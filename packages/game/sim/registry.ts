import type { Place, PlaceOption } from './places.ts';
import type { Sim } from './Sim.ts';
import type { ActionResult, Villager } from './types.ts';

// The game's content as registered definitions: needs, items, places, options and buildings.
//
// The game's content as registered definitions (ARCHITECTURE.md, "Content is registered
// definitions"): a need, an item and its uses, a kind of place, an option at a place, a kind of
// building. Each is one definition, registered once (`register`: the game's own in content/), and
// the core reads them here by id or in order, never by name: the needs fall in Sim's tick by their
// definitions, `use` runs an item's use, `do` an option of the place stood at, perception shows a
// building's site and store. Adding a resource is adding definitions, never a change to the core.
//
// Rules: ids are unique within their category, and the order of registration is the order the
// core reads them in (the needs' order in the body and its perception, the options' at a place,
// the place kinds' preference after the core's own: places.ts). Ids are words, never integer-like
// ('7'), which a JavaScript object would order first. A need may not be called `bag` or `doing`,
// which the perceived body holds beside the needs (agent.ts). An option is registered at a kind of
// place: `shore` (a kind registered here), `person` (the people system's: people.ts), a kind of
// building (offered once it is built) or `building` (every building, at every stage:
// buildings.ts). So a kind of building is never named after another kind of place (`shore`,
// `person`, `building`) or so that its buildings' ids meet the islanders' (a kind `v`: v1, v2),
// and its options take ids the options at `building` do not (where both are offered, the work's
// wins).
// Its `make` builds the option for one place of that kind from what the place is (nothing for the
// shore, the islander for a person, the building's state for a building), so its rules close over
// what they act on.
//
// Content is registered before any simulation is made (a body's needs are made at its landing, so
// a need registered later is missing from the bodies already there). Registering takes all of a
// call's definitions or none, and returns its undoing, so a check can add content of its own and
// take it away again (tools/game/verify-game.mjs); the game's content stays for the page's life.

/** A need of the body: 0..NEED_MAX (needs.ts), starting at `start` and falling `perDay` a game
 * day. */
export interface NeedDef {
	id: string;
	start: number;
	perDay: number;
}

/** A use of an item: acts on the body using it; the item is spent when it succeeds. */
export type ItemUse = ( body: Villager ) => ActionResult;

export interface ItemDef {
	id: string;
	/** use name to what it does; `use( item )` runs the first unless one is named */
	uses: Readonly<Record<string, ItemUse>>;
}

/** A kind of place there is on the island (places.ts): every place of it, and the one with an
 * id. */
export interface PlaceKindDef {
	id: string;
	all( sim: Sim ): Place[];
	/** the place of the kind with an id, or null: builds only that one */
	byId( sim: Sim, id: string ): Place | null;
}

/** An option at a kind of place (`at`), made for one place of it from what that place is. */
export interface OptionDef<S = never> {
	id: string;
	at: string;
	make( subject: S ): PlaceOption;
}

/** A kind of building the player can place (buildings.ts). */
export interface BuildingDef {
	id: string;
	/** the disc it blocks (m, radius) */
	radius: number;
	/** the work it takes, game seconds of one islander's building */
	work: number;
	/** items its store holds in all, once built; none without */
	capacity?: number;
}

/** Definitions to register together (a resource's need, item and options, say). */
export interface Content {
	needs?: readonly NeedDef[];
	items?: readonly ItemDef[];
	places?: readonly PlaceKindDef[];
	// (a subject of any kind: each option names its own, `optionsAt` hands it over)
	options?: readonly OptionDef<never>[];
	buildings?: readonly BuildingDef[];
}

// the ids the perceived body holds beside the needs (agent.ts `perceive`)
const BODY_KEYS = [ 'bag', 'doing' ];

const NEEDS: NeedDef[] = [];
const ITEMS: ItemDef[] = [];
const PLACES: PlaceKindDef[] = [];
const OPTIONS: OptionDef<never>[] = [];
const BUILDINGS: BuildingDef[] = [];

// throws when a definition's id is taken, in the list or among the others registered with it
function check<T extends { id: string }>( list: readonly T[], defs: readonly T[] | undefined, what: string, same: ( a: T, b: T ) => boolean = ( a, b ) => a.id === b.id ): void {

	const all = [ ...list ];
	for ( const def of defs ?? [] ) {

		if ( all.some( ( d ) => same( d, def ) ) ) throw new Error( `${ what } ${ def.id } is registered twice` );
		all.push( def );

	}

}

function add<T>( list: T[], defs: readonly T[] | undefined ): void {

	for ( const def of defs ?? [] ) list.push( def );

}

function drop<T>( list: T[], defs: readonly T[] | undefined ): void {

	for ( const def of defs ?? [] ) {

		const i = list.indexOf( def );
		if ( i >= 0 ) list.splice( i, 1 );

	}

}

/** Register definitions, all of them or (when one cannot be) none; returns what takes them away
 * again. */
export function register( content: Content ): () => void {

	for ( const need of content.needs ?? [] ) if ( BODY_KEYS.includes( need.id ) ) throw new Error( `A need cannot be called ${ need.id }` );
	check( NEEDS, content.needs, 'The need' );
	check( ITEMS, content.items, 'The item' );
	check( PLACES, content.places, 'The place kind' );
	check( OPTIONS, content.options, 'The option', ( a, b ) => a.id === b.id && a.at === b.at );
	check( BUILDINGS, content.buildings, 'The building' );
	add( NEEDS, content.needs );
	add( ITEMS, content.items );
	add( PLACES, content.places );
	add( OPTIONS, content.options );
	add( BUILDINGS, content.buildings );
	return () => {

		drop( NEEDS, content.needs );
		drop( ITEMS, content.items );
		drop( PLACES, content.places );
		drop( OPTIONS, content.options );
		drop( BUILDINGS, content.buildings );

	};

}

/** The needs, in the order registered. */
export function needs(): readonly NeedDef[] {

	return NEEDS;

}

export function isNeed( id: unknown ): id is string {

	return NEEDS.some( ( n ) => n.id === id );

}

/** The item with an id, or undefined. */
export function itemKind( id: unknown ): ItemDef | undefined {

	return ITEMS.find( ( i ) => i.id === id );

}

/** The items, in the order registered. */
export function itemKinds(): readonly ItemDef[] {

	return ITEMS;

}

/** The kinds of place registered, in the order registered. */
export function placeKinds(): readonly PlaceKindDef[] {

	return PLACES;

}

/** The options at a kind of place, made for one place of it, by id in the order registered. */
export function optionsAt( at: string, subject: unknown ): Record<string, PlaceOption> {

	const options: Record<string, PlaceOption> = {};
	for ( const o of OPTIONS ) if ( o.at === at ) options[ o.id ] = ( o.make as ( subject: unknown ) => PlaceOption )( subject );
	return options;

}

/** The kind of building with an id, or undefined. */
export function buildingKind( id: unknown ): BuildingDef | undefined {

	return BUILDINGS.find( ( b ) => b.id === id );

}

/** The kinds of building, in the order registered. */
export function buildingKinds(): readonly BuildingDef[] {

	return BUILDINGS;

}
