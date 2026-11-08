/*!
 * Adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import { Fn, texture, uv, vec2, vec3, vec4, float, inverseSqrt, luminance, max, select, clamp, uniform } from 'three/tsl';
import type { FrameGraph, GraphResources, ResourceHandle, SizeClass } from './graph/FrameGraph.ts';
import type { PassBuilder } from './graph/GraphCompiler.ts';
import { keyed, type DayKeys } from './DayKeys.ts';
import { tuneKeys } from '../debug/Tune.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

// The bloom, begun as tidewater's PostFX (4811ba4): a pyramid of downsamples from the frame's
// radiance and the tent upsamples that add it back (Jimenez, "Next Generation Post Processing in
// Call of Duty: Advanced Warfare", SIGGRAPH 2014), with a threshold on the exposed image at its
// first level, so only what is bright glows, and a weight per level. Every target is the frame
// graph's, half float, at its render-relative size class.
// - Level 0, half the render: the input's 13-tap downsample (taps one and two render texels off
//   the texel's centre, five overlapping 2x2 boxes weighed 1/2 for the inner box and 1/8 for each
//   corner box), each tap, the mean of its 2x2 render pixels, weighed by its share times
//   1 / ( 1 + its exposed luminance ) and the weights normalised (a Karis average per tap), so a
//   lone hot pixel, which only the five taps about the centre reach, is outweighed by the eight
//   beyond it: a few grass blades' shading singularities spread into glowing discs without it.
//   The taps make two such averages, the land's and the sky's (below), and each goes through the
//   threshold and the cap of its own set. (A source at the canvas's size, as hdr is under fsr3,
//   keeps the taps at render texels: the same footprint on screen.)
// - The threshold, on an average's exposed colour x (mid grey 0.18): its brightness b = max( r, g, b ) goes
//   through a quadratic soft knee, the curve of Unity's Post Processing Stack v2 bloom (used
//   as a technique only, with no code), set so the glow starts at the threshold T: the knee
//   q = clamp( b - T, 0, 2K )^2 / 4K rises from T to T + 2K and meets the line b - T - K there, and
//   the colour is scaled by k max( q, b - T - K ) / b, k the share. A value just over T enters with
//   a square, a bright one linearly, and the colour keeps its hue (the scale is the same for every
//   channel).
// - The cap: the result's luminance Y is compressed smoothly toward `cap`,
//   y cap / sqrt( cap^2 + Y^2 ): a faint glow passes nearly whole (99.5 % at a tenth of the cap),
//   one at the cap keeps 71 %, and no glow, however bright its source, exceeds the cap. (The
//   first-order form y cap / ( cap + Y ) halved a glow at the cap and took a tenth off one at a
//   tenth of it: the square keeps the faint glow and compresses only near the cap.)
// - The sky (depth past the far plane) takes a set of its own (`skyThreshold`, `skyKnee`,
//   `skyShare`, `skyCap`), high enough by day that only the sun and the brightest clouds near it
//   pass, so the open sky does not glow. A pass before level 0 writes the sky's mask at half the
//   render, 1 where any of a texel's four render pixels is sky (one depth read a render pixel), and
//   each tap reads it once, bilinearly at its own centre: a tap that reaches no sky joins the
//   land's average, any other the sky's. (A tap one texel off the level's centre falls between the
//   mask's texels and reads two or four of them, a pixel or two more than its own; it then goes to
//   the sky a little sooner.) The two averages, thresholded and capped, are added back by their
//   weights' sums. So a tap straddling the skyline, its mean of bright sky and dark land, is
//   thresholded as sky and does not glow as land would (a share of the sky between the sets drew a
//   glowing line along a bright skyline), and the land beside the sky keeps its own set whatever
//   the sky about it holds. Against one set for the whole texel mixed by its share of sky, only
//   the skyline's glow changes: mostly less, at most 1.5 % more. `skyShare` is the sky's share of
//   the glow.
// - An extra term (`extra`: the sun's or the moon's flare, LightShafts.ts) joins level 0 after the
//   threshold and the cap, so it shows only through the bloom.
// - Levels 1 to 7, each half the size of the one above (1/4 ... 1/256 of the render): the same
//   13-tap downsample of the level above, without the Karis weights. Each level keeps its colour.
//   Eight levels reach about a fifth of the frame's height at the widest (in one dimension the
//   widest level's spread has a standard deviation of some 310 render pixels at 1440 rows; the
//   finest 1.6, each about twice the one before).
// - The upsamples, from the widest level back to level 0: up_i = w_i L_i + tent( up_( i + 1 ) ),
//   the tent a 3x3 [ 1, 2, 1 ] x [ 1, 2, 1 ] / 16 of the smaller level's texels at the larger's
//   uv (the widest level enters as w_7 L_7). Each level's image keeps its energy through the
//   pyramid, so the result is the levels' images times their weights, and the weights' sum is the
//   strength. The reader reads up_0 bilinearly at half the render and adds it (times its own
//   factor).
// - The extra term, smooth over a level's texel, comes out of every level whole: the result holds
//   it times the weights' sum (`strength`), so its caller divides it by that and the reader's
//   factor, and it leaves at its own radiance.
// The clear high sun's key (from 9 degrees up) is set with the day's exposure and grade, its
// levels' weights on the halo about the sun out to some 50 degrees. The bloom stands for the
// lens's scatter, and the lens does not change with the sky: on the exposed image the same light
// glows the same, so a clouded sky takes the high sun's key whole (under cloud the land and the sky
// stay under its thresholds, and what glows glows as on a clear day: the sea's glints, a sun seen
// through a gap), and every key's sky cap is the high sun's. By a high sun the land's threshold
// sits over three stops above mid grey, so the lit ground stays out; in the golden hour and by night near mid grey, so a low sun's
// whites glow, with a wider knee than the day's in the golden hour and about the day's by night. By
// night the land's share is small by choice (0.05, falling from the low sun's 0.2 as the night
// comes in): at a threshold under the moon's glints a large share spread them over the wide levels
// into a pale pedestal under the whole field, and the water between the glints stood lit. The sky
// keeps its own share, so the moon's disc and the bright clouds glow as before.
// The weights carry the strength: about 2.3 by a high sun; 1.25 in the
// golden hour and by night, whose thresholds let far more in, toward the wide levels (a broad
// soft glow about the moon and bright clouds). The high sun's weights rise and fall from level to
// level, less at 1/16 and 1/128 than at the levels either side, which sets the halo's outer rings
// (all positive, so the summed kernel still falls off from its centre). The finest level takes
// none: its spread, a pixel or two, is the image's own sharpness. The sky's share is a little
// smaller by a clear high sun (0.17) than by a low sun (0.2), so the glow round the sun stays
// close to it rather than spreading over the sky far from it.

const LEVELS = 8;

type BloomKey = {
	threshold: number; knee: number; share: number; cap: number;
	skyThreshold: number; skyKnee: number; skyShare: number; skyCap: number;
	w0: number; w1: number; w2: number; w3: number; w4: number; w5: number; w6: number; w7: number;
};
// the levels' weights from the finest to the widest, scaled so their sum is `strength`
const weights = ( strength: number, w: number[] ) => {

	const sum = w.reduce( ( a, b ) => a + b );
	const [ w0, w1, w2, w3, w4, w5, w6, w7 ] = w.map( ( v ) => Math.round( v / sum * strength * 1e4 ) / 1e4 );
	return { w0, w1, w2, w3, w4, w5, w6, w7 };

};
/** The bloom by the sun's elevation, under a clouded sky and at night (DayKeys.ts), on the exposed
 * image (mid grey 0.18): the land's threshold T (where its glow starts), knee K (the knee's half
 * width), share k and cap, the sky's (`sky...`), and the levels' weights from the finest (w0, half
 * the render) to the widest (w7, 1/256), whose sum is the strength. Tunable on debug pages
 * (debug/Tune.ts `post.bloom.<value>@<key>`, the keys `low`, `high`, `cloudy`, `night`); a tuned sky
 * threshold leaves its knee where the table puts it. */
const HIGH_SUN: BloomKey = {
	threshold: 1.76, knee: 0.66, share: 0.2, cap: 3.89,
	skyThreshold: 18.3, skyKnee: 0.4 * 18.3, skyShare: 0.17, skyCap: 2250,
	w0: 0, w1: 0.38, w2: 0.74, w3: 0.185, w4: 0.395, w5: 0.371, w6: 0.0944, w7: 0.13,
};
export const BLOOM: DayKeys<BloomKey> = tuneKeys( 'post.bloom', {
	day: [
		{ at: 4, name: 'low', values: {
			threshold: 0.2, knee: 1.1, share: 0.2, cap: 2,
			skyThreshold: 6, skyKnee: 0.4 * 6, skyShare: 0.2, skyCap: HIGH_SUN.skyCap,
			...weights( 1.25, [ 0, 0.17, 0.44, 0.54, 0.64, 0.74, 0.88, 0.58 ] ),
		} },
		{ at: 9, name: 'high', values: HIGH_SUN },
	],
	cloudy: HIGH_SUN,
	night: {
		threshold: 0.18, knee: 0.6, share: 0.05, cap: 1,
		skyThreshold: 1, skyKnee: 0.4, skyShare: 0.5, skyCap: HIGH_SUN.skyCap,
		...weights( 1.25, [ 0, 0.13, 0.34, 0.44, 0.58, 0.78, 0.94, 0.58 ] ),
	},
}, { skyThreshold: { min: 3, max: 40, scale: 'log' }, skyCap: { min: 100, max: 3000, scale: 'log' } } );
const levelSize = ( i: number ): SizeClass => ( { of: 'render', scale: 0.5 / 2 ** i, min: 1 } );

// The 13-tap downsample's taps (render or source texels off the destination texel's centre) and
// their shares: the inner 2x2 box's four taps and the centre, the edges' and the corners'.
const TAPS: readonly ( readonly [ number, number, number ] )[] = [
	[ 0, 0, 1 / 8 ], [ - 1, - 1, 1 / 8 ], [ 1, - 1, 1 / 8 ], [ - 1, 1, 1 / 8 ], [ 1, 1, 1 / 8 ],
	[ 0, - 2, 1 / 16 ], [ - 2, 0, 1 / 16 ], [ 2, 0, 1 / 16 ], [ 0, 2, 1 / 16 ],
	[ - 2, - 2, 1 / 32 ], [ 2, - 2, 1 / 32 ], [ - 2, 2, 1 / 32 ], [ 2, 2, 1 / 32 ],
];

export class PhysicalBloom {

	// the sky's mask (level 0's size), each level's downsample, and the upsamples' sums (levels 0
	// to 6)
	private readonly sky: ResourceHandle;
	private readonly down: ResourceHandle[];
	private readonly up: ResourceHandle[];
	private readonly quads: { sky: THREE.QuadMesh; down: THREE.QuadMesh[]; up: THREE.QuadMesh[] };

	readonly uniforms = {
		threshold: uniform( HIGH_SUN.threshold ), knee: uniform( HIGH_SUN.knee ), share: uniform( HIGH_SUN.share ), cap: uniform( HIGH_SUN.cap ),
		skyThreshold: uniform( HIGH_SUN.skyThreshold ), skyKnee: uniform( HIGH_SUN.skyKnee ), skyShare: uniform( HIGH_SUN.skyShare ), skyCap: uniform( HIGH_SUN.skyCap ),
		weights: Array.from( { length: LEVELS }, () => uniform( 0.5 ) ),
	};
	private readonly keyedValues = { ...BLOOM.day[ 0 ].values };

	/** The weights' sum: what a smooth term added to level 0 comes out times (see the header). */
	readonly strength: F;

	/** `input`: the image to bloom (scene radiance), at the render's size or the canvas's; `exposure`
	 * scales it to the exposed image; `isSky` is 1 where screen uv `at` shows the sky; `extra`,
	 * radiance added at screen uv to level 0 (the sun's or the moon's flare, LightShafts.ts), given
	 * `strength` to divide by; the targets are declared on `graph`. */
	constructor( private readonly graph: GraphResources, input: THREE.TextureNode, private readonly exposure: F, private readonly isSky: ( at: V2 ) => F, private readonly extra?: ( at: V2, strength: F ) => V3 ) {

		this.strength = this.uniforms.weights.reduce<F>( ( sum, w ) => sum.add( w ), float( 0 ) );

		const color = ( name: string, size: SizeClass ) => graph.color( name, { size, format: THREE.RGBAFormat, type: THREE.HalfFloatType } );
		this.sky = graph.color( 'bloom.sky', { size: levelSize( 0 ), format: THREE.RedFormat, type: THREE.UnsignedByteType } );
		this.down = Array.from( { length: LEVELS }, ( _, i ) => color( `bloom.down${ i }`, levelSize( i ) ) );
		this.up = Array.from( { length: LEVELS - 1 }, ( _, i ) => color( `bloom.up${ i }`, levelSize( i ) ) );
		const tex = ( h: ResourceHandle ) => texture( graph.texture( h ) );
		const w = this.uniforms.weights;
		this.quads = {
			sky: quad( 'Bloom.Sky', this.skyMask( graph.texel( { of: 'render' } ) ) ),
			down: Array.from( { length: LEVELS }, ( _, i ) => quad( `Bloom.Down${ i }`, i === 0
				? this.prefilter( input, tex( this.sky ), graph.texel( { of: 'render' } ) )
				: vec4( this.downsample( tex( this.down[ i - 1 ] ), graph.texel( levelSize( i - 1 ) ) ), 1 ) ) ),
			up: Array.from( { length: LEVELS - 1 }, ( _, i ) => {

				const widest = i === LEVELS - 2;
				const small = tex( widest ? this.down[ LEVELS - 1 ] : this.up[ i + 1 ] );
				return quad( `Bloom.Up${ i }`, this.upsample( small, tex( this.down[ i ] ), graph.texel( levelSize( i + 1 ) ), w[ i ], widest ? w[ LEVELS - 1 ] : null ) );

			} ),
		};

	}

	// the 13-tap downsample of `source` (`texel` its texel's size in uv) at the pixel's uv
	private downsample( source: THREE.TextureNode, texel: V2 ): V3 {

		const at = uv();
		let sum: V3 = vec3( 0 );
		for ( const [ x, y, share ] of TAPS ) sum = sum.add( source.sample( at.add( texel.mul( vec2( x, y ) ) ) ).rgb.mul( share ) );
		return sum;

	}

	// the sky's mask at level 0's texel (`texel` a render pixel's size in uv): 1 where any of its
	// four render pixels, half a pixel off its centre either way, is sky
	private skyMask( texel: V2 ): V4 {

		return Fn( () => {

			const at = uv();
			let sky: F = float( 0 );
			for ( const [ x, y ] of [ [ - 0.5, - 0.5 ], [ 0.5, - 0.5 ], [ - 0.5, 0.5 ], [ 0.5, 0.5 ] ] ) sky = max( sky, this.isSky( at.add( texel.mul( vec2( x, y ) ) ) ) );
			return vec4( sky, 0, 0, 1 );

		} )() as unknown as V4;

	}

	// level 0 (`texel` a render pixel's size in uv): the 13 taps' Karis averages, the land's and the
	// sky's by the sky's mask (`mask`) at each tap, each through the threshold and the cap of its own
	// set, added back by their weights' sums, with the extra term (see the header)
	private prefilter( source: THREE.TextureNode, mask: THREE.TextureNode, texel: V2 ): V4 {

		return Fn( () => {

			const at = uv();
			const u = this.uniforms;
			let land: V3 = vec3( 0 ), sky: V3 = vec3( 0 ), landWeight: F = float( 0 ), skyWeight: F = float( 0 );
			for ( const [ x, y, share ] of TAPS ) {

				// (the tap: its 2x2 render pixels' mean, one bilinear sample at their shared corner;
				// on land only if the mask holds no sky there)
				const p = at.add( texel.mul( vec2( x, y ) ) );
				const c = source.sample( p ).rgb.mul( this.exposure ).toVar();
				const isSky = select( mask.sample( p ).r.greaterThan( 0 ), float( 1 ), float( 0 ) ).toVar();
				// the Karis weight, by the tap's own exposed luminance
				const w = float( share ).div( luminance( c ).add( 1 ) ).toVar();
				const ws = w.mul( isSky ).toVar(), wl = w.sub( ws ).toVar();
				land = land.add( c.mul( wl ) ); landWeight = landWeight.add( wl );
				sky = sky.add( c.mul( ws ) ); skyWeight = skyWeight.add( ws );

			}
			const lw = landWeight.toVar(), sw = skyWeight.toVar();
			const landGlow = bloomKnee( land.div( max( lw, 1e-30 ) ), u.threshold, max( u.knee, 1e-4 ), u.share, u.cap );
			const skyGlow = bloomKnee( sky.div( max( sw, 1e-30 ) ), u.skyThreshold, max( u.skyKnee, 1e-4 ), u.skyShare, u.skyCap );
			// back to the input's units (hdr's, pre-exposed: PreExposure.ts), with the extra term
			const result = landGlow.mul( lw ).add( skyGlow.mul( sw ) ).div( lw.add( sw ) ).div( this.exposure );
			return vec4( this.extra ? result.add( this.extra( at, this.strength ) ) : result, 1 );

		} )() as unknown as V4;

	}

	// up_i: the level's own image at its weight and the tent of the level below's (`texel` that
	// level's texel in uv), the widest level's at its weight `smallWeight`
	private upsample( small: THREE.TextureNode, base: THREE.TextureNode, texel: V2, weight: F, smallWeight: F | null ): V4 {

		return Fn( () => {

			const at = uv();
			const tap = ( x: number, y: number ): V3 => small.sample( at.add( texel.mul( vec2( x, y ) ) ) ).rgb;
			let s: V3 = tap( 0, 0 ).mul( 4 )
				.add( tap( - 1, 0 ).add( tap( 1, 0 ) ).add( tap( 0, - 1 ) ).add( tap( 0, 1 ) ).mul( 2 ) )
				.add( tap( - 1, - 1 ).add( tap( 1, - 1 ) ).add( tap( - 1, 1 ) ).add( tap( 1, 1 ) ) ).div( 16 );
			if ( smallWeight ) s = s.mul( smallWeight );
			return vec4( base.sample( at ).rgb.mul( weight ).add( s ), 1 );

		} )() as unknown as V4;

	}

	/** Sets the land's and the sky's sets and the levels' weights for the sun's `elevation`
	 * (degrees), the night's weight and the weather's cloud (BLOOM, DayKeys.ts). */
	update( elevation: number, night: number, cloud: number ): void {

		const k = keyed( BLOOM, elevation, night, this.keyedValues, cloud ), u = this.uniforms;
		u.threshold.value = k.threshold; u.knee.value = k.knee; u.share.value = k.share; u.cap.value = k.cap;
		u.skyThreshold.value = k.skyThreshold; u.skyKnee.value = k.skyKnee; u.skyShare.value = k.skyShare; u.skyCap.value = k.skyCap;
		const w = [ k.w0, k.w1, k.w2, k.w3, k.w4, k.w5, k.w6, k.w7 ];
		for ( let i = 0; i < LEVELS; i ++ ) u.weights[ i ].value = w[ i ];

	}

	/** Adds the passes to `graph`: the sky's mask (its reads of `isSky` declared by `skyReads`),
	 * the downsamples (the first one's reads of the input declared by `reads`, its reads of `extra`
	 * by `extraReads`), then the upsamples. Returns the result's version (the last upsample's), for
	 * the reader to declare. */
	passes<Frame>( graph: FrameGraph<Frame>, label: string, reads: ( b: PassBuilder ) => void, skyReads: ( b: PassBuilder ) => void, extraReads?: ( b: PassBuilder ) => void ): ResourceHandle {

		const down = [ ...this.down ], up = [ ...this.up ], q = this.quads;
		let sky = this.sky;
		graph.addPass( 'bloomSky', 'quad', ( b ) => {

			skyReads( b );
			sky = b.write( sky );
			return { label, quad: q.sky };

		} );
		for ( let i = 0; i < LEVELS; i ++ ) {

			graph.addPass( `bloomDown${ i }`, 'quad', ( b ) => {

				if ( i === 0 ) {

					reads( b );
					b.read( sky );
					if ( extraReads ) extraReads( b );

				} else b.read( down[ i - 1 ] );
				down[ i ] = b.write( down[ i ] );
				return { label, quad: q.down[ i ] };

			} );

		}
		for ( let i = LEVELS - 2; i >= 0; i -- ) {

			graph.addPass( `bloomUp${ i }`, 'quad', ( b ) => {

				b.read( i === LEVELS - 2 ? down[ LEVELS - 1 ] : up[ i + 1 ] );
				b.read( down[ i ] );
				up[ i ] = b.write( up[ i ] );
				return { label, quad: q.up[ i ] };

			} );

		}
		return up[ 0 ];

	}

	/** The bloom at screen uv `at`: the last upsample read bilinearly (scene units, before the
	 * reader's factor). */
	read( at: V2 ): V3 {

		return texture( this.graph.texture( this.up[ 0 ] ) ).sample( at ).rgb;

	}

}

// The soft knee and the cap on the exposed colour `x` (see the header): the threshold `T`, the
// knee's half width `K`, the share `k` and the cap
const bloomKnee = Fn( ( [ x, T, K, k, cap ]: [ V3, F, F, F, F ] ) => {

	const b = max( x.r, max( x.g, x.b ) ).toVar();
	const knee = clamp( b.sub( T ), 0, K.mul( 2 ) ).toVar();
	const q = knee.mul( knee ).div( K.mul( 4 ) );
	const y = x.mul( max( q, b.sub( T ).sub( K ) ).mul( k ).div( max( b, 1e-6 ) ) ).toVar();
	const Y = luminance( y );
	return y.mul( cap.mul( inverseSqrt( cap.mul( cap ).add( Y.mul( Y ) ) ) ) );

} ).setLayout( { name: 'bloomKnee', type: 'vec3', inputs: [ { name: 'x', type: 'vec3' }, { name: 'T', type: 'float' }, { name: 'K', type: 'float' }, { name: 'k', type: 'float' }, { name: 'cap', type: 'float' } ] } );

function quad( name: string, fragment: V4 ): THREE.QuadMesh {

	const material = new THREE.NodeMaterial();
	material.name = name;
	material.fragmentNode = fragment;
	const mesh = new THREE.QuadMesh( material );
	mesh.name = name;
	return mesh;

}
