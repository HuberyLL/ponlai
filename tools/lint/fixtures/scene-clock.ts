// Fixture for ponlai/scene-clock (tools/verify-lint.mjs): each line marked `reported` must be
// reported by that rule, and no other line.
let phase = 0, last = 0;

// a per-frame update stepped by the wall clock
export function update(): void {

	const now = performance.now(); // reported
	phase += ( now - last ) / 1000;
	last = now;

}
export const stamp = Date.now(); // reported
export const today = new Date(); // reported
export const text = Date(); // reported
// a stored time formatted: no clock read
export const shown = new Date( 0 ).toISOString();
// the scene clock's step
export function stepped( dt: number ): void {

	phase += dt;

}
