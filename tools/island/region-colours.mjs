// Reads what colour the frame shows per kind of surface and per kind of light, as final-pixel Oklab measurements.
//
// It answers "what colour is the sunlit rock, the shaded grass, the sky in this view, before and
// after a change", where a hand-placed box mixes sun and shade: final-pixel Oklab L, C and h per
// view, per kind of surface and per kind of light, with the sky, the sea, the land's darkest 5 % and
// any boxes. It prints what the frames hold and judges nothing: it knows no ranges. For the lighting
// in scene units over the meadow's blades use tools/island/meadow-light.mjs; for the day as a whole,
// tools/island/day-sweep.mjs (which runs this tool).
//
// Usage:
//   node tools/island/region-colours.mjs capture <url> <dir> --views-file f.json [--pages normal,light,ambient,classes]
//       [--size 2560x1440@1] [--q "extra&query"] [--warm] [--jobs 1] [--scene]
//   node tools/island/region-colours.mjs measure <dir> [--sort <dir> | --own [--sky-mask-deg N]] [--boxes f.json] [--views a,b]
//       [--sky-bands 0,5,15,30] [--out f.json] [--json]
//
// Options:
//   capture:
//     --views-file f.json  the views, in tools/kit/parity/capture-set.mjs's views file form (required)
//     --pages a,b          the pages to capture, of those below (all four)
//     --size WxH@dpr       the frame's size (2560x1440@1)
//     --q query            extra query options for every page
//     --warm               the views of a page reach each other by the scene jump instead of a load each
//     --jobs n             capture-set's page count (1)
//     --scene              the normal page also reads the scene's radiance, normals and camera
//   measure:
//     --sort <dir>         the directory whose classes and light pages give the sort (<dir>)
//     --own                sorts each view by its own depth read instead (with neither --sort nor --sky-bands)
//     --sky-mask-deg N     with --own: leaves the sky cells within N degrees of the sun or the moon out (0)
//     --boxes f.json       boxes to read: { "<base view>": { "<name>": [ x, y, w, h ] } } in the PNG's pixels
//     --views a,b          only these views (every view captured)
//     --sky-bands e0,e1,.. a measurement `sky <a>-<b>` per pair of rising elevations in degrees (frames captured with --scene)
//     --out f.json         the output file (<dir>/rows.json)
//     --json               prints the JSON instead of the table
//
// capture takes the frames: one tools/kit/parity/capture-set.mjs run per page, on one page each, into
// `<dir>/<page>/`. A view's `eval` sets its variant up; each view ends with this tool's read of the
// page. Without `--warm` a page takes a fresh load per view, since an `--eval-ready` runs on every
// view and capture-set cannot tell it only reads. `--warm` says so (capture.mjs `--ready-reads`): a
// view is then a scene jump, a fraction of a page load, with the same frames and readings byte for
// byte. A view with an eval of its own still ends its page. Paths are taken from the directory the
// tool is called in. measure is plain node over that output.
//
// The pages:
//   normal    the frame itself: the PNG, the exposure, the depth's sky and sea shares
//   light     flags=lightOnly:2,grey:1: every lit surface a white card, specular off
//   ambient   the same with ambientOnly: the key light taken out
//   classes   flags=classes&aa=off: each cell's kind (packages/render/debug/Classes.ts; its codes stored at
//             most 2^15, so a page pre-exposed past half float, a deep overcast night, decodes)
//
// The sort. The frame is cut into a grid of 256 by 144 cells, each read over the 3 by 3 pixels at its
// centre, the same pixels on every page (packages/render/debug/RadianceAov.ts `forCellTexels`):
//   land      cells with no sky, no sea and a kind
//   d         a cell's direct share, 1 - ambient / light (luminance)
//   sun       land cells with d at or over 0.7 of the land's 95th percentile of d
//   shade     land cells with d at or under 0.2 of it (the penumbra between is in neither)
//   sky, sea  cells more than 0.99 sky or sea
// A variant is read through the sort of its base view, so a measurement covers the same cells before
// and after a change, whatever the change does to the lighting: a view `<base>--<variant>` takes the sort of `<base>`
// in the `--sort` directory, or its own name if that holds it, and needs only the normal page.
//
// `--own` sorts each view by its own normal page's depth read (sky and sea cells more than 0.99 so,
// land the cells with neither), for views that share no camera (a camera turned at each frame, where
// a base's cells would read sea as land). It gives the land and its floor, no kinds, light, card,
// p95 or shares, and needs no other page. `--sky-mask-deg` works by angle, from the page's read of
// the lights and the camera; a light more than a degree under the horizon has no disc to leave out.
//
// The measurements (the JSON's `rows`), each { n, L, C, h, rgb, card }: `<kind> sun`, `<kind> shade`
// and `<kind>` for each kind that shows; `land sun` and `land shade` over every kind; `land`, `sky`,
// `sea`; `floor`, the darkest 5 % of the frame's own land cells. rgb is the measurement's mean linear
// pixel, L, C, h the Oklab of that mean. card is the mean luminance of the same cells on the light
// page, in scene units (null without a light page). A measurement over fewer than 8 cells keeps its n
// and has null values. A box gives the medians of its pixels' L, C, h (as `img.py stats --oklab`), p5
// and p90 of L, and the measurements `mean`, `dark` and `lit` (the pixels under and over its median
// L: a crown's two halves).
//
// With `capture --scene`, measure adds to every measurement `scene` { Y, med, hdr } (the cells'
// luminance in scene units before the display chain, packages/render/debug/Radiance.ts) and the
// measurements that need the cells' direction: `sky band`, `sea away`, `<kind> flat`, `<kind> sun flat`, `land flat` and `land sun
// flat`; the view's record adds `E`, pi times the sky's irradiance (the probe's: on a clear or fair
// day it takes the fog layer's haze, which the land's own sky light leaves out,
// packages/render/sky/Sky.ts `fogEnvironment`), and `preExposure`. A `--sky-bands` measurement read
// over fewer than 64 cells has null values and `note: 'too few cells'`. The measurements' definitions are beside
// the code that sorts them (`sortOf`).
//
// Each view's record also holds `ev` and `exposure` (packages/render/post/Exposure.ts), the key light's
// `key` { colour, dir }, the sun's `elevation` (degrees), the land's `p95` of d, `shares` { sun,
// shade, penumbra } of the land, and `note`, whatever the view's eval left in
// `__PONLAI__.colourNote` (a script reads tune.set's report that way).
//
// Output: capture writes `<dir>/<page>/` (capture-set's PNGs and JSON per view). measure writes
// `<dir>/rows.json` (or `--out`) and prints a table per view, or the JSON with `--json`.
//
// GPU lock and browser: capture runs each page's capture-set under `tools/kit/gpu-lock.mjs run
// --shared` (docs/reference/gpu-lock.md) in the capture tools' headless browser; measure neither.
//
// Cost: capture, a page load per page and view (a scene jump per view with `--warm`); measure, seconds of
// CPU (it starts under the QoS policy, tools/kit/qos.mjs).
//
// Exit codes: 0 done; 1 a page that failed, a missing page or view, or a page's failed read; 2 bad usage.
import '../kit/help.mjs';
import '../kit/qos.mjs'; // first: the PNG decodes run with the application policy
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from '../kit/capture-browser.mjs';
import { ROOT } from '../kit/root.mjs';

const REPO = ROOT;
const NX = 256, NY = 144, CELL = 3;
const MIN_CELLS = 8;
// the least cells a --sky-bands measurement is read over
const SKY_BAND_CELLS = 64;
const KINDS = [ 'sky', 'sea', 'ground', 'rock', 'grass', 'leaves', 'wood', 'figure', 'other' ]; // packages/render/debug/Classes.ts
const FIRST_LAND = KINDS.indexOf( 'ground' );
const PAGES = {
	normal: '',
	light: 'flags=lightOnly:2,grey:1',
	ambient: 'flags=lightOnly:2,grey:1,ambientOnly',
	classes: 'flags=classes&aa=off',
};

// what each page's view hands back, as a capture's --eval-ready: its value lands in the view's JSON
// (`scene`: the normal page also reads the scene's radiance, the normals and the camera)
const pageRead = ( scene ) => `async () => {

	const cells = { grid: [ ${ NX }, ${ NY } ], cell: ${ CELL }, boxes: {} };
	const short = ( values ) => values.map( ( v ) => Number( v.toPrecision( 4 ) ) );
	if ( P.flags.classes ) return { cls: ( await P.radiance( { ...cells, aov: 'class' } ) ).values };
	if ( P.flags.lightOnly ) return { opaque: short( ( await P.radiance( { ...cells, source: 'opaque' } ) ).grid.rgb ) };
	const { r, g, b } = P.sky.keyColor;
	const matrix = ( m ) => Array.from( m.elements, ( v ) => Number( v.toPrecision( 8 ) ) );
	const out = {
		exposure: await P.pipeline.readExposure(),
		depth: short( ( await P.radiance( { ...cells, aov: 'depth' } ) ).values ),
		key: { colour: [ r, g, b ], dir: P.sky.keyDir.toArray() },
		lights: { sun: P.sky.sunDir.toArray(), moon: P.sky.moonDir.toArray() },
		view: { world: matrix( P.camera.matrixWorldInverse ), proj: matrix( P.camera.projectionMatrix ) },
		elevation: P.sky.elevation,
		note: P.colourNote ?? null,
	};
	if ( ${ scene } ) {

		const c = P.camera, i = P.sky.skyIrradiance, opaque = await P.radiance( { ...cells, source: 'opaque' } );
		c.updateMatrixWorld();
		Object.assign( out, {
			preExposure: opaque.preExposure,
			opaque: short( opaque.grid.rgb ),
			hdr: short( ( await P.radiance( { ...cells, source: 'hdr' } ) ).grid.rgb ),
			normal: short( ( await P.radiance( { ...cells, aov: 'normal' } ) ).values ),
			camera: { position: c.position.toArray(), world: c.matrixWorld.toArray(), projectionInverse: c.projectionMatrixInverse.toArray() },
			E: Math.PI * ( 0.2126 * i.r + 0.7152 * i.g + 0.0722 * i.b ),
		} );

	}
	return out;

}`;

function usage( message ) {

	console.error( message );
	console.error( 'usage: region-colours.mjs capture <url> <dir> --views-file f.json [options] | measure <dir> [options] (see the file header)' );
	process.exit( 2 );

}

function parse( list, known ) {

	const positional = [], options = {};
	for ( let i = 0; i < list.length; i ++ ) {

		const a = list[ i ];
		if ( ! a.startsWith( '--' ) ) { positional.push( a ); continue; }
		const k = a.slice( 2 );
		if ( ! known.includes( k ) ) usage( `unknown option ${ a }` );
		if ( k === 'json' || k === 'warm' || k === 'own' || k === 'scene' ) options[ k ] = true;
		else if ( list[ i + 1 ] === undefined ) usage( `${ a } needs a value` );
		else options[ k ] = list[ ++ i ];

	}
	return { positional, options };

}

// runs a command with the output on ours; a SIGTERM or SIGINT to this process goes on to it (the
// GPU lock's run forwards it to the capture below, which closes its browser)
function runChild( file, args ) {

	return new Promise( ( resolve ) => {

		const child = spawn( process.execPath, [ file, ...args ], { cwd: REPO, stdio: 'inherit' } );
		const handlers = [ 'SIGTERM', 'SIGINT' ].map( ( signal ) => [ signal, () => child.kill( signal ) ] );
		for ( const [ signal, handler ] of handlers ) process.on( signal, handler );
		child.on( 'close', ( code ) => {

			for ( const [ signal, handler ] of handlers ) process.off( signal, handler );
			resolve( code ?? 1 );

		} );

	} );

}

async function capture( list ) {

	const { positional, options } = parse( list, [ 'views-file', 'pages', 'size', 'q', 'jobs', 'warm', 'scene' ] );
	if ( positional.length !== 2 || ! options[ 'views-file' ] ) usage( 'capture needs <url> <dir> --views-file f.json' );
	const url = positional[ 0 ], dir = path.resolve( positional[ 1 ] ), viewsFile = path.resolve( options[ 'views-file' ] );
	const pages = ( options.pages ?? Object.keys( PAGES ).join( ',' ) ).split( ',' );
	for ( const page of pages ) if ( PAGES[ page ] === undefined ) usage( `no page ${ page } (of ${ Object.keys( PAGES ).join( ', ' ) })` );
	for ( const page of pages ) {

		const q = [ PAGES[ page ], options.q ].filter( Boolean ).join( '&' );
		console.log( `region-colours: page ${ page }` );
		const status = await runChild( 'tools/kit/gpu-lock.mjs', [ 'run', '--shared', '--',
			process.execPath, 'tools/kit/parity/capture-set.mjs', url, path.join( dir, page ), '--size', options.size ?? '2560x1440@1', '--jobs', options.jobs ?? '1',
			'--views-file', viewsFile, ...( q ? [ '--q', q ] : [] ), '--', ...( options.warm ? [ '--ready-reads' ] : [] ), '--eval-ready', pageRead( options.scene === true ) ] );
		if ( status !== 0 ) {

			console.error( `region-colours: page ${ page } failed` );
			return 1;

		}

	}
	return 0;

}

// ------------------------------------------------------------------ colour

const SRGB = Float64Array.from( { length: 256 }, ( _, i ) => {

	const c = i / 255;
	return c <= 0.04045 ? c / 12.92 : ( ( c + 0.055 ) / 1.055 ) ** 2.4;

} );
const luminance = ( r, g, b ) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// linear Rec. 709 to Oklab (Björn Ottosson's) as [ L, a, b ]
function oklab( r, g, b ) {

	const l = Math.cbrt( 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b );
	const m = Math.cbrt( 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b );
	const s = Math.cbrt( 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b );
	return [ 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s ];

}

const round = ( v, digits = 4 ) => Number( v.toFixed( digits ) );

// the measurement of a mean linear colour. L, C and h are the Oklab of the cells' mean linear colour,
// so a measurement's hue is the hue of its average colour, steady where single pixels are near
// neutral. A measurement's card (cellsRow) reads the lighting where its rgb reads the frame: `land
// sun` over `land shade` cards is the contrast of the lighting itself.
function rowOf( n, r, g, b ) {

	const [ L, A, B ] = oklab( r, g, b );
	const h = ( Math.atan2( B, A ) * 180 / Math.PI + 360 ) % 360;
	return { n, L: round( L ), C: round( Math.hypot( A, B ) ), h: round( h, 1 ), rgb: [ r, g, b ].map( ( v ) => Number( v.toPrecision( 4 ) ) ) };

}

// linear between the two nearest ranks, as numpy's default; `sorted` ascending
const rank = ( sorted, q ) => {

	const x = q * ( sorted.length - 1 ), i = Math.floor( x );
	return i + 1 < sorted.length ? sorted[ i ] + ( sorted[ i + 1 ] - sorted[ i ] ) * ( x - i ) : sorted[ i ];

};
const median = ( values ) => rank( Float64Array.from( values ).sort(), 0.5 );

// ------------------------------------------------------------------ the frames

// a view's JSON value on one page of a directory
function pageValue( dir, page, view ) {

	const file = path.join( dir, page, `${ view }.json` );
	if ( ! existsSync( file ) ) throw new Error( `no ${ file }: run capture with --pages ${ page }` );
	const read = JSON.parse( readFileSync( file, 'utf8' ) ).readyEvals?.[ 0 ];
	if ( ! read || 'error' in read ) throw new Error( `${ file }: the page's read failed: ${ read?.error ?? 'none recorded' }` );
	return read.value;

}

// the frame's pixels: { width, height, data (8-bit RGB) }
const framePixels = ( dir, view ) => decodePng( readFileSync( path.join( dir, 'normal', `${ view }.png` ) ) );

// each cell's mean linear colour, over the same pixels as the page's cells
function cellColours( { width, height, data } ) {

	const out = new Float64Array( NX * NY * 3 );
	const lo = Math.floor( ( CELL - 1 ) / 2 );
	for ( let j = 0, c = 0; j < NY; j ++ ) for ( let i = 0; i < NX; i ++, c ++ ) {

		const cx = Math.floor( ( i + 0.5 ) * width / NX ) - lo, cy = Math.floor( ( j + 0.5 ) * height / NY ) - lo;
		for ( let dy = 0; dy < CELL; dy ++ ) for ( let dx = 0; dx < CELL; dx ++ ) {

			const x = Math.min( width - 1, Math.max( 0, cx + dx ) ), y = Math.min( height - 1, Math.max( 0, cy + dy ) );
			const p = ( y * width + x ) * 3;
			for ( let k = 0; k < 3; k ++ ) out[ c * 3 + k ] += SRGB[ data[ p + k ] ] / ( CELL * CELL );

		}

	}
	return out;

}

// a 4 x 4 matrix (column major, as three's toArray) times ( x, y, z, w )
const transform = ( m, x, y, z, w ) => [ 0, 1, 2, 3 ].map( ( k ) => m[ k ] * x + m[ 4 + k ] * y + m[ 8 + k ] * z + m[ 12 + k ] * w );

// each cell's ray from the camera (a unit world direction, three per cell), through the centre of
// the cell's pixels (the camera's matrices as the scene page read them)
function cellRays( camera ) {

	const rays = new Float64Array( NX * NY * 3 ), [ px, py, pz ] = camera.position;
	for ( let j = 0, c = 0; j < NY; j ++ ) for ( let i = 0; i < NX; i ++, c ++ ) {

		const v = transform( camera.projectionInverse, ( i + 0.5 ) / NX * 2 - 1, 1 - ( j + 0.5 ) / NY * 2, 0.5, 1 );
		const [ x, y, z ] = transform( camera.world, v[ 0 ] / v[ 3 ], v[ 1 ] / v[ 3 ], v[ 2 ] / v[ 3 ], 1 );
		const dx = x - px, dy = y - py, dz = z - pz, l = Math.hypot( dx, dy, dz ) || 1;
		rays.set( [ dx / l, dy / l, dz / l ], c * 3 );

	}
	return rays;

}

// The sky's bands (measure --sky-bands e0,e1,...): a measurement `sky <a>-<b>` per pair of neighbouring edges,
// the sky cells whose ray stands at least a and under b degrees up (half open, [a, b)) and turns more
// than 90 degrees in azimuth from the key light's, as `sky band` takes them. Each cell's elevation
// is its centre's ray through the camera's matrices as the scene page read them, between frames:
// unjittered (the temporal modes jitter the scene passes' projection only, and MSAA has no
// jitter). These are not `sky band` (4 to 15 degrees), which stays as it is.
const skyBandRow = ( a, b ) => `sky ${ a }-${ b }`;

// The measurements that need the cells' direction (frames captured with --scene): `sky band`, the sky cells
// whose ray stands 4 to 15 degrees up and turns more than 90 degrees in azimuth from the key
// light's (the sun's, by night the moon's); `sea away`, the sea cells whose ray lies 0 to 5 degrees
// under the horizon on that side; `<kind> flat`, `<kind> sun flat`, `land flat` and `land sun
// flat`, the cells whose normal (RadianceAov.ts `normal`) stands within about 25 degrees of straight
// up: a flat open card's light, under a sky alone, is read against the view's `E`. A view read
// through another's sort takes these measurements from the base's normals and camera.
// the sort of a view (see the header): { land, cells: { row: [ cell indices ] }, p95 }
function sortOf( dir, view, skyBands = [] ) {

	const normal = pageValue( dir, 'normal', view ), light = pageValue( dir, 'light', view ).opaque;
	const ambient = pageValue( dir, 'ambient', view ).opaque, cls = pageValue( dir, 'classes', view ).cls;
	const depth = normal.depth;
	const count = NX * NY;
	if ( cls.length !== count || depth.length !== count * 3 ) throw new Error( `${ view }: the pages' grid is not ${ NX } by ${ NY }` );
	const land = [], cells = {}, d = new Float64Array( count );
	const add = ( row, c ) => ( cells[ row ] ??= [] ).push( c );
	for ( let c = 0; c < count; c ++ ) {

		const sky = depth[ c * 3 + 1 ], sea = depth[ c * 3 + 2 ];
		if ( sky > 0.99 ) add( 'sky', c );
		if ( sea > 0.99 ) add( 'sea', c );
		if ( sky !== 0 || sea !== 0 || cls[ c ] < FIRST_LAND ) continue;
		land.push( c );
		// (a card's light that a page stored as not finite is null in the JSON: no direct share)
		const at = ( v, k ) => v[ c * 3 + k ] ?? NaN;
		const a = luminance( at( ambient, 0 ), at( ambient, 1 ), at( ambient, 2 ) ), l = luminance( at( light, 0 ), at( light, 1 ), at( light, 2 ) );
		d[ c ] = 1 - a / Math.max( l, 1e-9 );

	}
	const shares = Float64Array.from( land, ( c ) => d[ c ] ).filter( Number.isFinite ).sort();
	const p95 = shares.length ? rank( shares, 0.95 ) : 0;
	cells.land = land;
	for ( const c of land ) {

		const kind = KINDS[ cls[ c ] ];
		add( kind, c );
		if ( d[ c ] >= 0.7 * p95 ) {

			add( `${ kind } sun`, c );
			add( 'land sun', c );

		} else if ( d[ c ] <= 0.2 * p95 ) {

			add( `${ kind } shade`, c );
			add( 'land shade', c );

		}

	}
	// the measurements that need each cell's direction (the scene's read: see the header)
	if ( skyBands.length && ! normal.camera ) throw new Error( `${ view }: --sky-bands needs frames captured with --scene` );
	if ( normal.camera && normal.normal ) {

		const rays = cellRays( normal.camera ), [ kx, , kz ] = normal.key.dir, DEG = Math.PI / 180;
		const away = ( c ) => rays[ c * 3 ] * kx + rays[ c * 3 + 2 ] * kz < 0;
		const up = ( c ) => Math.asin( Math.max( - 1, Math.min( 1, rays[ c * 3 + 1 ] ) ) ) / DEG;
		for ( const c of cells.sky ?? [] ) if ( away( c ) && up( c ) >= 4 && up( c ) <= 15 ) add( 'sky band', c );
		for ( let k = 0; k + 1 < skyBands.length; k ++ ) {

			const [ a, b ] = [ skyBands[ k ], skyBands[ k + 1 ] ], row = skyBandRow( a, b );
			cells[ row ] ??= [];
			for ( const c of cells.sky ?? [] ) if ( away( c ) && up( c ) >= a && up( c ) < b ) add( row, c );

		}
		for ( const c of cells.sea ?? [] ) if ( away( c ) && up( c ) >= - 5 && up( c ) < 0 ) add( 'sea away', c );
		for ( const row of Object.keys( cells ).filter( ( r ) => r.endsWith( ' sun' ) || KINDS.indexOf( r ) >= FIRST_LAND || r === 'land' ) ) {

			for ( const c of cells[ row ] ) if ( ( normal.normal[ c * 3 + 1 ] ?? 0 ) >= 0.9 ) add( `${ row } flat`, c );

		}

	}
	const share = ( row ) => land.length ? round( ( cells[ row ]?.length ?? 0 ) / land.length ) : 0;
	const split = { sun: share( 'land sun' ), shade: share( 'land shade' ) };
	split.penumbra = round( land.length ? 1 - split.sun - split.shade : 0 );
	return { land, cells, p95, shares: split };

}

// a measurement over some cells of the frame, with its card from the light page's cells (`light`, or null)
// and, from the scene's read (`scene`: the normal page's `opaque` and `hdr` grids, or null), its
// radiance in scene units
function cellsRow( colours, list, light, scene ) {

	if ( list.length < MIN_CELLS ) return { n: list.length, L: null, C: null, h: null, rgb: null, card: null, ...( scene ? { scene: null } : {} ) };
	let r = 0, g = 0, b = 0, card = 0, cards = 0;
	for ( const c of list ) {

		r += colours[ c * 3 ];
		g += colours[ c * 3 + 1 ];
		b += colours[ c * 3 + 2 ];
		// (a cell the page stored as not finite is null in the JSON: left out of the card)
		const l = light ? luminance( light[ c * 3 ] ?? NaN, light[ c * 3 + 1 ] ?? NaN, light[ c * 3 + 2 ] ?? NaN ) : NaN;
		if ( Number.isFinite( l ) ) {

			card += l;
			cards ++;

		}

	}
	const row = { ...rowOf( list.length, r / list.length, g / list.length, b / list.length ), card: cards ? Number( ( card / cards ).toPrecision( 4 ) ) : null };
	if ( scene ) {

		const of = ( grid ) => list.map( ( c ) => luminance( grid[ c * 3 ] ?? NaN, grid[ c * 3 + 1 ] ?? NaN, grid[ c * 3 + 2 ] ?? NaN ) ).filter( Number.isFinite );
		const opaque = of( scene.opaque ), hdr = of( scene.hdr );
		const mean = ( v ) => v.length ? Number( ( v.reduce( ( t, x ) => t + x, 0 ) / v.length ).toPrecision( 4 ) ) : null;
		row.scene = { Y: mean( opaque ), med: opaque.length ? Number( median( opaque ).toPrecision( 4 ) ) : null, hdr: mean( hdr ) };

	}
	return row;

}

// a box's numbers over every pixel (see the header). `mean` is the Oklab of the pixels' mean linear
// colour, which a box of mixed light reads quite otherwise than by its medians.
function boxRow( { width, height, data }, [ x0, y0, w, h ] ) {

	if ( x0 < 0 || y0 < 0 || x0 + w > width || y0 + h > height ) throw new Error( `box ${ [ x0, y0, w, h ] } lies outside the ${ width } by ${ height } frame` );
	const n = w * h, Ls = new Float64Array( n ), Cs = new Float64Array( n ), hs = new Float64Array( n ), rgb = new Float64Array( n * 3 );
	for ( let y = 0, i = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++, i ++ ) {

		const p = ( ( y0 + y ) * width + x0 + x ) * 3;
		const r = rgb[ i * 3 ] = SRGB[ data[ p ] ], g = rgb[ i * 3 + 1 ] = SRGB[ data[ p + 1 ] ], b = rgb[ i * 3 + 2 ] = SRGB[ data[ p + 2 ] ];
		const [ L, A, B ] = oklab( r, g, b );
		Ls[ i ] = L;
		Cs[ i ] = Math.hypot( A, B );
		hs[ i ] = ( Math.atan2( B, A ) * 180 / Math.PI + 360 ) % 360;

	}
	const sorted = Ls.slice().sort(), mid = rank( sorted, 0.5 );
	const half = ( keep ) => {

		const sum = [ 0, 0, 0 ];
		let count = 0;
		for ( let i = 0; i < n; i ++ ) if ( keep( Ls[ i ] ) ) {

			for ( let k = 0; k < 3; k ++ ) sum[ k ] += rgb[ i * 3 + k ];
			count ++;

		}
		return count ? rowOf( count, sum[ 0 ] / count, sum[ 1 ] / count, sum[ 2 ] / count ) : null;

	};
	return { n, L: round( mid ), C: round( median( Cs ) ), h: round( median( hs ), 1 ), p5: round( rank( sorted, 0.05 ) ), p90: round( rank( sorted, 0.9 ) ),
		mean: half( () => true ), dark: half( ( L ) => L < mid ), lit: half( ( L ) => L >= mid ) };

}

// whether a cell lies within `deg` degrees of the sun or the moon, as the page read them (--own
// --sky-mask-deg): each cell's ray from the camera's projection, each light's direction in the
// camera's frame. A light more than a degree under the horizon has no disc to see, only the glow
// that the sky is.
function nearLight( read, deg ) {

	if ( ! read.view || ! read.lights ) throw new Error( 'the pages hold no read of the lights and the camera (captured by an older region-colours): capture again' );
	const { world: e, proj } = read.view;
	const lights = Object.values( read.lights ).filter( ( d ) => d[ 1 ] > - Math.sin( Math.PI / 180 ) )
		.map( ( d ) => [ e[ 0 ] * d[ 0 ] + e[ 4 ] * d[ 1 ] + e[ 8 ] * d[ 2 ], e[ 1 ] * d[ 0 ] + e[ 5 ] * d[ 1 ] + e[ 9 ] * d[ 2 ], e[ 2 ] * d[ 0 ] + e[ 6 ] * d[ 1 ] + e[ 10 ] * d[ 2 ] ] );
	const cos = Math.cos( deg * Math.PI / 180 );
	return ( c ) => {

		const x = ( ( c % NX + 0.5 ) / NX * 2 - 1 ) / proj[ 0 ], y = ( 1 - ( Math.floor( c / NX ) + 0.5 ) / NY * 2 ) / proj[ 5 ], length = Math.hypot( x, y, 1 );
		return lights.some( ( l ) => ( x * l[ 0 ] + y * l[ 1 ] - l[ 2 ] ) / length > cos );

	};

}

// the sort of a view by its own depth read (--own): sky and sea cells, and the land between them
function ownSortOf( read, maskDeg ) {

	const depth = read.depth, near = maskDeg > 0 ? nearLight( read, maskDeg ) : () => false;
	const cells = {}, land = [];
	let masked = 0;
	for ( let c = 0; c < NX * NY; c ++ ) {

		const sky = depth[ c * 3 + 1 ], sea = depth[ c * 3 + 2 ];
		if ( sky > 0.99 ) {

			if ( near( c ) ) masked ++;
			else ( cells.sky ??= [] ).push( c );

		}
		if ( sea > 0.99 ) ( cells.sea ??= [] ).push( c );
		if ( sky === 0 && sea === 0 ) land.push( c );

	}
	cells.land = land;
	return { land, cells, p95: null, shares: null, masked };

}

function measure( list ) {

	const { positional, options } = parse( list, [ 'sort', 'own', 'sky-mask-deg', 'boxes', 'views', 'out', 'json', 'sky-bands' ] );
	if ( options.own && options.sort ) usage( '--own and --sort do not mix' );
	if ( options[ 'sky-mask-deg' ] !== undefined && ! options.own ) usage( '--sky-mask-deg goes with --own' );
	if ( options[ 'sky-bands' ] !== undefined && options.own ) usage( '--sky-bands goes with the classes page\'s sort, not --own' );
	const maskDeg = Number( options[ 'sky-mask-deg' ] ?? 0 );
	if ( ! ( maskDeg >= 0 ) ) usage( `bad --sky-mask-deg ${ options[ 'sky-mask-deg' ] }` );
	if ( positional.length !== 1 ) usage( 'measure needs <dir>' );
	const skyBands = options[ 'sky-bands' ] ? options[ 'sky-bands' ].split( ',' ).map( Number ) : [];
	if ( skyBands.some( ( e ) => ! Number.isFinite( e ) ) || skyBands.some( ( e, k ) => k && e <= skyBands[ k - 1 ] ) || skyBands.length === 1 ) usage( '--sky-bands: rising elevations in degrees, at least two' );
	const bandRows = new Set( skyBands.slice( 1 ).map( ( b, k ) => skyBandRow( skyBands[ k ], b ) ) );
	const dir = positional[ 0 ], sortDir = options.sort ?? dir;
	const boxes = options.boxes ? JSON.parse( readFileSync( options.boxes, 'utf8' ) ) : {};
	const normal = path.join( dir, 'normal' );
	if ( ! existsSync( normal ) ) throw new Error( `no ${ normal }: run capture first` );
	const shot = readdirSync( normal ).filter( ( f ) => f.endsWith( '.png' ) && ! f.endsWith( '.repeat.png' ) ).map( ( f ) => f.slice( 0, - 4 ) ).sort();
	const names = options.views ? options.views.split( ',' ) : shot;
	for ( const name of names ) if ( ! shot.includes( name ) ) throw new Error( `no view ${ name } in ${ normal }` );
	const sorts = new Map(), views = {};
	for ( const view of names ) {

		const base = options.own ? view : existsSync( path.join( sortDir, 'classes', `${ view }.json` ) ) ? view : view.split( '--' )[ 0 ];
		const read = pageValue( dir, 'normal', view ), pixels = framePixels( dir, view ), colours = cellColours( pixels );
		if ( ! options.own && ! sorts.has( base ) ) sorts.set( base, sortOf( sortDir, base, skyBands ) );
		const sort = options.own ? ownSortOf( read, maskDeg ) : sorts.get( base );
		const light = ! options.own && existsSync( path.join( dir, 'light', `${ view }.json` ) ) ? pageValue( dir, 'light', view ).opaque : null;
		const scene = read.opaque && read.hdr ? { opaque: read.opaque, hdr: read.hdr } : null;
		const out = {};
		for ( const row of Object.keys( sort.cells ).sort() ) {

			const few = bandRows.has( row ) && sort.cells[ row ].length < SKY_BAND_CELLS;
			out[ row ] = few ? { ...cellsRow( colours, [], light, scene ), n: sort.cells[ row ].length, note: 'too few cells' } : cellsRow( colours, sort.cells[ row ], light, scene );

		}
		// the darkest of this frame's own land, whichever cells those are now
		const dark = sort.land.map( ( c ) => [ luminance( colours[ c * 3 ], colours[ c * 3 + 1 ], colours[ c * 3 + 2 ] ), c ] ).sort( ( a, b ) => a[ 0 ] - b[ 0 ] );
		if ( dark.length ) {

			const edge = rank( Float64Array.from( dark, ( e ) => e[ 0 ] ), 0.05 );
			out.floor = cellsRow( colours, dark.filter( ( e ) => e[ 0 ] <= edge ).map( ( e ) => e[ 1 ] ), light, scene );

		}
		const own = Object.entries( boxes[ base ] ?? {} ).map( ( [ name, box ] ) => [ name, boxRow( pixels, box ) ] );
		views[ view ] = { sort: base, ev: read.exposure.ev, exposure: read.exposure.exposure, elevation: read.elevation, key: read.key, p95: sort.p95 === null ? null : round( sort.p95 ), shares: sort.shares, ...( options.own ? { skyMasked: sort.masked } : {} ), note: read.note,
			...( read.E === undefined ? {} : { E: Number( read.E.toPrecision( 4 ) ), preExposure: read.preExposure } ), rows: out, ...( own.length ? { boxes: Object.fromEntries( own ) } : {} ) };

	}
	const result = { grid: [ NX, NY ], cell: CELL, sort: options.own ? 'own' : sortDir, ...( options.own ? { skyMaskDeg: maskDeg } : {} ), views };
	writeFileSync( options.out ?? path.join( dir, 'rows.json' ), JSON.stringify( result, null, '\t' ) );
	if ( options.json ) {

		console.log( JSON.stringify( result ) );
		return 0;

	}
	const line = ( name, r ) => `  ${ name.padEnd( 16 ) } ${ String( r.n ).padStart( 6 ) }  ${ r.L === null ? ( r.note ?? '-' ) : `${ r.L.toFixed( 2 ) } ${ r.C.toFixed( 3 ) } ${ r.h.toFixed( 0 ).padStart( 3 ) }` }${ r.card == null ? '' : `  card ${ r.card.toPrecision( 3 ) }` }${ r.scene?.Y == null ? '' : `  scene ${ r.scene.Y.toPrecision( 3 ) } (median ${ r.scene.med.toPrecision( 3 ) }, hdr ${ r.scene.hdr.toPrecision( 3 ) })` }`;
	for ( const [ view, v ] of Object.entries( views ) ) {

		const E = v.E === undefined ? '' : `  E ${ v.E.toPrecision( 4 ) }`;
		if ( v.shares ) {

			const { sun, shade, penumbra } = v.shares;
			console.log( `${ view }  EV ${ v.ev.toFixed( 2 ) }  sun ${ v.elevation.toFixed( 1 ) } deg  (sort ${ v.sort }, p95 ${ v.p95.toFixed( 2 ) }; land in sun ${ sun.toFixed( 2 ) }, shade ${ shade.toFixed( 2 ) }, penumbra ${ penumbra.toFixed( 2 ) })${ E }` );

		} else console.log( `${ view }  EV ${ v.ev.toFixed( 2 ) }  sun ${ v.elevation.toFixed( 1 ) } deg  (own sort)${ E }` );
		for ( const [ name, r ] of Object.entries( v.rows ) ) console.log( line( name, r ) );
		for ( const [ name, b ] of Object.entries( v.boxes ?? {} ) ) {

			console.log( `${ line( `box ${ name }`, b ) }  p5 ${ b.p5.toFixed( 2 ) } p90 ${ b.p90.toFixed( 2 ) }` );
			for ( const part of [ 'mean', 'dark', 'lit' ] ) if ( b[ part ] ) console.log( line( `  ${ part }`, b[ part ] ) );

		}

	}
	return 0;

}

const [ command, ...rest ] = process.argv.slice( 2 );
if ( command !== 'capture' && command !== 'measure' ) usage( `no command ${ command ?? '' }` );
try {

	process.exit( command === 'capture' ? await capture( rest ) : measure( rest ) );

} catch ( error ) {

	console.error( `region-colours: ${ error.message }` );
	process.exit( 1 );

}
