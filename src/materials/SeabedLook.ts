import type * as THREE from 'three/webgpu';
import { float, vec3, mix, smoothstep } from 'three/tsl';

type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type F = THREE.Node<'float'>;

// The sea floor's colour, shared by its material (TerrainMaterial's seabed) and the water's
// estimate of the floor where refracted rays leave the screen, so that the two stay one floor.
//   bed:    seagrass cover and pale-sand share, baked per vertex (Bathymetry's seabedBeds)
//   broad:  the sand's broad variation (the detail textures' normalsB alpha, some 77 m a tile)
//   detail: the tiled detail heights (r rock, g moss cushions, b sand ripples), or their means
//   shore:  the distance to the shoreline (m)
// Returns the albedo with the seagrass and rubble shares (the material also bends its normal by
// them).
export function seabedAlbedo( bed: V2, broad: F, detail: V3, shore: F ): { albedo: V3; grass: F; rubble: F } {

	// Broad sand colour carries the shallows; low-relief ripples stay subordinate so the
	// ocean does not look like a transparent lid over an engraved, striped floor. Warm, fairly
	// bright sand is what turns the clear water over the shelf into teal shallows; the clean
	// sand washed off the island is paler still, while the basin's silted sand darkens so
	// the sea deepens in colour away from the island.
	const sand = mix( vec3( 0.36, 0.34, 0.28 ), vec3( 0.56, 0.53, 0.45 ), smoothstep( 0.1, 0.9, detail.z.mul( 0.23 ).add( broad.mul( 0.87 ) ) ) )
		.mul( detail.y.mul( 0.1 ).add( 0.95 ) ).mul( mix( float( 0.4 ), float( 1.06 ), bed.y ) );
	// seagrass and algae beds: dark olive meadows whose edges fray over a few decimetres (a
	// meadow's edge is a sharp step from leaves to bare sand, not a gradient)
	const grass = smoothstep( 0.4, 0.6, bed.x.add( detail.x.sub( 0.5 ).mul( 0.35 ) ) );
	const grassC = mix( vec3( 0.06, 0.085, 0.045 ), vec3( 0.13, 0.17, 0.085 ), detail.y );
	// rubble and boulders shed from the cliffs: weathered limestone grit, a shade darker than
	// the sand, so the cliff foot reads as a stony apron rather than a dark moat. Against the wall
	// the cobbles close up, the sand left in pockets between them, and thin out over the apron;
	// in patches they wear the olive film of algae and diatoms the submerged stones wear
	// (TerrainMaterial), so they part from the sand by hue as well as value.
	const foot = float( 1 ).sub( smoothstep( 0.5, 3, shore ) ).mul( 0.12 );
	const rubble = float( 1 ).sub( smoothstep( 0.5, broad.mul( 3 ).add( 5 ), shore ) ).mul( smoothstep( float( 0.3 ).sub( foot ), float( 0.55 ).sub( foot ), detail.x ) );
	const rubbleC = mix( vec3( 0.2, 0.2, 0.18 ), vec3( 0.38, 0.37, 0.32 ), detail.x )
		.mul( mix( vec3( 1 ), vec3( 0.84, 0.74, 0.46 ), smoothstep( 0.45, 0.75, detail.y ).mul( 0.8 ) ) );
	return { albedo: mix( mix( sand, grassC, grass ), rubbleC, rubble ), grass, rubble };

}
