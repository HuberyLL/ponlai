import { CLEAR_RING, cellsWithin, clearAround } from './ground.ts';
import type { Holder } from './items.ts';
import type { Place } from './places.ts';
import { buildingKind, optionsAt } from './registry.ts';
import type { BuildingDef } from './registry.ts';
import type { Sim } from './Sim.ts';
import { planar } from './maths.ts';
import type { BuildingState, SimState, Vec2 } from './types.ts';

// The buildings system: placing, building and storing for every registered kind of building.
//
// The buildings system: what the player places, of the kinds registered (registry.ts BuildingDef:
// a footprint, the work it takes, the room of its store; today's in content/). This module names
// no kind. Placing is generic (`placeBuilding`, refused by `blueprintRefusal`): a building needs
// open main ground with a clear ring round its footprint (CLEAR_RING, so it can never cut the main
// ground in two) and no body standing on it; any number of a kind may stand. Each building's id is
// its kind's name and a count of that kind ever placed (SimState.placed): chest1, chest2. An id is
// never reused, so it stays the same across saves and the agent names the place by it (`go`,
// `do`).
//
// The player plans, the islanders build (docs/design/game-design.md, "Building"). A placed building is a
// blueprint: a construction site, the place with its id, which blocks its footprint from the
// moment it is placed (the islander works beside it, within REACH). Every building, at every
// stage, offers the options registered at `building` (the work on it: content/build.ts); once
// built it offers its kind's own options too, before those, and shows what its kind shows. The
// work is this system's (`work`, a game second of it, BuildingState.worked), and its end is an
// event (events.ts `built`). Its stage is a function of its progress alone (stageOf): planned (no
// work yet), being built, built; perception shows how far along it is in whole percent
// (siteShows), a number like every state that decides outcomes. No materials yet (nothing on the
// island gives wood or stone): building costs time only. Cancelling a site is not designed yet.
//
// A built building with a store (its kind's `capacity`) is a holder of items (`storeOf`, items.ts),
// whose contents show only to someone standing at it; a kind without one shows nothing.

/** standing within this distance (m) of a building's footprint is standing at it */
const REACH = 0.9;

/** a building's stage, from its progress */
export type Stage = 'planned' | 'building' | 'built';

// a placed building's kind: placed only of a kind there is (a save of another version is never
// loaded: ../save.ts)
function kindOf( b: BuildingState ): BuildingDef {

	return buildingKind( b.kind ) as BuildingDef;

}

/** The building with an id, or undefined. */
export function buildingOf( state: SimState, id: string ): BuildingState | undefined {

	return state.buildings.find( ( b ) => b.id === id );

}

/** Why a building of a kind cannot go at a point, or null when it can. */
export function blueprintRefusal( sim: Sim, kind: string, p: Vec2 ): string | null {

	const def = buildingKind( kind );
	if ( ! def ) return `There is no building called ${ kind }`;
	if ( ! clearAround( sim.grid, p, def.radius + CLEAR_RING ) ) return 'Not enough open ground there';
	const covered = cellsWithin( sim.grid, p, def.radius );
	if ( sim.state.villagers.some( ( v ) => covered.includes( sim.grid.indexAt( v.pos.x, v.pos.z ) ) ) ) return 'Someone stands there';
	return null;

}

/** A new building's state at a point, its id the next of its kind (counted in state.placed). */
export function newBuilding( state: SimState, kind: string, x: number, z: number ): BuildingState {

	const n = ( state.placed[ kind ] ?? 0 ) + 1;
	state.placed[ kind ] = n;
	return { id: `${ kind }${ n }`, kind, x, z, worked: 0, items: {} };

}

/** Place a building's blueprint of a kind at a point: it blocks its ground from now on, and the
 * placing is an event (events.ts `placed`). Null when it stands there, else why not. */
export function placeBuilding( sim: Sim, kind: string, p: Vec2 ): string | null {

	const reason = blueprintRefusal( sim, kind, p );
	if ( reason ) return reason;
	const building = newBuilding( sim.state, kind, p.x, p.z );
	sim.state.buildings.push( building );
	sim.grid.obstruct( p.x, p.z, kindOf( building ).radius );
	sim.emit( { kind: 'placed', tick: sim.state.tick, building: building.id, of: kind } );
	return null;

}

/** How far a building has come, 0 (planned) to 1 (built). */
export function progressOf( b: BuildingState ): number {

	return Math.min( 1, b.worked / kindOf( b ).work );

}

/** A building's stage, from its progress. */
export function stageOf( b: BuildingState ): Stage {

	const progress = progressOf( b );
	return progress >= 1 ? 'built' : progress > 0 ? 'building' : 'planned';

}

/** Whether its work is done. */
export function isBuilt( b: BuildingState ): boolean {

	return b.worked >= kindOf( b ).work;

}

/** The game seconds of work still left on it. */
export function workLeft( b: BuildingState ): number {

	return kindOf( b ).work - b.worked;

}

/** A game second of work on an unbuilt building: whether that finished it (its end an event,
 * events.ts `built`). */
export function work( sim: Sim, b: BuildingState ): boolean {

	b.worked ++;
	if ( b.worked < kindOf( b ).work ) return false;
	sim.emit( { kind: 'built', tick: sim.state.tick, building: b.id, of: b.kind } );
	return true;

}

/** A building's store as a holder (items.ts), the room its kind gives (none without a store). */
export function storeOf( b: BuildingState ): Holder {

	return { items: b.items, capacity: kindOf( b ).capacity ?? 0 };

}

/** How an unbuilt site looks to someone who sees it: how far along, in whole percent (0: marked
 * out, not begun). A number, like every other state the islander perceives. */
function siteShows( b: BuildingState ): Record<string, unknown> {

	return { construction: Math.floor( progressOf( b ) * 100 ) };

}

/** How a built building looks: what its store holds, to someone standing at it. */
function builtShows( b: BuildingState, at: boolean ): Record<string, unknown> | null {

	return at && kindOf( b ).capacity ? { items: { ...b.items } } : null;

}

function buildingPlace( sim: Sim, b: BuildingState ): Place {

	const grid = sim.grid, p = { x: b.x, z: b.z };
	const reach = kindOf( b ).radius + REACH, built = stageOf( b ) === 'built';
	return {
		id: b.id,
		kind: b.kind,
		reaches: ( k ) => k >= 0 && planar( grid.centreX( k ) - p.x, grid.centreZ( k ) - p.z ) <= reach,
		near: () => cellsWithin( grid, p, reach ),
		distance: ( q ) => planar( q.x - p.x, q.z - p.z ),
		shows: ( at ) => built ? builtShows( b, at ) : siteShows( b ),
		options: built ? { ...optionsAt( b.kind, b ), ...optionsAt( 'building', b ) } : optionsAt( 'building', b ),
	};

}

/** The buildings as places (places.ts). */
export function buildings( sim: Sim ): Place[] {

	return sim.state.buildings.map( ( b ) => buildingPlace( sim, b ) );

}

/** The building with an id as a place, or null (places.ts `placeById`). */
export function buildingById( sim: Sim, id: string ): Place | null {

	const b = buildingOf( sim.state, id );
	return b ? buildingPlace( sim, b ) : null;

}

/** Block the ground the buildings stand on. */
export function obstructBuildings( sim: Sim ): void {

	for ( const b of sim.state.buildings ) sim.grid.obstruct( b.x, b.z, kindOf( b ).radius );

}
