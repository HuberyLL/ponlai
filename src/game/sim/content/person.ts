import { bagOf, count, itemCount, room, transfer } from '../items.ts';
import { planar } from '../maths.ts';
import { findPath, lineClear, placeGoal } from '../path.ts';
import { PERSON_REACH, personPlace } from '../people.ts';
import { register } from '../registry.ts';
import type { Vec2, Villager } from '../types.ts';

// What one islander can do with another, at a person (people.ts: a place that moves, beside whom
// one stands within PERSON_REACH):
//
// - `give` ( { item, count = 1 } ), instant: the giver gives only what it carries, and a bag
//   without room for all of it refuses the whole gift (nothing moves). The hand-over is an event
//   (events.ts `gave`), which the one given to notices (people.ts) and the record keeps.
// - `follow`, timed without end: it runs until a new action replaces it, or ends interrupted once
//   the one followed is gone (dead: their place is gone, actions.ts `holds`); it holds wherever
//   the follower stands, beside them or not. A walking follower walks on until its own cell is
//   beside them, so it comes to rest with them at hand and can give without a `go`; a standing one
//   stays put while within FOLLOW_GAP of them, and steps beside them again once they stand. It
//   finds its way again only when it has no way or its way no longer ends beside them, so it
//   re-plans as the leader moves, not every tick: straight at them where the line is open (a way
//   through the cells beside them turns corners, and at the same pace each turn would leave it
//   farther behind), else by a path to those cells.

/** a follower stands while within this distance (m) of the one followed: a step or two behind */
export const FOLLOW_GAP = 1.5;
// a follower in the open makes for a point this far short of the one followed (m)
const STEP_SHORT = 0.8;

const distance = ( a: Vec2, b: Vec2 ) => planar( a.x - b.x, a.z - b.z );

register( { options: [
	{ id: 'give', at: 'person', make: ( person: Villager ) => ( {
		open: () => true,
		start: ( sim, body, args ) => {

			const what = itemCount( args );
			if ( typeof what === 'string' ) return { ok: false, reason: what };
			const bag = bagOf( body ), theirs = bagOf( person );
			const carried = count( bag.items, what.item );
			if ( carried < what.n ) return { ok: false, reason: `the bag holds ${ carried } ${ what.item }` };
			if ( room( theirs ) < what.n ) return { ok: false, reason: `${ person.id }'s bag has no room for that` };
			transfer( sim, bag, theirs, what.item, what.n );
			sim.emit( { kind: 'gave', tick: sim.state.tick, who: body.id, to: person.id, item: what.item, count: what.n } );
			return { ok: true, value: `gave ${ what.n } ${ what.item } to ${ person.id }` };

		},
	} ) },
	{ id: 'follow', at: 'person', make: ( person: Villager ) => ( {
		open: () => true,
		start: () => ( { ok: true, seconds: null } ),
		// the place's being there is the condition (the one followed alive), checked before this
		// option's place is built each tick, so `person` is the living islander
		holds: () => null,
		during: ( sim, body ) => {

			const leader = person;
			const place = personPlace( sim, leader );
			const beside = place.reaches( sim.grid.indexAt( body.pos.x, body.pos.z ) );
			const gap = distance( body.pos, leader.pos );
			// walking: it has a way, or it walked this tick (to the end of a way that ran out)
			if ( body.path || body.pos.x !== body.prev.x || body.pos.z !== body.prev.z ) {

				// on until its own cell is beside them, then it stands there
				if ( beside ) {

					body.path = null;
					return null;

				}
				const end = body.path?.[ body.path.length - 1 ];
				if ( end && distance( end, leader.pos ) <= PERSON_REACH ) return null;

			} else if ( gap <= FOLLOW_GAP && ( beside || leader.path ) ) {

				// standing: it stays while within the gap, and steps beside them once they stand
				return null;

			}
			// in the open, straight at them, to a point a step short of them whose cell is beside
			// them (STEP_SHORT plus half a cell's diagonal within PERSON_REACH): a way through the
			// cells beside them turns corners and falls behind someone walking at the same pace
			const short = 1 - STEP_SHORT / gap;
			const point = { x: body.pos.x + ( leader.pos.x - body.pos.x ) * short, z: body.pos.z + ( leader.pos.z - body.pos.z ) * short };
			if ( gap > STEP_SHORT && lineClear( sim.grid, body.pos, point ) ) {

				body.path = [ point ];
				return null;

			}
			const goal = placeGoal( sim.grid, place );
			const path = goal && findPath( sim.grid, body.pos, goal );
			body.path = path && path.length > 0 ? path : null;
			// no way beside them: within the gap it stands where it is, beyond it the follow ends
			if ( ! path && gap > FOLLOW_GAP ) return { ok: false, reason: `no way to ${ person.id }` };
			return null;

		},
	} ) },
] } );
