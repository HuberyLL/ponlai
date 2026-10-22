import type * as THREE from 'three/webgpu';
import 'lxgw-wenkai-gb-web/lxgwwenkaigb-regular/result.css';
import '@fontsource/ma-shan-zheng/400.css';
import './ui.css';
import type { Game } from '../Game.ts';
import { BlueprintPlacement } from '../Placement.ts';
import { BuildBar } from './BuildBar.ts';
import { BUILDINGS, rosterTimes } from './data/buildings.ts';
import { MORE_RESOURCES, RESOURCES } from './data/resources.ts';
import { dayName } from './data/record.ts';
import { el, flag } from './dom.ts';
import { locale, t } from './i18n/i18n.ts';
import { PALETTE } from './Palette.ts';
import { People } from './People.ts';
import { Record } from './Record.ts';
import { UiShared } from './Shared.ts';
import { SpeakBar } from './SpeakBar.ts';
import { TopRow } from './TopRow.ts';

// 蜃光, the player's interface in ?game (docs/ui.md, the spec it follows; the design canvas's boards
// predate the decisions it marks as changed). The interface is a mirage over the sea: no frames, a
// mist shadow under white brush line art, in one language: Chinese, the language the game is written
// in, or another by `?lang=` (i18n/i18n.ts: every word is a catalogue's). Its parts:
//   TopRow.ts      the day and time, the speeds, the weather and its forecast (Forecast.ts), the
//                  island's resources (ResourceRow.ts) and the record's scroll
//   People.ts      the islanders' marks: the selected one's ring and tag, alerts, thinking, speech
//   SpeakBar.ts    talking to the islanders, and the words flying to them
//   BuildBar.ts    the build bar, which hands a building the simulation knows to the placement in
//                  the scene (../Placement.ts)
//   Record.ts      沧海录, the record, over the dimmed and stopped world
// Every list they show is data in ./data (the buildings, the resources, the weather kinds, the
// record's kinds of entry, the words for the simulation's states), each with placeholder rows that
// cover every state, their words in the catalogue by the rows' ids; the icons are Icons.ts, the
// strokes Brush.ts, the colours Palette.ts.
//
// Type: Ma Shan Zheng (马善政) for calligraphy, LXGW WenKai GB (霞鹜文楷 GB, sliced by unicode-range,
// so a page loads only the slices its characters need) for running text, and our own brush fonts
// (fonts/) first in every stack for numerals and Latin (ui.css). The layout is the design's
// 1600 x 900 board scaled to the window (`--k`: the smaller of its width over 1600 and height over
// 900), each part anchored to the edge it is drawn against.
//
// Keys: one listener ahead of the page's (capture, on the window) routes them, the record first
// (it takes every key while open: the world behind it is still), then the build bar's (1-9, the
// arrows, Esc, /), then Enter to the speak bar and Esc to let go of the selected islander; a key it
// takes reaches neither the camera nor the page. Typing in a field is the field's.
//
// Rules: the interface reads the simulation and acts only through the Game's methods; it never
// duplicates a game rule but asks the simulation (a refusal: buildings.ts; a shortfall: stock.ts).
// It never touches the canvas's pixels, so paused frames stay exact; the DOM is written only where
// it changed. The placement ring is drawn in the scene, and its changes are scene events
// (Placement.ts). Its own motion keeps real time; what moves with the world (the weather icon, the
// forecast) follows the game's clock, so a game loaded paused shows a still interface.

export interface UiContext {
	canvas: HTMLCanvasElement;
	camera: THREE.PerspectiveCamera;
	scene: THREE.Scene;
	/** a change of the scene for the temporal anti-aliasing (GameContext.sceneEvent) */
	sceneEvent( reason: 'game input' ): void;
}

// the design's board, which the window scales
const BOARD_W = 1600, BOARD_H = 900;
// what the fonts must have before the interface shows (the loading screen waits: Game.ready): the
// slices of the words the interface opens with (the first ten days' names and the titles)
const FONT_SAMPLES = [ '26px "Ma Shan Zheng"', '18px "LXGW WenKai GB"', '18px "Ponlai Brush"', '30px "Ponlai Brush Display"' ];
const FONT_TEXT = [ ...Array.from( { length: 10 }, ( _, i ) => dayName( i + 1 ) ), t( 'record.title' ), t( 'speak.title' ), t( 'record.island' ), ' 0123456789:' ].join( '' );

export class GameUi {

	private readonly shared: UiShared;
	private readonly root: HTMLElement;
	private readonly people: People;
	private readonly top: TopRow;
	private readonly speak: SpeakBar;
	private readonly build: BuildBar;
	private readonly record: Record;
	private readonly placement: BlueprintPlacement;
	private fontsLoaded = false;

	constructor( game: Game, context: UiContext ) {

		const shared = this.shared = new UiShared( game );
		const root = this.root = el( 'div', 'pl-ui', document.body );
		root.lang = locale;
		for ( const [ name, colour ] of Object.entries( PALETTE ) ) root.style.setProperty( `--${ name }`, colour );
		el( 'div', 'pl-veil top', root );
		el( 'div', 'pl-veil bottom', root );
		// (the islanders' marks first: their clicks on the scene are heard before the placement's,
		// so a click that places a building never also selects)
		this.people = new People( root, shared, context.camera, context.canvas );
		const hud = el( 'div', 'pl-hud', root );
		this.top = new TopRow( hud, shared, () => this.record.setOpen( true ) );
		const flights = el( 'div', 'pl-flights', root );
		this.speak = new SpeakBar( root, flights, shared, this.people );
		this.placement = new BlueprintPlacement( game, context );
		this.build = new BuildBar( hud, shared, this.placement, ( open ) => {

			this.speak.away = open;

		}, () => this.speak.focus() );
		this.placement.onPlaced = () => this.build.placed();
		this.record = new Record( root, shared, ( open ) => flag( root, 'recording', open ) );
		this.people.selectable = () => this.placement.armed === null && ! this.record.open;
		addEventListener( 'keydown', this.onKey, { capture: true } );
		Promise.all( FONT_SAMPLES.map( ( f ) => document.fonts.load( f, FONT_TEXT ) ) ).catch( () => [] ).then( () => {

			this.fontsLoaded = true;

		} );
		this.rescale();

	}

	/** Whether the interface can show: its fonts are in (the page's loading screen waits). */
	get ready(): boolean {

		return this.fontsLoaded;

	}

	/** What the interface draws into the scene, for the game to compile at start (GameView "First draws"). */
	samples(): THREE.Object3D[] {

		return this.placement.samples;

	}

	/** A new simulation was installed (start, load). */
	reset(): void {

		this.people.reset();
		this.speak.reset();
		this.build.reset();
		this.record.reset();
		this.placement.reset();

	}

	/** Per frame, after the simulation advanced and the record noted it. */
	update(): void {

		this.rescale();
		this.shared.refresh( performance.now() );
		this.placement.update();
		this.people.update();
		this.top.update();
		this.build.update();
		this.speak.update();
		this.record.update();

	}

	/** The debug panel's lists: the data's rows, or "many" (the roster three times over and more
	 * resource kinds than the row shows whole), to see the bar scroll and the row merge. */
	setMany( many: boolean ): void {

		const shared = this.shared;
		shared.roster = many ? rosterTimes( 3 ) : [ ...BUILDINGS ];
		shared.resources = many ? [ ...RESOURCES, ...MORE_RESOURCES ] : [ ...RESOURCES ];
		shared.lists ++;

	}

	private rescale(): void {

		const k = Math.min( Math.max( Math.min( innerWidth / BOARD_W, innerHeight / BOARD_H ), 0.75 ), 3 );
		if ( k === this.shared.k ) return;
		this.shared.k = k;
		this.root.style.setProperty( '--k', String( k ) );

	}

	// The interface's keys, ahead of the page's (see the header).
	private readonly onKey = ( e: KeyboardEvent ): void => {

		const take = () => {

			e.preventDefault();
			e.stopImmediatePropagation();

		};
		const target = e.target as Element | null;
		const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
		// the browser's own shortcuts are never the interface's
		if ( e.ctrlKey || e.metaKey || e.altKey ) return;
		if ( this.record.open ) {

			// the world behind is still: no other key reaches the page or the camera (their
			// defaults stay: Tab, a button's Enter and Space, F5)
			if ( this.record.key( e ) ) take();
			else e.stopImmediatePropagation();
			return;

		}
		if ( typing ) return;
		if ( this.build.key( e ) ) {

			take();
			return;

		}
		if ( e.key === 'Enter' && ! ( target instanceof HTMLButtonElement ) ) {

			// Enter leaves building for talking, or opens the bar to talk
			this.build.talk();
			take();

		} else if ( e.key === 'Escape' && this.shared.selected !== null ) {

			this.people.select( null );
			take();

		}

	};

}
