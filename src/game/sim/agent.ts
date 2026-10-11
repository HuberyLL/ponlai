import { placesAt, placesOf } from './places.ts';
import type { Sim } from './Sim.ts';
import type { ActionCall, ActionOutcome, ActionResult, Items, Villager } from './types.ts';

// The agent loop's frame: a brain thinks from what an islander perceives and answers with tool
// calls, which run on the islander's body. The tools are the five actions (actions.ts).
//
// Perception is what a person would perceive, never the world's state (docs/game-design.md,
// "Perception"): the time; the places in sight (within SIGHT, no occlusion yet) and what shows on
// them, with no positions or distances; the places stood at and their open `do` options; the body's
// needs and bag as numbers and the action under way; and how the last action ended. Memory,
// hearing the leader and what starts a thought are designed with the language model; until then
// the simulation asks for a thought whenever an islander has nothing under way (Sim.ts).

/** what an islander sees round them (m): the whole island today */
export const SIGHT = 20;

/** What a tool did: its result, or why it could not. */
export type ToolResult = ActionResult;

/** A tool: acts on an islander's body (and through it on the world). */
export type ToolHandler = ( body: Villager, args: unknown, sim: Sim ) => ToolResult;

/** Tool name to handler (Sim.tools). */
export type ToolRegistry = Map<string, ToolHandler>;

export type ToolCall = ActionCall;

/** A place in sight, by its id, and what shows on it (coconuts on a palm; inside the chest, while at it). */
export interface SeenPlace {
	place: string;
	shows?: Record<string, unknown>;
}

/** What an islander perceives. */
export interface Perception {
	/** the day counted from 1, and the time of day to the minute */
	time: { day: number; hour: number; minute: number };
	seen: SeenPlace[];
	/** the places stood at (usually one; none between places) and the `do` options each offers now */
	atHand: { place: string; options: string[] }[];
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

/** What decides for the islanders (Sim.brain): tool calls now, or later through a Promise. */
export interface Brain {
	think( perception: Perception ): ToolCall[] | Promise<ToolCall[]>;
}

/** The perception hook: what an islander perceives now (copies: the brain cannot touch the state). */
export function perceive( sim: Sim, body: Villager ): Perception {

	const places = placesOf( sim );
	const here = placesAt( sim, body, places );
	const seen: SeenPlace[] = [];
	for ( const place of places ) {

		if ( place.distance( body.pos ) > SIGHT ) continue;
		const shows = place.shows( here.includes( place ) );
		seen.push( shows ? { place: place.id, shows } : { place: place.id } );

	}
	const minutes = Math.floor( sim.hour() * 60 );
	return structuredClone( {
		time: { day: sim.day() + 1, hour: Math.floor( minutes / 60 ), minute: minutes % 60 },
		seen,
		atHand: here.map( ( p ) => ( { place: p.id, options: Object.keys( p.options ).filter( ( o ) => p.options[ o ].open( sim ) ) } ) ),
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
