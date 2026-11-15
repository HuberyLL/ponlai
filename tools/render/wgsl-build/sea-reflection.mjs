// tools/render/wgsl-build.mjs's entry for the sea's reflection (packages/render/ocean/SeaReflection.ts):
// its full-screen passes, the trace, the moments, the reprojection, the average, the prefilter and the
// temporal resolve, in the order a frame draws them, declared on a frame graph of their own as
// PipelinePasses.ts declares them (the MSAA half: unjittered). The opaque pass's linear depth and
// colour are stand-ins in Pipeline.ts's formats; the prepass, the water's surface drawn alone, is
// Water.ts's and is not built here.

import * as THREE from 'three/webgpu';
import { FrameGraph } from '../../../packages/render/post/graph/FrameGraph.ts';
import { DepthPyramid } from '../../../packages/render/post/DepthPyramid.ts';
import { SeaReflection } from '../../../packages/render/ocean/SeaReflection.ts';

export default function ( { renderer } ) {

	const g = new FrameGraph( renderer, { sceneSamples: 4 } );
	const render = { of: 'render' };
	let linearDepth = g.color( 'linearDepth', { size: render, format: THREE.RGFormat, type: THREE.FloatType, filter: 'nearest' } );
	let opaqueColor = g.color( 'opaqueColor', { size: render, format: THREE.RGBAFormat, type: THREE.HalfFloatType, filter: 'linear' } );
	const pyramid = new DepthPyramid( g.texture( linearDepth ) );
	// (the opaque pass and its copies, which write what the reflection reads)
	g.addPass( 'opaque', 'callback', ( b ) => {

		linearDepth = b.storage( linearDepth );
		opaqueColor = b.storage( opaqueColor );
		return { label: 'stand-in', run() {} };

	} );
	const reflection = new SeaReflection( g );
	reflection.passes( g, { linearDepth, opaqueColor, pyramid, iterations: 48 }, false, { active: () => true, camera: () => new THREE.PerspectiveCamera(), before: () => {} } );
	// (the graph's executors are its own; the quads are read from its definitions in order)
	const shaders = [];
	g.decl.passes.forEach( ( pass, i ) => {

		const quad = g.defs[ i ].quad;
		if ( quad ) shaders.push( [ pass.name, quad.material ] );

	} );
	return shaders;

}
