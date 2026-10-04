import type * as THREE from 'three/webgpu';
import { Fn, modelWorldMatrix, varyingProperty, vec4 } from 'three/tsl';

type V3 = THREE.Node<'vec3'>;

// Thin leaves move across individual shadow texels. Cast their rest silhouette and receive
// its shadow in the same pose, while the visible surface keeps its original wind animation.
export function useRestPoseShadows( material: THREE.NodeMaterial, restPosition: V3, animatedPosition: V3 ): void {

	const restWorld = varyingProperty( 'vec3', 'vVegetationShadowRestWorld' );
	// This is a material-local vertex stack, not a shared layout function: it writes a varying
	// and uses this object's matrix. Rest positions already include the instance transform.
	material.positionNode = Fn( () => {

		const rest = restPosition.toVar();
		restWorld.assign( modelWorldMatrix.mul( vec4( rest, 1 ) ).xyz );
		return animatedPosition;

	} )();
	material.castShadowPositionNode = restPosition;
	material.receivedShadowPositionNode = restWorld;
	// Renderer caches shadow overrides by the source material's version.
	material.needsUpdate = true;

}
