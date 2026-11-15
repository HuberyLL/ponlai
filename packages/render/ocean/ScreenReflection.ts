/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * SPDX-FileCopyrightText: Copyright (c) 2026 DRG Software Solutions LLC
 * SPDX-License-Identifier: MIT
 */

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, Break, texture, textureLoad, textureSize, cameraPosition, cameraProjectionMatrix, cameraProjectionMatrixInverse,
	cameraViewMatrix, cameraWorldMatrix, float, int, ivec2, vec2, vec3, vec4, mix, smoothstep, clamp, length, max, min, abs, select,
	sqrt, log2, exp2, floor, asin, sin, cos, normalize,
} from 'three/tsl';
import { sceneUnits } from '../post/PreExposure.ts';
import { cellIndex, NO_SURFACE, PYRAMID_LEVELS, SKY_Z, type DepthPyramid } from '../post/DepthPyramid.ts';

type F = THREE.Node<'float'>;
type I = THREE.Node<'int'>;
type IV2 = THREE.Node<'ivec2'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

// The sea's screen-space reflection of the opaque scene, traced over the depth pyramid and read through a cone.
//
// What it reflects: the cliffs, the plants and the islanders, as the opaque pass drew them (its
// resolved colour and linear depth). Water.ts calls `trace` for the rays near the horizon whose
// reflectance can be seen, and blends its colour over the sky's reflection by its weight.
//
// The trace (Uludag, "Hi-Z Screen-Space Cone-Traced Reflections", GPU Pro 5, 2014): the ray, from
// just off the water (a start that grows with the distance, tidewater's) to FARTHEST, in front of
// the camera and inside the box of what it can reflect, is projected to the screen and clipped to
// it, then walked cell by cell over the depth pyramid (post/DepthPyramid.ts), its view z at each
// cell's edges interpolated in perspective (McGuire & Mara, "Efficient GPU Screen-Space Ray
// Tracing", JCGT 3:4, 2014). A cell whose depth range (its nearest surface to its farthest one's
// back, THICKNESS behind it) the ray does not meet is stepped over and the trace climbs a level; a
// cell it meets, the trace moves up to where the ray enters that range and descends, down to the
// pixel the ray meets, which is the hit. Nothing is skipped, so a culm a few pixels wide is found,
// and a ray that passes behind a surface goes on past it. A march over fixed steps stepped over thin
// culms and gave up on a ray at the first surface it passed behind: a speck of sky in the reflected
// cliff, gaps in the reflected grove. A ray that runs out of iterations short of its end is taken
// where it stopped, its footprint there (below) telling what it was passing: a ray threading a
// grove's culms descends and climbs at each it passes behind and can spend the whole budget among
// them, and keeping the sky for it scattered single-pixel specks of sky over the reflected island.
//
// The cone: a pixel of the sea reflects a spread of directions, the reflected ray's turn across the
// pixel (the waves the pixel resolves: its derivatives) and the lobe of the slopes it does not
// resolve (Water.ts REFLECTION_LOBE), so it sees an area of what it reflects that widens along the
// ray: its footprint on the screen, the pixel's own at the water plus the spread times the
// distance. The footprint is tall and narrow. A slope along the view turns the reflected ray's
// elevation by twice its angle, a slope across the view turns its azimuth by twice its angle times
// the tangent of the view's elevation, nearly nothing at a grazing view: the reflection of a cliff
// in a rippled sea is drawn out downward, not blurred sideways. The hit's colour is the opaque
// colour read over that footprint: TAPS reads down its height, each over a square of the
// footprint's width (the colour's mips: Pipeline.ts `opaqueColor`), and each read classed by the
// depth under it. A surface above the sea is a reflector, which the colour averages; the sky above
// the horizon is what the ray goes on to, which the weight leaves to the sky's reflection
// underneath (the weight is the reflectors' share of the reads that are either); what lies under
// the sea or the dome under the horizon no reflected ray can reach, and is left out of both. Where
// two neighbouring reads differ, a reflector and the open sky, a bisection of EDGE_STEPS finds the
// edge between them and each weighs its side of it, so the weight follows an edge through the
// footprint smoothly, not in steps of a read. So the top of a cliff's reflection fades into the
// sky's over its height, a culm narrower than the footprint shows as its share of it, and the
// reflection's foot takes no colour from the seabed behind it. On a calm sea the footprint is a
// pixel and the reflection a sharp mirror.
//
// Which ray is traced: the cone's lower edge, the pixel's own ray turned down by half the cone's
// height (never below the horizontal, unless the pixel's own ray is), and the footprint is read
// round the pixel's own ray as far along. A cliff stands on the sea with the sky above it, so the
// lower edge meets it wherever any of the cone does: the pixels whose own rays pass just over the
// cliff's top take the share of their footprint the cliff fills, as those just under it do. Tracing
// the pixel's own ray gave the first nothing, and as the waves turn each pixel's ray across the top
// a pixel at a time, the top of the reflection broke into single-pixel specks of sky.
//
// The box (Water.ts `reflectionBounds`), in two switches, each its own material: cull, a ray that
// never meets the box within its stretch keeps the sky without tracing (most of the sea away from
// the island); clip, the trace covers only the stretch inside the box. The stretch before the box
// crosses the screen over the seabed and the shore, whose depths a ray can meet, and a hit there
// ends the ray on something it cannot reflect (or that weighs nothing) where the stretch in the box
// would find another: the image changes without it.
//
// The waterline: where the ray meets the cliff below the sea's reach, it could only have got there
// through the water it meets first. Falling back to the sky there (tidewater fades the lowest 0.4 m,
// sized for cliffs ten times taller) drew a bright band along every cliff foot. The sea at this
// island's cliffs is a near mirror in everyday weather, so the reflected rock continues down to the
// waterline, and rock just below it shows the rock where it leaves the water: the hit lifted to the
// waterline, if the depth buffer confirms rock there (a cliff face, not open seabed). A gale's swell
// heaves the surface at the rock by tens of centimetres; the reach grows with it and the lifted rock
// gives way to the sky, so a rough sea keeps its sky-lit facets. Hits deeper than 0.35 m under the
// sea level weigh nothing (Water.ts REFLECTION_FLOOR ends the box there).

// The trace stops this far along the ray (m); its hits fade out from 120 m (tidewater's).
const FARTHEST = 260;
// How far behind a surface the trace takes the surface to reach (m): a share of its distance, at
// least `least`. The depth buffer holds only the front of things; a ray that passes behind a surface
// by less than this meets it, by more goes on past it. The share keeps a distant cliff, whose depth a
// pixel spans by metres, solid.
const THICKNESS = { least: 0.35, share: 0.02 } as const;
// The cone spans `lobe` standard deviations of the unresolved slopes' lobe either side.
const CONE = { lobe: 1 } as const;
// The reads down the footprint's height, and the bisection's steps for an edge between two of them.
const TAPS = 6;
const EDGE_STEPS = 3;

// The distances along a ray (origin, unit direction) at which it enters and leaves a box (slab
// method); enter > leave when it misses.
const rayBoxSpan = Fn( ( [ origin, direction, lo, hi ]: [ V3, V3, V3, V3 ] ) => {

	const safe = ( c: F ) => select( abs( c ).lessThan( 1e-6 ), select( c.lessThan( 0 ), float( - 1e-6 ), float( 1e-6 ) ), c );
	const inv = vec3( float( 1 ).div( safe( direction.x ) ), float( 1 ).div( safe( direction.y ) ), float( 1 ).div( safe( direction.z ) ) ).toVar();
	const a = lo.sub( origin ).mul( inv ).toVar(), b = hi.sub( origin ).mul( inv ).toVar();
	const enter = max( max( min( a.x, b.x ), min( a.y, b.y ) ), min( a.z, b.z ) );
	const leave = min( min( max( a.x, b.x ), max( a.y, b.y ) ), max( a.z, b.z ) );
	return vec2( enter, leave );

} ).setLayout( {
	name: 'rayBoxSpan', type: 'vec2',
	inputs: [ { name: 'origin', type: 'vec3' }, { name: 'direction', type: 'vec3' }, { name: 'lo', type: 'vec3' }, { name: 'hi', type: 'vec3' } ],
} );

export interface ScreenReflectionInputs {
	depth: THREE.TextureNode; // the opaque pass's linear depth: sample 0's view z (x)
	sceneColor: THREE.Texture; // its resolved colour, with mips
	pyramid: DepthPyramid; // the depth's pyramid
	iterations: number; // the most steps of the trace (WaterQuality `ssrIterations`), compiled in
	box: { min: V3; max: V3; cull: boolean; clip: boolean }; // what the sea can reflect (world space)
	waterLevel: F;
	gale: F; // the wind's gale share (shared.ts), which lowers the lifted rock at the waterline
}

export interface ScreenReflection {
	/** The cone's full width across and along the screen's vertical, in radians, which `trace` takes:
	 * from the reflected direction's derivatives across the pixel
	 * (`dRx`, `dRy`: world space, taken in uniform control flow), the unresolved slopes' lobe
	 * (`lobeW`, one standard deviation of the reflected direction's elevation, radians) and the
	 * sine of the view's elevation over the water (`sinView`). */
	cone( dRx: V3, dRy: V3, lobeW: F, sinView: F ): V2;
	/** The opaque scene the view-space ray from `posV` along unit `Rv` reflects, in scene units,
	 * and its weight (a). */
	trace( posV: V3, Rv: V3, cone: V2 ): V4;
}

export function screenReflection( inputs: ScreenReflectionInputs ): ScreenReflection {

	const { depth, sceneColor, pyramid, iterations, box, waterLevel, gale } = inputs;
	const size = vec2( textureSize( depth ) as unknown as IV2 );
	const lastPixel = ivec2( size ).sub( int( 1 ) );
	const cells = pyramid.reader();
	const levels = pyramid.levels;
	// (a cell clamped to a level's: integer vectors, which three's typings of clamp do not take)
	const clampCell = ( cell: IV2, last: IV2 ) => clamp( cell as unknown as V2, ivec2( 0 ) as unknown as V2, last as unknown as V2 ) as unknown as IV2;
	// sample 0's view z at a pixel
	const viewZAt = ( p: V2 ) => ( textureLoad( depth, clampCell( ivec2( floor( p ) ), lastPixel ) ) as unknown as V4 ).x;
	// a cell's depth range ( nearest, farthest ), level 0 the linear depth's sample 0
	const cellRange = Fn( ( [ level, cell ]: [ I, IV2 ] ) => {

		const range = vec2( 0 ).toVar();
		If( level.equal( int( 0 ) ), () => {

			const z = ( textureLoad( depth, clampCell( cell, lastPixel ) ) as unknown as V4 ).x.toVar();
			range.assign( vec2( z, select( z.lessThan( SKY_Z ), float( NO_SURFACE ), z ) ) );

		} ).Else( () => {

			const L = ( levels.element( level ) as unknown as V4 ).toVar();
			const c = clampCell( cell, ivec2( int( L.y ).sub( int( 1 ) ), int( L.z ).sub( int( 1 ) ) ) );
			range.assign( cells.element( cellIndex( L, c ) ) as unknown as V2 );

		} );
		return range;

	} ).setLayout( { name: 'cellRange', type: 'vec2', inputs: [ { name: 'level', type: 'int' }, { name: 'cell', type: 'ivec2' } ] } );
	// a clip-space point on the screen, in pixels (y down)
	const toPixels = ( h: V4, k: F ) => vec2( h.x.mul( k ).mul( 0.5 ).add( 0.5 ), float( 0.5 ).sub( h.y.mul( k ).mul( 0.5 ) ) ).mul( size );
	// a pixel's ray in view space, homogeneous (its direction is xyz, whatever w)
	const pixelRay = ( p: V2 ) => cameraProjectionMatrixInverse.mul( vec4( p.x.div( size.x ).mul( 2 ).sub( 1 ), float( 1 ).sub( p.y.div( size.y ).mul( 2 ) ), 1, 1 ) );
	// radians to pixels at unit depth (the projection's y scale: column 1's y)
	const focalPixels = ( ( cameraProjectionMatrix as unknown as { element( i: I ): V4 } ).element( int( 1 ) ) ).y.mul( size.y.mul( 0.5 ) );

	// The opaque colour over a footprint at pixel `p`, `width` pixels across and `height` down (the
	// header, The cone), and the reflectors' share of what the footprint reads (a).
	const overFootprint = Fn( ( [ p, width, height ]: [ V2, F, F ] ) => {

		const mip = log2( max( max( width, height.div( TAPS ) ), 1 ) ).toVar();
		// (the footprint's first and last reads, and the rays through them in view space and their
		// world height's share: homogeneous coordinates are linear on the screen)
		const first = p.add( vec2( 0, height.mul( 0.5 / TAPS - 0.5 ) ) ).toVar();
		const last = p.add( vec2( 0, height.mul( 0.5 - 0.5 / TAPS ) ) ).toVar();
		const rayFirst = pixelRay( first ).xyz.toVar(), rayLast = pixelRay( last ).xyz.toVar();
		const upFirst = cameraWorldMatrix.mul( vec4( rayFirst, 0 ) ).y.toVar(), upLast = cameraWorldMatrix.mul( vec4( rayLast, 0 ) ).y.toVar();
		// what the footprint holds at share f of the way from the first read to the last: 1 a surface
		// above the sea, - 1 the sky above the horizon, 0 neither (the world height of what the pixel
		// holds: the sky's far depth puts it far up or down)
		const classAt = ( f: F | number ) => {

			const z = viewZAt( mix( first, last, f ) ).toVar();
			const worldY = cameraPosition.y.add( mix( upFirst, upLast, f ).mul( z.div( mix( rayFirst.z, rayLast.z, f ) ) ) );
			return select( worldY.greaterThanEqual( waterLevel ), select( z.lessThan( SKY_Z ), float( - 1 ), float( 1 ) ), float( 0 ) );

		};
		const reads: F[] = [];
		const weights: F[] = [];
		for ( let k = 0; k < TAPS; k ++ ) {

			reads.push( classAt( TAPS > 1 ? k / ( TAPS - 1 ) : 0 ).toVar() );
			weights.push( float( 1 ).toVar() );

		}
		// Between a reflector's read and the open sky's, the edge, found by bisection: each read
		// weighs the share of the footprint on its side of it, so the weight follows an edge across
		// the footprint smoothly rather than in steps of a read.
		for ( let k = 1; k < TAPS; k ++ ) {

			If( reads[ k - 1 ].mul( reads[ k ] ).lessThan( 0 ), () => {

				const f0 = ( k - 1 ) / ( TAPS - 1 ), f1 = k / ( TAPS - 1 );
				const lo = float( f0 ).toVar(), hi = float( f1 ).toVar();
				for ( let i = 0; i < EDGE_STEPS; i ++ ) {

					const mid = lo.add( hi ).mul( 0.5 ).toVar();
					If( classAt( mid ).equal( reads[ k - 1 ] ), () => {

						lo.assign( mid );

					} ).Else( () => {

						hi.assign( mid );

					} );

				}
				const shift = lo.add( hi ).mul( 0.5 ).sub( f0 ).div( f1 - f0 ).sub( 0.5 ).toVar();
				weights[ k - 1 ].addAssign( shift );
				weights[ k ].subAssign( shift );

			} );

		}
		const reflector = vec4( 0 ).toVar();
		const open = float( 0 ).toVar();
		for ( let k = 0; k < TAPS; k ++ ) {

			const at = mix( first, last, TAPS > 1 ? k / ( TAPS - 1 ) : 0 );
			const w = select( reads[ k ].greaterThan( 0.5 ), weights[ k ], float( 0 ) );
			reflector.addAssign( vec4( sceneUnits( texture( sceneColor, at.div( size ) ).level( mip ).rgb ).mul( w ), w ) );
			open.addAssign( select( reads[ k ].lessThan( - 0.5 ), weights[ k ], float( 0 ) ) );

		}
		return vec4( reflector.rgb.div( max( reflector.a, 1e-4 ) ), reflector.a.div( max( reflector.a.add( open ), 1e-4 ) ) );

	} ).setLayout( { name: 'overFootprint', type: 'vec4', inputs: [ { name: 'p', type: 'vec2' }, { name: 'width', type: 'float' }, { name: 'height', type: 'float' } ] } );

	const trace = Fn( ( [ posV, Rv, cone ]: [ V3, V3, V2 ] ) => {

		const res = vec4( 0 ).toVar();
		// (rays toward the camera fade out by this weight; those it zeroes are not traced)
		const directionWeight = smoothstep( 0.5, 0.1, Rv.z ).toVar();
		// The ray traced: the cone's lower edge, the pixel's own ray turned down by half the cone's
		// height, never below the horizontal unless the pixel's own ray is (the header, Which ray is traced).
		const Rw = cameraWorldMatrix.mul( vec4( Rv, 0 ) ).xyz.toVar();
		const elevation = asin( clamp( Rw.y, - 1, 1 ) ).toVar();
		const lowered = max( elevation.sub( cone.y.mul( 0.5 ) ), min( elevation, 0 ) ).toVar();
		const heading = normalize( vec3( Rw.x, 0, Rw.z ).add( vec3( 1e-6, 0, 0 ) ) ).mul( cos( lowered ) ).toVar();
		const Rt = normalize( cameraViewMatrix.mul( vec4( heading.x, sin( lowered ), heading.z, 0 ) ).xyz ).toVar();
		// the stretch of the ray traced (m along it): from just off the water, in front of the camera,
		// to FARTHEST
		const tIn = max( posV.z.negate().div( 60 ), 1 ).mul( 0.15 ).toVar();
		const tOut = float( FARTHEST ).toVar();
		If( Rt.z.greaterThan( 0 ), () => {

			tOut.assign( min( tOut, posV.z.negate().sub( 0.2 ).div( Rt.z ) ) );

		} );
		let traces = Rv.z.lessThanEqual( 0.6 ).and( directionWeight.greaterThan( 0 ) );
		// where the ray is inside the box (in world space: the view is rigid, so distances along the
		// ray are the same)
		if ( box.cull || box.clip ) {

			const span = rayBoxSpan( cameraWorldMatrix.mul( vec4( posV, 1 ) ).xyz, cameraWorldMatrix.mul( vec4( Rt, 0 ) ).xyz, box.min, box.max ).toVar();
			if ( box.cull ) traces = traces.and( span.y.greaterThanEqual( max( span.x, tIn ) ) ).and( span.x.lessThanEqual( tOut ) );
			if ( box.clip ) {

				tIn.assign( max( tIn, span.x ) );
				tOut.assign( min( tOut, span.y ) );

			}

		}
		If( traces.and( tOut.greaterThan( tIn ) ), () => {

			// the stretch's ends in view space, in clip space and on the screen
			const a = posV.add( Rt.mul( tIn ) ).toVar(), b = posV.add( Rt.mul( tOut ) ).toVar();
			const ha = cameraProjectionMatrix.mul( vec4( a, 1 ) ).toVar(), hb = cameraProjectionMatrix.mul( vec4( b, 1 ) ).toVar();
			const ka = float( 1 ).div( ha.w ).toVar(), kb = float( 1 ).div( hb.w ).toVar();
			const sa = toPixels( ha, ka ).toVar(), sb = toPixels( hb, kb ).toVar();
			const d = sb.sub( sa ).toVar();
			// (a direction along a pixel axis divides by a tiny step, never by zero)
			const forward = vec2( select( d.x.greaterThanEqual( 0 ), float( 1 ), float( - 1 ) ), select( d.y.greaterThanEqual( 0 ), float( 1 ), float( - 1 ) ) ).toVar();
			const dSafe = max( abs( d ), vec2( 1e-5 ) ).mul( forward ).toVar();
			// the part of the stretch on the screen: s in [ s0, s1 ] along it
			const e0 = sa.negate().div( dSafe ).toVar(), e1 = size.sub( sa ).div( dSafe ).toVar();
			const s0 = max( max( min( e0.x, e1.x ), min( e0.y, e1.y ) ), 0 ).toVar();
			const s1 = min( min( max( e0.x, e1.x ), max( e0.y, e1.y ) ), 1 ).toVar();
			// the ray at screen parameter s: the share u of the stretch in view space (perspective-
			// correct), its view z and its distance; and the s at which it reaches view z `z`
			const along = ( s: F ) => s.mul( kb ).div( mix( ka, kb, s ) );
			const dz = b.z.sub( a.z ).toVar();
			const flat = abs( dz ).lessThan( 1e-6 ).toVar();
			const atZ = ( z: F ) => {

				const u = z.sub( a.z ).div( select( flat, float( 1 ), dz ) );
				return u.mul( ka ).div( kb.add( u.mul( ka.sub( kb ) ) ) );

			};
			const toward = vec2( max( forward, vec2( 0 ) ) ).toVar();
			const s = s0.toVar();
			const level = int( 0 ).toVar();
			const hit = float( 0 ).toVar();
			Loop( iterations, () => {

				If( s.greaterThanEqual( s1 ), () => {

					Break();

				} );
				const cellSize = exp2( float( level ) ).toVar();
				const cell = floor( sa.add( d.mul( s ) ).div( cellSize ) ).toVar();
				// where the ray leaves the cell (pushed a hundredth of a pixel into the next)
				const exits = cell.add( toward ).mul( cellSize ).add( forward.mul( 0.01 ) ).sub( sa ).div( dSafe );
				const sExit = min( min( exits.x, exits.y ), s1 ).toVar();
				const z0 = mix( a.z, b.z, along( s ) ).toVar(), z1 = mix( a.z, b.z, along( sExit ) ).toVar();
				const range = cellRange( level, ivec2( cell ) ).toVar();
				const back = range.y.sub( max( abs( range.y ).mul( THICKNESS.share ), THICKNESS.least ) ).toVar();
				const meets = min( z0, z1 ).lessThanEqual( range.x ).and( max( z0, z1 ).greaterThanEqual( back ) );
				If( meets.not(), () => {

					s.assign( sExit );
					level.assign( min( level.add( int( 1 ) ) as unknown as F, int( PYRAMID_LEVELS ) as unknown as F ) as unknown as I );

				} ).Else( () => {

					// on to where the ray enters the cell's depth range: its nearest surface going away
					// from the eye, the back of its farthest coming toward it
					const sIn = select( flat, s, atZ( select( z1.lessThan( z0 ), range.x, back ) ) );
					s.assign( clamp( sIn, s, sExit ) );
					If( level.equal( int( 0 ) ), () => {

						hit.assign( 1 );
						Break();

					} );
					level.subAssign( int( 1 ) );

				} );

			} );
			// A ray out of steps short of its end is taken where it stopped: the footprint there tells
			// what it was passing (the header, The trace).
			If( hit.lessThan( 0.5 ).and( s.lessThan( s1 ) ), () => {

				hit.assign( 1 );

			} );
			If( hit.greaterThan( 0.5 ), () => {

				const u = along( s ).toVar();
				const hv = mix( a, b, u ).toVar();
				const p = sa.add( d.mul( s ) ).toVar();
				const q = p.div( size ).toVar();
				const t = mix( tIn, tOut, u ).toVar();
				// the cone's footprint at the hit, in pixels across and down, round the pixel's own ray
				// as far along
				const footprint = length( posV ).add( cone.mul( focalPixels ).mul( t ) ).div( max( hv.z.negate(), 0.1 ) ).toVar();
				const hc = cameraProjectionMatrix.mul( vec4( posV.add( Rv.mul( t ) ), 1 ) ).toVar();
				const seen = overFootprint( toPixels( hc, float( 1 ).div( hc.w ) ), footprint.x, footprint.y ).toVar();
				const hw = cameraWorldMatrix.mul( vec4( hv, 1 ) ).xyz.toVar();
				const edge = smoothstep( 0, 0.06, q.x ).mul( smoothstep( 1, 0.94, q.x ) ).mul( smoothstep( 0, 0.06, q.y ) ).mul( smoothstep( 1, 0.94, q.y ) );
				const base = edge.mul( directionWeight ).mul( smoothstep( FARTHEST, 120, t ) ).toVar();
				res.assign( vec4( seen.rgb, base.mul( seen.a ) ) );
				// the waterline (the header): the hit lifted to the waterline, if rock is there
				const galeShare = clamp( gale, 0, 1 ).toVar();
				const waterline = waterLevel.add( mix( float( 0.03 ), float( 0.3 ), galeShare ) ).toVar();
				const above = smoothstep( waterLevel.sub( galeShare.mul( 0.1 ) ), waterline, hw.y ).toVar();
				If( above.lessThan( 1 ), () => {

					const lifted = cameraViewMatrix.mul( vec4( hw.x, waterline, hw.z, 1 ) ).xyz.toVar();
					const hl = cameraProjectionMatrix.mul( vec4( lifted, 1 ) ).toVar();
					const pl = toPixels( hl, float( 1 ).div( hl.w ) ).toVar();
					const liftedTouch = float( 1 ).sub( smoothstep( 0.15, 0.6, abs( viewZAt( pl ).sub( lifted.z ) ) ) );
					const rockSeen = overFootprint( pl, footprint.x, footprint.y ).toVar();
					// Deep hits (the seabed, rock seen past a downward-tilted facet) keep the sky.
					const shallow = smoothstep( waterLevel.sub( 0.35 ), waterLevel.sub( 0.15 ), hw.y ).mul( float( 1 ).sub( galeShare ) );
					// Weighted, so that a gale's sea (no lifted rock) blends as the direct hit alone.
					const direct = res.a.mul( above ).toVar();
					const rock = base.mul( rockSeen.a ).mul( liftedTouch ).mul( shallow ).mul( float( 1 ).sub( above ) ).toVar();
					const weight = direct.add( rock ).toVar();
					res.assign( vec4( rockSeen.rgb.mul( rock ).add( res.rgb.mul( direct ) ).div( max( weight, 1e-4 ) ), weight ) );

				} );

			} );

		} );
		return res;

	} ).setLayout( { name: 'traceSSR', type: 'vec4', inputs: [ { name: 'posV', type: 'vec3' }, { name: 'Rv', type: 'vec3' }, { name: 'cone', type: 'vec2' } ] } );

	return {
		cone: ( dRx, dRy, lobeW, sinView ) => {

			// how far the reflected direction turns across the pixel, across and down the screen
			const x = cameraViewMatrix.mul( vec4( dRx, 0 ) ).xy, y = cameraViewMatrix.mul( vec4( dRy, 0 ) ).xy;
			const spread = abs( x ).add( abs( y ) );
			// the lobe: whole along the view, by the tangent of the view's elevation across it
			const tangent = min( sinView.div( sqrt( max( float( 1 ).sub( sinView.mul( sinView ) ), 1e-6 ) ) ), 1 );
			const lobe = vec2( tangent, 1 ).mul( lobeW.mul( 2 * CONE.lobe ) );
			return sqrt( spread.mul( spread ).add( lobe.mul( lobe ) ) );

		},
		trace: ( posV, Rv, cone ) => trace( posV, Rv, cone ) as unknown as V4,
	};

}
