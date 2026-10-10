import type * as THREE from 'three/webgpu';
import type GUI from 'lil-gui';
import type { DayCycle } from '../sky/DayCycle.ts';
import type { CharacterShadow } from '../characters/CharacterShadow.ts';
import type { Villager as Figure } from '../characters/Villagers.ts';
import { drawnFoliageSites } from '../world/FoliageSites.ts';
import { newGame, loadGame } from './sim/Sim.ts';
import type { Sim } from './sim/Sim.ts';
import type { Brain, ToolRegistry, ToolResult } from './sim/agent.ts';
import { GameView } from './view/GameView.ts';
import { SECONDS_PER_GAME_DAY } from './sim/types.ts';
import type { EntityId, IslandInput, Speed } from './sim/types.ts';

// The island as a game (?game): the simulation (src/game/sim) runs the islanders' bodies, a brain
// in its slot may think for them (none by default: they stand idle) and GameView draws them into
// the scene. There is no player interface: the debug panel's Game folder
// (GameDebug.ts) and the methods below, reached from the console as window.__PONLAI__.game, drive
// it. The simulation's clock sets the time of day; the page's sky follows it, so pausing or
// speeding up the game turns the sky with it. The weather is the page's own, as without ?game,
// running on the day clock. Waves, wind and rain keep real time.
//
// URL options: hour (start hour, default 8), paused (start paused), load (resume the saved game).

export interface GameContext {
	params: URLSearchParams;
	scene: THREE.Scene;
	camera: THREE.PerspectiveCamera;
	/** the canvas, for the debug panel's send-to-click */
	canvas: HTMLCanvasElement;
	/** turf anchors from the world generator (WorldData.vegetation) */
	vegetation: Float32Array;
	dayCycle: DayCycle;
	characterShadow: CharacterShadow;
	loadLook( look: number ): Promise<Figure>;
	invalidateSunShadow(): void;
	refreshEnvironment(): Promise<void>;
}

// the one save slot
const SAVE_KEY = 'ponlai.game';
// a stalled frame (a background tab, a debugger stop) resumes without running hours at once
const MAX_FRAME = 0.25;

// The simulation's island from the world generator's own exports: the bushes buildFoliage draws,
// so the game's obstacles are exactly what is drawn.
function islandInput( vegetation: Float32Array ): IslandInput {

	return {
		bushes: drawnFoliageSites( vegetation ).map( ( s ) => ( { x: s.x, z: s.z, r: s.r } ) ),
	};

}

export class Game {

	static async start( context: GameContext ): Promise<Game> {

		const game = new Game( context );
		// a new game starts at the page's hour (the `hour` URL option)
		const sim = ( context.params.has( 'load' ) ? game.savedGame() : null ) ?? newGame( game.input, { startHour: context.dayCycle.hour } );
		if ( context.params.has( 'paused' ) ) sim.speed = 0;
		await game.begin( sim );
		return game;

	}

	sim!: Sim;
	private view: GameView | null = null;
	private readonly context: GameContext;
	private readonly input: IslandInput;
	private debug: { update(): void; reset(): void } | null = null;
	/** the tools a brain acts through, by name (sim/agent.ts): empty, kept across a load */
	readonly tools: ToolRegistry = new Map();
	// the brain in the islanders' slot, kept across a load (setBrain)
	private brain: Brain | null = null;
	private gameDt = 0;
	private resumeSpeed: Speed = 1;

	private constructor( context: GameContext ) {

		this.context = context;
		this.input = islandInput( context.vegetation );

	}

	/** The saved game, or null when there is none or it cannot be read. */
	private savedGame(): Sim | null {

		try {

			const json = localStorage.getItem( SAVE_KEY );
			return json === null ? null : loadGame( json, this.input );

		} catch ( error ) {

			console.error( 'Could not load the saved game', error );
			return null;

		}

	}

	/** Install a simulation: its tools and brain, a fresh view, and the day clock set to its hour at once. */
	private async begin( sim: Sim ): Promise<void> {

		const c = this.context;
		sim.tools = this.tools;
		sim.brain = this.brain;
		this.view?.dispose();
		this.view = new GameView( { sim, scene: c.scene, camera: c.camera, characterShadow: c.characterShadow, loadLook: c.loadLook } );
		this.sim = sim;
		this.debug?.reset();
		// the simulation owns the time of day; the day clock only follows it
		c.dayCycle.paused = false;
		const before = c.dayCycle.hour;
		c.dayCycle.setHour( sim.hour() );
		c.invalidateSunShadow();
		// at start the page has just lit the sky for this hour
		if ( c.dayCycle.hour !== before ) await c.refreshEnvironment();

	}

	/** Advance the simulation; returns the day clock's seconds to advance the sky and the page's weather by. */
	update( rawDt: number ): number {

		const secondsPerDay = this.context.dayCycle.dayLength;
		// a speed set directly (the debug panel, the console) is the one Space resumes
		if ( this.sim.speed !== 0 ) this.resumeSpeed = this.sim.speed;
		this.gameDt = this.sim.advance( Math.min( Math.max( rawDt, 0 ), MAX_FRAME ), secondsPerDay );
		return this.gameDt * secondsPerDay / SECONDS_PER_GAME_DAY;

	}

	/** The time of day to draw: the simulation's hour, between its ticks. */
	hour(): number {

		return this.sim.hour() + this.sim.alpha / 3600;

	}

	/** After the scene's own updates: the islanders, their shadow and the debug panel. */
	render( renderer: THREE.WebGPURenderer, sun: THREE.DirectionalLight, rawDt: number ): void {

		this.view?.update( renderer, sun, rawDt, this.gameDt );
		this.debug?.update();

	}

	togglePause(): void {

		this.sim.speed = this.sim.speed === 0 ? this.resumeSpeed : 0;

	}

	setSpeed( speed: Speed ): void {

		this.sim.speed = speed;

	}

	save(): void {

		localStorage.setItem( SAVE_KEY, this.sim.save() );

	}

	/** Resume the saved game; says whether it was loaded. */
	async load(): Promise<string> {

		const sim = this.savedGame();
		if ( ! sim ) return 'No saved game was loaded';
		await this.begin( sim );
		return 'Loaded';

	}

	/** The brain that thinks for the islanders (sim/agent.ts Brain; null: none), kept across a load. */
	setBrain( brain: Brain | null ): void {

		this.brain = brain;
		this.sim.brain = brain;

	}

	/** Ask the brain to think for an islander now (Sim.think): the results of its tool calls once they ran, or null. */
	think( villager: EntityId ): Promise<ToolResult[]> | null {

		return this.sim.think( villager );

	}

	/** Walk an islander's body to a point of the ground (world metres): null when it sets off, else why not. */
	walkTo( villager: EntityId, x: number, z: number ): string | null {

		return this.sim.walkTo( villager, { x, z } );

	}

	/** The figures' shadow map follows this islander (null: the one nearest the view's middle). */
	focus( villager: EntityId | null ): void {

		if ( this.view ) this.view.focus = villager;

	}

	/** The Game folder in the scene's debug panel (H). */
	async addDebugFolder( gui: GUI ): Promise<void> {

		const { GameDebug } = await import( './GameDebug.ts' );
		this.debug = new GameDebug( this, gui, this.context.camera, this.context.canvas );

	}

}
