// The renderer's neutral inputs: what a scene hands the renderer's stages where it has no world of
// its own to derive them from, in the formats a world gives them in (the ambient light's probes:
// lighting/ProbeFormat.ts; the ground the bounce reads: lighting/GroundBounce.ts `BounceGround`;
// the scene's fields and the shore's field: RenderStages.ts `SceneFields`, RenderTypes.ts
// `ShoreField`). They describe the plainest world there is: level ground of one albedo under an
// open sky, and fields that hold one value everywhere. The test scenes are built on them
// (app/scenes/); a world of its own (the island) gives its own and loads none of this.
//
// - The probes (`neutralLattice`): every probe sees the whole sky over the horizon and the level
//   ground under it, which sees the whole sky itself, so under a uniform white sky it bounces its
//   albedo in every direction below the horizon. Both are a hemisphere's indicator, whose
//   projection on the harmonics is exact: of the nine coefficients only the constant and the
//   vertical one are not zero (the three of the second band integrate to zero over a hemisphere
//   about the y axis). No probe sees the sea, none is moved and all are valid. A probe does not
//   depend on where it stands, so the lattice is as small as the format allows and the probes of
//   the points outside it are the same: the ground has no end.
// - The ground (`neutralBounceGround`): its albedo, on the land and under the sea alike, and its
//   height.
// - The fields (`neutralFields`): the shore's sea-level distance and the floor's height, one value
//   each over a square round the origin (far inland: a large negative distance; open water: a
//   large positive one), as textures of the formats a world's are, with the transform that maps
//   the ground to them and the shore's field as plain data.
import * as THREE from 'three/webgpu';
import { float, texture, vec3 } from 'three/tsl';
import { META_VEC4, PROBE_STRIDE, type AmbientLattice } from './lighting/ProbeFormat.ts';
import type { BounceGround } from './lighting/GroundBounce.ts';
import type { Bounds, ShoreField } from './RenderTypes.ts';

/** A linear albedo. */
export type Albedo = readonly [ number, number, number ];

// a hemisphere's indicator about the y axis on the harmonics (ProbeFormat.ts `shBasis`): the
// constant's coefficient, 0.282095 x 2 pi, and the vertical one's, 0.488603 x pi (negative for the
// lower half)
const HEMISPHERE_0 = 0.282095 * 2 * Math.PI, HEMISPHERE_Y = 0.488603 * Math.PI;

/** The probes of level ground of `albedo` at the height `ground` (m) under an open sky: a lattice
 * of 2 x 2 columns of `levels` levels, `spacing` (m) apart, its lowest level half a cell over
 * the ground, round the origin. */
export function neutralLattice( { ground, albedo, spacing = 2, levels = 4 }: { ground: number; albedo: Albedo; spacing?: number; levels?: number } ): AmbientLattice {

	const probe = new Float32Array( PROBE_STRIDE );
	// the constant: ( sky visibility, bounced r, g, b ); the vertical one: the sky above, the ground below
	probe.set( [ HEMISPHERE_0, HEMISPHERE_0 * albedo[ 0 ], HEMISPHERE_0 * albedo[ 1 ], HEMISPHERE_0 * albedo[ 2 ] ], 0 );
	probe.set( [ HEMISPHERE_Y, - HEMISPHERE_Y * albedo[ 0 ], - HEMISPHERE_Y * albedo[ 1 ], - HEMISPHERE_Y * albedo[ 2 ] ], 4 );
	probe[ META_VEC4 * 4 + 3 ] = 1;
	const nx = 2, ny = levels, nz = 2;
	// the box's probes, then one per level for the points outside it
	const count = nx * ny * nz + ny;
	const probes = new Float32Array( count * PROBE_STRIDE );
	for ( let k = 0; k < count; k ++ ) probes.set( probe, k * PROBE_STRIDE );
	return { x0: - spacing / 2, y0: ground + spacing / 2, z0: - spacing / 2, spacing, nx, ny, nz, probes };

}

/** Level ground of `albedo` at the height `ground` (m), as the ground bounce's bake reads it. */
export function neutralBounceGround( { ground, albedo }: { ground: number; albedo: Albedo } ): BounceGround {

	return {
		land: () => vec3( ...albedo ),
		floor: () => vec3( ...albedo ),
		height: () => float( ground ),
	};

}

/** The scene's fields at one value each over the square of `half` (m) round the origin, in
 * `cells` cells a side: the shore's sea-level distance `shore` (m, negative over the land) and
 * the floor's height `floor` (m). Sets `xform` (shared.shoreXform's value) to the square. */
export function neutralFields( { half, cells = 32, shore, floor, xform }: { half: number; cells?: number; shore: number; floor: number; xform: THREE.Vector4 } ): {
	fields: { shore: THREE.TextureNode; floor: THREE.TextureNode };
	shoreData: ShoreField;
	bounds: Bounds;
} {

	const field = ( value: number, name: string ) => {

		const data = new Float32Array( cells * cells ).fill( value );
		const tex = new THREE.DataTexture( data, cells, cells, THREE.RedFormat, THREE.FloatType );
		tex.minFilter = tex.magFilter = THREE.LinearFilter;
		tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
		tex.generateMipmaps = false;
		tex.needsUpdate = true;
		tex.name = name;
		return { data, node: texture( tex ) };

	};
	const shoreField = field( shore, 'shore-distance' ), floorField = field( floor, 'seabed-height' );
	const cell = 2 * half / cells;
	xform.set( - half, - half, 1 / ( 2 * half ), 1 / ( 2 * half ) );
	return {
		fields: { shore: shoreField.node, floor: floorField.node },
		shoreData: { data: shoreField.data, nx: cells, nz: cells, x0: - half, z0: - half, cell },
		bounds: { x0: - half, z0: - half, x1: half, z1: half },
	};

}
