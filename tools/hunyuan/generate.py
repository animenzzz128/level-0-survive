"""Generate a scan mesh for tools/blender/sources/ with Tencent's public Hunyuan3D-2mv Space on Hugging Face.

    python -m venv .venv-hunyuan && .venv-hunyuan/Scripts/pip install gradio_client pillow
    .venv-hunyuan/Scripts/python tools/hunyuan/generate.py skin_stealer

Crops the concept turnaround into front, left and back views (the same boxes the Blender script projects from),
uploads them to the Space and saves the untextured shape. No account is needed; anonymous use has a small daily GPU
quota. The Space can change or go away, so the result is committed and this script records how it was made.
See README.md here for the settings, the licence and how the scan is used.
"""
import pathlib
import shutil
import sys
import tempfile

from PIL import Image
from gradio_client import Client, handle_file

REPO = pathlib.Path(__file__).resolve().parents[2]
JOBS = {
    'skin_stealer': dict(
        turnaround=REPO / 'docs/design/art/concepts/skin-stealer/B_turnaround.webp',
        boxes={'front': (30, 0, 630, 768), 'left': (590, 0, 860, 768), 'back': (920, 0, 1330, 768)},
        out=REPO / 'tools/blender/sources/skin_stealer_hunyuan2mv.glb',
    ),
}
SPACE = 'tencent/Hunyuan3D-2mv'
SETTINGS = dict(steps=30, guidance_scale=5.0, seed=1234, octree_resolution=256, check_box_rembg=True,
                num_chunks=8000, randomize_seed=False)


def crop_views(job, tmp):
    im = Image.open(job['turnaround']).convert('RGB')
    bg = im.getpixel((5, 5))
    paths = {}
    for name, box in job['boxes'].items():
        c = im.crop(box)
        side = max(c.size) + 60
        sq = Image.new('RGB', (side, side), bg)
        sq.paste(c, ((side - c.size[0]) // 2, (side - c.size[1]) // 2))
        p = pathlib.Path(tmp) / f'{name}.png'
        sq.resize((1024, 1024), Image.LANCZOS).save(p)
        paths[name] = p
    return paths


def main(name):
    job = JOBS[name]
    with tempfile.TemporaryDirectory() as tmp:
        v = crop_views(job, tmp)
        client = Client(SPACE, verbose=False)
        result = client.predict(caption='', image=None, mv_image_front=handle_file(str(v['front'])),
                                mv_image_back=handle_file(str(v['back'])), mv_image_left=handle_file(str(v['left'])),
                                mv_image_right=None, api_name='/shape_generation', **SETTINGS)
    mesh = result[0]['value'] if isinstance(result[0], dict) else result[0]
    shutil.copy(mesh, job['out'])
    print('saved', job['out'], result[2] if len(result) > 2 else '')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'skin_stealer')
