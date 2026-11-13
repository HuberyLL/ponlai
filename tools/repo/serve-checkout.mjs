// Fills a commit's worktree with what git does not hold, for tools/kit/serve.mjs `--sha` (the
// configuration's `serve.prepare`), once its dependencies are in.
//
// The assets fill its public/ themselves (tools/repo/vite-assets.mjs, in commits that have
// assets.lock.json). A commit without the lock, from before the assets left git, holds none of
// them (the history was rewritten without them): the files its public/ lacks are copied from the
// calling checkout's public/ (the brush fonts, which then sat in src/game/ui/fonts/, there), so an
// asset changed since shows in its later version.
//   prepareCheckout( { repo, caller } )   repo: the commit's worktree; caller: the checkout serving it
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function prepareCheckout( { repo, caller } ) {

	const from = join( caller, 'public' );
	if ( existsSync( join( repo, 'assets.lock.json' ) ) || ! existsSync( from ) ) return;

	let copied = 0;
	const fill = ( dir ) => {

		for ( const e of readdirSync( join( from, dir ), { withFileTypes: true } ) ) {

			const path = join( dir, e.name ), target = join( repo, 'public', path );
			if ( e.isDirectory() ) fill( path );
			else if ( ! existsSync( target ) ) {

				mkdirSync( dirname( target ), { recursive: true } );
				copyFileSync( join( from, path ), target, constants.COPYFILE_FICLONE );
				copied ++;

			}

		}

	};

	fill( '' );

	// The brush fonts sat beside the UI's stylesheet before they moved to public/fonts/.
	const ui = join( repo, 'src', 'game', 'ui' ), fonts = join( from, 'fonts' );
	if ( existsSync( join( ui, 'ui.css' ) ) && existsSync( fonts ) ) {

		const css = readFileSync( join( ui, 'ui.css' ), 'utf8' );
		for ( const name of readdirSync( fonts ) ) {

			const target = join( ui, 'fonts', name );
			if ( ! css.includes( `./fonts/${ name }` ) || existsSync( target ) ) continue;
			mkdirSync( dirname( target ), { recursive: true } );
			copyFileSync( join( fonts, name ), target, constants.COPYFILE_FICLONE );
			copied ++;

		}

	}

	console.log( `public/: no assets.lock.json, ${ copied } file(s) it lacked copied from ${ from }` );

}
