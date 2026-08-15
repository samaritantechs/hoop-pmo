#!/usr/bin/env python3
"""Build the Android launcher icons from brand/hope-logo.png.

The logo is a wide wordmark sitting in a mostly-empty square. Dropped into a 48px icon
untouched it becomes an unreadable smudge, so this trims it down to its actual ink first and
then gives it the margin an icon wants -- which is why this is a script and not a five-line
resize.

    python3 scripts/make-launcher-icons.py

Re-run it whenever brand/hope-logo.png changes. Everything it writes is checked in, so the
build itself needs neither Python nor this script.
"""
import os
from PIL import Image

SRC = 'brand/hoop-logo.png'
RES = 'android/app/src/main/res'
# The five densities Android asks for, in px.
SIZES = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
# Adaptive icons (Android 8+) crop hard: the outer ~25% of the foreground can be masked away
# by the launcher's shape, so the artwork lives inside a safe circle in the middle.
ADAPTIVE = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}
WHITE = (255, 255, 255, 255)


def trim(im):
    """Crop away everything that is transparent OR white -- both read as 'empty' here, since
    the logo arrives on a white square and the ink is what matters."""
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


def compose(ink, size, margin):
    """Centre `ink` on a white square of `size`, leaving `margin` (a fraction) all round."""
    box = int(size * (1 - 2 * margin))
    w, h = ink.size
    s = min(box / w, box / h)
    art = ink.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
    out = Image.new('RGBA', (size, size), WHITE)
    out.paste(art, ((size - art.size[0]) // 2, (size - art.size[1]) // 2), art)
    return out


def main():
    ink = trim(Image.open(SRC))
    print(f'{SRC}: ink is {ink.size[0]}x{ink.size[1]} after trimming')

    for d, size in SIZES.items():
        out = compose(ink, size, 0.10)
        path = f'{RES}/mipmap-{d}/ic_launcher.png'
        os.makedirs(os.path.dirname(path), exist_ok=True)
        out.save(path)
        # Round variant: launchers that ask for a circle get the same art, same file content.
        out.save(f'{RES}/mipmap-{d}/ic_launcher_round.png')
        print(f'  {path}  {size}x{size}')

    # Adaptive foreground: the same ink, but pulled well inside the safe zone so a circular or
    # squircle mask never clips the wordmark. Background is a flat white layer in XML.
    for d, size in ADAPTIVE.items():
        path = f'{RES}/mipmap-{d}/ic_launcher_foreground.png'
        art = compose(ink, size, 0.28)
        art.putalpha(art.split()[3])
        # Foreground must be transparent where there is no ink -- the white comes from the
        # background layer, so a white-filled foreground would defeat the mask entirely.
        base = Image.new('RGBA', (size, size), (255, 255, 255, 0))
        w, h = ink.size
        box = int(size * (1 - 2 * 0.28))
        s = min(box / w, box / h)
        a = ink.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
        base.paste(a, ((size - a.size[0]) // 2, (size - a.size[1]) // 2), a)
        base.save(path)
        print(f'  {path}  {size}x{size} (adaptive foreground)')


if __name__ == '__main__':
    main()
