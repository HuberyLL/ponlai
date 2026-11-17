import { defineConfig } from 'vite';

// The render pipeline starts its workers as ES modules.
export default defineConfig( { worker: { format: 'es' } } );
