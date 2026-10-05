/*!
 * hash33 is "Hash without Sine" by David Hoskins (https://www.shadertoy.com/view/4djSRW).
 * Copyright (c) 2014 David Hoskins
 * Licensed under the MIT License; see ./hoskins-hash.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, instanceIndex, textureStore, uint, int, float, vec2, vec3, vec4, ivec2, uvec3,
	floor, fract, dot, mix, min, clamp, length, mod,
} from 'three/tsl';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

// Tileable cloud noise baked once on the GPU (the technique follows Schneider, "The Real-time
// Volumetric Cloudscapes of Horizon Zero Dawn", SIGGRAPH 2015; the code is original):
//   shape   128^3  R Perlin-Worley   G B A Worley fBm at rising frequencies (low-frequency erosion)
//   detail   32^3  R G B Worley fBm at rising frequencies (edge erosion)
//   weather 512^2  R coverage field  G cloud-type variation  B height variation
// All repeat over [0, 1) so a wrapped wind offset never shows a seam.

const hash33 = Fn( ( [ p ]: [ V3 ] ) => {

	const p3 = fract( p.mul( vec3( 0.1031, 0.1030, 0.0973 ) ) ).toVar();
	p3.addAssign( dot( p3, p3.yxz.add( 33.33 ) ) );
	return fract( p3.xxy.add( p3.yxx ).mul( p3.zyx ) );

} ).setLayout( { name: 'cloudHash33', type: 'vec3', inputs: [ { name: 'p', type: 'vec3' } ] } );

// Gradient noise with an integer period, in [-1, 1].
const perlin3 = Fn( ( [ p, period ]: [ V3, F ] ) => {

	const i = floor( p ).toVar();
	const f = fract( p ).toVar();
	const u = f.mul( f ).mul( f ).mul( f.mul( f.mul( 6 ).sub( 15 ) ).add( 10 ) ).toVar();
	const corner = ( x: number, y: number, z: number ) => {

		const o = vec3( x, y, z );
		const g = hash33( mod( i.add( o ), period ) ).mul( 2 ).sub( 1 );
		return dot( g, f.sub( o ) );

	};
	const x00 = mix( corner( 0, 0, 0 ), corner( 1, 0, 0 ), u.x );
	const x10 = mix( corner( 0, 1, 0 ), corner( 1, 1, 0 ), u.x );
	const x01 = mix( corner( 0, 0, 1 ), corner( 1, 0, 1 ), u.x );
	const x11 = mix( corner( 0, 1, 1 ), corner( 1, 1, 1 ), u.x );
	return mix( mix( x00, x10, u.y ), mix( x01, x11, u.y ), u.z ).mul( 1.15 );

} ).setLayout( { name: 'cloudPerlin3', type: 'float', inputs: [ { name: 'p', type: 'vec3' }, { name: 'period', type: 'float' } ] } );

// Inverted cellular noise (1 at feature points), with an integer period.
const worley3 = Fn( ( [ p, period ]: [ V3, F ] ) => {

	const i = floor( p ).toVar();
	const f = fract( p ).toVar();
	const nearest = float( 1 ).toVar();
	// The 27 neighbouring cells, unrolled: this runs once at startup.
	for ( let x = - 1; x <= 1; x ++ ) for ( let y = - 1; y <= 1; y ++ ) for ( let z = - 1; z <= 1; z ++ ) {

		const o = vec3( x, y, z );
		const feature = o.add( hash33( mod( i.add( o ), period ) ) );
		nearest.assign( min( nearest, length( feature.sub( f ) ) ) );

	}
	return float( 1 ).sub( clamp( nearest, 0, 1 ) );

} ).setLayout( { name: 'cloudWorley3', type: 'float', inputs: [ { name: 'p', type: 'vec3' }, { name: 'period', type: 'float' } ] } );

const worleyFbm = ( q: V3, cells: number ) =>
	worley3( q.mul( cells ), float( cells ) ).mul( 0.625 )
		.add( worley3( q.mul( cells * 2 ), float( cells * 2 ) ).mul( 0.25 ) )
		.add( worley3( q.mul( cells * 4 ), float( cells * 4 ) ).mul( 0.125 ) );

const remap = ( v: F, lo: F | number, hi: F | number, a: number, b: number ) =>
	v.sub( lo ).div( ( typeof hi === 'number' ? float( hi ) : hi ).sub( lo ) ).mul( b - a ).add( a );

function storage3D( size: number ): THREE.Storage3DTexture {

	const texture = new THREE.Storage3DTexture( size, size, size );
	texture.type = THREE.UnsignedByteType;
	texture.format = THREE.RGBAFormat;
	texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
	texture.minFilter = texture.magFilter = THREE.LinearFilter;
	texture.generateMipmaps = false;
	return texture;

}

const voxel = ( size: number ) => {

	const n = uint( size );
	return uvec3( instanceIndex.mod( n ), instanceIndex.div( n ).mod( n ), instanceIndex.div( n.mul( n ) ) );

};

export interface CloudNoise {
	shape: THREE.Storage3DTexture;
	detail: THREE.Storage3DTexture;
	weather: THREE.StorageTexture;
}

export function bakeCloudNoise( renderer: THREE.WebGPURenderer ): CloudNoise {

	const shape = storage3D( 128 ), detail = storage3D( 32 );
	const shapeKernel = Fn( () => {

		const c = voxel( 128 );
		const q = vec3( c ).add( 0.5 ).div( 128 ).toVar();
		// Perlin fBm, its billows reshaped by cellular noise: rounded heaps with connected bases.
		const perlin = perlin3( q.mul( 4 ), float( 4 ) ).mul( 0.5 )
			.add( perlin3( q.mul( 8 ), float( 8 ) ).mul( 0.25 ) )
			.add( perlin3( q.mul( 16 ), float( 16 ) ).mul( 0.125 ) )
			.add( perlin3( q.mul( 32 ), float( 32 ) ).mul( 0.0625 ) ).mul( 0.5 ).add( 0.5 ).toVar();
		const cells = worleyFbm( q, 4 ).toVar();
		const perlinWorley = clamp( remap( perlin, cells.sub( 1 ), 1, 0, 1 ), 0, 1 );
		textureStore( shape, c, vec4( perlinWorley, cells, worleyFbm( q, 8 ), worleyFbm( q, 16 ) ) );

	} )().compute( 128 * 128 * 128, [ 64 ] ).setName( 'Clouds.ShapeNoise' );
	const detailKernel = Fn( () => {

		const c = voxel( 32 );
		const q = vec3( c ).add( 0.5 ).div( 32 ).toVar();
		textureStore( detail, c, vec4( worleyFbm( q, 2 ), worleyFbm( q, 4 ), worleyFbm( q, 8 ), 1 ) );

	} )().compute( 32 * 32 * 32, [ 64 ] ).setName( 'Clouds.DetailNoise' );

	const weather = new THREE.StorageTexture( 512, 512 );
	weather.type = THREE.UnsignedByteType;
	weather.wrapS = weather.wrapT = THREE.RepeatWrapping;
	weather.minFilter = weather.magFilter = THREE.LinearFilter;
	weather.generateMipmaps = false;
	const weatherKernel = Fn( () => {

		const n = uint( 512 );
		const c = ivec2( int( instanceIndex.mod( n ) ), int( instanceIndex.div( n ) ) );
		const q = vec2( c ).add( 0.5 ).div( 512 ).toVar();
		const at = ( p: V2, z: number ) => vec3( p, z );
		// A 2D slice of the periodic 3D noises keeps the field seamless in x and z.
		const broad = perlin3( at( q.mul( 6 ), 0.37 ), float( 6 ) ).mul( 0.55 )
			.add( perlin3( at( q.mul( 12 ), 3.71 ), float( 12 ) ).mul( 0.3 ) )
			.add( perlin3( at( q.mul( 24 ), 7.13 ), float( 24 ) ).mul( 0.15 ) ).mul( 0.5 ).add( 0.5 ).toVar();
		const clumps = worley3( at( q.mul( 10 ), 0.5 ), float( 10 ) ).mul( 0.6 )
			.add( worley3( at( q.mul( 20 ), 2.5 ), float( 20 ) ).mul( 0.4 ) ).toVar();
		// Clumped coverage: Perlin drifts set where clouds gather, cells break them into heaps.
		const coverage = clamp( remap( broad, clumps.oneMinus().mul( 0.6 ), 1, 0, 1 ), 0, 1 );
		const type = perlin3( at( q.mul( 3 ), 9.1 ), float( 3 ) ).mul( 0.5 ).add( 0.5 );
		const height = perlin3( at( q.mul( 5 ), 5.3 ), float( 5 ) ).mul( 0.5 ).add( 0.5 );
		textureStore( weather, c, vec4( coverage, clamp( type, 0, 1 ), clamp( height, 0, 1 ), 1 ) );

	} )().compute( 512 * 512, [ 64 ] ).setName( 'Clouds.WeatherMap' );

	renderer.compute( [ shapeKernel, detailKernel, weatherKernel ] );
	return { shape, detail, weather };

}

export { remap as cloudRemap };
