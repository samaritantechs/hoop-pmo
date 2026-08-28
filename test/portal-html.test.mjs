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
