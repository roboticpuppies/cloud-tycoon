// Headless check: every reference solution must pass, every "naive" design must fail.
const { SCENARIOS, makeDesign } = require('../js/scenarios.js');
const { Sim, analyze } = require('../js/sim.js');
const { designCost, canLink, canPlace, COMPONENTS } = require('../js/components.js');

const naive = makeDesign([['web', 1, 2], ['db', 2, 2]], ['users>web-1', 'web-1>db-1']);
let bad = 0;
for (const sc of SCENARIOS) {
  if (!sc.solution) continue;
  for (const e of sc.solution.edges) {
    const fk = e.from === 'users' ? 'users' : sc.solution.nodes.find(n => n.id === e.from)?.kind;
    const tk = sc.solution.nodes.find(n => n.id === e.to)?.kind;
    if (!fk || !tk || !canLink(fk, tk)) { console.log('  BAD EDGE', sc.id, e); bad++; }
  }
  for (const n of sc.solution.nodes) if (!sc.allowed.includes(n.kind)) { console.log('  NOT ALLOWED', sc.id, n.kind); bad++; }
  if (sc.net) for (const n of sc.solution.nodes) if (!canPlace(n.kind, n.col)) { console.log('  BAD PLACEMENT', sc.id, n.id); bad++; }
  const sim = new Sim(sc.solution, sc); const r = sim.runAll();
  const line = r.checks.map(c => `${c.key}=${c.fmt(c.value)}${c.pass ? '' : '(X)'}`).join(' ');
  console.log(`${r.pass ? 'PASS' : 'FAIL'} ${'*'.repeat(r.stars).padEnd(3)} ${sc.id.padEnd(12)} ${line}  3*<=${Math.round(sc.budget * .8)}`);
  if (!r.pass) { bad++; console.log(analyze(sim, sc.solution, sc).map(a => '   - ' + a.text).join('\n')); console.log('   fails', r.fail); }
  const start = sc.start || naive;
  if (sc.id !== 'hello') {
    const s2 = new Sim(start, sc); const r2 = s2.runAll();
    console.log(`     start/naive: ${r2.pass ? 'PASS (should fail!)' : 'fail ok'} ${r2.checks.map(c => `${c.key}=${c.fmt(c.value)}`).join(' ')}`);
    if (r2.pass) bad++;
  }
}
if (process.argv[2] === '-v') { const sc = SCENARIOS.find(s => s.id === process.argv[3]); const sim = new Sim(sc.solution, sc); sim.runAll(); console.log(sim.log, analyze(sim, sc.solution, sc)); }
console.log(bad ? `\n${bad} problem(s)` : '\nall good');
process.exit(bad ? 1 : 0);
