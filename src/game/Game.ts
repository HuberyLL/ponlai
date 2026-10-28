import type * as THREE from 'three/webgpu';
import type GUI from 'lil-gui';
import type { DayCycle } from '../sky/DayCycle.ts';
import type { SceneEventReason } from '../post/SceneEvents.ts';
import type { CharacterShadow } from '../characters/CharacterShadow.ts';
import { FIGURE_HEIGHT, type Villager as Figure } from '../characters/Villagers.ts';
import type { LookColours } from '../characters/looks.ts';
import { parseBodies, type Body } from '../characters/Ages.ts';
import type { LandLattice } from '../world/IslandGrowth.ts';
import { GameUi } from './ui/GameUi.ts';
import { newGame, loadGame } from './sim/Sim.ts';
import { initPhysics } from './sim/physics.ts';
import { SAVE_KEY, UNREAD_KEY, keepsSave, readSave, readSlot, resumesSave, savedPieces, writeSave } from './save.ts';
import type { Sim } from './sim/Sim.ts';
import { actionTools } from './sim/actions.ts';
import type { Brain, ToolRegistry, ToolResult } from './sim/agent.ts';
import { StandInBrain } from './sim/standin.ts';
import { GameView, propSamples } from './view/GameView.ts';
import { SECONDS_PER_GAME_DAY } from './sim/types.ts';
import type { TrampleWalker } from '../world/vegetation/Trample.ts';
import type { Weather, WeatherName } from '../sky/Weather.ts';
import { Chronicle } from './Chronicle.ts';
import type { RecordSave } from './Chronicle.ts';
import { stockOf } from './sim/stock.ts';
import type { EntityId, IslandInput, Items } from './sim/types.ts';

// The island as a game (?game): the simulation (src/game/sim) runs the islanders' bodies, their
// needs, the places they act at and the things on the ground (their rigid bodies in the physics
// world, sim/physics.ts, whose engine `start` loads before any simulation is made), a brain in its
// slot thinks for them (the stand-in of plain rules by default, sim/standin.ts) and GameView draws
// them, the chest and the things into the scene.
// The player's interface is 蜃光 (ui/GameUi.ts, docs/ui.md): the top row (day and time, pause and play,
// the weather and its forecast, the island's stock, the record), the islanders' tags and marks, the
// speak bar, the build bar (which hands a building the simulation knows to the placement in the
// scene, Placement.ts) and the record (沧海录), whose history the game keeps (Chronicle.ts). The debug panel's Game folder (GameDebug.ts) and
// the methods below, reached from the console as window.__PONLAI__.game, drive the rest. The
// simulation's clock sets the time of day; the page's sky follows it, so pausing the game stops the
// sky with it. The weather is the page's own, as without ?game, running on the day
// clock, and its auto chain read ahead is the game's forecast (`forecast`, in game hours). Waves,
// wind and rain keep real time. The player speaks to the islanders through `speak`: the words go
// into the record and, for a brain that hears, wait per listener for its next thought
// (`takeHeard`); the stand-in does not hear.
//
// URL options: hour (start hour, default 8), paused (start paused), load (resume the saved game),
// new (start a new game), autosave (on, off), dayLength (real seconds per game day at 1x); see
// docs/tools.md.
//
// Rules: without ?game the page stays the art-review scene, unchanged. The game is the first
// prototype of docs/game-design.md ("Next"): nothing is built ahead of that design. The brain's
// tools are the five actions (sim/actions.ts). Thinking is asynchronous to the world: `think( id )`
// asks the brain with the islander's perception, the simulation never waits for the answer, the
// body goes on with what it is doing meanwhile, and the answer's tool calls run on the body when it
// arrives; one thought per islander may be in flight. What starts a thought is not decided: until
// it is, the simulation asks whenever an islander has nothing under way (sim/Sim.ts), and the
// console may ask with `think`. Walking is the body's motor, reached by the `go` action (walkTo is
// the debug panel's). The save is the simulation's state (its physics world's snapshot
// taken as it saves) and the record as JSON with a version
// number, in one slot (save.ts, which says what is saved and how a save carries over to the next
// build). Where the page keeps it (`keepsSave`: not in an automated browser) the game resumes it at
// start and saves every AUTOSAVE_SECONDS while the page shows (only when something changed), and
// when the page is hidden or left; a save it cannot read is copied aside before the first save
// over it. The debug panel and the console save, load and start over by hand anywhere. The ground
// comes from the world generator's own exports: the land (its walkable grid, sim/grid.ts, spans the
// land lattice's extent anchored to the world, so growth only opens cells). What changes the drawn scene at once (a simulation
// installed at start or load, the pause, a placed blueprint, the placement ring the
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
	/** the page's weather: the sky the game shows, and its auto chain read ahead (the forecast) */
	weather: Weather;
	characterShadow: CharacterShadow;
	/** a skinned islander figure for a look index, with a body where the look takes one (Villagers.ts
	 * loadVillager), its pipelines compiled (GameView "First draws") */
	loadLook( look: number, body: Body ): Promise<Figure>;
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
// real seconds between the saves the page makes as the game runs: at most this much play is lost
// to a crash (a hidden or closed page saves at once)
const AUTOSAVE_SECONDS = 60;

// The simulation's island from the world generator's own exports: its land and top.
function islandInput( land: LandLattice, top?: Uint8Array ): IslandInput {

	return { land, top };

}

export class Game {

	static async start( context: GameContext ): Promise<Game> {

		// the physics engine's WebAssembly (sim/physics.ts), which every simulation's world needs
		await initPhysics();
		const game = new Game( context );
		// a new game starts at the page's hour (the `hour` URL option), on the island loaded
		const saved = resumesSave( context.params ) ? game.savedGame( game.keeps ) : null;
		const sim = saved?.sim ?? newGame( game.input, { startHour: game.startHour, pieces: context.pieces, bodies: game.bodies } );
		// (a save stands on the world loaded for it, unless the `grow` URL option chose another: then
		// its world's ground is this land's)
		if ( saved && sim.state.pieces !== context.pieces ) sim.physics.setGround( sim.state, sim.grid );
		sim.state.pieces = context.pieces;
		if ( context.params.has( 'paused' ) ) sim.paused = true;
		await game.begin( sim, saved?.record );
		if ( game.keeps ) {

			// a page hidden (another tab, a minimised window, a phone's app switch) may never show again
			document.addEventListener( 'visibilitychange', () => {

				if ( document.visibilityState === 'hidden' ) game.autosave();

			} );
			addEventListener( 'pagehide', () => game.autosave() );

		}
		return game;

	}

	sim!: Sim;
	private view: GameView | null = null;
	private readonly context: GameContext;
	private input: IslandInput;
	private debug: { update(): void; reset(): void } | null = null;
	/** the player's interface (null until the first simulation is installed) */
	ui: GameUi | null = null;
	/** the island's record (沧海录): what happened since the game was installed (Chronicle.ts) */
	readonly record = new Chronicle();
	// the player's words each islander has heard and no thought has taken yet (takeHeard)
	private readonly heard = new Map<EntityId, string[]>();
	/** the tools a brain acts through, by name (sim/agent.ts): the five actions, kept across a load */
	readonly tools: ToolRegistry = actionTools();
	// the brain in the islanders' slot, kept across a load (setBrain)
	private brain: Brain | null = new StandInBrain();
	private gameDt = 0;
	// a grow asked of the page and not yet in
	private growing = false;
	// the pending piece's island, kept for a simulation installed later (a load)
	private coming: IslandInput | null = null;
	// frames rendered so far, and whether the props' pipelines are compiling (render)
	private framesDrawn = 0;
	private compiling = false;

	/** whether the page keeps the save itself: resumes it at start and saves as the game runs (save.ts) */
	readonly keeps: boolean;
	/** when the game was last saved (ms since the epoch), by hand or by the page; null: not since the page loaded */
	savedAt: number | null = null;
	// the hour a new game starts at: the page's (the `hour` URL option)
	private readonly startHour: number;
	// the next autosave (performance.now ms), the game as last saved (to skip a save of no change),
	// and whether the last one failed (said once, not every minute)
	private nextSave = 0;
	private lastSaved = '';
	private saveFailed = false;
	// the sexes and ages a new game's islanders start at instead of the simulation's three (the
	// `bodies` URL option, Ages.ts parseBodies)
	private readonly bodies: Body[];

	private constructor( context: GameContext ) {

		this.context = context;
		this.input = islandInput( context.land, context.top );
		this.keeps = keepsSave( context.params );
		this.startHour = context.dayCycle.hour;
		this.bodies = parseBodies( context.params.get( 'bodies' ) );

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

	/** The saved game, or null when there is none or it cannot be read. One that cannot be read is
	 * copied aside (UNREAD_KEY) when `setAside`: the page is about to save over it. */
	private savedGame( setAside = false ): { sim: Sim; record: RecordSave } | null {

		const json = readSlot();
		if ( json === null ) return null;
		const save = readSave( json );
		try {

			if ( save ) return { sim: loadGame( save.sim, this.input ), record: save.record };

		} catch ( error ) {

			console.error( 'Could not load the saved game', error );

		}
		if ( setAside ) {

			try {

				localStorage.setItem( UNREAD_KEY, json );
				console.warn( `The saved game could not be read by this build: kept as ${ UNREAD_KEY }, and a new game started` );

			} catch { /* storage refused: the slot is not written either */ }

		}
		return null;

	}

	/** Install a simulation (and its record, for a saved game): its tools and brain, a fresh view,
	 * and the day clock set to its hour at once. */
	private async begin( sim: Sim, record?: RecordSave ): Promise<void> {

		const c = this.context;
		sim.tools = this.tools;
		sim.brain = this.brain;
		if ( this.coming ) sim.setComing( this.coming );
		this.view?.dispose();
		// the simulation replaced lets its physics world go (its WebAssembly memory)
		if ( this.sim && this.sim !== sim ) this.sim.dispose();
		this.view = new GameView( { sim, scene: c.scene, camera: c.camera, characterShadow: c.characterShadow, invalidateSunShadow: c.invalidateSunShadow, holdOpaque: c.holdOpaque, loadLook: c.loadLook, lookColours: c.lookColours,
			body: ( v ) => ( { sex: v.sex, age: sim.age( v ) } ),
			ticksPerSecond: () => SECONDS_PER_GAME_DAY / c.dayCycle.dayLength } );
		this.sim = sim;
		this.record.reset();
		if ( record ) this.record.restore( record );
		this.heard.clear();
		this.lastSaved = '';
		this.nextSave = performance.now() + AUTOSAVE_SECONDS * 1000;
		// the record's first look, before any tick: a new game's islanders land at its start
		this.record.observe( sim, this.weatherNow().shown, 0 );
		c.sceneEvent( 'game begin' );
		this.debug?.reset();
		if ( this.ui ) this.ui.reset();
		else this.ui = new GameUi( this, c );
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
			this.context.compileDraws( [ ...propSamples(), ...this.ui!.samples() ] ).catch( ( error: unknown ) => console.error( 'Could not compile the game\'s props', error ) );

		}
		this.record.observe( this.sim, this.weatherNow().shown, this.gameDt / 3600 );
		this.ui?.update();
		this.debug?.update();
		if ( this.keeps && performance.now() >= this.nextSave ) this.autosave();

	}

	togglePause(): void {

		this.setPaused( ! this.sim.paused );

	}

	setPaused( paused: boolean ): void {

		this.sim.paused = paused;
		this.context.sceneEvent( 'game pause' );

	}

	/** Saves the game and its record; says whether it was saved. Storage can be off (private
	 * windows, blocked site data) or full, and then the game goes on unsaved instead of throwing. */
	save(): string {

		// what happened since the frame's look goes in too (the panel's click comes between frames)
		this.record.observe( this.sim, this.weatherNow().shown, 0 );
		// the state with its physics world's snapshot taken now (sim/Sim.ts snapshot)
		const sim = this.sim.snapshot(), record = this.record.save();
		try {

			localStorage.setItem( SAVE_KEY, writeSave( sim, record ) );
			this.savedAt = Date.now();
			this.lastSaved = JSON.stringify( { sim, record } );
			this.saveFailed = false;
			return 'Saved';

		} catch ( error ) {

			if ( ! this.saveFailed ) console.error( 'Could not save the game', error );
			this.saveFailed = true;
			return 'Could not save: this browser does not allow storage here, or it is full';

		}

	}

	/** The page's own save, as the game runs and as the page is hidden or left: skipped when
	 * nothing changed since the last. */
	autosave(): void {

		this.nextSave = performance.now() + AUTOSAVE_SECONDS * 1000;
		this.record.observe( this.sim, this.weatherNow().shown, 0 );
		if ( JSON.stringify( { sim: this.sim.snapshot(), record: this.record.save() } ) !== this.lastSaved ) this.save();

	}

	/** Resume the saved game; says whether it was loaded. A save stands on its own island: one of
	 * another piece count loads with the page (`?game&load`), not here. */
	async load(): Promise<string> {

		const pieces = savedPieces( readSlot() );
		if ( pieces !== null && pieces !== this.sim.state.pieces ) return `The save stands on ${ pieces } pieces, this island on ${ this.sim.state.pieces }: reload with ?game&load`;
		const saved = this.savedGame();
		if ( ! saved ) return 'No saved game was loaded';
		await this.begin( saved.sim, saved.record );
		return 'Loaded';

	}

	/** A new game on the island shown, at the page's start hour; where the page keeps the save it
	 * replaces the saved game at once. */
	async startOver(): Promise<string> {

		await this.begin( newGame( this.input, { startHour: this.startHour, pieces: this.sim.state.pieces, bodies: this.bodies } ) );
		if ( this.keeps ) this.autosave();
		return this.keeps ? 'New game, saved over the old one' : 'New game';

	}

	/** Whether the brain hears the player's words (sim/agent.ts Brain.hears): the interface keeps
	 * the characters that land for its next thought only then. */
	hears(): boolean {

		return this.brain?.hears ?? false;

	}

	/** The brain that thinks for the islanders (sim/agent.ts Brain; null: none), kept across a load. */
	setBrain( brain: Brain | null ): void {

		this.brain = brain;
		this.heard.clear();
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

	/** The weather now: the sky the front under way left and the one it moves to, how far along it
	 * is (0..1; 1 with no front), and the sky shown (the nearer of the two). */
	weatherNow(): { from: WeatherName; to: WeatherName; progress: number; shown: WeatherName } {

		const w = this.context.weather, from = w.origin, to = w.target, progress = w.progress;
		return { from, to, progress, shown: progress < 0.5 ? from : to };

	}

	/** The weather's turns over the next `hours` game hours, read ahead from its auto chain
	 * (Weather.forecast): each front's start and length in game hours from now (the front under way
	 * first, its start negative), and the skies it moves between. */
	forecast( hours: number ): { at: number; duration: number; from: WeatherName; to: WeatherName }[] {

		// the weather runs on the day clock: a game hour is a 24th of the day's length
		const perHour = this.context.dayCycle.dayLength / 24;
		return this.context.weather.forecast( hours * perHour ).map( ( turn ) => ( { at: turn.at / perHour, duration: turn.duration / perHour, from: turn.from, to: turn.to } ) );

	}

	/** What the island holds: its stores' items by kind (sim/stock.ts). */
	stock(): Items {

		return stockOf( this.sim.state );

	}

	/** The player speaks: words to some islanders (their ids) or to everyone. They go into the
	 * record; for a brain that hears, each listener keeps them until a thought takes them
	 * (takeHeard), and is asked for one now. */
	speak( words: string, to: EntityId[] | 'all' ): void {

		const text = words.trim();
		if ( ! text ) return;
		this.record.add( this.sim, { kind: 'said', who: 'player', to, text } );
		if ( ! this.brain?.hears ) return;
		const listeners = to === 'all' ? this.sim.state.villagers.map( ( v ) => v.id ) : to;
		for ( const id of listeners ) {

			let lines = this.heard.get( id );
			if ( ! lines ) this.heard.set( id, lines = [] );
			lines.push( text );

		}
		// (Sim.think: not while a thought is in flight; the words then wait for the next)
		for ( const id of listeners ) this.sim.think( id );

	}

	/** An islander says something (the `say` action on their body: the debug panel's and the
	 * console's; a brain says through its tools). Null when said, else why not. */
	say( id: EntityId, words: string ): string | null {

		const v = this.sim.villager( id ), say = this.tools.get( 'say' );
		if ( ! v || ! say ) return 'No such islander';
		const result = say( v, { words }, this.sim );
		return result.ok ? null : result.reason;

	}

	/** Set an islander's need by hand (the debug panel's: to see the interface's ramps and alerts). */
	setNeed( id: EntityId, need: 'satiety' | 'hydration', value: number ): void {

		const v = this.sim.villager( id );
		if ( v ) v.needs[ need ] = Math.min( Math.max( value, 0 ), 100 );

	}

	/** The player's words an islander has heard since the last call for it, oldest first (for a
	 * brain that hears: hearing the leader is designed with the language model). */
	takeHeard( id: EntityId ): string[] {

		const lines = this.heard.get( id ) ?? [];
		this.heard.delete( id );
		return lines;

	}

	/** Whether the player's words wait for an islander's next thought. */
	hasHeard( id: EntityId ): boolean {

		return ( this.heard.get( id )?.length ?? 0 ) > 0;

	}

	/** Where an islander stands as drawn (its feet, world metres), into `out`; false while not drawn. */
	anchor( id: EntityId, out: THREE.Vector3 ): boolean {

		return this.view?.anchor( id, out ) ?? false;

	}

	/** An islander's height as drawn (m, feet to crown), which the interface's marks hang over. */
	figureHeight( id: EntityId ): number {

		return this.view?.figureHeight( id ) ?? FIGURE_HEIGHT;

	}

	/** Whether every islander shows on screen and the interface's fonts are in: the page keeps its
	 * loading screen until then. */
	ready(): boolean {

		return ( this.view?.ready ?? false ) && ( this.ui?.ready ?? false );

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
