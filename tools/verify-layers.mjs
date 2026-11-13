// Checks the direction of the imports between the code's layers, that a package is imported only
// through its exits, that the world's chunk worker and the headless exits import only plain code, that the renderer and the island keep off the page, which files
// write another module's state, that each layer names only the userData keys declared for it, and
// that no module reads the look where none is installed. CPU only, no GPU, a few seconds (the page and state checks run
// TypeScript's checker over packages/ and app/).
//   node tools/verify-layers.mjs
//
// The layers, lowest first: render (light, sky, weather, sea, the frame's passes, the generic
// materials and vegetation machinery, the quality tiers), island (this island's generation and
// growth, its materials, plants, camera, characters, creatures), game (everything behind `?game`)
// and app (the page's entry, which assembles the others). A file may import its own layer and the
// layers below it, never one above: a lower layer defines an interface and the higher one fills
// it. A file's folder is its layer: the three lower layers are packages, each a folder of
// `packages/` (`packages/render/`, `packages/island/`, `packages/game/`), and the app layer is
// `app/`. Each package offers two exits (`tools/layers.json`, `exits`), files of re-exports only:
// one for the page (render/index.ts, island/index.ts, game/index.ts) and a headless one for the code that loads without three.js, in the chunk worker and in node (render/data.ts,
// island/land.ts, game/sim/index.ts). The renderer has a third, its setup exit (render/setup.ts):
// what the page needs before the renderer's other modules load (the settings, the look, the quality
// tiers and the render scale they set), which loads in node too. The modules the page loads on
// demand are lazy exits (`lazy`): the page exits leave them out, so they keep chunks of their own.
//
// Guarantees, each a failure (exit 1) when broken:
// - Every code file under `packages/` (.ts, .mts, .js, .mjs) is in the folder of one of the three
//   packages: a new file is placed in a layer by the folder it is added to.
// - No import goes up a layer, except the pairs of files in KNOWN, which are printed but pass.
//   KNOWN only shrinks: a pair in it that no longer imports upward fails, so the entry is removed
//   with the change that removes the import. Imports are read with TypeScript's own pre-processor
//   (static imports, `import type`, re-exports, side-effect and dynamic imports) plus workers'
//   `new URL( '<path>', import.meta.url )`. Package imports are not layered; imports of data files
//   (JSON, CSS) are not checked.
// - The exits: each one `tools/layers.json` names exists in its package's layer and holds only
//   re-exports of its own package's files. An import from one package into another (or from the
//   app layer into a package) names an exit of that package or a lazy exit. A lazy exit is imported
//   dynamically or with `import type` only, from anywhere, so it stays out of the page's chunks.
//   Every name an exit exports (by TypeScript's checker) is taken from it by a file of another
//   package or of the app layer, through an import, a re-export or a dynamic import that names it
//   (a namespace import takes them all); a lazy exit that is not one of its package's exits is a
//   module of the package as well, and its names need only some other file that takes them. No
//   name is exported by two exits.
//   The exits' own tests (the headless and setup ones load in node, the page ones neither await
//   nor read the page at load) are tools/verify-exits.mjs.
// - The test scenes: a file under `app/scenes/` (the scene page and the scenes it shows) imports
//   only the renderer's exits, the renderer's lazy exits and the files beside it, by any kind of
//   import: a scene is built from the renderer alone, and the island's numbers reach its page only
//   through the entry (app/ScenesBoot.ts).
// - Each headless exit, the setup exit and every file they load (static imports and re-exports,
//   `import type` left out) import relative paths only: no package, three.js least of all, so node
//   and a worker load them as they are.
// - The chunk worker (packages/island/world/chunkWorker.ts) and everything it imports, followed through
//   relative imports, imports no package except the files tools/vite-world-generator.mjs hashes:
//   the same walk and the same exceptions as the build's world generator plugin, run here so the
//   check fails before a build does. (Its files are hashed into the world's cache key, and a
//   package such as three.js would not run in the worker's plain code.)
// - The page check: the render and island layers and the game's headless simulation (packages/game/sim/)
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
// - The userData check: a file names only the `userData` keys the renderer declares
//   (packages/render/UserData.ts: the key, who sets it, who reads it, what it means) and, above the renderer,
//   those its own layer declares it keeps to itself (`userData` in tools/layers.json: each layer's
//   file and list, the island's packages/island/world/IslandUserData.ts). Every key on the renderer's list is named
//   by some file of the code, every key on a layer's list by a file of that layer, and no layer's
//   list repeats a key of the renderer's. A key counts where it is written after the
//   bag (`x.userData.key`, `x.userData[ 'key' ]`); one reached through an alias of the bag
//   (`const data = material.userData`) or a computed name is not seen.
// - The look checks: the renderer draws with the look its page installs (packages/render/look/Look.ts), which
//   a module reads as it loads (`readLook(`), so a reader that loads where no look is installed
//   takes the neutral one without a word. Neither that module nor any reader is among the files
//   the chunk worker loads (the world is generated without the look, and no worker installs one).
//   No reader is among the files the headless game loads (every module tools/play-game.mjs
//   and its fixture name, with what those load: the game is played without the look); look/Look.ts
//   itself may be, through the setup exit, whose settings the game's words read (it reads nothing
//   while no reader loads),
//   and no reader is among the files an entry's first module (app/PageSettings.ts, and the scene
//   page's app/ScenesBoot.ts) or the renderer's setup exit loads: the first installs the look and
//   must have run before the first reader does, and the second is what it installs the look through. The files a file loads are
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
const SRC = ROOT;
// the folders the layered code lives in, from the repository's root
const CODE_ROOTS = [ 'packages', 'app' ];
const outside = ( file ) => ! CODE_ROOTS.some( ( root ) => file.startsWith( `${ root }/` ) );
const TABLE = path.join( ROOT, 'tools', 'layers.json' );
const RANK = { render: 0, island: 1, game: 2, app: 3 };
const CODE = /\.(ts|mts|js|mjs)$/;

// Upward imports not yet turned round, as 'from -> to' (paths from the repository's root). Remove
// an entry with the change that removes its import; never add one.
const KNOWN = [];

// The page's globals the lower layers must not name.
const PAGE = [ 'location', 'localStorage', 'sessionStorage', 'document', 'window', 'navigator', 'URLSearchParams', 'requestAnimationFrame', 'cancelAnimationFrame', 'Worker', 'indexedDB', 'fetch' ];
// The one file of each need the renderer and the island have of the browser, and the names it may
// use. Workers start in the module that names their script: the build bundles a worker only from
// a literal `new Worker( new URL( ... ) )`, so each layer's workers start in their own file.
const PAGE_NEEDS = {
	'packages/render/post/FramePacer.ts': { need: 'frame pacing', names: [ 'requestAnimationFrame', 'cancelAnimationFrame' ] },
	'packages/island/world/WorldChunks.ts': { need: 'the world\'s workers', names: [ 'Worker', 'navigator' ] },
	'packages/render/ocean/ShoreWaves.ts': { need: 'the shore field\'s worker', names: [ 'Worker' ] },
	'packages/island/world/WorldCache.ts': { need: 'the world\'s cache', names: [ 'indexedDB', 'navigator' ] },
	'packages/render/FetchAsset.ts': { need: 'the assets\' fetch', names: [ 'fetch' ] },
	'packages/render/vegetation/LeafTexture.ts': { need: 'the textures\' canvas', names: [ 'document' ] },
	'packages/render/Settings.ts': { need: 'the settings\' parser', names: [ 'URLSearchParams' ] },
};

// Module state written from another file, as 'owner file:variable' -> the files that write it
// (paths from the repository's root). Remove a writer, or the entry, with the change that ends its
// writes; never add one.
const STATE = {
	'packages/render/debug/DebugFlags.ts:debugFlags': [ 'packages/render/post/SubmitBatch.ts', 'packages/render/vegetation/VegetationPrepass.ts' ],
	'packages/render/lighting/AmbientGrade.ts:ambient': [ 'packages/render/lighting/AmbientRelight.ts' ],
	'packages/render/lighting/KeyCloud.ts:keyDeckShare': [ 'packages/render/RenderStages.ts' ],
	'packages/render/lighting/SurfaceBRDF.ts:keyGlint': [ 'packages/render/RenderStages.ts' ],
	'packages/render/ocean/Water.ts:keyChroma': [ 'packages/render/RenderStages.ts' ],
	'packages/render/post/GTAO.ts:gtaoMap': [ 'packages/render/post/Pipeline.ts' ],
	'packages/render/post/GTAO.ts:gtaoView': [ 'packages/render/post/Pipeline.ts', 'packages/render/post/PipelinePasses.ts' ],
	'packages/render/post/Jitter.ts:jitter': [ 'packages/render/post/Pipeline.ts', 'packages/render/post/TemporalAA.ts', 'packages/render/post/fsr3/Fsr3Upscaler.ts' ],
	'packages/render/post/MeadowShade.ts:meadowDepthMap': [ 'packages/render/post/Pipeline.ts' ],
	'packages/render/post/MeadowShade.ts:meadowGroundView': [ 'packages/render/post/Pipeline.ts' ],
	'packages/render/post/MeadowShade.ts:meadowShade': [ 'packages/render/post/Pipeline.ts' ],
	'packages/render/post/MeadowShade.ts:screenShadowView': [ 'packages/render/post/Pipeline.ts', 'packages/render/post/PipelinePasses.ts' ],
	'packages/render/post/Motion.ts:reactiveUniforms': [ 'packages/render/post/TemporalAA.ts', 'packages/render/weather/Lightning.ts' ],
	'packages/render/post/fsr3/MipBias.ts:fsr3MipBiasScale': [ 'packages/render/post/fsr3/Fsr3Upscaler.ts' ],
	'packages/render/shared.ts:shared': [ 'packages/render/RenderStages.ts', 'app/Diagnostics.ts', 'packages/render/sky/SkyTrack.ts', 'packages/render/weather/RainCollision.ts' ],
	'packages/render/sky/SkyRetune.ts:skyRetune': [ 'packages/render/RenderStages.ts' ],
	'packages/render/vegetation/VegetationShadow.ts:shadowWindOn': [ 'packages/render/lighting/SunShadow.ts' ],
	'packages/island/world/WorldStart.ts:worldProgress': [ 'packages/island/IslandStages.ts' ],
};
// The pairs of STATE whose writer sits in another layer than the state's owner, as
// 'owner file:variable <- writer': the scene's uniforms the page's diagnostics set.
const ACROSS = [
	'packages/render/shared.ts:shared <- app/Diagnostics.ts',
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

/** The file a relative specifier names (from the repository's root, with '/'), or null for a package. */
function resolve( from, spec ) {

	if ( ! spec.startsWith( '.' ) ) return null;
	const base = path.resolve( path.dirname( path.join( SRC, from ) ), spec.replace( /\?.*$/, '' ) );
	const file = [ base, base + '.ts', path.join( base, 'index.ts' ) ].find( ( c ) => existsSync( c ) && statSync( c ).isFile() ) ?? base;
	return path.relative( SRC, file ).split( path.sep ).join( '/' );

}

/** Each relative import of a file: its target (from the repository's root) and its specifier, as written. */
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

/** TypeScript's program over the code (tsconfig.json), which the page and the state checks read. */
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
		if ( outside( file ) || ! ( table[ file ] === 'render' || table[ file ] === 'island' || file.startsWith( 'packages/game/sim/' ) ) ) continue;
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
		if ( outside( owner ) || owner === writer ) return;
		const key = `${ owner }:${ symbol.name }`;
		if ( ! writes.has( key ) ) writes.set( key, new Set() );
		writes.get( key ).add( writer );

	};
	for ( const source of program.getSourceFiles() ) {

		if ( outside( under( source.fileName ) ) ) continue;
		const visit = ( node ) => {

			if ( ts.isBinaryExpression( node ) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment ) note( node.left, source );
			else if ( ( ts.isPrefixUnaryExpression( node ) || ts.isPostfixUnaryExpression( node ) ) && ( node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken ) ) note( node.operand, source );
			ts.forEachChild( node, visit );

		};
		visit( source );

	}
	return writes;

}

/** Every `userData` key named in the files under packages/ and app/, as { file, line, key }. */
function userDataKeys( program ) {

	const hits = [];
	for ( const source of program.getSourceFiles() ) {

		const file = path.relative( SRC, source.fileName ).split( path.sep ).join( '/' );
		if ( outside( file ) ) continue;
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

/** Each name a file of the code takes from another file, as a map from the file it names (from
 * the repository's root) to { name: [ the files that take it ] }: the names of its `import` and `import type`
 * declarations and re-exports (the exported name, not a local alias), and of its dynamic imports
 * where the name is written at the import (`( await import( ... ) ).name`, `const { name } = await
 * import( ... )`, `import( ... ).Type` in a type). A namespace import (`import * as`) takes every
 * name and is recorded as '*'. */
function takenNames( program ) {

	const taken = new Map();
	const take = ( from, spec, name ) => {

		const to = resolve( from, spec );
		if ( ! to ) return;
		if ( ! taken.has( to ) ) taken.set( to, new Map() );
		const names = taken.get( to );
		if ( ! names.has( name ) ) names.set( name, new Set() );
		names.get( name ).add( from );

	};
	for ( const source of program.getSourceFiles() ) {

		const file = path.relative( SRC, source.fileName ).split( path.sep ).join( '/' );
		if ( outside( file ) ) continue;
		const visit = ( node ) => {

			if ( ts.isImportDeclaration( node ) && ts.isStringLiteralLike( node.moduleSpecifier ) ) {

				const spec = node.moduleSpecifier.text, clause = node.importClause;
				if ( clause?.name ) take( file, spec, 'default' );
				const bindings = clause?.namedBindings;
				if ( bindings && ts.isNamespaceImport( bindings ) ) take( file, spec, '*' );
				else if ( bindings ) for ( const el of bindings.elements ) take( file, spec, ( el.propertyName ?? el.name ).text );

			} else if ( ts.isExportDeclaration( node ) && node.moduleSpecifier && ts.isStringLiteralLike( node.moduleSpecifier ) ) {

				const spec = node.moduleSpecifier.text;
				if ( ! node.exportClause || ts.isNamespaceExport( node.exportClause ) ) take( file, spec, '*' );
				else for ( const el of node.exportClause.elements ) take( file, spec, ( el.propertyName ?? el.name ).text );

			} else if ( ts.isCallExpression( node ) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[ 0 ] && ts.isStringLiteralLike( node.arguments[ 0 ] ) ) {

				const spec = node.arguments[ 0 ].text;
				let up = node.parent;
				while ( up && ( ts.isAwaitExpression( up ) || ts.isParenthesizedExpression( up ) ) ) up = up.parent;
				if ( up && ts.isPropertyAccessExpression( up ) ) take( file, spec, up.name.text );
				else if ( up && ts.isVariableDeclaration( up ) && ts.isObjectBindingPattern( up.name ) ) for ( const el of up.name.elements ) take( file, spec, ( el.propertyName ?? el.name ).text );
				else take( file, spec, '*' );

			} else if ( ts.isImportTypeNode( node ) && ts.isLiteralTypeNode( node.argument ) && ts.isStringLiteralLike( node.argument.literal ) ) {

				const q = node.qualifier;
				take( file, node.argument.literal.text, q ? ( ts.isIdentifier( q ) ? q.text : q.left.getText( source ) ) : '*' );

			}
			ts.forEachChild( node, visit );

		};
		visit( source );

	}
	return taken;

}

/** The names a module exports, by TypeScript's checker. */
function exportedNames( program, file ) {

	const checker = program.getTypeChecker();
	const source = program.getSourceFile( path.join( SRC, file ) );
	const symbol = source && checker.getSymbolAtLocation( source );
	return symbol ? checker.getExportsOfModule( symbol ).map( ( s ) => s.name ) : [];

}

const failures = [];
const layers = JSON.parse( readFileSync( TABLE, 'utf8' ) );
const files = CODE_ROOTS.flatMap( ( root ) => walk( path.join( SRC, root ) ) ).sort();
// each file's layer, its folder: app/, or the package's folder under packages/
const table = Object.fromEntries( files.map( ( f ) => [ f, f.startsWith( 'app/' ) ? 'app' : f.split( '/' )[ 1 ] ] ) );
for ( const [ f, layer ] of Object.entries( table ) ) if ( ! ( layer in RANK ) || layer === 'app' && ! f.startsWith( 'app/' ) ) failures.push( `${ f }: not in the folder of a package (packages/render/, packages/island/, packages/game/)` );

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
const exits = new Map(); // file -> { layer, side: 'page' | 'headless' | 'setup' }
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
for ( const from of files ) {

	for ( const { spec, kind } of importKinds( from ) ) {

		const to = resolve( from, spec );
		if ( ! to || ! ( to in table ) ) continue;
		if ( lazy.has( to ) && kind === 'static' ) failures.push( `${ from }: imports ${ to } statically, a lazy exit the page loads on demand: \`import( ... )\` it, or \`import type\`` );
		if ( table[ from ] === table[ to ] || table[ to ] === 'app' ) continue;
		across ++;
		const exit = exits.get( to );
		if ( exit || lazy.has( to ) ) continue;
		failures.push( `${ from }: imports ${ to } across packages: import it from ${ Object.values( layers.exits[ table[ to ] ] ).join( ' or ' ) }, the ${ table[ to ] } package's exits` );

	}

}

// the test scenes: under app/scenes/ a file imports the renderer's exits, its lazy exits and its
// neighbours only, whatever the kind of import
const SCENES_DIR = 'app/scenes/';
const sceneFiles = files.filter( ( f ) => f.startsWith( SCENES_DIR ) );
if ( sceneFiles.length === 0 ) failures.push( `test scenes: no file under ${ SCENES_DIR }` );
for ( const from of sceneFiles ) {

	for ( const { spec } of importKinds( from ) ) {

		const to = resolve( from, spec );
		if ( ! to || ! ( to in table ) || to.startsWith( SCENES_DIR ) ) continue;
		if ( exits.get( to )?.layer === 'render' || ( lazy.has( to ) && table[ to ] === 'render' ) ) continue;
		failures.push( `${ from }: imports ${ to }: a test scene imports only the renderer's exits (${ Object.values( layers.exits.render ).join( ', ' ) }), its lazy exits and the files beside it` );

	}

}

// the headless and setup exits' reach: relative imports only
const headlessFiles = new Set();
for ( const [ file, { side } ] of exits ) {

	if ( side === 'page' ) continue;
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
const LOOK = 'packages/render/look/Look.ts';
const lookReaders = files.filter( ( f ) => f !== LOOK && /\breadLook\(/.test( readFileSync( path.join( SRC, f ), 'utf8' ) ) );
if ( ! files.includes( LOOK ) || lookReaders.length === 0 ) failures.push( `look check: ${ LOOK } or its readers (\`readLook(\`) not found` );
const workerLoads = loadClosure( 'packages/island/world/chunkWorker.ts' );
if ( workerLoads.has( LOOK ) ) failures.push( `look check: the chunk worker loads ${ LOOK } (the world is generated without the look: no worker installs one)` );
for ( const f of lookReaders ) if ( workerLoads.has( f ) ) failures.push( `look check: the chunk worker loads ${ f }, which reads the look` );
const entryLoads = loadClosure( 'app/PageSettings.ts' );
if ( ! entryLoads.has( LOOK ) ) failures.push( `look check: app/PageSettings.ts does not load ${ LOOK }: the entry installs the look there` );
for ( const f of lookReaders ) if ( entryLoads.has( f ) ) failures.push( `look check: PageSettings.ts loads ${ f }, which reads the look before the entry installs it` );
const SCENES_ENTRY = 'app/ScenesBoot.ts';
const scenesEntryLoads = loadClosure( SCENES_ENTRY );
if ( ! scenesEntryLoads.has( LOOK ) ) failures.push( `look check: ${ SCENES_ENTRY } does not load ${ LOOK }: the scene page's entry installs the look there` );
for ( const f of lookReaders ) if ( scenesEntryLoads.has( f ) ) failures.push( `look check: ${ SCENES_ENTRY } loads ${ f }, which reads the look before the entry installs it` );
const SETUP = [ ...exits ].find( ( [ , { side } ] ) => side === 'setup' )?.[ 0 ];
const setupLoads = SETUP ? loadClosure( SETUP ) : new Set();
if ( ! SETUP ) failures.push( 'look check: tools/layers.json names no setup exit, through which the entry installs the look' );
for ( const f of lookReaders ) if ( setupLoads.has( f ) ) failures.push( `look check: the setup exit ${ SETUP } loads ${ f }, which reads the look before the entry installs it` );
// the headless game: every module tools/play-game.mjs and its fixture name, static or dynamic
const HEADLESS = [ 'tools/play-game.mjs', 'tools/game-fixture.mjs' ];
const headlessLoads = new Set();
for ( const tool of HEADLESS ) for ( const [ , f ] of readFileSync( path.join( ROOT, tool ), 'utf8' ).matchAll( /['"]\.\.\/((?:packages|app)\/[^'"]+\.ts)['"]/g ) ) for ( const g of loadClosure( f ) ) headlessLoads.add( g );
if ( ! headlessLoads.has( 'packages/game/Session.ts' ) ) failures.push( `look check: ${ HEADLESS[ 0 ] } does not load packages/game/Session.ts: the headless game's files were not found` );
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

// the exits' names: each taken by another package, each from one exit
const taken = takenNames( program );
const exitNames = new Map(); // name -> the exits that export it
let exitNameCount = 0;
for ( const file of new Set( [ ...exits.keys(), ...lazy ] ) ) {

	// a lazy exit that is not one of its package's exits is a module of the package as well, whose
	// names the package's own files may take too
	const layer = table[ file ], module = ! exits.has( file );
	const takers = taken.get( file ) ?? new Map();
	const takenBy = ( name ) => [ ...( takers.get( name ) ?? [] ), ...( takers.get( '*' ) ?? [] ) ].some( ( f ) => module ? f !== file : table[ f ] !== layer );
	for ( const name of exportedNames( program, file ) ) {

		exitNameCount ++;
		if ( ! exitNames.has( name ) ) exitNames.set( name, [] );
		exitNames.get( name ).push( file );
		if ( takenBy( name ) ) continue;
		if ( module ) failures.push( `${ file }: exports ${ name }, which no other file takes from it: do not export it` );
		else failures.push( `${ file }: exports ${ name }, which no file outside the ${ layer } package takes from it: leave it out of the exit` );

	}

}
for ( const [ name, from ] of exitNames ) if ( from.length > 1 ) failures.push( `${ name }: exported by ${ from.join( ' and ' ) }: a name leaves its package through one exit` );

// the userData check: the renderer's keys, and each upper layer's own
const userLists = {};
for ( const [ layer, { file, list } ] of Object.entries( layers.userData ?? {} ) ) {

	if ( table[ file ] !== layer ) failures.push( `tools/layers.json: the userData list ${ file } is not in the ${ layer } layer` );
	userLists[ layer ] = { file, keys: ( await import( pathToFileURL( path.join( SRC, file ) ).href ) )[ list ] ?? {} };

}
const USER_DATA = userLists.render?.keys ?? {};
if ( ! userLists.render ) failures.push( 'tools/layers.json: names no userData list for the render layer' );
const userKeys = userDataKeys( program );
for ( const { file, line, key } of userKeys ) {

	const layer = table[ file ];
	if ( key in USER_DATA ) continue;
	if ( layer !== 'render' && userLists[ layer ] && key in userLists[ layer ].keys ) continue;
	const own = layer === 'render' ? '' : userLists[ layer ] ? `, or ${ userLists[ layer ].file } if the ${ layer } layer keeps it to itself` : `, or a list of the ${ layer } layer's own (tools/layers.json, userData) if it keeps it to itself`;
	failures.push( `${ file }:${ line }: names userData.${ key }, which ${ userLists.render?.file } does not declare (${ layer } layer): declare the key there${ own }` );

}
for ( const [ layer, { file, keys } ] of Object.entries( userLists ) ) {

	for ( const key of Object.keys( keys ) ) {

		if ( layer !== 'render' && key in USER_DATA ) failures.push( `${ file } declares '${ key }', which the renderer's list declares too: remove the entry` );
		const named = userKeys.some( ( hit ) => hit.key === key && ( layer === 'render' || table[ hit.file ] === layer ) );
		if ( ! named ) failures.push( `${ file } declares '${ key }', which no file ${ layer === 'render' ? 'of the code' : `of the ${ layer } layer` } names: remove the entry` );

	}

}

console.log( `verify-layers: ${ files.length } files, ${ edges } imports, ${ upward.size } upward (${ KNOWN.length } known), ${ across } across packages, ${ exits.size } exits and ${ lazy.size } lazy, ${ sceneFiles.length } test scene files, the headless and setup exits' ${ headlessFiles.size } files, chunk worker ${ workerFiles } files, ${ pageHits.length } page globals named (${ Object.keys( PAGE_NEEDS ).length } files allowed), ${ statePairs } writes of another file's state (${ ACROSS.length } across layers), ${ Object.entries( userLists ).map( ( [ l, { keys } ] ) => `${ Object.keys( keys ).length } ${ l }` ).join( ' and ' ) } userData keys declared, ${ exitNameCount } names in the exits, ${ lookReaders.length } readers of the look (none in the chunk worker's ${ workerLoads.size } files, the headless game's ${ headlessLoads.size }, the entry's first ${ entryLoads.size }, the scene page's entry's ${ scenesEntryLoads.size } or the setup exit's ${ setupLoads.size })` );
for ( const [ key, pair ] of [ ...upward ].sort() ) console.log( `  ${ known.has( key ) ? 'known' : 'NEW  ' } ${ pair }: ${ key }` );
if ( failures.length ) {

	console.log( `FAIL (${ failures.length })` );
	for ( const f of failures ) console.log( `  ${ f }` );
	process.exit( 1 );

}
console.log( 'PASS' );
