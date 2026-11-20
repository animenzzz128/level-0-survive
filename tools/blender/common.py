"""Shared helpers for the model build scripts (Blender 4.5, background mode).

Import from a build script with:
    import sys, pathlib; sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent)); import common
See docs/design/art/model-contract.md for what each model must contain.
"""
import pathlib
import sys

import bpy
import numpy as np
from mathutils import Matrix

REPO = pathlib.Path(__file__).resolve().parents[2]
MODELS = REPO / 'public' / 'assets' / 'models'
FPS = 30


def args_after_dashdash():
    """Arguments after `--` on the Blender command line."""
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def reset_scene():
    """Empty scene, metres, 30 fps."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = FPS
    return scene


def image_from_array(name, rgba):
    """Packed image from a float array (H, W, 4) in 0..1, row 0 at the top."""
    h, w, _ = rgba.shape
    img = bpy.data.images.new(name, width=w, height=h, alpha=True)
    img.pixels.foreach_set(np.ascontiguousarray(rgba[::-1]).astype(np.float32).ravel())
    img.pack()
    return img


def material(name, color=(0.8, 0.8, 0.8), metallic=0.0, roughness=0.6, emission=None, emission_strength=1.0,
             alpha=None, base_image=None, normal_image=None, normal_strength=1.0, roughness_image=None):
    """Principled BSDF material. Colours are sRGB-ish 0..1 tuples; images come from image_from_array."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*color, 1.0)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    if base_image is not None:
        tex = nodes.new('ShaderNodeTexImage')
        tex.image = base_image
        links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    if roughness_image is not None:
        tex = nodes.new('ShaderNodeTexImage')
        tex.image = roughness_image
        tex.image.colorspace_settings.name = 'Non-Color'
        links.new(tex.outputs['Color'], bsdf.inputs['Roughness'])
    if normal_image is not None:
        tex = nodes.new('ShaderNodeTexImage')
        tex.image = normal_image
        tex.image.colorspace_settings.name = 'Non-Color'
        nmap = nodes.new('ShaderNodeNormalMap')
        nmap.inputs['Strength'].default_value = normal_strength
        links.new(tex.outputs['Color'], nmap.inputs['Color'])
        links.new(nmap.outputs['Normal'], bsdf.inputs['Normal'])
    if emission is not None:
        bsdf.inputs['Emission Color'].default_value = (*emission, 1.0)
        bsdf.inputs['Emission Strength'].default_value = emission_strength
    if alpha is not None:
        bsdf.inputs['Alpha'].default_value = alpha
        mat.blend_method = 'BLEND'
    return mat


def assign(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    return obj


def apply_transforms(objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)


def empty(name, location=(0, 0, 0), parent=None, parent_bone=None, size=0.05):
    """Socket Empty. With parent_bone, the Empty follows that bone (location stays in world space)."""
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = 'PLAIN_AXES'
    e.empty_display_size = size
    bpy.context.scene.collection.objects.link(e)
    e.location = location
    if parent is not None:
        world = Matrix.Translation(location)
        e.parent = parent
        if parent_bone:
            e.parent_type = 'BONE'
            e.parent_bone = parent_bone
        bpy.context.view_layer.update()
        e.matrix_world = world
    return e


def triangle_count(objs=None):
    objs = objs or [o for o in bpy.context.scene.objects if o.type == 'MESH']
    dg = bpy.context.evaluated_depsgraph_get()
    total = 0
    for o in objs:
        mesh = o.evaluated_get(dg).to_mesh()
        mesh.calc_loop_triangles()
        total += len(mesh.loop_triangles)
        o.evaluated_get(dg).to_mesh_clear()
    return total


def export_glb(filename, animations=True, directory=None):
    """Export the whole scene to public/assets/models/<filename> (or another directory, for tests)."""
    target = pathlib.Path(directory) if directory else MODELS
    target.mkdir(parents=True, exist_ok=True)
    path = target / filename
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format='GLB',
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials='EXPORT',
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_skins=True,
        export_morph=True,
        export_animations=animations,
        export_animation_mode='ACTIONS',
        export_force_sampling=True,
        export_frame_step=1,
    )
    return path


def render_preview(filename, camera_location, target=(0, 0, 1.0), lens=50, resolution=(900, 900), directory=None):
    """Quick preview render to tools/blender/previews/<filename> (Cycles on the CPU, few samples)."""
    scene = bpy.context.scene
    out = (pathlib.Path(directory) if directory else REPO / 'tools' / 'blender' / 'previews') / filename
    out.parent.mkdir(parents=True, exist_ok=True)
    cam_data = bpy.data.cameras.new('preview_cam')
    cam_data.lens = lens
    cam = bpy.data.objects.new('preview_cam', cam_data)
    scene.collection.objects.link(cam)
    cam.location = camera_location
    direction = np.array(target) - np.array(camera_location)
    cam.rotation_mode = 'QUATERNION'
    from mathutils import Vector
    cam.rotation_quaternion = Vector(direction).to_track_quat('-Z', 'Y')
    scene.camera = cam
    sun_data = bpy.data.lights.new('preview_sun', 'SUN')
    sun_data.energy = 3.0
    sun = bpy.data.objects.new('preview_sun', sun_data)
    sun.rotation_euler = (0.9, 0.2, 0.6)
    scene.collection.objects.link(sun)
    if scene.world is None:
        scene.world = bpy.data.worlds.new('preview_world')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.35, 0.35, 0.35, 1)
    scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.8
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 24
    scene.render.resolution_x, scene.render.resolution_y = resolution
    scene.render.filepath = str(out)
    bpy.ops.render.render(write_still=True)
    # Remove the preview helpers so they never end up in an export.
    for o in (cam, sun):
        bpy.data.objects.remove(o, do_unlink=True)
    return out
