'use strict';
// Trace recording and replay. Every run produces a hash-chained list of
// steps; replay re-executes the planner against recorded tool results and
// verifies the chain step by step, so "it worked on my machine" becomes a
// diffable artifact. The hash is FNV-1a over the canonical JSON of the
// step plus the previous hash, which is cheap and plenty for tamper
// evidence in a log (this is an integrity check, not cryptography).

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

class Trace {
  constructor(meta) {
    this.meta = meta || {};
    this.steps = [];
    this.head = 'genesis';
  }

  record(step) {
    const body = canonical({ prev: this.head, step });
    const hash = fnv1a(body);
    const entry = { index: this.steps.length, hash, prev: this.head, step };
    this.steps.push(entry);
    this.head = hash;
    return entry;
  }

  // Recompute every hash from genesis; any edit to any step breaks the
  // chain from that point forward.
  verifyChain() {
    let head = 'genesis';
    for (const entry of this.steps) {
      if (entry.prev !== head) return { ok: false, at: entry.index, why: 'prev_mismatch' };
      const expect = fnv1a(canonical({ prev: head, step: entry.step }));
      if (expect !== entry.hash) return { ok: false, at: entry.index, why: 'hash_mismatch' };
      head = entry.hash;
    }
    return { ok: true, head };
  }

  toJSON() { return { meta: this.meta, steps: this.steps, head: this.head }; }

  static fromJSON(obj) {
    const t = new Trace(obj.meta);
    t.steps = obj.steps;
    t.head = obj.head;
    return t;
  }
}

// Compare two traces step by step. Returns the first divergence, which for
// a deterministic planner over recorded tool results should never exist.
function diffTraces(a, b) {
  const n = Math.min(a.steps.length, b.steps.length);
  for (let i = 0; i < n; i++) {
    if (canonical(a.steps[i].step) !== canonical(b.steps[i].step)) {
      return { identical: false, at: i, left: a.steps[i].step, right: b.steps[i].step };
    }
  }
  if (a.steps.length !== b.steps.length) {
    return { identical: false, at: n, why: 'length', left: a.steps.length, right: b.steps.length };
  }
  return { identical: a.head === b.head, head: [a.head, b.head] };
}

module.exports = { Trace, diffTraces, canonical, fnv1a };

