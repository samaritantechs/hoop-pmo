#!/usr/bin/env python3
"""Build a WHITE-ink version of brand/hoop-logo.png, for anywhere the ground is already a
solid brand colour instead of white -- the lock screen's navy background is the first one.

brand/hoop-logo.png is navy ink (#2E2B7A) plus a light-blue smile (#35A8E1), drawn for a
WHITE ground -- see make-launcher-icons.py. Dropped onto a coloured screen as-is, the navy
reads as a dark smudge with no contrast against navy, and the whole point of a mark on a
lock screen (say who is holding the phone, at a glance, before anyone reads a word) is lost.

This keeps the exact shapes from the master file -- same H, same O's, same smile curve -- and
turns every inked pixel white, keeping its alpha. Nothing is redrawn by eye, so the mark on
the lock screen is never a hand-approximation of the brand, it is the brand.

    python3 scripts/make-white-logo.py

Re-run whenever brand/hoop-logo.png changes. Everything it writes is checked in, so the build
itself needs neither Python nor this script.
"""
import os
from PIL import Image

SRC = 'brand/hoop-logo.png'
OUT_SOURCE = 'brand/hoop-logo-white.png'
# drawable-nodpi: Android will not density-scale this file up or down on its own -- it is
# handed to the ImageView at native resolution and scaled DOWN to whatever size the layout
# asks for. Downscaling a large bitmap is always safe; only upscaling introduces visible
# blur, and trimming to ink at the source's native ~1120px width leaves plenty of headroom
# for that -- there is no per-density bucket to maintain here, unlike the launcher icon.
LOCK_DEST = 'android/lock/src/main/res/drawable-nodpi/hoop_logo_white.png'


def trim(im):
    """Crop away everything that is transparent OR white -- both read as 'empty' here, since
    the logo arrives on a white square and the ink is what matters. (Copied from
    make-launcher-icons.py rather than imported: two five-line scripts sharing one function
    is not worth a shared module, and this one must keep working even if that one changes.)"""
    im = im.convert('RGBA')
    px = im.load()
    w, h = im.size
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a > 24 and not (r > 244 and g > 244 and b > 244):
                if x < x0: x0 = x
                if y < y0: y0 = y
                if x > x1: x1 = x
                if y > y1: y1 = y
    if x1 < 0:
        return im
    return im.crop((x0, y0, x1 + 1, y1 + 1))


def whiten(im):
    """Every inked pixel -> white, alpha untouched. Not a threshold: the source anti-aliases
    its edges with partial alpha, and preserving that (rather than snapping to opaque) is what
    keeps the H's corners and the smile's curve smooth instead of jagged at any size."""
    im = im.convert('RGBA')
    r, g, b, a = im.split()
    white = Image.new('L', im.size, 255)
    return Image.merge('RGBA', (white, white, white, a))


def main():
    ink = trim(Image.open(SRC))
    white = whiten(ink)
    print(f'{SRC}: ink is {ink.size[0]}x{ink.size[1]} after trimming, now white')

    os.makedirs(os.path.dirname(OUT_SOURCE), exist_ok=True)
    white.save(OUT_SOURCE)
    print(f'  {OUT_SOURCE}')

    os.makedirs(os.path.dirname(LOCK_DEST), exist_ok=True)
    white.save(LOCK_DEST)
    print(f'  {LOCK_DEST}')


if __name__ == '__main__':
    main()
