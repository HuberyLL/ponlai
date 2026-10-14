import * as THREE from 'three/webgpu';
import { Fn, If, dot, exp, float, max, min, smoothstep, sqrt, uniform, vec2 } from 'three/tsl';
import { pnoise } from '../materials/ProceduralTextures.ts';
import { DayCycle } from '../sky/DayCycle.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

// Grass blades are narrower than a sun-shadow texel, so the meadow does not cast into the sun's
// shadow map: as the sun turns, re-rasterising sub-texel blades reshuffles their whole shadow
// pattern at every map update. Larger casters (rock, bushes, flowers, figures) keep the map.
// Shadowing inside the meadow is instead the light that survives the canopy above a point on
// its way to the key light. Gaps are sampled where that ray leaves the canopy, so blades and the
// turf below share one dapple field, and it slides with the sun only as far as that exit point.
export const meadowCanopy = {
	density: uniform( 5 ), // extinction per metre of canopy along the ray
	gapScale: uniform( 12 ), // dapple frequency across the light, per metre
	contrast: uniform( 1 ), // 0: uniform canopy, 1: fully open gaps
	softness: uniform( 0.25 ), // width of the gap edges in noise units
	stretch: uniform( 2 ), // elongation along the light's azimuth per unit of shadow length
	// The gap field's frame: xy, the light's azimuth; z, the squeeze along it (trackMeadowCanopy).
	frame: uniform( new THREE.Vector3( 1, 0, 1 ) ),
	nextFrame: uniform( new THREE.Vector3( 1, 0, 1 ) ),
	fade: uniform( 0 ), // weight of nextFrame, at most 0.5
};

// Blade shadows lengthen along the sun's azimuth as it sinks, so the gaps stretch the same way.
// That frame turns and squeezes about the world origin, though: following the key every frame
// swept the whole dapple field across the meadow, tens of times faster than real blade shadows
// far from the origin. The frame instead holds still at fixed steps along the key's path and
// cross-fades into the next one halfway between them, so the gaps stay rooted in the ground.
const STEP = Math.PI * 2 / 60; // 6 degrees along the path: 48 s of the default day
const FADE = 0.5; // the share of each step spent cross-fading, at a steady rate

// The day cycle moves the sun, the moon and so the key along one great circle: its noon (hour
// angle 0) and its 18:00 direction (a quarter turn on) span it.
const pathAt = ( hour: number ) => new DayCycle( { hour } ).snapshot().sunDir;
const PATH_X = pathAt( 12 ), PATH_Y = pathAt( 18 ), PATH_N = PATH_X.clone().cross( PATH_Y );
const stepKey = new THREE.Vector3();

function frameOf( key: THREE.Vector3, target: THREE.Vector3 ): THREE.Vector3 {

	const flat = Math.hypot( key.x, key.z ), rise = Math.max( key.y, 0.12 );
	const along = 1 / ( 1 + Math.min( flat / rise, 3 ) * meadowCanopy.stretch.value );
	return flat > 1e-4 ? target.set( key.x / flat, key.z / flat, along ) : target.set( 1, 0, along );

}

function frameAtStep( step: number, target: THREE.Vector3 ): THREE.Vector3 {

	const a = step * STEP;
	return frameOf( stepKey.copy( PATH_X ).multiplyScalar( Math.cos( a ) ).addScaledVector( PATH_Y, Math.sin( a ) ), target );

}

/** Follow the key light (unit vector toward it). A function of the key alone, so a paused frame
 * repeats exactly. A light placed off the day's path (the GUI's manual sun) is followed directly. */
export function trackMeadowCanopy( key: THREE.Vector3 ): void {

	const c = meadowCanopy;
	if ( Math.abs( key.dot( PATH_N ) ) > 1e-4 ) {

		frameOf( key, c.frame.value );
		c.fade.value = 0;
		return;

	}

	const u = Math.atan2( key.dot( PATH_Y ), key.dot( PATH_X ) ) / STEP, k = Math.floor( u );
	const w = THREE.MathUtils.clamp( ( u - k - 0.5 ) / FADE + 0.5, 0, 1 );
	frameAtStep( k, w < 0.5 ? c.frame.value : c.nextFrame.value );
	frameAtStep( k + 1, w < 0.5 ? c.nextFrame.value : c.frame.value );
	c.fade.value = Math.min( w, 1 - w );

}

const PERIOD = vec2( 4096 );

const gapNoise = Fn( ( [ exit, frame, gapScale ]: [ V2, V3, F ] ) => {

	const along = dot( exit, frame.xy ).mul( frame.z );
	const across = dot( exit, vec2( frame.y.negate(), frame.x ) );
	const q = vec2( along, across ).mul( gapScale ).toVar();
	return pnoise( q, PERIOD ).mul( 0.55 )
		.add( pnoise( q.mul( 2.7 ).add( 17.1 ), PERIOD ).mul( 0.3 ) )
		.add( pnoise( q.mul( 6.1 ).sub( 5.3 ), PERIOD ).mul( 0.15 ) );

} ).setLayout( { name: 'ponlaiMeadowGaps', type: 'float', inputs: [
	{ name: 'exit', type: 'vec2' }, { name: 'frame', type: 'vec3' }, { name: 'gapScale', type: 'float' },
] } );

// Uniforms reach a layout function only as arguments.
const canopyLight = Fn( ( [ xz, depth, key, density, gapScale, contrast, softness, frame, nextFrame, fade ]: [ V2, F, V3, F, F, F, F, V3, V3, F ] ) => {

	// Grazing light crosses at most this much canopy; beyond it the key is dark anyway.
	const rise = max( key.y, 0.12 );
	const reach = min( max( depth, 0 ).div( rise ), 2.5 ).toVar();
	const exit = xz.add( key.xz.mul( reach ) ).toVar();
	const gaps = gapNoise( exit, frame, gapScale ).toVar();
	// The second field costs a lookup only while fading. Blending with weights normalised to
	// unit length keeps the noise's spread, so the gaps do not soften halfway through.
	If( fade.greaterThan( 0 ), () => {

		const b = gapNoise( exit, nextFrame, gapScale );
		gaps.assign( gaps.mul( float( 1 ).sub( fade ) ).add( b.mul( fade ) )
			.div( sqrt( float( 1 ).sub( fade ).pow( 2 ).add( fade.pow( 2 ) ) ) ) );

	} );
	const open = smoothstep( softness.negate().mul( 0.5 ), softness.mul( 0.5 ), gaps ).mul( contrast );
	return exp( density.negate().mul( reach ).mul( float( 1 ).sub( open ) ) );

} ).setLayout( { name: 'ponlaiMeadowCanopy', type: 'float', inputs: [
	{ name: 'xz', type: 'vec2' }, { name: 'depth', type: 'float' }, { name: 'key', type: 'vec3' },
	{ name: 'density', type: 'float' }, { name: 'gapScale', type: 'float' }, { name: 'contrast', type: 'float' },
	{ name: 'softness', type: 'float' }, { name: 'frame', type: 'vec3' }, { name: 'nextFrame', type: 'vec3' },
	{ name: 'fade', type: 'float' },
] } );

// Light transmitted to a point `depth` metres below the canopy top at `xz`. `key` is the unit
// direction toward the light. Uses no textures or derivatives, so it is safe inside branches.
export function meadowCanopyLight( xz: V2, depth: F, key: V3 ): F {

	const c = meadowCanopy;
	return canopyLight( xz, depth, key, c.density, c.gapScale, c.contrast, c.softness, c.frame, c.nextFrame, c.fade );

}

// A tuft's top stands CANOPY_TOP times its height scale above its root (plantGrass). The canopy's
// depth above the turf is one value for the whole meadow: about the mean tuft top at the growth
// field's middle. The turf once took the local mean
// tuft height from the growth field, so where the sward grew tall the light under it fell off
// with exp( -density * depth / sun height ): ~4 m dark drifts in the sun that no blade outlined,
// worst at golden hour, and brighter pockets where the soil pockets cut the height. With one
// depth the turf's shade varies with the sun's height alone (as a low sun lengthens every ray
// through the sward) and with the gaps' pattern. A blade takes this depth scaled by its share of
// the way down its own tuft (Grass.ts), so its root meets the turf's shade and tall and short
// tufts shade alike; the flowers, which stand in the sward, take their depth below its top.
export const CANOPY_TOP = 0.8;
export const TURF_CANOPY_DEPTH = 0.2;
