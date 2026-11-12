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
import { newGame } from './sim/Sim.ts';
import { topFromTiles } from './sim/grid.ts';
import { SAVE_KEY, UNREAD_KEY, keepsSave, readSlot, resumesSave, savedPieces } from './save.ts';
import type { Sim } from './sim/Sim.ts';
import type { Brain, ToolResult } from './sim/agent.ts';
import type { SimEvent } from './sim/events.ts';
import { GameView, propSamples } from './view/GameView.ts';
import { SECONDS_PER_GAME_DAY } from './sim/types.ts';
import type { TrampleWalker } from '../world/vegetation/Trample.ts';
import type { Weather, WeatherName } from '../sky/Weather.ts';
import type { Chronicle, RecordSave } from './Chronicle.ts';
import { Session } from './Session.ts';
import { stockOf } from './sim/stock.ts';
import type { EntityId, IslandInput, Items } from './sim/types.ts';

// The island as a game (?game): the game around its simulation runs headless in a session
// (Session.ts: the simulation of src/game/sim, which runs the islanders' bodies, their needs and the
// places they act at; its record, Chronicle.ts; the brain in its slot, the stand-in of plain rules by
// default, sim/standin.ts; the leader's words; the save's contents; the island's growth), and the
// page hosts it here: GameView draws the islanders and the chest into the scene.
// The player's interface is 蜃光 (ui/GameUi.ts, docs/explanation/ui.md): the top row (day and time, pause and play,
// the weather and its forecast, the island's stock, the record), the islanders' tags and marks, the
// speak bar, the build bar (which hands a building the simulation knows to the placement in the
// scene, Placement.ts) and the record (沧海录), whose history the session keeps. The debug panel's Game folder (GameDebug.ts) and
// the methods below, reached from the console as window.__PONLAI__.game, drive the rest. The
// simulation's clock sets the time of day; the page's sky follows it, so pausing the game stops the
// sky with it. The weather is the page's own, as without ?game, running on the day
// clock, and its auto chain read ahead is the game's forecast (`forecast`, in game hours). Waves,
// wind and rain keep real time. The player speaks to the islanders through `speak` (Session.speak:
// the words go into the record and, for a brain that hears, wait per listener for its next
// thought); the stand-in does not hear. What happened reaches the interface as the simulation's
// events, which the session hands to whoever listens (`listen`, Session.listen; sim/events.ts),
// never by watching the state for changes.
//
// A frame: `update` advances the session (a growth due asked for, the ticks, how near the next step
// is: Session.advance) and returns the day clock's seconds the page steps the sky and the weather
// by; `render` draws the islanders, and the record notes the sky the weather then shows
// (Session.look).
//
// URL options: hour (start hour, default 8), paused (start paused), load (resume the saved game),
// new (start a new game), autosave (on, off), dayLength (real seconds per game day at 1x); see
// docs/reference/url-options.md.
//
// Rules: without ?game the page stays the art-review scene, unchanged. The game follows
// docs/explanation/game-design.md: nothing is built ahead of that design. The brain's
// tools are the five actions (sim/actions.ts). Thinking is asynchronous to the world: `think( id )`
// asks the brain with the islander's perception, the simulation never waits for the answer, the
// body goes on with what it is doing meanwhile, and the answer's tool calls run on the body when it
// arrives; one thought per islander may be in flight. What starts a thought is not decided: until
// it is, the simulation asks whenever an islander has nothing under way (sim/Sim.ts), and the
// console may ask with `think`. Walking is the body's motor, reached by the `go` action (walkTo is
// the debug panel's). The save is the simulation's state and the record as JSON with a version
// number, in one slot (Session.save, save.ts, which says what is saved and how a save carries over
// to the next build). Where the page keeps it (`keepsSave`: not in an automated browser) the game resumes it at
// start and saves every AUTOSAVE_SECONDS while the page shows (only when something changed), and
// when the page is hidden or left; a save it cannot read is copied aside before the first save
// over it. The debug panel and the console save, load and start over by hand anywhere. The ground
// comes from the world generator's own exports: the land (its walkable grid, sim/grid.ts, spans the
// land lattice's extent anchored to the world, so growth only opens cells). What changes the drawn scene at once (a simulation
// installed at start or load, the pause, a placed blueprint, the placement ring the
// pointer moves) tells the page through the context's `sceneEvent` (post/SceneEvents.ts), so the
// temporal anti-aliasing cuts its history or converges a paused frame again.
//
// The island grows with the population (docs/explanation/game-design.md, "How the island grows"; Session.ts):
// the session asks the page's island to grow once a step is due (`island.grow`, world/Growth.ts's
// instant swap) and tells it each frame how near the next step is (`island.approach`, the sea
// floor's rise over the coming piece). The swap hands the new land to `setIsland`, which is the
// session's (the simulation's `addPiece`: the piece is counted there, whoever asked for the growth,
// so the simulation's piece count is always the land step shown). The pending piece's land comes to
// `setComing` once the page has it, and the simulation exposes its cells (Sim.comingLand). A save
// keeps the piece count, and the page loads its world at it (WorldBoot.ts; the `grow` URL
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
// the world's chunks as the game reads them: their walk tiles (sim/grid.ts topFromTiles)
type WalkTiles = Parameters<typeof topFromTiles>[ 0 ];

function islandInput( land: LandLattice, top?: Uint8Array ): IslandInput {

	return { land, top };

}

export class Game {

	static async start( context: GameContext ): Promise<Game> {

		const game = new Game( context );
		// a new game starts at the page's hour (the `hour` URL option), on the island loaded
		const saved = resumesSave( context.params ) ? game.savedGame( game.keeps ) : null;
		const sim = saved?.sim ?? newGame( game.session.island, { startHour: game.startHour, pieces: context.pieces, bodies: game.bodies } );
		// (a save stands on the world loaded for it, unless the `grow` URL option chose another)
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

	/** the game around the simulation, headless (Session.ts): the simulation, its record, the brain,
	 * the leader's words, the island's growth */
	readonly session: Session;
	private view: GameView | null = null;
	private readonly context: GameContext;
	private debug: { update(): void; reset(): void } | null = null;
	/** the player's interface (null until the first simulation is installed) */
	ui: GameUi | null = null;
	// the ticks the last frame ran
	private gameDt = 0;
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
		this.session = new Session( islandInput( context.land, context.top ), { grow: () => context.island.grow(), approach: ( p ) => context.island.approach( p ) } );
		this.keeps = keepsSave( context.params );
		this.startHour = context.dayCycle.hour;
		this.bodies = parseBodies( context.params.get( 'bodies' ) );

	}

	/** The simulation installed (Session.sim). */
	get sim(): Sim {

		return this.session.sim;

	}

	/** The island's record (沧海录): what happened since the simulation was installed (Chronicle.ts). */
	get record(): Chronicle {

		return this.session.record;

	}

	/** The island grew by a piece (Growth.ts's swap): the simulation's ground follows the new land,
	 * its top from the world's chunks on it (their walk tiles, sim/grid.ts topFromTiles), and counts
	 * the piece (Session.setIsland); a saved game loads onto it. */
	setIsland( land: LandLattice, chunks: WalkTiles ): void {

		this.session.setIsland( islandInput( land, topFromTiles( chunks ) ) );

	}

	/** The next piece is ready on the page (Growth.ts), with the world's chunks on it: the simulation
	 * sees its cells (Session.setComing). */
	setComing( land: LandLattice, chunks: WalkTiles ): void {

		this.session.setComing( islandInput( land, topFromTiles( chunks ) ) );

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
		try {

			const saved = this.session.read( json );
			if ( saved ) return saved;

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

	/** Install a simulation (and its record, for a saved game) in the session (Session.install: its
	 * brain, the record, its events so far), a fresh view, and the day clock set to its hour at
	 * once. */
	private async begin( sim: Sim, record?: RecordSave ): Promise<void> {

		const c = this.context;
		this.session.install( sim, record );
		this.view?.dispose();
		this.view = new GameView( { sim, scene: c.scene, camera: c.camera, characterShadow: c.characterShadow, invalidateSunShadow: c.invalidateSunShadow, holdOpaque: c.holdOpaque, loadLook: c.loadLook, lookColours: c.lookColours,
			body: ( v ) => ( { sex: v.sex, age: sim.age( v ) } ),
			ticksPerSecond: () => SECONDS_PER_GAME_DAY / c.dayCycle.dayLength } );
		this.lastSaved = '';
		this.nextSave = performance.now() + AUTOSAVE_SECONDS * 1000;
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

	/** Advance the session by a frame (Session.advance: the island's growth, the simulation); returns
	 * the day clock's seconds to advance the sky and the page's weather by. */
	update( rawDt: number ): number {

		const secondsPerDay = this.context.dayCycle.dayLength;
		this.gameDt = this.session.advance( Math.min( Math.max( rawDt, 0 ), MAX_FRAME ), secondsPerDay );
		return this.gameDt * secondsPerDay / SECONDS_PER_GAME_DAY;

	}

	/** The islanders drawn, which part the meadow (world/vegetation/Trample.ts). */
	walkers(): readonly TrampleWalker[] {

		return this.view?.walkers() ?? [];

	}

	/** The time of day to draw: the simulation's hour, between its ticks. */
	hour(): number {

		return this.sim.hour() + this.sim.alpha / 3600;

	}

	/** After the scene's own updates: the islanders, their shadow, the record's look at the frame
	 * with the sky now shown, the HUD and the debug panel. */
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
		this.session.look( this.weatherNow().shown );
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
		const json = this.session.save( this.weatherNow().shown );
		try {

			localStorage.setItem( SAVE_KEY, json );
			this.savedAt = Date.now();
			this.lastSaved = this.contents();
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
		this.session.look( this.weatherNow().shown );
		if ( this.contents() !== this.lastSaved ) this.save();

	}

	// what a save holds, without the time it was written: equal when nothing changed since
	private contents(): string {

		return JSON.stringify( { sim: this.sim.state, record: this.record.save() } );

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

		await this.begin( newGame( this.session.island, { startHour: this.startHour, pieces: this.sim.state.pieces, bodies: this.bodies } ) );
		if ( this.keeps ) this.autosave();
		return this.keeps ? 'New game, saved over the old one' : 'New game';

	}

	/** Whether the brain hears the player's words (sim/agent.ts Brain.hears): the interface keeps
	 * the characters that land for its next thought only then. */
	hears(): boolean {

		return this.session.hears();

	}

	/** The brain that thinks for the islanders (sim/agent.ts Brain; null: none), kept across a load
	 * (Session.setBrain). */
	setBrain( brain: Brain | null ): void {

		this.session.setBrain( brain );

	}

	/** Ask the brain to think for an islander now (Sim.think): the results of its tool calls once they ran, or null. */
	think( villager: EntityId ): Promise<ToolResult[]> | null {

		return this.sim.think( villager );

	}

	/** Walk an islander's body to a point of the ground (world metres): null when it sets off, else why not. */
	walkTo( villager: EntityId, x: number, z: number ): string | null {

		return this.sim.walkTo( villager, { x, z } );

	}

	/** Place a building of a kind (sim/registry.ts BuildingDef: today's chest in sim/content/chest.ts) at a point of the ground (world metres): null when it stands there, else why not. */
	placeBlueprint( kind: string, x: number, z: number ): string | null {

		const refusal = this.session.place( kind, x, z );
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

	/** The player speaks: words to some islanders (their ids) or to everyone (Session.speak: an
	 * event, and for a brain that hears to each listener's next thought, asked for now). Null when
	 * said, else why not. */
	speak( words: string, to: EntityId[] | 'all' ): string | null {

		return this.session.speak( words, to );

	}

	/** Hear the simulation's events, in order (Session.listen); returns the call that stops it. */
	listen( listener: ( event: SimEvent ) => void ): () => void {

		return this.session.listen( listener );

	}

	/** Tool calls for an islander, `[ { tool, args } ]` (the five actions, sim/actions.ts: the
	 * console's), through the entrance a brain's answer takes (Session.act): each call's result. */
	act( id: EntityId, calls: unknown ): ToolResult[] {

		return this.session.act( id, calls );

	}

	/** An islander says something (the `say` action, through the entrance a brain's calls take:
	 * the debug panel's and the console's). Null when said, else why not. */
	say( id: EntityId, words: string ): string | null {

		const [ result ] = this.session.act( id, [ { tool: 'say', args: { words } } ] );
		return result.ok ? null : result.reason;

	}

	/** Set an islander's need by hand (the debug panel's: to see the interface's ramps and alerts). */
	setNeed( id: EntityId, need: string, value: number ): void {

		this.sim.setNeed( id, need, value );

	}

	/** The player's words an islander has heard since the last call for it, oldest first
	 * (Session.takeHeard). */
	takeHeard( id: EntityId ): string[] {

		return this.session.takeHeard( id );

	}

	/** Whether the player's words wait for an islander's next thought (Session.hasHeard). */
	hasHeard( id: EntityId ): boolean {

		return this.session.hasHeard( id );

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
