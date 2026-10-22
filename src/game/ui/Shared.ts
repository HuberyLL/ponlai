import type { Game } from '../Game.ts';
import { shortfall } from '../sim/stock.ts';
import type { EntityId, Items } from '../sim/types.ts';
import { BUILDINGS } from './data/buildings.ts';
import type { BuildingRow } from './data/buildings.ts';
import { RESOURCES, resourceStock } from './data/resources.ts';
import type { ResourceRow } from './data/resources.ts';

// What the interface's parts share: the game, the islander selected, the building chosen in the
// build bar, the lists in use and the island's stock by resource. GameUi owns it and refreshes the
// stock once a frame; the parts read it and change the selection through it.

export class UiShared {

	readonly game: Game;
	/** the islander selected (their tag shows, the speak bar speaks to them), or null */
	selected: EntityId | null = null;
	/** the building the build bar shows (chosen, or under the pointer) while it is open: the top
	 * row's counts it lacks turn 朱 */
	shown: BuildingRow | null = null;
	/** the lists in use: the data's rows (the debug panel's "many" rows add placeholders) */
	resources: ResourceRow[] = [ ...RESOURCES ];
	roster: BuildingRow[] = [ ...BUILDINGS ];
	/** bumped when a list changes, so the parts that draw it rebuild */
	lists = 0;
	/** the island's stock by resource id (data/resources.ts resourceStock) */
	stock: Items = {};
	/** the interface's scale: screen pixels per pixel of the design (GameUi `--k`) */
	k = 1;
	/** real time now (ms), for the interface's own motion */
	now = 0;
	/** the lines the player has said so far (each one's number: People.hear) */
	lines = 0;

	constructor( game: Game ) {

		this.game = game;

	}

	/** Once a frame, before the parts update. */
	refresh( now: number ): void {

		this.now = now;
		this.stock = resourceStock( this.resources, this.game.stock() );

	}

	/** What a building's cost lacks against the stock (sim/stock.ts shortfall); empty when met. */
	short( row: BuildingRow ): Items {

		return shortfall( row.cost, this.stock );

	}

	/** A building's name by the simulation's kind (the roster's row that places it). */
	readonly buildingName = ( kind: string ): string => this.roster.find( ( r ) => r.kind === kind )?.name ?? kind;

	/** An islander's name by id. */
	readonly personName = ( id: string ): string => this.game.sim.villager( id )?.name ?? id;

}
