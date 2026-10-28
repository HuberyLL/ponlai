import { CLEAR_RING, cellsWithin, clearAround } from './ground.ts';
import { BAG_CAPACITY, addItems, count, itemCount, removeItems, total } from './items.ts';
import type { Place, PlaceOption } from './places.ts';
import type { Sim } from './Sim.ts';
import type { BuildingState, SimState, Vec2, Vec3 } from './types.ts';

// The buildings the player places: registered kinds, each a footprint, the work it takes and the
// options the finished place offers. Placing is generic (Sim.placeBlueprint, refused by
// blueprintRefusal): a building needs open main ground with a clear ring round its footprint
// (CLEAR_RING, so it can never cut the main ground in two) and no body standing on
// it; any number of a kind may stand. Each building's id is its kind's name and a count of that
// kind ever placed (SimState.placed): chest1, chest2. An id is never reused, so it stays the same
// across saves and the brain names the place by it (`go`, `do`). A new kind is one more entry in
// BUILDING_KINDS.
//
// The player plans, the islanders build (docs/game-design.md, "Building"). A placed building is a
// blueprint: a construction site, the place with its id, which blocks its footprint from the
// moment it is placed (the islander works beside it, within REACH) and whose only option is
// `build`. `do( 'build' )` works on it for the work still left, a game second of work a tick
// (BuildingState.worked); a new action interrupts it and the work done stays. Several islanders
// may build one site, each adding their work. When the work is done the site is the finished
// building: its own options and what shows on it. `build` stays on it closed (not offered, refused
// when called), so whoever else was building it ends at once on their next tick, with the
// building done as their outcome, instead of standing out the time they had planned. Its stage is a function of its progress alone (stageOf): planned (no work yet), being
// built, built; perception shows how far along it is in whole percent (siteShows), a number like
// every state that decides outcomes. No materials yet (nothing on the island gives wood or stone): building costs time
// only. Cancelling a site is not designed yet.
//
// Each building is a fixed box in the physics world (physics.ts), the box of what its view draws at
// its stage (`bodyBox`): none while it is only marked out, the frame's (`siteFrame`, the same
// sizes SiteView builds it from) as it rises by tiers, the finished model's (BuildingKind.size)
// once built, turned as it is drawn (its front to the island's middle).
//
// - chest: a wooden chest that holds CHEST_CAPACITY items. `put` and `take` ( { item, count } )
//   are instant; what is inside shows only to someone standing at it. CHEST_WORK is about a game
//   hour: a few planks and a lid knocked together by one person, which at the game's day (24 real
//   minutes at 1x) is a minute to watch the site rise, and costs the islander about 4 of
//   hydration and 3 of satiety (needs.ts), so building it never crowds out drinking and eating.

/** standing within this distance (m) of a building's footprint is standing at it */
const REACH = 0.9;

/** a building's stage, from its progress */
export type Stage = 'planned' | 'building' | 'built';

export interface BuildingKind {
	/** the disc it blocks (m, radius) */
	radius: number;
	/** the work it takes, game seconds of one islander's building */
	work: number;
	/** the finished model's box (m: width along its x, height, depth along its z) */
	size: Vec3;
	/** what shows on the finished building, to someone who sees it or stands at it */
	shows( building: BuildingState, at: boolean ): Record<string, unknown> | null;
	/** the options the finished building offers */
	options( building: BuildingState ): Record<string, PlaceOption>;
}

// ------------------------------------------------------------------ chest

/** the chest blocks a disc this wide (m, radius): its 0.9 x 0.55 m lid's half diagonal */
export const CHEST_RADIUS = 0.55;
/** A chest holds five bags' worth: ten days of one islander's fish (two a day, needs.ts), a
 * store against a poor day's fishing, not a granary. */
export const CHEST_CAPACITY = 20;
/** the chest's work (game seconds): see the header */
export const CHEST_WORK = 3600;
/** the chest's box (m): its lid 0.9 x 0.55 m, 0.6 m tall on its skids (ChestView.ts draws it) */
export const CHEST_SIZE: Vec3 = { x: 0.9, y: 0.6, z: 0.55 };

const chest: BuildingKind = {
	radius: CHEST_RADIUS,
	work: CHEST_WORK,
	size: CHEST_SIZE,
	shows: ( box, at ) => at ? { items: { ...box.items } } : null,
	options: ( box ) => ( {
		put: {
			open: () => true,
			start: ( _sim, body, args ) => {

				const what = itemCount( args );
				if ( typeof what === 'string' ) return { ok: false, reason: what };
				const carried = count( body.bag, what.item );
				if ( carried < what.n ) return { ok: false, reason: `the bag holds ${ carried } ${ what.item }` };
				if ( total( box.items ) + what.n > CHEST_CAPACITY ) return { ok: false, reason: 'the chest is full' };
				removeItems( body.bag, what.item, what.n );
				addItems( box.items, what.item, what.n );
				return { ok: true, value: `put ${ what.n } ${ what.item } in the chest` };

			},
		},
		take: {
			open: () => total( box.items ) > 0,
			start: ( _sim, body, args ) => {

				const what = itemCount( args );
				if ( typeof what === 'string' ) return { ok: false, reason: what };
				const stored = count( box.items, what.item );
				if ( stored < what.n ) return { ok: false, reason: `the chest holds ${ stored } ${ what.item }` };
				if ( total( body.bag ) + what.n > BAG_CAPACITY ) return { ok: false, reason: 'the bag has no room for that' };
				removeItems( box.items, what.item, what.n );
				addItems( body.bag, what.item, what.n );
				return { ok: true, value: `took ${ what.n } ${ what.item } from the chest` };

			},
		},
	} ),
};

// ------------------------------------------------------------------ the registry

/** every kind of building, by name */
export const BUILDING_KINDS: Readonly<Record<string, BuildingKind>> = { chest };

/** The building with an id, or undefined. */
export function buildingOf( state: SimState, id: string ): BuildingState | undefined {

	return state.buildings.find( ( b ) => b.id === id );

}

/** Why a building of a kind cannot go at a point, or null when it can. */
export function blueprintRefusal( sim: Sim, kind: string, p: Vec2 ): string | null {

	if ( ! Object.hasOwn( BUILDING_KINDS, kind ) ) return `There is no building called ${ kind }`;
	const r = BUILDING_KINDS[ kind ].radius;
	if ( ! clearAround( sim.grid, p, r + CLEAR_RING ) ) return 'Not enough open ground there';
	const covered = cellsWithin( sim.grid, p, r );
	if ( sim.state.villagers.some( ( v ) => covered.includes( sim.grid.indexAt( v.pos.x, v.pos.z ) ) ) ) return 'Someone stands there';
	return null;

}

/** A new building's state at a point, its id the next of its kind (counted in state.placed). */
export function newBuilding( state: SimState, kind: string, x: number, z: number ): BuildingState {

	const n = ( state.placed[ kind ] ?? 0 ) + 1;
	state.placed[ kind ] = n;
	return { id: `${ kind }${ n }`, kind, x, z, worked: 0, items: {}, collider: null };

}

/** How far a building has come, 0 (planned) to 1 (built). */
export function progressOf( b: BuildingState ): number {

	return Math.min( 1, b.worked / BUILDING_KINDS[ b.kind ].work );

}

/** A building's stage, from its progress. */
export function stageOf( b: BuildingState ): Stage {

	const progress = progressOf( b );
	return progress >= 1 ? 'built' : progress > 0 ? 'building' : 'planned';

}

/** A construction site's frame for a footprint's radius (SiteView.ts builds it from these): the
 * square inscribed in the disc (its half side, m), the frame's height, its timbers' section and
 * the tiers it rises in. */
export function siteFrame( radius: number ): { half: number; height: number; section: number; tiers: number } {

	const height = 1.1 * radius;
	return { half: radius / Math.SQRT2, height, section: 0.03 + 0.04 * radius, tiers: Math.min( 6, Math.max( 2, Math.round( height / 0.2 ) ) ) };

}

/** The box a building is in the physics world at its stage (half extents, m, and its turn about
 * the vertical: its front, +z, to the island's middle); null while it is only marked out. */
export function bodyBox( b: BuildingState ): { half: Vec3; yaw: number } | null {

	const stage = stageOf( b ), yaw = Math.atan2( - b.x, - b.z );
	if ( stage === 'planned' ) return null;
	if ( stage === 'built' ) {

		const s = BUILDING_KINDS[ b.kind ].size;
		return { half: { x: s.x / 2, y: s.y / 2, z: s.z / 2 }, yaw };

	}
	// the frame up to the tier its progress has reached
	const f = siteFrame( BUILDING_KINDS[ b.kind ].radius );
	const top = f.section + Math.ceil( progressOf( b ) * f.tiers ) * ( f.height - f.section ) / f.tiers;
	return { half: { x: f.half, y: top / 2, z: f.half }, yaw };

}

/** How an unbuilt site looks to someone who sees it: how far along, in whole percent (0: marked
 * out, not begun). A number, like every other state the islander perceives. */
function siteShows( b: BuildingState ): Record<string, unknown> {

	return { construction: Math.floor( progressOf( b ) * 100 ) };

}

/** The site's one option: work on it until it is built. Closed once built: a builder still on
 * it (someone else finished it) ends at its next tick. */
function buildOption( b: BuildingState, kind: BuildingKind ): PlaceOption {

	return {
		open: () => b.worked < kind.work,
		start: () => b.worked < kind.work ? { ok: true, seconds: kind.work - b.worked } : { ok: false, reason: `${ b.id } is built` },
		during: () => {

			if ( b.worked >= kind.work ) return { ok: true, value: `${ b.id } is built` };
			b.worked ++;
			return b.worked >= kind.work ? { ok: true, value: `built ${ b.id }` } : null;

		},
	};

}

function buildingPlace( sim: Sim, b: BuildingState ): Place {

	const grid = sim.grid, kind = BUILDING_KINDS[ b.kind ], p = { x: b.x, z: b.z };
	const reach = kind.radius + REACH, built = stageOf( b ) === 'built';
	return {
		id: b.id,
		kind: b.kind,
		reaches: ( k ) => k >= 0 && Math.hypot( grid.centreX( k ) - p.x, grid.centreZ( k ) - p.z ) <= reach,
		near: () => cellsWithin( grid, p, reach ),
		distance: ( q ) => Math.hypot( q.x - p.x, q.z - p.z ),
		shows: ( at ) => built ? kind.shows( b, at ) : siteShows( b ),
		options: built ? { ...kind.options( b ), build: buildOption( b, kind ) } : { build: buildOption( b, kind ) },
	};

}

/** The buildings as places (places.ts PLACE_KINDS). */
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

	for ( const b of sim.state.buildings ) sim.grid.obstruct( b.x, b.z, BUILDING_KINDS[ b.kind ].radius );

}
