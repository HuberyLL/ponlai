// Colour rows: what the frame shows, as final-pixel Oklab L, C and h per kind of surface and per kind
// of light, over a set of views. It answers "what colour is the sunlit rock, the shaded grass, the
// sky in this view, before and after a change", where a hand-placed box mixes sun and shade.
//
//   node tools/colour-rows.mjs shoot <url> <dir> --views-file f.json [--pages normal,light,ambient,classes]
//       [--size 2560x1440@1] [--q "extra&query"] [--scene]
//   node tools/colour-rows.mjs rows <dir> [--sort <dir>] [--boxes f.json] [--views a,b] [--sky-bands 0,5,15,30]
//       [--out f.json] [--json]
//
// shoot takes the frames: one tools/parity/capture-set.mjs run per page below, on one warm page
// each, under the shared GPU lock, into `<dir>/<page>/`. The views file is capture-set's (a view's
// `eval` sets its variant up). Each view ends with this tool's read of the page (PAGE_READ).
// Paths are taken from the cwd the tool is called in, wherever that is; the runs start in the repo.
// rows is plain node over that output: no browser and no GPU. It prints what the frames hold and
// nothing else: it knows no ranges and judges nothing. Exit 0, or 1 when a page or a view is missing.
//
// The pages
//   normal    the frame itself: the PNG, the exposure, the depth's sky and sea shares
//   light     flags=lightOnly:2,grey:1: every lit surface a white card, specular off
//   ambient   the same with ambientOnly: the key light taken out
//   classes   flags=classes&aa=off: each cell's kind (src/debug/Classes.ts)
//
// The sort. The frame is cut into a grid of NX by NY cells, each read over the CELL by CELL pixels
// at its centre, the same pixels on every page (src/debug/RadianceAov.ts `forCellTexels`):
//   land      cells with no sky, no sea and a kind
//   d         a cell's direct share, 1 - ambient / light (luminance)
//   sun       land cells with d at or over 0.7 of the land's 95th percentile of d
//   shade     land cells with d at or under 0.2 of it (the penumbra between is in neither)
//   sky, sea  cells more than 0.99 sky or sea
// A variant is read through the sort of its base view, so a row is the same cells before and after
// a change, whatever the change does to the light. A view `<base>--<variant>` takes the sort of
// `<base>` in the --sort directory (default <dir>), or its own name if that holds it. A variant's
// frames therefore need only the normal page (`shoot --pages normal`).
//
// The rows (rows.json, `views.<view>.rows`), each { n, L, C, h, rgb, card }: `<kind> sun`, `<kind>
// shade` and `<kind>` over all its cells for each kind that shows; `land sun` and `land shade`, the
// union of the kinds' sun and shade cells; `land`, `sky`, `sea`; `floor`, the darkest 5 % of the
// frame's own land cells by luminance. rgb is the row's mean linear pixel and L, C, h are the Oklab
// of that mean, so a row's hue is the hue of its average colour, steady where single pixels are near
// neutral. card is the mean luminance of the same cells on the view's own light page (scene units:
// the light a white card takes there), so `land sun` over `land shade` reads the contrast of the
// light where the rows' rgb read it in the frame; null when the view has no light page. A row of
// fewer than MIN_CELLS cells keeps its n and has null values.
//
// The boxes (`--boxes`, `views.<view>.boxes`): { "<base view>": { "<name>": [ x, y, w, h ] } } in pixels
// of the PNG, each read over every pixel: L, C, h the medians of the pixels' values (as `img.py stats
// --oklab` gives them), p5 and p90 of L, `mean`, the row of all its pixels (the Oklab of their mean
// linear colour, which a box of mixed light reads quite otherwise than by its medians), and `dark`
// and `lit`, the row of the pixels under and over the box's median L (the two halves of a crown).
//
// The scene (shoot --scene): the normal page also reads the frame's own radiance in scene units on
// the same cells, before the display chain (src/debug/Radiance.ts: `opaque`, the lit surfaces and the
// sky before the sea and the air, and `hdr`, the composite with them), each cell's world normal
// (RadianceAov.ts `normal`), the camera's matrices and the sky's irradiance, so a ratio of the scene's
// light (lit grass over the sky, shade over sun, one weather over another) is read where the rows'
// rgb read the display. rows then adds to every row `scene` { Y, med, hdr }: the mean and the median
// of the cells' luminance in the opaque source and the mean in hdr; and the rows that need the
// cells' direction: `sky band`, the sky cells whose ray stands 4 to 15 degrees up and turns more than
// 90 degrees in azimuth from the key light's (the sun's, by night the moon's), `sea away`, the sea
// cells whose ray lies 0 to 5 degrees under the horizon on that side, and `<kind> flat`, `<kind> sun
// flat`, `land flat` and `land sun flat`, the cells whose normal stands within about 25 degrees of
// straight up (a flat open card's light, under a sky alone, is read against `E` below). A view
// read through another's sort takes these rows from the base's normals and camera. The view's
// record adds `E`, pi times the sky's irradiance (Sky.ts `skyIrradiance`, luminance), against which
// a flat open card's light is read, and `preExposure`, the frame's P in stops (post/PreExposure.ts).
//
// The sky's bands (rows --sky-bands e0,e1,...: frames shot with --scene): a row `sky <a>-<b>` per pair
// of neighbouring edges, the sky cells whose ray stands at least a and under b degrees up (half open,
// [a, b)) and turns more than 90 degrees in azimuth from the key light's, as `sky band` takes them;
// each cell's elevation is its centre's ray through the camera's matrices as the scene page read
// them, between frames: unjittered (the temporal modes jitter the scene passes' projection only, and
// MSAA has no jitter). A band of fewer than SKY_BAND_CELLS cells keeps its n and has null values,
// with `note: 'too few cells'`. These are not `sky band` (4 to 15 degrees), which stays as it is.
//
// Each view's record also holds `ev` and `exposure` (the frame's, src/post/Exposure.ts), the key
// light's `key` { colour, dir }, the sun's `elevation` (degrees), the land's `p95` of d, `shares`
// { sun, shade, penumbra }, the land cells' shares in the sort's sun, shade and neither, and `note`,
// whatever the view's eval left in `__PONLAI__.colourNote` (a script reads tune.set's report that way).
//
// Output: `<dir>/rows.json` (or --out) and a table on stdout, or the JSON with --json.
import './qos.mjs'; // first: the PNG decodes run with the application policy
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from './capture-browser.mjs';

const REPO = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const NX = 256, NY = 144, CELL = 3;
const MIN_CELLS = 8;
// the least cells a --sky-bands row is read over
const SKY_BAND_CELLS = 64;
const KINDS = [ 'sky', 'sea', 'ground', 'rock', 'grass', 'leaves', 'wood', 'figure', 'other' ]; // src/debug/Classes.ts
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
	const out = {
		exposure: await P.pipeline.readExposure(),
		depth: short( ( await P.radiance( { ...cells, aov: 'depth' } ) ).values ),
		key: { colour: [ r, g, b ], dir: P.sky.keyDir.toArray() },
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
	console.error( 'usage: colour-rows.mjs shoot <url> <dir> --views-file f.json [options] | rows <dir> [options] (see the file header)' );
	process.exit( 2 );

}

function parse( list, known ) {

	const positional = [], options = {};
	for ( let i = 0; i < list.length; i ++ ) {

		const a = list[ i ];
		if ( ! a.startsWith( '--' ) ) { positional.push( a ); continue; }
		const k = a.slice( 2 );
		if ( ! known.includes( k ) ) usage( `unknown option ${ a }` );
		if ( k === 'json' || k === 'scene' ) options[ k ] = true;
		else if ( list[ i + 1 ] === undefined ) usage( `${ a } needs a value` );
		else options[ k ] = list[ ++ i ];

	}
	return { positional, options };

}

function shoot( list ) {

	const { positional, options } = parse( list, [ 'views-file', 'pages', 'size', 'q', 'scene' ] );
	if ( positional.length !== 2 || ! options[ 'views-file' ] ) usage( 'shoot needs <url> <dir> --views-file f.json' );
	const url = positional[ 0 ], dir = path.resolve( positional[ 1 ] ), viewsFile = path.resolve( options[ 'views-file' ] );
	const pages = ( options.pages ?? Object.keys( PAGES ).join( ',' ) ).split( ',' );
	for ( const page of pages ) if ( PAGES[ page ] === undefined ) usage( `no page ${ page } (of ${ Object.keys( PAGES ).join( ', ' ) })` );
	for ( const page of pages ) {

		const q = [ PAGES[ page ], options.q ].filter( Boolean ).join( '&' );
		console.log( `colour-rows: page ${ page }` );
		const run = spawnSync( process.execPath, [ 'tools/gpu-lock.mjs', 'run', '--shared', '--',
			process.execPath, 'tools/parity/capture-set.mjs', url, path.join( dir, page ), '--size', options.size ?? '2560x1440@1', '--jobs', '1',
			'--views-file', viewsFile, ...( q ? [ '--q', q ] : [] ), '--', '--eval-ready', pageRead( options.scene === true ) ], { cwd: REPO, stdio: 'inherit' } );
		if ( run.status !== 0 ) {

			console.error( `colour-rows: page ${ page } failed` );
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

// the row of a mean linear colour
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
	if ( ! existsSync( file ) ) throw new Error( `no ${ file }: run shoot with --pages ${ page }` );
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

const skyBandRow = ( a, b ) => `sky ${ a }-${ b }`;

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
	// the rows that need each cell's direction (the scene's read: see the header)
	if ( skyBands.length && ! normal.camera ) throw new Error( `${ view }: --sky-bands needs frames shot with --scene` );
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

// a row over some cells of the frame, with its card from the light page's cells (`light`, or null)
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

// a box's numbers over every pixel (see the header)
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

function rows( list ) {

	const { positional, options } = parse( list, [ 'sort', 'boxes', 'views', 'out', 'json', 'sky-bands' ] );
	if ( positional.length !== 1 ) usage( 'rows needs <dir>' );
	const skyBands = options[ 'sky-bands' ] ? options[ 'sky-bands' ].split( ',' ).map( Number ) : [];
	if ( skyBands.some( ( e ) => ! Number.isFinite( e ) ) || skyBands.some( ( e, k ) => k && e <= skyBands[ k - 1 ] ) || skyBands.length === 1 ) usage( '--sky-bands: rising elevations in degrees, at least two' );
	const bandRows = new Set( skyBands.slice( 1 ).map( ( b, k ) => skyBandRow( skyBands[ k ], b ) ) );
	const dir = positional[ 0 ], sortDir = options.sort ?? dir;
	const boxes = options.boxes ? JSON.parse( readFileSync( options.boxes, 'utf8' ) ) : {};
	const normal = path.join( dir, 'normal' );
	if ( ! existsSync( normal ) ) throw new Error( `no ${ normal }: run shoot first` );
	const shot = readdirSync( normal ).filter( ( f ) => f.endsWith( '.png' ) && ! f.endsWith( '.repeat.png' ) ).map( ( f ) => f.slice( 0, - 4 ) ).sort();
	const names = options.views ? options.views.split( ',' ) : shot;
	for ( const name of names ) if ( ! shot.includes( name ) ) throw new Error( `no view ${ name } in ${ normal }` );
	const sorts = new Map(), views = {};
	for ( const view of names ) {

		const base = existsSync( path.join( sortDir, 'classes', `${ view }.json` ) ) ? view : view.split( '--' )[ 0 ];
		if ( ! sorts.has( base ) ) sorts.set( base, sortOf( sortDir, base, skyBands ) );
		const sort = sorts.get( base );
		const read = pageValue( dir, 'normal', view ), pixels = framePixels( dir, view ), colours = cellColours( pixels );
		const light = existsSync( path.join( dir, 'light', `${ view }.json` ) ) ? pageValue( dir, 'light', view ).opaque : null;
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
		views[ view ] = { sort: base, ev: read.exposure.ev, exposure: read.exposure.exposure, elevation: read.elevation, key: read.key, p95: round( sort.p95 ), shares: sort.shares, note: read.note,
			...( read.E === undefined ? {} : { E: Number( read.E.toPrecision( 4 ) ), preExposure: read.preExposure } ), rows: out, ...( own.length ? { boxes: Object.fromEntries( own ) } : {} ) };

	}
	const result = { grid: [ NX, NY ], cell: CELL, sort: sortDir, views };
	writeFileSync( options.out ?? path.join( dir, 'rows.json' ), JSON.stringify( result, null, '\t' ) );
	if ( options.json ) {

		console.log( JSON.stringify( result ) );
		return 0;

	}
	const line = ( name, r ) => `  ${ name.padEnd( 16 ) } ${ String( r.n ).padStart( 6 ) }  ${ r.L === null ? ( r.note ?? '-' ) : `${ r.L.toFixed( 2 ) } ${ r.C.toFixed( 3 ) } ${ r.h.toFixed( 0 ).padStart( 3 ) }` }${ r.card == null ? '' : `  card ${ r.card.toPrecision( 3 ) }` }${ r.scene?.Y == null ? '' : `  scene ${ r.scene.Y.toPrecision( 3 ) } (median ${ r.scene.med.toPrecision( 3 ) }, hdr ${ r.scene.hdr.toPrecision( 3 ) })` }`;
	for ( const [ view, v ] of Object.entries( views ) ) {

		const { sun, shade, penumbra } = v.shares;
		console.log( `${ view }  EV ${ v.ev.toFixed( 2 ) }  sun ${ v.elevation.toFixed( 1 ) } deg  (sort ${ v.sort }, p95 ${ v.p95.toFixed( 2 ) }; land in sun ${ sun.toFixed( 2 ) }, shade ${ shade.toFixed( 2 ) }, penumbra ${ penumbra.toFixed( 2 ) })${ v.E === undefined ? '' : `  E ${ v.E.toPrecision( 4 ) }` }` );
		for ( const [ name, r ] of Object.entries( v.rows ) ) console.log( line( name, r ) );
		for ( const [ name, b ] of Object.entries( v.boxes ?? {} ) ) {

			console.log( `${ line( `box ${ name }`, b ) }  p5 ${ b.p5.toFixed( 2 ) } p90 ${ b.p90.toFixed( 2 ) }` );
			for ( const part of [ 'mean', 'dark', 'lit' ] ) if ( b[ part ] ) console.log( line( `  ${ part }`, b[ part ] ) );

		}

	}
	return 0;

}

const [ command, ...rest ] = process.argv.slice( 2 );
if ( command !== 'shoot' && command !== 'rows' ) usage( `no command ${ command ?? '' }` );
try {

	process.exit( command === 'shoot' ? shoot( rest ) : rows( rest ) );

} catch ( error ) {

	console.error( `colour-rows: ${ error.message }` );
	process.exit( 1 );

}
