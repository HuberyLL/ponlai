// Fixture for ponlai/tsl-only (tools/verify-lint.mjs): each line marked `reported` must be reported
// by that rule, and no other line.
import * as THREE from 'three/webgpu';
import { wgslFn, code } from 'three/tsl'; // reported
import { glslFn } from 'three/webgpu'; // reported

export const a = wgslFn( 'fn f( x: f32 ) -> f32 { return x; }' );
export const b = code( 'let x = 1.0;' );
export const c = glslFn( 'float f( float x ) { return x; }' );
export const d = THREE.TSL.wgslFn( 'fn g() -> f32 { return 1.0; }' ); // reported
export const e = THREE.TSL.code( 'let y = 2.0;' ); // reported
// a property named code that is not TSL's
export const event = { code: 'KeyA' }.code;
