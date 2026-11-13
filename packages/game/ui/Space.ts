import * as THREE from 'three/webgpu';
import { css } from './dom.ts';

// The interface's elements that stand in the world, laid into the scene by a matrix3d.
//
// The interface's elements that stand in the world (docs/design/ui.md, Screen and world): the ring at the
// feet, the thinking ring, the speech over a head and the player's words in flight. Each is a DOM
// element laid into the scene through the game's camera: a matrix3d carries its own pixels (x to the
// right, y down, from its top left corner) through its frame in the world (the point that corner
// stands at, and the world's step for a pixel of it along x and along y), the camera's view and
// projection and the interface's viewport, and the browser divides by w, so it is drawn in the
// camera's perspective. It stays DOM: its type is drawn at the screen's own resolution in the
// palette's exact colours, and the canvas's pixels never change for it (a paused frame stays
// exact). It is flat and never sorted or hidden by the scene: it lies over the canvas as the rest of
// the interface does.
//
// Rules: `update` once a frame before anything is placed (the camera's matrices and the
// interface's size are read there); an element placed here has `transform-origin: 0 0` at the top
// left of its parent, which spans the interface (`.pl-space`), and is hidden while it stands at or
// behind the camera's near plane, where a perspective division would turn it inside out.

const _p = new THREE.Vector4(), _o = new THREE.Vector3(), _m = new THREE.Matrix4(), _w = new THREE.Matrix4();
const _q = new THREE.Quaternion(), _e = new THREE.Euler();

export class Space {

	private readonly camera: THREE.PerspectiveCamera;
	// world to the interface's pixels (homogeneous: x and y times w, w the view depth)
	private readonly screen = new THREE.Matrix4();
	private w = 1;
	private h = 1;
	/** the camera's place and its axes in the world this frame: right, up (on screen), and toward
	 * the viewer (out of the screen) */
	readonly eye = new THREE.Vector3();
	readonly right = new THREE.Vector3();
	readonly up = new THREE.Vector3();
	readonly back = new THREE.Vector3();
	private readonly turn = new THREE.Quaternion();

	constructor( camera: THREE.PerspectiveCamera ) {

		this.camera = camera;

	}

	/** Once a frame: the camera as it draws, over an interface of w x h pixels. */
	update( w: number, h: number ): void {

		const camera = this.camera;
		camera.updateMatrixWorld();
		this.w = w;
		this.h = h;
		const viewport = _m.set(
			w / 2, 0, 0, w / 2,
			0, - h / 2, 0, h / 2,
			0, 0, 0, 0,
			0, 0, 0, 1 );
		this.screen.multiplyMatrices( viewport, camera.projectionMatrix ).multiply( camera.matrixWorldInverse );
		camera.matrixWorld.extractBasis( this.right, this.up, this.back );
		this.eye.setFromMatrixPosition( camera.matrixWorld );
		this.turn.setFromRotationMatrix( camera.matrixWorld );

	}

	/** A point's distance in front of the camera, along its view (negative: behind it). */
	depth( p: THREE.Vector3 ): number {

		return _o.subVectors( p, this.eye ).dot( this.back ) * - 1;

	}

	/** Interface pixels per metre across the view at a depth. */
	pixelsPerMetre( depth: number ): number {

		return this.camera.projectionMatrix.elements[ 5 ] * this.h / 2 / Math.max( depth, 1e-6 );

	}

	/** A point on screen (interface pixels), into `out` (x, y; z its depth); false when at or behind
	 * the near plane. */
	project( p: THREE.Vector3, out: THREE.Vector3 ): boolean {

		_p.set( p.x, p.y, p.z, 1 ).applyMatrix4( this.screen );
		if ( _p.w <= this.camera.near ) return false;
		out.set( _p.x / _p.w, _p.y / _p.w, _p.w );
		return true;

	}

	/** The world point at a depth in front of the camera seen at ( x, y ) on screen (interface pixels). */
	unproject( x: number, y: number, depth: number, out: THREE.Vector3 ): THREE.Vector3 {

		out.set( x / this.w * 2 - 1, 1 - y / this.h * 2, 0.5 ).unproject( this.camera ).sub( this.eye );
		return out.multiplyScalar( depth / Math.max( - out.dot( this.back ), 1e-9 ) ).add( this.eye );

	}

	/** The axes of a face toward the viewer, turned by `yaw` (about its up: its right edge comes
	 * toward the viewer), `pitch` (about its right: its top comes toward the viewer) and `roll`
	 * (clockwise in its plane), in radians: its x and its y (down) as unit vectors, into `ax`, `ay`. */
	facing( yaw: number, pitch: number, roll: number, ax: THREE.Vector3, ay: THREE.Vector3 ): void {

		_q.setFromEuler( _e.set( pitch, - yaw, - roll, 'YXZ' ) ).premultiply( this.turn );
		ax.set( 1, 0, 0 ).applyQuaternion( _q );
		ay.set( 0, - 1, 0 ).applyQuaternion( _q );

	}

	/** Lay an element `width` x `height` pixels of its own with its middle at `centre`, its x and y
	 * running along `ax` and `ay` (world metres per pixel of it). False, and hidden, when its middle
	 * is not in front of the near plane. */
	place( e: HTMLElement | SVGElement, centre: THREE.Vector3, ax: THREE.Vector3, ay: THREE.Vector3, width: number, height: number ): boolean {

		const near = this.depth( centre ) > this.camera.near * 1.5;
		css( e, 'visibility', near ? '' : 'hidden' );
		if ( ! near ) return false;
		// its frame: its top left corner, its pixel steps (its own z is always 0)
		_o.copy( centre ).addScaledVector( ax, - width / 2 ).addScaledVector( ay, - height / 2 );
		_w.set(
			ax.x, ay.x, 0, _o.x,
			ax.y, ay.y, 0, _o.y,
			ax.z, ay.z, 0, _o.z,
			0, 0, 0, 1 );
		const m = _w.premultiply( this.screen ).elements;
		// the z row kept as its own z, so the matrix stays invertible (one that is not draws nothing)
		m[ 2 ] = 0;
		m[ 6 ] = 0;
		m[ 10 ] = 1;
		m[ 14 ] = 0;
		let s = 'matrix3d(';
		for ( let k = 0; k < 16; k ++ ) s += ( k ? ',' : '' ) + ( Math.abs( m[ k ] ) < 1e-12 ? 0 : m[ k ].toPrecision( 7 ) );
		css( e, 'transform', s + ')' );
		return true;

	}

}
