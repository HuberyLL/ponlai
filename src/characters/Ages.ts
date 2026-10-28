// The islanders' bodies by age and sex, as growth curves relative to the adult of the same sex:
// keyed values, linearly interpolated, so that a child grows and an elder ages smoothly. Pure
// numbers, no three.js, so the simulation can read them too. A figure takes them on its rig in
// FigureAge.ts (the bones' proportions solved from the shares of the height below, the shape keys
// weighted, the elder's stoop).
//
// Sources, taken as rounded key values only: stature by age, the CDC 2000 growth charts' medians
// (public domain); sitting height over stature (the leg's share), Bogin & Varela-Silva 2010,
// "Leg length, body proportion, and health: a review with a note on beauty"; the head's growth,
// from head circumference curves and the face's share of the skull; the stature lost in old age
// (about 5 cm for a man of 80, 8 cm for a woman), as longitudinal ageing studies report it (the
// Baltimore Longitudinal Study of Aging). The adults' look is our own stylised one (about 6.5
// heads, Proportions.ts `real`), every curve a ratio to it, so a child is that adult's child.
//
// No babies: the youngest body drawn is a two-year-old's.

export type Sex = 'male' | 'female';

/** Every value relative to the adult of the same sex, but the height (m) and the weights (0..1). */
export interface Growth {
	/** the age drawn (years, at least 2) */
	age: number;
	sex: Sex;
	/** standing height before the old's loss (m) */
	height: number;
	/** the leg's share of the height, against the adult's (Proportions.ts legs is solved for it) */
	legShare: number;
	/** the head's share of the height, against the adult's (Proportions.ts head is solved for it) */
	headShare: number;
	neck: number;
	torso: number;
	hips: number;
	limbs: number;
	hands: number;
	feet: number;
	/** the arm's length: six tenths of the leg's change */
	arms: number;
	/** the spine's length (the old's lost height is the spine's) */
	spine: number;
	/** the weights of the shape keys: the woman's form after puberty, the small child's, the old's */
	female: number;
	child: number;
	elder: number;
}

/** the adult man's and woman's height (m) */
export const ADULT_HEIGHT: Readonly<Record<Sex, number>> = { male: 1.68, female: 1.56 };

const HEIGHT: Readonly<Record<Sex, Keys>> = {
	male: [ [ 2, .49 ], [ 3, .55 ], [ 4, .59 ], [ 5, .63 ], [ 6, .66 ], [ 8, .73 ], [ 10, .78 ], [ 12, .85 ], [ 13, .89 ], [ 14, .93 ], [ 15, .97 ], [ 16, .99 ], [ 18, 1 ] ],
	// girls are taller than boys from 10 to 13: puberty comes two years earlier
	female: [ [ 2, .53 ], [ 3, .58 ], [ 4, .63 ], [ 5, .66 ], [ 6, .71 ], [ 8, .78 ], [ 10, .85 ], [ 12, .93 ], [ 13, .96 ], [ 14, .98 ], [ 15, .99 ], [ 16, 1 ] ],
};
const HEAD: Keys = [ [ 2, .77 ], [ 3, .80 ], [ 5, .84 ], [ 8, .88 ], [ 10, .90 ], [ 12, .93 ], [ 14, .96 ], [ 16, .98 ], [ 18, 1 ] ];
// the legs grow ahead of the trunk, longest for the height about 12
const LEG: Keys = [ [ 2, .85 ], [ 3, .90 ], [ 5, .94 ], [ 8, .98 ], [ 10, .99 ], [ 12, 1.01 ], [ 14, 1 ] ];
const TORSO: Keys = [ [ 3, 1.04 ], [ 12, 1 ] ];
const HIPS: Keys = [ [ 3, 1.08 ], [ 12, 1 ] ];
// a toddler's fat, then the lean years, then the adult
const LIMBS: Keys = [ [ 2, 1.08 ], [ 6, .92 ], [ 10, .92 ], [ 16, 1 ] ];
const NECK: Keys = [ [ 2, .7 ], [ 3, .8 ], [ 8, .95 ], [ 12, 1 ] ];
// the small child's shape key, and the old's (which also drives the stoop and the lost height)
const CHILD: Keys = [ [ 2, 1 ], [ 5, .6 ], [ 9, .25 ], [ 14, 0 ] ];
const ELDER: Keys = [ [ 50, 0 ], [ 60, .25 ], [ 70, .55 ], [ 80, .85 ], [ 90, 1 ] ];
// the adult woman against the adult man
const WOMAN = { torso: 0.94, hips: 1.07, legs: 0.98, head: 1.02, limbs: 0.97, hands: 0.97, feet: 0.95 };
// the spine's share of the height an elder loses (at the elder weight 1)
const SPINE_LOSS: Readonly<Record<Sex, number>> = { male: 0.06, female: 0.09 };
// comfortable walking pace against the adult's
const PACE: Keys = [ [ 3, .70 ], [ 5, .77 ], [ 8, .88 ], [ 12, .96 ], [ 18, 1 ], [ 60, 1 ], [ 70, .93 ], [ 80, .80 ], [ 90, .65 ] ];

/** degrees each bone of the back and neck bends forward at the elder weight 1: most in the upper
 * back (a kyphosis; a bend low in the back folded the belly into the closed top), the head
 * raised against the rest so the gaze stays about level, and the upper arms turned back as far as
 * the back bends, so they hang plumb from the shoulders (carried with the back, they swung back
 * and held the hands behind the hips, bent at the wrist) */
export const STOOP = { Abdomen: 2, Torso: 8, Chest: 12, UpperArmL: - 22, UpperArmR: - 22, Neck: 8, Head: - 24 } as const;

type Keys = readonly ( readonly [ number, number ] )[];

function at( keys: Keys, x: number ): number {

	if ( x <= keys[ 0 ][ 0 ] ) return keys[ 0 ][ 1 ];
	for ( let i = 1; i < keys.length; i ++ ) {

		const [ x1, y1 ] = keys[ i ];
		if ( x <= x1 ) {

			const [ x0, y0 ] = keys[ i - 1 ];
			return y0 + ( y1 - y0 ) * ( x - x0 ) / ( x1 - x0 );

		}

	}
	return keys[ keys.length - 1 ][ 1 ];

}

function smoothstep( a: number, b: number, x: number ): number {

	const t = Math.min( Math.max( ( x - a ) / ( b - a ), 0 ), 1 );
	return t * t * ( 3 - 2 * t );

}

/** Puberty's progress: from 9 to 15 for a girl, 11 to 17 for a boy (boys stay the children's
 * shape, the man's being the base). */
function puberty( sex: Sex, age: number ): number {

	return sex === 'female' ? smoothstep( 9, 15, age ) : smoothstep( 11, 17, age );

}

/** The body at an age (years). */
export function growth( sex: Sex, age: number ): Growth {

	age = Math.max( age, 2 );
	const young = Math.min( age, 18 );
	const female = sex === 'female' ? puberty( sex, age ) : 0;
	const sexed = ( k: keyof typeof WOMAN ) => 1 + ( WOMAN[ k ] - 1 ) * female;
	const elder = at( ELDER, age );
	const leg = at( LEG, young );
	return {
		age, sex,
		height: heightAt( sex, age ),
		legShare: leg * sexed( 'legs' ),
		headShare: at( HEAD, young ) / at( HEIGHT[ sex ], young ) * sexed( 'head' ),
		neck: at( NECK, age ),
		torso: at( TORSO, age ) * sexed( 'torso' ),
		hips: at( HIPS, age ) * sexed( 'hips' ),
		limbs: at( LIMBS, age ) * sexed( 'limbs' ) * ( 1 - 0.07 * elder ),
		hands: sexed( 'hands' ),
		feet: sexed( 'feet' ),
		arms: 1 + 0.6 * ( leg - 1 ),
		spine: 1 - SPINE_LOSS[ sex ] * elder,
		female, child: at( CHILD, age ), elder,
	};

}

/** The standing height (m) at an age, before the old's loss: growth's `height` alone (the
 * simulation's bodies stand this tall, sim/physics.ts). */
export function heightAt( sex: Sex, age: number ): number {

	return ADULT_HEIGHT[ sex ] * at( HEIGHT[ sex ], Math.min( Math.max( age, 2 ), 18 ) );

}

/** The elder weight alone (the stoop follows it every frame). */
export function elderAt( age: number ): number {

	return at( ELDER, age );

}

/** The walking pace at an age, against the adult's. */
export function paceAt( age: number ): number {

	return at( PACE, Math.max( age, 2 ) );

}

/**
 * The age a figure's body is built for while it is `age` (FigureAge.ts builds it again when this
 * changes): a quarter year for a child, one body from 18 to 50 (nothing changes between), a year
 * for the old. The height follows the age itself between rebuilds.
 */
export function builtAge( age: number ): number {

	age = Math.max( age, 2 );
	return age < 18 ? Math.floor( age * 4 ) / 4 : age < 50 ? 18 : Math.floor( age );

}

/** A figure's sex and age (years). */
export interface Body {
	sex: Sex;
	age: number;
}

/** Bodies written as sex and age, `M30,F28,F6` (the `body` and `bodies` URL options): those that read. */
export function parseBodies( text: string | null ): Body[] {

	const out: Body[] = [];
	for ( const s of ( text ?? '' ).split( ',' ) ) {

		const m = /^\s*([MF])(\d+(?:\.\d+)?)\s*$/i.exec( s );
		if ( m ) out.push( { sex: m[ 1 ].toUpperCase() === 'F' ? 'female' : 'male', age: Number( m[ 2 ] ) } );

	}
	return out;

}
