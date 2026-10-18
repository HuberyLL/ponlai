import * as THREE from 'three/webgpu';
import type { Shared } from '../shared.ts';
import { culmMaterial, leafMaterial } from './BambooMaterials.ts';
import { hash3i, mulberry32, type Rng } from './noise.ts';
import type { VegetationKind } from './vegetation/Registry.ts';
import { MeshBuilder, UP, leafLayout, smooth, streamAt } from './vegetation/TreeMesh.ts';
import type { LeafAtlas } from './vegetation/TreeSurfaces.ts';

// Penglai's bamboo (浮筠之簳): "green leaves, purple stems, seeds as big as pearls" (Wang Jia, Shiyi
// ji, book 10, on Penglai), the one plant that text gives the island itself, the wind in its leaves
// ringing like bells and chimes. Its real kin is the purple (black) bamboo, Phyllostachys nigra: a
// running bamboo whose culms come up green and turn purple-black in their second or third year,
// a white bloom of wax under each node, the narrow leaves in fans at the twigs' ends. A running
// bamboo spreads by its rhizomes into a stand, so the bamboo grows in stands: the first ones where
// the starting island's ground lies deepest (IslandGrowth.ts startGrove: its heart, the most
// sheltered and the deepest soil), a seed fixing them; the game will plant and cut more (not yet).
//
// A stand's form, after groves of Phyllostachys:
// - The culms: spread over an oval patch, packed closer in its middle, tallest there and shorter
//   toward its edge, so the stand rises to a crown; each leans out from the middle the more the
//   farther out it stands, and bows outward at its top under its leaves. Straight internodes,
//   short at the foot and longer up the culm, a ridge at each node; the culms' ages mixed (green,
//   turning, purple).
// - The branches: in the upper part of each culm, at every node, alternately to one side and the
//   other (turned toward the stand's outside, where the light is), longest about halfway up, rising
//   and then drooping; a tuft at the culm's top.
// - The leaves: sprays of narrow leaves on cards along the branches' outer part, hanging out along
//   the branch (BambooMaterials.ts's atlas), their normals bent out from the stand
//   and up so the stand shades as one mass, its inside darker (the cards' vertex colours).
// - A few clusters of pale seeds like pearls among the leaves (the atlas).
// The whole stand sways in the one wind, each culm from its own foot (`treeRoot`), bending most at
// its top (`leafSway` x) and by its slenderness (its length to the fourth over its radius cubed, as
// a cantilever under the wind's load), so the culms swing apart rather than as one; each spray
// flutters from its twig on its own phase as the gusts pass (Deform.ts leafFlutter).
// Every random choice of a stand draws from one stream seeded by where it stands; each culm's
// cards from a stream of their own (TreeMesh.ts streamAt).
//
// Two vegetation kinds: the culms and branches (an ordinary shadow, no depth prepass) and the
// leaves (the vegetation's shadow filter and depth prepass, drawn before the terrain). It takes no
// part in the growth swap: the sites are the step-0 piece's and the ground is a function of the
// point (WorldShapes.ts islandSurfaceHeight). Not yet: LOD, the game's planting and cutting.

export const BAMBOO = {
	radius: 2.2, // a full stand's radius (m), along its longer axis
	culms: 42, // culms in a full stand
	height: [ 4.2, 7.2 ] as const, // a culm's height at the stand's edge and in its middle (m)
	diameter: 0.04, // a 7 m culm's diameter at its foot (m)
	internode: [ 0.12, 0.32 ] as const, // internode length at the foot and up the culm (m)
	lean: [ 0.03, 0.3 ] as const, // a culm's lean out from the middle (rad), in the middle and at the edge
	bow: 1.0, // how far a full culm's top bows out under its leaves (m)
	branches: 0.4, // branches from this share of a culm's height up
	branch: 1.3, // the longest branch (m, about halfway up a full culm)
	card: 0.5, // a leaf card's side (m)
	bend: 0.3, // a 7 m culm's sway at its top (m at a fair day's typical gust)
	flutter: 0.035, // a card's flutter at its tip in a gust's core (m: Deform.ts leafFlutter)
	size: [ 1, 0.7 ] as const, // the first stand's size, and every later one's
};

/** The culms' and branches' mesh layout: `culm` (age: 0 green to 1 purple; where in its
 * internode, 0 at the node below to 1 at the node above) and the sway (as the leaf cards':
 * `treeRoot`, `leafSway`). */
const culmLayout = () => new MeshBuilder( { culm: 2, treeRoot: 3, leafSway: 4 } );

interface Stand {
	culms: MeshBuilder; leaves: MeshBuilder; rng: Rng;
	centre: THREE.Vector3; radius: number; top: number;
}

interface Culm {
	foot: THREE.Vector3; height: number; radius: number; age: number;
	out: THREE.Vector3; // outward from the stand's middle, level
	lean: number; bow: number;
	/** the sway amplitude at a point of the culm or its leaves, by height above its foot */
	sway: ( y: number ) => number;
}

/** A culm's axis at s (0 foot, 1 top, of its length): upright, leaning out, bowing over at the top. */
function axisAt( c: Culm, s: number, out: THREE.Vector3 ): THREE.Vector3 {

	const h = c.height;
	const along = s * h * Math.cos( c.lean ), off = s * h * Math.sin( c.lean ) + c.bow * Math.pow( s, 2.5 );
	return out.copy( c.foot ).addScaledVector( c.out, off ).add( new THREE.Vector3( 0, along - c.bow * 0.35 * Math.pow( s, 4 ), 0 ) );

}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _t = new THREE.Vector3(), _n = new THREE.Vector3(), _bn = new THREE.Vector3();
const _d = new THREE.Vector3(), _p = new THREE.Vector3();

/** A straight segment of tube from `a` to `b` (radii ra, rb), its rings `values` carry; `phase`
 * runs from p0 to p1 (the internode's), a bulge of `node` at its start. */
function segment( mesh: MeshBuilder, a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number, sides: number, rings: readonly number[], values: { age: number; p0: number; p1: number; node: number; root: number[]; sway: ( y: number ) => number; phase: number } ): void {

	_t.subVectors( b, a );
	const length = _t.length();
	_t.normalize();
	_n.set( 0, 0, 1 ).cross( _t );
	if ( _n.lengthSq() < 1e-4 ) _n.set( 1, 0, 0 ).cross( _t );
	_n.normalize();
	_bn.crossVectors( _t, _n );
	const first = mesh.count, row = sides + 1;
	for ( const s of rings ) {

		const centre = _p.copy( a ).addScaledVector( _t, s * length ).clone();
		const r = ( ra + ( rb - ra ) * s ) * ( 1 + values.node * Math.exp( - ( ( s * length / 0.012 ) ** 2 ) ) );
		const phase = values.p0 + ( values.p1 - values.p0 ) * s;
		for ( let j = 0; j <= sides; j ++ ) {

			const ang = ( j % sides ) / sides * Math.PI * 2;
			_d.copy( _n ).multiplyScalar( Math.cos( ang ) ).addScaledVector( _bn, Math.sin( ang ) );
			const p = centre.clone().addScaledVector( _d, r );
			const index = mesh.vertex( p, {
				culm: [ values.age, phase ], treeRoot: values.root, leafSway: [ values.sway( p.y ), 0, values.phase, 0 ],
			} );
			// the seam shares its first vertex's normal
			if ( j === sides ) mesh.seams.push( index - sides, index );

		}

	}
	for ( let i = 0; i < rings.length - 1; i ++ ) for ( let j = 0; j < sides; j ++ ) {

		const p = first + i * row + j, q = p + 1, r = p + row, s = q + row;
		mesh.indices.push( p, q, r, q, s, r );

	}

}

/** One culm: its internodes as straight segments, node to node, then its branches and leaves. */
function culm( st: Stand, c: Culm ): void {

	const { rng } = st;
	const root = [ c.foot.x, c.foot.y, c.foot.z ];
	const phase = rng();
	// the nodes: internodes short at the foot, longest a third of the way up, shorter again at the top
	const nodes: number[] = [ 0 ];
	for ( let at = 0; at < c.height; ) {

		const s = at / c.height;
		const length = ( BAMBOO.internode[ 0 ] + ( BAMBOO.internode[ 1 ] - BAMBOO.internode[ 0 ] ) * smooth( 0, 0.35, s ) * ( 1 - 0.35 * smooth( 0.7, 1, s ) ) ) * ( c.height / BAMBOO.height[ 1 ] * 0.5 + 0.5 ) * ( 0.9 + 0.2 * rng() );
		at = Math.min( c.height, at + length );
		nodes.push( at );

	}
	if ( nodes[ nodes.length - 1 ] - nodes[ nodes.length - 2 ] < 0.05 ) nodes.splice( nodes.length - 2, 1 );
	const radiusAt = ( s: number ) => c.radius * ( 1 - 0.3 * s - 0.6 * Math.pow( s, 5 ) );
	const sides = c.radius > 0.012 ? 8 : 6;
	// the foot a little into the ground
	const below = c.foot.clone().add( new THREE.Vector3( 0, - 0.15, 0 ) );
	segment( st.culms, below, axisAt( c, 0, _a ).clone(), c.radius * 1.05, c.radius, sides, [ 0, 1 ], { age: c.age, p0: 0.5, p1: 1, node: 0, root, sway: c.sway, phase } );
	let side = rng() < 0.5 ? 1 : - 1;
	for ( let k = 0; k < nodes.length - 1; k ++ ) {

		const s0 = nodes[ k ] / c.height, s1 = nodes[ k + 1 ] / c.height;
		const a = axisAt( c, s0, _a ).clone(), b = axisAt( c, s1, _b ).clone();
		segment( st.culms, a, b, radiusAt( s0 ), radiusAt( s1 ), sides, [ 0, 0.08, 0.92, 1 ], { age: c.age, p0: 0, p1: 1, node: k > 0 ? 0.06 : 0, root, sway: c.sway, phase } );
		// two branches at each node in the upper part, a main one and a lesser, alternately to
		// either side
		if ( s0 >= BAMBOO.branches && k > 0 && s0 < 0.97 ) {

			branch( st, c, a, s0, side, 0, radiusAt( s0 ), root, phase );
			branch( st, c, a, s0, side, 1, radiusAt( s0 ), root, phase );
			side = - side;

		}

	}
	// the top: a tuft of sprays round the last node, drooping
	const top = axisAt( c, 1, _a ).clone();
	const tip = top.clone().sub( axisAt( c, 0.96, _b ) ).normalize();
	for ( let k = 0; k < 10; k ++ ) {

		const az = ( k / 10 ) * Math.PI * 2 + rng() * 0.6;
		const dir = new THREE.Vector3( Math.cos( az ), 0, Math.sin( az ) ).multiplyScalar( 0.8 ).add( tip ).add( new THREE.Vector3( 0, - 0.35, 0 ) ).normalize();
		spray( st, c, top.clone().addScaledVector( tip, - 0.15 * rng() ), dir, BAMBOO.card * ( 0.75 + 0.3 * rng() ), root );

	}

}

/** A branch from the culm's node at `at` (s along the culm), out to one `side` (the node's main
 * one, or the `lesser` beside it): up and out, then drooping, with sprays along it. */
function branch( st: Stand, c: Culm, at: THREE.Vector3, s: number, side: number, lesser: number, r: number, root: number[], phase: number ): void {

	const { rng } = st;
	// turned toward the stand's outside: the culm's outward way, swung to the side
	const az = Math.atan2( c.out.z, c.out.x ) + side * ( 0.5 + 0.9 * rng() ) + lesser * side * ( 0.3 + 0.4 * rng() );
	const level = new THREE.Vector3( Math.cos( az ), 0, Math.sin( az ) );
	const rise = 0.7 - 0.5 * s + 0.2 * rng();
	const dir = level.clone().add( new THREE.Vector3( 0, rise, 0 ) ).normalize();
	// longest about halfway up a culm
	const length = BAMBOO.branch * ( c.height / BAMBOO.height[ 1 ] ) * ( 1 - 1.6 * ( s - 0.55 ) ** 2 ) * ( 0.75 + 0.4 * rng() ) * ( 1 - 0.4 * lesser );
	if ( length < 0.15 ) return;
	const end = at.clone().addScaledVector( dir, length ).add( new THREE.Vector3( 0, - 0.25 * length, 0 ) );
	const mid = at.clone().addScaledVector( dir, length * 0.55 );
	const curve = new THREE.QuadraticBezierCurve3( at.clone().addScaledVector( dir, r ), mid, end );
	const steps = 3;
	for ( let i = 0; i < steps; i ++ ) {

		const p = curve.getPoint( i / steps ), q = curve.getPoint( ( i + 1 ) / steps );
		segment( st.culms, p, q, r * 0.32 * ( 1 - i / steps * 0.7 ), r * 0.32 * ( 1 - ( i + 1 ) / steps * 0.7 ), 4, [ 0, 1 ], { age: c.age, p0: 0.5, p1: 0.5, node: 0, root, sway: c.sway, phase } );

	}
	// sprays along it, hanging out along the branch
	const cards = 2 + Math.floor( rng() * 2 + length * 4.5 );
	for ( let k = 0; k < cards; k ++ ) {

		const t = 0.2 + 0.8 * ( k + 0.5 * rng() ) / cards;
		const from = curve.getPoint( t );
		const along = curve.getTangent( t ).normalize();
		const turn = ( k % 2 === 0 ? 1 : - 1 ) * ( 0.3 + 0.5 * rng() );
		const out = along.clone().applyAxisAngle( UP, turn ).add( new THREE.Vector3( 0, - 0.25 - 0.3 * rng(), 0 ) ).normalize();
		spray( st, c, from, out, BAMBOO.card * ( 0.8 + 0.35 * rng() ) * Math.min( 1, 0.6 + length ), root );

	}

}

/** A leaf card from `from`, its spray hanging out along `out` (the atlas tile's up), facing up as
 * far as it can; its normal bent out from the stand and up, its colour the exposure. */
function spray( st: Stand, c: Culm, from: THREE.Vector3, out: THREE.Vector3, size: number, root: number[] ): void {

	const rng = streamAt( from, 23 );
	const Y = out.clone().normalize();
	// the card's width across the spray, turned about it a little
	const X = new THREE.Vector3().crossVectors( UP, Y );
	if ( X.lengthSq() < 1e-4 ) X.set( 1, 0, 0 );
	X.normalize().applyAxisAngle( Y, ( rng() - 0.5 ) * 1.2 );
	const N = new THREE.Vector3().crossVectors( X, Y ).normalize();
	if ( N.y < 0 ) {

		N.negate();
		X.negate();

	}
	const tile = Math.floor( rng() * 4 ), tu = ( tile % 2 ) * 0.5, tv = Math.floor( tile / 2 ) * 0.5;
	const inset = 2 / 512;
	const flutterPhase = rng();
	const first = st.leaves.count;
	for ( const [ cx, cy, u, v ] of [ [ - 0.5, 0, 0, 0 ], [ 0.5, 0, 1, 0 ], [ 0.5, 1, 1, 1 ], [ - 0.5, 1, 0, 1 ] ] ) {

		const p = from.clone().addScaledVector( X, cx * size ).addScaledVector( Y, ( cy - 0.04 ) * size );
		// out from the stand's axis (at the point's height) and up
		const away = new THREE.Vector3( p.x - st.centre.x, 0, p.z - st.centre.z );
		const radial = Math.min( 1, away.length() / st.radius );
		away.normalize();
		const height = Math.min( 1, Math.max( 0, ( p.y - st.centre.y ) / st.top ) );
		const nn = away.clone().multiplyScalar( 0.5 ).addScaledVector( N, 0.35 ).addScaledVector( UP, 0.15 + 0.35 * height ).normalize();
		const exposure = Math.min( 1, 0.5 * radial + 0.45 * height + 0.15 * rng() );
		const k = 0.32 + 0.68 * exposure * exposure;
		st.leaves.vertex( p, {
			normal: [ nn.x, nn.y, nn.z ],
			uv: [ tu + inset + u * ( 0.5 - 2 * inset ), tv + inset + v * ( 0.5 - 2 * inset ) ],
			color: [ k, k, k ],
			leafSway: [ c.sway( p.y ), BAMBOO.flutter * cy, flutterPhase, 0 ],
			treeRoot: root,
		} );

	}
	st.leaves.indices.push( first, first + 1, first + 2, first, first + 2, first + 3 );

}

/** One stand round ( x, z ), of `size` (of a full stand's). */
function grow( culms: MeshBuilder, leaves: MeshBuilder, x: number, z: number, size: number, groundAt: ( x: number, z: number ) => number ): void {

	const P = BAMBOO;
	const rng = mulberry32( ( hash3i( Math.round( x * 4 ), Math.round( z * 4 ), 13 ) * 4294967296 ) >>> 0 );
	const centre = new THREE.Vector3( x, groundAt( x, z ), z );
	const radius = P.radius * Math.sqrt( size );
	// an oval patch, turned its own way, packed closer in its middle
	const turn = rng() * Math.PI, squash = 0.65 + 0.2 * rng();
	const count = Math.round( P.culms * size );
	const feet: THREE.Vector2[] = [];
	for ( let tries = 0; feet.length < count && tries < count * 40; tries ++ ) {

		const q = Math.pow( rng(), 0.7 ), a = rng() * Math.PI * 2;
		const u = Math.cos( a ) * q * radius, w = Math.sin( a ) * q * radius * squash;
		const p = new THREE.Vector2( x + u * Math.cos( turn ) - w * Math.sin( turn ), z + u * Math.sin( turn ) + w * Math.cos( turn ) );
		if ( feet.every( ( f ) => f.distanceTo( p ) > 0.26 ) ) feet.push( p );

	}
	const tallest = P.height[ 1 ] * ( 0.8 + 0.2 * size );
	const st: Stand = { culms, leaves, rng, centre, radius, top: tallest };
	for ( const f of feet ) {

		const away = new THREE.Vector3( f.x - x, 0, f.y - z );
		const q = Math.min( 1, away.length() / radius );
		const out = away.lengthSq() > 1e-6 ? away.normalize() : new THREE.Vector3( 1, 0, 0 );
		out.applyAxisAngle( UP, ( rng() - 0.5 ) * 0.8 );
		const height = ( P.height[ 1 ] + ( P.height[ 0 ] - P.height[ 1 ] ) * Math.pow( q, 1.5 ) ) * ( 0.8 + 0.2 * size ) * ( 0.85 + 0.25 * rng() );
		const k = rng();
		const age = k < 0.2 ? 0 : k < 0.42 ? 0.35 + 0.4 * rng() : 1;
		const c: Culm = {
			foot: new THREE.Vector3( f.x, groundAt( f.x, f.y ), f.y ), height,
			radius: P.diameter / 2 * Math.pow( height / P.height[ 1 ], 1.2 ) * ( 0.85 + 0.3 * rng() ), age, out,
			lean: P.lean[ 0 ] + ( P.lean[ 1 ] - P.lean[ 0 ] ) * q + ( rng() - 0.5 ) * 0.06,
			bow: P.bow * ( height / P.height[ 1 ] ) * ( 0.6 + 0.6 * rng() ),
			sway: () => 0,
		};
		const footY = c.foot.y;
		// the culm's slenderness: a cantilever's tip under the wind's load along it (its drag on the
		// culm's width) goes as the length to the fourth over the radius cubed (a full culm's 1)
		const slender = Math.min( 2, Math.pow( height / P.height[ 1 ], 4 ) / Math.pow( c.radius / ( P.diameter / 2 ), 3 ) );
		c.sway = ( y ) => P.bend * slender * Math.pow( Math.min( 1, Math.max( 0, ( y - footY ) / height ) ), 2 );
		culm( st, c );

	}

}

export interface BambooStands {
	culms: THREE.Mesh;
	leaves: THREE.Mesh;
}

/** The bamboo stands at `sites` (x, z, depth per stand: IslandGrowth.ts startGrove; the first full
 * size, the others smaller), on the ground `groundAt` gives, in their surfaces (BambooMaterials.ts:
 * the leaves' atlas, made once); null with no site. */
export function buildBamboo( sites: ArrayLike<number>, groundAt: ( x: number, z: number ) => number, surfaces: { shared: Shared; atlas: LeafAtlas } ): BambooStands | null {

	if ( sites.length === 0 ) return null;
	const culms = culmLayout(), leaves = leafLayout( { treeRoot: 3 } );
	for ( let s = 0; s < sites.length; s += 3 ) grow( culms, leaves, sites[ s ], sites[ s + 1 ], s === 0 ? BAMBOO.size[ 0 ] : BAMBOO.size[ 1 ], groundAt );

	const culmGeometry = culms.geometry( 'bamboo culms' );
	const leafGeometry = leaves.geometry( 'bamboo leaves' );
	// room for the sway
	for ( const g of [ culmGeometry, leafGeometry ] ) g.boundingSphere!.radius += 0.6;
	const culmMesh = new THREE.Mesh( culmGeometry, culmMaterial( surfaces.shared ) );
	const leafMesh = new THREE.Mesh( leafGeometry, leafMaterial( surfaces.shared, surfaces.atlas ) );
	// before the terrain, as all the vegetation (the turf it covers then fails the depth test)
	leafMesh.renderOrder = - 1;
	for ( const mesh of [ culmMesh, leafMesh ] ) {

		mesh.name = mesh.geometry.name;
		mesh.castShadow = true;
		mesh.receiveShadow = true;

	}
	return { culms: culmMesh, leaves: leafMesh };

}

/** The stands' two vegetation kinds: the culms (an ordinary shadow) and the leaves. */
export function bambooKinds( stands: BambooStands ): VegetationKind[] {

	return [
		{ name: 'bamboo', root: stands.culms, prepass: false, shadowFilter: 'ordinary', sunCaster: true, rainBake: true },
		{ name: 'bamboo leaves', root: stands.leaves, prepass: true, shadowFilter: 'vegetation', sunCaster: true, rainBake: true },
	];

}
