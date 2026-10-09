import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// OrbitControls whose damping advances once per rendered frame, by the frame's length.
//
// three's OrbitControls damps per `update()` call (a fixed share of the pending rotation, pan and
// zoom each time), and its pointer, wheel and key handlers call `update()` on every event. With
// input events at the display's refresh (the browser dispatches them once per refresh) and frames
// at 60 Hz, a frame took one, two or three damping steps by chance, so while the camera was dragged
// its steps from frame to frame alternated by about half, at a steady pace and a steady drag. Here
// the handlers only gather their input (their `update()` returns at once while damping is on) and
// the frame loop applies it with `advance()`, damped by the frame's interval: the camera glides the
// same whatever the frame rate, and a frame that comes late moves it as far as the time it took.
export class OrbitFrameControls extends OrbitControls {

	/** The share of the pending motion applied per 60 Hz frame. */
	damping = 0.06;
	private stepping = false;

	override update( deltaTime: number | null = null ): boolean {

		if ( this.enableDamping && ! this.stepping ) return false;
		return super.update( deltaTime );

	}

	/** One frame of `dt` seconds: applies the input gathered since the last frame, damped by the
	 * frame's length (0 only applies the limits). */
	advance( dt: number ): boolean {

		this.dampingFactor = 1 - Math.pow( 1 - this.damping, Math.max( dt, 0 ) * 60 );
		this.stepping = true;
		try {

			return super.update();

		} finally {

			this.stepping = false;

		}

	}

	/** Applies all pending motion at once (no damping), before the camera is placed by hand. */
	settle(): void {

		const damping = this.enableDamping;
		this.enableDamping = false;
		super.update();
		this.enableDamping = damping;

	}

}
