import * as THREE from 'three/webgpu';
import { Fn, texture, uniform, uv, float, vec2, vec4, mix, smoothstep, clamp, min, max, length, dot, exp, select } from 'three/tsl';
import type { OceanFFT } from './OceanFFT.ts';
import type { Shared } from '../shared.ts';

// Low-frequency wave events, not the final foam pattern: R is activity, G is activity times
// age, B is the previous shoreline wave height, A is a crest latch. Water reconstructs crisp
// filaments at full resolution; repeatedly filtering those filaments would erase their holes.
export class OceanFoam {

	readonly texture: THREE.TextureNode;
	readonly direction = uniform( new THREE.Vector2() );
	private renderer: THREE.WebGPURenderer;
	private fft: OceanFFT;
	private targets: THREE.RenderTarget[];
	private previous: THREE.TextureNode;
	private quad: THREE.QuadMesh;
	private dt = uniform( 1 / 30 );
	private seed = uniform( 1 );
	private index = 0;
	private lastTime: number | undefined;
	private spectrumRevision = - 1;

	constructor( renderer: THREE.WebGPURenderer, fft: OceanFFT, shared: Shared, shore: THREE.Texture, islandShore: THREE.Texture, pattern: THREE.Texture ) {

		this.renderer = renderer;
		this.fft = fft;
		this.targets = [ 0, 1 ].map( ( i ) => {

			const target = new THREE.RenderTarget( 512, 512, {
				type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
				depthBuffer: false, generateMipmaps: false,
			} );
			target.texture.name = 'oceanFoamEvent' + i;
			return target;

		} );
		this.previous = texture( this.targets[ 0 ].texture );
		this.texture = texture( this.targets[ 0 ].texture );
		const material = new THREE.NodeMaterial();
		material.fragmentNode = Fn( () => {

			const q = uv();
			const p = q.div( shared.shoreXform.zw ).add( shared.shoreXform.xy );
			const sampleShore = Fn( ( [ at ]: [ THREE.Node<'vec2'> ] ) => texture( shore, at ).level( float( 0 ) ).r )
				.setLayout( { name: 'foamEventShoreDistance', type: 'float', inputs: [ { name: 'at', type: 'vec2' } ] } );
			const sd = sampleShore( q ).toVar();
			const texel = shared.shoreXform.zw.mul( 0.3 );
			const gradient = vec2(
				sampleShore( q.add( vec2( texel.x, 0 ) ) ).sub( sampleShore( q.sub( vec2( texel.x, 0 ) ) ) ),
				sampleShore( q.add( vec2( 0, texel.y ) ) ).sub( sampleShore( q.sub( vec2( 0, texel.y ) ) ) ),
			);
			const normal = gradient.div( max( length( gradient ), 1e-5 ) ).toVar();
			// Sample the same point at the cliff foot across the wash width. Otherwise the
			// seaward edge gets a different age and the reconstructed front folds on itself.
			const foot = p.sub( normal.mul( sd.sub( 0.25 ) ) );
			const height = texture( fft.displacementTextures[ 0 ], foot.div( fft.sizes[ 0 ] ) ).level( float( 0 ) ).y
				.add( texture( fft.displacementTextures[ 1 ], foot.div( fft.sizes[ 1 ] ) ).level( float( 0 ) ).y ).mul( 0.47 ).toVar();
			const old = this.previous.sample( q ).level( float( 0 ) ).toVar();
			const valid = float( 1 ).sub( this.seed );
			const rise = height.sub( old.b ).div( this.dt ).mul( valid );
			// Hysteresis creates one event as a wave rises into the wall, rather than pumping
			// fresh foam every frame or following unrelated high-frequency capillary ripples.
			const latch = select( height.lessThan( - 0.008 ), float( 0 ),
				select( height.greaterThan( 0.014 ).and( rise.greaterThan( 0.012 ) ), float( 1 ), old.a ) ).mul( valid );
			const arrival = max( latch.sub( old.a ), 0 ).mul( valid );
			const coast = float( 1 ).sub( smoothstep( 0.2, 1.8, sd ) );
			const flow = this.direction.mul( 0.2 ).toVar();
			flow.subAssign( normal.mul( min( dot( flow, normal ), 0 ) ).mul( coast ) );
			flow.addAssign( normal.mul( old.r ).mul( coast ).mul( 0.25 ) );
			// Semi-Lagrangian backtracing after Jos Stam, Real-Time Fluid Dynamics for Games
			// (GDC 2003). Original TSL implementation; see CREDITS.md.
			const upstream = q.sub( flow.mul( this.dt ).mul( shared.shoreXform.zw ) );
			const edge = select( upstream.x.greaterThanEqual( 0 ).and( upstream.x.lessThanEqual( 1 ) )
				.and( upstream.y.greaterThanEqual( 0 ) ).and( upstream.y.lessThanEqual( 1 ) ), float( 1 ), float( 0 ) );
			const carried = this.previous.sample( clamp( upstream, vec2( 0 ), vec2( 1 ) ) ).level( float( 0 ) ).rg.mul( edge ).mul( valid );
			const decay = exp( this.dt.mul( - 0.72 ) );
			const activity = carried.r.mul( decay );
			const moment = carried.g.add( carried.r.mul( this.dt ) ).mul( decay );
			// Sheltered-side activity must survive until its detached arc develops.
			const incoming = mix( float( 0.55 ), float( 1 ), smoothstep( 0.05, 0.6, dot( this.direction, normal ).negate() ) );
			const band = float( 1 ).sub( smoothstep( 1.1, 1.8, sd ) );
			const island = float( 1 ).sub( smoothstep( 0.4, 0.9, texture( islandShore, q ).level( float( 0 ) ).r ) );
			const patch = texture( pattern, foot.mul( 0.055 ) ).level( float( 0 ) ).r;
			const strength = band.mul( incoming ).mul( mix( float( 0.65 ), float( 1 ), island ) )
				.mul( mix( float( 0.6 ), float( 0.95 ), smoothstep( 0.35, 0.58, patch ) ) );
			// Let a visible event finish. Resetting its age on every new crest would snap its
			// detached front back to the wall and turn changing noise into fake motion again.
			const age = moment.div( max( activity, 1e-5 ) );
			const birth = arrival.mul( select( activity.lessThan( 0.025 ).or( age.greaterThan( 3.2 ) ), float( 1 ), float( 0 ) ) ).mul( strength );
			const newborn = birth.greaterThan( 0.025 );
			const openWater = select( sd.greaterThan( 0 ), float( 1 ), float( 0 ) );
			return vec4( select( newborn, birth, activity ).mul( openWater ),
				select( newborn, float( 0 ), moment ).mul( openWater ), height, latch );

		} )();
		this.quad = new THREE.QuadMesh( material );

	}

	update( time: number ): void {

		if ( this.lastTime === undefined || time < this.lastTime || time - this.lastTime > 0.25 || this.fft.spectrumRevision !== this.spectrumRevision ) {

			this.spectrumRevision = this.fft.spectrumRevision;
			// The existing FFT's +omega*t convention makes its dominant waves travel -wind.
			const angle = this.fft.params.windDirection * Math.PI / 180;
			this.direction.value.set( - Math.cos( angle ), - Math.sin( angle ) );
			// The fixed history also makes paused, time-stamped captures reproducible.
			for ( let i = 0; i <= 120; i ++ ) {

				this.fft.update( 0, time - 4 + i / 30 );
				this.step( 1 / 30, i === 0 );

			}
			this.lastTime = time;
			return;

		}
		const elapsed = time - this.lastTime;
		// Only the broad event envelope needs an update; fine filaments remain in Water.
		if ( elapsed < 1 / 30 - 1e-6 ) return;
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
