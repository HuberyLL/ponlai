import type * as THREE from 'three/webgpu';

// Dynamic resolution (high tier): the scene's render scale moves between the tier's maximum and a
// floor so that the GPU's frame time stays inside the paced frame (a 60 Hz frame, `FramePacer.ts`),
// changing as seldom as it can: every change softens or sharpens the whole image at once.
//
// - The GPU time comes from timestamp queries (`GpuFrameTimer`, or the frame profiler's own when it
//   runs), as the time the GPU was busy with each frame: every pass charged from the previous
//   pass's completion (or its own start, if later) to its end. A tile-based GPU stamps a pass's
//   start when its vertex stage begins, long before the passes it reads have finished, so the raw
//   intervals overlap; summed they come to several times the frame. Without timestamp queries the
//   frame intervals steer it instead (`sampleInterval`): missed vblanks step it down, and a long
//   run without one steps it up, backing off each time a step up costs frames.
// - It steers a high quantile of the frames' GPU times (the 90th percentile) by what the display
//   shows. On a 120 Hz display at 60 fps the share of frames presented a refresh late stayed at its
//   floor (1-2 %, as many with frames of 10 ms as of 14 ms) until that quantile passed about 14.5 ms,
//   then rose steeply (4 % at 15.1 - 15.4 ms, 13 % at 16.3 ms, 31 % at 17.5 ms). The 97th percentile
//   it steered before sat on periodic work that hardly follows the pixel count (sky bakes, map
//   redraws): just over its budget, it stepped the scale down again and again while most frames
//   had room. The GPU's clock held its top step at every scale while the frames were paced (its
//   performance states, read through IOReport), so the time follows the scale; another page or app
//   drawing at the same time lengthens it, and then the scale goes down as it should.
// - Down: when the quantile of the last DOWN_FRAMES frames passes the paced interval less
//   DOWN_HEADROOM (at most every HOLD seconds; after EMERGENCY_HOLD when the last frames take the
//   whole interval, or when more than SPIKE_SHARE of the window does), straight to the scale a cost
//   model predicts lands under the interval less TARGET_HEADROOM: a fixed part (FIXED ms) plus a part
//   that follows the pixel count, in one change.
// - Up: after UP_HOLD seconds at the scale with UP_SAMPLES frames in, by at most UP_STEPS steps,
//   whenever the same model predicts the window's quantile at the larger render lands under that
//   target. A scale it had to leave is barred for a while (BAR seconds, doubled each time, up to
//   BAR_MAX): a step back up to it needs BAR_MARGIN ms more, and one it stepped up to and had to
//   leave again at once is not tried until its bar runs out, so it does not oscillate. Bars expire
//   and the model follows the load, so once a heavier view or another page's load is gone the scale
//   climbs back: it never drifts only down.
// - Until its first decision (`settling`) it decides as soon as a few frames are in, so the page can
//   keep its loading screen up over the first jump from the maximum.
// The page renders at the tier's nominal scale whenever the scale is pinned (`?dpr`, the GUI's
// full resolution) or the scene is paused, so paused frames and captures render at the reference
// scale whatever scale the running page had reached.

// The quantile of the window's GPU times it steers (QUANTILE), and the time (ms) left in the paced
// interval for the main thread's share of the frame and the compositor: past the interval less
// DOWN_HEADROOM it steps down, and it steps to scales predicted to land under the interval less
// TARGET_HEADROOM (14.9 and 14.3 ms at 60 fps, 23.2 and 22.6 ms at 40 fps). Held there, the frames
// in a player's window on a 120 Hz display were presented late about as often as at lower scales
// (2.5 % at 1.05, 2.2 % at 1.0); 0.6 ms higher it settled at 1.1 with a quarter more late frames.
// A high quantile, not the median, so a noisy load (another page drawing, a view whose cost changes
// from frame to frame) keeps a margin; not the 97th percentile, which sat on the periodic bake
// frames (one in thirty at high's sky cadence).
const QUANTILE = 0.9, DOWN_HEADROOM = 1.8, TARGET_HEADROOM = 2.4;
// The part of a frame's GPU time (ms) that does not follow the render's pixel count (shadow maps,
// FFT, sky bakes, the cloud view sized from the display, canvas-sized upscale and output), at most
// FIXED_SHARE of the frame. Fitted to fixed scales on a 120 Hz display: 7.3 ms full screen and
// 6.4 ms in a window of four fifths its height, beside 14.2 and 12.9 ms frames at scale 1.
const FIXED = 6.8, FIXED_SHARE = 0.7;
// seconds between steps down, after a change before its frames count, the least frames a decision
// takes, the frames the down quantile spans and the most in its window (about 2.5 s at 60 Hz)
const HOLD = 1.5, SETTLE = 0.4, MIN_SAMPLES = 45, DOWN_FRAMES = 90, WINDOW = 150;
// a step up: seconds after any change, the frames its window needs, and the most steps at once
const UP_HOLD = 4, UP_SAMPLES = 120, UP_STEPS = 2;
// frames a decision takes while settling (after SETTLE seconds at the scale)
const SETTLING_FRAMES = 20, SETTLING_SPREAD = 0.4;
// frames that take the whole interval: the median of the last EMERGENCY_FRAMES does, or more than
// SPIKE_SHARE of the window does (a few periodic bakes stay under it)
const EMERGENCY_HOLD = 0.5, EMERGENCY_FRAMES = 12, SPIKE_SHARE = 0.1;
// seconds a scale it stepped down from stays barred, doubling each time it is barred again; while
// barred, a step back up to it needs BAR_MARGIN ms more headroom. A step up it had to take back
// within PROBE seconds bars that scale outright (and every scale above it) for its time: under a
// noisy load (another page drawing) the estimate kept promising the next step, and the scale went
// up and down every few seconds.
const BAR = 8, BAR_MAX = 64, BAR_MARGIN = 0.5, PROBE = 6;
// frame-interval fallback: a frame over 1.5 refresh periods missed its vblank; steps down when
// more than MISS_SHARE of a window missed, up after UP_AFTER seconds without a miss
const MISS_SHARE = 0.02, UP_AFTER = 6;

export interface DynamicResolutionOptions {
	max: number; // the largest scale (the tier's nominal: the display's ratio, up to its cap)
	floor: number;
	step: number;
}

export class DynamicResolution {

	max: number;
	floor: number;
	readonly step: number;
	// the tier's own range
	private readonly limit: number;
	private readonly limitFloor: number;
	/** The scale the scene renders at while the resolution is dynamic. */
	scale: number;
	/** Changes so far, newest last (seconds of `performance.now`, the new scale and the rule that
	 * made it). */
	readonly changes: { at: number; scale: number; why: string }[] = [];
	/** 'gpu' once a GPU time arrived, 'frames' while it steers by frame intervals. */
	source: 'gpu' | 'frames' = 'frames';
	/** false holds the scale where it is (debug: with `force`, to time one scale). */
	enabled = true;
	/** true until its first decision from the GPU's times (the page keeps its loading screen up). */
	settling = true;
	/** The last frames' GPU busy times (ms), whatever their scale (shown in the GUI). */
	readonly observed: number[] = [];
	private samples: number[] = [];
	private intervals: number[] = [];
	private lastChange = - Infinity;
	private lastMiss = - Infinity;
	// the paced frame interval (ms)
	private interval = 1000 / 60;
	private readonly bars = new Map<number, { until: number; seconds: number; hard: boolean }>();
	private lastWhy = '';

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
	sample( ms: number, scale: number, now = performance.now() / 1000 ): void {

		if ( ! Number.isFinite( ms ) || ms <= 0 ) return;
		this.source = 'gpu';
		this.observed.push( ms );
		if ( this.observed.length > 120 ) this.observed.shift();
		// frames of the previous scale (their timestamps arrive a few frames late) and the first
		// frames after a change (new targets' first use) are left out
		if ( scale !== this.scale || now - this.lastChange < SETTLE ) return;
		this.samples.push( ms );
		if ( this.samples.length > WINDOW ) this.samples.shift();

	}

	/** One frame interval (ms), for a browser without timestamp queries. */
	sampleInterval( ms: number, now = performance.now() / 1000 ): void {

		if ( this.source === 'gpu' || ! Number.isFinite( ms ) || ms <= 0 || ms > 250 ) return;
		if ( now - this.lastChange < SETTLE ) return;
		this.intervals.push( ms );
		if ( this.intervals.length > WINDOW ) this.intervals.shift();

	}

	/** Moves the scale when its window says so. Returns whether it changed. */
	update( now = performance.now() / 1000 ): boolean {

		if ( ! this.enabled ) return false;
		return this.source === 'gpu' ? this.steerByGpu( now ) : this.steerByIntervals( now );

	}

	/** The frame loop starts (or restarts after a stop): its first frames (first-use work, whole
	 * bakes) do not count, and the next decision comes as soon as a few frames are in. */
	begin( now = performance.now() / 1000 ): void {

		this.lastChange = now;
		this.samples.length = 0;
		this.intervals.length = 0;
		this.settling = true;

	}

	/** Sets the scale (a debug override, or a seek to a known settle point); clears the window. */
	force( scale: number, now = performance.now() / 1000 ): void {

		this.change( Math.min( Math.max( this.round( scale ), this.floor ), this.max ), now, 'force' );

	}

	private steerByGpu( now: number ): boolean {

		const s = this.samples;
		const since = now - this.lastChange;
		const over = this.interval - DOWN_HEADROOM, target = this.interval - TARGET_HEADROOM;
		// settling, it decides as soon as a few frames are in, until a window fits
		if ( this.settling ) {

			if ( s.length < SETTLING_FRAMES ) return false;
			// the median and the quantile's usual lead over it in a steady view: the first frames after
			// a load carry one-off work (whole bakes, first draws)
			const typical = quantile( s, 0.5 ) + SETTLING_SPREAD;
			if ( typical > over && this.scale > this.floor ) return this.down( now, typical, 'settle' );
			this.settling = false;
			return false;

		}
		if ( this.scale > this.floor && since >= EMERGENCY_HOLD && s.length >= EMERGENCY_FRAMES ) {

			const recent = quantile( s.slice( - EMERGENCY_FRAMES ), 0.5 );
			if ( recent > this.interval ) return this.down( now, recent, 'emergency' );

		}
		if ( since < HOLD || s.length < MIN_SAMPLES ) return false;
		const high = quantile( s.slice( - DOWN_FRAMES ), QUANTILE );
		if ( this.scale > this.floor ) {

			if ( high > over ) return this.down( now, high, 'over' );
			if ( s.filter( ( ms ) => ms > this.interval ).length > s.length * SPIKE_SHARE ) return this.down( now, Math.max( high, over ), 'spikes' );

		}
		if ( this.scale < this.max && since >= UP_HOLD && s.length >= UP_SAMPLES ) {

			// the largest of the next few scales up the model predicts lands under the target; a
			// scale it recently had to leave (or one it would jump past) needs a wider margin, and one
			// whose step up did not hold stops the climb below it
			const window = quantile( s, QUANTILE );
			let margin = 0;
			let best = 0;
			for ( let k = 1; k <= UP_STEPS; k ++ ) {

				const up = this.round( Math.min( this.scale + k * this.step, this.max ) );
				if ( up <= this.scale || up === best ) break;
				const bar = this.barred( up, now );
				if ( bar === 'hard' ) break;
				if ( bar === 'soft' ) margin = BAR_MARGIN;
				if ( this.cost( window, up ) < target - margin ) best = up;
				else break;

			}
			if ( best > this.scale ) return this.up( best, now );

		}
		return false;

	}

	// The GPU time (ms) a frame that takes `ms` at the current scale is predicted to take at `scale`.
	private cost( ms: number, scale: number ): number {

		const fixed = Math.min( FIXED, FIXED_SHARE * ms );
		return fixed + ( ms - fixed ) * ( scale * scale ) / ( this.scale * this.scale );

	}

	private steerByIntervals( now: number ): boolean {

		const v = this.intervals;
		if ( v.length < MIN_SAMPLES ) return false;
		const period = quantile( v, 0.1 );
		const missed = v.filter( ( x ) => x > period * 1.5 ).length;
		if ( missed > 0 ) this.lastMiss = Math.max( this.lastMiss, now );
		const since = now - this.lastChange;
		if ( since >= HOLD && missed > v.length * MISS_SHARE && this.scale > this.floor ) return this.down( now );
		if ( since >= UP_AFTER && now - this.lastMiss >= UP_AFTER && this.scale < this.max ) {

			const up = this.round( Math.min( this.scale + this.step, this.max ) );
			if ( this.barred( up, now ) === null ) return this.up( up, now, 'frames' );

		}
		return false;

	}

	/** Steps down, to the largest scale the model predicts frames costing `ms` now to land at under
	 * the target; one step without a cost (the frame-interval fallback). */
	private down( now: number, ms = NaN, why = 'frames' ): boolean {

		// the scale it leaves cost too much: keep away from it for a while, longer each time
		const bar = this.bars.get( this.scale );
		const seconds = bar && now - bar.until < BAR_MAX ? Math.min( bar.seconds * 2, BAR_MAX ) : BAR;
		const hard = this.lastWhy === 'up' && now - this.lastChange < PROBE;
		this.bars.set( this.scale, { until: now + seconds, seconds, hard } );
		let scale = this.round( Math.max( this.scale - this.step, this.floor ) );
		if ( ms > 0 ) {

			const target = this.interval - TARGET_HEADROOM;
			while ( scale > this.floor && this.cost( ms, scale ) > target ) scale = this.round( Math.max( scale - this.step, this.floor ) );

		}
		this.change( scale, now, why );
		return true;

	}

	private up( scale: number, now: number, why = 'up' ): boolean {

		this.change( scale, now, why );
		return true;

	}

	// Whether a step up to `scale` is barred now: 'hard' (a step up to it did not hold), 'soft' (it
	// had to leave it) or null.
	private barred( scale: number, now: number ): 'hard' | 'soft' | null {

		const bar = this.bars.get( scale );
		return bar === undefined || now >= bar.until ? null : bar.hard ? 'hard' : 'soft';

	}

	private change( scale: number, now: number, why: string ): void {

		if ( scale !== this.scale ) this.changes.push( { at: now, scale, why } );
		this.lastWhy = why;
		if ( this.changes.length > 200 ) this.changes.shift();
		this.scale = scale;
		this.lastChange = now;
		this.samples.length = 0;
		this.intervals.length = 0;

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
 * resolves while that one is mapped). Call `resolve()` once per frame, after its passes. */
export class GpuFrameTimer {

	/** Called with each frame's id (three's `info.frame`) and its GPU busy time in ms. */
	onFrame: ( ( frame: number, ms: number ) => void ) | null = null;
	private readonly backend: Backend;
	private readonly buffers: { buffer: GPUBuffer; busy: boolean }[] = [];
	private readonly frames = new Map<number, [ number, number ][]>();
	private origin: bigint | null = null;
	private lastEnd = - Infinity;
	private newest = - 1;
	// the newest frame reported, and frames some of whose passes went unread
	private reported = - 1;
	private readonly lost = new Set<number>();

	private constructor( backend: Backend ) {

		this.backend = backend;

	}

	/** A timer, or null where the device has no timestamp queries (or the renderer does not track them). */
	static create( renderer: THREE.WebGPURenderer ): GpuFrameTimer | null {

		const backend = renderer.backend as unknown as Backend;
		return backend.trackTimestamp ? new GpuFrameTimer( backend ) : null;

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
		const offsets = [ ...pool.queryOffsets ];
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
			for ( const [ uid, base ] of offsets ) {

				const start = times[ base ], end = times[ base + 1 ];
				if ( start === 0n || end < start ) continue;
				const frame = frameOf( uid );
				// (a pass of a frame already reported arrived late: that frame is gone)
				if ( ! Number.isFinite( frame ) || frame <= this.reported ) continue;
				if ( this.origin === null ) this.origin = start;
				const list = this.frames.get( frame ) ?? [];
				list.push( [ Number( start - this.origin ) / 1e6, Number( end - this.origin ) / 1e6 ] );
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
			let cursor = this.lastEnd, busy = 0;
			for ( const [ start, end ] of passes ) {

				busy += Math.max( end - Math.max( start, cursor ), 0 );
				cursor = Math.max( cursor, end );

			}
			this.lastEnd = cursor;
			if ( ! this.lost.delete( frame ) ) this.onFrame?.( frame, busy );

		}
		// frames lost whole never come up here
		for ( const frame of this.lost ) if ( frame < this.newest - 64 ) this.lost.delete( frame );

	}

}
