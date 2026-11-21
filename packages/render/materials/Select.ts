import * as THREE from 'three/webgpu';
import { bvec3, select } from 'three/tsl';

// Choices between two vectors built as straight-line code.
//
// three's `select()` by a scalar condition is an `if` / `else`, and a node first built inside one
// of its branches is built again in every block that cannot see it: the shader does the work
// twice or more (docs/reference/three-behaviour.md, select() of large operands). By a vector
// condition it is WGSL's `select()`, which builds both operands once, before it. The types of
// three's `select()` take a scalar condition only, so this module holds the casts.

type V3 = THREE.Node<'vec3'>;

/** `a` where `condition` holds, else `b`, as WGSL's `select()` (both built, no branch). */
export function selectVec3( condition: THREE.Node<'bool'>, a: V3, b: V3 ): V3 {

	return select( bvec3( condition ) as unknown as THREE.Node<'bool'>, a, b );

}

/** Each channel of `a` where that channel of `condition` (a `bvec3`, such as a vector
 * `lessThan`) holds, else of `b`, as WGSL's `select()`. */
export function selectEach( condition: THREE.Node, a: V3, b: V3 ): V3 {

	return select( condition as unknown as THREE.Node<'bool'>, a, b );

}
