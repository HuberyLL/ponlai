import { islandSurfaceHeight } from './WorldShapes.ts';

// The meadow's planting gate: where the island's surface is level and high enough for the sward.

export const MEADOW_MIN_UP = 0.85;
export const MEADOW_MAX_DROP = 0.3;

// Share the planting gate with the worker without importing rendering code there.
export function supportsMeadow( x: number, y: number, z: number, up: number ): boolean {

	return y >= islandSurfaceHeight( x, z ) - MEADOW_MAX_DROP && up >= MEADOW_MIN_UP;

}
