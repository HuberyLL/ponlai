import type { Sim } from '../../sim/Sim.ts';
import type { Villager } from '../../sim/types.ts';
import { lookup, t } from '../i18n/i18n.ts';

// What the interface says in words for the simulation's states, places, items and refusals.
//
// What the interface says in words for the simulation's states: what an islander is doing (the name
// tag's second line), the names of places (an islander, as a place, by their name) and items, and
// the reasons a placement is refused. The simulation speaks English to the brain (its tools,
// reasons and ids); the player reads the catalogue's words for them (i18n/zh-CN.json `doing`,
// `place`, `item`, `build.refusal`), and anything without a row there shows as the simulation
// says it.

/** the simulation's refusals of a placement (sim/buildings.ts blueprintRefusal), by the catalogue's key */
const REFUSALS: Readonly<Record<string, string>> = { 'Not enough open ground there': 'noGround', 'Someone stands there': 'occupied' };

export const itemName = ( kind: string ) => lookup( `item.${ kind }`, kind );
export const refusalWords = ( reason: string ) => REFUSALS[ reason ] ? lookup( `build.refusal.${ REFUSALS[ reason ] }`, reason ) : reason;

/** The name of a place by its id: a building by its kind's name (`building`), an islander by
 * their name, else the place's own. */
export function placeName( sim: Sim, id: unknown, building: ( kind: string ) => string ): string {

	if ( typeof id !== 'string' ) return '';
	const b = sim.state.buildings.find( ( x ) => x.id === id );
	return b ? building( b.kind ) : sim.nameOf( id ) ?? lookup( `place.${ id }`, id );

}

/** What an islander is doing, in a few words: the action under way, walking, thinking or resting. */
export function doingWords( sim: Sim, v: Villager, building: ( kind: string ) => string ): string {

	const call = v.action?.call;
	const args = ( typeof call?.args === 'object' && call.args !== null ? call.args : {} ) as Record<string, unknown>;
	if ( call?.tool === 'go' ) {

		// to a person: 去小禾那儿
		const place = placeName( sim, args.place, building );
		return t( sim.nameOf( String( args.place ) ) !== undefined ? 'doing.goTo' : 'doing.go', { place } );

	}
	// the place a `do` runs at is in its call (sim/actions.ts): for `follow`, the one followed
	if ( call?.tool === 'do' ) return lookup( `doing.do.${ String( args.action ) }`, String( args.action ), { place: placeName( sim, args.place, building ) } );
	if ( call?.tool === 'wait' ) return t( 'doing.wait' );
	if ( v.path ) return t( 'doing.walk' );
	if ( sim.thinking( v.id ) ) return t( 'doing.think' );
	return t( 'doing.idle' );

}
