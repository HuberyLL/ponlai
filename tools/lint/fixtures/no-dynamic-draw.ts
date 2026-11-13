// Fixture for ponlai/no-dynamic-draw (tools/verify-lint.mjs): each line marked `reported` must be
// reported by that rule, and no other line.
import * as THREE from 'three/webgpu';
import { DynamicDrawUsage } from 'three'; // reported

const attribute = new THREE.BufferAttribute( new Float32Array( 12 ), 3 );
attribute.setUsage( THREE.DynamicDrawUsage ); // reported
attribute.setUsage( DynamicDrawUsage );
// static usage with update ranges
attribute.addUpdateRange( 0, 3 );
attribute.needsUpdate = true;
