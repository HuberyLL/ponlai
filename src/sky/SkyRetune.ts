// Tunables that change the sky or the air (debug/Tune.ts) mark it here through their `onChange`:
// the frame reads most of them at once, but the environment's bakes (the reflection, the ambient
// light and the irradiance the island takes from the sky) hold what the sky looked like when they
// ran, so main.ts's `tune` handle rebakes the environment after any value set marks it. A bake in
// flight holds the settled signal, so a tool that waits for it reads the rebaked frame.

export const skyRetune = { dirty: false };

/** An `onChange` for tunables the environment's bakes depend on. */
export const markSkyRetune = (): void => {

	skyRetune.dirty = true;

};
