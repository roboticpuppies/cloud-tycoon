// Component catalogue. Pure data, shared by the simulator and the UI.
// cap = requests per second, cost = $/month (fake but proportional), lat = ms added per hop.
(function (global) {
  const COMPONENTS = {
    igw: {
      name: 'Internet Gateway', cost: 0, cap: 1e6, lat: 1, zoneless: true, max: 1,
      desc: 'The door between the VPC and the internet. Without an IGW, no packet can enter or leave the VPC. Free, one per VPC.',
      tip: 'Users -> IGW -> a server in a PUBLIC subnet. A server in a private subnet cannot be reached from the internet.'
    },
    nat: {
      name: 'NAT Gateway', cost: 35, cap: 1e6, lat: 1,
      desc: 'The way OUT to the internet for servers in a private subnet (package updates, payment API calls). The internet cannot start a connection inward through it. Lives in one AZ.',
      tip: 'Place it in a PUBLIC subnet. One NAT per AZ, so a private subnet does not lose internet when another AZ goes down.'
    },
    s3: {
      name: 'S3 Bucket', cost: 5, cap: 1e6, lat: 10, zoneless: true,
      desc: 'Object storage for assets (photos, CSS, JS). Sits outside the VPC and survives AZ outages. A new bucket is always PRIVATE: allow public read only on an asset bucket.',
      tip: 'Users -> S3 for public assets. Web -> S3 for uploads, with an IAM Role and not an access key.'
    },
    cdn: {
      name: 'CDN', cost: 60, cap: 1e6, lat: 5, zoneless: true,
      desc: 'Edge cache. Serves STATIC requests at the edge, never touching origin latency. Managed, multi-region: immune to AZ outages.',
      tip: 'Put it first in the chain: Users -> CDN -> Load Balancer.'
    },
    lb: {
      name: 'Load Balancer', cost: 25, cap: 20000, lat: 2, zoneless: true,
      desc: 'Spreads traffic across healthy backends. Health-checks: dead servers get no traffic. Managed, multi-AZ.',
      tip: 'Without it, users hit servers directly and a dead server still gets its share.'
    },
    web: {
      name: 'Web Server', cost: 35, cap: 100, lat: 15,
      desc: 'One box, 100 req/s. Serves static files itself if no CDN. Async jobs processed inline cost 3x capacity and +300ms.',
      tip: 'Cheap. Add more behind a Load Balancer, spread over AZs.'
    },
    webxl: {
      name: 'Big Web Server', cost: 140, cap: 500, lat: 15,
      desc: '5x capacity, 4x price. Still a single box in a single AZ.',
      tip: 'Vertical scaling. Fine until the box dies.'
    },
    asg: {
      name: 'Auto Scaling', cost: 40, cap: 100, lat: 15, perInstance: 30, maxInstances: 6,
      desc: 'Group of web servers. Starts at MIN instances, adds +2 every 3s when load is high, up to 6. Pay base + per instance.',
      tip: 'Scaling lags behind a spike. Raise MIN before a known event.'
    },
    cache: {
      name: 'Cache', cost: 45, cap: 8000, lat: 2,
      desc: 'In-memory cache (Redis style). Answers ~80% of READS without touching the database. Single node in one AZ.',
      tip: 'Link Web -> Cache -> DB. When the cache dies, every read lands on the DB.'
    },
    db: {
      name: 'DB Primary', cost: 110, cap: 250, lat: 8, max: 1,
      desc: 'Handles READS and WRITES. 250 req/s. Only one allowed: two writers = split brain (sharding is another course).',
      tip: 'When it dies, writes fail until a replica is promoted.'
    },
    replica: {
      name: 'DB Replica', cost: 110, cap: 250, lat: 8,
      desc: 'Read-only copy. Link DB Primary -> Replica so it replicates. If the primary dies, the replica is promoted after 5s failover.',
      tip: 'Also link Web/Cache -> Replica so reads keep flowing during failover.'
    },
    queue: {
      name: 'Queue', cost: 20, cap: 1e6, lat: 1, zoneless: true, maxBacklog: 20000,
      desc: 'Message broker (SQS/RabbitMQ style). Web hands ASYNC jobs to it and answers the user instantly. Managed, multi-AZ.',
      tip: 'A queue with no workers is a very expensive /dev/null.'
    },
    worker: {
      name: 'Worker', cost: 30, cap: 40, lat: 0,
      desc: 'Pulls jobs from a Queue, 40 jobs/s. Writes results to a DB if linked. Single box in one AZ.',
      tip: 'Drain rate must beat arrival rate, with headroom for when one dies.'
    }
  };

  // Allowed links: from kind -> set of to kinds. 'users' is the traffic source.
  const LINK_RULES = {
    users:   ['cdn', 'lb', 'web', 'webxl', 'asg', 'igw', 's3'],
    igw:     ['lb', 'web', 'webxl', 'asg'],
    nat:     [],
    s3:      [],
    cdn:     ['lb', 'web', 'webxl', 'asg'],
    lb:      ['web', 'webxl', 'asg'],
    web:     ['cache', 'db', 'replica', 'queue', 's3'],
    webxl:   ['cache', 'db', 'replica', 'queue', 's3'],
    asg:     ['cache', 'db', 'replica', 'queue', 's3'],
    cache:   ['db', 'replica'],
    db:      ['replica'],
    replica: [],
    queue:   ['worker'],
    worker:  ['db', 'replica']
  };

  const WEB_KINDS = ['web', 'webxl', 'asg'];
  const FLOW_KINDS = ['static', 'read', 'write', 'async'];
  const FLOW_COLORS = { static: '#ffd166', read: '#4cc9f0', write: '#f3722c', async: '#c77dff' };

  const GRID = { cols: 12, rows: 6, zones: 3 };
  // Zones are horizontal bands stacked top to bottom; traffic flows left to right through them.
  function zoneOf(row) { return Math.min(GRID.zones - 1, Math.floor(row / (GRID.rows / GRID.zones))); }

  // Network scenarios (scenario.net): the grid is one VPC. Columns 0-1 are outside it,
  // 2-6 are the public subnets, 7-11 the private subnets. Each AZ band has one of each.
  const EDGE_KINDS = ['igw', 's3', 'cdn'];
  function subnetOf(col) { return col < 2 ? 'edge' : col < 7 ? 'public' : 'private'; }
  function canPlace(kind, col) { return EDGE_KINDS.includes(kind) === (subnetOf(col) === 'edge'); }

  function canLink(fromKind, toKind) {
    return (LINK_RULES[fromKind] || []).includes(toKind);
  }

  // Static cost of a design (before running). ASG counts its MIN instances.
  function designCost(design) {
    let c = 0;
    for (const n of design.nodes) {
      const d = COMPONENTS[n.kind];
      c += d.cost;
      if (n.kind === 'asg') c += d.perInstance * ((n.cfg && n.cfg.min) || 1);
    }
    return c;
  }

  const api = { COMPONENTS, LINK_RULES, WEB_KINDS, FLOW_KINDS, FLOW_COLORS, GRID, zoneOf, subnetOf, canPlace, canLink, designCost };
  if (typeof module !== 'undefined') module.exports = api; else Object.assign(global, api);
})(typeof window !== 'undefined' ? window : globalThis);
