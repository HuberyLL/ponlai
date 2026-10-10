/*!
 * mxPerlin3 ports three.js's MaterialX Perlin noise (src/nodes/materialx/MaterialXNoise.js:
 * mx_perlin_noise_float for a vec3, its lookup3 hash and gradients) from TSL to plain
 * TypeScript, so the CPU reads the same field as the shader.
 * Copyright (c) 2010-2026 three.js authors
 * Licensed under the MIT License (the three package's licence, shipped with the build).
 * three.js transpiled it from MaterialX's mx_noise.glsl (Contributors to the MaterialX project).
 */
// The puddles' hollow field on the CPU, so planting can keep out of the places where standing
// water collects. It must stay the twin of `puddleField` in Puddles.ts: the same two octaves of
// MaterialX Perlin noise (three's `mx_noise_float`), ported here with the same integer hash, so
// the two agree to float precision.

// The fullest waterline of `puddleField` (its level at full wetness): above it the ground floods
// in heavy rain. The ground's relief moves the line by at most 0.025.
export const PUDDLE_FULL_LEVEL = 0.63;
// The puddles never reach below this hollow value, whatever the ground's relief.
const PUDDLE_DRY_LEVEL = PUDDLE_FULL_LEVEL - 0.035;

/** Whether standing water can ever collect here, whatever the ground's relief: the plants keep off it. */
export function puddleGround( x: number, z: number ): boolean {

	return puddleHollows( x, z ) > PUDDLE_DRY_LEVEL;

}

/** The hollows of the puddle field at a world position (0 to 1; water stands above the level). */
export function puddleHollows( x: number, z: number ): number {

	return ( mxPerlin3( x / 3.2, z / 3.2, 0.37 ) * 0.7 + mxPerlin3( x / 1.1, z / 1.1, 4.1 ) * 0.3 ) * 0.5 + 0.5;

}

// MaterialX's Perlin noise as three.js implements it (MaterialXNoise.js: mx_perlin_noise_float
// for a vec3, Bob Jenkins' lookup3 final mix as the lattice hash). WGSL's u32( i32 ) keeps the
// bits, as `>>> 0` does.
const rotl = ( x: number, k: number ) => ( ( x << k ) | ( x >>> ( 32 - k ) ) ) >>> 0;

function bjfinal( a: number, b: number, c: number ): number {

	c = ( ( c ^ b ) - rotl( b, 14 ) ) >>> 0;
	a = ( ( a ^ c ) - rotl( c, 11 ) ) >>> 0;
	b = ( ( b ^ a ) - rotl( a, 25 ) ) >>> 0;
	c = ( ( c ^ b ) - rotl( b, 16 ) ) >>> 0;
	a = ( ( a ^ c ) - rotl( c, 4 ) ) >>> 0;
	b = ( ( b ^ a ) - rotl( a, 14 ) ) >>> 0;
	c = ( ( c ^ b ) - rotl( b, 24 ) ) >>> 0;
	return c;

}

const SEED = ( 0xdeadbeef + ( 3 << 2 ) + 13 ) >>> 0;

function hash3( x: number, y: number, z: number ): number {

	return bjfinal( ( SEED + ( x >>> 0 ) ) >>> 0, ( SEED + ( y >>> 0 ) ) >>> 0, ( SEED + ( z >>> 0 ) ) >>> 0 );

}

function gradient( hash: number, x: number, y: number, z: number ): number {

	const h = hash & 15;
	const u = h < 8 ? x : y;
	const v = h < 4 ? y : ( h === 12 || h === 14 ) ? x : z;
	return ( h & 1 ? - u : u ) + ( h & 2 ? - v : v );

}

const fade = ( t: number ) => t * t * t * ( t * ( t * 6 - 15 ) + 10 );

export function mxPerlin3( px: number, py: number, pz: number ): number {

	const X = Math.floor( px ), Y = Math.floor( py ), Z = Math.floor( pz );
	const fx = px - X, fy = py - Y, fz = pz - Z;
	const s = fade( fx ), t = fade( fy ), r = fade( fz );
	const g = ( i: number, j: number, k: number ) => gradient( hash3( X + i, Y + j, Z + k ), fx - i, fy - j, fz - k );
	const s1 = 1 - s, t1 = 1 - t, r1 = 1 - r;
	const near = t1 * ( g( 0, 0, 0 ) * s1 + g( 1, 0, 0 ) * s ) + t * ( g( 0, 1, 0 ) * s1 + g( 1, 1, 0 ) * s );
	const far = t1 * ( g( 0, 0, 1 ) * s1 + g( 1, 0, 1 ) * s ) + t * ( g( 0, 1, 1 ) * s1 + g( 1, 1, 1 ) * s );
	return 0.982 * ( r1 * near + r * far );

}
