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

/* =========================================================================================
   THE RENAME, AND THE FOUR STRINGS IT MUST NOT TOUCH.

     "the apk and everywhere rename this from hoopcalls to hooploan"

   The visible name is now HOOPLOAN everywhere an officer can read it. Underneath it there
   are four identifiers that still spell the old name, and every one of them is load-bearing
   in a way that is invisible from a diff. Somebody will eventually find them and finish the
   job; this is the note that stops them, with the consequence attached to each:

     applicationId   Android identifies an install by it. Change it and the next build is a
                     SECOND app: the old icon stays, its data stays in it, and every handset
                     registered under the old id is orphaned. Never an update.
     namespace       generates BuildConfig, which the app reads for START_URL and
                     VERSION_CODE; it moves with the package directory, not with the brand.
     "hopecalls"     the SharedPreferences file. It holds the device id the server knows each
                     handset by and the saved access code. Rename it and every officer is
                     signed out onto a device nobody recognises.
     keystore alias  the signing key. Android refuses an update signed by a different key,
                     and Device Owner provisioning pins its certificate CHECKSUM into the QR
                     -- so re-keying strands every phone already provisioned, at the setup
                     wizard, with no way forward.
   ========================================================================================= */
const androidFile = p => fs.readFileSync(new URL('../android/' + p, import.meta.url), 'utf8');

/** Java with its comments removed. The notes in these files QUOTE the old names in order to
    explain why the identifiers beside them were left alone, so a check on what SHIPS has to
    read only what ships. Block comments go entirely; line comments only where `//` opens the
    line, so a `https://` inside a string literal is never mistaken for one. */
const javaCode = p => androidFile(p)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^[ \t]*\/\/.*$/gm, '');

test('the app is called HOOPLOAN everywhere an officer can read it', () => {
  const strings = androidFile('app/src/main/res/values/strings.xml');
  assert.match(strings, /<string name="app_name">HOOPLOAN<\/string>/,
    'the launcher label is the one name people actually see');

  // The update dialog names the app so the officer can find it in Android's own settings
  // list -- which lists it under app_name. The two must not drift apart again.
  const updater = javaCode('app/src/main/java/com/samaritantechs/hoopcalls/Updater.java');
  assert.doesNotMatch(updater, /HOOP PMO|HOOP Calls/,
    'the update prompt must name the app exactly as the launcher does');

  const main = androidFile('app/src/main/java/com/samaritantechs/hoopcalls/MainActivity.java');
  const offline = main.match(/<h2 style='margin:0 0 6px'>([^<]*)<\/h2>/);
  assert.ok(offline, 'the offline fallback screen lost its heading');
  assert.equal(offline[1], 'HOOPLOAN');
});

test('the rename stops at the four identifiers that carry identity, not branding', () => {
  const gradle = androidFile('app/build.gradle');
  assert.match(gradle, /applicationId 'com\.samaritantechs\.hoopcalls'/,
    'renaming applicationId installs a SECOND app and orphans every registered handset');
  assert.match(gradle, /namespace 'com\.samaritantechs\.hoopcalls'/,
    'the namespace generates BuildConfig and moves with the package directory, not the brand');
  assert.match(gradle, /keyAlias 'hopecalls'/,
    'a new signing key cannot update an installed app, and breaks Device Owner provisioning');

  const main = androidFile('app/src/main/java/com/samaritantechs/hoopcalls/MainActivity.java');
  assert.match(main, /getSharedPreferences\("hopecalls"/,
    'the preferences file holds the device id and access code -- renaming it signs everyone out');
});

test('both bridge names are published, because the page is served to older installs too', () => {
  /* public/call.html is deployed from Vercel the moment a merge lands; the APK reaches a
     phone whenever its owner taps Update. For the days in between, a page that looked only
     for the new name would find no bridge at all on every un-updated handset -- no call log,
     no device id -- and the remedy would be "update the app we can no longer reach". */
  const main = androidFile('app/src/main/java/com/samaritantechs/hoopcalls/MainActivity.java');
  assert.match(main, /addJavascriptInterface\(bridge, "HoopLoan"\)/);
  assert.match(main, /addJavascriptInterface\(bridge, "HopeCalls"\)/);
  assert.equal((main.match(/new HoopLoanBridge\(/g) || []).length, 1,
    'ONE bridge object under two names -- two would be two copies of the same state');
});

test('the APK the version file advertises is a file that exists', () => {
  /* app-version.json is deployed by Vercel the instant a merge lands; the APK itself is
     built minutes later by Actions. Pointing apkUrl at a path with nothing behind it hands
     every phone a 404 in that gap, and the app then reports "the last update did not
     finish" on the next launch. Whatever the URL says must already be committed. */
  const v = JSON.parse(fs.readFileSync(new URL('../app-version.json', import.meta.url), 'utf8'));
  const name = v.apkUrl.split('/').pop();
  assert.ok(fs.existsSync(new URL('../public/' + name, import.meta.url)),
    `app-version.json advertises /${name}, which is not in public/`);
  // The old path stays served: links written on setup sheets and turned into QR codes for
  // the sales desks point at it forever, and a 404 there reads as "the system is down".
  assert.ok(fs.existsSync(new URL('../public/HOOP-Calls.apk', import.meta.url)),
    'the pre-rename download path must keep working for links already in circulation');
});
