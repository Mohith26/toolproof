'use strict';
// Golden-task evaluation. A task bundles a goal, a scripted world (tools
// with deterministic handlers over a task-local state), the capability
// grants, a planner, and a success predicate over the final state and run
// outcome. The harness runs every task, scores it, and can diff two runs
// of the suite so a runtime change that breaks task 7 shows up as exactly
// that, not as a vibe.

const { Registry, runAgent } = require('./runtime');

function runSuite(tasks) {
  const results = [];
  for (const task of tasks) {
    const world = task.world();
    const registry = new Registry();
    for (const tool of world.tools) registry.register(tool);
    const outcome = runAgent({
      goal: task.goal,
      planner: task.planner(world),
      registry,
      grants: task.grants,
      budget: task.budget,
      meta: { task: task.id }
    });
    let passed = false;
    let why = '';
    try {
      const verdict = task.expect(world, outcome);
      passed = verdict === true || (verdict && verdict.ok === true);
      why = verdict && verdict.why ? verdict.why : '';
    } catch (err) {
      passed = false;
      why = 'expect threw: ' + err.message;
    }
    results.push({
      id: task.id, passed, why,
      status: outcome.status,
      steps: outcome.counters.steps,
      calls: outcome.counters.calls,
      cost: outcome.counters.cost,
      denials: outcome.counters.denials,
      flags: outcome.counters.flags,
      traceHead: outcome.trace.head,
      chainOk: outcome.trace.verifyChain().ok
    });
  }
  const passed = results.filter(r => r.passed).length;
  return {
    total: results.length, passed, failed: results.length - passed,
    passRate: results.length === 0 ? 1 : +(passed / results.length).toFixed(4),
    results
  };
}

// Diff two suite reports by task id: regressions, fixes, and drift in
// steps/cost even when pass status is unchanged.
function diffSuites(before, after) {
  const byId = new Map(before.results.map(r => [r.id, r]));
  const regressions = [], fixes = [], drift = [];
  for (const r of after.results) {
    const prev = byId.get(r.id);
    if (!prev) continue;
    if (prev.passed && !r.passed) regressions.push(r.id);
    else if (!prev.passed && r.passed) fixes.push(r.id);
    else if (prev.steps !== r.steps || prev.cost !== r.cost || prev.traceHead !== r.traceHead) {
      drift.push({ id: r.id, steps: [prev.steps, r.steps], cost: [prev.cost, r.cost] });
    }
  }
  return { regressions, fixes, drift, clean: regressions.length === 0 && drift.length === 0 };
}

module.exports = { runSuite, diffSuites };

