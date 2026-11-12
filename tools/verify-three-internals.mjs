// Checks what the code depends on of three.js beyond its public interface, against the three that
// is installed. CPU only, no GPU and no browser: it reads three's sources and imports three in
// node, a few seconds.
//   node tools/verify-three-internals.mjs [--verbose] [--fingerprints]
//
// The renderer reaches into three where no public path gives what it needs: private members of the
// renderer and of its helpers, the WebGPU backend and its device, methods it replaces or wraps,
// and code of three's it mirrors. Those reaches cannot be removed without changing the image, so
// they are listed and checked, and an upgrade of three finds every one of them at once.
// `src/three/three-internals.json` is that list: for each entry, the file of three it lives in (under
// node_modules/three), its class (`owner`), its name, what it is there (`kind`), how we use it
// (`use`) and which of our files use it (`users`). Its categories: 1, three's private members and
// the code we replace or mirror; 2, the backend and the device; 3, the extension hooks three
// leaves for materials, lighting models, shadows and inspectors, which @types/three does not
// declare (they are its interface, listed so that an upgrade sees one go).
//
// Three checks, each a failure (exit 1) when broken:
// - Version. three and @types/three installed are the versions the list was checked against, and
//   three's REVISION is the list's, and package.json pins both to exact versions (no ^ or ~).
// - Shape. Every entry holds in the installed three: a `method` (a method, getter or setter) is
//   declared in its class, and, where the class is exported (from three/webgpu, or the entry's
//   `module`), is on its prototype at run time; a `member` is assigned in its class
//   (`this.<name> =`, a constructor's or a method's); a `declaration` is a top-level function,
//   class or variable of its file; a `text` entry's `text` occurs in its file (a field three sets
//   on a data record, a key of a lighting context). An entry we replace, wrap, mirror or rely on
//   (`use`: replace, wrap, mirror, relies) carries a fingerprint of its source text: when three
//   changes the function, our patch, wrapper or copy is read again against the new code and the
//   fingerprint updated (`--fingerprints` prints the current ones).
// - Location. No file under src/ outside src/three/ reaches into three: no `.backend`, no cast to
//   a structural type with a member whose name starts with an underscore, and no name of a
//   category 1 or 2 entry that starts with one (comments are not read). The files that did when
//   the check was written are listed in SRC_KNOWN; the list only shrinks: a listed file that no
//   longer reaches in fails, so the entry is removed with the change that moves its reach.
//   tools/ is white-box (its tools run scripts in the page) and keeps a list of its own,
//   TOOLS_KNOWN, which only shrinks too.
//
// Output: a summary on stdout, warnings and failures listed; `--verbose` prints where each entry
// was found, `--fingerprints` every fingerprinted entry's current fingerprint. Exit 0 when
// everything passes (warnings included), 1 with the failures listed.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const THREE = path.join( ROOT, 'node_modules', 'three' );
const LIST = path.join( ROOT, 'src', 'three', 'three-internals.json' );
const SELF = path.relative( ROOT, fileURLToPath( import.meta.url ) );

// Whether a three or @types/three not pinned to an exact version in package.json fails the check
// or is only reported.
const UNPINNED_FAILS = true;

// how an entry is used; the ones whose source text is fingerprinted
const USES = [ 'read', 'call', 'write', 'hook', 'replace', 'wrap', 'mirror', 'relies' ];
const FINGERPRINTED = new Set( [ 'replace', 'wrap', 'mirror', 'relies' ] );
const KINDS = [ 'method', 'member', 'declaration', 'text' ];

// The files under src/ that reach into three, outside src/three/ (paths under src/). Remove an
// entry with the change that moves its reach; never add one.
const SRC_KNOWN = [
	'debug/AmbientProbe.ts',
	'debug/FrameProfiler.ts',
	'debug/PipelineCounter.ts',
	'lighting/SunShadow.ts',
	'main.ts',
	'materials/CloudNoise.ts',
	'post/DynamicResolution.ts',
	'post/Pipeline.ts',
	'post/graph/AttachmentOps.ts',
	'post/graph/Compile.ts',
	'post/graph/FrameGraph.ts',
	'sky/Sky.ts',
	'world/Upload.ts',
	'world/WorldFields.ts',
	'world/vegetation/VegetationCull.ts',
];

// The tools that reach into three (paths under tools/). Remove an entry with the change that
// removes its reach; never add one.
const TOOLS_KNOWN = [
	'dusk-grid.mjs',
	// a mock renderer with the members graph/Compile.ts builds through
	'framegraph/tables-warm.mjs',
	'pipeline-trace.mjs',
	'profile-frame.mjs',
	'verify-frame-graph-gpu.mjs',
	'verify-storage-realloc.mjs',
	'wgsl-build.mjs',
];

const options = { verbose: false, fingerprints: false };
for ( const a of process.argv.slice( 2 ) ) {

	if ( a === '--verbose' ) options.verbose = true;
	else if ( a === '--fingerprints' ) options.fingerprints = true;
	else {

		console.error( `verify-three-internals: unknown option '${ a }'` );
		process.exit( 1 );

	}

}

const failures = [], warnings = [];
const list = JSON.parse( readFileSync( LIST, 'utf8' ) );
const json = ( file ) => JSON.parse( readFileSync( file, 'utf8' ) );

// ---- version

const pkg = json( path.join( ROOT, 'package.json' ) );
const wanted = { three: pkg.dependencies?.three, '@types/three': pkg.devDependencies?.[ '@types/three' ] };
const listed = { three: list.three, '@types/three': list.types };
for ( const [ name, spec ] of Object.entries( wanted ) ) {

	const installedFile = path.join( ROOT, 'node_modules', name, 'package.json' );
	const installed = existsSync( installedFile ) ? json( installedFile ).version : null;
	if ( installed !== listed[ name ] ) failures.push( `version: ${ name } installed is ${ installed ?? 'missing' }, the list was checked against ${ listed[ name ] }` );
	if ( ! /^\d+\.\d+\.\d+$/.test( spec ?? '' ) ) {

		( UNPINNED_FAILS ? failures : warnings ).push( `version: package.json asks for ${ name } '${ spec }', not one exact version` );

	} else if ( spec !== listed[ name ] ) failures.push( `version: package.json pins ${ name } ${ spec }, the list was checked against ${ listed[ name ] }` );

}
const webgpu = await import( 'three/webgpu' );
if ( webgpu.REVISION !== list.revision ) failures.push( `version: three's REVISION is ${ webgpu.REVISION }, the list's is ${ list.revision }` );

// ---- shape

const sources = new Map();
function source( file ) {

	let sf = sources.get( file );
	if ( sf === undefined ) {

		const full = path.join( THREE, file );
		sf = existsSync( full ) ? ts.createSourceFile( full, readFileSync( full, 'utf8' ), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS ) : null;
		sources.set( file, sf );

	}
	return sf;

}

const nameOf = ( node ) => node.name && ( ts.isIdentifier( node.name ) || ts.isPrivateIdentifier( node.name ) || ts.isStringLiteral( node.name ) ) ? node.name.text : undefined;

function findClass( sf, owner ) {

	let found = null;
	const visit = ( node ) => {

		if ( found ) return;
		if ( ( ts.isClassDeclaration( node ) || ts.isClassExpression( node ) ) && node.name?.text === owner ) found = node;
		else ts.forEachChild( node, visit );

	};
	visit( sf );
	return found;

}

// the node an entry names, or null
function locate( sf, entry ) {

	if ( entry.kind === 'declaration' ) {

		for ( const statement of sf.statements ) {

			if ( ( ts.isFunctionDeclaration( statement ) || ts.isClassDeclaration( statement ) ) && statement.name?.text === entry.name ) return statement;
			if ( ts.isVariableStatement( statement ) ) {

				const d = statement.declarationList.declarations.find( ( v ) => ts.isIdentifier( v.name ) && v.name.text === entry.name );
				if ( d ) return d;

			}

		}
		return null;

	}
	const cls = findClass( sf, entry.owner );
	if ( ! cls ) return undefined;
	if ( entry.kind === 'method' ) {

		return cls.members.find( ( m ) => ( ts.isMethodDeclaration( m ) || ts.isGetAccessorDeclaration( m ) || ts.isSetAccessorDeclaration( m ) ) && nameOf( m ) === entry.name ) ?? null;

	}
	// a member: a field declared in the class, or `this.<name> =` anywhere in its body
	const field = cls.members.find( ( m ) => ts.isPropertyDeclaration( m ) && nameOf( m ) === entry.name );
	if ( field ) return field;
	let found = null;
	const visit = ( node ) => {

		if ( found ) return;
		if ( ts.isBinaryExpression( node ) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression( node.left )
			&& node.left.expression.kind === ts.SyntaxKind.ThisKeyword && node.left.name.text === entry.name ) found = node;
		else ts.forEachChild( node, visit );

	};
	visit( cls );
	return found;

}

const fingerprint = ( sf, node ) => createHash( 'sha256' ).update( node.getText( sf ) ).digest( 'hex' ).slice( 0, 16 );
const lineOf = ( sf, pos ) => sf.getLineAndCharacterOfPosition( pos ).line + 1;
const modules = new Map( [ [ 'three/webgpu', webgpu ] ] );

const ids = new Set();
const privateNames = new Set();
const current = [];
for ( const entry of list.entries ) {

	const label = `${ entry.id } (${ entry.file }; used by ${ ( entry.users ?? [] ).join( ', ' ) || 'nobody' })`;
	if ( ids.has( entry.id ) ) failures.push( `list: ${ entry.id } is listed twice` );
	ids.add( entry.id );
	if ( ! KINDS.includes( entry.kind ) ) failures.push( `list: ${ entry.id } has an unknown kind '${ entry.kind }'` );
	if ( ! USES.includes( entry.use ) ) failures.push( `list: ${ entry.id } has an unknown use '${ entry.use }'` );
	if ( ! [ 1, 2, 3 ].includes( entry.category ) ) failures.push( `list: ${ entry.id } has an unknown category '${ entry.category }'` );
	if ( ( entry.kind === 'method' || entry.kind === 'member' ) && ! entry.owner ) failures.push( `list: ${ entry.id } names no owner class` );
	if ( entry.category !== 3 && entry.name.startsWith( '_' ) ) privateNames.add( entry.name );
	const sf = source( entry.file );
	if ( ! sf ) {

		failures.push( `shape: ${ label }: the file is not in three` );
		continue;

	}
	let where;
	if ( entry.kind === 'text' ) {

		const at = sf.text.indexOf( entry.text );
		if ( at < 0 ) {

			failures.push( `shape: ${ label }: '${ entry.text }' is no longer in the file` );
			continue;

		}
		where = `${ entry.file }:${ lineOf( sf, at ) }`;

	} else {

		const node = locate( sf, entry );
		if ( node === undefined ) {

			failures.push( `shape: ${ label }: no class ${ entry.owner } in the file` );
			continue;

		}
		if ( node === null ) {

			const what = { method: `no method ${ entry.owner }.${ entry.name }`, member: `${ entry.owner } assigns no member ${ entry.name }`, declaration: `no top-level ${ entry.name }` }[ entry.kind ];
			failures.push( `shape: ${ label }: ${ what }` );
			continue;

		}
		where = `${ entry.file }:${ lineOf( sf, node.getStart( sf ) ) }`;
		if ( FINGERPRINTED.has( entry.use ) || entry.fingerprint ) {

			const now = fingerprint( sf, node );
			current.push( [ entry.id, now ] );
			if ( ! entry.fingerprint ) failures.push( `shape: ${ label }: no fingerprint recorded (now ${ now })` );
			else if ( entry.fingerprint !== now ) failures.push( `shape: ${ label }: its source changed (fingerprint ${ entry.fingerprint }, now ${ now }): read it again against our ${ entry.use === 'replace' ? 'patch' : entry.use === 'wrap' ? 'wrapper' : 'copy' }, then update the fingerprint` );

		}
		if ( entry.kind === 'method' ) {

			// on the prototype at run time, where the class is exported
			const specifier = entry.module ?? 'three/webgpu';
			if ( ! modules.has( specifier ) ) modules.set( specifier, await import( specifier ) );
			const mod = modules.get( specifier );
			const Owner = mod[ entry.owner ] ?? ( mod.default?.name === entry.owner ? mod.default : undefined );
			if ( typeof Owner === 'function' && ! ( entry.name in Owner.prototype ) && ! ( entry.name in Owner ) ) {

				failures.push( `shape: ${ label }: declared at ${ where }, but not on ${ entry.owner }'s prototype at run time` );

			}

		}

	}
	if ( options.verbose ) console.log( `  ${ entry.id.padEnd( 44 ) } ${ entry.kind.padEnd( 11 ) } ${ entry.use.padEnd( 7 ) } ${ where }` );

}
if ( options.fingerprints ) for ( const [ id, now ] of current ) console.log( `  fingerprint ${ id } ${ now }` );

// ---- location

const CODE = /\.(ts|mts|js|mjs)$/;
function walk( dir, out = [] ) {

	for ( const name of readdirSync( dir ) ) {

		const p = path.join( dir, name );
		if ( statSync( p ).isDirectory() ) walk( p, out );
		else if ( CODE.test( name ) && ! name.endsWith( '.d.ts' ) && ! name.endsWith( '.d.mts' ) ) out.push( p );

	}
	return out;

}

// the file's text with its comments blanked (lines kept)
function code( file ) {

	const text = readFileSync( file, 'utf8' );
	const kind = /\.m?js$/.test( file ) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
	const sf = ts.createSourceFile( file, text, ts.ScriptTarget.Latest, true, kind );
	const chars = text.split( '' ), seen = new Set();
	const blank = ( ranges ) => {

		for ( const r of ranges ?? [] ) {

			if ( seen.has( r.pos ) ) continue;
			seen.add( r.pos );
			for ( let i = r.pos; i < r.end; i ++ ) if ( chars[ i ] !== '\n' ) chars[ i ] = ' ';

		}

	};
	const visit = ( node ) => {

		blank( ts.getLeadingCommentRanges( text, node.pos ) );
		blank( ts.getTrailingCommentRanges( text, node.end ) );
		for ( const child of node.getChildren( sf ) ) visit( child );

	};
	visit( sf );
	return chars.join( '' );

}

const escape = ( s ) => s.replace( /[$]/g, '\\$&' );
const REACHES = [
	[ 'backend', /\.\s*backend(?![\w$])/ ],
	// `as { _x: ... }`, `as unknown as { ...; _x(): ... }`, one level of nested braces
	[ 'private cast', /\bas\s+(?:unknown\s+as\s+)?(?:\w+\s*&\s*)?\{(?:[^{}]|\{[^{}]*\})*?(?<![\w$])_[A-Za-z]\w*\s*\??\s*[:(]/ ],
	[ 'private name', new RegExp( `(?<![\\w$])(?:${ [ ...privateNames ].map( escape ).join( '|' ) })(?![\\w$])` ) ],
];
function reaches( file ) {

	const text = code( file );
	const found = [];
	for ( const [ what, pattern ] of REACHES ) {

		const m = pattern.exec( text );
		if ( m ) found.push( `${ what } at line ${ text.slice( 0, m.index ).split( '\n' ).length }` );

	}
	return found;

}

function checkPlace( dir, known, skip, listName, remedy ) {

	const base = path.join( ROOT, dir );
	const seen = new Map();
	for ( const file of walk( base ) ) {

		const rel = path.relative( base, file ).split( path.sep ).join( '/' );
		if ( skip( rel ) ) continue;
		const found = reaches( file );
		if ( found.length ) seen.set( rel, found );

	}
	const knownSet = new Set( known );
	for ( const [ rel, found ] of seen ) {

		if ( ! knownSet.has( rel ) ) failures.push( `location: ${ dir }/${ rel } reaches into three (${ found.join( ', ' ) }): ${ remedy }` );

	}
	for ( const rel of known ) if ( ! seen.has( rel ) ) failures.push( `location: ${ listName } lists ${ rel }, which no longer reaches into three: remove the entry` );
	return seen;

}
const inSrc = checkPlace( 'src', SRC_KNOWN, ( rel ) => rel.startsWith( 'three/' ), 'SRC_KNOWN', 'reach it through a function of src/three/' );
const inTools = checkPlace( 'tools', TOOLS_KNOWN, ( rel ) => `tools/${ rel }` === SELF, 'TOOLS_KNOWN', 'drive the page through its debug objects, or call a function of src/three/' );
if ( options.verbose ) for ( const [ dir, seen ] of [ [ 'src', inSrc ], [ 'tools', inTools ] ] ) for ( const [ rel, found ] of seen ) console.log( `  reach ${ dir }/${ rel }: ${ found.join( ', ' ) }` );

// ---- summary

const byCategory = [ 1, 2, 3 ].map( ( c ) => list.entries.filter( ( e ) => e.category === c ).length );
console.log( `verify-three-internals: three ${ list.three } (r${ list.revision }), ${ list.entries.length } entries (${ byCategory.join( ' / ' ) } by category), ${ current.length } fingerprinted; reaches in ${ inSrc.size } src files (${ SRC_KNOWN.length } known), ${ inTools.size } tools (${ TOOLS_KNOWN.length } known)` );
for ( const w of warnings ) console.log( `  warning ${ w }` );
if ( failures.length ) {

	console.log( `FAIL (${ failures.length })` );
	for ( const f of failures ) console.log( `  ${ f }` );
	process.exit( 1 );

}
console.log( 'PASS' );
