import * as THREE from 'three/webgpu';
import {
	Fn, If, attribute, positionGeometry, positionLocal, normalViewGeometry, normalGeometry, vec3, float, mix, dot, step, mx_noise_float, smoothstep,
	uniform, cameraPosition, length, clamp, select,
} from 'three/tsl';
import { wave } from '../weather/Wind.ts';
import { hash3i, mulberry32, type Rng } from './noise.ts';
import { PLANT_WIND, mainBend } from './vegetation/Deform.ts';
import type { VegetationKind } from './vegetation/Registry.ts';
import { AttributeType, geometrySteps, uploadSteps } from './Upload.ts';
import { leafTexture } from './vegetation/LeafTexture.ts';
import { leafTransmission, vegetationMaterial } from './vegetation/Material.ts';
import { boundsSteps, float32Steps, runSteps, Growing } from './Steps.ts';
import { PLANT_STRIDE, PLANT_TREE, PLANT_ROUND, PLANT_BROADLEAF, PLANT_FERN } from './PlantSites.ts';
import type { Shared } from '../shared.ts';
import { SUN_MAP_LAYER } from '../lighting/SunShadow.ts';

// The island top's shrubs and small trees (sited by PlantSites.ts). Every plant is grown once from
// its own seed, so no two share a silhouette: round shrubs of small or larger leaves, broad-leaved
// clumps, ferns and small trees with a forked trunk under clustered crowns. They use the rim
// bushes' folded leaf (one texture, its coverage-preserving alpha mips) and their light model (the
// vegetation's factory, vegetation/Material.ts, family 'leaf'), and merge into one geometry in
// world space. Per vertex: plantMotion ( wind phase, flags: stem 1 + bark 2, ambient occlusion,
// direct light ), plantRoot ( the plant's root in world space ), plantWind ( main bend, branch and
// leaf-edge amplitudes in metres, the plant's height ) and plantLeaf ( its leaf's centre in world
// space and the leaf's rank, -1 on bark and stalks ): eight vertex buffers, the most one draw may
// bind.
//
// Level of detail. The plants' cost is in their triangles (3.2 million on a grown island, half of
// them drawn again by the depth prepass), not their pixels: the same at 1080p as at 1440p. With
// every leaf collapsed to a point in the vertex stage (bark drawn) the opaque pass kept about 40 %
// of the plants' cost, the vertices' share; so the far plants are drawn from a mesh that holds
// fewer vertices, not only fewer triangles. As a function of the camera's position alone:
// - A plant keeps the share keep( d ) of its leaves at d metres from its root to the camera:
//   1 nearer than PLANT_LOD.near, PLANT_LOD.keep from PLANT_LOD.far on, easing between. A leaf is
//   kept while its rank (a hash of the plant's seed and the leaf's number, so the subset is the
//   same at every load and grow) lies below the share; within LEAF_FADE of it the leaf shrinks to
//   its centre, so leaves leave one by one and never pop. The leaves kept grow by 1 / sqrt( keep )
//   about their centres, so the plant covers about as much and keeps its colour (the grass's
//   thinning and widening, Grass.ts, is the model). Bark and stalks stay whole. PLANT_LOD.keep
//   is 0.45: at 0.3 single enlarged bright leaves showed in the plateau's shrubs from the game's
//   camera, at 0.45 they do not, and the far plants still cost about 0.6 ms less than every leaf
//   (the cost rises about 0.7 ms with each 0.15 of the share).
// - The far mesh holds the bark, the stalks and the leaves ranked below PLANT_LOD.keep, the same
//   vertices as the full geometry through an index of its own, and draws the plants from
//   PLANT_LOD.far on; the near meshes draw the full index and the plants nearer than that. At
//   PLANT_LOD.far a plant is the same in both (the same leaves, the same scale), so it changes
//   meshes without a change in the image. A plant a mesh does not draw collapses to a point.
// - The index is ordered by world-anchored cells of LOD_CELL metres (`cellOrder`): the near meshes
//   (NEAR_RANGES of them, each one range of the index) draw only the runs of cells in view with a
//   root nearer than PLANT_LOD.far, and the far mesh only from its first cell in view with a root at
//   that distance or beyond to its last (`CellRanges`, set in each mesh's onBeforeRender for the
//   camera that draws it, the depth prepass's copies sharing the geometry and so the range). A
//   cell out of view draws no pixel, so the image stays a function of the camera's position; the
//   culling spares the vertex stage the plants behind the camera, which the single mesh ran. An
//   empty range draws a lone degenerate triangle at the index's end: WebGPU flags a draw of no
//   index.
// - Shadows: the sun's map is drawn only as the sun turns, so a caster that followed the camera
//   would leave the shadows where the camera stood at the map's last redraw. The plants cast from
//   a mesh of their own with every leaf, drawn only into the sun's map (SunShadow's
//   SUN_MAP_LAYER, which the view's camera does not enable); the near and far meshes cast nothing.
//   Casting the far mesh's share instead lightened the near plants' self-shadowing visibly, so
//   the map costs what it did. The rain's collision map prints the caster too (the others are
//   `rainBake: false`).
// Material, layout and pipelines are shared by all of them: the near or far draw is a per-object
// uniform (`farDraw`, `userData.plantsFar`, which the prepass's copy carries).
//
// The island grows (Growth.ts): a grown island's plants are grown in the preparation's idle-time
// steps (`plantSteps`, yielding inside each plant's sprays and fronds), each plant once: its
// arrays are kept by its site (`PlantCache`), so a grow grows only the plants that are new or
// changed and copies the rest into the new merged geometry, uploaded ahead with the far index
// (Upload.ts). The swap gives the meshes, and their depth copies, new geometries over those
// buffers: same material, same attributes, no new pipeline (`setPlants`). The plants are ordered by
// cell, then in the sites' order, so a grown page draws what a fresh load of that land draws.
//
// Wind: the bushes' layers (vegetation/Deform.ts `mainBend`, PLANT_WIND): the whole plant bends from its root with the
// gust field and sways with its neighbours at 30 swings per gust tile (about 0.9 Hz), trees at half
// that rate (`slow`, from 1.4 to 2.6 m tall); each spray, frond or leaf stalk swings on its own
// phase from where it leaves the plant; each leaf's edges and tip flutter along its normal. Shadows
// keep the rest pose; a limb casts whole or not at all: limbs that leave their parent 3 cm or more
// in radius cast, thinner twigs, shrub stems and stalks do not (VegetationShadow.ts).

const UP = new THREE.Vector3( 0, 1, 0 );
// A texel inside the leaf body: bark and stalks take an opaque, constant colour from the map.
const SOLID_UV: [ number, number ] = [ 0.3, 0.5 ];

type RGB = [ number, number, number ];

// linear albedo before the leaf map; each list is one family of plants
const PALETTES: Record<string, RGB[]> = {
	smallLeaf: [ [ 0.045, 0.12, 0.04 ], [ 0.06, 0.145, 0.045 ], [ 0.075, 0.16, 0.055 ] ],
	largeLeaf: [ [ 0.11, 0.19, 0.05 ], [ 0.15, 0.205, 0.055 ], [ 0.085, 0.17, 0.045 ] ],
	broadleaf: [ [ 0.05, 0.13, 0.04 ], [ 0.07, 0.15, 0.04 ], [ 0.045, 0.12, 0.05 ] ],
	fern: [ [ 0.13, 0.22, 0.045 ], [ 0.16, 0.235, 0.05 ], [ 0.105, 0.2, 0.04 ] ],
	tree: [ [ 0.06, 0.15, 0.045 ], [ 0.09, 0.175, 0.05 ], [ 0.14, 0.19, 0.05 ] ],
};
// Grey-brown bark. The leaf map's solid texel (about 0.6 linear) and the furrows multiply in
// after, so the trunk's albedo settles near 0.17: a mid grey-brown that still reads under the
// crown's shade instead of a black stroke.
const BARK: RGB = [ 0.3, 0.255, 0.2 ];
const STALK: RGB = [ 0.09, 0.13, 0.04 ];

interface Look {
	envelope: THREE.Vector3; // outward from the plant's mass, local
	envelopeWeight: number;
	light: number; // 0 deep inside the plant, 1 on its outer shell
	phase: number;
	flutter: number; // extra sway (m) of this part on top of the plant's bend
	// Where the part (a spray, a leaf's stalk, a frond) leaves the plant, local, and how far it
	// reaches: its sway in the wind grows from 0 there to `flutter` at its far end.
	base?: THREE.Vector3;
	reach?: number;
}

// a leaf's edge and tip flutter in the wind (m, at a fair day's gust) on top of its part's sway
const LEAF_EDGE = 0.005;

/** The plants' level of detail (see the header): a plant keeps all its leaves nearer the camera
 * than `near` (m, from its root), the share `keep` of them from `far` on, the share easing down
 * between; the near meshes draw a plant nearer than `far`, the far mesh from `far` on. */
export const PLANT_LOD = { near: uniform( 40 ), far: uniform( 100 ), keep: 0.45 };
// A leaf shrinks to nothing over this much of the share as it drops out, so no leaf pops; leaf
// ranks lie below 1 - LEAF_FADE, so a plant at the share 1 keeps every leaf whole.
const LEAF_FADE = 0.1;
// the near meshes' cells (m, world-anchored squares): each draws the plants rooted in it, or not
const LOD_CELL = 32;
// how many index ranges the near meshes draw at most (a mesh each): the near cells' runs, the
// closest runs merged when there are more
const NEAR_RANGES = 4;
const SALT_LEAF = 4271;

/** One plant's arrays (world space; its indices count from its own first vertex). */
export interface PlantPart {
	position: Float32Array; uv: Float32Array; color: Float32Array; normal: Float32Array;
	motion: Float32Array; root: Float32Array; wind: Float32Array; leaf: Float32Array; index: Uint32Array;
}

// what one vertex carries, in floats per attribute (the merged geometry's layout)
const LAYOUT = { position: 3, uv: 2, color: 3, normal: 3, motion: 4, root: 3, wind: 4, leaf: 4 } as const;
const ATTRIBUTES: Record<keyof typeof LAYOUT, string> = {
	position: 'position', uv: 'uv', color: 'color', normal: 'normal', motion: 'plantMotion', root: 'plantRoot', wind: 'plantWind', leaf: 'plantLeaf',
};

class PlantBuilder {

	readonly P = new Growing(); readonly U = new Growing(); readonly C = new Growing();
	readonly M = new Growing(); readonly R = new Growing(); readonly W = new Growing(); readonly I = new Growing();
	readonly L = new Growing();
	readonly intended = new Growing(); readonly envelope = new Growing(); readonly envelopeWeight = new Growing();
	// the plant being grown: its frame on the ground, its sky visibility and how it bends
	readonly frame = new THREE.Matrix4();
	readonly turn = new THREE.Matrix3();
	visibility = 1;
	height = 1;
	seed = 0;
	// the leaf being grown: its centre in world space and its rank (-1 outside a leaf)
	private leaves = 0;
	private rank = - 1;
	private readonly centre = new THREE.Vector3();
	bend: ( local: THREE.Vector3 ) => number = () => 0;
	private readonly root = new THREE.Vector3();
	private readonly w = new THREE.Vector3(); private readonly n = new THREE.Vector3(); private readonly e = new THREE.Vector3();

	place( x: number, y: number, z: number, visibility: number, height: number, yaw: number, tilt: THREE.Vector3 ): void {

		const q = new THREE.Quaternion().setFromUnitVectors( UP, tilt ).multiply( new THREE.Quaternion().setFromAxisAngle( UP, yaw ) );
		this.frame.compose( new THREE.Vector3( x, y - 0.03, z ), q, new THREE.Vector3( 1, 1, 1 ) );
		this.turn.setFromMatrix4( this.frame );
		this.visibility = visibility;
		this.height = height;
		this.root.setFromMatrixPosition( this.frame );

	}

	vertex( p: THREE.Vector3, u: number, v: number, color: RGB, shade: number, normal: THREE.Vector3, look: Look, stem: boolean, bark: boolean, flutter = 0 ): number {

		const index = this.P.length / 3;
		this.w.copy( p ).applyMatrix4( this.frame );
		this.P.push( this.w.x, this.w.y, this.w.z );
		this.U.push( u, v );
		this.C.push( color[ 0 ] * shade, color[ 1 ] * shade, color[ 2 ] * shade );
		const light = THREE.MathUtils.clamp( look.light, 0, 1 );
		this.M.push( look.phase, ( stem ? 1 : 0 ) + ( bark ? 2 : 0 ), THREE.MathUtils.lerp( 0.32, 1, light ) * this.visibility, THREE.MathUtils.lerp( 0.7, 1, light ) );
		const branch = look.base ? THREE.MathUtils.clamp( p.distanceTo( look.base ) / Math.max( 1e-3, look.reach ?? 1 ), 0, 1 ) : flutter;
		this.R.push( this.root.x, this.root.y, this.root.z );
		this.L.push( this.centre.x, this.centre.y, this.centre.z, this.rank );
		this.W.push( this.bend( p ), branch * look.flutter, stem || bark ? 0 : flutter * LEAF_EDGE, this.height );
		this.n.copy( normal ).applyMatrix3( this.turn ).normalize();
		this.e.copy( look.envelope ).applyMatrix3( this.turn ).normalize();
		this.intended.push( this.n.x, this.n.y, this.n.z );
		this.envelope.push( this.e.x, this.e.y, this.e.z );
		this.envelopeWeight.push( bark ? 0 : look.envelopeWeight );
		return index;

	}

	// A leaf's vertices follow: their centre ( local ) and the leaf's rank, a hash of the plant's seed
	// and the leaf's number in it (every grow of the plant ranks its leaves alike).
	private beginLeaf( centre: THREE.Vector3 ): void {

		this.rank = hash3i( this.seed, this.leaves ++, SALT_LEAF ) * ( 1 - LEAF_FADE );
		this.centre.copy( centre ).applyMatrix4( this.frame );

	}

	private endLeaf(): void {

		this.rank = - 1;
		this.centre.set( 0, 0, 0 );

	}

	// A thin flat stalk from a to b (twigs, leaf stalks, fern stems): under a shadow texel
	// across, so it stays out of the sun's map.
	stalk( a: THREE.Vector3, b: THREE.Vector3, w0: number, w1: number, color: RGB, shade: number, look: Look, bark = false ): void {

		const dir = new THREE.Vector3().subVectors( b, a ).normalize();
		const side = new THREE.Vector3().crossVectors( UP, dir );
		if ( side.lengthSq() < 1e-4 ) side.set( 1, 0, 0 );
		side.normalize();
		const n = new THREE.Vector3().crossVectors( dir, side ).normalize();
		if ( n.y < 0 ) n.negate();
		const v = new THREE.Vector3();
		const i = this.vertex( v.copy( a ).addScaledVector( side, - w0 ), ...SOLID_UV, color, shade * 0.75, n, look, true, bark );
		this.vertex( v.copy( a ).addScaledVector( side, w0 ), ...SOLID_UV, color, shade * 0.75, n, look, true, bark );
		this.vertex( v.copy( b ).addScaledVector( side, w1 ), ...SOLID_UV, color, shade, n, look, true, bark, 1 );
		this.vertex( v.copy( b ).addScaledVector( side, - w1 ), ...SOLID_UV, color, shade, n, look, true, bark, 1 );
		this.I.push( i, i + 1, i + 2, i, i + 2, i + 3 );

	}

	// A folded leaf with a raised midrib, as on the rim bushes: base, two flanks, the fold, tip.
	leaf( p: THREE.Vector3, along: THREE.Vector3, n: THREE.Vector3, L: number, W: number, fold: number, color: RGB, shade: number, look: Look ): void {

		const width = new THREE.Vector3().crossVectors( n, along ).normalize();
		const v = new THREE.Vector3();
		this.beginLeaf( v.copy( p ).addScaledVector( along, L * 0.5 ) );
		const i = this.vertex( p, 0.5, 0, color, shade * 0.82, n, look, false, false, 0.3 );
		this.vertex( v.copy( p ).addScaledVector( along, L * 0.48 ).addScaledVector( width, - W * 0.5 ), 0, 0.5, color, shade, n, look, false, false, 0.7 );
		this.vertex( v.copy( p ).addScaledVector( along, L * 0.51 ).addScaledVector( n, fold ), 0.5, 0.5, color, shade * 1.03, n, look, false, false, 0.7 );
		this.vertex( v.copy( p ).addScaledVector( along, L * 0.48 ).addScaledVector( width, W * 0.5 ), 1, 0.5, color, shade, n, look, false, false, 0.7 );
		this.vertex( v.copy( p ).addScaledVector( along, L ).addScaledVector( n, fold * 0.32 ), 0.5, 1, color, shade * 1.04, n, look, false, false, 1 );
		this.I.push( i, i + 1, i + 2, i + 1, i + 4, i + 2, i, i + 2, i + 3, i + 2, i + 4, i + 3 );
		this.endLeaf();

	}

	// A large leaf blade that arches and droops along its length: rows of edge, midrib, edge.
	blade( p: THREE.Vector3, along: THREE.Vector3, n: THREE.Vector3, L: number, W: number, fold: number, droop: number, color: RGB, shade: number, look: Look, rows = 4 ): void {

		const width = new THREE.Vector3().crossVectors( n, along ).normalize();
		const c = new THREE.Vector3(), v = new THREE.Vector3(), rowN = new THREE.Vector3();
		const first = this.P.length / 3;
		this.beginLeaf( c.copy( p ).addScaledVector( along, L * 0.5 ).addScaledVector( UP, - droop * 0.25 ) );
		for ( let r = 0; r <= rows; r ++ ) {

			const t = r / rows;
			// the blade bends down toward its tip
			c.copy( p ).addScaledVector( along, L * t ).addScaledVector( UP, - droop * t * t );
			rowN.copy( n ).addScaledVector( along, droop * 2 * t / L ).normalize();
			const s = shade * ( 0.84 + 0.2 * t );
			this.vertex( v.copy( c ).addScaledVector( width, - W * 0.5 ).addScaledVector( rowN, - fold * 0.4 ), 0, t, color, s, rowN, look, false, false, t );
			this.vertex( v.copy( c ).addScaledVector( rowN, fold ), 0.5, t, color, s * 1.04, rowN, look, false, false, t );
			this.vertex( v.copy( c ).addScaledVector( width, W * 0.5 ).addScaledVector( rowN, - fold * 0.4 ), 1, t, color, s, rowN, look, false, false, t );

		}
		for ( let r = 0; r < rows; r ++ ) {

			const a = first + r * 3, b = a + 3;
			this.I.push( a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2 );

		}
		this.endLeaf();

	}

	// A round, tapering limb along `points`. A limb that leaves its parent thinner than a shadow
	// texel stays out of the sun's map, like the stalks. The flag is one per limb, not per ring: a
	// triangle with masked and unmasked corners would stretch to the origin in the shadow pass
	// (masked corners collapse there) and cast a long straight streak across the meadow.
	tube( points: THREE.Vector3[], radii: number[], sides: number, color: RGB, look: Look ): void {

		const first = this.P.length / 3;
		const stem = Math.max( ...radii ) < 0.03;
		const t = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), dir = new THREE.Vector3(), v = new THREE.Vector3();
		for ( let k = 0; k < points.length; k ++ ) {

			t.subVectors( points[ Math.min( k + 1, points.length - 1 ) ], points[ Math.max( k - 1, 0 ) ] ).normalize();
			a.set( 1, 0, 0 );
			if ( Math.abs( t.x ) > 0.9 ) a.set( 0, 0, 1 );
			a.addScaledVector( t, - a.dot( t ) ).normalize();
			b.crossVectors( t, a );
			const shade = 0.75 + 0.25 * Math.min( 1, points[ k ].y / 1.5 );
			for ( let s = 0; s <= sides; s ++ ) {

				const angle = s / sides * Math.PI * 2;
				dir.copy( a ).multiplyScalar( Math.cos( angle ) ).addScaledVector( b, Math.sin( angle ) );
				this.vertex( v.copy( points[ k ] ).addScaledVector( dir, radii[ k ] ), ...SOLID_UV, color, shade, dir, look, stem, true );

			}

		}
		for ( let k = 0; k + 1 < points.length; k ++ ) for ( let s = 0; s < sides; s ++ ) {

			const i = first + k * ( sides + 1 ) + s, j = i + sides + 1;
			this.I.push( i, j, i + 1, i + 1, j, j + 1 );

		}

	}

	/** The plant's arrays, in steps. The normals as three's computeVertexNormals makes them (each
	 * triangle's cross product added to its corners in index order, then normalised); then each
	 * leaf keeps its fold's lighting, turned to the side it was grown to face (a double-sided
	 * leaf's winding is arbitrary) and eased toward the plant's rounded mass. */
	*part(): Generator<void, PlantPart> {

		const position = yield* float32Steps( this.P );
		const index = new Uint32Array( this.I.length );
		for ( let k = 0; k < this.I.length; k += 1 << 14 ) {

			index.set( this.I.slice( k, Math.min( k + ( 1 << 14 ), this.I.length ) ), k );
			yield;

		}
		const n = new Float32Array( position.length );
		for ( let t = 0; t < index.length; t += 3 ) {

			if ( t % ( 3 * 2048 ) === 3 * 2047 ) yield;
			const a = index[ t ], bb = index[ t + 1 ], c = index[ t + 2 ];
			const ax = position[ a * 3 ], ay = position[ a * 3 + 1 ], az = position[ a * 3 + 2 ];
			const bx = position[ bb * 3 ], by = position[ bb * 3 + 1 ], bz = position[ bb * 3 + 2 ];
			const cx = position[ c * 3 ] - bx, cy = position[ c * 3 + 1 ] - by, cz = position[ c * 3 + 2 ] - bz;
			const ex = ax - bx, ey = ay - by, ez = az - bz;
			const x = cy * ez - cz * ey, y = cz * ex - cx * ez, z = cx * ey - cy * ex;
			n[ a * 3 ] += x; n[ a * 3 + 1 ] += y; n[ a * 3 + 2 ] += z;
			n[ bb * 3 ] += x; n[ bb * 3 + 1 ] += y; n[ bb * 3 + 2 ] += z;
			n[ c * 3 ] += x; n[ c * 3 + 1 ] += y; n[ c * 3 + 2 ] += z;

		}
		yield;
		const v = new THREE.Vector3(), want = new THREE.Vector3(), env = new THREE.Vector3();
		for ( let i = 0; i < n.length / 3; i ++ ) {

			if ( i % 2048 === 2047 ) yield;
			v.fromArray( n, i * 3 );
			want.set( this.intended.get( i * 3 ), this.intended.get( i * 3 + 1 ), this.intended.get( i * 3 + 2 ) );
			if ( v.lengthSq() < 1e-8 ) v.copy( want );
			if ( v.dot( want ) < 0 ) v.negate();
			const w = this.envelopeWeight.get( i );
			env.set( this.envelope.get( i * 3 ), this.envelope.get( i * 3 + 1 ), this.envelope.get( i * 3 + 2 ) );
			v.normalize().multiplyScalar( 1 - w ).add( env.multiplyScalar( w ) ).normalize();
			v.toArray( n, i * 3 );

		}
		yield;
		const uv = yield* float32Steps( this.U ), color = yield* float32Steps( this.C ), motion = yield* float32Steps( this.M );
		const root = yield* float32Steps( this.R ), wind = yield* float32Steps( this.W ), leaf = yield* float32Steps( this.L );
		return { position, uv, color, normal: n, motion, root, wind, leaf, index };

	}

}

const pick = <T>( rng: Rng, list: T[] ): T => list[ Math.floor( rng() * list.length ) ];
const tint = ( rng: Rng, c: RGB, spread = 0.3 ): RGB => {

	const k = 1 - spread / 2 + rng() * spread;
	return [ c[ 0 ] * k, c[ 1 ] * k, c[ 2 ] * k ];

};
const randomUnit = ( rng: Rng, out = new THREE.Vector3() ) => {

	const z = rng() * 2 - 1, a = rng() * Math.PI * 2, r = Math.sqrt( 1 - z * z );
	return out.set( r * Math.cos( a ), z, r * Math.sin( a ) );

};

type Grower = ( b: PlantBuilder, rng: Rng, H: number ) => Generator<void, void>;

// Branching sprays of opposite leaf pairs around a centre, as on the rim bushes; `outward`
// biases them away from the plant's middle so the mass reads round.
function* leafCluster( b: PlantBuilder, rng: Rng, centre: THREE.Vector3, radius: number, sprays: number, middle: THREE.Vector3,
	extent: number, leafSize: [ number, number ], color: RGB, height: number, lift = 0.45 ): Generator<void, void> {

	const dir = new THREE.Vector3(), across = new THREE.Vector3(), start = new THREE.Vector3(), end = new THREE.Vector3();
	const p = new THREE.Vector3(), n = new THREE.Vector3(), along = new THREE.Vector3(), out = new THREE.Vector3(), j = new THREE.Vector3();
	const twig: RGB = [ 0.42, 0.31, 0.17 ];
	for ( let s = 0; s < sprays; s ++ ) {

		if ( s % 4 === 3 ) yield;
		out.subVectors( centre, middle ).setY( 0 );
		if ( out.lengthSq() > 1e-6 ) out.normalize();
		dir.copy( randomUnit( rng, j ) ).addScaledVector( out, 0.7 ).addScaledVector( UP, lift ).normalize();
		across.crossVectors( UP, dir );
		if ( across.lengthSq() < 1e-4 ) across.set( 1, 0, 0 );
		across.normalize();
		const length = radius * ( 0.6 + rng() * 0.45 );
		start.copy( centre ).add( randomUnit( rng, j ).multiplyScalar( radius * 0.25 ) );
		end.copy( start ).addScaledVector( dir, length );
		const phase = rng() * Math.PI * 2;
		const sprayBase = start.clone(), sprayReach = length + leafSize[ 1 ];
		const look = ( q: THREE.Vector3 ): Look => ( {
			envelope: new THREE.Vector3().subVectors( q, middle ).normalize(), envelopeWeight: 0.24,
			light: 0.25 + 0.75 * Math.min( 1, q.distanceTo( middle ) / extent ), phase, flutter: 0.006,
			base: sprayBase, reach: sprayReach,
		} );
		b.stalk( start, end, 0.005, 0.0018, twig, 0.5, look( start ) );
		const pairs = Math.max( 3, Math.min( 7, Math.round( length / 0.075 ) ) );
		for ( let k = 0; k < pairs; k ++ ) for ( const side of [ - 1, 1 ] ) {

			const t = 0.12 + k / pairs * 0.86 + ( rng() - 0.5 ) * 0.06;
			p.copy( start ).addScaledVector( dir, length * t ).addScaledVector( across, side * 0.008 );
			n.copy( dir ).multiplyScalar( 0.38 ).addScaledVector( UP, 0.65 );
			n.add( j.set( ( rng() - 0.5 ) * 0.7, ( rng() - 0.5 ) * 0.35, ( rng() - 0.5 ) * 0.7 ) ).normalize();
			along.copy( across ).multiplyScalar( side ).addScaledVector( dir, 0.3 + rng() * 0.25 );
			along.addScaledVector( n, - along.dot( n ) ).normalize();
			const L = ( leafSize[ 0 ] + rng() * ( leafSize[ 1 ] - leafSize[ 0 ] ) ) * ( k === pairs - 1 ? 0.8 : 1 );
			const W = L * ( 0.48 + rng() * 0.18 );
			const shade = 0.62 + 0.28 * Math.min( 1, p.y / height ) + rng() * 0.16;
			b.leaf( p, along, n, L, W, L * ( 0.08 + rng() * 0.07 ), color, shade, look( p ) );

		}

	}

}

// A rounded shrub of several offset crowns on woody stems, knee to head high. Two leaf
// families: dense small leaves, or looser larger ones in fresher greens.
function* roundShrub( b: PlantBuilder, rng: Rng, H: number ): Generator<void, void> {

	const small = rng() < 0.55;
	const color = tint( rng, pick( rng, small ? PALETTES.smallLeaf : PALETTES.largeLeaf ) );
	const leafSize: [ number, number ] = small ? [ 0.095, 0.145 ] : [ 0.15, 0.22 ];
	const middle = new THREE.Vector3( 0, H * 0.42, 0 );
	b.bend = ( q ) => 0.022 * Math.min( 1, Math.max( 0, q.y ) / Math.max( 0.72, H * 0.8 ) );
	const crowns = 4 + Math.round( H * 3 );
	const stemLook: Look = { envelope: UP, envelopeWeight: 0, light: 0.2, phase: rng() * 6.28, flutter: 0 };
	for ( let c = 0; c < crowns; c ++ ) {

		const top = c === crowns - 1;
		const cr = H * ( 0.26 + rng() * 0.1 );
		const a = c / crowns * Math.PI * 2 + ( rng() - 0.5 ) * 0.9;
		const ring = top ? H * 0.05 : H * ( 0.16 + rng() * 0.16 );
		// the lower crowns sit down on the ground, so no bare stems show under the mass
		const centre = new THREE.Vector3( Math.cos( a ) * ring, top ? H - cr * 1.05 : Math.max( cr * 0.75, H * ( 0.24 + rng() * 0.26 ) ), Math.sin( a ) * ring );
		b.tube( [ new THREE.Vector3( 0, - 0.02, 0 ), centre.clone().multiplyScalar( 0.5 ).setY( centre.y * 0.45 ), centre ], [ 0.022, 0.015, 0.008 ], 4, BARK, stemLook );
		// sprays spread level as much as up: a shrub is leafy down to its skirt
		yield* leafCluster( b, rng, centre, cr, Math.round( ( small ? 16 : 10 ) + cr * ( small ? 30 : 18 ) ), middle, H * 0.6, leafSize, color, H, 0.12 );

	}

}

// A clump of large, broad leaves on long stalks from one crown: the old leaves spread low and
// wide, the young ones stand up in the middle.
function* broadleafClump( b: PlantBuilder, rng: Rng, H: number ): Generator<void, void> {

	const color = tint( rng, pick( rng, PALETTES.broadleaf ) );
	b.bend = ( q ) => 0.018 * Math.min( 1, Math.max( 0, q.y ) / H );
	const count = 11 + Math.floor( rng() * 6 );
	// successive leaves turn by the golden angle, as in a rosette (H. Vogel's phyllotaxis, 1979)
	const golden = Math.PI * ( 3 - Math.sqrt( 5 ) );
	const offset = rng() * Math.PI * 2;
	const dirH = new THREE.Vector3(), base = new THREE.Vector3(), tip = new THREE.Vector3(), mid = new THREE.Vector3();
	const along = new THREE.Vector3(), n = new THREE.Vector3(), width = new THREE.Vector3();
	for ( let i = 0; i < count; i ++ ) {

		if ( i % 4 === 3 ) yield;
		const young = i / count; // later leaves are younger: smaller, more upright, inside
		const a = offset + i * golden + ( rng() - 0.5 ) * 0.4;
		dirH.set( Math.cos( a ), 0, Math.sin( a ) );
		const rise = THREE.MathUtils.degToRad( 38 + 30 * young + rng() * 14 );
		const stalkLength = H * ( 0.35 + rng() * 0.25 ) * ( 1 - 0.3 * young );
		base.copy( dirH ).multiplyScalar( 0.03 );
		tip.copy( base ).addScaledVector( dirH, Math.cos( rise ) * stalkLength ).addScaledVector( UP, Math.sin( rise ) * stalkLength );
		mid.lerpVectors( base, tip, 0.5 ).addScaledVector( UP, stalkLength * 0.06 );
		const look: Look = { envelope: dirH.clone().addScaledVector( UP, 0.8 ).normalize(), envelopeWeight: 0.15,
			light: 0.45 + 0.55 * ( 1 - young * 0.4 ), phase: rng() * Math.PI * 2, flutter: 0.012, base: base.clone(), reach: stalkLength + H * 0.8 };
		b.stalk( base, mid, 0.008, 0.006, STALK, 0.6, look );
		b.stalk( mid, tip, 0.006, 0.004, STALK, 0.7, look );
		const L = THREE.MathUtils.clamp( H * ( 0.5 + rng() * 0.3 ) * ( 1 - 0.35 * young ), 0.16, 0.42 );
		const lift = THREE.MathUtils.degToRad( 8 + 30 * young + rng() * 12 );
		along.copy( dirH ).multiplyScalar( Math.cos( lift ) ).addScaledVector( UP, Math.sin( lift ) ).normalize();
		width.crossVectors( UP, dirH ).normalize();
		n.crossVectors( along, width ).normalize();
		if ( n.y < 0 ) n.negate();
		b.blade( tip, along, n, L, L * ( 0.62 + rng() * 0.12 ), L * 0.05, L * ( 0.18 + rng() * 0.22 ) * ( 1 - young * 0.6 ),
			color, 0.72 + rng() * 0.2, look );

	}

}

// A fern: pinnate fronds rising from one crown and arching out, leaflets shortening toward
// the base and the tip; a few young fronds still stand upright.
function* fern( b: PlantBuilder, rng: Rng, H: number ): Generator<void, void> {

	const color = tint( rng, pick( rng, PALETTES.fern ) );
	b.bend = ( q ) => 0.01 * Math.min( 1, Math.max( 0, q.y ) / H );
	const fronds = 9 + Math.floor( rng() * 6 );
	const golden = Math.PI * ( 3 - Math.sqrt( 5 ) );
	const offset = rng() * Math.PI * 2;
	const dirH = new THREE.Vector3(), p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), p2 = new THREE.Vector3();
	const c = new THREE.Vector3(), tan = new THREE.Vector3(), side = new THREE.Vector3(), nf = new THREE.Vector3();
	const along = new THREE.Vector3(), n = new THREE.Vector3(), prev = new THREE.Vector3();
	const at = ( t: number, out: THREE.Vector3 ) => out.set( 0, 0, 0 ).addScaledVector( p0, ( 1 - t ) * ( 1 - t ) ).addScaledVector( p1, 2 * t * ( 1 - t ) ).addScaledVector( p2, t * t );
	for ( let f = 0; f < fronds; f ++ ) {

		yield;
		const young = rng() < 0.18;
		const a = offset + f * golden + ( rng() - 0.5 ) * 0.5;
		dirH.set( Math.cos( a ), 0, Math.sin( a ) );
		const reach = H * ( young ? 0.35 : 0.85 + rng() * 0.35 );
		p0.copy( dirH ).multiplyScalar( 0.025 );
		p1.copy( p0 ).addScaledVector( UP, H * ( young ? 1.1 : 1.3 + rng() * 0.2 ) ).addScaledVector( dirH, reach * 0.3 );
		p2.copy( p0 ).addScaledVector( dirH, reach ).addScaledVector( UP, H * ( young ? 0.95 : 0.35 + rng() * 0.3 ) );
		const look: Look = { envelope: dirH.clone().addScaledVector( UP, 0.6 ).normalize(), envelopeWeight: 0.12, light: 0.85, phase: rng() * Math.PI * 2, flutter: 0.016,
			base: p0.clone(), reach: p0.distanceTo( p2 ) };
		const segments = 6;
		prev.copy( p0 );
		for ( let s = 1; s <= segments; s ++ ) {

			at( s / segments, c );
			look.light = 0.45 + 0.55 * s / segments;
			b.stalk( prev, c, 0.006 * ( 1 - ( s - 1 ) / segments ) + 0.002, 0.006 * ( 1 - s / segments ) + 0.0015, STALK, 0.7, look );
			prev.copy( c );

		}
		const pairs = 12 + Math.floor( rng() * 5 );
		const size = H * ( young ? 0.1 : 0.17 + rng() * 0.05 );
		for ( let k = 0; k < pairs; k ++ ) {

			const t = 0.14 + 0.85 * k / pairs;
			at( t, c );
			at( Math.min( 1, t + 0.01 ), tan ).sub( c ).normalize();
			side.crossVectors( tan, UP );
			if ( side.lengthSq() < 1e-4 ) side.crossVectors( tan, dirH );
			side.normalize();
			nf.crossVectors( side, tan ).normalize();
			if ( nf.y < 0 ) nf.negate();
			const L = size * Math.pow( Math.sin( Math.PI * Math.min( 1, t * 1.02 ) ), 0.6 ) * ( 1 - 0.3 * t ) + 0.02;
			look.light = 0.5 + 0.5 * t;
			const shade = 0.7 + 0.25 * t + rng() * 0.1;
			for ( const s of [ - 1, 1 ] ) {

				along.copy( side ).multiplyScalar( s ).addScaledVector( tan, 0.5 ).addScaledVector( nf, - 0.15 ).normalize();
				n.copy( nf ).addScaledVector( side, s * 0.25 ).normalize();
				b.leaf( c, along, n, L, L * 0.34, L * 0.06, color, shade, look );

			}

		}

	}

}

// A small tree 2.5 - 3.5 m tall: a leaning, flared trunk forks into four or five limbs that
// spread and turn up, each with a side branch or two. Leaf clusters sit at the branch ends and
// along the limbs, filling a rounded crown that still shows gaps and a few clouds of leaves, as
// young broadleaf trees do.
function* smallTree( b: PlantBuilder, rng: Rng, H: number ): Generator<void, void> {

	const color = tint( rng, pick( rng, PALETTES.tree ), 0.2 );
	b.bend = ( q ) => 0.035 * Math.pow( Math.min( 1, Math.max( 0, q.y ) / H ), 2 );
	const barkLook: Look = { envelope: UP, envelopeWeight: 0, light: 0.6, phase: rng() * 6.28, flutter: 0 };
	const leanA = rng() * Math.PI * 2, lean = 0.05 + rng() * 0.08;
	const leanDir = new THREE.Vector3( Math.cos( leanA ), 0, Math.sin( leanA ) );
	const bendDir = new THREE.Vector3( - leanDir.z, 0, leanDir.x ).multiplyScalar( rng() < 0.5 ? - 1 : 1 );
	const fork = H * ( 0.36 + rng() * 0.08 );
	const R0 = 0.07 + H * 0.011;
	const trunk: THREE.Vector3[] = [], radii: number[] = [];
	const rings = 9;
	for ( let k = 0; k <= rings; k ++ ) {

		const s = k / rings;
		trunk.push( new THREE.Vector3().addScaledVector( leanDir, lean * fork * s * s ).addScaledVector( bendDir, 0.05 * Math.sin( Math.PI * s ) ).setY( fork * s - 0.05 ) );
		radii.push( R0 * ( 1 - 0.3 * s ) * ( 1 + 0.55 * Math.pow( Math.max( 0, 1 - s / 0.14 ), 2 ) ) );

	}
	b.tube( trunk, radii, 8, BARK, barkLook );
	const top = trunk[ rings ];
	const scale = H / 3;
	// the crown's rounded mass, for the leaves' light and the limbs' reach
	const crown = new THREE.Vector3( top.x, H * 0.66, top.z );
	const crownR = H * 0.36;
	const clusters: { centre: THREE.Vector3; radius: number }[] = [];
	// A limb that leaves `from` along `dir` and turns up toward its end.
	const limb = ( from: THREE.Vector3, dir: THREE.Vector3, length: number, r0: number, r1: number, rise: number ) => {

		const points: THREE.Vector3[] = [], rs: number[] = [];
		const wobble = randomUnit( rng ).multiplyScalar( length * 0.06 );
		for ( let k = 0; k <= 5; k ++ ) {

			const s = k / 5;
			points.push( from.clone().addScaledVector( dir, length * s ).addScaledVector( UP, length * rise * s * s )
				.addScaledVector( wobble, Math.sin( Math.PI * s ) ) );
			rs.push( THREE.MathUtils.lerp( r0, r1, Math.pow( s, 0.8 ) ) );

		}
		b.tube( points, rs, r0 > 0.03 ? 6 : 4, BARK, barkLook );
		return points;

	};
	const limbs = 4 + ( rng() < 0.45 ? 1 : 0 );
	const a0 = rng() * Math.PI * 2;
	for ( let l = 0; l < limbs; l ++ ) {

		const a = a0 + l / limbs * Math.PI * 2 + ( rng() - 0.5 ) * 0.8;
		const rise = THREE.MathUtils.degToRad( 24 + rng() * 26 );
		const dir = new THREE.Vector3( Math.cos( a ) * Math.cos( rise ), Math.sin( rise ), Math.sin( a ) * Math.cos( rise ) );
		// limbs leave the trunk at staggered heights just below the fork
		const from = top.clone().addScaledVector( UP, - rng() * 0.18 * scale );
		const length = H * ( 0.3 + rng() * 0.14 );
		const points = limb( from, dir, length, R0 * 0.55, 0.018, 0.35 + rng() * 0.25 );
		const end = points[ points.length - 1 ];
		clusters.push( { centre: end.clone().addScaledVector( UP, 0.1 * scale ), radius: ( 0.5 + rng() * 0.2 ) * scale } );
		clusters.push( { centre: points[ 3 ].clone().addScaledVector( UP, 0.18 * scale ), radius: ( 0.38 + rng() * 0.12 ) * scale } );
		const sides = 1 + ( rng() < 0.5 ? 1 : 0 );
		for ( let k = 0; k < sides; k ++ ) {

			// a side branch from the limb's middle, turned off to one side
			const at = points[ 2 + k ];
			const side = new THREE.Vector3( - dir.z, 0.3, dir.x ).multiplyScalar( ( k + l ) % 2 ? - 1 : 1 ).add( dir ).normalize();
			const twig = limb( at, side, H * ( 0.13 + rng() * 0.08 ), 0.026, 0.012, 0.4 );
			clusters.push( { centre: twig[ twig.length - 1 ].clone().addScaledVector( UP, 0.06 ), radius: ( 0.36 + rng() * 0.14 ) * scale } );

		}

	}
	// the leader carries the crown's top
	const leader = limb( top, new THREE.Vector3( lean, 1, 0 ).normalize(), H - fork - 0.65 * scale, R0 * 0.5, 0.018, 0 );
	clusters.push( { centre: leader[ leader.length - 1 ].clone(), radius: 0.6 * scale } );
	clusters.push( { centre: leader[ 3 ].clone(), radius: 0.45 * scale } );
	yield;
	const extent = Math.max( ...clusters.map( ( c ) => c.centre.distanceTo( crown ) + c.radius ), crownR );
	for ( const c of clusters ) {

		// pull outlying clusters a little toward the crown so it reads as one rounded mass
		const pull = Math.max( 0, c.centre.distanceTo( crown ) - crownR ) * 0.3;
		c.centre.addScaledVector( new THREE.Vector3().subVectors( crown, c.centre ).normalize(), pull );
		yield* leafCluster( b, rng, c.centre, c.radius, Math.round( 12 + c.radius * 28 ), crown, extent, [ 0.13, 0.2 ], tint( rng, color, 0.14 ), H );

	}

}

const GROW: Record<number, Grower> = {
	[ PLANT_ROUND ]: roundShrub, [ PLANT_BROADLEAF ]: broadleafClump, [ PLANT_FERN ]: fern, [ PLANT_TREE ]: smallTree,
};

/** One plant of `sites` (its PLANT_STRIDE floats at `k`), grown in steps. */
function* growPlant( sites: Float32Array, k: number ): Generator<void, PlantPart> {

	const [ kind, x, y, z, nx, ny, nz, height, , seed, visibility ] = sites.subarray( k, k + PLANT_STRIDE );
	const b = new PlantBuilder();
	b.seed = seed;
	const rng = mulberry32( seed );
	// shrubs follow the ground a little; trees grow toward the light
	const tilt = new THREE.Vector3( nx, ny, nz ).lerp( UP, kind === PLANT_TREE ? 1 : 0.5 ).normalize();
	b.place( x, y, z, visibility, height, rng() * Math.PI * 2, tilt );
	yield* GROW[ kind ]( b, rng, height );
	return yield* b.part();

}

/** The plants grown so far, by site: a grow grows only the plants it has not grown yet. */
export class PlantCache {

	private parts = new Map<string, PlantPart>();

	/** The parts of every plant of `sites`, in order, grown where missing (in steps). */
	*grow( sites: Float32Array ): Generator<void, PlantPart[]> {

		const out: PlantPart[] = [];
		for ( let k = 0; k < sites.length; k += PLANT_STRIDE ) {

			const id = siteKey( sites, k );
			let part = this.parts.get( id );
			if ( ! part ) part = yield* growPlant( sites, k );
			out.push( part );

		}
		return out;

	}

	/** Keep only the plants of `sites` (after a swap, or at load), with their parts. */
	keep( sites: Float32Array, parts: PlantPart[] ): void {

		this.parts = new Map();
		for ( let k = 0, i = 0; k < sites.length; k += PLANT_STRIDE, i ++ ) this.parts.set( siteKey( sites, k ), parts[ i ] );

	}

}

const siteKey = ( sites: Float32Array, k: number ) => Array.prototype.join.call( sites.subarray( k, k + PLANT_STRIDE ), ',' );

/** A cell of the plants: its plants' range in the near meshes' index and in the far mesh's, the
 * box of their roots and the box they may be drawn in. */
export interface PlantCell { start: number; count: number; farStart: number; farCount: number; box: THREE.Box3; bounds: THREE.Box3 }

// What a plant may be drawn beyond its vertices' box (m): a gale's bend (as the bounding sphere's
// room) and a leaf grown by the far share, 1 / sqrt( 0.45 ) of a leaf's half length.
const DRAWN_ROOM = 0.75;

/** The merged geometry of a land's plants (null: none) with every leaf, the far mesh's geometry
 * (the same vertices, the share PLANT_LOD.keep of the leaves), the near meshes' cells, the parts it
 * holds and their sites. */
export interface PlantsBuilt { geometry: THREE.BufferGeometry | null; far: THREE.BufferGeometry | null; cells: PlantCell[]; sites: Float32Array; parts: PlantPart[] }

// The plants' order in the merged geometry: by cell ( row, column ), the sites' order within a cell,
// so each cell's triangles follow one another.
function cellOrder( sites: Float32Array ): { order: number[]; keys: number[] } {

	const keys: number[] = [];
	for ( let k = 0; k < sites.length; k += PLANT_STRIDE ) {

		const cx = Math.floor( sites[ k + 1 ] / LOD_CELL ), cz = Math.floor( sites[ k + 3 ] / LOD_CELL );
		keys.push( ( cz + 4096 ) * 8192 + cx + 4096 );

	}
	const order = keys.map( ( _, i ) => i ).sort( ( i, j ) => keys[ i ] - keys[ j ] || i - j );
	return { order, keys };

}

const _point = new THREE.Vector3();

/** The plants of `sites` as one geometry, in steps (the growth's idle time, Growth.ts): the parts
 * `cache` lacks grown, then every part copied in order into the merged arrays, a part a step, and
 * the far mesh's index (the triangles of bark, stalks and the leaves ranked below PLANT_LOD.keep). */
export function* plantSteps( sites: Float32Array, cache: PlantCache ): Generator<void, PlantsBuilt> {

	const parts = yield* cache.grow( sites );
	if ( ! parts.length ) return { geometry: null, far: null, cells: [], sites, parts };
	const { order, keys } = cellOrder( sites );
	let vertices = 0, indices = 0, farIndices = 0;
	for ( const p of parts ) {

		vertices += p.position.length / 3;
		indices += p.index.length;
		for ( let t = 0; t < p.index.length; t += 3 ) if ( p.leaf[ p.index[ t ] * 4 + 3 ] < PLANT_LOD.keep ) farIndices += 3;

	}
	const arrays = Object.fromEntries( Object.entries( LAYOUT ).map( ( [ name, size ] ) => [ name, new Float32Array( vertices * size ) ] ) ) as Record<keyof typeof LAYOUT, Float32Array>;
	// (the index ends in a triangle of vertex 0 alone: what a near mesh with no cell to draw draws,
	// nothing, where a draw of no index would be flagged by WebGPU)
	const index = new Uint32Array( indices + 3 ), farIndex = new Uint32Array( farIndices + 3 );
	const cells: PlantCell[] = [];
	let v = 0, i = 0, f = 0;
	for ( let o = 0; o < order.length; o ++ ) {

		yield;
		const n = order[ o ], p = parts[ n ], farFirst = f;
		for ( const name of Object.keys( LAYOUT ) as ( keyof typeof LAYOUT )[] ) arrays[ name ].set( p[ name ], v * LAYOUT[ name ] );
		for ( let t = 0; t < p.index.length; t ++ ) index[ i + t ] = p.index[ t ] + v;
		for ( let t = 0; t < p.index.length; t += 3 ) {

			if ( p.leaf[ p.index[ t ] * 4 + 3 ] >= PLANT_LOD.keep ) continue;
			farIndex[ f ++ ] = p.index[ t ] + v; farIndex[ f ++ ] = p.index[ t + 1 ] + v; farIndex[ f ++ ] = p.index[ t + 2 ] + v;

		}
		let cell = cells[ cells.length - 1 ];
		if ( o === 0 || keys[ n ] !== keys[ order[ o - 1 ] ] ) cells.push( cell = { start: i, count: 0, farStart: farFirst, farCount: 0, box: new THREE.Box3(), bounds: new THREE.Box3() } );
		cell.count += p.index.length;
		cell.farCount = f - cell.farStart;
		cell.box.expandByPoint( new THREE.Vector3( sites[ n * PLANT_STRIDE + 1 ], sites[ n * PLANT_STRIDE + 2 ], sites[ n * PLANT_STRIDE + 3 ] ) );
		for ( let k = 0; k < p.position.length; k += 3 ) cell.bounds.expandByPoint( _point.fromArray( p.position, k ) );
		v += p.position.length / 3;
		i += p.index.length;

	}
	for ( const cell of cells ) cell.bounds.expandByScalar( DRAWN_ROOM );
	const geometry = new THREE.BufferGeometry();
	for ( const name of Object.keys( LAYOUT ) as ( keyof typeof LAYOUT )[] ) geometry.setAttribute( ATTRIBUTES[ name ], new THREE.BufferAttribute( arrays[ name ], LAYOUT[ name ] ) );
	geometry.setIndex( new THREE.BufferAttribute( index, 1 ) );
	yield* boundsSteps( geometry );
	// Room for the bend: a gale's gust lays a crown over by a few decimetres.
	geometry.boundingSphere!.radius += 0.5;
	const far = sharedGeometry( geometry );
	far.setIndex( new THREE.BufferAttribute( farIndex, 1 ) );
	return { geometry, far, cells, sites, parts };

}

// A geometry drawing `source`'s vertices (the same attributes, so the same GPU buffers) with its
// index, its own draw range and its bounds.
function sharedGeometry( source: THREE.BufferGeometry ): THREE.BufferGeometry {

	const geometry = new THREE.BufferGeometry();
	for ( const [ name, attribute ] of Object.entries( source.attributes ) ) geometry.setAttribute( name, attribute );
	geometry.setIndex( source.getIndex() );
	geometry.boundingBox = source.boundingBox?.clone() ?? null;
	geometry.boundingSphere = source.boundingSphere?.clone() ?? null;
	return geometry;

}

// Per object: 1 for the far mesh's draws (and its depth copy's), 0 for the near meshes'.
const farDraw = uniform( 0 ).onObjectUpdate( ( { object } ) => object?.userData.plantsFar === true ? 1 : 0 );

// A plant's leaves at the share `keep` of them (PLANT_LOD): a leaf ranked at or above the share is
// gone (its scale 0), one within LEAF_FADE below it shrinks toward its centre, and the leaves kept
// grow by 1 / sqrt( keep ) about their centres, so the plant covers about as much as with every
// leaf and its colour holds (after the grass's thinning and widening, Grass.ts `tuftLod`). Bark
// and stalks (rank -1) keep their shape. Returns the position and whether anything is left of it.
function leafShare( p: THREE.Node<'vec3'>, keep: THREE.Node<'float'> ): { position: THREE.Node<'vec3'>; left: THREE.Node<'bool'> } {

	const leaf = attribute<'vec4'>( 'plantLeaf', 'vec4' );
	const scale = clamp( keep.sub( leaf.w ).div( LEAF_FADE ), 0, 1 );
	// (a plant keeping every leaf takes p itself: centre + ( p - centre ) is not always p)
	const shrinks = leaf.w.greaterThanEqual( 0 ).and( keep.lessThan( 1 ) );
	const position = select( shrinks, leaf.xyz.add( p.sub( leaf.xyz ).mul( scale.div( keep.sqrt() ) ) ), p );
	return { position, left: leaf.w.lessThan( 0 ).or( scale.greaterThan( 0 ) ) };

}

function plantMaterial( shared: Shared ): THREE.MeshStandardNodeMaterial {

	const map = leafTexture();
	const motion = attribute<'vec4'>( 'plantMotion', 'vec4' );
	const bark = step( 1.5, motion.y );
	const stem = motion.y.sub( bark.mul( 2 ) );
	// Bark: grey-brown furrows along the stem, from the rest pose so they do not swim in the wind.
	// Leaves skip the noise: only bark fragments take the branch.
	const furrows = Fn( () => {

		const f = float( 1 ).toVar();
		If( bark.greaterThan( 0.5 ), () => {

			const g = positionGeometry;
			const ridge = mx_noise_float( vec3( g.x.mul( 16 ), g.y.mul( 1.8 ), g.z.mul( 16 ) ) ).mul( 0.5 ).add( 0.5 );
			const lichen = mx_noise_float( g.mul( 3.1 ) ).mul( 0.5 ).add( 0.5 );
			f.assign( mix( float( 0.62 ), float( 1.18 ), ridge ).mul( mix( float( 0.95 ), float( 1.25 ), lichen.mul( lichen ) ) ) );

		} );
		return f;

	} )();
	const rest = positionLocal; // the mesh sits at the origin: world space
	const root = attribute<'vec3'>( 'plantRoot', 'vec3' );
	// The level of detail (see the header): the share of its leaves the plant keeps at its distance
	// from the camera, and whether this mesh draws the plant there (the near meshes below
	// PLANT_LOD.far, the far mesh from it on); a plant it does not draw collapses to a point.
	const distance = length( cameraPosition.sub( root ) );
	const lod = leafShare( rest, mix( float( 1 ), float( PLANT_LOD.keep ), smoothstep( PLANT_LOD.near, PLANT_LOD.far, distance ) ) );
	const drawn = farDraw.equal( step( PLANT_LOD.far, distance ) ).and( lod.left );
	const p = lod.position;
	// Three layers, after Sousa (GPU Gems 3, ch. 16): the whole plant bends from its root with the
	// gust field (trees sway at half a shrub's rate); each spray, frond or leaf stalk swings on its
	// own phase, from where it leaves the plant out; each leaf's edges and tip flutter along its
	// normal. Branches and leaves move more in a gust and in a strong wind, and their flutter speeds
	// up with it (the `flutter` clock).
	const amp = attribute<'vec4'>( 'plantWind', 'vec4' );
	const slow = smoothstep( PLANT_WIND.slow[ 0 ], PLANT_WIND.slow[ 1 ], amp.w );
	const local = dot( positionGeometry, vec3( 1.7, 2.3, 1.9 ) );
	let sway: THREE.Node<'vec2'> | undefined;
	return vegetationMaterial( shared, {
		family: 'leaf', name: 'plants', roughness: 0.82, leaf: { map },
		wet: {
			// Wet bark darkens far more than a leaf, whose waxy surface sheds the water.
			tint: ( wetness ) => mix( float( 1 ), mix( float( 0.92 ), float( 0.62 ), bark ), wetness ).mul( furrows ),
			roughness: ( wetness ) => mix( mix( float( 0.82 ), float( 0.9 ), bark ), float( 0.68 ), wetness ),
		},
		rest,
		displacement: ( wind ) => {

			const bend = mainBend( wind, p, root, amp.x, PLANT_WIND.cycles, slow );
			if ( wind === shared.wind ) sway = bend.sway;
			const field = bend.field;
			const along = vec3( field.x, 0, field.y ), across = vec3( field.y.negate(), 0, field.x );
			const lively = wind.breeze.mul( field.w.mul( 0.7 ).add( 0.3 ) );
			const swing = wave( wind.flutter, 0.85, motion.x ).mul( 0.6 ).add( wave( wind.flutter, 1.37, motion.x.mul( 1.9 ).add( local ) ).mul( 0.4 ) );
			const swayBranch = wave( wind.flutter, 0.63, motion.x.mul( 2.3 ) );
			const branch = vec3( 0, swing, 0 ).add( along.mul( swayBranch.mul( 0.5 ).add( 0.35 ) ) ).add( across.mul( swing.mul( 0.4 ) ) ).mul( amp.y.mul( lively ) );
			const edge = normalGeometry.mul( wave( wind.flutter, 4.1, motion.x.mul( 3 ).add( local.mul( 4 ) ) ).mul( amp.z.mul( lively ) ) );
			return select( drawn, bend.position.add( branch ).add( edge ), vec3( 0 ) );

		},
		castMask: float( 1 ).sub( stem ),
		sway: () => sway,
		normal: normalViewGeometry,
		ao: motion.z,
		// leaves: wrapped light and a glow against the sun (`leafTransmission`); bark is opaque
		light: { scale: () => motion.w, extra: ( L, V, N ) => leafTransmission( L, V, N ).mul( float( 1 ).sub( bark ) ) },
	} );

}

// A geometry with the plants' attributes and nothing to draw.
function emptyGeometry(): THREE.BufferGeometry {

	const geometry = new THREE.BufferGeometry();
	for ( const name of Object.keys( LAYOUT ) as ( keyof typeof LAYOUT )[] ) geometry.setAttribute( ATTRIBUTES[ name ], new THREE.BufferAttribute( new Float32Array( LAYOUT[ name ] ), LAYOUT[ name ] ) );
	geometry.setIndex( new THREE.BufferAttribute( new Uint32Array( 0 ), 1 ) );
	geometry.boundingBox = new THREE.Box3();
	geometry.boundingSphere = new THREE.Sphere();
	return geometry;

}

// The draw ranges for a camera. The near meshes draw the cells in view whose roots lie nearer than
// PLANT_LOD.far, in runs of cells that follow one another in the index, the closest runs merged
// until there are NEAR_RANGES at most; the far mesh draws from its first cell in view with a root
// at PLANT_LOD.far or beyond to its last. A merged gap only draws plants the mesh collapses anyway,
// and a cell out of view (its `bounds` outside the camera's frustum) draws nothing: which plant
// draws how is a function of the camera's position alone.
class CellRanges {

	private cells: PlantCell[] = [];
	private key = '';
	private runs: [ number, number ][] = [];
	private farRun: [ number, number ] = [ 0, 0 ];
	// the empty triangles at the indices' ends (plantSteps)
	private none: [ number, number ] = [ 0, 0 ];
	private farNone: [ number, number ] = [ 0, 0 ];

	reset( cells: PlantCell[] ): void {

		this.cells = cells;
		this.key = '';
		const last = cells[ cells.length - 1 ];
		this.none = last ? [ last.start + last.count, 3 ] : [ 0, 0 ];
		this.farNone = last ? [ last.farStart + last.farCount, 3 ] : [ 0, 0 ];

	}

	near( k: number, camera: THREE.Camera ): [ number, number ] {

		this.update( camera );
		return this.runs[ k ] ?? this.none;

	}

	far( camera: THREE.Camera ): [ number, number ] {

		this.update( camera );
		return this.farRun;

	}

	private update( view: THREE.Camera ): void {

		const far = PLANT_LOD.far.value;
		const key = `${ view.matrixWorld.elements.join( ' ' ) } ${ view.projectionMatrix.elements.join( ' ' ) } ${ far }`;
		if ( key === this.key ) return;
		this.key = key;
		const camera = _camera.setFromMatrixPosition( view.matrixWorld );
		_frustum.setFromProjectionMatrix( _matrix.multiplyMatrices( view.projectionMatrix, view.matrixWorldInverse ), view.coordinateSystem, view.reversedDepth );
		this.runs = [];
		let first = - 1, end = 0;
		for ( const cell of this.cells ) {

			if ( ! _frustum.intersectsBox( cell.bounds ) ) continue;
			// (a centimetre's margin for the shader's rounding of a root's distance)
			if ( cell.box.distanceToPoint( camera ) < far + 0.01 ) {

				const last = this.runs[ this.runs.length - 1 ];
				if ( last && last[ 0 ] + last[ 1 ] === cell.start ) last[ 1 ] += cell.count;
				else this.runs.push( [ cell.start, cell.count ] );

			}
			const { min, max } = cell.box;
			const dx = Math.max( camera.x - min.x, max.x - camera.x ), dy = Math.max( camera.y - min.y, max.y - camera.y ), dz = Math.max( camera.z - min.z, max.z - camera.z );
			if ( Math.hypot( dx, dy, dz ) >= far - 0.01 && cell.farCount > 0 ) {

				if ( first < 0 ) first = cell.farStart;
				end = cell.farStart + cell.farCount;

			}

		}
		while ( this.runs.length > NEAR_RANGES ) {

			const gap = ( r: number ) => this.runs[ r + 1 ][ 0 ] - this.runs[ r ][ 0 ] - this.runs[ r ][ 1 ];
			let best = 0;
			for ( let r = 1; r + 1 < this.runs.length; r ++ ) if ( gap( r ) < gap( best ) ) best = r;
			const [ a, b ] = [ this.runs[ best ], this.runs[ best + 1 ] ];
			this.runs.splice( best, 2, [ a[ 0 ], b[ 0 ] + b[ 1 ] - a[ 0 ] ] );

		}
		this.farRun = first < 0 ? this.farNone : [ first, end - first ];

	}

}

const _camera = new THREE.Vector3();
const _frustum = new THREE.Frustum();
const _matrix = new THREE.Matrix4();

/** The plants of `sites` (PlantSites.ts) in world space, in a group (`setPlants` swaps their
 * geometry; `userData.sites` lists them for the tools): NEAR_RANGES near meshes drawing the near
 * cells' plants with every leaf, and the far mesh. `cache` keeps their parts for the growth. */
export function buildPlants( sites: Float32Array, shared: Shared, cache: PlantCache ): THREE.Group {

	const built = runSteps( plantSteps( sites, cache ) );
	cache.keep( built.sites, built.parts );
	const group = new THREE.Group();
	group.name = 'plants';
	const material = plantMaterial( shared );
	const ranges = new CellRanges();
	ranges.reset( built.cells );
	group.userData.ranges = ranges;
	// (the distances, for the tools: `__PONLAI__.plants.userData.lod`)
	group.userData.lod = PLANT_LOD;
	if ( ! built.geometry ) console.warn( 'No shrubs or trees on the first land: a grown island\'s would build their pipelines as they first draw (Plants.ts)' );
	for ( let k = 0; k < NEAR_RANGES; k ++ ) {

		const mesh = new THREE.Mesh( built.geometry ? sharedGeometry( built.geometry ) : emptyGeometry(), material );
		mesh.name = `plantsNear${ k }`;
		mesh.castShadow = false;
		// (the far mesh prints the plants into the rain's map)
		mesh.userData.rainBake = false;
		// the camera's own draw range of the near cells (the depth prepass's copy shares the geometry)
		mesh.onBeforeRender = ( _renderer, _scene, camera ) => {

			const [ start, count ] = ranges.near( k, camera );
			mesh.geometry.setDrawRange( start, count );

		};
		group.add( mesh );

	}
	const far = new THREE.Mesh( built.far ?? emptyGeometry(), material );
	far.name = 'plantsFar';
	far.userData.plantsFar = true;
	far.castShadow = false;
	far.onBeforeRender = ( _renderer, _scene, camera ) => {

		const [ start, count ] = ranges.far( camera );
		far.geometry.setDrawRange( start, count );

	};
	far.userData.rainBake = false;
	group.add( far );
	// Every leaf casts, whatever the camera: the sun's map is drawn only as the sun turns, so a
	// caster that followed the camera would leave the shadows where the camera stood at the last
	// redraw. A mesh of its own on the sun's layer alone, the view never draws it.
	const caster = new THREE.Mesh( built.geometry ? sharedGeometry( built.geometry ) : emptyGeometry(), material );
	caster.name = 'plantsShadow';
	caster.layers.set( SUN_MAP_LAYER );
	caster.castShadow = true;
	group.add( caster );
	for ( const mesh of group.children as THREE.Mesh[] ) {

		mesh.visible = built.geometry !== null;
		mesh.receiveShadow = mesh !== caster;
		mesh.renderOrder = - 1; // before the terrain: the turf it covers then fails the depth test

	}
	group.userData.sites = siteList( sites );
	return group;

}

/** Swaps the plants of `group` (buildPlants) to `built` in place, the depth prepass's copies with
 * them. Returns the geometries replaced, to dispose of once nothing draws them. */
function setPlants( group: THREE.Group, built: PlantsBuilt ): THREE.BufferGeometry[] {

	group.userData.sites = siteList( built.sites );
	( group.userData.ranges as CellRanges ).reset( built.cells );
	const old: THREE.BufferGeometry[] = [];
	for ( const mesh of group.children as THREE.Mesh[] ) {

		const geometry = mesh.userData.plantsFar ? built.far ?? emptyGeometry() : built.geometry ? sharedGeometry( built.geometry ) : emptyGeometry();
		old.push( mesh.geometry );
		for ( const child of mesh.children ) if ( ( child as THREE.Mesh ).geometry === mesh.geometry ) ( child as THREE.Mesh ).geometry = geometry;
		mesh.geometry = geometry;
		mesh.visible = built.geometry !== null;

	}
	return old;

}

/** The plateau's plants as a vegetation kind (vegetation/Registry.ts): a grown island's plants (only
 * those `cache` does not hold) are grown in steps on the sites the growth found, copied into one new
 * geometry, uploaded ahead (the far mesh's index with it) and swapped into the meshes; the cache
 * keeps their parts. */
export function plantsKind( group: THREE.Group, cache: PlantCache ): VegetationKind<PlantsBuilt> {

	return {
		name: 'plants', root: group, prepass: true, shadowFilter: 'vegetation', sunCaster: true, rainBake: true,
		growth: {
			*prepare( input ) {

				const built = yield* plantSteps( input.plantSites, cache );
				if ( built.geometry ) {

					yield* geometrySteps( input.renderer, built.geometry );
					yield* uploadSteps( input.renderer, built.far!.getIndex(), AttributeType.INDEX );

				}
				return built;

			},
			swap( prepared ) {

				const old = setPlants( group, prepared );
				cache.keep( prepared.sites, prepared.parts );
				return () => {

					for ( const geometry of old ) geometry.dispose();

				};

			},
		},
	};

}

const KINDS = [ 'round', 'broadleaf', 'fern', 'tree' ];

/** The sites as objects, for the tools (the parity views find the trees by them: `kind`, foot
 * `x`, `y`, `z`, `height`, `radius`). */
function siteList( sites: Float32Array ): { kind: string; x: number; y: number; z: number; height: number; radius: number }[] {

	const out = [];
	for ( let k = 0; k < sites.length; k += PLANT_STRIDE ) out.push( { kind: KINDS[ sites[ k ] ], x: sites[ k + 1 ], y: sites[ k + 2 ], z: sites[ k + 3 ], height: sites[ k + 7 ], radius: sites[ k + 8 ] } );
	return out;

}

/** The box of the drawn plants (empty when there are none): the sea's reflection box and the sun's
 * casters grow to hold it. */
export function plantsBox( group: THREE.Group ): THREE.Box3 {

	const mesh = group.getObjectByName( 'plantsShadow' ) as THREE.Mesh;
	return mesh.visible && mesh.geometry.boundingBox ? mesh.geometry.boundingBox.clone() : new THREE.Box3();

}
