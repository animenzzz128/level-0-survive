# Blender build scripts

Every 3D model in `public/assets/models/` is built by a script here, so the scripts are the source and the `.glb`
files are build output. What each model must contain is in
[docs/design/art/model-contract.md](../../docs/design/art/model-contract.md); what it should look like is in the
[art bible](../../docs/design/art/art-bible.md) and its [concepts](../../docs/design/art/concepts/README.md).

Blender 4.5 LTS. On Windows:

```bash
BLENDER="/c/Program Files/Blender Foundation/Blender 4.5/blender.exe"
"$BLENDER" --background --factory-startup --python tools/blender/build_props.py
"$BLENDER" --background --factory-startup --python tools/blender/inspect_glb.py -- public/assets/models/props.glb
```

| Script | Output |
|---|---|
| `build_props.py` | `props.glb`: pickups, furniture, doors, exit door, troffer, landmarks, decor |
| `build_skin_stealer.py` | `ent_skin_stealer.glb` |
| `build_howler.py` | `ent_howler.glb` |
| `build_smiler.py` | `ent_smiler.glb` |
| `build_viewmodel.py` | `vm_pistol.glb` |

- `common.py`: scene reset, materials, generated textures, sockets, export, preview render.
- `inspect_glb.py`: re-imports a `.glb` and writes `reports/<name>.json` (nodes, triangles, materials, bones, clips,
  bounds) to check against the contract.
- `previews/`: one render per model for review.

Like all art in this repository, the scripts' output is CC BY-SA 3.0 and the scripts themselves are GPL-3.0-or-later
(see `CREDITS.md`).
