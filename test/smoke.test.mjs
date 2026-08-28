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
