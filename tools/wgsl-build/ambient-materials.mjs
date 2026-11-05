// tools/wgsl-build.mjs's entry for the lit materials that read the ambient volume
// (src/lighting/AmbientSample.ts): a game prop (degree 2) twice, as two materials of one model, to
// check that the second's code names its own bindings; the islanders' lit figure and their
// vertex-colour figure (characters/); the bamboo's culms and leaves (degree 1, as the page draws
// them: wgsl-build/plants.mjs); a surface with the
// meadow's reading (degree 1, straight above the point); and a surface with an under-water share
// at degree 1 (the terrain's and the stones' reading, without the terrain's own inputs). The
// specular's relight reads the environment's own harmonics from an AmbientRelight over a sky that
// has projected nothing (its storage buffer of zeros). With `--q "flags=ambientVolume:0"` the same materials build on the
// environment's irradiance, for a comparison with the code before the volume.
//
// Stand-ins: a small lattice (the sizes reach the shaders through uniforms only), one directional
// light and no environment (the materials' environment terms build as zero): the counts are each
// material's own plus the volume's, not the page's shadow maps, environment or ground bounce.

import * as THREE from 'three/webgpu';
import { float, uniform, vec3 } from 'three/tsl';
import { AmbientVolume } from '../../src/lighting/AmbientVolume.ts';
import { PROBE_STRIDE } from '../../src/world/AmbientProbes.ts';
import { GroundBounceLightingModel } from '../../src/lighting/GroundBounce.ts';
import { propMaterial } from '../../src/game/view/Props.ts';
import { makeLitFigureMaterial } from '../../src/characters/FigureSurfaces.ts';
import { makeVertexColourCharacterMaterial } from '../../src/characters/CharacterMaterial.ts';
import { plantDraws, standInBamboo } from './plants.mjs';
import { vegetationMaterial } from '../../src/world/vegetation/Material.ts';
import { shared } from '../../src/shared.ts';

export default async function ( { renderer } ) {

	const nx = 3, ny = 2, nz = 4;
	const lattice = { x0: 0, y0: - 2, z0: 0, spacing: 2, nx, ny, nz, probes: new Float32Array( ( nx * ny * nz + ny ) * PROBE_STRIDE ) };
	const volume = new AmbientVolume( renderer, lattice );
	// (absent before the volume's materials: the entry then builds the same materials without it)
	const sample = await import( '../../src/lighting/AmbientSample.ts' ).catch( () => null );
	sample?.installAmbientVolume( volume );
	if ( sample?.installEnvironmentHarmonics ) {

		const { AmbientRelight, AmbientSky } = await import( '../../src/lighting/AmbientRelight.ts' );
		const sky = new AmbientSky( renderer );
		sample.installEnvironmentHarmonics( new AmbientRelight( {
			renderer, volume, shared, sky, weights: () => ( { a: 0, b: 1, blend: 0 } ), cloud: () => float( 1 ), seaCloud: () => float( 1 ), keyHeight: () => 1,
		} ) );

	}

	const scene = new THREE.Scene();
	const light = new THREE.DirectionalLight( 0xffffff, 1 );
	light.position.set( 1, 2, 1 );
	scene.add( light );
	const camera = new THREE.PerspectiveCamera();
	// a box with every attribute the materials read (zeros)
	const box = () => {

		const geometry = new THREE.BoxGeometry();
		const count = geometry.attributes.position.count;
		for ( const [ name, size ] of [ [ 'shade', 4 ], [ 'color', 3 ] ] ) geometry.setAttribute( name, new THREE.Float32BufferAttribute( new Float32Array( count * size ), size ) );
		return geometry;

	};
	const draw = ( material, geometry = box() ) => ( { material, object: new THREE.Mesh( geometry, material ), scene, camera } );

	// a plain surface on a lighting model of its own choosing
	const surface = ( name, model ) => {

		const material = new THREE.MeshStandardNodeMaterial( { roughness: 0.8, metalness: 0 } );
		material.name = name;
		material.normalNode = vec3( 0, 0, 1 );
		material.setupLightingModel = model;
		return material;

	};
	const depth = uniform( 0 );
	const meadow = vegetationMaterial( shared, {
		family: 'sod', name: 'meadow-reading', roughness: 0.65, rest: vec3( 0 ), displacement: () => vec3( 0 ),
		wet: { tint: 0.75, roughness: 0.35 },
		light: { scale: float( 1 ), translucency: 0, ambient: { bands: 1, offset: 'up' } },
	} );
	// the leaves' atlas (painted on canvases in the page)
	const atlasTexture = ( name ) => {

		const texture = new THREE.DataTexture( new Uint8Array( 4 ), 1, 1 );
		texture.name = name;
		return texture;

	};
	const atlas = { map: atlasTexture( 'leafMap' ), alpha: atlasTexture( 'leafAlpha' ), ids: atlasTexture( 'leafIds' ) };
	const vertexColour = makeVertexColourCharacterMaterial( shared );
	return [
		[ 'prop-a', draw( propMaterial( 'prop a' ) ) ],
		[ 'prop-b', draw( propMaterial( 'prop b' ) ) ],
		[ 'figure', draw( makeLitFigureMaterial() ) ],
		[ 'figure-vertex-colour', draw( vertexColour ) ],
		...plantDraws( standInBamboo( atlas ) ).map( ( [ name, mesh ] ) => [ name, { material: mesh.material, object: mesh, scene, camera } ] ),
		[ 'meadow-reading', draw( meadow ) ],
		[ 'terrain-reading', draw( surface( 'terrain reading', () => new GroundBounceLightingModel( { bands: 1, weight: depth } ) ) ) ],
	];

}
