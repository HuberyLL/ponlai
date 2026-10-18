import type { ToolHandler, ToolRegistry } from './agent.ts';
import { ITEMS, count, isItem, removeItems } from './items.ts';
import { findPath, goalAt } from './path.ts';
import type { Goal } from './path.ts';
import { placesAt, placesOf } from './places.ts';
import type { DoArgs, Place } from './places.ts';
import type { Sim } from './Sim.ts';
import type { ActionCall, ActionResult, Villager } from './types.ts';

// The five actions an islander acts through, registered as the brain's tools (Sim.tools):
//
//   go( { place } )      walk to a place, named by its id, never a point (the body finds the way)
//   say( { words } )     say something (kept in Villager.said; nobody hears it yet), alongside
//                        whatever the body is doing
//   wait( { seconds } )  stand for a while
//   do( { action, ... } ) run an option of a place the islander stands at (places.ts)
//   use( { item, use? } ) run a use of a carried item (items.ts); the first unless one is named
//
// Rules: a new action replaces the one under way (a refused one replaces nothing); stopping is not
// an action. Saying is the exception: speech comes from the mind, not the body, so it neither
// replaces the action under way nor takes the place of its outcome in Villager.last. An action with duration (walking, waiting, fishing, picking, building) is Villager.action and
// advances per tick (`advanceAction`); it ends with an outcome in Villager.last, which the next
// thought perceives. An instant one (use, put, take, a refusal) leaves its outcome there at
// once. A tool's own result says whether the action began (or what it did, when instant). A timed
// `do` runs its option's `during` every tick it lasts (building adds its work there and ends when
// the work is done), then its `finish` when its time is up.

/** How a call begins: refused, done, or under way (its outcome comes when it ends). */
const UNDER_WAY: ActionResult = { ok: true, value: 'under way' };

/** An action ends (or an instant one is done): its outcome is what the next thought perceives. */
function end( body: Villager, call: ActionCall, result: ActionResult ): ActionResult {

	body.action = null;
	body.last = { call, result };
	return result;

}

/** A call refused: it replaces nothing, but the next thought perceives why. */
function refuse( body: Villager, call: ActionCall, reason: string ): ActionResult {

	const result: ActionResult = { ok: false, reason };
	body.last = { call, result };
	return result;

}

/** Stop whatever is under way: a new action takes the body over. */
function replace( body: Villager ): void {

	body.action = null;
	body.path = null;

}

function record( args: unknown ): Record<string, unknown> {

	return typeof args === 'object' && args !== null ? args as Record<string, unknown> : {};

}

/** Where to stand at a place: its open cells on the main ground. */
function placeGoal( sim: Sim, place: Place ): Goal | null {

	const grid = sim.grid;
	const cells = place.near().filter( ( k ) => grid.region[ k ] === grid.main && place.reaches( k ) );
	if ( cells.length === 0 ) return null;
	// no target point: the nearest cell by the walk (a search without a heuristic)
	return { cells, point: { x: 0, z: 0 }, slack: Infinity, exact: null };

}

const go: ToolHandler = ( body, args, sim ) => {

	const id = record( args ).place;
	const call = { tool: 'go', args: { place: id } };
	const place = placesOf( sim ).find( ( p ) => p.id === id );
	if ( ! place ) return refuse( body, call, `there is no place called ${ String( id ) }` );
	const goal = placeGoal( sim, place );
	const path = goal && findPath( sim.grid, body.pos, goal );
	if ( ! path ) return refuse( body, call, `no way to the ${ place.id }` );
	replace( body );
	if ( path.length === 0 ) return end( body, call, { ok: true, value: `already at the ${ place.id }` } );
	body.path = path;
	body.action = { call, until: null };
	return UNDER_WAY;

};

const say: ToolHandler = ( body, args, sim ) => {

	const words = record( args ).words;
	if ( typeof words !== 'string' || words.trim() === '' ) return { ok: false, reason: 'nothing to say' };
	body.said = { words, tick: sim.state.tick };
	return { ok: true, value: 'said it' };

};

const wait: ToolHandler = ( body, args, sim ) => {

	const seconds = record( args ).seconds;
	const call = { tool: 'wait', args: { seconds } };
	if ( typeof seconds !== 'number' || ! ( seconds > 0 ) || ! Number.isFinite( seconds ) ) return refuse( body, call, 'wait a number of seconds above 0' );
	replace( body );
	body.action = { call, until: sim.state.tick + Math.ceil( seconds ) };
	return UNDER_WAY;

};

const use: ToolHandler = ( body, args ) => {

	const a = record( args );
	const call: ActionCall = { tool: 'use', args: a.use === undefined ? { item: a.item } : { item: a.item, use: a.use } };
	if ( ! isItem( a.item ) ) return refuse( body, call, `there is no item called ${ String( a.item ) }` );
	if ( count( body.bag, a.item ) === 0 ) return refuse( body, call, `no ${ a.item } in the bag` );
	const uses = ITEMS[ a.item ].uses;
	const how = a.use ?? Object.keys( uses )[ 0 ];
	if ( typeof how !== 'string' || ! Object.hasOwn( uses, how ) ) return refuse( body, call, `a ${ a.item } is not for ${ String( how ) }` );
	replace( body );
	const result = uses[ how ]( body );
	if ( result.ok ) removeItems( body.bag, a.item, 1 );
	return end( body, call, result );

};

const doAction: ToolHandler = ( body, args, sim ) => {

	const a = record( args );
	const action = String( a.action );
	const here = placesAt( sim, body );
	// a place that offers it now first: a built site keeps `build` closed (buildings.ts)
	const offers = ( p: Place ) => Object.hasOwn( p.options, action );
	const place = here.find( ( p ) => offers( p ) && p.options[ action ].open( sim ) ) ?? here.find( offers );
	const doArgs: DoArgs = { ...a, action, place: place?.id ?? '' };
	const call = { tool: 'do', args: doArgs };
	if ( here.length === 0 ) return refuse( body, call, 'not at any place' );
	if ( ! place ) return refuse( body, call, `nothing here offers ${ action }` );
	const start = place.options[ action ].start( sim, body, doArgs );
	if ( ! start.ok ) return refuse( body, call, start.reason );
	replace( body );
	if ( ! ( 'seconds' in start ) ) return end( body, call, start );
	body.action = { call, until: sim.state.tick + start.seconds };
	return UNDER_WAY;

};

/** The five actions as a brain's tools: a fresh registry. */
export function actionTools(): ToolRegistry {

	return new Map( [ [ 'go', go ], [ 'say', say ], [ 'wait', wait ], [ 'do', doAction ], [ 'use', use ] ] );

}

/** One tick of the action under way, after the body walked: end it when it is done. */
export function advanceAction( sim: Sim, body: Villager ): void {

	const action = body.action;
	if ( ! action ) return;
	const call = action.call;
	if ( call.tool === 'go' ) {

		if ( body.path ) return;
		const id = record( call.args ).place;
		const place = placesOf( sim ).find( ( p ) => p.id === id );
		const k = sim.grid.indexAt( body.pos.x, body.pos.z );
		end( body, call, place && place.reaches( k ) ? { ok: true, value: `arrived at the ${ place.id }` } : { ok: false, reason: 'could not get there' } );
		return;

	}
	if ( call.tool === 'do' ) {

		const args = call.args as DoArgs;
		const option = placesOf( sim ).find( ( p ) => p.id === args.place )?.options[ args.action ];
		const done = option?.during?.( sim, body, args );
		if ( done ) end( body, call, done );
		else if ( action.until !== null && sim.state.tick >= action.until ) end( body, call, option?.finish ? option.finish( sim, body, args ) : { ok: false, reason: 'the place is gone' } );
		return;

	}
	if ( action.until === null || sim.state.tick < action.until ) return;
	end( body, call, { ok: true, value: 'waited' } );

}

/** After the ground changed: find each walking body's way again, to the same place or point. */
export function findWaysAgain( sim: Sim ): void {

	for ( const body of sim.state.villagers ) {

		if ( ! body.path ) continue;
		const call = body.action?.call;
		const place = call?.tool === 'go' ? placesOf( sim ).find( ( p ) => p.id === record( call.args ).place ) : undefined;
		const goal = place ? placeGoal( sim, place ) : goalAt( sim.grid, body.path[ body.path.length - 1 ] );
		const path = goal && findPath( sim.grid, body.pos, goal );
		// no way any more: the walk ends here (a `go` then ends as not arrived)
		body.path = path && path.length > 0 ? path : null;

	}

}

/** A call in a few words, for a readout: "go shore", "do fish shore", "wait 600". */
export function describeCall( call: ActionCall ): string {

	const values = Object.values( record( call.args ) ).filter( ( value ) => value !== undefined );
	return [ call.tool, ...values.map( String ) ].join( ' ' );

}
