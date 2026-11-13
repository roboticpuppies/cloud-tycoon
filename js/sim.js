// Traffic + chaos simulator. Pure logic, no DOM. Runs in the browser and in node (tests).
(function (global) {
  const C = typeof module !== 'undefined' ? require('./components.js') : global;
  const { COMPONENTS, WEB_KINDS, FLOW_KINDS, zoneOf, GRID } = C;

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  const FAILOVER_SECONDS = 5;
  const ASG_SCALE_EVERY = 3;
  const ASG_SCALE_STEP = 2;
  const ASG_SCALE_IN_EVERY = 6;
  const CACHE_HIT = 0.8;
  const LOCAL_ASYNC_WEIGHT = 3;
  const LOCAL_ASYNC_LAT = 300;

  // Short label shown over a node while it is dropping requests.
  const REASON_LABEL = {
    'overload': 'OVERLOAD', 'db-dead': 'DB DOWN', 'no-db': 'NO DB LINK', 'no-route': 'NO ROUTE',
    'no-backend': 'NO BACKEND', 'replica-readonly': 'READ-ONLY', 'queue-full': 'QUEUE FULL'
  };
  const REASON_TEXT = {
    'no-entry': 'nothing is connected to Users',
    'dead': 'the node was down',
    'overload': 'the node was over capacity',
    'no-route': 'no live downstream node',
    'no-backend': 'load balancer had no live backend',
    'no-db': 'no database reachable for this request',
    'db-dead': 'database was down (no promoted replica)',
    'replica-readonly': 'write hit a read-only replica',
    'queue-full': 'queue backlog overflowed',
    'dead-entry': 'users were sent straight to a dead server'
  };

  class Sim {
    constructor(design, scenario, hooks) {
      this.sc = scenario;
      this.hooks = hooks || {};
      this.t = 0; this.dt = 0.1; this.done = false;
      this.rng = mulberry32(scenario.seed || 1337);
      this.nodes = design.nodes.map(n => ({
        id: n.id, kind: n.kind, col: n.col, row: n.row, cfg: n.cfg || {},
        def: COMPONENTS[n.kind], zone: zoneOf(n.row),
        dead: false, deadUntil: 0, azDead: false,
        load: 0, demand: 0, peakLoad: 0, loadWindow: 0,
        backlog: 0, instances: 1, instSum: 0, instTicks: 0, lowSince: null,
        promoted: false, failoverAt: null,
        served: 0, failed: 0, reasons: {}
      }));
      for (const n of this.nodes) if (n.kind === 'asg') n.instances = Math.max(1, n.cfg.min || 1);
      this.byId = Object.fromEntries(this.nodes.map(n => [n.id, n]));
      this.out = {}; this.inn = {};
      for (const n of this.nodes) { this.out[n.id] = []; this.inn[n.id] = []; }
      this.entries = [];
      for (const e of design.edges) {
        if (e.from === 'users') { if (this.byId[e.to]) this.entries.push(this.byId[e.to]); }
        else if (this.byId[e.from] && this.byId[e.to]) { this.out[e.from].push(this.byId[e.to]); this.inn[e.to].push(this.byId[e.from]); }
      }
      this.stats = { ok: 0, total: 0, latSum: 0, fail: {}, jobsTotal: 0, jobsDone: 0, series: [], peakRate: 0 };
      this.events = (scenario.events || []).map(e => ({ ...e, fired: false, ended: false }));
      this.log = [];
      this.spike = 1;
      this.activeAz = null;
      this.secAcc = { ok: 0, fail: 0, latSum: 0, n: 0, next: 1 };
      this.tickFlow = [];
    }

    // ---------- helpers ----------
    logMsg(text, level) { this.log.push({ t: +this.t.toFixed(1), text, level: level || 'info' }); if (this.hooks.onLog) this.hooks.onLog(this.log[this.log.length - 1]); }
    capOf(n) { return n.kind === 'asg' ? n.def.cap * n.instances : n.def.cap; }
    alive(n) { return !n.dead; }
    readable(n) { return (n.kind === 'db' || n.kind === 'replica') && !n.dead; }
    writable(n) { return (n.kind === 'db' || (n.kind === 'replica' && n.promoted)) && !n.dead; }
    flow(from, to, amt, kind) { if (amt > 0) this.tickFlow.push({ from, to, amt, kind }); }

    ok(node, kind, amt, lat) {
      this.stats.ok += amt; this.stats.total += amt; this.stats.latSum += amt * lat;
      this.secAcc.ok += amt; this.secAcc.latSum += amt * lat;
      if (node) node.served += amt;
      if (kind === 'async') this.stats.jobsDone += amt;
    }
    fail(node, kind, amt, reason) {
      if (amt <= 0) return;
      this.stats.total += amt; this.stats.fail[reason] = (this.stats.fail[reason] || 0) + amt;
      this.secAcc.fail += amt;
      if (node) { node.failed += amt; node.reasons[reason] = (node.reasons[reason] || 0) + amt; node.failReason = reason; node.failAt = this.t; if (this.hooks.onFail) this.hooks.onFail(node, reason, amt); }
    }

    kill(node, duration, why) {
      if (node.dead) return;
      node.dead = true; node.deadUntil = this.t + duration;
      node.downWhy = node.azDead ? 'AZ DOWN' : 'CRASHED';
      this.logMsg(`${node.id} ${why}`, 'bad');
      if (this.hooks.onKill) this.hooks.onKill(node);
      if (node.kind === 'db' || (node.kind === 'replica' && node.promoted)) {
        for (const r of this.out[node.id]) if (r.kind === 'replica' && !r.promoted && !r.dead) {
          r.failoverAt = this.t + FAILOVER_SECONDS;
          this.logMsg(`failover started: ${r.id} promotes in ${FAILOVER_SECONDS}s`, 'warn');
        }
      }
    }

    fire(ev) {
      if (ev.type === 'kill') {
        const kinds = Array.isArray(ev.target) ? ev.target : [ev.target];
        let cands = this.nodes.filter(n => kinds.includes(n.kind) && !n.dead);
        if (!cands.length && ev.fallback !== false) cands = this.nodes.filter(n => !n.def.zoneless && !n.dead);
        if (!cands.length) { this.logMsg(`chaos monkey found nothing to kill`, 'info'); return; }
        const victim = cands[Math.floor(this.rng() * cands.length)];
        this.kill(victim, ev.duration, 'crashed!');
      } else if (ev.type === 'az') {
        let zone = ev.zone;
        if (zone === 'busiest') {
          const counts = new Array(GRID.zones).fill(0);
          for (const n of this.nodes) if (!n.def.zoneless) counts[n.zone]++;
          zone = counts.indexOf(Math.max(...counts));
        }
        this.activeAz = zone;
        this.logMsg(`AZ-${'abc'[zone]} outage!`, 'bad');
        if (this.hooks.onAz) this.hooks.onAz(zone, true);
        for (const n of this.nodes) if (!n.def.zoneless && n.zone === zone) { n.azDead = true; this.kill(n, ev.duration, `lost with AZ-${'abc'[zone]}`); }
      } else if (ev.type === 'spike') {
        this.spike = ev.mult;
        this.logMsg(`traffic spike x${ev.mult}!`, 'warn');
      }
    }
    end(ev) {
      if (ev.type === 'az') {
        for (const n of this.nodes) if (n.azDead) { n.azDead = false; }
        this.activeAz = null;
        this.logMsg(`AZ-${'abc'[this.activeZoneEnded(ev)]} recovered`, 'ok');
        if (this.hooks.onAz) this.hooks.onAz(null, false);
      } else if (ev.type === 'spike') {
        this.spike = 1; this.logMsg('traffic back to normal', 'ok');
      }
    }
    activeZoneEnded(ev) { return ev.zone === 'busiest' ? (ev._zone != null ? ev._zone : 0) : ev.zone; }

    // ---------- routing ----------
    route(node, kind, amt, lat, depth, viaEntry) {
      if (amt <= 0 || depth > 8) return;
      if (node.dead) { this.fail(node, kind, amt, viaEntry && !node.def.zoneless ? 'dead-entry' : 'dead'); return; }
      const cap = this.capOf(node);
      const localAsync = kind === 'async' && WEB_KINDS.includes(node.kind) && !this.out[node.id].some(o => o.kind === 'queue' && !o.dead);
      const weight = localAsync ? LOCAL_ASYNC_WEIGHT : 1;
      const want = amt * weight / this.dt;             // req/s this batch wants
      node.demand += want;
      const room = Math.max(0, cap - node.load);
      const acceptedReq = Math.min(want, room);
      const accepted = acceptedReq / weight * this.dt;
      const rejected = amt - accepted;
      node.load += acceptedReq;
      if (node.load > node.peakLoad) node.peakLoad = node.load;
      if (rejected > 1e-9) { node.overloaded = true; this.fail(node, kind, rejected, 'overload'); }
      if (accepted <= 1e-9) return;
      const util = node.load / cap;
      lat += node.def.lat + (util > 0.7 ? (util - 0.7) * 150 : 0);
      const outs = this.out[node.id];
      const spread = (targets, k, a, l) => {
        const share = a / targets.length;
        for (const tnode of targets) { this.flow(node.id, tnode.id, share, k); this.route(tnode, k, share, l, depth + 1, false); }
      };

      switch (node.kind) {
        case 'cdn': {
          if (kind === 'static') { this.ok(node, kind, accepted, lat); return; }
          const targets = outs.filter(o => !o.dead);
          if (!targets.length) { this.fail(node, kind, accepted, outs.length ? 'no-route' : 'no-route'); return; }
          spread(targets, kind, accepted, lat + (this.sc.originLatency || 0));
          return;
        }
        case 'lb': {
          const targets = outs.filter(o => !o.dead);
          if (!targets.length) { this.fail(node, kind, accepted, 'no-backend'); return; }
          spread(targets, kind, accepted, lat);
          return;
        }
        case 'web': case 'webxl': case 'asg': {
          if (kind === 'static') { this.ok(node, kind, accepted, lat); return; }
          if (kind === 'read') {
            const caches = outs.filter(o => o.kind === 'cache' && !o.dead);
            if (caches.length) { spread(caches, kind, accepted, lat); return; }
            const dbs = outs.filter(o => this.readable(o));
            if (!dbs.length) { this.fail(node, kind, accepted, outs.some(o => o.kind === 'db' || o.kind === 'replica' || o.kind === 'cache') ? 'db-dead' : 'no-db'); return; }
            spread(dbs, kind, accepted, lat); return;
          }
          if (kind === 'write') {
            const dbs = outs.filter(o => this.writable(o));
            if (!dbs.length) {
              const anyDb = outs.some(o => o.kind === 'db' || o.kind === 'replica');
              this.fail(node, kind, accepted, anyDb ? 'db-dead' : 'no-db'); return;
            }
            spread(dbs, kind, accepted, lat); return;
          }
          if (kind === 'async') {
            const qs = outs.filter(o => o.kind === 'queue' && !o.dead);
            if (qs.length) { spread(qs, kind, accepted, lat); return; }
            this.ok(node, kind, accepted, lat + LOCAL_ASYNC_LAT); return; // processed inline
          }
          return;
        }
        case 'cache': {
          if (kind === 'read') {
            const hits = accepted * (this.sc.cacheHit != null ? this.sc.cacheHit : CACHE_HIT);
            this.ok(node, kind, hits, lat);
            const miss = accepted - hits;
            const dbs = outs.filter(o => this.readable(o));
            if (!dbs.length) { this.fail(node, kind, miss, outs.length ? 'db-dead' : 'no-db'); return; }
            spread(dbs, kind, miss, lat); return;
          }
          const dbs = outs.filter(o => this.writable(o));
          if (!dbs.length) { this.fail(node, kind, accepted, outs.length ? 'db-dead' : 'no-db'); return; }
          spread(dbs, kind, accepted, lat); return;
        }
        case 'db': { this.ok(node, kind, accepted, lat); return; }
        case 'replica': {
          if (kind === 'write' && !node.promoted) { this.fail(node, kind, accepted, 'replica-readonly'); return; }
          this.ok(node, kind, accepted, lat); return;
        }
        case 'queue': {
          const room = node.def.maxBacklog - node.backlog;
          const take = Math.min(accepted, Math.max(0, room));
          node.backlog += take;
          // ack to the user: request is "done" from their point of view, but the job is not.
          this.stats.ok += take; this.stats.total += take; this.stats.latSum += take * lat; this.secAcc.ok += take; this.secAcc.latSum += take * lat; node.served += take;
          if (accepted - take > 1e-9) this.fail(node, kind, accepted - take, 'queue-full');
          return;
        }
        case 'worker': { this.ok(node, kind, accepted, lat); return; }
      }
    }

    drainQueues() {
      for (const q of this.nodes) {
        if (q.kind !== 'queue' || q.dead || q.backlog <= 0) continue;
        const workers = this.out[q.id].filter(w => w.kind === 'worker' && !w.dead);
        for (const w of workers) {
          if (q.backlog <= 0) break;
          const can = this.capOf(w) * this.dt;
          const take = Math.min(q.backlog, can);
          q.backlog -= take; w.load = take / this.dt; if (w.load > w.peakLoad) w.peakLoad = w.load;
          this.flow(q.id, w.id, take, 'async');
          const dbs = this.out[w.id].filter(o => this.writable(o));
          if (!dbs.length) {
            if (this.out[w.id].length) { q.backlog += take; w.reasons['db-dead'] = (w.reasons['db-dead'] || 0) + take; } // retry later
            else { this.stats.jobsDone += take; w.served += take; }
            continue;
          }
          const share = take / dbs.length;
          for (const db of dbs) {
            const room = Math.max(0, this.capOf(db) - db.load);
            const acc = Math.min(share / this.dt, room) * this.dt;
            db.load += acc / this.dt;
            this.flow(w.id, db.id, acc, 'async');
            this.stats.jobsDone += acc; w.served += acc; db.served += acc;
            const back = share - acc;
            if (back > 1e-9) { q.backlog += back; db.reasons['overload'] = (db.reasons['overload'] || 0) + back; }
          }
        }
      }
    }

    scaleAsg() {
      for (const n of this.nodes) {
        if (n.kind !== 'asg') continue;
        n.instSum += n.instances; n.instTicks++;
        const min = Math.max(1, n.cfg.min || 1), max = n.def.maxInstances;
        n.loadWindow = Math.max(n.loadWindow, n.demand);
        const atStep = Math.abs(this.t / ASG_SCALE_EVERY - Math.round(this.t / ASG_SCALE_EVERY)) < 1e-6 && this.t > 0;
        if (!atStep) continue;
        const desired = Math.min(max, Math.max(min, Math.ceil(n.loadWindow / (n.def.cap * 0.75))));
        if (desired > n.instances && !n.dead) {
          n.instances = Math.min(desired, n.instances + ASG_SCALE_STEP);
          this.logMsg(`${n.id} scaled out to ${n.instances} instances`, 'ok');
          n.lowSince = null;
        } else if (desired < n.instances) {
          if (n.lowSince == null) n.lowSince = this.t;
          else if (this.t - n.lowSince >= ASG_SCALE_IN_EVERY) { n.instances--; n.lowSince = this.t; this.logMsg(`${n.id} scaled in to ${n.instances}`, 'info'); }
        } else n.lowSince = null;
        n.loadWindow = 0;
      }
    }

    tick() {
      if (this.done) return;
      const t = this.t;
      this.tickFlow = [];
      for (const ev of this.events) {
        if (!ev.fired && t >= ev.t - 1e-9) { ev.fired = true; if (ev.type === 'az' && ev.zone === 'busiest') { /* resolved in fire */ } this.fire(ev); if (ev.type === 'az') ev._zone = this.activeAz; }
        if (ev.fired && !ev.ended && t >= ev.t + ev.duration - 1e-9) { ev.ended = true; this.end(ev); }
      }
      for (const n of this.nodes) {
        if (n.dead && !n.azDead && n.deadUntil <= t + 1e-9) { n.dead = false; this.logMsg(`${n.id} is back`, 'ok'); if (this.hooks.onRevive) this.hooks.onRevive(n); }
        if (n.kind === 'replica' && n.failoverAt != null && !n.promoted && t >= n.failoverAt - 1e-9) {
          if (!n.dead) { n.promoted = true; n.failoverAt = null; this.logMsg(`${n.id} promoted to PRIMARY`, 'ok'); }
        }
      }
      this.scaleAsg();
      for (const n of this.nodes) { n.load = 0; n.demand = 0; n.overloaded = false; }

      const rate = this.sc.rate * this.spike * (this.sc.profile ? this.sc.profile(t) : 1);
      if (rate > this.stats.peakRate) this.stats.peakRate = rate;
      const amt = rate * this.dt;
      for (const kind of FLOW_KINDS) {
        const a = amt * (this.sc.mix[kind] || 0);
        if (a <= 0) continue;
        if (kind === 'async') this.stats.jobsTotal += a;
        if (!this.entries.length) { this.fail(null, kind, a, 'no-entry'); continue; }
        const share = a / this.entries.length;
        for (const e of this.entries) {
          this.flow('users', e.id, share, kind);
          const lat0 = e.kind === 'cdn' ? 0 : (this.sc.originLatency || 0);
          this.route(e, kind, share, lat0, 0, true);
        }
      }
      this.drainQueues();
      if (this.hooks.onFlow) this.hooks.onFlow(this.tickFlow);

      this.t = +(this.t + this.dt).toFixed(3);
      if (this.t >= this.secAcc.next - 1e-9) {
        const s = this.secAcc;
        this.stats.series.push({ t: s.next, ok: s.ok, fail: s.fail, lat: s.ok > 0 ? s.latSum / s.ok : 0 });
        this.secAcc = { ok: 0, fail: 0, latSum: 0, n: 0, next: s.next + 1 };
      }
      if (this.t >= this.sc.duration - 1e-9) this.done = true;
    }

    // Fire an unscheduled event right now (sandbox chaos buttons).
    inject(ev) {
      const e = { ...ev, t: this.t, fired: true, ended: false };
      this.events.push(e); this.fire(e);
      if (e.type === 'az') e._zone = this.activeAz;
    }

    runAll() { while (!this.done) this.tick(); return this.result(); }

    cost() {
      let c = 0;
      for (const n of this.nodes) {
        c += n.def.cost;
        if (n.kind === 'asg') c += n.def.perInstance * (n.instTicks ? n.instSum / n.instTicks : n.instances);
      }
      return Math.round(c);
    }

    result() {
      const s = this.stats;
      const availability = s.total > 0 ? s.ok / s.total * 100 : 100;
      const latency = s.ok > 0 ? s.latSum / s.ok : 0;
      const jobs = s.jobsTotal > 0 ? s.jobsDone / s.jobsTotal * 100 : 100;
      const cost = this.cost();
      const tg = this.sc.targets;
      const checks = [
        { key: 'availability', label: 'Availability', value: availability, target: tg.availability, cmp: '>=', fmt: v => v.toFixed(2) + '%', pass: availability + 1e-9 >= tg.availability },
        { key: 'latency', label: 'Avg latency', value: latency, target: tg.latency, cmp: '<=', fmt: v => Math.round(v) + 'ms', pass: latency <= tg.latency + 1e-9 }
      ];
      if (isFinite(this.sc.budget)) checks.push({ key: 'cost', label: 'Monthly cost', value: cost, target: this.sc.budget, cmp: '<=', fmt: v => '$' + Math.round(v), pass: cost <= this.sc.budget });
      if ((this.sc.mix.async || 0) > 0) checks.push({ key: 'jobs', label: 'Jobs completed', value: jobs, target: tg.jobs || 95, cmp: '>=', fmt: v => v.toFixed(1) + '%', pass: jobs + 1e-9 >= (tg.jobs || 95) });
      const pass = checks.every(c => c.pass);
      let stars = 0;
      if (pass) stars = (isFinite(this.sc.budget) && cost <= this.sc.budget * 0.8) ? 3 : 2;
      else if (checks[0].pass) stars = 1;
      return { pass, stars, availability, latency, jobs, cost, checks, fail: s.fail, series: s.series, log: this.log, peakRate: s.peakRate, nodes: this.nodes };
    }
  }

  // ---------- post-mortem advice ----------
  function analyze(sim, design, scenario) {
    const r = sim.result();
    const out = [];
    const total = sim.stats.total || 1;
    const pct = v => (v / total * 100).toFixed(1) + '%';
    const f = sim.stats.fail;
    const nodes = sim.nodes;
    const kinds = k => nodes.filter(n => (Array.isArray(k) ? k : [k]).includes(n.kind));
    const webs = kinds(WEB_KINDS), lbs = kinds('lb'), dbs = kinds('db'), reps = kinds('replica'), caches = kinds('cache'), cdns = kinds('cdn'), queues = kinds('queue'), workers = kinds('worker');

    if (f['no-entry']) out.push({ level: 'bad', text: `Nothing was connected to Users. Drag from the Users icon to your first component.` });
    if (f['dead-entry']) out.push({ level: 'bad', text: `${pct(f['dead-entry'])} of requests went straight to a dead server. DNS does not health-check. Put a Load Balancer in front so traffic only reaches live backends.` });
    if (f['no-backend']) out.push({ level: 'bad', text: `The Load Balancer had no live backend for ${pct(f['no-backend'])} of requests. One backend is a single point of failure. Add a second server, in a different AZ.` });
    if (f['no-db']) out.push({ level: 'bad', text: `${pct(f['no-db'])} of requests needed a database and found none. Link Web -> DB Primary (or Web -> Cache -> DB).` });
    if (f['db-dead']) out.push({ level: 'bad', text: `${pct(f['db-dead'])} failed because the database was down with no promoted replica. Add a DB Replica, link Primary -> Replica (replication) and Web/Cache -> Replica (reads during failover). Failover still takes ${FAILOVER_SECONDS}s: that is why even multi-AZ databases have an SLA below 100%.` });
    if (f['replica-readonly']) out.push({ level: 'bad', text: `Writes were sent to a replica (${pct(f['replica-readonly'])}). Replicas are read-only until promoted. Only link writes to the Primary.` });
    if (f['queue-full']) out.push({ level: 'bad', text: `The queue overflowed. Workers drain slower than jobs arrive. Add workers.` });

    const overloaded = nodes.filter(n => (n.reasons.overload || 0) > 0).sort((a, b) => b.reasons.overload - a.reasons.overload);
    for (const n of overloaded.slice(0, 3)) {
      const cap = sim.capOf(n);
      if (WEB_KINDS.includes(n.kind)) out.push({ level: 'bad', text: `${n.id} was over capacity (peak ${Math.round(n.peakLoad)} req/s vs ${cap}). Dropped ${pct(n.reasons.overload)}. Add servers behind the Load Balancer, use Auto Scaling, or shave load with a CDN (static) and Cache (reads).` });
      else if (n.kind === 'db' || n.kind === 'replica') out.push({ level: 'bad', text: `${n.id} saturated (peak ${Math.round(n.peakLoad)} req/s vs ${cap}). Reads should hit a Cache first, or be spread over Read Replicas. Writes can be buffered through a Queue.` });
      else if (n.kind === 'cache') out.push({ level: 'warn', text: `${n.id} was over capacity. Rare, but possible under extreme spikes.` });
    }
    const deadFails = nodes.filter(n => (n.reasons.dead || 0) > 0 && !WEB_KINDS.includes(n.kind) && n.kind !== 'db' && n.kind !== 'replica');
    for (const n of deadFails.slice(0, 2)) out.push({ level: 'bad', text: `${n.id} went down and ${pct(n.reasons.dead)} of requests died with it. Give it a sibling so traffic can route around.` });
    const deadWeb = webs.filter(n => (n.reasons.dead || 0) > 0);
    if (deadWeb.length && !f['dead-entry']) out.push({ level: 'bad', text: `Traffic was still routed to dead web servers (${deadWeb.map(n => n.id).join(', ')}). A CDN forwards blindly: put a Load Balancer between CDN and servers.` });

    // structural warnings
    if (webs.length === 1 && !(webs[0].kind === 'asg')) out.push({ level: 'warn', text: `One web server is a single point of failure. Two small servers behind a Load Balancer beat one big one.` });
    if (webs.length > 1 && !lbs.length && !cdns.length) out.push({ level: 'warn', text: `Multiple servers with no Load Balancer: users pick servers by DNS round-robin, dead ones included.` });
    const zonal = nodes.filter(n => !n.def.zoneless);
    const zonesUsed = new Set(zonal.map(n => n.zone));
    if (zonal.length > 1 && zonesUsed.size === 1) out.push({ level: 'warn', text: `Everything sits in one Availability Zone. An AZ outage takes all of it down. Spread across the three zone bands.` });
    if (dbs.length && !reps.length && (scenario.events || []).some(e => e.type === 'az' || (e.type === 'kill' && [].concat(e.target).includes('db')))) out.push({ level: 'warn', text: `No DB Replica. When the primary goes, writes stop until it is back.` });
    if (reps.length && !reps.some(r => sim.inn[r.id].some(p => p.kind === 'db'))) out.push({ level: 'warn', text: `A replica with no Primary -> Replica link replicates nothing and can never be promoted.` });
    if (reps.length && !reps.some(r => sim.inn[r.id].some(p => WEB_KINDS.includes(p.kind) || p.kind === 'cache'))) out.push({ level: 'warn', text: `Nobody reads from the replica. Link Web or Cache -> Replica so reads survive a primary failure.` });
    if (queues.length && !workers.length) out.push({ level: 'bad', text: `Queue with no Worker: jobs are accepted and never processed.` });
    if (workers.length && !queues.length) out.push({ level: 'warn', text: `Workers without a Queue have nothing to pull from.` });
    if ((scenario.mix.async || 0) > 0 && !queues.length) out.push({ level: 'warn', text: `Async jobs are processed inline on the web tier: 3x capacity and +${LOCAL_ASYNC_LAT}ms per job. Hand them to a Queue + Workers.` });
    if ((scenario.mix.read || 0) >= 0.5 && !caches.length && dbs.length) out.push({ level: 'warn', text: `Read-heavy workload with no Cache. A cache serves ~80% of reads and is cheaper than a replica.` });
    if ((scenario.mix.static || 0) >= 0.3 && !cdns.length) out.push({ level: 'warn', text: `${Math.round(scenario.mix.static * 100)}% of traffic is static. A CDN serves it at the edge: less load, less latency.` });

    const costCheck = r.checks.find(c => c.key === 'cost');
    if (costCheck && !costCheck.pass) {
      const items = [...nodes].map(n => ({ id: n.id, cost: n.def.cost + (n.kind === 'asg' ? n.def.perInstance * n.instances : 0), util: n.peakLoad / sim.capOf(n) })).sort((a, b) => b.cost - a.cost);
      const idle = items.filter(i => i.util < 0.2).map(i => i.id);
      out.push({ level: 'bad', text: `Over budget by $${r.cost - scenario.budget}.${idle.length ? ' Barely used: ' + idle.join(', ') + '.' : ''} Right-size: small servers behind a LB, cache instead of replicas, auto scaling instead of fixed peak capacity.` });
    }
    const latCheck = r.checks.find(c => c.key === 'latency');
    if (latCheck && !latCheck.pass) out.push({ level: 'bad', text: `Latency ${Math.round(r.latency)}ms over target ${scenario.targets.latency}ms. Nodes above 70% utilisation add queueing delay; CDN cuts static latency, Cache cuts read latency, Queue removes inline job time.` });
    const jobsCheck = r.checks.find(c => c.key === 'jobs');
    if (jobsCheck && !jobsCheck.pass) out.push({ level: 'bad', text: `Only ${r.jobs.toFixed(1)}% of async jobs finished. Drain rate (workers x 40/s) must beat arrival rate with headroom for failures. Workers also need a DB to write to.` });

    if (!out.length) out.push({ level: 'good', text: 'Clean run. No dropped requests, no structural warnings.' });
    if (r.pass && r.stars === 3) out.push({ level: 'good', text: `Under 80% of budget. Efficient and resilient.` });
    else if (r.pass && costCheck) out.push({ level: 'good', text: `Passed. 3 stars need cost <= $${Math.round(scenario.budget * 0.8)} (you: $${r.cost}).` });
    return out;
  }

  const api = { Sim, analyze, REASON_TEXT, REASON_LABEL, FAILOVER_SECONDS };
  if (typeof module !== 'undefined') module.exports = api; else Object.assign(global, api);
})(typeof window !== 'undefined' ? window : globalThis);
