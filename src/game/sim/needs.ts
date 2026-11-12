import { isNeed, needs } from './registry.ts';
import { SECONDS_PER_GAME_DAY } from './types.ts';
import type { Needs } from './types.ts';

// An islander's needs, 0..NEED_MAX each: the needs registered (registry.ts; today's in content/),
// in the order registered, each starting where its definition says and falling every tick by its
// rate a day, raised by what answers it (an item's use: registry.ts ItemDef, `raiseNeed`). They
// clamp at 0 with no consequence yet (docs/explanation/game-design.md, "Next"). This module names no need: it
// is the rule every need follows.
//
// A need that falls to CRITICAL_NEED is an event (events.ts `need`), at the tick it crossed the
// line from above, which the record notes; it is noted again only once the need has risen above the
// line and fallen back. The interface's alert is what is true now, a need at or below the line, and
// samples the numbers.

export const NEED_MAX = 100;
/** a need at or below this is critical: the interface raises its alert and the record notes it
 * (docs/explanation/ui.md, Islanders), and below LOW_NEED its bar turns toward the alert's colour */
export const CRITICAL_NEED = 20;
export const LOW_NEED = 50;

/** A new islander's needs, each where its definition starts it. */
export function startNeeds(): Needs {

	const n: Needs = {};
	for ( const need of needs() ) n[ need.id ] = need.start;
	return n;

}

/** Whether a need went from above the critical line to on or below it. */
export function fellCritical( was: number, now: number ): boolean {

	return was > CRITICAL_NEED && now <= CRITICAL_NEED;

}

/** One game second of the needs falling; the needs that fell to the critical line, or null. */
export function fallNeeds( n: Needs ): string[] | null {

	let fell: string[] | null = null;
	for ( const need of needs() ) {

		const was = n[ need.id ];
		n[ need.id ] = Math.max( 0, was - need.perDay / SECONDS_PER_GAME_DAY );
		if ( fellCritical( was, n[ need.id ] ) ) ( fell ??= [] ).push( need.id );

	}
	return fell;

}

/** Raise a need by an amount, up to NEED_MAX. */
export function raiseNeed( n: Needs, need: string, amount: number ): void {

	n[ need ] = Math.min( NEED_MAX, n[ need ] + amount );

}

/** Set a need (the debug panel's), within 0..NEED_MAX: whether it fell to the critical line, as
 * when it falls by itself; false for a need there is not. */
export function setNeed( n: Needs, need: string, value: number ): boolean {

	if ( ! isNeed( need ) || ! Number.isFinite( value ) ) return false;
	const was = n[ need ];
	n[ need ] = Math.min( Math.max( value, 0 ), NEED_MAX );
	return fellCritical( was, n[ need ] );

}
