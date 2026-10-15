import * as THREE from 'three/webgpu';
import { generateVersion, type LoadedWorld, type VersionChunks } from './WorldChunks.ts';
import { mergeSteps } from './ChunkMerge.ts';
import { GROWTH, LandLattice } from './IslandGrowth.ts';
import { landBounds, type Bounds } from './WorldShapes.ts';
import { derive, islandMesh, seabedGeometry, stonesGeometry, type WorldMeshes } from './World.ts';
import type { WorldFields, FieldsPrepared } from './WorldFields.ts';
import { geometrySteps, textureSteps } from './Upload.ts';
import { boundsSteps } from './Steps.ts';
import { plantSiteSteps, anchorContactSteps } from './PlantSites.ts';
import { walkLoopDistance, walkPoints } from './WalkPath.ts';
import { topFromTiles } from '../game/sim/grid.ts';
import type { GrowthInput, GrowthSteps, Vegetation, VegetationKind } from './vegetation/Registry.ts';
import type { ChunkData } from './Chunks.ts';
import type { IslandChunk, WorldData } from './types.ts';
import type { ShoreWaves, ShoreFields } from '../ocean/ShoreWaves.ts';
import type { RefractedSun } from '../lighting/RefractedSun.ts';
import type { Rain } from '../weather/Rain.ts';
import { Villagers } from '../characters/Villagers.ts';
import { SeabedRise } from './SeabedRise.ts';

// The island grows in place (chunk design, sections 3.4, 10 and 11; plan M8): the next piece is
// generated in the background, and a Grow (`grow()`, the GUI's Island folder) swaps in only the
// chunks that changed, in one frame, with every dependent following. No pipeline is built: a swap
// needing one would be a bug (tools/verify-first-use.mjs and the page's pipeline count). A grown
// page against a fresh load of its land, pipelines across swaps included: tools/verify-growth-swap.mjs.
//
// - When: the game (`start()` once the page shows) generates the next piece at once, as it will
//   need it; any other page only from its first `grow()`, so a page that never grows spends no
//   worker time on it. From then on one piece is kept ahead: the next is asked for (in idle time)
//   once a swap's frames are done. The game's population sets when (Game.ts): it is told the
//   pending piece once it is ready (`game.setComing`), and asks for the grow once a step is due.
// - Versions: a version is a land step and its chunks (WorldChunks.ts `VersionChunks`). The shown
//   one is the page's; the next step is generated as the pending one, on at most two workers (the
//   shown one's own chunks are taken over wherever the growth steps in a chunk's window are the
//   same, Chunks.ts dirtyChunks, so only the rebuild set is generated or read from the cache). A
//   rebuilt chunk whose hash equals the shown one's is the shown one's (the same object), so it is
//   not swapped: `changed` lists the chunks whose data differs.
// - Preparation, in idle time (requestIdleCallback; a timer where there is none), slices of at
//   most SLICE ms of steps of a few tenths of a millisecond each: the merge (ChunkMerge.ts
//   mergeSteps), the land's box and the page's framing of it (`measure`), the new island meshes
//   of the changed land chunks, the merged kinds' new geometry (the stones, the sea floor, the
//   turf skirt, the rim trails, their bounds found in steps: Steps.ts), the shrubs and small trees
//   (sited off the walking loop, their shade baked into the anchors before the meadow reads them,
//   only the plants not grown before grown, all copied into one new geometry: Plants.ts), the
//   meadow (planted a slice of anchors at a step, its cull pool filled), the bushes' instances,
//   each vegetation kind its own part
//   after the plants' sites, in registry order (vegetation/Registry.ts), the world fields (WorldFields.ts)
//   and the shore's wave fields (in a worker, ShoreWaves.ts, on a copy of the shore field made in
//   steps). Every buffer and texture goes up ahead, a slice a step (Upload.ts: buffers mapped at
//   creation and copies on the GPU, never queue writes, which stalled the page for hundreds of
//   milliseconds with the GPU busy). The bushes' instances are written in place at the swap (a
//   new instanced mesh would be a node build of tens of milliseconds), so
//   their data is staged ahead too and three's write at their first draw becomes a copy on the GPU
//   (Upload.ts stagedWriteSteps): as queue writes, each 256 KB of instance matrices blocked the
//   main thread for 15-35 ms on a running page, and the first frame after the swap (the rain's map
//   draws them first) took 50-200 ms. Nothing is compiled ahead for the island's chunks: their draws use
//   the pipelines the loaded chunks drew with (the same materials and layouts), and the swap's
//   frame only makes their render objects (compiling ahead cost 10-19 ms of the main thread per
//   chunk, more than that frame's share).
//   A grow asked for before it is done swaps once it is.
// - The swap, in the frame's tick before the camera and the shadows update (main.ts's one-line
//   hook): the changed island meshes out and the new ones in (ordered by chunk, ( cj, ci ), as a
//   page loaded on that land orders them), the merged kinds' geometry, then each vegetation kind's
//   swap (the plants' and the trails' geometry, the bushes' instances, the
//   meadow's pool: the cull's storage nodes (vegetation/VegetationCull.ts) pointed at the new buffers),
//   the fields' changed squares (copied on the GPU) or new textures, the shore's wave fields, the
//   refracted sun's casters, the walker's loop, and the page's own (main.ts `onSwap`: the land's
//   box and framing as measured ahead, the fog's clearing, the sun's caster box and columns, the
//   sea's reflection box, the camera's ground).
// - The frames after it, one step each: the rain's collision map (resized, then baked again eight
//   meshes a frame from the island and the kinds registered with `rainBake`: RainCollision.bakeSteps), the game's ground (the chunks' walk tiles,
//   sim/grid.ts), the old resources disposed (a kind a frame), the page's own (`onSwapped`).
//   A replaced mesh, and the refracted sun's and the rain map's proxies of it, are disposed as
//   objects, not only their geometry: three keeps a render object (and its uniform buffers) per
//   object and pass until the object's dispose. Their shared materials stay. They go after the swap's
//   frame has drawn their successors, so no pipeline loses its last user. A replaced texture is not
//   uploaded again by a later chunk's first draw (graph/ThreePatches.ts `installBindingPatches`).
// - The growth's own main-thread time is counted per frame (`work`; the workers' replies
//   included), and kept with the swap's record (`state.last.work`): no frame's share should pass
//   2 ms (plan M8's frame-time acceptance).
// - The page then draws what a page loaded on the grown land draws, bit for bit (paused): every
//   dependent is the same function of the same version, and the island's meshes are split and
//   ordered alike (World.ts on split draws).
// - The shoal (SeabedRise.ts, `rise`): once the next version is generated, the preparation's first
//   steps find the floor tiles it changes and install them; from then on the floor there rises
//   toward the next version's as the approach (`approach`, 0 .. 1) grows, and the swap resets it.
//   `approach` and `approachNow` start the generation first, so a page that only moves the GUI's
//   Approach slider gets a pending piece. Its writes count in `work` (stage 'rise').

/** What the growth changes on the page: its world objects, and the page's own hooks. */
export interface GrowthPage<M = unknown> {
	renderer: THREE.WebGPURenderer;
	world: WorldMeshes;
	fields: WorldFields;
	/** the vegetation's kinds (vegetation/Registry.ts): each prepares and swaps its own part, and
	 * the rain's collision map is baked from the island and the kinds that take part in it */
	vegetation: Vegetation;
	shoreWaves: ShoreWaves;
	refractedSun: RefractedSun;
	rain: Rain;
	characters: Villagers | null;
	/** the game (?game): the pending piece once it is ready (`setComing`), the new land after a swap (`setIsland`) */
	game: {
		setComing( land: LandLattice, bushes: Float32Array, top?: Uint8Array, plants?: Float32Array ): void;
		setIsland( land: LandLattice, bushes: Float32Array, top?: Uint8Array, plants?: Float32Array ): void;
	} | null;
	/** the page's own land-dependent state, in the swap's frame */
	/** what the page measures of a land (its box and framing), ahead in a step of the preparation */
	measure( land: LandLattice ): M;
	/** the page's own land-dependent state, in the swap's frame, with `measure`'s result */
	onSwap( land: LandLattice, data: WorldData, measured: M ): void;
	/** after the swap's frames (the chunks' borders, the diagnostics) */
	onSwapped?( data: WorldData ): void;
	/** the shoal's floor was written anew (SeabedRise.ts): a change no frame before shows */
	onRise?(): void;
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
	// the shrubs and small trees sited on the land (PlantSites.ts), for the game
	plantSites: Float32Array;
	// each growing vegetation kind's prepared part, in registry order
	vegetation: { kind: VegetationKind; prepared: unknown }[];
	fields: FieldsPrepared;
	shore: ShoreFields;
	top: Uint8Array;
	// the staged in-place writes of the bushes, freed after the swap
	staged: ( () => void )[];
}

/** What the growth is doing: `idle` (nothing pending: at the horizon, or between steps), generating
 * the pending version in the workers, preparing it on the page, `ready` to swap, `swapping` (the
 * swap and the frames after it). */
export type GrowthPhase = 'idle' | 'generating' | 'preparing' | 'ready' | 'swapping' | 'failed';

// A preparation step yields nothing (a slice ends) or a promise (wait for it: a worker, a compile).
type Steps<T> = GrowthSteps<T>;

// The idle time a slice of preparation takes at most (ms; where there is no idle callback, the
// time a timer's slice takes). A slice runs steps until it has used this, so it ends at most a step
// later: steps are a few tenths of a millisecond, and a frame's whole share of the growth stays
// under 2 ms (`work`).
const SLICE = 1;
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
		last: null as null | { step: number; chunks: number; rebuilt: number; changed: number; added: number; removed: number; ms: Record<string, number>; at: number; work: Growth[ 'work' ] },
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
	/** the shoal under the next piece */
	readonly rise: SeabedRise;
	private sceneTime = - 1;

	constructor( private readonly page: GrowthPage<M>, loaded: LoadedWorld, { seed, cache }: { seed: number; cache: boolean } ) {

		this.seed = seed;
		this.cache = cache;
		this.shown = { version: loaded.version, data: loaded.data, land: LandLattice.fromBytes( loaded.data.land ) };
		this.state.step = loaded.version.step;
		this.rise = new SeabedRise( page.world.seabed, page.fields, page.refractedSun, page.renderer, () => page.onRise?.() );

	}

	/** The progress toward the next piece (0 .. 1): the floor under it rises toward its grown form,
	 * easing over seconds of scene time (SeabedRise.ts). Starts generating the piece if none is. */
	approach( p: number ): void {

		this.start();
		this.rise.approach( p );

	}

	/** `approach`, with the floor put on it at once (the URL's option, a scene jump, a paused page's
	 * slider): resolves once it is written, which for p > 0 waits for the next piece to be generated
	 * and its tiles installed. At 0 nothing is generated. */
	approachNow( p: number ): Promise<void> {

		const waits = p > 0 && this.state.step < GROWTH.maxSteps && this.state.phase !== 'failed';
		if ( waits ) this.start();
		return this.rise.snap( p, waits );

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

	/** Once a frame, in the tick after the game's update and before the camera and the shadows, at
	 * scene time `time` (s): the shoal eased and written, a swap asked for and ready, or the next of
	 * the frames after one. */
	update( time: number ): void {

		// the frame before ends here
		const now = performance.now();
		if ( this.frameMs > 0 ) {

			if ( this.work.frames.length < 20000 ) this.work.frames.push( + this.frameAt.toFixed( 1 ), + this.frameMs.toFixed( 3 ) );
			this.frameMs = 0;

		}
		this.frameAt = now;
		// (a seek back holds R; one forward eases it at most a quarter of a second's worth)
		const dt = this.sceneTime < 0 ? 0 : Math.min( 0.25, Math.max( 0, time - this.sceneTime ) );
		this.sceneTime = time;
		this.rise.update( dt );
		const risen = performance.now() - now;
		if ( risen > 0.05 ) this.charge( risen, 'rise' );
		if ( this.after.length > 0 ) {

			const k = this.afterStep ++;
			if ( ! this.after[ 0 ]() ) this.after.shift();
			const ms = performance.now() - now;
			this.times[ `after ${ k }` ] = ms;
			this.charge( ms, `after ${ k }` );
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
						this.page.game?.setComing( next.value.land, next.value.data.bushes, next.value.top, next.value.plantSites );
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
		this.idle( run );

	}

	// `run` in idle time (requestIdleCallback; a timer where there is none)
	private idle( run: ( deadline?: { timeRemaining(): number } ) => void ): void {

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

		// the shoal: the floor this version changes, installed at once (SeabedRise.ts)
		this.stage = 'shoal';
		this.rise.install( yield* SeabedRise.plan( shown.version.chunks, chunks, page.fields, page.world.seabed.geometry ) );
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
		this.stage = 'stones';
		// the merged kinds' new geometry, its bounds and buffers
		const rocks = stonesGeometry( data, false );
		yield* boundsSteps( rocks );
		yield* geometrySteps( renderer, rocks );
		const seabed = seabedGeometry( data, false );
		yield* boundsSteps( seabed );
		yield* geometrySteps( renderer, seabed );

		// the walking loop, and the plants' sites off it
		this.stage = 'walk';
		const points = walkPoints( data.walk ), walkDistance = walkLoopDistance( points );
		yield;
		const walk = Villagers.loop( points );
		yield;
		// the shrubs and small trees off the loop, and their shade in the anchors' sky visibility
		// before the meadow reads it
		this.stage = 'plants';
		const plantSites = yield* plantSiteSteps( data.vegetation, data.bushes, walkDistance );
		yield* anchorContactSteps( data.vegetation, plantSites );
		// each vegetation kind's part, in registry order (vegetation/Registry.ts); what a kind writes
		// in place at the swap is staged here, so that it is copied on the GPU
		const staged: ( () => void )[] = [];
		const input: GrowthInput = {
			renderer, data, walkDistance, plantSites,
			stage: ( free ) => { if ( free ) staged.push( free ); },
		};
		const vegetation: Prepared<M>[ 'vegetation' ] = [];
		for ( const kind of page.vegetation.kinds ) {

			if ( ! kind.growth ) continue;
			this.stage = kind.name;
			vegetation.push( { kind, prepared: yield* kind.growth.prepare( input ) } );

		}

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
			version, measured, bounds, data, land, changed, islands: { add, remove }, rocks, seabed, walk, plantSites,
			vegetation, fields, shore: shore!, top, staged,
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
			// (the mesh's own dispose releases its draws: three keeps a render object, and its
			// uniform buffers, per object and pass until then; the material is shared and stays)
			disposals.push( () => { mesh.geometry.dispose(); mesh.dispose(); } );

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
		// the vegetation's kinds, each its own part (vegetation/Registry.ts)
		for ( const { kind, prepared } of p.vegetation ) {

			const dispose = kind.growth!.swap( prepared );
			if ( dispose ) disposals.push( dispose );

		}
		disposals.push( () => { for ( const free of p.staged ) free(); } );
		part( 'vegetation' );
		// the shoal's tiles go with the old floor, and its field squares the swap keeps are written back;
		// then the fields and the shore's wave fields
		const kept = ( key: 'floor' | 'beds' ) => p.fields.textures[ key ] ? null : new Set( ( p.fields.staged[ key ]?.rects ?? [] ).map( ( [ x, y ] ) => `${ x },${ y }` ) );
		this.rise.clear( { floor: kept( 'floor' ), beds: kept( 'beds' ) } );
		const oldFields = page.fields.apply( p.fields, page.renderer ), oldTextures = page.shoreWaves.setFields( p.shore );
		disposals.push( () => { for ( const dispose of oldFields ) dispose(); for ( const texture of oldTextures ) texture.dispose(); } );
		part( 'fields' );
		// what draws or reads the island
		disposals.push( page.refractedSun.setCasters( world.group, world.subsets ) );
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
					bake = page.rain.collision.bakeSteps( page.renderer, [ world.group, ...page.vegetation.roots( ( kind ) => kind.rainBake ) ], 8 );

				}
				return ! bake.next().done;

			},
			() => page.game?.setIsland( p.land, p.data.bushes, p.top, p.plantSites ),
			// (the old resources a frame each)
			...disposals.map( ( dispose ) => () => dispose() ),
			() => page.onSwapped?.( p.data ),
			() => {

				const rebuilt = p.version.chunks.length - p.version.reused;
				this.work.ended = performance.now();
				this.state.last = {
					step: p.version.step, chunks: p.version.chunks.length, rebuilt, changed: p.changed.length, at: + t0.toFixed( 1 ),
					added: p.islands.add.length, removed: p.islands.remove.length,
					ms: { ...Object.fromEntries( Object.entries( this.times ).map( ( [ k, v ] ) => [ k, + v.toFixed( 2 ) ] ) ), swap: + swapMs.toFixed( 2 ), ...Object.fromEntries( Object.entries( parts ).map( ( [ k, v ] ) => [ `swap ${ k }`, v ] ) ) },
					work: { ...this.work },
				};
				console.info( `growth: step ${ previous.version.step } -> ${ p.version.step }`, this.state.last );
				this.state.phase = 'idle';
				const done = this.wanted.shift();
				done?.();
				// the next piece is asked of the workers in idle time, not in a frame (starting them
				// takes a few milliseconds)
				this.idle( () => this.start() );

			},
		);

	}

}
