import * as THREE from 'three/webgpu';
import { mrt, output, vec4 } from 'three/tsl';

// The temporal modes' scene outputs (Antialiasing.ts: `aa=taa|taau`): the scene's colour and its
// motion vectors, written together into the frame graph's `sceneColor` and `velocity` (Pipeline.ts).
// An MRT finds its outputs and its blend modes by the textures' names, which are the graph's
// resource names.
//
// In three r186 the blend of each attachment comes only from the renderer's context MRT (the
// pass's `mrt`: WebGPUPipelineUtils reads `context.mrt.getBlendMode( texture.name )`, NoBlending
// unless set), whatever a material's own MRT node says, which changes its shader's outputs only.
// The scene MRT draws the colour with each material's own blending and overwrites the velocity, so
// whatever is drawn last at a pixel, transparent or not, leaves its motion there. The overlay MRT,
// for what the overlay pass draws over the finished scene (the rain and the storm's spray), blends
// the colour as the material says and keeps the velocity's rgb (Zero / One), while its alpha, the
// reactive weight, takes the larger of the two (One / One, Max): a streak keeps the motion of the
// surface behind it. tools/verify-frame-graph-gpu.mjs checks both blends on the GPU.

/** The velocity's clear value: no motion, class sky (nothing drawn there), not reactive. */
export const VELOCITY_CLEAR = [ 0, 0, 1, 0 ] as const;

const materialBlending = () => new THREE.BlendMode( THREE.MaterialBlending );

// the overlay's velocity blend: rgb kept, alpha the larger
function keepMaxBlending(): THREE.BlendMode {

	const blend = new THREE.BlendMode( THREE.CustomBlending );
	blend.blendSrc = THREE.ZeroFactor;
	blend.blendDst = THREE.OneFactor;
	blend.blendEquation = THREE.AddEquation;
	blend.blendSrcAlpha = THREE.OneFactor;
	blend.blendDstAlpha = THREE.OneFactor;
	blend.blendEquationAlpha = THREE.MaxEquation;
	return blend;

}

/** The opaque and water passes' MRT. (The velocity is a placeholder until the motion vectors land:
 * no motion, class opaque.) */
export const sceneMRT: THREE.MRTNode = mrt( { sceneColor: output, velocity: vec4( 0, 0, 0, 0 ) } )
	.setBlendMode( 'sceneColor', materialBlending() )
	.setClearColor( 'velocity', new THREE.Color( VELOCITY_CLEAR[ 0 ], VELOCITY_CLEAR[ 1 ], VELOCITY_CLEAR[ 2 ] ), VELOCITY_CLEAR[ 3 ] );

/** The overlay pass's MRT (the rain, the storm's spray): the velocity kept, its reactive weight the
 * larger. */
export const overlayMRT: THREE.MRTNode = mrt( { sceneColor: output, velocity: vec4( 0, 0, 0, 0 ) } )
	.setBlendMode( 'sceneColor', materialBlending() )
	.setBlendMode( 'velocity', keepMaxBlending() );
