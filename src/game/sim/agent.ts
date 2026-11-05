import { ACTIONS, refuse, run } from './actions.ts';
import { timeOf } from './clock.ts';
import type { GameTime } from './clock.ts';
import { placesAt, placesFor } from './places.ts';
import { checkArgs } from './schema.ts';
import type { Sim } from './Sim.ts';
import type { ActionCall, ActionOutcome, ActionResult, EntityId, Items, Villager } from './types.ts';

// The agent loop's frame: a brain thinks from what an islander perceives and answers with tool
// calls, which run on the islander's body. The tools are the five actions (actions.ts).
//
// The answer is outside input, and `act` is its one entrance: whatever a brain (or the game's own
// controls) hands it, a list of calls each naming a tool of ACTIONS with arguments its schema
// takes (schema.ts), it checks here before any rule runs, and refuses the rest with the reason
// (events.ts: refused). It checks the islander too, when the answer comes: a brain may answer late
// (Sim.think), and an islander who died meanwhile is no longer on the island, so the answer is
// refused for them rather than acted on. A refused call is kept with its tool alone, never with
// arguments it was refused for, so nothing unchecked reaches the state or the save.
//
// Perception is what a person would perceive, never the world's state (docs/game-design.md,
// "Perception"): the time; the places and people in sight (within SIGHT, no occlusion yet), each
// by its id and kind, and what shows on them, as numbers, with no positions or distances (never
// the islander itself); the places stood at and their open `do` options; what others did to it
// since its last thought (the words it heard, what was handed to it: Villager.noticed, each by
// who, their name and the time); the body's needs and bag as numbers and the action under way;
// and how the last action ended. Memory, hearing the leader and what starts a thought are designed
// with the language model; until then the simulation asks for a thought whenever an islander has
// nothing under way (Sim.ts), and forgets what it noticed once that thought's answer is acted on.

/** what an islander sees round them (m): the whole island today */
export const SIGHT = 20;

/** What a tool did: its result, or why it could not. */
export type ToolResult = ActionResult;

export type ToolCall = ActionCall;

/** A place in sight, by its id and kind, and what shows on it (a site's progress; inside a chest,
 * while at it; a person's name, age and what they are doing). */
export interface SeenPlace {
	place: string;
	kind: string;
	shows?: Record<string, unknown>;
}

/** The game's time of a tick: the day counted from 1, and the time of day to the minute. */
export type PerceivedTime = GameTime;

/** Something another islander did to one, by who it was: words heard, or items handed over. */
export type NoticedEvent = { who: EntityId; name: string; time: PerceivedTime; said: string } | { who: EntityId; name: string; time: PerceivedTime; gave: Items };

/** What an islander perceives. */
export interface Perception {
	/** the day counted from 1, and the time of day to the minute */
	time: PerceivedTime;
	seen: SeenPlace[];
	/** the places stood at (usually one; none between places) and the `do` options each offers now */
	atHand: { place: string; options: string[] }[];
	/** what others did to it since its last thought, oldest first */
	noticed: NoticedEvent[];
	body: {
		/** 0..100, whole numbers */
		satiety: number;
		hydration: number;
		bag: Items;
		/** the action under way, or null */
		doing: ActionCall | null;
	};
	/** how the last action ended; null before the first */
	last: ActionOutcome | null;
}

/** What decides for the islanders (Sim.brain): tool calls now, or later through a Promise. It is
 * told whom it thinks for (the islander's id: a brain keeps a memory per islander). */
export interface Brain {
	think( perception: Perception, who: EntityId ): ToolCall[] | Promise<ToolCall[]>;
	/** whether it hears the player's words: the game asks it for a thought as they are said
	 * (Session.speak, Session.takeHeard); the stand-in does not */
	readonly hears?: boolean;
}

/** The perception hook: what an islander perceives now (copies: the brain cannot touch the state). */
export function perceive( sim: Sim, body: Villager ): Perception {

	const places = placesFor( sim, body );
	const here = placesAt( sim, body, places );
	const seen: SeenPlace[] = [];
	for ( const place of places ) {

		if ( place.distance( body.pos ) > SIGHT ) continue;
		const shows = place.shows( here.includes( place ) );
		seen.push( shows ? { place: place.id, kind: place.kind, shows } : { place: place.id, kind: place.kind } );

	}
	const startHour = sim.state.startHour;
	const noticed = body.noticed.map( ( n ): NoticedEvent => {

		const by = { who: n.who, name: sim.nameOf( n.who ) ?? n.who, time: timeOf( n.tick, startHour ) };
		return 'said' in n ? { ...by, said: n.said } : { ...by, gave: n.gave };

	} );
	return structuredClone( {
		time: timeOf( sim.state.tick, startHour ),
		seen,
		atHand: here.map( ( p ) => ( { place: p.id, options: Object.keys( p.options ).filter( ( o ) => p.options[ o ].open( sim ) ) } ) ),
		noticed,
		body: {
			satiety: Math.round( body.needs.satiety ),
			hydration: Math.round( body.needs.hydration ),
			bag: body.bag,
			doing: body.action?.call ?? null,
		},
		last: body.last,
	} );

}

/** The entrance: a brain's answer for an islander (by id), checked and run call by call, in
 * order; each refused call gets its reason. */
export function act( sim: Sim, who: EntityId, calls: unknown ): ToolResult[] {

	if ( ! Array.isArray( calls ) ) return [ refuseFor( sim, who, { tool: '' }, 'an answer is a list of tool calls' ) ];
	// every entry gets its result, in order (Array.from: a gap is a call that names no tool)
	return Array.from( calls, ( given: unknown ) => {

		const call: { tool?: unknown; args?: unknown } = typeof given === 'object' && given !== null ? given : {};
		const name = call.tool;
		if ( typeof name !== 'string' || name === '' ) return refuseFor( sim, who, { tool: '' }, 'a call names its tool' );
		const tool = ACTIONS.get( name );
		if ( ! tool ) return refuseFor( sim, who, { tool: name }, `there is no tool called ${ name }` );
		const body = sim.villager( who );
		if ( ! body ) return refuse( sim, null, who, { tool: name }, `${ who } is not on the island`, tool.mind );
		const checked = checkArgs( name, tool.args, call.args );
		if ( ! checked.ok ) return refuse( sim, body, who, { tool: name }, checked.reason, tool.mind );
		return run( sim, body, name, tool, checked.args );

	} );

}

// a call refused before its tool is known: perceived by the islander when they are on the island
function refuseFor( sim: Sim, who: EntityId, call: ActionCall, reason: string ): ToolResult {

	return refuse( sim, sim.villager( who ) ?? null, who, call, reason );

}
