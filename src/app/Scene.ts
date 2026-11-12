// The scene jump: `establishScene` moves the page to another scene as a fresh load of its query
// holds it, and SCENE_OPTIONS names the query options that make a scene (the tools read the list
// from this file: tools/parity/adhoc.mjs).
import { settings as params, type SettingName } from '../Settings.ts';
import type { DayPreset } from '../sky/DayCycle.ts';
import type { WeatherName } from '../sky/Weather.ts';
import { weatherWind } from '../weather/Wind.ts';
import { sceneEvent } from '../post/SceneEvents.ts';
import { registerSceneHistories, registerLightHistories, type RenderParts } from '../RenderStages.ts';
import { registerIslandHistories, type IslandParts } from '../IslandStages.ts';
import type { PageParts } from './Page.ts';

// A whole scene at once, as a page loads it (the capture tools' one page per set; the profiler's
// scene switches). `establishScene( query )` (a string or URLSearchParams) leaves the page as a
// fresh load of `?<query>` would draw it, from any scene before: once the caller has rendered a
// frame at the jump's camera and then run what it runs after a load (a view's eval), the paused
// frame equals the fresh load's, to the byte wherever the fresh load repeats itself
// (tools/verify-scene-jump.mjs checks every parity view from several scenes before).
// - The scene's options (SCENE_OPTIONS) come from the query, each one left out at its load default
//   (`sceneOptions`): the weather established (wet in rain; auto weather without `weather`), the day
//   clock (hour or preset, moon phase, day length, paused), the scene clock (`t`, `paused`) and the
//   wind integrated to it, the cloud override.
// - The camera: the orbit's island view at the query's dist / polar / az (`placeOrbit`, as the load
//   places it) and the controls' limits restored, in the query's camera mode.
// - What the scenes before left behind is cleared: the sky bakes as the page's first bake (Sky.reset:
//   both endpoints and atlases, the clouds as before the first frame), the lightning forgets its
//   strikes, the storm sea its foam window, the islander its clips, the refracted sun its map
//   (back to its size and redrawn at once after the bake, as the load's `prepare` draws it), the
//   fog its bank; the sun's map redraws from scratch and the temporal modes cut their history
//   ('establish scene').
// - Load-time options the query names (quality, aa, dpr, the debug switches: read once when
//   materials and the frame graph are built; the land's `seed`, generated once) must equal the
//   page's own, or it throws: reload instead. `grow` must equal the land step shown (the URL's, or
//   a later one after Grow: a page grown in place draws what a fresh load of that step draws). Those it leaves out are the page's. GUI edits and console changes are not undone.
// The frame after the jump must render at the jump's camera before a view's eval moves it, as a
// fresh load's first frames do before a capture's eval runs: the storm's strikes take their
// bearings ahead of the camera of the frame that first sees them (Lightning.ts), the storm sea
// places its window there (StormSea.ts). (The art-review page only: under ?game the game owns the
// clock.)
// The options form `{ weather?, preset?, hour?, time? }` (tools/profile-frame.mjs) sets what it
// names, keeps the rest and the camera, and clears the leftovers all the same.
// `__PONLAI__.sceneJump` (1) marks a page that keeps this contract: tools/parity/capture-set.mjs
// captures a set in one page only where it is set (older builds' establishScene takes only the
// options form and leaves state behind). Raise it if the contract changes in a way callers see.
export const SCENE_OPTIONS = [ 'weather', 'wind', 'windDir', 'preset', 'hour', 'moon', 't', 'dist', 'polar', 'az', 'camera', 'clouds', 'dayLength', 'paused', 'clock', 'approach' ];
export type SceneRequest = string | URLSearchParams | { weather?: WeatherName; preset?: DayPreset; hour?: number; time?: number };

/** The scene jump. */
export function createSceneControls( render: RenderParts, island: IslandParts, page: PageParts ) {

	const { sceneOptions, dayCycle, weather, wind, bakeExplicitly, refreshEnvironment, history } = render;
	const { controls, growth, poseIslandView } = island;
	const { setCameraMode, setCameraView, timeView, pacer } = page;
	// What a jump clears of the scenes before, registered layer by layer in the order it is
	// cleared (post/SceneHistory.ts): the renderer's, the island's, the renderer's light, the page's.
	registerSceneHistories( render );
	registerIslandHistories( render, island );
	registerLightHistories( render );
	history.onJump( 'shadow cadence', () => { page.shadowElapsed = 0; } );
	// a fresh load starts at the held frame rate, not at a fallback the last scene fell to
	history.onJump( 'frame pacer', () => pacer.reset() );
	// setTime moves the (paused) clock, so captures can step through an animation in one page load
	page.setTime = ( t: number ) => {

		if ( ! Number.isFinite( t ) || t < 0 ) throw new RangeError( 'Scene time must be finite and non-negative' );
		render.simTime = t;
		wind.reset( { ...weatherWind( weather.state ), time: t } );
		sceneEvent( 'seek' );
		return refreshEnvironment();

	};
	// (the loop draws no frame from its first change until its bake has published: `bakeExplicitly`)
	page.establishScene = async ( scene: SceneRequest ): Promise<void> => {

		render.jumpsInFlight ++;
		try {

			await changeScene( scene );

		} finally {

			render.jumpsInFlight --;

		}

	};
	const changeScene = async ( scene: SceneRequest ): Promise<void> => {

		const query = typeof scene === 'string' ? new URLSearchParams( scene ) : scene instanceof URLSearchParams ? scene : null;
		if ( query ) {

			// (the land's `grow` against the step shown: a page grown in place draws a fresh load of that step)
			const pageValues = ( key: string ) => key === 'grow' ? [ String( growth.state.step ) ] : params.getAll( key as SettingName );
			const fixed = [ ...new Set( query.keys() ) ].filter( ( key ) => ! SCENE_OPTIONS.includes( key ) && query.getAll( key ).join( '&' ) !== pageValues( key ).join( '&' ) );
			if ( fixed.length ) throw new Error( `establishScene: ${ fixed.join( ', ' ) } differ from the page's and are read once at load: reload the page with them` );
			const next = sceneOptions( query );
			render.cloudOverride = next.clouds;
			weather.establish( next.weather, next.wind );
			weather.auto = next.autoWeather;
			dayCycle.reset( next.day );
			if ( next.preset ) dayCycle.setPreset( next.preset );
			timeView.preset = query.get( 'preset' ) ?? 'golden-hour';
			render.paused = next.paused;
			render.simTime = next.time;
			// the island view's pose, placed as the load places it, on a camera and controls of its own
			poseIslandView( query );
			controls.clearInput();
			setCameraMode( 'orbit' );
			setCameraView( 'island' );
			if ( next.camera === 'free' ) setCameraMode( 'free' );
			// the shoal at the query's approach (0 without one), put on it at once
			await growth.approachNow( Number( query.get( 'approach' ) ?? 0 ) );

		} else {

			const options = scene as { weather?: WeatherName; preset?: DayPreset; hour?: number; time?: number };
			render.cloudOverride = null;
			if ( options.weather ) {

				weather.auto = false;
				weather.establish( options.weather );

			}
			if ( options.preset ) dayCycle.setPreset( options.preset );
			else if ( options.hour !== undefined ) dayCycle.setHour( options.hour );
			if ( options.time !== undefined ) render.simTime = options.time;

		}
		history.jump( 'before bake' );
		sceneEvent( 'establish scene' );
		render.manualSun = false;
		await bakeExplicitly();
		history.jump( 'after bake' );

	};

}
