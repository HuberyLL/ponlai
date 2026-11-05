import { bagOf, bring, room } from '../items.ts';
import { raiseNeed } from '../needs.ts';
import { register } from '../registry.ts';

// Food: hunger (the need `satiety`), the fish that answers it, and fishing at the shore (shore.ts).
//
// - satiety: falls SATIETY_PER_DAY a game day from its start of 80 (fed, not full).
// - fish: `eat` raises satiety by FISH_SATIETY.
// - `fish` at the shore takes FISH_SECONDS and brings a fish by chance (the seeded generator, at
//   its end); a full bag refuses it, and one filled meanwhile ends it failed.
//
// The rates come from the game's day, so a day of play has a person's rhythm: someone eats about
// every 12 hours. Satiety falls 72 a day (3 an hour) and a fish gives 36: one every 12 game hours,
// two a day. It runs from full to empty in a day and a third, so a missed meal shows in the numbers
// within hours but nothing is lost to one mistake. A fish comes for about an hour of fishing (half
// the tries of 20 minutes catch) against the two an islander eats a day, so the shore keeps one
// islander and leaves a little to store.

export const SATIETY_PER_DAY = 72;
/** satiety a fish gives: about one every 12 game hours */
export const FISH_SATIETY = 36;
export const FISH_SECONDS = 20 * 60;
export const FISH_CHANCE = 0.5;

register( {
	needs: [ { id: 'satiety', start: 80, perDay: SATIETY_PER_DAY } ],
	items: [ { id: 'fish', uses: { eat: ( body ) => {

		raiseNeed( body.needs, 'satiety', FISH_SATIETY );
		return { ok: true, value: 'ate a fish' };

	} } } ],
	options: [ { id: 'fish', at: 'shore', make: () => ( {
		open: () => true,
		start: ( _sim, body ) => room( bagOf( body ) ) < 1 ? { ok: false, reason: 'the bag is full' } : { ok: true, seconds: FISH_SECONDS },
		finish: ( sim, body ) => {

			if ( sim.random() >= FISH_CHANCE ) return { ok: true, value: 'caught nothing' };
			const bag = bagOf( body );
			if ( room( bag ) < 1 ) return { ok: false, reason: 'the bag is full' };
			bring( sim, bag, 'fish' );
			return { ok: true, value: 'caught a fish' };

		},
	} ) } ],
} );
