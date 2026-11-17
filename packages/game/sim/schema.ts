import type { EntityId } from './types.ts';

// The schemas outside input is checked against once, at the entrance, before any rule runs.
//
// Outside input is checked once, at the entrance: a tool call from an agent (agent.ts `act`), or a
// command of the player's (../Session.ts `speak`, `place`), is matched against its schema here
// before any rule runs, and the rules then take the clean arguments as given. A schema names each
// argument with its type and whether it may be left out; `checkArgs` refuses what does not match,
// with a reason the caller hands on (the next thought perceives it):
//
// - not an object (an array, null, a number), or absent where an argument is required;
// - an argument the schema does not name (an agent's stray field, `__proto__`): refused, never
//   copied, so nothing outside the schema reaches a rule or the save;
// - a value of another type: a text that is blank, a number that is not finite (NaN, which JSON
//   writes as null), a count that is not a whole number from 1, an audience that names an
//   islander twice. A null is a value, not a left-out argument, so it never falls back to a
//   default.
//
// The arguments come back as a fresh object holding only the schema's names, read with
// Object.hasOwn, each once, and texts trimmed (words said, an id with a stray space). Outside input
// is plain data, what JSON carries (an agent's answer is parsed from it), so nothing here defends
// against getters or proxies. Whether a value names something in the world (a place, an item, an
// islander) is the rules' to say: that changes as the game runs, a schema does not.

/** the types an argument can have */
export type ArgType = 'text' | 'number' | 'positive' | 'count' | 'audience';

export interface ArgSpec {
	type: ArgType;
	/** it may be left out (absent, never null) */
	optional?: true;
}

export type Schema = Readonly<Record<string, ArgSpec>>;

type ValueOf<T extends ArgType> = T extends 'number' | 'positive' | 'count' ? number : T extends 'audience' ? EntityId[] | 'all' : string;
type Required<S extends Schema> = { [ K in keyof S as S[ K ][ 'optional' ] extends true ? never : K ]: ValueOf<S[ K ][ 'type' ]> };
type Optional<S extends Schema> = { [ K in keyof S as S[ K ][ 'optional' ] extends true ? K : never ]?: ValueOf<S[ K ][ 'type' ]> };
/** The clean arguments of a schema: its required names and, where given, its optional ones. */
export type ArgsOf<S extends Schema> = Required<S> & Optional<S>;

const TYPES: Readonly<Record<ArgType, { is( value: unknown ): boolean; says: string }>> = {
	text: { is: ( x ) => typeof x === 'string' && x.trim() !== '', says: 'a text that is not blank' },
	number: { is: ( x ) => typeof x === 'number' && Number.isFinite( x ), says: 'a number' },
	positive: { is: ( x ) => typeof x === 'number' && Number.isFinite( x ) && x > 0, says: 'a number above 0' },
	count: { is: ( x ) => typeof x === 'number' && Number.isInteger( x ) && x >= 1, says: 'a whole number from 1' },
	audience: { is: ( x ) => x === 'all' || ( Array.isArray( x ) && x.length > 0 && x.every( ( id ) => typeof id === 'string' && id !== '' ) && new Set( x ).size === x.length ), says: '"all" or a list of islanders\' ids, each once' },
};

const isObject = ( value: unknown ): value is Record<string, unknown> => typeof value === 'object' && value !== null && ! Array.isArray( value );

/** Arguments checked against a schema (`what` names the call in the reasons: a tool's name): the
 * clean arguments, or why they are refused. Absent arguments (undefined) are none. */
export function checkArgs<S extends Schema>( what: string, schema: S, args: unknown ): { ok: true; args: ArgsOf<S> } | { ok: false; reason: string } {

	const given = args === undefined ? {} : args;
	if ( ! isObject( given ) ) return { ok: false, reason: `${ what } takes its arguments as an object` };
	for ( const key of Object.keys( given ) ) {

		if ( ! Object.hasOwn( schema, key ) ) return { ok: false, reason: `${ what } takes no ${ key }${ argumentList( schema ) }` };

	}
	const clean: Record<string, unknown> = {};
	for ( const key of Object.keys( schema ) ) {

		const spec = schema[ key ];
		const value = Object.hasOwn( given, key ) ? given[ key ] : undefined;
		if ( value === undefined ) {

			if ( spec.optional ) continue;
			return { ok: false, reason: `${ what } needs ${ key }` };

		}
		if ( ! TYPES[ spec.type ].is( value ) ) return { ok: false, reason: `${ key } must be ${ TYPES[ spec.type ].says }` };
		clean[ key ] = typeof value === 'string' ? value.trim() : Array.isArray( value ) ? [ ...value ] : value;

	}
	return { ok: true, args: clean as ArgsOf<S> };

}

// the names a schema takes, for a refusal of another: " (place)", or "" for none
function argumentList( schema: Schema ): string {

	const names = Object.keys( schema );
	return names.length > 0 ? ` (${ names.join( ', ' ) })` : '';

}
