'use strict';
// Whole suite: unit checks on each module, then the golden-task suite, then
// the guard scored against the labelled corpus, then a replay check.

const { validate } = require('../src/schema');
const { screen, quarantineWrap } = require('../src/guard');
const { Trace, diffTraces } = require('../src/trace');
const { Registry, runAgent, replay } = require('../src/runtime');
const { runSuite, diffSuites } = require('../src/evalharness');
const { tasks, ticketWorld, scriptedPlanner } = require('./tasks');
const corpus = require('./corpus');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); }
}
function eq(label, got, want) { ok(label, JSON.stringify(got) === JSON.stringify(want), { got, want }); }

console.log('toolproof test suite');

console.log('\nargument validation');
{
  const spec = {
    q: { type: 'string', required: true, maxLen: 10 },
    n: { type: 'number', min: 0, max: 5, integer: true },
    flag: { type: 'boolean' },
    tags: { type: 'array', maxItems: 2 },
    mode: { type: 'string', oneOf: ['fast', 'slow'] }
  };
  ok('a valid payload passes', validate(spec, { q: 'hi', n: 3, flag: true, tags: ['a'], mode: 'fast' }).ok);
  ok('missing required is caught', !validate(spec, { n: 1 }).ok);
  ok('wrong type is caught', !validate(spec, { q: 5 }).ok);
  ok('too long is caught', !validate(spec, { q: 'x'.repeat(11) }).ok);
  ok('out of range is caught', !validate(spec, { q: 'a', n: 9 }).ok);
  ok('non-integer is caught', !validate(spec, { q: 'a', n: 1.5 }).ok);
  ok('bad enum is caught', !validate(spec, { q: 'a', mode: 'medium' }).ok);
  ok('too many items is caught', !validate(spec, { q: 'a', tags: [1, 2, 3] }).ok);
  ok('hallucinated argument is rejected', !validate(spec, { q: 'a', surprise: 1 }).ok);
  ok('non-object arguments are rejected', !validate(spec, ['a']).ok);
  eq('empty spec accepts empty args', validate({}, {}).ok, true);
  ok('errors are readable', validate(spec, { n: 99 }).errors.some(e => e.includes('maximum')));
}

console.log('\nguard scoring on the labelled corpus');
{
  let tp = 0, fn = 0, fp = 0, tn = 0;
  const missed = [], falsePos = [];
  for (const s of corpus.positives) { if (screen(s).flagged) tp++; else { fn++; missed.push(s.slice(0, 50)); } }
  for (const s of corpus.negatives) { if (screen(s).flagged) { fp++; falsePos.push(s.slice(0, 50)); } else tn++; }
  const precision = tp / (tp + fp || 1);
  const recall = tp / (tp + fn || 1);
  console.log(`  positives ${tp}/${corpus.positives.length} caught, negatives ${tn}/${corpus.negatives.length} clean`);
  console.log(`  precision ${precision.toFixed(3)}, recall ${recall.toFixed(3)}`);
  if (missed.length) console.log('  missed: ' + JSON.stringify(missed));
  if (falsePos.length) console.log('  false positives: ' + JSON.stringify(falsePos));
  ok('recall is at least 0.9', recall >= 0.9, recall);
  ok('precision is at least 0.9', precision >= 0.9, precision);
  ok('quarantine wrapper keeps the content and labels it',
    quarantineWrap('bad text', screen(corpus.positives[0])).includes('bad text'));
  ok('quarantine wrapper names the signals',
    quarantineWrap('x', screen(corpus.positives[0])).includes('instruction_override'));
}

console.log('\ntrace chain');
{
  const t = new Trace({ goal: 'x' });
  t.record({ type: 'proposal', tool: 'a' });
  t.record({ type: 'result', tool: 'a', raw: 'ok' });
  t.record({ type: 'finish', output: 'done' });
  ok('a fresh chain verifies', t.verifyChain().ok);
  eq('every step is linked', t.steps.map(s => s.index), [0, 1, 2]);
  const tampered = Trace.fromJSON(JSON.parse(JSON.stringify(t.toJSON())));
  tampered.steps[1].step.raw = 'tampered';
  const v = tampered.verifyChain();
  ok('editing a recorded step breaks the chain', !v.ok);
  eq('and it points at the edited step', v.at, 1);
  const t2 = new Trace({ goal: 'x' });
  t2.record({ type: 'proposal', tool: 'a' });
  t2.record({ type: 'result', tool: 'a', raw: 'ok' });
  t2.record({ type: 'finish', output: 'done' });
  ok('identical runs produce identical heads', diffTraces(t, t2).identical);
  const t3 = new Trace({ goal: 'x' });
  t3.record({ type: 'proposal', tool: 'b' });
  ok('different runs diverge at the first differing step', diffTraces(t, t3).at === 0);
}

console.log('\ngolden task suite');
const report = runSuite(tasks);
for (const r of report.results) {
  ok(`task ${r.id}${r.why ? ' (' + r.why + ')' : ''}`, r.passed, r.passed ? undefined : r);
  ok(`task ${r.id} trace chain intact`, r.chainOk);
}
console.log(`  ${report.passed}/${report.total} golden tasks passed (rate ${report.passRate})`);
ok('all golden tasks pass', report.failed === 0);

console.log('\nsuite diffing');
{
  const again = runSuite(tasks);
  const d = diffSuites(report, again);
  ok('rerunning the suite is clean', d.clean, d);
  const broken = runSuite(tasks.map(t => t.id === 'cost-budget' ? { ...t, budget: { maxCost: 999, maxCalls: 99, maxSteps: 20 } } : t));
  const d2 = diffSuites(report, broken);
  ok('loosening a budget shows up as a regression', d2.regressions.includes('cost-budget'), d2);
}

console.log('\nreplay');
{
  const world = ticketWorld();
  const registry = new Registry();
  for (const tool of world.tools) registry.register(tool);
  const script = [
    { kind: 'call', tool: 'search_tickets', args: { query: 'refund' } },
    { kind: 'call', tool: 'add_note', args: { id: 't1', body: 'note' } },
    { kind: 'finish', output: 'done' }
  ];
  const first = runAgent({
    goal: 'replay me', planner: scriptedPlanner(script), registry,
    grants: ['read:tickets', 'write:tickets']
  });
  const before = world.state.notes.length;
  const second = replay({
    goal: 'replay me', planner: scriptedPlanner(script), registry,
    grants: ['read:tickets', 'write:tickets'], trace: first.trace
  });
  eq('replay reaches the same status', second.status, first.status);
  eq('replay produces the same trace head', second.trace.head, first.trace.head);
  eq('replay does not re-run side effects', world.state.notes.length, before);
  const divergent = replay({
    goal: 'replay me',
    planner: scriptedPlanner([{ kind: 'call', tool: 'close_ticket', args: { id: 't1' } }, { kind: 'finish' }]),
    registry, grants: ['read:tickets', 'write:tickets'], trace: first.trace
  });
  eq('a changed plan is caught as divergence', divergent.status, 'replay_divergence');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
module.exports = { pass, fail };

