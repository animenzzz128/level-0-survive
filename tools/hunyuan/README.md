# Scan meshes from Hunyuan3D

Model v1 built every creature from primitives in a Blender script, and the result looked nothing like the concepts.
From v2 on, a creature's shape starts as a mesh that an image-to-3D model makes from the concept turnaround.
The Blender scripts then turn that shape into a game model: they fit it to the rig, smooth it, decimate it, paint
it, and export it with the same clips and sockets as before.

| File | Made by | Used by |
|---|---|---|
| `tools/blender/sources/skin_stealer_hunyuan2mv.glb` | `generate.py skin_stealer` | `tools/blender/build_skin_stealer_scan.py` |

## How the Skin-Stealer scan was made

| | |
|---|---|
| Date | 2026-11-20 |
| Service | Tencent's public Space on Hugging Face, `tencent/Hunyuan3D-2mv`, endpoint `/shape_generation`. Anonymous, free |
| Model | `hunyuan3d-dit-v2-mv-turbo` (Hunyuan3D-2mv, shape only) |
| Input | Three crops of `docs/design/art/concepts/skin-stealer/B_turnaround.webp`: front, left side, back |
| Settings | 30 steps, guidance 5.0, seed 1234, octree resolution 256, background removal on |
| Output | 85,985 vertices, 172,018 triangles, no texture, 4.2 MB |

The Space can change or disappear, so the output is committed. Re-running `generate.py` may not give the same mesh.

### Other attempts

- **Hunyuan3D-2.1, from the front view only.** The face and hands came out cleaner, but the model had to guess the
  back, and it guessed wrong: a shirt instead of half a cardigan, and no raised right shoulder.
- **Textures from the Space.**
  - The 2.1 Space asks for more GPU time than anonymous use allows.
  - The 2mv texture step fails on the server.

  So the colour comes from the concept views instead: `build_skin_stealer_scan.py` projects them onto the mesh.

## Licence

- **The model.** Hunyuan3D-2mv is under the Tencent Hunyuan 3D 2.0 Community License Agreement. That licence does
  not cover use in the European Union, the United Kingdom or South Korea.
- **The mesh.** Tencent claims no rights in what the model outputs. The scan and the models built from it are CC BY-SA
  3.0, like the rest of the art here (see `CREDITS.md`).
- **The input.** The concept images are AI-generated. Their provenance is in
  `docs/design/art/concepts/README.md`.
