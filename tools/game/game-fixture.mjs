// The island for the CPU-only game checks (verify-game.mjs): the page's default land (seed 1, the
// starting island), and the land IslandGrowth grows from it by a number of pieces (`inputAt`); and
// the interface's catalogues as node can import them (`importCatalogues`), for the tools that write
// in the interface's words (play-game.mjs, verify-game.mjs).
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { growLand } from '../../packages/island/world/IslandGrowth.ts';

/** The island grown by `step` pieces after the starting island (seed 1). */
export function inputAt( step ) {

	const { land } = growLand( 1, step );
	return { land };

}

export const input = inputAt( 0 );

/** Let node import the interface's catalogues (packages/game/ui/i18n/*.json) as the page's bundler does:
 * as a module whose default export is the JSON. Call it before importing the interface's data
 * tables (data/*.ts), which load them, with a dynamic import. */
export function importCatalogues() {

	registerHooks( { load( url, context, next ) {

		if ( ! url.endsWith( '.json' ) || ! url.includes( '/packages/game/ui/i18n/' ) ) return next( url, context );
		return { format: 'module', shortCircuit: true, source: `export default ${ readFileSync( new URL( url ), 'utf8' ) };` };

	} } );

}
