/* THE BRAND, IN ONE PLACE.
   The launcher, the dashboard sign-in and the upload page all show the company before anyone
   has identified themselves, and each had the name hard-coded and no logo at all -- so
   changing the logo meant editing three files and shipping a deploy.

   They now read the same CALL_LOGO_URL / CALL_BRAND settings the phone app reads, through the
   public api_brand endpoint. Upload the logo once and every surface carries it -- including
   the BROWSER TAB and the icon Android puts on the home screen when a page is added from the
   browser, which no page had at all: every one of them showed a blank default.

   (The icon on the APK's own home-screen entry is a different thing again. Android resolves
   that from inside the installed package, so it needs a build -- nothing served from here can
   reach it.)

   Until a logo is uploaded, the drawn HOPE mark stands in. Nothing here ever renders an <img>
   with an empty or failed src, because that is a broken-image icon, which looks worse than no
   logo at all.

   Deliberately ES5-plain and dependency-free: the Android WebView on the oldest handset in
   the field loads these pages.

   A page that fetches the brand itself (call.html does, inside boot) sets
   window.HOPE_NO_BRAND_FETCH = true and calls HOPEBrand.icon(url) from there, so the phone
   never makes the same round trip twice. */
(function () {
  var MARK = '<svg viewBox="0 0 64 64" aria-hidden="true">'
    + '<text x="32" y="33" text-anchor="middle" font-size="21" font-weight="800"'
    + ' letter-spacing="-1.4" fill="#2E2B7A">HOOP</text>'
    + '<path d="M18 38 A 14 14 0 0 0 46 38" fill="none" stroke="#35A8E1" stroke-width="5"'
    + ' stroke-linecap="round"/></svg>';
  // The same mark as a standalone file, for the tab icon before anything is uploaded.
  var MARK_ICON = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
    + '<rect width="64" height="64" rx="14" fill="#fff"/>'
    + '<text x="32" y="33" text-anchor="middle" font-size="21" font-weight="800"'
    + ' letter-spacing="-1.4" fill="#2E2B7A" font-family="Arial,Helvetica,sans-serif">HOOP</text>'
    + '<path d="M18 38 A 14 14 0 0 0 46 38" fill="none" stroke="#35A8E1" stroke-width="5"'
    + ' stroke-linecap="round"/></svg>');

  /** Points the tab icon, and the icon a browser uses for "add to home screen", at a URL. */
  function icon(url) {
    if (!url) return;
    var rels = ['icon', 'shortcut icon', 'apple-touch-icon'];
    for (var i = 0; i < rels.length; i++) {
      var links = document.querySelectorAll('link[rel="' + rels[i] + '"]');
      for (var j = 0; j < links.length; j++) links[j].parentNode.removeChild(links[j]);
      var l = document.createElement('link');
      l.rel = rels[i]; l.href = url;
      document.head.appendChild(l);
    }
  }
  window.HOPEBrand = { icon: icon, mark: MARK, markIcon: MARK_ICON };
  icon(MARK_ICON);                       // never a blank tab, even before an upload

  var css = document.createElement('style');
  css.textContent = '.brandmark{width:64px;height:64px;border-radius:16px;background:#fff;'
    + 'margin:0 0 12px;padding:4px;display:block;box-sizing:border-box;'
    + 'box-shadow:0 1px 3px rgba(16,24,40,.10)}'
    + '.brandmark svg,.brandmark img{width:100%;height:100%;display:block;object-fit:contain}';
  document.head.appendChild(css);

  function paint(url, brandName) {
    icon(url);
    for (var k = 0; k < spots.length; k++) {
      var c = spots[k]; c.innerHTML = '';
      var el = new Image(); el.src = url; el.alt = brandName || '';
      c.appendChild(el);
    }
  }

  var spots = document.querySelectorAll('[data-brandmark]');
  for (var i = 0; i < spots.length; i++) {
    spots[i].className = (spots[i].className ? spots[i].className + ' ' : '') + 'brandmark';
    spots[i].innerHTML = MARK;
  }

  // Painted from the device first, so a returning visitor never watches the stand-in swap for
  // the real logo a second later. The network still refreshes it below; this only decides what
  // is on screen in the meantime.
  var seen = null;
  try { seen = localStorage.getItem('hopeLogo'); } catch (e) {}
  if (seen) paint(seen, null);
  if (window.HOPE_NO_BRAND_FETCH) return;

  try {
    fetch('/api/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn: 'api_brand', args: [] })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) return;
      if (d.brand) {
        var names = document.querySelectorAll('[data-brandname]');
        for (var j = 0; j < names.length; j++) names[j].textContent = d.brand;
      }
      if (!d.logo) return;
      if (d.logo === seen) return;                 // already on screen from the device
      // The mark is only replaced by an image that has actually LOADED.
      var im = new Image();
      im.onload = function () {
        paint(d.logo, d.brand);
        try { localStorage.setItem('hopeLogo', d.logo); } catch (e) {}
      };
      im.src = d.logo;
    }).catch(function () { /* offline or the API is down -- the drawn mark stands */ });
  } catch (e) { /* no fetch on a very old WebView -- the drawn mark stands */ }
})();

/* =====================================================================================
   AN ACCESS CODE TYPED IN PUBLIC IS AN ACCESS CODE SOMEBODY BEHIND YOU HAS READ.
   =====================================================================================
   "writing password during login should show dots not display while typing"

   Every door in this system is opened by a short code typed into a plain text box, on a phone,
   in an office or a bank hall, in front of whoever happens to be standing there. A leader's
   code is their whole authority -- it decides which teams they see and what they may change --
   and it was on screen in full while they typed it.

   So: dots, and an eye to check what was typed. The eye matters as much as the dots do. These
   codes are six characters of unpredictable letters and digits, entered on a phone keyboard by
   somebody who may be outdoors; a masked field with no way to look is a field people get
   locked out of, and locked-out people write the code on the desk.

   `data-upper` keeps the uppercasing that autocapitalize="characters" used to do, because a
   password field turns the browser's own autocapitalize off. Only the boxes that already had
   it get it, so nothing that accepted a lower-case code stops accepting one -- and the server
   now matches case-insensitively as a second line of defence.

   Written the same way as the rest of this file: no framework, no CSS file to load, nothing
   that a five-year-old WebView will not run. */
(function () {
  function attach(inp) {
    if (inp.getAttribute('data-secret-on')) return;      // idempotent: pages re-render
    inp.setAttribute('data-secret-on', '1');
    inp.type = 'password';
    inp.setAttribute('autocomplete', 'off');
    inp.setAttribute('autocorrect', 'off');
    inp.setAttribute('spellcheck', 'false');

    if (inp.hasAttribute('data-upper')) {
      inp.addEventListener('input', function () {
        var v = inp.value.toUpperCase();
        if (v === inp.value) return;
        // Keep the caret where the typist left it, or editing the middle of a code throws you
        // to the end on every keystroke.
        var a = inp.selectionStart, b = inp.selectionEnd;
        inp.value = v;
        try { inp.setSelectionRange(a, b); } catch (e) {}
      });
    }

    /* The input is wrapped rather than restyled: every page here has its own CSS for inputs and
       a shared stylesheet would be one more thing to load. A relative wrapper and an absolutely
       positioned button need nothing from the page at all. */
    var wrap = document.createElement('span');
    wrap.style.cssText = 'position:relative;display:block';
    inp.parentNode.insertBefore(wrap, inp);
    wrap.appendChild(inp);
    inp.style.paddingRight = '44px';

    var eye = document.createElement('button');
    eye.type = 'button';
    eye.setAttribute('aria-label', 'Onyesha / Show');
    eye.style.cssText = 'position:absolute;right:6px;top:50%;transform:translateY(-50%);'
      + 'width:32px;height:28px;line-height:1;padding:0;border:0;background:transparent;'
      + 'cursor:pointer;font-size:15px;opacity:.65';
    eye.innerHTML = '&#128065;';                      // an eye, which needs no translating
    eye.onclick = function () {
      var hidden = inp.type === 'password';
      inp.type = hidden ? 'text' : 'password';
      eye.style.opacity = hidden ? '1' : '.65';
      eye.setAttribute('aria-label', hidden ? 'Ficha / Hide' : 'Onyesha / Show');
      inp.focus();
    };
    wrap.appendChild(eye);
  }

  /** Called again after any screen that re-renders its sign-in form. Safe to call as often as
      you like -- a box that is already masked is left alone. */
  window.hopeSecrets = function (root) {
    var list = (root || document).querySelectorAll('input[data-secret]');
    for (var i = 0; i < list.length; i++) attach(list[i]);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { window.hopeSecrets(); });
  } else {
    window.hopeSecrets();
  }
})();
