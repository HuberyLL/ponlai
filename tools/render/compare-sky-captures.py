"""Compare matched sky/weather captures without changing the source pixels.

Usage: python3 tools/render/compare-sky-captures.py before.png after.png --out DIR \
    [--view overview|horizon|clouds]
Requires Pillow and NumPy. The cameras must match; image dimensions need only be equal.
Metrics use displayed RGB values in [0, 255], not scene-linear radiance.
"""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


# Fractional bounds preserve the established overview regions at other resolutions.
# The horizon view is the wide, low-polar-angle island camera; clouds is a skyward view.
REGIONS = {
    "overview": {
        "meadow": (0.28708, 0.25505, 0.66388, 0.59511),
        "cliff": (0.19139, 0.63762, 0.65789, 0.83953),
        "shallow-water": (0.01196, 0.46759, 0.13158, 0.78640),
        "open-water": (0.01495, 0.03188, 0.22428, 0.16472),
        "water-glare": (0.88517, 0.32944, 0.98684, 0.76514),
    },
    "horizon": {
        "sky": (0.02, 0.02, 0.98, 0.23),
        "horizon": (0.02, 0.23, 0.98, 0.33),
        "island": (0.38, 0.40, 0.66, 0.58),
        "sea": (0.05, 0.64, 0.95, 0.94),
        "distant-sea": (0.05, 0.34, 0.95, 0.395),
    },
    "clouds": {
        "sky": (0.0, 0.0, 1.0, 1.0),
        "central-cloud": (0.25, 0.20, 0.75, 0.70),
    },
}
LUMA = np.array([0.2126, 0.7152, 0.0722])


def pixel_bounds(fractions, size):
    width, height = size
    x0, y0, x1, y1 = fractions
    left = min(width - 1, max(0, round(x0 * width)))
    top = min(height - 1, max(0, round(y0 * height)))
    right = min(width, max(left + 1, round(x1 * width)))
    bottom = min(height, max(top + 1, round(y1 * height)))
    return left, top, right, bottom


def metrics(pixels):
    luma = pixels @ LUMA
    return {
        "meanRGB": np.round(pixels.mean(axis=(0, 1)), 4).tolist(),
        "lumaMean": round(float(luma.mean()), 4),
        "lumaStdDev": round(float(luma.std()), 4),
        # Report both perceptually bright pixels and a saturated individual channel.
        "clippedLumaFraction245": round(float((luma >= 245 - 1e-9).mean()), 6),
        "clippedAnyChannelFraction245": round(float((pixels >= 245).any(axis=2).mean()), 6),
    }


def paired_crop(before, after, name):
    # Labels occupy their own margin; crop pixels are copied at native resolution.
    pair = Image.new("RGB", (before.width * 2, before.height + 24), "#172c32")
    pair.paste(before, (0, 24))
    pair.paste(after, (before.width, 24))
    labels = ImageDraw.Draw(pair)
    labels.text((8, 5), f"BEFORE / {name}", fill="white")
    labels.text((before.width + 8, 5), f"AFTER / {name}", fill="white")
    return pair


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before", type=Path)
    parser.add_argument("after", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--view", choices=REGIONS, default="overview")
    args = parser.parse_args()
    try:
        with Image.open(args.before) as source:
            before = source.convert("RGB")
        with Image.open(args.after) as source:
            after = source.convert("RGB")
    except (OSError, ValueError) as error:
        parser.error(f"Could not read captures: {error}")
    if before.size != after.size:
        parser.error(f"Capture dimensions must match: {before.size} != {after.size}")

    # Avoid overwriting an input capture even if the user supplies the source directory.
    outputs = [args.out / "metrics.json"]
    for name in REGIONS[args.view]:
        outputs.extend(args.out / f"{name}-{suffix}.png" for suffix in ("before", "after", "comparison"))
    sources = {args.before.resolve(), args.after.resolve()}
    if any(path.resolve() in sources for path in outputs):
        parser.error("Output names would overwrite a source capture; use a separate --out directory")

    args.out.mkdir(parents=True, exist_ok=True)
    report = {
        "before": str(args.before.resolve()),
        "after": str(args.after.resolve()),
        "view": args.view,
        "size": list(before.size),
        "units": {"RGBAndLuma": "display values 0..255", "clippedFractions": "0..1", "clippingThreshold": 245},
        "regions": {},
    }
    for name, fractions in REGIONS[args.view].items():
        bounds = pixel_bounds(fractions, before.size)
        crop_before, crop_after = before.crop(bounds), after.crop(bounds)
        crop_before.save(args.out / f"{name}-before.png")
        crop_after.save(args.out / f"{name}-after.png")
        paired_crop(crop_before, crop_after, name).save(args.out / f"{name}-comparison.png")
        a = np.asarray(crop_before, dtype=np.float64)
        b = np.asarray(crop_after, dtype=np.float64)
        report["regions"][name] = {
            "fractionalBounds": list(fractions),
            "bounds": list(bounds),
            "before": metrics(a),
            "after": metrics(b),
            "meanAbsolutePixelDifference": round(float(np.abs(b - a).mean()), 4),
            "meanAbsoluteLumaDifference": round(float(np.abs((b @ LUMA) - (a @ LUMA)).mean()), 4),
        }

    encoded = json.dumps(report, indent=2) + "\n"
    (args.out / "metrics.json").write_text(encoded, encoding="utf-8")
    print(encoded, end="")


if __name__ == "__main__":
    main()
