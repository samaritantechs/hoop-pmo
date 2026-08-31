/* =======================================================================================
   THE CHECK THAT WOULD HAVE CAUGHT IT.

   The Devices pane shipped with four buttons that did nothing at all. Every one of them
   called drawer(); nothing in the file ever defined it. Parsing the script -- which is what
   was being done before, via new Function(src) -- says the file is valid JavaScript, and it
   is: a call to an unbound name is legal until the line actually runs. So the enrolment form
   threw ReferenceError the first time somebody pressed it, and nowhere else.

   WHY THIS IS NARROW, deliberately. The first cut tried to discover EVERY call site by
   regex and diff them against every declaration. Getting that right means tokenising
   JavaScript -- string literals, template literals, regex literals, character classes with
   quotes in them (esc() has one) -- and each near-miss reported a dozen functions that
   plainly exist. A test that cries wolf gets switched off, which would leave the real bug
   uncaught for the second time.

   So it asks a smaller question it can answer exactly. Searching for a definition of a name
   you already know is reliable; discovering the names is what was not. Two rules:

     1. Every handler named in an inline HTML attribute -- onclick="closeDrawer()" -- must be
        defined. These are the highest-risk references in the file because they live inside
        strings, where no parser and no linter will ever look at them.
     2. If a page uses one of the shared shell helpers, it must define it. That is the
        drawer() case exactly.
   ======================================================================================= */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const PAGES = ['portal.html', 'call.html', 'upload.html', 'index.html']
  .filter(f => fs.existsSync(new URL('../public/' + f, import.meta.url)));

/** The helpers a page is expected to own if it leans on them at all. */
const SHELL = ['drawer', 'closeDrawer', 'toast', 'srv', 'esc', 'money', 'busy',
  'buildNav', 'goTab', 'navSet', 'applyLang', 'applyTheme', 'tipShow', 'tipsStart',
  'bellRefresh', 'bellOpen', 'paneFailed'];

const read = f => fs.readFileSync(new URL('../public/' + f, import.meta.url), 'utf8');

/** Does this page bind `name`, by any of the forms these files actually use? */
function defines(src, name) {
  const n = name.replace(/[$]/g, '\\$');
  return new RegExp(
    '(?:function\\s+' + n + '\\s*\\(' +          // function foo(
    '|(?:var|let|const)\\s+' + n + '\\b' +       // var foo = function(){}
    '|\\b' + n + '\\s*=\\s*function' +           // foo = function(){}
    '|\\b' + n + '\\s*=\\s*\\()'                 // foo = (a) => {}
  ).test(src);
}

/* =======================================================================================
   THE SHELL'S TWO LOAD-BEARING RULES.

   Reported from a desk: "I now have to scroll the whole page's content to find the left
   panel's bottom options." Both causes were invisible without a browser, and both are the
   kind of thing that gets deleted later by somebody tidying up:

     1. A percentage height is resolved against the PARENT's height. #scrApp had none, so
        the chain from <body> broke there and the shell fell back to its content's height.
        Viewport units cut the chain out; dvh so a phone's address bar is accounted for.
     2. A flex item's default min-height is `auto` -- "never shrink below your content" --
        so `flex:1` with `overflow:auto` grows instead of scrolling, and pushes whatever
        follows it out of view. min-height:0 is what makes it a scrolling box.
   ======================================================================================= */
test('portal.html: the shell takes its height from the window, not from its contents', () => {
  const css = read('portal.html');
  assert.match(css, /#scrApp\{[^}]*height:100dvh/,
    'the app wrapper must be sized in viewport units -- a percentage chain breaks here');
  assert.match(css, /#scrApp\{[^}]*height:100vh/,
    'and keep the vh fallback for the older WebViews this runs in');
});

test('portal.html: every scrolling flex pane can actually shrink', () => {
  const css = read('portal.html');
  for (const sel of ['\\.tabs', '\\.body']) {
    const m = css.match(new RegExp('(^|\\n)' + sel + '\\{[^}]*\\}', 'm'));
    assert.ok(m, `${sel} rule not found`);
    assert.match(m[0], /min-height:0/,
      `${sel} scrolls, so it needs min-height:0 -- without it the flex item grows and `
      + 'carries the sidebar foot off the screen');
    assert.match(m[0], /overflow(-y)?:auto/, `${sel} is meant to be the thing that scrolls`);
  }
});

test('portal.html: the dashboard sales card compares money with money', () => {
  /* It compared a HANDSET COUNT against a TZS TARGET. weekTarget is SALES_DAILY_TARGET x 7
     in shillings; `count` is a number of phones. Fourteen sold against a 21,000,000 target
     rendered as "20,999,986 pungufu" and painted red every week no matter what the team
     did -- a tile that is always wrong in the same direction is worse than no tile, because
     people learn to ignore it and then ignore it on the week it matters.

     Pinned as source text because there is no browser here to render the card in. */
  const css = read('portal.html');
  const fn = css.match(/function drawDashSales\(\)\{[\s\S]*?\n\}/);
  assert.ok(fn, 'drawDashSales not found');
  assert.match(fn[0], /var over\s*=\s*tgt\s*\?\s*\(\s*amt\s*-\s*tgt\s*\)/,
    'the target delta must be amount minus target -- never the handset count');
  assert.doesNotMatch(fn[0], /\(\s*n\s*-\s*tgt\s*\)/,
    'comparing count to a shilling target is the bug this test exists for');
});

/* =======================================================================================
   THE CUSTOMER PANEL IS A DRAWER.

     "Clicking customer should open their panel as hopeloan does. not scroll to bottom"

   It used to render into a #custDetail div below the table and scrollIntoView its way down,
   so on a long deck the row you clicked scrolled off the top while the panel arrived at the
   bottom. The regression that matters is somebody reinstating an inline container: that
   would read as harmless in a diff and put the scrolling straight back.
   ======================================================================================= */
test('portal.html: the customer panel opens over the page, not below the table', () => {
  const src = read('portal.html');
  assert.ok(/function openCust\(c\)\{[\s\S]*?drawer\(/.test(src),
    'openCust must render through drawer() -- an inline card is what caused the scrolling');
  assert.doesNotMatch(src, /id="custDetail"/,
    'the inline detail container is gone; reinstating it brings the scroll back');
  assert.doesNotMatch(src, /\$\('#custCard'\)|closest\('#custCard'\)/,
    'and so is every hook that existed only to chase that inline card around the page');
});

test('portal.html: a fixed panel is resized for the keyboard', () => {
  /* position:fixed does not shrink to the visual viewport by itself on every Android
     WebView, and a comment can ONLY be written from the app -- so the screen this matters
     on is the only screen it is used on. */
  const src = read('portal.html');
  assert.match(src, /function fitPanelToKeyboard_/);
  assert.ok(/function drawer\(html\)\{[\s\S]*?fitPanelToKeyboard_\('drawerBg'\)/.test(src),
    'opening a drawer must fit it to the visible area');
  assert.ok(/function closeDrawer\(\)\{[\s\S]*?style\.height=''/.test(src),
    'and closing must clear it, or the next drawer opens as a letterbox');
});

for (const page of PAGES) {
  const src = read(page);

  test(`${page}: every inline on*= handler is a real function`, () => {
    /* onclick="foo()" and friends. The browser resolves these against the global scope at
       click time; nothing before that moment checks them, which is what makes them worth
       a test of their own. */
    const missing = new Set();
    for (const m of src.matchAll(/\bon[a-z]+\s*=\s*"([^"]*)"/g)) {
      for (const c of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
        const name = c[1];
        // Method calls and platform names are somebody else's problem.
        if (/\.\s*$/.test(m[1].slice(0, c.index))) continue;
        if (['return', 'if', 'typeof', 'this', 'alert', 'confirm'].includes(name)) continue;
        if (!defines(src, name)) missing.add(name);
      }
    }
    assert.deepEqual([...missing], [],
      'named in an inline handler but never defined on this page');
  });

  test(`${page}: a shell helper it uses is a shell helper it defines`, () => {
    const missing = SHELL.filter(name => {
      // "Uses" means a bare call somewhere -- `name(` not preceded by a dot or a word char.
      const used = new RegExp('(^|[^.\\w$])' + name.replace(/[$]/g, '\\$') + '\\s*\\(').test(src);
      return used && !defines(src, name);
    });
    assert.deepEqual(missing, [],
      'called but never defined -- this is exactly the drawer() bug');
  });
}

/* =========================================================================================
   NO BARS INSIDE TABLE ROWS.

     "I intended to see graphs but the bars are killing it better use numbers within
      b/se the variance of the lenghts makes them ugly"

   Twice now the same defect has been built: a per-day bar drawn inside each cell of a
   per-person row, scaled against the busiest person of the week. One officer dealt 40 and
   another dealt 2 puts a full-height block beside a 3px stub on the same row, and the tall
   one is usually the WORSE day -- 1 of 2 recovered beats 12 of 40. Sales performance had it,
   the credit grid had it, and both are gone.

   The two week charts are NOT this and must stay: they are single-series SVG with a shared
   baseline, gridlines and an axis. Those are the graphs that were wanted. This guards the
   pattern, not the concept -- an inline pixel height computed per row.
   ========================================================================================= */
test('portal.html: no per-row inline bars, only the real week charts', () => {
  const src = read('portal.html');
  const html = src.replace(/<style[\s\S]*?<\/style>/g, ' ');
  // A height in px computed from a ratio, written into an inline style: the bar-in-a-cell.
  const inline = [...html.matchAll(/style="[^"]*height:'\s*\+/g)];
  assert.deepEqual(inline.map(m => m[0]), [],
    'a bar drawn inside a table cell is back -- use a tinted number cell instead');
  // ...while the two SVG week charts keep their bars, because those were never the problem.
  assert.match(src, /<rect x="'\+\(cx-bw\/2\)/,
    'the single-series week charts must keep their bars');
});

/* =========================================================================================
   THE SIGN-IN BOX HAS TO BE ABLE TO MOVE.

     "at login page it doesnt slide up to see whats beeing filled"

   fitPanelToKeyboard_ was already pointed at #scrIn and could not shift it, for two reasons
   that both lived in the one CSS line: a `min-height:100vh` that an inline height cannot
   shrink past, and `position:static`, on which `top` means nothing at all. Neither is
   visible in a diff as a bug -- they read as ordinary layout -- so they are pinned here.
   ========================================================================================= */
test('portal.html: the sign-in panel can be shrunk and moved by the keyboard fit', () => {
  const src = read('portal.html');
  const rule = src.match(/(^|\n)#scrIn\{[^}]*\}/m);
  assert.ok(rule, '#scrIn rule not found');
  assert.match(rule[0], /position:fixed/,
    '`top` is ignored on a static box, so half of fitPanelToKeyboard_ does nothing');
  assert.doesNotMatch(rule[0], /min-height:100(vh|dvh)/,
    'a stylesheet min-height outranks the inline height -- the panel cannot shrink for the keys');
  assert.match(rule[0], /overflow:auto/,
    'with the keyboard up the button must still be reachable');
  // Both halves, or neither works: the height that shrinks and the min-height that permits it.
  const fit = src.match(/function fitPanelToKeyboard_\(id\)\{[\s\S]*?\n\}/);
  assert.ok(fit, 'fitPanelToKeyboard_ not found');
  assert.match(fit[0], /style\.minHeight\s*=\s*vv\.height/,
    'setting height without minHeight leaves the panel exactly as tall as it was');
});

/* =========================================================================================
   THE DASHBOARD STANDS ON ONE WEEK.

     "the date forward and backward is not for credit but the whole dashboard holded
      DTA preview as hopeloan"

   The control began inside the Credit card and moved only the two recovery charts, so the
   board could show last week's recovery beside this week's sales and today's stock -- four
   cards disagreeing about what day it is, with nothing on screen admitting it. HOPE settled
   this: one bar at the head, every card drawn for it.

   The regression that matters is a card added later that forgets to take the week, which is
   why every draw goes through ONE function and this checks that function rather than the
   call sites.
   ========================================================================================= */
test('portal.html: one week governs every card on the dashboard', () => {
  const src = read('portal.html');
  const fn = src.match(/function dashWeekRedraw\(\)\{[\s\S]*?\n\}/);
  assert.ok(fn, 'dashWeekRedraw not found -- the single redraw path is the whole design');
  for (const card of ['drawTrend', 'drawCreditRecovery', 'drawRecoveryTrend',
                      'drawDashSales', 'drawDashStock']) {
    assert.match(fn[0], new RegExp('\\b' + card + '\\('),
      `${card} is not redrawn when the week changes -- it will show a different week`);
  }
  // The bar itself must be at the head of the board, not inside a card it appears to belong to.
  assert.match(src, /id="dashWeekBar"[\s\S]{0,400}?<div class="tiles">/,
    'the week bar must sit above the tiles, or it reads as belonging to whatever is beside it');
  // And the two cards that used to ignore it must now ask for it.
  assert.match(src, /srv\('salesWeek',\{week:RECWEEK\}\)/,
    'the sales card must ask for the week the board is standing on');
  assert.match(src, /srv\('stockAccount', RECWEEK\?\{asOf:/,
    'the stock card must ask for the book as it stood at the end of that week');
});

test('portal.html: a Swahili day axis names seven different days', () => {
  /* Jumapili, Jumatatu, Jumanne and Jumatano ALL begin "Jum", so slicing the names to three
     letters produced a week reading Jum · Jum · Jum · Jum · Alh · Iju · Jum. Four distinct
     days under one label is not a shorter axis, it is no axis -- and it looked perfectly
     fine in the source. Caught by rendering the page, not by reading it. */
  const src = read('portal.html');
  assert.doesNotMatch(src, /\['Jumapili'[^\]]*\][^;]*\.slice\(0,\s*3\)/,
    'slicing Swahili day names to three letters collapses four days onto "Jum"');
  const fn = src.match(/function salesWeekChart_\(d\)\{[\s\S]*?\n\}/);
  assert.ok(fn, 'salesWeekChart_ not found');
  const days = fn[0].match(/\['Jpi','Jtt','Jnn','Jtn','Alh','Iju','Jms'\]/);
  assert.ok(days, 'the sales axis must use the same distinct abbreviations as the credit grid');
});

test('portal.html: no assignment concatenates a string onto a unary plus', () => {
  /* `b.innerHTML=\n  +'<div>...'` is valid JavaScript and means +("<div>...") -- NaN, printed
     into the card. It happened here by deleting the first term of a concatenation and leaving
     the `+` that joined it, which is the most ordinary edit there is. Nothing catches it: it
     parses, it lints, and the page renders the word NaN where the content should be. */
  for (const page of PAGES) {
    const src = read(page);
    const bad = [...src.matchAll(/=\s*\n\s*\+\s*['"`]/g)];
    assert.deepEqual(bad.map(m => m[0].replace(/\s+/g, ' ')), [],
      `${page}: an assignment whose right-hand side starts with + and a string is NaN, `
      + 'not concatenation -- the leading term was deleted and its + left behind');
  }
});

/* =========================================================================================
   EVERY TILE IS A DOOR.
     "the widgets in dashboard, sales and stock; in recovery; fraud audit; all stock;
      devices: - should be clickable to open the description/link to their specified
      data lists"

   Forty headline numbers across nine panes, each of which now opens the rows behind it. The
   two ways this quietly breaks are worth a test each: a tile built the old way (a raw
   `<div class="tile">`), which loses its door without looking wrong; and a pane whose
   innerHTML contains tiles but never calls wireTiles, which renders the "fungua ›" line and
   then does nothing at all when it is tapped. The second is the worse of the two -- it
   advertises a door that is not there.
   ========================================================================================= */
test('portal.html: no tile is built by hand any more', () => {
  const src = read('portal.html');
  const raw = [...src.matchAll(/<div class="tile"/g)];
  assert.equal(raw.length, 0,
    'a hand-built tile has no door and no keyboard handling -- build it with tile()');
});

test('portal.html: every pane that draws tiles also wires them', () => {
  const src = read('portal.html');
  /* Each drawing function, sliced at the next top-level `function` -- a pane that calls
     tile() and never wireTiles has painted a button that does nothing. */
  const fns = src.split(/\nfunction /).slice(1);
  const missing = fns
    .filter(f => /\btile\(/.test(f) && !/wireTiles\(/.test(f))
    // The helper itself and the sorters it calls are not panes.
    .filter(f => !/^(tile|wireTiles|goWith)\b/.test(f))
    .map(f => f.slice(0, f.indexOf('(')));
  assert.deepEqual(missing, [], 'these draw tiles but never call wireTiles');
});

test('portal.html: a tile that leaves its pane sets the destination filter first', () => {
  /* goWith(tab, set) exists so "Locked 7+" lands on the sinking customers rather than on
     Recovery's default view. A bare goTab from a tile is not wrong -- three tiles legitimately
     just open Mauzo -- but the ones that carry a slice must set it BEFORE navigating, or the
     pane draws once with the old filter and the click reads as having done nothing. */
  const src = read('portal.html');
  const bad = [...src.matchAll(/goWith\('[a-z]+',\s*function\(\)\{\s*\}\)/g)];
  assert.deepEqual(bad.map(m => m[0]), [], 'goWith with an empty setter should just be goTab');
});

/* =========================================================================================
   SELECT-ALL MUST NEVER REACH A ROW THAT IS NOT ON SCREEN.

     "Add Bulk Tick checkbox on the first column before imei that selects all list"

   The column funnels hide rows without unticking them. So a select-all written the obvious
   way -- every .dvck on the page -- arms Funga against phones nobody can see: filter Devices
   to one branch, tick all, press Funga, and the other branches' handsets go dark too. Each
   of those is a customer holding a phone that stopped working for a reason nobody at HOOP
   can explain, because nobody at HOOP intended it.

   `$all('.dvck')` is the shorter expression and the wrong one, which is exactly why this is
   pinned: it is the edit a later reader makes while tidying.
   ========================================================================================= */
test('Devices select-all and bulk actions only ever touch visible rows', () => {
  const src = fs.readFileSync(new URL('../public/portal.html', import.meta.url), 'utf8');

  // The visibility filter must exist and must test BOTH ways a row gets hidden.
  const fn = src.slice(src.indexOf('function devVisibleTicks_'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /style\.display!=='none'/, 'a row hidden by a search box is still hidden');
  assert.match(body, /classList\.contains\('fhide'\)/, 'a row hidden by a column funnel is still hidden');

  // And the bulk action must read through it, never straight off the class.
  const picked = src.slice(src.indexOf('function devPicked'));
  assert.match(picked.slice(0, picked.indexOf('\n')), /devVisibleTicks_\(\)/,
    'devPicked must go through the visible-rows filter -- $all(\'.dvck\') would let a bulk '
    + 'Funga reach phones the operator cannot see on screen');
});

/* The export drops controls rather than guessing at their text: a tick box exports as an
   empty column and an action cell as "Token Historia Futa". Marking the cell is the honest
   way -- a column that legitimately contained the word "Futa" could not be told apart. */
test('the Excel export drops control cells, and Devices marks them', () => {
  const src = fs.readFileSync(new URL('../public/portal.html', import.meta.url), 'utf8');
  assert.match(src, /filter\(function\(td\)\{\s*return !td\.classList\.contains\('noxl'\)/,
    'csvOfTable_ stopped dropping control cells; exports regain a blank column and a column '
    + 'of button labels');
  // Both ends of that contract: the header cells and the body cells of the Devices table.
  assert.match(src, /<th class="noxl"><input type="checkbox" id="dvAll"/,
    'the select-all header cell must be marked noxl, or it exports as a stray empty column');
  assert.match(src, /<td class="noxl"><input type="checkbox" class="dvck"/,
    'the row tick cell must be marked noxl');
  assert.match(src, /<td class="r noxl">/, 'the Token/Historia/Futa cell must be marked noxl');
});

/* =========================================================================================
   THE COMMAND THE STATION ACTUALLY PASTES.

     "the copying cmd from clipboard in system at device should be the single command to
      configure phone"

   The docs were fixed three times over for exactly three faults; the portal -- which is the
   copy Sipho actually uses -- still carried all three, because a fix applied to prose does
   not travel to code. Every one of them cost real bench time:

     `\` continuations   bash. In cmd.exe the first line runs truncated and the rest arrive
                         as broken commands. Reported verbatim: "failed to stat", then an
                         Invalid component stack trace.
     `adb install` bare  no -r, so a handset that already has the app is refused outright.
     no --include-stopped-packages
                         the enrol silently does nothing on a freshly installed app while
                         printing result=0, which reads exactly like success. Twenty hours
                         of a real handset lost to that one.

   So the shape of this string is load-bearing, and it is pinned here rather than trusted to
   whoever edits it next.
   ========================================================================================= */
test('the provisioning command the portal hands out actually runs on a Windows bench', () => {
  const src = fs.readFileSync(new URL('../public/portal.html', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function devOneLiner'));
  const body = fn.slice(0, fn.indexOf('\n}'));

  // ONE command, chained -- the whole point of it.
  assert.match(body, /&&/, 'the one-liner must chain its steps, or it is not one command');
  assert.ok(!/\\\\n/.test(body), 'the single command must not contain newlines');

  // The three faults, each pinned by the thing that fixes it.
  assert.match(body, /adb install -r/, 'without -r a handset that already has the app is refused');
  assert.match(body, /--include-stopped-packages/,
    'without this the enrol silently does nothing and prints result=0 like a success');
  assert.ok(!/\\\\$|\s\\\\\s/.test(body),
    'a backslash continuation is bash; in cmd.exe it truncates the command');

  // Order is not optional: owner BEFORE enrol, or the receiver drops the token in silence.
  const owner = body.indexOf('set-device-owner');
  const enrol = body.indexOf('.ENROL');
  assert.ok(owner > 0 && enrol > owner, 'set-device-owner must come before the enrol broadcast');

  // An absolute path, because "adb install HOOPLOAN-Lock.apk" only works if the operator
  // happens to be standing in the right folder -- and reports "failed to stat" when not.
  assert.match(body, /%USERPROFILE%/, 'the APK path must not depend on the current directory');

  /* THE ENROL MUST NOT BE CHAINED BEHIND THE OWNER STEP.
     ---------------------------------------------------------------------------------------
       "token copying just have 3 cmd at once dont confuse me nor sipho"

     The screen used to carry the three commands separately as well, purely because `&&`
     stops at the first failure and the commonest stop here is not a failure: a phone being
     redone answers "device owner is already set", which is the finished state. Dropping that
     second box is only safe while `&` -- run regardless -- sits between owner and enrol, so
     that is pinned. Restore the `&&` and the operator is back to a phone that installed,
     printed something red, and never enrolled. */
  const between = body.slice(owner, enrol);
  assert.ok(!between.includes('&&'),
    'the enrol must not be chained behind set-device-owner: "already set" is the finished '
    + 'state of every phone being redone, and && would swallow the enrol');
  assert.match(between, /[^&]&[^&]/,
    'set-device-owner and the enrol must be joined by a single & so the enrol runs whatever '
    + 'the owner step said');

  // Exactly one command is offered, because two was the confusion being fixed.
  assert.ok(!/function devAdbLines/.test(src),
    'the multi-line variant is gone on purpose -- one box, one button, nothing to choose');

  /* AND NO ANGLE-BRACKET PLACEHOLDER ANYWHERE NEAR IT. In cmd.exe `<` and `>` are
     redirection: a pasted <TOKEN> does not read as "fill this in", it errors, and the
     operator gets a message about a file from a command about a phone. */
  assert.ok(!/devOneLiner\('<|devOneLiner\("</.test(src),
    'the bulk template must not use <TOKEN>: angle brackets are redirection in cmd.exe');
});

/** Lift one top-level function out of the page and run it for real. */
function lift(src, name, deps) {
  const at = src.indexOf('function ' + name + '(');
  assert.ok(at > 0, name + ' is not defined in portal.html any more');
  const body = src.slice(at, src.indexOf('\n}', at) + 2);
  return new Function((deps || '') + body + '\nreturn ' + name + ';')();
}

/* =========================================================================================
   THE CLOCK IS THE COLUMN, so it is tested as behaviour rather than as a shape.

     "you said you'll 00:00:00 for last pinged so as we see actual time"

   Two things can go wrong here and both are silent: a zero-padding slip turns 14:06:03 into
   14:6:3, and a same-day check that only compares the date-of-month calls last month's beat
   "today". Either one makes the column say the wrong time confidently, which is worse than
   the age it replaced.
   ========================================================================================= */
test('the last-pinged column shows a real clock, padded, and dates anything not today', () => {
  const src = fs.readFileSync(new URL('../public/portal.html', import.meta.url), 'utf8');
  const clock = lift(src, 'clock');

  assert.equal(clock(null), '', 'a phone that never spoke has no time to show');
  assert.equal(clock(0), '', 'epoch zero is "no timestamp", not 1970');

  // Today, single-digit everywhere: the padding case.
  const t = new Date(); t.setHours(4, 6, 3, 0);
  assert.equal(clock(t.getTime()), '04:06:03', 'every field is two digits or it is not a clock');

  const u = new Date(); u.setHours(14, 30, 59, 0);
  assert.equal(clock(u.getTime()), '14:30:59');

  /* A year ago TO THE DAY -- same date-of-month, same month, different year. A same-day
     check that forgot the year would print this as a bare time and quietly claim a phone
     that has been silent for a year spoke this afternoon. */
  const old = new Date(); old.setFullYear(old.getFullYear() - 1); old.setHours(9, 5, 7, 0);
  assert.match(clock(old.getTime()), /^\d\d\/\d\d 09:05:07$/,
    'anything but today must carry its date, or a year-old beat reads as this afternoon');
});

/* A cell that carries a sub-line is two facts; the export used to run them together into
   "14:06:314 dk", which Excel shows as a corrupt number rather than a time and an age. */
test('the Excel export keeps a cell and its sub-line apart', () => {
  const src = fs.readFileSync(new URL('../public/portal.html', import.meta.url), 'utf8');
  const cellText = lift(src, 'cellText_');
  const td = { childNodes: [
    { nodeType: 3, textContent: '14:06:31' },
    { nodeType: 1, nodeName: 'DIV', textContent: '4 dk' },
  ] };
  assert.equal(cellText(td), '14:06:31 4 dk');
  assert.equal(cellText({ childNodes: [{ nodeType: 3, textContent: '  spaced  out ' }] }),
    'spaced out', 'ordinary cells still collapse and trim exactly as before');
});

/* =========================================================================================
   EVERY NAVIGATION STILL WORKS -- checked as wiring rather than by opening each one.

     "making sure all functionallities are working in all existing navigations"

   A pane breaks in three silent ways, and none of them is a syntax error, so nothing else in
   this suite would notice:

     1. The page asks the server for a function the server does not have. srv() posts a name;
        an unknown name comes back as an error inside a pane that just says it could not load.
     2. A nav is granted in NAV_TABS but has no entry in the sidebar, so the permission can be
        ticked on a role and opens nothing -- or the reverse, a sidebar entry whose permission
        no role can ever be given.
     3. A sidebar entry whose tab key reaches draw() and matches nothing, leaving a blank pane.

   This runs over ALL of them at once, so a pane added next month is covered the day it lands.
   ========================================================================================= */
test('every pane the page can open is wired end to end', () => {
  const html = read('portal.html');
  const api = fs.readFileSync(new URL('../api/portal.js', import.meta.url), 'utf8');

  // 1. Every function the page calls must exist on the server.
  const called = [...new Set([...html.matchAll(/srv\(\s*'([A-Za-z0-9_]+)'/g)].map(m => m[1]))];
  const defined = new Set([...api.matchAll(/^ {2}async ([A-Za-z0-9_]+)\(/gm)].map(m => m[1]));
  assert.ok(called.length > 40, 'the srv() scan found almost nothing -- it has stopped matching');
  assert.deepEqual(called.filter(n => !defined.has(n)).sort(), [],
    'the page calls these and the server does not answer to them');

  // 2. Every grantable nav has a door, and every door has a grantable nav.
  const navTabs = (/const NAV_TABS = \[([^\]]+)\]/.exec(api) || [])[1]
    .split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean);
  assert.ok(navTabs.includes('advreq') && navTabs.includes('advappr') && navTabs.includes('advrep'),
    'the three advance panes must be grantable in Access codes, or the roles editor cannot '
    + 'offer them and the owner cannot hand advrep to HR');
  const entries = [...html.matchAll(/\{ g:'[a-z]+',\s*t:'([a-z]+)',\s*nav:'([a-z]+)'/g)]
    .map(m => ({ t: m[1], nav: m[2] }));
  const navsOnPage = new Set(entries.map(e => e.nav));
  assert.deepEqual(navTabs.filter(n => n !== 'dashboard' && !navsOnPage.has(n)), [],
    'these navs can be ticked on a role and open nothing');
  assert.deepEqual([...navsOnPage].filter(n => !navTabs.includes(n)), [],
    'these sidebar entries need a permission no role can ever be granted');

  // 3. Every sidebar entry reaches a draw function that is actually defined.
  const dispatch = html.slice(html.indexOf('function draw()'), html.indexOf('function draw()') + 2000);
  for (const e of entries) {
    const m = new RegExp("TAB==='" + e.t + "'\\) return (\\w+)\\(").exec(dispatch);
    assert.ok(m, 'the ' + e.t + ' tab is in the sidebar but draw() does nothing with it');
    assert.ok(defines(html, m[1]), 'draw() calls ' + m[1] + '(), which is not defined');
  }
});

/* =========================================================================================
   THE EXPORTS, AND THE PHONE.

     "export enabled of pdf and excel and downloading exports able to work in app in a phone too"

   Three separate things can go wrong here, and every one of them is silent on the handset --
   which is where these reports are actually read:

     1. An export that builds a blob: URL and points an <a download> at it. Inside the Android
        wrapper that is a dead end: the WebView hands blob: to DownloadManager, which does not
        understand the scheme, and the officer gets no file. Every export must go through
        saveFile_, which tries the native bridge first. A future pane reaching for an anchor of
        its own would reintroduce the bug for that one report only, which is exactly the kind
        of hole nobody finds by clicking around.

     2. A PDF that is not a PDF. It is written out by hand here -- no CDN, no library -- and the
        cross-reference table at the end is a list of byte offsets. One wrong offset and every
        reader refuses the whole file, so it is parsed back the way a reader parses it.

     3. A PDF that opens but is unreadable because the columns overlap. Character widths live
        inside the font, which is not shipped, so they are tabulated in the page; if that table
        is wrong the text runs into the next column and the sheet cannot be taken to a bank.
   ========================================================================================= */

/** The source text of one top-level function, for composing a runnable bundle. */
function srcOf(src, name) {
  const at = src.indexOf('function ' + name + '(');
  assert.ok(at > 0, name + ' is not defined in portal.html any more');
  return src.slice(at, src.indexOf('\n}', at) + 2) + '\n';
}

test('every export goes through saveFile_, which tries the phone bridge first', () => {
  const src = read('portal.html');
  const save = srcOf(src, 'saveFile_');

  assert.match(save, /window\.HoopLoan\s*\|\|\s*window\.HopeCalls/,
    'saveFile_ must look for the native bridge under both names -- the wrapper registers it '
    + 'twice while the HOPE-to-HOOP rename crosses over');
  assert.match(save, /saveBase64/,
    'the bridge method that writes into the phone Downloads folder must actually be called');
  assert.match(save, /indexOf\('ERR'\)===0/,
    'the bridge answers OK or ERR; a save that failed must say so rather than look successful');
  /* THE MIDDLE RUNG IS THE ONE THAT IS EASY TO DROP, and it covers most handsets in the field
     on any day an APK goes out: saveBase64 is newer than the app people already have, and
     without the share sheet those officers fall to the browser rung, which inside a WebView is
     a dead end -- so a report that exported last week would silently stop coming out. */
  assert.match(save, /navigator\.share/,
    'an older wrapper, with no saveBase64, must still get its file out through the share sheet');
  assert.match(save, /createObjectURL/,
    'and a plain browser, with no bridge at all, must still get its file');
  assert.ok(save.indexOf('saveBase64') < save.indexOf('navigator.share')
    && save.indexOf('navigator.share') < save.indexOf('createObjectURL'),
    'the three routes must be tried best-first: write to Downloads, then share, then download');

  /* THE GUARD THAT MATTERS: nowhere else may build a download of its own. */
  const rogue = src.split('\nfunction ').slice(1)
    .filter(f => /\.download\s*=|createObjectURL/.test(f))
    .map(f => f.slice(0, f.indexOf('(')))
    .filter(n => n !== 'saveFile_');
  assert.deepEqual(rogue, [],
    'these build their own download instead of calling saveFile_, so on a phone they hand the '
    + 'WebView a blob: URL it cannot save');
});

test('the PDF export writes a file a reader will actually accept', () => {
  const src = read('portal.html');
  const wm = /\nvar HELVW=[\s\S]*?;\n/.exec(src);
  assert.ok(wm, 'the Helvetica width table is gone; the PDF cannot place text without it');
  const deps = wm[0] + ['cellText_', 'pdfEsc_', 'pdfW_', 'pdfFit_'].map(n => srcOf(src, n)).join('');
  const pdfOfTable = lift(src, 'pdfOfTable_', deps);
  const pdfW = lift(src, 'pdfW_', wm[0]);

  /* THE WIDTH TABLE IS THE FONT'S OWN, not a rule of thumb. These are the published Helvetica
     values; W really is more than four times l, which is why no single average can work. */
  const AFM = { ' ': 278, W: 944, O: 778, M: 833, A: 667, l: 222, i: 222, m: 833, 0: 556 };
  for (const ch of Object.keys(AFM)) {
    assert.equal(Math.round(pdfW(ch, 1000, false)), AFM[ch],
      'the width table is wrong for ' + JSON.stringify(ch) + ', so columns will not line up');
  }

  // A fake table: wide headers, a long comment, enough rows to force several pages.
  const cls = list => ({ contains: c => list.indexOf(c) >= 0 });
  const td = (text, classes) => ({ classList: cls(classes || []), textContent: text,
    childNodes: [{ nodeType: 3, nodeName: '#text', textContent: text }] });
  const tr = (cells, head) => ({ style: {}, classList: cls([]), cells,
    parentNode: { nodeName: head ? 'THEAD' : 'TBODY' } });
  const HEAD = ['TIMESTAMP', 'STAFF ROLE', 'STAFF NAME', 'APPLICATION DATE', 'REQUESTED',
    'STATUS', 'APPROVAL', 'COMMENT', 'BANK/CARRIER NAME', 'ACCOUNTS NO.'];
  const RIGHT = [4, 6];
  const rows = [];
  for (let n = 0; n < 120; n++) {
    rows.push(['0' + (n % 9 + 1) + '/08/2026 09:1' + (n % 10), 'Credit officer',
      'A NAME THAT IS DELIBERATELY LONG', '2026-08-0' + (n % 9 + 1), '200,000',
      ['Requested', 'Approved', 'Rejected'][n % 3], n % 3 === 1 ? '100,000' : '—',
      'Hakuna fedha mwezi huu — omba tena mwezi ujao', 'M-Pesa', '07' + (10000000 + n)]);
  }
  const table = { tHead: {},
    rows: [tr(HEAD.map((h, i) => td(h, RIGHT.indexOf(i) >= 0 ? ['r'] : [])), true)]
      .concat(rows.map(r => tr(r.map((v, i) => td(v, RIGHT.indexOf(i) >= 0 ? ['r'] : []))))) };

  const s = Buffer.from(pdfOfTable(table, 'Ripoti ya advance')).toString('latin1');
  assert.ok(s.startsWith('%PDF-1.'), 'no PDF header');
  assert.ok(s.endsWith('%%EOF'), 'no end-of-file marker');

  /* PARSED THE WAY A READER PARSES IT: follow startxref to the table, then follow every offset
     in the table and check it lands exactly on the object it claims. This is the check that
     catches a stray multi-byte character, which shifts every offset after it by one and turns
     the whole file into something nothing will open. */
  const startxref = parseInt(s.slice(s.lastIndexOf('startxref') + 9).trim(), 10);
  assert.equal(s.slice(startxref, startxref + 4), 'xref', 'startxref does not point at the table');
  const xm = /xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(s.slice(startxref));
  assert.ok(xm, 'the cross-reference table is unparseable');
  const size = Number(xm[1]);
  // NOT trimmed: every entry legally ends in a space, twenty bytes each, and that is the format.
  const entries = xm[2].split('\n').filter(l => l.length);
  assert.equal(entries.length, size, 'the xref count disagrees with the entries under it');
  for (let n = 1; n < size; n++) {
    assert.match(entries[n], /^\d{10} \d{5} n $/, 'xref entry ' + n + ' is malformed');
    const off = parseInt(entries[n].slice(0, 10), 10);
    assert.equal(s.slice(off, off + (n + ' 0 obj').length), n + ' 0 obj',
      'object ' + n + ' is not where the xref says it is, so no reader will open this file');
  }
  assert.ok(s.indexOf('trailer\n<< /Size ' + size + ' /Root 1 0 R >>') > 0,
    'the trailer must agree with the xref and name the catalog');

  // A declared /Length that is not the real byte count truncates the page it belongs to.
  let streams = 0;
  for (const m of s.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    streams++;
    const from = m.index + m[0].length;
    assert.equal(s.indexOf('\nendstream', from) - from, Number(m[1]),
      'a content stream declares a length it does not have');
  }
  assert.ok(streams > 1, 'a 120-row table must run to more than one page');
  assert.equal((size - 1 - 4) / 2, streams, 'every page needs exactly one content stream');

  for (const m of s.matchAll(/(\d+) 0 R/g)) {
    assert.ok(Number(m[1]) >= 1 && Number(m[1]) < size, 'dangling reference to object ' + m[1]);
  }

  /* THE GEOMETRY. Every line of text is re-measured and must sit inside the page and clear of
     the cell beside it. This is what a wrong width table looks like from the outside. */
  let lines = 0;
  for (const m of s.matchAll(/<< \/Length \d+ >>\nstream\n([\s\S]*?)\nendstream/g)) {
    const byY = new Map();
    for (const o of m[1].matchAll(/BT (\/F[12]) ([\d.]+) Tf ([\d.]+) ([\d.]+) Td \((.*?)\) Tj ET/g)) {
      if (!byY.has(o[4])) byY.set(o[4], []);
      byY.get(o[4]).push({ bold: o[1] === '/F2', size: Number(o[2]), x: Number(o[3]), t: o[5] });
    }
    for (const line of byY.values()) {
      lines++;
      line.sort((a, b) => a.x - b.x);
      line.forEach((c, i) => {
        const end = c.x + pdfW(c.t, c.size, c.bold);
        assert.ok(c.x >= 25.99 && end <= 816.01,
          '"' + c.t + '" runs off the page (' + c.x.toFixed(1) + '..' + end.toFixed(1) + ')');
        if (i + 1 < line.length) assert.ok(end <= line[i + 1].x + 0.01,
          '"' + c.t + '" overlaps the cell beside it, which is what an unreadable sheet is');
      });
    }
  }
  assert.ok(lines > 100, 'far too few lines of text for 120 rows -- rows are being dropped');

  // The header is reprinted on every page: page four of a bank run is useless without it.
  assert.equal([...s.matchAll(/\(BANK\/CARRIER NAME\)/g)].length, streams,
    'the column headers must be reprinted on every page');
});

test('the PDF never emits a byte the font has no glyph for', () => {
  const pdfEsc = lift(read('portal.html'), 'pdfEsc_');
  /* The em dash is the empty cell in every table in this file, so it is the one that would
     have shipped broken. WinAnsi has no code point for it; a bare '?' would be honest but
     ugly, so the handful that actually occur are mapped down to their plain equivalents. */
  assert.equal(pdfEsc('—'), '-', 'an em dash must become a hyphen, not a question mark');
  assert.equal(pdfEsc('‘a’'), "'a'", 'curly quotes must flatten');
  assert.equal(pdfEsc('中'), '?', 'a character with no glyph must not be emitted raw');
  // ( ) and backslash end a PDF string early; unescaped, they corrupt the page they land on.
  assert.equal(pdfEsc('a(b)c\\d'), 'a\\(b\\)c\\\\d');
  for (const ch of pdfEsc('—‘“…•中 M-Pesa')) {
    const c = ch.charCodeAt(0);
    assert.ok(c >= 32 && c <= 255 && !(c >= 127 && c < 160),
      'byte ' + c + ' is outside WinAnsi and would print as noise');
  }
});

/* =========================================================================================
   THE ADVANCE REPORT opens on the month it is about.

     "default start and end dates calenders defaulted to start and end of current month
      unless altered"

   Two empty date boxes are an unbounded query dressed up as a blank form: the pane loads every
   advance ever granted, and the total tile above the table then shows an all-time figure
   sitting exactly where a monthly one belongs. On the sheet somebody pays from.
   ========================================================================================= */
test('the advance report defaults to the current month, and says so in the filter boxes', () => {
  const src = read('portal.html');
  const monthRange = lift(src, 'monthRange_');
  const r = monthRange();
  const now = new Date();
  const p = n => (n < 10 ? '0' : '') + n;
  const mm = now.getFullYear() + '-' + p(now.getMonth() + 1);

  assert.equal(r.from, mm + '-01', 'the range must start on the first of this month');
  /* Day 0 of NEXT month is the last day of this one -- the only way to write it that is right
     in February, and right in a leap February. */
  assert.equal(r.to, mm + '-' + p(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()),
    'the range must end on the last day of this month, whatever length it is');

  /* RESOLVED PER DRAW, NOT AT SCRIPT LOAD. Seeding ADVR at load froze the range for the life
     of the tab, and these tabs stay open: somebody who left the portal open on the 31st and came
     back on the 1st was shown last month's rows labelled as this month, on the pane the payment
     run is built from. */
  assert.match(src, /if\(!ADVR\.from&&!ADVR\.to&&!ADVR\.explicit\)\{ var mr=monthRange_\(\);/,
    'drawAdvRep must resolve the month on every draw, or a long-lived tab shows a stale month');
  assert.match(src, /^var ADVR=\{from:'',to:'',status:''\};/m,
    'the module-level default must stay blank -- blank is the marker that means "fill me in"');
  assert.match(src, /explicit:true/,
    'an explicit date choice must be distinguishable from "not filled in yet", or the redraw '
    + 'helpfully puts this month back over the user\'s own selection');
  assert.match(src, /id="avrAll"/,
    'there must still be a deliberate way to ask for all dates -- the default is a default, '
    + 'not a cage');
});

/* "advance salaries report have status column of requested, approved or rejected too" --
   the owner's three words, which are not quite the approval queue's three. */
test('the advance report carries a status column in the owner three words', () => {
  const src = read('portal.html');
  const status = lift(src, 'advReportStatus');

  assert.match(status({ status: 'pending' }), />Requested</,
    'an undecided row is REQUESTED on this sheet: what the staff member did was ask');
  assert.match(status({ status: 'approved' }), />Approved</);
  assert.match(status({ status: 'declined' }), />Rejected</,
    'the owner said rejected, so the sheet says rejected');

  const rep = src.slice(src.indexOf('function drawAdvRep('));
  const head = /<th>TIMESTAMP<\/th>[\s\S]*?ACCOUNTS NO\.<\/th>/.exec(rep);
  assert.ok(head, 'the report header row has changed shape');
  assert.ok(head[0].indexOf('<th>STATUS</th>') > 0, 'the STATUS column is missing');
  /* BOTH FIGURES, NAMED AS FIGURES. "2 columns of requested amt and approved amt" -- an
     approver may grant less than was asked, and a reader who cannot see both numbers cannot
     tell that they did. STATUS sits between them because that is the order the three facts
     are read in: asked X, answer Y, therefore pay Z. */
  /* Matched as MARKUP, not as bare words: the comment above these headers names them too, and
     a bare indexOf finds the prose first and then reports the columns in the wrong order. */
  assert.ok(head[0].indexOf('>REQUESTED AMOUNT<') >= 0, 'the requested figure must be named as one');
  assert.ok(head[0].indexOf('>APPROVED AMOUNT<') >= 0, 'the approved figure must be named as one');
  assert.ok(head[0].indexOf('>REQUESTED AMOUNT<') < head[0].indexOf('>STATUS<')
    && head[0].indexOf('>STATUS<') < head[0].indexOf('>APPROVED AMOUNT<'),
    'STATUS belongs between the two figures');

  /* And APPROVAL is now a figure and nothing else. A row that is not approved shows a dash,
     never a zero: a zero in a payment column is an instruction to pay nothing, which is a
     different statement from "there is nothing to pay here yet". */
  assert.match(rep, /r\.status==='approved'\?money\(r\.approved\|\|0\):'—'/,
    'the approved column must show the figure or a dash, now that STATUS carries the word');
});

/* "approved at approval are default of requested but approver can alter so that the final
   report has this detail and use the approved column" -- the approver opens the drawer on the
   answer YES, at the full amount asked for. Approving in full is the common case and must cost
   one click; granting less is the deliberate act. */
test('the approval drawer opens at the requested amount and cannot go above it', () => {
  const src = read('portal.html');
  // money() only formats the label; which options exist and which is selected is the question.
  const options = lift(src, 'advAmountOptions', 'function money(n){ return String(n); }\n');
  const AMOUNTS = [50000, 100000, 150000, 200000];

  const onA200 = options(AMOUNTS, 200000, 200000);
  assert.equal((onA200.match(/<option/g) || []).length, 4, 'all four are offered on a 200k ask');
  assert.match(onA200, /<option value="200000" selected>/,
    'the drawer must open pre-set to the full amount requested');

  /* Capped at what was asked. More than requested is somebody mis-clicking a dropdown, and the
     server refuses it too -- this is so the option is never on screen to click. */
  const onA100 = options(AMOUNTS, 100000, 100000);
  assert.equal((onA100.match(/<option/g) || []).length, 2, 'a 100k ask offers only 50k and 100k');
  assert.ok(onA100.indexOf('200000') < 0 && onA100.indexOf('150000') < 0,
    'amounts above the request must not be offered at all');
  assert.match(onA100, /<option value="100000" selected>/);

  // The requester's own form has no default and no cap: they are choosing, not answering.
  const fresh = options(AMOUNTS, null, null);
  assert.equal((fresh.match(/<option/g) || []).length, 4);
  assert.ok(fresh.indexOf('selected') < 0, 'the request form must not pre-pick an amount');

  // And the drawer passes the requested amount in as both the selection and the ceiling.
  assert.match(src, /advAmountOptions\(amounts,r\.amount,r\.amount\)/,
    'the decide drawer must seed the dropdown from the requested amount, both ways');
});

/* "the leader button i need it visible as a column before the hariri and futa ones" -- the
   position is the request, so the position is what is pinned. */
test('the Kiongozi switch sits in the row, immediately before Hariri and Futa', () => {
  const src = read('portal.html');
  const head = /<tr><th>Code<\/th>[\s\S]{0,400}?<\/tr>/.exec(src);
  assert.ok(head, 'the access-codes header row has changed shape');
  const cols = [...head[0].matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map(m => m[1]);
  assert.deepEqual(cols, ['Code', 'Jina', 'Role', 'Timu', 'Tabs', 'Kiongozi', ''],
    'Kiongozi must be the last named column, just before the actions cell');

  const row = src.slice(src.indexOf("<tr><td class=\"code\">"));
  const lead = row.indexOf('data-lead="');
  const edit = row.indexOf('data-ed="');
  const del = row.indexOf('data-del="');
  assert.ok(lead > 0 && edit > 0 && del > 0, 'all three row controls must be present');
  assert.ok(lead < edit && edit < del,
    'the Kiongozi button must come before Hariri, which comes before Futa');

  // It is a switch, not a label: the face shows the state and one click flips it.
  assert.match(src, /srv\('accessCodeLeader',\{code:code,leader:!on\}\)/,
    'the button must post the OPPOSITE of what it currently shows');
  assert.match(src, /confirm\(on/,
    'it hands over the approval pane, so it confirms rather than firing on a stray tap');
  assert.match(src, /c\.leader===null/,
    'before the migration it must show a dash, not a button that cannot work');
});
