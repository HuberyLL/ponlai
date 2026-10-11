/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import type { WorldData, ShoreField } from '../world/types.ts';

const MAX_RES = 256;

function sampleShore( field: ShoreField, x: number, z: number ): number {

	const fx = Math.max( 0, Math.min( field.nx - 1, ( x - field.x0 ) / field.cell - 0.5 ) );
	const fz = Math.max( 0, Math.min( field.nz - 1, ( z - field.z0 ) / field.cell - 0.5 ) );
	const i = Math.floor( fx ), j = Math.floor( fz ), u = fx - i, v = fz - j;
	const ii = Math.min( i + 1, field.nx - 1 ), jj = Math.min( j + 1, field.nz - 1 );
	const a = field.data[ j * field.nx + i ], b = field.data[ j * field.nx + ii ];
	const c = field.data[ jj * field.nx + i ], d = field.data[ jj * field.nx + ii ];
	return ( a + ( b - a ) * u ) * ( 1 - v ) + ( c + ( d - c ) * u ) * v;

}


// A geometric boundary only: confidence and distance gradient. Wave timing comes from FFT,
// so crossing wave systems never inherit the old single-period arrival-time field.
export function createShoreBoundaryField( data: WorldData ): THREE.DataTexture {

	const shore = data.shore;
	const scale = Math.min( 1, MAX_RES / Math.max( shore.nx, shore.nz ) );
	const nx = Math.max( 2, Math.round( shore.nx * scale ) ), nz = Math.max( 2, Math.round( shore.nz * scale ) );
	const width = shore.nx * shore.cell, height = shore.nz * shore.cell;
	const pixels = new Float32Array( nx * nz * 4 );
	for ( let j = 0; j < nz; j ++ ) for ( let i = 0; i < nx; i ++ ) {

		const x = shore.x0 + ( i + 0.5 ) * width / nx, z = shore.z0 + ( j + 0.5 ) * height / nz;
		const sd = sampleShore( shore, x, z );
		const gx = ( sampleShore( shore, x + 0.4, z ) - sampleShore( shore, x - 0.4, z ) ) / 0.8;
		const gz = ( sampleShore( shore, x, z + 0.4 ) - sampleShore( shore, x, z - 0.4 ) ) / 0.8;
		const k = ( j * nx + i ) * 4;
		pixels[ k ] = sd;
		pixels[ k + 1 ] = Math.min( 1, Math.max( 0, ( Math.hypot( gx, gz ) - 0.45 ) / 0.45 ) );
		pixels[ k + 2 ] = gx; pixels[ k + 3 ] = gz;

	}
	const texture = new THREE.DataTexture( pixels, nx, nz, THREE.RGBAFormat, THREE.FloatType );
	texture.name = 'shoreWaveBoundary';
	texture.minFilter = texture.magFilter = THREE.LinearFilter;
	texture.generateMipmaps = false; texture.flipY = false; texture.needsUpdate = true;
	return texture;

}

/**
 * Directional energy shelter for the dominant swell. Our closed-island
 * extension: Tidewater's local direction alignment alone does not test intervening land.
 * R: swell amplitude transmission, G: central-ray visibility, BA: spatial derivatives of R.
 * This is an art-directed soft wave shadow, not a diffraction or fluid solver.
 */
export function createShoreShelterField( data: WorldData, direction: THREE.Vector2, spreadDegrees = 18 ): THREE.DataTexture {

	const started = performance.now();
	const shoreGrid = data.shore;
	const scale = Math.min( 1, MAX_RES / Math.max( shoreGrid.nx, shoreGrid.nz ) );
	const nx = Math.max( 2, Math.round( shoreGrid.nx * scale ) ), nz = Math.max( 2, Math.round( shoreGrid.nz * scale ) );
	const info = { x0: shoreGrid.x0, z0: shoreGrid.z0, width: shoreGrid.nx * shoreGrid.cell, height: shoreGrid.nz * shoreGrid.cell,
		cellX: shoreGrid.nx * shoreGrid.cell / nx, cellZ: shoreGrid.nz * shoreGrid.cell / nz };
	const dx = direction.x, dz = direction.y;
	const shore = data.shore, count = nx * nz;
	const visible = new Float32Array( count ), direct = new Float32Array( count );
	const water = new Uint8Array( count ), distances = new Float32Array( count );
	const angles = [ - spreadDegrees, - spreadDegrees / 2, 0, spreadDegrees / 2, spreadDegrees ], weights = [ 1, 2, 6, 2, 1 ];
	const rays = angles.map( ( degrees, i ) => {

		const a = degrees * Math.PI / 180;
		return { x: - dx * Math.cos( a ) + dz * Math.sin( a ), z: - dx * Math.sin( a ) - dz * Math.cos( a ), weight: weights[ i ] };

	} );
	const x1 = info.x0 + info.width, z1 = info.z0 + info.height;
	const minimumStep = Math.min( info.cellX, info.cellZ, shore.cell ) * 0.5;
	const trace = ( x: number, z: number, rx: number, rz: number ): number => {

		let distance = minimumStep;
		// The shore SDF is sampled more densely than this field. Conservative, capped steps
		// retain narrow rock shoulders without marching at fixed resolution across open sea.
		while ( distance < Math.hypot( info.width, info.height ) ) {

			const px = x + rx * distance, pz = z + rz * distance;
			if ( px < info.x0 || pz < info.z0 || px > x1 || pz > z1 ) return 1;
			const clearance = sampleShore( shore, px, pz );
			// A millimetre tolerance covers grazing contacts below the shore-grid precision.
			if ( clearance <= 0.001 ) return 0;
			distance += Math.max( minimumStep, Math.min( 2, clearance * 0.65 ) );

		}
		return 1;

	};
	for ( let j = 0; j < nz; j ++ ) for ( let i = 0; i < nx; i ++ ) {

		const k = j * nx + i, x = info.x0 + ( i + 0.5 ) * info.cellX, z = info.z0 + ( j + 0.5 ) * info.cellZ;
		const sd = sampleShore( shore, x, z );
		distances[ k ] = sd;
		if ( sd <= 0 ) continue;
		water[ k ] = 1;
		let sum = 0;
		for ( let ray = 0; ray < rays.length; ray ++ ) {

			const r = rays[ ray ], visibility = trace( x, z, r.x, r.z );
			sum += visibility * r.weight;
			if ( ray === 2 ) direct[ k ] = visibility;

		}
		visible[ k ] = sum / 12;

	}
	// Blur water neighbours only. This removes fan/grid steps at penumbra boundaries
	// without bleeding a fully exposed wave through the solid island into a small inlet.
	for ( let pass = 0; pass < 4; pass ++ ) {

		const previous = visible.slice();
		for ( let j = 0; j < nz; j ++ ) for ( let i = 0; i < nx; i ++ ) {

			const k = j * nx + i;
			if ( ! water[ k ] ) continue;
			let sum = previous[ k ] * 4, weight = 4;
			for ( const next of [ i > 0 ? k - 1 : - 1, i < nx - 1 ? k + 1 : - 1, j > 0 ? k - nx : - 1, j < nz - 1 ? k + nx : - 1 ] ) {

				if ( next >= 0 && water[ next ] ) { sum += previous[ next ]; weight ++; }

			}
			visible[ k ] = sum / weight;

		}

	}
	const pixels = new Float32Array( count * 4 );
	const amplitude = ( k: number ): number => {

		if ( ! water[ k ] ) return 0;
		// Recover distant wind sea before the finite field edge; clamp-to-edge samples
		// must not carry an infinite, straight shadow strip across the offshore FFT. The
		// shore's distance is clamped to LAND_REACH (24 m, the chunks' shore tiles), so the
		// recovery ends there.
		const t = Math.max( 0, Math.min( 1, ( distances[ k ] - 12 ) / 12 ) );
		const recovery = t * t * ( 3 - 2 * t );
		const i = k % nx, j = Math.floor( k / nx );
		const border = Math.min( ( i + 0.5 ) * info.cellX, ( nx - i - 0.5 ) * info.cellX,
			( j + 0.5 ) * info.cellZ, ( nz - j - 0.5 ) * info.cellZ );
		const edge = Math.max( 0, Math.min( 1, ( border - 1 ) / 4 ) );
		const edgeWeight = edge * edge * ( 3 - 2 * edge );
		// The cached correction has an exact zero rim at every heading. Only the local
		// energy shadow is bounded; the incident FFT waves continue over the whole sea.
		return 1 - ( 1 - ( 0.06 + 0.94 * visible[ k ] ) ) * ( 1 - recovery ) * edgeWeight;

	};
	for ( let j = 0; j < nz; j ++ ) for ( let i = 0; i < nx; i ++ ) {

		const k = j * nx + i, out = k * 4;
		pixels[ out ] = amplitude( k ); pixels[ out + 1 ] = direct[ k ];
		if ( ! water[ k ] ) continue;
		// One-sided water differences avoid an artificial damping-gradient seam at land.
		const left = i > 0 && water[ k - 1 ] ? k - 1 : k, right = i < nx - 1 && water[ k + 1 ] ? k + 1 : k;
		const down = j > 0 && water[ k - nx ] ? k - nx : k, up = j < nz - 1 && water[ k + nx ] ? k + nx : k;
		pixels[ out + 2 ] = ( amplitude( right ) - amplitude( left ) ) / Math.max( ( right - left ) * info.cellX, info.cellX );
		pixels[ out + 3 ] = ( amplitude( up ) - amplitude( down ) ) / Math.max( ( up - down ) / nx * info.cellZ, info.cellZ );

	}
	// Extend the water-side amplitude and gradient into land for linear filtering. A zero
	// land amplitude would add a false shoreline ramp that its one-sided gradient omits.
	// This extension never participates in tracing or smoothing.
	const queue = new Int32Array( count ), reached = water.slice();
	let head = 0, tail = 0;
	for ( let k = 0; k < count; k ++ ) if ( water[ k ] ) queue[ tail ++ ] = k;
	while ( head < tail ) {

		const k = queue[ head ++ ], i = k % nx, j = Math.floor( k / nx );
		for ( const next of [ i > 0 ? k - 1 : - 1, i < nx - 1 ? k + 1 : - 1, j > 0 ? k - nx : - 1, j < nz - 1 ? k + nx : - 1 ] ) {

			if ( next < 0 || reached[ next ] ) continue;
			reached[ next ] = 1;
			pixels[ next * 4 ] = pixels[ k * 4 ];
			pixels[ next * 4 + 2 ] = pixels[ k * 4 + 2 ]; pixels[ next * 4 + 3 ] = pixels[ k * 4 + 3 ];
			queue[ tail ++ ] = next;

		}

	}
	const texture = new THREE.DataTexture( pixels, nx, nz, THREE.RGBAFormat, THREE.FloatType );
	texture.name = 'shoreWaveShelter';
	texture.minFilter = texture.magFilter = THREE.LinearFilter;
	texture.generateMipmaps = false; texture.flipY = false; texture.needsUpdate = true;
	texture.userData.shoreWaveShelter = { direction: [ dx, dz ], fanDegrees: angles, residualAmplitude: 0.06, buildMs: performance.now() - started };
	return texture;

}
