import { cellsWithin } from './ground.ts';
import { BAG_CAPACITY, count, intoBag, itemCount, removeItems, total } from './items.ts';
import { statureOf } from './physics.ts';
import type { Place } from './places.ts';
import type { Sim } from './Sim.ts';
import type { Thing, Vec2, Vec3, Villager } from './types.ts';

// Things on the ground (docs/game-design.md, "Things on the ground"): each item that leaves a bag
// for the ground is a thing of its own, one fish here and another there, never a pile or a count
// at a spot, and lies where the physics leaves it (physics.ts: a dynamic body each, in the
// simulation's deterministic world, so where a thing comes to rest is the simulation's, not the
// view's). SimState.things holds them in the order they came to lie, each by its id: its item's
// kind and the count of things ever made (fish3), never reused.
//
// - Each item kind's body comes from THING_KINDS: a rounded box of its size with its material.
// - The ground is a place (`ground`: kind and id `ground`), at hand on every walkable cell, at
//   distance 0, showing nothing. `drop` ( { item, count = 1 } ), instant: the bag gives only what
//   it carries (the same words as give's, people.ts). Each item falls from hand height (HAND of
//   the islander's stature) AHEAD of the body along its walking direction (prev to pos; standing
//   still, a direction from the generator), with a small spread of speed and spin from the
//   generator; several at once, stacked a few centimetres apart; a spawn point that overlaps a
//   collider moves up until it is clear (the world as the last step left it: physics.ts).
// - Each thing is a place: kind its item (fish), id its own, reaching the cells within REACH of
//   where it lies now, its distance to that point, showing nothing. `take` (no arguments),
//   instant, open while the bag has room: the body and the thing go, the bag gains the item. A
//   thing still rolling can be taken; one that rolls away is followed by `go` (actions.ts).
// - A catch that does not fit the bag falls at the islander's feet (places.ts shore), and a death
//   drops the whole bag where the islander stood (Sim.ts), both through `dropItems`.
//
// Each tick, after the world's step (Sim.ts): the things whose bodies moved copy their poses into
// the state (`settleThings`; `prev` the pose before, for the view to interpolate by Sim.alpha), a
// sleeping one keeps its pose with `prev` equal to it, and a thing below the sea's level (y < 0) is
// gone: its body is removed and it leaves `things`.

/** standing within this distance (m: a cell's centre from the thing) is standing beside it */
export const REACH = 0.9;
/** items fall from this share of the islander's stature (its hand) */
const HAND = 0.8;
/** and this far (m) ahead of its body's axis: clear of its capsule (physics.ts BODY_RADIUS) and of
 * half a fish's length */
const AHEAD = 0.45;
/** several items at once stack this far apart (m), over each one's height */
const STACK_GAP = 0.03;
/** a spawn point that overlaps moves up by this much (m) until it is clear, at most CLEAR_TRIES times */
const CLEAR_STEP = 0.02;
const CLEAR_TRIES = 100;

/** A kind of thing's body: a rounded box of full size (m: x across, y up, z along), its corners
 * `border` round, and its material. */
export interface ThingKind {
	size: Vec3;
	border: number;
	/** kg/m^3 */
	density: number;
	friction: number;
	restitution: number;
	linearDamping: number;
	angularDamping: number;
}

/** Each item kind's body, by kind (items.ts ITEMS). A fish (its snout to +z, its back +y) is about
 * 0.30 m long, 0.08 m high and 0.05 m thick, so it comes to rest on its flank; as dense as water,
 * gripping, barely bouncing (a wet fish), damped to settle within a second or two. */
export const THING_KINDS: Readonly<Record<string, ThingKind>> = {
	fish: { size: { x: 0.05, y: 0.08, z: 0.3 }, border: 0.015, density: 1000, friction: 0.8, restitution: 0.05, linearDamping: 0.4, angularDamping: 1.0 },
};

const distance = ( a: Vec2, b: Vec2 ) => Math.hypot( a.x - b.x, a.z - b.z );
const yawQuaternion = ( yaw: number ) => [ 0, Math.sin( yaw / 2 ), 0, Math.cos( yaw / 2 ) ];

/** A new thing of an item at a point (m), set off at a velocity (m/s) with a little spin from the
 * generator, held level and turned along its horizontal velocity (or a turn from the generator):
 * its body and its entry in SimState.things. Returns it. */
export function dropThing( sim: Sim, item: string, from: Vec3, velocity: Vec3 ): Thing {

	const state = sim.state, kind = THING_KINDS[ item ];
	const spin = () => ( sim.random() - 0.5 ) * 3;
	const yaw = Math.hypot( velocity.x, velocity.z ) > 1e-6 ? Math.atan2( velocity.x, velocity.z ) : sim.random() * 2 * Math.PI;
	const rot = yawQuaternion( yaw );
	const body = sim.physics.addThing( kind, from, rot, velocity, { x: spin(), y: spin(), z: spin() } );
	const thing: Thing = { id: `${ item }${ ++ state.nextThing }`, item, body, pos: { ...from }, rot: [ ...rot ], prev: { pos: { ...from }, rot: [ ...rot ] } };
	state.things.push( thing );
	return thing;

}

/**
 * Items out of an islander's hands onto the ground: from its hand AHEAD of it along its walking
 * direction (or one from the generator while it stands), tossed a little forward; `ahead` false,
 * where it stood (a death's bag), only let go. Several stack a few centimetres apart; each spawn
 * point that overlaps a collider (the islander's own capsule aside) moves up until it is clear.
 */
export function dropItems( sim: Sim, v: Villager, items: readonly ( readonly [ string, number ] )[], ahead = true ): void {

	const physics = sim.physics;
	let dx = v.pos.x - v.prev.x, dz = v.pos.z - v.prev.z;
	const d = Math.hypot( dx, dz );
	if ( d > 1e-9 ) {

		dx /= d;
		dz /= d;

	} else {

		const a = sim.random() * 2 * Math.PI;
		dx = Math.sin( a );
		dz = Math.cos( a );

	}
	const reach = ahead ? AHEAD : 0;
	const base = { x: v.pos.x + dx * reach, y: sim.grid.height( v.pos.x, v.pos.z ) + HAND * statureOf( v, sim.state.tick ), z: v.pos.z + dz * reach };
	let y = base.y;
	for ( const [ item, n ] of items ) {

		const kind = THING_KINDS[ item ];
		for ( let k = 0; k < n; k ++ ) {

			const at = { x: base.x, y, z: base.z };
			const yaw = Math.atan2( dx, dz );
			for ( let tries = 0; tries < CLEAR_TRIES && physics.overlaps( kind.size, kind.border, at, yawQuaternion( yaw ), v.body ); tries ++ ) at.y += CLEAR_STEP;
			// a toss forward of 0.4 to 0.8 m/s with a little to the side; let go, a drift of a few cm/s
			const speed = ahead ? 0.4 + 0.4 * sim.random() : 0.05 * sim.random();
			const side = ( sim.random() - 0.5 ) * ( ahead ? 0.3 : 0.05 );
			dropThing( sim, item, at, { x: dx * speed - dz * side, y: 0, z: dz * speed + dx * side } );
			y = at.y + kind.size.y + STACK_GAP;

		}

	}

}

/** A thing leaves the world: its body and its entry. */
export function removeThing( sim: Sim, thing: Thing ): void {

	sim.physics.removeBody( thing.body );
	const things = sim.state.things;
	things.splice( things.indexOf( thing ), 1 );

}

/** After the world's step: the moving things' poses into the state, the lost ones gone. */
export function settleThings( sim: Sim ): void {

	const things = sim.state.things;
	let lost = false;
	for ( const t of things ) {

		const { pos, rot, prev } = t;
		// it moved last tick: it may have come to rest in this one, so read it once more
		const moved = prev.pos.x !== pos.x || prev.pos.y !== pos.y || prev.pos.z !== pos.z || prev.rot.some( ( q, k ) => q !== rot[ k ] );
		prev.pos.x = pos.x; prev.pos.y = pos.y; prev.pos.z = pos.z;
		for ( let k = 0; k < 4; k ++ ) prev.rot[ k ] = rot[ k ];
		if ( moved || ! sim.physics.sleeping( t.body ) ) sim.physics.pose( t.body, pos, rot );
		if ( pos.y < 0 ) lost = true;

	}
	if ( ! lost ) return;
	for ( const t of things.filter( ( t ) => t.pos.y < 0 ) ) removeThing( sim, t );

}

// ------------------------------------------------------------------ the places

function thingPlace( sim: Sim, t: Thing ): Place {

	const grid = sim.grid, p = t.pos;
	return {
		id: t.id,
		kind: t.item,
		moves: true,
		reaches: ( k ) => k >= 0 && Math.hypot( grid.centreX( k ) - p.x, grid.centreZ( k ) - p.z ) <= REACH,
		near: () => cellsWithin( grid, p, REACH ),
		distance: ( q ) => distance( q, p ),
		shows: () => null,
		options: {
			take: {
				open: ( _sim, body ) => total( body.bag ) < BAG_CAPACITY,
				start: ( s, body ) => {

					const full = intoBag( body, t.item );
					if ( full ) return { ok: false, reason: full };
					removeThing( s, t );
					return { ok: true, value: `took 1 ${ t.item }` };

				},
			},
		},
	};

}

/** The things lying on the ground as places (places.ts PLACE_KINDS). */
export function things( sim: Sim ): Place[] {

	return sim.state.things.map( ( t ) => thingPlace( sim, t ) );

}

/** The thing with an id as a place, or null (places.ts placeById). */
export function thingById( sim: Sim, id: string ): Place | null {

	const t = sim.state.things.find( ( x ) => x.id === id );
	return t ? thingPlace( sim, t ) : null;

}

/** The ground as a place (places.ts PLACE_KINDS): at hand wherever one can walk. */
export function ground( sim: Sim ): Place {

	const open = sim.grid.open;
	return {
		id: 'ground',
		kind: 'ground',
		reaches: ( k ) => k >= 0 && open[ k ] === 1,
		// never walked to: it is wherever one stands
		near: () => [],
		distance: () => 0,
		shows: () => null,
		options: {
			drop: {
				open: ( _sim, body ) => total( body.bag ) > 0,
				start: ( s, body, args ) => {

					const what = itemCount( args );
					if ( typeof what === 'string' ) return { ok: false, reason: what };
					const carried = count( body.bag, what.item );
					if ( carried < what.n ) return { ok: false, reason: `the bag holds ${ carried } ${ what.item }` };
					removeItems( body.bag, what.item, what.n );
					dropItems( s, body, [ [ what.item, what.n ] ] );
					return { ok: true, value: `dropped ${ what.n } ${ what.item }` };

				},
			},
		},
	};

}
