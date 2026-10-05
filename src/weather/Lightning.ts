import * as THREE from 'three/webgpu';
import { Fn, If, uniform, vec2, vec3, float, abs, atan, asin, clamp, exp, max, smoothstep, fract, sin, dot, floor, mix, length } from 'three/tsl';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

// Cloud-to-sea lightning in a storm. Strikes come at irregular intervals from a seeded sequence,
// each a few return strokes in quick succession. A strike lights the cloud base around it and
// the whole scene for an instant, and draws a jagged channel from the cloud base to the sea.

const hash = Fn( ( [ p ]: [ THREE.Node<'vec2'> ] ) => fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ).mul( 43758.5453 ) ) )
	.setLayout( { name: 'lightningHash', type: 'float', inputs: [ { name: 'p', type: 'vec2' } ] } );

// Piecewise-linear noise: straight segments with sharp kinks, like a stepped leader.
const noise1 = ( x: F, seed: F ) => {

	const i = floor( x ), f = fract( x );
	return mix( hash( vec2( i, seed ) ), hash( vec2( i.add( 1 ), seed ) ), f ).sub( 0.5 );

};

export class Lightning {

	// Brightness of the current flash, 0 between strikes.
	readonly flash = uniform( 0 );
	// Unit horizontal direction and distance (metres) of the current strike.
	readonly direction = uniform( new THREE.Vector2( 1, 0 ) );
	readonly distance = uniform( 6000 );
	readonly seed = uniform( 0 );
	private seedState = 0x1b0175;
	private wait = 4;
	private strike = - 1; // seconds since the current strike began, < 0 when idle
	private strokes: number[] = [];

	private random(): number {

		let t = this.seedState = ( this.seedState + 0x6D2B79F5 ) | 0;
		t = Math.imul( t ^ ( t >>> 15 ), t | 1 );
		t ^= t + Math.imul( t ^ ( t >>> 7 ), t | 61 );
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	}

	/** `storm` is 0 to 1; strikes come more often and closer as it grows. */
	update( dt: number, storm: number ): void {

		if ( dt <= 0 || this.strike === - 2 ) return;
		if ( this.strike >= 0 ) {

			this.strike += dt;
			// Each stroke flares and decays in tens of milliseconds; the channel glows between.
			let flash = 0;
			for ( const at of this.strokes ) {

				const t = this.strike - at;
				if ( t >= 0 ) flash = Math.max( flash, Math.exp( - t / 0.06 ) * ( t < 0.012 ? t / 0.012 : 1 ) );

			}
			this.flash.value = flash;
			if ( this.strike > this.strokes[ this.strokes.length - 1 ] + 0.6 ) {

				this.strike = - 1;
				this.flash.value = 0;

			}
			return;

		}
		if ( storm < 0.05 ) return;
		this.wait -= dt * storm;
		if ( this.wait > 0 ) return;
		this.wait = 3 + this.random() * 12;
		const angle = this.random() * Math.PI * 2;
		this.direction.value.set( Math.cos( angle ), Math.sin( angle ) );
		this.distance.value = 2500 + this.random() * 9000 * ( 1.4 - storm * 0.6 );
		this.seed.value = Math.floor( this.random() * 1000 );
		const count = 1 + Math.floor( this.random() * 4 );
		this.strokes = [ 0 ];
		for ( let i = 1; i < count; i ++ ) this.strokes.push( this.strokes[ i - 1 ] + 0.05 + this.random() * 0.12 );
		this.strike = 0;

	}

	/** Review aid: hold a strike at full brightness toward `angle` (radians) until `release`. */
	hold( angle: number, distance: number, seed = 1 ): void {

		this.direction.value.set( Math.cos( angle ), Math.sin( angle ) );
		this.distance.value = distance;
		this.seed.value = seed;
		this.flash.value = 1;
		this.strike = - 2;

	}

	release(): void { this.strike = - 1; this.flash.value = 0; }

	/** Light the sky adds along a direction: the channel, a branch, and the glow they cast into
	 * the clouds (`cloudOpacity`, 0 in clear sky) around the strike. */
	sky( direction: V3, cloudBaseAngle: F, cloudOpacity: F ): V3 {

		const result = vec3( 0 ).toVar();
		If( this.flash.greaterThan( 0.001 ), () => {

			const flat = max( length( direction.xz ), 1e-4 );
			const azimuth = fract( atan( direction.z, direction.x ).sub( atan( this.direction.y, this.direction.x ) ).div( 2 * Math.PI ).add( 0.5 ) )
				.sub( 0.5 ).mul( 2 * Math.PI ).toVar();
			const elevation = asin( clamp( direction.y, - 1, 1 ) ).toVar();
			// The channel runs from the cloud base down to the sea, kinking every few dozen metres.
			const top = cloudBaseAngle;
			const along = clamp( elevation.div( max( top, 1e-3 ) ), 0, 1 ).toVar();
			const scale = float( 1 ).div( this.distance ).toVar();
			const wander = noise1( along.mul( 9 ), this.seed ).mul( 380 ).add( noise1( along.mul( 31 ), this.seed.add( 7 ) ).mul( 120 ) )
				.add( noise1( along.mul( 97 ), this.seed.add( 13 ) ).mul( 35 ) ).mul( scale );
			const offset = abs( azimuth.sub( wander ) ).mul( flat );
			const inside = smoothstep( - 0.002, 0.002, elevation ).mul( float( 1 ).sub( smoothstep( top.mul( 0.95 ), top, elevation ) ) );
			// A branch leaves the channel part-way down and drifts away before fading out.
			const fork = clamp( float( 0.62 ).sub( along ).div( 0.35 ), 0, 1 ).toVar();
			const branchWander = wander.add( fork.mul( 520 ).add( noise1( along.mul( 43 ), this.seed.add( 29 ) ).mul( 60 ) ).mul( scale ) );
			const branchOffset = abs( azimuth.sub( branchWander ) ).mul( flat );
			const branch = exp( branchOffset.div( 0.0004 ).negate() ).mul( 18 ).mul( smoothstep( 0, 0.1, fork ) ).mul( float( 1 ).sub( smoothstep( 0.6, 1, fork ) ) );
			const core = exp( offset.div( 0.0004 ).negate() ).mul( 30 );
			const halo = exp( offset.div( 0.002 ).negate() ).mul( 0.6 );
			const channel = core.add( halo ).add( branch ).mul( inside );
			// The cloud around the top of the channel lights up from within.
			const near = exp( abs( azimuth ).mul( flat ).div( 0.09 ).negate() ).mul( exp( abs( elevation.sub( top ) ).div( 0.06 ).negate() ) );
			result.assign( vec3( 0.75, 0.82, 1 ).mul( channel.add( near.mul( cloudOpacity ).mul( 1.2 ) ) ).mul( this.flash ) );

		} );
		return result;

	}

}
