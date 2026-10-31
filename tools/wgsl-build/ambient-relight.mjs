// tools/wgsl-build.mjs's entry for the ambient light's relight (src/lighting/AmbientRelight.ts):
// the kernels the page builds, in the order it builds them: the sky's projection (at the first
// bake: its rows, its groups and its finish), the relight (at the first frame), then on demand the
// readback's copy and the probes' debug view (AmbientVolume.ts, every mode in one material).
//
// Stand-ins: a small lattice (the sizes reach the kernels through uniforms and dispatch counts
// only), an environment source of the page's size and format (Sky.ts `reflectionSource`: the
// projection's kernels are sized from it), and a constant cloud shadow where the page passes
// Sky.ts `cloudVisibility` (a texture read the relight's WGSL then adds).

import * as THREE from 'three/webgpu';
import { float } from 'three/tsl';
import { AmbientRelight, AmbientSky } from '../../src/lighting/AmbientRelight.ts';
import { AmbientVolume } from '../../src/lighting/AmbientVolume.ts';
import { PROBE_STRIDE } from '../../src/world/AmbientProbes.ts';
import { shared } from '../../src/shared.ts';

export default function ( { renderer } ) {

	const nx = 3, ny = 2, nz = 4;
	const lattice = { x0: 0, y0: 0, z0: 0, spacing: 2, nx, ny, nz, probes: new Float32Array( ( nx * ny * nz + ny ) * PROBE_STRIDE ) };
	const volume = new AmbientVolume( renderer, lattice );
	const source = new THREE.Texture( { width: 512, height: 256 } );
	source.name = 'reflectionSource';
	source.isRenderTargetTexture = true;
	source.generateMipmaps = false;
	source.format = THREE.RGBAFormat;
	source.type = THREE.HalfFloatType;
	source.minFilter = source.magFilter = THREE.LinearFilter;
	const sky = new AmbientSky( renderer );
	const { rows, groups, finish } = sky.build( source );
	const relight = new AmbientRelight( { renderer, volume, shared, sky, weights: () => ( { a: 0, b: 1, blend: 0 } ), cloud: () => float( 1 ) } );
	const view = volume.buildView();
	return [
		[ 'AmbientSky.Rows', rows ],
		[ 'AmbientSky.Groups', groups ],
		[ 'AmbientSky.Finish', finish ],
		[ 'AmbientRelight.Relight', relight.kernel ],
		[ 'AmbientRelight.Readback', relight.buildCopy( ( nx + 1 ) * 7 * ny * nz ).kernel ],
		[ 'AmbientVolume.View', { material: view.material, object: view } ],
	];

}
