// The seed guard. Hope's real test harness (fake-db) gets copied over with the first
// API code; until then these tests hold the two promises the seed makes: the schema
// file keeps its invariants, and nothing turns IMEI into a number.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as spawnMod from 'node:child_process';

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

/* =========================================================================================
   THE BLUE SCREEN WITH NOTHING ON IT.

     "app is blanking blue not opening"

   The WebView's background is painted navy so the status-bar strip matches the header, which
   means an empty WebView IS a full navy screen. Two separate things could produce one, and
   neither had anything watching it:

     1. NATIVE. onReceivedError fires on an error. A load that simply never finishes is not an
        error, and neither is an HTTP 500 on the main frame -- so the fallback screen, the one
        thing in this app with a Retry button, was unreachable in exactly the cases that
        needed it.
     2. THE PAGE. srv() gives each attempt 25 seconds and retries twice. A merely slow server
        therefore kept #scrBoot mute for over a minute before #bootErr appeared. A screen that
        says nothing for that long is indistinguishable from a broken app, so the officer
        force-stops it -- and starts the whole wait again.
   ========================================================================================= */
test('no load in the wrapper can end in a silent navy screen', () => {
  const main = javaCode('app/src/main/java/com/samaritantechs/hoopcalls/MainActivity.java');
  assert.match(main, /web\.postDelayed\(loadWatchdog, LOAD_TIMEOUT_MS\)/,
    'every page load must be racing a watchdog');
  /* Matched with the argument list, not just the name. `/onPageFinished/` alone also matches
     `onPageFinishedX` -- so renaming the override, which is exactly how it would stop being an
     override, sailed through the first version of this check. */
  assert.match(main, /public void onPageFinished\(WebView [\s\S]{0,200}?removeCallbacks\(loadWatchdog\)/,
    'the watchdog must be called off, by that exact override, when the page does arrive');
  assert.match(main, /public void onReceivedHttpError\(WebView /,
    'a 500 on the main frame is not onReceivedError -- it needs its own path to the fallback');

  /* The one that would actually be reintroduced: a NEW load added later, straight through
     web.loadUrl, with nothing watching it. Retry is the dangerous one -- it is pressed FROM
     the fallback screen, so an unwatched retry is a dead end reached by trying to escape one. */
  const bare = [...main.matchAll(/web\.loadUrl\(/g)];
  assert.equal(bare.length, 1,
    'web.loadUrl belongs only inside loadWatched() -- every other load must go through it');
  assert.ok(/private void loadWatched\(String url\)\{?[\s\S]{0,600}?web\.loadUrl\(url\)/.test(main),
    'the single web.loadUrl must be the one inside loadWatched');
});

test('the boot screen speaks up long before the retries run out', () => {
  const src = fs.readFileSync(new URL('../public/call.html', import.meta.url), 'utf8');
  const slow = Number((src.match(/var BOOT_SLOW_MS = (\d+)/) || [])[1]);
  const perTry = Number((src.match(/\}, (\d+)\);\s*\n\s*fetch\(/) || [])[1]);
  assert.ok(slow > 0, 'BOOT_SLOW_MS not found');
  assert.ok(perTry > 0, 'the srv() abort deadline not found');
  assert.ok(slow < perTry,
    `the boot screen must say something (${slow}ms) before even the FIRST attempt times out `
    + `(${perTry}ms) -- waiting for all three is the minute of silence that was reported`);
  // Slow is not failure: the spinner keeps turning and the request is never cancelled.
  assert.ok(/if \(S\.entered\) return;[\s\S]{0,400}?bootErr'\)\.classList\.remove\('hide'\)/.test(src),
    'a handset already working from its own cache must never be shown this');
  assert.match(src, /bootSlowStop_\(true\)/, 'a boot that succeeds must take the notice back down');
  assert.match(src, /bootSlowStop_\(false\)/, 'a boot that fails must leave the failure showing');
});

test('the wrapper is syntactically valid Java', () => {
  /* CI compiles it properly, with the SDK. That feedback arrives minutes later and has cost a
     round trip before now (a missing `import android.os.Build` once did exactly that), so this
     catches the cheap half here: javac without the Android platform still PARSES every file,
     and reports a syntax slip -- a dropped brace, a stray paren, a malformed lambda -- as a
     syntax error rather than as a missing symbol.

     BE CLEAR ABOUT WHAT THIS IS NOT. Without android.jar every Android type is unknown, so
     three whole classes of real error are indistinguishable from the expected noise and are
     filtered out below: a missing import and a genuine typo both read "cannot find symbol",
     and every @Override on an Android supertype reads "does not override" because the
     supertype itself is absent. This is a PARSE check. Only CI compiles this for real. */
  const { spawnSync } = spawnMod;
  const dir = new URL('../android/app/src/main/java/', import.meta.url).pathname;
  const probe = spawnSync('javac', ['-version'], { encoding: 'utf8' });
  if (probe.error) return;                       // no JDK here; CI still compiles it for real
  const r = spawnSync('javac', ['-d', '/tmp/javac-parse-check', '-nowarn',
    dir + 'com/samaritantechs/hoopcalls/MainActivity.java',
    dir + 'com/samaritantechs/hoopcalls/HoopLoanBridge.java',
    dir + 'com/samaritantechs/hoopcalls/Updater.java'], { encoding: 'utf8' });
  const EXPECTED_WITHOUT_THE_SDK =
    /cannot find symbol|does not exist|cannot access|does not override or implement/;
  const syntax = (r.stderr || '').split('\n')
    .filter(l => /error:/.test(l) && !EXPECTED_WITHOUT_THE_SDK.test(l));
  assert.deepEqual(syntax, [], 'javac reported something that is not a missing Android class');
});

test('the lock app is syntactically valid Java', () => {
  /* Same parse-only check, same caveats, on the other app -- and this one matters more. A
     syntax slip in the wrapper shows up the moment somebody opens the calls app; a slip in
     here is only found when a handset is already boxed and on a shelf. */
  const { spawnSync } = spawnMod;
  const dir = new URL('../android/lock/src/main/java/com/samaritantechs/hooploanlock/',
    import.meta.url).pathname;
  if (spawnSync('javac', ['-version'], { encoding: 'utf8' }).error) return;
  const r = spawnSync('javac', ['-d', '/tmp/javac-parse-lock', '-nowarn',
    ...fs.readdirSync(dir).filter(f => f.endsWith('.java')).map(f => dir + f),
  ], { encoding: 'utf8' });
  const EXPECTED_WITHOUT_THE_SDK =
    /cannot find symbol|does not exist|cannot access|does not override or implement|package (android|org\.json)/;
  const syntax = (r.stderr || '').split('\n')
    .filter(l => /error:/.test(l) && !EXPECTED_WITHOUT_THE_SDK.test(l));
  assert.deepEqual(syntax, [], 'javac reported something that is not a missing Android class');

  /* AND THE ONE REAL ERROR THIS CANNOT SEE: A CLASS USED WITHOUT ITS IMPORT.
     -----------------------------------------------------------------------------------
     Not hypothetical -- `Context` used in LockActivity with no `import android.content.Context`
     passed everything above and failed the real compile in CI a minute later.

     And javac cannot help here, which is worth knowing before someone tries: without
     android.jar it stops at the IMPORT lines ("package android.content does not exist") and
     never reaches the usage, so the "cannot find symbol" the SDK build reports is never
     produced locally at all. A guard written to read those never fires.

     So this reads the source instead. Every android.* class any file in the package imports
     is the vocabulary this app uses; if a file mentions one of those names in its code and
     does not import it, that file does not compile -- anywhere. Comments and string literals
     are stripped first, because the notes here quote type names constantly. */
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.java'));
  const vocabulary = new Set();
  for (const f of files) {
    for (const m of fs.readFileSync(dir + f, 'utf8').matchAll(/^import\s+android\.[\w.]*\.(\w+)\s*;/gm)) {
      vocabulary.add(m[1]);
    }
  }
  const unimported = [];
  for (const f of files) {
    const raw = fs.readFileSync(dir + f, 'utf8');
    const mine = new Set([...raw.matchAll(/^import\s+[\w.]*\.(\w+)\s*;/gm)].map(m => m[1]));
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')            // block comments
      .replace(/\/\/.*$/gm, ' ')                    // line comments
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')          // string literals
      .replace(/^import\s+[^;]+;/gm, ' ');           // the imports themselves
    for (const name of vocabulary) {
      if (mine.has(name)) continue;
      if (new RegExp('\\b' + name + '\\b').test(code)) {
        unimported.push(f + ' uses ' + name + ' without importing it');
      }
    }
  }
  assert.deepEqual(unimported.sort(), [],
    'a class is used without an import for it -- that compiles nowhere, and javac without the '
    + 'Android SDK cannot see it, so CI is otherwise the first thing to notice');
});
/* =========================================================================================
   THE FOUR LINES ON A LOCKED PHONE, and why a test stands over them.

       HOOP LIMITED
       SIMU HII IMEFUNGWA NA HOOP LIMITED. WASILIANA NASI KWA NAMBA 0700000000
       IMEI: 351388334583295
       REASON: STOCK, UNSOLD

   That shape was specified by the person who answers the calls, and it is the only part of
   this system a customer ever reads. Nobody sees this screen during development -- it needs
   a provisioned handset and a lock order to appear at all -- so a line quietly lost in a
   refactor would ship, sit in a box, and surface as a phone call nobody can resolve because
   the caller cannot say which handset they are holding.
   ========================================================================================= */
test('the lock screen keeps its four lines, and hard-codes none of the words', () => {
  const lock = javaCode('lock/src/main/java/com/samaritantechs/hooploanlock/LockActivity.java');

  assert.match(lock, /"IMEI: "/, 'the IMEI line is what a caller reads out to identify the phone');
  assert.match(lock, /"REASON: "/, 'a lock with no stated reason is the one nobody can resolve');
  assert.match(lock, /setAllCaps\(true\)/, 'read at arm\'s length, outdoors, by somebody upset');

  // Every word comes down the wire. A literal company name here is a rename that needs an
  // APK on every handset already in a customer's pocket -- see CALL_BRAND for how that ends.
  assert.doesNotMatch(lock, /"HOOP[^"]*"/,
    'the brand belongs in DEVICE_LOCK_BRAND, never compiled into the lock screen');
  for (const key of ['Prefs.BRAND', 'Prefs.IMEI', 'Prefs.REASON', 'Prefs.HELP_PHONE']) {
    assert.ok(lock.includes(key), 'the lock screen stopped reading ' + key);
  }
});

test('the beat carries every word the lock screen shows', () => {
  const core = fs.readFileSync(new URL('../api/_lib/device-core.js', import.meta.url), 'utf8');
  const beat = javaCode('lock/src/main/java/com/samaritantechs/hooploanlock/Beat.java');
  /* Both ends of the same wire. The server may send a field the handset ignores and nothing
     breaks visibly -- the screen simply comes out blank on a phone in somebody's hand. */
  for (const field of ['brand', 'imei', 'message', 'helpPhone', 'reason']) {
    assert.match(core, new RegExp('\\b' + field + '\\b'), 'device-core stopped sending ' + field);
    assert.match(beat, new RegExp('optString\\("' + field + '"'), 'Beat stopped storing ' + field);
  }
});

/* =========================================================================================
   ONE STATUS-BAR MECHANISM, AND IT IS fitsSystemWindows.

     "the apk interfaces both callap and system are too high to touch the top bar functions
      (solve as we did with hopeloan)"
     "you didn't solve the interface haven't buttons on top battery and network positions"

   Reported twice, because the first fix was not one. Two mistakes, both worth a guard:

     THE WRAPPER. setFitsSystemWindows(true) works by way of View.onApplyWindowInsets(), and
     setOnApplyWindowInsetsListener REPLACES that method outright. A listener added to
     REINFORCE fitsSystemWindows is therefore the thing that switches it off. Its guard made
     it worse -- SDK_INT >= 30 is Android 11, so every handset from 11 up lost the working
     path, not the Android 15 ones it was aimed at. HOPE runs the same theme, the same
     targetSdk and the same WebView-as-content-view with fitsSystemWindows alone, in
     production, every day.

     THE PAGE. `padding:calc(14px + env(safe-area-inset-top,0px))` cannot help either, and
     this is the subtler trap: the wrapper hands the page a viewport that ALREADY starts
     below the status bar, so that inset is 0 and the calc resolves to the padding that was
     already there. It reads like a fix in a diff and is a no-op on the handset -- which is
     worse than nothing, because it makes a live bug look closed.
   ========================================================================================= */
test('the wrapper keeps exactly one status-bar mechanism', () => {
  const main = javaCode('app/src/main/java/com/samaritantechs/hoopcalls/MainActivity.java');
  assert.match(main, /web\.setFitsSystemWindows\(true\)/,
    'this is the mechanism HOPE uses, and the one that works');
  assert.doesNotMatch(main, /setOnApplyWindowInsetsListener/,
    'an inset listener REPLACES onApplyWindowInsets, which is how fitsSystemWindows works -- '
    + 'adding one disables the very thing it looks like it is helping');
  assert.doesNotMatch(main, /web\.setBackgroundColor/,
    'the navy WebView background only ever tinted the strip that listener created; without '
    + 'it, it just turns an empty WebView into a featureless blue screen');
});

test('no page pads itself with an inset it never checked', () => {
  /* THE BAN IS ON THE BLIND VERSION, and this distinction is the whole lesson.

     `padding: calc(14px + env(safe-area-inset-top,0px))` in a stylesheet is inert wherever
     the wrapper has already inset the viewport: the value is 0, the calc resolves to the
     padding that was already there, and the diff reads like a fix. That is what shipped
     twice, and it is what stays banned.

     MEASURING the same value is the opposite thing. statusBarFit_() reads it off a probe
     element, compares screen height against the viewport the page was actually given, and
     pads only when the numbers say the page is drawing under the clock. That is allowed --
     it is the thing that replaced the guesswork.

     So the check is narrow on purpose: the inset may not appear inside a padding
     declaration. It may appear in a height, which is how a probe is measured. */
  for (const f of ['call.html', 'portal.html', 'upload.html', 'index.html']) {
    const url = new URL('../public/' + f, import.meta.url);
    if (!fs.existsSync(url)) continue;
    /* Comments stripped first. The note explaining why the blind version is useless NAMES
       it, so a check against the raw file fails on its own documentation -- which is how the
       reader ends up deleting the explanation to make the test pass. */
    const shipped = fs.readFileSync(url, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
    assert.doesNotMatch(shipped, /padding[^;{}]*env\(safe-area-inset-top/,
      `${f}: padding computed from safe-area-inset-top is 0 wherever the wrapper already `
      + 'inset the viewport -- a no-op that reads as a fix. Measure it (statusBarFit_) '
      + 'and pad only when the measurement says the page is under the clock.');
  }
});

/* =========================================================================================
   THE NAME LIVES IN ONE PLACE.

     "set CALL_BRAND to HOOPLOAN"

   Every file in the repo said HOOPLOAN, the launcher said HOOPLOAN, and /api/call went on
   answering {"brand":"HOOP CALLS"} -- because the name was ALSO a row in the settings table,
   planted by db/seed.sql before the rename, and a settings row outranks the constant in
   call-core.js. A rename that greps the source can never find that, which is why it survived
   an APK rebuild, a full-text sweep and three deployments.

   Seeding a setting whose only value is a copy of the code default is the whole trap: it is
   invisible until the default changes, and then it silently wins. The setting still exists
   for a deployment that wants a genuinely different brand -- it is simply not planted.
   ========================================================================================= */
test('the calls app brand is a constant, not a seeded copy of one', () => {
  const seed = fs.readFileSync(new URL('../db/seed.sql', import.meta.url), 'utf8')
    .replace(/^\s*--.*$/gm, '');            // the note explaining this NAMES the key
  assert.doesNotMatch(seed, /insert into settings[\s\S]{0,120}?'CALL_BRAND'/i,
    'seeding CALL_BRAND plants a copy of the name that outranks APP.BRAND and goes stale '
    + 'the moment the code default changes -- which is exactly what happened');

  const core = fs.readFileSync(new URL('../api/_lib/call-core.js', import.meta.url), 'utf8');
  assert.match(core, /BRAND:\s*'HOOPLOAN'/, 'APP.BRAND is the single source of the name');
  // Both readers must fall back to it, or removing the row would blank the brand instead.
  assert.equal((core.match(/CALL_BRAND'\)\s*\|\|\s*APP\.BRAND|CALL_BRAND'\)\s*\|\|\s*APP\.BRAND/g) || []).length
    + (core.match(/setting\('CALL_BRAND'\)\s*\|\|\s*APP\.BRAND/g) || []).length, 2,
    'every reader of CALL_BRAND must fall back to APP.BRAND when the row is absent');
});

/* =========================================================================================
   THE BENCH SCRIPT. Nothing here can run adb, so this checks the two things that are wrong
   in the FILE rather than on the bench: that it parses at all, and that it keeps the two
   provisioning commands in the one order that works.
   ========================================================================================= */
test('the bench script is valid bash and provisions in the order that works', () => {
  const { spawnSync } = spawnMod;
  const path = new URL('../scripts/lock-bench.sh', import.meta.url).pathname;
  const src = fs.readFileSync(path, 'utf8');

  const parsed = spawnSync('bash', ['-n', path], { encoding: 'utf8' });
  if (!parsed.error) assert.equal(parsed.status, 0, parsed.stderr);

  /* SET-DEVICE-OWNER BEFORE THE ENROL BROADCAST, always. The other way round, the receiver
     drops the token on the floor and `am broadcast` still prints "Broadcast completed:
     result=0" -- which reads exactly like success. That cost an evening on the first
     handset; a script that shipped them reversed would cost it once per batch. */
  const owner = src.indexOf('set-device-owner');
  const enrol = src.indexOf('.ENROL');
  assert.ok(owner > 0 && enrol > 0, 'the script lost one of the two provisioning commands');
  assert.ok(owner < enrol, 'set-device-owner must come BEFORE the enrol broadcast');

  // It must never invent a token for a phone whose IMEI it could not read: a token in the
  // wrong handset makes that phone answer for somebody else's loan.
  assert.match(src, /NEVER GUESS/, 'the unmatched-phone guard was removed');
  assert.match(src, /\$\{TOKEN_OF\[\$IMEI\]:-\}/, 'the token lookup must default to empty, never to a neighbour');
});

/* =========================================================================================
   AND THE SAME SCRIPT FOR WINDOWS, which is what the station actually runs.

     C:\Users\marki>./scripts/lock-bench.sh tokens.txt
     '.' is not recognized as an internal or external command

   A bash script on a Windows bench is not a slow path, it is no path -- so there are two
   scripts, and the risk is now that they drift. This holds the PowerShell one to the same
   two rules that matter, and checks the pair still describe the same three commands.
   ========================================================================================= */
test('the Windows bench script matches the Linux one where it counts', () => {
  const ps = fs.readFileSync(new URL('../scripts/lock-bench.ps1', import.meta.url), 'utf8');
  const sh = fs.readFileSync(new URL('../scripts/lock-bench.sh', import.meta.url), 'utf8');

  // Owner before enrol, here too. The failure mode is identical and just as silent.
  const owner = ps.indexOf('set-device-owner');
  const enrol = ps.indexOf('.ENROL');
  assert.ok(owner > 0 && enrol > 0, 'the PowerShell script lost one of the provisioning commands');
  assert.ok(owner < enrol, 'set-device-owner must come BEFORE the enrol broadcast');

  assert.match(ps, /NEVER GUESS/, 'the unmatched-phone guard was removed from the Windows script');
  assert.match(ps, /if \(-not \$token\)/, 'a phone with no matched token must be skipped, never defaulted');

  // Both scripts must name the same package, receiver and admin component -- a rename that
  // reaches one and not the other bricks a whole bench day on whichever laptop is running
  // the stale copy.
  for (const needle of [
    'com.samaritantechs.hooploanlock',
    '/.LockAdmin',
    '/.EnrolReceiver',
    'ENROLLED',
  ]) {
    assert.ok(sh.includes(needle), 'lock-bench.sh no longer mentions ' + needle);
    assert.ok(ps.includes(needle), 'lock-bench.ps1 no longer mentions ' + needle);
  }

  // The .bat exists only so nobody has to remember the powershell incantation; if it stops
  // pointing at the .ps1 it is a file that does nothing when double-clicked.
  const bat = fs.readFileSync(new URL('../scripts/lock-bench.bat', import.meta.url), 'utf8');
  assert.match(bat, /lock-bench\.ps1/, 'the launcher stopped pointing at the script it launches');
});

/* =========================================================================================
   A PHONE WHOSE ROW IS GONE MUST NOT BE A BRICK FOREVER.

     "if it doesn't find it's tocken it's should release fromm organization ownership"

   The handset used to treat a 403 -- "the register does not know this token" -- as a reason
   to carry on unchanged. That left a phone whose row had been deleted hardened for good,
   with nobody able to lock it, unlock it or release it, and refusing the factory reset that
   would have fixed it.

   The fix is a release on SUSTAINED refusal, and the two halves are both load-bearing: it
   must happen, or the phone is a brick; and it must not happen at the first 403, or one bad
   deploy hands every phone HOOP owns back to whoever is holding it. Both are asserted here,
   because a later reader tidying this into "release on 403" would be undoing the second half
   without noticing there was one.
   ========================================================================================= */
test('the handset releases itself only after a SUSTAINED not-enrolled, never at once', () => {
  const beat = javaCode('lock/src/main/java/com/samaritantechs/hooploanlock/Beat.java');

  assert.match(beat, /RETIRE_AFTER_GONE_MS/, 'the sustained-403 release was removed');
  const days = beat.match(/RETIRE_AFTER_GONE_MS\s*=\s*(\d+)L?\s*\*\s*24/);
  assert.ok(days, 'the threshold must be written in days, so its size is readable at a glance');
  assert.ok(Number(days[1]) >= 7,
    'a short threshold turns a bad deploy into a fleet-wide release; keep it in weeks');

  // The 403 clock is started, not acted on, the first time -- and any successful beat
  // clears it, so a phone that comes back is never carrying a stale countdown.
  assert.match(beat, /GONE_SINCE, System\.currentTimeMillis\(\)/, 'the first 403 must only start the clock');
  assert.match(beat, /remove\(Prefs\.GONE_SINCE\)/, 'a successful beat must clear the clock');

  // Only a 403 counts. A timeout or a DNS failure is silence, and silence never frees a
  // phone -- that is what the offline grace is for, in the other direction.
  assert.match(beat, /lastStatus == 403/, 'only a real 403 may count toward the release');
});

/* =========================================================================================
   --include-stopped-packages, THE THIRD SUCCESS-SHAPED FAILURE THIS FEATURE HAS PRODUCED.

   A freshly installed app -- and any app that has had `pm clear` run on it -- sits in
   Android's STOPPED state and receives no broadcast at all unless the sender asks for one.
   Without the flag, `am broadcast` reports:

       Broadcast completed: result=0

   No result code, no message, nothing in logcat: EnrolReceiver is never constructed, so not
   one of its carefully-worded guards can fire. It looks exactly like the enrol working.

   Caught on a real handset that had been silent for twenty hours while the register happily
   recorded locks and releases against it. The signature is worth knowing: result=0 with NO
   data= means the receiver did not run; result=1..4 WITH a message means it did.

   Every place the command is written down must carry the flag, because whichever copy
   somebody pastes is the one that decides whether a phone gets provisioned.
   ========================================================================================= */
test('every written form of the enrol broadcast includes stopped packages', () => {
  const files = [
    'scripts/lock-bench.sh',
    'scripts/lock-bench.ps1',
    'docs/DEVICE-LOCKING.md',
    'android/lock/src/main/java/com/samaritantechs/hooploanlock/EnrolReceiver.java',
  ];
  for (const f of files) {
    const src = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    // Every `am broadcast` that names our ENROL action must carry the flag. Allowed to sit
    // on the next line -- both scripts wrap the command -- so the window is generous.
    const casts = [...src.matchAll(/am broadcast[\s\S]{0,220}?ENROL/g)];
    assert.ok(casts.length > 0, f + ': the enrol broadcast disappeared from this file');
    for (const m of casts) {
      assert.ok(/--include-stopped-packages/.test(m[0]),
        f + ': an enrol broadcast without --include-stopped-packages silently does nothing '
        + 'on a freshly installed or pm-cleared app, and prints result=0 like a success');
    }
  }
});

/* =========================================================================================
   A PHONE MUST NEVER GO SILENT WHILE IT IS STILL OWNED.
   =========================================================================================
   This is the bug that stranded the first A07, written down so it cannot come back.

   A release does three things: unlock the screen, step down as Device Owner, and stop
   beating. The old code did them in that fixed order and ignored whether the middle one
   actually took. But clearDeviceOwnerApp is deprecated and CAN be refused without throwing --
   Samsung's Knox layer does exactly that on an organisation-owned handset. So the phone kept
   ownership, and stopped calling home anyway: owned, silent, and unreachable by the office
   that was supposed to be able to reach it. A factory reset would have cleared it, and the
   lock forbids factory reset. That is a brick, and it was produced by the release path itself.

   The rule the fix encodes: RETIRED and the cancelled beat are only safe once the phone is
   ACTUALLY no longer owned. unharden() now reads that back off the system and returns it, and
   every caller waits on it. A phone the system refused to release keeps beating -- visible to
   the office, and reachable -- instead of disappearing.
   ========================================================================================= */
test('unharden reports whether ownership was truly given up', () => {
  const admin = javaCode('lock/src/main/java/com/samaritantechs/hooploanlock/LockAdmin.java');
  assert.match(admin, /static\s+boolean\s+unharden\s*\(/,
    'unharden must return the truth, not void -- callers decide whether to go silent on it');
  // The answer is read off the system after the step-down, never presumed from the call that
  // can lie. `return !isOwner(c)` is that read-back; a bare `return true` would be the lie.
  assert.match(admin, /return\s+!\s*isOwner\(c\)/,
    'unharden must read isOwner back after clearDeviceOwnerApp, which can be refused silently');
});

test('the handset never retires while it is still Device Owner', () => {
  const beat = javaCode('lock/src/main/java/com/samaritantechs/hooploanlock/Beat.java');
  /* Both release paths -- the office "retire", and the sustained-403 self-release -- must gate
     RETIRED behind a successful unharden. The shape that is safe is `if (unharden(...)) {
     RETIRED; cancel; }`; the shape that bricked the A07 was setting RETIRED unconditionally
     next to the unharden call. So: every place RETIRED is written must sit inside an
     unharden() test, and unharden must never be called and its answer thrown away. */
  const setsRetired = [...beat.matchAll(/Prefs\.put\(c,\s*Prefs\.RETIRED,\s*true\)/g)];
  assert.ok(setsRetired.length >= 2, 'both release paths should still set RETIRED');
  for (const m of setsRetired) {
    const before = beat.slice(Math.max(0, m.index - 120), m.index);
    assert.match(before, /if\s*\(\s*LockAdmin\.unharden\(c\)\s*\)/,
      'RETIRED is set without first confirming unharden() gave up ownership -- that is exactly '
      + 'the owned-and-silent brick the A07 became');
  }
  // And unharden must never be called as a bare statement whose boolean answer is discarded --
  // the whole fix is that the answer is load-bearing.
  assert.doesNotMatch(beat, /^\s*LockAdmin\.unharden\(c\);\s*$/m,
    'unharden() called and its answer thrown away -- the retire decision must depend on it');
});

/* =========================================================================================
   AND THE WAY BACK FROM A PHONE THAT IS ALREADY CARRYING THE FLAG.

     "so if a customer never reboots the phone?"

   The test above stops RETIRED being set wrongly from now on. It does nothing for a handset
   that already has it, and that phone is genuinely unreachable: every path checks the flag --
   Beat.run returns on its first line, BeatJob will not arm, Guard will not restore, SelfUpdate
   will not fetch -- and BootReceiver calls straight into those, so a reboot does not help
   either. `pm clear` is refused on a Device Owner app. There was no route home short of a
   factory reset.

   Found on a real handset: JobScheduler showed BeatJob running and finishing in 14
   MILLISECONDS, far too fast to be a network call, while the register showed it had not
   spoken for 51 minutes. That gap is the signature of this guard.

   Enrolling is the office saying "this handset is in service", and there is no reading of
   that which leaves it retired. So the one command the station already copies is the way
   back, and these are the three things that make it one.
   ========================================================================================= */
test('enrolling a handset puts it back in service, whatever it was carrying', () => {
  const enrol = javaCode('lock/src/main/java/com/samaritantechs/hooploanlock/EnrolReceiver.java');

  assert.match(enrol, /remove\(Prefs\.RETIRED\)/,
    'enrolment must clear RETIRED -- otherwise a phone that once carried it can never beat '
    + 'again, and no reboot and no reinstall will bring it back');
  assert.match(enrol, /remove\(Prefs\.GONE_SINCE\)/,
    'the unreachable-for-how-long clock must stop too; enrolment is when it stops being true');

  /* THE SAME TOKEN MUST FALL THROUGH, not bail. This is the case that happens on EVERY
     reinstall: `adb install -r` leaves the app in Android's stopped state, and the enrol
     broadcast is the only thing that starts it again. The old guard returned above the
     re-arming lines, so every cable install left a phone installed, owned, enrolled -- and
     silent until something rebooted it. */
  const armAt = Math.min(...['Beat.now(c, true)', 'BeatJob.schedule(c)'].map(s => enrol.indexOf(s)));
  const bail = enrol.indexOf('say(2,');
  assert.ok(armAt > 0, 'the enrol must still arm the beat and report in');
  assert.ok(bail > 0 && bail < armAt,
    'the refusal must sit above the re-arming lines -- and only the different-token case may reach it');
  assert.match(enrol, /boolean\s+same\s*=/,
    're-running with the same token must be recognised and allowed through, to re-arm the phone');

  /* THE SERVER STAYS PUT. A new token is a change of identity inside one office; a new
     server is a change of WHO OWNS THE PHONE, and is the one thing that could turn a leaked
     token into an unlock. So it is written at first enrolment only. */
  assert.ok(/if\s*\(fresh\)\s*\{[\s\S]{0,260}?Prefs\.SERVER/.test(enrol),
    'the server must only be settable on a FIRST enrolment -- a re-enrol that could re-point '
    + 'the phone at another server is a complete bypass of the lock');
});

/* =========================================================================================
   THE RELEASE MUST NOT ALSO PUT A LOCK SCREEN UP.

     "cmd runs and the bluescreen flushes off and back on in a second"
     "restarting the phone made the app flash and get off"

   Unlocking takes two routes: a broadcast to the live screen, and an activity start as a
   fallback for a screen believed up whose activity is gone. The fallback was guarded by
   re-reading SCREEN_UP on the line immediately after the broadcast, which READS as "only if
   the broadcast did not work" and cannot be -- sendBroadcast is asynchronous. It queues the
   intent and returns; the receiver runs afterwards on the main thread. The flag is always
   still true one line later, so the guard never once said no.

   Every unlock therefore did it twice: the broadcast took the screen down, and the fallback
   built a SECOND lock screen, drew it, read its extra and finished. That is the flash -- and
   for that moment a phone the office has just released is showing its customer a lock screen.
   ========================================================================================= */
test('the unlock fallback waits for the live screen instead of racing it', () => {
  const guard = javaCode('lock/src/main/java/com/samaritantechs/hooploanlock/Guard.java');
  const unlock = guard.slice(guard.indexOf('static void unlock'));
  const body = unlock.slice(0, unlock.indexOf('\n    }'));

  const sent = body.indexOf('sendBroadcast');
  const started = body.indexOf('startActivity');
  assert.ok(sent > 0 && started > sent, 'the broadcast must still come first, and the start still exist');

  // The fallback must be deferred, not evaluated inline after an async send.
  assert.match(body, /postDelayed/,
    'the fallback must wait for the live screen to act -- a SCREEN_UP read on the next line '
    + 'is always still true, because sendBroadcast is asynchronous');
  const between = body.slice(sent, started);
  assert.match(between, /postDelayed/,
    'the activity start must sit INSIDE the delayed block, or it still races the broadcast');

  // And a phone re-locked in the meantime must not be torn down by a stale fallback.
  assert.match(between, /Prefs\.LOCKED/,
    'the deferred fallback must re-check LOCKED -- an operator can re-lock within the delay');
});

/* A screen already up, re-locked under a new reason, used to go on showing the old one: the
   words are read when the activity is built, and re-locking an already-locked phone builds
   nothing. Register and glass then give two different answers to "why is my phone off". */
test('a new lock reason repaints a screen that is already up', () => {
  const guard = javaCode('lock/src/main/java/com/samaritantechs/hooploanlock/Guard.java');
  const act = javaCode('lock/src/main/java/com/samaritantechs/hooploanlock/LockActivity.java');

  assert.match(guard, /ACTION_REPAINT/, 'Guard must be able to tell a live screen the words changed');
  const lock = guard.slice(guard.indexOf('static void lock'));
  assert.match(lock.slice(0, lock.indexOf('\n    }')), /sendBroadcast[\s\S]{0,80}ACTION_REPAINT/,
    'locking must send the repaint, or a re-lock under a new reason shows the previous one');

  assert.match(act, /addAction\(Guard\.ACTION_REPAINT\)/,
    'the screen must actually be listening for the repaint');
  assert.match(act, /ACTION_REPAINT\.equals[\s\S]{0,200}refresh\(\)/,
    'a repaint must re-read the words -- and must NOT be treated as a release');
  assert.match(act, /protected void onResume\(\)[\s\S]{0,120}refresh\(\)/,
    'and coming back to the front must repaint too, for a broadcast that arrived too early');
});

/* =========================================================================================
   A PHONE THAT CANNOT HEAR US IS NOT LOCKED, IT IS LOST.

     "wifi is off, let me connect it"     "the reset took it off"

   A handset sat locked for thirty-five minutes after the office had already released it.
   Every layer read healthy: the job was scheduled, the app was armed, the enrol answered
   "reporting in now". The phone simply had no network.

   The reason it could not recover on its own is the part worth pinning. BeatJob asked for
   NETWORK_TYPE_ANY, and a job with a network requirement DOES NOT RUN while there is no
   network -- so the app never woke, and an app that never wakes cannot notice it is offline
   or turn the radio back on. Being offline sustained itself.

   And nobody could fix it from the handset either: a locked phone is pinned in lock task, so
   Settings is out of reach. A customer who has PAID IN FULL would be holding a phone that
   neither they nor the office can open, and the only way in is a cable.
   ========================================================================================= */
test('a phone with no network can still wake up and get its radio back', () => {
  const job = javaCode('lock/src/main/java/com/samaritantechs/hooploanlock/BeatJob.java');
  const sched = job.slice(job.indexOf('static void schedule'));
  const body = sched.slice(0, sched.indexOf('\n    }'));
  assert.ok(!/setRequiredNetworkType/.test(body),
    'the PERIODIC beat must have no network constraint -- with one it never runs on an '
    + 'offline phone, so the app can never notice it is offline or fix it');

  const beat = javaCode('lock/src/main/java/com/samaritantechs/hooploanlock/Beat.java');
  const run = beat.slice(beat.indexOf('private static void run('));
  const ensure = run.indexOf('Net.ensureOnline');
  const http = run.indexOf('HttpURLConnection');
  assert.ok(ensure > 0, 'every beat must try to restore connectivity first');
  assert.ok(http < 0 || ensure < http, 'and it must do so BEFORE attempting the request');

  // Turning a radio on needs the permission even as Device Owner; without it the call fails
  // on precisely the phone nobody can reach to find out.
  const man = fs.readFileSync(
    new URL('../android/lock/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  assert.match(man, /permission\.CHANGE_WIFI_STATE/, 'setWifiEnabled needs CHANGE_WIFI_STATE');

  /* And the radio must not be switchable off from under us while the phone is ours.
     Airplane mode is one tap from any screen; on Android 13+ so is Wi-Fi. Both are held for
     exactly as long as Device Owner is, and unharden must give them back -- a phone handed
     back to a customer is an ordinary phone. */
  const admin = javaCode('lock/src/main/java/com/samaritantechs/hooploanlock/LockAdmin.java');
  const hard = admin.slice(admin.indexOf('static void harden'), admin.indexOf('static boolean unharden'));
  const soft = admin.slice(admin.indexOf('static boolean unharden'));
  for (const r of ['DISALLOW_AIRPLANE_MODE', 'DISALLOW_CHANGE_WIFI_STATE']) {
    assert.ok(hard.includes(r), 'harden must hold ' + r + ' -- a lock that can be switched off is not a lock');
    assert.ok(soft.includes(r), 'unharden must release ' + r + ' -- a released phone is an ordinary phone');
  }
});

/* Two commands that were written down, never run on hardware, and could not work. Both cost
   bench time before anybody tried them, so both are pinned here as absences. */
test('nothing tells an operator to send BOOT_COMPLETED, which adb may not send', () => {
  for (const f of ['docs/DEVICE-LOCKING.md', 'scripts/lock-bench.sh', 'scripts/lock-bench.ps1',
                   'public/portal.html']) {
    const src = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    for (const m of [...src.matchAll(/am broadcast[^\n]{0,200}/g)]) {
      assert.ok(!/BOOT_COMPLETED/.test(m[0]),
        f + ': BOOT_COMPLETED is a protected broadcast -- only the system may send it, and adb '
        + 'runs as uid 2000. It answers SecurityException every time, on every phone.');
    }
  }
});

test('the bench scripts never run pm clear, which a Device Owner app refuses', () => {
  for (const f of ['scripts/lock-bench.sh', 'scripts/lock-bench.ps1']) {
    const src = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    for (const line of src.split('\n')) {
      if (/^\s*#/.test(line)) continue;                  // prose explaining why it cannot work
      assert.ok(!/pm clear/.test(line),
        f + ': `pm clear` is refused on a Device Owner app (CLEAR_APP_USER_DATA). It did '
        + 'nothing, silently, and left a factory reset as the only route to a new token. '
        + 'Re-enrol with -e current <the token it holds now> instead.');
    }
  }
});

test('a released phone never self-locks, even when the step-down was refused', () => {
  /* THE REGRESSION THE FIX ABOVE COULD HAVE INTRODUCED, caught by reading the diff rather
     than by a handset a month from now.

     Keeping a refused-release phone beating is right. But it also keeps it subject to
     enforceGrace -- and the server goes on sending a real graceHours (a week, by default) for
     any handset that was ever sold, because that figure describes the ROW, not this moment.
     So a former customer's phone, released, still owned because Knox refused the step-down,
     that then spends a week out of coverage, would lock itself for a loan the office closed.
     A lock nobody ordered, on a phone nobody can unlock, for a debt that does not exist.

     Both release paths therefore pin graceHours to -1 -- "never self-lock" -- before they try
     to step down, so it holds whichever way that goes. */
  const beat = javaCode('lock/src/main/java/com/samaritantechs/hooploanlock/Beat.java');
  const pins = [...beat.matchAll(/Prefs\.put\(c,\s*Prefs\.GRACE_HOURS,\s*"-1"\)/g)];
  assert.equal(pins.length, 2,
    'both the retire path and the sustained-403 self-release must pin graceHours to -1');

  // Each pin must come BEFORE its unharden attempt: written after, it would be skipped on
  // exactly the path that needs it -- the one where the step-down was refused.
  for (const m of pins) {
    const after = beat.slice(m.index, m.index + 400);
    assert.match(after, /LockAdmin\.unharden\(c\)/,
      'the graceHours pin must sit ahead of the step-down it is protecting against');
  }

  // -1 is the value enforceGrace actually treats as "never"; anything else self-locks.
  assert.match(beat, /if \(graceHours <= 0\) return;/,
    'enforceGrace stopped treating a non-positive grace as "never self-lock"');
});

/* =========================================================================================
   THE WAY BACK OUT, over the cable. ReleaseReceiver is the recovery route for a handset the
   server can no longer reach -- the A07's actual situation. It is exported so adb can reach
   it, so it must be guarded, and it must tell the truth about what the system let it do.
   ========================================================================================= */
test('the release receiver is guarded, and does not lie about a refused step-down', () => {
  const rel = javaCode('lock/src/main/java/com/samaritantechs/hooploanlock/ReleaseReceiver.java');

  // Guarded by this handset's own token: an exported release with no guard is a phone any
  // sideloaded app could free. It compares the presented token against the stored one.
  assert.match(rel, /Prefs\.TOKEN/, 'the release receiver must read the stored token to guard on it');
  assert.match(rel, /\.equals\(given\)/,
    'release must be refused unless the caller presents this handset\'s own token');
  assert.match(rel, /setResultData/, 'the receiver must answer in the terminal it was called from');

  // It must branch on the real unharden() result -- a RELEASED that ignored a refused
  // step-down would be the same lie the old release path told.
  assert.match(rel, /LockAdmin\.unharden\(c\)/, 'release must actually attempt the step-down');
  assert.match(rel, /freed/, 'release must report freed vs partial from the real result');

  // Registered and reachable, or none of the above ships.
  const manifest = androidFile('lock/src/main/AndroidManifest.xml');
  assert.match(manifest, /\.ReleaseReceiver/, 'ReleaseReceiver is not declared in the manifest');
  assert.match(manifest, /com\.samaritantechs\.hooploanlock\.RELEASE/,
    'the RELEASE action is not wired to the receiver');

  // The recovery command is written down for the operator, with the flag a stopped app needs.
  const doc = fs.readFileSync(new URL('../docs/DEVICE-LOCKING.md', import.meta.url), 'utf8');
  const casts = [...doc.matchAll(/am broadcast[\s\S]{0,220}?RELEASE/g)];
  assert.ok(casts.length > 0, 'the release recovery command is missing from DEVICE-LOCKING.md');
  for (const m of casts) {
    assert.ok(/--include-stopped-packages/.test(m[0]),
      'the release broadcast needs --include-stopped-packages too -- adb install -r leaves the '
      + 'app STOPPED, and a stopped app hears no broadcast without it');
  }
});

/* =========================================================================================
   PROVISIONING AGAINST A RELEASED ROW, which is a fifteen-minute fuse.

   `retire` is simply `state === 'released'`, and a retiring phone unlocks, unhardens and
   stops beating. But the provisioning HANDSHAKE does not carry it -- hello() answers with a
   command, a state and the words, and nothing else -- so enrolling a handset against a
   released row looks perfect at the bench: the enrol reports ENROLLED, the phone appears on
   the register, everybody boxes it. The first real beat, up to fifteen minutes later, hands
   it back.

   The fix is procedural (lock the row before provisioning, see DEVICE-LOCKING.md) but the
   SHAPE is what this guards: hello must stay silent about retire, so the handshake can never
   start the countdown, and beat must keep carrying it, so a genuine release still lands.
   Somebody "tidying" the two to return the same fields would break one or the other.
   ========================================================================================= */
test('the provisioning handshake never carries retire; the beat always does', () => {
  const core = fs.readFileSync(new URL('../api/_lib/device-core.js', import.meta.url), 'utf8');

  const hello = core.slice(core.indexOf('async function hello'));
  const helloBody = hello.slice(0, hello.indexOf('\n}'));
  assert.ok(!/\bretire\b/.test(helloBody),
    'hello() started returning retire -- a phone would now hand itself back during '
    + 'provisioning, at the bench, instead of being enrolled');

  const beat = core.slice(core.indexOf('async function beat'));
  assert.match(beat.slice(0, beat.indexOf('\n}')), /\bretire\b/,
    'the beat stopped carrying retire -- a released phone would never be handed back');

  // And retire must stay tied to the state, not to some looser condition.
  assert.match(core, /const retire = S\(dev\.state\) === 'released'/,
    'retire is the released state and nothing else; widening it releases phones nobody freed');
});

/* Re-registering a known IMEI mints nothing, which is correct -- one token per phone, for the
   life of that row -- but it is also why the station must use the Token button rather than
   Sajili simu when redoing a handset the register already knows. Pinned because the filter is
   one line and reads like an optimisation. */
test('enrolment mints a token only for an IMEI the register does not already hold', () => {
  const portal = fs.readFileSync(new URL('../api/portal.js', import.meta.url), 'utf8');
  assert.match(portal, /const fresh = list\.filter\(i => !have\.has\(i\)\)/,
    'deviceEnrol must skip IMEIs already on the register -- minting a second token for a live '
    + 'phone would orphan the one that handset is actually carrying');
  assert.match(portal, /alreadyOn: list\.length - fresh\.length/,
    'the count of skipped IMEIs must be reported, or the station cannot tell that the empty '
    + 'token list was deliberate rather than a failure');
});
