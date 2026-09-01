'use strict';
// The run loop. A planner proposes one action at a time; the runtime is the
// only thing that touches tools, and it enforces, in order: the tool
// exists, the arguments validate, the run's capability grants cover the
// tool's scopes, writes are not frozen, and the budgets are not exhausted.
// Every proposal and outcome lands in the trace, including the refusals,
// because the refusals are the part you audit later.
//
// The planner contract is deliberately tiny:
//   planner.next({ goal, memory, lastResult, step }) ->
//     { kind: 'call', tool, args }
//   | { kind: 'finish', output }
// A planner can be an LLM adapter in production; in this repo it is
// scripted, because the runtime's guarantees should be testable without a
// model in the loop.

const { validate } = require('./schema');
const { screen, quarantineWrap } = require('./guard');
const { Trace } = require('./trace');

const DEFAULT_BUDGET = { maxSteps: 32, maxCalls: 16, maxCost: 100 };

class Registry {
  constructor() { this.tools = new Map(); }
  register({ name, scopes, cost = 1, args, handler, description }) {
    if (this.tools.has(name)) throw new Error(`tool ${name} already registered`);
    if (!Array.isArray(scopes) || scopes.length === 0) throw new Error(`tool ${name} must declare scopes`);
    this.tools.set(name, { name, scopes, cost, args: args || {}, handler, description: description || '' });
  }
  get(name) { return this.tools.get(name); }
  list() { return [...this.tools.keys()]; }
}

function runAgent({ goal, planner, registry, grants, budget, meta, replayFrom }) {
  const caps = new Set(grants || []);
  const limits = { ...DEFAULT_BUDGET, ...(budget || {}) };
  const trace = new Trace({ goal, grants: [...caps], limits, ...(meta || {}) });
  const counters = { steps: 0, calls: 0, cost: 0, denials: 0, flags: 0 };
  let writesFrozen = false;
  let lastResult = null;
  const memory = [];

  // In replay mode tool handlers never run; recorded results are fed back.
  const recorded = replayFrom ? replayFrom.steps.filter(s => s.step.type === 'result').map(s => s.step) : null;
  let recordedIdx = 0;

  while (counters.steps < limits.maxSteps) {
    counters.steps++;
    let proposal;
    try {
      proposal = planner.next({ goal, memory, lastResult, step: counters.steps });
    } catch (err) {
      trace.record({ type: 'planner_error', message: String(err.message) });
      return finish('planner_error');
    }

    if (!proposal || (proposal.kind !== 'call' && proposal.kind !== 'finish')) {
      trace.record({ type: 'protocol_error', got: proposal === undefined ? null : proposal });
      return finish('protocol_error');
    }

    if (proposal.kind === 'finish') {
      trace.record({ type: 'finish', output: proposal.output === undefined ? null : proposal.output });
      return finish('completed', proposal.output);
    }

    trace.record({ type: 'proposal', tool: proposal.tool, args: proposal.args === undefined ? null : proposal.args });
    const tool = registry.get(proposal.tool);

    const deny = (why, extra) => {
      counters.denials++;
      const rec = { type: 'denial', tool: proposal.tool, why, ...(extra || {}) };
      trace.record(rec);
      lastResult = { denied: true, why, ...(extra || {}) };
      memory.push(rec);
    };

    if (!tool) { deny('unknown_tool'); continue; }

    const argCheck = validate(tool.args, proposal.args);
    if (!argCheck.ok) { deny('bad_arguments', { errors: argCheck.errors }); continue; }

    const missing = tool.scopes.filter(s => !caps.has(s));
    if (missing.length > 0) { deny('missing_scopes', { missing }); continue; }

    if (writesFrozen && tool.scopes.some(s => s.startsWith('write'))) {
      deny('writes_frozen_after_flag'); continue;
    }

    if (counters.calls + 1 > limits.maxCalls) { deny('call_budget_exhausted'); return finish('budget_exhausted'); }
    if (counters.cost + tool.cost > limits.maxCost) { deny('cost_budget_exhausted'); return finish('budget_exhausted'); }

    counters.calls++;
    counters.cost += tool.cost;

    let raw;
    if (recorded) {
      const rec = recorded[recordedIdx++];
      if (!rec || rec.tool !== tool.name) {
        trace.record({ type: 'replay_divergence', expected: rec ? rec.tool : null, got: tool.name });
        return finish('replay_divergence');
      }
      raw = rec.raw;
    } else {
      try {
        raw = tool.handler(proposal.args || {});
      } catch (err) {
        trace.record({ type: 'result', tool: tool.name, ok: false, raw: 'tool_error: ' + String(err.message), flagged: false });
        lastResult = { ok: false, error: String(err.message) };
        memory.push(lastResult);
        continue;
      }
    }

    const verdict = screen(raw);
    if (verdict.flagged) {
      counters.flags++;
      writesFrozen = true;
    }
    trace.record({ type: 'result', tool: tool.name, ok: true, raw, flagged: verdict.flagged, hits: verdict.hits });
    lastResult = {
      ok: true,
      tool: tool.name,
      content: verdict.flagged ? quarantineWrap(raw, verdict) : raw,
      flagged: verdict.flagged
    };
    memory.push({ tool: tool.name, flagged: verdict.flagged });
  }

  trace.record({ type: 'step_budget_exhausted' });
  return finish('budget_exhausted');

  function finish(status, output) {
    return { status, output: output === undefined ? null : output, trace, counters, writesFrozen };
  }
}

// Replay: run the same planner against the recorded tool results and check
// the traces match. Deterministic planners must produce identical chains.
function replay({ goal, planner, registry, grants, budget, meta, trace }) {
  return runAgent({ goal, planner, registry, grants, budget, meta, replayFrom: trace });
}

module.exports = { Registry, runAgent, replay, DEFAULT_BUDGET };

