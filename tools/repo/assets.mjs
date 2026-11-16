// Keeps public/ in step with the assets a commit pins, and publishes a new version of them.
//
// Every binary file the page loads (textures, models, fonts, audio, baked data) is an asset, and no
// asset goes into git: a repository that keeps every version of every binary only grows, and its
// history cannot be cut back without rewriting it. The assets live in public/, git-ignored, which
// Vite serves at the site's root and copies into dist/. Each version of the whole set is published
// as one archive (`ponlai-assets-<version>.tar.gz`) on a GitHub release tagged `assets-<version>`,
// the version the UTC date it was packed on (`2026.11.16`, a second that day `2026.11.16.2`).
// assets.lock.json, committed, pins the release, the archive's size and SHA-256 and every file's,
// so a commit names the assets it runs with and a checkout of it gets exactly those back (the
// byte-for-byte checks compare commits). Use it to see whether public/ matches the lock, to fill
// it, and to cut a release; tools/verify-no-binaries.mjs is the check that keeps assets out of git.
//
// Usage:
//   node tools/repo/assets.mjs [status]
//   node tools/repo/assets.mjs pull [--force]
//   node tools/repo/assets.mjs release [--notes <text>] [--attach <file>]... [--local]
//   node tools/repo/assets.mjs publish [--attach <file>]...
//
// Options:
//   status             public/ against the lock: missing, changed and unlisted files (the default)
//   pull               fills public/ from the lock's release; a file that differs from the lock is
//                      work in progress and is kept and named
//     --force          also replaces the files that differ from the lock
//   release            packs the whole of public/ as the next release, creates it with gh (its
//                      notes list what was added, changed and removed) and rewrites the lock
//     --notes <text>   a paragraph put first in the release's notes
//     --attach <file>  uploads a file beside the archive; repeatable; not with --local
//     --local          packs the release into the cache and rewrites the lock, uploading nothing
//                      (gh not needed)
//   publish            uploads the lock's release, packed earlier with --local, from the cache as
//                      it was packed, so the committed lock stays valid
//     --attach <file>  as for release
//
// The dev server and the build pull the files public/ lacks before they read it
// (tools/repo/vite-assets.mjs `ensureAssets`; its header says what each does without them).
// Downloads go through gh while the repository is private, else the release's public URL. They are
// kept in git's common directory (`ponlai-assets/<release>/`, shared by every worktree, never
// tracked), checked against the lock's size and hash, unpacked once there and copied into each
// checkout's public/ (a clone where the file system can).
//
// A release packed with --local exists on this machine only until it is published: its cache must
// be kept, and a checkout elsewhere cannot pull it. A release takes the first version of the day
// that neither the lock nor the cache holds, so a branch packing from an older lock never
// overwrites another branch's pack (the two locks then merge by hand: the later release repacked
// over both sets of changes). Locks that name `assets-v<N>` come from before the first published
// release: no release holds those sets, so the commits that carry them pull nothing, and `release`
// packs public/ again over such a lock even when nothing changed.
//
// Rules:
// - A file the page loads is placed under public/ and loaded through
//   `import.meta.env.BASE_URL + '<path under public/>'` (a stylesheet: `url( '/<path>' )`, which
//   Vite rewrites for the base), never from `artifacts/` or another machine path.
// - Adding, changing or removing an asset cuts the next release; a published release never changes
//   (a broken one is followed by the next, never replaced). The commit that needs the new files
//   carries the new assets.lock.json, so every commit still builds with its own assets.
// - The archive holds the whole set, so one release is one version of the assets.
// - A release holds only files that may be redistributed: every third-party source is credited in
//   CREDITS.md (title, author, source, licence) with its path in public/ before it ships.
// - A file made by a tool from a source (the moon, the stars, the Milky Way) keeps its tool in
//   tools/, whose header says how it is made; the release holds the output.
// - Masters of our own that the page does not load (Blender files, layered images) go beside the
//   archive with --attach, on the release whose files they were exported for. Third-party sources
//   stay with their publisher; CREDITS.md links them.
//
// Output: status prints a line per missing, changed and unlisted file, then whether public/
// matches the lock's release; pull prints the files copied, kept and unlisted; release prints the
// release and its counts of added, changed and removed files; publish prints the release. release
// writes assets.lock.json and the archive, its file list and notes in the cache. Errors go to
// stderr.
//
// GPU lock and browser: neither. pull and release reach the network (gh or the release's URL);
// release and publish need gh unless --local.
//
// Cost: status hashes every file of public/, seconds; pull downloads the archive once per release;
// release packs and hashes the whole set.
//
// Exit codes: 0 done (status: public/ matches the lock); 1 status found a difference or no lock,
// or any command failed (an unknown command or option, a hash mismatch, nothing to release).
import '../kit/help.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCK = 'assets.lock.json';
const PUBLIC = 'public';

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

/** A release named by its date (`assets-2026.11.16`), not by the number the first ones carried. */
const DATED = /^assets-\d{4}\.\d{2}\.\d{2}(\.\d+)?$/;

/** A release's version: its tag without `assets-`. */
const versionOf = ( lock ) => lock.release.replace( /^assets-/, '' );

/** The next release's version: today's UTC date, with a count past the first that day that the
 * lock or the cache holds. */
function nextVersion( root, old ) {

	const date = new Date().toISOString().slice( 0, 10 ).replaceAll( '-', '.' );
	const taken = ( version ) => old?.release === `assets-${ version }` || existsSync( join( cacheRoot( root ), `assets-${ version }` ) );
	let version = date;
	for ( let n = 2; taken( version ); n ++ ) version = `${ date }.${ n }`;
	return version;

}

/** Uploads a packed release from the cache: its archive, its notes and `attach`. Never marked the
 * repository's latest release, which the project's own versions hold. */
function upload( root, lock, attach ) {

	const dir = join( cacheRoot( root ), lock.release );
	const archive = join( dir, lock.archive.name );
	execFileSync( 'gh', [ 'release', 'create', lock.release, archive, ...attach, '--repo', lock.repo, '--title', `Assets ${ versionOf( lock ) }`, '--latest=false', '--notes-file', join( dir, 'notes.md' ) ], { stdio: 'inherit' } );

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

	// a lock of the numbered releases names a set no release holds: it is packed again, all of it new
	const dated = old !== null && DATED.test( old.release );
	const before = dated ? old.files : {};
	const added = names.filter( ( n ) => ! ( n in before ) );
	const changed = names.filter( ( n ) => n in before && before[ n ].sha256 !== files[ n ].sha256 );
	const removed = Object.keys( before ).filter( ( n ) => ! ( n in files ) );
	if ( dated && added.length + changed.length + removed.length === 0 ) throw new Error( `public/ matches ${ old.release }: nothing to release` );

	const version = nextVersion( root, old );
	const release = `assets-${ version }`;
	const repo = old ? old.repo : originRepo( root );
	const dir = join( cacheRoot( root ), release );
	const archive = join( dir, `ponlai-assets-${ version }.tar.gz` );
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

	const lock = { repo, release, archive: { name: `ponlai-assets-${ version }.tar.gz`, size: statSync( archive ).size, sha256: sha256( archive ) }, files };
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
	if ( ! existsSync( join( dir, 'notes.md' ) ) ) writeFileSync( join( dir, 'notes.md' ), `The game's assets, version ${ versionOf( lock ) } (tools/repo/assets.mjs).` );
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
