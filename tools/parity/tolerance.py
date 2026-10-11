"""The temporal parity tolerance: when two paused frames of a temporal AA mode (taa, taau) count as
the same image. Imported by diff-set.py (--temporal); every threshold lives in TEMPORAL below.

Why a tolerance: MSAA paused frames are byte-repeatable, temporal ones are not. The GPU ends a render
pass on its own (a tile's binned geometry overflows, preemption) at points that vary from draw to
draw, and a split pass shades a few samples differently (mostly through fragment derivatives). MSAA
shows one frame, so a glitch in it is gone the next frame; the temporal rest averages 40 frames and
freezes whatever glitches those frames held. Making that bit-exact would cost product changes we
chose not to make, so temporal frames are compared the way engine screenshot tests compare frames:
per-pixel differences under a level are ignored, the share of pixels over it is bounded on the
frame and in every local window, and a coherent shift that stays under the level everywhere is
caught by the window's mean signed difference. A failure counts only after one recapture
(diff-set.py: the best of the pairings of both sides' captures, <view>.png and <view>.repeat.png).

The model (all levels are 8-bit code values of the PNG, per channel):
  - Unity's Graphics Test Framework (ImageComparisonSettings): a per-pixel threshold, the share of
    pixels over it (IncorrectPixelsThreshold) and the mean error (AverageCorrectnessThreshold).
  - Unreal's screenshot comparison (FAutomationScreenshotTolerance): a per-channel tolerance with a
    global error (share over tolerance in the frame) and a local error (the same share in any
    block), so that a small, concentrated change cannot hide in a large frame.
  - NVIDIA FLIP (perceptual difference), reported only and only when flip-evaluator is installed:
    the levels above are the gate, since FLIP's mean over a frame is too forgiving of small regions.

Calibration: every A/A pair of one build
recorded (taa, taau and msaa; quiet and contended GPU; forced strike, storm, rain;
vegPrepass=0), and synthetic regressions cut into those frames (a 1-level change over a 48 px
square, a recoloured flower patch, a 0.25 px shift of a 384 px crop, a missing 6 px flower or the
islander's head) that must fail. The worst A/A pair (dense vegetation on a busy GPU) uses 0.43 of
the tolerance (`use`: the largest measurement / threshold); the weakest regression 3.9 times it.
Each threshold sits at two to four times the worst A/A value of its measurement. Windows are
W x W at a stride of W / 2, so any square of 1.5 W lies whole inside one.
"""
import numpy as np

# Every threshold of the temporal rule. A pixel is "off" when its largest channel difference
# exceeds `level`; "big" when it exceeds `big`.
TEMPORAL = {
	"level": 2,
	"big": 16,
	# the frame: share of off pixels, mean |difference| over all channels
	"frame_off": 0.0005,
	"frame_mean": 0.02,
	# every window: share of off pixels, big pixels, |mean signed difference| of any channel
	"window": 32,
	"window_off": 0.06,
	"window_big": 6,
	"window_bias": 0.25,
	# every named crop (views.mjs anchors): share of off pixels, |mean signed difference| of any channel
	"crop_off": 0.004,
	"crop_bias": 0.02,
}


def _windows(X, w):
	"""Sums of X (H x W [x C]) over w x w windows at a stride of w / 2 (an integral image)."""
	s = w // 2
	I = np.zeros((X.shape[0] + 1, X.shape[1] + 1) + X.shape[2:], dtype=np.int64)
	I[1:, 1:] = X.cumsum(0, dtype=np.int64).cumsum(1)
	ys = np.arange(0, max(1, X.shape[0] - w + 1), s)
	xs = np.arange(0, max(1, X.shape[1] - w + 1), s)
	y0, x0 = ys[:, None], xs[None, :]
	y1, x1 = np.minimum(y0 + w, X.shape[0]), np.minimum(x0 + w, X.shape[1])
	return I[y1, x1] - I[y0, x1] - I[y1, x0] + I[y0, x0], ys, xs


def _region(S, M, T):
	n = M.size
	return {
		"off": float((M > T["level"]).sum() / n),
		"big": int((M > T["big"]).sum()),
		"mean": float(np.abs(S).mean()),
		"bias": float(np.abs(S.reshape(-1, 3).mean(0)).max()),
		"max": int(M.max()),
	}


def measure(A, B, crops=None, T=TEMPORAL):
	"""The rule's measurements for frames A (reference) and B (test), int16 H x W x 3."""
	S = (B - A).astype(np.int16)
	M = np.abs(S).max(axis=2)
	r = {"frame": _region(S, M, T)}
	w = T["window"]
	off, ys, xs = _windows((M > T["level"]).astype(np.uint8), w)
	big, _, _ = _windows((M > T["big"]).astype(np.uint8), w)
	bias, _, _ = _windows(S, w)
	bias = np.abs(bias).max(axis=2) / (w * w)
	worst = lambda X: tuple(int(i) for i in np.unravel_index(np.argmax(X), X.shape))
	r["window"] = {}
	for k, X, scale in (("off", off, 1 / (w * w)), ("big", big, 1), ("bias", bias, 1)):
		j, i = worst(X)
		r["window"][k] = {"value": float(X[j, i] * scale) if k != "big" else int(X[j, i]), "at": [int(xs[i]), int(ys[j])]}
	r["crops"] = {}
	for name, c in (crops or {}).items():
		if "x" not in c:
			continue
		x, y, cw, ch = c["x"], c["y"], c["w"], c["h"]
		r["crops"][name] = _region(S[y:y + ch, x:x + cw], M[y:y + ch, x:x + cw], T)
	return r


def checks(r, T=TEMPORAL):
	"""Every measurement against its threshold: (criterion, value, limit, where) per check."""
	f, wn = r["frame"], r["window"]
	yield f"frame px>{T['level']}", f["off"], T["frame_off"], ""
	yield "frame mean", f["mean"], T["frame_mean"], ""
	yield f"window px>{T['level']}", wn["off"]["value"], T["window_off"], wn["off"]["at"]
	yield f"window px>{T['big']}", wn["big"]["value"], T["window_big"], wn["big"]["at"]
	yield "window bias", wn["bias"]["value"], T["window_bias"], wn["bias"]["at"]
	for name, c in r["crops"].items():
		yield f"crop {name} px>{T['level']}", c["off"], T["crop_off"], ""
		yield f"crop {name} bias", c["bias"], T["crop_bias"], ""


def judge(r, T=TEMPORAL):
	"""(pass, use, reasons): use is the largest value / limit over the checks (pass: use <= 1)."""
	why, use = [], 0.0
	for name, v, lim, at in checks(r, T):
		use = max(use, v / lim)
		if v > lim:
			fv = f"{v:.3%}" if "px>" + str(T["level"]) in name else (f"{v:.4f}" if isinstance(v, float) else str(v))
			fl = f"{lim:.3%}" if "px>" + str(T["level"]) in name else str(lim)
			why.append(f"{name} {fv} > {fl}" + (f" @{at[0]},{at[1]}" if at else ""))
	return not why, round(use, 3), why


def flip_mean(A, B):
	"""Mean LDR FLIP of B against A, or None without flip-evaluator (NVIDIA, BSD-3-Clause)."""
	try:
		import flip_evaluator as flip
	except ImportError:
		return None
	_, mean, _ = flip.evaluate((A / 255.0).astype(np.float32), (B / 255.0).astype(np.float32), "LDR")
	return float(mean)
