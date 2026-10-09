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
// - Down: when the window's high quantile of GPU time exceeds UPPER (at most every HOLD seconds, or
//   after EMERGENCY_HOLD when the last frames run far over it), straight to the scale a model of the
//   frame's cost predicts the window fits at (a fixed share plus a share that follows the pixel
//   count), in one change rather than a step at a time: a heavier view once cost three changes in
//   a row, and the first seconds after a load a dozen.
// - Up: only after UP_HOLD seconds at the scale with a full window, by at most UP_STEPS steps, when
//   the same model (with a smaller fixed share, so the growth is predicted pessimistically) keeps
//   the window under UPPER - MARGIN. A scale it had to leave stays barred for a while (BAR, doubled
//   each time): a step back up to it needs a wider margin, so it does not oscillate, yet a lighter
//   scene still climbs.
// - Until its first decision (`settling`) it decides as soon as a few frames are in, so the page can
//   keep its loading screen up over the first jump from the maximum.
// The page renders at the tier's nominal scale whenever the scale is pinned (`?dpr`, the GUI's
// full resolution) or the scene is paused, so paused frames and captures render at the reference
// scale whatever scale the running page had reached.

// GPU busy time (ms) the window's high quantile must stay under, for a 60 Hz frame (16.7 ms; the
// budgets scale with the paced interval). The slack covers the spread between frames (periodic
// bakes and map redraws land on single frames) and the compositor: on a 120 Hz display frames
// whose GPU work ran past about 14 ms were presented a refresh late now and then, and the next a
// refresh early (a tenth of the intervals changed cadence at a median of 14.3 ms, a thirtieth at
// 13.1 ms). Held under this, the median settles near 13.5 ms; a budget of 14.2 ms took 0.7 ms off
// the median without a measurable change in the presented cadence.
const UPPER = 15.2;
const MARGIN = 0.4;
// the quantile of the window's frames that steers it (its few worst frames must fit too)
const QUANTILE = 0.97;
// The part of a frame's GPU time that does not follow the render's pixels (shadow maps, FFT, sky
// bakes, canvas-sized output and upscale). A step up takes it as a share of the frame, low, so the
// growth is predicted pessimistically. A step down takes it in milliseconds of a 60 Hz frame:
// around the settle point it came to over half the frame (8.5 ms of 13.5 - 16 ms, two scales apart
// in one view), so a frame twice over the budget at the maximum is not cut to the floor as a share
// of the frame would have it.
const FIXED_SHARE = 0.35, FIXED_DOWN = 8.4;
// seconds between steps down, after a change before its frames count, and the least and most
// frames in its window (the most about 2.5 s at 60 Hz, so a new scene soon replaces the old one's)
const HOLD = 2, SETTLE = 0.4, MIN_SAMPLES = 45, WINDOW = 150;
// a step up: seconds after any change, the frames its window needs, and the most steps at once
const UP_HOLD = 4, UP_SAMPLES = 120, UP_STEPS = 2;
// frames a decision takes while settling (after SETTLE seconds at the scale), and how far under
// UPPER their median must come (the window's high quantile lies about that far above it)
const SETTLING_FRAMES = 20, SETTLING_GAP = 1.5;
// frames far over the budget: the median of the last EMERGENCY_FRAMES over UPPER + EMERGENCY_OVER
const EMERGENCY_HOLD = 0.5, EMERGENCY_FRAMES = 12, EMERGENCY_OVER = 2;
// seconds a scale it stepped down from stays barred, doubling each time it is barred again; while
// barred, a step back up to it needs BAR_MARGIN ms more headroom
const BAR = 8, BAR_MAX = 120, BAR_MARGIN = 1;
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
	/** Changes so far, newest last (seconds of `performance.now`, and the new scale). */
	readonly changes: { at: number; scale: number }[] = [];
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
	// the frame interval's share of a 60 Hz frame: the budgets below are a 60 Hz frame's
	private budget = 1;
	private readonly bars = new Map<number, { until: number; seconds: number }>();

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
		this.change( Math.min( this.scale, max ), performance.now() / 1000 );

	}

	/** The interval (ms) the frames are paced to (FramePacer.ts); the GPU's budget scales with it. */
	setFrameInterval( ms: number ): void {

		if ( Number.isFinite( ms ) && ms > 0 ) this.budget = Math.min( Math.max( ms / ( 1000 / 60 ), 0.25 ), 4 );

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

		this.change( Math.min( Math.max( this.round( scale ), this.floor ), this.max ), now );

	}

	private steerByGpu( now: number ): boolean {

		const s = this.samples;
		const since = now - this.lastChange;
		// settling, it decides as soon as a few frames are in, until a window fits
		if ( this.settling ) {

			if ( s.length < SETTLING_FRAMES ) return false;
			// the median: the first frames after a load carry one-off work (whole bakes, first draws)
			const typical = quantile( s, 0.5 ) / this.budget;
			if ( typical > UPPER - SETTLING_GAP && this.scale > this.floor ) return this.down( now, typical, UPPER - SETTLING_GAP );
			this.settling = false;
			return false;

		}
		if ( since >= EMERGENCY_HOLD && s.length >= EMERGENCY_FRAMES ) {

			const recent = quantile( s.slice( - EMERGENCY_FRAMES ), 0.5 ) / this.budget;
			if ( recent > UPPER + EMERGENCY_OVER && this.scale > this.floor ) return this.down( now, Math.max( recent, quantile( s, QUANTILE ) / this.budget ) );

		}
		if ( since < HOLD || s.length < MIN_SAMPLES ) return false;
		const high = quantile( s, QUANTILE ) / this.budget;
		if ( high > UPPER && this.scale > this.floor ) return this.down( now, high );
		if ( this.scale < this.max && since >= UP_HOLD && s.length >= UP_SAMPLES ) {

			// the largest of the next few scales up the model predicts fits; a scale it recently had
			// to leave (or one it would jump past) needs a wider margin, as the load may have fallen since
			let margin = MARGIN;
			let best = 0;
			for ( let k = 1; k <= UP_STEPS; k ++ ) {

				const up = this.round( Math.min( this.scale + k * this.step, this.max ) );
				if ( up <= this.scale || up === best ) break;
				if ( this.barred( up, now ) ) margin = MARGIN + BAR_MARGIN;
				if ( high * this.growth( up, FIXED_SHARE ) < UPPER - margin ) best = up;
				else break;

			}
			if ( best > this.scale ) return this.up( best, now );

		}
		return false;

	}

	// the cost of rendering at `scale` relative to the current one, by the model above
	private growth( scale: number, fixed: number ): number {

		return fixed + ( 1 - fixed ) * ( scale * scale ) / ( this.scale * this.scale );

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
			if ( ! this.barred( up, now ) ) return this.up( up, now );

		}
		return false;

	}

	/** Steps down, to the largest scale the model predicts frames costing `high` now (ms, at a 60 Hz
	 * budget) to fit at under `target`; one step without a cost (the frame-interval fallback). */
	private down( now: number, high = NaN, target = UPPER - MARGIN * 0.5 ): boolean {

		// the scale it leaves cost too much: keep away from it for a while, longer each time
		const bar = this.bars.get( this.scale );
		const seconds = bar && now - bar.until < BAR_MAX ? Math.min( bar.seconds * 2, BAR_MAX ) : BAR;
		this.bars.set( this.scale, { until: now + seconds, seconds } );
		let scale = this.round( Math.max( this.scale - this.step, this.floor ) );
		if ( high > 0 ) {

			const fixed = Math.min( FIXED_DOWN, 0.8 * high );
			const cost = ( x: number ) => fixed + ( high - fixed ) * ( x * x ) / ( this.scale * this.scale );
			while ( scale > this.floor && cost( scale ) > target ) scale = this.round( Math.max( scale - this.step, this.floor ) );

		}
		this.change( scale, now );
		return true;

	}

	private up( scale: number, now: number ): boolean {

		this.change( scale, now );
		return true;

	}

	private barred( scale: number, now: number ): boolean {

		const bar = this.bars.get( scale );
		return bar !== undefined && now < bar.until;

	}

	private change( scale: number, now: number ): void {

		if ( scale !== this.scale ) this.changes.push( { at: now, scale } );
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

	private constructor( backend: Backend ) {

		this.backend = backend;

	}

	/** A timer, or null where the device has no timestamp queries (or the renderer does not track them). */
	static create( renderer: THREE.WebGPURenderer ): GpuFrameTimer | null {

		const backend = renderer.backend as unknown as Backend;
		return backend.trackTimestamp ? new GpuFrameTimer( backend ) : null;

	}

	resolve(): void {

		for ( const pool of Object.values( this.backend.timestampQueryPool ) ) {

			if ( ! pool ) continue;
			// three resolves a pool on its own only when it overflows: route that through here too
			const hooked = pool as Pool & { frameTimer?: boolean };
			if ( ! hooked.frameTimer ) {

				hooked.frameTimer = true;
				pool.resolveQueriesAsync = () => { this.resolvePool( pool ); return Promise.resolve( 0 ); };

			}
			this.resolvePool( pool );

		}

	}

	private resolvePool( pool: Pool ): void {

		const count = pool.currentQueryIndex;
		if ( count === 0 ) return;
		const offsets = [ ...pool.queryOffsets ];
		pool.currentQueryIndex = 0;
		pool.queryOffsets.clear();
		const device = this.backend.device;
		let slot = this.buffers.find( ( b ) => ! b.busy && b.buffer.size >= pool.maxQueries * 8 );
		if ( ! slot && this.buffers.length < RING ) {

			slot = { buffer: device.createBuffer( { label: 'frameTimer.timestamps', size: pool.maxQueries * 8, usage: READBACK_USAGE } ), busy: false };
			this.buffers.push( slot );

		}
		if ( ! slot ) return; // every read-back buffer is in flight: these frames go unmeasured
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
				const frame = Number( uid.slice( uid.lastIndexOf( ':f' ) + 2 ) );
				if ( ! Number.isFinite( frame ) ) continue;
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
			let cursor = this.lastEnd, busy = 0;
			for ( const [ start, end ] of passes ) {

				busy += Math.max( end - Math.max( start, cursor ), 0 );
				cursor = Math.max( cursor, end );

			}
			this.lastEnd = cursor;
			this.onFrame?.( frame, busy );

		}

	}

}
