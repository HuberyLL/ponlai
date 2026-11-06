import type { WeatherName } from '../sky/Weather.ts';
import { Chronicle } from './Chronicle.ts';
import type { RecordSave } from './Chronicle.ts';
import { readSave, writeSave } from './save.ts';
import { loadGame } from './sim/Sim.ts';
import type { Sim } from './sim/Sim.ts';
import { act } from './sim/agent.ts';
import type { Brain, ToolResult } from './sim/agent.ts';
import type { SimEvent } from './sim/events.ts';
import { checkArgs } from './sim/schema.ts';
import { StandInBrain } from './sim/standin.ts';
import type { EntityId, IslandInput } from './sim/types.ts';

// The game around its simulation, without the page: the simulation installed (sim/Sim.ts) and its
// record (Chronicle.ts), the brain in the islanders' slot, the stream of what happened handed to
// its listeners, the player's commands checked at the entrance, the leader's words as each
// listener hears them, the island's growth asked of a host, and the save of the simulation with its
// record (save.ts). The page's game (Game.ts) hosts it beside the view, the
// interface, the scene events and the autosave; tools/play-game.mjs hosts it headless, so a run in
// node plays the game the page plays, with nothing copied. No three.js or DOM: node runs it by
// stripping types, as it runs sim/.
//
// What happened is one stream (sim/events.ts): the rules emit events at the tick they happen, and
// the session takes them from the simulation and hands each, in order, to its listeners (`listen`):
// the record first (Chronicle.note), then the page's interface and the play tool. It hands them on
// after every call that can make them (`install`, `advance`, `look`, `speak`, `act`, `place`,
// `setIsland`, `save`), so a listener hears what a call did before the call returns; a late
// brain's answer (Sim.think) comes between calls, and its events go with the next one, as do those
// of a host's own calls on the simulation (the debug panel's: an islander added, a walk, a need
// set). Events carry their own tick, so when they are handed on changes nothing they say.
//
// A frame: `advance` asks for a growth that is due, runs the simulation's ticks (Sim.advance) and
// tells the host how near the next step is; the host shows the frame (on the page the day clock and
// the weather step by the seconds `advance` returns), and then `look` notes the sky shown over its
// ticks in the record. The look is a call of its own because the sky it notes is the one shown
// after the weather's step. What the host does between frames comes in through the session's
// calls: the leader's words (`speak`), a blueprint placed (`place`), an islander added (a growth it
// makes due is asked for at the next `advance`).
//
// The player's commands are outside input, checked once at the entrance as a brain's calls are
// (sim/schema.ts; sim/agent.ts `act`): `speak` and `place` refuse what does not match, with the
// reason, before any rule runs.
//
// Installing a simulation (`install`: a new game, a load) hands it the brain, and the coming piece
// once the host has it; the record starts over (or takes a saved one back), the words no thought
// has taken are forgotten, and what the simulation emitted before it was installed is handed on: a
// new game's islanders landing at its start (a loaded one has emitted nothing). So a host adds the
// islanders a game starts with before installing it.
//
// The leader's words (`speak`) are an event as the player's; for a brain that hears
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

// the player's commands' arguments (sim/schema.ts)
const SPEAK = { words: { type: 'text' }, to: { type: 'audience' } } as const;
const PLACE = { kind: { type: 'text' }, x: { type: 'number' }, z: { type: 'number' } } as const;

export class Session {

	/** the simulation installed (set by the first `install`) */
	sim!: Sim;
	/** the island's record (沧海录): what happened since the simulation was installed (Chronicle.ts) */
	readonly record = new Chronicle();
	// who hears the simulation's events, in order: the record first
	private readonly listeners: ( ( event: SimEvent ) => void )[] = [];
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
		this.listen( ( event ) => this.record.note( event ) );

	}

	/** Hear the simulation's events (sim/events.ts), in order, after the record, for as long as the
	 * session lives, across installs; returns the call that stops it. */
	listen( listener: ( event: SimEvent ) => void ): () => void {

		this.listeners.push( listener );
		return () => {

			const i = this.listeners.indexOf( listener );
			if ( i >= 0 ) this.listeners.splice( i, 1 );

		};

	}

	// what the simulation emitted since, to the listeners
	private dispatch(): void {

		for ( const event of this.sim.take() ) for ( const listener of this.listeners ) listener( event );

	}

	/** The island shown: a new game or a load stands on it. */
	get island(): IslandInput {

		return this.input;

	}

	/** Install a simulation (a new game, a load), and its record for a saved game: its brain, the
	 * coming piece, the record started over or taken back, the words no thought has taken
	 * forgotten, and what it emitted before (a new game's landings) handed on. */
	install( sim: Sim, record?: RecordSave ): void {

		sim.brain = this.brain;
		if ( this.coming ) sim.setComing( this.coming );
		this.sim = sim;
		this.record.reset( sim.state.startHour );
		if ( record ) this.record.restore( record );
		this.heard.clear();
		this.ticks = 0;
		this.dispatch();

	}

	/** A frame: a growth due is asked for, the simulation runs forward by real seconds at the day
	 * clock's rate (Sim.advance: nothing while paused), and the host hears how near the next step
	 * is. Returns the ticks run, whose events the listeners have heard; the record notes the sky
	 * over them once the host has shown them (`look`). */
	advance( realSeconds: number, secondsPerDay: number ): number {

		this.grow();
		const ticks = this.sim.advance( realSeconds, secondsPerDay );
		this.ticks += ticks;
		this.host.approach?.( this.sim.approach() );
		this.dispatch();
		return ticks;

	}

	/** Once a frame, after the host has shown the frame's ticks: what happened since is handed on,
	 * and the record notes the sky shown over the ticks since the last look (null: none is shown,
	 * as headless, and none is noted). */
	look( sky: WeatherName | null ): void {

		this.dispatch();
		if ( sky !== null && this.ticks > 0 ) this.record.addSky( this.sim.day() + 1, sky, this.ticks / 3600 );
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
		this.dispatch();

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

	/** The leader speaks: words to some islanders (their ids, each on the island) or to everyone.
	 * They are an event; for a brain that hears, each listener keeps them until a thought takes
	 * them (takeHeard), and is asked for one now. Null when they are said, else why not. */
	speak( words: unknown, to: unknown ): string | null {

		const checked = checkArgs( 'speak', SPEAK, { words, to } );
		if ( ! checked.ok ) return checked.reason;
		const sim = this.sim, text = checked.args.words, audience = checked.args.to;
		if ( audience !== 'all' ) for ( const id of audience ) if ( ! sim.villager( id ) ) return `${ id } is not on the island`;
		sim.emit( { kind: 'said', tick: sim.state.tick, who: 'player', words: text, to: audience } );
		this.dispatch();
		if ( ! this.brain?.hears ) return null;
		const listeners = audience === 'all' ? sim.state.villagers.map( ( v ) => v.id ) : audience;
		for ( const id of listeners ) {

			let lines = this.heard.get( id );
			if ( ! lines ) this.heard.set( id, lines = [] );
			lines.push( text );

		}
		// (Sim.think: not while a thought is in flight; the words then wait for the next)
		for ( const id of listeners ) sim.think( id );
		// a brain that answers at once acts within the call
		this.dispatch();
		return null;

	}

	/** Tool calls for an islander, from outside a thought (the debug panel's, the console's), through
	 * the entrance a brain's answer takes (sim/agent.ts `act`); what they did is handed on. */
	act( who: EntityId, calls: unknown ): ToolResult[] {

		const results = act( this.sim, who, calls );
		this.dispatch();
		return results;

	}

	/** The player places a building of a kind (sim/buildings.ts) at a point of the ground (world
	 * metres): null when it stands there, else why not (Sim.placeBlueprint). */
	place( kind: unknown, x: unknown, z: unknown ): string | null {

		const checked = checkArgs( 'place', PLACE, { kind, x, z } );
		if ( ! checked.ok ) return checked.reason;
		const refused = this.sim.placeBlueprint( checked.args.kind, checked.args.x, checked.args.z );
		this.dispatch();
		return refused;

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
	 * has heard what happened since the last call and noted the sky shown (a save comes between
	 * frames). */
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
