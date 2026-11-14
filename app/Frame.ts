// The island page's frame: its part of each frame, the quality detector and the keys.
//
// The island page's frame (render/index.ts `startScene`'s frame, packages/render/assemble/
// SceneFrame.ts, which owns the canvas's size, the render scale, the tick, the loop and `loop.step`):
// what the island page adds to it.
// - Its part of each frame, in the frame's slots: the frame statistics, the game's update, its hour
//   and its draw, the island's frame stages (IslandStages.ts `createIslandFrame`: the growth, the
//   camera, the night's lights, the sward's tint, the life, the islanders, the trample), the GUI's
//   mirrors of the weather and the wind, and the camera's glide among the reasons a frame is not
//   settled. The order is part of the image: a stage reads what the ones before it wrote in the same
//   frame, so a new call goes in the slot its statements belong to.
// - A load that measures the GPU for its tier (QualityDetect.ts) holds the dynamic scale at its
//   nominal until it is done and reads the GPU's time from the frame's timer, or times frames on an
//   idle queue where there is none; the loading screen waits for it, and a lower tier reloads.
// - A resize keeps the island view's framing on the window's aspect.
// - The keys: Space pauses (the game its own clock), H hides the GUI, R / 1, 2, 3 the camera views.
import { DAY_PRESETS, renderEvent, type RenderParts, type SceneContent, type SceneFrameSpec } from '../packages/render/index.ts';
import { isCameraInputTarget, createIslandFrame, type IslandParts } from '../packages/island/index.ts';
import { QualityDetector, qualityLines, rememberQuality } from './QualityDetect.ts';
import type { PageParts } from './Page.ts';

/** The island page's frame. */
export function islandFrame( render: RenderParts, island: IslandParts, page: PageParts ): SceneFrameSpec {

	const { profiler, renderer, DPR_CAP, weather, sun } = render;
	const { poseIslandView, holdsFraming, followFraming } = page.framing;
	const { qualityChoice, weatherEffects, environmentLook, weatherView, windView, frameStats } = page;
	return {
		weatherEffects,
		environmentLook,
		setup( frame ) {

			page.frame = frame;
			if ( qualityChoice.source !== 'detect' ) return;
			const view = () => ( { paused: render.paused, hidden: document.hidden, scale: frame.sizing.renderScale, interval: frame.pacer.rate > 0 ? frame.pacer.interval : 1000 / 60, width: innerWidth, height: innerHeight, cap: DPR_CAP } );
			const detector = new QualityDetector( qualityChoice, view, frame.gpuTimer !== null || profiler?.timestamps === true, () => frame.gpuQueue.onSubmittedWorkDone(), () => renderer.info.frame );
			page.detector = detector;
			if ( frame.dynamicResolution ) frame.dynamicResolution.enabled = false;
			// it measures at the nominal scale, not at the one the dynamic scale remembered
			return { gpuSample: ( id, ms ) => detector.gpu( id, ms ), restore: false };

		},
		resize( apply ) {

			// the island view's framing follows the window's aspect, at once
			const follow = holdsFraming();
			apply();
			poseIslandView( page.framing.viewOptions, island.islandTurned, island.islandZoom );
			if ( follow ) followFraming( false );

		},
		content( frame ) {

			const stages = createIslandFrame( render, island, { framing: page.framing, view: page.reviewView } );
			const { game } = page;
			return {
				start: ( time ) => frameStats.record( time, frame.pacer.interval, frame.pacer.period ),
				// ?game&paused starts the game paused; once the game runs, so does the scene
				beforeClock() {

					if ( render.paused && game && ! game.sim.paused ) render.paused = false;

				},
				// in the game the simulation's clock sets the pace of the day (and so of the page's weather)
				dayStep: game ? ( rawDt ) => game.update( rawDt ) : undefined,
				beforeDay: () => stages.grow(),
				// the sky shows the simulation's hour, whatever else moved the day clock
				hour: game ? () => game.hour() : undefined,
				afterDay( time, dt, rawDt ) {

					weatherView.preset = weather.target;
					const windTarget = weather.windTarget;
					if ( `${ windTarget.level },${ windTarget.heading }` !== page.shownWind ) {

						Object.assign( windView, windTarget );
						page.shownWind = `${ windTarget.level },${ windTarget.heading }`;

					}
					stages.moveCamera( time, dt, rawDt );

				},
				localLights: () => stages.night(),
				afterNight: ( nightAmbient ) => stages.tintSward( nightAmbient ),
				afterWeather: ( dt ) => stages.advanceLife( dt ),
				afterRelight( dt, rawDt ) {

					stages.advanceIslanders( dt );
					game?.render( renderer, sun, render.paused ? 0 : rawDt );
					stages.trample( game ? game.walkers() : null );

				},
				pending( reasons ) {

					if ( island.framingGlide.running ) reasons.push( 'camera glide' );

				},
			};

		},
	};

}

/** The loop behind the quality detector's timing when it runs, and the loading screen's wait. */
export function islandLoop( parts: () => RenderParts, island: IslandParts, page: PageParts ): Pick<SceneContent, 'wrapLoop' | 'revealWait' | 'onRevealed'> {

	return {
		wrapLoop( body ) {

			const { qualityTier } = parts();
			const measuring = page.detector;
			if ( ! measuring ) return body;
			const dynamicResolution = page.frame.dynamicResolution;
			measuring.onDone = ( record ) => {

				Object.assign( page.autoQuality, qualityLines( record?.tier ?? qualityTier, record ? 'measured on this load' : measuring.why, record ) );
				// its frames were drawn at the nominal scale, so the dynamic scale's first decision follows at once
				if ( dynamicResolution ) dynamicResolution.enabled = true;
				// a lower tier reloads into it (from storage, or by ?quality where nothing can be stored)
				const stored = record !== null && rememberQuality( record );
				if ( record && record.tier !== qualityTier ) page.reloadWithQuality( stored ? null : record.tier );

			};
			return ( time ) => measuring.frame( body, time );

		},
		// High's first frames find its render scale behind the loading screen: from the nominal it jumps
		// to the scale the GPU's times call for within a second, out of sight (at most until `until`).
		// The game's islanders show before it lifts too: their figures arrive after the first frames once
		// their pipelines are compiled (GameView "First draws"), which on a cold shader cache took seconds.
		// So do the sun's shadows: its map draws for the first time once its casters' pipelines exist, a
		// few frames in (SunShadow). And the ambient light: its volume holds zeros until its first relight,
		// once the sky has been projected (AmbientRelight `ready`). And the shoal's approach.
		revealWait( { render }, until ) {

			const { profiler, qualityTier, resolution, sunShadow, ambientRelight } = render;
			const { detector, game, frame } = page;
			const { dynamicResolution, gpuTimer } = frame;
			return ! island.approachWritten || sunShadow.draws === 0 || ! ambientRelight.ready || ( detector !== null && ( detector.pending || ( detector.result !== null && detector.result.tier !== qualityTier ) ) ) || ( game !== null && ! game.ready() ) || dynamicResolution !== null && dynamicResolution.settling && ( gpuTimer !== null || profiler?.timestamps === true ) &&
				// eslint-disable-next-line ponlai/scene-clock -- the loading screen's longest wait: when it lifts, not what is drawn
				! render.paused && ! resolution.full && performance.now() < until;

		},
		onRevealed() {

			// the counts start where the scene shows
			page.frameStats.reset();
			// the game's island grows as its people need: its next piece is generated from here on; any
			// other page generates one only once it is asked to grow (Growth.ts)
			if ( page.GAME ) island.growth.start();

		},
	};

}

/** The page's keys. */
export function addKeys( render: RenderParts, page: PageParts ): void {

	const { dayCycle } = render;
	addEventListener( 'keydown', ( e ) => {

		if ( e.repeat || e.ctrlKey || e.metaKey || e.altKey || isCameraInputTarget( e.target ) ) return;
		if ( e.code === 'Space' ) {

			e.preventDefault();
			// the game pauses its own clock; the sea keeps moving
			if ( page.game ) page.game.togglePause();
			else { render.paused = ! render.paused; dayCycle.paused = render.paused; }
			renderEvent( 'key toggle' );

		}
		if ( e.code === 'KeyH' ) { page.gui.show( page.gui._hidden ); renderEvent( 'key toggle' ); }
		if ( e.code === 'KeyR' || e.code === 'Digit1' ) page.setCameraView( 'island' );
		if ( e.code === 'Digit2' ) page.setCameraView( 'horizon' );
		if ( e.code === 'Digit3' ) page.setCameraView( 'sky' );

	} );

}

/** The scene a query names where it names no hour or day length: a 48-minute day from the golden
 * hour, as in many open-world games, slow enough to watch the light change; the game's day is 24
 * minutes at 1x, so a day's work and its evening fit one sitting, and it starts at 8 (Game.ts), so
 * the sky is lit once for that hour. */
export const sceneDefaults = ( game: boolean ) => game ? { hour: 8, dayLength: 1440 } : { hour: DAY_PRESETS[ 'golden-hour' ], dayLength: 2880 };
