// Checks the direction of the imports between the code's layers, that a package is imported only
// through its exits, that the world's chunk worker and the headless exits import only plain code, that the renderer and the island keep off the page, which files
// write another module's state, that the renderer names only the userData keys it declares, and
// that no module reads the look where none is installed. CPU only, no GPU, a few seconds (the page and state checks run
// TypeScript's checker over src/).
//   node tools/verify-layers.mjs
//
// The layers, lowest first: render (light, sky, weather, sea, the frame's passes, the generic
// materials and vegetation machinery, the quality tiers), island (this island's generation and
// growth, its materials, plants, camera, characters, creatures), game (everything behind `?game`)
// and app (the page's entry, which assembles the others). A file may import its own layer and the
// layers below it, never one above: a lower layer defines an interface and the higher one fills
// it. Which layer a file belongs to is not its folder's name: some files sit in another layer's
// folder until the files move, so `tools/layers.json` maps every file under `src/` to its layer
// (`files`). The three lower layers are packages, and each offers two exits (`exits`), files of
// re-exports only: one for the page (render.ts, island.ts, game/index.ts) and a headless one for
// the code that loads without three.js, in the chunk worker and in node (renderData.ts,
// islandLand.ts, game/sim/index.ts). The modules the page loads on demand are lazy exits (`lazy`):
// the page exits leave them out, so they keep chunks of their own.
//
// Guarantees, each a failure (exit 1) when broken:
// - Every code file under `src/` (.ts, .mts, .js, .mjs) has a layer in `tools/layers.json`, and
//   every file named there exists: a new file is placed in a layer when it is added.
// - No import goes up a layer, except the pairs of files in KNOWN, which are printed but pass.
//   KNOWN only shrinks: a pair in it that no longer imports upward fails, so the entry is removed
//   with the change that removes the import. Imports are read with TypeScript's own pre-processor
//   (static imports, `import type`, re-exports, side-effect and dynamic imports) plus workers'
//   `new URL( '<path>', import.meta.url )`. Package imports are not layered; imports of data files
//   (JSON, CSS) are not checked.
// - The exits: each one `tools/layers.json` names exists in its package's layer and holds only
//   re-exports of its own package's files. An import from one package into another (or from the
//   app layer into a package) names an exit of that package or a lazy exit, outside the pairs in
//   DIRECT, each the reason a file must name a module by its path. A lazy exit is imported
//   dynamically or with `import type` only, from anywhere, so it stays out of the page's chunks.
//   DIRECT only shrinks: a pair in it that no longer imports fails. The exits' own tests (the
//   headless ones load in node, the page ones neither await nor read the page at load) are
//   tools/verify-exits.mjs.
// - Each headless exit and every file it loads (static imports and re-exports, `import type` left
//   out) import relative paths only: no package, three.js least of all, so node and a worker load
//   them as they are.
// - The chunk worker (src/world/chunkWorker.ts) and everything it imports, followed through
//   relative imports, imports no package except the files tools/vite-world-generator.mjs hashes:
//   the same walk and the same exceptions as the build's world generator plugin, run here so the
//   check fails before a build does. (Its files are hashed into the world's cache key, and a
//   package such as three.js would not run in the worker's plain code.)
// - The page check: the render and island layers and the game's headless simulation (game/sim/)
//   name none of the page's globals in PAGE (the address, the browser's storage, the document,
//   window, navigator, the frame callbacks, workers, IndexedDB, fetch), outside the files in
//   PAGE_NEEDS, each the one place of a need the renderer has of the browser and allowed only the
//   names it needs. The page (the app layer: the entry, PageSettings.ts, main.ts) owns the rest and
//   hands the renderer what it needs (the canvas, the settings, the storage). A name counts by
//   what it resolves to, so a local of the same name passes and `globalThis.x` is not seen; type
//   positions (`typeof window`) are not code and pass.
// - The state check: an exported module-level variable is written only by its own file, outside the
//   pairs in STATE (the variable, as 'file:name', and the other files that write it). STATE only
//   shrinks: a pair in it that no longer writes fails, so the entry is removed with the change that
//   gives the state one writer (a creation parameter, a field of an instance, or a call of an
//   operation its owner exports). A writer in another layer than the owner's must also be in
//   ACROSS, which only shrinks too. A write is an assignment (or `++` / `--`) whose target is a
//   property chain rooted at the variable (`state.field = x`, `uniforms.gain.value = x`), found
//   through the import's binding; a method that mutates (`vector.copy( x )`) and a GUI bound to a
//   field are not seen.
// - The userData check: a file of the render layer names only the `userData` keys the renderer
//   declares (src/UserData.ts: the key, who sets it, who reads it, what it means), and every key
//   declared there is named by some file under src/. A key counts where it is written after the
//   bag (`x.userData.key`, `x.userData[ 'key' ]`); one reached through an alias of the bag
//   (`const data = material.userData`) or a computed name is not seen.
// - The look checks: the renderer draws with the look its page installs (src/look/Look.ts), which
//   a module reads as it loads (`readLook(`), so a reader that loads where no look is installed
//   takes the neutral one without a word. Neither that module nor any reader is among the files
//   the chunk worker loads (the world is generated without the look, and no worker installs one),
//   nor among the files the headless game loads (every src/ module tools/play-game.mjs and its
//   fixture name, with what those load: the game is played without the look),
//   and no reader is among the files the entry's first module (src/PageSettings.ts) loads, which
//   installs the look and must have run before the first reader does. The files a file loads are
//   its static imports and re-exports followed through relative specifiers, `import type` left
//   out (it is erased) and dynamic imports too (they load later).
//
// Output: a summary on stdout, every upward import found (known or not) and the failures. It takes
// no options. Exit 0 when everything passes, 1 with the failures listed.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { worldGeneratorSources } from './vite-world-generator.mjs';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const SRC = path.join( ROOT, 'src' );
const TABLE = path.join( ROOT, 'tools', 'layers.json' );
const RANK = { render: 0, island: 1, game: 2, app: 3 };
const CODE = /\.(ts|mts|js|mjs)$/;

// Upward imports not yet turned round, as 'from -> to' (paths under src/). Remove an entry with
// the change that removes its import; never add one.
const KNOWN = [];

// Imports across packages that name a module by its path instead of an exit, as 'from -> to'
// (paths under src/), with the reason. Remove an entry with the change that removes its import;
// never add one.
const DIRECT = {
	// the entry's first module installs the settings and the look before any reader of them loads;
	// the renderer's page exit loads every reader, and its headless exit cannot hold these (the
	// chunk worker loads it, and the worker must not load the look)
	'PageSettings.ts -> Settings.ts': 'installs the settings before the renderer loads',
	'PageSettings.ts -> look/Look.ts': 'installs the look before the renderer loads',
	'PageSettings.ts -> look/NeutralLook.ts': 'installs the look before the renderer loads',
	'QualityDetect.ts -> Quality.ts': 'chooses the tier before the renderer loads (PageSettings.ts)',
	'QualityDetect.ts -> post/RenderScale.ts': 'chooses the tier before the renderer loads (PageSettings.ts)',
	// node loads the interface's words (tools/play-game.mjs), and the renderer's page exit does not
	// load in node
	'game/ui/i18n/i18n.ts -> Settings.ts': 'node loads it (tools/play-game.mjs)',
};

// The page's globals the lower layers must not name.
const PAGE = [ 'location', 'localStorage', 'sessionStorage', 'document', 'window', 'navigator', 'URLSearchParams', 'requestAnimationFrame', 'cancelAnimationFrame', 'Worker', 'indexedDB', 'fetch' ];
// The one file of each need the renderer and the island have of the browser, and the names it may
// use. Workers start in the module that names their script: the build bundles a worker only from
// a literal `new Worker( new URL( ... ) )`, so each layer's workers start in their own file.
const PAGE_NEEDS = {
	'post/FramePacer.ts': { need: 'frame pacing', names: [ 'requestAnimationFrame', 'cancelAnimationFrame' ] },
	'world/WorldChunks.ts': { need: 'the world\'s workers', names: [ 'Worker', 'navigator' ] },
	'ocean/ShoreWaves.ts': { need: 'the shore field\'s worker', names: [ 'Worker' ] },
	'world/WorldCache.ts': { need: 'the world\'s cache', names: [ 'indexedDB', 'navigator' ] },
	'FetchAsset.ts': { need: 'the assets\' fetch', names: [ 'fetch' ] },
	'world/vegetation/LeafTexture.ts': { need: 'the textures\' canvas', names: [ 'document' ] },
	'Settings.ts': { need: 'the settings\' parser', names: [ 'URLSearchParams' ] },
};

// Module state written from another file, as 'owner file:variable' -> the files that write it
// (paths under src/). Remove a writer, or the entry, with the change that ends its writes; never
// add one.
const STATE = {
	'debug/DebugFlags.ts:debugFlags': [ 'post/SubmitBatch.ts', 'world/VegetationPrepass.ts' ],
	'lighting/AmbientGrade.ts:ambient': [ 'lighting/AmbientRelight.ts' ],
	'lighting/KeyCloud.ts:keyDeckShare': [ 'RenderStages.ts' ],
	'lighting/SurfaceBRDF.ts:keyGlint': [ 'RenderStages.ts' ],
	'ocean/Water.ts:keyChroma': [ 'RenderStages.ts' ],
	'post/GTAO.ts:gtaoMap': [ 'post/Pipeline.ts' ],
	'post/GTAO.ts:gtaoView': [ 'post/Pipeline.ts', 'post/PipelinePasses.ts' ],
	'post/Jitter.ts:jitter': [ 'post/Pipeline.ts', 'post/TemporalAA.ts', 'post/fsr3/Fsr3Upscaler.ts' ],
	'post/MeadowShade.ts:meadowDepthMap': [ 'post/Pipeline.ts' ],
	'post/MeadowShade.ts:meadowGroundView': [ 'post/Pipeline.ts' ],
	'post/MeadowShade.ts:meadowShade': [ 'post/Pipeline.ts' ],
	'post/MeadowShade.ts:screenShadowView': [ 'post/Pipeline.ts', 'post/PipelinePasses.ts' ],
	'post/Motion.ts:reactiveUniforms': [ 'post/TemporalAA.ts', 'weather/Lightning.ts' ],
	'post/fsr3/MipBias.ts:fsr3MipBiasScale': [ 'post/fsr3/Fsr3Upscaler.ts' ],
	'shared.ts:shared': [ 'RenderStages.ts', 'app/Diagnostics.ts', 'app/Frame.ts', 'sky/SkyTrack.ts', 'weather/RainCollision.ts' ],
	'sky/SkyRetune.ts:skyRetune': [ 'RenderStages.ts' ],
	'world/VegetationShadow.ts:shadowWindOn': [ 'lighting/SunShadow.ts' ],
	'world/WorldStart.ts:worldProgress': [ 'IslandStages.ts' ],
};
// The pairs of STATE whose writer sits in another layer than the state's owner, as
// 'owner file:variable <- writer': the scene's uniforms the page's frame sets.
const ACROSS = [
	'shared.ts:shared <- app/Diagnostics.ts',
	'shared.ts:shared <- app/Frame.ts',
];

for ( const a of process.argv.slice( 2 ) ) {

	console.error( `verify-layers: unknown option '${ a }'` );
	process.exit( 1 );

}

function walk( dir, out = [] ) {

	for ( const name of readdirSync( dir ) ) {

		const p = path.join( dir, name );
		if ( statSync( p ).isDirectory() ) walk( p, out );
		else if ( CODE.test( name ) ) out.push( path.relative( SRC, p ).split( path.sep ).join( '/' ) );

	}
	return out;

}

/** The file a relative specifier names (under src/, with '/'), or null for a package. */
function resolve( from, spec ) {

	if ( ! spec.startsWith( '.' ) ) return null;
	const base = path.resolve( path.dirname( path.join( SRC, from ) ), spec.replace( /\?.*$/, '' ) );
	const file = [ base, base + '.ts', path.join( base, 'index.ts' ) ].find( ( c ) => existsSync( c ) && statSync( c ).isFile() ) ?? base;
	return path.relative( SRC, file ).split( path.sep ).join( '/' );

}

/** Each relative import of a file: its target (under src/) and its specifier, as written. */
function imports( file ) {

	const text = readFileSync( path.join( SRC, file ), 'utf8' );
	const specs = ts.preProcessFile( text, true, true ).importedFiles.map( ( f ) => f.fileName );
	for ( const m of text.matchAll( /new\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g ) ) specs.push( m[ 1 ] );
	const out = [];
	for ( const spec of new Set( specs ) ) {

		const to = resolve( file, spec );
		if ( to ) out.push( { to, spec } );

	}
	return out;

}

/** Each import of a file, relative or not: its specifier and how it loads ('static', 'type' for
 * `import type` / `export type` and `import( ... )` types, 'dynamic' for `import( ... )`). */
function importKinds( file ) {

	const source = ts.createSourceFile( file, readFileSync( path.join( SRC, file ), 'utf8' ), ts.ScriptTarget.Latest, true );
	const out = [];
	const visit = ( node ) => {

		if ( ( ts.isImportDeclaration( node ) || ts.isExportDeclaration( node ) ) && node.moduleSpecifier && ts.isStringLiteralLike( node.moduleSpecifier ) ) {

			const typeOnly = ts.isImportDeclaration( node ) ? node.importClause?.isTypeOnly : node.isTypeOnly;
			out.push( { spec: node.moduleSpecifier.text, kind: typeOnly ? 'type' : 'static' } );

		} else if ( ts.isCallExpression( node ) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[ 0 ] && ts.isStringLiteralLike( node.arguments[ 0 ] ) ) {

			out.push( { spec: node.arguments[ 0 ].text, kind: 'dynamic' } );

		} else if ( ts.isImportTypeNode( node ) && ts.isLiteralTypeNode( node.argument ) && ts.isStringLiteralLike( node.argument.literal ) ) {

			out.push( { spec: node.argument.literal.text, kind: 'type' } );

		}
		ts.forEachChild( node, visit );

	};
	visit( source );
	return out;

}

/** The files a file loads as it loads, itself included: its static imports and re-exports that are
 * not `import type` / `export type` (those are erased), followed through relative specifiers.
 * Dynamic imports load later and are left out; `import { type X }` still loads its module and
 * counts. */
function loadClosure( entry ) {

	const seen = new Set();
	const visit = ( file ) => {

		if ( seen.has( file ) || ! existsSync( path.join( SRC, file ) ) || ! CODE.test( file ) ) return;
		seen.add( file );
		const source = ts.createSourceFile( file, readFileSync( path.join( SRC, file ), 'utf8' ), ts.ScriptTarget.Latest, false );
		for ( const statement of source.statements ) {

			const typeOnly = ts.isImportDeclaration( statement ) ? statement.importClause?.isTypeOnly : ts.isExportDeclaration( statement ) ? statement.isTypeOnly : true;
			if ( typeOnly || ! statement.moduleSpecifier ) continue;
			const to = resolve( file, statement.moduleSpecifier.text );
			if ( to ) visit( to );

		}

	};
	visit( entry );
	return seen;

}

/** TypeScript's program over src/ (tsconfig.json), which the page and the state checks read. */
function typedProgram() {

	const config = ts.getParsedCommandLineOfConfigFile( path.join( ROOT, 'tsconfig.json' ), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: ( d ) => { throw new Error( ts.flattenDiagnosticMessageText( d.messageText, '\n' ) ); } } );
	return ts.createProgram( { rootNames: config.fileNames, options: config.options } );

}

/** Every identifier in the checked files that resolves to one of PAGE's globals. */
function pageGlobals( table, program ) {

	const checker = program.getTypeChecker();
	const globals = new Map();
	for ( const name of PAGE ) {

		const symbol = checker.resolveName( name, undefined, ts.SymbolFlags.Value, false );
		if ( symbol ) globals.set( symbol, name );

	}
	const hits = [];
	for ( const source of program.getSourceFiles() ) {

		const file = path.relative( SRC, source.fileName ).split( path.sep ).join( '/' );
		if ( file.startsWith( '..' ) || ! ( table[ file ] === 'render' || table[ file ] === 'island' || file.startsWith( 'game/sim/' ) ) ) continue;
		const visit = ( node ) => {

			if ( ts.isTypeNode( node ) ) return;
			if ( ts.isIdentifier( node ) ) {

				let symbol = checker.getSymbolAtLocation( node );
				if ( symbol && symbol.flags & ts.SymbolFlags.Alias ) symbol = checker.getAliasedSymbol( symbol );
				const name = symbol && globals.get( symbol );
				if ( name ) hits.push( { file, line: source.getLineAndCharacterOfPosition( node.getStart( source ) ).line + 1, name } );

			}
			ts.forEachChild( node, visit );

		};
		visit( source );

	}
	return hits;

}

/**
 * The exported module-level variables another file writes, as 'file:name' -> the writers' files.
 * A write is an assignment (or ++ / --) whose target is a property chain rooted at the variable
 * (`state.field = x`, `uniforms.gain.value = x`); a method that mutates (`vector.copy( x )`) is
 * not seen.
 */
function stateWrites( program ) {

	const checker = program.getTypeChecker();
	const under = ( fileName ) => path.relative( SRC, fileName ).split( path.sep ).join( '/' );
	const writes = new Map();
	const root = ( node ) => {

		while ( ts.isPropertyAccessExpression( node ) || ts.isElementAccessExpression( node ) || ts.isNonNullExpression( node ) || ts.isParenthesizedExpression( node ) || ts.isAsExpression( node ) ) node = node.expression;
		return ts.isIdentifier( node ) ? node : null;

	};
	const note = ( target, source ) => {

		if ( ! ts.isPropertyAccessExpression( target ) && ! ts.isElementAccessExpression( target ) ) return;
		const id = root( target );
		if ( ! id ) return;
		let symbol = checker.getSymbolAtLocation( id );
		if ( symbol && symbol.flags & ts.SymbolFlags.Alias ) symbol = checker.getAliasedSymbol( symbol );
		const declaration = symbol?.valueDeclaration;
		if ( ! declaration || ! ts.isVariableDeclaration( declaration ) ) return;
		const statement = declaration.parent.parent;
		if ( ! ts.isVariableStatement( statement ) || ! ts.isSourceFile( statement.parent ) ) return;
		const owner = under( declaration.getSourceFile().fileName ), writer = under( source.fileName );
		if ( owner.startsWith( '..' ) || owner === writer ) return;
		const key = `${ owner }:${ symbol.name }`;
		if ( ! writes.has( key ) ) writes.set( key, new Set() );
		writes.get( key ).add( writer );

	};
	for ( const source of program.getSourceFiles() ) {

		if ( under( source.fileName ).startsWith( '..' ) ) continue;
		const visit = ( node ) => {

			if ( ts.isBinaryExpression( node ) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment ) note( node.left, source );
			else if ( ( ts.isPrefixUnaryExpression( node ) || ts.isPostfixUnaryExpression( node ) ) && ( node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken ) ) note( node.operand, source );
			ts.forEachChild( node, visit );

		};
		visit( source );

	}
	return writes;

}

/** Every `userData` key named in the files under src/, as { file, line, key }. */
function userDataKeys( program ) {

	const hits = [];
	for ( const source of program.getSourceFiles() ) {

		const file = path.relative( SRC, source.fileName ).split( path.sep ).join( '/' );
		if ( file.startsWith( '..' ) ) continue;
		const bag = ( node ) => ( ts.isPropertyAccessExpression( node ) && node.name.text === 'userData' ) || ( ts.isIdentifier( node ) && node.text === 'userData' );
		const visit = ( node ) => {

			let key = null;
			if ( ts.isPropertyAccessExpression( node ) && bag( node.expression ) ) key = node.name.text;
			else if ( ts.isElementAccessExpression( node ) && bag( node.expression ) && ts.isStringLiteralLike( node.argumentExpression ) ) key = node.argumentExpression.text;
			if ( key !== null ) hits.push( { file, line: source.getLineAndCharacterOfPosition( node.getStart( source ) ).line + 1, key } );
			ts.forEachChild( node, visit );

		};
		visit( source );

	}
	return hits;

}

const failures = [];
const layers = JSON.parse( readFileSync( TABLE, 'utf8' ) );
const table = layers.files;
const files = walk( SRC ).sort();

// the table against the files
for ( const f of files ) if ( ! ( f in table ) ) failures.push( `${ f }: no layer in tools/layers.json` );
for ( const [ f, layer ] of Object.entries( table ) ) {

	if ( ! files.includes( f ) ) failures.push( `tools/layers.json names ${ f }, which does not exist` );
	if ( ! ( layer in RANK ) ) failures.push( `tools/layers.json: ${ f } has an unknown layer '${ layer }'` );

}

// the imports' direction
const upward = new Map();
let edges = 0;
for ( const from of files ) {

	for ( const { to, spec } of imports( from ) ) {

		edges ++;
		if ( ! CODE.test( to ) ) continue;
		if ( ! ( to in table ) ) {

			if ( ! files.includes( to ) ) failures.push( `${ from }: imports '${ spec }', which does not exist` );
			continue;

		}
		if ( RANK[ table[ from ] ] < RANK[ table[ to ] ] ) {

			const key = `${ from } -> ${ to }`;
			upward.set( key, `${ table[ from ] } -> ${ table[ to ] }` );

		}

	}

}
const known = new Set( KNOWN );
for ( const [ key, pair ] of upward ) if ( ! known.has( key ) ) failures.push( `upward import (${ pair }): ${ key }` );
for ( const key of KNOWN ) if ( ! upward.has( key ) ) failures.push( `KNOWN lists ${ key }, which no longer imports upward: remove the entry` );

// the exits
const exits = new Map(); // file -> { layer, side: 'page' | 'headless' }
for ( const [ layer, sides ] of Object.entries( layers.exits ) ) for ( const [ side, file ] of Object.entries( sides ) ) exits.set( file, { layer, side } );
const lazy = new Set( layers.lazy );
for ( const layer of Object.keys( RANK ).filter( ( l ) => l !== 'app' ) ) if ( ! layers.exits[ layer ]?.page || ! layers.exits[ layer ]?.headless ) failures.push( `tools/layers.json: the ${ layer } package has no page or no headless exit` );
for ( const [ file, { layer } ] of exits ) {

	if ( table[ file ] !== layer ) { failures.push( `tools/layers.json: the exit ${ file } is not in the ${ layer } layer` ); continue; }
	const source = ts.createSourceFile( file, readFileSync( path.join( SRC, file ), 'utf8' ), ts.ScriptTarget.Latest, false );
	for ( const statement of source.statements ) {

		const to = ts.isExportDeclaration( statement ) && statement.moduleSpecifier && resolve( file, statement.moduleSpecifier.text );
		if ( ! to ) failures.push( `${ file }: an exit holds re-exports only (\`export { ... } from './...'\`)` );
		else if ( table[ to ] !== layer ) failures.push( `${ file }: re-exports ${ to }, which is not in its package (${ layer })` );

	}

}
for ( const file of lazy ) if ( ! ( table[ file ] in RANK ) || table[ file ] === 'app' ) failures.push( `tools/layers.json: the lazy exit ${ file } is not a file of a package` );
let across = 0;
const direct = new Set();
for ( const from of files ) {

	for ( const { spec, kind } of importKinds( from ) ) {

		const to = resolve( from, spec );
		if ( ! to || ! ( to in table ) ) continue;
		if ( lazy.has( to ) && kind === 'static' ) failures.push( `${ from }: imports ${ to } statically, a lazy exit the page loads on demand: \`import( ... )\` it, or \`import type\`` );
		if ( table[ from ] === table[ to ] || table[ to ] === 'app' ) continue;
		across ++;
		const exit = exits.get( to );
		if ( exit || lazy.has( to ) ) continue;
		const key = `${ from } -> ${ to }`;
		if ( key in DIRECT ) { direct.add( key ); continue; }
		const { page, headless } = layers.exits[ table[ to ] ];
		failures.push( `${ from }: imports ${ to } across packages: import it from ${ page } or ${ headless }, the ${ table[ to ] } package's exits` );

	}

}
for ( const key of Object.keys( DIRECT ) ) if ( ! direct.has( key ) ) failures.push( `DIRECT lists ${ key }, which no longer imports across packages by path: remove the entry` );

// the headless exits' reach: relative imports only
const headlessFiles = new Set();
for ( const [ file, { side } ] of exits ) {

	if ( side !== 'headless' ) continue;
	for ( const f of loadClosure( file ) ) {

		headlessFiles.add( f );
		for ( const { spec } of importKinds( f ) ) if ( ! spec.startsWith( '.' ) ) failures.push( `${ f }: imports '${ spec }', and the headless exit ${ file } loads it: a headless exit's files import relative paths only` );

	}

}

// the chunk worker's imports
let workerFiles = 0;
try {

	workerFiles = worldGeneratorSources( ROOT ).length;

} catch ( e ) {

	failures.push( `chunk worker: ${ e.message }` );

}

// the look checks: who reads the installed look (look/Look.ts `readLook`), and where they must not load
const LOOK = 'look/Look.ts';
const lookReaders = files.filter( ( f ) => f !== LOOK && /\breadLook\(/.test( readFileSync( path.join( SRC, f ), 'utf8' ) ) );
if ( ! files.includes( LOOK ) || lookReaders.length === 0 ) failures.push( `look check: ${ LOOK } or its readers (\`readLook(\`) not found` );
const workerLoads = loadClosure( 'world/chunkWorker.ts' );
if ( workerLoads.has( LOOK ) ) failures.push( `look check: the chunk worker loads ${ LOOK } (the world is generated without the look: no worker installs one)` );
for ( const f of lookReaders ) if ( workerLoads.has( f ) ) failures.push( `look check: the chunk worker loads ${ f }, which reads the look` );
const entryLoads = loadClosure( 'PageSettings.ts' );
if ( ! entryLoads.has( LOOK ) ) failures.push( `look check: PageSettings.ts does not load ${ LOOK }: the entry installs the look there` );
for ( const f of lookReaders ) if ( entryLoads.has( f ) ) failures.push( `look check: PageSettings.ts loads ${ f }, which reads the look before the entry installs it` );
// the headless game: every src/ module tools/play-game.mjs and its fixture name, static or dynamic
const HEADLESS = [ 'tools/play-game.mjs', 'tools/game-fixture.mjs' ];
const headlessLoads = new Set();
for ( const tool of HEADLESS ) for ( const [ , f ] of readFileSync( path.join( ROOT, tool ), 'utf8' ).matchAll( /['"]\.\.\/src\/([^'"]+\.ts)['"]/g ) ) for ( const g of loadClosure( f ) ) headlessLoads.add( g );
if ( ! headlessLoads.has( 'game/Session.ts' ) ) failures.push( `look check: ${ HEADLESS[ 0 ] } does not load game/Session.ts: the headless game's files were not found` );
if ( headlessLoads.has( LOOK ) ) failures.push( `look check: the headless game loads ${ LOOK } (the game is played without the look: tools/play-game.mjs installs none)` );
for ( const f of lookReaders ) if ( headlessLoads.has( f ) ) failures.push( `look check: the headless game loads ${ f }, which reads the look` );

// the page check
const program = typedProgram();
const pageHits = pageGlobals( table, program );
for ( const [ f ] of Object.entries( PAGE_NEEDS ) ) if ( ! files.includes( f ) ) failures.push( `PAGE_NEEDS names ${ f }, which does not exist` );
for ( const { file, line, name } of pageHits ) {

	if ( PAGE_NEEDS[ file ]?.names.includes( name ) ) continue;
	failures.push( `${ file }:${ line }: names the page's \`${ name }\` (${ table[ file ] } layer): take it from the page, or add the need to PAGE_NEEDS` );

}

// the state check
const states = stateWrites( program );
let statePairs = 0;
for ( const [ key, writers ] of states ) {

	const owner = key.split( ':' )[ 0 ];
	for ( const writer of writers ) {

		statePairs ++;
		if ( ! STATE[ key ]?.includes( writer ) ) failures.push( `${ writer } writes ${ key }: a module's state is written by its own file (give it a creation parameter, an instance's field or an operation of its owner)` );
		else if ( table[ writer ] !== table[ owner ] && ! ACROSS.includes( `${ key } <- ${ writer }` ) ) failures.push( `${ writer } (${ table[ writer ] }) writes ${ key } (${ table[ owner ] }): a write across layers` );

	}

}
for ( const [ key, writers ] of Object.entries( STATE ) ) for ( const writer of writers ) {

	if ( ! states.get( key )?.has( writer ) ) failures.push( `STATE lists ${ writer } writing ${ key }, which it no longer does: remove the entry` );

}
for ( const pair of ACROSS ) {

	const [ key, writer ] = pair.split( ' <- ' );
	if ( ! STATE[ key ]?.includes( writer ) || table[ writer ] === table[ key.split( ':' )[ 0 ] ] ) failures.push( `ACROSS lists '${ pair }', which is not a write across layers in STATE: remove the entry` );

}

// the userData check
const { USER_DATA } = await import( pathToFileURL( path.join( SRC, 'UserData.ts' ) ).href );
const userKeys = userDataKeys( program );
for ( const { file, line, key } of userKeys ) {

	if ( table[ file ] === 'render' && ! ( key in USER_DATA ) ) failures.push( `${ file }:${ line }: names userData.${ key }, which src/UserData.ts does not declare (render layer): declare the key there` );

}
for ( const key of Object.keys( USER_DATA ) ) if ( ! userKeys.some( ( hit ) => hit.key === key ) ) failures.push( `src/UserData.ts declares '${ key }', which no file under src/ names: remove the entry` );

console.log( `verify-layers: ${ files.length } files, ${ edges } imports, ${ upward.size } upward (${ KNOWN.length } known), ${ across } across packages (${ direct.size } by path, in DIRECT), ${ exits.size } exits and ${ lazy.size } lazy, the headless exits' ${ headlessFiles.size } files, chunk worker ${ workerFiles } files, ${ pageHits.length } page globals named (${ Object.keys( PAGE_NEEDS ).length } files allowed), ${ statePairs } writes of another file's state (${ ACROSS.length } across layers), ${ Object.keys( USER_DATA ).length } userData keys declared, ${ lookReaders.length } readers of the look (none in the chunk worker's ${ workerLoads.size } files, the headless game's ${ headlessLoads.size } or the entry's first ${ entryLoads.size })` );
for ( const [ key, pair ] of [ ...upward ].sort() ) console.log( `  ${ known.has( key ) ? 'known' : 'NEW  ' } ${ pair }: ${ key }` );
if ( failures.length ) {

	console.log( `FAIL (${ failures.length })` );
	for ( const f of failures ) console.log( `  ${ f }` );
	process.exit( 1 );

}
console.log( 'PASS' );
