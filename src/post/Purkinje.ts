import * as THREE from 'three/webgpu';
import { Fn, uniform, vec3, float, dot, max, mix, inverseSqrt } from 'three/tsl';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

// Night vision: the Purkinje shift as the rods take over from the cones in dim light. Colours
// lean toward blue and the eye's own blue-green sensitivity, the way a moonlit scene looks
// rather than a darker day. Implemented after Jasmin Patry, "Real-Time Samurai Cinema"
// (SIGGRAPH 2021 Advances in Real-Time Rendering, slides 160-168), which models the rods' input
// to the cone pathways as a delta in opponent colour space following D. Cao et al., "Rod
// contributions to color perception: linear with rod contrast" (Vision Research 48, 2008) and
// A. G. Kirk and J. F. O'Brien, "Perceptually based tone mapping for low-light conditions"
// (SIGGRAPH 2011). No code is copied; the receptor matrix below is our own fit.

// Rec.709 linear RGB to peak-normalised receptor excitations. Each row is a least-squares fit of
// a CVRL receptor curve to the CIE 1931 colour matching functions (380 - 780 nm), mapped through
// the Rec.709 primaries: the Stockman & Sharpe (2000) 2-degree L, M and S cone fundamentals and
// the CIE 1951 scotopic luminosity V'(lambda) for the rods. The rods' fitted red weight (slightly
// negative, an artefact of fitting V' with the cone space) is clamped to zero.
const LMS_FROM_RGB = new THREE.Matrix3().set(
	0.28995, 0.69727, 0.07638,
	0.09047, 0.70737, 0.11220,
	0.01385, 0.05371, 0.50978,
);
const ROD_FROM_RGB = new THREE.Vector3( 0, 0.54441, 0.36003 );

// Cao et al.'s constants as Patry quotes them: maximal cone sensitivity m, rod input strength k
// into the L, M and S pathways, the scaling constant K, static saturation S, the opponent
// surround strength k3, the ratio of responses to white light rw and the L cones' weight p.
const m = [ 0.63721, 0.39242, 1.6064 ];
const k = [ 0.2, 0.2, 0.29 ];
const K = 45, S = 10, k3 = 0.6, rw = 0.139, p = 0.6189;

// Rods' effect in opponent space (red-green, blue-yellow, luminance) per unit gain-controlled
// rod signal, delta o = ( K / S ) N diag( k ) diag( m )^-1 g q_R, and back to RGB through the
// opponent transform A and the cone matrix: delta c = LMS^-1 A^-1 delta o.
const N = new THREE.Matrix3().set(
	- ( k3 + rw ), 1 + k3 * rw, 0,
	p * k3, ( 1 - p ) * k3, 1,
	p * S, ( 1 - p ) * S, 0,
);
const A = new THREE.Matrix3().set(
	- 1, 1, 0,
	- 1, - 1, 1,
	1, 1, 0,
);
const RGB_FROM_ROD = LMS_FROM_RGB.clone().invert()
	.multiply( A.clone().invert() )
	.multiply( N )
	.multiply( new THREE.Matrix3().set( k[ 0 ] / m[ 0 ], 0, 0, 0, k[ 1 ] / m[ 1 ], 0, 0, 0, k[ 2 ] / m[ 2 ] ) )
	.multiplyScalar( K / S );

// The hue colours fade toward in rod vision: white nudged along the rods' shift, scaled so that
// its rod signal is 1.
const ROD_HUE = new THREE.Vector3( 1, 1, 1 ).applyMatrix3( RGB_FROM_ROD ).multiplyScalar( 0.01 ).addScalar( 1 );
ROD_HUE.divideScalar( ROD_HUE.dot( ROD_FROM_RGB ) );

const lmsFromRgb = uniform( LMS_FROM_RGB );
const rgbFromRod = uniform( RGB_FROM_ROD );

/**
 * Night vision for a scene-linear `color`. `retina` converts it to retinal illuminance in trolands,
 * so the cones' gain control decides how far the rods take over: fully in starlight, fading
 * through the mesopic range, not at all in daylight. Where they do, colours lose some of their
 * saturation (the cones' share of the signal falls) and the rods add Cao's blue-leaning shift.
 * `strength` scales that shift, whose constants describe an eye adapted to the stimulus, to the
 * subtle tint the art direction wants; `desaturation` is the saturation lost in full rod vision.
 * Both scale with each pixel's own light, so black stays black: no veil over the frame.
 */
export const nightVision = Fn( ( [ color, retina, strength, desaturation ]: [ V3, F, F, F ] ) => {

	const c = max( color, vec3( 0 ) ).toVar();
	const rod = dot( c, vec3( ROD_FROM_RGB.x, ROD_FROM_RGB.y, ROD_FROM_RGB.z ) ).toVar();
	const cones = lmsFromRgb.mul( c ).toVar();
	// Patry's multiplicative gain control g = ( 1 + 0.33 / m ( q + k q_R ) ) ^ -1/2, in trolands:
	// near 1 in the dark, falling toward 0 as the cones take the light.
	const q = cones.add( vec3( ...k ).mul( rod ) ).mul( retina );
	const gain = inverseSqrt( float( 1 ).add( vec3( 0.33 / m[ 0 ], 0.33 / m[ 1 ], 0.33 / m[ 2 ] ).mul( q ) ) ).toVar();
	// Toward the rods' own blue-grey at the rods' brightness rather than the cones': blues and
	// greens keep their lightness, reds sink as they do at dusk, and a blue night sky does not
	// fade to grey.
	const muted = mix( c, vec3( ROD_HUE.x, ROD_HUE.y, ROD_HUE.z ).mul( rod ), gain.y.mul( desaturation ) );
	return muted.add( rgbFromRod.mul( gain ).mul( rod.mul( strength ) ) );

} ).setLayout( { name: 'nightVision', type: 'vec3', inputs: [
	{ name: 'color', type: 'vec3' }, { name: 'retina', type: 'float' },
	{ name: 'strength', type: 'float' }, { name: 'desaturation', type: 'float' },
] } );
