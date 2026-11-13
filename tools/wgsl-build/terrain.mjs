// tools/wgsl-build.mjs's entry for the island's terrain material (packages/island/materials/TerrainMaterial.ts):
// the cliff with the meadow's ground (as World.ts builds the island's), the stones' cliff without it
// and the sea floor, each lit through the ambient volume as the page lights them.
//
// Stand-ins: 1x1 textures for the baked maps, the scans, the soil and the world's fields (the
// shaders take their sizes through uniforms, the scans' smallest mip through a constant), an ocean
// FFT of three cascades for the caustics, a small ambient lattice and the environment's harmonics
// over an empty sky (as the ambient-materials entry builds them), one directional light and no
// environment: the counts are each material's own plus the volume's, not the page's shadow maps,
// environment or ground bounce.

import * as THREE from 'three/webgpu';
import { float, texture } from 'three/tsl';
import { AmbientVolume } from '../../packages/render/lighting/AmbientVolume.ts';
import { PROBE_STRIDE } from '../../packages/render/lighting/ProbeFormat.ts';
import { installAmbientVolume, installEnvironmentHarmonics } from '../../packages/render/lighting/AmbientSample.ts';
import { AmbientRelight, AmbientSky } from '../../packages/render/lighting/AmbientRelight.ts';
import { WaveMaps } from '../../packages/render/ocean/WaveMaps.ts';
import { makeTerrainMaterial } from '../../packages/island/materials/TerrainMaterial.ts';
import { shared } from '../../packages/render/shared.ts';
import { createDayWindows } from '../../packages/render/look/DayLook.ts';
import { createAmbientTables } from '../../packages/render/look/AmbientLook.ts';
import { installedLook } from '../../packages/render/look/Look.ts';

const array = ( name, layers, colorSpace = THREE.NoColorSpace ) => {

	const t = new THREE.DataArrayTexture( new Uint8Array( 4 * layers ), 1, 1, layers );
	t.name = name;
	t.colorSpace = colorSpace;
	return t;

};

export default async function ( { renderer } ) {

	const nx = 3, ny = 2, nz = 4;
	const lattice = { x0: 0, y0: - 2, z0: 0, spacing: 2, nx, ny, nz, probes: new Float32Array( ( nx * ny * nz + ny ) * PROBE_STRIDE ) };
	const volume = new AmbientVolume( renderer, lattice );
	installAmbientVolume( volume );
	// the specular's relight over a sky that has projected nothing (as ambient-materials builds it)
	installEnvironmentHarmonics( new AmbientRelight( {
		renderer, volume, shared, sky: new AmbientSky( renderer ), weights: () => ( { a: 0, b: 1, blend: 0 } ), cloud: () => float( 1 ), seaCloud: () => float( 1 ), keyHeight: () => 1, dayWindows: createDayWindows( installedLook().day ), grade: createAmbientTables( installedLook().ambient ),
	} ) );

	const detail = array( 'detail', 4 );
	const tex = {
		soil: array( 'soil', 2 ),
		heights: texture( detail ).depth( 0 ), normalsA: texture( detail ).depth( 1 ), normalsB: texture( detail ).depth( 2 ), gravel: texture( detail ).depth( 3 ),
		scanAlbedo: array( 'scanAlbedo', 3, THREE.SRGBColorSpace ), scanDetail: array( 'scanDetail', 3 ),
	};
	const waveMaps = new WaveMaps( renderer, { cascades: 3, sizes: [ 250, 50, 10 ], derivatives: array( 'derivatives', 3 ) } );
	const field = ( name ) => {

		const t = new THREE.DataTexture( new Uint16Array( 4 ), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType );
		t.name = name;
		return texture( t );

	};
	const shore = field( 'shore-distance' ), rim = field( 'rim-root-bed' );

	const scene = new THREE.Scene();
	const light = new THREE.DirectionalLight( 0xffffff, 1 );
	light.position.set( 1, 2, 1 );
	scene.add( light );
	const camera = new THREE.PerspectiveCamera();
	// a box with every attribute the materials read (zeros)
	const box = () => {

		const geometry = new THREE.BoxGeometry();
		const count = geometry.attributes.position.count;
		for ( const [ name, size ] of [ [ 'detail', 4 ], [ 'detail2', 3 ], [ 'ao', 1 ], [ 'tint', 1 ], [ 'curv', 1 ], [ 'bed', 2 ] ] ) geometry.setAttribute( name, new THREE.Float32BufferAttribute( new Float32Array( count * size ), size ) );
		return geometry;

	};
	const draw = ( material ) => ( { material, object: new THREE.Mesh( box(), material ), scene, camera } );
	return [
		[ 'cliff', draw( makeTerrainMaterial( 'cliff', tex, shared, waveMaps, shore, { topY: 3.1, rimGround: rim, rimGroundXform: new THREE.Vector4( 0, 0, 1, 1 ) } ) ) ],
		[ 'stones', draw( makeTerrainMaterial( 'cliff', tex, shared, waveMaps, shore, { vegetation: false } ) ) ],
		[ 'seabed', draw( makeTerrainMaterial( 'seabed', tex, shared, waveMaps, shore ) ) ],
	];

}
