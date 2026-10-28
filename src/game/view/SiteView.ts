import * as THREE from 'three/webgpu';
import { BUILDING_KINDS, progressOf, siteFrame } from '../sim/buildings.ts';
import type { BuildingState } from '../sim/types.ts';
import { BOX, LOG, PropBuilder, at, buildingMaterial, hashAt } from './Props.ts';
import type { RGB } from './Props.ts';

// A building's construction site (sim/buildings.ts) until it is built, as a real site rather than a
// ghost of the finished building: the same stages for every kind, shaped by its footprint radius
// alone, so a new kind needs only its finished model (GameView).
//
// - planned (no work yet): the ground marked out, a square of turned soil inscribed in the
//   footprint's disc, a stake just outside each corner and a cord strung between them.
// - being built: a timber frame on that square rises with the progress in tiers (sill beams, then
//   per tier its posts, rails and a brace), with a scaffold of poles, lashed ledgers and a board to
//   stand on beside two of its sides, and a pile of planks beside it that shrinks as the frame uses
//   them; at the end joists close the top.
//
// The pieces are laid in a fixed order and the progress shows the first ones (a piece appears
// whole, as a person sets it): the geometry is rebuilt only when that count or the pile changes,
// a few dozen times over the whole build, and each time the site asks for the sun's shadow map to
// be redrawn (GameView). It shares the chest's material (buildingMaterial) and its vertex layout,
// so no stage builds a pipeline of its own when it first shows (GameView "First draws"). Sizes
// follow the radius (the frame is as tall as 1.1 radii, its timbers thicker on a larger site);
// what varies (a stake's lean, a plank's tone) comes from a hash of where the site stands, so a
// loaded game draws it the same. Its front faces the island's middle, as the chest's does. The
// scaffold and the pile stand a little past the blocked disc: they are low and thin, and the
// islander works beside the site.

// linear albedo: freshly cut timber (paler than the chest's weathered planks), bark-dark poles,
// hemp cord and lashings, turned soil
const TIMBER: RGB = [ 0.19, 0.115, 0.06 ];
const TIMBER_PALE: RGB = [ 0.235, 0.15, 0.08 ];
const POLE: RGB = [ 0.12, 0.085, 0.05 ];
const CORD: RGB = [ 0.27, 0.215, 0.13 ];
const LASHING: RGB = [ 0.17, 0.13, 0.08 ];
const SOIL: RGB = [ 0.07, 0.05, 0.034 ];
const SOIL_DARK: RGB = [ 0.045, 0.033, 0.024 ];

/** the planks in the pile when building starts */
const PILE = 8;

interface Piece { colour: RGB; matrix: THREE.Matrix4; template: THREE.BufferGeometry }

/** A timber between two points (prop space), its square section `s` wide. */
function beam( a: THREE.Vector3, b: THREE.Vector3, s: number ): THREE.Matrix4 {

	const d = new THREE.Vector3().subVectors( b, a ), length = d.length();
	const q = new THREE.Quaternion().setFromUnitVectors( new THREE.Vector3( 0, 1, 0 ), d.divideScalar( length ) );
	return new THREE.Matrix4().compose( a.clone().add( b ).multiplyScalar( 0.5 ), q, new THREE.Vector3( s, length, s ) );

}

/** A round pole from a foot to a top (prop space), `radius` thick. */
function pole( foot: THREE.Vector3, top: THREE.Vector3, radius: number ): THREE.Matrix4 {

	const d = new THREE.Vector3().subVectors( top, foot );
	const q = new THREE.Quaternion().setFromUnitVectors( new THREE.Vector3( 0, 1, 0 ), d.clone().normalize() );
	return new THREE.Matrix4().compose( foot, q, new THREE.Vector3( radius, d.length(), radius ) );

}

const v = ( x: number, y: number, z: number ) => new THREE.Vector3( x, y, z );

/** Everything a site of a radius can show, in the order it is built, and the marks of the plan. */
function sitePlan( site: BuildingState ): { marks: Piece[]; pieces: Piece[]; pile: Piece[] } {

	const r = BUILDING_KINDS[ site.kind ].radius;
	const hash = ( k: number ) => hashAt( site.x, site.z, k );
	const tone = ( c: RGB, k: number ): RGB => {

		const f = 0.85 + 0.3 * hash( k );
		return [ c[ 0 ] * f, c[ 1 ] * f, c[ 2 ] * f ];

	};
	// the square inscribed in the footprint's disc, the frame's height, its timbers' section (the
	// simulation's box of the site rises by the same tiers: buildings.ts bodyBox)
	const { half: h, height, section: s, tiers } = siteFrame( r );
	const corners = [ [ - 1, - 1 ], [ 1, - 1 ], [ 1, 1 ], [ - 1, 1 ] ];

	// --- the plan: turned soil over the square, four stakes, a cord round them
	const marks: Piece[] = [];
	const pad = h + 0.6 * s + 0.05;
	marks.push( { template: BOX, colour: SOIL, matrix: at( 0, - 0.012, 0, 2 * pad, 0.05, 2 * pad, 0, 0.04 * ( hash( 1 ) - 0.5 ), 0 ).clone() } );
	// a few darker clods along the edges, where the turf was cut
	for ( let k = 0; k < 8; k ++ ) {

		const side = k % 4, t = ( hash( 2 + k ) - 0.5 ) * 1.6 * pad;
		const [ x, z ] = side === 0 ? [ t, - pad ] : side === 1 ? [ pad, t ] : side === 2 ? [ t, pad ] : [ - pad, t ];
		marks.push( { template: BOX, colour: SOIL_DARK, matrix: at( x, 0.01, z, 0.09 + 0.06 * hash( 12 + k ), 0.05, 0.07, 0, hash( 22 + k ) * 3, 0.15 ).clone() } );

	}
	const stake = h + 0.08 + 0.4 * s, stakeTop = 0.38 + 0.12 * r, cordY = stakeTop - 0.07;
	const tops: THREE.Vector3[] = [];
	corners.forEach( ( [ sx, sz ], k ) => {

		const lean = 0.05 * ( hash( 30 + k ) - 0.5 );
		const foot = v( sx * stake, - 0.08, sz * stake ), top = v( sx * ( stake + lean ), stakeTop, sz * ( stake - lean ) );
		marks.push( { template: BOX, colour: tone( TIMBER_PALE, 34 + k ), matrix: beam( foot, top, 0.6 * s ) } );
		tops.push( v( top.x, cordY, top.z ) );

	} );
	for ( let k = 0; k < 4; k ++ ) {

		// each side in two runs that sag to the middle
		const a = tops[ k ], b = tops[ ( k + 1 ) % 4 ];
		const mid = a.clone().add( b ).multiplyScalar( 0.5 ).add( v( 0, - 0.02 - 0.02 * r, 0 ) );
		marks.push( { template: BOX, colour: CORD, matrix: beam( a, mid, 0.012 ) } );
		marks.push( { template: BOX, colour: CORD, matrix: beam( mid, b, 0.012 ) } );
		marks.push( { template: BOX, colour: LASHING, matrix: at( a.x, a.y, a.z, 0.6 * s + 0.012, 0.03, 0.6 * s + 0.012 ).clone() } );

	}

	// --- the frame, tier by tier, and the scaffold beside its back (-z) and right (+x) sides
	const pieces: Piece[] = [];
	const post = h - s / 2, y0 = s;
	const timber = ( k: number ) => tone( k % 2 ? TIMBER : TIMBER_PALE, 100 + k );
	let n = 0;
	// side k of the square at a height, from corner k to the next, its ends pushed out by `over`
	const side = ( k: number, y: number, over: number ): [ THREE.Vector3, THREE.Vector3 ] => {

		const [ ax, az ] = corners[ k ], [ bx, bz ] = corners[ ( k + 1 ) % 4 ];
		const a = v( ax * post, y, az * post ), b = v( bx * post, y, bz * post );
		const d = b.clone().sub( a ).normalize().multiplyScalar( over );
		return [ a.sub( d ), b.add( d ) ];

	};
	// sill beams on the soil, two of them running past the corners
	for ( let k = 0; k < 4; k ++ ) pieces.push( { template: BOX, colour: timber( n ++ ), matrix: beam( ...side( k, s / 2, k % 2 ? - s / 2 : s / 2 ), s ) } );
	const scaffold = h + 0.12 + 2 * s, poleR = 0.45 * s;
	const poles = [ v( - post, 0, - scaffold ), v( post, 0, - scaffold ), v( scaffold, 0, - post ), v( scaffold, 0, post ) ];
	const tierH = ( height - y0 ) / tiers;
	for ( let t = 0; t < tiers; t ++ ) {

		const lo = y0 + t * tierH, hi = y0 + ( t + 1 ) * tierH, last = t === tiers - 1;
		// the posts' next lengths
		for ( const [ sx, sz ] of corners ) pieces.push( { template: BOX, colour: timber( n ++ ), matrix: beam( v( sx * post, lo, sz * post ), v( sx * post, hi, sz * post ), s ) } );
		// the scaffold's poles grow a tier too (past the top on the last), with a lashing at the joint
		for ( let k = 0; k < poles.length; k ++ ) {

			const p = poles[ k ];
			const top = last ? hi + 0.2 + 0.1 * r : hi;
			pieces.push( { template: LOG, colour: tone( POLE, 200 + k ), matrix: pole( v( p.x, t === 0 ? - 0.06 : lo, p.z ), v( p.x, top, p.z ), poleR ) } );
			if ( t > 0 ) pieces.push( { template: BOX, colour: LASHING, matrix: at( p.x, lo, p.z, 2.6 * poleR, 0.035, 2.6 * poleR ).clone() } );

		}
		// the rails (the top plate on the last tier, a little heavier)
		const rs = last ? 1.15 * s : 0.85 * s, ry = hi - rs / 2;
		for ( let k = 0; k < 4; k ++ ) pieces.push( { template: BOX, colour: timber( n ++ ), matrix: beam( ...side( k, ry, last && k % 2 === 0 ? s / 2 : - s / 2 ), rs ) } );
		// a brace across one side, a different side each tier
		const [ ba, bb ] = side( t % 4, 0, - s / 2 );
		pieces.push( { template: BOX, colour: timber( n ++ ), matrix: beam( ba.setY( lo + 0.6 * s ), bb.setY( hi - 0.6 * s ), 0.7 * s ) } );
		// the scaffold's ledgers at this height, lashed to the poles, and a board across them
		const ly = hi - 0.02;
		pieces.push( { template: LOG, colour: tone( POLE, 220 + t ), matrix: pole( v( - post - 0.08, ly, - scaffold - poleR * 2 ), v( post + 0.08, ly, - scaffold - poleR * 2 ), poleR * 0.8 ) } );
		pieces.push( { template: LOG, colour: tone( POLE, 230 + t ), matrix: pole( v( scaffold + poleR * 2, ly, - post - 0.08 ), v( scaffold + poleR * 2, ly, post + 0.08 ), poleR * 0.8 ) } );
		const boardW = Math.min( 0.22, scaffold - post - s / 2 + 0.04 ), boardY = ly + poleR * 0.8 + 0.012;
		const back = t % 2 === 0;
		pieces.push( { template: BOX, colour: tone( TIMBER_PALE, 240 + t ), matrix: back
			? at( 0, boardY, - ( post + s / 2 + scaffold ) / 2 - 0.01, 2 * post, 0.022, boardW, 0, 0, 0.02 * ( hash( 250 + t ) - 0.5 ) ).clone()
			: at( ( post + s / 2 + scaffold ) / 2 + 0.01, boardY, 0, boardW, 0.022, 2 * post, 0.02 * ( hash( 250 + t ) - 0.5 ), 0, 0 ).clone() } );

	}
	// joists over the top plate, closing it
	const joists = Math.max( 2, Math.round( 2 * h / 0.25 ) );
	for ( let k = 0; k < joists; k ++ ) {

		const x = - post + ( k + 0.5 ) * ( 2 * post / joists );
		pieces.push( { template: BOX, colour: timber( n ++ ), matrix: at( x, height + 0.5 * s, 0, 0.8 * s, 0.9 * s, 2 * ( post + s / 2 ), 0, 0, 0 ).clone() } );

	}

	// --- the planks waiting beside the left (-x) side, on two bearers
	const pile: Piece[] = [];
	const px = - ( h + 0.2 + 0.5 * s + 0.15 * r ), length = 2 * h + 0.1, plankW = 0.07 + 0.05 * r, plankT = 0.02 + 0.008 * r;
	for ( const sz of [ - 1, 1 ] ) pile.push( { template: BOX, colour: tone( POLE, 300 + sz ), matrix: at( px, 0.015, sz * length * 0.32, 2.3 * plankW + 0.04, 0.05, 0.05 ).clone() } );
	for ( let k = 0; k < PILE; k ++ ) {

		const row = Math.floor( k / 2 ), col = k % 2;
		const x = px + ( col - 0.5 ) * ( plankW + 0.008 ) + 0.01 * ( hash( 310 + k ) - 0.5 );
		pile.push( { template: BOX, colour: tone( k % 3 ? TIMBER_PALE : TIMBER, 320 + k ), matrix: at( x, 0.04 + plankT / 2 + row * ( plankT + 0.002 ), 0, plankW, plankT, length, 0, 0.05 * ( hash( 330 + k ) - 0.5 ), 0 ).clone() } );

	}
	return { marks, pieces, pile };

}

export class SiteView {

	readonly mesh: THREE.Mesh;
	readonly x: number;
	readonly z: number;
	private readonly plan: ReturnType<typeof sitePlan>;
	// what the geometry shows now: the pieces built and the planks left (-1: nothing yet)
	private shown = - 1;
	private planks = - 1;

	constructor( site: BuildingState, ground: number ) {

		this.x = site.x;
		this.z = site.z;
		this.plan = sitePlan( site );
		this.mesh = new THREE.Mesh( new THREE.BufferGeometry(), buildingMaterial() );
		this.mesh.name = `site:${ site.id }`;
		this.mesh.position.set( site.x, ground, site.z );
		// the front (+z) faces the island's middle, as the finished building's
		this.mesh.rotation.y = Math.atan2( - site.x, - site.z );
		this.mesh.castShadow = true;
		this.mesh.receiveShadow = true;
		this.update( site );

	}

	/** Show the site's progress; true when what it shows (and so its shadow) changed. */
	update( site: BuildingState ): boolean {

		const progress = progressOf( site ), total = this.plan.pieces.length;
		const shown = progress > 0 ? Math.min( total, Math.max( 1, Math.ceil( progress * total ) ) ) : 0;
		// the pile appears with the work and is used up as the frame rises (the last plank stays)
		const planks = progress > 0 ? Math.max( 1, Math.round( PILE * ( 1 - progress ) ) ) : 0;
		if ( shown === this.shown && planks === this.planks ) return false;
		this.shown = shown;
		this.planks = planks;
		const b = new PropBuilder();
		for ( const p of this.plan.marks ) b.add( p.template, p.colour, p.matrix );
		for ( let k = 0; k < shown; k ++ ) b.add( this.plan.pieces[ k ].template, this.plan.pieces[ k ].colour, this.plan.pieces[ k ].matrix );
		// the two bearers, then the planks
		if ( planks > 0 ) for ( let k = 0; k < 2 + planks; k ++ ) b.add( this.plan.pile[ k ].template, this.plan.pile[ k ].colour, this.plan.pile[ k ].matrix );
		this.mesh.geometry.dispose();
		this.mesh.geometry = b.geometry( 'site' );
		return true;

	}

	dispose(): void {

		this.mesh.removeFromParent();
		this.mesh.geometry.dispose();

	}

}
