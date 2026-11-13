import * as THREE from 'three/webgpu';
import {
	attribute, uniform, vec3, vec4, float, mix, smoothstep, clamp, dot, max, abs, pow, normalize, luminance, select,
	normalView, normalWorld, positionViewDirection, positionLocal, positionPrevious, positionWorld,
	diffuseColor, vertexColor,
} from 'three/tsl';
import { TEMPORAL, groundBounceLight, motionNode, motionState, velocityOutput, debugFlags, useLightLayer, ambient, gradeOcclusion, shadeLocalLights, ambientField, ambientPoint, ambientVolumeOn, liftKey, keyDeckShare, keyLandVisibility, type Shared, meterAmbient, meterKey, meterStart, writeMeter } from '../render.ts';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;
type Reflected = { directDiffuse: V3; directSpecular: V3; indirectDiffuse: V3; indirectSpecular: V3 };

// Characters are drawn rather than rendered: sunlight steps from light to shade over a narrow
// band, the shade is filled by the same sky and sunlit ground that light the island, and a
// thin rim catches the sun along the silhouette. The light's colour, the sky's irradiance and
// the shadow maps are the scene's own, so a figure sits in the island's light while its forms
// stay simple and graphic. Flat colours and simple faces in the island's palette, soft cel steps,
// no outlines; plants keep their realistic shading (docs/explanation/art-direction.md). The cel light, its
// highlight included, takes the key's shading direction (lighting/KeyLift.ts: lifted under a low
// key, the moon's fixed direction by night), as the island's materials and the shadow maps do.
//
// The cast shadow is read as the ratio of the key the shadow maps let through to the open key:
// under a deck the open key is the one the land keeps there, its floor through the clouds' shadow
// (lighting/KeyCloud.ts), by the deck's light, so a figure in the floor's light reads lit and the
// shadows cast on it read as shadows; the rim takes the same open key.
//
// The sky fill and the rim take the ambient volume's light where the figure stands
// (lighting/AmbientSample.ts), as the island round it does; with `flags=ambientVolume:0` the
// island's level sky and the environment's irradiance.
// The ambient grade (lighting/AmbientGrade.ts) scales the sky rim by
// `skySpecular`, the ground's bounce by `sunBounce` (as every material takes it), and the baked
// occlusion in the fill by `aoStrength`. The local lights (lighting/LocalLights.ts) light a figure
// with plain Lambert diffuse on its albedo (its key has no Fresnel weight), under the fill's
// occlusion.
//
// The metering illuminance (lighting/MeterLight.ts) takes the cel light's own factors: the key by
// the band, the cast shadow and the form step, the fill (sky and the ground's bounce) by its
// occlusion and gain, as the colour does.
// Under the temporal modes the material writes the figure's motion vectors, its walk and its
// skin kept apart (see "motion vectors" below).

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
	// tone, so the figure's fill (sky and the ground's bounce) is lifted well above the island's.
	fillGain: uniform( 2 ),
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
	sun: V3 | null = null;

	constructor( shade: V4, shared: Shared ) {

		super();
		this.shade = shade;
		this.shared = shared;
		// the lighting layer's debug views (debug/LightLayer.ts), as the physical models take them
		useLightLayer( this );

	}

	start( builder: THREE.NodeBuilder ): void {

		// the metering illuminance's sums (lighting/MeterLight.ts), filled by the terms below
		meterStart();
		super.start( builder );

	}

	direct( { lightDirection, lightColor, reflectedLight: out }: THREE.LightingModelDirectInput ): void {

		const reflectedLight = out as unknown as Reflected;

		// the key's shading direction, as the island's materials take it (lifted under a low key, the
		// moon's fixed direction by night: lighting/KeyLift.ts)
		const L = liftKey( lightDirection as V3 ).toVar(), N = normalView, V = positionViewDirection;
		const kind = this.shade.x;
		const skin = is( kind, KIND_SKIN ), hair = is( kind, KIND_HAIR );
		const shiny = is( kind, KIND_METAL ).add( is( kind, KIND_LEATHER ).mul( 0.25 ) );
		// the open key the shadow maps are read against: three's sun, the land's key, and under a deck
		// the key the land keeps in the open there, its floor (the deck's key gain on it) through the
		// clouds' shadow (lighting/KeyCloud.ts `keyDeckShare`), so a figure under the deck's light
		// reads lit and its cast shadow as a shadow
		const sun = this.shared.landKey.mul( mix( float( 1 ), keyLandVisibility( positionWorld ), keyDeckShare ) ).toVar();
		this.sun = sun;
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
		// the key's metering illuminance by the cel light's own factor, as the diffuse takes it
		meterKey.addAssign( sun.mul( lit.mul( form ).mul( look.sunGain ) ) );
		// light scattered under the skin warms the edge between light and shade
		const edge = band.mul( band.oneMinus() ).mul( 4 ).mul( cast ).mul( skin );
		reflectedLight.directDiffuse.addAssign( sun.mul( albedo ).mul( vec3( 0.85, 0.22, 0.1 ) ).mul( edge.mul( 0.3 / Math.PI ) ) );

		// a crisp highlight on brass and the sheen of worn leather; hair shows a soft sheen band
		const H = normalize( L.add( V ) );
		const ndh = clamp( dot( N, H ), 0, 1 );
		const spot = smoothstep( 0.9, 0.95, ndh ).mul( shiny ).add( pow( ndh, 24 ).mul( hair ).mul( 0.12 ) );
		reflectedLight.directSpecular.addAssign( sun.mul( spot.mul( cast ).mul( look.albedo ).mul( 0.35 / Math.PI ) ) );

	}

	indirect( builder: THREE.NodeBuilder ): void {

		const ctx = builder.context as unknown as { iblIrradiance: V3; reflectedLight: Reflected };
		const look = characterLook;
		// With the ambient volume (lighting/AmbientSample.ts) the sky is its light where the figure
		// stands (graded by the relight already), degree 1 in front of the surface; without it the
		// island's level sky and the environment's irradiance.
		const volume = ambientVolumeOn( 'figures' ) ? ambientField( ambientPoint( positionWorld, normalWorld ), 1 ) : null;
		// E / pi on a level surface, as lent to the island
		const sky = volume ? volume.at( vec3( 0, 1, 0 ) ).mul( 1 / Math.PI ).toVar() : this.shared.islandIrradianceSource;
		const up = normalWorld.y;
		// The shade side keeps one fill colour (a flattened sky dome), with a little of the
		// environment's direction for warmth toward the sun and blue away from it.
		const dome = sky.mul( mix( float( 0.55 ), float( 1 ), up.mul( 0.5 ).add( 0.5 ) ) );
		const env = volume ? volume.at( normalWorld ).mul( 1 / Math.PI ) : ( ctx.iblIrradiance ).mul( 1 / Math.PI );
		const skyFill = mix( dome, env, 0.3 );
		// the sunlit ground below throws its light up into the shade (lighting/GroundBounce.ts), E / pi
		// as the sky's
		const bounce = groundBounceLight().mul( 1 / Math.PI );
		const ao = gradeOcclusion( this.shade.y ).toVar();
		const albedo = diffuseColor.rgb;
		// painted shade keeps (and slightly deepens) the colour instead of greying it
		const shadeAlbedo = max( mix( vec3( luminance( albedo ) ), albedo, look.shadowSaturation ), vec3( 0 ) );
		const skin = is( this.shade.x, KIND_SKIN );
		const warm = mix( vec3( 1 ), vec3( 1.1, 0.93, 0.88 ), skin );
		const fill = skyFill.add( bounce ).mul( ao ).mul( look.fillGain ).toVar();
		ctx.reflectedLight.indirectDiffuse.addAssign( shadeAlbedo.mul( warm ).mul( fill ) );
		// the fill's metering illuminance (E, from its E / pi: lighting/MeterLight.ts)
		meterAmbient.addAssign( fill.mul( Math.PI ) );
		// the local lights (lighting/LocalLights.ts): plain Lambert, as the figure's key has no
		// Fresnel weight, under the figure's own occlusion
		shadeLocalLights( builder, ( L, light ) => {

			const lambert = light.mul( clamp( dot( normalView, L ), 0, 1 ) ).toVar();
			return { reflected: lambert.mul( albedo ), meter: lambert };

		}, ao );

		// a cool, light rim along the silhouette's shaded side: the sky behind the figure and a
		// little of the sun scattered in it (the open key `direct` reads its shadows against)
		const fres = clamp( dot( normalView, positionViewDirection ), 0, 1 ).oneMinus();
		const shaded = this.lit ? this.lit.oneMinus() : float( 1 );
		const skyRim = smoothstep( 0.52, 0.78, fres ).mul( shaded ).mul( smoothstep( - 0.3, 0.5, up ) ).mul( look.skyRimGain );
		const open = this.sun ?? vec3( this.shared.landKey );
		const rimLight = sky.mul( 2.2 ).add( open.mul( 0.05 ) );
		ctx.reflectedLight.indirectSpecular.addAssign( rimLight.mul( albedo.add( luminance( albedo ).mul( 0.5 ) ) ).mul( skyRim ).mul( ambient.skySpecular ) );

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
	writeMeter( mat );
	if ( TEMPORAL ) addSkinnedMotion( mat );
	return mat;

}

// ---- motion vectors (the temporal modes: Antialiasing.ts, Motion.ts)

// A figure's motion is its object's (the walk moves and turns the figure's group: Motion.ts takes
// its world matrix a rendered frame ago) and its skin's (the clips move the bones under it).
// three's skinning gives the vertex skinned by the previous frame's bones (`positionPrevious`,
// whenever the draw needs previous data), but in the mesh's CURRENT space: in the attached bind
// mode the bones' matrices are world matrices, so they carry the walk too, and three's
// `bindMatrixInverse` is the inverse of the mesh's world matrix now. Taken as it is, under
// Motion's previous model matrix, the walk would count twice. It is rebased here into the mesh's
// space a rendered frame ago, inverse( previous world ) x world now, so the previous world point
// is the previous bones' and the two motions stay apart: `flags.mv.object = false` leaves the walk
// out, `flags.mv.skin = false` the clips (the previous skinned vertex is the current one). Across
// a cut (`taaCut`), or when the figure was not drawn in the rendered frame before, its skin does
// not move either: three's previous bones are then those of whenever it was last drawn.

interface SkinTrack { frame: number; current: THREE.Matrix4; previous: THREE.Matrix4; rebase: THREE.Matrix4; moving: boolean }
const skinTracks = new WeakMap<THREE.Object3D, SkinTrack>();

// the figure's state for the rendered frame being drawn, updated at its first draw in that frame
function skinTrackOf( object: THREE.Object3D ): SkinTrack {

	const frame = motionState.frame;
	let t = skinTracks.get( object );
	if ( t === undefined ) {

		t = { frame: - 1, current: object.matrixWorld.clone(), previous: new THREE.Matrix4(), rebase: new THREE.Matrix4(), moving: false };
		skinTracks.set( object, t );

	}
	if ( t.frame !== frame ) {

		const continuous = t.frame === frame - 1 && ! motionState.cut;
		t.previous.copy( continuous ? t.current : object.matrixWorld );
		t.current.copy( object.matrixWorld );
		t.rebase.copy( t.previous ).invert().multiply( t.current );
		t.moving = continuous && debugFlags.mv.skin !== false;
		t.frame = frame;

	}
	return t;

}

// (object uniforms: set for each draw before its bindings are uploaded)
const skinRebase = uniform( new THREE.Matrix4() ).onObjectUpdate( ( { object } ) => object ? skinTrackOf( object ).rebase : undefined );
const skinMoving = uniform( 0 ).onObjectUpdate( ( { object } ) => object ? ( skinTrackOf( object ).moving ? 1 : 0 ) : undefined );

/** A figure's velocity under the temporal modes: class character, its skin's previous vertex in
 * the mesh's previous space (see above). */
export function addSkinnedMotion( mat: THREE.MeshStandardNodeMaterial ): void {

	const material = mat as unknown as { setupPosition( builder: THREE.NodeBuilder ): THREE.Node };
	const setupPosition = material.setupPosition.bind( mat );
	material.setupPosition = ( builder: THREE.NodeBuilder ) => {

		// after three's skinning, which assigns both positions
		const position = setupPosition( builder );
		const b = builder as unknown as { object: THREE.Object3D | null; needsPreviousData(): boolean };
		if ( ( b.object as THREE.SkinnedMesh | null )?.isSkinnedMesh === true && b.needsPreviousData() ) {

			const rebased = skinRebase.mul( vec4( positionPrevious, 1 ) ).xyz;
			positionPrevious.assign( select( skinMoving.greaterThan( 0.5 ), rebased, positionLocal ) );

		}
		return position;

	};
	mat.mrtNode = velocityOutput( motionNode( 'character' ) );

}
