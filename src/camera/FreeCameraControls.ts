import * as THREE from 'three/webgpu';

const MOVE_KEYS = new Set( [ 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight' ] );
const PITCH_LIMIT = Math.PI / 2 - 0.01;

export function isCameraInputTarget( target: EventTarget | null ): boolean {

	return target instanceof Element && target.closest( 'input, textarea, select, button, form, [contenteditable]:not([contenteditable="false"]), .lil-gui' ) !== null;

}

/** Free flight keeps navigation independent of the scene clock and never captures the pointer lock. */
export class FreeCameraControls {

	speed = 12;
	private active = false;
	private readonly keys = new Set<string>();
	private readonly direction = new THREE.Vector3();
	private readonly rotation = new THREE.Euler( 0, 0, 0, 'YXZ' );
	private pointerId: number | null = null;
	private pointerX = 0;
	private pointerY = 0;

	constructor( private readonly camera: THREE.Camera, private readonly element: HTMLCanvasElement ) {

		window.addEventListener( 'keydown', this.onKeyDown );
		window.addEventListener( 'keyup', this.onKeyUp );
		window.addEventListener( 'blur', this.clearInput );
		document.addEventListener( 'visibilitychange', this.onVisibilityChange );
		document.addEventListener( 'focusin', this.onFocusIn );
		element.addEventListener( 'pointerdown', this.onPointerDown );
		element.addEventListener( 'pointermove', this.onPointerMove );
		element.addEventListener( 'pointerup', this.onPointerEnd );
		element.addEventListener( 'pointercancel', this.onPointerCancel );
		element.addEventListener( 'lostpointercapture', this.onPointerEnd );
		element.addEventListener( 'contextmenu', this.onContextMenu );
		element.addEventListener( 'wheel', this.onWheel, { passive: false } );

	}

	get enabled(): boolean { return this.active; }
	set enabled( value: boolean ) {

		if ( value === this.active ) return;
		this.clearInput();
		this.active = value;

	}

	clearInput = (): void => {

		this.keys.clear();
		this.endDrag();

	};

	update( dt: number ): void {

		if ( ! this.active || ! Number.isFinite( dt ) || isCameraInputTarget( document.activeElement ) ) return;
		const x = Number( this.keys.has( 'KeyD' ) ) - Number( this.keys.has( 'KeyA' ) );
		const z = Number( this.keys.has( 'KeyS' ) ) - Number( this.keys.has( 'KeyW' ) );
		const y = Number( this.keys.has( 'KeyE' ) ) - Number( this.keys.has( 'KeyQ' ) );
		this.direction.set( x, 0, z ).applyQuaternion( this.camera.quaternion );
		this.direction.y += y;
		if ( this.direction.lengthSq() === 0 ) return;
		const boost = this.keys.has( 'ShiftLeft' ) || this.keys.has( 'ShiftRight' ) ? 4 : 1;
		this.camera.position.addScaledVector( this.direction.normalize(), this.speed * boost * THREE.MathUtils.clamp( dt, 0, 0.1 ) );

	}

	dispose(): void {

		this.clearInput();
		window.removeEventListener( 'keydown', this.onKeyDown );
		window.removeEventListener( 'keyup', this.onKeyUp );
		window.removeEventListener( 'blur', this.clearInput );
		document.removeEventListener( 'visibilitychange', this.onVisibilityChange );
		document.removeEventListener( 'focusin', this.onFocusIn );
		this.element.removeEventListener( 'pointerdown', this.onPointerDown );
		this.element.removeEventListener( 'pointermove', this.onPointerMove );
		this.element.removeEventListener( 'pointerup', this.onPointerEnd );
		this.element.removeEventListener( 'pointercancel', this.onPointerCancel );
		this.element.removeEventListener( 'lostpointercapture', this.onPointerEnd );
		this.element.removeEventListener( 'contextmenu', this.onContextMenu );
		this.element.removeEventListener( 'wheel', this.onWheel );

	}

	private onKeyDown = ( event: KeyboardEvent ): void => {

		if ( ! this.active ) return;
		if ( event.ctrlKey || event.metaKey || event.altKey || isCameraInputTarget( event.target ) || isCameraInputTarget( document.activeElement ) ) {

			this.clearInput();
			return;

		}
		if ( ! MOVE_KEYS.has( event.code ) ) return;
		event.preventDefault();
		this.keys.add( event.code );

	};

	private onKeyUp = ( event: KeyboardEvent ): void => {

		this.keys.delete( event.code );

	};

	private onVisibilityChange = (): void => {

		if ( document.hidden ) this.clearInput();

	};

	private onFocusIn = ( event: FocusEvent ): void => {

		if ( isCameraInputTarget( event.target ) ) this.clearInput();

	};

	private onPointerDown = ( event: PointerEvent ): void => {

		if ( ! this.active || this.pointerId !== null || ( event.button !== 0 && event.button !== 2 ) || event.ctrlKey || event.metaKey || event.altKey ) return;
		event.preventDefault();
		// Returning to the canvas should release form focus so navigation can resume.
		if ( document.activeElement instanceof HTMLElement && isCameraInputTarget( document.activeElement ) ) document.activeElement.blur();
		this.rotation.setFromQuaternion( this.camera.quaternion, 'YXZ' );
		this.rotation.z = 0;
		this.pointerId = event.pointerId;
		this.pointerX = event.clientX;
		this.pointerY = event.clientY;
		this.element.setPointerCapture( event.pointerId );

	};

	private onPointerMove = ( event: PointerEvent ): void => {

		if ( ! this.active || event.pointerId !== this.pointerId ) return;
		if ( event.ctrlKey || event.metaKey || event.altKey ) {

			this.clearInput();
			return;

		}
		event.preventDefault();
		const sensitivity = 0.003;
		this.rotation.y -= ( event.clientX - this.pointerX ) * sensitivity;
		this.rotation.x = THREE.MathUtils.clamp( this.rotation.x - ( event.clientY - this.pointerY ) * sensitivity, - PITCH_LIMIT, PITCH_LIMIT );
		this.camera.quaternion.setFromEuler( this.rotation );
		this.pointerX = event.clientX;
		this.pointerY = event.clientY;

	};

	private onPointerEnd = ( event: PointerEvent ): void => {

		if ( event.pointerId === this.pointerId ) this.endDrag();

	};

	private onPointerCancel = ( event: PointerEvent ): void => {

		if ( event.pointerId === this.pointerId ) this.clearInput();

	};

	private endDrag(): void {

		const id = this.pointerId;
		this.pointerId = null;
		if ( id !== null && this.element.hasPointerCapture( id ) ) this.element.releasePointerCapture( id );

	}

	private onContextMenu = ( event: MouseEvent ): void => {

		if ( this.active ) event.preventDefault();

	};

	private onWheel = ( event: WheelEvent ): void => {

		if ( ! this.active || event.ctrlKey || event.metaKey || event.altKey || isCameraInputTarget( document.activeElement ) ) return;
		event.preventDefault();
		// Browsers report wheels in pixels, lines, or pages; normalise before changing speed.
		const delta = event.deltaY * ( event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.element.clientHeight : 1 );
		this.speed = THREE.MathUtils.clamp( this.speed * Math.exp( - delta * 0.001 ), 1, 160 );

	};

}
