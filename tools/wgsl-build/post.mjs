// tools/wgsl-build.mjs's entry for the post chain's own passes, in the order a frame draws them:
// the exposure's meter (packages/render/post/Metering.ts, the target and the adaptation of
// packages/render/post/Exposure.ts), the bloom's levels (packages/render/post/PhysicalBloom.ts) and the local tone's grid
// with its slicing (packages/render/post/LocalTone.ts `apply`, drawn as a full-screen pass that reads it). The
// graph is a stand-in that hands each resource a texture in Pipeline.ts's format and each size
// class a uniform; the exposure is the page's builder (Pipeline.ts `exposureRead`). The display
// pass itself (the grade, the curve) is built by the page's Pipeline only; its vignette is built
// here alone (PipelineDisplay.ts `vignetteFactor`).

import * as THREE from 'three/webgpu';
import { exp2, float, ivec2, select, texture, textureLoad, uniform, uv, vec3, vec4 } from 'three/tsl';
import { Metering } from '../../packages/render/post/Metering.ts';
import { PhysicalBloom } from '../../packages/render/post/PhysicalBloom.ts';
import { LocalTone } from '../../packages/render/post/LocalTone.ts';
import { vignetteFactor } from '../../packages/render/post/PipelineDisplay.ts';
import { preExposure } from '../../packages/render/post/PreExposure.ts';
import { createDisplayTables } from '../../packages/render/look/DisplayLook.ts';
import { ISLAND_LOOK } from '../../packages/island/look/IslandLook.ts';

// a graph resource as Pipeline.ts declares it
function resource( name, format, type ) {

	const texture = new THREE.Texture();
	texture.name = name;
	texture.isRenderTargetTexture = true;
	texture.generateMipmaps = false;
	texture.format = format;
	texture.type = type;
	texture.minFilter = texture.magFilter = THREE.LinearFilter;
	return texture;

}

// the graph's resource calls the modules make (GraphResources, graph/FrameGraph.ts)
function standInGraph() {

	const uniforms = new Map();
	const sized = ( size ) => {

		const key = JSON.stringify( size );
		if ( ! uniforms.has( key ) ) uniforms.set( key, uniform( new THREE.Vector2( 1, 1 ) ) );
		return uniforms.get( key );

	};
	return {
		color: ( name, desc ) => ( { name, texture: resource( name, desc.format ?? THREE.RGBAFormat, desc.type ?? THREE.HalfFloatType ) } ),
		texture: ( h ) => h.texture,
		extent: sized,
		texel: sized,
		onResize: () => {},
	};

}

export default function () {

	const graph = standInGraph();
	const hdr = resource( 'hdr', THREE.RGBAFormat, THREE.HalfFloatType );
	const meterLight = resource( 'meterLight', THREE.RGBAFormat, THREE.HalfFloatType );
	const surfaceDepth = resource( 'surfaceDepth', THREE.RedFormat, THREE.FloatType );
	const exposureState = resource( 'exposureState', THREE.RGBAFormat, THREE.FloatType );
	const exposureStatePrev = resource( 'exposureStatePrev', THREE.RGBAFormat, THREE.FloatType );
	const sharp = resource( 'sharp', THREE.RGBAFormat, THREE.HalfFloatType );
	const renderSize = graph.extent( { of: 'render' } );

	// the meter
	const metering = new Metering( hdr, meterLight, renderSize );
	metering.buildMeter( uniform( 0 ), exposureStatePrev );

	// the exposure as the passes after the meter read it (Pipeline.ts `exposureRead`)
	const exposure = exp2( textureLoad( texture( exposureState ), ivec2( 0 ) ).x ).mul( preExposure.inverse );

	// the display's tables of the island's look, as the page's stage makes them
	const display = createDisplayTables( ISLAND_LOOK.display );

	// the bloom, with the sky's test and a stand-in extra term
	const isSky = ( at ) => select( textureLoad( texture( surfaceDepth ), ivec2( at.mul( renderSize ) ) ).x.lessThan( - 9e4 ), float( 1 ), float( 0 ) );
	const bloom = new PhysicalBloom( display, graph, texture( hdr ), exposure, isSky, ( at, strength ) => at.xyx.div( strength ) );
	const q = bloom.quads;

	// the local tone's grid, and its slicing drawn as a full-screen pass
	const tSharp = texture( sharp );
	const localTone = new LocalTone( graph, tSharp, exposure, renderSize );
	const slice = new THREE.NodeMaterial();
	slice.name = 'LocalTone.Apply';
	slice.fragmentNode = vec4( localTone.apply( tSharp.rgb.mul( exposure ), uv() ), 1 );
	const vignette = new THREE.NodeMaterial();
	vignette.name = 'Vignette';
	vignette.fragmentNode = vec4( vec3( vignetteFactor( display.vignette, uv(), uniform( 1 ) ) ), 1 );
	const bloomRead = new THREE.NodeMaterial();
	bloomRead.name = 'Bloom.Read';
	bloomRead.fragmentNode = vec4( bloom.read( uv() ), 1 );

	return [
		[ 'metering-clear', metering.clearKernel ],
		[ 'metering-histograms', metering.histogramKernel ],
		[ 'meter', metering.meterQuad.material ],
		...bloomShaders( q ),
		[ 'bloom-read', bloomRead ],
		...localTone.quads.map( ( m ) => [ m.name, m.material ] ),
		[ 'local-tone-apply', slice ],
		[ 'vignette', vignette ],
	];

}

// the bloom's passes, in the order PhysicalBloom.passes declares them: the sky's mask, the
// downsamples, then the upsamples from the widest
function bloomShaders( q ) {

	return [ q.sky, ...q.down, ...[ ...q.up ].reverse() ].map( ( m ) => [ m.name, m.material ] );

}
