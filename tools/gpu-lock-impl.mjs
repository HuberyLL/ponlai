// A stand-in for the GPU lock's implementation, which lives in tools/kit/gpu-lock-impl.mjs since the
// tools were grouped. The lock's entries of checkouts from before then look for the main checkout's
// implementation here, read its version from this file's text and load the higher one; this file
// declares the kit's LOCK_VERSION and re-exports the kit's implementation, so those copies run the
// same lock. Keep LOCK_VERSION equal to the kit's (tools/kit/gpu-lock-impl.mjs); tools import the
// entry, tools/kit/gpu-lock.mjs, never this file.
export * from './kit/gpu-lock-impl.mjs';

export const LOCK_VERSION = 5;
