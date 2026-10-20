/*!
 * Adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, If, texture, uniform, vec2, vec3, vec4, float, int, max, mix, clamp, smoothstep, exp, dot, length, select,
	screenCoordinate, positionWorld, normalWorld,
} from 'three/tsl';
import { ISLAND_TOP } from '../world/WorldShapes.ts';
import type { SunShadow } from './SunShadow.ts';
import type { Shared } from '../shared.ts';

// Sunlight bounced off the ground, one diffuse bounce (tidewater's GroundBounce, 4811ba4): the
// sunlit plateau lights the islanders' undersides and the grass from below, the bright shallows
// light the cliff's walls over them.
//
// The bake: a map over the world fields' bounds (the land's box and 32 m round it: shoreXform) of
// the light the ground reflects per unit of the key's irradiance: its albedo (the plateau's turf,
// stone over the rim's last metre and a half; over the sea the floor's sand, seagrass and the
// cliff foot's rubble seen through the water column, down and back up, as tidewater's sea) times
// the cosine of the key on the level ground times the key's visibility there (the sun's shadow map,
// a little above the ground so the plateau's relief stays under the lookup; tidewater takes its
// heightfield's shadow, which the island's own shadow map already holds here), minus what the
// environment's lower half already gives a face turned down (the distant sea's radiance, Sky's
// `seaRadiance`, where tidewater's environment has the atmosphere's dark ground), then blurred
// (a binomial 5x5 of 1 m steps, as 3x3 bilinear lookups). Alpha: the height of the bouncing
// surface (the plateau's top or the sea level). It is drawn at 256 texels, blurred into the
// caustics' array target (its last layer, Caustics `bounceLayer`): the materials lit under the
// water already bind WebGPU's 16 sampled textures, and the caustics' map is one of them. Like the
// caustics, it is drawn before the frame graph, after the sun's map. It is a function of the key's direction and colour, the sun's maps,
// the sea's radiance and the world fields. It is drawn with the sun's map: at each of its redraws
// (a step of the key's turn, SunShadow.ts), from that map alone and the key as it stands then, and
// whenever the sea's radiance or the fields change (a growth swap and a scene jump through
// `invalidate`, since the fields change in place). Drawn every frame the clock ran, its two passes
// took a tenth of a millisecond or more; between steps the key turns by at most 0.2 degrees, which
// moves the blurred bounce by far less than a level, and a paused frame draws it as a fresh load
// does (a jump redraws the sun's map from scratch, and this map with it).
//
// The shading: irradiance = the key's colour x the cloud shadow x the map x the lower hemisphere's
// view factor of the normal ( ( 1 - N.y ) / 2 ) x a fade with the height over the bouncing surface
// (none from a surface above the receiver: under the water the sea is above) x the self-shading of
// a face turned away from a low key (it sees the ground its own object shades) x SURROUND (objects
// round the receiver shade part of the ground it sees). The map is read in front of the face, REACH
// along its horizontal normal: tidewater reads under the point, which over its gentle shore and 4 m
// texels is the same ground, but a cliff's wall stands on the line between the plateau and the sea
// and sees the sea in front of it. One lookup at level 0, only for faces turned down or sideways
// above the sea.
//
// Every lit material adds it to its irradiance, so its diffuse albedo, its occlusion and its own
// ambient scale apply as to the sky's (tidewater adds it to the indirect diffuse light): a physical
// lighting model calls `addGroundBounce` at the start of its `indirect` (the terrain's, the
// vegetation's, `GroundBounceLightingModel` for the game's props), a model of its own reads
// `groundBounceLight` (the islanders'), never a bounce of its own. The water does not take it.
// The lookup is inlined into each material: as a layout function reading this module's uniforms and
// texture, r186 emits it with the first material's binding names in the next one (SeaDetail.ts).

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

// the bake's texels per side (the blurred map takes the caustics target's)
const RAW = 256;
// objects round the receiver shade part of the ground it sees (their shadows are not in the map)
const SURROUND = 0.6;
// the blur's step (m): a binomial 5x5 of these (sigma one step), about the ground a receiver a metre
// or two above it integrates
const BLUR_STEP = 1;
// how far in front of a face the ground it sees is read (m)
const REACH = 1;
// how far above the ground the bake takes the key's visibility (m): above the plateau's relief
const SHADOW_LIFT = 0.2;
// linear albedos: the plateau's turf (the islanders' former bounce, tidewater's grass), the rim's
// stone, and the floor's (SeabedLook's means)
const TURF = vec3( 0.075, 0.11, 0.032 ), RIM = vec3( 0.08, 0.075, 0.065 );
const SAND = vec3( 0.46, 0.435, 0.365 ), SEAGRASS = vec3( 0.095, 0.128, 0.065 ), RUBBLE = vec3( 0.29, 0.285, 0.25 );
// the water's own backscatter seen from above (tidewater's)
const WATER_BODY = vec3( 0.01, 0.025, 0.03 );

export interface GroundBounceInputs {
	renderer: THREE.WebGPURenderer;
	shared: Shared;
	sunShadow: SunShadow;
	// the world fields (WorldFields.ts): the shore's sea-level distance, the floor's height and beds
	fields: { shore: THREE.TextureNode; floor: THREE.TextureNode; beds: THREE.TextureNode };
	// the array target and layer the map is blurred into (Caustics `target`, `bounceLayer`)
	target: THREE.RenderTarget;
	layer: number;
	// the cloud shadow's visibility of the key at a world point
	cloud: ( position: V3 ) => F;
}

export class GroundBounce {

	readonly strength = uniform( 1 );
	/** Draws of the map so far. */
	bakes = 0;
	private readonly ready = uniform( 0 );
	// the environment's lower half per unit of the key's irradiance (see the header)
	private readonly envGround = uniform( new THREE.Vector3() );
	private readonly raw: THREE.RenderTarget;
	private readonly rawQuad: THREE.QuadMesh;
	private readonly blurQuad: THREE.QuadMesh;
	private signature = '';

	constructor( private readonly inputs: GroundBounceInputs ) {

		const { shared, sunShadow, fields, target } = inputs;
		this.raw = new THREE.RenderTarget( RAW, RAW, {
			type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false,
			minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
		} );
		this.raw.texture.name = 'groundBounceRaw';

		const rawMat = new THREE.NodeMaterial();
		rawMat.name = 'GroundBounce.Raw';
		rawMat.fragmentNode = Fn( () => {

			// the texel's centre (screen row 0 is texture row 0) and its world xz
			const at = screenCoordinate.xy.div( RAW ).toVar();
			const xz = shared.shoreXform.xy.add( at.div( shared.shoreXform.zw ) ).toVar();
			const sd = texture( fields.shore, at ).level( float( 0 ) ).r.toVar();
			const floorY = texture( fields.floor, at ).level( float( 0 ) ).r;
			const beds = texture( fields.beds, at ).level( float( 0 ) ).rg;
			const L = shared.sunDir;
			const land = mix( TURF.mul( shared.lawnGain ), RIM, smoothstep( - 1.5, 0, sd ) );
			// the sea: the floor seen through the water column, down and back up
			const depth = max( shared.waterLevel.sub( floorY ), 0 );
			const floor = mix( mix( SAND, SEAGRASS, smoothstep( 0.3, 0.7, beds.x ) ), RUBBLE, smoothstep( 6.5, 0.5, sd ).mul( 0.5 ) );
			const sea = floor.mul( exp( shared.sigA.add( shared.sigS ).mul( depth ).mul( - 2.4 ) ) ).mul( 0.9 ).add( WATER_BODY );
			const wet = smoothstep( - 0.25, 0.25, sd ).toVar();
			const albedo = mix( land, sea, wet );
			const top = mix( float( ISLAND_TOP ), shared.waterLevel, wet );
			const lift = select( wet.lessThan( 0.5 ), float( ISLAND_TOP ), shared.waterLevel ).add( SHADOW_LIFT );
			const visibility = sunShadow.currentPCFVisibility( sunShadow.coordinate.mul( vec4( xz.x, lift, xz.y, 1 ) ).xyz );
			const E = max( L.y, 0 ).mul( visibility ).mul( smoothstep( - 0.02, 0.05, L.y ) );
			return vec4( max( albedo.mul( E ).sub( this.envGround ), vec3( 0 ) ), top );

		} )();
		this.rawQuad = new THREE.QuadMesh( rawMat );
		this.rawQuad.name = 'GroundBounce.Raw';

		const blurMat = new THREE.NodeMaterial();
		blurMat.name = 'GroundBounce.Blur';
		blurMat.fragmentNode = Fn( () => {

			// the binomial 1 4 6 4 1 per axis as three bilinear taps (the outer pairs merged at their
			// weighted mean offset, 1.2 steps out): 9 lookups instead of 25
			const at = screenCoordinate.xy.div( target.width ).toVar();
			const step = shared.shoreXform.zw.mul( BLUR_STEP ).toVar();
			const taps = [ [ - 1.2, 5 / 16 ], [ 0, 6 / 16 ], [ 1.2, 5 / 16 ] ];
			let sum: THREE.Node<'vec4'> = vec4( 0 );
			for ( const [ y, wy ] of taps ) for ( const [ x, wx ] of taps ) {

				const tap = texture( this.raw.texture, at.add( step.mul( vec2( x, y ) ) ) ).level( float( 0 ) );
				sum = sum.add( tap.mul( wx * wy ) );

			}
			return sum;

		} )();
		this.blurQuad = new THREE.QuadMesh( blurMat );
		this.blurQuad.name = 'GroundBounce.Blur';

	}

	/** The bounce's irradiance at a world point and normal (none before the first bake). */
	irradiance( P: V3, N: V3 ): V3 {

		const { shared, target, layer } = this.inputs;
		const E = vec3( 0 ).toVar();
		const view = clamp( N.y.mul( - 0.5 ).add( 0.5 ), 0, 1 ).toVar();
		If( view.greaterThan( 0.03 ).and( P.y.greaterThan( shared.waterLevel.sub( 0.3 ) ) ).and( this.strength.greaterThan( 0 ) ).and( this.ready.greaterThan( 0 ) ), () => {

			const half = 0.5 / target.width;
			const at = clamp( P.xz.add( N.xz.mul( REACH ) ).sub( shared.shoreXform.xy ).mul( shared.shoreXform.zw ), half, 1 - half );
			const s = texture( target.texture, at ).depth( int( layer ) ).level( float( 0 ) ).toVar();
			const above = P.y.sub( s.w );
			// nothing from a surface above the receiver, a little less high up where more of the view
			// is taken by other objects
			const fade = smoothstep( - 0.3, 0.3, above ).mul( mix( float( 0.4 ), float( 1 ), smoothstep( 30, 4, above ) ) );
			// a face turned away from a low key looks at the ground its object shades (a long shadow)
			const L = shared.sunDir;
			const Lh = L.xz.div( max( length( L.xz ), 1e-3 ) );
			const selfShade = float( 1 ).sub( clamp( dot( N.xz, Lh ).negate(), 0, 1 ).mul( clamp( L.y.oneMinus(), 0, 1 ) ).mul( 0.6 ) );
			E.assign( s.rgb.mul( shared.sunColor ).mul( this.inputs.cloud( P ) ).mul( view.mul( fade ).mul( selfShade ).mul( this.strength ).mul( SURROUND ) ) );

		} );
		return E;

	}

	/** Once a frame, after the sun's map and the caustics: draws the map again at the sun's map's
	 * redraws and when the sea or the fields changed (see the header). `sea`: the environment's lower
	 * half (Sky `seaRadiance`). */
	update( sea: THREE.Color ): void {

		const { renderer: r, shared, sunShadow, target, layer } = this.inputs;
		const fill = shared.skyFill.value, x = shared.shoreXform.value;
		const signature = [ sunShadow.draws, sunShadow.ready.value, sea.r, sea.g, sea.b, fill,
			x.x, x.y, x.z, x.w, shared.waterLevel.value ].join( ',' );
		if ( signature === this.signature ) return;
		this.signature = signature;
		// a face turned down receives pi times the lower half's radiance from the environment
		const key = shared.sunColor.value;
		const per = ( radiance: number, k: number ) => Math.min( Math.PI * radiance * fill / Math.max( k, 1e-6 ), 1 );
		this.envGround.value.set( per( sea.r, key.x ), per( sea.g, key.y ), per( sea.b, key.z ) );
		const prev = r.getRenderTarget();
		r.setRenderTarget( this.raw );
		this.rawQuad.render( r );
		// (read at level 0 only: the caustics' mip chain is made after their own layers)
		const mips = target.texture.generateMipmaps;
		target.texture.generateMipmaps = false;
		r.setRenderTarget( target, layer );
		this.blurQuad.render( r );
		target.texture.generateMipmaps = mips;
		r.setRenderTarget( prev );
		this.ready.value = 1;
		this.bakes ++;

	}

	/** Draws the map again on the next update: the world fields changed in place (a growth swap) or
	 * the scene jumped. */
	invalidate(): void {

		this.signature = '';

	}

}

let installed: GroundBounce | null = null;

/** Makes `bounce` the ground bounce every lit material adds: before any of them builds. */
export function installGroundBounce( bounce: GroundBounce ): void {

	installed = bounce;

}

/** The ground bounce's irradiance at the surface being lit (none where none is installed). */
export function groundBounceLight(): V3 {

	return installed ? installed.irradiance( positionWorld, normalWorld ) : vec3( 0 );

}

/** Adds the ground bounce to a physical lighting model's irradiance: called at the start of its
 * `indirect`, before three's indirect diffuse reads the irradiance. */
export function addGroundBounce( builder: THREE.NodeBuilder ): void {

	( builder.context as unknown as { irradiance: V3 } ).irradiance.addAssign( groundBounceLight() );

}

/** Three's physical lighting with the ground bounce, for lit materials without a model of their own
 * (the game's props). */
export class GroundBounceLightingModel extends THREE.PhysicalLightingModel {

	indirect( builder: THREE.NodeBuilder ): void {

		addGroundBounce( builder );
		super.indirect( builder );

	}

}
