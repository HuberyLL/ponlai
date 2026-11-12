import type { WeatherName } from '../sky/Weather.ts';
import { timeOf } from './sim/clock.ts';
import type { GameTime } from './sim/clock.ts';
import type { SimEvent } from './sim/events.ts';
import type { EntityId } from './sim/types.ts';

// The island's record (沧海录, docs/explanation/ui.md): what happened, day by day. Islanders landing and dying,
// the player's words and the islanders', what one islander handed another, buildings set out and
// finished, a need turning critical, and how long each sky held on each day. The interface reads it
// (src/game/ui/Record.ts) and turns each entry into words and a mark by its kind's row
// (src/game/ui/data/record.ts), so a new kind of entry is a new row there.
//
// Rules: it is the first listener of the simulation's events (sim/events.ts, Session.listen), and
// notes an entry for each event of the kinds above (`note`, RECORDED), with the tick the event
// happened at;
// it never reads or changes the simulation's state. So it keeps every line said, two in one frame
// included, and keeps no copy of what the simulation decides (a need's line is the simulation's:
// sim/needs.ts). An entry keeps its tick, and its day and time of day are derived from it
// (`timeOf`, sim/clock.ts), never stored beside it. It is part of the save (save.ts): `save` gives
// its entries and the skies of each day, and `restore` takes them back into a record just reset; a
// loaded game's simulation has emitted nothing yet, so the record notes nothing twice. A record
// restored and hearing the same events keeps the entries the original keeps
// (tools/verify-game.mjs). Entries are kept in the order they happened (the debug panel's
// placeholders aside: readers sort by tick). `version` counts the changes, so a reader redraws only
// when it moved.

/** who an entry is about: an islander, the player, or the island as a whole (a building finished) */
export type RecordWho = EntityId | 'player' | 'island';

export interface RecordEntry {
	/** its kind (src/game/ui/data/record.ts): landed, died, said, gave, placed, built, need */
	kind: string;
	/** the tick it happened at (its day and time: Chronicle.timeOf) */
	tick: number;
	who: RecordWho;
	/** whom words were said to (the islanders' ids, or everyone), or whom something was given to */
	to?: EntityId[] | 'all';
	/** the words said; the item given; a building's kind; a need's id (sim/registry.ts); the age
	 * one died at */
	text?: string;
	/** how many were given */
	count?: number;
	/** the building an entry is about (its id) */
	subject?: string;
}

/** The kinds of the simulation's events the record notes (`note`), each as an entry of the same
 * kind; a presentation that shows the others (tools/play-game.mjs) shows these through the record. */
export const RECORDED: ReadonlySet<SimEvent[ 'kind' ]> = new Set( [ 'landed', 'died', 'said', 'gave', 'placed', 'built', 'need' ] );

/** The record as a save holds it (plain JSON). */
export interface RecordSave {
	entries: RecordEntry[];
	/** game hours each sky held, by day */
	skies: Record<string, Partial<Record<WeatherName, number>>>;
}

export class Chronicle {

	readonly entries: RecordEntry[] = [];
	/** game hours each sky held, by day */
	readonly skies = new Map<number, Map<WeatherName, number>>();
	/** the tick each islander landed at, where the record has it */
	readonly landed = new Map<EntityId, number>();
	/** changes so far */
	version = 0;
	// the game's start hour, which a tick's time of day counts from
	private startHour = 0;

	/** A new simulation is installed (start, load), starting at an hour: the record starts over. */
	reset( startHour: number ): void {

		this.entries.length = 0;
		this.skies.clear();
		this.landed.clear();
		this.startHour = startHour;
		this.version ++;

	}

	/** The day (from 1) and time of day of a tick. */
	timeOf( tick: number ): GameTime {

		return timeOf( tick, this.startHour );

	}

	/** The record for a save. */
	save(): RecordSave {

		const skies: RecordSave[ 'skies' ] = {};
		for ( const [ day, tally ] of this.skies ) skies[ day ] = Object.fromEntries( tally );
		return { entries: this.entries, skies };

	}

	/** Take a saved record back, into a record just reset. */
	restore( saved: RecordSave ): void {

		for ( const e of saved.entries ) this.keep( e );
		for ( const [ day, tally ] of Object.entries( saved.skies ) ) this.skies.set( Number( day ), new Map( Object.entries( tally ) as [ WeatherName, number ][] ) );
		this.version ++;

	}

	/** An entry (the debug panel's placeholders; the events' through `note`). */
	add( entry: RecordEntry ): void {

		this.keep( entry );
		this.version ++;

	}

	/** An event of the simulation's: an entry for the kinds the record keeps. */
	note( e: SimEvent ): void {

		const tick = e.tick;
		switch ( e.kind ) {

			case 'landed': this.add( { kind: 'landed', tick, who: e.who } ); break;
			case 'died': this.add( { kind: 'died', tick, who: e.who, text: String( e.age ) } ); break;
			case 'said': this.add( e.to ? { kind: 'said', tick, who: e.who, to: e.to, text: e.words } : { kind: 'said', tick, who: e.who, text: e.words } ); break;
			case 'gave': this.add( { kind: 'gave', tick, who: e.who, to: [ e.to ], text: e.item, count: e.count } ); break;
			case 'placed': this.add( { kind: 'placed', tick, who: 'player', text: e.of, subject: e.building } ); break;
			case 'built': this.add( { kind: 'built', tick, who: 'island', text: e.of, subject: e.building } ); break;
			case 'need': this.add( { kind: 'need', tick, who: e.who, text: e.need } ); break;

		}

	}

	/** Note how long a sky held on a day (game hours). */
	addSky( day: number, sky: WeatherName, hours: number ): void {

		let tally = this.skies.get( day );
		if ( ! tally ) this.skies.set( day, tally = new Map() );
		tally.set( sky, ( tally.get( sky ) ?? 0 ) + hours );

	}

	private keep( e: RecordEntry ): void {

		this.entries.push( e );
		if ( e.kind === 'landed' && ! this.landed.has( e.who ) ) this.landed.set( e.who, e.tick );

	}

}
