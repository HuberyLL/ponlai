import type { Brain, Perception, ToolCall } from './agent.ts';
import { BAG_CAPACITY } from './items.ts';

// A stand-in brain of plain rules, thinking for the islander until the language model is
// connected (docs/game-design.md, "Next"). It reads only the Perception and answers with the five
// actions, one call a thought, as a person would act on what they see and carry:
//
// - thirsty (hydration below THIRSTY): drink a carried coconut; else take one at the chest;
//   else pick one at the palm (going there); else look in the chest; else wait for regrowth.
// - hungry (satiety below HUNGRY): eat a carried fish; else take one at the chest; else fish
//   at the shore (going there). The lower need comes first.
// - then a construction site in sight (a place that shows its construction, buildings.ts): build
//   the first one listed (the first placed), going there first. Building runs until the site is
//   done, an hour for a chest, which the needs' thresholds leave room for.
// - otherwise keep one coconut and one fish in the bag; with a chest built (the first built one in
//   sight, by kind), gather a second of each and carry it there until it holds STOCK of each (it
//   sees what it holds only while standing at it, and remembers nothing); else wait a while.
//
// A full bag with nothing to drink or eat in it makes room by using what it holds most of.

const THIRSTY = 60;
const HUNGRY = 60;
/** what the islander stocks the chest up to, of each kind */
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
		const sees = ( id: string ) => p.seen.find( ( s ) => s.place === id );
		const coconutsOnPalm = number( sees( 'palm' )?.shows?.coconuts );
		// a place under construction shows how far along it is; the chest counts once built
		const site = p.seen.find( ( s ) => s.shows?.construction !== undefined );
		const chest = p.seen.find( ( s ) => s.kind === 'chest' && s.shows?.construction === undefined );
		const stored = ( item: string ) => number( ( chest?.shows?.items as Record<string, unknown> | undefined )?.[ item ] );

		// a full bag with nothing for the need: make room with what it holds most of
		const makeRoom = (): ToolCall => {

			const most = Object.keys( bag ).sort( ( a, b ) => carried( b ) - carried( a ) )[ 0 ];
			return chest && at( chest.place ) ? doAt( 'put', most, 1 ) : use( most );

		};

		const drink = (): ToolCall | null => {

			if ( carried( 'coconut' ) > 0 ) return use( 'coconut' );
			if ( chest && at( chest.place ) && stored( 'coconut' ) > 0 ) return full ? makeRoom() : doAt( 'take', 'coconut', 1 );
			if ( full ) return makeRoom();
			if ( coconutsOnPalm > 0 ) return at( 'palm' ) ? doAt( 'pick' ) : go( 'palm' );
			if ( chest && ! at( chest.place ) ) return go( chest.place );
			if ( ! sees( 'palm' ) ) return go( 'palm' );
			return null;

		};

		const eat = (): ToolCall | null => {

			if ( carried( 'fish' ) > 0 ) return use( 'fish' );
			if ( chest && at( chest.place ) && stored( 'fish' ) > 0 ) return full ? makeRoom() : doAt( 'take', 'fish', 1 );
			if ( full ) return makeRoom();
			return at( 'shore' ) ? doAt( 'fish' ) : go( 'shore' );

		};

		const needs = [
			{ level: p.body.hydration, below: THIRSTY, act: drink },
			{ level: p.body.satiety, below: HUNGRY, act: eat },
		].filter( ( n ) => n.level < n.below ).sort( ( a, b ) => a.level - b.level );
		for ( const need of needs ) {

			const call = need.act();
			if ( call ) return call;

		}

		if ( site ) return at( site.place ) ? doAt( 'build' ) : go( site.place );

		// gather one of a kind: a coconut from the palm, a fish at the shore
		const gather = ( item: string ): ToolCall | null => {

			if ( full ) return null;
			if ( item === 'coconut' ) return coconutsOnPalm > 0 ? ( at( 'palm' ) ? doAt( 'pick' ) : go( 'palm' ) ) : null;
			return at( 'shore' ) ? doAt( 'fish' ) : go( 'shore' );

		};

		// keep one of each in the bag
		for ( const item of [ 'coconut', 'fish' ] ) {

			const call = carried( item ) === 0 ? gather( item ) : null;
			if ( call ) return call;

		}

		if ( chest ) {

			if ( at( chest.place ) ) {

				for ( const item of [ 'coconut', 'fish' ] ) if ( carried( item ) > 1 && stored( item ) < STOCK ) return doAt( 'put', item, carried( item ) - 1 );
				for ( const item of [ 'coconut', 'fish' ] ) if ( stored( item ) < STOCK && carried( item ) < 2 ) {

					const call = gather( item );
					if ( call ) return call;

				}
				return wait( IDLE_SECONDS );

			}
			for ( const item of [ 'coconut', 'fish' ] ) {

				const call = carried( item ) < 2 ? gather( item ) : null;
				if ( call ) return call;

			}
			if ( carried( 'coconut' ) > 1 || carried( 'fish' ) > 1 ) return go( chest.place );

		}
		return wait( IDLE_SECONDS );

	}

}
