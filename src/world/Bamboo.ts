import * as THREE from 'three/webgpu';
import type { Shared } from '../shared.ts';
import { BAMBOO_PARTS, bambooMaterials } from './BambooMaterials.ts';
import { AIR_DENSITY, REFERENCE_SPEED, logLaw } from '../weather/Wind.ts';
import { CROWN_DRAG } from './vegetation/Deform.ts';
import { GROVES, plantCulms, plantShoots, type CulmSite, type ShootSite } from './BambooGroves.ts';
import { mulberry32, type Rng } from './noise.ts';
import { SEABED_TILE } from './SeabedTile.ts';
import { runSteps } from './Steps.ts';
import { islandSurfaceHeight } from './WorldShapes.ts';
import type { WorldData } from './types.ts';
import { PLANT_PART, PlantInstances, levelDraws, type PlantDraw, type PlantInstance, type PlantPool } from './vegetation/PlantInstances.ts';
import type { KindGrowth, VegetationKind } from './vegetation/Registry.ts';
import { BRANCH_ATTRIBUTES, MeshBuilder, UP, branchValues, leafLayout, smooth, sprayValues, streamAt } from './vegetation/TreeMesh.ts';
import type { LeafAtlas } from './vegetation/TreeSurfaces.ts';

// Penglai's bamboo (浮筠之簳): "green leaves, purple stems, seeds as big as pearls" (Wang Jia, Shiyi
// ji, book 10, on Penglai), the one plant that text gives the island itself, the wind in its leaves
// ringing like bells and chimes. Its real kin is the purple (black) bamboo, Phyllostachys nigra: a
// running bamboo whose culms come up green and turn purple-black in their second or third year,
// a white bloom of wax under each node, the narrow leaves in fans at the twigs' ends. It grows over
// the whole island in groves and single culms (BambooGroves.ts: where each culm stands, its
// height, girth, age, lean and bow); this module builds the culms there. The text gives the
// bamboo its origin, not its look: here the stems are a mid to dark green, the leaves' family, and
// a dim dusty purple stays on a minority of old culms at the same lightness, the old lore kept on a
// few stems (BambooMaterials.ts).
//
// A culm's form, after groves of Phyllostachys:
// - Straight internodes, short at the foot and longer up the culm (about three times its girth), a
//   ridge at each node; leaning and bowing over at the top in an arc as its site says.
// - The branches: from a little over halfway up, at every node, alternately to one side and the other
//   (turned toward the way the culm leans), longest in the middle of the leafy part and short (an
//   eighth of the culm), rising and then drooping; a small tuft at the culm's top. Below them the
//   culm stands bare.
// - The leaves: a few sprays of narrow leaves on cards along each branch's outer part, hanging out
//   along it and facing up (BambooMaterials.ts's atlas), so a culm's leaves hang in loose drooping
//   layers with the sky and the culms showing between them, not a ball of foliage; their normals
//   bent out from the culm and up, the inner ones darker (the cards' vertex colours).
// - A culm's lower part sees the sky only through its grove's canopy (by its grove's density and
//   the point's share of its height, as BambooGroves.ts `groveSky`), so a grove is dark inside; the
//   material takes it only without the ambient volume, which sees the canopy itself
//   (BambooMaterials.ts).
// - The young bamboo on the groves' floor (BambooGroves.ts `plantShoots`): a few sprays fanning out
//   and drooping from a low point, in the leaves' draws, darker the deeper in a grove (BAMBOO.shoot).
// Each culm bends in the one wind from its own foot (its instance's), most at its top (`leafSway` x,
// its yield ( 1 - stiffness ) eta^2, and w, eta, the share of its height) and by its wind load, its
// crown's drag over its stiffness (`culmLoad`: its height over its radius to the fourth), each at
// its own rate and phase (Deform.ts mainBend), so the culms swing apart rather than as one; each
// spray flutters from its twig on its own phase as the gusts pass (Deform.ts leafFlutter). Each
// branch and the cards on it swing on their own about its start, bent downwind the more the wind
// crosses it (Deform.ts branchBend, its start and end and yield on every vertex: TreeMesh.ts
// BRANCH_ATTRIBUTES), its yield from its thickness (BAMBOO.branchStiffness), and each spray on its
// branch again (Deform.ts sprayBend, from the card's foot along it).
// A prototype's form draws from one stream seeded by its number; its cards from a stream of their
// own (TreeMesh.ts streamAt).
//
// Drawn as instances (vegetation/PlantInstances.ts): a few prototypes, each one upright culm with
// its branches and leaves built at the origin (BAMBOO.prototypes: a band of heights by a band of
// girths, each from a fixed seed, so the same on every page), and the young shoots' one; every site
// an instance of the nearest, scaled to its height and girth, turned to the way it leans, leaning
// and bowing by its site (`stemAxis`, the curve this module built each culm along), its age, grove
// and leaf tone carried per instance (`look`). The instance's wind is read at its own foot, so each
// culm still swings on its own. Each prototype has a far level (BAMBOO.far: a culm of four sides, a
// ring at each node, half its leaf cards, the outer ones kept and enlarged to keep its cover) that
// takes over where its culm is a few pixels wide (vegetation/Lod.ts LEVEL_SWITCH).
//
// Two vegetation kinds: the culms and branches (an ordinary shadow, no depth prepass) and the
// leaves (the vegetation's shadow filter and depth prepass, drawn before the terrain), each a group
// of the prototypes' draws, from one GPU cull. The instances are a function of the sites, and the
// sites of the rim ground (BambooGroves.ts), planted per land chunk in the chunks' order ( cj, ci ),
// so the bamboo follows the land's version: a growth step plants every land chunk again and, where
// the sites changed, fills a new instance pool in idle-time steps and uploads it, and the swap
// points the cull at it (PlantInstances.ts `prepare`, `swap`): the prototypes, materials and
// pipelines stay (Growth.ts). Not yet: the game's planting and cutting.

export const BAMBOO = {
	internode: [ 0.1, 0.24 ] as const, // internode length at the foot and up the culm (m, of a 7.2 m culm)
	branches: 0.55, // branches from this share of a culm's height up
	branch: 0.12, // the longest branch (of the height)
	card: 0.5, // a leaf card's side (m)
	flutter: 0.035, // a card's flutter at its tip in a gust's core (m: Deform.ts leafFlutter, A_l; the weight from its twig to its tip squared)
	sprayStiffness: 0.3, // a spray's stiffness on its branch (Deform.ts sprayBend)
	branchStiffness: 0.3, // a branch's stiffness k_b at its foot radius `branchRadius` (m), growing with it (Deform.ts branchBend)
	branchRadius: 0.004,
	shoot: { cards: 5, card: [ 0.3, 0.48 ] as const, tone: [ 0.45, 0.85 ] as const, height: 0.42, width: 0.03 }, // a young shoot's leaves (`shoot`), its prototype's height and the width it changes level by (m)
	// the culms' prototypes: bands of a culm's height over GROVES.height (all a site can take,
	// BambooGroves.ts culmAt) by bands of its girth over its height's ( height / GROVES.slender / 2 )
	prototypes: { heights: 4, height: [ 0.68, 1.1 ] as const, girths: 2, girth: [ 0.85, 1.15 ] as const },
	// the far level: the culm's sides, its rings an internode, and the share of the leaf cards kept
	far: { sides: 4, cards: 0.5 },
};

// the internodes' reference culm (BAMBOO.internode): its height and foot radius (m)
const REF = { height: 7.2, radius: 0.02 };

// The culm's wall: a share of its diameter, and its axial modulus (Pa), moso bamboo's (P. G. Dixon
// and L. J. Gibson, "The structure and mechanics of Moso bamboo material", Journal of the Royal
// Society Interface 11, 2014: a 12.0 mm wall at a 13.7 cm diameter, and the mean modulus of its
// flexure specimens outside the innermost tissue ( r / a > 0.15 ), 10.56 GPa).
const CULM_WALL = 12.0 / 137, CULM_MODULUS = 10.56e9;
// A shoot's wind load (`instances`): a shoot is a few sprays from a point, with no stem to derive a
// stiffness from; set so it leans in a fair wind as it did before the culms' load was derived
// (about 10 degrees), not from a measurement.
const SHOOT_LOAD = 0.55;

/** A culm's wind load, its main bend's load in fair's mean wind (Deform.ts mainBend's lambda_0,
 * PLANT_BEND): lambda_0 = F0 H^2 / EI0, the crown's drag over the culm's stiffness at its foot. The
 * culm: H tall, a hollow tube of foot radius r (`radius`), its wall CULM_WALL of its diameter, so
 * EI0 = E pi / 64 D^4 ( 1 - ( 1 - 2 t / D )^4 ), E CULM_MODULUS. The crown: an ellipse as long as
 * the culm's leafy share (from BAMBOO.branches up) and as broad as twice its longest branch
 * (BAMBOO.branch), loaded at its middle by F0 = 0.5 rho C_D A U^2 (Deform.ts CROWN_DRAG, rho
 * Wind.ts AIR_DENSITY), U fair's mean wind there by the log law (Wind.ts `logLaw`). The drag's
 * area grows as H^2 and its arm as H while the stiffness grows as r^4 at a fixed wall share, so the
 * load goes as ( H / r )^4 (and the log law's slow rise with height): the grown culm (13 m, 5 cm)
 * takes 0.40 and leans 7 degrees on a fair day; one a fifth more slender takes about twice that. */
export function culmLoad( height: number, radius: number ): number {

	const D = 2 * radius, d = D * ( 1 - 2 * CULM_WALL );
	const stiffness = CULM_MODULUS * Math.PI / 64 * ( D ** 4 - d ** 4 );
	const area = Math.PI / 4 * ( 1 - BAMBOO.branches ) * height * 2 * BAMBOO.branch * height;
	const u = REFERENCE_SPEED * logLaw( ( 1 + BAMBOO.branches ) / 2 * height );
	const drag = 0.5 * AIR_DENSITY * CROWN_DRAG.c * Math.pow( u, 2 + CROWN_DRAG.v ) * area;
	return drag * height * height / stiffness;

}

/** The culms' and branches' mesh layout: `culm` (where in its internode, 0 at the node below to 1
 * at the node above), where it hangs on the culm (`plantPart`, PlantInstances.ts), the sway (as the
 * leaf cards': `leafSway`) and the branch a vertex lies on (`branchFrom`, `branchTo`: TreeMesh.ts
 * BRANCH_ATTRIBUTES; the wood carries no spray, so not the spray's two). The leaves' layout carries
 * all four (`leafLayout`), interleaved in one buffer to stay within WebGPU's eight vertex buffers. */
const LIMBS = Object.keys( BRANCH_ATTRIBUTES );
const WOOD_LIMBS = [ 'branchFrom', 'branchTo' ];
const culmLayout = () => new MeshBuilder( { culm: 1, [ PLANT_PART ]: 2, leafSway: 4, branchFrom: 4, branchTo: 4 }, WOOD_LIMBS );
const leavesLayout = () => leafLayout( { [ PLANT_PART ]: 2, ...BRANCH_ATTRIBUTES }, LIMBS );
type Branch = ReturnType<typeof branchValues>;
// a vertex on no branch: the culm's, and the cards of a top tuft or a shoot
const NONE = branchValues();

/** A prototype's culm, upright at the origin and turned to +x (its instances lean and turn it). */
interface Culm {
	height: number; radius: number;
	/** eta, the share of the culm's height at a point, 0..1 */
	eta: ( y: number ) => number;
}

/** What a level builds: the culm's sides and rings an internode, the leaf cards' share kept. */
interface Level { sides: number | null; rings: readonly number[]; cards: number }
const NEAR: Level = { sides: null, rings: [ 0, 0.06, 1 ], cards: 1 };
const FAR: Level = { sides: BAMBOO.far.sides, rings: [ 0, 1 ], cards: BAMBOO.far.cards };

interface Build { culms: MeshBuilder; leaves: MeshBuilder; rng: Rng; level: Level }

const upright = ( height: number, radius: number ): Culm => ( { height, radius, eta: ( y ) => Math.min( 1, Math.max( 0, y / height ) ) } );

// ------------------------------------------------------------------ a culm's mesh

const axisAt = ( c: Culm, s: number, out: THREE.Vector3 ) => out.set( 0, s * c.height, 0 );
// the wind's sway at a point of a prototype: eta^2 (the instance's yield multiplies it) and eta
const swayAt = ( c: Culm, y: number, flutter: number, phase: number ) => [ c.eta( y ) ** 2, flutter, phase, c.eta( y ) ];

const _t = new THREE.Vector3(), _n = new THREE.Vector3(), _bn = new THREE.Vector3();
const _d = new THREE.Vector3(), _p = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();

/** A straight segment of tube from `a` to `b` (radii ra, rb), its rings `values` carry; `phase`
 * runs from p0 to p1 (the internode's), a bulge of `node` at its start; on the culm's tube (`hang`
 * null: each ring hangs from its own height) or off it, hanging from share `hang` of the culm. */
function segment( mesh: MeshBuilder, c: Culm, a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number, sides: number, rings: readonly number[], values: { p0: number; p1: number; node: number; hang: number | null; phase: number; branch: Branch } ): void {

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
		const part = values.hang === null ? [ c.eta( centre.y ), 1 ] : [ values.hang, 0 ];
		for ( let j = 0; j <= sides; j ++ ) {

			const ang = ( j % sides ) / sides * Math.PI * 2;
			_d.copy( _n ).multiplyScalar( Math.cos( ang ) ).addScaledVector( _bn, Math.sin( ang ) );
			const p = centre.clone().addScaledVector( _d, r );
			const index = mesh.vertex( p, {
				culm: [ phase ], [ PLANT_PART ]: part, leafSway: swayAt( c, p.y, 0, values.phase ), ...values.branch,
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
function culm( b: Build, c: Culm ): void {

	const { rng, level } = b;
	const phase = rng();
	// the nodes: internodes short at the foot, longest a third of the way up, shorter again at the top
	const nodes: number[] = [ 0 ];
	for ( let at = 0; at < c.height; ) {

		const s = at / c.height;
		const length = ( BAMBOO.internode[ 0 ] + ( BAMBOO.internode[ 1 ] - BAMBOO.internode[ 0 ] ) * smooth( 0, 0.35, s ) * ( 1 - 0.35 * smooth( 0.7, 1, s ) ) ) * ( c.height / REF.height * 0.5 + 0.5 ) * ( 0.9 + 0.2 * rng() );
		at = Math.min( c.height, at + length );
		nodes.push( at );

	}
	if ( nodes[ nodes.length - 1 ] - nodes[ nodes.length - 2 ] < 0.05 ) nodes.splice( nodes.length - 2, 1 );
	const radiusAt = ( s: number ) => c.radius * ( 1 - 0.3 * s - 0.6 * Math.pow( s, 5 ) );
	const sides = level.sides ?? ( c.radius > 0.012 ? 8 : 6 );
	// the foot a little into the ground
	const below = new THREE.Vector3( 0, - 0.15, 0 );
	segment( b.culms, c, below, axisAt( c, 0, _a ).clone(), c.radius * 1.05, c.radius, sides, [ 0, 1 ], { p0: 0.5, p1: 1, node: 0, hang: null, phase, branch: NONE } );
	let side = rng() < 0.5 ? 1 : - 1;
	for ( let k = 0; k < nodes.length - 1; k ++ ) {

		const s0 = nodes[ k ] / c.height, s1 = nodes[ k + 1 ] / c.height;
		const a = axisAt( c, s0, _a ).clone(), e = axisAt( c, s1, _b ).clone();
		segment( b.culms, c, a, e, radiusAt( s0 ), radiusAt( s1 ), sides, level.rings, { p0: 0, p1: 1, node: k > 0 && level.rings.length > 2 ? 0.06 : 0, hang: null, phase, branch: NONE } );
		// two branches at each node in the upper part, a main one and a lesser, alternately to
		// either side
		if ( s0 >= BAMBOO.branches && k > 0 && s0 < 0.97 ) {

			branch( b, c, a, s0, side, 0, radiusAt( s0 ), phase );
			branch( b, c, a, s0, side, 1, radiusAt( s0 ), phase );
			side = - side;

		}

	}
	// the top: a tuft of sprays round the last node, drooping (the far level every other one)
	const top = axisAt( c, 1, _a ).clone();
	const tip = new THREE.Vector3( 0, 1, 0 );
	const tuft = 8, kept = Math.round( tuft * level.cards );
	for ( let k = 0; k < tuft; k ++ ) {

		const az = ( k / tuft ) * Math.PI * 2 + rng() * 0.6;
		const dir = new THREE.Vector3( Math.cos( az ), 0, Math.sin( az ) ).multiplyScalar( 0.8 ).add( tip ).add( new THREE.Vector3( 0, - 0.35, 0 ) ).normalize();
		const from = top.clone().addScaledVector( tip, - 0.15 * rng() ), size = BAMBOO.card * ( 0.75 + 0.3 * rng() );
		if ( k % ( tuft / kept ) === tuft / kept - 1 ) spray( b, c, from, dir, size * Math.sqrt( tuft / kept ), 1, NONE );

	}

}

/** A branch from the culm's node at `at` (s along the culm), out to one `side` (the node's main
 * one, or the `lesser` beside it): up and out, then drooping, with sprays along it (the far level
 * the outer ones, enlarged to keep their cover). */
function branch( b: Build, c: Culm, at: THREE.Vector3, s: number, side: number, lesser: number, r: number, phase: number ): void {

	const { rng, level } = b;
	// turned toward the way the culm leans (the prototype's +x), swung to the side
	const az = side * ( 0.5 + 0.9 * rng() ) + lesser * side * ( 0.3 + 0.4 * rng() );
	const flat = new THREE.Vector3( Math.cos( az ), 0, Math.sin( az ) );
	const rise = 0.7 - 0.5 * s + 0.2 * rng();
	const dir = flat.clone().add( new THREE.Vector3( 0, rise, 0 ) ).normalize();
	// longest in the middle of the leafy part
	const middle = ( 1 + BAMBOO.branches ) / 2;
	const length = BAMBOO.branch * c.height * ( 1 - 6 * ( s - middle ) ** 2 ) * ( 0.75 + 0.4 * rng() ) * ( 1 - 0.4 * lesser );
	if ( length < 0.15 ) return;
	const end = at.clone().addScaledVector( dir, length ).add( new THREE.Vector3( 0, - 0.25 * length, 0 ) );
	const mid = at.clone().addScaledVector( dir, length * 0.55 );
	const curve = new THREE.QuadraticBezierCurve3( at.clone().addScaledVector( dir, r ), mid, end );
	// the branch's wind: from its start to its end, stiffer the thicker it is
	const foot = r * 0.32;
	const give = 1 - Math.min( 0.9, BAMBOO.branchStiffness * foot / BAMBOO.branchRadius );
	const wood = branchValues( curve.v0, end, give );
	const steps = 3;
	for ( let i = 0; i < steps; i ++ ) {

		const p = curve.getPoint( i / steps ), q = curve.getPoint( ( i + 1 ) / steps );
		segment( b.culms, c, p, q, r * 0.32 * ( 1 - i / steps * 0.7 ), r * 0.32 * ( 1 - ( i + 1 ) / steps * 0.7 ), 4, [ 0, 1 ], { p0: 0.5, p1: 0.5, node: 0, hang: s, phase, branch: wood } );

	}
	// sprays along it, hanging out along the branch (every draw taken, so both levels place the
	// same cards)
	const cards = 1 + Math.floor( rng() * 2 + length * 3.5 );
	const kept = Math.max( 1, Math.round( cards * level.cards ) );
	for ( let k = 0; k < cards; k ++ ) {

		const t = 0.2 + 0.8 * ( k + 0.5 * rng() ) / cards;
		const from = curve.getPoint( t );
		const along = curve.getTangent( t ).normalize();
		const turn = ( k % 2 === 0 ? 1 : - 1 ) * ( 0.3 + 0.5 * rng() );
		const out = along.clone().applyAxisAngle( UP, turn ).add( new THREE.Vector3( 0, - 0.25 - 0.3 * rng(), 0 ) ).normalize();
		const size = BAMBOO.card * ( 0.8 + 0.35 * rng() ) * Math.min( 1, 0.6 + length );
		if ( k >= cards - kept ) spray( b, c, from, out, size * Math.sqrt( cards / kept ), s, wood );

	}

}

/** A leaf card from `from`, its spray hanging out along `out` (the atlas tile's up), facing up as
 * far as it can, on `branch` (its attributes, TreeMesh.ts branchValues), hanging from share `hang`
 * of the culm; its normal bent out from the culm and up, its colour the exposure. */
function spray( b: Build, c: Culm, from: THREE.Vector3, out: THREE.Vector3, size: number, hang: number, branch: Branch ): void {

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
	const reach = BAMBOO.branch * c.height;
	const first = b.leaves.count;
	// the spray's own swing, from its foot along the card
	const limbs = sprayValues( branch, from, from.clone().addScaledVector( Y, size ), 1 - BAMBOO.sprayStiffness );
	for ( const [ cx, cy, u, v ] of [ [ - 0.5, 0, 0, 0 ], [ 0.5, 0, 1, 0 ], [ 0.5, 1, 1, 1 ], [ - 0.5, 1, 0, 1 ] ] ) {

		const p = from.clone().addScaledVector( X, cx * size ).addScaledVector( Y, ( cy - 0.04 ) * size );
		// out from the culm's axis and up
		const away = new THREE.Vector3( p.x, 0, p.z );
		const radial = Math.min( 1, away.length() / reach );
		away.normalize();
		const height = c.eta( p.y );
		const nn = away.clone().multiplyScalar( 0.5 ).addScaledVector( N, 0.35 ).addScaledVector( UP, 0.15 + 0.35 * height ).normalize();
		const exposure = Math.min( 1, 0.5 * radial + 0.45 * height + 0.15 * rng() );
		const k = 0.32 + 0.68 * exposure * exposure;
		b.leaves.vertex( p, {
			normal: [ nn.x, nn.y, nn.z ],
			uv: [ tu + inset + u * ( 0.5 - 2 * inset ), tv + inset + v * ( 0.5 - 2 * inset ) ],
			color: [ k, k, k ],
			leafSway: swayAt( c, p.y, BAMBOO.flutter * cy * cy, flutterPhase ),
			[ PLANT_PART ]: [ hang, 0 ],
			...limbs,
		} );

	}
	b.leaves.indices.push( first, first + 1, first + 2, first, first + 2, first + 3 );

}

/** The young shoots' prototype (BambooGroves.ts `plantShoots`): a few leaf sprays fanning out and
 * drooping from a low point (BAMBOO.shoot), their tone the instance's (its `look` z). */
function shoot( b: Build ): void {

	const P = BAMBOO.shoot, rng = b.rng, level = b.level;
	const c = upright( P.height, 0.004 );
	const top = new THREE.Vector3( 0, P.height, 0 );
	const kept = Math.max( 1, Math.round( P.cards * level.cards ) );
	for ( let k = 0; k < P.cards; k ++ ) {

		const az = ( k / P.cards ) * Math.PI * 2 + ( rng() - 0.5 ) * 0.8;
		const out = new THREE.Vector3( Math.cos( az ), - 0.25 - 0.35 * rng(), Math.sin( az ) ).normalize();
		const size = P.card[ 0 ] + ( P.card[ 1 ] - P.card[ 0 ] ) * rng();
		// (the far level every other card)
		if ( level.cards === 1 || k % 2 === 0 ) spray( b, c, top.clone().addScaledVector( out, 0.02 ), out, size * Math.sqrt( P.cards / kept ), 1, NONE );

	}

}

// ------------------------------------------------------------------ the prototypes and instances

// the culms' prototypes, ( height band, girth band ) as height * girths + girth; the shoots' last
const CULM_PROTOTYPES = BAMBOO.prototypes.heights * BAMBOO.prototypes.girths;
const SHOOT = CULM_PROTOTYPES;
// a band's middle, of `count` over [ lo, hi ]
const bandMiddle = ( [ lo, hi ]: readonly [ number, number ], count: number, k: number ) => lo + ( hi - lo ) * ( k + 0.5 ) / count;
const bandOf = ( [ lo, hi ]: readonly [ number, number ], count: number, x: number ) => Math.min( count - 1, Math.max( 0, Math.floor( ( x - lo ) / ( hi - lo ) * count ) ) );

/** Prototype `k`'s culm: its band's middle height and girth (GROVES.height is a load knob, read
 * here once). */
function prototypeCulm( k: number ): Culm {

	const P = BAMBOO.prototypes;
	const height = GROVES.height * bandMiddle( P.height, P.heights, Math.floor( k / P.girths ) );
	return upright( height, height / GROVES.slender / 2 * bandMiddle( P.girth, P.girths, k % P.girths ) );

}

/** A prototype's two meshes at a level (`leaves` alone for the shoots), from its fixed seed. */
function prototypeMesh( k: number, level: Level ): { culms: THREE.BufferGeometry | null; leaves: THREE.BufferGeometry } {

	const b: Build = { culms: culmLayout(), leaves: leavesLayout(), rng: mulberry32( 0xba3b00 + k ), level };
	if ( k === SHOOT ) shoot( b );
	else culm( b, prototypeCulm( k ) );
	const name = `${ k === SHOOT ? 'shoot' : `culm ${ k }` } ${ level === NEAR ? 'near' : 'far' }`;
	return { culms: b.culms.count > 0 ? b.culms.geometry( `bamboo ${ name }` ) : null, leaves: b.leaves.geometry( `bamboo leaves ${ name }` ) };

}

/** The sites' instances, in their order: each culm of the prototype nearest its height and girth. */
function instances( sites: { culms: CulmSite[]; shoots: ShootSite[] } ): PlantInstance[] {

	const P = BAMBOO.prototypes, S = BAMBOO.shoot;
	const culms = sites.culms.map( ( site ): PlantInstance => {

		const q = site.height / GROVES.height, g = site.radius / ( site.height / GROVES.slender / 2 );
		const k = bandOf( P.height, P.heights, q ) * P.girths + bandOf( P.girth, P.girths, g );
		const proto = prototypeCulm( k );
		const scale = site.height / proto.height;
		return {
			prototype: k, x: site.x, y: site.y, z: site.z, yaw: Math.atan2( site.outZ, site.outX ),
			height: site.height, scale, girth: site.radius / proto.radius, limb: scale,
			lean: site.lean, bow: site.bow, load: culmLoad( site.height, site.radius ),
			width: 2 * site.radius, reach: BAMBOO.branch * site.height + BAMBOO.card,
			look: [ site.age, site.grove, 1, 0 ],
		};

	} );
	const shoots = sites.shoots.map( ( site ): PlantInstance => ( {
		prototype: SHOOT, x: site.x, y: site.y, z: site.z, yaw: site.turn,
		height: site.height, scale: site.height / S.height, girth: 1, limb: 1,
		lean: 0, bow: 0, load: SHOOT_LOAD,
		width: S.width, reach: S.card[ 1 ],
		look: [ 0, 0, S.tone[ 0 ] + ( S.tone[ 1 ] - S.tone[ 0 ] ) * site.light, 0 ],
	} ) );
	return [ ...culms, ...shoots ];

}

// ------------------------------------------------------------------ the page's bamboo

export type Sites = { culms: CulmSite[]; shoots: ShootSite[] };

/** What a growth step prepared: the sites and their pool, or null where the sites did not change. */
export type BambooPrepared = { sites: Sites; pool: PlantPool } | null;

// the chunks' order ( cj, ci ), as the island's meshes are ordered (Growth.ts)
const order = ( a: { ci: number; cj: number }, b: { ci: number; cj: number } ) => a.cj - b.cj || a.ci - b.ci;
// the chunk's square (Chunks.ts chunkBox)
const chunkBox = ( ci: number, cj: number ) => ( { x0: ci * SEABED_TILE, z0: cj * SEABED_TILE, x1: ci * SEABED_TILE + SEABED_TILE, z1: cj * SEABED_TILE + SEABED_TILE } );

/** The sites over `data`'s land: every land chunk planted in the chunks' order (BambooGroves.ts,
 * the rim ground's distance from the cliff's edge), a row of cells a step. */
function* plantSteps( data: WorldData ): Generator<void, Sites> {

	const sites: Sites = { culms: [], shoots: [] };
	for ( const { ci, cj } of [ ...data.islands ].sort( order ) ) {

		const box = chunkBox( ci, cj );
		sites.culms.push( ...yield* plantCulms( data.rimGround, islandSurfaceHeight, box ) );
		sites.shoots.push( ...yield* plantShoots( data.rimGround, islandSurfaceHeight, box ) );

	}
	return sites;

}

/** The bamboo over the land's top: its prototypes' draws under `culms` and `leaves`, the plants
 * the sites' instances (PlantInstances.ts), in its surfaces (BambooMaterials.ts: the leaves' atlas,
 * made once). */
export class Bamboo {

	readonly plants: PlantInstances;
	readonly culms: THREE.Group;
	readonly leaves: THREE.Group;
	private shown: Sites;

	constructor( sites: Sites, surfaces: { shared: Shared; atlas: LeafAtlas } ) {

		const draws: PlantDraw[] = [];
		for ( let k = 0; k <= SHOOT; k ++ ) {

			const near = prototypeMesh( k, NEAR ), far = prototypeMesh( k, FAR );
			if ( near.culms && far.culms ) draws.push( ...levelDraws( 0, k, near.culms, far.culms, true ) );
			draws.push( ...levelDraws( 1, k, near.leaves, far.leaves, false ) );

		}
		this.shown = sites;
		this.plants = new PlantInstances( {
			name: 'Bamboo', parts: BAMBOO_PARTS, draws, plants: instances( this.shown ),
			material: bambooMaterials( surfaces ),
		} );
		[ this.culms, this.leaves ] = this.plants.roots;
		for ( const mesh of this.culms.children ) mesh.userData.culms = true;
		// before the terrain, as all the vegetation (the turf it covers then fails the depth test)
		for ( const mesh of this.leaves.children ) mesh.renderOrder = - 1;

	}

	/** The culms and shoots standing now (for the diagnostics). */
	sites(): Sites {

		return this.shown;

	}

	/** The bamboo of `data`'s land, in steps (the growth's idle time): planted again, and where the
	 * sites changed their instance pool filled and uploaded. */
	* prepare( data: WorldData, renderer: THREE.WebGPURenderer | null ): Generator<void, BambooPrepared> {

		const sites = yield* plantSteps( data );
		if ( sameSites( sites.culms, this.shown.culms ) && sameSites( sites.shoots, this.shown.shoots ) ) return null;
		return { sites, pool: yield* this.plants.prepare( instances( sites ), renderer ) };

	}

	/** Swaps `prepared` in (PlantInstances.ts `swap`). Returns what frees the old pool. */
	swap( prepared: BambooPrepared ): ( () => void ) | null {

		if ( ! prepared ) return null;
		this.shown = prepared.sites;
		return this.plants.swap( prepared.pool );

	}

}

// Whether two lists of sites are the same, field by field.
function sameSites<T extends CulmSite | ShootSite>( a: readonly T[], b: readonly T[] ): boolean {

	if ( a.length !== b.length ) return false;
	for ( let k = 0; k < a.length; k ++ ) {

		const p = a[ k ] as unknown as Record<string, number>, q = b[ k ] as unknown as Record<string, number>;
		for ( const field in p ) if ( p[ field ] !== q[ field ] ) return false;

	}
	return true;

}

/** The bamboo over `data`'s land (`Bamboo`). */
export function buildBamboo( data: WorldData, surfaces: { shared: Shared; atlas: LeafAtlas } ): Bamboo {

	return new Bamboo( runSteps( plantSteps( data ) ), surfaces );

}

/** The bamboo's two vegetation kinds: the culms (an ordinary shadow) and the leaves. The culms'
 * growth prepares and swaps the one instance pool both kinds draw from; the leaves follow it. */
export function bambooKinds( bamboo: Bamboo ): VegetationKind[] {

	const growth: KindGrowth<BambooPrepared> = {
		prepare: ( input ) => bamboo.prepare( input.data, input.renderer ),
		swap: ( prepared ) => bamboo.swap( prepared ),
	};
	return [
		{ name: 'bamboo', root: bamboo.culms, prepass: false, shadowFilter: 'ordinary', sunCaster: true, rainBake: true, growth: growth as KindGrowth<unknown> },
		{ name: 'bamboo leaves', root: bamboo.leaves, prepass: true, shadowFilter: 'vegetation', sunCaster: true, rainBake: true },
	];

}
