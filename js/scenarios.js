// Scenario definitions. Each one teaches one idea and then tries to break your design.
(function (global) {
  // Compact design builder: nodes [[kind, col, row, cfg?]], edges ['users>lb-1', 'lb-1>web-1'].
  function design(nodes, edges) {
    const count = {};
    const ns = nodes.map(([kind, col, row, cfg]) => {
      count[kind] = (count[kind] || 0) + 1;
      return { id: `${kind}-${count[kind]}`, kind, col, row, cfg: cfg || {} };
    });
    return { nodes: ns, edges: edges.map(e => { const [from, to] = e.split('>'); return { from, to }; }) };
  }

  const ALL = ['cdn', 'lb', 'web', 'webxl', 'asg', 'cache', 'db', 'replica', 'queue', 'worker'];

  const SCENARIOS = [
    {
      id: 'hello', title: 'Hello, Cloud', tag: 'Request path basics',
      story: 'Your first day. A tiny blog needs to go live before lunch. Nothing fancy: make requests reach a server, and make the server reach a database.',
      learn: ['Place components on the grid', 'Drag from one node to another to link them', 'Read the traffic mix: static / read / write'],
      rate: 50, mix: { static: 0.3, read: 0.5, write: 0.2 }, duration: 25, budget: 200,
      targets: { availability: 99, latency: 60 }, events: [],
      allowed: ['web', 'db'],
      lesson: 'Every request follows a path. Static files end at the web server. Reads and writes need a database behind it. If a hop is missing, the request has nowhere to go.',
      solution: design([['web', 4, 0], ['db', 7, 0]], ['users>web-1', 'web-1>db-1'])
    },
    {
      id: 'crash', title: 'The 3 AM Crash', tag: 'Redundancy + load balancing',
      story: 'The blog got popular. At 3 AM a web server kernel-panics. With one server, the site is down until someone wakes up. Make sure nobody has to.',
      learn: ['Single point of failure (SPOF)', 'Load balancer health checks', 'N+1: survive losing one node'],
      rate: 80, mix: { static: 0.2, read: 0.5, write: 0.3 }, duration: 45, budget: 300,
      targets: { availability: 99, latency: 60 },
      events: [{ t: 12, type: 'kill', target: ['web', 'webxl', 'asg'], duration: 20 }],
      allowed: ['lb', 'web', 'webxl', 'db'],
      lesson: 'Two servers alone are not enough: without a load balancer, half the users still land on the dead one. The LB health-checks backends and routes around failure. Size for N+1: the survivors must carry the full load.',
      solution: design([['lb', 1, 0], ['web', 3, 1], ['web', 4, 3], ['db', 7, 0]],
        ['users>lb-1', 'lb-1>web-1', 'lb-1>web-2', 'web-1>db-1', 'web-2>db-1'])
    },
    {
      id: 'zone', title: 'Zone Down', tag: 'Multi-AZ design',
      story: 'A backhoe meets a fiber trunk. An entire Availability Zone goes dark, and Murphy picks the zone where you put the most stuff. The three bands on the map, top to bottom, are AZ-a, AZ-b, AZ-c.',
      learn: ['Availability Zones are failure domains', 'Spread every tier across zones', 'Replica in another AZ + failover time'],
      rate: 120, mix: { static: 0.3, read: 0.5, write: 0.2 }, duration: 60, budget: 450,
      targets: { availability: 98, latency: 60 },
      events: [{ t: 20, type: 'az', zone: 'busiest', duration: 20 }],
      allowed: ['lb', 'web', 'webxl', 'db', 'replica'],
      lesson: 'Redundancy inside one failure domain is not redundancy. Spread web servers over zones, keep a DB replica in a different zone than the primary, and remember capacity: after losing a zone, what is left must still carry the load. Failover is not instant, which is why the target here is 98% and not 100%.',
      solution: design([['lb', 0, 0], ['web', 3, 1], ['web', 3, 3], ['web', 3, 5], ['db', 7, 1], ['replica', 7, 3]],
        ['users>lb-1', 'lb-1>web-1', 'lb-1>web-2', 'lb-1>web-3', 'web-1>db-1', 'web-2>db-1', 'web-3>db-1', 'web-1>replica-1', 'web-2>replica-1', 'web-3>replica-1', 'db-1>replica-1'])
    },
    {
      id: 'dbdown', title: 'Database Down', tag: 'Replication + failover',
      story: 'The disk under your primary database fills up and the process dies. Stateless servers are easy to replace. State is not.',
      learn: ['Primary / replica replication', 'Automatic failover and promotion', 'Reads can survive while writes wait'],
      rate: 100, mix: { static: 0.3, read: 0.5, write: 0.2 }, duration: 60, budget: 450,
      targets: { availability: 97, latency: 60 },
      events: [{ t: 20, type: 'kill', target: ['db'], duration: 25, fallback: false }, { t: 35, type: 'kill', target: ['web', 'webxl'], duration: 10, fallback: false }],
      allowed: ['lb', 'web', 'webxl', 'db', 'replica', 'cache'],
      lesson: 'The replica needs two kinds of links: Primary -> Replica so data replicates and it can be promoted, and Web -> Replica so the app can actually use it. During the 5 second failover reads keep flowing from the replica while writes fail. That gap is your RTO.',
      solution: design([['lb', 1, 0], ['web', 3, 1], ['web', 3, 3], ['db', 7, 1], ['replica', 7, 3]],
        ['users>lb-1', 'lb-1>web-1', 'lb-1>web-2', 'web-1>db-1', 'web-2>db-1', 'web-1>replica-1', 'web-2>replica-1', 'db-1>replica-1'])
    },
    {
      id: 'cache', title: 'Cache Me If You Can', tag: 'Caching read-heavy load',
      story: 'A news site: 90% of requests read the same handful of articles. The database is melting at 350 req/s and it only handles 250.',
      learn: ['Read/write ratio drives design', 'Cache-aside pattern', 'Cache vs read replica: cost and latency'],
      rate: 350, mix: { static: 0, read: 0.9, write: 0.1 }, duration: 40, budget: 450,
      targets: { availability: 99, latency: 40 },
      events: [{ t: 15, type: 'kill', target: ['web', 'webxl', 'asg'], duration: 10 }],
      allowed: ['lb', 'web', 'webxl', 'db', 'replica', 'cache'],
      lesson: 'A cache answers ~80% of reads from memory, so the database only sees misses and writes. Read replicas also work, but cost more and are slower. Cache first, replicas when the cache is not enough.',
      solution: design([['lb', 1, 0], ['web', 3, 0], ['web', 4, 0], ['web', 3, 2], ['web', 4, 2], ['web', 3, 5], ['db', 8, 2], ['cache', 8, 0]],
        ['users>lb-1', 'lb-1>web-1', 'lb-1>web-2', 'lb-1>web-3', 'lb-1>web-4', 'lb-1>web-5',
          'web-1>cache-1', 'web-2>cache-1', 'web-3>cache-1', 'web-4>cache-1', 'web-5>cache-1',
          'web-1>db-1', 'web-2>db-1', 'web-3>db-1', 'web-4>db-1', 'web-5>db-1', 'cache-1>db-1'])
    },
    {
      id: 'stampede', title: 'Cache Stampede', tag: 'When the cache dies',
      story: 'The cache made everything fast, so everyone forgot the database is small. Then the cache node restarts, and 500 req/s of reads stampede to the DB at once.',
      learn: ['A cache hides load, it does not remove it', 'Design for the cache-cold case', 'Read replicas as a safety net'],
      rate: 500, mix: { static: 0, read: 0.9, write: 0.1 }, duration: 50, budget: 700,
      targets: { availability: 98, latency: 60 },
      events: [{ t: 20, type: 'kill', target: ['cache'], duration: 15, fallback: false }],
      allowed: ['lb', 'web', 'webxl', 'db', 'replica', 'cache'],
      lesson: 'If losing the cache takes down the database, the cache has become a critical dependency with no backup. Give reads a fallback path (Web -> DB and Web -> Replica) with enough capacity to survive a cold cache.',
      solution: design([['lb', 1, 0], ['web', 3, 0], ['web', 4, 0], ['web', 3, 2], ['web', 4, 2], ['web', 3, 4], ['web', 4, 4], ['cache', 8, 0], ['db', 8, 2], ['replica', 8, 4]],
        ['users>lb-1', ...[1, 2, 3, 4, 5, 6].flatMap(i => [`lb-1>web-${i}`, `web-${i}>cache-1`, `web-${i}>db-1`, `web-${i}>replica-1`]),
          'cache-1>db-1', 'cache-1>replica-1', 'db-1>replica-1'])
    },
    {
      id: 'jobs', title: 'Background Jobs', tag: 'Message queues + workers',
      story: 'A photo app. Half of all requests are uploads that need thumbnails generated. Right now the web server does it while the user stares at a spinner.',
      learn: ['Sync vs async work', 'Queue decouples producers from consumers', 'Drain rate, backlog, and worker redundancy'],
      rate: 60, mix: { static: 0, read: 0.3, write: 0.2, async: 0.5 }, duration: 60, budget: 360,
      targets: { availability: 99, latency: 60, jobs: 95 },
      events: [{ t: 30, type: 'kill', target: ['worker'], duration: 10, fallback: false }],
      allowed: ['lb', 'web', 'webxl', 'db', 'queue', 'worker'],
      lesson: 'The queue lets the web tier answer in milliseconds and absorbs bursts. But a queue only moves the work: workers must drain faster than jobs arrive, with spare capacity for the day one of them dies. Watch the backlog, not just the request latency.',
      solution: design([['lb', 1, 0], ['web', 3, 1], ['web', 3, 3], ['db', 8, 2], ['queue', 7, 1], ['worker', 11, 0], ['worker', 5, 4]],
        ['users>lb-1', 'lb-1>web-1', 'lb-1>web-2', 'web-1>db-1', 'web-2>db-1', 'web-1>queue-1', 'web-2>queue-1', 'queue-1>worker-1', 'queue-1>worker-2', 'worker-1>db-1', 'worker-2>db-1'])
    },
    {
      id: 'flash', title: 'Flash Sale', tag: 'Auto scaling + spikes',
      story: 'Marketing scheduled a flash sale and told nobody. For 15 seconds traffic jumps 8x. Paying for peak capacity all month is not in the budget.',
      learn: ['Elasticity vs fixed capacity', 'Scaling lag and minimum capacity', 'Shed load with CDN + cache before scaling'],
      rate: 100, mix: { static: 0.4, read: 0.4, write: 0.2 }, duration: 90, budget: 500,
      targets: { availability: 96, latency: 70 },
      events: [{ t: 30, type: 'spike', mult: 8, duration: 15 }],
      allowed: ['cdn', 'lb', 'web', 'webxl', 'asg', 'cache', 'db', 'replica'],
      lesson: 'Auto scaling reacts after the load arrives, so the first seconds of a spike hit whatever is already running. Raise the minimum for known events, and take load off the origin first: a CDN removes static traffic and a cache protects the database, which cannot scale out in seconds.',
      solution: design([['cdn', 0, 1], ['lb', 1, 1], ['asg', 4, 2, { min: 3 }], ['db', 8, 2], ['cache', 8, 0]],
        ['users>cdn-1', 'cdn-1>lb-1', 'lb-1>asg-1', 'asg-1>cache-1', 'asg-1>db-1', 'cache-1>db-1'])
    },
    {
      id: 'global', title: 'Going Global', tag: 'CDN + edge latency',
      story: 'Your users are an ocean away from the region. Every request that reaches origin pays 60ms of round trip before your servers even see it.',
      learn: ['Latency budgets', 'Edge caching for static content', 'What a CDN can and cannot help with'],
      rate: 200, mix: { static: 0.6, read: 0.3, write: 0.1 }, duration: 45, budget: 400, originLatency: 60,
      targets: { availability: 99, latency: 45 },
      events: [{ t: 15, type: 'kill', target: ['web', 'webxl', 'asg'], duration: 15 }],
      allowed: ['cdn', 'lb', 'web', 'webxl', 'cache', 'db', 'replica'],
      lesson: 'You cannot make the ocean smaller, but you can stop crossing it. Static content served at the edge never pays origin latency. Dynamic requests still do, which is why the next step in real life is multi-region.',
      solution: design([['cdn', 0, 1], ['lb', 1, 1], ['web', 4, 0], ['web', 4, 2], ['db', 8, 2], ['cache', 8, 0]],
        ['users>cdn-1', 'cdn-1>lb-1', 'lb-1>web-1', 'lb-1>web-2', 'web-1>cache-1', 'web-2>cache-1', 'web-1>db-1', 'web-2>db-1', 'cache-1>db-1'])
    },
    {
      id: 'penny', title: 'Penny Pincher', tag: 'Cost optimization',
      story: 'The previous engineer believed in "better safe than sorry". Finance believes in a $300 budget. The bill is over $1000. Cut it without cutting reliability.',
      learn: ['Right-sizing', 'Paying for idle capacity', 'Redundancy you need vs redundancy you imagine'],
      rate: 100, mix: { static: 0.3, read: 0.5, write: 0.2 }, duration: 45, budget: 300,
      targets: { availability: 99, latency: 60 },
      events: [{ t: 15, type: 'kill', target: ['web', 'webxl', 'asg'], duration: 15 }],
      allowed: ALL,
      lesson: 'Cost optimization is architecture too. Match capacity to measured load plus a failure margin, not to fear. Every component should earn its place: if utilisation is under 20%, ask why it exists.',
      start: design([['cdn', 0, 0], ['lb', 1, 0], ['webxl', 3, 1], ['webxl', 3, 3], ['webxl', 3, 5], ['webxl', 4, 5], ['cache', 7, 1], ['db', 8, 1], ['replica', 8, 3], ['replica', 8, 5]],
        ['users>cdn-1', 'cdn-1>lb-1', ...[1, 2, 3, 4].flatMap(i => [`lb-1>webxl-${i}`, `webxl-${i}>cache-1`, `webxl-${i}>db-1`]), 'cache-1>db-1', 'cache-1>replica-1', 'cache-1>replica-2', 'db-1>replica-1', 'db-1>replica-2']),
      solution: design([['lb', 1, 0], ['web', 3, 1], ['web', 3, 3], ['db', 7, 1]],
        ['users>lb-1', 'lb-1>web-1', 'lb-1>web-2', 'web-1>db-1', 'web-2>db-1'])
    },
    {
      id: 'blackfriday', title: 'Black Friday', tag: 'Final boss: everything at once',
      story: 'An online store on the biggest day of the year. The database will crash, traffic will spike 5x, and an AZ will fail. Orders are async jobs and every one of them is money.',
      learn: ['Combine every pattern', 'Failures overlap and compound', 'Trade cost against resilience on purpose'],
      rate: 150, mix: { static: 0.4, read: 0.3, write: 0.1, async: 0.2 }, duration: 80, budget: 950,
      targets: { availability: 96, latency: 80, jobs: 95 },
      events: [
        { t: 10, type: 'kill', target: ['db'], duration: 15, fallback: false },
        { t: 30, type: 'spike', mult: 5, duration: 15 },
        { t: 55, type: 'az', zone: 'busiest', duration: 15 }
      ],
      allowed: ALL,
      lesson: 'Real incidents stack. A design that survives each failure alone can still fall to two in a row: after the first failover, is there another replica left? Resilience is layers: shed load at the edge, scale the stateless tier, protect the database, buffer the work.',
      solution: design([
        ['cdn', 0, 0], ['lb', 1, 0], ['queue', 2, 0],
        ['asg', 3, 1, { min: 2 }], ['asg', 3, 3, { min: 2 }],
        ['db', 7, 1], ['replica', 7, 3], ['cache', 4, 4],
        ['worker', 11, 1], ['worker', 11, 3], ['worker', 8, 5]],
        ['users>cdn-1', 'cdn-1>lb-1', 'lb-1>asg-1', 'lb-1>asg-2',
          ...[1, 2].flatMap(i => [`asg-${i}>cache-1`, `asg-${i}>db-1`, `asg-${i}>replica-1`, `asg-${i}>queue-1`]),
          'cache-1>db-1', 'cache-1>replica-1', 'db-1>replica-1',
          ...[1, 2, 3].flatMap(i => [`queue-1>worker-${i}`, `worker-${i}>db-1`, `worker-${i}>replica-1`])])
    },
    {
      id: 'sandbox', title: 'Sandbox', tag: 'Free play + chaos buttons', sandbox: true,
      story: 'No budget, no boss. Build anything, hit Run, then break it yourself with the chaos buttons and watch what happens.',
      learn: ['Test your own hypotheses', 'Kill things on purpose', 'Chaos engineering in miniature'],
      rate: 200, mix: { static: 0.3, read: 0.4, write: 0.2, async: 0.1 }, duration: 120, budget: Infinity,
      targets: { availability: 99, latency: 100, jobs: 95 }, events: [],
      allowed: ALL,
      lesson: 'The best way to trust a system is to break it on purpose, on your own schedule.',
      solution: null
    }
  ];

  const api = { SCENARIOS, makeDesign: design };
  if (typeof module !== 'undefined') module.exports = api; else Object.assign(global, api);
})(typeof window !== 'undefined' ? window : globalThis);
