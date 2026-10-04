import * as THREE from 'three/webgpu';
import { Fn, texture, uniform, uv, float, vec2, vec4, mix, smoothstep, clamp, min, max, length, dot, exp, select, abs } from 'three/tsl';
import type { OceanFFT } from './OceanFFT.ts';
import type { Shared } from '../shared.ts';

// A world-space foam history: R is coverage, GBA is the last FFT displacement.
// Birth follows incoming, rising waves; coverage then drifts and decays independently of
// the next crest. Keeping that history avoids a noise mask blinking in place at the wall.
export class OceanFoam {

	readonly texture: THREE.TextureNode;
	private renderer: THREE.WebGPURenderer;
	private fft: OceanFFT;
	private targets: THREE.RenderTarget[];
	private previous: THREE.TextureNode;
	private quad: THREE.QuadMesh;
	private dt = uniform( 1 / 30 );
	private seed = uniform( 1 );
	private direction = uniform( new THREE.Vector2() );
	private index = 0;
	private lastTime: number | undefined;
	private spectrumRevision = - 1;

	constructor( renderer: THREE.WebGPURenderer, fft: OceanFFT, shared: Shared, shore: THREE.Texture, islandShore: THREE.Texture, pattern: THREE.Texture ) {

		this.renderer = renderer;
		this.fft = fft;
		this.targets = [ 0, 1 ].map( ( i ) => {

			const target = new THREE.RenderTarget( 768, 768, {
				type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
				depthBuffer: false, generateMipmaps: false,
			} );
			target.texture.name = 'oceanFoam' + i;
			return target;

		} );
		this.previous = texture( this.targets[ 0 ].texture );
		this.texture = texture( this.targets[ 0 ].texture );
		const material = new THREE.NodeMaterial();
		material.fragmentNode = Fn( () => {

			const q = uv();
			const p = q.div( shared.shoreXform.zw ).add( shared.shoreXform.xy );
			const sampleShore = Fn( ( [ at ]: [ THREE.Node<'vec2'> ] ) => texture( shore, at ).level( float( 0 ) ).r )
				.setLayout( { name: 'foamShoreDistance', type: 'float', inputs: [ { name: 'at', type: 'vec2' } ] } );
			const sd = sampleShore( q ).toVar();
			const texel = shared.shoreXform.zw.mul( 0.25 );
			const gradient = vec2(
				sampleShore( q.add( vec2( texel.x, 0 ) ) ).sub( sampleShore( q.sub( vec2( texel.x, 0 ) ) ) ),
				sampleShore( q.add( vec2( 0, texel.y ) ) ).sub( sampleShore( q.sub( vec2( 0, texel.y ) ) ) ),
			);
			const normal = gradient.div( max( length( gradient ), 1e-5 ) ).toVar();
			const damp = mix( float( 0.45 ), float( 1 ), smoothstep( 0, 7, sd ) );
			const displacement = texture( fft.displacementTextures[ 0 ], p.div( fft.sizes[ 0 ] ) ).level( float( 0 ) ).xyz
				.add( texture( fft.displacementTextures[ 1 ], p.div( fft.sizes[ 1 ] ) ).level( float( 0 ) ).xyz )
				.add( texture( fft.displacementTextures[ 2 ], p.div( fft.sizes[ 2 ] ) ).level( float( 0 ) ).xyz ).mul( damp ).toVar();
			const derivatives = texture( fft.derivativeTextures[ 0 ], p.div( fft.sizes[ 0 ] ) ).level( float( 0 ) )
				.add( texture( fft.derivativeTextures[ 1 ], p.div( fft.sizes[ 1 ] ) ).level( float( 0 ) ) )
				.add( texture( fft.derivativeTextures[ 2 ], p.div( fft.sizes[ 2 ] ) ).level( float( 0 ) ) ).mul( damp );
			const old = this.previous.sample( q ).level( float( 0 ) ).toVar();
			const valid = float( 1 ).sub( this.seed );
			const rise = displacement.y.sub( old.b ).div( this.dt ).mul( valid );
			// This FFT uses +omega*t and -i*k choppy coordinate offsets. Their negated time
			// derivative estimates orbital drift toward a travelling crest, rather than the
			// opposite grid warp. A small mean drift carries remnants between wave arrivals.
			const orbital = old.ga.sub( displacement.xz ).div( this.dt ).mul( valid ).mul( 0.45 );
			const flow = orbital.add( this.direction.mul( 0.2 ) ).toVar();
			flow.mulAssign( min( float( 1 ), float( 1.2 ).div( max( length( flow ), 1e-5 ) ) ) );
			const coast = float( 1 ).sub( smoothstep( 0.15, 1.0, sd ) );
			// Project incoming drift along the rock and let the residue wash back into open
			// water. Otherwise a world-space advection field would carry foam through the wall.
			flow.subAssign( normal.mul( min( dot( flow, normal ), 0 ) ).mul( coast ) );
			flow.addAssign( normal.mul( old.r ).mul( coast ).mul( 0.25 ) );
			// Semi-Lagrangian backtracing after Jos Stam, Real-Time Fluid Dynamics for Games
			// (GDC 2003). Original TSL implementation; see CREDITS.md.
			const upstream = q.sub( flow.mul( this.dt ).mul( shared.shoreXform.zw ) );
			const edge = select( upstream.x.greaterThanEqual( 0 ).and( upstream.x.lessThanEqual( 1 ) )
				.and( upstream.y.greaterThanEqual( 0 ) ).and( upstream.y.lessThanEqual( 1 ) ), float( 1 ), float( 0 ) );
			const carried = this.previous.sample( clamp( upstream, vec2( 0 ), vec2( 1 ) ) ).level( float( 0 ) ).r.mul( edge ).mul( valid );
			const incoming = smoothstep( 0.05, 0.6, dot( this.direction, normal ).negate() );
			const rising = smoothstep( 0.015, 0.12, rise );
			const crest = smoothstep( - 0.025, 0.07, displacement.y );
			const band = float( 1 ).sub( smoothstep( 0.10, 0.45, sd ) );
			const islandDistance = texture( islandShore, q ).level( float( 0 ) ).r;
			const island = float( 1 ).sub( smoothstep( 0.4, 0.9, islandDistance ) );
			// Static variation only breaks up births. Once generated, every patch travels in
			// the history texture; no independent animated noise can turn it on or off.
			const grain = texture( pattern, p.mul( 0.7 ) ).level( float( 0 ) ).g;
			const patch = texture( pattern, p.mul( 1.7 ) ).level( float( 0 ) ).g;
			const lace = float( 1 ).sub( smoothstep( 0.045, 0.13, abs( grain.sub( 0.46 ) ) ) );
			const fragments = lace.mul( smoothstep( 0.3, 0.6, patch ) );
			const impact = band.mul( incoming ).mul( rising ).mul( crest.mul( 0.7 ).add( 0.3 ) )
				.mul( mix( float( 0.28 ), float( 1 ), island ) );
			// The diagonal Jacobian is a compression proxy, as in the water shader, rather
			// than a claim to resolve breaking waves with a shallow-water fluid solver.
			const jac = derivatives.z.add( 1 ).mul( derivatives.w.add( 1 ) );
			const breaking = smoothstep( 0.65, 0.42, jac ).mul( 0.25 );
			const source = max( impact, breaking ).mul( fragments ).mul( valid );
			const residual = carried.mul( exp( this.dt.mul( - 0.65 ) ) );
			const birth = float( 1 ).sub( exp( source.mul( this.dt ).mul( - 6 ) ) );
			// A soft mask applied on every step would make shoreline decay depend on FPS.
			// Clear solid interiors here; the water shader owns the single display fade.
			const openWater = select( sd.greaterThan( 0 ), float( 1 ), float( 0 ) );
			const coverage = residual.add( float( 1 ).sub( residual ).mul( birth ) ).mul( openWater );
			return vec4( clamp( coverage, 0, 1 ), displacement );

		} )();
		this.quad = new THREE.QuadMesh( material );

	}

	update( time: number ): void {

		if ( this.lastTime === undefined || time < this.lastTime || time - this.lastTime > 0.25 || this.fft.spectrumRevision !== this.spectrumRevision ) {

			this.spectrumRevision = this.fft.spectrumRevision;
			// Positive IFFT twiddles and +omega*t make the weighted +k modes travel toward
			// -k. Keep the existing ocean phase convention and follow its visible motion.
			const angle = this.fft.params.windDirection * Math.PI / 180;
			this.direction.value.set( - Math.cos( angle ), - Math.sin( angle ) );
			// Fixed pre-roll gives paused captures the same recent wave history every time.
			// Seed displacement first: a difference from an empty target is never a velocity.
			for ( let i = 0; i <= 60; i ++ ) {

				this.fft.update( 0, time - 2 + i / 30 );
				this.step( 1 / 30, i === 0 );

			}
			this.lastTime = time;
			return;

		}
		const elapsed = time - this.lastTime;
		// Half-float displacement differences become noisy at extremely short intervals.
		// Pausing leaves both coverage and its displacement history untouched.
		if ( elapsed < 1 / 120 ) return;
		this.step( elapsed, false );
		this.lastTime = time;

	}

	private step( dt: number, seed: boolean ): void {

		this.dt.value = dt;
		this.seed.value = seed ? 1 : 0;
		this.previous.value = this.targets[ this.index ].texture;
		this.index = 1 - this.index;
		const renderer = this.renderer, previousTarget = renderer.getRenderTarget();
		renderer.setRenderTarget( this.targets[ this.index ] );
		this.quad.render( renderer );
		renderer.setRenderTarget( previousTarget );
		this.texture.value = this.targets[ this.index ].texture;

	}

}
