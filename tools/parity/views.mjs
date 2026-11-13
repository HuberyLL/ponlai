// The parity views: name -> { q, eval, crops, group, special }. Every view is a paused frame at a fixed t;
// `q` is added to the common query (capture-set.mjs), `eval` runs in the page once
// window.__PONLAI__ exists (before capture.mjs's settling wait). Placements derive from the
// island's bounds and height grid as the camera's ground holds them (`controls.ground`,
// IslandGround: made from the chunks' meshes in the workers, so the page's meshes and their
// vertices are never read and a build that simplifies the drawn meshes frames alike), the meadow's
// flowering plants and its tufts at the cliff's edge, the islander and the sun and moon, so they follow any land, as tools/profile-frame.mjs places its
// scenes.
//
// Groups: `parity` (the views every parity check runs; the default) and `taa` (6 close views for
// the temporal anti-aliasing work: thin and moving detail); `all` is both. `special` holds the
// parked weathers' views (`special: true`: the cloudy and overcast skies, the rain, the storm, the
// fog and the weather front into rain; packages/render/sky/Weather.ts PARKED_WEATHER): no other group lists them, so every default set is the
// normal weathers' and a parked view is reached by name or by `special` (`all,special` is every
// view). `normal` is `all`, kept as a name. tools/kit/gates.py --normal leaves special entries
// unjudged. A clip belongs to the group of its view (clips.mjs).
//
// Crop anchors: each view names the subjects worth a 1:1 look (`crops`). The page projects a world
// point for each into a 384 px box of the captured image (device pixels) and exposes them as
// `window.__PONLAI_CROPS__`, a getter evaluated when read, so it follows the camera the capture
// shows; capture.mjs writes it into the capture's JSON (`crops`) and diff-set.py --crops-from cuts
// those boxes. An anchor that is off screen or hidden behind the island is reported with
// `missing` instead of a box. Reading the anchors does not change the scene.
//
//   node views.mjs list [parity|taa|all|normal|special]   -> view names, one per line
//   node views.mjs query <name>            -> the view's extra query
//   node views.mjs eval <name>             -> the view's eval js (the crop anchors' setup included)
//   node views.mjs crops <name>            -> the view's anchor names, comma-separated
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eveningHour, morningHour } from '../../packages/render/sky/DayCycle.ts';

// the hour, for a query, at which the morning's or the evening's sun stands `elevation` degrees up
const morning = ( elevation ) => morningHour( elevation ).toFixed( 4 );
const evening = ( elevation ) => eveningHour( elevation ).toFixed( 4 );

const PRE = `const s = window.__PONLAI__;
// the island's box: the camera's ground (packages/island/camera/IslandGround.ts, merged from the chunks' ground
// grids), which equals the box of the island's chunk meshes but never reads their vertices
const isl = () => { const b = s.controls.ground.bounds;
	return { cx: ( b.min.x + b.max.x ) / 2, cz: ( b.min.z + b.max.z ) / 2, rx: ( b.max.x - b.min.x ) / 2, rz: ( b.max.z - b.min.z ) / 2, top: b.max.y }; };
// (older builds, such as the exp/taa preview, have no setCameraView or controls.settle: the views
// fall back to what those builds have, so the experiment's images can be cut alike)
const free = ( p, l, fov ) => { s.setCameraView?.( 'island' ); s.setCameraMode( 'free' ); s.camera.position.set( p[ 0 ], p[ 1 ], p[ 2 ] );
	s.camera.lookAt( l[ 0 ], l[ 1 ], l[ 2 ] ); s.camera.fov = fov; s.camera.updateProjectionMatrix(); };
const orbitAround = ( dirx, dirz ) => { const t = s.controls.target, p = s.camera.position; const r = Math.hypot( p.x - t.x, p.z - t.z ), len = Math.hypot( dirx, dirz ) || 1;
	p.x = t.x + dirx / len * r; p.z = t.z + dirz / len * r; s.camera.lookAt( t ); s.controls.update(); };`;

// The crop anchors, installed after the view's own eval. Everything here runs only when
// window.__PONLAI_CROPS__ is read: the island's height grid (the camera's ground: the highest point
// of the island's chunks per 0.5 m cell of the world's lattice), visibility by marching the grid
// from the camera, and the projection into device pixels.
const CROPS = `
const CROP = 384, CELL = 0.5;
let grid = null;
const heightGrid = () => {
	if ( grid ) return grid;
	// IslandGround's own grid (-Infinity where no point falls), read in place
	const G = s.controls.ground, nx = G.nx, nz = G.nz, h = G.heights;
	// fill cells no point fell in from their neighbours
	const f = h.slice();
	for ( let z = 1; z < nz - 1; z ++ ) for ( let x = 1; x < nx - 1; x ++ ) {
		const c = x + z * nx; if ( h[ c ] > - Infinity ) continue;
		let m = - Infinity, n = 0;
		for ( const d of [ - 1, 1, - nx, nx ] ) if ( h[ c + d ] > - Infinity ) { m = Math.max( m, h[ c + d ] ); n ++; }
		if ( n >= 3 ) f[ c ] = m;
	}
	const sorted = Array.from( f ).filter( ( y ) => y > - Infinity ).sort( ( a, b ) => a - b );
	grid = { x0: G.x0, z0: G.z0, nx, nz, h: f, top: sorted[ Math.floor( sorted.length * 0.98 ) ] };
	return grid;
};
const height = ( x, z ) => { const g = heightGrid(); const i = Math.floor( ( x - g.x0 ) / CELL ), k = Math.floor( ( z - g.z0 ) / CELL );
	return i < 0 || k < 0 || i >= g.nx || k >= g.nz ? - Infinity : g.h[ i + k * g.nx ]; };
const V = ( x, y, z ) => new s.camera.position.constructor( x, y, z );
// terrain between the camera and p (the last 'margin' metres excepted)
const visible = ( p, margin = 0.8 ) => {
	const c = s.camera.position, d = p.clone().sub( c ), len = d.length(); d.divideScalar( len );
	for ( let t = 0.5; t < len - margin; t += 0.25 ) {
		const x = c.x + d.x * t, y = c.y + d.y * t, z = c.z + d.z * t;
		if ( y < height( x, z ) - 0.05 ) return false;
	}
	return true;
};
// nothing but sky beyond p along the view ray (a silhouette against the sky)
const skyBehind = ( p ) => {
	const c = s.camera.position, d = p.clone().sub( c ).normalize();
	if ( d.y <= 0.002 ) return false;
	for ( let t = 0.6; t < 80; t += 0.25 ) if ( p.y + d.y * t < height( p.x + d.x * t, p.z + d.z * t ) + 0.05 ) return false;
	return true;
};
// the islander as a solid cylinder about its centre (the hips) from the feet to above the head
const islanderBlocks = ( p ) => {
	const ic = s.characters.centre; if ( ! ic || ! ic.lengthSq() ) return false;
	const c = s.camera.position, d = p.clone().sub( c ), len = d.length(); d.divideScalar( len );
	for ( let t = 0.5; t < len - 0.3; t += 0.1 ) {
		const x = c.x + d.x * t, y = c.y + d.y * t, z = c.z + d.z * t;
		if ( y > ic.y - 1.05 && y < ic.y + 0.9 && ( x - ic.x ) ** 2 + ( z - ic.z ) ** 2 < 0.35 ** 2 ) return true;
	}
	return false;
};
const clearView = ( p ) => visible( p ) && ! islanderBlocks( p );
const screen = () => { const r = s.renderer.domElement.getBoundingClientRect(), k = window.devicePixelRatio;
	return { r, k, w: Math.round( window.innerWidth * k ), h: Math.round( window.innerHeight * k ) }; };
const project = ( p ) => {
	const q = p.clone().project( s.camera ), sc = screen();
	if ( q.z < - 1 || q.z > 1 ) return null;
	return [ ( sc.r.left + ( q.x + 1 ) / 2 * sc.r.width ) * sc.k, ( sc.r.top + ( 1 - q.y ) / 2 * sc.r.height ) * sc.k ];
};
// whether a box around the point fits inside the image
const inner = ( px ) => { const sc = screen(); return px && px[ 0 ] >= CROP / 2 && px[ 1 ] >= CROP / 2 && px[ 0 ] <= sc.w - CROP / 2 && px[ 1 ] <= sc.h - CROP / 2; };
const onScreen = ( px ) => { const sc = screen(); return px && px[ 0 ] >= 0 && px[ 1 ] >= 0 && px[ 0 ] <= sc.w && px[ 1 ] <= sc.h; };
// the boxes placed so far in this reading: a later anchor with a choice of points keeps clear of them
let placed = [];
const clear = ( px ) => placed.every( ( q ) => Math.max( 0, CROP - Math.abs( q[ 0 ] - px[ 0 ] ) ) * Math.max( 0, CROP - Math.abs( q[ 1 ] - px[ 1 ] ) ) < CROP * CROP * 0.3 );
const pick = ( cands, ok = visible ) => { cands.sort( ( a, b ) => a.score - b.score );
	for ( const c of cands ) { const px = project( c.p ); if ( inner( px ) && clear( px ) && ok( c.p ) ) return c.p; } return null; };
const cells = ( test ) => { const g = heightGrid(), out = [];
	for ( let k = 2; k < g.nz - 2; k ++ ) for ( let i = 2; i < g.nx - 2; i ++ ) { const y = g.h[ i + k * g.nx ]; if ( y === - Infinity ) continue;
		const x = g.x0 + ( i + 0.5 ) * CELL, z = g.z0 + ( k + 0.5 ) * CELL, r = test( x, y, z, i, k ); if ( r ) out.push( r ); }
	return out; };
// a cell at the coast: the outward direction toward the lower neighbours within 'reach' cells
const outward = ( i, k, below, reach ) => { const g = heightGrid(); let ox = 0, oz = 0;
	for ( let b = - reach; b <= reach; b ++ ) for ( let a = - reach; a <= reach; a ++ ) {
		const ii = i + a, kk = k + b; const y = ii < 0 || kk < 0 || ii >= g.nx || kk >= g.nz ? - Infinity : g.h[ ii + kk * g.nx ];
		if ( y < below ) { ox += a; oz += b; } }
	const l = Math.hypot( ox, oz ); return l > 0 ? [ ox / l, oz / l ] : null; };
const facing = ( p, o ) => o && ( s.camera.position.x - p.x ) * o[ 0 ] + ( s.camera.position.z - p.z ) * o[ 1 ] > 0;
const dist = ( p ) => p.distanceTo( s.camera.position );
const meadowAt = ( target, lo, hi ) => { const g = heightGrid();
	return pick( cells( ( x, y, z, i, k ) => { if ( y < g.top - 0.7 || outward( i, k, g.top - 2.5, 3 ) ) return null;
		const p = V( x, y, z ), d = dist( p ); if ( d < lo || d > hi ) return null;
		const px = project( p ); const sc = screen();
		return { p, score: Math.abs( d - target ) + ( px ? Math.hypot( px[ 0 ] - sc.w / 2, px[ 1 ] - sc.h / 2 ) * 0.002 : 99 ) }; } ), clearView ); };
const lips = () => { const g = heightGrid(); return cells( ( x, y, z, i, k ) => { if ( y < g.top - 0.7 ) return null; const o = outward( i, k, g.top - 2.5, 2 );
	if ( ! o ) return null; const p = V( x, y, z ); return facing( p, o ) || p.y > s.camera.position.y ? { p, o } : null; } ); };
const coast = ( y0 ) => cells( ( x, y, z, i, k ) => { if ( y < y0 + 0.3 ) return null; const o = outward( i, k, - 0.5, 2 );
	if ( ! o ) return null; const p = V( x + o[ 0 ] * CELL, y0, z + o[ 1 ] * CELL ); return facing( p, o ) ? { p, o } : null; } );
const flowerBeds = () => { const bins = new Map();
	for ( const [ x, y, z ] of s.grass.userData.flowerHeads() ) {
			const key = Math.floor( x / 2 ) + ',' + Math.floor( z / 2 ); const b = bins.get( key ) ?? { n: 0, x: 0, y: 0, z: 0 };
			b.n ++; b.x += x; b.y += y; b.z += z; bins.set( key, b ); }
	return [ ...bins.values() ].map( ( b ) => ( { n: b.n, p: V( b.x / b.n, b.y / b.n + 0.25, b.z / b.n ) } ) ); };
const bone = ( name ) => { const b = s.characters.walker.group.getObjectByName( name ); return b ? b.getWorldPosition( V( 0, 0, 0 ) ) : null; };
const keyDir = () => s.sky.sunDir.y > 0.02 ? s.sky.sunDir : s.sky.moonDir;
const horizonPoint = ( dx, dz ) => { const c = s.camera.position; return V( c.x + dx * 5000, 0, c.z + dz * 5000 ); };
const sky = ( dir ) => dir.y > 0.03 && skyBehind( s.camera.position.clone().addScaledVector( dir, 0.5 ) );
const ANCHORS = {
	'meadow-near': () => meadowAt( 5, 2.5, 20 ),
	'meadow-band-40m': () => meadowAt( 40, 34, 46 ),
	'meadow-band-70m': () => meadowAt( 70, 62, 80 ),
	// the nearest 2 m cell of the meadow with a few flowering plants in it
	'flowers': () => pick( flowerBeds().filter( ( b ) => b.n >= 4 && dist( b.p ) < 90 ).map( ( b ) => ( { p: b.p, score: dist( b.p ) - b.n * 0.05 } ) ), clearView ),
	// the nearest stretch of the lip (with the meadow draped over it) facing the camera
	'rim-lip': () => pick( lips().map( ( c ) => ( { p: c.p, score: dist( c.p ) } ) ).filter( ( c ) => c.score > 4 ) ),
	// the cliff's foot at the waterline, facing the camera
	'cliff-edge-sea': () => pick( coast( 0.3 ).map( ( c ) => ( { p: c.p, score: dist( c.p ) } ) ) ),
	// the lip seen from below against the sky; where the plateau behind the lip rises above the
	// line of sight (a camera only a little below the top, or level with it), the island's silhouette
	// on a lip's bearing: the terrain point seen highest above the camera's horizontal (above the sea
	// horizon, so only sky lies beyond it)
	'cliff-edge-sky': () => { const c = s.camera.position, all = lips(), below = all.filter( ( l ) => l.p.y > c.y + 0.3 );
		const edge = pick( below.map( ( l ) => ( { p: l.p, score: dist( l.p ) } ) ), ( p ) => visible( p ) && skyBehind( p ) );
		if ( edge ) return edge;
		const cands = [];
		for ( const l of all ) { const dx = l.p.x - c.x, dz = l.p.z - c.z, r = Math.hypot( dx, dz ); let best = null, ang = 0.002;
			for ( let t = Math.max( 0.5, r - 2 ); t < r + 80; t += 0.25 ) { const x = c.x + dx / r * t, z = c.z + dz / r * t, h = height( x, z );
				if ( ( h - c.y ) / t > ang ) { ang = ( h - c.y ) / t; best = V( x, h, z ); } }
			if ( best ) cands.push( { p: best, score: dist( best ) } ); }
		return pick( cands ); },
	'islander-head': () => { const p = bone( 'Head' ); if ( p ) p.y += 0.12; return p && inner( project( p ) ) && visible( p, 0.3 ) ? p : null; },
	'islander-hands': () => { for ( const n of [ 'WristR', 'WristL' ] ) { const p = bone( n ); if ( p && inner( project( p ) ) && visible( p, 0.3 ) ) return p; } return null; },
	// the sea where it mirrors the key light (sun, else moon) toward the camera; when that point lies
	// below the frame (a high light, a level camera), the glitter path farther out along the light's
	// bearing where it enters the frame (near the frame's edge the box is clamped into the image)
	'sea-glints': () => { const k = keyDir(), c = s.camera.position; if ( k.y < 0.02 ) return null; const l = Math.hypot( k.x, k.z ) || 1;
		let d = Math.min( c.y / Math.tan( Math.asin( Math.min( 1, k.y ) ) ), 3000 ), p = null;
		for ( ; d <= 3000; d *= 1.1 ) { p = V( c.x + k.x / l * d, 0, c.z + k.z / l * d ); const px = project( p );
			if ( ! px || px[ 1 ] <= screen().h - CROP / 4 ) break; }
		return onScreen( project( p ) ) && visible( p, 0.3 ) ? p : null; },
	// the horizon ahead, turned aside in steps until the island no longer hides it
	'horizon-line': () => { const f = V( 0, 0, - 1 ).applyQuaternion( s.camera.quaternion ); const a0 = Math.atan2( f.z, f.x );
		for ( const da of [ 0, 0.12, - 0.12, 0.24, - 0.24, 0.36, - 0.36 ] ) { const p = horizonPoint( Math.cos( a0 + da ), Math.sin( a0 + da ) );
			const dir = p.clone().sub( s.camera.position ).normalize(); let hidden = false;
			for ( let t = 0.5; t < 200; t += 0.25 ) { const q = s.camera.position.clone().addScaledVector( dir, t ); if ( q.y < height( q.x, q.z ) ) { hidden = true; break; } }
			if ( ! hidden && inner( project( p ) ) ) return p; } return null; },
	// open night sky in the upper part of the frame
	'stars': () => { if ( s.sky.sunDir.y > - 0.1 ) return null; for ( const [ x, y ] of [ [ 0.45, 0.6 ], [ - 0.45, 0.6 ], [ 0, 0.7 ], [ 0.6, 0.35 ], [ - 0.6, 0.35 ] ] ) {
		const d = V( x, y, 0.5 ).unproject( s.camera ).sub( s.camera.position ).normalize(); if ( sky( d ) ) return s.camera.position.clone().addScaledVector( d, 5000 ); } return null; },
	// open sky just above the sea horizon, where the stars scintillate (NightSky.ts: below about
	// 11 degrees, most below 3): beside the camera's heading and clear of the moon, the box's
	// lower edge above the horizon and sky along it
	'stars-horizon': () => { if ( s.sky.sunDir.y > - 0.1 ) return null; const f = V( 0, 0, - 1 ).applyQuaternion( s.camera.quaternion ), a0 = Math.atan2( f.z, f.x );
		const am = Math.atan2( s.sky.moonDir.z, s.sky.moonDir.x ), sc = screen(), c = s.camera.position;
		const ray = ( x, y ) => V( x / sc.w * 2 - 1, 1 - y / sc.h * 2, 0.5 ).unproject( s.camera ).sub( c ).normalize();
		for ( const da of [ 0.45, - 0.45, 0.3, - 0.3, 0.6, - 0.6 ] ) { const a = a0 + da; if ( Math.abs( Math.atan2( Math.sin( a - am ), Math.cos( a - am ) ) ) < 0.25 ) continue;
			const h = project( horizonPoint( Math.cos( a ), Math.sin( a ) ) ); if ( ! h ) continue;
			for ( const e of [ 0.07, 0.09, 0.11, 0.13 ] ) { const d = V( Math.cos( a ) * Math.cos( e ), Math.sin( e ), Math.sin( a ) * Math.cos( e ) ), p = c.clone().addScaledVector( d, 5000 ), px = project( p );
				if ( ! px || ! inner( px ) || px[ 1 ] + CROP / 2 > h[ 1 ] - 4 ) continue;
				const bottom = px[ 1 ] + CROP / 2 - 2;
				if ( [ - 0.5, 0, 0.5 ].every( ( k ) => sky( ray( px[ 0 ] + k * CROP, bottom ) ) ) ) return p; } }
		return null; },
	// the moon's upper limb (drawn at twice its true radius); near the frame's edge its box is
	// clamped into the image rather than dropped
	'moon-limb': () => { const m = s.sky.moonDir.clone().normalize(); if ( m.y < 0 ) return null; const up = V( 0, 1, 0 ).addScaledVector( m, - m.y ).normalize();
		const d = m.clone().addScaledVector( up, Math.tan( 2 * 0.004654 ) ).normalize(); const p = s.camera.position.clone().addScaledVector( d, 5000 ); return onScreen( project( p ) ) ? p : null; },
	// the falling rain a few metres ahead, upper left, where streaks cross sky or sea
	'rain-streaks': () => { if ( ! ( s.rain.uniforms.rain.value > 0.01 ) ) return null; const d = V( - 0.35, 0.25, 0.5 ).unproject( s.camera ).sub( s.camera.position ).normalize();
		return s.camera.position.clone().addScaledVector( d, 6 ); },
	// the cliff face half way up, nearest the camera (in fog: the near cliff through the fog)
	'fog-cliff': () => { const g = heightGrid(); return pick( coast( g.top * 0.45 ).map( ( c ) => ( { p: c.p, score: dist( c.p ) } ) ) ); },
};
const anchors = NAMES;
Object.defineProperty( window, '__PONLAI_CROPS__', { configurable: true, get: () => {
	s.camera.updateMatrixWorld();
	const sc = screen(), out = {};
	placed = [];
	for ( const name of anchors ) {
		let p = null; try { p = ANCHORS[ name ](); } catch ( e ) { out[ name ] = { missing: 'error: ' + e.message }; continue; }
		const px = p && project( p );
		if ( ! px ) { out[ name ] = { missing: p ? 'off screen' : 'not visible' }; continue; }
		placed.push( px );
		const x = Math.round( Math.min( Math.max( px[ 0 ] - CROP / 2, 0 ), sc.w - CROP ) ), y = Math.round( Math.min( Math.max( px[ 1 ] - CROP / 2, 0 ), sc.h - CROP ) );
		out[ name ] = { x, y, w: CROP, h: CROP, anchor: [ Math.round( px[ 0 ] ), Math.round( px[ 1 ] ) ], world: [ p.x, p.y, p.z ].map( ( c ) => + c.toFixed( 3 ) ), distance: + dist( p ).toFixed( 2 ) };
	}
	return out;
} } );`;

const wrap = ( body, crops ) => `(async () => { ${ PRE }\n${ body ?? '' }\n{${ CROPS.replace( 'NAMES', JSON.stringify( crops ) ) }\n}\n})()`;

// the islander's centre (hips) once the first frame has placed it
const ISLANDER = 'while ( ! s.characters.centre.lengthSq() ) await new Promise( ( r ) => setTimeout( r, 50 ) ); const c = s.characters.centre;';

export const VIEWS = {
	// the profiler's scenes (tools/profile-frame.mjs SCENES), paused
	'island-fair-noon': { q: 'weather=fair&preset=noon', crops: [ 'meadow-band-70m', 'flowers', 'rim-lip', 'cliff-edge-sea', 'islander-head' ] },
	// orbit to the island's far side from the sun: the view looks into the low sun (profiler's faceSun)
	'island-clear-golden': { q: 'weather=clear&preset=golden-hour', eval: 'orbitAround( - s.sky.sunDir.x, - s.sky.sunDir.z );', crops: [ 'rim-lip', 'cliff-edge-sea' ] },
	'horizon-fair-noon': { q: 'weather=fair&preset=noon', eval: `s.setCameraView( 'horizon' );`, crops: [ 'cliff-edge-sea', 'rim-lip', 'horizon-line' ] },
	'sky-fair': { q: 'weather=fair&preset=noon', eval: `s.setCameraView( 'sky' );`, crops: [] },
	'sky-cloudy': { special: true, q: 'weather=cloudy&preset=noon', eval: `s.setCameraView( 'sky' );`, crops: [] },
	'island-overcast': { special: true, q: 'weather=overcast&preset=noon', crops: [ 'meadow-band-70m', 'rim-lip', 'cliff-edge-sea' ] },
	'island-rain': { special: true, q: 'weather=rain&preset=noon', crops: [ 'rain-streaks', 'meadow-band-70m', 'rim-lip', 'cliff-edge-sea' ] },
	'island-storm': { special: true, q: 'weather=storm&preset=noon', crops: [ 'rain-streaks', 'rim-lip', 'cliff-edge-sea' ] },
	'horizon-storm': { special: true, q: 'weather=storm&preset=noon', eval: `s.setCameraView( 'horizon' );`, crops: [ 'rain-streaks', 'horizon-line', 'cliff-edge-sea' ] },
	'island-fog-dawn': { special: true, q: 'weather=fog&preset=dawn', crops: [ 'fog-cliff', 'rim-lip', 'meadow-band-70m' ] },
	'island-night-clear': { q: 'weather=clear&preset=midnight', crops: [ 'rim-lip', 'meadow-band-70m', 'cliff-edge-sea' ] },
	// the profiler's meadow placement: eye height a little inside the rim, looking out over the lip
	'meadow-close': { q: 'weather=fair&preset=noon', eval: `const b = isl(); const d = { x: Math.cos( 0.7 ), z: Math.sin( 0.7 ) };
		const p = [ b.cx + d.x * b.rx * 0.45, b.top + 1.6, b.cz + d.z * b.rz * 0.45 ];
		free( p, [ p[ 0 ] + d.x * 10, p[ 1 ] - 2.2, p[ 2 ] + d.z * 10 ], 55 );`, crops: [ 'meadow-near', 'rim-lip', 'horizon-line' ] },
	// the profiler's front from fair to rain, frozen half way (3 s of its 6 s), its environment baked
	'weather-change': { special: true, q: 'weather=fair&preset=noon', eval: `await s.setWeather( 'rain', 6 ); s.weather.update( 3 ); await s.refreshEnvironment();`, crops: [ 'rain-streaks', 'meadow-band-70m', 'rim-lip', 'cliff-edge-sea' ] },

	// extra views
	// the low suns whose clouds' shadow is cast over the sun's disc: 4.8 degrees, the air reading the
	// whole disc; 5.3, halfway through the air's fade to the centre rays; 9.3, the disc fading to one
	// ray. Their elevations are chosen by what they reach, which depends on where the clouds sit at
	// t=12: pinning `shadowRays` to 1, or `shadowAirNarrow` to its other end, must move each of them
	// (tools/parity/README.md), and a view that stays byte identical under that does not belong here.
	'island-cloudy-low-sun': { special: true, q: `weather=cloudy&hour=${ morning( 4.8 ) }`, crops: [ 'meadow-band-70m', 'rim-lip' ] },
	'island-cloudy-sun-rising': { special: true, q: `weather=cloudy&hour=${ morning( 5.3 ) }`, crops: [ 'meadow-band-70m', 'rim-lip' ] },
	'island-cloudy-disc-fade': { special: true, q: `weather=cloudy&hour=${ morning( 9.3 ) }`, crops: [ 'meadow-band-70m', 'rim-lip' ] },
	// a low camera 1.4 m over the sea, just off the cliffs, looking along the coast (reflections of
	// the cliff foot and the islanders, the island's edge against the sky)
	'water-skim-cliffs': { q: 'weather=fair&preset=noon', eval: `const b = isl(); const a = 2.3, r = Math.max( b.rx, b.rz );
		const p = [ b.cx + Math.cos( a ) * r * 1.25, 1.4, b.cz + Math.sin( a ) * r * 1.25 ];
		const l = [ b.cx + Math.cos( a + 0.75 ) * r * 0.95, 2.5, b.cz + Math.sin( a + 0.75 ) * r * 0.95 ];
		free( p, l, 55 );`, crops: [ 'cliff-edge-sea', 'cliff-edge-sky', 'rim-lip', 'horizon-line' ] },
	// a free camera 150 m out, 14 m up, looking back at the island
	'island-from-sea': { q: 'weather=fair&preset=noon', eval: `const b = isl(); const a = 4.0;
		free( [ b.cx + Math.cos( a ) * 150, 14, b.cz + Math.sin( a ) * 150 ], [ b.cx, 3, b.cz ], 35 );`, crops: [ 'cliff-edge-sea', 'rim-lip', 'horizon-line' ] },
	// sunrise, the orbit turned across the sun so the long shadows run sideways over the meadow
	'sunrise-long-shadows': { q: 'weather=clear&preset=sunrise', eval: 'orbitAround( s.sky.sunDir.z, - s.sky.sunDir.x );', crops: [ 'meadow-band-70m', 'rim-lip' ] },
	// a full moon 20 degrees up, the sun 15.8 degrees under the horizon in the evening, from the low
	// horizon orbit's place facing the moon over the island, the line of sight raised to 8 degrees up
	// so the frame (from about 35 degrees up to 20 down) holds the moon in its upper third and the
	// sea's horizon low
	'night-moon': { q: `weather=clear&hour=${ evening( - 15.8 ) }&moon=0.5`, eval: `s.setCameraView( 'horizon' ); orbitAround( - s.sky.moonDir.x, - s.sky.moonDir.z );
		const c = s.camera.position.clone(), m = s.sky.moonDir, l = Math.hypot( m.x, m.z ) || 1, e = 8 * Math.PI / 180;
		free( [ c.x, c.y, c.z ], [ c.x + m.x / l * Math.cos( e ) * 5000, c.y + Math.sin( e ) * 5000, c.z + m.z / l * Math.cos( e ) * 5000 ], 55 );`, crops: [ 'moon-limb', 'stars', 'sea-glints', 'horizon-line' ] },

	// temporal anti-aliasing views: thin, high-contrast and moving detail up close
	// the orbit at 24 m, 60 degrees from the zenith: the meadow's near bands and its flowers
	'meadow-24': { group: 'taa', q: 'weather=fair&preset=noon&dist=24&polar=60&az=300', crops: [ 'islander-head', 'flowers', 'meadow-near', 'rim-lip' ] },
	// the orbit low over the sea at 36 m: the lip against the sky
	'low-36': { group: 'taa', q: 'weather=fair&preset=noon&dist=36&polar=80&az=330', crops: [ 'rim-lip', 'cliff-edge-sea', 'meadow-band-40m', 'horizon-line' ] },
	// the islander a few metres away (skinned motion, ears, hands)
	'islander-close': { group: 'taa', q: 'weather=fair&preset=noon', eval: `${ ISLANDER }
		s.controls.minDistance = 2; s.controls.target.copy( c ); s.camera.position.set( c.x + 3.2, c.y + 2.4, c.z + 3.6 ); s.camera.lookAt( c ); ( s.controls.settle ?? s.controls.update ).call( s.controls );`,
	crops: [ 'islander-head', 'islander-hands', 'meadow-near' ] },
	// 1.2 m over the densest flowers (3 m cells of the meadow's flowering plants), looking 35 degrees down
	// and away from the island's centre; the flowers are off by default (`--q flowers` plants them, a
	// load-time option a jump cannot change), so without them it looks at the island's centre
	'flowers-close': { group: 'taa', q: 'weather=fair&preset=noon', eval: `const b = isl(), bins = new Map();
		for ( const [ x, y, z ] of s.grass.userData.flowerHeads() ) {
				const key = Math.floor( x / 3 ) + ',' + Math.floor( z / 3 ); const e = bins.get( key ) ?? { n: 0, x: 0, y: 0, z: 0, key };
				e.n ++; e.x += x; e.y += y; e.z += z; bins.set( key, e ); }
		// (a page without them, as a jump from one: the island's centre)
		const best = [ ...bins.values() ].sort( ( a, c ) => c.n - a.n || ( a.key < c.key ? - 1 : 1 ) )[ 0 ] ?? { n: 1, x: b.cx, y: b.top, z: b.cz };
		const f = [ best.x / best.n, best.y / best.n, best.z / best.n ];
		let dx = f[ 0 ] - b.cx, dz = f[ 2 ] - b.cz; const len = Math.hypot( dx, dz ) || 1; dx /= len; dz /= len;
		const back = 1.2 / Math.tan( 35 * Math.PI / 180 );
		free( [ f[ 0 ] - dx * back, f[ 1 ] + 1.2, f[ 2 ] - dz * back ], f, 55 );`, crops: [ 'flowers', 'meadow-near' ] },
	// 25 m out over the sea and 4 m up, facing the densest stretch of the meadow's tufts at the cliff's
	// edge (5 degree sectors of their roots, each by its blades)
	'rim-sea': { group: 'taa', q: 'weather=fair&preset=noon', eval: `const b = isl(); const n = 72, bins = Array.from( { length: n }, () => ( { n: 0, x: 0, y: 0, z: 0 } ) );
		for ( const [ x, y, z, w ] of s.grass.userData.edgeRoots() ) {
			const k = Math.floor( ( Math.atan2( z - b.cz, x - b.cx ) / ( 2 * Math.PI ) + 0.5 ) * n ) % n; const e = bins[ k ]; e.n += w; e.x += x * w; e.y += y * w; e.z += z * w; }
		const e = bins.reduce( ( a, c ) => c.n > a.n ? c : a ); const p = [ e.x / e.n, e.y / e.n, e.z / e.n ];
		let dx = p[ 0 ] - b.cx, dz = p[ 2 ] - b.cz; const len = Math.hypot( dx, dz ) || 1; dx /= len; dz /= len;
		free( [ p[ 0 ] + dx * 25, 4, p[ 2 ] + dz * 25 ], p, 35 );`, crops: [ 'rim-lip', 'cliff-edge-sea' ] },
	// golden hour from the sea, 3 m up, the island between the camera and the low sun (turned 20
	// degrees off it so the disk stays clear of the island): backlit cliff edges and the sun's glare
	'cliff-sea-golden': { group: 'taa', q: 'weather=clear&preset=golden-hour', eval: `const b = isl(); const r = Math.max( b.rx, b.rz );
		const a = Math.atan2( - s.sky.sunDir.z, - s.sky.sunDir.x ) + 0.35;
		free( [ b.cx + Math.cos( a ) * ( r + 30 ), 3, b.cz + Math.sin( a ) * ( r + 30 ) ], [ b.cx, 2.5, b.cz ], 45 );`, crops: [ 'cliff-edge-sea', 'cliff-edge-sky', 'sea-glints', 'horizon-line' ] },
};

export const VIEW_GROUPS = [ 'parity', 'taa', 'all', 'normal', 'special' ];

export function viewNames( group = 'parity' ) {

	if ( ! VIEW_GROUPS.includes( group ) ) throw new Error( `unknown view group ${ group } (${ VIEW_GROUPS.join( ', ' ) })` );
	// the parked weathers' views only by name or in `special`
	return Object.keys( VIEWS ).filter( ( v ) => group === 'special' ? VIEWS[ v ].special === true
		: VIEWS[ v ].special !== true && ( group === 'all' || group === 'normal' || ( VIEWS[ v ].group ?? 'parity' ) === group ) );

}

/** A --views value as view names: comma-separated names and groups, each group expanded in place
 * (`normal,flowers-close`). Names are not checked here: each tool says what it does with one it
 * does not know. */
export function expandViews( spec ) {

	return [ ...new Set( spec.split( ',' ).filter( Boolean ).flatMap( ( v ) => VIEW_GROUPS.includes( v ) ? viewNames( v ) : [ v ] ) ) ];

}

// (`crops` names other anchors than the view's own: tools/capture-clip.mjs --crops)
export const viewEval = ( name, crops = VIEWS[ name ].crops ?? [] ) => wrap( VIEWS[ name ].eval, crops );

if ( process.argv[ 1 ] && path.resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url ) ) {

	const [ cmd, name ] = process.argv.slice( 2 );
	if ( cmd === 'list' ) console.log( viewNames( name ).join( '\n' ) );
	else if ( cmd === 'query' ) console.log( VIEWS[ name ].q );
	else if ( cmd === 'eval' ) console.log( viewEval( name ) );
	else if ( cmd === 'crops' ) console.log( ( VIEWS[ name ].crops ?? [] ).join( ',' ) );
	else { console.error( 'usage: node views.mjs list [parity|taa|all|normal|special] | query <view> | eval <view> | crops <view>' ); process.exitCode = 2; }

}
