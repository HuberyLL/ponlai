// Fixture for ponlai/pass-on-graph (tools/verify-lint.mjs): each line marked `reported` must be
// reported by that rule, and no other line.
import * as THREE from 'three/webgpu';
import { convertToTexture, rtt, vec4 } from 'three/tsl';

const material = new THREE.MeshBasicNodeMaterial();
material.colorNode = rtt( vec4( 1 ) ); // reported
material.colorNode = convertToTexture( vec4( 0.5 ) ); // reported
material.colorNode = THREE.TSL.rtt( vec4( 0 ) ); // reported
