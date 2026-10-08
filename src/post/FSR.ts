/*!
 * Adapted from three.js's FSR1Node (examples/jsm/tsl/display/FSR1Node.js), a port of AMD FidelityFX
 * Super Resolution 1 (ffx_fsr1.h: EASU and RCAS).
 * Copyright (c) 2021 Advanced Micro Devices, Inc.; Copyright © 2010-2026 three.js authors
 * Licensed under the MIT License; see ./fsr.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, float, vec2, vec3, vec4, ivec2, uv, abs, max, min, clamp, saturate, sqrt, select, exp2, texture, textureLoad,
	screenCoordinate, uniform,
} from 'three/tsl';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

// FSR 1 for the frame graph's upscale, split differently from three's FSR1Node: EASU (edge-adaptive
// upsampling) runs as its own pass into a canvas-sized target, and RCAS (contrast-adaptive
// sharpening) is a function the canvas pass calls before it adds the grain, so the canvas no longer
// takes a second full-size pass and target between the two. EASU fetches its 12-texel cross as four
// 2x2 gathers per channel where the input is filterable (AMD's own layout), and with single texel
// loads otherwise; either way the taps and the maths are three's, and only the alpha channel,
// which the frame never uses, is dropped.
export class FSR {

	/** The upscaled image, before sharpening. */
	readonly easuRT = new THREE.RenderTarget( 1, 1, { depthBuffer: false, type: THREE.HalfFloatType } );
	private readonly quad: THREE.QuadMesh;
	private readonly inputSize = uniform( new THREE.Vector2( 1, 1 ) );
	private readonly outputSize = uniform( new THREE.Vector2( 1, 1 ) );

	/** `input` holds display values at the render's size; `gather` reads it with textureGather
	 * (it must then be filterable). */
	constructor( input: THREE.Texture, gather: boolean ) {

		this.easuRT.texture.name = 'FSR.easu';
		const material = new THREE.NodeMaterial();
		material.name = 'FSR.EASU';
		material.fragmentNode = this.easu( input, gather );
		this.quad = new THREE.QuadMesh( material );
		this.quad.name = 'FSR.EASU';

	}

	/** The canvas's size, and the render's (the input's). */
	setSize( width: number, height: number, inputWidth: number, inputHeight: number ): void {

		this.easuRT.setSize( width, height );
		this.inputSize.value.set( inputWidth, inputHeight );
		this.outputSize.value.set( width, height );

	}

	/** Runs EASU into `easuRT`. */
	render( renderer: THREE.WebGPURenderer ): void {

		const target = renderer.getRenderTarget();
		renderer.setRenderTarget( this.easuRT );
		this.quad.render( renderer );
		renderer.setRenderTarget( target );

	}

	/** Compiles EASU ahead of its first frame (see `AerialPerspective.warm`). */
	async warm( renderer: THREE.WebGPURenderer ): Promise<void> {

		const target = renderer.getRenderTarget();
		renderer.setRenderTarget( this.easuRT );
		const compile = renderer.compileAsync( this.quad, ( this.quad as unknown as { camera: THREE.Camera } ).camera );
		renderer.setRenderTarget( target );
		await compile;

	}

	private easu( input: THREE.Texture, gather: boolean ): V4 {

		// Accumulates edge direction and length for one bilinear quadrant.
		const accumulateEdge = ( dir: THREE.Node<'vec2'>, len: F, w: F, aL: F, bL: F, cL: F, dL: F, eL: F ) => {

			const dc = dL.sub( cL ).toConst();
			const cb = cL.sub( bL ).toConst();
			const dirX = dL.sub( bL ).toConst();
			const lenX = max( abs( dc ), abs( cb ) ).toConst();
			const sLenX = saturate( abs( dirX ).div( max( lenX, float( 1.0 / 65536.0 ) ) ) ).toConst();
			dir.x.addAssign( dirX.mul( w ) );
			len.addAssign( sLenX.mul( sLenX ).mul( w ) );
			const ec = eL.sub( cL ).toConst();
			const ca = cL.sub( aL ).toConst();
			const dirY = eL.sub( aL ).toConst();
			const lenY = max( abs( ec ), abs( ca ) ).toConst();
			const sLenY = saturate( abs( dirY ).div( max( lenY, float( 1.0 / 65536.0 ) ) ) ).toConst();
			dir.y.addAssign( dirY.mul( w ) );
			len.addAssign( sLenY.mul( sLenY ).mul( w ) );

		};

		// An approximate Lanczos2 tap weight, accumulated.
		const accumulateTap = ( aC: V3, aW: F, offset: V2, dir: V2, len2: V2, lob: F, clp: F, color: V3 ) => {

			const vx = offset.x.mul( dir.x ).add( offset.y.mul( dir.y ) ).toConst();
			const vy = offset.x.mul( dir.y ).negate().add( offset.y.mul( dir.x ) ).toConst();
			const sx = vx.mul( len2.x ).toConst();
			const sy = vy.mul( len2.y ).toConst();
			const d2 = min( sx.mul( sx ).add( sy.mul( sy ) ), clp ).toConst();
			const wB = d2.mul( 2.0 / 5.0 ).sub( 1.0 ).toConst();
			const wA = d2.mul( lob ).sub( 1.0 ).toConst();
			const w = wB.mul( wB ).mul( 25.0 / 16.0 ).sub( 25.0 / 16.0 - 1.0 ).mul( wA.mul( wA ) ).toConst();
			aC.addAssign( color.mul( w ) );
			aW.addAssign( w );

		};

		return Fn( () => {

			const pp = uv().mul( this.inputSize ).sub( 0.5 ).toConst();
			const fp = pp.floor().toConst();
			const f = pp.sub( fp ).toConst();

			// The 12-texel cross:
			//       b c
			//     e f g h
			//     i j k l
			//       n o
			let sB: V3, sC: V3, sE: V3, sF: V3, sG: V3, sH: V3, sI: V3, sJ: V3, sK: V3, sL: V3, sN: V3, sO: V3;
			if ( gather ) {

				// Four 2x2 quads: { b c f g }, { e f i j }, { g h k l }, { j k n o }, each gathered at
				// the corner its four texels share. A gather returns ( lower left, lower right, upper
				// right, upper left ), with v growing downward: x ( 0, 1 ), y ( 1, 1 ), z ( 1, 0 ), w ( 0, 0 ).
				const t = texture( input );
				const quad = ( cx: number, cy: number ) => {

					const at = fp.add( vec2( cx, cy ) ).div( this.inputSize ).toConst();
					const r = t.sample( at ).gather( 0 ).toConst() as unknown as V4;
					const g = t.sample( at ).gather( 1 ).toConst() as unknown as V4;
					const b = t.sample( at ).gather( 2 ).toConst() as unknown as V4;
					return {
						tl: vec3( r.w, g.w, b.w ), tr: vec3( r.z, g.z, b.z ),
						bl: vec3( r.x, g.x, b.x ), br: vec3( r.y, g.y, b.y ),
					};

				};
				const q0 = quad( 1, 0 ), q1 = quad( 0, 1 ), q2 = quad( 2, 1 ), q3 = quad( 1, 2 );
				sB = q0.tl; sC = q0.tr; sF = q0.bl; sG = q0.br;
				sE = q1.tl; sI = q1.bl; sJ = q1.br;
				sH = q2.tr; sK = q2.bl; sL = q2.br;
				sN = q3.bl; sO = q3.br;

			} else {

				// (clamped at the border, as the backend's robust loads would)
				const last = this.inputSize.sub( 1 ).toConst();
				const tap = ( dx: number, dy: number ) => ( textureLoad( input, ivec2( clamp( fp.add( vec2( dx, dy ) ), vec2( 0 ), last ) ) ) as unknown as V4 ).rgb;
				sB = tap( 0, - 1 ); sC = tap( 1, - 1 );
				sE = tap( - 1, 0 ); sF = tap( 0, 0 ); sG = tap( 1, 0 ); sH = tap( 2, 0 );
				sI = tap( - 1, 1 ); sJ = tap( 0, 1 ); sK = tap( 1, 1 ); sL = tap( 2, 1 );
				sN = tap( 0, 2 ); sO = tap( 1, 2 );

			}

			// approximate luminance for the edge detection
			const luma = ( s: V3 ) => s.r.mul( 0.5 ).add( s.g ).add( s.b.mul( 0.5 ) );
			const bL = luma( sB ), cL = luma( sC );
			const eL = luma( sE ), fL = luma( sF ), gL = luma( sG ), hL = luma( sH );
			const iL = luma( sI ), jL = luma( sJ ), kL = luma( sK ), lL = luma( sL );
			const nL = luma( sN ), oL = luma( sO );

			// edge direction and length from the four bilinear quadrants
			const dir = vec2( 0 ).toVar();
			const len = float( 0 ).toVar();
			const w0 = float( 1 ).sub( f.x ).mul( float( 1 ).sub( f.y ) ).toConst();
			const w1 = f.x.mul( float( 1 ).sub( f.y ) ).toConst();
			const w2 = float( 1 ).sub( f.x ).mul( f.y ).toConst();
			const w3 = f.x.mul( f.y ).toConst();
			accumulateEdge( dir, len, w0, bL, eL, fL, gL, jL );
			accumulateEdge( dir, len, w1, cL, fL, gL, hL, kL );
			accumulateEdge( dir, len, w2, fL, iL, jL, kL, nL );
			accumulateEdge( dir, len, w3, gL, jL, kL, lL, oL );

			// the direction normalised, ( 1, 0 ) where the gradient is negligible
			const dirSq = dir.x.mul( dir.x ).add( dir.y.mul( dir.y ) ).toConst();
			const zro = dirSq.lessThan( 1.0 / 32768.0 ).toConst();
			const rDirLen = float( 1.0 ).div( sqrt( max( dirSq, float( 1.0 / 32768.0 ) ) ) ).toConst();
			dir.x.assign( select( zro, float( 1.0 ), dir.x ) );
			dir.mulAssign( select( zro, float( 1.0 ), rDirLen ) );

			// the kernel shaped by the edge's strength: stretched along it ( 1 for axis-aligned
			// edges, sqrt 2 on diagonals ), shrunk across it
			len.assign( len.mul( 0.5 ) );
			len.mulAssign( len );
			const stretch = dir.x.mul( dir.x ).add( dir.y.mul( dir.y ) ).div( max( abs( dir.x ), abs( dir.y ) ) ).toConst();
			const len2 = vec2( float( 1.0 ).add( stretch.sub( 1.0 ).mul( len ) ), float( 1.0 ).sub( len.mul( 0.5 ) ) ).toConst();
			// the negative lobe: strong on flat areas ( 0.5 ), reduced on edges ( 0.21 )
			const lob = float( 0.5 ).add( float( 1.0 / 4.0 - 0.04 - 0.5 ).mul( len ) ).toConst();
			const clp = float( 1.0 ).div( lob ).toConst();

			const aC = vec3( 0 ).toVar();
			const aW = float( 0 ).toVar();
			accumulateTap( aC, aW, vec2( 0, - 1 ).sub( f ), dir, len2, lob, clp, sB );
			accumulateTap( aC, aW, vec2( 1, - 1 ).sub( f ), dir, len2, lob, clp, sC );
			accumulateTap( aC, aW, vec2( - 1, 0 ).sub( f ), dir, len2, lob, clp, sE );
			accumulateTap( aC, aW, vec2( 0, 0 ).sub( f ), dir, len2, lob, clp, sF );
			accumulateTap( aC, aW, vec2( 1, 0 ).sub( f ), dir, len2, lob, clp, sG );
			accumulateTap( aC, aW, vec2( 2, 0 ).sub( f ), dir, len2, lob, clp, sH );
			accumulateTap( aC, aW, vec2( - 1, 1 ).sub( f ), dir, len2, lob, clp, sI );
			accumulateTap( aC, aW, vec2( 0, 1 ).sub( f ), dir, len2, lob, clp, sJ );
			accumulateTap( aC, aW, vec2( 1, 1 ).sub( f ), dir, len2, lob, clp, sK );
			accumulateTap( aC, aW, vec2( 2, 1 ).sub( f ), dir, len2, lob, clp, sL );
			accumulateTap( aC, aW, vec2( 0, 2 ).sub( f ), dir, len2, lob, clp, sN );
			accumulateTap( aC, aW, vec2( 1, 2 ).sub( f ), dir, len2, lob, clp, sO );
			aC.divAssign( aW );

			// anti-ringing: clamped to the four nearest texels' range
			const min4 = min( min( sF, sG ), min( sJ, sK ) ).toConst();
			const max4 = max( max( sF, sG ), max( sJ, sK ) ).toConst();
			return vec4( clamp( aC, min4, max4 ), 1 );

		} )();

	}

	/** RCAS on `easuRT` at the canvas pixel being drawn. `sharpness` in stops: 0 the strongest, 2
	 * none (three's fsr1() leaves its noise attenuation off, and so does this). */
	rcas( sharpness: F ): V3 {

		const easu = this.easuRT.texture;
		return Fn( () => {

			// (the cross clamped at the frame's edge, as EASU's taps are)
			const p = screenCoordinate.xy.floor().toConst();
			const last = this.outputSize.sub( 1 ).toConst();
			const tap = ( dx: number, dy: number ) => textureLoad( easu, ivec2( clamp( p.add( vec2( dx, dy ) ), vec2( 0 ), last ) ) ) as unknown as V4;
			const e = tap( 0, 0 );
			const b = tap( 0, - 1 );
			const d = tap( - 1, 0 );
			const f = tap( 1, 0 );
			const h = tap( 0, 1 );
			const con = exp2( sharpness.negate() ).toConst();
			// the ring's minimum and maximum, and the lobe weight the local contrast can take
			const mn4 = min( min( b.rgb, d.rgb ), min( f.rgb, h.rgb ) ).toConst();
			const mx4 = max( max( b.rgb, d.rgb ), max( f.rgb, h.rgb ) ).toConst();
			const RCAS_LIMIT = float( 0.25 - 1.0 / 16.0 ).toConst();
			const hitMin = min( mn4, e.rgb ).div( mx4.mul( 4.0 ) ).toConst();
			const hitMax = vec3( 1.0 ).sub( max( mx4, e.rgb ) ).div( mn4.mul( 4.0 ).sub( 4.0 ) ).toConst();
			const lobeRGB = max( hitMin.negate(), hitMax ).toConst();
			const lobe = max( RCAS_LIMIT.negate(), min( max( lobeRGB.r, max( lobeRGB.g, lobeRGB.b ) ), float( 0.0 ) ) ).mul( con ).toConst();
			// the cross and the centre, blended
			return b.rgb.add( d.rgb ).add( f.rgb ).add( h.rgb ).mul( lobe ).add( e.rgb ).div( lobe.mul( 4.0 ).add( 1.0 ) );

		} )() as V3;

	}

	dispose(): void {

		this.easuRT.dispose();
		( this.quad.material as THREE.Material ).dispose();

	}

}
