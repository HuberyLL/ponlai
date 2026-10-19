import type * as THREE from 'three/webgpu';
import type GUI from 'lil-gui';
import type { DayCycle } from '../sky/DayCycle.ts';
import type { SceneEventReason } from '../post/SceneEvents.ts';
import type { CharacterShadow } from '../characters/CharacterShadow.ts';
import type { Villager as Figure } from '../characters/Villagers.ts';
import type { LookColours } from '../characters/looks.ts';
import type { LandLattice } from '../world/IslandGrowth.ts';
import { GameHud } from './Hud.ts';
import { newGame, loadGame } from './sim/Sim.ts';
import { SAVE_KEY, savedPieces } from './sim/save.ts';
import type { Sim } from './sim/Sim.ts';
import { actionTools } from './sim/actions.ts';
import type { Brain, ToolRegistry, ToolResult } from './sim/agent.ts';
import { StandInBrain } from './sim/standin.ts';
import { GameView, propSamples } from './view/GameView.ts';
import { SECONDS_PER_GAME_DAY } from './sim/types.ts';
import type { TrampleWalker } from '../world/vegetation/Trample.ts';
import type { EntityId, IslandInput, Speed } from './sim/types.ts';

// The island as a game (?game): the simulation (src/game/sim) runs the islanders' bodies, their
// needs and the places they act at, a brain in its slot thinks for them (the stand-in of plain
// rules by default, sim/standin.ts) and GameView draws them and the chest into the scene.
// The player's interface is a prototype HUD (Hud.ts): a readout of the islander and the player's
// one act, setting the chest down as a blueprint the islander then builds (Placement.ts). The debug panel's Game folder (GameDebug.ts) and
// the methods below, reached from the console as window.__PONLAI__.game, drive the rest. The
// simulation's clock sets the time of day; the page's sky follows it, so pausing or speeding up the
// game turns the sky with it. The weather is the page's own, as without ?game, running on the day
// clock. Waves, wind and rain keep real time.
//
// URL options: hour (start hour, default 8), paused (start paused), load (resume the saved game),
// dayLength (real seconds per game day at 1x); see docs/tools.md.
//
// Rules: without ?game the page stays the art-review scene, unchanged. The game is the first
// prototype of docs/game-design.md ("Next"): nothing is built ahead of that design. The brain's
// tools are the five actions (sim/actions.ts). Thinking is asynchronous to the world: `think( id )`
// asks the brain with the islander's perception, the simulation never waits for the answer, the
// body goes on with what it is doing meanwhile, and the answer's tool calls run on the body when it
// arrives; one thought per islander may be in flight. What starts a thought is not decided: until
// it is, the simulation asks whenever an islander has nothing under way (sim/Sim.ts), and the
// console may ask with `think`. Walking is the body's motor, reached by the `go` action (walkTo is
// the debug panel's). The save is the state as JSON with a version number, in one slot. The ground
// comes from the world generator's own exports: the land (its walkable grid, sim/grid.ts, spans the
// land lattice's extent anchored to the world, so growth only opens cells). What changes the drawn scene at once (a simulation
// installed at start or load, the speed or the pause, a placed blueprint, the placement ring the
// pointer moves) tells the page through the context's `sceneEvent` (post/SceneEvents.ts), so the
// temporal anti-aliasing cuts its history or converges a paused frame again.
//
// The island grows with the population (docs/game-design.md, "How the island grows"): each frame
// `update` tells the page's island how near the next step is (`island.approach`, the sea floor's
// rise over the coming piece) and, once a step is due and nothing is growing, asks it to grow
// (`island.grow`, world/Growth.ts's instant swap). The swap hands the new land to `setIsland`,
// which is the simulation's `addPiece`: the piece is counted there, whoever asked for the growth,
// so the simulation's piece count is always the land step shown. The pending piece's land comes to
// `setComing` once the page has it, and the simulation exposes its cells (Sim.comingLand). A save
// keeps the piece count, and the page loads its world at it (world/WorldStart.ts; the `grow` URL
// option wins), so a game resumes on its own island; one loaded from the panel must stand on the
// island shown.

export interface GameContext {
	params: URLSearchParams;
	scene: THREE.Scene;
	camera: THREE.PerspectiveCamera;
	/** the canvas, for the debug panel's send-to-click */
	canvas: HTMLCanvasElement;
	/** the grown land, and the island's top from the world's chunks (sim/grid.ts topFromTiles) */
	land: LandLattice;
	top?: Uint8Array;
	dayCycle: DayCycle;
	characterShadow: CharacterShadow;
	/** a skinned islander figure for a look index, its pipelines compiled (GameView "First draws") */
	loadLook( look: number ): Promise<Figure>;
	/** the colours of a look index, for a stand-in figure (GameView) */
	lookColours( look: number ): LookColours;
	invalidateSunShadow(): void;
	/** an opaque prop the game draws spans this box: the sun's shadow casters and the sea's reflection box grow to hold it */
	holdOpaque( box: THREE.Box3 ): void;
	refreshEnvironment(): Promise<void>;
	/** compile the pipelines these objects will draw with (the scene's pass, the sun's shadow map) off the frame */
	compileDraws( objects: THREE.Object3D[] ): Promise<void>;
	/** a change of the scene for the temporal anti-aliasing (post/SceneEvents.ts: its table says which cut) */
	sceneEvent( reason: SceneEventReason ): void;
	/** the island's pieces the world was loaded with (its land step: the save's, or the `grow` URL option) */
	pieces: number;
	/** the page's growing island (world/Growth.ts): how near the next step is (0..1), and a grow that
	 * resolves once the next piece is in and every dependent has followed (`setIsland` included) */
	island: { approach( p: number ): void; grow(): Promise<void> };
}

// a stalled frame (a background tab, a debugger stop) resumes without running hours at once
const MAX_FRAME = 0.25;

// The simulation's island from the world generator's own exports: its land and top.
function islandInput( land: LandLattice, top?: Uint8Array ): IslandInput {

	return { land, top };

}

export class Game {

	static async start( context: GameContext ): Promise<Game> {

		const game = new Game( context );
		// a new game starts at the page's hour (the `hour` URL option), on the island loaded
		const sim = ( context.params.has( 'load' ) ? game.savedGame() : null ) ?? newGame( game.input, { startHour: context.dayCycle.hour, pieces: context.pieces } );
		// (a save stands on the world loaded for it, unless the `grow` URL option chose another)
		sim.state.pieces = context.pieces;
		if ( context.params.has( 'paused' ) ) sim.speed = 0;
		await game.begin( sim );
		return game;

	}

	sim!: Sim;
	private view: GameView | null = null;
	private readonly context: GameContext;
	private input: IslandInput;
	private debug: { update(): void; reset(): void } | null = null;
	private hud: GameHud | null = null;
	/** the tools a brain acts through, by name (sim/agent.ts): the five actions, kept across a load */
	readonly tools: ToolRegistry = actionTools();
	// the brain in the islanders' slot, kept across a load (setBrain)
	private brain: Brain | null = new StandInBrain();
	private gameDt = 0;
	private resumeSpeed: Speed = 1;
	// a grow asked of the page and not yet in
	private growing = false;
	// the pending piece's island, kept for a simulation installed later (a load)
	private coming: IslandInput | null = null;
	// frames rendered so far, and whether the props' pipelines are compiling (render)
	private framesDrawn = 0;
	private compiling = false;

	private constructor( context: GameContext ) {

		this.context = context;
		this.input = islandInput( context.land, context.top );

	}

	/** The island grew by a piece (Growth.ts's swap): the simulation's ground follows the new land,
	 * its top, and counts the piece (Sim.addPiece); a saved game loads onto it. */
	setIsland( land: LandLattice, top?: Uint8Array ): void {

		this.input = islandInput( land, top );
		this.coming = null;
		this.sim.addPiece( this.input );

	}

	/** The next piece is ready on the page (Growth.ts): the simulation sees its cells (Sim.comingLand). */
	setComing( land: LandLattice, top?: Uint8Array ): void {

		this.coming = islandInput( land, top );
		this.sim.setComing( this.coming );

	}

	/** A new islander near the island's middle (the debug panel's population bump); returns its id. */
	addIslander(): EntityId {

		const id = this.sim.addIslander();
		this.context.sceneEvent( 'game order' );
		return id;

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
		if ( this.coming ) sim.setComing( this.coming );
		this.view?.dispose();
		this.view = new GameView( { sim, scene: c.scene, camera: c.camera, characterShadow: c.characterShadow, invalidateSunShadow: c.invalidateSunShadow, holdOpaque: c.holdOpaque, loadLook: c.loadLook, lookColours: c.lookColours,
			ticksPerSecond: () => SECONDS_PER_GAME_DAY / c.dayCycle.dayLength } );
		this.sim = sim;
		c.sceneEvent( 'game begin' );
		this.debug?.reset();
		if ( this.hud ) this.hud.reset();
		else this.hud = new GameHud( this, c );
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
		this.grow();
		return this.gameDt * secondsPerDay / SECONDS_PER_GAME_DAY;

	}

	// The island follows the population: how near the next step is, and a grow once one is due and
	// none is under way. A grow that brought no piece (the growth horizon, a failed generation) is
	// not asked again.
	private grow(): void {

		const sim = this.sim, island = this.context.island;
		island.approach( sim.approach() );
		if ( this.growing || ! sim.growthDue() ) return;
		this.growing = true;
		const before = sim.state.pieces;
		island.grow().then( () => {

			if ( this.sim.state.pieces > before ) this.growing = false;

		} );

	}

	/** The islanders drawn, which part the meadow (world/vegetation/Trample.ts). */
	walkers(): readonly TrampleWalker[] {

		return this.view?.walkers() ?? [];

	}

	/** The time of day to draw: the simulation's hour, between its ticks. */
	hour(): number {

		return this.sim.hour() + this.sim.alpha / 3600;

	}

	/** After the scene's own updates: the islanders, their shadow, the HUD and the debug panel. */
	render( renderer: THREE.WebGPURenderer, sun: THREE.DirectionalLight, rawDt: number ): void {

		this.view?.update( renderer, sun, rawDt, this.gameDt );
		// Once a frame has drawn the scene, what can first show mid-game builds its pipelines, off
		// the frame, rather than in the frame it appears in (GameView "First draws"). Not sooner:
		// compiled during startup, the chest's main pass did not match the draw it was for (its
		// pipeline was built again when it appeared), and the sun's map is built by the first frame.
		if ( ! this.compiling && ++ this.framesDrawn > 1 ) {

			this.compiling = true;
			this.context.compileDraws( [ ...propSamples(), ...this.hud!.samples() ] ).catch( ( error: unknown ) => console.error( 'Could not compile the game\'s props', error ) );

		}
		this.hud?.update();
		this.debug?.update();

	}

	togglePause(): void {

		this.sim.speed = this.sim.speed === 0 ? this.resumeSpeed : 0;
		this.context.sceneEvent( 'game speed' );

	}

	setSpeed( speed: Speed ): void {

		this.sim.speed = speed;
		this.context.sceneEvent( 'game speed' );

	}

	/** Saves the game; says whether it was saved. Storage can be off (private windows, blocked site
	 * data), and then the game goes on unsaved instead of throwing. */
	save(): string {

		try {

			localStorage.setItem( SAVE_KEY, this.sim.save() );
			return 'Saved';

		} catch ( error ) {

			console.error( 'Could not save the game', error );
			return 'Could not save: this browser does not allow storage here';

		}

	}

	/** Resume the saved game; says whether it was loaded. A save stands on its own island: one of
	 * another piece count loads with the page (`?game&load`), not here. */
	async load(): Promise<string> {

		let json: string | null = null;
		try { json = localStorage.getItem( SAVE_KEY ); } catch { /* storage off: no save */ }
		const pieces = savedPieces( json );
		if ( pieces !== null && pieces !== this.sim.state.pieces ) return `The save stands on ${ pieces } pieces, this island on ${ this.sim.state.pieces }: reload with ?game&load`;
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

	/** Place a building of a kind (sim/buildings.ts: 'chest') at a point of the ground (world metres): null when it stands there, else why not. */
	placeBlueprint( kind: string, x: number, z: number ): string | null {

		const refusal = this.sim.placeBlueprint( kind, x, z );
		if ( refusal === null ) this.context.sceneEvent( 'game order' );
		return refusal;

	}

	/** Whether every islander shows on screen: the page keeps its loading screen until then. */
	ready(): boolean {

		return this.view?.ready ?? false;

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
