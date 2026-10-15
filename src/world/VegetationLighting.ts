import * as THREE from 'three/webgpu';
import { positionViewDirection, normalView, diffuseColor } from 'three/tsl';
import { keyRimLight, type KeyRimSurface } from '../lighting/KeyRim.ts';

type V3 = THREE.Node<'vec3'>;
type F = THREE.Node<'float'>;

// Physical lighting plus light through thin leaves and blades: `extra( L, V, N )` (view space)
// scales an unshadowed-by-orientation diffuse term added on top of the usual one (a vec3 tints it,
// as light through a blade turns yellower than the light off it), and `scale` dims all direct
// light (deep inside a bush, down at the roots of a tuft). `sheen( L, V, N )`, if given, is a soft
// gloss off the surface: it multiplies the key light alone, not the albedo, and like the rest
// follows the key, so it fades with the sun and stays at the moon's own strength by night.
// `rim` is the plant's surface for the key light's shared rim (lighting/KeyRim.ts), added on top
// under the same dimmed light.
export class VegetationLighting extends THREE.PhysicalLightingModel {

	scale: F;
	extra: ( L: V3, V: V3, N: V3 ) => F | V3;
	sheenTerm?: ( L: V3, V: V3, N: V3 ) => V3;
	rim: KeyRimSurface;

	constructor( scale: F, extra: ( L: V3, V: V3, N: V3 ) => F | V3, rim: KeyRimSurface, sheen?: ( L: V3, V: V3, N: V3 ) => V3 ) {

		super();
		this.scale = scale;
		this.extra = extra;
		this.rim = rim;
		this.sheenTerm = sheen;

	}

	direct( input: THREE.LightingModelDirectInput, builder: THREE.NodeBuilder ): void {

		const lightColor = ( input.lightColor as V3 ).mul( this.scale );
		super.direct( { ...input, lightColor }, builder );
		const k = this.extra( input.lightDirection as V3, positionViewDirection, normalView );
		// Match the Lambert term's radiance scale. Without 1 / pi, transmitted sunlight
		// overwhelms the shaded leaf body and turns whole bushes into yellow cutouts.
		( input.reflectedLight.directDiffuse as V3 ).addAssign( lightColor.mul( diffuseColor.rgb ).mul( k ).mul( 1 / Math.PI ) );
		( input.reflectedLight.directDiffuse as V3 ).addAssign( keyRimLight( lightColor, input.lightDirection as V3, diffuseColor.rgb, this.rim ) );
		if ( this.sheenTerm ) ( input.reflectedLight.directSpecular as V3 ).addAssign( lightColor.mul( this.sheenTerm( input.lightDirection as V3, positionViewDirection, normalView ) ).mul( 1 / Math.PI ) );

	}

}

export function useLighting( mat: THREE.MeshStandardNodeMaterial, model: () => THREE.LightingModel ): void {

	( mat as unknown as { setupLightingModel: () => THREE.LightingModel } ).setupLightingModel = model;

}
