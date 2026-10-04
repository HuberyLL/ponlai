/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 * Based on src/world/ShoreField.js at 4811ba48d795197de5621985f404e765c0b7c0ef.
 */

import * as THREE from 'three/webgpu';
import type { WorldData, ShoreField } from '../world/types.ts';

const GRAVITY = 9.81;
const MAX_RES = 256;
const MIN_SPEED_DEPTH = 0.15;

class MinHeap {

	keys: Float64Array;
	values: Int32Array;
	size = 0;

	constructor( capacity: number ) {

		this.keys = new Float64Array( capacity );
		this.values = new Int32Array( capacity );

	}

	push( key: number, value: number ): void {

		if ( this.size === this.keys.length ) {

			const keys = new Float64Array( this.size * 2 ), values = new Int32Array( this.size * 2 );
			keys.set( this.keys ); values.set( this.values );
			this.keys = keys; this.values = values;

		}
		let i = this.size ++;
		while ( i > 0 ) {

			const parent = ( i - 1 ) >> 1;
			if ( this.keys[ parent ] <= key ) break;
			this.keys[ i ] = this.keys[ parent ]; this.values[ i ] = this.values[ parent ];
			i = parent;

		}
		this.keys[ i ] = key; this.values[ i ] = value;

	}

	pop(): number {

		const value = this.values[ 0 ];
		const key = this.keys[ -- this.size ], last = this.values[ this.size ];
		let i = 0;
		while ( true ) {

			let child = i * 2 + 1;
			if ( child >= this.size ) break;
			if ( child + 1 < this.size && this.keys[ child + 1 ] < this.keys[ child ] ) child ++;
			if ( this.keys[ child ] >= key ) break;
			this.keys[ i ] = this.keys[ child ]; this.values[ i ] = this.values[ child ];
			i = child;

		}
		this.keys[ i ] = key; this.values[ i ] = last;
		return value;

	}

}

function sampleShore( field: ShoreField, x: number, z: number ): number {

	const fx = Math.max( 0, Math.min( field.nx - 1, ( x - field.x0 ) / field.cell - 0.5 ) );
	const fz = Math.max( 0, Math.min( field.nz - 1, ( z - field.z0 ) / field.cell - 0.5 ) );
	const i = Math.floor( fx ), j = Math.floor( fz ), u = fx - i, v = fz - j;
	const ii = Math.min( i + 1, field.nx - 1 ), jj = Math.min( j + 1, field.nz - 1 );
	const a = field.data[ j * field.nx + i ], b = field.data[ j * field.nx + ii ];
	const c = field.data[ jj * field.nx + i ], d = field.data[ jj * field.nx + ii ];
	return ( a + ( b - a ) * u ) * ( 1 - v ) + ( c + ( d - c ) * u ) * v;

}

function seabedSampler( { positions, res }: WorldData[ 'seabed' ] ): ( x: number, z: number ) => number {

	// The seabed is a nonuniform rectilinear grid. Search its stored axes rather than
	// interpolating in index space, which would move depth contours on the warped mesh.
	const stride = res + 1;
	const xs = new Float64Array( stride ), zs = new Float64Array( stride );
	for ( let i = 0; i <= res; i ++ ) {

		xs[ i ] = positions[ i * 3 ]; zs[ i ] = positions[ i * stride * 3 + 2 ];

	}
	const cellAt = ( axis: Float64Array, p: number ): number => {

		let lo = 0, hi = res;
		while ( lo + 1 < hi ) {

			const middle = ( lo + hi ) >> 1;
			if ( axis[ middle ] <= p ) lo = middle; else hi = middle;

		}
		return Math.min( lo, res - 1 );

	};
	return ( x, z ) => {

		const i = cellAt( xs, x ), j = cellAt( zs, z );
		const u = Math.max( 0, Math.min( 1, ( x - xs[ i ] ) / ( xs[ i + 1 ] - xs[ i ] ) ) );
		const v = Math.max( 0, Math.min( 1, ( z - zs[ j ] ) / ( zs[ j + 1 ] - zs[ j ] ) ) );
		const a = ( j * stride + i ) * 3 + 1, b = a + 3, c = a + stride * 3, d = c + 3;
		return ( positions[ a ] + ( positions[ b ] - positions[ a ] ) * u ) * ( 1 - v )
			+ ( positions[ c ] + ( positions[ d ] - positions[ c ] ) * u ) * v;

	};

}

function phaseSpeed( depth: number, omega: number ): number {

	// The finite-depth dispersion relation supplies phase speed, not the shallow-water
	// approximation: a 3.8 s offshore swell must not travel at sqrt( g * deepDepth ).
	const omega2 = omega * omega;
	let lo = 0, hi = Math.max( omega2 / GRAVITY, omega / Math.sqrt( GRAVITY * depth ) ) * 2;
	while ( GRAVITY * hi * Math.tanh( hi * depth ) < omega2 ) hi *= 2;
	for ( let iteration = 0; iteration < 32; iteration ++ ) {

		const k = ( lo + hi ) * 0.5;
		if ( GRAVITY * k * Math.tanh( k * depth ) < omega2 ) lo = k; else hi = k;

	}
	return omega / ( ( lo + hi ) * 0.5 );

}

/**
 * An offline Eikonal field over exactly data.shore's domain. RGBA is arrival time (s),
 * dT/dx and dT/dz (s/m), and actual seabed depth (m, sea level 0). Rebuild after changing
 * direction or period; the caller owns disposal. Direction points along wave travel.
 */
export function createShoreWaveField( data: WorldData, direction: THREE.Vector2, period: number ): THREE.DataTexture {

	const started = performance.now();
	if ( ! Number.isFinite( period ) || period <= 0 ) throw new RangeError( 'Wave period must be positive and finite.' );
	const directionLength = direction.length();
	if ( ! Number.isFinite( directionLength ) || directionLength < 1e-8 ) throw new RangeError( 'Wave direction must be finite and nonzero.' );
	const dx = direction.x / directionLength, dz = direction.y / directionLength;
	const shore = data.shore;
	const scale = Math.min( 1, MAX_RES / Math.max( shore.nx, shore.nz ) );
	const nx = Math.max( 2, Math.round( shore.nx * scale ) ), nz = Math.max( 2, Math.round( shore.nz * scale ) );
	const width = shore.nx * shore.cell, height = shore.nz * shore.cell;
	const hx = width / nx, hz = height / nz, count = nx * nz;
	const arrival = new Float64Array( count ).fill( Infinity ), state = new Uint8Array( count );
	const depths = new Float32Array( count ), speeds = new Float32Array( count );
	const heightAt = seabedSampler( data.seabed );
	let maxDepth = MIN_SPEED_DEPTH;
	for ( let j = 0; j < nz; j ++ ) for ( let i = 0; i < nx; i ++ ) {

		const k = j * nx + i;
		const x = shore.x0 + ( i + 0.5 ) * hx, z = shore.z0 + ( j + 0.5 ) * hz;
		const bottom = heightAt( x, z );
		depths[ k ] = Number.isFinite( bottom ) ? Math.max( 0, - bottom ) : 0;
		if ( sampleShore( shore, x, z ) > 0 ) {

			speeds[ k ] = 1; maxDepth = Math.max( maxDepth, depths[ k ] );

		}

	}
	// A small speed lookup avoids solving dispersion separately for every texel.
	const omega = 2 * Math.PI / period, lookup = new Float64Array( 1024 );
	const depthSpan = Math.max( maxDepth - MIN_SPEED_DEPTH, 1e-8 );
	for ( let i = 0; i < lookup.length; i ++ ) lookup[ i ] = phaseSpeed( MIN_SPEED_DEPTH + depthSpan * i / ( lookup.length - 1 ), omega );
	for ( let k = 0; k < count; k ++ ) if ( speeds[ k ] > 0 ) {

		const f = Math.max( 0, Math.min( lookup.length - 1, ( depths[ k ] - MIN_SPEED_DEPTH ) / depthSpan * ( lookup.length - 1 ) ) );
		const i = Math.min( Math.floor( f ), lookup.length - 2 );
		speeds[ k ] = lookup[ i ] + ( lookup[ i + 1 ] - lookup[ i ] ) * ( f - i );

	}
	const referenceSpeed = lookup[ lookup.length - 1 ];
	// Subtract the earliest plane-wave arrival, in seconds. This gives a meaningful
	// phase origin at the upstream corner rather than adding an arbitrary world size.
	const upstreamX = shore.x0 + ( dx >= 0 ? 0.5 : nx - 0.5 ) * hx;
	const upstreamZ = shore.z0 + ( dz >= 0 ? 0.5 : nz - 0.5 ) * hz;
	const timeOffset = ( upstreamX * dx + upstreamZ * dz ) / referenceSpeed;
	const heap = new MinHeap( Math.max( 64, count * 2 ) );
	for ( let j = 0; j < nz; j ++ ) for ( let i = 0; i < nx; i ++ ) {

		if ( i !== 0 && j !== 0 && i !== nx - 1 && j !== nz - 1 ) continue;
		const k = j * nx + i;
		if ( speeds[ k ] <= 0 ) continue;
		const x = shore.x0 + ( i + 0.5 ) * hx, z = shore.z0 + ( j + 0.5 ) * hz;
		arrival[ k ] = ( x * dx + z * dz ) / referenceSpeed - timeOffset;
		state[ k ] = 1; heap.push( arrival[ k ], k );

	}
	const solve = ( i: number, j: number ): number => {

		const k = j * nx + i;
		const tx = Math.min( i > 0 && state[ k - 1 ] === 2 ? arrival[ k - 1 ] : Infinity,
			i < nx - 1 && state[ k + 1 ] === 2 ? arrival[ k + 1 ] : Infinity );
		const tz = Math.min( j > 0 && state[ k - nx ] === 2 ? arrival[ k - nx ] : Infinity,
			j < nz - 1 && state[ k + nx ] === 2 ? arrival[ k + nx ] : Infinity );
		const slowness = 1 / speeds[ k ];
		const oneAxis = Math.min( tx + hx * slowness, tz + hz * slowness );
		if ( ! Number.isFinite( tx ) || ! Number.isFinite( tz ) ) return oneAxis;
		const ax = 1 / ( hx * hx ), az = 1 / ( hz * hz ), a = ax + az;
		const low = Math.min( tx, tz ), x = tx - low, z = tz - low;
		const discriminant = a * slowness * slowness - ax * az * ( x - z ) ** 2;
		if ( discriminant <= 0 ) return oneAxis;
		const result = low + ( ax * x + az * z + Math.sqrt( discriminant ) ) / a;
		return result >= Math.max( tx, tz ) ? result : oneAxis;

	};
	while ( heap.size > 0 ) {

		const k = heap.pop();
		if ( state[ k ] === 2 ) continue;
		state[ k ] = 2;
		const i = k % nx, j = Math.floor( k / nx );
		const visit = ( ni: number, nj: number ): void => {

			if ( ni < 0 || ni >= nx || nj < 0 || nj >= nz ) return;
			const next = nj * nx + ni;
			if ( state[ next ] === 2 || speeds[ next ] <= 0 ) return;
			const time = solve( ni, nj );
			if ( time < arrival[ next ] ) {

				arrival[ next ] = time; state[ next ] = 1; heap.push( time, next );

			}

		};
		visit( i - 1, j ); visit( i + 1, j ); visit( i, j - 1 ); visit( i, j + 1 );

	}
	// Remove grid-scale FMM kinks without smoothing across an opaque island or moving
	// the prescribed border phase. Fine wave shape remains the renderer's responsibility.
	for ( let pass = 0; pass < 3; pass ++ ) {

		const previous = arrival.slice();
		for ( let j = 1; j < nz - 1; j ++ ) for ( let i = 1; i < nx - 1; i ++ ) {

			const k = j * nx + i;
			if ( state[ k ] !== 2 ) continue;
			let sum = previous[ k ] * 4, weight = 4;
			for ( const next of [ k - 1, k + 1, k - nx, k + nx ] ) if ( state[ next ] === 2 ) {

				sum += previous[ next ]; weight ++;

			}
			arrival[ k ] = sum / weight;

		}

	}
	const pixels = new Float32Array( count * 4 ), queue = new Int32Array( count );
	let head = 0, tail = 0;
	for ( let j = 0; j < nz; j ++ ) for ( let i = 0; i < nx; i ++ ) {

		const k = j * nx + i, t = arrival[ k ], out = k * 4;
		pixels[ out + 3 ] = depths[ k ];
		if ( state[ k ] !== 2 ) continue;
		const left = i > 0 && state[ k - 1 ] === 2, right = i < nx - 1 && state[ k + 1 ] === 2;
		const down = j > 0 && state[ k - nx ] === 2, up = j < nz - 1 && state[ k + nx ] === 2;
		pixels[ out ] = t;
		pixels[ out + 1 ] = left && right ? ( arrival[ k + 1 ] - arrival[ k - 1 ] ) / ( 2 * hx )
			: right ? ( arrival[ k + 1 ] - t ) / hx : left ? ( t - arrival[ k - 1 ] ) / hx : dx / referenceSpeed;
		pixels[ out + 2 ] = down && up ? ( arrival[ k + nx ] - arrival[ k - nx ] ) / ( 2 * hz )
			: up ? ( arrival[ k + nx ] - t ) / hz : down ? ( t - arrival[ k - nx ] ) / hz : dz / referenceSpeed;
		queue[ tail ++ ] = k;

	}
	// Extend from the nearest reached water cells into land. Copy T and its water-side
	// gradient together, keeping bilinear shoreline samples finite without crossing land
	// during propagation. Any disconnected water pocket receives the same safe extension.
	while ( head < tail ) {

		const k = queue[ head ++ ], i = k % nx, j = Math.floor( k / nx );
		const fill = ( ni: number, nj: number ): void => {

			if ( ni < 0 || ni >= nx || nj < 0 || nj >= nz ) return;
			const next = nj * nx + ni;
			if ( state[ next ] === 2 ) return;
			state[ next ] = 2;
			pixels[ next * 4 ] = pixels[ k * 4 ];
			pixels[ next * 4 + 1 ] = pixels[ k * 4 + 1 ]; pixels[ next * 4 + 2 ] = pixels[ k * 4 + 2 ];
			queue[ tail ++ ] = next;

		};
		fill( i - 1, j ); fill( i + 1, j ); fill( i, j - 1 ); fill( i, j + 1 );

	}
	if ( tail === 0 ) for ( let j = 0; j < nz; j ++ ) for ( let i = 0; i < nx; i ++ ) {

		const k = j * nx + i, x = shore.x0 + ( i + 0.5 ) * hx, z = shore.z0 + ( j + 0.5 ) * hz;
		pixels[ k * 4 ] = ( x * dx + z * dz ) / referenceSpeed - timeOffset;
		pixels[ k * 4 + 1 ] = dx / referenceSpeed; pixels[ k * 4 + 2 ] = dz / referenceSpeed;

	}
	const texture = new THREE.DataTexture( pixels, nx, nz, THREE.RGBAFormat, THREE.FloatType );
	texture.name = 'shoreWaveField';
	texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter;
	texture.wrapS = THREE.ClampToEdgeWrapping; texture.wrapT = THREE.ClampToEdgeWrapping;
	texture.generateMipmaps = false; texture.flipY = false; texture.needsUpdate = true;
	texture.userData.shoreWaveField = { period, direction: [ dx, dz ], referenceSpeed, timeOffset,
		x0: shore.x0, z0: shore.z0, width, height, cellX: hx, cellZ: hz, buildMs: performance.now() - started };
	return texture;

}
