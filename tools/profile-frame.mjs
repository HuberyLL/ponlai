// Frame profiler: plays a matrix of scenes (running clock, fixed weather, a slow camera orbit) in
// headless Chrome with an uncapped frame rate (or at 60 Hz with `--vsync`), and reports the frame
// interval, the GPU time per pass (timestamp queries, labelled by `src/debug/FrameProfiler.ts`
// through `?profile`), the tick's JS time, hitches with their cause, and the startup. Runs under the machine-wide GPU lock (held
// exclusively) and first checks that nothing else keeps the GPU busy (its results are marked
// contended otherwise).
//
//   node tools/profile-frame.mjs [url] [--scenes a,b | --scene a] [--w 1920 --h 1080 --scale 2]
//        [--quality high] [--timestamps on|off|both] [--warmup s] [--seconds 7] [--orbit 3]
//        [--eval "js"] [--repeat n] [--shots] [--detail] [--raw] [--out dir] [--label name]
//        [--q "extra=url&options"] [--hooks off] [--world-cache off] [--idle-threshold 15] [--idle-wait s]
//        [--mode page | reload] [--fresh] [--vsync] [--accept [--target 16.7] [--strict]] [--scales 1.5,1.25,1]
//        [--scale-settle s] [--drs-store] [--preload-wait 60] [--display [--motion user | orbit | none]]
//   node tools/profile-frame.mjs --compare urlA urlB [--eval-a "js"] [--eval-b "js"] [--scenes ...]
//        [--slices 8] [--slice 1.5] [--settle 1] [--display]       (two pages, alternating slices)
//   node tools/profile-frame.mjs [url] --toggle "js using s and on" [--block 60] [--blocks 8] [--lag 30]
//   node tools/profile-frame.mjs --report <dir>/profile.json     (re-renders its summary.md)
//   node tools/profile-frame.mjs --list
//
// The reference is a production build (`npm run build && npm run preview`, port 5191, the
// default url); the dev server works for quick checks. The default viewport is a generic 4K
// display (1920x1080 CSS at DPR 2). Chrome comes from CHROME_PATH, else the system Chrome, else
// Playwright's Chromium, with a profile of its own kept between runs (`--profile-dir`), so the
// world cache below survives. Writes <out>/profile.json and <out>/summary.md (default
// artifacts/perf/<label>).
//
// The exclusive lock covers what is measured, not the setup: the browser starts before it, and a
// build this profile has not loaded yet is first loaded once under a shared GPU slot (`preload`;
// skipped when no slot frees within `--preload-wait` seconds), so the loads under the lock find the
// world cache and the shader cache warm, as every run but a build's first always did (a miss
// generates the island: seconds alone, a minute under a busy CPU). Under the lock everything runs
// as before: the idle check (which also stands for the first load's), each load, each scene's
// switch, warm-up, scale settle and measured window. The pages' loops stop before the lock is
// released; the GPU name, the files and the browser's close follow. profile.json's `wallSeconds`
// is the time under the exclusive lock (`lockWaitSeconds`, `totalSeconds`, `preload` beside it).
// Measured: per-pass GPU times, frame rates and
// acceptance verdicts within the run-to-run noise of the earlier tool, 4-12 s less held per run.
//
// Modes (most of a page load is generating the island, about 10 s; scenes are switched instead):
// - page (the default): one page load per variant; each scene is set up at runtime through
//   window.__PONLAI__ as its URL options would load it (weather established at once and wet in
//   rain, the time preset, the clock from 0, the camera view and its motion), then warmed up for
//   `--warmup` seconds (1.5) and until no pipeline was created for a second (a new weather compiles
//   its pipelines on first use; that compile is reported per scene, outside the measured window).
// - reload (`--mode reload`): the original method, a fresh page load per group of scenes sharing
//   a query (all of them with --fresh). `--compare` then alternates A B B A page loads.
// - compare in page mode: A and B are loaded once each, in two pages of one browser, and measured
//   in alternating slices (`--slices` 8 in the order B A A B A B B A, `--slice` 1.5 s each) under
//   the same conditions. One page runs at a time: the other is stopped (no animation frame, no GPU
//   work; its queued frames and any sky bake drained before the other starts; its camera and
//   clock wait), since Chrome let one page's frames starve the other's queue. Deltas are reported with a 95 % interval from the slices' spread,
//   beside each page's render scale per scene (high's dynamic scale can settle higher on one side,
//   which the load-time render in the header does not show). Page errors name their page (A or B).
// - toggle (`--toggle "js"`): A/B inside one page. The expression runs with `s` = window.__PONLAI__
//   and `on` (false for A, true for B), and is applied every `--block` frames in an A B B A B A A B
//   pattern after both states were warmed: for example --toggle "s.water.mesh.visible = !on", or
//   --toggle "s.flags.fastWater = on" for an optimisation that reads a flag of
//   `src/debug/DebugFlags.ts` (the fastest and most precise A/B: no reload, no drain). Each frame
//   counts for the state its tick ran in; GPU figures drop the first 2 frames after a change, frame
//   intervals the first `--lag` (30: headless Chrome queues about two dozen frames, so a change
//   reaches the rAF interval that much later).
// - vsync (`--vsync`): Chrome keeps its vsync and frame-rate limit (60 Hz headless), so the frame
//   interval is what a player sees: 16.7 ms while every frame makes its vblank, 33.3 when one
//   misses. Uncapped, a GPU-bound scene's p95 is mostly pacing noise (a sky that holds 60 Hz under
//   vsync showed a p95 of 33.5 ms uncapped); with vsync the queue stays shallow and the intervals
//   quantise to vblanks.
// - acceptance (`--accept`, implies --vsync and, unless given, --timestamps both): a pass or fail
//   per scene for the 60 fps criterion. From the run without timestamps: the median and the p95
//   within half a millisecond of `--target` (16.7), and no frame over 25 ms in the measured window
//   (7 s by default); the p99, the maximum, and the GPU busy time of the run with timestamps are
//   reported beside the verdict. Other work on the GPU costs frames, so a scene measured while something
//   else kept the GPU busy (contended) that fails is INCONCLUSIVE, unless its own GPU busy time
//   (median, with timestamps) is over the target, which no idle GPU would make up; one that passes
//   is PASS (contended). The exit code stays 0 unless `--strict` is given, which exits 1 on a FAIL.
//   Headless 60 Hz does not show how a faster display paces the frames (see --display).
// - scales (`--scales 1.5,1.25,1`): the run once per render scale (the page's `dpr` option), in one
//   invocation, with a table of every scene at every scale (for the threshold where a scene holds
//   60 Hz, and the settle points of a dynamic resolution). The url and `--q` must not set `dpr`
//   themselves (the page reads the first of a repeated option); a scale above the display's pixel
//   ratio is capped by the page, and the run warns when the render's ratio differs from the scale.
// - scale settle (`--scale-settle s`): a tier with a dynamic render scale (high) moves it by the
//   GPU's frame time; after a scene's warm-up the run waits until it has held for s seconds (at
//   most 60), so the scene is measured at its settle point. Each scene's results give the scale
//   its frames were drawn at (median, range and changes) beside the frame times.
// - the remembered scale: high starts from the dynamic scale it last held (`drsStore`, off in an
//   automated browser anyway); --compare and --accept add `drsStore=off` so neither side of an A/B
//   (two AA modes or two builds) starts from a scale the other settled at, and `--drs-store` adds
//   `drsStore=on` instead, to measure a returning load.
// - display (`--display`): the real display, headed. Chrome (the system's, without the switches the
//   headless runs take) opens full screen (`--kiosk`) at the display's size and pixel ratio with
//   its own vsync, so a 120 Hz display runs rAF at 120 Hz. The camera is dragged like a player's
//   (`--motion user`, the default here: drags of 30 to 200 deg/s with pauses, a wheel zoom, a flick,
//   through Chrome's own input; `orbit` keeps the slow orbit, `none` holds it still) for `--seconds`
//   (20). Beside the usual figures each scene reports, by display refreshes, the intervals between
//   the frames the scene rendered and between the frames the compositor presented (a trace of
//   Chrome's frame pipeline), the share of intervals that change cadence (judder at a steady pace),
//   and how much the camera's turning speed changes from frame to frame while it turns. Timestamps
//   default to off, as in a player's page. Headless 60 Hz vsync passed every scene while this display
//   showed a sixth of the frames 8.3 ms apart and a third of the intervals changing cadence (before
//   the frame pacer): the headless run does not stand in for a faster display. A window appears on
//   the screen for the run; keep other pages and animated windows closed (the window server itself
//   took 15-30 % of the GPU's time during these runs). `--window WxH` opens a normal window of that
//   outer size instead (a player's, with its tab strip and toolbar): the other windows stay on
//   screen, and a page drawing in one of them (an app's hidden browser pane kept rendering a second
//   Ponlai page) shares the GPU and lowers high's scale. Full screen covers them, and they drew less:
//   the app with that pane took a tenth of the GPU beside a window, a hundredth behind full screen.
//   With `--compare` (page mode) the two pages run in the same interleaved slices as headless, so
//   the drift between separate headed runs (1-2 ms) cancels: the running page is brought to the
//   front (a background tab gets no animation frames), each slice has its own trace and restarts
//   the drags through its settle and slice, and the summary adds the share of late frames
//   (presented intervals longer than the frame pacer's pace) as a delta over the slices.
// A/B decisions should rest on GPU time (per pass and in total): it is measured per frame on the
// GPU's timeline and converges in far fewer frames than the frame interval. Frame rates for final
// numbers come from `--timestamps off` or `both`, since Chrome paces frames differently with
// timestamp queries on (up to a quarter faster).
//
// `--eval` runs in the page for every scene, after its camera is placed and before its warm-up,
// with `s` = window.__PONLAI__: an ablation, for example --eval "s.water.mesh.visible = false".
// A url's own query options come first, so "http://host/?profile=frames" runs that side without
// timestamps. `--timestamps both` takes a scene's frame intervals from a run without GPU
// timestamps (the rate a player sees) and its passes from a run with them. `--hooks off` leaves
// out ?profile (frame intervals only, as for a build without the profiler). Builds load the island
// from IndexedDB while its generator is unchanged (older ones only with `?worldCache`, which is
// added to every url); `--world-cache off` adds `worldCache=off` instead, so the island is
// generated as on a first visit. Older builds ignore what they do not know, as they ignore the runtime
// hooks this tool falls back from (it then drives their handles directly). `--shots` saves a JPEG
// of each scene after its measurement (profile runs, not A/Bs), `--detail` adds each pass's own time and `--raw` every
// frame.
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { withGpuLock, waitForIdleGpu, sampleGpuUtilisation } from './gpu-lock.mjs';
import { requireDisplayAllowed } from './display-gate.mjs';

// ------------------------------------------------------------------ options

const argv = process.argv.slice( 2 );
const flags = new Set( argv.filter( ( a ) => a.startsWith( '--' ) ) );
const VALUE_FLAGS = new Set( [ 'report', 'scenes', 'scene', 'w', 'h', 'scale', 'quality', 'warmup', 'seconds', 'orbit', 'eval', 'eval-a', 'eval-b', 'repeat', 'out', 'label', 'q', 'compare', 'idle-wait', 'idle-threshold', 'timestamps', 'hooks',
	'mode', 'toggle', 'world-cache', 'slices', 'slice', 'settle', 'block', 'blocks', 'lag', 'profile-dir', 'target', 'scales', 'scale-settle', 'motion', 'preload-wait' ] );
const opt = ( name, fallback ) => {

	const i = argv.indexOf( '--' + name );
	return i >= 0 ? argv[ i + 1 ] : fallback;

};
const positional = argv.filter( ( a, i ) => ! a.startsWith( '--' ) && ! ( i > 0 && VALUE_FLAGS.has( argv[ i - 1 ].slice( 2 ) ) ) );

// Every scene runs its clock (a paused, still scene settles its clouds once and skips the march
// and the shadow steps, so it under-measures) with fixed weather, the camera moving as in play.
// Scenes sharing a query run in one page load unless --fresh; `change` scenes run last.
export const SCENES = {
	'island-fair-noon': { q: 'weather=fair&preset=noon', view: 'island' },
	'island-clear-golden': { q: 'weather=clear&preset=golden-hour', view: 'island', faceSun: true },
	'horizon-fair-noon': { q: 'weather=fair&preset=noon', view: 'horizon' },
	'sky-cloudy': { q: 'weather=cloudy&preset=noon', view: 'sky' },
	'island-overcast': { q: 'weather=overcast&preset=noon', view: 'island' },
	'island-rain': { q: 'weather=rain&preset=noon', view: 'island' },
	'island-storm': { q: 'weather=storm&preset=noon', view: 'island' },
	'horizon-storm': { q: 'weather=storm&preset=noon', view: 'horizon' },
	'island-fog-dawn': { q: 'weather=fog&preset=dawn', view: 'island' },
	'island-night-clear': { q: 'weather=clear&preset=midnight', view: 'island' },
	// eye height over the meadow near the rim, looking out over the lip
	'meadow-close': { q: 'weather=fair&preset=noon', view: 'meadow' },
	// a front from fair to rain sweeps in during the measurement: pipeline compiles, bakes
	'weather-change': { q: 'weather=fair&preset=noon', view: 'island', change: { weather: 'rain', seconds: 6 } },
};

if ( flags.has( '--list' ) ) {

	for ( const [ name, s ] of Object.entries( SCENES ) ) console.log( name.padEnd( 22 ), s.q, s.view, s.change ? `-> ${ s.change.weather }` : '' );
	process.exit( 0 );

}

// --display: Chrome headed and full screen on the real display, with the display's own vsync (a
// 120 Hz display stays 120 Hz), the camera dragged like a player's (`--motion user`), and the frames
// the compositor presented read from a trace (see the header)
const DISPLAY = flags.has( '--display' );
// --window WxH (with --display): a normal window of that outer size instead of full screen, as a
// player's: the other windows stay on screen, and whatever they draw shares the GPU
const WINDOW = opt( 'window', '' );
if ( WINDOW && ! ( DISPLAY && /^\d+x\d+$/.test( WINDOW ) ) ) throw new Error( '--window WxH goes with --display' );
const MOTION = opt( 'motion', DISPLAY ? 'user' : 'orbit' );
if ( ! [ 'user', 'orbit', 'none' ].includes( MOTION ) ) throw new Error( '--motion user | orbit | none' );
if ( MOTION === 'user' && ! DISPLAY ) throw new Error( '--motion user drives a headed page: give --display' );
const MODE = opt( 'mode', 'page' );
if ( ! [ 'page', 'reload' ].includes( MODE ) ) throw new Error( '--mode page | reload' );
const TOGGLE = opt( 'toggle', '' );
const W = Number( opt( 'w', 1920 ) ), H = Number( opt( 'h', 1080 ) ), SCALE = Number( opt( 'scale', 2 ) );
const QUALITY = opt( 'quality', 'high' );
// warm-up after a load (reload mode) or a scene switch (page modes, which also wait for compiles)
const WARMUP = Number( opt( 'warmup', MODE === 'reload' ? 3 : 1.5 ) ), SECONDS = Number( opt( 'seconds', DISPLAY ? 20 : 7 ) ), ORBIT = Number( opt( 'orbit', 3 ) );
// compare in page mode: alternating slices of each page, measured for SLICE seconds after SETTLE
const SLICES = Math.max( 2, Number( opt( 'slices', 8 ) ) ), SLICE = Number( opt( 'slice', 1.5 ) ), SETTLE = Number( opt( 'settle', 1 ) );
// toggle: frames per block, blocks per scene, frames dropped from the intervals after a change
const BLOCK = Math.max( 4, Number( opt( 'block', 60 ) ) ), BLOCKS = Math.max( 2, Number( opt( 'blocks', 8 ) ) ), LAG = Number( opt( 'lag', 30 ) );
// the order of slices and toggle blocks: balanced against a drift over the run (0 = A, 1 = B)
const ORDER = [ 0, 1, 1, 0, 1, 0, 0, 1 ];
const WORLD_CACHE = opt( 'world-cache', 'on' ) !== 'off';
// --scale-settle s: after a scene's warm-up, wait until a dynamic render scale (high's) has not
// moved for s seconds (at most 60 s), so the scene is measured at its settle point
const SCALE_SETTLE = Number( opt( 'scale-settle', 0 ) );
const PROFILE_DIR = opt( 'profile-dir', path.join( os.tmpdir(), 'ponlai-profile-frame-chrome' ) );
// the longest wait for a shared GPU slot to preload in (see preload), seconds
const PRELOAD_WAIT = Number( opt( 'preload-wait', 60 ) );
const REPEAT = Math.max( 1, Number( opt( 'repeat', 1 ) ) );
const EXTRA_Q = opt( 'q', '' );
// GPU timestamps: on (the default: frame intervals and the GPU time per pass), off (frame intervals
// only), or both (each scene twice: its frame intervals from a run without timestamps, its passes
// from one with them). With timestamp queries on, Chrome on an Apple GPU ran the same frames up to
// a quarter faster (light scenes most, a GPU-bound heavy scene hardly at all), so the frame rate a
// player sees is the one without them; their per-pass split stays the reference for where the time
// goes, and A/B deltas in one mode cancel the bias.
// --accept: the 60 fps criterion per scene (see above), under vsync; frame intervals come from the
// run without timestamps, the GPU busy time from the run with them
const ACCEPT = flags.has( '--accept' );
const VSYNC = flags.has( '--vsync' ) || ACCEPT || DISPLAY;
// --strict: exit with 1 when an uncontended scene fails the acceptance (the verdicts are written
// either way; without it the exit code stays 0, as for any profile run)
const STRICT = flags.has( '--strict' );
if ( STRICT && ! ACCEPT ) throw new Error( '--strict goes with --accept' );
// the frame interval to hold (ms), the slack allowed on its median and p95 (vblank timestamps
// jitter by a few tenths), and the longest frame allowed
const TARGET = Number( opt( 'target', 16.7 ) ), TARGET_SLACK = 0.5, ACCEPT_MAX = 25;
// (display mode: off, as a player's page runs; high's dynamic resolution keeps its own queries)
const TIMESTAMP_MODE = opt( 'timestamps', ACCEPT ? 'both' : DISPLAY ? 'off' : 'on' );
if ( ! [ 'on', 'off', 'both' ].includes( TIMESTAMP_MODE ) ) throw new Error( '--timestamps on | off | both' );
if ( ACCEPT && TIMESTAMP_MODE === 'on' ) throw new Error( '--accept judges the frame rate a player sees: --timestamps both (the default) or off' );
// --scales: render scales (the page's dpr option) to sweep in one invocation
const SCALES = opt( 'scales', '' ).split( ',' ).map( ( x ) => x.trim() ).filter( Boolean ).map( Number );
if ( SCALES.some( ( x ) => ! ( x > 0 ) ) ) throw new Error( '--scales takes a list of positive numbers, e.g. 1.5,1.25,1' );
// --hooks off: no ?profile, frame intervals only (to check what the hooks cost, or a build without them)
const HOOKS = opt( 'hooks', 'on' ) !== 'off';
// GPU utilisation (%) above which something outside the run is rendering, and how long to wait
// for it to stop before the run (and before each page load) goes on marked as contended
const IDLE_THRESHOLD = Number( opt( 'idle-threshold', 15 ) );
const IDLE_WAIT = Number( opt( 'idle-wait', MODE === 'reload' ? 60 : 20 ) );
// (not again before every load when the run already found the GPU busy for a minute)
let idleWaitLoad = Math.min( IDLE_WAIT, 20 );
const DETAIL = flags.has( '--detail' );
const RAW = flags.has( '--raw' );
const FRESH = flags.has( '--fresh' );
// a JPEG of each scene after its measurement, to see what was measured
const SHOTS = flags.has( '--shots' );
const compareIndex = argv.indexOf( '--compare' );
const COMPARE = compareIndex >= 0 ? [ argv[ compareIndex + 1 ], argv[ compareIndex + 2 ] ] : null;
const URL_A = COMPARE ? COMPARE[ 0 ] : positional[ 0 ] ?? 'http://127.0.0.1:5191/';
const sceneNames = ( opt( 'scenes', opt( 'scene', '' ) ) || Object.keys( SCENES ).join( ',' ) ).split( ',' ).map( ( s ) => s.trim() ).filter( Boolean );
for ( const name of sceneNames ) if ( ! SCENES[ name ] ) throw new Error( `unknown scene ${ name } (--list)` );
const stamp = new Date().toISOString().replace( /[:.]/g, '-' ).slice( 0, 19 );
const LABEL = opt( 'label', COMPARE ? `compare-${ stamp }` : TOGGLE ? `toggle-${ stamp }` : `profile-${ stamp }` );
if ( COMPARE && TOGGLE ) throw new Error( '--toggle A/Bs inside one page: give one url, not --compare' );
if ( TOGGLE && MODE === 'reload' ) throw new Error( '--toggle needs --mode page' );
if ( DISPLAY && ( TOGGLE || ACCEPT || SCALES.length || MODE === 'reload' ) ) throw new Error( '--display is for profile runs and --compare in page mode (no --toggle, --accept, --scales or --mode reload)' );
// a headed window takes over the user's screen: only while they allow it (tools/display-gate.mjs)
if ( DISPLAY ) requireDisplayAllowed( 'profile-frame --display' );
if ( ( ACCEPT || SCALES.length ) && ( COMPARE || TOGGLE ) ) throw new Error( '--accept and --scales are for profile runs, not --compare or --toggle' );
// the page reads the first of a repeated option, so a dpr in the url or --q would win over --scales
if ( SCALES.length && [ new URL( URL_A ).search.slice( 1 ), EXTRA_Q ].some( ( q ) => new URLSearchParams( q ).has( 'dpr' ) ) ) throw new Error( '--scales sets the dpr option itself: remove dpr from the url and --q' );
const OUT = opt( 'out', path.join( 'artifacts/perf', LABEL ) );
// The page's remembered dynamic scale (`drsStore`): an A/B (--compare) or an acceptance run turns it
// off (`drsStore=off`), so neither side starts from a scale the other, or an earlier run, settled at;
// `--drs-store` keeps it (`drsStore=on`: restored and saved even in this automated browser).
const DRS_STORE = flags.has( '--drs-store' ) ? 'drsStore=on' : COMPARE || ACCEPT ? 'drsStore=off' : '';

const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.CHROME_PATH || ( existsSync( SYSTEM_CHROME ) ? SYSTEM_CHROME : undefined );
const CHROME_ARGS = DISPLAY ? WINDOW ? [
	// a player's Chrome in a window of its own size, its tab strip and toolbar included
	`--window-size=${ WINDOW.replace( 'x', ',' ) }`, '--window-position=0,0',
] : [
	// a player's Chrome: full screen without its bars (the window's size from the start), its own
	// vsync and timestamp quantisation
	'--kiosk',
] : [
	'--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu',
	// uncapped: the frame interval measures the work, not the display's refresh (--vsync keeps
	// Chrome's 60 Hz pacing instead: the frame interval a player sees)
	...( VSYNC ? [] : [ '--disable-gpu-vsync', '--disable-frame-rate-limit' ] ),
	// unquantised timestamp queries (Chrome rounds them to 100 µs otherwise)
	'--enable-webgpu-developer-features', '--disable-dawn-features=timestamp_quantization',
	'--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
];

// ------------------------------------------------------------------ statistics

const sorted = ( values ) => [ ...values ].sort( ( a, b ) => a - b );
function quantile( values, q ) {

	if ( values.length === 0 ) return NaN;
	const s = sorted( values );
	const i = ( s.length - 1 ) * q, lo = Math.floor( i ), hi = Math.ceil( i );
	return s[ lo ] + ( s[ hi ] - s[ lo ] ) * ( i - lo );

}
const mean = ( values ) => values.length ? values.reduce( ( a, b ) => a + b, 0 ) / values.length : NaN;
const r2 = ( x ) => Number.isFinite( x ) ? Math.round( x * 100 ) / 100 : null;

function summarise( frames ) {

	const intervals = frames.map( ( f ) => f.interval );
	const of = ( key ) => frames.map( ( f ) => f[ key ] ).filter( Number.isFinite );
	const stats = ( values ) => ( { median: r2( quantile( values, 0.5 ) ), mean: r2( mean( values ) ), p95: r2( quantile( values, 0.95 ) ), p99: r2( quantile( values, 0.99 ) ), max: r2( values.length ? Math.max( ...values ) : NaN ) } );
	const groups = new Set( frames.flatMap( ( f ) => Object.keys( f.groups ) ) );
	const timed = frames.filter( ( f ) => f.missing === 0 && f.passes > 0 && Object.keys( f.groups ).length );
	const gpuGroups = {};
	for ( const g of groups ) {

		const all = timed.map( ( f ) => f.groups[ g ] ?? 0 );
		const present = timed.filter( ( f ) => g in f.groups ).map( ( f ) => f.groups[ g ] );
		gpuGroups[ g ] = {
			mean: r2( mean( all ) ), p95: r2( quantile( all, 0.95 ) ), max: r2( Math.max( ...all ) ),
			// work that runs on some frames only (bakes, shadow steps): how often, and its cost then
			share: r2( present.length / timed.length ), perRun: r2( mean( present ) ),
		};

	}
	const order = Object.entries( gpuGroups ).sort( ( a, b ) => b[ 1 ].mean - a[ 1 ].mean );
	const detail = {};
	if ( frames.some( ( f ) => f.detail ) ) {

		const keys = new Set( timed.flatMap( ( f ) => Object.keys( f.detail ?? {} ) ) );
		for ( const k of keys ) detail[ k ] = r2( mean( timed.map( ( f ) => f.detail?.[ k ] ?? 0 ) ) );

	}
	const medians = Object.fromEntries( [ ...groups ].map( ( g ) => [ g, quantile( timed.map( ( f ) => f.groups[ g ] ?? 0 ), 0.5 ) ] ) );
	const jsMedian = quantile( of( 'js' ), 0.5 );
	const intervalMedian = quantile( intervals, 0.5 );
	const gpuIntervals = of( 'gpuInterval' );
	const gpuIntervalMedian = quantile( gpuIntervals, 0.5 );
	// A hitch is a frame over 25 ms that also stands out from its neighbours (1.5 times the median),
	// so a scene that is slow throughout reports its slowness, not every frame as a hitch.
	const HITCH = Math.max( 25, intervalMedian * 1.5 ), GPU_HITCH = Math.max( 25, gpuIntervalMedian * 1.5 );
	// GPU hitches, on the GPU's own timeline: a frame whose work finished long after the previous
	// frame's, by the passes that rose most above their medians in that frame. Exact whatever the
	// queue depth (headless Chrome queues about two dozen frames, so a GPU spike reaches the frame
	// interval that much later).
	// A new pipeline compiles in Chrome's GPU process when first used, not in the JS call that
	// creates it: the GPU then idles until the compile is done.
	const gpuHitches = [];
	frames.forEach( ( f, i ) => {

		if ( ! ( f.gpuInterval > GPU_HITCH ) ) return;
		const rises = Object.entries( f.groups ).map( ( [ g, ms ] ) => [ g, ms - medians[ g ] ] ).filter( ( [ , d ] ) => d > 1 ).sort( ( a, b ) => b[ 1 ] - a[ 1 ] );
		const compiled = frames.slice( Math.max( 0, i - 3 ), i + 1 ).reduce( ( a, w ) => a + w.pipelines, 0 );
		const idle = f.gpu < gpuIntervalMedian * 1.2;
		const cause = idle && compiled > 0 ? 'pipeline compile' : idle ? 'gpu idle (waiting for work)' : rises[ 0 ]?.[ 0 ] ?? 'spread over passes';
		gpuHitches.push( { t: r2( ( f.t - frames[ 0 ].t ) / 1000 ), at: f.t, gpuInterval: r2( f.gpuInterval ), gpu: r2( f.gpu ), cause, pipelines: compiled, rises: rises.slice( 0, 3 ).map( ( [ g, d ] ) => `${ g } +${ r2( d ) }` ) } );

	} );
	// Frame hitches: long rAF intervals. The tick's own work shows in its own frame (new pipelines,
	// a long JS tick), work issued after the previous tick (async bakes) in the next interval; a GPU
	// hitch reaches the interval through the queue up to a few seconds later (the largest one in
	// the 2.5 s before is taken as the cause). A tick held up in one of the queue calls (their time
	// is not JS: a large upload's copy counts there too) names the call; the rest is the browser's
	// pacing.
	const outsideMedian = quantile( of( 'outsideJs' ), 0.5 );
	const CALLS = { submit: 'queue.submit', write: 'queue writes', texture: 'getCurrentTexture' };
	const waitMedians = Object.fromEntries( Object.keys( CALLS ).map( ( k ) => [ k, quantile( frames.map( ( f ) => f.waits?.[ k ] ).filter( Number.isFinite ), 0.5 ) || 0 ] ) );
	const hitches = [];
	frames.forEach( ( f, i ) => {

		if ( f.interval <= HITCH ) return;
		const before = frames[ i - 1 ];
		const outside = before ? before.outsideJs : 0;
		const queued = gpuHitches.filter( ( h ) => h.at <= f.t && h.at > f.t - 2500 ).sort( ( a, b ) => b.gpuInterval - a.gpuInterval )[ 0 ];
		const blocked = Object.keys( CALLS ).map( ( k ) => [ k, ( f.waits?.[ k ] ?? 0 ) - waitMedians[ k ] ] ).sort( ( a, b ) => b[ 1 ] - a[ 1 ] )[ 0 ];
		const cause = f.pipelines > 0 && f.js > jsMedian + 4 ? 'pipeline compile' : f.js > jsMedian + 4 ? 'js tick' :
			outside > outsideMedian + 4 ? 'js after the tick (bakes)' : queued ? `${ queued.cause } (via the queue)` :
				blocked[ 1 ] > 4 ? `blocked in ${ CALLS[ blocked[ 0 ] ] }` : 'pacing';
		hitches.push( { t: r2( ( f.t - frames[ 0 ].t ) / 1000 ), interval: r2( f.interval ), cause, js: r2( f.js ), wait: r2( f.submitWait ), outsideJs: r2( outside ), gap: r2( f.gap ), pipelines: f.pipelines, pipelineMs: r2( f.pipelineMs ) } );

	} );
	const tally = ( list ) => {

		const causes = {};
		for ( const h of list ) causes[ h.cause ] = ( causes[ h.cause ] ?? 0 ) + 1;
		return causes;

	};
	// the render scale the frames were drawn at (a dynamic resolution moves it): its median, range
	// and the changes within the window
	const scales = frames.map( ( f ) => f.scale ).filter( Number.isFinite );
	const renderScale = scales.length ? { median: r2( quantile( scales, 0.5 ) ), min: r2( Math.min( ...scales ) ), max: r2( Math.max( ...scales ) ),
		changes: scales.filter( ( x, i ) => i > 0 && x !== scales[ i - 1 ] ).length } : null;
	return {
		frames: frames.length,
		fps: r2( 1000 / mean( intervals ) ),
		renderScale,
		interval: stats( intervals ),
		over16: r2( intervals.filter( ( x ) => x > 16.7 ).length / intervals.length ),
		over25: r2( intervals.filter( ( x ) => x > 25 ).length / intervals.length ),
		over25Count: intervals.filter( ( x ) => x > 25 ).length,
		// GPU busy time per frame (the passes' charges) and the GPU's own frame-to-frame interval
		gpu: stats( timed.map( ( f ) => f.gpu ) ),
		// the part of it in passes that follow the render's pixel count (the dynamic resolution's
		// split, high only: `PassScaling`)
		...( timed.some( ( f ) => Number.isFinite( f.pixel ) ) ? { gpuPixel: stats( timed.map( ( f ) => f.pixel ).filter( Number.isFinite ) ) } : {} ),
		gpuInterval: stats( gpuIntervals ),
		// the GPU's share of the frame: near 1 the frame is GPU-bound
		gpuShare: r2( mean( timed.map( ( f ) => f.gpu ) ) / mean( intervals ) ),
		span: stats( timed.map( ( f ) => f.span ) ),
		// the tick's own JS work, its wall time and the part of it spent blocked in the queue calls
		// (submit, writeBuffer, getCurrentTexture; by call in `waits`)
		js: stats( of( 'js' ) ),
		jsWall: stats( of( 'jsWall' ) ),
		submitWait: stats( of( 'submitWait' ) ),
		...( frames.some( ( f ) => f.waits ) ? { waits: Object.fromEntries( [ 'submit', 'write', 'texture' ].map( ( k ) => [ k, stats( frames.map( ( f ) => f.waits?.[ k ] ).filter( Number.isFinite ) ) ] ) ) } : {} ),
		// JS of the render and compute calls issued after the tick (the sky's bakes), less their
		// queue waits (`outsideWait`), and the gap between ticks
		outsideJs: stats( of( 'outsideJs' ) ),
		outsideWait: stats( of( 'outsideWait' ) ),
		gap: stats( of( 'gap' ) ),
		calls: Math.round( mean( frames.map( ( f ) => f.calls ) ) ), triangles: Math.round( mean( frames.map( ( f ) => f.triangles ) ) ),
		passes: Math.round( mean( frames.map( ( f ) => f.passes ) ) ),
		timedFrames: timed.length,
		missingPasses: frames.reduce( ( a, f ) => a + f.missing, 0 ),
		pipelinesCreated: frames.reduce( ( a, f ) => a + f.pipelines, 0 ),
		groups: Object.fromEntries( order ),
		...( Object.keys( detail ).length ? { detail: Object.fromEntries( Object.entries( detail ).sort( ( a, b ) => b[ 1 ] - a[ 1 ] ) ) } : {} ),
		hitchThreshold: r2( HITCH ),
		hitches: { count: hitches.length, causes: tally( hitches ), list: hitches.slice( 0, 30 ) },
		gpuHitchThreshold: r2( GPU_HITCH ),
		gpuHitches: { count: gpuHitches.length, causes: tally( gpuHitches ), list: gpuHitches.slice( 0, 30 ).map( ( { at, ...h } ) => h ) },
	};

}

// One slice of a page-mode compare, or one toggle block: GPU figures from `gpuFrames`, frame
// intervals from `intervalFrames` (a toggle drops more of a block's first frames from those).
function sliceStats( gpuFrames, intervalFrames = gpuFrames ) {

	const timed = gpuFrames.filter( ( f ) => f.missing === 0 && f.passes > 0 && Object.keys( f.groups ).length );
	const intervals = intervalFrames.map( ( f ) => f.interval );
	const groups = {};
	for ( const g of new Set( timed.flatMap( ( f ) => Object.keys( f.groups ) ) ) ) groups[ g ] = r2( mean( timed.map( ( f ) => f.groups[ g ] ?? 0 ) ) );
	return {
		frames: intervalFrames.length, gpuFrames: timed.length,
		interval: r2( quantile( intervals, 0.5 ) ), p95: r2( quantile( intervals, 0.95 ) ),
		gpu: r2( mean( timed.map( ( f ) => f.gpu ) ) ), gpuInterval: r2( quantile( timed.map( ( f ) => f.gpuInterval ).filter( Number.isFinite ), 0.5 ) ),
		js: r2( quantile( gpuFrames.map( ( f ) => f.js ).filter( Number.isFinite ), 0.5 ) ), groups,
	};

}

// Student's t at 97.5 % for a 95 % interval
function t95( df ) {

	const table = [ 12.71, 4.3, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23, 2.2, 2.18, 2.16, 2.14, 2.13 ];
	return df < 1 ? NaN : df <= table.length ? table[ df - 1 ] : df <= 30 ? 2.09 : 1.98;

}

// B / A, to three places (null when A is zero)
const ratio = ( a, b ) => Number.isFinite( a ) && Number.isFinite( b ) && a !== 0 ? Math.round( b / a * 1000 ) / 1000 : null;

// The 60 fps criterion for one scene's results (frame intervals from the run without timestamps
// when there was one): median and p95 within TARGET_SLACK of TARGET, no frame over ACCEPT_MAX.
function acceptance( r ) {

	const limit = TARGET + TARGET_SLACK;
	const reasons = [];
	if ( ! ( r.interval.median <= limit ) ) reasons.push( `median ${ r.interval.median }` );
	if ( ! ( r.interval.p95 <= limit ) ) reasons.push( `p95 ${ r.interval.p95 }` );
	if ( r.over25Count > 0 ) reasons.push( `${ r.over25Count } frames over ${ ACCEPT_MAX } ms` );
	const pass = reasons.length === 0, contended = Boolean( r.contended );
	// a contended run's failure proves nothing (see the file's header) unless the scene's own GPU
	// work already takes longer than a frame
	const overBudget = r.gpu?.median > TARGET;
	if ( ! pass && overBudget ) reasons.push( `gpu busy ${ r.gpu.median } over ${ TARGET }` );
	return {
		pass, verdict: pass ? contended ? 'PASS (contended)' : 'PASS' : contended && ! overBudget ? 'INCONCLUSIVE (contended)' : 'FAIL', reasons, target: TARGET, limit: r2( limit ),
		median: r.interval.median, p95: r.interval.p95, p99: r.interval.p99, max: r.interval.max, framesOver25: r.over25Count, frames: r.frames,
		// the GPU's busy time per frame, from the run with timestamps (null without one)
		gpuBusy: r.gpu?.median ?? null, gpuBusyP95: r.gpu?.p95 ?? null, contended,
		// the render scale of the measured frames (and of the run with timestamps), where it moves
		scale: r.renderScale ?? null, scaleWithTimestamps: r.withTimestamps?.renderScale ?? null,
	};

}

// B - A over slices (or blocks): the mean difference, its 95 % interval (Welch) and the larger
// range of either side (the old mode's noise)
function delta( a, b ) {

	a = a.filter( ( x ) => Number.isFinite( x ) );
	b = b.filter( ( x ) => Number.isFinite( x ) );
	if ( ! a.length || ! b.length ) return { a: null, b: null, delta: null, ci: null, noise: null, significant: false };
	const variance = ( v ) => v.length > 1 ? v.reduce( ( s, x ) => s + ( x - mean( v ) ) ** 2, 0 ) / ( v.length - 1 ) : NaN;
	const va = variance( a ) / a.length, vb = variance( b ) / b.length;
	const se = Math.sqrt( va + vb );
	const df = se > 0 ? Math.round( ( va + vb ) ** 2 / ( ( a.length > 1 ? va * va / ( a.length - 1 ) : 0 ) + ( b.length > 1 ? vb * vb / ( b.length - 1 ) : 0 ) ) ) : a.length + b.length - 2;
	const d = mean( b ) - mean( a );
	const ci = t95( Math.max( 1, df ) ) * se;
	const noise = Math.max( Math.max( ...a ) - Math.min( ...a ), Math.max( ...b ) - Math.min( ...b ) );
	return { a: r2( mean( a ) ), b: r2( mean( b ) ), delta: r2( d ), ratio: ratio( mean( a ), mean( b ) ), ci: r2( ci ), noise: r2( noise ), significant: Number.isFinite( ci ) && Math.abs( d ) > ci };

}

// ------------------------------------------------------------------ the page

const sleep = ( ms ) => new Promise( ( resolve ) => setTimeout( resolve, ms ) );

// The run's own idle check (main), taken with the browser already open on a blank page just before
// the first load: it stands for that load's check instead of sampling the same idle GPU again.
let startIdle = null;
function loadIdle( log ) {

	const idle = startIdle;
	startIdle = null;
	return idle ?? waitForIdleGpu( { threshold: IDLE_THRESHOLD, seconds: 2, wait: idleWaitLoad, log } );

}

// the render scale of the run under way (--scales), added to every page's url as `dpr`
let renderScale = null;

function pageUrl( base, q, timestamps ) {

	const url = new URL( base );
	// the url's own options first (the page reads the first of a repeated option), then the
	// scene's; `debug` too, so a build without the profiler still exposes its handles
	// uncapped, the frame pacer would read the work's own intervals as a display's refresh
	url.search = [ url.search.slice( 1 ), HOOKS ? timestamps ? 'profile' : 'profile=frames' : '', 'debug', WORLD_CACHE ? 'worldCache' : 'worldCache=off', `quality=${ QUALITY }`, q, EXTRA_Q, DRS_STORE, renderScale ? `dpr=${ renderScale }` : '', VSYNC ? '' : 'frameRate=0' ].filter( Boolean ).join( '&' );
	return url.href;

}

async function load( page, base, q, timestamps ) {

	const url = pageUrl( base, q, timestamps );
	const started = Date.now();
	await page.goto( url );
	await page.waitForFunction( () => window.__PONLAI__ && window.__THREE_GAME_DIAGNOSTICS__?.frame > 30 &&
		document.getElementById( 'loading' )?.classList.contains( 'done' ), null, { timeout: 180000, polling: 250 } );
	const startup = await page.evaluate( () => {

		if ( ! window.__PONLAI_PROFILE__ ) {

			// A build without the profiler: frame intervals only, from a rAF callback of our own (it
			// runs in the same frames as the page's, so it sees the same intervals; it stops with the
			// page's loop).
			let done = [], last = 0;
			const step = ( time ) => {

				const running = window.__profileTools?.loop.running ?? true;
				if ( last && running ) done.push( { id: 0, t: performance.now(), interval: time - last, js: NaN, jsWall: NaN, submitWait: NaN, outsideJs: NaN, gap: NaN, gpu: NaN, gpuInterval: NaN, span: 0, passes: 0, missing: 0, pipelines: 0, pipelineMs: 0, calls: 0, triangles: 0, groups: {} } );
				last = running ? time : 0;
				requestAnimationFrame( step );

			};
			requestAnimationFrame( step );
			window.__PONLAI_PROFILE__ = {
				reset: () => { done = []; }, take: () => done.splice( 0, done.length ), setDetail: () => {}, setRaw: () => {}, pending: () => 0,
				info: () => ( { timestamps: false, profiler: false, lostPasses: 0, failedPasses: {}, readbackMs: [], marks: {}, startup: { frames: [] } } ),
			};

		}
		const info = window.__PONLAI_PROFILE__.info();
		const d = window.__THREE_GAME_DIAGNOSTICS__;
		return { ...info, diagnostics: { canvas: d.canvas, render: d.render, upscaled: d.upscaled, dpr: d.dpr, canvasDpr: d.canvasDpr, quality: d.quality, timings: d.timings, worldTriangles: d.worldTriangles, worldCache: d.worldCache ?? 'unsupported' } };

	} );
	if ( startup.profiler === false ) console.error( `[profile] ${ base } has no ?profile hooks: frame intervals only` );
	const hooks = await page.evaluate( pageHelpers );
	await page.evaluate( ( { detail, raw } ) => {

		window.__PONLAI_PROFILE__.setDetail( detail );
		window.__PONLAI_PROFILE__.setRaw( raw );

	}, { detail: DETAIL, raw: RAW } );
	return { url, loadMs: Date.now() - started, startup, hooks };

}

// Installed in each page as window.__profileTools: the loop's stop and start, the runtime scene
// switch, the camera views and their motion. Builds without the runtime hooks (establishScene,
// loop) are driven through the handles they do have.
function pageHelpers() {

	const s = window.__PONLAI__;
	const wait = ( ms ) => new Promise( ( resolve ) => setTimeout( resolve, ms ) );
	const animation = s.renderer._animation;
	const loop = s.loop ?? {
		running: true,
		async stop() {

			if ( ! loop.running ) return;
			loop.running = false;
			animation.stop();
			const until = performance.now() + 2000;
			while ( s.sky.busy && performance.now() < until ) await wait( 10 );
			await s.renderer.backend.device.queue.onSubmittedWorkDone();

		},
		start() {

			if ( loop.running ) return;
			loop.running = true;
			animation.start();

		},
	};
	let motion = null;
	const tools = {
		loop,
		// the scene's URL options at runtime: the weather established at once (as weather= loads
		// it: no front, the ground wet in rain), the time preset or hour, the clock from 0
		async establish( q ) {

			const p = new URLSearchParams( q );
			const t0 = performance.now();
			const name = p.get( 'weather' ) ?? undefined, preset = p.get( 'preset' ) ?? undefined;
			const hour = p.has( 'hour' ) ? Number( p.get( 'hour' ) ) : undefined;
			if ( s.establishScene ) {

				await s.establishScene( { weather: name, preset, hour, time: 0 } );

			} else {

				// older builds: the same through their handles, also with one bake
				const w = s.weather;
				if ( name ) {

					w.auto = false;
					w.setWeather( name, 0 );
					w.from = { ...w.destination };
					w.dwell = 0;
					const state = w.state;
					state.wetness = state.rain * 0.8;
					state.showers = state.rain;

				}
				if ( preset ) s.dayCycle.setPreset( preset );
				else if ( hour !== undefined ) s.dayCycle.setHour( hour );
				await s.setTime( 0 );
				// setTime integrated the wind at the previous sky's speed
				s.wind.reset( { speed: s.sky.weather.windSpeed, heading: s.sky.weather.windDirection, time: s.wind.time } );

			}
			return performance.now() - t0;

		},
		place( def ) {

			if ( def.view === 'meadow' ) {

				// a point on the meadow 5.5 m inside the rim, out from the land's centroid (so any land
				// works), the eye 1.6 m up, looking out over the lip and down a little. The heights are
				// those of the island group's meshes (`island`), on a 0.5 m grid from their box's corner
				// as the camera's ground was built before it came from the chunks' grids: a build that
				// draws the same island, merged or a mesh per chunk, takes the same view.
				s.setCameraView( 'island' );
				s.setCameraMode( 'free' );
				const parts = [];
				s.scene.getObjectByName( 'island' ).traverse( ( o ) => { if ( o.isMesh ) parts.push( o.geometry.getAttribute( 'position' ).array ); } );
				let x0 = Infinity, z0 = Infinity, x1 = - Infinity, z1 = - Infinity;
				for ( const p of parts ) for ( let v = 0; v < p.length; v += 3 ) {

					x0 = Math.min( x0, p[ v ] ); x1 = Math.max( x1, p[ v ] );
					z0 = Math.min( z0, p[ v + 2 ] ); z1 = Math.max( z1, p[ v + 2 ] );

				}
				const nx = Math.ceil( ( x1 - x0 ) / 0.5 ) + 1, nz = Math.ceil( ( z1 - z0 ) / 0.5 ) + 1;
				const heights = new Float32Array( nx * nz ).fill( - Infinity );
				const cell = ( x, z ) => {

					const i = Math.floor( ( x - x0 ) / 0.5 ), j = Math.floor( ( z - z0 ) / 0.5 );
					return i >= 0 && i < nx && j >= 0 && j < nz ? j * nx + i : - 1;

				};
				for ( const p of parts ) for ( let v = 0; v < p.length; v += 3 ) {

					const k = cell( p[ v ], p[ v + 2 ] );
					if ( k >= 0 && p[ v + 1 ] > heights[ k ] ) heights[ k ] = p[ v + 1 ];

				}
				const heightAt = ( x, z ) => {

					const k = cell( x, z );
					return k >= 0 ? Math.max( heights[ k ], 0 ) : 0;

				};
				const { x: cx, z: cz } = s.land.centroid, dir = { x: Math.cos( 0.7 ), z: Math.sin( 0.7 ) };
				const top = ( t ) => heightAt( cx + dir.x * t, cz + dir.z * t ) > 1;
				let t = 0;
				while ( ! top( t ) && t < 200 ) t += 0.25;
				while ( top( t ) ) t += 0.25;
				const x = cx + dir.x * ( t - 5.5 ), z = cz + dir.z * ( t - 5.5 );
				s.camera.position.set( x, heightAt( x, z ) + 1.6, z );
				s.camera.lookAt( s.camera.position.x + dir.x * 10, s.camera.position.y - 2.2, s.camera.position.z + dir.z * 10 );
				s.camera.fov = 55;
				s.camera.updateProjectionMatrix();

			} else {

				if ( s.cameraSettings.mode !== 'orbit' ) s.setCameraMode( 'orbit' );
				s.setCameraView( def.view );
				if ( def.faceSun ) {

					// orbit to the island's far side from the sun: the view looks into the low sun
					const t = s.controls.target, p = s.camera.position, sun = s.sky.sunDir;
					const dx = p.x - t.x, dz = p.z - t.z, r = Math.hypot( dx, dz ), len = Math.hypot( sun.x, sun.z ) || 1;
					p.x = t.x - sun.x / len * r;
					p.z = t.z - sun.z / len * r;
					s.camera.lookAt( t );
					s.controls.update();

				}

			}

		},
		// the slow orbit of play: about the target, or in place for the sky and meadow views; it
		// waits while the loop is stopped, so two pages see the same views in their slices
		startMotion( def, orbit ) {

			tools.stopMotion();
			let last = performance.now(), on = true;
			const inPlace = def.view === 'sky' || def.view === 'meadow';
			const step = ( now ) => {

				if ( ! on ) return;
				const a = loop.running ? orbit * Math.PI / 180 * Math.min( ( now - last ) / 1000, 0.1 ) : 0;
				last = now;
				const c = Math.cos( a ), si = Math.sin( a );
				if ( inPlace && s.cameraSettings.mode === 'free' ) {

					s.camera.rotateOnWorldAxis( s.camera.up.clone().set( 0, 1, 0 ), a );

				} else {

					const pivot = inPlace ? s.camera.position : s.controls.target;
					const moved = inPlace ? s.controls.target : s.camera.position;
					const x = moved.x - pivot.x, z = moved.z - pivot.z;
					moved.x = pivot.x + x * c - z * si;
					moved.z = pivot.z + x * si + z * c;

				}
				requestAnimationFrame( step );

			};
			requestAnimationFrame( step );
			motion = { stop: () => { on = false; } };

		},
		stopMotion() {

			motion?.stop();
			motion = null;

		},
	};
	window.__profileTools = tools;
	return { establishScene: Boolean( s.establishScene ), loop: Boolean( s.loop ), flags: Boolean( s.flags ) };

}

async function gpuInfo( page ) {

	return page.evaluate( async () => {

		const a = await navigator.gpu?.requestAdapter( { powerPreference: 'high-performance' } );
		if ( ! a ) return null;
		const { vendor, architecture, device, description } = a.info ?? {};
		return { vendor, architecture, device, description, timestampQuery: a.features.has( 'timestamp-query' ) };

	} );

}

// Sets a scene up: (page modes) its weather, time and clock at runtime, then the camera, the
// ablation and the motion. Returns the switch's time and the page time it was done.
async function prepare( page, scene, evalJs, establish ) {

	return page.evaluate( async ( { def, orbit, evalJs, establish } ) => {

		const T = window.__profileTools;
		T.stopMotion();
		const switchMs = establish ? await T.establish( def.q ) : 0;
		T.place( def );
		if ( evalJs ) ( 0, eval )( `( ( s ) => { ${ evalJs } } )` )( window.__PONLAI__ );
		T.startMotion( def, orbit );
		return { switchMs, t: performance.now() };

	}, { def: SCENES[ scene ], orbit: MOTION === 'orbit' ? ORBIT : 0, evalJs, establish } );

}

// Every finished frame of a page, pulled as it arrives (the GPU timestamps read back a few frames
// late) and sorted into measuring windows afterwards by the page's own clock.
class Frames {

	constructor( page ) {

		this.page = page;
		this.all = [];

	}

	async pull() {

		const fresh = await this.page.evaluate( () => window.__PONLAI_PROFILE__.take() );
		for ( const f of fresh ) this.all.push( f );
		return fresh;

	}

	// waits until every frame started before `t1` has its timestamps, then pulls them
	async settle( t1 ) {

		await this.page.waitForFunction( ( t1 ) => window.__PONLAI_PROFILE__.pending( t1 ) === 0, t1, { timeout: 6000, polling: 50 } ).catch( () => {} );
		await this.pull();

	}

	in( t0, t1 ) {

		return this.all.filter( ( f ) => f.t >= t0 && f.t < t1 );

	}

	now() {

		return this.page.evaluate( () => performance.now() );

	}

}

// Warm-up after a switch: at least `seconds`, then until a second of frames passed without a new
// pipeline (at most 20 s). Reports what compiled: pipelines, their JS time, when the last one was
// created and the longest frame meanwhile.
async function warm( frames, since, seconds ) {

	const list = Array.isArray( frames ) ? frames : [ frames ];
	const started = Date.now();
	for ( ;; ) {

		await sleep( 250 );
		await Promise.all( list.map( ( f ) => f.pull() ) );
		const elapsed = ( Date.now() - started ) / 1000;
		const quiet = list.every( ( f, i ) => {

			const after = f.all.filter( ( x ) => x.t >= since[ i ] );
			const latest = after.length ? after[ after.length - 1 ].t : - Infinity;
			const compiled = after.filter( ( x ) => x.pipelines > 0 );
			const last = compiled.length ? compiled[ compiled.length - 1 ].t : since[ i ];
			return latest - last >= 1000;

		} );
		if ( elapsed >= 20 || ( elapsed >= seconds && quiet ) ) break;

	}
	return list.map( ( f, i ) => {

		const after = f.all.filter( ( x ) => x.t >= since[ i ] );
		const compiled = after.filter( ( x ) => x.pipelines > 0 );
		return {
			seconds: r2( ( Date.now() - started ) / 1000 ), pipelines: compiled.reduce( ( a, x ) => a + x.pipelines, 0 ), pipelineMs: r2( compiled.reduce( ( a, x ) => a + x.pipelineMs, 0 ) ),
			lastCompileMs: compiled.length ? r2( compiled[ compiled.length - 1 ].t - since[ i ] ) : 0, worstFrameMs: r2( Math.max( 0, ...after.map( ( x ) => x.interval ) ) ),
		};

	} );

}

// Waits until the page's dynamic render scale has held for SCALE_SETTLE seconds; returns the
// seconds waited and the scale it holds (null without a dynamic scale).
async function settleScale( page ) {

	// (the quiet time counts from the switch at the earliest: the scale may not have moved yet)
	const started = Date.now();
	for ( ;; ) {

		const state = await page.evaluate( () => {

			const d = window.__PONLAI__?.dynamicResolution;
			if ( ! d ) return null;
			const last = d.changes.length ? d.changes[ d.changes.length - 1 ].at : - Infinity;
			return { scale: d.scale, quiet: performance.now() / 1000 - last };

		} );
		const waited = ( Date.now() - started ) / 1000;
		if ( ! state ) return null;
		if ( Math.min( state.quiet, waited ) >= SCALE_SETTLE || waited >= 60 ) return { seconds: r2( waited ), scale: state.scale };
		await sleep( 250 );

	}

}

async function measure( page, scene ) {

	const def = SCENES[ scene ];
	await page.waitForTimeout( WARMUP * 1000 );
	const t0 = await page.evaluate( ( { change } ) => {

		window.__PONLAI_PROFILE__.reset();
		if ( change ) window.__PONLAI__.setWeather( change.weather, change.seconds );
		return performance.now();

	}, { change: def.change ?? null } );
	// the GPU's utilisation while measuring: near 100 % the scene keeps it saturated
	const [ utilisation ] = await Promise.all( [ sampleGpuUtilisation( Math.max( SECONDS - 0.5, 0.5 ) ), page.waitForTimeout( SECONDS * 1000 ) ] );
	const t1 = await page.evaluate( () => performance.now() );
	// the last frames' timestamps arrive a few frames later
	await page.waitForFunction( ( t1 ) => window.__PONLAI_PROFILE__.pending( t1 ) === 0, t1, { timeout: 6000, polling: 50 } ).catch( () => {} );
	const frames = ( await page.evaluate( () => window.__PONLAI_PROFILE__.take() ) ).filter( ( f ) => f.t >= t0 && f.t < t1 );
	const info = await page.evaluate( () => {

		window.__profileTools.stopMotion();
		const { lostPasses, failedPasses, readbackMs } = window.__PONLAI_PROFILE__.info();
		return { lostPasses, failedPasses, readbackMs };

	} );
	return { frames, info: { ...info, utilisation } };

}

// ------------------------------------------------------------------ display mode

// The real display (--display): the frames the compositor presented, from a trace of Chrome's
// frame pipeline (each PipelineReporter frame the page's renderer presented, at its presentation
// time), and an in-page sampler of every animation frame (its vblank time, whether the scene
// rendered in it, the camera's heading), started for one measuring window.
async function startDisplay( page ) {

	const cdp = await page.context().newCDPSession( page );
	const events = [];
	cdp.on( 'Tracing.dataCollected', ( e ) => { for ( const x of e.value ) if ( x.name === 'PipelineReporter' || x.name === 'ponlai-display-sync' ) events.push( x ); } );
	const done = new Promise( ( resolve ) => cdp.once( 'Tracing.tracingComplete', resolve ) );
	await cdp.send( 'Tracing.start', { traceConfig: { includedCategories: [ 'cc', 'benchmark', 'disabled-by-default-devtools.timeline.frame', 'blink.user_timing' ] } } );
	// the trace's clock against the page's: a mark seen by both
	const sync = await page.evaluate( () => {

		const s = window.__PONLAI__;
		const dir = s.camera.getWorldDirection( s.camera.position.clone() );
		const samples = window.__displaySamples = [];
		let on = true;
		window.__displayStop = () => { on = false; return samples; };
		// registered after the page's loop, so it runs after the tick in each frame
		const step = ( time ) => {

			if ( ! on ) return;
			s.camera.getWorldDirection( dir );
			samples.push( [ time, s.renderer.info.render.calls, Math.atan2( dir.x, dir.z ), s.camera.position.x, s.camera.position.z ] );
			requestAnimationFrame( step );

		};
		requestAnimationFrame( step );
		performance.mark( 'ponlai-display-sync' );
		return performance.now();

	} );
	return {
		async stop( t0, t1 ) {

			const samples = await page.evaluate( () => window.__displayStop() );
			const pacing = await page.evaluate( () => window.__THREE_GAME_DIAGNOSTICS__?.pacing ?? null );
			await cdp.send( 'Tracing.end' );
			await done;
			await cdp.detach();
			return displayStats( events, sync, samples, pacing, t0, t1 );

		},
	};

}

// The camera dragged as a player drags it: through Chrome's input (CDP mouse events, dispatched
// once per display refresh as real ones are), turning drags of 30 to 200 degrees a second with
// pauses, a wheel zoom in and out and a flick it glides on from, repeated until `seconds` have
// passed.
async function driveUser( page, seconds ) {

	// the island camera turns with the right button, by its turn per window height dragged, and
	// zooms by its own step a wheel notch; older builds' OrbitControls with the left, a full circle
	// per window height, 5 % a notch. The zoom takes the notches that make the same 0.95^8.
	const view = await page.evaluate( () => {

		const c = window.__PONLAI__.controls, island = c.isIslandCamera === true;
		return { w: innerWidth, h: innerHeight, button: island ? 'right' : 'left', perHeight: island ? c.turnPerHeight * 180 / Math.PI : 360,
			notches: island ? Math.max( 1, Math.round( - 8 * Math.log( 0.95 ) / c.wheelZoom ) ) : 8 };

	} );
	const cx = view.w * 0.45, cy = view.h / 2;
	const pxPerDeg = view.h / view.perHeight;
	const end = Date.now() + seconds * 1000;
	const left = () => end - Date.now();
	const pause = ( s ) => sleep( Math.max( Math.min( s * 1000, left() ), 0 ) );
	const drag = async ( degX, degY, s ) => {

		if ( left() <= 0 ) return;
		s = Math.min( s, left() / 1000 );
		const dx = degX * pxPerDeg * s, dy = degY * pxPerDeg * s;
		// starting where the whole drag fits, clear of the GUI's corner
		const x0 = Math.min( Math.max( cx - dx / 2, 40 ), view.w * 0.75 ), y0 = Math.min( Math.max( cy - dy / 2, 40 ), view.h - 40 );
		await page.mouse.move( x0, y0 );
		await page.mouse.down( { button: view.button } );
		const started = Date.now();
		for ( ;; ) {

			const f = Math.min( ( Date.now() - started ) / 1000 / s, 1 );
			await page.mouse.move( x0 + dx * f, y0 + dy * f );
			if ( f >= 1 ) break;
			await sleep( 4 );

		}
		await page.mouse.up( { button: view.button } );

	};
	const wheel = async ( notches, s, dir ) => {

		await page.mouse.move( cx, cy );
		for ( let i = 0; i < notches && left() > 0; i ++ ) {

			await page.mouse.wheel( 0, dir * 100 );
			await sleep( s * 1000 / notches );

		}

	};
	while ( left() > 0 ) {

		await pause( 0.6 );
		await drag( - 60, 0, 2 );
		await pause( 0.6 );
		await drag( 120, 0, 1.5 );
		await pause( 0.5 );
		await drag( 0, 30, 1 );
		await drag( - 90, - 10, 1.5 );
		await pause( 0.8 );
		await wheel( view.notches, 1, - 1 );
		await pause( 0.4 );
		await wheel( view.notches, 1, 1 );
		await drag( 90, 0, 2 );
		await pause( 0.8 );
		await drag( - 200, 0, 0.4 );
		await pause( 1.5 );

	}

}

const r3 = ( x ) => Number.isFinite( x ) ? Math.round( x * 1000 ) / 1000 : null;

// Intervals by display refreshes (1, 2, 3, 4 or more), as shares; and the share of intervals that
// differ from the one before by half a refresh or more (the cadence changing: judder)
function cadence( intervals, refresh ) {

	const counts = { 1: 0, 2: 0, 3: 0, '4+': 0 };
	for ( const x of intervals ) {

		const n = Math.max( 1, Math.round( x / refresh ) );
		counts[ n >= 4 ? '4+' : n ] ++;

	}
	let changes = 0;
	for ( let i = 1; i < intervals.length; i ++ ) if ( Math.abs( intervals[ i ] - intervals[ i - 1 ] ) >= refresh * 0.5 ) changes ++;
	return {
		frames: intervals.length + 1, refreshes: Object.fromEntries( Object.entries( counts ).map( ( [ k, v ] ) => [ k, r3( v / Math.max( intervals.length, 1 ) ) ] ) ),
		cadenceChanges: r3( changes / Math.max( intervals.length - 1, 1 ) ), median: r2( quantile( intervals, 0.5 ) ), max: r2( intervals.length ? Math.max( ...intervals ) : NaN ),
	};

}

function displayStats( events, sync, samples, pacing, t0, t1 ) {

	// the refresh period: the pacer's measure, else the median of the shortest vblank intervals
	const vblanks = samples.slice( 1 ).map( ( k, i ) => k[ 0 ] - samples[ i ][ 0 ] ).filter( ( x ) => x > 2 && x < 50 );
	const low = quantile( vblanks, 0.05 );
	const refresh = pacing?.refreshMs ?? quantile( vblanks.filter( ( x ) => x < low * 1.5 ), 0.5 );
	// rendered frames: the animation frames in which the scene drew
	const rendered = samples.filter( ( k, i ) => i > 0 && k[ 1 ] !== samples[ i - 1 ][ 1 ] && k[ 0 ] >= t0 && k[ 0 ] < t1 );
	const renderedIntervals = rendered.slice( 1 ).map( ( k, i ) => k[ 0 ] - rendered[ i ][ 0 ] );
	// the camera's turning speed from one rendered frame to the next (frames turning at 20 deg/s or
	// more): a steady drag should turn it by the same amount per unit of time
	const speeds = [];
	for ( let i = 1; i < rendered.length; i ++ ) {

		let d = rendered[ i ][ 2 ] - rendered[ i - 1 ][ 2 ];
		if ( d > Math.PI ) d -= 2 * Math.PI;
		if ( d < - Math.PI ) d += 2 * Math.PI;
		speeds.push( d * 180 / Math.PI / ( ( rendered[ i ][ 0 ] - rendered[ i - 1 ][ 0 ] ) / 1000 ) );

	}
	const changes = [];
	for ( let i = 1; i < speeds.length; i ++ ) {

		const a = speeds[ i - 1 ], b = speeds[ i ];
		if ( Math.abs( a ) < 20 || Math.abs( b ) < 20 || Math.sign( a ) !== Math.sign( b ) ) continue;
		changes.push( Math.abs( b - a ) / ( ( Math.abs( a ) + Math.abs( b ) ) / 2 ) );

	}
	// presented frames: the renderer's (the process with most main-thread frames) presented ones,
	// at their presentation, within the window (by the sync mark)
	const mark = events.find( ( e ) => e.name === 'ponlai-display-sync' );
	const offset = mark ? mark.ts / 1000 - sync : NaN;
	const begins = new Map(), frames = [];
	for ( const e of events ) {

		if ( e.name !== 'PipelineReporter' ) continue;
		const key = `${ e.pid }:${ e.id2?.local ?? e.id }`;
		if ( e.ph === 'b' ) begins.set( key, e );
		else if ( e.ph === 'e' && begins.has( key ) ) {

			const b = begins.get( key );
			begins.delete( key );
			frames.push( { pid: e.pid, end: e.ts / 1000 - offset, fr: b.args?.frame_reporter ?? {} } );

		}

	}
	const byPid = {};
	for ( const f of frames ) if ( f.fr.has_main_animation ) byPid[ f.pid ] = ( byPid[ f.pid ] ?? 0 ) + 1;
	const pid = Number( Object.entries( byPid ).sort( ( a, b ) => b[ 1 ] - a[ 1 ] )[ 0 ]?.[ 0 ] );
	const shown = [ ...new Set( frames.filter( ( f ) => f.pid === pid && f.fr.has_main_animation && /PRESENTED/.test( f.fr.state ?? '' ) && f.end >= t0 && f.end < t1 )
		.map( ( f ) => Math.round( f.end * 10 ) / 10 ) ) ].sort( ( a, b ) => a - b );
	const presentedIntervals = shown.slice( 1 ).map( ( t, i ) => t - shown[ i ] ).filter( ( x ) => x > 1 );
	return {
		refresh: r2( refresh ), pacing,
		rendered: cadence( renderedIntervals, refresh ),
		presented: Number.isFinite( offset ) && shown.length > 1 ? cadence( presentedIntervals, refresh ) : null,
		camera: { frames: changes.length, median: r3( quantile( changes, 0.5 ) ), p90: r3( quantile( changes, 0.9 ) ), p99: r3( quantile( changes, 0.99 ) ), over25: r3( changes.filter( ( x ) => x > 0.25 ).length / Math.max( changes.length, 1 ) ) },
	};

}

// One page's display figures over its slices of a scene (--display --compare): the shares weighted
// by each slice's intervals, the longest interval of any
function poolDisplay( list ) {

	const pool = ( key ) => {

		const parts = list.map( ( d ) => d[ key ] ).filter( Boolean );
		if ( ! parts.length ) return null;
		const n = parts.reduce( ( a, c ) => a + Math.max( c.frames - 1, 0 ), 0 ) || 1;
		const share = ( f ) => r3( parts.reduce( ( a, c ) => a + f( c ) * Math.max( c.frames - 1, 0 ), 0 ) / n );
		return {
			frames: parts.reduce( ( a, c ) => a + c.frames, 0 ), refreshes: Object.fromEntries( Object.keys( parts[ 0 ].refreshes ).map( ( k ) => [ k, share( ( c ) => c.refreshes[ k ] ?? 0 ) ] ) ),
			cadenceChanges: share( ( c ) => c.cadenceChanges ?? 0 ), median: r2( quantile( parts.map( ( c ) => c.median ), 0.5 ) ), max: r2( Math.max( ...parts.map( ( c ) => c.max ) ) ),
		};

	};
	const cams = list.map( ( d ) => d.camera ).filter( ( c ) => c.frames > 0 );
	const camN = cams.reduce( ( a, c ) => a + c.frames, 0 ) || 1;
	const cam = ( k ) => r3( cams.reduce( ( a, c ) => a + ( c[ k ] ?? 0 ) * c.frames, 0 ) / camN );
	return {
		refresh: r2( quantile( list.map( ( d ) => d.refresh ), 0.5 ) ), pacing: list[ list.length - 1 ].pacing, slices: list.length,
		rendered: pool( 'rendered' ), presented: pool( 'presented' ),
		camera: { frames: cams.reduce( ( a, c ) => a + c.frames, 0 ), median: cam( 'median' ), p90: cam( 'p90' ), over25: cam( 'over25' ) },
	};

}

// The share of a display slice's intervals longer than the pace (the compositor's presented
// frames, else the rendered ones): the late frames. The pace is the frame pacer's divisor of the
// refresh (2 for 60 fps on a 120 Hz display), one refresh without a pacer.
const lateShare = ( d ) => {

	const c = d?.presented ?? d?.rendered;
	if ( ! c ) return NaN;
	const pace = d.pacing?.divisor ?? 1;
	return Object.entries( c.refreshes ).reduce( ( a, [ k, v ] ) => a + ( ( k === '4+' ? 4 : Number( k ) ) > pace ? v : 0 ), 0 );

};

const pct = ( x ) => Number.isFinite( x ) ? `${ Math.round( x * 1000 ) / 10 } %` : '–';
const refreshText = ( c ) => c ? Object.entries( c.refreshes ).map( ( [ k, v ] ) => `${ k }: ${ pct( v ) }` ).join( ', ' ) : '–';
const displayLog = ( scene, d ) => `${ scene.padEnd( 20 ) } display ${ d.refresh } ms refresh${ d.pacing ? `, paced to ${ d.pacing.divisor } (target ${ d.pacing.target })` : '' }: rendered ${ refreshText( d.rendered ) } (cadence changes ${ pct( d.rendered.cadenceChanges ) }); ` +
	`presented ${ refreshText( d.presented ) } (cadence changes ${ pct( d.presented?.cadenceChanges ) }, max ${ d.presented?.max ?? '–' } ms); camera speed change per frame median ${ pct( d.camera.median ) }, p90 ${ pct( d.camera.p90 ) }, over 25 % ${ pct( d.camera.over25 ) }`;

function plan( names ) {

	// page loads: scenes sharing a query share a load (a weather change last), unless --fresh
	const loads = [];
	for ( const name of names ) {

		const q = SCENES[ name ].q;
		const load = ! FRESH && loads.find( ( l ) => l.q === q && ! l.scenes.some( ( s ) => SCENES[ s ].change ) );
		if ( load ) load.scenes.push( name );
		else loads.push( { q, scenes: [ name ] } );

	}
	for ( const l of loads ) l.scenes.sort( ( a, b ) => ( SCENES[ a ].change ? 1 : 0 ) - ( SCENES[ b ].change ? 1 : 0 ) );
	return loads;

}

const scaleText = ( s ) => s ? s.min === s.max ? `${ s.median }` : `${ s.median } (${ s.min }-${ s.max }, ${ s.changes } changes)` : '–';
const sceneLog = ( scene, r, extra = '' ) => `${ scene.padEnd( 20 ) } ${ extra }scale ${ scaleText( r.renderScale ) }  ${ VSYNC ? `>25 ms ${ r.over25Count }  max ${ r.interval.max }  ` : '' }median ${ r.interval.median } p95 ${ r.interval.p95 } p99 ${ r.interval.p99 } ms  gpu busy ${ r.gpu.median } (gpu interval ${ r.gpuInterval.median } p95 ${ r.gpuInterval.p95 })  js ${ r.js.median } (+ ${ r.submitWait.median } blocked)  frames ${ r.frames }  hitches ${ r.hitches.count } / gpu ${ r.gpuHitches.count }  missing ${ r.missingPasses }  top ${ topGroups( r, 3 ) }`;

// reload mode: a fresh page load per group of scenes
async function runVariant( page, base, evalJs, log, groups = plan( sceneNames ), shotSuffix = '', timestamps = TIMESTAMP_MODE !== 'off' ) {

	const results = {};
	const loads = [];
	for ( const group of groups ) {

		// between page loads the GPU should be idle: anything rendering now is outside this run (the
		// first load's page is blank already)
		if ( ! startIdle ) {

			await page.goto( 'about:blank' );
			await page.waitForTimeout( 1000 );

		}
		const gpuIdle = await loadIdle( log );
		const loaded = await load( page, base, SCENES[ group.scenes[ 0 ] ].q, timestamps );
		loads.push( { scenes: group.scenes, loadMs: loaded.loadMs, url: loaded.url, gpuIdle, startup: loaded.startup } );
		const entry = loads[ loads.length - 1 ];
		for ( const scene of group.scenes ) {

			await prepare( page, scene, evalJs, false );
			const { frames, info } = await measure( page, scene );
			if ( SHOTS ) await page.screenshot( { path: path.join( OUT, `${ scene }${ shotSuffix }.jpg` ), type: 'jpeg', quality: 70, scale: 'css' } );
			results[ scene ] = { ...summarise( frames ), profiler: info, gpuIdle: gpuIdle.idle?.mean ?? null, contended: gpuIdle.contended };
			if ( RAW ) results[ scene ].raw = frames;
			log( sceneLog( scene, results[ scene ], `[gpu ${ info.utilisation?.mean ?? '?' } %] ` ) );

		}
		// the startup frames' GPU completions arrive late with a deep queue: read them again now
		if ( entry.startup ) entry.startup.startup = await page.evaluate( () => window.__PONLAI_PROFILE__.info().startup );

	}
	return { scenes: results, loads };

}

// page mode: one load, every scene switched at runtime
async function runPage( page, base, evalJs, log, names = sceneNames, shotSuffix = '', timestamps = TIMESTAMP_MODE !== 'off' ) {

	await page.goto( 'about:blank' );
	const gpuIdle = await loadIdle( log );
	const loaded = await load( page, base, SCENES[ names[ 0 ] ].q, timestamps );
	log( `loaded ${ loaded.url } in ${ ( loaded.loadMs / 1000 ).toFixed( 1 ) } s (world cache ${ JSON.stringify( loaded.startup.diagnostics.worldCache ) })` );
	const frames = new Frames( page );
	const windows = [];
	for ( const scene of names ) {

		const def = SCENES[ scene ];
		const { switchMs, t } = await prepare( page, scene, evalJs, true );
		const compile = ( await warm( frames, [ t ], WARMUP ) )[ 0 ];
		if ( SCALE_SETTLE > 0 ) compile.scaleSettle = await settleScale( page );
		const display = DISPLAY ? await startDisplay( page ) : null;
		const t0 = await page.evaluate( ( { change } ) => {

			if ( change ) window.__PONLAI__.setWeather( change.weather, change.seconds );
			return performance.now();

		}, { change: def.change ?? null } );
		const [ utilisation ] = await Promise.all( [ sampleGpuUtilisation( Math.max( SECONDS - 0.5, 0.5 ) ), MOTION === 'user' ? driveUser( page, SECONDS ) : sleep( SECONDS * 1000 ) ] );
		const t1 = await frames.now();
		const displayed = display ? await display.stop( t0, t1 ) : undefined;
		if ( SHOTS ) await page.screenshot( { path: path.join( OUT, `${ scene }${ shotSuffix }.jpg` ), type: 'jpeg', quality: 70, scale: 'css' } );
		windows.push( { scene, t0, t1, switch: { ms: r2( switchMs ), ...compile }, utilisation, display: displayed } );
		log( `${ scene.padEnd( 20 ) } switched in ${ Math.round( switchMs ) } ms, warmed ${ compile.seconds } s (${ compile.pipelines } pipelines, ${ compile.pipelineMs } ms JS, last ${ compile.lastCompileMs } ms after the switch)${ compile.scaleSettle ? `, scale settled at ${ compile.scaleSettle.scale } after ${ compile.scaleSettle.seconds } s more` : '' }` );

	}
	await frames.settle( windows[ windows.length - 1 ].t1 );
	const info = await page.evaluate( () => {

		window.__profileTools.stopMotion();
		const { lostPasses, failedPasses, readbackMs } = window.__PONLAI_PROFILE__.info();
		return { lostPasses, failedPasses, readbackMs };

	} );
	const results = {};
	for ( const w of windows ) {

		const list = frames.in( w.t0, w.t1 );
		results[ w.scene ] = { ...summarise( list ), profiler: { ...info, utilisation: w.utilisation }, switch: w.switch, gpuIdle: gpuIdle.idle?.mean ?? null, contended: gpuIdle.contended };
		if ( w.display ) results[ w.scene ].display = w.display;
		if ( RAW ) results[ w.scene ].raw = list;
		log( sceneLog( w.scene, results[ w.scene ], `[gpu ${ w.utilisation?.mean ?? '?' } %] ` ) );
		if ( w.display ) log( displayLog( w.scene, w.display ) );

	}
	loaded.startup.startup = await page.evaluate( () => window.__PONLAI_PROFILE__.info().startup );
	return { scenes: results, loads: [ { scenes: names, loadMs: loaded.loadMs, url: loaded.url, gpuIdle, startup: loaded.startup, hooks: loaded.hooks } ] };

}

// The page (A or B) each browser page of an A/B shows, to name it on its errors
const pageNames = new WeakMap();

// compare in page mode: A and B in two pages of one browser, measured in alternating slices with
// the other page stopped. Returns each variant's slices per scene and its frames pooled.
async function runPair( context, bases, evals, log, names = sceneNames, timestamps = TIMESTAMP_MODE !== 'off' ) {

	const pages = [ context.pages()[ 0 ] ?? await context.newPage() ];
	pages.push( await context.newPage() );
	pages.forEach( ( p, v ) => pageNames.set( p, 'AB'[ v ] ) );
	for ( const p of pages ) await p.goto( 'about:blank' );
	const gpuIdle = await loadIdle( log );
	// one after the other (a page running starves the other's queue), each stopped once loaded
	const loaded = [];
	for ( const v of [ 0, 1 ] ) {

		if ( DISPLAY ) await pages[ v ].bringToFront();
		loaded[ v ] = await load( pages[ v ], bases[ v ], SCENES[ names[ 0 ] ].q, timestamps );
		log( `${ 'AB'[ v ] } loaded ${ loaded[ v ].url } in ${ ( loaded[ v ].loadMs / 1000 ).toFixed( 1 ) } s (world cache ${ JSON.stringify( loaded[ v ].startup.diagnostics.worldCache ) }; runtime hooks ${ JSON.stringify( loaded[ v ].hooks ) })` );
		if ( v === 0 ) await pages[ 0 ].evaluate( () => window.__profileTools.loop.stop() );

	}
	const frames = pages.map( ( p ) => new Frames( p ) );
	// the page's time the loop stood still from (after a stop drained) or until (before a start,
	// which runs its first frame at once)
	const loop = ( v, action ) => pages[ v ].evaluate( async ( action ) => {

		const before = performance.now();
		await window.__profileTools.loop[ action ]();
		return action === 'start' ? before : performance.now();

	}, action );
	// per variant: its slices' windows, and the times it stood stopped (to check it drew nothing).
	// One page runs at a time: Chrome let one page's frames starve the other's queue, so a page is
	// stopped and drained before the other starts.
	const windows = [ [], [] ], stopped = [ [], [] ], switches = {};
	let active = null;
	const run = async ( v ) => {

		if ( active === v ) return;
		if ( active !== null ) stopped[ active ].push( { from: await loop( active, 'stop' ) } );
		// headed, a background tab gets no animation frames: the running page is the one in front
		// (the page hides and shows itself without restarting a loop stopped here)
		if ( DISPLAY ) await pages[ v ].bringToFront();
		const started = await loop( v, 'start' );
		const last = stopped[ v ][ stopped[ v ].length - 1 ];
		if ( last && last.to === undefined ) last.to = started;
		active = v;

	};
	// A stood stopped while B loaded
	stopped[ 0 ].push( { from: await frames[ 0 ].now() } );
	active = 1;
	for ( let k = 0; k < REPEAT; k ++ ) for ( const scene of names ) {

		const def = SCENES[ scene ];
		// each page switches and warms (compiles included) alone; the slices start with the page
		// warmed last, B, so the order is B A A B A B B A
		const compile = [];
		for ( const v of [ 0, 1 ] ) {

			await run( v );
			const prepared = await prepare( pages[ v ], scene, evals[ v ], true );
			compile[ v ] = { ms: r2( prepared.switchMs ), ...( await warm( frames[ v ], [ prepared.t ], WARMUP ) )[ 0 ] };
			if ( def.change ) await pages[ v ].evaluate( ( c ) => window.__PONLAI__.setWeather( c.weather, c.seconds ), def.change );

		}
		if ( k === 0 ) switches[ scene ] = compile;
		for ( let i = 0; i < SLICES; i ++ ) {

			const v = 1 - ORDER[ i % ORDER.length ];
			const switched = active !== v;
			if ( switched ) await run( v );
			// on the display: the compositor's trace for the slice, and the camera dragged through
			// the settle and the slice (each slice starts the same drags, so both pages see them)
			const display = DISPLAY ? await startDisplay( pages[ v ] ) : null;
			const motion = MOTION === 'user' ? driveUser( pages[ v ], ( switched ? SETTLE : 0 ) + SLICE ) : null;
			// the measured slice starts once this page has run alone a little (its queue fills)
			if ( switched ) await sleep( SETTLE * 1000 );
			const t0 = await frames[ v ].now();
			await sleep( SLICE * 1000 );
			const t1 = await frames[ v ].now();
			await motion;
			windows[ v ].push( { scene, slice: i, t0, t1, display: display ? await display.stop( t0, t1 ) : undefined } );

		}
		log( `${ scene.padEnd( 20 ) } A switched in ${ compile[ 0 ].ms } ms, warmed ${ compile[ 0 ].seconds } s (${ compile[ 0 ].pipelines } pipelines); B ${ compile[ 1 ].ms } ms, ${ compile[ 1 ].seconds } s (${ compile[ 1 ].pipelines } pipelines); ${ SLICES } slices` );

	}
	stopped[ active ].push( { from: await loop( active, 'stop' ) } );
	for ( const v of [ 0, 1 ] ) {

		const last = stopped[ v ][ stopped[ v ].length - 1 ];
		if ( last && last.to === undefined ) last.to = await frames[ v ].now();

	}
	await Promise.all( [ 0, 1 ].map( ( v ) => frames[ v ].settle( Math.max( ...windows[ v ].map( ( w ) => w.t1 ) ) ) ) );
	const runs = [ 0, 1 ].map( ( v ) => {

		const scenes = {};
		for ( const scene of names ) {

			const mine = windows[ v ].filter( ( w ) => w.scene === scene );
			const pooled = mine.flatMap( ( w ) => frames[ v ].in( w.t0, w.t1 ) );
			scenes[ scene ] = { ...summarise( pooled ), switch: switches[ scene ][ v ], gpuIdle: gpuIdle.idle?.mean ?? null, contended: gpuIdle.contended,
				slices: mine.map( ( w ) => ( { ...sliceStats( frames[ v ].in( w.t0, w.t1 ) ), ...( w.display ? { display: w.display } : {} ) } ) ) };
			if ( DISPLAY ) scenes[ scene ].display = poolDisplay( mine.map( ( w ) => w.display ) );
			if ( RAW ) scenes[ scene ].raw = pooled;

		}
		// frames the page drew while it should have stood still (more than the one in flight)
		const strays = stopped[ v ].reduce( ( a, s ) => a + frames[ v ].in( s.from + 1, s.to ?? Infinity ).length, 0 );
		return { scenes, loads: [ { scenes: names, loadMs: loaded[ v ].loadMs, url: loaded[ v ].url, gpuIdle, startup: loaded[ v ].startup, hooks: loaded[ v ].hooks } ], strayFrames: strays };

	} );
	for ( const p of pages.slice( 1 ) ) await p.close();
	return runs;

}

// toggle: one page, the expression flipped every BLOCK frames
async function runToggle( page, base, evalJs, toggleJs, log, names = sceneNames, timestamps = TIMESTAMP_MODE !== 'off' ) {

	await page.goto( 'about:blank' );
	const gpuIdle = await loadIdle( log );
	const loaded = await load( page, base, SCENES[ names[ 0 ] ].q, timestamps );
	log( `loaded ${ loaded.url } in ${ ( loaded.loadMs / 1000 ).toFixed( 1 ) } s (world cache ${ JSON.stringify( loaded.startup.diagnostics.worldCache ) })` );
	const frames = new Frames( page );
	const apply = ( on ) => page.evaluate( ( { js, on } ) => {

		( 0, eval )( `( ( s, on ) => { ${ js } } )` )( window.__PONLAI__, on );
		return performance.now();

	}, { js: toggleJs, on } );
	const scenes = [];
	for ( let k = 0; k < REPEAT; k ++ ) for ( const scene of names ) {

		const def = SCENES[ scene ];
		const { switchMs } = await prepare( page, scene, evalJs, true );
		// both states warmed (B, then A, which the blocks start with)
		const warmed = [];
		for ( const on of [ true, false ] ) warmed.push( ( await warm( frames, [ await apply( on ) ], on ? WARMUP : 1 ) )[ 0 ] );
		if ( def.change ) await page.evaluate( ( c ) => window.__PONLAI__.setWeather( c.weather, c.seconds ), def.change );
		const marks = await page.evaluate( ( { js, block, blocks, order } ) => new Promise( ( resolve ) => {

			const s = window.__PONLAI__;
			const set = ( 0, eval )( `( ( s, on ) => { ${ js } } )` );
			const marks = [];
			let n = 0, k = 0;
			const mark = () => {

				const on = order[ k % order.length ] === 1;
				set( s, on );
				marks.push( { t: performance.now(), on, k } );

			};
			mark();
			const step = () => {

				n ++;
				if ( n % block === 0 ) {

					k ++;
					if ( k >= blocks ) {

						marks.push( { t: performance.now(), end: true } );
						set( s, false );
						resolve( marks );
						return;

					}
					mark();

				}
				requestAnimationFrame( step );

			};
			requestAnimationFrame( step );

		} ), { js: toggleJs, block: BLOCK, blocks: BLOCKS, order: ORDER } );
		if ( k === 0 ) log( `${ scene.padEnd( 20 ) } switched in ${ Math.round( switchMs ) } ms; warmed B ${ warmed[ 0 ].seconds } s (${ warmed[ 0 ].pipelines } pipelines), A ${ warmed[ 1 ].seconds } s (${ warmed[ 1 ].pipelines }); ${ BLOCKS } blocks of ${ BLOCK } frames in ${ ( ( marks[ marks.length - 1 ].t - marks[ 0 ].t ) / 1000 ).toFixed( 1 ) } s` );
		scenes.push( { scene, marks, switch: { ms: r2( switchMs ), warmB: warmed[ 0 ], warmA: warmed[ 1 ] } } );

	}
	await frames.settle( Math.max( ...scenes.map( ( s ) => s.marks[ s.marks.length - 1 ].t ) ) );
	await page.evaluate( () => window.__profileTools.stopMotion() );
	// sort each block's frames: GPU figures drop the first 2 after a change, intervals the first LAG
	const runs = [ 0, 1 ].map( () => ( { scenes: {}, loads: [ { scenes: names, loadMs: loaded.loadMs, url: loaded.url, gpuIdle, startup: loaded.startup, hooks: loaded.hooks } ] } ) );
	for ( const name of names ) {

		const pooled = [ [], [] ], slices = [ [], [] ];
		for ( const { marks } of scenes.filter( ( x ) => x.scene === name ) ) {

			for ( let i = 0; i + 1 < marks.length; i ++ ) {

				const v = marks[ i ].on ? 1 : 0;
				const changed = i === 0 ? false : marks[ i - 1 ].on !== marks[ i ].on;
				const list = frames.in( marks[ i ].t, marks[ i + 1 ].t );
				const gpuFrames = changed ? list.slice( 2 ) : list;
				const intervalFrames = changed ? list.slice( LAG ) : list;
				slices[ v ].push( sliceStats( gpuFrames, intervalFrames ) );
				pooled[ v ].push( ...gpuFrames );

			}

		}
		const info = scenes.find( ( x ) => x.scene === name ).switch;
		for ( const v of [ 0, 1 ] ) runs[ v ].scenes[ name ] = { ...summarise( pooled[ v ] ), switch: info, gpuIdle: gpuIdle.idle?.mean ?? null, contended: gpuIdle.contended, slices: slices[ v ] };

	}
	return runs;

}

// ------------------------------------------------------------------ reports

// B / A in a cell: x0.912 (a report re-rendered from an older profile.json has no ratio)
const ratioText = ( x ) => x === null || x === undefined ? 'x –' : `x${ x.toFixed( 3 ) }`;
const fmt = ( x ) => x === null || x === undefined ? '–' : typeof x === 'number' ? x.toFixed( 2 ).replace( /\.?0+$/, '' ) || '0' : x;

function topGroups( r, n = 5 ) {

	return Object.entries( r.groups ).slice( 0, n ).map( ( [ g, v ] ) => `${ g } ${ fmt( v.mean ) }` ).join( ', ' );

}

function markdownProfile( meta, runs ) {

	const lines = [ `# Frame profile: ${ meta.label }`, '', `${ meta.url } at ${ meta.viewport.width }x${ meta.viewport.height } CSS, DPR ${ meta.viewport.scale }, quality ${ meta.quality }; ` +
		`render ${ meta.render ?? '?' }; warm-up ${ meta.warmup } s, ${ meta.seconds } s measured per scene, ${ meta.motion === 'user' ? 'the camera dragged like a player\'s' : meta.motion === 'none' ? 'the camera still' : `orbit ${ meta.orbit } deg/s` }${ meta.display ? ', headed on the real display at its own refresh' : '' }; ` +
		`GPU utilisation before the run ${ meta.gpuIdle?.idle?.mean ?? '?' } %${ meta.gpuIdle?.contended ? ` (CONTENDED: something else was rendering${ meta.gpuIdle.clients?.length ? `: ${ meta.gpuIdle.clients.map( ( c ) => `${ c.name.replace( / \(pid \d+\)/, '' ) } ${ c.percent } %` ).join( ', ' ) }` : '' })` : '' }; GPU timestamps ${ meta.timestamps === 'both' ? 'both (frame intervals without them, passes with them)' : meta.timestamps ? 'on' : 'off' }.`, '',
		`Frame interval in ms (rAF to rAF, ${ meta.display ? 'at the display\'s refresh' : meta.vsync ? 'under vsync at 60 Hz' : 'uncapped' }). ` +
		'GPU busy: the time the frame\'s passes add to the GPU\'s timeline (median); ' +
		'GPU p95: the 95th percentile of the GPU\'s own frame-to-frame interval. JS: the tick\'s own work (median), without the time it was ' +
		'blocked in queue.submit, writeBuffer and getCurrentTexture while the GPU caught up. Passes: mean GPU ms per frame. Hitches: frames over 25 ms and over 1.5 times the ' +
		'median, as frame intervals (cause: pipeline compile, JS tick, or GPU work through the queue) / on the GPU\'s timeline (cause: the pass ' +
		'that rose most above its median).' + ( meta.vsync ? ' Under vsync the intervals quantise to vblanks (16.7, 33.3 ms) and a GPU-bound frame waits for the display in getCurrentTexture.' : '' ), '' ];
	runs.forEach( ( run, k ) => {

		const repeat = runs.filter( ( r ) => r.scale === run.scale ).indexOf( run );
		if ( run.scale !== undefined && run.scale !== null ) lines.push( `## Render scale ${ run.scale }${ run.render ? ` (render ${ run.render })` : '' }${ runs.length > ( meta.scales?.length ?? 1 ) ? `, run ${ repeat + 1 }` : '' }`, '' );
		else if ( runs.length > 1 ) lines.push( `## Run ${ k + 1 }`, '' );
		const both = meta.timestamps === 'both';
		lines.push( `| scene | median | p95 | p99 | max | >16.7 | >25 |${ both ? ' median (timestamps on) |' : '' } GPU busy | GPU p95 | JS | hitches frame / GPU | top passes (mean GPU ms) |`, `|---|---|---|---|---|---|---|${ both ? '---|' : '' }---|---|---|---|---|` );
		for ( const [ scene, r ] of Object.entries( run.scenes ) ) {

			const causes = ( h ) => {

				const list = Object.entries( h.causes ).sort( ( a, b ) => b[ 1 ] - a[ 1 ] ).map( ( [ c, n ] ) => `${ c } ${ n }` ).join( ', ' );
				return `${ h.count }${ list ? ` (${ list })` : '' }`;

			};
			lines.push( `| ${ scene }${ r.contended ? ' (contended)' : '' } | ${ fmt( r.interval.median ) } | ${ fmt( r.interval.p95 ) } | ${ fmt( r.interval.p99 ) } | ${ fmt( r.interval.max ) } | ${ Math.round( r.over16 * 100 ) } % | ${ Math.round( r.over25 * 100 ) } % |${ both ? ` ${ fmt( r.withTimestamps?.interval.median ) } |` : '' } ${ fmt( r.gpu.median ) } | ${ fmt( r.gpuInterval.p95 ) } | ${ fmt( r.js.median ) } | ${ causes( r.hitches ) } / ${ causes( r.gpuHitches ) } | ${ topGroups( r ) } |` );

		}
		lines.push( '' );
		if ( Object.values( run.scenes ).some( ( r ) => r.display ) ) {

			lines.push( 'On the display: the intervals between the frames the scene rendered and between the frames the compositor presented, by display refreshes ' +
				'(their shares), and the share of intervals that differ from the one before by half a refresh or more (cadence changes: judder at a steady pace). ' +
				'Camera: how much the camera\'s turning speed changes from one rendered frame to the next while it turns (median, p90, share over 25 %).', '',
				'| scene | refresh | rendered (1 / 2 / 3 / 4+) | cadence changes | presented (1 / 2 / 3 / 4+) | cadence changes | presented max | camera speed change | scale |', '|---|---|---|---|---|---|---|---|---|' );
			const shares = ( c ) => c ? [ 1, 2, 3, '4+' ].map( ( n ) => pct( c.refreshes[ n ] ) ).join( ' / ' ) : '–';
			for ( const [ scene, r ] of Object.entries( run.scenes ) ) {

				const d = r.display;
				if ( ! d ) continue;
				lines.push( `| ${ scene } | ${ fmt( d.refresh ) } ms${ d.pacing ? `, paced ${ d.pacing.divisor }` : '' } | ${ shares( d.rendered ) } | ${ pct( d.rendered.cadenceChanges ) } | ${ shares( d.presented ) } | ${ pct( d.presented?.cadenceChanges ) } | ${ fmt( d.presented?.max ) } | ${ pct( d.camera.median ) } / ${ pct( d.camera.p90 ) } / ${ pct( d.camera.over25 ) } | ${ scaleText( r.renderScale ) } |` );

			}
			lines.push( '' );

		}
		const s = run.loads[ 0 ]?.startup;
		if ( s ) lines.push( `Startup (${ k === 0 ? 'first load, cold shader cache' : 'first load of this run' }): ${ startupLine( s ) }`, '' );
		const warm = run.loads.slice( 1 ).map( ( l ) => l.startup ).filter( Boolean );
		if ( warm.length ) lines.push( `Startup (later loads, median of ${ warm.length }): ${ startupLine( medianStartup( warm ) ) }`, '' );

	} );
	// repeats at one render scale: their spread
	for ( const scale of [ ...new Set( runs.map( ( r ) => r.scale ) ) ] ) {

		const same = runs.filter( ( r ) => r.scale === scale );
		if ( same.length < 2 ) continue;
		lines.push( `## Spread between runs${ scale !== undefined && scale !== null ? ` at render scale ${ scale }` : '' } (max - min of the run medians)`, '', '| scene | median | p95 | p99 | GPU busy |', '|---|---|---|---|---|' );
		for ( const scene of Object.keys( same[ 0 ].scenes ) ) {

			const spread = ( f ) => {

				const v = same.map( ( run ) => f( run.scenes[ scene ] ) );
				return `${ fmt( Math.max( ...v ) - Math.min( ...v ) ) } (${ v.map( fmt ).join( ' / ' ) })`;

			};
			lines.push( `| ${ scene } | ${ spread( ( r ) => r.interval.median ) } | ${ spread( ( r ) => r.interval.p95 ) } | ${ spread( ( r ) => r.interval.p99 ) } | ${ spread( ( r ) => r.gpu.median ) } |` );

		}
		lines.push( '' );

	}
	if ( meta.accept ) {

		const a = meta.accept;
		lines.push( '## Acceptance (60 fps)', '', `Pass: frame interval median and p95 at most ${ a.limit } ms (${ a.target } plus vblank jitter) and no frame over ${ a.maxFrame } ms in the ${ meta.seconds } s measured, ` +
			`from the run ${ meta.timestampMode === 'on' && meta.hooks !== false ? 'with' : 'without' } GPU timestamps under vsync; p99, the maximum and the GPU busy time (median / p95, from the run with timestamps) are reported. ` +
			'Headless 60 Hz shows whether the GPU holds 60 fps, not how a faster display paces the frames: check that with --display. ' +
			'A contended scene (something else kept the GPU busy) that fails is INCONCLUSIVE, not FAIL, unless its GPU busy median is over the target: run it again on an idle GPU.', '',
			`| ${ meta.scales ? 'render scale | ' : '' }scene | verdict | median | p95 | p99 | max | frames over ${ a.maxFrame } ms | GPU busy | frames' scale (with timestamps) | why |`, `|${ meta.scales ? '---|' : '' }---|---|---|---|---|---|---|---|---|---|` );
		for ( const run of runs ) for ( const [ scene, r ] of Object.entries( run.scenes ) ) {

			const v = r.accept;
			if ( ! v ) continue;
			const verdict = v.verdict ?? ( v.pass ? 'PASS' : 'FAIL' );
			lines.push( `| ${ meta.scales ? `${ run.scale } | ` : '' }${ scene } | ${ verdict === 'FAIL' ? '**FAIL**' : verdict } | ${ fmt( v.median ) } | ${ fmt( v.p95 ) } | ${ fmt( v.p99 ) } | ${ fmt( v.max ) } | ${ v.framesOver25 } of ${ v.frames } | ${ fmt( v.gpuBusy ) } / ${ fmt( v.gpuBusyP95 ) } | ${ scaleText( v.scale ) } (${ scaleText( v.scaleWithTimestamps ) }) | ${ v.reasons.join( ', ' ) } |` );

		}
		lines.push( '' );

	}
	if ( ( meta.scales?.length ?? 0 ) > 1 ) {

		// every scene at every scale (the first run at each): where it holds the frame rate
		const first = meta.scales.map( ( scale ) => runs.find( ( r ) => r.scale === scale ) );
		lines.push( '## Scenes by render scale', '', 'Each cell: frame interval median / p95 (ms), frames over 25 ms, GPU busy median' + ( meta.accept ? ', and the verdict' : '' ) + '.', '',
			`| scene | ${ meta.scales.join( ' | ' ) } |`, `|---|${ meta.scales.map( () => '---|' ).join( '' ) }` );
		for ( const scene of Object.keys( first[ 0 ].scenes ) ) {

			const cells = first.map( ( run ) => {

				const r = run?.scenes[ scene ];
				return r ? `${ fmt( r.interval.median ) } / ${ fmt( r.interval.p95 ) }, ${ r.over25Count ?? '–' }, ${ fmt( r.gpu.median ) }${ r.accept ? ` ${ r.accept.verdict ?? ( r.accept.pass ? 'PASS' : 'FAIL' ) }` : '' }` : '–';

			} );
			lines.push( `| ${ scene } | ${ cells.join( ' | ' ) } |` );

		}
		lines.push( '' );

	}
	return lines.join( '\n' );

}

// the median of several loads' startups, field by field
function medianStartup( list ) {

	const pick = ( f ) => quantile( list.map( f ).filter( Number.isFinite ), 0.5 );
	const frames = Array.from( { length: 12 }, ( _, i ) => ( {
		interval: pick( ( s ) => s.startup?.frames?.[ i ]?.interval ), wait: pick( ( s ) => s.startup?.frames?.[ i ]?.wait ), done: pick( ( s ) => s.startup?.frames?.[ i ]?.done ),
	} ) );
	return {
		marks: Object.fromEntries( [ 'renderer', 'sky', 'world', 'meshes', 'villagers', 'loop' ].map( ( k ) => [ k, pick( ( s ) => s.marks?.[ k ] ) ] ) ),
		diagnostics: { timings: { total: pick( ( s ) => s.diagnostics?.timings?.total ) } },
		startup: {
			firstFrame: Object.fromEntries( [ 'at', 'js', 'wait', 'pipelines', 'pipelineMs', 'done' ].map( ( k ) => [ k, pick( ( s ) => s.startup?.firstFrame?.[ k ] ) ] ) ),
			frames,
		},
	};

}

function startupLine( s ) {

	const m = s.marks ?? {};
	const f = s.startup?.firstFrame;
	const frames = s.startup?.frames ?? [];
	// frames[ i ].interval: from tick i - 1's start to tick i's
	const next10 = frames.slice( 2, 12 ).reduce( ( a, x ) => a + x.interval, 0 );
	const tickEnd = ( f?.at ?? NaN ) + ( f?.js ?? 0 ) + ( f?.wait ?? 0 );
	return `since navigation: renderer ${ fmt( m.renderer ) } ms, sky lit ${ fmt( m.sky ) }, world ${ fmt( m.world ) } (generation ${ fmt( s.diagnostics?.timings?.total ) } in the worker), ` +
		`meshes ${ fmt( m.meshes ) }, villagers ${ fmt( m.villagers ) }, first tick ${ fmt( f?.at ) }, first frame done on the GPU ${ fmt( f?.done ) }, tenth ${ fmt( frames[ 9 ]?.done ) }. ` +
		`The first tick took ${ fmt( ( f?.js ?? 0 ) + ( f?.wait ?? 0 ) ) } ms (building the materials' shaders; ${ f?.pipelines ?? '?' } pipelines, ${ fmt( f?.pipelineMs ) } ms of it in createRenderPipeline), ` +
		`then the GPU process compiled and ran it for ${ fmt( f?.done - tickEnd ) } ms; the next 10 ticks ${ fmt( next10 ) } ms`;

}

// ------------------------------------------------------------------ main

// Chrome with a profile kept between runs (the world cache lives in its IndexedDB, the shader cache
// beside it); a profile still in use by another run falls back to a temporary one
async function launch() {

	const options = {
		headless: ! DISPLAY, ...( executablePath ? { executablePath } : { channel: 'chromium' } ), args: CHROME_ARGS,
		// on the display the page takes the screen's size and pixel ratio, and Chrome its field trials
		...( DISPLAY ? { viewport: null, ignoreDefaultArgs: [ '--disable-field-trial-config' ] } : { viewport: { width: W, height: H }, deviceScaleFactor: SCALE } ),
	};
	try {

		await mkdir( PROFILE_DIR, { recursive: true } );
		return { context: await chromium.launchPersistentContext( PROFILE_DIR, options ), dir: PROFILE_DIR, temporary: false };

	} catch ( error ) {

		console.error( `[profile] the Chrome profile ${ PROFILE_DIR } is unavailable (${ error.message.split( '\n' )[ 0 ] }); using a temporary one, without the world cache of earlier runs` );
		const dir = await mkdtemp( path.join( os.tmpdir(), 'ponlai-profile-frame-' ) );
		return { context: await chromium.launchPersistentContext( dir, options ), dir, temporary: true };

	}

}

// The preload: the run's first page loaded once under a shared GPU slot, before the exclusive lock,
// so that the loads under the lock find the profile's world cache and shader cache warm. A load that
// misses the world cache generates the island inside the exclusive hold (seconds alone, a minute
// under a busy CPU) and compiles every shader cold; a load that hits is what every run but a build's
// first already measured, so the preload changes no measured window, only which loads hit. The
// preloaded page is left (a blank page) before the slot is released. It is skipped when the profile
// already preloaded this build in this browser (`profile-frame-preloaded.json` in the profile, per
// origin, as the world cache keeps one world per origin: a hash of the served index.html, whose
// asset names carry the bundle's content hashes, and the Chrome version its user agent gives, the
// world cache's key; the world's options do not depend on the url), always on a dev server (its
// index does not change with its sources), and never with `--world-cache off` (the island is then
// generated as on a first visit by design). The url is the first load's with `drsStore=off`, so
// the preload neither restores nor stores a dynamic scale.
async function preload( page, dir, label, chrome ) {

	if ( ! WORLD_CACHE ) return null;
	const markerFile = path.join( dir, 'profile-frame-preloaded.json' );
	let marker = {};
	try { marker = JSON.parse( await readFile( markerFile, 'utf8' ) ); } catch { /* none yet */ }
	renderScale = SCALES[ 0 ] ?? null;
	const timestamps = TIMESTAMP_MODE !== 'off' && ! ( TIMESTAMP_MODE === 'both' && ! COMPARE && ! TOGGLE );
	const entries = [];
	for ( const base of COMPARE ?? [ URL_A ] ) {

		const url = new URL( pageUrl( base, SCENES[ sceneNames[ 0 ] ].q, timestamps ) );
		url.search = [ ...url.search.slice( 1 ).split( '&' ).filter( ( o ) => ! o.startsWith( 'drsStore=' ) ), 'drsStore=off' ].join( '&' );
		let build = null;
		try {

			const html = await ( await fetch( base ) ).text();
			if ( ! html.includes( '/@vite/client' ) ) build = createHash( 'sha1' ).update( html ).digest( 'hex' ).slice( 0, 16 );

		} catch { /* unknown: preload */ }
		const last = marker[ url.origin ];
		entries.push( { url: url.href, build, cached: build !== null && last?.build === build && last?.chrome === chrome } );

	}
	renderScale = null;
	const todo = entries.filter( ( e ) => ! e.cached );
	if ( todo.length === 0 ) return { skipped: 'this build was preloaded before', entries };
	// a slot waits behind every exclusive request queued: after PRELOAD_WAIT the build loads under the
	// exclusive lock as before, rather than queueing twice
	const requested = Date.now();
	let lockWaitMs = 0;
	const load = async () => {

		lockWaitMs = Date.now() - requested;
		for ( const e of todo ) {

			const started = Date.now();
			await page.goto( e.url );
			await page.waitForFunction( () => window.__PONLAI__ && window.__THREE_GAME_DIAGNOSTICS__?.frame > 30 &&
				document.getElementById( 'loading' )?.classList.contains( 'done' ), null, { timeout: 180000, polling: 'raf' } );
			e.worldCache = await page.evaluate( () => window.__THREE_GAME_DIAGNOSTICS__.worldCache ?? 'unsupported' );
			e.ms = Date.now() - started;
			console.error( `[profile] preloaded ${ e.url } in ${ ( e.ms / 1000 ).toFixed( 1 ) } s (world cache ${ JSON.stringify( e.worldCache ) })` );

		}
		await page.goto( 'about:blank' );

	};
	try {

		await withGpuLock( `${ label } preload`, load, { shared: true, timeout: PRELOAD_WAIT } );

	} catch ( error ) {

		if ( lockWaitMs > 0 || ! /still held/.test( error.message ) ) throw error;
		console.error( `[profile] no GPU slot for the preload within ${ PRELOAD_WAIT } s: the first load runs under the exclusive lock` );
		return { skipped: `no GPU slot within ${ PRELOAD_WAIT } s`, entries };

	}
	for ( const e of todo ) marker[ new URL( e.url ).origin ] = { build: e.build, chrome, url: e.url };
	await writeFile( markerFile, JSON.stringify( marker, null, 1 ) );
	return { lockWaitMs, entries };

}

async function main() {

	await mkdir( OUT, { recursive: true } );
	const label = `profile-frame ${ LABEL }`;
	const begun = Date.now();
	// Setup outside the exclusive lock: the browser (its blank page draws nothing) and, when the
	// profile's caches may not hold this build yet, the preload under a shared GPU slot (see preload)
	const { context, dir, temporary } = await launch();
	const errors = [];
	const watch = ( p ) => {

		// named by the page (A or B) in an A/B
		const name = () => pageNames.has( p ) ? ` (page ${ pageNames.get( p ) })` : '';
		p.on( 'pageerror', ( e ) => errors.push( `pageerror${ name() }: ${ e.message }` ) );
		p.on( 'console', ( m ) => { if ( m.type() === 'error' ) errors.push( `${ name() ? `console${ name() }: ` : '' }${ m.text() }` ); } );

	};
	context.pages().forEach( watch );
	context.on( 'page', watch );
	let started = 0, held = 0, waitedMs = 0, result = null, preloaded = null;
	try {

		const page = context.pages()[ 0 ] ?? await context.newPage();
		const version = ( await page.evaluate( () => navigator.userAgent ) ).match( /Chrome\/([\d.]+)/ )?.[ 1 ] ?? '?';
		preloaded = await preload( page, dir, label, version );
		// (the preload's page errors are not the run's)
		if ( errors.length ) console.error( `[profile] the preload logged: ${ errors.splice( 0 ).slice( 0, 5 ).join( ' | ' ) }` );
		const requested = Date.now();
		await withGpuLock( label, async () => {

			// the run's time from here on: the lock's wait is someone else's run
			started = Date.now();
			waitedMs = started - requested;
			if ( waitedMs > 1000 ) console.error( `[profile] GPU lock acquired after ${ ( waitedMs / 1000 ).toFixed( 0 ) } s` );
			const gpuIdle = await waitForIdleGpu( { threshold: IDLE_THRESHOLD, wait: IDLE_WAIT } );
			if ( gpuIdle.contended ) idleWaitLoad = 0;
			startIdle = gpuIdle;
			console.error( `[profile] GPU idle ${ gpuIdle.idle?.mean ?? '?' } % (max ${ gpuIdle.idle?.max ?? '?' } %)${ gpuIdle.contended ? ', CONTENDED' : '' }; Chrome: ${ executablePath ?? 'Playwright Chromium' }; mode ${ TOGGLE ? 'toggle' : MODE }${ VSYNC ? ', vsync' : ', uncapped' }${ ACCEPT ? `, accept at ${ TARGET } ms` : '' }` );
			// a run that stops making progress fails rather than holding the lock
			let progress = Date.now();
			const watchdog = setInterval( () => {

				if ( Date.now() - progress < 180000 ) return;
				console.error( '[profile] no progress for 3 minutes: giving up (the GPU lock is released)' );
				process.exit( 1 );

			}, 5000 );
			watchdog.unref();
			const log = ( line ) => { progress = Date.now(); console.error( `[profile] ${ line }` ); };
			const meta = {
				label: LABEL, url: URL_A, viewport: { width: W, height: H, scale: SCALE }, quality: QUALITY, warmup: WARMUP, seconds: SECONDS, orbit: ORBIT,
				chrome: version, args: CHROME_ARGS, gpuIdle, started: new Date().toISOString(), fresh: FRESH, eval: opt( 'eval', '' ), extraQuery: EXTRA_Q,
				mode: TOGGLE ? 'toggle' : MODE, worldCache: WORLD_CACHE, vsync: VSYNC, timestampMode: TIMESTAMP_MODE, hooks: HOOKS, display: DISPLAY, motion: MOTION, preload: preloaded,
			};
			const evals = [ opt( 'eval-a', opt( 'eval', '' ) ), opt( 'eval-b', opt( 'eval', '' ) ) ];
			const tsModes = TIMESTAMP_MODE === 'both' ? [ true, false ] : [ TIMESTAMP_MODE !== 'off' ];
			if ( TOGGLE || ( COMPARE && MODE === 'page' ) ) {

				// A/B in page mode: GPU time first (timestamps on), the frame rate without them
				const reports = [];
				let runs = null;
				for ( const timestamps of tsModes ) {

					if ( tsModes.length > 1 ) log( timestamps ? 'with timestamps (GPU time per pass)' : 'without timestamps (frame intervals)' );
					const [ A, B ] = TOGGLE ? await runToggle( page, URL_A, opt( 'eval', '' ), TOGGLE, log, sceneNames, timestamps ) : await runPair( context, COMPARE, evals, log, sceneNames, timestamps );
					runs ??= { A: [ A ], B: [ B ] };
					reports.push( { timestamps, report: sliceReport( A, B ), strayFrames: [ A.strayFrames, B.strayFrames ] } );
					if ( ! TOGGLE ) for ( const [ scene, r ] of Object.entries( reports[ reports.length - 1 ].report ) ) log( `${ scene.padEnd( 20 ) } scale A ${ scaleText( r.scale[ 0 ] ) }, B ${ scaleText( r.scale[ 1 ] ) }${ r.late ? `; late frames ${ pct( r.late.a ) } -> ${ pct( r.late.b ) }` : '' }` );
					if ( A.strayFrames || B.strayFrames ) log( `WARNING: a stopped page drew ${ A.strayFrames } / ${ B.strayFrames } frames` );

				}
				meta.compare = TOGGLE ? { A: `${ URL_A } with on = false`, B: `${ URL_A } with on = true`, toggle: TOGGLE, block: BLOCK, blocks: BLOCKS, lag: LAG } :
					{ A: COMPARE[ 0 ], B: COMPARE[ 1 ], evalA: evals[ 0 ], evalB: evals[ 1 ], slices: SLICES, slice: SLICE, settle: SETTLE };
				meta.timestamps = TIMESTAMP_MODE === 'both' ? 'both' : tsModes[ 0 ];
				const renderAt = ( s ) => s?.diagnostics ? `${ s.diagnostics.render.join( 'x' ) } -> ${ s.diagnostics.canvas.join( 'x' ) }${ s.diagnostics.upscaled ? ' (FSR)' : '' }` : null;
				meta.render = renderAt( runs.A[ 0 ].loads[ 0 ]?.startup );
				// each page's render at its load (a dynamic scale moves it afterwards: see each scene's scale)
				meta.renderB = renderAt( runs.B[ 0 ].loads[ 0 ]?.startup );
				if ( DISPLAY ) meta.viewport = await page.evaluate( () => ( { width: innerWidth, height: innerHeight, scale: devicePixelRatio } ) );
				result = { meta, json: () => ( { meta, runs, reports, errors } ), markdown: () => sliceMarkdown( meta, reports ) };

			} else if ( ! COMPARE ) {

				const run = ( timestamps, suffix ) => MODE === 'reload' ? runVariant( page, URL_A, opt( 'eval', '' ), log, plan( sceneNames ), suffix, timestamps ) :
					runPage( page, URL_A, opt( 'eval', '' ), log, sceneNames, suffix, timestamps );
				const runs = [];
				for ( const scale of SCALES.length ? SCALES : [ null ] ) {

					renderScale = scale;
					if ( scale !== null ) log( `render scale ${ scale } (dpr=${ scale })` );
					for ( let k = 0; k < REPEAT; k ++ ) {

						if ( REPEAT > 1 ) log( `run ${ k + 1 } / ${ REPEAT }` );
						const suffix = ( scale !== null ? `-dpr${ scale }` : '' ) + ( REPEAT > 1 ? `-run${ k + 1 }` : '' );
						let result;
						if ( TIMESTAMP_MODE === 'both' ) {

							log( 'without timestamps (frame intervals)' );
							const off = await run( false, suffix );
							log( 'with timestamps (GPU time per pass)' );
							const on = await run( true, suffix );
							result = mergeModes( off, on );

						} else {

							result = await run( TIMESTAMP_MODE !== 'off', suffix );

						}
						const d = result.loads[ 0 ]?.startup?.diagnostics;
						result.scale = scale;
						result.render = d ? `${ d.render.join( 'x' ) } -> ${ d.canvas.join( 'x' ) }${ d.upscaled ? ' (FSR)' : '' }` : null;
						// the page caps the render's ratio at the display's (and a quality's budget may lower it)
						if ( scale !== null && d && Math.abs( d.dpr - scale ) > 0.01 ) log( `WARNING: render scale ${ scale } asked, the page renders at ${ d.dpr } (${ d.render.join( 'x' ) })` );
						if ( ACCEPT ) for ( const [ scene, r ] of Object.entries( result.scenes ) ) {

							r.accept = acceptance( r );
							const a = r.accept;
							log( `accept ${ scale !== null ? `dpr ${ scale } ` : '' }${ scene.padEnd( 20 ) } ${ a.verdict }  median ${ a.median } p95 ${ a.p95 } p99 ${ a.p99 } max ${ a.max } ms, ${ a.framesOver25 } of ${ a.frames } frames over ${ ACCEPT_MAX } ms, gpu busy ${ a.gpuBusy ?? '–' } (p95 ${ a.gpuBusyP95 ?? '–' }), scale ${ scaleText( a.scale ) } (${ scaleText( a.scaleWithTimestamps ) })${ a.pass ? '' : ` (${ a.reasons.join( ', ' ) })` }` );

						}
						runs.push( result );

					}

				}
				renderScale = null;
				if ( DISPLAY ) meta.viewport = await page.evaluate( () => ( { width: innerWidth, height: innerHeight, scale: devicePixelRatio } ) );
				if ( SCALES.length ) meta.scales = SCALES;
				if ( ACCEPT ) {

					meta.accept = { target: TARGET, limit: r2( TARGET + TARGET_SLACK ), maxFrame: ACCEPT_MAX };
					const verdicts = runs.flatMap( ( run ) => Object.values( run.scenes ).map( ( r ) => r.accept.verdict ) );
					const tally = {};
					for ( const v of verdicts ) tally[ v ] = ( tally[ v ] ?? 0 ) + 1;
					log( `accept: ${ verdicts.length } scene runs: ${ Object.entries( tally ).map( ( [ v, n ] ) => `${ n } ${ v }` ).join( ', ' ) }` );
					if ( STRICT && tally.FAIL ) process.exitCode = 1;

				}
				const s = runs[ 0 ].loads.find( ( l ) => l.startup?.timestamps )?.startup ?? runs[ 0 ].loads[ 0 ]?.startup;
				meta.timestamps = TIMESTAMP_MODE === 'both' ? 'both' : s?.timestamps;
				meta.render = s?.diagnostics ? `${ s.diagnostics.render.join( 'x' ) } -> ${ s.diagnostics.canvas.join( 'x' ) }${ s.diagnostics.upscaled ? ' (FSR)' : '' }` : null;
				result = { meta, json: () => ( { meta, runs, errors } ), markdown: () => markdownProfile( meta, runs ) };

			} else {

				if ( TIMESTAMP_MODE === 'both' ) log( '--compare --mode reload runs one mode: timestamps on' );
				// A B B A for each page load's scenes, so a drift of the machine over the run cancels
				const runs = { A: [], B: [] };
				for ( let k = 0; k < REPEAT; k ++ ) for ( const group of plan( sceneNames ) ) {

					for ( const v of [ 0, 1, 1, 0 ] ) {

						log( `variant ${ 'AB'[ v ] }: ${ COMPARE[ v ] }${ evals[ v ] ? ` eval ${ evals[ v ] }` : '' }` );
						pageNames.set( page, 'AB'[ v ] );
						const run = await runVariant( page, COMPARE[ v ], evals[ v ], log, [ group ], `-${ 'AB'[ v ] }` );
						// one entry per repetition, holding every scene
						const list = runs[ 'AB'[ v ] ];
						const slot = list.find( ( r ) => ! Object.keys( r.scenes ).some( ( s ) => group.scenes.includes( s ) ) );
						if ( slot ) { Object.assign( slot.scenes, run.scenes ); slot.loads.push( ...run.loads ); } else list.push( run );

					}

				}
				meta.compare = { A: COMPARE[ 0 ], B: COMPARE[ 1 ], evalA: evals[ 0 ], evalB: evals[ 1 ] };
				const report = compareReport( runs );
				result = { meta, json: () => ( { meta, runs, report, errors } ), markdown: () => compareMarkdown( meta, report ) };

			}
			// the measurements are done: once every page's loop stood still (no frame, its queue
			// drained), nothing of this run renders and the lock goes to the next run
			for ( const p of context.pages() ) await p.evaluate( () => window.__profileTools?.loop.stop() ).catch( () => {} );
			held = Date.now() - started;
			clearInterval( watchdog );

		} );
		const { meta } = result;
		meta.gpu = await gpuInfo( page );
		meta.finished = new Date().toISOString();
		// wallSeconds: the run under the exclusive lock (as before: from taking it to the results);
		// the setup before it (launch, preload and its shared slot) and the wait for the lock apart
		meta.wallSeconds = r2( held / 1000 );
		meta.lockWaitSeconds = r2( waitedMs / 1000 );
		meta.totalSeconds = r2( ( Date.now() - begun ) / 1000 );
		await writeFile( path.join( OUT, 'profile.json' ), JSON.stringify( result.json(), null, 1 ) );
		await writeFile( path.join( OUT, 'summary.md' ), result.markdown() );
		if ( errors.length ) console.error( errors.slice( 0, 10 ).join( '\n' ) );

	} finally {

		await context.close();
		if ( temporary ) await rm( dir, { recursive: true, force: true } );

	}
	const waits = waitedMs + ( preloaded?.lockWaitMs ?? 0 );
	console.error( `[profile] done: ${ ( held / 1000 ).toFixed( 0 ) } s under the exclusive lock, ${ ( ( Date.now() - begun - waits ) / 1000 ).toFixed( 0 ) } s in all without the waits for the GPU lock` );
	console.log( path.join( OUT, 'summary.md' ) );

}

// page-mode compare and toggle: deltas over the slices or blocks
function sliceReport( A, B ) {

	const report = {};
	for ( const scene of Object.keys( A.scenes ) ) {

		const a = A.scenes[ scene ].slices, b = B.scenes[ scene ].slices;
		const metric = ( f ) => delta( a.map( f ), b.map( f ) );
		const groups = new Set( [ ...a, ...b ].flatMap( ( s ) => Object.keys( s.groups ) ) );
		report[ scene ] = {
			slices: [ a.length, b.length ], frames: [ A.scenes[ scene ].frames, B.scenes[ scene ].frames ],
			gpu: metric( ( s ) => s.gpu ), gpuInterval: metric( ( s ) => s.gpuInterval ),
			median: metric( ( s ) => s.interval ), p95: metric( ( s ) => s.p95 ), js: metric( ( s ) => s.js ),
			// on the display: the share of late frames (intervals longer than the pace) per slice
			...( a.some( ( s ) => s.display ) ? { late: metric( ( s ) => lateShare( s.display ) ) } : {} ),
			// each page's render scale over its slices (a dynamic scale settles where its GPU time puts it)
			scale: [ A.scenes[ scene ].renderScale ?? null, B.scenes[ scene ].renderScale ?? null ],
			over25: [ A.scenes[ scene ].over25Count, B.scenes[ scene ].over25Count ],
			// pooled over every slice, for the scene's level
			pooled: { a: { median: A.scenes[ scene ].interval.median, p95: A.scenes[ scene ].interval.p95, gpu: A.scenes[ scene ].gpu.mean }, b: { median: B.scenes[ scene ].interval.median, p95: B.scenes[ scene ].interval.p95, gpu: B.scenes[ scene ].gpu.mean } },
			groups: Object.fromEntries( [ ...groups ].map( ( g ) => [ g, metric( ( s ) => s.groups[ g ] ?? 0 ) ] ).sort( ( x, y ) => Math.abs( y[ 1 ].delta ) - Math.abs( x[ 1 ].delta ) ) ),
			switch: [ A.scenes[ scene ].switch, B.scenes[ scene ].switch ],
		};

	}
	return report;

}

function sliceMarkdown( meta, reports ) {

	const c = meta.compare;
	const how = meta.mode === 'toggle' ? `in one page: \`${ c.toggle }\` applied every ${ c.block } frames, ${ c.blocks } blocks per scene (A B B A B A A B); GPU figures drop 2 frames after a change, frame intervals ${ c.lag }` :
		`two pages in one browser, ${ c.slices } slices of ${ c.slice } s per scene (B A A B A B B A), each after the other page stopped and drained and this one ran ${ c.settle } s`;
	const lines = [ `# Frame profile ${ meta.mode === 'toggle' ? 'toggle' : 'compare' }: ${ meta.label }`, '',
		`A: ${ c.A }${ c.evalA ? ` (eval ${ c.evalA })` : '' }`, `B: ${ c.B }${ c.evalB ? ` (eval ${ c.evalB })` : '' }`, '',
		`${ meta.viewport.width }x${ meta.viewport.height } CSS, DPR ${ meta.viewport.scale }, quality ${ meta.quality }; render at load ${ meta.renderB && meta.renderB !== meta.render ? `A ${ meta.render ?? '?' }, B ${ meta.renderB }` : meta.render ?? '?' }; ${ how }` +
		`${ meta.display ? `, headed on the real display at its own refresh, ${ meta.motion === 'user' ? 'the camera dragged like a player\'s in each slice' : meta.motion === 'none' ? 'the camera still' : `orbit ${ meta.orbit } deg/s` }` : '' }. ` +
		`Scenes are switched at runtime and warmed ${ meta.warmup } s and until no pipeline compiled for a second. Each cell: A -> B (B - A ± its 95 % interval over the slices); * marks a delta beyond it. ` +
		`B/A follows each delta as a ratio (x0.9: B takes 10 % less). Decide on GPU busy and the passes (GPU time per frame); take frame rates from the run without timestamps. ${ meta.wallSeconds ? `Wall time ${ Math.round( meta.wallSeconds ) } s.` : '' }`, '' ];
	const cell = ( m ) => m.delta === null ? '–' : `${ fmt( m.a ) } -> ${ fmt( m.b ) } (${ m.delta > 0 ? '+' : '' }${ fmt( m.delta ) } ± ${ fmt( m.ci ) }; ${ ratioText( m.ratio ) })${ m.significant ? ' *' : '' }`;
	for ( const { timestamps, report, strayFrames } of reports ) {

		lines.push( `## ${ timestamps ? 'With GPU timestamps (GPU time per pass)' : 'Without timestamps (the frame rate a player sees)' }`, '' );
		const late = Object.values( report ).some( ( r ) => r.late );
		// each page's render scale over the scene's slices: median (range, changes)
		const scales = ( r ) => r.scale ? `${ scaleText( r.scale[ 0 ] ) } / ${ scaleText( r.scale[ 1 ] ) }` : '–';
		if ( timestamps ) lines.push( '| scene | scale A / B | GPU busy | GPU frame interval | frame interval median | p95 | JS tick | largest pass deltas |', '|---|---|---|---|---|---|---|---|' );
		else lines.push( `| scene | scale A / B | frame interval median | p95 | JS tick |${ late ? ' late frames (share over the pace) | frames over 25 ms A / B |' : '' }`, `|---|---|---|---|---|${ late ? '---|---|' : '' }` );
		for ( const [ scene, r ] of Object.entries( report ) ) {

			const passes = Object.entries( r.groups ).slice( 0, 3 ).map( ( [ g, m ] ) => `${ g } ${ m.delta > 0 ? '+' : '' }${ fmt( m.delta ) }${ m.significant ? '*' : '' }` ).join( ', ' );
			if ( timestamps ) lines.push( `| ${ scene } | ${ scales( r ) } | ${ cell( r.gpu ) } | ${ cell( r.gpuInterval ) } | ${ cell( r.median ) } | ${ cell( r.p95 ) } | ${ cell( r.js ) } | ${ passes } |` );
			else lines.push( `| ${ scene } | ${ scales( r ) } | ${ cell( r.median ) } | ${ cell( r.p95 ) } | ${ cell( r.js ) } |${ late ? ` ${ r.late ? cell( r.late ) : '–' } | ${ r.over25?.join( ' / ' ) ?? '–' } |` : '' }` );

		}
		lines.push( '' );
		if ( late ) lines.push( 'Late frames: the share of the intervals between the frames the compositor presented (else those the scene rendered) longer than the pace (the frame pacer\'s refreshes per frame, one without it), per slice.', '' );
		const compiles = Object.entries( report ).map( ( [ scene, r ] ) => {

			const w = ( x ) => x ? `${ x.pipelines ?? x.warmB?.pipelines ?? 0 } pipelines${ x.pipelineMs ? ` (${ fmt( x.pipelineMs ) } ms JS)` : '' }` : '?';
			return meta.mode === 'toggle' ? `${ scene } ${ fmt( r.switch[ 0 ]?.ms ) } ms, B ${ w( r.switch[ 0 ]?.warmB ) }, A ${ w( r.switch[ 0 ]?.warmA ) }` : `${ scene } A ${ fmt( r.switch[ 0 ]?.ms ) } ms ${ w( r.switch[ 0 ] ) }, B ${ fmt( r.switch[ 1 ]?.ms ) } ms ${ w( r.switch[ 1 ] ) }`;

		} );
		lines.push( `Scene switches and the compiles after them (outside the measured slices): ${ compiles.join( '; ' ) }.`, '' );
		if ( strayFrames && ( strayFrames[ 0 ] || strayFrames[ 1 ] ) ) lines.push( `WARNING: a stopped page drew frames (A ${ strayFrames[ 0 ] }, B ${ strayFrames[ 1 ] }).`, '' );
		else if ( meta.mode !== 'toggle' ) lines.push( 'The stopped page drew no frame during the other\'s slices.', '' );

	}
	return lines.join( '\n' );

}

// --timestamps both: a scene's frame intervals (and frame hitches) from the run without timestamps,
// everything else from the run with them, which keeps its own intervals under `withTimestamps`
function mergeModes( off, on ) {

	const scenes = {};
	for ( const [ scene, r ] of Object.entries( on.scenes ) ) {

		const o = off.scenes[ scene ];
		scenes[ scene ] = {
			...r, frames: o.frames, fps: o.fps, interval: o.interval, over16: o.over16, over25: o.over25, over25Count: o.over25Count, hitchThreshold: o.hitchThreshold, hitches: o.hitches,
			js: o.js, jsWall: o.jsWall, submitWait: o.submitWait, waits: o.waits, outsideJs: o.outsideJs, outsideWait: o.outsideWait, contended: o.contended || r.contended, renderScale: o.renderScale,
			...( o.display ? { display: o.display, displayWithTimestamps: r.display } : {} ),
			withTimestamps: { frames: r.frames, fps: r.fps, interval: r.interval, over16: r.over16, over25: r.over25, over25Count: r.over25Count, hitches: r.hitches, js: r.js, renderScale: r.renderScale },
			...( r.raw ? { raw: r.raw, rawWithoutTimestamps: o.raw } : {} ),
		};

	}
	return { scenes, loads: [ ...off.loads.map( ( l ) => ( { ...l, timestamps: false } ) ), ...on.loads.map( ( l ) => ( { ...l, timestamps: true } ) ) ] };

}

function compareReport( runs ) {

	const report = {};
	for ( const scene of Object.keys( runs.A[ 0 ].scenes ) ) {

		const metric = ( f ) => {

			const a = runs.A.map( ( r ) => f( r.scenes[ scene ] ) ), b = runs.B.map( ( r ) => f( r.scenes[ scene ] ) );
			const noise = Math.max( Math.max( ...a ) - Math.min( ...a ), Math.max( ...b ) - Math.min( ...b ) );
			const delta = mean( b ) - mean( a );
			return { a: r2( mean( a ) ), b: r2( mean( b ) ), delta: r2( delta ), ratio: ratio( mean( a ), mean( b ) ), noise: r2( noise ), significant: Math.abs( delta ) > noise };

		};
		const groups = new Set( [ ...runs.A, ...runs.B ].flatMap( ( r ) => Object.keys( r.scenes[ scene ].groups ) ) );
		report[ scene ] = {
			median: metric( ( r ) => r.interval.median ), p95: metric( ( r ) => r.interval.p95 ), p99: metric( ( r ) => r.interval.p99 ),
			gpu: metric( ( r ) => r.gpu.median ), js: metric( ( r ) => r.js.median ),
			groups: Object.fromEntries( [ ...groups ].map( ( g ) => [ g, metric( ( r ) => r.groups[ g ]?.mean ?? 0 ) ] ).sort( ( x, y ) => Math.abs( y[ 1 ].delta ) - Math.abs( x[ 1 ].delta ) ) ),
			// each load's render scale (a dynamic scale settles where its GPU time puts it)
			scale: [ runs.A.map( ( r ) => r.scenes[ scene ].renderScale ?? null ), runs.B.map( ( r ) => r.scenes[ scene ].renderScale ?? null ) ],
		};

	}
	return report;

}

function compareMarkdown( meta, report ) {

	const lines = [ `# Frame profile compare: ${ meta.label }`, '', `A: ${ meta.compare.A }${ meta.compare.evalA ? ` (eval ${ meta.compare.evalA })` : '' }`, `B: ${ meta.compare.B }${ meta.compare.evalB ? ` (eval ${ meta.compare.evalB })` : '' }`, '',
		`${ meta.viewport.width }x${ meta.viewport.height } CSS, DPR ${ meta.viewport.scale }, quality ${ meta.quality }; A B B A per load; noise = the larger run-to-run spread of A or B; * marks a delta beyond it; B/A follows as a ratio.`, '',
		'| scene | scale A / B (each load) | median A -> B (delta, noise) | p95 | p99 | GPU busy | JS tick | largest pass deltas |', '|---|---|---|---|---|---|---|---|' ];
	const cell = ( m ) => `${ fmt( m.a ) } -> ${ fmt( m.b ) } (${ m.delta > 0 ? '+' : '' }${ fmt( m.delta ) }, ±${ fmt( m.noise ) }; ${ ratioText( m.ratio ) })${ m.significant ? ' *' : '' }`;
	for ( const [ scene, r ] of Object.entries( report ) ) {

		const passes = Object.entries( r.groups ).slice( 0, 3 ).map( ( [ g, m ] ) => `${ g } ${ m.delta > 0 ? '+' : '' }${ fmt( m.delta ) }${ m.significant ? '*' : '' }` ).join( ', ' );
		const scales = r.scale ? r.scale.map( ( list ) => list.map( scaleText ).join( ', ' ) ).join( ' / ' ) : '–';
		lines.push( `| ${ scene } | ${ scales } | ${ cell( r.median ) } | ${ cell( r.p95 ) } | ${ cell( r.p99 ) } | ${ cell( r.gpu ) } | ${ cell( r.js ) } | ${ passes } |` );

	}
	return lines.join( '\n' ) + '\n';

}

if ( flags.has( '--report' ) ) {

	// re-render summary.md from a profile.json written earlier (after a change to the report)
	const file = opt( 'report' );
	const data = JSON.parse( await readFile( file, 'utf8' ) );
	const out = path.join( path.dirname( file ), 'summary.md' );
	await writeFile( out, data.reports ? sliceMarkdown( data.meta, data.reports ) : data.report ? compareMarkdown( data.meta, data.report ) : markdownProfile( data.meta, data.runs ) );
	console.log( out );

} else {

	await main();

}
