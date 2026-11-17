// Cloud Tycoon UI: canvas world, editing, live simulation, results.
(function () {
  const $ = id => document.getElementById(id);
  const TILE = 24, GX = 32, GY = 12;
  const cv = $('world'), ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const W = cv.width, H = cv.height;
  const USERS = { x: 16, y: GY + GRID.rows * TILE / 2 };
  const ZONE_TINT = [['#f3f7df', '#e6efcb'], ['#e3f1f4', '#d3e6ec'], ['#f6efdc', '#ebe1c6']]; // checker floor per zone
  const NET_TINT = { edge: ['#e9e9e4', '#dcdcd5'], public: ['#f6f3cf', '#ece8b8'], private: ['#dbe6f6', '#c9d8ee'] }; // floor per subnet type in network levels
  const INK = '#0b3009';
  const SIM_SPEED = 2; // sim seconds per real second at 1x

  const S = {
    sc: null, design: { nodes: [], edges: [] },
    tool: null, selected: null, hover: null, drag: null,
    sim: null, simAcc: 0, speed: 1, lastResult: null,
    packets: [], puffs: [], pktAcc: {}, azDown: null, shake: 0,
    fails: {}, muted: false, frame: 0
  };

  // ---------- storage ----------
  // One-time migration of saves from the game's old names.
  try {
    for (const old of ['cloudcommander.', 'cloudcraft.']) for (const k of Object.keys(localStorage)) if (k.startsWith(old)) {
      const nk = 'cloudtycoon.' + k.slice(old.length);
      if (localStorage.getItem(nk) == null) localStorage.setItem(nk, localStorage.getItem(k));
      localStorage.removeItem(k);
    }
  } catch (e) { /* storage unavailable */ }
  const store = {
    get(k, d) { try { const v = localStorage.getItem('cloudtycoon.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('cloudtycoon.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  };
  let progress = store.get('progress', {});

  // ---------- sound ----------
  let actx = null;
  function beep(freq, dur, type, vol) {
    if (S.muted) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type || 'square'; o.frequency.value = freq;
      g.gain.value = vol || 0.04; g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
      o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + dur);
    } catch (e) { /* no audio */ }
  }
  const sfx = {
    place: () => beep(520, 0.06), link: () => { beep(660, 0.05); setTimeout(() => beep(880, 0.06), 50); },
    del: () => beep(180, 0.08, 'sawtooth'), err: () => beep(120, 0.15, 'sawtooth', 0.05),
    boom: () => { beep(90, 0.3, 'sawtooth', 0.08); setTimeout(() => beep(60, 0.3, 'sawtooth', 0.08), 80); },
    win: () => [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => beep(f, 0.15), i * 110)),
    lose: () => [392, 330, 262].forEach((f, i) => setTimeout(() => beep(f, 0.2, 'triangle', 0.06), i * 160))
  };

  // ---------- helpers ----------
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const nodeAt = (col, row) => S.design.nodes.find(n => n.col === col && n.row === row);
  const byId = id => S.design.nodes.find(n => n.id === id);
  const center = n => n === 'users' || (n && n.id === 'users') ? USERS : { x: GX + n.col * TILE + TILE / 2, y: GY + n.row * TILE + TILE / 2 };
  const posOf = id => id === 'users' ? USERS : center(byId(id));
  const running = () => !!S.sim;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 2600); }
  function newId(kind) { let i = 1; while (byId(`${kind}-${i}`)) i++; return `${kind}-${i}`; }
  function saveDesign() { if (S.sc) store.set('design.' + S.sc.id, S.design); }
  const clone = o => JSON.parse(JSON.stringify(o));

  function toTile(ev) {
    const r = cv.getBoundingClientRect();
    const x = (ev.clientX - r.left) * W / r.width, y = (ev.clientY - r.top) * H / r.height;
    const col = Math.floor((x - GX) / TILE), row = Math.floor((y - GY) / TILE);
    const inGrid = col >= 0 && col < GRID.cols && row >= 0 && row < GRID.rows;
    const onUsers = x < GX - 2 && Math.abs(y - USERS.y) < 16;
    return { x, y, col, row, inGrid, onUsers };
  }

  // ---------- editing ----------
  function place(kind, col, row) {
    const def = COMPONENTS[kind];
    if (nodeAt(col, row)) return;
    if (!placeOk(kind, col)) return;
    if (def.max && S.design.nodes.filter(n => n.kind === kind).length >= def.max) { toast(`Only ${def.max} ${def.name} allowed.${kind === 'db' ? ' Use replicas.' : ''}`); sfx.err(); return; }
    const n = { id: newId(kind), kind, col, row, cfg: kind === 'asg' ? { min: 1 } : {} };
    S.design.nodes.push(n); S.selected = n.id; sfx.place(); changed();
  }
  // Network levels: IGW and S3 sit outside the VPC, everything else inside a subnet.
  function placeOk(kind, col) {
    if (!S.sc.net || canPlace(kind, col)) return true;
    toast(subnetOf(col) === 'edge' ? `${COMPONENTS[kind].name} must be inside the VPC, in a public or private subnet.` : `${COMPONENTS[kind].name} sits outside the VPC: place it in the two leftmost columns.`);
    sfx.err(); return false;
  }
  function removeNode(id) {
    S.design.nodes = S.design.nodes.filter(n => n.id !== id);
    S.design.edges = S.design.edges.filter(e => e.from !== id && e.to !== id);
    if (S.selected === id) S.selected = null;
    sfx.del(); changed();
  }
  function toggleLink(from, to) {
    const fk = from === 'users' ? 'users' : byId(from).kind, tk = byId(to).kind;
    const i = S.design.edges.findIndex(e => e.from === from && e.to === to);
    if (i >= 0) { S.design.edges.splice(i, 1); sfx.del(); changed(); return; }
    if (!canLink(fk, tk)) {
      // friendly: maybe they dragged backwards
      if (from !== 'users' && canLink(tk, fk)) return toggleLink(to, from);
      const ok = (LINK_RULES[fk] || []).map(k => COMPONENTS[k].name).join(', ') || 'nothing';
      toast(`${fk === 'users' ? 'Users' : COMPONENTS[fk].name} cannot link to ${COMPONENTS[tk].name}. It can link to: ${ok}.`); sfx.err(); return;
    }
    S.design.edges.push({ from, to }); sfx.link(); changed();
  }
  function changed() { saveDesign(); renderBrief(); renderInspect(); renderStats(); }

  // ---------- pointer ----------
  cv.addEventListener('pointerdown', ev => {
    if (ev.button === 2) return;
    const p = toTile(ev);
    const n = p.inGrid ? nodeAt(p.col, p.row) : null;
    if (running()) { S.selected = n ? n.id : null; renderInspect(); return; }
    if (p.onUsers) { S.drag = { from: 'users', x: p.x, y: p.y, sx: p.x, sy: p.y, moved: false }; cv.setPointerCapture(ev.pointerId); return; }
    if (n) { S.drag = { from: n.id, x: p.x, y: p.y, sx: p.x, sy: p.y, moved: false }; cv.setPointerCapture(ev.pointerId); return; }
    if (p.inGrid && S.tool) { place(S.tool, p.col, p.row); return; }
    S.selected = null; renderInspect();
  });
  cv.addEventListener('pointermove', ev => {
    const p = toTile(ev);
    S.hover = p;
    if (S.drag) { S.drag.x = p.x; S.drag.y = p.y; if (Math.hypot(p.x - S.drag.sx, p.y - S.drag.sy) > 5) S.drag.moved = true; }
  });
  cv.addEventListener('pointerup', ev => {
    const d = S.drag; S.drag = null;
    if (!d) return;
    const p = toTile(ev);
    const target = p.inGrid ? nodeAt(p.col, p.row) : null;
    if (!d.moved) { if (d.from !== 'users') { S.selected = d.from; renderInspect(); } return; }
    if (target && target.id !== d.from) { toggleLink(d.from, target.id); return; }
    if (!target && p.inGrid && d.from !== 'users') { const n = byId(d.from); if (!placeOk(n.kind, p.col)) return; n.col = p.col; n.row = p.row; sfx.place(); changed(); return; }
    if (!target && p.onUsers && d.from !== 'users') toast('Traffic flows out of Users, not into them. Drag from Users to the node.');
  });
  cv.addEventListener('pointerleave', () => { S.hover = null; });
  cv.addEventListener('contextmenu', ev => {
    ev.preventDefault();
    if (running()) return;
    const p = toTile(ev); const n = p.inGrid ? nodeAt(p.col, p.row) : null;
    if (n) removeNode(n.id); else if (S.tool) setTool(null);
  });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { setTool(null); document.querySelectorAll('.overlay').forEach(o => { if (o.id !== 'levels' || S.sc) o.classList.add('hidden'); }); }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && S.selected && !running()) { ev.preventDefault(); removeNode(S.selected); }
  });

  // ---------- palette ----------
  function setTool(kind) {
    S.tool = kind;
    document.querySelectorAll('.pal').forEach(b => b.classList.toggle('on', b.dataset.kind === kind));
    if (kind) showHint(kind);
  }
  function showHint(kind) {
    const d = COMPONENTS[kind];
    $('hint').innerHTML = `<b>${esc(d.name)}</b> &middot; $${d.cost}${d.perInstance ? ' + $' + d.perInstance + '/inst' : ''}<br>${esc(d.desc)}<br><span class="warn">${esc(d.tip)}</span>`;
  }
  function renderPalette() {
    const pal = $('palette'); pal.innerHTML = '';
    for (const kind of Object.keys(COMPONENTS)) {
      const d = COMPONENTS[kind];
      const b = document.createElement('button');
      b.className = 'pal'; b.dataset.kind = kind;
      const locked = !S.sc.allowed.includes(kind);
      if (locked) { b.classList.add('locked'); b.title = 'Not available in this scenario'; }
      const ic = document.createElement('canvas'); ic.width = 16; ic.height = 16;
      ic.getContext('2d').drawImage(Sprites.sprite(kind), 0, 0);
      b.appendChild(ic);
      b.insertAdjacentHTML('beforeend', `<span class="nm">${esc(d.name)}</span><span class="ct">$${d.cost}</span>`);
      b.onmouseenter = () => showHint(kind);
      b.onclick = () => { if (locked || running()) return; setTool(S.tool === kind ? null : kind); };
      pal.appendChild(b);
    }
  }

  // ---------- panels ----------
  const EV_TEXT = e => e.type === 'scan' ? 'bots scan for ports 22 and 3306 open to the internet'
    : e.type === 'kill' ? `${[].concat(e.target).includes('db') ? 'database' : [].concat(e.target).includes('cache') ? 'cache' : [].concat(e.target).includes('worker') ? 'worker' : 'server'} crash (${e.duration}s)`
    : e.type === 'az' ? `AZ outage, ${e.zone === 'busiest' ? 'your busiest zone' : 'AZ-' + 'abc'[e.zone]} (${e.duration}s)` : `traffic spike x${e.mult} (${e.duration}s)`;

  function renderBrief() {
    const sc = S.sc, m = sc.mix;
    const cost = designCost(S.design);
    const seg = (k, c) => m[k] ? `<i style="width:${m[k] * 100}%;background:${c}" title="${k}"></i>` : '';
    const leg = FLOW_KINDS.filter(k => m[k]).map(k => `<span><i class="dot" style="background:${FLOW_COLORS[k]}"></i> ${Math.round(m[k] * 100)}% ${k}</span>`).join(' ');
    const over = isFinite(sc.budget) && cost > sc.budget;
    $('tbCost').textContent = '$' + cost; $('tbRate').textContent = sc.rate + '/s';
    $('tbNodes').textContent = S.design.nodes.length; $('tbThreats').textContent = sc.events.length;
    $('tbLeft').textContent = isFinite(sc.budget) ? (over ? '-$' + (cost - sc.budget) : '$' + (sc.budget - cost)) : 'no limit';
    $('money').classList.toggle('over', over);
    $('brief').innerHTML = `
      <p class="story">${esc(sc.story)}</p>
      <ul>${sc.learn.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
      <div class="req"><span>Traffic</span><b>${sc.rate} req/s${sc.originLatency ? ', +' + sc.originLatency + 'ms to origin' : ''}</b></div>
      <div class="mix">${seg('static', FLOW_COLORS.static)}${seg('read', FLOW_COLORS.read)}${seg('write', FLOW_COLORS.write)}${seg('async', FLOW_COLORS.async)}</div>
      <div class="mixlegend">${leg}</div>
      <div class="req"><span>Availability</span><b>&ge; ${sc.targets.availability}%</b></div>
      <div class="req"><span>Avg latency</span><b>&le; ${sc.targets.latency}ms</b></div>
      ${m.async ? `<div class="req"><span>Jobs completed</span><b>&ge; ${sc.targets.jobs || 95}%</b></div>` : ''}
      ${sc.net ? '<div class="req"><span>Security audit</span><b>0 findings</b></div>' : ''}
      ${isFinite(sc.budget) ? `<div class="req"><span>Budget</span><b class="${over ? 'bad' : ''}">$${cost} / $${sc.budget}</b></div>` : `<div class="req"><span>Cost</span><b>$${cost}</b></div>`}
      ${sc.events.length ? `<h3>THREAT FORECAST</h3>${sc.events.map(e => `<div class="req threat"><span>t=${e.t}s</span><span>${esc(EV_TEXT(e))}</span></div>`).join('')}` : (sc.sandbox ? '<h3>THREATS</h3><div class="info">You are the threat. Chaos buttons appear when you hit Run.</div>' : '<h3>THREAT FORECAST</h3><div class="info">Clear skies.</div>')}`;
  }

  // Per-node settings in network levels. Click cycles through the values; the first one is the AWS default.
  const OPEN = [[0, 'CLOSED'], [1, '0.0.0.0/0']];
  function netFields(n) {
    if (WEB_KINDS.includes(n.kind)) return [
      { key: 'http', label: 'SG inbound 80 (HTTP)', vals: OPEN },
      { key: 'https', label: 'SG inbound 443 (HTTPS)', vals: OPEN },
      { key: 'ssh', label: 'SG inbound 22 (SSH)', vals: [[0, 'CLOSED'], ['myip', 'MY IP /32'], ['any', '0.0.0.0/0']] },
      ...(S.sc.allowed.includes('s3') ? [{ key: 's3auth', label: 'S3 access', vals: [[0, 'NONE'], ['key', 'ACCESS KEY IN .ENV'], ['role', 'IAM ROLE']] }] : [])];
    if (n.kind === 'db') return [{ key: 'dbsrc', label: 'SG inbound 3306 (MySQL)', vals: [[0, 'CLOSED'], ['web', 'FROM SG-WEB'], ['any', '0.0.0.0/0']] }];
    if (n.kind === 's3') return [{ key: 'public', label: 'Bucket access', vals: [[0, 'PRIVATE'], [1, 'PUBLIC READ']] }];
    return [];
  }

  function renderInspect() {
    const box = $('inspect');
    const n = S.selected && byId(S.selected);
    if (!n) { box.innerHTML = 'Nothing selected. Click a node.'; return; }
    const d = COMPONENTS[n.kind];
    const sn = S.sim && S.sim.byId[n.id];
    const outs = S.design.edges.filter(e => e.from === n.id), ins = S.design.edges.filter(e => e.to === n.id);
    const cap = n.kind === 'asg' ? `${d.cap} x instances (max ${d.maxInstances})` : d.cap >= 1e5 ? 'unlimited' : d.cap + ' /s';
    let h = `<div class="ttl">${esc(n.id)}</div>
      <div><b>${esc(d.name)}</b> &middot; ${d.zoneless ? 'managed, multi-AZ' : 'AZ-' + 'abc'[zoneOf(n.row)]}</div>
      <div>Capacity: <b>${cap}</b> &middot; Cost: <b>$${d.cost}${n.kind === 'asg' ? ' + $' + d.perInstance * (n.cfg.min || 1) : ''}</b> &middot; +${d.lat}ms</div>`;
    if (S.sc.net) {
      const sub = subnetOf(n.col), z = zoneOf(n.row);
      h += `<div>Location: <b>${sub === 'edge' ? 'outside the VPC' : `${sub} subnet ${'abc'[z]} (10.0.${z + 1 + (sub === 'private' ? 10 : 0)}.0/24)`}</b></div>`;
      for (const f of netFields(n)) {
        const cur = f.vals.find(v => v[0] === (n.cfg[f.key] || 0)) || f.vals[0];
        h += `<div>${f.label}: <button class="mini" data-cfg="${f.key}" ${S.sim ? 'disabled' : ''}>${cur[1]}</button></div>`;
      }
      if (n.kind === 'replica') h += `<div>Security Group: <b>same as DB Primary</b></div>`;
    }
    if (n.kind === 'asg') h += `<div>Min instances: <button class="mini" data-min="-1">-</button> <b>${n.cfg.min || 1}</b> <button class="mini" data-min="1">+</button></div>`;
    if (sn) {
      const c = S.sim.capOf(sn);
      const dropping = sn.failReason && S.sim.t - sn.failAt < 0.6 && REASON_LABEL[sn.failReason];
      const why = Object.entries(sn.reasons).sort((a, b) => b[1] - a[1]);
      h += `<div>Status: <b class="${sn.dead || dropping ? 'bad' : 'good'}">${sn.dead ? (sn.downWhy || 'DOWN') : dropping ? REASON_LABEL[sn.failReason] : 'UP'}</b>${sn.kind === 'replica' && sn.promoted ? ' <b class="warn">PROMOTED</b>' : ''}${sn.kind === 'asg' ? ' &middot; ' + sn.instances + ' inst' : ''}</div>
        <div>Load: <b>${Math.round(sn.load)} / ${c >= 1e5 ? 'inf' : c}</b>${sn.kind === 'queue' ? ' &middot; backlog <b>' + Math.round(sn.backlog) + '</b>' : ''}</div>
        <div>Served: <b>${Math.round(sn.served)}</b> &middot; Dropped: <b class="${sn.failed ? 'bad' : ''}">${Math.round(sn.failed)}</b></div>`;
      if (why.length) h += `<div class="bad">Why requests dropped here:</div>` + why.map(([r, v]) => `<div class="bad">&middot; ${Math.round(v)}: ${esc(REASON_TEXT[r] || r)}</div>`).join('');
    } else {
      h += `<div class="links">In: ${ins.map(e => `<button data-from="${e.from}" data-to="${e.to}" title="remove link">${esc(e.from)} x</button>`).join('') || '<span class="info">none</span>'}</div>
        <div class="links">Out: ${outs.map(e => `<button data-from="${e.from}" data-to="${e.to}" title="remove link">${esc(e.to)} x</button>`).join('') || '<span class="info">none</span>'}</div>
        <button class="mini" data-del="1">delete node</button>`;
    }
    h += `<div style="margin-top:6px">${esc(d.desc)}</div>`;
    box.innerHTML = h;
    box.querySelectorAll('[data-from]').forEach(b => b.onclick = () => toggleLink(b.dataset.from, b.dataset.to));
    box.querySelectorAll('[data-min]').forEach(b => b.onclick = () => { n.cfg.min = Math.max(1, Math.min(d.maxInstances, (n.cfg.min || 1) + +b.dataset.min)); changed(); });
    box.querySelectorAll('[data-cfg]').forEach(b => b.onclick = () => {
      const f = netFields(n).find(x => x.key === b.dataset.cfg), i = f.vals.findIndex(v => v[0] === (n.cfg[f.key] || 0));
      n.cfg[f.key] = f.vals[(i + 1) % f.vals.length][0]; changed();
    });
    const del = box.querySelector('[data-del]'); if (del) del.onclick = () => removeNode(n.id);
  }

  function renderStats() {
    const sim = S.sim;
    if (!sim) {
      $('stRate').textContent = S.sc.rate + ' req/s'; $('stAvail').textContent = '-'; $('stLat').textContent = '-';
      $('stCost').textContent = '$' + designCost(S.design); $('stBacklog').textContent = '-';
      $('stAvail').className = ''; return;
    }
    const st = sim.stats;
    const av = st.total ? st.ok / st.total * 100 : 100;
    $('stRate').textContent = Math.round(S.sc.rate * sim.spike) + ' req/s';
    $('stRate').className = sim.spike > 1 ? 'warn' : '';
    $('stAvail').textContent = av.toFixed(2) + '%';
    $('stAvail').className = av >= S.sc.targets.availability ? 'good' : 'bad';
    const lat = st.ok ? st.latSum / st.ok : 0;
    $('stLat').textContent = Math.round(lat) + 'ms'; $('stLat').className = lat <= S.sc.targets.latency ? 'good' : 'bad';
    $('stCost').textContent = '$' + sim.cost();
    const bl = sim.nodes.filter(n => n.kind === 'queue').reduce((a, n) => a + n.backlog, 0);
    $('stBacklog').textContent = sim.nodes.some(n => n.kind === 'queue') ? Math.round(bl) + ' jobs' : '-';
  }

  function drawChart() {
    const c = $('chart'), x = c.getContext('2d');
    x.fillStyle = '#f4fbe6'; x.fillRect(0, 0, c.width, c.height);
    const series = S.sim ? S.sim.stats.series : (S.lastResult ? S.lastResult.series : []);
    if (!series.length) return;
    const dur = S.sc.duration, bw = c.width / dur;
    const max = Math.max(...series.map(s => s.ok + s.fail), 1);
    for (const s of series) {
      const px = Math.floor((s.t - 1) * bw), w = Math.max(1, Math.ceil(bw) - 1);
      const hOk = Math.round(s.ok / max * (c.height - 4)), hF = Math.round(s.fail / max * (c.height - 4));
      x.fillStyle = '#3aa62b'; x.fillRect(px, c.height - hOk, w, hOk);
      x.fillStyle = '#e03150'; x.fillRect(px, c.height - hOk - hF, w, hF);
    }
  }

  function logLine(l) {
    const el = $('log'); const d = document.createElement('div');
    d.className = l.level; d.innerHTML = `<span>${String(l.t).padStart(4)}s</span>${esc(l.text)}`;
    el.appendChild(d); el.scrollTop = el.scrollHeight;
  }

  function renderTimeMarks() {
    const m = $('timemarks'); m.innerHTML = '';
    for (const e of S.sc.events) {
      const a = e.t / S.sc.duration * 100, w = e.duration / S.sc.duration * 100;
      m.insertAdjacentHTML('beforeend', `<i style="left:${a}%" title="${esc(EV_TEXT(e))}"></i><i class="span" style="left:${a}%;width:${w}%"></i>`);
    }
    $('timefill').style.width = '0'; $('timetext').textContent = `0 / ${S.sc.duration}s`;
  }

  // ---------- simulation control ----------
  function startSim() {
    if (!S.design.nodes.length) { toast('Place something first.'); sfx.err(); return; }
    setTool(null);
    S.packets = []; S.puffs = []; S.pktAcc = {}; S.azDown = null; S.simAcc = 0; S.lastResult = null;
    $('log').innerHTML = '';
    const unit = Math.max(0.5, S.sc.rate * 0.1 / 3);
    S.sim = new Sim(clone(S.design), S.sc, {
      onFlow(flows) {
        for (const f of flows) {
          const key = f.from + '>' + f.to + ':' + f.kind;
          S.pktAcc[key] = (S.pktAcc[key] || 0) + f.amt / unit;
          while (S.pktAcc[key] >= 1) { S.pktAcc[key] -= 1; if (S.packets.length < 500) S.packets.push({ from: f.from, to: f.to, kind: f.kind, p: 0, j: (Math.random() - 0.5) * 4 }); }
        }
      },
      onFail(node) { if (Math.random() < 0.25 && S.puffs.length < 80) { const c = center(node); S.puffs.push({ x: c.x + (Math.random() - 0.5) * 12, y: c.y - 6, life: 1, kind: 'x' }); } },
      onKill(node) { const c = center(node); for (let i = 0; i < 14; i++) S.puffs.push({ x: c.x, y: c.y, vx: (Math.random() - 0.5) * 60, vy: (Math.random() - 0.8) * 60, life: 1, kind: 'spark' }); S.shake = 0.35; sfx.boom(); },
      onAz(zone, down) { S.azDown = down ? zone : null; },
      onLog: logLine
    });
    $('btnRun').textContent = 'STOP'; $('btnRun').className = 'btn stop';
    $('btnClear').disabled = true; $('btnSolution').disabled = true;
    $('chaos').classList.toggle('hidden', !S.sc.sandbox);
    logLine({ t: 0, text: 'traffic is live', level: 'info' });
    renderInspect();
  }
  function stopSim(showResult) {
    const sim = S.sim; if (!sim) return;
    S.sim = null; S.packets = []; S.azDown = null;
    $('btnRun').textContent = 'RUN'; $('btnRun').className = 'btn go';
    $('btnClear').disabled = false; $('chaos').classList.add('hidden');
    if (showResult) finish(sim); else { logLine({ t: sim.t, text: 'run aborted', level: 'warn' }); }
    $('btnSolution').disabled = !(S.sc.solution && (S.fails[S.sc.id] || 0) >= 1);
    renderStats(); renderInspect();
  }
  function finish(sim) {
    const r = sim.result(); S.lastResult = r;
    const advice = analyze(sim, S.design, S.sc);
    const sc = S.sc;
    if (r.pass) { if ((progress[sc.id] || 0) < r.stars) { progress[sc.id] = r.stars; store.set('progress', progress); } sfx.win(); }
    else { S.fails[sc.id] = (S.fails[sc.id] || 0) + 1; sfx.lose(); }
    $('resTitle').textContent = sc.sandbox ? 'SANDBOX REPORT' : r.pass ? 'SURVIVED!' : 'INCIDENT REVIEW';
    $('resTitle').className = r.pass ? 'good' : 'bad';
    $('resStars').innerHTML = sc.sandbox ? '' : '★'.repeat(r.stars) + '<i>' + '★'.repeat(3 - r.stars) + '</i>';
    $('resChecks').innerHTML = r.checks.map(c => `<tr><td>${c.label}</td><td>${c.fmt(c.value)} <span class="info">(need ${c.cmp === '>=' ? '&ge;' : '&le;'} ${c.fmt(c.target)})</span></td><td class="${c.pass ? 'good' : 'bad'}">${c.pass ? 'OK' : 'MISS'}</td></tr>`).join('');
    $('resAdvice').innerHTML = advice.map(a => `<li class="${a.level}">${esc(a.text)}</li>`).join('');
    $('resLesson').innerHTML = r.pass ? `<b class="good">Lesson:</b> ${esc(sc.lesson)}` : `<span class="info">Fix the red items and run again. ${sc.solution ? 'Stuck? SHOW A SOLUTION is now unlocked.' : ''}</span>`;
    const idx = SCENARIOS.indexOf(sc);
    $('btnNext').classList.toggle('hidden', !r.pass || idx >= SCENARIOS.length - 1);
    $('result').classList.remove('hidden');
    renderHeader(); drawChart();
  }

  $('btnRun').onclick = () => running() ? stopSim(!!S.sc.sandbox) : startSim();
  $('btnSpeed').onclick = () => { S.speed = S.speed === 1 ? 2 : S.speed === 2 ? 4 : 1; $('btnSpeed').textContent = `SPEED ${S.speed}x`; };
  $('btnClear').onclick = () => { if (!S.design.nodes.length || confirm('Remove everything from the map?')) { S.design = { nodes: [], edges: [] }; S.selected = null; changed(); } };
  $('btnSolution').onclick = () => { if (S.sc.solution && confirm('Replace your design with one working reference design? There are other valid answers.')) { S.design = clone(S.sc.solution); S.selected = null; changed(); toast('Reference design loaded. Study the links, then hit RUN.'); } };
  $('btnRetry').onclick = () => $('result').classList.add('hidden');
  $('btnNext').onclick = () => { $('result').classList.add('hidden'); const i = SCENARIOS.indexOf(S.sc); loadScenario(SCENARIOS[Math.min(SCENARIOS.length - 1, i + 1)]); };
  $('btnLevels').onclick = () => { if (running()) stopSim(false); showLevels(); };
  $('btnHelp').onclick = () => $('help').classList.remove('hidden');
  $('btnHelpClose').onclick = () => { $('help').classList.add('hidden'); store.set('helped', true); };
  $('btnMute').onclick = () => { S.muted = !S.muted; $('btnMute').textContent = S.muted ? 'SOUND OFF' : 'SOUND ON'; store.set('muted', S.muted); };
  document.querySelectorAll('[data-chaos]').forEach(b => b.onclick = () => {
    if (!S.sim) return; const k = b.dataset.chaos;
    if (k === 'az') { if (S.sim.activeAz != null) return toast('One AZ outage at a time.'); S.sim.inject({ type: 'az', zone: Math.floor(Math.random() * 3), duration: 15 }); }
    else if (k === 'spike') S.sim.inject({ type: 'spike', mult: 4, duration: 10 });
    else S.sim.inject({ type: 'kill', target: k === 'web' ? WEB_KINDS : [k], duration: 15, fallback: false });
  });

  // ---------- levels ----------
  function renderHeader() {
    const total = SCENARIOS.filter(s => !s.sandbox).length * 3;
    const got = Object.entries(progress).filter(([k]) => SCENARIOS.some(s => s.id === k && !s.sandbox)).reduce((a, [, v]) => a + v, 0);
    $('starTotal').textContent = `${got}/${total}`;
    if (S.sc) $('levelName').textContent = `${SCENARIOS.indexOf(S.sc) + 1}. ${S.sc.title.toUpperCase()}`;
  }
  function showLevels() {
    const g = $('levelGrid'); g.innerHTML = '';
    SCENARIOS.forEach((sc, i) => {
      const st = progress[sc.id] || 0;
      const b = document.createElement('button'); b.className = 'card';
      b.innerHTML = `<div class="n">${sc.sandbox ? 'FREE PLAY' : 'SCENARIO ' + (i + 1)}</div><div class="t">${esc(sc.title)}</div><div class="g">${esc(sc.tag)}</div>${sc.sandbox ? '' : `<div class="st">${'★'.repeat(st)}<i>${'★'.repeat(3 - st)}</i></div>`}`;
      b.onclick = () => { $('levels').classList.add('hidden'); loadScenario(sc); };
      g.appendChild(b);
    });
    $('levels').classList.remove('hidden');
  }
  function loadScenario(sc) {
    S.sc = sc; S.selected = null; S.lastResult = null; S.tool = null;
    // Levels with `carry` continue from the design the player left in the previous level.
    const saved = store.get('design.' + sc.id, null) || (sc.carry ? store.get('design.' + sc.carry, null) : null);
    S.design = saved && saved.nodes ? clone(saved) : (sc.start ? clone(sc.start) : { nodes: [], edges: [] });
    S.design.nodes = S.design.nodes.filter(n => COMPONENTS[n.kind]);
    store.set('last', sc.id);
    $('log').innerHTML = ''; logLine({ t: 0, text: `${sc.title}: build, then RUN`, level: 'info' });
    $('btnSolution').disabled = !(sc.solution && (S.fails[sc.id] || 0) >= 1);
    $('btnSolution').classList.toggle('hidden', !sc.solution);
    renderPalette(); renderBrief(); renderInspect(); renderStats(); renderTimeMarks(); renderHeader(); drawChart();
    $('hint').innerHTML = sc.net ? `${sc.carry ? 'This is your architecture from the previous level. Continue from here. ' : ''}<b>Click a node</b> to set its Security Group. Internet Gateway and S3 go outside the VPC (two leftmost columns).` : sc.start && !saved ? 'This design is already running in prod. <b>Right-click</b> nodes to delete what you do not need.' : 'Pick a component, click the map to place it. <b>Drag node to node</b> to link. Start from the <b>Users</b> icon. Right-click deletes.';
  }

  // ---------- drawing ----------
  function line(x0, y0, x1, y1, color, dash) {
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash(dash || []);
    ctx.beginPath(); ctx.moveTo(Math.round(x0) + 0.5, Math.round(y0) + 0.5); ctx.lineTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5); ctx.stroke(); ctx.setLineDash([]);
  }
  function arrow(a, b, color, dash) {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    const sx = a.x + ux * 9, sy = a.y + uy * 9, ex = b.x - ux * 10, ey = b.y - uy * 10;
    line(sx, sy, ex, ey, color, dash);
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(ex - ux * 2 - uy * 2), Math.round(ey - uy * 2 + ux * 2), 2, 2);
    ctx.fillRect(Math.round(ex - ux * 2 + uy * 2) , Math.round(ey - uy * 2 - ux * 2), 2, 2);
    ctx.fillRect(Math.round(ex) - 1, Math.round(ey) - 1, 2, 2);
  }
  function text(str, x, y, color, align) {
    ctx.font = '8px monospace'; ctx.textAlign = align || 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = INK; for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1]]) ctx.fillText(str, x + ox, y + oy);
    ctx.fillStyle = color; ctx.fillText(str, x, y);
  }

  function draw(dt) {
    S.frame++;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#4fae35'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#48a330'; for (let gy = 0; gy < H; gy += 8) for (let gx = (gy / 8 % 2) * 8; gx < W; gx += 16) ctx.fillRect(gx, gy, 8, 8);
    if (S.shake > 0) { S.shake -= dt; ctx.translate(Math.round((Math.random() - 0.5) * 4), Math.round((Math.random() - 0.5) * 4)); }
    // zones: horizontal bands stacked top to bottom, label in the right margin
    const gw = GRID.cols * TILE, zh = GRID.rows / GRID.zones * TILE;
    for (let z = 0; z < GRID.zones; z++) {
      const zy = GY + z * zh;
      for (let c = 0; c < GRID.cols; c++) for (let r = 0; r < GRID.rows / GRID.zones; r++) { ctx.fillStyle = (S.sc.net ? NET_TINT[subnetOf(c)] : ZONE_TINT[z])[(c + r) % 2]; ctx.fillRect(GX + c * TILE, zy + r * TILE, TILE, TILE); }
      ctx.fillStyle = 'rgba(11,48,9,0.25)'; ctx.fillRect(GX + 2, zy + zh, gw, 2); // drop shadow under the slab
      ctx.strokeStyle = INK; ctx.lineWidth = 1; ctx.strokeRect(GX + 0.5, zy + 0.5, gw - 1, zh - 1);
      const down = S.azDown === z;
      if (down) {
        ctx.fillStyle = 'rgba(239,71,111,0.30)'; ctx.fillRect(GX, zy, gw, zh);
        ctx.fillStyle = 'rgba(200,30,60,0.45)';
        for (let k = -zh; k < gw; k += 8) for (let s = 0; s < zh; s += 2) { const px = GX + k + s + (S.frame >> 2) % 8; if (px >= GX && px < GX + gw - 1) ctx.fillRect(px, zy + s, 2, 2); }
      }
      const lc = down && (S.frame >> 4) % 2 ? '#ff8fa3' : down ? '#ffe066' : '#ffffff';
      text(`AZ-${'abc'[z]}`, GX + gw + 15, zy + zh / 2 - (down ? 9 : 4), lc, 'center');
      if (down) text('DOWN', GX + gw + 15, zy + zh / 2 + 1, lc, 'center');
    }

    if (S.sc.net) {
      const x0 = GX + 2 * TILE, x1 = GX + 7 * TILE, gh = GRID.rows * TILE;
      ctx.fillStyle = INK; ctx.fillRect(x1 - 1, GY, 2, gh);                       // public | private
      ctx.strokeStyle = '#e8590c'; ctx.lineWidth = 2; ctx.strokeRect(x0, GY + 1, GX + gw - x0 - 1, gh - 2); // the VPC
      text('OUTSIDE', GX + TILE, 2, '#ffffff', 'center');
      text('VPC: PUBLIC SUBNET', (x0 + x1) / 2, 2, '#ffe066', 'center');
      text('VPC: PRIVATE SUBNET', (x1 + GX + gw) / 2, 2, '#bfe3ff', 'center');
    }

    // edges
    const simById = S.sim ? S.sim.byId : null;
    for (const e of S.design.edges) {
      const a = posOf(e.from), b = posOf(e.to); if (!a || !b) continue;
      const fromN = e.from === 'users' ? null : byId(e.from), toN = byId(e.to);
      const repl = fromN && fromN.kind === 'db' && toN.kind === 'replica';
      const sel = S.selected && (e.from === S.selected || e.to === S.selected);
      const deadEnd = simById && ((simById[e.to] && simById[e.to].dead) || (fromN && simById[e.from] && simById[e.from].dead));
      arrow(a, b, deadEnd ? '#d98a9a' : sel ? '#e8590c' : repl ? '#7b3fc4' : '#5d7a63', repl ? [2, 2] : null);
    }
    if (S.drag && S.drag.moved) { const a = posOf(S.drag.from); line(a.x, a.y, S.drag.x, S.drag.y, '#e8590c', [3, 2]); }

    // users
    ctx.drawImage(Sprites.sprite('users'), USERS.x - 8, USERS.y - 8 + (S.sim ? Math.round(Math.sin(S.frame / 6)) : 0));
    text('USERS', USERS.x, USERS.y + 10, '#ffffff', 'center');
    if (!S.design.edges.some(e => e.from === 'users') && !S.sim && (S.frame >> 5) % 2) text('drag>', USERS.x, USERS.y - 20, '#ffe066', 'center');

    // packets
    const pspeed = 2.6 * (S.sim ? S.speed : 1);
    for (let i = S.packets.length - 1; i >= 0; i--) {
      const p = S.packets[i]; p.p += dt * pspeed;
      const a = posOf(p.from), b = byId(p.to) ? posOf(p.to) : null;
      if (p.p >= 1 || !a || !b) { S.packets.splice(i, 1); continue; }
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      const px = Math.round(a.x + dx * p.p - dy / len * p.j) - 1, py = Math.round(a.y + dy * p.p + dx / len * p.j) - 1;
      ctx.fillStyle = INK; ctx.fillRect(px - 1, py - 1, 4, 4);
      ctx.fillStyle = FLOW_COLORS[p.kind]; ctx.fillRect(px, py, 2, 2);
    }

    // nodes
    for (const n of S.design.nodes) {
      const x = GX + n.col * TILE + 4, y = GY + n.row * TILE + 3;
      const sn = simById && simById[n.id];
      const dead = sn && sn.dead;
      if (S.selected === n.id) { ctx.strokeStyle = '#e8590c'; ctx.lineWidth = 1; ctx.strokeRect(x - 2.5, y - 2.5, 21, 21); }
      ctx.globalAlpha = dead ? 0.35 : 1;
      ctx.drawImage(Sprites.sprite(n.kind), x, y + (dead ? 1 : 0));
      ctx.globalAlpha = 1;
      if (dead) ctx.drawImage(Sprites.sprite('fire'), x + 4, y + 2 + ((S.frame >> 3) % 2));
      if (sn && !dead) {
        const cap = S.sim.capOf(sn), u = Math.min(1, sn.load / cap);
        if (cap < 1e5) {
          ctx.fillStyle = '#000'; ctx.fillRect(x, y + 17, 16, 3);
          ctx.fillStyle = u > 0.95 ? '#ef476f' : u > 0.7 ? '#ffd166' : '#06d6a0'; ctx.fillRect(x + 1, y + 18, Math.round(14 * u), 1);
        }
        if (sn.kind === 'asg') for (let i = 0; i < sn.instances; i++) { ctx.fillStyle = '#ffd166'; ctx.fillRect(x + i * 3, y - 3, 2, 2); }
        if (sn.kind === 'queue' && sn.backlog >= 1) { const hgt = Math.min(14, Math.ceil(Math.log2(sn.backlog + 1))); ctx.fillStyle = '#c77dff'; ctx.fillRect(x + 17, y + 16 - hgt, 2, hgt); }
      } else if (!sn && n.kind === 'asg') for (let i = 0; i < (n.cfg.min || 1); i++) { ctx.fillStyle = '#ffd166'; ctx.fillRect(x + i * 3, y - 3, 2, 2); }
    }

    // status labels, drawn after all nodes so they stay on top
    if (simById) for (const n of S.design.nodes) {
      const sn = simById[n.id]; if (!sn) continue;
      const blink = (S.frame >> 4) % 2;
      let label = null, color = '#ef476f';
      if (sn.dead) { label = sn.downWhy || 'DOWN'; color = blink ? '#ef476f' : '#ffd166'; }
      else if (sn.kind === 'replica' && sn.failoverAt != null && !sn.promoted) { label = 'FAILOVER'; color = '#ffd166'; }
      else if (sn.failReason && S.sim.t - sn.failAt < 0.6 && REASON_LABEL[sn.failReason]) { label = REASON_LABEL[sn.failReason]; color = blink ? '#f3722c' : '#ffd166'; }
      else if (sn.kind === 'replica' && sn.promoted) { label = 'PRIMARY'; color = '#06d6a0'; }
      if (!label) continue;
      ctx.font = '8px monospace';
      const tw = Math.ceil(ctx.measureText(label).width);
      const cx = Math.max(tw / 2 + 2, Math.min(W - tw / 2 - 2, GX + n.col * TILE + 12));
      const ty = GY + n.row * TILE - 7;
      ctx.fillStyle = 'rgba(0,0,0,0.85)'; ctx.fillRect(Math.round(cx - tw / 2) - 2, ty - 1, tw + 4, 10);
      ctx.fillStyle = color; ctx.fillRect(Math.round(cx - tw / 2) - 2, ty + 9, tw + 4, 1);
      text(label, Math.round(cx), ty, color, 'center');
    }

    // effects
    for (let i = S.puffs.length - 1; i >= 0; i--) {
      const p = S.puffs[i]; p.life -= dt * (p.kind === 'x' ? 2.2 : 1.6);
      if (p.life <= 0) { S.puffs.splice(i, 1); continue; }
      if (p.kind === 'x') { p.y -= dt * 14; ctx.fillStyle = '#ef476f'; const X = Math.round(p.x), Y = Math.round(p.y); ctx.fillRect(X - 1, Y - 1, 1, 1); ctx.fillRect(X + 1, Y - 1, 1, 1); ctx.fillRect(X, Y, 1, 1); ctx.fillRect(X - 1, Y + 1, 1, 1); ctx.fillRect(X + 1, Y + 1, 1, 1); }
      else { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 120 * dt; ctx.fillStyle = p.life > 0.5 ? '#ffd166' : '#f3722c'; ctx.fillRect(Math.round(p.x), Math.round(p.y), 2, 2); }
    }

    // ghost
    if (!S.sim && S.tool && S.hover && S.hover.inGrid && !S.drag && !nodeAt(S.hover.col, S.hover.row)) {
      const x = GX + S.hover.col * TILE + 4, y = GY + S.hover.row * TILE + 3;
      ctx.globalAlpha = 0.55; ctx.drawImage(Sprites.sprite(S.tool), x, y); ctx.globalAlpha = 1;
      ctx.strokeStyle = '#1c8a17'; ctx.strokeRect(x - 3.5, y - 2.5, 23, 23);
    }
    if (S.hover && S.hover.inGrid) { const n = nodeAt(S.hover.col, S.hover.row); if (n && !S.drag) text(n.id, Math.min(W - 4, Math.max(GX, GX + n.col * TILE + 12)), GY + n.row * TILE + (n.row === GRID.rows - 1 ? -7 : 23), '#f4f4f4', 'center'); }
  }

  // ---------- main loop ----------
  let last = performance.now(), uiAcc = 0;
  function loop(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (S.sim) {
      S.simAcc += dt * SIM_SPEED * S.speed;
      while (S.sim && S.simAcc >= S.sim.dt) {
        S.simAcc -= S.sim.dt; S.sim.tick();
        if (S.sim.done) { stopSim(true); break; }
      }
      uiAcc += dt;
      if (S.sim && uiAcc > 0.15) {
        uiAcc = 0; renderStats(); drawChart(); if (S.selected) renderInspect();
        $('timefill').style.width = (S.sim.t / S.sc.duration * 100) + '%';
        $('timetext').textContent = `${Math.floor(S.sim.t)} / ${S.sc.duration}s`;
      }
    }
    draw(dt);
    requestAnimationFrame(loop);
  }

  // ---------- boot ----------
  S.muted = store.get('muted', false); $('btnMute').textContent = S.muted ? 'SOUND OFF' : 'SOUND ON';
  const lastId = store.get('last', null);
  loadScenario(SCENARIOS.find(s => s.id === lastId) || SCENARIOS[0]);
  if (!lastId) showLevels();
  if (!store.get('helped', false)) $('help').classList.remove('hidden');
  window.CloudTycoon = { S, startSim, stopSim, loadScenario }; // debugging hook
  // ?demo=<scenario id> loads the reference design and runs it (used for smoke tests).
  const demo = new URLSearchParams(location.search).get('demo');
  if (demo && SCENARIOS.some(s => s.id === demo)) {
    document.querySelectorAll('.overlay').forEach(o => o.classList.add('hidden'));
    S.muted = true; loadScenario(SCENARIOS.find(s => s.id === demo));
    if (S.sc.solution) S.design = clone(S.sc.solution);
    S.speed = 4; changed(); startSim();
    const at = +new URLSearchParams(location.search).get('at');
    if (at) { while (S.sim.t < at) S.sim.tick(); S.speed = 1; }
    if (new URLSearchParams(location.search).get('fast')) { while (!S.sim.done) S.sim.tick(); stopSim(true); }
  }
  requestAnimationFrame(loop);
})();
