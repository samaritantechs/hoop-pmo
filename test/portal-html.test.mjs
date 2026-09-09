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

/* The Kiongozi switch is gone (2026-09-07): one approver for the company, and the nav is the
   grant. What is pinned now is its absence, so it cannot drift back in through a merge. */
test('the access-codes table has no Kiongozi column and the page never calls the old toggle', () => {
  const src = read('portal.html');
  const head = /<tr><th>Code<\/th>[\s\S]{0,400}?<\/tr>/.exec(src);
  assert.ok(head, 'the access-codes header row has changed shape');
  const cols = [...head[0].matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map(m => m[1]);
  assert.deepEqual(cols, ['Code', 'Jina', 'Role', 'Timu', 'Tabs', 'Yupo?', ''],
    'Yupo? is the one named control column, still before the actions cell');
  const row = src.slice(src.indexOf("<tr><td class=\"code\">"));
  const susp = row.indexOf('data-susp="'), edit = row.indexOf('data-ed="'), del = row.indexOf('data-del="');
  assert.ok(susp > 0 && edit > 0 && del > 0 && susp < edit && edit < del, 'Yupo?, then Hariri and Futa');
  assert.ok(!/data-lead\b|data-lead2|accessCodeLeader|acLead|Kiongozi wa idara|leaderKnown/.test(src),
    'no trace of the switch on the page');
  // And the approval pane no longer explains a department scope it no longer has.
  const appr = src.slice(src.indexOf('function drawAdvAppr('), src.indexOf('var ADVQ='));
  assert.ok(!/d\.scope|role yako|own role only|d\.note/.test(appr),
    'the queue is the whole company and says nothing else about whose it is');
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

  // The trap named: a row on the register is not a locked phone.
  assert.ok(note.includes('<b>NOT locked</b>'), 'it says plainly what the handset is');

  /* AND IT NAMES THE RIGHT RESULT CODE. This note first claimed the broadcast "may still say
     result=1 ENROLLED" after set-device-owner was refused. It cannot: EnrolReceiver checks
     LockAdmin.isOwner FIRST and returns say(3, "NOT DEVICE OWNER") before it ever looks at a
     token. Telling an operator to distrust a line the app does not print in this situation
     sends them hunting for the wrong thing.

     What actually lies is the REGISTER -- Sajili simu mints the token when the IMEI is pasted,
     so the row reads as enrolled for a phone that has never spoken. That is the whole reason
     the never-spoke alarm exists, and it is what the note must say. */
  assert.ok(note.includes('result=3 NOT DEVICE OWNER'),
    'the code the app actually returns when ownership was refused');
  assert.ok(!/may still say <b>result=1/.test(note),
    'and not the code it cannot return on this path');
  assert.match(note, /What lies is the register/,
    'the register is what misleads here, not the terminal');

  const java = fs.readFileSync(new URL(
    '../android/lock/src/main/java/com/samaritantechs/hooploanlock/EnrolReceiver.java',
    import.meta.url), 'utf8');
  const owner = java.indexOf('if (!LockAdmin.isOwner(c))');
  const tokenRead = java.indexOf('String token = intent.getStringExtra("token");');
  assert.ok(owner > 0 && owner < tokenRead,
    'the ownership check really does come first -- this is why result=1 is impossible here');
  assert.match(java.slice(owner, tokenRead), /say\(3, "NOT DEVICE OWNER/,
    'and it really does answer 3, which is the number the note quotes');

  // Both halves carry the instruction that saves a handset, not just the English one.
  assert.match(note, /Usisafirishe simu hii/, 'Swahili says do not ship it');
  assert.match(note, /Do not ship the handset/, 'and so does the English');

  /* AND IT NAMES THE RIGHT LINE OF THAT OUTPUT.
     -----------------------------------------------------------------------------------
     This note first said "read the Account {name= lines". On a CLEAN phone there are none,
     and the only thing left to read is a twelve-entry RegisteredServicesCache that lists
     every app capable of making an account -- naming com.google.android.apps.tachyon on a
     spotless handset. An operator following that instruction reads a ready phone as a dirty
     one and starts uninstalling. Confirmed on the returned handset: "Accounts: 0" at the top,
     tachyon still named twelve lines below it.

     So the anchor is the COUNT, which is unambiguous on every phone, and the services list is
     ruled out by name. */
  assert.ok(note.includes('Accounts: 0'), 'the count is the line the operator is sent to');
  assert.match(note, /RegisteredServicesCache/,
    'and the list that names Meet on a clean phone is ruled out by name');
  assert.ok(!/Account \{name=/.test(note),
    'the old anchor is gone: on a clean phone it matches nothing but the services list');
  // Both halves carry it -- an operator reading only Swahili must not be sent to the old line.
  assert.match(note, /Soma[\s\S]{0,120}Accounts: 0/, 'Swahili sends them to the count');
  assert.match(note, /Read the count at the top/, 'and so does the English');
});

/* =========================================================================================
   IMPREST AND LEAVE, on the page.

     "request tab, approval tab and imprest reports tab ... retirement ... with 3 pictures
      (optimize for storage as business operator does) ... asking for leaves in app (another
      nav), and hr approves or rejects there (another one)"

   The wiring test above already proves each of the five navs opens a defined pane that calls
   functions the server has. These pin the parts of the page that the server cannot check for
   it: what is NOT sent, what is shrunk before it is sent, and what the preview promises.
   ========================================================================================= */
const IMP_SRC = (name, html) => {
  const m = new RegExp('\\nfunction ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}').exec(html);
  assert.ok(m, name + '() is a top-level function on the page');
  return m[0];
};

test('portal.html: the imprest and leave writes are never re-sent by the client', () => {
  const html = read('portal.html');
  const m = /var NO_RETRY=\{([\s\S]*?)\};/.exec(html);
  assert.ok(m, 'NO_RETRY is a literal');
  for (const f of ['impRequest', 'impDecide', 'impRetire', 'impRoleSave', 'impRoleDelete', 'leaveRequest', 'leaveDecide']) {
    assert.match(m[1], new RegExp('\\b' + f + ':1'), f + ' is a write; a dropped one is re-pressed by a person, not re-sent by a client');
  }
});

test('portal.html: the role editor names the five new panes in words the owner can tick', () => {
  const html = read('portal.html');
  const lbl = /var lbl=\{dashboard:[\s\S]*?\}\[k\]\|\|k;/.exec(html);
  assert.ok(lbl, 'the label map is where it was');
  for (const k of ['impreq', 'impappr', 'imprep', 'leavereq', 'leaveappr', 'leaverep']) {
    assert.match(lbl[0], new RegExp("\\b" + k + ":'[^']+'"), k + ' has a label, not a bare key');
  }
  // And the sidebar has the two groups the five entries file under.
  assert.match(html, /\{ g:'imp',\s*sw:'Imprest'/);
  assert.match(html, /\{ g:'leave',\s*sw:'Likizo'/);
});

test('portal.html: the request form sends the parts and never a total, and the preview says so', () => {
  const html = read('portal.html');
  const fn = IMP_SRC('drawImpReq', html);
  const call = /srv\('impRequest',\{([\s\S]*?)\}\)\.then/.exec(fn);
  assert.ok(call, 'the form submits through srv(impRequest)');
  for (const k of ['fareTrips', 'farePerTrip', 'accomDays', 'imprestRole', 'other1Desc', 'other1Amount', 'purpose', 'email', 'travelDate']) {
    assert.match(call[1], new RegExp('\\b' + k + ':'), k + ' is sent');
  }
  for (const k of ['fareAmount', 'accomAmount', 'accomRate', 'total']) {
    assert.ok(!new RegExp('\\b' + k + ':').test(call[1]), k + ' is a preview, not an argument -- the server computes it');
  }
  // The computed boxes are read-only so nobody types into a figure the server will ignore.
  for (const id of ['imFare', 'imRate', 'imAccom']) {
    assert.match(fn, new RegExp('id="' + id + '" class="inp" readonly'), id + ' cannot be typed into');
  }
  assert.match(fn, /seva inahesabu upya/, 'and the form says the server recomputes');
  // The role list comes from the server's rate table, with the rate shown beside each role.
  assert.match(fn, /roles\.map\(function\(r\)\{ return '<option value="'\+esc\(r\.role\)\+'">'\+esc\(r\.role\)\+' · malazi '\+money\(r\.rate\)/);
});

test('portal.html: receipts are shrunk on the phone to the same ceiling the server holds', () => {
  const html = read('portal.html');
  const api = fs.readFileSync(new URL('../api/portal.js', import.meta.url), 'utf8');
  const server = /const IMP_PHOTO_MAX_BYTES = ([0-9 *]+);/.exec(api);
  const page = /var IMP_PHOTO_MAX=([0-9 *]+);/.exec(html);
  assert.ok(server && page, 'both sides state the ceiling as a literal');
  assert.equal(eval(page[1]), eval(server[1]), 'the page shrinks to the size the server accepts');

  /* DECODED ONCE, DRAWN SMALLER. An 8MB photo read into a base64 string and decoded again for
     every size tried is how an old WebView's renderer gets killed and the typed actuals with it. */
  const load = IMP_SRC('loadImage', html);
  assert.equal((load.match(/readAsDataURL\(file\)/g) || []).length, 1, 'one read of the file');
  assert.equal((load.match(/new Image\(\)/g) || []).length, 1, 'one decode');
  assert.ok(!/createObjectURL/.test(load), 'and not through the route the export guard reserves for saveFile_');
  const draw = IMP_SRC('drawScaled', html);
  assert.match(draw, /toDataURL\('image\/jpeg', q\)/, 'JPEG at a quality, not a PNG of the original');
  assert.match(draw, /maxPx\/Math\.max\(w,h,1\)/, 'scaled by the LONG side');
  assert.match(draw, /ctx\.fillStyle='#fff'; ctx\.fillRect/, 'a transparent PNG receipt does not go black');
  assert.match(draw, /if\(!ctx\) throw/, 'a WebView with no canvas memory left is an error in words, not a slot stuck on "shrinking"');
  const steps = IMP_SRC('shrinkForReceipt', html);
  assert.match(steps, /\[\[1024,0\.6\],\[800,0\.5\]/, 'starts at 1024px and steps down');
  assert.match(steps, /dataUrlBytes\(u\)<=IMP_PHOTO_MAX\) return u;/, 'and keeps going until it fits');
  assert.match(steps, /Promise\.all\(\[loadImage\(file\), photoOrientation\(file\)\]\)/, 'one decode, one EXIF read, every size from those');
  // Old WebViews draw the camera's raw pixels sideways; the orientation is applied only there.
  assert.match(IMP_SRC('photoOrientation', html), /if\(autoOrients\(\)\|\|!file\|\|!jpeg\)\{ res\(1\); return; \}/,
    'a browser that turns photos the right way up itself is never rotated twice');
  assert.match(IMP_SRC('autoOrients', html), /CSS\.supports\('image-orientation','from-image'\)/);
  assert.match(draw, /case 6: ctx\.transform\(0,1,-1,0,ch,0\); break;/, 'the common portrait-phone case');

  const drawerFn = IMP_SRC('impRetireDrawer', html);
  // One slot per pass of a three-pass loop: the file input is written once, drawn three times.
  assert.match(drawerFn, /\[1,2,3\]\.map\(function\(i\)\{[\s\S]*?type="file" accept="image\/\*"/,
    'three photo slots, camera or gallery -- accept="image/*" with no capture= so the gallery is offered too');
  assert.ok(!/capture=/.test(drawerFn), 'no capture= attribute: a receipt already in the gallery must be attachable');
  assert.match(drawerFn, /var photos=\[null,null,null\], seq=\[0,0,0\], pending=0/, 'exactly three slots, each with its own sequence');
  assert.match(drawerFn, /var my=\+\+seq\[i-1\];/, 'the newest pick on a slot owns it; a slower earlier shrink is dropped');
  assert.match(drawerFn, /if\(my!==seq\[i-1\]\) return;/);
  assert.match(drawerFn, /b\.disabled=pending>0\|\|invalid/, 'File waits for every chosen photo to finish shrinking');
  assert.match(drawerFn, /if\(IMP_INFLIGHT\[r\.id\]\)\{ toast\(/, 'a second drawer on a trip still uploading is refused');
  assert.match(drawerFn, /IMP_INFLIGHT\[r\.id\]=true;/);
  assert.match(drawerFn, /photos\.filter\(Boolean\)/, 'only the slots that were filled are sent');
  assert.match(drawerFn, /srv\('impRetire',\{[\s\S]*photos:got/, 'as data URLs, already shrunk');
  assert.match(drawerFn, /shrinkForReceipt\(f\)/, 'every chosen file goes through the shrink');

  /* The page's byte count agrees with the server's for the same data URL, so a photo the page
     thinks fits is a photo the server accepts. */
  const bytesFn = new Function(IMP_SRC('dataUrlBytes', html) + '; return dataUrlBytes;')();
  const buf = Buffer.alloc(150 * 1024 + 1, 9);
  assert.equal(bytesFn('data:image/jpeg;base64,' + buf.toString('base64')), buf.length);
  assert.equal(bytesFn('data:image/jpeg;base64,' + Buffer.alloc(2, 1).toString('base64')), 2, 'padding is subtracted');
});

test('portal.html: the drawers refuse what the server would refuse, and say so first', () => {
  const html = read('portal.html');
  const decide = IMP_SRC('impDecideDrawer', html);
  assert.match(decide, /if\(approve\)\{ var amt=\$\('#imdAmt'\)\.value; if\(amt===''\|\|!\(Number\(amt\)>0\)\)\{ toast\(/,
    'a cleared amount box is not "approve the full amount"');
  const appr = IMP_SRC('drawImpAppr', html);
  assert.match(appr, /if\(\$\('#rlRate'\)\.value===''\)\{ toast\(/, 'a blank rate is not a zero rate');
  const req = IMP_SRC('drawImpReq', html);
  assert.match(req, /Math\.floor\(n\)!==n\|\|n<0/, 'the preview refuses decimals and negatives like the server');
  assert.match(req, /\$\('#imSend'\)\.disabled=invalid\|\|!roles\.length;/, 'and will not offer to send them');
  // The receipts button in the details drawer is bound, never inlined.
  const details = IMP_SRC('impDetailsDrawer', html);
  assert.ok(!/onclick="impPhotosDrawer/.test(details), 'no inline handler with a quoted id in it');
  assert.match(details, /\$\('#drawer \[data-impp\]'\)/, 'bound after the drawer is drawn, like every other button');
  // A slow answer redraws its own pane only: every post-write redraw in the block is guarded.
  const block = html.slice(html.indexOf("var ADVR={from:'',to:'',status:''};"), html.indexOf('/* ---------- stock accountability'));
  const bare = block.split('\n').filter(l => /\bdraw(ImpReq|ImpAppr|ImpRep|LeaveReq|LeaveAppr|LeaveRep)\(m\);/.test(l)
    && !/return draw|if\(TAB==='/.test(l));
  assert.deepEqual(bare, [], 'an imprest or leave redraw never lands under whatever tab the person moved to');
  assert.ok((block.match(/if\(TAB==='impreq'\) drawImpReq\(m\);/g) || []).length >= 2);
  // A dropped ANSWER to a write is not "the request never arrived".
  const srvFn = IMP_SRC('srv', html);
  assert.match(srvFn, /if\(dropped\) e=new Error\(NO_RETRY\[fn\]/, 'the message depends on whether a re-send could file twice');
  assert.match(srvFn, /BEFORE sending again/);
});

test('portal.html: the leave preview counts the same working days the server will', () => {
  const html = read('portal.html');
  const days = new Function(IMP_SRC('leaveWorkingDays', html) + '; return leaveWorkingDays;')();
  const resume = new Function(IMP_SRC('leaveResumeDay', html) + '; return leaveResumeDay;')();
  assert.equal(days('2026-09-14', '2026-09-25'), 10, 'two Monday-to-Friday weeks');
  assert.equal(days('2026-09-12', '2026-09-13'), 0, 'a weekend alone is no working days');
  assert.equal(days('2026-10-07', '2026-10-07'), 1);
  assert.equal(days('2026-09-25', '2026-09-14'), 0, 'reversed dates count nothing rather than crashing');
  const t0 = Date.now();
  assert.equal(days('0002-01-01', '9999-12-31'), 0, 'a span of centuries -- a year typed digit by digit -- is not walked day by day');
  assert.ok(Date.now() - t0 < 50, 'and costs nothing');
  assert.equal(resume('2026-09-25'), '2026-09-28', 'a leave ending Friday resumes Monday');
  assert.equal(resume('2026-10-07'), '2026-10-08');

  const fn = IMP_SRC('drawLeaveReq', html);
  assert.match(fn, /declared:\$\('#lvDecl'\)\.checked/, 'the declaration is a tick, sent as a boolean');
  assert.match(fn, /WIKI MOJA kabla/, 'the one-week rule is on the form in Swahili');
  assert.match(fn, /ONE WEEK ahead/, 'and in English');
  assert.match(fn, /noNotice=type==='sick'\|\|type==='compassionate'/, 'with the form\'s own two exceptions');
  for (const t of ['annual', 'sick', 'maternity', 'paternity', 'compassionate', 'other']) {
    assert.match(html, new RegExp("\\['" + t + "','"), t + ' is on the type list');
  }
});

test('portal.html: every imprest and leave list says which migration to run when the tables are missing', () => {
  const html = read('portal.html');
  for (const name of ['drawImpReq', 'drawImpAppr', 'drawImpRep']) {
    assert.match(IMP_SRC(name, html), /if\(d\.notReady\)\{ m\.innerHTML=impNotReady\(\); return; \}/, name + ' handles notReady');
  }
  for (const name of ['drawLeaveReq', 'drawLeaveAppr', 'drawLeaveRep']) {
    assert.match(IMP_SRC(name, html), /if\(d\.notReady\)\{ m\.innerHTML=leaveNotReady\(\); return; \}/, name + ' handles notReady');
  }
  assert.match(IMP_SRC('impNotReady', html), /RUN-ME-2026-09-07-imprest-leave\.sql/);
  assert.match(IMP_SRC('leaveNotReady', html), /RUN-ME-2026-09-07-imprest-leave\.sql/);
  assert.ok(fs.existsSync(new URL('../db/migrations/RUN-ME-2026-09-07-imprest-leave.sql', import.meta.url)),
    'and that file exists under the name the panes print');
});

test('portal.html: the approval pane owns the rate table and the CEO report reads by travel date', () => {
  const html = read('portal.html');
  const appr = IMP_SRC('drawImpAppr', html);
  assert.match(appr, /srv\('impRoleSave',\{role:role, rate:rate\}\)/, 'add or change a role\'s nightly rate');
  assert.match(appr, /srv\('impRoleDelete',\{role:role\}\)/);
  assert.match(appr, /confirm\('Futa wadhifa/, 'deleting a role asks first');
  assert.match(appr, /impTable\(rows,\{decide:true,photos:true\}\)/, 'the approver decides and may see receipts');
  const req = IMP_SRC('drawImpReq', html);
  assert.match(req, /impTable\(rows,\{retire:true,photos:true\}\)/, 'the requester retires their own and sees their own receipts');
  const table = IMP_SRC('impTable', html);
  assert.match(table, /o\.retire&&r\.mine&&r\.status==='approved'&&!r\.retiredAt/, 'Retire only on an approved, un-retired trip of your own');
  const rep = IMP_SRC('drawImpRep', html);
  assert.match(rep, /Tarehe ya safari:/, 'the CEO filters on the trip, not the click');
  assert.match(rep, /monthRange_\(\)/, 'this month by default, like the advance report');
  for (const k of ['toRefund', 'toReimburse', 'toRetire', 'spent', 'approvedAmount']) {
    assert.match(rep, new RegExp('t\\.' + k), 'the ' + k + ' widget is drawn');
  }
  assert.match(rep, /PHOTOS \('\+ret\.photos\+'\)/, 'receipts open per row, never inline');
  const decide = IMP_SRC('impDecideDrawer', html);
  assert.match(decide, /max="'\+\(r\.total\|\|0\)\+'"/, 'the approve box is capped at what was asked');
});

/* =========================================================================================
   ISSUES: one log, three panes -- raise, desk, report.
     "the gaps of what we haven't implemented at all should be implemented I think"
     "remember I implement tasks/roles by nav tabs not role based so just implement the
      functionality"
   The wiring test proves the three navs open defined panes that call functions the server
   has. These pin what the server cannot see: what the form sends, who gets the controls that
   move an issue, and that the desk is ONE queue with a department chip -- never a nav per
   department.
   ========================================================================================= */
test('portal.html: the issue writes are never re-sent, and the role editor names the three panes', () => {
  const html = read('portal.html');
  const nr = /var NO_RETRY=\{([\s\S]*?)\};/.exec(html);
  assert.ok(nr, 'NO_RETRY is a literal');
  for (const f of ['issueRaise', 'issueUpdate']) {
    assert.match(nr[1], new RegExp('\\b' + f + ':1'), f + ' is a write; a dropped one is re-pressed by a person');
  }
  const lbl = /var lbl=\{dashboard:[\s\S]*?\}\[k\]\|\|k;/.exec(html);
  assert.ok(lbl, 'the label map is where it was');
  for (const k of ['issuereq', 'issues', 'issuerep']) {
    assert.match(lbl[0], new RegExp("\\b" + k + ":'[^']+'"), k + ' has a label, not a bare key');
  }
  assert.match(html, /\{ g:'issue',\s*sw:'Masuala'/, 'the sidebar group the three file under');
  // Exactly three issue navs: the department is a chip on the desk, not a nav of its own.
  const navs = [...html.matchAll(/\{ g:'issue', t:'([a-z]+)'/g)].map(m => m[1]);
  assert.deepEqual(navs, ['issuereq', 'issues', 'issuerep']);
});

test('portal.html: the raise form sends the parts of an issue and never who raised it or where it stands', () => {
  const html = read('portal.html');
  const wire = IMP_SRC('issueRaiseWire', html);
  const call = /srv\('issueRaise',\{([\s\S]*?)\}\)/.exec(wire);
  assert.ok(call, 'the form submits through srv(issueRaise)');
  for (const k of ['department', 'kind', 'subjectType', 'subject', 'title', 'details', 'contact']) {
    assert.match(call[1], new RegExp('\\b' + k + ':'), k + ' is sent');
  }
  for (const k of ['status', 'staffName', 'staffCode', 'verified', 'assignedTo']) {
    assert.ok(!new RegExp('\\b' + k + ':').test(call[1]), k + ' is the server\'s to stamp, never the form\'s to send');
  }
  // The subject box is enabled only for the kinds of subject that need one, as the server insists.
  assert.match(wire, /needs=t==='imei'\|\|t==='agent'\|\|t==='receipt'/);
  // Both panes build the same form: the desk logs on a caller's behalf (the complaints form).
  assert.match(IMP_SRC('drawIssueReq', html), /issueRaiseHtml\(d,'is'\)/);
  assert.match(IMP_SRC('drawIssues', html), /issueRaiseHtml\(d,'isn'\)/);
  // And the desk's form is not offered to a view-only code.
  assert.match(IMP_SRC('drawIssues', html), /BOOT\.readOnly\?'':'<button class="btn sm" id="isqNew"/);
});

test('portal.html: the drawer gives the controls that move an issue to the desk nav alone', () => {
  const html = read('portal.html');
  const dr = IMP_SRC('issueDrawer', html);
  assert.match(dr, /var desk=hasNav\('issues'\)&&!BOOT\.readOnly;/, 'the desk is whoever holds the issues nav, nobody by role');
  assert.match(dr, /var canNote=!BOOT\.readOnly&&\(desk\|\|\(r\.mine&&hasNav\('issuereq'\)\)\);/, 'a raiser may talk on their own');
  // Status, assignment, references, the verified tick and the resolution are inside the desk branch only.
  const deskBlock = /\(desk\?'<div class="row"[\s\S]*?<textarea id="isdRes"[\s\S]*?:''\)/.exec(dr);
  assert.ok(deskBlock, 'the desk controls are one conditional block');
  for (const id of ['isdSt', 'isdAsg', 'isdRef', 'isdXr', 'isdVer', 'isdRes']) {
    assert.match(deskBlock[0], new RegExp('id="' + id + '"'), id + ' is a desk control');
  }
  assert.match(dr, /if\(desk\)\{ a\.status=\$\('#isdSt'\)\.value;/, 'and only the desk sends them');
  assert.match(dr, /\[\['open',[^\]]*\],\['waiting',[^\]]*\],\['escalated',[^\]]*\],\['resolved'/, 'the four states, in the order they are lived');
  assert.match(dr, /srv\('issueNotes',\{id:r\.id\}\)/, 'the conversation is loaded with the drawer');
});

test('portal.html: the desk is one queue with a department chip, and the report reads by the date raised', () => {
  const html = read('portal.html');
  const desk = IMP_SRC('drawIssues', html);
  assert.match(desk, /srv\('issueQueue',ISSUEQ\)/);
  assert.match(html, /var ISSUEQ=\{department:'',state:''\};/, 'unresolved, every department, by default');
  assert.match(desk, /\(d\.departments\|\|\[\]\)\.map\(function\(k\)\{ return chip\(k,issueDept\(k\),byDept\[k\]\|\|0\); \}\)/, 'one chip per department, with its open count');
  assert.match(desk, /ISSUEQ\.state=\(ISSUEQ\.state==='all'\?'':'all'\)/, 'resolved ones are a toggle away, not gone');
  const rep = IMP_SRC('drawIssueRep', html);
  assert.match(rep, /Tarehe ya kuletwa:/, 'the period is the date raised');
  assert.match(rep, /monthRange_\(\)/, 'this month by default, like every other report here');
  for (const k of ['count', 'open', 'waiting', 'escalated', 'resolved', 'avgDays', 'oldestOpenDays']) {
    assert.match(rep, new RegExp('t\\.' + k + '\\b'), 'the ' + k + ' widget is drawn');
  }
  assert.match(rep, /byDept\.map\(function\(x\)/, 'and the per-department table');
  // The settings pane explains the two new keys in the same breath as the other addresses.
  assert.match(html, /<b>ISSUES_EMAIL<\/b>: mstari mmoja kwa kila idara/);
  assert.match(html, /<b>GM_EMAIL<\/b>/);
  // Every pane names the migration when the table is not there yet.
  assert.match(IMP_SRC('issueNotReady', html), /RUN-ME-2026-09-08-issues\.sql/);
  for (const fn of ['drawIssueReq', 'drawIssues', 'drawIssueRep']) {
    assert.match(IMP_SRC(fn, html), /if\(d\.notReady\)\{ m\.innerHTML=issueNotReady\(\); return; \}/, fn + ' says which file to run');
  }
});

/* =========================================================================================
   THE FOLLOW-UP REPORT, the company script and the KPI card.
     Credit SOP A.5 six buckets, A.6 send to the GM, A.3/E.5 the company script, D the 5% KPI.
   The wiring test above proves the nav opens a defined pane calling functions the server has.
   These pin what the server cannot see: that the tiles ARE the buckets the server sent, that
   the send button is not offered to a code that may not write, and that the KPI card says what
   it is measuring rather than passing itself off as WATU's own figure.
   ========================================================================================= */
test('portal.html: the follow-up report draws the server\'s own buckets and each tile filters the table', () => {
  const html = read('portal.html');
  const fn = IMP_SRC('drawFuRep', html);
  assert.match(fn, /srv\('fuOutcomes',\{from:FUR\.from,to:FUR\.to,team:FUR\.team\}\)/);
  // The tiles are built from d.kinds, so a bucket added on the server appears here with no
  // second edit -- the failure mode this replaces is a screen quietly missing a category.
  assert.match(fn, /kinds\.map\(function\(k\)\{/);
  assert.match(fn, /labels\[k\]\|\|k/, 'and labelled with the server\'s own words');
  assert.match(fn, /FUR\.kind\?rows\.filter\(function\(r\)\{ return r\.kind===FUR\.kind; \}\):rows/,
    'tapping a tile filters the table under it');
  assert.match(html, /var FUR=\{from:'',to:'',team:'',kind:''\};/);
  assert.match(fn, /FUR\.from=isoToday\(0\); FUR\.to=isoToday\(0\);/, 'today by default: this is a daily report');
  assert.match(fn, /go\(isoToday\(-6\),isoToday\(0\)\)/, 'and a week back is a NEGATIVE offset');
  // Sending the GM his copy: a write, so not offered to a view-only code, and never re-sent.
  assert.match(fn, /BOOT\.readOnly\?'':'<button class="btn sm" id="furSend"/);
  assert.match(fn, /srv\('fuOutcomesSend'/);
  const nr = /var NO_RETRY=\{([\s\S]*?)\};/.exec(html);
  assert.match(nr[1], /\bfuOutcomesSend:1/, 'a dropped send is re-pressed by a person who can see it');
  const lbl = /var lbl=\{dashboard:[\s\S]*?\}\[k\]\|\|k;/.exec(html);
  assert.match(lbl[0], /\bfurep:'[^']+'/, 'the owner ticks it by a name, not a key');
});

test('portal.html: the KPI card names its own proxy and only shouts when it is over the line', () => {
  const html = read('portal.html');
  const fn = IMP_SRC('kpiCard', html);
  assert.match(fn, /if\(!k\|\|!k\.book\) return '';/, 'no book, no card -- never a bare 0%');
  assert.match(fn, /pct>k\.target/, 'red is measured against the setting, not a hard-coded 5');
  assert.match(fn, /closest proxy for the WATU default rate, not WATU/, 'the card says what it is and what it is not');
  // Drawn on the recovery pane in BOTH states: with two decks, and on the very first upload.
  const rec = IMP_SRC('drawRecovery', html);
  assert.equal((rec.match(/kpiCard\(d\.kpi\)/g) || []).length, 2,
    'the first upload has no recovery to show and still has a KPI');
  assert.match(html, /<b>KPI_DEFAULT_RATE<\/b>/, 'and Settings explains the key');
  assert.match(html, /<b>CALL_SCRIPT<\/b>/);
});

test('call.html: the company script is on the card, folded, and absent when nobody set one', () => {
  const html = read('call.html');
  assert.match(html, /S\.boot && S\.boot\.callScript/, 'the script comes off the boot the app already makes');
  assert.match(html, /<details class="script-box"><summary>[^<]*Maneno ya kampuni \/ Company script<\/summary>/);
  assert.match(html, /esc\(S\.boot\.callScript\)/, 'escaped: the office types prose, not markup');
  assert.match(html, /\.script-body\{white-space:pre-wrap/, 'the office\'s own line breaks survive');
  // The empty case is a MISSING panel, not an empty one.
  assert.match(html, /\? '<details class="script-box">[\s\S]*?: ''\)/);
});

/* =========================================================================================
   STOCK REQUESTS: ask, decide against the aging gate, hand over.
     Store SOP B.1/B.2/B.5-B.9, E (the gate), E.3 (the tracker), G (the low-stock alert).
   The wiring test proves the three navs open defined panes calling functions the server has.
   These pin what the server cannot see: that the person asking is shown the gate BEFORE they
   file, that the override is a tick plus a reason rather than a silent flag, and that the
   handover form asks for the things the SOP says make somebody accountable.
   ========================================================================================= */
test('portal.html: the stock panes are wired, their writes never re-sent, and the owner can tick them', () => {
  const html = read('portal.html');
  const nr = /var NO_RETRY=\{([\s\S]*?)\};/.exec(html);
  for (const f of ['stockRequest', 'stockDecide', 'stockIssue']) {
    assert.match(nr[1], new RegExp('\\b' + f + ':1'), f + ' is a write; a dropped one is re-pressed by a person');
  }
  const lbl = /var lbl=\{dashboard:[\s\S]*?\}\[k\]\|\|k;/.exec(html);
  for (const k of ['stockreq', 'stockappr', 'stockrep']) {
    assert.match(lbl[0], new RegExp("\\b" + k + ":'[^']+'"), k + ' has a label, not a bare key');
  }
  // Three entries under the Stoo group the page already has -- no new group for these.
  for (const t of ['streq', 'stappr', 'strep']) {
    assert.match(html, new RegExp("\\{ g:'stock', t:'" + t + "'"), t + ' files under Stoo');
  }
  assert.match(IMP_SRC('stockNotReady', html), /RUN-ME-2026-09-09-stock-requests\.sql/);
});

test('portal.html: the asker is shown the gate before filing, not after being refused', () => {
  const html = read('portal.html');
  const fn = IMP_SRC('drawStockReq', html);
  assert.match(fn, /srv\('stockMine',\{\}\)/);
  // The red banner is drawn from the SERVER's live verdict for this person, above the form.
  assert.match(fn, /g&&g\.blocked\?'<div class="note bad">/, 'a blocked asker sees why at the top of the pane');
  assert.match(fn, /SOP E/);
  assert.match(fn, /Unaweza kuomba/, 'and is told they may still ask -- the gate is the desk\'s, not a locked form');
  const call = /srv\('stockRequest',\{([\s\S]*?)\}\)/.exec(fn);
  for (const k of ['holder', 'destination', 'item', 'qty', 'reason']) {
    assert.match(call[1], new RegExp('\\b' + k + ':'), k + ' is sent');
  }
  for (const k of ['status', 'agingCount', 'agingOverride', 'staffName']) {
    assert.ok(!new RegExp('\\b' + k + ':').test(call[1]), k + ' is the server\'s to stamp');
  }
});

test('portal.html: releasing over the gate takes a tick AND a reason, and the desk sees the live position', () => {
  const html = read('portal.html');
  const dec = IMP_SRC('stockDecideDrawer', html);
  // The override controls exist only when the gate is actually blocking.
  assert.match(dec, /g&&g\.blocked\?'<div class="note bad"[\s\S]*?id="stdOv"[\s\S]*?id="stdOvR"[\s\S]*?:''\)/,
    'no blocked holder, no override box to tick out of habit');
  assert.match(dec, /overrideAging:!!\(ov&&ov\.checked\), overrideReason:/);
  assert.match(dec, /max="'\+money\(r\.qty\)\+'"/, 'the release box is capped at what was asked');
  // The queue shows each row's gate as it stands NOW, and has a chip for the blocked ones.
  const appr = IMP_SRC('drawStockAppr', html);
  assert.match(appr, /c\.blocked/, 'the blocked tile');
  assert.match(appr, /stockTable\(rows,\{decide:!BOOT\.readOnly,issue:!BOOT\.readOnly\}\)/,
    'a view-only code gets no Decide and no Hand over');
  assert.match(IMP_SRC('stockTable', html), /agingLine\(g\)/, 'and each row carries the live position');
});

test('portal.html: the handover form asks for what the SOP says makes somebody accountable', () => {
  const html = read('portal.html');
  const fn = IMP_SRC('stockIssueDrawer', html);
  for (const [id, why] of [['siNo', 'B.5 the pre-numbered note'], ['siImeis', 'B.5 the IMEIs'],
    ['siJoint', 'B.6 the joint count'], ['siRcv', 'B.8 who signed'],
    ['siCour', 'B.9 the courier'], ['siDocs', 'B.9 its documents']]) {
    assert.match(fn, new RegExp('id="' + id + '"'), why + ' is on the form');
  }
  // B.7: photos, shrunk on the phone to the ceiling the server holds.
  assert.match(fn, /siP'\+i/, 'three photo inputs');
  assert.match(fn, /Promise\.all\(files\.map\(shrinkForReceipt\)\)/, 'shrunk before sending, as the receipts are');
  assert.match(fn, /srv\('stockIssue',\{[\s\S]*?countedJointly:\$\('#siJoint'\)\.checked/);
  // The IMEI counter tells the store keeper they have over-listed before the server does.
  assert.match(fn, /ni nyingi kuliko zilizoidhinishwa/);
  // And the note reads back, photos included, behind one button.
  const hv = IMP_SRC('stockHandoverDrawer', html);
  assert.match(hv, /srv\('stockHandover',\{id:id\}\)/);
  assert.match(hv, /srv\('stockPhotos'/);
  assert.match(hv, /data:image\\\/\(jpeg\|jpg\|png\|webp\);base64,/,
    'only an image data URL ever reaches a src, the same rule the server kept on the way in');
});

test('portal.html: the stock report is the aging tracker and the distribution book on one pane', () => {
  const html = read('portal.html');
  const fn = IMP_SRC('drawStockRep', html);
  assert.match(fn, /srv\('stockReqReport',STOCKR\)/);
  assert.match(fn, /ag\.low\?'<div class="note bad">/, 'SOP G: the low-stock alert is a banner, not a tile nobody reads');
  assert.match(fn, /t\.overrides/, 'and how often the gate was overridden');
  assert.match(fn, /Stoo iliyokaa \/ Aging stock tracker/);
  assert.match(fn, /monthRange_\(\)/, 'this month by default, like every other report here');
  assert.match(html, /<b>STOCK_AGING_DAYS<\/b>/, 'Settings explains the threshold');
  assert.match(html, /<b>STOCK_LOW_ALERT<\/b>/);
});

/* =========================================================================================
   SALES TARGETS. CSM SOP B.3 sets regional targets, RSM SOP B.1 sets each agent's.
   The board next door says how much we sold; this says against what. These pin the two things
   the server cannot: that a missing target draws NOTHING rather than a zero bar, and that the
   scope buttons and the table come from the server's own answer.
   ========================================================================================= */
test('portal.html: the targets pane draws four scopes and never invents a percentage', () => {
  const html = read('portal.html');
  const fn = IMP_SRC('drawTargets', html);
  assert.match(fn, /srv\('targetsView',\{period:TGT\.period\}\)/);
  assert.match(html, /var TGT=\{period:'',scope:'agent'\};/);
  assert.match(fn, /TGT\.period=thisMonth_\(\)/, 'this month by default');
  // The scope buttons come from the server's list, so a scope added there appears here.
  assert.match(fn, /\(d\.scopes\|\|\['agent','rsm','branch','company'\]\)\.map/);
  assert.match(fn, /rows=\(d\.rows&&d\.rows\[TGT\.scope\]\)\|\|\[\]/);
  // NO TARGET, NO BAR. An empty bar reads as zero attainment, which is a different claim.
  const bar = IMP_SRC('tgtBar', html);
  assert.match(bar, /if\(pct==null\) return '<span class="mut">—<\/span>';/);
  assert.match(bar, /pct>=100\?'ok':\(pct>=70\?'warn':'bad'\)/);
  // The RSM column only exists on the agent scope, where it means something.
  assert.match(fn, /TGT\.scope==='agent'\?'<th>RSM<\/th>':''/);
  assert.match(fn, /r\.targetQty==null\?'—':money\(r\.targetQty\)/, 'and an unset target reads as unset');
  // A view-only code gets no Set button and no per-row edit.
  assert.match(fn, /var canW=!BOOT\.readOnly;/);
  assert.match(fn, /canW\?'<button class="btn sm" id="tgNew"/);
});

test('portal.html: the target drawer sends the parts, and removing is not the same as zero', () => {
  const html = read('portal.html');
  const fn = IMP_SRC('targetDrawer', html);
  const call = /srv\('targetSave',\{([\s\S]*?)\}\)/.exec(fn);
  for (const k of ['period', 'scope', 'name', 'qty', 'amount', 'note']) {
    assert.match(call[1], new RegExp('\\b' + k + ':'), k + ' is sent');
  }
  assert.match(fn, /Sifuri ni lengo halali/, 'the form says zero is a real target and blank is none');
  assert.match(fn, /r\.hasTarget\?'<button class="btn w danger ghost" id="tgDel"/,
    'remove is offered only where a target exists');
  assert.match(fn, /confirm\('Futa lengo/, 'and removing asks first');
  assert.match(fn, /srv\('targetDelete'/);
  // The company scope names itself; nobody types a name for it.
  assert.match(fn, /isCo\?'<input id="tgName" class="inp" value="ALL" readonly>'/);
  // Writes are never re-sent by the client.
  const nr = /var NO_RETRY=\{([\s\S]*?)\};/.exec(html);
  for (const f of ['targetSave', 'targetDelete', 'staffManager']) {
    assert.match(nr[1], new RegExp('\\b' + f + ':1'), f + ' is a write');
  }
  const lbl = /var lbl=\{dashboard:[\s\S]*?\}\[k\]\|\|k;/.exec(html);
  assert.match(lbl[0], /\btargets:'[^']+'/);
  assert.match(IMP_SRC('targetNotReady', html), /RUN-ME-2026-09-09-targets\.sql/);
});

test('portal.html: the staff register shows who each agent reports to, and says blank means the branch', () => {
  const html = read('portal.html');
  const fn = IMP_SRC('drawStaff', html);
  assert.match(fn, /<th>Reports to<\/th>/);
  assert.match(fn, /o\.manager\?esc\(o\.manager\):'<span class="mut">kwa tawi \/ by branch<\/span>'/,
    'blank is a stated fallback, not an empty cell');
  assert.match(fn, /srv\('staffManager',\{phone:phone, manager:\$\('#mgrV'\)\.value\}\)/);
  assert.match(fn, /BOOT\.readOnly\?'':' <button class="btn sm ghost" data-mgr=/,
    'a view-only code gets no pencil');
  // The picker offers the RSMs the register knows, so nobody types a name nothing matches.
  assert.match(fn, /REGIONAL\|COUNTRY_SALES/);
});

/* =========================================================================================
   COMMISSION. Finance SOP A.1 the two schedules, A.3 the phone-to-agent check, A.4 the sheet
   and its sign-off, A.6 the CLEARED stamp, plus the five-row audit checklist.
   These pin what the server cannot: that the sheet shows the five fields the SOP names, that
   the checklist is rendered from the server's own list rather than a second copy, and that
   the pay controls appear only on a signed sheet that has not been cleared.
   ========================================================================================= */
test('portal.html: the commission sheet shows the five fields SOP A.4 requires', () => {
  const html = read('portal.html');
  const fn = IMP_SRC('commSheetHtml', html);
  for (const [col, why] of [['AJENTI', 'agent name'], ['IDADI', 'sales quantity'],
    ['KAMISHENI', 'commission amount'], ['SIMU', 'phone number'], ['RSM', 'the RSM they fall under']]) {
    assert.match(fn, new RegExp('<th[^>]*>' + col + '</th>'), why + ' is a column on the sheet');
  }
  assert.match(fn, /l\.agentPhone\|\|'—'/); assert.match(fn, /l\.rsm\|\|'—'/);
  // A cleared cycle says so in words, not just a chip.
  assert.match(fn, /r\.clearedAt\?'<div class="note ok"/);
  assert.match(fn, /haiwezi kulipwa tena/, 'and says it cannot be paid again');
  assert.match(IMP_SRC('commNotReady', html), /RUN-ME-2026-09-09-commission\.sql/);
});

test('portal.html: the checklist comes from the server, and paying is offered only where it is legal', () => {
  const html = read('portal.html');
  const fn = IMP_SRC('commSheetDrawer', html);
  // Rendered from d.checks -- one list on the server, not a second copy on the page that can drift.
  assert.match(fn, /checks=d\.checks\|\|\[\]/);
  assert.match(fn, /checks\.map\(function\(c\)\{/);
  assert.match(fn, /class="cmChk" data-k="'\+esc\(c\.key\)/);
  // Pay: only on an approved, uncleared sheet, and only for a code that may write.
  assert.match(fn, /var canPay=opts\.pay&&!BOOT\.readOnly&&r\.status==='approved'&&!r\.clearedAt;/);
  assert.match(fn, /var canSign=opts\.sign&&!BOOT\.readOnly&&r\.status==='draft';/);
  assert.match(fn, /srv\('commPay',\{id:id, paymentRef:\$\('#cmRef'\)\.value, checks:picked\}\)/);
  // The two panes open the same drawer with different powers -- that is the whole separation.
  assert.match(IMP_SRC('drawComm', html), /commSheetDrawer\(m, b\.getAttribute\('data-cmv'\), \{pay:true\}\)/);
  assert.match(IMP_SRC('drawCommAppr', html), /commSheetDrawer\(m, b\.getAttribute\('data-cmv'\), \{sign:true\}\)/);
});

test('portal.html: building a cycle switches the period control between a month and a day', () => {
  const html = read('portal.html');
  const fn = IMP_SRC('drawComm', html);
  assert.match(fn, /per\.type=kind\.value==='daily'\?'date':'month';/,
    'SOP A.1 has two schedules, so the control asks for the right shape');
  assert.match(fn, /srv\('commBuild',\{period:per\.value, kind:kind\.value\}\)/);
  assert.match(fn, /Kujenga upya kunaruhusiwa ikiwa bado ni rasimu tu/, 'and says rebuilding is draft-only');
  assert.match(fn, /A phone with no rate is not paid/, 'the rates block says what an unpriced phone does');
  // Writes are never re-sent, least of all the payment.
  const nr = /var NO_RETRY=\{([\s\S]*?)\};/.exec(html);
  for (const f of ['commBuild', 'commDecide', 'commPay', 'commRateSave', 'commRateDelete']) {
    assert.match(nr[1], new RegExp('\\b' + f + ':1'), f + ' is a write');
  }
  const lbl = /var lbl=\{dashboard:[\s\S]*?\}\[k\]\|\|k;/.exec(html);
  for (const k of ['commission', 'commappr']) assert.match(lbl[0], new RegExp('\\b' + k + ":'[^']+'"));
});

/* =========================================================================================
   THE ADVANCE RULES. Finance SOP G.4 the deadline flag, G.5 the 40% cap, G.6 the two stamps.
   These pin what the server cannot: that a request filed before the rules shipped draws NO
   chip rather than a green one it never earned, that the form says what the flag will say
   before the button is pressed, and that HR's two stamps are offered in order.
   ========================================================================================= */
test('portal.html: the rules chips never claim more than the row knows', () => {
  const html = read('portal.html');
  const fn = IMP_SRC('advRules', html);
  // late === true, not truthiness: null means nothing was being measured, which is not "in time".
  assert.match(fn, /if\(r\.late===true\)/, 'only an actually-late row is chipped late');
  assert.ok(!/r\.late\?/.test(fn), 'never a bare truthiness test on a tri-state field');
  assert.match(fn, /r\.capAmount!=null/);
  assert.match(fn, /r\.status==='approved'\) out\.push\('<span class="chip warn">Hakuna mshahara/,
    'an approval with no salary on file is named uncapped rather than left blank');
});

test('portal.html: the request form says what the deadline flag will say, from the server\'s day', () => {
  const html = read('portal.html');
  const fn = IMP_SRC('drawAdvReq', html);
  assert.match(fn, /var dd=d\.deadlineDay\|\|15;/, 'the deadline comes from the server, not a 15 typed here');
  assert.match(fn, /SOP G\.4/);
  assert.match(fn, /Bado unaweza kutuma|You can still send it/, 'and it is a warning, never a block');
  assert.match(fn, /\$\('#avDate'\)\.onchange=ruleLine/);
});

test('portal.html: HR gets Pay then Deduct, in that order, and only where each is legal', () => {
  const html = read('portal.html');
  const t = IMP_SRC('advTable', html);
  assert.match(t, /pay&&!BOOT\.readOnly&&r\.status==='approved'&&!r\.paidAt/, 'Pay: approved and not yet paid');
  assert.match(t, /pay&&!BOOT\.readOnly&&r\.paidAt&&!r\.deductedAt/, 'Deduct: paid and not yet deducted');
  assert.match(t, /act==='decide'&&r\.status==='pending'/, 'and the approval queue gets its own button only');
  const w = IMP_SRC('advWirePay', html);
  assert.match(w, /srv\('advPay',\{id:id, paymentRef:\$\('#avpRef'\)\.value\}\)/);
  assert.match(w, /srv\('advDeduct',\{id:id, period:\$\('#avkP'\)\.value\}\)/);
  assert.match(w, /type="month"/, 'the deduction records a payroll MONTH');
  const nr = /var NO_RETRY=\{([\s\S]*?)\};/.exec(html);
  for (const f of ['advPay', 'advDeduct', 'salarySave', 'salaryDelete']) {
    assert.match(nr[1], new RegExp('\\b' + f + ':1'), f + ' is a write');
  }
});

test('portal.html: salaries sit behind the staff nav and say what they are for', () => {
  const html = read('portal.html');
  const fn = IMP_SRC('drawSalaries', html);
  assert.match(fn, /srv\('salaryList',\{\}\)/);
  assert.match(fn, /Finance SOP G\.5/, 'the block says the one rule that reads it');
  assert.match(fn, /d\.maxPct\|\|40/, 'and takes the percentage from the server');
  assert.match(fn, /RUN-ME-2026-09-09-advance-rules\.sql/);
  assert.match(fn, /canW=!BOOT\.readOnly/);
  assert.match(IMP_SRC('drawStaff', html), /drawSalaries\(\);/, 'drawn as part of the staff pane');
});

/* =========================================================================================
   LOSS AND DAMAGE. Finance SOP H.1 the police report, H.2 the price list, H.5 the signature.
   These pin what the server cannot: that the form asks for the police report the moment theft
   is chosen, that an unvalued case shows a dash rather than a zero, and that the desk's
   controls are not handed to whoever merely reported the loss.
   ========================================================================================= */
test('portal.html: the loss form asks for the police report as soon as theft is chosen', () => {
  const html = read('portal.html');
  const wire = IMP_SRC('lossRaiseWire', html);
  assert.match(wire, /cause\.value==='theft'\?'':'none'/,
    'SOP H.1 is asked for on the form, not discovered from a server error');
  const call = /srv\('lossRaise',\{([\s\S]*?)\}\)/.exec(wire);
  for (const k of ['custodian', 'item', 'imei', 'cause', 'policeRef', 'details']) {
    assert.match(call[1], new RegExp('\\b' + k + ':'), k + ' is sent');
  }
  for (const k of ['value', 'status', 'recovered', 'acknowledgedBy']) {
    assert.ok(!new RegExp('\\b' + k + ':').test(call[1]), k + ' is the desk\'s, never the reporter\'s');
  }
  assert.match(IMP_SRC('lossNotReady', html), /RUN-ME-2026-09-09-loss-damage\.sql/);
});

test('portal.html: an unvalued case shows a dash, and the desk controls stay with the desk', () => {
  const html = read('portal.html');
  const t = IMP_SRC('lossTable', html);
  // A zero in a debt column reads as "nothing owed", which is a different claim from "not priced".
  assert.match(t, /r\.value==null\?'<span class="mut">—<\/span>':money\(r\.value\)/);
  assert.match(t, /r\.outstanding==null\?'—':money\(r\.outstanding\)/);
  const dr = IMP_SRC('lossDrawer', html);
  assert.match(dr, /var canNote=!BOOT\.readOnly&&\(desk\|\|r\.mine\);/,
    'a reporter may talk on their own case');
  assert.match(dr, /desk&&!BOOT\.readOnly\?'<div class="row"[\s\S]*?id="lsdSt"/,
    'valuing, the recovery method, the signature and the status are one desk-only block');
  assert.match(dr, /if\(desk&&\$\('#lsdVal'\)\)\{/, 'and only the desk sends them');
  assert.match(dr, /SOP H\.5/);
  // The two panes open the same drawer with different powers.
  assert.match(IMP_SRC('drawLossReq', html), /lossWire\(m, rows, false\)/);
  assert.match(IMP_SRC('drawLoss', html), /lossWire\(m, rows, true\)/);
});

test('portal.html: the price list says why changing it does not re-price an open case', () => {
  const html = read('portal.html');
  const fn = IMP_SRC('drawLoss', html);
  assert.match(fn, /SOP H\.2/);
  assert.match(fn, /never re-prices a debt already acknowledged/);
  assert.match(fn, /srv\('priceSave'/); assert.match(fn, /srv\('priceDelete'/);
  assert.match(fn, /confirm\('Futa bei/, 'and removing a price asks first');
  assert.match(fn, /t\.unvalued/, 'the tile that chases SOP H.2');
  const nr = /var NO_RETRY=\{([\s\S]*?)\};/.exec(html);
  for (const f of ['lossRaise', 'lossUpdate', 'priceSave', 'priceDelete']) {
    assert.match(nr[1], new RegExp('\\b' + f + ':1'), f + ' is a write');
  }
  const lbl = /var lbl=\{dashboard:[\s\S]*?\}\[k\]\|\|k;/.exec(html);
  for (const k of ['lossreq', 'loss']) assert.match(lbl[0], new RegExp('\\b' + k + ":'[^']+'"));
});

/* =========================================================================================
   TOP-UPS. Finance SOP B.5 is the only step in any of these SOPs with the words "must never
   be delayed", so the pane's job is to make a delay impossible to miss. These pin that the
   wait is drawn in minutes and colours, that the desk's three steps appear one at a time in
   order, and that a checklist row already ticked cannot be quietly unticked.
   ========================================================================================= */
test('portal.html: the top-up queue draws the wait and shouts when somebody has waited hours', () => {
  const html = read('portal.html');
  const w = IMP_SRC('topupWait', html);
  assert.match(w, /m>=120\?'bad':\(m>=30\?'warn':'ok'\)/, 'minutes turn amber then red');
  assert.match(w, /done\) return '<span class="mut">/, 'a finished one is not still shouting');
  const fn = IMP_SRC('drawTopups', html);
  assert.match(fn, /longest>=120\?'<div class="note bad">/, 'and a long wait is a banner, not a tile nobody reads');
  assert.match(fn, /SOP B\.5/);
  assert.match(fn, /c\.longestWaitMins/);
  assert.match(IMP_SRC('topupNotReady', html), /RUN-ME-2026-09-09-topups\.sql/);
});

test('portal.html: the desk gets one step at a time, in the order the SOP sets', () => {
  const html = read('portal.html');
  const dr = IMP_SRC('topupDrawer', html);
  // Verify only while requested, pay only once verified, unlock only once paid.
  assert.match(dr, /r\.status==='requested'\n?\s*\?[\s\S]*?id="tuImei"[\s\S]*?id="tuPayer"/,
    'B.2 and B.3 are two ticks on the verify step');
  assert.match(dr, /r\.status==='verified'\n?\s*\?[\s\S]*?id="tuRef"/, 'B.5 asks for the reference');
  assert.match(dr, /r\.status==='paid'\n?\s*\?[\s\S]*?id="tuConf"/, 'B.6 asks somebody to confirm');
  assert.match(dr, /send\('verify',\{imeiOk:\$\('#tuImei'\)\.checked, payerOk:\$\('#tuPayer'\)\.checked/);
  assert.match(dr, /send\('unlock',\{confirmed:\$\('#tuConf'\)\.checked\}\)/);
  assert.match(dr, /desk&&!BOOT\.readOnly\?/, 'and a view-only code gets none of it');
  // A checklist row already ticked is shown ticked and disabled: an audit tick is not a toggle.
  assert.match(dr, /r\.checks&&r\.checks\[c\.key\]\?' checked disabled':''/);
  assert.match(dr, /if\(c\.checked&&!c\.disabled\)/, 'and only newly ticked rows are sent');
});

test('portal.html: the top-up request form sends the parts and never the state', () => {
  const html = read('portal.html');
  const wire = IMP_SRC('topupRaiseWire', html);
  const call = /srv\('topupRequest',\{([\s\S]*?)\}\)/.exec(wire);
  for (const k of ['imei', 'customer', 'customerPhone', 'paidAmount', 'price', 'payerName', 'proofRef']) {
    assert.match(call[1], new RegExp('\\b' + k + ':'), k + ' is sent');
  }
  for (const k of ['status', 'verifiedBy', 'paidAt', 'balance']) {
    assert.ok(!new RegExp('\\b' + k + ':').test(call[1]), k + ' is the server\'s');
  }
  assert.match(IMP_SRC('topupRaiseHtml', html), /Acha wazi ili itafutwe/,
    'the price may be left blank and looked up');
  const nr = /var NO_RETRY=\{([\s\S]*?)\};/.exec(html);
  for (const f of ['topupRequest', 'topupUpdate']) {
    assert.match(nr[1], new RegExp('\\b' + f + ':1'), f + ' is a write');
  }
  const lbl = /var lbl=\{dashboard:[\s\S]*?\}\[k\]\|\|k;/.exec(html);
  for (const k of ['topupreq', 'topups']) assert.match(lbl[0], new RegExp('\\b' + k + ":'[^']+'"));
});

/* =========================================================================================
   THE DOOR -- IT SOP D "monitor for unauthorized access ... act immediately on any breach".

   Two things must hold on the page, and the first is the whole feature: the pane can be
   ticked for more than one person, so it must never become a list of the company's keys.
   ========================================================================================= */
test('portal.html: the security pane shows a mask and never a code', () => {
  const html = read('portal.html');
  const fn = IMP_SRC('drawSecurity', html);
  // What is drawn per attempt is the MASK the server sent, never anything else.
  assert.match(fn, /esc\(r\.codeMasked\|\|'—'\)/, 'the masked code is the only form on screen');
  assert.ok(!/r\.code\b/.test(fn), 'the page never reaches for a plain code -- there is not one to reach for');
  assert.match(fn, /Misimbo haihifadhiwi hapa/,
    'and it says so, so nobody spends the morning looking for a column that does not exist');
  assert.match(fn, /d\.alertFails/, 'how many tries count as somebody working at it comes from Settings');
  assert.match(fn, /watch\.length\?'<div class="note bad">/,
    'codes nobody has acted on are a banner, because SOP D says immediately');
  assert.match(IMP_SRC('secNotReady', html), /RUN-ME-2026-09-10-signin-watch\.sql/);
});

test('portal.html: the door pane counts the right refusals and asks what was done', () => {
  const html = read('portal.html');
  // The admin's own switch turning everybody away says nothing about anybody.
  const al = IMP_SRC('secAlarming', html);
  assert.ok(!/'closed'/.test(al), 'a closed system is not a break-in');
  for (const k of ['invalid', 'suspended', 'switched_off', 'unknown_phone', 'view_only']) {
    assert.match(al, new RegExp("'" + k + "'"), k + ' is worth a look');
  }
  const dr = IMP_SRC('secReviewDrawer', html);
  assert.match(dr, /srv\('signinReview',\{key:g\.key,note:\$\('#secNote'\)\.value\}\)/,
    'acting on a breach is recorded against the line it was about');
  assert.match(dr, /Misimbo ya kuingia|Access codes/,
    'and it points at the pane where a code is actually changed, rather than duplicating it here');
  assert.match(dr, /BOOT\.readOnly\?''/, 'supervision changes nothing');
  const nr = /var NO_RETRY=\{([\s\S]*?)\};/.exec(html);
  for (const f of ['signinReview', 'signinSend']) {
    assert.match(nr[1], new RegExp('\\b' + f + ':1'), f + ' is a write and is never re-sent by the client');
  }
  const lbl = /var lbl=\{dashboard:[\s\S]*?\}\[k\]\|\|k;/.exec(html);
  assert.match(lbl[0], /\bsecurity:'[^']+'/, 'the nav is grantable by name in the roles editor');
});

/* =========================================================================================
   ENROLMENT -- IT SOP A. The page's job is to make A.3 look like what it is: a check that
   comes BEFORE an activation, rather than a switch with a checklist beside it.
   ========================================================================================= */
test('portal.html: the enrolment desk shows the gaps and activation is a button, not a box', () => {
  const html = read('portal.html');
  const fn = IMP_SRC('drawEnrol', html);
  assert.match(fn, /c\.liveUnverified\?'<div class="note bad">/,
    'live and never checked is the one number A.3 exists to drive to zero');
  assert.match(fn, /RSM SOP E\.1/, 'the branch table IS the RSM’s own question');
  assert.match(fn, /byBranch\.map/);
  /* No "active" control anywhere on the form: switching an account on goes through the gate
     or not at all. The form builds its ids by concatenation, so the field LIST is what to
     look at -- checking for a literal id="enActive" would pass whatever the form did. */
  assert.ok(!/f\('Active'|f\('Verified'/.test(IMP_SRC('enrolFormHtml', html)),
    'there is no way to tick somebody live past the check');
  assert.match(IMP_SRC('enrolNotReady', html), /RUN-ME-2026-09-10-enrolment\.sql/);
});

test('portal.html: the enrolment form asks for both referees and sends only the details', () => {
  const html = read('portal.html');
  const form = IMP_SRC('enrolFormHtml', html);
  // The ids are built by concatenation, so the field list is what the form actually declares.
  for (const f of ['Name', 'Phone', 'Nid', 'Role', 'Branch', 'K1n', 'K1p', 'K2n', 'K2p']) {
    assert.ok(form.includes("f('" + f + "'"), f + ' is on the form (SOP A.1)');
  }
  assert.match(form, /SOP A\.1 inasema wawili/, 'and it says why there are two referees');
  const args = IMP_SRC('enrolFormArgs', html);
  for (const id of ['enName', 'enPhone', 'enNid', 'enK2n', 'enK2p']) {
    assert.ok(args.includes("$('#" + id + "')"), id + ' is read back when the form is sent');
  }
  for (const k of ['active', 'verified', 'notified']) {
    assert.ok(!new RegExp('\\b' + k, 'i').test(args), k + ' is the server’s, decided by A.3/A.4');
  }
  const dr = IMP_SRC('enrolDrawer', html);
  assert.match(dr, /step\('enVer','verify'\)/);
  assert.match(dr, /step\('enNot','notify'\)/);
  assert.match(dr, /r\.verifiedAt&&!r\.notifiedAt\?/, 'A.4 is only offered once A.3 is done');
  assert.match(dr, /BOOT\.readOnly\?''/, 'supervision changes nothing');
  const nr = /var NO_RETRY=\{([\s\S]*?)\};/.exec(html);
  for (const f of ['enrolSave', 'enrolUpdate']) assert.match(nr[1], new RegExp('\\b' + f + ':1'));
  const lbl = /var lbl=\{dashboard:[\s\S]*?\}\[k\]\|\|k;/.exec(html);
  assert.match(lbl[0], /\benrol:'[^']+'/);
});
