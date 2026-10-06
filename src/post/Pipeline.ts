import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, texture, textureLoad, rtt, uniform, uv, screenCoordinate, ivec2, vec2, vec3, vec4, float, mix,
	smoothstep, clamp, max, min, dot, length, abs, sqrt, cos, sin, luminance, neutralToneMapping, sRGBTransferOETF,
	fract, convertToTexture,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import type BloomNode from 'three/addons/tsl/display/BloomNode.js';
import { SCENE_RADIANCE_SCALE } from '../lighting/Radiometry.ts';
import { AerialPerspective } from '../weather/AerialPerspective.ts';
import { LightShafts } from './LightShafts.ts';
import type { Sky } from '../sky/Sky.ts';
import type { Rain } from '../weather/Rain.ts';

// Frame graph:
//   opaque scene ── sceneRT (MSAA x4, half float, multisampled depth)
//   depth resolve ── depthRT (view-space z, single sample: the water and the depth of field read it)
//   water ── waterRT + its depth (reads sceneRT's resolved colour and depthRT)
//   composite ── bloom (tight) + glow (wide), both through a clamped soft-knee prefilter
//   ── tilt-shift depth of field (half-res gather) ── exposure, PBR Neutral tone map,
//   split-tone grade, vibrance, lifted blacks, vignette, S-curve, grain, sRGB ── screen

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;

export interface PipelineSettings {
	exposure: number; saturation: number; vibrance: number; contrast: number; split: number;
	lift: THREE.Color; vignette: number; grain: number;
	bloomStrength: number; bloomRadius: number; bloomThreshold: number; bloomMaxLum: number;
	glowStrength: number; glowRadius: number; glowThreshold: number; glowMaxLum: number;
	dof: number; dofRange: number; dofMaxRadius: number; focusDistance: number;
}

export class Pipeline {

	renderer: THREE.WebGPURenderer;
	width = 1;
	height = 1;
	settings: PipelineSettings = {
		// The look's bright midtones and soft shadows are a display grade; keep the
		// calibrated sunlight and water transport intact, with a nearly neutral black lift.
		exposure: 2.35, saturation: 0.97, vibrance: 0.15, contrast: 0.04, split: 0.45,
		lift: new THREE.Color( 0.027, 0.027, 0.026 ),
		vignette: 0.06, grain: 0.004,
		bloomStrength: 0.22, bloomRadius: 0.3, bloomThreshold: 1.4, bloomMaxLum: 4.0,
		glowStrength: 0.1, glowRadius: 1.0, glowThreshold: 0.8, glowMaxLum: 1.0,
		dof: 0.65, dofRange: 8.0, dofMaxRadius: 6.0, focusDistance: 0,
	};

	sceneRT: THREE.RenderTarget;
	depthRT: THREE.RenderTarget;
	waterRT: THREE.RenderTarget;
	readonly air = new AerialPerspective();
	readonly shafts = new LightShafts();

	private depthQuad: THREE.QuadMesh;
	private output: THREE.RenderPipeline;
	private previousClearColor = new THREE.Color();
	private blooms: { node: BloomNode; maxLum: THREE.UniformNode<'float', number> }[] = [];
	private u = {
		exposure: uniform( 1 ), saturation: uniform( 1 ), vibrance: uniform( 0 ), contrast: uniform( 0 ), split: uniform( 1 ),
		lift: uniform( new THREE.Color() ), vignette: uniform( 0.3 ), grain: uniform( 0.01 ), time: uniform( 0 ),
		dof: uniform( 1 ), focus: uniform( 50 ), range: uniform( 3 ), resolution: uniform( new THREE.Vector2( 1, 1 ) ),
		// the scene camera's (inside a full-screen pass the camera nodes refer to the pass's own camera)
		projInv: uniform( new THREE.Matrix4() ),
		maxRadius: uniform( 6 ), texel: uniform( new THREE.Vector2( 1, 1 ) ),
	};

	constructor( renderer: THREE.WebGPURenderer, sky: Sky, rain?: Rain ) {

		this.renderer = renderer;
		const depthTexture = new THREE.DepthTexture( 1, 1 );
		depthTexture.type = THREE.FloatType;
		this.sceneRT = new THREE.RenderTarget( 1, 1, { type: THREE.HalfFloatType, samples: 4, depthTexture } );
		this.sceneRT.texture.name = 'sceneColor';
		this.depthRT = new THREE.RenderTarget( 1, 1, { type: THREE.FloatType, format: THREE.RedFormat, depthBuffer: false } );
		this.depthRT.texture.name = 'linearDepth';
		const waterDepth = new THREE.DepthTexture( 1, 1 );
		waterDepth.type = THREE.FloatType;
		this.waterRT = new THREE.RenderTarget( 1, 1, { type: THREE.HalfFloatType, depthTexture: waterDepth } );
		this.waterRT.texture.name = 'water';

		const u = this.u;
		const resolveMat = new THREE.NodeMaterial();
		// multisampled depth can only be loaded (sample 0); sky stays far away (-1e5)
		resolveMat.fragmentNode = Fn( () => {

			const coord = screenCoordinate.xy;
			const d = ( textureLoad( texture( depthTexture ), ivec2( coord ) ) as unknown as F ).toVar();
			const z = float( - 1e5 ).toVar();
			If( d.lessThan( 0.999999 ), () => {

				const q = coord.div( u.resolution );
				const v = u.projInv.mul( vec4( q.x.mul( 2 ).sub( 1 ), float( 1 ).sub( q.y ).mul( 2 ).sub( 1 ), d, 1 ) ).toVar();
				z.assign( v.z.div( v.w ) );

			} );
			return vec4( z );

		} )();
		this.depthQuad = new THREE.QuadMesh( resolveMat );

		// ---- composite: the water over the opaque image
		const sceneTex = texture( this.sceneRT.texture );
		const waterTex = texture( this.waterRT.texture );
		// Water writes alpha 1. Rain is normal-blended over transparent black, so this
		// combined target already contains premultiplied radiance; do not apply alpha twice.
		const overlay = sceneTex.rgb.mul( float( 1 ).sub( waterTex.a ) ).add( waterTex.rgb );
		const hdr = this.air.apply( overlay, this.depthRT.texture, waterDepth, sky, rain ? ( d, distance ) => rain.veil( d, distance ) : undefined )
			.add( this.shafts.build( this.depthRT.texture, waterDepth, sky ) );

		// ---- blooms: glints clamped first so a few firefly pixels cannot flood the frame, then a
		// soft knee instead of a hard threshold
		const makeBloom = () => {

			const maxLum = uniform( 5 );
			const node = bloom( vec4( hdr, 1 ), 0.3, 0.5, 1.5 );
			( node as unknown as { highPassFn: unknown } ).highPassFn = Fn( ( { input, threshold }: { input: THREE.Node<'vec4'>; threshold: THREE.Node<'float'> } ) => {

				const c = input.rgb;
				const v0 = luminance( c );
				const c1 = c.mul( min( float( 1 ), maxLum.div( max( v0, 1e-4 ) ) ) );
				const v = min( v0, maxLum );
				const knee = threshold.mul( 0.5 );
				const soft0 = clamp( v.sub( threshold ).add( knee ), 0, knee.mul( 2 ) );
				const soft = soft0.mul( soft0 ).div( knee.mul( 4 ).add( 1e-4 ) );
				return vec4( c1.mul( max( soft, v.sub( threshold ) ) ).div( max( v, 1e-4 ) ), 1 );

			} );
			this.blooms.push( { node, maxLum } );
			return node;

		};

		const withBloom = hdr.add( makeBloom().rgb ).add( makeBloom().rgb );

		// ---- tilt-shift depth of field: a half-res gather over a golden-angle disc whose radius grows
		// with the circle of confusion; a sample only counts where its own blur reaches this pixel
		// (no sharp halos round in-focus edges), then mixed over the sharp image by its coc
		const sharp = convertToTexture( vec4( withBloom, 1 ) );
		const tD = texture( this.depthRT.texture ), tW = texture( waterDepth );
		// the distance to the nearest surface, the water's included (view-space z: closer is larger)
		const cocAt = Fn( ( [ q ]: [ V2 ] ) => {

			const px = ivec2( clamp( q.mul( u.resolution ), vec2( 0 ), u.resolution.sub( 1 ) ) );
			const z = ( textureLoad( tD, px ) as unknown as F ).toVar();
			const dw = ( textureLoad( tW, px ) as unknown as F ).toVar();
			const ndc = vec2( q.x.mul( 2 ).sub( 1 ), float( 1 ).sub( q.y ).mul( 2 ).sub( 1 ) ).toVar();
			If( dw.lessThan( 1 ), () => {

				const w = u.projInv.mul( vec4( ndc, dw, 1 ) ).toVar();
				z.assign( max( z, w.z.div( w.w ) ) );

			} );
			const dist = float( 1e5 ).toVar();
			If( z.greaterThan( - 9e4 ), () => {

				const v = u.projInv.mul( vec4( ndc, 1, 1 ) ).toVar();
				const dir = v.xyz.div( v.w ).toVar();
				dist.assign( length( dir.mul( z.div( dir.z ) ) ) );

			} );
			// The miniature blur is for the island's surroundings. Kilometres out it eases off, so the
			// sky and the horizon keep their scale: blurred, clouds read as a backdrop close behind
			// the island and every star spreads into a bokeh disc.
			const far = mix( float( 1 ), float( 0.15 ), smoothstep( 1500, 15000, dist ) );
			return clamp( abs( dist.sub( u.focus ) ).sub( u.range ).div( u.focus.mul( 0.55 ) ), 0, 1 ).mul( far );

		} ).setLayout( { name: 'cocAt', type: 'float', inputs: [ { name: 'q', type: 'vec2' } ] } );
		const TAPS = 36, GA = 2.39996323;
		const gather = Fn( () => {

			const q = uv();
			const c0 = cocAt( q ).toVar();
			const acc = vec3( 0 ).toVar(), wsum = float( 0 ).toVar();
			Loop( TAPS, ( { i } ) => {

				const fi = float( i );
				const r = sqrt( fi.add( 0.5 ).div( TAPS ) ).toVar();
				const a = fi.mul( GA );
				const o = vec2( cos( a ), sin( a ) ).mul( r ).mul( u.maxRadius ).mul( u.texel );
				const p = q.add( o.mul( max( c0, 0 ) ) ).toVar();
				const w = smoothstep( r.sub( 0.15 ), r, max( cocAt( p ), c0.mul( 0.5 ) ).add( 0.1 ) ).toVar();
				acc.addAssign( texture( sharp, p ).level( float( 0 ) ).rgb.mul( w ) );
				wsum.addAssign( w );

			} );
			return vec4( acc.div( max( wsum, 1e-4 ) ), c0 );

		} )();
		const blur = rtt( gather, null, null, { type: THREE.HalfFloatType, resolutionScale: 0.5 } );
		const lin = mix( sharp.rgb, blur.rgb, smoothstep( 0, 0.35, blur.a ).mul( u.dof ) );

		// ---- grade
		const graded = Fn( () => {

			const c = ( neutralToneMapping( lin, u.exposure ) as THREE.Node<'vec3'> ).toVar();
			// teal-blue shadows, golden highlights
			const l = luminance( c );
			const tint = mix( vec3( 0.96, 1.0, 1.04 ), vec3( 1.1, 1.0, 0.82 ), smoothstep( 0.02, 0.45, l ) );
			c.mulAssign( mix( vec3( 1 ), tint, u.split ) );
			// saturation with vibrance: muted colours gain more than already saturated ones
			const l2 = luminance( c );
			const chroma = max( c.r, max( c.g, c.b ) ).sub( min( c.r, min( c.g, c.b ) ) );
			const satAmt = u.saturation.add( u.vibrance.mul( float( 1 ).sub( smoothstep( 0, 0.35, chroma.div( max( l2, 1e-3 ) ).mul( 0.5 ) ) ) ) );
			c.assign( max( mix( vec3( l2 ), c, satAmt ), vec3( 0 ) ) );
			// A display black lift softens dark colours without adding atmospheric scattering.
			c.assign( c.add( vec3( 1 ).sub( c ).mul( u.lift ) ) );
			// vignette
			const q = uv().sub( 0.5 ).mul( vec2( u.resolution.x.div( u.resolution.y ), 1 ) );
			c.mulAssign( mix( float( 1 ), smoothstep( 1.15, 0.3, length( q ) ), u.vignette ) );
			const s = ( sRGBTransferOETF( clamp( c, 0, 1 ) ) as THREE.Node<'vec3'> ).toVar();
			// gentle S-curve in display space
			s.assign( mix( s, s.mul( s ).mul( float( 3 ).sub( s.mul( 2 ) ) ), u.contrast ) );
			// grain + dither
			const hash = ( p: THREE.Node<'vec2'> ) => fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ).mul( 43758.5453 ) );
			const px = uv().mul( u.resolution );
			const g = hash( px.add( fract( u.time.mul( 13 ) ).mul( 100 ) ) ).sub( 0.5 );
			s.addAssign( g.mul( u.grain ).add( hash( px.mul( 1.37 ) ).sub( 0.5 ).div( 255 ) ) );
			return vec4( s, 1 );

		} )();

		this.output = new THREE.RenderPipeline( renderer, graded );
		this.output.outputColorTransform = false;

	}

	setSize( w: number, h: number ): void {

		this.width = w; this.height = h;
		this.sceneRT.setSize( w, h );
		this.depthRT.setSize( w, h );
		this.waterRT.setSize( w, h );
		this.u.resolution.value.set( w, h );
		this.u.texel.value.set( 1 / w, 1 / h );

	}

	render( { scene, waterScene, rainScene, camera, water, sun, time }: { scene: THREE.Scene; waterScene: THREE.Scene; rainScene?: THREE.Scene; camera: THREE.Camera; water: { prepare( sun: THREE.DirectionalLight ): void } | null; sun: THREE.DirectionalLight; time: number } ): void {

		const r = this.renderer;
		const S = this.settings;
		const u = this.u;

		camera.updateMatrixWorld();
		u.projInv.value.copy( ( camera as THREE.PerspectiveCamera ).projectionMatrixInverse );
		this.air.update( camera, this.width, this.height );
		this.shafts.update( camera as THREE.PerspectiveCamera, this.width, this.height, this.air.haze.value,
			this.air.fogTransmittance( camera.position.y, this.shafts.sunDirection ) );

		// 1. opaque
		r.setRenderTarget( this.sceneRT );
		r.render( scene, camera );

		// 2. linear depth
		r.setRenderTarget( this.depthRT );
		this.depthQuad.render( r );

		// 3. Water, then world-space rain in the same target. The attached water depth
		// occludes drops; their material also compares the resolved opaque depth. Rain does
		// not write depth, so surface focus and overlapping translucent streaks are preserved.
		const prevAlpha = r.getClearAlpha();
		r.getClearColor( this.previousClearColor );
		const autoClear = r.autoClear;
		r.setRenderTarget( this.waterRT );
		try {

			r.setClearColor( 0, 0 );
			r.clear();
			r.autoClear = false;
			if ( water ) {

				water.prepare( sun );
				r.render( waterScene, camera );

			}
			if ( rainScene ) r.render( rainScene, camera );

		} finally {

			r.autoClear = autoClear;
			r.setClearColor( this.previousClearColor, prevAlpha );
			r.setRenderTarget( null );

		}

		// 4. composite, bloom, depth of field, grade
		const [ b, g ] = this.blooms;
		b.node.strength.value = S.bloomStrength; b.node.radius.value = S.bloomRadius; b.node.threshold.value = S.bloomThreshold * SCENE_RADIANCE_SCALE; b.maxLum.value = S.bloomMaxLum * SCENE_RADIANCE_SCALE;
		g.node.strength.value = S.glowStrength; g.node.radius.value = S.glowRadius; g.node.threshold.value = S.glowThreshold * SCENE_RADIANCE_SCALE; g.maxLum.value = S.glowMaxLum * SCENE_RADIANCE_SCALE;
		u.exposure.value = S.exposure / SCENE_RADIANCE_SCALE; u.saturation.value = S.saturation; u.vibrance.value = S.vibrance; u.contrast.value = S.contrast;
		u.split.value = S.split; u.lift.value.copy( S.lift ); u.vignette.value = S.vignette; u.grain.value = S.grain; u.time.value = time;
		u.dof.value = S.dof; u.range.value = S.dofRange;
		u.maxRadius.value = S.dofMaxRadius * this.height / 900; // blur scales with the image, not the pixel count
		u.focus.value = S.focusDistance > 0 ? S.focusDistance : camera.position.length();
		this.output.render();

	}

}
