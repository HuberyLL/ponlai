import * as THREE from 'three/webgpu';
import { texture, float, vec4, mix, smoothstep } from 'three/tsl';
import type { OceanFFT } from './OceanFFT.ts';
import type { ShoreWaves } from './ShoreWaves.ts';
import type { Shared } from '../shared.ts';

// How much of each FFT cascade a point of the sea keeps: tidewater's shallow-water attenuation by
// the floor's depth under it (OceanFFT.attenuation: the shelf sea leaves the swell a sixth of its
// open-ocean height), the island's lee (the shelter field: the long waves most, the finest not at
// all) and the last 7 m before the rock. The sea's surface (Water.ts) and the long waves the light
// under it follows (Caustics.ts, the wave maps) both take these weights, so both see one sea.

type V2 = THREE.Node<'vec2'>;

export interface WaveDampingInputs {
	fft: OceanFFT;
	shared: Shared;
	shore: THREE.Texture | THREE.TextureNode; // the shore's sea-level distance (world fields)
	seabedHeight: THREE.Texture | THREE.TextureNode; // the rendered floor's height (world fields)
	shoreWaves: ShoreWaves;
}

/** The cascades' weights at a world xz (explicit levels: any stage, any branch), and the floor's
 * depth there under the mean sea. */
export function waveDamping( { fft, shared, shore, seabedHeight, shoreWaves }: WaveDampingInputs, xz: V2 ): { weights: THREE.Node<'vec4'>; seaDepth: THREE.Node<'float'> } {

	const fieldUV = ( p: V2 ) => p.sub( shared.shoreXform.xy ).mul( shared.shoreXform.zw );
	const sd = texture( shore, fieldUV( xz ) ).level( float( 0 ) ).r;
	// Shelter changes the physical wave amplitude; the finest wind detail stays alive.
	const shelter = shoreWaves.shelter.sample( fieldUV( xz ) ).level( float( 0 ) );
	const coastDamp = mix( float( 0.45 ), float( 1 ), smoothstep( 0, 7, sd ) );
	const windDamp = mix( float( 0.12 ), float( 1 ), shelter.r );
	const mediumDamp = mix( float( 0.8 ), float( 1 ), shelter.r );
	const seaDepth = shared.waterLevel.sub( texture( seabedHeight, fieldUV( xz ) ).level( float( 0 ) ).r );
	const damping = [ windDamp, windDamp, mediumDamp, float( 1 ) ].map( ( lee, c ) => fft.attenuation( c, seaDepth ).mul( lee ).mul( coastDamp ) );
	return { weights: vec4( damping[ 0 ], damping[ 1 ], damping[ 2 ], damping[ 3 ] ), seaDepth };

}
