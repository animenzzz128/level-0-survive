"""Re-import a .glb in an empty scene and write tools/blender/reports/<name>.json.

Run: blender --background --factory-startup --python tools/blender/inspect_glb.py -- public/assets/models/props.glb
The report lists nodes (with parents), meshes with triangle counts and materials, armatures and bones, actions with
frame ranges, shape keys and the bounds of every top-level node, so a model can be checked against
docs/design/art/model-contract.md without opening Blender.
"""
import json
import pathlib
import struct
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import common  # noqa: E402

path = pathlib.Path(common.args_after_dashdash()[0]).resolve()
common.reset_scene()
bpy.ops.import_scene.gltf(filepath=str(path))
scene = bpy.context.scene
# The importer adds a shape object for drawing bones; it is not part of the model, so it is left out.
BONE_SHAPES = {pb.custom_shape.name for o in scene.objects if o.type == 'ARMATURE'
               for pb in o.pose.bones if pb.custom_shape is not None}
MODEL = [o for o in scene.objects if o.name not in BONE_SHAPES]
dg = bpy.context.evaluated_depsgraph_get()


def bounds(objs):
    pts = []
    for o in objs:
        if o.type == 'MESH':
            pts += [o.matrix_world @ Vector(c) for c in o.bound_box]
    if not pts:
        return None
    lo = [min(p[i] for p in pts) for i in range(3)]
    hi = [max(p[i] for p in pts) for i in range(3)]
    return {'min': [round(v, 4) for v in lo], 'max': [round(v, 4) for v in hi],
            'size': [round(hi[i] - lo[i], 4) for i in range(3)]}


def descendants(o):
    out = [o]
    for c in o.children:
        out += descendants(c)
    return out


report = {'file': path.name, 'bytes': path.stat().st_size, 'nodes': [], 'meshes': [], 'armatures': [],
          'actions': [], 'top_level_bounds': {}}
total_tris = 0
for o in MODEL:
    report['nodes'].append({'name': o.name, 'type': o.type, 'parent': o.parent.name if o.parent else None,
                            'parent_bone': o.parent_bone or None})
    if o.type == 'MESH':
        mesh = o.evaluated_get(dg).to_mesh()
        mesh.calc_loop_triangles()
        tris = len(mesh.loop_triangles)
        o.evaluated_get(dg).to_mesh_clear()
        total_tris += tris
        keys = [k.name for k in o.data.shape_keys.key_blocks] if o.data.shape_keys else []
        report['meshes'].append({'name': o.name, 'triangles': tris,
                                 'materials': [m.name for m in o.data.materials if m],
                                 'skinned': any(md.type == 'ARMATURE' for md in o.modifiers),
                                 'shape_keys': keys})
    if o.type == 'ARMATURE':
        report['armatures'].append({'name': o.name, 'bones': [b.name for b in o.data.bones]})
for a in bpy.data.actions:
    report['actions'].append({'name': a.name, 'frames': [round(a.frame_range[0], 2), round(a.frame_range[1], 2)]})
for o in MODEL:
    if o.parent is None:
        report['top_level_bounds'][o.name] = bounds(descendants(o))
report['triangles_total'] = total_tris


def rest_sockets(glb_path):
    """Rest-pose positions of HIT_*, SOCKET_* and JS_CAM, read from the file itself (three.js axes: +Y up, +Z front).

    Read from the glTF node transforms, not from the re-imported scene: the importer leaves an animation frame
    applied, and an error in how the build script parented a socket shows up here as it will in the game.
    """
    data = glb_path.read_bytes()
    length = struct.unpack_from('<I', data, 12)[0]
    nodes = json.loads(data[20:20 + length])['nodes']
    parent = {c: i for i, n in enumerate(nodes) for c in n.get('children', [])}

    def local(n):
        t = n.get('translation', [0, 0, 0])
        x, y, z, w = n.get('rotation', [0, 0, 0, 1])
        sx, sy, sz = n.get('scale', [1, 1, 1])
        r = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
             [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
             [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
        return [[r[i][0] * sx, r[i][1] * sy, r[i][2] * sz, t[i]] for i in range(3)] + [[0, 0, 0, 1]]

    def world(i):
        m = local(nodes[i])
        while i in parent:
            i = parent[i]
            pm = local(nodes[i])
            m = [[sum(pm[r][k] * m[k][c] for k in range(4)) for c in range(4)] for r in range(4)]
        return m

    out = {}
    for i, n in enumerate(nodes):
        name = n.get('name', '')
        if name.startswith(('HIT_', 'SOCKET_')) or name == 'JS_CAM':
            m = world(i)
            out[name] = [round(m[r][3], 4) for r in range(3)]
    return out


report['rest_sockets'] = rest_sockets(path)
# A socket exactly at the model origin is almost always a parenting mistake in the build script.
report['socket_warnings'] = [f'{k} is at the origin' for k, v in report['rest_sockets'].items()
                             if max(abs(c) for c in v) < 1e-3]
for warning in report['socket_warnings']:
    print('WARNING', warning)
report['materials'] = sorted(m.name for m in bpy.data.materials)

out = common.REPO / 'tools' / 'blender' / 'reports' / (path.stem + '.json')
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(report, indent=2), encoding='utf-8')
print('REPORT', out)
