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
  assert.deepEqual(cols, ['Code', 'Jina', 'Role', 'Timu', 'Tabs', 'Kiongozi', 'Yupo?', ''],
    'Kiongozi and Yupo? are the named columns, both before the actions cell');

  const row = src.slice(src.indexOf("<tr><td class=\"code\">"));
  const lead = row.indexOf('data-lead="');
  const susp = row.indexOf('data-susp="');
  const edit = row.indexOf('data-ed="');
  const del = row.indexOf('data-del="');
  assert.ok(lead > 0 && susp > 0 && edit > 0 && del > 0, 'all four row controls must be present');
  assert.ok(lead < susp && susp < edit && edit < del,
    'Kiongozi, then Yupo?, both still before Hariri and Futa');

  // It is a switch, not a label: the face shows the state and one click flips it.
  assert.match(src, /srv\('accessCodeLeader',\{code:code,leader:!on\}\)/,
    'the button must post the OPPOSITE of what it currently shows');
  assert.match(src, /confirm\(on/,
    'it hands over the approval pane, so it confirms rather than firing on a stray tap');
  assert.match(src, /c\.leader===null/,
    'before the migration it must show a dash, not a button that cannot work');
});

/* "can update their passcodes at loginpage by iputing current one and double input new one" */
test('the sign-in screen can change a code, and cannot leave it authenticated as a guess', () => {
  const src = read('portal.html');
  for (const id of ['chgNow', 'chgNew', 'chgNew2', 'chgGo', 'chgCancel', 'inChg']) {
    assert.ok(src.includes('id="' + id + '"'), 'the change-code form is missing #' + id);
  }
  // Three password boxes: current, new, and new again. Never a visible one.
  const box = src.slice(src.indexOf('id="chgBox"'), src.indexOf('id="chgBox"') + 1400);
  assert.equal((box.match(/type="password"/g) || []).length, 3,
    'all three boxes must be masked -- this screen is used standing at a desk');

  const fn = src.slice(src.indexOf("$('#chgGo').onclick"), src.indexOf("$('#chgGo').onclick") + 1400);
  assert.match(fn, /srv\('changeMyCode',\{next:a,again:b\}\)/,
    'both new-code boxes go to the server: the match is re-checked where it counts');
  /* srv() sends whatever CODE holds, so the current code is set into it for this one call.
     A failure MUST put it back -- otherwise the sign-in box is left authenticating as
     something the person never typed, and the next thing they press fails confusingly. */
  assert.match(fn, /var was=CODE; CODE=now;/, 'the current code is used as the credential');
  assert.match(fn, /CODE=was;/, 'and restored when the change is refused');
  assert.match(fn, /CODE='';/, 'and cleared on success, so nothing signs in on a dead code');
});

/* "my concern was getting a multi-device token cmd to go and run in cmd-like am copying one
   when i add one device just before doing anything else" */
test('bulk enrolment gives one button per phone, each carrying that phone\'s own token', () => {
  const src = read('portal.html');
  const fn = src.slice(src.indexOf('function devProvision('),
                       src.indexOf('function devProvision(') + 9000);

  assert.match(fn, /data-dvcopy="'\+i\+'"/, 'every phone needs its own copy button');
  assert.match(fn, /esc\(x\.imei\)/, 'and the row must name the handset it belongs to');
  assert.match(fn, /\(i\+1\)\+'\/'\+p\.length/, 'numbered, so a long batch keeps its place');

  const handler = src.slice(src.indexOf("$all('[data-dvcopy]')"),
                            src.indexOf("$all('[data-dvcopy]')") + 900);
  /* BUILT FROM THE SAME devOneLiner AS THE BLOCK ABOVE. Two places composing the same adb
     command independently is two places that can drift, and a drifted enrol command writes
     the wrong identity into a handset. */
  assert.match(handler, /devOneLiner\(x\.token\)/,
    'the per-row copy must build its command the same way the block does');
  assert.ok(!/PASTE|<TOKEN>|\bNEW\b/.test(handler),
    'no placeholder may ever reach a runnable line -- that mistake cost a handset once');
  assert.match(handler, /opacity='\.45'/, 'a copied row must show it is done');

  /* THE INVARIANT IS NOT "NO LOOP" -- IT IS "NO TOKEN IN A LOOP".
     Install and set-device-owner are identical on every handset, so devHubLine deliberately
     runs those across every phone on the hub. What must never be looped is the ENROL
     broadcast: it carries a token minted for ONE IMEI, and the server does not check a
     handset's reported IMEI against the token's row (api/_lib/device-core.js says why), so
     nothing downstream would catch a phone that received another phone's identity. Plug-in
     order would silently decide it, and the way back is a factory reset. */
  /* Asserted on what the function PRODUCES, not on its source: the command is built by
     concatenation, so the shape that matters only exists once it has been run. */
  const hub = lift(src, 'devHubLine',
    'var DEVCMP="com.samaritantechs.hooploanlock/.LockAdmin";'
    + 'var DEVPKG="com.samaritantechs.hooploanlock";'
    + 'var location={origin:"https://hoop-pmo.vercel.app"};')();
  assert.match(hub, /adb devices/, 'the hub command works from the connected-device list');
  assert.match(hub, /install -r/, 'it installs...');
  assert.match(hub, /set-device-owner/, '...and takes ownership, both identical on every phone');
  assert.match(hub, /"%b"=="device"/,
    'a handset still unauthorized or offline must be skipped, not half-provisioned');
  assert.ok(!/ && /.test(hub),
    'the steps join with a single & -- "already set" is the normal answer for a handset being '
    + 'redone, and && would treat that as a reason to stop');
  assert.ok(!/%%/.test(hub),
    'written to be PASTED into cmd, so single % -- %% is .bat syntax and would not expand');
  assert.ok(!/PASTE|<TOKEN>|<SERIAL>/.test(hub),
    'no placeholder may reach a runnable line');

  // And no OTHER loop anywhere may wrap the enrol broadcast.
  assert.ok(!/for \s*\/f[^\n]*ENROL|for %\w[^\n]*-e token/i.test(src),
    'nothing may enrol several phones in one paste');
});

/* =========================================================================================
   THREE THINGS THAT WOULD HAVE SHOWN ON A PROJECTOR.

     "am going to presentation ... if i get a breakage like before the service may not be
      received"

   Found by an adversarial sweep of the Devices pane. None of them is a crash; all three are
   the pane confidently showing something wrong, which in front of an audience is worse.
   ========================================================================================= */
test('a refusal the server wrote is shown, however long, and never as markup', () => {
  const src = read('portal.html');
  // safeErr logs a raw failure to the console when it hides one; give it a window.
  const safeErr = lift(src, 'safeErr', 'var window={console:{error:function(){}}};');

  /* 1. THE 639-CHARACTER REFUSAL. Pressing Futa on a released-but-still-beating handset
        produces the longest and most important sentence in this pane, and a bare length test
        replaced every word of it with "the server did not answer properly" -- a careful
        explanation rendered as a crash. srv() marks what the server ANSWERED; that is the
        thing to trust, not the length. */
  const long = 'Simu iliambiwa iachiwe lakini bado ni mali ya kampuni. '.repeat(12);
  assert.ok(long.length > 300, 'fixture must exceed the old cut-off');
  const answered = Object.assign(new Error(long), { answered: true });
  assert.equal(safeErr(answered), long, 'an answered refusal must survive intact');

  /* ...and the guard it replaced still works for what it was written for: an unexpected
     failure that dumped data into a message. */
  assert.match(safeErr(new Error('[{"code":"PGRST","detail":"' + 'x'.repeat(400) + '"}]')),
    /haukujibu vizuri|did not answer properly/, 'a data dump is still hidden');
  assert.match(safeErr(new Error('y'.repeat(400))),
    /haukujibu vizuri|did not answer properly/, 'an unanswered wall of text is still hidden');

  /* 2. MARKUP READ ALOUD. These strings reach the screen through textContent, so a <b> in one
        is not bold -- it is the four characters <b>. Two server refusals carry markup. */
  const withTags = Object.assign(
    new Error('Simu bado ipo chini ya udhibiti. Bonyeza <b>Achia</b> kwanza.'), { answered: true });
  assert.equal(safeErr(withTags), 'Simu bado ipo chini ya udhibiti. Bonyeza Achia kwanza.',
    'tags must be stripped at the one funnel every message passes through');
  assert.ok(!/[<>]/.test(safeErr(withTags)));

  // A short ordinary refusal is still passed straight through.
  assert.equal(safeErr(new Error('Weka IMEI.')), 'Weka IMEI.');
  assert.equal(safeErr(null), '');
});

test('the silent tile and the list it opens are the same arithmetic', () => {
  /* 3. `r.stale` on a row means "not reporting" and INCLUDES a phone that never spoke -- that
        is deliberate, tested, and what paints the clock red. The TILE counts something
        narrower on purpose (`stale && !neverSeen`) so the two tiles partition the fleet.
        Filtering on the bare flag drew a different set from the one the tile had counted, and
        the gap is widest in the state a demo is most likely to be in. */
  const src = read('portal.html');
  assert.match(src, /if\(DEV\.flag==='stale'\) return r\.stale===true && r\.neverSeen!==true;/,
    'the silent filter must exclude never-spoken phones, exactly as the tile does');

  // And the server still counts it that way, so the two cannot drift apart.
  const api = fs.readFileSync(new URL('../api/portal.js', import.meta.url), 'utf8');
  assert.match(api, /stale: count\(r => r\.stale && !r\.neverSeen\)/,
    'the tile count is the definition the filter above mirrors');
  assert.match(api, /stale: !seen \|\| \(now - seen\) > HOURS,/,
    'and the row flag keeps its own, broader meaning -- it is what colours the clock');
});

/* "Copy the commands", plural, was a trap: cmd runs a pasted block line by line against
   whatever single handset is plugged in. Line one enrols it, lines two onward are refused as
   ALREADY ENROLLED under a different token, and the phone in your hand ends up holding the
   FIRST row's identity -- whichever phone it actually is. The exact swap the batch design
   exists to make impossible, reachable by pressing the biggest button on the screen. */
test('no button ever offers every phone\'s token as one pasteable block', () => {
  const src = read('portal.html');
  const fn = src.slice(src.indexOf('function devProvision('),
                       src.indexOf('function devProvision(') + 9000);

  // The shared box and its button exist for ONE phone only, where one line is the whole job.
  assert.match(fn, /\+\(one\s*\n?\s*\? '<textarea id="dvAdb"/,
    'the joined-commands box must be single-phone only');
  assert.ok(!/one\?5:Math\.min\(14/.test(fn),
    'the multi-phone sizing of that box is gone with it');

  /* The multi-phone routes that remain are both safe: one command per phone, or one hub
     command that carries a batch and no token at all. */
  assert.match(fn, /data-dvcopy="'\+i\+'"/, 'per-phone copy buttons remain');
  assert.match(fn, /id="dvHubCopy"/, 'and the hub command remains');

  // cmd, not PowerShell: Windows Terminal defaults to PowerShell and this syntax dies there.
  assert.match(fn, /Fungua <b>cmd<\/b>/, 'the shell must be named, or the paste fails on parse');
  assert.match(fn, /not PowerShell/i);
});

/* =========================================================================================
   THE DEVICES PANE, RE-READ BEFORE THE PRESENTATION.
   Four things the screen said with confidence and got wrong. Each is asserted against the
   MARKUP or the CALL, never against a word that could equally appear in a comment near it --
   a regex that matches its own explanation is a test that passes after the fix is reverted.
   ========================================================================================= */

test('portal.html: the selection count survives a column funnel', () => {
  /* Ticks are scoped to visible rows on purpose -- you act on what you see -- so a funnel that
     hides a ticked row silently drops it from what Funga will touch. The tick handlers resync
     the count; the funnel is not a tick handler. "Zilizochaguliwa: 35" beside a button about
     to darken nine customers' phones is the one stale number this pane cannot afford. */
  const src = read('portal.html');
  const fn = src.slice(src.indexOf('function applyFlt_'), src.indexOf('function openFlt_'));
  assert.match(fn, /devSyncTicks_\(\)/,
    'applyFlt_ must resync the device tick count after it changes what is visible');
});

test('portal.html: the bulk device buttons go dead while the order is in the air', () => {
  const src = read('portal.html');
  const fn = src.slice(src.indexOf('function devSend_'), src.indexOf('function devDelete'));
  assert.match(fn, /devBusy_\(true\)/, 'disabled before the request goes out');
  assert.match(fn, /devBusy_\(false\)/, 'and released again on the failure path');
  const busy = src.slice(src.indexOf('function devBusy_'), src.indexOf('function devSend_'));
  assert.match(busy, /\[data-dvs\]/, 'it is the four bulk buttons that are held');
});

test('portal.html: Achia asks before it releases a handset for good', () => {
  /* Funga and Imepotea both stop to demand a reason. Achia -- which tells the phone to drop
     Device Owner and stop calling home, undoable only with a cable and the handset in hand --
     fired on the first click, on however many rows happened to be ticked. */
  const src = read('portal.html');
  const fn = src.slice(src.indexOf('function devSetState'), src.indexOf('/* THE ORDER, AND THE ONE'));
  assert.match(fn, /state===['"]released['"]\s*&&\s*!confirm\(/,
    'releasing takes a deliberate yes, like the other two one-way orders');
});

test('portal.html: a view-only code is not offered buttons the server will refuse', () => {
  /* deviceSetState, deviceEnrol, deviceToken and deviceDelete are all writes. A read-only code
     got every one of those buttons and discovered the 403 by pressing it. */
  const src = read('portal.html');
  const pane = src.slice(src.indexOf('function drawDevices'), src.indexOf('function devVisibleTicks_'));
  for (const marker of ['data-dvs="locked"', 'data-dvt=', 'data-dvd=', 'id="dvEnrol"']) {
    const at = pane.indexOf(marker);
    assert.ok(at > 0, marker + ' is drawn by this pane');
    assert.ok(/BOOT\.readOnly/.test(pane.slice(Math.max(0, at - 700), at)),
      marker + ' must be gated on BOOT.readOnly');
  }
  assert.match(pane, /data-dvh="/, 'Historia is a read and stays for everyone');
});

test('portal.html: a truncated register says so, instead of letting the tiles disagree', () => {
  /* deviceList sends the newest 500 rows and the count of ALL of them. The pane read `rows`
     and ignored `total`, so a fleet of 640 showed tiles adding to 640 above a table holding
     500, with nothing on screen to say which number was the truncated one. */
  const src = read('portal.html');
  assert.match(src, /function devMore_\(d\)\{[^]*?d\.total\s*>[^]*?rows\|\|\[\]\)\.length/,
    'the notice is decided by comparing what was sent with what there was');
  const pane = src.slice(src.indexOf('function drawDevices'), src.indexOf('function devVisibleTicks_'));
  assert.match(pane, /devMore_\(d\)/, 'and the pane actually asks');
});

test('portal.html: sorting reads the value, not the value with its subline stuck to it', () => {
  /* "Iliongea lini" is a clock with a grey age under it, so textContent ran them together as
     "14:3236h" and the column sorted on a leading 14. cellVal_ drops the .mut subline, which
     is already exactly what the funnel on that same header does -- so sort and filter now
     agree on what the column's values are. */
  const src = read('portal.html');
  const at = src.indexOf('EVERY TABLE SORTS ITSELF');
  const fn = src.slice(at, src.indexOf('THE EVERYTHING BOX', at));
  assert.match(fn, /cellVal_\(td\)/, 'the sort key is the column value, sublines removed');
  assert.ok(!/td\.textContent\.trim\(\)/.test(fn),
    'and never the raw cell text that welded the two together');
});

/* =========================================================================================
   PAINTING SPLIT OFF FROM FETCHING.
   Three of the five tiles are questions for the database; two are arithmetic on rows the
   browser already holds. Both kinds went through drawDevices, which blanks the pane and
   re-reads -- so clicking Kimya discarded a screen of rows and painted back the same bytes.
   ========================================================================================= */

test('portal.html: drawDevices fetches, devPaint_ draws, and only one of them calls the server', () => {
  const src = read('portal.html');
  const fetchFn = src.slice(src.indexOf('function drawDevices(m){'),
                            src.indexOf('/* PAINTING IS NOT FETCHING'));
  assert.match(fetchFn, /srv\('deviceList'/, 'the fetch half still reads the register');
  assert.match(fetchFn, /devPaint_\(m, d, Date\.now\(\)\)/,
    'and hands the answer, with the time it arrived, to the paint half');
  assert.match(fetchFn, /paneFailed\(m,e\)/, 'a failed read still reports as a failed pane');

  const paint = src.slice(src.indexOf('function devPaint_(m, d, at){'),
                          src.indexOf('function devVisibleTicks_'));
  assert.ok(paint.length > 3000, 'the paint half is the body that used to live in the .then');
  assert.ok(!/srv\(/.test(paint), 'drawing must never itself go to the server');
});

test('portal.html: a flag tile repaints, a state tile re-reads', () => {
  /* neverSeen and stale are stamped on rows already in hand, so narrowing to them is
     arithmetic. enrolled/locked/released change the QUERY, so they have to ask again. */
  const src = read('portal.html');
  const paint = src.slice(src.indexOf('function devPaint_(m, d, at){'),
                          src.indexOf('function devVisibleTicks_'));

  const flag = paint.slice(paint.indexOf('var byFlag='), paint.indexOf("var tiles='"));
  assert.match(flag, /devPaint_\(m, d, at\)/, 'the flag tiles repaint from rows already loaded');
  /* The one case that still must fetch: clearing a live state chip WIDENS what the server
     would send, and the extra rows are by definition not in hand. */
  assert.match(flag, /widening\s*=\s*DEV\.filter!==''/);
  assert.match(flag, /if\(widening\)\s*drawDevices\(m\)/);

  const state = paint.slice(paint.indexOf('var byState='), paint.indexOf('var byFlag='));
  assert.match(state, /drawDevices\(m\)/, 'a state tile changes the query, so it re-reads');
  assert.ok(!/devPaint_/.test(state), 'and must never satisfy itself from the old rows');
});

test('portal.html: the register says when it was read, and offers a way to read it again', () => {
  /* Repainting instead of fetching means the screen can be a moment behind. That is the
     right trade -- filtering a list is not the same act as refreshing it -- but only if the
     screen says so, which is the failure mode this pane has been fixed for twice. */
  const src = read('portal.html');
  const paint = src.slice(src.indexOf('function devPaint_(m, d, at){'),
                          src.indexOf('function devVisibleTicks_'));
  assert.match(paint, />Ilisomwa '\+esc\(clock\(at\)\)/, 'the read time is printed, from `at`');
  assert.match(paint, /id="dvRefresh"/, 'and there is a control that re-reads');
  assert.match(paint, /rf\.onclick=function\(\)\{ drawDevices\(m\); \}/,
    'which goes through the FETCH half, not the paint half');
});

/* =========================================================================================
   ONE PHONE, ON ITS OWN SCREEN.

     "when the list is getting high suffocates so put them on a button 'locking' on each row
      before the token button so that we deal with each imei on its interface"

   The four bulk buttons live at the FOOT of the table, which is right for a bench of twenty
   and wrong for a register of four hundred: to act on one handset you tick its row, scroll
   past everything to reach the buttons, then scroll back to check you ticked the right one.
   ========================================================================================= */

test('portal.html: every row carries a Kufunga button, before Token', () => {
  const src = read('portal.html');
  const pane = src.slice(src.indexOf('function devPaint_(m, d, at){'),
                         src.indexOf('function devVisibleTicks_'));
  const lock = pane.indexOf('data-dvlock="');
  const tok = pane.indexOf('data-dvt="');
  const hist = pane.indexOf('data-dvh="');
  const del = pane.indexOf('data-dvd="');
  assert.ok(lock > 0, 'the row opens a per-handset panel');
  assert.ok(lock < tok && tok < hist && hist < del,
    'Kufunga comes first, then Token, Historia, Futa -- the position is the request');
  // A write, so a view-only code is not offered it, exactly like Token and Futa.
  assert.ok(/BOOT\.readOnly/.test(pane.slice(Math.max(0, lock - 400), lock)),
    'gated on BOOT.readOnly');
});

test('portal.html: the per-row panel reuses the bulk path, it does not reimplement it', () => {
  /* The reason a lock demands, the sentence Achia must be answered with, and the override for
     a released handset that stopped listening are all safety. Safety kept in two copies is
     safety that will one day disagree with itself. */
  const src = read('portal.html');
  const one = src.slice(src.indexOf('function devLockOne(m, d, imei){'),
                        src.indexOf('function devSend_'));
  assert.ok(one.length > 500, 'the panel exists');
  assert.match(one, /devAct_\(m, \[imei\], b\.getAttribute\('data-dvs1'\)\)/,
    'it calls the shared door with a list of one');
  assert.ok(!/prompt\(/.test(one), 'it must not ask for the reason itself');
  assert.ok(!/confirm\(/.test(one), 'nor put up its own Achia sentence');
  assert.ok(!/srv\('deviceSetState'/.test(one), 'nor talk to the server directly');

  // And the shared door reports whether an order actually went, so a cancelled prompt leaves
  // the panel open on the phone the operator is still deciding about.
  const act = src.slice(src.indexOf('function devAct_(m, imeis, state){'),
                        src.indexOf('/* ONE PHONE, ON ITS OWN SCREEN'));
  assert.match(act, /return false;[\s\S]*return true;/,
    'devAct_ answers whether it dispatched');
  // Nested parens inside the call, so match across them rather than up to the first ')'.
  assert.match(one, /if\(devAct_[\s\S]{0,90}?closeDrawer\(\)/,
    'the panel closes only on a yes');
});

test('portal.html: the in-flight guard covers both sets of state buttons', () => {
  /* The bulk bar and the panel use different attributes on purpose -- two controls sharing one
     selector is how a disabled button turns up somewhere nobody pressed anything -- so the
     guard has to name both, or a double-click in the panel sends the order twice. */
  const src = read('portal.html');
  const busy = src.slice(src.indexOf('function devBusy_(on){'), src.indexOf('function devSend_'));
  assert.match(busy, /\[data-dvs\],\[data-dvs1\]/);
});

test('portal.html: the bulk bar survives -- this is a second way in, not a replacement', () => {
  /* A hub of twenty phones is still one tick-all and one press, and that is the flow the
     multi-enrol work exists to serve. */
  const src = read('portal.html');
  const pane = src.slice(src.indexOf('function devPaint_(m, d, at){'),
                         src.indexOf('function devVisibleTicks_'));
  for (const s of ['locked', 'enrolled', 'released', 'lost']) {
    assert.ok(pane.includes('data-dvs="' + s + '"'), 'the bulk ' + s + ' button is still there');
  }
  assert.match(pane, />Zilizochaguliwa: <span id="dvCount">/, 'and the count beside them');
});

test('portal.html: the four orders sit ABOVE the table, not under it', () => {
  /* "These buttons are so important but giving me headeche to find them on bottom ...
      put them on top of the table"

     They were at the foot because that is where a selection ENDS -- you tick down the rows and
     the buttons are waiting. True for twenty rows, false for four hundred: the operator ticks
     near the top and then scrolls the whole register to reach the thing that acts on it, with
     the tick out of sight the whole way. */
  const src = read('portal.html');
  const pane = src.slice(src.indexOf('function devPaint_(m, d, at){'),
                         src.indexOf('function devVisibleTicks_'));
  const actions = pane.indexOf('var actions=');
  const table = pane.indexOf('var table=rows.length');
  assert.ok(actions > 0 && table > actions, 'the bar is built before the table');
  /* The guarantee, not the literal: the orders are composed BEFORE the table. The alarm
     later took a place between them, which must not break this. */
  const compose = /\+tiles\+bar\+(\w+\+)*actions\+table\+/.exec(pane);
  assert.ok(compose, 'composed above it -- tiles, chips, the orders, then the register');

  // The count travels with them: that number belongs beside the button, not a scroll away.
  const bar = pane.slice(actions, table);
  assert.match(bar, />Zilizochaguliwa: <span id="dvCount">/);
  for (const s of ['locked', 'enrolled', 'released', 'lost']) {
    assert.ok(bar.includes('data-dvs="' + s + '"'), s + ' moved up with the rest');
  }
  assert.match(bar, /BOOT\.readOnly/, 'still not offered to a view-only code');
  // And nothing was left behind under the table.
  assert.ok(!pane.slice(table).includes('data-dvs="locked"'),
    'no second copy below the table');
});

test('portal.html: the pane shouts when a phone is ordered locked but never spoke', () => {
  /* The cost of missing it is a phone shipped to a customer with no lock on it and no way back
     without the handset in hand. That has already happened once. So it rides above the table,
     it is red, and it says do not ship them. */
  const src = read('portal.html');
  const pane = src.slice(src.indexOf('function devPaint_(m, d, at){'),
                         src.indexOf('function devVisibleTicks_'));
  const alarm = pane.slice(pane.indexOf('var alarm='), pane.indexOf('var actions='));
  assert.ok(alarm.length > 200, 'the alarm is built');
  assert.match(alarm, /c\.lockedNeverSpoke/, 'off the server count, not a client guess');
  assert.match(alarm, /class="note bad"/, 'red, because it is not an observation');
  assert.match(alarm, /NOT locked/, 'it says plainly what these phones are');
  assert.match(alarm, /Do not ship them/, 'and the one instruction that matters');
  assert.match(alarm, /id="dvAlarm"/, 'with a way to see exactly which');

  // Above the table, with the orders -- not buried under the register it is warning about.
  const compose = /\+tiles\+bar\+alarm\+actions\+table\+/.exec(pane);
  assert.ok(compose, 'composed between the chips and the orders');

  // And it filters rather than re-reading: the rows are already in hand.
  assert.match(pane, /DEV\.flag='lockedNeverSpoke'; DEV\.filter=''; devPaint_\(m, d, at\)/);
});

test('portal.html: the enrol drawer answers the refusal that still prints ENROLLED', () => {
  /* The alarm above catches these phones AFTER the bench has packed up. This is the same
     failure caught while the cable is still in: set-device-owner refused for an account that
     Settings does not show, the enrol broadcast that follows answering result=1 ENROLLED all
     the same, because the office minted a token for a phone that never became Device Owner.
     There is no remote cure for one that ships in that state, so the note has to name the
     refusal, both commands, and the fact that ENROLLED is not proof of anything. */
  const src = read('portal.html');
  const fn = src.slice(src.indexOf('function devProvision('),
                       src.indexOf('$(\'#dvTokDone\').onclick'));

  /* Between the count sentence and the Done button -- OUTSIDE both one-vs-many ternaries.
     Inside the batch card it would be invisible on a single-phone bench, which is exactly
     where the two ruined handsets were enrolled. */
  const tail = fn.slice(fn.indexOf('before you unplug the hub.'), fn.indexOf('id="dvTokDone"'));
  assert.ok(!/\+\(one/.test(tail), 'nothing conditional may wrap it');
  const note = tail.slice(tail.indexOf('<div class="note bad"'));
  assert.ok(note.length > 400, 'the note is built, in both languages');
  assert.ok(note.includes('HAIJAFUNGWA'), 'and the Swahili half says it is not locked');

  // Both commands whole. A placeholder on either line gets pasted into cmd exactly as written.
  assert.ok(note.includes('>adb shell dumpsys account</div>'),
    'the command that lists the accounts Settings hides');
  assert.ok(note.includes('adb shell pm uninstall --user 0 com.google.android.apps.tachyon</div>'),
    'and the one that removes the account that actually causes this');

  // The trap named: a green line on the screen is not a locked phone.
  assert.ok(note.includes('<b>NOT locked</b>'), 'it says plainly what the handset is');
  assert.ok(note.includes('<b>result=1 ENROLLED</b>'),
    'and that the line the operator is counting proves nothing here');
  assert.match(note, /Do not ship the handset/, 'the one instruction that matters');
});
