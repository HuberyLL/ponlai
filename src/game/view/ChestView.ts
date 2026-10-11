import * as THREE from 'three/webgpu';
import type { BuildingState } from '../sim/types.ts';
import { BOX, PropBuilder, at, hashAt, propMaterial } from './Props.ts';
import type { RGB } from './Props.ts';

// The chest (sim/buildings.ts) once the player has set it down: a stand-in wooden chest built in code, in
// the props' faceted style (Props.ts), as the art direction's things people make are, handmade and
// a little chunky: a body of horizontal planks on two skids, darker corner posts, a lid of planks
// with a rim, two dark bands over body and lid and a clasp at the front. About 0.9 x 0.55 m and
// 0.6 m tall, so the disc it blocks (CHEST_RADIUS) is its lid's half diagonal: what is drawn is
// what the islanders walk round. Its front faces the island's middle (the world origin), so a
// loaded game draws it the same; its planks vary by a hash of where it stands.

// linear albedo: weathered planks, darker posts and skids, dark bands
const WOOD: RGB = [ 0.16, 0.09, 0.045 ];
const WOOD_PALE: RGB = [ 0.2, 0.125, 0.07 ];
const POST: RGB = [ 0.1, 0.06, 0.035 ];
const BAND: RGB = [ 0.045, 0.04, 0.035 ];

const HALF_X = 0.45, HALF_Z = 0.275;
const SKID = 0.05; // the skids' height: the body stands on them
const BODY = 0.4; // the body's height above the skids
const LID = 0.15; // the lid's height

function chestGeometry( chest: BuildingState ): THREE.BufferGeometry {

	const b = new PropBuilder();
	const hash = ( k: number ) => hashAt( chest.x, chest.z, k );
	const jitter = ( c: RGB, k: number ): RGB => {

		const f = 0.85 + 0.3 * hash( k );
		return [ c[ 0 ] * f, c[ 1 ] * f, c[ 2 ] * f ];

	};

	// two skids across the short side, sunk a little into uneven ground
	for ( const sx of [ - 1, 1 ] ) b.add( BOX, POST, at( sx * ( HALF_X - 0.1 ), SKID / 2 - 0.03, 0, 0.08, SKID + 0.06, 2 * HALF_Z + 0.02 ) );

	// the body: three rows of planks on each side, a little inset from the corner posts
	const rows = 3, rowH = BODY / rows, base = SKID;
	for ( let r = 0; r < rows; r ++ ) {

		const y = base + ( r + 0.5 ) * rowH;
		for ( const sz of [ - 1, 1 ] ) b.add( BOX, jitter( r % 2 ? WOOD_PALE : WOOD, 10 + r + ( sz > 0 ? 0 : 5 ) ), at( 0, y, sz * ( HALF_Z - 0.02 ), 2 * HALF_X - 0.06, rowH - 0.012, 0.04 ) );
		for ( const sx of [ - 1, 1 ] ) b.add( BOX, jitter( r % 2 ? WOOD : WOOD_PALE, 20 + r + ( sx > 0 ? 0 : 5 ) ), at( sx * ( HALF_X - 0.02 ), y, 0, 0.04, rowH - 0.012, 2 * HALF_Z - 0.06 ) );

	}
	// the floor inside, seen only past the planks' joints
	b.add( BOX, POST, at( 0, base + 0.02, 0, 2 * HALF_X - 0.06, 0.04, 2 * HALF_Z - 0.06 ) );
	// corner posts
	for ( const sx of [ - 1, 1 ] ) for ( const sz of [ - 1, 1 ] ) b.add( BOX, POST, at( sx * ( HALF_X - 0.03 ), base + BODY / 2, sz * ( HALF_Z - 0.03 ), 0.065, BODY, 0.065 ) );

	// the lid: planks along its length, closed by a rim, a hair wider than the body
	const lidY = base + BODY, planks = 4;
	for ( let i = 0; i < planks; i ++ ) {

		const z = - HALF_Z - 0.01 + ( i + 0.5 ) * ( ( 2 * HALF_Z + 0.02 ) / planks );
		const lift = 0.006 * hash( 40 + i );
		b.add( BOX, jitter( i % 2 ? WOOD : WOOD_PALE, 30 + i ), at( 0, lidY + LID - 0.025 + lift, z, 2 * HALF_X + 0.02, 0.05, ( 2 * HALF_Z + 0.02 ) / planks - 0.008 ) );

	}
	for ( const sz of [ - 1, 1 ] ) b.add( BOX, jitter( WOOD, 50 + sz ), at( 0, lidY + ( LID - 0.05 ) / 2, sz * ( HALF_Z + 0.0 ), 2 * HALF_X + 0.02, LID - 0.05, 0.04 ) );
	for ( const sx of [ - 1, 1 ] ) b.add( BOX, jitter( WOOD, 55 + sx ), at( sx * ( HALF_X + 0.0 ), lidY + ( LID - 0.05 ) / 2, 0, 0.04, LID - 0.05, 2 * HALF_Z + 0.02 ) );

	// two bands over the lid and down the front and back, and a clasp
	const top = lidY + LID;
	for ( const sx of [ - 1, 1 ] ) {

		const x = sx * ( HALF_X - 0.17 );
		b.add( BOX, BAND, at( x, top + 0.006, 0, 0.05, 0.012, 2 * HALF_Z + 0.05 ) );
		for ( const sz of [ - 1, 1 ] ) b.add( BOX, BAND, at( x, base + ( top - base ) / 2, sz * ( HALF_Z + 0.022 ), 0.05, top - base, 0.012 ) );

	}
	b.add( BOX, BAND, at( 0, lidY - 0.01, HALF_Z + 0.03, 0.07, 0.11, 0.02 ) );
	return b.geometry( 'chest' );

}

// One material for every chest, the sample the game compiles at start among them (GameView "First
// draws"): a chest drawn later then finds its shaders built, not only its pipelines. It is never
// disposed.
let material: THREE.MeshStandardNodeMaterial | null = null;

export class ChestView {

	readonly mesh: THREE.Mesh;
	/** where it was drawn for, so a different chest (a loaded game's) is drawn anew */
	readonly x: number;
	readonly z: number;

	constructor( chest: BuildingState, ground: number ) {

		this.x = chest.x;
		this.z = chest.z;
		this.mesh = new THREE.Mesh( chestGeometry( chest ), material ??= propMaterial( 'chest' ) );
		this.mesh.name = 'chest';
		this.mesh.position.set( chest.x, ground, chest.z );
		// the front (+z) faces the island's middle
		this.mesh.rotation.y = Math.atan2( - chest.x, - chest.z );
		this.mesh.castShadow = true;
		this.mesh.receiveShadow = true;

	}

	dispose(): void {

		this.mesh.removeFromParent();
		this.mesh.geometry.dispose();

	}

}
