/* THE ONE DRIFT audited()'s side-channel cannot catch at runtime.

   A spec marked `selfCtx: true` tells audited() NOT to read the row before the handler runs,
   because the handler reads it itself and leaves it in args.__auditCtx. If somebody later
   deletes that one line from a handler while the flag stays on its spec, nothing throws: the
   audit row simply logs `before: null`, and a before-read cannot be recovered after the write.
   There is no cheaper way to know a value from before a write that already happened, so the
   guard has to be static -- every flagged handler's source must carry both assignments. */

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

test('no handler fills the audit ctx without its spec being flagged', () => {
  const flagged = new Set(selfCtxFns());
  for (const m of portalSrc.matchAll(/\n  async ([A-Za-z0-9_]+)\(/g)) {
    const body = fnBody(m[1]);
    if (/__auditCtx\.before\s*=/.test(body)) {
      assert.ok(flagged.has(m[1]), m[1] + ' fills the audit ctx but its spec is not selfCtx, so the fill is dead');
    }
  }
});
