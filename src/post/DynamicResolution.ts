import type * as THREE from 'three/webgpu';

// Dynamic resolution (high tier): the scene's render scale moves between the tier's maximum and a
// floor so that the GPU's frame time stays inside the paced frame (a 60 Hz frame, `FramePacer.ts`),
// without the scale ever jumping.
//
// - The GPU time comes from timestamp queries (`GpuFrameTimer`, or the frame profiler's own when it
//   runs), as the time the GPU was busy with each frame: every pass charged from the previous
//   pass's completion (or its own start, if later) to its end. A tile-based GPU stamps a pass's
//   start when its vertex stage begins, long before the passes it reads have finished, so the raw
//   intervals overlap; summed they come to several times the frame. Without timestamp queries the
//   frame intervals steer it instead (`sampleInterval`): missed vblanks step it down, and a long
//   run without one steps it up, backing off each time a step up costs frames.
// - It changes by one step (0.05) at a time, at most every HOLD seconds, so a change is gradual
//   and softens or sharpens the whole frame at once. Frames far over the budget step it down after
//   EMERGENCY_HOLD instead, so a sudden heavy scene (a jump to a storm) recovers in seconds.
// - Hysteresis: it steps down when the window's high quantile of GPU time exceeds UPPER, and up
//   only when that quantile, grown by the cost of the larger render (a pessimistic model: the
//   per-pixel share of the frame scaled by the pixel count), stays under UPPER - MARGIN. A scale it
//   had to leave stays barred for a while (BAR, doubled each time): a step back up to it then needs
//   a wider margin, so it does not oscillate, yet a lighter scene still climbs.
// The page renders at the tier's nominal scale whenever the scale is pinned (`?dpr`, the GUI's
// full resolution) or the scene is paused, so paused frames and captures render at the reference
// scale whatever scale the running page had reached.

// GPU busy time (ms) the window's high quantile must stay under, for a 60 Hz frame (16.7 ms; the
// budgets scale with the paced interval). The slack covers the spread between frames (periodic
// bakes and map redraws land on single frames) and the browser's pacing, which missed vblanks
// from about 16 ms of GPU time.
const UPPER = 15.2;
const MARGIN = 0.4;
// the quantile of the window's frames that steers it (its few worst frames must fit too)
const QUANTILE = 0.97;
// share of a frame's GPU time that does not scale with the render's pixels (shadow maps, FFT,
// sky bakes, canvas-sized output and upscale), taken low so a step up is predicted pessimistically
const FIXED_SHARE = 0.35;
// seconds between changes, after a change before its frames count, and the least and most frames
// in its window (the most about 2.5 s at 60 Hz, so a new scene soon replaces the old one's)
const HOLD = 2, SETTLE = 0.4, MIN_SAMPLES = 45, WINDOW = 150;
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

	/** Sets the scale (a debug override, or a seek to a known settle point); clears the window. */
	force( scale: number, now = performance.now() / 1000 ): void {

		this.change( Math.min( Math.max( this.round( scale ), this.floor ), this.max ), now );

	}

	private steerByGpu( now: number ): boolean {

		const s = this.samples;
		const since = now - this.lastChange;
		if ( since >= EMERGENCY_HOLD && s.length >= EMERGENCY_FRAMES && this.scale > this.floor ) {

			const recent = quantile( s.slice( - EMERGENCY_FRAMES ), 0.5 ) / this.budget;
			if ( recent > UPPER + EMERGENCY_OVER ) return this.down( now );

		}
		if ( since < HOLD || s.length < MIN_SAMPLES ) return false;
		const high = quantile( s, QUANTILE ) / this.budget;
		if ( high > UPPER && this.scale > this.floor ) return this.down( now );
		if ( this.scale < this.max ) {

			const up = this.round( Math.min( this.scale + this.step, this.max ) );
			const growth = FIXED_SHARE + ( 1 - FIXED_SHARE ) * ( up * up ) / ( this.scale * this.scale );
			// a scale it recently had to leave needs a wider margin (the load may have fallen since)
			const margin = this.barred( up, now ) ? MARGIN + BAR_MARGIN : MARGIN;
			if ( high * growth < UPPER - margin ) return this.up( up, now );

		}
		return false;

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

	private down( now: number ): boolean {

		// the scale it leaves cost too much: keep away from it for a while, longer each time
		const bar = this.bars.get( this.scale );
		const seconds = bar && now - bar.until < BAR_MAX ? Math.min( bar.seconds * 2, BAR_MAX ) : BAR;
		this.bars.set( this.scale, { until: now + seconds, seconds } );
		this.change( this.round( Math.max( this.scale - this.step, this.floor ) ), now );
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
