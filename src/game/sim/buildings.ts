import { CLEAR_RING, cellsWithin, clearAround } from './ground.ts';
import { BAG_CAPACITY, addItems, count, isItem, removeItems, total } from './items.ts';
import type { DoArgs, Place, PlaceOption } from './places.ts';
import type { Sim } from './Sim.ts';
import type { BuildingState, SimState, Vec2 } from './types.ts';

// The buildings the player places: registered kinds, each a footprint and the options the
// finished place offers. Placing is generic (Sim.placeBlueprint, refused by blueprintRefusal):
// a building needs open main ground with a clear ring round its footprint (CLEAR_RING, as the
// palm's, so it can never cut the main ground in two), no body standing on it, and none of its kind
// placed yet (one of each kind for now, so its id is the kind's name). It blocks its footprint from
// the moment it is placed. A new kind is one more entry in BUILDING_KINDS.
//
// - chest: a wooden chest that holds CHEST_CAPACITY items. `put` and `take` ( { item, count } )
//   are instant; what is inside shows only to someone standing at it.

/** standing within this distance (m) of a building's footprint is standing at it */
const REACH = 0.9;

export interface BuildingKind {
	/** the disc it blocks (m, radius) */
	radius: number;
	/** what shows on the finished building, to someone who sees it or stands at it */
	shows( building: BuildingState, at: boolean ): Record<string, unknown> | null;
	/** the options the finished building offers */
	options( building: BuildingState ): Record<string, PlaceOption>;
}

// ------------------------------------------------------------------ chest

/** the chest blocks a disc this wide (m, radius): its 0.9 x 0.55 m lid's half diagonal */
export const CHEST_RADIUS = 0.55;
/** A chest holds five bags' worth: about four days of one islander's food and water (three
 * coconuts and two fish a day, needs.ts), a store against a poor day's fishing, not a granary. */
export const CHEST_CAPACITY = 20;

/** The item and count a put or take names, or why they are not one. */
function itemCount( args: DoArgs ): { item: string; n: number } | string {

	if ( ! isItem( args.item ) ) return `there is no item called ${ String( args.item ) }`;
	const n = args.count ?? 1;
	if ( typeof n !== 'number' || ! Number.isInteger( n ) || n < 1 ) return 'the count must be a whole number from 1';
	return { item: args.item, n };

}

const chest: BuildingKind = {
	radius: CHEST_RADIUS,
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
	if ( buildingOf( sim.state, kind ) ) return `The ${ kind } is already placed`;
	const r = BUILDING_KINDS[ kind ].radius;
	if ( ! clearAround( sim.grid, p, r + CLEAR_RING ) ) return 'Not enough open ground there';
	const covered = cellsWithin( sim.grid, p, r );
	if ( sim.state.villagers.some( ( v ) => covered.includes( sim.grid.indexAt( v.pos.x, v.pos.z ) ) ) ) return 'Someone stands there';
	return null;

}

/** A new building's state at a point (its kind's name as its id). */
export function newBuilding( kind: string, x: number, z: number ): BuildingState {

	return { id: kind, kind, x, z, items: {} };

}

function buildingPlace( sim: Sim, b: BuildingState ): Place {

	const grid = sim.grid, kind = BUILDING_KINDS[ b.kind ], p = { x: b.x, z: b.z };
	const reach = kind.radius + REACH;
	return {
		id: b.id,
		reaches: ( k ) => k >= 0 && Math.hypot( grid.centreX( k ) - p.x, grid.centreZ( k ) - p.z ) <= reach,
		near: () => cellsWithin( grid, p, reach ),
		distance: ( q ) => Math.hypot( q.x - p.x, q.z - p.z ),
		shows: ( at ) => kind.shows( b, at ),
		options: kind.options( b ),
	};

}

/** The buildings as places (places.ts PLACE_KINDS). */
export function buildings( sim: Sim ): Place[] {

	return sim.state.buildings.map( ( b ) => buildingPlace( sim, b ) );

}

/** Block the ground the buildings stand on. */
export function obstructBuildings( sim: Sim ): void {

	for ( const b of sim.state.buildings ) sim.grid.obstruct( b.x, b.z, BUILDING_KINDS[ b.kind ].radius );

}
