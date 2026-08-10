"""Build the one shipped texture: public/textures/steel-roughness.png.

Input  : assets/textures/steel-roughness.zimage-source.png
         (512x512 L, 170 KB — the de-lit, offset-and-healed seamless brushed-steel
         signal derived from the Comfy Cloud Z-Image-Turbo render; see PROVENANCE.md)
Output : public/textures/steel-roughness.png
         (512x512 8-bit greyscale, colour type 0, under 60 KB)

Three things happen here, and only three. Nothing invents detail; every step
either removes bytes or re-levels the signal.

1. BRUSH-ALIGNED LOW-PASS. A 7px box blur along x ONLY, wrap-addressed with
   np.roll. Brushed steel grain is anisotropic by definition — the abrasive runs
   left to right, so variation along the brush is physically small and whatever
   the diffusion model put there is sampler noise, not surface. Removing it is
   both more correct and where most of the byte saving comes from (97 KB ->
   54 KB at a fixed step of 4). It is wrap-addressed so the tile survives:
   a translation-invariant filter on a torus stays seamless.

2. RE-LEVEL TO THE MAP THIS REPLACES. src/ui/scene.ts builds brushedRoughness()
   on a canvas at runtime: fill 138, 5000 alpha-0.3 streaks at 138 +- 55. That
   algorithm re-implemented in numpy and measured: min 104, max 172, mean 138.6,
   std 10.9 (a simulation, not a browser-canvas decode). This file is re-levelled to mean 138.0,
   std 11.0 so it is a DROP-IN: three.js multiplies roughnessMap by
   material.roughness, so whatever scalar the steel material carries keeps
   landing where it does today. Only the grain changes — from 1-D scanlines to
   real 2-D brushed structure.

   This is why the map is centred at 0.541 and not at some "true" roughness: it
   is a MULTIPLIER in three.js, not an absolute value. Centring it at a literal
   brushed-steel 0.42 would drop the plates by a further 22% and read as chrome.

   The report at the bottom converts the band into effective roughness using
   STEEL_ROUGHNESS below. That scalar lives in scene.ts and has already moved
   once (0.46 -> 0.58); it is a display figure only and cannot affect the output
   bytes, but keep it in step or the printed numbers quietly go stale.

3. QUANTISE. Round to a step of 4 grey levels — 13 levels across the band. The
   band is only ~+-2.2 sigma wide to begin with, so a step of 4 is ~0.016 of
   roughness; the grain is high-frequency enough to dither its own contours, and
   a contrast-stretched inspection shows no banding. This is the rest of the
   budget: 103 KB -> 54 KB at a fixed blur radius of 3.

Both operations are wrap-safe (a pointwise map cannot create a seam; the blur is
circular), so the input's verified seamlessness is preserved, not re-established.
"""
import os
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SRC = os.path.join(HERE, 'steel-roughness.zimage-source.png')
DST = os.path.join(REPO, 'public', 'textures', 'steel-roughness.png')

BLUR_R = 3      # box radius along x, in pixels (7px kernel)
TARGET_MEAN = 138.0
TARGET_STD = 11.0
STEP = 4        # quantisation step in 8-bit grey levels
BUDGET = 60 * 1024
# Reporting only — never touches the pixels. Mirrors `steel.roughness` in
# src/ui/scene.ts, which is the scalar this map multiplies.
STEEL_ROUGHNESS = 0.58


def wrap_blur_x(a, r):
    """Box blur along x with circular addressing — cannot introduce a seam."""
    if r == 0:
        return a
    acc = np.zeros_like(a)
    for k in range(-r, r + 1):
        acc += np.roll(a, k, axis=1)
    return acc / (2 * r + 1)


src = np.asarray(Image.open(SRC).convert('L')).astype(np.float64)
print('source      : %dx%d  min %d max %d mean %.2f std %.2f  %d KB'
      % (src.shape[1], src.shape[0], src.min(), src.max(), src.mean(), src.std(),
         os.path.getsize(SRC) / 1024))

detail = wrap_blur_x(src - src.mean(), BLUR_R)
detail *= TARGET_STD / detail.std()
q = np.clip(np.round((detail + TARGET_MEAN) / STEP) * STEP, 0, 255).astype(np.uint8)

Image.fromarray(q, mode='L').save(DST, optimize=True, compress_level=9)
size = os.path.getsize(DST)

# ------------------------------------------------------------------ verification
im = Image.open(DST)
a = np.asarray(im).astype(np.int16)
wrap_x = np.abs(a[:, 0] - a[:, -1]).mean()
int_x = np.abs(np.diff(a, axis=1)).mean()
wrap_y = np.abs(a[0, :] - a[-1, :]).mean()
int_y = np.abs(np.diff(a, axis=0)).mean()

print('shipped     : %s %dx%d  %d bytes (%.1f KB)  %s budget by %.1f KB'
      % (im.mode, im.size[0], im.size[1], size, size / 1024,
         'UNDER' if size < BUDGET else 'OVER', abs(BUDGET - size) / 1024))
print('levels      : %d distinct, step %d' % (len(np.unique(q)), STEP))
print('8-bit range : min %d max %d mean %.2f std %.2f' % (q.min(), q.max(), q.mean(), q.std()))
print('as roughness multiplier on material.roughness %.2f (src/ui/scene.ts steel):'
      % STEEL_ROUGHNESS)
print('              %.3f .. %.3f, mean %.3f'
      % (q.min() / 255 * STEEL_ROUGHNESS, q.max() / 255 * STEEL_ROUGHNESS,
         q.mean() / 255 * STEEL_ROUGHNESS))
print('seam        : x wrap %.3f vs interior %.3f (%.2fx)   y wrap %.3f vs interior %.3f (%.2fx)'
      % (wrap_x, int_x, wrap_x / int_x, wrap_y, int_y, wrap_y / int_y))

# 2x2 composite and a 100% crop centred on the four-way join, for eyeballing.
big = np.tile(q, (2, 2))
Image.fromarray(big, 'L').save(os.path.join(HERE, 'steel-roughness.tile2x2.png'))
H = W = 512
Image.fromarray(big[H - 160:H + 160, W - 160:W + 160], 'L').resize(
    (640, 640), Image.NEAREST).save(os.path.join(HERE, 'steel-roughness.join.png'))
c = big[H - 160:H + 160, W - 160:W + 160].astype(np.float32)
c = np.clip((c - c.mean()) / (2.2 * c.std()) * 127 + 128, 0, 255).astype(np.uint8)
Image.fromarray(c, 'L').resize((640, 640), Image.NEAREST).save(
    os.path.join(HERE, 'steel-roughness.join-boost.png'))
print('wrote tile2x2 / join / join-boost previews into assets/textures/')
