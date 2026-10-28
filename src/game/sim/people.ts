import { cellsWithin } from './ground.ts';
import { BAG_CAPACITY, addItems, count, itemCount, removeItems, total } from './items.ts';
import { ageOf } from './life.ts';
import { findPath, lineClear, placeGoal } from './path.ts';
import type { DoArgs, Place, PlaceOption } from './places.ts';
import type { Sim } from './Sim.ts';
import type { Notice, Vec2, Villager } from './types.ts';

// The other islanders as places (docs/game-design.md, "People"): a person is a place that moves,
// one per living islander by its id (v2), of kind `person`, and offers its options to whoever
// stands beside them (within PERSON_REACH). There is no action of their own: what passes between
// islanders goes through the five actions like everything else.
//
// - Talking: `say` is heard by every other living islander within EARSHOT (straight distance, at
//   that tick), who notices who said what and when (Villager.noticed). Hearing is the only way
//   words reach another; nothing here needs the other's consent.
// - `give` ( { item, count = 1 } ), instant: the giver gives only what it carries, and a bag
//   without room for all of it refuses the whole gift (nothing moves). The one given to notices
//   it; the giver's Villager.gave keeps the hand-over for the record.
// - `follow`, timed without end: it runs until a new action replaces it or the one followed is
//   gone. A walking follower walks on until its own cell is beside them (PERSON_REACH), so it
//   comes to rest with them at hand and can give without a `go`; a standing one stays put while
//   within FOLLOW_GAP of them, and steps beside them again once they stand. It finds its way
//   again only when it has no way or its way no longer ends beside them, so it re-plans as the
//   leader moves, not every tick: straight at them where the line is open (a way through the
//   cells beside them turns corners, and at the same pace each turn would leave it farther
//   behind), else by a path to those cells.
//
// What a person shows to anyone who sees them is their name, their age in whole years and what
// they are doing (a `do` by its option, `go`, `wait`, or `walk` for a walk without an action),
// never their needs, their bag or where they are. A body never stands at or sees itself
// (places.ts `placesFor`).

/** words carry this far (m) */
export const EARSHOT = 15;
/** what an islander notices between two thoughts, at most: the oldest are forgotten */
export const NOTICED_KEPT = 10;
/** standing within this distance (m: a cell's centre from the person) is standing beside them */
export const PERSON_REACH = 1.2;
/** a follower stands while within this distance (m) of the one followed: a step or two behind */
export const FOLLOW_GAP = 1.5;
// a follower in the open makes for a point this far short of the one followed (m)
const STEP_SHORT = 0.8;

const distance = ( a: Vec2, b: Vec2 ) => Math.hypot( a.x - b.x, a.z - b.z );

/** Something done to an islander, for its next thought; the oldest beyond NOTICED_KEPT go. */
export function notify( v: Villager, notice: Notice ): void {

	v.noticed.push( notice );
	if ( v.noticed.length > NOTICED_KEPT ) v.noticed.splice( 0, v.noticed.length - NOTICED_KEPT );

}

/** Words said: every other living islander within earshot hears them. */
export function hear( sim: Sim, speaker: Villager, words: string ): void {

	for ( const v of sim.state.villagers ) {

		if ( v !== speaker && distance( v.pos, speaker.pos ) <= EARSHOT ) notify( v, { who: speaker.id, tick: sim.state.tick, said: words } );

	}

}

/** What a person is seen doing: an option under way by its name, `go` or `wait`, `walk` for a
 * walk without an action (the debug panel's), else nothing. */
function doingOf( v: Villager ): string | null {

	const call = v.action?.call;
	if ( call?.tool === 'do' ) return String( ( call.args as DoArgs ).action );
	if ( call ) return call.tool;
	return v.path ? 'walk' : null;

}

function giveOption( person: Villager ): PlaceOption {

	return {
		open: () => true,
		start: ( sim, body, args ) => {

			const what = itemCount( args );
			if ( typeof what === 'string' ) return { ok: false, reason: what };
			const carried = count( body.bag, what.item );
			if ( carried < what.n ) return { ok: false, reason: `the bag holds ${ carried } ${ what.item }` };
			if ( total( person.bag ) + what.n > BAG_CAPACITY ) return { ok: false, reason: `${ person.id }'s bag has no room for that` };
			const tick = sim.state.tick;
			removeItems( body.bag, what.item, what.n );
			addItems( person.bag, what.item, what.n );
			notify( person, { who: body.id, tick, gave: { [ what.item ]: what.n } } );
			body.gave = { to: person.id, item: what.item, count: what.n, tick };
			return { ok: true, value: `gave ${ what.n } ${ what.item } to ${ person.id }` };

		},
	};

}

function followOption( person: Villager ): PlaceOption {

	return {
		open: () => true,
		start: () => ( { ok: true, seconds: null } ),
		during: ( sim, body ) => {

			// the person a place was built for may have died since: look them up by id
			const leader = sim.villager( person.id );
			if ( ! leader ) return { ok: false, reason: `${ person.id } is gone` };
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
	};

}

function personPlace( sim: Sim, v: Villager ): Place {

	const grid = sim.grid, p = v.pos;
	return {
		id: v.id,
		kind: 'person',
		moves: true,
		reaches: ( k ) => k >= 0 && Math.hypot( grid.centreX( k ) - p.x, grid.centreZ( k ) - p.z ) <= PERSON_REACH,
		near: () => cellsWithin( grid, p, PERSON_REACH ),
		distance: ( q ) => distance( q, p ),
		shows: () => ( { name: v.name, age: Math.floor( ageOf( v, sim.state.tick ) ), doing: doingOf( v ) } ),
		options: { give: giveOption( v ), follow: followOption( v ) },
	};

}

/** The living islanders as places (places.ts PLACE_KINDS). */
export function people( sim: Sim ): Place[] {

	return sim.state.villagers.map( ( v ) => personPlace( sim, v ) );

}

/** The living islander with an id as a place, or null (places.ts `placeById`). */
export function personById( sim: Sim, id: string ): Place | null {

	const v = sim.villager( id );
	return v ? personPlace( sim, v ) : null;

}
