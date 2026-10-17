import * as THREE from 'three/webgpu';
import {
	Fn, If, float, vec3, vec4, positionWorld, normalViewGeometry, cameraViewMatrix,
	normalize, exp, dot, select, smoothstep, dFdx, dFdy,
} from 'three/tsl';
import type { Shared } from '../shared.ts';
import { causticsColorAt, type Caustics } from '../ocean/Caustics.ts';
import { refractedSunDirectionNode, refractedSunBeamScaleNode } from './RefractedSun.ts';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type B = THREE.Node<'bool'>;

// The light below the water's surface, one model for everything lit under it (the terrain and the
// sea floor, TerrainMaterial.ts; the sea life, world/life/LifeMaterial.ts): the key light
// refracted at the mean surface and carried down the water column to the point (Beer-Lambert over
// the slant path, the share that enters the water, the beam's change of area and the caustics),
// and the ambient and specular light, dimmer and bluer with the depth. The water shader adds the
// view path from the point back to the eye, so a material lit here must not.
//
// A material calls `underwaterLight` with its own above-water terms (the terrain's canopy shade and
// its reflected caustic shimmer; nothing for a material that never reaches the surface) and installs
// `UnderwaterLightingModel` as its lighting model; it also sets `userData.refractedSolarReceiver`,
// so RefractedSun.bindTerrain gives it the refracted sun's shadow map.
//
// Everything is built in the order the terrain built it before it was shared, and the Fn calls
// inline, so the terrain's shaders are what they were, byte for byte (the parity MSAA set).

/** The light below the water at a point, for `UnderwaterLightingModel`. */
export interface UnderwaterLight {
	// whether the point lies below the water level
	under: B;
	// the water column above it (m, negative above the water)
	depth: F;
	// the key light's colour multiplier: under water its path down the column (with caustics),
	// above it the material's own `aboveSun`
	sun: V3;
	// the refracted key's direction in view space, which replaces the light's under water
	sunView: V3;
	// the ambient's multiplier: under water its attenuation, above it the material's `aboveAmbient`
	// (1 without one)
	ambient: V3;
	// the specular ambient's multiplier
	specular: V3;
	// the ambient's attenuation down the column (exp( -sigT 1.25 depth ), 1 above the water)
	ambientAttenuation: V3;
}

export interface UnderwaterOptions {
	// the key's multiplier above the water (the terrain's canopy shade); 1 without one
	aboveSun?: V3;
	// the ambient's multiplier in a band above the water (the terrain's reflected shimmer): `when`
	// the band holds, `value` builds it inside its branch
	aboveAmbient?: { when: B; value: () => V3 };
}

/** The underwater light at `positionWorld` (see the header). */
export function underwaterLight( shared: Shared, caustics: Caustics, { aboveSun, aboveAmbient }: UnderwaterOptions = {} ): UnderwaterLight {

	// the water column above this point
	const p = positionWorld;
	const dW = shared.waterLevel.sub( p.y );
	const sigT = shared.sigA.add( shared.sigS );
	const under = dW.greaterThan( 0 );
	// Snell's direction and the beam-area factor must change together. For a horizontal
	// floor, muWater * (muAir / muWater) preserves transmitted horizontal irradiance;
	// steep submerged walls now receive the correct refracted projection as well.
	const waterSun = refractedSunDirectionNode( shared.sunDir );
	const waterSunView = normalize( cameraViewMatrix.mul( vec4( waterSun, 0 ) ).xyz );
	// The caustics are read only where they are seen: below the water for the sun's path (and in
	// a material's own band above it). Most of the island's rock lies above both, and a select()
	// would read them everywhere. They sample with explicit gradients (the pixel's footprint,
	// taken before the branch) or an explicit level, so the reads may sit inside these branches.
	const sun = Fn( () => {

		const att = ( aboveSun ?? vec3( float( 1 ) ) ).toVar();
		const footprint = { dx: dFdx( p.xz ).toVar(), dy: dFdy( p.xz ).toVar() };
		If( under, () => {

			att.assign( exp( sigT.negate().mul( dW ).div( waterSun.y ) )
				.mul( shared.sunIntoWater ).mul( refractedSunBeamScaleNode( shared.sunDir ) ).mul( causticsColorAt( caustics, p, dW.max( 0 ), { footprint } ) ) );

		} );
		return att;

	} )();
	const ambAtt = exp( sigT.negate().mul( dW.max( 0 ) ).mul( 1.25 ) );
	const ambient = Fn( () => {

		const mul = vec3( 1 ).toVar();
		const below = If( under, () => {

			mul.assign( ambAtt );

		} );
		if ( aboveAmbient ) below.ElseIf( aboveAmbient.when, () => {

			mul.assign( aboveAmbient.value() );

		} );
		return mul;

	} )();
	const specular = select( under, ambAtt.mul( 0.5 ), vec3( 1 ) );
	return { under, depth: dW, sun, sunView: waterSunView, ambient, specular, ambientAttenuation: ambAtt };

}

export interface UnderwaterModelOptions {
	// Fade the key out over the last few degrees before the geometric terminator (the terrain's
	// detail normals: past the terminator they still tilt some texels toward the light, which the
	// shadow map cannot shade). Off for a double-sided surface, whose geometric normal faces away
	// on its inner side.
	terminator?: boolean;
	// more direct light of the material's own (the terrain's key rim), with the key's colour as it
	// reaches the surface and its direction
	extra?: ( input: THREE.LightingModelDirectInput, lightColor: V3, lightDirection: V3 ) => void;
}

/** The physical lighting model with the key light and the ambient carried down the water column
 * (`underwaterLight`). */
export class UnderwaterLightingModel extends THREE.PhysicalLightingModel {

	light: UnderwaterLight;
	options: UnderwaterModelOptions;

	constructor( light: UnderwaterLight, options: UnderwaterModelOptions = {} ) {

		super();
		this.light = light;
		this.options = options;

	}

	direct( input: THREE.LightingModelDirectInput, builder: THREE.NodeBuilder ): void {

		const lightDirection = select( this.light.under, this.light.sunView, input.lightDirection as V3 );
		// The bump terminator: past the geometric terminator the stone's detail normals still
		// tilt some texels toward the light, and the shadow map cannot shade them, since the
		// surface there occludes only itself (the bias clears it). Their sunlit specks twinkled
		// inside the cliff's own shadow along its creases. A surface facing away from the light
		// cannot see it; fade the key light out over the last few degrees before the terminator.
		let lightColor = ( input.lightColor as V3 ).mul( this.light.sun );
		if ( this.options.terminator !== false ) lightColor = lightColor.mul( smoothstep( 0, 0.06, dot( normalViewGeometry, lightDirection ) ) );
		const color = lightColor.toVar();
		super.direct( { ...input, lightDirection, lightColor: color }, builder );
		this.options.extra?.( input, color, lightDirection );

	}

	indirect( builder: THREE.NodeBuilder ): void {

		super.indirect( builder );
		const reflected = ( builder.context as unknown as { reflectedLight: { indirectDiffuse: V3; indirectSpecular: V3 } } ).reflectedLight;
		reflected.indirectDiffuse.mulAssign( this.light.ambient );
		reflected.indirectSpecular.mulAssign( this.light.specular );

	}

}
