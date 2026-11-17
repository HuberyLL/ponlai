import { bagOf, count, spend, takeMoves, watchMoves } from './items.ts';
import { findPath, goalAt, placeGoal } from './path.ts';
import { placeById, placesAt } from './places.ts';
import type { DoArgs, Place, Start } from './places.ts';
import { itemKind } from './registry.ts';
import type { ArgsOf, Schema } from './schema.ts';
import type { Sim } from './Sim.ts';
import type { ActionCall, ActionResult, ActionState, EntityId, Items, Outcome, Vec2, Villager } from './types.ts';

// The five actions an islander acts through, registered as the agent's tools.
//
// The five actions an islander acts through, registered as the agent's tools (ACTIONS), each with
// the arguments it takes (schema.ts: the entrance, agent.ts `act`, checks them before any rule
// here runs, so the rules take them as given):
//
//   go( { place } )      walk to a place or a person, named by its id, never a point (the body
//                        finds the way, and keeps after a person who moves until beside them)
//   say( { words } )     say something (heard within earshot: people.ts), alongside whatever the
//                        body is doing
//   wait( { seconds } )  stand for a while
//   do( { action, place?, item?, count? } ) run an option of a place the islander stands at
//                        (places.ts; the options registered at its kind: registry.ts): the one
//                        `place` names, else the first that offers it
//   use( { item, use? } ) run a use of a carried item (its kind's uses: registry.ts ItemDef); the
//                        first unless one is named
//
// Rules: a new action replaces the one under way (a refused one replaces nothing); stopping is not
// an action. Saying is the exception: speech comes from the mind, not the body (`mind`), so it
// neither replaces the action under way nor takes the place of its outcome in Villager.last. An
// action with duration (walking, waiting, fishing, building, following) is Villager.action and
// advances per tick (`advanceAction`); an instant one (use, put, take, give) is done at once. Every
// call ends in one of a few outcomes (events.ts: done, failed, interrupted, refused, replaced),
// which the next thought perceives in Villager.last and the session hears as an event; a tool's
// own result says whether the action began (or what it did, when instant).
//
// An action under way holds only while what it needs is still there: each timed tool declares
// that condition (`holds`: the place it goes to or acts at still there, still offering the option,
// still stood at), and `holdAction` checks it every tick before the body walks or the action
// advances, in this one place. When it fails the action ends interrupted, with the reason, whatever caused it (the one
// followed died, a growth turned the shore inland, the islander was moved). The rules for an
// option under way need not check again what its condition says. A timed `do` runs its option's
// `during` every tick it lasts (building adds its work there and ends when the work is done), then
// its `finish` when its time is up; one without an end (`follow`) runs until a new action replaces
// it, its `during` ends it, or its condition fails.

/** An action as an agent's tool. */
export interface Tool<S extends Schema = Schema> {
	/** the arguments it takes, checked at the entrance before it begins (schema.ts) */
	readonly args: S;
	/** speech, from the mind: it runs beside the action under way, replaces nothing, and its
	 * outcome is an event (`said`), never Villager.last */
	readonly mind?: true;
	/** the arguments completed from where the body stands, before it begins (`do`: the place that
	 * offers the option), so the call kept and perceived names them */
	complete?( sim: Sim, body: Villager, args: ArgsOf<S> ): ArgsOf<S>;
	/** Begin on a body: refused (and nothing changed), done at once, or under way for `seconds`
	 * (null: until it ends itself), walking `path` where it walks. It must not touch the body's
	 * action or path: a new action replaces the one under way only once it has begun. */
	start( sim: Sim, body: Villager, args: ArgsOf<S> ): Start | { ok: true; seconds: null; path: Vec2[] };
	/** Whether it can go on, every tick it is under way, before it advances: null, or why not (it
	 * then ends interrupted). Without it, it always can. */
	holds?( sim: Sim, body: Villager, args: ArgsOf<S> ): string | null;
	/** A tick of it under way, after its condition held and the body walked: a result ends it. */
	step?( sim: Sim, body: Villager, args: ArgsOf<S>, action: ActionState ): ActionResult | null;
}

/** Tool name to tool (the agent's tools: ACTIONS). */
export type ToolRegistry = ReadonlyMap<string, Tool>;

/** What a call that began with duration answers: its outcome comes when it ends. */
const UNDER_WAY: ActionResult = { ok: true, value: 'under way' };

/** An action ends (or an instant one is done, or one under way is replaced): the body stops, the
 * next thought perceives how (never a replacement: the new action's own outcome comes), and the
 * session hears it. */
function end( sim: Sim, body: Villager, call: ActionCall, outcome: Outcome, result: ActionResult, moved?: Record<EntityId, Items> ): ActionResult {

	body.action = null;
	body.path = null;
	if ( outcome !== 'replaced' ) body.last = { call, outcome, result };
	sim.emit( moved ? { kind: 'outcome', tick: sim.state.tick, who: body.id, call, outcome, result, moved } : { kind: 'outcome', tick: sim.state.tick, who: body.id, call, outcome, result } );
	return result;

}

/** A call refused: it changes nothing and replaces nothing, but the next thought perceives why
 * (never a word's: speech is the mind's), and the session hears it. The body is null when the
 * islander is no longer on the island (a late answer). */
export function refuse( sim: Sim, body: Villager | null, who: EntityId, call: ActionCall, reason: string, mind = false ): ActionResult {

	const result: ActionResult = { ok: false, reason };
	if ( body && ! mind ) body.last = { call, outcome: 'refused', result };
	sim.emit( { kind: 'outcome', tick: sim.state.tick, who, call, outcome: 'refused', result } );
	return result;

}

/** The action under way ends: something else takes the body over (a new action; the debug
 * panel's walk). */
export function stopAction( sim: Sim, body: Villager ): void {

	if ( body.action ) end( sim, body, body.action.call, 'replaced', { ok: false, reason: 'replaced' } );
	body.path = null;

}

/** The action under way ends as its islander dies. */
export function interruptAction( sim: Sim, body: Villager, reason: string ): void {

	if ( body.action ) end( sim, body, body.action.call, 'interrupted', { ok: false, reason } );

}

// ------------------------------------------------------------------ the five actions

const GO = { place: { type: 'text' } } as const;
const SAY = { words: { type: 'text' } } as const;
const WAIT = { seconds: { type: 'positive' } } as const;
const DO = { action: { type: 'text' }, place: { type: 'text', optional: true }, item: { type: 'text', optional: true }, count: { type: 'count', optional: true } } as const;
const USE = { item: { type: 'text' }, use: { type: 'text', optional: true } } as const;

const go: Tool<typeof GO> = {
	args: GO,
	start: ( sim, body, args ) => {

		const place = placeById( sim, body, args.place );
		if ( ! place ) return { ok: false, reason: `there is no place called ${ args.place }` };
		const goal = placeGoal( sim.grid, place );
		const path = goal && findPath( sim.grid, body.pos, goal );
		if ( ! path ) return { ok: false, reason: `no way to the ${ place.id }` };
		if ( path.length === 0 ) return { ok: true, value: `already at the ${ place.id }` };
		return { ok: true, seconds: null, path };

	},
	holds: ( sim, body, args ) => placeById( sim, body, args.place ) ? null : `${ args.place } is gone`,
	step: ( sim, body, args ) => {

		// there: `holds` found it this tick
		const place = placeById( sim, body, args.place ) as Place;
		if ( place.moves !== undefined ) {

			// a place that moves (a person): find the way again whenever it no longer ends at it
			const tail = body.path?.[ body.path.length - 1 ];
			if ( tail ? place.distance( tail ) > place.moves : ! place.reaches( sim.grid.indexAt( body.pos.x, body.pos.z ) ) ) {

				const goal = placeGoal( sim.grid, place );
				const path = goal && findPath( sim.grid, body.pos, goal );
				body.path = path && path.length > 0 ? path : null;
				if ( body.path ) return null;

			}

		}
		if ( body.path ) return null;
		const k = sim.grid.indexAt( body.pos.x, body.pos.z );
		return place.reaches( k ) ? { ok: true, value: `arrived at the ${ place.id }` } : { ok: false, reason: 'could not get there' };

	},
};

const say: Tool<typeof SAY> = {
	args: SAY,
	mind: true,
	start: ( sim, body, args ) => {

		// heard by those within earshot: the people system hears the event (people.ts `notice`)
		sim.emit( { kind: 'said', tick: sim.state.tick, who: body.id, words: args.words } );
		return { ok: true, value: 'said it' };

	},
};

const wait: Tool<typeof WAIT> = {
	args: WAIT,
	start: ( _sim, _body, args ) => ( { ok: true, seconds: Math.ceil( args.seconds ) } ),
	step: ( sim, _body, _args, action ) => action.until !== null && sim.state.tick >= action.until ? { ok: true, value: 'waited' } : null,
};

const use: Tool<typeof USE> = {
	args: USE,
	start: ( sim, body, args ) => {

		const kind = itemKind( args.item );
		if ( ! kind ) return { ok: false, reason: `there is no item called ${ args.item }` };
		if ( count( body.bag, args.item ) === 0 ) return { ok: false, reason: `no ${ args.item } in the bag` };
		const uses = kind.uses;
		const how = args.use ?? Object.keys( uses )[ 0 ];
		if ( ! Object.hasOwn( uses, how ) ) return { ok: false, reason: `a ${ args.item } is not for ${ how }` };
		// a use that fails changes nothing, and is refused like any call that does not begin
		const result = uses[ how ]( body );
		if ( result.ok ) spend( sim, bagOf( body ), args.item, 1 );
		return result;

	},
};

const offers = ( p: Place, action: string ) => Object.hasOwn( p.options, action );

const doAction: Tool<typeof DO> = {
	args: DO,
	// the place named, else one stood at that offers it now, first: a built building keeps the
	// work on it closed (content/build.ts), so that does not take the place of its kind's options
	complete: ( sim, body, args ) => {

		if ( args.place !== undefined ) return args;
		const here = placesAt( sim, body );
		const place = here.find( ( p ) => offers( p, args.action ) && p.options[ args.action ].open( sim ) ) ?? here.find( ( p ) => offers( p, args.action ) );
		const { action, ...rest } = args;
		return place ? { action, place: place.id, ...rest } : args;

	},
	start: ( sim, body, args ) => {

		const here = placesAt( sim, body );
		const place = args.place === undefined ? undefined : here.find( ( p ) => p.id === args.place );
		if ( args.place !== undefined && ! place ) return { ok: false, reason: `not at ${ args.place }` };
		if ( here.length === 0 ) return { ok: false, reason: 'not at any place' };
		if ( ! place ) return { ok: false, reason: `nothing here offers ${ args.action }` };
		if ( ! offers( place, args.action ) ) return { ok: false, reason: `${ place.id } does not offer ${ args.action }` };
		return place.options[ args.action ].start( sim, body, args as DoArgs );

	},
	// its place still there and still offering it (a built site keeps `build`, closed: its other
	// builders end done on their next step), and the option's own condition: by default the body
	// still stands at the place
	holds: ( sim, body, args ) => {

		const place = placeById( sim, body, args.place );
		if ( ! place ) return `${ args.place } is gone`;
		if ( ! offers( place, args.action ) ) return `${ place.id } no longer offers ${ args.action }`;
		const option = place.options[ args.action ];
		if ( option.holds ) return option.holds( sim, body, args as DoArgs );
		return place.reaches( sim.grid.indexAt( body.pos.x, body.pos.z ) ) ? null : `no longer at ${ place.id }`;

	},
	step: ( sim, body, args, action ) => {

		// there, and offering it: `holds` found them this tick
		const option = ( placeById( sim, body, args.place ) as Place ).options[ args.action ];
		const done = option.during?.( sim, body, args as DoArgs );
		if ( done ) return done;
		if ( action.until === null || sim.state.tick < action.until ) return null;
		return option.finish ? option.finish( sim, body, args as DoArgs ) : { ok: true };

	},
};

/** The five actions as the agent's tools. */
export const ACTIONS: ToolRegistry = new Map<string, Tool>( [
	[ 'go', go as unknown as Tool ],
	[ 'say', say as unknown as Tool ],
	[ 'wait', wait as unknown as Tool ],
	[ 'do', doAction as unknown as Tool ],
	[ 'use', use as unknown as Tool ],
] );

/** Run a call whose arguments the entrance checked (agent.ts `act`) on a body: refused, done at
 * once, or begun; a new action takes the body over from the one under way, which ends replaced. */
export function run( sim: Sim, body: Villager, name: string, tool: Tool, given: ArgsOf<Schema> ): ActionResult {

	const args = tool.complete ? tool.complete( sim, body, given ) : given;
	const call: ActionCall = { tool: name, args };
	// what an instant action moves between bags is its outcome's (items.ts)
	if ( ! tool.mind ) watchMoves( sim );
	const begun = tool.start( sim, body, args );
	const moved = tool.mind ? undefined : takeMoves( sim );
	if ( ! begun.ok ) return refuse( sim, body, body.id, call, begun.reason, tool.mind );
	if ( tool.mind ) return begun;
	stopAction( sim, body );
	if ( ! ( 'seconds' in begun ) ) return end( sim, body, call, 'done', begun, moved );
	body.path = 'path' in begun ? begun.path : null;
	body.action = { call, until: begun.seconds === null ? null : sim.state.tick + begun.seconds };
	sim.emit( { kind: 'began', tick: sim.state.tick, who: body.id, call } );
	return UNDER_WAY;

}

/** The condition of the action under way, every tick before the body walks (walking is how `go`
 * and a follow advance): where it no longer holds the action ends interrupted, with the reason, and
 * the body stops where it stands. */
export function holdAction( sim: Sim, body: Villager ): void {

	const action = body.action;
	if ( ! action ) return;
	const why = toolOf( action.call.tool ).holds?.( sim, body, action.call.args as ArgsOf<Schema> ) ?? null;
	if ( why !== null ) end( sim, body, action.call, 'interrupted', { ok: false, reason: why } );

}

/** One tick of the action under way, after its condition held (`holdAction`) and the body walked:
 * advanced, and ended when it is done. */
export function advanceAction( sim: Sim, body: Villager ): void {

	const action = body.action;
	if ( ! action ) return;
	const call = action.call, tool = toolOf( call.tool ), args = call.args as ArgsOf<Schema>;
	// what a finish brings or spends (a catch) is the outcome's (items.ts)
	const finishing = action.until !== null && sim.state.tick >= action.until;
	if ( finishing ) watchMoves( sim );
	const result = tool.step?.( sim, body, args, action ) ?? null;
	const moved = finishing ? takeMoves( sim ) : undefined;
	if ( result ) end( sim, body, call, result.ok ? 'done' : 'failed', result, moved );

}

// The tool of an action under way: every one began through ACTIONS (a save of another version is
// never loaded: ../save.ts).
function toolOf( name: string ): Tool {

	const tool = ACTIONS.get( name );
	if ( ! tool ) throw new Error( `No tool named ${ name }` );
	return tool;

}

/** After the ground changed: find each walking body's way again, to the same place or point. */
export function findWaysAgain( sim: Sim ): void {

	for ( const body of sim.state.villagers ) {

		if ( ! body.path ) continue;
		const call = body.action?.call;
		const place = call?.tool === 'go' ? placeById( sim, body, ( call.args as ArgsOf<typeof GO> ).place ) : null;
		const goal = place ? placeGoal( sim.grid, place ) : goalAt( sim.grid, body.path[ body.path.length - 1 ] );
		const path = goal && findPath( sim.grid, body.pos, goal );
		// no way any more: the walk ends here (a `go` then ends as not arrived)
		body.path = path && path.length > 0 ? path : null;

	}

}

/** A call in a few words, for a readout: "go shore", "do fish shore", "wait 600". */
export function describeCall( call: ActionCall ): string {

	const args = typeof call.args === 'object' && call.args !== null ? Object.values( call.args ) : [];
	return [ call.tool, ...args.filter( ( value ) => value !== undefined ).map( String ) ].join( ' ' );

}

export type { DoArgs };
