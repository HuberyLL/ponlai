/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	attribute, texture, uniform, varying, vec2, vec3, vec4, float, normalize, refract, max, dFdx, dFdy, abs,
	clamp, log2, mix, smoothstep, select,
} from 'three/tsl';
import type { OceanFFT } from './OceanFFT.ts';

// Caustics by rasterised photon splatting (Evan Wallace's "WebGL Water", as in tidewater's
// Caustics.js). A grid over one 16 m wave tile is drawn into an offscreen target; each vertex is a
// point on the real surface (cascades 1 + 2, which tiles 4x inside it), the sun ray is refracted
// through the normal there and followed down to a plane D metres below. The fragment writes the
// area ratio (surface patch / its image on the floor) additively, which is the light
// concentration: focusing folds form the bright networks. The grid covers the tile plus a margin
// so the result tiles seamlessly. Two focal planes: R = shallow, G = deep.

const CAUSTIC_DEPTHS = [ 1.4, 4.2 ];

export class Caustics {

	renderer: THREE.WebGPURenderer;
	tile: number;
	target: THREE.RenderTarget;
	texture: THREE.Texture;
	// flat refracted sun ray: horizontal metres per metre of depth
	shift = uniform( new THREE.Vector2() );

	private sunDir = uniform( new THREE.Vector3( 0, 1, 0 ) );
	private scene = new THREE.Scene();
	private camera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );

	constructor( renderer: THREE.WebGPURenderer, fft: OceanFFT, { res = 512, grid = 256, margin = 0.18 } = {} ) {

		this.renderer = renderer;
		this.tile = fft.sizes[ 1 ];
		this.target = new THREE.RenderTarget( res, res, {
			type: THREE.HalfFloatType, generateMipmaps: true,
			minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
			wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, depthBuffer: false, anisotropy: 8,
		} );
		this.target.texture.name = 'caustics';
		this.texture = this.target.texture;

		// indexed grid over [-margin, 1 + margin]^2 (in tile units)
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
		const d1 = fft.derivativeTextures[ 1 ], d2 = fft.derivativeTextures[ 2 ];
		CAUSTIC_DEPTHS.forEach( ( D, channel ) => {

			const q0 = attribute<'vec3'>( 'position', 'vec3' ).xy;
			const d = texture( d1, q0 ).level( float( 0 ) ).add( texture( d2, q0.mul( 4 ) ).level( float( 0 ) ) );
			const s = vec2( d.x.div( max( d.z.add( 1 ), 0.3 ) ), d.y.div( max( d.w.add( 1 ), 0.3 ) ) );
			const n = normalize( vec3( s.x.negate(), 1, s.y.negate() ) );
			const T = refract( this.sunDir.negate(), n, 1 / 1.333 );
			const T0 = refract( this.sunDir.negate(), vec3( 0, 1, 0 ), 1 / 1.333 );
			// the flat-surface offset is removed so the pattern stays registered with the entry point
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
			// soft limit: a nearly folded cell must not become a flat white hot spot
			const I = ao.div( max( an.add( ao.mul( 0.125 ) ), 1e-12 ) );
			mat.fragmentNode = channel === 0 ? vec4( I, 0, 0, 0 ) : vec4( 0, I, 0, 0 );
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
			this.scene.add( mesh );

		} );

	}

	update( sunDir: THREE.Vector3 ): void {

		const r = this.renderer;
		this.sunDir.value.copy( sunDir );
		const prev = r.getRenderTarget();
		const prevClear = r.getClearColor( new THREE.Color() ), prevAlpha = r.getClearAlpha();
		r.setRenderTarget( this.target );
		r.setClearColor( 0x000000, 0 );
		r.render( this.scene, this.camera );
		r.setRenderTarget( prev );
		r.setClearColor( prevClear, prevAlpha );

		// flat refracted sun ray (pointing down into the water); the entry point lies up-sun
		// refract( -sun, up, eta ): T.xz = -eta sun.xz, T.y = -sqrt( k )
		const eta = 1 / 1.333;
		const k = 1 - eta * eta * ( 1 - sunDir.y * sunDir.y );
		const down = Math.max( Math.sqrt( k ), 0.15 );
		this.shift.value.set( eta * sunDir.x / down, eta * sunDir.z / down );

	}

}

// caustic light factor (mean ~1) at a world point `depth` metres below the surface
export function causticsAt( caustics: Caustics, wp: THREE.Node<'vec3'>, depth: THREE.Node<'float'> ): THREE.Node<'float'> {

	// entry point of the light that lands here
	const e = wp.xz.add( caustics.shift.mul( depth ) );
	const blur = clamp( log2( depth.mul( 0.5 ).add( 1 ) ), 0, 3.5 );
	const c = texture( caustics.texture, e.div( caustics.tile ) ).level( blur ).rg;
	const shallow = mix( float( 1 ), c.r, smoothstep( 0, 0.9, depth ) );
	const v = mix( shallow, c.g, smoothstep( CAUSTIC_DEPTHS[ 0 ], CAUSTIC_DEPTHS[ 1 ], depth ) );
	// very deep: the networks wash out
	return select( depth.greaterThan( 0 ), mix( v, float( 1 ), smoothstep( 7, 16, depth ) ), float( 1 ) );

}
