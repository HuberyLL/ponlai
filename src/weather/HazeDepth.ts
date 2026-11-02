// The haze's medium in closed form, apart from the haze (VolumetricHaze.ts, whose header describes
// the medium), so that a reader built before the haze can share it:
//   - `meanExtinction`: the medium's mean density over a span of heights, so an optical depth is a
//     ray's length times it;
//   - `nearFactor` and `nearLength`: the weather's thinner near haze on a ray's depth.
// Rays here are straight and climb with the direction's y alone, as the haze's surfaces take them
// (VolumetricHaze.ts `skyHaze`).

import type * as THREE from 'three/webgpu';
import { Fn, exp, float, max, min, select, smoothstep, sqrt } from 'three/tsl';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

// (1 - e^-x) / x, the share of a slab of optical depth x that scatters, per unit of that depth, with
// its series near 0 (where the difference loses its digits)
export const expShare = Fn( ( [ x ]: [ F ] ) => {

	const series = float( 1 ).sub( x.mul( 0.5 ) ).add( x.mul( x ).div( 6 ) );
	return select( x.lessThan( 1e-3 ), series, float( 1 ).sub( exp( x.negate() ) ).div( max( x, 1e-30 ) ) );

} ).setLayout( { name: 'hazeExpShare', type: 'float', inputs: [ { name: 'x', type: 'float' } ] } );

// The medium's mean density (1/m, before each band's sigma) over the heights between a and b
// (metres, either order; below the sea it holds its value at sea level, which only rays hidden
// under the water reach): the exponential layer (density at sea level, scale height) and the ground
// layer (rho_f, top, width). An optical depth is a ray's length times the mean over the heights it
// spans.
export const meanExtinction = Fn( ( [ a0, b0, layer, ground ]: [ F, F, V2, V3 ] ) => {

	const a = max( min( a0, b0 ), 0 ).toVar();
	const b = max( max( a0, b0 ), 0 ).toVar();
	const span = b.sub( a ).toVar();
	const exponential = ( l: V2 ) => l.x.mul( exp( a.div( l.y ).negate() ) ).mul( expShare( span.div( l.y ) ) );
	// the ground layer's weight 1 - u / r integrates to u - r, r = sqrt( u^2 + w^2 ); its mean,
	// written so that no difference cancels: 1 - ( ua + ub ) / ( ra + rb )
	const ua = a.sub( ground.y ).toVar(), ub = b.sub( ground.y ).toVar();
	const w2 = ground.z.mul( ground.z );
	const r = sqrt( ua.mul( ua ).add( w2 ) ).add( sqrt( ub.mul( ub ).add( w2 ) ) );
	const weight = float( 1 ).sub( ua.add( ub ).div( max( r, 1e-6 ) ) );
	return exponential( layer ).add( ground.x.mul( weight ) );

} ).setLayout( { name: 'hazeMeanExtinction', type: 'float', inputs: [
	{ name: 'a0', type: 'float' }, { name: 'b0', type: 'float' }, { name: 'layer', type: 'vec2' }, { name: 'ground', type: 'vec3' },
] } );

// The near haze's factor on the optical depth from the camera out to t metres ( k, d0, d1 ): k up
// to d0, a smoothstep back to 1 at d1, then 1. Written 1 - ( 1 - k )( 1 - s ), it is 1 exactly past d1
// and with k = 1, so those rays keep their depth to the bit.
export const nearFactor = Fn( ( [ t, near ]: [ F, V3 ] ) => {

	return float( 1 ).sub( float( 1 ).sub( near.x ).mul( float( 1 ).sub( smoothstep( near.y, max( near.z, near.y.add( 1e-3 ) ), t ) ) ) );

} ).setLayout( { name: 'hazeNearFactor', type: 'float', inputs: [ { name: 't', type: 'float' }, { name: 'near', type: 'vec3' } ] } );

// A whole ray's length out to t as the near haze weighs it: its optical depth is this times the far
// mean density over the heights it spans.
export const nearLength = ( t: F, near: V3 ): F => t.mul( nearFactor( t, near ) );

