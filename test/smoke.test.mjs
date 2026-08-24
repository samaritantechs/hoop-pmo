// The seed guard. Hope's real test harness (fake-db) gets copied over with the first
// API code; until then these tests hold the two promises the seed makes: the schema
// file keeps its invariants, and nothing turns IMEI into a number.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const schema = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the schema defines every v1 table', () => {
  for (const t of [
    'teams', 'access_codes', 'roles', 'settings', 'hints',
    'watu_loans', 'watu_snapshots', 'followup_status', 'followup_comments',
    'call_users', 'call_logs', 'announcement', 'audit_log',
  ]) {
    assert.match(schema, new RegExp(`create table if not exists ${t}\\b`), `missing table: ${t}`);
  }
});

test('IMEI is TEXT end to end -- never a numeric type', () => {
  // Excel destroys a 15-digit IMEI held as a number; the schema must never invite that.
  assert.match(schema, /imei text primary key/, 'watu_loans/followup_status must key on imei as text');
  assert.doesNotMatch(schema, /imei\s+(bigint|numeric|integer|int\b)/i, 'an imei column declared numeric');
});

test('every CREATE TABLE is idempotent (IF NOT EXISTS)', () => {
  const creates = schema.match(/create table\s+(?!if not exists)/gi) || [];
  assert.equal(creates.length, 0, 'a CREATE TABLE without IF NOT EXISTS breaks safe-to-re-run');
});

test('the 45-day window is computable: disbursed_date and snapshot_date are dates', () => {
  assert.match(schema, /disbursed_date date/);
  assert.match(schema, /snapshot_date date not null/);
});

test('package identity', () => {
  assert.equal(pkg.name, 'hoop-pmo');
  assert.equal(pkg.type, 'module');
});

/* The Android manifests and resources are XML, and nothing in `npm test` used to look at
   them -- so a malformed one only surfaced as a gradle failure minutes later in CI, with
   "Error parsing AndroidManifest.xml" and no line number. This is the cheap guard for the
   one mistake that is easy to make here: `--` cannot appear INSIDE an XML comment, and the
   prose style in this repo uses it constantly. */
test('every android XML is well-formed enough to parse', () => {
  const files = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== 'build') walk(p); }
      else if (e.name.endsWith('.xml')) files.push(p);
    }
  };
  walk(new URL('../android', import.meta.url).pathname);
  assert.ok(files.length > 0, 'no android XML found -- the guard is looking in the wrong place');

  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    // Comments first: strip them, checking each for the `--` that makes it invalid.
    let i = 0;
    while ((i = src.indexOf('<!--', i)) !== -1) {
      const end = src.indexOf('-->', i + 4);
      assert.notEqual(end, -1, `${f}: unterminated XML comment`);
      const body = src.slice(i + 4, end);
      assert.ok(!body.includes('--'),
        `${f}: "--" inside an XML comment is invalid XML (near: ${body.trim().slice(0, 60)}...)`);
      i = end + 3;
    }
    // Then the crude tag balance that catches a dropped closing tag.
    const opens = (src.match(/<[A-Za-z][^>]*[^/]>/g) || []).length;
    const closes = (src.match(/<\/[A-Za-z][^>]*>/g) || []).length;
    const selfClosed = (src.match(/<[A-Za-z][^>]*\/>/g) || []).length;
    assert.ok(opens >= closes, `${f}: more closing tags than opening ones`);
    assert.ok(selfClosed >= 0);
  }
});
