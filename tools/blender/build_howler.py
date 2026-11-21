"""Build public/assets/models/ent_howler.glb: the Howler, a blind sound-hunter made of twisted cable.

Run from the repository root (Blender 4.5):
    blender --background --factory-startup --python tools/blender/build_howler.py
    blender ... --python tools/blender/build_howler.py -- --previews   # also render tools/blender/previews/
    blender ... --python tools/blender/build_howler.py -- --diag       # print pose checks, no export

What it makes (see docs/design/art/model-contract.md and art-bible.md section 4.1 / 5.2):
- armature `howler_rig` with the 39 bones of the art bible's skeleton;
- one skinned mesh `howler_body`: cables swept along the bone chains (twist, jitter, wrap-around), a wire-loop
  gourd head with four listening frills, a vertical slit mouth (two plates, copper rings, a cracked starter),
  three hooked wire claws per hand, reverse-knee legs with frayed broom feet, a loose cable tail, zip ties,
  junction boxes and stained ceiling-tile fragments. Material `howler_body` (one generated atlas: base colour,
  normal, ORM) plus the small emissive `howler_starter`;
- sockets HIT_head, HIT_body, SOCKET_mouth (bone children) and the static JS_CAM (armature child);
- the 13 clips of the art bible, 30 fps, in place, loops seamless (frame N = frame 0).
Weights are computed per cable ring from the bones the part follows (no bone heat), at most 3 influences.
"""
import math
import pathlib
import sys
import tempfile

import bpy
import numpy as np
from mathutils import Matrix

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import common  # noqa: E402

ARGS = common.args_after_dashdash()
PREVIEWS = '--previews' in ARGS
DIAG = '--diag' in ARGS
TAU = 2 * math.pi
rng = np.random.default_rng(1905)


def unit(v):
    v = np.asarray(v, float)
    n = np.linalg.norm(v)
    return v / n if n > 1e-12 else v


def smooth(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def E(x=0.0, y=0.0, z=0.0):
    """Rotation in armature axes, degrees: X first (pitch, + tips up-pointing bones forward), then Y, then Z."""
    rx, ry, rz = np.radians([x, y, z])
    cx, sx, cy, sy, cz, sz = math.cos(rx), math.sin(rx), math.cos(ry), math.sin(ry), math.cos(rz), math.sin(rz)
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return Rz @ Ry @ Rx


def Es(side, x=0.0, y=0.0, z=0.0):
    """E for a left bone, mirrored for the right one (Y and Z rotations flip sign)."""
    return E(x, y, z) if side == 'L' else E(x, -y, -z)


def rodrigues(axis, ang):
    k = unit(axis)
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(ang) * K + (1 - math.cos(ang)) * K @ K


def arc(u, v):
    """Smallest rotation taking direction u to direction v."""
    u, v = unit(u), unit(v)
    ax = np.cross(u, v)
    s, c = np.linalg.norm(ax), float(np.dot(u, v))
    if s < 1e-9:
        return np.eye(3) if c > 0 else rodrigues(unit(np.cross(u, [1, 0, 0]) + np.cross(u, [0, 0, 1])), math.pi)
    return rodrigues(ax / s, math.atan2(s, c))


# ---------------------------------------------------------------------------------------------------------------
# Skeleton (rest pose: natural hunched stance, facing -Y, feet on the floor, head top 2.37 m)
# ---------------------------------------------------------------------------------------------------------------
BONES = []  # (name, head, tail, parent) in parent-first order


def bone(name, head, tail, parent):
    BONES.append((name, np.array(head, float), np.array(tail, float), parent))


bone('root', (0, 0, 0), (0, 0, 0.2), None)
bone('pelvis', (0, 0.03, 1.10), (0, 0.02, 1.27), 'root')
bone('spine_01', (0, 0.02, 1.27), (0, 0.0, 1.45), 'pelvis')
bone('spine_02', (0, 0.0, 1.45), (0, -0.06, 1.62), 'spine_01')
bone('spine_03', (0, -0.06, 1.62), (0, -0.16, 1.79), 'spine_02')
bone('neck_01', (0, -0.16, 1.79), (0, -0.23, 1.87), 'spine_03')
bone('neck_02', (0, -0.23, 1.87), (0, -0.285, 1.95), 'neck_01')
bone('head', (0, -0.285, 1.95), (0, -0.30, 2.37), 'neck_02')
for S, sg in (('L', 1), ('R', -1)):
    def m(p, sg=sg):
        return (p[0] * sg, p[1], p[2])
    bone(f'jaw_{S}', m((0.074, -0.41, 2.31)), m((0.074, -0.41, 2.02)), 'head')
for S, sg in (('L', 1), ('R', -1)):
    def m(p, sg=sg):
        return (p[0] * sg, p[1], p[2])
    bone(f'sensor_{S}_01', m((0.135, -0.29, 2.29)), m((0.35, -0.25, 2.31)), 'head')
    bone(f'sensor_{S}_02', m((0.13, -0.28, 2.17)), m((0.33, -0.22, 2.13)), 'head')
for S, sg in (('L', 1), ('R', -1)):
    def m(p, sg=sg):
        return (p[0] * sg, p[1], p[2])
    bone(f'clavicle_{S}', m((0.03, -0.11, 1.75)), m((0.235, -0.17, 1.775)), 'spine_03')
    bone(f'upperarm_{S}', m((0.235, -0.17, 1.775)), m((0.29, -0.22, 1.305)), f'clavicle_{S}')
    bone(f'forearm_{S}', m((0.29, -0.22, 1.305)), m((0.33, -0.30, 0.735)), f'upperarm_{S}')
    bone(f'hand_{S}', m((0.33, -0.30, 0.735)), m((0.34, -0.33, 0.625)), f'forearm_{S}')
    bone(f'claw_{S}_01', m((0.322, -0.345, 0.64)), m((0.30, -0.39, 0.465)), f'hand_{S}')
    bone(f'claw_{S}_02', m((0.342, -0.34, 0.635)), m((0.345, -0.385, 0.455)), f'hand_{S}')
    bone(f'claw_{S}_03', m((0.362, -0.325, 0.64)), m((0.39, -0.355, 0.47)), f'hand_{S}')
bone('cable_tail_01', (0, 0.10, 1.42), (0, 0.21, 1.10), 'spine_02')
bone('cable_tail_02', (0, 0.21, 1.10), (0, 0.33, 0.72), 'cable_tail_01')
bone('cable_tail_03', (0, 0.33, 0.72), (0, 0.44, 0.24), 'cable_tail_02')
for S, sg in (('L', 1), ('R', -1)):
    def m(p, sg=sg):
        return (p[0] * sg, p[1], p[2])
    bone(f'thigh_{S}', m((0.115, 0.04, 1.18)), m((0.13, 0.25, 0.66)), 'pelvis')
    bone(f'shin_{S}', m((0.13, 0.25, 0.66)), m((0.14, -0.02, 0.13)), f'thigh_{S}')
    bone(f'foot_{S}', m((0.14, -0.02, 0.13)), m((0.15, -0.13, 0.035)), f'shin_{S}')
    bone(f'toe_{S}', m((0.15, -0.13, 0.035)), m((0.155, -0.24, 0.01)), f'foot_{S}')

NAMES = [b[0] for b in BONES]
PARENT = {b[0]: b[3] for b in BONES}
HEAD0 = {b[0]: b[1] for b in BONES}
TAIL0 = {b[0]: b[2] for b in BONES}
LEN = {n: float(np.linalg.norm(TAIL0[n] - HEAD0[n])) for n in NAMES}
DIR0 = {n: unit(TAIL0[n] - HEAD0[n]) for n in NAMES}
CHILDREN = {n: [c for c in NAMES if PARENT[c] == n] for n in NAMES}
assert len(NAMES) <= 64

# Fixed points the code and the clips refer to.
HEAD_CENTER = np.array([0.0, -0.2925, 2.15])      # centre of the rest head box 1.91-2.39
BODY_CENTER = np.array([0.0, -0.08, 1.0925])      # centre of the rest body box 0.275-1.91
JS_CAM_POS = np.array([0.0, -1.05, 1.70])         # player's eye during the jump scare (static)


# ---------------------------------------------------------------------------------------------------------------
# Mesh builder
# ---------------------------------------------------------------------------------------------------------------
class MB:
    def __init__(self):
        self.V, self.W, self.F, self.FUV, self.FM, self.FS = [], [], [], [], [], []

    def v(self, p, w):
        self.V.append(np.asarray(p, float))
        self.W.append(w)
        return len(self.V) - 1

    def f(self, idx, uvs, mat=0, smooth_=True):
        self.F.append(tuple(idx))
        self.FUV.append([tuple(map(float, uv)) for uv in uvs])
        self.FM.append(mat)
        self.FS.append(smooth_)

    def f_oriented(self, idx, uvs, normal, mat=0, smooth_=False):
        """Face whose winding is flipped if needed so that it faces `normal`."""
        p = [self.V[i] for i in idx]
        n = np.cross(p[1] - p[0], p[2] - p[0])
        if len(p) == 4:
            n = n + np.cross(p[2] - p[0], p[3] - p[0])
        if np.dot(n, normal) < 0:
            idx, uvs = list(reversed(idx)), list(reversed(uvs))
        self.f(idx, uvs, mat, smooth_)

    def tris(self):
        return sum(len(f) - 2 for f in self.F)


MB_ = MB()

# Atlas layout. Left half: four full-height columns that tile along v (cable runs any length);
# right half: tile, junction box, aluminium duct, bakelite, zip tie, broken tile edge.
LT = 1.0                     # metres of cable per vertical texture repeat
COLW, MARG = 0.125, 4 / 1024
COL_BLACK, COL_GREY, COL_CONDUIT, COL_COPPER = 0, 1, 2, 3
R_TILE, R_BOX, R_DUCT = (0.5, 0.5, 1.0, 1.0), (0.5, 0.25, 0.75, 0.5), (0.75, 0.25, 1.0, 0.5)
R_BAKE, R_ZIP, R_EDGE = (0.5, 0.0, 0.75, 0.25), (0.75, 0.0, 0.875, 0.25), (0.875, 0.0, 1.0, 0.25)


def col_u(col):
    return (col * COLW + MARG, (col + 1) * COLW - MARG)


def rect_uv(R, a, b, inset=5 / 1024):
    return (R[0] + inset + a * (R[2] - R[0] - 2 * inset), R[1] + inset + b * (R[3] - R[1] - 2 * inset))


# ---------------------------------------------------------------------------------------------------------------
# Skin weights: nearest bone of an allowed set, blended 50/50 at the joints with a smooth falloff
# ---------------------------------------------------------------------------------------------------------------
def seg_dist(p, b):
    h, t = HEAD0[b], TAIL0[b]
    d = t - h
    tt = float(np.clip(np.dot(p - h, d) / max(np.dot(d, d), 1e-12), 0, 1))
    return float(np.linalg.norm(p - (h + tt * d))), tt


def wnear(allowed, blend=0.07):
    allowed = list(allowed)

    def fn(p):
        p = np.asarray(p, float)
        best = min(((b,) + seg_dist(p, b) for b in allowed), key=lambda x: x[1])
        b, _, tt = best
        w = {b: 1.0}
        bl = min(blend, 0.45 * LEN[b])
        par = PARENT[b]
        if par in allowed and tt * LEN[b] < bl:
            wn = 0.5 * (1 - smooth(tt * LEN[b] / bl))
            w[par] = w.get(par, 0) + wn
            w[b] -= wn
        kids = [c for c in CHILDREN[b] if c in allowed]
        if kids and (1 - tt) * LEN[b] < bl:
            c = min(kids, key=lambda c: seg_dist(p, c)[0])
            wn = 0.5 * (1 - smooth((1 - tt) * LEN[b] / bl))
            w[c] = w.get(c, 0) + wn
            w[b] -= wn
        return {k: v for k, v in w.items() if v > 1e-4}
    return fn


def wfix(d):
    return lambda p: dict(d)


# ---------------------------------------------------------------------------------------------------------------
# Curves and tubes
# ---------------------------------------------------------------------------------------------------------------
def catmull(ctrl, per_seg=8):
    P = np.asarray(ctrl, float)
    if len(P) == 2:
        return np.linspace(P[0], P[1], per_seg + 1)
    ext = np.vstack([2 * P[0] - P[1], P, 2 * P[-1] - P[-2]])
    out = []
    for i in range(1, len(ext) - 2):
        p0, p1, p2, p3 = ext[i - 1], ext[i], ext[i + 1], ext[i + 2]
        for k in range(per_seg):
            t = k / per_seg
            out.append(0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                              + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    out.append(P[-1])
    return np.array(out)


def resample(Pd, seg):
    d = np.linalg.norm(np.diff(Pd, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(d)])
    n = max(2, int(math.ceil(s[-1] / seg)) + 1)
    si = np.linspace(0, s[-1], n)
    return np.stack([np.interp(si, s, Pd[:, k]) for k in range(3)], 1), si


def transport_frames(P):
    T = np.gradient(P, axis=0)
    T /= np.linalg.norm(T, axis=1, keepdims=True) + 1e-12
    a = np.array([0, 0, 1.0]) if abs(T[0, 2]) < 0.9 else np.array([1.0, 0, 0])
    N = np.zeros_like(P)
    N[0] = unit(np.cross(T[0], a))
    for k in range(1, len(P)):
        n = N[k - 1] - np.dot(N[k - 1], T[k]) * T[k]
        N[k] = unit(n) if np.linalg.norm(n) > 1e-6 else N[k - 1]
    return T, N, np.cross(T, N)


def ring_pts(c, n_, b_, r, sides, tw):
    a = TAU * np.arange(sides) / sides + tw
    return c + r * (np.cos(a)[:, None] * n_ + np.sin(a)[:, None] * b_)


def connect(mb, A, B, vA, vB, u01, mat=0):
    n = len(A)
    U = np.linspace(u01[0], u01[1], n + 1)
    for j in range(n):
        j1 = (j + 1) % n
        mb.f((A[j], A[j1], B[j1], B[j]), [(U[j], vA), (U[j + 1], vA), (U[j + 1], vB), (U[j], vB)], mat)


def cap(mb, ids, center, w, uvc, mat=0, end=True):
    c = mb.v(center, w)
    n = len(ids)
    for j in range(n):
        j1 = (j + 1) % n
        a0, a1 = TAU * j / n, TAU * j1 / n
        uv0 = (uvc[0] + 0.012 * math.cos(a0), uvc[1] + 0.012 * math.sin(a0))
        uv1 = (uvc[0] + 0.012 * math.cos(a1), uvc[1] + 0.012 * math.sin(a1))
        if end:
            mb.f((c, ids[j], ids[j1]), [uvc, uv0, uv1], mat)
        else:
            mb.f((c, ids[j1], ids[j]), [uvc, uv1, uv0], mat)


COPPER_CAP_UV = ((col_u(COL_COPPER)[0] + col_u(COL_COPPER)[1]) / 2, 0.5)
BLACK_CAP_UV = ((col_u(COL_BLACK)[0] + col_u(COL_BLACK)[1]) / 2, 0.5)


def tube(ctrl, r, sides=3, col=COL_BLACK, wfn=None, seg=None, twist=None, rad=None, per_seg=8,
         end0=None, end1=None, uv_rect=None, mat=0, mb=None):
    """Sweep a `sides`-gon along a Catmull-Rom curve through ctrl. Ends: None, 'cap' or 'copper' (cut end)."""
    mb = mb or MB_
    P, s = resample(catmull(ctrl, per_seg), seg or max(0.03, 3.2 * r))
    T, N, B = transport_frames(P)
    L = max(s[-1], 1e-6)
    f = s / L
    radii = r * (rad(f) if rad is not None else np.ones_like(s))
    tw = rng.uniform(0, TAU) + TAU * (rng.uniform(-1.0, 1.0) if twist is None else twist) * f
    wfn = wfn or wfix({'root': 1.0})
    ws = [wfn(p) for p in P]
    if uv_rect is not None:
        u01 = (uv_rect[0] + 0.004, uv_rect[2] - 0.004)
        vs = uv_rect[1] + 0.004 + f * (uv_rect[3] - uv_rect[1] - 0.008)
    else:
        u01 = col_u(col)
        vs = rng.uniform(0, 1) + s / LT
    ids = [[mb.v(p, ws[k]) for p in ring_pts(P[k], N[k], B[k], radii[k], sides, tw[k])] for k in range(len(P))]
    for k in range(len(P) - 1):
        connect(mb, ids[k], ids[k + 1], vs[k], vs[k + 1], u01, mat)
    for which, kind in ((0, end0), (1, end1)):
        if not kind:
            continue
        k = 0 if which == 0 else len(P) - 1
        sgn = -1 if which == 0 else 1
        tdir = T[k] * sgn
        if kind == 'cap':
            cap(mb, ids[k], P[k] + tdir * radii[k] * 0.4, ws[k], BLACK_CAP_UV, mat, end=(which == 1))
            continue
        if kind == 'tip':   # cheap cut end: a short copper cone (end only)
            A = [mb.v(p, ws[k]) for p in ring_pts(P[k], N[k], B[k], radii[k] * 0.6, sides, tw[k])]
            connect(mb, ids[k], A, 0.3, 0.31, col_u(COL_COPPER), mat)
            cap(mb, A, P[k] + tdir * min(0.016, 2.5 * radii[k] + 0.004), ws[k], COPPER_CAP_UV, mat, end=True)
            continue
        # cut end: insulation face, then a short bare copper core with a cap
        rc = radii[k] * 0.55
        A = [mb.v(p, ws[k]) for p in ring_pts(P[k], N[k], B[k], rc, sides, tw[k])]
        ext = min(0.018, 1.6 * radii[k] + 0.006)
        Bc = [mb.v(p, ws[k]) for p in ring_pts(P[k] + tdir * ext, N[k], B[k], rc * 0.8, sides, tw[k] + 0.4)]
        cu = col_u(COL_COPPER)
        if which == 1:
            connect(mb, ids[k], A, vs[k], vs[k] + 0.01, u01, mat)
            connect(mb, A, Bc, 0.3, 0.3 + ext / LT, cu, mat)
            cap(mb, Bc, P[k] + tdir * (ext + 0.003), ws[k], COPPER_CAP_UV, mat, end=True)
        else:
            connect(mb, A, ids[k], vs[k] - 0.01, vs[k], u01, mat)
            connect(mb, Bc, A, 0.3, 0.3 + ext / LT, cu, mat)
            cap(mb, Bc, P[k] + tdir * (ext + 0.003), ws[k], COPPER_CAP_UV, mat, end=False)
    return P


def zip_tie(center, axis, R, wfn, r=0.0042):
    axis = unit(axis)
    a = unit(np.cross(axis, [0.31, 0.47, 0.83]))
    b = np.cross(axis, a)
    ang = np.linspace(0, TAU * 1.05, 10)
    ctrl = [center + R * (math.cos(t) * a + math.sin(t) * b) for t in ang]
    tube(ctrl, r, sides=3, uv_rect=R_ZIP, wfn=wfix(wfn(center)), seg=TAU * R / 7.5, twist=0.0, per_seg=4)


def box(center, size, R, wfn, rect=R_BOX):
    center = np.asarray(center, float)
    hs = np.asarray(size, float) / 2
    w = wfn(center)
    ids = {}
    for i in (0, 1):
        for j in (0, 1):
            for k in (0, 1):
                ids[i, j, k] = MB_.v(center + R @ (hs * np.array([2 * i - 1, 2 * j - 1, 2 * k - 1])), w)
    faces = [((0, 0, 0), (0, 1, 0), (0, 1, 1), (0, 0, 1), (-1, 0, 0)), ((1, 0, 0), (1, 1, 0), (1, 1, 1), (1, 0, 1), (1, 0, 0)),
             ((0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1), (0, -1, 0)), ((0, 1, 0), (1, 1, 0), (1, 1, 1), (0, 1, 1), (0, 1, 0)),
             ((0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (0, 0, -1)), ((0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1), (0, 0, 1))]
    uvq = [rect_uv(rect, 0, 0), rect_uv(rect, 1, 0), rect_uv(rect, 1, 1), rect_uv(rect, 0, 1)]
    for a, b_, c, d, n in faces:
        MB_.f_oriented([ids[a], ids[b_], ids[c], ids[d]], uvq, R @ np.array(n, float))


def frame_from(normal, xdir):
    n = unit(normal)
    x = unit(np.asarray(xdir, float) - np.dot(xdir, n) * n)
    return np.stack([x, np.cross(n, x), n], 1)  # columns: x, y, n


def tile_fragment(center, normal, xdir, outline, thick, wfn, bend=0.6):
    """Broken ceiling-tile piece: an irregular slab, top face in the tile region, broken edges in the edge one."""
    Rm = frame_from(normal, xdir)
    center = np.asarray(center, float)
    w = wfn(center)
    o = np.asarray(outline, float)
    span = np.abs(o).max() * 2.2

    def pt(x, y, z):
        return center + Rm @ np.array([x, y, z - bend * (x * x + y * y)])
    top = [MB_.v(pt(x, y, thick / 2), w) for x, y in o]
    bot = [MB_.v(pt(x, y, -thick / 2), w) for x, y in o]
    ct, cb = MB_.v(pt(0, 0, thick / 2), w), MB_.v(pt(0, 0, -thick / 2), w)
    n = len(o)
    uv = [rect_uv(R_TILE, 0.5 + x / span, 0.5 + y / span) for x, y in o]
    uvc = rect_uv(R_TILE, 0.5, 0.5)
    nrm = Rm[:, 2]
    for j in range(n):
        j1 = (j + 1) % n
        MB_.f_oriented([ct, top[j], top[j1]], [uvc, uv[j], uv[j1]], nrm)
        MB_.f_oriented([cb, bot[j1], bot[j]], [uvc, uv[j1], uv[j]], -nrm)
        edge_out = Rm @ np.array([*(unit(o[j] + o[j1])), 0.0])
        a0, a1 = j / n, (j + 1) / n
        MB_.f_oriented([top[j], top[j1], bot[j1], bot[j]],
                       [rect_uv(R_EDGE, 0.1, a0), rect_uv(R_EDGE, 0.1, a1), rect_uv(R_EDGE, 0.9, a1),
                        rect_uv(R_EDGE, 0.9, a0)], edge_out)


def ragged_outline(rx, ry, n=8, jitter=0.25):
    out = []
    for k in range(n):
        a = TAU * k / n + rng.uniform(-0.25, 0.25)
        rr = 1 + rng.uniform(-jitter, jitter)
        out.append((rx * rr * math.cos(a), ry * rr * math.sin(a)))
    return out


# ---------------------------------------------------------------------------------------------------------------
# Head: gourd surface, wire loops, slit mouth, frills
# ---------------------------------------------------------------------------------------------------------------
HEAD_Z0, HEAD_H = 1.94, 0.43
GP = np.array([[0, 0.0], [0.015, 0.055], [0.04, 0.09], [0.08, 0.107], [0.11, 0.11], [0.14, 0.101], [0.17, 0.092],
               [0.20, 0.104], [0.24, 0.133], [0.29, 0.151], [0.34, 0.145], [0.38, 0.122], [0.41, 0.078], [0.43, 0.0]])
SLIT_H0, SLIT_H1 = 0.075, 0.37
DEPTH = 0.92


def g_r(h):
    return float(np.interp(h, GP[:, 0], GP[:, 1]))


def g_axis(h):
    return np.array([0.0, -0.285 - 0.015 * h / HEAD_H, HEAD_Z0 + h])


def g_pt(h, a, scale=1.0, off=0.0):
    """Point on the gourd at height h (0..HEAD_H) and azimuth a (0 = front, + towards +X), pushed out by off."""
    r = g_r(h) * scale
    e = 0.004
    drdh = (g_r(min(h + e, HEAD_H)) - g_r(max(h - e, 0))) / (2 * e) * scale
    nr, nz = 1.0, -drdh
    ln = math.hypot(nr, nz)
    nr, nz = nr / ln, nz / ln
    rr = r + off * nr
    return g_axis(h) + np.array([rr * math.sin(a), -DEPTH * rr * math.cos(a), off * nz])


def slit_w(h):
    if h <= SLIT_H0 or h >= SLIT_H1:
        return 0.0
    return 0.064 * math.sin(math.pi * (h - SLIT_H0) / (SLIT_H1 - SLIT_H0)) ** 0.6


def slit_ang(h, margin=0.016):
    return math.asin(min(1.0, (slit_w(h) + margin) / max(g_r(h), 0.03)))


def g_front_y(h):
    return g_pt(h, 0.0)[1]


W_HEAD = wnear(['neck_02', 'head'], blend=0.04)


def build_head():
    w_head = wfix({'head': 1.0})
    # wire loops: open great circles on a sphere mapped onto the gourd, pushed aside around the mouth slit
    for i in range(11):
        phi = math.pi * i / 11 + rng.uniform(-0.12, 0.12)
        nvec = unit([math.cos(phi), math.sin(phi), rng.uniform(-0.45, 0.45)])
        a = unit(np.cross(nvec, [0, 0, 1]))
        b = np.cross(nvec, a)
        th_low = math.atan2(-b[2], -a[2])
        gap = 0.55
        off = 0.011 + 0.003 * (i % 3)
        raw = []
        for th in np.linspace(th_low + gap / 2, th_low + TAU - gap / 2, 30):
            p = math.cos(th) * a + math.sin(th) * b
            h = HEAD_H * (1 - math.acos(float(np.clip(p[2], -1, 1))) / math.pi)
            raw.append((float(np.clip(h, 0.012, HEAD_H - 0.012)), math.atan2(p[0], -p[1])))
        zone = [SLIT_H0 - 0.02 < h < SLIT_H1 + 0.02 and abs(az) < slit_ang(h) for h, az in raw]
        # A run of points over the slit is pushed to one edge; a run that enters on one side and leaves on the
        # other is cut instead, both ends tucked into the head at the slit edges (no wire across the mouth).
        pieces, k = [[]], 0
        while k < len(raw):
            if not zone[k]:
                pieces[-1].append(g_pt(*raw[k], off=off))
                k += 1
                continue
            j = k
            while j < len(raw) and zone[j]:
                j += 1
            s_in = math.copysign(1, raw[k - 1][1]) if k > 0 else None
            s_out = math.copysign(1, raw[j][1]) if j < len(raw) else None
            if s_in is None or s_out is None or s_in == s_out:
                side = s_in if s_in is not None else (s_out if s_out is not None else 1.0)
                pieces[-1] += [g_pt(h, side * slit_ang(h), off=off) for h, _ in raw[k:j]]
            else:
                pieces[-1].append(g_pt(raw[k][0], s_in * slit_ang(raw[k][0]), off=-0.006))
                pieces.append([g_pt(raw[j - 1][0], s_out * slit_ang(raw[j - 1][0]), off=-0.006)])
            k = j
        r_loop = rng.uniform(0.0095, 0.0115)
        for pts in pieces:
            if len(pts) >= 3:
                tube(pts, r_loop, sides=3, col=COL_BLACK if i % 3 else COL_GREY, wfn=W_HEAD, seg=0.046, per_seg=3)
    # wraps around the waist of the gourd, open at the slit
    for h0 in (0.12, 0.165, 0.215):
        a0 = slit_ang(h0) + 0.03
        pts = []
        for k, az in enumerate(np.linspace(a0, TAU - a0, 16)):
            h = h0 + 0.012 * math.sin(3 * az)
            pts.append(g_pt(h, az, off=0.013))
        pts[0] = g_pt(h0, a0, off=-0.004)
        pts[-1] = g_pt(h0, TAU - a0, off=-0.004)
        tube(pts, 0.0095, sides=3, wfn=W_HEAD, seg=0.04, per_seg=3)
    # three cut wires sticking out of the crown, bent backwards
    for k in range(3):
        az = math.pi + rng.uniform(-0.9, 0.9)
        base = g_pt(0.385, az, off=0.0)
        d = unit(np.array([math.sin(az) * 0.5, 0.9, 0.3]) + rng.normal(0, 0.1, 3))
        ctrl = [base - d * 0.01, base + d * 0.05, base + d * 0.09 + np.array([0, 0.02, -0.02])]
        tube(ctrl, 0.004, sides=3, col=COL_GREY, wfn=w_head, seg=0.05, end1='tip')
    # dark inner core (so the gaps between the wires show black), recessed behind the slit
    hs = np.linspace(0.006, HEAD_H - 0.004, 9)
    rings = []
    for h in hs:
        pts = []
        for az in np.linspace(0, TAU, 10, endpoint=False):
            sc = 0.80
            if SLIT_H0 - 0.02 < h < SLIT_H1 + 0.02 and (abs(az) < 0.7 or abs(az - TAU) < 0.7):
                sc = 0.66
            pts.append(g_pt(h, az, scale=sc))
        rings.append(pts)
    ids = [[MB_.v(p, W_HEAD(p)) for p in ring] for ring in rings]
    cu = col_u(COL_BLACK)
    for k in range(len(ids) - 1):
        connect(MB_, ids[k], ids[k + 1], 0.1 * k, 0.1 * (k + 1), cu)
    cap(MB_, ids[0], g_axis(0.0), W_HEAD(g_axis(0.0)), BLACK_CAP_UV, end=False)
    cap(MB_, ids[-1], g_axis(HEAD_H), w_head(None), BLACK_CAP_UV, end=True)
    # mouth: two bakelite plates on vertical hinges (jaw_L / jaw_R)
    for S, sg in (('L', 1), ('R', -1)):
        zs = np.linspace(HEAD_Z0 + SLIT_H0 - 0.005, HEAD_Z0 + SLIT_H1 + 0.005, 7)
        wj = wfix({f'jaw_{S}': 1.0})
        front, back = [], []
        for z in zs:
            h = z - HEAD_Z0
            wo = slit_w(h) + 0.010
            yf = g_front_y(min(max(h, 0.0), HEAD_H)) - 0.002
            xs = [0.0025, (0.0025 + wo) / 2, wo]
            front.append([MB_.v((sg * x, yf - 0.004 + 0.006 * (x / 0.06) ** 2, z), wj(None)) for x in xs])
            back.append([MB_.v((sg * x, yf + 0.007 + 0.006 * (x / 0.06) ** 2, z), wj(None)) for x in xs])
        nz_ = len(zs)
        for i in range(nz_ - 1):
            for c in range(2):
                uvs = [rect_uv(R_BAKE, c / 2, i / (nz_ - 1)), rect_uv(R_BAKE, (c + 1) / 2, i / (nz_ - 1)),
                       rect_uv(R_BAKE, (c + 1) / 2, (i + 1) / (nz_ - 1)), rect_uv(R_BAKE, c / 2, (i + 1) / (nz_ - 1))]
                MB_.f_oriented([front[i][c], front[i][c + 1], front[i + 1][c + 1], front[i + 1][c]], uvs,
                               np.array([0, -1.0, 0]), smooth_=True)
                MB_.f_oriented([back[i][c], back[i][c + 1], back[i + 1][c + 1], back[i + 1][c]], uvs,
                               np.array([0, 1.0, 0]), smooth_=True)
            for c, nx in ((0, -sg), (2, sg)):  # inner and outer rims
                MB_.f_oriented([front[i][c], front[i + 1][c], back[i + 1][c], back[i][c]],
                               [rect_uv(R_BAKE, 0.0, i / 7), rect_uv(R_BAKE, 0.0, (i + 1) / 7),
                                rect_uv(R_BAKE, 0.05, (i + 1) / 7), rect_uv(R_BAKE, 0.05, i / 7)],
                               np.array([nx, 0, 0.0]))
        for i, nzv in ((0, -1.0), (nz_ - 1, 1.0)):
            for c in range(2):
                MB_.f_oriented([front[i][c], front[i][c + 1], back[i][c + 1], back[i][c]],
                               [rect_uv(R_BAKE, 0, 0), rect_uv(R_BAKE, 0.1, 0), rect_uv(R_BAKE, 0.1, 0.05),
                                rect_uv(R_BAKE, 0, 0.05)], np.array([0, 0, nzv]))
    # copper wire rings lining the cavity (the "teeth")
    for z in np.linspace(HEAD_Z0 + SLIT_H0 + 0.035, HEAD_Z0 + SLIT_H1 - 0.035, 5):
        h = z - HEAD_Z0
        wk = slit_w(h) * 0.97 + 0.006
        yf = g_front_y(h)
        ctrl = [(wk + 0.008, yf + 0.006, z), (wk, yf + 0.014, z), (0.65 * wk, yf + 0.03, z), (0, yf + 0.036, z),
                (-0.65 * wk, yf + 0.03, z), (-wk, yf + 0.014, z), (-wk - 0.008, yf + 0.006, z)]
        tube(ctrl, 0.005, sides=3, col=COL_COPPER, wfn=w_head, seg=0.02, per_seg=3)
    # the cracked fluorescent starter, deep in the slit (second material, emissive)
    cz, cy = 2.165, g_front_y(0.225) + 0.03
    rings = []
    for k, z in enumerate((cz - 0.022, cz + 0.016, cz + 0.022)):
        pts = []
        for j in range(6):
            a = TAU * j / 6
            rr = 0.0105 if k < 2 else 0.0105 * (0.55 + 0.45 * ((j * 7919) % 5) / 4)
            zz = z if k < 2 else z + 0.006 * ((j * 31) % 3 - 1)
            pts.append((rr * math.cos(a), cy + rr * math.sin(a), zz))
        rings.append([MB_.v(p, w_head(None)) for p in pts])
    for k in range(2):
        connect(MB_, rings[k], rings[k + 1], 0.2 * k, 0.2 * (k + 1), (0.0, 1.0), mat=1)
    cap(MB_, rings[0], (0, cy, cz - 0.026), w_head(None), (0.5, 0.5), mat=1, end=False)
    cap(MB_, rings[2], (0, cy, cz + 0.012), w_head(None), (0.5, 0.5), mat=1, end=True)
    # four listening frills: torn aluminium duct strip plus a fan of cut wire ends
    for S in ('L', 'R'):
        for idx, beta in (('01', 35.0), ('02', -25.0)):
            bname = f'sensor_{S}_{idx}'
            h0, t0 = HEAD0[bname], TAIL0[bname]
            d = unit(t0 - h0)
            L = LEN[bname]
            e0 = unit(np.cross(d, [0, 0, 1]))
            z0 = np.cross(e0, d)
            if z0[2] < 0:
                z0 = -z0
            bb = math.radians(beta)
            e = math.cos(bb) * e0 + math.sin(bb) * z0
            nrm = unit(np.cross(d, e))
            wf = wnear(['head', bname], blend=0.05)
            for k, g in enumerate(np.linspace(-20, 20, 5)):
                gr = math.radians(g + rng.uniform(-4, 4))
                dw = unit(math.cos(gr) * d + math.sin(gr) * e + nrm * rng.uniform(-0.12, 0.12))
                ln = L * rng.uniform(0.95, 1.12)
                ctrl = [h0 - d * 0.02, h0 + dw * ln * 0.45 + np.array([0, 0, -0.008]), h0 + dw * ln]
                tube(ctrl, 0.0045, sides=3, col=COL_GREY if k % 2 else COL_BLACK, wfn=wf, seg=ln / 2.2,
                     end1='tip', per_seg=4)
            # duct strip: 5 stations along, 3 across, crinkled, cut into a fringe at the far end
            grid = []
            for i, a in enumerate(np.linspace(0.04, 0.88, 5)):
                width = 0.045 + 0.11 * a
                row = []
                for j, bj in enumerate((-0.5, 0.0, 0.5)):
                    fringe = (0.045 if j != 1 else -0.015) if i == 4 else 0.0
                    crink = 0.009 * (1 if (i + j) % 2 else -1)
                    row.append(h0 + d * (a * L + fringe + rng.uniform(-0.006, 0.006)) + e * bj * width + nrm * crink)
                grid.append(row)
            for side_off, flip in ((0.0015, False), (-0.0015, True)):
                vid = [[MB_.v(p + nrm * side_off, wf(p)) for p in row] for row in grid]
                for i in range(4):
                    for j in range(2):
                        uvs = [rect_uv(R_DUCT, i / 4, j / 2), rect_uv(R_DUCT, i / 4, (j + 1) / 2),
                               rect_uv(R_DUCT, (i + 1) / 4, (j + 1) / 2), rect_uv(R_DUCT, (i + 1) / 4, j / 2)]
                        MB_.f_oriented([vid[i][j], vid[i][j + 1], vid[i + 1][j + 1], vid[i + 1][j]], uvs,
                                       -nrm if flip else nrm, smooth_=True)


# ---------------------------------------------------------------------------------------------------------------
# Body: torso cage, neck, arms, claws, legs, broom feet, tail, attachments
# ---------------------------------------------------------------------------------------------------------------
S_PTS = np.array([[0, 0.05, 1.00], [0, 0.03, 1.10], [0, 0.02, 1.27], [0, 0.0, 1.45], [0, -0.06, 1.62],
                  [0, -0.16, 1.79], [0, -0.21, 1.85]])
S_RX = np.array([0.085, 0.145, 0.125, 0.155, 0.21, 0.215, 0.10])
S_RY = np.array([0.07, 0.11, 0.10, 0.125, 0.15, 0.13, 0.085])
_SD = catmull(S_PTS, 24)
_ST = np.linspace(0, len(S_PTS) - 1, len(_SD))
_STAN = np.gradient(_SD, axis=0)
W_TORSO = wnear(['pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01'])


def torso_pt(t, th, rho=1.0, extra=0.0):
    c = np.array([np.interp(t, _ST, _SD[:, k]) for k in range(3)])
    tg = unit([np.interp(t, _ST, _STAN[:, k]) for k in range(3)])
    bvec = unit(np.cross(tg, [1, 0, 0]))
    rx = np.interp(t, np.arange(len(S_RX)), S_RX) * rho + extra
    ry = np.interp(t, np.arange(len(S_RY)), S_RY) * rho + extra
    return c + rx * math.cos(th) * np.array([1.0, 0, 0]) + ry * math.sin(th) * bvec


def bundle(center_ctrl, per_seg=14):
    C = catmull(center_ctrl, per_seg)
    T, N, B = transport_frames(C)
    return C, N, B, np.linspace(0, len(center_ctrl) - 1, len(C))


def bpt(BD, t, ang, rho):
    C, N, B, tp = BD
    c = np.array([np.interp(t, tp, C[:, k]) for k in range(3)])
    n = unit([np.interp(t, tp, N[:, k]) for k in range(3)])
    b = unit([np.interp(t, tp, B[:, k]) for k in range(3)])
    return c + rho * (math.cos(ang) * n + math.sin(ang) * b)


def btan(BD, t):
    C, N, B, tp = BD
    e = 0.02
    return unit(bpt(BD, min(t + e, tp[-1]), 0, 0) - bpt(BD, max(t - e, 0), 0, 0))


def build_torso():
    for c in range(14):
        th0 = TAU * c / 14 + rng.normal(0, 0.08)
        turns = (0.28 if c % 2 else -0.28) + rng.normal(0, 0.05)
        t0, t1 = rng.uniform(0.0, 0.45), rng.uniform(5.2, 6.0)
        rho = rng.uniform(0.93, 1.04)
        ts = np.linspace(t0, t1, 9)
        ctrl = [torso_pt(t, th0 + TAU * turns * (t - t0) / (t1 - t0) + 0.06 * math.sin(3 * t + c), rho) for t in ts]
        tube(ctrl, rng.uniform(0.016, 0.021), sides=3 if c % 3 else 4, col=COL_GREY if c % 4 == 0 else COL_BLACK,
             wfn=W_TORSO, seg=0.075)
    # rib cage of wound cable around the chest, plus one waist wrap
    for tc, turns in ((3.35, 1.05), (3.95, 1.1), (4.55, 1.0), (2.0, 1.15)):
        tha = rng.uniform(0, TAU)
        n = 26
        ctrl = [torso_pt(tc - 0.17 + 0.34 * k / (n - 1), tha + TAU * turns * k / (n - 1), 1.13) for k in range(n)]
        tube(ctrl, 0.011, sides=3, wfn=W_TORSO, seg=0.06, per_seg=3, col=COL_BLACK if tc > 3 else COL_GREY)
    # inner core: dark elliptical tube
    rings = []
    for t in np.linspace(0.0, 6.0, 9):
        rings.append([torso_pt(t, a, 0.78) for a in np.linspace(0, TAU, 8, endpoint=False)])
    ids = [[MB_.v(p, W_TORSO(p)) for p in r_] for r_ in rings]
    cu = col_u(COL_BLACK)
    for k in range(len(ids) - 1):
        connect(MB_, ids[k], ids[k + 1], 0.1 * k, 0.1 * (k + 1), cu)
    cap(MB_, ids[0], torso_pt(0.0, 0, 0) - np.array([0, 0, 0.02]), W_TORSO(S_PTS[0]), BLACK_CAP_UV, end=False)
    # two conduits crossing the torso: front left shoulder -> right hip, back right shoulder -> left hip
    for th_a, th_b in ((-math.pi / 2 + 0.95, -math.pi / 2 - 0.9), (math.pi / 2 + 0.95, math.pi / 2 - 0.9)):
        ctrl = [torso_pt(5.55 - 4.3 * k / 7, th_a + (th_b - th_a) * k / 7, 1.07) for k in range(8)]
        tube(ctrl, 0.0115, sides=5, col=COL_CONDUIT, wfn=W_TORSO, seg=0.06, end0='cap', end1='cap', twist=0.0)
    zip_tie(torso_pt(1.95, 0, 0), np.array([0, -0.08, 1.0]), 0.155, W_TORSO, r=0.005)


def build_neck():
    BD = bundle([(0, -0.10, 1.68), HEAD0['neck_01'], HEAD0['neck_02'], HEAD0['head'], (0, -0.29, 2.05)])
    wf = wnear(['spine_03', 'neck_01', 'neck_02', 'head'], blend=0.05)
    for c in range(3):
        a0 = TAU * c / 3 + 0.3
        ctrl = [bpt(BD, t, a0 + TAU * 0.45 * t / 4, 0.034) for t in np.linspace(0, 4, 9)]
        tube(ctrl, 0.022, sides=5, col=COL_BLACK if c else COL_GREY, wfn=wf, seg=0.06, twist=0.4)
    zip_tie(bpt(BD, 2.0, 0, 0), btan(BD, 2.0), 0.062, wf, r=0.005)


def build_arm(S, sg):
    sh, el, wr, kn = HEAD0[f'upperarm_{S}'], HEAD0[f'forearm_{S}'], HEAD0[f'hand_{S}'], TAIL0[f'hand_{S}']
    BD = bundle([sh + np.array([0, 0, 0.03]), el, wr, kn])
    rt = [0, 0.5, 0.9, 1.0, 1.1, 1.5, 1.9, 2.0, 2.5, 3.0]
    rv = [0.058, 0.056, 0.046, 0.05, 0.048, 0.06, 0.044, 0.034, 0.04, 0.034]

    def rho(t):
        return float(np.interp(t, rt, rv))
    allowed = ['spine_02', 'spine_03', f'clavicle_{S}', f'upperarm_{S}', f'forearm_{S}', f'hand_{S}']
    wf = wnear(allowed)
    starts = [(0.07, -0.21, 1.58), (0.10, 0.07, 1.62), (0.05, -0.09, 1.83), (0.16, -0.10, 1.52), (0.14, 0.05, 1.50)]
    for c in range(5):
        st = np.array(starts[c]) * np.array([sg, 1, 1])
        ang = TAU * c / 5 + rng.uniform(-0.2, 0.2)
        turns = 0.8 * sg
        t_end = rng.uniform(2.25, 3.0)
        rs = rng.uniform(0.9, 1.12)
        top = bpt(BD, 0.0, ang, rho(0) * rs)
        mid = (st + top) / 2 + np.array([0.02 * sg, 0, 0.05])
        ctrl = [st, mid] + [bpt(BD, t, ang + TAU * turns * t / 3, rho(t) * rs) for t in np.arange(0.12, t_end, 0.3)]
        ctrl.append(bpt(BD, t_end, ang + TAU * turns * t_end / 3, rho(t_end) * rs))
        cut = 'copper' if (t_end < 2.85 and c % 2 == 0) else None
        tube(ctrl, rng.uniform(0.013, 0.017), sides=3, col=COL_GREY if c == 3 else COL_BLACK, wfn=wf, seg=0.075,
             end1=cut)
    tube([bpt(BD, t, 0, 0) for t in np.linspace(0.0, 3.0, 10)], 0.026, sides=4, wfn=wf, seg=0.085,
         end0='cap', end1='cap')
    # elbow coil
    ts = np.linspace(0.88, 1.12, 16)
    ctrl = [bpt(BD, t, TAU * 1.25 * k / 15 * sg, rho(t) + 0.02) for k, t in enumerate(ts)]
    tube(ctrl, 0.008, sides=3, wfn=wf, seg=0.03, per_seg=3, col=COL_GREY)
    zip_tie(bpt(BD, 1.96, 0, 0), btan(BD, 1.96), rho(1.96) + 0.014, wf)
    zip_tie(bpt(BD, 0.5, 0, 0), btan(BD, 0.5), rho(0.5) + 0.018, wf)
    # conduit from the upper back over the shoulder, spiralling down the upper arm
    ca = rng.uniform(0, TAU)
    ctrl = [np.array([0.12 * sg, 0.07, 1.70]), np.array([0.20 * sg, -0.04, 1.86]),
            bpt(BD, 0.3, ca, rho(0.3) + 0.012), bpt(BD, 0.6, ca + 1.6 * sg, rho(0.6) + 0.012),
            bpt(BD, 0.92, ca + 3.0 * sg, rho(0.92) + 0.012)]
    if S == 'R':
        ctrl += [bpt(BD, 1.3, ca + 4.3 * sg, rho(1.3) + 0.012), bpt(BD, 1.6, ca + 5.2 * sg, rho(1.6) + 0.012)]
    tube(ctrl, 0.0095, sides=5, col=COL_CONDUIT, wfn=wf, seg=0.06, end0='cap', end1='cap', twist=0.0)
    # three hooked wire claws, bound at the knuckles
    for k in ('01', '02', '03'):
        bname = f'claw_{S}_{k}'
        h0, d, L = HEAD0[bname], DIR0[bname], LEN[bname]
        fwd = unit(np.array([-0.35 * sg, -1.0, 0.0]) - np.dot([-0.35 * sg, -1.0, 0.0], d) * d)
        ctrl = [h0 - d * 0.035, h0 + d * 0.35 * L, h0 + d * 0.75 * L + fwd * 0.004, h0 + d * 1.0 * L + fwd * 0.035,
                h0 + d * 0.92 * L + fwd * 0.08, h0 + d * 0.74 * L + fwd * 0.095]
        tube(ctrl, 0.0105, sides=4, col=COL_CONDUIT, wfn=wnear([f'hand_{S}', bname], blend=0.04), seg=0.036,
             rad=lambda f: 1.0 - 0.62 * f ** 1.5, end0='cap', end1='cap', twist=0.0, per_seg=6)
    zip_tie(kn + DIR0[f'hand_{S}'] * 0.005, DIR0[f'hand_{S}'], 0.038, wnear([f'hand_{S}']), r=0.005)
    # junction box on the shoulder front, and one on the left elbow / right forearm
    box(np.array([0.17 * sg, -0.245, 1.735]), (0.065, 0.04, 0.062), E(8, 0, -20 * sg), wfix({f'clavicle_{S}': 1.0}))
    if S == 'L':
        box(bpt(BD, 0.85, 0, 0) + np.array([0.06, 0.01, 0]), (0.03, 0.05, 0.06), E(0, 0, 10),
            wfix({'upperarm_L': 1.0}))
    else:
        box(bpt(BD, 1.45, 0, 0) + np.array([-0.06, 0.0, 0]), (0.03, 0.05, 0.06), E(-8, 0, -12),
            wfix({'forearm_R': 1.0}))


def build_leg(S, sg):
    hip, kn, an = HEAD0[f'thigh_{S}'], HEAD0[f'shin_{S}'], HEAD0[f'foot_{S}']
    BD = bundle([hip + np.array([0, 0, 0.06]), kn, an])
    rt = [0, 0.4, 0.85, 1.0, 1.15, 1.6, 2.0]
    rv = [0.062, 0.055, 0.04, 0.046, 0.036, 0.03, 0.026]

    def rho(t):
        return float(np.interp(t, rt, rv))
    wf = wnear(['pelvis', 'spine_01', f'thigh_{S}', f'shin_{S}', f'foot_{S}', f'toe_{S}'])
    starts = [(0.05, -0.09, 1.24), (0.08, 0.12, 1.22), (0.16, 0.0, 1.32), (0.03, 0.04, 1.05), (0.07, 0.10, 1.34)]
    for c in range(5):
        st = np.array(starts[c]) * np.array([sg, 1, 1])
        ang = TAU * c / 5 + rng.uniform(-0.2, 0.2)
        rs = rng.uniform(0.9, 1.1)
        ctrl = [st] + [bpt(BD, t, ang + TAU * 0.5 * sg * t / 2, rho(t) * rs) for t in np.linspace(0.08, 1.98, 8)]
        tube(ctrl, rng.uniform(0.0135, 0.017), sides=3, col=COL_GREY if c == 2 else COL_BLACK, wfn=wf, seg=0.08)
    tube([bpt(BD, t, 0, 0) for t in np.linspace(-0.05, 2.0, 8)], 0.024, sides=4, wfn=wf, seg=0.09,
         end0='cap', end1='cap')
    ts = np.linspace(0.9, 1.1, 18)
    ctrl = [bpt(BD, t, -TAU * 1.4 * k / 17 * sg, rho(t) + 0.018) for k, t in enumerate(ts)]
    tube(ctrl, 0.0085, sides=3, wfn=wf, seg=0.028, per_seg=3)
    zip_tie(bpt(BD, 1.86, 0, 0), btan(BD, 1.86), rho(1.86) + 0.014, wf)
    zip_tie(bpt(BD, 0.45, 0, 0), btan(BD, 0.45), rho(0.45) + 0.018, wf)
    # conduit down the outside of the thigh
    ca = math.pi * (0 if sg > 0 else 1)
    ctrl = [np.array([0.17 * sg, 0.0, 1.27]), bpt(BD, 0.2, ca, rho(0.2) + 0.013), bpt(BD, 0.55, ca + 1.0, rho(0.55) + 0.013),
            bpt(BD, 0.88, ca + 2.0, rho(0.88) + 0.013)]
    tube(ctrl, 0.009, sides=5, col=COL_CONDUIT, wfn=wf, seg=0.06, end0='cap', end1='cap', twist=0.0)
    # frayed broom foot: strands splaying from the ankle onto the floor. Below the ankle they follow only the
    # foot and toe, so they stay flat on the floor when the shin swings.
    w_ankle = wnear([f'shin_{S}', f'foot_{S}', f'toe_{S}'])
    w_floor = wnear([f'foot_{S}', f'toe_{S}'])

    def w_broom(p):
        return w_ankle(p) if p[2] > 0.10 else w_floor(p)
    for k, psi in enumerate((-70, -40, -12, 16, 44, 150, 205)):
        pr = math.radians(psi + rng.uniform(-6, 6))
        dvec = np.array([math.sin(pr) * sg, -math.cos(pr), 0.0])
        dist = rng.uniform(0.2, 0.29) if abs(psi) < 100 else rng.uniform(0.11, 0.14)
        base = an + np.array(rng.uniform(-0.012, 0.012, 3))
        end = np.array([base[0] + dvec[0] * dist, base[1] + dvec[1] * dist, 0.007])
        ctrl = [base + np.array([0, 0, 0.04]), base + dvec * 0.04 + np.array([0, 0, -0.03]),
                base + dvec * dist * 0.55 + np.array([0, 0, -0.105]), end]
        tube(ctrl, rng.uniform(0.0065, 0.0085), sides=3, col=COL_BLACK if k % 3 else COL_GREY, wfn=w_broom, seg=0.065,
             end1='tip' if k % 2 == 0 else 'cap')
    if S == 'L':
        box(np.array([0.185, -0.035, 1.21]), (0.04, 0.06, 0.06), E(0, 0, 15), wfix({'pelvis': 1.0}))


def build_tail():
    pts = [(0, 0.07, 1.48), HEAD0['cable_tail_01'], HEAD0['cable_tail_02'], HEAD0['cable_tail_03'],
           TAIL0['cable_tail_03'], (0.0, 0.60, 0.03), (0.04, 0.84, 0.014)]
    BD = bundle(pts, per_seg=10)
    wf = wnear(['spine_01', 'spine_02', 'cable_tail_01', 'cable_tail_02', 'cable_tail_03'])
    for c in range(4):
        a0 = TAU * c / 4 + rng.uniform(-0.3, 0.3)
        t_end = (6.0, 5.4, 4.9, 5.7)[c]
        ts = np.arange(0, t_end, 0.4).tolist() + [t_end]
        ctrl = [bpt(BD, t, a0 + TAU * 1.2 * t / 6, 0.032 - 0.002 * t) for t in ts]
        if c:
            ctrl[-1] = ctrl[-1] + np.array([rng.uniform(-0.08, 0.08), rng.uniform(0, 0.05), 0])
        for k in range(len(ctrl)):
            ctrl[k] = np.array(ctrl[k])
            ctrl[k][2] = max(ctrl[k][2], 0.012)
        tube(ctrl, rng.uniform(0.012, 0.016), sides=3, col=COL_GREY if c == 1 else COL_BLACK, wfn=wf, seg=0.085,
             end1='copper')
    zip_tie(bpt(BD, 2.0, 0, 0), btan(BD, 2.0), 0.05, wf, r=0.005)


def build_attachments():
    # stained ceiling-tile fragments stuck to the shoulders and the upper back
    tile_fragment((0.205, -0.135, 1.885), (0.35, 0.05, 1.0), (1, -0.3, 0), ragged_outline(0.11, 0.075), 0.017,
                  wfix({'clavicle_L': 1.0}))
    tile_fragment((-0.215, -0.15, 1.872), (-0.4, -0.05, 1.0), (1, 0.4, 0), ragged_outline(0.07, 0.055), 0.015,
                  wfix({'clavicle_R': 1.0}))
    tile_fragment((0.06, 0.07, 1.71), (0.1, 1.0, 0.45), (1, 0, 0.2), ragged_outline(0.06, 0.045, n=7), 0.014,
                  wfix({'spine_03': 1.0}))


def build_mesh():
    parts = [('torso', build_torso), ('neck', build_neck)]
    for S, sg in (('L', 1), ('R', -1)):
        parts += [(f'arm_{S}', lambda S=S, sg=sg: build_arm(S, sg)), (f'leg_{S}', lambda S=S, sg=sg: build_leg(S, sg))]
    parts += [('tail', build_tail), ('attachments', build_attachments), ('head', build_head)]
    for name, fn in parts:
        t0, v0 = MB_.tris(), len(MB_.V)
        fn()
        zmax = max(v[2] for v in MB_.V[v0:])
        print(f'  part {name:12s} {MB_.tris() - t0:5d} tris, top {zmax:.3f}')


# ---------------------------------------------------------------------------------------------------------------
# Textures (numpy) and materials
# ---------------------------------------------------------------------------------------------------------------
def tnoise(shape, sigma, seed):
    r = np.random.default_rng(seed).standard_normal(shape)
    fy = np.fft.fftfreq(shape[0])[:, None]
    fx = np.fft.fftfreq(shape[1])[None, :]
    g = np.exp(-2 * (math.pi * sigma) ** 2 * (fx ** 2 + fy ** 2))
    n = np.real(np.fft.ifft2(np.fft.fft2(r) * g))
    return np.clip(n / (3 * n.std() + 1e-9), -1, 1)


def build_textures(S=1024):
    H = W = S
    base = np.zeros((H, W, 3))
    rough = np.full((H, W), 0.5)
    metal = np.zeros((H, W))
    hgt = np.zeros((H, W))
    kmap = np.zeros((H, W))
    V = (1 - (np.arange(H) + 0.5) / H)[:, None]
    cw, m = W // 8, 4

    def colnoise(sig, seed):
        n = tnoise((H, cw - 2 * m), sig, seed)
        return np.pad(n, ((0, 0), (m, m)), mode='wrap')
    lu = ((np.arange(cw) - m) / (cw - 2 * m))[None, :]
    for col in range(4):
        sl = (slice(None), slice(col * cw, (col + 1) * cw))
        nz = colnoise(6, 10 + col)
        nf = colnoise(1.2, 20 + col)
        if col in (0, 1):
            nstr, pitch = (3, 28) if col == 0 else (2, 20)
            ph = (nstr * lu + pitch * V) % 1.0
            prof = np.sqrt(np.clip(1 - (2 * ph - 1) ** 2, 0, 1))
            tone = np.array([0.071, 0.063, 0.055]) if col == 0 else np.array([0.12, 0.115, 0.105])
            c = tone[None, None, :] * (0.8 + 0.3 * prof[..., None] + 0.12 * nz[..., None])
            dust = (1 - prof) ** 4 * (0.5 + 0.5 * nz)
            c += np.array([0.09, 0.08, 0.06])[None, None, :] * dust[..., None] * 0.7
            base[sl] = c
            rough[sl] = 0.48 + 0.14 * (1 - prof) + 0.05 * nf
            hgt[sl] = prof + 0.05 * nf
            kmap[sl] = 2.5
        elif col == 2:
            ph = (lu + 90 * V) % 1.0
            prof = (0.5 + 0.5 * np.cos(TAU * ph)) ** 0.6
            c = np.array([0.30, 0.30, 0.285])[None, None, :] * (0.45 + 0.55 * prof[..., None])
            rust = np.clip(nz - 0.35, 0, 1)[..., None] * np.array([0.25, 0.12, 0.04])[None, None, :]
            base[sl] = c * (1 - 0.6 * np.clip(nz - 0.35, 0, 1)[..., None]) + rust
            metal[sl] = 0.85 - 0.35 * (1 - prof) - 0.5 * np.clip(nz - 0.35, 0, 1)
            rough[sl] = 0.36 + 0.3 * (1 - prof) + 0.1 * nf
            hgt[sl] = prof
            kmap[sl] = 2.0
        else:
            ph = (11 * lu + 5 * V) % 1.0
            prof = np.sin(math.pi * ph) ** 0.6
            c = np.array([0.722, 0.451, 0.20])[None, None, :] * (0.7 + 0.35 * prof[..., None])
            tarn = np.clip(nz, 0, 1)[..., None]
            base[sl] = c * (1 - 0.45 * tarn) + np.array([0.18, 0.12, 0.07])[None, None, :] * tarn * 0.6
            metal[sl] = 1.0
            rough[sl] = 0.28 + 0.2 * (1 - prof) + 0.15 * tarn[..., 0]
            hgt[sl] = prof
            kmap[sl] = 2.0

    def region(R):
        c0, c1 = int(R[0] * W), int(R[2] * W)
        r0, r1 = int((1 - R[3]) * H), int((1 - R[1]) * H)
        h_, w_ = r1 - r0, c1 - c0
        a = ((np.arange(w_) + 0.5) / w_)[None, :]
        b = (1 - (np.arange(h_) + 0.5) / h_)[:, None]
        return (slice(r0, r1), slice(c0, c1)), a, b, (h_, w_)
    # tile: mineral fibre, pits, water stains
    sl, a, b, shp = region(R_TILE)
    mott = tnoise(shp, 1.5, 31)
    big = tnoise(shp, 22, 32)
    stain = tnoise(shp, 34, 33)
    pits = (np.random.default_rng(34).random(shp) > 0.991).astype(float)
    pits = np.clip(np.real(np.fft.ifft2(np.fft.fft2(pits) * np.exp(
        -2 * (math.pi * 1.1) ** 2 * (np.fft.fftfreq(shp[0])[:, None] ** 2 + np.fft.fftfreq(shp[1])[None, :] ** 2))))
        * 6, 0, 1)
    blot = smooth((stain - 0.05) / 0.25)
    ring = np.exp(-((stain - 0.05) / 0.03) ** 2)
    c = np.array([0.784, 0.761, 0.651])[None, None, :] * (1 + 0.05 * big[..., None] + 0.04 * mott[..., None])
    c = c * (1 - 0.22 * blot[..., None] * np.array([0.6, 0.8, 1.2])[None, None, :]) \
        - ring[..., None] * np.array([0.16, 0.17, 0.2])[None, None, :]
    c = c * (1 - 0.55 * pits[..., None])
    base[sl] = np.clip(c, 0, 1)
    rough[sl] = 0.93
    hgt[sl] = 0.3 * mott - pits
    kmap[sl] = 1.5
    # broken tile edge
    sl, a, b, shp = region(R_EDGE)
    n = tnoise(shp, 1.3, 41)
    base[sl] = np.array([0.83, 0.80, 0.70])[None, None, :] * (0.9 + 0.12 * n[..., None])
    rough[sl] = 0.96
    hgt[sl] = n
    kmap[sl] = 2.0
    # junction box: grey paint, raised border, knockout ring, grime and rust specks
    sl, a, b, shp = region(R_BOX)
    edge = np.minimum(np.minimum(a, 1 - a), np.minimum(b, 1 - b))
    border = smooth((edge - 0.05) / 0.04)
    rr = np.hypot(a - 0.5, b - 0.5)
    knock = np.exp(-((rr - 0.17) / 0.012) ** 2)
    grime = tnoise(shp, 8, 51)
    rust = np.clip(tnoise(shp, 2.5, 52) - 0.55, 0, 1) * 3
    c = np.array([0.42, 0.43, 0.41])[None, None, :] * (0.75 + 0.25 * border[..., None]) * (1 - 0.15 * grime[..., None])
    c = c * (1 - 0.6 * knock[..., None]) * (1 - rust[..., None]) + rust[..., None] * np.array([0.32, 0.17, 0.07])
    base[sl] = np.clip(c, 0, 1)
    metal[sl] = 0.55 * (1 - rust)
    rough[sl] = 0.5 + 0.2 * grime + 0.3 * rust
    hgt[sl] = border * 0.6 - knock * 0.5
    kmap[sl] = 3.0
    # aluminium duct: crinkled foil
    sl, a, b, shp = region(R_DUCT)
    hc = np.zeros(shp)
    r_ = np.random.default_rng(61)
    for k in range(7):
        ang = r_.uniform(0, math.pi)
        fr = r_.uniform(3, 11)
        hc += np.abs(np.sin(TAU * fr * (a * math.cos(ang) + b * math.sin(ang)) + r_.uniform(0, TAU))) / (1 + k * 0.3)
    hc = (hc - hc.min()) / (hc.max() - hc.min())
    nd = tnoise(shp, 3, 62)
    base[sl] = np.array([0.69, 0.69, 0.67])[None, None, :] * (0.72 + 0.3 * hc[..., None] + 0.06 * nd[..., None])
    metal[sl] = 0.95
    rough[sl] = 0.3 + 0.15 * (1 - hc) + 0.08 * nd
    hgt[sl] = hc
    kmap[sl] = 2.5
    # bakelite mouth plates
    sl, a, b, shp = region(R_BAKE)
    nb = tnoise(shp, 5, 71)
    cr = np.exp(-((tnoise(shp, 18, 72)) / 0.02) ** 2) * 0.6
    base[sl] = np.array([0.105, 0.068, 0.048])[None, None, :] * (0.85 + 0.25 * nb[..., None]) + cr[..., None] * 0.05
    rough[sl] = 0.33 + 0.1 * nb + 0.3 * cr
    hgt[sl] = 0.2 * nb - cr
    kmap[sl] = 2.0
    # zip ties: ribbed grey plastic
    sl, a, b, shp = region(R_ZIP)
    prof = 0.5 + 0.5 * np.cos(TAU * 34 * b + 0 * a)
    base[sl] = np.array([0.27, 0.27, 0.25])[None, None, :] * (0.85 + 0.2 * prof[..., None])
    rough[sl] = 0.55
    hgt[sl] = prof * np.ones_like(a)
    kmap[sl] = 1.5
    # normal map from the height field (OpenGL convention: +Y = +v)
    dx = (np.roll(hgt, -1, 1) - np.roll(hgt, 1, 1)) / 2
    dy = (np.roll(hgt, 1, 0) - np.roll(hgt, -1, 0)) / 2
    nrm = np.stack([-kmap * dx, -kmap * dy, np.ones_like(hgt)], -1)
    nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True)
    one = np.ones((H, W, 1))
    base_rgba = np.concatenate([np.clip(base, 0, 1), one], -1)
    nrm_rgba = np.concatenate([nrm * 0.5 + 0.5, one], -1)
    orm = np.stack([np.ones((H, W)), np.clip(rough, 0.05, 1), np.clip(metal, 0, 1)], -1)
    orm = orm.reshape(H // 2, 2, W // 2, 2, 3).mean(axis=(1, 3))
    orm_rgba = np.concatenate([orm, np.ones((H // 2, W // 2, 1))], -1)
    return base_rgba, nrm_rgba, orm_rgba


def jpeg_image(name, rgba, quality, non_color=False):
    """Packed JPEG image from a float array (row 0 at the top). The glTF exporter embeds packed JPEG bytes as they
    are, which keeps the file small (PNG of these noisy maps is several MB). The JPEG goes through a build folder in
    the system temp directory, overwritten on every build."""
    h, w, _ = rgba.shape
    src = bpy.data.images.new(name + '_src', width=w, height=h, alpha=False)
    src.pixels.foreach_set(np.ascontiguousarray(rgba[::-1]).astype(np.float32).ravel())
    folder = pathlib.Path(tempfile.gettempdir()) / 'level0_blender_build'
    folder.mkdir(exist_ok=True)
    path = folder / f'{name}.jpg'
    src.filepath_raw = str(path)
    src.file_format = 'JPEG'
    src.save(quality=quality)
    bpy.data.images.remove(src)
    img = bpy.data.images.load(str(path))
    img.name = name
    img.pack()
    if non_color:
        img.colorspace_settings.name = 'Non-Color'
    return img


def build_materials():
    b, n, o = build_textures()
    img_b = jpeg_image('howler_basecolor', b, 90)
    img_n = jpeg_image('howler_normal', n, 92, non_color=True)
    img_o = jpeg_image('howler_orm', o, 92, non_color=True)
    mat = common.material('howler_body', color=(1, 1, 1), base_image=img_b, normal_image=img_n, normal_strength=1.0)
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes['Principled BSDF']
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = img_o
    sep = nodes.new('ShaderNodeSeparateColor')
    links.new(tex.outputs['Color'], sep.inputs['Color'])
    links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
    links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    glow = common.material('howler_starter', color=(0.85, 0.86, 0.80), roughness=0.3, emission=(1.0, 0.92, 0.70),
                           emission_strength=1.6)
    for m in (mat, glow):
        m.use_backface_culling = True   # single-sided in glTF; the thin duct strips are modelled with two faces
    return mat, glow


# ---------------------------------------------------------------------------------------------------------------
# Pose solver: rotations authored in armature axes (relative to the parent's motion) or world deltas, two-bone IK
# for legs and arms. Produces Blender local quaternions per bone.
# ---------------------------------------------------------------------------------------------------------------
REST, RROT, RINV = {}, {}, {}


def two_bone(H, T, a, b, pole):
    d = T - H
    dist = float(np.linalg.norm(d))
    u = d / max(dist, 1e-9)
    dist = float(np.clip(dist, abs(a - b) + 1e-3, (a + b) * 0.9995))
    v = unit(pole - np.dot(pole, u) * u)
    x = (a * a - b * b + dist * dist) / (2 * dist)
    y = math.sqrt(max(a * a - x * x, 0.0))
    return H + u * x + v * y, H + u * dist


def solve(spec):
    """spec: rel{bone:R}, world{bone:R}, trans{bone:t}, ik{('leg'|'arm', side):(target, pole)}."""
    M, D, L, TL = {}, {}, {}, {}
    ikdir = {}
    I3 = np.eye(3)
    for name in NAMES:
        p = PARENT[name]
        Rb = RROT[name]
        base = (M[p] @ RINV[p] @ REST[name]) if p else REST[name].copy()
        Dp = D[p] if p else I3
        h = base[:3, 3]
        side = name[-1]
        t = spec['trans'].get(name)
        if t is not None:
            h = h + Dp @ t
        Db = None
        for kind, upper, lower in (('leg', 'thigh_', 'shin_'), ('arm', 'upperarm_', 'forearm_')):
            if name == upper + side and (kind, side) in spec['ik']:
                tgt, pole = spec['ik'][(kind, side)]
                K, Tt = two_bone(h, np.asarray(tgt, float), LEN[name], LEN[lower + side], unit(pole))
                Db = arc(Dp @ DIR0[name], K - h) @ Dp
                ikdir[lower + side] = unit(Tt - K)
        if Db is None and name in ikdir:
            Db = arc(Dp @ DIR0[name], ikdir[name]) @ Dp
        if Db is None:
            Db = spec['world'][name] if name in spec['world'] else Dp @ spec['rel'].get(name, I3)
        Q = Dp.T @ Db
        Lb = Rb.T @ Q @ Rb
        tl = Rb.T @ t if t is not None else np.zeros(3)
        basis = np.eye(4)
        basis[:3, :3] = Lb
        basis[:3, 3] = tl
        M[name] = base @ basis
        D[name] = Db
        L[name] = Lb
        TL[name] = tl
    return M, D, L, TL


def wpos(M, b, p):
    """World position of the rest point p carried by bone b."""
    return (M[b] @ RINV[b] @ np.array([*p, 1.0]))[:3]


# ---------------------------------------------------------------------------------------------------------------
# Pose parameters -> spec
# ---------------------------------------------------------------------------------------------------------------
A0 = {'L': HEAD0['foot_L'].copy(), 'R': HEAD0['foot_R'].copy()}
POLE_LEG = {'L': np.array([0.2, 1.0, 0.0]), 'R': np.array([-0.2, 1.0, 0.0])}
SIDES = (('L', 1), ('R', -1))


def sym(**kw):
    out = {}
    for k, v in kw.items():
        out[k + '_L'] = v
        out[k + '_R'] = v
    return out


DEF = dict(px=0.0, py=0.0, pz=0.0, pp=0.0, proll=0.0, pyaw=0.0, hunch=0.0, sroll=0.0, syaw=0.0, neck=0.0, nyaw=0.0,
           hp=0.0, hy=0.0, hr=0.0, jaw=0.0, fo=0.0, ff=0.0, t1=0.0, t2=0.0, t3=0.0, ty1=0.0, ty2=0.0, ty3=0.0,
           s1x=0.0, s3x=0.0,
           **sym(clf=0.0, cld=0.0, ap=0.0, aab=0.0, ayaw=0.0, el=0.0, hd=0.0, cw=0.0, cs=0.0, fp=0.0, tp=0.0,
                 fu=0.0, fl=0.0, ffs=0.0, jx=0.0))
DEF['lg_L'] = A0['L'].copy()
DEF['lg_R'] = A0['R'].copy()

STANCE = dict(DEF)
STANCE.update(pz=-0.03, pp=2.0, hunch=16.0, neck=26.0, hp=-34.0, t1=3.0, t2=4.0, t3=4.0)
STANCE.update(sym(clf=12.0, cld=5.0, ap=-8.0, aab=3.0, el=-14.0, hd=-6.0, cw=-15.0))


def P_(**kw):
    p = dict(STANCE)
    p.update(kw)
    return p


def build_spec(P):
    rel, world, trans, ik = {}, {}, {}, {}
    trans['pelvis'] = np.array([P['px'], P['py'], P['pz']])
    rel['pelvis'] = E(P['pp'], P['proll'], P['pyaw'])
    for b, k in (('spine_01', 0.25), ('spine_02', 0.35), ('spine_03', 0.40)):
        extra = P['s1x'] if b == 'spine_01' else (P['s3x'] if b == 'spine_03' else 0.0)
        rel[b] = E(P['hunch'] * k + extra, P['sroll'] * k, P['syaw'] * k)
    rel['neck_01'] = E(P['neck'] * 0.5, 0, P['nyaw'] * 0.5)
    rel['neck_02'] = E(P['neck'] * 0.5, P['hr'] * 0.3, P['nyaw'] * 0.5 + P['hy'] * 0.3)
    if 'hw' in P:   # head orientation given in world space (jump scare)
        world['head'] = P['hw']
    else:
        rel['head'] = E(P['hp'], P['hr'] * 0.7, P['hy'] * 0.7)
    for S, sg in SIDES:
        rel[f'jaw_{S}'] = Es(S, 0, 0, P['jaw'] + P['jx_' + S])
        rel[f'sensor_{S}_01'] = Es(S, 0, -(P['fo'] + P['fu_' + S]), -(P['ff'] + P['ffs_' + S]))
        rel[f'sensor_{S}_02'] = Es(S, 0, 0.8 * (P['fo'] + P['fl_' + S]), -(P['ff'] + P['ffs_' + S]))
        rel[f'clavicle_{S}'] = Es(S, 0, P['cld_' + S], -P['clf_' + S])
        if ('aik_' + S) in P:
            ik[('arm', S)] = (P['aik_' + S], P.get('apole_' + S, np.array([0.6 * sg, 1.0, 0.1])))
        else:
            world[f'upperarm_{S}'] = Es(S, P['ap_' + S], -P['aab_' + S], P['ayaw_' + S])
            rel[f'forearm_{S}'] = Es(S, P['el_' + S], 0, 0)
        if ('hw_' + S) in P:
            world[f'hand_{S}'] = P['hw_' + S]
        else:
            rel[f'hand_{S}'] = Es(S, P['hd_' + S], 0, 0)
        for k, spread in (('01', -1), ('02', 0), ('03', 1)):
            rel[f"claw_{S}_{k}"] = Es(S, P["cw_" + S] + 3 * spread, 0, spread * P["cs_" + S])
        if ('lfk_' + S) in P:   # legs in FK (death)
            th, sh = P['lfk_' + S]
            rel[f'thigh_{S}'] = Es(S, th[0], th[1], th[2])
            rel[f'shin_{S}'] = Es(S, sh, 0, 0)
            rel[f'foot_{S}'] = Es(S, P['fp_' + S], 0, 0)
        else:
            ik[('leg', S)] = (P['lg_' + S], P.get('lpole_' + S, POLE_LEG[S]))
            world[f'foot_{S}'] = Es(S, P['fp_' + S], 0, P.get('fyaw_' + S, 0.0))
        rel[f'toe_{S}'] = Es(S, P['tp_' + S], 0, 0)
    rel['cable_tail_01'] = E(P['t1'], 0, P['ty1'])
    rel['cable_tail_02'] = E(P['t2'], 0, P['ty2'])
    rel['cable_tail_03'] = E(P['t3'], 0, P['ty3'])
    return dict(rel=rel, world=world, trans=trans, ik=ik)


def lerp_P(a, b, w):
    out = {}
    for k in set(a) | set(b):
        va, vb = a.get(k, DEF.get(k)), b.get(k, DEF.get(k))
        if va is None:
            va = vb
        if vb is None:
            vb = va
        if isinstance(va, np.ndarray) and va.shape == (3, 3):   # world rotations (hw, hw_L, hw_R)
            out[k] = slerp_m(va, vb, w)
        else:   # numbers and 3-vectors (IK targets, poles)
            out[k] = va * (1 - w) + vb * w
    return out


def slerp_m(A, B, w):
    qa, qb = Matrix(A.tolist()).to_quaternion(), Matrix(B.tolist()).to_quaternion()
    return np.array(qa.slerp(qb, w).to_matrix())


EASE = {
    'io': lambda u: float(smooth(u)),
    'o': lambda u: 1 - (1 - u) ** 2.5,
    'snap': lambda u: 1 - (1 - u) ** 4,
    'i': lambda u: u ** 2,
    'l': lambda u: u,
}


def keyed(f, keys):
    """keys: [(frame, P, ease)] - ease shapes the segment arriving at that key."""
    if f <= keys[0][0]:
        return dict(keys[0][1])
    for (f0, p0, _), (f1, p1, e) in zip(keys, keys[1:]):
        if f <= f1:
            u = (f - f0) / (f1 - f0)
            return lerp_P(p0, p1, EASE[e](u))
    return dict(keys[-1][1])


def pkeys(phi, keys):
    """Periodic keys [(t in 0..1, value)] with smoothstep segments (holds, then quick twitches)."""
    phi %= 1.0
    n = len(keys)
    for i in range(n):
        t0, v0 = keys[i]
        t1, v1 = keys[(i + 1) % n]
        if i == n - 1:
            t1 += 1.0
        x = phi if phi >= t0 else phi + 1.0
        if t0 <= x <= t1:
            u = float(smooth((x - t0) / (t1 - t0)))
            return np.asarray(v0, float) * (1 - u) + np.asarray(v1, float) * u
    return np.asarray(keys[0][1], float)


def hermite(p0, p1, m0, m1, u):
    h00, h10 = 2 * u ** 3 - 3 * u ** 2 + 1, u ** 3 - 2 * u ** 2 + u
    h01, h11 = -2 * u ** 3 + 3 * u ** 2, u ** 3 - u ** 2
    return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1


FOOT_VEC = TAIL0['foot_L'] - HEAD0['foot_L']


def heel_lift(pitch):
    """How far the ankle must rise for the ball of the foot to stay on the floor when the foot pitches toes-down."""
    a = math.radians(pitch)
    return max(0.0, -(FOOT_VEC[1] * math.sin(a) + FOOT_VEC[2] * math.cos(a)) + FOOT_VEC[2])


def limb_cycle(phi, offset, stride, duty, lift, home, ground_z, roll=28.0, reach=0.5):
    """In-place foot/hand target over one cycle: the stance slides backwards at the clip speed (no foot slip).

    Returns (target, foot pitch, toe pitch, in stance). Late in the stance the heel rolls up over the ball of the
    foot (toes stay flat on the floor); in the swing the frayed toes trail and droop."""
    p = (phi - offset) % 1.0
    S = stride * duty
    pos = np.array(home, float)
    if p < duty:
        q = p / duty
        fwd = S / 2 - S * q
        pitch = roll * float(smooth((q - 0.72) / 0.28))
        toe = -pitch
        up = heel_lift(pitch)
    else:
        q = (p - duty) / (1 - duty)
        m = -S * (1 - duty) / duty * reach
        fwd = hermite(-S / 2, S / 2, m, m, q)
        r0 = roll * (1 - float(smooth(q * 2.2)))
        pitch = r0 + 24 * math.sin(math.pi * q)
        toe = -r0 + 22 * math.sin(math.pi * q)
        up = lift * math.sin(math.pi * q) ** 0.9 + heel_lift(r0)
    pos[1] -= fwd
    pos[2] = ground_z + up
    return pos, pitch, toe, p < duty


# ---------------------------------------------------------------------------------------------------------------
# Clips
# ---------------------------------------------------------------------------------------------------------------
def gait_legs(P, phi, stride, duty, lift, offsets=(0.0, 0.5), xw=0.15, yc=-0.01, reach=0.5):
    for (S, sg), off in zip(SIDES, offsets):
        home = np.array([xw * sg, yc, A0[S][2]])
        tgt, pitch, toe, _ = limb_cycle(phi, off, stride, duty, lift, home, A0[S][2], reach=reach)
        P['lg_' + S] = tgt
        P['fp_' + S] = pitch
        P['tp_' + S] = toe


def clip_idle_listen(f, N):
    phi = f / N
    s2 = math.sin(TAU * 2 * phi)
    P = P_()
    P['pz'] += 0.006 * s2
    P['hunch'] += 1.5 * math.sin(TAU * 2 * phi + 1.0) + 2.0
    P['px'] = 0.012 * math.sin(TAU * phi)
    P['proll'] = 1.2 * math.sin(TAU * phi)
    hr, hy, hp = pkeys(phi, [(0.00, (16, 10, -2)), (0.28, (18, 12, 0)), (0.33, (-10, -14, -6)), (0.58, (-12, -12, -4)),
                             (0.63, (4, 20, 4)), (0.86, (6, 18, 2)), (0.93, (16, 10, -2))])
    P['hr'], P['hy'], P['hp'] = hr, hy, P['hp'] + hp
    twitch = float(pkeys(phi, [(0.0, 0.0), (0.30, 0.0), (0.335, 1.0), (0.42, 0.0), (0.60, 0.0), (0.635, 1.0),
                               (0.72, 0.0), (0.90, 0.0)]))
    P['fo'] = 6 + 18 * twitch + 3 * math.sin(TAU * 3 * phi)
    for S, ph in (('L', 0.0), ('R', 0.37)):
        P['fu_' + S] = 5 * math.sin(TAU * (7 * phi + ph))
        P['fl_' + S] = 5 * math.sin(TAU * (7 * phi + ph + 0.2))
        P['ffs_' + S] = 6 * math.sin(TAU * (2 * phi + ph))
        P['ap_' + S] += 2.5 * math.sin(TAU * (phi + ph))
        P['cw_' + S] += -14 * twitch + 4 * math.sin(TAU * (4 * phi + ph))
    P['jaw'] = 1.5 + 6 * twitch
    P['ty1'], P['ty2'], P['ty3'] = (6 * math.sin(TAU * phi), 8 * math.sin(TAU * phi - 0.8),
                                    10 * math.sin(TAU * phi - 1.6))
    P['t2'] += 2 * math.sin(TAU * phi - 0.5)
    return P


def clip_walk(f, N):
    phi = f / N
    P = P_()
    gait_legs(P, phi, stride=1.85 * N / 30, duty=0.62, lift=0.15)
    P['pz'] = -0.075 + 0.02 * math.cos(TAU * 2 * (phi - 0.12))
    P['px'] = 0.022 * math.sin(TAU * (phi - 0.05))
    P['pyaw'] = -5 * math.cos(TAU * phi)
    P['proll'] = 2.5 * math.sin(TAU * phi)
    P['syaw'] = 8 * math.cos(TAU * phi)
    P['hunch'] += 4 + 1.5 * math.cos(TAU * 2 * phi)
    P['hy'] = -0.6 * (P['pyaw'] + P['syaw']) + 4 * math.sin(TAU * phi)
    P['hr'] = 7
    P['hp'] -= 2 * math.cos(TAU * 2 * phi)
    for S, sg in SIDES:
        sw = math.cos(TAU * (phi - (0.5 if S == 'L' else 0.0)))
        P['ap_' + S] = -12 - 15 * sw
        P['el_' + S] = -18 - 8 * max(0.0, sw)
        P['cw_' + S] = -18 + 5 * sw
    P['fo'] = 5 + 3 * math.sin(TAU * 2 * phi)
    P['fu_L'] = P['fl_R'] = 3 * math.sin(TAU * 4 * phi)
    P['ty1'], P['ty2'], P['ty3'] = (7 * math.sin(TAU * phi - 0.5), 9 * math.sin(TAU * phi - 1.2),
                                    11 * math.sin(TAU * phi - 1.9))
    P['t1'] += 3 * math.cos(TAU * 2 * phi)
    P['jaw'] = 1.0
    return P


def clip_stalk(f, N):
    phi = f / N
    P = P_()
    gait_legs(P, phi, stride=3.2 * N / 30, duty=0.45, lift=0.22, yc=0.0)
    P['pz'] = -0.13 + 0.03 * math.cos(TAU * 2 * (phi - 0.15))
    P['pyaw'] = -6 * math.cos(TAU * phi)
    P['syaw'] = 7 * math.cos(TAU * phi)
    P['proll'] = 2 * math.sin(TAU * phi)
    P['hunch'] = 34 + 2 * math.cos(TAU * 2 * phi)
    P['pp'] = 6
    P['neck'] = -16
    P['hp'] = -20 + 2.5 * math.cos(TAU * 2 * phi)
    P['hy'] = -0.7 * (P['pyaw'] + P['syaw'])
    P['ff'] = 22
    P['fo'] = 14 + 4 * math.sin(TAU * 2 * phi)
    for S, sg in SIDES:
        sw = math.cos(TAU * (phi - (0.5 if S == 'L' else 0.0)))
        P['ap_' + S] = -20 - 10 * sw
        P['aab_' + S] = 9
        P['el_' + S] = -30 + 6 * sw
        P['hd_' + S] = -12
        P['cw_' + S] = -28
        P['clf_' + S] = 18
        P['fu_' + S] = 4 * math.sin(TAU * (5 * phi + (0.0 if S == 'L' else 0.3)))
    P['t1'], P['t2'], P['t3'] = 14 + 3 * math.cos(TAU * 2 * phi), 8, 6
    P['ty1'], P['ty2'], P['ty3'] = (6 * math.sin(TAU * phi - 0.5), 8 * math.sin(TAU * phi - 1.2),
                                    10 * math.sin(TAU * phi - 1.9))
    P['jaw'] = 3
    return P


def clip_run_search(f, N):
    phi = f / N
    P = P_()
    gait_legs(P, phi, stride=3.64 * N / 30, duty=0.38, lift=0.24, yc=0.0)
    P['pz'] = -0.095 + 0.035 * math.cos(TAU * 2 * (phi - 0.15))
    P['pyaw'] = -6 * math.cos(TAU * phi)
    P['syaw'] = 9 * math.cos(TAU * phi)
    P['proll'] = 2.5 * math.sin(TAU * phi)
    P['hunch'] = 22 + 2 * math.cos(TAU * 2 * phi)
    hy, hr = pkeys(phi, [(0.0, (-30, -10)), (0.38, (-34, -12)), (0.5, (30, 10)), (0.88, (34, 12))])
    P['hy'] = hy - 0.6 * (P['pyaw'] + P['syaw'])
    P['hr'] = hr
    P['hp'] = -10 - 2 * math.cos(TAU * 2 * phi)
    P['fo'] = 18 + 5 * math.sin(TAU * 4 * phi)
    P['ffs_L'] = 12 if hy < 0 else -6
    P['ffs_R'] = 12 if hy > 0 else -6
    for S, sg in SIDES:
        sw = math.cos(TAU * (phi - (0.5 if S == 'L' else 0.0)))
        P['ap_' + S] = -14 - 24 * sw
        P['aab_' + S] = 8
        P['el_' + S] = -32 - 10 * max(0.0, sw)
        P['cw_' + S] = -8
        P['cs_' + S] = 10
    P['t1'], P['t2'], P['t3'] = 12, 8, 6
    P['ty1'], P['ty2'], P['ty3'] = (7 * math.sin(TAU * phi - 0.5), 9 * math.sin(TAU * phi - 1.2),
                                    12 * math.sin(TAU * phi - 1.9))
    P['jaw'] = 4
    return P


LOPE_BASE = dict(pz=-0.17, pp=16.0, hunch=42.0, neck=-34.0, hp=-30.0)


def hold_head_z(P, z_target, iters=4):
    """Adjust the neck pitch (and counter-rotate the head) so that the head centre sits at z_target."""
    n_ref, hp_ref = P['neck'], P['hp']

    def hz(nk):
        Q = dict(P, neck=nk, hp=hp_ref - 0.9 * (nk - n_ref))
        return wpos(solve(build_spec(Q))[0], 'head', HEAD_CENTER)[2]
    n0, n1 = n_ref, n_ref - 10.0
    z0, z1 = hz(n0), hz(n1)
    for _ in range(iters):
        if abs(z1 - z0) < 1e-7:
            break
        n2 = float(np.clip(n1 + (z_target - z1) * (n1 - n0) / (z1 - z0), -95.0, 30.0))
        n0, z0, n1, z1 = n1, z1, n2, hz(n2)
    P['neck'], P['hp'] = n1, hp_ref - 0.9 * (n1 - n_ref)


def lope_body(phi):
    P = P_(**LOPE_BASE)
    flex = math.cos(TAU * (phi - 0.95))
    P['hunch'] += 6 * flex
    P['pz'] += 0.035 * math.sin(TAU * (phi - 0.1))
    P['pp'] += 3 * math.cos(TAU * (phi - 0.6))
    P['hp'] -= 0.7 * (6 * flex + 3 * math.cos(TAU * (phi - 0.6)))
    P['pyaw'] = 3 * math.sin(TAU * phi)
    P['syaw'] = -3 * math.sin(TAU * phi)
    for S in ('L', 'R'):
        P['clf_' + S] = 16
        P['cld_' + S] = 22
    return P


def clip_lope(f, N):
    phi = f / N
    stride = 4.55 * N / 30
    P = lope_body(phi)
    gait_legs(P, phi, stride=stride, duty=0.30, lift=0.26, offsets=(0.0, 0.08), xw=0.16, yc=0.08, reach=0.6)
    # the craned neck holds the head steady at 1.6-1.8 m while the back flexes
    hold_head_z(P, 1.70 + 0.025 * math.sin(TAU * (phi - 0.2)))
    # front limbs: knuckle gallop, the hooked claws strike the floor
    M, D, _, _ = solve(build_spec(P))
    for (S, sg), off in zip(SIDES, (0.50, 0.58)):
        sh = M[f'upperarm_{S}'][:3, 3]
        home = np.array([0.30 * sg, sh[1] - 0.06, 0.0])
        tgt, pitch, _, stance = limb_cycle(phi, off, stride, 0.30, 0.30, home, 0.27, roll=20.0, reach=0.6)
        P['aik_' + S] = tgt
        P['apole_' + S] = np.array([0.5 * sg, 1.0, 0.3])
        P['hw_' + S] = Es(S, -8 + 0.9 * pitch, 0, 0)
        P['cw_' + S] = -8 - 1.2 * pitch
        P['cs_' + S] = 12
    P['ff'] = -26
    P['fo'] = -6
    for S, ph in (('L', 0.0), ('R', 0.25)):
        P['fu_' + S] = 6 * math.sin(TAU * (2 * phi + ph))
        P['fl_' + S] = 6 * math.sin(TAU * (2 * phi + ph + 0.15))
    P['jaw'] = 9 + 3 * math.sin(TAU * phi)
    P['t1'], P['t2'], P['t3'] = 8 + 5 * math.sin(TAU * phi), 10 + 6 * math.sin(TAU * phi - 0.9), \
        8 + 8 * math.sin(TAU * phi - 1.8)
    P['ty1'], P['ty2'], P['ty3'] = (5 * math.sin(TAU * phi), 7 * math.sin(TAU * phi - 0.9),
                                    9 * math.sin(TAU * phi - 1.8))
    return P


def idle0():
    return clip_idle_listen(0, 72)


ALERT = P_(hunch=10.0, hp=-14.0, hy=-20.0, hr=-4.0, fo=32.0, jaw=4.0, **sym(cw=-30.0, ap=-12.0, aab=8.0))


def clip_notice(f, N):
    snap = P_(hunch=8.0, hp=-16.0, hy=-26.0, hr=-6.0, fo=38.0, jaw=10.0, pz=-0.02,
              **sym(cw=-38.0, ap=-16.0, aab=12.0, el=-20.0, clf=8.0))
    over = dict(snap, hy=-31.0, fo=30.0, hr=-3.0)
    return keyed(f, [(0, idle0(), 'l'), (3, snap, 'snap'), (6, over, 'o'), (12, ALERT, 'io')])


def clip_screech(f, N):
    inhale = P_(hunch=4.0, pp=-4.0, neck=-12.0, hp=-28.0, jaw=16.0, fo=22.0, **sym(aab=24.0, ap=-20.0, el=-24.0,
                                                                                     cw=-30.0))
    thrust = P_(hunch=28.0, pp=4.0, neck=16.0, hp=-42.0, jaw=72.0, fo=46.0, py=-0.03,
                **sym(aab=42.0, ap=-36.0, el=-22.0, cw=-50.0, cs=22.0, clf=4.0))
    keys = [(0, ALERT, 'l'), (4, inhale, 'io'), (7, thrust, 'snap'), (14, dict(thrust, jaw=66.0, hunch=26.0), 'l'),
            (18, P_(fo=20.0, jaw=8.0, hunch=20.0), 'io')]
    P = keyed(f, keys)
    if 6 <= f <= 15:  # shaking scream
        k = math.sin(math.pi * (f - 6) / 9)
        P['hr'] += 5 * k * math.sin(f * 2.7)
        P['hy'] += 4 * k * math.sin(f * 3.9)
        P['jaw'] += 5 * k * math.sin(f * 4.4)
        for S, ph in (('L', 0.0), ('R', 1.1)):
            P['fu_' + S] = 11 * k * math.sin(f * 3.1 + ph)
            P['fl_' + S] = 11 * k * math.sin(f * 2.6 + ph)
    return P


WINDUP_END = P_(hunch=10.0, pp=-2.0, py=0.03, pz=-0.07, neck=6.0, hp=-20.0, jaw=46.0, fo=40.0,
                **sym(ap=-78.0, aab=26.0, ayaw=78.0, el=-36.0, hd=-12.0, cw=-42.0, cs=16.0, clf=4.0))
STRIKE_END = P_(hunch=38.0, pp=6.0, py=-0.12, pz=-0.10, neck=4.0, hp=-26.0, jaw=56.0, fo=36.0,
                **sym(ap=-46.0, aab=10.0, ayaw=-44.0, el=-22.0, hd=-6.0, cw=-20.0, cs=6.0, clf=22.0))


def clip_attack_windup(f, N):
    start = P_(hunch=22.0)
    return keyed(f, [(0, start, 'l'), (9, WINDUP_END, 'io')])


def clip_attack_strike(f, N):
    mid = lerp_P(WINDUP_END, STRIKE_END, 0.5)
    mid.update(sym(ayaw=12.0, ap=-72.0, el=-14.0))
    return keyed(f, [(0, WINDUP_END, 'l'), (3, mid, 'i'), (5, dict(STRIKE_END, **sym(ayaw=-36.0)), 'o'),
                     (7, STRIKE_END, 'o')])


def clip_attack_recover(f, N):
    return keyed(f, [(0, STRIKE_END, 'l'), (15, P_(), 'io')])


def clip_stagger(f, N):
    hit = P_(hunch=6.0, pp=-2.0, py=0.03, neck=-8.0, hp=-18.0, hr=14.0, fo=-22.0, jaw=22.0,
             **sym(ap=12.0, aab=24.0, el=-32.0, cw=-2.0))
    hold = dict(hit, hunch=2.0, hr=18.0, hy=6.0)
    return keyed(f, [(0, P_(), 'l'), (2, hit, 'snap'), (6, hold, 'io'), (15, P_(), 'io')])


def clip_death(f, N):
    spasm = P_(hunch=4.0, hp=-32.0, hr=24.0, jaw=50.0, fo=50.0, **sym(aab=34.0, ap=-32.0, el=-42.0, cw=-62.0))
    give = P_(pz=-0.20, hunch=26.0, hp=-10.0, hr=14.0, jaw=32.0, fo=20.0, proll=6.0,
              **sym(aab=24.0, ap=-14.0, el=-24.0, cw=-30.0))
    pile = P_(pz=-0.80, py=-0.06, pp=30.0, proll=14.0, hunch=44.0, neck=26.0, hp=4.0, hr=50.0, jaw=18.0, fo=-30.0,
              t1=10.0, t2=-40.0, t3=20.0, **sym(clf=4.0, cld=-10.0, el=-55.0, cw=-50.0, hd=10.0))
    pile.update(ap_L=-36.0, aab_L=60.0, ayaw_L=10.0, ap_R=-30.0, aab_R=66.0, ayaw_R=-12.0)
    pile['lg_L'] = A0['L'] + np.array([0.12, 0.02, 0.0])
    pile['lg_R'] = A0['R'] + np.array([-0.16, 0.06, 0.0])
    bounce = dict(pile, pz=-0.76, hunch=40.0, neck=22.0)
    rest = dict(pile, pz=-0.81, hunch=45.0, neck=28.0, fo=-36.0, jaw=12.0)
    return keyed(f, [(0, P_(), 'l'), (3, spasm, 'snap'), (7, give, 'io'), (17, pile, 'i'), (20, bounce, 'o'),
                     (24, rest, 'io')])


# Jump scare "Short Circuit" around the static JS_CAM: arms wide, claws slam either side of the lens, the head
# drops in from above, the slit mouth opens, then the whole head rushes into the lens.
JS_BASE = dict(hunch=8.0, pp=0.0, neck=-20.0)


def js_key(head, look_pitch, wrist_x, wrist_y, wrist_z, jaw, fo, cw, cs, lunge):
    P = P_(**JS_BASE)
    P['hunch'] += 46 * lunge
    P['pp'] += 10 * lunge
    P['neck'] += 12 * lunge
    P['head_target'] = np.array(head, float)
    P['hw'] = E(look_pitch, 0, 0)
    P['jaw'] = jaw
    P['fo'] = fo
    P['ff'] = 10.0
    P['lg_L'] = A0['L'] + np.array([0.03, -0.36, 0.0])
    P['lg_R'] = A0['R'] + np.array([-0.02, 0.12, heel_lift(24.0)])
    P['fp_R'] = 24.0
    P['tp_R'] = -24.0
    for S, sg in SIDES:
        P['aik_' + S] = np.array([wrist_x * sg, wrist_y, wrist_z])
        P['apole_' + S] = np.array([1.0 * sg, 0.5, 0.6])
        P['hw_' + S] = Es(S, -84.0, 180.0, -22.0)
        P['cw_' + S] = cw
        P['cs_' + S] = cs
        P['clf_' + S] = 6.0
        P['cld_' + S] = -12.0
    return P


JS_KEYS = None


def clip_jumpscare(f, N):
    global JS_KEYS
    if JS_KEYS is None:
        JS_KEYS = [
            (0, js_key((0, -0.40, 2.20), 30, 0.80, -0.48, 1.86, 8, 34, -8, 26, 0.0), 'l'),
            (4, js_key((0, -0.41, 2.15), 26, 0.70, -0.55, 1.86, 10, 44, -12, 24, 0.15), 'io'),
            (7, js_key((0, -0.42, 1.95), 14, 0.43, -0.52, 1.80, 12, 52, -48, 14, 0.5), 'snap'),
            (10, js_key((0, -0.43, 1.73), 2, 0.43, -0.53, 1.79, 18, 52, -50, 14, 0.75), 'o'),
            (16, js_key((0, -0.44, 1.71), 0, 0.43, -0.53, 1.79, 74, 54, -52, 14, 0.8), 'o'),
            (24, js_key((0, -0.47, 1.70), 0, 0.42, -0.54, 1.79, 78, 56, -54, 14, 0.85), 'l'),
            (36, js_key((0, -0.93, 1.70), -2, 0.40, -0.62, 1.78, 84, 60, -56, 14, 1.0), 'i'),
        ]
    P = keyed(f, JS_KEYS)
    if 10 <= f <= 26:   # trembling close-up
        P['jaw'] += 3 * math.sin(f * 4.1)
        P['fu_L'] = 8 * math.sin(f * 3.3)
        P['fu_R'] = 8 * math.sin(f * 2.9 + 1)
        P['hw'] = P['hw'] @ E(0, 2.0 * math.sin(f * 3.7), 1.5 * math.sin(f * 2.3))
    # place the pelvis so that the head centre lands on its target (legs and arms follow by IK)
    tgt = P.pop('head_target')
    for _ in range(2):
        M, _, _, _ = solve(build_spec(P))
        hc = wpos(M, 'head', HEAD_CENTER)
        P['px'] += tgt[0] - hc[0]
        P['py'] += tgt[1] - hc[1]
        P['pz'] += tgt[2] - hc[2]
    return P


CLIPS = [  # name, frames, loop, function
    ('idle_listen', 72, True, clip_idle_listen),
    ('walk', 26, True, clip_walk),
    ('stalk', 22, True, clip_stalk),
    ('lope', 17, True, clip_lope),
    ('run_search', 20, True, clip_run_search),
    ('notice', 12, False, clip_notice),
    ('screech', 18, False, clip_screech),
    ('attack_windup', 9, False, clip_attack_windup),
    ('attack_strike', 7, False, clip_attack_strike),
    ('attack_recover', 15, False, clip_attack_recover),
    ('stagger', 15, False, clip_stagger),
    ('death', 24, False, clip_death),
    ('jumpscare', 36, False, clip_jumpscare),
]


def bake_clip(fn, N):
    """Per-frame local quaternions for every bone (and the pelvis location), frames 0..N inclusive."""
    quats = {b: [] for b in NAMES}
    locs = []
    worlds = []
    for f in range(N + 1):
        P = fn(f, N)
        M, D, L, TL = solve(build_spec(P))
        worlds.append(M)
        for b in NAMES:
            q = Matrix(L[b].tolist()).to_quaternion()
            if quats[b] and np.dot(quats[b][-1], q) < 0:
                q.negate()
            quats[b].append(np.array(q))
        locs.append(TL['pelvis'])
    return quats, np.array(locs), worlds


def write_action(arm, name, N, quats, locs):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    slot = act.slots.new(id_type='OBJECT', name=arm.name)
    layer = act.layers.new('Layer')
    strip = layer.strips.new(type='KEYFRAME')
    cb = strip.channelbag(slot, ensure=True)
    frames = np.arange(N + 1, dtype=float)

    def curve(path, idx, vals, group):
        fc = cb.fcurves.new(path, index=idx)
        fc.group = group
        fc.keyframe_points.add(N + 1)
        fc.keyframe_points.foreach_set('co', np.stack([frames, vals], 1).ravel())
        fc.keyframe_points.foreach_set('interpolation', [1] * (N + 1))  # LINEAR
        fc.update()
    for b in NAMES:
        grp = cb.groups.new(b)
        q = np.array(quats[b])
        for i in range(4):
            curve(f'pose.bones["{b}"].rotation_quaternion', i, q[:, i], grp)
        if b == 'pelvis':
            for i in range(3):
                curve(f'pose.bones["{b}"].location', i, locs[:, i], grp)
    track = arm.animation_data.nla_tracks.new()
    track.name = name
    st = track.strips.new(name, 0, act)
    st.action_slot = slot
    track.mute = True
    return act, slot


# ---------------------------------------------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------------------------------------------
def build_armature():
    data = bpy.data.armatures.new('howler_rig')
    arm = bpy.data.objects.new('howler_rig', data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    for name, h, t, parent in BONES:
        eb = data.edit_bones.new(name)
        eb.head, eb.tail, eb.roll = h.tolist(), t.tolist(), 0.0
        if parent:
            eb.parent = data.edit_bones[parent]
            eb.use_connect = False
    bpy.ops.object.mode_set(mode='OBJECT')
    for b in data.bones:
        REST[b.name] = np.array(b.matrix_local)
        RROT[b.name] = REST[b.name][:3, :3].copy()
        RINV[b.name] = np.linalg.inv(REST[b.name])
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    arm.animation_data_create()
    return arm


def build_body_object(arm, mats):
    me = bpy.data.meshes.new('howler_body')
    verts = np.array(MB_.V)
    me.from_pydata(verts.tolist(), [], [list(f) for f in MB_.F])
    uv = me.uv_layers.new(name='UVMap')
    uv.data.foreach_set('uv', np.array([c for f in MB_.FUV for c in f], float).ravel())
    me.polygons.foreach_set('use_smooth', MB_.FS)
    me.polygons.foreach_set('material_index', MB_.FM)
    for m in mats:
        me.materials.append(m)
    me.validate(clean_customdata=False)
    me.update()
    obj = bpy.data.objects.new('howler_body', me)
    bpy.context.scene.collection.objects.link(obj)
    groups = {b: obj.vertex_groups.new(name=b) for b in NAMES}
    for i, w in enumerate(MB_.W):
        items = sorted(w.items(), key=lambda kv: -kv[1])[:4]
        tot = sum(v for _, v in items)
        for b, v in items:
            groups[b].add([i], v / tot, 'REPLACE')
    obj.parent = arm
    mod = obj.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm
    return obj


def skinned_min_z(M):
    """Lowest skinned vertex (linear blend) and the bone that carries it."""
    best = (1e9, None)
    for b, (idx, W) in _SKIN.items():
        X = (M[b] @ RINV[b])[:3]
        z = (np.c_[_VERTS[idx], np.ones(len(idx))] @ X.T)[:, 2]
        k = int(np.argmin(z))
        if z[k] < best[0]:
            best = (float(z[k]), b)
    return best


_SKIN, _VERTS = {}, None


def diag(arm_clips):
    global _VERTS
    _VERTS = np.array(MB_.V)
    for b in NAMES:   # dominant bone per vertex is enough to find floor penetration
        idx = [i for i, w in enumerate(MB_.W) if max(w, key=w.get) == b]
        if idx:
            _SKIN[b] = (np.array(idx), None)

    def head_c(M):
        return wpos(M, 'head', HEAD_CENTER)
    for name, N, worlds in arm_clips:
        lows = [skinned_min_z(M) for M in worlds]
        lo = min(lows)
        print(f'   {name}: lowest skinned vertex z {lo[0]:+.3f} ({lo[1]}, frame {lows.index(lo)})')
        hs = np.array([head_c(M) for M in worlds])
        shz = np.array([M['upperarm_L'][2, 3] for M in worlds])
        clawz = np.array([min(wpos(M, f'claw_{S}_02', TAIL0[f'claw_{S}_02'])[2] for S in 'LR') for M in worlds])
        toez = np.array([min(wpos(M, f'toe_{S}', TAIL0[f'toe_{S}'])[2] for S in 'LR') for M in worlds])
        print(f'DIAG {name:15s} head z {hs[:, 2].min():.2f}-{hs[:, 2].max():.2f} y {hs[:, 1].min():.2f}-'
              f'{hs[:, 1].max():.2f} | shoulder z {shz.min():.2f}-{shz.max():.2f} | claw tip z min {clawz.min():.3f}'
              f' | toe z min {toez.min():.3f}')
        if name in ('jumpscare', 'death', 'lope'):
            for f in range(0, N + 1, 3 if name != 'lope' else 2):
                M = worlds[f]
                hc = head_c(M)
                wl = M['hand_L'][:3, 3]
                ct = wpos(M, 'claw_L_02', TAIL0['claw_L_02'])
                pel = M['pelvis'][:3, 3]
                print(f'   f{f:2d} head ({hc[0]:+.2f},{hc[1]:+.2f},{hc[2]:.2f}) wristL ({wl[0]:+.2f},{wl[1]:+.2f},'
                      f'{wl[2]:.2f}) clawL ({ct[0]:+.2f},{ct[1]:+.2f},{ct[2]:.2f}) pelvis ({pel[0]:+.2f},'
                      f'{pel[1]:+.2f},{pel[2]:.2f})')


def main():
    common.reset_scene()
    scene = bpy.context.scene
    scene.frame_start, scene.frame_end = 0, 72
    arm = build_armature()
    build_mesh()
    print('TRIS', MB_.tris(), 'VERTS', len(MB_.V))
    baked = []
    for name, N, loop, fn in CLIPS:
        quats, locs, worlds = bake_clip(fn, N)
        baked.append((name, N, quats, locs, worlds))
    if DIAG:
        diag([(n, N, w) for n, N, _, _, w in baked])
        hc_rest = HEAD_CENTER
        print('REST head top', max(v[2] for v in MB_.V), 'head centre', hc_rest)
        return
    mats = build_materials()
    body = build_body_object(arm, mats)
    common.empty('HIT_head', HEAD_CENTER, parent=arm, parent_bone='head', size=0.22)
    common.empty('HIT_body', BODY_CENTER, parent=arm, parent_bone='spine_01', size=0.3)
    common.empty('SOCKET_mouth', (0.0, g_front_y(0.225) + 0.03, 2.165), parent=arm, parent_bone='head', size=0.05)
    # JS_CAM: identity rotation, so in three.js its -Z axis looks back at the creature (+Z faces) and +Y is up.
    common.empty('JS_CAM', JS_CAM_POS, parent=arm, size=0.1)
    actions = {}
    for name, N, quats, locs, worlds in baked:
        actions[name] = write_action(arm, name, N, quats, locs)
    arm.animation_data.action = None
    print('TRIS (evaluated)', common.triangle_count([body]))
    path = common.export_glb('ent_howler.glb')
    print('EXPORTED', path, path.stat().st_size)
    if PREVIEWS:
        render_previews(arm, actions)


def set_pose(arm, actions, name, frame):
    ad = arm.animation_data
    if name is None:
        ad.action = None
        for pb in arm.pose.bones:
            pb.rotation_quaternion = (1, 0, 0, 0)
            pb.location = (0, 0, 0)
    else:
        act, slot = actions[name]
        ad.action = act
        ad.action_slot = slot
    bpy.context.scene.frame_set(frame)


def render_previews(arm, actions):
    scene = bpy.context.scene
    me = bpy.data.meshes.new('preview_floor')
    me.from_pydata([(-4, -4, 0), (4, -4, 0), (4, 4, 0), (-4, 4, 0)], [], [(0, 1, 2, 3)])
    floor = bpy.data.objects.new('preview_floor', me)
    floor.data.materials.append(common.material('preview_floor', color=(0.43, 0.36, 0.2), roughness=0.9))
    scene.collection.objects.link(floor)
    shots = [
        ('ent_howler.png', None, 0, (2.2, -3.6, 1.7), (0, -0.05, 1.2), 50, (900, 900)),
        ('ent_howler_front.png', None, 0, (0.0, -4.2, 1.4), (0, 0, 1.2), 50, (900, 900)),
        ('ent_howler_side.png', 'idle_listen', 0, (4.2, -0.1, 1.3), (0, 0, 1.15), 50, (900, 900)),
        ('ent_howler_idle.png', 'idle_listen', 20, (2.0, -3.4, 1.6), (0, -0.1, 1.15), 50, (900, 900)),
        ('ent_howler_walk.png', 'walk', 4, (3.6, -1.6, 1.3), (0, -0.1, 1.1), 50, (900, 900)),
        ('ent_howler_lope.png', 'lope', 9, (3.8, -1.2, 1.2), (0, -0.25, 0.95), 50, (900, 900)),
        ('ent_howler_head.png', 'screech', 9, (0.55, -1.45, 2.1), (0, -0.35, 2.05), 50, (900, 900)),
        ('ent_howler_death.png', 'death', 24, (2.4, -2.6, 1.4), (0, -0.2, 0.3), 50, (900, 900)),
        ('ent_howler_jumpscare.png', 'jumpscare', 20, tuple(JS_CAM_POS), tuple(JS_CAM_POS + np.array([0, 1, 0])),
         14, (1280, 720)),
        ('ent_howler_jumpscare_f06.png', 'jumpscare', 6, tuple(JS_CAM_POS), tuple(JS_CAM_POS + np.array([0, 1, 0])),
         14, (1280, 720)),
    ]
    only = [a.split('=', 1)[1] for a in ARGS if a.startswith('--only=')]
    for fname, clip, frame, cam, tgt, lens, res in shots:
        if only and not any(o in fname for o in only):
            continue
        set_pose(arm, actions, clip, frame)
        common.render_preview(fname, cam, target=tgt, lens=lens, resolution=res)
    bpy.data.objects.remove(floor, do_unlink=True)
    set_pose(arm, actions, None, 0)


main()
