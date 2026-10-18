import type { Brain, Perception, ToolCall } from './agent.ts';
import { BAG_CAPACITY } from './items.ts';

// A stand-in brain of plain rules, thinking for the islander until the language model is
// connected (docs/game-design.md, "Next"). It reads only the Perception and answers with the five
// actions, one call a thought, as a person would act on what they see and carry:
//
// - hungry (satiety below HUNGRY): eat a carried fish; else take one at the chest; else fish
//   at the shore (going there). Thirst is off (needs.ts): nothing on the island gives water yet.
// - then a construction site in sight (a place that shows its construction, buildings.ts): build
//   the first one listed (the first placed), going there first. Building runs until the site is
//   done, an hour for a chest, which the needs' thresholds leave room for.
// - otherwise keep one fish in the bag; with a chest built (the first built one in sight, by
//   kind), catch a second and carry it there until it holds STOCK (it sees what it holds only
//   while standing at it, and remembers nothing); else wait a while.
//
// The fish is the only item there is, so a bag with no fish in it is never full.

const HUNGRY = 60;
/** what the islander stocks the chest up to */
const STOCK = 4;
/** the wait when there is nothing to do (game seconds) */
const IDLE_SECONDS = 30 * 60;

const go = ( place: string ): ToolCall => ( { tool: 'go', args: { place } } );
const use = ( item: string ): ToolCall => ( { tool: 'use', args: { item } } );
const doAt = ( action: string, item?: string, count?: number ): ToolCall => ( { tool: 'do', args: item ? { action, item, count } : { action } } );
const wait = ( seconds: number ): ToolCall => ( { tool: 'wait', args: { seconds } } );

function number( value: unknown ): number {

	return typeof value === 'number' ? value : 0;

}

export class StandInBrain implements Brain {

	think( p: Perception ): ToolCall[] {

		return [ this.decide( p ) ];

	}

	private decide( p: Perception ): ToolCall {

		const bag = p.body.bag;
		const carried = ( item: string ) => bag[ item ] ?? 0;
		let inBag = 0;
		for ( const item in bag ) inBag += bag[ item ];
		const full = inBag >= BAG_CAPACITY;
		const at = ( id: string ) => p.atHand.some( ( h ) => h.place === id );
		// a place under construction shows how far along it is; the chest counts once built
		const site = p.seen.find( ( s ) => s.shows?.construction !== undefined );
		const chest = p.seen.find( ( s ) => s.kind === 'chest' && s.shows?.construction === undefined );
		const stored = ( item: string ) => number( ( chest?.shows?.items as Record<string, unknown> | undefined )?.[ item ] );

		if ( p.body.satiety < HUNGRY ) {

			if ( carried( 'fish' ) > 0 ) return use( 'fish' );
			if ( chest && at( chest.place ) && stored( 'fish' ) > 0 ) return doAt( 'take', 'fish', 1 );
			return at( 'shore' ) ? doAt( 'fish' ) : go( 'shore' );

		}

		if ( site ) return at( site.place ) ? doAt( 'build' ) : go( site.place );

		// catch a fish at the shore
		const gather = (): ToolCall | null => full ? null : at( 'shore' ) ? doAt( 'fish' ) : go( 'shore' );

		// keep one in the bag
		if ( carried( 'fish' ) === 0 ) {

			const call = gather();
			if ( call ) return call;

		}

		if ( chest ) {

			if ( at( chest.place ) ) {

				if ( carried( 'fish' ) > 1 && stored( 'fish' ) < STOCK ) return doAt( 'put', 'fish', carried( 'fish' ) - 1 );
				if ( stored( 'fish' ) < STOCK && carried( 'fish' ) < 2 ) {

					const call = gather();
					if ( call ) return call;

				}
				return wait( IDLE_SECONDS );

			}
			if ( carried( 'fish' ) < 2 ) {

				const call = gather();
				if ( call ) return call;

			}
			if ( carried( 'fish' ) > 1 ) return go( chest.place );

		}
		return wait( IDLE_SECONDS );

	}

}
