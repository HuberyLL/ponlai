import * as THREE from 'three/webgpu';
import { bakeProceduralTextures, type DetailTextures } from '../../render/index.ts';
import { createSoilTexture } from './Soil.ts';

// The island's ground textures: shared detail maps, the island's scans and its soil map.
//
// The island's ground textures: the detail maps every ground shares (ProceduralTextures.ts), the
// island's own scans in their texture arrays, and its soil map (Soil.ts).

/** The scans' layers in the texture arrays: the cliff's stone and the island's ground, the meadow's
 * and the bamboo groves' alike (CC0 scans: the stone's irregular mineral relief, the ground's soil;
 * generated textures still serve moss and sand). */
export const SCAN_LAYER = { rock: 0, meadow: 1 } as const;
// their files, in SCAN_LAYER's order
const SCAN_FILES = [ 'rock/rock', 'ground/meadow' ];

export interface GroundTextures extends DetailTextures {
	soil: THREE.DataArrayTexture; // layers: the root bed (Soil.ts), the bamboo groves' density
}

/** Bakes the detail maps, loads the island's scans, then makes the soil map. */
export async function bakeGroundTextures( renderer: THREE.WebGPURenderer ): Promise<GroundTextures> {

	const detail = await bakeProceduralTextures( renderer, SCAN_FILES );
	return { ...detail, soil: createSoilTexture() };

}
