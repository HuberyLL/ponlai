import type { SimEvent } from './events.ts';
import { cellsWithin } from './ground.ts';
import { ageOf } from './life.ts';
import type { DoArgs, Place } from './places.ts';
import { optionsAt } from './registry.ts';
import type { Sim } from './Sim.ts';
import { planar } from './maths.ts';
import type { Notice, Vec2, Villager } from './types.ts';

// The people system: the other islanders as places (docs/game-design.md, "People"). A person is a
// place that moves, one per living islander by its id (v2), of kind `person`, and offers the
// options registered at `person` (registry.ts; today give and follow: content/person.ts) to
// whoever stands beside them (within PERSON_REACH). There is no action of their own: what passes
// between islanders goes through the five actions like everything else.
//
// What islanders notice of one another is this system's (Villager.noticed), and it learns of it
// from the events alone (`notice`): words said (`said`, an islander's `say`) are heard by every
// other living islander within EARSHOT (straight distance, at that tick), who notices who said
// what and when; a hand-over (`gave`) is noticed by the one given to. Hearing is the only way words
// reach another; nothing here needs the other's consent. An islander keeps at most NOTICED_KEPT
// notices between two thoughts, the oldest forgotten.
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
const distance = ( a: Vec2, b: Vec2 ) => planar( a.x - b.x, a.z - b.z );

// Something done to an islander, for its next thought; the oldest beyond NOTICED_KEPT go.
function notify( v: Villager, notice: Notice ): void {

	v.noticed.push( notice );
	if ( v.noticed.length > NOTICED_KEPT ) v.noticed.splice( 0, v.noticed.length - NOTICED_KEPT );

}

/** What the people system hears of what happened (Sim.emit hands it every event as it comes): an
 * islander's words, which every other living islander within earshot hears, and a hand-over, which
 * the one given to notices. The player's words are not an islander's (the session keeps them:
 * ../Session.ts). */
export function notice( sim: Sim, e: SimEvent ): void {

	if ( e.kind === 'said' ) {

		const speaker = e.who === 'player' ? undefined : sim.villager( e.who );
		if ( ! speaker ) return;
		for ( const v of sim.state.villagers ) {

			if ( v !== speaker && distance( v.pos, speaker.pos ) <= EARSHOT ) notify( v, { who: speaker.id, tick: e.tick, said: e.words } );

		}

	} else if ( e.kind === 'gave' ) {

		const to = sim.villager( e.to );
		if ( to ) notify( to, { who: e.who, tick: e.tick, gave: { [ e.item ]: e.count } } );

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

/** A living islander as a place. */
export function personPlace( sim: Sim, v: Villager ): Place {

	const grid = sim.grid, p = v.pos;
	return {
		id: v.id,
		kind: 'person',
		reaches: ( k ) => k >= 0 && planar( grid.centreX( k ) - p.x, grid.centreZ( k ) - p.z ) <= PERSON_REACH,
		near: () => cellsWithin( grid, p, PERSON_REACH ),
		distance: ( q ) => distance( q, p ),
		shows: () => ( { name: v.name, age: Math.floor( ageOf( v, sim.state.tick ) ), doing: doingOf( v ) } ),
		moves: PERSON_REACH,
		options: optionsAt( 'person', v ),
	};

}

/** The living islanders as places (places.ts). */
export function people( sim: Sim ): Place[] {

	return sim.state.villagers.map( ( v ) => personPlace( sim, v ) );

}

/** The living islander with an id as a place, or null (places.ts `placeById`). */
export function personById( sim: Sim, id: string ): Place | null {

	const v = sim.villager( id );
	return v ? personPlace( sim, v ) : null;

}
