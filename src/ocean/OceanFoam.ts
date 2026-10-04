import * as THREE from 'three/webgpu';
import { Fn, texture, uniform, uv, float, vec2, vec4, clamp, mix, max, exp, select } from 'three/tsl';
import type { OceanFFT } from './OceanFFT.ts';
import type { ShoreWaves } from './ShoreWaves.ts';
import type { Shared } from '../shared.ts';

// Broad whitewater history: R coverage, GB transported material-coordinate offsets (m),
// A fresh aerated whitewater. Coverage opens holes as it thins; the lace rides its parcels.
export class OceanFoam {

	readonly texture: THREE.TextureNode;
	readonly direction: THREE.Node<'vec2'>;
	private renderer: THREE.WebGPURenderer;
	private fft: OceanFFT;
	private waves: ShoreWaves;
	private targets: THREE.RenderTarget[];
	private previous: THREE.TextureNode;
	private quad: THREE.QuadMesh;
	private dt = uniform( 1 / 30 );
	private seed = uniform( 1 );
	private index = 0;
	private lastTime: number | undefined;
	private spectrumRevision = - 1;
	private waveRevision = - 1;

	constructor( renderer: THREE.WebGPURenderer, fft: OceanFFT, shared: Shared, shore: THREE.Texture, waves: ShoreWaves ) {

		this.renderer = renderer;
		this.fft = fft;
		this.waves = waves;
		this.direction = waves.direction;
		this.targets = [ 0, 1 ].map( ( i ) => {

			const target = new THREE.RenderTarget( 512, 512, {
				type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
				depthBuffer: false, generateMipmaps: false,
			} );
			target.texture.name = 'oceanFoamHistory' + i;
			return target;

		} );
		this.previous = texture( this.targets[ 0 ].texture );
		this.texture = texture( this.targets[ 0 ].texture );
		const material = new THREE.NodeMaterial();
		material.fragmentNode = Fn( () => {

			const q = uv();
			const sampleShore = Fn( ( [ at ]: [ THREE.Node<'vec2'> ] ) => texture( shore, at ).level( float( 0 ) ).r )
				.setLayout( { name: 'foamShoreDistance', type: 'float', inputs: [ { name: 'at', type: 'vec2' } ] } );
			const sd = sampleShore( q ).toVar();
			const wave = waves.motion.sample( q ).level( float( 0 ) ).toVar();
			const flow = wave.xy;
			const valid = float( 1 ).sub( this.seed );
			// The same incoming FFT spectrum and rocky response supply orbital parcel velocity.
			// Keep the density loss caused by its expansion: transported foam tears into holes.
			const e = shared.shoreXform.zw.mul( 0.25 );
			const vx0 = waves.motion.sample( q.sub( vec2( e.x, 0 ) ) ).level( float( 0 ) ).x;
			const vx1 = waves.motion.sample( q.add( vec2( e.x, 0 ) ) ).level( float( 0 ) ).x;
			const vz0 = waves.motion.sample( q.sub( vec2( 0, e.y ) ) ).level( float( 0 ) ).y;
			const vz1 = waves.motion.sample( q.add( vec2( 0, e.y ) ) ).level( float( 0 ) ).y;
			const expansion = max( vx1.sub( vx0 ).add( vz1.sub( vz0 ) ).div( 0.5 ), 0 );
			// Semi-Lagrangian backtracing after Jos Stam (GDC 2003); see CREDITS.md.
			const upstream = q.sub( flow.mul( this.dt ).mul( shared.shoreXform.zw ) );
			const edge = select( upstream.x.greaterThanEqual( 0 ).and( upstream.x.lessThanEqual( 1 ) )
				.and( upstream.y.greaterThanEqual( 0 ) ).and( upstream.y.lessThanEqual( 1 ) ), float( 1 ), float( 0 ) );
			const carried = this.previous.sample( clamp( upstream, vec2( 0 ), vec2( 1 ) ) ).level( float( 0 ) ).mul( edge ).mul( valid );
			// Stop traces that cross land, including thin rock shoulders between water parcels.
			const segmentWater = select( sampleShore( upstream ).greaterThan( 0 )
				.and( sampleShore( mix( q, upstream, float( 0.5 ) ) ).greaterThan( 0 ) ), float( 1 ), float( 0 ) );
			const remaining = carried.r.mul( segmentWater ).mul( exp( expansion.add( 0.65 ).mul( this.dt ).negate() ) );
			// No white line on an unbroken offshore crest. The wave's actual rock contact
			// supplies aerated mass; its dense core survives briefly after the impact ends.
			const birth = float( 1 ).sub( exp( wave.z.mul( this.dt ).mul( - 4.8 ) ) );
			const newMass = float( 1 ).sub( remaining ).mul( birth );
			const coverage = remaining.add( newMass );
			const freshOld = carried.a.mul( segmentWater ).mul( exp( this.dt.mul( - 3.4 ) ) );
			const fresh = freshOld.add( float( 1 ).sub( freshOld ).mul( birth ) );
			const openWater = select( sd.greaterThan( 0 ), float( 1 ), float( 0 ) );
			const offset = select( carried.r.greaterThan( 0.001 ), carried.gb.sub( flow.mul( this.dt ) ), vec2( 0 ) );
			// New foam joins a fresh parcel gradually instead of snapping a visible old pattern.
			const tracer = mix( offset, vec2( 0 ), newMass.div( max( coverage, 1e-5 ) ) ).mul( openWater );
			return vec4( coverage.mul( openWater ), tracer.x, tracer.y, fresh.min( coverage ).mul( openWater ) );

		} )();
		this.quad = new THREE.QuadMesh( material );

	}

	update( time: number ): void {

		this.waves.update( this.fft );
		if ( this.lastTime === undefined || time < this.lastTime || time - this.lastTime > 0.25 || this.fft.spectrumRevision !== this.spectrumRevision || this.waves.fieldRevision !== this.waveRevision ) {

			this.spectrumRevision = this.fft.spectrumRevision;
			this.waveRevision = this.waves.fieldRevision;
			// Warm both histories from the same fixed clock for reproducible paused captures.
			for ( let i = 0; i <= 120; i ++ ) {

				const sampleTime = time - 4 + i / 30;
				this.fft.update( 0, sampleTime );
				this.waves.update( this.fft, sampleTime );
				this.step( 1 / 30, i === 0 );

			}
			this.lastTime = time;
			return;

		}
		const elapsed = time - this.lastTime;
		if ( elapsed < 1 / 30 - 1e-6 ) return;
		this.waves.update( this.fft, time );
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
