import * as THREE from 'three/webgpu';
import { positionViewDirection, normalView, diffuseColor } from 'three/tsl';

type V3 = THREE.Node<'vec3'>;
type F = THREE.Node<'float'>;

// Physical lighting plus light through thin leaves and blades: `extra( L, V, N )` (view space)
// scales an unshadowed-by-orientation diffuse term added on top of the usual one, and `scale`
// dims all direct light (deep inside a bush, down at the roots of a tuft).
export class VegetationLighting extends THREE.PhysicalLightingModel {

	scale: F;
	extra: ( L: V3, V: V3, N: V3 ) => F;

	constructor( scale: F, extra: ( L: V3, V: V3, N: V3 ) => F ) {

		super();
		this.scale = scale;
		this.extra = extra;

	}

	direct( input: THREE.LightingModelDirectInput, builder: THREE.NodeBuilder ): void {

		const lightColor = ( input.lightColor as V3 ).mul( this.scale );
		super.direct( { ...input, lightColor }, builder );
		const k = this.extra( input.lightDirection as V3, positionViewDirection, normalView );
		( input.reflectedLight.directDiffuse as V3 ).addAssign( lightColor.mul( diffuseColor.rgb ).mul( k ) );

	}

}

export function useLighting( mat: THREE.MeshStandardNodeMaterial, model: () => THREE.LightingModel ): void {

	( mat as unknown as { setupLightingModel: () => THREE.LightingModel } ).setupLightingModel = model;

}
