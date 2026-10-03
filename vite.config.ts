import { defineConfig } from 'vite';

export default defineConfig( {
	base: './',
	build: {
		target: 'es2022',
		chunkSizeWarningLimit: 1500,
		// keep third-party licence notices ( /*! ... */ ) in the bundle
		rolldownOptions: { output: { comments: { legal: true } } },
	},
	worker: { format: 'es' },
} );
