/* THE GAP THAT test/speed.test.mjs COULD NOT SEE.

   A table with no `id` column costs a doomed round trip on every single fetchAll() page,
   forever, until it is added to PAGE_KEY (api/_lib/supabase.js) with its real key -- see that
   map's own comment for the mechanism. `devices` and `imprest_roles` were found and fixed
   that way once; what had not been checked was every OTHER table.

   Ten more were wrong, found from a real Postgres query log rather than from this suite --
   because test/fake-db.mjs is deliberately schema-agnostic (it knows a fixture's ROWS, never
   a table's true column set), so it has no way to fail an ORDER BY on a column that flatly
   does not exist; that is a different question from `missingColumns`, which models a
   migration not yet run. Every trip-count test in this repo, including every ceiling in
   speed.test.mjs, was silently blind to this whole class of cost.

   This file is the guard that replaces "wait for someone to paste a slow query": it reads the
   REAL schema straight from db/schema.sql and db/migrations/*.sql -- the SQL Supabase actually
   runs, not a fixture -- and checks every table this codebase ever pages against it. A table
   is safe when either it has a genuine `id` column (PAGE_KEY's default needs no entry), or it
   is listed in PAGE_KEY under a column that table genuinely has. Add a table with neither and
   this fails before `npm test` does, not after a query log does. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { PAGE_KEY } from '../api/_lib/supabase.js';

const ROOT = new URL('../', import.meta.url);
const read = p => readFileSync(new URL(p, ROOT), 'utf8');

/** Every `create table` this repo ships, real column names only -- comments and constraint
    lines (primary key / unique / check / foreign key / a bare `--`) dropped. Idempotent
    CREATE TABLE IF NOT EXISTS is safe to parse more than once: a later file re-declaring a
    table already known (there are none today) would simply be ignored below. */
function realSchema() {
  const files = ['db/schema.sql', ...readdirSync(new URL('db/migrations', ROOT)).filter(f => f.endsWith('.sql'))
    .map(f => 'db/migrations/' + f)];
  const tables = new Map();
  for (const f of files) {
    const sql = read(f);
    for (const m of sql.matchAll(/create table(?: if not exists)?\s+"?(\w+)"?\s*\(([\s\S]*?)\n\);/gi)) {
      const [, name, body] = m;
      if (tables.has(name)) continue;
      const cols = new Set();
      const stripped = body.replace(/\/\*[\s\S]*?\*\//g, '');
      for (let line of stripped.split('\n')) {
        line = line.replace(/--.*$/, '').trim();
        if (!line || /^(primary key|unique|check|constraint|foreign key)\b/i.test(line)) continue;
        const col = line.split(/\s+/)[0].replace(/,$/, '').replace(/^"|"$/g, '');
        if (col) cols.add(col);
      }
      tables.set(name, cols);
    }
  }
  return tables;
}

/** Every table name this codebase ever calls `db.from('...')` on, anywhere under api/. A
    literal string only -- a table name built at runtime would not page-key correctly either,
    and there are none today (grepped by hand when this file was written). */
function tablesReferenced() {
  const files = readdirSync(new URL('api', ROOT)).filter(f => f.endsWith('.js')).map(f => 'api/' + f)
    .concat(readdirSync(new URL('api/_lib', ROOT)).filter(f => f.endsWith('.js')).map(f => 'api/_lib/' + f));
  const tables = new Set();
  for (const f of files) {
    for (const m of read(f).matchAll(/\.from\(['"]([a-z_]+)['"]\)/g)) tables.add(m[1]);
  }
  return tables;
}

test('every table this codebase pages either has a real id column, or PAGE_KEY names one it actually has', () => {
  const schema = realSchema();
  const referenced = tablesReferenced();
  const bad = [];
  for (const table of referenced) {
    const cols = schema.get(table);
    if (!cols) continue;   // not a table this schema creates (a view, or read via an rpc) -- out of scope here
    const keyed = Object.prototype.hasOwnProperty.call(PAGE_KEY, table) ? PAGE_KEY[table] : 'id';
    if (!cols.has(keyed)) {
      bad.push(`${table}: pages ordered by '${keyed}', which is not a column of ${table} `
        + `(real columns: ${[...cols].join(', ')}) -- add PAGE_KEY['${table}'] = '<the real key>' in api/_lib/supabase.js`);
    }
  }
  assert.deepEqual(bad, []);
});

test('every PAGE_KEY entry still names a real column of a real table', () => {
  const schema = realSchema();
  const bad = [];
  for (const [table, key] of Object.entries(PAGE_KEY)) {
    const cols = schema.get(table);
    if (!cols) continue;   // call_agents: a stray entry from the hope-pmo-v2 template, no such table here -- harmless
    if (!cols.has(key)) bad.push(`PAGE_KEY['${table}'] = '${key}', but ${table} has no such column`);
  }
  assert.deepEqual(bad, []);
});
