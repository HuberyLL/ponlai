import * as THREE from 'three/webgpu';
import { attribute, clamp, float, mix, positionGeometry, varying, vec2, vec3 } from 'three/tsl';
import { setWindDisplacement, windField, type WindUniforms, previousSway, useRestPoseShadows, followWindMotionFlag, CANOPY_TOP, GAIN } from '../../render/index.ts';
import { islandSurfaceHeight } from '../world/WorldShapes.ts';
import { sampleShore } from './ChunkBorders.ts';
import type { WorldData } from '../world/types.ts';

// The wind view's arrows, built on first show and again after the island grows.
//
// The wind view's arrows (`windView`, see WindView.ts): main.ts builds them on first show and again
// after the island grows (as the chunk borders), for the land shown, so their pipeline exists only
// on a page that shows them (a growth gives the mesh a new geometry under the same material).

type V3 = THREE.Node<'vec3'>;

// the arrows: their spacing (m) and lift above the canopy (m), over the meadow (inside the coast)
const STEP = 2, LIFT = 0.15;

/** The arrows over `data`'s land (see the header): one instanced mesh. */
export function buildWindArrows( data: WorldData, wind: WindUniforms ): THREE.Mesh {

	const mesh = new THREE.Mesh( windArrowGeometry( data ), windArrowMaterial( wind ) );
	mesh.name = 'wind-arrows';
	mesh.frustumCulled = false;
	mesh.castShadow = mesh.receiveShadow = false;
	return mesh;

}

/** The arrows' geometry over `data`'s land: a grown island's takes the mesh's material as it is. */
export function windArrowGeometry( data: WorldData ): THREE.InstancedBufferGeometry {

	const f = data.shore, cells: number[] = [];
	const x0 = Math.ceil( f.x0 / STEP ) * STEP, z0 = Math.ceil( f.z0 / STEP ) * STEP;
	for ( let z = z0; z < f.z0 + f.nz * f.cell; z += STEP ) for ( let x = x0; x < f.x0 + f.nx * f.cell; x += STEP ) {

		const d = sampleShore( f, x, z );
		if ( d > - 0.3 ) continue;
		cells.push( x, islandSurfaceHeight( x, z ) + CANOPY_TOP + LIFT, z, 0 );

	}
	// a flat arrow along +x, 1 m long, centred on the origin
	const shape = [
		[ - 0.5, - 0.05 ], [ 0.2, - 0.05 ], [ 0.2, 0.05 ], [ - 0.5, 0.05 ],
		[ 0.2, - 0.17 ], [ 0.5, 0 ], [ 0.2, 0.17 ],
	];
	const geometry = new THREE.InstancedBufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( shape.flatMap( ( [ x, z ] ) => [ x, 0, z ] ), 3 ) );
	geometry.setIndex( [ 0, 2, 1, 0, 3, 2, 4, 6, 5 ] );
	geometry.setAttribute( 'windCell', new THREE.InstancedBufferAttribute( new Float32Array( cells ), 4 ) );
	geometry.instanceCount = cells.length / 4;
	return geometry;

}

function windArrowMaterial( wind: WindUniforms ): THREE.MeshBasicNodeMaterial {

	const material = new THREE.MeshBasicNodeMaterial( { side: THREE.DoubleSide } );
	material.fog = false;
	const cell = attribute<'vec4'>( 'windCell', 'vec4' );
	const arrow = ( state: typeof wind.previous ): V3 => {

		const field = windField( state, cell.xz ).toVar();
		const side = vec2( field.y.negate(), field.x );
		const size = mix( float( 0.6 ), float( 1.8 ), field.w );
		const p = cell.xz.add( field.xy.mul( positionGeometry.x.mul( size ) ) ).add( side.mul( positionGeometry.z ) );
		return vec3( p.x, cell.y, p.y );

	};
	const swayed = setWindDisplacement( material, arrow, wind );
	useRestPoseShadows( material, cell.xyz, swayed, undefined, previousSway( material, wind ) );
	followWindMotionFlag( material );
	// brighter with the load the plants take there (Wind.ts `plantLoad`, full from 0.33), warmer
	// in a gust
	const field = varying( windField( wind, cell.xz ), 'vWindArrow' );
	const bright = clamp( field.z.div( 0.33 ), 0, 1 ).mul( 0.75 ).add( 0.25 );
	material.colorNode = mix( vec3( 0.55, 0.75, 1 ), vec3( 1, 0.85, 0.2 ), field.w ).mul( bright ).mul( GAIN );
	return material;

}
