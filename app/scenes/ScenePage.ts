// The scene page: one test scene on the renderer alone, assembled as main.ts does the island.
//
// The scene page: one test scene (TestScene.ts) on the renderer alone, which scenes.html loads
// behind its entry (ScenesBoot.ts). It is to a test scene what main.ts is to the island: the one
// place that assembles it, through the renderer's assembly (render/index.ts `startScene`), on the
// renderer's neutral inputs (NeutralInputs.ts) where the island hands its world's, with the look its
// entry picked (`startScenePage`). It draws no island, no game and no GUI.
// - The scene is `scene=<name>`, which the entry reads and hands over (index.ts). The scene's
//   options (`weather`, `hour`, `preset`, `paused`, ...) are the island page's and read the same
//   way (render/index.ts `sceneOptions`), with a load at noon where the query names no hour.
// - The frame is the renderer's frame stages with nothing of a world's between them, at the tier's
//   nominal render scale (no dynamic scale: the scenes are shot paused). The canvas is sized before
//   the haze's bake, as it was before the assembly existed.
// - It keeps the island page's contract with the tools: the URL options, `window.__PONLAI__` and
//   `window.__THREE_GAME_DIAGNOSTICS__` with its `settled` signal, on the dev server or with
//   `?debug` / `?profile`. `__PONLAI__.establishScene( query )` jumps to a scene's hour and weather
//   as a fresh load of that query draws it, the camera back at the scene's first view;
//   `__PONLAI__.scenePage` holds the scene's own handles: its `views`, `times` and `readings`,
//   `setView( name )` and `read()`, which measures the readings the view's frame holds;
//   `__PONLAI__.rebuild()` disposes the scene and starts it again on the same page.
// - A scene stands on level ground or in the open sea (TestScene.ts `SceneGround`). Ground has no
//   end, so its sea is never seen: the water's surface is built, as the frame's passes need it,
//   and hidden. The open sea is far from any shore and equally deep everywhere (the fields, the
//   probes and the bounce's ground of NeutralInputs.ts); the water is drawn, its floor and what
//   reaches under its surface are the scene's own.
// - The scene's plant kinds join the registry before `placeVegetation` closes it, drawn with the
//   default plant (vegetation/DefaultPlant.ts), and cast into the sun's map with the scene's
//   casters.
import * as THREE from 'three/webgpu';
import { startScene, bakeRainCollision, defaultPlant, placeVegetation, vegetationCasters, neutralBounceGround, neutralFields, neutralLattice, neutralSeaLattice, OPEN_SEA_SHORE, Vegetation, renderEvent, type SceneContext } from '../../packages/render/index.ts';
import { browserHost } from '../../packages/render/browser.ts';
import type { Look } from '../../packages/render/setup.ts';
import { SCENES } from './index.ts';
import type { ReadingContext, SceneReading, Triple } from './TestScene.ts';

/** Builds the scene the address names and starts its frame loop, drawn with `look` (the entry's
 * pick: ScenesBoot.ts). */
export async function startScenePage( name: string, look: Look ): Promise<void> {

	const host = browserHost( { canvasHost: document.getElementById( 'app' )!, loading: document.getElementById( 'loading' ) } );
	const testScene = Object.hasOwn( SCENES, name ) ? SCENES[ name ] : null;
	if ( ! testScene ) {

		host.status( `scene=${ Object.keys( SCENES ).join( ' | ' ) }` );
		throw new Error( `scenes: no scene '${ name }' (scene=${ Object.keys( SCENES ).join( ' | ' ) })` );

	}

	// ------------------------------------------------------------------ the views

	const views = testScene.views;
	// (a jump poses the first view before the key is the new hour's: TestScene.ts `SceneView`)
	if ( typeof views[ 0 ].eye === 'function' || typeof views[ 0 ].target === 'function' ) throw new Error( `scenes: '${ testScene.name }''s first view follows the key; the first view is fixed` );
	let shownView = views[ 0 ].name;
	let poseView: ( viewName: string ) => void = () => {};

	const { ground } = testScene;
	// On land, far inland everywhere: the shore is nowhere near and the floor is the ground. At sea,
	// far from any shore everywhere, over the floor at the scene's depth.
	const FIELD_HALF = 64;
	// where the water would take the open sea to deepen (m): past the sea's farthest edge, so that the
	// floor's depth holds everywhere
	const OPEN_SEA_DEEPENING = { from: 1e5, to: 2e5 };
	let neutral!: ReturnType<typeof neutralFields>;
	let content!: ReturnType<typeof testScene.build>;
	let world!: THREE.Group;
	let casting = false;
	let reach!: THREE.Box3;
	const seaLevelOf = ( scene: SceneContext ) => scene.shared.waterLevel.value;

	// The scene a query names, the load's and a jump's alike: noon where it names no hour, the island
	// page's length of day.
	const running = await startScene( host, { look, defaults: { hour: 12, dayLength: 2880 }, dynamicScale: false }, {
		afterSky( { render } ) {

			const { camera } = render;
			poseView = ( viewName: string ) => {

				const view = views.find( ( v ) => v.name === viewName );
				if ( ! view ) throw new RangeError( `scenes: '${ testScene.name }' has no view '${ viewName }' (${ views.map( ( v ) => v.name ).join( ', ' ) })` );
				const place = ( p: Triple | ( ( key: THREE.Vector3 ) => Triple ) ) => typeof p === 'function' ? p( render.sky.keyDir ) : p;
				shownView = view.name;
				camera.fov = view.fov ?? 27;
				camera.position.set( ...place( view.eye ) );
				camera.up.set( 0, 1, 0 );
				camera.lookAt( ...place( view.target ) );
				camera.updateProjectionMatrix();
				camera.updateMatrixWorld();

			};
			poseView( shownView );

		},
		// the rain's ceiling: over the tallest thing a scene stands on its ground, or on the sea
		passes: ( scene ) => ( { rainCeiling: ( ground.kind === 'land' ? ground.height : seaLevelOf( scene ) ) + 8, extraPasses: [] } ),

		// -------------------------------------------------------------- the neutral world

		ground( scene ) {

			const { shared } = scene;
			const seaLevel = seaLevelOf( scene );
			neutral = ground.kind === 'land'
				? neutralFields( { half: FIELD_HALF, shore: - 1000, floor: ground.height, xform: shared.shoreXform.value } )
				: neutralFields( { half: FIELD_HALF, shore: OPEN_SEA_SHORE, floor: seaLevel - ground.depth, xform: shared.shoreXform.value } );
			const bounceGround = ground.kind === 'land'
				? neutralBounceGround( { ground: ground.height, albedo: ground.albedo } )
				: neutralBounceGround( { ground: seaLevel - ground.depth, albedo: ground.floor } );
			return { fields: neutral.fields, bounceGround, shoreData: neutral.shoreData };

		},
		afterBounce( { render } ) {

			content = testScene.build( render );
			world = new THREE.Group();
			world.name = 'scene';
			world.add( ...content.objects );
			render.scene.add( world );
			world.updateMatrixWorld( true );

		},
		ambient: ( scene ) => ( { ambientData: ground.kind === 'land' ? neutralLattice( { ground: ground.height, albedo: ground.albedo } ) : neutralSeaLattice( { sea: seaLevelOf( scene ) } ), world: { group: world } } ),
		afterAmbient( scene ) {

			const { render, shared } = scene;
			// the scene's plant kinds, drawn with the default plant; the registry places them and closes
			const vegetation = new Vegetation( ( sites, kindName ) => defaultPlant( shared, sites, kindName ) );
			for ( const kind of content.plants ?? [] ) vegetation.add( kind );
			placeVegetation( render, vegetation, { ground: content.objects } );
			// What casts into the sun's map: the scene's casters and its plants; a scene with nothing on its
			// ground gives the map a box to fit.
			const surfaceHeight = ground.kind === 'land' ? ground.height : seaLevelOf( scene );
			casting = content.casters !== null || vegetation.kinds.length > 0;
			const casters = vegetation.kinds.length
				? vegetationCasters( vegetation, { ground: content.objects, box: new THREE.Box3() } ).union( content.casters ?? new THREE.Box3() )
				: content.casters ?? new THREE.Box3( new THREE.Vector3( - 1, surfaceHeight, - 1 ), new THREE.Vector3( 1, surfaceHeight + 1, 1 ) );
			render.sunShadow.setCasters( casters );
			bakeRainCollision( render, vegetation, { ground: content.objects, area: neutral.bounds } );
			// the sea reflects what stands inside the box of everything on the ground or on the sea
			reach = casters;

		},
		water: () => ( {
			fields: neutral.fields,
			landBox: { x0: Math.min( reach.min.x, - 1 ), z0: Math.min( reach.min.z, - 1 ), x1: Math.max( reach.max.x, 1 ), z1: Math.max( reach.max.z, 1 ) },
			// at sea no shelf: the floor's depth everywhere, the open sea's deepening past the farthest view
			seaShape: { openSea: ground.kind === 'land' ? { from: 400, to: 800 } : OPEN_SEA_DEEPENING, reflectorTop: reach.max.y + 1 },
			heldOpaque: [],
		} ),
		afterWater( { render, sizing } ) {

			render.water!.mesh.visible = ground.kind === 'sea';
			// the canvas at the window's size and the render at the tier's nominal scale (`dpr` pins it)
			sizing.resize();

		},
		// The loading screen lifts once the sun's map has drawn (where anything casts into it) and the
		// ambient light's first relight is in, at most until `until`.
		revealWait: ( { render }, until ) => ( ( casting && render.sunShadow.draws === 0 ) || ! render.ambientRelight.ready ) &&
			// eslint-disable-next-line ponlai/scene-clock -- the loading screen's longest wait: when it lifts, not what is drawn
			performance.now() < until,
		// a jump leaves the camera at the scene's first view
		jump: () => ( { jump: () => poseView( views[ 0 ].name ) } ),
		handles: () => ( {
			everyFrame: () => ( { scene: testScene.name, view: shownView } ),
			handles: () => ( {
				// disposes the running scene and builds it again in the same page, as a fresh load of its
				// address builds it (tools/render/scenes.mjs `--rebuild` checks the frames it draws)
				rebuild: async () => {

					await running.dispose();
					await startScenePage( name, look );

				},
				// the test scene's own handles
				scenePage: {
					name: testScene.name, about: testScene.about,
					views: views.map( ( v ) => v.name ), times: testScene.times, readings: testScene.readings.map( ( r ) => r.name ),
					get view() { return shownView; },
					setView, read,
				},
			} ),
		} ),
	} );
	const { render } = running;
	const { renderer, camera } = render;

	// ------------------------------------------------------------------ the scene's handles

	/** Moves the camera to one of the scene's views. */
	function setView( viewName: string ): void {

		poseView( viewName );
		renderEvent( 'view jump' );

	}

	// A reading's box on the frame, in fractions from its top-left corner: `size` of the frame's height
	// a side, round the reading's point or direction; null where the frame does not hold all of it.
	const projected = new THREE.Vector3();
	function readingBox( reading: SceneReading, context: ReadingContext ): [ number, number, number, number ] | null {

		const resolve = ( place: Triple | ( ( context: ReadingContext ) => Triple ) ) => typeof place === 'function' ? place( context ) : place;
		if ( reading.at ) projected.set( ...resolve( reading.at ) );
		else if ( reading.toward ) projected.set( ...resolve( reading.toward ) ).normalize().multiplyScalar( 1000 ).add( camera.position );
		else return null;
		// (behind the camera)
		if ( projected.clone().applyMatrix4( camera.matrixWorldInverse ).z >= - camera.near ) return null;
		projected.project( camera );
		const h = reading.size ?? 0.02, w = h / camera.aspect;
		const x = ( projected.x + 1 ) / 2 - w / 2, y = ( 1 - projected.y ) / 2 - h / 2;
		if ( x < 0 || y < 0 || x + w > 1 || y + h > 1 ) return null;
		return [ x, y, w, h ];

	}

	/** The readings the shown view's frame holds: each one's box (fractions of the frame from its
	 * top-left corner), its linear radiance before the sea, the air and the display chain (`opaque`)
	 * and after the composite (`hdr`), with the light they were taken under. For the frame drawn last:
	 * on a paused page, wait for `settled` first. */
	async function read(): Promise<unknown> {

		const { sky, pipeline } = render;
		camera.updateMatrixWorld();
		const context: ReadingContext = { key: sky.keyDir.clone(), camera };
		const boxes: Record<string, [ number, number, number, number ]> = {};
		for ( const reading of testScene!.readings ) {

			const box = readingBox( reading, context );
			if ( box ) boxes[ reading.name ] = box;

		}
		const { readRadiance } = await import( '../../packages/render/debug/Radiance.ts' );
		const opaque = await readRadiance( renderer, pipeline, { boxes, source: 'opaque' }, camera ) as { boxes: Record<string, unknown>; exposure: unknown; preExposure: number };
		const hdr = await readRadiance( renderer, pipeline, { boxes, source: 'hdr' }, camera ) as { boxes: Record<string, unknown> };
		return {
			scene: testScene!.name, view: shownView, boxes,
			opaque: opaque.boxes, hdr: hdr.boxes, exposure: opaque.exposure, preExposure: opaque.preExposure,
			light: {
				hour: render.dayCycle.hour,
				weather: render.weather.target,
				keyIsMoon: sky.keyIsMoon,
				keyDirection: sky.keyDir.toArray(),
				keyElevation: THREE.MathUtils.radToDeg( Math.asin( THREE.MathUtils.clamp( sky.keyDir.y, - 1, 1 ) ) ),
				keyColour: sky.keyColor.toArray(),
				sunElevation: sky.elevation,
				skyIrradiance: sky.skyIrradiance.toArray(),
			},
		};

	}

}
