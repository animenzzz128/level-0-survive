"""Build public/assets/models/props.glb: every node of the props.glb table in docs/design/art/model-contract.md.

Run from the repository root (Blender 4.5):
    blender --background --factory-startup --python tools/blender/build_props.py
    blender --background --factory-startup --python tools/blender/build_props.py -- --no-preview

Each prop is a top-level Empty named as in the contract, with its origin at the prop's pivot and its front facing
Blender -Y. Its meshes are children with identity transforms, so their vertices are already in the prop's own space
(the code can take a named mesh's geometry as it is, e.g. to instance `troffer_frame` and `troffer_lens`). The
Empties are spread out for the preview only; the game places the props itself. All textures are generated here with
numpy from fixed seeds, so re-running the script reproduces the file. After the export the script renders
tools/blender/previews/props*.png (helpers added for the renders are never exported).

Drafted with Claude Code (Anthropic) under Jacky Yao's direction.
"""
import math
import pathlib
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import common  # noqa: E402

TAU = 2 * math.pi


# ----------------------------------------------------------------------------------------------------------------------
# Colours and textures
# ----------------------------------------------------------------------------------------------------------------------

def srgb(hexstr):
    """'#rrggbb' -> sRGB array 0..1 (texture pixels are stored in sRGB)."""
    return np.array([int(hexstr[i:i + 2], 16) / 255 for i in (1, 3, 5)])


def lin(hexstr):
    """'#rrggbb' -> linear RGB tuple (material factors are linear in Blender and in glTF)."""
    return tuple(float(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4) for c in srgb(hexstr))


def grid(h, w):
    """U, V per pixel (h, w); row 0 is the top of the image, i.e. v = 1."""
    u = (np.arange(w) + 0.5) / w
    v = 1.0 - (np.arange(h) + 0.5) / h
    return np.meshgrid(u, v)


def vnoise(h, w, cy, cx, rng):
    """Tileable value noise 0..1 with cy x cx cells."""
    g = rng.random((cy, cx))
    ys = (np.arange(h) + 0.5) * cy / h
    xs = (np.arange(w) + 0.5) * cx / w
    y0 = np.floor(ys).astype(int) % cy
    x0 = np.floor(xs).astype(int) % cx
    fy = ys - np.floor(ys)
    fx = xs - np.floor(xs)
    fy = (fy * fy * (3 - 2 * fy))[:, None]
    fx = (fx * fx * (3 - 2 * fx))[None, :]
    y1, x1 = (y0 + 1) % cy, (x0 + 1) % cx
    a, b = g[np.ix_(y0, x0)], g[np.ix_(y0, x1)]
    c, d = g[np.ix_(y1, x0)], g[np.ix_(y1, x1)]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def fbm(h, w, cells, rng, octaves=4, gain=0.5, aspect=1.0):
    """Tileable fractal noise 0..1; `cells` across the width, `cells * aspect` down the height."""
    total, amp, norm = np.zeros((h, w)), 1.0, 0.0
    for o in range(octaves):
        cx = max(1, int(round(cells * 2 ** o)))
        cy = max(1, int(round(cells * aspect * 2 ** o)))
        total += amp * vnoise(h, w, cy, cx, rng)
        norm += amp
        amp *= gain
    return total / norm


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    t = np.asarray(t)
    if t.ndim == 2:
        t = t[..., None]
    return a + (b - a) * t


def blur(a, r):
    """Separable box blur (twice, so roughly Gaussian), wrapping at the edges."""
    out = a
    for axis in (0, 1):
        for _ in range(2):
            acc = np.zeros_like(out)
            for k in range(-r, r + 1):
                acc += np.roll(out, k, axis=axis)
            out = acc / (2 * r + 1)
    return out


def seg_dist(xs, ys, p0, p1):
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    t = np.clip(((xs - p0[0]) * dx + (ys - p0[1]) * dy) / max(dx * dx + dy * dy, 1e-9), 0, 1)
    return np.hypot(xs - (p0[0] + t * dx), ys - (p0[1] + t * dy))


def scratches(h, w, rng, n, length=(0.05, 0.25), width=0.7, angle=None):
    """Mask of thin straight scratches; length as a fraction of the width, width in pixels."""
    ys, xs = np.mgrid[0:h, 0:w].astype(float)
    m = np.zeros((h, w))
    for _ in range(n):
        x0, y0 = rng.random() * w, rng.random() * h
        a = rng.random() * math.pi if angle is None else angle + rng.normal(0, 0.12)
        ln = rng.uniform(*length) * w
        d = seg_dist(xs, ys, (x0, y0), (x0 + math.cos(a) * ln, y0 + math.sin(a) * ln))
        m = np.maximum(m, np.exp(-(d / width) ** 2) * rng.uniform(0.4, 1.0))
    return m


def gauss(U, V, u0, v0, ru, rv):
    return np.exp(-(((U - u0) / ru) ** 2 + ((V - v0) / rv) ** 2))


def image(name, rgb, alpha=None, non_color=False):
    h, w, _ = rgb.shape
    a = np.ones((h, w, 1)) if alpha is None else np.clip(alpha, 0, 1)[..., None]
    img = common.image_from_array(name, np.concatenate([np.clip(rgb, 0, 1), a], axis=2))
    if non_color:
        img.colorspace_settings.name = 'Non-Color'
    return img


def mr_image(name, rough, metal):
    """glTF metallic-roughness texture: G = roughness, B = metallic."""
    rgb = np.stack([np.ones_like(rough), np.clip(rough, 0, 1), np.clip(metal, 0, 1)], axis=-1)
    return image(name, rgb, non_color=True)


def normal_image(name, height, du_m, dv_m):
    """Tangent-space normal map (OpenGL, Y+) from a height field in metres; du_m/dv_m = texel size in metres."""
    gx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) / (2 * du_m)
    gy = (np.roll(height, 1, 0) - np.roll(height, -1, 0)) / (2 * dv_m)   # +v is up the image
    n = np.stack([-gx, -gy, np.ones_like(gx)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return image(name, n * 0.5 + 0.5, non_color=True)


def painted_metal(size, rng, base, chip, rust, chip_amount=0.08, rust_amount=0.08, n_scratch=30):
    """Tileable worn paint on steel: (rgb, roughness, metallic)."""
    H = W = size
    mott = fbm(H, W, 3, rng, 5)
    col = srgb(base)[None, None] * (0.92 + 0.16 * mott[..., None])
    grime = fbm(H, W, 5, rng, 4)
    col = col * (1 - 0.12 * smooth(0.5, 0.8, grime))[..., None]
    cn = fbm(H, W, 20, rng, 3) * 0.6 + fbm(H, W, 64, rng, 2) * 0.4
    thr = 0.80 - chip_amount * 0.6
    chips = smooth(thr, thr + 0.015, cn)
    rim = np.clip(smooth(thr - 0.025, thr, cn) - chips, 0, 1)
    rn = fbm(H, W, 6, rng, 5)
    rst = smooth(0.80 - rust_amount, 0.88 - rust_amount, rn) * (0.6 + 0.4 * fbm(H, W, 40, rng, 2))
    scr = scratches(H, W, rng, n_scratch, (0.04, 0.2), 0.6)
    col = lerp(col, col * 0.7, rim * 0.6)
    col = lerp(col, srgb(chip)[None, None] * (0.85 + 0.15 * mott[..., None]), chips)
    col = lerp(col, np.clip(srgb(base) * 1.45, 0, 1), scr * 0.45 * (1 - chips))
    col = lerp(col, srgb(rust), np.clip(rst + chips * smooth(0.5, 0.7, rn) * 0.7, 0, 1) * 0.85)
    rough = 0.55 + 0.1 * mott - 0.2 * chips + 0.3 * rst - 0.1 * scr
    metal = 0.15 + 0.75 * chips * (1 - rst)
    return col, rough, metal


# ----------------------------------------------------------------------------------------------------------------------
# Texture painters (one per textured material)
# ----------------------------------------------------------------------------------------------------------------------

# Dents on the Almond Water bottle: (u around from +X counter-clockwise, v = z / 0.372, radius m, depth m).
# The front (-Y) is u = 0.75.
ALMOND_DENTS = [(0.71, 0.58, 0.022, 0.0050), (0.79, 0.41, 0.018, 0.0042), (0.74, 0.26, 0.021, 0.0046),
                (0.83, 0.66, 0.015, 0.0030), (0.29, 0.47, 0.020, 0.0040), (0.52, 0.20, 0.016, 0.0030)]
ALMOND_PAINT_TOP = 0.372   # z where the painted body ends (the steel neck and cap start)


def tex_almond():
    rng = np.random.default_rng(11)
    H = W = 256
    U, V = grid(H, W)
    C, HM = TAU * 0.1, ALMOND_PAINT_TOP
    dent = np.zeros((H, W))
    for (u0, v0, rad, depth) in ALMOND_DENTS:
        du = ((U - u0 + 0.5) % 1.0 - 0.5) * C
        dv = (V - v0) * HM
        dent += depth * np.exp(-(du ** 2 + dv ** 2) / rad ** 2)
    dent_mask = np.clip(dent / 0.003, 0, 1)
    mott = fbm(H, W, 4, rng, 5)
    col = srgb('#8b8f8a')[None, None] * (0.93 + 0.14 * mott[..., None])
    col = col * (1 - 0.18 * smooth(0.35, 0.0, V))[..., None]           # grime toward the base
    cn = fbm(H, W, 22, rng, 3) * 0.6 + fbm(H, W, 64, rng, 2) * 0.4
    edge = smooth(0.08, 0.0, V) + smooth(0.86, 0.995, V)                  # base rim and shoulder
    thr = 0.73 - 0.17 * edge - 0.07 * dent_mask
    chips = smooth(thr, thr + 0.012, cn)
    rim = np.clip(smooth(thr - 0.02, thr, cn) - chips, 0, 1)
    rn = fbm(H, W, 10, rng, 4)
    rust = smooth(0.07, 0.0, V) * smooth(0.40, 0.60, rn) + chips * smooth(0.62, 0.78, rn) * 0.6
    rust = np.clip(rust, 0, 1)
    scr = scratches(H, W, rng, 22, (0.03, 0.14), 0.6)
    col = lerp(col, srgb('#5c5f5a'), rim * 0.6)
    steel = srgb('#b9bcb8')[None, None] * (0.9 + 0.1 * fbm(H, W, 30, rng, 2))[..., None]
    col = lerp(col, steel, chips)
    col = lerp(col, srgb('#a6aaa4'), scr * 0.5 * (1 - chips))
    col = lerp(col, srgb('#6b4a2e'), rust * 0.85)
    rough = 0.42 + 0.08 * mott - 0.12 * chips + 0.35 * rust - 0.08 * scr
    metal = (0.3 + 0.5 * chips) * (1 - rust)
    height = 0.00025 * (1 - chips) - dent
    return (image('almond_steel_col', col), mr_image('almond_steel_mr', rough, metal),
            normal_image('almond_steel_nrm', height, C / W, HM / H))


def tex_vhs():
    """Atlas: left half black plastic (shell), top right the window with the reels, below it the spine sticker."""
    rng = np.random.default_rng(12)
    S = 256
    U, V = grid(S, S)
    col = srgb('#1b1b1c')[None, None] * (0.85 + 0.3 * fbm(S, S, 64, rng, 2))[..., None]
    dust = smooth(0.55, 0.85, fbm(S, S, 6, rng, 4))
    col = lerp(col, srgb('#5a5650'), dust * 0.25)
    col = lerp(col, srgb('#5d5d5d'), scratches(S, S, rng, 30, (0.03, 0.15), 0.5) * 0.6)
    # Window, u 0.5..1, v 0.75..1, covers x -0.15..0.15, y -0.098..-0.024 of the shell top.
    x = -0.15 + (U - 0.5) / 0.5 * 0.30
    y = -0.098 + (V - 0.75) / 0.25 * 0.074
    win = (U >= 0.5) & (V >= 0.75)
    wcol = srgb('#101012')[None, None] * np.ones((S, S, 1))
    for cx, pack in ((-0.088, 0.050), (0.088, 0.031)):
        r = np.hypot(x - cx, y + 0.040)
        tape = smooth(pack + 0.002, pack - 0.002, r)
        sheen = 0.85 + 0.15 * np.sin(r * 900)
        wcol = lerp(wcol, srgb('#2c2119') * sheen[..., None], tape)
        ang = np.arctan2(y + 0.040, x - cx)
        teeth = (np.cos(ang * 6) > 0.6) & (r > 0.011)
        hub = smooth(0.0175, 0.0165, r) * (1 - teeth * smooth(0.012, 0.013, r))
        wcol = lerp(wcol, srgb('#cfcfc6'), hub)
        wcol = lerp(wcol, srgb('#0c0c0c'), smooth(0.0065, 0.0055, r))
    refl = np.clip(1 - np.abs((x + y * 2.0) - 0.02) / 0.03, 0, 1)
    wcol = lerp(wcol, srgb('#8a8f94'), refl * 0.18)
    col = np.where(win[..., None], wcol, col)
    # Spine sticker, u 0.5..1, v 0.5..0.72.
    stk = (U >= 0.5) & (V >= 0.5) & (V < 0.72)
    paper = srgb('#ddd4b4')[None, None] * (0.92 + 0.12 * fbm(S, S, 8, rng, 4))[..., None]
    ev = np.minimum(np.minimum(U - 0.5, 1 - U) / 0.5, np.minimum(V - 0.5, 0.72 - V) / 0.22)
    paper = paper * (0.82 + 0.18 * smooth(0.0, 0.12, ev))[..., None]
    paper = lerp(paper, srgb('#a99f80'), smooth(0.6, 0.85, fbm(S, S, 5, rng, 3)) * 0.4)
    col = np.where(stk[..., None], paper, col)
    return image('vhs_shell_col', col)


def tex_battery():
    rng = np.random.default_rng(13)
    S = 128
    U, V = grid(S, S)
    col = srgb('#141416')[None, None] * (0.9 + 0.2 * fbm(S, S, 8, rng, 3))[..., None]
    wn = fbm(S, S, 16, rng, 3) * 0.6 + fbm(S, S, 48, rng, 2) * 0.4
    wear = smooth(0.70, 0.73, wn + smooth(0.07, 0.0, V) * 0.3 + smooth(0.93, 1.0, V) * 0.3)
    scr = scratches(S, S, rng, 14, (0.05, 0.25), 0.5)
    col = lerp(col, srgb('#9b9c99'), wear)
    col = lerp(col, srgb('#555658'), scr * 0.6 * (1 - wear))
    rough = 0.32 + 0.1 * wn + 0.1 * scr
    metal = wear
    return image('battery_body_col', col), mr_image('battery_body_mr', rough, metal)


def tex_ammo():
    rng = np.random.default_rng(14)
    col, rough, metal = painted_metal(256, rng, '#50553a', '#77776f', '#5e3b22', chip_amount=0.10, rust_amount=0.06,
                                      n_scratch=36)
    return image('ammo_olive_col', col), mr_image('ammo_olive_mr', rough, metal)


def tex_table_top():
    """Laminate wood grain over the whole top (u = x across 1.15 m, v = y across 0.72 m), chipped at the edges."""
    rng = np.random.default_rng(15)
    S = 512
    U, V = grid(S, S)
    warp = fbm(S, S, 2, rng, 4)
    g = V * 0.72 * 22 + warp * 9.0 + fbm(S, S, 1, rng, 3, aspect=4) * 3.0
    lines = smooth(0.12, 0.0, np.abs((g % 1.0) - 0.5) * 2 - 0.86) * (0.5 + 0.5 * fbm(S, S, 6, rng, 3, aspect=0.2))
    fibre = fbm(S, S, 2, rng, 4, aspect=60)
    broad = fbm(S, S, 1, rng, 3, aspect=3)
    col = srgb('#756b52')[None, None] * (0.86 + 0.12 * broad[..., None] + 0.10 * fibre[..., None]
                                          - 0.08 * lines[..., None])
    col = lerp(col, srgb('#8a8068'), smooth(0.55, 0.8, fbm(S, S, 3, rng, 4)) * 0.35)   # worn, sun-faded patches
    edge = np.minimum(np.minimum(U, 1 - U) * 1.15, np.minimum(V, 1 - V) * 0.72)    # metres from the edge
    cn = fbm(S, S, 20, rng, 4)
    chips = smooth(0.62, 0.66, cn + smooth(0.02, 0.0, edge) * 0.4) * smooth(0.035, 0.0, edge)
    col = lerp(col, srgb('#b0a586'), chips)
    col = lerp(col, srgb('#4e4635'), smooth(0.004, 0.0, edge) * 0.5)
    for (u0, v0, r) in ((0.30, 0.38, 0.035), (0.68, 0.62, 0.03)):              # old mug rings
        d = np.hypot((U - u0) * 1.15, (V - v0) * 0.72)
        ring = np.exp(-((d - r) / 0.003) ** 2) * (0.6 + 0.4 * fbm(S, S, 30, rng, 2))
        col = lerp(col, srgb('#4a3d28'), ring * 0.55 + smooth(r, 0.0, d) * 0.08)
    col = lerp(col, srgb('#9a9078'), scratches(S, S, rng, 40, (0.02, 0.12), 0.6) * 0.35)
    return image('table_top_col', col)


def tex_metal(name, seed, base, chip, rust, chip_amount, rust_amount, size=256):
    col, rough, metal = painted_metal(size, np.random.default_rng(seed), base, chip, rust, chip_amount, rust_amount)
    return image(name + '_col', col), mr_image(name + '_mr', rough, metal)


def tex_door():
    """Planar over the panel: u = x / 1.22, v = z / 2.26."""
    rng = np.random.default_rng(16)
    H, W = 512, 256
    U, V = grid(H, W)
    col = srgb('#c8b994')[None, None] * (0.95 + 0.08 * fbm(H, W, 3, rng, 5, aspect=2)[..., None])
    low = smooth(0.14, 0.0, V)
    scuff = smooth(0.55, 0.75, fbm(H, W, 10, rng, 4, aspect=2)) * low
    col = col * (1 - 0.18 * low - 0.25 * scuff)[..., None]
    col = lerp(col, srgb('#3e3a32'), scratches(H, W, rng, 30, (0.03, 0.12), 0.8, angle=0.0) * low * 0.6)
    hand = gauss(U, V, 0.88, 0.445, 0.07, 0.04) * (0.6 + 0.4 * fbm(H, W, 12, rng, 3, aspect=2))
    col = lerp(col, srgb('#6e6450'), hand * 0.55)
    streak = fbm(H, W, 40, rng, 2, aspect=0.05) * smooth(0.3, 1.0, V)
    col = col * (1 - 0.06 * smooth(0.5, 0.8, streak))[..., None]
    dings = smooth(0.86, 0.9, fbm(H, W, 60, rng, 2, aspect=2))
    col = lerp(col, srgb('#8d8064'), dings * 0.6)
    return image('door_paint_col', col)


def tex_brushed():
    rng = np.random.default_rng(17)
    S = 128
    b = fbm(S, S, 2, rng, 3, aspect=48)
    col = srgb('#c3c5c1')[None, None] * (0.9 + 0.14 * b[..., None])
    col = lerp(col, srgb('#6f706c'), scratches(S, S, rng, 16, (0.1, 0.4), 0.5) * 0.4)
    return image('door_steel_col', col)


def rust_streaks(H, W, rng, sources):
    """Rust running down from sources (u, v_top, length_v, width_px, strength)."""
    m = np.zeros((H, W))
    fine = fbm(H, W, 64, rng, 2, aspect=0.25)
    for (u0, v0, length, width, s) in sources:
        r0 = int((1 - v0) * H)
        r1 = min(H, int((1 - v0 + length) * H))
        if r1 <= r0:
            continue
        rows = np.arange(r0, r1)
        t = (rows - r0) / max(1, r1 - r0)
        wob = np.cumsum(rng.normal(0, 0.35, len(rows)))
        cx = u0 * W + wob
        wid = width * (1 + 1.5 * t)
        cols = np.arange(W)
        d = (cols[None, :] - cx[:, None]) / wid[:, None]
        streak = s * ((1 - t) ** 1.4)[:, None] * np.exp(-d ** 2)
        m[r0:r1] = np.maximum(m[r0:r1], streak)
    return np.clip(m * (0.55 + 0.6 * fine), 0, 1)


def tex_exit_door():
    """Planar over the door: u = (x + 0.84) / 1.68, v = z / 2.4."""
    rng = np.random.default_rng(18)
    S = 512
    U, V = grid(S, S)
    mott = fbm(S, S, 3, rng, 5)
    col = srgb('#3c403a')[None, None] * (0.9 + 0.2 * mott[..., None])
    src = []
    for _ in range(26):                                   # from the top edge
        src.append((rng.random(), 1.0, rng.uniform(0.15, 0.7), rng.uniform(1.5, 5), rng.uniform(0.5, 1.0)))
    for u0 in (0.107, 0.94):                              # under the push bar brackets
        for _ in range(4):
            src.append((u0 + rng.normal(0, 0.02), 0.41, rng.uniform(0.1, 0.35), rng.uniform(1.5, 4), 0.9))
    for v0 in (0.146 + 0.03, 0.5 + 0.03, 0.854 + 0.03):   # under the hinges
        src.append((0.985, v0, rng.uniform(0.15, 0.3), 3, 0.9))
    for _ in range(14):                                   # random weeping spots
        src.append((rng.random(), rng.uniform(0.2, 0.9), rng.uniform(0.05, 0.25), rng.uniform(1, 3), 0.7))
    streaks = rust_streaks(S, S, rng, src)
    rn = fbm(S, S, 8, rng, 5)
    patches = smooth(0.15, 0.0, V) * smooth(0.35, 0.6, rn)
    edge = np.minimum(np.minimum(U, 1 - U), np.minimum(V, 1 - V))
    patches = np.maximum(patches, smooth(0.025, 0.0, edge) * smooth(0.4, 0.6, rn))
    patches = np.maximum(patches, smooth(0.78, 0.86, rn) * 0.8)
    rust = np.clip(streaks * 0.9 + patches, 0, 1)
    rust_col = lerp(srgb('#4a2a17')[None, None] * np.ones((S, S, 1)), srgb('#8a4a20'),
                    fbm(S, S, 20, rng, 3))
    col = lerp(col, col * 0.8, smooth(0.0, 0.3, rust))
    col = lerp(col, rust_col, rust * 0.9)
    col = lerp(col, srgb('#6f746b'), scratches(S, S, rng, 30, (0.02, 0.1), 0.7) * 0.4 * (1 - rust))
    rough = 0.5 + 0.1 * mott + 0.4 * rust
    metal = 0.35 * (1 - rust) + 0.1
    return image('exit_steel_col', col), mr_image('exit_steel_mr', rough, metal)


def tex_troffer_lens():
    """u across 0.66 m, v along 1.28 m. Returns (base colour, emission)."""
    rng = np.random.default_rng(19)
    H, W = 512, 256
    U, V = grid(H, W)
    ys, xs = np.mgrid[0:H, 0:W].astype(float)
    prism = 0.5 + 0.5 * np.sin(TAU * xs / 4) * np.sin(TAU * ys / 4)
    edge = np.minimum(np.minimum(U, 1 - U) * 0.66, np.minimum(V, 1 - V) * 1.28)
    yellow = np.clip(smooth(0.06, 0.0, edge) * 0.8 + smooth(0.55, 0.85, fbm(H, W, 3, rng, 4, aspect=2)) * 0.6, 0, 1)
    col = srgb('#e8e4c8')[None, None] * (0.96 + 0.05 * prism[..., None])
    col = lerp(col, srgb('#cdbd85'), yellow * 0.7)
    stain = fbm(H, W, 2, rng, 4, aspect=2)
    tide = np.exp(-((stain - 0.62) / 0.012) ** 2) * smooth(0.3, 0.0, np.abs(U - 0.2) + np.abs(V - 0.15))
    col = lerp(col, srgb('#9c8550'), np.clip(tide, 0, 1) * 0.6)
    bugs = np.zeros((H, W))
    for _ in range(9):                                     # dead insects lying in the lens
        bx, by = rng.uniform(20, W - 20), rng.uniform(30, H - 30)
        a = rng.random() * math.pi
        ca, sa = math.cos(a), math.sin(a)
        lx, ly = (xs - bx) * ca + (ys - by) * sa, -(xs - bx) * sa + (ys - by) * ca
        body = np.exp(-((lx / rng.uniform(3.5, 6)) ** 2 + (ly / 1.8) ** 2))
        legs = np.zeros((H, W))
        for k in range(6):
            side = 1 if k % 2 else -1
            p0 = (bx + ca * (k // 2 - 1) * 2.5, by + sa * (k // 2 - 1) * 2.5)
            ang = a + side * (math.pi / 2 + rng.normal(0, 0.4))
            p1 = (p0[0] + math.cos(ang) * 6, p0[1] + math.sin(ang) * 6)
            legs = np.maximum(legs, np.exp(-(seg_dist(xs, ys, p0, p1) / 0.6) ** 2) * 0.7)
        bugs = np.maximum(bugs, np.maximum(body, legs))
    specks = smooth(0.9, 0.95, fbm(H, W, 90, rng, 1, aspect=2)) * 0.6
    dark = np.clip(bugs + specks, 0, 1)
    col = lerp(col, srgb('#2c2418'), dark)
    tubes = np.exp(-((U - 0.28) / 0.05) ** 2) + np.exp(-((U - 0.72) / 0.05) ** 2)
    halo = np.exp(-((U - 0.28) / 0.16) ** 2) + np.exp(-((U - 0.72) / 0.16) ** 2)
    ends = smooth(0.0, 0.06, V) * smooth(1.0, 0.94, V)
    glow = (0.55 + 0.25 * halo + 0.35 * tubes * ends) * (1 - 0.25 * yellow)
    em = srgb('#fff4c2')[None, None] * np.clip(glow, 0, 1)[..., None] * (1 - 0.9 * dark)[..., None]
    em = lerp(em, srgb('#b49a5a') * 0.5, np.clip(tide, 0, 1) * 0.5)
    return image('troffer_lens_col', col), image('troffer_lens_emit', em)


def tex_vending_body():
    """Box-projected at 2 m per tile (u = coord / 2 + 0.5, v = z / 2), so the machine never repeats."""
    rng = np.random.default_rng(20)
    S = 512
    U, V = grid(S, S)
    col, rough, metal = painted_metal(S, rng, '#6e1c18', '#4a4a46', '#4f2c18', chip_amount=0.06, rust_amount=0.05,
                                      n_scratch=40)
    low = smooth(0.12, 0.0, V)
    rn = fbm(S, S, 10, rng, 4)
    rust = np.clip(low * smooth(0.35, 0.6, rn), 0, 1)
    col = col * (1 - 0.3 * low)[..., None]
    col = lerp(col, srgb('#5a3018'), rust * 0.8)
    drips = rust_streaks(S, S, rng, [(rng.random(), rng.uniform(0.4, 0.95), rng.uniform(0.1, 0.3),
                                      rng.uniform(1, 3), 0.5) for _ in range(20)])
    col = lerp(col, srgb('#2e1410'), drips * 0.5)
    return image('vending_body_col', col), mr_image('vending_body_mr', rough + 0.3 * rust, metal * (1 - rust))


def tex_vending_glass():
    """u across 0.62 m, v up 1.15 m: frosted backlit panel with blurred bottle silhouettes on four shelves."""
    rng = np.random.default_rng(21)
    H, W = 512, 256
    U, V = grid(H, W)
    glow = 0.75 + 0.25 * np.exp(-((U - 0.5) / 0.45) ** 2) * np.exp(-((V - 0.55) / 0.6) ** 2)
    col = lerp(srgb('#8fd3e6')[None, None] * np.ones((H, W, 1)), srgb('#effdff'), glow)
    sil = np.zeros((H, W))
    shelves = (0.04, 0.29, 0.54, 0.79)
    for s in shelves:
        sil = np.maximum(sil, np.exp(-((V - s) / 0.006) ** 2) * 0.9)
        x = 0.04
        while x < 0.94:
            w = rng.uniform(0.06, 0.09)
            if rng.random() < 0.18:                          # an empty slot
                x += w + 0.03
                continue
            kind = rng.random()
            if kind < 0.7:                                   # bottle: body, shoulder, neck, cap
                h = rng.uniform(0.15, 0.2)
                body = (np.abs(U - x - w / 2) < w / 2) & (V > s) & (V < s + h * 0.62)
                sh = np.clip((V - (s + h * 0.62)) / (h * 0.16), 0, 1)
                shoulder = (np.abs(U - x - w / 2) < w / 2 * (1 - 0.65 * sh)) & (V >= s + h * 0.62) & (V < s + h * 0.78)
                neck = (np.abs(U - x - w / 2) < w * 0.17) & (V >= s + h * 0.78) & (V < s + h)
                shape = body | shoulder | neck
            else:                                            # can
                h = rng.uniform(0.08, 0.1)
                shape = (np.abs(U - x - w / 2) < w * 0.42) & (V > s) & (V < s + h)
            sil = np.maximum(sil, shape * rng.uniform(0.55, 0.85))
            x += w + rng.uniform(0.015, 0.04)
    sil = blur(sil, 4)
    col = lerp(col, srgb('#5d8c99'), sil)
    col = col * (1 - 0.25 * smooth(0.06, 0.0, V) - 0.15 * smooth(0.5, 0.9, fbm(H, W, 4, rng, 4)))[..., None]
    return image('vending_glass_col', col)


def tex_vending_panel():
    """u across 0.16 m, v up 0.5 m: display, coin slot, selection keypad, coin return."""
    rng = np.random.default_rng(22)
    H, W = 512, 128
    U, V = grid(H, W)
    col = srgb('#2b2a28')[None, None] * (0.9 + 0.2 * fbm(H, W, 8, rng, 3, aspect=4))[..., None]

    def rect(u0, u1, v0, v1):
        return (U >= u0) & (U <= u1) & (V >= v0) & (V <= v1)

    col = np.where(rect(0.14, 0.86, 0.86, 0.95)[..., None], srgb('#1c2a1e'), col)       # display
    col = np.where(rect(0.18, 0.82, 0.875, 0.935)[..., None], srgb('#2f4a32'), col)
    col = np.where(rect(0.3, 0.7, 0.74, 0.82)[..., None], srgb('#8c8e8a'), col)          # coin slot plate
    col = np.where(rect(0.47, 0.53, 0.755, 0.805)[..., None], srgb('#050505'), col)
    for r in range(4):                                                                  # 3 x 4 keys
        for c in range(3):
            u0, v0 = 0.14 + c * 0.25, 0.62 - r * 0.075
            col = np.where(rect(u0 - 0.01, u0 + 0.21, v0 - 0.008, v0 + 0.058)[..., None], srgb('#111111'), col)
            col = np.where(rect(u0, u0 + 0.2, v0, v0 + 0.05)[..., None], srgb('#a4a49e'), col)
    d = np.hypot((U - 0.5) * 0.16, (V - 0.27) * 0.5)
    col = lerp(col, srgb('#8c8e8a'), smooth(0.013, 0.011, d))
    col = lerp(col, srgb('#1a1a1a'), smooth(0.006, 0.004, d))
    col = lerp(col, srgb('#0a0a0a'), rect(0.2, 0.8, 0.08, 0.16) * 1.0)                    # coin return cup
    col = lerp(col, srgb('#6b6a64'), scratches(H, W, rng, 12, (0.1, 0.5), 0.5) * 0.4)
    return image('vending_panel_col', col)


def tex_cooler():
    """Box-projected at 1 m (u = coord + 0.5, v = z)."""
    rng = np.random.default_rng(23)
    S = 256
    U, V = grid(S, S)
    col = srgb('#d9d5c6')[None, None] * (0.94 + 0.1 * fbm(S, S, 4, rng, 5)[..., None])
    yel = smooth(0.5, 0.85, fbm(S, S, 3, rng, 4)) * 0.5 + smooth(0.2, 0.0, V) * 0.4
    col = lerp(col, srgb('#b9ad86'), yel)
    drips = rust_streaks(S, S, rng, [(0.445 + rng.normal(0, 0.006), 0.6, rng.uniform(0.1, 0.25), 1.2, 0.6)
                                     for _ in range(3)] +
                         [(0.555 + rng.normal(0, 0.006), 0.6, rng.uniform(0.1, 0.25), 1.2, 0.6) for _ in range(3)])
    col = lerp(col, srgb('#8c7c58'), drips * 0.6)
    scuff = smooth(0.09, 0.0, V) * smooth(0.45, 0.7, fbm(S, S, 16, rng, 3))
    col = lerp(col, srgb('#5e5848'), scuff * 0.7)
    for v0 in (0.58, 0.06):                                                            # panel seams
        col = lerp(col, srgb('#7a7666'), np.exp(-((V - v0) * S / 0.8) ** 2) * 0.8)
    col = lerp(col, srgb('#8a8676'), scratches(S, S, rng, 16, (0.03, 0.12), 0.6) * 0.4)
    return image('cooler_body_col', col)


def tex_cone():
    """u around, v = (z - 0.04) / 0.54."""
    rng = np.random.default_rng(24)
    H, W = 256, 128
    U, V = grid(H, W)
    col = srgb('#d2601c')[None, None] * (0.9 + 0.16 * fbm(H, W, 4, rng, 4, aspect=2)[..., None])
    band = smooth(0.53, 0.535, V) * smooth(0.665, 0.66, V)
    col = lerp(col, srgb('#d8d3c4') * (0.85 + 0.15 * fbm(H, W, 12, rng, 3, aspect=2))[..., None], band)
    dust = smooth(0.25, 0.0, V) * 0.6 + smooth(0.6, 0.85, fbm(H, W, 6, rng, 4, aspect=2)) * 0.4
    col = lerp(col, srgb('#7a6a55'), dust * 0.5)
    col = lerp(col, srgb('#3a2c22'), scratches(H, W, rng, 26, (0.05, 0.3), 0.7) * 0.6)
    col = col * (1 - 0.25 * smooth(0.06, 0.0, V))[..., None]
    return image('cone_orange_col', col)


TILE_N, TILE_HALF = 5, 0.34
TILE_CRACK = [3, 3, 2, 2, 1]        # per grid column: the grid row line the crack runs along


def tile_layout():
    """Jittered 5 x 5 grid of the fallen tile (shared by its texture and its mesh) and the crack path."""
    rng = np.random.default_rng(5)
    n, half = TILE_N, TILE_HALF
    xs = [-half + i * 2 * half / n for i in range(n + 1)]
    P = {}
    for i in range(n + 1):
        for j in range(n + 1):
            jx = 0.0 if i in (0, n) else rng.uniform(-0.03, 0.03)
            jy = 0.0 if j in (0, n) else rng.uniform(-0.03, 0.03)
            P[i, j] = [xs[i] + jx, xs[j] + jy]
    for i in range(1, n):                   # slant the crack's steps so they do not turn at right angles
        a, b = TILE_CRACK[i - 1], TILE_CRACK[i]
        if a != b:
            P[i, a][0] = xs[i] - 0.045
            P[i, b][0] = xs[i] + 0.045
    path = [(0, TILE_CRACK[0])]
    for i in range(n):
        if path[-1][1] != TILE_CRACK[i]:
            path.append((i, TILE_CRACK[i]))
        path.append((i + 1, TILE_CRACK[i]))
    return P, path


def tex_tile():
    """Planar over the tile (0.68 m): mineral fibre with fissures, a water stain and crumbled crack edges."""
    rng = np.random.default_rng(25)
    S = 256
    U, V = grid(S, S)
    P, path = tile_layout()
    col = srgb('#c8c2a6')[None, None] * (0.94 + 0.1 * fbm(S, S, 8, rng, 4)[..., None])
    fis = smooth(0.66, 0.70, fbm(S, S, 24, rng, 3, aspect=0.5)) + smooth(0.7, 0.74, fbm(S, S, 30, rng, 3, aspect=2))
    pits = smooth(0.82, 0.88, fbm(S, S, 110, rng, 1))
    col = lerp(col, srgb('#8e8973'), np.clip(fis * 0.6 + pits * 0.7, 0, 1))
    st = fbm(S, S, 2, rng, 5) + 0.35 * gauss(U, V, 0.35, 0.62, 0.35, 0.35)
    inside = smooth(0.62, 0.66, st)
    tide = np.exp(-((st - 0.64) / 0.01) ** 2)
    col = lerp(col, srgb('#b7a678'), inside * 0.45)
    col = lerp(col, srgb('#7d6a40'), tide * 0.6)
    edge = np.minimum(np.minimum(U, 1 - U), np.minimum(V, 1 - V))
    col = col * (1 - 0.2 * smooth(0.03, 0.0, edge))[..., None]
    ys, xs = np.mgrid[0:S, 0:S].astype(float)
    d = np.full((S, S), 1e9)
    pix = [((P[k][0] / (2 * TILE_HALF) + 0.5) * S, (0.5 - P[k][1] / (2 * TILE_HALF)) * S) for k in path]
    for a, b in zip(pix[:-1], pix[1:]):
        d = np.minimum(d, seg_dist(xs, ys, a, b))
    crumble = smooth(5.0, 1.0, d + 3.0 * fbm(S, S, 40, rng, 2))
    col = lerp(col, srgb('#6f6955'), crumble * 0.55)
    return image('fallen_tile_col', col)


def tex_neon_face():
    """Placeholder for the code's OPEN texture: abstract pink tube loops on transparent (u across 1.08 m)."""
    rng = np.random.default_rng(26)
    H, W = 256, 512
    ys, xs = np.mgrid[0:H, 0:W].astype(float)
    d = np.full((H, W), 1e9)
    for k in range(2):
        x0 = 30 + k * 245
        ctrl = [(x0 + rng.uniform(-6, 6), rng.uniform(80, 176))]
        for _ in range(12):
            px, py = ctrl[-1]
            ctrl.append((np.clip(px + rng.uniform(-6, 32), 20, W - 20), np.clip(py + rng.uniform(-60, 60), 40, 216)))
        pts = []
        for i in range(len(ctrl) - 1):                          # Catmull-Rom through the control points
            p0, p1 = np.array(ctrl[max(i - 1, 0)]), np.array(ctrl[i])
            p2, p3 = np.array(ctrl[i + 1]), np.array(ctrl[min(i + 2, len(ctrl) - 1)])
            for t in np.linspace(0, 1, 12, endpoint=False):
                pts.append(0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                                  + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
        pts.append(np.array(ctrl[-1]))
        for a, b in zip(pts[:-1], pts[1:]):
            d = np.minimum(d, seg_dist(xs, ys, a, b))
    core = np.exp(-(d / 1.6) ** 2)
    tube = np.exp(-(d / 3.6) ** 2)
    halo = np.exp(-(d / 14.0) ** 2)
    col = lerp(srgb('#ff3d9a')[None, None] * np.ones((H, W, 1)), srgb('#ffe0f0'), core)
    alpha = np.clip(tube + halo * 0.45, 0, 1)
    return image('neon_face_col', col, alpha=alpha)


def tex_crt_static():
    rng = np.random.default_rng(27)
    S = 128
    n = rng.random((S, S)) * 0.7 + 0.3 * rng.random((S, 1))
    n = n * np.where(np.arange(S) % 2 == 0, 1.0, 0.7)[:, None]
    col = srgb('#7dffa8')[None, None] * (0.25 + 0.75 * n[..., None])
    return image('crt_screen_static', col)


def tex_board():
    rng = np.random.default_rng(28)
    col, rough, metal = painted_metal(256, rng, '#1a1611', '#3a3631', '#5a3218', chip_amount=0.05, rust_amount=0.08,
                                      n_scratch=20)
    return image('neon_board_col', col)


# ----------------------------------------------------------------------------------------------------------------------
# Materials
# ----------------------------------------------------------------------------------------------------------------------

def tex_node(mat, img):
    for n in mat.node_tree.nodes:
        if n.type == 'TEX_IMAGE' and n.image == img:
            return n
    n = mat.node_tree.nodes.new('ShaderNodeTexImage')
    n.image = img
    return n


def make_mat(name, color='#808080', metallic=0.0, roughness=0.6, base=None, mr=None, normal=None, normal_strength=1.0,
             emission=None, emission_strength=1.0, emission_image=None, alpha=None, alpha_from_base=False):
    """common.material plus a metallic-roughness texture (G, B), an emission texture and alpha from the base."""
    m = common.material(name, color=lin(color), metallic=metallic, roughness=roughness,
                        emission=lin(emission) if emission else None, emission_strength=emission_strength,
                        alpha=alpha, base_image=base, normal_image=normal, normal_strength=normal_strength)
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    if mr is not None:
        tex = tex_node(m, mr)
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(tex.outputs['Color'], sep.inputs['Color'])
        nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
        nt.links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    if emission_image is not None:
        nt.links.new(tex_node(m, emission_image).outputs['Color'], bsdf.inputs['Emission Color'])
        bsdf.inputs['Emission Strength'].default_value = emission_strength
    if alpha_from_base:
        nt.links.new(tex_node(m, base).outputs['Alpha'], bsdf.inputs['Alpha'])
        m.blend_method = 'BLEND'
    return m


def build_materials():
    M = {}
    col, mr, nrm = tex_almond()
    M['almond_steel'] = make_mat('almond_steel', base=col, mr=mr, normal=nrm)
    M['almond_cap'] = make_mat('almond_cap', '#b9bcb8', metallic=1.0, roughness=0.38)
    M['vhs_shell'] = make_mat('vhs_shell', base=tex_vhs(), roughness=0.42)
    M['vhs_label'] = make_mat('vhs_label', '#e2dabd', roughness=0.85)
    col, mr = tex_battery()
    M['battery_body'] = make_mat('battery_body', base=col, mr=mr)
    M['battery_band'] = make_mat('battery_band', '#e8b838', roughness=0.4, emission='#e8b838', emission_strength=1.0)
    col, mr = tex_ammo()
    M['ammo_olive'] = make_mat('ammo_olive', base=col, mr=mr)
    M['table_top'] = make_mat('table_top', base=tex_table_top(), roughness=0.5)
    col, mr = tex_metal('table_metal', 31, '#3c403a', '#8b8d88', '#5a3a22', 0.07, 0.04)
    M['table_metal'] = make_mat('table_metal', base=col, mr=mr)
    col, mr = tex_metal('cart_metal', 32, '#5d5f59', '#9a9c97', '#5e3a20', 0.08, 0.10)
    M['cart_metal'] = make_mat('cart_metal', base=col, mr=mr)
    M['door_paint'] = make_mat('door_paint', base=tex_door(), roughness=0.6)
    M['door_steel'] = make_mat('door_steel', base=tex_brushed(), metallic=1.0, roughness=0.32)
    col, mr = tex_exit_door()
    M['exit_steel'] = make_mat('exit_steel', base=col, mr=mr)
    col, mr = tex_metal('exit_frame', 33, '#242622', '#5a5c58', '#5a3018', 0.06, 0.12)
    M['exit_frame'] = make_mat('exit_frame', base=col, mr=mr)
    M['exit_beacon'] = make_mat('exit_beacon', '#ff3b30', roughness=0.3, emission='#ff3b30', emission_strength=1.0)
    M['exit_hardware'] = make_mat('exit_hardware', '#6c6e68', metallic=0.7, roughness=0.5)
    M['troffer_frame'] = make_mat('troffer_frame', '#dcd7c0', metallic=0.2, roughness=0.55)
    col, em = tex_troffer_lens()
    M['troffer_lens'] = make_mat('troffer_lens', base=col, roughness=0.35, emission_image=em, emission_strength=1.0)
    col, mr = tex_vending_body()
    M['vending_body'] = make_mat('vending_body', base=col, mr=mr)
    glass = tex_vending_glass()
    M['vending_glass'] = make_mat('vending_glass', base=glass, roughness=0.15, emission_image=glass,
                                  emission_strength=1.0)
    M['vending_panel'] = make_mat('vending_panel', base=tex_vending_panel(), roughness=0.5, metallic=0.2)
    M['cooler_body'] = make_mat('cooler_body', base=tex_cooler(), roughness=0.62)
    M['cooler_bottle'] = make_mat('cooler_bottle', '#4a8fd0', roughness=0.1, emission='#2a78c8',
                                  emission_strength=0.55, alpha=0.75)
    M['crt_tv'] = make_mat('crt_tv', '#34332e', roughness=0.6)
    static = tex_crt_static()
    M['crt_screen'] = make_mat('crt_screen', base=static, roughness=0.2, emission_image=static, emission_strength=0.7)
    M['neon_board'] = make_mat('neon_board', base=tex_board(), metallic=0.3, roughness=0.8)
    neon = tex_neon_face()
    M['neon_face'] = make_mat('neon_face', base=neon, roughness=0.3, emission_image=neon, alpha_from_base=True)
    M['cone_orange'] = make_mat('cone_orange', base=tex_cone(), roughness=0.55)
    M['fallen_tile'] = make_mat('fallen_tile', base=tex_tile(), roughness=0.95)
    M['steel_bare'] = make_mat('steel_bare', '#a7aaa5', metallic=1.0, roughness=0.4)
    M['rubber_black'] = make_mat('rubber_black', '#171716', roughness=0.85)
    M['plastic_dark'] = make_mat('plastic_dark', '#262624', roughness=0.55)
    return M


# ----------------------------------------------------------------------------------------------------------------------
# Mesh building
# ----------------------------------------------------------------------------------------------------------------------

class MB:
    """Accumulates primitives (with UVs and material slots) into one bmesh, then becomes one object."""

    def __init__(self):
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new('UVMap')
        self.mats = []
        self._before = set()

    def mi(self, mat):
        if mat not in self.mats:
            self.mats.append(mat)
        return self.mats.index(mat)

    def begin(self):
        self._before = set(self.bm.faces)

    def end(self, mat, uv=None):
        faces = [f for f in self.bm.faces if f not in self._before]
        idx = self.mi(mat) if mat is not None else 0
        for f in faces:
            f.normal_update()
            if mat is not None:
                f.material_index = idx
        if uv is not None:
            uv(faces, self.uv)
        return faces


def uv_box(scale=1.0, off=(0.0, 0.0)):
    """Box projection in prop space: uv = coordinate / scale + offset."""
    def f(faces, layer):
        for face in faces:
            n = face.normal
            ax = max(range(3), key=lambda i: abs(n[i]))
            for loop in face.loops:
                x, y, z = loop.vert.co
                if ax == 2:
                    a, b = x, y
                elif ax == 1:
                    a, b = (x if n.y < 0 else -x), z
                else:
                    a, b = (y if n.x > 0 else -y), z
                loop[layer].uv = (a / scale + off[0], b / scale + off[1])
    return f


def uv_planar(fu, fv):
    def f(faces, layer):
        for face in faces:
            for loop in face.loops:
                co = loop.vert.co
                loop[layer].uv = (fu(co), fv(co))
    return f


def uv_cyl(z0, z1, cx=0.0, cy=0.0):
    """u = angle around (cx, cy) / 2pi, v = (z - z0) / (z1 - z0); faces across the seam are unwrapped."""
    def f(faces, layer):
        for face in faces:
            us = []
            for loop in face.loops:
                x, y, _ = loop.vert.co
                r = math.hypot(x - cx, y - cy)
                us.append(None if r < 1e-6 else (math.atan2(y - cy, x - cx) / TAU) % 1.0)
            known = [u for u in us if u is not None]
            if known and max(known) - min(known) > 0.5:
                us = [None if u is None else (u + 1.0 if u < 0.5 else u) for u in us]
                known = [u for u in us if u is not None]
            avg = sum(known) / len(known) if known else 0.0
            for loop, u in zip(face.loops, us):
                loop[layer].uv = (avg if u is None else u, (loop.vert.co.z - z0) / (z1 - z0))
    return f


def add_box(mb, size, center, mat, bevel=0.0, seg=1, uv=None, edge_filter=None):
    mb.begin()
    m = Matrix.Translation(center) @ Matrix.Diagonal((size[0], size[1], size[2], 1.0))
    verts = bmesh.ops.create_cube(mb.bm, size=1.0, matrix=m)['verts']
    if bevel > 0:
        mb.bm.edges.index_update()
        edges = sorted({e for v in verts for e in v.link_edges}, key=lambda e: e.index)   # stable order
        if edge_filter is not None:
            edges = [e for e in edges if edge_filter(e)]
        if edges:
            bmesh.ops.bevel(mb.bm, geom=edges, offset=bevel, offset_type='OFFSET', segments=seg, profile=0.5,
                            affect='EDGES', clamp_overlap=True)
    return mb.end(mat, uv if uv is not None else uv_box())


def vertical_edges(e):
    a, b = e.verts[0].co, e.verts[1].co
    return abs(a.z - b.z) > 1e-5 and abs(a.x - b.x) < 1e-5 and abs(a.y - b.y) < 1e-5


AXIS_ROT = {'Z': Matrix.Identity(4), 'X': Matrix.Rotation(math.pi / 2, 4, 'Y'),
            'Y': Matrix.Rotation(-math.pi / 2, 4, 'X')}


def add_cyl(mb, r, h, center, mat, segs=16, axis='Z', r2=None, caps=True, uv=None):
    """Cylinder (or cone frustum: r at the -axis end, r2 at the +axis end) centred on `center`."""
    mb.begin()
    m = Matrix.Translation(center) @ AXIS_ROT[axis]
    bmesh.ops.create_cone(mb.bm, cap_ends=caps, cap_tris=False, segments=segs, radius1=r,
                          radius2=r if r2 is None else r2, depth=h, matrix=m)
    return mb.end(mat, uv if uv is not None else uv_box(0.5))


def add_lathe(mb, profile, segs, mat_fn, center=(0.0, 0.0, 0.0), v_fn=None):
    """Surface of revolution about the z axis. profile: (r, z) from the bottom pole up the outside to the top;
    r = 0 makes a pole. mat_fn(k) gives the material of the band between profile points k and k + 1."""
    bm = mb.bm
    cx, cy, cz = center
    v_fn = v_fn or (lambda r, z: z)
    rings = []
    for (r, z) in profile:
        if r < 1e-7:
            rings.append([bm.verts.new((cx, cy, cz + z))])
        else:
            rings.append([bm.verts.new((cx + r * math.cos(TAU * i / segs), cy + r * math.sin(TAU * i / segs), cz + z))
                          for i in range(segs)])
    faces = []
    for k in range(len(rings) - 1):
        A, B = rings[k], rings[k + 1]
        va, vb = v_fn(*profile[k]), v_fn(*profile[k + 1])
        idx = mb.mi(mat_fn(k))
        for i in range(segs):
            j = (i + 1) % segs
            ui, uj = i / segs, (i + 1) / segs
            if len(A) == 1:
                vs, uvs = (A[0], B[j], B[i]), ((ui + 0.5 / segs, va), (uj, vb), (ui, vb))
            elif len(B) == 1:
                vs, uvs = (A[i], A[j], B[0]), ((ui, va), (uj, va), (ui + 0.5 / segs, vb))
            else:
                vs, uvs = (A[i], A[j], B[j], B[i]), ((ui, va), (uj, va), (uj, vb), (ui, vb))
            f = bm.faces.new(vs)
            f.material_index = idx
            for loop, uv in zip(f.loops, uvs):
                loop[mb.uv].uv = uv
            faces.append(f)
    return faces, rings


def fillet(points, radius, steps=3):
    """Round the inner corners of a polyline with quadratic Bezier arcs."""
    pts = [Vector(p) for p in points]
    out = [pts[0]]
    for i in range(1, len(pts) - 1):
        P, A, C = pts[i], pts[i - 1], pts[i + 1]
        da, dc = A - P, C - P
        p1 = P + da.normalized() * min(radius, da.length * 0.5)
        p2 = P + dc.normalized() * min(radius, dc.length * 0.5)
        for s in range(steps + 1):
            t = s / steps
            out.append((1 - t) ** 2 * p1 + 2 * (1 - t) * t * P + t * t * p2)
    out.append(pts[-1])
    return out


def add_tube(mb, pts, r, mat, sides=6, caps=True, v_scale=0.2):
    """Tube of radius r swept along a polyline (parallel-transport frames)."""
    bm = mb.bm
    pts = [Vector(p) for p in pts]
    n = len(pts)
    T = []
    for i in range(n):
        if i == 0:
            d = pts[1] - pts[0]
        elif i == n - 1:
            d = pts[-1] - pts[-2]
        else:
            d = (pts[i + 1] - pts[i]).normalized() + (pts[i] - pts[i - 1]).normalized()
        T.append(d.normalized())
    ref = Vector((0, 0, 1)) if abs(T[0].z) < 0.9 else Vector((1, 0, 0))
    N = T[0].cross(ref).normalized()
    rings, vs_len, acc = [], [], 0.0
    for i in range(n):
        if i > 0:
            N = (N - T[i] * N.dot(T[i])).normalized()
            acc += (pts[i] - pts[i - 1]).length
        B = T[i].cross(N)
        # Keep the radius at a bend: stretch the ring along the bend direction by 1 / cos(half angle).
        scale = 1.0
        if 0 < i < n - 1:
            cosang = max(0.3, (pts[i + 1] - pts[i]).normalized().dot(T[i]))
            scale = 1.0 / cosang
        bend = None
        if 0 < i < n - 1:
            bd = (pts[i + 1] - pts[i]).normalized() - (pts[i] - pts[i - 1]).normalized()
            bend = bd.normalized() if bd.length > 1e-6 else None
        ring = []
        for k in range(sides):
            a = TAU * k / sides
            off = (N * math.cos(a) + B * math.sin(a)) * r
            if bend is not None:
                off = off + bend * off.dot(bend) * (scale - 1.0)
            ring.append(bm.verts.new(pts[i] + off))
        rings.append(ring)
        vs_len.append(acc / v_scale)
    idx = mb.mi(mat)
    for i in range(n - 1):
        for k in range(sides):
            j = (k + 1) % sides
            f = bm.faces.new((rings[i][k], rings[i][j], rings[i + 1][j], rings[i + 1][k]))
            f.material_index = idx
            for loop, uv in zip(f.loops, ((k / sides, vs_len[i]), ((k + 1) / sides, vs_len[i]),
                                          ((k + 1) / sides, vs_len[i + 1]), (k / sides, vs_len[i + 1]))):
                loop[mb.uv].uv = uv
    if caps:
        for ring, rev in ((rings[0], True), (rings[-1], False)):
            f = bm.faces.new(list(reversed(ring)) if rev else ring)
            f.material_index = idx
            for loop in f.loops:
                loop[mb.uv].uv = (0.5, 0.5)


def add_poly(mb, verts, mat, uvs):
    mb.begin()
    f = mb.bm.faces.new([mb.bm.verts.new(v) for v in verts])
    for loop, uv in zip(f.loops, uvs):
        loop[mb.uv].uv = uv
    return mb.end(mat)


def rrect(w, h, r, n=3):
    """Rounded rectangle outline in 2D, counter-clockwise, centred on 0."""
    pts = []
    for cx, cy, a0 in ((w / 2 - r, -h / 2 + r, -90), (w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90),
                       (-w / 2 + r, -h / 2 + r, 180)):
        for k in range(n + 1):
            a = math.radians(a0 + 90 * k / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def front_loop(pts2d, cx, y, cz):
    """2D outline (a, b) -> points in the XZ plane at depth y (CCW seen from -Y, the front)."""
    return [Vector((cx + a, y, cz + b)) for a, b in pts2d]


def add_loft(mb, loops, mat, cap_start=False, cap_end=False, uv=None):
    """Bridge consecutive closed loops. Loops run counter-clockwise seen from the side the faces should face when the
    profile goes from the outer back edge to the front and then inwards (the same rule as add_lathe)."""
    mb.begin()
    bm = mb.bm
    V = [[bm.verts.new(p) for p in loop] for loop in loops]
    n = len(loops[0])
    for k in range(len(V) - 1):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((V[k][i], V[k][j], V[k + 1][j], V[k + 1][i]))
    if cap_start:
        bm.faces.new(list(reversed(V[0])))
    if cap_end:
        bm.faces.new(V[-1])
    return mb.end(mat, uv if uv is not None else uv_box())


def add_ring_bezel(mb, outer, inner, cx, cz, y_back, y_front, y_inner_back, mat, uv=None):
    """Raised rounded-rectangle frame on a front (-Y) face: outer wall, front face, inner wall."""
    return add_loft(mb, [front_loop(outer, cx, y_back, cz), front_loop(outer, cx, y_front, cz),
                         front_loop(inner, cx, y_front, cz), front_loop(inner, cx, y_inner_back, cz)], mat, uv=uv)


def canonicalize(bm, uv):
    """Put vertices, faces and each face's first loop in an order that depends only on the geometry. Blender's bevel
    walks hash tables keyed by memory address, so without this two runs give the same mesh in a different order."""
    order = sorted(bm.verts, key=lambda v: (round(v.co.x, 6), round(v.co.y, 6), round(v.co.z, 6)))
    rank = {v: i for i, v in enumerate(order)}
    bm.verts.sort(key=lambda v: rank[v])          # bmesh sort keys must be numbers
    bm.verts.index_update()
    faces = []
    for f in bm.faces:
        loops = list(f.loops)
        k = min(range(len(loops)), key=lambda i: loops[i].vert.index)
        loops = loops[k:] + loops[:k]
        faces.append(([lp.vert for lp in loops], [tuple(lp[uv].uv) for lp in loops], f.material_index))
    for f in list(bm.faces):
        bm.faces.remove(f)
    faces.sort(key=lambda d: (d[2], sorted(v.index for v in d[0]), [v.index for v in d[0]]))
    for verts, uvs, mi in faces:
        f = bm.faces.new(verts)
        f.material_index = mi
        for lp, t in zip(f.loops, uvs):
            lp[uv].uv = t
    order = sorted(bm.edges, key=lambda e: sorted(v.index for v in e.verts))
    rank = {e: i for i, e in enumerate(order)}
    bm.edges.sort(key=lambda e: rank[e])


def finish(name, mb, parent, sharp_deg=40.0):
    me = bpy.data.meshes.new(name)
    canonicalize(mb.bm, mb.uv)
    mb.bm.normal_update()
    mb.bm.to_mesh(me)
    mb.bm.free()
    for m in mb.mats:
        me.materials.append(m)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.parent = parent
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(sharp_deg))
    me.validate()
    return ob


# ----------------------------------------------------------------------------------------------------------------------
# Props
# ----------------------------------------------------------------------------------------------------------------------

def build_almond_water(M):
    root = common.empty('prop_almond_water')
    mb = MB()
    steel, cap = M['almond_steel'], M['almond_cap']
    body = [(0, 0), (0.092, 0), (0.1, 0.008), (0.1, 0.06), (0.1, 0.11), (0.1, 0.16), (0.1, 0.21), (0.1, 0.26),
            (0.0985, 0.295), (0.094, 0.315), (0.083, 0.333), (0.066, 0.348), (0.049, 0.358), (0.036, 0.366)]
    faces, rings = add_lathe(mb, body, 20, lambda k: steel, v_fn=lambda r, z: z / ALMOND_PAINT_TOP)
    C = TAU * 0.1
    for ring in rings[3:8]:                                   # shallow dents (the normal map does the rest)
        for v in ring:
            r = math.hypot(v.co.x, v.co.y)
            u = (math.atan2(v.co.y, v.co.x) / TAU) % 1.0
            push = 0.0
            for (u0, v0, rad, depth) in ALMOND_DENTS:
                du = ((u - u0 + 0.5) % 1.0 - 0.5) * C
                dz = v.co.z - v0 * ALMOND_PAINT_TOP
                push += 0.6 * depth * math.exp(-(du * du + dz * dz) / (rad * rad * 1.6))
            v.co.x *= (r - push) / r
            v.co.y *= (r - push) / r
    capp = [(0.034, 0.36), (0.037, 0.368), (0.0375, 0.376), (0.0355, 0.379), (0.0375, 0.382), (0.0355, 0.385),
            (0.04, 0.389), (0.04, 0.408), (0.0365, 0.4145), (0, 0.415)]
    add_lathe(mb, capp, 12, lambda k: cap)
    # Fold-down bail: pivots on the cap sides, folded forward and down onto the shoulder.
    hz, th, L, xw = 0.398, math.radians(122), 0.056, 0.047
    d = Vector((0.0, -math.sin(th), math.cos(th)))

    def P(x, s):
        return Vector((x, 0.0, hz)) + d * s

    path = [Vector((-0.039, 0, hz)), P(-xw, 0), P(-xw, L), P(xw, L), P(xw, 0), Vector((0.039, 0, hz))]
    add_tube(mb, fillet(path, 0.012, 2), 0.0034, cap, sides=5)
    for sx in (-1, 1):
        add_box(mb, (0.006, 0.012, 0.014), (sx * 0.0415, 0, hz), cap)
    finish('prop_almond_water_mesh', mb, root)
    return root


def build_vhs(M):
    root = common.empty('prop_vhs')
    mb = MB()
    shell = M['vhs_shell']
    X, Y, Z = 0.36, 0.2195, 0.0545

    def uv_shell(faces, layer):
        for face in faces:
            n = face.normal
            ax = max(range(3), key=lambda i: abs(n[i]))
            for loop in face.loops:
                x, y, z = loop.vert.co
                if ax == 2:
                    uv = ((x + X / 2) / X * 0.5, (y + 0.1095) / Y)
                elif ax == 1:
                    uv = ((x + X / 2) / X * 0.5, z / Z * 0.25)
                else:
                    uv = ((y + 0.1095) / Y * 0.5, z / Z * 0.25)
                loop[layer].uv = uv
    add_box(mb, (X, Y, Z), (0, 0.00025, Z / 2), shell, bevel=0.003, seg=2, uv=uv_shell)   # y -0.1095..0.11
    zt = 0.055
    add_poly(mb, [(-0.15, -0.098, zt), (0.15, -0.098, zt), (0.15, -0.024, zt), (-0.15, -0.024, zt)], shell,
             [(0.5, 0.75), (1.0, 0.75), (1.0, 1.0), (0.5, 1.0)])               # window with the reels
    ys = -0.11
    add_poly(mb, [(-0.15, ys, 0.008), (0.15, ys, 0.008), (0.15, ys, 0.047), (-0.15, ys, 0.047)], shell,
             [(0.5, 0.5), (1.0, 0.5), (1.0, 0.72), (0.5, 0.72)])               # spine sticker on the front edge
    finish('prop_vhs_shell', mb, root)
    lb = MB()
    add_poly(lb, [(-0.13, -0.01, zt), (0.13, -0.01, zt), (0.13, 0.10, zt), (-0.13, 0.10, zt)], M['vhs_label'],
             [(0, 0), (1, 0), (1, 1), (0, 1)])
    finish('vhs_label', lb, root)
    return root


def build_battery(M):
    root = common.empty('prop_battery')
    mb = MB()
    body, steel = M['battery_body'], M['steel_bare']
    R = 0.0494
    prof = [(0, 0), (0.043, 0), (R, 0.005), (R, 0.166), (0.048, 0.1705), (0.045, 0.172),
            (0.022, 0.1725), (0.017, 0.1735), (0.017, 0.179), (0.0145, 0.18), (0, 0.18)]
    add_lathe(mb, prof, 20, lambda k: steel if k == 0 or k >= 5 else body, v_fn=lambda r, z: z / 0.18)
    finish('prop_battery_mesh', mb, root)
    bb = MB()
    z0, z1 = 0.55 * 0.18, 0.75 * 0.18
    add_lathe(bb, [(R, z0), (0.05, z0 + 0.001), (0.05, z1 - 0.001), (R, z1)], 20, lambda k: M['battery_band'],
              v_fn=lambda r, z: (z - z0) / (z1 - z0))
    finish('battery_band', bb, root)
    return root


def build_ammo_can(M):
    root = common.empty('prop_ammo_can')
    mb = MB()
    olive = M['ammo_olive']
    uv = uv_box(0.5)
    add_box(mb, (0.42, 0.24, 0.19), (0, 0, 0.095), olive, bevel=0.006, seg=2, uv=uv)
    add_box(mb, (0.43, 0.25, 0.043), (0, 0, 0.2095), olive, bevel=0.006, seg=2, uv=uv)          # lid with its lip
    add_box(mb, (0.36, 0.18, 0.004), (0, 0, 0.2315), olive, bevel=0.0015, uv=uv)                 # pressed panel
    # Latch on the -X end: lever plate hinged at the lid, catch on the body.
    add_box(mb, (0.006, 0.07, 0.105), (-0.218, 0, 0.158), olive, bevel=0.002, uv=uv)
    add_cyl(mb, 0.0065, 0.08, (-0.2165, 0, 0.212), olive, segs=10, axis='Y', uv=uv)
    add_box(mb, (0.01, 0.07, 0.005), (-0.221, 0, 0.108), olive, uv=uv)
    add_box(mb, (0.01, 0.05, 0.022), (-0.213, 0, 0.092), olive, bevel=0.002, uv=uv)
    add_cyl(mb, 0.0055, 0.18, (0.2145, 0, 0.19), olive, segs=10, axis='Y', uv=uv)                # lid hinge
    # Folding handle, folded flat toward the front.
    for sx in (-1, 1):
        add_box(mb, (0.016, 0.014, 0.0075), (sx * 0.07, 0.035, 0.2375), olive, uv=uv)
    zh = 0.2372
    path = [(-0.07, 0.035, zh), (-0.07, -0.045, zh), (0.07, -0.045, zh), (0.07, 0.035, zh)]
    add_tube(mb, fillet(path, 0.014, 2), 0.0035, olive, sides=6)
    finish('prop_ammo_can_mesh', mb, root)
    return root


def table_uv(faces, layer):
    """Top and bottom faces get the whole texture; the edges get its outer border, so the chips wrap round."""
    X, Y = 1.15, 0.72
    for face in faces:
        n = face.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for loop in face.loops:
            x, y, z = loop.vert.co
            u, v = (x + X / 2) / X, (y + Y / 2) / Y
            t = (0.78 - z) / 0.055 * 0.012
            if ax == 1:
                v = t if n.y < 0 else 1 - t
            elif ax == 0:
                u = t if n.x < 0 else 1 - t
            loop[layer].uv = (u, v)


def build_table(M, name, desk):
    root = common.empty(name)
    mb = MB()
    top, metal, rubber = M['table_top'], M['table_metal'], M['rubber_black']
    uv = uv_box(0.6)
    add_box(mb, (1.15, 0.72, 0.055), (0, 0, 0.7525), top, bevel=0.004, seg=2, uv=table_uv)
    for lx in (-0.5, 0.5):
        for ly in (-0.3, 0.3):
            add_box(mb, (0.05, 0.05, 0.713), (lx, ly, 0.012 + 0.713 / 2), metal, bevel=0.004, uv=uv)
            add_cyl(mb, 0.019, 0.012, (lx, ly, 0.006), rubber, segs=10, r2=0.024)
    for ly in (-0.3, 0.3):
        if desk and ly > 0:
            continue                                    # the modesty panel takes the back rail's place
        add_box(mb, (0.95, 0.02, 0.07), (0, ly, 0.69), metal, bevel=0.003, uv=uv)
    for lx in (-0.5, 0.5):
        add_box(mb, (0.02, 0.55, 0.07), (lx, 0, 0.69), metal, bevel=0.003, uv=uv)
    if desk:
        add_box(mb, (1.05, 0.03, 0.5), (0, 0.32, 0.5), metal, bevel=0.004, seg=2, uv=uv)
        for z in (0.36, 0.64):                          # pressed stiffening ribs on the outside of the panel
            add_box(mb, (0.98, 0.006, 0.02), (0, 0.338, z), metal, bevel=0.002, uv=uv)
    finish(name + '_mesh', mb, root)
    return root


def build_door(M):
    root = common.empty('prop_door')
    mb = MB()
    paint, steel = M['door_paint'], M['door_steel']
    W, T, H = 1.22, 0.05, 2.26

    def door_uv(faces, layer):
        for face in faces:
            ax = max(range(3), key=lambda i: abs(face.normal[i]))
            for loop in face.loops:
                x, y, z = loop.vert.co
                u = x / W if ax != 0 else (0.002 if x < W / 2 else 0.998)
                loop[layer].uv = (u, z / H)
    add_box(mb, (W - 0.002, T, H), ((W + 0.002) / 2, 0, H / 2), paint, bevel=0.003, uv=door_uv)
    suv = uv_box(0.3)
    for s in (-1, 1):
        add_box(mb, (1.16, 0.0015, 0.25), (0.61, s * (T / 2 + 0.00075), 0.14), steel, bevel=0.0007, uv=suv)
        add_cyl(mb, 0.027, 0.008, (1.10, s * (T / 2 + 0.004), 1.0), steel, segs=16, axis='Y', uv=suv)
        add_cyl(mb, 0.012, 0.006, (1.10, s * (T / 2 + 0.003), 0.93), steel, segs=10, axis='Y', uv=suv)  # key rose
        path = [(1.10, s * 0.03, 1.0), (1.10, s * 0.062, 1.0), (0.978, s * 0.062, 1.0), (0.97, s * 0.05, 1.0)]
        add_tube(mb, fillet(path, 0.014, 3), 0.0085, steel, sides=8)
    for z in (0.25, 1.15, 2.05):                       # hinge leaves on the hinge edge
        add_box(mb, (0.002, 0.034, 0.10), (0.001, 0, z), steel, uv=suv)
    finish('prop_door_mesh', mb, root)
    return root


def build_exit_door(M):
    root = common.empty('prop_exit_door')
    mb = MB()
    frame, door, hw, steel = M['exit_frame'], M['exit_steel'], M['exit_hardware'], M['steel_bare']
    fuv = uv_box(1.0)
    for sx in (-1, 1):
        add_box(mb, (0.16, 0.2, 2.40), (sx * 0.92, 0, 1.2), frame, bevel=0.006, uv=fuv)
    add_box(mb, (2.0, 0.2, 0.15), (0, 0, 2.475), frame, bevel=0.006, uv=fuv)
    add_box(mb, (1.68, 0.1, 2.4), (0, 0, 1.2), door, bevel=0.008, seg=2,
            uv=uv_planar(lambda c: (c.x + 0.84) / 1.68, lambda c: c.z / 2.4))
    # Push bar on the front: latch mechanism on the left (the keypad side), bracket on the hinge side.
    add_box(mb, (0.20, 0.075, 0.11), (-0.66, -0.0875, 1.02), hw, bevel=0.01, seg=2, uv=fuv)
    add_box(mb, (0.06, 0.075, 0.09), (0.74, -0.0875, 1.02), hw, bevel=0.008, seg=2, uv=fuv)
    add_cyl(mb, 0.021, 1.27, (0.075, -0.1, 1.02), steel, segs=12, axis='X', uv=fuv)
    for z in (0.35, 1.2, 2.05):                        # heavy hinge knuckles on the right edge
        add_cyl(mb, 0.016, 0.14, (0.835, -0.058, z), steel, segs=12, uv=fuv)
        add_cyl(mb, 0.006, 0.012, (0.835, -0.058, z + 0.076), steel, segs=8, uv=fuv)
    # Beacon: back plate, end mounts, lens (exit_beacon, separate mesh) and a wire cage, all within
    # 0.54 x 0.12 x 0.19 centred at z 2.74 on the front.
    zb = 2.74
    add_box(mb, (0.54, 0.03, 0.19), (0, -0.025, zb), frame, bevel=0.006, uv=fuv)
    for sx in (-1, 1):
        add_box(mb, (0.05, 0.085, 0.15), (sx * 0.245, -0.0825, zb), frame, bevel=0.006, uv=fuv)
    add_box(mb, (0.1, 0.03, 0.1), (0, -0.025, 2.6), frame, bevel=0.004, uv=fuv)               # mount on the header
    for x in (-0.16, -0.08, 0.0, 0.08, 0.16):
        path = [(x, -0.04, zb + 0.06), (x, -0.124, zb + 0.06), (x, -0.124, zb - 0.06), (x, -0.04, zb - 0.06)]
        add_tube(mb, fillet(path, 0.02, 2), 0.0045, frame, sides=5, caps=False)
    add_tube(mb, [(-0.22, -0.1235, zb), (0.22, -0.1235, zb)], 0.0045, frame, sides=5)
    path = [(0.27, -0.022, zb), (0.33, -0.022, zb), (0.36, -0.022, zb - 0.04), (0.36, -0.022, 2.55)]
    add_tube(mb, fillet(path, 0.03, 3), 0.011, steel, sides=6)                                 # conduit
    # Keypad on the wall to the left.
    kx, kz = -1.12, 1.38
    add_box(mb, (0.18, 0.08, 0.28), (kx, -0.06, kz), hw, bevel=0.008, seg=2, uv=fuv)
    for r in range(4):
        for c in range(3):
            add_box(mb, (0.03, 0.008, 0.022), (kx + (c - 1) * 0.042, -0.104, 1.37 - r * 0.033), M['plastic_dark'],
                    bevel=0.002, uv=fuv)
    finish('prop_exit_door_mesh', mb, root)
    bm_ = MB()
    add_box(bm_, (0.42, 0.07, 0.10), (0, -0.075, zb), M['exit_beacon'], bevel=0.024, seg=3, uv=uv_box(0.5))
    add_poly(bm_, [(kx - 0.05, -0.1005, 1.405), (kx + 0.05, -0.1005, 1.405), (kx + 0.05, -0.1005, 1.475),
                   (kx - 0.05, -0.1005, 1.475)], M['exit_beacon'], [(0, 0), (1, 0), (1, 1), (0, 1)])
    finish('exit_beacon', bm_, root)
    return root


def build_troffer(M):
    root = common.empty('prop_troffer')

    def rect_cw(a, b, z):   # clockwise seen from above = counter-clockwise seen from below (the visible side)
        return [Vector(p) for p in ((-a, -b, z), (-a, b, z), (a, b, z), (a, -b, z))]
    fb = MB()
    add_loft(fb, [rect_cw(0.38, 0.69, 0.0), rect_cw(0.38, 0.69, -0.044), rect_cw(0.376, 0.686, -0.05),
                  rect_cw(0.338, 0.648, -0.05), rect_cw(0.33, 0.64, -0.045)], M['troffer_frame'], cap_start=True,
             uv=uv_planar(lambda c: c.x / 0.76 + 0.5, lambda c: c.y / 1.38 + 0.5))
    finish('troffer_frame', fb, root)
    lb = MB()
    add_poly(lb, rect_cw(0.33, 0.64, -0.045), M['troffer_lens'], [(0, 0), (0, 1), (1, 1), (1, 0)])
    finish('troffer_lens', lb, root)
    return root


def build_vending(M):
    root = common.empty('lm_vending')
    mb = MB()
    body, dark, steel = M['vending_body'], M['plastic_dark'], M['steel_bare']
    uv = uv_box(2.0, (0.5, 0.0))
    add_box(mb, (0.95, 0.77, 1.84), (0, 0.015, 0.98), body, bevel=0.014, seg=2, uv=uv)          # cabinet
    add_box(mb, (0.91, 0.74, 0.06), (0, 0.02, 0.03), M['rubber_black'], uv=uv)                  # recessed plinth
    add_box(mb, (0.93, 0.02, 1.80), (0, -0.38, 0.98), body, bevel=0.008, seg=2, uv=uv)          # front door
    gx, gz = -0.08, 1.22
    add_ring_bezel(mb, rrect(0.67, 1.20, 0.05), rrect(0.62, 1.15, 0.035), gx, gz, -0.39, -0.40, -0.392, dark)
    add_ring_bezel(mb, rrect(0.67, 0.22, 0.04), rrect(0.61, 0.16, 0.025), gx, 0.42, -0.39, -0.40, -0.391, dark)
    flap = rrect(0.61, 0.16, 0.025)
    add_poly(mb, [Vector((gx + a, -0.3906, 0.42 + b)) for a, b in flap], M['rubber_black'],
             [(0.5 + a, 0.5 + b) for a, b in flap])
    add_box(mb, (0.6, 0.006, 0.012), (gx, -0.392, 0.47), dark, uv=uv)                           # flap hinge
    add_box(mb, (0.16, 0.01, 0.5), (0.33, -0.395, 1.2), M['vending_panel'], bevel=0.002,
            uv=uv_planar(lambda c: (c.x - 0.25) / 0.16, lambda c: (c.z - 0.95) / 0.5))
    add_cyl(mb, 0.016, 0.01, (0.33, -0.395, 0.80), steel, segs=14, axis='Y')                    # door lock
    add_cyl(mb, 0.006, 0.002, (0.33, -0.399, 0.80), M['rubber_black'], segs=8, axis='Y')
    finish('lm_vending_mesh', mb, root)
    gb = MB()
    pts = rrect(0.62, 1.15, 0.035)
    add_poly(gb, [Vector((gx + a, -0.392, gz + b)) for a, b in pts], M['vending_glass'],
             [(a / 0.62 + 0.5, b / 1.15 + 0.5) for a, b in pts])
    finish('vending_glass', gb, root)
    return root


def build_cooler(M):
    root = common.empty('lm_cooler')
    mb = MB()
    body, steel, dark = M['cooler_body'], M['steel_bare'], M['plastic_dark']
    uv = uv_box(1.0, (0.5, 0.0))
    add_box(mb, (0.38, 0.38, 0.60), (0, 0, 0.30), body, bevel=0.035, seg=3, uv=uv, edge_filter=vertical_edges)
    add_box(mb, (0.38, 0.30, 0.26), (0, 0.04, 0.73), body, bevel=0.035, seg=3, uv=uv,
            edge_filter=lambda e: vertical_edges(e) and e.verts[0].co.y > 0)
    for sx in (-1, 1):
        add_box(mb, (0.07, 0.08, 0.26), (sx * 0.155, -0.15, 0.73), body, bevel=0.035, seg=3, uv=uv,
                edge_filter=lambda e, sx=sx: vertical_edges(e) and e.verts[0].co.y < -0.18
                and e.verts[0].co.x * sx > 0.18)
    add_box(mb, (0.38, 0.38, 0.125), (0, 0, 0.9225), body, bevel=0.035, seg=3, uv=uv, edge_filter=vertical_edges)
    add_cyl(mb, 0.115, 0.025, (0, 0, 0.9975), body, segs=24, uv=uv)                             # bottle seat
    add_box(mb, (0.24, 0.08, 0.02), (0, -0.15, 0.61), dark, bevel=0.003, uv=uv)                 # drip tray
    for sx in (-1, 1):                                                                         # taps
        x = sx * 0.055
        add_box(mb, (0.034, 0.05, 0.04), (x, -0.135, 0.765), steel, bevel=0.005, seg=2, uv=uv)
        add_cyl(mb, 0.008, 0.026, (x, -0.15, 0.735), steel, segs=8, uv=uv)
        add_box(mb, (0.014, 0.034, 0.012), (x, -0.17, 0.79), M['rubber_black' if sx < 0 else 'plastic_dark'],
                bevel=0.003, uv=uv)
    bottle = [(0, 0.995), (0.028, 0.995), (0.028, 1.03), (0.034, 1.034), (0.034, 1.046), (0.05, 1.052),
              (0.11, 1.085), (0.148, 1.112), (0.16, 1.14), (0.16, 1.20), (0.152, 1.212), (0.16, 1.224),
              (0.16, 1.33), (0.152, 1.342), (0.16, 1.354), (0.16, 1.44), (0.155, 1.458), (0.14, 1.468),
              (0.09, 1.47), (0, 1.47)]
    add_lathe(mb, bottle, 20, lambda k: M['cooler_bottle'], v_fn=lambda r, z: (z - 0.995) / 0.475)
    finish('lm_cooler_mesh', mb, root)
    return root


def build_crt(M):
    root = common.empty('lm_crt')
    mb = MB()
    cart, rubber, steel, dark, tv = M['cart_metal'], M['rubber_black'], M['steel_bare'], M['plastic_dark'], M['crt_tv']
    uv = uv_box(0.8)
    for sx in (-1, 1):
        for sy in (-1, 1):
            add_box(mb, (0.03, 0.03, 0.645), (sx * 0.385, sy * 0.26, 0.3975), cart, uv=uv)
            cx, cy = sx * 0.36, sy * 0.235
            add_box(mb, (0.05, 0.05, 0.006), (cx, cy, 0.072), steel, uv=uv)
            for fx in (-1, 1):
                add_box(mb, (0.004, 0.026, 0.04), (cx + fx * 0.0155, cy, 0.05), steel, uv=uv)
            add_cyl(mb, 0.03, 0.022, (cx, cy, 0.03), rubber, segs=12, axis='X', uv=uv)
    for zt in (0.72, 0.40, 0.13):                                                              # shelf pans + lips
        add_box(mb, (0.8, 0.55, 0.025), (0, 0, zt - 0.0125), cart, bevel=0.004, uv=uv)
        for sy in (-1, 1):
            add_box(mb, (0.8, 0.012, 0.015), (0, sy * 0.269, zt + 0.0075), cart, uv=uv)
        for sx in (-1, 1):
            add_box(mb, (0.012, 0.526, 0.015), (sx * 0.394, 0, zt + 0.0075), cart, uv=uv)
    # CRT: bezel, tapered tube housing, raised screen mask, controls.
    add_box(mb, (0.62, 0.17, 0.50), (0, -0.145, 0.97), tv, bevel=0.012, seg=2, uv=uv)
    hx = [(0.29, 0.735, 1.20, -0.06), (0.26, 0.73, 1.16, 0.10), (0.19, 0.725, 1.04, 0.24)]
    loops = [[Vector((-w, y, z0)), Vector((w, y, z0)), Vector((w, y, z1)), Vector((-w, y, z1))]
             for (w, z0, z1, y) in reversed(hx)]
    add_loft(mb, loops, tv, cap_start=True, uv=uv)
    add_ring_bezel(mb, rrect(0.56, 0.42, 0.05), rrect(0.50, 0.37, 0.04), 0, 1.0, -0.23, -0.24, -0.2305, tv)
    for i, x in enumerate((0.12, 0.15, 0.18, 0.21)):
        add_box(mb, (0.018, 0.008, 0.012), (x, -0.234, 0.765), dark if i else steel, bevel=0.002, uv=uv)
    add_box(mb, (0.03, 0.008, 0.016), (-0.22, -0.234, 0.765), steel, bevel=0.002, uv=uv)
    # VCR on the middle shelf.
    add_box(mb, (0.43, 0.30, 0.085), (0, -0.03, 0.4425), dark, bevel=0.004, uv=uv)
    add_box(mb, (0.2, 0.004, 0.018), (-0.06, -0.181, 0.458), rubber, uv=uv)
    add_box(mb, (0.07, 0.003, 0.018), (0.13, -0.1805, 0.458), M['exit_hardware'], uv=uv)
    for x in (0.075, 0.11, 0.145, 0.18):
        add_box(mb, (0.016, 0.004, 0.008), (x, -0.181, 0.425), steel, uv=uv)
    # Cables: TV to VCR, power cord down to a coil on the bottom shelf.
    add_tube(mb, fillet([(0.15, 0.2, 0.80), (0.15, 0.245, 0.75), (0.165, 0.245, 0.62), (0.16, 0.22, 0.49),
                         (0.12, 0.125, 0.445)], 0.04, 2), 0.006, rubber, sides=6)
    add_tube(mb, fillet([(-0.1, 0.235, 0.78), (-0.12, 0.25, 0.70), (-0.14, 0.255, 0.45), (-0.15, 0.25, 0.25),
                         (-0.15, 0.2, 0.15), (-0.13, 0.12, 0.137)], 0.05, 2), 0.006, rubber, sides=6)
    coil = []
    for i in range(23):
        a = math.radians(-60 + i * 25)
        rr = 0.1 - 0.012 * i / 22
        coil.append((-0.08 + rr * math.cos(a) * 1.2, 0.0 + rr * math.sin(a), 0.137 + 0.012 * i / 22))
    add_tube(mb, coil, 0.006, rubber, sides=6)
    finish('lm_crt_mesh', mb, root)
    sb = MB()
    nu, nv, w, h, y0 = 6, 4, 0.49, 0.36, -0.231
    vs = {}
    for i in range(nu + 1):
        for j in range(nv + 1):
            u, v = i / nu, j / nv
            bulge = 0.007 * (1 - (2 * u - 1) ** 2) * (1 - (2 * v - 1) ** 2)
            vs[i, j] = sb.bm.verts.new((-w / 2 + u * w, y0 - bulge, 1.0 - h / 2 + v * h))
    idx = sb.mi(M['crt_screen'])
    for i in range(nu):
        for j in range(nv):
            f = sb.bm.faces.new((vs[i, j], vs[i + 1, j], vs[i + 1, j + 1], vs[i, j + 1]))
            f.material_index = idx
            for loop, (a, b) in zip(f.loops, ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))):
                loop[sb.uv].uv = (a / nu, b / nv)
    finish('crt_screen', sb, root, sharp_deg=80)
    return root


def build_neon(M):
    root = common.empty('lm_neon')
    mb = MB()
    board = M['neon_board']
    uv = uv_box(1.2, (0.5, 0.5))
    add_box(mb, (1.15, 0.04, 0.48), (0, 0.01, 0), board, bevel=0.004, uv=uv)                    # back box
    for sz in (-1, 1):                                                                         # raised frame
        add_box(mb, (1.15, 0.02, 0.025), (0, -0.02, sz * 0.2275), board, bevel=0.003, uv=uv)
    for sx in (-1, 1):
        add_box(mb, (0.025, 0.02, 0.43), (sx * 0.5625, -0.02, 0), board, bevel=0.003, uv=uv)
    for x in (-0.4, 0.0, 0.4):                                                                 # tube standoffs
        for z in (-0.13, 0.13):
            add_cyl(mb, 0.006, 0.022, (x, -0.021, z), M['steel_bare'], segs=8, axis='Y')
    path = [(0.45, 0.005, -0.22), (0.45, 0.005, -0.27), (0.47, 0.01, -0.305), (0.52, 0.018, -0.315),
            (0.555, 0.022, -0.30), (0.56, 0.025, -0.28)]
    add_tube(mb, fillet(path, 0.03, 2), 0.005, M['rubber_black'], sides=6)                     # power cable
    finish('lm_neon_mesh', mb, root)
    fb = MB()
    add_poly(fb, [(-0.54, -0.035, -0.2), (0.54, -0.035, -0.2), (0.54, -0.035, 0.2), (-0.54, -0.035, 0.2)],
             M['neon_face'], [(0, 0), (1, 0), (1, 1), (0, 1)])
    finish('neon_face', fb, root)
    return root


def build_cone(M):
    root = common.empty('prop_cone')
    mb = MB()
    add_box(mb, (0.32, 0.32, 0.04), (0, 0, 0.02), M['rubber_black'], bevel=0.04, seg=2, uv=uv_box(0.5),
            edge_filter=vertical_edges)
    add_cyl(mb, 0.138, 0.012, (0, 0, 0.046), M['rubber_black'], segs=16, caps=False, r2=0.13)
    prof = [(0.128, 0.04), (0.126, 0.052), (0.03, 0.57), (0.027, 0.58), (0.017, 0.58), (0.016, 0.565), (0, 0.565)]
    add_lathe(mb, prof, 16, lambda k: M['cone_orange'], v_fn=lambda r, z: (z - 0.04) / 0.54)
    finish('prop_cone_mesh', mb, root)
    return root


def build_fallen_tile(M):
    """5 x 5 grid split along a stepped crack into two warped pieces, solidified to 0.025 m."""
    root = common.empty('prop_fallen_tile')
    rng = np.random.default_rng(6)
    n, half, crack = TILE_N, TILE_HALF, TILE_CRACK
    P, _ = tile_layout()
    mb = MB()
    idx = mb.mi(M['fallen_tile'])
    for piece in (0, 1):
        cells = [(i, j) for i in range(n) for j in range(n) if (j >= crack[i]) == (piece == 0)]
        used = {(a, b) for (i, j) in cells for (a, b) in ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))}
        verts = {}
        for key in used:
            x, y = P[key]
            if piece == 1:
                y -= 0.011                      # the crack opens
            # distance to the crack line (in rows) for the lift along the broken edge
            ci = min(key[0], n - 1)
            dist = abs(key[1] - crack[ci]) / n
            curl = 0.012 * ((abs(x) / half) ** 3 + (abs(y) / half) ** 3) / 2
            lift = (0.016 if piece == 1 else 0.006) * max(0.0, 1 - dist * 2.5)
            z = 0.025 + curl + lift + rng.uniform(0, 0.0015)
            verts[key] = mb.bm.verts.new((x, y, z))
        for (i, j) in cells:
            keys = ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))
            f = mb.bm.faces.new([verts[k] for k in keys])
            f.material_index = idx
            for loop, k in zip(f.loops, keys):
                loop[mb.uv].uv = (P[k][0] / (2 * half) + 0.5, P[k][1] / (2 * half) + 0.5)
    ob = finish('prop_fallen_tile_mesh', mb, root)
    mod = ob.modifiers.new('solidify', 'SOLIDIFY')
    mod.thickness = 0.025
    mod.offset = -1.0
    mod.use_even_offset = True
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    bpy.data.meshes.remove(old)
    me.name = 'prop_fallen_tile_mesh'
    # Fit the footprint to exactly 0.68 x 0.68 and rest the lowest point on the floor (pivot = bottom centre).
    co = np.array([v.co[:] for v in me.vertices])
    lo, hi = co.min(axis=0), co.max(axis=0)
    co[:, 0] = (co[:, 0] - (lo[0] + hi[0]) / 2) * 0.68 / (hi[0] - lo[0])
    co[:, 1] = (co[:, 1] - (lo[1] + hi[1]) / 2) * 0.68 / (hi[1] - lo[1])
    co[:, 2] -= lo[2]
    me.vertices.foreach_set('co', co.ravel())
    me.update()
    # Solidify copies the top UVs onto the rim, which streaks; give the rim its own unstretched mapping.
    uvl = me.uv_layers.active.data
    for poly in me.polygons:
        if abs(poly.normal.z) < 0.6:
            for li in poly.loop_indices:
                x, y, z = me.vertices[me.loops[li].vertex_index].co
                uvl[li].uv = ((x + y) / 0.68 + 0.5, 0.45 + z * 2.0)
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(40))
    return root


# ----------------------------------------------------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------------------------------------------------

# Where each prop stands in the exported scene (preview only; the game places the props itself): tall props at the
# back, furniture and decor in the middle, pickups in front.
LAYOUT = {
    'lm_vending': (-4.0, 3.0, 0.0), 'lm_cooler': (-2.95, 3.0, 0.0), 'lm_crt': (-2.0, 3.0, 0.0),
    'lm_neon': (-0.75, 3.3, 1.6), 'prop_door': (0.3, 3.0, 0.0), 'prop_exit_door': (3.5, 3.0, 0.0),
    'prop_office_table': (-3.4, 1.3, 0.0), 'prop_desk_hide': (-1.95, 1.3, 0.0), 'prop_troffer': (-0.45, 1.3, 2.6),
    'prop_fallen_tile': (0.75, 1.2, 0.0), 'prop_cone': (1.55, 1.3, 0.0),
    'prop_almond_water': (-1.3, 0.0, 0.0), 'prop_vhs': (-0.85, 0.0, 0.0), 'prop_battery': (-0.45, 0.0, 0.0),
    'prop_ammo_can': (0.05, 0.0, 0.0),
}

def build_all():
    common.reset_scene()
    M = build_materials()
    roots = [build_almond_water(M), build_vhs(M), build_battery(M), build_ammo_can(M),
             build_table(M, 'prop_office_table', False), build_table(M, 'prop_desk_hide', True), build_door(M),
             build_exit_door(M), build_troffer(M), build_vending(M), build_cooler(M), build_crt(M), build_neon(M),
             build_cone(M), build_fallen_tile(M)]
    bpy.context.view_layer.update()
    for r in roots:
        meshes = [c for c in r.children if c.type == 'MESH']
        print(f'PROP {r.name:20s} tris {common.triangle_count(meshes):5d}  parts {[c.name for c in meshes]}')
        r.location = LAYOUT[r.name]
    return roots


def set_hidden(root, hidden):
    for o in [root, *root.children_recursive]:
        o.hide_render = hidden


def stage(roots, poses):
    """Show only the props in `poses` ({name: (location, rotation)}), placed for the shot."""
    for r in roots:
        set_hidden(r, r.name not in poses)
        if r.name in poses:
            r.location, r.rotation_euler = poses[r.name]


def render_previews(roots, only=None):
    """Helpers added here (floor, wall, preview poses) come after the export, so they never reach the glb."""
    scene = bpy.context.scene
    scene.view_settings.view_transform = 'Standard'       # closer to the game's plain sRGB output than AgX
    scene.view_settings.exposure = -0.35
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
    common.assign(bpy.context.active_object, make_mat('preview_floor', '#6e6656', roughness=0.9))
    bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0.41, 1.5), rotation=(math.pi / 2, 0, 0))
    wall = bpy.context.active_object
    wall.scale = (6.0, 3.0, 1.0)
    common.assign(wall, make_mat('preview_wall', '#c4ac54', roughness=0.85))
    up = (0.0, 0.0, 0.0)
    flat = {n: (LAYOUT[n], up) for n in LAYOUT}
    flat['prop_troffer'] = ((-0.45, 1.3, 0.0), (math.pi, 0.0, 0.0))        # lying lens-up on the floor
    shots = {
        'props.png': (flat, False, dict(camera_location=(1.3, -5.4, 3.6), target=(-0.15, 1.7, 0.75), lens=22,
                                        resolution=(1600, 1000))),
        'props_pickups.png': ({'prop_almond_water': ((-0.42, 0.0, 0.0), up), 'prop_vhs': ((-0.08, -0.02, 0.0), up),
                               'prop_battery': ((0.2, 0.02, 0.0), up), 'prop_ammo_can': ((0.52, 0.03, 0.0), up)},
                              False, dict(camera_location=(0.42, -1.05, 0.55), target=(0.04, 0.0, 0.11), lens=38,
                                          resolution=(1400, 900))),
        'props_decor.png': ({'prop_cone': ((-0.3, 0.1, 0.0), up), 'prop_fallen_tile': ((0.32, 0.0, 0.0), (0, 0, 0.3)),
                             'prop_troffer': ((1.25, 0.25, 0.0), (math.pi, 0.0, 0.25))},
                            False, dict(camera_location=(0.9, -1.85, 1.35), target=(0.42, 0.1, 0.12), lens=32,
                                        resolution=(1400, 900))),
        'props_landmarks.png': ({'lm_vending': ((-1.45, 0.01, 0.0), up), 'lm_cooler': ((-0.55, 0.22, 0.0), up),
                                 'lm_crt': ((0.3, 0.135, 0.0), up), 'lm_neon': ((1.45, 0.38, 1.7), up)},
                                True, dict(camera_location=(0.45, -3.3, 1.55), target=(0.0, 0.0, 1.0), lens=28,
                                           resolution=(1400, 1000))),
        'props_furniture.png': ({'prop_office_table': ((-0.75, 0.0, 0.0), up),
                                 'prop_desk_hide': ((0.7, 0.0, 0.0), up)},
                                False, dict(camera_location=(1.1, -2.6, 1.55), target=(0.0, 0.0, 0.45), lens=30,
                                            resolution=(1400, 900))),
        'props_doors.png': ({'prop_door': ((-1.75, 0.0, 0.0), up), 'prop_exit_door': ((1.0, 0.0, 0.0), up)},
                            False, dict(camera_location=(0.6, -4.3, 1.7), target=(-0.1, 0.0, 1.3), lens=28,
                                        resolution=(1400, 1000))),
    }
    for name, (poses, show_wall, cam) in shots.items():
        if only and name not in only:
            continue
        stage(roots, poses)
        wall.hide_render = not show_wall
        common.render_preview(name, **cam)


def main():
    roots = build_all()
    path = common.export_glb('props.glb', animations=False)
    print('EXPORTED', path, path.stat().st_size, 'bytes')
    args = common.args_after_dashdash()
    if '--no-preview' not in args:
        only = args[args.index('--previews') + 1].split(',') if '--previews' in args else None
        render_previews(roots, only)


main()
