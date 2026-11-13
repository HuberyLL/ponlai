import { islandSurfaceHeight } from './WorldShapes.ts';

export const MEADOW_MIN_UP = 0.85;
export const MEADOW_MAX_DROP = 0.3;

// Share the planting gate with the worker without importing rendering code there.
export function supportsMeadow( x: number, y: number, z: number, up: number ): boolean {

	return y >= islandSurfaceHeight( x, z ) - MEADOW_MAX_DROP && up >= MEADOW_MIN_UP;

}
