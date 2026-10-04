/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';

export const GLITTER_TILE = 8.8; // Metres per repeat of the mask.

// Soft, repeatable value-noise mottling that breaks the optional glitter lobe into patches.
// It is the density channel of tidewater's SurfFoam.js lace pattern, baked on the CPU
// with the same hash and seed, so the glitter keeps its earlier layout.
export function createGlitterMask( size = 256 ): THREE.DataTexture {

	const hash = ( x: number, y: number, seed: number ) => {

		let h = ( x * 374761393 + y * 668265263 + seed * 2246822519 ) | 0;
		h = Math.imul( h ^ ( h >>> 13 ), 1274126177 );
		h ^= h >>> 16;
		return ( h >>> 0 ) / 4294967296;

	};
	const wrap = ( x: number, n: number ) => ( ( x % n ) + n ) % n;
	const vnoise = ( x: number, y: number, n: number, seed: number ) => {

		const i = Math.floor( x ), j = Math.floor( y );
		const fx = x - i, fy = y - j;
		const ux = fx * fx * ( 3 - 2 * fx ), uy = fy * fy * ( 3 - 2 * fy );
		const a = hash( wrap( i, n ), wrap( j, n ), seed ), b = hash( wrap( i + 1, n ), wrap( j, n ), seed );
		const c = hash( wrap( i, n ), wrap( j + 1, n ), seed ), d = hash( wrap( i + 1, n ), wrap( j + 1, n ), seed );
		return ( a * ( 1 - ux ) + b * ux ) * ( 1 - uy ) + ( c * ( 1 - ux ) + d * ux ) * uy;

	};

	const data = new Uint8Array( size * size );
	for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) {

		const u = ( x + 0.5 ) / size * 3, v = ( y + 0.5 ) / size * 3;
		let value = 0, amplitude = 0.5, total = 0;
		for ( let o = 0; o < 4; o ++ ) {

			const frequency = 1 << o;
			value += vnoise( u * frequency, v * frequency, 3 * frequency, 71 + o * 17 ) * amplitude;
			total += amplitude;
			amplitude *= 0.5;

		}

		data[ y * size + x ] = Math.round( value / total * 255 );

	}

	const tex = new THREE.DataTexture( data, size, size, THREE.RedFormat, THREE.UnsignedByteType );
	tex.name = 'waterGlitterMask';
	tex.generateMipmaps = true;
	tex.minFilter = THREE.LinearMipmapLinearFilter;
	tex.magFilter = THREE.LinearFilter;
	tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
	tex.needsUpdate = true;
	return tex;

}
