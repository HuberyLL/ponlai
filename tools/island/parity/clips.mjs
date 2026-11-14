// The named clips: short stepped sequences for the temporal anti-aliasing work, each a parity view set in motion.
//
// It answers "what does the clip <name> do, frame by frame": tools/kit/parity/capture-clip.mjs,
// tools/kit/parity/baseline.mjs and tools/kit/parity/carry.mjs read their clips, the baseline's plan
// and the ground truth's frame sampling from here. A clip names its base view
// (tools/island/parity/views.mjs), whether the scene clock runs or stays paused, its frame count, a
// camera path and, where it needs them, extra URL options (`sun-shadow`: `dayLength=600`), a render
// scale schedule (`drs-steps`), a per-frame hook (`lightning`: a strike forced at frame 30) and lead
// frames. What each clip is for is its `about` in CLIPS.
//
// Usage:
//   node tools/island/parity/clips.mjs list [all|normal|special]
//   node tools/island/parity/clips.mjs show <clip>
//   node tools/island/parity/clips.mjs eval <clip>
//
// Options: none. The commands:
//   list [group]   the group's clip names, one per line (all)
//   show <clip>    the clip's definition as JSON, with its view's query and its ground truth's sampling
//   eval <clip>    the page js that installs window.__PONLAI_CLIP__
//
// capture-clip.mjs loads the view as capture-set.mjs does (paused at t=12), runs the view's eval,
// then steps the clip's frames with `__PONLAI__.loop.step` (app/Frame.ts: a fixed dt, no wall clock,
// the frame pacer and the dynamic scale bypassed) and captures crops and full frames as it goes.
// Paused clips isolate the camera's motion over a frozen scene; running ones (the clock steps by dt
// from t=12) add the scene's own motion: wind, sea, rain, the islander, lightning, the sun.
//
// Camera paths are functions of the frame index applied to the view's own pose (the base), so like
// the views they follow any land: nothing is placed by coordinates. The base is the camera's position
// at frame 0 and its pivot: the orbit's target when the island camera is active, else a point 10 m
// ahead of a free camera. A path gives each frame a position and a pivot; the camera looks at the
// pivot (the island camera keeps both as its own pose: its update at rest leaves a pose placed by
// hand as it is).
//   yaw( deg )               turn in place, `deg` degrees a frame about the vertical (a pan)
//   flick( deg, start, n )   rest, then turn `deg` degrees over n frames (smoothstep), then rest
//   dolly( k )               toward the pivot, the distance times exp( -k ) a frame (a zoom)
//   orbit( deg, subject )    around a subject, `deg` degrees a frame, looking at it (`islander`:
//                            the walking islander's centre, followed as it moves)
//   still                    the base pose every frame
//
// A render scale schedule is given as shares of the tier's nominal ratio
// (`__PONLAI__.nominalScale()`, 2K's pixel count on high: about 1.38 at the default size), so it
// keeps its meaning at any --size; the page turns it into the absolute ratios `loop.step` takes. A
// clip may step `lead` frames before its frame 0 (at frame 0's pose and scale, the clock running as
// the clip's, nothing captured): a temporal mode starts each clip with its history cut (the stepper
// restarts the loop), so its first frames converge from one frame's samples, a change that is the
// start, not the clip's subject (`drs-steps`: 32 lead frames, so the steps of the scale are measured,
// not the warm-up).
//
// Groups: `special`, the clips whose view is a parked weather's (views.mjs: the rain, the storm, the
// lightning, the fog), and `normal`, the rest; `all` is `normal` (the default), so a parked clip is
// reached by name or by `special`. The view decides, so a clip and its view never fall into
// different groups.
//
// Exported: CLIPS, CLIP_GROUPS, clipNames( group ), BASELINE_PLAN, CARRY_SPOT, GT_DENSE_MAX, GT_EVERY,
// gtSampling( clip, frames ), clipScales( clip ), clipEval( name, { frames, dt, setup } ).
//
// Output: stdout only.
//
// GPU lock and browser: neither (docs/reference/gpu-lock.md); the eval it prints runs in the page of
// whichever tool loads it.
//
// Cost: a fraction of a second.
//
// Exit codes: 0 printed; 1 an unknown group (an uncaught error); 2 an unknown command or clip.
import '../../kit/help.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VIEWS } from './views.mjs';
import PROJECT from '../../project.mjs';

const PAGE = PROJECT.page;

// The measurement window of the clips whose gates pair consecutive frames against the ground truth
// (TI, G, the lag): captured densely there (gtDense), frames 16 to 47 after the clip has settled
// into its motion.
const WINDOW = [ 16, 47 ];

// A strike in front of the camera at frame 30 (lightning's `force`, at the scene time that frame
// renders: the tick adds dt before it lights the strikes).
const STRIKE_AT_30 = `if ( i === 30 ) { const f = new s.camera.position.constructor( 0, 0, - 1 ).applyQuaternion( s.camera.quaternion );
	s.sky.lightning.force( { start: s.clockTime() + dt, azimuth: Math.atan2( f.z, f.x ), distance: 3000, seed: 7 } ); }`;

// The sun-shadow clip wants the vegetation still, so only the shadows move: `flags.windFreeze`
// (DebugFlags.ts, read by Wind.ts every frame) holds the wind. The flag starts unset, so it is set
// here rather than tested for.
const WIND_FREEZE = 's.flags.windFreeze = true;';

export const CLIPS = {
	// a still frame of any view (capture-clip.mjs --view): the rest sets of tools/kit/parity/baseline.mjs
	'rest': { view: 'island-fair-noon', clock: 'paused', frames: 1, path: [ 'still' ],
		about: 'one paused frame of the view at its own pose: the image at rest, captured through the clip machinery so its crops and its ground truth are cut alike' },
	// camera motion over a frozen scene
	'static-jitter': { view: 'meadow-close', clock: 'paused', frames: 64, path: [ 'still' ],
		about: 'a still camera and a paused scene: under MSAA every frame is the same; a temporal resolve shows its jitter and convergence' },
	'pan-slow': { view: 'meadow-close', clock: 'paused', frames: 64, path: [ 'yaw', 0.05 ], gtDense: [ WINDOW ],
		about: 'a slow pan (3 degrees a second at 60 fps, about 2 canvas px a frame)' },
	'pan-fast': { view: 'meadow-close', clock: 'paused', frames: 64, path: [ 'yaw', 0.5 ],
		about: 'a fast pan (30 degrees a second)' },
	'flick': { view: 'island-fair-noon', clock: 'paused', frames: 64, path: [ 'flick', 40, 16, 10 ], gtDense: [ [ 14, 40 ] ],
		about: 'rest, a 40 degree flick over 10 frames from frame 16, rest: disocclusion and the history rebuilding' },
	'zoom': { view: 'island-fair-noon', clock: 'paused', frames: 64, path: [ 'dolly', 0.008 ],
		about: 'a dolly toward the orbit pivot, to 60 % of the distance over 64 frames' },
	// skinned motion
	'islander-walk': { view: 'islander-close', clock: 'running', frames: 64, path: [ 'still' ], gtDense: [ WINDOW ],
		about: 'the islander walking past a still camera' },
	'islander-orbit': { view: 'islander-close', clock: 'running', frames: 64, path: [ 'orbit', 1, 'islander' ], gtDense: [ WINDOW ],
		about: 'the camera orbiting the walking islander, 1 degree a frame' },
	// wind and sea
	'wind-still': { view: 'meadow-close', clock: 'running', frames: 64, path: [ 'still' ], gtDense: [ WINDOW ],
		about: 'the meadow in the wind, a still camera' },
	'sea-still': { view: 'water-skim-cliffs', clock: 'running', frames: 64, path: [ 'still' ],
		about: 'the FFT sea against the cliffs, a still camera' },
	'sea-pan': { view: 'water-skim-cliffs', clock: 'running', frames: 64, path: [ 'yaw', 0.25 ], gtDense: [ WINDOW ],
		about: 'the sea under a pan (15 degrees a second)' },
	// weather
	'storm': { view: 'island-storm', clock: 'running', frames: 64, path: [ 'still' ], gtDense: [ WINDOW ],
		about: 'a storm: rain streaks, whitecaps, foam and spray' },
	'rain': { view: 'island-rain', clock: 'running', frames: 64, path: [ 'still' ], gtDense: [ WINDOW ],
		about: 'rain streaks, ripples and splashes' },
	'lightning': { view: 'horizon-storm', clock: 'running', frames: 64, path: [ 'still' ], at: STRIKE_AT_30, gtDense: [ [ 26, 40 ] ],
		about: 'a storm with a strike forced in front of the camera at frame 30' },
	'night': { view: 'island-night-clear', clock: 'running', frames: 64, path: [ 'yaw', 0.05 ],
		about: 'a moonlit night under a slow pan: stars and dark detail' },
	// the clip names its crops: the horizon's stars are no crop of the view's rest image
	'night-still': { view: 'night-moon', clock: 'running', frames: 64, path: [ 'still' ], crops: [ 'stars-horizon', 'stars' ],
		about: 'the night sky over a still camera: the low stars\' scintillation, which a temporal resolve must not average away' },
	'fog': { view: 'island-fog-dawn', clock: 'running', frames: 64, path: [ 'yaw', 0.05 ], gtDense: [ WINDOW ],
		about: 'sea fog at dawn under a slow pan' },
	// render scale and light
	'drs-steps': { view: 'island-fair-noon', clock: 'running', frames: 120, path: [ 'still' ],
		scale: [ [ 0.8, 40 ], [ 0.6, 40 ], [ 0.8, 40 ] ], gtDense: [ [ 36, 44 ], [ 76, 84 ] ], lead: 32,
		about: 'the render scale stepped to 0.8 -> 0.6 -> 0.8 of the nominal ratio, 40 frames each, a still camera, after 32 lead frames at the first scale' },
	'sun-shadow': { view: 'meadow-close', clock: 'running', frames: 64, q: 'dayLength=600', path: [ 'still' ], setup: WIND_FREEZE,
		about: 'a fast day (600 s) under a still camera: the sun map steps and cross-fades as the sun moves' },
};

export const CLIP_GROUPS = [ 'all', 'normal', 'special' ];

export function clipNames( group = 'all' ) {

	if ( ! CLIP_GROUPS.includes( group ) ) throw new Error( `unknown clip group ${ group } (${ CLIP_GROUPS.join( ', ' ) })` );
	return Object.keys( CLIPS ).filter( ( c ) => ( VIEWS[ CLIPS[ c ].view ].special === true ) === ( group === 'special' ) );

}

// The anti-aliasing baseline's entries per quality tier (tools/kit/parity/baseline.mjs): on high
// every view at rest (the parked weathers' too, run only when named), the views of the default
// group also as whole frames (for the overall fidelity gate), and the gates' clips; on medium and
// low six views at rest. Medium and low are parked (packages/render/Quality.ts PARKED_QUALITY).
// The views every lower tier keeps at rest: the meadow near and far, the flowers, the island, the
// sea's glints and horizon, the night sky.
const TIER_VIEWS = [ 'meadow-close', 'meadow-24', 'flowers-close', 'island-fair-noon', 'horizon-fair-noon', 'night-moon' ];
// the gates' clips: [ clip, view or null for the clip's own ]
const GATE_CLIPS = [
	[ 'pan-slow', null ], [ 'pan-slow', 'island-fair-noon' ], [ 'pan-fast', null ], [ 'flick', null ], [ 'zoom', null ],
	[ 'islander-walk', null ], [ 'islander-orbit', null ], [ 'wind-still', null ], [ 'sea-still', null ], [ 'sea-pan', null ],
	// the still sea also facing a low sun: the glints' sparkle (the only view with a sea-glints crop by day)
	[ 'sea-still', 'cliff-sea-golden' ],
	// the night clip on the moon view: its stars, moon limb and moonlit glints under the pan
	[ 'storm', null ], [ 'rain', null ], [ 'lightning', null ], [ 'night', 'night-moon' ], [ 'fog', null ],
	// the low stars' scintillation under a still camera (the pan's twinkle is pixel phase)
	[ 'night-still', null ],
];
export const BASELINE_PLAN = {
	high: { rest: Object.keys( VIEWS ), full: Object.keys( VIEWS ).filter( ( v ) => ( VIEWS[ v ].group ?? 'parity' ) === 'parity' ), clips: GATE_CLIPS },
	medium: { rest: TIER_VIEWS, full: [], clips: [] },
	low: { rest: TIER_VIEWS, full: [], clips: [] },
};

// The carry-over's spot checks (tools/kit/parity/carry.mjs): a camera move over the meadow (paused
// clock) and the islander walking under the running clock (the walk, the wind in the meadow
// behind); the rest views whose ground truth is checked, the first one stored taken.
export const CARRY_SPOT = { clips: [ 'pan-slow', 'islander-walk' ], gtViews: [ 'island-fair-noon', 'meadow-close', 'meadow-24', 'flowers-close', 'rim-sea' ] };

// The ground truth's frames: every frame of a clip of up to 60 frames, else
// every 4th, plus the clip's `gtDense` runs [ first, last ] where a gate reads single frames or
// consecutive pairs (the flick's stop and recovery, the strike, the scale steps, the window of the
// crawl, wind, rain and fog instability and of the trails and lag). F, Vown and the other metrics
// of a side's own frames use all of its frames; only those against the GT are limited to these.
export const GT_DENSE_MAX = 60, GT_EVERY = 4;
export function gtSampling( clip, frames = clip.frames ) {

	if ( frames <= GT_DENSE_MAX ) return { every: 1, dense: [] };
	return { every: GT_EVERY, dense: ( clip.gtDense ?? [] ).filter( ( [ a ] ) => a < frames ).map( ( [ a, b ] ) => [ a, Math.min( b, frames - 1 ) ] ) };

}

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

/** Page code that installs `window.__PONLAI_CLIP__` = { camera( i ), frames, lead, clock, dt, scale } for
 * the clip, from the camera's current pose (run it after the view's eval); `scale` holds absolute
 * render ratios, one per frame. `setup` is page code of the caller's, run after the clip's own. */
export function clipEval( name, { frames, dt = 1 / 60, setup = '' } = {} ) {

	const clip = CLIPS[ name ];
	if ( ! clip ) throw new Error( `unknown clip ${ name }` );
	const [ kind, ...args ] = clip.path;
	return `(async () => { const s = window.${ PAGE.handle }; const dt = ${ dt };
window.${ PAGE.clipNotes } = [];
${ clip.setup ?? '' }
${ setup }
${ PATHS }
const path = PATH[ ${ JSON.stringify( kind ) } ]( ...${ JSON.stringify( args ) } );
window.${ PAGE.clip } = { name: ${ JSON.stringify( name ) }, frames: ${ frames ?? clip.frames }, lead: ${ clip.lead ?? 0 }, clock: ${ JSON.stringify( clip.clock ) }, dt,
	scale: ( ( shares ) => {
		if ( ! shares ) return null;
		if ( typeof s.nominalScale !== 'function' ) throw new Error( 'this build has no ${ PAGE.handle }.nominalScale for the scale schedule of the clip' );
		const nominal = s.nominalScale();
		return shares.map( ( k ) => k * nominal );
	} )( ${ JSON.stringify( clipScales( clip ) ) } ),
	camera: ( i ) => { path( i ); ${ clip.at ?? '' } } };
})()`;

}

if ( process.argv[ 1 ] && path.resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url ) ) {

	const [ cmd, name ] = process.argv.slice( 2 );
	if ( cmd === 'list' ) console.log( clipNames( name ).join( '\n' ) );
	else if ( cmd === 'show' && CLIPS[ name ] ) console.log( JSON.stringify( { ...CLIPS[ name ], viewQuery: VIEWS[ CLIPS[ name ].view ].q, gt: gtSampling( CLIPS[ name ] ) }, null, 2 ) );
	else if ( cmd === 'eval' && CLIPS[ name ] ) console.log( clipEval( name ) );
	else { console.error( 'usage: node clips.mjs list [all|normal|special] | show <clip> | eval <clip>' ); process.exitCode = 2; }

}
