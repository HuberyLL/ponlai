/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, If, attribute, texture, uniform, varying, vec2, vec3, vec4, float, int, normalize, refract, max, dFdx, dFdy, abs,
	clamp, mix, smoothstep, exp, length, screenCoordinate,
} from 'three/tsl';
import { FFT_SIZE, type OceanFFT } from './OceanFFT.ts';
import type { SeaDetail } from './SeaDetail.ts';
import { waveDamping, type WaveDampingInputs } from './WaveDamping.ts';
import { shared } from '../shared.ts';
import { debugFlags } from '../debug/DebugFlags.ts';
import { compileInto } from '../post/graph/Compile.ts';

// Caustics by rasterised photon splatting (Evan Wallace's "WebGL Water"), as tidewater's Caustics.js
// (4811ba4). A fine grid over one FFT tile is drawn into an offscreen target; each vertex is a point
// on the real wave surface, the sun ray is refracted through the surface normal there and followed
// down to a plane D metres below, and the vertex is placed at that landing point. The fragment
// writes the area ratio (surface patch / its image on the floor) additively, which is the light
// concentration: focusing folds form the bright networks. The grid covers the tile plus a margin
// on every side (the FFT tiles, so the margin is the neighbouring tiles' surface), so light
// refracted in from across the tile's edge lands inside it and the result tiles seamlessly.
//
// Two layers, each with two focal planes (shallow, deep) blended by the real depth at lookup: fine
// networks from the finest cascade (its slopes read one level down, so ripples under about 11 cm,
// which defocus at once, are left out) and broad focusing from the next cascade, whose tile is of
// another size, so the product never repeats. Each needs only its own cascade to tile. Both are
// splatted into one target, each over the whole of it in its own tile's coordinates: the fine
// layer's planes in R and G, the broad layer's in B and A (tidewater's broad layer is a 256²
// target of its own, read at level 1.5: here 512², read at 2.5, the same texel). Materials that
// light under the water already bind 16 textures with one caustic map; a second would not fit.
//
// The lookup (`causticsColorAt`): the light that lands at a floor point entered the water up-sun
// along the refracted sun ray, through the slope of the long waves above (a level sea without
// one); it is blurred with depth (the sun's disk and forward scattering), lands a little apart per
// colour (a slight dispersion), takes the broad layer as mix( 1, broad, 0.6 ), and fades in over
// the first half metre and out with depth, times `strength`. Foam above diffuses the network and
// shades the floor under it. With the pixel's footprint ( dpdx, dpdy of its xz ) the networks are
// filtered over it, anisotropically; without it each lookup takes the depth's blur level alone.
// Inside gusts the rougher water focuses more, in slicks less (SeaDetail, through the wave maps).
//
// The wave maps (tidewater's UnderwaterLighting bake, 4811ba4): what the light under the water needs
// at a point depends on its xz alone (the long waves' height, slope and foam, the mean level, the
// caustics' gust and slick factor), so it is baked once a frame into two maps centred on the camera
// (0.25 m texels over 128 m, 2 m over 1 km, snapped to their texels so they do not crawl) instead of
// every fragment that can be under the water reading the FFT and the shore waves. Beyond the far map:
// a level sea. The long waves are the three coarsest cascades' height and the two coarsest's slope,
// damped as the sea's surface is (WaveDamping.ts), and the rock's reflected wave; none over dry land.
// The maps share the caustics' target, an array of six layers (the caustics in layer 0, the maps'
// A and B in layers 1 to 4, the ground bounce's map in layer 5: lighting/GroundBounce.ts), so the
// materials lit under the water, already at WebGPU's 16 sampled textures, bind no more. They are
// read at level 0 within half a texel of their edges, so neither the repeat wrap nor the mip chain
// (made once a frame after the last layer drawn) reaches them.

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

const ETA = 1 / 1.333;

// the shared target's size
const RES = 512;

// the target's layers: the caustics, then per wave map ( height - sea level, slope x, slope z, foam )
// and ( mean level - sea level, the caustics' gust and slick factor, 0, 1 ), then the ground bounce's
// map (drawn by GroundBounce)
const CAUSTICS_LAYER = 0;
const WAVE_EXTENTS = [ 128, 1024 ];
const wavesLayer = ( level: number ) => 1 + level * 2, levelLayer = ( level: number ) => 2 + level * 2;
const BOUNCE_LAYER = 1 + WAVE_EXTENTS.length * 2;
const LAYERS = BOUNCE_LAYER + 1;
// Above this height over the sea level no water reaches (m): the lookups return a level sea there.
const WAVE_REACH = 2.5;

interface LayerOptions { grid: number; depths: [ number, number ]; channel: 0 | 2; slopeLevel: number; margin: number }

class CausticLayer {

	readonly tile: number;
	readonly channel: 0 | 2;

	constructor( fft: OceanFFT, cascade: number, sunDir: THREE.UniformNode<'vec3', THREE.Vector3>, private target: THREE.RenderTarget,
		scene: THREE.Scene, { grid, depths, channel, slopeLevel, margin }: LayerOptions ) {

		this.tile = fft.sizes[ cascade ];
		this.channel = channel;

		// indexed grid over [-margin, 1 + margin]^2 (in tile units) at the tile's vertex density: each
		// surface vertex is shaded once instead of once per triangle corner
		const g = Math.ceil( grid * ( 1 + 2 * margin ) );
		const pos = new Float32Array( ( g + 1 ) * ( g + 1 ) * 3 );
		for ( let j = 0; j <= g; j ++ ) for ( let i = 0; i <= g; i ++ ) {

			const k = ( j * ( g + 1 ) + i ) * 3;
			pos[ k ] = i / g * ( 1 + 2 * margin ) - margin;
			pos[ k + 1 ] = j / g * ( 1 + 2 * margin ) - margin;

		}

		const idx = new Uint32Array( g * g * 6 );
		for ( let j = 0, n = 0; j < g; j ++ ) for ( let i = 0; i < g; i ++ ) {

			const a = j * ( g + 1 ) + i;
			idx[ n ++ ] = a; idx[ n ++ ] = a + 1; idx[ n ++ ] = a + g + 1;
			idx[ n ++ ] = a + g + 1; idx[ n ++ ] = a + 1; idx[ n ++ ] = a + g + 2;

		}

		const geo = new THREE.BufferGeometry();
		geo.setAttribute( 'position', new THREE.BufferAttribute( pos, 3 ) );
		geo.setIndex( new THREE.BufferAttribute( idx, 1 ) );

		const tile = this.tile;
		depths.forEach( ( D, plane ) => {

			const q0 = attribute<'vec3'>( 'position', 'vec3' ).xy;
			const d = texture( fft.derivatives, q0 ).depth( int( cascade ) ).level( float( slopeLevel ) );
			const s = vec2( d.x.div( max( d.z.add( 1 ), 0.3 ) ), d.y.div( max( d.w.add( 1 ), 0.3 ) ) );
			const n = normalize( vec3( s.x.negate(), 1, s.y.negate() ) );
			const T = refract( sunDir.negate(), n, ETA );
			const T0 = refract( sunDir.negate(), vec3( 0, 1, 0 ), ETA );
			// the flat-surface offset is removed so the pattern stays registered with the entry point
			// (the lookup applies it again with the real depth)
			const off = T.xz.div( max( T.y.negate(), 0.15 ) ).sub( T0.xz.div( max( T0.y.negate(), 0.15 ) ) ).mul( D );
			const p = q0.mul( tile );
			const q = p.add( off );
			const vOld = varying( p ), vNew = varying( q );

			const mat = new THREE.NodeMaterial();
			// texture v runs down the target in WebGPU: row 0 at the top (clip y = +1)
			const uvq = q.div( tile );
			mat.vertexNode = vec4( uvq.x.mul( 2 ).sub( 1 ), float( 1 ).sub( uvq.y.mul( 2 ) ), 0, 1 );
			const ox = dFdx( vOld ), oy = dFdy( vOld ), nx = dFdx( vNew ), ny = dFdy( vNew );
			const ao = abs( ox.x.mul( oy.y ).sub( ox.y.mul( oy.x ) ) );
			const an = abs( nx.x.mul( ny.y ).sub( nx.y.mul( ny.x ) ) );
			// soft limit: a single nearly folded cell must not become a flat white hot spot (the finite
			// sun disk spreads real caustic peaks to a few times the mean anyway)
			const I = ao.div( max( an.add( ao.mul( 1 / 8 ) ), 1e-9 ) );
			const out = [ 0, 0, 0, 0 ].map( ( _, k ) => k === channel + plane ? I : float( 0 ) );
			mat.fragmentNode = vec4( out[ 0 ], out[ 1 ], out[ 2 ], out[ 3 ] );
			mat.blending = THREE.CustomBlending;
			mat.blendEquation = THREE.AddEquation;
			mat.blendSrc = THREE.OneFactor;
			mat.blendDst = THREE.OneFactor;
			mat.blendSrcAlpha = THREE.OneFactor;
			mat.blendDstAlpha = THREE.OneFactor;
			mat.depthTest = false;
			mat.depthWrite = false;
			mat.side = THREE.DoubleSide;
			const mesh = new THREE.Mesh( geo, mat );
			mesh.frustumCulled = false;
			scene.add( mesh );

		} );

	}

	// One lookup of this layer's two planes ( shallow, deep ): at the blur level, or over the
	// pixel's footprint stretched to at least that level's texel.
	fetch( uv: V2, level: F, footprint?: { dx: V2; dy: V2 } ): V2 {

		const t = texture( this.target.texture, uv ).depth( int( CAUSTICS_LAYER ) );
		const planes = ( v: THREE.Node<'vec4'> ) => this.channel === 0 ? v.xy : v.zw;
		if ( ! footprint ) return planes( t.level( level ) );
		const minLength = level.exp2().div( RES );
		const stretch = ( g: V2 ) => g.div( this.tile ).toVar().mul( max( minLength.div( max( length( g.div( this.tile ) ), 1e-9 ) ), 1 ) );
		return planes( t.grad( stretch( footprint.dx ), stretch( footprint.dy ) ) );

	}

}

/** What a caustic lookup knows of the surface above and of the pixel (see the header). */
export interface CausticsOptions {
	slope?: V2; // the long waves' slope above ( dh/dx, dh/dz ): their refraction tilts the light
	foam?: F; // foam or bubble cover above (0..1)
	detail?: F; // the gust and slick factor above (the wave maps' B.y)
	footprint?: { dx: V2; dy: V2 }; // dpdx and dpdy of the point's xz, taken in uniform control flow
}

/** What the wave maps' bake reads (Caustics.attachWaves). */
export interface WaveMapInputs extends WaveDampingInputs {
	shoreWaves: WaveDampingInputs['shoreWaves'];
	detail: SeaDetail;
}

export class Caustics {

	renderer: THREE.WebGPURenderer;
	readonly target: THREE.RenderTarget;
	readonly fine: CausticLayer;
	readonly broad: CausticLayer;
	readonly strength = uniform( 0.75 );
	/** The target's layer that holds the ground bounce's map (lighting/GroundBounce.ts draws it). */
	readonly bounceLayer = BOUNCE_LAYER;
	// a level sea's refracted sun ray: horizontal metres per metre of depth toward the entry point
	readonly shift = uniform( new THREE.Vector2() );
	readonly sunDir = uniform( new THREE.Vector3( 0, 1, 0 ) );

	private scene = new THREE.Scene();
	private camera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );
	// the wave maps: each one's world origin (its texel ( 0, 0 )'s corner) and its bake, once attached
	private readonly origins = WAVE_EXTENTS.map( () => uniform( new THREE.Vector2() ) );
	private readonly wavesReady = uniform( 0 );
	private bakes: { quad: THREE.QuadMesh; layer: number }[] = [];
	private allocated = false;

	constructor( renderer: THREE.WebGPURenderer, fft: OceanFFT ) {

		this.renderer = renderer;
		// The floor is mostly seen at grazing angles: filtered along the view (anisotropic), sharp
		// across it.
		this.target = new THREE.RenderTarget( RES, RES, {
			depth: LAYERS, type: THREE.HalfFloatType, generateMipmaps: true,
			minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
			wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, depthBuffer: false, anisotropy: 8,
		} );
		this.target.texture.name = 'caustics';
		const fine = fft.cascades - 1;
		this.fine = new CausticLayer( fft, fine, this.sunDir, this.target, this.scene, { grid: 256, depths: [ 1.2, 4.0 ], channel: 0, slopeLevel: 1, margin: 0.35 } );
		this.broad = new CausticLayer( fft, fine - 1, this.sunDir, this.target, this.scene, { grid: 128, depths: [ 3.0, 9.0 ], channel: 2, slopeLevel: 0.5, margin: 0.35 } );

	}

	/** Compiles the splats' draws for their target ahead of their first frame: while the key light
	 * gives none (a moonless night) that frame comes only with the dawn. */
	warm(): Promise<void> {

		return compileInto( this.renderer, this.scene, this.camera, this.target );

	}

	/** Bakes the wave maps from now on (the world's fields and the shore waves exist): until then
	 * the lookups read a level sea. */
	attachWaves( inputs: WaveMapInputs ): void {

		const { fft } = inputs;
		WAVE_EXTENTS.forEach( ( extent, level ) => {

			const texel = extent / RES, origin = this.origins[ level ];
			// the world xz at this texel's centre (screen row 0 is texture row 0)
			const xz = screenCoordinate.xy.mul( texel ).add( origin ).toVar();
			const { weights, seaDepth } = waveDamping( inputs, xz );
			const w = [ weights.x, weights.y, weights.z ];
			const at = ( field: THREE.Texture, c: number, lvl: number ) => texture( field, xz.div( fft.sizes[ c ] ) ).depth( int( c ) ).level( float( lvl ) );
			// the cascades read no finer than the bake's texel (and at least two levels down)
			const lvl = ( c: number ) => Math.max( 2, Math.log2( texel * FFT_SIZE / fft.sizes[ c ] ) );
			const waves = new THREE.NodeMaterial();
			waves.fragmentNode = Fn( () => {

				let h: F = float( 0 ), slope: V2 = vec2( 0 );
				for ( let c = 0; c < Math.min( 3, fft.cascades ); c ++ ) {

					h = h.add( at( fft.displacement, c, lvl( c ) ).y.mul( w[ c ] ) );
					if ( c < 2 ) slope = slope.add( at( fft.derivatives, c, lvl( c ) ).xy.mul( w[ c ] ) );

				}
				const shore = inputs.shoreWaves.surfaceAt( xz, shared.time ).toVar();
				// waves only over water: none over dry land (a deep trough there, so nothing above it
				// counts as under the water)
				const height = h.add( shore.x ).mul( smoothstep( 0, 1, seaDepth ) ).sub( smoothstep( 0, - 0.4, seaDepth ).mul( 10 ) );
				// (the rocky shore draws no whitewater: no foam over the floor)
				return vec4( height, slope.add( shore.yz ), 0 );

			} )();
			const mean = new THREE.NodeMaterial();
			mean.fragmentNode = Fn( () => {

				// the mean level from the two longest cascades
				let h: F = float( 0 );
				for ( let c = 0; c < Math.min( 2, fft.cascades ); c ++ ) h = h.add( at( fft.displacement, c, 3 ).y.mul( w[ c ] ) );
				const sea = inputs.detail.sample( xz ).toVar();
				// rougher water in gusts focuses more, slicks less (tidewater's causticsDetailK)
				const detail = mix( float( 0.55 ), float( 1.25 ), sea.y ).mul( float( 1 ).sub( sea.z.mul( 0.6 ) ) );
				return vec4( h.mul( smoothstep( 0, 3, seaDepth ) ), detail, 0, 1 );

			} )();
			this.bakes.push( { quad: new THREE.QuadMesh( waves ), layer: wavesLayer( level ) }, { quad: new THREE.QuadMesh( mean ), layer: levelLayer( level ) } );

		} );

	}

	update( sunDir: THREE.Vector3, camera: THREE.Camera ): void {

		const r = this.renderer;
		this.sunDir.value.copy( sunDir );
		const prev = r.getRenderTarget();
		// One mip chain after the last layer drawn this frame. The first frame asks at every layer: a
		// target's texture takes its mip levels from the flag at its first render.
		const mips = ( last: boolean ) => {

			this.target.texture.generateMipmaps = last || ! this.allocated;

		};
		// The pattern only scales the key light's direct share (Underwater.ts), so while the key gives
		// no light at all (the sun/moon handoff) a redraw cannot change the image. The next frame
		// with light redraws before anything renders. (debugFlags.causticsSkip = false: always.)
		const key = shared.sunColor.value;
		const dark = key.x === 0 && key.y === 0 && key.z === 0 && debugFlags.causticsSkip !== false;
		if ( ! dark ) {

			const prevClear = r.getClearColor( new THREE.Color() ), prevAlpha = r.getClearAlpha();
			r.setClearColor( 0x000000, 0 );
			mips( this.bakes.length === 0 );
			r.setRenderTarget( this.target, CAUSTICS_LAYER );
			r.render( this.scene, this.camera );
			r.setClearColor( prevClear, prevAlpha );

		}
		if ( this.bakes.length > 0 ) {

			// the maps' origins, snapped to whole texels so their texel centres stay put in the world
			WAVE_EXTENTS.forEach( ( extent, level ) => {

				const texel = extent / RES;
				this.origins[ level ].value.set( Math.floor( camera.position.x / texel ) * texel - extent / 2, Math.floor( camera.position.z / texel ) * texel - extent / 2 );

			} );
			this.bakes.forEach( ( { quad, layer }, i ) => {

				mips( i === this.bakes.length - 1 );
				r.setRenderTarget( this.target, layer );
				quad.render( r );

			} );
			this.wavesReady.value = 1;

		}
		r.setRenderTarget( prev );
		this.allocated = true;

		// a level sea's refracted sun ray (pointing down into the water); the entry point lies up-sun
		// refract( -sun, up, eta ): T.xz = -eta sun.xz, T.y = -sqrt( k )
		const k = 1 - ETA * ETA * ( 1 - sunDir.y * sunDir.y );
		const down = Math.max( Math.sqrt( k ), 0.15 );
		this.shift.value.set( ETA * sunDir.x / down, ETA * sunDir.z / down );

	}

	/** The wave maps' A at a world point: ( height of the long waves' surface over the sea level,
	 * their slope x and z, foam over the floor ); a level sea above WAVE_REACH, beyond the far map
	 * and before the first bake. Explicit levels: any branch. */
	wavesAt( P: V3 ): THREE.Node<'vec4'> {

		return this.mapLookup( P, wavesLayer, vec4( 0 ) );

	}

	/** The wave maps' B: ( mean level over the sea level, the caustics' gust and slick factor, 0, 1 ). */
	levelAt( P: V3 ): THREE.Node<'vec4'> {

		return this.mapLookup( P, levelLayer, vec4( 0, 0.9, 0, 1 ) );

	}

	private mapLookup( P: V3, layer: ( level: number ) => number, flat: THREE.Node<'vec4'> ): THREE.Node<'vec4'> {

		return Fn( () => {

			const out = flat.toVar();
			const inside = ( st: V2 ) => st.x.greaterThan( 0.5 ).and( st.y.greaterThan( 0.5 ) ).and( st.x.lessThan( RES - 0.5 ) ).and( st.y.lessThan( RES - 0.5 ) );
			const st = WAVE_EXTENTS.map( ( extent, level ) => P.xz.sub( this.origins[ level ] ).div( extent / RES ).toVar() );
			const read = ( level: number ) => () => {

				out.assign( texture( this.target.texture, st[ level ].div( RES ) ).depth( int( layer( level ) ) ).level( float( 0 ) ) );

			};
			If( this.wavesReady.greaterThan( 0.5 ).and( P.y.lessThan( shared.waterLevel.add( WAVE_REACH ) ) ), () => {

				If( inside( st[ 0 ] ), read( 0 ) ).ElseIf( inside( st[ 1 ] ), read( 1 ) );

			} );
			return out;

		} )();

	}

}

function causticsLight( caustics: Caustics, P: V3, depth: F, mono: boolean, { slope, foam, detail, footprint }: CausticsOptions ): V3 {

	const F = caustics.fine, B = caustics.broad;
	// the light reaching this point entered the water up-sun along the refracted sun ray
	let entry: V2, along: V2;
	if ( slope ) {

		const Ls = refract( caustics.sunDir.negate(), normalize( vec3( slope.x.negate(), 1, slope.y.negate() ) ), ETA ).toVar();
		entry = P.xz.sub( Ls.xz.mul( depth.div( max( Ls.y.negate(), 0.15 ) ) ) );
		along = Ls.xz;

	} else {

		entry = P.xz.add( caustics.shift.mul( depth ) );
		along = caustics.shift.negate();

	}
	entry = entry.toVar();
	// deeper: softer (finite sun disk and forward scattering)
	const blur = clamp( depth.mul( 0.4 ).sub( 0.2 ), 0, 3 ).toVar();
	const wD = clamp( depth.sub( 1.2 ).div( 2.8 ), 0, 1 ).toVar(); // between the two focal planes
	const uvF = entry.div( F.tile ).toVar();
	const plane = ( t: V2 ) => mix( t.x, t.y, wD );
	const g = plane( F.fetch( uvF, blur, footprint ) ).toVar();
	let c: V3 = vec3( g );
	if ( ! mono ) {

		// slight chromatic dispersion: each colour lands a little apart along the sun's direction
		const disp = normalize( along.add( vec2( 1e-4, 0 ) ) ).mul( depth.mul( 0.0035 ) ).div( F.tile ).toVar();
		c = vec3( plane( F.fetch( uvF.add( disp ), blur, footprint ) ), g, plane( F.fetch( uvF.sub( disp ), blur, footprint ) ) );

	}
	const broad = B.fetch( entry.div( B.tile ), float( 2.5 ), footprint );
	const br = mix( broad.x, broad.y, clamp( depth.div( 9 ), 0, 1 ) );
	c = c.mul( mix( float( 1 ), br, 0.6 ) );

	// none right at the surface, strongest in the first metres, fading with depth
	let k: F = smoothstep( 0.03, 0.5, depth ).mul( exp( depth.mul( - 0.06 ) ) ).mul( caustics.strength );
	if ( detail ) k = k.mul( detail );
	if ( foam ) k = k.mul( float( 1 ).sub( clamp( foam, 0, 1 ) ) );
	let result: V3 = mix( vec3( 1 ), c, k );
	// foam and bubble clouds scatter the light back up: the floor under them is shaded
	if ( foam ) result = result.mul( float( 1 ).sub( clamp( foam, 0, 1 ).mul( 0.6 ) ) );
	return result;

}

/** The caustic light factor (per colour, mean about 1) at a world point `depth` metres below the
 * surface. */
export function causticsColorAt( caustics: Caustics, P: V3, depth: F, options: CausticsOptions = {} ): V3 {

	return causticsLight( caustics, P, depth, false, options );

}

/** The same without the dispersion, one value (one fine lookup instead of three). */
export function causticsAt( caustics: Caustics, P: V3, depth: F, options: CausticsOptions = {} ): F {

	return causticsLight( caustics, P, depth, true, options ).y;

}
