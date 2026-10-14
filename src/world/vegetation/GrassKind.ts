import type * as THREE from 'three/webgpu';
import { plantGrass, grassSteps, setGrass, type GrassPrepared, type GrassTufts } from '../Grass.ts';
import type { CullBuffers } from '../GrassCull.ts';
import { AttributeType, uploadSteps } from '../Upload.ts';
import { VEGETATION_STRIDE } from '../types.ts';
import type { VegetationKind } from './Registry.ts';

// The meadow as a vegetation kind (Registry.ts), on the grass module's own exports: a grown
// island's meadow is planted a slice of anchors at a step and its cull pool filled and uploaded
// ahead; the swap points the pool's storage nodes at the new buffers (Grass.ts setGrass, no
// pipeline), and the old buffers leave the renderer's attributes once nothing draws them. It stays
// out of the sun's caster box, as it always has.

export function grassKind( group: THREE.Group, renderer: THREE.WebGPURenderer ): VegetationKind<GrassPrepared> {

	return {
		name: 'grass', root: group, prepass: true, shadowFilter: 'vegetation', sunCaster: false, rainBake: true,
		growth: {
			*prepare( input ) {

				const veg = input.data.vegetation, anchors = veg.length / VEGETATION_STRIDE;
				const tufts: GrassTufts = { lawn: [], lawnThin: [] };
				for ( let a = 0; a < anchors; a += 16 ) {

					const part = plantGrass( veg.subarray( a * VEGETATION_STRIDE, Math.min( anchors, a + 16 ) * VEGETATION_STRIDE ), input.data.rimGround );
					tufts.lawn.push( ...part.lawn );
					tufts.lawnThin.push( ...part.lawnThin );
					yield;

				}
				const grass = yield* grassSteps( group, tufts, 256 );
				yield;
				for ( const buffer of Object.values( grass.buffers ) as CullBuffers[ keyof CullBuffers ][] ) yield* uploadSteps( input.renderer, buffer, AttributeType.STORAGE );
				return grass;

			},
			swap( prepared ) {

				const old = setGrass( group, prepared );
				return () => {

					const attributes = ( renderer as unknown as { _attributes?: { delete( attribute: unknown ): void } } )._attributes;
					for ( const buffer of Object.values( old ) ) attributes?.delete( buffer );

				};

			},
		},
	};

}
