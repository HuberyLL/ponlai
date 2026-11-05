import type { Brain, Perception, ToolCall } from './agent.ts';
import { BAG_CAPACITY } from './items.ts';

// A stand-in brain of plain rules, thinking for the islander until the language model is
// connected (docs/game-design.md, "Next"). It reads only the Perception and remembers nothing, and
// answers with the five actions, as a person would act on what they see, hear and carry: one
// action a thought, with words said before it where it has something to say:
//
// - given something (a gift among what it noticed): it says THANKS_WORDS, once a thought, beside
//   whatever it does.
// - hungry (satiety below HUNGRY): eat a carried fish; else take one at the chest; else fish
//   at the shore. Setting off for the shore from elsewhere with nothing to eat, it says
//   HUNGRY_WORDS (only then, so a hungry spell is one line, not one per thought). Thirst is off
//   (needs.ts): nothing on the island gives water yet.
// - having walked over to someone (its last action a `go` to a person in sight, arrived) with a
//   fish in the bag: give them one.
// - having heard HUNGRY_WORDS from someone in sight, fed and carrying a fish: give them one at
//   once if they are beside it, else go to them.
// - then a construction site in sight (a place that shows its construction, buildings.ts): build
//   the first one listed (the first placed), going there first. Building runs until the site is
//   done, an hour for a chest, which the needs' thresholds leave room for.
// - otherwise keep one fish in the bag; with a chest built (the first built one in sight, by
//   kind), catch a second and carry it there until it holds STOCK (it sees what it holds only
//   while standing at it, and remembers nothing); else wait a while.
//
// The fish is the only item there is, so a bag with no fish in it is never full. It never follows
// anyone (the language model will).

const HUNGRY = 60;
// what it says: content, like the islanders' names (Sim.ts NAMES), in the language the islanders
// speak, not the interface's words
export const HUNGRY_WORDS = '我饿了';
export const THANKS_WORDS = '谢谢';
/** what the islander stocks the chest up to */
const STOCK = 4;
/** the wait when there is nothing to do (game seconds) */
const IDLE_SECONDS = 30 * 60;

const go = ( place: string ): ToolCall => ( { tool: 'go', args: { place } } );
const use = ( item: string ): ToolCall => ( { tool: 'use', args: { item } } );
const doAt = ( action: string, item?: string, count?: number ): ToolCall => ( { tool: 'do', args: item ? { action, item, count } : { action } } );
const say = ( words: string ): ToolCall => ( { tool: 'say', args: { words } } );
const giveFish = ( place: string ): ToolCall => ( { tool: 'do', args: { action: 'give', place, item: 'fish', count: 1 } } );
const wait = ( seconds: number ): ToolCall => ( { tool: 'wait', args: { seconds } } );

function number( value: unknown ): number {

	return typeof value === 'number' ? value : 0;

}

/** whether a place is at hand */
const at = ( p: Perception, id: string ) => p.atHand.some( ( h ) => h.place === id );

export class StandInBrain implements Brain {

	think( p: Perception ): ToolCall[] {

		const calls = this.decide( p );
		return p.noticed.some( ( n ) => 'gave' in n ) ? [ say( THANKS_WORDS ), ...calls ] : calls;

	}

	private decide( p: Perception ): ToolCall[] {

		const call = this.respond( p );
		if ( call ) return [ call ];
		// hungry, with nothing to eat at hand: off to fish, saying so
		if ( number( p.body.satiety ) < HUNGRY ) return at( p, 'shore' ) ? [ doAt( 'fish' ) ] : [ say( HUNGRY_WORDS ), go( 'shore' ) ];
		return [ this.work( p ) ];

	}

	/** Eating what is at hand, and giving to those who need it; null: nothing of the kind to do. */
	private respond( p: Perception ): ToolCall | null {

		const fish = p.body.bag.fish ?? 0;
		if ( number( p.body.satiety ) < HUNGRY ) {

			if ( fish > 0 ) return use( 'fish' );
			const chest = p.seen.find( ( s ) => s.kind === 'chest' && at( p, s.place ) && number( ( s.shows?.items as Record<string, unknown> | undefined )?.fish ) > 0 );
			return chest ? { tool: 'do', args: { action: 'take', place: chest.place, item: 'fish', count: 1 } } : null;

		}
		if ( fish === 0 ) return null;
		const person = ( id: unknown ) => p.seen.some( ( s ) => s.kind === 'person' && s.place === id );
		// walked over to someone: hand them the fish
		const last = p.last;
		const to = ( last?.call.args as Record<string, unknown> | undefined )?.place;
		if ( last?.call.tool === 'go' && last.result.ok && person( to ) && at( p, String( to ) ) ) return giveFish( String( to ) );
		// someone in sight said they are hungry
		const asker = p.noticed.find( ( n ) => 'said' in n && n.said === HUNGRY_WORDS && person( n.who ) );
		if ( asker ) return at( p, asker.who ) ? giveFish( asker.who ) : go( asker.who );
		return null;

	}

	/** Build, keep a fish, stock the chest, else rest. */
	private work( p: Perception ): ToolCall {

		const bag = p.body.bag;
		const carried = ( item: string ) => bag[ item ] ?? 0;
		let inBag = 0;
		for ( const item in bag ) inBag += bag[ item ];
		const full = inBag >= BAG_CAPACITY;
		// a place under construction shows how far along it is; the chest counts once built
		const site = p.seen.find( ( s ) => s.shows?.construction !== undefined );
		const chest = p.seen.find( ( s ) => s.kind === 'chest' && s.shows?.construction === undefined );
		const stored = ( item: string ) => number( ( chest?.shows?.items as Record<string, unknown> | undefined )?.[ item ] );

		if ( site ) return at( p, site.place ) ? doAt( 'build' ) : go( site.place );

		// catch a fish at the shore
		const gather = (): ToolCall | null => full ? null : at( p, 'shore' ) ? doAt( 'fish' ) : go( 'shore' );

		// keep one in the bag
		if ( carried( 'fish' ) === 0 ) {

			const call = gather();
			if ( call ) return call;

		}

		if ( chest ) {

			if ( at( p, chest.place ) ) {

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
