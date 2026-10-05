"""Build the moon's web textures from NASA's CGI Moon Kit (public domain).

Usage: uv run --with pillow --with numpy tools/build-moon-textures.py [source-dir]

source-dir (default artifacts/third-party/nasa-moon) holds two files from
https://svs.gsfc.nasa.gov/4720/ (NASA's Scientific Visualization Studio):
  lroc_color_2k.jpg  colour, 2048 x 1024, sRGB, centred on 0 degrees longitude
  ldem_4_uint.tif    LOLA heights, 1440 x 720, unsigned 16-bit half-metres offset by
                     +10 km from the 1737.4 km reference sphere
Writes public/sky/moon/:
  moon_color.jpg     1024 x 512 sRGB colour, a 2 x 2 box average taken in linear light
  moon_height.png    512 x 256 heights, an area average of the LOLA grid, kept in the
                     kit's units (half-metres + 20000) and split into two 8-bit channels:
                     red the high byte, green the low byte. Filtering is linear, so the
                     GPU's bilinear and mipmap filters of the two channels recombine into
                     the filtered 16-bit height (red * 65280 + green * 255) / 65535 without
                     an 8-bit height's terracing in the shading near the terminator.
The moon is about a degree wide on screen, a few dozen pixels in the usual views; these sizes
stay sharp in a narrow-lens close-up while keeping the download small.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

source = Path(sys.argv[1] if len(sys.argv) > 1 else "artifacts/third-party/nasa-moon")
out = Path("public/sky/moon")
out.mkdir(parents=True, exist_ok=True)


def to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


color = to_linear(np.asarray(Image.open(source / "lroc_color_2k.jpg").convert("RGB"), dtype=np.float64) / 255)
assert color.shape == (1024, 2048, 3), color.shape
half = color.reshape(512, 2, 1024, 2, 3).mean(axis=(1, 3))
srgb = np.round(to_srgb(half) * 255).astype(np.uint8)
Image.fromarray(srgb, "RGB").save(out / "moon_color.jpg", quality=90, subsampling=0, optimize=True)

raw = np.asarray(Image.open(source / "ldem_4_uint.tif"), dtype=np.float32)
assert raw.shape == (720, 1440), raw.shape
height = np.asarray(Image.fromarray(raw, "F").resize((512, 256), Image.BOX))
value = np.clip(np.round(height), 0, 65535).astype(np.uint16)
packed = np.zeros((256, 512, 3), dtype=np.uint8)
packed[..., 0] = value >> 8
packed[..., 1] = value & 0xFF
Image.fromarray(packed, "RGB").save(out / "moon_height.png", optimize=True)

# Mean linear luminance of the near side, weighted by its projected area on the disk: the
# shader divides the colour by this so the textured full moon keeps the old disk's brightness.
lat = (0.5 - (np.arange(512) + 0.5) / 512) * np.pi
lon = ((np.arange(1024) + 0.5) / 1024 - 0.5) * 2 * np.pi
weight = np.cos(lat)[:, None] ** 2 * np.clip(np.cos(lon), 0, None)[None, :]
luminance = half @ np.array([0.2126, 0.7152, 0.0722])
print("near-side mean luminance", (luminance * weight).sum() / weight.sum())
print("height range (m)", height.min() * 0.5 - 10000, height.max() * 0.5 - 10000)
for name in ("moon_color.jpg", "moon_height.png"):
    print(name, (out / name).stat().st_size, "bytes")
