// Frame pacing: renders on a steady divisor of the display's refresh, so a display faster than the
// frame rate the scene holds shows every frame for the same number of refreshes.
//
// Chrome runs `requestAnimationFrame` at the display's refresh (120 Hz on a ProMotion display). A
// frame that keeps the GPU busy for 12-16 ms then finishes one, two or three refreshes after the
// previous one, as the queue happens to drain: on such a display the frames came 8.3, 16.7 and
// 25 ms apart in an irregular mix (about a sixth at 8.3 ms, a third of the intervals differing
// from the one before), which reads as stutter while the camera moves even where the average is
// above 60 fps. Here the loop renders only on the refreshes that keep the interval at the target
// (every second refresh at 120 Hz for 60 fps) and skips the others before three's animation loop
// sees them, so the scene clock, the camera's damping and the GPU all advance in equal steps.
//
// The refresh period is estimated from the animation frames' own timestamps (the vblank times the
// browser hands to rAF): the median of the shortest intervals between consecutive callbacks,
// rendered or skipped. The divisor is the whole number of refreshes nearest the target interval, never more
// than a quarter above it (so 144 Hz holds 72 fps and 90 Hz renders every refresh); at 60 Hz or a
// target of 0 every callback renders, as without the pacer.
//
// High and medium hold 60 (Quality.ts `frameRate`). Low renders on every refresh (`frameRate: 0`):
// its light frames, held to 60 Hz, finished right at the compositor's deadline and were shown one
// and three refreshes apart in turn. The scene's clock steps by the frames' vblank times (rAF's
// timestamp), not by when the tick starts (a few milliseconds into the frame, by a varying
// amount), and the camera applies its input once per rendered frame (IslandCameraControls'
// `advance`): three's OrbitControls damped on every event, so a frame took one to three damping
// steps by chance. A hidden page renders nothing (main.ts stops the loop).

// callbacks in the window the refresh period is taken from, and its quantile (low, as a callback
// delayed by the main thread or a skipped vblank only lengthens an interval)
const WINDOW = 240, QUANTILE = 0.05;
// intervals outside this range (ms) are not refresh periods (a hidden page, a stall)
const MIN_PERIOD = 2, MAX_PERIOD = 50;

export class FramePacer {

	/** The frame rate to hold (frames per second); 0 renders on every refresh. */
	readonly target: number;
	/** The display's refresh period (ms), as measured. */
	period = 1000 / 60;
	/** Refreshes per rendered frame. */
	divisor = 1;
	/** Animation frames the pacer let through and skipped (for diagnostics). */
	rendered = 0;
	skipped = 0;
	/** A `requestAnimationFrame` context for three's animation loop (`Animation.setContext`): the
	 * callback runs only on the refreshes the pacer renders. */
	readonly context: { requestAnimationFrame( callback: FrameRequestCallback ): number; cancelAnimationFrame( id: number ): void };
	private readonly deltas: number[] = [];
	private previous = NaN;
	private last = - Infinity;
	private callback: FrameRequestCallback | null = null;
	private pending = 0;

	constructor( target: number ) {

		this.target = Number.isFinite( target ) && target > 0 ? target : 0;
		const onFrame = ( time: number ) => {

			const callback = this.callback;
			if ( ! callback ) return;
			if ( this.frame( time ) ) {

				// three's loop asks for its next frame first thing, through this context again
				this.callback = null;
				callback( time );

			} else this.pending = requestAnimationFrame( onFrame );

		};
		this.context = {
			requestAnimationFrame: ( callback ) => {

				this.callback = callback;
				this.pending = requestAnimationFrame( onFrame );
				return this.pending;

			},
			cancelAnimationFrame: () => {

				cancelAnimationFrame( this.pending );
				this.callback = null;

			},
		};

	}

	/** The interval (ms) between rendered frames while the pacer holds its target. */
	get interval(): number {

		return this.divisor * this.period;

	}

	/** Whether the animation frame at `time` (its rAF timestamp, ms) renders. */
	frame( time: number ): boolean {

		const delta = time - this.previous;
		this.previous = time;
		if ( delta >= MIN_PERIOD && delta <= MAX_PERIOD ) {

			this.deltas.push( delta );
			if ( this.deltas.length > WINDOW ) this.deltas.shift();
			if ( this.deltas.length >= 30 ) this.setPeriod( this.measure() );

		}
		// a frame is due once the interval has passed, give or take half a refresh (the timestamps
		// jitter by a fraction of a millisecond); a late frame restarts the count from itself
		if ( time - this.last < this.interval - this.period * 0.5 ) {

			this.skipped ++;
			return false;

		}
		this.last = time;
		this.rendered ++;
		return true;

	}

	// The refresh period: the median of the shortest intervals (the timestamps jitter by up to a
	// millisecond either way, so a low quantile alone would read a period that short).
	private measure(): number {

		const low = quantile( this.deltas, QUANTILE );
		const single = this.deltas.filter( ( d ) => d < low * 1.5 );
		return quantile( single, 0.5 );

	}

	private setPeriod( period: number ): void {

		this.period = period;
		if ( this.target === 0 ) { this.divisor = 1; return; }
		this.divisor = Math.max( 1, Math.floor( 1000 / this.target / period + 0.25 ) );

	}

}

function quantile( values: readonly number[], q: number ): number {

	const s = [ ...values ].sort( ( a, b ) => a - b );
	const i = ( s.length - 1 ) * q, lo = Math.floor( i ), hi = Math.ceil( i );
	return s[ lo ] + ( s[ hi ] - s[ lo ] ) * ( i - lo );

}
