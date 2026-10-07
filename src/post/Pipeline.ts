import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, texture, textureLoad, rtt, uniform, uv, screenCoordinate, ivec2, int, vec2, vec3, vec4, float, mix,
	smoothstep, clamp, max, min, dot, length, abs, sqrt, cos, sin, luminance, neutralToneMapping, sRGBTransferOETF,
	fract, convertToTexture, select,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import type BloomNode from 'three/addons/tsl/display/BloomNode.js';
import { SCENE_RADIANCE_SCALE } from '../lighting/Radiometry.ts';
import { AerialPerspective } from '../weather/AerialPerspective.ts';
import { LightShafts } from './LightShafts.ts';
import { DAY_BLACK_LIFT } from '../sky/DayCycle.ts';
import type { Sky } from '../sky/Sky.ts';
import type { Rain } from '../weather/Rain.ts';

// Frame graph:
//   opaque scene ── sceneRT (MSAA x4, half float, multisampled depth)
//   depth resolve ── depthRT (view-space z of the opaque pass: sample 0, and the farthest sample)
//   opaque copy ── opaqueRT (the resolved opaque colour: what the water refracts and reflects)
//   water ── back into sceneRT, depth-tested per sample against the opaque samples
//   surface resolve ── surfaceRT (view-space z of the nearest surface, the sea's included)
//   rain ── into sceneRT
//   composite ── bloom (tight) + glow (wide), both through a clamped soft-knee prefilter
//   ── tilt-shift depth of field (half-res gather) ── exposure, PBR Neutral tone map,
//   split-tone grade, vibrance, lifted blacks, vignette, S-curve, grain, sRGB ── screen

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;

export interface PipelineSettings {
	exposure: number; saturation: number; vibrance: number; contrast: number; split: number;
	lift: THREE.Color; vignette: number; grain: number;
	bloomStrength: number; bloomRadius: number; bloomThreshold: number; bloomMaxLum: number; bloomSurfaceMaxLum: number;
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
		lift: new THREE.Color( DAY_BLACK_LIFT, DAY_BLACK_LIFT, DAY_BLACK_LIFT * 0.97 ),
		vignette: 0.06, grain: 0.004,
		bloomStrength: 0.22, bloomRadius: 0.3, bloomThreshold: 1.4, bloomMaxLum: 4.0, bloomSurfaceMaxLum: 2.0,
		glowStrength: 0.1, glowRadius: 1.0, glowThreshold: 0.8, glowMaxLum: 1.0,
		dof: 0.65, dofRange: 8.0, dofMaxRadius: 6.0, focusDistance: 0,
	};

	sceneRT: THREE.RenderTarget;
	depthRT: THREE.RenderTarget;
	opaqueRT: THREE.RenderTarget;
	surfaceRT: THREE.RenderTarget;
	readonly air = new AerialPerspective();
	readonly shafts = new LightShafts();

	private depthQuad: THREE.QuadMesh;
	private copyQuad: THREE.QuadMesh;
	private surfaceQuad: THREE.QuadMesh;
	private output: THREE.RenderPipeline;
	private blooms: { node: BloomNode; maxLum: THREE.UniformNode<'float', number>; surfaceMaxLum: THREE.UniformNode<'float', number> }[] = [];
	private u = {
		exposure: uniform( 1 ), saturation: uniform( 1 ), vibrance: uniform( 0 ), contrast: uniform( 0 ), split: uniform( 1 ),
		lift: uniform( new THREE.Color() ), vignette: uniform( 0.3 ), grain: uniform( 0.01 ), time: uniform( 0 ),
		dof: uniform( 1 ), focus: uniform( 50 ), range: uniform( 3 ), resolution: uniform( new THREE.Vector2( 1, 1 ) ),
		// the scene camera's (inside a full-screen pass the camera nodes refer to the pass's own camera)
		projInv: uniform( new THREE.Matrix4() ),
		maxRadius: uniform( 6 ), texel: uniform( new THREE.Vector2( 1, 1 ) ), halfRes: uniform( new THREE.Vector2( 1, 1 ) ),
	};

	constructor( renderer: THREE.WebGPURenderer, sky: Sky, rain?: Rain ) {

		this.renderer = renderer;
		const depthTexture = new THREE.DepthTexture( 1, 1 );
		depthTexture.type = THREE.FloatType;
		this.sceneRT = new THREE.RenderTarget( 1, 1, { type: THREE.HalfFloatType, samples: 4, depthTexture } );
		this.sceneRT.texture.name = 'sceneColor';
		this.depthRT = new THREE.RenderTarget( 1, 1, { type: THREE.FloatType, format: THREE.RGFormat, depthBuffer: false } );
		this.depthRT.texture.name = 'linearDepth';
		this.opaqueRT = new THREE.RenderTarget( 1, 1, { type: THREE.HalfFloatType, depthBuffer: false } );
		this.opaqueRT.texture.name = 'opaqueColor';
		this.surfaceRT = new THREE.RenderTarget( 1, 1, { type: THREE.FloatType, format: THREE.RedFormat, depthBuffer: false } );
		this.surfaceRT.texture.name = 'surfaceDepth';

		const u = this.u;
		// Multisampled depth can only be loaded, a sample at a time. The sky stays far away (-1e5).
		const viewZ = ( coord: V2, d: F ) => {

			const z = float( - 1e5 ).toVar();
			If( d.lessThan( 0.999999 ), () => {

				const q = coord.div( u.resolution );
				const v = u.projInv.mul( vec4( q.x.mul( 2 ).sub( 1 ), float( 1 ).sub( q.y ).mul( 2 ).sub( 1 ), d, 1 ) ).toVar();
				z.assign( v.z.div( v.w ) );

			} );
			return z;

		};
		const msDepth = texture( depthTexture );
		const depthSample = ( coord: V2, i: number ) => textureLoad( msDepth, ivec2( coord ), int( i ) ) as unknown as F;
		// Sample 0 for what reads the depth at a point (the water's traces, rain, spray, the haze and
		// the blur), and the farthest of the four samples for the water's view of what lies behind it.
		// The water is shaded once per pixel, but drawn only into the samples it is in front of: at an
		// edge pixel where a cliff, a figure or a leaf covers sample 0, the samples the water does
		// cover hold what is behind it, the farthest one.
		const resolveMat = new THREE.NodeMaterial();
		resolveMat.fragmentNode = Fn( () => {

			const coord = screenCoordinate.xy;
			const d0 = depthSample( coord, 0 ).toVar();
			const far = max( max( d0, depthSample( coord, 1 ) ), max( depthSample( coord, 2 ), depthSample( coord, 3 ) ) );
			return vec4( viewZ( coord, d0 ), viewZ( coord, far ), 0, 0 );

		} )();
		this.depthQuad = new THREE.QuadMesh( resolveMat );
		const copyMat = new THREE.NodeMaterial();
		copyMat.fragmentNode = textureLoad( texture( this.sceneRT.texture ), ivec2( screenCoordinate.xy ) );
		this.copyQuad = new THREE.QuadMesh( copyMat );
		const surfaceMat = new THREE.NodeMaterial();
		surfaceMat.fragmentNode = Fn( () => vec4( viewZ( screenCoordinate.xy, depthSample( screenCoordinate.xy, 0 ) ) ) )();
		this.surfaceQuad = new THREE.QuadMesh( surfaceMat );

		// ---- composite: the scene target holds the opaque image with the sea and the rain drawn over it
		const sceneTex = texture( this.sceneRT.texture );
		const surfaceDepth = this.surfaceRT.texture;
		const hdr = this.air.apply( sceneTex.rgb, surfaceDepth, sky, rain ? ( d, distance, background ) => rain.veil( d, distance, background ) : undefined )
			.add( this.shafts.build( surfaceDepth, sky ) );

		// ---- blooms: glints clamped first so a few firefly pixels cannot flood the frame, then a
		// soft knee instead of a hard threshold. On surfaces (anything in front of the sky) the
		// tight bloom's clamp sits just above its threshold (bloomSurfaceMaxLum 2 against 1.4):
		// every pixel of the sun's glitter path reaches the clamp, so a higher one let the path's
		// bloom pile up into a bright column over the island. The sky keeps the higher clamp, so
		// the sun's disc and a lightning channel (drawn without depth) keep their glow.
		const tBloomD = texture( surfaceDepth );
		const makeBloom = () => {

			const maxLum = uniform( 5 ), surfaceMaxLum = uniform( 5 );
			const node = bloom( vec4( hdr, 1 ), 0.3, 0.5, 1.5 );
			( node as unknown as { highPassFn: unknown } ).highPassFn = Fn( ( { input, threshold }: { input: THREE.Node<'vec4'>; threshold: THREE.Node<'float'> } ) => {

				const px = ivec2( clamp( uv().mul( u.resolution ), vec2( 0 ), u.resolution.sub( 1 ) ) );
				const surface = ( textureLoad( tBloomD, px ) as unknown as F ).greaterThan( - 9e4 );
				const clampLum = select( surface, surfaceMaxLum, maxLum );
				const c = input.rgb;
				const v0 = luminance( c );
				const c1 = c.mul( min( float( 1 ), clampLum.div( max( v0, 1e-4 ) ) ) );
				const v = min( v0, clampLum );
				const knee = threshold.mul( 0.5 );
				const soft0 = clamp( v.sub( threshold ).add( knee ), 0, knee.mul( 2 ) );
				const soft = soft0.mul( soft0 ).div( knee.mul( 4 ).add( 1e-4 ) );
				return vec4( c1.mul( max( soft, v.sub( threshold ) ) ).div( max( v, 1e-4 ) ), 1 );

			} );
			this.blooms.push( { node, maxLum, surfaceMaxLum } );
			return node;

		};

		const withBloom = hdr.add( makeBloom().rgb ).add( makeBloom().rgb );

		// ---- tilt-shift depth of field: a half-res gather over a golden-angle disc whose radius grows
		// with the circle of confusion; a sample only counts where its blur reaches this pixel, then
		// the blur is mixed over the sharp image by the full-resolution coc
		const sharp = convertToTexture( vec4( withBloom, 1 ) );
		const tD = texture( surfaceDepth );
		// The circle of confusion (0..1 of the widest blur) and the distance to the nearest surface,
		// the water's included (view-space z: closer is larger). One function per pass: a layout
		// function shared by two shaders keeps the first one's uniform bindings.
		const makeCocAt = () => Fn( ( [ q ]: [ V2 ] ) => {

			const px = ivec2( clamp( q.mul( u.resolution ), vec2( 0 ), u.resolution.sub( 1 ) ) );
			const z = ( textureLoad( tD, px ) as unknown as F ).toVar();
			const ndc = vec2( q.x.mul( 2 ).sub( 1 ), float( 1 ).sub( q.y ).mul( 2 ).sub( 1 ) ).toVar();
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
			return vec2( clamp( abs( dist.sub( u.focus ) ).sub( u.range ).div( u.focus.mul( 0.55 ) ), 0, 1 ).mul( far ), dist );

		} ).setLayout( { name: 'cocAt', type: 'vec2', inputs: [ { name: 'q', type: 'vec2' } ] } );
		const cocAt = makeCocAt();
		// The blur's radius, in units of the widest one. It grows faster than the coc, so the
		// transition out of focus stays gentle (as the earlier gather's weights made it).
		const spread = ( c: F ) => c.mul( min( c.add( 0.15 ), 1 ) );
		const TAPS = 36, GA = 2.39996323;
		// The gather averages colours compressed by their displayed luminance (c / (1 + L), after
		// Karis) and expands the mean again. A plain mean of HDR samples let a single sun glint,
		// tens of times white, clip every pixel of its circle of confusion: each out-of-focus glint
		// on the sea became a flat white disc. Compressed, a lone glint only brightens its blur a
		// little, while a dense glitter path stays bright.
		const compress = Fn( ( [ c ]: [ THREE.Node<'vec3'> ] ) => c.div( luminance( c ).mul( u.exposure ).add( 1 ) ) )
			.setLayout( { name: 'dofCompress', type: 'vec3', inputs: [ { name: 'c', type: 'vec3' } ] } );
		const gather = Fn( () => {

			const q = uv();
			const centre = cocAt( q ).toVar();
			const c0 = centre.x, s0 = spread( c0 ).toVar();
			const acc = compress( texture( sharp, q ).level( float( 0 ) ).rgb ).toVar(), wsum = float( 1 ).toVar();
			Loop( TAPS, ( { i } ) => {

				const fi = float( i );
				const r = sqrt( fi.add( 0.5 ).div( TAPS ) ).toVar();
				const a = fi.mul( GA );
				const o = vec2( cos( a ), sin( a ) ).mul( r ).mul( u.maxRadius ).mul( u.texel );
				const p = q.add( o.mul( s0 ) ).toVar();
				const tap = cocAt( p ).toVar();
				// Depth order (after Jimenez's scatter-as-gather): a tap in front of this pixel reaches
				// as far as its own blur, a tap behind no further than this pixel's. A sharp figure in
				// front of the blurred sea then keeps to its silhouette instead of spreading a halo
				// over the sea, while a blurred foreground still spills over what lies behind it.
				const reach = spread( select( tap.y.lessThan( centre.y ), tap.x, min( tap.x, c0 ) ) );
				// it counts where that reach covers its distance here, with a pixel-wide edge, under a
				// kernel falling to a third at the rim, so what remains of a highlight's disc has a
				// soft edge rather than a cut-out one
				const w = clamp( reach.sub( r.mul( s0 ) ).mul( u.maxRadius ).add( 1 ), 0, 1 ).mul( r.mul( r ).mul( - 0.7 ).add( 1 ) ).toVar();
				acc.addAssign( compress( texture( sharp, p ).level( float( 0 ) ).rgb ).mul( w ) );
				wsum.addAssign( w );

			} );
			const mean = acc.div( max( wsum, 1e-4 ) ).toVar();
			// the inverse of compress(): the mean's compressed luminance stays below one (the floor
			// caps an expanded mean near a thousand times display white, far past what the grade shows)
			return vec4( mean.div( max( float( 1 ).sub( luminance( mean ).mul( u.exposure ) ), 1e-3 ) ), c0 );

		} )();
		const blur = rtt( gather, null, null, { type: THREE.HalfFloatType, resolutionScale: 0.5 } );
		// Upsample the half-res blur by its four nearest texels, each weighted by how much it would
		// itself show as blur: plain bilinear filtering pulled a sharp figure's colour (a texel whose
		// coc is near zero) a pixel or two out over the blurred sea beside it. Texels that are
		// blurred themselves keep their bilinear weight, so a soft bush in front of a softer sea
		// stays soft at its edge instead of snapping to the half-res grid. The mix factor comes from
		// the full-resolution coc for the same reason.
		const composite = Fn( () => {

			const c = makeCocAt()( uv() ).x.toVar();
			const hp = uv().mul( u.halfRes ).sub( 0.5 ).toVar();
			const base = hp.floor().toVar();
			const f = hp.sub( base ).toVar();
			const acc = vec3( 0 ).toVar(), wsum = float( 0 ).toVar();
			for ( const [ ox, oy ] of [ [ 0, 0 ], [ 1, 0 ], [ 0, 1 ], [ 1, 1 ] ] ) {

				const t = blur.sample( clamp( base.add( vec2( ox, oy ) ), vec2( 0 ), u.halfRes.sub( 1 ) ).add( 0.5 ).div( u.halfRes ) ).level( float( 0 ) ).toVar();
				const bl = ( ox ? f.x : float( 1 ).sub( f.x ) ).mul( oy ? f.y : float( 1 ).sub( f.y ) );
				const w = bl.mul( smoothstep( 0, 0.35, t.a ).add( 1e-3 ) );
				acc.addAssign( t.rgb.mul( w ) );
				wsum.addAssign( w );

			}
			// (the plain bilinear blur keeps the half-res pass in the graph; it only shows where
			// every weight vanished, which they cannot)
			const blurred = select( wsum.greaterThan( 0 ), acc.div( max( wsum, 1e-6 ) ), blur.rgb );
			return mix( sharp.rgb, blurred, smoothstep( 0, 0.35, c ).mul( u.dof ) );

		} );
		const lin = composite();

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
		this.opaqueRT.setSize( w, h );
		this.surfaceRT.setSize( w, h );
		this.u.resolution.value.set( w, h );
		this.u.texel.value.set( 1 / w, 1 / h );
		// the size rtt() gives the half-res blur
		this.u.halfRes.value.set( Math.max( Math.floor( w * 0.5 ), 1 ), Math.max( Math.floor( h * 0.5 ), 1 ) );

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

		// 2. linear depth, and a copy of the opaque colour for the water to refract and reflect
		// (a pass cannot sample the target it draws into)
		r.setRenderTarget( this.depthRT );
		this.depthQuad.render( r );
		r.setRenderTarget( this.opaqueRT );
		this.copyQuad.render( r );

		// 3. The water, then the world-space rain, over the opaque image in the scene's multisampled
		// target. Each sample keeps the opaque surface or the sea, whichever is nearer, so
		// silhouettes against the sea are antialiased like the rest of the image. (Drawn into a
		// target of their own, single-sampled, the water had to decide per pixel between the sea
		// and the opaque colour: edges stepped, and the opaque colour at an edge pixel held the
		// sky the sea was not there to cover, a pale outline round everything over the sea.)
		// Rain does not write depth, so surface focus and overlapping translucent streaks are
		// preserved; its splashes compare the resolved depths themselves.
		const autoClear = r.autoClear;
		r.setRenderTarget( this.sceneRT );
		try {

			r.autoClear = false;
			if ( water ) {

				water.prepare( sun );
				r.render( waterScene, camera );

			}
			r.setRenderTarget( this.surfaceRT );
			this.surfaceQuad.render( r );
			if ( rainScene ) {

				r.setRenderTarget( this.sceneRT );
				r.render( rainScene, camera );

			}

		} finally {

			r.autoClear = autoClear;
			r.setRenderTarget( null );

		}

		// 4. composite, bloom, depth of field, grade
		const [ b, g ] = this.blooms;
		b.node.strength.value = S.bloomStrength; b.node.radius.value = S.bloomRadius; b.node.threshold.value = S.bloomThreshold * SCENE_RADIANCE_SCALE; b.maxLum.value = S.bloomMaxLum * SCENE_RADIANCE_SCALE; b.surfaceMaxLum.value = S.bloomSurfaceMaxLum * SCENE_RADIANCE_SCALE;
		g.node.strength.value = S.glowStrength; g.node.radius.value = S.glowRadius; g.node.threshold.value = S.glowThreshold * SCENE_RADIANCE_SCALE; g.maxLum.value = S.glowMaxLum * SCENE_RADIANCE_SCALE; g.surfaceMaxLum.value = S.glowMaxLum * SCENE_RADIANCE_SCALE;
		u.exposure.value = S.exposure / SCENE_RADIANCE_SCALE; u.saturation.value = S.saturation; u.vibrance.value = S.vibrance; u.contrast.value = S.contrast;
		u.split.value = S.split; u.lift.value.copy( S.lift ); u.vignette.value = S.vignette; u.grain.value = S.grain; u.time.value = time;
		u.dof.value = S.dof; u.range.value = S.dofRange;
		u.maxRadius.value = S.dofMaxRadius * this.height / 900; // blur scales with the image, not the pixel count
		u.focus.value = S.focusDistance > 0 ? S.focusDistance : camera.position.length();
		this.output.render();

	}

}
