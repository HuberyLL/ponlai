import * as THREE from 'three/webgpu';
import { isCameraInputTarget } from './FreeCameraControls.ts';
import { GROWTH, type LandLattice } from '../world/IslandGrowth.ts';
import { ISLAND_TOP } from '../world/WorldShapes.ts';
import { SHELF_REACH } from '../world/Bathymetry.ts';

// The island view's framing: the camera pose that just holds the whole island and the ring of
// shallows round it, centred in the frame, at the view's heading and tilt, whatever size the land
// has grown to. It is the island camera's pose when the hand does not move it (main.ts
// `placeOrbit`), so the view a tuning session looks at is the same on every load of the same land
// and query.
//
// - What is framed derives from the land alone: the convex hull of its lattice cells (`landOutline`)
//   at the meadow's height, and that hull grown by the shelf's reach (Bathymetry.ts SHELF_REACH, the
//   ring where the floor is the shelf's) at sea level. Only the hull's vertices matter to a frame,
//   and the grown hull's support in any direction is the hull's plus the reach, so the fit is exact
//   and needs no samples of the ring.
// - The fit (`frameIsland`) is closed-form for a heading: the camera looks at the land's centre (its
//   hull's box centre at the meadow's height), which is its pivot, and stands back along the view's
//   direction just far enough that every side of the frustum clears the framed set. It stands at
//   the farthest of these distances over all headings (sampled every 2 degrees), so a turn keeps
//   the distance and the island fits from every side (a heading's own fit, if farther between two
//   samples, wins). Fitting the frustum's sides to the set alone left the island above the frame's
//   centre: in perspective the near ring of shallows takes more of the frame than the far one.
// - A margin of FRAME_MARGIN of the half frame stays free on every side.
// - The view starts nearer than this framing: where it frames the land alone from its own heading
//   (`landFitDistance`).
// - When the land grows the camera glides to the new framing (`FramingGlide`, on the scene clock's
//   step, eased in and out over `duration`); a paused page takes it at once (main.ts).
// - The only input is a turn about the pivot and a zoom (`IslandTurn`): Q / E held, or a right or
//   middle drag across the canvas, turn at a constant distance; the wheel (or a pinch) zooms in from
//   that distance, the farthest, to the one that frames the land alone without its shallows from
//   every side, the nearest, so the whole island always stays in view. The zoom is kept as a share
//   of that range (on the log of the distance), so it holds through a turn, a growth step and a
//   resize; the key R returns to the query's heading and the farthest zoom. The page sets
//   `wheelZoom` to 0: the island view never zooms in past its framing (main.ts `islandNearest`).

/** The share of the half frame kept free round the framed island. */
export const FRAME_MARGIN = 0.04;
/** The share of the half frame kept free round the land at the view's start (`landFitDistance`):
 * wider, as what stands on the land (the bamboo, some 13 m tall) reaches past its outline. */
export const START_MARGIN = 0.16;

const CELL = GROWTH.cell, X0 = - GROWTH.half;

/** The convex hull of the land's cells, as x, z pairs counter-clockwise seen from above (m). */
export function landOutline( land: LandLattice ): number[] {

	// each row's outermost cells' corners: only they can be vertices of the hull
	const w = land.cells(), points: [ number, number ][] = [];
	for ( let j = w.j0; j < w.j1; j ++ ) {

		let i0 = w.i0;
		while ( i0 < w.i1 && ! land.has( i0, j ) ) i0 ++;
		if ( i0 === w.i1 ) continue;
		let i1 = w.i1 - 1;
		while ( ! land.has( i1, j ) ) i1 --;
		const z0 = X0 + j * CELL, z1 = z0 + CELL, xa = X0 + i0 * CELL, xb = X0 + ( i1 + 1 ) * CELL;
		points.push( [ xa, z0 ], [ xa, z1 ], [ xb, z0 ], [ xb, z1 ] );

	}
	return convexHull( points );

}

// Andrew's monotone chain; collinear points are dropped.
function convexHull( points: [ number, number ][] ): number[] {

	points.sort( ( a, b ) => a[ 0 ] - b[ 0 ] || a[ 1 ] - b[ 1 ] );
	const cross = ( o: number[], a: number[], b: number[] ) => ( a[ 0 ] - o[ 0 ] ) * ( b[ 1 ] - o[ 1 ] ) - ( a[ 1 ] - o[ 1 ] ) * ( b[ 0 ] - o[ 0 ] );
	const lower: [ number, number ][] = [], upper: [ number, number ][] = [];
	for ( const p of points ) {

		while ( lower.length >= 2 && cross( lower[ lower.length - 2 ], lower[ lower.length - 1 ], p ) <= 0 ) lower.pop();
		lower.push( p );

	}
	for ( let k = points.length - 1; k >= 0; k -- ) {

		const p = points[ k ];
		while ( upper.length >= 2 && cross( upper[ upper.length - 2 ], upper[ upper.length - 1 ], p ) <= 0 ) upper.pop();
		upper.push( p );

	}
	lower.pop();
	upper.pop();
	return lower.concat( upper ).flat();

}

export interface FramingView {
	/** the view's tilt from straight down and its heading, as three's spherical coordinates (rad) */
	polar: number;
	azimuth: number;
	/** the camera's vertical fov (degrees) and aspect */
	fov: number;
	aspect: number;
}

const _r = new THREE.Vector3(), _u = new THREE.Vector3(), _f = new THREE.Vector3(), _w = new THREE.Vector3(), _pivot = new THREE.Vector3();

// headings the distance is fitted at (every 2 degrees); between two, the margin holds the set
const HEADINGS = 180;
// the distance found for an outline, by tilt, fov and aspect: a turn asks for it every frame
const distances = new WeakMap<readonly number[], Map<string, number>>();

// The land's centre, the pivot: its hull's box centre at the meadow's height.
function landCentre( outline: readonly number[], out: THREE.Vector3 ): THREE.Vector3 {

	let x0 = Infinity, x1 = - Infinity, z0 = Infinity, z1 = - Infinity;
	for ( let k = 0; k < outline.length; k += 2 ) {

		x0 = Math.min( x0, outline[ k ] ); x1 = Math.max( x1, outline[ k ] );
		z0 = Math.min( z0, outline[ k + 1 ] ); z1 = Math.max( z1, outline[ k + 1 ] );

	}
	return out.set( ( x0 + x1 ) / 2, ISLAND_TOP, ( z0 + z1 ) / 2 );

}

// Sets the view's axes (`_f` forward, `_r` right, `_u` up, as `lookAt` makes them for an offset
// along ( polar, azimuth )) and returns how far back from the pivot the camera must stand for
// every framed point to fall inside the frame from this heading.
function fitDistance( outline: readonly number[], pivot: THREE.Vector3, view: FramingView, azimuth: number, reach: number, margin = FRAME_MARGIN ): number {

	const sp = Math.sin( view.polar ), cp = Math.cos( view.polar ), sa = Math.sin( azimuth ), ca = Math.cos( azimuth );
	_f.set( - sp * sa, - cp, - sp * ca );
	_r.set( ca, 0, - sa );
	_u.crossVectors( _r, _f );
	// the framed set's greatest extent along w: the hull at the meadow's height, the hull grown by
	// `reach` at sea level
	const support = ( w: THREE.Vector3 ) => {

		let m = - Infinity;
		for ( let k = 0; k < outline.length; k += 2 ) m = Math.max( m, w.x * outline[ k ] + w.z * outline[ k + 1 ] );
		return m + Math.max( w.y * ISLAND_TOP, reach * Math.hypot( w.x, w.z ) );

	};
	// c = pivot - s f. A side's plane through the camera, ( ±axis - t f ) · ( q - c ) <= 0 for every
	// framed q, holds once s >= ( support - w · pivot ) / t, as w · f = -t.
	const tan = Math.tan( THREE.MathUtils.degToRad( view.fov ) / 2 ) * ( 1 - margin );
	const tH = tan * view.aspect, tV = tan;
	const back = ( w: THREE.Vector3, t: number ) => ( support( w ) - w.dot( pivot ) ) / t;
	return Math.max(
		back( _w.copy( _r ).addScaledVector( _f, - tH ), tH ), back( _w.copy( _r ).negate().addScaledVector( _f, - tH ), tH ),
		back( _w.copy( _u ).addScaledVector( _f, - tV ), tV ), back( _w.copy( _u ).negate().addScaledVector( _f, - tV ), tV ),
	);

}

// The distance that frames the hull grown by `reach` from every heading (sampled), and from the
// view's own heading.
function fitAllHeadings( outline: readonly number[], pivot: THREE.Vector3, view: FramingView, reach: number ): number {

	let byView = distances.get( outline );
	if ( ! byView ) distances.set( outline, byView = new Map() );
	const key = `${ view.polar },${ view.fov },${ view.aspect },${ reach }`;
	let s = byView.get( key );
	if ( s === undefined ) {

		s = 0;
		for ( let k = 0; k < HEADINGS; k ++ ) s = Math.max( s, fitDistance( outline, _pivot.copy( pivot ), view, k * 2 * Math.PI / HEADINGS, reach ) );
		byView.set( key, s );

	}
	// (the heading's own fit too, so it never falls outside the frame between two sampled headings)
	return Math.max( s, fitDistance( outline, pivot, view, view.azimuth, reach ) );

}

/** The camera position and pivot that frame `outline` (landOutline) from `view`'s heading and tilt:
 * at `zoom` 0 the land and its ring of shallows, at 1 the land alone, from every heading (the
 * distance between eased on its log). */
export function frameIsland( outline: readonly number[], view: FramingView, position: THREE.Vector3, pivot: THREE.Vector3, zoom = 0 ): void {

	landCentre( outline, pivot );
	const near = zoom > 0 ? fitAllHeadings( outline, pivot, view, 0 ) : 0;
	const far = fitAllHeadings( outline, pivot, view, SHELF_REACH );
	const s = zoom > 0 ? far * Math.pow( Math.min( near / far, 1 ), zoom ) : far;
	// (the axes are the last heading fitted: the view's own)
	position.copy( pivot ).addScaledVector( _f, - s );

}

/** How far back from the land's centre the camera stands to frame the land alone (without its
 * ring of shallows) from `view`'s own heading: the island view's start (main.ts `placeOrbit`). A
 * turn keeps that distance, so from another heading a long island may reach past the frame's edge. */
export function landFitDistance( outline: readonly number[], view: FramingView ): number {

	return fitDistance( outline, landCentre( outline, _pivot ), view, view.azimuth, 0, START_MARGIN );

}

/** The camera's glide from one framing to the next, on the scene clock's step. */
export class FramingGlide {

	/** The glide's length (s). */
	duration = 1.6;
	private elapsed = Infinity;
	private readonly fromPosition = new THREE.Vector3();
	private readonly fromPivot = new THREE.Vector3();
	private readonly toPosition = new THREE.Vector3();
	private readonly toPivot = new THREE.Vector3();

	get running(): boolean { return this.elapsed < this.duration; }

	start( position: THREE.Vector3, pivot: THREE.Vector3, toPosition: THREE.Vector3, toPivot: THREE.Vector3 ): void {

		this.fromPosition.copy( position );
		this.fromPivot.copy( pivot );
		this.toPosition.copy( toPosition );
		this.toPivot.copy( toPivot );
		this.elapsed = 0;

	}

	stop(): void {

		this.elapsed = Infinity;

	}

	/** Moves the glide on by `dt` seconds and writes its pose; returns whether it ran. */
	advance( dt: number, position: THREE.Vector3, pivot: THREE.Vector3 ): boolean {

		if ( ! this.running ) return false;
		this.elapsed += dt;
		const u = Math.min( this.elapsed / this.duration, 1 ), k = u * u * u * ( u * ( u * 6 - 15 ) + 10 );
		// position and pivot together, so the view's direction holds through the glide
		position.lerpVectors( this.fromPosition, this.toPosition, k );
		pivot.lerpVectors( this.fromPivot, this.toPivot, k );
		return true;

	}

}

/** The island view's turn about its pivot, Q / E held (eased in and out) or a right or middle drag
 * across the canvas (a window's width a half turn), and its zoom, the wheel (a notch an eighth of
 * the range, glided in). Takes no input while disabled. */
export class IslandTurn {

	/** The keys' turn (rad/s) and how they ease in and out (time constant, s). */
	keySpeed = THREE.MathUtils.degToRad( 60 );
	keyTime = 0.1;
	/** The turn per window width dragged (rad). */
	turnPerWidth = Math.PI;
	private active = false;
	private readonly keys = new Set<string>();
	private speed = 0;
	private dragId: number | null = null;
	private dragX = 0;
	private dragged = 0;
	/** A wheel notch's zoom (share of the range) and the time constant of its glide (s). */
	wheelZoom = 0.125;
	zoomTime = 0.08;
	private zoomLeft = 0;

	constructor( private readonly element: HTMLElement ) {

		const view = element.ownerDocument.defaultView as Window; // the page the element is in
		element.addEventListener( 'wheel', this.onWheel, { passive: false } );
		element.addEventListener( 'pointerdown', this.onPointerDown );
		element.addEventListener( 'pointermove', this.onPointerMove );
		element.addEventListener( 'pointerup', this.onPointerUp );
		element.addEventListener( 'pointercancel', this.onPointerUp );
		element.addEventListener( 'contextmenu', this.onContextMenu );
		view.addEventListener( 'keydown', this.onKeyDown );
		view.addEventListener( 'keyup', this.onKeyUp );
		view.addEventListener( 'blur', this.clear );

	}

	get enabled(): boolean { return this.active; }
	set enabled( value: boolean ) {

		if ( value === this.active ) return;
		this.clear();
		this.active = value;

	}

	/** The turn to add to the view's azimuth this frame of `dt` seconds (rad). */
	advance( dt: number ): number {

		const target = ( Number( this.keys.has( 'KeyQ' ) ) - Number( this.keys.has( 'KeyE' ) ) ) * this.keySpeed;
		this.speed += ( target - this.speed ) * ( 1 - Math.exp( - dt / this.keyTime ) );
		if ( Math.abs( this.speed ) < 1e-4 ) this.speed = 0;
		const turn = this.speed * dt - this.dragged * this.turnPerWidth / Math.max( this.element.clientWidth, 1 );
		this.dragged = 0;
		return turn;

	}

	/** The zoom to add this frame of `dt` seconds (share of the range, + nearer). */
	zoom( dt: number ): number {

		let step = this.zoomLeft * ( 1 - Math.exp( - dt / this.zoomTime ) );
		if ( Math.abs( this.zoomLeft - step ) < 1e-4 ) step = this.zoomLeft;
		this.zoomLeft -= step;
		return step;

	}

	/** Drops a zoom still gliding (at an end of the range). */
	stopZoom(): void {

		this.zoomLeft = 0;

	}

	private onWheel = ( event: WheelEvent ): void => {

		if ( ! this.active ) return;
		// (a pinch would zoom the page otherwise)
		event.preventDefault();
		const dy = event.deltaY;
		// in notches: lines, pages, a macOS wheel notch (multiples of 4.000244140625 px), else 100 px
		const notches = event.deltaMode === 1 ? dy / 3 : event.deltaMode === 2 ? dy * 10
			: dy !== 0 && Math.abs( dy ) % 4.000244140625 === 0 ? dy / 4.000244140625 : dy / 100;
		this.zoomLeft -= THREE.MathUtils.clamp( notches, - 3, 3 ) * this.wheelZoom;

	};

	private clear = (): void => {

		this.keys.clear();
		this.speed = this.dragged = this.zoomLeft = 0;
		if ( this.dragId !== null && this.element.hasPointerCapture( this.dragId ) ) this.element.releasePointerCapture( this.dragId );
		this.dragId = null;

	};

	private onPointerDown = ( event: PointerEvent ): void => {

		if ( ! this.active || this.dragId !== null || ( event.button !== 1 && event.button !== 2 ) ) return;
		event.preventDefault();
		this.dragId = event.pointerId;
		this.dragX = event.clientX;
		try {

			this.element.setPointerCapture( event.pointerId );

		} catch {

			// (a synthetic pointer: the drag works while it stays over the canvas)

		}

	};

	private onPointerMove = ( event: PointerEvent ): void => {

		if ( event.pointerId !== this.dragId ) return;
		this.dragged += event.clientX - this.dragX;
		this.dragX = event.clientX;

	};

	private onPointerUp = ( event: PointerEvent ): void => {

		if ( event.pointerId !== this.dragId ) return;
		if ( this.element.hasPointerCapture( event.pointerId ) ) this.element.releasePointerCapture( event.pointerId );
		this.dragId = null;

	};

	private onContextMenu = ( event: MouseEvent ): void => {

		if ( this.active ) event.preventDefault();

	};

	private onKeyDown = ( event: KeyboardEvent ): void => {

		if ( ! this.active || event.ctrlKey || event.metaKey || event.altKey || isCameraInputTarget( event.target ) ) return;
		if ( event.code !== 'KeyQ' && event.code !== 'KeyE' ) return;
		event.preventDefault();
		this.keys.add( event.code );

	};

	private onKeyUp = ( event: KeyboardEvent ): void => {

		this.keys.delete( event.code );

	};

}
