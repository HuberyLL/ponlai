// Vite plugin: fills public/ with the game's assets before the dev server or the build reads it
// (tools/assets.mjs: they are pinned by assets.lock.json and published as GitHub releases, never
// committed). A fresh clone or worktree needs no setup: the missing files are pulled from the
// lock's release, from the download cache that every worktree shares. Files that differ from the
// lock (work in progress) are kept and named. The dev server starts without what it could not
// pull (the page then waits at its loading screen); a build fails, so no dist/ ships without its
// assets. `vite preview` serves a finished dist/ and pulls nothing.
import { ensureAssets } from './assets.mjs';

export function assets() {

	return {
		name: 'ponlai-assets',
		async configResolved( config ) {

			if ( config.isPreview ) return;
			const missing = await ensureAssets( config.root, config.logger );
			if ( missing > 0 && config.command === 'build' ) throw new Error( `ponlai-assets: public/ lacks ${ missing } file(s) of assets.lock.json` );

		},
	};

}
