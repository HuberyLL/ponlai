import type * as THREE from 'three/webgpu';
import { If, float, vec3, mix, smoothstep } from 'three/tsl';
import { FLOOR_ALBEDO } from '../world/SeabedTile.ts';

type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;
type F = THREE.Node<'float'>;

// The sea floor's colour, for its material (TerrainMaterial's seabed). The sand, the seagrass and
// the rubble take FLOOR_ALBEDO's gain alike, so they keep their order, the rubble a shade under the
// sand of its depth at every hour; the ground bounce and the ambient probes read it too.
//   bed:      seagrass cover and pale-sand share, baked per vertex (Bathymetry's seabedBeds)
//   broad:    the sand's broad variation (the detail textures' normalsB alpha, some 77 m a tile)
//   detail:   the tiled detail heights (r rock, g moss cushions, b sand ripples), or their means
//   shore:    the distance to the shoreline (m)
//   wander:   a low noise round 0 over a few metres, already in the material's hands
//   gravelAt: samples the gravel at a rate (tiles a metre) under a rotation and offset, at an
//             explicit level, so it can be called inside the apron's branch
// Returns the albedo with the seagrass and rubble shares (the material also bends its normal by
// them) and `relief`, the height of the stones over the sand (the material takes their slope from
// its screen derivatives, outside the branch).
export function seabedAlbedo( bed: V2, broad: F, detail: V3, shore: F, wander: F, gravelAt: ( rate: number, c: number, sn: number, at: number ) => V4 ): { albedo: V3; grass: F; rubble: F; relief: F } {

	// Broad sand colour carries the shallows; low-relief ripples stay subordinate so the
	// ocean does not look like a transparent lid over an engraved, striped floor. This is wet sand,
	// about 0.09 for the clean sand washed off the island and 0.06 for the basin's silted sand, near
	// neutral, and the shallows are this floor seen through the water, dim and quiet, so a stone reads
	// on it and the sea deepens in colour away from the island with no bright rim.
	const sand = mix( vec3( 0.36, 0.34, 0.28 ), vec3( 0.56, 0.53, 0.45 ), smoothstep( 0.1, 0.9, detail.z.mul( 0.23 ).add( broad.mul( 0.87 ) ) ) )
		.mul( detail.y.mul( 0.1 ).add( 0.95 ) ).mul( mix( float( 0.68 ), float( 1 ), bed.y ) ).mul( FLOOR_ALBEDO.gain );
	// seagrass and algae beds: dark olive meadows whose edges fray over a few decimetres (a
	// meadow's edge is a sharp step from leaves to bare sand, not a gradient)
	const grass = smoothstep( 0.4, 0.6, bed.x.add( detail.x.sub( 0.5 ).mul( 0.35 ) ) );
	const grassC = mix( vec3( 0.068, 0.097, 0.051 ), vec3( 0.148, 0.194, 0.097 ), detail.y ).mul( FLOOR_ALBEDO.gain );
	const albedo = mix( sand, grassC, grass ).toVar();
	const relief = float( 0 ).toVar();
	// rubble shed from the cliffs: an apron of stones round the foot, gone by 2 to 4 m from the shore
	// on the dark floor and by little over a metre on the shelf's pale flats, its edge wandering so
	// it never follows the coast as a band. Only its fragments pay for the stones. They come from
	// three layers of the gravel, 0.1 to 0.35 m and a few larger, about half the floor between them:
	// where two stones overlap the taller stands, so they meet as stones do rather than cut each
	// other. Their blend to the sand spans the rim, and the bed between them is silted a little
	// darker than the clean sand. The tones keep close, a low mottle of grey-brown with the olive film
	// of algae and diatoms the submerged stones wear (TerrainMaterial); the eye takes the stones from
	// their lit and shaded sides. As the apron thins the level rises, so the sand buries them.
	const flat = smoothstep( 0.7, 0.9, bed.y );
	const apron = float( 1 ).sub( smoothstep( mix( 1.4, 0.2, flat ), mix( broad.mul( 2 ).add( 2.2 ), 1.3, flat ), shore.add( wander.mul( 5 ) ) ) ).toVar();
	If( apron.greaterThan( 0 ), () => {

		const small = gravelAt( 0.13, 1, 0, 0.13 ), middle = gravelAt( 0.085, 0.6, 0.8, 0.37 ), large = gravelAt( 0.05, - 0.8, 0.6, 0.71 );
		// the layer's first stones (no cover in G) stand a little paler than its next ones
		const toneOf = ( layer: V4, tone: number ) => mix( float( tone * 1.2 ), float( tone ), smoothstep( 0, 0.5, layer.y ) );
		const overLarge = smoothstep( - 0.06, 0.06, middle.z.sub( large.z ) );
		const under = mix( large.z, middle.z, overLarge ), underTone = mix( toneOf( large, 0.185 ), toneOf( middle, 0.175 ), overLarge );
		const overUnder = smoothstep( - 0.06, 0.06, small.z.sub( under ) );
		const height = mix( under, small.z, overUnder ).toVar(), tone = mix( underTone, toneOf( small, 0.195 ), overUnder );
		const level = mix( float( 1.05 ), float( 0.05 ), smoothstep( 0, 0.4, apron ) ).toVar();
		const crown = smoothstep( level, level.add( 0.5 ), height ).mul( 0.3 ).add( 0.7 );
		const value = tone.mul( detail.x.sub( 0.5 ).mul( 0.4 ).add( 1 ) ).mul( crown );
		const film = mix( vec3( 1 ), vec3( 0.84, 0.74, 0.46 ), smoothstep( 0.45, 0.75, detail.y ).mul( 0.4 ) );
		const stone = vec3( 1, 0.95, 0.84 ).mul( value ).mul( film ).mul( FLOOR_ALBEDO.gain );
		albedo.assign( mix( albedo.mul( mix( float( 1 ), float( 0.85 ), apron ) ), stone, smoothstep( level, level.add( 0.45 ), height ) ) );
		relief.assign( height.sub( level ).max( 0 ) );

	} );
	return { albedo, grass, rubble: apron, relief };

}
