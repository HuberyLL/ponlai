import * as THREE from 'three/webgpu';
import type { CharacterShadow } from '../../characters/CharacterShadow.ts';
import type { Villager as Figure } from '../../characters/Villagers.ts';
import { ISLANDER_LOOKS } from '../../characters/looks.ts';
import { ISLAND_TOP } from '../../world/WorldShapes.ts';
import { SPEED_FACTORS } from '../sim/types.ts';
import type { EntityId } from '../sim/types.ts';
import type { Sim } from '../sim/Sim.ts';
import { buildingOf, stageOf } from '../sim/buildings.ts';
import { PalmView } from './PalmView.ts';
import { standIn } from './StandIn.ts';
import { ChestView } from './ChestView.ts';
import { VillagerView, disposeFigure } from './VillagerView.ts';

// The game drawn into the island scene: its islanders, its palms (PalmView) and the chest
// once placed (ChestView). Each frame it diffs the simulation's islanders and palms by id
// (create, update, remove) and keeps every view in place between frames, so a steady scene
// allocates nothing. The palms and the chest cast into the sun's shadow map, which is redrawn
// only as the sun turns (SunShadow.ts): whatever changes their shape (a chest set down, a
// coconut picked or grown) asks for a redraw.

export interface GameViewOptions {
	sim: Sim;
	scene: THREE.Scene;
	camera: THREE.PerspectiveCamera;
	characterShadow: CharacterShadow;
	/** redraw the sun's shadow map: what casts into it changed */
	invalidateSunShadow(): void;
	/** a skinned islander figure for a look index (src/characters/looks.ts) */
	loadLook( look: number ): Promise<Figure>;
}

// Figures kept from the last GameView for the next one: a loaded game has the same islanders, and
// taking a figure over is instant where loading it again leaves the islanders unseen for a moment.
// The next view disposes whatever it does not take.
const spares = new Map<number, Figure[]>();

function disposeSpares(): void {

	for ( const list of spares.values() ) for ( const f of list ) disposeFigure( f );
	spares.clear();

}

export class GameView {

	private readonly options: GameViewOptions;
	private readonly group = new THREE.Group();
	private readonly villagers: VillagerView[] = [];
	private readonly byId = new Map<EntityId, VillagerView>();
	private readonly palms = new Map<string, PalmView>();
	private chest: ChestView | null = null;
	private readonly shadowCentre = new THREE.Vector3();
	private readonly scratch = new THREE.Vector3();
	/** the islander the figures' shadow map follows (the debug panel's pick); null: the one nearest the view's middle */
	focus: EntityId | null = null;
	private stamp = 0;
	private lastAlpha = NaN;
	private disposed = false;

	constructor( options: GameViewOptions ) {

		this.options = options;
		this.group.name = 'game';
		options.scene.add( this.group );

	}

	/**
	 * Per frame, after the simulation advanced: sync the islanders, animate their figures, draw their shadow.
	 * gameDt: the whole ticks (game seconds) the simulation stepped this frame.
	 */
	update( renderer: THREE.WebGPURenderer, sun: THREE.DirectionalLight, realDt: number, gameDt: number ): void {

		if ( this.disposed ) return;
		const { sim } = this.options;
		const state = sim.state, grid = sim.grid;
		const factor = SPEED_FACTORS[ sim.speed ];
		const stamp = ++ this.stamp;
		// Game seconds per game-paced second (the figures' clock): the ticks stepped plus the
		// change in the tick fraction give exactly the game time this frame advanced
		const pace = factor > 0 && realDt > 0 ? ( gameDt + sim.alpha - this.lastAlpha ) / ( realDt * factor ) : NaN;
		this.lastAlpha = sim.alpha;

		for ( const v of state.villagers ) {

			let view = this.byId.get( v.id );
			if ( ! view ) {

				view = new VillagerView( v.id, v.look );
				this.villagers.push( view );
				this.byId.set( v.id, view );
				this.group.add( view.root );
				const spare = spares.get( v.look )?.pop();
				if ( spare ) view.attach( spare );

			}
			view.stamp = stamp;
			if ( ! view.drawn && ! view.loading ) this.load( view );
			view.update( v, grid, sim.alpha, realDt, factor, pace );

		}
		// the figures this view did not take over from the last one
		if ( spares.size > 0 ) disposeSpares();
		this.sweep( stamp );
		if ( this.syncPlaces( stamp ) ) this.options.invalidateSunShadow();

		// one figure at a time casts (the map is 2.5 m wide): the focused islander, else the one
		// nearest the middle of the view
		this.options.characterShadow.update( renderer, this.options.scene, sun, this.shadowFocus() );

	}

	private load( view: VillagerView ): void {

		const look = view.look;
		view.loading = true;
		this.options.loadLook( look ).then( ( figure ) => {

			// the islander may have gone (or the game closed) while its figure loaded
			if ( this.disposed || this.byId.get( view.id ) !== view ) disposeFigure( figure );
			else view.attach( figure );

		}, ( error: unknown ) => {

			if ( this.disposed || this.byId.get( view.id ) !== view ) return;
			// a stand-in, so the islander stays seen
			view.showStandIn( standIn( look, ISLANDER_LOOKS[ look % ISLANDER_LOOKS.length ].colours ) );
			view.loading = false;
			console.error( `Could not load the figure for look ${ look }`, error );

		} );

	}

	/** Draw the palms and the chest as the state holds them; true when what casts a shadow changed. */
	private syncPlaces( stamp: number ): boolean {

		const { sim } = this.options;
		const state = sim.state, grid = sim.grid;
		let changed = false;
		for ( const palm of state.palms ) {

			let view = this.palms.get( palm.id );
			if ( ! view ) {

				view = new PalmView( palm, grid.height( palm.x, palm.z ) );
				this.palms.set( palm.id, view );
				this.group.add( view.mesh );
				changed = true;

			}
			view.stamp = stamp;
			if ( view.update( palm ) ) changed = true;

		}
		for ( const [ id, view ] of this.palms ) {

			if ( view.stamp === stamp ) continue;
			view.dispose();
			this.palms.delete( id );
			changed = true;

		}
		// the chest's model once it is built (its construction stages are not drawn yet)
		const site = buildingOf( state, 'chest' );
		const box = site && stageOf( site ) === 'built' ? site : null;
		if ( this.chest && ( ! box || box.x !== this.chest.x || box.z !== this.chest.z ) ) {

			this.chest.dispose();
			this.chest = null;
			changed = true;

		}
		if ( box && ! this.chest ) {

			this.chest = new ChestView( box, grid.height( box.x, box.z ) );
			this.group.add( this.chest.mesh );
			changed = true;

		}
		return changed;

	}

	/** Remove views whose islander was not seen this frame. */
	private sweep( stamp: number ): void {

		const list = this.villagers;
		for ( let k = list.length - 1; k >= 0; k -- ) {

			const view = list[ k ];
			if ( view.stamp === stamp ) continue;
			list.splice( k, 1 );
			if ( this.byId.get( view.id ) === view ) this.byId.delete( view.id );
			view.dispose();

		}

	}

	/** Where the figures' small shadow map looks. */
	private shadowFocus(): THREE.Vector3 {

		const { camera } = this.options;
		const focused = this.focus ? this.byId.get( this.focus ) : undefined;
		if ( focused && focused.drawn ) return this.shadowCentre.copy( focused.centre );
		// the view's middle on the island's top
		const dir = camera.getWorldDirection( this.scratch );
		const t = dir.y < - 1e-3 ? ( ISLAND_TOP - camera.position.y ) / dir.y : 30;
		const cx = camera.position.x + dir.x * t, cz = camera.position.z + dir.z * t;
		let best: VillagerView | null = null, bestD = Infinity;
		for ( const v of this.villagers ) {

			if ( ! v.drawn ) continue;
			const d = ( v.centre.x - cx ) ** 2 + ( v.centre.z - cz ) ** 2;
			if ( d < bestD ) {

				bestD = d;
				best = v;

			}

		}
		if ( best ) return this.shadowCentre.copy( best.centre );
		return this.shadowCentre.set( cx, ISLAND_TOP, cz );

	}

	dispose(): void {

		if ( this.disposed ) return;
		this.disposed = true;
		// the next view takes these over (anything older is stale by now)
		disposeSpares();
		for ( const v of this.villagers ) {

			const f = v.release();
			if ( ! f ) continue;
			let list = spares.get( v.look );
			if ( ! list ) spares.set( v.look, list = [] );
			list.push( f );

		}
		for ( const v of this.villagers ) v.dispose();
		this.villagers.length = 0;
		this.byId.clear();
		for ( const p of this.palms.values() ) p.dispose();
		this.palms.clear();
		this.chest?.dispose();
		this.chest = null;
		this.group.removeFromParent();

	}

}
