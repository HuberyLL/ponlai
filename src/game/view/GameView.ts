import * as THREE from 'three/webgpu';
import type { CharacterShadow } from '../../characters/CharacterShadow.ts';
import { FIGURE_HEIGHT, type Villager as Figure } from '../../characters/Villagers.ts';
import type { Body, Sex } from '../../characters/Ages.ts';
import type { LookColours } from '../../characters/looks.ts';
import { ISLAND_TOP } from '../../world/WorldShapes.ts';
import type { EntityId } from '../sim/types.ts';
import type { Sim } from '../sim/Sim.ts';
import { BUILDING_KINDS, stageOf } from '../sim/buildings.ts';
import type { BuildingState, Villager } from '../sim/types.ts';
import { standIn } from './StandIn.ts';
import { ChestView } from './ChestView.ts';
import { SiteView } from './SiteView.ts';
import { ThingsView, thingSamples } from './ThingsView.ts';
import { VillagerView, disposeFigure } from './VillagerView.ts';

// The game drawn into the island scene: its islanders, its buildings, each a construction site
// (SiteView, the same stages for every kind) until it is built and then its kind's own model
// (MODELS: ChestView), and the things lying on the ground (ThingsView, an instanced mesh per item
// kind). Each frame it diffs the simulation's islanders and buildings by id (create,
// update, remove) and keeps every view in place between frames, so a steady scene allocates
// nothing. The buildings and the things cast into the sun's shadow map, which is redrawn only as the
// sun turns (SunShadow.ts): whatever changes their shape (a site set down or grown by a piece, a
// building finished, a thing that moves, comes or goes) asks for a redraw. A prop may rise above everything the island grows, so each prop's
// box grows the sun map's casters and the sea's reflection box (GameViewOptions.holdOpaque).
//
// First draws: a mesh whose material or vertex layout nothing on screen has drawn yet builds its
// pipelines in the frame that first shows it, synchronously: the chest's model stalled the frame
// it appeared in by about 0.7 s on a cold shader cache (its main pass and its shadow-map pass),
// the placement ring by about 0.2 s. So everything that can first show mid-game has a sample in
// `propSamples` (each kind's model and its construction site, each item kind's things; the HUD adds its own,
// GameHud.samples), and the game compiles their pipelines off the frame once its first frame has
// drawn (Game.render, GameContext.compileDraws). A sample must be built as the real thing is (the same view class,
// material and attributes, castShadow and receiveShadow), since that is what the pipelines are
// keyed by, and shares the real thing's material where it can, so that the shaders are built too
// (Props.ts buildingMaterial: every building and site shares one). The samples are never drawn and
// are kept for the page's life: disposing one would
// release the pipelines it shares with the props drawn later. An islander's figure has no sample:
// each load brings its own material, so `loadLook` hands a figure over only once its own draws
// are compiled (main.ts), and a figure taken over on a load keeps the pipelines it drew with.

export interface GameViewOptions {
	sim: Sim;
	scene: THREE.Scene;
	camera: THREE.PerspectiveCamera;
	characterShadow: CharacterShadow;
	/** redraw the sun's shadow map: what casts into it changed */
	invalidateSunShadow(): void;
	/** grow the sun's shadow casters and the sea's reflection box to hold a prop's box (GameContext) */
	holdOpaque( box: THREE.Box3 ): void;
	/** a skinned islander figure for a look index (src/characters/looks.ts), with a body where the look takes one */
	loadLook( look: number, body: Body ): Promise<Figure>;
	/** an islander's sex and age (its figure keeps the sex it was made with) */
	body( v: Readonly<Villager> ): Readonly<Body>;
	/** the colours of a look index, for the stand-in shown when its figure cannot load */
	lookColours( look: number ): LookColours;
	/** game ticks per second of the scene's clock at the game's normal pace (the day's length):
	 * the meadow's trail recovers by it (world/vegetation/Trample.ts) */
	ticksPerSecond(): number;
}

// Figures kept from the last GameView for the next one, by look and sex (`spareKey`): a loaded
// game has the same islanders, and taking a figure over is instant where loading it again leaves
// the islanders unseen for a moment. The next view disposes whatever it does not take.
const spares = new Map<string, Figure[]>();
const spareKey = ( look: number, sex: Sex ) => `${ look } ${ sex }`;

function disposeSpares(): void {

	for ( const list of spares.values() ) for ( const f of list ) disposeFigure( f );
	spares.clear();

}

let samples: THREE.Object3D[] | null = null;

/** One of each model the game can first show mid-game (see "First draws" above), made once. */
export function propSamples(): THREE.Object3D[] {

	if ( samples ) return samples;
	samples = [];
	for ( const kind of Object.keys( MODELS ) ) {

		const sample = ( worked: number ): BuildingState => ( { id: kind, kind, x: 0, z: 0, worked, items: {}, collider: null } );
		samples.push( MODELS[ kind ]( sample( BUILDING_KINDS[ kind ].work ), 0 ).mesh );
		// its site half built (the marks, the frame, the pile)
		samples.push( new SiteView( sample( BUILDING_KINDS[ kind ].work / 2 ), 0 ).mesh );

	}
	samples.push( ...thingSamples() );
	return samples;

}

/** A built building's model. */
interface BuildingModel { readonly mesh: THREE.Mesh; dispose(): void }

/** Each kind's finished model, by kind (sim/buildings.ts BUILDING_KINDS). */
const MODELS: Readonly<Record<string, ( b: BuildingState, ground: number ) => BuildingModel>> = {
	chest: ( b, ground ) => new ChestView( b, ground ),
};

/** A building as drawn: its site until it is built, then its model. */
interface BuildingDraw { x: number; z: number; site: SiteView | null; model: BuildingModel | null; stamp: number }

export class GameView {

	private readonly options: GameViewOptions;
	private readonly group = new THREE.Group();
	private readonly villagers: VillagerView[] = [];
	private readonly byId = new Map<EntityId, VillagerView>();
	private readonly buildings = new Map<string, BuildingDraw>();
	private readonly things: ThingsView;
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
		this.things = new ThingsView( this.group, options.holdOpaque );

	}

	/** Where an islander stands as drawn this frame (its feet, world metres), into `out`; false
	 * while nothing is drawn for it. The interface hangs its tag and marks there (ui/People.ts). */
	anchor( id: EntityId, out: THREE.Vector3 ): boolean {

		const view = this.byId.get( id );
		if ( ! view || ! view.drawn ) return false;
		out.copy( view.root.position );
		return true;

	}

	/** An islander's height as drawn (m, feet to crown): its figure's, or a stand-in's. */
	figureHeight( id: EntityId ): number {

		return this.byId.get( id )?.figure?.height ?? FIGURE_HEIGHT;

	}

	/** The islanders drawn, which part the meadow (world/vegetation/Trample.ts). */
	walkers(): VillagerView[] {

		return this.villagers.filter( ( v ) => v.drawn );

	}

	/** True once the view has drawn a frame and every islander shows something (its figure or a stand-in). */
	get ready(): boolean {

		return this.stamp > 0 && this.villagers.every( ( v ) => v.drawn );

	}

	/**
	 * Per frame, after the simulation advanced: sync the islanders, animate their figures, draw their shadow.
	 * gameDt: the whole ticks (game seconds) the simulation stepped this frame.
	 */
	update( renderer: THREE.WebGPURenderer, sun: THREE.DirectionalLight, realDt: number, gameDt: number ): void {

		if ( this.disposed ) return;
		const { sim } = this.options;
		const state = sim.state, grid = sim.grid;
		// the game's pace against real time: 1 while it runs, 0 while paused
		const factor = sim.paused ? 0 : 1;
		const stamp = ++ this.stamp;
		// Game seconds per game-paced second (the figures' clock): the ticks stepped plus the
		// change in the tick fraction give exactly the game time this frame advanced
		const pace = factor > 0 && realDt > 0 ? ( gameDt + sim.alpha - this.lastAlpha ) / realDt : NaN;
		this.lastAlpha = sim.alpha;

		// one figure a frame puts on a body prepared for its age (a copy of its meshes and rig)
		let swap = true;
		for ( const v of state.villagers ) {

			let view = this.byId.get( v.id );
			const body = this.options.body( v );
			if ( ! view ) {

				view = new VillagerView( v.id, v.look, body.sex );
				this.villagers.push( view );
				this.byId.set( v.id, view );
				this.group.add( view.root );
				const spare = spares.get( spareKey( v.look, body.sex ) )?.pop();
				if ( spare ) view.attach( spare );

			}
			view.stamp = stamp;
			if ( ! view.drawn && ! view.loading ) this.load( view, body.age );
			if ( view.update( v, body.age, grid, sim.alpha, realDt, factor, pace, swap ) ) swap = false;
			view.record( state.tick + sim.alpha, this.options.ticksPerSecond() );

		}
		// the figures this view did not take over from the last one
		if ( spares.size > 0 ) disposeSpares();
		this.sweep( stamp );
		const places = this.syncPlaces( stamp ), things = this.things.update( sim );
		if ( places || things ) this.options.invalidateSunShadow();

		// one figure at a time casts (the map is 2.5 m wide): the focused islander, else the one
		// nearest the middle of the view
		this.options.characterShadow.update( renderer, this.options.scene, sun, this.shadowFocus() );

	}

	private load( view: VillagerView, age: number ): void {

		const look = view.look;
		view.loading = true;
		this.options.loadLook( look, { sex: view.sex, age } ).then( ( figure ) => {

			// the islander may have gone (or the game closed) while its figure loaded
			if ( this.disposed || this.byId.get( view.id ) !== view ) disposeFigure( figure );
			else view.attach( figure );

		}, ( error: unknown ) => {

			if ( this.disposed || this.byId.get( view.id ) !== view ) return;
			// a stand-in, so the islander stays seen
			view.showStandIn( standIn( look, this.options.lookColours( look ) ) );
			view.loading = false;
			console.error( `Could not load the figure for look ${ look }`, error );

		} );

	}

	// A prop into the scene, and its box into the sun's casters and the sea's reflection box.
	private add( mesh: THREE.Mesh ): void {

		this.group.add( mesh );
		this.options.holdOpaque( new THREE.Box3().setFromObject( mesh ) );

	}

	/** Draw the buildings as the state holds them; true when what casts a shadow changed. */
	private syncPlaces( stamp: number ): boolean {

		const { sim } = this.options;
		const state = sim.state, grid = sim.grid;
		let changed = false;
		for ( const b of state.buildings ) {

			let draw = this.buildings.get( b.id );
			// a different building under the same id (a loaded game's) is drawn anew
			if ( draw && ( draw.x !== b.x || draw.z !== b.z ) ) {

				this.drop( draw );
				draw = undefined;

			}
			if ( ! draw ) this.buildings.set( b.id, draw = { x: b.x, z: b.z, site: null, model: null, stamp } );
			draw.stamp = stamp;
			const ground = grid.height( b.x, b.z );
			if ( stageOf( b ) === 'built' ) {

				if ( draw.model ) continue;
				draw.site?.dispose();
				draw.site = null;
				draw.model = MODELS[ b.kind ]( b, ground );
				this.add( draw.model.mesh );
				changed = true;

			} else if ( ! draw.site ) {

				draw.site = new SiteView( b, ground );
				this.add( draw.site.mesh );
				changed = true;

			} else if ( draw.site.update( b ) ) changed = true;

		}
		for ( const [ id, draw ] of this.buildings ) {

			if ( draw.stamp === stamp ) continue;
			this.drop( draw );
			this.buildings.delete( id );
			changed = true;

		}
		return changed;

	}

	private drop( draw: BuildingDraw ): void {

		draw.site?.dispose();
		draw.model?.dispose();
		draw.site = draw.model = null;

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
			const key = spareKey( v.look, v.sex );
			let list = spares.get( key );
			if ( ! list ) spares.set( key, list = [] );
			list.push( f );

		}
		for ( const v of this.villagers ) v.dispose();
		this.villagers.length = 0;
		this.byId.clear();
		for ( const draw of this.buildings.values() ) this.drop( draw );
		this.buildings.clear();
		this.things.dispose();
		this.group.removeFromParent();

	}

}
