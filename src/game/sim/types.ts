// Plain data shared by the island simulation, its view, the debug panel and the tests. Nothing here
// imports three.js or touches the DOM: the simulation runs headless in node as well as in the
// page. Everything in SimState is JSON, so a save is the state itself.
//
// Node runs the simulation's TypeScript by stripping the types, so files under src/game/sim
// import types with `import type` and use only erasable syntax (no enums, namespaces or
// constructor parameter properties).

export interface Vec2 { x: number; z: number }

/** A cell of the simulation's ground grid: column i along +x, row j along +z. */
export interface Cell { i: number; j: number }

export type EntityId = string;
/** paused, then the three play speeds */
export type Speed = 0 | 1 | 2 | 3;
/** game time runs this many times faster than the day clock's own rate at each speed */
export const SPEED_FACTORS: Readonly<Record<Speed, number>> = { 0: 0, 1: 1, 2: 3, 3: 6 };
/** one tick is one game second */
export const SECONDS_PER_GAME_DAY = 86400;
/** walking speed, metres per game second: 1.8 m/s on screen at the game's 24-minute day at 1x */
export const WALK_SPEED = 0.9 * 2880 / 86400;

/** An islander's body. */
export interface Villager {
	id: EntityId;
	name: string;
	/** palette index for the view (src/characters/looks.ts) */
	look: number;
	/** world position (m) now and at the previous tick, for interpolation */
	pos: Vec2;
	prev: Vec2;
	/** facing in radians, atan2( dx, dz ): the scene's yaw convention */
	heading: number;
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
}

export interface Needs { satiety: number; hydration: number }

/** item kind to count; a kind is present only while its count is above zero */
export type Items = Record<string, number>;

/** A call of one of the five actions (actions.ts): its name and arguments, plain JSON. */
export interface ActionCall { tool: string; args?: unknown }

/** An action with duration, as the islander's state: walking (`go`, with Villager.path), `wait` and a timed `do`. */
export interface ActionState {
	call: ActionCall;
	/** the tick it ends at; null for `go`, which ends on arrival */
	until: number | null;
}

/** What an action did: its result, or why it could not. */
export type ActionResult = { ok: true; value?: string } | { ok: false; reason: string };

export interface ActionOutcome { call: ActionCall; result: ActionResult }

/** A coconut palm (places.ts): where it stands, its coconuts and the regrowth of the next one. */
export interface PalmState {
	id: string;
	x: number;
	z: number;
	coconuts: number;
	/** game seconds grown toward the next coconut */
	growth: number;
}

/** A building the player placed (buildings.ts): its kind, where it stands, what it holds. */
export interface BuildingState {
	/** its place's id: the kind's name (one of each kind for now) */
	id: string;
	kind: string;
	x: number;
	z: number;
	/** what it holds (the chest's store; empty for a kind that holds nothing) */
	items: Items;
}

export interface SimState {
	/** see Sim.ts SAVE_VERSION */
	version: number;
	seed: number;
	/** game seconds since the game began */
	tick: number;
	/** hour of day at tick 0 */
	startHour: number;
	/** the seeded generator's state */
	rng: number;
	villagers: Villager[];
	palms: PalmState[];
	/** what the player placed, in the order placed */
	buildings: BuildingState[];
}

/**
 * What the island looks like to the simulation, from the world generator's own exports (never
 * re-sampled here): the bushes FoliageSites' drawnFoliageSites returns and the shrubs and small
 * trees PlantSites' pickPlantSites placed, each an obstacle. The island's outline comes from
 * WorldShapes directly.
 */
export interface IslandInput {
	bushes: readonly { x: number; z: number; r: number }[];
	/** r is the ground the plant covers */
	plants: readonly { x: number; z: number; r: number }[];
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
