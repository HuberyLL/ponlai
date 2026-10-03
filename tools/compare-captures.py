"""Measure matched overview captures and save unretouched comparison crops.

Usage: python3 tools/compare-captures.py before.png after.png
Requires Pillow and NumPy; available in the Codex bundled Python runtime.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


before, after = [Image.open(path).convert("RGB") for path in sys.argv[1:3]]
assert before.size == after.size == (1672, 941), "Use matching overview cameras at 1672 x 941"
out = Path("artifacts/comparison")
out.mkdir(parents=True, exist_ok=True)
regions = {
    "cliff": (320, 600, 1100, 790),
    "meadow": (480, 240, 1110, 560),
    "open-water": (25, 30, 375, 155),
    "water-glare": (1480, 310, 1650, 720),
}


def metrics(im):
    a = np.asarray(im, dtype=np.float64)
    y = a @ np.array([0.2126, 0.7152, 0.0722])
    dx = np.abs(np.diff(y, axis=1)).mean()
    dy = np.abs(np.diff(y, axis=0)).mean()
    return {
        "meanRGB": np.round(a.mean(axis=(0, 1)), 2).tolist(),
        "lumaMean": round(float(y.mean()), 2),
        "lumaStdDev": round(float(y.std()), 2),
        "meanAdjacentLumaDifference": round(float((dx + dy) / 2), 3),
        "brightPixelPercent": round(float((y > 245).mean() * 100), 3),
    }


report = {}
for name, box in regions.items():
    a, b = before.crop(box), after.crop(box)
    a.save(out / f"{name}-before.png")
    b.save(out / f"{name}-after.png")
    paired = Image.new("RGB", (a.width * 2, a.height + 24), "#172c32")
    paired.paste(a, (0, 24))
    paired.paste(b, (a.width, 24))
    draw = ImageDraw.Draw(paired)
    draw.text((8, 5), f"BEFORE / {name}", fill="white")
    draw.text((a.width + 8, 5), f"AFTER / {name}", fill="white")
    paired.save(out / f"{name}-comparison.png")
    report[name] = {"bounds": box, "before": metrics(a), "after": metrics(b)}

(out / "metrics.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
