/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, If, float, vec3, vec4, positionWorld, normalViewGeometry, cameraViewMatrix,
	normalize, exp, dot, select, smoothstep, mix, max, dFdx, dFdy,
} from 'three/tsl';
import type { Shared } from '../shared.ts';
import { causticsColorAt, type Caustics } from '../ocean/Caustics.ts';
import { refractedSunDirectionNode, refractedSunBeamScaleNode } from './RefractedSun.ts';
import { addGroundBounce } from './GroundBounce.ts';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type B = THREE.Node<'bool'>;

// The light below the water's surface, one model for everything lit under it (the terrain and the
// sea floor, TerrainMaterial.ts; the sea life, world/life/LifeMaterial.ts), as tidewater's
// UnderwaterLighting (4811ba4) lights it: the key light refracted at the mean surface and carried
// down the water column to the point under the long waves' surface (Beer-Lambert over the slant
// path, the share that enters the water, the beam's change of area, and the caustics, which follow
// the long waves' slope above and the gusts and slicks), faded in over the first 8 cm; and the
// ambient and specular light under the mean level, dimmer and bluer with the depth (Beer-Lambert
// over 1.2 times the depth, 85 % of it, with a little in-scattered blue), faded in over the first
// 10 cm. The long waves, the mean level and the gust factor come from the wave maps baked once a
// frame (Caustics.ts `wavesAt`, `levelAt`), so the waterline on the rock rises and falls with the
// swell. The water shader adds the view path from the point back to the eye, so a material lit
// here must not. (tidewater leaves the key at its direction in the air with no share or beam
// factor: the same on a level floor; here the refracted direction lights steep submerged walls as
// the sun reaches them, and the share that enters the water follows the sun's height.)
//
// A material calls `underwaterLight` with its own above-water terms (the terrain's canopy shade and
// its reflected caustic shimmer; nothing for a material that never reaches the surface) and installs
// `UnderwaterLightingModel` as its lighting model; it also sets `userData.refractedSolarReceiver`,
// so RefractedSun.bindTerrain gives it the refracted sun's shadow map.
//

/** The light below the water at a point, for `UnderwaterLightingModel`. */
export interface UnderwaterLight {
	// whether the point lies below the long waves' surface
	under: B;
	// the water column above it to the mean level (m, negative above the water)
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
	// the ambient's attenuation down the column (1 above the water)
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

	// the water above this point: the long waves' surface for the key, the mean level for the
	// ambient (the wave maps; a level sea above the water's reach)
	const p = positionWorld;
	const sigT = shared.sigA.add( shared.sigS );
	const waves = caustics.wavesAt( p ).toVar();
	const level = caustics.levelAt( p ).toVar();
	const dSun = shared.waterLevel.add( waves.x ).sub( p.y ).toVar();
	const dW = shared.waterLevel.add( level.x ).sub( p.y ).toVar();
	const under = dSun.greaterThan( 0 );
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
		// (the maps' variables are first built here, outside the branch, so that every later reader
		// finds them declared)
		const detail = level.y.toVar();
		If( under, () => {

			const path = exp( sigT.negate().mul( dSun ).div( max( waterSun.y, 0.15 ) ) );
			const caust = causticsColorAt( caustics, p, dSun, { slope: waves.yz, foam: waves.w, detail, footprint } );
			att.assign( mix( att, path.mul( shared.sunIntoWater ).mul( refractedSunBeamScaleNode( shared.sunDir ) ).mul( caust ), smoothstep( 0, 0.08, dSun ) ) );

		} );
		return att;

	} )();
	const depth = dW.max( 0 );
	const ambAtt = exp( sigT.negate().mul( depth ).mul( 1.2 ) ).mul( 0.85 ).add( vec3( 0, 0.02, 0.04 ).mul( exp( depth.mul( - 0.1 ) ) ) ).toVar();
	const water = mix( vec3( 1 ), ambAtt, smoothstep( 0, 0.1, depth ) );
	// (the water's multiplier is 1 above the mean level; built outside any branch, see `detail`)
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

	}

	indirect( builder: THREE.NodeBuilder ): void {

		// the light the sunlit ground bounces up (above the water only: GroundBounce.ts)
		addGroundBounce( builder );
		super.indirect( builder );
		const reflected = ( builder.context as unknown as { reflectedLight: { indirectDiffuse: V3; indirectSpecular: V3 } } ).reflectedLight;
		reflected.indirectDiffuse.mulAssign( this.light.ambient );
		reflected.indirectSpecular.mulAssign( this.light.specular );

	}

}
