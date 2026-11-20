"""Build public/assets/models/vm_pistol.glb: the first-person suppressed pistol held in two gloved hands.

Run from the repository root (Blender 4.5):
    blender --background --factory-startup --python tools/blender/build_viewmodel.py
    blender --background --factory-startup --python tools/blender/build_viewmodel.py -- --no-preview

Coordinates are the code's gun pivot (src/game/weapon.ts) in Blender axes: x right, +y along the barrel, z up. Every
number the game frames on stays where the procedural gun had it: slide 0.27 m with its top at z 0.0425, sights at
z ~0.055 (the ADS eye line), suppressor dia 0.035 x 0.145 ending at y 0.302, bore at z 0.020. See
docs/design/art/model-contract.md, section vm_pistol.glb.

The pistol is an original design (no real model): a slide with a stepped nose and a cascade of slanted cuts instead of
serrations, an external spur hammer, a smooth grip with one rectangular stippled panel per side, a squared trigger
guard with a chamfered corner and a flat trigger blade.

Rig `vm_rig`: gun_root, slide, trigger, hammer, magazine (gun parts are separate meshes parented rigidly to these
bones) and upperarm/forearm/hand per side (one skinned mesh `vm_arms`, distance-based weights). The shoulders stay
fixed in the viewmodel's space; in every frame the hands are placed on the gun and the elbows are solved with an
analytic two-bone IK, then every bone is keyed, so the clips need no constraints at runtime.
"""
import math
import pathlib
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Quaternion, Vector

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import common  # noqa: E402

R = math.radians
V = Vector
ARGS = common.args_after_dashdash()

# ----------------------------------------------------------------------------------------------------------------------
# Layout (metres, gun space)
# ----------------------------------------------------------------------------------------------------------------------
BORE_Z = 0.020
SLIDE_Y0, SLIDE_Y1 = -0.118, 0.152
SUP_Y0, SUP_Y1, SUP_R = 0.157, 0.302, 0.0175
LIGHT_Z = -0.051                       # weapon light axis
LENS_Y = 0.1636

GRIP_TILT = R(16)
GRIP_TOP = V((0.0, -0.076, -0.006))
GD = V((0.0, -math.sin(GRIP_TILT), -math.cos(GRIP_TILT)))   # down the grip axis
GF = V((0.0, math.cos(GRIP_TILT), -math.sin(GRIP_TILT)))    # across the grip, towards the front strap
GR = V((1.0, 0.0, 0.0))
GRIP_N = 2.8
GRIP_S = [0.0, 0.03, 0.08, 0.125, 0.145, 0.150]
GRIP_A = [0.025, 0.026, 0.027, 0.0275, 0.0285, 0.029]        # half depth (front to back)
GRIP_B = [0.0150, 0.0160, 0.0165, 0.0165, 0.0172, 0.0175]    # half width
GRIP_LEN = 0.150

MAG_POS = V((0.0, -0.0, 0.0))

# Texture atlas regions (u0, v0, u1, v1); the gun shares one material, the arms another.
SLIDE_RG = (0.0, 0.5, 0.5, 1.0)
FRAME_RG = (0.5, 0.5, 1.0, 1.0)
DARK_RG = (0.5, 0.0, 1.0, 0.5)
STIPPLE_RG = (0.0, 0.0, 0.25, 0.5)
BRIGHT_RG = (0.25, 0.25, 0.5, 0.5)
LENS_RG = (0.25, 0.125, 0.375, 0.25)
BRASS_RG = (0.375, 0.125, 0.5, 0.25)
RUBBER_RG = (0.25, 0.0, 0.375, 0.125)
REGION_SIZE = {SLIDE_RG: 0.30, FRAME_RG: 0.30, DARK_RG: 0.30, BRIGHT_RG: 0.10, LENS_RG: 0.04, BRASS_RG: 0.04,
               RUBBER_RG: 0.04}

GLOVE_RG = (0.0, 0.0, 0.5, 1.0)
JACKET_RG = (0.5, 0.25, 1.0, 1.0)
CUFF_RG = (0.5, 0.0, 0.75, 0.25)
GCUFF_RG = (0.75, 0.0, 1.0, 0.25)


def gA(s):
    return float(np.interp(s, GRIP_S, GRIP_A))


def gB(s):
    return float(np.interp(s, GRIP_S, GRIP_B))


def grip_pt(s, v, u):
    return GRIP_TOP + GD * s + GF * v + GR * u


def grip_coords(p):
    d = V(p) - GRIP_TOP
    return d.dot(GD), d.dot(GF), d.dot(GR)


def se_point(phi, a, b, n=GRIP_N):
    """Superellipse; phi = 0 is +u (right side), 90 deg is +v (front strap)."""
    c, s = math.cos(phi), math.sin(phi)
    return b * math.copysign(abs(c) ** (2 / n), c), a * math.copysign(abs(s) ** (2 / n), s)


def se_normal(u, v, a, b, n=GRIP_N):
    gu = math.copysign(abs(u / b) ** (n - 1), u) / b
    gv = math.copysign(abs(v / a) ** (n - 1), v) / a
    ln = math.hypot(gu, gv)
    return gu / ln, gv / ln


# ----------------------------------------------------------------------------------------------------------------------
# Mesh helpers
# ----------------------------------------------------------------------------------------------------------------------
def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def obj_from_bm(name, bm):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return link(bpy.data.objects.new(name, me))


def apply_mods(obj):
    """Bake the modifier stack into the mesh (no operators, so it works in background mode)."""
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(obj.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    old = obj.data
    obj.modifiers.clear()
    obj.data = me
    bpy.data.meshes.remove(old)
    me.name = obj.name


def co3(axis, p, q, a):
    if axis == 'x':
        return V((a, p, q))
    if axis == 'y':
        return V((p, a, q))
    return V((p, q, a))


def prism(poly, axis, a0, a1):
    """Closed prism: 2D polygon extruded along an axis. axis x: (y, z); axis y: (x, z); axis z: (x, y)."""
    bm = bmesh.new()
    v0 = [bm.verts.new(co3(axis, p, q, a0)) for p, q in poly]
    v1 = [bm.verts.new(co3(axis, p, q, a1)) for p, q in poly]
    n = len(poly)
    bm.faces.new(v0[::-1])
    bm.faces.new(v1)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((v0[i], v0[j], v1[j], v1[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def box(x0, x1, y0, y1, z0, z1):
    return prism([(y0, z0), (y1, z0), (y1, z1), (y0, z1)], 'x', x0, x1)


def ring_prism(outer, inner, axis, a0, a1):
    """A loop (outer and inner polygon with the same vertex count) extruded along an axis."""
    bm = bmesh.new()
    n = len(outer)
    o0 = [bm.verts.new(co3(axis, p, q, a0)) for p, q in outer]
    o1 = [bm.verts.new(co3(axis, p, q, a1)) for p, q in outer]
    i0 = [bm.verts.new(co3(axis, p, q, a0)) for p, q in inner]
    i1 = [bm.verts.new(co3(axis, p, q, a1)) for p, q in inner]
    for k in range(n):
        j = (k + 1) % n
        bm.faces.new((o0[k], o0[j], o1[j], o1[k]))
        bm.faces.new((i0[j], i0[k], i1[k], i1[j]))
        bm.faces.new((o0[j], o0[k], i0[k], i0[j]))
        bm.faces.new((o1[k], o1[j], i1[j], i1[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def lathe(center, axis, profile, segs=24, phase=0.0):
    """Surface of revolution. profile [(t, r)] walks from the start of the axis, round the outside, to its end;
    r == 0 makes a pole. Normals come out right by construction."""
    center, axis = V(center), V(axis).normalized()
    ref = V((0, 0, 1)) if abs(axis.z) < 0.9 else V((1, 0, 0))
    e1 = axis.cross(ref).normalized()
    e2 = axis.cross(e1)
    bm = bmesh.new()
    rings = []
    for t, r in profile:
        if r <= 1e-7:
            rings.append([bm.verts.new(center + axis * t)])
        else:
            rings.append([bm.verts.new(center + axis * t + (e1 * math.cos(phase + 2 * math.pi * k / segs)
                                                             + e2 * math.sin(phase + 2 * math.pi * k / segs)) * r)
                          for k in range(segs)])
    for ra, rb in zip(rings, rings[1:]):
        for k in range(segs):
            j = (k + 1) % segs
            if len(ra) == 1 and len(rb) == 1:
                continue
            if len(ra) == 1:
                bm.faces.new((ra[0], rb[j], rb[k]))
            elif len(rb) == 1:
                bm.faces.new((ra[k], ra[j], rb[0]))
            else:
                bm.faces.new((ra[k], ra[j], rb[j], rb[k]))
    return bm


def loft_closed(rings, cap_start=True, cap_end=True):
    bm = bmesh.new()
    vr = [[bm.verts.new(p) for p in ring] for ring in rings]
    n = len(rings[0])
    for a, b in zip(vr, vr[1:]):
        for k in range(n):
            j = (k + 1) % n
            bm.faces.new((a[k], a[j], b[j], b[k]))
    if cap_start:
        bm.faces.new(vr[0][::-1])
    if cap_end:
        bm.faces.new(vr[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def solid(name, bm, bevel=0.0, segs=2, cutters=(), intersect=None, bevel_after_intersect=True):
    """Object from a bmesh with an optional intersect, bevel and difference cutters, all baked."""
    obj = obj_from_bm(name, bm)
    ops = []
    if intersect is not None:
        m = obj.modifiers.new('isect', 'BOOLEAN')
        m.operation, m.solver, m.object = 'INTERSECT', 'EXACT', intersect
        ops.append(intersect)
    if bevel:
        m = obj.modifiers.new('bevel', 'BEVEL')
        m.width, m.segments, m.limit_method, m.angle_limit = bevel, segs, 'ANGLE', R(30)
        m.use_clamp_overlap = True
    if cutters:
        coll = bpy.data.collections.new(name + '_cutters')
        bpy.context.scene.collection.children.link(coll)
        for c in cutters:
            bpy.context.scene.collection.objects.unlink(c)
            coll.objects.link(c)
        m = obj.modifiers.new('cut', 'BOOLEAN')
        m.operation, m.solver, m.operand_type, m.collection = 'DIFFERENCE', 'EXACT', 'COLLECTION', coll
    apply_mods(obj)
    for c in list(cutters) + ops:
        bpy.data.objects.remove(c, do_unlink=True)
    if cutters:
        bpy.data.collections.remove(coll)
    return obj


def cutter(bm):
    return obj_from_bm('cutter', bm)


def uv_layer(bm):
    return bm.loops.layers.uv.get('UVMap') or bm.loops.layers.uv.new('UVMap')


def finish_part(obj, region, mat=0, sharp=46):
    """Box-project UVs into an atlas region, set the material slot and mark sharp edges by angle."""
    size = REGION_SIZE[region]
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    uvl = uv_layer(bm)
    lo = V([min(v.co[i] for v in bm.verts) for i in range(3)])
    hi = V([max(v.co[i] for v in bm.verts) for i in range(3)])
    c = (lo + hi) / 2
    u0, v0, u1, v1 = region
    for f in bm.faces:
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        f.material_index = mat
        f.smooth = True
        for lp in f.loops:
            p = lp.vert.co - c
            a, b = ((p.y, p.z), (p.x, p.z), (p.y, p.x))[ax]
            a = min(max(a / size + 0.5, 0.01), 0.99)
            b = min(max(b / size + 0.5, 0.01), 0.99)
            lp[uvl].uv = (u0 + a * (u1 - u0), v0 + b * (v1 - v0))
    for e in bm.edges:
        e.smooth = len(e.link_faces) == 2 and e.calc_face_angle(0) < R(sharp)
    bm.to_mesh(obj.data)
    bm.free()
    return obj


def join(name, objs, materials, weighted=True):
    bm = bmesh.new()
    for o in objs:
        bm.from_mesh(o.data)
    obj = obj_from_bm(name, bm)
    for m in materials:
        obj.data.materials.append(m)
    for o in objs:
        bpy.data.objects.remove(o, do_unlink=True)
    if weighted:
        m = obj.modifiers.new('wn', 'WEIGHTED_NORMAL')
        m.keep_sharp, m.weight, m.mode = True, 50, 'FACE_AREA'
        apply_mods(obj)
    return obj


def parallelogram(yc, zc, h, w, ang):
    """Slanted slot outline in the yz plane: centre, length along the slant, width, slant angle from horizontal."""
    d = V((math.cos(ang), math.sin(ang)))
    nrm = V((math.sin(ang), -math.cos(ang)))
    c = V((yc, zc))
    pts = [c - d * h / 2 - nrm * w / 2, c - d * h / 2 + nrm * w / 2, c + d * h / 2 + nrm * w / 2,
           c + d * h / 2 - nrm * w / 2]
    return [(p.x, p.y) for p in pts]


# ----------------------------------------------------------------------------------------------------------------------
# Gun parts
# ----------------------------------------------------------------------------------------------------------------------
def build_slide(mats):
    side = [(SLIDE_Y0, 0.006), (SLIDE_Y1, 0.006), (SLIDE_Y1, 0.025), (0.146, 0.0355), (0.094, 0.0355),
            (0.068, 0.0440), (-0.110, 0.0440), (SLIDE_Y0, 0.032)]
    xsec = [(-0.017, 0.006), (0.017, 0.006), (0.017, 0.031), (0.011, 0.0425), (-0.011, 0.0425), (-0.017, 0.031)]
    isect = cutter(prism(xsec, 'y', -0.14, 0.17))
    cuts = []
    # A cascade of slanted cuts at the rear (each one shorter and flatter than the one behind it) and one long slanted
    # slot along the nose: no serrations.
    for yc, zc, h, w, ang in [(-0.104, 0.0205, 0.022, 0.0032, 62), (-0.093, 0.0215, 0.019, 0.0030, 60),
                              (-0.083, 0.0225, 0.016, 0.0028, 58), (-0.074, 0.0235, 0.012, 0.0024, 56)]:
        poly = parallelogram(yc, zc, h, w, R(ang))
        cuts += [cutter(prism(poly, 'x', 0.0158, 0.03)), cutter(prism(poly, 'x', -0.03, -0.0158))]
    slot = [(0.070, 0.0230), (0.128, 0.0126), (0.1298, 0.0160), (0.0718, 0.0264)]
    cuts += [cutter(prism(slot, 'x', 0.0158, 0.03)), cutter(prism(slot, 'x', -0.03, -0.0158))]
    # Ejection port (right side), front wall raked forward.
    cuts.append(cutter(prism([(-0.040, 0.024), (0.008, 0.024), (0.014, 0.06), (-0.040, 0.06)], 'x', 0.0, 0.03)))
    # Bore.
    bore = lathe((0, 0.10, BORE_Z), (0, 1, 0), [(0, 0), (0, 0.0068), (0.07, 0.0068), (0.07, 0)], segs=16)
    bmesh.ops.recalc_face_normals(bore, faces=bore.faces)
    cuts.append(cutter(bore))
    body = finish_part(solid('slide_body', prism(side, 'x', -0.02, 0.02), bevel=0.0011, cutters=cuts,
                             intersect=isect), SLIDE_RG)
    # Rear sight with a U notch, front post (suppressor height).
    rear = solid('rear_sight', prism([(-0.098, 0.040), (-0.083, 0.040), (-0.083, 0.052), (-0.086, 0.0585),
                                      (-0.098, 0.0585)], 'x', -0.0145, 0.0145), bevel=0.0006,
                 cutters=[cutter(box(-0.0040, 0.0040, -0.11, -0.07, 0.0515, 0.07))])
    front = solid('front_sight', prism([(0.131, 0.034), (0.145, 0.034), (0.145, 0.040), (0.142, 0.0585),
                                        (0.131, 0.0585)], 'x', -0.0024, 0.0024), bevel=0.0005)
    base = solid('front_base', box(-0.006, 0.006, 0.127, 0.146, 0.033, 0.040), bevel=0.0008)
    extractor = solid('extractor', box(0.0160, 0.0177, -0.058, -0.041, 0.0262, 0.0302), bevel=0.0004)
    parts = [body, finish_part(rear, SLIDE_RG), finish_part(front, SLIDE_RG), finish_part(base, SLIDE_RG),
             finish_part(extractor, BRIGHT_RG)]
    # Three tritium inserts: rings on the rear faces of the sights, the glowing vial inside.
    for x, y, z, r in [(-0.0090, -0.0980, 0.0545, 0.0019), (0.0090, -0.0980, 0.0545, 0.0019),
                       (0.0, 0.1310, 0.0535, 0.0020)]:
        ring = lathe((x, y + 0.0002, z), (0, -1, 0), [(0, 0.0), (0, r + 0.0009), (0.0006, r + 0.0009),
                                                       (0.0006, r), (0.0003, 0)], segs=12)
        parts.append(finish_part(obj_from_bm('tritium_ring', ring), BRIGHT_RG, sharp=60))
        dot = lathe((x, y, z), (0, -1, 0), [(0, 0), (0, r), (0.0004, r), (0.0006, r * 0.6), (0.00065, 0)], segs=12)
        parts.append(finish_part(obj_from_bm('tritium_dot', dot), BRIGHT_RG, mat=1, sharp=80))
    return join('vm_slide', parts, mats)


def build_frame(mats):
    parts = []
    # Receiver + dust cover + beavertail, one profile.
    rec = [(0.142, 0.0058), (0.142, -0.017), (0.136, -0.026), (-0.060, -0.026), (-0.092, -0.016),
           (-0.112, -0.0125), (-0.126, -0.0095), (-0.1365, -0.0055), (-0.1410, 0.0), (-0.1375, 0.0042),
           (-0.122, 0.0058)]
    cuts = [cutter(box(-0.0046, 0.0046, -0.1345, -0.116, -0.010, 0.010))]           # hammer slot
    acc = [(0.030, -0.0185), (0.112, -0.0185), (0.1165, -0.0140), (0.0345, -0.0140)]  # slanted accent groove
    cuts += [cutter(prism(acc, 'x', 0.0137, 0.03)), cutter(prism(acc, 'x', -0.03, -0.0137))]
    parts.append(finish_part(solid('receiver', prism(rec, 'x', -0.0145, 0.0145), bevel=0.0012, cutters=cuts),
                             FRAME_RG))
    # Accessory rail with two cross slots.
    rail = solid('rail', prism([(-0.0105, -0.0335), (0.0105, -0.0335), (0.0105, -0.0272), (0.0085, -0.0255),
                                (-0.0085, -0.0255), (-0.0105, -0.0272)], 'y', 0.048, 0.137), bevel=0.0006,
                 cutters=[cutter(box(-0.02, 0.02, 0.052, 0.0565, -0.04, -0.0300)),
                          cutter(box(-0.02, 0.02, 0.1295, 0.134, -0.04, -0.0300))])
    parts.append(finish_part(rail, FRAME_RG))
    # Squared trigger guard: flat front, chamfered lower corner, no hook.
    outer = [(0.012, -0.020), (0.012, -0.0515), (0.0005, -0.0640), (-0.0745, -0.0640), (-0.0640, -0.0200)]
    inner = [(0.0058, -0.0262), (0.0058, -0.0495), (-0.0015, -0.0578), (-0.0700, -0.0578), (-0.0585, -0.0262)]
    parts.append(finish_part(solid('guard', ring_prism(outer, inner, 'x', -0.0060, 0.0060), bevel=0.0010),
                             FRAME_RG))
    # Grip: superellipse rings down the raked axis, flared at the bottom, with a shallow magazine well.
    rings, ss = [], [-0.004, 0.0, 0.02, 0.04, 0.06, 0.08, 0.10, 0.12, 0.135, 0.145, 0.1495]
    segs = 32

    def grip_ring(s, scale=1.0, grow=0.0):
        a, b = gA(min(max(s, 0), GRIP_LEN)) * scale + grow, gB(min(max(s, 0), GRIP_LEN)) * scale + grow
        return [grip_pt(s, *se_point(2 * math.pi * k / segs, a, b)[::-1]) for k in range(segs)]

    for s in ss:
        rings.append(grip_ring(s))
    rings.append(grip_ring(0.1505, 0.97))
    rings.append(grip_ring(0.1505, 0.80))
    rings.append(grip_ring(0.126, 0.80))
    grip = loft_closed(rings)
    gobj = finish_part(obj_from_bm('grip', grip), FRAME_RG, sharp=60)
    parts.append(gobj)
    # Stippled panel on each side: a slightly raised patch that follows the grip surface.
    for sign in (1, -1):
        bm = bmesh.new()
        uvl = uv_layer(bm)
        nv, ns = 9, 12
        v_lo, v_hi, s_lo, s_hi = -0.0165, 0.0115, 0.030, 0.118
        grid = []
        for i in range(ns + 1):
            s = s_lo + (s_hi - s_lo) * i / ns
            row = []
            for j in range(nv + 1):
                v = v_lo + (v_hi - v_lo) * j / nv
                a, b = gA(s), gB(s)
                u = b * max(0.0, 1 - abs(v / a) ** GRIP_N) ** (1 / GRIP_N)
                nu, nvv = se_normal(u, v, a, b)
                edge = i in (0, ns) or j in (0, nv)
                off = 0.00005 if edge else 0.0005
                p = grip_pt(s, v + nvv * off, (u + nu * off) * sign)
                row.append((bm.verts.new(p), v, s))
            grid.append(row)
        u0, v0, u1, v1 = STIPPLE_RG
        for i in range(ns):
            for j in range(nv):
                quad = [grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j]]
                if sign < 0:
                    quad = quad[::-1]
                f = bm.faces.new([q[0] for q in quad])
                f.smooth = True
                for lp, q in zip(f.loops, quad):
                    lp[uvl].uv = (u0 + (q[1] + 0.0225) / 0.045 * (u1 - u0), v0 + (q[2] / 0.12) * (v1 - v0))
        bm.normal_update()
        bm.faces.ensure_lookup_table()
        # Faces must point away from the grip.
        f0 = bm.faces[0]
        if f0.normal.x * sign < 0:
            bmesh.ops.reverse_faces(bm, faces=bm.faces)
        for e in bm.edges:
            e.smooth = True
        parts.append(obj_from_bm('stipple', bm))
    # Barrel (seen through the port, at the muzzle and when the slide is back), hood and thread.
    barrel = lathe((0, -0.040, BORE_Z), (0, 1, 0), [(0, 0), (0, 0.0062), (0.190, 0.0062), (0.191, 0.0057),
                                                    (0.199, 0.0057), (0.199, 0.0034), (0.196, 0.0030),
                                                    (0.196, 0)], segs=16)
    parts.append(finish_part(obj_from_bm('barrel', barrel), BRIGHT_RG, sharp=50))
    parts.append(finish_part(solid('hood', box(-0.0078, 0.0078, -0.042, 0.010, 0.016, 0.0355), bevel=0.0006),
                             BRIGHT_RG))
    # Suppressor: octagonal mount collar, smooth tube, one shallow ring groove, recessed bore at the front.
    collar = lathe((0, SUP_Y0, BORE_Z), (0, 1, 0), [(-0.0005, 0), (-0.0005, 0.0150), (0.001, 0.0170), (0.017, 0.0170),
                                                    (0.0185, 0.0155), (0.0185, 0)], segs=8, phase=math.pi / 8)
    parts.append(finish_part(obj_from_bm('sup_collar', collar), DARK_RG, sharp=40))
    tube = lathe((0, 0.0, BORE_Z), (0, 1, 0), [(0.171, 0), (0.171, 0.0150), (0.1735, 0.0175), (0.276, 0.0175),
                                               (0.2765, 0.0169), (0.2795, 0.0169), (0.280, 0.0175),
                                               (SUP_Y1 - 0.0022, SUP_R), (SUP_Y1, 0.0154), (SUP_Y1, 0.0062),
                                               (SUP_Y1 - 0.004, 0.0052), (SUP_Y1 - 0.004, 0)], segs=32)
    parts.append(finish_part(obj_from_bm('sup_tube', tube), DARK_RG, sharp=40))
    # Weapon light: squared body, round head, lens, clamp on the rail, rocker paddles at the rear.
    body = [(-0.0125, -0.0640), (0.0125, -0.0640), (0.0130, -0.0590), (0.0130, -0.0410), (0.0100, -0.0375),
            (-0.0100, -0.0375), (-0.0130, -0.0410), (-0.0130, -0.0590)]
    parts.append(finish_part(solid('light_body', prism(body, 'y', 0.058, 0.150), bevel=0.0012), DARK_RG))
    head = lathe((0, 0.146, LIGHT_Z), (0, 1, 0), [(0, 0), (0, 0.0128), (0.003, 0.0142), (0.0165, 0.0142),
                                                   (0.0180, 0.0130), (0.0180, 0.0112), (LENS_Y - 0.146 - 0.0002,
                                                                                         0.0106),
                                                   (LENS_Y - 0.146 - 0.0002, 0)], segs=24)
    parts.append(finish_part(obj_from_bm('light_head', head), DARK_RG, sharp=40))
    lens = lathe((0, LENS_Y, LIGHT_Z), (0, 1, 0), [(-0.0003, 0.0106), (0.0, 0.0104), (0.0004, 0)], segs=24)
    parts.append(finish_part(obj_from_bm('light_lens', lens), LENS_RG, sharp=80))
    parts.append(finish_part(solid('light_clamp', box(-0.0115, 0.0115, 0.070, 0.128, -0.0385, -0.0255),
                                   bevel=0.0010), DARK_RG))
    bolt = lathe((0.0115, 0.099, -0.032), (1, 0, 0), [(0, 0), (0, 0.0035), (0.0025, 0.0035), (0.003, 0.0028),
                                                       (0.003, 0)], segs=12)
    parts.append(finish_part(obj_from_bm('light_bolt', bolt), BRIGHT_RG, sharp=50))
    for sign in (1, -1):
        paddle = prism([(0.046, -0.058), (0.060, -0.058), (0.060, -0.044), (0.050, -0.044)], 'x',
                       sign * 0.0100, sign * 0.0155)
        parts.append(finish_part(solid('paddle', paddle, bevel=0.0008), RUBBER_RG))
    # Controls on the left side: slide stop, takedown tab, magazine release.
    stop = prism([(-0.044, -0.0045), (-0.012, -0.0045), (-0.007, -0.0010), (-0.011, 0.0032), (-0.044, 0.0022)], 'x',
                 -0.0165, -0.0140)
    parts.append(finish_part(solid('slide_stop', stop, bevel=0.0005), FRAME_RG))
    take = prism([(0.008, -0.013), (0.020, -0.013), (0.020, -0.0045), (0.008, -0.0045)], 'x', -0.0160, -0.0140)
    parts.append(finish_part(solid('takedown', take, bevel=0.0006), FRAME_RG))
    rel = prism([(-0.062, -0.034), (-0.054, -0.034), (-0.054, -0.024), (-0.062, -0.024)], 'x', -0.0172, -0.0140)
    parts.append(finish_part(solid('mag_release', rel, bevel=0.0007), FRAME_RG))
    return join('vm_frame', parts, mats)


TRIGGER_PIVOT = V((0.0, -0.024, -0.021))
HAMMER_PIVOT = V((0.0, -0.1245, -0.0005))
HAMMER_COCKED = R(50)


def build_trigger(mats):
    py, pz = TRIGGER_PIVOT.y, TRIGGER_PIVOT.z
    blade = [(0.0030, 0.0030), (0.0035, -0.0100), (0.0045, -0.0245), (0.0005, -0.0275), (-0.0035, -0.0255),
             (-0.0030, -0.0100), (-0.0040, 0.0030)]
    bm = prism([(py + y, pz + z) for y, z in blade], 'x', -0.0032, 0.0032)
    return join('vm_trigger', [finish_part(solid('trigger', bm, bevel=0.0007), SLIDE_RG)], mats)


def build_hammer(mats):
    py, pz = HAMMER_PIVOT.y, HAMMER_PIVOT.z
    prof = [(0.0040, -0.0040), (0.0040, 0.0185), (0.0022, 0.0235), (-0.0055, 0.0262), (-0.0110, 0.0245),
            (-0.0085, 0.0205), (-0.0045, 0.0180), (-0.0050, -0.0040)]
    bm = prism([(py + y, pz + z) for y, z in prof], 'x', -0.0035, 0.0035)
    # Rest pose is cocked: rotate the spur back about the pin.
    rot = Matrix.Translation(HAMMER_PIVOT) @ Matrix.Rotation(HAMMER_COCKED, 4, 'X') @ Matrix.Translation(-HAMMER_PIVOT)
    bm.transform(rot)
    obj = solid('hammer', bm, bevel=0.0006)
    pin = lathe(HAMMER_PIVOT + V((-0.0045, 0, 0)), (1, 0, 0), [(0, 0), (0, 0.0022), (0.009, 0.0022), (0.009, 0)],
                segs=10)
    return join('vm_hammer', [finish_part(obj, SLIDE_RG), finish_part(obj_from_bm('pin', pin), BRIGHT_RG)], mats)


MAG_TOP_S, MAG_BOT_S = 0.010, 0.150


def build_magazine(mats):
    segs = 20

    def ring(s, a, b, dv=0.0, n=4.0):
        return [grip_pt(s, se_point(2 * math.pi * k / segs, a, b, n)[1] + dv, se_point(2 * math.pi * k / segs, a, b,
                                                                                       n)[0]) for k in range(segs)]

    body = loft_closed([ring(MAG_TOP_S, 0.0155, 0.0105, 0.001), ring(MAG_BOT_S, 0.0155, 0.0105, 0.001)])
    parts = [finish_part(obj_from_bm('mag_body', body), DARK_RG, sharp=50)]
    plate = loft_closed([ring(0.1495, 0.0255, 0.0152, 0.0015), ring(0.1565, 0.0262, 0.0158, 0.0018),
                         ring(0.1595, 0.0250, 0.0148, 0.0018), ring(0.1605, 0.0235, 0.0136, 0.0018)])
    parts.append(finish_part(obj_from_bm('mag_plate', plate), FRAME_RG, sharp=50))
    # Top round: a 9 mm cartridge on the feed lips, pointing along the bore.
    c0 = grip_pt(MAG_TOP_S + 0.004, -0.012, 0.0)
    rnd = lathe(c0, GF, [(0, 0), (0, 0.0048), (0.0190, 0.0048), (0.0192, 0.0046), (0.0235, 0.0040), (0.0270, 0.0024),
                         (0.0285, 0)], segs=12)
    parts.append(finish_part(obj_from_bm('round', rnd), BRASS_RG, sharp=50))
    return join('vm_magazine', parts, mats)


# ----------------------------------------------------------------------------------------------------------------------
# Arms and gloved hands
# ----------------------------------------------------------------------------------------------------------------------
def catmull(ctrl, radii, sub):
    """Centripetal Catmull-Rom through the control points (no loops on uneven spacing); radii interpolate linearly."""
    pts, rads = [], []
    P = [ctrl[0] * 2 - ctrl[1]] + list(ctrl) + [ctrl[-1] * 2 - ctrl[-2]]
    for i in range(len(ctrl) - 1):
        p0, p1, p2, p3 = P[i], P[i + 1], P[i + 2], P[i + 3]
        t0 = 0.0
        t1 = t0 + max((p1 - p0).length, 1e-6) ** 0.5
        t2 = t1 + max((p2 - p1).length, 1e-6) ** 0.5
        t3 = t2 + max((p3 - p2).length, 1e-6) ** 0.5
        for k in range(sub):
            tt = t1 + (t2 - t1) * k / sub
            a1 = p0 * ((t1 - tt) / (t1 - t0)) + p1 * ((tt - t0) / (t1 - t0))
            a2 = p1 * ((t2 - tt) / (t2 - t1)) + p2 * ((tt - t1) / (t2 - t1))
            a3 = p2 * ((t3 - tt) / (t3 - t2)) + p3 * ((tt - t2) / (t3 - t2))
            b1 = a1 * ((t2 - tt) / (t2 - t0)) + a2 * ((tt - t0) / (t2 - t0))
            b2 = a2 * ((t3 - tt) / (t3 - t1)) + a3 * ((tt - t1) / (t3 - t1))
            pts.append(b1 * ((t2 - tt) / (t2 - t1)) + b2 * ((tt - t1) / (t2 - t1)))
            rads.append(radii[i] + (radii[i + 1] - radii[i]) * k / sub)
    pts.append(V(ctrl[-1]))
    rads.append(radii[-1])
    return pts, rads


def transport_frames(pts, up):
    T = []
    for i in range(len(pts)):
        a, b = pts[max(i - 1, 0)], pts[min(i + 1, len(pts) - 1)]
        T.append((b - a).normalized())
    for cand in (V(up), V((0, 0, 1)), V((1, 0, 0))):
        N0 = cand - T[0] * cand.dot(T[0])
        if N0.length > 0.2:
            break
    N0.normalize()
    frames = [(T[0], N0, T[0].cross(N0))]
    for i in range(1, len(pts)):
        Tp, Np, _ = frames[-1]
        q = Tp.rotation_difference(T[i])
        N = (q @ Np)
        N = (N - T[i] * N.dot(T[i])).normalized()
        frames.append((T[i], N, T[i].cross(N)))
    return frames


class Arms:
    """One bmesh for both arms; remembers which side and part each vertex belongs to."""

    def __init__(self):
        self.bm = bmesh.new()
        self.uv = uv_layer(self.bm)
        self.tags = []          # per vertex: (side, rigid_hand)

    def _vert(self, p, side, rigid):
        self.tags.append((side, rigid))
        return self.bm.verts.new(p)

    def rings(self, rings, vs, region, side, rigid, cap0=None, cap1=None, close0=False, close1=False):
        """Quads between rings (lists of points ordered CCW about the direction of travel); optional pole caps."""
        u0, v0, u1, v1 = region
        segs = len(rings[0])
        vr = [[self._vert(p, side, rigid) for p in ring] for ring in rings]

        def uv(k, v):
            return (u0 + (u1 - u0) * (0.01 + 0.98 * k / segs), v0 + (v1 - v0) * min(max(v, 0.01), 0.99))

        def face(verts, uvs):
            f = self.bm.faces.new(verts)
            f.smooth = True
            for lp, t in zip(f.loops, uvs):
                lp[self.uv].uv = t
            return f

        for i in range(len(vr) - 1):
            for k in range(segs):
                j = (k + 1) % segs
                face((vr[i][k], vr[i][j], vr[i + 1][j], vr[i + 1][k]),
                     (uv(k, vs[i]), uv(k + 1, vs[i]), uv(k + 1, vs[i + 1]), uv(k, vs[i + 1])))
        if cap1 is not None:
            pole = self._vert(cap1[0], side, rigid)
            for k in range(segs):
                j = (k + 1) % segs
                face((vr[-1][k], vr[-1][j], pole), (uv(k, vs[-1]), uv(k + 1, vs[-1]), uv(k + 0.5, cap1[1])))
        if cap0 is not None:
            pole = self._vert(cap0[0], side, rigid)
            for k in range(segs):
                j = (k + 1) % segs
                face((vr[0][j], vr[0][k], pole), (uv(k + 1, vs[0]), uv(k, vs[0]), uv(k + 0.5, cap0[1])))
        if close0:
            face(vr[0][::-1], [uv(k, vs[0]) for k in range(segs)][::-1])
        if close1:
            face(vr[-1], [uv(k, vs[-1]) for k in range(segs)])
        return vr

    def tube(self, ctrl, radii, side, region, uv_len, rigid=False, segs=10, sub=3, up=V((0, 0, 1)), round0=False,
             round1=True, flat0=False, flat1=False, ell=(1.0, 1.0), wobble=None):
        pts, rads = catmull([V(c) for c in ctrl], radii, sub)
        frames = transport_frames(pts, up)
        rings, vs, acc = [], [], 0.0
        for i, (p, r, (T, N, B)) in enumerate(zip(pts, rads, frames)):
            if i:
                acc += (p - pts[i - 1]).length
            ring = []
            for k in range(segs):
                th = 2 * math.pi * k / segs
                rr = r * (wobble(th, acc) if wobble else 1.0)
                ring.append(p + (N * math.cos(th) * ell[0] + B * math.sin(th) * ell[1]) * rr)
            rings.append(ring)
            vs.append(acc / uv_len)
        cap0 = cap1 = None
        T0, N0, B0 = frames[0]
        T1, N1, B1 = frames[-1]
        if round0:   # rounded start: two shrinking rings and a pole
            r0 = rads[0]
            extra = [[pts[0] - T0 * r0 * f + (N0 * math.cos(2 * math.pi * k / segs) * ell[0]
                                             + B0 * math.sin(2 * math.pi * k / segs) * ell[1]) * r0 * g
                      for k in range(segs)] for f, g in ((0.85, 0.5), (0.5, 0.85))]
            rings = extra + rings
            vs = [-0.6 * r0 / uv_len, -0.35 * r0 / uv_len] + vs
            cap0 = (pts[0] - T0 * r0, -r0 / uv_len)
        if round1:
            r1 = rads[-1]
            extra = [[pts[-1] + T1 * r1 * f + (N1 * math.cos(2 * math.pi * k / segs) * ell[0]
                                              + B1 * math.sin(2 * math.pi * k / segs) * ell[1]) * r1 * g
                      for k in range(segs)] for f, g in ((0.5, 0.85), (0.85, 0.5))]
            rings = rings + extra
            vs = vs + [vs[-1] + 0.35 * r1 / uv_len, vs[-1] + 0.6 * r1 / uv_len]
            cap1 = (pts[-1] + T1 * r1, vs[-1] + 0.4 * r1 / uv_len)
        return self.rings(rings, vs, region, side, rigid, cap0=cap0, cap1=cap1, close0=flat0, close1=flat1)


def ring_outline(s, off, extra=0.0, n=720):
    a, b = gA(s) + extra, gB(s) + extra
    out = []
    for k in range(n):
        phi = 2 * math.pi * k / n
        u, v = se_point(phi, a, b)
        nu, nv = se_normal(u, v, a, b)
        out.append((u + nu * off, v + nv * off))
    return out


def walk(pts, k0, length, step):
    n, p0, k = len(pts), pts[k0], k0
    for _ in range(n):
        k = (k + step) % n
        if math.dist(pts[k], p0) >= length:
            return k
    raise ValueError('finger longer than the grip outline')


def wrap_finger(s, r, lens, phi_pip, side, extra=0.0):
    """Joint chain (base in the palm, MCP, PIP, DIP, tip) for a finger wrapped round the grip at height s.
    Right fingers run from the right side round the front strap to the left side; left fingers the other way."""
    n = 720
    pts = ring_outline(s, r + 0.0006, extra, n)
    knuckle = ring_outline(s, r + 0.0040, extra, n)
    if side == 'R':
        k_pip, fwd = int(phi_pip / 360 * n), 1
    else:
        k_pip, fwd = int((180 - phi_pip) / 360 * n), -1
    k_dip = walk(pts, k_pip, lens[1], fwd)
    k_tip = walk(pts, k_dip, lens[2] - r * 0.7, fwd)
    k_mcp = walk(pts, k_pip, lens[0], -fwd)

    def p3(k, ds, src=pts):
        u, v = src[k]
        return grip_pt(s + ds, v, u)

    mcp, pip, dip, tip = p3(k_mcp, 0.0, knuckle), p3(k_pip, 0.002), p3(k_dip, 0.004), p3(k_tip, 0.005)
    base = mcp + (mcp - pip).normalized() * 0.016
    return [base, mcp, pip, dip, tip]


RIGHT_FINGERS = [(0.064, 0.0092, (0.050, 0.031, 0.024), 42), (0.0835, 0.0088, (0.047, 0.029, 0.023), 44),
                 (0.1015, 0.0078, (0.038, 0.023, 0.020), 46)]
LEFT_FINGERS = [(0.066, 0.0090, (0.047, 0.028, 0.022), 40), (0.0855, 0.0092, (0.050, 0.031, 0.024), 42),
                (0.1045, 0.0088, (0.047, 0.029, 0.023), 44), (0.1225, 0.0078, (0.038, 0.023, 0.020), 46)]
LEFT_EXTRA = 0.0185   # the left fingers wrap over the right ones

ARM = {
    'R': dict(W=grip_pt(0.072, -0.088, 0.017), E=V((0.070, -0.420, -0.170)), S=V((-0.030, -0.620, 0.050))),
    'L': dict(W=grip_pt(0.118, -0.082, -0.050), E=V((-0.200, -0.400, -0.220)), S=V((-0.400, -0.580, 0.020))),
}
BONE_NAMES = ['upperarm_L', 'forearm_L', 'hand_L', 'upperarm_R', 'forearm_R', 'hand_R']


def push_out_of_grip(p, extra, side_bias=0.0):
    s, v, u = grip_coords(p)
    if s < -0.02 or s > GRIP_LEN + 0.02:
        return p
    sc = min(max(s, 0.0), GRIP_LEN)
    a, b = gA(sc) + extra, gB(sc) + extra
    f = abs(u / b) ** GRIP_N + abs(v / a) ** GRIP_N
    if f >= 1.0:
        return p
    k = f ** (-1 / GRIP_N)
    return grip_pt(s, v * k, u * k)


def build_hand(arms, side):
    cfg = ARM[side]
    W = cfg['W']
    if side == 'R':
        chains = [wrap_finger(s, r, lens, phi, 'R') for s, r, lens, phi in RIGHT_FINGERS]
        radii = [r for _, r, _, _ in RIGHT_FINGERS]
        mid_mcp = chains[0][1]
        mcp_i = mid_mcp - GD * 0.021 + GF * 0.003
        index = [mcp_i + (mcp_i - V((0.0235, -0.053, -0.037))).normalized() * 0.016, mcp_i,
                 V((0.0235, -0.053, -0.037)), V((0.0125, -0.0265, -0.040)), V((-0.0050, -0.0118, -0.0430))]
        chains.insert(0, index)
        radii.insert(0, 0.0090)
        thumb = [grip_pt(0.050, -gA(0.05) - 0.020, -0.004), V((-0.0262, -0.110, -0.0125)),
                 V((-0.0270, -0.081, -0.0068)), V((-0.0272, -0.058, -0.0048))]
        thumb_r = [0.0165, 0.0115, 0.0100, 0.0092]
        # Web between thumb and index, pressed up under the beavertail round the back strap (a high grip).
        web = [mcp_i + (W - mcp_i) * 0.15, grip_pt(0.030, -gA(0.03) + 0.006, gB(0.03) + 0.0075),
               grip_pt(0.022, -gA(0.022) - 0.0085, 0.0), grip_pt(0.020, -gA(0.02) + 0.004, -gB(0.02) - 0.0080),
               V((-0.0262, -0.110, -0.0125))]
        arms.tube(web, [0.0115, 0.0110, 0.0100, 0.0105, 0.0112], side, GLOVE_RG, 0.25, rigid=True, segs=10, sub=3,
                  up=V((0, 0, 1)), round0=True)
        extra = 0.0015
    else:
        chains = [wrap_finger(s, r, lens, phi, 'L', LEFT_EXTRA) for s, r, lens, phi in LEFT_FINGERS]
        radii = [r for _, r, _, _ in LEFT_FINGERS]
        thumb = [V((-0.050, -0.150, -0.085)), V((-0.037, -0.100, -0.041)), V((-0.0280, -0.061, -0.0262)),
                 V((-0.0266, -0.035, -0.0238))]
        thumb_r = [0.0150, 0.0112, 0.0100, 0.0092]
        extra = LEFT_EXTRA + 0.002
    mcps = [c[1] for c in chains]
    K = sum(mcps, V()) / len(mcps)
    cfg['K'] = K
    # Fingers (rigid on the hand bone).
    for chain, r in zip(chains, radii):
        arms.tube(chain, [r * 1.08, r * 1.08, r, r * 0.97, r * 0.9], side, GLOVE_RG, 0.25, rigid=True, segs=10, sub=3,
                  up=(K - W).normalized(), round0=True)
    # Thumb, from the thenar pad to the tip.
    arms.tube(thumb, thumb_r, side, GLOVE_RG, 0.25, rigid=True, segs=10, sub=3, up=(K - W).normalized(),
              round0=True)
    # Palm: superellipse sections from the wrist to just past the knuckle line, pushed out of the grip.
    L = (K - W).normalized()
    Wv = (mcps[0] - mcps[-1])
    Wv = (Wv - L * Wv.dot(L)).normalized()
    e2 = L.cross(Wv)
    segs = 16
    secs = [(-0.022, 0.024, 0.021), (0.0, 0.031, 0.0230), (0.25, 0.038, 0.020), (0.5, 0.042, 0.018),
            (0.75, 0.045, 0.016), (0.95, 0.045, 0.0145), (1.08, 0.042, 0.012), (1.16, 0.034, 0.008)]
    span = (K - W).length
    rings, vs = [], []
    for t, w, h in secs:
        c = W + L * (span * t if t > 0 else t)
        ring = []
        for k in range(segs):
            th = 2 * math.pi * k / segs
            cu, su = math.cos(th), math.sin(th)
            x = math.copysign(abs(cu) ** (2 / 2.6), cu) * w
            y = math.copysign(abs(su) ** (2 / 2.6), su) * h
            ring.append(push_out_of_grip(c + Wv * x + e2 * y, extra))
        rings.append(ring)
        vs.append((span * t) / 0.25 + 0.1)
    arms.rings(rings, vs, GLOVE_RG, side, False, close0=True, close1=True)
    # Glove cuff and jacket sleeve.
    E, S = cfg['E'], cfg['S']
    dF = (W - E).normalized()
    arms.tube([W - dF * 0.080, W - dF * 0.040, W - L * 0.006], [0.031, 0.0295, 0.0200], side, GCUFF_RG, 0.25,
              segs=16, sub=2, up=Wv, round1=False, flat1=True)
    Wc = W - dF * 0.040

    def folds(th, ln):
        return 1.0 + 0.045 * math.sin(3 * th + 11 * ln) + 0.03 * math.sin(5 * th - 17 * ln + 1.3)

    # The sleeve: shoulder -> elbow -> just short of the wrist, with cloth folds; then a cuff band.
    ctrl = [S, (S + E) / 2, E, E + (Wc - E) * 0.5, Wc - dF * 0.045]
    sleeve_len = sum((b - a).length for a, b in zip(ctrl, ctrl[1:]))

    def sleeve_folds(th, ln):
        fade = min(max((sleeve_len - 0.035 - ln) / 0.03, 0.0), 1.0)
        return 1.0 + (folds(th, ln) - 1.0) * fade

    arms.tube(ctrl, [0.060, 0.056, 0.052, 0.047, 0.043], side, JACKET_RG, 0.75, segs=18, sub=3, up=V((0, 0, 1)),
              round1=False, flat0=True, wobble=sleeve_folds)
    arms.tube([Wc - dF * 0.046, Wc - dF * 0.020, Wc - dF * 0.002, Wc - dF * 0.0005],
              [0.0455, 0.0465, 0.0460, 0.0420], side, CUFF_RG, 0.25, segs=18, sub=1, up=V((0, 0, 1)), round1=False,
              flat1=True)


def seg_dist(p, a, b):
    ab = b - a
    t = min(max((p - a).dot(ab) / ab.length_squared, 0.0), 1.0)
    return (p - (a + ab * t)).length


def build_arms(mat):
    arms = Arms()
    for side in ('L', 'R'):
        build_hand(arms, side)
    bm = arms.bm
    bm.verts.index_update()
    dl = bm.verts.layers.deform.verify()
    for v, (side, rigid) in zip(bm.verts, arms.tags):
        cfg = ARM[side]
        idx = {n: BONE_NAMES.index(f'{n}_{side}') for n in ('upperarm', 'forearm', 'hand')}
        if rigid:
            v[dl][idx['hand']] = 1.0
            continue
        segs = {'upperarm': (cfg['S'], cfg['E']), 'forearm': (cfg['E'], cfg['W']), 'hand': (cfg['W'], cfg['K'])}
        w = {n: 1.0 / (seg_dist(v.co, *ab) + 0.006) ** 6 for n, ab in segs.items()}
        tot = sum(w.values())
        w = {n: x / tot for n, x in w.items() if x / tot > 0.02}
        tot = sum(w.values())
        for n, x in w.items():
            v[dl][idx[n]] = x / tot
    obj = obj_from_bm('vm_arms', bm)
    obj.data.materials.append(mat)
    for n in BONE_NAMES:
        obj.vertex_groups.new(name=n)
    return obj


# ----------------------------------------------------------------------------------------------------------------------
# Textures and materials
# ----------------------------------------------------------------------------------------------------------------------
def smooth_noise(h, w, cells, seed, octaves=3):
    rng = np.random.default_rng(seed)
    out = np.zeros((h, w))
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        c = cells * 2 ** o
        g = rng.random((c + 1, c + 1))
        ys, xs = np.linspace(0, c, h, endpoint=False), np.linspace(0, c, w, endpoint=False)
        y0, x0 = ys.astype(int), xs.astype(int)
        fy, fx = ys - y0, xs - x0
        fy, fx = fy * fy * (3 - 2 * fy), fx * fx * (3 - 2 * fx)
        a, b = g[y0][:, x0], g[y0][:, x0 + 1]
        cc, d = g[y0 + 1][:, x0], g[y0 + 1][:, x0 + 1]
        out += amp * ((a * (1 - fx) + b * fx) * (1 - fy)[:, None] + (cc * (1 - fx) + d * fx) * fy[:, None])
        tot += amp
        amp *= 0.5
    return out / tot


def px(region, n):
    u0, v0, u1, v1 = region
    return slice(int(round((1 - v1) * n)), int(round((1 - v0) * n))), slice(int(round(u0 * n)), int(round(u1 * n)))


def height_to_normal(hgt, strength):
    dx = (np.roll(hgt, -1, 1) - np.roll(hgt, 1, 1)) * 0.5
    dy = (np.roll(hgt, -1, 0) - np.roll(hgt, 1, 0)) * 0.5
    n = np.stack([-dx * strength, dy * strength, np.ones_like(hgt)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def tiled_noise(tile, seed, blur=1):
    rng = np.random.default_rng(seed)
    t = rng.random((tile, tile))
    for _ in range(blur):
        t = (t + np.roll(t, 1, 0) + np.roll(t, -1, 0) + np.roll(t, 1, 1) + np.roll(t, -1, 1)) / 5
    return t


def stipple_tile(tile=48, spacing=6, radius=1.9, seed=5):
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:tile, 0:tile]
    hgt = np.zeros((tile, tile))
    for gy in range(0, tile, spacing):
        for gx in range(0, tile, spacing):
            cy = gy + spacing / 2 + rng.uniform(-1.3, 1.3)
            cx = gx + spacing / 2 + rng.uniform(-1.3, 1.3)
            r = radius * rng.uniform(0.8, 1.15)
            dy = (yy - cy + tile / 2) % tile - tile / 2
            dx = (xx - cx + tile / 2) % tile - tile / 2
            d = np.sqrt(dx * dx + dy * dy) / r
            hgt = np.maximum(hgt, np.clip(1 - d * d, 0, 1))
    return hgt


def fill(img, region, n, value):
    rs, cs = px(region, n)
    img[rs, cs, :len(value)] = value


def gun_textures():
    n = 512
    base = np.ones((n, n, 4))
    mott = smooth_noise(n, n, 6, 11)
    for region, col, amp in [(SLIDE_RG, (0.205, 0.213, 0.222), 0.035), (FRAME_RG, (0.115, 0.117, 0.118), 0.03),
                             (DARK_RG, (0.135, 0.137, 0.140), 0.03), (STIPPLE_RG, (0.098, 0.099, 0.100), 0.02),
                             (BRIGHT_RG, (0.50, 0.51, 0.53), 0.04), (LENS_RG, (0.92, 0.92, 0.88), 0.0),
                             (BRASS_RG, (0.76, 0.58, 0.30), 0.04), (RUBBER_RG, (0.07, 0.07, 0.07), 0.0)]:
        rs, cs = px(region, n)
        m = 1 + (mott[rs, cs] - 0.5) * 2 * amp
        base[rs, cs, :3] = np.array(col)[None, None, :] * m[..., None]
    orm = np.ones((n, n, 4))
    rough_n = smooth_noise(n, n, 8, 12)
    for region, rough, metal, amp in [(SLIDE_RG, 0.36, 0.85, 0.08), (FRAME_RG, 0.66, 0.0, 0.05),
                                      (DARK_RG, 0.48, 0.55, 0.06), (STIPPLE_RG, 0.86, 0.0, 0.0),
                                      (BRIGHT_RG, 0.30, 1.0, 0.05), (LENS_RG, 0.05, 0.0, 0.0),
                                      (BRASS_RG, 0.32, 1.0, 0.05), (RUBBER_RG, 0.9, 0.0, 0.0)]:
        rs, cs = px(region, n)
        orm[rs, cs, 1] = np.clip(rough + (rough_n[rs, cs] - 0.5) * 2 * amp, 0, 1)
        orm[rs, cs, 2] = metal
    nn = 1024
    nrm = np.zeros((nn, nn, 4))
    nrm[..., :] = (0.5, 0.5, 1.0, 1.0)
    rs, cs = px(FRAME_RG, nn)
    tile = height_to_normal(tiled_noise(8, 3, 0), 0.12)      # faint moulded-polymer grain
    nrm[rs, cs, :3] = np.tile(tile, ((rs.stop - rs.start) // 8 + 1, (cs.stop - cs.start) // 8 + 1, 1))[
        :rs.stop - rs.start, :cs.stop - cs.start]
    rs, cs = px(STIPPLE_RG, nn)
    tile = height_to_normal(stipple_tile(), 2.2)
    nrm[rs, cs, :3] = np.tile(tile, ((rs.stop - rs.start) // 48 + 1, (cs.stop - cs.start) // 48 + 1, 1))[
        :rs.stop - rs.start, :cs.stop - cs.start]
    ne = 32
    emi = np.zeros((ne, ne, 4))
    emi[..., 3] = 1.0
    fill(emi, LENS_RG, ne, (1.0, 0.96, 0.85))
    return (common.image_from_array('vm_gun_base', base), common.image_from_array('vm_gun_orm', orm),
            common.image_from_array('vm_gun_normal', nrm), common.image_from_array('vm_gun_emit', emi))


def arm_textures():
    n = 512
    base = np.ones((n, n, 4))
    mott = smooth_noise(n, n, 8, 21)
    for region, col, amp in [(GLOVE_RG, (0.155, 0.158, 0.140), 0.08), (JACKET_RG, (0.300, 0.318, 0.200), 0.10),
                             (CUFF_RG, (0.270, 0.288, 0.180), 0.10), (GCUFF_RG, (0.085, 0.086, 0.082), 0.05)]:
        rs, cs = px(region, n)
        m = 1 + (mott[rs, cs] - 0.5) * 2 * amp
        base[rs, cs, :3] = np.array(col)[None, None, :] * m[..., None]
    nrm = np.zeros((n, n, 4))
    nrm[..., :] = (0.5, 0.5, 1.0, 1.0)
    rs, cs = px(GLOVE_RG, n)
    tile = height_to_normal(tiled_noise(16, 7, 1), 0.9)
    nrm[rs, cs, :3] = np.tile(tile, ((rs.stop - rs.start) // 16 + 1, (cs.stop - cs.start) // 16 + 1, 1))[
        :rs.stop - rs.start, :cs.stop - cs.start]
    # Canvas: soft crumples (the threads are far below a texel at this density).
    tile = height_to_normal(tiled_noise(64, 9, 8) * 6.0, 0.6)
    for region in (JACKET_RG, CUFF_RG):
        rs, cs = px(region, n)
        nrm[rs, cs, :3] = np.tile(tile, ((rs.stop - rs.start) // 64 + 1, (cs.stop - cs.start) // 64 + 1, 1))[
            :rs.stop - rs.start, :cs.stop - cs.start]
    rs, cs = px(GCUFF_RG, n)
    ribs = np.tile(np.sin(np.pi * (np.arange(6) / 6.0))[:, None], (1, 6))
    tile = height_to_normal(ribs, 0.8)
    nrm[rs, cs, :3] = np.tile(tile, ((rs.stop - rs.start) // 6 + 1, (cs.stop - cs.start) // 6 + 1, 1))[
        :rs.stop - rs.start, :cs.stop - cs.start]
    return common.image_from_array('vm_arms_base', base), common.image_from_array('vm_arms_normal', nrm)


def gun_material(base, orm, nrm, emi):
    mat = bpy.data.materials.new('vm_gun')
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes['Principled BSDF']
    tb = nodes.new('ShaderNodeTexImage')
    tb.image = base
    links.new(tb.outputs['Color'], bsdf.inputs['Base Color'])
    to = nodes.new('ShaderNodeTexImage')
    to.image = orm
    orm.colorspace_settings.name = 'Non-Color'
    sep = nodes.new('ShaderNodeSeparateColor')
    links.new(to.outputs['Color'], sep.inputs['Color'])
    links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
    links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    tn = nodes.new('ShaderNodeTexImage')
    tn.image = nrm
    nrm.colorspace_settings.name = 'Non-Color'
    nm = nodes.new('ShaderNodeNormalMap')
    links.new(tn.outputs['Color'], nm.inputs['Color'])
    links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    te = nodes.new('ShaderNodeTexImage')
    te.image = emi
    links.new(te.outputs['Color'], bsdf.inputs['Emission Color'])
    bsdf.inputs['Emission Strength'].default_value = 1.0
    return mat


def srgb_to_linear(c):
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


# ----------------------------------------------------------------------------------------------------------------------
# Rig
# ----------------------------------------------------------------------------------------------------------------------
def mag_axis_mat():
    return GRIP_TOP + GD * MAG_BOT_S, GRIP_TOP + GD * 0.075


def build_rig(root):
    data = bpy.data.armatures.new('vm_rig')
    arm = link(bpy.data.objects.new('vm_rig', data))
    arm.parent = root
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = data.edit_bones

    def bone(name, head, tail, parent=None, z=None):
        b = eb.new(name)
        b.head, b.tail = V(head), V(tail)
        if z is not None:
            b.align_roll(V(z))
        if parent:
            b.parent = eb[parent]
            b.use_connect = False
        return b

    bone('gun_root', (0, 0, 0), (0, 0.08, 0), z=(0, 0, 1))
    bone('slide', (0, SLIDE_Y0 + 0.02, 0.025), (0, SLIDE_Y0 + 0.08, 0.025), 'gun_root', z=(0, 0, 1))
    bone('trigger', TRIGGER_PIVOT, TRIGGER_PIVOT + V((0, -0.004, -0.024)), 'gun_root', z=(0, 1, 0))
    hp = HAMMER_PIVOT
    bone('hammer', hp, hp + V((0, -math.sin(HAMMER_COCKED), math.cos(HAMMER_COCKED))) * 0.022, 'gun_root',
         z=(0, -math.cos(HAMMER_COCKED), -math.sin(HAMMER_COCKED)))
    mh, mt = mag_axis_mat()
    bone('magazine', mh, mt, 'gun_root', z=GF)
    for side in ('L', 'R'):
        cfg = ARM[side]
        S, E, W, K = cfg['S'], cfg['E'], cfg['W'], cfg['K']
        bend = (E - S).cross(W - E).normalized()
        bone(f'upperarm_{side}', S, E, z=bend)
        bone(f'forearm_{side}', E, W, f'upperarm_{side}', z=bend)
        bone(f'hand_{side}', W, K, f'forearm_{side}', z=bend)
    bpy.ops.object.mode_set(mode='OBJECT')
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    return arm


def parent_to_bone(obj, arm, bone):
    world = obj.matrix_world.copy()
    obj.parent = arm
    obj.parent_type = 'BONE'
    obj.parent_bone = bone
    bpy.context.view_layer.update()
    obj.matrix_world = world


# ----------------------------------------------------------------------------------------------------------------------
# Animation: every frame is computed in armature space, then converted to bone-local keys
# ----------------------------------------------------------------------------------------------------------------------
GRIP_PIVOT = V((0.0, -0.09, -0.06))


def gun_delta(t=(0, 0, 0), e=(0, 0, 0)):
    """Gun motion: rotate (pitch, roll, yaw degrees) about the grip, then translate."""
    rot = Euler((R(e[0]), R(e[1]), R(e[2])), 'XYZ').to_matrix().to_4x4()
    return Matrix.Translation(GRIP_PIVOT + V(t)) @ rot @ Matrix.Translation(-GRIP_PIVOT)


def hermite_keys(keys, f):
    """Catmull-Rom (C1) through keys [(frame, tuple)], clamped at the ends."""
    fs = [k[0] for k in keys]
    vals = [np.array(k[1], float) for k in keys]
    if f <= fs[0]:
        return vals[0]
    if f >= fs[-1]:
        return vals[-1]
    i = max(j for j in range(len(fs) - 1) if fs[j] <= f)
    f0, f1 = fs[i], fs[i + 1]
    p0, p1 = vals[i], vals[i + 1]
    m0 = np.zeros_like(p0) if i == 0 else (vals[i + 1] - vals[i - 1]) / (fs[i + 1] - fs[i - 1]) * (f1 - f0)
    m1 = np.zeros_like(p0) if i + 1 == len(fs) - 1 else (vals[i + 2] - vals[i]) / (fs[i + 2] - fs[i]) * (f1 - f0)
    t = (f - f0) / (f1 - f0)
    h00, h10, h01, h11 = 2 * t ** 3 - 3 * t ** 2 + 1, t ** 3 - 2 * t ** 2 + t, -2 * t ** 3 + 3 * t ** 2, t ** 3 - t ** 2
    return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1


def smoothstep(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


def blend(A, B, w):
    la, ra, _ = A.decompose()
    lb, rb, _ = B.decompose()
    return Matrix.Translation(la.lerp(lb, w)) @ ra.slerp(rb, w).to_matrix().to_4x4()


class Poser:
    def __init__(self, arm):
        self.arm = arm
        self.rest = {b.name: b.matrix_local.copy() for b in arm.data.bones}
        self.ik = {}
        for side in ('L', 'R'):
            S = self.rest[f'upperarm_{side}'].translation
            E = self.rest[f'forearm_{side}'].translation
            W = self.rest[f'hand_{side}'].translation
            u = (W - S).normalized()
            pole = ((E - S) - u * (E - S).dot(u)).normalized()
            self.ik[side] = dict(S=S, E=E, W=W, a=(E - S).length, b=(W - E).length, pole=pole)
        self.prev_q = {}

    def solve_arm(self, side, hand):
        k = self.ik[side]
        S, a, b = k['S'], k['a'], k['b']
        W = hand.translation
        d = W - S
        ln = d.length
        assert abs(a - b) + 1e-4 < ln < a + b - 1e-4, f'{side} wrist out of reach ({ln:.3f} vs {a + b:.3f})'
        u = d / ln
        ca = (a * a + ln * ln - b * b) / (2 * a * ln)
        v = (k['pole'] - u * k['pole'].dot(u)).normalized()
        E = S + (u * ca + v * math.sqrt(max(0.0, 1 - ca * ca))) * a

        def frame(y, n):
            y = y.normalized()
            x = (n - y * n.dot(y)).normalized()
            return Matrix((x, y, x.cross(y))).transposed()

        n0 = (k['E'] - S).cross(k['W'] - k['E'])
        n1 = (E - S).cross(W - E)
        ru = frame(E - S, n1) @ frame(k['E'] - S, n0).transposed()
        rf = frame(W - E, n1) @ frame(k['W'] - k['E'], n0).transposed()
        up = Matrix.Translation(S) @ (ru @ self.rest[f'upperarm_{side}'].to_3x3()).to_4x4()
        fo = Matrix.Translation(E) @ (rf @ self.rest[f'forearm_{side}'].to_3x3()).to_4x4()
        return up, fo

    def pose(self, dg, slide=0.0, trigger=0.0, hammer=None, mag=None, hand_l=None):
        """Armature-space matrices for every bone. dg: gun delta. slide: metres back. trigger: degrees (negative
        pulls). hammer: degrees back from vertical (rest 50). mag / hand_l: armature-space overrides."""
        rest = self.rest
        P = {'gun_root': dg @ rest['gun_root'],
             'slide': dg @ Matrix.Translation((0, -slide, 0)) @ rest['slide']}
        tp, hp = TRIGGER_PIVOT, HAMMER_PIVOT
        P['trigger'] = dg @ Matrix.Translation(tp) @ Matrix.Rotation(R(trigger), 4, 'X') @ Matrix.Translation(-tp) \
            @ rest['trigger']
        hang = R((hammer if hammer is not None else 50.0) - 50.0)
        P['hammer'] = dg @ Matrix.Translation(hp) @ Matrix.Rotation(hang, 4, 'X') @ Matrix.Translation(-hp) \
            @ rest['hammer']
        P['magazine'] = mag if mag is not None else dg @ rest['magazine']
        hands = {'R': dg @ rest['hand_R'], 'L': hand_l if hand_l is not None else dg @ rest['hand_L']}
        for side in ('L', 'R'):
            P[f'upperarm_{side}'], P[f'forearm_{side}'] = self.solve_arm(side, hands[side])
            P[f'hand_{side}'] = hands[side]
        return P

    def key(self, P, frame):
        for pb in self.arm.pose.bones:
            b = pb.bone
            if b.parent:
                rel = self.rest[b.parent.name].inverted() @ self.rest[b.name]
                basis = rel.inverted() @ P[b.parent.name].inverted() @ P[b.name]
            else:
                basis = self.rest[b.name].inverted() @ P[b.name]
            loc, rot, _ = basis.decompose()
            q = self.prev_q.get(b.name)
            if q is not None and q.dot(rot) < 0:
                rot = -rot
            self.prev_q[b.name] = rot.copy()
            pb.location = loc
            pb.rotation_quaternion = rot
            pb.scale = (1, 1, 1)
            pb.keyframe_insert('location', frame=frame, group=b.name)
            pb.keyframe_insert('rotation_quaternion', frame=frame, group=b.name)


def make_clip(poser, name, frames, fn):
    arm = poser.arm
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data.action = act
    poser.prev_q = {}
    for f in range(frames + 1):
        poser.key(fn(f), f)
    for fc in act.fcurves:
        for kp in fc.keyframe_points:
            kp.interpolation = 'LINEAR'
    act.use_frame_range = True
    act.frame_start, act.frame_end = 0, frames
    return act


def clips(poser):
    rest = poser.rest
    tau = 2 * math.pi

    def idle(f):
        ph = tau * f / 60
        dg = gun_delta((0.0007 * math.sin(2 * ph), 0.0, 0.0016 * math.sin(ph)),
                       (0.35 * math.sin(ph + 0.6), 0.25 * math.sin(ph + 1.9), 0.15 * math.sin(2 * ph)))
        return poser.pose(dg)

    FIRE = [  # frame: slide back (m), trigger (deg), hammer (deg back), gun kick (y, pitch)
        (0.0, 0, 50, 0.0, 0.0), (0.042, -16, 82, -0.004, 1.2), (0.036, -16, 80, -0.003, 1.0),
        (0.020, -10, 66, -0.0015, 0.5), (0.007, -4, 54, -0.0005, 0.15), (0.001, 0, 50, 0.0, 0.0),
        (0.0, 0, 50, 0.0, 0.0)]

    def fire(f):
        s, t, h, ky, kp = FIRE[f]
        return poser.pose(gun_delta((0, ky, 0), (kp, 0, 0)), slide=s, trigger=t, hammer=h)

    EMPTY = [(0.0, 0, 50, 0.0, 0.0), (0.042, -16, 82, -0.004, 1.2), (0.038, -10, 79, -0.002, 0.6),
             (0.038, -4, 79, -0.0005, 0.15), (0.038, 0, 79, 0.0, 0.0)]

    def empty(f):
        s, t, h, ky, kp = EMPTY[f]
        return poser.pose(gun_delta((0, ky, 0), (kp, 0, 0)), slide=s, trigger=t, hammer=h)

    def sprint(f):
        ph = tau * f / 20
        dg = gun_delta((-0.024 + 0.006 * math.sin(ph), -0.025, -0.032 + 0.007 * abs(math.sin(ph))),
                       (-22 + 2.0 * math.sin(2 * ph), -18 + 3.0 * math.sin(ph), 12 + 1.5 * math.sin(ph)))
        return poser.pose(dg)

    gun_keys = [(0, (0, 0, 0, 0, 0, 0)), (5, (-0.012, -0.004, 0.012, 12, 22, -4)),
                (12, (-0.015, -0.004, 0.016, 14, 26, -5)), (19, (-0.016, -0.002, 0.018, 12, 27, -6)),
                (23, (-0.016, -0.002, 0.016, 10, 26, -6)), (25, (-0.016, 0.0, 0.026, 16, 24, -6)),
                (28, (-0.014, -0.002, 0.016, 9, 22, -5)), (33, (-0.004, -0.001, 0.004, 2, 6, -1)),
                (38, (0, 0, 0, 0, 0, 0))]
    free_keys = [(2, (0, 0, 0, 0, 0, 0)), (7, (-0.03, -0.05, -0.10, -25, 10, 25)),
                 (11, (-0.08, -0.09, -0.20, -40, 15, 35)), (15, (-0.08, -0.09, -0.20, -40, 15, 35)),
                 (20, (-0.02, -0.03, -0.10, -10, 5, 10))]
    depth_keys = [(17, (0.11,)), (20, (0.050,)), (22, (0.024,)), (24, (0.008,)), (25, (0.0,)), (27, (0.0,))]
    SEAT = 0.075
    WL0 = rest['hand_L'].translation
    seat_hand = Matrix.Translation(GD * SEAT) @ rest['hand_L']
    carry = seat_hand.inverted() @ rest['magazine']

    def reload(f):
        g = hermite_keys(gun_keys, f)
        dg = gun_delta(g[:3], g[3:])
        attached = dg @ rest['hand_L']
        fk = hermite_keys(free_keys, f)
        free = Matrix.Translation(WL0 + V(fk[:3])) @ Euler((R(fk[3]), R(fk[4]), R(fk[5])), 'XYZ').to_matrix(
        ).to_4x4() @ Matrix.Translation(-WL0) @ rest['hand_L']
        depth = float(hermite_keys(depth_keys, f)[0])
        insert = dg @ Matrix.Translation(GD * (SEAT + depth)) @ rest['hand_L']
        if f <= 2:
            hand = attached
        elif f <= 7:
            hand = blend(attached, free, smoothstep((f - 2) / 5))
        elif f <= 16:
            hand = free
        elif f <= 21:
            hand = blend(free, insert, smoothstep((f - 16) / 5))
        elif f <= 27:
            hand = insert
        else:
            hand = blend(dg @ Matrix.Translation(GD * SEAT) @ rest['hand_L'], attached, smoothstep((f - 27) / 7))
        # Magazine: seated, then pushed out along the grip and dropping; from frame 13 the new one rides in the hand.
        if f < 4:
            mag = dg @ rest['magazine']
        elif f <= 12:
            t = (f - 4) / 30
            out = min(0.035, 0.6 * t + 4.0 * t * t)
            mag = Matrix.Translation((0, 0, -0.5 * 9.8 * max(0.0, t - 0.02) ** 2 * 1.6)) @ dg @ \
                Matrix.Translation(GD * out) @ rest['magazine']
        elif f < 25:
            mag = hand @ carry
        else:
            mag = dg @ rest['magazine']
        return poser.pose(dg, mag=mag, hand_l=hand)

    return [('idle', 60, idle), ('fire', 6, fire), ('reload', 38, reload), ('empty', 4, empty),
            ('sprint', 20, sprint)]


# ----------------------------------------------------------------------------------------------------------------------
# Build
# ----------------------------------------------------------------------------------------------------------------------
def main():
    scene = common.reset_scene()
    scene.frame_start, scene.frame_end = 0, 60
    base, orm, nrm, emi = gun_textures()
    m_gun = gun_material(base, orm, nrm, emi)
    green = srgb_to_linear((0x68 / 255, 0xff / 255, 0xa2 / 255))
    m_tri = common.material('tritium', color=green, roughness=0.25, emission=green, emission_strength=1.0)
    abase, anrm = arm_textures()
    m_arms = common.material('vm_arms', color=(1, 1, 1), roughness=0.82, base_image=abase, normal_image=anrm,
                             normal_strength=0.8)

    frame = build_frame([m_gun])
    slide = build_slide([m_gun, m_tri])
    trigger = build_trigger([m_gun])
    hammer = build_hammer([m_gun])
    magazine = build_magazine([m_gun])
    arms = build_arms(m_arms)          # also fills ARM[...]['K'] (knuckle centres) used by the rig

    root = link(bpy.data.objects.new('vm_root', None))
    root.empty_display_type = 'PLAIN_AXES'
    root.empty_display_size = 0.05
    arm = build_rig(root)
    for obj, bone in ((frame, 'gun_root'), (slide, 'slide'), (trigger, 'trigger'), (hammer, 'hammer'),
                      (magazine, 'magazine')):
        parent_to_bone(obj, arm, bone)
    arms.parent = arm
    mod = arms.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm

    for name, loc, bone in (('SOCKET_muzzle', (0.0, SUP_Y1, BORE_Z), 'gun_root'),
                            ('SOCKET_eject', (0.0170, -0.014, 0.0345), 'slide'),
                            ('SOCKET_light', (0.0, LENS_Y + 0.0004, LIGHT_Z), 'gun_root')):
        common.empty(name, loc, parent=arm, parent_bone=bone, size=0.02)
    for m in (m_gun, m_tri, m_arms):
        m.use_backface_culling = True

    arm.animation_data_create()
    poser = Poser(arm)
    for name, frames, fn in clips(poser):
        make_clip(poser, name, frames, fn)
    arm.animation_data.action = None
    for pb in arm.pose.bones:
        pb.location, pb.rotation_quaternion, pb.scale = (0, 0, 0), (1, 0, 0, 0), (1, 1, 1)
    scene.frame_set(0)

    gun = [frame, slide, trigger, hammer, magazine]
    print('TRIS gun', common.triangle_count(gun), 'arms', common.triangle_count([arms]))
    path = common.export_glb('vm_pistol.glb')
    print('EXPORTED', path, path.stat().st_size)

    if '--no-preview' not in ARGS:
        previews(arm, arms)


def set_clip(arm, name, frame):
    arm.animation_data.action = bpy.data.actions[name]
    bpy.context.scene.frame_set(frame)


def previews(arm, arms):
    """Review renders (after the export, so the helpers never reach the glb). A fill light from the left joins
    common.render_preview's sun so the support hand is readable."""
    fill = link(bpy.data.objects.new('preview_fill', bpy.data.lights.new('preview_fill', 'SUN')))
    fill.data.energy = 1.4
    fill.rotation_euler = (1.0, -0.3, -2.4)
    vfov_lens = 18 / math.tan(R(72) / 2) / (16 / 9)     # 72 deg vertical at 16:9, as the game's default
    common.render_preview('vm_pistol.png', (0.50, 0.36, 0.03), target=(0.0, 0.04, -0.05), lens=42)
    arms.hide_render = True
    common.render_preview('vm_pistol_side.png', (0.80, 0.08, -0.02), target=(0.0, 0.08, -0.02), lens=50,
                          resolution=(1400, 800))
    arms.hide_render = False
    common.render_preview('vm_pistol_left.png', (-0.55, 0.0, 0.02), target=(0.0, 0.0, -0.05), lens=50)
    common.render_preview('vm_pistol_fp.png', (-0.22, -0.44, 0.20), target=(-0.22, 0.56, 0.20), lens=vfov_lens,
                          resolution=(1280, 720))
    common.render_preview('vm_pistol_ads.png', (0.0, -0.29, 0.056), target=(0.0, 0.71, 0.056), lens=vfov_lens,
                          resolution=(1280, 720))
    set_clip(arm, 'reload', 21)
    common.render_preview('vm_pistol_reload.png', (-0.40, -0.25, 0.10), target=(0.0, 0.0, -0.08), lens=40)
    set_clip(arm, 'sprint', 5)
    common.render_preview('vm_pistol_sprint.png', (-0.22, -0.44, 0.20), target=(-0.22, 0.56, 0.20), lens=vfov_lens,
                          resolution=(1280, 720))
    arm.animation_data.action = None
    bpy.data.objects.remove(fill, do_unlink=True)


main()
