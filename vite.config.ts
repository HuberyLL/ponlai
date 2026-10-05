import { defineConfig, type Plugin } from 'vite';

// Licence texts that must travel with the built site: MIT asks for the full notice in every copy,
// and the /*! */ headers kept in the bundle only point to these files.
const LICENCE_FILES: Record<string, string> = {
	'licenses/LICENSE.txt': 'LICENSE',
	'licenses/CREDITS.md': 'CREDITS.md',
	'licenses/tidewater.LICENSE.txt': 'src/ocean/tidewater.LICENSE.txt',
	'licenses/tidewater-sky.LICENSE.txt': 'src/sky/tidewater.LICENSE.txt',
	'licenses/hoskins-hash.LICENSE.txt': 'src/materials/hoskins-hash.LICENSE.txt',
	'licenses/threejs-conference.LICENSE.txt': 'src/weather/threejs-conference.LICENSE.txt',
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
	plugins: [ licences() ],
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
