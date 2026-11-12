// The page's control panel (lil-gui): the scene's folders (time, weather, wind, camera, ground,
// islander, quality) and, once the frame's passes and the haze exist, the look's and the haze's.
// Its handlers call the renderer's and the island's operations; the game adds its own folder
// between them (main.ts).
import { reloadWith } from '../PageSettings.ts';
import { DAY_PRESETS, type DayPreset, WEATHER_PRESETS, isParkedWeather, type WeatherName, WIND_LEVELS, type WindLevel, WHITE_BALANCE, LOCAL_TONE, FrameStats, shared, AMBIENT_KNOBS, ambientGrade, type AmbientView, markSkyRetune, type AAMode, AA_MODE, sceneEvent, debugViewChoices, type RenderParts } from '../render.ts';
import { settings as params, numberSetting, type QualityTier, ACTIVE_QUALITY } from '../renderSetup.ts';
import GUI from 'lil-gui';
import { qualityLines } from '../QualityDetect.ts';
import { soilUniforms, setSoilStrength, groundGains, PROPORTION_NAMES, type ProportionName, characterLook, type IslandParts } from '../island.ts';
import type { Sex } from '../islandLand.ts';
import type { PageParts } from './Page.ts';

/** The panel and its scene folders. */
export function createGui( render: RenderParts, island: IslandParts, page: PageParts ) {

	const { DEBUG, qualityTier, resolution, scene, camera, sky, dayCycle, weather, seaFogView, dayFogView, skyQuality, lighting, invalidateSunShadow, refreshEnvironment, applySun, setPreset, setWeather, setWind, applySkyFill, fft, pipeline, groundBounce, ambient, ambientView } = render;
	const { controls, freeControls, chunkView, showChunkBorders, SCENE_LOOK, islanderBuild, sceneBody, buildIslander, growth } = island;
	const { ground, qualityChoice, cameraSettings, reviewView, fovWidening, applyOrbitLimit, unwidenFov, setCameraMode, setCameraView, resize } = page;
	page.reloadWithQuality = reloadWithQuality;
	// A tier change rebuilds materials and the frame graph: reload with the tier and the page's options.
	function reloadWithQuality( tier: QualityTier | null ): void {

		reloadWith( { quality: tier, ...( params.get( 'autoQuality' ) === 'detect' ? { autoQuality: null } : {} ), gui: gui._hidden ? null : '' } );

	}

	// ------------------------------------------------------------------ GUI

	const gui = new GUI( { title: 'Ponlai · lighting & water' } );
	page.gui = gui;
	// every control, in any folder, bubbles here
	gui.onChange( () => sceneEvent( 'gui' ) );
	if ( ! params.has( 'gui' ) ) gui.hide();
	page.S = pipeline.settings;
	controls.nearFov = numberSetting( 'nearFov', controls.nearFov );
	controls.widenFrom = numberSetting( 'nearFovFrom', controls.widenFrom );

	setCameraMode( cameraSettings.mode );
	const cameraF = gui.addFolder( 'Camera' );
	cameraF.add( cameraSettings, 'mode', [ 'free', 'orbit' ] ).name( 'camera mode' ).listen().onChange( setCameraMode );
	cameraF.add( reviewView, 'camera', [ 'island', 'horizon', 'sky' ] ).name( 'view' ).listen().onChange( setCameraView );
	// (off again, the view returns to its framing)
	cameraF.add( controls, 'handInput' ).name( 'move by hand' ).onChange( () => {

		if ( ! controls.handInput ) setCameraView( 'island' );

	} );
	cameraF.add( controls, 'scrollMode', [ 'auto', 'zoom', 'pan' ] ).name( 'scroll / swipe' );
	cameraF.add( controls, 'enableDamping' ).name( 'glide and ease' );
	cameraF.add( controls, 'edgePan' ).name( 'pan at the edge' );
	cameraF.add( freeControls, 'speed', 1, 160, 1 ).name( 'flight speed' ).listen();
	// (in the widened island view the slider sets the far fov, which the view takes from `nearFovFrom` out)
	cameraF.add( camera, 'fov', 15, 100, 1 ).name( 'field of view' ).listen().onChange( () => {

		if ( controls.widenFov ) controls.farFov = camera.fov;
		camera.updateProjectionMatrix();

	} );
	cameraF.add( fovWidening, 'on' ).name( 'widen fov up close' ).onChange( () => {

		if ( ! fovWidening.on ) unwidenFov();
		applyOrbitLimit();

	} );
	cameraF.add( controls, 'nearFov', 27, 60, 1 ).name( 'near fov' );
	cameraF.add( controls, 'widenFrom', 22, 150, 1 ).name( 'widen from (m)' );
	cameraF.add( { reset: () => setCameraView( 'island' ) }, 'reset' ).name( 'return to island (R)' );
	const environmentLook = { exposure: true };
	page.environmentLook = environmentLook;
	const W = render.water!.uniforms;
	// The quality tier sets every knob of the frame's cost (Quality.ts); a change reloads the page. It
	// lists the active tiers (high alone while medium and low are parked), and the page's own tier when
	// `?quality` loaded a parked one.
	const performanceF = gui.addFolder( 'Performance' );
	const qualityChoices = ACTIVE_QUALITY.includes( qualityTier ) ? [ ...ACTIVE_QUALITY ] : [ ...ACTIVE_QUALITY, qualityTier ];
	performanceF.add( skyQuality, 'value', qualityChoices ).name( 'quality (reloads)' ).onFinishChange( ( tier: QualityTier ) => { if ( tier !== qualityTier ) reloadWithQuality( tier ); } );
	// How the tier was chosen (QualityDetect.ts: `?quality` or high; the GPU is not measured while the
	// lower tiers are parked).
	const autoQuality = qualityLines( qualityTier, qualityChoice.why, qualityChoice.record );
	page.autoQuality = autoQuality;
	performanceF.add( autoQuality, 'chosen' ).name( 'quality chosen' ).listen().disable();
	performanceF.add( resolution, 'full' ).name( 'full resolution' ).onChange( resize );
	performanceF.add( pipeline.sharpness, 'value', 0, 2, 0.05 ).name( 'upscale softness' );
	// The live readout (FrameStats.ts): the rendered frames' cadence by their rAF timestamps, the render
	// scale and the GPU's frame time, refreshed a few times a second while the folder shows (F toggles a
	// corner overlay with the same numbers).
	const frameStats = new FrameStats( document.body );
	page.frameStats = frameStats;
	const statsF = [
		performanceF.add( frameStats.readout, 'fps' ).name( 'fps (1 s)' ),
		performanceF.add( frameStats.readout, 'p95' ).name( 'interval p95' ),
		performanceF.add( frameStats.readout, 'max' ).name( 'interval max' ),
		performanceF.add( frameStats.readout, 'late' ).name( 'late frames' ),
		performanceF.add( frameStats.readout, 'hitches' ).name( 'over 25 ms' ),
		performanceF.add( resolution, 'scale' ).name( 'render scale' ),
		performanceF.add( resolution, 'gpu' ).name( 'GPU (median)' ),
		performanceF.add( resolution, 'render' ).name( 'render → canvas' ),
	];
	for ( const c of statsF ) c.disable();
	performanceF.add( { reset: () => frameStats.reset() }, 'reset' ).name( 'reset counts' );
	frameStats.visible = () => ! gui._hidden && ! gui._closed && ! performanceF._closed;
	frameStats.onReadout = () => { for ( const c of statsF ) c.updateDisplay(); };
	frameStats.extra = () => `scale ${ resolution.scale }   GPU ${ resolution.gpu }`;
	// The anti-aliasing mode (post/Antialiasing.ts) is built into materials and the frame graph, so a
	// change reloads the page with `aa=` (the older `msaa` alias dropped). It shows the running mode,
	// the tier's default or the URL's (`msaa`, high's, first), and the ground truth (URL only) is listed
	// while it runs.
	const antialiasingF = gui.addFolder( 'Antialiasing' );
	const aaChoices: Record<string, AAMode> = { 'MSAA 4x': 'msaa', 'TAAU': 'taau', 'FSR 3.1': 'fsr3', 'TAA': 'taa', 'Off': 'off' };
	if ( AA_MODE === 'gt' ) aaChoices[ 'Ground truth' ] = 'gt';
	antialiasingF.add( { mode: AA_MODE }, 'mode', aaChoices ).name( 'mode (reloads)' ).onFinishChange( ( mode: AAMode ) => {

		if ( mode === AA_MODE ) return;
		reloadWith( { aa: mode, msaa: null, gui: gui._hidden ? null : '' } );

	} );
	// The temporal resolve's knobs (TemporalAA.ts), live: the tier's `taa` table is where they start. A
	// change restarts the rest of a paused scene (the rest's key holds them).
	// FSR 3's sharpness (RCAS: 0 the least, 1 the most), live: a change restarts its rest
	if ( pipeline.fsr3 ) antialiasingF.add( pipeline.fsr3.settings.fsr3, 'sharpness', 0, 1, 0.01 ).name( 'FSR sharpness' );
	if ( pipeline.temporal ) {

		const T = pipeline.temporal.settings;
		antialiasingF.add( T, 'framesStill', 1, 32, 1 ).name( 'history frames, still' );
		antialiasingF.add( T, 'framesMoving', 1, 32, 1 ).name( 'history frames, moving' );
		antialiasingF.add( T, 'speedFull', 1, 64, 1 ).name( 'moving from (px/frame)' );
		antialiasingF.add( T, 'gammaStill', 0.25, 3, 0.05 ).name( 'clip box, still (sd)' );
		antialiasingF.add( T, 'gammaMove', 0.25, 3, 0.05 ).name( 'clip box, moving (sd)' );
		antialiasingF.add( T, 'sigma', 0.2, 0.8, 0.01 ).name( 'filter sigma (px)' );
		antialiasingF.add( T, 'sigmaRest', 0.2, 0.8, 0.01 ).name( 'filter sigma at rest (px)' );
		antialiasingF.add( T.sharpness, 'taa', 0, 2, 0.05 ).name( 'taa sharpen softness' );
		antialiasingF.add( T.sharpness.taau, '0', 0, 2, 0.05 ).name( 'taau softness at 1:1' );
		antialiasingF.add( T.sharpness.taau, '1', 0, 2, 0.05 ).name( 'taau softness at 2:1' );
		antialiasingF.add( T, 'skyPassThrough' ).name( 'sky without history' );
		antialiasingF.add( T, 'restSettle', 0, 32, 1 ).name( 'rest: settle frames' );
		antialiasingF.add( T, 'restSequence', 0, 64, 1 ).name( 'rest: jitter frames' );

	}
	const groundF = gui.addFolder( 'Ground' );
	groundF.add( ground, 'soil' ).name( 'soil layer' ).onChange( ( enabled: boolean ) => {

		setSoilStrength( enabled );
		invalidateSunShadow();

	} );
	groundF.add( soilUniforms.depth, 'value', 0.5, 1.75, 0.05 ).name( 'soil depth' ).onChange( invalidateSunShadow );
	groundF.add( chunkView, 'borders' ).name( 'chunk borders' ).onChange( showChunkBorders );
	groundF.add( ambientView, 'mode', [ 'off', 'sky', 'bounce', 'irradiance' ] ).name( 'ambient probes' ).onChange( ( mode: AmbientView ) => ambient.show( mode, scene ) );
	// The island's growth (Growth.ts): Grow swaps in the next piece once it is generated and prepared.
	const islandF = gui.addFolder( 'Island' );
	islandF.add( growth.state, 'step' ).name( 'growth step' ).listen().disable();
	islandF.add( growth.state, 'phase' ).name( 'next piece' ).listen().disable();
	islandF.add( { grow: () => { void growth.grow(); } }, 'grow' ).name( 'Grow' );
	// the progress toward the next piece: the shoal eases toward it, or (paused) is put on it at once
	islandF.add( growth.rise.state, 'approach', 0, 1, 0.01 ).name( 'Approach' ).listen().onChange( ( value: number ) => {

		if ( render.paused ) void growth.approachNow( value );
		else growth.approach( value );

	} );
	const sunF = gui.addFolder( 'Sun' );
	const cloudF = gui.addFolder( 'Sky & clouds' );
	cloudF.add( sky.clouds.coverage, 'value', 0, 1, 0.01 ).name( 'cloud cover override' ).onFinishChange( ( value: number ) => { render.cloudOverride = value; void refreshEnvironment(); } );
	const weatherF = gui.addFolder( 'Weather' );
	const weatherView = { preset: weather.target, seconds: 20 };
	page.weatherView = weatherView;
	// parked weathers are listed in debug builds only (Weather.ts)
	weatherF.add( weatherView, 'preset', Object.keys( WEATHER_PRESETS ).filter( ( name ) => DEBUG || ! isParkedWeather( name ) ) ).name( 'weather' ).listen().onChange( ( name: WeatherName ) => { void setWeather( name, weatherView.seconds ); } );
	weatherF.add( weatherView, 'seconds', 0, 120, 1 ).name( 'transition seconds' );
	// the wind's level and heading (Weather.ts), shown as the weather's target: written only when the
	// target changes, so a drag of the heading is not overwritten while it lasts
	const windView = { ...weather.windTarget };
	page.windView = windView;
	page.shownWind = `${ windView.level },${ windView.heading }`;
	weatherF.add( windView, 'level', Object.keys( WIND_LEVELS ) ).name( 'wind' ).listen().onChange( ( level: WindLevel ) => { void setWind( { level }, weatherView.seconds ); } );
	weatherF.add( windView, 'heading', 0, 360, 1 ).name( 'wind heading' ).listen().onFinishChange( ( heading: number ) => { void setWind( { heading }, weatherView.seconds ); } );
	weatherF.add( weather, 'auto' ).name( 'auto weather' ).listen();
	// the rain's drops and ripples and the wet surfaces, each switched off here (the frame reads them)
	const weatherEffects = { rain: true, wetness: true };
	page.weatherEffects = weatherEffects;
	weatherF.add( weatherEffects, 'rain' ).name( 'rain & ripples' );
	weatherF.add( weatherEffects, 'wetness' ).name( 'wet surfaces' );
	weatherF.add( dayFogView, 'on' ).name( 'day fog' ).onChange( () => markSkyRetune() );
	weatherF.add( seaFogView, 'on' ).name( 'sea fog' ).onChange( () => markSkyRetune() );
	const timeF = gui.addFolder( 'Time & moon' );
	const timeView = { preset: params.get( 'preset' ) ?? 'golden-hour' };
	page.timeView = timeView;
	timeF.add( dayCycle, 'hour', 0, 24, 0.01 ).name( 'hour' ).listen().onFinishChange( refreshEnvironment );
	timeF.add( dayCycle, 'dayLength', 30, 7200, 1 ).name( 'seconds per day' );
	timeF.add( dayCycle, 'paused' ).name( 'pause clock' ).listen();
	timeF.add( timeView, 'preset', Object.keys( DAY_PRESETS ) ).name( 'time preset' ).listen().onChange( ( preset: DayPreset ) => { void setPreset( preset ); } );
	timeF.add( dayCycle, 'moonPhase', 0, 1, 0.01 ).name( 'moon phase' ).onFinishChange( refreshEnvironment );
	timeF.add( dayCycle, 'advanceMoonPhase' ).name( 'lunar cycle' );
	timeF.add( environmentLook, 'exposure' ).name( 'adapt exposure' );
	// in the game the simulation owns the time of day (see tick)
	if ( page.game ) for ( const c of timeF.controllers ) if ( c.object === timeView || ( c.object === dayCycle && ( c.property === 'hour' || c.property === 'paused' ) ) ) c.disable();
	sunF.add( sky, 'elevation', - 6, 70, 0.5 ).onFinishChange( applySun );
	sunF.add( sky, 'azimuth', - 180, 180, 1 ).onFinishChange( applySun );
	sunF.add( sky, 'sunIlluminance', 2, 20, 0.1 ).name( 'illuminance' ).onFinishChange( applySun );
	sunF.add( sky.atmosphere.mieScale, 'value', 0.1, 5, 0.01 ).name( 'aerosol scattering' ).onFinishChange( applySun );
	sunF.add( lighting, 'skyFill', 0, 3, 0.01 ).name( 'sky fill' ).onChange( applySkyFill );
	sunF.add( groundBounce.strength, 'value', 0, 2, 0.01 ).name( 'ground bounce' );
	// the ambient grade (lighting/AmbientGrade.ts): the values the table gives now, and an override
	// whose sliders replace them while it is on, for live tuning
	const ambientF = gui.addFolder( 'Ambient' );
	for ( const key of AMBIENT_KNOBS ) ambientF.add( ambientGrade.current, key ).name( key ).listen().disable();
	const retuneAmbient = () => sceneEvent( 'retune' );
	ambientF.add( ambientGrade, 'override' ).name( 'override' ).onChange( retuneAmbient );
	for ( const key of AMBIENT_KNOBS ) ambientF.add( ambientGrade.manual, key, 0, key === 'directionality' || key === 'aoStrength' ? 1 : 3, 0.01 ).name( `${ key } (override)` ).onChange( retuneAmbient );
	ambientF.close();
	// the local lights (lighting/LocalLights.ts): on or off, and the art gain over the sources' light
	const localLights = render.localLights;
	const localLightsF = gui.addFolder( 'Local lights' );
	localLightsF.add( localLights, 'enabled' ).name( 'on' ).onChange( retuneAmbient );
	localLightsF.add( localLights, 'gain', 0, 16, 0.1 ).name( 'gain' ).onChange( retuneAmbient );
	localLightsF.close();
	const waterF = gui.addFolder( 'Water' );
	const optics = { clarity: 1.0, turbidity: 1.0 };
	const baseA = shared.sigA.value.clone(), baseB = shared.bb.value.clone();
	const setOptics = () => {

		shared.sigA.value.copy( baseA ).multiplyScalar( 1 / optics.clarity );
		shared.bb.value.copy( baseB ).multiplyScalar( optics.turbidity / optics.clarity );

	};

	waterF.add( optics, 'clarity', 0.3, 3, 0.01 ).onChange( setOptics );
	waterF.add( optics, 'turbidity', 0.1, 4, 0.01 ).onChange( setOptics );
	waterF.add( W.roughness, 'value', 0.005, 0.2, 0.001 ).name( 'roughness' );
	waterF.add( W.foamIntensity, 'value', 0, 2, 0.01 ).name( 'foam' );
	waterF.add( W.ssr, 'value', 0, 1, 1 ).name( 'SSR' );
	const waveF = gui.addFolder( 'Waves' );
	const rebuild = () => fft.rebuildSpectrum();
	waveF.add( fft.params, 'windSpeed', 1, 14, 0.1 ).onFinishChange( rebuild );
	waveF.add( fft.params, 'windDirection', - 180, 180, 1 ).onFinishChange( rebuild );
	waveF.add( fft.params, 'amplitude', 0, 3, 0.01 ).onFinishChange( rebuild );
	waveF.add( fft.params, 'choppiness', 0, 1.5, 0.01 ).onFinishChange( rebuild );
	const islanderF = gui.addFolder( 'Islander' );
	page.islanderF = islanderF;
	const proportionsControl = islanderF.add( islanderBuild, 'proportions', PROPORTION_NAMES ).onChange( async ( name: ProportionName ) => island.characters?.setWalker( await buildIslander( name ) ) );
	// the scene walker's body: a new sex dresses it again, a new age builds it again in place
	// (FigureAge.ts); the game's islanders take their build and bodies as they load
	const sexControl = islanderF.add( sceneBody, 'sex', [ 'male', 'female' ] satisfies Sex[] ).onChange( async () => island.characters?.setWalker( await buildIslander( islanderBuild.proportions ) ) );
	const ageControl = islanderF.add( sceneBody, 'age', 2, 100, 0.25 ).onChange( ( age: number ) => island.characters?.walker.age?.set( age ) );
	if ( page.game || ! SCENE_LOOK.ages ) {

		sexControl.disable();
		ageControl.disable();

	}
	if ( page.game ) proportionsControl.disable();

}

/** The folders of the frame's passes: post, tone, anti-aliasing, the debug views. */
export function addLookFolders( render: RenderParts, page: PageParts ) {

	const { pipeline, groundBounce } = render;
	const { gui, S, islanderF } = page;
	islanderF.add( characterLook.albedo, 'value', 0.05, 1, 0.01 ).name( 'palette exposure' );
	islanderF.add( characterLook.sunGain, 'value', 0, 2, 0.01 ).name( 'sun' );
	islanderF.add( characterLook.fillGain, 'value', 0, 10, 0.05 ).name( 'shade fill' );
	islanderF.add( characterLook.formFloor, 'value', 0, 1, 0.01 ).name( 'lit form floor' );
	islanderF.add( characterLook.softCloth, 'value', 0.005, 0.4, 0.005 ).name( 'cloth edge' );
	islanderF.add( characterLook.softSkin, 'value', 0.005, 0.4, 0.005 ).name( 'skin edge' );
	islanderF.add( characterLook.skyRimGain, 'value', 0, 4, 0.01 ).name( 'sky rim' );
	islanderF.add( characterLook.shadowSaturation, 'value', 0.5, 2, 0.01 ).name( 'shade saturation' );
	// the display chain (Pipeline.ts): tidewater's grade (TIDEWATER_GRADE), its exposure from the clock
	// and the weather, the white balance, the local tone mapping and the grade's tables
	const postF = gui.addFolder( 'Post' );
	postF.add( S, 'exposureOffset', - 3, 3, 0.05 ).name( 'exposure offset (stops)' );
	postF.add( S, 'bloom', 0, 3, 0.05 ).name( 'bloom strength' );
	{

		// the high sun's white balance (look/DisplayLook.ts WHITE_BALANCE)
		const day = WHITE_BALANCE.day[ WHITE_BALANCE.day.length - 1 ].values;
		postF.add( day, 'r', 0.4, 1.5, 0.005 ).name( 'white balance red (high sun)' );
		postF.add( day, 'b', 0.5, 1.5, 0.005 ).name( 'white balance blue (high sun)' );

	}
	{

		// the tone curve (ToneCurve.ts): its slope at black, what mid grey shows (linear) and the input
		// that shows white; a set the solve cannot meet warns and keeps the last good curve (only the
		// default set failing throws, on the dev server)
		const curveF = postF.addFolder( 'Tone curve' );
		curveF.add( S.curve, 'toe', 1.5, 3, 0.01 ).name( 'slope at black' );
		curveF.add( S.curve, 'mid', 0.12, 0.22, 0.0005 ).name( 'mid grey shown (linear)' );
		curveF.add( S.curve, 'white', 8, 32, 0.1 ).name( 'white (input)' );
		curveF.close();

	}
	if ( pipeline.localTone ) {

		// the local tone mapping's smooth hinge (LocalTone.ts): the high sun's key, the last of the
		// day's (the frame's values are keyed by the sun every frame)
		const high = LOCAL_TONE.keys.day[ LOCAL_TONE.keys.day.length - 1 ].values;
		postF.add( high, 'hinge', - 3, 2, 0.01 ).name( 'local hinge (stops over mid grey, high sun)' );
		postF.add( high, 'high', - 0.6, 0.2, 0.01 ).name( 'local slope over the hinge (high sun)' );
		postF.add( high, 'low', - 0.4, 0.4, 0.01 ).name( 'local slope under the hinge (high sun)' );
		postF.add( high, 'width', 0.05, 2, 0.01 ).name( 'local knee width (stops, high sun)' );

	}
	postF.add( S, 'lut', 0, 1, 0.01 ).name( 'grade table blend' );
	// the meadow's albedo against its lawn colour (groundGains.lawnGain), tuned with the exposure
	postF.add( groundGains.lawnGain, 'value', 0.5, 3, 0.01 ).name( 'meadow albedo (x)' ).onChange( () => groundBounce.invalidate() );
	postF.add( groundGains.rockGain, 'value', 0.5, 3, 0.01 ).name( 'cliff albedo (x)' );
	postF.add( shared.leafGain, 'value', 0.5, 3, 0.01 ).name( 'tree leaves albedo (x)' );
	{

		// the first table's grade (GradeLut.ts), its table filled anew on every change
		const grade = pipeline.grade, fill = () => pipeline.setGrade();
		const gradeF = postF.addFolder( 'Grade table' );
		gradeF.add( grade, 'contrast', 0.8, 1.3, 0.005 ).onChange( fill );
		gradeF.add( grade, 'saturation', 0.5, 1.6, 0.005 ).onChange( fill );
		gradeF.add( grade.split, '0', 0.1, 0.8, 0.01 ).name( 'shadows end (L)' ).onChange( fill );
		gradeF.add( grade.split, '1', 0.3, 0.98, 0.01 ).name( 'highlights begin (L)' ).onChange( fill );
		for ( const name of [ 'shadows', 'midtones', 'highlights' ] as const ) {

			const zoneF = gradeF.addFolder( name ), zone = grade[ name ];
			zoneF.add( zone, 'value', - 1, 1, 0.01 ).name( 'value (stops)' ).onChange( fill );
			zoneF.addColor( zone, 'tint' ).onChange( fill );
			zoneF.add( zone, 'saturation', 0.5, 1.6, 0.005 ).onChange( fill );
			zoneF.close();

		}
		for ( const [ name, band ] of Object.entries( grade.bands ) ) {

			const bandF = gradeF.addFolder( `${ name } (hue band)` );
			bandF.add( band, 'hue', 0, 360, 1 ).onChange( fill );
			bandF.add( band, 'width', 5, 90, 1 ).onChange( fill );
			bandF.add( band, 'saturation', 0, 2, 0.01 ).onChange( fill );
			bandF.add( band, 'value', - 1, 1, 0.01 ).name( 'value (stops)' ).onChange( fill );
			bandF.add( band, 'shift', - 30, 30, 0.5 ).name( 'hue turn' ).onChange( fill );
			bandF.add( band, 'ceiling', 0.03, 1, 0.005 ).name( 'chroma ceiling' ).onChange( fill );
			bandF.close();

		}
		gradeF.close();

	}
	postF.add( S, 'tone', 0, 1, 0.01 );
	postF.add( S, 'vignette', 0, 1, 0.01 );
	// the haze (weather/VolumetricHaze.ts): its slices, its medium (the weather and the hour's key set the
	// haze's amount, colour and shape, the fog's and the mist's amount: weather/HazeKeys.ts), its light, the
	// shadow's filter and the A/B switches
	page.hazeF = gui.addFolder( 'Haze' );
	page.H = pipeline.air.settings;

}

/** The haze's folder, once the haze has its key. */
export function addHazeFolders( render: RenderParts, page: PageParts ) {

	const { DEBUG, fgview, pipeline } = render;
	const { gui, hazeF, H } = page;
	hazeF.add( H, 'near', 0.05, 20, 0.05 ).name( 'grid near (m)' );
	hazeF.add( H, 'far', 1000, 200000, 1000 ).name( 'grid far (m)' );
	hazeF.add( H, 'growth', 1.02, 1.4, 0.01 ).name( 'slice growth' );
	hazeF.add( H, 'fogExtinction', 0, 0.05, 0.0001 ).name( 'fog extinction (1/m)' );
	hazeF.add( H, 'albedo', 0, 1, 0.01 );
	hazeF.add( H, 'anisotropy', - 0.5, 0.95, 0.01 ).name( 'phase anisotropy' );
	hazeF.add( H, 'gain', 0, 4, 0.01 ).name( 'brightness gain' );
	hazeF.add( H, 'ambientFloor', 0, 1, 0.01 ).name( 'ambient floor under cover' );
	hazeF.add( H, 'ambientSoftness', 0.1, 10, 0.1 ).name( 'cover top half-width (m)' );
	hazeF.add( H, 'blend', 0.01, 1, 0.01 ).name( 'shadow blend' );
	hazeF.add( H, 'restFrames', 1, 64, 1 ).name( 'rest frames' );
	hazeF.add( H, 'jitter' );
	hazeF.add( H, 'tricubic' );
	hazeF.add( H, 'densityAA' ).name( 'density AA' );
	hazeF.add( H, 'sky' ).name( 'haze over the sky' );
	hazeF.add( H, 'debug', { off: 0, 'key light visibility': 1 } ).name( 'debug view' );
	// the screen-space rays (off by default: the haze shows the shafts) and the sun's flare, for A/Bs
	hazeF.add( pipeline.shafts.strength, 'value', 0, 2, 0.01 ).name( 'screen-space rays' ).onChange( () => sceneEvent( 'retune' ) );
	hazeF.add( pipeline.shafts.glare, 'value', 0, 4, 0.01 ).name( 'sun flare' ).onChange( () => sceneEvent( 'retune' ) );
	hazeF.close();
	if ( DEBUG ) {

		// The frame graph's debug view (fgview): its choices from the graph's description. The graph
		// compiles once, so a choice reloads the page with it.
		const debugF = gui.addFolder( 'Debug' );
		const view = { fgview: fgview ?? 'off' };
		const choices = [ 'off', ...debugViewChoices( pipeline.graph.describe() ) ];
		if ( ! choices.includes( view.fgview ) ) choices.push( view.fgview );
		debugF.add( view, 'fgview', choices ).name( 'frame-graph view (reloads)' ).onFinishChange( ( value: string ) => reloadWith( { fgview: value === 'off' ? null : value, gui: '' } ) );
		debugF.close();

	}

}
