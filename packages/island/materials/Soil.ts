import * as THREE from 'three/webgpu';
import { float, texture, uniform } from 'three/tsl';
import { sampleMeadow } from './Meadow.ts';
import { ISLAND_TOP, SWELL, islandSurfaceHeight, islandSwell } from '../world/WorldShapes.ts';
import { GROWTH } from '../world/IslandGrowth.ts';
import { noise3, smoothstep } from '../../render/data.ts';
import { groveAt } from '../world/BambooGroves.ts';

// The root bed cut open at the meadow's shoulder (TerrainMaterial's root-soil cut).
// The narrow height encoding (the fine noise over the plateau's swells) retains millimetre precision
// in an inexpensive RGBA8 map.
// Thickness and exposed patches vary independently, so the root bed never becomes a belt.
// The map covers the land lattice's whole extent, wherever the island grows, at 0.25 m.
// Its second layer holds the bamboo groves' density there (R: BambooGroves.ts `groveAt`, drawn at
// GROVE_CELL and filled in between), and the plateau's swell
// (WorldShapes.ts `islandSwell`, over +-SWELL_RANGE, in 16 bits: G the high byte, B the low, which
// linear filtering recombines) for the meadow's top (both TerrainMaterial.ts): functions of the
// world alone, never of the land, so a grown island keeps them. One array of the two keeps
// the terrain's fragment stage within WebGPU's 16 sampled textures. The meadow's blades read the
// groves' density too, at their roots (world/Grass.ts `aoCanopy`, `grass.ao.canopy`), through a
// base node the map is set on when it is made (`soilGroveAt`).
export const SOIL_EXTENT = 2 * GROWTH.half;
export const SOIL_HEIGHT_RANGE = 0.5;
const SOIL_SIZE = SOIL_EXTENT * 4;
const GROVE_CELL = 0.5;
export const SWELL_RANGE = SWELL.height + 0.1;

/** The map's second layer at world `xz` (a node): the bamboo groves' density and the plateau's
 * swell (m about ISLAND_TOP). */
export function soilGroveSwell( map: THREE.Texture, xz: THREE.Node<'vec2'> ): { grove: THREE.Node<'float'>; swell: THREE.Node<'float'> } {

	const s = texture( map, xz.div( SOIL_EXTENT ).add( 0.5 ) ).depth( float( 1 ) ).level( float( 0 ) ).toVar();
	return { grove: s.r, swell: s.g.mul( 65280 / 65535 ).add( s.b.mul( 255 / 65535 ) ).mul( 2 ).sub( 1 ).mul( SWELL_RANGE ) };

}

/** The base node the grass samples the map's second layer through (`soilGroveAt`): a placeholder of
 * the same kind until the map is made (`createSoilTexture` sets it). */
const soilBase = /*@__PURE__*/ texture( placeholder() );

function placeholder(): THREE.DataArrayTexture {

	const t = new THREE.DataArrayTexture( new Uint8Array( 4 * 2 ), 1, 1, 2 );
	t.colorSpace = THREE.NoColorSpace;
	t.magFilter = THREE.LinearFilter;
	t.minFilter = THREE.LinearFilter;
	t.generateMipmaps = false;
	t.needsUpdate = true;
	return t;

}

/** The bamboo groves' density at world `xz` (a node, any stage: sampled at level 0), from the map's
 * second layer through its base node. */
export function soilGroveAt( xz: THREE.Node<'vec2'> ): THREE.Node<'float'> {

	return soilBase.sample( xz.div( SOIL_EXTENT ).add( 0.5 ) ).depth( float( 1 ) ).level( float( 0 ) ).r;

}

export const soilUniforms = {
	strength: uniform( 1 ),
	depth: uniform( 1 ),
};

/** Shows the soil layer or leaves it out: the app's switch (`soil`, the GUI's Ground folder). */
export function setSoilStrength( on: boolean ): void {

	soilUniforms.strength.value = on ? 1 : 0;

}

export const SOIL_PALETTE = {
	cut: [ 0.18, 0.115, 0.062 ],
	root: [ 0.12, 0.075, 0.039 ],
} as const;

interface SoilSample { thickness: number; exposure: number; variation: number }

function sampleWithGrowth( x: number, z: number, growth: number ): SoilSample {

	const broad = noise3( x * 0.27 + 3.8, 8.7, z * 0.27 - 2.1 ) * 0.5 + 0.5;
	const pocket = noise3( x * 0.61 - 6.2, 3.4, z * 0.61 + 7.1 ) * 0.5 + 0.5;
	const depth = noise3( x * 0.19 - 2.6, 5.8, z * 0.19 + 9.3 ) * 0.5 + 0.5;
	// Broad patches expose only part of the rim. Short growth increases their strength
	// after the patch gate, so a short meadow patch is not automatically bare soil.
	const exposure = smoothstep( 0.51, 0.68, broad * 0.72 + pocket * 0.28 ) * ( 0.3 + ( 1 - growth ) * 0.7 );
	const thickness = smoothstep( 0.23, 0.72, depth * 0.7 + growth * 0.3 );
	// The quarter-metre grid supports colour drifts; grain comes from the existing
	// terrain detail maps so this field does not bake sub-texel freckles into the lip.
	const variation = noise3( x * 1.05 + 8.6, 1.7, z * 1.05 - 5.3 ) * 0.5 + 0.5;
	return { thickness, exposure, variation };

}

function sampleSoil( x: number, z: number ): SoilSample {

	return sampleWithGrowth( x, z, sampleMeadow( x, z ).growth );

}

const pack = ( value: number ) => Math.round( Math.min( 1, Math.max( 0, value ) ) * 255 );

export function createSoilTexture(): THREE.DataArrayTexture {

	const data = new Uint8Array( SOIL_SIZE * SOIL_SIZE * 4 * 2 );
	for ( let row = 0; row < SOIL_SIZE; row ++ ) {

		const z = ( ( row + 0.5 ) / SOIL_SIZE - 0.5 ) * SOIL_EXTENT;
		for ( let column = 0; column < SOIL_SIZE; column ++ ) {

			const x = ( ( column + 0.5 ) / SOIL_SIZE - 0.5 ) * SOIL_EXTENT;
			const soil = sampleSoil( x, z );
			const k = ( row * SOIL_SIZE + column ) * 4;
			const swell = islandSwell( x, z );
			data[ k ] = pack( ( islandSurfaceHeight( x, z ) - ISLAND_TOP - swell ) / SOIL_HEIGHT_RANGE + 0.5 );
			const level = Math.round( Math.min( 1, Math.max( 0, swell / SWELL_RANGE * 0.5 + 0.5 ) ) * 65535 );
			data[ SOIL_SIZE * SOIL_SIZE * 4 + k + 1 ] = level >> 8;
			data[ SOIL_SIZE * SOIL_SIZE * 4 + k + 2 ] = level & 255;
			data[ k + 1 ] = pack( soil.thickness );
			data[ k + 2 ] = pack( soil.exposure );
			data[ k + 3 ] = pack( soil.variation );

		}

	}

	// the groves at GROVE_CELL, read bilinearly at the soil's texels
	const n = Math.round( SOIL_EXTENT / GROVE_CELL ) + 1, grove = new Float32Array( n * n );
	const at = ( i: number ) => i * GROVE_CELL - SOIL_EXTENT / 2;
	for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) grove[ j * n + i ] = groveAt( at( i ), at( j ) );

	const layer = SOIL_SIZE * SOIL_SIZE * 4;
	for ( let row = 0; row < SOIL_SIZE; row ++ ) for ( let column = 0; column < SOIL_SIZE; column ++ ) {

		const u = ( column + 0.5 ) / SOIL_SIZE * ( n - 1 ), v = ( row + 0.5 ) / SOIL_SIZE * ( n - 1 );
		const i = Math.min( Math.floor( u ), n - 2 ), j = Math.min( Math.floor( v ), n - 2 ), fu = u - i, fv = v - j;
		const lerp = ( f: Float32Array ) => ( f[ j * n + i ] * ( 1 - fu ) + f[ j * n + i + 1 ] * fu ) * ( 1 - fv ) + ( f[ ( j + 1 ) * n + i ] * ( 1 - fu ) + f[ ( j + 1 ) * n + i + 1 ] * fu ) * fv;
		const k = layer + ( row * SOIL_SIZE + column ) * 4;
		data[ k ] = pack( lerp( grove ) );

	}

	const texture = new THREE.DataArrayTexture( data, SOIL_SIZE, SOIL_SIZE, 2 );
	texture.colorSpace = THREE.NoColorSpace;
	texture.magFilter = THREE.LinearFilter;
	texture.minFilter = THREE.LinearFilter;
	texture.wrapS = THREE.ClampToEdgeWrapping;
	texture.wrapT = THREE.ClampToEdgeWrapping;
	// Height mip averages could smear a root band across neighbouring rock shoulders.
	texture.generateMipmaps = false;
	texture.needsUpdate = true;
	texture.name = 'soil-support';
	soilBase.value = texture;
	return texture;

}

