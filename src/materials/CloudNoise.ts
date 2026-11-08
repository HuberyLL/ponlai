/*!
 * hash33 is "Hash without Sine" by David Hoskins (https://www.shadertoy.com/view/4djSRW).
 * Copyright (c) 2014 David Hoskins
 * Licensed under the MIT License; see ./hoskins-hash.LICENSE.txt.
 *
 * The synoptic field and the shape noise loader are adapted from tidewater by Daniel Greenheck
 * (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ../sky/tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, Loop, instanceIndex, textureStore, textureLoad, texture3D, storageTexture, uniform, uint, int,
	float, vec2, vec3, vec4, ivec2, ivec3, floor, fract, dot, mix, clamp, mod, sin, cos,
} from 'three/tsl';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

// Tileable fields for the clouds:
//   shape    64^3 RGB  Perlin-Worley shape noise at three frequencies, with its mip chain
//            (`public/clouds/baseShape64.bin`, from tidewater's Sky Pro clouds)
//   synoptic 512^2     R the thin cloud layer's patches, over a few to twenty kilometres (Clouds.ts
//                      `streaksAt`)
//   deck     64^3      R the overcast deck's middle scale (Clouds.ts `deckDensity`): gradient fBm
//                      baked at load, with its mip chain
// Every field repeats over [0, 1), so a wrapped wind offset never shows a seam.

export const SYNOPTIC_RES = 512;

export const hash33 = Fn( ( [ p ]: [ V3 ] ) => {

	const p3 = fract( p.mul( vec3( 0.1031, 0.1030, 0.0973 ) ) ).toVar();
	p3.addAssign( dot( p3, p3.yxz.add( 33.33 ) ) );
	return fract( p3.xxy.add( p3.yxx ).mul( p3.zyx ) );

} ).setLayout( { name: 'cloudHash33', type: 'vec3', inputs: [ { name: 'p', type: 'vec3' } ] } );

// Gradient noise with an integer period, in [-1, 1]. `seed` offsets the lattice's hash, so noises of
// the same period read unrelated gradients (null leaves the hash's input as it is).
const gradient3 = ( p: V3, period: F, seed: F | null ) => {

	const i = floor( p ).toVar();
	const f = fract( p ).toVar();
	const u = f.mul( f ).mul( f ).mul( f.mul( f.mul( 6 ).sub( 15 ) ).add( 10 ) ).toVar();
	const corner = ( x: number, y: number, z: number ) => {

		const o = vec3( x, y, z );
		const cell = mod( i.add( o ), period );
		const g = hash33( seed === null ? cell : cell.add( vec3( 71, 113, 157 ).mul( seed ) ) ).mul( 2 ).sub( 1 );
		return dot( g, f.sub( o ) );

	};
	const x00 = mix( corner( 0, 0, 0 ), corner( 1, 0, 0 ), u.x );
	const x10 = mix( corner( 0, 1, 0 ), corner( 1, 1, 0 ), u.x );
	const x01 = mix( corner( 0, 0, 1 ), corner( 1, 0, 1 ), u.x );
	const x11 = mix( corner( 0, 1, 1 ), corner( 1, 1, 1 ), u.x );
	return mix( mix( x00, x10, u.y ), mix( x01, x11, u.y ), u.z ).mul( 1.15 );

};

export const perlin3 = Fn( ( [ p, period ]: [ V3, F ] ) => gradient3( p, period, null ) )
	.setLayout( { name: 'cloudPerlin3', type: 'float', inputs: [ { name: 'p', type: 'vec3' }, { name: 'period', type: 'float' } ] } );

const perlin3Seeded = Fn( ( [ p, period, seed ]: [ V3, F, F ] ) => gradient3( p, period, seed ) )
	.setLayout( { name: 'cloudPerlin3Seeded', type: 'float', inputs: [ { name: 'p', type: 'vec3' }, { name: 'period', type: 'float' }, { name: 'seed', type: 'float' } ] } );

const hash2 = ( p: V2 ) => fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ).mul( 43758.5453 ) );
const fade = ( f: V2 ) => f.mul( f ).mul( f.mul( f.mul( 6 ).sub( 15 ) ).add( 10 ) );
// Tileable 2D gradient noise, about [-1, 1].
const gradientNoise2 = ( p: V2, cx: number, cy: number ) => {

	const cells = vec2( cx, cy );
	const q = p.mul( cells );
	const i = floor( q ).toVar(), f = fract( q ).toVar();
	const u = fade( f ).toVar();
	const g = ( x: number, y: number ) => {

		const o = vec2( x, y );
		const a = hash2( mod( i.add( o ), cells ) ).mul( 2 * Math.PI );
		return dot( vec2( cos( a ), sin( a ) ), f.sub( o ) );

	};
	return mix( mix( g( 0, 0 ), g( 1, 0 ), u.x ), mix( g( 0, 1 ), g( 1, 1 ), u.x ), u.y );

};
// Gradient fBm remapped to about [0, 1]: smoother than value noise, with no grid artefacts.
const gradientFbm = ( p: V2, cx: number, cy: number, seed: number ) =>
	gradientNoise2( p.add( seed ), cx, cy ).mul( 0.55 ).add( gradientNoise2( p.add( seed * 1.7 ), cx * 2, cy * 2 ).mul( 0.3 ) )
		.add( gradientNoise2( p.add( seed * 2.3 ), cx * 4, cy * 4 ).mul( 0.15 ) ).mul( 1.6 ).add( 0.5 );


/** Bake the synoptic field (the thin layer's patches): two fractal noises of 20 x 28 and 56 x 80
 * cells over the field (Clouds.ts SYNOPTIC_SIZE), weighted 0.7 and 0.3. At half those counts a
 * low sun's view toward it held one patch across most of its sky, read as a single sheet; at these
 * its patches stand apart with sky between them. Needs an initialised renderer. */
export function bakeSynoptic( renderer: THREE.WebGPURenderer ): THREE.StorageTexture {

	const synoptic = new THREE.StorageTexture( SYNOPTIC_RES, SYNOPTIC_RES );
	synoptic.type = THREE.UnsignedByteType;
	synoptic.wrapS = synoptic.wrapT = THREE.RepeatWrapping;
	synoptic.minFilter = synoptic.magFilter = THREE.LinearFilter;
	synoptic.generateMipmaps = false;
	const kernel = Fn( () => {

		const n = uint( SYNOPTIC_RES );
		const c = ivec2( int( instanceIndex.mod( n ) ), int( instanceIndex.div( n ) ) );
		const p = vec2( c ).add( 0.5 ).div( SYNOPTIC_RES ).toVar();
		const patches = gradientFbm( p, 20, 28, 0.83 ).mul( 0.7 ).add( gradientFbm( p, 56, 80, 0.21 ).mul( 0.3 ) );
		textureStore( synoptic, c, vec4( clamp( patches, 0, 1 ), 0, 0, 1 ) );

	} )().compute( SYNOPTIC_RES ** 2, [ 64 ] ).setName( 'Clouds.SynopticMap' );
	renderer.compute( kernel );
	return synoptic;

}

export const DECK_NOISE_RES = 64;
// The deck noise's octaves: the first's lattice cells across the tile, each next twice as many at
// half the amplitude. Four cells to the tile hold a few connected masses per period; the fourth
// octave's 32 cells still span two texels each.
const DECK_OCTAVES = [ 4, 8, 16, 32 ];

/** Bake the overcast deck's middle-scale noise: tileable gradient fBm on a 64^3 volume, its sum over
 * the octaves' amplitudes taken from [-1, 1] to [0, 1], in the red channel of RGBA8 like the shape
 * noise. Each octave hashes its lattice with its own seed: with the period alone the octaves'
 * lattices share their first cells' gradients. The top level samples the fBm at its texels'
 * centres; every next level is the mean of the 2x2x2 texels under it, written by one kernel for all
 * levels (three generates no mips for a 3D texture), which only swaps its target and its uniforms:
 * a level is stored into a scratch volume of its size and copied into the chain, since one dispatch
 * cannot sample the chain while it stores into a level of it. Once at load, before the first
 * frame. */
export function bakeDeckNoise( renderer: THREE.WebGPURenderer ): THREE.Storage3DTexture {

	const n = DECK_NOISE_RES;
	const volume = ( size: number ) => {

		const v = new THREE.Storage3DTexture( size, size, size );
		v.type = THREE.UnsignedByteType;
		return v;

	};
	const noise = volume( n );
	noise.wrapS = noise.wrapT = noise.wrapR = THREE.RepeatWrapping;
	noise.minFilter = THREE.LinearMipmapLinearFilter;
	noise.magFilter = THREE.LinearFilter;
	// allocates the whole chain (the levels are baked below, never generated)
	noise.generateMipmaps = true;
	( noise as THREE.Storage3DTexture & { mipmapsAutoUpdate: boolean } ).mipmapsAutoUpdate = false;
	const amplitude = DECK_OCTAVES.reduce( ( sum, _, k ) => sum + 0.5 ** k, 0 );
	const texel = ( index: THREE.Node<'uint'>, size: THREE.Node<'uint'> ) => ivec3( int( index.mod( size ) ), int( index.div( size ).mod( size ) ), int( index.div( size.mul( size ) ) ) );

	const top = Fn( () => {

		const c = texel( instanceIndex, uint( n ) ).toVar();
		const q = vec3( c ).add( 0.5 ).div( n );
		let sum: F = float( 0 );
		DECK_OCTAVES.forEach( ( cells, k ) => {

			sum = sum.add( perlin3Seeded( q.mul( cells ), float( cells ), float( k ) ).mul( 0.5 ** k ) );

		} );
		textureStore( noise, c, vec4( clamp( sum.div( amplitude ).mul( 0.5 ).add( 0.5 ), 0, 1 ), 0, 0, 1 ) );

	} )().compute( n ** 3, [ 64 ] ).setName( 'Clouds.DeckNoise' );
	renderer.compute( top );

	const size = uniform( 0, 'uint' ), source = uniform( 0, 'int' );
	const placeholder = volume( 1 ), target = storageTexture( placeholder );
	const halve = Fn( () => {

		const c = texel( instanceIndex, size ).toVar();
		const sum = float( 0 ).toVar();
		Loop( 8, ( { i } ) => {

			const o = ivec3( int( i ).bitAnd( 1 ), int( i ).shiftRight( 1 ).bitAnd( 1 ), int( i ).shiftRight( 2 ) );
			sum.addAssign( textureLoad( texture3D( noise ), c.mul( 2 ).add( o ), source ).r );

		} );
		textureStore( target, c, vec4( sum.mul( 0.125 ), 0, 0, 1 ) );

	} )().compute( ( n / 2 ) ** 3, [ 64 ] ).setName( 'Clouds.DeckNoiseMip' );
	for ( let level = 1; ( n >> level ) >= 1; level ++ ) {

		const s = n >> level, scratch = volume( s );
		target.value = scratch;
		size.value = s;
		source.value = level - 1;
		// the kernel's count (its threads' bound) follows the level, its pipeline does not
		halve.count = s ** 3;
		renderer.compute( halve );
		renderer.copyTextureToTexture( scratch, noise, new THREE.Box3( new THREE.Vector3(), new THREE.Vector3( s, s, s ) ), null, 0, level );
		scratch.dispose();

	}
	placeholder.dispose();
	return noise;

}

/** Load the 64^3 shape noise and its mip chain. The file is gzip-compressed: a 16 byte header
 * ('NZZ1', version, channel count, three u16 dimensions, a u8 mip count) and RGBA8 mips. */
export async function loadCloudShape( renderer: THREE.WebGPURenderer ): Promise<THREE.Data3DTexture> {

	const response = await fetch( import.meta.env.BASE_URL + 'clouds/baseShape64.bin' );
	if ( ! response.ok || ! response.body ) throw new Error( `Cloud shape noise: HTTP ${ response.status }` );
	const data = new Uint8Array( await new Response( response.body.pipeThrough( new DecompressionStream( 'gzip' ) ) ).arrayBuffer() );
	const view = new DataView( data.buffer, data.byteOffset, data.byteLength );
	if ( view.getUint32( 0, true ) !== 0x315a5a4e ) throw new Error( 'Cloud shape noise: bad header' );
	const dims = [ view.getUint16( 6, true ), view.getUint16( 8, true ), view.getUint16( 10, true ) ];
	const levels = view.getUint8( 12 );
	const mips: { data: Uint8Array; width: number; height: number; depth: number }[] = [];
	let offset = 16;
	for ( let m = 0; m < levels; m ++ ) {

		const [ width, height, depth ] = dims.map( ( x ) => Math.max( 1, x >> m ) );
		const bytes = width * height * depth * 4;
		mips.push( { data: data.subarray( offset, offset + bytes ), width, height, depth } );
		offset += bytes;

	}
	const shape = new THREE.Data3DTexture( mips[ 0 ].data, dims[ 0 ], dims[ 1 ], dims[ 2 ] );
	shape.format = THREE.RGBAFormat;
	shape.type = THREE.UnsignedByteType;
	shape.wrapS = shape.wrapT = shape.wrapR = THREE.RepeatWrapping;
	shape.minFilter = THREE.LinearMipmapLinearFilter;
	shape.magFilter = THREE.LinearFilter;
	shape.unpackAlignment = 1;
	// Listing the mips allocates the whole chain; three uploads only the first level of a 3D
	// texture, so the rest are written directly.
	shape.mipmaps = mips as unknown as THREE.Texture[ 'mipmaps' ];
	shape.needsUpdate = true;
	renderer.initTexture( shape );
	type Queue = { writeTexture( destination: { texture: unknown; mipLevel: number }, data: Uint8Array, layout: { bytesPerRow: number; rowsPerImage: number }, size: number[] ): void };
	const backend = renderer.backend as unknown as { device: { queue: Queue }; get( object: object ): { texture: unknown } };
	for ( let m = 1; m < levels; m ++ ) {

		const { data: bytes, width, height, depth } = mips[ m ];
		backend.device.queue.writeTexture( { texture: backend.get( shape ).texture, mipLevel: m }, bytes,
			{ bytesPerRow: width * 4, rowsPerImage: height }, [ width, height, depth ] );

	}
	return shape;

}
