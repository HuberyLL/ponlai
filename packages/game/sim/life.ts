import { paceAt, type Sex } from '../../island/land.ts';
import { exp, log } from './maths.ts';
import { random } from './rng.ts';
import type { RngState } from './rng.ts';
import { SECONDS_PER_YEAR } from './types.ts';
import type { Villager } from './types.ts';

// An islander's life: a game day is a year, and a lifespan drawn once by Gompertz's law.
//
// An islander's life: a game day is a year of it (types.ts SECONDS_PER_YEAR), and each one dies of
// old age at a lifespan drawn once, as it comes, as a person's is in a present-day population with
// accidents and disease left out: the life the body was born with. The ages at death follow
// Gompertz's law (B. Gompertz, 1825: the hazard of dying grows by a fixed share each year), fitted
// to the old ages of Japan's abridged life table for 2022 (Ministry of Health, Labour and Welfare):
// the mode of the ages at death and the hazard's growth, by sex. Without the accidents of youth
// (Makeham's term), a lifespan drawn at 20 averages about 82 years for a man and 88 for a woman.
// An islander who comes grown draws on the condition that it lived to its age.
//
// The body's own curves (its height, its walking pace) are packages/island/characters/Ages.ts's, which the
// figures read too.

/** the mode of the ages at death (years) and the yearly growth of the hazard, by sex */
const GOMPERTZ: Readonly<Record<Sex, { mode: number; growth: number }>> = {
	male: { mode: 87.0, growth: 0.111 },
	female: { mode: 92.5, growth: 0.128 },
};

/** An islander's age (years) at a tick. */
export function ageOf( v: Pick<Villager, 'born'>, tick: number ): number {

	return ( tick - v.born ) / SECONDS_PER_YEAR;

}

/** The walking pace at its age against an adult's. */
export function paceOf( v: Pick<Villager, 'born'>, tick: number ): number {

	return paceAt( ageOf( v, tick ) );

}

/** A lifespan (years) for one of a sex who has lived to `age`, from the seeded generator: Gompertz's
 * law inverted, S( x ) / S( age ) = U for U uniform in ( 0, 1 ]. */
export function drawLifespan( state: RngState, sex: Sex, age: number ): number {

	const { mode, growth } = GOMPERTZ[ sex ];
	const e = - log( 1 - random( state ) );
	return log( exp( growth * age ) + exp( growth * mode ) * e ) / growth;

}
