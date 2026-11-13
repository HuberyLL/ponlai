import { register } from '../registry.ts';

// Water: the hydration need, held still until the island has a water source of its own.
//
// Water: thirst (the need `hydration`), off until the island has a water source of its own. It
// holds where it starts (HYDRATION_PER_DAY is 0) and nothing raises it; the interface still shows
// it. With a source it falls 96 a day (4 an hour, a drink of 32 every 8 game hours), faster than
// hunger, as for a person: then a drink is an item with a use and the source an option at a place,
// registered here beside the need.

/** 0: thirst is off (see the header); 96 with a water source */
export const HYDRATION_PER_DAY = 0;

register( { needs: [ { id: 'hydration', start: 80, perDay: HYDRATION_PER_DAY } ] } );
