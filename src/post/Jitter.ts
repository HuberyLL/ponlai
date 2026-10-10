import * as THREE from 'three/webgpu';
import { renderGroup, uniform } from 'three/tsl';
import { debugFlags } from '../debug/DebugFlags.ts';

// The temporal modes' sub-pixel jitter (Antialiasing.ts: aa=taa|taau): each frame the scene half
// of the frame graph (its jittered span, from the opaque scene to the overlay) renders with the
// camera's projection shifted by a fraction of a render pixel, so successive frames sample each
// pixel at different points and the resolve can accumulate them. After Karis, "High Quality
// Temporal Supersampling" (SIGGRAPH 2014): a Halton (2, 3) sequence, whose points fill the pixel
// evenly whatever the length a frame cuts it at.
//
// Frame k of the running sequence takes Halton index (k mod L) + 1, the offset (h2 - 0.5, h3 - 0.5)
// in render pixels. TAA keeps L = 16; TAAU, whose output pixels are smaller than the render's,
// needs about eight samples per output pixel, so L = clamp( ceil( 8 r^2 ), 16, 64 ) for an output
// r times the render per axis. A scene at rest runs its own sequence of REST_SEQUENCE indices
// (1..32: `restIndex`, set by the rest convergence), so a paused frame is the same however it was
// reached.
//
// The offset moves the sampled point, x right and y down in render pixels: each render pixel shows
// the scene at its centre plus `px`. The projection is shifted the other way in NDC (by `ndc`),
// applied to the camera by `begin` and undone exactly by `end` (the graph's jitter hooks, around
// the jittered passes that run). Everything outside the span sees the camera unjittered: the sky
// and grass cull keys, the light shafts' sun position, the motion vectors (which are the motion
// of the unjittered views: the jitter is no motion). `debugFlags.jitter = false` renders without
// it (the motion vectors' unit checks).

/** The radical inverse of `index` in `base`: the Halton sequence's value. */
export function halton( index: number, base: number ): number {

	let f = 1, r = 0;
	for ( let i = index; i > 0; i = Math.floor( i / base ) ) {

		f /= base;
		r += f * ( i % base );

	}
	return r;

}

/** The rest sequence's length (its indices are 1..REST_SEQUENCE). */
export const REST_SEQUENCE = 32;

/** The running sequence's length: 16 for TAA, more for TAAU's smaller output pixels (`ratio`: the
 * output's size over the render's, per axis). */
export function sequenceLength( mode: 'taa' | 'taau', ratio: number ): number {

	return mode === 'taa' ? 16 : THREE.MathUtils.clamp( Math.ceil( 8 * ratio * ratio ), 16, 64 );

}

export class Jitter {

	/** This frame's offset of the sampled point from each render pixel's centre (render px; x right,
	 * y down). */
	readonly px = new THREE.Vector2();
	/** This frame's place in its sequence (0-based; the Halton index is k + 1), and the length. */
	k = 0;
	length = 16;
	/** Rendered frames so far (the running sequence's clock: frames the pacer skips do not count). */
	frame = 0;
	/** 1..REST_SEQUENCE while a scene at rest runs the rest sequence (TemporalRest), else null. */
	restIndex: number | null = null;
	readonly uniforms = {
		// k mod 16, for the vegetation's per-frame dither (a threshold of the pixel's 4x4 Bayer value
		// plus 5 k, mod 16)
		ditherIndex: uniform( 0 ),
		// the offset in render pixels (`px`)
		px: uniform( new THREE.Vector2() ),
		// what to add to a jittered fragment's NDC for the unjittered view's: ( 2 px.x / w, -2 px.y / h )
		ndc: uniform( new THREE.Vector2() ).setGroup( renderGroup ),
		// the camera's projection without the jitter (the sky, which must not jitter, and the culls)
		unjitteredProjection: uniform( new THREE.Matrix4() ).setGroup( renderGroup ),
		unjitteredProjectionInverse: uniform( new THREE.Matrix4() ).setGroup( renderGroup ),
	};
	/** TAA's sequence or TAAU's (Pipeline sets it for the page's mode). */
	mode: 'taa' | 'taau' = 'taa';
	private readonly projection = new THREE.Matrix4();
	private readonly projectionInverse = new THREE.Matrix4();
	private readonly shift = new THREE.Matrix4();
	private applied: THREE.Camera | null = null;

	/** Before a frame renders (the camera unjittered): this frame's offset, from the render's size and
	 * the output's ratio to it, and the unjittered projection. */
	prepare( camera: THREE.Camera, width: number, height: number, ratio: number ): void {

		this.length = sequenceLength( this.mode, ratio );
		this.k = this.restIndex !== null ? this.restIndex - 1 : this.frame % this.length;
		this.frame ++;
		if ( debugFlags.jitter === false ) this.px.set( 0, 0 );
		else this.px.set( halton( this.k + 1, 2 ) - 0.5, halton( this.k + 1, 3 ) - 0.5 );
		const u = this.uniforms;
		u.ditherIndex.value = this.k % 16;
		u.px.value.copy( this.px );
		u.ndc.value.set( 2 * this.px.x / Math.max( width, 1 ), - 2 * this.px.y / Math.max( height, 1 ) );
		this.projection.copy( camera.projectionMatrix );
		this.projectionInverse.copy( camera.projectionMatrixInverse );
		u.unjitteredProjection.value.copy( this.projection );
		u.unjitteredProjectionInverse.value.copy( this.projectionInverse );

	}

	/** Shifts the camera's projection by this frame's offset (the scene point at a pixel's centre plus
	 * `px` lands on the centre). */
	begin( camera: THREE.Camera ): void {

		const d = this.uniforms.ndc.value;
		this.shift.makeTranslation( - d.x, - d.y, 0 );
		camera.projectionMatrix.copy( this.projection ).premultiply( this.shift );
		camera.projectionMatrixInverse.copy( camera.projectionMatrix ).invert();
		this.applied = camera;

	}

	/** Restores the unjittered projection, bit for bit. */
	end( camera: THREE.Camera ): void {

		if ( this.applied !== camera ) return;
		camera.projectionMatrix.copy( this.projection );
		camera.projectionMatrixInverse.copy( this.projectionInverse );
		this.applied = null;

	}

}

/** The page's jitter: one, since the materials that read its uniforms are built once. */
export const jitter = new Jitter();
