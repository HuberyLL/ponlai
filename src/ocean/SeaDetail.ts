/*!
 * Adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import { Fn, texture, uniform, float, vec2, vec4, dot, mix, smoothstep, clamp, max } from 'three/tsl';
import { mulberry32 } from '../world/noise.ts';
import { REFERENCE_SPEED } from '../weather/Wind.ts';
import type { Shared } from '../shared.ts';

// Large-scale variation of the sea surface in world space, which never repeats with the FFT's tiles
// (tidewater's SeaDetail, 4811ba4):
//  - gusts ("cat's paws"): patches of rougher water drifting downwind. Rough water reflects less of
//    the bright horizon sky, so from a low viewpoint gusts read as irregular dark patches, and the
//    sun's glitter path breaks into patches;
//  - slicks: long calm bands along the wind (surfactant films) where the capillary waves are damped,
//    mirror-like and bright, mostly in light to moderate wind;
//  - windrows: thin wavy lines along the wind in fresh wind (Langmuir circulation), mostly smooth
//    lanes with a trace of foam.
// `sample( xz )` gives ( rough, gust, slick, streak ): the multiplier of the short waves' slopes the
// pixel cannot resolve (and of the near-field ripples), and the three patterns in 0..1. Water.ts
// reads it at the surface's undisplaced point.
//
// Its inputs are the weather's wind (Wind.ts): the travel direction and the speed, and the gusts
// drift with 0.7 times the wind's integrated displacement (tidewater moves them at 0.7 times the
// wind speed a frame), so the pattern is a function of the wind's state and the scene clock and a
// paused frame repeats. The noise is a tileable smooth fbm in four channels, made once on the CPU
// with fixed seeds (256 texels, half float, bilinear, repeating; low frequency, so no mipmaps).

type V2 = THREE.Node<'vec2'>;

const NOISE_SIZE = 256;

export class SeaDetail {

	readonly texture: THREE.DataTexture;
	readonly gustAmount = uniform( 1 );
	readonly slickAmount = uniform( 1 );
	readonly streakAmount = uniform( 0.3 );
	/** ( rough, gust, slick, streak ) at a world xz (explicit level: callable in branches). Inlined
	 * where it is called: as a layout function reading this module's uniforms and texture, r186
	 * emitted it with the first material's binding names in the next one that called it. */
	readonly sample: ( xz: V2 ) => THREE.Node<'vec4'>;

	constructor( shared: Shared ) {

		this.texture = makeNoiseTexture( NOISE_SIZE );
		const noise = ( uv: V2 ) => texture( this.texture, uv ).level( float( 0 ) );
		const wind = shared.wind;
		const { gustAmount, slickAmount, streakAmount } = this;

		this.sample = Fn( ( [ xz ]: [ V2 ] ) => {

			const p = xz.sub( wind.displacement.mul( 0.7 ) ).toVar();
			const windSpeed = wind.breeze.mul( REFERENCE_SPEED );

			// gusts: two octaves (about 600 m and 230 m features), the second slowly morphing
			const g1 = noise( p.div( 620 ) ).x;
			const g2 = noise( p.div( 230 ).add( vec2( shared.time.mul( 0.0009 ), 0.37 ) ) ).y.toVar();
			const gustRaw = g1.mul( 0.62 ).add( g2.mul( 0.38 ) );
			const gust = clamp( gustRaw.sub( 0.5 ).mul( 2.4 ).mul( gustAmount ).add( 0.5 ), 0, 1 ).toVar();

			// a frame along the wind, lightly domain-warped so that the bands meander
			const w = wind.direction;
			const along = dot( xz, w ).toVar();
			const across = dot( xz, vec2( w.y.negate(), w.x ) ).add( g2.sub( 0.5 ).mul( 26 ) ).toVar();

			// slicks: long bands, strongest in light wind, torn apart by gusts
			const sl = noise( vec2( along.div( 1100 ), across.div( 70 ) ) ).z;
			const calmWind = smoothstep( 13, 4, windSpeed );
			const slick = smoothstep( 0.64, 0.76, sl ).mul( float( 1 ).sub( gust.mul( 0.8 ) ) ).mul( calmWind ).mul( slickAmount ).toVar();

			// windrows: thin lines about 10 m apart that come and go along their length
			const st = noise( vec2( along.div( 380 ), across.div( 11 ) ).add( vec2( 0.13, 0.71 ) ) ).w;
			const breakUp = noise( vec2( along.div( 140 ), across.div( 40 ) ).add( vec2( 0.51, 0.29 ) ) ).x;
			const freshWind = smoothstep( 6, 12, windSpeed );
			const streak = smoothstep( 0.68, 0.82, st ).mul( smoothstep( 0.4, 0.62, breakUp ) ).mul( freshWind ).mul( streakAmount ).toVar();

			// windrows show mostly as smooth lanes (surfactant and debris collect in the convergence
			// lines and damp the ripples), with only a trace of foam
			const rough = mix( float( 0.5 ), float( 1.5 ), gust ).mul( float( 1 ).sub( slick.mul( 0.8 ) ) )
				.mul( float( 1 ).sub( streak.div( max( streakAmount, 1e-3 ) ).mul( 0.45 ) ) );
			return vec4( rough, gust, slick, streak );

		} );

	}

}

// A tileable smooth fbm (periodic gradient noise, quintic fade) in four channels, each with its own
// seed, base frequency and octaves, normalised to 0..1.
function makeNoiseTexture( size: number ): THREE.DataTexture {

	const data = new Uint16Array( size * size * 4 );
	const channels = [
		{ seed: 11, freq: 4, oct: 4 },
		{ seed: 23, freq: 5, oct: 4 },
		{ seed: 37, freq: 4, oct: 3 },
		{ seed: 53, freq: 6, oct: 3 },
	];
	const values = new Float32Array( size * size );
	for ( let c = 0; c < 4; c ++ ) {

		const { seed, freq, oct } = channels[ c ];
		const rand = mulberry32( seed );
		// a gradient table per octave (a periodic lattice)
		const tables: { n: number; g: Float32Array }[] = [];
		for ( let o = 0; o < oct; o ++ ) {

			const n = freq << o;
			const g = new Float32Array( n * n * 2 );
			for ( let i = 0; i < n * n; i ++ ) {

				const a = rand() * Math.PI * 2;
				g[ i * 2 ] = Math.cos( a );
				g[ i * 2 + 1 ] = Math.sin( a );

			}
			tables.push( { n, g } );

		}

		let lo = Infinity, hi = - Infinity;
		for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) {

			let v = 0, amp = 1, norm = 0;
			for ( let o = 0; o < oct; o ++ ) {

				const { n, g } = tables[ o ];
				const fx = x / size * n, fy = y / size * n;
				const xi = Math.floor( fx ), yi = Math.floor( fy );
				const xf = fx - xi, yf = fy - yi;
				const grad = ( ix: number, iy: number, dx: number, dy: number ) => {

					const k = ( ( ( iy % n ) + n ) % n ) * n + ( ( ( ix % n ) + n ) % n );
					return g[ k * 2 ] * dx + g[ k * 2 + 1 ] * dy;

				};
				const u = xf * xf * xf * ( xf * ( xf * 6 - 15 ) + 10 );
				const w = yf * yf * yf * ( yf * ( yf * 6 - 15 ) + 10 );
				const a0 = grad( xi, yi, xf, yf ), a1 = grad( xi + 1, yi, xf - 1, yf );
				const b0 = grad( xi, yi + 1, xf, yf - 1 ), b1 = grad( xi + 1, yi + 1, xf - 1, yf - 1 );
				const top = a0 + ( a1 - a0 ) * u;
				v += ( top + ( ( b0 + ( b1 - b0 ) * u ) - top ) * w ) * amp;
				norm += amp;
				amp *= 0.5;

			}
			v /= norm;
			values[ y * size + x ] = v;
			lo = Math.min( lo, v );
			hi = Math.max( hi, v );

		}
		for ( let i = 0; i < size * size; i ++ ) data[ i * 4 + c ] = THREE.DataUtils.toHalfFloat( ( values[ i ] - lo ) / ( hi - lo ) );

	}

	const t = new THREE.DataTexture( data, size, size, THREE.RGBAFormat, THREE.HalfFloatType );
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	t.magFilter = t.minFilter = THREE.LinearFilter;
	t.generateMipmaps = false;
	t.name = 'seaDetailNoise';
	t.needsUpdate = true;
	return t;

}
