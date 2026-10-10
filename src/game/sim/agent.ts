import type { Sim } from './Sim.ts';
import type { EntityId, Vec2, Villager } from './types.ts';

// The agent loop's frame, without content: a brain thinks from what an islander perceives and
// answers with tool calls, which run on the islander's body. The tools and the perception are
// still to be designed: the registry is empty and the perception is a placeholder.

/** What a tool did: its result, or why it could not. */
export type ToolResult = { ok: true; value?: unknown } | { ok: false; reason: string };

/** A tool: acts on an islander's body (and through it on the world). */
export type ToolHandler = ( body: Villager, args: unknown, sim: Sim ) => ToolResult;

/** Tool name to handler (Sim.tools). */
export type ToolRegistry = Map<string, ToolHandler>;

export interface ToolCall { tool: string; args?: unknown }

/** What an islander perceives: a placeholder until perception is designed. */
export interface Perception {
	/** the day counted from 1 */
	time: { day: number; hour: number };
	self: { id: EntityId; pos: Vec2 };
}

/** What decides for the islanders (Sim.brain): tool calls now, or later through a Promise. */
export interface Brain {
	think( perception: Perception ): ToolCall[] | Promise<ToolCall[]>;
}

/** The perception hook: what an islander perceives now. */
export function perceive( sim: Sim, body: Villager ): Perception {

	return { time: { day: sim.day() + 1, hour: sim.hour() }, self: { id: body.id, pos: { ...body.pos } } };

}

/** Run tool calls on a body, in order. */
export function act( sim: Sim, body: Villager, calls: readonly ToolCall[] ): ToolResult[] {

	return calls.map( ( call ) => {

		const tool = sim.tools.get( call.tool );
		return tool ? tool( body, call.args, sim ) : { ok: false, reason: `No tool named ${ call.tool }` };

	} );

}
