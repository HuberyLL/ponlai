// The game's front end on the page: the title screen, the menus and the graphics control, started once the scene is built.
//
// Starts the game's front end (game/front/Front.ts) once the scene is built and before the loop
// starts, so the loading screen lifts onto the title screen (or, after a reload for a setting made
// in play, straight onto play). It gives the front end the graphics control (GraphicsControl.ts),
// the title's view (the island camera turning slowly round the island, the hand's input off, and
// back to the island view for play: the turn itself is in the frame, Frame.ts) and the new game on
// another island (a reload with `new`, which the next load takes off the address again).
//
// Where the load opens: `?opening`, else what a reload for a setting left in session storage
// (GraphicsControl.ts `OPENING_KEY`, read once), else the title. A paused page (the test mode)
// stays paused in play: the front end leaves the simulation's pause to it.
import type { RenderParts } from '../packages/render/index.ts';
import type { IslandParts } from '../packages/island/index.ts';
import type { PageParts } from './Page.ts';
import { settings as params } from './AppSettings.ts';
import { GRAPHICS_STORE, QUALITY_CHOICE, STORED_GRAPHICS, reloadWith } from './PageSettings.ts';
import { currentGraphics } from './GraphicsSettings.ts';
import { createGraphicsControl, OPENING_KEY } from './GraphicsControl.ts';

function opening(): 'title' | 'play' {

	const asked = params.get( 'opening' );
	let stored: string | null = null;
	try {

		stored = sessionStorage.getItem( OPENING_KEY );
		sessionStorage.removeItem( OPENING_KEY );

	} catch { /* storage refused: the title */ }
	if ( asked === 'title' || asked === 'play' ) return asked;
	return stored === 'play' ? 'play' : 'title';

}

export async function startFront( render: RenderParts, island: IslandParts, page: PageParts ): Promise<void> {

	const game = page.game!;
	const { Front } = await import( '../packages/game/index.ts' );
	const graphics = createGraphicsControl( render, page.frame, game, currentGraphics( STORED_GRAPHICS, QUALITY_CHOICE.tier ), GRAPHICS_STORE );
	// a new game asked for on the last load: the address forgets it, so a refresh resumes that game
	if ( params.has( 'new' ) ) {

		const url = new URL( location.href );
		url.searchParams.delete( 'new' );
		history.replaceState( history.state, '', url );

	}
	const hand = island.controls.handInput;
	page.front = new Front( {
		game,
		graphics,
		opening: opening(),
		holdsPause: params.has( 'paused' ),
		titleView( on ) {

			page.titleTurn = on;
			island.controls.handInput = on ? false : hand;
			if ( ! on ) page.setCameraView( 'island' );

		},
		newGameElsewhere() {

			if ( game.keeps ) game.autosave();
			try { sessionStorage.setItem( OPENING_KEY, 'play' ); } catch { /* the title then */ }
			reloadWith( { new: '' } );

		},
	} );

}
