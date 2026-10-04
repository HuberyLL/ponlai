import * as THREE from 'three/webgpu';
import {
	attribute, uniform, vec2, vec3, float, mix, smoothstep, clamp, dot, max, abs, pow, normalize, luminance,
	normalView, normalWorld, positionViewDirection, positionWorld, cameraPosition, diffuseColor, vertexColor,
} from 'three/tsl';
import type { Shared } from '../shared.ts';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;
type Reflected = { directDiffuse: V3; directSpecular: V3; indirectDiffuse: V3; indirectSpecular: V3 };

// Characters are drawn rather than rendered: sunlight steps from light to shade over a narrow
// band, the shade is filled by the same sky and the sunlit meadow that light the island, and a
// thin rim catches the sun along the silhouette. The light's colour, the sky's irradiance and
// the shadow maps are the scene's own, so a figure sits in the island's light while its forms
// stay simple and graphic.

export const characterLook = {
	// Palette colours are authored as they should read in sunlight. The island is exposed for
	// turf and stone of about 0.1 albedo, so the painted colours scale into that range.
	albedo: uniform( 0.36 ),
	// direct sun on the lit side (cel lighting has no cosine falloff to darken grazing forms)
	sunGain: uniform( 1 ),
	// width of the light/shade transition for cloth, and for skin (wider: soft faces and hands)
	softCloth: uniform( 0.1 ),
	softSkin: uniform( 0.2 ),
	// light-side tone step: forms turning away from the sun keep this fraction before the edge
	formFloor: uniform( 0.72 ),
	// The open sky is about a tenth of the sun here. Painted shade sits nearer half the lit
	// tone, so the figure's fill (sky and sunlit turf) is lifted well above the island's.
	fillGain: uniform( 2 ),
	bounceGain: uniform( 0.8 ),
	rimGain: uniform( 1 ),
	skyRimGain: uniform( 1 ),
	shadowSaturation: uniform( 1.3 ),
};

// Shading channel per vertex (the `shade` attribute's x).
export const KIND = { cloth: 0, skin: 1, hair: 2, leather: 3, metal: 4 } as const;
const KIND_SKIN = KIND.skin, KIND_HAIR = KIND.hair, KIND_LEATHER = KIND.leather, KIND_METAL = KIND.metal;
// 1 where the kind channel equals k (the channel is constant over every part)
const is = ( kind: F, k: number ): F => float( 1 ).sub( clamp( abs( kind.sub( k ) ), 0, 1 ) );

class CharacterLighting extends THREE.LightingModel {

	shade: V4;
	shared: Shared;
	lit: F | null = null;

	constructor( shade: V4, shared: Shared ) {

		super();
		this.shade = shade;
		this.shared = shared;

	}

	direct( { lightDirection, lightColor, reflectedLight: out }: THREE.LightingModelDirectInput ): void {

		const reflectedLight = out as unknown as Reflected;

		const L = lightDirection as V3, N = normalView, V = positionViewDirection;
		const kind = this.shade.x;
		const skin = is( kind, KIND_SKIN ), hair = is( kind, KIND_HAIR );
		const shiny = is( kind, KIND_METAL ).add( is( kind, KIND_LEATHER ).mul( 0.25 ) );
		const sun = this.shared.sunColor;
		const look = characterLook;

		const ndl = dot( N, L ).toVar();
		const soft = mix( look.softCloth, look.softSkin, skin ).toVar();
		// the terminator sits a little past 90 degrees: forms read mostly lit, as in a painting
		const band = smoothstep( soft.negate(), soft, ndl.add( 0.06 ) ).toVar();
		// Shadow maps (the island's and the moving figures') arrive filtered in the light colour.
		// Their ratio to the open sun gives the visibility; a narrower ramp keeps cast shadows
		// as graphic as the terminator.
		const visibility = clamp( luminance( lightColor as V3 ).div( max( luminance( sun ), 1e-6 ) ), 0, 1 );
		const cast = smoothstep( 0.12, 0.7, visibility ).toVar();
		// baked occlusion (folds, overlaps) reaches into the light a little, as painted shading would
		const lit = band.mul( cast ).mul( mix( float( 0.72 ), float( 1 ), this.shade.y ) ).toVar();
		this.lit = band.mul( cast );
		const form = mix( look.formFloor, float( 1 ), smoothstep( 0.12, 0.8, ndl ) );
		const albedo = diffuseColor.rgb;
		const direct = sun.mul( albedo ).mul( lit.mul( form ).mul( look.sunGain ).mul( 1 / Math.PI ) );
		reflectedLight.directDiffuse.addAssign( direct );
		// light scattered under the skin warms the edge between light and shade
		const edge = band.mul( band.oneMinus() ).mul( 4 ).mul( cast ).mul( skin );
		reflectedLight.directDiffuse.addAssign( sun.mul( albedo ).mul( vec3( 0.85, 0.22, 0.1 ) ).mul( edge.mul( 0.3 / Math.PI ) ) );

		// sun rim: an edge along the silhouette on the side toward the light, strongest when the
		// figure stands against the sun. Seen from above, as the island usually is, the view and
		// the sun are compared in plan as well: a low sun ahead of the camera backlights figures
		// even when the camera looks down on them.
		const fres = clamp( dot( N, V ), 0, 1 ).oneMinus();
		const rimEdge = smoothstep( 0.46, 0.72, fres );
		const toCamera = cameraPosition.sub( positionWorld ).toVar();
		const sunPlan = vec2( this.shared.sunDir.x, this.shared.sunDir.z );
		const viewPlan = vec2( toCamera.x, toCamera.z ).negate();
		const againstPlan = clamp( dot( normalize( viewPlan ), normalize( sunPlan ) ), 0, 1 );
		const against = max( clamp( dot( V.negate(), L ), 0, 1 ), againstPlan.mul( 0.85 ) );
		const rim = rimEdge.mul( smoothstep( - 0.3, 0.3, ndl ) ).mul( cast ).mul( mix( float( 0.3 ), float( 2 ), against ) ).mul( look.rimGain );
		reflectedLight.directSpecular.addAssign( sun.mul( albedo.mul( 1.2 ).add( luminance( albedo ).mul( 0.35 ) ) ).mul( rim.mul( 1 / Math.PI ) ) );

		// a crisp highlight on brass and the sheen of worn leather; hair shows a soft sheen band
		const H = normalize( L.add( V ) );
		const ndh = clamp( dot( N, H ), 0, 1 );
		const spot = smoothstep( 0.9, 0.95, ndh ).mul( shiny ).add( pow( ndh, 24 ).mul( hair ).mul( 0.12 ) );
		reflectedLight.directSpecular.addAssign( sun.mul( spot.mul( cast ).mul( look.albedo ).mul( 0.35 / Math.PI ) ) );

	}

	indirect( builder: THREE.NodeBuilder ): void {

		const ctx = builder.context as unknown as { iblIrradiance: V3; reflectedLight: Reflected };
		const look = characterLook;
		const sky = this.shared.skyIrradianceSource; // E / pi on a level surface
		const up = normalWorld.y;
		// The shade side keeps one fill colour (a flattened sky dome), with a little of the
		// environment's direction for warmth toward the sun and blue away from it.
		const dome = sky.mul( mix( float( 0.55 ), float( 1 ), up.mul( 0.5 ).add( 0.5 ) ) );
		const env = ( ctx.iblIrradiance ).mul( 1 / Math.PI );
		const skyFill = mix( dome, env, 0.3 );
		// sunlit turf below throws green-gold light up into the shade
		const turf = vec3( 0.075, 0.11, 0.032 );
		const sunOnTurf = this.shared.sunColor.mul( max( this.shared.sunDir.y, 0 ) ).mul( 1 / Math.PI );
		const bounce = turf.mul( sunOnTurf.add( sky ) ).mul( clamp( up.negate().mul( 0.5 ).add( 0.5 ), 0, 1 ) ).mul( look.bounceGain );
		const ao = this.shade.y;
		const albedo = diffuseColor.rgb;
		// painted shade keeps (and slightly deepens) the colour instead of greying it
		const shadeAlbedo = max( mix( vec3( luminance( albedo ) ), albedo, look.shadowSaturation ), vec3( 0 ) );
		const skin = is( this.shade.x, KIND_SKIN );
		const warm = mix( vec3( 1 ), vec3( 1.1, 0.93, 0.88 ), skin );
		ctx.reflectedLight.indirectDiffuse.addAssign( shadeAlbedo.mul( warm ).mul( skyFill.add( bounce ).mul( ao ).mul( look.fillGain ) ) );

		// a cool, light rim along the silhouette's shaded side: the sky behind the figure and a
		// little of the sun scattered in it
		const fres = clamp( dot( normalView, positionViewDirection ), 0, 1 ).oneMinus();
		const shaded = this.lit ? this.lit.oneMinus() : float( 1 );
		const skyRim = smoothstep( 0.52, 0.78, fres ).mul( shaded ).mul( smoothstep( - 0.3, 0.5, up ) ).mul( look.skyRimGain );
		const rimLight = sky.mul( 2.2 ).add( this.shared.sunColor.mul( 0.05 ) );
		ctx.reflectedLight.indirectSpecular.addAssign( rimLight.mul( albedo.add( luminance( albedo ).mul( 0.5 ) ) ).mul( skyRim ) );

	}

}

/** The character light for a figure painted in vertex colours, with its shading channel per
 *  vertex in a `shade` attribute (kind, occlusion). */
export function makeVertexColourCharacterMaterial( shared: Shared ): THREE.MeshStandardNodeMaterial {

	const mat = new THREE.MeshStandardNodeMaterial( { roughness: 1, metalness: 0 } );
	mat.name = 'character';
	mat.userData.casterOfCharacterShadow = true;
	const shade = attribute<'vec4'>( 'shade', 'vec4' );
	mat.colorNode = vertexColor().rgb.mul( characterLook.albedo );
	( mat as unknown as { setupLightingModel: () => THREE.LightingModel } ).setupLightingModel = () => new CharacterLighting( shade, shared );
	return mat;

}
