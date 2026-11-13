// tools/wgsl-build.mjs's entry for the local lights (packages/render/lighting/LocalLights.ts): the clusters'
// kernel, then the lit materials whose fragment stage binds the most, which the light table and the
// clusters add two storage buffers to: the terrain's cliff (with the meadow over it) and its seabed
// (packages/island/materials/TerrainMaterial.ts), and the islanders' lit figure (packages/island/characters/), each over the
// ambient volume as the page builds them (packages/render/lighting/AmbientSample.ts).
//
// Stand-ins: the detail maps and scans are empty textures of the page's kinds (one array texture
// for the baked maps' layers, two for the scans), the shore and rim fields empty textures, the
// wave maps the page's own, never baked, one directional light, no environment, a small ambient
// lattice and its relight over an empty sky. The counts are each
// material's own plus the volume's and the local lights', not the page's shadow maps, environment,
// ground bounce or screen-space terms.

import * as THREE from 'three/webgpu';
import { texture, int, float } from 'three/tsl';
import { localLightsKernel } from '../../packages/render/lighting/LocalLights.ts';
import { AmbientVolume } from '../../packages/render/lighting/AmbientVolume.ts';
import { installAmbientVolume, installEnvironmentHarmonics } from '../../packages/render/lighting/AmbientSample.ts';
import { AmbientRelight, AmbientSky } from '../../packages/render/lighting/AmbientRelight.ts';
import { PROBE_STRIDE } from '../../packages/render/lighting/ProbeFormat.ts';
import { DETAIL_LAYER } from '../../packages/render/materials/ProceduralTextures.ts';
import { createSoilTexture } from '../../packages/island/materials/Soil.ts';
import { makeTerrainMaterial } from '../../packages/island/materials/TerrainMaterial.ts';
import { WaveMaps } from '../../packages/render/ocean/WaveMaps.ts';
import { makeLitFigureMaterial } from '../../packages/island/characters/FigureSurfaces.ts';
import { shared } from '../../packages/render/shared.ts';
import { createDayWindows } from '../../packages/render/look/DayLook.ts';
import { installedLook } from '../../packages/render/look/Look.ts';

const array = ( name, depth ) => {

	const t = new THREE.DataArrayTexture( new Uint8Array( 4 * depth ), 1, 1, depth );
	t.name = name;
	t.needsUpdate = true;
	return t;

};
const plain = ( name ) => {

	const t = new THREE.DataTexture( new Uint8Array( 4 ), 1, 1 );
	t.name = name;
	t.needsUpdate = true;
	return t;

};

export default function ( { renderer } ) {

	const nx = 3, ny = 2, nz = 4;
	const volume = new AmbientVolume( renderer, { x0: 0, y0: - 2, z0: 0, spacing: 2, nx, ny, nz, probes: new Float32Array( ( nx * ny * nz + ny ) * PROBE_STRIDE ) } );
	installAmbientVolume( volume );
	// the specular's relight over a sky that has projected nothing (as ambient-materials builds it)
	installEnvironmentHarmonics( new AmbientRelight( {
		renderer, volume, shared, sky: new AmbientSky( renderer ), weights: () => ( { a: 0, b: 1, blend: 0 } ), cloud: () => float( 1 ), seaCloud: () => float( 1 ), keyHeight: () => 1, dayWindows: createDayWindows( installedLook().day ),
	} ) );
	const detail = array( 'detail', 4 );
	const layer = ( i ) => texture( detail ).depth( int( i ) );
	const tex = {
		soil: createSoilTexture(), heights: layer( DETAIL_LAYER.heights ), gravel: layer( DETAIL_LAYER.gravel ),
		normalsA: layer( DETAIL_LAYER.normalsA ), normalsB: layer( DETAIL_LAYER.normalsB ),
		scanAlbedo: array( 'scanAlbedo', 3 ), scanDetail: array( 'scanDetail', 3 ),
	};
	const waveMaps = new WaveMaps( renderer, { cascades: 3, sizes: [ 250, 50, 10 ], derivatives: array( 'derivatives', 3 ) } );
	const shore = plain( 'shore' ), rim = plain( 'rim' );
	const scene = new THREE.Scene();
	const light = new THREE.DirectionalLight( 0xffffff, 1 );
	light.position.set( 1, 2, 1 );
	scene.add( light );
	const camera = new THREE.PerspectiveCamera();
	const draw = ( material ) => ( { material, object: new THREE.Mesh( new THREE.BoxGeometry(), material ), scene, camera } );
	return [
		[ 'clusters', localLightsKernel ],
		[ 'cliff', draw( makeTerrainMaterial( 'cliff', tex, shared, waveMaps, shore, { topY: 3.1, rimGround: rim, rimGroundXform: new THREE.Vector4( 0, 0, 1, 1 ) } ) ) ],
		[ 'seabed', draw( makeTerrainMaterial( 'seabed', tex, shared, waveMaps, shore ) ) ],
		[ 'figure', draw( makeLitFigureMaterial() ) ],
	];

}
