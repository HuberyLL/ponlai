// Checks that the packages' entry points load without doing work or reading the page, the headless ones in plain node.
//
// An entry point is a file of re-exports through which another package imports a package
// (tools/repo/layers.json `entryPoints`; tools/repo/verify-layers.mjs checks that every import across
// packages goes through one). Loading an entry point loads its whole package, so a module that did work as
// it loaded would make the order of the imports part of the program, and a package that read the
// page at load could not be loaded anywhere else. Run it after a change to what an entry point loads; it
// is part of `npm run check`.
//
// Usage:
//   node tools/repo/verify-entry-points.mjs
//
// Options: none.
//
// What it checks, each a failure when broken:
// - Each headless entry point (packages/render/data.ts, packages/island/land.ts,
//   packages/game/sim/index.ts) and the setup entry point (packages/render/setup.ts, which the headless game
//   loads for its settings) loads in plain node, with its types stripped and nothing installed first,
//   without throwing, and every value name it re-exports is defined once it has loaded. The page
//   entry points do not load in node, nor need to: modules of theirs read `import.meta.env`, which the
//   bundler provides.
// - Every file a main entry point (packages/render/index.ts, packages/island/index.ts,
//   packages/game/index.ts) or the setup entry point loads, followed through its static imports and
//   re-exports with `import type` left out, has no `await` at module scope and names none of the
//   page's globals in PAGE (the address, the storage, the document, window, the browser's
//   description, the frame callbacks, workers, IndexedDB, fetch) at module scope. Module scope is
//   the code that runs as the module loads: its top-level statements, the initialisers of its
//   classes' static fields and static blocks, and the bodies of functions called where they are
//   written. A function's body, a method or an instance field's initialiser runs later and is not
//   read. A name counts unless it is a property's name (`x.document`, `{ window: ... }`) or the file
//   declares it at its top level; type positions are not code and pass.
//
// Output: a line per entry point, then the failures.
//
// GPU lock and browser: neither. Cost: about a second, CPU only.
//
// Exit codes: 0 everything passes; 1 a failure (listed) or an unknown option.
import '../kit/help.mjs';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { ROOT } from '../kit/root.mjs';

const SRC = ROOT;
const { entryPoints } = JSON.parse( readFileSync( path.join( ROOT, 'tools', 'repo', 'layers.json' ), 'utf8' ) );

// The page's globals a module must not read as it loads: the address, the storage, the document,
// window, the browser's description, the frame callbacks, workers, IndexedDB and fetch.
const PAGE = new Set( [ 'location', 'localStorage', 'sessionStorage', 'document', 'window', 'navigator', 'requestAnimationFrame', 'cancelAnimationFrame', 'Worker', 'indexedDB', 'fetch' ] );

for ( const a of process.argv.slice( 2 ) ) {

	console.error( `verify-entry-points: unknown option '${ a }'` );
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

/** The value names an entry re-exports (`export { a, b as c } from`, not `export type`). */
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
for ( const [ pkg, sides ] of Object.entries( entryPoints ) ) for ( const [ side, entry ] of Object.entries( sides ) ) {

	// a headless or setup entry point, loaded in plain node
	if ( side !== 'main' ) try {

		const module = await import( pathToFileURL( path.join( SRC, entry ) ).href );
		const missing = valueNames( entry ).filter( ( name ) => module[ name ] === undefined );
		for ( const name of missing ) failures.push( `${ entry }: \`${ name }\` is undefined once loaded in node` );
		lines.push( `${ pkg }: ${ entry } loads in node (${ Object.keys( module ).length } values)` );

	} catch ( e ) {

		failures.push( `${ entry }: does not load in plain node: ${ e.message.split( '\n' )[ 0 ] }` );

	}

	// a main or setup entry point, read
	if ( side === 'headless' ) continue;
	const files = loadClosure( entry );
	for ( const file of files ) {

		if ( read.has( file ) ) continue;
		read.add( file );
		failures.push( ...atLoad( file ) );

	}
	lines.push( `${ pkg }: ${ entry } loads ${ files.size } files, none awaits or reads the page at load` );

}

for ( const line of lines ) console.log( `verify-entry-points: ${ line }` );
if ( failures.length ) {

	console.log( `FAIL (${ failures.length })` );
	for ( const f of failures ) console.log( `  ${ f }` );
	process.exit( 1 );

}
console.log( 'PASS' );
