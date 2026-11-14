import * as THREE from 'three/webgpu';
import { isCameraInputTarget } from './FreeCameraControls.ts';
import { IslandGround } from './IslandGround.ts';
import type { GroundGrid } from '../world/ChunkDerived.ts';
import { SHELF_REACH } from '../world/Bathymetry.ts';

// The island's camera controls: grab, orbit and zoom by hand, or held at the island's framing.
//
// The island's camera, in the manner of a management or island-building game (Islanders,
// Dorfromantik; Anno, Frostpunk and Planet Zoo differ mostly in which button does what). The hand
// moves it while `handInput` is on (main.ts: on unless the query says `cameraInput=off`, the GUI's
// 'move by hand'); off, every pointer, wheel, gesture and key is ignored, and the island view holds
// the framing main.ts places it at (IslandFraming.ts). With the hand:
//
// - A left drag grabs the ground: the point under the cursor at the press stays under it, exactly,
//   on every frame (one-finger click-drag on a trackpad). A right or middle drag (or Option / Ctrl
//   with the left) turns the view about the point at the screen's centre and tilts it.
// - The wheel zooms toward the point under the cursor, and the view tilts toward the horizon as it
//   closes in. A trackpad's two-finger swipe moves the ground with the fingers and its pinch zooms
//   (Chrome reports a pinch as a wheel event with ctrlKey); with Option, a swipe turns and tilts.
// - W A S D or the arrows pan, Q / E turn, T / G tilt, + / - zoom (Shift: faster); panning at the
//   window's edge is optional.
//
// Smoothing only where such games use it: what the hand moves directly (a drag, a swipe, a pinch)
// is applied whole on the frame that draws it, with no smoothing between hand and view (a drag is
// read a fixed few milliseconds behind the frame, so it moves the view evenly: `pointerAt`); the
// wheel's zoom, the keys and the edge ease in and out, and a drag released while moving glides on
// and slows. Every input is gathered by the event handlers and applied at the start of the next
// tick (`advance`), so a frame shows all input that arrived before it, and the motion it carries is
// taken as deltas on the camera's current position and target: anything that places the camera by
// hand (the views, the capture and profiling tools) keeps its placement.
//
// At rest, `advance` does exactly what three's OrbitControls did at rest (spherical coordinates
// from the camera's offset, the same clamps, the same arithmetic), so a still camera holds the very
// position it did and paused captures frame exactly as before. The pivot is held over the land and
// its ring of shallows, softly (`setIsland`, again whenever the land grows), the distance and tilt
// to their limits, and the camera kept above the ground.
//
// Rules and their reasons:
// - A press stays a click until it moves 3 px, so a left-click action can share the button.
// - The zoom tilts the view toward the horizon by 12 degrees per e-fold of distance.
// - In the island view the fov widens as the view closes in (`widenFov`, `fovAt`): the far fov
//   (27 degrees) from 50 m outward, eased to 42 degrees at the closest zoom, so up close the view
//   takes in the sky above the island while the far end keeps its miniature look. It is a function
//   of the distance alone, set before the points under the pointer are kept there, so a zoom stays
//   anchored under the cursor and a still camera's frames repeat (`nearFov`, `nearFovFrom` and
//   `nearFov=off` in the query: main.ts).
// - A mouse wheel is told from a trackpad swipe by its deltas (macOS reports a notch in multiples
//   of 4.000244140625 px, a trackpad whole pixels with `wheelDeltaY` three times `-deltaY`); the
//   GUI's scroll setting overrides the guess. Panning at the window's edge is off by default: in a
//   normal window the edge is where the pointer leaves.
// - Only the wheel's zoom glides (80 ms), the keys ease in and out (100 ms) and a released drag
//   glides on (220 ms). The orbit before damped every input (a 0.27 s time constant): in a steady
//   drag the view trailed the hand by about a quarter of a second, which players read as dropped
//   frames; now it trails by one input sample.
// - Input is applied once, at the start of the tick that draws it (`advance( dt, time )`), never
//   between frames. A drag is read one input sample interval (at most 8 ms) behind the frame's
//   vblank, between the two pointer samples around that time (input resampling, as Android's
//   `InputTransport` does with its `RESAMPLE_LATENCY`): read at its newest sample, a 125 Hz mouse
//   moved the view unevenly from one frame to the next.
// - The limits constrain input only: the pivot over the land's convex hull grown by the shelf's
//   reach, 14 m (the land and its ring of shallows, which the island view frames; recomputed when
//   the land grows: `setIsland`), past which a pull goes on against a resistance that grows with
//   the distance, at most 10 m farther (`held`), and springs back with a 0.12 s time constant once let
//   go, so the edge reads as a give rather than a wall; the farthest zoom 70 m whatever the land's
//   size (at 1440p the meadow's blades still cover a pixel there: the hand pans to the rest of a
//   larger land); the camera 2 m above the ground (a height grid of the island's meshes, merged
//   from the grids the world's chunks come with: IslandGround.ts).
// - At rest the update is three's OrbitControls' arithmetic to the bit, its constructor's update
//   included, so paused frames do not depend on input history and match older captures; but for
//   the clamp of the target's length, a no-op with its limits whose last bit could alternate
//   from frame to frame.

type DragMode = 'pan' | 'rotate';

interface Drag {
	id: number;
	mode: DragMode;
	// the press, the latest pointer position and the one the last frame consumed (canvas px)
	downX: number; downY: number;
	x: number; y: number;
	usedX: number; usedY: number;
	// the grabbed ground point (a pan); `grabAt` asks the next frame to take it under (x, y)
	grab: THREE.Vector3 | null;
	grabAt: 'down' | 'current' | null;
	// a left drag stays a click until it moves a few pixels
	started: boolean;
	// recent pointer samples (resampling, the glide on release): [ time, x, y ] triplets, and the
	// interval they come at (ms)
	samples: number[];
	interval: number;
	// the pointer time the last frame showed (a frame never goes back before it)
	usedTime: number;
}

export type ScrollMode = 'auto' | 'zoom' | 'pan';

// the drag that turns a left press into a pan (px), so a click stays a click (the game debug
// panel's send-to-click reads the same slop)
export const CLICK_SLOP = 3;
// pointer samples kept for the release velocity (ms), and how recent the last must be for a glide
const RELEASE_WINDOW = 80, RELEASE_STILL = 50;
// the most a drag is resampled behind the frame's vblank (ms): one sample of a 125 Hz mouse
const MAX_RESAMPLE_DELAY = 8;
// a mouse wheel notch on macOS (Chrome and Safari report its delta in multiples of this: Cocoa's
// 0.1 line times 40 px)
const MAC_WHEEL_NOTCH = 4.000244140625;
// a scroll gesture ends after this long without events (ms)
const GESTURE_GAP = 250;
const PAN_KEYS: Record<string, [ number, number ]> = {
	KeyW: [ 0, 1 ], ArrowUp: [ 0, 1 ], KeyS: [ 0, - 1 ], ArrowDown: [ 0, - 1 ],
	KeyA: [ - 1, 0 ], ArrowLeft: [ - 1, 0 ], KeyD: [ 1, 0 ], ArrowRight: [ 1, 0 ],
};
const CAMERA_KEYS = new Set( [ ...Object.keys( PAN_KEYS ), 'KeyQ', 'KeyE', 'KeyT', 'KeyG', 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract', 'ShiftLeft', 'ShiftRight' ] );

const _offset = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _swipe = new THREE.Vector3();
const _centre = new THREE.Vector3();
const _pan = new THREE.Vector2();
const _near = new THREE.Vector2();
const _best = new THREE.Vector2();
const _held = new THREE.Vector2();

export class IslandCameraControls {

	readonly isIslandCamera = true;
	/** The pivot: the point the view centres on and turns about. */
	readonly target = new THREE.Vector3();
	minDistance = 0;
	maxDistance = Infinity;
	minPolarAngle = 0;
	maxPolarAngle = Math.PI;
	/** Off: zoom, keys, edge and glides apply at once (the verify tools place the camera with it). */
	enableDamping = true;
	enablePan = true;
	enableZoom = true;
	enableRotate = true;
	/** The turn (and tilt) per window height dragged (radians). */
	turnPerHeight = Math.PI;
	/** The tilt that follows a zoom: radians toward the horizon per e-fold the distance shrinks. */
	pitchPerZoom = THREE.MathUtils.degToRad( 12 );
	/** The vertical field of view follows the distance (`fovAt`): `farFov` from `widenFrom` (m)
	 * outward, widening to `nearFov` at `minDistance` (degrees). Off, the camera's fov is left as it
	 * is (the review views and the free flight set their own). */
	widenFov = false;
	farFov: number;
	nearFov = 42;
	widenFrom = 50;
	/** A wheel notch's zoom (natural log of the distance), and the time constant of its glide (s). */
	wheelZoom = 0.18;
	zoomTime = 0.08;
	/** The glide after a released drag: its time constant (s). */
	glideTime = 0.22;
	/** Keyboard and edge pan, in view distances per second; turn, tilt (rad/s); zoom (e-folds/s). */
	keyPanSpeed = 0.6;
	keyTurnSpeed = THREE.MathUtils.degToRad( 100 );
	keyTiltSpeed = THREE.MathUtils.degToRad( 50 );
	keyZoomSpeed = 1.2;
	/** How the keys and the edge ease in and out (time constant, s). */
	keyTime = 0.1;
	/** What a scroll that is not a pinch does: `auto` zooms with a mouse wheel and pans with a
	 * trackpad's two-finger swipe. */
	scrollMode: ScrollMode = 'auto';
	edgePan = false;
	/** The pivot stays over the land's convex hull grown by this (m): the land and its ring of
	 * shallows (Bathymetry.ts SHELF_REACH), which the island view frames (IslandFraming.ts). */
	reach = SHELF_REACH;
	/** How much farther past that the hand can pull the pivot (m), against a resistance that grows
	 * with the distance, and the time constant it springs back in once let go (s). */
	softReach = 10;
	springTime = 0.12;
	/** The farthest zoom (m): at 1440p the meadow's blades still cover a pixel or more there. */
	farthest = 70;
	groundClearance = 2;
	readonly ground = new IslandGround();
	/** The page time of the newest pointer or wheel input the last frame applied (for latency
	 * measurements), or NaN. */
	lastInputTime = NaN;
	/** Whether a drag is resampled at a fixed delay behind the frame (see `pointerAt`). */
	resample = true;

	private active = true;
	private hand = false;
	private readonly spherical = new THREE.Spherical();
	private drag: Drag | null = null;
	// a drag just released, whose last motion the next frame still applies
	private ending: Drag | null = null;
	private readonly keys = new Set<string>();
	// input gathered since the last frame
	private turn = 0;
	private tilt = 0;
	private pinch = 0;
	private wheel = 0;
	private scrollX = 0;
	private scrollY = 0;
	private scrollAtX = 0;
	private scrollAtY = 0;
	private zoomAtX = NaN;
	private zoomAtY = NaN;
	private newestInput = NaN;
	// the zoom still to glide (natural log of the distance), and the point it closes in on
	private zoomLeft = 0;
	private readonly zoomAnchor = new THREE.Vector3();
	private zoomAnchored = false;
	private zoomNdcX = 0;
	private zoomNdcY = 0;
	// the glides after a release and the eased keyboard / edge motion
	private readonly glide = new THREE.Vector2();
	private glideTurn = 0;
	private readonly keyPan = new THREE.Vector2();
	private keyTurn = 0;
	private keyTilt = 0;
	private keyZoom = 0;
	// the pointer over the canvas, for the edge pan
	private hoverX = NaN;
	private hoverY = NaN;
	private scrollType: 'wheel' | 'trackpad' = 'wheel';
	private lastScroll = - Infinity;
	private gestureScale = 1;
	private gestureRotation = 0;
	// the land's convex hull (x, z pairs: IslandFraming.landOutline); empty, the pivot goes anywhere
	private hull: readonly number[] = [];
	// the page the element is in, for its keys, focus and visibility
	private readonly page: Document;
	private readonly view: Window;

	constructor( private readonly camera: THREE.PerspectiveCamera, private readonly element: HTMLElement ) {

		this.page = element.ownerDocument;
		this.view = this.page.defaultView as Window;
		this.farFov = camera.fov;
		element.style.touchAction = 'none';
		element.addEventListener( 'pointerdown', this.onPointerDown );
		element.addEventListener( 'pointermove', this.onPointerMove );
		element.addEventListener( 'pointerup', this.onPointerUp );
		element.addEventListener( 'pointercancel', this.onPointerCancel );
		element.addEventListener( 'lostpointercapture', this.onPointerCancel );
		element.addEventListener( 'pointerleave', this.onPointerLeave );
		element.addEventListener( 'contextmenu', this.onContextMenu );
		element.addEventListener( 'wheel', this.onWheel, { passive: false } );
		// Safari's trackpad pinch and rotation (Chrome sends a pinch as a ctrl wheel instead)
		element.addEventListener( 'gesturestart', this.onGestureStart as EventListener );
		element.addEventListener( 'gesturechange', this.onGestureChange as EventListener );
		this.view.addEventListener( 'keydown', this.onKeyDown );
		this.view.addEventListener( 'keyup', this.onKeyUp );
		this.view.addEventListener( 'blur', this.clearInput );
		this.page.addEventListener( 'visibilitychange', this.onVisibilityChange );
		this.page.addEventListener( 'focusin', this.onFocusIn );
		// as OrbitControls' constructor did (about the origin, with its default limits), so a camera
		// placed before it ends on the very same bits
		this.update();

	}

	get enabled(): boolean { return this.active; }
	set enabled( value: boolean ) {

		if ( value === this.active ) return;
		this.clearInput();
		this.active = value;

	}

	/** Whether the hand moves the view (drags, the wheel and gestures, the keys). Off by default:
	 * the view holds the pose it is placed at (main.ts frames it on the land: IslandFraming.ts). */
	get handInput(): boolean { return this.hand; }
	set handInput( value: boolean ) {

		if ( value === this.hand ) return;
		this.clearInput();
		this.hand = value;

	}

	// whether input is taken
	private get listening(): boolean { return this.active && this.hand; }
	// whether the hand pulled the pivot past its bounds: it springs back once let go
	private stretched = false;

	/** Takes the ground the camera grabs from the grids of the island's chunks (ChunkDerived.ts),
	 * and the land's convex hull the pivot's bounds grow from (IslandFraming.landOutline); again
	 * when the land grows. The farthest zoom is `farthest`, whatever the land's size: the hand pans
	 * to the rest. */
	setIsland( grids: readonly GroundGrid[], outline: readonly number[] ): void {

		this.ground.fromGrids( grids );
		this.hull = outline;
		this.maxDistance = this.farthest;

	}

	// The point of the land's hull nearest to ( x, z ): itself when inside (or with no hull).
	private nearestOnHull( x: number, z: number, out: THREE.Vector2 ): THREE.Vector2 {

		const h = this.hull, n = h.length >> 1;
		out.set( x, z );
		if ( n < 3 ) return out;
		let best = Infinity, above = 0, below = 0;
		for ( let i = 0; i < n; i ++ ) {

			const ax = h[ 2 * i ], az = h[ 2 * i + 1 ], j = ( i + 1 ) % n;
			const ex = h[ 2 * j ] - ax, ez = h[ 2 * j + 1 ] - az;
			// inside a convex polygon the point lies on one side of every edge, whichever its winding
			const side = ex * ( z - az ) - ez * ( x - ax );
			if ( side > 0 ) above ++; else if ( side < 0 ) below ++;
			const t = THREE.MathUtils.clamp( ( ( x - ax ) * ex + ( z - az ) * ez ) / Math.max( ex * ex + ez * ez, 1e-12 ), 0, 1 );
			const px = ax + ex * t, pz = az + ez * t, d = ( x - px ) ** 2 + ( z - pz ) ** 2;
			if ( d < best ) { best = d; _best.set( px, pz ); }

		}
		return above === 0 || below === 0 ? out : out.copy( _best );

	}

	// How far ( x, z ) lies from the land's hull (0 inside it).
	private hullDistance( x: number, z: number ): number {

		const q = this.nearestOnHull( x, z, _near );
		return Math.hypot( x - q.x, z - q.y );

	}

	// ( x, z ) held to the hull grown by `edge` (m): past it, eased toward `softReach` farther along
	// the way out from the hull (the rubber band's resistance), else as it is.
	private held( x: number, z: number, edge: number, out: THREE.Vector2 ): THREE.Vector2 {

		const q = this.nearestOnHull( x, z, out );
		const dx = x - q.x, dz = z - q.y, d = Math.hypot( dx, dz );
		if ( ! ( d > edge ) ) return out.set( x, z );
		const r = this.softReach, o = d - edge;
		const k = ( edge + ( r > 0 ? r * ( 1 - Math.exp( - o / r ) ) : 0 ) ) / d;
		return out.set( q.x + dx * k, q.y + dz * k );

	}

	/** The vertical field of view at `distance` (degrees): `farFov` from `widenFrom` outward, eased
	 * (smoothstep on the log of the distance) to `nearFov` at `minDistance`. A function of the
	 * distance alone, so a still camera's fov does not depend on the zoom that brought it there. */
	fovAt( distance: number ): number {

		const from = Math.max( this.widenFrom, this.minDistance );
		if ( ! ( distance < from ) ) return this.farFov;
		const u = Math.min( Math.log( from / distance ) / Math.log( from / this.minDistance ), 1 );
		return this.farFov + ( this.nearFov - this.farFov ) * u * u * ( 3 - 2 * u );

	}

	/** Drops the input in flight: held keys, a drag, pending zoom and every glide. */
	clearInput = (): void => {

		this.keys.clear();
		this.endDrag();
		this.ending = null;
		this.stopMotion();

	};

	/** Applies the input gathered since the last frame and one frame of `dt` seconds of the eased
	 * motion; `time` is the frame's vblank (its rAF timestamp, page time), which a drag is
	 * resampled against. Returns whether the camera moved. */
	advance( dt: number, time = NaN ): boolean {

		return this.apply( Number.isFinite( dt ) ? Math.max( dt, 0 ) : 0, time );

	}

	/** Applies the gathered input at once and drops the eased motion (before a placement by hand). */
	settle(): void {

		this.applyAtOnce();
		this.stopMotion();
		if ( this.drag?.mode === 'pan' ) this.drag.grabAt = 'current';

	}

	/** Applies the gathered input and the limits at once (as OrbitControls' `update` did), for code
	 * that places the camera by hand. */
	update(): boolean {

		return this.applyAtOnce();

	}

	dispose(): void {

		this.clearInput();
		const e = this.element;
		e.removeEventListener( 'pointerdown', this.onPointerDown );
		e.removeEventListener( 'pointermove', this.onPointerMove );
		e.removeEventListener( 'pointerup', this.onPointerUp );
		e.removeEventListener( 'pointercancel', this.onPointerCancel );
		e.removeEventListener( 'lostpointercapture', this.onPointerCancel );
		e.removeEventListener( 'pointerleave', this.onPointerLeave );
		e.removeEventListener( 'contextmenu', this.onContextMenu );
		e.removeEventListener( 'wheel', this.onWheel );
		e.removeEventListener( 'gesturestart', this.onGestureStart as EventListener );
		e.removeEventListener( 'gesturechange', this.onGestureChange as EventListener );
		this.view.removeEventListener( 'keydown', this.onKeyDown );
		this.view.removeEventListener( 'keyup', this.onKeyUp );
		this.view.removeEventListener( 'blur', this.clearInput );
		this.page.removeEventListener( 'visibilitychange', this.onVisibilityChange );
		this.page.removeEventListener( 'focusin', this.onFocusIn );

	}

	// ------------------------------------------------------------------ the frame

	private applyAtOnce(): boolean {

		const damping = this.enableDamping;
		this.enableDamping = false;
		try {

			return this.apply( 0, NaN );

		} finally {

			this.enableDamping = damping;

		}

	}

	private apply( dt: number, time: number ): boolean {

		const camera = this.camera, position = camera.position, target = this.target, s = this.spherical;
		const h = Math.max( this.element.clientHeight, 1 );
		const ease = ( tau: number ) => this.enableDamping ? 1 - Math.exp( - dt / tau ) : 1;
		this.lastInputTime = this.newestInput;
		this.newestInput = NaN;

		// what the hand moved since the last frame, whole, and this frame's share of the eased motion
		let dTheta = 0, dPhi = 0, dZoom = 0;
		const pan = this.keyFrame( dt, ease( this.keyTime ) );
		if ( this.enableRotate ) {

			dTheta += ( this.keyTurn + this.glideTurn ) * dt - this.turn * this.turnPerHeight / h;
			dPhi += this.keyTilt * dt - this.tilt * this.turnPerHeight / h;

		}
		this.turn = this.tilt = 0;
		// the drag (or the one released since the last frame, to its last position): where the
		// pointer was at this frame's sampling time
		const drag = this.drag ?? this.ending;
		const [ px, py ] = drag ? drag === this.ending ? [ drag.x, drag.y ] : this.pointerAt( drag, time ) : [ 0, 0 ];
		this.ending = null;
		if ( drag?.mode === 'pan' && ! this.enablePan ) {

			// (the view changed to one that only turns, mid-drag)
			drag.mode = 'rotate';
			drag.usedX = px;
			drag.usedY = py;

		}
		if ( drag?.mode === 'pan' && drag.grabAt ) {

			// the grab of a pan, under the press (or, after a view jump, where the pointer is now)
			const x = drag.grabAt === 'down' ? drag.downX : px, y = drag.grabAt === 'down' ? drag.downY : py;
			drag.grab = this.groundAt( x, y, drag.grab ?? new THREE.Vector3() );
			drag.grabAt = null;
			// grabbing the sky turns the view instead
			if ( ! drag.grab ) {

				drag.mode = 'rotate';
				drag.usedX = x;
				drag.usedY = y;

			}

		}
		if ( drag?.mode === 'rotate' ) {

			if ( this.enableRotate ) {

				dTheta -= ( px - drag.usedX ) * this.turnPerHeight / h;
				dPhi -= ( py - drag.usedY ) * this.turnPerHeight / h;

			}
			drag.usedX = px;
			drag.usedY = py;

		}
		// zoom: a pinch whole, a wheel notch's glide eased, the keys; toward the point under the
		// pointer for as long as the glide it started runs
		let zoomAnchoring = false;
		if ( this.enableZoom ) {

			if ( this.pinch !== 0 || this.wheel !== 0 ) this.anchorZoom();
			this.zoomLeft += this.wheel;
			let glide = this.zoomLeft * ease( this.zoomTime );
			if ( Math.abs( this.zoomLeft - glide ) < 1e-4 ) glide = this.zoomLeft;
			this.zoomLeft -= glide;
			dZoom = this.pinch + glide + this.keyZoom * dt;
			zoomAnchoring = this.zoomAnchored && ( this.pinch !== 0 || glide !== 0 );
			if ( this.zoomLeft === 0 ) this.zoomAnchored = false;

		} else {

			this.zoomLeft = 0;
			this.zoomAnchored = false;

		}
		this.pinch = this.wheel = 0;
		if ( this.enablePan ) pan.addScaledVector( this.glide, dt );
		else pan.set( 0, 0 );
		// a pivot the hand pulled past its bounds springs back once let go (a pan drag or the keys
		// hold it out)
		let springing = false;
		if ( this.stretched && drag?.mode !== 'pan' && pan.x === 0 && pan.y === 0 ) {

			// the nearest point of the hull grown by `reach`
			const q = this.nearestOnHull( target.x, target.z, _held ), d = Math.hypot( target.x - q.x, target.z - q.y );
			const k0 = d > this.reach ? this.reach / d : 1;
			const dx = q.x + ( target.x - q.x ) * k0 - target.x, dz = q.y + ( target.z - q.y ) * k0 - target.z;
			const k = Math.abs( dx ) + Math.abs( dz ) < 0.01 ? 1 : ease( this.springTime );
			target.x += dx * k;
			target.z += dz * k;
			position.x += dx * k;
			position.z += dz * k;
			if ( k === 1 ) this.stretched = false;
			springing = dx !== 0 || dz !== 0;

		}
		// the ground under a two-finger swipe, before the frame moves the camera
		const swiping = ( this.scrollX !== 0 || this.scrollY !== 0 ) && this.enablePan;
		const swipe = swiping ? this.groundAt( this.scrollAtX, this.scrollAtY, _swipe ) ?? this.levelAt( this.scrollAtX, this.scrollAtY, target.y, _swipe ) : null;
		// a turn about the ground at the screen's centre (rather than the pivot, which lies below the
		// meadow), so the point there stays there
		const centre = dTheta !== 0 && this.enablePan ? this.groundAt( this.element.clientWidth / 2, h / 2, _centre ) : null;
		const moving = springing || dTheta !== 0 || dPhi !== 0 || dZoom !== 0 || pan.x !== 0 || pan.y !== 0 || swipe !== null || ( drag?.mode === 'pan' && drag.grab !== null && drag.started );
		const targetX = target.x, targetZ = target.z, positionX = position.x, positionY = position.y, positionZ = position.z;

		// OrbitControls' update, with the deltas above (at rest it is that update to the bit)
		_offset.copy( position ).sub( target );
		s.setFromVector3( _offset );
		s.theta += dTheta;
		s.phi += dPhi;
		if ( dZoom !== 0 ) {

			const radius = THREE.MathUtils.clamp( s.radius * Math.exp( dZoom ), this.minDistance, this.maxDistance );
			// the view tilts toward the horizon as it closes in, by the zoom it actually took
			s.phi -= this.pitchPerZoom * Math.log( radius / s.radius );
			s.radius = radius;
			if ( radius === this.minDistance || radius === this.maxDistance ) this.zoomLeft = 0;

		}
		s.phi = Math.max( this.minPolarAngle, Math.min( this.maxPolarAngle, s.phi ) );
		s.makeSafe();
		if ( centre ) {

			const x = target.x - centre.x, z = target.z - centre.z, c = Math.cos( dTheta ), si = Math.sin( dTheta );
			target.x = centre.x + x * c + z * si;
			target.z = centre.z + z * c - x * si;

		}
		if ( pan.x !== 0 || pan.y !== 0 ) {

			// the keys' and the glides' pan, in the view's heading (x right, y forward)
			const si = Math.sin( s.theta ), c = Math.cos( s.theta );
			target.x += pan.x * c - pan.y * si;
			target.z += - pan.x * si - pan.y * c;

		}
		// (OrbitControls also clamps the target's length about its cursor, which with its default
		// limits changes nothing but the last bit: dividing by the length and multiplying back
		// stepped the island view's pivot at the fourth growth step between two values on
		// alternate frames, so a paused page never settled. It is left out.)
		s.radius = Math.max( this.minDistance, Math.min( this.maxDistance, s.radius ) );
		this.place();
		// the fov at the new distance, before the points below are kept under the pointer: their
		// rays are cast through the projection this frame draws with (the sideways moves and the
		// limits below keep the distance)
		const widened = this.widenFov && this.setFov( this.fovAt( s.radius ) );

		// the points that stay under the pointer: the zoom's, the swipe's, the drag's (the hand's
		// last, so it wins)
		if ( zoomAnchoring ) this.keepUnder( this.zoomAnchor, this.zoomNdcX, this.zoomNdcY );
		if ( swipe ) this.keepUnder( swipe, this.ndcX( this.scrollAtX - this.scrollX ), this.ndcY( this.scrollAtY - this.scrollY ) );
		this.scrollX = this.scrollY = 0;
		if ( drag?.mode === 'pan' && drag.grab && drag.started ) this.keepUnder( drag.grab, this.ndcX( px ), this.ndcY( py ) );
		if ( ! moving ) return widened;

		// Limits on what the input does (a placement by hand outside them stays): the pivot over the
		// land and its ring of shallows (the hull grown by `reach`), or no farther out than a placement
		// put it; past that it goes on against a growing resistance, at most `softReach` farther
		// (`held`: a drag's pointer keeps pulling it from where the grab would put it, so it does not
		// creep), and springs back once let go (above); the camera above the ground, or no lower.
		const edge = this.stretched ? this.reach : Math.max( this.reach, this.hullDistance( targetX, targetZ ) );
		const { x, y: z } = this.held( target.x, target.z, edge, _held );
		if ( x !== target.x || z !== target.z ) {

			position.x += x - target.x;
			position.z += z - target.z;
			target.x = x;
			target.z = z;
			this.glide.set( 0, 0 );
			this.stretched = true;

		}
		// (a camera placed below its floor may stay as low, not go lower)
		const clearance = this.groundClearance, floorBefore = this.ground.heightAt( positionX, positionZ ) + clearance;
		let floor = this.ground.heightAt( position.x, position.z ) + clearance;
		if ( positionY < floorBefore ) floor = Math.min( floor, positionY );
		if ( position.y < floor && this.enablePan ) {

			_offset.copy( position ).sub( target );
			s.setFromVector3( _offset );
			s.phi = Math.min( s.phi, Math.acos( THREE.MathUtils.clamp( ( floor - target.y ) / s.radius, - 1, 1 ) ) );
			s.makeSafe();
			this.place();

		}
		return true;

	}

	private place(): void {

		_offset.setFromSpherical( this.spherical );
		this.camera.position.copy( this.target ).add( _offset );
		this.camera.lookAt( this.target );

	}

	// Returns whether the fov changed.
	private setFov( fov: number ): boolean {

		if ( fov === this.camera.fov ) return false;
		this.camera.fov = fov;
		this.camera.updateProjectionMatrix();
		return true;

	}

	// Where the pointer was at the frame's sampling time: a sample interval (at most
	// MAX_RESAMPLE_DELAY) before its vblank, between the two samples around it. The newest sample's
	// age at a frame varies by up to a sample interval (a 125 Hz mouse's 8 ms against a 16.7 ms
	// frame: a frame now and then took a third more or less of the motion), so a steady drag moved
	// the view in uneven steps; at a fixed delay it moves by the same amount every frame, at the
	// cost of that delay (as Android resamples touch input). Without a vblank, the newest sample.
	private pointerAt( d: Drag, time: number ): [ number, number ] {

		const s = d.samples, n = s.length / 3, newest = s[ ( n - 1 ) * 3 ];
		const delayed = this.resample && Number.isFinite( time ) ? time - Math.min( d.interval, MAX_RESAMPLE_DELAY ) : Infinity;
		// never back before what a frame already showed (a settle between frames takes the newest)
		const t = Math.max( delayed, d.usedTime );
		if ( t >= newest ) {

			d.usedTime = newest;
			return [ d.x, d.y ];

		}
		d.usedTime = t;
		for ( let i = n - 2; i >= 0; i -- ) {

			if ( s[ i * 3 ] > t ) continue;
			// a pointer that had rested set out about one sample before it was seen moving
			const t1 = s[ i * 3 + 3 ], t0 = Math.max( s[ i * 3 ], t1 - d.interval );
			const f = t1 > t0 ? Math.max( 0, ( t - t0 ) / ( t1 - t0 ) ) : 1;
			return [ s[ i * 3 + 1 ] + ( s[ i * 3 + 4 ] - s[ i * 3 + 1 ] ) * f, s[ i * 3 + 2 ] + ( s[ i * 3 + 5 ] - s[ i * 3 + 2 ] ) * f ];

		}
		return [ s[ 1 ], s[ 2 ] ];

	}

	// The keys' and the edge's eased motion for one frame: returns the pan (m, x right, y forward).
	private keyFrame( dt: number, k: number ): THREE.Vector2 {

		const keys = this.keys, fast = keys.has( 'ShiftLeft' ) || keys.has( 'ShiftRight' ) ? 2.5 : 1;
		let x = 0, y = 0;
		for ( const code of keys ) {

			const d = PAN_KEYS[ code ];
			if ( d ) { x += d[ 0 ]; y += d[ 1 ]; }

		}
		if ( this.edgePan && ! this.drag && Number.isFinite( this.hoverX ) ) {

			const edge = 12, w = this.element.clientWidth, h = this.element.clientHeight;
			if ( this.hoverX < edge ) x -= 1; else if ( this.hoverX > w - edge ) x += 1;
			if ( this.hoverY < edge ) y += 1; else if ( this.hoverY > h - edge ) y -= 1;

		}
		const length = Math.hypot( x, y );
		const speed = this.keyPanSpeed * this.camera.position.distanceTo( this.target ) * fast;
		const vx = length > 0 ? x / length * speed : 0, vy = length > 0 ? y / length * speed : 0;
		this.keyPan.x += ( vx - this.keyPan.x ) * k;
		this.keyPan.y += ( vy - this.keyPan.y ) * k;
		if ( this.keyPan.lengthSq() < 1e-6 ) this.keyPan.set( 0, 0 );
		const turn = ( Number( keys.has( 'KeyQ' ) ) - Number( keys.has( 'KeyE' ) ) ) * this.keyTurnSpeed * fast;
		const tilt = ( Number( keys.has( 'KeyG' ) ) - Number( keys.has( 'KeyT' ) ) ) * this.keyTiltSpeed * fast;
		const zoom = ( Number( keys.has( 'Minus' ) || keys.has( 'NumpadSubtract' ) ) - Number( keys.has( 'Equal' ) || keys.has( 'NumpadAdd' ) ) ) * this.keyZoomSpeed * fast;
		this.keyTurn += ( turn - this.keyTurn ) * k;
		this.keyTilt += ( tilt - this.keyTilt ) * k;
		this.keyZoom += ( zoom - this.keyZoom ) * k;
		if ( Math.abs( this.keyTurn ) < 1e-4 ) this.keyTurn = 0;
		if ( Math.abs( this.keyTilt ) < 1e-4 ) this.keyTilt = 0;
		if ( Math.abs( this.keyZoom ) < 1e-4 ) this.keyZoom = 0;
		// the glides after a release slow down by the same clock
		const decay = this.enableDamping ? Math.exp( - dt / this.glideTime ) : 0;
		this.glide.multiplyScalar( decay );
		this.glideTurn *= decay;
		if ( this.glide.lengthSq() < 1e-4 ) this.glide.set( 0, 0 );
		if ( Math.abs( this.glideTurn ) < 1e-3 ) this.glideTurn = 0;
		return _pan.set( this.keyPan.x * dt, this.keyPan.y * dt );

	}

	private stopMotion(): void {

		this.turn = this.tilt = this.pinch = this.wheel = this.zoomLeft = 0;
		this.scrollX = this.scrollY = 0;
		this.glide.set( 0, 0 );
		this.glideTurn = 0;
		this.keyPan.set( 0, 0 );
		this.keyTurn = this.keyTilt = this.keyZoom = 0;
		this.zoomAnchored = false;

	}

	// The point a new zoom closes in on: the ground under the pointer, else the pivot.
	private anchorZoom(): void {

		this.zoomAnchored = Number.isFinite( this.zoomAtX ) && this.groundAt( this.zoomAtX, this.zoomAtY, this.zoomAnchor ) !== null;
		this.zoomNdcX = this.ndcX( this.zoomAtX );
		this.zoomNdcY = this.ndcY( this.zoomAtY );

	}

	// ------------------------------------------------------------------ rays

	private ndcX( x: number ): number { return x / Math.max( this.element.clientWidth, 1 ) * 2 - 1; }
	private ndcY( y: number ): number { return 1 - y / Math.max( this.element.clientHeight, 1 ) * 2; }

	// The direction through ( ndcX, ndcY ) from the camera as it now stands.
	private ray( ndcX: number, ndcY: number, out: THREE.Vector3 ): THREE.Vector3 {

		const camera = this.camera;
		const tan = Math.tan( THREE.MathUtils.degToRad( camera.fov ) / 2 ) / camera.zoom;
		return out.set( ndcX * tan * camera.aspect, ndcY * tan, - 1 ).applyQuaternion( camera.quaternion ).normalize();

	}

	// The ground under the canvas point ( x, y ) seen from the camera as it now stands, or null.
	private groundAt( x: number, y: number, out: THREE.Vector3 ): THREE.Vector3 | null {

		this.ray( this.ndcX( x ), this.ndcY( y ), _dir );
		return this.ground.intersect( this.camera.position, _dir, this.maxDistance * 4, out );

	}

	// Moves the camera and pivot sideways so the ray through ( ndcX, ndcY ) meets `point`'s level at
	// `point`: the exact solution, as a sideways move keeps the view's direction.
	private keepUnder( point: THREE.Vector3, ndcX: number, ndcY: number ): void {

		const position = this.camera.position;
		this.ray( ndcX, ndcY, _dir );
		if ( _dir.y > - 1e-4 ) return;
		const t = ( point.y - position.y ) / _dir.y;
		if ( ! ( t > 0 ) || t > this.maxDistance * 4 ) return;
		const dx = point.x - ( position.x + _dir.x * t ), dz = point.z - ( position.z + _dir.z * t );
		position.x += dx; position.z += dz;
		this.target.x += dx; this.target.z += dz;

	}

	// ------------------------------------------------------------------ pointer

	private canvasPoint( event: { clientX: number; clientY: number } ): [ number, number ] {

		const r = this.element.getBoundingClientRect();
		return [ event.clientX - r.left, event.clientY - r.top ];

	}

	private onPointerDown = ( event: PointerEvent ): void => {

		if ( ! this.listening || this.drag ) return;
		const left = event.button === 0, right = event.button === 2 || event.button === 1;
		if ( ! left && ! right ) return;
		event.preventDefault();
		// returning to the canvas releases a form field's focus, so the keys work again
		if ( this.page.activeElement instanceof HTMLElement && isCameraInputTarget( this.page.activeElement ) ) this.page.activeElement.blur();
		// a press holds the view: the glides stop as a hand stops a sliding map
		this.glide.set( 0, 0 );
		this.glideTurn = 0;
		const turn = right || event.altKey || event.ctrlKey || ! this.enablePan;
		if ( turn && ! this.enableRotate ) return;
		const [ x, y ] = this.canvasPoint( event );
		this.drag = {
			id: event.pointerId, mode: turn ? 'rotate' : 'pan',
			downX: x, downY: y, x, y, usedX: x, usedY: y,
			grab: null, grabAt: turn ? null : 'down', started: turn, samples: [ event.timeStamp, x, y ], interval: MAX_RESAMPLE_DELAY, usedTime: event.timeStamp,
		};
		try {

			this.element.setPointerCapture( event.pointerId );

		} catch {

			// (a synthetic or already released pointer: the drag works while it stays over the canvas)

		}
		if ( ! turn ) this.element.style.cursor = 'grabbing';

	};

	private onPointerMove = ( event: PointerEvent ): void => {

		const [ hx, hy ] = this.canvasPoint( event );
		this.hoverX = hx;
		this.hoverY = hy;
		const d = this.drag;
		if ( ! this.listening || ! d || event.pointerId !== d.id ) return;
		event.preventDefault();
		// every sample since the last event (the browser hands them over once per frame), and the
		// interval they come at
		const r = this.element.getBoundingClientRect(), samples = d.samples;
		const coalesced = event.getCoalescedEvents?.() ?? [];
		for ( const e of coalesced.length ? coalesced : [ event ] ) {

			const gap = e.timeStamp - samples[ samples.length - 3 ];
			if ( gap <= 0 ) continue;
			if ( gap < 50 ) d.interval += ( gap - d.interval ) * 0.2;
			samples.push( e.timeStamp, e.clientX - r.left, e.clientY - r.top );

		}
		// (the oldest kept is at least the window old, so a frame can still find where a pointer
		// that had rested set out from)
		while ( samples.length > 6 && samples[ 3 ] < event.timeStamp - RELEASE_WINDOW ) samples.splice( 0, 3 );
		d.x = hx;
		d.y = hy;
		if ( ! d.started && Math.hypot( hx - d.downX, hy - d.downY ) >= CLICK_SLOP ) d.started = true;
		this.newestInput = event.timeStamp;

	};

	private onPointerUp = ( event: PointerEvent ): void => {

		const d = this.drag;
		if ( ! d || event.pointerId !== d.id ) return;
		if ( this.enableDamping && d.started ) this.release( d, event.timeStamp );
		this.endDrag();
		// the next frame still takes the drag to where it was let go
		if ( d.started ) this.ending = d;

	};

	private onPointerCancel = ( event: PointerEvent ): void => {

		if ( this.drag && event.pointerId === this.drag.id ) this.endDrag();

	};

	private onPointerLeave = (): void => {

		this.hoverX = this.hoverY = NaN;

	};

	// A drag let go while moving glides on: its velocity over the last samples, unless the pointer
	// had come to rest before the release.
	private release( d: Drag, time: number ): void {

		const s = d.samples, n = s.length / 3;
		if ( n < 2 || time - s[ ( n - 1 ) * 3 ] > RELEASE_STILL ) return;
		// over the window's samples (the oldest kept may be older)
		let i0 = 0;
		while ( i0 < n - 2 && s[ i0 * 3 ] < s[ ( n - 1 ) * 3 ] - RELEASE_WINDOW ) i0 ++;
		const t0 = s[ i0 * 3 ], t1 = s[ ( n - 1 ) * 3 ], dt = ( t1 - t0 ) / 1000;
		if ( dt < 0.008 ) return;
		const x0 = s[ i0 * 3 + 1 ], y0 = s[ i0 * 3 + 2 ], x1 = s[ ( n - 1 ) * 3 + 1 ], y1 = s[ ( n - 1 ) * 3 + 2 ];
		if ( d.mode === 'rotate' ) {

			const h = Math.max( this.element.clientHeight, 1 );
			this.glideTurn = THREE.MathUtils.clamp( - ( x1 - x0 ) / dt * this.turnPerHeight / h, - 2 * Math.PI, 2 * Math.PI );

		} else if ( d.grab ) {

			// the ground's velocity under the pointer, on the grabbed level; the camera moves against it
			const a = this.levelAt( x0, y0, d.grab.y, _a ), b = this.levelAt( x1, y1, d.grab.y, _b );
			if ( ! a || ! b ) return;
			const vx = - ( b.x - a.x ) / dt, vz = - ( b.z - a.z ) / dt;
			// into the view's frame (x right, y forward)
			const theta = this.spherical.theta, sin = Math.sin( theta ), cos = Math.cos( theta );
			this.glide.set( vx * cos - vz * sin, - vx * sin - vz * cos );
			const max = 2 * this.camera.position.distanceTo( this.target );
			if ( this.glide.length() > max ) this.glide.setLength( max );

		}

	}

	// Where the ray through the canvas point meets the level y.
	private levelAt( x: number, y: number, level: number, out: THREE.Vector3 ): THREE.Vector3 | null {

		this.ray( this.ndcX( x ), this.ndcY( y ), _dir );
		const position = this.camera.position;
		if ( _dir.y > - 1e-4 ) return null;
		const t = ( level - position.y ) / _dir.y;
		return t > 0 ? out.copy( _dir ).multiplyScalar( t ).add( position ) : null;

	}

	private endDrag(): void {

		const d = this.drag;
		this.drag = null;
		if ( d && this.element.hasPointerCapture( d.id ) ) this.element.releasePointerCapture( d.id );
		if ( this.element.style.cursor === 'grabbing' ) this.element.style.cursor = '';

	}

	private onContextMenu = ( event: MouseEvent ): void => {

		if ( this.listening ) event.preventDefault();

	};

	// ------------------------------------------------------------------ wheel and gestures

	private onWheel = ( event: WheelEvent ): void => {

		if ( ! this.listening ) return;
		// (a pinch would zoom the page otherwise)
		event.preventDefault();
		const [ x, y ] = this.canvasPoint( event );
		const type = this.classify( event );
		this.newestInput = event.timeStamp;
		const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.element.clientHeight : 1;
		const dx = event.deltaX * lines, dy = event.deltaY * lines;
		if ( type === 'pinch' ) {

			// Chrome's pinch: deltaY = -100 ln( scale ), so the view scales with the fingers
			this.pinch += THREE.MathUtils.clamp( dy / 100, - 1, 1 );
			this.zoomAtX = x;
			this.zoomAtY = y;

		} else if ( type === 'trackpad' && event.altKey ) {

			// as a drag the way the fingers move (the deltas run against them)
			this.turn -= dx;
			this.tilt -= dy;

		} else if ( type === 'trackpad' && this.scrollMode !== 'zoom' ) {

			// the ground follows the fingers, as a page does under natural scrolling
			this.scrollX += dx;
			this.scrollY += dy;
			this.scrollAtX = x;
			this.scrollAtY = y;

		} else if ( type === 'trackpad' ) {

			this.pinch += THREE.MathUtils.clamp( dy / 100, - 1, 1 );
			this.zoomAtX = x;
			this.zoomAtY = y;

		} else if ( this.scrollMode === 'pan' ) {

			this.scrollX += dx;
			this.scrollY += dy;
			this.scrollAtX = x;
			this.scrollAtY = y;

		} else {

			// a wheel's notches, however the platform scales them, glide to their zoom
			const notches = event.deltaMode === 1 ? event.deltaY / 3 : event.deltaMode === 2 ? event.deltaY * 10
				: isMacNotch( event.deltaY ) ? event.deltaY / MAC_WHEEL_NOTCH : event.deltaY / 100;
			this.wheel += THREE.MathUtils.clamp( notches, - 3, 3 ) * this.wheelZoom;
			this.zoomAtX = x;
			this.zoomAtY = y;

		}

	};

	// Whether a wheel event is a pinch, a mouse wheel or a trackpad's two-finger swipe. No browser
	// says which device scrolled. On macOS, Chrome and Safari report a wheel notch as a multiple of
	// MAC_WHEEL_NOTCH (Cocoa's tenth of a line at 40 px a line) and a trackpad's continuous scroll in
	// whole pixels, with the legacy wheelDeltaY three times -deltaY (Chromium's Cocoa event builder:
	// 40 px per wheel tick, 120 per tick in wheelDelta); deltas under 4 px are a trackpad's, as in
	// Mapbox GL's scroll handler; elsewhere a wheel's are whole deltas of 50 px or more (100 a notch
	// on Windows) or a wheelDeltaY in whole ticks of 120. What stays unclear keeps the gesture's
	// earlier verdict (a trackpad's, if new).
	private classify( event: WheelEvent ): 'pinch' | 'wheel' | 'trackpad' {

		const dy = event.deltaY, dx = event.deltaX;
		const legacy = ( event as WheelEvent & { wheelDeltaY?: number } ).wheelDeltaY;
		const continuous = dy !== 0 && legacy === - 3 * dy;
		let type: 'wheel' | 'trackpad' | null = null;
		if ( event.deltaMode !== 0 || ( isMacNotch( dy ) && dx === 0 ) ) type = 'wheel';
		else if ( dx !== 0 || continuous || Math.abs( dy ) < 4 ) type = 'trackpad';
		else if ( ( Number.isInteger( dy ) && Math.abs( dy ) >= 50 ) || ( legacy !== undefined && legacy !== 0 && legacy % 120 === 0 ) ) type = 'wheel';
		// a pinch comes as a wheel with ctrlKey; ctrl with a real wheel zooms by its notches
		if ( event.ctrlKey ) return type === 'wheel' ? 'wheel' : 'pinch';
		const fresh = event.timeStamp - this.lastScroll > GESTURE_GAP;
		this.lastScroll = event.timeStamp;
		if ( type ) this.scrollType = type;
		else if ( fresh ) this.scrollType = 'trackpad';
		return this.scrollType;

	}

	private onGestureStart = ( event: Event & { scale?: number; rotation?: number } ): void => {

		if ( ! this.listening ) return;
		event.preventDefault();
		this.gestureScale = event.scale ?? 1;
		this.gestureRotation = event.rotation ?? 0;

	};

	private onGestureChange = ( event: Event & { scale?: number; rotation?: number; clientX?: number; clientY?: number } ): void => {

		if ( ! this.listening ) return;
		event.preventDefault();
		const scale = event.scale ?? 1, rotation = event.rotation ?? 0;
		this.pinch -= Math.log( scale / this.gestureScale );
		this.turn -= ( rotation - this.gestureRotation ) / 180 * Math.PI / this.turnPerHeight * this.element.clientHeight;
		this.gestureScale = scale;
		this.gestureRotation = rotation;
		if ( event.clientX !== undefined && event.clientY !== undefined ) [ this.zoomAtX, this.zoomAtY ] = this.canvasPoint( event as { clientX: number; clientY: number } );

	};

	// ------------------------------------------------------------------ keys

	private onKeyDown = ( event: KeyboardEvent ): void => {

		if ( ! this.listening ) return;
		if ( event.ctrlKey || event.metaKey || event.altKey || isCameraInputTarget( event.target ) || isCameraInputTarget( this.page.activeElement ) ) {

			this.keys.clear();
			return;

		}
		if ( ! CAMERA_KEYS.has( event.code ) ) return;
		event.preventDefault();
		this.keys.add( event.code );

	};

	private onKeyUp = ( event: KeyboardEvent ): void => {

		this.keys.delete( event.code );

	};

	private onVisibilityChange = (): void => {

		if ( this.page.hidden ) this.clearInput();

	};

	private onFocusIn = ( event: FocusEvent ): void => {

		if ( isCameraInputTarget( event.target ) ) this.clearInput();

	};

}

function isMacNotch( delta: number ): boolean {

	return delta !== 0 && Math.abs( delta ) % MAC_WHEEL_NOTCH === 0;

}
