import * as THREE from 'three/webgpu';
import { Fn, texture, uniform, uv, float, vec2, vec4, smoothstep, clamp, mix, min, max, length, dot, exp, select } from 'three/tsl';
import type { OceanFFT } from './OceanFFT.ts';
import type { ShoreWaves } from './ShoreWaves.ts';
import type { Shared } from '../shared.ts';

// Broad whitewater history: R coverage, GB transported material-coordinate offsets (m),
// A the crest source. Water samples crisp lace through the same flow as its coverage.
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
			const texel = shared.shoreXform.zw.mul( 0.3 );
			const gradient = vec2(
				sampleShore( q.add( vec2( texel.x, 0 ) ) ).sub( sampleShore( q.sub( vec2( texel.x, 0 ) ) ) ),
				sampleShore( q.add( vec2( 0, texel.y ) ) ).sub( sampleShore( q.sub( vec2( 0, texel.y ) ) ) ),
			);
			const normal = gradient.div( max( length( gradient ), 1e-5 ) );
			const wave = waves.texture.sample( q ).level( float( 0 ) ).toVar();
			const field = waves.field.sample( q ).level( float( 0 ) ).toVar();
			const invSpeed = max( length( field.gb ), 1e-4 );
			const direction = field.gb.div( invSpeed );
			const old = this.previous.sample( q ).level( float( 0 ) ).toVar();
			const valid = float( 1 ).sub( this.seed );
			// Tidewater's shallow-water particle velocity c*eta/h reverses with the trough.
			// A modest outward return carries the foam left after a crest hits the cliff.
			const orbital = clamp( wave.x.div( invSpeed.mul( max( field.a, 0.7 ) ) ), - 0.4, 0.5 );
			const flow = direction.mul( orbital.add( 0.04 ) ).toVar();
			const coast = float( 1 ).sub( smoothstep( 0.2, 1.8, sd ) );
			flow.subAssign( normal.mul( min( dot( flow, normal ), 0 ) ).mul( coast ) );
			flow.addAssign( normal.mul( old.r ).mul( coast ).mul( float( 1 ).sub( wave.w ) ).mul( 0.22 ) );
			// Semi-Lagrangian backtracing after Jos Stam (GDC 2003); see CREDITS.md.
			const upstream = q.sub( flow.mul( this.dt ).mul( shared.shoreXform.zw ) );
			const edge = select( upstream.x.greaterThanEqual( 0 ).and( upstream.x.lessThanEqual( 1 ) )
				.and( upstream.y.greaterThanEqual( 0 ) ).and( upstream.y.lessThanEqual( 1 ) ), float( 1 ), float( 0 ) );
			const carried = this.previous.sample( clamp( upstream, vec2( 0 ), vec2( 1 ) ) ).level( float( 0 ) ).mul( edge ).mul( valid );
			const decay = exp( this.dt.mul( - 0.9 ) );
			const remaining = carried.r.mul( decay );
			// Deposition is continuous along the approaching crest, not a per-pixel latch.
			// The crest is the very one displacing the mesh and tipping its shading normal.
			const source = wave.w.mul( float( 1 ).sub( smoothstep( 0.3, 1.6, sd ) ) );
			const birth = float( 1 ).sub( exp( source.mul( this.dt ).mul( - 3.8 ) ) );
			const coverage = remaining.add( float( 1 ).sub( remaining ).mul( birth ) );
			const openWater = select( sd.greaterThan( 0 ), float( 1 ), float( 0 ) );
			const offset = select( carried.r.greaterThan( 0.001 ), carried.gb.sub( flow.mul( this.dt ) ), vec2( 0 ) );
			// New foam joins a fresh parcel gradually instead of snapping a visible old pattern.
			const tracer = mix( offset, vec2( 0 ), birth ).mul( openWater );
			return vec4( coverage.mul( openWater ), tracer.x, tracer.y, source );

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
