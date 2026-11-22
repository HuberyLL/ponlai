import * as THREE from 'three/webgpu';
import { If, Loop, float, int, uniform, uniformArray, dot, max, min, length, clamp, select } from 'three/tsl';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

// The shadows of what swims in the water on what lies under it.
//
// The refracted sun's map (RefractedSun.ts) is drawn only when the sun turns, so a swimmer moving
// over the floor cannot go into it. Each frame the creatures that cast a shadow worth drawing
// (the island's sea life chooses them: life/SeaLife.ts) are handed over as capsules, a segment and
// a radius each, at most SWIMMER_SHADOWS, and every point lit under the water (Underwater.ts) tests
// the refracted key's ray from it toward the surface against them: the body over the ray takes
// that share of the key. A ray of a few-metre body over sand at a few metres' depth casts as clear a
// shadow as it does in clear water; the analytic test is the cheap way to draw a few such
// occluders, as games draw capsule shadows for characters.
//
// The penumbra: the water's particles scatter the beam forward by a small angle (shared.ts
// `forwardAngle`, rms along one axis), so a shadow h metres below the body is blurred over about
// 2 forwardAngle h, beside which the sun's own half a degree is small. Across the ray the body's
// cover is that of a band 2r wide blurred by a box of that width: a body high over the floor casts
// only a faint, wide shadow, a body near it a sharp one. Only the key is shaded: the light the
// water scatters in from every side keeps reaching under a swimmer.

/** The most swimmers casting a shadow at once. */
export const SWIMMER_SHADOWS = 12;

export interface SwimmerShadowUniforms {
	// per swimmer two vec4: ( one end, radius ), ( the other end, the half-length plus the radius )
	capsules: THREE.UniformArrayNode<'vec4'>;
	count: THREE.UniformNode<'int', number>;
	// the CPU's copy, written before each frame
	values: THREE.Vector4[];
}

/** The uniforms (shared.ts holds one set). */
export function createSwimmerShadows(): SwimmerShadowUniforms {

	const values = Array.from( { length: 2 * SWIMMER_SHADOWS }, () => new THREE.Vector4() );
	return { capsules: uniformArray( values, 'vec4' ) as unknown as THREE.UniformArrayNode<'vec4'>, count: uniform( 0, 'int' ) as unknown as THREE.UniformNode<'int', number>, values };

}

/** One swimmer's shadow: the segment's ends (world, m) and the body's radius (m). */
export interface SwimmerCapsule { ax: number; ay: number; az: number; bx: number; by: number; bz: number; r: number }

/** Hands this frame's casters over (at most SWIMMER_SHADOWS; the rest are left out). */
export function setSwimmerShadows( u: SwimmerShadowUniforms, list: readonly SwimmerCapsule[] ): void {

	const n = Math.min( list.length, SWIMMER_SHADOWS );
	for ( let k = 0; k < n; k ++ ) {

		const c = list[ k ];
		u.values[ 2 * k ].set( c.ax, c.ay, c.az, c.r );
		u.values[ 2 * k + 1 ].set( c.bx, c.by, c.bz, Math.hypot( c.bx - c.ax, c.by - c.ay, c.bz - c.az ) / 2 + c.r );

	}
	u.count.value = n;

}

/** The share of the key the swimmers leave at point `p`, its ray toward the light `L` (unit, up);
 * `spread` the blur's width per metre of height (2 forwardAngle). */
export function swimmerShade( u: SwimmerShadowUniforms, p: V3, L: V3, spread: F ): F {

	const lit = float( 1 ).toVar();
	// the ray's horizontal run per metre of rise
	const run = L.xz.div( max( L.y, 0.05 ) ).toVar();
	Loop( u.count, ( { i } ) => {

		const a = u.capsules.element( int( i ).mul( 2 ) ), b = u.capsules.element( int( i ).mul( 2 ).add( 1 ) );
		// first the cheap test most points fail: where the body's centre shades at this point's
		// height, against how far its shadow reaches round that (its half-length and radius, its
		// ends' rise stretched along the ray's run, and the blur's half-width at that height)
		const centre = a.xyz.add( b.xyz ).mul( 0.5 );
		const rise = centre.y.sub( p.y );
		const off = p.xz.sub( centre.xz.sub( run.mul( rise ) ) );
		const reach = b.w.add( b.y.sub( a.y ).abs().mul( 0.5 ).mul( length( run ) ) ).add( rise.mul( spread ).mul( 0.5 ) ).add( 0.05 );
		If( rise.greaterThan( 0 ).and( dot( off, off ).lessThan( reach.mul( reach ) ) ), () => {

			// the segment's ends seen along the ray: their offsets across it, and their heights along it
			const pa = a.xyz.sub( p ), pb = b.xyz.sub( p );
			const ha = dot( pa, L ), hb = dot( pb, L );
			const qa = pa.sub( L.mul( ha ) ), qb = pb.sub( L.mul( hb ) );
			// the segment's point nearest the ray across it
			const e = qb.sub( qa );
			const s = clamp( dot( qa, e ).negate().div( max( dot( e, e ), 1e-6 ) ), 0, 1 );
			const d = length( qa.add( e.mul( s ) ) );
			const h = ha.add( hb.sub( ha ).mul( s ) );
			// the band of half-width r blurred by a box of width w: its cover at d
			const r = a.w, w = max( h.mul( spread ), 0.02 );
			const cover = clamp( min( r, d.add( w.mul( 0.5 ) ) ).sub( max( r.negate(), d.sub( w.mul( 0.5 ) ) ) ).div( w ), 0, 1 );
			// only a body above the point shades it
			lit.mulAssign( float( 1 ).sub( select( h.greaterThan( 0 ), cover, float( 0 ) ) ) );

		} );

	} );
	return lit;

}
