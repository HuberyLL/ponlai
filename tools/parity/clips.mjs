// The named clips: short stepped sequences for the temporal anti-aliasing work, each a parity view
// (views.mjs) set in motion. A clip names its base view, whether the scene clock runs or stays
// paused, its frame count, a camera path and, where it needs them, extra URL options, a render
// scale schedule and a per-frame hook. tools/capture-clip.mjs loads the view as capture-set.mjs
// does (paused at t=12), runs the view's eval, then steps the clip's frames with
// `__PONLAI__.loop.step` (main.ts: fixed dt, no wall clock, the frame pacer and the dynamic scale
// bypassed) and captures crops and full frames as it goes.
//
// Camera paths are functions of the frame index applied to the view's own pose (the "base"), so
// like the views they follow any tile layout: nothing is placed by coordinates. The base is the
// camera's position at frame 0 and its pivot: the orbit's target when the island camera is active,
// else a point 10 m ahead of a free camera. A path gives each frame a position and a pivot; the
// camera looks at the pivot (the island camera keeps both as its own pose: its update at rest
// leaves a pose placed by hand as it is).
//
//   yaw( deg )               turn in place, `deg` degrees a frame about the vertical (a pan)
//   flick( deg, start, n )   rest, then turn `deg` degrees over n frames (smoothstep), then rest
//   dolly( k )               toward the pivot, the distance times exp( -k ) a frame (a zoom)
//   orbit( deg, subject )    around a subject, `deg` degrees a frame, looking at it ('islander':
//                            the walking islander's centre, followed as it moves)
//   still                    the base pose every frame
//
// A render scale schedule is given as shares of the tier's nominal ratio (`__PONLAI__.nominalScale()`,
// 1.5 on high at the default size), so it keeps its meaning at any --size; the page turns it into
// the absolute ratios `loop.step` takes.
//
// Paused clips isolate the camera's motion over a frozen scene; running ones (the clock steps by
// dt from t=12) add the scene's own motion: wind, sea, rain, the islander, lightning, the sun.
//
//   node tools/parity/clips.mjs list            -> clip names, one per line
//   node tools/parity/clips.mjs show <clip>     -> the clip's definition as JSON
//   node tools/parity/clips.mjs eval <clip>     -> the page js that installs window.__PONLAI_CLIP__
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VIEWS } from './views.mjs';

// A strike in front of the camera at frame 30 (lightning's `force`, at the scene time that frame
// renders: the tick adds dt before it lights the strikes).
const STRIKE_AT_30 = `if ( i === 30 ) { const f = new s.camera.position.constructor( 0, 0, - 1 ).applyQuaternion( s.camera.quaternion );
	s.sky.lightning.force( { start: s.clockTime() + dt, azimuth: Math.atan2( f.z, f.x ), distance: 3000, seed: 7 } ); }`;

// The sun-shadow clip wants the vegetation still, so only the shadows move: a wind freeze flag
// does not exist yet (it arrives with the vegetation's motion vectors, mv-vegetation in M8); until
// then the clip runs with the wind as it is and says so in its notes.
const WIND_FREEZE = `if ( 'windFreeze' in s.flags ) s.flags.windFreeze = true; else window.__PONLAI_CLIP_NOTES__.push( 'flags.windFreeze does not exist yet (mv-vegetation, M8): the vegetation sways with the wind' );`;

export const CLIPS = {
	// camera motion over a frozen scene
	'static-jitter': { view: 'meadow-close', clock: 'paused', frames: 64, path: [ 'still' ],
		about: 'a still camera and a paused scene: under MSAA every frame is the same; a temporal resolve shows its jitter and convergence' },
	'pan-slow': { view: 'meadow-close', clock: 'paused', frames: 64, path: [ 'yaw', 0.05 ],
		about: 'a slow pan (3 degrees a second at 60 fps, about 2 canvas px a frame)' },
	'pan-fast': { view: 'meadow-close', clock: 'paused', frames: 64, path: [ 'yaw', 0.5 ],
		about: 'a fast pan (30 degrees a second)' },
	'flick': { view: 'island-fair-noon', clock: 'paused', frames: 64, path: [ 'flick', 40, 16, 10 ],
		about: 'rest, a 40 degree flick over 10 frames from frame 16, rest: disocclusion and the history rebuilding' },
	'zoom': { view: 'island-fair-noon', clock: 'paused', frames: 64, path: [ 'dolly', 0.008 ],
		about: 'a dolly toward the orbit pivot, to 60 % of the distance over 64 frames' },
	// skinned motion
	'islander-walk': { view: 'islander-close', clock: 'running', frames: 64, path: [ 'still' ],
		about: 'the islander walking past a still camera' },
	'islander-orbit': { view: 'islander-close', clock: 'running', frames: 64, path: [ 'orbit', 1, 'islander' ],
		about: 'the camera orbiting the walking islander, 1 degree a frame' },
	// wind and sea
	'wind-still': { view: 'meadow-close', clock: 'running', frames: 64, path: [ 'still' ],
		about: 'the meadow in the wind, a still camera' },
	'sea-still': { view: 'water-skim-cliffs', clock: 'running', frames: 64, path: [ 'still' ],
		about: 'the FFT sea against the cliffs, a still camera' },
	'sea-pan': { view: 'water-skim-cliffs', clock: 'running', frames: 64, path: [ 'yaw', 0.25 ],
		about: 'the sea under a pan (15 degrees a second)' },
	// weather
	'storm': { view: 'island-storm', clock: 'running', frames: 64, path: [ 'still' ],
		about: 'a storm: rain streaks, whitecaps, foam and spray' },
	'rain': { view: 'island-rain', clock: 'running', frames: 64, path: [ 'still' ],
		about: 'rain streaks, ripples and splashes' },
	'lightning': { view: 'horizon-storm', clock: 'running', frames: 64, path: [ 'still' ], at: STRIKE_AT_30,
		about: 'a storm with a strike forced in front of the camera at frame 30' },
	'night': { view: 'island-night-clear', clock: 'running', frames: 64, path: [ 'yaw', 0.05 ],
		about: 'a moonlit night under a slow pan: stars and dark detail' },
	'fog': { view: 'island-fog-dawn', clock: 'running', frames: 64, path: [ 'yaw', 0.05 ],
		about: 'sea fog at dawn under a slow pan' },
	// render scale and light
	'drs-steps': { view: 'island-fair-noon', clock: 'running', frames: 120, path: [ 'still' ],
		scale: [ [ 0.8, 40 ], [ 0.6, 40 ], [ 0.8, 40 ] ],
		about: 'the render scale stepped to 0.8 -> 0.6 -> 0.8 of the nominal ratio (1.2 -> 0.9 -> 1.2 on high at a ratio of 2), 40 frames each, a still camera' },
	'sun-shadow': { view: 'meadow-shade', clock: 'running', frames: 64, q: 'dayLength=600', path: [ 'still' ], setup: WIND_FREEZE,
		about: 'a fast day (600 s) under a still camera: the sun map steps and cross-fades as the sun moves' },
};

export const clipNames = () => Object.keys( CLIPS );

/** The clip's frame scales as shares of the nominal ratio, one per frame, from its
 * [ share, frames ] runs (null: the nominal throughout). */
export function clipScales( clip ) {

	if ( ! clip.scale ) return null;
	return clip.scale.flatMap( ( [ value, n ] ) => Array( n ).fill( value ) );

}

// Page code: the camera paths, as described in the header.
const PATHS = `
const V = ( x, y, z ) => new s.camera.position.constructor( x, y, z );
const orbitMode = s.controls.enabled;
s.camera.updateMatrixWorld();
const p0 = s.camera.position.clone();
const forward = V( 0, 0, - 1 ).applyQuaternion( s.camera.quaternion );
const t0 = orbitMode ? s.controls.target.clone() : p0.clone().addScaledVector( forward, 10 );
const up = V( 0, 1, 0 );
const place = ( p, t ) => {
	s.camera.position.copy( p );
	if ( orbitMode ) s.controls.target.copy( t );
	s.camera.lookAt( t );
	s.camera.updateMatrixWorld();
};
const rad = Math.PI / 180;
const turn = ( a ) => place( p0, t0.clone().sub( p0 ).applyAxisAngle( up, a ).add( p0 ) );
const smooth = ( x ) => { x = Math.min( Math.max( x, 0 ), 1 ); return x * x * ( 3 - 2 * x ); };
const subjects = { islander: () => s.characters.centre.clone() };
const PATH = {
	still: () => () => place( p0, t0 ),
	yaw: ( deg ) => ( i ) => turn( - deg * rad * i ),
	flick: ( deg, start, n ) => ( i ) => turn( - deg * rad * smooth( ( i - start ) / n ) ),
	dolly: ( k ) => ( i ) => place( t0.clone().add( p0.clone().sub( t0 ).multiplyScalar( Math.exp( - k * i ) ) ), t0 ),
	orbit: ( deg, subject ) => { const c0 = subjects[ subject ](); const offset = p0.clone().sub( c0 );
		return ( i ) => { const c = subjects[ subject ](); place( c.clone().add( offset.clone().applyAxisAngle( up, deg * rad * i ) ), c ); }; },
};`;

/** Page code that installs `window.__PONLAI_CLIP__` = { camera( i ), frames, clock, dt, scale } for
 * the clip, from the camera's current pose (run it after the view's eval); `scale` holds absolute
 * render ratios, one per frame. */
export function clipEval( name, { frames, dt = 1 / 60 } = {} ) {

	const clip = CLIPS[ name ];
	if ( ! clip ) throw new Error( `unknown clip ${ name }` );
	const [ kind, ...args ] = clip.path;
	return `(async () => { const s = window.__PONLAI__; const dt = ${ dt };
window.__PONLAI_CLIP_NOTES__ = [];
${ clip.setup ?? '' }
${ PATHS }
const path = PATH[ ${ JSON.stringify( kind ) } ]( ...${ JSON.stringify( args ) } );
window.__PONLAI_CLIP__ = { name: ${ JSON.stringify( name ) }, frames: ${ frames ?? clip.frames }, clock: ${ JSON.stringify( clip.clock ) }, dt,
	scale: ( ( shares ) => {
		if ( ! shares ) return null;
		if ( typeof s.nominalScale !== 'function' ) throw new Error( 'this build has no __PONLAI__.nominalScale for the scale schedule of the clip' );
		const nominal = s.nominalScale();
		return shares.map( ( k ) => k * nominal );
	} )( ${ JSON.stringify( clipScales( clip ) ) } ),
	camera: ( i ) => { path( i ); ${ clip.at ?? '' } } };
})()`;

}

if ( process.argv[ 1 ] && path.resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url ) ) {

	const [ cmd, name ] = process.argv.slice( 2 );
	if ( cmd === 'list' ) console.log( clipNames().join( '\n' ) );
	else if ( cmd === 'show' && CLIPS[ name ] ) console.log( JSON.stringify( { ...CLIPS[ name ], viewQuery: VIEWS[ CLIPS[ name ].view ].q }, null, 2 ) );
	else if ( cmd === 'eval' && CLIPS[ name ] ) console.log( clipEval( name ) );
	else { console.error( 'usage: node clips.mjs list | show <clip> | eval <clip>' ); process.exitCode = 2; }

}
