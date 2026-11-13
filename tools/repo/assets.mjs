// The game's assets: every binary file the page loads (textures, models, fonts, baked data). None
// goes into git: a repository that keeps every version of every texture only grows, and its
// history cannot be cut back without rewriting it. They live in public/ (git-ignored; Vite serves
// it at the site's root and copies it into dist/), and each version of the whole set is published
// as one archive on a GitHub release, `assets-v<N>`. assets.lock.json, committed, pins the release,
// its archive and every file's size and SHA-256, so each commit names the assets it runs with and
// a checkout of it gets exactly those back (the byte-for-byte checks compare commits).
//   node tools/repo/assets.mjs [status]        public/ against the lock: missing, changed and unlisted
//                                         files (exit 0 when it matches, 1 when not)
//   node tools/repo/assets.mjs pull [--force]  fills public/ from the lock's release; a file that differs
//                                         from the lock is work in progress and is kept, unless
//                                         --force
//   node tools/repo/assets.mjs release [--notes <text>] [--attach <file>]... [--local]
//                                         packs public/ as the next release, publishes it with gh
//                                         and rewrites the lock; --attach uploads more files beside
//                                         the archive (masters of our own, such as a Blender file);
//                                         --local packs it into the cache and rewrites the lock but
//                                         uploads nothing (gh not needed)
//   node tools/repo/assets.mjs publish [--attach <file>]...
//                                         uploads the lock's release packed with --local, from this
//                                         machine's cache, as it was packed (the lock stays valid)
// Rules:
// - A published release never changes: adding, changing or removing a file cuts the next one, and
//   the lock moves in the same commit as the code that needs it.
// - The archive holds the whole set, so one release is one version of the game's assets.
// - A new release takes the first number past the lock's that this machine's cache does not hold:
//   another branch may have packed the lock's successor already, its lock not merged here yet.
// - A release packed with --local exists only in this machine's cache until it is published: a
//   checkout elsewhere cannot pull it, and the cache's archive must be kept until then.
// - Downloads are cached in git's common directory (ponlai-assets/<release>/), shared by every
//   worktree and never tracked; each worktree gets its own copy of the files (a clone where the
//   file system can).
// - gh downloads from the repository while it is private; without gh, the release's public URL.
// The dev server and the build call `ensureAssets` (tools/repo/vite-assets.mjs): missing files are
// pulled, changed and unlisted ones only reported.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCK = 'assets.lock.json';
const PUBLIC = 'public';
const TAG = /^assets-v(\d+)$/;

const sha256 = ( path ) => createHash( 'sha256' ).update( readFileSync( path ) ).digest( 'hex' );

/** The files under `dir`, as sorted paths with forward slashes; dot files (.DS_Store) are skipped. */
function listFiles( dir ) {

	const out = [];
	const walk = ( at ) => {

		for ( const entry of readdirSync( at, { withFileTypes: true } ) ) {

			if ( entry.name.startsWith( '.' ) ) continue;
			const path = join( at, entry.name );
			if ( entry.isDirectory() ) walk( path );
			else if ( entry.isFile() ) out.push( relative( dir, path ).split( sep ).join( '/' ) );

		}

	};
	if ( existsSync( dir ) ) walk( dir );
	return out.sort();

}

export function readLock( root ) {

	const path = join( root, LOCK );
	return existsSync( path ) ? JSON.parse( readFileSync( path, 'utf8' ) ) : null;

}

/** public/ against the lock: the files it lacks, those whose content differs, and those it does not list. */
export function assetStatus( root, lock = readLock( root ) ) {

	const dir = join( root, PUBLIC );
	const listed = lock ? lock.files : {};
	const missing = [], changed = [];
	for ( const [ name, want ] of Object.entries( listed ) ) {

		const path = join( dir, name );
		if ( ! existsSync( path ) ) missing.push( name );
		else if ( statSync( path ).size !== want.size || sha256( path ) !== want.sha256 ) changed.push( name );

	}

	const unlisted = listFiles( dir ).filter( ( name ) => ! ( name in listed ) );
	return { missing, changed, unlisted };

}

/** Where downloads and packed archives are kept: git's common directory, shared by the worktrees. */
function cacheRoot( root ) {

	try {

		const common = execFileSync( 'git', [ 'rev-parse', '--path-format=absolute', '--git-common-dir' ], { cwd: root, encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'ignore' ] } ).trim();
		return join( common, 'ponlai-assets' );

	} catch {

		// not a git checkout (an unpacked source archive)
		return join( root, 'node_modules', '.cache', 'ponlai-assets' );

	}

}

function hasGh() {

	try {

		execFileSync( 'gh', [ '--version' ], { stdio: 'ignore' } );
		return true;

	} catch {

		return false;

	}

}

/** The lock's archive, downloaded once into the cache and checked against its size and hash. */
async function fetchArchive( root, lock ) {

	const dir = join( cacheRoot( root ), lock.release );
	const path = join( dir, lock.archive.name );
	const good = () => existsSync( path ) && statSync( path ).size === lock.archive.size && sha256( path ) === lock.archive.sha256;
	if ( good() ) return path;

	mkdirSync( dir, { recursive: true } );
	rmSync( path, { force: true } );
	if ( hasGh() ) {

		execFileSync( 'gh', [ 'release', 'download', lock.release, '--repo', lock.repo, '--pattern', lock.archive.name, '--dir', dir, '--clobber' ], { stdio: [ 'ignore', 'ignore', 'inherit' ] } );

	} else {

		const url = `https://github.com/${ lock.repo }/releases/download/${ lock.release }/${ lock.archive.name }`;
		const response = await fetch( url );
		if ( ! response.ok ) throw new Error( `${ url }: ${ response.status } ${ response.statusText }` );
		writeFileSync( path, Buffer.from( await response.arrayBuffer() ) );

	}

	if ( ! good() ) throw new Error( `${ lock.archive.name } from ${ lock.release } does not match assets.lock.json` );
	return path;

}

/** The release's files, unpacked once beside its archive. */
async function unpacked( root, lock ) {

	const archive = await fetchArchive( root, lock );
	const dir = join( dirname( archive ), 'files' );
	if ( existsSync( join( dir, '.complete' ) ) ) return dir;

	const partial = dir + '.partial';
	rmSync( partial, { recursive: true, force: true } );
	mkdirSync( partial, { recursive: true } );
	execFileSync( 'tar', [ '-xzf', archive, '-C', partial ], { stdio: 'inherit' } );
	writeFileSync( join( partial, '.complete' ), '' );
	rmSync( dir, { recursive: true, force: true } );
	renameSync( partial, dir );
	return dir;

}

/** Copies the lock's files into public/: the missing ones, and with `force` the changed ones too. */
export async function pullAssets( root, { force = false } = {} ) {

	const lock = readLock( root );
	if ( lock === null ) throw new Error( `no ${ LOCK } in ${ root }` );
	const status = assetStatus( root, lock );
	const wanted = force ? [ ...status.missing, ...status.changed ] : status.missing;
	if ( wanted.length > 0 ) {

		const from = await unpacked( root, lock );
		for ( const name of wanted ) {

			const source = join( from, name );
			if ( ! existsSync( source ) || sha256( source ) !== lock.files[ name ].sha256 ) throw new Error( `${ name } in ${ lock.release } does not match assets.lock.json` );
			const target = join( root, PUBLIC, name );
			mkdirSync( dirname( target ), { recursive: true } );
			rmSync( target, { force: true } );
			copyFileSync( source, target, constants.COPYFILE_FICLONE );

		}

	}

	return { release: lock.release, copied: wanted, kept: force ? [] : status.changed, unlisted: status.unlisted };

}

/** For the dev server and the build: pulls what public/ lacks and reports what differs. Returns how
 * many listed files are still missing. */
export async function ensureAssets( root, logger ) {

	const lock = readLock( root );
	if ( lock === null ) return 0;
	let result;
	try {

		result = await pullAssets( root );

	} catch ( error ) {

		const { missing } = assetStatus( root, lock );
		logger.error( `ponlai-assets: could not pull ${ missing.length } file(s) of ${ lock.release }: ${ error.message }` );
		return missing.length;

	}

	if ( result.copied.length > 0 ) logger.info( `ponlai-assets: pulled ${ result.copied.length } file(s) of ${ lock.release } into public/` );
	const differ = [ ...result.kept.map( ( n ) => `changed ${ n }` ), ...result.unlisted.map( ( n ) => `unlisted ${ n }` ) ];
	if ( differ.length > 0 ) logger.warn( `ponlai-assets: public/ differs from ${ LOCK } (${ lock.release }): ${ differ.join( ', ' ) }. Cut a release when they are done (node tools/repo/assets.mjs release).` );
	return 0;

}

/** The GitHub repository the first release goes to: origin's. */
function originRepo( root ) {

	const url = execFileSync( 'git', [ 'remote', 'get-url', 'origin' ], { cwd: root, encoding: 'utf8' } ).trim();
	const match = url.match( /github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/ );
	if ( ! match ) throw new Error( `origin (${ url }) is not a GitHub repository` );
	return match[ 1 ];

}

const needGh = () => {

	if ( ! hasGh() ) throw new Error( 'a release is published with gh (https://cli.github.com), which is not installed' );

};

/** Uploads a packed release from the cache: its archive, its notes and `attach`. */
function upload( root, lock, attach ) {

	const dir = join( cacheRoot( root ), lock.release );
	const archive = join( dir, lock.archive.name );
	const version = lock.release.match( TAG )[ 1 ];
	execFileSync( 'gh', [ 'release', 'create', lock.release, archive, ...attach, '--repo', lock.repo, '--title', `Assets v${ version }`, '--notes-file', join( dir, 'notes.md' ) ], { stdio: 'inherit' } );

}

/** Packs public/ as the next release, writes the lock and, unless `local`, publishes it. */
export function releaseAssets( root, { notes = '', attach = [], local = false } = {} ) {

	if ( local && attach.length > 0 ) throw new Error( '--attach goes with publish, not with --local' );
	if ( ! local ) needGh();
	const old = readLock( root );
	const names = listFiles( join( root, PUBLIC ) );
	if ( names.length === 0 ) throw new Error( 'public/ is empty' );

	const files = {};
	for ( const name of names ) {

		const path = join( root, PUBLIC, name );
		files[ name ] = { size: statSync( path ).size, sha256: sha256( path ) };

	}

	const before = old ? old.files : {};
	const added = names.filter( ( n ) => ! ( n in before ) );
	const changed = names.filter( ( n ) => n in before && before[ n ].sha256 !== files[ n ].sha256 );
	const removed = Object.keys( before ).filter( ( n ) => ! ( n in files ) );
	if ( old && added.length + changed.length + removed.length === 0 ) throw new Error( `public/ matches ${ old.release }: nothing to release` );

	let version = old ? Number( old.release.match( TAG )[ 1 ] ) + 1 : 1;
	while ( existsSync( join( cacheRoot( root ), `assets-v${ version }` ) ) ) version ++;
	const release = `assets-v${ version }`;
	const repo = old ? old.repo : originRepo( root );
	const dir = join( cacheRoot( root ), release );
	const archive = join( dir, `ponlai-assets-v${ version }.tar.gz` );
	mkdirSync( dir, { recursive: true } );
	const list = join( dir, 'files.txt' );
	writeFileSync( list, names.join( '\n' ) + '\n' );
	// macOS's tar would add an AppleDouble file (._name) and extended attributes for every file,
	// which other systems' tar warn about
	const mac = process.platform === 'darwin' ? [ '--no-mac-metadata', '--no-xattrs' ] : [];
	execFileSync( 'tar', [ '-czf', archive, ...mac, '-C', join( root, PUBLIC ), '-T', list ], { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } } );

	const lines = ( title, list ) => list.length ? [ `${ title }:`, ...list.map( ( n ) => `- ${ n }` ), '' ] : [];
	const body = [
		...( notes ? [ notes, '' ] : [] ),
		`The game's assets, version ${ version }: unpack into public/, or let the dev server and the build pull them (tools/repo/assets.mjs). Third-party files and their licences are listed in CREDITS.md.`,
		'',
		...lines( 'Added', added ), ...lines( 'Changed', changed ), ...lines( 'Removed', removed ),
	].join( '\n' );
	writeFileSync( join( dir, 'notes.md' ), body );

	const lock = { repo, release, archive: { name: `ponlai-assets-v${ version }.tar.gz`, size: statSync( archive ).size, sha256: sha256( archive ) }, files };
	if ( ! local ) upload( root, lock, attach );
	writeFileSync( join( root, LOCK ), JSON.stringify( lock, null, '\t' ) + '\n' );
	return { release, added, changed, removed };

}

/** Publishes the lock's release, packed earlier with --local. */
export function publishAssets( root, { attach = [] } = {} ) {

	needGh();
	const lock = readLock( root );
	if ( lock === null ) throw new Error( `no ${ LOCK } in ${ root }` );
	const dir = join( cacheRoot( root ), lock.release );
	const archive = join( dir, lock.archive.name );
	if ( ! existsSync( archive ) || statSync( archive ).size !== lock.archive.size || sha256( archive ) !== lock.archive.sha256 ) throw new Error( `${ lock.archive.name } in the cache does not match assets.lock.json: ${ lock.release } was not packed on this machine` );
	if ( ! existsSync( join( dir, 'notes.md' ) ) ) writeFileSync( join( dir, 'notes.md' ), `The game's assets, version ${ lock.release.match( TAG )[ 1 ] } (tools/repo/assets.mjs).` );
	upload( root, lock, attach );
	return lock.release;

}

async function main() {

	const args = process.argv.slice( 2 );
	const command = args[ 0 ] && ! args[ 0 ].startsWith( '--' ) ? args.shift() : 'status';
	const options = { force: false, notes: '', attach: [], local: false };
	for ( let i = 0; i < args.length; i ++ ) {

		const arg = args[ i ];
		if ( arg === '--force' && command === 'pull' ) options.force = true;
		else if ( arg === '--notes' && command === 'release' ) options.notes = args[ ++ i ] ?? '';
		else if ( arg === '--attach' && ( command === 'release' || command === 'publish' ) ) options.attach.push( resolve( args[ ++ i ] ?? '' ) );
		else if ( arg === '--local' && command === 'release' ) options.local = true;
		else throw new Error( `unknown option for ${ command }: ${ arg }` );

	}

	const root = execFileSync( 'git', [ 'rev-parse', '--show-toplevel' ], { encoding: 'utf8' } ).trim();
	if ( command === 'status' ) {

		const lock = readLock( root );
		const { missing, changed, unlisted } = assetStatus( root, lock );
		for ( const name of missing ) console.log( `missing   ${ name }` );
		for ( const name of changed ) console.log( `changed   ${ name }` );
		for ( const name of unlisted ) console.log( `unlisted  ${ name }` );
		const count = lock ? Object.keys( lock.files ).length : 0;
		const clean = missing.length + changed.length + unlisted.length === 0;
		console.log( lock ? `public/ ${ clean ? 'matches' : 'differs from' } ${ lock.release } (${ count } files)` : `no ${ LOCK }` );
		process.exit( clean && lock ? 0 : 1 );

	} else if ( command === 'pull' ) {

		const result = await pullAssets( root, options );
		console.log( `${ result.release }: copied ${ result.copied.length } file(s)` );
		for ( const name of result.kept ) console.log( `kept (differs from the lock; --force replaces it)  ${ name }` );
		for ( const name of result.unlisted ) console.log( `unlisted  ${ name }` );

	} else if ( command === 'release' ) {

		const { release, added, changed, removed } = releaseAssets( root, options );
		console.log( `${ release }${ options.local ? ' (packed, not published)' : '' }: ${ added.length } added, ${ changed.length } changed, ${ removed.length } removed; commit ${ LOCK } with the change that needs it` );

	} else if ( command === 'publish' ) {

		console.log( `${ publishAssets( root, options ) }: published` );

	} else {

		throw new Error( `unknown command: ${ command }` );

	}

}

if ( process.argv[ 1 ] && resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url ) ) {

	main().catch( ( error ) => {

		console.error( error.message );
		process.exit( 1 );

	} );

}
