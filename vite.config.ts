import { defineConfig, type Plugin } from 'vite';
import { assets } from './tools/repo/vite-assets.mjs';
import { worldGeneratorHash } from './tools/repo/vite-world-generator.mjs';

// Licence texts that must travel with the built site: MIT asks for the full notice in every copy.
// The /*! */ notices kept in the bundle carry the copyright lines and the SPDX licence; the texts
// of the licences are LICENSES/ (one per SPDX id, REUSE), every file of it shipped as it is.
const LICENCE_DIR = 'LICENSES';
const LICENCE_FILES: Record<string, string> = {
	'licenses/LICENSE.txt': 'LICENSE',
	'licenses/CREDITS.md': 'CREDITS.md',
	// the game interface's fonts: the OFL with each font's notice, beside the font files
	'licenses/LXGWWenKaiGB.OFL.txt': 'packages/game/ui/fonts/LXGWWenKaiGB.OFL.txt',
	'licenses/MaShanZheng.OFL.txt': 'packages/game/ui/fonts/MaShanZheng.OFL.txt',
};

function licences(): Plugin {

	return {
		name: 'ponlai-licences',
		apply: 'build',
		async generateBundle() {

			const files = { ...LICENCE_FILES };
			for ( const name of ( await this.fs.readdir( LICENCE_DIR ) ).sort() ) files[ `licenses/${ name }` ] = `${ LICENCE_DIR }/${ name }`;

			for ( const [ fileName, source ] of Object.entries( files ) ) {

				let contents: string | Uint8Array = await this.fs.readFile( source );
				if ( fileName === 'licenses/CREDITS.md' ) {

					// Release credits live beside the shipped notices, not in the source tree.
					let text = new TextDecoder().decode( contents );
					for ( const [ shipped, from ] of Object.entries( files ) ) {

						text = text.replaceAll( `](${ from })`, `](${ shipped.replace( 'licenses/', '' ) })` );

					}

					contents = text;

				}
				this.emitFile( { type: 'asset', fileName, source: contents } );

			}

		},
	};

}

export default defineConfig( {
	base: './',
	// assets(): fills the git-ignored public/ from the assets release (tools/repo/vite-assets.mjs);
	// the world generator's source hash, for the world cache (packages/island/world/WorldCache.ts)
	plugins: [ licences(), assets(), worldGeneratorHash() ],
	server: {
		// Worktrees for parallel branches live under .claude/. A build or checkout there writes an
		// index.html inside this root, which would make the dev server reload every open page. The
		// glob is anchored to this config's own .claude/: a relative '**/.claude/**' also matched
		// every file of a dev server started inside a worktree, which then served stale modules.
		watch: { ignored: [ decodeURIComponent( new URL( './.claude/', import.meta.url ).pathname ) + '**' ] },
	},
	build: {
		target: 'es2022',
		chunkSizeWarningLimit: 1500,
		// keep third-party licence notices ( /*! ... */ ) in the bundle
		rolldownOptions: {
			// the island's page and the test scenes' (app/scenes/)
			input: [ 'index.html', 'scenes.html' ],
			output: {
				comments: { legal: true },
				// A chunk that is no entry of its own holds the code the page and its lazy parts
				// (the game, the profiler) share, three.js first; Rolldown would name it after one
				// of its modules (looks-*.js), which says nothing about what it is.
				chunkFileNames: ( chunk ) => chunk.isDynamicEntry ? 'assets/[name]-[hash].js' : 'assets/shared-[hash].js',
			},
		},
		// licences of the npm packages bundled into the build ( three, lil-gui )
		license: { fileName: 'licenses/dependencies.md' },
	},
	worker: { format: 'es' },
} );
