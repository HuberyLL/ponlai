import * as THREE from 'three/webgpu';
import { texture, vec2 } from 'three/tsl';
import { MEADOW_EXTENT, MEADOW_SIZE, meadowTexels } from '../materials/Meadow.ts';

// The sward's cover and depth over the ground: whether and how deep in the meadow each point of its
// turf lies, for the ground under the blades (TerrainMaterial.ts's meadow ground). Every anchor that
// holds turf gives its tussock's depth (Grass.ts `plantGrass`: the share of a tussock's roots its
// height and blades darken, the measure that darkens its own blades toward the root; about 0 for a
// short tussock) or, for a gap where no tussock grows, -1 (no cover, no depth), and the fields are
// their means about each point over about a tussock's reach: each anchor's weight, cover and depth
// spread over the four texels round it, then all blurred by a binomial of one texel's sigma, and
// divided. A short tussock covers its ground as a tall one does (a short turf is a closed mat);
// only a gap leaves it bare. Under the tall sward the ground lies deep in its shade; in the
// short turf (the low patches, the low flowers' patches) and the gaps between tall tussocks the
// light reaches it, as in a real meadow, where the ground under short turf is lit and the deep
// shade lies only under the tall sward. One root layer for the whole meadow drew the short
// patches' ground as dark as the tall sward's, and they read as dark holes between the flowers.
// The fields are the meadow map's G (cover) and A (depth) channels (Meadow.ts: its R the turf's
// tone, over the land lattice's extent at 0.25 m, about the planting anchors' spacing): the
// terrain's fragment stage samples all the textures WebGPU allows it, and a map of its own was one
// too many. This module
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

/** The meadow map with the fields of the meadow's anchors `sward` ( x, z and the tussock's depth,
 * 0 to 1, or -1 for a gap, per anchor that holds turf, in the anchors' order), in steps of a few
 * tenths of a millisecond; texels with no turf take the depth `fallback` and full cover. */
export function* swardSteps( sward: ArrayLike<number>, fallback: number ): Generator<void, THREE.DataTexture> {

	const n = SIZE * SIZE;
	const deep = new Float32Array( n ), held = new Float32Array( n ), cover = new Float32Array( n );
	for ( let k = 0; k < sward.length; k += 3 ) {

		const fx = ( sward[ k ] / MEADOW_EXTENT + 0.5 ) * SIZE - 0.5, fz = ( sward[ k + 1 ] / MEADOW_EXTENT + 0.5 ) * SIZE - 0.5;
		const i = Math.floor( fx ), j = Math.floor( fz ), u = fx - i, v = fz - j, d = Math.max( sward[ k + 2 ], 0 ), c = sward[ k + 2 ] < 0 ? 0 : 1;
		if ( i < 0 || j < 0 || i >= SIZE - 1 || j >= SIZE - 1 ) continue;
		const at = j * SIZE + i;
		const w = [ ( 1 - u ) * ( 1 - v ), u * ( 1 - v ), ( 1 - u ) * v, u * v ], to = [ at, at + 1, at + SIZE, at + SIZE + 1 ];
		for ( let t = 0; t < 4; t ++ ) {

			held[ to[ t ] ] += w[ t ];
			deep[ to[ t ] ] += w[ t ] * d;
			cover[ to[ t ] ] += w[ t ] * c;

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
	const across = new Float32Array( n );
	for ( const field of [ deep, held, cover ] ) {

		yield* blur( field, across, 1 );
		yield* blur( across, field, SIZE );

	}
	const out = meadowTexels().slice(), rest = Math.round( fallback * 255 );
	const share = ( f: Float32Array, k: number ) => Math.round( Math.min( Math.max( f[ k ] / held[ k ], 0 ), 1 ) * 255 );
	for ( let k = 0; k < n; k ++ ) {

		out[ k * 4 + 1 ] = held[ k ] > HELD ? share( cover, k ) : 255;
		out[ k * 4 + 3 ] = held[ k ] > HELD ? share( deep, k ) : rest;
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
