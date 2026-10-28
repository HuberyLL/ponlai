import type { World } from '@dimforge/rapier3d-deterministic-compat';
import { heightAt } from '../../characters/Ages.ts';
import { bodyBox } from './buildings.ts';
import type { Grid } from './grid.ts';
import { ageOf } from './life.ts';
import { SECONDS_PER_GAME_DAY } from './types.ts';
import type { BuildingState, SimState, Vec3, Villager } from './types.ts';

// The simulation's rigid bodies: one Rapier world per Sim (the deterministic build,
// @dimforge/rapier3d-deterministic-compat, which gives the same results on every platform and
// inlines its WASM, so node and the page load it alike). It is imported dynamically, once, before
// any simulation exists (`initPhysics`: Game.start and tools/verify-game.mjs await it), so the
// bundle keeps its megabytes in a chunk of their own that only the game loads; a static import let
// the bundler merge it into a chunk the island's page loads without the game.
//
// The world holds the things lying on the ground (things.ts: dynamic bodies) and what they meet:
// - the ground: one fixed heightfield of the island's surface (grid.ts `height`) on the grid's
//   lattice (0.5 m, world-anchored, a vertex at each cell's centre) over the island top's bounds
//   grown by GROUND_PAD, at the surface on the land (within RIM_REACH of the top) and SEA_FLOOR
//   below the sea elsewhere, so the rim is a one-cell ramp down to the sea; a function of the
//   land alone, replaced as the island grows (`setGround`, Sim.addPiece);
// - the buildings: a fixed box each, the one its view draws at its stage (buildings.ts `bodyBox`),
//   set as buildings are placed and built (`syncBodies`);
// - the islanders: a kinematic, position-based capsule each, BODY_RADIUS round and as tall as the
//   islander's stature at its age (Ages.ts `heightAt`), its bottom LIFT above the surface,
//   moved each tick to where the islander walks, so they push what they walk into; removed at death.
//
// Rules: the world is a function of the state's history and the seed alone: no wall clock and no
// Math.random (the spread and spin of what is dropped come from the state's generator), every body
// made, moved and removed in the simulation's own order. One step a tick, of PHYSICS_STEP: a
// tick's length on screen at the game's 24-minute day (the basis WALK_SPEED is written on), so
// things fall at the pace the islanders walk; the simulation never reads the page's day length. The integration parameters are set here explicitly (the
// solver's iterations at Rapier's defaults), so an upgrade that changes a default shows in the diff.
// The save holds the world as Rapier's snapshot (SimState.physics, taken when the game is saved:
// Sim.save), whose format is Rapier's: a Rapier upgrade bumps SAVE_VERSION. A restored world
// continues bit for bit, and its handles stay valid (tools/verify-game.mjs).
//
// Scene queries (the drop's overlap test, things.ts) see the world as the last step left it: a
// body made since is not in them yet.

/** one step a tick (s): a tick on screen at the game's 24-minute day at 1x, 1/60 s */
export const PHYSICS_STEP = 1440 / SECONDS_PER_GAME_DAY;
const GRAVITY = - 9.81;
// Rapier's defaults, set so that a change of them shows
const SOLVER_ITERATIONS = 4;
const PGS_ITERATIONS = 1;
const CCD_SUBSTEPS = 1;

/** the ground's height off the land: below the sea (y 0), where whatever falls is lost (things.ts) */
const SEA_FLOOR = - 1;
/** a heightfield vertex is on the land within this distance (m) of the island top: its rim
 * (grid.ts RIM_MARGIN) */
const RIM_REACH = 0.9;
/** the heightfield spans the island top's bounds grown by this much (m) */
const GROUND_PAD = 2;

/** an islander's capsule: its radius (m) and its bottom's height above the surface (m) */
export const BODY_RADIUS = 0.2;
const LIFT = 0.03;

type Rapier = typeof import( '@dimforge/rapier3d-deterministic-compat' ).default;
let RAPIER: Rapier;
let ready: Promise<void> | null = null;

/** Load the engine; once, before any simulation exists. */
export function initPhysics(): Promise<void> {

	return ready ??= import( '@dimforge/rapier3d-deterministic-compat' ).then( async ( module ) => {

		await module.default.init();
		RAPIER = module.default;

	} );

}

/** base64 of bytes, in node and the page alike (btoa takes a binary string) */
function encode( bytes: Uint8Array ): string {

	let s = '';
	for ( let k = 0; k < bytes.length; k += 0x8000 ) s += String.fromCharCode( ...bytes.subarray( k, k + 0x8000 ) );
	return btoa( s );

}

function decode( text: string ): Uint8Array {

	const s = atob( text ), bytes = new Uint8Array( s.length );
	for ( let k = 0; k < s.length; k ++ ) bytes[ k ] = s.charCodeAt( k );
	return bytes;

}

/** An islander's stature (m) at a tick. */
export function statureOf( v: Readonly<Villager>, tick: number ): number {

	return heightAt( v.sex, ageOf( v, tick ) );

}

const yawQuaternion = ( yaw: number ) => ( { x: 0, y: Math.sin( yaw / 2 ), z: 0, w: Math.cos( yaw / 2 ) } );

export class Physics {

	readonly world: World;

	/** A new world (`snapshot` empty), else the one a save holds. */
	constructor( snapshot: string ) {

		this.world = snapshot ? RAPIER.World.restoreSnapshot( decode( snapshot ) ) : new RAPIER.World( { x: 0, y: GRAVITY, z: 0 } );
		const w = this.world;
		w.timestep = PHYSICS_STEP;
		w.numSolverIterations = SOLVER_ITERATIONS;
		w.numInternalPgsIterations = PGS_ITERATIONS;
		w.maxCcdSubsteps = CCD_SUBSTEPS;

	}

	/** The world as a save keeps it (base64 of Rapier's snapshot). */
	snapshot(): string {

		return encode( this.world.takeSnapshot() );

	}

	step(): void {

		this.world.step();

	}

	free(): void {

		this.world.free();

	}

	// ------------------------------------------------------------------ the ground

	/** The ground's heightfield for the grid's island top, in place of the one before (state.ground). */
	setGround( state: SimState, grid: Grid ): void {

		const w = this.world;
		if ( state.ground >= 0 ) w.removeCollider( w.getCollider( state.ground ), true );
		const { cols, top } = grid;
		// the island top's bounds, in cells
		let i0 = Infinity, i1 = - Infinity, j0 = Infinity, j1 = - Infinity;
		for ( let k = 0; k < top.length; k ++ ) {

			if ( ! top[ k ] ) continue;
			const i = k % cols, j = ( k - i ) / cols;
			i0 = Math.min( i0, i ); i1 = Math.max( i1, i ); j0 = Math.min( j0, j ); j1 = Math.max( j1, j );

		}
		const pad = Math.ceil( ( RIM_REACH + GROUND_PAD ) / grid.size );
		i0 -= pad; i1 += pad; j0 -= pad; j1 += pad;
		const reach = Math.ceil( RIM_REACH / grid.size );
		const onLand = ( i: number, j: number ) => {

			for ( let dj = - reach; dj <= reach; dj ++ ) for ( let di = - reach; di <= reach; di ++ ) {

				if ( Math.hypot( di, dj ) * grid.size > RIM_REACH + 1e-6 || ! grid.inBounds( i + di, j + dj ) ) continue;
				if ( top[ ( j + dj ) * cols + i + di ] ) return true;

			}
			return false;

		};
		// a column per x (i), a row per z (j), column-major
		const ncols = i1 - i0 + 1, nrows = j1 - j0 + 1;
		const heights = new Float32Array( ncols * nrows );
		for ( let c = 0; c < ncols; c ++ ) for ( let r = 0; r < nrows; r ++ ) {

			const i = i0 + c, j = j0 + r;
			const x = grid.x0 + ( i + 0.5 ) * grid.size, z = grid.z0 + ( j + 0.5 ) * grid.size;
			heights[ c * nrows + r ] = onLand( i, j ) ? grid.height( x, z ) : SEA_FLOOR;

		}
		const sx = ( ncols - 1 ) * grid.size, sz = ( nrows - 1 ) * grid.size;
		const desc = RAPIER.ColliderDesc.heightfield( nrows - 1, ncols - 1, heights, { x: sx, y: 1, z: sz }, RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES )
			.setTranslation( grid.x0 + ( i0 + 0.5 ) * grid.size + sx / 2, 0, grid.z0 + ( j0 + 0.5 ) * grid.size + sz / 2 );
		state.ground = w.createCollider( desc ).handle;

	}

	// ------------------------------------------------------------------ the islanders and buildings

	/** An islander's capsule, standing where it stands. */
	addBody( v: Villager, grid: Grid, tick: number ): void {

		const stature = statureOf( v, tick );
		const body = this.world.createRigidBody( RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation( v.pos.x, grid.height( v.pos.x, v.pos.z ) + LIFT + stature / 2, v.pos.z ) );
		this.world.createCollider( RAPIER.ColliderDesc.capsule( stature / 2 - BODY_RADIUS, BODY_RADIUS ), body );
		v.body = body.handle;

	}

	removeBody( handle: number ): void {

		this.world.removeRigidBody( this.world.getRigidBody( handle ) );

	}

	/** Before the step: each islander's capsule to where it walked (and its stature), each building's
	 * box as its stage draws it. */
	syncBodies( state: SimState, grid: Grid ): void {

		const w = this.world;
		for ( const v of state.villagers ) {

			const body = w.getRigidBody( v.body ), collider = body.collider( 0 );
			const stature = statureOf( v, state.tick ), half = stature / 2 - BODY_RADIUS;
			// a child's capsule grows by the centimetre
			if ( Math.abs( collider.halfHeight() - half ) > 0.01 ) collider.setHalfHeight( half );
			const y = grid.height( v.pos.x, v.pos.z ) + LIFT + BODY_RADIUS + collider.halfHeight();
			const t = body.translation();
			// (Rapier keeps single floats: a body standing still is left alone, so it can sleep)
			if ( Math.abs( t.x - v.pos.x ) > 1e-4 || Math.abs( t.z - v.pos.z ) > 1e-4 || Math.abs( t.y - y ) > 1e-4 ) body.setNextKinematicTranslation( { x: v.pos.x, y, z: v.pos.z } );

		}
		for ( const b of state.buildings ) this.syncBuilding( b, grid );

	}

	private syncBuilding( b: BuildingState, grid: Grid ): void {

		const w = this.world, box = bodyBox( b );
		if ( ! box ) {

			if ( b.collider !== null ) w.removeCollider( w.getCollider( b.collider ), true );
			b.collider = null;
			return;

		}
		const centre = { x: b.x, y: grid.height( b.x, b.z ) + box.half.y, z: b.z };
		if ( b.collider === null ) {

			const desc = RAPIER.ColliderDesc.cuboid( box.half.x, box.half.y, box.half.z ).setTranslation( centre.x, centre.y, centre.z ).setRotation( yawQuaternion( box.yaw ) );
			b.collider = w.createCollider( desc ).handle;
			return;

		}
		const collider = w.getCollider( b.collider ), now = collider.halfExtents()!;
		if ( Math.abs( now.x - box.half.x ) < 1e-4 && Math.abs( now.y - box.half.y ) < 1e-4 && Math.abs( now.z - box.half.z ) < 1e-4 ) return;
		collider.setHalfExtents( box.half );
		collider.setTranslation( centre );

	}

	// ------------------------------------------------------------------ things

	/** A dynamic body: a rounded box of full `size` with its corners `border` round. */
	addThing( spec: { size: Vec3; border: number; density: number; friction: number; restitution: number; linearDamping: number; angularDamping: number }, at: Vec3, rot: readonly number[], linvel: Vec3, angvel: Vec3 ): number {

		const w = this.world;
		const body = w.createRigidBody( RAPIER.RigidBodyDesc.dynamic()
			.setTranslation( at.x, at.y, at.z ).setRotation( { x: rot[ 0 ], y: rot[ 1 ], z: rot[ 2 ], w: rot[ 3 ] } )
			.setLinvel( linvel.x, linvel.y, linvel.z ).setAngvel( angvel )
			.setLinearDamping( spec.linearDamping ).setAngularDamping( spec.angularDamping ).setCcdEnabled( true ) );
		const b = spec.border, s = spec.size;
		w.createCollider( RAPIER.ColliderDesc.roundCuboid( s.x / 2 - b, s.y / 2 - b, s.z / 2 - b, b )
			.setDensity( spec.density ).setFriction( spec.friction ).setRestitution( spec.restitution ), body );
		return body.handle;

	}

	/** Whether a rounded box of full `size` at a pose overlaps any collider (the world as the last
	 * step left it), the bodies `exclude` names aside. */
	overlaps( size: Vec3, border: number, at: Vec3, rot: readonly number[], exclude: number | null ): boolean {

		const shape = new RAPIER.RoundCuboid( size.x / 2 - border, size.y / 2 - border, size.z / 2 - border, border );
		const body = exclude === null ? undefined : this.world.getRigidBody( exclude );
		return this.world.intersectionWithShape( at, { x: rot[ 0 ], y: rot[ 1 ], z: rot[ 2 ], w: rot[ 3 ] }, shape, undefined, undefined, undefined, body ) !== null;

	}

	/** A body's pose into a position and a quaternion [ x, y, z, w ]; whether it is asleep. */
	pose( handle: number, pos: Vec3, rot: number[] ): boolean {

		const body = this.world.getRigidBody( handle ), t = body.translation(), r = body.rotation();
		pos.x = t.x; pos.y = t.y; pos.z = t.z;
		rot[ 0 ] = r.x; rot[ 1 ] = r.y; rot[ 2 ] = r.z; rot[ 3 ] = r.w;
		return body.isSleeping();

	}

	sleeping( handle: number ): boolean {

		return this.world.getRigidBody( handle ).isSleeping();

	}

}
