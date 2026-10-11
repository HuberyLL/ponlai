import type * as THREE from 'three/webgpu';
import { CLICK_SLOP } from '../camera/IslandCameraControls.ts';
import type { Game } from './Game.ts';
import type { HudContext } from './Hud.ts';
import { groundPoint, pointerRay } from './pick.ts';
import { blueprintRefusal } from './sim/buildings.ts';
import type { Vec2 } from './sim/types.ts';
import { PlacementPreview } from './view/PlacementPreview.ts';

// The player's first control: placing the chest by hand. A button arms placement; while armed,
// a ring on the turf under the pointer shows where it would stand (PlacementPreview: green where
// it can go, red where the simulation would refuse it, with the reason over the button), and a
// click on the island places it through Game.placeBlueprint. A refused click leaves placement
// armed; Escape or the button again cancels. Once the chest stands (placed now or in a
// loaded game) the control is gone.
//
// Rules: a press that moves CLICK_SLOP or more is the camera's drag, not a click, as for the debug
// panel's send-to-click; the preview reads the same refusal the simulation applies
// (buildings.ts blueprintRefusal), so green always means the click will place it.

const HINT = 'Click the island to place it · Esc to cancel';

export class ChestPlacement {

	private readonly game: Game;
	private readonly context: HudContext;
	private readonly box: HTMLElement;
	private readonly hint: HTMLElement;
	private readonly button: HTMLButtonElement;
	private readonly preview = new PlacementPreview();
	private armed = false;
	private down = false;
	private downX = 0;
	private downY = 0;
	private pointer: { x: number; y: number } | null = null;

	constructor( game: Game, context: HudContext, box: HTMLElement ) {

		this.game = game;
		this.context = context;
		this.box = box;
		this.hint = document.createElement( 'div' );
		this.hint.className = 'hint';
		this.button = document.createElement( 'button' );
		this.button.type = 'button';
		this.button.addEventListener( 'click', () => {

			this.arm( ! this.armed );
			// keep Space for the game's pause, not this button
			this.button.blur();

		} );
		box.append( this.hint, this.button );
		context.scene.add( this.preview.mesh );
		const canvas = context.canvas;
		canvas.addEventListener( 'pointerdown', this.onDown );
		canvas.addEventListener( 'pointermove', this.onMove );
		canvas.addEventListener( 'pointerup', this.onUp );
		canvas.addEventListener( 'pointerleave', this.onLeave );
		addEventListener( 'keydown', this.onKey );
		this.arm( false );
		this.reset();

	}

	/** What it draws, for the game to compile at start (GameView "First draws"). */
	get samples(): THREE.Object3D[] {

		return [ this.preview.mesh ];

	}

	/** A new simulation was installed (start, load): show the control only while there is no chest. */
	reset(): void {

		this.arm( false );
		this.box.style.display = this.game.sim.state.buildings.some( ( b ) => b.kind === 'chest' ) ? 'none' : '';

	}

	/** Per frame: the preview follows the pointer (the camera may move under it). */
	update(): void {

		if ( this.armed ) this.showPreview();

	}

	private arm( on: boolean ): void {

		this.armed = on;
		this.box.classList.toggle( 'armed', on );
		this.button.textContent = on ? 'Cancel' : 'Place chest';
		this.context.canvas.style.cursor = on ? 'crosshair' : '';
		if ( on ) this.showPreview();
		else {

			this.preview.show( null, false, this.game.sim.grid );
			this.say( '' );

		}

	}

	private say( words: string, refused = false ): void {

		if ( this.hint.textContent !== words ) this.hint.textContent = words;
		this.hint.classList.toggle( 'refused', refused );

	}

	/** The ground under the pointer, or null. */
	private target(): Vec2 | null {

		if ( ! this.pointer ) return null;
		const { canvas, camera } = this.context;
		return groundPoint( pointerRay( canvas, camera, this.pointer.x, this.pointer.y ), this.game.sim.grid );

	}

	private showPreview(): void {

		const sim = this.game.sim, p = this.target();
		const reason = p && blueprintRefusal( sim, 'chest', p );
		this.preview.show( p, p !== null && reason === null, sim.grid );
		this.say( reason || HINT, !! reason );

	}

	private place( p: Vec2 ): void {

		const reason = this.game.placeBlueprint( 'chest', p.x, p.z );
		if ( reason ) {

			this.say( reason, true );
			return;

		}
		this.arm( false );
		this.box.style.display = 'none';

	}

	private readonly onDown = ( e: PointerEvent ): void => {

		this.down = e.button === 0 && ! e.altKey && ! e.ctrlKey;
		this.downX = e.clientX;
		this.downY = e.clientY;

	};

	private readonly onMove = ( e: PointerEvent ): void => {

		this.pointer = { x: e.clientX, y: e.clientY };

	};

	private readonly onLeave = (): void => {

		this.pointer = null;

	};

	private readonly onUp = ( e: PointerEvent ): void => {

		if ( ! this.armed || ! this.down || e.button !== 0 || Math.hypot( e.clientX - this.downX, e.clientY - this.downY ) >= CLICK_SLOP ) return;
		this.down = false;
		this.pointer = { x: e.clientX, y: e.clientY };
		const p = this.target();
		if ( p ) this.place( p );

	};

	private readonly onKey = ( e: KeyboardEvent ): void => {

		if ( e.code === 'Escape' && this.armed ) this.arm( false );

	};

}
