// Runtime switches for timing a change inside one page (debug builds expose them as
// window.__PONLAI__.flags). An optimisation under development keeps its old path and reads a flag
// where it chooses between the two, every frame:
//
//   import { debugFlags } from '../debug/DebugFlags.ts';
//   const mesh = debugFlags.lowPolyGrass ? newGrass : oldGrass;   // or skip a pass, pick a material
//
// and tools/profile-frame.mjs flips it every few frames with --toggle "s.flags.lowPolyGrass = on",
// after warming both paths, to A/B it in seconds without a reload. A shader change keeps both
// materials (or both nodes) built and swaps them on the flag, rather than branching inside one
// shader, so each side runs its own pipeline. A missing flag reads as undefined: the old path
// while a change is under development. Once an optimisation ships, a missing flag must mean the
// shipped path, so its flag either selects the old path only on an explicit `false`
// (`flags.ssrCull = false`) or is named for the old path (`flags.skyWholeBake = true`); the code
// that reads the flag says which. --toggle sets the flag explicitly on both sides either way.
//
// `mv` holds the temporal modes' motion vector sources (src/post/Motion.ts), each on unless set to
// false: `flags.mv.camera = false` leaves the camera's motion out of every surface's velocity, as
// MV-UNIT compares a source on against off. `camera` and `object` (an object's world matrix) are
// read by Motion.ts; `skin`, `wind`, `sea` and `foam` by the movers that write those motions
// (`wind`: the vegetation's materials, through WindVariants.ts, swap to a build without the previous
// sway, so a --toggle of it also times that sway).
//
// `windFreeze = true` holds the vegetation's wind while the scene clock runs (Wind.ts): the plants
// stand in one pose with no motion, for clips where only the shadows or the jitter should move.
export interface MotionSourceFlags { camera?: boolean; object?: boolean; skin?: boolean; wind?: boolean; sea?: boolean; foam?: boolean }
export const debugFlags: Record<string, boolean | number | string | MotionSourceFlags | undefined> & { mv: MotionSourceFlags } = { mv: {} };

// `flags=<name>:<value>,...` in the URL (debug builds: the dev server, ?debug, ?profile) sets flags
// as this module loads, before any module reads them, so a capture or a clip A/Bs a flag by its
// query. A value reads as true / false, a number, or else the string itself; `mv.<source>` sets a
// motion source. (Under node, as the plain verify tools run modules, there is no location.)
const search = ( globalThis as { location?: { search: string } } ).location?.search ?? '';
const query = new URLSearchParams( search );
if ( query.has( 'flags' ) && ( ( import.meta as { env?: { DEV?: boolean } } ).env?.DEV || query.has( 'debug' ) || query.has( 'profile' ) ) ) {

	for ( const entry of ( query.get( 'flags' ) ?? '' ).split( ',' ) ) {

		const at = entry.indexOf( ':' );
		if ( at <= 0 ) continue;
		const name = entry.slice( 0, at ), text = entry.slice( at + 1 );
		const value = text === 'true' ? true : text === 'false' ? false : text !== '' && Number.isFinite( Number( text ) ) ? Number( text ) : text;
		if ( name.startsWith( 'mv.' ) ) ( debugFlags.mv as Record<string, unknown> )[ name.slice( 3 ) ] = value;
		else debugFlags[ name ] = value;

	}

}
