import type * as THREE from 'three/webgpu';
import type GUI from 'lil-gui';
import type { Controller } from 'lil-gui';
import { CLICK_SLOP } from '../island/index.ts';
import type { Game } from './Game.ts';
import { groundPoint, pointerRay } from './pick.ts';
import { describeCall } from './sim/actions.ts';
import { tickAt } from './sim/clock.ts';
import { needs } from './sim/registry.ts';
import type { Agent, Perception, ToolCall } from './sim/agent.ts';
import { StandInAgent } from './sim/standin.ts';
import { GROWTH_STEPS } from './sim/types.ts';
import type { EntityId } from './sim/types.ts';
import { PLACEHOLDER_DAYS, PLACEHOLDER_NAMES, PLACEHOLDER_SKIES } from './ui/data/record.ts';
import { LOCALES, locale } from './ui/i18n/i18n.ts';

// The game's developer controls: a Game folder in the scene's lil-gui panel.
//
// The game's developer controls: a Game folder in the scene's lil-gui panel (H), not a player
// interface. It pauses and resumes, saves, loads and starts a new game (the save's slot:
// save.ts; `saved` says when the game was last saved and whether the page saves it itself), shows
// one islander's body as the simulation holds it (where it is, the action under way, whether a
// thought is in flight for it) and sends that body walking to the next click on the island. Its
// Growth folder bumps the population by an islander (how islanders arrive is not designed yet), so
// a step of the island's growth can be crossed by hand, and shows the population against the next
// step. Its Interface folder puts the player's interface (ui/GameUi.ts) into the states the game
// does not reach yet: the lists at three times their size, nine placeholder days in the record
// (entries like any other, so they go into the save: a new game clears them), an agent that hears
// the player and answers after a thought (HearingAgent), a line said by the islander inspected, and
// their needs low and critical; and it picks the interface's language, which reloads the page with
// `?lang=` (a load knob: ui/i18n/i18n.ts). Everything goes through the Game's methods, which the
// console reaches as window.__PONLAI__.game.

// placeholder answers of the hearing agent
const REPLIES = [ '好，这就去。', '知道了。', '箱子放哪儿？', '我先喝口水，马上就来。', '嗯。', '鱼够不够？' ];

// An agent for seeing the interface's speech at work until the language model hears the player: it
// hears (Agent.hears), thinks over what it heard for a while (the thinking ring shows: two seconds
// and 0.3 s a character, at most seven) and answers with a placeholder line; otherwise it thinks as
// the stand-in does.
class HearingAgent implements Agent {

	readonly hears = true;
	private readonly game: Game;
	private readonly inner = new StandInAgent();
	private replies = 0;

	constructor( game: Game ) {

		this.game = game;

	}

	think( perception: Perception, who: EntityId ): ToolCall[] | Promise<ToolCall[]> {

		if ( ! this.game.hasHeard( who ) ) return this.inner.think( perception );
		const heard = Array.from( this.game.takeHeard( who ).join( '' ) ).length;
		const words = REPLIES[ this.replies ++ % REPLIES.length ];
		return new Promise( ( resolve ) => setTimeout( () => resolve( [ { tool: 'say', args: { words } } ] ), Math.min( 7000, 2000 + 300 * heard ) ) );

	}

}

// ms between refreshes of the read-only fields
const REFRESH_MS = 250;

export class GameDebug {

	private readonly game: Game;
	private readonly camera: THREE.PerspectiveCamera;
	private readonly canvas: HTMLCanvasElement;
	private readonly folder: GUI;
	private readonly fields = {
		paused: false, status: '', saved: '', islander: '' as EntityId, position: '', doing: '', thinking: false,
		population: '',
	};
	private readonly islander: Controller;
	private readonly readouts: Controller[] = [];
	private readonly armButton: Controller;
	private nextRefresh = 0;
	// send-to-click: armed by the panel, spent by the next click (not a camera drag) on the island
	private armed = false;
	private downX = 0;
	private downY = 0;
	private down = false;

	constructor( game: Game, gui: GUI, camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement ) {

		this.game = game;
		this.camera = camera;
		this.canvas = canvas;
		const f = this.fields;
		const folder = this.folder = gui.addFolder( 'Game' );

		folder.add( f, 'paused' ).onChange( ( paused: boolean ) => game.setPaused( paused ) );
		folder.add( { pause: () => game.togglePause() }, 'pause' ).name( 'pause / resume (Space)' );
		folder.add( { save: () => {

			this.say( game.save() );

		} }, 'save' );
		folder.add( { load: () => void game.load().then( ( text ) => this.say( text ) ) }, 'load' );
		folder.add( { start: () => void game.startOver().then( ( text ) => this.say( text ) ) }, 'start' ).name( 'new game' );
		this.readouts.push( folder.add( f, 'saved' ).disable() );
		this.readouts.push( folder.add( f, 'status' ).disable() );

		const growth = folder.addFolder( 'Growth' );
		this.readouts.push( growth.add( f, 'population' ).disable() );
		growth.add( { add: () => {

			game.addIslander();
			this.reset();

		} }, 'add' ).name( 'add an islander' );

		const ui = folder.addFolder( 'Interface' );
		ui.add( { many: false }, 'many' ).name( 'many rows (x3)' ).onChange( ( many: boolean ) => game.ui?.setMany( many ) );
		ui.add( { days: () => this.placeholderDays() }, 'days' ).name( 'placeholder days' );
		ui.add( { hearing: false }, 'hearing' ).name( 'hearing agent' ).onChange( ( on: boolean ) => game.setAgent( on ? new HearingAgent( game ) : new StandInAgent() ) );
		let line = 0;
		ui.add( { say: () => this.say( game.say( f.islander, REPLIES[ line ++ % REPLIES.length ] ) ?? 'Said' ) }, 'say' ).name( 'inspected islander says a line' );
		// the registered needs in turn to these values: one low and one critical, both critical
		const setNeeds = ( values: number[] ) => needs().forEach( ( need, i ) => game.setNeed( f.islander, need.id, values[ i % values.length ] ) );
		ui.add( { low: () => setNeeds( [ 38, 12 ] ) }, 'low' ).name( 'needs low (38, 12)' );
		ui.add( { critical: () => setNeeds( [ 14, 9 ] ) }, 'critical' ).name( 'needs critical (14, 9)' );
		ui.add( { lang: locale }, 'lang', LOCALES ).name( 'language (reloads)' ).onChange( ( lang: string ) => {

			const url = new URL( location.href );
			url.searchParams.set( 'lang', lang );
			location.assign( url );

		} );

		const who = folder.addFolder( 'Inspect islander' );
		this.islander = who.add( f, 'islander', {} ).onChange( ( id: EntityId ) => game.focus( id ) );
		for ( const key of [ 'position', 'doing', 'thinking' ] as const ) this.readouts.push( who.add( f, key ).disable() );
		this.armButton = who.add( { arm: () => this.arm( ! this.armed ) }, 'arm' ).name( 'send to next click' );

		canvas.addEventListener( 'pointerdown', this.onDown );
		canvas.addEventListener( 'pointerup', this.onUp );
		this.reset();

	}

	/** A new simulation was installed (start, load): its islanders. */
	reset(): void {

		const sim = this.game.sim, f = this.fields;
		const options: Record<string, EntityId> = {};
		// (names repeat past the simulation's list of them: a repeated one is told by its id)
		for ( const v of sim.state.villagers ) options[ Object.hasOwn( options, v.name ) ? `${ v.name } (${ v.id })` : v.name ] = v.id;
		( this.islander as unknown as { options( o: object ): Controller } ).options( options );
		if ( ! sim.state.villagers.some( ( v ) => v.id === f.islander ) ) f.islander = sim.state.villagers[ 0 ]?.id ?? '';
		this.islander.updateDisplay();
		this.game.focus( f.islander || null );
		this.nextRefresh = 0;

	}

	/** Per frame; refreshes the read-only fields a few times a second while the folder is open. */
	update(): void {

		const now = performance.now();
		if ( now < this.nextRefresh || this.folder._closed || this.folder.root._hidden ) return;
		this.nextRefresh = now + REFRESH_MS;
		const f = this.fields, sim = this.game.sim;
		f.paused = sim.paused;
		const at = this.game.savedAt === null ? 'not since the page loaded' : new Date( this.game.savedAt ).toLocaleTimeString();
		f.saved = `${ at }${ this.game.keeps ? ', autosave on' : ', autosave off' }`;
		const next = GROWTH_STEPS[ sim.state.pieces ];
		f.population = `${ sim.population() } islanders, ${ sim.state.pieces } pieces, next at ${ next ?? '-' }`;
		const v = sim.state.villagers.find( ( o ) => o.id === f.islander );
		f.position = v ? `${ v.pos.x.toFixed( 1 ) }, ${ v.pos.z.toFixed( 1 ) }` : '';
		f.doing = v ? ( v.action ? describeCall( v.action.call ) : v.path ? 'walking' : 'standing' ) : '';
		f.thinking = v ? sim.thinking( v.id ) : false;
		for ( const c of this.folder.controllersRecursive() ) c.updateDisplay();

	}

	// Nine placeholder days in the record (ui/data/record.ts): the game's islanders where it has
	// them, placeholder names for the rest.
	private placeholderDays(): void {

		const game = this.game, ids = game.sim.state.villagers.map( ( v ) => v.id ), startHour = game.sim.state.startHour;
		const who = ( n: number | 'player' | 'island' ) => typeof n === 'number' ? ids[ n ] ?? `~${ PLACEHOLDER_NAMES[ n ] }` : n;
		for ( const { day, minute, ...e } of PLACEHOLDER_DAYS ) {

			// an islander the record saw land keeps that landing
			if ( e.kind === 'landed' && game.record.landed.has( who( e.who ) ) ) continue;
			game.record.add( { ...e, tick: tickAt( day, minute, startHour ), who: who( e.who ), to: Array.isArray( e.to ) ? e.to.map( who ) : e.to } );

		}
		PLACEHOLDER_SKIES.forEach( ( sky, i ) => game.record.addSky( i + 1, sky, 24 ) );
		this.say( 'Nine placeholder days in the record' );

	}

	private say( text: string ): void {

		this.fields.status = text;
		this.nextRefresh = 0;

	}

	private arm( on: boolean ): void {

		this.armed = on;
		this.armButton.name( on ? 'click the island… (again: cancel)' : 'send to next click' );

	}

	private readonly onDown = ( e: PointerEvent ): void => {

		this.down = e.button === 0 && ! e.altKey && ! e.ctrlKey;
		this.downX = e.clientX;
		this.downY = e.clientY;

	};

	// a press that moved less than the camera's CLICK_SLOP is a click, not a grab of the ground
	private readonly onUp = ( e: PointerEvent ): void => {

		if ( ! this.armed || ! this.down || e.button !== 0 || Math.hypot( e.clientX - this.downX, e.clientY - this.downY ) >= CLICK_SLOP ) return;
		this.down = false;
		const hit = groundPoint( pointerRay( this.canvas, this.camera, e.clientX, e.clientY ), this.game.sim.grid );
		if ( ! hit ) return;
		this.say( this.game.walkTo( this.fields.islander, hit.x, hit.z ) ?? 'Walking' );
		this.arm( false );

	};

}
