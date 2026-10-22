import type { WeatherName } from '../sky/Weather.ts';
import { stageOf } from './sim/buildings.ts';
import { CRITICAL_NEED } from './sim/needs.ts';
import type { Sim } from './sim/Sim.ts';
import type { EntityId, Needs, Villager } from './sim/types.ts';

// The island's record (沧海录, docs/ui.md): what happened, day by day, as the game sees it happen.
// Islanders landing, the player's words and the islanders', buildings set out and finished, a need
// turning critical, and how long each sky held on each day. The interface reads it
// (src/game/ui/Record.ts) and turns each entry into words and a mark by its kind's row
// (src/game/ui/data/record.ts), so a new kind of entry is a new row there.
//
// Rules: it watches the simulation once a frame (Game.render) and never changes it; the player's
// words come through Game.speak. It holds what happened since the game was installed on the page:
// it is not part of the save yet, so a loaded game's record starts at the load, its islanders
// listed with their landing unknown. A day is the game's day counted from 1, a time the minute of
// that day; entries are kept in the order they happened. `version` counts the changes, so a reader
// redraws only when it moved.

/** who an entry is about: an islander, the player, or the island as a whole (a building finished) */
export type RecordWho = EntityId | 'player' | 'island';

export interface RecordEntry {
	/** its kind (src/game/ui/data/record.ts): landed, said, placed, built, need */
	kind: string;
	day: number;
	minute: number;
	who: RecordWho;
	/** whom words were said to: the islanders' ids, or everyone */
	to?: EntityId[] | 'all';
	/** the words said; a building's kind; a need's name (satiety, hydration) */
	text?: string;
	/** the building an entry is about (its id) */
	subject?: string;
}

// a critical need is noted again only after it has risen this far above the line
const REARM = 10;

export class Chronicle {

	readonly entries: RecordEntry[] = [];
	/** game hours each sky held, by day */
	readonly skies = new Map<number, Map<WeatherName, number>>();
	/** the day each islander landed on, where the record saw it */
	readonly landed = new Map<EntityId, number>();
	/** changes so far */
	version = 0;
	private watching = false;
	// the line each islander said last (each line said is a new object, whatever the tick)
	private readonly said = new Map<EntityId, Villager[ 'said' ]>();
	private readonly built = new Map<string, boolean>();
	private readonly alerted = new Set<string>();

	/** A new simulation is installed (start, load): the record starts over. A new game's first
	 * islanders land at its start; a loaded game's were there before the record. */
	reset(): void {

		this.entries.length = 0;
		this.skies.clear();
		this.landed.clear();
		this.said.clear();
		this.built.clear();
		this.alerted.clear();
		this.watching = false;
		this.version ++;

	}

	/** Add an entry, at the game's time now unless it names its own (the debug panel's
	 * placeholders); a landing is the day the islander's page starts. */
	add( sim: Sim, entry: Omit<RecordEntry, 'day' | 'minute'> & Partial<Pick<RecordEntry, 'day' | 'minute'>> ): void {

		const e = { day: sim.day() + 1, minute: Math.floor( sim.hour() * 60 ), ...entry };
		this.entries.push( e );
		if ( e.kind === 'landed' && ! this.landed.has( e.who ) ) this.landed.set( e.who, e.day );
		this.version ++;

	}

	/** Note how long a sky held on a day (game hours). */
	addSky( day: number, sky: WeatherName, hours: number ): void {

		let tally = this.skies.get( day );
		if ( ! tally ) this.skies.set( day, tally = new Map() );
		tally.set( sky, ( tally.get( sky ) ?? 0 ) + hours );

	}

	/** Once a frame: note what changed in the simulation, and the sky shown over `hours` game hours. */
	observe( sim: Sim, sky: WeatherName, hours: number ): void {

		const state = sim.state, fresh = ! this.watching;
		this.watching = true;
		for ( const v of state.villagers ) {

			if ( ! this.said.has( v.id ) ) {

				// a new game's islanders land at its start; a loaded game's came before the record
				if ( ! fresh || state.tick === 0 ) this.add( sim, { kind: 'landed', who: v.id } );
				this.said.set( v.id, v.said );

			}
			if ( v.said && v.said !== this.said.get( v.id ) ) {

				this.said.set( v.id, v.said );
				this.add( sim, { kind: 'said', who: v.id, text: v.said.words } );

			}
			for ( const need of Object.keys( v.needs ) as ( keyof Needs )[] ) {

				const key = `${ v.id }:${ need }`, value = v.needs[ need ];
				if ( value <= CRITICAL_NEED && ! this.alerted.has( key ) ) {

					this.alerted.add( key );
					if ( ! fresh ) this.add( sim, { kind: 'need', who: v.id, text: need } );

				} else if ( value > CRITICAL_NEED + REARM ) this.alerted.delete( key );

			}

		}
		for ( const b of state.buildings ) {

			const done = stageOf( b ) === 'built', was = this.built.get( b.id );
			if ( was === done ) continue;
			this.built.set( b.id, done );
			if ( fresh ) continue;
			if ( was === undefined ) this.add( sim, { kind: 'placed', who: 'player', text: b.kind, subject: b.id } );
			if ( done ) this.add( sim, { kind: 'built', who: 'island', text: b.kind, subject: b.id } );

		}
		if ( hours > 0 ) this.addSky( sim.day() + 1, sky, hours );

	}

}
