// The meadow's light, cover and colour, measured on its leaf pixels: how bright the sunlit blades
// are against bare ground in the same sun, how many of them are lit, how dark the shaded ones are,
// how much of the lawn the blades cover, and the colour of the lit lawn on screen.
//
//   node tools/meadow-light.mjs [url] [--elev 50,20] [--azimuth 135] [--view name=tilt,dist,fov]...
//       [--target x,z] [--views-file f.json [--views a,b]] [--side afternoon] [--weather clear] [--flags a,b] [--q extra] [--expect lo,hi]
//       [--w 1920 --h 1080 --scale 2] [--timeout 60000] [--out dir] [--pages a,b|none] [--save dir] [--reuse dir]
//
// url: the server (default http://127.0.0.1:5190/, the dev server; a production preview needs the
// debug build's `debug` in the query, which every page here carries).
//
// Views. Each sun elevation (`--elev`, degrees, the afternoon's hour that gives it, or the morning's
// with `--side morning`: packages/render/sky/DayCycle.ts)
// is shot from each view: `name=tilt,dist,fov` is a camera `dist` m from the lawn point `--target`
// (x, z; its height the camera's ground), looking down `tilt` degrees, with a vertical field of view
// of `fov` degrees, its heading turned from the direction toward the sun by each `--azimuth`
// (degrees: 180 the sun straight behind, 135 behind and to the side, the framing the look is judged
// in; 90 side-on; 0 against the light). The view `island` is the island camera's own (the query's
// default orbit, every azimuth alike). Default: `--view game=50,24,50 --azimuth 135`. The views keep
// the sun where it stands relative to the camera, so elevations compare like for like.
// `--views-file` adds the views of a file in capture-set's form (name -> { q, eval }; names starting
// with `_` skipped), all of them or those `--views` lists, each at every elevation: its `q` joins the
// query and its eval runs as capture-set runs it (tools/parity/views.mjs's helpers). Without `--view`
// the file's views are the only ones.
//
// Pages. Every view is shot on seven pages, each a fresh load of its flags (they are read at load),
// the views reached in it by the exact scene jump and a camera move, each read once the page's
// `settled` signal holds, from the resolved opaque colour at the render's size (the frame graph's
// `opaque` radiance source: linear, before the sea, the haze and the post chain):
//   mask    `grassMask:exact`: the blades unlit in a red far over any radiance, so each pixel's
//           cover is exact in the scene's four samples (packages/island/world/Grass.ts); full cover is all four,
//           with neither green nor blue. Everything but the land and the blades is hidden (the
//           bamboo, the yunpeng, the islanders, the sea), so this page's cover and depth are the
//           meadow's own behind whatever stands in front of it
//   albedo  `grassMask:albedo,albedoOnly`: every lit surface unlit in its own diffuse colour, the
//           albedo the lighting takes (the blades' darkening toward the roots included), the turf's
//           between them too (packages/render/debug/LightLayer.ts)
//   light   `lightOnly`: every lit albedo 0.5 grey (packages/render/debug/LightLayer.ts), the light alone
//   bare    `lightOnly,bareGround`: the blades hidden, the turf lit as bare ground, same pixels
//   ambient `lightOnly,bareGround,ambientOnly`: the bare ground without the sun, so each pixel's
//           share of direct light sorts sun from shade
//   normal  no flag: the frame as drawn (its radiance for the colours, and the canvas for the screen)
//   matte   `lightOnly:2`: the light page without the specular, so the light page less this one is
//           each pixel's specular radiance (it does not depend on the albedo); optional: a run
//           reused without it leaves the specular's measures out
//   lean    `grassMask:lean`, hidden as the mask: each leaf's lean from upright, as drawn and by its
//           pose alone (packages/island/world/Grass.ts); shot only when `--pages` names it, for the `lean`
//           measure (the leaves' lean over the lawn they cover whole, LEAN: weighted by the pixels
//           each leaf covers, as the view shows them)
// All the pages draw the same blades (the test mode's paused frame is a function of the query and the
// camera), so their pixels line up.
// A change that moves only some pages need not shoot the rest: `--save dir` writes each page read
// (its frame, depth, camera and, for `normal`, the canvas) to dir, and `--reuse dir` reads every page
// `--pages` leaves out from such a run, of the same views and size (`--pages none`: all of them, no
// browser, to run changed measures on a saved run). The blades' shading (their
// normals, colour of light, the cast they read) moves `light`, `normal` and `matte` only: `bare` and `ambient`
// draw no blades and no cast of theirs, `mask` and `albedo` no light. Their geometry, albedo or the
// turf move the others.
//
// The sort. Lawn: pixels within a hundredth of the frame's width of blades covering at least 2 % of
// them (the mask page's: behind an occluder too). Open lawn: the lawn where the mask and light pages'
// depths agree (within 2 cm), so nothing hidden on the mask page stands in front of it; every
// measure but the cover reads the open lawn only. Leaf: fully covered pixels only (a partly covered
// pixel mixes the blade with the ground behind it). Sun and shade, by the bare ground's share of
// direct light d = 1 - ambient / bare at the pixel: sunlit where d is at least 0.7 of the open lawn's
// 95th percentile of d, shaded at most 0.2 of it (cast shade: the bamboo's, the land's), the
// penumbra left out.
//
// The measures (each view; Y is luminance, Rec. 709 linear):
//   litBare        the median Y of the bare ground at the sunlit leaf pixels
//   bright, dark   the medians of the two clusters the sunlit leaf pixels split into on log Y
//                  (Otsu's threshold); `litShare` the share in the bright one, `litDark` bright / dark
//   mean           the mean Y of the sunlit leaf pixels
//   brightToBare, meanToBare   bright / litBare, mean / litBare
//   shadedGrass, shadedBare, shadedRatio   the mean Y of the shaded leaf pixels, of the bare ground
//                  at the same pixels, and the first over the second
//   groundToLeaf   the mean Y of the sunlit turf the blades leave bare (cover 0) over that of the
//                  sunlit leaf pixels: the light the ground under the sward takes
//   cover          the mean cover over the lawn, over a box at the frame's centre (a fifth of each
//                  side), and over the lawn per band of view depth (m)
//   leafAlbedo     the blades' albedo over the open leaf pixels, sunlit or not (the albedo page): Y,
//                  R/G, B/G of the mean, `warmShare`, the share of those pixels with R/G over 0.95,
//                  and `rgSpread`, the 10th and 90th percentiles of the pixels' R/G (how far the
//                  blades' colours spread)
//   groundAlbedo   the turf's albedo over the open lawn the blades leave bare (cover 0) where they
//                  cover at least a quarter of the lawn's box around it (the ground under the sward,
//                  not the coast's lip or a gap beyond it), sunlit or not (the albedo page): Y, R/G,
//                  B/G of the mean
//   specular       over the sunlit leaf pixels (with the matte page), the specular's share of their
//                  radiance in green and in blue (`g`, `b`), and `glint`, the share of those pixels
//                  whose specular is at least what their diffuse returns
//   leaf, ground   the colour of the sunlit leaf pixels and of the sunlit bare turf in the normal
//                  page's radiance (`radiance`: R/G, B/G) and their albedo (normal over light, times
//                  the grey's 0.5: `albedo` Y, R/G, B/G; diffuse light only, so a rough estimate)
//   screen         the Oklab of the mean colour of the sunlit lawn's pixels on the canvas (sRGB
//                  decoded, the box mean), over the lawn and per depth band; and the sunlit leaf
//                  pixels and the sunlit bare turf on the canvas as a close look reads them
//                  (`leaf`, `turf`): the median of their linear luminance (sRGB decoded), the R/G
//                  and B/G of their mean 8-bit codes and the standard deviation of their codes' luma
//                  (`sd`, the texture's swing within each); `fleck`, the same over the turf the
//                  blades leave in the sun (its light at least FLECK of the bare ground's there);
//                  the leaf's `bright`, the Oklab, R/G and B/G of the mean colour of its brightest
//                  third; `soil`, over the bare turf pixels redder than green (soil, not the
//                  green flecks on it): the Oklab, R/G and B/G of the mean colour of their
//                  brighter half and `relief`, their luminance's 90th over its 10th percentile; and
//                  `spread`, the sunlit lawn's linear luminance on the canvas at its 10th, 50th and
//                  90th percentiles and the outer two over the median (`low`, `high`: how deep the
//                  gaps between the blades go and how far the lit blades rise)
//   gaps           the share of the frame the open lawn takes where the blades leave it bare
//   keyToAmbient   the key's illuminance at normal incidence (the sun light's colour times its
//                  intensity, read on the page) over the ambient irradiance on the sunlit open lawn's
//                  bare ground, 2 pi times the ambient page's median luminance there (its grey 0.5),
//                  in scene units (each page's pre-exposure divided out). It guards the land's sky
//                  light against the key: `--expect lo,hi` exits 3 when a view's value falls outside.
//                  A view with no reading (no sunlit open ground, or pages saved before this
//                  reading) counts as outside. The ambient page holds the ambient's specular too, and
//                  the lawn's bare ground is not open level ground: at a clear 22 degree sun the
//                  default view reads about 0.65 of the key-to-ambient a white card on lit open
//                  ground reads at the same sun (another framing: the lit grass and ground in front
//                  of an eye-height camera). Its window: docs/reference/tools.md, Probes
// Under a sun so low or a view so shaded that a class is empty its measures are null. A placed view
// shot at several azimuths also gets, per elevation, the mean of its ratios, cover and screen colour
// over them (`means`, `<view>-e<elevation>-mean`), as one framing alone carries the sun's side of
// the camera with it.
//
// Outputs: `<out>/meadow-light.json` (every view's measures, the sun's actual elevation and the
// azimuth it stands at from the view), per view `<out>/<view>.png` (the normal page's canvas) and
// `<out>/<view>.sort.png` (the sort at the render's size: sunlit bright leaf yellow, sunlit dark
// leaf green, shaded leaf blue, lawn behind an occluder purple, partly covered grey by its cover,
// sunlit turf tan, shaded turf brown), and a table on stdout. `--out` defaults to artifacts/meadow-light/<UTC stamp>/.
// Exit codes: 0 measured, 1 a page or view failed, 3 a key:ambient outside `--expect` or missing (all
// measured).
//
// The GPU lock is held shared (the readings do not depend on what else renders) and offered back
// between pages (leaseGpuLock), never across the CPU work of the measures, which runs after the
// browser is closed.
import './qos.mjs'; // first: the measures run here, over every pixel of seven frames per view
import { acquireGpuLock, leaseGpuLock, releaseGpuLock } from './gpu-lock.mjs';
import { launchCapture, waitForScene, pngShooter, stopLoop, startLoop, decodePng } from './capture-browser.mjs';
import { VIEWS, viewEval } from './parity/views.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { NOON_ELEVATION, morningHour, eveningHour } from '../packages/render/sky/DayCycle.ts';

const usage = 'usage: node tools/meadow-light.mjs [url] [--elev 50,20] [--azimuth 135] [--view name=tilt,dist,fov]... [--target x,z] [--views-file f [--views a,b]] [--side afternoon|morning] [--weather clear] [--expect lo,hi] [--flags a,b] [--q extra] [--w --h --scale] [--timeout ms] [--out dir] [--pages a,b|none] [--save dir] [--reuse dir] (see the file header)';
const argv = process.argv.slice( 2 );
const options = { expect: '', elev: '50,20', azimuth: '135', target: '-13.76,0.8', side: 'afternoon', weather: 'clear', flags: '', q: '', w: '1920', h: '1080', scale: '2', timeout: '60000', out: '',
	'views-file': '', views: '', pages: '', save: '', reuse: '' };
const viewSpecs = [];
let url = 'http://127.0.0.1:5190/';
for ( let i = 0; i < argv.length; i ++ ) {

	const a = argv[ i ];
	if ( ! a.startsWith( '--' ) ) { url = a; continue; }
	const k = a.slice( 2 ), v = argv[ ++ i ];
	if ( v === undefined ) { console.error( `--${ k } needs a value\n${ usage }` ); process.exit( 2 ); }
	if ( k === 'view' ) viewSpecs.push( v );
	else if ( k in options ) options[ k ] = v;
	else { console.error( `unknown option --${ k }\n${ usage }` ); process.exit( 2 ); }

}
if ( ! url.endsWith( '/' ) && ! url.includes( '?' ) ) url += '/';
// the views of a views file (capture-set's form: name -> { q, eval }), all or those --views names
const fileViews = [];
if ( options[ 'views-file' ] ) {

	const data = JSON.parse( readFileSync( options[ 'views-file' ], 'utf8' ) );
	const names = options.views ? options.views.split( ',' ).filter( ( n ) => n !== '' ) : Object.keys( data ).filter( ( n ) => ! n.startsWith( '_' ) );
	for ( const name of names ) {

		if ( ! data[ name ] ) { console.error( `--views: ${ name } is not in ${ options[ 'views-file' ] }` ); process.exit( 2 ); }
		VIEWS[ name ] = { q: data[ name ].q ?? '', eval: data[ name ].eval ?? '', crops: [] };
		fileViews.push( { name, q: data[ name ].q ?? '', js: viewEval( name, [] ) } );

	}

}
if ( viewSpecs.length === 0 && fileViews.length === 0 ) viewSpecs.push( 'game=50,24,50' );
const numbers = ( text ) => text.split( ',' ).filter( ( s ) => s !== '' ).map( Number );
const elevations = numbers( options.elev ), azimuths = numbers( options.azimuth ), target = numbers( options.target );
const timeout = Number( options.timeout );
const frames = viewSpecs.map( ( spec ) => {

	const [ name, values ] = spec.split( '=' );
	if ( name === 'island' && values === undefined ) return { name, island: true };
	const [ tilt, dist, fov ] = numbers( values ?? '' );
	if ( ! [ tilt, dist, fov ].every( Number.isFinite ) ) { console.error( `--view ${ spec }: name=tilt,dist,fov or island\n${ usage }` ); process.exit( 2 ); }
	return { name, tilt, dist, fov };

} );
if ( ! elevations.length || ! elevations.every( ( e ) => e > 0 && e < NOON_ELEVATION ) ) { console.error( `--elev: degrees above 0 and below ${ NOON_ELEVATION } (the noon sun)` ); process.exit( 2 ); }
if ( target.length !== 2 || ! target.every( Number.isFinite ) ) { console.error( '--target x,z' ); process.exit( 2 ); }
if ( options.side !== 'afternoon' && options.side !== 'morning' ) { console.error( '--side afternoon or morning' ); process.exit( 2 ); }
const expect = options.expect ? numbers( options.expect ) : null;
if ( expect && ! ( expect.length === 2 && expect.every( Number.isFinite ) && expect[ 0 ] < expect[ 1 ] ) ) { console.error( '--expect lo,hi' ); process.exit( 2 ); }

// The afternoon's (or the morning's) hour whose sun stands `elevation` degrees up (packages/render/sky/DayCycle.ts)
const hourFor = ( elevation ) => options.side === 'morning' ? morningHour( elevation ) : eveningHour( elevation );

const repo = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const stamp = new Date().toISOString().replace( /[:.]/g, '-' ).slice( 0, 19 );
const out = path.resolve( options.out || path.join( repo, 'artifacts', 'meadow-light', stamp ) );
mkdirSync( out, { recursive: true } );

const PAGES = [
	{ name: 'mask', flags: [ 'grassMask:exact' ], hide: true, depth: true },
	{ name: 'albedo', flags: [ 'grassMask:albedo', 'albedoOnly' ] },
	{ name: 'light', flags: [ 'lightOnly' ], depth: true },
	{ name: 'bare', flags: [ 'lightOnly', 'bareGround' ] },
	{ name: 'ambient', flags: [ 'lightOnly', 'bareGround', 'ambientOnly' ] },
	{ name: 'normal', flags: [] },
	{ name: 'matte', flags: [ 'lightOnly:2' ], optional: true },
	{ name: 'lean', flags: [ 'grassMask:lean' ], hide: true, optional: true, extra: true },
];
// the pages shot (`--pages`); the rest are read from `--reuse`'s run
// (`none`: every page read from it, so a changed measure runs on a saved run without the browser)
const shoot = options.pages === 'none' ? [] : options.pages ? options.pages.split( ',' ).filter( ( s ) => s !== '' ) : PAGES.filter( ( p ) => ! p.extra ).map( ( p ) => p.name );
if ( ! shoot.every( ( n ) => PAGES.some( ( p ) => p.name === n ) ) ) { console.error( `--pages: of ${ PAGES.map( ( p ) => p.name ).join( ', ' ) }` ); process.exit( 2 ); }
if ( PAGES.some( ( p ) => ! p.optional && ! shoot.includes( p.name ) ) && ! options.reuse ) { console.error( '--pages without every page needs --reuse dir' ); process.exit( 2 ); }
const reuse = options.reuse ? path.resolve( options.reuse ) : null, save = options.save ? path.resolve( options.save ) : null;
if ( save ) mkdirSync( save, { recursive: true } );
const extraFlags = options.flags.split( ',' ).filter( ( s ) => s !== '' );
const queryFor = ( page, view ) => {

	const flags = [ ...page.flags, ...extraFlags ];
	return [ 'debug', 'paused', 't=12', `weather=${ options.weather }`, `hour=${ view.hour.toFixed( 4 ) }`, ...( flags.length ? [ `flags=${ flags.join( ',' ) }` ] : [] ),
		...( options.q ? [ options.q ] : [] ), ...( view.file?.q ? [ view.file.q ] : [] ) ].join( '&' );

};
const views = [];
for ( const elevation of elevations ) {

	for ( const frame of frames ) for ( const azimuth of frame.island ? [ null ] : azimuths ) {

		views.push( { name: `${ frame.name }-e${ elevation }${ azimuth === null ? '' : `-a${ azimuth }` }`, elevation, hour: hourFor( elevation ), frame, azimuth } );

	}
	for ( const file of fileViews ) views.push( { name: `${ file.name }-e${ elevation }`, elevation, hour: hourFor( elevation ), frame: null, azimuth: null, file } );

}

// ---------------------------------------------------------------- in the page

// Places the camera (`view`'s frame and azimuth, the sun's direction now; the island view and a views
// file's view stand where the query and the view's eval put them) and reports the sun.
function placeCamera( { frame, azimuth, target } ) {

	const s = window.__PONLAI__;
	const sun = s.sky.sunDir;
	const sl = Math.hypot( sun.x, sun.z );
	if ( ! frame || frame.island ) return { sunElevation: Math.asin( sun.y ) * 180 / Math.PI };
	// the heading: the direction toward the sun on the ground, turned by the azimuth
	const a = azimuth * Math.PI / 180, hx = sun.x / sl, hz = sun.z / sl;
	const vx = hx * Math.cos( a ) - hz * Math.sin( a ), vz = hx * Math.sin( a ) + hz * Math.cos( a );
	const t = Math.PI / 180 * frame.tilt;
	const ty = s.controls.ground.heightAt( target[ 0 ], target[ 1 ] );
	s.setCameraView?.( 'island' );
	s.setCameraMode( 'free' );
	s.camera.position.set( target[ 0 ] - vx * frame.dist * Math.cos( t ), ty + frame.dist * Math.sin( t ), target[ 1 ] - vz * frame.dist * Math.cos( t ) );
	s.camera.lookAt( target[ 0 ], ty, target[ 1 ] );
	s.camera.fov = frame.fov;
	s.camera.updateProjectionMatrix();
	return { sunElevation: Math.asin( sun.y ) * 180 / Math.PI, targetHeight: ty };

}

// Hides what is neither the land nor the meadow's blades (the bamboo, the yunpeng, the islanders, the
// sea and the sky), so the mask page's cover and depth are the meadow's own where something stands
// in front of it.
function hideOccluders() {

	const s = window.__PONLAI__;
	const keep = ( o ) => o.name.startsWith( 'island' ) || o.name.startsWith( 'grass' ) || o.name === 'rocks' || o.name === 'seabed';
	let hidden = 0;
	s.scene.traverse( ( o ) => {

		if ( ( o.isMesh || o.isPoints || o.isLine || o.isSprite ) && o.visible && ! keep( o ) ) { o.visible = false; hidden ++; }

	} );
	return hidden;

}

// The resolved opaque colour (RGB, half floats or floats) and, with `depth`, the view depth of the
// opaque pass's first sample in centimetres (16 bits), read back at the render's size, as base64.
async function readFrame( { depth } ) {

	const s = window.__PONLAI__;
	const b64 = ( array ) => new Promise( ( resolve, reject ) => {

		const reader = new FileReader();
		reader.onload = () => resolve( reader.result.slice( reader.result.indexOf( ',' ) + 1 ) );
		reader.onerror = () => reject( reader.error );
		reader.readAsDataURL( new Blob( [ array.buffer ] ) );

	} );
	const { target, index } = s.pipeline.radianceSource( 'opaque' );
	const w = target.width, h = target.height;
	const raw = await s.renderer.readRenderTargetPixelsAsync( target, 0, 0, w, h, index );
	const half = raw instanceof Uint16Array;
	// rows come back padded to 256 bytes (three's copyTextureToBuffer)
	const bytes = half ? 2 : 4, stride = Math.ceil( w * 4 * bytes / 256 ) * 256 / bytes;
	const rgb = half ? new Uint16Array( w * h * 3 ) : new Float32Array( w * h * 3 );
	for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) {

		const i = y * stride + x * 4, o = ( y * w + x ) * 3;
		rgb[ o ] = raw[ i ]; rgb[ o + 1 ] = raw[ i + 1 ]; rgb[ o + 2 ] = raw[ i + 2 ];

	}
	// the pre-exposure the frame was drawn at (stops: its colours are scene units times 2^stops) and
	// the key's illuminance at normal incidence (the sun light's colour times its intensity, luminance)
	const c = s.sun.color;
	const result = { w, h, half, rgb: await b64( rgb ), stops: window.__THREE_GAME_DIAGNOSTICS__.preExposure.stops,
		key: ( 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b ) * s.sun.intensity };
	if ( depth ) {

		const rt = s.pipeline.depthRT;
		const z = await s.renderer.readRenderTargetPixelsAsync( rt, 0, 0, rt.width, rt.height, 0 );
		const zs = Math.ceil( rt.width * 2 * 4 / 256 ) * 256 / 4;
		const dm = new Uint16Array( w * h );
		for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) dm[ y * w + x ] = Math.min( 65535, Math.round( Math.abs( z[ y * zs + x * 2 ] ) * 100 ) );
		result.depth = await b64( dm );

	}
	return result;

}

// ---------------------------------------------------------------- the pages

const HALF = new Float32Array( 65536 );
for ( let i = 0; i < 65536; i ++ ) {

	const sign = i >> 15 ? - 1 : 1, e = ( i >> 10 ) & 31, m = i & 1023;
	HALF[ i ] = sign * ( e === 0 ? m / 1024 * 2 ** - 14 : e === 31 ? ( m ? NaN : Infinity ) : ( 1 + m / 1024 ) * 2 ** ( e - 15 ) );

}
// A read as it came (its buffers kept as they are, half floats at half the size), and decoded only
// when its view is measured, so many views' pages fit in memory
const packFrame = ( r ) => ( { w: r.w, h: r.h, half: r.half, stops: r.stops, key: r.key, rgb: Buffer.from( r.rgb, 'base64' ), depth: r.depth ? Buffer.from( r.depth, 'base64' ) : null } );
const decodeFrame = ( r ) => {

	const buffer = r.rgb;
	let rgb;
	if ( r.half ) {

		const u = new Uint16Array( buffer.buffer, buffer.byteOffset, buffer.byteLength / 2 );
		rgb = new Float32Array( u.length );
		for ( let i = 0; i < u.length; i ++ ) rgb[ i ] = HALF[ u[ i ] ];

	} else rgb = new Float32Array( buffer.buffer.slice( buffer.byteOffset, buffer.byteOffset + buffer.byteLength ) );
	const frame = { w: r.w, h: r.h, stops: r.stops, key: r.key, rgb };
	if ( r.depth ) {

		const d = r.depth;
		frame.depth = new Uint16Array( d.buffer.slice( d.byteOffset, d.byteOffset + d.byteLength ) );

	}
	return frame;

};

// a page's read on disk (`--save`, `--reuse`): its header, frame and depth as they came, the canvas
const savePage = ( view, page, read, placed, png ) => {

	const base = path.join( save, `${ view }.${ page }` );
	writeFileSync( `${ base }.json`, JSON.stringify( { w: read.w, h: read.h, half: read.half, stops: read.stops, key: read.key, depth: !! read.depth, placed, png: !! png } ) );
	writeFileSync( `${ base }.rgb`, read.rgb );
	if ( read.depth ) writeFileSync( `${ base }.depth`, read.depth );
	if ( png ) writeFileSync( `${ base }.png`, png );

};
const loadPage = ( view, page ) => {

	const base = path.join( reuse, `${ view }.${ page }` );
	const head = JSON.parse( readFileSync( `${ base }.json`, 'utf8' ) );
	const read = { w: head.w, h: head.h, half: head.half, stops: head.stops, key: head.key, rgb: readFileSync( `${ base }.rgb` ), depth: head.depth ? readFileSync( `${ base }.depth` ) : null };
	return { read, placed: head.placed, png: head.png ? readFileSync( `${ base }.png` ) : null };

};

const shots = new Map( views.map( ( v ) => [ v.name, {} ] ) );
const label = 'meadow-light';
let failed = false;
const errors = [];
if ( shoot.length ) {

	await acquireGpuLock( label, { shared: true } );
	const capture = await launchCapture( { viewport: { width: Number( options.w ), height: Number( options.h ) }, deviceScaleFactor: Number( options.scale ), url } );
	const { page } = capture;
	page.on( 'pageerror', ( e ) => errors.push( e.message ) );
	try {

		for ( const p of PAGES.filter( ( p ) => shoot.includes( p.name ) ) ) {

			await leaseGpuLock( label, { shared: true, budget: 0 } );
			let current = null; // the query the page holds
			for ( const view of views ) {

				try {

					const q = queryFor( p, view );
					if ( current === null ) {

						await page.goto( `${ url }?${ q }` );
						await page.waitForFunction( () => window.__PONLAI__ && window.__THREE_GAME_DIAGNOSTICS__, null, { timeout } );
						await waitForScene( page, { frames: 1, timeout } );

					} else if ( current !== q || ! view.frame || view.frame.island ) {

						// a new query, or a view that starts from the query's own camera: the exact scene jump
						// (app/Scene.ts establishScene, as capture.mjs's worker makes it), which places it as a load
						const jumped = await page.evaluate( async ( q ) => {

							const s = window.__PONLAI__;
							await s.establishScene( q );
							s.loop.start();
							return s.renderer.info.frame;

						}, q );
						await page.waitForFunction( ( f ) => window.__PONLAI__.renderer.info.frame > f, jumped, { timeout, polling: 'raf' } );

					}
					current = q;
					// a views file's view runs its eval as capture-set does (tools/parity/views.mjs's helpers)
					if ( view.file ) await page.evaluate( view.file.js );
					const placed = await page.evaluate( placeCamera, { frame: view.frame, azimuth: view.azimuth, target } );
					if ( p.hide ) await page.evaluate( hideOccluders );
					// a frame at the new camera, then the page's own readiness
					const from = await page.evaluate( () => window.__PONLAI__.renderer.info.frame );
					await page.waitForFunction( ( f ) => window.__PONLAI__.renderer.info.frame > f + 1, from, { timeout, polling: 'raf' } );
					await page.waitForFunction( () => window.__THREE_GAME_DIAGNOSTICS__?.settled === true, null, { timeout, polling: 'raf' } );
					const read = packFrame( await page.evaluate( readFrame, { depth: !! p.depth } ) );
					const shot = shots.get( view.name );
					shot[ p.name ] = read;
					if ( p.name === 'normal' || ! shot.placed ) shot.placed = placed;
					if ( p.name === 'normal' ) {

						await stopLoop( page );
						const shooter = await pngShooter( page, { timeout } );
						const png = await shooter.shoot();
						await shooter.close();
						await startLoop( page );
						writeFileSync( path.join( out, `${ view.name }.png` ), png );
						shot.png = png;

					}
					if ( save ) savePage( view.name, p.name, read, placed, p.name === 'normal' ? shot.png : null );
					console.log( `[meadow-light] ${ p.name } ${ view.name } read (${ read.w }x${ read.h })` );

				} catch ( error ) {

					console.error( `[meadow-light] ${ p.name } ${ view.name } failed: ${ error.message.split( '\n' )[ 0 ] }` );
					failed = true;
					current = null;

				}

			}

		}

	} finally {

		await capture.close().catch( () => {} );
		releaseGpuLock();

	}

}

// ---------------------------------------------------------------- the measures

const lum = ( c, i ) => 0.2126 * c[ i ] + 0.7152 * c[ i + 1 ] + 0.0722 * c[ i + 2 ];
const round = ( x, digits = 4 ) => x === null || ! Number.isFinite( x ) ? null : Number( x.toPrecision( digits ) );
const median = ( values ) => {

	if ( ! values.length ) return null;
	const a = Float64Array.from( values ).sort();
	return a.length % 2 ? a[ ( a.length - 1 ) / 2 ] : ( a[ a.length / 2 - 1 ] + a[ a.length / 2 ] ) / 2;

};
const mean = ( values ) => values.length ? values.reduce( ( s, v ) => s + v, 0 ) / values.length : null;
const quantile = ( values, q ) => {

	if ( ! values.length ) return null;
	const a = Float64Array.from( values ).sort();
	return a[ Math.min( a.length - 1, Math.floor( q * a.length ) ) ];

};
// Otsu's threshold on log values: the split of the histogram that maximises the variance between
// the two clusters
function otsu( values ) {

	const logs = values.filter( ( v ) => v > 0 ).map( Math.log );
	if ( logs.length < 2 ) return null;
	const lo = quantile( logs, 0.001 ), hi = quantile( logs, 0.999 );
	if ( ! ( hi > lo ) ) return null;
	const bins = 512, hist = new Float64Array( bins );
	for ( const v of logs ) hist[ Math.max( 0, Math.min( bins - 1, Math.floor( ( v - lo ) / ( hi - lo ) * bins ) ) ) ] ++;
	let total = 0, sum = 0;
	for ( let i = 0; i < bins; i ++ ) { total += hist[ i ]; sum += i * hist[ i ]; }
	let w0 = 0, s0 = 0, best = - 1, at = 0;
	for ( let i = 0; i < bins - 1; i ++ ) {

		w0 += hist[ i ]; s0 += i * hist[ i ];
		const w1 = total - w0;
		if ( w0 === 0 || w1 === 0 ) continue;
		const m0 = s0 / w0, m1 = ( sum - s0 ) / w1, between = w0 * w1 * ( m0 - m1 ) ** 2;
		if ( between > best ) { best = between; at = i; }

	}
	return Math.exp( lo + ( at + 1 ) / bins * ( hi - lo ) );

}
// Oklab of a linear Rec. 709 colour (Ottosson's matrices, as packages/render/debug/Radiance.ts)
function oklab( r, g, b ) {

	const l = Math.cbrt( 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b );
	const m = Math.cbrt( 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b );
	const s = Math.cbrt( 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b );
	const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
	const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
	const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
	return { L: round( L ), C: round( Math.hypot( A, B ) ), h: round( ( Math.atan2( B, A ) * 180 / Math.PI + 360 ) % 360 ) };

}
const SRGB = new Float64Array( 256 ).map( ( _, i ) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ( ( c + 0.055 ) / 1.055 ) ** 2.4; } );
const BANDS = [ [ 0, 10 ], [ 10, 20 ], [ 20, 40 ], [ 40, 80 ], [ 80, 190 ] ];

const MASK = 256; // packages/island/world/Grass.ts MASK_EXACT
// the depth (cm) the mask and light pages may differ by at an open pixel: both draw the same blades,
// so 93 to 97 % of the leaf pixels agree exactly; a looser match (2 % and 5 cm) let through what
// stands among the blades (the meadow's flowers, hidden on the mask page), 2.5 to 7 % of them
const SEEN = 2;
// the blades' cover around a pixel (the lawn's box) from which its bare ground is the sward's own:
// the lawn's edge takes in the coast's lip and the gaps' soil beyond the blades, a sixth to a third
// of its bare pixels on the island's views
const SWARD = 0.25;
// the share of the bare ground's light (the bare page) a turf pixel keeps under the blades (the light
// page) from which it counts as a fleck of sun: in a blade's shade it keeps the ambient's share alone
const FLECK = 0.8;
function measure( shot ) {

	const [ mask, albedo, light, bare, ambient, normal ] = [ 'mask', 'albedo', 'light', 'bare', 'ambient', 'normal' ].map( ( name ) => decodeFrame( shot[ name ] ) );
	const matte = shot.matte ? decodeFrame( shot.matte ) : null;
	const canvas = shot.png ? decodePng( shot.png ) : null;
	const w = mask.w, h = mask.h, n = w * h;
	for ( const f of [ albedo, light, bare, ambient, normal, matte ].filter( Boolean ) ) if ( f.w !== w || f.h !== h ) throw new Error( 'the pages read different sizes' );
	// cover in the scene's four samples (the resolve averages them: what the land behind adds is far
	// below a sample's share of the mask's red), full cover, and the pixels where nothing hidden on the
	// mask page stands in front of the meadow (the two pages' depths agree)
	const cover = new Float32Array( n ), full = new Uint8Array( n ), seen = new Uint8Array( n );
	for ( let p = 0; p < n; p ++ ) {

		const i = p * 3, R = mask.rgb[ i ], G = mask.rgb[ i + 1 ], B = mask.rgb[ i + 2 ];
		cover[ p ] = Math.max( 0, Math.min( 4, Math.round( R / ( MASK / 4 ) ) ) ) / 4;
		full[ p ] = cover[ p ] === 1 && G === 0 && B === 0 ? 1 : 0;
		seen[ p ] = Math.abs( light.depth[ p ] - mask.depth[ p ] ) <= SEEN ? 1 : 0;

	}
	// lawn: blades covering at least 2 % within a hundredth of the width (a summed-area table), and the
	// open lawn, the part of it nothing stands in front of
	const r = Math.max( 1, Math.round( w / 100 ) );
	const sat = new Float64Array( ( w + 1 ) * ( h + 1 ) );
	for ( let y = 0; y < h; y ++ ) {

		let row = 0;
		for ( let x = 0; x < w; x ++ ) { row += cover[ y * w + x ]; sat[ ( y + 1 ) * ( w + 1 ) + x + 1 ] = sat[ y * ( w + 1 ) + x + 1 ] + row; }

	}
	const lawn = new Uint8Array( n ), open = new Uint8Array( n ), around = new Float32Array( n );
	for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) {

		const x0 = Math.max( 0, x - r ), x1 = Math.min( w, x + r + 1 ), y0 = Math.max( 0, y - r ), y1 = Math.min( h, y + r + 1 );
		const s = sat[ y1 * ( w + 1 ) + x1 ] - sat[ y0 * ( w + 1 ) + x1 ] - sat[ y1 * ( w + 1 ) + x0 ] + sat[ y0 * ( w + 1 ) + x0 ];
		const p = y * w + x;
		around[ p ] = s / ( ( x1 - x0 ) * ( y1 - y0 ) );
		lawn[ p ] = around[ p ] >= 0.02 ? 1 : 0;
		open[ p ] = lawn[ p ] & seen[ p ];

	}
	// the bare ground's share of direct light, and the sort into sun and shade
	const direct = new Float32Array( n ).fill( NaN );
	const lawnDirect = [];
	for ( let p = 0; p < n; p ++ ) {

		const yb = lum( bare.rgb, p * 3 ), ya = lum( ambient.rgb, p * 3 );
		if ( yb > 0 ) direct[ p ] = 1 - ya / yb;
		if ( open[ p ] && Number.isFinite( direct[ p ] ) ) lawnDirect.push( direct[ p ] );

	}
	const top = quantile( lawnDirect, 0.95 ) ?? 0;
	const sun = new Uint8Array( n ); // 1 sunlit, 2 shaded
	for ( let p = 0; p < n; p ++ ) if ( open[ p ] && Number.isFinite( direct[ p ] ) && top > 0 ) sun[ p ] = direct[ p ] >= 0.7 * top ? 1 : direct[ p ] <= 0.2 * top ? 2 : 0;
	// the key against the ambient light on the sunlit open ground: the key's illuminance at normal
	// incidence over the ambient irradiance there, 2 pi times the ambient page's median luminance
	// (its grey 0.5 returns E / 2 pi), in scene units (the page's pre-exposure divided out)
	const litAmbient = [];
	for ( let p = 0; p < n; p ++ ) if ( sun[ p ] === 1 ) litAmbient.push( lum( ambient.rgb, p * 3 ) );
	const ambientLit = median( litAmbient );
	const keyToAmbient = ambientLit > 0 && ambient.key > 0 && Number.isFinite( ambient.stops ) ? ambient.key / ( 2 * Math.PI * ambientLit * 2 ** - ambient.stops ) : null;
	// the leaf pixels' light
	const litLeaf = [], litLeafBare = [], shadeLeaf = [], shadeLeafBare = [], litTurf = [];
	const leafRad = [ 0, 0, 0 ], leafLight = [ 0, 0, 0 ], turfRad = [ 0, 0, 0 ], turfLight = [ 0, 0, 0 ];
	// the sunlit leaf pixels' specular radiance (light less matte) and the pixels where it is at least
	// what the leaf's diffuse returns
	const leafSpec = [ 0, 0, 0 ];
	let glints = 0;
	for ( let p = 0; p < n; p ++ ) {

		const i = p * 3;
		if ( full[ p ] && sun[ p ] === 1 ) {

			litLeaf.push( lum( light.rgb, i ) ); litLeafBare.push( lum( bare.rgb, i ) );
			for ( let k = 0; k < 3; k ++ ) { leafRad[ k ] += normal.rgb[ i + k ]; leafLight[ k ] += light.rgb[ i + k ]; }
			if ( matte ) {

				for ( let k = 0; k < 3; k ++ ) leafSpec[ k ] += Math.max( 0, light.rgb[ i + k ] - matte.rgb[ i + k ] );
				const spec = Math.max( 0, lum( light.rgb, i ) - lum( matte.rgb, i ) );
				if ( spec >= lum( normal.rgb, i ) - spec ) glints ++;

			}

		} else if ( full[ p ] && sun[ p ] === 2 ) {

			shadeLeaf.push( lum( light.rgb, i ) ); shadeLeafBare.push( lum( bare.rgb, i ) );

		} else if ( cover[ p ] === 0 && sun[ p ] === 1 ) {

			litTurf.push( lum( light.rgb, i ) );
			for ( let k = 0; k < 3; k ++ ) { turfRad[ k ] += normal.rgb[ i + k ]; turfLight[ k ] += light.rgb[ i + k ]; }

		}

	}
	// the blades' albedo (the albedo page), over every open leaf pixel, sunlit or not
	// and the turf's, over the open lawn they leave bare inside the sward
	const leafAlbedo = [ 0, 0, 0 ], leafRG = [], groundAlbedo = [ 0, 0, 0 ];
	let albedoPx = 0, warm = 0, groundPx = 0;
	for ( let p = 0; p < n; p ++ ) {

		if ( ! open[ p ] ) continue;
		const i = p * 3, a = albedo.rgb;
		if ( full[ p ] ) {

			for ( let k = 0; k < 3; k ++ ) leafAlbedo[ k ] += a[ i + k ];
			if ( a[ i ] > 0.95 * a[ i + 1 ] ) warm ++;
			if ( a[ i + 1 ] > 0 ) leafRG.push( a[ i ] / a[ i + 1 ] );
			albedoPx ++;

		} else if ( cover[ p ] === 0 && around[ p ] >= SWARD ) {

			for ( let k = 0; k < 3; k ++ ) groundAlbedo[ k ] += a[ i + k ];
			groundPx ++;

		}

	}
	const meanAlbedo = ( sum, px ) => px ? {
		Y: round( ( 0.2126 * sum[ 0 ] + 0.7152 * sum[ 1 ] + 0.0722 * sum[ 2 ] ) / px ),
		rg: round( sum[ 0 ] / sum[ 1 ] ), bg: round( sum[ 2 ] / sum[ 1 ] ),
	} : null;
	const split = otsu( litLeaf );
	const brightSet = split === null ? [] : litLeaf.filter( ( v ) => v >= split ), darkSet = split === null ? [] : litLeaf.filter( ( v ) => v < split );
	const litBare = median( litLeafBare ), bright = median( brightSet ), dark = median( darkSet ), leafMean = mean( litLeaf );
	const shadedGrass = mean( shadeLeaf ), shadedBare = mean( shadeLeafBare );
	const colour = ( rad, lit ) => {

		if ( ! ( rad[ 1 ] > 0 && lit[ 1 ] > 0 ) ) return null;
		const albedo = [ 0, 1, 2 ].map( ( k ) => rad[ k ] / lit[ k ] * 0.5 );
		return {
			radiance: { rg: round( rad[ 0 ] / rad[ 1 ] ), bg: round( rad[ 2 ] / rad[ 1 ] ) },
			albedo: { Y: round( 0.2126 * albedo[ 0 ] + 0.7152 * albedo[ 1 ] + 0.0722 * albedo[ 2 ] ), rg: round( albedo[ 0 ] / albedo[ 1 ] ), bg: round( albedo[ 2 ] / albedo[ 1 ] ) },
		};

	};
	// cover: the lawn, the centre box, the depth bands
	let lawnCover = 0, lawnPx = 0, boxCover = 0, boxPx = 0;
	const bandCover = BANDS.map( () => [ 0, 0 ] );
	for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) {

		const p = y * w + x;
		if ( x >= 0.4 * w && x < 0.6 * w && y >= 0.4 * h && y < 0.6 * h ) { boxCover += cover[ p ]; boxPx ++; }
		if ( ! lawn[ p ] ) continue;
		lawnCover += cover[ p ]; lawnPx ++;
		const z = mask.depth[ p ] / 100;
		const b = BANDS.findIndex( ( [ lo, hi ] ) => z >= lo && z < hi );
		if ( b >= 0 ) { bandCover[ b ][ 0 ] += cover[ p ]; bandCover[ b ][ 1 ] ++; }

	}
	// the screen: the canvas's sunlit lawn pixels (each canvas pixel sorted by the render pixel under it)
	const screen = { all: null, bands: {}, leaf: null, turf: null, fleck: null, spread: null, soil: null };
	if ( canvas ) {

		const c = canvas, sums = [ [ 0, 0, 0, 0 ], ...BANDS.map( () => [ 0, 0, 0, 0 ] ) ];
		// per class: the linear luminances, the codes' sums and their luma's sum and square
		const classes = Object.fromEntries( [ 'leaf', 'turf', 'fleck' ].map( ( name ) => [ name, { Y: [], codes: [ 0, 0, 0 ], luma: [ 0, 0 ] } ] ) );
		const lawnY = [], leafRGB = [], soilY = [], soilRGB = [];
		for ( let y = 0; y < c.height; y ++ ) for ( let x = 0; x < c.width; x ++ ) {

			const p = Math.floor( y * h / c.height ) * w + Math.floor( x * w / c.width );
			if ( sun[ p ] !== 1 ) continue;
			const o = ( y * c.width + x ) * 3, z = mask.depth[ p ] / 100;
			lawnY.push( 0.2126 * SRGB[ c.data[ o ] ] + 0.7152 * SRGB[ c.data[ o + 1 ] ] + 0.0722 * SRGB[ c.data[ o + 2 ] ] );
			if ( full[ p ] ) leafRGB.push( SRGB[ c.data[ o ] ], SRGB[ c.data[ o + 1 ] ], SRGB[ c.data[ o + 2 ] ] );
			else if ( cover[ p ] === 0 && c.data[ o ] > c.data[ o + 1 ] ) {

				soilY.push( 0.2126 * SRGB[ c.data[ o ] ] + 0.7152 * SRGB[ c.data[ o + 1 ] ] + 0.0722 * SRGB[ c.data[ o + 2 ] ] );
				soilRGB.push( SRGB[ c.data[ o ] ], SRGB[ c.data[ o + 1 ] ], SRGB[ c.data[ o + 2 ] ] );

			}
			const ks = full[ p ] ? [ classes.leaf ] : cover[ p ] === 0 ? lum( light.rgb, p * 3 ) >= FLECK * lum( bare.rgb, p * 3 ) ? [ classes.turf, classes.fleck ] : [ classes.turf ] : [];
			for ( const k of ks ) {

				const R = c.data[ o ], G = c.data[ o + 1 ], B = c.data[ o + 2 ], code = 0.2126 * R + 0.7152 * G + 0.0722 * B;
				k.Y.push( 0.2126 * SRGB[ R ] + 0.7152 * SRGB[ G ] + 0.0722 * SRGB[ B ] );
				k.codes[ 0 ] += R; k.codes[ 1 ] += G; k.codes[ 2 ] += B; k.luma[ 0 ] += code; k.luma[ 1 ] += code * code;

			}
			const b = BANDS.findIndex( ( [ lo, hi ] ) => z >= lo && z < hi );
			for ( const s of b >= 0 ? [ sums[ 0 ], sums[ b + 1 ] ] : [ sums[ 0 ] ] ) {

				s[ 0 ] += SRGB[ c.data[ o ] ]; s[ 1 ] += SRGB[ c.data[ o + 1 ] ]; s[ 2 ] += SRGB[ c.data[ o + 2 ] ]; s[ 3 ] ++;

			}

		}
		const lab = ( s ) => s[ 3 ] ? { ...oklab( s[ 0 ] / s[ 3 ], s[ 1 ] / s[ 3 ], s[ 2 ] / s[ 3 ] ), px: s[ 3 ] } : null;
		// the mean colour of the pixels at or above the luminance quantile `q`: Oklab, R/G and B/G
		const upper = ( Y, rgb, q ) => {

			const cut = quantile( Y, q ), sum = [ 0, 0, 0, 0 ];
			Y.forEach( ( y, i ) => { if ( y >= cut ) { sum[ 0 ] += rgb[ i * 3 ]; sum[ 1 ] += rgb[ i * 3 + 1 ]; sum[ 2 ] += rgb[ i * 3 + 2 ]; sum[ 3 ] ++; } } );
			return sum[ 1 ] > 0 ? { ...lab( sum ), rg: round( sum[ 0 ] / sum[ 1 ] ), bg: round( sum[ 2 ] / sum[ 1 ] ) } : null;

		};
		screen.all = lab( sums[ 0 ] );
		BANDS.forEach( ( [ lo, hi ], b ) => { if ( sums[ b + 1 ][ 3 ] ) screen.bands[ `${ lo }-${ hi }` ] = lab( sums[ b + 1 ] ); } );
		for ( const name of [ 'leaf', 'turf', 'fleck' ] ) {

			const k = classes[ name ], px = k.Y.length;
			if ( ! px || ! k.codes[ 1 ] ) continue;
			const m = k.luma[ 0 ] / px;
			screen[ name ] = { Y: round( median( k.Y ) ), rg: round( k.codes[ 0 ] / k.codes[ 1 ] ), bg: round( k.codes[ 2 ] / k.codes[ 1 ] ), sd: round( Math.sqrt( Math.max( 0, k.luma[ 1 ] / px - m * m ) ) ), px };

		}
		if ( screen.leaf ) {

			// the brightest third of the sunlit leaf pixels, by luminance
			screen.leaf.bright = upper( classes.leaf.Y, leafRGB, 2 / 3 );

		}
		if ( soilY.length ) {

			const [ p10, p90 ] = [ 0.1, 0.9 ].map( ( q ) => quantile( soilY, q ) );
			screen.soil = { ...upper( soilY, soilRGB, 1 / 2 ), relief: p10 > 0 ? round( p90 / p10 ) : null };

		}
		if ( lawnY.length ) {

			const [ p10, p50, p90 ] = [ 0.1, 0.5, 0.9 ].map( ( q ) => quantile( lawnY, q ) );
			screen.spread = { p10: round( p10 ), p50: round( p50 ), p90: round( p90 ), low: p50 ? round( p10 / p50 ) : null, high: p50 ? round( p90 / p50 ) : null };

		}

	}
	// the sort's image
	const sort = new Uint8Array( n * 3 );
	for ( let p = 0; p < n; p ++ ) {

		let col = [ 0, 0, 0 ];
		if ( full[ p ] && sun[ p ] === 1 ) col = split !== null && lum( light.rgb, p * 3 ) >= split ? [ 255, 220, 40 ] : [ 40, 120, 30 ];
		else if ( full[ p ] && sun[ p ] === 2 ) col = [ 40, 80, 230 ];
		else if ( lawn[ p ] && ! seen[ p ] ) col = [ 120, 40, 120 ];
		else if ( cover[ p ] > 0 ) col = [ 1, 1, 1 ].map( () => Math.round( 60 + 140 * cover[ p ] ) );
		else if ( lawn[ p ] && sun[ p ] === 1 ) col = [ 200, 170, 120 ];
		else if ( lawn[ p ] && sun[ p ] === 2 ) col = [ 90, 60, 40 ];
		sort.set( col, p * 3 );

	}
	return {
		measures: {
			pixels: { lawn: lawnPx, open: open.reduce( ( a, v ) => a + v, 0 ), litLeaf: litLeaf.length, shadeLeaf: shadeLeaf.length, litTurf: litTurf.length, albedoLeaf: albedoPx, albedoGround: groundPx, directP95: round( top ) },
			litBare: round( litBare ), bright: round( bright ), dark: round( dark ), mean: round( leafMean ),
			litShare: litLeaf.length && split !== null ? round( brightSet.length / litLeaf.length ) : null,
			litDark: bright !== null && dark ? round( bright / dark ) : null,
			brightToBare: bright !== null && litBare ? round( bright / litBare ) : null,
			meanToBare: leafMean !== null && litBare ? round( leafMean / litBare ) : null,
			shadedGrass: round( shadedGrass ), shadedBare: round( shadedBare ),
			shadedRatio: shadedGrass !== null && shadedBare ? round( shadedGrass / shadedBare ) : null,
			groundToLeaf: litTurf.length && leafMean ? round( mean( litTurf ) / leafMean ) : null,
			gaps: round( open.reduce( ( a, v, p ) => a + ( v && cover[ p ] === 0 ? 1 : 0 ), 0 ) / n ),
			keyToAmbient: round( keyToAmbient ),
			cover: {
				lawn: lawnPx ? round( lawnCover / lawnPx ) : null, centre: boxPx ? round( boxCover / boxPx ) : null,
				bands: Object.fromEntries( BANDS.map( ( [ lo, hi ], b ) => [ `${ lo }-${ hi }`, bandCover[ b ][ 1 ] ? round( bandCover[ b ][ 0 ] / bandCover[ b ][ 1 ] ) : null ] ).filter( ( [ , v ] ) => v !== null ) ),
			},
			leafAlbedo: albedoPx ? {
				...meanAlbedo( leafAlbedo, albedoPx ), warmShare: round( warm / albedoPx ),
				rgSpread: [ round( quantile( leafRG, 0.1 ) ), round( quantile( leafRG, 0.9 ) ) ],
			} : null,
			groundAlbedo: meanAlbedo( groundAlbedo, groundPx ),
			leaf: colour( leafRad, leafLight ), ground: colour( turfRad, turfLight ), screen,
			specular: matte && litLeaf.length && leafRad[ 1 ] > 0 ? { g: round( leafSpec[ 1 ] / leafRad[ 1 ] ), b: round( leafSpec[ 2 ] / leafRad[ 2 ] ), glint: round( glints / litLeaf.length ) } : null,
			lean: shot.lean ? leanOf( decodeFrame( shot.lean ), lawn ) : null,
		},
		sort: { width: w, height: h, data: sort },
	};

}

// the leaves' lean on the lean page, over the lawn's pixels the blades cover whole: as drawn (green)
// and by the pose's tilt alone (blue), degrees from upright, at the 10th, 50th and 90th percentiles,
// with the shares under LEAN[ 0 ] (near upright) and over LEAN[ 1 ] (lying down)
const LEAN = [ 15, 60 ];
function leanOf( frame, lawn ) {

	const drawn = [], pose = [];
	for ( let p = 0; p < lawn.length; p ++ ) {

		const i = p * 3;
		if ( lawn[ p ] && frame.rgb[ i ] >= MASK - 0.5 ) { drawn.push( frame.rgb[ i + 1 ] ); pose.push( frame.rgb[ i + 2 ] ); }

	}
	const stats = ( v ) => ( {
		p10: round( quantile( v, 0.1 ) ), p50: round( quantile( v, 0.5 ) ), p90: round( quantile( v, 0.9 ) ),
		upright: round( v.filter( ( x ) => x < LEAN[ 0 ] ).length / v.length ), flat: round( v.filter( ( x ) => x > LEAN[ 1 ] ).length / v.length ),
	} );
	return drawn.length ? { drawn: stats( drawn ), pose: stats( pose ), px: drawn.length } : null;

}

// a PNG of 8-bit RGB (no filter, one IDAT)
function encodePng( { width, height, data } ) {

	const chunk = ( type, body ) => {

		const head = Buffer.alloc( 8 ), tail = Buffer.alloc( 4 );
		head.writeUInt32BE( body.length, 0 ); head.write( type, 4, 'latin1' );
		tail.writeUInt32BE( zlib.crc32( Buffer.concat( [ Buffer.from( type, 'latin1' ), body ] ) ), 0 );
		return Buffer.concat( [ head, body, tail ] );

	};
	const ihdr = Buffer.alloc( 13 );
	ihdr.writeUInt32BE( width, 0 ); ihdr.writeUInt32BE( height, 4 ); ihdr[ 8 ] = 8; ihdr[ 9 ] = 2;
	const raw = Buffer.alloc( ( width * 3 + 1 ) * height );
	for ( let y = 0; y < height; y ++ ) Buffer.from( data.buffer, data.byteOffset + y * width * 3, width * 3 ).copy( raw, y * ( width * 3 + 1 ) + 1 );
	return Buffer.concat( [ Buffer.from( [ 137, 80, 78, 71, 13, 10, 26, 10 ] ), chunk( 'IHDR', ihdr ), chunk( 'IDAT', zlib.deflateSync( raw, { level: 3 } ) ), chunk( 'IEND', Buffer.alloc( 0 ) ) ] );

}

const results = [];
for ( const view of views ) {

	const shot = shots.get( view.name );
	// the pages left out of this run, from `--reuse`'s
	for ( const p of PAGES ) {

		if ( shoot.includes( p.name ) ) continue;
		try {

			const { read, placed, png } = loadPage( view.name, p.name );
			const w = shot[ shoot[ 0 ] ]?.w ?? read.w, h = shot[ shoot[ 0 ] ]?.h ?? read.h;
			if ( read.w !== w || read.h !== h ) throw new Error( `${ read.w }x${ read.h }, not ${ w }x${ h }` );
			shot[ p.name ] = read;
			if ( ! shot.placed ) shot.placed = placed;
			if ( png ) { shot.png = png; writeFileSync( path.join( out, `${ view.name }.png` ), png ); }

		} catch ( error ) {

			if ( p.optional ) continue;
			console.error( `[meadow-light] ${ p.name } ${ view.name } not reused: ${ error.message.split( '\n' )[ 0 ] }` );
			failed = true;

		}

	}
	const entry = { view: view.name, elevation: view.elevation, hour: round( view.hour, 6 ), frame: view.frame ?? view.file.name, azimuth: view.azimuth, sunElevation: round( shot.placed?.sunElevation ?? NaN ) };
	if ( PAGES.some( ( p ) => ! p.optional && ! shot[ p.name ] ) ) {

		entry.error = 'a page failed';
		results.push( entry );
		continue;

	}
	const { measures, sort } = measure( shot );
	shots.delete( view.name );
	writeFileSync( path.join( out, `${ view.name }.sort.png` ), encodePng( sort ) );
	results.push( { ...entry, ...measures } );

}
// the mean over the azimuths of each placed view at each elevation (`<view>-e<elevation>-mean`): a
// look judged in one framing alone takes the sun's side of the camera with it
const MEAN_KEYS = [ 'brightToBare', 'meanToBare', 'litShare', 'litDark', 'shadedRatio', 'groundToLeaf' ];
const means = [];
for ( const elevation of elevations ) for ( const frame of frames ) {

	const rows = results.filter( ( r ) => ! r.error && r.elevation === elevation && r.frame === frame && r.azimuth !== null );
	if ( rows.length < 2 ) continue;
	const avg = ( get ) => {

		const values = rows.map( get ).filter( ( v ) => v !== null && v !== undefined );
		return values.length === rows.length ? round( mean( values ) ) : null;

	};
	const entry = { view: `${ frame.name }-e${ elevation }-mean`, elevation, azimuths: rows.map( ( r ) => r.azimuth ), sunElevation: avg( ( r ) => r.sunElevation ) };
	for ( const k of MEAN_KEYS ) entry[ k ] = avg( ( r ) => r[ k ] );
	entry.cover = { lawn: avg( ( r ) => r.cover.lawn ), centre: avg( ( r ) => r.cover.centre ) };
	entry.screen = { all: rows.every( ( r ) => r.screen.all ) ? { L: avg( ( r ) => r.screen.all.L ), C: avg( ( r ) => r.screen.all.C ), h: avg( ( r ) => r.screen.all.h ) } : null };
	means.push( entry );

}
writeFileSync( path.join( out, 'meadow-light.json' ), JSON.stringify( { url, options, views: results, means, errors }, null, 2 ) );

// the table
const f = ( x, d = 3 ) => x === null || x === undefined ? '-' : Number( x ).toFixed( d );
console.log( `\n${ 'view'.padEnd( 20 ) } ${ 'sun'.padStart( 5 ) } ${ 'br:bare'.padStart( 8 ) } ${ 'mean:bare'.padStart( 9 ) } ${ 'litShr'.padStart( 7 ) } ${ 'lit:dark'.padStart( 8 ) } ${ 'shade g:b'.padStart( 9 ) } ${ 'gnd:leaf'.padStart( 8 ) } ${ 'cover'.padStart( 6 ) } ${ 'centre'.padStart( 6 ) }  ${ 'albedo Y R/G B/G warm'.padEnd( 26 ) }  ${ 'R/G p10 p90'.padEnd( 11 ) }  ${ 'turf Y R/G B/G'.padEnd( 17 ) }  screen L C h` );
for ( const r of [ ...results, ...means ] ) {

	if ( r.error ) { console.log( `${ r.view.padEnd( 20 ) } ${ r.error }` ); continue; }
	const s = r.screen.all, a = r.leafAlbedo, g = r.groundAlbedo;
	console.log( `${ r.view.padEnd( 20 ) } ${ f( r.sunElevation, 1 ).padStart( 5 ) } ${ f( r.brightToBare ).padStart( 8 ) } ${ f( r.meanToBare ).padStart( 9 ) } ${ f( r.litShare ).padStart( 7 ) } ${ f( r.litDark, 2 ).padStart( 8 ) } ${ f( r.shadedRatio, 2 ).padStart( 9 ) } ${ f( r.groundToLeaf ).padStart( 8 ) } ${ f( r.cover.lawn ).padStart( 6 ) } ${ f( r.cover.centre ).padStart( 6 ) }  ${ ( a ? `${ f( a.Y ) } ${ f( a.rg ) } ${ f( a.bg ) } ${ f( a.warmShare ) }` : '-' ).padEnd( 26 ) }  ${ ( a?.rgSpread ? `${ f( a.rgSpread[ 0 ], 2 ) } ${ f( a.rgSpread[ 1 ], 2 ) }` : '-' ).padEnd( 11 ) }  ${ ( g ? `${ f( g.Y ) } ${ f( g.rg ) } ${ f( g.bg ) }` : '-' ).padEnd( 17 ) }  ${ s ? `${ f( s.L ) } ${ f( s.C ) } ${ f( s.h, 1 ) }` : '-' }` );

}
// the close look on screen: the sunlit leaf and bare turf on the canvas
console.log( `\n${ 'view'.padEnd( 20 ) } ${ 'leaf Y'.padStart( 7 ) } ${ 'turf Y'.padStart( 7 ) } ${ 'turf:leaf'.padStart( 9 ) } ${ 'fleck:leaf'.padStart( 10 ) }  ${ 'leaf R/G B/G sd'.padEnd( 18 ) }  ${ 'turf R/G B/G sd'.padEnd( 18 ) }  ${ 'fleck R/G B/G sd'.padEnd( 18 ) }  ${ 'gaps'.padStart( 5 ) }  ${ 'p10:p50 p90:p50'.padEnd( 15 ) }  ${ 'bright leaf L C h'.padEnd( 19 ) }  lin R/G B/G  spec G B glint` );
for ( const r of results ) {

	if ( r.error ) continue;
	const l = r.screen.leaf, t = r.screen.turf, k = r.screen.fleck;
	const cls = ( k ) => ( k ? `${ f( k.rg ) } ${ f( k.bg ) } ${ f( k.sd, 1 ) }` : '-' ).padEnd( 18 );
	const sp = r.screen.spread, b = l?.bright;
	console.log( `${ r.view.padEnd( 20 ) } ${ f( l?.Y, 4 ).padStart( 7 ) } ${ f( t?.Y, 4 ).padStart( 7 ) } ${ f( l && t ? t.Y / l.Y : null ).padStart( 9 ) } ${ f( l && k ? k.Y / l.Y : null ).padStart( 10 ) }  ${ cls( l ) }  ${ cls( t ) }  ${ cls( k ) }  ${ f( r.gaps ).padStart( 5 ) }  ${ ( sp ? `${ f( sp.low ) } ${ f( sp.high ) }` : '-' ).padEnd( 15 ) }  ${ ( b ? `${ f( b.L ) } ${ f( b.C ) } ${ f( b.h, 1 ) }` : '-' ).padEnd( 19 ) }  ${ r.leaf ? `${ f( r.leaf.radiance.rg ) } ${ f( r.leaf.radiance.bg ) }` : '-' }  ${ r.specular ? `${ f( r.specular.g ) } ${ f( r.specular.b ) } ${ f( r.specular.glint ) }` : '-' }` );

}
// the leaves' lean, as drawn and by the pose alone (with the lean page)
if ( results.some( ( r ) => r.lean ) ) {

	console.log( `\n${ 'view'.padEnd( 20 ) } ${ 'drawn p10 p50 p90 <15 >60'.padEnd( 30 ) } ${ 'pose p10 p50 p90 <15 >60'.padEnd( 30 ) } px` );
	const c = ( k ) => `${ f( k.p10, 1 ) } ${ f( k.p50, 1 ) } ${ f( k.p90, 1 ) } ${ f( k.upright, 2 ) } ${ f( k.flat, 2 ) }`.padEnd( 30 );
	for ( const r of results ) if ( r.lean ) console.log( `${ r.view.padEnd( 20 ) } ${ c( r.lean.drawn ) } ${ c( r.lean.pose ) } ${ r.lean.px }` );

}
// the soil against the lit leaves, in the canvas's linear colour
console.log( `\n${ 'view'.padEnd( 20 ) } ${ 'soil R/G B/G L C h'.padEnd( 32 ) } ${ 'leaf R/G B/G L C h'.padEnd( 32 ) } ${ 'R/G÷ B/G÷ C÷ dh'.padEnd( 24 ) } relief` );
for ( const r of results ) {

	if ( r.error ) continue;
	const o = r.screen.soil, l = r.screen.leaf?.bright;
	const c = ( k ) => ( k ? `${ f( k.rg ) } ${ f( k.bg ) } ${ f( k.L ) } ${ f( k.C ) } ${ f( k.h, 1 ) }` : '-' ).padEnd( 32 );
	console.log( `${ r.view.padEnd( 20 ) } ${ c( o ) } ${ c( l ) } ${ ( o && l ? `${ f( o.rg / l.rg ) } ${ f( o.bg / l.bg ) } ${ f( o.C / l.C ) } ${ f( l.h - o.h, 1 ) }` : '-' ).padEnd( 24 ) } ${ f( o?.relief, 2 ) }` );

}
// the key against the ambient light on the sunlit open ground, and its window (`--expect`)
console.log( `\n${ 'view'.padEnd( 20 ) } ${ 'key:ambient'.padStart( 11 ) }${ expect ? `  window ${ expect[ 0 ] }-${ expect[ 1 ] }` : '' }` );
let outside = false;
for ( const r of results ) {

	if ( r.error ) continue;
	const k = r.keyToAmbient, fails = expect !== null && ! ( k !== null && k >= expect[ 0 ] && k <= expect[ 1 ] );
	if ( fails ) outside = true;
	console.log( `${ r.view.padEnd( 20 ) } ${ f( k, 2 ).padStart( 11 ) }${ fails ? '  OUTSIDE' : '' }` );

}
console.log( `\n${ path.relative( repo, out ) }/meadow-light.json` );
if ( failed || errors.length ) {

	if ( errors.length ) console.error( `page errors:\n  ${ errors.join( '\n  ' ) }` );
	process.exitCode = 1;

} else if ( outside ) process.exitCode = 3;
