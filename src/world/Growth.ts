import * as THREE from 'three/webgpu';
import { generateVersion, type LoadedWorld, type VersionChunks } from './WorldChunks.ts';
import { mergeSteps } from './ChunkMerge.ts';
import { GROWTH, LandLattice } from './IslandGrowth.ts';
import { landBounds, type Bounds } from './WorldShapes.ts';
import { derive, islandMesh, seabedGeometry, stonesGeometry, type WorldMeshes } from './World.ts';
import type { WorldFields, FieldsPrepared } from './WorldFields.ts';
import { AttributeType, geometrySteps, textureSteps, uploadSteps } from './Upload.ts';
import { boundsSteps } from './Steps.ts';
import { debugFlags } from '../debug/DebugFlags.ts';
import { plantGrass, grassSteps, setGrass, type GrassPrepared, type GrassTufts } from './Grass.ts';
import { plantFlowers, flowerInstances, flowerReplacement, setFlowers, type FlowerInstances, type Plant } from './Flowers.ts';
import { bushInstances, setBushes, type BushInstances } from './Foliage.ts';
import { rimFoliageSteps, setRimFoliage, type RimFoliageBuilt } from './RimFoliage.ts';
import { turfSkirtSteps, setTurfSkirt, type TurfSkirtBuilt } from './RimSkirt.ts';
import { walkLoopDistance, walkPoints } from './WalkPath.ts';
import { topFromTiles } from '../game/sim/grid.ts';
import { VEGETATION_STRIDE } from './types.ts';
import type { ChunkData } from './Chunks.ts';
import type { IslandChunk, WorldData } from './types.ts';
import type { ShoreWaves, ShoreFields } from '../ocean/ShoreWaves.ts';
import type { RefractedSun } from '../lighting/RefractedSun.ts';
import type { Rain } from '../weather/Rain.ts';
import { Villagers } from '../characters/Villagers.ts';
import type { CullBuffers } from './GrassCull.ts';

// The island grows in place (chunk design, sections 3.4, 10 and 11; plan M8): the next piece is
// generated ahead in the background, and a Grow (`grow()`, the GUI's Island folder) swaps in only
// the chunks that changed, in one frame, with every dependent following. No pipeline is built: a
// swap needing one would be a bug (tools/verify-first-use.mjs and the page's pipeline count).
//
// - Versions: a version is a land step and its chunks (WorldChunks.ts `VersionChunks`). The shown
//   one is the page's; once it shows, the next step is generated as the pending one, on at most
//   two workers (the shown one's own chunks are taken over wherever the growth steps in a chunk's
//   window are the same, Chunks.ts dirtyChunks, so only the rebuild set is generated or read from
//   the cache). A rebuilt chunk whose hash equals the shown one's is the shown one's (the same
//   object), so it is not swapped: `changed` lists the chunks whose data differs.
// - Preparation, in idle time (requestIdleCallback; setTimeout where there is none), a step of a
//   millisecond or two at a time: the merge (ChunkMerge.ts mergeSteps), the new island meshes of
//   the changed land chunks (built and compiled for the frame's passes ahead, one per step:
//   `compileDraws`, which uploads their buffers), the merged kinds' new geometry (the stones, the
//   sea floor, the turf skirt, the rim trails: their buffers uploaded ahead), the meadow (planted
//   a slice of anchors at a step, its cull pool filled and its buffers uploaded), the flowers' and
//   bushes' instances (and a new mesh, compiled, for a species that outgrew its capacity), the
//   world fields (WorldFields.ts) and the shore's wave fields (in a worker, ShoreWaves.ts). Data
//   goes up in buffers made for it (mapped at creation) and copies on the GPU, not queue writes,
//   which stalled the page for hundreds of milliseconds with the GPU busy; the flowers and bushes
//   are the exception (under a megabyte written in place at the swap: a new instanced mesh would
//   be a node build of tens of milliseconds, Flowers.ts).
//   A grow asked for before it is done swaps once it is.
// - The swap, in the frame's tick before the camera and the shadows update (main.ts's one-line
//   hook): the changed island meshes out and the new ones in (ordered by chunk, ( cj, ci ), as a
//   page loaded on that land orders them), the merged kinds' geometry, the flowers' and the
//   bushes' instances, the meadow's pool (GrassCull's storage nodes pointed at the new buffers),
//   the fields' changed squares (copied on the GPU) or new textures, the shore's wave fields, the
//   refracted sun's casters, the walker's loop, and the page's own (main.ts `onSwap`: the land's
//   box and framing, the fog's clearing, the sun's caster box and columns, the sea's reflection
//   box, the camera's ground).
// - The frames after it: the rain's collision map (resized, then baked again eight meshes a frame:
//   RainCollision.bakeSteps), the game's ground (the chunks' walk tiles, sim/grid.ts), the old
//   resources disposed; then the next version is generated.
// - The page then draws what a page loaded on the grown land draws, bit for bit (paused): every
//   dependent is the same function of the same version, and the island's meshes are split and
//   ordered alike (World.ts on split draws).

/** What the growth changes on the page: its world objects, and the page's own hooks. */
export interface GrowthPage<M = unknown> {
	renderer: THREE.WebGPURenderer;
	world: WorldMeshes;
	fields: WorldFields;
	grass: THREE.Group;
	flowers: THREE.Group;
	foliage: THREE.InstancedMesh;
	rimFoliage: THREE.Group;
	turfSkirt: THREE.Mesh;
	shoreWaves: ShoreWaves;
	refractedSun: RefractedSun;
	rain: Rain;
	characters: Villagers | null;
	game: { setIsland( land: LandLattice, bushes: Float32Array, top?: Uint8Array ): void } | null;
	// the roots the rain's collision map is baked from
	rainRoots: THREE.Object3D[];
	/** compiles what `objects` draw in the frame's passes (and uploads their buffers); `casters`:
	 * the sun's map too */
	compileDraws( objects: THREE.Object3D[], casters?: boolean ): Promise<void>;
	/** the page's own land-dependent state, in the swap's frame */
	/** what the page measures of a land (its box and framing), ahead in a step of the preparation */
	measure( land: LandLattice ): M;
	/** the page's own land-dependent state, in the swap's frame, with `measure`'s result */
	onSwap( land: LandLattice, data: WorldData, measured: M ): void;
	/** after the swap's frames (the chunks' borders, the diagnostics) */
	onSwapped?( data: WorldData ): void;
}

interface Shown { version: VersionChunks; data: WorldData; land: LandLattice }

interface Prepared<M> {
	version: VersionChunks;
	measured: M;
	bounds: Bounds;
	data: WorldData;
	land: LandLattice;
	changed: ChunkData[];
	islands: { add: THREE.Mesh[]; remove: THREE.Mesh[] };
	rocks: THREE.BufferGeometry;
	seabed: THREE.BufferGeometry;
	walk: ReturnType<typeof Villagers.loop>;
	grass: GrassPrepared;
	flowers: { instances: FlowerInstances[]; replacements: ( THREE.InstancedMesh | null )[]; boxes: ( THREE.Box3 | null )[] };
	bushes: { instances: BushInstances; box: THREE.Box3 };
	rim: RimFoliageBuilt;
	skirt: TurfSkirtBuilt;
	fields: FieldsPrepared;
	shore: ShoreFields;
	top: Uint8Array;
}

/** What the growth is doing: `idle` (nothing pending: at the horizon, or between steps), generating
 * the pending version in the workers, preparing it on the page, `ready` to swap, `swapping` (the
 * swap and the frames after it). */
export type GrowthPhase = 'idle' | 'generating' | 'preparing' | 'ready' | 'swapping' | 'failed';

// A preparation step yields nothing (a slice ends) or a promise (wait for it: a worker, a compile).
type Steps<T> = Generator<void | Promise<unknown>, T>;

// The idle time a slice of preparation takes at most (ms; where there is no idle callback, the
// time a timer's slice takes). A slice runs steps until it has used this, so it ends at most a step
// later: steps are a few tenths of a millisecond, and a frame's whole share of the growth stays
// under 2 ms (`work`).
const SLICE = 1.2;
// steps longer than this (ms) are listed in `work.slow`
const SLOW = 0.6;


export class Growth<M = unknown> {

	readonly state = {
		/** the land step shown */
		step: 0,
		/** the step being prepared (or ready), -1 when none */
		pending: - 1,
		phase: 'idle' as GrowthPhase,
		swaps: 0,
		/** the chunks of the last swap: rebuilt (the rebuild set), changed (swapped), island meshes added and
		 * removed, its times (ms) and the page time it happened at (`at`) */
		last: null as null | { step: number; chunks: number; rebuilt: number; changed: number; added: number; removed: number; ms: Record<string, number>; at: number },
		error: '',
	};
	/** The growth's own main-thread time per frame (ms; a frame runs from one `update` to the next):
	 * the preparation's slices, the swap and the frames after it, and the generation's replies from
	 * the workers. Since the pending version began: the largest frame and its stage, every frame
	 * with any as ( page time, ms ) pairs, the steps over SLOW ms ( stage, step, ms ), and when the
	 * preparation began, the swap happened and the frames after it ended (page times). */
	readonly work = {
		max: 0, stage: '',
		frames: [] as number[],
		slow: [] as [ string, number, number ][],
		prepared: 0, swapped: 0, ended: 0,
	};
	private frameMs = 0;
	private frameAt = 0;
	private stepIndex = 0;
	private shown: Shown;
	private prepared: Prepared<M> | null = null;
	private steps: Steps<Prepared<M>> | null = null;
	private waiting = false;
	private idleQueued = false;
	private wanted: ( () => void )[] = [];
	// the frames after a swap: each step runs once a frame until it says it is done (returns falsy)
	private after: ( () => boolean | void )[] = [];
	private readonly times: Record<string, number> = {};
	// the preparation's stage (for the timings: its longest step)
	private stage = '';
	private afterStep = 0;
	private readonly seed: number;
	private readonly cache: boolean;

	constructor( private readonly page: GrowthPage<M>, loaded: LoadedWorld, { seed, cache }: { seed: number; cache: boolean } ) {

		this.seed = seed;
		this.cache = cache;
		this.shown = { version: loaded.version, data: loaded.data, land: LandLattice.fromBytes( loaded.data.land ) };
		this.state.step = loaded.version.step;

	}

	/** Starts generating the next piece ahead (the game, once the page shows: the workers then share
	 * the machine with the frames, not with the page's start). A page that never calls it generates
	 * on its first `grow`, and keeps a piece ahead from then on; one that never grows spends no
	 * worker time on it. */
	start(): void {

		if ( this.state.phase === 'idle' && this.state.pending < 0 && this.after.length === 0 ) this.next();

	}

	/** Grow by the next piece: resolves once it is swapped in and every dependent has followed (the
	 * frames after the swap included). At the growth horizon it resolves at once. */
	grow(): Promise<void> {

		if ( this.state.step >= GROWTH.maxSteps || this.state.phase === 'failed' ) return Promise.resolve();
		const wanted = new Promise<void>( ( resolve ) => this.wanted.push( resolve ) );
		this.start();
		return wanted;

	}

	/** The shown version's chunks' hashes ( `ci,cj` -> hash ): equal on a grown page and a page
	 * loaded on the same land. */
	chunkHashes(): Record<string, string> {

		return Object.fromEntries( this.shown.version.chunks.map( ( c ) => [ `${ c.ci },${ c.cj }`, c.hash ] ) );

	}

	/** Once a frame, in the tick after the game's update and before the camera and the shadows: a
	 * swap asked for and ready, or the next of the frames after one. */
	update(): void {

		// the frame before ends here
		const now = performance.now();
		if ( this.frameMs > 0 ) {

			if ( this.work.frames.length < 20000 ) this.work.frames.push( + this.frameAt.toFixed( 1 ), + this.frameMs.toFixed( 3 ) );
			this.frameMs = 0;

		}
		this.frameAt = now;
		if ( this.after.length > 0 ) {

			const k = this.afterStep ++;
			if ( ! this.after[ 0 ]() ) this.after.shift();
			const ms = performance.now() - now;
			this.times[ `after ${ k }` ] = ms;
			this.charge( ms, `after ${ k }` );
			if ( this.after.length === 0 ) this.work.ended = performance.now();
			return;

		}
		if ( this.wanted.length > 0 && this.state.phase === 'ready' ) {

			this.swap();
			this.charge( performance.now() - now, 'swap' );

		}

	}

	// Adds growth work to the frame under way.
	private charge( ms: number, stage: string ): void {

		this.frameMs += ms;
		if ( this.frameMs > this.work.max ) {

			this.work.max = this.frameMs;
			this.work.stage = stage;

		}

	}

	// ------------------------------------------------------------------ the pending version

	private next(): void {

		const step = this.state.step + 1;
		if ( step > GROWTH.maxSteps ) {

			this.state.phase = 'idle';
			this.state.pending = - 1;
			for ( const resolve of this.wanted.splice( 0 ) ) resolve();
			return;

		}
		this.state.pending = step;
		this.state.phase = 'generating';
		for ( const key of Object.keys( this.times ) ) delete this.times[ key ];
		Object.assign( this.work, { max: 0, stage: '', frames: [], slow: [], prepared: 0, swapped: 0, ended: 0 } );
		const t = performance.now();
		const clock = ( ms: number ) => this.charge( ms, 'generate' );
		generateVersion( { worldSeed: this.seed, step }, { cache: this.cache, threads: 2, from: this.shown.version, clock } ).then( ( g ) => {

			this.times.generate = Math.round( performance.now() - t );
			this.state.phase = 'preparing';
			this.steps = this.prepare( g.version );
			this.schedule();

		} ).catch( ( error: unknown ) => this.fail( error ) );

	}

	private fail( error: unknown ): void {

		console.error( 'The island could not grow', error );
		this.state.phase = 'failed';
		this.state.error = String( error );
		for ( const resolve of this.wanted.splice( 0 ) ) resolve();

	}

	// Runs the preparation's steps in idle time, a slice at a time.
	private schedule(): void {

		if ( this.idleQueued || this.waiting || ! this.steps ) return;
		this.idleQueued = true;
		const run = ( deadline?: { timeRemaining(): number } ) => {

			this.idleQueued = false;
			const t = performance.now(), until = t + ( deadline ? Math.min( deadline.timeRemaining(), SLICE ) : SLICE );
			if ( ! this.work.prepared ) this.work.prepared = t;
			try {

				do {

					const before = performance.now(), stage = this.stage;
					const next = this.steps!.next();
					const took = performance.now() - before;
					this.times[ `longest step ${ stage }` ] = Math.max( this.times[ `longest step ${ stage }` ] ?? 0, took );
					if ( this.stage !== stage ) this.stepIndex = 0;
					else this.stepIndex ++;
					if ( took > SLOW && this.work.slow.length < 500 ) this.work.slow.push( [ stage, this.stepIndex, + took.toFixed( 2 ) ] );
					if ( next.done ) {

						this.steps = null;
						this.prepared = next.value;
						this.state.phase = 'ready';
						if ( this.wanted.length === 0 ) console.info( `growth: step ${ this.state.pending } ready`, this.times );
						return;

					}
					if ( next.value instanceof Promise ) {

						this.waiting = true;
						next.value.then( () => {

							this.waiting = false;
							this.schedule();

						}, ( error: unknown ) => this.fail( error ) );
						break;

					}

				} while ( performance.now() < until );

			} catch ( error ) {

				this.fail( error );
				return;

			} finally {

				this.time( 'prepare', t );
				this.charge( performance.now() - t, this.stage );

			}
			this.schedule();

		};
		const page = globalThis as { requestIdleCallback?: ( callback: ( deadline: { timeRemaining(): number } ) => void, options?: { timeout: number } ) => number };
		if ( page.requestIdleCallback ) page.requestIdleCallback( run, { timeout: 200 } );
		else setTimeout( run, 0 );

	}

	private time( name: string, since: number ): void {

		const ms = performance.now() - since;
		this.times[ name ] = ( this.times[ name ] ?? 0 ) + ms;
		this.times[ `${ name } max` ] = Math.max( this.times[ `${ name } max` ] ?? 0, ms );

	}

	private * prepare( version: VersionChunks ): Steps<Prepared<M>> {

		const page = this.page, shown = this.shown, renderer = page.renderer;
		this.stage = 'chunks';
		// a rebuilt chunk equal to the shown one is the shown one
		const before = new Map( shown.version.chunks.map( ( c ) => [ `${ c.ci },${ c.cj }`, c ] ) );
		const chunks = version.chunks.map( ( c ) => {

			const old = before.get( `${ c.ci },${ c.cj }` );
			return old && old !== c && old.hash === c.hash ? old : c;

		} );
		version.chunks = chunks;
		const changed = chunks.filter( ( c ) => before.get( `${ c.ci },${ c.cj }` ) !== c );
		yield;

		// the merge
		this.stage = 'merge';
		const data: WorldData = yield* mergeSteps( version.land, chunks );
		const land = LandLattice.fromBytes( data.land );
		yield;
		const bounds = landBounds( land );
		yield;
		const measured = page.measure( land );
		yield;

		// the island: a mesh per changed land chunk, its buffers uploaded. The frame's passes draw it
		// with the pipelines the loaded chunks drew with (the same material and layout): nothing is
		// compiled ahead (the swap's frame makes its render objects, which build no pipeline).
		this.stage = 'island';
		const changedKeys = new Set( changed.map( ( c ) => `${ c.ci },${ c.cj }` ) );
		const add: THREE.Mesh[] = [];
		for ( const part of data.islands ) {

			if ( ! changedKeys.has( `${ part.ci },${ part.cj }` ) ) continue;
			const mesh = islandMesh( part, page.world.cliff );
			add.push( mesh );
			yield* geometrySteps( renderer, mesh.geometry );

		}
		const remove = ( page.world.island.children as THREE.Mesh[] ).filter( ( mesh ) => {

			const part = mesh.userData.part as IslandChunk;
			return changedKeys.has( `${ part.ci },${ part.cj }` );

		} );
		if ( debugFlags.growthCompile ) {

			for ( const mesh of add ) yield page.compileDraws( [ mesh ], false );
			if ( add.length ) yield page.rain.collision.prepare( renderer, add );

		}
		this.stage = 'stones';
		// the merged kinds' new geometry, its bounds and buffers
		const rocks = stonesGeometry( data, false );
		yield* boundsSteps( rocks );
		yield* geometrySteps( renderer, rocks );
		const seabed = seabedGeometry( data, false );
		yield* boundsSteps( seabed );
		yield* geometrySteps( renderer, seabed );

		// the walking loop, and the meadow planted on it a slice of anchors at a time
		this.stage = 'grass';
		const points = walkPoints( data.walk ), walkDistance = walkLoopDistance( points );
		yield;
		const walk = Villagers.loop( points );
		yield;
		const veg = data.vegetation, anchors = veg.length / VEGETATION_STRIDE;
		const tufts: GrassTufts = { lawn: [], tussocks: [], lawnThin: [] };
		const plants: Plant[][] = page.flowers.children.map( () => [] );
		for ( let a = 0; a < anchors; a += 16 ) {

			const part = plantGrass( veg.subarray( a * VEGETATION_STRIDE, Math.min( anchors, a + 16 ) * VEGETATION_STRIDE ), data.rimGround, walkDistance );
			tufts.lawn.push( ...part.lawn );
			tufts.tussocks.push( ...part.tussocks );
			tufts.lawnThin.push( ...part.lawnThin );
			yield;

		}
		const grass = yield* grassSteps( page.grass, tufts, 256 );
		yield;
		for ( const buffer of Object.values( grass.buffers ) as CullBuffers[ keyof CullBuffers ][] ) yield* uploadSteps( renderer, buffer, AttributeType.STORAGE );
		this.stage = 'flowers';
		for ( let a = 0; a < anchors; a += 128 ) {

			const part = plantFlowers( veg.subarray( a * VEGETATION_STRIDE, Math.min( anchors, a + 128 ) * VEGETATION_STRIDE ), walkDistance );
			part.forEach( ( list, s ) => plants[ s ].push( ...list ) );
			yield;

		}
		// per species its instances, written in place at the swap with their box, or (outgrown) a
		// new mesh, compiled (and its proxy in the rain's bake)
		const flowers: Prepared<M>[ 'flowers' ] = { instances: [], replacements: [], boxes: [] };
		for ( let k = 0; k < plants.length; k ++ ) {

			const instances = flowerInstances( [ plants[ k ] ] )[ 0 ];
			flowers.instances.push( instances );
			yield;
			const replacement = flowerReplacement( page.flowers, k, instances );
			flowers.replacements.push( replacement );
			flowers.boxes.push( replacement ? null : instancesBox( ( page.flowers.children[ k ] as THREE.Mesh ).geometry, instances.matrices, instances.count ) );
			yield;
			if ( replacement ) {

				yield page.compileDraws( [ replacement ] );
				yield page.rain.collision.prepare( renderer, [ replacement ] );

			}

		}
		// the bushes' instances and their box, as InstancedMesh.computeBoundingBox finds it (the sun's
		// caster box reads it)
		const bushes = bushInstances( data.bushes );
		yield;
		const bushBox = instancesBox( page.foliage.geometry, bushes.matrices, bushes.count );
		yield;

		// the rim's trails and the turf skirt (their bounds found in the steps)
		this.stage = 'rim';
		const rim: RimFoliageBuilt = yield* rimFoliageSteps( data.rimStrands, 1 );
		if ( rim.geometry ) yield* geometrySteps( renderer, rim.geometry );
		this.stage = 'skirt';
		const skirt: TurfSkirtBuilt = yield* turfSkirtSteps( data.rimSkirt, 8 );
		yield* geometrySteps( renderer, skirt.geometry );

		// the fields, and the shore's wave fields from the new shore field (in a worker, on a copy)
		this.stage = 'fields';
		const fields: FieldsPrepared = yield* page.fields.steps( data, changed, renderer );
		this.stage = 'shore';
		const copy = new Float32Array( data.shore.data.length );
		for ( let k = 0; k < copy.length; k += 1 << 16 ) {

			copy.set( data.shore.data.subarray( k, k + ( 1 << 16 ) ), k );
			yield;

		}
		let shore: ShoreFields | null = null;
		yield page.shoreWaves.fieldsFor( data, copy ).then( ( fieldsOf ) => { shore = fieldsOf; } );
		yield* textureSteps( renderer, shore!.boundary );
		yield* textureSteps( renderer, shore!.shelter );
		const top = topFromTiles( chunks );
		return {
			version, measured, bounds, data, land, changed, islands: { add, remove }, rocks, seabed, walk, grass,
			flowers, bushes: { instances: bushes, box: bushBox },
			rim, skirt, fields, shore: shore!, top,
		};

	}

	// ------------------------------------------------------------------ the swap

	private swap(): void {

		const t0 = performance.now();
		const parts: Record<string, number> = {};
		let mark = t0;
		const part = ( name: string ) => { const now = performance.now(); parts[ name ] = + ( now - mark ).toFixed( 2 ); mark = now; };
		const p = this.prepared!, page = this.page, world = page.world;
		this.prepared = null;
		this.work.swapped = t0;
		this.state.phase = 'swapping';
		const disposals: ( () => void )[] = [];

		// the island: the changed chunks' meshes out, the new ones in, ordered by chunk
		for ( const mesh of p.islands.remove ) {

			world.island.remove( mesh );
			disposals.push( () => mesh.geometry.dispose() );

		}
		for ( const mesh of p.islands.add ) world.island.add( mesh );
		const order = ( m: THREE.Object3D ) => { const part = m.userData.part as IslandChunk; return part.cj * 65536 + part.ci; };
		world.island.children.sort( ( a, b ) => order( a ) - order( b ) );
		// the merged kinds
		const oldRocks = world.rocks.geometry, oldSeabed = world.seabed.geometry;
		world.rocks.geometry = p.rocks;
		world.seabed.geometry = p.seabed;
		disposals.push( () => { oldRocks.dispose(); oldSeabed.dispose(); } );
		derive( world, p.data );
		part( 'meshes' );
		const oldGrass = setGrass( page.grass, p.grass );
		const atDisposal = ( renderer: THREE.WebGPURenderer ) => {

			const attributes = ( renderer as unknown as { _attributes?: { delete( attribute: unknown ): void } } )._attributes;
			for ( const buffer of Object.values( oldGrass ) ) attributes?.delete( buffer );

		};
		disposals.push( () => atDisposal( page.renderer ) );
		const oldFlowers = setFlowers( page.flowers, p.flowers.instances, p.flowers.replacements, p.flowers.boxes );
		disposals.push( () => { for ( const mesh of oldFlowers ) { mesh.geometry.dispose(); mesh.dispose(); } } );
		setBushes( page.foliage, p.bushes.instances );
		page.foliage.boundingBox = p.bushes.box;
		const oldRim = setRimFoliage( page.rimFoliage, p.rim );
		const oldSkirt = setTurfSkirt( page.turfSkirt, p.skirt );
		disposals.push( () => { oldRim?.dispose(); oldSkirt.dispose(); } );
		part( 'vegetation' );
		// the fields and the shore's wave fields
		const oldFields = page.fields.apply( p.fields, page.renderer ), oldTextures = page.shoreWaves.setFields( p.shore );
		disposals.push( () => { for ( const dispose of oldFields ) dispose(); for ( const texture of oldTextures ) texture.dispose(); } );
		part( 'fields' );
		// what draws or reads the island
		page.refractedSun.setCasters( world.group, world.subsets );
		page.characters?.setLoop( p.walk );
		part( 'casters' );
		const previous = this.shown;
		this.shown = { version: p.version, data: p.data, land: p.land };
		this.state.step = p.version.step;
		this.state.pending = - 1;
		this.state.swaps ++;
		this.afterStep = 0;
		page.onSwap( p.land, p.data, p.measured );
		part( 'page' );
		const swapMs = performance.now() - t0;
		const box: Bounds = p.bounds;
		// (the rain's map a few meshes a frame)
		let bake: Generator<void, void> | null = null;
		this.after.push(
			() => {

				if ( ! bake ) {

					page.rain.collision.setArea( box );
					bake = page.rain.collision.bakeSteps( page.renderer, page.rainRoots, 8 );

				}
				return ! bake.next().done;

			},
			() => page.game?.setIsland( p.land, p.data.bushes, p.top ),
			() => {

				for ( const dispose of disposals ) dispose();
				page.onSwapped?.( p.data );
				const rebuilt = p.version.chunks.length - p.version.reused;
				this.state.last = {
					step: p.version.step, chunks: p.version.chunks.length, rebuilt, changed: p.changed.length, at: + t0.toFixed( 1 ),
					added: p.islands.add.length, removed: p.islands.remove.length,
					ms: { ...Object.fromEntries( Object.entries( this.times ).map( ( [ k, v ] ) => [ k, + v.toFixed( 2 ) ] ) ), swap: + swapMs.toFixed( 2 ), ...Object.fromEntries( Object.entries( parts ).map( ( [ k, v ] ) => [ `swap ${ k }`, v ] ) ) },
				};
				console.info( `growth: step ${ previous.version.step } -> ${ p.version.step }`, this.state.last );
				this.state.phase = 'idle';
				const done = this.wanted.shift();
				done?.();
				this.next();

			},
		);

	}

}

// An InstancedMesh's box over `count` instances of `matrices`, as its computeBoundingBox finds it.
function instancesBox( geometry: THREE.BufferGeometry, matrices: Float32Array, count: number ): THREE.Box3 {

	if ( geometry.boundingBox === null ) geometry.computeBoundingBox();
	const box = new THREE.Box3(), part = new THREE.Box3(), m = new THREE.Matrix4();
	for ( let i = 0; i < count; i ++ ) {

		m.fromArray( matrices, i * 16 );
		part.copy( geometry.boundingBox! ).applyMatrix4( m );
		box.union( part );

	}
	return box;

}
