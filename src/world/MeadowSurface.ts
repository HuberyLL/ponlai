import { ISLAND_TOP } from './WorldShapes.ts';

export const MEADOW_MIN_UP = 0.85;
export const MEADOW_MAX_DROP = 0.3;

// Share the planting gate with the worker without importing rendering code there.
export function supportsMeadow( y: number, up: number ): boolean {

	return y >= ISLAND_TOP - MEADOW_MAX_DROP && up >= MEADOW_MIN_UP;

}
