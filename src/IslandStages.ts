// The island's stages: the island built a stage at a time on the renderer's stages
// (RenderStages.ts), in the order the entry (main.ts) calls them. Each stage puts what it builds on
// the one IslandParts object: the island's camera, the islanders' trail and shadow, the ground's
// scans, the world's data and land, its meshes, its debug views, the vegetation, and the growth in
// place. The rules of RenderStages.ts hold here too: the statements' order is part of the image,
// and a stage that ends in a wait returns its promise to the entry.
// - The page's camera views (app/CameraViews.ts) need the document, so the page hangs them on the
//   object as the hooks the land's changes call: `frameLand`, `holdsFraming`, `followFraming`,
//   `poseIslandView`, `islandViewOptions`.
import { WIND_VIEW, shared, testSources, debugFlags, TEST_MODE, declareSceneEvents, installVegetationPrepass, createDisplacementField, displacementField, installOpaquePrepass, GTAO, SS_SHADOW, Vegetation, defaultPlant, installWindMotionFlag, type RenderParts } from './render.ts';
import { settings as params, type SettingsQuery } from './renderSetup.ts';
import * as THREE from 'three/webgpu';
import { FreeCameraControls } from './camera/FreeCameraControls.ts';
import { IslandCameraControls } from './camera/IslandCameraControls.ts';
import { FramingGlide, IslandTurn, landOutline } from './camera/IslandFraming.ts';
import { Wenyao } from './life/Wenyao.ts';
import { FallingLeaves } from './weather/FallingLeaves.ts';
import { bakeGroundTextures } from './materials/GroundTextures.ts';
import { buildWorldMeshes } from './world/World.ts';
import type { WorldData } from './world/types.ts';
import { WorldFields } from './world/WorldFields.ts';
import { Growth } from './world/Growth.ts';
import { worldProgress, landFraming, worldCacheOn } from './world/WorldStart.ts';
import { buildChunkBorders } from './debug/ChunkBorders.ts';
import { windArrowGeometry, buildWindArrows } from './debug/WindArrows.ts';
import { buildGrass, plantGrass, grassKind } from './world/Grass.ts';
import { buildYunpeng, yunpengKind, yunpengLights } from './world/Yunpeng.ts';
import { landBounds, islandSurfaceHeight } from './world/WorldShapes.ts';
import { GROWTH, LandLattice } from './world/IslandGrowth.ts';
import { walkPoints } from './world/WalkPath.ts';
import { buildBamboo, bambooKinds } from './world/Bamboo.ts';
import { loadBambooLook } from './world/BambooGroves.ts';
import { singleLeaf, leafAtlas as bambooAtlas } from './world/BambooMaterials.ts';
import { loadVillager, type Villagers } from './characters/Villagers.ts';
import { Trample } from './world/vegetation/Trample.ts';
import { PROPORTION_NAMES, type ProportionName, PROPORTIONS } from './characters/Proportions.ts';
import { type Body, parseBodies } from './characters/Ages.ts';
import { CharacterShadow } from './characters/CharacterShadow.ts';
import { registerIslandClasses } from './world/IslandClasses.ts';
import { ISLANDER, HANMING, ISLANDER_LOOKS, HANMING_LOOKS } from './characters/looks.ts';
import type { GroundTextures } from './materials/GroundTextures.ts';
import type { LoadedWorld } from './world/WorldChunks.ts';
import type { Bounds } from './renderData.ts';
import type { WorldMeshes } from './world/World.ts';
import type { Yunpeng } from './world/Yunpeng.ts';
import type { Bamboo } from './world/Bamboo.ts';
import type { Look } from './characters/looks.ts';
import type { Villager } from './characters/Villagers.ts';

// The island's scene events (post/SceneEvents.ts), and whether each cuts the temporal history:
// the island grew (Growth.ts: new land where the sea was, the rest unchanged; the resolve's clip
// takes the new surfaces as it takes a placed prop), and the shoal under the next piece was
// written anew (SeabedRise.ts: the floor moves in place).
const islandEvent = declareSceneEvents( {
	'world swap': false,
	'approach': false,
} );

/** What the page measures of a land: its box, how the views frame it and its outline. */
type LandMeasure = { box: Bounds; framing: { centroid: { x: number; z: number }; scale: number; onLand: ( x: number, y: number, z: number ) => THREE.Vector3; pivot: THREE.Vector3 }; outline: number[] };

export interface IslandParts {
	target: THREE.Vector3;
	controls: IslandCameraControls;
	initialCameraPosition: THREE.Vector3;
	initialCameraQuaternion: THREE.Quaternion;
	initialCameraTarget: THREE.Vector3;
	framingGlide: FramingGlide;
	islandTurn: IslandTurn;
	islandTurned: number;
	islandZoom: number;
	initialCameraFov: number;
	orbitMaxPolar: number;
	orbitMinDistance: number;
	islandNearest: number;
	freeControls: FreeCameraControls;
	trample: Trample;
	characterShadow: CharacterShadow;
	textures: GroundTextures;
	fallingLeaves: FallingLeaves | null;
	t0: number;
	worldCache: LoadedWorld;
	data: WorldData;
	land: LandLattice;
	landBox: Bounds;
	measureLand: ( next: LandLattice ) => LandMeasure;
	landScale: number;
	onLand: ReturnType<typeof landFraming>[ 'onLand' ];
	outline: number[];
	landInfo: { seed: number; step: number; bounds: Bounds; centroid: { x: number; z: number }; scale: number; target: number[] };
	setLand: ( next: LandLattice, step: number, measured?: LandMeasure ) => void;
	fields: WorldFields;
	walk: [ number, number ][];
	world: WorldMeshes;
	wenyao: Wenyao;
	chunkView: { borders: boolean; lines: THREE.LineSegments | null };
	shownData: WorldData;
	showChunkBorders: ( on: boolean ) => void;
	showWindArrows: () => void;
	grass: THREE.Group;
	vegetation: Vegetation<WorldData>;
	yunpeng: Yunpeng;
	setLocalSources: () => void;
	bamboo: Bamboo;
	sunCasters: THREE.Box3;
	heldOpaque: THREE.Box3[];
	holdPlants: () => void;
	setSunCasters: () => void;
	islandMaxDistance: number;
	SCENE_LOOK: Look;
	GAME_LOOKS: readonly Look[];
	islanderBuild: { proportions: ProportionName };
	sceneBody: Body;
	buildIslander: ( name: ProportionName ) => Promise<Villager>;
	compileDraws: ( objects: THREE.Object3D[] ) => Promise<void>;
	characters: Villagers | null;
	worldInfo: { worldTriangles: number };
	growth: Growth<LandMeasure>;
	approachWritten: boolean;
	frameLand: () => void;
	islandViewOptions: SettingsQuery;
	poseIslandView: ( options: SettingsQuery, turn?: number, zoom?: number ) => void;
	holdsFraming: () => boolean;
	followFraming: ( glide?: boolean ) => void;
}

/** The island's camera controls and the free flight's. */
export function createIslandCamera( render: RenderParts, island: IslandParts ) {

	const { renderer, camera } = render;
	// the island's kinds for the kinds' view, registered before any of its materials builds
	registerIslandClasses();
	// The views are framed on the land once the world has loaded (frameLand): the island view just
	// holds the land and its ring of shallows (IslandFraming.ts); the others take the first island's
	// framing, moved to the land's centroid and scaled by its size. An explicit `dist` is in metres.
	island.target = new THREE.Vector3();
	// the island's camera: it starts at the island view's pose and the hand moves it (pans within the
	// land's soft bounds, turns, tilts and zooms out from the island view's framing to 70 m or the
	// framing's own distance, never in past the framing: IslandCameraControls.ts), the
	// drags followed on the frame that draws them; `cameraInput=off` (or the GUI's 'move by hand')
	// holds the view at its framing
	const controls = new IslandCameraControls( camera, renderer.domElement );
	island.controls = controls;
	controls.handInput = params.get( 'cameraInput' ) !== 'off';
	controls.minDistance = 22;
	controls.maxPolarAngle = THREE.MathUtils.degToRad( 82 );
	// the island view's pose (the R key, `setCameraView( 'island' )`); a scene jump, a growth step and
	// a resize set it anew
	island.initialCameraPosition = new THREE.Vector3();
	island.initialCameraQuaternion = new THREE.Quaternion();
	island.initialCameraTarget = new THREE.Vector3();
	// the camera's glide to the island view's new framing when the land grows
	island.framingGlide = new FramingGlide();
	// the island view's input: a turn about its pivot (Q / E, a right or middle drag) and a zoom (the
	// wheel); how far it has turned from the query's heading (rad), and its zoom (0 the farthest, 1
	// the nearest: IslandFraming.ts)
	const islandTurn = new IslandTurn( renderer.domElement );
	island.islandTurn = islandTurn;
	// (the island view never zooms in past its framing, held or by hand: `islandNearest`)
	islandTurn.wheelZoom = 0;
	island.islandTurned = 0; island.islandZoom = 0;
	island.initialCameraFov = camera.fov;
	island.orbitMaxPolar = controls.maxPolarAngle;
	const orbitMinDistance = controls.minDistance;
	island.orbitMinDistance = orbitMinDistance;
	// the island view's nearest zoom: its pose's own distance (frameLand, poseIslandView), so the
	// hand zooms out from the framing but never in past it; the review views keep `orbitMinDistance`
	island.islandNearest = orbitMinDistance;
	// The island view starts where it frames the land alone (without its ring of shallows) from its own
	// heading, looking 50 degrees down (`polar` 40): the whole island in view with a margin of sea, the
	// ground read as a map while the cliff's depth still shows (IslandFraming.ts `landFitDistance`).
	// Framing the shallows too, or the land from every heading, stood half as far again and left the
	// island small in the frame; a fixed 45 m held the first island of 400 m^2 but not one of 1000.
	island.freeControls = new FreeCameraControls( camera, renderer.domElement );

}

/** The islanders' trail through the meadow. */
export function createTrample( render: RenderParts, island: IslandParts ) {


	// The islanders' trail through the meadow (world/vegetation/Trample.ts), drawn after they move each
	// frame into the displacement field (world/vegetation/Displacement.ts), made here over the land's
	// whole lattice and drawn again each frame; across a cut its frame before is not read.
	island.trample = new Trample( createDisplacementField( 2 * GROWTH.half ) );
	render.history.onCut( 'displacement field', () => displacementField?.cut() );

}

/** The islanders' shadow map. */
export function createCharacterShadow( render: RenderParts, island: IslandParts ) {

	const { sun } = render;
	// Moving figures cast through a small map of their own that every receiver multiplies in. It
	// must be installed before any receiving material is built.
	const characterShadow = new CharacterShadow();
	island.characterShadow = characterShadow;
	characterShadow.install( sun );

}

/** Returns the ground's scans, which the entry awaits. */
export function bakeIslandGround( render: RenderParts ) {

	const { renderer } = render;

	// the bamboo's groves (`bamboo=cover,height` loads another look of them), which the ground's
	// floor follows (the textures' grove field) and the meadow thins under and the bamboo stands in
	loadBambooLook( params.get( 'bamboo' ) );
	return bakeGroundTextures( renderer );

}

/**
 * Shows the generator's progress. Returns the world the page's start began, which the entry
 * awaits.
 */
export function awaitWorld( render: RenderParts, island: IslandParts, { worldJob }: { worldJob: Promise<LoadedWorld> } ) {

	const { setStatus } = render;

	// ------------------------------------------------------------------ world

	worldProgress.show = ( text ) => setStatus( `Generating the island…${ text }` );
	worldProgress.show( worldProgress.text );
	island.t0 = performance.now();
	// a failed world must not leave the loading screen saying it is still generating
	return worldJob.catch( ( error: unknown ) => {

		setStatus( 'The island failed to generate (see the console).' );
		throw error;

	} );

}

/** The land and what the page measures of it: its box, its framing, its fields. */
export function createLand( render: RenderParts, island: IslandParts, { landOptions }: { landOptions: { worldSeed: number; step: number } } ) {

	const { mark } = render;
	const { target, worldCache } = island;
	island.measureLand = measureLand;
	island.setLand = setLand;
	worldProgress.show = null;
	const data = worldCache.data;
	island.data = data;
	mark( 'world' );
	// The grown land, and the framing it sets (again whenever the island grows: `setLand`).
	island.land = LandLattice.fromBytes( data.land );
	island.landBox = landBounds( island.land );
	function measureLand( next: LandLattice ) {

		return { box: landBounds( next ), framing: landFraming( next ), outline: landOutline( next ) };

	}
	let centroid: ReturnType<typeof landFraming>[ 'centroid' ];


	( { centroid, scale: island.landScale, onLand: island.onLand } = landFraming( island.land ) );
	// the land's convex hull, which the island view frames (IslandFraming.ts)
	island.outline = [];
	// the land for the tools: its seed and step, box, centroid, the framing's scale against the first
	// island and the default pivot
	const landInfo = { seed: landOptions.worldSeed, step: landOptions.step, bounds: island.landBox, centroid, scale: island.landScale, target: [ 0, 0, 0 ] };
	island.landInfo = landInfo;
	// (`measured`: the land's box and framing found ahead, as Growth.ts's preparation finds them)
	function setLand( next: LandLattice, step: number, measured = measureLand( next ) ): void {

		island.land = next;
		island.landBox = measured.box;
		island.outline = measured.outline;
		( { centroid, scale: island.landScale, onLand: island.onLand } = measured.framing );
		target.copy( island.onLand( 1.5, 0.5, 1 ) );
		Object.assign( landInfo, { step, bounds: island.landBox, centroid, scale: island.landScale, target: target.toArray() } );

	}
	setLand( island.land, landOptions.step );
	// The world fields' textures (WorldFields.ts), sampled through one node each: the shore's distance
	// (its transform is the shared shoreXform), the floor's height and beds over the same bounds, the
	// rim ground over its own.
	island.fields = new WorldFields( data, shared.shoreXform.value );

}

/** The world's meshes, and the wenyao over the sea. */
export function createWorld( render: RenderParts, island: IslandParts ) {

	const { scene, wind, fft, waveMaps } = render;
	const { textures, data, fields } = island;
	island.walk = walkPoints( data.walk );
	const world = buildWorldMeshes( data, textures, shared, waveMaps, fields );
	island.world = world;
	scene.add( world.group );
	// The wenyao's schools off the island (life/Wenyao.ts): swimmers (Refraction.ts markSwimmer), which
	// the opaque pass draws where the eye sees them through the waves (Water.ts swimmerSway).
	const wenyao = new Wenyao( data, shared, waveMaps, fft );
	island.wenyao = wenyao;
	scene.add( wenyao.mesh );
	island.fallingLeaves = TEST_MODE ? null : new FallingLeaves( { shared, fields, soil: textures.soil, wind, atlas: singleLeaf() } );

}

/** The world's debug views: chunk borders, wind arrows. */
export function createWorldViews( render: RenderParts, island: IslandParts ) {

	const { scene } = render;
	const { data } = island;
	if ( island.fallingLeaves ) scene.add( island.fallingLeaves.mesh );
	// The chunks' borders (GUI Ground folder, ?chunkBorders), built on first show.
	const chunkView = { borders: params.has( 'chunkBorders' ), lines: null as THREE.LineSegments | null };
	island.chunkView = chunkView;
	// the version shown (a grown island's, once the island grows)
	island.shownData = data;
	const showChunkBorders = ( on: boolean ) => {

		if ( on && ! chunkView.lines ) scene.add( chunkView.lines = buildChunkBorders( island.shownData ) );
		if ( chunkView.lines ) chunkView.lines.visible = on;

	};
	island.showChunkBorders = showChunkBorders;
	showChunkBorders( chunkView.borders );
	// The wind view's arrows (`windView`, debug/WindView.ts), over the land shown: built only on a page
	// that shows them, again after the island grows.
	let windArrows: THREE.Mesh | null = null;
	const showWindArrows = () => {

		if ( ! WIND_VIEW.arrows ) return;
		if ( windArrows ) {

			windArrows.geometry.dispose();
			windArrows.geometry = windArrowGeometry( island.shownData );

		} else scene.add( windArrows = buildWindArrows( island.shownData, shared.wind ) );

	};
	island.showWindArrows = showWindArrows;
	showWindArrows();

}

/**
 * The meadow, the yunpeng and its lights, the bamboo, the sun's casters and the islanders' looks.
 */
export function createVegetation( render: RenderParts, island: IslandParts ) {

	const { mark, setStatus, renderer, scene, sunShadow } = render;
	const { controls, data, world, frameLand } = island;
	island.setSunCasters = setSunCasters;
	island.compileDraws = compileDraws;
	const grass = buildGrass( plantGrass( data.vegetation ), shared );
	island.grass = grass;
	// The vegetation's kinds (vegetation/Registry.ts), in the order the scene draws them; every list
	// of vegetation below reads it.
	const vegetation = new Vegetation<WorldData>( ( sites, name ) => defaultPlant( shared, sites, name ) );
	island.vegetation = vegetation;
	vegetation.add( grassKind( grass ) );
	// the yunpeng's clumps in the meadow, instances of a few prototypes at two levels (Yunpeng.ts)
	const yunpeng = buildYunpeng( data, shared );
	island.yunpeng = yunpeng;
	vegetation.add( yunpengKind( yunpeng ) );
	// its light by night, a local light per clump (lighting/LocalLights.ts), moved as the island grows
	// (`onSwap`); `flags=lightTest:N`: N white test sources over the meadow, for the local lights' cost
	// tests, loaded once, with the light of stand-in clumps (the island may hold none)
	const testLights = typeof debugFlags.lightTest === 'number' ? testSources( debugFlags.lightTest, island.landBox, ( x, z ) => island.land.inside( x, z ), islandSurfaceHeight, yunpeng.sampleLights() ) : [];
	render.localLights.add( yunpengLights( yunpeng ) );
	// (the test sources are loaded once: a growth does not move them)
	render.localLights.add( { name: 'light test', cost: 'none', testMode: 'stateless', land: 'independent', sources: () => testLights } );
	island.setLocalSources = () => render.localLights.refresh();
	// the bamboo over the whole island, instances of a few prototypes at two levels (Bamboo.ts,
	// vegetation/PlantInstances.ts), its leaves drawn once here (BambooMaterials.ts)
	const bamboo = buildBamboo( data, { shared, atlas: bambooAtlas() } );
	island.bamboo = bamboo;
	for ( const kind of bambooKinds( bamboo ) ) vegetation.add( kind );
	scene.add( ...vegetation.roots() );
	installWindMotionFlag( scene );
	installVegetationPrepass( scene, vegetation.roots( ( kind ) => kind.prepass ) );
	// the opaque scene's depth for the ambient occlusion (post/GTAO.ts, high's `ao` knob) and the
	// screen-space shade over the whole scene (post/MeadowShade.ts `SS_SHADOW`): the island, its stones
	// and floor, and the plants without a prepass of their own
	if ( GTAO || SS_SHADOW ) installOpaquePrepass( [ world.group, ...vegetation.roots( ( kind ) => ! kind.prepass ) ] );
	// Everything that casts into the sun's map: the figures cast through their own map, and the sea
	// floor's stones only into the refracted one. The game's props grow it (holdOpaque below), and so
	// does the island (setSunCasters again at each growth step).
	const sunCasters = new THREE.Box3();
	island.sunCasters = sunCasters;
	// the boxes the game's props hold (holdOpaque), kept over the island's growth
	const heldOpaque: THREE.Box3[] = [];
	island.heldOpaque = heldOpaque;
	// the bamboo's crown and the yunpeng's stalks rise above the island too (their boxes follow the
	// growth: `onSwap`)
	const bambooBox = new THREE.Box3(), yunpengBox = new THREE.Box3();
	const holdPlants = () => {

		bambooBox.setFromObject( bamboo.culms ).union( new THREE.Box3().setFromObject( bamboo.leaves ) ).expandByScalar( 0.6 );
		yunpengBox.setFromObject( yunpeng.root );

	};
	island.holdPlants = holdPlants;
	holdPlants();
	heldOpaque.push( bambooBox, yunpengBox );
	function setSunCasters(): void {

		sunCasters.makeEmpty();
		for ( const root of [ world.group, ...vegetation.roots( ( kind ) => kind.sunCaster ) ] ) {

			root.updateWorldMatrix( true, true );
			root.traverse( ( object ) => { if ( ( object as THREE.Mesh ).isMesh && object.castShadow ) sunCasters.expandByObject( object ); } );

		}
		for ( const box of heldOpaque ) sunCasters.union( box );
		// (the island parts' caster columns come with the chunks, World.ts)
		sunShadow.setCasters( sunCasters, world.columns );

	}
	setSunCasters();
	// the island's terrain is a closed solid: it casts its front faces (SunShadow)
	sunShadow.castFrontFaces( world.group );
	// the camera grabs the island's ground (the chunks' grids, World.ts) and keeps its pivot over the land
	// and its ring of shallows (the land's hull)
	controls.setIsland( world.grounds, island.outline );
	island.islandMaxDistance = controls.maxDistance;
	frameLand();
	// Drops stop on the first surface they meet: rock, turf, leaves (the meadow's blades are generated
	// as they draw, Grass.ts, and stay out of the bake).
	render.rain.collision.setArea( island.landBox );
	render.rain.bakeCollision( renderer, [ world.group, ...vegetation.roots( ( kind ) => kind.rainBake ) ] );
	mark( 'meshes' );
	setStatus( 'Waking the villagers…' );
	// The islanders are the Hanming people (src/characters/looks.ts HANMING: a woven bamboo hat, a
	// short-sleeved feather top worn open and feather shorts, lit as the island is); `look=kit` brings
	// back the kit-dressed islander (bare head, so the pointed ears read, linen shirt, plain trousers,
	// leather shoes, in cel steps). The game dresses its islanders in the look's variants.
	// Their proportions (`islander` URL option, GUI Islander folder) are the look's build of
	// Proportions.ts by default (the Hanming's realistic `real`, the kit figure's chunkier `medium`);
	// the kit's own (`stock`) and the other builds stay selectable for comparison. A Hanming islander
	// has a sex and an age (characters/Ages.ts, FigureAge.ts), the build that of its adult man: the
	// scene's walker the `body` URL option's (`F6`: a girl of six; a man of 30 by default, GUI
	// Islander folder), the game's from the game (Game.ts).
	const KIT_LOOK = params.get( 'look' ) === 'kit';
	const SCENE_LOOK = KIT_LOOK ? ISLANDER : HANMING;
	island.SCENE_LOOK = SCENE_LOOK;
	island.GAME_LOOKS = KIT_LOOK ? ISLANDER_LOOKS : HANMING_LOOKS;
	island.islanderBuild = { proportions: ( PROPORTION_NAMES as string[] ).includes( params.get( 'islander' ) ?? '' ) ? params.get( 'islander' ) as ProportionName : SCENE_LOOK.build ?? 'medium' };
	const sceneBody: Body = { ...parseBodies( params.get( 'body' ) )[ 0 ] ?? { sex: 'male', age: 30 } };
	island.sceneBody = sceneBody;
	island.buildIslander = ( name: ProportionName ) => loadVillager( SCENE_LOOK.base, SCENE_LOOK.parts, shared, PROPORTIONS[ name ], SCENE_LOOK.lit, SCENE_LOOK.ages ? sceneBody : undefined );
	// Compiles what `objects` draw in the frame's passes ahead, off the frame: the scene's pass (a latent
	// of the frame graph's opaque pass, under its target and MRT: the temporal modes' velocity output is
	// part of its pipelines' keys) and then the sun's map, one draw at a time and in the order a frame
	// first draws them (the scene's pass, then the map's redraw): a pass into the map shares its
	// material's nodes, and compiled the other way round or side by side, the game's chest came out
	// shaded differently from the chest drawn without them. The game's props come this way; this also
	// uploads their buffers. (A grown island's chunks need none: they draw with the loaded chunks' pipelines.)
	async function compileDraws( objects: THREE.Object3D[] ): Promise<void> {

		for ( const object of objects ) await render.latents.latent( 'opaque', [ object ] );
		const compiled = sunShadow.compileCasters( renderer, objects );
		if ( compiled ) await compiled;
		else console.warn( 'The sun\'s shadow map is not built yet: these draws compile their shadow pass when first drawn' );

	}

}

/** The island's growth in place and everything that follows a land's swap. */
export function createGrowth( render: RenderParts, island: IslandParts, { landOptions, game }: { landOptions: { worldSeed: number; step: number }; game: ConstructorParameters<typeof Growth>[ 0 ][ 'game' ] } ) {

	const { renderer, scene, groundBounce, shoreWaves, ambient, refractedSun } = render;
	const { controls, t0, worldCache, data, measureLand, setLand, fields, world, wenyao, chunkView, showChunkBorders, showWindArrows, vegetation, setLocalSources, heldOpaque, holdPlants, setSunCasters, poseIslandView, holdsFraming, followFraming } = island;

	console.info( `world: ${ worldCache.hits } of ${ worldCache.chunks + 1 } records from the cache (${ worldCache.cache })`, data.timings, 'triangles', world.triangles, 'in', Math.round( performance.now() - t0 ), 'ms' );

	// The island grows in place (Growth.ts): the next piece is generated ahead, and a Grow (the GUI's
	// Island folder, `__PONLAI__.growth.grow()`) swaps it in, every dependent following. The page's own
	// part of a swap: the land's framing and the fog's clearing (setLand), the sea's reflection box (and
	// the box its gusts take the meadow's within, Water.setLand) and
	// the sun's casters (the game's held props kept), the camera's ground; the scene event keeps the
	// temporal modes' history (the new land is a change of the scene, which the resolve's clip handles,
	// as a placed prop's) and restarts a paused frame's rest.
	// (for the diagnostics, which follow a grown island)
	const worldInfo = { worldTriangles: world.triangles };
	island.worldInfo = worldInfo;
	const growth = new Growth( {
		renderer, world, fields, vegetation, shoreWaves, refractedSun, ambient, rain: render.rain, characters: island.characters, game,
		measure: measureLand,
		onSwap: ( next, version, measured ) => {

			setLand( next, growth.state.step, measured );
			render.water!.setLand( island.landBox );
			holdPlants();
			setLocalSources();
			for ( const box of heldOpaque ) render.water!.hold( box );
			setSunCasters();
			groundBounce.invalidate();
			// (asked before the pose changes: whether the camera holds the island view)
			const follow = holdsFraming();
			controls.setIsland( world.grounds, island.outline );
			island.islandMaxDistance = controls.maxDistance;
			poseIslandView( island.islandViewOptions, island.islandTurned, island.islandZoom );
			if ( follow ) followFraming();
			island.shownData = version;
			wenyao.setWorld( version );
			islandEvent( 'world swap' );

		},
		onSwapped: () => {

			// the chunks' borders follow, if built (made again on their next show otherwise)
			if ( chunkView.lines ) {

				scene.remove( chunkView.lines );
				chunkView.lines.geometry.dispose();
				chunkView.lines = null;
				showChunkBorders( chunkView.borders );

			}
			showWindArrows();
			worldInfo.worldTriangles = world.triangles;

		},
		onRise: () => islandEvent( 'approach' ),
	}, worldCache, { seed: landOptions.worldSeed, cache: worldCacheOn } );
	island.growth = growth;
	// `approach=<0..1>`: the shoal under the next piece put on that progress at once (Growth.ts
	// `approachNow`); the loading screen stays up until it is written, so a paused load repeats.
	island.approachWritten = true;
	if ( params.has( 'approach' ) ) {

		island.approachWritten = false;
		void growth.approachNow( Number( params.get( 'approach' ) ) ).then( () => { island.approachWritten = true; } );

	}

}

/** Registers what a scene jump clears of the island's (post/SceneHistory.ts): the islander's
 * clips, the wenyao's schools and the falling leaves, each read when the jump comes (the islander
 * and the leaves are made late, or not at all). */
export function registerIslandHistories( render: RenderParts, island: IslandParts ) {

	const { wenyao } = island;
	render.history.onJump( 'islanders', () => island.characters?.reset() );
	render.history.onJump( 'wenyao', () => wenyao.reset() );
	render.history.onJump( 'falling leaves', () => island.fallingLeaves?.reset() );

}
