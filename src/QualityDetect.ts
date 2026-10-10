import { QUALITY, QUALITY_TIERS, DEFAULT_QUALITY, isQualityTier, type QualityTier } from './Quality.ts';
import { renderPixelRatio } from './post/RenderScale.ts';

// The quality tier chosen at startup, as games do (Unreal's scalability auto-detect): on a first
// visit without `?quality`, the page loads as high and times the GPU over the first frames behind the
// loading screen, then picks the highest tier a cost model predicts fits the display's paced frame
// interval with headroom. The choice is remembered (localStorage), with the GPU adapter it was made
// on; it is measured again only on request (the GUI's re-detect, `?autoQuality=detect`) or when the
// adapter changes. A choice below high reloads the page into that tier (the tiers differ in their
// materials and frame graph).
//
// It never switches tier while the scene is paused, under `?quality`, or in an automated browser
// (captures, profiles and probes keep the default unless they ask: `autoQuality=detect`), so their
// frames are unchanged. `autoQuality=off` keeps the default; `autoQualitySlow=<factor>` scales the
// measured time (a debug stand-in for a slower GPU; a choice made under it is not reused without it).
//
// The measurement: the scene as it loads, at high's nominal render scale with the dynamic scale held
// there, for MEASURE_FRAMES frames after WARMUP seconds (first bakes and first draws). The GPU's busy
// time per frame comes from timestamp queries (`GpuFrameTimer`, the dynamic scale's timer). Without
// them each measured frame starts on an idle queue (the loop skips frames while one is in flight)
// and is timed from the start of its tick to the queue's `onSubmittedWorkDone`: the GPU's time plus
// the tick's JS, so the choice errs on the safe side. Two other fallbacks were tried and dropped: the
// intervals between the rendered frames are whole refreshes (33.3 ms for a 23 ms frame at 60 Hz,
// which chose low), and submission-to-done over a queue that is never drained reads the queue's
// depth (98 ms for 23 ms frames).

// bumped when the model or the tiers change, so remembered choices are made again
const VERSION = 1;
const STORAGE_KEY = 'ponlai.quality.auto';
// seconds before frames count, the frames taken, and the most seconds it may take before it gives up
const WARMUP = 0.5, MEASURE_FRAMES = 30, TIMEOUT = 5;
// seconds after the warm-up without a timestamp before it times frames on an idle queue instead
const TIMER_WAIT = 1.5;
// The time (ms) left in the paced interval for the main thread, the compositor and the frames'
// spread above their median (the dynamic scale steers its 90th percentile to the interval less
// 2.4 ms; the 90th percentile ran about 0.4 ms above the median in a steady view).
const HEADROOM = 2.8;
// High is judged at medium's render scale: its dynamic scale settles wherever the GPU allows, but
// one that has to go below medium's pixel count in an ordinary view draws a softer image than
// medium's for its sharper shading, and has no room left for a heavier view.
//
// Each tier's GPU time as A + B * scale^2 (scale: render pixels per CSS pixel per axis), relative to
// high's at 1.5 = 1, at 1920x1080 CSS. Fitted to frames at render scales 1.5 and 1 (production
// build, timestamps on, the island at noon and golden hour, on one GPU): high 7.4 + 7.9 s^2 ms,
// medium 6.9 + 6.0 s^2, low 6.1 + 5.8 s^2. A measurement on high gives the GPU's speed; the other
// tiers follow in these proportions (a GPU of another make may share its time out differently, so
// the budget keeps headroom).
const COST: Record<QualityTier, { fixed: number; pixel: number }> = {
	high: { fixed: 0.29, pixel: 0.71 / 2.25 },
	medium: { fixed: 0.27, pixel: 0.53 / 2.25 },
	low: { fixed: 0.24, pixel: 0.52 / 2.25 },
};
// the view the fit was made at (CSS pixels): the per-pixel part follows the view's area
const FIT_AREA = 1920 * 1080;

export interface AutoQualityRecord {
	v: number;
	tier: QualityTier;
	adapter: string;
	slow: number;
	// the measured GPU time (ms, median), the scale it was rendered at, its source
	gpuMs: number;
	scale: number;
	source: 'gpu' | 'queue';
	// the paced interval (ms) and the budget it left, each tier's predicted time (ms)
	interval: number;
	budget: number;
	predicted: Record<QualityTier, number>;
	at: string;
}

export interface QualityChoice {
	tier: QualityTier;
	// how it was chosen: ?quality, a remembered measurement, a measurement on this load, the default
	source: 'url' | 'auto' | 'detect' | 'default';
	why: string;
	record: AutoQualityRecord | null;
	adapter: string;
	slow: number;
}

function readRecord(): AutoQualityRecord | null {

	try {

		const raw = localStorage.getItem( STORAGE_KEY );
		const record = raw ? JSON.parse( raw ) as AutoQualityRecord : null;
		return record && record.v === VERSION && isQualityTier( record.tier ) ? record : null;

	} catch {

		return null;

	}

}

function writeRecord( record: AutoQualityRecord ): boolean {

	try {

		localStorage.setItem( STORAGE_KEY, JSON.stringify( record ) );
		return readRecord()?.at === record.at;

	} catch {

		return false;

	}

}

/** Forgets the remembered choice (the GUI's re-detect, before it reloads). */
export function forgetQuality(): void {

	try { localStorage.removeItem( STORAGE_KEY ); } catch { /* storage unavailable: nothing kept */ }

}

/** A short, stable name of the GPU adapter (vendor, architecture, device, description). */
async function adapterName(): Promise<string> {

	try {

		const gpu = ( navigator as unknown as { gpu?: { requestAdapter( o: object ): Promise<{ info?: Record<string, string> } | null> } } ).gpu;
		const adapter = await gpu?.requestAdapter( { powerPreference: 'high-performance' } );
		const info = adapter?.info;
		return info ? [ info.vendor, info.architecture, info.device, info.description ].join( '/' ) : '';

	} catch {

		return '';

	}

}

/** The tier this load builds, and whether it measures the GPU (`source === 'detect'`). */
export async function chooseQuality( params: URLSearchParams ): Promise<QualityChoice> {

	const slow = Math.max( Number( params.get( 'autoQualitySlow' ) ?? 1 ) || 1, 0.01 );
	const base = { record: null, adapter: '', slow };
	const requested = params.get( 'quality' );
	if ( isQualityTier( requested ) ) return { ...base, tier: requested, source: 'url', why: 'set by ?quality' };
	const mode = params.get( 'autoQuality' );
	if ( mode === 'off' ) return { ...base, tier: DEFAULT_QUALITY, source: 'default', why: 'autoQuality=off' };
	const force = mode === 'detect';
	const adapter = await adapterName();
	const record = readRecord();
	if ( ! force && record && record.adapter === adapter && record.slow === slow ) {

		return { tier: record.tier, source: 'auto', why: `measured on this GPU ${ record.at.slice( 0, 10 ) }`, record, adapter, slow };

	}
	if ( ! force && navigator.webdriver ) return { ...base, adapter, tier: DEFAULT_QUALITY, source: 'default', why: 'automated browser: not measured (autoQuality=detect measures)' };
	// a paused scene never switches tier: it keeps the default until a running load measures
	if ( params.has( 'paused' ) ) return { ...base, adapter, tier: DEFAULT_QUALITY, source: 'default', why: 'paused: not measured' };
	const why = ! record ? 'first visit: measuring' : record.adapter !== adapter ? 'GPU changed: measuring' : 'measuring';
	return { ...base, adapter, tier: 'high', source: 'detect', why };

}

/** The GUI's lines for a choice: how the tier was chosen, the measurement and each tier's prediction. */
export interface QualityLines {
	chosen: string;
	measured: string;
	predicted: string;
}

function describe( r: AutoQualityRecord ): string {

	return `${ r.tier } (GPU ${ r.gpuMs.toFixed( 1 ) } ms)`;

}

export function qualityLines( tier: QualityTier, how: string, r: AutoQualityRecord | null ): QualityLines {

	if ( ! r ) return { chosen: `${ tier }: ${ how }`, measured: '-', predicted: '-' };
	const timer = r.source === 'queue' ? 'frame on an idle queue' : 'GPU timestamps';
	return {
		chosen: `${ tier }: ${ how }`,
		measured: `${ r.gpuMs.toFixed( 1 ) } ms at scale ${ r.scale.toFixed( 2 ) } (${ timer }${ r.slow !== 1 ? `, x${ r.slow } slow` : '' })`,
		predicted: QUALITY_TIERS.map( ( t ) => `${ t } ${ r.predicted[ t ].toFixed( 1 ) }` ).reverse().join( ', ' ) + ` / ${ r.budget.toFixed( 1 ) } ms`,
	};

}

export interface DetectView {
	paused: boolean;
	hidden: boolean;
	// the scale the frames render at, the paced interval (ms) and the view (CSS pixels)
	scale: number;
	interval: number;
	width: number;
	height: number;
	cap: number;
}

/** Times the GPU over the first frames and picks the tier. With timestamp queries (`timed`), feed it
 * `gpu()` samples; without them it times frames itself on an idle queue (`idle` resolves once the
 * queue's work is done). Run each frame through `frame()`; `onDone` is called once with the record, or
 * null when it gave up (paused, hidden, too few frames): the page then keeps high for this load. */
export class QualityDetector {

	pending = true;
	result: AutoQualityRecord | null = null;
	why = 'measuring';
	onDone: ( ( record: AutoQualityRecord | null ) => void ) | null = null;
	private readonly samples: number[] = [];
	private timed: boolean;
	// a frame timed on an idle queue is in flight; the first one may wait behind earlier frames
	private inFlight = false;
	private drained = false;
	// the first frame's time: the loop starts after the first-use pipelines are built
	private start = NaN;
	// the renderer's frame id at the end of the warm-up
	private warmFrame = Infinity;
	private readonly choice: QualityChoice;
	private readonly view: () => DetectView;
	private readonly idle: () => Promise<void>;
	private readonly frameId: () => number;

	constructor( choice: QualityChoice, view: () => DetectView, timed: boolean, idle: () => Promise<void>, frameId: () => number ) {

		this.choice = choice;
		this.view = view;
		this.timed = timed;
		this.idle = idle;
		this.frameId = frameId;

	}

	private get elapsed(): number {

		return ( performance.now() - this.start ) / 1000; // NaN before the first frame

	}

	/** One frame's GPU busy time (ms), from the timestamp queries, by the renderer's frame id. The
	 * times arrive frames late: only frames rendered after the warm-up count. */
	gpu( frame: number, ms: number ): void {

		if ( this.pending && this.timed && frame > this.warmFrame && ms > 0 ) this.samples.push( ms );

	}

	/** Runs one frame of the loop (or skips it while a frame timed on an idle queue is in flight). */
	frame( body: ( time: number ) => void, time: number ): void {

		if ( Number.isNaN( this.start ) ) this.start = performance.now();
		if ( ! this.pending ) return body( time );
		// timestamps that never arrive (a timer that could not be set up): time frames instead
		if ( this.timed && this.samples.length === 0 && this.elapsed > WARMUP + TIMER_WAIT ) this.timed = false;
		const timeFrames = ! this.timed && this.elapsed >= WARMUP;
		if ( timeFrames && this.inFlight ) return this.check();
		const t0 = performance.now();
		body( time );
		if ( this.elapsed >= WARMUP && this.warmFrame === Infinity ) this.warmFrame = this.frameId();
		if ( timeFrames ) {

			this.inFlight = true;
			this.idle().then( () => {

				this.inFlight = false;
				// the first one waited behind the frames queued before it
				if ( this.drained && this.pending ) this.samples.push( performance.now() - t0 );
				this.drained = true;

			}, () => { this.inFlight = false; } );

		}
		this.check();

	}

	private check(): void {

		const v = this.view();
		if ( v.paused || v.hidden ) return this.finish( null, v.paused ? 'paused: not measured' : 'page hidden: not measured' );
		if ( this.samples.length < MEASURE_FRAMES ) {

			// a GPU too slow for the frames in time is judged on the few it drew
			if ( this.elapsed > TIMEOUT ) {

				if ( this.samples.length >= 3 ) this.choose( v );
				else this.finish( null, 'too few frames: not measured' );

			}
			return;

		}
		this.choose( v );

	}

	private choose( v: DetectView ): void {

		const measured = median( this.samples ) * this.choice.slow;
		const area = v.width * v.height;
		// the GPU's speed against the fit: the measured frame over the model's high at this scale
		const model = ( tier: QualityTier, scale: number ) => COST[ tier ].fixed + COST[ tier ].pixel * scale * scale * area / FIT_AREA;
		const speed = measured / model( 'high', v.scale );
		const predicted = {} as Record<QualityTier, number>;
		const scaleOf = ( tier: QualityTier ) => renderPixelRatio( v.width, v.height, QUALITY[ tier ].render, false, v.cap );
		for ( const tier of QUALITY_TIERS ) predicted[ tier ] = + ( speed * model( tier, scaleOf( tier === 'high' ? 'medium' : tier ) ) ).toFixed( 2 );
		const budget = v.interval - HEADROOM;
		const tier = [ ...QUALITY_TIERS ].reverse().find( ( t ) => predicted[ t ] <= budget ) ?? QUALITY_TIERS[ 0 ];
		const record: AutoQualityRecord = {
			v: VERSION, tier, adapter: this.choice.adapter, slow: this.choice.slow,
			gpuMs: + measured.toFixed( 2 ), scale: v.scale, source: this.timed ? 'gpu' : 'queue',
			interval: + v.interval.toFixed( 2 ), budget: + budget.toFixed( 2 ), predicted, at: new Date().toISOString(),
		};
		this.finish( record, describe( record ) );

	}

	private finish( record: AutoQualityRecord | null, why: string ): void {

		this.pending = false;
		this.result = record;
		this.why = why;
		this.onDone?.( record );

	}

}

/** Remembers a new choice; false where the browser keeps no storage. */
export function rememberQuality( record: AutoQualityRecord ): boolean {

	return writeRecord( record );

}

function median( values: readonly number[] ): number {

	const s = [ ...values ].sort( ( a, b ) => a - b );
	return s[ s.length >> 1 ];

}
