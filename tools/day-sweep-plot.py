# /// script
# requires-python = ">=3.10"
# dependencies = ["matplotlib", "numpy"]
# ///
"""The curves of tools/day-sweep.mjs: one PNG per camera and weather, over the day in five panels:
the sun's elevation, the frame's exposure (EV), and the sky, the sea, the land and the land's
darkest 5 % by log2 luminance of the rows' mean colour, Oklab chroma and Oklab hue. The steps it
flagged are circled on the curves in their region's colour, and the pairs of frames the camera
turned between (a change of the picture, not of the light) are shaded.

  uv run tools/day-sweep-plot.py <series.json> <outDir>

series.json is what day-sweep.mjs writes beside its report: { sunrise, sunset (hours), cameras:
{ <camera>: { <weather>: { points: [ { hour, elevation, ev, regions: { <region>: { log2Y, C, h } } } ],
jumps: [ { hours: [ from, to ], region, quantity: log2Y | colour } ], turned: [ [ from, to ] ] } } } }.
Writes <outDir>/curves-<camera>-<weather>.png.
"""
import os
import sys

# The application scheduling policy on macOS (tools/qos.mjs says why), as in img.py: the process
# re-executes itself in place under taskpolicy -a.
if sys.platform == "darwin" and os.environ.get("PONLAI_QOS") != "off" and os.environ.get("PONLAI_QOS") != str(os.getpid()):
    os.environ["PONLAI_QOS"] = str(os.getpid())
    os.execv("/usr/sbin/taskpolicy", ["/usr/sbin/taskpolicy", "-a", sys.executable, *sys.orig_argv[1:]])

import json  # noqa: E402
from pathlib import Path  # noqa: E402

import matplotlib  # noqa: E402

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

REGIONS = ["sky", "sea", "land", "floor"]
NAMES = {"sky": "sky", "sea": "sea", "land": "land", "floor": "darkest 5 % of the land"}
COLOURS = {"sky": "#3b7dd8", "sea": "#1a9e8f", "land": "#d9822b", "floor": "#7d4fb0"}
PANELS = [("log2Y", "log2 luminance (final pixel)"), ("C", "Oklab chroma"), ("h", "Oklab hue (deg)")]


def series_of(pts, region, key):
    """A region's values over the points, NaN where it holds none; hue breaks where it wraps 0/360."""
    xs, ys = [], []
    for p in pts:
        r = p["regions"].get(region)
        v = np.nan if not r else r[key]
        if key == "h" and ys and not np.isnan(v) and not np.isnan(ys[-1]) and abs(v - ys[-1]) > 180:
            xs.append(np.nan)
            ys.append(np.nan)
        xs.append(p["hour"])
        ys.append(v)
    return xs, ys


def plot(camera, weather, data, sunrise, sunset, out):
    pts = data["points"]
    hours = [p["hour"] for p in pts]
    fig, axes = plt.subplots(5, 1, figsize=(13, 13), sharex=True, gridspec_kw={"height_ratios": [1, 1, 3, 3, 3]})
    axes[0].plot(hours, [p["elevation"] for p in pts], color="#555", lw=1.2, marker="o", ms=2)
    axes[0].axhline(0, color="#999", lw=0.6)
    axes[0].set_ylabel("sun elev (deg)")
    axes[1].plot(hours, [p["ev"] for p in pts], color="#333", lw=1.2, marker="o", ms=2)
    axes[1].set_ylabel("exposure (EV)")
    value_axes = axes[2:]
    for ax in axes[1:]:
        ax.grid(alpha=0.25)
    for ax, (key, title) in zip(value_axes, PANELS):
        for region in REGIONS:
            if not any(p["regions"].get(region) for p in pts):
                continue  # a region the camera's view holds no cells of (the island view has no sky)
            xs, ys = series_of(pts, region, key)
            ax.plot(xs, ys, color=COLOURS[region], lw=1.3, marker="o", ms=2.5, label=NAMES[region])
        ax.set_ylabel(title)
    # the steps, circled on the quantity's panels in their region's colour: luminance on the first,
    # colour (Oklab a, b) on the chroma and hue panels
    for j in data.get("jumps", []):
        panels = [(value_axes[0], "log2Y")] if j["quantity"] == "log2Y" else [(value_axes[1], "C"), (value_axes[2], "h")]
        for hour in j["hours"]:
            p = next((p for p in pts if abs(p["hour"] - hour) < 1e-6), None)
            if p is None or not p["regions"].get(j["region"]):
                continue
            for ax, k in panels:
                ax.plot([hour], [p["regions"][j["region"]][k]], marker="o", ms=9, mfc="none", mec=COLOURS[j["region"]], mew=1.6, ls="none")
    for a, b in data.get("turned", []):
        for ax in axes:
            ax.axvspan(a, b, color="#999", alpha=0.25, lw=0)
    for ax in axes:
        for x in (sunrise, sunset):
            ax.axvline(x, color="#999", lw=0.8, ls="--")
    value_axes[0].legend(ncol=4, loc="upper right", fontsize=8)
    axes[-1].set_xlim(0, 24)
    axes[-1].set_xticks(range(0, 25, 2))
    axes[-1].set_xlabel("hour (rings: flagged steps; grey: the camera turned between the frames; dashed: sun at the horizon)")
    fig.suptitle(f"{camera} / {weather}", y=0.995)
    fig.tight_layout()
    fig.savefig(out, dpi=110)
    plt.close(fig)


def main():
    series = json.loads(Path(sys.argv[1]).read_text())
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    for camera, weathers in series["cameras"].items():
        for weather, data in weathers.items():
            if len(data["points"]) < 2:
                continue
            f = out / f"curves-{camera}-{weather}.png"
            plot(camera, weather, data, series["sunrise"], series["sunset"], f)
            print(f)


main()
