import * as THREE from 'three/webgpu';
import { texture, vec2 } from 'three/tsl';
import { MEADOW_EXTENT, MEADOW_SIZE, meadowTexels } from '../materials/Meadow.ts';

// The sward's depth over the ground: how deep in the meadow each point of its turf lies, for the
// ground under the blades (TerrainMaterial.ts's root layer). Every anchor that holds turf gives its
// tussock's depth (Grass.ts `plantGrass`: the share of a tussock's roots its height and blades
// darken, the measure that darkens its own blades toward the root; 0 for a gap or a short
// tussock), and the field is their mean about each point over about a tussock's reach: each
// anchor's weight and depth spread over the four texels round it, then both blurred by a binomial
// of one texel's sigma, and divided. Under the tall sward the ground lies deep in its shade; in the
// short turf (the low patches, the low flowers' patches) and the gaps between tall tussocks the
// light reaches it, as in a real meadow, where the ground under short turf is lit and the deep
// shade lies only under the tall sward. One root layer for the whole meadow drew the short
// patches' ground as dark as the tall sward's, and they read as dark holes between the flowers.
// The field is the meadow map's A channel (Meadow.ts: its RGB the turf's colour, over the land
// lattice's extent at 0.25 m, about the planting anchors' spacing): the terrain's fragment stage
// samples all the textures WebGPU allows it, and a map of its own was one too many. This module
// holds the map: the materials sample it through one base node (`swardField`), and a grown island's
// map, its field baked from its tufts in the growth's idle-time steps (Grass.ts `grassKind`), is set
// on it in the swap's frame: a new texture is a new bind group, never a pipeline.

const SIZE = MEADOW_SIZE;
const BLUR = [ 1, 4, 6, 4, 1 ].map( ( w ) => w / 16 );
// (the anchors' weight below which a texel holds no turf: it takes the fallback)
const HELD = 1e-3;

function meadowMap( data: Uint8Array, size: number ): THREE.DataTexture {

	const tex = new THREE.DataTexture( data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType );
	// (linear values: a conversion would part the turf from its blades' colours)
	tex.colorSpace = THREE.NoColorSpace;
	tex.minFilter = tex.magFilter = THREE.LinearFilter;
	tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
	tex.generateMipmaps = false;
	tex.needsUpdate = true;
	tex.name = 'meadow';
	return tex;

}

/** The base node the materials sample the meadow map through ( xz / MEADOW_EXTENT + 0.5 ): empty
 * until the meadow is planted (Grass.ts `buildGrass`). */
export const swardField = texture( meadowMap( new Uint8Array( 4 ), 1 ), vec2( 0 ) );

/** The meadow map with the field of the meadow's anchors `sward` ( x, z and the tussock's depth,
 * 0 to 1, per anchor that holds turf, in the anchors' order), in steps of a few tenths of a
 * millisecond; texels with no turf take `fallback`. */
export function* swardSteps( sward: ArrayLike<number>, fallback: number ): Generator<void, THREE.DataTexture> {

	const n = SIZE * SIZE;
	const deep = new Float32Array( n ), held = new Float32Array( n );
	for ( let k = 0; k < sward.length; k += 3 ) {

		const fx = ( sward[ k ] / MEADOW_EXTENT + 0.5 ) * SIZE - 0.5, fz = ( sward[ k + 1 ] / MEADOW_EXTENT + 0.5 ) * SIZE - 0.5;
		const i = Math.floor( fx ), j = Math.floor( fz ), u = fx - i, v = fz - j, d = sward[ k + 2 ];
		if ( i < 0 || j < 0 || i >= SIZE - 1 || j >= SIZE - 1 ) continue;
		const at = j * SIZE + i;
		const w = [ ( 1 - u ) * ( 1 - v ), u * ( 1 - v ), ( 1 - u ) * v, u * v ], to = [ at, at + 1, at + SIZE, at + SIZE + 1 ];
		for ( let c = 0; c < 4; c ++ ) {

			held[ to[ c ] ] += w[ c ];
			deep[ to[ c ] ] += w[ c ] * d;

		}
		if ( k % ( 3 * 8192 ) === 0 ) yield;

	}
	// the binomial along x, then along z (taps past the extent's edge left out: no turf reaches it)
	const ROWS = 16;
	const blur = function* ( from: Float32Array, to: Float32Array, step: number ): Generator<void, void> {

		for ( let j = 0; j < SIZE; j ++ ) {

			for ( let i = 0; i < SIZE; i ++ ) {

				const at = j * SIZE + i, along = step === 1 ? i : j;
				let s = 0;
				for ( let o = - 2; o <= 2; o ++ ) if ( along + o >= 0 && along + o < SIZE ) s += BLUR[ o + 2 ] * from[ at + o * step ];
				to[ at ] = s;

			}
			if ( j % ROWS === ROWS - 1 ) yield;

		}

	};
	const deepX = new Float32Array( n ), heldX = new Float32Array( n );
	yield* blur( deep, deepX, 1 );
	yield* blur( held, heldX, 1 );
	yield* blur( deepX, deep, SIZE );
	yield* blur( heldX, held, SIZE );
	const out = meadowTexels().slice(), rest = Math.round( fallback * 255 );
	for ( let k = 0; k < n; k ++ ) {

		out[ k * 4 + 3 ] = held[ k ] > HELD ? Math.round( Math.min( Math.max( deep[ k ] / held[ k ], 0 ), 1 ) * 255 ) : rest;
		if ( k % ( SIZE * ROWS * 4 ) === 0 ) yield;

	}
	return meadowMap( out, SIZE );

}

/** Sets the meadow map `field` (`swardSteps`) on the base node; returns the texture it replaced. */
export function setSwardField( field: THREE.DataTexture ): THREE.Texture {

	const old = swardField.value;
	swardField.value = field;
	return old;

}
