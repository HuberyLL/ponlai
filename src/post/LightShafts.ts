import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, uniform, texture, textureLoad, rtt, uv, ivec2, vec2, vec4, float, min, clamp,
	dot, normalize, acos, exp, select,
} from 'three/tsl';
import type { Sky } from '../sky/Sky.ts';
import { sizeRtt } from './RenderScale.ts';
import type { GraphResources } from './graph/FrameGraph.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

const STEPS = 48;

/** Crepuscular rays (the Tyndall effect in hazy air) and the sun's glare.
 *
 * Light scattered by haze shows the shadows clouds and the island cast through the air as
 * beams converging on the sun. In screen space they are the visible sky around the sun, with
 * cloud and island silhouettes, blurred radially toward the sun's position (after Mitchell,
 * "Volumetric Light Scattering as a Post-Process", GPU Gems 3, 2007). The glare is the eye's
 * and lens's scattering of the bright disk, scaled by how much of it is unobstructed. Both
 * are camera-side effects and leave the sky's radiometry unchanged. */
export class LightShafts {

	readonly strength = uniform( 1 );
	readonly glare = uniform( 1 );
	private readonly sunUV = uniform( new THREE.Vector2( 0.5, 0.5 ) );
	private readonly sunDir = uniform( new THREE.Vector3( 0, 1, 0 ) );
	private readonly color = uniform( new THREE.Color( 0, 0, 0 ) );
	// 1 while the sun is in front of the camera, fading out as it leaves the view.
	private readonly facing = uniform( 0 );
	private readonly haze = uniform( 0 );
	private readonly lowSun = uniform( 0 );
	// The disk's transmittance through fog between the camera and the sky.
	private readonly fogVisibility = uniform( 1 );
	private readonly projectionInverse = uniform( new THREE.Matrix4() );
	private readonly cameraWorld = uniform( new THREE.Matrix4() );
	private readonly clip = new THREE.Vector4();
	// the half-resolution passes, sized with the scene's render
	private readonly passes: THREE.RTTNode[] = [];

	/** Radiance to add to the HDR image, from the resolved depth (the sea's included) and the sky;
	 * the render's size is the frame graph's. */
	build( depth: THREE.Texture, sky: Sky, graph: GraphResources ): V3 {

		const sceneDepth = texture( depth );
		const resolution = graph.extent( { of: 'render' } );
		const direction = ( q: V2 ) => {

			const ndc = vec4( q.x.mul( 2 ).sub( 1 ), float( 1 ).sub( q.y ).mul( 2 ).sub( 1 ), 1, 1 );
			const view = this.projectionInverse.mul( ndc );
			return normalize( this.cameraWorld.mul( vec4( view.xyz.div( view.w ), 0 ) ).xyz );

		};

		// Half resolution: the open sky's brightness near the sun (r) and its plain visibility (g).
		const source = this.pass( rtt( Fn( () => {

			const q = uv().toVar();
			const px = ivec2( clamp( q.mul( resolution ), vec2( 0 ), resolution.sub( 1 ) ) );
			const z = ( textureLoad( sceneDepth, px ) as unknown as F ).toVar();
			const d = direction( q ).toVar();
			const open = float( 0 ).toVar();
			If( z.lessThan( - 9e4 ).and( d.y.greaterThan( 0 ) ), () => {

				open.assign( sky.clouds.sample( d ).a );

			} );
			const angle = acos( clamp( dot( d, this.sunDir ), - 1, 1 ) );
			// Beams carry the bright sky near the sun; a wide term alone would blur into a disc.
			const bright = exp( angle.div( - 0.05 ) ).mul( 1.5 ).add( exp( angle.div( - 0.15 ) ).mul( 0.15 ) );
			return vec4( open.mul( bright ), open, 0, 1 );

		} )(), null, null, { type: THREE.HalfFloatType, resolutionScale: 0.5 } ) );

		const inside = ( p: V2 ) => select( p.x.greaterThanEqual( 0 ).and( p.x.lessThanEqual( 1 ) ).and( p.y.greaterThanEqual( 0 ) ).and( p.y.lessThanEqual( 1 ) ), float( 1 ), float( 0 ) );

		const rays = this.pass( rtt( Fn( () => {

			const result = float( 0 ).toVar();
			If( this.facing.greaterThan( 0.001 ), () => {

				const q = uv().toVar();
				// March toward the sun; the reach covers the sun from anywhere on screen.
				const step = this.sunUV.sub( q ).mul( 0.9 / STEPS ).toVar();
				const p = q.toVar();
				const decay = float( 1 ).toVar();
				Loop( STEPS, () => {

					p.addAssign( step );
					result.addAssign( texture( source, p ).level( float( 0 ) ).r.mul( inside( p ) ).mul( decay ) );
					decay.mulAssign( 0.97 );

				} );
				result.mulAssign( 1 / STEPS );

			} );
			return vec4( result, 0, 0, 1 );

		} )(), null, null, { type: THREE.HalfFloatType, resolutionScale: 0.5 } ) );

		return Fn( () => {

			const q = uv().toVar();
			// The unobstructed fraction of the disk: the sky's visibility at the sun's position.
			const s = this.sunUV;
			const t = vec2( 2 ).div( resolution );
			const visible = texture( source, s ).level( float( 0 ) ).g.add( texture( source, s.add( vec2( t.x, 0 ) ) ).level( float( 0 ) ).g )
				.add( texture( source, s.sub( vec2( t.x, 0 ) ) ).level( float( 0 ) ).g ).add( texture( source, s.add( vec2( 0, t.y ) ) ).level( float( 0 ) ).g )
				.add( texture( source, s.sub( vec2( 0, t.y ) ) ).level( float( 0 ) ).g ).mul( 0.2 ).mul( inside( s ) );
			const angle = acos( clamp( dot( direction( q ), this.sunDir ), - 1, 1 ) );
			const glare = exp( angle.div( - 0.012 ) ).mul( 0.7 ).add( exp( angle.div( - 0.045 ) ).mul( 0.04 ) ).mul( visible ).mul( this.fogVisibility ).mul( this.glare );
			// Beams need haze to scatter in, and a low sun's long path through it; clear air at
			// midday still shows them faintly. Weak enough that a clear sky only gains a glow.
			const air = min( this.haze.mul( 600 ).add( 0.5 ), 2 ).mul( this.lowSun.mul( 4 ).add( 1 ) );
			const beams = texture( rays, q ).level( float( 0 ) ).r.mul( air ).mul( this.strength ).mul( 0.14 );
			return this.color.rgb.mul( glare.add( beams ) ).mul( this.facing );

		} )();

	}

	private pass( node: THREE.RTTNode ): THREE.RTTNode {

		this.passes.push( node );
		return node;

	}

	/** The size of the scene's render (the canvas may be larger while the frame is upscaled). */
	setSize( width: number, height: number ): void {

		for ( const node of this.passes ) sizeRtt( node, width, height );

	}

	/** The sun's direction and its direct irradiance. The moon is far too faint for either
	 * effect; its own haze glow is part of the night sky. */
	get sunDirection(): THREE.Vector3 { return this.sunDir.value; }

	setSun( direction: THREE.Vector3, color: THREE.Color ): void {

		this.sunDir.value.copy( direction );
		this.color.value.copy( color );

	}

	update( camera: THREE.PerspectiveCamera, haze: number, fogVisibility = 1 ): void {

		const key = this.sunDir.value;
		this.projectionInverse.value.copy( camera.projectionMatrixInverse );
		this.cameraWorld.value.copy( camera.matrixWorld );
		this.haze.value = haze;
		this.fogVisibility.value = fogVisibility;
		this.lowSun.value = 1 - THREE.MathUtils.smoothstep( key.y, 0.05, 0.35 );
		const c = this.clip.set( key.x, key.y, key.z, 0 ).applyMatrix4( camera.matrixWorldInverse ).applyMatrix4( camera.projectionMatrix );
		const forward = c.w > 1e-6;
		const x = forward ? c.x / c.w : 0, y = forward ? c.y / c.w : 0;
		this.sunUV.value.set( x * 0.5 + 0.5, 0.5 - y * 0.5 );
		// Fade as the sun leaves the view, and as it sets.
		const offscreen = Math.max( Math.abs( x ), Math.abs( y ) );
		this.facing.value = forward ? ( 1 - THREE.MathUtils.smoothstep( offscreen, 1.2, 2.2 ) ) * THREE.MathUtils.smoothstep( key.y, - 0.02, 0.02 ) : 0;

	}

}
