"""Build the meadow ground's web textures from two Poly Haven scans (CC0).

Usage: uv run --with pillow --with numpy tools/build-ground-textures.py [source-dir]

source-dir (default artifacts/third-party/polyhaven) holds each scan's 1K maps in a folder of its
id, `<id>_diff_1k.jpg` (colour, sRGB), `<id>_nor_gl_1k.jpg` (OpenGL normals) and
`<id>_rough_1k.jpg` (roughness):
  brown_mud_leaves_01  https://polyhaven.com/a/brown_mud_leaves_01: brown earth under small green
                       leaves, a 1.3 m square; the open meadow's ground
  forrest_ground_01    https://polyhaven.com/a/forrest_ground_01: moss, short grass, dead leaves
                       and twigs, a 2 m square; the bamboo groves' floor
Writes public/textures/ground/ (meadow_* from the first, grove_* from the second):
  <name>_albedo.jpg  the colour, unchanged
  <name>_detail.png  the normal map's x and y (R, G) and the roughness (B), 8 bits each, no
                     alpha (the page decodes it exactly into a texture array's layer; the normal's
                     z follows from x and y): the cliff's stone packs its scan the same way, and
                     the three share one array, so one hex-tiled read serves each
"""
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

source = Path(sys.argv[1] if len(sys.argv) > 1 else "artifacts/third-party/polyhaven")
out = Path("public/textures/ground")
out.mkdir(parents=True, exist_ok=True)

for name, scan in (("meadow", "brown_mud_leaves_01"), ("grove", "forrest_ground_01")):
    src = source / scan
    shutil.copyfile(src / f"{scan}_diff_1k.jpg", out / f"{name}_albedo.jpg")
    normal = np.asarray(Image.open(src / f"{scan}_nor_gl_1k.jpg").convert("RGB"))
    rough = np.asarray(Image.open(src / f"{scan}_rough_1k.jpg").convert("L"))
    Image.fromarray(np.dstack([normal[..., 0], normal[..., 1], rough]), "RGB").save(out / f"{name}_detail.png", optimize=True)
    print(f"wrote {out}/{name}_albedo.jpg, {out}/{name}_detail.png")
