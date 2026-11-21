"""Build public/assets/models/ent_smiler.glb: the Smiler, a hovering column of void with a glowing grin.

Run from the repository root (Git Bash):
    "/c/Program Files/Blender Foundation/Blender 4.5/blender.exe" --background --factory-startup \
        --python tools/blender/build_smiler.py                 # build and export
    ... --python tools/blender/build_smiler.py -- --previews   # also render tools/blender/previews/ent_smiler*.png

Interface: docs/design/art/model-contract.md (Smiler). Look: docs/design/art/art-bible.md 4.2 and 5.3,
docs/design/art/concepts/smiler/B_turnaround.webp, true scale in docs/design/art/blueprints/smiler.svg.
Drafted with Claude Code under Jacky Yao's direction.

Blender axes: metres, Z up, the Smiler faces -Y. Everything is generated here (geometry, textures, rig, weights,
clips); there is no .blend source.
"""
import json
import math
import pathlib
import struct
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import common  # noqa: E402

ARGS = common.args_after_dashdash()
SEED = 5150

# ----------------------------------------------------------------------------------------------------------------
# Dimensions (art bible 4.2, blueprint smiler.svg, contract hitboxes: head 1.605-2.155, body 0.175-1.605)
# ----------------------------------------------------------------------------------------------------------------
FACE_Z = 1.95                      # face centre
EYE_Z, EYE_X, EYE_R = 2.03, 0.10, 0.045   # eye centres 20 cm apart, diameter 9 cm
GRIN_HW = 0.275                    # grin 0.55 m wide (front view)
UPPER_C, UPPER_K = 1.900, 0.045    # upper inner lip: z = UPPER_C + UPPER_K * t^2, t = u / GRIN_HW
LOWER_C = 1.820                    # lower inner lip centre; both lips meet at the corners
LOWER_K = UPPER_C + UPPER_K - LOWER_C
Y_GRIN = -0.28                     # depth of the grin surface at the centre line
Y_EYE = Y_GRIN + 0.05              # eyes sit 5 cm behind the grin
ARC_R = 0.30                       # the face wraps round a parabola y = base + u^2 / (2 ARC_R)
Z_BOT, Z_TOP = 0.36, 2.15          # body column extent (tendril tips reach down to HOVER)
HOVER = 0.20
JS_CAM_POS = Vector((0.0, Y_GRIN - 0.55, FACE_Z))   # 0.55 m in front of the grin at face height
ARM_LENS = (0.46, 0.44, 0.40, 0.30)         # four segments, 1.6 m
BOB = 0.06                         # hover_idle: +-6 cm, 0.12 m of travel over 3 s

TEAR_CUTS = (1.75, 1.80, 1.845, 1.878, 1.912, 1.95, 1.998, 2.022, 2.05)
TEAR_SHIFT = (0.0, 0.035, -0.05, 0.07, -0.03, 0.055, -0.08, 0.03, -0.045, 0.0)

CORE = ('core_01', 'core_02', 'core_03', 'face_root')
CORE_Z = {'core_01': (0.70, 1.10), 'core_02': (1.10, 1.48), 'core_03': (1.48, 1.68), 'face_root': (1.68, 2.13)}


def smoothstep(e0, e1, x):
    t = np.clip((np.asarray(x, dtype=float) - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def sstep(e0, e1, x):
    return float(smoothstep(e0, e1, x))


def pchip(xs, ys, x):
    """Monotone cubic interpolation (Fritsch-Carlson), scalar x."""
    xs, ys = np.asarray(xs, float), np.asarray(ys, float)
    h, d = np.diff(xs), np.diff(ys) / np.diff(xs)
    m = np.zeros_like(ys)
    m[0], m[-1] = d[0], d[-1]
    for k in range(1, len(xs) - 1):
        if d[k - 1] * d[k] > 0:
            w1, w2 = 2 * h[k] + h[k - 1], h[k] + 2 * h[k - 1]
            m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k])
    i = int(np.clip(np.searchsorted(xs, x) - 1, 0, len(xs) - 2))
    t = (x - xs[i]) / h[i]
    return ((2 * t ** 3 - 3 * t ** 2 + 1) * ys[i] + (t ** 3 - 2 * t ** 2 + t) * h[i] * m[i]
            + (-2 * t ** 3 + 3 * t ** 2) * ys[i + 1] + (t ** 3 - t ** 2) * h[i] * m[i + 1])


def norm_top4(w):
    items = sorted(((k, v) for k, v in w.items() if v > 1e-4), key=lambda kv: -kv[1])[:4]
    s = sum(v for _, v in items)
    return {k: v / s for k, v in items}


# ----------------------------------------------------------------------------------------------------------------
# Face surface: design coordinates (u lateral = front-view x, v height = z, w depth behind the face surface)
# ----------------------------------------------------------------------------------------------------------------
def face_map(u, v, w, base):
    slope = u / ARC_R
    s = math.sqrt(1 + slope * slope)
    return Vector((u - w * slope / s, base + u * u / (2 * ARC_R) + w / s, v))


def upper_edge(t):
    return UPPER_C + UPPER_K * t * t


def lower_edge(t):
    return LOWER_C + LOWER_K * t * t


def face_surface_y(x, z, gap_mouth=0.035, gap_eyes=0.012):
    """Depth of the head surface just behind the face (grin at mouth height, eyes above)."""
    k = sstep(1.95, 2.0, z)
    base = Y_GRIN + (Y_EYE - Y_GRIN) * k
    return base + x * x / (2 * ARC_R) + gap_mouth + (gap_eyes - gap_mouth) * k


# ----------------------------------------------------------------------------------------------------------------
# Mesh building helpers
# ----------------------------------------------------------------------------------------------------------------
class Builder:
    def __init__(self):
        self.co, self.w, self.attr = [], [], []
        self.faces, self.uvs, self.ref = [], [], []

    def v(self, co, w, **attr):
        self.co.append(Vector(co))
        self.w.append(norm_top4(w))
        self.attr.append(attr)
        return len(self.co) - 1

    def f(self, idx, uv, ref=None):
        """ref: a point the face should face away from (outward test), or a direction vector tagged ('dir', vec)."""
        self.faces.append(list(idx))
        self.uvs.append(list(uv))
        self.ref.append(ref)


def tube(b, pts, radii, sides, weights_fn, uv_u0, uv_du, uv_v, close_tip=False):
    """Tapered tube along a polyline. weights_fn(i) -> weight dict for ring i; uv_v(i) -> v coordinate."""
    pts = [Vector(p) for p in pts]
    n = len(pts)
    tang = []
    for i in range(n):
        a = pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]
        tang.append(a.normalized())
    # parallel-transported frame
    t0 = tang[0]
    helper = Vector((0, 0, 1)) if abs(t0.z) < 0.9 else Vector((1, 0, 0))
    N = (helper - t0 * helper.dot(t0)).normalized()
    rings = []
    for i in range(n):
        if i > 0:
            q = tang[i - 1].rotation_difference(tang[i])
            N = q @ N
            N = (N - tang[i] * N.dot(tang[i])).normalized()
        B = tang[i].cross(N)
        r = float(radii[i])
        ring = []
        for j in range(sides):
            a = 2 * math.pi * j / sides
            ring.append(b.v(pts[i] + r * (math.cos(a) * N + math.sin(a) * B), weights_fn(i)))
        rings.append(ring)
    for i in range(n - 1):
        for j in range(sides):
            j2 = (j + 1) % sides
            u0, u1 = uv_u0 + uv_du * j / sides, uv_u0 + uv_du * (j + 1) / sides
            b.f((rings[i][j], rings[i][j2], rings[i + 1][j2], rings[i + 1][j]),
                ((u0, uv_v(i)), (u1, uv_v(i)), (u1, uv_v(i + 1)), (u0, uv_v(i + 1))),
                ref=(pts[i] + pts[i + 1]) * 0.5)
    if close_tip:
        tip = b.v(pts[-1] + tang[-1] * float(radii[-1]) * 2.5, weights_fn(n - 1))
        for j in range(sides):
            j2 = (j + 1) % sides
            u0, u1 = uv_u0 + uv_du * j / sides, uv_u0 + uv_du * (j + 1) / sides
            b.f((rings[-1][j], rings[-1][j2], tip), ((u0, uv_v(n - 1)), (u1, uv_v(n - 1)), (u0, uv_v(n - 1))),
                ref=pts[-1])
    return rings


def make_object(name, b, groups, float_attrs=()):
    me = bpy.data.meshes.new(name)
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    for g in groups:
        obj.vertex_groups.new(name=g)
    gi = {g: i for i, g in enumerate(groups)}
    bm = bmesh.new()
    dl = bm.verts.layers.deform.verify()
    fl = {a: bm.verts.layers.float.new(a) for a in float_attrs}
    verts = []
    for co, w, at in zip(b.co, b.w, b.attr):
        v = bm.verts.new(co)
        for g, x in w.items():
            v[dl][gi[g]] = x
        for a in float_attrs:
            v[fl[a]] = float(at.get(a, 0.0))
        verts.append(v)
    uvl = bm.loops.layers.uv.new('UVMap')
    flipped = 0
    for idx, uv, ref in zip(b.faces, b.uvs, b.ref):
        face = bm.faces.new([verts[i] for i in idx])
        for loop, t in zip(face.loops, uv):
            loop[uvl].uv = t
        face.normal_update()
        if ref is not None:
            if isinstance(ref, tuple) and ref[0] == 'dir':
                want = ref[1]
            else:
                want = face.calc_center_median() - ref
            if face.normal.dot(want) < 0:
                face.normal_flip()
                flipped += 1
    return obj, bm, fl, flipped


def finish_mesh(obj, bm):
    bm.to_mesh(obj.data)
    bm.free()
    me = obj.data
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    me.update()


# ----------------------------------------------------------------------------------------------------------------
# Rig
# ----------------------------------------------------------------------------------------------------------------
TENDRIL_TIPS = (0.20, 0.25, 0.21, 0.29, 0.22, 0.26)   # the lowest tip is the 0.2 m hover height


def tendril_curve(k):
    """Centre line p(s), s = 0 (root, inside the lower body) .. 1 (tip)."""
    rng = np.random.default_rng(SEED + 11 * k)
    theta = math.radians(30 + 60 * k + rng.uniform(-8, 8))
    ph, ph2 = rng.uniform(0, 2 * math.pi), rng.uniform(0, 2 * math.pi)
    amp = rng.uniform(0.45, 0.65)
    z0, z1 = 0.98, TENDRIL_TIPS[k] + 0.0125           # + the length of the tip cone

    def p(s):
        r = 0.06 + 0.22 * s ** 1.1 + 0.035 * s * math.sin(2 * math.pi * 1.4 * s + ph2)
        phi = theta + amp * s * math.sin(2 * math.pi * 1.2 * s + ph)
        return Vector((r * math.cos(phi), 0.045 + r * math.sin(phi), z0 - (z0 - z1) * s))
    return theta, p


def arm_joints(side):
    """Rest (folded behind the back) joint positions for one arm. side +1 = left (+X), -1 = right."""
    s = side
    S = Vector((0.25 * s, 0.06, 1.50))
    dirs = [Vector((0.25 * s, 0.40, -0.88)), Vector((-0.05 * s, 0.25, -0.97)),
            Vector((-0.85 * s, 0.05 if s > 0 else 0.20, 0.25 if s > 0 else 0.12)),
            Vector((-0.45 * s, -0.05, -0.89))]
    pts = [S]
    for d, ln in zip(dirs, ARM_LENS):
        pts.append(pts[-1] + d.normalized() * ln)
    return pts


def build_rig():
    arm = bpy.data.armatures.new('smiler_rig')
    rig = bpy.data.objects.new('smiler_rig', arm)
    bpy.context.scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.edit_bones

    def bone(name, head, tail, parent=None):
        x = eb.new(name)
        x.head, x.tail = Vector(head), Vector(tail)
        x.roll = 0.0
        if parent:
            x.parent = eb[parent]
        x.use_connect = False
        x.use_deform = True
        return x

    bone('root', (0, 0, 0), (0, 0, 0.25))
    bone('core_01', (0, 0.03, 0.70), (0, 0.02, 1.10), 'root')
    bone('core_02', (0, 0.02, 1.10), (0, 0.0, 1.48), 'core_01')
    bone('core_03', (0, 0.0, 1.48), (0, -0.01, 1.68), 'core_02')
    bone('face_root', (0, -0.01, 1.68), (0, -0.01, 2.13), 'core_03')
    for side, nm in ((1, 'L'), (-1, 'R')):
        c = face_map(EYE_X * side, EYE_Z, 0.0, Y_EYE)
        bone(f'eye_{nm}', c, c + Vector((0, -0.04, 0)), 'face_root')
    bone('grin_upper', (0, -0.05, 1.95), (0, -0.30, 1.93), 'face_root')
    bone('grin_lower', (0, -0.05, 1.93), (0, -0.30, 1.80), 'face_root')
    for side, nm in ((1, 'L'), (-1, 'R')):
        pts = arm_joints(side)
        bone(f'shoulder_{nm}', (0.07 * side, 0.04, 1.46), pts[0], 'core_02')
        parent = f'shoulder_{nm}'
        for i in range(4):
            bone(f'arm_{nm}_{i + 1:02d}', pts[i], pts[i + 1], parent)
            parent = f'arm_{nm}_{i + 1:02d}'
    for k in range(6):
        _, p = tendril_curve(k)
        bone(f'wisp_{k + 1:02d}_01', p(0.10), p(0.55), 'core_01')
        bone(f'wisp_{k + 1:02d}_02', p(0.55), p(1.0), f'wisp_{k + 1:02d}_01')
    bpy.ops.object.mode_set(mode='OBJECT')
    order = []

    def walk(bn):
        order.append(bn.name)
        for c in bn.children:
            walk(c)
    walk(arm.bones['root'])
    return rig, order


# ----------------------------------------------------------------------------------------------------------------
# Body: hooded void column + six tendrils + two four-segment arms
# ----------------------------------------------------------------------------------------------------------------
# Column cross-section below the head dome: half-width a, half-depth b, centre y (blueprint: tapers to the bottom)
PROFILE_Z = (0.36, 0.40, 0.48, 0.60, 0.75, 0.95, 1.15, 1.32, 1.45, 1.53, 1.59, 1.635, 1.68, 1.73, 1.80, 1.88)
PROFILE_A = (0.0, 0.05, 0.085, 0.12, 0.15, 0.185, 0.22, 0.255, 0.28, 0.27, 0.235, 0.20, 0.195, 0.215, 0.24, 0.255)
PROFILE_B = (0.0, 0.045, 0.075, 0.10, 0.125, 0.145, 0.16, 0.175, 0.18, 0.175, 0.165, 0.16, 0.17, 0.195, 0.22, 0.235)
PROFILE_YC = (0.06, 0.06, 0.055, 0.05, 0.045, 0.035, 0.025, 0.015, 0.005, 0.0, -0.005, -0.008, -0.01, -0.015, -0.02,
              -0.02)
DOME_Z = 1.88                       # above this the head is half an ellipsoid up to Z_TOP
UV_COL, UV_TEN, UV_ARM = (0.01, 0.49), (0.51, 0.74), (0.76, 0.99)   # body texture regions (u), v in 0.02..0.98


def uv_v(x):
    return 0.02 + 0.96 * x


def profile(z):
    if z <= DOME_Z:
        return pchip(PROFILE_Z, PROFILE_A, z), pchip(PROFILE_Z, PROFILE_B, z), pchip(PROFILE_Z, PROFILE_YC, z)
    c = math.sqrt(max(0.0, 1 - ((z - DOME_Z) / (Z_TOP - DOME_Z)) ** 2))
    return PROFILE_A[-1] * c, PROFILE_B[-1] * c, PROFILE_YC[-1] + 0.01 * (1 - c)


def column_weights(z):
    w = {}
    for bn in CORE:
        z0, z1 = CORE_Z[bn]
        if bn == 'core_01':
            z0 = -1.0
        if bn == 'face_root':
            z1 = 9.0
        d = max(z0 - z, 0.0, z - z1)
        w[bn] = 1.0 / (d + 0.06) ** 3
    return w


def build_body(groups):
    b = Builder()
    seg = 32
    zs = [float(z) for z in np.linspace(0.40, 1.40, 14)] + [float(z) for z in np.linspace(1.45, 1.70, 6)] \
        + [float(z) for z in np.linspace(1.74, 2.04, 9)] + [2.07, 2.095, 2.115, 2.13, 2.142]
    vz = lambda z: uv_v((z - Z_BOT) / (Z_TOP - Z_BOT))  # noqa: E731
    cu0, cdu = UV_COL[0], UV_COL[1] - UV_COL[0]
    rings = []
    for z in zs:
        a, bb, yc = profile(z)
        ring = []
        for j in range(seg):
            th = math.pi / 2 + 2 * math.pi * j / seg       # j = 0 at the back (+Y): the UV seam
            # smoky wobble on the torso, none on the head
            wob = (0.010 * math.sin(3 * th + 6 * z) + 0.007 * math.sin(5 * th - 4 * z + 1.3)
                   + 0.005 * math.sin(9 * th + 11 * z + 0.4)) * (1 - sstep(1.45, 1.62, z))
            x = (a + wob) * math.cos(th)
            y = yc + (bb + wob) * math.sin(th)
            if y < yc and 1.66 < z < 2.13:
                # the head front becomes a face plate just behind the floating face
                mask = (1 - sstep(0.12, 0.24, abs(x))) * sstep(1.70, 1.76, z) * (1 - sstep(2.03, 2.13, z))
                target = face_surface_y(x, z)
                y = y + mask * (target - y)
                if abs(x) < 0.30 and 1.66 < z < 2.09:
                    # never in front of the teeth roots or the eye rims (the body would dim them)
                    y = max(y, face_surface_y(x, z, 0.022, 0.006))
            ring.append(b.v((x, y, z), column_weights(z)))
        rings.append(ring)
    for i in range(len(zs) - 1):
        for j in range(seg):
            j2 = (j + 1) % seg
            u0, u1 = cu0 + cdu * j / seg, cu0 + cdu * (j + 1) / seg
            zc = 0.5 * (zs[i] + zs[i + 1])
            b.f((rings[i][j], rings[i][j2], rings[i + 1][j2], rings[i + 1][j]),
                ((u0, vz(zs[i])), (u1, vz(zs[i])), (u1, vz(zs[i + 1])), (u0, vz(zs[i + 1]))),
                ref=Vector((0, profile(zc)[2], zc)))
    bot = b.v((0, profile(Z_BOT)[2], Z_BOT), column_weights(Z_BOT))
    top = b.v((0, profile(Z_TOP)[2], Z_TOP), column_weights(Z_TOP))
    for j in range(seg):
        j2 = (j + 1) % seg
        u0, u1 = cu0 + cdu * j / seg, cu0 + cdu * (j + 1) / seg
        b.f((bot, rings[0][j2], rings[0][j]), ((u0, vz(Z_BOT)), (u1, vz(zs[0])), (u0, vz(zs[0]))),
            ref=('dir', Vector((0, 0, -1))))
        b.f((top, rings[-1][j], rings[-1][j2]), ((u0, vz(Z_TOP)), (u0, vz(zs[-1])), (u1, vz(zs[-1]))),
            ref=('dir', Vector((0, 0, 1))))

    # tendrils
    for k in range(6):
        _, p = tendril_curve(k)
        ss = list(np.linspace(0, 1, 15))
        pts = [p(s) for s in ss]
        radii = [0.005 + 0.055 * (1 - s) ** 0.9 for s in ss]
        nm = f'wisp_{k + 1:02d}'

        def wfn(i, ss=ss, nm=nm):
            s = ss[i]
            wc = 1 - sstep(0.0, 0.25, s)
            w2 = sstep(0.40, 0.70, s)
            return {'core_01': wc, f'{nm}_01': max(0.0, 1 - wc - w2), f'{nm}_02': w2}
        tube(b, pts, radii, 7, wfn, UV_TEN[0], UV_TEN[1] - UV_TEN[0], lambda i, ss=ss: uv_v(ss[i]), close_tip=True)

    # arms: folded behind the back, knobbly joints, three needle claws
    for side, nm in ((1, 'L'), (-1, 'R')):
        J = arm_joints(side)
        pts, radii, wts, vv = [], [], [], []
        r_seg = ((0.024, 0.018), (0.018, 0.015), (0.015, 0.012), (0.012, 0.008))
        total = sum(ARM_LENS)
        acc = 0.0
        for i in range(4):
            fr = (0.0, 0.1, 0.5, 0.9) if i == 0 else (0.1, 0.5, 0.9)
            if i > 0:
                pts.append(J[i])
                radii.append(r_seg[i][0] * 1.3)
                wts.append({f'arm_{nm}_{i:02d}': 0.5, f'arm_{nm}_{i + 1:02d}': 0.5})
                vv.append(acc / total)
            for f in fr:
                pts.append(J[i].lerp(J[i + 1], f))
                radii.append(r_seg[i][0] + (r_seg[i][1] - r_seg[i][0]) * f)
                w = {f'arm_{nm}_{i + 1:02d}': 1.0}
                if f == 0.0:
                    w = {f'arm_{nm}_01': 0.6, f'shoulder_{nm}': 0.4}
                elif f == 0.1 and i > 0:
                    w = {f'arm_{nm}_{i + 1:02d}': 0.8, f'arm_{nm}_{i:02d}': 0.2}
                elif f == 0.9 and i < 3:
                    w = {f'arm_{nm}_{i + 1:02d}': 0.8, f'arm_{nm}_{i + 2:02d}': 0.2}
                wts.append(w)
                vv.append((acc + f * ARM_LENS[i]) / total)
            acc += ARM_LENS[i]
        pts.append(J[4])
        radii.append(0.008)
        wts.append({f'arm_{nm}_04': 1.0})
        vv.append(1.0)
        tube(b, pts, radii, 8, lambda i, wts=wts: wts[i], UV_ARM[0], UV_ARM[1] - UV_ARM[0],
             lambda i, vv=vv: uv_v(vv[i]), close_tip=True)
        # claws
        d4 = (J[4] - J[3]).normalized()
        side_ax = d4.cross(Vector((0, 0, 1))).normalized()
        for c, ang in enumerate((-0.45, 0.0, 0.45)):
            dirc = (Quaternion(d4.cross(side_ax).normalized(), ang) @ d4).normalized()
            curl = Quaternion(side_ax, 0.35)
            ln = (0.10, 0.12, 0.10)[c]
            p0 = J[4] - d4 * 0.01
            p1 = p0 + dirc * ln * 0.5
            p2 = p1 + (curl @ dirc) * ln * 0.5
            tube(b, [p0, p1, p2], [0.0055, 0.0035, 0.0012], 5, lambda i, nm=nm: {f'arm_{nm}_04': 1.0},
                 UV_ARM[0], UV_ARM[1] - UV_ARM[0], lambda i: uv_v(1.0), close_tip=True)

    obj, bm, _, flipped = make_object('smiler_body', b, groups)
    finish_mesh(obj, bm)
    return obj, flipped


# ----------------------------------------------------------------------------------------------------------------
# Face: eye discs, crescent lip band, needle teeth, mouth cavity (one mesh, material smiler_glow)
# ----------------------------------------------------------------------------------------------------------------
P_EYE_L, P_EYE_R, P_TEETH_U, P_TEETH_L, P_LIPS, P_CAVITY = range(6)
UV_EYE, UV_TEETH, UV_LIPS, UV_CAVITY = (0.25, 0.75), (0.75, 0.75), (0.25, 0.25), (0.75, 0.25)
FACE_ATTRS = ('du', 'dv', 'dw', 'base', 'part', 'ru', 'rv', 'js')


def build_face(groups):
    b = Builder()
    rng = np.random.default_rng(SEED)
    front = ('dir', Vector((0, -1, 0)))

    def fv(u, v, w, base, part, w8, ru=None, rv=None, js=0.0):
        return b.v(face_map(u, v, w, base), w8, du=u, dv=v, dw=w, base=base, part=part,
                   ru=u if ru is None else ru, rv=v if rv is None else rv, js=js)

    # eyes: slightly domed discs
    for side, part, bn in ((1, P_EYE_L, 'eye_L'), (-1, P_EYE_R, 'eye_R')):
        uc = EYE_X * side
        segs, radii = 24, (0.0, 0.45, 0.8, 1.0)
        rings = []
        for rr in radii:
            ring = []
            for j in range(1 if rr == 0 else segs):
                a = 2 * math.pi * j / segs
                u, v = uc + EYE_R * rr * math.cos(a), EYE_Z + EYE_R * rr * math.sin(a)
                ring.append(fv(u, v, -0.008 * (1 - rr * rr), Y_EYE, part, {bn: 1.0}, ru=uc, rv=EYE_Z))
            rings.append(ring)
        uvp = lambda rr, a: (UV_EYE[0] + 0.23 * rr * math.cos(a), UV_EYE[1] + 0.23 * rr * math.sin(a))  # noqa: E731
        for j in range(segs):
            a0, a1 = 2 * math.pi * j / segs, 2 * math.pi * (j + 1) / segs
            j2 = (j + 1) % segs
            b.f((rings[0][0], rings[1][j], rings[1][j2]), (uvp(0, 0), uvp(radii[1], a0), uvp(radii[1], a1)), front)
            for r in range(1, len(radii) - 1):
                b.f((rings[r][j], rings[r + 1][j], rings[r + 1][j2], rings[r][j2]),
                    (uvp(radii[r], a0), uvp(radii[r + 1], a0), uvp(radii[r + 1], a1), uvp(radii[r], a1)), front)

    # lip band: a crescent ring round the opening, pointed at the corners
    N = 40
    inner, outer, side_js = [], [], []
    for j in range(N + 1):                      # upper edge, left -> right
        t = -1 + 2 * j / N
        inner.append((t * GRIN_HW, upper_edge(t)))
        side_js.append(0.5 if j in (0, N) else 0.0)
    for j in range(N - 1, 0, -1):               # lower edge, right -> left
        t = -1 + 2 * j / N
        inner.append((t * GRIN_HW, lower_edge(t)))
        side_js.append(1.0)
    for i, (u, v) in enumerate(inner):
        t = u / GRIN_HW
        if abs(abs(t) - 1) < 1e-9:
            outer.append((u + math.copysign(0.014, t), v + 0.003))
            continue
        if side_js[i] == 0.0:
            n = Vector((-2 * UPPER_K * t, GRIN_HW)).normalized()
        else:
            n = Vector((2 * LOWER_K * t, -GRIN_HW)).normalized()
        th = 0.0105 * (1 - 0.5 * t * t)
        outer.append((u + n.x * th, v + n.y * th))
    M = len(inner)
    vin = [fv(u, v, 0.0, Y_GRIN, P_LIPS, {'grin_upper': 1 - side_js[i], 'grin_lower': side_js[i]}, js=side_js[i])
           for i, (u, v) in enumerate(inner)]
    vout = [fv(u, v, 0.005, Y_GRIN, P_LIPS, {'grin_upper': 1 - side_js[i], 'grin_lower': side_js[i]}, js=side_js[i])
            for i, (u, v) in enumerate(outer)]
    for i in range(M):
        i2 = (i + 1) % M
        uu0, uu1 = 0.02 + 0.46 * i / M, 0.02 + 0.46 * (i + 1) / M
        b.f((vin[i], vin[i2], vout[i2], vout[i]), ((uu0, 0.05), (uu1, 0.05), (uu1, 0.45), (uu0, 0.45)), front)

    # mouth cavity: a black bowl behind the teeth, spanning upper to lower lip
    cols, rows = 29, 6
    grid = []
    for r in range(rows + 1):
        s = r / rows
        row = []
        for c in range(cols):
            t = -0.97 + 1.94 * c / (cols - 1)
            v = (upper_edge(t) + 0.006) * (1 - s) + (lower_edge(t) - 0.006) * s
            w = 0.010 + 0.022 * math.sin(math.pi * s) * (1 - t * t)
            row.append(fv(t * GRIN_HW, v, w, Y_GRIN, P_CAVITY, {'grin_upper': 1 - s, 'grin_lower': s}, js=s))
        grid.append(row)
    for r in range(rows):
        for c in range(cols - 1):
            b.f((grid[r][c], grid[r + 1][c], grid[r + 1][c + 1], grid[r][c + 1]), [UV_CAVITY] * 4, front)

    # needle teeth: upper row points down, lower row up, interleaved like a closed trap
    lens = []
    n_up = 26
    du = 1.72 / (n_up - 1)
    rows_t = [(P_TEETH_U, 'grin_upper', [-0.86 + du * i for i in range(n_up)]),
              (P_TEETH_L, 'grin_lower', [-0.86 + du * (i + 0.5) for i in range(n_up - 1)])]
    for part, bn, ts in rows_t:
        upper = part == P_TEETH_U
        for t in ts:
            ru = t * GRIN_HW
            rv = upper_edge(t) if upper else lower_edge(t)
            tt = 0.85 * t                       # lean slightly towards the middle of the grin
            target = Vector((tt * GRIN_HW, lower_edge(tt) if upper else upper_edge(tt)))
            d = (target - Vector((ru, rv))).normalized()
            d = (Quaternion((0, 0, 1), rng.uniform(-0.06, 0.06)) @ Vector((d.x, d.y, 0))).to_2d().normalized()
            # longest it may be without crossing the opposite lip by more than 4 mm (hidden under the band)
            lam = 0.0
            while lam < 0.2:
                pu, pv = ru + d.x * lam, rv + d.y * lam
                opp = lower_edge(pu / GRIN_HW) if upper else upper_edge(pu / GRIN_HW)
                if (pv <= opp) if upper else (pv >= opp):
                    break
                lam += 0.001
            L = (0.03 + 0.03 * (1 - abs(t) ** 1.6)) * (1 + rng.uniform(-0.06, 0.06))
            L = min(L, 0.06, lam + 0.004)
            lens.append(L)
            e1 = Vector((-d.y, d.x))
            root_u, root_v = ru - d.x * 0.004, rv - d.y * 0.004
            ring_def = ((0.0, 0.0052), (0.45, 0.0029))
            sides = 6
            ids = []
            for fr, rad in ring_def:
                ring = []
                ln = 0.004 + fr * L
                for j in range(sides):
                    a = 2 * math.pi * j / sides
                    u = root_u + d.x * ln + rad * math.cos(a) * e1.x
                    v = root_v + d.y * ln + rad * math.cos(a) * e1.y
                    w = 0.003 + 0.006 * fr * fr + rad * math.sin(a)
                    ring.append(fv(u, v, w, Y_GRIN, part, {bn: 1.0}, ru=ru, rv=rv, js=0.0 if upper else 1.0))
                ids.append(ring)
            tip = fv(root_u + d.x * (0.004 + L), root_v + d.y * (0.004 + L), 0.009, Y_GRIN, part, {bn: 1.0},
                     ru=ru, rv=rv, js=0.0 if upper else 1.0)
            axis_mid = face_map(root_u + d.x * (0.004 + 0.4 * L), root_v + d.y * (0.004 + 0.4 * L), 0.005, Y_GRIN)
            for j in range(sides):
                j2 = (j + 1) % sides
                b.f((ids[0][j], ids[0][j2], ids[1][j2], ids[1][j]),
                    ((0.75, 0.52), (0.76, 0.52), (0.76, 0.75), (0.75, 0.75)), ref=axis_mid)
                b.f((ids[1][j], ids[1][j2], tip), ((0.75, 0.75), (0.76, 0.75), (0.755, 0.98)), ref=axis_mid)

    obj, bm, fl, flipped = make_object('smiler_face', b, groups, FACE_ATTRS)
    # cut the face into horizontal slices so face_tear can offset them cleanly (videotape tear)
    for zc in TEAR_CUTS:
        r = bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-7,
                                   plane_co=(0, 0, zc), plane_no=(0, 0, 1))
        cut = [e for e in r['geom_cut'] if isinstance(e, bmesh.types.BMEdge)]
        bmesh.ops.split_edges(bm, edges=cut)
    bm.verts.ensure_lookup_table()
    bm.verts.index_update()
    # per-vertex data for the shape keys
    cuts = np.array(TEAR_CUTS)
    data = []
    bad = 0
    for v in bm.verts:
        bands = {int(np.searchsorted(cuts, f.calc_center_median().z)) for f in v.link_faces}
        if len(bands) > 1:
            bad += 1
        band = min(bands) if bands else int(np.searchsorted(cuts, v.co.z))
        data.append(dict(co=v.co.copy(), band=band, **{a: v[fl[a]] for a in FACE_ATTRS}))
    finish_mesh(obj, bm)
    for a in FACE_ATTRS:
        if a in obj.data.attributes:
            obj.data.attributes.remove(obj.data.attributes[a])
    add_face_keys(obj, data)
    return obj, flipped, lens, bad, data


def jaw(u, js):
    prof = max(0.0, 1 - (u / GRIN_HW) ** 2) ** 0.55
    return prof * (0.03 * (1 - js) - 0.13 * js)


def add_face_keys(obj, data):
    obj.shape_key_add(name='Basis', from_mix=False)
    mouth = (P_TEETH_U, P_TEETH_L, P_LIPS, P_CAVITY)

    def key(name, fn):
        sk = obj.shape_key_add(name=name, from_mix=False)
        co = []
        for d in data:
            u, v, w = fn(d)
            delta = face_map(u, v, w, d['base']) - face_map(d['du'], d['dv'], d['dw'], d['base'])
            co.extend(d['co'] + delta)
        sk.data.foreach_set('co', co)
        sk.value = 0.0
        return sk

    def wide(d):
        if int(round(d['part'])) not in mouth:
            return d['du'], d['dv'], d['dw']
        ru2 = 1.5 * d['ru']
        rv2 = d['rv'] + 0.02 * (d['ru'] / GRIN_HW) ** 2
        return d['du'] + ru2 - d['ru'], d['dv'] + rv2 - d['rv'], d['dw']

    def open_(d):
        if int(round(d['part'])) not in mouth:
            return d['du'], d['dv'], d['dw']
        return d['du'], d['dv'] + jaw(d['ru'], d['js']), d['dw']

    def narrow(d):
        if int(round(d['part'])) not in (P_EYE_L, P_EYE_R):
            return d['du'], d['dv'], d['dw']
        x = (d['du'] - d['ru']) / EYE_R
        return d['du'], EYE_Z + (d['dv'] - EYE_Z) * 0.3 + 0.006 * (1 - x * x), d['dw']

    def collapse(d):
        w = d['dw'] + (0.012 if int(round(d['part'])) == P_CAVITY else 0.0)
        return d['du'] * 1.04, FACE_Z + (d['dv'] - FACE_Z) * 0.03, w

    key('grin_wide', wide)
    key('grin_open', open_)
    key('eyes_narrow', narrow)
    sk = obj.shape_key_add(name='face_tear', from_mix=False)
    co = []
    for d in data:
        co.extend(d['co'] + Vector((TEAR_SHIFT[d['band']], 0, 0)))
    sk.data.foreach_set('co', co)
    key('face_collapse', collapse)


# ----------------------------------------------------------------------------------------------------------------
# Materials and generated textures
# ----------------------------------------------------------------------------------------------------------------
def body_textures(n=512):
    rng = np.random.default_rng(SEED + 1)
    u = (np.arange(n) + 0.5) / n
    v = 1 - (np.arange(n) + 0.5) / n                  # row 0 = top of the image
    U, V = np.meshgrid(u, v)
    # region-local coordinates (each region wraps round its own surface, so it must tile in u on its own)
    regions = (UV_COL, UV_TEN, UV_ARM)
    rid = np.digitize(U, [0.5, 0.75])
    u0 = np.choose(rid, [r[0] for r in regions])
    du = np.choose(rid, [r[1] - r[0] for r in regions])
    lu = np.clip((U - u0) / du, 0, 1)
    lv = np.clip((V - 0.02) / 0.96, 0, 1)
    waves = [(2, 1.5), (3, 2.5), (5, 1.0), (6, 4.5), (8, 2.0), (3, 6.5), (10, 3.5), (2, 5.5), (12, 7.5), (5, 9.5)]
    h = np.zeros_like(U)
    gu = np.zeros_like(U)
    gv = np.zeros_like(U)
    for i, (ku, kv) in enumerate(waves):
        amp = 1.0 / (1 + 0.35 * i)
        ph = rng.uniform(0, 2 * math.pi)
        arg = 2 * math.pi * (ku * lu + kv * lv) + ph + 0.8 * np.sin(2 * math.pi * (2 * lu - lv) + i)
        swirl_u = 0.8 * np.cos(2 * math.pi * (2 * lu - lv) + i) * 2 * math.pi * 2
        swirl_v = -0.8 * np.cos(2 * math.pi * (2 * lu - lv) + i) * 2 * math.pi
        h += amp * np.sin(arg)
        gu += amp * np.cos(arg) * (2 * math.pi * ku + swirl_u) / du
        gv += amp * np.cos(arg) * (2 * math.pi * kv + swirl_v) / 0.96
    h /= np.abs(h).max()
    # base colour #030305 with alpha: 0.85, fading out at the bottom of the column and along the tendrils
    rgba = np.zeros((n, n, 4))
    rgba[..., 0] = rgba[..., 1] = 3 / 255
    rgba[..., 2] = 5 / 255
    alpha = np.full((n, n), 0.85)
    z = Z_BOT + lv * (Z_TOP - Z_BOT)
    col = rid == 0
    alpha[col] = (0.85 * smoothstep(0.45, 1.02, z + 0.08 * h))[col]
    ten = rid == 1
    fade = (1 - smoothstep(0.30, 1.0, lv + 0.12 * h)) ** 1.3
    alpha[ten] = (0.85 * fade)[ten]
    rgba[..., 3] = np.clip(alpha, 0, 1)
    # normal map: slow smoke swirls
    g = np.stack([gu, gv], -1)
    g = g / np.abs(g).max() * 0.45
    nrm = np.stack([-g[..., 0], -g[..., 1], np.ones_like(U)], -1)
    nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True)
    nmap = np.concatenate([nrm * 0.5 + 0.5, np.ones((n, n, 1))], -1)
    return common.image_from_array('smiler_void_color', rgba), common.image_from_array('smiler_void_normal', nmap)


def face_texture(n=256):
    u = (np.arange(n) + 0.5) / n
    v = 1 - (np.arange(n) + 0.5) / n
    U, V = np.meshgrid(u, v)
    val = np.zeros((n, n))
    eye = (U < 0.5) & (V >= 0.5)
    r = np.hypot(U - UV_EYE[0], V - UV_EYE[1]) / 0.23
    val[eye] = (1.0 - 0.2 * smoothstep(0.7, 1.0, r))[eye]
    teeth = (U >= 0.5) & (V >= 0.5)
    val[teeth] = (0.72 + 0.28 * smoothstep(0.52, 0.95, V))[teeth]
    lips = (U < 0.5) & (V < 0.5)
    val[lips] = (0.02 + 0.16 * (1 - smoothstep(0.05, 0.45, V)) ** 1.5)[lips]
    rgba = np.ones((n, n, 4))
    rgba[..., 0] = rgba[..., 1] = rgba[..., 2] = val
    return common.image_from_array('smiler_glow_atlas', rgba)


def build_materials():
    col, nrm = body_textures()
    void = common.material('smiler_void', color=(1, 1, 1), roughness=0.62, alpha=0.85, base_image=col,
                           normal_image=nrm, normal_strength=0.6)
    nodes, links = void.node_tree.nodes, void.node_tree.links
    tex = next(nd for nd in nodes if nd.type == 'TEX_IMAGE' and nd.image == col)
    links.new(tex.outputs['Alpha'], nodes['Principled BSDF'].inputs['Alpha'])
    void.use_backface_culling = True
    atlas = face_texture()
    glow = common.material('smiler_glow', color=(1, 1, 1), roughness=1.0, emission=(1, 1, 1), emission_strength=1.0,
                           base_image=atlas)
    nodes, links = glow.node_tree.nodes, glow.node_tree.links
    tex = next(nd for nd in nodes if nd.type == 'TEX_IMAGE')
    links.new(tex.outputs['Color'], nodes['Principled BSDF'].inputs['Emission Color'])
    glow.use_backface_culling = True
    return void, glow


# ----------------------------------------------------------------------------------------------------------------
# Posing: own forward kinematics in armature space, written to pose bones as keyframes
# ----------------------------------------------------------------------------------------------------------------
class Poser:
    def __init__(self, rig, order):
        self.rig, self.order = rig, order
        self.rest = {b.name: b.matrix_local.copy() for b in rig.data.bones}
        self.parent = {b.name: (b.parent.name if b.parent else None) for b in rig.data.bones}
        self.rest_dir = {n: (m.to_3x3() @ Vector((0, 1, 0))).normalized() for n, m in self.rest.items()}

    def solve(self, deltas):
        """deltas[bone]: aim (armature-space direction), rot (Quaternion, armature space, about the bone head),
        loc (armature-space offset), abs_loc, abs_rot (orientation relative to rest), scale (uniform)."""
        P, basis = {}, {}
        for name in self.order:
            rest = self.rest[name]
            par = self.parent[name]
            Q = P[par] @ self.rest[par].inverted() @ rest if par else rest.copy()
            d = deltas.get(name, {})
            Q3 = Q.to_3x3()
            sq = Q3.to_scale().x
            R = Matrix.Identity(3)
            if 'aim' in d:
                cur = (Q3 @ Vector((0, 1, 0))).normalized()
                R = cur.rotation_difference(Vector(d['aim']).normalized()).to_matrix()
            if 'rot' in d:
                R = d['rot'].to_matrix() @ R
            M3 = R @ Q3
            if 'abs_rot' in d:
                M3 = d['abs_rot'].to_matrix() @ rest.to_3x3() * sq
            sc = d.get('scale', 1.0)
            M3 = M3 * sc if isinstance(sc, (int, float)) else M3 @ Matrix.Diagonal(Vector(sc))  # bone-local axes
            pos = Vector(d['abs_loc']) if 'abs_loc' in d else Q.translation + Vector(d.get('loc', (0, 0, 0)))
            M = Matrix.Translation(pos) @ M3.to_4x4()
            P[name] = M
            basis[name] = Q.inverted() @ M
        return basis, P

    def action(self, name, frames, pose_fn):
        rig = self.rig
        act = bpy.data.actions.new(name)
        act.use_fake_user = True
        rig.animation_data.action = act
        prev = {}
        for f in range(frames + 1):
            basis, _ = self.solve(pose_fn(f, frames))
            for bn in self.order:
                pb = rig.pose.bones[bn]
                loc, q, sc = basis[bn].decompose()
                if bn in prev and prev[bn].dot(q) < 0:
                    q.negate()
                prev[bn] = q.copy()
                pb.location, pb.rotation_quaternion, pb.scale = loc, q, sc
                for path in ('location', 'rotation_quaternion', 'scale'):
                    pb.keyframe_insert(path, frame=f, group=bn)
        for fc in act.fcurves:
            for kp in fc.keyframe_points:
                kp.interpolation = 'LINEAR'
        act.use_frame_range = True
        act.frame_start, act.frame_end = 0, frames
        return act


def slerp_dirs(A, B, t):
    out = []
    for a, b in zip(A, B):
        q = a.rotation_difference(b)
        out.append((Quaternion().slerp(q, t) @ a).normalized())
    return out


def mirror(dirs):
    return [Vector((-d.x, d.y, d.z)) for d in dirs]


def fabrik(p0, hint, target, iters=60):
    pts = [Vector(p0)]
    for d, ln in zip(hint, ARM_LENS):
        pts.append(pts[-1] + Vector(d).normalized() * ln)
    target = Vector(target)
    for _ in range(iters):
        pts[-1] = target.copy()
        for i in range(3, -1, -1):
            pts[i] = pts[i + 1] + (pts[i] - pts[i + 1]).normalized() * ARM_LENS[i]
        pts[0] = Vector(p0)
        for i in range(4):
            pts[i + 1] = pts[i] + (pts[i + 1] - pts[i]).normalized() * ARM_LENS[i]
    return [(pts[i + 1] - pts[i]).normalized() for i in range(4)]


def ease(t):
    t = min(max(t, 0.0), 1.0)
    return t * t * (3 - 2 * t)


def build_clips(rig, order):
    po = Poser(rig, order)
    rig.animation_data_create()
    X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
    arm = {s: [po.rest_dir[f'arm_{s}_{i:02d}'] for i in range(1, 5)] for s in 'LR'}
    shoulder = Vector(arm_joints(1)[0])
    UNFOLD = [Vector(d).normalized() for d in ((0.70, 0.30, -0.65), (0.75, 0.05, -0.66), (0.55, -0.45, -0.70),
                                                 (0.25, -0.70, -0.67))]
    SPREAD = [Vector(d).normalized() for d in ((0.80, -0.05, 0.60), (0.80, -0.50, 0.33), (0.30, -0.93, 0.20),
                                                 (-0.25, -0.95, 0.0))]
    STRIKE = fabrik(shoulder, [(0.55, -0.75, 0.2), (0.35, -0.93, 0.0), (-0.15, -0.98, -0.05), (-0.55, -0.83, -0.05)],
                    (0.07, -1.10, 1.30))   # plus the lunge lean: claws 1.2 m in front
    JSPOSE = fabrik(shoulder, SPREAD, (0.40, -0.95, 1.92))
    poses = {'REST': arm['L'], 'UNFOLD': UNFOLD, 'SPREAD': SPREAD, 'STRIKE': STRIKE, 'JS': JSPOSE}

    def arm_pose(dl, key_a, key_b, t):
        """Blend both arms between two named poses (left side given; right side mirrored)."""
        for s in 'LR':
            A = poses[key_a] if s == 'L' else (arm['R'] if key_a == 'REST' else mirror(poses[key_a]))
            B = poses[key_b] if s == 'L' else (arm['R'] if key_b == 'REST' else mirror(poses[key_b]))
            for i, d in enumerate(slerp_dirs(A, B, t)):
                dl.setdefault(f'arm_{s}_{i + 1:02d}', {})['aim'] = d

    def arm_path(dl, keys, t):
        """Piecewise blend through a list of poses, t in 0..1."""
        n = len(keys) - 1
        x = min(max(t, 0.0), 1.0) * n
        i = min(int(x), n - 1)
        arm_pose(dl, keys[i], keys[i + 1], ease(x - i))

    wisp_axes = []
    for k in range(6):
        th, _ = tendril_curve(k)
        radial = Vector((math.cos(th), math.sin(th), 0))
        wisp_axes.append((radial, Z.cross(radial).normalized()))

    def wisps(dl, ph, amp, trail=0.0, flare=0.0):
        """ph: phase in radians (2 pi per cycle); trail tips backwards; flare swings them outwards."""
        for k, (radial, tang) in enumerate(wisp_axes):
            a1 = amp * math.sin(ph + 1.1 * k)
            b1 = 0.6 * amp * math.sin(ph + 1.1 * k + 1.7)
            q1 = Quaternion(tang, a1 + flare) @ Quaternion(radial, b1) @ Quaternion(X, trail)
            q2 = Quaternion(tang, 1.5 * amp * math.sin(ph + 1.1 * k - 1.2)) @ \
                Quaternion(radial, 0.9 * amp * math.sin(ph + 1.1 * k + 0.5)) @ Quaternion(X, 0.6 * trail)
            dl[f'wisp_{k + 1:02d}_01'] = {'rot': q1}
            dl[f'wisp_{k + 1:02d}_02'] = {'rot': q2}

    def rot(dl, bone, axis, ang):
        q = Quaternion(axis, ang)
        if 'rot' in dl.get(bone, {}):
            q = q @ dl[bone]['rot']
        dl.setdefault(bone, {})['rot'] = q

    def jitter_table(n, seed):
        r = np.random.default_rng(seed)
        return [(r.uniform(-1, 1), r.uniform(-1, 1), r.uniform(-1, 1)) for _ in range(n)]

    rest_face = po.rest['face_root'].translation.copy()
    rest_core1 = po.rest['core_01'].translation.copy()

    def hover_idle(f, n):
        p = 2 * math.pi * f / n
        dl = {'core_01': {'loc': (0, 0, BOB * math.sin(p))}}
        rot(dl, 'core_02', Y, 0.025 * math.sin(p + 0.6))
        rot(dl, 'face_root', Y, 0.05 * math.sin(p + 1.3))
        rot(dl, 'face_root', X, 0.02 * math.sin(2 * p))
        wisps(dl, 2 * p, 0.10)
        for s, sg in (('L', 1), ('R', -1)):
            rot(dl, f'arm_{s}_01', Y, sg * 0.03 * math.sin(p))
        return dl

    def glide(f, n):
        p = 2 * math.pi * f / n
        dl = {'core_01': {'loc': (0, 0, 0.02 * math.sin(2 * p))}}
        rot(dl, 'core_01', X, 0.05)
        rot(dl, 'core_02', X, 0.05)
        rot(dl, 'core_01', Y, 0.04 * math.sin(p))
        rot(dl, 'face_root', Y, -0.05 * math.sin(p))
        rot(dl, 'face_root', X, -0.06)
        wisps(dl, 2 * p, 0.12, trail=0.22)
        for s in 'LR':
            rot(dl, f'arm_{s}_01', X, 0.06 + 0.02 * math.sin(2 * p))
        return dl

    def glide_hunt(f, n):
        p = 2 * math.pi * f / n
        dl = {'core_01': {'loc': (0, 0, 0.015 * math.sin(3 * p))}}
        rot(dl, 'core_01', X, 0.07)
        rot(dl, 'core_02', X, 0.07)
        rot(dl, 'core_03', X, 0.04)
        rot(dl, 'core_01', Y, 0.03 * math.sin(p))
        rot(dl, 'face_root', X, -0.12)
        dl['face_root']['loc'] = (0, -0.05, 0)
        wisps(dl, 3 * p, 0.14, trail=0.42)
        arm_pose(dl, 'REST', 'UNFOLD', 0.12 + 0.04 * math.sin(3 * p))
        return dl

    def notice(f, n):
        t = f / n
        snap = math.sin(math.pi * min(t / 0.35, 1.0)) if t < 0.35 else 0.0
        dl = {}
        rot(dl, 'face_root', X, -0.10 * snap - 0.03 * ease(t / 0.35))
        dl['face_root']['loc'] = (0, -0.03 * ease(t / 0.3), 0.01 * snap)
        rot(dl, 'core_02', X, 0.03 * snap)
        sc = 1 + 0.30 * snap if t < 0.35 else 1.12 + 0.18 * (1 - ease((t - 0.35) / 0.65))
        for s in 'LR':
            dl[f'eye_{s}'] = {'scale': sc}
        wisps(dl, 2 * math.pi * t, 0.08, flare=0.2 * snap + 0.05)
        return dl

    jit = jitter_table(8, SEED + 7)

    def lit_recoil(f, n):
        p = 2 * math.pi * f / n
        jx, jr, jp = jit[(f // 3) % 8]
        dl = {}
        rot(dl, 'core_01', X, -0.06)
        rot(dl, 'core_02', X, -0.14 + 0.02 * math.sin(2 * p))
        rot(dl, 'core_03', X, -0.08)
        rot(dl, 'face_root', X, -0.16 + 0.08 * jp)
        rot(dl, 'face_root', Y, 0.12 * jr)
        dl['face_root']['loc'] = (0.035 * jx, 0.02, 0)
        wisps(dl, 4 * p, 0.18, trail=-0.25)
        arm_pose(dl, 'REST', 'UNFOLD', 0.35 + 0.1 * jp)
        return dl

    jit_b = jitter_table(12, SEED + 9)

    def banish(f, n):
        dl = {}
        if f < 8:
            jx, jr, jp = jit_b[f // 2]
            k = 0.5 + f / 8
            rot(dl, 'core_02', X, -0.10 + 0.05 * jp * k)
            rot(dl, 'face_root', Y, 0.15 * jr * k)
            dl['face_root']['loc'] = (0.04 * jx * k, 0, 0)
            wisps(dl, f * 1.3, 0.2 * k, flare=0.3 * k)
            arm_pose(dl, 'REST', 'UNFOLD', 0.4 * k)
        else:
            u = (f - 8) / (n - 8)
            s = 1 - 0.97 * u ** 2
            # the void drains into the head pivot while the head flattens into a line about the face centre
            h = ease((f - 12) / (n - 12)) if f > 12 else 0.0
            squash = (1 + 0.15 * h, 1 - 0.95 * h, 1 - 0.4 * h)        # face_root local x, up, depth
            D = Matrix.Diagonal(Vector(squash))
            r3 = po.rest['face_root'].to_3x3()
            fc = Vector((0, Y_GRIN, FACE_Z))
            pivot = fc - r3 @ D @ r3.inverted() @ (fc - rest_face)    # where the head pivot must go
            dl['core_01'] = {'scale': s, 'loc': tuple(pivot - rest_core1 - s * (rest_face - rest_core1))}
            dl['face_root'] = {'scale': tuple(c / s for c in squash),   # undoes the parent's shrink
                               'abs_loc': pivot}
            wisps(dl, f * 1.3, 0.2, flare=0.3 + 0.5 * u)
            arm_pose(dl, 'REST', 'UNFOLD', 0.6)
        return dl

    def windup(f, n):
        t = f / n
        dl = {}
        rot(dl, 'core_02', X, -0.07 * ease(t))
        rot(dl, 'face_root', X, -0.10 * ease(t))
        dl['face_root']['loc'] = (0, -0.03 * ease(t), 0.01 * ease(t))
        arm_path(dl, ['REST', 'UNFOLD', 'SPREAD'], t)
        wisps(dl, 3 * t, 0.12, flare=0.15 * ease(t))
        return dl

    def strike(f, n):
        t = f / n
        e = t ** 1.6
        dl = {}
        rot(dl, 'core_01', X, 0.06 * e)
        rot(dl, 'core_02', X, -0.07 + 0.22 * e)
        rot(dl, 'face_root', X, -0.10 + 0.12 * e)
        dl['face_root']['loc'] = (0, -0.03 - 0.07 * e, 0.01)
        arm_pose(dl, 'SPREAD', 'STRIKE', e)
        wisps(dl, 3 + 3 * t, 0.12, trail=0.3 * e, flare=0.15 * (1 - e))
        return dl

    def recover(f, n):
        t = f / n
        e = ease(t)
        dl = {}
        rot(dl, 'core_01', X, 0.06 * (1 - e))
        rot(dl, 'core_02', X, 0.15 * (1 - e))
        rot(dl, 'face_root', X, 0.02 * (1 - e))
        dl['face_root']['loc'] = (0, -0.10 * (1 - e), 0.01 * (1 - e))
        arm_path(dl, ['STRIKE', 'UNFOLD', 'REST'], t)
        wisps(dl, 6 + 2 * t, 0.12 * (1 - e) + 0.06, trail=0.3 * (1 - e))
        return dl

    js_jolt = {19: (0.045, 0.06), 20: (0.03, 0.04), 24: (-0.05, -0.07), 25: (-0.035, -0.05)}

    def jumpscare(f, n):
        # art bible 5.3 "Lights Out", relative to the static JS_CAM
        dl = {}
        if f <= 6:
            push, roll = 0.0, 0.10
        elif f <= 15:
            k = ease((f - 6) / 9)
            push, roll = 0.06 * k, 0.10 * (1 - k)
        elif f <= 27:
            k = (f - 15) / 12
            push, roll = 0.06 + 0.14 * k, 0.0
        elif f <= 33:
            k = ((f - 27) / 6) ** 2
            push, roll = 0.20 + 0.23 * k, 0.0
        else:
            push, roll = 0.43 + 0.02 * ((f - 33) / 6), 0.0
        lean = min(push / 0.43, 1.0)
        rot(dl, 'core_02', X, 0.12 * lean)
        rot(dl, 'core_03', X, 0.10 * lean)
        jx, jroll = js_jolt.get(f, (0.0, 0.0))
        shake = 0.004 * math.sin(f * 2.7) if f > 33 else 0.0
        dl['face_root'] = {'abs_loc': rest_face + Vector((jx + shake, -push, 0.0)),
                           'abs_rot': Quaternion(Y, roll + jroll)}
        if f <= 6:
            arm_pose(dl, 'REST', 'REST', 0)
        elif f <= 15:
            arm_pose(dl, 'REST', 'UNFOLD', ease((f - 6) / 9) * 0.6)
        elif f <= 27:
            arm_path(dl, ['REST', 'UNFOLD', 'SPREAD'], 0.3 + 0.7 * (f - 15) / 12)
        else:
            arm_pose(dl, 'SPREAD', 'JS', ease((f - 27) / 6))
        wisps(dl, f * 0.35, 0.08 + 0.10 * lean, trail=0.3 * lean)
        return dl

    clips = [('hover_idle', 90, hover_idle), ('glide', 60, glide), ('glide_hunt', 45, glide_hunt),
             ('notice', 10, notice), ('lit_recoil', 24, lit_recoil), ('banish', 24, banish),
             ('attack_windup', 9, windup), ('attack_strike', 7, strike), ('attack_recover', 15, recover),
             ('jumpscare', 39, jumpscare)]
    checks = {'loop_seam_max': {}}
    for name, frames, fn in clips:
        act = po.action(name, frames, fn)
        if name in ('hover_idle', 'glide', 'glide_hunt', 'lit_recoil'):
            checks['loop_seam_max'][name] = round(max(abs(fc.evaluate(0) - fc.evaluate(frames))
                                                      for fc in act.fcurves), 6)
    # numbers to check against the brief
    _, P = po.solve(strike(7, 7))
    tipL = P['arm_L_04'] @ Vector((0, ARM_LENS[3], 0))
    tipR = P['arm_R_04'] @ Vector((0, ARM_LENS[3], 0))
    checks['strike_tips'] = [[round(c, 3) for c in tipL], [round(c, 3) for c in tipR]]
    _, P = po.solve(jumpscare(39, 39))
    grin_front = P['face_root'] @ (po.rest['face_root'].inverted() @ Vector((0, Y_GRIN, 1.86)))
    checks['jumpscare_end_grin_to_cam'] = round((JS_CAM_POS - grin_front).length, 3)
    _, P = po.solve(jumpscare(0, 39))
    g0 = P['face_root'] @ (po.rest['face_root'].inverted() @ Vector((0, Y_GRIN, 1.86)))
    checks['jumpscare_start_grin_to_cam'] = round((JS_CAM_POS - g0).length, 3)
    return checks


# ----------------------------------------------------------------------------------------------------------------
# Export check: read the written GLB directly
# ----------------------------------------------------------------------------------------------------------------
def glb_summary(path):
    data = path.read_bytes()
    clen = struct.unpack_from('<I', data, 12)[0]
    js = json.loads(data[20:20 + clen])
    acc = js.get('accessors', [])
    out = {'bytes': len(data)}
    out['animations'] = {a['name']: round(max(acc[s['input']]['max'][0] for s in a['samplers']) * common.FPS, 2)
                         for a in js.get('animations', [])}
    out['materials'] = [{k: m.get(k) for k in ('name', 'alphaMode', 'doubleSided')} for m in js.get('materials', [])]
    out['meshes'] = [{'name': m['name'], 'targets': m.get('extras', {}).get('targetNames'),
                      'weights': m.get('weights')} for m in js.get('meshes', [])]
    out['skins'] = [len(s['joints']) for s in js.get('skins', [])]
    out['images'] = []
    bin_off = 20 + clen + 8
    for im in js.get('images', []):
        bv = js['bufferViews'][im['bufferView']]
        start = bin_off + bv.get('byteOffset', 0)
        w, h = struct.unpack_from('>II', data, start + 16)
        out['images'].append({'name': im.get('name'), 'size': [w, h], 'bytes': bv['byteLength']})
    out['cameras'] = len(js.get('cameras', []))
    out['joint_sets'] = sorted({k for m in js.get('meshes', []) for p in m['primitives'] for k in p['attributes']
                                if k.startswith('JOINTS')})
    return out


def hidden_face_verts(body, face_data):
    """Rest pose: how many eye / tooth / lip vertices sit behind the void body when seen from the front."""
    from mathutils.bvhtree import BVHTree
    me = body.data
    tree = BVHTree.FromPolygons([v.co for v in me.vertices], [p.vertices[:] for p in me.polygons])
    names = {P_EYE_L: 'eyes', P_EYE_R: 'eyes', P_TEETH_U: 'teeth', P_TEETH_L: 'teeth', P_LIPS: 'lips'}
    out = {'eyes': 0, 'teeth': 0, 'lips': 0}
    for d in face_data:
        part = int(round(d['part']))
        if part in names and tree.ray_cast(d['co'], Vector((0, -1, 0)), 2.0)[0] is not None:
            out[names[part]] += 1
    return out


def main():
    scene = common.reset_scene()
    rig, order = build_rig()
    groups = [b.name for b in rig.data.bones]
    void, glow = build_materials()
    body, flipped_body = build_body(groups)
    face, flipped_face, tooth_lens, bad_bands, face_data = build_face(groups)
    common.assign(body, void)
    common.assign(face, glow)
    for o in (body, face):
        o.parent = rig
        md = o.modifiers.new('Armature', 'ARMATURE')
        md.object = rig
    # sockets
    common.empty('HIT_head', (0, 0, (1.605 + 2.155) / 2), parent=rig, parent_bone='face_root')
    common.empty('HIT_body', (0, 0, (0.175 + 1.605) / 2), parent=rig, parent_bone='core_01')
    common.empty('SOCKET_eyes', face_map(0, EYE_Z, 0, Y_EYE), parent=rig, parent_bone='face_root')
    common.empty('SOCKET_mouth', face_map(0, (UPPER_C + LOWER_C) / 2, 0, Y_GRIN), parent=rig, parent_bone='face_root')
    common.empty('JS_CAM', JS_CAM_POS, parent=rig)

    checks = build_clips(rig, order)
    rig.animation_data.action = None
    for pb in rig.pose.bones:
        pb.location, pb.rotation_quaternion, pb.scale = (0, 0, 0), (1, 0, 0, 0), (1, 1, 1)
    scene.frame_set(0)
    bpy.context.view_layer.update()

    tris = {o.name: common.triangle_count([o]) for o in (body, face)}
    zs = [v.co.z for v in body.data.vertices]
    head = [v.co for v in body.data.vertices if v.co.z > 1.62]
    summary = {
        'triangles': tris, 'total': sum(tris.values()), 'bones': len(groups),
        'faces_flipped_body': flipped_body, 'faces_flipped_face': flipped_face, 'tear_band_violations': bad_bands,
        'teeth': len(tooth_lens), 'tooth_len_cm': [round(min(tooth_lens) * 100, 1), round(max(tooth_lens) * 100, 1)],
        'body_z': [round(min(zs), 3), round(max(zs), 3)],
        'head_width': round(2 * max(abs(c.x) for c in head), 3),
        **checks,
        'face_verts_behind_body': hidden_face_verts(body, face_data),
    }
    path = common.export_glb('ent_smiler.glb')
    summary['glb'] = glb_summary(path)
    print('SMILER', json.dumps(summary, indent=1))

    if '--previews' in ARGS:
        render_previews(rig, face)


def render_previews(rig, face):
    scene = bpy.context.scene
    keys = face.data.shape_keys.key_blocks
    rig.animation_data.action = None
    scene.frame_set(0)
    common.render_preview('ent_smiler.png', (2.4, -3.7, 1.7), target=(0, 0, 1.2), lens=50)
    common.render_preview('ent_smiler_back.png', (-2.2, 3.6, 1.6), target=(0, 0, 1.15), lens=50, resolution=(600, 600))
    keys['grin_wide'].value = 1.0
    keys['grin_open'].value = 1.0
    common.render_preview('ent_smiler_grin.png', (0.55, -1.75, 2.0), target=(0, -0.2, 1.88), lens=50)
    keys['grin_wide'].value = keys['grin_open'].value = 0.0
    keys['face_tear'].value = 1.0
    common.render_preview('ent_smiler_tear.png', (0.3, -1.6, 1.95), target=(0, -0.2, 1.9), lens=50,
                          resolution=(600, 600))
    keys['face_tear'].value = 0.0
    act = bpy.data.actions['attack_strike']
    rig.animation_data.action = act
    scene.frame_set(7)
    common.render_preview('ent_smiler_attack.png', (3.2, -2.6, 2.4), target=(0, -0.55, 1.3), lens=40,
                          resolution=(600, 600))
    rig.animation_data.action = bpy.data.actions['jumpscare']
    scene.frame_set(30)
    keys['grin_wide'].value = 1.0
    keys['grin_open'].value = 0.8
    # JS_CAM looks along +Y; 72 degree vertical field of view at 16:9
    lens = 18 / (math.tan(math.radians(36)) * 16 / 9)
    common.render_preview('ent_smiler_jumpscare.png', tuple(JS_CAM_POS), target=tuple(JS_CAM_POS + Vector((0, 1, 0))),
                          lens=lens, resolution=(1280, 720))
    keys['grin_wide'].value = keys['grin_open'].value = 0.0
    rig.animation_data.action = None


main()
