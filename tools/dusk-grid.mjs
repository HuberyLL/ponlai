// Dusk grid: the scene's light at a grid of sun elevations through the dusk and the dawn, read off
// the running page in scene units, each point reached by the exact scene jump and baked explicitly,
// and judged for the rule that a lower sun never makes a quantity brighter (src/sky/DayCycle.ts:
// the dusk's shares). It answers "does the land, the sky, the sea or the air brighten anywhere as
// the sun goes down, by how much, and which of the night's terms does it", where a few views at
// fixed hours miss a step in between.
//
//   node tools/dusk-grid.mjs [base] [--weathers clear,fair,cloudy,overcast] [--sides evening,morning]
//       [--from 2 --to -8 --step 0.5] [--midnight] [--at e1,e2,...] [--hours h1,h2,...]
//       [--fine e1:e2:step]... [--views island[,<parity view>...]] [--split [name,...]] [--night-split] [--twilight]
//       [--compare dir [--compare-tolerance 1e-4]] [--judge 0.02] [--judge-range 2:-8] [--judge-weathers ...] [--overall-weathers ...]
//       [--haze [--haze-sky 3,5,10,20] [--haze-distances 300,1000]]
//       [--frames] [--walk] [--q "grow=36"] [--src dir] [--out dir] [--timeout ms] [--lock-timeout s]
//
// base: the page's server (default http://127.0.0.1:5190/), a dev server: the reads import the
// page's own modules by path (a production preview has none). `node tools/serve.mjs dev --sha <rev>
// --port N` serves another commit; give its checkout as --src.
//
// The points
//   - Elevations: --from down to --to by --step (default +2 to -8 by 0.5); --to takes down to -18,
//     or `midnight` (-18 and midnight). --midnight adds midnight, the hour 0 (`e: null`, `at:
//     "midnight"`), measured once per weather and shared by both sides. --fine e1:e2:step adds a
//     denser series over a span (repeatable). --at e1,e2,... and --hours h1,h2,... replace the grid
//     with those elevations or clock hours (an hour before noon is the morning's).
//   - The hour of an elevation is solved in node from the sun of --src's src/sky/DayCycle.ts
//     (default: this checkout): a bisection of `sunElevationAt` on the side's half of the day to
//     1e-12 h, checked against `eveningHour` / `morningHour` where the module has them (the largest
//     difference is in summary.txt), and given to the page with 9 decimals. The page's own sun is
//     checked against it after each jump (within 1e-3 degrees), so a page of another arc than
//     --src's fails rather than reading other elevations.
//   - Each point is its own scene jump (main.ts `establishScene`) to `weather=<w>&hour=<h>&paused&t=12`
//     plus --q (default `grow=36`, the grown island: its yunpeng clumps), never reached by walking the
//     clock through the points before it, since the scene is a function of its query (AGENTS.md).
//     --walk instead reaches each point of a side by `__PONLAI__.setHour` in one page, from the
//     side's first point loaded: the path check, against a jump run through --compare.
//   - At each point the figures are hidden, every `sky.dusk.force.*` tunable is set back to -1 (a
//     scene jump keeps tunables), and the views' camera is placed: `island` is the orbit's island
//     view, any other name a parity view's placement (tools/parity/views.mjs `eval`; its query's
//     weather and hour are not taken, and a view whose query places the camera is refused).
//
// A state (the point as it is, or with some shares forced) is taken as: the forces set through the
// page's Tune handle (`sky.dusk.force.<name>`: DayCycle.ts DUSK_FORCES), an explicit bake of the
// environment (sky/SkyRetune.ts, read back as `sky.bakeVersion` rising), then per view the page's
// settled signal (tools/capture-browser.mjs `waitForSettled`) and the reads. The frame loop is
// stopped between points, when the lock may be given up.
//
// The reads (scene units, luminance)
//   CPU: E (pi times the sky's irradiance), Edeck (the deck's, read back), mS (the sky's metering
//   log2) and mS2 = 2^mS, the far sea's seaBody / seaRadiance / seaNight / seaSun, the air's
//   airAmb0 / airAmb1 / airMie0 / airDeckShare / airKeyFloor, keyIsMoon, keyColour, keyCloudFloor,
//   deckKeyFloor, landKeyFloor = keyCloudFloor x keyColour, airKey = deckKeyFloor x keyColour,
//   skyScale, landA = skyScale x E, landSky, sunBounce, daySky, displayAmbientGain, nightSkyLevel,
//   moonVisibility, leafThrough, leafBack, swardTint (luminance of the tint), yunpengNight; sky4,
//   the ring of the environment's baked source (the sky with its haze) 4 degrees up, its
//   mean luminance over every azimuth, and sky4sun / sky4away over the halves within and beyond 90
//   degrees of the sun's azimuth; skyLow4, the same ring 4 degrees down (the sea's half).
//   Per view, on a 256 x 144 grid of cells (3 x 3 texels each; land = cells with no sky and no sea):
//   <view>.EV, .EVt (the exposure, and the value it adapts toward, `exposure.target`), .kappa,
//   .kappaH, .beta (the exposure's keys), .mM and .mH (the meter's trimmed means, computed from
//   its histograms as Metering.ts does, P taken out), .mS (the sky's log, the term the meter reads
//   beside them), .eM, .eH, .eS, .eG (the target's terms as Exposure.ts takes them: the scene's,
//   the highlight's, the sky's and the guarded scene's) with .highlightDecides (1 where e_H lies
//   under e_M, so the soft minimum follows it) and .EVt2 (the target recomputed from them, to check
//   against .EVt), .M and .Mfar (the metering illuminance
//   over the land, and over the land outside the yunpeng's lights' reach), .Yland, .Yfar, .Ysky,
//   .Ysea (the opaque source), .hYland, .hYsky, .hYsea (hdr: with the sea and the air),
//   .yunInner, .yunRing, .yunMInner, .yunMRing (the cells a clump covers, and the ring to three
//   times its size: radiance and M).
//   Weights (reported, never judged): the snapshot's moonKeyGain, handoff, daylight,
//   nightVisibility, nightSkyLevel, moonVisibility, overcastAdaptation; gradeNight (the display's
//   night) and gradeExposureNight (the exposure's: the `exposureNight` force sets the weight the
//   exposure's keys take, apart from the display's); moonKeyShare,
//   nightAmbientShare, displayNight, exposureNight, starNight at this sun; and `share.<name>`, each forced share's value as the code made it
//   (DayCycle.ts `duskShares`: a number, or [ least, greatest ] when its readers took several).
//
// --haze: at each point, after the point's own state, the haze in a view of its own (`haze-rows`:
// 65 m over the sea at the land box's +x edge, its back to the island, facing the open sea, pitched
// 10 degrees up with a vertical field of 30; one pose everywhere, since the ground layer's width
// follows the camera's height), once the page has settled there:
//   - hazeMedium: every item of the haze's key as the frame set it (main.ts `hazeKey`, `key.*`), the
//     haze's copy of it (`look.*`), its medium's uniforms (`air.*`: the weather's haze and fog, the
//     layers, the ground layer's width rule, sigma, the dome's own depth, the near haze), the
//     clouds' copy of the medium (`clouds.*`), the moon's aerosol keys (`moon.*`, Tune
//     `haze.moon.*`) and the settings (`settings.*`); vectors flattened (`.0`, `.1`, ...), non-finite
//     numbers as text. The light's colours are not in it.
//   - hazeOpacity: 1 - T per display channel and the light at full opacity (VolumetricHaze.probe,
//     the composite's own nodes on the GPU) along the view's azimuth: `sky <e>` at each --haze-sky
//     elevation (the medium to the atmosphere's top, without the dome's own thin haze) and
//     `level <d> m` at the camera's height over a surface at each --haze-distances (the composite's
//     fog over it, the volume and the rest beyond it). A ray outside the view's frustum is not read
//     (null, and `hazeOutside`).
// Then the point's view is placed again for the states that follow. summary.txt lists the opacity;
// --compare judges hazeMedium bit for bit at every point both runs hold (the deck's shares
// `key.deck`, `key.overcastDeck` listed, not judged), the differing items by name.
//
// --split [names] (default every DUSK_FORCES name; the twilight's are sun, hazeSun, hazeSky)
//   - Per name, states with the share forced to 0 (q0) and to 1 (q1); the point itself is q. A
//     twilight's share is a weight that is 1 unforced, so its q1 is q. A forced value equal to the
//     share's own (an exact 0 or 1 in every reader, from `share.<name>`) is not taken again: that
//     state is q (never for hazeNight, which has no value of its own).
//   - Cumulative: from every night name of the split forced to 0 (T, the twilight) the names are put
//     back one at a time in DUSK_FORCES order; `inc` is what each one adds. The last state (nothing
//     forced) is taken again and must equal q bit for bit, else the point is void (reported, exit 1);
//     the reads of the hdr source (hY*, mH) within --compare-tolerance, since the haze's rest after
//     other states puts a cell's fourth digit a unit apart now and then (its largest: `hdrDrift`).
//   - Residual: T + sum over the night names of ( q - q0 ) - q, per quantity; over 1 % of q it is
//     listed in summary.txt (terms that act on each other: a product of shares).
// --night-split: the twilight forced to 0 (sun, hazeSun, hazeSky): the night's terms alone
//   (`night`), and the local lights forced off alone (`noLights`).
// --twilight: the twilight alone, every night name of DUSK_FORCES forced to 0 (the split's T, as
//   `cumulative.T`), without the split's other states: where the twilight and the night cross,
//   read against the night of another point (midnight), at a few seconds a point. Not with --split,
//   which takes T itself.
//
// The rules (summary.txt; violations exit 1)
//   - Step: on the grid's adjacent points within --judge-range (default +2 to -8), q( lower ) <=
//     ( 1 + judge ) q( higher ) for E, Edeck, mS2, landA, seaRadiance, airAmb0 and every view's
//     Mfar; a cell over it is marked *. Weathers: --judge-weathers (default all run).
//   - Overall: over every point from the range's top down, midnight included, the largest rise
//     q( e' ) / q( e ) for e' < e and the pair; over 1 + judge it is marked #, and judged only for
//     --overall-weathers (default all run).
//   - Exposure, per view: EV( lower ) >= EV( higher ) - log2( 1 + judge ) on the step pairs, else
//     marked ! with the change of kappa and of m_M (EV = kappa - m_M, blended with the sky's); EV at
//     night less EV at the range's top is reported.
//   - Fine (each --fine series): a rise between adjacent points of at most judge x step / 0.5.
//   Reported, not judged: M, Yland, landKeyFloor, airKey, airMie0, the yunpeng's cells, leafThrough,
//   leafBack, swardTint, sky4, sky4sun, sky4away, the hdr luminances.
//
// Output (--out, default artifacts/dusk-grid/<time>; frames there too, never in git)
//   <weather>-<side>.json: { version: 1, sha (--src's HEAD), base, query, weather, side, weathers,
//     sides, grid, views, split, points: [ { key, e, at, hour, elevation, values, weights, shares?:
//     { <name>: { w, q0, q1, inc } } (q is the point's `values`), cumulative?: { T }, residual?,
//     void?, night?, noLights?, hazeMedium?, hazeOpacity?, hazePose?, hazeOutside?, frame?, error?,
//     warnings? } ] }, written after every point;
//   summary.txt: the values per point, then per weather and side the steps (%), the overall rises,
//     the exposure's steps, the fine series, the residuals, the void points and errors;
//   handoff.txt (with --split and midnight): per weather e_d (the highest point whose key has
//     turned to the moon, snapshot `handoff` 1), the land's twilight ambient there T( e_d ) (Mfar in
//     the T state), the moon's key at night K = q - q0( moonKey ) at midnight, and the condition
//     T( e_d ) - T( night ) >= K (pass / fail) with T( e_d ) / K; then the line
//     `floor <weather> landKeyFloor(night)/M(night) = x.xx %` (landKeyFloor / pi over M, M being
//     lum( E ) / pi; marked under or over 5 %), with the key's measured share
//     of M at night beside it;
//   terms.txt (with --split, --night-split or --twilight): per quantity and point, q, T, each night name's inc,
//     the residual, `night` and `noLights`;
//   compare.txt (--compare dir): every point both runs hold, value by value. In [+2.5, +4] the CPU
//     values and the weights must be bit for bit the same, and the views' reads (GPU reads) within
//     --compare-tolerance (default 1e-4 relative): two pages loaded on the same commit, one
//     walking the clock and one jumping, read a mean of the hdr source (the sea, the land through
//     the air) a few 1e-8 apart at a point in ten, and an opaque cell can land a unit apart in its
//     fourth significant digit (Radiance.ts rounds each cell to four), while one page reaching a
//     point twice by the jump reads it again bit for bit; the largest view difference is in
//     compare.txt. A difference past the tolerance is a violation. With --haze in both runs, the
//     haze's medium is judged bit for bit at every point (above); each point it differs at is a
//     violation, and the opacity's largest difference is reported. With --night-split in both runs
//     it lists the lift, the island view's metered EV with the lamps off less the other run's at
//     each point both hold, and at midnight that lift less NIGHT_METER_LIFT (DayCycle.ts): run
//     against a page of the night those keys were set over, it says how far the night keys and the
//     constant lie from what the meter now gives (DayCycle.ts EXPOSURE_KEYS).
//
// Exit codes: 0 every judged rule held; 1 a rule was broken, a point is void, or --compare found a
// difference in [+2.5, +4]; 2 an option or the page went wrong (an unknown option, a page error,
// a point that did not settle: what was measured is still written); 3 the GPU lock stayed held for
// --lock-timeout seconds and nothing was measured.
//
// The tool takes the GPU lock itself (run it unwrapped): shared, since the reads do not depend on
// what else renders, and leased per point (leaseGpuLock), the loop stopped while it may be given up. A run of the four weathers, both sides,
// +2 to -14 and midnight with --split takes hours: run it through tools/job.mjs.
import './qos.mjs'; // first: the summary's CPU work runs with the application policy
import { acquireGpuLock, leaseGpuLock, releaseGpuLock } from './gpu-lock.mjs';
import { launchCapture, pngShooter, stopLoop, waitForScene, waitForSettled } from './capture-browser.mjs';
import { WAIT_FRAMES, runInPage } from './page-eval.mjs';
import { VIEWS, viewEval } from './parity/views.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const USAGE = 'usage: node tools/dusk-grid.mjs [base] [--weathers ...] [--sides ...] [--from 2 --to -8 --step 0.5] [--midnight] [--at ...] [--hours ...] [--fine e1:e2:step]... [--views ...] [--split [names]] [--night-split] [--twilight] [--compare dir [--compare-tolerance 1e-4]] [--judge 0.02] [--judge-range 2:-8] [--judge-weathers ...] [--overall-weathers ...] [--haze [--haze-sky 3,5,10,20] [--haze-distances 300,1000]] [--frames] [--walk] [--q query] [--src dir] [--out dir] [--timeout ms] [--lock-timeout s] (see the file header)';
const WEATHERS = [ 'clear', 'fair', 'cloudy', 'overcast', 'rain', 'storm', 'fog' ];
const SIDES = [ 'evening', 'morning' ];
const TWILIGHT = [ 'sun', 'hazeSun', 'hazeSky' ];
const FORCE = 'sky.dusk.force.';
const JUDGED = [ 'E', 'Edeck', 'mS2', 'landA', 'seaRadiance', 'airAmb0' ];
const JUDGED_VIEW = [ 'Mfar' ];
const REPORTED = [ 'landKeyFloor', 'airKey', 'airMie0', 'leafThrough', 'leafBack', 'swardTint', 'sky4', 'sky4sun', 'sky4away' ];
const REPORTED_VIEW = [ 'M', 'Yland', 'yunInner', 'yunRing', 'yunMInner', 'yunMRing', 'hYland', 'hYsky', 'hYsea', 'EV' ];
const WINDOW = [ 2.5, 4 ];
const HDR_READS = [ 'hYland', 'hYsky', 'hYsea', 'mH' ];

class ArgError extends Error {}
const fail = ( message ) => { throw new ArgError( message ); };

// ---- options
const argv = process.argv.slice( 2 );
const o = { weathers: 'clear,fair,cloudy,overcast', sides: 'evening,morning', from: '2', to: '-8', step: '0.5', views: 'island',
	judge: '0.02', 'judge-range': '2:-8', 'compare-tolerance': '1e-4', q: 'grow=36', timeout: '120000', 'lock-timeout': '0', fine: [],
	'haze-sky': '3,5,10,20', 'haze-distances': '300,1000' };
let base = 'http://127.0.0.1:5190/';
const FLAGS = [ 'midnight', 'night-split', 'twilight', 'frames', 'walk', 'haze' ];
const VALUED = [ 'weathers', 'sides', 'from', 'to', 'step', 'at', 'hours', 'views', 'compare', 'compare-tolerance', 'judge', 'judge-range', 'judge-weathers', 'overall-weathers', 'q', 'src', 'out', 'timeout', 'lock-timeout', 'haze-sky', 'haze-distances' ];
let options;
try {

	for ( let i = 0; i < argv.length; i ++ ) {

		const a = argv[ i ];
		if ( ! a.startsWith( '--' ) ) { base = a; continue; }
		const k = a.slice( 2 );
		if ( FLAGS.includes( k ) ) { o[ k ] = true; continue; }
		if ( k === 'split' ) { o.split = argv[ i + 1 ] && ! argv[ i + 1 ].startsWith( '--' ) ? argv[ ++ i ] : ''; continue; }
		if ( k !== 'fine' && ! VALUED.includes( k ) ) fail( `unknown option --${ k }` );
		const v = argv[ ++ i ];
		if ( v === undefined ) fail( `--${ k } needs a value` );
		if ( k === 'fine' ) o.fine.push( v );
		else o[ k ] = v;

	}
	options = parseOptions( o );

} catch ( error ) {

	if ( ! ( error instanceof ArgError ) ) throw error;
	console.error( `dusk-grid: ${ error.message }\n${ USAGE }` );
	process.exit( 2 );

}

function num( text, name ) {

	const x = Number( text );
	if ( text === '' || ! Number.isFinite( x ) ) fail( `${ name }: ${ JSON.stringify( text ) } is not a number` );
	return x;

}

function list( text, known, name ) {

	const names = String( text ).split( ',' ).map( ( s ) => s.trim() ).filter( Boolean );
	for ( const n of names ) if ( known && ! known.includes( n ) ) fail( `${ name }: unknown ${ JSON.stringify( n ) } (${ known.join( ', ' ) })` );
	return names;

}

function parseOptions( o ) {

	const weathers = list( o.weathers, WEATHERS, '--weathers' );
	const sides = list( o.sides, SIDES, '--sides' );
	const step = num( o.step, '--step' );
	if ( step <= 0 ) fail( '--step must be positive' );
	const from = num( o.from, '--from' );
	const midnight = o.midnight === true || o.to === 'midnight';
	const to = o.to === 'midnight' ? - 18 : num( o.to, '--to' );
	if ( to < - 18 ) fail( '--to takes down to -18 (and midnight)' );
	if ( from < to ) fail( '--from lies below --to' );
	const fine = o.fine.map( ( f ) => {

		const [ a, b, s ] = f.split( ':' ).map( ( x ) => num( x, '--fine' ) );
		if ( ! ( s > 0 ) || a === undefined || b === undefined ) fail( `--fine ${ f }: give e1:e2:step` );
		return { hi: Math.max( a, b ), lo: Math.min( a, b ), step: s };

	} );
	const [ jHi, jLo ] = o[ 'judge-range' ].split( ':' ).map( ( x ) => num( x, '--judge-range' ) );
	if ( jLo === undefined ) fail( '--judge-range: give e1:e2' );
	const views = list( o.views, null, '--views' );
	for ( const v of views ) {

		if ( v === 'island' ) continue;
		if ( ! VIEWS[ v ] ) fail( `--views: unknown view ${ JSON.stringify( v ) } (island or a parity view)` );
		if ( /(^|&)(dist|polar|az|camera)=/.test( VIEWS[ v ].q ) ) fail( `--views: ${ v } places its camera by its query, which a point's jump would not take` );

	}
	const timeout = num( o.timeout, '--timeout' ), lockTimeout = num( o[ 'lock-timeout' ], '--lock-timeout' );
	const at = o.at !== undefined ? list( o.at, null, '--at' ).map( ( x ) => num( x, '--at' ) ) : null;
	const hours = o.hours !== undefined ? list( o.hours, null, '--hours' ).map( ( x ) => num( x, '--hours' ) ) : null;
	if ( at && hours ) fail( '--at and --hours: give one' );
	const judge = num( o.judge, '--judge' );
	const hazeSky = list( o[ 'haze-sky' ], null, '--haze-sky' ).map( ( x ) => num( x, '--haze-sky' ) );
	const hazeDistances = list( o[ 'haze-distances' ], null, '--haze-distances' ).map( ( x ) => num( x, '--haze-distances' ) );
	if ( hazeSky.some( ( e ) => e <= 0 || e >= 90 ) ) fail( '--haze-sky: elevations between 0 and 90 degrees' );
	if ( hazeDistances.some( ( d ) => d <= 0 ) ) fail( '--haze-distances: positive distances in metres' );
	if ( hazeSky.length + hazeDistances.length > 64 ) fail( '--haze-sky, --haze-distances: at most 64 rays in all (VolumetricHaze.probe)' );
	const src = path.resolve( o.src ?? ROOT );
	if ( ! existsSync( path.join( src, 'src/sky/DayCycle.ts' ) ) ) fail( `--src ${ src }: no src/sky/DayCycle.ts there` );
	return {
		weathers, sides, from, to, step, midnight, fine, at, hours, views, judge,
		judgeRange: [ Math.max( jHi, jLo ), Math.min( jHi, jLo ) ],
		judgeWeathers: o[ 'judge-weathers' ] ? list( o[ 'judge-weathers' ], WEATHERS, '--judge-weathers' ) : weathers,
		overallWeathers: o[ 'overall-weathers' ] ? list( o[ 'overall-weathers' ], WEATHERS, '--overall-weathers' ) : weathers,
		split: o.split, nightSplit: o[ 'night-split' ] === true, twilight: o.twilight === true, frames: o.frames === true, walk: o.walk === true,
		haze: o.haze === true, hazeSky, hazeDistances,
		compare: o.compare ? path.resolve( o.compare ) : null, compareTolerance: num( o[ 'compare-tolerance' ], '--compare-tolerance' ), q: o.q, src, timeout, lockTimeout,
		out: path.resolve( o.out ?? path.join( ROOT, 'artifacts/dusk-grid', new Date().toISOString().replace( /[:.]/g, '-' ).slice( 0, 19 ) ) ),
	};

}

// ---- the sun of --src, the points
const DC = await import( pathToFileURL( path.join( options.src, 'src/sky/DayCycle.ts' ) ).href );
const FORCES = DC.DUSK_FORCES ?? [];
let splitNames = [];
try {

	if ( options.split !== undefined ) {

		if ( ! FORCES.length ) fail( `--split: ${ options.src } has no DUSK_FORCES` );
		splitNames = options.split === '' ? [ ...FORCES ] : list( options.split, FORCES, '--split' );
		splitNames = FORCES.filter( ( n ) => splitNames.includes( n ) );

	}
	if ( options.nightSplit && ! TWILIGHT.every( ( n ) => FORCES.includes( n ) ) ) fail( `--night-split: ${ options.src } has no twilight forces` );
	if ( options.twilight && options.split !== undefined ) fail( '--twilight: --split takes T itself' );
	if ( options.twilight && ! FORCES.length ) fail( `--twilight: ${ options.src } has no DUSK_FORCES` );

} catch ( error ) {

	if ( ! ( error instanceof ArgError ) ) throw error;
	console.error( `dusk-grid: ${ error.message }\n${ USAGE }` );
	process.exit( 2 );

}
const nightNames = splitNames.filter( ( n ) => ! TWILIGHT.includes( n ) );
// (--twilight's: every night name the page can force)
const twilightNames = options.twilight ? FORCES.filter( ( n ) => ! TWILIGHT.includes( n ) ) : [];
let hourCheck = 0;

/** The hour on `side` at which the sun of --src stands `e` degrees up (see the header). */
function hourOf( e, side ) {

	const evening = side === 'evening';
	let lo = evening ? 12 : 0, hi = lo + 12;
	for ( let i = 0; i < 80; i ++ ) {

		const mid = ( lo + hi ) / 2;
		if ( ( DC.sunElevationAt( mid ) > e ) === evening ) lo = mid;
		else hi = mid;

	}
	const h = ( lo + hi ) / 2;
	const named = evening ? DC.eveningHour : DC.morningHour;
	if ( named ) hourCheck = Math.max( hourCheck, Math.abs( named( e ) - h ) );
	return h;

}

const round6 = ( x ) => Math.round( x * 1e6 ) / 1e6;
const keyOf = ( e ) => ( e >= 0 ? '+' : '' ) + e.toFixed( 3 );

/** The points of a side in its clock's order, each { key, e, at, hour, hourText, grid, fine }. */
function pointsOf( side ) {

	const byKey = new Map();
	const add = ( e, tag ) => {

		e = round6( e );
		const key = keyOf( e );
		const p = byKey.get( key ) ?? { key, e, at: null, grid: false, fine: [] };
		if ( tag === 'grid' ) p.grid = true;
		else if ( tag !== undefined ) p.fine.push( tag );
		byKey.set( key, p );

	};
	if ( options.hours ) {

		for ( const h of options.hours ) if ( ( h < 12 ? 'morning' : 'evening' ) === side ) byKey.set( `h${ h.toFixed( 6 ) }`, { key: `h${ h.toFixed( 6 ) }`, e: round6( DC.sunElevationAt( h ) ), at: null, grid: true, fine: [], hour: h } );

	} else if ( options.at ) for ( const e of options.at ) add( e, 'grid' );
	else for ( let i = 0; ; i ++ ) {

		const e = round6( options.from - i * options.step );
		if ( e < options.to - 1e-9 ) break;
		add( e, 'grid' );

	}
	options.fine.forEach( ( f, k ) => {

		for ( let i = 0; ; i ++ ) {

			const e = round6( f.hi - i * f.step );
			if ( e < f.lo - 1e-9 ) break;
			add( e, k );

		}

	} );
	const points = [ ...byKey.values() ];
	for ( const p of points ) {

		p.hour ??= hourOf( p.e, side );
		p.hourText = p.hour.toFixed( 9 );

	}
	if ( options.midnight ) points.push( { key: 'midnight', e: null, at: 'midnight', grid: true, fine: [], hour: 0, hourText: '0' } );
	// the clock's order: the evening's sun goes down to midnight, the morning's comes up from it
	const order = ( p ) => p.at === 'midnight' && side === 'evening' ? 24 : p.hour;
	return points.sort( ( a, b ) => order( a ) - order( b ) );

}

// ---- the page
const NOTE = ( text ) => console.log( `[dusk-grid ${ new Date().toTimeString().slice( 0, 8 ) }] ${ text }` );
const PAGE = String.raw`
const s = window.__PONLAI__, sky = s.sky;
const lum = ( c ) => 0.2126 * c[ 0 ] + 0.7152 * c[ 1 ] + 0.0722 * c[ 2 ];
const DEG = Math.PI / 180, NX = 256, NY = 144, CELLS = { grid: [ NX, NY ], cell: 3, boxes: {} };
const tick = () => new Promise( ( r ) => { const t = setTimeout( r, 100 ); requestAnimationFrame( () => { clearTimeout( t ); r(); } ); } );
const waitFor = async ( fn, ms, what ) => { const end = performance.now() + ms; for ( ;; ) { const v = await fn(); if ( v ) return v; if ( performance.now() > end ) throw new Error( 'dusk-grid: ' + what + ' not within ' + ms + ' ms' ); await tick(); } };
const load = async ( p ) => { try { return await import( p ); } catch { return {}; } };
const G = window.__duskGrid ??= { masks: {} };
const FORCE = 'sky.dusk.force.';
const forceNames = () => s.tune ? s.tune.list().filter( ( t ) => t.name.startsWith( FORCE ) ).map( ( t ) => t.name.slice( FORCE.length ) ) : [];
`;

const prepareJs = () => `async () => { ${ PAGE }
	const reset = {};
	for ( const n of forceNames() ) reset[ FORCE + n ] = - 1;
	if ( Object.keys( reset ).length ) s.tune.set( reset );
	if ( s.characters ) s.characters.group.visible = false;
	G.masks = {};
	return { forces: forceNames(), elevation: sky.elevation, hour: s.dayCycle.hour };
}`;

const applyJs = ( forces ) => `async () => { ${ PAGE }
	const DC = await load( '/src/sky/DayCycle.ts' ), RT = await load( '/src/sky/SkyRetune.ts' );
	const forced = ${ JSON.stringify( forces ) }, values = {};
	for ( const n of forceNames() ) values[ FORCE + n ] = forced[ n ] ?? - 1;
	s.loop.start();
	const v0 = sky.bakeVersion;
	DC.duskShares?.clear();
	const applied = Object.keys( values ).length ? s.tune.set( values ).applied : [];
	// (a force that changed rebaked already: tune.set runs the sky's retune at once)
	if ( ! applied.length ) RT.markSkyRetune();
	await waitFor( () => sky.bakeVersion > v0, ${ options.timeout }, 'the bake' );
	// a few frames of the new state before the settled signal is asked: tune.set bakes at once, and
	// the diagnostics' signal is still the last frame's (the state before) until a frame has run
	await ( ${ WAIT_FRAMES } )( 3, ${ options.timeout } );
	return applied.length;
}`;

const ISLAND_VIEW = `(() => { const s = window.__PONLAI__; s.setCameraMode( 'orbit' ); s.setCameraView( 'island' ); })()`;
const viewJs = ( view ) => view === 'island' ? ISLAND_VIEW : viewEval( view, [] );

// --haze: the haze's own view, one pose at every point (the ground layer's width follows the
// camera's height, so the height is fixed): 65 m over the sea at the land box's +x edge, its back to
// the island, facing the open sea along +x, pitched 10 degrees up with a vertical field of 30, so
// the horizon and the sky up to 25 degrees are in the frame
const HAZE_HEIGHT = 65, HAZE_PITCH = 10, HAZE_FOV = 30;
const HAZE_VIEW = `(() => { const s = window.__PONLAI__, b = s.controls.ground.bounds, cz = ( b.min.z + b.max.z ) / 2, e = ${ HAZE_PITCH } * Math.PI / 180;
	s.setCameraView?.( 'island' ); s.setCameraMode( 'free' ); s.camera.position.set( b.max.x, ${ HAZE_HEIGHT }, cz );
	s.camera.lookAt( b.max.x + Math.cos( e ) * 1000, ${ HAZE_HEIGHT } + Math.sin( e ) * 1000, cz ); s.camera.fov = ${ HAZE_FOV }; s.camera.updateProjectionMatrix(); })()`;

// The haze's medium as the frame holds it (every item of main.ts's HazeKey, the haze's own medium
// uniforms and key copy, the clouds' copy of the medium, the moon's aerosol keys, the settings;
// vectors flattened, non-finite numbers as text so the JSON keeps them), and its opacity over the
// view's azimuth: sky rays at each --haze-sky elevation (the medium to the atmosphere's top, without
// the dome's own haze) and level rays at the camera's height over a surface at each --haze-distances
// (the composite's fog over it), read on the GPU by VolumetricHaze.probe. A ray outside the view's
// frustum (the probe takes the composite's grid projection) is not read: null, listed.
const hazeReadJs = () => `async () => { ${ PAGE }
	const air = s.pipeline.air, cam = s.camera, medium = {};
	const put = ( name, v ) => {

		if ( v && typeof v.toArray === 'function' ) v = v.toArray();
		if ( Array.isArray( v ) ) { v.forEach( ( x, i ) => put( name + '.' + i, x ) ); return; }
		medium[ name ] = typeof v === 'number' && ! Number.isFinite( v ) ? String( v ) : v;

	};
	for ( const [ k, v ] of Object.entries( s.hazeKey ) ) put( 'key.' + k, v );
	for ( const [ k, v ] of Object.entries( air.look ) ) put( 'look.' + k, v );
	for ( const k of [ 'haze', 'fog', 'layer', 'ground', 'widthRule', 'sigma', 'skyDepth', 'near' ] ) put( 'air.' + k, air[ k ].value );
	const clouds = air.cloudMedium ?? sky.clouds?.haze;
	if ( clouds ) for ( const k of [ 'layer', 'ground', 'near', 'sigma' ] ) put( 'clouds.' + k, clouds[ k ].value );
	for ( const k of [ 'red', 'blue', 'gain', 'mieG' ] ) put( 'moon.' + k, s.tune.get( 'haze.moon.' + k ) );
	for ( const [ k, v ] of Object.entries( air.settings ) ) put( 'settings.' + k, v );
	cam.updateMatrixWorld();
	const f = cam.getWorldDirection( cam.position.clone() ), len = Math.hypot( f.x, f.z ), fx = f.x / len, fz = f.z / len;
	const rays = [], names = [], outside = [];
	const add = ( name, elevation, distance ) => {

		const e = elevation * DEG, d = { x: Math.cos( e ) * fx, y: Math.sin( e ), z: Math.cos( e ) * fz };
		// in the frame: in front of the camera and inside its projection (unjittered under MSAA)
		const v = cam.position.clone().set( d.x, d.y, d.z ).transformDirection( cam.matrixWorldInverse );
		const p = cam.position.clone().set( d.x, d.y, d.z ).multiplyScalar( 1000 ).add( cam.position ).project( cam );
		if ( ! ( v.z < 0 && Math.abs( p.x ) <= 1 && Math.abs( p.y ) <= 1 ) ) { outside.push( name ); return; }
		rays.push( distance === undefined ? { direction: d } : { direction: d, distance } );
		names.push( name );

	};
	for ( const e of ${ JSON.stringify( options.hazeSky ) } ) add( 'sky ' + e, e );
	for ( const m of ${ JSON.stringify( options.hazeDistances ) } ) add( 'level ' + m + ' m', 0, m );
	const read = rays.length ? await air.probe( s.renderer, rays ) : [];
	const opacity = {};
	for ( const n of outside ) opacity[ n ] = null;
	names.forEach( ( n, i ) => { opacity[ n ] = { opacity: read[ i ].opacity, light: read[ i ].light }; } );
	return { medium, opacity, outside, pose: { position: cam.position.toArray(), forward: [ fx, 0, fz ], pitch: ${ HAZE_PITCH }, fov: cam.fov, aspect: cam.aspect } };
}`;

const readJs = ( view, cpu ) => `async () => { ${ PAGE }
	const out = {}, view = ${ JSON.stringify( view ) };
	const g = s.controls.ground;
	if ( ! G.masks[ view ] ) {

		// the cells' kinds from the depth AOV (sky and sea shares), the yunpeng's clumps and their
		// lights' reach projected on the current camera
		const dep = ( await s.radiance( { grid: [ NX, NY ], cell: 3, aov: 'depth' } ) ).values;
		const n = NX * NY, land = new Uint8Array( n ), near = new Uint8Array( n ), inner = new Uint8Array( n ), ring = new Uint8Array( n ), skyM = new Uint8Array( n ), seaM = new Uint8Array( n );
		for ( let c = 0; c < n; c ++ ) {

			land[ c ] = dep[ 3 * c + 1 ] === 0 && dep[ 3 * c + 2 ] === 0 && dep[ 3 * c ] > 0 ? 1 : 0;
			skyM[ c ] = dep[ 3 * c + 1 ] > 0.99 ? 1 : 0;
			seaM[ c ] = dep[ 3 * c + 2 ] > 0.99 ? 1 : 0;

		}
		const Y = s.yunpengSites ? s.yunpengSites() : { clumps: [], lights: [] }, cam = s.camera, clumps = [];
		const f = ( NY / 2 ) / Math.tan( cam.fov * DEG / 2 );
		for ( let i = 0; i < Y.clumps.length / 3; i ++ ) {

			const x = Y.clumps[ 3 * i ], z = Y.clumps[ 3 * i + 1 ], size = Y.clumps[ 3 * i + 2 ];
			const p = new cam.position.constructor( x, g.heightAt( x, z ) + size * 0.5, z );
			const d = p.distanceTo( cam.position );
			p.project( cam );
			if ( p.z > 1 || Math.abs( p.x ) > 1.2 || Math.abs( p.y ) > 1.2 ) continue;
			clumps.push( { cx: ( p.x + 1 ) / 2 * NX, cy: ( 1 - p.y ) / 2 * NY, rSize: Math.max( size * f / d, 1 ), rLight: Math.max( ( Y.lights[ i ]?.range ?? 6 ) * f / d, 1 ) } );

		}
		for ( let c = 0; c < n; c ++ ) {

			const x = c % NX + 0.5, y = Math.floor( c / NX ) + 0.5;
			for ( const k of clumps ) {

				const r = Math.hypot( x - k.cx, y - k.cy );
				if ( r <= k.rLight ) near[ c ] = 1;
				if ( r <= k.rSize ) inner[ c ] = 1;
				else if ( r <= 3 * k.rSize ) ring[ c ] = 1;

			}

		}
		G.masks[ view ] = { land, near, inner, ring, skyM, seaM, clumps: clumps.length };

	}
	const K = G.masks[ view ];
	const mean = ( v, m ) => { let t = 0, k = 0; for ( let c = 0; c < v.length; c ++ ) if ( m( c ) && Number.isFinite( v[ c ] ) && v[ c ] > 0 ) { t += v[ c ]; k ++; } return k ? t / k : null; };
	const lums = ( rgb ) => { const y = new Float64Array( NX * NY ); for ( let c = 0; c < y.length; c ++ ) y[ c ] = lum( [ rgb[ 3 * c ], rgb[ 3 * c + 1 ], rgb[ 3 * c + 2 ] ] ); return y; };
	if ( ${ cpu } ) {

		const R = s.ambientRelight, air = s.pipeline.air, snap = s.dayCycle.snapshot();
		const AG = await load( '/src/lighting/AmbientGrade.ts' ), LL = await load( '/src/world/vegetation/LeafLight.ts' ), YP = await load( '/src/world/Yunpeng.ts' );
		const DC = await load( '/src/sky/DayCycle.ts' ), W = await load( '/src/sky/Weather.ts' );
		const px = async ( rt ) => Array.from( await s.renderer.readRenderTargetPixelsAsync( rt, 0, 0, 1, 1 ) );
		// a ring of the environment's source (the baked sky with its haze, in half floats)
		// at deg degrees: its mean luminance over every azimuth and over the halves toward and away
		// from the sun (the sun's azimuth within 90 degrees or beyond)
		const ring = async ( deg ) => {

			const t = sky.reflectionSource?.texture, b = t && s.renderer.backend.get( t );
			if ( ! b?.texture || b.textureDescriptorGPU.format !== 'rgba16float' ) return null;
			// (the source stores the radiance times its bake's power of two, an older page's times
			// PANORAMA_STORE)
			const store = sky.sourceStops !== undefined ? 2 ** sky.sourceStops : ( await load( '/src/sky/Sky.ts' ) ).PANORAMA_STORE ?? 1;
			const W = t.image.width, H = t.image.height, y = ( deg / 180 + 0.5 ) * H - 0.5, y0 = Math.floor( y ), f = y - y0;
			const half = await s.renderer.backend.textureUtils.copyTextureToBuffer( t, 0, y0, W, 2, 0 ), row = Math.ceil( W * 8 / 256 ) * 128;
			const h = ( i ) => { const e = ( i >> 10 ) & 31, m = i & 1023; return ( i >> 15 ? - 1 : 1 ) * ( e === 0 ? m * 2 ** - 24 : ( 1 + m / 1024 ) * 2 ** ( e - 15 ) ); };
			const sun = Math.atan2( sky.sunDir.z, sky.sunDir.x );
			let all = 0, near = 0, far = 0, nNear = 0;
			for ( let x = 0; x < W; x ++ ) {

				const c = ( k ) => ( ( 1 - f ) * h( half[ x * 4 + k ] ) + f * h( half[ row + x * 4 + k ] ) ) / store;
				const L = lum( [ c( 0 ), c( 1 ), c( 2 ) ] );
				all += L;
				if ( Math.cos( ( ( x + 0.5 ) / W - 0.5 ) * 2 * Math.PI - sun ) >= 0 ) { near += L; nNear ++; } else far += L;

			}
			return { all: all / W, near: nNear ? near / nNear : null, far: nNear < W ? far / ( W - nNear ) : null };

		};
		const sky4 = await ring( 4 ), skyLow4 = await ring( - 4 );
		const deck = lum( await px( sky.deckIrradianceDisplay ) ), disp = await px( sky.irradianceDisplay );
		const st = sky.endpoints?.[ sky.front ]?.sea, kc = lum( sky.keyColor.toArray() ), E = Math.PI * lum( sky.skyIrradiance.toArray() );
		const v = ( x ) => x === undefined ? null : typeof x === 'boolean' ? ( x ? 1 : 0 ) : x;
		Object.assign( out, {
			elevation: sky.elevation, hour: s.dayCycle.hour, E, Edeck: Math.PI * deck, mS: disp[ 3 ], mS2: 2 ** disp[ 3 ],
			seaBody: st ? lum( st.body.toArray() ) : null, seaRadiance: st ? lum( st.radiance.toArray() ) : null, seaNight: st ? lum( st.night.toArray() ) : null, seaSun: v( st?.sun ),
			airAmb0: lum( air.ambientColour[ 0 ].value.toArray() ), airAmb1: lum( air.ambientColour[ 1 ].value.toArray() ), airMie0: lum( air.mieColour[ 0 ].value.toArray() ),
			airDeckShare: v( air.deckShare?.value ), airKeyFloor: v( air.keyFloor?.value ),
			keyIsMoon: v( sky.keyIsMoon ), keyColour: kc, keyCloudFloor: sky.keyCloudFloor.value, deckKeyFloor: sky.deckKeyFloor,
			landKeyFloor: sky.keyCloudFloor.value * kc, airKey: sky.deckKeyFloor * kc,
			skyScale: R.skyScale.value, landA: R.skyScale.value * E, landSky: v( AG.ambient?.landSky.value ), sunBounce: v( AG.ambient?.sunBounce.value ),
			daySky: v( sky.daySky ), displayAmbientGain: v( sky.displayAmbientGain?.value ), nightSkyLevel: v( snap.nightSkyLevel ), moonVisibility: v( snap.moonVisibility ),
			leafThrough: v( LL.leafThrough?.value ), leafBack: v( LL.leafBack?.value ), swardTint: s.shared?.swardTint ? lum( s.shared.swardTint.value.toArray() ) : null,
			yunpengNight: v( YP.yunpengNight?.value ),
			sky4: sky4?.all ?? null, sky4sun: sky4?.near ?? null, sky4away: sky4?.far ?? null, skyLow4: skyLow4?.all ?? null,
		} );
		const e = sky.elevation, rising = sky.rising, cloud = W.cloudedShare ? W.cloudedShare( s.weather.skyMix ) : null;
		const w = { moonKeyGain: v( snap.moonKeyGain ), handoff: v( snap.handoff ), daylight: v( snap.daylight ), nightVisibility: v( snap.nightVisibility ),
			nightSkyLevel: v( snap.nightSkyLevel ), moonVisibility: v( snap.moonVisibility ), overcastAdaptation: v( snap.overcastAdaptation ),
			gradeNight: v( s.pipeline.settings.night ), gradeExposureNight: v( s.pipeline.settings.exposureNight ), cloud, rising: v( rising ) };
		if ( DC.moonKeyShare ) w.moonKeyShare = DC.moonKeyShare( e );
		if ( DC.nightAmbientShare ) w.nightAmbientShare = DC.nightAmbientShare( e, rising, cloud );
		if ( DC.displayNight ) w.displayNight = DC.displayNight( snap.daylight, e, rising, cloud );
		if ( DC.exposureNight ) w.exposureNight = DC.exposureNight( snap.daylight, e, rising, cloud );
		if ( DC.starNight ) w.starNight = DC.starNight( snap.daylight, e, rising, cloud );
		for ( const [ n, [ lo, hi ] ] of DC.duskShares ?? [] ) w[ 'share.' + n ] = lo === hi ? lo : [ lo, hi ];
		out.__weights = w;

	}
	const r = await s.radiance( CELLS ), m = await s.radiance( { ...CELLS, source: 'meterLight' } ), h = await s.radiance( { ...CELLS, source: 'hdr' } );
	const y = lums( r.grid.rgb ), hy = lums( h.grid.rgb ), mm = new Float64Array( NX * NY );
	for ( let c = 0; c < mm.length; c ++ ) mm[ c ] = m.grid.rgb[ 3 * c ];
	// the meter's trimmed means as Metering.ts takes them, P taken out
	const MT = await load( '/src/post/Metering.ts' ), meter = s.pipeline.metering;
	const BINS = MT.METER_BINS ?? 128, PER = MT.METER_BINS_PER_STOP ?? 4, LOW = MT.METER_LOW ?? - 16, ONE = MT.METER_ONE ?? 256;
	const hist = meter ? await meter.read( s.renderer ) : null;
	const trimmed = ( from, low, high ) => {

		if ( ! hist ) return null;
		let total = 0;
		for ( let i = 0; i < BINS; i ++ ) total += hist[ from + i ];
		const a = total * low, b = total * high;
		let below = 0, weight = 0, sum = 0;
		for ( let i = 0; i < BINS; i ++ ) {

			const c = hist[ from + i ], share = Math.max( Math.min( below + c, b ) - Math.max( below, a ), 0 );
			weight += share; sum += share * ( ( i + 0.5 ) / PER + LOW ); below += c;

		}
		return total >= ONE ? sum / Math.max( weight, 1e-6 ) - r.preExposure : null;

	};
	const u = meter?.uniforms;
	// the target's terms as Exposure.ts \`exposureTarget\` takes them: the sky's log ( m_S, the
	// irradiance texel's alpha, shared.ts \`skyMeterLog2\` ), e_M, e_H, e_S, the guarded scene's
	// exposure and the target recomputed from them (EVt2, to check against EVt)
	const mM = trimmed( 0, 0.1, 0.9 ), mH = trimmed( BINS, 0.9, 0.97 );
	const EX = await load( '/src/post/Exposure.ts' ), K0 = EX.SOFT_MIN ?? 0.25;
	const mS = sky.irradianceDisplay ? ( await s.renderer.readRenderTargetPixelsAsync( sky.irradianceDisplay, 0, 0, 1, 1 ) )[ 3 ] : null;
	let terms = {};
	if ( u && mS !== null ) {

		const kappa = u.key.value, eS = kappa - mS, eM = mM === null ? eS : kappa - mM, eH = mH === null ? null : u.highlight.value - mH;
		const guarded = eH === null ? eM : Math.min( eM, eH ) - Math.log2( 2 ** ( Math.abs( eM - eH ) / - K0 ) + 1 ) * K0;
		const e = guarded + ( eS - guarded ) * u.skyShare.value + u.offset.value;
		const lo = eS - ( EX.EXPOSURE_UNDER ?? 4 ) + u.offset.value, hi = eS + ( EX.EXPOSURE_OVER ?? 5 ) + u.offset.value;
		terms = { mS, eM, eH, eS, eG: guarded, EVt2: Math.min( Math.max( e, lo ), hi ), highlightDecides: eH !== null && eH < eM ? 1 : 0, offset: u.offset.value };

	}
	const V = {
		EV: r.exposure.ev, EVt: r.exposure.target, kappa: u ? u.key.value : null, kappaH: u ? u.highlight.value : null, beta: u ? u.skyShare.value : null,
		mM, mH, ...terms, P: r.preExposure,
		M: mean( mm, ( c ) => K.land[ c ] ), Mfar: mean( mm, ( c ) => K.land[ c ] && ! K.near[ c ] ),
		Yland: mean( y, ( c ) => K.land[ c ] ), Yfar: mean( y, ( c ) => K.land[ c ] && ! K.near[ c ] ),
		Ysky: mean( y, ( c ) => K.skyM[ c ] ), Ysea: mean( y, ( c ) => K.seaM[ c ] ),
		hYland: mean( hy, ( c ) => K.land[ c ] ), hYsky: mean( hy, ( c ) => K.skyM[ c ] ), hYsea: mean( hy, ( c ) => K.seaM[ c ] ),
		yunInner: mean( y, ( c ) => K.land[ c ] && K.inner[ c ] ), yunRing: mean( y, ( c ) => K.land[ c ] && K.ring[ c ] ),
		yunMInner: mean( mm, ( c ) => K.land[ c ] && K.inner[ c ] ), yunMRing: mean( mm, ( c ) => K.land[ c ] && K.ring[ c ] ),
		landCells: K.land.reduce( ( a, b ) => a + b, 0 ), clumps: K.clumps,
	};
	for ( const [ k, x ] of Object.entries( V ) ) out[ view + '.' + k ] = x;
	return out;
}`;

// ---- running
const label = `dusk-grid ${ options.weathers.join( ',' ) }`;
const sha = ( () => {

	try { return execFileSync( 'git', [ '-C', options.src, 'rev-parse', 'HEAD' ], { encoding: 'utf8' } ).trim(); } catch { return null; }

} )();
if ( ! base.endsWith( '/' ) && ! base.includes( '?' ) ) base += '/';
mkdirSync( options.out, { recursive: true } );
const pagesErrors = [];
let lockWaitMs = 0;
try {

	lockWaitMs = await acquireGpuLock( label, { shared: true, timeout: options.lockTimeout } );

} catch ( error ) {

	if ( /still held|timed out|timeout/i.test( error.message ) ) {

		console.error( `dusk-grid: ${ error.message }: nothing measured` );
		process.exit( 3 );

	}
	throw error;

}
const capture = await launchCapture( { viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1, url: base } );
const { page } = capture;
const pageErrors = [];
page.on( 'pageerror', ( e ) => pageErrors.push( e.message ) );
page.on( 'crash', () => pageErrors.push( 'the page crashed' ) );

async function load( query ) {

	await page.goto( `${ base }?${ query }`, { timeout: options.timeout } );
	await page.waitForFunction( () => window.__PONLAI__ && window.__THREE_GAME_DIAGNOSTICS__, null, { timeout: options.timeout } );

}

// the exact scene jump (tools/probe.mjs); false when the page refuses the query
async function jump( query ) {

	const jumped = await page.evaluate( async ( q ) => {

		const s = window.__PONLAI__;
		if ( s.sceneJump !== 1 ) return - 1;
		try { await s.establishScene( q ); } catch ( error ) {

			if ( /reload the page/.test( error.message ) ) return - 1;
			throw error;

		}
		s.loop.start();
		return s.renderer.info.frame;

	}, query );
	if ( jumped < 0 ) return false;
	await page.waitForFunction( ( f ) => window.__PONLAI__.renderer.info.frame > f, jumped, { timeout: options.timeout, polling: 'raf' } );
	return true;

}

const run = ( js ) => runInPage( page, js, { timeout: options.timeout } );

/** One state of the current point: the forces set, the bake, then per view the settled signal and
 * the reads. Returns { values, weights, unsettled }. */
async function state( forces ) {

	await run( applyJs( forces ) );
	const values = {};
	let weights = null, unsettled = false;
	for ( const [ i, view ] of options.views.entries() ) {

		if ( options.views.length > 1 ) await run( viewJs( view ) );
		const ready = await waitForSettled( page, { timeout: options.timeout } );
		if ( ready.signal !== false && ! ready.settled ) unsettled = true;
		const read = await run( readJs( view, i === 0 ) );
		if ( read.__weights ) {

			weights = read.__weights;
			delete read.__weights;

		}
		Object.assign( values, read );

	}
	return { values, weights, unsettled };

}

const same = ( a, b ) => a === b || ( a === null && b === null ) || ( typeof a === 'number' && typeof b === 'number' && Number.isNaN( a ) && Number.isNaN( b ) );
const diff = ( a, b ) => {

	const out = {};
	for ( const k of Object.keys( a ) ) out[ k ] = typeof a[ k ] === 'number' && typeof b[ k ] === 'number' ? a[ k ] - b[ k ] : null;
	return out;

};

async function measure( point, query, how ) {

	const t0 = Date.now();
	point.query = query;
	if ( how === 'walk' ) await run( `async () => { await window.__PONLAI__.setHour( ${ point.hourText } ); window.__PONLAI__.loop.start(); }` );
	else if ( how === 'load' || ! await jump( query ) ) {

		await load( query );
		point.loaded = true;

	}
	await waitForScene( page, { frames: 1, timeout: options.timeout } );
	const prep = await run( prepareJs() );
	const want = [ ...splitNames, ...twilightNames, ...( options.nightSplit ? [ ...TWILIGHT, 'localLights' ] : [] ) ];
	const missing = want.filter( ( n ) => ! prep.forces.includes( n ) );
	if ( missing.length ) throw new ArgError( `the page has no sky.dusk.force.${ missing.join( ', ' ) }` );
	point.elevation = prep.elevation;
	const expected = DC.sunElevationAt( Number( point.hourText ) );
	if ( Math.abs( prep.elevation - expected ) > 1e-3 ) throw new ArgError( `the page's sun stands at ${ prep.elevation } at hour ${ point.hourText }, --src's at ${ expected }: give the served checkout as --src` );
	if ( options.views.length === 1 ) await run( viewJs( options.views[ 0 ] ) );
	// the jump's own bakes done before the first state asks for its own
	await waitForSettled( page, { timeout: options.timeout } );
	const warnings = [];
	const take = async ( forces ) => {

		const r = await state( forces );
		if ( r.unsettled ) warnings.push( `not settled with ${ JSON.stringify( forces ) }` );
		return r;

	};
	const q = await take( {} );
	point.values = q.values;
	point.weights = q.weights;
	if ( options.frames ) {

		const shooter = await pngShooter( page, { timeout: options.timeout } );
		const png = await shooter.shoot();
		await shooter.close();
		const file = path.join( options.out, 'frames', `${ point.weather }-${ point.side }-${ point.key }.png` );
		mkdirSync( path.dirname( file ), { recursive: true } );
		writeFileSync( file, png );
		point.frame = path.relative( options.out, file );

	}
	if ( options.haze ) {

		// the haze's view, its reads, then the point's own view back for the states after it
		await run( HAZE_VIEW );
		const ready = await waitForSettled( page, { timeout: options.timeout } );
		if ( ready.signal !== false && ! ready.settled ) warnings.push( 'not settled in the haze view' );
		const h = await run( hazeReadJs() );
		point.hazeMedium = h.medium;
		point.hazeOpacity = h.opacity;
		point.hazePose = h.pose;
		if ( h.outside.length ) point.hazeOutside = h.outside;
		await run( viewJs( options.views[ 0 ] ) );
		await waitForSettled( page, { timeout: options.timeout } );

	}
	// a share the code already makes exactly 0 or 1 everywhere needs no state of its own
	const natural = ( n ) => n === 'hazeNight' ? undefined : q.weights?.[ `share.${ n }` ];
	const is = ( n, x ) => natural( n ) === x;
	let states = 1;
	const taken = async ( forces ) => {

		states ++;
		return take( forces );

	};
	if ( splitNames.length ) {

		point.shares = {};
		for ( const n of splitNames ) {

			// (a twilight's share is a weight that is 1 unforced: its q1 is q)
			const q0 = is( n, 0 ) ? q : await taken( { [ n ]: 0 } );
			const q1 = TWILIGHT.includes( n ) || is( n, 1 ) ? q : await taken( { [ n ]: 1 } );
			point.shares[ n ] = { w: natural( n ) ?? null, q0: q0.values, q1: q1.values, ...( q0 === q ? { q0Same: true } : {} ), ...( q1 === q ? { q1Same: true } : {} ) };

		}
		if ( nightNames.length ) {

			const forced = Object.fromEntries( nightNames.map( ( n ) => [ n, 0 ] ) );
			let prev = nightNames.every( ( n ) => is( n, 0 ) ) ? q : await taken( forced );
			point.cumulative = { T: prev.values };
			for ( const [ k, n ] of nightNames.entries() ) {

				delete forced[ n ];
				const cur = k === nightNames.length - 1 ? await taken( {} ) : is( n, 0 ) ? prev : await taken( { ...forced } );
				point.shares[ n ].inc = diff( cur.values, prev.values );
				prev = cur;

			}
			// bit for bit, but for the reads of the hdr source (the sea and the air over the opaque
			// scene): the haze's rest after other states lands a cell's fourth digit apart now and then
			let drift = 0;
			const off = Object.keys( q.values ).filter( ( k ) => {

				const a = prev.values[ k ], b = q.values[ k ];
				if ( same( a, b ) ) return false;
				if ( ! HDR_READS.includes( k.slice( k.indexOf( '.' ) + 1 ) ) || typeof a !== 'number' || typeof b !== 'number' || b === 0 ) return true;
				drift = Math.max( drift, Math.abs( a / b - 1 ) );
				return Math.abs( a / b - 1 ) > options.compareTolerance;

			} );
			if ( drift > 0 ) point.hdrDrift = drift;
			// (with each value's relative difference, so a void point tells a frame read's noise from a lost term)
			const rel = ( k ) => { const a = prev.values[ k ], b = q.values[ k ]; return typeof a === 'number' && typeof b === 'number' && b !== 0 ? ` ${ ( a / b - 1 ).toExponential( 1 ) }` : ''; };
			if ( off.length ) point.void = `the last cumulative state differs from the point in ${ off.length } values (${ off.slice( 0, 4 ).map( ( k ) => k + rel( k ) ).join( ', ' ) })`;
			point.residual = {};
			for ( const k of Object.keys( q.values ) ) {

				const vq = q.values[ k ];
				let t = point.cumulative.T[ k ];
				if ( typeof vq !== 'number' || typeof t !== 'number' ) { point.residual[ k ] = null; continue; }
				for ( const n of nightNames ) t += vq - point.shares[ n ].q0[ k ];
				point.residual[ k ] = t - vq;

			}

		}

	}
	if ( twilightNames.length ) {

		const forced = Object.fromEntries( twilightNames.map( ( n ) => [ n, 0 ] ) );
		point.cumulative = { T: ( twilightNames.every( ( n ) => is( n, 0 ) ) ? q : await taken( forced ) ).values };

	}
	if ( options.nightSplit ) {

		point.night = ( await taken( Object.fromEntries( TWILIGHT.map( ( n ) => [ n, 0 ] ) ) ) ).values;
		point.noLights = point.shares?.localLights?.q0 ?? ( is( 'localLights', 0 ) ? q : await taken( { localLights: 0 } ) ).values;

	}
	if ( warnings.length ) point.warnings = warnings;
	point.states = states;
	point.ms = Date.now() - t0;

}

const files = {};
const fileOf = ( weather, side ) => files[ `${ weather }-${ side }` ] ??= {
	version: 1, tool: 'dusk-grid', sha, src: options.src, base, query: options.q, weather, side, weathers: options.weathers, sides: options.sides,
	grid: { from: options.from, to: options.to, step: options.step, midnight: options.midnight, fine: options.fine, at: options.at, hours: options.hours, walk: options.walk },
	views: options.views, split: splitNames, nightSplit: options.nightSplit, twilight: twilightNames, browser: capture.version, points: [],
	...( options.haze ? { haze: { sky: options.hazeSky, distances: options.hazeDistances, height: HAZE_HEIGHT, pitch: HAZE_PITCH, fov: HAZE_FOV } } : {} ),
};
const save = ( weather, side ) => writeFileSync( path.join( options.out, `${ weather }-${ side }.json` ), JSON.stringify( fileOf( weather, side ), null, 1 ) );

const plan = [];
for ( const weather of options.weathers ) for ( const side of options.sides ) plan.push( { weather, side, points: pointsOf( side ) } );
const total = plan.reduce( ( a, p ) => a + p.points.length, 0 );
NOTE( `${ total } points (${ options.weathers.join( ',' ) } x ${ options.sides.join( ',' ) }) from ${ base }, sun of ${ options.src }${ sha ? ` (${ sha.slice( 0, 8 ) })` : '' }; out ${ options.out }` );
let done = 0, broken = true, argError = null;
const shared = new Map();
try {

	for ( const { weather, side, points } of plan ) {

		const file = fileOf( weather, side );
		let first = true;
		for ( const p of points ) {

			const point = { weather, side, key: p.key, e: p.e, at: p.at, hour: p.hour, hourText: p.hourText, grid: p.grid, fine: p.fine };
			Object.defineProperty( point, 'weather', { enumerable: false } );
			Object.defineProperty( point, 'side', { enumerable: false } );
			done ++;
			const sharedKey = `${ weather } ${ p.key }`;
			if ( p.at === 'midnight' && ! options.walk && shared.has( sharedKey ) ) {

				file.points.push( { ...shared.get( sharedKey ), sharedWith: shared.get( sharedKey ).side } );
				save( weather, side );
				continue;

			}
			const query = `weather=${ weather }&hour=${ p.hourText }&paused&t=12${ options.q ? `&${ options.q }` : '' }`;
			await stopLoop( page ).catch( () => {} );
			lockWaitMs += ( await leaseGpuLock( label, { shared: true, budget: 20000 } ) ).waitMs;
			try {

				await measure( point, query, broken || ( options.walk && first ) ? 'load' : options.walk ? 'walk' : 'jump' );
				broken = false;

			} catch ( error ) {

				if ( error instanceof ArgError ) { argError = error; throw error; }
				point.error = error.message.split( '\n' )[ 0 ];
				pagesErrors.push( `${ weather } ${ side } ${ p.key }: ${ point.error }` );
				broken = true;

			}
			first = false;
			if ( pageErrors.length ) {

				point.pageErrors = pageErrors.splice( 0 );
				pagesErrors.push( `${ weather } ${ side } ${ p.key }: page error ${ point.pageErrors[ 0 ] }` );
				broken = true;

			}
			if ( p.at === 'midnight' ) shared.set( sharedKey, Object.assign( { ...point }, { side } ) );
			file.points.push( point );
			save( weather, side );
			const v0 = options.views[ 0 ];
			NOTE( `${ done }/${ total } ${ weather } ${ side } ${ p.key }${ point.error ? ` ERROR ${ point.error }` : `: ${ point.states } states in ${ ( point.ms / 1000 ).toFixed( 1 ) } s, E ${ fmt( point.values.E ) } ${ v0 }.Mfar ${ fmt( point.values[ `${ v0 }.Mfar` ] ) } EV ${ fmt( point.values[ `${ v0 }.EV` ] ) }${ point.void ? ' VOID' : '' }${ point.warnings ? ` (${ point.warnings.length } unsettled)` : '' }` }` );

		}

	}

} catch ( error ) {

	if ( ! ( error instanceof ArgError ) ) throw error;

} finally {

	await stopLoop( page ).catch( () => {} );
	await capture.close().catch( () => {} );
	releaseGpuLock();

}
if ( argError ) {

	console.error( `dusk-grid: ${ argError.message }` );
	process.exit( 2 );

}

// ---- the rules
function fmt( x, digits = 4 ) {

	if ( x === null || x === undefined ) return '-';
	if ( Array.isArray( x ) ) return `[${ x.map( ( y ) => fmt( y, digits ) ).join( ',' ) }]`;
	if ( typeof x !== 'number' ) return String( x );
	if ( x === 0 ) return '0';
	return Math.abs( x ) >= 1e5 || Math.abs( x ) < 1e-3 ? x.toExponential( digits - 1 ) : x.toPrecision( digits );

}
const pad = ( s, n ) => String( s ).padStart( n );
const eOf = ( p ) => p.e === null ? - Infinity : p.e;
const label_ = ( p ) => p.at === 'midnight' ? 'midnight' : p.key;
const judgedKeys = [ ...JUDGED, ...options.views.flatMap( ( v ) => JUDGED_VIEW.map( ( q ) => `${ v }.${ q }` ) ) ];
const reportedKeys = [ ...REPORTED, ...options.views.flatMap( ( v ) => REPORTED_VIEW.map( ( q ) => `${ v }.${ q }` ) ) ];
const rise = ( lower, higher ) => {

	if ( typeof lower !== 'number' || typeof higher !== 'number' ) return null;
	if ( higher === 0 ) return lower > 0 ? Infinity : 0;
	return lower / higher - 1;

};
let violations = 0;
const lines = [];
const say = ( s = '' ) => lines.push( s );
say( `dusk-grid ${ options.weathers.join( ',' ) } x ${ options.sides.join( ',' ) }; judge ${ options.judge } on ${ options.judgeRange.join( ' to ' ) }; steps judged for ${ options.judgeWeathers.join( ',' ) }, overall for ${ options.overallWeathers.join( ',' ) }` );
say( `sun of ${ options.src } (${ sha ?? 'no git' }); hours bisected, largest difference from eveningHour / morningHour ${ hourCheck.toExponential( 2 ) } h` );
say( `query weather=<w>&hour=<h>&paused&t=12&${ options.q }; views ${ options.views.join( ',' ) }; ${ options.walk ? 'walked by setHour' : 'each point a scene jump' }` );
const LOG2 = Math.log2( 1 + options.judge );
const residuals = [], voids = [];
for ( const { weather, side } of plan ) {

	const file = fileOf( weather, side );
	const points = file.points.filter( ( p ) => p.values ).sort( ( a, b ) => eOf( b ) - eOf( a ) );
	const stepsJudged = options.judgeWeathers.includes( weather ), overallJudged = options.overallWeathers.includes( weather );
	say();
	say( `== ${ weather } ${ side }: ${ points.length } points` );
	say( 'values' );
	const cols = [ ...judgedKeys, ...reportedKeys ];
	say( `${ pad( 'e', 9 ) } ${ cols.map( ( c ) => pad( c.replace( /^.*\./, '' ), 10 ) ).join( ' ' ) }` );
	for ( const p of points ) say( `${ pad( label_( p ), 9 ) } ${ cols.map( ( c ) => pad( fmt( p.values[ c ] ), 10 ) ).join( ' ' ) }` );
	// steps
	const [ top, bottom ] = options.judgeRange;
	const grid = points.filter( ( p ) => p.grid && p.e !== null && p.e <= top + 1e-9 && p.e >= bottom - 1e-9 );
	say( `steps, q( lower ) / q( higher ) - 1 in %, * over ${ ( options.judge * 100 ).toFixed( 1 ) } %${ stepsJudged ? '' : ' (reported only)' }` );
	say( `${ pad( 'from', 9 ) } ${ pad( 'to', 9 ) } ${ judgedKeys.map( ( c ) => pad( c.replace( /^.*\./, '' ), 9 ) ).join( ' ' ) }` );
	for ( let i = 0; i + 1 < grid.length; i ++ ) {

		const a = grid[ i ], b = grid[ i + 1 ];
		const cells = judgedKeys.map( ( c ) => {

			const r = rise( b.values[ c ], a.values[ c ] );
			if ( r === null ) return pad( '-', 9 );
			const bad = r > options.judge + 1e-12;
			if ( bad && stepsJudged ) violations ++;
			return pad( `${ r === Infinity ? 'inf' : ( r * 100 ).toFixed( 2 ) }${ bad ? '*' : ' ' }`, 9 );

		} );
		say( `${ pad( label_( a ), 9 ) } ${ pad( label_( b ), 9 ) } ${ cells.join( ' ' ) }` );

	}
	// overall
	const overall = points.filter( ( p ) => p.e === null || p.e <= top + 1e-9 );
	say( `overall, the largest q( e' ) / q( e ) for e' < e from ${ top } down${ options.midnight ? ' and midnight' : '' }, # over ${ ( 1 + options.judge ).toFixed( 3 ) }${ overallJudged ? '' : ' (reported only)' }` );
	for ( const c of judgedKeys ) {

		let best = { r: - Infinity };
		for ( let i = 0; i < overall.length; i ++ ) for ( let j = i + 1; j < overall.length; j ++ ) {

			const r = rise( overall[ j ].values[ c ], overall[ i ].values[ c ] );
			if ( r !== null && r > best.r ) best = { r, hi: overall[ i ], lo: overall[ j ] };

		}
		if ( best.r === - Infinity ) continue;
		const bad = best.r > options.judge + 1e-12;
		if ( bad && overallJudged ) violations ++;
		say( `  ${ pad( c, 14 ) } ${ pad( best.r === Infinity ? 'inf' : ( 1 + best.r ).toFixed( 4 ), 9 ) }${ bad ? '#' : ' ' } at ${ label_( best.lo ) } over ${ label_( best.hi ) }` );

	}
	// exposure
	for ( const v of options.views ) {

		say( `exposure ${ v }: EV, its step, kappa's and m_M's; ! where EV falls more than ${ LOG2.toFixed( 4 ) } stop${ stepsJudged ? '' : ' (reported only)' }` );
		for ( let i = 0; i + 1 < grid.length; i ++ ) {

			const a = grid[ i ].values, b = grid[ i + 1 ].values;
			const ev = ( x ) => x[ `${ v }.EV` ], k = ( x ) => x[ `${ v }.kappa` ], m = ( x ) => x[ `${ v }.mM` ];
			if ( typeof ev( a ) !== 'number' || typeof ev( b ) !== 'number' ) continue;
			const dEV = ev( b ) - ev( a ), dk = k( b ) - k( a ), dm = typeof m( a ) === 'number' && typeof m( b ) === 'number' ? m( b ) - m( a ) : null;
			const bad = dEV < - LOG2 - 1e-12;
			if ( bad && stepsJudged ) violations ++;
			say( `  ${ pad( label_( grid[ i ] ), 9 ) } ${ pad( label_( grid[ i + 1 ] ), 9 ) } EV ${ pad( fmt( ev( b ) ), 8 ) } dEV ${ pad( dEV.toFixed( 3 ), 7 ) } dkappa ${ pad( dk.toFixed( 3 ), 7 ) } dmM ${ pad( dm === null ? '-' : dm.toFixed( 3 ), 7 ) }${ bad ? ` ! ${ dm !== null && dm > 0 ? 'm_M rises' : 'kappa falls faster than m_M' }` : '' }` );

		}
		const night = points[ points.length - 1 ], high = grid[ 0 ];
		if ( night && high && night !== high ) say( `  EV( ${ label_( night ) } ) - EV( ${ label_( high ) } ) = ${ fmt( night.values[ `${ v }.EV` ] - high.values[ `${ v }.EV` ] ) } stops (reported)` );

	}
	// fine series
	options.fine.forEach( ( f, k ) => {

		const series = points.filter( ( p ) => p.fine?.includes( k ) );
		say( `fine ${ f.hi }:${ f.lo }:${ f.step }: the largest rise per step in %, limit ${ ( options.judge * f.step / 0.5 * 100 ).toFixed( 3 ) } %${ stepsJudged ? '' : ' (reported only)' }` );
		for ( const c of judgedKeys ) {

			let best = { r: - Infinity };
			for ( let i = 0; i + 1 < series.length; i ++ ) {

				const r = rise( series[ i + 1 ].values[ c ], series[ i ].values[ c ] );
				if ( r !== null && r > best.r ) best = { r, at: series[ i + 1 ] };

			}
			if ( best.r === - Infinity ) continue;
			const bad = best.r > options.judge * f.step / 0.5 + 1e-12;
			if ( bad && stepsJudged ) violations ++;
			say( `  ${ pad( c, 14 ) } ${ pad( best.r === Infinity ? 'inf' : ( best.r * 100 ).toFixed( 3 ), 8 ) }${ bad ? '*' : ' ' } at ${ label_( best.at ) }` );

		}

	} );
	if ( options.haze ) {

		// the haze's opacity, 1 - T per display channel: green, then red and blue
		const rays = [ ...options.hazeSky.map( ( e ) => `sky ${ e }` ), ...options.hazeDistances.map( ( m ) => `level ${ m } m` ) ];
		say( `haze opacity (1 - T, green; red / blue), the haze view at ${ HAZE_HEIGHT } m, pitch ${ HAZE_PITCH }, fov ${ HAZE_FOV }; medium items per point` );
		say( `${ pad( 'e', 9 ) } ${ rays.map( ( r ) => pad( r, 19 ) ).join( ' ' ) } ${ pad( 'medium', 7 ) }` );
		for ( const p of points ) {

			if ( ! p.hazeOpacity ) continue;
			const cell = ( r ) => { const x = p.hazeOpacity[ r ]; return x ? `${ x.opacity[ 1 ].toFixed( 4 ) } (${ x.opacity[ 0 ].toFixed( 3 ) }/${ x.opacity[ 2 ].toFixed( 3 ) })` : 'outside'; };
			say( `${ pad( label_( p ), 9 ) } ${ rays.map( ( r ) => pad( cell( r ), 19 ) ).join( ' ' ) } ${ pad( Object.keys( p.hazeMedium ?? {} ).length, 7 ) }` );

		}

	}
	for ( const p of points ) {

		if ( p.void ) voids.push( `${ weather } ${ side } ${ label_( p ) }: ${ p.void }` );
		if ( p.residual ) for ( const c of [ ...judgedKeys, ...options.views.map( ( v ) => `${ v }.M` ) ] ) {

			const r = p.residual[ c ], q = p.values[ c ];
			if ( typeof r === 'number' && typeof q === 'number' && Math.abs( r ) > 0.01 * Math.abs( q ) ) residuals.push( `${ weather } ${ side } ${ label_( p ) } ${ c }: ${ fmt( r ) } (${ ( r / q * 100 ).toFixed( 2 ) } % of ${ fmt( q ) })` );

		}

	}

}
violations += voids.length;
say();
say( `residuals over 1 % of q: ${ residuals.length }` );
for ( const r of residuals ) say( `  ${ r }` );
say( `void points: ${ voids.length }` );
for ( const v of voids ) say( `  ${ v }` );
const unsettled = Object.values( files ).flatMap( ( f ) => f.points.filter( ( p ) => p.warnings ).map( ( p ) => `${ f.weather } ${ f.side } ${ label_( p ) }: ${ p.warnings.join( '; ' ) }` ) );
say( `errors: ${ pagesErrors.length }, unsettled: ${ unsettled.length }` );
for ( const e of [ ...pagesErrors, ...unsettled ] ) say( `  ${ e }` );
writeFileSync( path.join( options.out, 'summary.txt' ), lines.join( '\n' ) + '\n' );

// ---- the terms and the handoff
if ( splitNames.length || options.nightSplit || twilightNames.length ) {

	const t = [];
	for ( const f of Object.values( files ) ) {

		const points = f.points.filter( ( p ) => p.values ).sort( ( a, b ) => eOf( b ) - eOf( a ) );
		for ( const c of [ ...judgedKeys, ...options.views.flatMap( ( v ) => [ `${ v }.M`, `${ v }.Yland` ] ) ] ) {

			t.push( `== ${ f.weather } ${ f.side } ${ c }: q, T (night shares forced 0), each night name's inc, residual, night (twilight forced 0), noLights` );
			t.push( `${ pad( 'e', 9 ) } ${ pad( 'q', 10 ) } ${ pad( 'T', 10 ) } ${ nightNames.map( ( n ) => pad( n, 12 ) ).join( ' ' ) } ${ pad( 'residual', 10 ) } ${ pad( 'night', 10 ) } ${ pad( 'noLights', 10 ) }` );
			for ( const p of points ) t.push( `${ pad( label_( p ), 9 ) } ${ pad( fmt( p.values[ c ] ), 10 ) } ${ pad( fmt( p.cumulative?.T[ c ] ), 10 ) } ${ nightNames.map( ( n ) => pad( fmt( p.shares?.[ n ]?.inc?.[ c ] ), 12 ) ).join( ' ' ) } ${ pad( fmt( p.residual?.[ c ] ), 10 ) } ${ pad( fmt( p.night?.[ c ] ), 10 ) } ${ pad( fmt( p.noLights?.[ c ] ), 10 ) }` );
			t.push( '' );

		}

	}
	writeFileSync( path.join( options.out, 'terms.txt' ), t.join( '\n' ) );

}
if ( splitNames.includes( 'moonKey' ) && nightNames.length ) {

	const h = [];
	for ( const weather of options.weathers ) {

		const v = options.views[ 0 ];
		h.push( `== ${ weather } (view ${ v }, M as Mfar)` );
		for ( const side of options.sides ) {

			const points = fileOf( weather, side ).points.filter( ( p ) => p.values && p.cumulative );
			const night = points.find( ( p ) => p.at === 'midnight' );
			const ed = points.filter( ( p ) => p.e !== null && p.weights?.handoff === 1 ).sort( ( a, b ) => b.e - a.e )[ 0 ];
			if ( ! night || ! ed ) { h.push( `  ${ side }: needs midnight and a point past the handoff, with --split` ); continue; }
			const Ted = ed.cumulative.T[ `${ v }.Mfar` ], Tnight = night.cumulative.T[ `${ v }.Mfar` ];
			const K = night.values[ `${ v }.Mfar` ] - night.shares.moonKey.q0[ `${ v }.Mfar` ];
			const pass = Ted - Tnight >= K;
			h.push( `  ${ side }: e_d ${ ed.key }  T_amb,land( e_d ) ${ fmt( Ted ) }  T( night ) ${ fmt( Tnight ) }  K_night ${ fmt( K ) }  T( e_d ) / K ${ fmt( Ted / K ) }  ${ pass ? 'pass' : 'fail' }` );

		}
		const night = fileOf( weather, options.sides[ 0 ] ).points.find( ( p ) => p.at === 'midnight' && p.values );
		if ( night ) {

			const M = night.values[ `${ v }.M` ], floor = night.values.landKeyFloor / Math.PI / M;
			const key = night.shares?.moonKey ? ( M - night.shares.moonKey.q0[ `${ v }.M` ] ) / M : null;
			h.push( `floor  ${ weather }  landKeyFloor(night)/M(night) = ${ ( floor * 100 ).toFixed( 2 ) } %   ${ floor < 0.05 ? '< 5 %' : '>= 5 %' }   (the key's measured share of M at night: ${ key === null ? '-' : `${ ( key * 100 ).toFixed( 2 ) } %` })` );

		}
		h.push( '' );

	}
	writeFileSync( path.join( options.out, 'handoff.txt' ), h.join( '\n' ) );

}

// ---- the comparison
let compareFound = null;
if ( options.compare ) {

	const tol = options.compareTolerance;
	const c = [ `dusk-grid compare: ${ options.out } against ${ options.compare }; in [${ WINDOW.join( ', ' ) }] the CPU values and the weights must be bit for bit the same, the views' reads within ${ tol } relative` ];
	let points = 0, identical = 0, windowOff = 0, viewNoise = 0;
	// --haze: the medium bit for bit at every point both runs read it (the deck's two shares are
	// listed, not judged: they are the light's), and the opacity's largest difference
	const hazeUnjudged = [ 'key.deck', 'key.overcastDeck' ];
	let hazePoints = 0, hazeOff = 0, hazeOpacity = { d: 0 };
	for ( const f of Object.values( files ) ) {

		const other = path.join( options.compare, `${ f.weather }-${ f.side }.json` );
		if ( ! existsSync( other ) ) { c.push( `${ f.weather } ${ f.side }: not in the other run` ); continue; }
		const them = new Map( JSON.parse( readFileSync( other, 'utf8' ) ).points.filter( ( p ) => p.values ).map( ( p ) => [ p.key, p ] ) );
		c.push( `== ${ f.weather } ${ f.side }` );
		for ( const p of f.points.filter( ( x ) => x.values ) ) {

			const q = them.get( p.key );
			if ( ! q ) continue;
			points ++;
			if ( p.hazeMedium && q.hazeMedium ) {

				hazePoints ++;
				const keys = [ ...new Set( [ ...Object.keys( p.hazeMedium ), ...Object.keys( q.hazeMedium ) ] ) ];
				const differ = keys.filter( ( k ) => JSON.stringify( p.hazeMedium[ k ] ) !== JSON.stringify( q.hazeMedium[ k ] ) );
				const judged = differ.filter( ( k ) => ! hazeUnjudged.includes( k ) );
				if ( judged.length ) hazeOff ++;
				for ( const r of Object.keys( p.hazeOpacity ?? {} ) ) {

					const a = p.hazeOpacity[ r ]?.opacity, b = q.hazeOpacity?.[ r ]?.opacity;
					if ( a && b ) a.forEach( ( x, i ) => { if ( Math.abs( x - b[ i ] ) > hazeOpacity.d ) hazeOpacity = { d: Math.abs( x - b[ i ] ), at: `${ f.weather } ${ f.side } ${ label_( p ) } ${ r } ${ 'rgb'[ i ] }` }; } );

				}
				if ( differ.length ) c.push( `  ${ label_( p ) } haze medium: ${ differ.length } items differ${ judged.length ? ` (${ judged.length } judged: a violation)` : ' (the deck\'s shares only, not judged)' }: ${ differ.map( ( k ) => `${ k } ${ JSON.stringify( p.hazeMedium[ k ] ) } vs ${ JSON.stringify( q.hazeMedium[ k ] ) }` ).join( '; ' ) }` );

			}
			const off = [];
			for ( const [ group, a, b ] of [ [ '', p.values, q.values ], [ 'w.', p.weights ?? {}, q.weights ?? {} ] ] ) for ( const k of Object.keys( a ) ) {

				if ( ! ( k in b ) ) continue;
				const x = a[ k ], y = b[ k ];
				if ( JSON.stringify( x ) === JSON.stringify( y ) ) continue;
				const rel = typeof x === 'number' && typeof y === 'number' && y !== 0 ? x / y - 1 : null;
				off.push( { k: group + k, x, y, rel } );

			}
			if ( ! off.length ) { identical ++; c.push( `  ${ label_( p ) }: identical` ); continue; }
			// a view's read is a GPU read (`<view>.<name>`): two pages repeat it to its noise only
			const isView = ( d ) => ! d.k.startsWith( 'w.' ) && d.k.includes( '.' );
			for ( const d of off ) if ( isView( d ) && d.rel !== null ) viewNoise = Math.max( viewNoise, Math.abs( d.rel ) );
			const breaks = off.filter( ( d ) => ! isView( d ) || d.rel === null || Math.abs( d.rel ) > tol );
			const inWindow = p.e !== null && p.e >= WINDOW[ 0 ] - 1e-9 && p.e <= WINDOW[ 1 ] + 1e-9;
			if ( inWindow && breaks.length ) windowOff ++;
			off.sort( ( a, b ) => Math.abs( b.rel ?? Infinity ) - Math.abs( a.rel ?? Infinity ) );
			c.push( `  ${ label_( p ) }: ${ off.length } values differ (${ breaks.length } CPU, weights or over the tolerance${ inWindow && breaks.length ? ': a violation, in the window' : '' }); largest ${ off.slice( 0, 6 ).map( ( d ) => `${ d.k } ${ fmt( d.x ) } vs ${ fmt( d.y ) }${ d.rel === null ? '' : ` (${ ( d.rel * 100 ).toFixed( 4 ) } %)` }` ).join( '; ' ) }` );

		}

	}
	c.push( `${ identical } of ${ points } points identical; ${ windowOff } differ in the window; the views' reads differ by at most ${ viewNoise.toExponential( 2 ) } relative` );
	// the night's lift: the metered EV with the lamps off (noLights, --night-split in both runs) less
	// the other run's, per point both hold; at midnight less NIGHT_METER_LIFT too, which a run against
	// a page of the night before the moon's magnitude reads as how far the constant has drifted
	const lift = [];
	for ( const f of Object.values( files ) ) {

		const other = path.join( options.compare, `${ f.weather }-${ f.side }.json` );
		if ( ! existsSync( other ) ) continue;
		const them = new Map( JSON.parse( readFileSync( other, 'utf8' ) ).points.filter( ( p ) => p.noLights ).map( ( p ) => [ p.key, p ] ) );
		for ( const v of options.views ) for ( const p of f.points.filter( ( x ) => x.noLights ) ) {

			const q = them.get( p.key ), a = p.noLights[ `${ v }.EV` ], b = q?.noLights[ `${ v }.EV` ];
			if ( typeof a !== 'number' || typeof b !== 'number' ) continue;
			const tail = p.at === 'midnight' && typeof DC.NIGHT_METER_LIFT === 'number' ? `   less NIGHT_METER_LIFT ${ DC.NIGHT_METER_LIFT }: ${ ( a - b - DC.NIGHT_METER_LIFT ).toFixed( 3 ) }` : '';
			lift.push( `  ${ f.weather } ${ f.side } ${ v } ${ pad( label_( p ), 9 ) } EV ${ a.toFixed( 3 ) } - ${ b.toFixed( 3 ) } = ${ ( a - b ).toFixed( 3 ) } stops${ tail }` );

		}

	}
	if ( lift.length ) c.push( 'the lift, EV less the other run\'s with the lamps off (noLights)', ...lift );
	if ( hazePoints ) c.push( `haze medium: ${ hazePoints - hazeOff } of ${ hazePoints } points bit for bit the same (the deck's shares aside); the opacity differs by at most ${ hazeOpacity.d.toExponential( 2 ) }${ hazeOpacity.at ? ` (${ hazeOpacity.at })` : '' }` );
	writeFileSync( path.join( options.out, 'compare.txt' ), c.join( '\n' ) + '\n' );
	violations += windowOff + hazeOff;
	compareFound = { points, identical, windowOff, hazePoints, hazeOff };

}

console.log( `dusk-grid: ${ done } points in ${ options.out } (lock waits ${ ( lockWaitMs / 1000 ).toFixed( 0 ) } s); ${ violations } violations (summary.txt), ${ voids.length } void, ${ pagesErrors.length } errors, ${ unsettled.length } unsettled${ compareFound ? `; compare: ${ compareFound.identical } of ${ compareFound.points } identical, ${ compareFound.windowOff } differ in [${ WINDOW.join( ', ' ) }]${ compareFound.hazePoints ? `, haze medium differs at ${ compareFound.hazeOff } of ${ compareFound.hazePoints }` : '' }` : '' }` );
process.exit( pagesErrors.length || unsettled.length ? 2 : violations ? 1 : 0 );
