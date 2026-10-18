import * as THREE from 'three/webgpu';
import { attribute, float, mix, normalGeometry, positionGeometry, smoothstep, vec3 } from 'three/tsl';
import { GroundBounceLightingModel } from '../lighting/GroundBounce.ts';
import type { Shared } from '../shared.ts';
import { debugFlags } from '../debug/DebugFlags.ts';
import { hash3i, mulberry32, type Rng } from './noise.ts';
import { leafFlutter, mainBend } from './vegetation/Deform.ts';
import { useVegetationMotion } from './vegetation/Material.ts';
import type { VegetationKind } from './vegetation/Registry.ts';

// The yunpeng (芸蓬) of Yuanjiao: "a grass named yunpeng, white as snow, a stem two zhang long; seen
// at night it gives a white light; it makes a staff" (Wang Jia, Shiyi ji, book 10). Yuanjiao and
// Daiyu drifted to the north pole and sank (Liezi, Tangwen); here a stand of its grass lives on.
// It grows where the sea wind is strongest and nothing else stands, on the turf at the windward
// cliff's edge: a clump for every 7 m of the starting island's coast that faces the wind
// (IslandGrowth.ts startYunpeng), a seed fixing them as the land grows round them.
//
// Its form, after the tall herbaceous stalks of giant reed and giant fennel (a grass two zhang high
// is a tall herb's stem, not a tree's trunk):
// - A clump of straight, slender stalks, snow white, from a foot's disc (YUNPENG.foot), each leaning
//   a little out from the clump and bowing over at its top; the first clump's tall, its tallest
//   about 5 m (two zhang), a second clump younger and lower (YUNPENG.height). A stalk is round,
//   thinning upward, a faint node every YUNPENG.internode (its colour), and stiff and straight
//   enough to cut a staff from.
// - Long, narrow leaves up its lower part (YUNPENG.leaves, YUNPENG.leafy), arching out and
//   drooping, white and greyer near the ground.
// - At the top a slim spindle of pale seed (YUNPENG.head) and round it a plume of fine tassels
//   arching out and hanging (YUNPENG.plume), the tangle of a 蓬.
// - White as snow: a high, slightly cool albedo, a waxy sheen; by night a faint white light of its
//   own (YUNPENG.glow, as emission, too faint to show by day; `flags=yunpengGlow:<strength>` at load
//   sets it for A/Bs).
// - It sways in the one wind from each stalk's foot, its top the most (Deform.ts mainBend at half
//   rate, a tall plant), each by its slenderness (`bendAt`), the leaves and the plume's tassels
//   fluttering from their foot as the gusts pass (Deform.ts leafFlutter).
// Every random choice of a clump draws from one stream seeded by where it stands. One mesh, one
// vegetation kind (an ordinary shadow, no depth prepass). It takes no part in the growth swap: the
// sites are the step-0 piece's and the ground is a function of the point.

export const YUNPENG = {
	stalks: [ 14, 9 ] as const, // stalks in the first clump and in each later one
	height: [ [ 3.2, 5 ], [ 2.2, 3.4 ] ] as const, // a stalk's height (m, the least and the most) in the first clump and the later
	foot: 0.4, // the clump's radius at the ground (m)
	radius: 0.017, // a 5 m stalk's radius at its foot (m)
	lean: [ 0.03, 0.14 ] as const, // a stalk's lean out from the clump (rad)
	bow: 0.25, // how far a 5 m stalk's top bows over (m)
	internode: 0.45, // between nodes (m)
	leaves: [ 5, 8 ] as const, // leaves a stalk carries, over its lower `leafy` share
	leafy: 0.65,
	leaf: [ 0.5, 0.95 ] as const, // a leaf's length (m)
	head: 0.3, // the seed spindle's length (m)
	plume: [ 12, 0.25, 0.45 ] as const, // the plume's tassels and their length (m, the least and the most)
	bend: 0.3, // a 5 m stalk's sway at its top (m at a fair day's typical gust)
	flutter: 0.03, // a leaf's flutter along its normal (m)
	glow: 0.0015, // the white light by night (emission, of the albedo)
};

// linear albedo: snow white, a little cool; greyer at the foot
const WHITE = [ 0.72, 0.74, 0.76 ], FOOT = [ 0.42, 0.44, 0.4 ];
const WIND = { cycles: 30, slow: 0.5, flutter: 2.2 } as const;

class Builder {

	readonly P: number[] = [];
	readonly N: number[] = [];
	readonly root: number[] = [];
	readonly sway: number[] = []; // x the bend's amplitude, y the flutter, z the phase, w the share of the plant's height
	readonly part: number[] = []; // 0 stalk, 1 leaf, 2 head
	readonly I: number[] = [];

	vertex( p: THREE.Vector3, n: THREE.Vector3, foot: THREE.Vector3, sway: number[], part: number ): number {

		this.P.push( p.x, p.y, p.z );
		this.N.push( n.x, n.y, n.z );
		this.root.push( foot.x, foot.y, foot.z );
		this.sway.push( ...sway );
		this.part.push( part );
		return this.P.length / 3 - 1;

	}

	geometry(): THREE.BufferGeometry {

		const g = new THREE.BufferGeometry();
		g.setAttribute( 'position', new THREE.Float32BufferAttribute( this.P, 3 ) );
		g.setAttribute( 'normal', new THREE.Float32BufferAttribute( this.N, 3 ) );
		g.setAttribute( 'yunpengRoot', new THREE.Float32BufferAttribute( this.root, 3 ) );
		g.setAttribute( 'yunpengSway', new THREE.Float32BufferAttribute( this.sway, 4 ) );
		g.setAttribute( 'yunpengPart', new THREE.Float32BufferAttribute( this.part, 1 ) );
		g.setIndex( new THREE.Uint32BufferAttribute( this.I, 1 ) );
		g.computeBoundingBox();
		g.computeBoundingSphere();
		// room for the sway
		g.boundingSphere!.radius += 0.6;
		g.name = 'yunpeng';
		return g;

	}

}

const UP = new THREE.Vector3( 0, 1, 0 );
const _n = new THREE.Vector3(), _b = new THREE.Vector3(), _p = new THREE.Vector3();

interface Stalk { foot: THREE.Vector3; height: number; out: THREE.Vector3; lean: number; bow: number; phase: number }

/** A stalk's axis at s (0 foot, 1 top): up, leaning out, bowing over at its top. */
function axisAt( k: Stalk, s: number, out: THREE.Vector3 ): THREE.Vector3 {

	const h = k.height;
	return out.copy( k.foot ).addScaledVector( k.out, s * h * Math.sin( k.lean ) + k.bow * s ** 2.5 ).add( _p.set( 0, s * h * Math.cos( k.lean ) - k.bow * 0.3 * s ** 4, 0 ) );

}

/** The bend's amplitude at s of a stalk (m at a fair day's typical gust): growing with the square of
 * the way up, and with the stalk's slenderness, as a cantilever's tip under the wind's load along it
 * (its drag on the stalk's width): the length to the fourth over the radius cubed, the radius
 * growing as the height to the 0.6 (`stalk`), so a 5 m stalk takes YUNPENG.bend and a shorter one
 * far less: the clump's stalks swing apart rather than as one. */
const bendAt = ( k: Stalk, s: number ) => YUNPENG.bend * Math.pow( k.height / 5, 4 - 3 * 0.6 ) * s * s;

/** One stalk: a tube from below the ground to the head's foot, then the head's spindle. */
function stalk( b: Builder, k: Stalk ): void {

	const sides = 7;
	const rings = Math.ceil( k.height / 0.12 );
	const r0 = YUNPENG.radius * Math.pow( k.height / 5, 0.6 );
	const headFrom = 1 - YUNPENG.head / k.height;
	const c = new THREE.Vector3(), next = new THREE.Vector3(), t = new THREE.Vector3();
	const first = b.P.length / 3;
	for ( let i = 0; i <= rings; i ++ ) {

		const s = i / rings;
		axisAt( k, s, c );
		axisAt( k, Math.min( 1, s + 0.01 ), next );
		t.subVectors( next, c ).normalize();
		if ( i === rings ) axisAt( k, s - 0.01, next ), t.subVectors( c, next ).normalize();
		_n.crossVectors( t, k.out ).normalize();
		_b.crossVectors( _n, t ).normalize();
		// thinning upward, then the head: swelling to a spindle and drawn to a point
		const h = Math.max( 0, ( s - headFrom ) / ( 1 - headFrom ) );
		const r = s < headFrom ? r0 * ( 1 - 0.5 * s ) : r0 * 0.5 * ( 1 + 1.6 * Math.sin( Math.PI * Math.min( h * 1.15, 1 ) ) ) * ( 1 - h ** 3 );
		for ( let j = 0; j < sides; j ++ ) {

			const a = j / sides * Math.PI * 2;
			const d = new THREE.Vector3().addScaledVector( _n, Math.cos( a ) ).addScaledVector( _b, Math.sin( a ) );
			const p = c.clone().addScaledVector( d, r );
			if ( i === 0 ) p.y -= 0.08;
			b.vertex( p, d, k.foot, [ bendAt( k, s ), 0, k.phase, s ], s < headFrom ? 0 : 2 );

		}

	}
	for ( let i = 0; i < rings; i ++ ) for ( let j = 0; j < sides; j ++ ) {

		const a = first + i * sides + j, bb = first + i * sides + ( j + 1 ) % sides, cc = a + sides, d = bb + sides;
		b.I.push( a, cc, bb, bb, cc, d );

	}

}

/** A leaf from s along a stalk (or a plume's tassel, `wide` of a leaf's width): a narrow ribbon
 * arching out and drooping (a quadratic curve), in `dir`, drawn on both sides. */
function leaf( b: Builder, k: Stalk, s: number, dir: THREE.Vector3, length: number, rng: Rng, wide: number ): void {

	const base = axisAt( k, s, new THREE.Vector3() );
	const rise = 0.3 + 0.2 * rng(), droop = 0.25 + 0.25 * rng();
	const mid = base.clone().addScaledVector( dir, 0.45 * length ).addScaledVector( UP, rise * length );
	const tip = base.clone().addScaledVector( dir, 0.85 * length ).addScaledVector( UP, ( rise - droop ) * length );
	const curve = new THREE.QuadraticBezierCurve3( base, mid, tip );
	const across = new THREE.Vector3().crossVectors( UP, dir ).normalize();
	const segs = 8, width = 0.032 * wide * ( 0.8 + 0.4 * rng() ), phase = rng();
	const first = b.P.length / 3;
	const t = new THREE.Vector3(), n = new THREE.Vector3();
	for ( let i = 0; i <= segs; i ++ ) {

		const u = i / segs;
		const p = curve.getPoint( u );
		curve.getTangent( u, t );
		n.crossVectors( across, t ).normalize();
		const w = width * 0.5 * Math.sin( Math.PI * Math.min( 0.15 + u * 0.95, 1 ) ) * ( 1 - 0.85 * u );
		const share = s + ( p.y - base.y ) / k.height;
		for ( const side of [ - 1, 1 ] ) b.vertex( p.clone().addScaledVector( across, side * w ), n, k.foot, [ bendAt( k, s ), YUNPENG.flutter * u, phase, Math.max( share, 0 ) ], 1 );

	}
	for ( let i = 0; i < segs; i ++ ) {

		const a = first + i * 2;
		b.I.push( a, a + 2, a + 1, a + 1, a + 2, a + 3 );

	}

}

/** One clump at ( x, z ): the first clump's (`first`) taller and fuller. */
function clump( b: Builder, x: number, z: number, first: boolean, groundAt: ( x: number, z: number ) => number ): void {

	const P = YUNPENG;
	const rng = mulberry32( ( hash3i( Math.round( x * 4 ), Math.round( z * 4 ), 61 ) * 4294967296 ) >>> 0 );
	const count = P.stalks[ first ? 0 : 1 ], [ h0, h1 ] = P.height[ first ? 0 : 1 ];
	for ( let n = 0; n < count; n ++ ) {

		const a = rng() * Math.PI * 2, r = Math.sqrt( rng() ) * P.foot;
		const fx = x + Math.cos( a ) * r, fz = z + Math.sin( a ) * r;
		const out = new THREE.Vector3( Math.cos( a ), 0, Math.sin( a ) ).applyAxisAngle( UP, ( rng() - 0.5 ) * 0.8 );
		// the clump's middle stalks the tallest
		const height = h0 + ( h1 - h0 ) * ( 1 - 0.6 * r / P.foot ) * ( 0.75 + 0.25 * rng() );
		const k: Stalk = {
			foot: new THREE.Vector3( fx, groundAt( fx, fz ), fz ), height, out,
			lean: P.lean[ 0 ] + ( P.lean[ 1 ] - P.lean[ 0 ] ) * ( r / P.foot ) + ( rng() - 0.5 ) * 0.03,
			bow: P.bow * ( height / 5 ) * ( 0.5 + rng() ), phase: rng(),
		};
		stalk( b, k );
		const leaves = P.leaves[ 0 ] + Math.floor( rng() * ( P.leaves[ 1 ] - P.leaves[ 0 ] + 1 ) );
		for ( let l = 0; l < leaves; l ++ ) {

			const turn = rng() * Math.PI * 2;
			const along = 0.04 + ( P.leafy - 0.04 ) * ( l + rng() ) / leaves;
			leaf( b, k, along, new THREE.Vector3( Math.cos( turn ), 0, Math.sin( turn ) ), ( P.leaf[ 0 ] + ( P.leaf[ 1 ] - P.leaf[ 0 ] ) * rng() ) * ( 1 - 0.4 * along ), rng, 1 );

		}
		// the plume: fine tassels from the head's foot, arching out and hanging
		const [ tassels, t0, t1 ] = P.plume;
		for ( let l = 0; l < tassels; l ++ ) {

			const turn = ( l + rng() ) / tassels * Math.PI * 2;
			leaf( b, k, 1 - P.head / height * ( 0.3 + 0.5 * rng() ), new THREE.Vector3( Math.cos( turn ), 0, Math.sin( turn ) ), t0 + ( t1 - t0 ) * rng(), rng, 0.35 );

		}

	}

}

/** The yunpeng's material: snow white over a greyer foot, a faint node every YUNPENG.internode, a
 * waxy sheen and a faint white light of its own; swaying from each stalk's foot. */
function material( shared: Shared ): THREE.MeshStandardNodeMaterial {

	const m = new THREE.MeshStandardNodeMaterial( { roughness: 0.45, metalness: 0, side: THREE.DoubleSide } );
	const sway = attribute<'vec4'>( 'yunpengSway', 'vec4' ), root = attribute<'vec3'>( 'yunpengRoot', 'vec3' ), part = attribute<'float'>( 'yunpengPart', 'float' );
	const height = positionGeometry.y.sub( root.y );
	// a node's faint band on the stalk: where the height crosses a multiple of the internode
	const node = smoothstep( 0.965, 1, height.div( YUNPENG.internode ).fract() ).mul( float( 1 ).sub( part.min( 1 ) ) );
	const white = mix( vec3( ...FOOT ), vec3( ...WHITE ), smoothstep( 0, 0.25, sway.w ) ).mul( float( 1 ).sub( node.mul( 0.45 ) ) );
	m.colorNode = white;
	const glow = Number( debugFlags.yunpengGlow ?? YUNPENG.glow );
	if ( glow > 0 ) m.emissiveNode = white.mul( glow );
	let trunk: THREE.Node<'vec2'> | undefined;
	useVegetationMotion( m, shared.wind, {
		rest: positionGeometry,
		displacement: ( wind ) => {

			const bent = mainBend( wind, positionGeometry, root, sway.x, WIND.cycles, float( WIND.slow ) );
			if ( wind === shared.wind ) trunk = bent.sway;
			return bent.position.add( leafFlutter( wind, bent.field, normalGeometry, sway.y, sway.z, WIND.flutter ) );

		},
		sway: () => trunk,
	} );
	m.name = 'yunpeng';
	( m as unknown as { setupLightingModel: () => THREE.LightingModel } ).setupLightingModel = () => new GroundBounceLightingModel();
	return m;

}

/** The yunpeng's clumps at `sites` (x, z, depth per clump: IslandGrowth.ts startYunpeng), on the
 * ground `groundAt` gives; null with no site. */
export function buildYunpeng( sites: ArrayLike<number>, groundAt: ( x: number, z: number ) => number, shared: Shared ): THREE.Mesh | null {

	if ( sites.length === 0 ) return null;
	const b = new Builder();
	for ( let s = 0; s < sites.length; s += 3 ) clump( b, sites[ s ], sites[ s + 1 ], s === 0, groundAt );
	const mesh = new THREE.Mesh( b.geometry(), material( shared ) );
	mesh.name = 'yunpeng';
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	return mesh;

}

/** The yunpeng as a vegetation kind (vegetation/Registry.ts). */
export function yunpengKind( mesh: THREE.Mesh ): VegetationKind {

	return { name: 'yunpeng', root: mesh, prepass: false, shadowFilter: 'ordinary', sunCaster: true, rainBake: true };

}
