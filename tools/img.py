# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "pillow"]
# ///
"""One image tool for captures: differences, crops, side-by-side sheets and statistics.

  uv run tools/img.py diff  A B            [region] [--thr 1,2,8,32] [--bbox-thr 0] [--heat P] [--gain 8] [--json]
  uv run tools/img.py crop  IMG|DIR...     region [--zoom N] --out DIR
  uv run tools/img.py sheet IMG|DIR...     [region] [--labels a,b] [--cols N] [--diff] [--zoom N | --scale F | --width W] --out FILE
  uv run tools/img.py stats IMG|DIR...     [region] [--pct 1,5,50,95,99] [--json]
  uv run tools/img.py flicker CLIP|DIR...  [region] [--frames a-b] [--spike 20,40] [--odd 2.5] [--drop-odd] [--map P] [--gain 8] [--json] [--save]

  region: --box [name=]x,y,w,h (repeatable) and/or --anchor name[,name] | all  [--anchors FILE.json]

`uv run` reads the dependencies above (PEP 723), so no system Pillow or NumPy is needed. A
directory stands for its PNGs (--match, default `*.png`, sorted by name); `diff` and `sheet` pair
directories by file name.

diff: per pair (two images, or the PNGs two directories share) and per region, `identical`
(equal decoded pixels), the max and mean absolute channel difference, the count of pixels over each
--thr level (a pixel counts when its largest channel difference exceeds the level), the mean signed
difference B - A per channel (`bias`), the luma mean's change (`dL`, Rec. 709 on code values) and
the bounding box [x, y, w, h] of the pixels over --bbox-thr. The numbers are diff-set.py's (the
same helpers, tools/parity/pixels.py): max, mean and counts over 1, 2, 8 and 32 equal its report.
--heat writes the per-pixel max channel difference times --gain (clipped; x8 as diff-set's
<view>.diff.png): a file for one pair, else a directory of <name>[.<region>].diff.png.

crop: every region of every image, nearest-neighbour zoomed by --zoom, saved as
<out>/<name>.<region>.png.

sheet: a labelled grid. Files (or one directory's PNGs): one column each (--cols wraps them into
rows when no region is given). Several directories: one column each, one row per shared file name. Each region adds rows, cut
with the same box from every column (an anchor's box comes from the first column's capture JSON
that names it). --diff adds a column after two inputs: their difference x --gain. Tiles are
1:1 unless --zoom (nearest, integer), --scale (box filter) or --width (box filter to that width)
is given; a full frame wider than 1280 px is scaled down to 1280 by default.

stats: per image and region, compare-captures.py's metrics (mean RGB, luma mean and standard
deviation, the mean luma difference of adjacent pixels, the share of pixels with luma over 245)
and the luma percentiles of --pct.

flicker: frame-to-frame flicker of a run of consecutive frames, per region: a capture-clip clip
directory (its whole frames, <clip>/full/<i>.png, in frame order) or a directory of PNGs named by
frame number. The frames must be consecutive (a gap is refused: the measures compare neighbours);
--frames a-b keeps frames a to b. Luma is Rec. 709 of the 8-bit values (float32), in levels:
  F       mean |L_t - L_t-1|
  Fhp     mean |L_t - ( L_t-2 + L_t+2 ) / 2|, the temporal high-pass (clip-metrics.py's)
  spike   s = L_t - ( L_t-1 + L_t+1 ) / 2, a one-frame flash: the share of pixel-frames with
          |s| over each --spike level and with s over the first (`bright`), in per mille, its
          99.9th percentile (`p999`), and the share of pixels that flash over the first level at
          least once (`once`, %)
  std     the mean per-pixel standard deviation over the frames; `mean` the luma mean
The numbers equal the sparkle surveys' flicker.py. A clip of 120 frames at 60 fps (2 s) is what
the vegetation surveys measured; the sea's own motion is a useful control region (Fhp about 0.35,
no spikes, on island-fair-noon). --map writes each region's flash map: the share of frames whose
|s| exceeds the first level, times 255 x --gain (a file for one clip and region, else a directory
of <clip>[.<region>].flash.png). --save writes <clip>/flicker.json. Only the regions are kept in
memory, so give regions rather than the whole frame for long 4K runs.
Odd frames: a paused page's stepped frames now and then come out as a discrete alternative image
(scattered vegetation pixels off by up to 190 levels: capture-clip.mjs, "The rest shot twice"),
which in a 120-frame meadow clip raised Fhp by about 5 % and the flashes by about 6 % from one
frame. A frame whose flash share over all the regions exceeds --odd (2.5) times the clip's median
and the median by 0.5 per mille is listed (`odd`); --drop-odd leaves out every term that reads
one, so A/Bs of small effects compare the wind's flicker rather than which clip caught an odd
frame.

Regions: --box takes pixels of the image as stored (a capture at dpr 2 has twice the CSS size).
--anchor reads the named crop anchors of the capture's JSON (<name>.json next to <name>.png,
`crops`: tools/parity/views.mjs; for diff, B's JSON, else A's), `all` every anchor in it;
--anchors FILE reads them from a capture JSON or a { name: {x, y, w, h} } file instead. An anchor
the capture reports missing (off screen) is skipped with a note.
"""
import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# The application scheduling policy on macOS (tools/qos.mjs says why), as in diff-set.py: the
# process re-executes itself in place under taskpolicy -a, and its pool threads ask for the
# user-initiated QoS.
QOS = sys.platform == "darwin" and os.environ.get("PONLAI_QOS") != "off"
if QOS and os.environ.get("PONLAI_QOS") != str(os.getpid()):
    os.environ["PONLAI_QOS"] = str(os.getpid())
    os.execv("/usr/sbin/taskpolicy", ["/usr/sbin/taskpolicy", "-a", sys.executable, *sys.orig_argv[1:]])


def raise_thread():
    if QOS:
        import ctypes
        ctypes.CDLL(None).pthread_set_qos_class_self_np(0x19, 0)  # QOS_CLASS_USER_INITIATED


import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent / "parity"))
from pixels import LEVELS, LUMA, Files, bbox, bias, decode, metrics, stats  # noqa: E402

FULL_MAX = 1280


def ints(s):
    return [int(v) for v in s.split(",") if v != ""]


def expand(paths, match):
    """Files as given; a directory stands for its PNGs matching the pattern, sorted by name."""
    out = []
    for p in map(Path, paths):
        out += sorted(p.glob(match)) if p.is_dir() else [p]
    return out


def anchors_of(img, a):
    """The capture's crop anchors: --anchors FILE, else <img>.json's `crops`."""
    f = Path(a.anchors) if a.anchors else Path(img).with_suffix(".json")
    if not f.exists():
        return {}
    d = json.loads(f.read_text())
    return d.get("crops", {} if "url" in d else d)


def box_arg(s):
    """(label, (x, y, w, h)) of a --box value, `x,y,w,h` or `name=x,y,w,h`."""
    name, _, v = s.rpartition("=")
    x, y, w, h = ints(v)
    return (name or f"{x}_{y}_{w}_{h}", (x, y, w, h))


def regions(imgs, a, shape):
    """[(label, (x, y, w, h))] for the first image of imgs that has what is asked; the whole frame
    when no region is asked."""
    out = [box_arg(b) for b in a.box or []]
    if a.anchor:
        crops = {}
        for img in imgs:
            crops = anchors_of(img, a)
            if crops:
                break
        names = list(crops) if a.anchor == "all" else a.anchor.split(",")
        for n in names:
            c = crops.get(n)
            if c is None or "x" not in c:
                why = "not in the capture's anchors" if c is None else f"missing: {c.get('missing', '?')}"
                print(f"note: anchor {n} skipped ({why})", file=sys.stderr)
                continue
            out.append((n, (c["x"], c["y"], c["w"], c["h"])))
    if not a.box and not a.anchor:
        out.append((None, (0, 0, shape[1], shape[0])))
    return out


def cut(X, box):
    x, y, w, h = box
    return X[y:y + h, x:x + w]


def gain_lut(g):
    return np.minimum(np.arange(256) * g, 255).astype(np.uint8)


# ---------------------------------------------------------------------------------------------- diff

def diff_pair(name, fa, fb, a, levels):
    fs = Files()
    A, B = fs.load(fa), fs.load(fb)
    if A.shape != B.shape:
        return [{"name": name, "a": str(fa), "b": str(fb), "sizeMismatch": [list(A.shape), list(B.shape)]}]
    ident = fs.same(fa, fb)
    rows = []
    for label, box in regions([fb, fa], a, A.shape):
        RA, RB = cut(A, box), cut(B, box)
        D, M, r = stats(RA, RB, levels)
        n = M.size
        sa, sb = RA.reshape(-1, 3).sum(0, dtype=np.int64), RB.reshape(-1, 3).sum(0, dtype=np.int64)
        r = {"name": name, "region": label, "box": list(box), "identical": ident if label is None else r["max"] == 0} | r
        r["bias"] = bias(RA, RB)
        r["dL"] = round(float(LUMA @ (sb - sa) / n), 5)
        b = bbox(M, a.bbox_thr)
        r["bbox"] = None if b is None else [b[0] + box[0], b[1] + box[1], b[2], b[3]]
        if a.heat and r["max"] > 0:
            heat = Path(a.heat)
            if heat.suffix.lower() != ".png":
                heat.mkdir(parents=True, exist_ok=True)
                heat = heat / (Path(name).stem + (f".{label}" if label else "") + ".diff.png")
            else:
                heat.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(gain_lut(a.gain)[M]).save(heat)
            r["heat"] = str(heat)
        rows.append(r)
    return rows


def cmd_diff(a):
    pa, pb = Path(a.a), Path(a.b)
    if pa.is_dir() != pb.is_dir():
        sys.exit("diff: give two images or two directories")
    if pa.is_dir():
        names = [p.name for p in sorted(pa.glob(a.match))]
        pairs = [(n, pa / n, pb / n) for n in names if (pb / n).exists()]
        missing = [n for n in names if not (pb / n).exists()] + [p.name for p in sorted(pb.glob(a.match)) if not (pa / p.name).exists()]
    else:
        pairs, missing = [(pb.name if pa.name == pb.name else f"{pa.name} vs {pb.name}", pa, pb)], []
    if a.heat and len(pairs) > 1 and Path(a.heat).suffix.lower() == ".png":
        sys.exit("diff: --heat takes a directory when there are several pairs")
    levels = tuple(ints(a.thr))
    with ThreadPoolExecutor(max_workers=max(1, a.jobs), initializer=raise_thread) as pool:
        results = [r for rows in pool.map(lambda p: diff_pair(*p, a, levels), pairs) for r in rows]
    if a.json:
        print(json.dumps({"pairs": results, "missing": missing}, indent=2))
        return
    w = max([len(r["name"] + (f" / {r['region']}" if r.get("region") else "")) for r in results] + [4])
    print(f"{'name':{w}} {'ident':5} {'max':>4} {'mean':>8} " + " ".join(f"{'>' + str(l):>9}" for l in levels)
          + f" {'bias R,G,B':>22} {'dL':>8}  bbox x,y,w,h")
    for r in results:
        n = r["name"] + (f" / {r['region']}" if r.get("region") else "")
        if "sizeMismatch" in r:
            print(f"{n:{w}} size {r['sizeMismatch'][0]} vs {r['sizeMismatch'][1]}")
            continue
        bb = ",".join(map(str, r["bbox"])) if r["bbox"] else "-"
        print(f"{n:{w}} {('yes' if r['identical'] else 'no'):5} {r['max']:4} {r['mean']:8.4f} "
              + " ".join(f"{r['over'][str(l)]:9}" for l in levels)
              + f" {','.join(f'{v:+.3f}' for v in r['bias']):>22} {r['dL']:+8.3f}  {bb}" + (f"  {r['heat']}" if r.get("heat") else ""))
    for n in missing:
        print(f"{n:{w}} only on one side")


# ---------------------------------------------------------------------------------------------- crop

def zoomed(X, z):
    return X if z == 1 else np.repeat(np.repeat(X, z, axis=0), z, axis=1)


def cmd_crop(a):
    if not a.box and not a.anchor:
        sys.exit("crop: give --box and/or --anchor")
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for f in expand(a.images, a.match):
        X = decode(f)
        for label, box in regions([f], a, X.shape):
            p = out / f"{f.stem}.{label}.png"
            Image.fromarray(zoomed(cut(X, box), a.zoom)).save(p)
            print(p)


# --------------------------------------------------------------------------------------------- sheet

def tile_size(X, a, region):
    h, w = X.shape[:2]
    if a.width:
        return a.width, max(1, round(h * a.width / w))
    if a.scale:
        return max(1, round(w * a.scale)), max(1, round(h * a.scale))
    if region is None and a.zoom == 1 and w > FULL_MAX:
        return FULL_MAX, max(1, round(h * FULL_MAX / w))
    return w * a.zoom, h * a.zoom


def to_tile(X, a, region, nearest=False):
    w, h = tile_size(X, a, region)
    if (w, h) == (X.shape[1], X.shape[0]):
        return Image.fromarray(X)
    if a.zoom > 1 and not a.width and not a.scale:
        return Image.fromarray(zoomed(X, a.zoom))
    return Image.fromarray(X).resize((w, h), Image.NEAREST if nearest else Image.BOX)


def cmd_sheet(a):
    inputs = [Path(p) for p in a.images]
    dirs = [p.is_dir() for p in inputs]
    if any(dirs) and not all(dirs):
        sys.exit("sheet: give images or directories, not both")
    if all(dirs) and len(inputs) > 1:
        names = [p.name for p in sorted(inputs[0].glob(a.match)) if all((d / p.name).exists() for d in inputs[1:])]
        groups = [(Path(n).stem, [d / n for d in inputs]) for n in names]
        labels = a.labels.split(",") if a.labels else [d.name for d in inputs]
    else:
        files = expand(a.images, a.match)
        labels = a.labels.split(",") if a.labels else [f.stem for f in files]
        groups = [(None, files)]
        if a.cols and not a.box and not a.anchor:
            groups = [(None, files[i:i + a.cols]) for i in range(0, len(files), a.cols)]
            labels = [labels[i:i + a.cols] for i in range(0, len(files), a.cols)]
    if a.diff and len(groups[0][1]) != 2:
        sys.exit("sheet: --diff needs exactly two inputs")
    lut = gain_lut(a.gain)
    rows = []  # [(title, [(label, PIL image)])]
    for gi, (gname, files) in enumerate(groups):
        imgs = [decode(f) for f in files]
        glabels = labels[gi] if a.cols and isinstance(labels[0], list) else labels
        for label, box in regions(files, a, imgs[0].shape):
            tiles = [cut(X, box) for X in imgs]
            row = [(glabels[j] if j < len(glabels) else files[j].stem, to_tile(t, a, label)) for j, t in enumerate(tiles)]
            if a.diff:
                if tiles[0].shape != tiles[1].shape:
                    sys.exit(f"sheet: --diff on images of different sizes ({files[0]}, {files[1]})")
                _, M, st = stats(tiles[0], tiles[1])
                row.append((f"diff x{a.gain:g} (max {st['max']})", to_tile(lut[M], a, label, nearest=True)))
            title = " / ".join(s for s in (gname, label) if s)
            rows.append((title, row))
    gap, bar = 4, 18
    cols = max(len(r) for _, r in rows)
    cw = [max((r[j][1].width for _, r in rows if j < len(r)), default=0) for j in range(cols)]
    rh = [max(t.height for _, t in r) + bar for _, r in rows]
    im = Image.new("RGB", (sum(cw) + gap * (cols - 1), sum(rh) + gap * (len(rows) - 1)), "#202020")
    dr = ImageDraw.Draw(im)
    y = 0
    for (title, row), h in zip(rows, rh):
        x = 0
        for j, (label, t) in enumerate(row):
            im.paste(t, (x, y + bar))
            dr.text((x + 4, y + 3), (f"{title}: {label}" if title and j == 0 else label), fill="white")
            x += cw[j] + gap
        y += h + gap
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    im.save(out)
    print(f"{out} ({im.width}x{im.height}, {len(rows)} rows x {cols} columns)")


# --------------------------------------------------------------------------------------------- stats

def cmd_stats(a):
    pct = [float(p) for p in a.pct.split(",")] if a.pct else []
    res = []
    for f in expand(a.images, a.match):
        X = decode(f)
        for label, box in regions([f], a, X.shape):
            R = cut(X, box)
            m = metrics(R)
            y = R.astype(np.float64) @ LUMA
            m["lumaPercentiles"] = {f"{p:g}": round(float(v), 2) for p, v in zip(pct, np.percentile(y, pct))}
            res.append({"name": f.name, "region": label, "box": list(box)} | m)
    if a.json:
        print(json.dumps(res, indent=2))
        return
    w = max([len(r["name"] + (f" / {r['region']}" if r["region"] else "")) for r in res] + [4])
    print(f"{'name':{w}} {'mean R,G,B':>20} {'luma':>7} {'std':>6} {'adj':>6} {'>245%':>7}  " + " ".join(f"{'p' + k:>7}" for k in (f"{p:g}" for p in pct)))
    for r in res:
        n = r["name"] + (f" / {r['region']}" if r["region"] else "")
        print(f"{n:{w}} {','.join(f'{v:.1f}' for v in r['meanRGB']):>20} {r['lumaMean']:7.2f} {r['lumaStdDev']:6.2f} "
              f"{r['meanAdjacentLumaDifference']:6.3f} {r['brightPixelPercent']:7.3f}  "
              + " ".join(f"{v:7.2f}" for v in r["lumaPercentiles"].values()))


# -------------------------------------------------------------------------------------------- flicker

# an odd frame also flashes this share of pixels (0.5 per mille) above the median, so a clip that
# hardly flashes (a ground truth) lists none
ODD_FLOOR = 0.5e-3
LUMA32 = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def clip_frames(d, span):
    """[(frame, path)] of a clip directory's whole frames (or a directory of numbered PNGs), in
    frame order, within span (a, b) when given."""
    d = Path(d)
    src = d / "full" if (d / "full").is_dir() else d
    files = sorted((int(p.stem), p) for p in src.glob("*.png") if p.stem.isdigit())
    if span:
        files = [(i, p) for i, p in files if span[0] <= i <= span[1]]
    gaps = [files[k][0] for k in range(1, len(files)) if files[k][0] != files[k - 1][0] + 1]
    if gaps:
        sys.exit(f"flicker: {src}: frames not consecutive (a gap before frame {gaps[0]}); pick a run with --frames")
    if len(files) < 5:
        sys.exit(f"flicker: {src}: {len(files)} frames, the measures need at least 5")
    return files


def flicker_clip(d, a):
    files = clip_frames(d, tuple(ints(a.frames.replace("-", ","))) if a.frames else None)
    first = decode(files[0][1])
    regs = regions([files[0][1]], a, first.shape)
    levels = [float(v) for v in a.spike.split(",")]

    def lumas(f):
        Y = decode(f).astype(np.float32) @ LUMA32
        return [cut(Y, box).copy() for _, box in regs]

    with ThreadPoolExecutor(max_workers=max(1, a.jobs), initializer=raise_thread) as pool:
        per = list(pool.map(lumas, [p for _, p in files]))
    n = len(files)
    stacks = [np.stack([f[k] for f in per]) for k in range(len(regs))]
    # odd frames: a frame's flash share over all the regions' pixels against the clip's median
    share = sum((np.abs(s[1:-1] - (s[:-2] + s[2:]) / 2) > levels[0]).sum(axis=(1, 2)) for s in stacks) / sum(s[0].size for s in stacks)
    med = float(np.median(share))
    odd = [int(i) + 1 for i in np.nonzero((share > a.odd * med) & (share > med + ODD_FLOOR))[0]] if a.odd > 0 else []
    out = {"clip": str(d), "frames": [files[0][0], files[-1][0]], "odd": [files[i][0] for i in odd], "dropped": bool(a.drop_odd and odd), "regions": []}
    bad = np.zeros(n, bool)
    if a.drop_odd:
        bad[odd] = True
    # the terms kept: none that reads an odd frame
    k1 = ~(bad[:-1] | bad[1:])
    k2 = ~(bad[:-4] | bad[2:-2] | bad[4:])
    ks = ~(bad[:-2] | bad[1:-1] | bad[2:])
    for k, (label, box) in enumerate(regs):
        s = stacks[k]
        d1 = np.abs(np.diff(s, axis=0))[k1]
        hp = np.abs(s[2:-2] - (s[:-4] + s[4:]) / 2)[k2]
        sp = (s[1:-1] - (s[:-2] + s[2:]) / 2)[ks]
        ab = np.abs(sp)
        r = {"region": label, "box": list(box), "F": round(float(d1.mean()), 3), "Fhp": round(float(hp.mean()), 3)}
        for v in levels:
            r[f"spike>{v:g}"] = round(float((ab > v).mean()) * 1e3, 3)
        r[f"bright>{levels[0]:g}"] = round(float((sp > levels[0]).mean()) * 1e3, 3)
        r["p999"] = round(float(np.percentile(ab, 99.9)), 2)
        flashes = ab > levels[0]
        r["once"] = round(float(flashes.any(axis=0).mean()) * 100, 2)
        r["std"] = round(float(s[~bad].std(axis=0).mean()), 3)
        r["mean"] = round(float(s[~bad].mean()), 2)
        if a.map:
            m = Path(a.map)
            if m.suffix.lower() != ".png":
                m.mkdir(parents=True, exist_ok=True)
                m = m / (Path(d).name + (f".{label}" if label else "") + ".flash.png")
            else:
                m.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(np.clip(flashes.mean(axis=0) * 255 * a.gain, 0, 255).astype(np.uint8)).save(m)
            r["map"] = str(m)
        out["regions"].append(r)
    if a.save:
        (Path(d) / "flicker.json").write_text(json.dumps(out, indent=1))
    return out


def cmd_flicker(a):
    if a.map and Path(a.map).suffix.lower() == ".png" and (len(a.clips) > 1 or len(a.box or []) + (1 if a.anchor else 0) > 1):
        sys.exit("flicker: --map takes a directory when there are several clips or regions")
    res = [flicker_clip(d, a) for d in a.clips]
    if a.json:
        print(json.dumps(res, indent=2))
        return
    lv = [f"{float(v):g}" for v in a.spike.split(",")]
    w = max([len(Path(c["clip"]).name + (f" / {r['region']}" if r["region"] else "")) for c in res for r in c["regions"]] + [4])
    print(f"{'clip':{w}} {'F':>6} {'Fhp':>6} " + " ".join(f"{'>' + v + '‰':>8}" for v in lv)
          + f" {'bright‰':>8} {'p999':>6} {'once%':>6} {'std':>6} {'mean':>7}")
    for c in res:
        for r in c["regions"]:
            n = Path(c["clip"]).name + (f" / {r['region']}" if r["region"] else "")
            print(f"{n:{w}} {r['F']:6.3f} {r['Fhp']:6.3f} " + " ".join(f"{r['spike>' + v]:8.3f}" for v in lv)
                  + f" {r['bright>' + lv[0]]:8.3f} {r['p999']:6.2f} {r['once']:6.2f} {r['std']:6.3f} {r['mean']:7.2f}"
                  + (f"  {r['map']}" if r.get("map") else ""))
        if c["odd"]:
            print(f"  odd frames {c['odd']}" + (" (dropped)" if c["dropped"] else " (kept: --drop-odd leaves them out)"))


# ---------------------------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="Image differences, crops, sheets and statistics for captures.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--box", action="append", help="x,y,w,h in image pixels (repeatable)")
        p.add_argument("--anchor", help="named crop anchors from the capture JSON: a,b or all")
        p.add_argument("--anchors", help="anchors from this JSON file instead of <image>.json")
        p.add_argument("--match", default="*.png", help="the files a directory stands for")

    p = sub.add_parser("diff", help="differences of two images or two directories")
    p.add_argument("a")
    p.add_argument("b")
    common(p)
    p.add_argument("--thr", default=",".join(map(str, LEVELS)), help="levels to count pixels over")
    p.add_argument("--bbox-thr", type=int, default=0, help="the level the bounding box encloses")
    p.add_argument("--heat", help="heat map: a .png file for one pair, else a directory")
    p.add_argument("--gain", type=float, default=8)
    p.add_argument("--json", action="store_true")
    p.add_argument("--jobs", type=int, default=min(4, max(1, (os.cpu_count() or 2) // 2)))
    p.set_defaults(fn=cmd_diff)

    p = sub.add_parser("crop", help="cut boxes or named anchors")
    p.add_argument("images", nargs="+")
    common(p)
    p.add_argument("--zoom", type=int, default=1)
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_crop)

    p = sub.add_parser("sheet", help="a labelled grid of images or crops")
    p.add_argument("images", nargs="+")
    common(p)
    p.add_argument("--labels")
    p.add_argument("--cols", type=int)
    p.add_argument("--diff", action="store_true")
    p.add_argument("--gain", type=float, default=8)
    p.add_argument("--zoom", type=int, default=1)
    p.add_argument("--scale", type=float)
    p.add_argument("--width", type=int)
    p.add_argument("--out", required=True)
    p.set_defaults(fn=cmd_sheet)

    p = sub.add_parser("stats", help="mean, luma, percentiles per image or region")
    p.add_argument("images", nargs="+")
    common(p)
    p.add_argument("--pct", default="1,5,50,95,99")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_stats)

    p = sub.add_parser("flicker", help="frame-to-frame flicker of a clip's consecutive frames per region")
    p.add_argument("clips", nargs="+")
    common(p)
    p.add_argument("--frames", help="a-b: the frames to keep")
    p.add_argument("--spike", default="20,40", help="the flash levels counted (the first also for `bright`, `once` and --map)")
    p.add_argument("--map", help="flash map: a .png file for one clip and region, else a directory")
    p.add_argument("--gain", type=float, default=8)
    p.add_argument("--json", action="store_true")
    p.add_argument("--save", action="store_true", help="write <clip>/flicker.json")
    p.add_argument("--odd", type=float, default=2.5, help="an odd frame flashes this many times the clip's median (0: none)")
    p.add_argument("--drop-odd", action="store_true", help="leave out the terms that read an odd frame")
    p.add_argument("--jobs", type=int, default=min(4, max(1, (os.cpu_count() or 2) // 2)))
    p.set_defaults(fn=cmd_flicker)

    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
