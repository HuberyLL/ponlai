// The scene page's entry, the module scenes.html loads: what Boot.ts and PageSettings.ts are to
// the island's page. It parses the address, warns of its problems, chooses the quality tier and
// installs the settings, then the look the renderer draws with, and only then loads the scene page
// (app/scenes/ScenePage.ts), by a dynamic import, so every module that reads a setting or the look
// as it loads does so after the install.
// The test scenes are the renderer's own, so the look is the renderer's neutral one
// (look/NeutralLook.ts). `renderLook=ponlai` on a debug page installs the island's instead, for a
// scene read beside the island's own numbers: this entry takes them from the island's headless
// exit, and the scenes themselves never import the island (tools/verify-layers.mjs).
import { installSettings, parseSettings, settingProblems, installLook, NEUTRAL_LOOK } from '../packages/render/setup.ts';
import { chooseQuality } from './QualityDetect.ts';
import { ISLAND_LOOK } from '../packages/island/land.ts';

const query = parseSettings( location.search );
for ( const problem of settingProblems( query ) ) console.warn( `[settings] ${ problem }` );
installSettings( query, chooseQuality( query ).tier );
const debugPage = import.meta.env.DEV || query.has( 'debug' ) || query.has( 'profile' );
installLook( debugPage && query.get( 'renderLook' ) === 'ponlai' ? ISLAND_LOOK : NEUTRAL_LOOK );

await import( './scenes/ScenePage.ts' );
