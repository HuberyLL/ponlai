"""Compare a parity capture set (tools/parity/capture-set.mjs) against a reference set, view by view.

  uv run --with numpy --with pillow tools/parity/diff-set.py <refDir> <testDir>
      [--views a,b] [--out dir] [--max-px1 200] [--crops 3] [--crop 256]
      [--aa-floor] [--md file.md] [--crops-from ref|test|<dir>|<file.json>]

Per view (each <view>.png present in both): the max absolute channel difference, the mean absolute
difference (over all channels), and how many pixels differ by more than 1, 2, 8 and 32 levels (a
pixel counts when its largest channel difference exceeds the level). `identical` is byte-equality
of the files. For views that differ, it writes <out>/<view>.diff.png (the per-pixel max channel
difference, amplified x8 and clipped) and the N worst regions as side-by-side crops (ref | test |
diff x8) at 1:1, chosen as the windows holding the most difference, non-overlapping.
--max-px1 is a pass threshold: a view passes when it has fewer than that many pixels over 1 level
and none over 2; pass 0 to require identity.

--aa-floor judges by each view's own repeatability instead (both sets captured with --repeat, so
<view>.repeat.png exists on both sides). A view passes when the test frame is byte-identical to the
reference frame (either capture of each side), or when the reference does not repeat (its A/A pair
differs) and the cross difference stays within the larger of the two sides' A/A differences (max
level and the count of pixels over 1 and 2 levels). The test side need not be non-repeatable too:
a test that repeats while the reference does not passes when its frame lies within the reference's
spread (noted as such). A view that repeats on the reference must repeat on the test side, and
must match it byte for byte. Comparing a set with itself (refDir = testDir) lists its A/A floor.
--md writes the table as Markdown too.

--crops-from cuts the named crop anchors (views.mjs; `crops` in each capture's JSON) from both
frames: `ref` or `test` reads <view>.json on that side, a directory reads <view>.json there, and a
JSON file holds either one capture's `crops` (used for every view) or { view: crops }. Each anchor
gets its own difference counts and a ref | test | diff x8 sheet (<out>/<view>.<anchor>.png), and
each view an overview of where its anchors fall (<out>/<view>.anchors.png, the test frame at a
quarter size).

Writes <out>/report.json (default <out>: <testDir>/diff) and prints a table; exit code 1 if any
view fails (or is missing).
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

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
a = ap.parse_args()

ref, test = Path(a.ref), Path(a.test)
out = Path(a.out) if a.out else test / "diff"
out.mkdir(parents=True, exist_ok=True)
views = a.views.split(",") if a.views else sorted(p.stem for p in ref.glob("*.png") if "." not in p.stem)
LEVELS = (1, 2, 8, 32)


def load(f):
    return np.asarray(Image.open(f).convert("RGB"), dtype=np.int16)


def stats(A, B):
    D = np.abs(A - B)
    M = D.max(axis=2)
    return D, M, {
        "max": int(M.max()),
        "mean": round(float(D.mean()), 5),
        "over": {str(l): int((M > l).sum()) for l in LEVELS},
        "pixels": int(M.size),
    }


def sheet(A, B, D, box, title):
    x, y, w, h = box
    tiles = (A[y:y + h, x:x + w], B[y:y + h, x:x + w], np.clip(D[y:y + h, x:x + w] * 8, 0, 255))
    im = Image.new("RGB", (w * 3 + 8, h + 18), "#202020")
    for j, t in enumerate(tiles):
        im.paste(Image.fromarray(t.astype(np.uint8)), (j * (w + 4), 18))
    ImageDraw.Draw(im).text((4, 3), title, fill="white")
    return im


def worst_windows(v, A, B, D, M, r):
    # worst windows: sum of the difference over crop-sized windows on a half-crop grid
    c, h, w = a.crop, M.shape[0], M.shape[1]
    step = c // 2
    S = np.cumsum(np.cumsum(np.pad(M.astype(np.int64), ((1, 0), (1, 0))), 0), 1)
    cands = []
    for y in range(0, max(1, h - c + 1), step):
        for x in range(0, max(1, w - c + 1), step):
            y1, x1 = min(y + c, h), min(x + c, w)
            cands.append((int(S[y1, x1] - S[y, x1] - S[y1, x] + S[y, x]), x, y))
    cands.sort(reverse=True)
    picked = []
    for s, x, y in cands:
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
    im = Image.fromarray(B.astype(np.uint8)).resize((B.shape[1] // k, B.shape[0] // k), Image.BOX)
    dr = ImageDraw.Draw(im)
    for name, x, y, w, h in boxes:
        dr.rectangle((x // k, y // k, (x + w) // k, (y + h) // k), outline="#ff3080", width=2)
        dr.text((x // k + 3, y // k + 2), name, fill="#ff3080")
    missing = [n for n, c in r["anchors"].items() if "missing" in c]
    if missing:
        dr.text((6, im.height - 14), "missing: " + ", ".join(f"{n} ({r['anchors'][n]['missing']})" for n in missing), fill="#ffd040")
    im.save(out / f"{v}.anchors.png")


def aa_pair(d, v):
    fa, fb = d / f"{v}.png", d / f"{v}.repeat.png"
    if not fa.exists() or not fb.exists():
        return None
    if fa.read_bytes() == fb.read_bytes():
        return {"identical": True, "max": 0, "over": {str(l): 0 for l in LEVELS}}
    _, _, st = stats(load(fa), load(fb))
    st["identical"] = False
    return st


def fmt(st):
    if st is None:
        return "no repeat"
    if st.get("identical"):
        return "identical"
    return f"max {st['max']}, {st['over']['1']} px>1, {st['over']['2']} px>2"


report, failed, rows = {}, False, []
if a.aa_floor:
    print(f"{'view':24} {'ref A/A':28} {'test A/A':28} {'cross':28} pass")
else:
    print(f"{'view':24} {'ident':5} {'max':>4} {'mean':>8} " + " ".join(f"{'>' + str(l):>9}" for l in LEVELS) + "  pass")
for v in views:
    fa, fb = ref / f"{v}.png", test / f"{v}.png"
    if not fb.exists() or not fa.exists():
        print(f"{v:24} missing")
        report[v] = {"missing": True}
        rows.append((v, "missing", "", "", "FAIL"))
        failed = True
        continue
    ident = fa.read_bytes() == fb.read_bytes()
    A, B = load(fa), load(fb)
    if A.shape != B.shape:
        print(f"{v:24} size {A.shape} vs {B.shape}")
        report[v] = {"sizeMismatch": [A.shape, B.shape]}
        rows.append((v, "size mismatch", "", "", "FAIL"))
        failed = True
        continue
    D, M, r = stats(A, B)
    r["identical"] = ident
    if a.aa_floor:
        ra, ta = aa_pair(ref, v), aa_pair(test, v)
        r["refAA"], r["testAA"] = ra, ta
        # the cross difference: the closest of the four pairings of the two sides' captures
        cross = r
        pairs = [(ref / f"{v}{s}.png", test / f"{v}{t}.png") for s in ("", ".repeat") for t in ("", ".repeat")]
        if any(p.exists() and q.exists() and p.read_bytes() == q.read_bytes() for p, q in pairs):
            cross, note = {"identical": True, "max": 0, "over": {str(l): 0 for l in LEVELS}}, "identical"
        elif ra is None or ta is None:
            note, ok = "a side has no repeat capture", False
        else:
            for p, q in pairs[1:]:
                if p.exists() and q.exists():
                    _, _, st = stats(load(p), load(q))
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
    else:
        ok = r["over"]["1"] < a.max_px1 and r["over"]["2"] == 0 if a.max_px1 > 0 else ident
    r["pass"] = bool(ok)
    failed |= not ok
    if r["max"] > 0:
        Image.fromarray(np.clip(M * 8, 0, 255).astype(np.uint8)).save(out / f"{v}.diff.png")
        worst_windows(v, A, B, D, M, r)
    if a.crops_from:
        named_crops(v, A, B, D, r)
    report[v] = r
    if a.aa_floor:
        rows.append((v, fmt(r["refAA"]), fmt(r["testAA"]), fmt(r["cross"]), ("ok" if ok else "FAIL") + f" ({r['note']})"))
        print(f"{v:24} {rows[-1][1]:28} {rows[-1][2]:28} {rows[-1][3]:28} {rows[-1][4]}")
    else:
        rows.append((v, "yes" if ident else "no", str(r["max"]), f"{r['mean']:.4f}", " ".join(str(r["over"][str(l)]) for l in LEVELS), "ok" if ok else "FAIL"))
        print(f"{v:24} {('yes' if ident else 'no'):5} {r['max']:4} {r['mean']:8.4f} " + " ".join(f"{r['over'][str(l)]:9}" for l in LEVELS) + ("  ok" if ok else "  FAIL"))
    if a.crops_from:
        for name, c in r["anchors"].items():
            print(f"    {name:20} " + (f"missing ({c['missing']})" if "missing" in c else f"max {c['max']:3}  >1 {c['over']['1']:6}  >2 {c['over']['2']:6}  {c['file']}"))
(out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
if a.md:
    head = ("view", "ref A/A", "test A/A", "cross", "verdict") if a.aa_floor else ("view", "identical", "max", "mean", "px >1 >2 >8 >32", "pass")
    lines = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    lines += ["| " + " | ".join(row) + " |" for row in rows]
    Path(a.md).write_text("\n".join(lines) + "\n")
print(f"report: {out / 'report.json'}")
sys.exit(1 if failed else 0)
