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
