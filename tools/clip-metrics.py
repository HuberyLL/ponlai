"""Image and temporal metrics of a stepped clip against MSAA and a ground truth.

    uv run --with numpy --with pillow [--with flip-evaluator] tools/clip-metrics.py \
        --test DIR --msaa DIR --gt DIR [--crops a,b] [--thresholds thresholds.json] \
        [--baseline baseline.json] [--out DIR] [--no-flip]

Each DIR is a tools/capture-clip.mjs output folder (clip.json and <crop>/<i>.png) of the same clip:
the mode under test, MSAA (today's image) and the ground truth (`--aa gt-hi` until `aa=gt` exists).
Frames present in all three are compared, per crop. A test or MSAA crop larger than the GT's (the
default 384 px against gt-hi's 288 px) is area-resampled to the GT's size first (PIL's box
filter), so every metric is taken at the GT's resolution. Luma L is Rec. 709 luma of the 8-bit
sRGB-encoded values (0-255 levels): differences in levels are what the eye and the PNGs see.

Metrics (per crop, for the test and for MSAA, each against the GT; "ratio" is test / MSAA):

  B       brightness: mean L of the clip / the GT's (1 = as bright).
  F       flicker: mean over frame pairs of the mean |L_t - L_t-1| (levels). Raw frame-to-frame
          change, true motion included: compare like with like.
  TI      temporal instability: mean over frame pairs of the mean |dL_t - dL_gt,t| with
          dL_t = L_t - L_t-1: the change from frame to frame that the GT does not have (shimmer,
          crawl, jitter left in the output), 0 = as steady as the GT.
  S       sharpness: mean Sobel gradient magnitude of L / the GT's (below 1 softer, above 1
          sharper or noisier).
  FLIP    mean NVIDIA FLIP (LDR) per frame against the GT, averaged (needs flip-evaluator);
  MAE     else the mean |RGB - GT| in levels.
  G       ghosting: among pixels where the GT changed by more than 16 levels over two frames
          (moving content), the share where the clip at t is off the GT at t by more than 8 levels
          and closer to the GT at t-2 by more than 4: a trail of where things were. Fine detail
          that a render resolves differently from the GT scores a little too, so judge it against
          MSAA's.
  L       lag: the shift in frames (0 to 4) that best lines up the frame-to-frame changes of the
          clip's mean L with the GT's (a flash or a cut that the clip shows late); 0 = none.
  R       ringing: over the GT's edges (Sobel above 32), the mean overshoot of L beyond the GT's
          own 3 x 3 range (levels): sharpening halos.
  W       vegetation coverage: the share of green pixels (hue 60-170 degrees, saturation above
          0.2, value above 0.08) / the GT's: blades and leaves thinner (below 1) or fatter.
  fringe  mean L in a 2 px band along the border of green and blue (sea or sky: hue 180-250,
          saturation above 0.15) pixels, minus the GT's (levels; above 0 a pale fringe).
  N_f     flower heads: blobs of 2 to 400 px (scaled to the crop's size) of bright or strongly
          coloured non-green pixels / the GT's count, mean over frames.
  C_f     flower head contrast: mean L of the heads minus that of a 3 px ring around them / the
          GT's.
  meadow  for meadow crops: mean L, mean saturation, green share and the local standard deviation
          of L (5 x 5, texture), each / the GT's.
  stars   for star crops: points (local maxima at least 20 levels over the median) / the GT's
          count, and their mean excess / the GT's.
  glints  for sea-glint crops: the share of pixels above 235 levels / the GT's, and the energy
          above 235 / the GT's.
  shift   the global image shift against the GT (phase correlation, sub-pixel), its length in GT
          pixels, mean over frames: a jitter or reprojection offset left in the output.
  V       sharpness step: the largest change of the per-frame sharpness ratio (S of that frame)
          from one frame to the next: a visible softening or sharpening step (dynamic
          resolution).

Crops: every crop folder of the GT, or those named by --crops. The "full" folder (whole frames,
capture-clip.mjs --full) is measured only when --crops names it: the window statistics, the phase
correlation and FLIP over whole frames take gigabytes and minutes, and the meadow, flower, star and
glint statistics are meant for crops of those subjects.

Gates: thresholds.json holds a rule per metric, {"metrics": {"TI": {"max": 1.0, "floor": 0.3},
"S": {"min": 0.95}, "B": {"band": [0.98, 1.02]}, "fringe": {"diff": [-2, 2]}}} (a key
"<crop>/<metric>" overrides it for one crop; nested metrics are named as in the table, e.g.
"meadow.luma"). The baseline b is the MSAA side measured here, or, with --baseline, the "msaa"
values of an earlier metrics.json (same clip and crops; plan section 3.3 measures it once per
merge-base). Two forms:

  ratio       for magnitudes (F, TI, FLIP/MAE, G, R, shift, V) and the ratios to the GT (B, S, W,
              N_f, C_f, meadow.*, stars.*, glints.*):
                "max": r      PASS if test <= max( r x b, floor )
                "min": r      PASS if test >= r x b
                "band": [lo, hi]  PASS if lo <= test / b <= hi; with |b| <= floor (b about 0, where
                              a ratio means nothing) PASS if |test| <= floor
              "floor" (default 0) is an absolute allowance in the metric's own units, not an MSAA
              value: under MSAA a paused clip's frames repeat, so its F and TI are exactly 0 and a
              pure ratio would fail any residual of a temporal resolve however small.
  difference  for the signed and integer metrics, fringe (levels, either sign) and L (frames):
                "diff": [lo, hi]  PASS if lo <= test - b <= hi
              A ratio rule on these is refused: a ratio to a negative fringe inverts its gate, and
              L is usually 0.

Without thresholds the table is informational.

Outputs: <out>/metrics.json (per crop: test, msaa, ratio, per-frame series and verdicts) and
<out>/metrics.md (a table), out defaulting to <test>/metrics.
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image

try:
	import flip_evaluator as flip  # NVIDIA FLIP (BSD-3-Clause), optional
except Exception:  # noqa: BLE001
	flip = None


def frames_of( folder, crop ):

	d = os.path.join( folder, crop )
	if not os.path.isdir( d ):
		return {}
	return { int( f[ :-4 ] ): os.path.join( d, f ) for f in os.listdir( d ) if f.endswith( '.png' ) and f[ :-4 ].isdigit() }


def load( path, size=None ):

	im = Image.open( path ).convert( 'RGB' )
	if size is not None and im.size != size:
		im = im.resize( size, Image.BOX )
	return np.asarray( im, dtype=np.float64 )


def luma( rgb ):

	return rgb[ ..., 0 ] * 0.2126 + rgb[ ..., 1 ] * 0.7152 + rgb[ ..., 2 ] * 0.0722


def hsv( rgb ):

	x = rgb / 255.0
	mx, mn = x.max( -1 ), x.min( -1 )
	d = mx - mn
	h = np.zeros_like( mx )
	safe = np.where( d > 1e-9, d, 1.0 )
	r, g, b = x[ ..., 0 ], x[ ..., 1 ], x[ ..., 2 ]
	h = np.where( mx == r, ( ( g - b ) / safe ) % 6, h )
	h = np.where( mx == g, ( b - r ) / safe + 2, h )
	h = np.where( mx == b, ( r - g ) / safe + 4, h )
	h = np.where( d > 1e-9, h * 60.0, 0.0 )
	s = np.where( mx > 1e-9, d / np.where( mx > 1e-9, mx, 1.0 ), 0.0 )
	return h, s, mx


def sobel( lum ):

	p = np.pad( lum, 1, mode='edge' )
	gx = ( p[ :-2, 2: ] + 2 * p[ 1:-1, 2: ] + p[ 2:, 2: ] ) - ( p[ :-2, :-2 ] + 2 * p[ 1:-1, :-2 ] + p[ 2:, :-2 ] )
	gy = ( p[ 2:, :-2 ] + 2 * p[ 2:, 1:-1 ] + p[ 2:, 2: ] ) - ( p[ :-2, :-2 ] + 2 * p[ :-2, 1:-1 ] + p[ :-2, 2: ] )
	return np.hypot( gx, gy ) / 4.0


def window( a, k, fn ):

	r = k // 2
	p = np.pad( a, r, mode='edge' )
	stack = [ p[ y:y + a.shape[ 0 ], x:x + a.shape[ 1 ] ] for y in range( k ) for x in range( k ) ]
	return fn( np.stack( stack ), axis=0 )


def green_mask( rgb ):

	h, s, v = hsv( rgb )
	return ( h >= 60 ) & ( h <= 170 ) & ( s > 0.2 ) & ( v > 0.08 )


def blue_mask( rgb ):

	h, s, v = hsv( rgb )
	return ( h >= 180 ) & ( h <= 250 ) & ( s > 0.15 )


def dilate( mask, r ):

	return window( mask.astype( np.uint8 ), 2 * r + 1, np.max ) > 0


def components( mask, lo, hi ):

	"""Connected components (4-neighbour) of a boolean mask with lo <= size <= hi, as index arrays."""
	h, w = mask.shape
	seen = np.zeros_like( mask, dtype=bool )
	out = []
	ys, xs = np.nonzero( mask )
	for y0, x0 in zip( ys, xs ):
		if seen[ y0, x0 ]:
			continue
		stack = [ ( y0, x0 ) ]
		seen[ y0, x0 ] = True
		pix = []
		while stack:
			y, x = stack.pop()
			pix.append( ( y, x ) )
			if len( pix ) > hi:
				# keep flooding to mark it seen, but it is too large to count
				pass
			for ny, nx in ( ( y + 1, x ), ( y - 1, x ), ( y, x + 1 ), ( y, x - 1 ) ):
				if 0 <= ny < h and 0 <= nx < w and mask[ ny, nx ] and not seen[ ny, nx ]:
					seen[ ny, nx ] = True
					stack.append( ( ny, nx ) )
		if lo <= len( pix ) <= hi:
			out.append( np.array( pix ) )
	return out


def flower_heads( rgb ):

	h, s, v = hsv( rgb )
	lum = luma( rgb )
	green = ( h >= 60 ) & ( h <= 170 )
	bright = ( lum > 150 ) & ( ~green | ( s < 0.25 ) )
	coloured = ( ~green ) & ( s > 0.35 ) & ( v > 0.4 ) & ( h < 60 ) | ( ~green ) & ( s > 0.35 ) & ( v > 0.4 ) & ( h > 250 )
	scale = ( rgb.shape[ 0 ] * rgb.shape[ 1 ] ) / ( 384 * 384 )
	heads = components( bright | coloured, max( 2, int( round( 2 * scale ) ) ), int( round( 400 * scale ) ) )
	if not heads:
		return 0, 0.0
	mask = np.zeros( lum.shape, dtype=bool )
	for c in heads:
		mask[ c[ :, 0 ], c[ :, 1 ] ] = True
	ring = dilate( mask, 3 ) & ~mask
	contrast = float( lum[ mask ].mean() - lum[ ring ].mean() ) if ring.any() else 0.0
	return len( heads ), contrast


def phase_shift( a, b ):

	"""Sub-pixel shift of b against a by phase correlation (parabolic peak refinement)."""
	wy = np.hanning( a.shape[ 0 ] )[ :, None ] * np.hanning( a.shape[ 1 ] )[ None, : ]
	fa = np.fft.fft2( ( a - a.mean() ) * wy )
	fb = np.fft.fft2( ( b - b.mean() ) * wy )
	r = fa * np.conj( fb )
	r /= np.abs( r ) + 1e-12
	c = np.real( np.fft.ifft2( r ) )
	y, x = np.unravel_index( np.argmax( c ), c.shape )

	def refine( cm, c0, cp ):
		den = cm - 2 * c0 + cp
		return 0.0 if abs( den ) < 1e-12 else 0.5 * ( cm - cp ) / den

	h, w = c.shape
	dy = y + refine( c[ ( y - 1 ) % h, x ], c[ y, x ], c[ ( y + 1 ) % h, x ] )
	dx = x + refine( c[ y, ( x - 1 ) % w ], c[ y, x ], c[ y, ( x + 1 ) % w ] )
	if dy > h / 2:
		dy -= h
	if dx > w / 2:
		dx -= w
	return float( np.hypot( dx, dy ) )


def stars( lum ):

	bg = float( np.median( lum ) )
	peak = window( lum, 3, np.max )
	points = ( lum == peak ) & ( lum >= bg + 20 )
	return int( points.sum() ), float( ( lum[ points ] - bg ).mean() ) if points.any() else 0.0


def safe_ratio( a, b ):

	if a is None or b is None:
		return None
	if abs( b ) < 1e-12:
		return None if abs( a ) >= 1e-12 else 1.0
	return a / b


def measure( clip_frames, gt_frames, crop, use_flip ):

	"""Metrics of one side's frames (dict i -> rgb) against the GT's, both resampled alike."""
	idx = sorted( clip_frames )
	L = { i: luma( clip_frames[ i ] ) for i in idx }
	Lg = { i: luma( gt_frames[ i ] ) for i in idx }
	out, series = {}, {}
	out[ 'B' ] = safe_ratio( float( np.mean( [ L[ i ].mean() for i in idx ] ) ), float( np.mean( [ Lg[ i ].mean() for i in idx ] ) ) )
	pairs = [ ( a, b ) for a, b in zip( idx, idx[ 1: ] ) ]
	out[ 'F' ] = float( np.mean( [ np.abs( L[ b ] - L[ a ] ).mean() for a, b in pairs ] ) ) if pairs else None
	out[ 'TI' ] = float( np.mean( [ np.abs( ( L[ b ] - L[ a ] ) - ( Lg[ b ] - Lg[ a ] ) ).mean() for a, b in pairs ] ) ) if pairs else None
	sharp = [ safe_ratio( float( sobel( L[ i ] ).mean() ), float( sobel( Lg[ i ] ).mean() ) ) for i in idx ]
	series[ 'S' ] = sharp
	out[ 'S' ] = float( np.mean( [ s for s in sharp if s is not None ] ) ) if any( s is not None for s in sharp ) else None
	steps = [ abs( b - a ) for a, b in zip( sharp, sharp[ 1: ] ) if a is not None and b is not None ]
	out[ 'V' ] = float( max( steps ) ) if steps else None
	if use_flip:
		errs = []
		for i in idx:
			_, mean, _ = flip.evaluate( ( gt_frames[ i ] / 255.0 ).astype( np.float32 ), ( clip_frames[ i ] / 255.0 ).astype( np.float32 ), 'LDR' )
			errs.append( float( mean ) )
		series[ 'FLIP' ] = errs
		out[ 'FLIP' ] = float( np.mean( errs ) )
	else:
		errs = [ float( np.abs( clip_frames[ i ] - gt_frames[ i ] ).mean() ) for i in idx ]
		series[ 'MAE' ] = errs
		out[ 'MAE' ] = float( np.mean( errs ) )
	# ghosting over moving content (two frames back)
	ghost, moving = 0, 0
	for k in range( 2, len( idx ) ):
		t, p = idx[ k ], idx[ k - 2 ]
		m = np.abs( Lg[ t ] - Lg[ p ] ) > 16
		moving += int( m.sum() )
		err = np.abs( L[ t ] - Lg[ t ] )
		ghost += int( ( m & ( err > 8 ) & ( np.abs( L[ t ] - Lg[ p ] ) + 4 < err ) ).sum() )
	out[ 'G' ] = ghost / moving if moving else None
	# lag of the mean luma's changes
	if len( idx ) > 6:
		mt = np.diff( [ L[ i ].mean() for i in idx ] )
		mg = np.diff( [ Lg[ i ].mean() for i in idx ] )
		if np.abs( mg ).max() > 0.05:
			best, lag = - np.inf, 0
			for s in range( 0, 5 ):
				c = float( np.dot( mt[ s: ], mg[ :len( mg ) - s ] ) )
				if c > best:
					best, lag = c, s
			out[ 'L' ] = lag
		else:
			out[ 'L' ] = 0
	else:
		out[ 'L' ] = None
	# ringing over the GT's edges
	ring = []
	for i in idx:
		edges = sobel( Lg[ i ] ) > 32
		if not edges.any():
			continue
		hi = window( Lg[ i ], 3, np.max )
		lo = window( Lg[ i ], 3, np.min )
		over = np.maximum( L[ i ] - hi, 0 ) + np.maximum( lo - L[ i ], 0 )
		ring.append( float( over[ edges ].mean() ) )
	out[ 'R' ] = float( np.mean( ring ) ) if ring else None
	# vegetation coverage and the fringe against sea or sky
	gs = [ safe_ratio( float( green_mask( clip_frames[ i ] ).mean() ), float( green_mask( gt_frames[ i ] ).mean() ) ) for i in idx ]
	gs = [ g for g in gs if g is not None ]
	out[ 'W' ] = float( np.mean( gs ) ) if gs else None
	fr = []
	for i in idx:
		g, b = green_mask( gt_frames[ i ] ), blue_mask( gt_frames[ i ] )
		band = dilate( g, 2 ) & dilate( b, 2 )
		if band.sum() >= 20:
			fr.append( float( L[ i ][ band ].mean() - Lg[ i ][ band ].mean() ) )
	out[ 'fringe' ] = float( np.mean( fr ) ) if fr else None
	# flowers
	if 'flower' in crop or 'meadow' in crop:
		nf, cf = [], []
		for i in idx:
			n, c = flower_heads( clip_frames[ i ] )
			ng, cg = flower_heads( gt_frames[ i ] )
			nf.append( safe_ratio( float( n ), float( ng ) ) )
			cf.append( safe_ratio( c, cg ) )
		nf = [ x for x in nf if x is not None ]
		cf = [ x for x in cf if x is not None ]
		out[ 'N_f' ] = float( np.mean( nf ) ) if nf else None
		out[ 'C_f' ] = float( np.mean( cf ) ) if cf else None
	if 'meadow' in crop or 'flower' in crop:
		def stats( rgb ):
			lum = luma( rgb )
			_, s, _ = hsv( rgb )
			local = np.sqrt( np.maximum( window( lum * lum, 5, np.mean ) - window( lum, 5, np.mean ) ** 2, 0 ) )
			return np.array( [ lum.mean(), s.mean(), green_mask( rgb ).mean(), local.mean() ] )
		a = np.mean( [ stats( clip_frames[ i ] ) for i in idx ], axis=0 )
		g = np.mean( [ stats( gt_frames[ i ] ) for i in idx ], axis=0 )
		out[ 'meadow' ] = { k: safe_ratio( float( x ), float( y ) ) for k, x, y in zip( [ 'luma', 'saturation', 'green', 'texture' ], a, g ) }
	if 'star' in crop:
		pts = [ stars( L[ i ] ) for i in idx ]
		gpts = [ stars( Lg[ i ] ) for i in idx ]
		out[ 'stars' ] = { 'count': safe_ratio( float( np.mean( [ p[ 0 ] for p in pts ] ) ), float( np.mean( [ p[ 0 ] for p in gpts ] ) ) ),
			'excess': safe_ratio( float( np.mean( [ p[ 1 ] for p in pts ] ) ), float( np.mean( [ p[ 1 ] for p in gpts ] ) ) ) }
	if 'glint' in crop:
		share = lambda lum: float( ( lum > 235 ).mean() )
		energy = lambda lum: float( np.maximum( lum - 235, 0 ).sum() )
		out[ 'glints' ] = { 'share': safe_ratio( float( np.mean( [ share( L[ i ] ) for i in idx ] ) ), float( np.mean( [ share( Lg[ i ] ) for i in idx ] ) ) ),
			'energy': safe_ratio( float( np.mean( [ energy( L[ i ] ) for i in idx ] ) ), float( np.mean( [ energy( Lg[ i ] ) for i in idx ] ) ) ) }
	shifts = [ phase_shift( Lg[ i ], L[ i ] ) for i in idx ]
	series[ 'shift' ] = shifts
	out[ 'shift' ] = float( np.mean( shifts ) )
	return out, series


def flatten( d, prefix='' ):

	out = {}
	for k, v in d.items():
		if isinstance( v, dict ):
			out.update( flatten( v, f'{ prefix }{ k }.' ) )
		else:
			out[ f'{ prefix }{ k }' ] = v
	return out


# metrics gated by their difference to the baseline, never by a ratio (see the docstring)
DIFF_METRICS = { 'fringe', 'L' }
RATIO_KEYS = { 'max', 'min', 'band' }


def check_thresholds( thresholds ):

	for key, rule in thresholds.items():
		name = key.split( '/' )[ -1 ]
		keys = set( rule ) - { 'floor' }
		if name in DIFF_METRICS and keys & RATIO_KEYS:
			raise SystemExit( f'thresholds: { key } is a signed or integer metric: gate it with "diff": [lo, hi], not { sorted( keys & RATIO_KEYS ) }' )
		if 'diff' in rule and keys & RATIO_KEYS:
			raise SystemExit( f'thresholds: { key } mixes "diff" with ratio gates' )
		unknown = keys - RATIO_KEYS - { 'diff' }
		if unknown:
			raise SystemExit( f'thresholds: { key } has unknown keys { sorted( unknown ) }' )


def verdict( name, crop, test, base, thresholds ):

	rule = thresholds.get( f'{ crop }/{ name }', thresholds.get( name ) )
	if rule is None or test is None or base is None:
		return None
	eps = 1e-12
	if 'diff' in rule:
		lo, hi = rule[ 'diff' ]
		return 'PASS' if lo - eps <= test - base <= hi + eps else 'FAIL'
	floor = float( rule.get( 'floor', 0.0 ) )
	if 'max' in rule and test > max( rule[ 'max' ] * base, floor ) + eps:
		return 'FAIL'
	if 'min' in rule and test < rule[ 'min' ] * base - eps:
		return 'FAIL'
	if 'band' in rule:
		if abs( base ) <= max( floor, eps ):
			if abs( test ) > floor + eps:
				return 'FAIL'
		elif not ( rule[ 'band' ][ 0 ] <= test / base <= rule[ 'band' ][ 1 ] ):
			return 'FAIL'
	return 'PASS'


def main():

	ap = argparse.ArgumentParser( description=__doc__.split( '\n' )[ 0 ] )
	ap.add_argument( '--test', required=True )
	ap.add_argument( '--msaa', required=True )
	ap.add_argument( '--gt', required=True )
	ap.add_argument( '--crops' )
	ap.add_argument( '--thresholds' )
	ap.add_argument( '--baseline' )
	ap.add_argument( '--out' )
	ap.add_argument( '--no-flip', action='store_true' )
	a = ap.parse_args()
	use_flip = flip is not None and not a.no_flip
	clip_json = {}
	for side, d in ( ( 'test', a.test ), ( 'msaa', a.msaa ), ( 'gt', a.gt ) ):
		p = os.path.join( d, 'clip.json' )
		clip_json[ side ] = json.load( open( p ) ) if os.path.exists( p ) else {}
	names = { c.get( 'clip' ) for c in clip_json.values() if c.get( 'clip' ) }
	if len( names ) > 1:
		print( f'warning: the folders hold different clips: { sorted( names ) }', file=sys.stderr )
	# whole frames only when named (see the docstring)
	crops = a.crops.split( ',' ) if a.crops else sorted( c for c in os.listdir( a.gt ) if os.path.isdir( os.path.join( a.gt, c ) ) and c not in ( 'metrics', 'full' ) )
	thresholds = json.load( open( a.thresholds ) ).get( 'metrics', {} ) if a.thresholds else {}
	check_thresholds( thresholds )
	baseline = json.load( open( a.baseline ) ) if a.baseline else None
	result = { 'clip': sorted( names ), 'metric': 'FLIP' if use_flip else 'MAE', 'test': a.test, 'msaa': a.msaa, 'gt': a.gt,
		'baseline': a.baseline, 'thresholds': a.thresholds, 'crops': {} }
	for crop in crops:
		ft, fm, fg = frames_of( a.test, crop ), frames_of( a.msaa, crop ), frames_of( a.gt, crop )
		idx = sorted( set( ft ) & set( fm ) & set( fg ) )
		if not idx:
			result[ 'crops' ][ crop ] = { 'missing': 'no frame in all three folders' }
			continue
		gt = { i: load( fg[ i ] ) for i in idx }
		size = ( gt[ idx[ 0 ] ].shape[ 1 ], gt[ idx[ 0 ] ].shape[ 0 ] )
		test = { i: load( ft[ i ], size ) for i in idx }
		msaa = { i: load( fm[ i ], size ) for i in idx }
		mt, st = measure( test, gt, crop, use_flip )
		mm, sm = measure( msaa, gt, crop, use_flip )
		ft_, fm_ = flatten( mt ), flatten( mm )
		base = flatten( baseline[ 'crops' ][ crop ][ 'msaa' ] ) if baseline and crop in baseline.get( 'crops', {} ) and 'msaa' in baseline[ 'crops' ][ crop ] else fm_
		entry = { 'frames': len( idx ), 'size': list( size ), 'test': mt, 'msaa': mm,
			'ratio': { k: safe_ratio( v, fm_.get( k ) ) for k, v in ft_.items() if isinstance( v, ( int, float ) ) },
			'series': { 'test': st, 'msaa': sm } }
		if thresholds:
			entry[ 'verdict' ] = { k: verdict( k, crop, v, base.get( k ), thresholds ) for k, v in ft_.items() }
		result[ 'crops' ][ crop ] = entry
	out = a.out or os.path.join( a.test, 'metrics' )
	os.makedirs( out, exist_ok=True )
	json.dump( result, open( os.path.join( out, 'metrics.json' ), 'w' ), indent=1 )
	# the table
	fmt = lambda v: '–' if v is None else ( f'{ v:.4g}' if isinstance( v, float ) else str( v ) )
	lines = [ f'# clip metrics: { ", ".join( result[ "clip" ] ) }', '', f'test `{ a.test }`, MSAA `{ a.msaa }`, GT `{ a.gt }`; { result[ "metric" ] }' + ( f'; baseline `{ a.baseline }`' if a.baseline else '' ), '' ]
	failed = 0
	for crop, e in result[ 'crops' ].items():
		lines.append( f'## { crop }' )
		if 'missing' in e:
			lines += [ '', e[ 'missing' ], '' ]
			continue
		lines += [ '', f'{ e[ "frames" ] } frames at { e[ "size" ][ 0 ] }x{ e[ "size" ][ 1 ] }', '', '| metric | test | MSAA | test / MSAA | gate |', '|---|---|---|---|---|' ]
		ft_, fm_ = flatten( e[ 'test' ] ), flatten( e[ 'msaa' ] )
		for k in ft_:
			v = e.get( 'verdict', {} ).get( k )
			failed += v == 'FAIL'
			lines.append( f'| { k } | { fmt( ft_[ k ] ) } | { fmt( fm_.get( k ) ) } | { fmt( e[ "ratio" ].get( k ) ) } | { v or "" } |' )
		lines.append( '' )
	if thresholds:
		lines.append( f'**{ "FAIL" if failed else "PASS" }** ({ failed } gates failed)' )
	open( os.path.join( out, 'metrics.md' ), 'w' ).write( '\n'.join( lines ) + '\n' )
	print( '\n'.join( lines ) )
	sys.exit( 1 if failed else 0 )


if __name__ == '__main__':
	main()
