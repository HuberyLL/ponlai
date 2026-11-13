import { defineConfig, type Plugin } from 'vite';
import { assets } from './tools/repo/vite-assets.mjs';
import { worldGeneratorHash } from './tools/repo/vite-world-generator.mjs';

// Licence texts that must travel with the built site: MIT asks for the full notice in every copy,
// and the /*! */ headers kept in the bundle only point to these files.
const LICENCE_FILES: Record<string, string> = {
	'licenses/LICENSE.txt': 'LICENSE',
	'licenses/CREDITS.md': 'CREDITS.md',
	'licenses/tidewater.LICENSE.txt': 'packages/render/ocean/tidewater.LICENSE.txt',
	'licenses/FidelityFX.LICENSE.txt': 'packages/render/post/fsr3/FidelityFX.LICENSE.txt',
	'licenses/tidewater-sky.LICENSE.txt': 'packages/render/sky/tidewater.LICENSE.txt',
	'licenses/tidewater-weather.LICENSE.txt': 'packages/render/weather/tidewater.LICENSE.txt',
	'licenses/hoskins-hash.LICENSE.txt': 'packages/render/materials/hoskins-hash.LICENSE.txt',
	'licenses/three-geospatial.LICENSE.txt': 'packages/render/sky/three-geospatial.LICENSE.txt',
	'licenses/a-starry-sky.LICENSE.txt': 'packages/render/sky/a-starry-sky.LICENSE.txt',
	'licenses/LightningStrike.LICENSE.txt': 'packages/render/weather/LightningStrike.LICENSE.txt',
	'licenses/VolumetricCloudsCS1.LICENSE.txt': 'packages/render/sky/VolumetricCloudsCS1.LICENSE.txt',
	'licenses/threejs-conference.LICENSE.txt': 'packages/render/weather/threejs-conference.LICENSE.txt',
	'licenses/tidewater-materials.LICENSE.txt': 'packages/render/materials/tidewater.LICENSE.txt',
	'licenses/tidewater-lighting.LICENSE.txt': 'packages/render/lighting/tidewater.LICENSE.txt',
	'licenses/tidewater-post.LICENSE.txt': 'packages/render/post/tidewater.LICENSE.txt',
	'licenses/tidewater-fsr2.LICENSE.txt': 'packages/render/post/tidewater-fsr2.LICENSE.txt',
	'licenses/godot-rain-shader.LICENSE.txt': 'packages/render/materials/godot-rain-shader.LICENSE.txt',
	'licenses/hextile-demo.LICENSE.txt': 'packages/render/materials/hextile-demo.LICENSE.txt',
	'licenses/fsr.LICENSE.txt': 'packages/render/post/fsr.LICENSE.txt',
	'licenses/fidelityfx-fsr3.LICENSE.txt': 'packages/render/post/fidelityfx-fsr3.LICENSE.txt',
	'licenses/meshoptimizer.LICENSE.txt': 'packages/island/world/meshoptimizer.LICENSE.txt',
	// the game interface's fonts (OFL: the licence travels with the font files the build copies)
	'licenses/LXGWWenKaiGB.OFL.txt': 'packages/game/ui/fonts/LXGWWenKaiGB.OFL.txt',
	'licenses/MaShanZheng.OFL.txt': 'packages/game/ui/fonts/MaShanZheng.OFL.txt',
};

function licences(): Plugin {

	return {
		name: 'ponlai-licences',
		apply: 'build',
		async generateBundle() {

			for ( const [ fileName, source ] of Object.entries( LICENCE_FILES ) ) {

				let contents: string | Uint8Array = await this.fs.readFile( source );
				if ( fileName === 'licenses/CREDITS.md' ) {

					// Release credits live beside the shipped notices, not in the source tree.
					let text = new TextDecoder().decode( contents );
					for ( const [ shipped, from ] of Object.entries( LICENCE_FILES ) ) {

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
