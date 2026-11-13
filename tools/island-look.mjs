// Installs the island's look for a tool that loads the renderer's modules outside the page. The
// renderer draws with the look its page installs (packages/render/look/Look.ts `installLook`); where nobody
// installed one it reads its own neutral look, so a tool that wants the numbers the island's page
// has installs the island's look (packages/island/look/IslandLook.ts) before the first module that
// reads it loads. CPU only; no options.
//
//   import './island-look.mjs';            // first, ahead of any import from packages/
//
// installs it for node's own modules (imports are evaluated in the order written, so the line
// goes above the tool's first import from `packages/`, or from a module that imports one).
//
//   import { installIslandLook } from './island-look.mjs';
//   await installIslandLook( ( file ) => server.ssrLoadModule( `/${ file }` ) );
//
// installs it through another loader, whose modules are not node's own (Vite's server-side loader:
// tools/wgsl-build.mjs; another checkout's tree: tools/dusk-grid.mjs `--src`). `load` takes a
// path from the tree's root and returns the module. A tree without `packages/render/look/Look.ts` (a checkout from before
// the look was installed) is left as it is: its modules hold the island's numbers themselves.
import { installLook } from '../packages/render/look/Look.ts';
import { ISLAND_LOOK } from '../packages/island/look/IslandLook.ts';

installLook( ISLAND_LOOK );

/** Installs the island's look in the modules `load( '<path from the tree's root>' )` returns; `has`,
 * when given, says whether that tree has a file (false for the look's module: nothing to install). */
export async function installIslandLook( load, has = () => true ) {

	if ( ! has( 'packages/render/look/Look.ts' ) ) return;
	const { installLook: install } = await load( 'packages/render/look/Look.ts' );
	const { ISLAND_LOOK: look } = await load( 'packages/island/look/IslandLook.ts' );
	install( look );

}
