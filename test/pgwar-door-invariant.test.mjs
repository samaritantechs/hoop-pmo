/* THE ONE DRIFT audited()'s side-channel cannot catch at runtime.

   A spec marked `selfCtx: true` tells audited() NOT to read the row before the handler runs,
   because the handler reads it itself and leaves it in args.__auditCtx. If somebody later
   deletes that one line from a handler while the flag stays on its spec, nothing throws: the
   audit row simply logs `before: null`, and a before-read cannot be recovered after the write.
   There is no cheaper way to know a value from before a write that already happened, so the
   guard has to be static -- every flagged handler's source must carry both assignments.

   AND THE HAND-OVER MUST COME BEFORE THE GUARDS. The first cut of this set ctx.before AFTER
   "already decided" / "already paid" / "not approved" had thrown, so exactly the refusal the
   log exists for -- two approvers acting at once, a double-click on Pay -- was written with
   before: null. The review caught it; this pins the order. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const auditSrc = readFileSync(new URL('../api/_lib/audit.js', import.meta.url), 'utf8');
const portalSrc = readFileSync(new URL('../api/portal.js', import.meta.url), 'utf8');

function selfCtxFns() {
  // Comments stripped first: the prose above the flagged specs mentions `selfCtx: true` too.
  const block = auditSrc.slice(auditSrc.indexOf('const AUDIT_DIFF = {'), auditSrc.indexOf('const K_ ='))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const starts = [...block.matchAll(/^\s+([A-Za-z0-9_]+):\s*\{/gm)];
  return starts.filter((m, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : block.length;
    return /\bselfCtx:\s*true\b/.test(block.slice(m.index, end));
  }).map(m => m[1]);
}

function fnBody(name) {
  const at = portalSrc.indexOf('\n  async ' + name + '(');
  assert.ok(at > 0, name + ' is not a portal fn');
  const next = portalSrc.indexOf('\n  async ', at + 1);
  return portalSrc.slice(at, next > 0 ? next : undefined);
}

test('every selfCtx handler leaves both halves of the diff in args.__auditCtx', () => {
  const names = selfCtxFns();
  assert.ok(names.length >= 9, 'the flagged specs should have been found: ' + names.join(','));
  for (const name of names) {
    const body = fnBody(name);
    assert.match(body, /__auditCtx\.before\s*=/, name + ' no longer hands audited() the row it read');
    assert.match(body, /__auditCtx\.afterPatch\s*=/, name + ' no longer hands audited() the patch it wrote');
  }
});

/* The state guards all say so in both languages -- "tayari" / "already", "imekamilika" /
   "complete", "halijaidhinishwa" / "not approved", "kimeshalipwa" -- so the rule is checkable
   from the source: none of them may throw before the row has been handed over. */
const STATE_GUARD = /bad\((?:[^)]|\([^)]*\))*?(tayari|already|imekamilika|halijaidhinishwa|kimeshalipwa|not approved)/g;

test('every selfCtx handler hands the row over BEFORE any "already decided" guard can refuse', () => {
  for (const name of selfCtxFns()) {
    const body = fnBody(name);
    const handOver = body.search(/__auditCtx\.before\s*=/);
    for (const m of body.matchAll(STATE_GUARD)) {
      assert.ok(m.index > handOver,
        name + ': a state guard ("' + m[0].slice(0, 60) + '...") throws before ctx.before is set, so a refused '
        + 'attempt would be logged with before: null');
    }
  }
});

test('no handler fills the audit ctx without its spec being flagged', () => {
  const flagged = new Set(selfCtxFns());
  for (const m of portalSrc.matchAll(/\n  async ([A-Za-z0-9_]+)\(/g)) {
    const body = fnBody(m[1]);
    if (/__auditCtx\.before\s*=/.test(body)) {
      assert.ok(flagged.has(m[1]), m[1] + ' fills the audit ctx but its spec is not selfCtx, so the fill is dead');
    }
  }
});
