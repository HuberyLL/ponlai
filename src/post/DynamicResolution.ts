import type * as THREE from 'three/webgpu';

// Dynamic resolution (high tier): the scene's render scale moves between the tier's maximum and a
// floor so that the GPU's frame time stays inside the paced frame (a 60 Hz frame, `FramePacer.ts`),
// changing as seldom as it can: every change softens or sharpens the whole image at once.
//
// Its interface to the frame graph is one number per frame: `scale`, the render's pixel ratio,
// read after `update()` and applied to the next frame (main.ts sizes the frame graph's targets
// from it and upscales the render to the canvas). In return it takes, per frame, the GPU's busy
// time, the part of it in passes whose targets are sized from the render (`PassScaling` sorts them
// by size, so an upscaler's canvas-sized passes count as fixed whatever upscaler it is). Nothing
// else about the frame graph is assumed.
//
// - The GPU time comes from timestamp queries (`GpuFrameTimer`, or the frame profiler's own when it
//   runs), as the time the GPU was busy with each frame: every pass charged from the previous
//   pass's completion (or its own start, if later) to its end. A tile-based GPU stamps a pass's
//   start when its vertex stage begins, long before the passes it reads have finished, so the raw
//   intervals overlap; summed they come to several times the frame. Without timestamp queries the
//   frame intervals steer it instead (`sampleInterval`).
// - Each frame's time is split by pass: passes into targets sized from the render (the scene, its
//   resolves and copies, the post chain, bloom's mips) and the rest (the canvas-sized upscale and
//   output, shadow maps, the FFT, every compute pass, the cloud view sized from the display, sky
//   bakes), which cost the same at any scale. One fixed share for every view was half the
//   horizon's (whose cloud view and sky take about four fifths of its frame), so every step down
//   there fell short and a single drop took three or four. The render-sized passes do not all
//   follow the pixel count either: their vertex work (the meadow's blades, the terrain, the sea's
//   grid) is the same at any scale. Timed at fixed scales they cost a share of their time at
//   scale 1 plus the rest in proportion to the pixel count (s^2): the share, `nonScaling`, was
//   0.4 - 0.5 over the island and the horizon between scales 0.8 and 1.5. It starts there and is
//   measured again at every change of scale (the render-sized passes' median just before and just
//   after), the median of the last SHARE_KEEP measurements.
// - Every sample keeps the scale it was drawn at, so frames at any scale predict the cost at any
//   other: fixed + render-sized x g(s') / g(s), g(s) = k + (1 - k) s^2. Decisions read a quantile
//   of those predictions.
// - It steers a high quantile (the 90th percentile) by what the display shows. With frames paced
//   to every second refresh, the share of frames presented a refresh late stayed at its floor
//   (1-2 %) until that quantile passed about seven eighths of the paced interval, then rose steeply
//   (to about a third of the frames once it ran 5 % over the interval).
// - Down: when the quantile of the frames at the scale passes the paced interval less
//   DOWN_HEADROOM (at most every HOLD seconds; after EMERGENCY_HOLD when the last frames take the
//   whole interval), straight to the largest scale predicted to land under the interval less
//   TARGET_HEADROOM, in one change. A step that would save under MIN_SAVING ms is not taken: the
//   view is bound by its fixed work, and a softer image would not make it faster. A frame whose
//   pass split finds no render-sized pass (a frame graph that renders into targets of another size,
//   such as max-size targets drawn through a viewport) is taken as wholly render-sized, with a
//   warning (`onWarning`): otherwise every scale would predict the same cost.
// - Up: after UP_HOLD seconds at the scale, in one jump to the largest scale that the last UP_SHORT
//   seconds predict lands under the target with UP_MARGIN ms to spare, once the last UP_LONG
//   seconds (every frame moved to the candidate scale) allow at least as much: a view whose cost
//   swings (the camera turning from the horizon back to the island) waits until the heavier frames
//   have left the long window and then steps once. A scale it stepped up to and had to leave within
//   PROBE seconds is barred, with every scale above it, for BAR seconds.
// - Without GPU times (no timestamp queries, `gpuTimer=off`) the frame intervals steer it, one step
//   at a time: down while more than MISS_SHARE of a window's frames missed their vblank, up after
//   UP_AFTER seconds without a miss. Every step down bars the scale it left from a step back up
//   for FRAME_BAR seconds, doubling each time it is left again soon after (up to FRAME_BAR_MAX),
//   so a load that misses just above a scale settles below it instead of flipping.
// - Until its first decision (`settling`) it waits for SETTLE_FRAMES frames and then takes
//   the largest scale their median predicts fits, up or down, with room for the first frames
//   running lighter than the scene will (SETTLE_LIGHT); the page keeps its loading screen up over
//   that first jump.
// The page renders at the tier's nominal scale whenever the scale is pinned (`?dpr`, the GUI's
// full resolution) or the scene is paused, so paused frames and captures render at the reference
// scale whatever scale the running page had reached.

// The quantile of the frames' GPU times it steers (QUANTILE), and the time (ms) left in the paced
// interval for the main thread's share of the frame and the compositor: past the interval less
// DOWN_HEADROOM it steps down, and it steps to scales predicted to land under the interval less
// TARGET_HEADROOM (14.9 and 14.3 ms at 60 fps, 23.2 and 22.6 ms at 40 fps).
const QUANTILE = 0.9, DOWN_HEADROOM = 1.8, TARGET_HEADROOM = 2.4;
// seconds between steps down, after a change before frames at the new scale count, the seconds a
// step down reads and the least frames a decision takes
const HOLD = 1.5, SETTLE = 0.4, DOWN_SPAN = 2, MIN_FRAMES = 45;
// the least a step down must save (ms); less, and the view is bound by its fixed work
const MIN_SAVING = 0.5;
// a step up: seconds after any change, its two windows (s) and the short one's extra headroom (ms)
const UP_HOLD = 3, UP_LONG = 6, UP_SHORT = 2, UP_MARGIN = 0.3;
// seconds between evaluations of a step up
const UP_EVERY = 0.25;
// frames that take the whole interval: the median of the last EMERGENCY_FRAMES does
const EMERGENCY_HOLD = 0.5, EMERGENCY_FRAMES = 12;
// a step down within PROBE seconds of a step up bars the scale it left, and those above, for BAR s
const PROBE = 8, BAR = 30;
// the render-sized passes' time before a change is the median of its last PROBE_SPAN seconds at the
// old scale (the frames that called for it, not those of a lighter view before them)
const PROBE_SPAN = 0.5;
// the render-sized passes' share that does not follow the pixel count: its first estimate, the
// range it is kept in, the measurements it is the median of and the least change of the squared
// scale a measurement takes (a smaller step drowns in the frames' noise)
const NON_SCALING = 0.45, SHARE_MIN = 0, SHARE_MAX = 0.85, SHARE_KEEP = 7, SHARE_SPAN = 0.12;
// settling: the frames it reads, the usual lead of the quantile over their median (ms) and
// how much lighter the first frames run than the scene will (until the key light's first shadow step
// its receivers read one shadow map, not two: about 7 % of a frame)
const SETTLE_FRAMES = 45, SETTLE_SPREAD = 0.4, SETTLE_LIGHT = 0.07;
// samples kept (s)
const KEEP = Math.max( UP_LONG, DOWN_SPAN ) + 0.5;
// frame-interval fallback: a frame over 1.5 refresh periods missed its vblank; steps down when
// more than MISS_SHARE of a window missed, up after UP_AFTER seconds without a miss
const MISS_SHARE = 0.02, UP_AFTER = 6, INTERVALS = 150;
// frame-interval fallback: seconds a scale it stepped down from is barred from a step back up,
// doubled each time it is left again within FRAME_BAR_MAX seconds of the last bar's end
const FRAME_BAR = 8, FRAME_BAR_MAX = 64;

export interface DynamicResolutionOptions {
	max: number; // the largest scale (the tier's nominal: the display's ratio, up to its cap)
	floor: number;
	step: number;
}

/** One frame's GPU time (ms) and how it was drawn. */
export interface FrameSampleOptions {
	/** the part of `ms` in passes whose targets are sized from the render (NaN: not known; the
	 * whole frame is then taken as render-sized) */
	pixel?: number;
	/** when it arrived (s of `performance.now`) */
	now?: number;
}

interface Sample {
	t: number;
	scale: number;
	total: number;
	// the part in fixed passes and in render-sized ones
	fixed: number;
	pixel: number;
}

/** A change of scale (seconds of `performance.now`), the rule that made it and, for the GPU's rules,
 * the 90th percentile predicted at the new scale and (once its frames are in) the one measured. */
export interface ScaleChange { at: number; scale: number; why: string; from?: number; predicted?: number; measured?: number }

// A change whose frames at the new scale are still to come, and the median of the render-sized
// passes' time in the frames that called for it.
interface Response { change: ScaleChange; beforePixel: number }

export class DynamicResolution {

	max: number;
	floor: number;
	readonly step: number;
	// the tier's own range
	private readonly limit: number;
	private readonly limitFloor: number;
	/** The scale the scene renders at while the resolution is dynamic. */
	scale: number;
	/** Changes so far, newest last. */
	readonly changes: ScaleChange[] = [];
	/** 'gpu' once a GPU time arrived, 'frames' while it steers by frame intervals. */
	source: 'gpu' | 'frames' = 'frames';
	/** false holds the scale where it is (debug: with `force`, to time one scale). */
	enabled = true;
	/** true until its first decision from the GPU's times (the page keeps its loading screen up). */
	settling = true;
	/** The last frames' GPU busy times (ms), whatever their scale (shown in the GUI). */
	readonly observed: number[] = [];
	/** The render-sized passes' share of their time at scale 1 that does not follow the pixel count. */
	nonScaling = NON_SCALING;
	/** Whether the last step down it considered would have saved too little (a view bound by its
	 * fixed work). */
	fixedBound = false;
	/** Called once with a message when something it reads looks wrong (main.ts sets it in debug
	 * builds). */
	onWarning: ( ( message: string ) => void ) | null = null;
	private samples: Sample[] = [];
	private intervals: number[] = [];
	private lastChange = - Infinity;
	private lastMiss = - Infinity;
	// the paced frame interval (ms)
	private interval = 1000 / 60;
	// a step up's bar: scales at or above `scale` are not tried before `until`
	private bar = { scale: Infinity, until: - Infinity };
	private lastWhy = '';
	private response: Response | null = null;
	// measurements of the non-scaling share (the prior counts once)
	private readonly shares: number[] = [ NON_SCALING ];
	private nextUp = - Infinity;
	// the frame-interval fallback's bars: a scale it stepped down from, until when it is barred and
	// for how long it was
	private readonly frameBars = new Map<number, { until: number; seconds: number }>();
	private warned = false;

	constructor( { max, floor, step }: DynamicResolutionOptions ) {

		if ( ! ( floor > 0 && floor <= max && step > 0 ) ) throw new RangeError( 'Dynamic resolution needs 0 < floor <= max and a positive step' );
		this.max = this.limit = max;
		this.floor = this.limitFloor = floor;
		this.step = step;
		this.scale = max;

	}

	/** The display's nominal scale, when it changes (a window moved to another display): the range
	 * tops out there and the floor never rises above it. */
	setMax( nominal: number ): void {

		const max = Math.min( nominal, this.limit );
		if ( max === this.max ) return;
		this.max = max;
		this.floor = Math.min( this.limitFloor, max );
		this.change( Math.min( this.scale, max ), performance.now() / 1000, 'max' );

	}

	/** The interval (ms) the frames are paced to (FramePacer.ts); the GPU's budget follows it. */
	setFrameInterval( ms: number ): void {

		if ( Number.isFinite( ms ) && ms > 0 ) this.interval = Math.min( Math.max( ms, 4 ), 67 );

	}

	/** The scales it can take, from the maximum down to the floor. */
	get steps(): number[] {

		const list: number[] = [];
		for ( let s = this.max; s > this.floor - 1e-6; s = this.round( s - this.step ) ) list.push( s );
		if ( list[ list.length - 1 ] > this.floor + 1e-6 ) list.push( this.floor );
		return list;

	}

	/** One frame's GPU busy time (ms), rendered at `scale` (NaN: a frame that does not steer it, while
	 * paused or pinned). */
	sample( ms: number, scale: number, { pixel = NaN, now = performance.now() / 1000 }: FrameSampleOptions = {} ): void {

		if ( ! Number.isFinite( ms ) || ms <= 0 ) return;
		this.source = 'gpu';
		this.observed.push( ms );
		if ( this.observed.length > 120 ) this.observed.shift();
		if ( ! ( scale > 0 ) ) return;
		// the first frames at a new scale use its targets for the first time
		if ( scale === this.scale && now - this.lastChange < SETTLE ) return;
		// A split that finds no render-sized pass at all (the scene pass always is one) means the
		// targets no longer match the render's size: every scale would then predict the same cost,
		// and no step down would ever save. The frame counts as wholly render-sized instead.
		if ( pixel <= 0 ) {

			pixel = NaN;
			if ( ! this.warned ) {

				this.warned = true;
				this.onWarning?.( 'Dynamic resolution: no pass of a frame renders into a target sized from the render (PassScaling); its whole GPU time is taken to follow the pixel count' );

			}

		}
		const p = Number.isFinite( pixel ) ? Math.min( pixel, ms ) : ms;
		this.samples.push( { t: now, scale, total: ms, fixed: ms - p, pixel: p } );
		while ( this.samples.length && now - this.samples[ 0 ].t > KEEP ) this.samples.shift();

	}

	/** One frame interval (ms), for a browser without timestamp queries. */
	sampleInterval( ms: number, now = performance.now() / 1000 ): void {

		if ( this.source === 'gpu' || ! Number.isFinite( ms ) || ms <= 0 || ms > 250 ) return;
		if ( now - this.lastChange < SETTLE ) return;
		this.intervals.push( ms );
		if ( this.intervals.length > INTERVALS ) this.intervals.shift();

	}

	/** Moves the scale when its window says so. Returns whether it changed. */
	update( now = performance.now() / 1000 ): boolean {

		if ( ! this.enabled ) return false;
		return this.source === 'gpu' ? this.steerByGpu( now ) : this.steerByIntervals( now );

	}

	/** The frame loop starts (or restarts after a stop): its first frames (first-use work, whole
	 * bakes) do not count, and it settles again from the next frames. */
	begin( now = performance.now() / 1000 ): void {

		this.lastChange = now;
		this.samples.length = 0;
		this.intervals.length = 0;
		this.response = null;
		this.settling = true;

	}

	/** Sets the scale (a debug override, or a seek to a known settle point). */
	force( scale: number, now = performance.now() / 1000 ): void {

		this.change( Math.min( Math.max( this.round( scale ), this.floor ), this.max ), now, 'force' );

	}

	private steerByGpu( now: number ): boolean {

		this.measureResponse();
		const since = now - this.lastChange;
		const target = this.interval - TARGET_HEADROOM;
		// the frames drawn at the scale since it was set
		const current = this.samples.filter( ( x ) => x.scale === this.scale && x.t - this.lastChange >= SETTLE );
		if ( this.settling ) {

			const frames = current;
			if ( frames.length < SETTLE_FRAMES ) return false;
			this.settling = false;
			const s = this.largestFitting( frames, ( target - SETTLE_SPREAD ) / ( 1 + SETTLE_LIGHT ), 0.5, this.floor );
			if ( s < this.scale ) return this.down( s, now, 'settle', frames );
			return this.to( s, now, 'settle', frames );

		}
		// frames that take the whole interval: no waiting for the window
		const last = current.slice( - EMERGENCY_FRAMES );
		if ( this.scale > this.floor && since >= EMERGENCY_HOLD && last.length === EMERGENCY_FRAMES && quantile( last.map( ( x ) => x.total ), 0.5 ) > this.interval ) {

			const s = this.largestFitting( last, target, 0.5, this.floor, this.scale );
			if ( s < this.scale && this.down( s, now, 'emergency', current ) ) return true;

		}
		if ( since < HOLD ) return false;
		const recent = current.filter( ( x ) => now - x.t <= DOWN_SPAN );
		if ( recent.length >= MIN_FRAMES ) {

			const high = this.predict( recent, this.scale, QUANTILE );
			if ( high > this.interval - DOWN_HEADROOM ) {

				if ( this.scale <= this.floor ) return false;
				const s = this.largestFitting( recent, target, QUANTILE, this.floor, this.scale );
				// a step that saves too little: the view is bound by its fixed work
				this.fixedBound = high - this.predict( recent, s, QUANTILE ) < MIN_SAVING;
				return this.fixedBound ? false : this.down( s, now, 'down', recent );

			}
			this.fixedBound = false;

		}
		// (a few times a second: it reads every frame of the last seconds at a few scales)
		if ( since >= UP_HOLD && this.scale < this.max && now >= this.nextUp ) {

			this.nextUp = now + UP_EVERY;
			const long = this.samples.filter( ( x ) => now - x.t <= UP_LONG );
			const short = long.filter( ( x ) => now - x.t <= UP_SHORT );
			if ( short.length >= MIN_FRAMES ) {

				const ceiling = now < this.bar.until ? this.bar.scale : Infinity;
				const a = this.largestFitting( long, target, QUANTILE, this.scale, ceiling );
				const b = this.largestFitting( short, target - UP_MARGIN, QUANTILE, this.scale, ceiling );
				// Up to the short window's level once the long one allows at least as much (waiting for
				// the two to be equal would never step up where the margin keeps them a level apart);
				// while the long one allows less, the view has just turned lighter: wait, then step once.
				if ( b > this.scale && a >= b ) return this.to( b, now, 'up', short );

			}

		}
		return false;

	}

	// The render-sized passes' time at `scale` relative to scale 1.
	private growth( scale: number ): number {

		return this.nonScaling + ( 1 - this.nonScaling ) * scale * scale;

	}

	// The GPU time (ms) the `q` quantile of `frames` is predicted to take at `scale`.
	private predict( frames: readonly Sample[], scale: number, q: number ): number {

		const g = this.growth( scale );
		return quantile( frames.map( ( x ) => x.fixed + x.pixel * g / this.growth( x.scale ) ), q );

	}

	// The largest scale between `lowest` and below `ceiling` (the maximum without one) whose
	// predicted `q` quantile lands under `limit`; `lowest` if none does (the cost rises with the
	// scale, so a bisection over the levels finds it).
	private largestFitting( frames: readonly Sample[], limit: number, q: number, lowest: number, ceiling = Infinity ): number {

		const levels = this.steps.filter( ( s ) => s >= lowest - 1e-6 && s < ceiling - 1e-6 );
		if ( levels.length === 0 ) return lowest;
		// levels run from the largest down: find the first that fits
		let lo = 0, hi = levels.length;
		while ( lo < hi ) {

			const mid = ( lo + hi ) >> 1;
			if ( this.predict( frames, levels[ mid ], q ) <= limit ) hi = mid;
			else lo = mid + 1;

		}
		return lo < levels.length ? levels[ lo ] : Math.max( lowest, levels[ levels.length - 1 ] );

	}

	// Steps down to `scale` (`frames`: the frames at the scale it leaves that called for it).
	private down( scale: number, now: number, why: string, frames: readonly Sample[] ): boolean {

		// a step up it has to take back at once: bar it, and every scale above, for a while
		if ( this.lastWhy === 'up' && now - this.lastChange < PROBE ) this.bar = { scale: this.scale, until: now + BAR };
		return this.to( scale, now, why, frames );

	}

	// The frames that called for a change (its last PROBE_SPAN seconds at the scale it leaves, not
	// those of a lighter view before them) and their medians.
	private before( frames: readonly Sample[], now: number ): { beforePixel: number } | null {

		const last = frames.filter( ( x ) => now - x.t <= PROBE_SPAN );
		const list = last.length >= EMERGENCY_FRAMES ? last : frames.slice( - EMERGENCY_FRAMES );
		if ( list.length < EMERGENCY_FRAMES ) return null;
		return { beforePixel: quantile( list.map( ( x ) => x.pixel ), 0.5 ) };

	}

	// Changes to `scale` by one of the GPU's rules, and arms the measurement of its response.
	private to( scale: number, now: number, why: string, frames: readonly Sample[] ): boolean {

		const response = this.before( frames, now );
		const changed = this.change( scale, now, why, frames.length ? this.predict( frames, scale, QUANTILE ) : NaN );
		if ( changed && response ) this.response = { change: this.changes[ this.changes.length - 1 ], beforePixel: response.beforePixel };
		return changed;

	}

	// Once frames at the scale a change went to are in: the quantile it reached and what the
	// render-sized passes' time did (the non-scaling share).
	private measureResponse(): void {

		const response = this.response;
		if ( ! response ) return;
		const change = response.change;
		const frames = this.samples.filter( ( x ) => x.scale === change.scale && x.t - change.at >= SETTLE );
		if ( frames.length < MIN_FRAMES ) return;
		this.response = null;
		change.measured = quantile( frames.map( ( x ) => x.total ), QUANTILE );
		this.learnShare( change.from!, change.scale, response.beforePixel, quantile( frames.map( ( x ) => x.pixel ), 0.5 ) );

	}

	// One measurement of the non-scaling share from the render-sized passes' medians before (at
	// `from`) and after (at `to`) a change: after / before = g( to ) / g( from ).
	private learnShare( from: number, to: number, before: number, after: number ): void {

		const f = from * from, t = to * to;
		if ( Math.abs( f - t ) < SHARE_SPAN || ! ( before > 0 ) || ! ( after > 0 ) ) return;
		const r = after / before;
		const d = r * ( 1 - f ) - ( 1 - t );
		if ( Math.abs( d ) < 1e-3 ) return;
		const k = ( t - r * f ) / d;
		// far outside the range: the view changed under the step
		if ( ! ( k > SHARE_MIN - 0.3 && k < 1.2 ) ) return;
		this.shares.push( Math.min( Math.max( k, SHARE_MIN ), SHARE_MAX ) );
		if ( this.shares.length > SHARE_KEEP ) this.shares.shift();
		this.nonScaling = quantile( this.shares, 0.5 );

	}

	private steerByIntervals( now: number ): boolean {

		const v = this.intervals;
		if ( v.length < MIN_FRAMES ) return false;
		const period = quantile( v, 0.1 );
		const missed = v.filter( ( x ) => x > period * 1.5 ).length;
		if ( missed > 0 ) this.lastMiss = Math.max( this.lastMiss, now );
		const since = now - this.lastChange;
		if ( since >= HOLD && missed > v.length * MISS_SHARE && this.scale > this.floor ) {

			// the scale it leaves missed: keep away from it for a while, longer each time
			const bar = this.frameBars.get( this.scale );
			const seconds = bar && now - bar.until < FRAME_BAR_MAX ? Math.min( bar.seconds * 2, FRAME_BAR_MAX ) : FRAME_BAR;
			this.frameBars.set( this.scale, { until: now + seconds, seconds } );
			return this.change( this.round( Math.max( this.scale - this.step, this.floor ) ), now, 'frames' );

		}
		if ( since >= UP_AFTER && now - this.lastMiss >= UP_AFTER && this.scale < this.max ) {

			const up = this.round( Math.min( this.scale + this.step, this.max ) );
			const bar = this.frameBars.get( up );
			if ( ! ( bar && now < bar.until ) ) return this.change( up, now, 'frames up' );

		}
		return false;

	}

	private change( scale: number, now: number, why: string, predicted = NaN ): boolean {

		const from = this.scale;
		const changed = scale !== from;
		if ( changed ) {

			const entry: ScaleChange = { at: now, scale, why, from };
			if ( Number.isFinite( predicted ) ) entry.predicted = predicted;
			this.changes.push( entry );
			if ( this.changes.length > 200 ) this.changes.shift();
			this.response = null;

		}
		this.lastWhy = why;
		this.scale = scale;
		this.lastChange = now;
		this.intervals.length = 0;
		return changed;

	}

	private round( x: number ): number {

		return Math.round( x * 1000 ) / 1000;

	}

}

function quantile( values: readonly number[], q: number ): number {

	const s = [ ...values ].sort( ( a, b ) => a - b );
	const i = ( s.length - 1 ) * q, lo = Math.floor( i ), hi = Math.ceil( i );
	return s[ lo ] + ( s[ hi ] - s[ lo ] ) * ( i - lo );

}

// ------------------------------------------------------------------ which passes follow the pixels

/** Sorts the renderer's passes, as they begin, into those whose target follows the render's pixel
 * count (sized from it, at the render's size or a power-of-two fraction: the scene, its resolves and
 * copies, the post chain, bloom's mips) and the rest (the canvas, canvas-sized upscale, shadow maps,
 * the FFT's and the sky's fixed targets, every compute pass: the cloud view's dispatch follows the
 * display). Reads three's inspector hooks, wrapping whichever inspector the renderer has. */
export class PassScaling {

	private readonly pixel = new Map<string, boolean>();
	private width = 0;
	private height = 0;

	private constructor( renderer: THREE.WebGPURenderer ) {

		type Hooks = { beginRender( uid: string, scene: unknown, camera: unknown, target: { width: number; height: number } | null ): void; beginCompute( uid: string, nodes: unknown ): void };
		const inspector = renderer.inspector as unknown as Hooks;
		const beginRender = inspector.beginRender.bind( inspector ), beginCompute = inspector.beginCompute.bind( inspector );
		inspector.beginRender = ( uid, scene, camera, target ) => {

			this.note( uid, target !== null && this.follows( target.width, target.height ) );
			beginRender( uid, scene, camera, target );

		};
		inspector.beginCompute = ( uid, nodes ) => {

			this.note( uid, false );
			beginCompute( uid, nodes );

		};

	}

	static install( renderer: THREE.WebGPURenderer ): PassScaling {

		return new PassScaling( renderer );

	}

	/** The render's size in pixels (call whenever it changes). */
	setSize( width: number, height: number ): void {

		this.width = width;
		this.height = height;

	}

	/** Whether the pass with timestamp uid `uid` followed the pixel count (and forgets it). */
	take( uid: string ): boolean {

		const pixel = this.pixel.get( uid ) ?? false;
		this.pixel.delete( uid );
		return pixel;

	}

	private note( uid: string, pixel: boolean ): void {

		this.pixel.set( uid, pixel );
		// uids whose timestamps never arrive (lost read-backs) must not pile up
		if ( this.pixel.size > 4096 ) this.pixel.delete( this.pixel.keys().next().value! );

	}

	// at the render's size or a fraction 1 / 2^k of it (floored or rounded), in both axes alike
	private follows( w: number, h: number ): boolean {

		for ( let k = 0, d = 1; k <= 6; k ++, d *= 2 ) {

			if ( Math.abs( w - this.width / d ) <= 1.01 && Math.abs( h - this.height / d ) <= 1.01 ) return true;

		}
		return false;

	}

}

// ------------------------------------------------------------------ GPU frame time

// The few WebGPU types used here (the project builds without @webgpu/types).
type GPUBuffer = { size: number; mapAsync( mode: number, offset: number, size: number ): Promise<void>; getMappedRange( offset: number, size: number ): ArrayBuffer; unmap(): void };
type GPUQuerySet = object;
type GPUDevice = {
	createBuffer( descriptor: { label: string; size: number; usage: number } ): GPUBuffer;
	createCommandEncoder( descriptor: { label: string } ): {
		resolveQuerySet( set: GPUQuerySet, first: number, count: number, destination: GPUBuffer, offset: number ): void;
		copyBufferToBuffer( source: GPUBuffer, sourceOffset: number, destination: GPUBuffer, destinationOffset: number, size: number ): void;
		finish(): object;
	};
	queue: { submit( buffers: object[] ): void };
};
type Pool = {
	querySet: GPUQuerySet; resolveBuffer: GPUBuffer; queryOffsets: Map<string, number>;
	currentQueryIndex: number; maxQueries: number; resolveQueriesAsync: () => Promise<number>;
};
type Backend = { device: GPUDevice; trackTimestamp: boolean; timestampQueryPool: Record<string, Pool | null> };

// The frame (three's `info.frame`) a timestamp uid belongs to (`<prefix>:<id>:f<frame>`).
function frameOf( uid: string ): number {

	return Number( uid.slice( uid.lastIndexOf( ':f' ) + 2 ) );

}

// GPUBufferUsage.MAP_READ | COPY_DST, GPUMapMode.READ
const READBACK_USAGE = 0x0001 | 0x0008, MAP_READ = 0x0001;
const RING = 8;

/** The GPU's busy time per frame from three's timestamp queries (`trackTimestamp`), read back
 * through a small ring of buffers (three's pool maps a single one and drops the frames it
 * resolves while that one is mapped), and the part of it in passes that follow the render's pixel
 * count (`PassScaling`). Call `resolve()` once per frame, after its passes. */
export class GpuFrameTimer {

	/** Called with each frame's id (three's `info.frame`), its GPU busy time in ms and the part of it
	 * in passes that follow the pixel count. */
	onFrame: ( ( frame: number, ms: number, pixel: number ) => void ) | null = null;
	private readonly backend: Backend;
	private readonly passes: PassScaling;
	private readonly buffers: { buffer: GPUBuffer; busy: boolean }[] = [];
	private readonly frames = new Map<number, [ number, number, boolean ][]>();
	private origin: bigint | null = null;
	private lastEnd = - Infinity;
	private newest = - 1;
	// the newest frame reported, and frames some of whose passes went unread
	private reported = - 1;
	private readonly lost = new Set<number>();

	private constructor( backend: Backend, passes: PassScaling ) {

		this.backend = backend;
		this.passes = passes;

	}

	/** A timer, or null where the device has no timestamp queries (or the renderer does not track them). */
	static create( renderer: THREE.WebGPURenderer, passes: PassScaling ): GpuFrameTimer | null {

		const backend = renderer.backend as unknown as Backend;
		return backend.trackTimestamp ? new GpuFrameTimer( backend, passes ) : null;

	}

	resolve(): void {

		const pools: Pool[] = [];
		for ( const pool of Object.values( this.backend.timestampQueryPool ) ) {

			if ( ! pool ) continue;
			// three resolves a pool on its own only when it overflows: route that through here too
			const hooked = pool as Pool & { frameTimer?: boolean };
			if ( ! hooked.frameTimer ) {

				hooked.frameTimer = true;
				pool.resolveQueriesAsync = () => { this.resolvePool( pool ); return Promise.resolve( 0 ); };

			}
			if ( pool.currentQueryIndex > 0 ) pools.push( pool );

		}
		// The render and compute pools are read together or not at all: a frame read from one of them
		// alone (its compute passes, the cloud view among them, left out) would pass for a light one.
		const free = this.buffers.filter( ( b ) => ! b.busy ).length + RING - this.buffers.length;
		for ( const pool of pools ) this.resolvePool( pool, free < pools.length );

	}

	private resolvePool( pool: Pool, drop = false ): void {

		const count = pool.currentQueryIndex;
		if ( count === 0 ) return;
		const offsets = [ ...pool.queryOffsets ].map( ( [ uid, base ] ) => [ uid, base, this.passes.take( uid ) ] as const );
		pool.currentQueryIndex = 0;
		pool.queryOffsets.clear();
		const device = this.backend.device;
		let slot = drop ? undefined : this.buffers.find( ( b ) => ! b.busy && b.buffer.size >= pool.maxQueries * 8 );
		if ( ! slot && ! drop && this.buffers.length < RING ) {

			slot = { buffer: device.createBuffer( { label: 'frameTimer.timestamps', size: pool.maxQueries * 8, usage: READBACK_USAGE } ), busy: false };
			this.buffers.push( slot );

		}
		if ( ! slot ) {

			// every read-back buffer is in flight: these frames go unmeasured, with any of their passes
			// read in another batch
			for ( const [ uid ] of offsets ) this.lost.add( frameOf( uid ) );
			return;

		}
		const target = slot;
		target.busy = true;
		const bytes = count * 8;
		const encoder = device.createCommandEncoder( { label: 'frameTimer.resolve' } );
		encoder.resolveQuerySet( pool.querySet, 0, count, pool.resolveBuffer, 0 );
		encoder.copyBufferToBuffer( pool.resolveBuffer, 0, target.buffer, 0, bytes );
		device.queue.submit( [ encoder.finish() ] );
		target.buffer.mapAsync( MAP_READ, 0, bytes ).then( () => {

			const times = new BigUint64Array( target.buffer.getMappedRange( 0, bytes ).slice( 0 ) );
			target.buffer.unmap();
			target.busy = false;
			for ( const [ uid, base, pixel ] of offsets ) {

				const start = times[ base ], end = times[ base + 1 ];
				if ( start === 0n || end < start ) continue;
				const frame = frameOf( uid );
				// (a pass of a frame already reported arrived late: that frame is gone)
				if ( ! Number.isFinite( frame ) || frame <= this.reported ) continue;
				if ( this.origin === null ) this.origin = start;
				const list = this.frames.get( frame ) ?? [];
				list.push( [ Number( start - this.origin ) / 1e6, Number( end - this.origin ) / 1e6, pixel ] );
				this.frames.set( frame, list );
				this.newest = Math.max( this.newest, frame );

			}
			this.settle();

		}, () => { target.busy = false; } );

	}

	// A frame is complete once passes of two later frames arrived (work issued after a tick, such as
	// a sky bake resuming after a read-back, carries the frame id of the tick before it).
	private settle(): void {

		const ready = [ ...this.frames.keys() ].filter( ( f ) => f < this.newest - 1 ).sort( ( a, b ) => a - b );
		for ( const frame of ready ) {

			const passes = this.frames.get( frame )!.sort( ( a, b ) => a[ 1 ] - b[ 1 ] );
			this.frames.delete( frame );
			this.reported = Math.max( this.reported, frame );
			let cursor = this.lastEnd, busy = 0, pixel = 0;
			for ( const [ start, end, follows ] of passes ) {

				const ms = Math.max( end - Math.max( start, cursor ), 0 );
				busy += ms;
				if ( follows ) pixel += ms;
				cursor = Math.max( cursor, end );

			}
			this.lastEnd = cursor;
			if ( ! this.lost.delete( frame ) ) this.onFrame?.( frame, busy, pixel );

		}
		// frames lost whole never come up here
		for ( const frame of this.lost ) if ( frame < this.newest - 64 ) this.lost.delete( frame );

	}

}
