// Vite plugin: the islanders' models live in the git-ignored artifacts/assets/ (no binary goes into
// git while their art is not settled: src/characters/looks.ts). A worktree has no copy of its own
// and a build empties dist/, so both used to need the folder linked by hand, or the page stayed on
// its loading screen. The source is the root's artifacts/assets, else the main checkout's, found
// through git's common directory so that no machine path is written into the repo. The dev server
// serves it at /artifacts/assets/; `vite build` links it into dist/artifacts/assets. Without a
// source the plugin warns once and the build still passes.
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';

const ASSETS_URL = '/artifacts/assets';

const ASSET_TYPES = {
	'.gltf': 'model/gltf+json',
	'.glb': 'model/gltf-binary',
	'.bin': 'application/octet-stream',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.webp': 'image/webp',
	'.ktx2': 'image/ktx2',
};

/** The assets folder: this root's, else the main checkout's; null without either. */
export function findAssets( root ) {

	const own = resolve( root, 'artifacts/assets' );
	if ( existsSync( own ) ) return own;

	try {

		const common = execFileSync( 'git', [ 'rev-parse', '--path-format=absolute', '--git-common-dir' ], { cwd: root, encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'ignore' ] } ).trim();
		const main = resolve( dirname( common ), 'artifacts/assets' );
		if ( existsSync( main ) ) return main;

	} catch {

		// not a git checkout (an unpacked source archive): there is no main checkout to ask

	}

	return null;

}

export function assets() {

	let source = null;
	let outDir = '';
	let building = false;

	return {
		name: 'ponlai-assets',
		configResolved( config ) {

			source = findAssets( config.root );
			outDir = resolve( config.root, config.build.outDir );
			building = config.command === 'build';
			if ( source === null ) config.logger.warn( `ponlai-assets: no artifacts/assets in this checkout or the main one; the page will wait at its loading screen` );

		},
		configureServer( server ) {

			// Served by hand rather than through Vite's static files: the main checkout's folder lies
			// outside a worktree's root, where Vite's fs rules would refuse it.
			server.middlewares.use( ASSETS_URL, ( req, res, next ) => {

				if ( source === null ) return next();
				const path = resolve( source, '.' + decodeURIComponent( ( req.url ?? '/' ).split( '?' )[ 0 ] ) );
				if ( ! path.startsWith( source + sep ) || ! existsSync( path ) || ! statSync( path ).isFile() ) return next();
				res.setHeader( 'Content-Type', ASSET_TYPES[ extname( path ).toLowerCase() ] ?? 'application/octet-stream' );
				res.setHeader( 'Cache-Control', 'no-cache' );
				createReadStream( path ).pipe( res );

			} );

		},
		closeBundle() {

			// A link, not a copy: the models are large, and a preview then serves them as the dev
			// server does (base './' keeps the absolute /artifacts/assets URLs at the site's root).
			if ( ! building || source === null ) return;
			const link = resolve( outDir, '.' + ASSETS_URL );
			mkdirSync( dirname( link ), { recursive: true } );
			rmSync( link, { recursive: true, force: true } );
			symlinkSync( source, link, 'dir' );

		},
	};

}
