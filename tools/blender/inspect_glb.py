"""Re-import a .glb in an empty scene and write tools/blender/reports/<name>.json.

Run: blender --background --factory-startup --python tools/blender/inspect_glb.py -- public/assets/models/props.glb
The report lists nodes (with parents), meshes with triangle counts and materials, armatures and bones, actions with
frame ranges, shape keys and the bounds of every top-level node, so a model can be checked against
docs/design/art/model-contract.md without opening Blender.
"""
import json
import pathlib
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
report['materials'] = sorted(m.name for m in bpy.data.materials)

out = common.REPO / 'tools' / 'blender' / 'reports' / (path.stem + '.json')
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(report, indent=2), encoding='utf-8')
print('REPORT', out)
