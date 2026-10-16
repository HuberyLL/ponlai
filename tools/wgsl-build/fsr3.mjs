// tools/wgsl-build.mjs's entry for FSR 3 (src/post/fsr3/): every kernel the page's upscaler builds,
// from the page's own Fsr3Upscaler (its resources, inputs, flags and clear jobs), in the order a
// frame dispatches them: the reactive-mask generator, the clears, the passes with the SPD tails
// after their pyramids. Beside what a frame dispatches it builds the generator (on as if
// `fsr3.autoReactive` were), ACCUMULATE without sharpening, the shading-change pyramid's tail
// and the debug view. The Lanczos LUT permutation is left out: the page never builds it.
//
// The frame graph is a stand-in that hands each input its texture in Pipeline.ts's format, with
// the graph's linear filter. The sizes do not reach the WGSL (the kernels read them from uniforms:
// Passes.ts).

import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { Fsr3Upscaler } from '../../src/post/fsr3/Fsr3Upscaler.ts';
import * as H from '../../src/post/fsr3/Host.ts';
import * as R from '../../src/post/fsr3/Resources.ts';
import { QUALITY } from '../../src/Quality.ts';

// a graph resource as Pipeline.ts declares it
function input( name, format, type ) {

	const texture = new THREE.Texture();
	texture.name = name;
	texture.isRenderTargetTexture = true;
	texture.generateMipmaps = false;
	texture.format = format;
	texture.type = type;
	texture.minFilter = texture.magFilter = THREE.LinearFilter;
	return { name, texture };

}

export default function ( { renderer } ) {

	const graph = { texture: ( h ) => h.texture, onResize: () => {} };
	const rgba16 = ( name ) => input( name, THREE.RGBAFormat, THREE.HalfFloatType );
	const inputs = {
		hdr: rgba16( 'hdr' ), velocity: rgba16( 'velocity' ), sceneColor: rgba16( 'sceneColor' ), opaqueColor: rgba16( 'opaqueColor' ),
		surfaceDepth: input( 'surfaceDepth', THREE.RedFormat, THREE.FloatType ),
		veilReactive: input( 'veilReactive', THREE.RedFormat, THREE.HalfFloatType ),
	};
	const taa = QUALITY.high.taa;
	const settings = { ...taa, fsr3: { ...taa.fsr3, autoReactive: true } };
	const fsr = new Fsr3Upscaler( renderer, graph, inputs, { settings, exposure: uniform( 1 ), debugView: true } );

	// (the upscaler's private kernels, generator and clear jobs)
	const k = fsr.kernels;
	const shaders = [ [ 'generate-reactive', fsr.generator.kernel ] ];
	for ( const job of fsr.clearJobs ) {

		// (one kernel per target and values: a target cleared at the first execution and on a reset
		// has one)
		const kernel = k.clear( job );
		if ( shaders.some( ( [ , s ] ) => s === kernel ) ) continue;
		const target = R.FSR3_INTERNAL_RESOURCES.find( ( d ) => d.id === job.target );
		shaders.push( [ `clear-${ target ? target.name.replace( /^FSR3UPSCALER_/, '' ) : job.target }`, kernel ] );

	}
	const passName = ( id ) => Object.keys( H ).find( ( key ) => key.startsWith( 'FFX_FSR3UPSCALER_PASS_' ) && H[ key ] === id ).slice( 22 ).toLowerCase().replaceAll( '_', '-' );
	for ( const id of [ H.FFX_FSR3UPSCALER_PASS_PREPARE_INPUTS, H.FFX_FSR3UPSCALER_PASS_LUMA_PYRAMID, 'luma-pyramid-tail',
		H.FFX_FSR3UPSCALER_PASS_SHADING_CHANGE_PYRAMID, 'shading-change-pyramid-tail', H.FFX_FSR3UPSCALER_PASS_SHADING_CHANGE,
		H.FFX_FSR3UPSCALER_PASS_PREPARE_REACTIVITY, H.FFX_FSR3UPSCALER_PASS_LUMA_INSTABILITY, H.FFX_FSR3UPSCALER_PASS_ACCUMULATE,
		H.FFX_FSR3UPSCALER_PASS_ACCUMULATE_SHARPEN, H.FFX_FSR3UPSCALER_PASS_RCAS, H.FFX_FSR3UPSCALER_PASS_DEBUG_VIEW ] ) {

		if ( id === 'luma-pyramid-tail' ) shaders.push( [ id, k.lumaPyramidTail() ] );
		else if ( id === 'shading-change-pyramid-tail' ) shaders.push( [ id, k.shadingChangePyramidTail() ] );
		else shaders.push( [ passName( id ), k.pass( id ) ] );

	}
	return shaders;

}
