// Checks the renderer's extension points: that a definition of one's own can be registered at each
// of them without changing any other file, and that the files that own the registries name none
// of the scene's definitions. CPU only, no GPU, a few seconds (it loads the page's modules through
// Vite's SSR loader, as tools/wgsl-build.mjs does: TypeScript and `import.meta.env`).
//   node tools/verify-extensions.mjs
//
// Guarantees, each a failure (exit 1) when broken:
// - The three declarations (src/Extensions.ts): a definition without its cost knob, its stand in
//   the test mode or how it follows the land's growth is refused by `checkDeclarations`, which
//   names what is missing, and so by every registry below.
// - A plant kind (src/world/vegetation/Registry.ts): a kind of this tool's, with sites and no art,
//   registers and is drawn with the default plant (DefaultPlant.ts: two cards a site, on a
//   material tagged as vegetation), and the registry's lists hold its root. A kind with a growth
//   that declares it does not depend on the land is refused.
// - A kind of local light (src/lighting/LocalLights.ts): a kind of this tool's registers, a
//   source given by its position alone takes the default's intensity and range, and `refresh`
//   reads the kind's sources again. A second light table on one page is refused.
// - An extra pass (src/post/ExtraPass.ts): a pass of this tool's is declared on a graph in the
//   list's order. Every name in SCENE_PASSES is a scene pass src/post/PipelinePasses.ts declares
//   (`addPass( '<name>', 'scene'`), so the typed names are real ones.
// - Scene events (src/post/SceneEvents.ts): reasons of this tool's are declared and raised (the
//   rest's epoch takes the reason; a cutting one reaches the cut's listeners, the other does not),
//   and a reason declared twice is refused.
// - The scene's histories (src/post/SceneHistory.ts): entries of this tool's are cleared by a jump
//   in the order registered, the ones after the bake apart.
// - No name of the scene's in the owners: the code of each registry's owner file (comments left
//   out) holds none of the words in OWNERS for it: the island's plants, lights, passes, events and
//   kinds are known only where they are defined. A word is matched whole, whatever its case.
//
// What it does not check: that a registered definition draws (the GPU tools: a capture), and the
// kinds' view's rules at work (debug/Classes.ts builds its answer inside a shader's build: the
// capture of `flags=classes` compares it).
//
// Output: a line per check, then the failures. It takes no options. Exit 0 when everything
// passes, 1 otherwise or when a module does not load.
import './qos.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );

// The registries' owner files (under src/) and the scene's words none of their code may hold.
const PLANTS = [ 'grass', 'yunpeng', 'bamboo', 'meadow', 'culms' ];
const OWNERS = {
	'Extensions.ts': [ ...PLANTS, 'leaves', 'wenyao', 'islander', 'game' ],
	'world/vegetation/Registry.ts': [ ...PLANTS, 'leaves' ],
	'world/vegetation/DefaultPlant.ts': [ 'grass', 'yunpeng', 'bamboo', 'meadow', 'culms' ],
	'lighting/LocalLights.ts': [ ...PLANTS, 'leaves', 'lantern' ],
	'post/ExtraPass.ts': [ ...PLANTS, 'leaves', 'fallingLeaves', 'leavesPass' ],
	'post/SceneEvents.ts': [ 'game', 'swap', 'approach', 'world', 'island' ],
	'post/SceneHistory.ts': [ ...PLANTS, 'leaves', 'wenyao', 'islander', 'islanders', 'characters', 'lightning', 'storm', 'wind', 'haze', 'bounce', 'pacer' ],
	// (the kinds' own names, FIT_CLASSES, are the view's: grass, leaves, wood, figure)
	'debug/Classes.ts': [ 'yunpeng', 'bamboo', 'culms', 'rocks', 'seabed', 'feathers', 'weave', 'hanming', 'topY', 'terrainVariant' ],
};

for ( const a of process.argv.slice( 2 ) ) {

	console.error( `verify-extensions: unknown option '${ a }'` );
	process.exit( 1 );

}

const failures = [];
let checks = 0;
const check = ( what, ok, detail = '' ) => {

	checks ++;
	console.log( `${ ok ? 'ok  ' : 'FAIL' } ${ what }${ ok || ! detail ? '' : `: ${ detail }` }` );
	if ( ! ok ) failures.push( `${ what }${ detail ? `: ${ detail }` : '' }` );

};
/** The error `fn` throws, or null. */
const thrown = ( fn ) => {

	try {

		fn();
		return null;

	} catch ( e ) {

		return e;

	}

};

// ---- the owners' code, without comments

function codeOf( file ) {

	const text = readFileSync( path.join( ROOT, 'src', file ), 'utf8' );
	const scanner = ts.createScanner( ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text );
	const parts = [];
	for ( let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan() ) parts.push( scanner.getTokenText() );
	return parts.join( ' ' );

}
for ( const [ file, words ] of Object.entries( OWNERS ) ) {

	const code = codeOf( file );
	const found = words.filter( ( word ) => new RegExp( `(^|[^A-Za-z])${ word }([^A-Za-z]|$)`, 'i' ).test( code ) );
	check( `src/${ file } names none of the scene's definitions`, found.length === 0, `its code holds ${ found.map( ( w ) => `'${ w }'` ).join( ', ' ) }` );

}

// ---- the registries, with definitions of this tool's

const { createServer } = await import( 'vite' );
const server = await createServer( {
	root: ROOT, logLevel: 'error', appType: 'custom', clearScreen: false,
	server: { middlewareMode: true, hmr: false, ws: false, watch: null },
	optimizeDeps: { noDiscovery: true, include: [] },
} );
const DECLARED = { cost: 'none', testMode: 'stateless', land: 'independent' };
try {

	const load = ( file ) => server.ssrLoadModule( `/src/${ file }` );
	const { installSettings, parseSettings } = await load( 'Settings.ts' );
	installSettings( parseSettings( '' ) );
	const { createShared, installShared } = await load( 'shared.ts' );
	const shared = createShared();
	installShared( shared );
	const THREE = await server.ssrLoadModule( 'three/webgpu' );

	// the three declarations
	const { checkDeclarations } = await load( 'Extensions.ts' );
	check( 'a declared definition is accepted', thrown( () => checkDeclarations( 'verify', 'whole', DECLARED ) ) === null );
	check( 'a held definition is accepted', thrown( () => checkDeclarations( 'verify', 'held', { cost: 'grassBlades', testMode: { held: 'off', by: 'the tool', settled: 'nothing' }, land: { follower: 'the tool' } } ) ) === null );
	for ( const key of [ 'cost', 'testMode', 'land' ] ) {

		const e = thrown( () => checkDeclarations( 'verify', 'partial', { ...DECLARED, [ key ]: undefined } ) );
		check( `a definition without its ${ key } is refused by name`, e !== null && String( e.message ).includes( key ) && String( e.message ).includes( 'partial' ), e ? e.message : 'accepted' );

	}

	// a plant kind
	const { Vegetation } = await load( 'world/vegetation/Registry.ts' );
	const { defaultPlant } = await load( 'world/vegetation/DefaultPlant.ts' );
	const standIn = new THREE.DataTexture( new Uint8Array( 4 ), 1, 1 );
	standIn.needsUpdate = true;
	const vegetation = new Vegetation( ( sites, name ) => defaultPlant( shared, sites, name, { map: standIn, alphaMap: standIn } ) );
	const sites = [ { x: 0, y: 5, z: 0 }, { x: 3, y: 5, z: 1 }, { x: - 2, y: 5, z: 4 } ];
	const plant = { name: 'verify plant', sites, prepass: true, shadowFilter: 'vegetation', sunCaster: true, rainBake: true, ...DECLARED };
	const e1 = thrown( () => vegetation.add( plant ) );
	check( 'a plant kind without art registers', e1 === null, e1?.stack ?? '' );
	const root = vegetation.kinds[ 0 ]?.root;
	check( 'it is drawn with the default plant: two cards a site', root?.isMesh === true && root.geometry.index.count === sites.length * 12 && root.geometry.attributes.position.count === sites.length * 8, root ? `${ root.geometry?.index?.count } indices` : 'no root' );
	check( 'its material is tagged as vegetation', root?.material?.userData.vegetation === true );
	check( 'the registry\'s lists hold its root', vegetation.roots( ( kind ) => kind.sunCaster )[ 0 ] === root && vegetation.roots( ( kind ) => ! kind.prepass ).length === 0 );
	const { cost: _cost, ...undeclared } = plant;
	check( 'a plant kind without its declarations is refused', thrown( () => vegetation.add( { ...undeclared, name: 'undeclared plant' } ) ) !== null && vegetation.kinds.length === 1 );
	check( 'a kind with a growth that declares no dependence on the land is refused', thrown( () => vegetation.add( { ...plant, name: 'growing plant', growth: { prepare: function* () {}, swap: () => null } } ) ) !== null );
	check( 'a registry without a default plant refuses a kind without art', thrown( () => new Vegetation().add( plant ) ) !== null );

	// a kind of local light
	const { createLocalLights, DEFAULT_SOURCE } = await load( 'lighting/LocalLights.ts' );
	const lights = createLocalLights();
	let lamps = [ { position: new THREE.Vector3( 1, 6, 2 ) } ];
	const e2 = thrown( () => lights.add( { name: 'verify light', ...DECLARED, sources: () => lamps } ) );
	check( 'a kind of local light registers', e2 === null && lights.sources.length === 1, e2?.stack ?? `${ lights.sources.length } sources` );
	const lamp = lights.sources[ 0 ];
	check( 'a source given by its position is the default light', lamp?.range === DEFAULT_SOURCE.range && lamp.intensity?.x === DEFAULT_SOURCE.intensity && lamp.position === lamps[ 0 ].position );
	lamps = [ ...lamps, { position: new THREE.Vector3( 4, 6, 2 ), intensity: new THREE.Vector3( 2, 1, 0.5 ), range: 3 } ];
	lights.refresh();
	check( 'refresh reads the kind\'s sources again', lights.sources.length === 2 && lights.sources[ 1 ].range === 3 && lights.sources[ 1 ].intensity.x === 2 );
	check( 'a kind of light without its declarations is refused', thrown( () => lights.add( { name: 'undeclared light', sources: () => [] } ) ) !== null && lights.kinds.length === 1 );
	check( 'a second light table on the page is refused', thrown( () => createLocalLights() ) !== null );

	// an extra pass
	const { declareExtraPasses, SCENE_PASSES } = await load( 'post/ExtraPass.ts' );
	const declaredPasses = [];
	const graph = { addPass: ( name, kind ) => declaredPasses.push( `${ name }:${ kind }` ) };
	const pass = ( name ) => ( { name, ...DECLARED, declare: ( g ) => g.addPass( name, 'compute', () => ( {} ) ) } );
	const e3 = thrown( () => declareExtraPasses( graph, [ pass( 'verifyFirst' ), pass( 'verifySecond' ) ] ) );
	check( 'extra passes are declared in the list\'s order', e3 === null && declaredPasses.join() === 'verifyFirst:compute,verifySecond:compute', e3?.stack ?? declaredPasses.join() );
	check( 'an extra pass without its declarations is refused', thrown( () => declareExtraPasses( graph, [ { name: 'undeclared pass', declare: () => {} } ] ) ) !== null );
	const pipeline = readFileSync( path.join( ROOT, 'src', 'post', 'PipelinePasses.ts' ), 'utf8' );
	const missing = SCENE_PASSES.filter( ( name ) => ! pipeline.includes( `addPass( '${ name }', 'scene'` ) );
	check( `the ${ SCENE_PASSES.length } typed scene pass names are passes the pipeline declares`, missing.length === 0, `not declared: ${ missing.join( ', ' ) }` );

	// scene events
	const { declareSceneEvents, onSceneCut } = await load( 'post/SceneEvents.ts' );
	const { restEpoch } = await load( 'post/TemporalRest.ts' );
	const heard = [];
	onSceneCut( ( reason ) => heard.push( reason ) );
	const raise = declareSceneEvents( { 'verify cut': true, 'verify retune': false } );
	const before = restEpoch.value;
	raise( 'verify retune' );
	check( 'a declared reason is raised: the rest\'s epoch takes it', restEpoch.value === before + 1 && restEpoch.reason === 'verify retune' && heard.length === 0, `epoch ${ before } -> ${ restEpoch.value }, reason ${ restEpoch.reason }` );
	raise( 'verify cut' );
	check( 'a cutting reason reaches the cut\'s listeners', heard.join() === 'verify cut' );
	check( 'a reason declared twice is refused', thrown( () => declareSceneEvents( { 'verify cut': false } ) ) !== null && thrown( () => declareSceneEvents( { 'seek': true } ) ) !== null );

	// the scene's histories
	const { SceneHistory } = await load( 'post/SceneHistory.ts' );
	const history = new SceneHistory();
	const cleared = [];
	history.onJump( 'first', () => cleared.push( 'first' ) );
	history.onJump( 'late', () => cleared.push( 'late' ), 'after bake' );
	history.onJump( 'second', () => cleared.push( 'second' ) );
	history.onCut( 'cut', () => cleared.push( 'cut' ) );
	history.jump( 'before bake' );
	const first = cleared.join();
	history.jump( 'after bake' );
	const names = history.names();
	check( 'a jump clears the histories in the order registered, those after the bake apart', first === 'first,second' && cleared.join() === 'first,second,late' && names.cut.join() === 'cut' && names.jump.join() === 'first,second' && names.afterBake.join() === 'late', cleared.join() );

} catch ( e ) {

	check( 'the modules load and run under node', false, e?.stack ?? String( e ) );

}
await server.close();

console.log( `verify-extensions: ${ checks } checks, ${ failures.length } failed` );
if ( failures.length ) {

	console.log( `FAIL (${ failures.length })` );
	for ( const f of failures ) console.log( `  ${ f }` );
	process.exit( 1 );

}
console.log( 'PASS' );
process.exit( 0 );
