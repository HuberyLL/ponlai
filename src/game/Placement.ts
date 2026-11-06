import type * as THREE from 'three/webgpu';
import { CLICK_SLOP } from '../camera/IslandCameraControls.ts';
import type { Game } from './Game.ts';
import { groundPoint, pointerRay } from './pick.ts';
import { blueprintRefusal } from './sim/buildings.ts';
import { buildingKind } from './sim/registry.ts';
import type { Vec2 } from './sim/types.ts';
import type { PlacementHandle } from './ui/BuildBar.ts';
import type { UiContext } from './ui/GameUi.ts';
import { PlacementPreview } from './view/PlacementPreview.ts';

// Placing a building in the scene: the build bar arms it with a kind the simulation knows (its
// roster row's `kind`: the chest) and disarms it when the choice is cleared or the bar closes.
// While armed, a ring on the turf under the pointer shows where it would stand (PlacementPreview:
// green where it can go, red where the simulation would refuse it), the bar says how or why not
// (`hint`), and a click on the island places it through Game.placeBlueprint. A refused click leaves
// it armed; a placed building disarms it and tells the bar (`onPlaced`). The placement of every
// other building, and the scene's own look of it, wait (docs/ui.md, Scope now).
//
// Rules: a press that moves CLICK_SLOP or more is the camera's drag, not a click, as for the debug
// panel's send-to-click; the preview reads the same refusal the simulation applies
// (buildings.ts blueprintRefusal), so green always means the click will place it. A change of the
// ring (moved, recoloured, shown or hidden) is a scene event ('game input'): on a paused page the
// temporal anti-aliasing shows a converged image until told the scene changed.

export class BlueprintPlacement implements PlacementHandle {

	private readonly game: Game;
	private readonly context: UiContext;
	private readonly preview = new PlacementPreview();
	/** the kind armed, or null */
	armed: string | null = null;
	/** while placing: the simulation's refusal of the spot, or null where it would place (the bar
	 * puts either in words: ui/data/words.ts, the catalogue's `build.place`) */
	hint: { refusal: string | null } | null = null;
	/** a building was placed */
	onPlaced: () => void = () => {};
	private down = false;
	private downX = 0;
	private downY = 0;
	private pointer: { x: number; y: number } | null = null;

	constructor( game: Game, context: UiContext ) {

		this.game = game;
		this.context = context;
		context.scene.add( this.preview.mesh );
		const canvas = context.canvas;
		canvas.addEventListener( 'pointerdown', this.onDown );
		canvas.addEventListener( 'pointermove', this.onMove );
		canvas.addEventListener( 'pointerup', this.onUp );
		canvas.addEventListener( 'pointerleave', this.onLeave );

	}

	/** What it draws, for the game to compile at start (GameView "First draws"). */
	get samples(): THREE.Object3D[] {

		return [ this.preview.mesh ];

	}

	/** A new simulation was installed (start, load): nothing armed. */
	reset(): void {

		this.arm( null );

	}

	/** Per frame: the preview follows the pointer (the camera may move under it). */
	update(): void {

		if ( this.armed ) this.showPreview();

	}

	arm( kind: string | null ): void {

		if ( this.armed === kind ) return;
		this.armed = kind;
		this.context.canvas.style.cursor = kind ? 'crosshair' : '';
		if ( kind ) this.showPreview();
		else {

			this.ring( null, false );
			this.hint = null;

		}

	}

	/** The ground under the pointer, or null. */
	private target(): Vec2 | null {

		if ( ! this.pointer ) return null;
		const { canvas, camera } = this.context;
		return groundPoint( pointerRay( canvas, camera, this.pointer.x, this.pointer.y ), this.game.sim.grid );

	}

	private showPreview(): void {

		const sim = this.game.sim, p = this.target();
		const reason = p && this.armed && blueprintRefusal( sim, this.armed, p );
		this.ring( p, p !== null && reason === null );
		this.hint = { refusal: reason || null };

	}

	private ring( p: Vec2 | null, ok: boolean ): void {

		const radius = buildingKind( this.armed )?.radius ?? 0;
		if ( this.preview.show( p, radius, ok, this.game.sim.grid ) ) this.context.sceneEvent( 'game input' );

	}

	private place( p: Vec2 ): void {

		if ( ! this.armed ) return;
		const reason = this.game.placeBlueprint( this.armed, p.x, p.z );
		if ( reason ) {

			this.hint = { refusal: reason };
			return;

		}
		this.arm( null );
		this.onPlaced();

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

}
