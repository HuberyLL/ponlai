"""Compare a parity capture set (tools/parity/capture-set.mjs) against a reference set, view by view.

  uv run --with numpy --with pillow tools/parity/diff-set.py <refDir> <testDir>
      [--views a,b] [--out dir] [--max-px1 200] [--crops 3] [--crop 256]
      [--aa-floor | --temporal [--flip]] [--md file.md] [--crops-from ref|test|<dir>|<file.json>]
      [--jobs 4]

Per view (each <view>.png present in both): the max absolute channel difference, the mean absolute
difference (over all channels), and how many pixels differ by more than 1, 2, 8 and 32 levels (a
pixel counts when its largest channel difference exceeds the level). `identical` is equality of
the decoded pixels (equal bytes, or equal arrays once decoded): a PNG's bytes depend on the encoder
(the capture tools' fast PNG against Playwright's default one), its pixels do not, so sets written
by either encoder compare alike. For views that differ, it writes <out>/<view>.diff.png (the
per-pixel max channel difference, amplified x8 and clipped) and the N worst regions as
side-by-side crops (ref | test | diff x8) at 1:1, chosen as the windows holding the most
difference, non-overlapping.
--max-px1 is a pass threshold: a view passes when it has fewer than that many pixels over 1 level
and none over 2; pass 0 to require identity.

--aa-floor judges by each view's own repeatability instead (both sets captured with --repeat, so
<view>.repeat.png exists on both sides). A view passes when the test frame is pixel-identical to the
reference frame (either capture of each side), or when the reference does not repeat (its A/A pair
differs) and the cross difference stays within the larger of the two sides' A/A differences (max
level and the count of pixels over 1 and 2 levels). The test side need not be non-repeatable too:
a test that repeats while the reference does not passes when its frame lies within the reference's
spread (noted as such). A view that repeats on the reference must repeat on the test side, and
must match it pixel for pixel. Comparing a set with itself (refDir = testDir) lists its A/A floor.
Both sets must come from the same browser build (`browser` in each capture's JSON): a mismatch is
reported as a warning, since no frame then matches pixel for pixel. --md writes the table as
Markdown too.

--temporal judges temporal AA captures (taa, taau) by the tolerance in tolerance.py instead: their
paused frames do not repeat pixel for pixel (the rest averages 40 frames and freezes the GPU's
own render pass splits), so per-pixel differences up to a level are ignored and the share of pixels over it
is bounded on the frame, in every 32 px window and on every named crop, with the windows' and
crops' mean signed difference bounding coherent shifts under the level (thresholds and their
calibration: tolerance.py). A failure counts only after one recapture: the view passes when any
pairing of the two sides' captures (<view>.png, <view>.repeat.png) passes, and a failing view
without a recapture on the test side says so. `use` is the largest measurement / threshold ratio of
the best pairing (pass: <= 1). Comparing a set with itself (refDir = testDir) judges each view's
A/A pair. The crops are those of --crops-from, else of the test side's JSON. --flip adds the mean
NVIDIA FLIP of the frame, reported only (needs `--with flip-evaluator`). MSAA sets stay pixel-exact
(the default and --aa-floor).

--crops-from cuts the named crop anchors (views.mjs; `crops` in each capture's JSON) from both
frames: `ref` or `test` reads <view>.json on that side, a directory reads <view>.json there, and a
JSON file holds either one capture's `crops` (used for every view) or { view: crops }. Each anchor
gets its own difference counts and a ref | test | diff x8 sheet (<out>/<view>.<anchor>.png), and
each view an overview of where its anchors fall (<out>/<view>.anchors.png, the test frame at a
quarter size).

Writes <out>/report.json (default <out>: <testDir>/diff) and prints a table; exit code 1 if any
view fails (or is missing).

Speed: views are compared in parallel threads (numpy and Pillow's PNG codec release the GIL), --jobs
of them at once: by default 4, or half the CPU's cores when it has fewer than 8, since captures and
world generation share the CPU (--jobs 1 runs them one after the other). Each view decodes each of
its PNGs once and keeps them as uint8; the output is the same as one view at a time, printed in view
order. Window sums are exact integer sums on a coarse integral image (tolerance.window_sums), and
every mean is an exact integer sum divided once, so no number depends on the order of summation.
"""
import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

import tolerance

ap = argparse.ArgumentParser()
ap.add_argument("ref")
ap.add_argument("test")
ap.add_argument("--out", default=None)
ap.add_argument("--crops", type=int, default=3)
ap.add_argument("--crop", type=int, default=256)
ap.add_argument("--max-px1", type=int, default=200)
ap.add_argument("--views", default="")
ap.add_argument("--aa-floor", action="store_true")
ap.add_argument("--md", default=None)
ap.add_argument("--crops-from", default=None)
ap.add_argument("--temporal", action="store_true")
ap.add_argument("--flip", action="store_true")
ap.add_argument("--jobs", type=int, default=min(4, max(1, (os.cpu_count() or 2) // 2)))
a = ap.parse_args()
if a.temporal and a.aa_floor:
    ap.error("--temporal and --aa-floor are two different rules: pick one")

ref, test = Path(a.ref), Path(a.test)
out = Path(a.out) if a.out else test / "diff"
out.mkdir(parents=True, exist_ok=True)
views = a.views.split(",") if a.views else sorted(p.stem for p in ref.glob("*.png") if "." not in p.stem)
LEVELS = (1, 2, 8, 32)
# the difference amplified x8 and clipped, as a lookup on uint8 differences
X8 = np.minimum(np.arange(256) * 8, 255).astype(np.uint8)


class Files:
    """One view's PNGs, each read and decoded once (uint8 H x W x 3)."""

    def __init__(self):
        self.raw, self.img = {}, {}

    def bytes(self, f):
        k = str(f)
        if k not in self.raw:
            self.raw[k] = Path(f).read_bytes()
        return self.raw[k]

    def load(self, f):
        k = str(f)
        if k not in self.img:
            self.img[k] = np.asarray(Image.open(BytesIO(self.bytes(f))).convert("RGB"))
        return self.img[k]

    def same(self, p, q):
        """Identical pixels: equal bytes, else equal decoded arrays (the bytes depend on the encoder)."""
        if self.bytes(p) == self.bytes(q):
            return True
        A, B = self.load(p), self.load(q)
        return A.shape == B.shape and np.array_equal(A, B)


def stats(A, B):
    """|A - B| (uint8, per channel), its per-pixel max over the channels, and the numbers."""
    D = np.maximum(A, B)
    D -= np.minimum(A, B)
    M = np.maximum(np.maximum(D[..., 0], D[..., 1]), D[..., 2])
    # the mean: an exact integer sum over one division (what D.mean() returns, whatever the order);
    # a row of a frame sums to under 2^32
    total = int(D.reshape(D.shape[0], -1).sum(1, dtype=np.uint32).sum(dtype=np.int64))
    return D, M, {
        "max": int(M.max()),
        "mean": round(float(total / D.size), 5),
        "over": {str(l): int(np.count_nonzero(M > l)) for l in LEVELS},
        "pixels": int(M.size),
    }


def sheet(A, B, D, box, title):
    x, y, w, h = box
    tiles = (A[y:y + h, x:x + w], B[y:y + h, x:x + w], X8[D[y:y + h, x:x + w]])
    im = Image.new("RGB", (w * 3 + 8, h + 18), "#202020")
    for j, t in enumerate(tiles):
        im.paste(Image.fromarray(t), (j * (w + 4), 18))
    ImageDraw.Draw(im).text((4, 3), title, fill="white")
    return im


def worst_windows(v, A, B, D, M, r):
    # worst windows: sum of the difference over crop-sized windows on a half-crop grid, the largest
    # first (ties: the larger x, then the larger y), picked greedily without overlap
    c = a.crop
    S, ys, xs = tolerance.window_sums(M, c, c // 2)
    yy, xx = np.meshgrid(ys, xs, indexing="ij")
    S, xx, yy = S.ravel(), xx.ravel(), yy.ravel()
    order = np.lexsort((yy, xx, S))[::-1]
    picked = []
    for k in order:
        s, x, y = int(S[k]), int(xx[k]), int(yy[k])
        if s == 0 or len(picked) >= a.crops:
            break
        if all(abs(x - px) >= c or abs(y - py) >= c for _, px, py in picked):
            picked.append((s, x, y))
    r["crops"] = []
    for i, (s, x, y) in enumerate(picked):
        box = (x, y, x + c, y + c)
        name = f"{v}.crop{i}.png"
        sheet(A, B, D, (x, y, c, c), f"{v} @ {x},{y}: ref | test | diff x8 (max {int(M[y:y+c, x:x+c].max())})").save(out / name)
        r["crops"].append({"file": name, "box": box, "sum": s})


def crops_for(v):
    src = a.crops_from
    if src in ("ref", "test"):
        f = (ref if src == "ref" else test) / f"{v}.json"
    else:
        p = Path(src)
        if p.is_dir():
            f = p / f"{v}.json"
        else:
            d = json.loads(p.read_text())
            return d["crops"] if "crops" in d else d.get(v, {})
    return json.loads(f.read_text()).get("crops", {}) if f.exists() else {}


def named_crops(v, A, B, D, r):
    anchors = crops_for(v)
    r["anchors"] = {}
    boxes = []
    for name, c in anchors.items():
        if "x" not in c:
            r["anchors"][name] = {"missing": c.get("missing", "?")}
            continue
        x, y, w, h = c["x"], c["y"], c["w"], c["h"]
        _, M, st = stats(A[y:y + h, x:x + w], B[y:y + h, x:x + w])
        st["box"] = [x, y, w, h]
        st["file"] = f"{v}.{name}.png"
        r["anchors"][name] = st
        sheet(A, B, D, (x, y, w, h), f"{v} / {name} @ {x},{y}: ref | test | diff x8 (max {st['max']})").save(out / st["file"])
        boxes.append((name, x, y, w, h))
    # where the anchors fall: the test frame at a quarter size
    k = 4
    im = Image.fromarray(B).resize((B.shape[1] // k, B.shape[0] // k), Image.BOX)
    dr = ImageDraw.Draw(im)
    for name, x, y, w, h in boxes:
        dr.rectangle((x // k, y // k, (x + w) // k, (y + h) // k), outline="#ff3080", width=2)
        dr.text((x // k + 3, y // k + 2), name, fill="#ff3080")
    missing = [n for n, c in r["anchors"].items() if "missing" in c]
    if missing:
        dr.text((6, im.height - 14), "missing: " + ", ".join(f"{n} ({r['anchors'][n]['missing']})" for n in missing), fill="#ffd040")
    im.save(out / f"{v}.anchors.png")


def aa_pair(fs, d, v):
    fa, fb = d / f"{v}.png", d / f"{v}.repeat.png"
    if not fa.exists() or not fb.exists():
        return None
    if fs.same(fa, fb):
        return {"identical": True, "max": 0, "over": {str(l): 0 for l in LEVELS}}
    _, _, st = stats(fs.load(fa), fs.load(fb))
    st["identical"] = False
    return st


def fmt(st):
    if st is None:
        return "no repeat"
    if st.get("identical"):
        return "identical"
    return f"max {st['max']}, {st['over']['1']} px>1, {st['over']['2']} px>2"


def temporal(fs, v):
    """The tolerance on the best pairing of the two sides' captures (one recapture before a failure counts)."""
    same = ref.resolve() == test.resolve()
    sides = [("", ".repeat")] if same else [(s, t) for s in ("", ".repeat") for t in ("", ".repeat")]
    crops = crops_for(v) if a.crops_from else (json.loads((test / f"{v}.json").read_text()).get("crops", {}) if (test / f"{v}.json").exists() else {})
    best = None
    for s, t in sides:
        p, q = ref / f"{v}{s}.png", test / f"{v}{t}.png"
        if not (p.exists() and q.exists()):
            continue
        if fs.same(p, q):
            ok, use, why, m = True, 0.0, [], None
        else:
            m = tolerance.measure(fs.load(p), fs.load(q), crops)
            ok, use, why = tolerance.judge(m)
        e = {"pair": ("repeat" if s else "png") + " / " + ("repeat" if t else "png"), "files": [str(p), str(q)], "pass": ok, "use": use, "why": why, "measure": m}
        if best is None or (ok, -use) > (best["pass"], -best["use"]):
            best = e
        if ok and use == 0:
            break
    if best is None:
        return {"pass": False, "use": None, "why": ["no repeat capture" if same else "missing"], "pair": ""}
    if not best["pass"] and not (test / f"{v}.repeat.png").exists():
        best["why"].append("unconfirmed: recapture the view (or capture with --repeat) before counting it")
    return best


def browser(d, v):
    f = d / f"{v}.json"
    try:
        return json.loads(f.read_text()).get("browser") if f.exists() else None
    except ValueError:
        return None


def compare(v):
    """One view: (printed lines, report entry, table row, passed)."""
    fa, fb = ref / f"{v}.png", test / f"{v}.png"
    if not fb.exists() or not fa.exists():
        return [f"{v:24} missing"], {"missing": True}, (v, "missing", "", "", "FAIL"), False
    fs = Files()
    ident = fs.same(fa, fb)
    A, B = fs.load(fa), fs.load(fb)
    if A.shape != B.shape:
        return [f"{v:24} size {A.shape} vs {B.shape}"], {"sizeMismatch": [A.shape, B.shape]}, (v, "size mismatch", "", "", "FAIL"), False
    D, M, r = stats(A, B)
    r["identical"] = ident
    if a.aa_floor:
        ra, ta = aa_pair(fs, ref, v), aa_pair(fs, test, v)
        r["refAA"], r["testAA"] = ra, ta
        # the cross difference: the closest of the four pairings of the two sides' captures
        cross = r
        pairs = [(ref / f"{v}{s}.png", test / f"{v}{t}.png") for s in ("", ".repeat") for t in ("", ".repeat")]
        if any(p.exists() and q.exists() and fs.same(p, q) for p, q in pairs):
            cross, note = {"identical": True, "max": 0, "over": {str(l): 0 for l in LEVELS}}, "identical"
        elif ra is None or ta is None:
            note, ok = "a side has no repeat capture", False
        else:
            for p, q in pairs[1:]:
                if p.exists() and q.exists():
                    _, _, st = stats(fs.load(p), fs.load(q))
                    if (st["max"], st["over"]["1"]) < (cross["max"], cross["over"]["1"]):
                        cross = st
        if cross.get("identical"):
            ok = not (ra and ra["identical"] and ta and not ta["identical"])
            note = "identical" if ok else "test does not repeat where the reference does"
        elif ra is not None and ta is not None:
            if ra["identical"]:
                ok, note = False, "differs where the reference repeats"
            else:
                floor = {k: max(ra[k] if k == "max" else ra["over"][k], ta[k] if k == "max" else ta["over"][k]) for k in ("max", "1", "2")}
                ok = cross["max"] <= floor["max"] and cross["over"]["1"] <= floor["1"] and cross["over"]["2"] <= floor["2"]
                note = "within the A/A floor" if ok else f"over the A/A floor (max {floor['max']}, {floor['1']} px>1, {floor['2']} px>2)"
                if ta["identical"]:
                    note += "; test repeats, the reference does not"
        r["cross"] = {k: cross[k] for k in ("max", "over") if k in cross} | {"identical": bool(cross.get("identical"))}
        r["note"] = note
    elif a.temporal:
        t = temporal(fs, v)
        ok = t["pass"]
        if t.get("files") and t["files"] != [str(fa), str(fb)]:
            # the diff images and crops show the pairing that was judged
            A, B = fs.load(t["files"][0]), fs.load(t["files"][1])
            D, M, r = stats(A, B)
            r["identical"] = t["measure"] is None
        r["temporal"] = t
        if a.flip:
            r["flip"] = tolerance.flip_mean(A, B)
    else:
        ok = r["over"]["1"] < a.max_px1 and r["over"]["2"] == 0 if a.max_px1 > 0 else ident
    r["pass"] = bool(ok)
    if r["max"] > 0:
        Image.fromarray(X8[M]).save(out / f"{v}.diff.png")
        worst_windows(v, A, B, D, M, r)
    if a.crops_from:
        named_crops(v, A, B, D, r)
    if a.aa_floor:
        row = (v, fmt(r["refAA"]), fmt(r["testAA"]), fmt(r["cross"]), ("ok" if ok else "FAIL") + f" ({r['note']})")
        lines = [f"{v:24} {row[1]:28} {row[2]:28} {row[3]:28} {row[4]}"]
    elif a.temporal:
        t, m = r["temporal"], r["temporal"].get("measure")
        mx, off = (m["frame"]["max"], f"{m['frame']['off']:.4%}") if m else (0, f"{0:.4%}")
        verdict = ("ok" if ok else "FAIL") + (f" ({'; '.join(t['why'])})" if t["why"] else "")
        if a.flip and r.get("flip") is not None:
            verdict += f" FLIP {r['flip']:.6f}"
        row = (v, t["pair"], str(mx), off, f"{t['use']:.3f}" if t["use"] is not None else "", verdict)
        lines = [f"{v:24} {t['pair']:15} {mx:4} {off:>8} {row[4]:>6}  {verdict}"]
    else:
        row = (v, "yes" if ident else "no", str(r["max"]), f"{r['mean']:.4f}", " ".join(str(r["over"][str(l)]) for l in LEVELS), "ok" if ok else "FAIL")
        lines = [f"{v:24} {('yes' if ident else 'no'):5} {r['max']:4} {r['mean']:8.4f} " + " ".join(f"{r['over'][str(l)]:9}" for l in LEVELS) + ("  ok" if ok else "  FAIL")]
    if a.crops_from:
        for name, c in r["anchors"].items():
            lines.append(f"    {name:20} " + (f"missing ({c['missing']})" if "missing" in c else f"max {c['max']:3}  >1 {c['over']['1']:6}  >2 {c['over']['2']:6}  {c['file']}"))
    return lines, r, row, bool(ok)


# frames from two browser builds never match pixel for pixel: say so before the table
seen = {(browser(ref, v), browser(test, v)) for v in views}
mixed = sorted({f"{r} vs {t}" for r, t in seen if r and t and r != t})
if mixed:
    print("WARNING: the sets come from different browser builds (" + "; ".join(mixed) + ")")

report, failed, rows = {}, False, []
if a.aa_floor:
    print(f"{'view':24} {'ref A/A':28} {'test A/A':28} {'cross':28} pass")
elif a.temporal:
    print(f"{'view':24} {'pairing':15} {'max':>4} {'px>' + str(tolerance.TEMPORAL['level']):>8} {'use':>6}  verdict")
else:
    print(f"{'view':24} {'ident':5} {'max':>4} {'mean':>8} " + " ".join(f"{'>' + str(l):>9}" for l in LEVELS) + "  pass")
sys.stdout.flush()
with ThreadPoolExecutor(max_workers=max(1, a.jobs)) as pool:
    # map() yields in view order: the table prints as the views finish, in order
    for v, (lines, r, row, ok) in zip(views, pool.map(compare, views)):
        print("\n".join(lines), flush=True)
        report[v], failed = r, failed or not ok
        rows.append(row)
(out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
if a.md:
    head = ("view", "ref A/A", "test A/A", "cross", "verdict") if a.aa_floor else \
        ("view", "pairing", "max", f"px >{tolerance.TEMPORAL['level']}", "use", "verdict") if a.temporal else \
        ("view", "identical", "max", "mean", "px >1 >2 >8 >32", "pass")
    lines = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    lines += ["| " + " | ".join(row) + " |" for row in rows]
    Path(a.md).write_text("\n".join(lines) + "\n")
print(f"report: {out / 'report.json'}")
sys.exit(1 if failed else 0)
