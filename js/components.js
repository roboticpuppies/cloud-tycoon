// Component catalogue. Pure data, shared by the simulator and the UI.
// cap = requests per second, cost = $/month (fake but proportional), lat = ms added per hop.
(function (global) {
  const COMPONENTS = {
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
    users:   ['cdn', 'lb', 'web', 'webxl', 'asg'],
    cdn:     ['lb', 'web', 'webxl', 'asg'],
    lb:      ['web', 'webxl', 'asg'],
    web:     ['cache', 'db', 'replica', 'queue'],
    webxl:   ['cache', 'db', 'replica', 'queue'],
    asg:     ['cache', 'db', 'replica', 'queue'],
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

  const api = { COMPONENTS, LINK_RULES, WEB_KINDS, FLOW_KINDS, FLOW_COLORS, GRID, zoneOf, canLink, designCost };
  if (typeof module !== 'undefined') module.exports = api; else Object.assign(global, api);
})(typeof window !== 'undefined' ? window : globalThis);
