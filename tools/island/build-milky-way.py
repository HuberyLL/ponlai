"""Reduce NASA SVS's Deep Star Maps 2020 Milky Way to the mask the night sky shapes its band with.

Usage:
    uv run --with numpy --with pillow --with openexr --with scipy \\
        python tools/island/build-milky-way.py milkyway_2020_4k.exr [public/sky/milkyway.png]

Source: https://svs.gsfc.nasa.gov/4851 (Deep Star Maps 2020), the 4k celestial-coordinate Milky
Way background `milkyway_2020_4k.exr`. Credit: NASA/Goddard Space Flight Center Scientific
Visualization Studio. Gaia DR2: ESA/Gaia/DPAC. Its equirectangular layout has right ascension 0h
at the centre, increasing to the left, and declination +90 along the top row; the output keeps it.

Output: a 1024 x 512 8-bit greyscale PNG (about a third of a degree per texel) holding the square
root of the luminance divided by the brightest star clouds (the 99.95th percentile), so 8 bits keep
the faint outer band and the dark lanes. The night sky draws its own stars and grain; the mask
only carries the band's broad light and dust, so the few point sources left in the background
are removed with a median filter first. Rows toward the poles are blurred along right ascension
to the equator's angular resolution.
"""
import sys

import numpy as np
import OpenEXR
from PIL import Image
from scipy.ndimage import gaussian_filter1d, median_filter

WIDTH, HEIGHT = 1024, 512
LUMINANCE = np.array([0.2126, 0.7152, 0.0722], np.float32)


def main():
    source = sys.argv[1]
    target = sys.argv[2] if len(sys.argv) > 2 else "public/sky/milkyway.png"
    rgb = OpenEXR.File(source).channels()["RGB"].pixels.astype(np.float32)
    h, w, _ = rgb.shape
    # Halve first (area mean); a 5 x 5 median at that scale (about 0.4 degrees) then removes
    # residual point sources without moving the edges of the dust lanes.
    half = (rgb @ LUMINANCE).reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3))
    # (Padded by hand: wrap in right ascension, clamp at the poles.)
    padded = np.pad(np.pad(half, ((2, 2), (0, 0)), mode="edge"), ((0, 0), (2, 2)), mode="wrap")
    half = median_filter(padded, size=5)[2:-2, 2:-2]
    fy, fx = half.shape[0] // HEIGHT, half.shape[1] // WIDTH
    small = half.reshape(HEIGHT, fy, WIDTH, fx).mean(axis=(1, 3))
    # Toward the poles a row's texels crowd together on the sky; blur each row along right
    # ascension to the equator's angular resolution, so noise does not pinch into radial streaks.
    for row in range(HEIGHT):
        declination = np.pi * (0.5 - (row + 0.5) / HEIGHT)
        sigma = 0.5 * (1 / max(np.cos(declination), 1e-3) - 1)
        if sigma > 0.25:
            small[row] = gaussian_filter1d(small[row], min(sigma, WIDTH / 4), mode="wrap")
    scale = np.percentile(small, 99.95)
    encoded = np.sqrt(np.clip(small / scale, 0, 1))
    Image.fromarray(np.round(encoded * 255).astype(np.uint8), "L").save(target, optimize=True)
    print(f"{target}: {WIDTH}x{HEIGHT}, median {np.median(small) / scale:.4f} of the 99.95th percentile")


if __name__ == "__main__":
    main()
