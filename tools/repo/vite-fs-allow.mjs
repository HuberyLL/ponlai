// Vite's server.fs.allow for a checkout: its workspace root, and the folder its packages really are in.
//
// A worktree's node_modules is a folder of links to the main checkout's packages (tools/kit/serve.mjs),
// so a file a package's CSS names (the interface fonts' slices) resolves outside the worktree, and
// the dev server refuses it. The list allows the workspace root as Vite does by default, and the
// folder the `vite` package's link resolves to, where every linked package lives.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { searchForWorkspaceRoot } from 'vite';

export function fsAllow() {

	const root = searchForWorkspaceRoot( process.cwd() );
	try {

		return [ root, path.dirname( realpathSync( path.join( root, 'node_modules', 'vite' ) ) ) ];

	} catch {

		return [ root ];

	}

}
