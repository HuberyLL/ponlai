// Sweeps the island view through the day under each kept weather, as sheets and curves with the steps flagged.
//
// The systems tuned by the sun's elevation and the weather (exposure, skylight, haze, white balance,
// the grade) go wrong at one hour under one sky, which the few frames a tuning session looks at miss.
// Run it before handing back a change to anything keyed by the sun's elevation or the weather, and
// again with `--compare` on the run from before. It only combines tools that exist:
// tools/island/colour-rows.mjs shoots the frames (shoot --warm: one warm page, a scene jump per frame)
// and reads them (rows --own), `tools/kit/img.py sheet` and `thumb` lay them out and shrink them, and
// tools/island/day-sweep-plot.py draws the curves. `report` runs the second half again on the frames
// already in <outDir> (new thresholds, a comparison, a sheet that failed).
//
// Usage:
//   node tools/kit/job.mjs start -- node tools/island/day-sweep.mjs <url> <outDir> [--scope routine|full]
//       [--views name,...] [--view name:query]... [--times all|hourly|midday|dense|key|HH:MM,...]
//       [--weathers name,...] [--compare <earlier outDir>] [--transitions] [--keep-frames]
//       [--thr-stops 0.3333] [--thr-de 0.03] [--turn-deg 15] [--sky-mask-deg 5]
//       [--size 2560x1440@1] [--jobs 1] [--q "extra&query"]
//   node tools/island/day-sweep.mjs report <outDir> [--compare <dir>] [--thin] [--thr-stops s] [--thr-de d]
//       [--turn-deg d] [--sky-mask-deg d]
//
// Options:
//   --scope s          routine: default, key and low all day; full: also back at the key moments (routine)
//   --views a,b        the cameras, of default, key, low, back (the scope's)
//   --view name:query  adds a camera of its own (its query: dist, polar, az, ...), all day; repeatable
//   --times spec       HH:MM tokens and the words below, mixed (`hourly,05:20`) (all)
//   --weathers a,b     the weathers (the kept ones, every weather not in Weather.ts PARKED_WEATHER)
//   --compare <dir>    compares with an earlier run of the same cameras, size and sort
//   --transitions      also shoots each adjacent pair of weathers half way through a front
//   --keep-frames      keeps every frame at full size
//   --thr-stops s      a step in log2 luminance worth a line (1/3)
//   --thr-de d         a step in the Oklab (a, b) distance worth a line (0.03)
//   --turn-deg d       a pair the camera turned more than d degrees over is not scanned (15)
//   --sky-mask-deg d   leaves the sky within d degrees of the sun or the moon out of the sky's row (5)
//   --size WxH@dpr     the frames' size (2560x1440@1)
//   --jobs n           colour-rows's page count (1)
//   --q query          extra query options for every frame
//   --thin             report: thins a run already made to thumbnails (as a shoot does)
//
// A routine run is hundreds of scene jumps: start it through tools/kit/job.mjs and wait on it there,
// never in a shell of its own. <outDir> must be new or empty: a run into an old one would read the
// old run's numbers.
//
// The cameras (every frame of a camera from the same pose; their reasons are beside CAMERAS):
//   default  the game's island view at its own heading (az 180), as views.mjs's island views
//   key      the default view's distance and tilt about the page's default pivot, turned at each frame
//            to look toward the light: the sun while it stands above -12 degrees, the moon after it
//   low      as key, at the lowest pitch the game's camera allows (8 degrees over the horizon, read
//            from the page): the only camera with sky, a band about 5 degrees high over the horizon
//   back     as key, from the light's side, looking away from it
// The island camera looks 50 degrees down, so default, key and back hold no sky.
//
// The times:
//   hourly  every whole hour, 0 to 23
//   midday  every half hour from 08:00 to 16:00
//   dense   every 10 game minutes from 70 minutes before sunrise to 90 after it, and from 90 before
//           sunset to 70 after it (DayCycle.ts `morningHour( 0 )`, `eveningHour( 0 )`: 06:00 and 18:00)
//   key     twelve moments by the sun's elevation, each rounded to 10 minutes: midnight, pre-dawn (-12
//           degrees), dawn (-6), sunrise (0), 09:00, noon, 14:00, the golden hour (DAY_PRESETS), sunset,
//           dusk (-6), late dusk (-12) and 22:00
//   all     hourly, midday, dense and key together: the default, 61 frames a camera and weather
// Each frame is `weather=<w>&hour=<h>` on the camera's pose; its label's elevation is the page's own.
//
// The regions, read per frame by colour-rows rows --own, each frame sorted by its own depth read:
// `sky` and `sea` (cells more than 0.99 sky or sea; the sky without the cells within --sky-mask-deg of
// the sun or the moon), `land` (no sky and no sea at all) and `floor` (the land's darkest 5 % by
// luminance). A row is the final pixel's mean linear colour over its cells, as log2 luminance and
// Oklab L, C, h. A region a camera holds no cells of is "not read"; one with too few cells (under 8)
// in a frame is a gap in its curve and a line in gaps.txt, not a failure.
//
// The steps. For each camera that has the whole day, each weather and region, each pair of
// neighbouring frames is scanned for what its change holds beyond the slope of its neighbours: a
// step in log2 luminance beyond --thr-stops, and in the Oklab (a, b) distance beyond --thr-de, each a
// line in jumps-<camera>.txt in units of its threshold. A third of a stop and .03 are about the least
// differences one sees in a whole frame. A pair the camera turned more than --turn-deg over is listed
// as "camera turned" instead. The rules are beside `stepsOf`.
//
// --compare <earlier outDir> gives a before, after and difference sheet per camera and weather and
// compare.txt, the frames whose regions changed beyond the thresholds, read from both runs' rows, so
// either run may be thinned. A run of another sort, size or with no camera in common is refused
// before anything is shot; a sky masked otherwise is marked not compared. Frames are subtracted only
// where both runs hold the same query; the rest are listed. --transitions freezes each adjacent pair
// of weathers half way through a front (views.mjs's `weather-change` recipe) at sunrise, noon, the
// golden hour and sunset (the first camera, a page each) and reports how far the middle frame lies
// from its endpoints.
//
// Output: in <outDir>, frames/<camera>/<weather>-<HHMM>.png (hard links into colour/normal for the
// frames a line of jumps.txt or compare.txt names; every other frame as a .jpg of 360 px on its short
// side, unless --keep-frames), sheet-<camera>-<weather>.png (the day by time, 8 columns of 320 px
// tiles labelled with the time and the sun's elevation),
// overview-<camera>.png (the weathers by the key moments), rows.json, curves-<camera>-<weather>.png
// (the regions' readings, the sun's elevation and the EV over the day, the steps circled),
// jumps-<camera>.txt and jumps.txt, compare/, compare.txt and compare.json (with --compare),
// transitions.txt and sheet-transitions.png (with --transitions), colour/ (colour-rows's own shoot and
// rows), plan.json, timing.json (wall, lock-wait and busy time per part) and gaps.txt. A thinned run's
// `report` redoes the numbers only; the sheets need the whole frames.
//
// GPU lock and browser: colour-rows takes the GPU lock shared (docs/reference/gpu-lock.md) in the
// capture tools' headless browser; a short probe reads the default view's pose first. `report`: neither.
//
// Cost: a scene jump per frame on a warm page, a fraction of a page load each; a routine run of the
// kept weathers is 366 frames of several MB each before thinning (about a third are kept full size);
// --transitions adds a page load per pair and moment. A SIGTERM (job.mjs stop) goes on to the tools
// below it.
//
// Exit codes: 0 done; 1 a failed shoot, picture or thumbnail, a frame with no row, or an unexpected
// error; 2 bad usage, an output directory that is not empty, an earlier run that cannot be compared,
// or a packages/render/sky/Weather.ts without WEATHER_PRESETS or with every weather parked.
import '../kit/help.mjs';
import '../kit/qos.mjs'; // first: the PNG work and the helpers run with the application policy
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DAY_PRESETS, DayCycle, eveningHour, morningHour } from '../../packages/render/sky/DayCycle.ts';
import { createExposure } from '../../packages/render/look/ExposureLook.ts';
import { createDayWindows } from '../../packages/render/look/DayLook.ts';
import { ISLAND_LOOK } from '../../packages/island/look/IslandLook.ts';

import * as WeatherModule from '../../packages/render/sky/Weather.ts';
import { ROOT } from '../kit/root.mjs';

const REPO = ROOT;
// the island's exposure and day windows, which the day cycle takes (its sun and moon do not read
// them)
const exposure = createExposure( ISLAND_LOOK ), dayWindows = createDayWindows( ISLAND_LOOK.day );
// the weathers' names, from the module's own exports (node strips its types): every name loads
// (WEATHER_PRESETS holds one preset per WeatherName), the weathers that are not parked are the default
const WEATHER_NAMES = Object.keys( WeatherModule.WEATHER_PRESETS ?? {} );
const WEATHERS = WEATHER_NAMES.filter( ( w ) => ! ( WeatherModule.PARKED_WEATHER ?? WEATHER_NAMES ).includes( w ) );
if ( ! WEATHER_NAMES.length ) { console.error( 'day-sweep: packages/render/sky/Weather.ts exports no WEATHER_PRESETS (a record by weather name), where the weathers\' names are read' ); process.exit( 2 ); }
if ( ! WEATHERS.length ) { console.error( 'day-sweep: packages/render/sky/Weather.ts parks every weather (PARKED_WEATHER): none is left for the default' ); process.exit( 2 ); }
const REGIONS = [ 'sky', 'sea', 'land', 'floor' ];
const THR_STOPS = 1 / 3, THR_DE = 0.03, TURN_DEG = 15, SKY_MASK_DEG = 5;
// the sun leads a camera down to here, the moon after (the light changes slowly there)
const HANDOFF_ELEVATION = - 12;
// The cameras. key and low turn at each frame to look toward the light, the sun down to -12 degrees
// and the moon after it (DayCycle's `sunDir` and `moonDir`). The key light itself turns from the sun
// to the moon between -2.5 and -0.7 degrees, which swung a camera that followed it 70 degrees in 10
// minutes at sunrise and sunset; at -12 the light changes slowly, and the camera's one big turn is
// there (--turn-deg). low stands at the island camera's `maxPolarAngle`, 82 degrees from straight
// down, so the horizon and the low sky stand in the frame; the sun stands in that sky band while it
// is under about 5 degrees (--sky-mask-deg). The turned cameras are shot at the default view's
// distance read from the page (a short probe), because the framing's own distance changes with the
// heading (85 m at az 180, 108 m at 200) and a turned camera would otherwise also change its
// height. There is no near or far camera: the game camera's farthest zoom, 70 m, is under the 85 m
// of the default framing, so it has no range to zoom in. In the full scope back takes the key
// moments only (12 frames a weather, no scan); a camera that --views names is scanned all day.
const CAMERAS = [ 'default', 'key', 'low', 'back' ];
// back takes the key moments only (the scope's cost), the others the whole day
const KEY_ONLY = new Set( [ 'back' ] );
const SCOPES = { routine: [ 'default', 'key', 'low' ], full: [ 'default', 'key', 'low', 'back' ] };
const THUMB = 360; // the short side of a thinned frame's thumbnail
const MAX_PAIR = 180; // minutes: a pair of frames further apart is not scanned

function usage( message ) {

	console.error( message );
	console.error( 'usage: day-sweep.mjs <url> <outDir> [options] | report <outDir> [options] (see the file header)' );
	process.exit( 2 );

}

// ------------------------------------------------------------------ options

const SHARED = [ 'compare', 'thr-stops', 'thr-de', 'turn-deg', 'sky-mask-deg' ];
const MODES = {
	shoot: { flags: [ 'transitions', 'keep-frames' ], values: [ ...SHARED, 'scope', 'views', 'times', 'weathers', 'size', 'jobs', 'q' ], lists: [ 'view' ] },
	report: { flags: [ 'thin' ], values: SHARED, lists: [] },
};

function parse( list, mode ) {

	const known = MODES[ mode ];
	const positional = [], options = { view: [] };
	for ( let i = 0; i < list.length; i ++ ) {

		const a = list[ i ];
		if ( ! a.startsWith( '--' ) ) { positional.push( a ); continue; }
		const k = a.slice( 2 );
		if ( known.flags.includes( k ) ) options[ k ] = true;
		else if ( known.lists.includes( k ) || known.values.includes( k ) ) {

			if ( list[ i + 1 ] === undefined ) usage( `${ a } needs a value` );
			if ( known.lists.includes( k ) ) options[ k ].push( list[ ++ i ] );
			else options[ k ] = list[ ++ i ];

		} else usage( `unknown option ${ a }${ mode === 'report' ? ' (report takes ' + [ ...known.flags, ...known.values ].join( ', ' ) + ')' : '' }` );

	}
	// the numbers, as numbers
	const number = ( k, least, fallback ) => {

		if ( options[ k ] === undefined ) return fallback;
		const v = Number( options[ k ] );
		if ( ! Number.isFinite( v ) || v < least ) usage( `bad --${ k } ${ options[ k ] }` );
		return v;

	};
	options.thr = { stops: number( 'thr-stops', 0, THR_STOPS ), de: number( 'thr-de', 0, THR_DE ) };
	if ( options.thr.stops <= 0 || options.thr.de <= 0 ) usage( 'the thresholds are over 0' );
	options.turnDeg = number( 'turn-deg', 0, TURN_DEG );
	options.skyMaskDeg = number( 'sky-mask-deg', 0, SKY_MASK_DEG );
	if ( options.jobs !== undefined && ! /^[1-9]\d*$/.test( options.jobs ) ) usage( `bad --jobs ${ options.jobs }` );
	if ( options.size !== undefined && ! /^\d+x\d+(@[\d.]+)?$/.test( options.size ) ) usage( `bad --size ${ options.size } (WxH@scale)` );
	return { positional, options };

}

// ------------------------------------------------------------------ the times

const pad = ( n ) => String( n ).padStart( 2, '0' );
const clock = ( minute ) => `${ pad( Math.floor( minute / 60 ) ) }:${ pad( minute % 60 ) }`;
const hhmm = ( minute ) => clock( minute ).replace( ':', '' );
const round10 = ( hours ) => Math.round( hours * 6 ) * 10 % 1440;

const SUNRISE = morningHour( 0 ) * 60, SUNSET = eveningHour( 0 ) * 60;

const hourly = () => Array.from( { length: 24 }, ( _, h ) => h * 60 );
const midday = () => Array.from( { length: 17 }, ( _, i ) => 480 + i * 30 );
function dense() {

	const out = [];
	for ( let m = Math.round( SUNRISE ) - 70; m <= Math.round( SUNRISE ) + 90; m += 10 ) out.push( m );
	for ( let m = Math.round( SUNSET ) - 90; m <= Math.round( SUNSET ) + 70; m += 10 ) out.push( m );
	return out;

}
// the key moments' names and minutes (by the sun's elevation, rounded to ten minutes)
const KEY_MOMENTS = [
	[ 'midnight', 0 ], [ 'pre-dawn', round10( morningHour( - 12 ) ) ], [ 'dawn', round10( morningHour( - 6 ) ) ],
	[ 'sunrise', round10( morningHour( 0 ) ) ], [ 'morning', 540 ], [ 'noon', 720 ], [ 'afternoon', 840 ],
	[ 'golden hour', round10( DAY_PRESETS[ 'golden-hour' ] ) ], [ 'sunset', round10( eveningHour( 0 ) ) ],
	[ 'dusk', round10( eveningHour( - 6 ) ) ], [ 'late dusk', round10( eveningHour( - 12 ) ) ], [ 'night', 1320 ],
];
// the transitions' moments are four of the key moments, so their endpoints are frames of the sweep
const TRANSITION_MOMENTS = [ 'sunrise', 'noon', 'golden hour', 'sunset' ].map( ( name ) => [ name, KEY_MOMENTS.find( ( k ) => k[ 0 ] === name )[ 1 ] ] );

function timesOf( spec ) {

	const set = new Set();
	for ( const token of spec.split( ',' ).filter( Boolean ) ) {

		if ( token === 'all' ) [ hourly(), midday(), dense(), KEY_MOMENTS.map( ( k ) => k[ 1 ] ) ].flat().forEach( ( m ) => set.add( m ) );
		else if ( token === 'hourly' ) hourly().forEach( ( m ) => set.add( m ) );
		else if ( token === 'midday' ) midday().forEach( ( m ) => set.add( m ) );
		else if ( token === 'dense' ) dense().forEach( ( m ) => set.add( m ) );
		else if ( token === 'key' ) KEY_MOMENTS.forEach( ( k ) => set.add( k[ 1 ] ) );
		else {

			const m = token.match( /^(\d{1,2})(?::(\d{2}))?$/ );
			if ( ! m || Number( m[ 1 ] ) > 23 || Number( m[ 2 ] ?? 0 ) > 59 ) usage( `bad time ${ token } (HH:MM, or all, hourly, midday, dense, key)` );
			set.add( Number( m[ 1 ] ) * 60 + Number( m[ 2 ] ?? 0 ) );

		}

	}
	return [ ...set ].sort( ( a, b ) => a - b );

}

// ------------------------------------------------------------------ the cameras and their frames

const withoutKeys = ( q, keys ) => ( q ?? '' ).split( '&' ).filter( ( p ) => p && ! keys.includes( p.split( '=' )[ 0 ] ) ).join( '&' );

// a camera's query for a frame, and the heading it holds: the weather and the hour first (the page
// reads the first of a repeated option), then the camera's own heading, distance and pitch
function frameQuery( camera, weather, minute ) {

	const hour = ( minute / 60 ).toFixed( 4 );
	const parts = [ `weather=${ weather }`, `hour=${ hour }` ];
	let az = null;
	if ( camera.heading ) {

		// the camera stands opposite the light's direction to look toward it (the island view's camera
		// is at ( sin az, cos az ) from its pivot: app/CameraViews.ts placeOrbit), on its side to look away
		const sign = camera.heading === 'toward' ? - 1 : 1;
		const snapshot = new DayCycle( exposure, dayWindows, { hour: Number( hour ), paused: true } ).snapshot();
		const light = snapshot.elevation > HANDOFF_ELEVATION ? snapshot.sunDir : snapshot.moonDir;
		az = Number( ( ( Math.atan2( sign * light.x, sign * light.z ) * 180 / Math.PI + 360 ) % 360 ).toFixed( 2 ) );
		parts.push( `az=${ az.toFixed( 2 ) }` );

	}
	if ( camera.dist ) parts.push( `dist=${ camera.dist.toFixed( 3 ) }` );
	if ( camera.polar ) parts.push( `polar=${ camera.polar.toFixed( 3 ) }` );
	const own = withoutKeys( camera.query, [ 'weather', 'hour', 'preset' ] );
	if ( own ) parts.push( own );
	return { q: parts.join( '&' ), az };

}

const viewName = ( camera, weather, minute ) => `${ camera }--${ weather }-${ hhmm( minute ) }`;
// the smallest turn between two headings (degrees)
const turnBetween = ( a, b ) => Math.abs( ( ( b - a + 540 ) % 360 ) - 180 );

// ------------------------------------------------------------------ running the tools

// the children below this process, so a SIGTERM (job.mjs stop) reaches them
const children = new Set();
for ( const signal of [ 'SIGTERM', 'SIGINT' ] ) {

	process.on( signal, () => {

		for ( const child of children ) child.kill( signal );
		setTimeout( () => process.exit( 143 ), 20000 ).unref();

	} );

}

// runs colour-rows with its output on ours, and adds up the GPU lock's waits it reports
function runColour( args ) {

	return new Promise( ( resolve ) => {

		const child = spawn( process.execPath, [ 'tools/island/colour-rows.mjs', ...args ], { cwd: REPO, stdio: [ 'ignore', 'inherit', 'pipe' ] } );
		children.add( child );
		let waited = 0, tail = '';
		child.stderr.on( 'data', ( d ) => {

			process.stderr.write( d );
			// (a line may arrive in two pieces)
			const text = tail + d.toString();
			const cut = text.lastIndexOf( '\n' ) + 1;
			for ( const m of text.slice( 0, cut ).matchAll( /acquired.* after ([\d.]+) s/g ) ) waited += Number( m[ 1 ] );
			tail = text.slice( cut );

		} );
		child.on( 'close', ( code ) => { children.delete( child ); resolve( { code, waited } ); } );

	} );

}

// the default view's pose on this land, read from the page: its distance, and the island camera's
// lowest pitch (its largest polar angle from straight down, degrees)
function probePose( url, size, extra ) {

	const [ , w, h, s = '1' ] = size.match( /^(\d+)x(\d+)(?:@([\d.]+))?$/ );
	const q = [ 'debug&paused&t=12&quality=high&weather=fair&hour=12', extra ].filter( Boolean ).join( '&' );
	return new Promise( ( resolve ) => {

		const child = spawn( process.execPath, [ 'tools/kit/gpu-lock.mjs', 'run', '--shared', '--', process.execPath, 'tools/kit/probe.mjs', url, '--q', q,
			'--w', w, '--h', h, '--scale', s, '--eval', '({ dist: P.camera.position.distanceTo( P.controls.target ), maxPolar: P.controls.maxPolarAngle * 180 / Math.PI })' ],
		{ cwd: REPO, stdio: [ 'ignore', 'pipe', 'inherit' ] } );
		children.add( child );
		const out = [];
		child.stdout.on( 'data', ( d ) => out.push( d ) );
		child.on( 'close', ( code ) => {

			children.delete( child );
			if ( code !== 0 ) { console.error( `day-sweep: the pose probe failed (exit ${ code })` ); process.exit( 1 ); }
			const value = JSON.parse( Buffer.concat( out ).toString() ).queries?.[ 0 ]?.steps?.[ 0 ]?.value;
			if ( ! value || ! ( value.dist > 0 ) || ! ( value.maxPolar > 0 && value.maxPolar < 90 ) ) {

				console.error( `day-sweep: the pose probe read no camera distance and lowest pitch (${ JSON.stringify( value ) })` );
				process.exit( 1 );

			}
			resolve( value );

		} );

	} );

}

// ------------------------------------------------------------------ the plan

async function planOf( options, url ) {

	const notes = [];
	const scope = options.scope ?? 'routine';
	if ( ! SCOPES[ scope ] ) usage( `no scope ${ scope } (routine or full)` );
	const names = options.views ? options.views.split( ',' ) : [ ...SCOPES[ scope ] ];
	for ( const n of names ) if ( ! CAMERAS.includes( n ) ) usage( `no camera ${ n } (${ CAMERAS.join( ', ' ) }; --view name:query adds one)` );
	const weathers = ( options.weathers ?? WEATHERS.join( ',' ) ).split( ',' ).filter( Boolean );
	for ( const w of weathers ) if ( ! WEATHER_NAMES.includes( w ) ) usage( `no weather ${ w } (${ WEATHER_NAMES.join( ', ' ) })` );
	const size = options.size ?? '2560x1440@1';
	// an earlier run this one cannot be compared with stops it here, before a frame is shot
	const earlier = options.compare ? earlierRun( options.compare, size, options.skyMaskDeg, [ ...names, ...options.view.map( ( t ) => t.slice( 0, t.indexOf( ':' ) ) ) ] ) : null;
	if ( earlier && ! earlier.skyComparable ) notes.push( `--compare: ${ earlier.skyNote }` );
	const everyTimes = timesOf( options.times ?? 'all' ), keyTimes = timesOf( options.times ?? 'key' );
	const needsPose = names.some( ( n ) => [ 'key', 'low', 'back' ].includes( n ) );
	const pose = needsPose ? await probePose( url, size, options.q ) : null;
	const cameras = [];
	for ( const n of names ) {

		const camera = { name: n, query: '', times: options.times || ! KEY_ONLY.has( n ) ? 'all' : 'key' };
		if ( n === 'key' ) Object.assign( camera, { heading: 'toward', dist: pose.dist } );
		if ( n === 'back' ) Object.assign( camera, { heading: 'away', dist: pose.dist } );
		if ( n === 'low' ) Object.assign( camera, { heading: 'toward', dist: pose.dist, polar: pose.maxPolar } );
		cameras.push( camera );

	}
	for ( const text of options.view ) {

		const colon = text.indexOf( ':' );
		if ( colon < 1 ) usage( `--view ${ JSON.stringify( text ) }: expected "name:query"` );
		const name = text.slice( 0, colon );
		if ( ! /^[A-Za-z0-9_-]+$/.test( name ) || name.includes( '--' ) || cameras.some( ( c ) => c.name === name ) ) usage( `bad or repeated camera name ${ name }` );
		cameras.push( { name, query: text.slice( colon + 1 ), times: 'all' } );

	}
	if ( ! cameras.length ) usage( 'no camera to sweep' );
	if ( pose ) notes.push( `pose probe: default view ${ pose.dist.toFixed( 2 ) } m, lowest pitch ${ ( 90 - pose.maxPolar ).toFixed( 1 ) } deg over the horizon (polar ${ pose.maxPolar.toFixed( 2 ) })` );
	// the transitions' moments join the first camera's times, so their endpoints are frames of the sweep
	const transitionMinutes = options.transitions ? TRANSITION_MOMENTS.map( ( m ) => m[ 1 ] ) : [];
	const frames = [];
	for ( const [ i, camera ] of cameras.entries() ) {

		const times = [ ...new Set( [ ...( camera.times === 'all' ? everyTimes : keyTimes ), ...( i === 0 ? transitionMinutes : [] ) ] ) ].sort( ( a, b ) => a - b );
		camera.scan = camera.times === 'all' && times.length >= 12;
		for ( const weather of weathers ) for ( const minute of times ) {

			const { q, az } = frameQuery( camera, weather, minute );
			frames.push( { camera: camera.name, weather, minute, view: viewName( camera.name, weather, minute ), q, az } );

		}

	}
	const transitions = [];
	if ( options.transitions ) for ( let i = 0; i + 1 < weathers.length; i ++ ) for ( const [ moment, minute ] of TRANSITION_MOMENTS ) {

		transitions.push( { camera: cameras[ 0 ].name, from: weathers[ i ], to: weathers[ i + 1 ], moment, minute,
			view: `${ cameras[ 0 ].name }--trans-${ weathers[ i ] }-${ weathers[ i + 1 ] }-${ hhmm( minute ) }`, q: frameQuery( cameras[ 0 ], weathers[ i ], minute ).q } );

	}
	return { scope, cameras, weathers, frames, transitions, notes, size, url, sunrise: SUNRISE / 60, sunset: SUNSET / 60 };

}

// ------------------------------------------------------------------ shooting

// what the views of a shoot cost, from their own records: the time they were busy and the time
// they waited for the GPU lock (colour/normal/<view>.json `page`)
function pageCosts( out, views ) {

	let busy = 0, lock = 0, read = 0;
	for ( const view of views ) {

		const file = path.join( out, 'colour', 'normal', `${ view }.json` );
		if ( ! existsSync( file ) ) continue;
		const page = JSON.parse( readFileSync( file, 'utf8' ) ).page;
		if ( ! page ) continue;
		busy += page.ms ?? 0;
		lock += page.lockMs ?? 0;
		read ++;

	}
	return { busyS: Math.round( busy / 1000 ), viewLockWaitS: Math.round( lock / 1000 ), viewsRead: read };

}

async function shoot( plan, out, options ) {

	const colour = path.join( out, 'colour' );
	mkdirSync( colour, { recursive: true } );
	const write = ( file, data ) => { writeFileSync( path.join( out, file ), JSON.stringify( data, null, '\t' ) ); return path.join( out, file ); };
	const frameFile = write( 'colour/views-frames.json', plan.frames.map( ( f ) => ( { name: f.view, q: f.q } ) ) );
	const transFile = write( 'colour/views-transitions.json', plan.transitions.map( ( t ) => ( { name: t.view, q: t.q, eval: `await s.setWeather( '${ t.to }', 6 ); s.weather.update( 3 ); await s.refreshEnvironment();` } ) ) );
	write( 'plan.json', plan );
	const common = [ '--warm', '--size', plan.size, ...( options.jobs ? [ '--jobs', options.jobs ] : [] ), ...( options.q ? [ '--q', options.q ] : [] ) ];
	const timing = { frameCount: plan.frames.length, transitionCount: plan.transitions.length };
	const phases = [
		[ 'frames', frameFile, plan.frames ],
		...( plan.transitions.length ? [ [ 'transitions', transFile, plan.transitions ] ] : [] ),
	];
	for ( const [ name, file, list ] of phases ) {

		console.log( `day-sweep: ${ name }: ${ list.length } views` );
		const started = Date.now();
		const { code, waited } = await runColour( [ 'shoot', plan.url, colour, '--views-file', file, '--pages', 'normal', ...common ] );
		if ( code !== 0 ) {

			console.error( `day-sweep: shooting the ${ name } views failed (exit ${ code })` );
			process.exit( 1 );

		}
		const costs = pageCosts( out, list.map( ( f ) => f.view ) );
		timing[ name ] = { views: list.length, wallS: Math.round( ( Date.now() - started ) / 1000 ), busyS: costs.busyS, lockWaitS: costs.viewLockWaitS + Math.round( waited ) };

	}
	return timing;

}

// ------------------------------------------------------------------ the numbers

const lum = ( [ r, g, b ] ) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const degrees = ( x ) => x.toFixed( 1 ).replace( /^-0\.0$/, '0.0' );

// a region's numbers from a colour-rows row, or null when it holds none. Each frame is sorted on its
// own (colour-rows rows --own) because the turned cameras share no cells from one frame to the next:
// a sort fixed on one frame read sea where the island had stood, and a sort of the sunlit and the
// shaded land fixed at noon read noon's shadow at every hour (a jump of three stops there). The land
// is taken whole and its dark end by rank, so the shade that moves with the sun moves no curve. The
// sky's mask works by angle, from the page's own read of the lights and the camera, so the disc and
// its glare do not make the sky's curve.
function regionOf( row ) {

	if ( ! row || row.L === null || ! row.rgb ) return null;
	const h = row.h * Math.PI / 180;
	return { n: row.n, L: row.L, C: row.C, h: row.h, a: row.C * Math.cos( h ), b: row.C * Math.sin( h ), log2Y: Math.log2( Math.max( lum( row.rgb ), 1e-5 ) ) };

}

// the regions a camera reads in some frame: the island view looks 50 degrees down, so no cell of
// it is sky, in any frame
const shown = ( plan, camera, views ) => REGIONS.filter( ( r ) => plan.frames.some( ( f ) => f.camera === camera && regionOf( views[ f.view ]?.rows[ r ] ) ) );

// a frame's heading: its own record, or the az of its query (a plan from before it was recorded)
const azOf = ( frame ) => frame.az ?? ( Number( frame.q?.match( /az=([\d.]+)/ )?.[ 1 ] ) || null );

function pointOf( frame, record ) {

	const regions = Object.fromEntries( REGIONS.map( ( r ) => [ r, regionOf( record.rows[ r ] ) ] ) );
	return { time: clock( frame.minute ), minute: frame.minute, hour: frame.minute / 60, az: azOf( frame ), elevation: record.elevation, ev: record.ev, exposure: record.exposure, key: record.key?.dir, regions };

}

// the colour's measure: the distance in the Oklab (a, b) plane, the lightness left to log2 luminance
const chromaDistance = ( p, q ) => Math.hypot( p.a - q.a, p.b - q.b );

// The steps between neighbouring frames of one camera and weather (the header's The steps).
// `points` by time; returns { steps, turned }: a step is { from, to, region, quantity, size, ratio,
// a, b } and a turned pair { from, to, turn }.
// The day is a circle: 23:00 and 00:00 are neighbours; with times that do not close, the first and
// last pair of the list are not scanned, nor is a pair over MAX_PAIR minutes wide. A pair's step is
// the change between its two frames less the time between them times the slope of the pair on
// either side (the one of the smaller size, so a single odd frame shows as two steps of its own
// size). A step in the light is flagged at its whole size, wherever the frames lie close or far
// apart, and a smooth curve shows only its bend. A change of light that moves both measures is two
// lines. A region read from 8-bit pixels in the dark is only as fine as its levels. The camera turn
// that a pair may hold (--turn-deg, 15): the sun at noon turns it 12 degrees in half an hour, the
// sun and moon switch at -12 degrees about 100. A turned pair is a change of the picture, not of the
// light; a pair beside it uses the slope of its other side only.
function stepsOf( points, thr, turnDeg ) {

	const n = points.length, steps = [], turned = [];
	if ( n < 4 ) return { steps, turned };
	const wraps = points[ 0 ].minute + 1440 - points[ n - 1 ].minute <= 90;
	const P = ( i ) => points[ ( ( i % n ) + n ) % n ];
	const T = ( i ) => points[ ( ( i % n ) + n ) % n ].minute + 1440 * Math.floor( i / n );
	// a pair (i, i+1) can be read for its change and as a neighbour's slope when it is not too wide
	// and its camera did not turn
	const turn = ( i ) => P( i ).az === null || P( i + 1 ).az === null ? 0 : turnBetween( P( i ).az, P( i + 1 ).az );
	const usable = ( i ) => T( i + 1 ) - T( i ) <= MAX_PAIR && turn( i ) <= turnDeg;
	const last = wraps ? n - 1 : n - 2;
	for ( let i = 0; i <= last; i ++ ) {

		const dt = T( i + 1 ) - T( i );
		if ( dt > MAX_PAIR ) continue;
		if ( turn( i ) > turnDeg ) { turned.push( { from: P( i ), to: P( i + 1 ), turn: turn( i ) } ); continue; }
		const leftOK = ( wraps || i - 1 >= 0 ) && usable( i - 1 ), rightOK = ( wraps || i + 2 <= n - 1 ) && usable( i + 1 );
		for ( const region of REGIONS ) {

			const at = ( k ) => P( k ).regions[ region ];
			const p = at( i ), q = at( i + 1 );
			if ( ! p || ! q ) continue;
			const sides = [];
			if ( leftOK && at( i - 1 ) ) sides.push( [ at( i - 1 ), p, T( i ) - T( i - 1 ) ] );
			if ( rightOK && at( i + 2 ) ) sides.push( [ q, at( i + 2 ), T( i + 2 ) - T( i + 1 ) ] );
			if ( ! sides.length ) continue;
			// the neighbours' slope of the smaller size: exact for a step and for a single odd frame
			const slopeY = sides.map( ( [ a, b, t ] ) => ( b.log2Y - a.log2Y ) / t ).reduce( ( s, x ) => Math.abs( x ) < Math.abs( s ) ? x : s );
			const slopeC = sides.map( ( [ a, b, t ] ) => [ ( b.a - a.a ) / t, ( b.b - a.b ) / t ] ).reduce( ( s, x ) => Math.hypot( ...x ) < Math.hypot( ...s ) ? x : s );
			const stops = q.log2Y - p.log2Y - slopeY * dt;
			const colour = Math.hypot( q.a - p.a - slopeC[ 0 ] * dt, q.b - p.b - slopeC[ 1 ] * dt );
			const base = { from: P( i ), to: P( i + 1 ), region, a: p, b: q };
			if ( Math.abs( stops ) > thr.stops ) steps.push( { ...base, quantity: 'log2Y', size: stops, ratio: Math.abs( stops ) / thr.stops } );
			if ( colour > thr.de ) steps.push( { ...base, quantity: 'oklab ab', size: colour, ratio: colour / thr.de } );

		}

	}
	return { steps, turned };

}

const stepLine = ( s, weather, camera ) => {

	const value = s.quantity === 'log2Y' ? `${ ( s.size >= 0 ? '+' : '' ) + s.size.toFixed( 3 ) } stops (${ s.a.log2Y.toFixed( 2 ) } to ${ s.b.log2Y.toFixed( 2 ) })`
		: `${ s.size.toFixed( 4 ) } (C ${ s.a.C.toFixed( 3 ) } h ${ s.a.h.toFixed( 0 ) } to C ${ s.b.C.toFixed( 3 ) } h ${ s.b.h.toFixed( 0 ) })`;
	return `${ s.ratio.toFixed( 2 ).padStart( 6 ) }x  ${ camera.padEnd( 8 ) } ${ weather.padEnd( 8 ) } ${ s.from.time }->${ s.to.time }  sun ${ degrees( s.from.elevation ) }->${ degrees( s.to.elevation ) } deg  ${ s.region.padEnd( 6 ) } ${ s.quantity.padEnd( 8 ) } ${ value }`;

};

// ------------------------------------------------------------------ the sheets

// pictures that failed, for the exit code
const failed = [];

function uv( args, what, quiet = false ) {

	const r = spawnSync( 'uv', [ 'run', ...args ], { cwd: REPO, stdio: [ 'ignore', quiet ? 'ignore' : 'inherit', 'inherit' ] } );
	if ( r.status !== 0 ) {

		console.error( `day-sweep: ${ what } failed (exit ${ r.status })` );
		failed.push( what );
		return false;

	}
	return true;

}

const sheet = ( files, labels, cols, width, file, extra = [] ) => uv( [ 'tools/kit/img.py', 'sheet', ...files, '--labels', labels.join( ',' ), '--cols', String( cols ), '--width', String( width ), ...extra, '--out', file ], `sheet ${ path.basename( file ) }` );

function link( from, to ) {

	rmSync( to, { force: true } );
	try { linkSync( from, to ); } catch { try { symlinkSync( from, to ); } catch { copyFileSync( from, to ); } }

}

// ------------------------------------------------------------------ the report

// a run's picture of a frame: the full-size frame, or the thumbnail a thinned run kept
const framePicture = ( root, f ) => [ 'png', 'jpg' ].map( ( e ) => path.join( root, 'frames', f.camera, `${ f.weather }-${ hhmm( f.minute ) }.${ e }` ) ).find( existsSync ) ?? null;
const framePng = ( out, f ) => path.join( out, 'frames', f.camera, `${ f.weather }-${ hhmm( f.minute ) }.png` );

// keeps the frames no line names as thumbnails only: frames/<camera>/<weather>-<HHMM>.jpg beside the
// flagged ones' PNGs, the PNGs of the rest (and their colour/normal files, the same file) then gone.
// All thumbnails first, the record of the thinning next, the deletions last: a failure leaves every
// frame whole. Returns whether it thinned.
// A frame is a PNG of several MB at the default size; in a routine run about a third of the frames
// are named, and the flagged ones, the sheets and the curves keep their size, so the run comes to
// under half of its size. A thinned run cannot read its pixels again: `report` on it redoes the
// numbers from colour/rows.json (jumps, curves, compare.txt and compare.json, transitions.txt) and
// leaves the pictures as they are, so a step found only under a new threshold has no full-size
// frame; the sheets, overviews and sheet-transitions.png need the whole frames, the compare/
// pictures do not.
function thin( plan, out, keep ) {

	const bytes = ( dir ) => Number( spawnSync( 'du', [ '-sk', dir ], { encoding: 'utf8' } ).stdout.split( '\t' )[ 0 ] ) * 1024;
	const before = bytes( out );
	const drop = plan.frames.filter( ( f ) => ! keep.has( f.view ) );
	for ( const camera of plan.cameras ) {

		const own = drop.filter( ( f ) => f.camera === camera.name );
		if ( own.length && ! uv( [ 'tools/kit/img.py', 'thumb', ...own.map( ( f ) => framePng( out, f ) ), '--short', String( THUMB ), '--out', path.join( out, 'frames', camera.name ) ], 'thumbnails', true ) ) return false;

	}
	writeFileSync( path.join( out, 'colour', 'thinned.json' ), JSON.stringify( { thumbShortSide: THUMB, kept: [ ...keep ].sort(), thinned: drop.map( ( f ) => f.view ) } ) );
	for ( const f of drop ) {

		rmSync( framePng( out, f ), { force: true } );
		rmSync( path.join( out, 'colour', 'normal', `${ f.view }.png` ), { force: true } );

	}
	console.log( `day-sweep: thinned ${ drop.length } of ${ plan.frames.length } frames to thumbnails, ${ keep.size } kept full size: ${ ( before / 1e9 ).toFixed( 2 ) } GB to ${ ( bytes( out ) / 1e9 ).toFixed( 2 ) } GB` );
	return true;

}

// colour-rows's rows of this run's frames, each sorted by its own depth read (--own: a turned
// camera's frames share no cells), into colour/rows.json once all of them are there
function readRows( out, plan, skyMaskDeg ) {

	const colour = path.join( out, 'colour' );
	const file = path.join( colour, 'rows.json' ), temporary = path.join( colour, 'rows.tmp.json' );
	const views = [ ...plan.frames, ...plan.transitions ].map( ( f ) => f.view );
	const r = spawnSync( process.execPath, [ 'tools/island/colour-rows.mjs', 'rows', colour, '--own', '--sky-mask-deg', String( skyMaskDeg ), '--views', views.join( ',' ), '--out', temporary ],
		{ cwd: REPO, stdio: [ 'ignore', 'ignore', 'inherit' ], maxBuffer: 1 << 30 } );
	if ( r.status !== 0 ) {

		console.error( `day-sweep: colour-rows rows failed (exit ${ r.status })` );
		process.exit( 1 );

	}
	const doc = JSON.parse( readFileSync( temporary, 'utf8' ) );
	if ( views.some( ( v ) => ! doc.views[ v ] ) ) { console.error( 'day-sweep: colour-rows rows left frames out' ); process.exit( 1 ); }
	renameSync( temporary, file );
	return doc;

}

// the swept points of each camera and weather, by time; `missing` lists frames without a row and
// `gaps` the frames where a region its camera reads has too few cells (a gap in its curve)
function seriesOf( plan, views, present ) {

	const cameras = {}, missing = [], gaps = [];
	for ( const frame of plan.frames ) {

		const record = views[ frame.view ];
		if ( ! record ) { missing.push( `${ frame.view }: no row` ); continue; }
		const point = pointOf( frame, record );
		const empty = present[ frame.camera ].filter( ( r ) => ! point.regions[ r ] );
		if ( empty.length ) gaps.push( `${ frame.view } (${ point.time }, sun ${ degrees( point.elevation ) } deg): too few cells in ${ empty.map( ( r ) => `${ r } (n ${ record.rows[ r ]?.n ?? 0 })` ).join( ', ' ) }` );
		( ( cameras[ frame.camera ] ??= {} )[ frame.weather ] ??= [] ).push( point );

	}
	for ( const weathers of Object.values( cameras ) ) for ( const list of Object.values( weathers ) ) list.sort( ( a, b ) => a.minute - b.minute );
	return { cameras, missing, gaps };

}

function report( out, options, thinNow ) {

	const plan = JSON.parse( readFileSync( path.join( out, 'plan.json' ), 'utf8' ) );
	const thr = options.thr;
	// a thinned run has no pixels to read again: its numbers come from the rows it wrote
	const thinned = existsSync( path.join( out, 'colour', 'thinned.json' ) );
	const kept = thinned ? JSON.parse( readFileSync( path.join( out, 'colour', 'rows.json' ), 'utf8' ) ) : null;
	// the earlier run is checked before the frames are read
	const earlier = options.compare ? earlierRun( options.compare, plan.size, thinned ? kept.skyMaskDeg : options.skyMaskDeg, plan.cameras.map( ( c ) => c.name ) ) : null;
	console.log( thinned ? 'day-sweep: thinned run: the numbers only, from colour/rows.json' : 'day-sweep: reading the frames' );
	const doc = thinned ? kept : readRows( out, plan, options.skyMaskDeg );
	const views = doc.views;
	const present = Object.fromEntries( plan.cameras.map( ( c ) => [ c.name, shown( plan, c.name, views ) ] ) );
	const { cameras, missing, gaps } = seriesOf( plan, views, present );
	for ( const c of plan.cameras ) {

		const own = plan.frames.filter( ( f ) => f.camera === c.name && views[ f.view ] );
		const range = ( r ) => { const n = own.map( ( f ) => views[ f.view ].rows[ r ]?.n ?? 0 ); return n.length ? `${ Math.min( ...n ) }-${ Math.max( ...n ) }` : '0'; };
		console.log( `day-sweep: ${ c.name }: cells a frame, ${ REGIONS.map( ( r ) => `${ r } ${ range( r ) }${ present[ c.name ].includes( r ) ? '' : ' (not read)' }` ).join( ', ' ) }` );

	}
	if ( gaps.length ) {

		writeFileSync( path.join( out, 'gaps.txt' ), gaps.join( '\n' ) + '\n' );
		console.log( `day-sweep: ${ gaps.length } frame(s) with a region of too few cells (gaps.txt)` );

	}
	// the turned cameras must point where the page's key light does while the light is the one they follow
	// (the sun above 0.7 degrees up: the key is the sun; under -12 degrees: it is the moon)
	const drift = [];
	for ( const frame of plan.frames ) {

		const camera = plan.cameras.find( ( c ) => c.name === frame.camera ), record = views[ frame.view ];
		if ( ! camera.heading || ! record?.key || ! ( azOf( frame ) > 0 ) || ! ( record.elevation > - 0.7 || record.elevation <= HANDOFF_ELEVATION ) ) continue;
		const sign = camera.heading === 'toward' ? - 1 : 1;
		const page = ( Math.atan2( sign * record.key.dir[ 0 ], sign * record.key.dir[ 2 ] ) * 180 / Math.PI + 360 ) % 360;
		drift.push( turnBetween( page, azOf( frame ) ) );

	}
	if ( drift.length && Math.max( ...drift ) > 0.5 ) console.warn( `day-sweep: the page's key light differs from the DayCycle's by up to ${ Math.max( ...drift ).toFixed( 2 ) } deg in the turned cameras' heading` );

	// rows.json
	const tableCameras = {};
	for ( const [ c, weathers ] of Object.entries( cameras ) ) tableCameras[ c ] = Object.fromEntries( Object.entries( weathers ).map( ( [ w, list ] ) => [ w, list.map( ( p ) => ( {
		time: p.time, hour: p.hour, az: p.az, elevation: Number( p.elevation.toFixed( 2 ) ), ev: p.ev, exposure: p.exposure,
		regions: Object.fromEntries( REGIONS.map( ( r ) => [ r, p.regions[ r ] && { n: p.regions[ r ].n, L: p.regions[ r ].L, C: p.regions[ r ].C, h: p.regions[ r ].h, log2Y: Number( p.regions[ r ].log2Y.toFixed( 4 ) ) } ] ) ) } ) ) ] ) );
	writeFileSync( path.join( out, 'rows.json' ), JSON.stringify( { thresholds: thr, turnDeg: options.turnDeg, skyMaskDeg: options.skyMaskDeg, sunrise: plan.sunrise, sunset: plan.sunset, regions: REGIONS, cameras: tableCameras }, null, '\t' ) );
	if ( missing.length ) {

		writeFileSync( path.join( out, 'missing.txt' ), missing.join( '\n' ) + '\n' );
		console.error( `day-sweep: STOP: ${ missing.length } frame(s) have no row (missing.txt):\n  ${ missing.slice( 0, 12 ).join( '\n  ' ) }` );
		process.exit( 1 );

	}

	// frames/, sheets, overviews
	if ( ! thinned ) {

		for ( const frame of plan.frames ) {

			mkdirSync( path.join( out, 'frames', frame.camera ), { recursive: true } );
			link( path.join( out, 'colour', 'normal', `${ frame.view }.png` ), framePng( out, frame ) );

		}
		const png = ( c, w, p ) => path.join( out, 'frames', c, `${ w }-${ hhmm( p.minute ) }.png` );
		for ( const [ c, weathers ] of Object.entries( cameras ) ) {

			for ( const [ w, list ] of Object.entries( weathers ) ) {

				sheet( list.map( ( p ) => png( c, w, p ) ), list.map( ( p ) => `${ p.time } · ${ degrees( p.elevation ) }°` ), 8, 320, path.join( out, `sheet-${ c }-${ w }.png` ) );

			}
			const files = [], labels = [];
			for ( const [ w, list ] of Object.entries( weathers ) ) for ( const [ , minute ] of KEY_MOMENTS ) {

				const near = list.reduce( ( best, p ) => Math.abs( p.minute - minute ) < Math.abs( best.minute - minute ) ? p : best );
				if ( Math.abs( near.minute - minute ) > 20 ) { files.push( null ); continue; }
				files.push( png( c, w, near ) );
				labels.push( `${ w } ${ near.time } · ${ degrees( near.elevation ) }°` );

			}
			if ( files.every( Boolean ) ) sheet( files, labels, KEY_MOMENTS.length, 288, path.join( out, `overview-${ c }.png` ) );
			else console.log( `day-sweep: no overview for ${ c }: its times miss a key moment` );

		}

	}

	// steps, curves
	const all = [], series = { sunrise: plan.sunrise, sunset: plan.sunset, cameras: {} };
	for ( const camera of plan.cameras ) {

		const lines = [], turnedLines = [];
		for ( const [ w, list ] of Object.entries( cameras[ camera.name ] ?? {} ) ) {

			const { steps, turned } = camera.scan ? stepsOf( list, thr, options.turnDeg ) : { steps: [], turned: [] };
			for ( const s of steps ) lines.push( { line: stepLine( s, w, camera.name ), ratio: s.ratio, weather: w, camera: camera.name, s } );
			for ( const t of turned ) turnedLines.push( `camera turned ${ t.turn.toFixed( 0 ).padStart( 3 ) } deg  ${ camera.name.padEnd( 8 ) } ${ w.padEnd( 8 ) } ${ t.from.time }->${ t.to.time }  sun ${ degrees( t.from.elevation ) }->${ degrees( t.to.elevation ) } deg` );
			( series.cameras[ camera.name ] ??= {} )[ w ] = {
				points: list.map( ( p ) => ( { hour: p.hour, elevation: p.elevation, ev: p.ev, regions: p.regions } ) ),
				jumps: steps.map( ( s ) => ( { hours: [ s.from.hour, s.to.hour ], region: s.region, quantity: s.quantity === 'log2Y' ? 'log2Y' : 'colour' } ) ),
				turned: turned.map( ( t ) => [ t.from.hour, t.to.hour ] ),
			};

		}
		lines.sort( ( a, b ) => b.ratio - a.ratio );
		all.push( ...lines );
		const head = `# ${ camera.name }: steps between neighbouring frames beyond what their neighbours' slope predicts: log2 luminance over ${ thr.stops.toFixed( 3 ) } stops, or Oklab (a, b) distance over ${ thr.de }; size in units of the threshold\n`
			+ ( camera.scan ? '' : '# (key moments only: no scan)\n' )
			+ ( turnedLines.length ? `# pairs the camera turned over ${ options.turnDeg } deg between, not scanned (the picture changed, not the light):\n${ turnedLines.map( ( l ) => `# ${ l }` ).join( '\n' ) }\n` : '' );
		writeFileSync( path.join( out, `jumps-${ camera.name }.txt` ), head + lines.map( ( l ) => l.line ).join( '\n' ) + ( lines.length ? '\n' : '' ) );

	}
	all.sort( ( a, b ) => b.ratio - a.ratio );
	writeFileSync( path.join( out, 'jumps.txt' ), `# every camera: steps beyond what the neighbours' slope predicts: log2 luminance over ${ thr.stops.toFixed( 3 ) } stops, or Oklab (a, b) distance over ${ thr.de }; by size in units of the threshold (jumps-<camera>.txt lists the pairs a camera turned over)\n${ all.map( ( l ) => l.line ).join( '\n' ) }${ all.length ? '\n' : '' }` );
	writeFileSync( path.join( out, 'colour', 'series.json' ), JSON.stringify( series ) );
	uv( [ '--with', 'matplotlib', '--with', 'numpy', 'tools/island/day-sweep-plot.py', path.join( out, 'colour', 'series.json' ), out ], 'the curves' );

	// the frames a line names stay whole: both frames of each step, and the comparison's
	const keep = new Set( all.flatMap( ( l ) => [ viewName( l.camera, l.weather, l.s.from.minute ), viewName( l.camera, l.weather, l.s.to.minute ) ] ) );
	if ( plan.transitions?.length ) transitions( plan, views, cameras, out, thr, ! thinned );
	if ( earlier ) compare( plan, doc, cameras, out, earlier, thr, keep );
	if ( thinNow && ! thinned && ! thin( plan, out, keep ) ) failed.push( 'thinning' );
	console.log( `day-sweep: ${ plan.frames.length } frames; steps ${ plan.cameras.map( ( c ) => `${ c.name } ${ all.filter( ( l ) => l.camera === c.name ).length }` ).join( ', ' ) } (jumps.txt)` );

}

// ------------------------------------------------------------------ transitions

// --transitions: each adjacent pair of weathers frozen half way through a front's six seconds
// (views.mjs's `weather-change` recipe: setWeather, update( 3 ), refreshEnvironment), beside the
// pair's two endpoints at that time. transitions.txt gives, per region, how far the half-way frame
// lies from the line between the endpoints (log2 luminance outside their span, Oklab (a, b) distance
// from their segment), and sheet-transitions.png the triples.
function transitions( plan, views, cameras, out, thr, pictures ) {

	const lines = [ `# the weather half way between two kept weathers against the line between their endpoints at that time (${ plan.cameras[ 0 ].name }); outside: log2 luminance beyond the endpoints' span, Oklab (a, b) distance from their segment` ];
	const files = [], labels = [];
	for ( const t of plan.transitions ) {

		const record = views[ t.view ];
		const a = cameras[ t.camera ]?.[ t.from ]?.find( ( p ) => p.minute === t.minute ), b = cameras[ t.camera ]?.[ t.to ]?.find( ( p ) => p.minute === t.minute );
		if ( ! record || ! a || ! b ) { lines.push( `${ t.from }->${ t.to } ${ clock( t.minute ) } ${ t.moment }: no frame` ); continue; }
		const mid = pointOf( t, record );
		const flags = [];
		for ( const region of REGIONS ) {

			const [ p, q, m ] = [ a.regions[ region ], b.regions[ region ], mid.regions[ region ] ];
			if ( ! p || ! q || ! m ) continue;
			const outside = Math.max( Math.min( p.log2Y, q.log2Y ) - m.log2Y, m.log2Y - Math.max( p.log2Y, q.log2Y ), 0 );
			// the mid point's distance from the segment p-q in the (a, b) plane
			const d = [ q.a - p.a, q.b - p.b ], v = [ m.a - p.a, m.b - p.b ];
			const len2 = d[ 0 ] ** 2 + d[ 1 ] ** 2;
			const s = len2 > 0 ? Math.max( 0, Math.min( 1, ( d[ 0 ] * v[ 0 ] + d[ 1 ] * v[ 1 ] ) / len2 ) ) : 0;
			const off = Math.hypot( v[ 0 ] - s * d[ 0 ], v[ 1 ] - s * d[ 1 ] );
			const flag = outside > thr.stops || off > thr.de ? '  <--' : '';
			flags.push( `    ${ region.padEnd( 6 ) } log2Y ${ p.log2Y.toFixed( 2 ) } | ${ m.log2Y.toFixed( 2 ) } | ${ q.log2Y.toFixed( 2 ) }  outside ${ outside.toFixed( 3 ) } stops   Oklab (a, b) off the segment ${ off.toFixed( 4 ) }${ flag }` );

		}
		lines.push( `${ t.from } -> ${ t.to }  ${ clock( t.minute ) } ${ t.moment }  sun ${ degrees( mid.elevation ) } deg`, ...flags );
		const normal = ( view ) => path.join( out, 'colour', 'normal', `${ view }.png` );
		files.push( normal( viewName( t.camera, t.from, t.minute ) ), normal( t.view ), normal( viewName( t.camera, t.to, t.minute ) ) );
		labels.push( `${ t.from } ${ clock( t.minute ) }`, `${ t.from }>${ t.to } half way`, `${ t.to } ${ clock( t.minute ) }` );

	}
	writeFileSync( path.join( out, 'transitions.txt' ), lines.join( '\n' ) + '\n' );
	if ( pictures && files.length ) sheet( files, labels, 3, 480, path.join( out, 'sheet-transitions.png' ) );

}

// ------------------------------------------------------------------ comparison with an earlier run

// An earlier run to compare with, checked before anything is shot or read: the same sort of cells
// and the same size, or a refusal (exit 2); a camera in common. A sky masked otherwise is not
// refused: its rows can only be read again from the full-size frames, which a thinned run no longer
// holds, so the sky is left out of the comparison and the others are compared.
function earlierRun( dir, size, skyMaskDeg, cameraNames ) {

	const before = path.resolve( dir );
	const refuse = ( why ) => { console.error( `day-sweep: --compare ${ path.basename( before ) }: ${ why }` ); process.exit( 2 ); };
	const planFile = path.join( before, 'plan.json' ), rowsFile = path.join( before, 'colour', 'rows.json' );
	if ( ! existsSync( planFile ) || ! existsSync( rowsFile ) ) refuse( 'no plan.json and colour/rows.json: not a day-sweep output' );
	const plan = JSON.parse( readFileSync( planFile, 'utf8' ) ), doc = JSON.parse( readFileSync( rowsFile, 'utf8' ) );
	if ( doc.sort !== 'own' ) refuse( `its rows were read by another sort (${ doc.sort }), not each frame's own: that run is out of date, run the sweep again` );
	if ( plan.size !== size ) refuse( `its frames are ${ plan.size }, this run's ${ size }` );
	if ( ! cameraNames.some( ( n ) => plan.cameras.some( ( o ) => o.name === n ) ) ) refuse( `it shares no camera with this run (it has ${ plan.cameras.map( ( c ) => c.name ).join( ', ' ) })` );
	// (a run read before the sky had a mask has none)
	const oldMask = doc.skyMaskDeg ?? 0, newMask = skyMaskDeg ?? 0;
	const skyComparable = oldMask === newMask;
	const skyNote = skyComparable ? '' : `sky not compared: its sky was masked ${ oldMask } deg round the lights, this run's ${ newMask } deg, and a sky's rows are read again only from full-size frames`;
	const thinned = path.join( before, 'colour', 'thinned.json' );
	const thumbShortSide = existsSync( thinned ) ? JSON.parse( readFileSync( thinned, 'utf8' ) ).thumbShortSide ?? THUMB : THUMB;
	return { before, plan, doc, skyComparable, skyNote, thumbShortSide };

}

// The comparison's sheets (compare/<camera>-<weather>.png): before, after and their difference x8,
// the frames that changed and the key moments. The sheet takes each side's full-size frame where both
// runs kept them all; otherwise every full-size frame is shrunk to the thinned run's thumbnail size
// first and the difference is between thumbnails (JPEG, so a few levels of it are the
// compression's), which compare.txt says per sheet. A frame is subtracted only where both runs hold
// it with the same query (the same pose, hour and weather); the rest are listed as only in one run
// or as posed differently. The readings come from the runs' colour/rows.json, never the pixels.
function compare( plan, doc, cameras, out, earlier, thr, keep ) {

	const { before, plan: oldPlan, doc: oldDoc, skyComparable, skyNote, thumbShortSide } = earlier;
	const regions = skyComparable ? REGIONS : REGIONS.filter( ( r ) => r !== 'sky' );
	const oldViews = oldDoc.views, newViews = doc.views;
	const oldFrames = new Map( oldPlan.frames.map( ( f ) => [ f.view, f ] ) ), newFrames = new Map( plan.frames.map( ( f ) => [ f.view, f ] ) );
	const sharedCameras = plan.cameras.map( ( c ) => c.name ).filter( ( n ) => oldPlan.cameras.some( ( o ) => o.name === n ) );
	const mine = plan.frames.filter( ( f ) => sharedCameras.includes( f.camera ) );
	const onlyNew = mine.filter( ( f ) => ! oldFrames.has( f.view ) );
	const onlyOld = oldPlan.frames.filter( ( f ) => sharedCameras.includes( f.camera ) && ! newFrames.has( f.view ) );
	// the same view name is the same frame only with the same query (pose, hour, weather)
	const posed = mine.filter( ( f ) => oldFrames.has( f.view ) && oldFrames.get( f.view ).q !== f.q );
	const shared = mine.filter( ( f ) => oldFrames.has( f.view ) && oldFrames.get( f.view ).q === f.q && oldViews[ f.view ] && newViews[ f.view ] );
	const list = ( frames ) => frames.length ? `${ frames.slice( 0, 24 ).map( ( f ) => f.view ).join( ' ' ) }${ frames.length > 24 ? ` and ${ frames.length - 24 } more` : '' }` : '';
	const lines = [ `# frames whose regions changed since ${ path.basename( before ) } beyond log2 luminance ${ thr.stops.toFixed( 3 ) } stops or Oklab (a, b) distance ${ thr.de } (each frame sorted by its own depth read; the readings from both runs' colour/rows.json)` ];
	const summary = [ `compared ${ shared.length } frames; only in the earlier run: ${ onlyOld.length }; only in this run: ${ onlyNew.length }; posed or timed differently (not subtracted): ${ posed.length }` ];
	if ( ! skyComparable ) summary.push( skyNote );
	if ( onlyOld.length ) summary.push( `only in the earlier run: ${ list( onlyOld ) }` );
	if ( onlyNew.length ) summary.push( `only in this run: ${ list( onlyNew ) }` );
	if ( posed.length ) summary.push( `posed differently: ${ list( posed ) }` );
	const result = [], sheets = {};
	mkdirSync( path.join( out, 'compare' ), { recursive: true } );
	for ( const camera of sharedCameras ) for ( const weather of plan.weathers ) {

		const frames = shared.filter( ( f ) => f.camera === camera && f.weather === weather ).sort( ( a, b ) => a.minute - b.minute );
		if ( ! frames.length ) continue;
		const flagged = [];
		let maxStops = 0, maxColour = 0;
		for ( const f of frames ) {

			const now = pointOf( f, newViews[ f.view ] ), was = pointOf( f, oldViews[ f.view ] );
			const changes = [];
			for ( const region of regions ) {

				const [ p, q ] = [ was.regions[ region ], now.regions[ region ] ];
				if ( ! p || ! q ) continue;
				const stops = q.log2Y - p.log2Y, colour = chromaDistance( p, q );
				maxStops = Math.max( maxStops, Math.abs( stops ) );
				maxColour = Math.max( maxColour, colour );
				if ( Math.abs( stops ) > thr.stops || colour > thr.de ) changes.push( { region, stops, colour } );

			}
			if ( changes.length ) {

				flagged.push( { f, now, changes } );
				keep.add( f.view );
				for ( const c of changes ) {

					lines.push( `${ camera.padEnd( 8 ) } ${ weather.padEnd( 8 ) } ${ now.time }  sun ${ degrees( now.elevation ).padStart( 5 ) } deg  ${ c.region.padEnd( 6 ) } ${ ( c.stops >= 0 ? '+' : '' ) + c.stops.toFixed( 3 ) } stops  Oklab (a, b) ${ c.colour.toFixed( 4 ) }` );
					result.push( { camera, weather, time: now.time, elevation: now.elevation, region: c.region, stops: c.stops, colour: c.colour } );

				}

			}

		}
		// the sheet: the frames that changed and the key moments, before | after | difference x8
		const pick = new Set( flagged.map( ( x ) => x.f.minute ) );
		for ( const [ , minute ] of KEY_MOMENTS ) pick.add( frames.reduce( ( best, f ) => Math.abs( f.minute - minute ) < Math.abs( best.minute - minute ) ? f : best ).minute );
		// each side's picture: the full-size frame, or the thumbnail a thinned run kept
		const picks = frames.filter( ( x ) => pick.has( x.minute ) ).map( ( f ) => ( { f, was: framePicture( before, f ), now: framePicture( out, f ), name: `${ hhmm( f.minute ).replace( /^(\d\d)/, '$1h' ) }_sun${ degrees( pointOf( f, newViews[ f.view ] ).elevation ) }deg` } ) ).filter( ( x ) => x.was && x.now );
		const full = picks.every( ( x ) => x.was.endsWith( '.png' ) && x.now.endsWith( '.png' ) );
		let from = full ? 'full-size frames' : `${ thumbShortSide } px thumbnails`;
		if ( picks.length ) {

			const dir = path.join( out, 'compare', `${ camera }-${ weather }` );
			rmSync( dir, { recursive: true, force: true } );
			for ( const side of [ 'before', 'after', 'png-before', 'png-after' ] ) mkdirSync( path.join( dir, side ), { recursive: true } );
			for ( const x of picks ) for ( const [ side, file ] of [ [ 'before', x.was ], [ 'after', x.now ] ] ) {

				// (a thumbnail on either side: every full-size frame is shrunk the way the thinning
				// shrank the other's, so the difference is taken between pictures of one size)
				if ( full || file.endsWith( '.jpg' ) ) link( file, path.join( dir, side, `${ x.name }${ path.extname( file ) }` ) );
				else link( file, path.join( dir, `png-${ side }`, `${ x.name }.png` ) );

			}
			if ( ! full ) for ( const side of [ 'before', 'after' ] ) {

				if ( readdirSync( path.join( dir, `png-${ side }` ) ).length ) uv( [ 'tools/kit/img.py', 'thumb', path.join( dir, `png-${ side }` ), '--short', String( thumbShortSide ), '--out', path.join( dir, side ) ], 'compare thumbnails', true );

			}
			if ( ! uv( [ 'tools/kit/img.py', 'sheet', path.join( dir, 'before' ), path.join( dir, 'after' ), '--diff', ...( full ? [] : [ '--match', '*.jpg' ] ), '--width', '480', '--out', path.join( out, 'compare', `${ camera }-${ weather }.png` ) ], `compare sheet ${ camera }-${ weather }` ) ) from = 'failed';
			rmSync( dir, { recursive: true, force: true } );

		} else from = 'no frame pictured on both sides';
		sheets[ `${ camera }-${ weather }` ] = from;
		summary.push( `${ camera.padEnd( 8 ) } ${ weather.padEnd( 8 ) } ${ String( flagged.length ).padStart( 3 ) } of ${ frames.length } frames changed; largest ${ maxStops.toFixed( 3 ) } stops, Oklab (a, b) ${ maxColour.toFixed( 4 ) }; sheet's difference from ${ from }` );

	}
	writeFileSync( path.join( out, 'compare.txt' ), [ ...summary.map( ( s ) => `# ${ s }` ), ...lines ].join( '\n' ) + '\n' );
	writeFileSync( path.join( out, 'compare.json' ), JSON.stringify( { before, thresholds: thr, notCompared: skyComparable ? [] : [ { region: 'sky', why: skyNote } ], sheets, onlyEarlier: onlyOld.map( ( f ) => f.view ), onlyThis: onlyNew.map( ( f ) => f.view ), posedDifferently: posed.map( ( f ) => f.view ), changed: result }, null, '\t' ) );
	console.log( `day-sweep: compare with ${ path.basename( before ) }:\n  ${ summary.join( '\n  ' ) }` );

}

// ------------------------------------------------------------------ main

const argv = process.argv.slice( 2 );
const reportOnly = argv[ 0 ] === 'report';
const { positional, options } = parse( reportOnly ? argv.slice( 1 ) : argv, reportOnly ? 'report' : 'shoot' );
if ( positional.length !== ( reportOnly ? 1 : 2 ) ) usage( reportOnly ? 'report needs <outDir>' : 'needs <url> <outDir>' );
const out = path.resolve( positional[ reportOnly ? 0 : 1 ] );
try {

	if ( ! reportOnly ) {

		// (a run into an old directory would read the old run's rows and frames)
		if ( existsSync( out ) && readdirSync( out ).length ) usage( `${ out } is not empty: a sweep goes into a new directory` );
		const url = positional[ 0 ];
		const started = Date.now();
		const plan = await planOf( options, url );
		console.log( `day-sweep: ${ plan.cameras.map( ( c ) => c.name ).join( ', ' ) } x ${ plan.weathers.join( ', ' ) }: ${ plan.frames.length } frames${ plan.transitions.length ? ` and ${ plan.transitions.length } transitions` : '' }` );
		for ( const note of plan.notes ) console.log( `day-sweep: ${ note }` );
		const timing = await shoot( plan, out, options );
		const reported = Date.now();
		report( out, options, ! options[ 'keep-frames' ] );
		timing.reportS = Math.round( ( Date.now() - reported ) / 1000 );
		timing.totalS = Math.round( ( Date.now() - started ) / 1000 );
		timing.perFrameS = Number( ( timing.frames.wallS / timing.frameCount ).toFixed( 2 ) );
		timing.perFrameBusyS = Number( ( timing.frames.busyS / timing.frameCount ).toFixed( 2 ) );
		writeFileSync( path.join( out, 'timing.json' ), JSON.stringify( timing, null, '\t' ) );
		console.log( `day-sweep: done in ${ Math.round( timing.totalS / 60 ) } min (${ out })` );

	} else report( out, options, options.thin );
	if ( failed.length ) {

		console.error( `day-sweep: ${ failed.length } step(s) failed: ${ [ ...new Set( failed ) ].join( ', ' ) }` );
		process.exit( 1 );

	}

} catch ( error ) {

	console.error( `day-sweep: ${ error.stack ?? error.message }` );
	process.exit( 1 );

}
