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
