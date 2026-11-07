import * as THREE from 'three/webgpu';
import { Fn, clamp, float, max, mod, vec2, vec3 } from 'three/tsl';
import { perlin3 } from '../materials/CloudNoise.ts';
import { GUST_EVOLUTION, GUST_TIME_PERIOD, type WindUniforms } from './Wind.ts';
import { tune } from '../debug/Tune.ts';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

// The fog layer's drift (VolumetricHaze.ts, the light kernel): the fog layer's density times a
// noise of mean 1, so the fog thins and thickens in patches that the wind carries over the island
// and that slowly change their shape.
//
// - The field: two octaves of Perlin noise (CloudNoise.ts `perlin3`), the second at twice the
//   frequency and 0.3 of the weight, in cells `scale` metres across ( 60 - 150 m; 60 by default:
//   the management view spans about two hundred metres of sea, and at 100 m it held one or two
//   patches, read as the whole frame thinning and thickening rather than as patches), scaled by FIELD_GAIN
//   so that its 1st and 99th percentiles are about -1 and 1 (the two octaves' sum alone has a
//   standard deviation of 0.168 and those percentiles at -0.384 and 0.384, measured over 400 000
//   points of a period). `amplitude` (0 - 1, 1) scales it about 1, clamped at 0. Its mean over
//   the sampled air is not exactly 1 (the field's own mean over a few patches, the clamp): the
//   light kernel divides it by its mean over the view (VolumetricHaze.ts `driftKernel`), so the
//   frame's mean opacity holds as the patches pass.
// - Its motion: the field moves with the air (Wind.ts `displacement`, the weather's integrated
//   travel, never time * a speed) and evolves along its height axis at FOG_EVOLUTION cells a
//   second, an integrated time taken from the gusts' (Wind.ts `gustTime`, GUST_EVOLUTION cells a
//   second modulo GUST_TIME_PERIOD), so both are functions of the scene clock and the weather, held
//   when the wind is frozen. The field repeats every FOG_PERIOD cells on every axis, which is where
//   the evolution's time wraps with the gusts' (GUST_TIME_PERIOD x FOG_EVOLUTION / GUST_EVOLUTION),
//   and the travel is taken modulo FOG_PERIOD cells, so neither wrap shows and the travel keeps its
//   digits.
// - Far slices are kilometres deep: one sample of a 60 m field there is noise of its own, which
//   flickers as the field moves. The amplitude fades out as a slice's length grows from half a cell
//   to one and a half (`fade`), so the far fog keeps its mean.

/** The field's evolution, cells a second (a patch reshapes within about 1 / FOG_EVOLUTION s). */
export const FOG_EVOLUTION = 0.02;
/** The field's period in cells on every axis, where the evolution's time wraps. */
export const FOG_PERIOD = GUST_TIME_PERIOD * FOG_EVOLUTION / GUST_EVOLUTION;

/** The knobs: the cell's size (metres) and the amplitude (`haze.fog.noiseScale`,
 * `haze.fog.noiseAmp`). */
export const FOG_NOISE = {
	scale: tune( 'haze.fog.noiseScale', 60, { min: 60, max: 150, scale: 'log' } ),
	amplitude: tune( 'haze.fog.noiseAmp', 1, { min: 0, max: 1 } ),
};

// the field's gain (see above)
const FIELD_GAIN = 2.6;

// the field at p (cells), about -1 .. 1, repeating every `period` cells
const fogField = Fn( ( [ p, period ]: [ V3, F ] ) => {

	const a = perlin3( p, period );
	const b = perlin3( p.mul( 2 ).add( vec3( 17, 5, 9 ) ), period.mul( 2 ) );
	return a.mul( 0.7 ).add( b.mul( 0.3 ) ).mul( FIELD_GAIN );

} ).setLayout( { name: 'fogField', type: 'float', inputs: [ { name: 'p', type: 'vec3' }, { name: 'period', type: 'float' } ] } );

/** The drift's factor (mean about 1, never below 0) at the world point `p`, for a slice `length`
 * metres deep; `noise` holds the cell's size (m) and the amplitude, `wind` the weather's wind. The
 * caller divides it by its mean over the view. */
export function fogDrift( p: V3, length: F, noise: THREE.Node<'vec2'>, wind: WindUniforms ): F {

	const scale = noise.x;
	const travel = mod( wind.displacement, vec2( FOG_PERIOD ).mul( scale ) );
	const time = wind.gustTime.mul( FOG_EVOLUTION / GUST_EVOLUTION );
	const q = vec3( p.x.sub( travel.x ), p.y, p.z.sub( travel.y ) ).div( scale ).add( vec3( 0, time, 0 ) );
	const fade = clamp( float( 1.5 ).sub( length.div( scale ) ), 0, 1 );
	return max( fogField( q, float( FOG_PERIOD ) ).mul( noise.y.mul( fade ) ).add( 1 ), 0 );

}
