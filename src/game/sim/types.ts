// Plain data shared by the island simulation, its view, the debug panel and the tests. Nothing here
// imports three.js or touches the DOM: the simulation runs headless in node as well as in the
// page. Everything in SimState is JSON, so a save is the state itself.
//
// Node runs the simulation's TypeScript by stripping the types, so files under src/game/sim
// import types with `import type` and use only erasable syntax (no enums, namespaces or
// constructor parameter properties).

import { GROWTH } from '../../world/IslandGrowth.ts';
import type { LandLattice } from '../../world/IslandGrowth.ts';
import type { Sex } from '../../characters/Ages.ts';

export interface Vec2 { x: number; z: number }

/** A cell of the simulation's ground grid: column i along +x, row j along +z. */
export interface Cell { i: number; j: number }

export type EntityId = string;
/** one tick is one game second */
export const SECONDS_PER_GAME_DAY = 86400;
/** a year of an islander's life is a game day (docs/game-design.md, The islanders) */
export const SECONDS_PER_YEAR = SECONDS_PER_GAME_DAY;
/** an adult's walking speed, metres per game second: 1.8 m/s on screen at the game's 24-minute
 * day at 1x (a child and the old walk slower: life.ts `paceOf`) */
export const WALK_SPEED = 0.9 * 2880 / 86400;

/** the population the island's growth counts from (docs/game-design.md: a few islanders on a
 * small island) */
export const POPULATION_START = 3;
/**
 * The island's growth (docs/game-design.md, "How the island grows"): the population at which each
 * piece arrives, the first at index 0. A game-design number, not settled: for now one piece per 2
 * islanders above the starting 3, up to the growth horizon (IslandGrowth.ts GROWTH.maxSteps).
 */
export const GROWTH_STEPS: readonly number[] = Array.from( { length: GROWTH.maxSteps }, ( _, k ) => POPULATION_START + 2 * ( k + 1 ) );

/** The pieces the island has grown by at a population (GROWTH_STEPS). */
export function piecesFor( population: number ): number {

	let pieces = 0;
	while ( pieces < GROWTH_STEPS.length && population >= GROWTH_STEPS[ pieces ] ) pieces ++;
	return pieces;

}

/** An islander's body. */
export interface Villager {
	id: EntityId;
	name: string;
	/** palette index for the view (src/characters/looks.ts) */
	look: number;
	sex: Sex;
	/** the tick it was born at, before 0 for those who came grown (its age: life.ts `ageOf`) */
	born: number;
	/** the age it dies of old age at (years), drawn as it came (life.ts) */
	lifespan: number;
	/** world position (m) now and at the previous tick, for interpolation */
	pos: Vec2;
	prev: Vec2;
	/** the way it faces, a unit vector in the ground plane (the view takes its yaw, atan2( x, z )) */
	facing: Vec2;
	/** waypoints still ahead while walking; null while standing */
	path: Vec2[] | null;
	/** 0..100 each (needs.ts) */
	needs: Needs;
	/** what the islander carries (items.ts) */
	bag: Items;
	/** the action under way (actions.ts); null: nothing */
	action: ActionState | null;
	/** how the last action ended, for the next thought; null before the first */
	last: ActionOutcome | null;
	/** the last words said, and the tick they were said at */
	said: { words: string; tick: number } | null;
	/** the last hand-over (people.ts `give`): to whom, what and when; null before the first. Each
	 * one is a new object, which the record watches as it watches `said` */
	gave: { to: EntityId; item: string; count: number; tick: number } | null;
	/** what others did to the islander since its last thought, oldest first, at most NOTICED_KEPT
	 * (people.ts): Sim.think drops what a thought perceived once its answer is acted on */
	noticed: Notice[];
}

/** Something another islander did to one: words it heard, or items handed to it, at a tick. */
export type Notice = { who: EntityId; tick: number; said: string } | { who: EntityId; tick: number; gave: Items };

/** An islander who died: what the record still names them by. */
export interface Departed {
	id: EntityId;
	name: string;
	sex: Sex;
	born: number;
	/** the tick it died at */
	died: number;
}

export interface Needs { satiety: number; hydration: number }

/** item kind to count; a kind is present only while its count is above zero */
export type Items = Record<string, number>;

/** A call of one of the five actions (actions.ts): its name and arguments, plain JSON. */
export interface ActionCall { tool: string; args?: unknown }

/** An action with duration, as the islander's state: walking (`go`, with Villager.path), `wait` and a timed `do`. */
export interface ActionState {
	call: ActionCall;
	/** the tick it ends at; null for `go`, which ends on arrival, and for a `do` that runs until a
	 * new action replaces it (`follow`) */
	until: number | null;
}

/** What an action did: its result, or why it could not. */
export type ActionResult = { ok: true; value?: string } | { ok: false; reason: string };

export interface ActionOutcome { call: ActionCall; result: ActionResult }

/** A building the player placed (buildings.ts): its kind, where it stands, the work done on it, what it holds. */
export interface BuildingState {
	/** its place's id: the kind's name and its count among that kind ever placed (chest1), never reused */
	id: string;
	kind: string;
	x: number;
	z: number;
	/** game seconds of work done on it: built once this reaches its kind's work */
	worked: number;
	/** what it holds (the chest's store; empty for a kind that holds nothing) */
	items: Items;
}

export interface SimState {
	/** the save's version it was written with (../save.ts SAVE_VERSION) */
	version: number;
	seed: number;
	/** game seconds since the game began */
	tick: number;
	/** hour of day at tick 0 */
	startHour: number;
	/** the seeded generator's state */
	rng: number;
	villagers: Villager[];
	/** the islanders who died, in the order they died */
	dead: Departed[];
	/** what the player placed, in the order placed */
	buildings: BuildingState[];
	/** how many of each building kind were ever placed: the count in their ids (buildings.ts) */
	placed: Record<string, number>;
	/** the pieces the island has grown by after the starting island: the land step the game stands
	 * on (world/Growth.ts), so a save loads its world at it */
	pieces: number;
}

/**
 * What the island looks like to the simulation, from the world generator's own exports (never
 * re-sampled here): the grown land, whose outline WorldShapes' footprint gives.
 */
export interface IslandInput {
	land: LandLattice;
	/** the island's top clear of the rim, a byte per ground cell (grid.ts `topFromTiles`: the page
	 * takes it from the world's chunks); without it the grid finds it from the land */
	top?: Uint8Array;
}

export interface GridApi {
	/** cell size (m) */
	readonly size: number;
	readonly cols: number;
	readonly rows: number;
	/** world position of cell ( 0, 0 )'s outer corner */
	readonly x0: number;
	readonly z0: number;
	cellAt( p: Vec2 ): Cell;
	centre( c: Cell ): Vec2;
	/** on the island top, clear of the rim, nothing growing there */
	walkable( c: Cell ): boolean;
	/** ground height (m) at a world position */
	height( x: number, z: number ): number;
}
