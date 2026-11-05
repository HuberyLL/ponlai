import type { WeatherName } from '../sky/Weather.ts';
import { Chronicle } from './Chronicle.ts';
import type { RecordSave } from './Chronicle.ts';
import { readSave, writeSave } from './save.ts';
import { loadGame } from './sim/Sim.ts';
import type { Sim } from './sim/Sim.ts';
import { actionTools } from './sim/actions.ts';
import type { Brain, ToolRegistry } from './sim/agent.ts';
import { StandInBrain } from './sim/standin.ts';
import type { EntityId, IslandInput } from './sim/types.ts';

// The game around its simulation, without the page: the simulation installed (sim/Sim.ts) and its
// record (Chronicle.ts), the brain in the islanders' slot and the tools it acts through, the
// leader's words as each listener hears them, the island's growth asked of a host, and the save of
// the simulation with its record (save.ts). The page's game (Game.ts) hosts it beside the view, the
// interface, the scene events and the autosave; tools/play-game.mjs hosts it headless, so a run in
// node plays the game the page plays, with nothing copied. No three.js or DOM: node runs it by
// stripping types, as it runs sim/.
//
// A frame: `advance` asks for a growth that is due, runs the simulation's ticks (Sim.advance) and
// tells the host how near the next step is; the host shows the frame (on the page the day clock and
// the weather step by the seconds `advance` returns), and then the record looks at it (`look`) with
// the sky shown over its ticks. The look is a call of its own because the sky it notes is the one
// shown after the weather's step. What the host does between frames comes in at the next frame:
// the leader's words (`speak`), a blueprint placed (the record's next look notes it as the
// player's, Chronicle.ts), an islander added (a growth it makes due is asked for at the next
// `advance`).
//
// Installing a simulation (`install`: a new game, a load) hands it the tools and the brain, and the
// coming piece once the host has it; the record starts over (or takes a saved one back), the words
// no thought has taken are forgotten, and the record's first look, before any tick, lands a new
// game's islanders at its start. So a host adds the islanders a game starts with before installing
// it.
//
// The leader's words (`speak`) go into the record as the player's; for a brain that hears
// (Brain.hears) each listener keeps them until a thought takes them (`takeHeard`, `hasHeard`), and
// is asked for one at once (Sim.think: not while one is in flight; the words then wait for the next).
//
// The island grows with the population (docs/game-design.md, "How the island grows"; Sim.ts): once
// a step is due and none is under way, `advance` asks the host's `grow`, before the frame's ticks,
// so on the state the last frame showed. The host hands the piece back through `setIsland`, which
// is the simulation's `addPiece` (the piece is counted there, whoever asked for it): at once
// (headless) or once its promise resolves (the page's swap, world/Growth.ts). A grow that brought
// no piece (the growth horizon, a failed generation, a headless run that does not grow) is not
// asked again. The pending piece comes to `setComing` once the host has it, and goes to a
// simulation installed later too.
//
// Rules: nothing here reads the page, and only the save reads the wall clock (the time it was
// written, save.ts); the rest is a function of the host's calls, so a headless run with a brain
// that answers at once repeats byte for byte.

/** What a session asks of its host (the page's game, a headless run). */
export interface SessionHost {
	/** Grow the island by the next piece, a step being due: the host hands it back through
	 * `setIsland`, before returning or by the time the promise resolves (the page's swap). */
	grow(): Promise<void> | void;
	/** How near the next step is (0..1, Sim.approach), after each frame's ticks: the page's sea
	 * floor rises over the coming piece. */
	approach?( p: number ): void;
}

export class Session {

	/** the simulation installed (set by the first `install`) */
	sim!: Sim;
	/** the island's record (沧海录): what happened since the simulation was installed (Chronicle.ts) */
	readonly record = new Chronicle();
	/** the tools a brain acts through, by name (sim/agent.ts): the five actions, kept across an install */
	readonly tools: ToolRegistry = actionTools();
	// the brain in the islanders' slot, kept across an install (setBrain)
	private brain: Brain | null;
	// the leader's words each islander has heard and no thought has taken yet (takeHeard)
	private readonly heard = new Map<EntityId, string[]>();
	private readonly host: SessionHost;
	// the island shown, and the pending piece's, kept for a simulation installed later
	private input: IslandInput;
	private coming: IslandInput | null = null;
	// a grow asked of the host and not yet in
	private growing = false;
	// the ticks run since the record's last look, which it notes the sky shown over
	private ticks = 0;

	/** A session on an island (the world generator's land), with a brain (the stand-in by default). */
	constructor( input: IslandInput, host: SessionHost, brain: Brain | null = new StandInBrain() ) {

		this.input = input;
		this.host = host;
		this.brain = brain;

	}

	/** The island shown: a new game or a load stands on it. */
	get island(): IslandInput {

		return this.input;

	}

	/** Install a simulation (a new game, a load), and its record for a saved game: its tools and
	 * brain, the coming piece, the record started over or taken back, the words no thought has
	 * taken forgotten, and the record's first look. */
	install( sim: Sim, record?: RecordSave ): void {

		sim.tools = this.tools;
		sim.brain = this.brain;
		if ( this.coming ) sim.setComing( this.coming );
		this.sim = sim;
		this.record.reset();
		if ( record ) this.record.restore( record );
		this.heard.clear();
		this.ticks = 0;
		// the record's first look, before any tick: a new game's islanders land at its start
		this.look( null );

	}

	/** A frame: a growth due is asked for, the simulation runs forward by real seconds at the day
	 * clock's rate (Sim.advance: nothing while paused), and the host hears how near the next step
	 * is. Returns the ticks run; the record looks at them once the host has shown them (`look`). */
	advance( realSeconds: number, secondsPerDay: number ): number {

		this.grow();
		const ticks = this.sim.advance( realSeconds, secondsPerDay );
		this.ticks += ticks;
		this.host.approach?.( this.sim.approach() );
		return ticks;

	}

	/** The record looks at what happened since its last look (Chronicle.observe): once a frame,
	 * after the host has shown the frame's ticks, with the sky shown over them (null: none is shown,
	 * as headless, and none is noted). */
	look( sky: WeatherName | null ): void {

		this.record.observe( this.sim, sky, this.ticks / 3600 );
		this.ticks = 0;

	}

	// The island follows the population: a grow asked of the host once a step is due and none is
	// under way.
	private grow(): void {

		const sim = this.sim;
		if ( this.growing || ! sim.growthDue() ) return;
		this.growing = true;
		const before = sim.state.pieces;
		const done = () => {

			if ( this.sim.state.pieces > before ) this.growing = false;

		};
		const grown = this.host.grow();
		if ( grown ) grown.then( done );
		else done();

	}

	/** The island grew by a piece (the host's grow, or a grow of the page's own): the simulation's
	 * ground follows the new land and counts the piece (Sim.addPiece); a game installed later
	 * stands on it. */
	setIsland( input: IslandInput ): void {

		this.input = input;
		this.coming = null;
		this.sim.addPiece( input );

	}

	/** The next piece is known (the page's pending land, Growth.ts): the simulation sees its cells
	 * (Sim.comingLand). */
	setComing( input: IslandInput ): void {

		this.coming = input;
		this.sim.setComing( input );

	}

	/** Whether the brain hears the leader's words (sim/agent.ts Brain.hears). */
	hears(): boolean {

		return this.brain?.hears ?? false;

	}

	/** The brain that thinks for the islanders (sim/agent.ts Brain; null: none), kept across an
	 * install; the words no thought has taken are forgotten. */
	setBrain( brain: Brain | null ): void {

		this.brain = brain;
		this.heard.clear();
		this.sim.brain = brain;

	}

	/** The leader speaks: words to some islanders (their ids) or to everyone. They go into the
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

	/** The leader's words an islander has heard since the last call for it, oldest first (for a
	 * brain that hears: hearing the leader is designed with the language model). */
	takeHeard( id: EntityId ): string[] {

		const lines = this.heard.get( id ) ?? [];
		this.heard.delete( id );
		return lines;

	}

	/** Whether the leader's words wait for an islander's next thought. */
	hasHeard( id: EntityId ): boolean {

		return ( this.heard.get( id )?.length ?? 0 ) > 0;

	}

	/** The game as a save's JSON (save.ts): the simulation's state and the record, once the record
	 * has looked at what happened since its last look (a save comes between frames), with the sky
	 * shown. */
	save( sky: WeatherName | null ): string {

		this.look( sky );
		return writeSave( this.sim.state, this.record.save() );

	}

	/** A saved game in a save's JSON, on the island shown, to install: null when there is none or
	 * it is not a save of this build's version (save.ts readSave); throws when its simulation
	 * cannot be loaded. */
	read( json: string | null ): { sim: Sim; record: RecordSave } | null {

		const save = readSave( json );
		return save ? { sim: loadGame( save.sim, this.input ), record: save.record } : null;

	}

}
