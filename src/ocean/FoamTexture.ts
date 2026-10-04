/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';

export const FOAM_TILE = 4; // Metres; the main cells average 0.25 m across.

// Tidewater's SurfFoam.js laceData, baked on the CPU into a repeatable, mipmapped pattern.
// R: distance from a bubble strand (0 on the strand, 1 inside a clear hole).
// G: small bubble clusters along strands. B: soft density mottling. A: cell randomness.
// Threshold R with the simulated coverage: fresh whitewater fills the holes, then opens into lace.
export function createFoamTexture( size = 512 ): THREE.DataTexture {

	if ( size < 32 || ( size & ( size - 1 ) ) !== 0 ) throw new RangeError( 'Foam texture size must be a power of two, at least 32.' );
	const started = performance.now();
	const data = laceData( size );
	const mips = [ { data, width: size, height: size } ];
	let src = data, s = size;
	while ( s > 1 ) {

		const h = s >> 1;
		const dst = new Uint8Array( h * h * 4 );
		for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < h; x ++ ) for ( let c = 0; c < 4; c ++ ) {

			const a = src[ ( ( 2 * y ) * s + 2 * x ) * 4 + c ], b = src[ ( ( 2 * y ) * s + 2 * x + 1 ) * 4 + c ];
			const d = src[ ( ( 2 * y + 1 ) * s + 2 * x ) * 4 + c ], e = src[ ( ( 2 * y + 1 ) * s + 2 * x + 1 ) * 4 + c ];
			dst[ ( y * h + x ) * 4 + c ] = ( a + b + d + e + 2 ) >> 2;

		}

		mips.push( { data: dst, width: h, height: h } );
		src = dst;
		s = h;

	}

	const tex = new THREE.DataTexture( data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType );
	tex.name = 'shoreFoamLace';
	tex.mipmaps = mips;
	tex.generateMipmaps = false;
	tex.minFilter = THREE.LinearMipmapLinearFilter;
	tex.magFilter = THREE.LinearFilter;
	tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
	tex.anisotropy = 8;
	tex.userData.foamPattern = { size, tileMeters: FOAM_TILE, buildMs: performance.now() - started };
	tex.needsUpdate = true;
	return tex;

}

function laceData( size: number ): Uint8Array {

	const data = new Uint8Array( size * size * 4 );
	const hash = ( x: number, y: number, seed: number ) => {

		let h = ( x * 374761393 + y * 668265263 + seed * 2246822519 ) | 0;
		h = Math.imul( h ^ ( h >>> 13 ), 1274126177 );
		h ^= h >>> 16;
		return ( h >>> 0 ) / 4294967296;

	};
	const wrap = ( x: number, n: number ) => ( ( x % n ) + n ) % n;
	const smoothstep = ( a: number, b: number, x: number ) => {

		const t = Math.min( 1, Math.max( 0, ( x - a ) / ( b - a ) ) );
		return t * t * ( 3 - 2 * t );

	};
	const vnoise = ( x: number, y: number, n: number, seed: number ) => {

		const i = Math.floor( x ), j = Math.floor( y );
		const fx = x - i, fy = y - j;
		const ux = fx * fx * ( 3 - 2 * fx ), uy = fy * fy * ( 3 - 2 * fy );
		const a = hash( wrap( i, n ), wrap( j, n ), seed ), b = hash( wrap( i + 1, n ), wrap( j, n ), seed );
		const c = hash( wrap( i, n ), wrap( j + 1, n ), seed ), d = hash( wrap( i + 1, n ), wrap( j + 1, n ), seed );
		return ( a * ( 1 - ux ) + b * ux ) * ( 1 - uy ) + ( c * ( 1 - ux ) + d * ux ) * uy;

	};
	const fbm = ( x: number, y: number, n: number, seed: number, octaves = 3 ) => {

		let value = 0, amplitude = 0.5, total = 0;
		for ( let o = 0; o < octaves; o ++ ) {

			const frequency = 1 << o;
			value += vnoise( x * frequency, y * frequency, n * frequency, seed + o * 17 ) * amplitude;
			total += amplitude;
			amplitude *= 0.5;

		}

		return value / total;

	};
	// F1/F2 supply a cell-edge distance; fixed integer seeds keep every bake identical.
	const voronoi = ( x: number, y: number, n: number, seed: number ): [ number, number, number ] => {

		const i = Math.floor( x ), j = Math.floor( y );
		let first = 9, second = 9, id = 0;
		for ( let dy = - 1; dy <= 1; dy ++ ) for ( let dx = - 1; dx <= 1; dx ++ ) {

			const ci = i + dx, cj = j + dy;
			const wi = wrap( ci, n ), wj = wrap( cj, n );
			const px = ci + 0.15 + 0.7 * hash( wi, wj, seed ), py = cj + 0.15 + 0.7 * hash( wi, wj, seed + 1 );
			const distance = Math.hypot( px - x, py - y );
			if ( distance < first ) {

				second = first;
				first = distance;
				id = hash( wi, wj, seed + 2 );

			} else if ( distance < second ) second = distance;

		}

		return [ first, second, id ];

	};

	const count = size * size;
	const warpedU = new Float32Array( count ), warpedV = new Float32Array( count ), contours = new Float32Array( count );
	for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) {

		const u = ( x + 0.5 ) / size, v = ( y + 0.5 ) / size;
		// Two periodic warps bend the cell boundaries without a visible square grid.
		const w1x = ( fbm( u * 3, v * 3, 3, 3 ) - 0.5 ) * 0.16, w1y = ( fbm( u * 3 + 5.2, v * 3 + 1.3, 3, 7 ) - 0.5 ) * 0.16;
		const w2x = ( fbm( ( u + w1x ) * 9, ( v + w1y ) * 9, 9, 13 ) - 0.5 ) * 0.07;
		const w2y = ( fbm( ( u + w1x ) * 9 + 2.7, ( v + w1y ) * 9, 9, 17 ) - 0.5 ) * 0.07;
		const k = y * size + x;
		warpedU[ k ] = u + w1x + w2x;
		warpedV[ k ] = v + w1y + w2y;
		contours[ k ] = fbm( warpedU[ k ] * 6, warpedV[ k ] * 6, 6, 91 );

	}

	const cells = 16, halfCell = 0.5 / cells;
	const distances = new Float32Array( count );
	for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) {

		const u = ( x + 0.5 ) / size, v = ( y + 0.5 ) / size;
		const k = y * size + x;
		const [ first, second, id ] = voronoi( warpedU[ k ] * cells, warpedV[ k ] * cells, cells, 11 );
		const cellDistance = ( second - first ) * 0.5 / cells;
		const xl = wrap( x - 1, size ), xr = wrap( x + 1, size ), yd = wrap( y - 1, size ), yu = wrap( y + 1, size );
		const gx = ( contours[ y * size + xr ] - contours[ y * size + xl ] ) * size * 0.5;
		const gy = ( contours[ yu * size + x ] - contours[ yd * size + x ] ) * size * 0.5;
		const gradient = Math.max( Math.hypot( gx, gy ), 0.5 );
		const contour = contours[ k ];
		const loopDistance = Math.min( Math.abs( contour - 0.5 ), Math.abs( contour - 0.36 ), Math.abs( contour - 0.64 ) ) / gradient;
		const fine = fbm( u * 24, v * 24, 24, 5, 2 );
		const gaps = smoothstep( 0.52, 0.36, fbm( u * 10 + 3.1, v * 10, 10, 31 ) );
		// Keep the small cell edges visible as foam thins. A larger bias removes them first,
		// leaving only the low-frequency contours as long, unrelated white lines.
		const edgeBreak = smoothstep( 0.15, 0.8, id ) * halfCell * 0.35;
		const edgeDistance = cellDistance * 1.35 + 0.0006 + edgeBreak;
		// Each cell retains a different part of the contour. Thin foam keeps short curved
		// fragments; denser foam reconnects them without adding flickering texel noise.
		const contourBreak = smoothstep( 0.2, 0.75, id ) * halfCell * 0.28;
		const distance = Math.min( edgeDistance, loopDistance + contourBreak ) / halfCell * ( 0.75 + 0.5 * fine ) + gaps * 0.22;
		const mottle = fbm( u * 3, v * 3, 3, 71, 4 );
		const [ bubbleDistance, , bubbleId ] = voronoi( u * 120, v * 120, 120, 61 );
		const radius = 0.1 + 0.22 * bubbleId;
		const bubble = smoothstep( radius, radius * 0.35, bubbleDistance ) * ( bubbleId > 0.45 ? 1 : 0 );
		const cluster = bubble * ( 0.25 + 0.75 * smoothstep( 0.5, 0.1, distance ) );
		distances[ k ] = Math.min( 1, distance );
		data[ k * 4 + 1 ] = Math.round( Math.min( 1, cluster ) * 255 );
		data[ k * 4 + 2 ] = Math.round( mottle * 255 );
		data[ k * 4 + 3 ] = Math.round( id * 255 );

	}

	// Round the holes while retaining the exact distances near the thin strands.
	const exact = new Float32Array( distances ), temporary = new Float32Array( count );
	for ( let iteration = 0; iteration < 2; iteration ++ ) {

		for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) {

			let sum = 0;
			for ( let offset = - 2; offset <= 2; offset ++ ) sum += distances[ y * size + wrap( x + offset, size ) ];
			temporary[ y * size + x ] = sum / 5;

		}

		for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) {

			let sum = 0;
			for ( let offset = - 2; offset <= 2; offset ++ ) sum += temporary[ wrap( y + offset, size ) * size + x ];
			distances[ y * size + x ] = sum / 5;

		}

	}

	for ( let k = 0; k < count; k ++ ) {

		data[ k * 4 ] = Math.round( ( exact[ k ] + ( distances[ k ] - exact[ k ] ) * smoothstep( 0.12, 0.45, exact[ k ] ) ) * 255 );

	}

	return data;

}
