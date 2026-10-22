import { placesAt } from '../../sim/places.ts';
import type { Sim } from '../../sim/Sim.ts';
import type { Villager } from '../../sim/types.ts';

// What the interface says in words for the simulation's states: what an islander is doing (the name
// tag's second line), the names of places and items, and the reasons a placement is refused. The
// simulation speaks English to the brain (its tools, reasons and ids); the player reads Chinese
// only (docs/ui.md), so the words for each are rows here, and anything without a row shows as the
// simulation says it.

/** names of places that are not buildings (sim/places.ts) */
const PLACES: Readonly<Record<string, string>> = { shore: '海边' };
/** names of items (sim/items.ts) */
const ITEMS: Readonly<Record<string, string>> = { fish: '鱼' };
/** a `do` option, by its action (places.ts, buildings.ts); `{place}` is the place's name */
const DOING: Readonly<Record<string, string>> = { fish: '钓鱼', build: '盖{place}', put: '往{place}里放东西', take: '从{place}里拿东西' };
/** the simulation's refusals of a placement (sim/buildings.ts blueprintRefusal) */
const REFUSALS: Readonly<Record<string, string>> = { 'Not enough open ground there': '这里空地不够', 'Someone stands there': '有人站在这里' };

export const itemName = ( kind: string ) => ITEMS[ kind ] ?? kind;
export const refusalWords = ( reason: string ) => REFUSALS[ reason ] ?? reason;

/** The name of a place by its id: a building by its kind's name (`building`), else the place's own. */
export function placeName( sim: Sim, id: unknown, building: ( kind: string ) => string ): string {

	if ( typeof id !== 'string' ) return '';
	const b = sim.state.buildings.find( ( x ) => x.id === id );
	return b ? building( b.kind ) : PLACES[ id ] ?? id;

}

/** What an islander is doing, in a few words: the action under way, walking, thinking or resting. */
export function doingWords( sim: Sim, v: Villager, building: ( kind: string ) => string ): string {

	const call = v.action?.call;
	const args = ( typeof call?.args === 'object' && call.args !== null ? call.args : {} ) as Record<string, unknown>;
	if ( call?.tool === 'go' ) return `去${ placeName( sim, args.place, building ) }`;
	if ( call?.tool === 'do' ) {

		const action = String( args.action ), words = DOING[ action ];
		// the place a `do` runs at: the first the body stands at that offers it (sim/places.ts)
		const at = placesAt( sim, v ).find( ( p ) => Object.hasOwn( p.options, action ) );
		return words ? words.replace( '{place}', at ? placeName( sim, at.id, building ) : '' ) : action;

	}
	if ( call?.tool === 'wait' ) return '歇着';
	if ( v.path ) return '走动';
	if ( sim.thinking( v.id ) ) return '在想';
	return '歇着';

}
