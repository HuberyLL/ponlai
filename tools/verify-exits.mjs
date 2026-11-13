// Checks the packages' exits (tools/layers.json `exits`): that each headless exit and the
// renderer's setup exit load in plain node, and that nothing the page and setup exits load awaits
// or reads the page as it loads. CPU only, no GPU, about a second.
//   node tools/verify-exits.mjs
//
// An exit is a file of re-exports through which another package imports a package
// (tools/verify-layers.mjs checks that every import across packages goes through one). Loading an
// exit loads its whole package, so a module that did work as it loaded would make the order of
// the imports part of the program, and a package that read the page at load could not be loaded
// anywhere else.
//
// Guarantees, each a failure (exit 1) when broken:
// - Each headless exit (render/data.ts, island/land.ts, game/sim/index.ts) and the setup exit
//   (render/setup.ts, which the headless game loads for its settings) loads in plain node, with its
//   types stripped and nothing installed first, without throwing, and every value name it
//   re-exports is defined once it has loaded. (The page exits do not load in node, nor need to:
//   modules of theirs read `import.meta.env`, which the bundler provides.)
// - Every file a page exit (render/index.ts, island/index.ts, game/index.ts) or the setup exit loads, followed
//   through its
//   static imports and re-exports with `import type` left out, has no `await` at module scope and
//   names none of the page's globals in PAGE at module scope. Module scope is the code that runs as
//   the module loads: its top-level statements, the initialisers of its classes' static fields and
//   static blocks, and the bodies of functions called where they are written; a function's body,
//   a method or an instance field's initialiser runs later and is not read. A name counts unless
//   it is a property's name (`x.document`, `{ window: ... }`) or the file declares it at its top
//   level; type positions are not code and pass.
//
// Output: a line per exit and the failures. It takes no options. Exit 0 when everything passes, 1
// with the failures listed.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const SRC = ROOT;
const { exits } = JSON.parse( readFileSync( path.join( ROOT, 'tools', 'layers.json' ), 'utf8' ) );

// The page's globals a module must not read as it loads: the address, the storage, the document,
// window, the browser's description, the frame callbacks, workers, IndexedDB and fetch.
const PAGE = new Set( [ 'location', 'localStorage', 'sessionStorage', 'document', 'window', 'navigator', 'requestAnimationFrame', 'cancelAnimationFrame', 'Worker', 'indexedDB', 'fetch' ] );

for ( const a of process.argv.slice( 2 ) ) {

	console.error( `verify-exits: unknown option '${ a }'` );
	process.exit( 1 );

}

const failures = [];
const parse = ( file ) => ts.createSourceFile( file, readFileSync( path.join( SRC, file ), 'utf8' ), ts.ScriptTarget.Latest, true );

/** The file a relative specifier names (from the repository's root, with '/'), or null for a package. */
function resolve( from, spec ) {

	if ( ! spec.startsWith( '.' ) ) return null;
	const file = path.resolve( path.dirname( path.join( SRC, from ) ), spec );
	return path.relative( SRC, file ).split( path.sep ).join( '/' );

}

/** The files a file loads as it loads, itself included: static imports and re-exports, not
 * `import type` / `export type`, followed through relative specifiers. */
function loadClosure( entry ) {

	const seen = new Set();
	const visit = ( file ) => {

		if ( seen.has( file ) || ! /\.(ts|mts|js|mjs)$/.test( file ) || ! existsSync( path.join( SRC, file ) ) ) return;
		seen.add( file );
		for ( const statement of parse( file ).statements ) {

			const typeOnly = ts.isImportDeclaration( statement ) ? statement.importClause?.isTypeOnly : ts.isExportDeclaration( statement ) ? statement.isTypeOnly : true;
			if ( typeOnly || ! statement.moduleSpecifier ) continue;
			const to = resolve( file, statement.moduleSpecifier.text );
			if ( to ) visit( to );

		}

	};
	visit( entry );
	return seen;

}

/** The value names an exit re-exports (`export { a, b as c } from`, not `export type`). */
function valueNames( file ) {

	const names = [];
	for ( const statement of parse( file ).statements ) {

		if ( ! ts.isExportDeclaration( statement ) || statement.isTypeOnly || ! statement.exportClause || ! ts.isNamedExports( statement.exportClause ) ) continue;
		for ( const e of statement.exportClause.elements ) if ( ! e.isTypeOnly ) names.push( e.name.text );

	}
	return names;

}

/** What a file does at module scope that a module must not do as it loads: `await`, and the page's
 * globals it names. */
function atLoad( file ) {

	const source = parse( file );
	const declared = new Set();
	for ( const statement of source.statements ) {

		if ( ts.isVariableStatement( statement ) ) for ( const d of statement.declarationList.declarations ) { if ( ts.isIdentifier( d.name ) ) declared.add( d.name.text ); }
		else if ( ( ts.isFunctionDeclaration( statement ) || ts.isClassDeclaration( statement ) ) && statement.name ) declared.add( statement.name.text );
		else if ( ts.isImportDeclaration( statement ) && statement.importClause ) {

			const c = statement.importClause;
			if ( c.name ) declared.add( c.name.text );
			if ( c.namedBindings ) {

				if ( ts.isNamespaceImport( c.namedBindings ) ) declared.add( c.namedBindings.name.text );
				else for ( const e of c.namedBindings.elements ) declared.add( e.name.text );

			}

		}

	}
	const hits = [];
	const at = ( node ) => source.getLineAndCharacterOfPosition( node.getStart( source ) ).line + 1;
	const isFunction = ( node ) => ts.isFunctionDeclaration( node ) || ts.isFunctionExpression( node ) || ts.isArrowFunction( node ) || ts.isMethodDeclaration( node ) || ts.isConstructorDeclaration( node ) || ts.isGetAccessorDeclaration( node ) || ts.isSetAccessorDeclaration( node );
	const isStatic = ( node ) => node.modifiers?.some( ( m ) => m.kind === ts.SyntaxKind.StaticKeyword );
	const visit = ( node ) => {

		if ( ts.isTypeNode( node ) || ts.isInterfaceDeclaration( node ) || ts.isTypeAliasDeclaration( node ) ) return;
		// a function written and called in place runs at load: read its body
		if ( ts.isCallExpression( node ) ) {

			let callee = node.expression;
			while ( ts.isParenthesizedExpression( callee ) ) callee = callee.expression;
			if ( ts.isFunctionExpression( callee ) || ts.isArrowFunction( callee ) ) {

				visit( callee.body );
				node.arguments.forEach( visit );
				return;

			}

		}
		if ( isFunction( node ) ) return;
		if ( ts.isPropertyDeclaration( node ) && ! isStatic( node ) ) return;
		if ( ts.isAwaitExpression( node ) || ( ts.isForOfStatement( node ) && node.awaitModifier ) ) hits.push( `${ file }:${ at( node ) }: awaits at load` );
		if ( ts.isIdentifier( node ) && PAGE.has( node.text ) && ! declared.has( node.text ) ) {

			const parent = node.parent;
			const property = ( ts.isPropertyAccessExpression( parent ) && parent.name === node ) || ( ( ts.isPropertyAssignment( parent ) || ts.isPropertyDeclaration( parent ) || ts.isMethodDeclaration( parent ) ) && parent.name === node );
			if ( ! property ) hits.push( `${ file }:${ at( node ) }: reads the page's \`${ node.text }\` at load` );

		}
		ts.forEachChild( node, visit );

	};
	source.statements.forEach( visit );
	return hits;

}

const lines = [];
const read = new Set();
for ( const [ pkg, sides ] of Object.entries( exits ) ) for ( const [ side, exit ] of Object.entries( sides ) ) {

	// a headless or setup exit, loaded in plain node
	if ( side !== 'page' ) try {

		const module = await import( pathToFileURL( path.join( SRC, exit ) ).href );
		const missing = valueNames( exit ).filter( ( name ) => module[ name ] === undefined );
		for ( const name of missing ) failures.push( `${ exit }: \`${ name }\` is undefined once loaded in node` );
		lines.push( `${ pkg }: ${ exit } loads in node (${ Object.keys( module ).length } values)` );

	} catch ( e ) {

		failures.push( `${ exit }: does not load in plain node: ${ e.message.split( '\n' )[ 0 ] }` );

	}

	// a page or setup exit, read
	if ( side === 'headless' ) continue;
	const files = loadClosure( exit );
	for ( const file of files ) {

		if ( read.has( file ) ) continue;
		read.add( file );
		failures.push( ...atLoad( file ) );

	}
	lines.push( `${ pkg }: ${ exit } loads ${ files.size } files, none awaits or reads the page at load` );

}

for ( const line of lines ) console.log( `verify-exits: ${ line }` );
if ( failures.length ) {

	console.log( `FAIL (${ failures.length })` );
	for ( const f of failures ) console.log( `  ${ f }` );
	process.exit( 1 );

}
console.log( 'PASS' );
