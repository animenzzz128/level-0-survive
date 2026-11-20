"""Build public/assets/models/ent_skin_stealer.glb (Blender 4.5, background mode).

    blender --background --factory-startup --python tools/blender/build_skin_stealer.py
    (add `-- stage=geo` to stop after the body sculpt and render a quick check)

The Skin-Stealer (art bible 4.3, 5.4; model contract "Entities"): a 2.27 m pale-yellow humanoid covered in tiny
sucker bumps, wearing stolen human skin that does not fit (a face worn low and rotated, a forearm sleeve, a chest
patch and a loose flap on the back, all held by rows of suckers with clear slime at the seams), half a torn grey
cardigan on the right shoulder and upper arm, a raised right shoulder hump, long arms and 0.18 m fingers.
Plus `disguise_bottle`, the Almond Water thermos it hides as.

Everything is generated here: the body is a union of lofted tubes and ellipsoids, voxel-remeshed and decimated;
the stolen skin, slime and cardigan are offset copies of body faces cut along analytic seam lines; textures are
rasterised in numpy from the rest-pose surface; skin weights come from bone-segment distances; every clip is
posed procedurally (with a two-bone IK for feet and hands) and baked to one Action per clip.
"""
import copy
import math
import pathlib
import sys
import tempfile

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import common  # noqa: E402

ARGS = dict(a.split('=', 1) for a in common.args_after_dashdash() if '=' in a)
STAGE = ARGS.get('stage', 'all')
OUT_NAME = 'ent_skin_stealer.glb'
TMP = pathlib.Path(tempfile.gettempdir()) / 'level0_blender_build'   # encoded textures; overwritten each run
TMP.mkdir(parents=True, exist_ok=True)

HEIGHT = 2.27
V = Vector


def srgb(hexstr):
    h = hexstr.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


C_SKIN = srgb('#d6c98e')       # the creature's own skin (close to the wallpaper)
C_SUCKER = srgb('#a8975c')     # sucker shadow
C_HUMAN = srgb('#c9a185')      # stolen human skin
C_DRY = srgb('#8a6a55')        # dried edges of the stolen skin
C_KNIT = srgb('#85857f')       # grey cardigan
C_STEEL_PAINT = srgb('#8b8f8a')
C_STEEL_BARE = srgb('#b9bcb8')

# ---------------------------------------------------------------------------------------------------------------
# Skeleton in the rest pose (armature space = world; metres; the creature faces -Y; its left is +X).
# The right side (-X) carries the raised shoulder.
# ---------------------------------------------------------------------------------------------------------------
SIDES = {'L': 1.0, 'R': -1.0}
HIP = {'L': V((0.105, 0.015, 0.975)), 'R': V((-0.105, 0.015, 0.975))}
KNEE = {s: V((0.11 * k, -0.02, 0.53)) for s, k in SIDES.items()}
ANKLE = {s: V((0.112 * k, 0.03, 0.078)) for s, k in SIDES.items()}
BALL = {s: V((0.122 * k, -0.135, 0.024)) for s, k in SIDES.items()}
TOE = {s: V((0.127 * k, -0.212, 0.018)) for s, k in SIDES.items()}
SHOULDER = {'L': V((0.29, 0.03, 1.785)), 'R': V((-0.29, 0.035, 1.815))}
ELBOW = {'L': V((0.375, 0.04, 1.296)), 'R': V((-0.373, 0.045, 1.324))}
WRIST = {'L': V((0.44, 0.0, 0.852)), 'R': V((-0.437, 0.005, 0.879))}
CLAV_IN = {'L': V((0.035, -0.035, 1.755)), 'R': V((-0.035, -0.035, 1.765))}
SPINE = [V((0, 0.01, 0.985)), V((0, 0.015, 1.08)), V((0, 0.03, 1.29)), V((0, 0.035, 1.50)), V((0, 0.02, 1.77)),
         V((0, -0.06, 1.975)), V((0, -0.09, 2.25))]   # pelvis, spine_01..03, neck, head heads; head tail
HEAD_C = V((0.0, -0.105, 2.10))
HEAD_R = V((0.104, 0.120, 0.168))
EYE_Z = 2.118
EYE_X = 0.041
EYE_R = 0.0145
EYE_CENTRES = {}

# The stolen face (mask) frame: a human face whose eye line would sit on the creature's eyes, worn 2 cm too low,
# 7 mm to the creature's left and rolled 7 degrees (its left side lower), so the eye holes miss.
MASK_ROLL = math.radians(7.0)
MASK_X0, MASK_Z0 = 0.007, EYE_Z - 0.020
MASK_MOUTH_UV = (0.0, -0.068)


def mask_uv_to_xz(u, v):
    ca, sa = math.cos(MASK_ROLL), math.sin(MASK_ROLL)
    return MASK_X0 + u * ca + v * sa, MASK_Z0 - u * sa + v * ca


MOUTH_X, MOUTH_Z = mask_uv_to_xz(*MASK_MOUTH_UV)


def hand_frame(side):
    """Wrist position, finger direction D, thumb-side direction Lh (forward) and palm normal Np (towards the body)."""
    k = SIDES[side]
    w = WRIST[side]
    d = (w - ELBOW[side]).normalized()
    d = (d + V((0.0, -0.05, -0.25))).normalized()
    lh = V((0, -1, 0))
    lh = (lh - d * lh.dot(d)).normalized()
    npal = d.cross(lh).normalized()
    if npal.x * k > 0:
        npal = -npal
    return w, d, lh, npal


FINGERS = {  # name: (lateral offset at the knuckle, segment lengths, splay deg, curl deg per joint, base radius)
    'index': (0.028, (0.068, 0.058, 0.054), 8.0, (14, 20, 16), 0.0105),
    'middle': (0.0, (0.072, 0.062, 0.056), 0.0, (16, 22, 16), 0.0110),
    'ring': (-0.028, (0.068, 0.057, 0.050), -9.0, (18, 24, 16), 0.0114),
}
PALM_LEN = 0.092


def finger_joints(side):
    """Joint positions per finger (knuckle .. tip) for one hand, in the rest pose."""
    w, d, lh, npal = hand_frame(side)
    out = {}
    knuckle_c = w + d * PALM_LEN
    for name, (off, segs, splay, curls, _r) in FINGERS.items():
        p = knuckle_c + lh * off - d * (abs(off) * 0.35)
        dirv = (Matrix.Rotation(math.radians(splay), 3, npal) @ d).normalized()
        pts = [p.copy()]
        for seg, curl in zip(segs, curls):
            dirv = curl_towards(dirv, npal, curl)
            p = p + dirv * seg
            pts.append(p.copy())
        out[name] = pts
    # thumb: from the base of the palm, forward and towards the palm
    tb = w + d * 0.028 + lh * 0.03 + npal * 0.008
    tdir = (d * 0.9 + lh * 0.28 + npal * 0.30).normalized()
    pts = [tb.copy()]
    for seg, curl in ((0.062, 16), (0.052, 20)):
        tdir = curl_towards(tdir, npal, curl)
        tb = tb + tdir * seg
        pts.append(tb.copy())
    out['thumb'] = pts
    return out


def curl_towards(a, b, deg):
    """Rotate direction a by deg towards direction b."""
    ax = a.cross(b)
    if ax.length < 1e-8:
        return a.copy()
    return (Matrix.Rotation(math.radians(deg), 3, ax.normalized()) @ a).normalized()


FJ = {s: finger_joints(s) for s in SIDES}

# ---------------------------------------------------------------------------------------------------------------
# Small numeric helpers (deterministic noise)
# ---------------------------------------------------------------------------------------------------------------


def smoothstep(e0, e1, x):
    t = np.clip((np.asarray(x, dtype=np.float64) - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def sstep(e0, e1, x):
    t = min(max((x - e0) / (e1 - e0), 0.0), 1.0)
    return t * t * (3.0 - 2.0 * t)


def hash3(ix, iy, iz, seed):
    """Integer lattice hash -> float in [0, 1). Works on numpy int arrays."""
    h = (ix.astype(np.int64) * 73856093) ^ (iy.astype(np.int64) * 19349663) ^ (iz.astype(np.int64) * 83492791)
    h = h ^ (seed * 2654435761)
    h = (h ^ (h >> 13)) * 1274126177
    h = h ^ (h >> 16)
    return (h & 0xFFFFFF).astype(np.float64) / float(0x1000000)


def vnoise(p, freq, seed=0):
    """Smooth value noise in [-1, 1] at points p (N, 3)."""
    q = np.asarray(p, dtype=np.float64) * freq
    i = np.floor(q).astype(np.int64)
    f = q - i
    u = f * f * (3 - 2 * f)
    out = 0.0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (u[:, 0] if dx else 1 - u[:, 0]) * (u[:, 1] if dy else 1 - u[:, 1]) * (u[:, 2] if dz else 1 - u[:, 2])
                out = out + w * hash3(i[:, 0] + dx, i[:, 1] + dy, i[:, 2] + dz, seed)
    return out * 2.0 - 1.0


def fbm(p, freq, octaves=3, seed=0):
    total, amp, norm = 0.0, 1.0, 0.0
    for o in range(octaves):
        total = total + amp * vnoise(p, freq * (2 ** o), seed + 17 * o)
        norm += amp
        amp *= 0.5
    return total / norm


def n1(p, freq, seed=0):
    """Scalar convenience wrapper of vnoise for one point."""
    return float(vnoise(np.array([p]), freq, seed)[0])


def ring_noise(theta, seed, amp):
    """Smooth periodic noise around a ring (for torn edges)."""
    rng = np.random.default_rng(seed)
    out = 0.0
    for k, a in ((2, 0.5), (3, 0.35), (5, 0.3), (7, 0.25), (11, 0.18), (17, 0.12), (23, 0.09)):
        out = out + a * np.sin(k * theta + rng.uniform(0, 2 * np.pi))
    return amp * out / 1.2


# ---------------------------------------------------------------------------------------------------------------
# Primitive builders: lofted tubes and ellipsoids, collected into one list and voxel-remeshed together.
# ---------------------------------------------------------------------------------------------------------------
class Sculpt:
    def __init__(self):
        self.verts, self.faces = [], []

    def add(self, verts, faces):
        o = len(self.verts)
        self.verts += [tuple(v) for v in verts]
        self.faces += [tuple(i + o for i in f) for f in faces]


def catmull(points, samples_per_seg):
    """Dense Catmull-Rom samples through the control points, with a parameter 0..1 by control index."""
    pts = [V(p) for p in points]
    ext = [pts[0] * 2 - pts[1]] + pts + [pts[-1] * 2 - pts[-2]]
    out, par = [], []
    nseg = len(pts) - 1
    for i in range(nseg):
        p0, p1, p2, p3 = ext[i], ext[i + 1], ext[i + 2], ext[i + 3]
        for j in range(samples_per_seg):
            t = j / samples_per_seg
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
                              + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
            par.append((i + t) / nseg)
    out.append(pts[-1].copy())
    par.append(1.0)
    return out, par


def interp(par, ctrl_t, ctrl_v):
    return float(np.interp(par, ctrl_t, ctrl_v))


def tube(sc, centres, ra, rb, axis_hint, n_ring=20, expo=2.0, disp=None, caps=(0.8, 0.8)):
    """Closed loft. centres: list of Vectors; ra/rb: radii along the hint axis A and along B = T x A.
    disp(p, outward, i, phi) -> extra outward offset in metres."""
    n = len(centres)
    tangents = []
    for i in range(n):
        a = centres[max(i - 1, 0)]
        b = centres[min(i + 1, n - 1)]
        tangents.append((b - a).normalized())
    # rounded ends: add rings that shrink like a squashed hemisphere
    rings = []
    for i in range(n):
        rings.append((centres[i], tangents[i], ra[i], rb[i], i))
    start, end = [], []
    for j in (3, 2, 1):
        th = j / 4 * math.pi / 2
        c0, t0 = centres[0], tangents[0]
        start.append((c0 - t0 * (0.5 * (ra[0] + rb[0]) * math.sin(th) * caps[0]), t0,
                      ra[0] * math.cos(th), rb[0] * math.cos(th), 0))
        c1, t1 = centres[-1], tangents[-1]
        end.append((c1 + t1 * (0.5 * (ra[-1] + rb[-1]) * math.sin(th) * caps[1]), t1,
                    ra[-1] * math.cos(th), rb[-1] * math.cos(th), n - 1))
    rings = start + rings + end[::-1]
    verts, faces = [], []
    hint = V(axis_hint) if not callable(axis_hint) else None
    for r, (c, t, a_r, b_r, idx) in enumerate(rings):
        h = axis_hint(idx) if callable(axis_hint) else hint
        A = (h - t * h.dot(t))
        if A.length < 1e-6:
            A = t.orthogonal()
        A.normalize()
        B = t.cross(A).normalized()
        for k in range(n_ring):
            phi = 2 * math.pi * k / n_ring
            cph, sph = math.cos(phi), math.sin(phi)
            ex = 2.0 / expo
            cx = math.copysign(abs(cph) ** ex, cph)
            sy = math.copysign(abs(sph) ** ex, sph)
            p = c + A * (a_r * cx) + B * (b_r * sy)
            outward = (A * (cx / max(a_r, 1e-4)) + B * (sy / max(b_r, 1e-4)))
            outward = outward.normalized() if outward.length > 1e-9 else A
            if disp is not None:
                p = p + outward * disp(p, outward, idx, phi)
            verts.append(p)
    nr = len(rings)
    for r in range(nr - 1):
        for k in range(n_ring):
            a = r * n_ring + k
            b = r * n_ring + (k + 1) % n_ring
            faces.append((a, b, b + n_ring, a + n_ring))
    # poles
    c0, t0 = rings[0][0], rings[0][1]
    c1, t1 = rings[-1][0], rings[-1][1]
    p0 = len(verts)
    verts.append(c0 - t0 * 0.15 * (ra[0] + rb[0]) * caps[0])
    p1 = len(verts)
    verts.append(c1 + t1 * 0.15 * (ra[-1] + rb[-1]) * caps[1])
    for k in range(n_ring):
        faces.append((p0, (k + 1) % n_ring, k))
        base = (nr - 1) * n_ring
        faces.append((p1, base + k, base + (k + 1) % n_ring))
    sc.add(verts, faces)


def ellipsoid(sc, centre, radii, n_lat=14, n_lon=20, rot=None, disp=None):
    """Closed ellipsoid; rot is a 3x3 Matrix; disp(p_local_unit, p_world) -> offset along the normal."""
    c = V(centre)
    rx, ry, rz = radii
    verts, faces = [], []
    rot = rot or Matrix.Identity(3)
    verts.append(c + rot @ V((0, 0, rz)))
    for i in range(1, n_lat):
        th = math.pi * i / n_lat
        for j in range(n_lon):
            ph = 2 * math.pi * j / n_lon
            u = V((math.sin(th) * math.cos(ph), math.sin(th) * math.sin(ph), math.cos(th)))
            loc = V((rx * u.x, ry * u.y, rz * u.z))
            nrm = V((u.x / rx, u.y / ry, u.z / rz)).normalized()
            p = c + rot @ loc
            if disp is not None:
                p = p + (rot @ nrm) * disp(u, p)
            verts.append(p)
    verts.append(c + rot @ V((0, 0, -rz)))
    last = len(verts) - 1
    for j in range(n_lon):
        faces.append((0, 1 + j, 1 + (j + 1) % n_lon))
    for i in range(n_lat - 2):
        for j in range(n_lon):
            a = 1 + i * n_lon + j
            b = 1 + i * n_lon + (j + 1) % n_lon
            faces.append((a, a + n_lon, b + n_lon, b))
    base = 1 + (n_lat - 2) * n_lon
    for j in range(n_lon):
        faces.append((last, base + (j + 1) % n_lon, base + j))
    sc.add(verts, faces)


def gauss2(dx, dy, sx, sy):
    return math.exp(-(dx * dx) / (2 * sx * sx) - (dy * dy) / (2 * sy * sy))


# ---------------------------------------------------------------------------------------------------------------
# Body parts
# ---------------------------------------------------------------------------------------------------------------
TORSO = [  # z, half-width, half-depth, centre y (+ = back)
    (0.875, 0.060, 0.045, 0.012), (0.925, 0.135, 0.090, 0.014), (0.99, 0.176, 0.110, 0.018), (1.06, 0.176, 0.106, 0.02),
    (1.14, 0.168, 0.100, 0.022), (1.22, 0.160, 0.094, 0.025), (1.31, 0.166, 0.100, 0.027), (1.41, 0.184, 0.112, 0.030),
    (1.51, 0.200, 0.122, 0.032), (1.60, 0.214, 0.128, 0.032), (1.68, 0.232, 0.126, 0.030), (1.75, 0.250, 0.118, 0.030),
    (1.80, 0.235, 0.104, 0.034), (1.845, 0.17, 0.085, 0.040), (1.875, 0.085, 0.06, 0.045),
]


def torso_disp(p, outward, idx, phi):
    x, y, z = p.x, p.y, p.z
    front = max(0.0, -outward.y)
    back = max(0.0, outward.y)
    ax = abs(x)
    d = 0.0
    # pectorals and clavicles
    d += 0.016 * front * gauss2(ax - 0.10, z - 1.64, 0.06, 0.045)
    d += 0.006 * front * gauss2(ax - 0.13, z - 1.765, 0.07, 0.008)
    # sternum groove, gaunt belly below the ribs, ribs on the sides and front
    d -= 0.007 * front * gauss2(x, z - 1.55, 0.012, 0.12)
    d -= 0.014 * front * gauss2(x, z - 1.25, 0.09, 0.05)
    if 1.30 < z < 1.56:
        rib = 0.5 + 0.5 * math.cos((z - 1.30) / 0.042 * 2 * math.pi + ax * 9.0)
        d += 0.0045 * rib * sstep(0.04, 0.10, ax) * (1 - back * 0.6) * sstep(1.30, 1.36, z) * (1 - sstep(1.50, 1.56, z))
    # abdominal blocks, faint
    if front > 0.5 and 1.08 < z < 1.40:
        d += 0.003 * front * (0.5 + 0.5 * math.cos((z - 1.08) / 0.07 * 2 * math.pi)) * gauss2(ax - 0.035, 0, 0.03, 1)
    # spine groove with vertebrae, shoulder blades, buttocks
    d -= 0.008 * back * gauss2(x, 0, 0.018, 1) * sstep(1.05, 1.15, z)
    if 1.10 < z < 1.84:
        d += 0.0045 * back * gauss2(x, 0, 0.010, 1) * (0.5 + 0.5 * math.cos((z - 1.10) / 0.034 * 2 * math.pi))
    d += 0.017 * back * gauss2(ax - 0.11, z - 1.64, 0.05, 0.07)
    d += 0.024 * back * gauss2(ax - 0.085, z - 0.99, 0.06, 0.06)
    # hip bones
    d += 0.003 * gauss2(ax - 0.160, z - 1.10, 0.03, 0.03)
    # lumpy flesh
    d += 0.003 * n1((x, y, z), 18.0, 3)
    return d


def build_torso(sc):
    zs = [r[0] for r in TORSO]
    cen = []
    ra, rb = [], []
    for z, a, b, cy in TORSO:
        cen.append(V((0.0, cy, z)))
    dense, par = catmull(cen, 4)
    t_ctrl = np.linspace(0, 1, len(TORSO))
    for pt, t in zip(dense, par):
        ra.append(interp(t, t_ctrl, [r[1] for r in TORSO]))
        rb.append(interp(t, t_ctrl, [r[2] for r in TORSO]))
    tube(sc, dense, ra, rb, (1, 0, 0), n_ring=40, expo=2.3, disp=torso_disp, caps=(0.6, 0.5))
    # trapezius slopes from the neck to each shoulder; the right one sits higher and heavier
    for s in SIDES:
        k = SIDES[s]
        a = V((0.02 * k, 0.05, 1.85))
        b = SHOULDER[s] + V((-0.03 * k, 0.0, 0.03))
        pts, par = catmull([a, (a + b) / 2 + V((0, 0.0, 0.015)), b], 4)
        r = [0.052 - 0.012 * t for t in par]
        tube(sc, pts, r, [x * 0.8 for x in r], (0, 1, 0), n_ring=14)
        # deltoid cap
        ellipsoid(sc, SHOULDER[s] + V((0.008 * k, -0.004, -0.03)), (0.056, 0.060, 0.088), 10, 14,
                  rot=Matrix.Rotation(math.radians(-8 * k), 3, 'Y'))
    # the raised flesh hump on the right shoulder (a lumpy mass, art bible 4.3)
    hump_c = V((-0.160, 0.050, 1.838))

    def hump_disp(u, p):
        return 0.012 * float(vnoise(np.array([tuple(p)]), 26.0, 7)[0]) + 0.006 * float(vnoise(np.array([tuple(p)]), 55.0, 9)[0])
    ellipsoid(sc, hump_c, (0.13, 0.108, 0.082), 16, 22, disp=hump_disp)
    ellipsoid(sc, hump_c + V((-0.075, 0.01, -0.035)), (0.07, 0.075, 0.075), 10, 14, disp=hump_disp)
    ellipsoid(sc, hump_c + V((0.035, 0.055, -0.07)), (0.075, 0.06, 0.08), 10, 14, disp=hump_disp)


def build_neck(sc):
    a = V((0.0, 0.035, 1.73))
    b = V((0.0, -0.075, 2.01))
    pts, par = catmull([a, V((0.0, 0.0, 1.86)), b], 6)
    r = [0.054 - 0.008 * t for t in par]

    def neck_disp(p, outward, idx, phi):
        # two tendons running from behind the ears to the sternum
        t = (p.z - 1.76) / 0.25
        tx = 0.042 - 0.03 * min(max(t, 0), 1)
        d = 0.0
        if outward.y < 0:
            d += 0.006 * gauss2(abs(p.x) - tx, 0, 0.007, 1) * (-outward.y)
        d += 0.002 * n1(tuple(p), 30.0, 5)
        return d
    tube(sc, pts, r, [x * 0.95 for x in r], (1, 0, 0), n_ring=18, disp=neck_disp)


def build_head(sc, features=True, target=None):
    """Head mesh. features=False gives the smooth face envelope the stolen face is draped on."""
    c, r = HEAD_C, HEAD_R
    n_lat, n_lon = 44, 56
    verts, faces = [], []
    for i in range(n_lat + 1):
        th = math.pi * i / n_lat
        for j in range(n_lon if 0 < i < n_lat else 1):
            ph = 2 * math.pi * j / n_lon
            u = V((math.sin(th) * math.cos(ph), math.sin(th) * math.sin(ph), math.cos(th)))
            # base shape in head-local coordinates
            x, y, z = r.x * u.x, r.y * u.y, r.z * u.z
            zt = z / r.z
            # jaw narrows below the cheekbones, chin forward a little; skull bulges back
            jaw = sstep(0.05, -0.75, zt)
            x *= 1.0 - 0.24 * jaw
            x *= 1.0 + 0.09 * sstep(-0.05, 0.5, zt) * (1.0 - 0.6 * sstep(0.7, 1.0, zt))
            if y > 0:
                y *= 1.0 + 0.06 * sstep(0.0, 0.6, zt)
            if y < 0:
                y *= 1.0 - 0.10 * jaw
            if y > 0:
                y *= 1.0 + 0.10 * sstep(-0.2, 0.5, zt)
            # flatter face plane
            if y < 0:
                y *= 1.0 - 0.10 * sstep(0.15, 0.95, -u.y) * sstep(-0.7, 0.2, zt)
            p = c + V((x, y, z))
            nrm = V((u.x / r.x, u.y / r.y, u.z / r.z)).normalized()
            d = 0.0
            front = max(0.0, -nrm.y)
            lx, lz = p.x, p.z
            for k in (-1, 1):
                ex = EYE_X * k
                if features:   # sunken eye sockets
                    d -= 0.020 * front * gauss2(lx - ex, lz - EYE_Z, 0.016, 0.012)
                d += 0.006 * front * gauss2(lx - ex, lz - (EYE_Z + 0.025), 0.022, 0.007)          # brow ridge
                d += 0.005 * front * gauss2(lx - 0.062 * k, lz - (EYE_Z - 0.032), 0.016, 0.012)   # cheekbone
                d += 0.004 * front * gauss2(lx - 0.035 * k, lz - (EYE_Z - 0.115), 0.012, 0.010)   # jaw corner
            if features:   # small nose
                d += 0.016 * front * gauss2(lx, lz - (EYE_Z - 0.045), 0.0085, 0.018)
                d += 0.006 * front * gauss2(lx, lz - (EYE_Z - 0.010), 0.006, 0.015)
            else:          # the envelope covers the nose with a broad bump
                d += 0.019 * front * gauss2(lx, lz - (EYE_Z - 0.040), 0.013, 0.026)
            if features:   # round mouth hole: a deep pit with a thin rim
                rr = math.hypot(lx - MOUTH_X, lz - MOUTH_Z)
                d -= 0.046 * front * math.exp(-(rr / 0.0125) ** 4)
                d += 0.003 * front * gauss2(rr - 0.017, 0, 0.004, 1)
            d += 0.006 * front * gauss2(lx, lz - (EYE_Z - 0.17), 0.02, 0.012)   # chin
            d += 0.002 * n1(tuple(p), 40.0, 11)
            verts.append(p + nrm * d)
    # faces
    def idx(i, j):
        if i == 0:
            return 0
        if i == n_lat:
            return 1 + (n_lat - 1) * n_lon
        return 1 + (i - 1) * n_lon + j % n_lon
    for j in range(n_lon):
        faces.append((idx(0, 0), idx(1, j), idx(1, j + 1)))
    for i in range(1, n_lat - 1):
        for j in range(n_lon):
            faces.append((idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)))
    for j in range(n_lon):
        faces.append((idx(n_lat, 0), idx(n_lat - 1, j + 1), idx(n_lat - 1, j)))
    (target if target is not None else sc).add(verts, faces)
    if features:
        # eyeballs set deep in the sockets (placed on the socket floor), ears
        tris = [f if len(f) == 3 else (f[0], f[1], f[2]) for f in faces] + [(f[0], f[2], f[3]) for f in faces if len(f) == 4]
        bvh = BVHTree.FromPolygons([tuple(v) for v in verts], tris)
        for k in (-1, 1):
            ex = EYE_X * k
            hit = bvh.ray_cast(V((ex, -1.0, EYE_Z)), V((0, 1, 0)))
            ey = (hit[0].y if hit[0] is not None else surface_y_estimate(ex, EYE_Z) + 0.02) + EYE_R * 0.45
            EYE_CENTRES[k] = V((ex, ey, EYE_Z))
            ellipsoid(sc, (ex, ey, EYE_Z), (EYE_R, EYE_R, EYE_R), 10, 14)
            ellipsoid(sc, (0.094 * k, HEAD_C.y + 0.01, 2.095), (0.014, 0.024, 0.034), 8, 12,
                      rot=Matrix.Rotation(math.radians(-14 * k), 3, 'Z'))


def surface_y_estimate(x, z):
    """Front surface of the plain head ellipsoid at (x, z) (no features)."""
    zt = (z - HEAD_C.z) / HEAD_R.z
    xt = x / HEAD_R.x
    s = max(1e-4, 1 - zt * zt - xt * xt)
    return HEAD_C.y - HEAD_R.y * math.sqrt(s) * 0.92


def build_leg(sc, s):
    k = SIDES[s]
    hip, knee, ank = HIP[s], KNEE[s], ANKLE[s]
    top = hip + V((-0.035 * k, 0.0, 0.085))
    pts, par = catmull([top, hip, (hip + knee) / 2 + V((0.006 * k, -0.01, 0)), knee,
                        (knee + ank) / 2 + V((0, 0.012, 0)), ank + V((0, 0, -0.03))], 5)
    t_ctrl = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]
    ra_c = [0.072, 0.079, 0.063, 0.050, 0.046, 0.034]
    rb_c = [0.074, 0.082, 0.065, 0.052, 0.050, 0.036]
    ra = [interp(t, t_ctrl, ra_c) for t in par]
    rb = [interp(t, t_ctrl, rb_c) for t in par]

    def leg_disp(p, outward, idx, phi):
        d = 0.0
        # knee cap, shin bone ridge, calf
        d += 0.010 * max(0, -outward.y) * gauss2(p.x - knee.x, p.z - (knee.z + 0.005), 0.025, 0.025)
        d += 0.004 * max(0, -outward.y) * gauss2(p.x - knee.x, 0, 0.012, 1) * sstep(0.45, 0.2, p.z)
        d += 0.012 * max(0, outward.y) * gauss2(0, p.z - 0.40, 1, 0.06)
        d += 0.006 * max(0, outward.x * k) * gauss2(0, p.z - 0.82, 1, 0.08)
        # ankle knobs
        d += 0.006 * abs(outward.x) * gauss2(0, p.z - ank.z, 1, 0.012)
        d += 0.0025 * n1(tuple(p), 22.0, 13)
        return d
    tube(sc, pts, ra, rb, (0, -1, 0), n_ring=22, disp=leg_disp)
    # foot: heel to toes, flat sole at z = 0
    heel = V((ank.x - 0.002 * k, ank.y + 0.05, 0.0))
    ball, toe = BALL[s], TOE[s]
    ctrl = [heel, V((ank.x, ank.y, 0.0)), V(((ank.x + ball.x) / 2, (ank.y + ball.y) / 2, 0.0)),
            V((ball.x, ball.y, 0.0)), V((toe.x, toe.y + 0.01, 0.0))]
    pts, par = catmull(ctrl, 5)
    t_ctrl = [0, 0.25, 0.5, 0.75, 1.0]
    hw = [interp(t, t_ctrl, [0.030, 0.036, 0.040, 0.047, 0.040]) for t in par]
    hh = [interp(t, t_ctrl, [0.034, 0.052, 0.040, 0.020, 0.012]) for t in par]
    cen = [V((p.x, p.y, h - 0.002)) for p, h in zip(pts, hh)]

    def foot_disp(p, outward, idx, phi):
        d = 0.0
        if p.y < ball.y + 0.01:   # toe bumps
            d += 0.005 * max(0, outward.z + 0.3) * (0.5 + 0.5 * math.cos((p.x - toe.x) / 0.019 * 2 * math.pi))
        d += 0.002 * n1(tuple(p), 30.0, 17)
        return d
    tube(sc, cen, hw, hh, (1, 0, 0), n_ring=18, expo=2.8, disp=foot_disp, caps=(0.7, 0.9))
    # five fused toes along the front of the foot
    for i, (dx, ln, r) in enumerate(((-0.030, 0.050, 0.012), (-0.012, 0.050, 0.0095), (0.004, 0.046, 0.009),
                                     (0.019, 0.040, 0.0085), (0.032, 0.034, 0.008))):
        base = V((ball.x + dx * k, ball.y + 0.006, 0.0))
        tip = V((ball.x + dx * k * 1.25, ball.y - ln - (0.01 if i == 0 else 0.0), 0.0))
        pts, par = catmull([base, (base + tip) / 2, tip], 3)
        rr = [r * (1 - 0.15 * t) for t in par]
        tube(sc, [V((p.x, p.y, rr[j] * 0.85)) for j, p in enumerate(pts)], rr, [x * 0.8 for x in rr], (1, 0, 0),
             n_ring=10, caps=(0.5, 0.9))


def build_arm(sc, s):
    k = SIDES[s]
    sh, el, wr = SHOULDER[s], ELBOW[s], WRIST[s]
    top = sh + V((-0.02 * k, 0.0, 0.035))
    pts, par = catmull([top, sh + V((0.008 * k, 0, -0.06)), (sh + el) / 2, el, (el + wr) / 2, wr + (wr - el).normalized() * 0.02], 6)
    t_ctrl = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]
    ra = [interp(t, t_ctrl, [0.050, 0.052, 0.043, 0.040, 0.044, 0.029]) for t in par]   # front-back
    rb = [interp(t, t_ctrl, [0.050, 0.050, 0.040, 0.039, 0.042, 0.021]) for t in par]   # side

    def arm_disp(p, outward, idx, phi):
        d = 0.0
        d += 0.009 * max(0, outward.y) * gauss2(0, (p - el).length, 1, 0.025)   # elbow point
        d += 0.006 * max(0, -outward.y) * gauss2(0, (p - (sh + el) / 2).length, 1, 0.07)   # biceps
        d += 0.005 * gauss2(0, (p - (el * 0.75 + wr * 0.25)).length, 1, 0.05)   # forearm muscle
        d += 0.004 * gauss2(0, (p - wr).length, 1, 0.012)   # wrist bones
        d += 0.0025 * n1(tuple(p), 24.0, 19)
        return d
    tube(sc, pts, ra, rb, (0, -1, 0), n_ring=18, disp=arm_disp)
    # hand: palm and fingers
    w, d, lh, npal = hand_frame(s)
    palm_pts = [w - d * 0.01, w + d * 0.03, w + d * 0.065, w + d * (PALM_LEN + 0.004)]
    pts, par = catmull(palm_pts, 4)
    ra = [interp(t, [0, 0.33, 0.66, 1], [0.024, 0.034, 0.040, 0.040]) for t in par]
    rb = [interp(t, [0, 0.33, 0.66, 1], [0.018, 0.018, 0.016, 0.013]) for t in par]
    tube(sc, pts, ra, rb, lh, n_ring=16, expo=2.4)
    for name, joints in FJ[s].items():
        r0 = FINGERS[name][4] if name in FINGERS else 0.0105
        pts, par = catmull(joints, 6)
        nj = len(joints) - 1
        rr = [r0 * (1.0 - 0.30 * t) for t in par]

        def finger_disp(p, outward, idx, phi, joints=joints, r0=r0):
            d = 0.0
            for jp in joints[1:-1]:
                d += 0.0018 * gauss2(0, (p - jp).length, 1, 0.006)
            # the 'one joint too many' look: an extra knuckle ring in the middle of the first phalanx
            mid = (joints[0] + joints[1]) / 2
            d += 0.0014 * gauss2(0, (p - mid).length, 1, 0.005)
            d += 0.0012 * gauss2(0, (p - joints[0]).length, 1, 0.009)
            return d
        tube(sc, pts, rr, [x * 0.92 for x in rr], npal, n_ring=10, disp=finger_disp, caps=(0.5, 0.9))


def build_body_sculpt():
    sc = Sculpt()
    build_torso(sc)
    build_neck(sc)
    build_head(sc, features=True)
    for s in SIDES:
        build_leg(sc, s)
        build_arm(sc, s)
    mesh = bpy.data.meshes.new('sculpt')
    mesh.from_pydata(sc.verts, [], sc.faces)
    mesh.validate()
    obj = bpy.data.objects.new('sculpt', mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def apply_modifier(obj, mod):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=mod.name)


def remesh_and_reduce(obj, voxel=0.0034, target_tris=9700):
    m = obj.modifiers.new('remesh', 'REMESH')
    m.mode = 'VOXEL'
    m.voxel_size = voxel
    m.adaptivity = 0.0
    apply_modifier(obj, m)
    m = obj.modifiers.new('smooth', 'SMOOTH')
    m.factor = 0.5
    m.iterations = 3
    apply_modifier(obj, m)
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    m = obj.modifiers.new('decimate', 'DECIMATE')
    m.decimate_type = 'COLLAPSE'
    m.ratio = target_tris / tris
    m.use_collapse_triangulate = True
    apply_modifier(obj, m)
    print('SCULPT remeshed tris', tris, '->', len(obj.data.polygons))


def fit_height(obj):
    """Snap the soles to z = 0 and the crown to HEIGHT with gentle local stretches."""
    co = np.zeros(len(obj.data.vertices) * 3)
    obj.data.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    zmin, zmax = co[:, 2].min(), co[:, 2].max()
    w_low = 1.0 - smoothstep(0.0, 0.12, co[:, 2])
    co[:, 2] -= zmin * w_low
    zmax = co[:, 2].max()
    w_high = smoothstep(1.95, HEIGHT, co[:, 2])
    co[:, 2] += (HEIGHT - zmax) * w_high
    obj.data.vertices.foreach_set('co', co.ravel())
    obj.data.update()
    print('SCULPT z range', zmin, zmax, '->', co[:, 2].min(), co[:, 2].max())


# ---------------------------------------------------------------------------------------------------------------
# Stolen-skin, cardigan and mask regions: analytic signed functions of the rest position (metres, > 0 inside).
# The same functions cut the mesh and paint the textures, so seams and painted edges line up.
# ---------------------------------------------------------------------------------------------------------------
def _axis(P, a, b, ref=(0.0, -1.0, 0.0)):
    a = np.array(tuple(a), float)
    b = np.array(tuple(b), float)
    d = b - a
    L = float(np.linalg.norm(d))
    dn = d / L
    rel = P - a
    t = rel @ dn
    rv = rel - np.outer(t, dn)
    radial = np.linalg.norm(rv, axis=1)
    r1 = np.array(ref, float)
    r1 = r1 - dn * (r1 @ dn)
    r1 /= np.linalg.norm(r1)
    r2 = np.cross(dn, r1)
    theta = np.arctan2(rv @ r2, rv @ r1)
    return t, radial, theta, L


def poly_sdf(x, z, poly):
    pts = np.array(poly, float)
    d = np.full(x.shape, 1e9)
    inside = np.zeros(x.shape, bool)
    n = len(pts)
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        e = b - a
        wx, wz = x - a[0], z - a[1]
        tt = np.clip((wx * e[0] + wz * e[1]) / (e @ e), 0, 1)
        d = np.minimum(d, np.hypot(wx - e[0] * tt, wz - e[1] * tt))
        cond = ((a[1] > z) != (b[1] > z)) & (x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1] + 1e-12) + a[0])
        inside ^= cond
    return np.where(inside, d, -d)


CHEST_POLY = [(-0.045, 1.705), (0.07, 1.692), (0.165, 1.668), (0.160, 1.53), (0.150, 1.408), (0.06, 1.42),
              (-0.022, 1.448), (-0.036, 1.58)]
BACK_POLY = [(0.035, 1.668), (0.165, 1.648), (0.152, 1.492), (0.045, 1.508)]


def s_sleeve(P):
    t, rad, th, L = _axis(P, ELBOW['R'], WRIST['R'])
    t0 = 0.078 + ring_noise(th, 101, 0.014)
    t1 = 0.372 + ring_noise(th, 102, 0.016)
    return np.minimum(np.minimum(t - t0, t1 - t), 0.085 - rad)


def s_chest(P):
    x, z = P[:, 0], P[:, 2]
    ang = np.arctan2(z - 1.555, x - 0.06)
    s = poly_sdf(x, z, CHEST_POLY) + ring_noise(ang, 103, 0.010)
    return np.minimum(s, -P[:, 1])


def s_back(P):
    x, z = P[:, 0], P[:, 2]
    ang = np.arctan2(z - 1.58, x - 0.10)
    s = poly_sdf(x, z, BACK_POLY) + ring_noise(ang, 104, 0.007)
    return np.minimum(s, P[:, 1] - 0.06)


def card_parts(P):
    t, rad, th, L = _axis(P, SHOULDER['R'], ELBOW['R'])
    hem = L - 0.075 + ring_noise(th, 105, 0.028)
    s_arm = np.minimum(np.minimum(hem - t, 0.11 - rad), t + 0.06)
    nz = vnoise(P, 14.0, 106)
    s_yoke = np.minimum(np.minimum(-0.115 - P[:, 0] + 0.015 * nz, P[:, 2] - 1.655 + 0.012 * nz), 1.93 - P[:, 2])
    bottom = 1.17 + 0.05 * vnoise(P * np.array([1.0, 1.0, 0.0]), 22.0, 107)
    s_panel = np.minimum.reduce([-0.098 - P[:, 0] + 0.008 * nz, P[:, 2] - bottom, 0.255 + P[:, 0], 0.01 - P[:, 1],
                                 1.70 - P[:, 2]])
    return s_arm, s_yoke, s_panel, t, rad, th


def s_card(P):
    a, b, c, *_ = card_parts(P)
    return np.maximum(np.maximum(a, b), c)


def s_skin(P):
    """Union of the stolen-skin patches on the body (sleeve, chest, back)."""
    return np.maximum(np.maximum(s_sleeve(P), s_chest(P)), s_back(P))


REGIONS = {'sleeve': s_sleeve, 'chest': s_chest, 'back': s_back, 'card': s_card}


# Mask (stolen face) in its own (u, v) frame: u to the creature's left, v up, origin between the eye holes.
MASK_EYES = [(-0.032, 0.0), (0.032, 0.0)]


def mask_uv_from_world(P):
    ca, sa = math.cos(MASK_ROLL), math.sin(MASK_ROLL)
    dx, dz = P[:, 0] - MASK_X0, P[:, 2] - MASK_Z0
    u = dx * ca - dz * sa
    v = dx * sa + dz * ca
    return u, v


def s_mask_uv(u, v):
    ang = np.arctan2(v + 0.02, u)
    # face oval from the hairline to under the chin, torn edge
    rx = 0.071 + 0.006 * np.cos(2 * ang)
    oval = 1.0 - np.sqrt((u / rx) ** 2 + ((v + 0.022) / np.where(v + 0.022 > 0, 0.098, 0.118)) ** 2)
    s = oval * 0.075 + ring_noise(ang, 111, 0.0065)
    for k, (eu, ev) in enumerate(MASK_EYES):
        ea = np.arctan2(v - ev, u - eu)
        hole = np.sqrt(((u - eu) / 0.0175) ** 2 + ((v - ev) / 0.0095) ** 2) - 1.0
        s = np.minimum(s, hole * 0.010 + ring_noise(ea, 112 + k, 0.0018))
    mu, mv = MASK_MOUTH_UV
    ma = np.arctan2(v - mv, u - mu)
    mouth = np.sqrt(((u - mu) / 0.0155) ** 2 + ((v - mv) / 0.0115) ** 2) - 1.0
    s = np.minimum(s, mouth * 0.012 + ring_noise(ma, 115, 0.0012))
    return s


def s_mask(P):
    u, v = mask_uv_from_world(P)
    return s_mask_uv(u, v)


# ---------------------------------------------------------------------------------------------------------------
# Mesh cutting
# ---------------------------------------------------------------------------------------------------------------
def bm_coords(bm):
    return np.array([tuple(v.co) for v in bm.verts], float)


def contour_cut(bm, fn, snap=0.0012):
    """Cut the mesh along fn = 0: split crossing edges and connect the new vertices inside each face."""
    bm.verts.ensure_lookup_table()
    sv = fn(bm_coords(bm))
    val = {}
    zero = set()
    for v, x in zip(bm.verts, sv):
        if abs(x) < snap:
            x = 0.0
            zero.add(v)
        val[v] = float(x)
    crossing = [e for e in bm.edges if val[e.verts[0]] * val[e.verts[1]] < 0]
    for e in crossing:
        a, b = e.verts
        sa, sb = val[a], val[b]
        t = sa / (sa - sb)
        _ne, nv = bmesh.utils.edge_split(e, a, t)
        val[nv] = 0.0
        zero.add(nv)
    faces = {f for v in zero for f in v.link_faces}
    for f in list(faces):
        zs = [v for v in f.verts if v in zero]
        if len(zs) == 2 and not any(zs[0] in e.verts and zs[1] in e.verts for e in f.edges):
            try:
                bmesh.utils.face_split(f, zs[0], zs[1])
            except ValueError:
                pass
    bm.verts.index_update()
    bm.faces.index_update()
    return zero


def faces_inside(bm, fn, tol=0.0012):
    """Faces on the positive side of a cut made by contour_cut (vertices within tol of the line count as on it)."""
    bm.verts.ensure_lookup_table()
    bm.verts.index_update()
    sv = fn(bm_coords(bm))
    out = []
    for f in bm.faces:
        vals = [sv[v.index] for v in f.verts]
        if max(vals) <= tol and min(vals) >= -tol:
            if fn(np.array([tuple(f.calc_center_median())]))[0] > 0:
                out.append(f)
        elif min(vals) >= -tol and max(vals) > tol:
            out.append(f)
    return out


# ---------------------------------------------------------------------------------------------------------------
# Rig
# ---------------------------------------------------------------------------------------------------------------
def bone_table():
    """name -> (head, tail, parent). Order: parents first."""
    T = {}
    T['root'] = (V((0, 0, 0)), V((0, 0, 0.2)), None)
    T['pelvis'] = (SPINE[0], SPINE[1], 'root')
    T['spine_01'] = (SPINE[1], SPINE[2], 'pelvis')
    T['spine_02'] = (SPINE[2], SPINE[3], 'spine_01')
    T['spine_03'] = (SPINE[3], SPINE[4], 'spine_02')
    T['neck'] = (SPINE[4], SPINE[5], 'spine_03')
    T['head'] = (SPINE[5], SPINE[6], 'neck')
    T['jaw'] = (V((0, -0.075, 2.005)), V((0, -0.19, 1.958)), 'head')
    mx0, mz0 = mask_uv_to_xz(0.0, -0.125)
    mx1, mz1 = mask_uv_to_xz(0.0, 0.08)
    T['mask'] = (V((mx0, -0.200, mz0)), V((mx1, -0.215, mz1)), 'head')
    T['chest_flap'] = (V((0.065, -0.115, 1.69)), V((0.065, -0.125, 1.43)), 'spine_03')
    T['back_flap'] = (V((0.10, 0.165, 1.655)), V((0.10, 0.18, 1.49)), 'spine_03')
    for s in SIDES:
        T['clavicle_' + s] = (CLAV_IN[s], SHOULDER[s], 'spine_03')
        T['upperarm_' + s] = (SHOULDER[s], ELBOW[s], 'clavicle_' + s)
        T['forearm_' + s] = (ELBOW[s], WRIST[s], 'upperarm_' + s)
        w, d, lh, npal = hand_frame(s)
        T['hand_' + s] = (w, w + d * PALM_LEN, 'forearm_' + s)
        fj = FJ[s]
        T['thumb_01_' + s] = (fj['thumb'][0], fj['thumb'][1], 'hand_' + s)
        T['thumb_02_' + s] = (fj['thumb'][1], fj['thumb'][2], 'thumb_01_' + s)
        for f in ('index', 'middle', 'ring'):
            for j in range(3):
                T['%s_%02d_%s' % (f, j + 1, s)] = (fj[f][j], fj[f][j + 1],
                                                    'hand_' + s if j == 0 else '%s_%02d_%s' % (f, j, s))
    for s in SIDES:
        T['thigh_' + s] = (HIP[s], KNEE[s], 'pelvis')
        T['shin_' + s] = (KNEE[s], ANKLE[s], 'thigh_' + s)
        T['foot_' + s] = (ANKLE[s], BALL[s], 'shin_' + s)
        T['toe_' + s] = (BALL[s], TOE[s], 'foot_' + s)
    return T


BONES = bone_table()


def build_armature():
    arm_data = bpy.data.armatures.new('skin_stealer_rig')
    arm = bpy.data.objects.new('skin_stealer_rig', arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm_data.edit_bones
    for name, (h, t, parent) in BONES.items():
        b = eb.new(name)
        b.head, b.tail = h, t
        d = (t - h).normalized()
        b.align_roll(V((0, 0, 1)) if abs(d.y) > 0.8 else V((0, -1, 0)))
        if parent:
            b.parent = eb[parent]
            b.use_connect = False
    bpy.ops.object.mode_set(mode='OBJECT')
    arm.data.display_type = 'STICK'
    return arm


# Weight segments: bone -> radius at head and tail (normalises the distance so thick and thin parts compete fairly)
SEG_R = {'pelvis': (0.17, 0.16), 'spine_01': (0.155, 0.15), 'spine_02': (0.16, 0.185), 'spine_03': (0.19, 0.20),
         'neck': (0.055, 0.05), 'head': (0.115, 0.11), 'jaw': (0.03, 0.025)}
for _s in SIDES:
    SEG_R.update({'clavicle_' + _s: (0.06, 0.07), 'upperarm_' + _s: (0.058, 0.044),
                  'forearm_' + _s: (0.045, 0.031), 'hand_' + _s: (0.032, 0.034),
                  'thigh_' + _s: (0.085, 0.052), 'shin_' + _s: (0.052, 0.036), 'foot_' + _s: (0.042, 0.035),
                  'toe_' + _s: (0.022, 0.016), 'thumb_01_' + _s: (0.012, 0.010), 'thumb_02_' + _s: (0.010, 0.008)})
    for _f in ('index', 'middle', 'ring'):
        for _j in range(3):
            SEG_R['%s_%02d_%s' % (_f, _j + 1, _s)] = (0.0115 - 0.001 * _j, 0.0105 - 0.001 * _j)
NO_BODY_WEIGHT = {'root', 'mask', 'chest_flap', 'back_flap'}


def compute_weights(P, edges=None):
    """Deterministic skin weights: distance to bone segments (scaled by local radius), smooth falloff, limited to
    the nearest bone's neighbourhood in the hierarchy, Laplacian-smoothed, 4 largest kept, normalised."""
    names = [n for n in BONES if n not in NO_BODY_WEIGHT]
    idx = {n: i for i, n in enumerate(names)}
    N, B = len(P), len(names)
    D = np.zeros((N, B))
    for j, n in enumerate(names):
        h, t, _p = BONES[n]
        h, t = np.array(tuple(h)), np.array(tuple(t))
        d = t - h
        tt = np.clip(((P - h) @ d) / (d @ d), 0, 1)
        dist = np.linalg.norm(P - (h + tt[:, None] * d), axis=1)
        r0, r1 = SEG_R[n]
        D[:, j] = dist / (r0 + (r1 - r0) * tt)
    nb = np.zeros((B, B), bool)
    for n in names:
        i = idx[n]
        nb[i, i] = True
        p = BONES[n][2]
        gp = BONES[p][2] if p else None
        for q in (p, gp):
            if q in idx:
                nb[i, idx[q]] = True
        for c, (_h, _t, cp) in BONES.items():
            if cp == n and c in idx:
                nb[i, idx[c]] = True
    best = np.argmin(D, axis=1)
    allowed = nb[best]
    dd = D - D[np.arange(N), best][:, None]
    W = np.where(allowed, np.clip(1.0 - dd / 0.55, 0, 1) ** 2, 0.0)
    if edges is not None and len(edges):
        for _ in range(2):
            acc = np.zeros_like(W)
            cnt = np.zeros(N)
            np.add.at(acc, edges[:, 0], W[edges[:, 1]])
            np.add.at(acc, edges[:, 1], W[edges[:, 0]])
            np.add.at(cnt, edges[:, 0], 1)
            np.add.at(cnt, edges[:, 1], 1)
            W = 0.5 * W + 0.5 * acc / np.maximum(cnt, 1)[:, None]
            W = np.where(allowed, W, 0.0)
    order = np.argsort(-W, axis=1)[:, :4]
    top = np.take_along_axis(W, order, axis=1)
    top = top / np.maximum(top.sum(axis=1, keepdims=True), 1e-9)
    return names, order, top


def write_weights(bm, obj, names, order, top):
    deform = bm.verts.layers.deform.verify()
    gi = {g.name: g.index for g in obj.vertex_groups}
    for k, v in enumerate(bm.verts):
        dv = v[deform]
        dv.clear()
        for j in range(4):
            w = float(top[k, j])
            if w > 1e-4:
                dv[gi[names[order[k, j]]]] = w


def blend_vertex_weights(v, deform, gi, bone, f):
    """Move fraction f of a vertex's weight onto bone, keep the 4 largest, normalise."""
    dv = v[deform]
    ws = {g: w * (1 - f) for g, w in dv.items()}
    ws[gi[bone]] = ws.get(gi[bone], 0.0) + f
    best = sorted(ws.items(), key=lambda kv: -kv[1])[:4]
    tot = sum(w for _g, w in best)
    dv.clear()
    for g, w in best:
        dv[g] = w / tot


# ---------------------------------------------------------------------------------------------------------------
# The stolen face (second mesh): a generic human face draped on the creature's face envelope, worn wrong.
# ---------------------------------------------------------------------------------------------------------------
def mask_relief(u, v):
    """Human features of the stolen face, as an outward offset in metres (a generic face, not anyone's)."""
    d = 0.0
    d += 0.013 * gauss2(u, v + 0.036, 0.0085, 0.012)            # nose tip
    d += 0.006 * gauss2(u, v + 0.012, 0.0055, 0.018)            # nose bridge
    d += 0.0035 * gauss2(abs(u) - 0.0125, v + 0.043, 0.005, 0.005)   # nostril wings
    d += 0.0035 * gauss2(abs(u) - 0.030, v - 0.020, 0.018, 0.0055)   # brows
    d += 0.0035 * gauss2(abs(u) - 0.046, v + 0.030, 0.017, 0.016)    # cheeks
    mu, mv = MASK_MOUTH_UV
    rr = math.hypot((u - mu) / 1.25, v - mv)
    d += 0.0045 * gauss2(rr - 0.0155, 0, 0.0045, 1)              # lips around the hole
    d += 0.0045 * gauss2(u, v + 0.113, 0.016, 0.011)            # chin
    for eu, ev in MASK_EYES:
        d -= 0.0018 * gauss2(u - eu, v - ev - 0.004, 0.015, 0.008)   # skin sagging into the creature's sockets
    d += 0.0003 * math.sin(v / 0.0068 * 2 * math.pi) * sstep(0.035, 0.06, v)  # forehead creases
    return d


def build_mask(envelope_bvh):
    step = 0.0071
    us = np.arange(-0.084, 0.0841, step)
    vs = np.arange(-0.148, 0.1021, step)
    verts, grid = [], {}
    for j, v in enumerate(vs):
        for i, u in enumerate(us):
            x, z = mask_uv_to_xz(float(u), float(v))
            hit, nrm, _i, _d = envelope_bvh.ray_cast(V((x, -1.0, z)), V((0, 1, 0)))
            if hit is None:
                continue
            n = nrm.normalized()
            if n.y > 0:
                n = -n
            grid[(i, j)] = len(verts)
            verts.append(hit + n * (0.0045 + mask_relief(float(u), float(v))))
    faces = []
    for (i, j), a in grid.items():
        k = [(i + 1, j), (i + 1, j + 1), (i, j + 1)]
        if all(q in grid for q in k):
            faces.append((a, grid[k[0]], grid[k[1]], grid[k[2]]))
    bm = bmesh.new()
    bv = [bm.verts.new(p) for p in verts]
    for f in faces:
        bm.faces.new([bv[i] for i in f])
    bm.normal_update()
    for f in bm.faces:   # outward = towards -Y
        if f.normal.y > 0:
            f.normal_flip()
    contour_cut(bm, s_mask, snap=0.0006)
    keep = set(faces_inside(bm, s_mask, tol=0.0006))
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f not in keep], context='FACES')
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context='VERTS')
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new('mask')
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new('mask', me)
    bpy.context.scene.collection.objects.link(obj)
    for p in me.polygons:
        p.use_smooth = True
    return obj


def envelope_bvh():
    sc = Sculpt()
    build_head(sc, features=False)
    tris = []
    for f in sc.faces:
        tris.append((f[0], f[1], f[2]))
        if len(f) == 4:
            tris.append((f[0], f[2], f[3]))
    return BVHTree.FromPolygons(sc.verts, tris)


# ---------------------------------------------------------------------------------------------------------------
# UV atlas (body + mask share one 2048 atlas; the face, head and hands get more texels)
# ---------------------------------------------------------------------------------------------------------------
HAND_C = {s: hand_frame(s)[0] + hand_frame(s)[1] * 0.1 for s in SIDES}


def uv_density(c, is_mask):
    if is_mask:
        return 3.2
    f = 1.0
    if c.z > 1.93:
        f = 2.6 if c.y < -0.06 else 2.0
    elif c.z > 1.76 and abs(c.x) < 0.12:
        f = 1.4
    for s in SIDES:
        if (c - HAND_C[s]).length < 0.17:
            f = max(f, 1.9)
    return f


def scale_islands(obj, is_mask):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    uvl = bm.loops.layers.uv.active
    bm.faces.ensure_lookup_table()
    parent = list(range(len(bm.faces)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for e in bm.edges:
        lf = e.link_faces
        if len(lf) != 2:
            continue
        f1, f2 = lf
        ok = True
        for v in e.verts:
            l1 = next(l for l in f1.loops if l.vert == v)
            l2 = next(l for l in f2.loops if l.vert == v)
            if (l1[uvl].uv - l2[uvl].uv).length > 1e-5:
                ok = False
                break
        if ok:
            parent[find(f1.index)] = find(f2.index)
    groups = {}
    for f in bm.faces:
        groups.setdefault(find(f.index), []).append(f)
    for fs in groups.values():
        wsum, fsum = 0.0, 0.0
        cen = V((0, 0))
        n = 0
        for f in fs:
            a = f.calc_area()
            wsum += a
            fsum += a * uv_density(f.calc_center_median(), is_mask)
            for l in f.loops:
                cen += l[uvl].uv
                n += 1
        k = fsum / max(wsum, 1e-12)
        cen /= max(n, 1)
        for f in fs:
            for l in f.loops:
                l[uvl].uv = cen + (l[uvl].uv - cen) * k
    bm.to_mesh(obj.data)
    bm.free()


def unwrap(objs):
    bpy.context.scene.tool_settings.use_uv_select_sync = True
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
        if not o.data.uv_layers:
            o.data.uv_layers.new(name='UVMap')
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.0, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    for o in objs:
        scale_islands(o, o.name == 'mask')
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(rotate=True, scale=True, margin=0.0025)
    bpy.ops.object.mode_set(mode='OBJECT')


# ---------------------------------------------------------------------------------------------------------------
# Layers on the body: stolen skin (offset copies of the patch faces), cardigan, slime over the seams
# ---------------------------------------------------------------------------------------------------------------
KIND_BODY, KIND_SKIN, KIND_SLIME, KIND_CARD = 0, 1, 2, 3


def skin_offset(P):
    s = s_skin(P)
    return 0.0034 + 0.0013 * vnoise(P, 55.0, 71) + 0.0022 * (1.0 - smoothstep(0.0, 0.008, s))


def card_offset(P):
    a, b, c, *_ = card_parts(P)
    s = np.maximum(np.maximum(a, b), c)
    off = np.where(a >= np.maximum(b, c), 0.012, np.where(b >= c, 0.010, 0.012 + 0.03 * smoothstep(1.55, 1.20, P[:, 2])))
    return off + 0.003 * vnoise(P, 25.0, 72) + 0.004 * (1.0 - smoothstep(0.0, 0.02, s))


def slime_offset(P):
    s = s_skin(P)
    return 0.0014 + skin_offset(P) * smoothstep(-0.002, 0.002, s)


def add_layer(bm, faces, offset_fn, mat_index, kind, kind_layer):
    bm.normal_update()
    ret = bmesh.ops.duplicate(bm, geom=faces)
    new_geom = set(ret['geom'])
    pairs = [(a, b) for a, b in ret['vert_map'].items() if b in new_geom and isinstance(b, bmesh.types.BMVert)]
    P = np.array([tuple(a.co) for a, _b in pairs])
    off = offset_fn(P) if len(P) else []
    for (a, b), o in zip(pairs, off):
        b.co = a.co + a.normal * float(o)
    new_faces = [g for g in ret['geom'] if isinstance(g, bmesh.types.BMFace)]
    for f in new_faces:
        f.material_index = mat_index
        f[kind_layer] = kind
    return new_faces, [b for _a, b in pairs]


# ---------------------------------------------------------------------------------------------------------------
# Texture painting: rasterise the rest-pose surface into the UV atlas, then evaluate colour and height in 3D.
# ---------------------------------------------------------------------------------------------------------------
def gather_tris(obj, label, kinds=None):
    me = obj.data
    me.calc_loop_triangles()
    nt = len(me.loop_triangles)
    loops = np.zeros(nt * 3, np.int64)
    me.loop_triangles.foreach_get('loops', loops)
    vidx = np.zeros(nt * 3, np.int64)
    me.loop_triangles.foreach_get('vertices', vidx)
    poly = np.zeros(nt, np.int64)
    me.loop_triangles.foreach_get('polygon_index', poly)
    uv = np.zeros(len(me.loops) * 2)
    me.uv_layers.active.data.foreach_get('uv', uv)
    uv = uv.reshape(-1, 2)
    co = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    nr = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get('normal', nr)
    nr = nr.reshape(-1, 3)
    keep = np.ones(nt, bool)
    if kinds is not None:
        keep = kinds[poly] == 0
    return (uv[loops].reshape(nt, 3, 2)[keep], co[vidx].reshape(nt, 3, 3)[keep], nr[vidx].reshape(nt, 3, 3)[keep],
            np.full(int(keep.sum()), label, np.int8))


def rasterize(UV, P3, N3, LAB, size):
    pos = np.zeros((size, size, 3), np.float32)
    nrm = np.zeros((size, size, 3), np.float32)
    lab = np.full((size, size), -1, np.int8)
    tsz = np.zeros((size, size), np.float32)
    for t in range(len(UV)):
        uv = UV[t] * size - 0.5
        x0, x1 = int(np.floor(uv[:, 0].min())), int(np.ceil(uv[:, 0].max()))
        y0, y1 = int(np.floor(uv[:, 1].min())), int(np.ceil(uv[:, 1].max()))
        x0, y0 = max(x0, 0), max(y0, 0)
        x1, y1 = min(x1, size - 1), min(y1, size - 1)
        if x1 < x0 or y1 < y0:
            continue
        a, b, c = uv
        v0, v1 = b - a, c - a
        den = v0[0] * v1[1] - v1[0] * v0[1]
        if abs(den) < 1e-12:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        px, py = gx - a[0], gy - a[1]
        l1 = (px * v1[1] - v1[0] * py) / den
        l2 = (v0[0] * py - px * v0[1]) / den
        l0 = 1.0 - l1 - l2
        ins = (l0 >= -1e-4) & (l1 >= -1e-4) & (l2 >= -1e-4)
        if not ins.any():
            continue
        yy, xx = gy[ins], gx[ins]
        w0, w1, w2 = l0[ins][:, None], l1[ins][:, None], l2[ins][:, None]
        Pt, Nt = P3[t], N3[t]
        pos[yy, xx] = w0 * Pt[0] + w1 * Pt[1] + w2 * Pt[2]
        nrm[yy, xx] = w0 * Nt[0] + w1 * Nt[1] + w2 * Nt[2]
        lab[yy, xx] = LAB[t]
        area3 = 0.5 * np.linalg.norm(np.cross(Pt[1] - Pt[0], Pt[2] - Pt[0]))
        tsz[yy, xx] = math.sqrt(area3 / (0.5 * abs(den)) + 1e-18)
    return pos, nrm, lab, tsz


def worley(P, cell, seed, keep=0.8, rmin=0.26, rmax=0.42):
    """Normalised distance to the nearest 'alive' feature point (in units of that point's radius)."""
    q = P / cell
    base = np.floor(q).astype(np.int64)
    best = np.full(len(P), 9.0)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                cx, cy, cz = base[:, 0] + dx, base[:, 1] + dy, base[:, 2] + dz
                fx = cx + 0.15 + 0.7 * hash3(cx, cy, cz, seed)
                fy = cy + 0.15 + 0.7 * hash3(cx, cy, cz, seed + 1)
                fz = cz + 0.15 + 0.7 * hash3(cx, cy, cz, seed + 2)
                r = rmin + (rmax - rmin) * hash3(cx, cy, cz, seed + 3)
                alive = hash3(cx, cy, cz, seed + 4) < keep
                d = np.sqrt((q[:, 0] - fx) ** 2 + (q[:, 1] - fy) ** 2 + (q[:, 2] - fz) ** 2) / r
                d = np.where(alive, d, 9.0)
                best = np.minimum(best, d)
    return best


def sucker_profile(rho):
    ring = np.exp(-((rho - 0.62) / 0.2) ** 2)
    cup = np.exp(-(rho / 0.32) ** 2)
    return ring, cup


def mix(a, b, t):
    t = np.clip(t, 0, 1)[:, None]
    return a * (1 - t) + np.asarray(b) * t


def nearest_dist(Q, pts, chunk=8000):
    out = np.full(len(Q), 9.0)
    idx = np.zeros(len(Q), np.int64)
    if len(pts) == 0:
        return out, idx
    for i in range(0, len(Q), chunk):
        d = np.linalg.norm(Q[i:i + chunk, None, :] - pts[None, :, :], axis=2)
        idx[i:i + chunk] = np.argmin(d, axis=1)
        out[i:i + chunk] = d[np.arange(len(d)), idx[i:i + chunk]]
    return out, idx


def seam_points(zero_positions, normals, fn, spacing, offset):
    """Points along a seam, pushed onto the creature's side by `offset` (rows of suckers holding the skin)."""
    pts = []
    taken = {}
    eps = 0.002
    for p, n in zip(zero_positions, normals):
        key = tuple(np.floor(p / spacing).astype(int))
        if key in taken:
            continue
        g = np.zeros(3)
        for i in range(3):
            e = np.zeros(3)
            e[i] = eps
            g[i] = (fn((p + e)[None])[0] - fn((p - e)[None])[0]) / (2 * eps)
        g = g - n * (g @ n)
        if np.linalg.norm(g) < 1e-6:
            continue
        g /= np.linalg.norm(g)
        taken[key] = True
        pts.append(p - g * offset)
    return np.array(pts) if pts else np.zeros((0, 3))


def dilate(img, valid, iters):
    img = img.copy()
    valid = valid.copy()
    for _ in range(iters):
        acc = np.zeros_like(img)
        cnt = np.zeros(valid.shape, np.float32)
        for sy, sx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            v = np.roll(valid, (sy, sx), axis=(0, 1))
            acc += np.roll(img, (sy, sx), axis=(0, 1)) * v[..., None]
            cnt += v
        fill = (~valid) & (cnt > 0)
        img[fill] = acc[fill] / cnt[fill][:, None]
        valid = valid | fill
    return img


def encode_image(name, arr, fmt='JPEG', quality=90, non_color=False):
    """Encode a bottom-origin float array (H, W, 3|4) to JPEG/PNG and pack it (the exporter keeps the bytes)."""
    h, w, c = arr.shape
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., :c] = arr
    img = bpy.data.images.new(name + '_tmp', width=w, height=h, alpha=(fmt == 'PNG'))
    img.pixels.foreach_set(np.clip(rgba, 0, 1).ravel())
    ext = 'jpg' if fmt == 'JPEG' else 'png'
    path = TMP / ('ent_skin_stealer_%s.%s' % (name, ext))
    img.file_format = fmt
    img.filepath_raw = str(path)
    img.save(filepath=str(path), quality=quality)
    bpy.data.images.remove(img)
    out = bpy.data.images.load(str(path))
    out.name = name
    out.pack()
    if non_color:
        out.colorspace_settings.name = 'Non-Color'
    return out


def paint_textures(body, mask, kinds, seams, size=2048):
    parts = [gather_tris(body, 0, kinds), gather_tris(mask, 1)]
    UV = np.concatenate([p[0] for p in parts])
    P3 = np.concatenate([p[1] for p in parts])
    N3 = np.concatenate([p[2] for p in parts])
    LAB = np.concatenate([p[3] for p in parts])
    pos, nrm, lab, tsz = rasterize(UV, P3, N3, LAB, size)
    valid = lab >= 0
    P = pos[valid].astype(np.float64)
    Nn = nrm[valid].astype(np.float64)
    Nn /= np.maximum(np.linalg.norm(Nn, axis=1, keepdims=True), 1e-9)
    L = lab[valid]
    M = len(P)
    print('PAINT texels', M, 'of', size * size)
    col = np.zeros((M, 3))
    hgt = np.zeros(M)
    s_sl, s_ch, s_bk, s_cd = s_sleeve(P), s_chest(P), s_back(P), s_card(P)
    s_sk = np.maximum(np.maximum(s_sl, s_ch), s_bk)
    is_mask = L == 1
    human = is_mask | ((L == 0) & (s_sk > 0))
    card = (L == 0) & (~human) & (s_cd > 0)
    pale = (L == 0) & ~(human | card)

    # --- the creature's own skin: pale yellow, mottled, covered in suckers of two sizes -------------------------
    Pp, Np = P[pale], Nn[pale]
    c = np.tile(np.array(C_SKIN), (len(Pp), 1)) * (1 + 0.07 * fbm(Pp, 7.0, 3, 21))[:, None]
    c = mix(c, (0.80, 0.75, 0.50), 0.3 * smoothstep(0.1, 0.6, fbm(Pp, 3.0, 2, 22)))
    head_w = smoothstep(1.92, 1.98, Pp[:, 2])
    hand_w = np.zeros(len(Pp))
    for s in SIDES:
        hand_w = np.maximum(hand_w, 1 - smoothstep(0.10, 0.17, np.linalg.norm(Pp - np.array(tuple(HAND_C[s])), axis=1)))
    w_large = np.clip(0.62 + 0.6 * fbm(Pp, 2.5, 2, 23) + 0.35 * np.clip(Np[:, 1], 0, 1) - 0.9 * np.maximum(head_w, hand_w),
                      0, 1)
    dens = smoothstep(-0.35, 0.15, fbm(Pp, 5.0, 2, 24) + 0.25) * (1 - 0.45 * head_w * smoothstep(0.3, 0.9, -Np[:, 1]))
    rs, cs = sucker_profile(worley(Pp, 0.0085, 31, keep=0.75))
    rho_l = worley(Pp, 0.0185, 41, keep=0.72)
    rl, cl = sucker_profile(worley(Pp, 0.0185, 41, keep=0.72))
    ring = ((1 - w_large) * rs + w_large * rl) * dens
    cup = ((1 - w_large) * cs + w_large * cl) * dens
    amp = (1 - w_large) * 0.0005 + w_large * 0.0011
    h = amp * (ring - 0.8 * cup) + 0.0006 * fbm(Pp, 30.0, 2, 25)
    c = c * (1 + 0.11 * ring)[:, None]
    c = mix(c, C_SUCKER, 0.8 * cup)
    c = mix(c, (0.74, 0.66, 0.42), 0.25 * smoothstep(0.9, 1.1, (1 - w_large) * 0 + 1.0) * np.exp(-((rho_l - 1.0) / 0.15) ** 2) * w_large * dens)
    # ribs, sternum and collarbones as surface relief (they are mostly lost in the decimated mesh)
    ax = np.abs(Pp[:, 0])
    torso = (ax < 0.21) & (Pp[:, 2] > 1.28) & (Pp[:, 2] < 1.80)
    front = np.clip(-Np[:, 1], 0, 1)
    rib = (0.5 + 0.5 * np.cos((Pp[:, 2] - 1.30) / 0.042 * 2 * np.pi + ax * 9.0)) * smoothstep(0.03, 0.09, ax)         * smoothstep(1.30, 1.36, Pp[:, 2]) * (1 - smoothstep(1.50, 1.58, Pp[:, 2]))
    clav = np.exp(-((Pp[:, 2] - 1.765 + 0.08 * (ax - 0.12) ** 2) / 0.008) ** 2) * smoothstep(0.03, 0.06, ax) * (1 - smoothstep(0.2, 0.25, ax))
    h = h + torso * (0.0016 * rib * (0.4 + 0.6 * front) + 0.0014 * clav * front)
    c = mix(c, (0.70, 0.62, 0.40), torso * 0.18 * (1 - rib) * smoothstep(0.03, 0.09, ax) * smoothstep(1.30, 1.36, Pp[:, 2]) * (1 - smoothstep(1.50, 1.58, Pp[:, 2])))
    # rows of bigger suckers along the stolen-skin seams, and a stained band where the skin is gripped
    near = s_sk[pale] > -0.035
    if near.any() and len(seams):
        d, j = nearest_dist(Pp[near], seams[:, :3])
        rho = d / seams[j, 3]
        r2, c2 = sucker_profile(rho)
        hh = 0.0012 * (r2 - 0.9 * c2) * (rho < 1.4)
        h[near] = h[near] * (1 - np.clip(1.4 - rho, 0, 1)) + hh
        cn = c[near]
        cn = mix(cn, (0.70, 0.60, 0.40), 0.45 * np.exp(s_sk[pale][near] / 0.007))
        cn = cn * (1 + 0.06 * r2)[:, None]
        cn = mix(cn, (0.40, 0.31, 0.21), 0.75 * c2)
        c[near] = cn
    # sunken white eyes
    for k, ec in EYE_CENTRES.items():
        de = np.linalg.norm(Pp - np.array(tuple(ec)), axis=1)
        eye = de < EYE_R + 0.0015
        if eye.any():
            front = np.clip(-(Pp[eye, 1] - ec.y) / EYE_R, 0, 1)
            ce = np.tile(np.array([0.90, 0.89, 0.83]), (int(eye.sum()), 1))
            lat = np.hypot(Pp[eye, 0] - ec.x, Pp[eye, 2] - ec.z)
            ce = mix(ce, (0.74, 0.75, 0.73), 0.5 * np.exp(-((lat - 0.0045) / 0.0012) ** 2) * front)
            c[eye] = ce
            h[eye] = 0.0
        sock = (~eye) & (np.hypot(Pp[:, 0] - ec.x, Pp[:, 2] - ec.z) < 0.03) & (Pp[:, 1] < -0.12)
        c[sock] = mix(c[sock], (0.70, 0.62, 0.40), 0.5 * (1 - smoothstep(0.012, 0.03, np.hypot(Pp[sock, 0] - ec.x,
                                                                                            Pp[sock, 2] - ec.z))))
    # the dark round mouth hole
    rr = np.hypot(Pp[:, 0] - MOUTH_X, Pp[:, 2] - MOUTH_Z)
    mz = (rr < 0.024) & (Pp[:, 1] < -0.12) & (Pp[:, 2] > 1.94)
    dark = 1 - smoothstep(0.0095, 0.0175, rr[mz])
    c[mz] = mix(mix(c[mz], (0.30, 0.17, 0.13), 0.6 * (1 - smoothstep(0.012, 0.022, rr[mz]))), (0.035, 0.022, 0.016),
                dark)
    h[mz] *= 1 - dark
    # pale nails on the fingertips
    for s in SIDES:
        for f, js in FJ[s].items():
            tip, prev = np.array(tuple(js[-1])), np.array(tuple(js[-2]))
            dn = np.linalg.norm(Pp - (tip * 0.75 + prev * 0.25), axis=1)
            nm = dn < 0.013
            c[nm] = mix(c[nm], (0.86, 0.82, 0.66), 0.7 * (1 - smoothstep(0.008, 0.013, dn[nm])))
    col[pale], hgt[pale] = c, h

    # --- stolen human skin: patches on the body and the face mask ----------------------------------------------
    Ph = P[human]
    mk = is_mask[human]
    sh = np.where(mk, s_mask(Ph), s_sk[human])
    c = np.tile(np.array(C_HUMAN), (len(Ph), 1)) * (1 + 0.06 * fbm(Ph, 25.0, 3, 51))[:, None]
    c = mix(c, (0.72, 0.50, 0.42), 0.35 * smoothstep(0.15, 0.6, fbm(Ph, 10.0, 2, 54)))
    c = mix(c, (0.66, 0.60, 0.52), 0.25 * smoothstep(0.2, 0.7, fbm(Ph, 18.0, 2, 55)))   # grey-green bruising
    h = 0.00007 * vnoise(Ph, 700.0, 53)
    if mk.any():
        u, v = mask_uv_from_world(Ph[mk])
        cm = c[mk]
        mu, mv = MASK_MOUTH_UV
        lip = np.exp(-((np.hypot((u - mu) / 1.25, v - mv) - 0.0165) / 0.0055) ** 2)
        cm = mix(cm, (0.60, 0.37, 0.34), 0.55 * lip)
        for eu, ev in MASK_EYES:
            e = np.sqrt(((u - eu) / 0.0175) ** 2 + ((v - ev) / 0.0095) ** 2)
            cm = mix(cm, (0.55, 0.36, 0.31), 0.45 * np.exp(-((e - 1.25) / 0.35) ** 2))
            cm = mix(cm, (0.50, 0.37, 0.38), 0.30 * np.exp(-(u - eu) ** 2 / (2 * 0.016 ** 2) - (v - ev + 0.017) ** 2 / (2 * 0.007 ** 2)))
            arch = ev + 0.021 + 0.004 * np.cos((u - eu) / 0.028 * np.pi / 2)
            brow = np.exp(-((v - arch) / 0.0033) ** 2) * smoothstep(0.004, 0.012, np.abs(u - eu + np.sign(eu) * 0.01) * 0 + np.abs(u) ) \
                * (1 - smoothstep(0.050, 0.058, np.abs(u)))
            hair = smoothstep(-0.2, 0.6, vnoise(np.stack([u * 260 + v * 140, v * 60, u * 0], 1), 1.0, 56))
            cm = mix(cm, (0.30, 0.22, 0.16), 0.55 * brow * (0.5 + 0.5 * hair))
        nos = np.exp(-(np.abs(u) - 0.0075) ** 2 / (2 * 0.0035 ** 2) - (v + 0.047) ** 2 / (2 * 0.0022 ** 2))
        cm = mix(cm, (0.22, 0.13, 0.11), 0.8 * nos)
        cm = mix(cm, (0.76, 0.50, 0.44), 0.25 * np.exp(-(np.abs(u) - 0.045) ** 2 / (2 * 0.02 ** 2) - (v + 0.03) ** 2 / (2 * 0.018 ** 2)))
        cm = mix(cm, (0.56, 0.48, 0.44), 0.15 * np.exp(-u ** 2 / (2 * 0.03 ** 2) - (v + 0.095) ** 2 / (2 * 0.03 ** 2)))
        c[mk] = cm
        h[mk] = h[mk] + 0.00009 * np.sin(v / 0.0065 * 2 * np.pi + 2 * vnoise(Ph[mk], 60.0, 57)) * smoothstep(0.03, 0.05, v)
    dry = 1 - smoothstep(0.0, 0.010 + 0.006 * vnoise(Ph, 80.0, 52), sh)
    c = mix(c, C_DRY, 0.85 * dry)
    c = mix(c, (0.33, 0.24, 0.18), 0.6 * (1 - smoothstep(0.0, 0.0025, sh)))
    h = h + 0.00028 * np.sin(sh / 0.0016) * dry
    col[human], hgt[human] = c, h

    # --- the grey cardigan (knit, grimy, torn hem) ------------------------------------------------------------
    Pc = P[card]
    a, b, cc, t, rad, th = card_parts(Pc)
    armp = a >= np.maximum(b, cc)
    ua = np.where(armp, th * 0.055, Pc[:, 0])
    va = np.where(armp, -t, Pc[:, 2])
    cu, cv = ua / 0.0056, va / 0.0044
    fu = cu - np.floor(cu) - 0.5
    knit = (0.5 + 0.5 * np.cos(2 * np.pi * (cv + 0.9 * np.abs(fu)))) * np.clip(1 - 3.2 * fu * fu, 0, 1)
    scd = s_cd[card]
    hem = 1 - smoothstep(0.0, 0.012, scd)
    c = np.tile(np.array(C_KNIT), (len(Pc), 1)) * (0.80 + 0.26 * knit)[:, None]
    c = mix(c, (0.40, 0.38, 0.34), 0.35 * smoothstep(0.1, 0.7, fbm(Pc, 8.0, 3, 81)) + 0.35 * hem)
    c = mix(c, (0.46, 0.42, 0.33), 0.25 * smoothstep(0.3, 0.8, fbm(Pc, 4.0, 2, 82)))
    col[card] = c
    hgt[card] = 0.0007 * knit + 0.0005 * fbm(Pc, 60.0, 2, 83) - 0.0006 * hem

    # --- slime over the seams (alpha only; its own texture) ----------------------------------------------------
    slime_a = np.zeros(M)
    sb = (L == 0) & (np.abs(s_sk) < 0.03)
    Ps, ss = P[sb], s_sk[sb]
    a_ = 0.85 * np.exp(-(ss / 0.0042) ** 2) * (0.65 + 0.35 * vnoise(Ps, 160.0, 61))
    drop = (worley(Ps, 0.0055, 62, keep=0.5) < 0.9) * np.exp(-((ss + 0.004) / 0.007) ** 2)
    streak = smoothstep(0.45, 0.8, vnoise(Ps * np.array([1.0, 1.0, 0.12]), 220.0, 63)) * np.exp(np.minimum(ss, 0) / 0.012) * (ss < 0.002)
    slime_a[sb] = np.clip(a_ + 0.7 * drop + 0.6 * streak * smoothstep(0.0, 0.006, -ss + 0.003), 0, 1)

    # --- assemble maps -------------------------------------------------------------------------------------------
    base = np.zeros((size, size, 3), np.float32)
    base[valid] = np.clip(col, 0, 1)
    base = dilate(base, valid, 8)
    H = np.zeros((size, size), np.float64)
    H[valid] = hgt
    T = tsz.astype(np.float64)
    gx = np.zeros_like(H)
    gy = np.zeros_like(H)
    for axis, g in ((1, gx), (0, gy)):
        fwd = np.roll(H, -1, axis=axis)
        bwd = np.roll(H, 1, axis=axis)
        vf = np.roll(valid, -1, axis=axis) & (np.linalg.norm(np.roll(pos, -1, axis=axis) - pos, axis=2) < 4 * T + 1e-4)
        vb = np.roll(valid, 1, axis=axis) & (np.linalg.norm(np.roll(pos, 1, axis=axis) - pos, axis=2) < 4 * T + 1e-4)
        num = np.where(vf, fwd, H) - np.where(vb, bwd, H)
        den = (vf.astype(float) + vb.astype(float)) * np.maximum(T, 1e-6)
        g[:] = np.where(valid & (den > 0), num / np.maximum(den, 1e-9), 0.0)
    n = np.stack([-gx, -gy, np.ones_like(gx)], axis=2)
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    # downsample to 1024: average the valid texels of each 2x2 block
    v4 = valid.reshape(size // 2, 2, size // 2, 2)
    n4 = (n * valid[..., None]).reshape(size // 2, 2, size // 2, 2, 3).sum(axis=(1, 3))
    vcount = v4.sum(axis=(1, 3))
    vsmall = vcount > 0
    n4 /= np.maximum(np.linalg.norm(n4, axis=2, keepdims=True), 1e-9)
    n4[~vsmall] = (0, 0, 1)
    n4 = dilate(n4, vsmall, 6)
    n4 /= np.maximum(np.linalg.norm(n4, axis=2, keepdims=True), 1e-9)
    normal = (n4 * 0.5 + 0.5).astype(np.float32)
    S = np.zeros((size, size), np.float64)
    S[valid] = slime_a
    s4 = (S * valid).reshape(size // 2, 2, size // 2, 2).sum(axis=(1, 3)) / np.maximum(vcount, 1)
    slime = np.zeros((size // 2, size // 2, 4), np.float32)
    slime[..., :3] = (0.93, 0.94, 0.87)
    slime[..., 3] = s4
    slime[..., 3] = dilate(slime[..., 3:4], vsmall, 4)[..., 0]
    return {
        'base': encode_image('ss_skin_basecolor', base, 'JPEG', 88),
        'normal': encode_image('ss_skin_normal', normal, 'JPEG', 92, non_color=True),
        'slime': encode_image('ss_slime', slime, 'PNG', 100),
    }


def build_materials(tex):
    m_skin = common.material('ss_skin', color=(1, 1, 1), roughness=0.6, base_image=tex['base'],
                             normal_image=tex['normal'], normal_strength=1.0)
    m_skin.use_backface_culling = True
    m_human = common.material('ss_human_skin', color=(1, 1, 1), roughness=0.5, base_image=tex['base'],
                              normal_image=tex['normal'], normal_strength=1.0)
    m_human.use_backface_culling = False
    m_slime = common.material('ss_slime', color=(1, 1, 1), roughness=0.08, base_image=tex['slime'])
    nodes, links = m_slime.node_tree.nodes, m_slime.node_tree.links
    texn = next(n for n in nodes if n.type == 'TEX_IMAGE')
    links.new(texn.outputs['Alpha'], nodes['Principled BSDF'].inputs['Alpha'])
    m_slime.blend_method = 'BLEND'
    m_slime.surface_render_method = 'BLENDED'
    m_slime.use_backface_culling = True
    return m_skin, m_human, m_slime


# ---------------------------------------------------------------------------------------------------------------
# Shape keys
# ---------------------------------------------------------------------------------------------------------------
def add_body_shape_keys(obj, kinds):
    obj.shape_key_add(name='Basis', from_mix=False)
    key = obj.shape_key_add(name='mouth_hole_open', from_mix=False)
    n = len(obj.data.vertices)
    co = np.zeros(n * 3)
    obj.data.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    x, y, z = co[:, 0], co[:, 1], co[:, 2]
    rr = np.hypot(x - MOUTH_X, z - MOUTH_Z)
    sel = (y < -0.12) & (z > 1.93) & (np.abs(x) < 0.09) & (rr < 0.05)
    out = co.copy()
    rx = np.where(rr > 1e-6, (x - MOUTH_X) / np.maximum(rr, 1e-6), 0)
    rz = np.where(rr > 1e-6, (z - MOUTH_Z) / np.maximum(rr, 1e-6), 0)
    amt = 0.012 * smoothstep(0.0, 0.008, rr) * (1 - smoothstep(0.018, 0.045, rr))
    drop = 0.007 * (z < MOUTH_Z) * (1 - smoothstep(0.02, 0.05, rr))
    deep = 0.007 * (1 - smoothstep(0.0, 0.012, rr))
    out[sel, 0] += (rx * amt)[sel]
    out[sel, 2] += (rz * amt - drop)[sel]
    out[sel, 1] += deep[sel]
    key.data.foreach_set('co', out.ravel())


def add_mask_shape_keys(mask, env):
    mask.shape_key_add(name='Basis', from_mix=False)
    n = len(mask.data.vertices)
    co = np.zeros(n * 3)
    mask.data.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    u, v = mask_uv_from_world(co)
    ca, sa = math.cos(MASK_ROLL), math.sin(MASK_ROLL)
    # mask_slip: slides about 6 cm down the face, the top and the creature's-left side peel away
    out = co.copy()
    peel_top = 0.035 * smoothstep(-0.02, 0.10, v) ** 2
    peel_side = 0.024 * smoothstep(0.015, 0.075, u) * smoothstep(-0.06, 0.08, v)
    sag = 0.012 * smoothstep(-0.06, -0.15, v)
    out[:, 2] -= 0.060 + 0.006 * smoothstep(0.0, 0.08, u)
    out[:, 1] -= 0.004 + peel_top + peel_side + sag
    out[:, 0] += 0.010 * smoothstep(0.03, 0.08, u) + 0.004 * smoothstep(0.0, 0.1, v)
    for i in range(n):
        hit = env.ray_cast(V((out[i, 0], -1.0, out[i, 2])), V((0, 1, 0)))
        if hit[0] is not None:
            out[i, 1] = min(out[i, 1], hit[0].y - 0.005 - mask_relief(float(u[i]), float(v[i])) * 0.6)
    k = mask.shape_key_add(name='mask_slip', from_mix=False)
    k.data.foreach_set('co', out.ravel())
    # mouth_hole_open: the lips of the stolen face stretch round the widening hole
    mu, mv = MASK_MOUTH_UV
    du, dv = u - mu, v - mv
    r = np.hypot(du / 1.25, dv)
    amt = 0.010 * (1 - smoothstep(0.012, 0.042, r))
    ru, rv = du / np.maximum(r, 1e-6), dv / np.maximum(r, 1e-6)
    gu = ru * amt
    gv = rv * amt - 0.006 * (dv < 0) * (1 - smoothstep(0.02, 0.05, r))
    out = co.copy()
    out[:, 0] += gu * ca + gv * sa
    out[:, 2] += -gu * sa + gv * ca
    out[:, 1] -= 0.002 * (1 - smoothstep(0.012, 0.04, r))
    k = mask.shape_key_add(name='mouth_hole_open', from_mix=False)
    k.data.foreach_set('co', out.ravel())


# ---------------------------------------------------------------------------------------------------------------
# Body assembly
# ---------------------------------------------------------------------------------------------------------------
def build_body_and_mask():
    body = build_body_sculpt()
    remesh_and_reduce(body)
    fit_height(body)
    body.name = 'skin_stealer_body'
    body.data.name = 'skin_stealer_body'
    bm = bmesh.new()
    bm.from_mesh(body.data)
    zero = {}
    for name in ('sleeve', 'chest', 'back', 'card'):
        zero[name] = contour_cut(bm, REGIONS[name])
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    bmesh.ops.dissolve_degenerate(bm, dist=1e-5, edges=bm.edges[:])
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    bm.normal_update()
    seams = []
    for name, spacing, offset, radius in (('sleeve', 0.0125, 0.0105, 0.0047), ('chest', 0.0125, 0.0105, 0.0047),
                                         ('back', 0.0125, 0.0105, 0.0047), ('sleeve', 0.017, 0.021, 0.0035),
                                         ('chest', 0.017, 0.021, 0.0035), ('back', 0.017, 0.021, 0.0035)):
        vs = [v for v in zero[name] if v.is_valid]
        pos = np.array([tuple(v.co) for v in vs])
        nrm = np.array([tuple(v.normal) for v in vs])
        pts = seam_points(pos, nrm, REGIONS[name], spacing, offset)
        if len(pts):
            seams.append(np.hstack([pts, np.full((len(pts), 1), radius)]))
    seams = np.vstack(seams) if seams else np.zeros((0, 4))
    bm.to_mesh(body.data)
    bm.free()
    for p in body.data.polygons:
        p.use_smooth = True
    env = envelope_bvh()
    mask = build_mask(env)
    unwrap([body, mask])
    tex = paint_textures(body, mask, None, seams)
    return body, mask, env, tex


def finish_body(body, mask, arm, mats, env):
    m_skin, m_human, m_slime = mats
    for n in BONES:
        body.vertex_groups.new(name=n)
    mask.vertex_groups.new(name='mask')
    body.data.materials.clear()
    for m in (m_skin, m_human, m_slime):   # slots first: to_mesh clamps material indices to existing slots
        body.data.materials.append(m)
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bm.verts.ensure_lookup_table()
    bm.verts.index_update()
    P = bm_coords(bm)
    edges = np.array([(e.verts[0].index, e.verts[1].index) for e in bm.edges])
    names, order, top = compute_weights(P, edges)
    write_weights(bm, body, names, order, top)
    kind = bm.faces.layers.int.new('kind')
    sk = s_skin(P)
    skin_faces = faces_inside(bm, s_skin)
    card_faces = faces_inside(bm, s_card)
    slime_faces = [f for f in bm.faces if min(abs(sk[v.index]) for v in f.verts) < 0.009]
    deform = bm.verts.layers.deform.verify()
    gi = {g.name: g.index for g in body.vertex_groups}
    _f, skin_new = add_layer(bm, skin_faces, skin_offset, 1, KIND_SKIN, kind)
    # the loose lower parts of the chest and back patches hang from their own flap bones
    for v in skin_new:
        p = np.array([tuple(v.co)])
        if s_chest(p)[0] > -0.01:
            blend_vertex_weights(v, deform, gi, 'chest_flap', 0.15 + 0.35 * float(smoothstep(1.64, 1.46, v.co.z)))
        elif s_back(p)[0] > -0.01:
            blend_vertex_weights(v, deform, gi, 'back_flap', 0.1 + 0.35 * float(smoothstep(1.64, 1.50, v.co.z)))
    add_layer(bm, card_faces, card_offset, 0, KIND_CARD, kind)
    add_layer(bm, slime_faces, slime_offset, 2, KIND_SLIME, kind)
    kinds = np.array([f[kind] for f in bm.faces])
    bm.faces.layers.int.remove(kind)
    bm.to_mesh(body.data)
    bm.free()
    if body.data.validate(verbose=True):
        print('BODY mesh needed fixes')
    for p in body.data.polygons:
        p.use_smooth = True
    add_body_shape_keys(body, kinds)
    common.assign(mask, m_human)
    vg = mask.vertex_groups['mask']
    vg.add(list(range(len(mask.data.vertices))), 1.0, 'REPLACE')
    add_mask_shape_keys(mask, env)
    for o in (body, mask):
        o.parent = arm
        md = o.modifiers.new('Armature', 'ARMATURE')
        md.object = arm
    print('BODY tris', sum(len(p.vertices) - 2 for p in body.data.polygons), 'mask tris',
          sum(len(p.vertices) - 2 for p in mask.data.polygons))
    return kinds


# ---------------------------------------------------------------------------------------------------------------
# The disguise: an Almond Water thermos (prop_almond_water dimensions) with a wet slime line at the base seam
# ---------------------------------------------------------------------------------------------------------------
BOTTLE_PROFILE = [(0.090, 0.0), (0.0985, 0.004), (0.100, 0.012), (0.100, 0.06), (0.100, 0.10), (0.100, 0.15),
                  (0.100, 0.20), (0.100, 0.24), (0.100, 0.288), (0.096, 0.302), (0.080, 0.328), (0.058, 0.352),
                  (0.043, 0.366), (0.041, 0.370), (0.041, 0.409), (0.036, 0.415)]
BOTTLE_DENTS = [((0.9, 0.16), 0.010, 0.035), ((2.6, 0.22), 0.008, 0.03), ((4.4, 0.09), 0.007, 0.03)]


def bottle_texture(size=512):
    v, u = np.mgrid[0:size, 0:size]
    u = (u + 0.5) / size
    v = (v + 0.5) / size
    ang = u * 2 * np.pi
    P = np.stack([np.cos(ang) * 0.1, np.sin(ang) * 0.1, v * 0.415], axis=-1).reshape(-1, 3)
    paint = np.array(C_STEEL_PAINT)
    c = np.tile(paint, (len(P), 1)) * (1 + 0.05 * fbm(P, 30.0, 3, 201))[:, None]
    chip = smoothstep(0.50, 0.56, fbm(P, 45.0, 3, 202) + 0.3 * (np.exp(-((P[:, 2] - 0.30) / 0.015) ** 2)
                                                               + np.exp(-(P[:, 2] / 0.01) ** 2)))
    c = mix(c, C_STEEL_BARE, chip)
    scratch = smoothstep(0.82, 0.95, vnoise(P * np.array([1.0, 1.0, 0.08]), 260.0, 203)) * 0.5
    c = mix(c, C_STEEL_BARE, scratch)
    rust = smoothstep(0.55, 0.8, fbm(P, 40.0, 2, 204)) * np.exp(-(P[:, 2] / 0.03))
    c = mix(c, (0.42, 0.28, 0.18), 0.6 * rust)
    return encode_image('almond_steel_basecolor', c.reshape(size, size, 3).astype(np.float32), 'JPEG', 88)


def build_bottle(arm, m_slime, slime_uv):
    segs = 20
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new('UVMap')
    rings = []
    for r, z in BOTTLE_PROFILE:
        ring = []
        for j in range(segs):
            a = 2 * math.pi * j / segs
            rr = r
            for (da, dz), depth, rad in BOTTLE_DENTS:
                if r > 0.095:
                    dd = math.hypot((((a - da + math.pi) % (2 * math.pi)) - math.pi) * 0.1, z - dz)
                    rr -= depth * math.exp(-(dd / rad) ** 2)
            ring.append(bm.verts.new((rr * math.cos(a), rr * math.sin(a), z)))
        rings.append(ring)
    bot = bm.verts.new((0, 0, 0))
    top = bm.verts.new((0, 0, 0.415))
    cap_from = len(BOTTLE_PROFILE) - 3
    faces = []
    for i in range(len(rings) - 1):
        for j in range(segs):
            f = bm.faces.new((rings[i][j], rings[i][(j + 1) % segs], rings[i + 1][(j + 1) % segs], rings[i + 1][j]))
            f.material_index = 1 if i >= cap_from else 0
            faces.append(f)
    for j in range(segs):
        f = bm.faces.new((bot, rings[0][(j + 1) % segs], rings[0][j]))
        f.material_index = 0
        f = bm.faces.new((top, rings[-1][j], rings[-1][(j + 1) % segs]))
        f.material_index = 1
    for f in bm.faces:
        for l in f.loops:
            co = l.vert.co
            u = (math.atan2(co.y, co.x) / (2 * math.pi)) % 1.0
            l[uvl].uv = (u, co.z / 0.415)
        us = [l[uvl].uv.x for l in f.loops]
        if max(us) - min(us) > 0.5:
            for l in f.loops:
                if l[uvl].uv.x < 0.5:
                    l[uvl].uv.x += 1.0
    # fold-down carry loop, hanging over the front of the cap
    path = [V((-0.030, -0.028, 0.409)), V((-0.032, -0.056, 0.401)), V((-0.032, -0.071, 0.374)),
            V((-0.026, -0.076, 0.348)), V((0.0, -0.078, 0.343)), V((0.026, -0.076, 0.348)), V((0.032, -0.071, 0.374)),
            V((0.032, -0.056, 0.401)), V((0.030, -0.028, 0.409))]
    sides = 6
    prev = None
    first_ring = []
    for i, p in enumerate(path):
        t = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        a = t.orthogonal().normalized()
        b = t.cross(a)
        ring = [bm.verts.new(p + (a * math.cos(2 * math.pi * k / sides) + b * math.sin(2 * math.pi * k / sides)) * 0.0032)
                for k in range(sides)]
        if prev:
            for k in range(sides):
                f = bm.faces.new((prev[k], prev[(k + 1) % sides], ring[(k + 1) % sides], ring[k]))
                f.material_index = 1
                for l in f.loops:
                    l[uvl].uv = (0.5, 0.5)
        prev = ring
    # the tell: a thin wet line at the base seam (slime material, mapped to an opaque spot of the slime texture)
    band = []
    for j in range(segs):
        a0, a1 = 2 * math.pi * j / segs, 2 * math.pi * (j + 1) / segs
        q = [bm.verts.new((0.1006 * math.cos(a), 0.1006 * math.sin(a), z)) for a, z in
             ((a0, 0.0015), (a1, 0.0015), (a1, 0.011), (a0, 0.011))]
        f = bm.faces.new(q)
        f.material_index = 2
        for l in f.loops:
            l[uvl].uv = slime_uv
    bm.normal_update()
    me = bpy.data.meshes.new('disguise_bottle')
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new('disguise_bottle', me)
    bpy.context.scene.collection.objects.link(obj)
    for p in me.polygons:
        p.use_smooth = True
    steel = common.material('almond_steel', color=(1, 1, 1), metallic=0.35, roughness=0.55,
                            base_image=bottle_texture())
    cap = common.material('almond_cap', color=C_STEEL_BARE, metallic=0.85, roughness=0.35)
    for m in (steel, cap, m_slime):
        me.materials.append(m)
    me.set_sharp_from_angle(angle=math.radians(40))
    obj.parent = arm
    return obj


def slime_uv_spot(img):
    """UV of an opaque spot in the slime texture (for the bottle's wet seam)."""
    w, h = img.size
    px = np.zeros(w * h * 4, np.float32)
    img.pixels.foreach_get(px)
    a = px.reshape(h, w, 4)[..., 3]
    k = np.ones((5, 5))
    m = a.copy()
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            m = np.minimum(m, np.roll(a, (dy, dx), axis=(0, 1)))
    y, x = np.unravel_index(np.argmin(np.abs(m - 0.45) + (m < 0.3) * 9), m.shape)
    return ((x + 0.5) / w, (y + 0.5) / h)


def add_sockets(arm):
    common.empty('HIT_head', (0.0, HEAD_C.y, (1.77 + 2.27) / 2), parent=arm, parent_bone='head')
    common.empty('HIT_body', (0.0, 0.02, (0.30 + 1.77) / 2), parent=arm, parent_bone='spine_01')
    common.empty('SOCKET_mouth', (MOUTH_X, -0.205, MOUTH_Z), parent=arm, parent_bone='head')
    w, d, lh, npal = hand_frame('R')
    common.empty('SOCKET_hand_R', tuple(w + d * 0.05 + npal * 0.016), parent=arm, parent_bone='hand_R')
    js = common.empty('JS_CAM', JS_CAM, parent=arm)
    return js


JS_CAM = (0.0, -0.78, 2.03)


# ---------------------------------------------------------------------------------------------------------------
# Animation: poses are specs (armature-axis rotations per bone, offsets, finger curls, foot placements, optional hand
# targets); a small FK/IK solver turns each frame's spec into bone-local transforms that are keyed every frame.
# Rotation conventions (armature axes, applied in the parent's frame): x > 0 tips an upward bone forward (-Y) and
# swings a downward bone backward; y > 0 tips the bone towards +X (the creature's left); z > 0 turns it left.
# ---------------------------------------------------------------------------------------------------------------

HEEL = {s: V((ANKLE[s].x, ANKLE[s].y + 0.05, 0.0)) for s in SIDES}
FINGER_BONES = {s: [n for n in BONES if n.endswith('_' + s) and n.split('_')[0] in ('thumb', 'index', 'middle', 'ring')]
                for s in SIDES}


def eul_q(x=0.0, y=0.0, z=0.0):
    return (Quaternion((0, 0, 1), math.radians(z)) @ Quaternion((0, 1, 0), math.radians(y))
            @ Quaternion((1, 0, 0), math.radians(x)))


def spec():
    return {'rot': {}, 'loc': {}, 'curl': {}, 'feet': {'L': [0.0] * 5, 'R': [0.0] * 5}, 'hands': {},
            'head_abs': None}


def add_rot(s, bone, x=0.0, y=0.0, z=0.0):
    r = s['rot'].setdefault(bone, [0.0, 0.0, 0.0])
    r[0] += x
    r[1] += y
    r[2] += z


def set_rot(s, bone, x=0.0, y=0.0, z=0.0):
    s['rot'][bone] = [x, y, z]


def add_loc(s, bone, x=0.0, y=0.0, z=0.0):
    r = s['loc'].setdefault(bone, [0.0, 0.0, 0.0])
    r[0] += x
    r[1] += y
    r[2] += z


def add_curl(s, side, amt, thumb=None):
    for n in FINGER_BONES[side]:
        k = 0.6 if n.endswith('01_' + side) else 1.0
        if n.startswith('thumb'):
            k *= 0.6 if thumb is None else thumb
        s['curl'][n] = s['curl'].get(n, 0.0) + amt * k


def mix_spec(a, b, t):
    if isinstance(a, dict) or isinstance(b, dict):
        a = a or {}
        b = b or {}
        out = {}
        for k in set(a) | set(b):
            if k in a and k in b:
                out[k] = mix_spec(a[k], b[k], t)
            else:
                v = a.get(k, b.get(k))
                z = mix_spec(_zero_like(v), v, t if k in b else 1 - t)
                out[k] = z
        return out
    if a is None or b is None:
        return copy.deepcopy(b if t >= 0.5 else a)
    if isinstance(a, (list, tuple)):
        return [x * (1 - t) + y * t for x, y in zip(a, b)]
    return a * (1 - t) + b * t


def _zero_like(v):
    if isinstance(v, dict):
        return {k: _zero_like(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [0.0] * len(v)
    if v is None:
        return None
    return 0.0


def ease(t):
    t = min(max(t, 0.0), 1.0)
    return t * t * (3 - 2 * t)


class Rig:
    def __init__(self, arm):
        self.arm = arm
        self.names = list(BONES.keys())
        self.parent = {n: BONES[n][2] for n in self.names}
        self.rest = {b.name: b.matrix_local.copy() for b in arm.data.bones}
        self.rest3 = {n: m.to_3x3() for n, m in self.rest.items()}
        self.rel = {n: (self.rest[self.parent[n]].inverted() @ self.rest[n]) if self.parent[n] else self.rest[n].copy()
                    for n in self.names}
        self.curl_axis = {}
        for s in SIDES:
            w, d, lh, npal = hand_frame(s)
            for n in FINGER_BONES[s]:
                h, t, _p = BONES[n]
                self.curl_axis[n] = (t - h).normalized().cross(npal).normalized()

    def basis_from_spec(self, s):
        basis = {}
        for n in self.names:
            q = eul_q(*s['rot'].get(n, (0, 0, 0)))
            c = s['curl'].get(n, 0.0)
            if c:
                q = Quaternion(self.curl_axis[n], math.radians(c)) @ q
            R3 = self.rest3[n]
            basis[n] = [R3.inverted() @ V(s['loc'].get(n, (0, 0, 0))), (R3.inverted() @ q.to_matrix() @ R3).to_quaternion()]
        return basis

    @staticmethod
    def mat(b):
        return Matrix.Translation(b[0]) @ b[1].to_matrix().to_4x4()

    def fk(self, basis):
        posed = {}
        for n in self.names:
            p = self.parent[n]
            posed[n] = ((posed[p] @ self.rel[n]) if p else self.rel[n]) @ self.mat(basis[n])
        return posed

    def unposed(self, posed, n):
        p = self.parent[n]
        return (posed[p] @ self.rel[n]) if p else self.rel[n].copy()

    def set_orient(self, basis, posed, n, O3):
        U = self.unposed(posed, n)
        basis[n][1] = (U.to_3x3().inverted() @ O3).to_quaternion()
        posed[n] = U @ self.mat(basis[n])

    def aim(self, basis, posed, n, direction):
        U = self.unposed(posed, n)
        cur = (U.to_3x3() @ V((0, 1, 0))).normalized()
        q = cur.rotation_difference(direction.normalized())
        self.set_orient(basis, posed, n, q.to_matrix() @ U.to_3x3())

    def two_bone(self, basis, posed, b1, b2, b3, target, pole):
        H = self.unposed(posed, b1).translation
        a = (BONES[b2][0] - BONES[b1][0]).length
        b = (BONES[b3][0] - BONES[b2][0]).length
        d = V(target) - H
        c = min(max(d.length, abs(a - b) + 1e-4), (a + b) * 0.9995)
        dn = d.normalized()
        cos_a = min(max((a * a + c * c - b * b) / (2 * a * c), -1.0), 1.0)
        A = math.acos(cos_a)
        pn = V(pole) - dn * V(pole).dot(dn)
        pn = pn.normalized() if pn.length > 1e-6 else dn.orthogonal().normalized()
        K = H + (dn * math.cos(A) + pn * math.sin(A)) * a
        self.aim(basis, posed, b1, K - H)
        self.aim(basis, posed, b2, (H + dn * c) - K)

    def solve(self, s):
        basis = self.basis_from_spec(s)
        posed = self.fk(basis)
        if s.get('head_abs'):
            self.set_orient(basis, posed, 'head', eul_q(*s['head_abs']).to_matrix() @ self.rest3['head'])
            posed = self.fk(basis)
        for side in SIDES:
            dx, dy, lift, pitch, yaw = s['feet'][side]
            Rz = Matrix.Rotation(math.radians(yaw), 3, 'Z')
            R = Rz @ Matrix.Rotation(math.radians(pitch), 3, 'X')
            off = V((dx, dy, lift))
            if pitch >= 0:
                ankle = BALL[side] + off + R @ (ANKLE[side] - BALL[side])
            else:
                ankle = HEEL[side] + off + R @ (ANKLE[side] - HEEL[side])
            pole = Rz @ V((0.12 * SIDES[side], -1.0, -0.15))
            self.two_bone(basis, posed, 'thigh_' + side, 'shin_' + side, 'foot_' + side, ankle, pole)
            self.set_orient(basis, posed, 'foot_' + side, R @ self.rest3['foot_' + side])
            tp = pitch * sstep(0.0, 0.03, lift) if pitch > 0 else pitch
            self.set_orient(basis, posed, 'toe_' + side,
                            Rz @ Matrix.Rotation(math.radians(tp), 3, 'X') @ self.rest3['toe_' + side])
        for side, h in s['hands'].items():
            k = SIDES[side]
            w = h[6] if len(h) > 6 else 1.0
            if w <= 1e-4:
                continue
            chain = ('upperarm_' + side, 'forearm_' + side, 'hand_' + side)
            fk_q = {b: basis[b][1].copy() for b in chain}
            self.two_bone(basis, posed, chain[0], chain[1], chain[2], V(h[:3]), V((0.9 * k, 0.5, -0.5)))
            rest_dir = (BONES['hand_' + side][1] - BONES['hand_' + side][0]).normalized()
            q = rest_dir.rotation_difference(V(h[3:6]).normalized())
            self.set_orient(basis, posed, 'hand_' + side, q.to_matrix() @ self.rest3['hand_' + side])
            if w < 1.0:
                for b in chain:
                    basis[b][1] = fk_q[b].slerp(basis[b][1], w)
                posed = self.fk(basis)
        return basis


def neutral():
    """The standing pose every non-locomotion clip starts or ends in: hunched, head jutting, right shoulder up."""
    s = spec()
    add_loc(s, 'pelvis', 0, 0.012, -0.03)
    add_rot(s, 'pelvis', 2)
    add_rot(s, 'spine_01', 4)
    add_rot(s, 'spine_02', 6, -1)
    add_rot(s, 'spine_03', 8, -2, 1)
    add_rot(s, 'neck', 8)
    add_rot(s, 'head', -22, -6, 4)
    add_rot(s, 'clavicle_R', 0, 6, 3)
    add_rot(s, 'clavicle_L', 0, 0, -2)
    add_rot(s, 'upperarm_L', -5, 6)
    add_rot(s, 'upperarm_R', -3, -5)
    add_rot(s, 'forearm_L', -12)
    add_rot(s, 'forearm_R', -8)
    add_rot(s, 'hand_L', -4)
    add_rot(s, 'hand_R', -4)
    add_curl(s, 'L', 14)
    add_curl(s, 'R', 12)
    s['feet']['R'] = [0.0, 0.03, 0.0, 0.0, -6.0]
    return s


def clip_idle(f, N):
    s = neutral()
    ph = 2 * math.pi * f / N
    br = math.sin(2 * ph)
    add_rot(s, 'spine_02', 1.2 * br)
    add_rot(s, 'spine_03', -1.6 * br)
    add_rot(s, 'neck', 0.8 * br)
    add_rot(s, 'head', 0.6 * br)
    add_rot(s, 'clavicle_L', 0, -1.0 * br)
    add_rot(s, 'clavicle_R', 0, 1.0 * br)
    add_loc(s, 'pelvis', 0.006 * math.sin(ph), 0, 0.003 * math.sin(2 * ph))
    add_rot(s, 'spine_01', 0, -1.2 * math.sin(ph))
    add_rot(s, 'spine_03', 0, 0.8 * math.sin(ph))
    add_rot(s, 'upperarm_L', -2 * math.sin(ph + 0.5))
    add_rot(s, 'upperarm_R', -1.5 * math.sin(ph + 1.0))
    tw = sstep(50, 52, f) * (1 - sstep(54, 62, f))      # the head twitch
    add_rot(s, 'head', 7 * tw, -11 * tw, 15 * tw)
    tw2 = sstep(17, 19, f) * (1 - sstep(20, 25, f))
    add_rot(s, 'head', 0, 4 * tw2, -5 * tw2)
    sp = sstep(70, 72, f) * (1 - sstep(73, 80, f))      # a spasm of the right hand
    add_curl(s, 'R', 25 * sp)
    add_rot(s, 'chest_flap', -3 * math.sin(ph + 0.3))
    add_rot(s, 'back_flap', 2 * math.sin(ph))
    return s


GAITS = {
    # beta: stance fraction; lift/strike/push/swing_pitch per foot; yc: stance centre (+ = behind the hip)
    'walk_limp': dict(v=1.45, N=27, beta={'L': 0.60, 'R': 0.48}, lift={'L': 0.075, 'R': 0.014},
                      strike={'L': 10, 'R': 0}, push={'L': 28, 'R': 14}, swing_pitch={'L': 0, 'R': 22}, yc=0.02,
                      pz=-0.075, bob=0.018, dip=0.03, sway=0.025, yaw=5, roll=4, arm={'L': 16, 'R': 6},
                      hunch=(0, 4, 3), head=-4, arms_fwd=0, forearm=0, curl=0, flight=0.0),
    'stalk': dict(v=2.55, N=24, beta={'L': 0.46, 'R': 0.46}, lift={'L': 0.11, 'R': 0.10},
                  strike={'L': 8, 'R': 6}, push={'L': 30, 'R': 28}, swing_pitch={'L': 0, 'R': 4}, yc=0.05,
                  pz=-0.15, bob=0.025, dip=0.0, sway=0.02, yaw=7, roll=3, arm={'L': 12, 'R': 10},
                  hunch=(4, 8, 8), head=-14, arms_fwd=-22, forearm=-30, curl=8, flight=0.0),
    'lurch': dict(v=3.65, N=18, beta={'L': 0.36, 'R': 0.36}, lift={'L': 0.17, 'R': 0.15},
                  strike={'L': 6, 'R': 4}, push={'L': 35, 'R': 32}, swing_pitch={'L': 0, 'R': 6}, yc=0.07,
                  pz=-0.09, bob=0.03, dip=0.0, sway=0.015, yaw=10, roll=4, arm={'L': 10, 'R': 10},
                  hunch=(6, 5, 5), head=-30, arms_fwd=-55, forearm=-12, curl=4, flight=0.04),
}


def clip_gait(f, N, g):
    s = neutral()
    T = N / 30.0
    phase = (f % N) / N
    for side, off in (('L', 0.0), ('R', 0.5)):
        beta = g['beta'][side]
        ph = (phase - off) % 1.0
        Ls = g['v'] * beta * T
        if ph < beta:
            q = ph / beta
            y = -Ls / 2 + Ls * q
            lift = 0.0
            pitch = (-g['strike'][side] * (1 - sstep(0, 0.15, q)) if q < 0.15 else
                     g['push'][side] * sstep(0.6, 1.0, q) if q > 0.6 else 0.0)
        else:
            q = (ph - beta) / (1 - beta)
            y = Ls / 2 - Ls * (0.5 - 0.5 * math.cos(math.pi * q))
            lift = g['lift'][side] * math.sin(math.pi * q) ** 0.9
            sp = g['swing_pitch'][side]
            if q < 0.35:
                pitch = g['push'][side] * (1 - sstep(0, 0.35, q)) + sp * sstep(0, 0.35, q)
            elif q > 0.7:
                pitch = sp * (1 - sstep(0.7, 1.0, q)) - g['strike'][side] * sstep(0.7, 1.0, q)
            else:
                pitch = sp
        yaw0 = s['feet'][side][4]
        s['feet'][side] = [0.0, y + g['yc'], lift, pitch, yaw0]
    p2 = 2 * math.pi * phase
    z = g['pz'] - g['bob'] * 0.5 * (1 + math.cos(2 * p2))
    if g['flight']:
        z += g['flight'] * max(0.0, math.sin(2 * p2 - 0.6))
    if g['dip']:
        qr = ((phase - 0.5) % 1.0) / g['beta']['R']
        if qr < 1.0:
            z -= g['dip'] * math.sin(math.pi * qr)
    add_loc(s, 'pelvis', g['sway'] * math.sin(p2), 0.0, z + 0.03)
    add_rot(s, 'pelvis', g['hunch'][0], -g['roll'] * math.sin(p2), g['yaw'] * math.sin(p2))
    add_rot(s, 'spine_01', 0, g['roll'] * 0.6 * math.sin(p2), -g['yaw'] * 0.3 * math.sin(p2))
    add_rot(s, 'spine_02', g['hunch'][1], 0, -g['yaw'] * 0.4 * math.sin(p2))
    add_rot(s, 'spine_03', g['hunch'][2], 0, -g['yaw'] * 0.4 * math.sin(p2))
    add_rot(s, 'head', g['head'] + 2.5 * math.cos(2 * p2), 0, 0)
    for side in SIDES:
        sw = g['arm'][side] * math.sin(p2) * (-1 if side == 'L' else 1)
        add_rot(s, 'upperarm_' + side, g['arms_fwd'] + sw)
        add_rot(s, 'forearm_' + side, g['forearm'] - 0.5 * abs(sw))
        add_curl(s, side, g['curl'])
    if g is GAITS['walk_limp']:
        qr = ((phase - 0.5) % 1.0) / g['beta']['R']
        on_bad = math.sin(math.pi * qr) if qr < 1.0 else 0.0
        add_rot(s, 'spine_02', 0, -4 * on_bad)
        add_rot(s, 'head', 3 * on_bad, 3 * on_bad)
    if g is GAITS['lurch']:
        add_rot(s, 'clavicle_L', 0, -8, -6)
        add_rot(s, 'clavicle_R', 0, 4, 6)
        add_rot(s, 'jaw', 6 + 3 * math.sin(2 * p2))
    return s


def clip_mimic(f, N):
    s = neutral()
    a = sstep(0, 12, f) * (1 - sstep(30, 40, f))
    tremble = math.sin(f * 2 * math.pi / 7) * 1.2 * a
    add_rot(s, 'head', 6 * a + tremble, 30 * a, -10 * a)
    add_rot(s, 'neck', 0, 8 * a, -4 * a)
    add_rot(s, 'spine_03', 0, 5 * a)
    add_rot(s, 'clavicle_L', 0, -6 * a)
    add_rot(s, 'jaw', 6 * a)
    add_rot(s, 'mask', 0, 3 * a)
    add_loc(s, 'pelvis', 0, 0, -0.04 * a)
    add_curl(s, 'L', 8 * a)
    add_curl(s, 'R', 8 * a)
    return s


def pose_windup():
    s = neutral()
    add_rot(s, 'spine_02', -6)
    add_rot(s, 'spine_03', -8)
    add_rot(s, 'neck', -4)
    add_rot(s, 'head', -8)
    add_rot(s, 'clavicle_L', 0, -14, -6)
    add_rot(s, 'clavicle_R', 0, 14, 6)
    set_rot(s, 'upperarm_L', -150, -14)
    set_rot(s, 'upperarm_R', -150, 14)
    set_rot(s, 'forearm_L', -38)
    set_rot(s, 'forearm_R', -38)
    set_rot(s, 'hand_L', -20)
    set_rot(s, 'hand_R', -20)
    add_curl(s, 'L', 22)
    add_curl(s, 'R', 22)
    add_rot(s, 'jaw', 10)
    add_loc(s, 'pelvis', 0, 0.05, -0.02)
    s['feet']['R'] = [0.0, 0.12, 0.0, 10.0, -6.0]
    return s


def pose_strike():
    s = neutral()
    add_rot(s, 'pelvis', 6)
    add_rot(s, 'spine_01', 8)
    add_rot(s, 'spine_02', 12)
    add_rot(s, 'spine_03', 12)
    add_rot(s, 'neck', 6)
    add_rot(s, 'head', -16)
    set_rot(s, 'upperarm_L', -40, 4)
    set_rot(s, 'upperarm_R', -40, -4)
    set_rot(s, 'forearm_L', -25)
    set_rot(s, 'forearm_R', -25)
    set_rot(s, 'hand_L', 15)
    set_rot(s, 'hand_R', 15)
    add_curl(s, 'L', 40)
    add_curl(s, 'R', 40)
    add_rot(s, 'jaw', 14)
    add_loc(s, 'pelvis', 0, -0.10, -0.12)
    s['feet']['L'] = [0.0, -0.30, 0.0, 0.0, 0.0]
    s['feet']['R'] = [0.0, 0.10, 0.0, 18.0, -6.0]
    return s


def pose_hit():
    s = neutral()
    add_rot(s, 'spine_02', -10, 0, 6)
    add_rot(s, 'spine_03', -12, 4, 8)
    add_rot(s, 'neck', -8)
    add_rot(s, 'head', -18, 12, -14)
    add_rot(s, 'upperarm_L', -28, -18)
    add_rot(s, 'upperarm_R', -18, 22)
    add_rot(s, 'forearm_L', -25)
    add_rot(s, 'forearm_R', -30)
    add_curl(s, 'L', -12)
    add_curl(s, 'R', -12)
    add_rot(s, 'jaw', 12)
    add_rot(s, 'mask', 6)
    add_rot(s, 'chest_flap', -12)
    add_loc(s, 'pelvis', 0, 0.07, -0.03)
    s['feet']['R'] = [0.0, 0.16, 0.0, 8.0, -6.0]
    return s


def pose_kneel():
    s = neutral()
    s['loc']['pelvis'] = [0.0, -0.36, -0.53]
    add_rot(s, 'pelvis', -12)
    add_rot(s, 'spine_02', -4)
    add_rot(s, 'neck', -6)
    add_rot(s, 'head', -10, 10, 6)
    add_rot(s, 'upperarm_L', 8, 6)
    add_rot(s, 'upperarm_R', 8, -6)
    add_rot(s, 'forearm_L', 6)
    add_rot(s, 'forearm_R', 6)
    add_curl(s, 'L', -6)
    add_curl(s, 'R', -6)
    add_rot(s, 'jaw', 16)
    add_rot(s, 'mask', 25)
    add_loc(s, 'mask', 0, -0.015, -0.05)
    add_rot(s, 'chest_flap', -35)
    s['feet']['L'] = [0.0, 0.0, 0.0, 60.0, 0.0]
    s['feet']['R'] = [0.0, 0.02, 0.0, 60.0, -6.0]
    return s


def pose_collapse():
    s = pose_kneel()
    s['loc']['pelvis'] = [0.0, -0.40, -0.53]
    set_rot(s, 'pelvis', 14)
    set_rot(s, 'spine_01', 16)
    set_rot(s, 'spine_02', 18)
    set_rot(s, 'spine_03', 14, -6, 4)
    set_rot(s, 'neck', 26)
    set_rot(s, 'head', 18, -14, 8)
    set_rot(s, 'upperarm_L', -6, -16)
    set_rot(s, 'upperarm_R', -10, 18)
    set_rot(s, 'forearm_L', -38)
    set_rot(s, 'forearm_R', -30)
    set_rot(s, 'jaw', 22)
    set_rot(s, 'mask', 75)
    s['loc']['mask'] = [0.0, -0.05, -0.20]
    set_rot(s, 'chest_flap', -75)
    set_rot(s, 'back_flap', 40)
    return s


def pose_folded():
    """Crouched and folded low on the floor where the bottle stood (start of `reveal`)."""
    s = neutral()
    s['loc']['pelvis'] = [0.0, 0.05, -0.62]
    add_rot(s, 'pelvis', 25)
    add_rot(s, 'spine_01', 18)
    add_rot(s, 'spine_02', 18)
    add_rot(s, 'spine_03', 14)
    add_rot(s, 'neck', 20)
    add_rot(s, 'head', 36)
    set_rot(s, 'upperarm_L', 10, 28)
    set_rot(s, 'upperarm_R', 10, -28)
    set_rot(s, 'forearm_L', -95, 0, 30)
    set_rot(s, 'forearm_R', -95, 0, -30)
    add_curl(s, 'L', 30)
    add_curl(s, 'R', 30)
    add_rot(s, 'clavicle_L', 0, 6, -10)
    add_rot(s, 'clavicle_R', 0, -6, 10)
    s['feet']['L'] = [0.0, 0.0, 0.0, 34.0, 0.0]
    s['feet']['R'] = [0.0, 0.02, 0.0, 34.0, -6.0]
    return s


def clip_reveal(f, N):
    body_t = ease(sstep(5, N, f))
    s = mix_spec(pose_folded(), neutral(), body_t)
    up = ease(sstep(0, 8, f))
    down = ease(sstep(10, 19, f))
    start, top = V((-0.10, -0.10, 0.32)), V((-0.22, -0.30, 1.30))
    p = start.lerp(top, up)
    w = sstep(0.0, 2.0, f) * (1 - down)
    s['hands']['R'] = [p.x, p.y, p.z, -0.15, -0.25, 1.0, w]
    spread = up * (1 - down)
    for n in FINGER_BONES['R']:
        s['curl'][n] = s['curl'].get(n, 0.0) * (1 - spread) - 8.0 * spread
    add_rot(s, 'clavicle_R', 0, 18 * spread, 4 * spread)
    add_rot(s, 'jaw', 14 * math.sin(math.pi * sstep(6, N, f)))
    return s


def clip_death(f, N):
    if f <= 6:
        s = mix_spec(neutral(), pose_hit(), ease(f / 6))
        add_loc(s, 'pelvis', 0, 0, -0.10 * ease(f / 6))
    elif f <= 14:
        a = pose_hit()
        add_loc(a, 'pelvis', 0, 0, -0.10)
        s = mix_spec(a, pose_kneel(), ease((f - 6) / 8))
    else:
        s = mix_spec(pose_kneel(), pose_collapse(), ease((f - 14) / (N - 14)))
    return s


def jumpscare_spec(rig, f):
    """Art bible 5.4 'Wearing You': hands grab both edges of the view, the stolen face comes close, slips off,
    and the black mouth swallows the camera. Everything is placed relative to the static JS_CAM."""
    cam = V(JS_CAM)
    keys = [  # frame, mouth distance in front of the camera, mouth height offset, hand x, hand y offset, jaw, mask peel
        (0, 0.50, -0.06, 0.62, 0.45, 4, 0.0), (5, 0.40, -0.05, 0.36, 0.24, 6, 0.0),
        (18, 0.26, -0.04, 0.35, 0.22, 8, 0.0), (24, 0.22, -0.03, 0.345, 0.21, 14, 0.25),
        (30, 0.18, -0.02, 0.34, 0.20, 22, 1.0), (45, 0.075, 0.0, 0.32, 0.17, 30, 1.0)]
    for i in range(len(keys) - 1):
        if keys[i][0] <= f <= keys[i + 1][0]:
            k0, k1 = keys[i], keys[i + 1]
            t = ease((f - k0[0]) / (k1[0] - k0[0]))
            k = [a * (1 - t) + b * t for a, b in zip(k0[1:], k1[1:])]
            break
    dist, dz, hx, hy, jaw, peel = k
    grip = ease(f / 5.0)
    s = neutral()
    s['feet']['L'] = [0.0, -0.34 * ease(f / 4.0 + 0.5), 0.0, 0.0, 0.0]
    s['feet']['R'] = [0.0, 0.06, 0.0, 22.0, -6.0]
    add_loc(s, 'pelvis', 0, 0, 0.03)
    shake = 1.5 * math.sin(f * 1.9) * sstep(5, 18, f)
    s['head_abs'] = [-2.0 + shake, -9.0, 2.0 * math.sin(f * 0.7)]
    for side in SIDES:
        kk = SIDES[side]
        s['hands'][side] = [kk * hx, cam.y + hy, cam.z + 0.01 - 0.05 * (1 - grip),
                            -kk * (0.25 + 0.35 * grip), -0.9 + 0.15 * grip, 0.1, 1.0]
        add_curl(s, side, 10 + 32 * grip)
    add_rot(s, 'jaw', jaw)
    add_rot(s, 'mask', 14 * peel, 10 * peel, -12 * peel)
    add_loc(s, 'mask', 0.008 * peel, -0.02 * peel, -0.05 * peel)
    # place the head: solve pelvis forward offset and extra spine pitch so the mouth sits on its mark
    mouth_rest = V((MOUTH_X, -0.215, MOUTH_Z))
    head_rest = BONES['head'][0]
    target_mouth = V((MOUTH_X, cam.y + dist, cam.z + dz))
    target_head = target_mouth - eul_q(*s['head_abs']) @ (mouth_rest - head_rest)

    def evalf(dy, th):
        t = copy.deepcopy(s)
        add_loc(t, 'pelvis', 0, dy, 0)
        for b in ('spine_01', 'spine_02', 'spine_03'):
            add_rot(t, b, th / 3)
        add_rot(t, 'neck', th * 0.5)
        posed = rig.fk(rig.basis_from_spec(t))
        hp = posed['head'].translation
        return V((hp.y - target_head.y, hp.z - target_head.z)), t
    dy, th = 0.0, 0.0
    for _ in range(12):
        r, t = evalf(dy, th)
        if r.length < 2e-5:
            break
        r1, _t = evalf(dy + 1e-3, th)
        r2, _t = evalf(dy, th + 0.2)
        J = Matrix(((((r1 - r) / 1e-3).x, ((r2 - r) / 0.2).x), (((r1 - r) / 1e-3).y, ((r2 - r) / 0.2).y)))
        try:
            step = J.inverted() @ (-r)
        except ValueError:
            break
        dy += step.x
        th += step.y
    return t


def key_action(name, obj, frames_data, nframes):
    """frames_data: {bone: [(loc, quat) per frame]} -> an Action keyed on every frame (linear)."""
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    obj.animation_data_create()
    obj.animation_data.action = act
    for bone, seq in frames_data.items():
        path = 'pose.bones["%s"]' % bone
        prev = None
        quats = []
        for loc, q in seq:
            q = q.copy()
            if prev is not None and prev.dot(q) < 0:
                q.negate()
            quats.append(q)
            prev = q
        for attr, comps, getter in (('location', 3, lambda i: [p[0][i] for p in seq]),
                                    ('rotation_quaternion', 4, lambda i: [q[i] for q in quats])):
            for i in range(comps):
                vals = getter(i)
                fc = act.fcurve_ensure_for_datablock(obj, '%s.%s' % (path, attr), index=i)
                fc.keyframe_points.add(len(vals))
                co = np.empty(len(vals) * 2, np.float32)
                co[0::2] = np.arange(len(vals))
                co[1::2] = vals
                fc.keyframe_points.foreach_set('co', co)
                fc.keyframe_points.foreach_set('interpolation', [1] * len(vals))
                fc.update()
    act.use_frame_range = True
    act.frame_start = 0
    act.frame_end = nframes
    return act


def bake_clip(rig, name, nframes, fn, loop=False):
    data = {n: [] for n in rig.names}
    for f in range(nframes + 1):
        s = fn(0 if (loop and f == nframes) else f)
        basis = rig.solve(s)
        for n in rig.names:
            data[n].append((tuple(basis[n][0]), basis[n][1].copy()))
    act = key_action(name, rig.arm, data, nframes)
    print('CLIP', name, nframes, 'loop' if loop else '')
    return act


def bottle_shudder(bottle, N=12):
    act = bpy.data.actions.new('disguised_shudder')
    act.use_fake_user = True
    bottle.animation_data_create()
    bottle.animation_data.action = act
    rx, ry, lz = [], [], []
    for f in range(N + 1):
        env = math.exp(-f / 4.0) * (1 - sstep(9, N, f)) * sstep(0, 1, f)
        rx.append(math.radians(4.5) * env * math.sin(f * 2 * math.pi / 3.2))
        ry.append(math.radians(3.0) * env * math.sin(f * 2 * math.pi / 2.7 + 1.0))
        lz.append(0.005 * math.sin(math.pi * min(f / 3.0, 1.0)) if f <= 3 else 0.0)
    for path, idx, vals in (('rotation_euler', 0, rx), ('rotation_euler', 1, ry), ('rotation_euler', 2, [0.0] * (N + 1)),
                            ('location', 0, [0.0] * (N + 1)), ('location', 1, [0.0] * (N + 1)), ('location', 2, lz)):
        fc = act.fcurve_ensure_for_datablock(bottle, path, index=idx)
        fc.keyframe_points.add(N + 1)
        co = np.empty((N + 1) * 2, np.float32)
        co[0::2] = np.arange(N + 1)
        co[1::2] = vals
        fc.keyframe_points.foreach_set('co', co)
        fc.keyframe_points.foreach_set('interpolation', [1] * (N + 1))
        fc.update()
    act.use_frame_range = True
    act.frame_start = 0
    act.frame_end = N
    return act


CLIPS = [  # name, frames, loop (art bible 4.3; disguised_shudder is on the bottle node)
    ('reveal', 21, False), ('idle', 90, True), ('walk_limp', 27, True), ('stalk', 24, True), ('lurch', 18, True),
    ('mimic_tilt', 40, False), ('attack_windup', 9, False), ('attack_strike', 8, False),
    ('attack_recover', 18, False), ('stagger', 15, False), ('death', 24, False), ('jumpscare', 45, False),
]


def build_actions(rig, bottle):
    acts = {}
    for name, N, loop in CLIPS:
        if name == 'idle':
            fn = lambda f, N=N: clip_idle(f, N)
        elif name in GAITS:
            fn = lambda f, N=N, g=GAITS[name]: clip_gait(f, N, g)
        elif name == 'mimic_tilt':
            fn = lambda f, N=N: clip_mimic(f, N)
        elif name == 'attack_windup':
            fn = lambda f, N=N: mix_spec(neutral(), pose_windup(), ease(f / N))
        elif name == 'attack_strike':
            fn = lambda f, N=N: mix_spec(pose_windup(), pose_strike(), min(1.0, (f / 5.0) ** 2))
        elif name == 'attack_recover':
            fn = lambda f, N=N: mix_spec(pose_strike(), neutral(), ease(f / N))
        elif name == 'stagger':
            fn = lambda f: (mix_spec(neutral(), pose_hit(), 1 - (1 - f / 6.0) ** 2) if f <= 6
                            else mix_spec(pose_hit(), neutral(), ease((f - 6) / 9.0)))
        elif name == 'death':
            fn = lambda f, N=N: clip_death(f, N)
        elif name == 'reveal':
            fn = lambda f, N=N: clip_reveal(f, N)
        elif name == 'jumpscare':
            fn = lambda f: jumpscare_spec(rig, f)
        acts[name] = bake_clip(rig, name, N, fn, loop)
    acts['disguised_shudder'] = bottle_shudder(bottle)
    rig.arm.animation_data.action = acts['idle']
    return acts


# ---------------------------------------------------------------------------------------------------------------
# Checks on the exported file, previews, main
# ---------------------------------------------------------------------------------------------------------------
def glb_json(path):
    import json
    import struct
    data = pathlib.Path(path).read_bytes()
    length = struct.unpack_from('<I', data, 12)[0]
    return json.loads(data[20:20 + length])


def check_glb(path):
    """Print the rest world position of every socket (back in Blender axes) and every clip, read from the glb."""
    g = glb_json(path)
    nodes = g['nodes']
    parent = {}
    for i, n in enumerate(nodes):
        for c in n.get('children', []):
            parent[c] = i

    def local(n):
        t = n.get('translation', [0, 0, 0])
        r = n.get('rotation', [0, 0, 0, 1])
        s = n.get('scale', [1, 1, 1])
        return (Matrix.Translation(t) @ Quaternion((r[3], r[0], r[1], r[2])).to_matrix().to_4x4()
                @ Matrix.Diagonal((s[0], s[1], s[2], 1.0)))

    def world(i):
        M = local(nodes[i])
        while i in parent:
            i = parent[i]
            M = local(nodes[i]) @ M
        return M
    out = {}
    for i, n in enumerate(nodes):
        name = n.get('name', '')
        if name.startswith(('HIT_', 'SOCKET_', 'JS_CAM')) or name == 'disguise_bottle':
            p = world(i).translation
            out[name] = (round(p.x, 3), round(-p.z, 3), round(p.y, 3))
            print('GLB socket %-14s blender xyz %s' % (name, out[name]))
    for a in g.get('animations', []):
        dur = max(g['accessors'][s['input']]['max'][0] for s in a['samplers'])
        paths = sorted({c['target']['path'] for c in a['channels']})
        print('GLB anim %-18s %5.3f s = %4.1f frames, %d channels %s' % (a['name'], dur, dur * 30, len(a['channels']),
                                                                         paths))
    return out


def floor_check(arm, body, acts):
    """Lowest point of the posed body per clip (feet and knees should stay near the floor, not under it)."""
    scene = bpy.context.scene
    ad = arm.animation_data
    for name, N, _loop in CLIPS:
        ad.action = acts[name]
        lows = []
        for f in range(0, N + 1, 3):
            scene.frame_set(f)
            dg = bpy.context.evaluated_depsgraph_get()
            me = body.evaluated_get(dg).to_mesh()
            co = np.zeros(len(me.vertices) * 3)
            me.vertices.foreach_get('co', co)
            body.evaluated_get(dg).to_mesh_clear()
            lows.append(co.reshape(-1, 3)[:, 2].min())
        print('FLOOR %-15s min z %.3f (worst frame %d)' % (name, min(lows), 3 * int(np.argmin(lows))))
    ad.action = None


def reset_pose(arm):
    for pb in arm.pose.bones:
        pb.location = (0, 0, 0)
        pb.rotation_quaternion = (1, 0, 0, 0)


def previews(arm, body, mask, bottle, acts):
    scene = bpy.context.scene
    ad = arm.animation_data
    bottle.hide_render = True
    ad.action = None
    reset_pose(arm)
    scene.frame_set(0)
    common.render_preview('ent_skin_stealer.png', (2.25, -3.25, 1.75), target=(0, 0, 1.13), lens=40)
    common.render_preview('ent_skin_stealer_face.png', (0.42, -0.95, 2.14), target=(0.0, -0.13, 2.06), lens=55)
    common.render_preview('ent_skin_stealer_back.png', (-1.6, 2.9, 1.7), target=(0, 0, 1.13), lens=40)
    for name, frame, cam, target, lens, res in (
            ('lurch', 5, (2.7, -2.7, 1.3), (0, -0.25, 1.0), 38, (900, 900)),
            ('walk_limp', 9, (2.9, -1.6, 1.3), (0, 0, 1.05), 38, (900, 900)),
            ('idle', 0, (2.25, -3.25, 1.75), (0, 0, 1.1), 40, (900, 900)),
            ('reveal', 3, (1.6, -2.0, 0.9), (0, 0, 0.55), 38, (900, 900)),
            ('reveal', 6, (1.6, -2.0, 0.9), (0, 0, 0.55), 38, (900, 900)),
            ('death', 24, (2.2, -2.6, 1.2), (0, -0.4, 0.5), 38, (900, 900)),
            ('jumpscare', 14, JS_CAM, (0.0, JS_CAM[1] + 1.0, JS_CAM[2]), 14, (1280, 720)),
            ('jumpscare', 34, JS_CAM, (0.0, JS_CAM[1] + 1.0, JS_CAM[2]), 14, (1280, 720))):
        ad.action = acts[name]
        scene.frame_set(frame)
        common.render_preview('ent_skin_stealer_%s_f%02d.png' % (name, frame), cam, target=target, lens=lens,
                              resolution=res)
    ad.action = None
    reset_pose(arm)
    scene.frame_set(0)
    body.hide_render = mask.hide_render = True
    bottle.hide_render = False
    common.render_preview('ent_skin_stealer_bottle.png', (0.55, -0.75, 0.42), target=(0, 0, 0.2), lens=50,
                          resolution=(700, 700))
    body.hide_render = mask.hide_render = False


def main():
    common.reset_scene()
    if STAGE == 'geo':
        body = build_body_sculpt()
        remesh_and_reduce(body)
        fit_height(body)
        common.assign(body, common.material('check', color=C_SKIN, roughness=0.6))
        for p in body.data.polygons:
            p.use_smooth = True
        for name, cam, tgt, lens in (('front', (0.0, -3.4, 1.3), (0, 0, 1.13), 40),
                                     ('34', (2.0, -2.7, 1.6), (0, 0, 1.13), 40),
                                     ('side', (3.4, 0.0, 1.3), (0, 0, 1.13), 40),
                                     ('face', (0.25, -1.1, 2.1), (0, -0.1, 2.06), 50),
                                     ('hand', (-0.9, -0.9, 0.85), (-0.44, -0.02, 0.78), 50)):
            common.render_preview('check_geo_%s.png' % name, cam, target=tgt, lens=lens, directory=TMP)
        return
    body, mask, env, tex = build_body_and_mask()
    mats = build_materials(tex)
    arm = build_armature()
    finish_body(body, mask, arm, mats, env)
    bottle = build_bottle(arm, mats[2], slime_uv_spot(tex['slime']))
    add_sockets(arm)
    rig = Rig(arm)
    acts = build_actions(rig, bottle)
    print('TRIS total', common.triangle_count(), {o.name: common.triangle_count([o]) for o in bpy.context.scene.objects
                                                   if o.type == 'MESH'})
    path = common.export_glb(OUT_NAME)
    print('EXPORTED', path, path.stat().st_size, 'bytes')
    check_glb(path)
    floor_check(arm, body, acts)
    if STAGE != 'noprev':
        previews(arm, body, mask, bottle, acts)


main()
