/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	attribute, texture, uniform, varying, vec2, vec3, vec4, float, int, normalize, refract, max, dFdx, dFdy, abs,
	clamp, mix, smoothstep, exp, length,
} from 'three/tsl';
import type { OceanFFT } from './OceanFFT.ts';
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

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

const ETA = 1 / 1.333;

// the shared target's size
const RES = 512;

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

		const t = texture( this.target.texture, uv );
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
	footprint?: { dx: V2; dy: V2 }; // dpdx and dpdy of the point's xz, taken in uniform control flow
}

export class Caustics {

	renderer: THREE.WebGPURenderer;
	readonly target: THREE.RenderTarget;
	readonly fine: CausticLayer;
	readonly broad: CausticLayer;
	readonly strength = uniform( 0.75 );
	// a level sea's refracted sun ray: horizontal metres per metre of depth toward the entry point
	readonly shift = uniform( new THREE.Vector2() );
	readonly sunDir = uniform( new THREE.Vector3( 0, 1, 0 ) );

	private scene = new THREE.Scene();
	private camera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );

	constructor( renderer: THREE.WebGPURenderer, fft: OceanFFT ) {

		this.renderer = renderer;
		// The floor is mostly seen at grazing angles: filtered along the view (anisotropic), sharp
		// across it.
		this.target = new THREE.RenderTarget( RES, RES, {
			type: THREE.HalfFloatType, generateMipmaps: true,
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

	update( sunDir: THREE.Vector3 ): void {

		const r = this.renderer;
		this.sunDir.value.copy( sunDir );
		// The pattern only scales the key light's direct share (Underwater.ts), so while the key gives
		// no light at all (the sun/moon handoff) a redraw cannot change the image. The next frame
		// with light redraws before anything renders. (debugFlags.causticsSkip = false: always.)
		const key = shared.sunColor.value;
		const dark = key.x === 0 && key.y === 0 && key.z === 0 && debugFlags.causticsSkip !== false;
		if ( ! dark ) {

			const prev = r.getRenderTarget();
			const prevClear = r.getClearColor( new THREE.Color() ), prevAlpha = r.getClearAlpha();
			r.setClearColor( 0x000000, 0 );
			r.setRenderTarget( this.target );
			r.render( this.scene, this.camera );
			r.setRenderTarget( prev );
			r.setClearColor( prevClear, prevAlpha );

		}

		// a level sea's refracted sun ray (pointing down into the water); the entry point lies up-sun
		// refract( -sun, up, eta ): T.xz = -eta sun.xz, T.y = -sqrt( k )
		const k = 1 - ETA * ETA * ( 1 - sunDir.y * sunDir.y );
		const down = Math.max( Math.sqrt( k ), 0.15 );
		this.shift.value.set( ETA * sunDir.x / down, ETA * sunDir.z / down );

	}

}

function causticsLight( caustics: Caustics, P: V3, depth: F, mono: boolean, { slope, foam, footprint }: CausticsOptions ): V3 {

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
