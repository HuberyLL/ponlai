/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, If, float, vec3, vec4, positionWorld, normalViewGeometry, cameraViewMatrix,
	normalize, exp, dot, select, smoothstep, mix, max,
} from 'three/tsl';
import type { Shared } from '../shared.ts';
import type { WaveMaps } from '../ocean/WaveMaps.ts';
import { refractedSunDirectionNode, refractedSunBeamScaleNode } from './RefractedSun.ts';
import { GroundBounceLightingModel } from './GroundBounce.ts';
import { meterAmbient } from './MeterLight.ts';
import type { AmbientReceiver } from './AmbientSample.ts';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type B = THREE.Node<'bool'>;

// The light below the water's surface, one model for everything lit under it (the terrain and the
// sea floor, TerrainMaterial.ts), as tidewater's UnderwaterLighting (4811ba4) lights it: the key light refracted at the mean surface and carried
// down the water column to the point under the long waves' surface (Beer-Lambert over the slant
// path, the share that enters the water and the beam's change of area), faded in over the first
// 8 cm; and the ambient and specular light under the mean level, dimmer and bluer with the depth
// (Beer-Lambert over 1.2 times the depth, 85 % of it, with a little in-scattered blue), faded in
// over the first 10 cm. The long waves and the mean level come from the wave maps baked once a
// frame (WaveMaps.ts `wavesAt`), so the waterline on the rock rises and falls with the swell. The
// water shader adds the view path from the point back to the eye, so a material lit
// here must not. (tidewater leaves the key at its direction in the air with no share or beam
// factor: the same on a level floor; here the refracted direction lights steep submerged walls as
// the sun reaches them, and the share that enters the water follows the sun's height.)
//
// Above the water the ambient diffuse is the ambient volume's (lighting/AmbientSample.ts), as on
// every lit island material; the probes do not model the water, so below it the environment's
// (`UnderwaterModelOptions.ambient`).
//
// A material calls `underwaterLight` with its own above-water terms (the terrain's canopy shade and
// the lift of the sea's light on the rock; nothing for a material that never reaches the surface) and installs
// `UnderwaterLightingModel` as its lighting model; it also sets `userData.refractedSolarReceiver`,
// so RefractedSun.bindTerrain gives it the refracted sun's shadow map.
//

/** The light below the water at a point, for `UnderwaterLightingModel`. */
export interface UnderwaterLight {
	// whether the point lies below the long waves' surface
	under: B;
	// the water column above it to the mean level (m, negative above the water)
	depth: F;
	// the key light's colour multiplier: under water its path down the column, above it the
	// material's own `aboveSun`
	sun: V3;
	// the refracted key's direction in view space, which replaces the light's under water
	sunView: V3;
	// the ambient's multiplier: under water its attenuation, above it the material's `aboveAmbient`
	// (1 without one)
	ambient: V3;
	// the specular ambient's multiplier
	specular: V3;
	// the ambient's attenuation down the column (1 above the water)
	ambientAttenuation: V3;
}

export interface UnderwaterOptions {
	// the key's multiplier above the water (the terrain's canopy shade); 1 without one
	aboveSun?: V3;
	// the ambient's multiplier in a band above the water (the terrain's lift of the sea's light): `when`
	// the band holds, `value` builds it inside its branch
	aboveAmbient?: { when: B; value: () => V3 };
}

/** The underwater light at `positionWorld` (see the header). */
export function underwaterLight( shared: Shared, waveMaps: WaveMaps, { aboveSun, aboveAmbient }: UnderwaterOptions = {} ): UnderwaterLight {

	// the water above this point: the long waves' surface for the key, the mean level for the
	// ambient (the wave maps; a level sea above the water's reach)
	const p = positionWorld;
	const sigT = shared.sigA.add( shared.sigS );
	const waves = waveMaps.wavesAt( p ).toVar();
	const dSun = shared.waterLevel.add( waves.x ).sub( p.y ).toVar();
	const dW = shared.waterLevel.add( waves.w ).sub( p.y ).toVar();
	const under = dSun.greaterThan( 0 );
	// Snell's direction and the beam-area factor must change together. For a horizontal
	// floor, muWater * (muAir / muWater) preserves transmitted horizontal irradiance;
	// steep submerged walls now receive the correct refracted projection as well.
	const waterSun = refractedSunDirectionNode( shared.sunDir );
	const waterSunView = normalize( cameraViewMatrix.mul( vec4( waterSun, 0 ) ).xyz );
	// (`under` first builds the wave maps' variable, outside the branch, so that every later reader
	// finds it declared)
	const sun = Fn( () => {

		const att = ( aboveSun ?? vec3( float( 1 ) ) ).toVar();
		If( under, () => {

			const path = exp( sigT.negate().mul( dSun ).div( max( waterSun.y, 0.15 ) ) );
			att.assign( mix( att, path.mul( shared.sunIntoWater ).mul( refractedSunBeamScaleNode( shared.sunDir ) ), smoothstep( 0, 0.08, dSun ) ) );

		} );
		return att;

	} )();
	const depth = dW.max( 0 );
	const ambAtt = exp( sigT.negate().mul( depth ).mul( 1.2 ) ).mul( 0.85 ).add( vec3( 0, 0.02, 0.04 ).mul( exp( depth.mul( - 0.1 ) ) ) ).toVar();
	const water = mix( vec3( 1 ), ambAtt, smoothstep( 0, 0.1, depth ) );
	// (the water's multiplier is 1 above the mean level; built outside any branch, see `sun`)
	const ambient = Fn( () => {

		const mul = water.toVar();
		if ( aboveAmbient ) If( dW.lessThanEqual( 0 ).and( aboveAmbient.when ), () => {

			mul.assign( aboveAmbient.value() );

		} );
		return mul;

	} )();
	const specular = select( dW.greaterThan( 0 ), water, vec3( 1 ) );
	return { under, depth: dW, sun, sunView: waterSunView, ambient, specular, ambientAttenuation: select( dW.greaterThan( 0 ), ambAtt, vec3( 1 ) ) };

}

export interface UnderwaterModelOptions {
	// Fade the key out over the last few degrees before the geometric terminator (the terrain's
	// detail normals: past the terminator they still tilt some texels toward the light, which the
	// shadow map cannot shade). Off for a double-sided surface, whose geometric normal faces away
	// on its inner side.
	terminator?: boolean;
	// How the part above the water reads the ambient volume (lighting/AmbientSample.ts; default
	// degree 1); null keeps the environment's irradiance everywhere. The volume's share falls to
	// nothing over the first 30 cm below the mean level (`AMBIENT_DEPTH`), where the environment's
	// light carried down the column takes over.
	ambient?: Omit<AmbientReceiver, 'weight'> | null;
}

// the depth (m) below the mean level over which the volume's share of the ambient falls to none
const AMBIENT_DEPTH = 0.3;

/** The physical lighting model with the key light and the ambient carried down the water column
 * (`underwaterLight`), on GroundBounceLightingModel (the ground's bounce, the low key's lift above
 * the water, the lighting layer's debug views). */
export class UnderwaterLightingModel extends GroundBounceLightingModel {

	light: UnderwaterLight;
	options: UnderwaterModelOptions;

	constructor( light: UnderwaterLight, options: UnderwaterModelOptions = {} ) {

		super();
		this.light = light;
		this.options = options;
		this.ambient = options.ambient === null ? null : { bands: 1, ...options.ambient, weight: smoothstep( 0, AMBIENT_DEPTH, light.depth ).oneMinus() };

	}

	direct( input: THREE.LightingModelDirectInput, builder: THREE.NodeBuilder ): void {

		const lightDirection = select( this.light.under, this.light.sunView, input.lightDirection as V3 );
		// The bump terminator: past the geometric terminator the stone's detail normals still
		// tilt some texels toward the light, and the shadow map cannot shade them, since the
		// surface there occludes only itself (the bias clears it). Their sunlit specks twinkled
		// inside the cliff's own shadow along its creases. A surface facing away from the light
		// cannot see it; fade the key light out over the last few degrees before the terminator.
		// Above the water the terminator is the lifted key's (lighting/KeyLift.ts), as the sun's map
		// is drawn along it: a face turned from the true key but toward the lifted one takes the
		// lifted diffuse, lit or shaded by that map.
		let lightColor = ( input.lightColor as V3 ).mul( this.light.sun );
		if ( this.options.terminator !== false ) lightColor = lightColor.mul( smoothstep( 0, 0.06, dot( normalViewGeometry, this.shadeDirection( lightDirection ) ) ) );
		const color = lightColor.toVar();
		super.direct( { ...input, lightDirection, lightColor: color }, builder );

	}

	/** Under the water the refracted sun's own direction: the low key's lift is the air's
	 * (lighting/KeyLift.ts). */
	shadeDirection( L: V3 ): V3 {

		const lifted = super.shadeDirection( L ).toVar();
		return select( this.light.under, L, lifted );

	}

	/** The local lights reach a submerged point down the water column, as the ambient does (and
	 * without the terrain's band above the water). */
	localScale(): V3 {

		return this.light.specular;

	}

	indirect( builder: THREE.NodeBuilder ): void {

		// the light the sunlit ground bounces up (above the water only: GroundBounce.ts), then three's
		super.indirect( builder );
		const reflected = ( builder.context as unknown as { reflectedLight: { indirectDiffuse: V3; indirectSpecular: V3 } } ).reflectedLight;
		reflected.indirectDiffuse.mulAssign( this.light.ambient );
		// the metering illuminance's ambient down the column, as the diffuse (lighting/MeterLight.ts)
		meterAmbient.mulAssign( this.light.ambient );
		reflected.indirectSpecular.mulAssign( this.light.specular );

	}

}
