import { TEMPORAL } from './Antialiasing.ts';
import { motionState, taaCut } from './Motion.ts';
import { restEpoch } from './TemporalRest.ts';

// The page's scene events for the temporal modes (Antialiasing.ts: aa=taa|taau). A temporal frame is
// a function of the frames before it, so whatever changes the scene in a way the frames themselves
// do not show must say so, at the site that does it, with one call: `sceneEvent( reason, { cut } )`.
// Every event bumps the rest's epoch (TemporalRest.ts: a paused scene converges again from scratch);
// a cut also drops the motion across it and starts the histories over (Motion.ts `taaCut`: the
// camera's, the objects' and the wind's previous state become the current one), for a change the
// history must not carry over (a jump of the camera or of the clock, a new scene, another canvas).
// An event that only retunes what is drawn (a GUI control, a front sweeping in over seconds) keeps
// the history: the running resolve follows it as it follows a moving scene.
//
// The sites call it with their reason; the table below is the one place that says which reasons cut.
// Generic sites only (main.ts's setters and handlers, the game's context hook), never the camera
// controls' internals: a teleport of the camera that no event covers (a direct assignment from the
// console, a control's own jump) is caught by Motion.ts's camera-delta detector (more than 8 m,
// 30 degrees or 2 % of field of view in one rendered frame). Under MSAA only the epoch bumps: the
// page's settled signal (Settled.ts) reads it in every mode; nothing else listens.
//
// The diagnostics' `taa.lastEvent` (TemporalAA.ts) holds the last event: its reason, whether it cut,
// and the rendered frame it followed (`frame`: the motion's frame count when it was raised; it
// applies to the next frame rendered).

/** Every reason a site raises, and whether it cuts. */
export const SCENE_EVENTS = {
	// the frame loop starts (the page's first frame) or restarts (`loop.start()` after a stop)
	'loop start': true,
	// the page shows again (visibilitychange to visible): its last frame may be minutes old
	'visible': true,
	// the scene clock is set (`setTime`): the sea, the wind and the sky jump
	'seek': true,
	// a whole scene at once (`establishScene`: weather, time and clock)
	'establish scene': true,
	// a weather or its wind set at once (`setWeather( name, 0 )`, `setWind( choice, 0 )`), and one
	// that sweeps in over seconds
	'weather jump': true,
	'weather front': false,
	// the time of day or a time preset set at once (`setHour`, `setPreset`)
	'set hour': true,
	'set preset': true,
	// the tier's runtime knobs applied (`applyQuality`: the clouds' view and march, the cadences)
	'apply quality': true,
	// the canvas changed size (a window resize); a render-scale step is not an event: the histories
	// are carried across it (TemporalAA.ts)
	'resize': true,
	// a view jump (keys R/1/2/3, the GUI's view, `setCameraView`) and a switch of the camera's mode
	'view jump': true,
	'camera mode': true,
	// any control of the GUI (bubbling to its root): it retunes the image in place
	'gui': false,
	// the page's keyboard toggles (Space: pause, H: the GUI)
	'key toggle': false,
	// the game (?game, Game.ts): a simulation installed (start, load), its speed or pause, an order
	// that changes what stands on the island (a placed blueprint), and an overlay the player's input
	// moves (the placement ring following the pointer, Placement.ts)
	'game begin': true,
	'game speed': false,
	'game order': false,
	'game input': false,
	// the island grew (World growth, Growth.ts): new land where the sea was, the rest unchanged; the
	// resolve's clip takes the new surfaces as it takes a placed prop
	'world swap': false,
	// the shoal under the next piece written anew (SeabedRise.ts): the floor moves in place
	'approach': false,
	// `__PONLAI__.taa.restart()`
	'restart': true,
} as const satisfies Record<string, boolean>;

export type SceneEventReason = keyof typeof SCENE_EVENTS;

// the events after which a still frame draws what it drew before (the loop restarted, the page
// shown again, a key toggled the pause or the GUI): they leave the epoch's `scene` count
const SAME_SCENE: ReadonlySet<SceneEventReason> = new Set( [ 'loop start', 'visible', 'key toggle' ] );

/** The last event raised (the diagnostics' `taa.lastEvent`), and how many. */
export const sceneEvents = {
	last: null as { reason: SceneEventReason; cut: boolean; frame: number } | null,
	count: 0,
};

/** A change of the scene the temporal modes must know of: bumps the rest's epoch, and cuts the
 * history where the table says so. */
export function sceneEvent( reason: SceneEventReason ): void {

	restEpoch.bump( reason, ! SAME_SCENE.has( reason ) );
	if ( ! TEMPORAL ) return;
	const cut = SCENE_EVENTS[ reason ];
	if ( cut ) taaCut( reason );
	sceneEvents.last = { reason, cut, frame: motionState.frame };
	sceneEvents.count ++;

}
