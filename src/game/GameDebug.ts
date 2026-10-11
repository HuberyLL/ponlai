import type * as THREE from 'three/webgpu';
import type GUI from 'lil-gui';
import type { Controller } from 'lil-gui';
import { CLICK_SLOP } from '../camera/IslandCameraControls.ts';
import type { Game } from './Game.ts';
import { groundPoint, pointerRay } from './pick.ts';
import { describeCall } from './sim/actions.ts';
import type { EntityId, Speed } from './sim/types.ts';

// The game's developer controls: a Game folder in the scene's lil-gui panel (H), not a player
// interface. It sets the speed and pauses, saves and loads, shows one islander's body as the
// simulation holds it (where it is, the action under way, whether a thought is in flight for it)
// and sends that body walking to the next click on the island. Everything
// goes through the Game's methods, which the console reaches as window.__PONLAI__.game.

// ms between refreshes of the read-only fields
const REFRESH_MS = 250;
const SPEEDS: Record<string, Speed> = { paused: 0, '1x': 1, '3x': 2, '6x': 3 };

export class GameDebug {

	private readonly game: Game;
	private readonly camera: THREE.PerspectiveCamera;
	private readonly canvas: HTMLCanvasElement;
	private readonly folder: GUI;
	private readonly fields = {
		speed: 1 as Speed, status: '', islander: '' as EntityId, position: '', doing: '', thinking: false,
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

		folder.add( f, 'speed', SPEEDS ).onChange( ( speed: Speed ) => game.setSpeed( speed ) );
		folder.add( { pause: () => game.togglePause() }, 'pause' ).name( 'pause / resume (Space)' );
		folder.add( { save: () => {

			game.save();
			this.say( 'Saved' );

		} }, 'save' );
		folder.add( { load: () => void game.load().then( ( text ) => this.say( text ) ) }, 'load' );
		this.readouts.push( folder.add( f, 'status' ).disable() );

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
		for ( const v of sim.state.villagers ) options[ v.name ] = v.id;
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
		f.speed = sim.speed;
		const v = sim.state.villagers.find( ( o ) => o.id === f.islander );
		f.position = v ? `${ v.pos.x.toFixed( 1 ) }, ${ v.pos.z.toFixed( 1 ) }` : '';
		f.doing = v ? ( v.action ? describeCall( v.action.call ) : v.path ? 'walking' : 'standing' ) : '';
		f.thinking = v ? sim.thinking( v.id ) : false;
		for ( const c of this.folder.controllersRecursive() ) c.updateDisplay();

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
