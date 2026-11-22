import type { GraphicsOption, GraphicsRecord, QualityTier } from '../../render/setup.ts';
import type { Game } from '../Game.ts';
import { el, flag, text, under } from '../ui/dom.ts';
import { t } from '../ui/i18n/i18n.ts';
import { PALETTE } from '../ui/Palette.ts';
import { SettingsPage } from './SettingsPage.ts';

// The game's front end over the live island: the title screen, the pause menu and the settings.
//
// The front end (docs/design/ui.md, The front end): the page opens on the title screen over the live
// island, the camera turning slowly round it, the name 蓬莱 upright in calligraphy and its choices
// beside it: 继续 (the saved game, which the game resumed as it loaded; shown only when there is
// one), 新游戏 and 设置. Choosing to play sinks the title into the mist, brings the camera to the
// island view and surfaces the game's interface (GameUi `hidden`). In play, Esc (when no part of the
// interface takes it) opens the pause menu over the dimmed world, the simulation paused: 继续, 设置,
// 返回标题 (which saves first). The settings (SettingsPage.ts) open from either.
//
// It reads the game through the Game's methods and the graphics through the app's `GraphicsControl`
// (app/GraphicsControl.ts), which stores the player's choice, applies a live option at once and
// reloads for the rest: the front end never reaches into the render pipeline or the browser's storage.
// Its keys: one listener ahead of the game's (capture, on the window) while a screen is up, which
// takes every key but the browser's shortcuts; in play only Esc, after the game's own listener has
// let it pass.

/** What the app gives the menu for the graphics (app/GraphicsControl.ts). */
export interface GraphicsControl {
	readonly options: readonly GraphicsOption[];
	/** the player's choice as it stands (the menu's) */
	readonly record: GraphicsRecord;
	/** a choice of one option: stored, applied at once when live */
	set( id: string, choice: string ): void;
	/** a whole preset */
	setPreset( tier: QualityTier ): void;
	/** the reload options whose choice differs from what this load built */
	pending(): string[];
	/** saves the game, then reloads into play (`into`) or to the title */
	reload( into: 'play' | 'title' ): void;
	/** the display mode (the Fullscreen API) */
	fullscreen(): boolean;
	setFullscreen( on: boolean ): void;
	/** the frames shown in the last second */
	fps(): number;
}

/** What the app gives the front end besides the game. */
export interface FrontContext {
	game: Game;
	graphics: GraphicsControl;
	/** the title's slow turn round the island (on), or the island view for play (off) */
	titleView( on: boolean ): void;
	/** where this load opens: the title, or straight into play (a reload for a setting from play) */
	opening: 'title' | 'play';
	/** a paused page (the test mode): play leaves the simulation's pause as the page set it */
	holdsPause: boolean;
	/** a new game on another island than the one loaded: the app reloads into it */
	newGameElsewhere(): void;
}

type Screen = 'title' | 'play' | 'pause' | 'settings';

// the interface's frame, which the window scales (GameUi's)
const BOARD_W = 1600, BOARD_H = 900;

function textButton( label: string, parent: Element, onClick: () => void ): HTMLButtonElement {

	const b = el( 'button', 'pl-btn text', parent );
	b.type = 'button';
	el( 'span', 'pl-face', b, label );
	under( b );
	b.addEventListener( 'click', ( e ) => {

		onClick();
		if ( e.detail > 0 ) b.blur();

	} );
	return b;

}

export class Front {

	private readonly context: FrontContext;
	private readonly root: HTMLElement;
	private readonly title: HTMLElement;
	private readonly resume: HTMLButtonElement;
	private readonly pause: HTMLElement;
	private readonly settings: SettingsPage;
	private readonly fpsLine: HTMLElement;
	private screen: Screen = 'title';
	// where the settings return to
	private from: 'title' | 'pause' = 'title';
	private k = 0;
	private orbiting = false;
	private nextFps = 0;

	constructor( context: FrontContext ) {

		this.context = context;
		const root = this.root = el( 'div', 'pl-front', document.body );
		root.lang = document.documentElement.lang;
		for ( const [ name, colour ] of Object.entries( PALETTE ) ) root.style.setProperty( `--${ name }`, colour );
		this.fpsLine = el( 'div', 'pl-fps pl-num', document.body );
		this.fpsLine.hidden = true;
		this.rescale();

		this.title = el( 'div', 'pl-screen pl-title-screen', root );
		el( 'div', 'pl-title-name pl-title pl-xb', this.title, t( 'front.name' ) );
		const menu = el( 'nav', 'pl-title-menu', this.title );
		menu.setAttribute( 'aria-label', t( 'front.title.menu' ) );
		this.resume = textButton( t( 'front.title.continue' ), menu, () => this.play() );
		textButton( t( 'front.title.new' ), menu, () => void this.newGame() );
		textButton( t( 'front.title.settings' ), menu, () => this.openSettings( 'title' ) );

		this.pause = el( 'div', 'pl-screen pl-pause', root );
		el( 'div', 'pl-pause-name pl-title pl-xb', this.pause, t( 'front.pause.title' ) );
		const pauseMenu = el( 'nav', 'pl-pause-menu', this.pause );
		pauseMenu.setAttribute( 'aria-label', t( 'front.pause.title' ) );
		textButton( t( 'front.pause.continue' ), pauseMenu, () => this.play() );
		textButton( t( 'front.pause.settings' ), pauseMenu, () => this.openSettings( 'pause' ) );
		textButton( t( 'front.pause.toTitle' ), pauseMenu, () => this.toTitle() );

		this.settings = new SettingsPage( root, context.graphics, () => this.closeSettings(), () => this.from === 'pause' ? 'play' : 'title' );

		addEventListener( 'keydown', this.onKey, { capture: true } );
		addEventListener( 'keydown', this.onPlayKey );
		if ( context.opening === 'play' ) this.play();
		else this.show( 'title' );

	}

	/** Per frame: the scale and the frame-rate readout. */
	update(): void {

		// eslint-disable-next-line ponlai/scene-clock -- the readout's refresh: when it is written, not what is drawn
		const now = performance.now();
		this.rescale();
		const on = this.context.graphics.record.options.fps === 'on';
		this.fpsLine.hidden = ! on;
		if ( on && now >= this.nextFps ) {

			this.nextFps = now + 500;
			text( this.fpsLine, t( 'front.fps', { fps: Math.round( this.context.graphics.fps() ) } ) );

		}

	}

	/** The screen shown ('play': none). */
	get current(): Screen {

		return this.screen;

	}

	private show( screen: Screen ): void {

		const { game } = this.context;
		this.screen = screen;
		flag( this.title, 'shown', screen === 'title' );
		flag( this.pause, 'shown', screen === 'pause' );
		this.settings.shown = screen === 'settings';
		if ( game.ui ) game.ui.hidden = screen !== 'play';
		if ( screen === 'title' ) this.resume.hidden = ! game.resumed;
		// the simulation stands still behind every screen; the camera turns round the island behind
		// the title (and the settings opened from it) and comes to the island view for play
		if ( screen !== 'play' ) game.setPaused( true );
		else if ( ! this.context.holdsPause ) game.setPaused( false );
		const orbit = screen === 'title' || screen === 'settings' && this.from === 'title' ? true : screen === 'play' ? false : this.orbiting;
		if ( orbit !== this.orbiting ) {

			this.orbiting = orbit;
			this.context.titleView( orbit );

		}
		const first = this.root.querySelector<HTMLButtonElement>( '.pl-screen.shown .pl-btn:not([hidden])' );
		if ( screen !== 'play' ) first?.focus( { preventScroll: true } );

	}

	private play(): void {

		this.show( 'play' );

	}

	private async newGame(): Promise<void> {

		const { game } = this.context;
		// a new game starts on the island the page loaded where it can, else the app reloads into one
		if ( game.sim.state.pieces !== 0 ) return this.context.newGameElsewhere();
		await game.startOver();
		game.resumed = true;
		this.play();

	}

	private toTitle(): void {

		this.context.game.autosave();
		this.show( 'title' );

	}

	private openSettings( from: 'title' | 'pause' ): void {

		this.from = from;
		this.show( 'settings' );
		this.settings.open();

	}

	private closeSettings(): void {

		this.show( this.from );

	}

	private rescale(): void {

		const k = Math.min( Math.max( Math.min( innerWidth / BOARD_W, innerHeight / BOARD_H ), 0.75 ), 3 );
		if ( k === this.k ) return;
		this.k = k;
		this.root.style.setProperty( '--k', String( k ) );
		this.fpsLine.style.setProperty( '--k', String( k ) );

	}

	// While a screen is up it takes every key (the browser's shortcuts and Tab aside).
	private readonly onKey = ( e: KeyboardEvent ): void => {

		if ( this.screen === 'play' || e.ctrlKey || e.metaKey || e.altKey ) return;
		if ( e.key === 'Tab' ) {

			e.stopImmediatePropagation();
			return;

		}
		let taken = false;
		if ( this.screen === 'settings' ) taken = this.settings.key( e );
		else if ( e.key === 'Escape' && this.screen === 'pause' ) {

			this.play();
			taken = true;

		} else if ( e.key === 'ArrowDown' || e.key === 'ArrowUp' ) {

			const buttons = [ ...this.root.querySelectorAll<HTMLButtonElement>( '.pl-screen.shown nav .pl-btn' ) ].filter( ( b ) => ! b.hidden );
			const at = buttons.indexOf( document.activeElement as HTMLButtonElement );
			const next = at < 0 ? 0 : ( at + ( e.key === 'ArrowDown' ? 1 : buttons.length - 1 ) ) % buttons.length;
			buttons[ next ]?.focus();
			taken = true;

		}
		// Enter and Space on a focused button are the button's
		if ( e.key === 'Enter' || e.key === ' ' ) return void e.stopImmediatePropagation();
		if ( taken ) e.preventDefault();
		e.stopImmediatePropagation();

	};

	// In play: Esc that the game's interface let pass opens the pause menu.
	private readonly onPlayKey = ( e: KeyboardEvent ): void => {

		if ( this.screen !== 'play' || e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey ) return;
		const target = e.target as Element | null;
		if ( target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ) return;
		e.preventDefault();
		this.show( 'pause' );

	};

}
