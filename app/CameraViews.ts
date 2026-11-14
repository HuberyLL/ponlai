// The page's camera views: the island view, the review views, the free flight and the orbit.
//
// The page's camera views: the island view the land is framed in (placed from the query's dist /
// polar / az, or the land's own framing), the review views (horizon, sky), the free flight, the
// widening of the field of view near the ground and the orbit's limits. The island's stages call
// the island view's framing (`IslandFraming`, on the page's parts as `framing`), which the entry
// hands them, since a land that grows reframes its view.
import { renderEvent, type RenderParts } from '../packages/render/index.ts';
import { settings as params, type SettingsQuery } from '../packages/render/setup.ts';
import * as THREE from 'three/webgpu';
import { IslandCameraControls, frameIsland, landFitDistance, type IslandFraming, type IslandParts } from '../packages/island/index.ts';
import type { PageParts } from './Page.ts';

export type CameraView = 'island' | 'horizon' | 'sky';

/** The camera mode a query names: `camera=free` flies free, anything else orbits the island. */
export function cameraMode( options: SettingsQuery ): 'free' | 'orbit' {

	return options.get( 'camera' ) === 'free' ? 'free' : 'orbit';

}

/** The camera's views and modes, and the framing the island's stages frame the land by. */
export function createCameraViews( render: RenderParts, island: IslandParts, page: PageParts ) {

	const { renderer, camera, sky } = render;
	const { target, controls, initialCameraPosition, initialCameraQuaternion, initialCameraTarget, framingGlide, initialCameraFov, orbitMaxPolar, orbitMinDistance, freeControls } = island;
	// (the options the island view was last posed at: the page's own query at first)
	let viewOptions: SettingsQuery = params;
	const framing: IslandFraming = { frameLand, poseIslandView, holdsFraming, followFraming, get viewOptions() { return viewOptions; } };
	page.framing = framing;
	page.applyOrbitLimit = applyOrbitLimit;
	page.unwidenFov = unwidenFov;
	page.setCameraMode = setCameraMode;
	page.setCameraView = setCameraView;
	const cameraSettings = { mode: cameraMode( params ) as string };
	page.cameraSettings = cameraSettings;
	const reviewView = { camera: 'island' as CameraView };
	page.reviewView = reviewView;
	// The island view's fov widens as it closes in (IslandCameraControls `widenFov`): `nearFov`
	// (degrees) at the closest zoom, from `nearFovFrom` (m) inward; `nearFov=off` keeps the far fov.
	const fovWidening = { on: params.get( 'nearFov' ) !== 'off' };
	page.fovWidening = fovWidening;
	const viewDirection = new THREE.Vector3();

	// The island view on this land at the `polar` and `az` options (degrees): the camera that just
	// frames the land and its ring of shallows from there (IslandFraming.ts), at the camera's aspect,
	// brought in to where it frames the land alone from its heading (`landFitDistance`; the zoom then runs from there to the
	// least distance); with a `dist` option (m),
	// the camera on its sphere about the default pivot at that distance instead. Then a settle within
	// the orbit's limits, the farthest zoom raised to the framing's distance (from the land's own each
	// time, so it never only grows). At rest the pose depends only on the pivot, the position and the
	// limits, so a scene jump (`establishScene`) repeats it on a camera and controls of its own with the
	// page's limits, and its pose is the load's to the bit.
	// The default azimuth (180: the view looks along +z, about 23 degrees east of the meridian the sun
	// culminates on and the moon stands on) is fixed, never following the clock, so the R key always
	// returns to the same view. It was 318, looking away from the meridian: the morning sun lit the
	// island flat from behind the camera and the moon path never entered the frame. From 180 the moon's
	// path is in view all night (the moon is fixed on the meridian: sky/DayCycle.ts MOON), while the sun lights the cliffs from the side in the
	// morning and the afternoon (a lit and a shaded side) and its glints at noon keep to a corner of the frame.
	function placeOrbit( on: THREE.PerspectiveCamera, orbit: IslandCameraControls, options: SettingsQuery, turn = 0, zoom = 0 ): void {

		const polar = THREE.MathUtils.degToRad( Number( options.get( 'polar' ) ?? 40 ) ), azimuth = THREE.MathUtils.degToRad( Number( options.get( 'az' ) ?? 180 ) ) + turn;
		if ( options.has( 'dist' ) ) {

			orbit.target.copy( target );
			on.position.setFromSphericalCoords( Number( options.get( 'dist' ) ), polar, azimuth ).add( target );
			orbit.maxDistance = Math.max( island.islandMaxDistance, Number( options.get( 'dist' ) ) );

		} else {

			// (a window of no size, such as a hidden pane's, has no aspect: square until it has one)
			const aspect = on.aspect > 0 && Number.isFinite( on.aspect ) ? on.aspect : 1;
			const view = { polar, azimuth, fov: initialCameraFov, aspect };
			frameIsland( island.outline, view, on.position, orbit.target );
			const framed = on.position.distanceTo( orbit.target );
			const start = Math.min( framed, landFitDistance( island.outline, view ) );
			orbit.maxDistance = Math.max( island.islandMaxDistance, start );
			// (from the start distance at zoom 0 to the least at 1, eased on the log as the framing's zoom)
			on.position.sub( orbit.target ).setLength( start * Math.pow( Math.min( orbit.minDistance / start, 1 ), zoom ) ).add( orbit.target );

		}
		orbit.settle();

	}

	function frameLand(): void {

		placeOrbit( camera, controls, params );
		initialCameraPosition.copy( camera.position );
		initialCameraQuaternion.copy( camera.quaternion );
		initialCameraTarget.copy( controls.target );
		controls.minDistance = island.islandNearest = camera.position.distanceTo( controls.target );

	}

	// The island view's pose (the R key, `setCameraView( 'island' )`) at the dist / polar / az of
	// `options`, the heading turned by `turn` (rad) at `zoom`, placed as the load places it on a camera and
	// controls of its own with the page's limits, the camera left where it is: a scene jump's
	// (`establishScene`), and again for the same options and turn when the island grows (Growth.ts) or
	// the window's shape changes, so the view frames the land shown, and at every step of a turn.
	function poseIslandView( options: SettingsQuery, turn = 0, zoom = 0 ): void {

		viewOptions = options;
		island.islandTurned = turn;
		island.islandZoom = zoom;
		const probe = camera.clone();
		const orbit = new IslandCameraControls( probe, document.createElement( 'div' ) );
		orbit.minDistance = orbitMinDistance;
		orbit.maxPolarAngle = orbitMaxPolar;
		placeOrbit( probe, orbit, options, turn, zoom );
		orbit.dispose();
		initialCameraPosition.copy( probe.position );
		initialCameraQuaternion.copy( probe.quaternion );
		initialCameraTarget.copy( orbit.target );
		controls.maxDistance = orbit.maxDistance;
		island.islandNearest = probe.position.distanceTo( orbit.target );
		applyOrbitLimit();

	}

	// Whether the camera holds the island view's pose, or glides toward it: only then does it follow
	// the pose when the land grows or the window's shape changes (a pose the hand or the tools moved
	// it from stays).
	function holdsFraming(): boolean {

		if ( ! controls.enabled || reviewView.camera !== 'island' ) return false;
		return framingGlide.running || ( camera.position.distanceTo( initialCameraPosition ) < 1e-3 && controls.target.distanceTo( initialCameraTarget ) < 1e-3 );

	}

	// Takes the camera to the island view's pose: a glide on the scene clock (the tick's
	// `framingGlide.advance`), at once on a paused page, so a paused frame is the fresh load's.
	function followFraming( glide = ! render.paused ): void {

		if ( glide ) {

			framingGlide.start( camera.position, controls.target, initialCameraPosition, initialCameraTarget );
			controls.maxDistance = Math.max( controls.maxDistance, camera.position.distanceTo( controls.target ) );
			return;

		}
		framingGlide.stop();
		camera.position.copy( initialCameraPosition );
		camera.quaternion.copy( initialCameraQuaternion );
		controls.target.copy( initialCameraTarget );
		controls.settle();

	}

	function settleOrbit(): void {

		// Drain residual orbit damping before changing ownership or jumping to a preset.
		controls.settle();

	}

	function applyOrbitLimit(): void {

		// Orbiting keeps the camera above the sea. The sky view instead turns the camera where it
		// stands: its target sits a few centimetres ahead, so even dragging the view straight up
		// cannot swing the camera round below its target and under the sea.
		const sky = reviewView.camera === 'sky';
		controls.maxPolarAngle = sky ? Math.PI : orbitMaxPolar;
		controls.minDistance = sky ? 0.01 : reviewView.camera === 'island' ? island.islandNearest : orbitMinDistance;
		controls.enableZoom = controls.enablePan = ! sky;
		// only the island view widens: the review views and the free flight keep their own fov
		controls.widenFov = fovWidening.on && controls.enabled && reviewView.camera === 'island';

	}

	// Leaving the widened island view (for the free flight, or with the widening switched off) takes
	// back its far fov.
	function unwidenFov(): void {

		if ( ! controls.widenFov ) return;
		camera.fov = controls.farFov;
		camera.updateProjectionMatrix();

	}

	function setCameraMode( mode: string ): void {

		framingGlide.stop();
		if ( controls.enabled ) settleOrbit();
		if ( mode === 'free' ) unwidenFov();
		if ( mode === 'orbit' && freeControls.enabled ) {

			camera.getWorldDirection( viewDirection );
			controls.target.copy( camera.position ).addScaledVector( viewDirection, 58 * island.landScale );

		}
		cameraSettings.mode = mode;
		renderEvent( 'camera mode' );
		controls.enabled = mode === 'orbit';
		freeControls.enabled = mode === 'free';
		applyOrbitLimit();
		if ( controls.enabled ) controls.settle();
		renderer.domElement.style.cursor = freeControls.enabled ? 'grab' : '';

	}

	function setCameraView( view: CameraView ): void {

		framingGlide.stop();
		freeControls.clearInput();
		settleOrbit();
		reviewView.camera = view;
		renderEvent( 'view jump' );
		if ( view === 'sky' ) {

			camera.position.copy( island.onLand( 0, 15, 0 ) );
			viewDirection.copy( sky.sunDir.y > 0 ? sky.sunDir : sky.moonDir );
			// At new moon both bodies can be below the horizon; keep the review aimed at the sky.
			if ( viewDirection.y <= 0 ) viewDirection.set( 0.6, 0.72, 0.35 ).normalize();
			controls.target.copy( camera.position ).addScaledVector( viewDirection, 0.05 );
			camera.fov = 65;
			camera.lookAt( controls.target );

		} else if ( view === 'horizon' ) {

			controls.target.copy( target );
			camera.position.setFromSphericalCoords( 110 * island.landScale, THREE.MathUtils.degToRad( 82 ), THREE.MathUtils.degToRad( 125 ) ).add( target );
			camera.fov = 55;
			camera.lookAt( controls.target );

		} else {

			// (back to the query's heading, at the farthest zoom)
			if ( island.islandTurned !== 0 || island.islandZoom !== 0 ) poseIslandView( viewOptions );
			controls.target.copy( initialCameraTarget );
			camera.position.copy( initialCameraPosition );
			camera.quaternion.copy( initialCameraQuaternion );
			camera.fov = controls.farFov = initialCameraFov;

		}
		camera.updateProjectionMatrix();
		applyOrbitLimit();
		if ( controls.enabled ) controls.settle();

	}

}
