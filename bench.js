'use strict';
// Overhead and scale numbers. The question this answers is "what does the
// safety layer cost per tool call", measured against a null runtime that
// does none of the checks, plus screening throughput and replay fidelity
// over a large trace. Writes bench-results.json.

const fs = require('fs');
const path = require('path');
const { Registry, runAgent, replay } = require('./src/runtime');
const { screen } = require('./src/guard');
const { validate } = require('./src/schema');
const { Trace } = require('./src/trace');
const corpus = require('./test/corpus');

const wall = () => Date.now();

function buildWorld(n) {
  const state = { writes: 0 };
  const registry = new Registry();
  registry.register({
    name: 'read_row', scopes: ['read:db'], cost: 0,
    args: { id: { type: 'number', required: true, integer: true, min: 0 } },
    handler: ({ id }) => `row ${id}: status ok, amount ${id * 3}`
  });
  registry.register({
    name: 'write_row', scopes: ['write:db'], cost: 0,
    args: { id: { type: 'number', required: true, integer: true }, value: { type: 'string', required: true } },
    handler: () => { state.writes++; return 'written'; }
  });
  const script = [];
  for (let i = 0; i < n; i++) {
    script.push(i % 2 === 0
      ? { kind: 'call', tool: 'read_row', args: { id: i } }
      : { kind: 'call', tool: 'write_row', args: { id: i, value: 'v' + i } });
  }
  script.push({ kind: 'finish', output: 'done' });
  let idx = 0;
  const planner = { next: () => script[idx++] || { kind: 'finish', output: 'done' } };
  return { registry, planner, state, n };
}

function guardedRun(n) {
  const { registry, planner } = buildWorld(n);
  const t0 = wall();
  const out = runAgent({
    goal: 'bench', planner, registry,
    grants: ['read:db', 'write:db'],
    budget: { maxSteps: n + 5, maxCalls: n + 5, maxCost: 10 ** 9 }
  });
  return { ms: wall() - t0, out };
}

// Same workload with no validation, no scope check, no screening, no trace.
function nullRun(n) {
  const { registry, planner } = buildWorld(n);
  const t0 = wall();
  let calls = 0;
  for (;;) {
    const p = planner.next({});
    if (!p || p.kind === 'finish') break;
    registry.get(p.tool).handler(p.args);
    calls++;
  }
  return { ms: wall() - t0, calls };
}

function main() {
  const N = 200000;
  const guarded = guardedRun(N);
  const bare = nullRun(N);
  const perCallGuardedUs = (guarded.ms * 1000) / guarded.out.counters.calls;
  const perCallBareUs = (bare.ms * 1000) / bare.calls;

  // screening throughput over the corpus repeated many times
  const all = corpus.positives.concat(corpus.negatives);
  const reps = 20000;
  const t0 = wall();
  let flagged = 0;
  for (let i = 0; i < reps; i++) {
    for (const s of all) if (screen(s).flagged) flagged++;
  }
  const screenMs = wall() - t0;
  const screened = reps * all.length;

  // schema validation throughput
  const spec = { id: { type: 'number', required: true, integer: true }, value: { type: 'string', required: true, maxLen: 64 } };
  const vN = 500000;
  const t1 = wall();
  let okCount = 0;
  for (let i = 0; i < vN; i++) if (validate(spec, { id: i, value: 'v' + i }).ok) okCount++;
  const validateMs = wall() - t1;

  // replay fidelity on the large trace
  const { registry: rg2, planner: pl2 } = buildWorld(5000);
  const first = runAgent({ goal: 'replay bench', planner: pl2, registry: rg2,
    grants: ['read:db', 'write:db'], budget: { maxSteps: 6000, maxCalls: 6000, maxCost: 10 ** 9 } });
  const { registry: rg3, planner: pl3, state: st3 } = buildWorld(5000);
  const t2 = wall();
  const second = replay({ goal: 'replay bench', planner: pl3, registry: rg3,
    grants: ['read:db', 'write:db'], budget: { maxSteps: 6000, maxCalls: 6000, maxCost: 10 ** 9 },
    trace: first.trace });
  const replayMs = wall() - t2;

  // corpus scoring, recomputed here so the README number has a source
  let tp = 0, fn = 0, fp = 0, tn = 0;
  for (const s of corpus.positives) (screen(s).flagged ? tp++ : fn++);
  for (const s of corpus.negatives) (screen(s).flagged ? fp++ : tn++);

  const out = {
    machine: 'Apple Silicon arm64, single thread',
    guardedVsBare: {
      toolCalls: guarded.out.counters.calls,
      guardedMs: guarded.ms,
      bareMs: bare.ms,
      guardedUsPerCall: +perCallGuardedUs.toFixed(3),
      bareUsPerCall: +perCallBareUs.toFixed(3),
      overheadUsPerCall: +(perCallGuardedUs - perCallBareUs).toFixed(3),
      guardedCallsPerSecond: Math.round(guarded.out.counters.calls / (guarded.ms / 1000)),
      traceSteps: guarded.out.trace.steps.length,
      chainVerified: guarded.out.trace.verifyChain().ok
    },
    screening: {
      documentsScreened: screened,
      elapsedMs: screenMs,
      docsPerSecond: Math.round(screened / (screenMs / 1000)),
      flaggedTotal: flagged
    },
    validation: {
      calls: vN, accepted: okCount, elapsedMs: validateMs,
      validationsPerSecond: Math.round(vN / (validateMs / 1000))
    },
    replay: {
      recordedSteps: first.trace.steps.length,
      replayMs,
      headsMatch: first.trace.head === second.trace.head,
      sideEffectsDuringReplay: st3.writes,
      status: second.status
    },
    guardCorpus: {
      positives: corpus.positives.length, negatives: corpus.negatives.length,
      truePositives: tp, falseNegatives: fn, falsePositives: fp, trueNegatives: tn,
      precision: +(tp / (tp + fp || 1)).toFixed(4),
      recall: +(tp / (tp + fn || 1)).toFixed(4)
    }
  };
  console.log(JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(__dirname, 'bench-results.json'), JSON.stringify(out, null, 2) + '\n');
  return out;
}

module.exports = { main };

