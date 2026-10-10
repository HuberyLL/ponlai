import { defineConfig, type Plugin } from 'vite';
import { worldGeneratorHash } from './tools/vite-world-generator.mjs';

// Licence texts that must travel with the built site: MIT asks for the full notice in every copy,
// and the /*! */ headers kept in the bundle only point to these files.
const LICENCE_FILES: Record<string, string> = {
	'licenses/LICENSE.txt': 'LICENSE',
	'licenses/CREDITS.md': 'CREDITS.md',
	'licenses/tidewater.LICENSE.txt': 'src/ocean/tidewater.LICENSE.txt',
	'licenses/tidewater-sky.LICENSE.txt': 'src/sky/tidewater.LICENSE.txt',
	'licenses/tidewater-weather.LICENSE.txt': 'src/weather/tidewater.LICENSE.txt',
	'licenses/hoskins-hash.LICENSE.txt': 'src/materials/hoskins-hash.LICENSE.txt',
	'licenses/three-geospatial.LICENSE.txt': 'src/sky/three-geospatial.LICENSE.txt',
	'licenses/a-starry-sky.LICENSE.txt': 'src/sky/a-starry-sky.LICENSE.txt',
	'licenses/LightningStrike.LICENSE.txt': 'src/weather/LightningStrike.LICENSE.txt',
	'licenses/VolumetricCloudsCS1.LICENSE.txt': 'src/sky/VolumetricCloudsCS1.LICENSE.txt',
	'licenses/threejs-conference.LICENSE.txt': 'src/weather/threejs-conference.LICENSE.txt',
	'licenses/tidewater-materials.LICENSE.txt': 'src/materials/tidewater.LICENSE.txt',
	'licenses/godot-rain-shader.LICENSE.txt': 'src/materials/godot-rain-shader.LICENSE.txt',
	'licenses/hextile-demo.LICENSE.txt': 'src/materials/hextile-demo.LICENSE.txt',
	'licenses/fsr.LICENSE.txt': 'src/post/fsr.LICENSE.txt',
};

function licences(): Plugin {

	return {
		name: 'soomi-licences',
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
	// the world generator's source hash, for the world cache (src/world/WorldCache.ts)
	plugins: [ licences(), worldGeneratorHash() ],
	server: {
		// Worktrees for parallel branches live under .claude/. A build or checkout there writes an
		// index.html inside this root, which would make the dev server reload every open page.
		watch: { ignored: [ '**/.claude/**' ] },
	},
	build: {
		target: 'es2022',
		chunkSizeWarningLimit: 1500,
		// keep third-party licence notices ( /*! ... */ ) in the bundle
		rolldownOptions: { output: { comments: { legal: true } } },
		// licences of the npm packages bundled into the build ( three, lil-gui )
		license: { fileName: 'licenses/dependencies.md' },
	},
	worker: { format: 'es' },
} );
