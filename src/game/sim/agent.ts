import { dayOf, hourOf } from './clock.ts';
import { placesAt, placesFor } from './places.ts';
import type { Sim } from './Sim.ts';
import type { ActionCall, ActionOutcome, ActionResult, EntityId, Items, Villager } from './types.ts';

// The agent loop's frame: a brain thinks from what an islander perceives and answers with tool
// calls, which run on the islander's body. The tools are the five actions (actions.ts).
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

/** A tool: acts on an islander's body (and through it on the world). */
export type ToolHandler = ( body: Villager, args: unknown, sim: Sim ) => ToolResult;

/** Tool name to handler (Sim.tools). */
export type ToolRegistry = Map<string, ToolHandler>;

export type ToolCall = ActionCall;

/** A place in sight, by its id and kind, and what shows on it (a site's progress; inside a chest,
 * while at it; a person's name, age and what they are doing). */
export interface SeenPlace {
	place: string;
	kind: string;
	shows?: Record<string, unknown>;
}

/** The game's time of a tick: the day counted from 1, and the time of day to the minute. */
export interface PerceivedTime { day: number; hour: number; minute: number }

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
	 * (Game.speak, Game.takeHeard); the stand-in does not */
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
	const timeOf = ( tick: number ): PerceivedTime => {

		const at = { tick, startHour }, minutes = Math.floor( hourOf( at ) * 60 );
		return { day: dayOf( at ) + 1, hour: Math.floor( minutes / 60 ), minute: minutes % 60 };

	};
	const noticed = body.noticed.map( ( n ): NoticedEvent => {

		const by = { who: n.who, name: sim.nameOf( n.who ) ?? n.who, time: timeOf( n.tick ) };
		return 'said' in n ? { ...by, said: n.said } : { ...by, gave: n.gave };

	} );
	return structuredClone( {
		time: timeOf( sim.state.tick ),
		seen,
		atHand: here.map( ( p ) => ( { place: p.id, options: Object.keys( p.options ).filter( ( o ) => p.options[ o ].open( sim, body ) ) } ) ),
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

/** Run tool calls on a body, in order. */
export function act( sim: Sim, body: Villager, calls: readonly ToolCall[] ): ToolResult[] {

	return calls.map( ( call ) => {

		const tool = sim.tools.get( call.tool );
		return tool ? tool( body, call.args, sim ) : { ok: false, reason: `No tool named ${ call.tool }` };

	} );

}
