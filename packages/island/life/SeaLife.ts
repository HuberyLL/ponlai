import * as THREE from 'three/webgpu';
import { type Shared, type WaveMaps, type OceanFFT, type SwimmerCapsule, SWIMMER_SHADOWS, setSwimmerShadows, swimmerSway } from '../../render/index.ts';
import { mulberry32, hash3i, type Rng } from '../../render/data.ts';
import type { Rock, WorldData } from '../world/types.ts';
import { SeaHabitat } from './SeaHabitat.ts';
import { SwimPath, type Fits, type PathPoint } from './SwimPath.ts';
import { Swimmers, type Pose } from './Swimmers.ts';
import { fishGeometry, type Anatomy } from './FishGeometry.ts';
import { rayGeometry, turtleGeometry, jellyGeometry } from './CreatureGeometry.ts';
import { makeSwimmerMaterial, fishSkin, raySkin, turtleSkin, jellySkin, type Motion, type Painter } from './SwimmerMaterial.ts';
import * as SP from './SeaSpecies.ts';

// The sea's life round the island.
//
// The sea's life round the island: a warm-temperate rocky coast's animals (SeaSpecies.ts), each at
// its real size, where it lives and in the numbers its habitat holds
// (docs/design/life-and-islanders.md, The sea):
//   - sardines in polarised schools of hundreds in mid-water over the shelf's edge, their flanks
//     flashing in waves as the fish roll
//   - grey mullet in loose shoals over the shallow sand
//   - a hunting group of amberjack, faster, wider-ranging, past the shelf's edge
//   - green turtles grazing the eelgrass meadows, each rising to breathe every few minutes
//   - red stingrays gliding over the bare sand a hand's breadth up
//   - Naruto eagle rays flying in a line in mid-water, flapping and gliding
//   - a pod of bottlenose dolphins round the island offshore, surfacing to breathe in pairs
//   - one whale shark on a wide loop past the shelf, near the surface
//   - moon jellies drifting in loose swarms in the upper water, their bells pulsing
//   - round the reef stones: clouds of pearl-spot chromis hovering over them, pairs of oriental
//     butterflyfish close along their feet, a few barred knifejaw ranging a little wider
//
// Where: every kind's homes are cells of a world-anchored grid whose jittered point lies in its
// habitat (SeaHabitat.ts candidates), or the reef's stones, taken in a hash's order and kept apart; its numbers scale
// with the coast's length, the meadows' or the shelf's area. A group swims a closed route through
// its habitat round its home (SwimPath.ts `around`); the offshore kinds, a ring round the island
// past its outline (`ring`). All of it is a function of the land and fixed seeds.
//
// How they move: as a function of the scene clock, with nothing integrated. A group's place on its
// route is its speed times the time; each member keeps its place in the group's formation (along,
// across and above the route), wandering about it in slow sines, and follows the route's bends,
// so a long school curves with it. Breathing (the dolphins', the turtles') is a periodic rise to
// the surface; an eagle ray's glides, a periodic easing of its flaps. The heading and the pitch
// follow the motion's direction a moment before (a finite difference of the same function), the
// bank and the body's bend the route's curvature (the bend is the arc's own: curvature times the
// length squared, over two). The stroke's phase is its frequency times the time. So a paused frame,
// a scene jump and a fresh load all draw the same thing, and a Grow (`setWorld`) lays the groups
// out again from the new land, as a fresh load does: nothing has history (the test mode needs
// nothing of them, docs/reference/test-mode.md).
//
// Drawn as one instanced mesh per kind (Swimmers.ts), swimmers in the opaque pass (Refraction.ts
// markSwimmer), moved to where the eye sees them through the waves (Water.ts swimmerSway).

const TAU = Math.PI * 2;
// the finite difference's step (s) for the heading and the pitch
const STEP = 0.2;

type Range = readonly [ number, number ];

interface Member {
	// the place in the formation (m: along the route, across it to the right, above it)
	a: number; b: number; c: number;
	// the wander's amplitudes (m), its angular frequency (rad/s) and phases
	wa: number; wb: number; wc: number; wf: number; pa: number; pb: number; pc: number;
	scale: number; freq: number; phase: number;
	// the breath's or glide's period (s) and offset (s)
	period: number; offset: number;
}

// a group's home: a point, and the stone when it is a reef
interface Home { x: number; z: number; rock?: Rock }

interface Group { kind: Kind; path: SwimPath; speed: number; s0: number; members: Member[] }

interface Kind {
	name: string;
	motion: Motion; anatomy?: Anatomy; paint: Painter; geometry: () => THREE.BufferGeometry;
	// the most instances, and how many groups of how many members the habitat holds
	capacity: number;
	groups: ( H: SeaHabitat ) => number;
	members: Range;
	// the instance's scale (the total length; a ray's disc width; a turtle's length over its
	// carapace's share), the cruising speed (m/s), the stroke's frequency (Hz) and amplitude, the
	// paired fins' fold (0 spread .. 1 folded)
	scale: Range; speed: Range; freq: Range; amp: number; fold: number;
	// the gap kept above the floor and the least depth (m), the most pitch (rad), the bank per
	// unit of curvature times speed squared over g (a coordinated turn's), the flanks' rolling wave
	clear: number; ceiling: number; pitch: number; bank: number; flash?: number;
	// the formation of member k of n, and the wander's amplitudes (m) and period (s)
	formation: ( rng: Rng, k: number, n: number ) => { a: number; b: number; c: number; offset?: number };
	wander: readonly [ number, number, number ]; wanderPeriod: Range;
	// the period of a breath or a glide (s), if the kind has one
	period?: Range;
	// the route: the homes' cell (m) and spacing, and the habitats of the homes and the route
	// (a reef kind's homes are the reef stones, `reef`, in a hash's order, kept `apart`)
	home?: { cell: number; apart: number; fits: ( H: SeaHabitat ) => Fits } | { reef: true; apart: number };
	route: ( H: SeaHabitat, home: Home, rng: Rng ) => SwimPath | null;
	// the final height (m) at a point of the member's course, from the route's
	height?: ( y: number, t: number, m: Member, x: number, z: number, H: SeaHabitat ) => number;
	// the stroke's amplitude at a time (an eagle ray's glides)
	ampAt?: ( t: number, m: Member ) => number;
	// the shadow it casts on the floor (render/lighting/SwimmerShadows.ts): a capsule along the
	// body or across the span (a ray's wings), its half-length and radius in units of the scale
	shadow?: { across: boolean; half: number; radius: number };
}

const between = ( rng: Rng, r: Range ) => r[ 0 ] + ( r[ 1 ] - r[ 0 ] ) * rng();
const clamp = ( x: number, a: number, b: number ) => Math.min( b, Math.max( a, x ) );
// a reef kind's groups: one per `per` reef stones, at least one where there is a reef, at most `most`
const reefGroups = ( H: SeaHabitat, per: number, most: number ) => H.reefs.length ? clamp( Math.round( H.reefs.length / per ), 1, most ) : 0;
const smooth = ( a: number, b: number, x: number ) => {

	const t = clamp( ( x - a ) / ( b - a ), 0, 1 );
	return t * t * ( 3 - 2 * t );

};
// a point inside the ellipsoid of half-axes ( ra, rb, rc ), denser toward the centre
const inEllipsoid = ( rng: Rng, ra: number, rb: number, rc: number ) => {

	for ( ;; ) {

		const a = rng() * 2 - 1, b = rng() * 2 - 1, c = rng() * 2 - 1;
		const r = a * a + b * b + c * c;
		if ( r <= 1 && rng() > r * 0.45 ) return { a: a * ra, b: b * rb, c: c * rc };

	}

};
// a periodic rise: 0 most of the period, easing up to 1 over `rise` of the `window` seconds that
// end each period, held, and easing back down
const breath = ( t: number, period: number, offset: number, window: number, rise: number ) => {

	const tau = ( ( ( t + offset ) % period ) + period ) % period - ( period - window );
	if ( tau <= 0 ) return 0;
	const f = tau / window;
	return smooth( 0, rise, f ) * ( 1 - smooth( 1 - rise, 1, f ) );

};

// the homes of a kind: cells whose point lies in its habitat, kept `apart`, each with its own
// stream; the route from each until `count` are made
function homeRoutes( H: SeaHabitat, K: Kind, salt: number, count: number ): { path: SwimPath; rng: Rng }[] {

	const out: { path: SwimPath; rng: Rng }[] = [];
	if ( count <= 0 || ! K.home ) return out;
	const cands: ( Home & { seed: number } )[] = 'reef' in K.home
		? H.reefs.map( ( rock ) => ( { x: rock.x, z: rock.z, rock, seed: Math.floor( hash3i( Math.round( rock.x * 16 ), Math.round( rock.z * 16 ), salt ) * 4294967296 ) } ) ).sort( ( a, b ) => a.seed - b.seed )
		: H.candidates( K.home.cell, salt, K.home.fits( H ) );
	const taken: { x: number; z: number }[] = [];
	for ( const c of cands ) {

		if ( out.length >= count ) break;
		if ( taken.some( ( o ) => Math.hypot( o.x - c.x, o.z - c.z ) < K.home!.apart ) ) continue;
		const rng = mulberry32( c.seed ^ 0x51ea );
		const path = K.route( H, c, rng );
		if ( ! path ) continue;
		taken.push( c );
		out.push( { path, rng } );

	}
	return out;

}

// ------------------------------------------------------------------ the kinds

function kinds(): Kind[] {

	// the distance from the coast between `near` and `far` (m), the floor deeper than `deeper`; the
	// shore's field reads LAND_REACH (24 m) or more past its bounds, so `far` under it keeps a kind
	// over the shelf round the island
	const band = ( H: SeaHabitat, near: number, far: number, deeper = 0 ): Fits => ( x, z ) => {

		const d = H.coast( x, z );
		return d >= near && d <= far && H.floor( x, z ) <= deeper;

	};
	return [
		{
			name: 'sardines', motion: 'fish', anatomy: SP.SARDINE, paint: fishSkin( SP.SARDINE_SKIN ), geometry: () => fishGeometry( SP.SARDINE, 2 ),
			capacity: 3 * 400, groups: ( H ) => clamp( Math.round( H.coastLength / 140 ), 1, 3 ), members: [ 220, 400 ],
			scale: [ 0.15, 0.2 ], speed: [ 0.4, 0.55 ], freq: [ 4, 5.5 ], amp: 0.09, fold: 0.75,
			clear: 0.6, ceiling: - 0.6, pitch: 0.35, bank: 0.6, flash: 0.45,
			formation: ( rng, _k, n ) => {

				const s = Math.cbrt( n / 300 );
				return inEllipsoid( rng, 2.2 * s, 1.1 * s, 0.55 * s );

			},
			wander: [ 0.15, 0.1, 0.06 ], wanderPeriod: [ 4, 8 ],
			home: { cell: 8, apart: 30, fits: ( H ) => band( H, 10, 20, - 5.5 ) },
			route: ( H, home, rng ) => SwimPath.around( home, rng, { points: 6, radius: [ 8, 16 ], margin: 3.5, height: ( x, z ) => clamp( H.floor( x, z ) * 0.4, - 3.2, - 1.4 ) }, band( H, 6, 23, - 4 ) ),
		},
		{
			name: 'mullet', motion: 'fish', anatomy: SP.MULLET, paint: fishSkin( SP.MULLET_SKIN ), geometry: () => fishGeometry( SP.MULLET, 1 ),
			capacity: 4 * 45, groups: ( H ) => clamp( Math.round( H.coastLength / 90 ), 2, 4 ), members: [ 20, 45 ],
			scale: [ 0.35, 0.5 ], speed: [ 0.5, 0.7 ], freq: [ 2.6, 3.4 ], amp: 0.085, fold: 0.7,
			clear: 0.35, ceiling: - 0.45, pitch: 0.3, bank: 0.5,
			formation: ( rng, _k, n ) => inEllipsoid( rng, 2.6 * Math.sqrt( n / 30 ), 1.8 * Math.sqrt( n / 30 ), 0.35 ),
			wander: [ 0.6, 0.5, 0.12 ], wanderPeriod: [ 5, 10 ],
			home: { cell: 6, apart: 18, fits: ( H ) => ( x, z ) => band( H, 2, 8, - 1.8 )( x, z ) && H.floor( x, z ) >= - 4.5 && H.grass( x, z ) < 0.3 },
			route: ( H, home, rng ) => SwimPath.around( home, rng, { points: 5, radius: [ 4, 9 ], margin: 1.5, height: ( x, z ) => H.floor( x, z ) + 0.7 }, ( x, z ) => band( H, 1.2, 14, - 1.6 )( x, z ) && H.floor( x, z ) >= - 6 ),
		},
		{
			name: 'amberjack', motion: 'fish', anatomy: SP.AMBERJACK, paint: fishSkin( SP.AMBERJACK_SKIN ), geometry: () => fishGeometry( SP.AMBERJACK, 0 ),
			shadow: { across: false, half: 0.36, radius: 0.07 },
			capacity: 14, groups: () => 1, members: [ 8, 14 ],
			scale: [ 0.8, 1.1 ], speed: [ 1.0, 1.3 ], freq: [ 2.2, 2.8 ], amp: 0.08, fold: 0.8,
			clear: 0.8, ceiling: - 0.9, pitch: 0.3, bank: 0.5,
			formation: ( rng ) => inEllipsoid( rng, 3, 2.2, 0.8 ),
			wander: [ 0.8, 0.6, 0.2 ], wanderPeriod: [ 4, 7 ],
			home: { cell: 8, apart: 60, fits: ( H ) => band( H, 14, 22, - 7 ) },
			route: ( H, home, rng ) => SwimPath.around( home, rng, { points: 6, radius: [ 12, 22 ], margin: 3, height: ( x, z ) => clamp( H.floor( x, z ) * 0.5, - 4.5, - 2.2 ) }, band( H, 8, 23.5, - 4.5 ) ),
		},
		{
			name: 'green turtles', motion: 'turtle', paint: turtleSkin( SP.TURTLE_SKIN ), geometry: () => turtleGeometry( 0 ),
			shadow: { across: false, half: 0.22, radius: 0.3 },
			capacity: 4, groups: ( H ) => H.meadowArea < 30 ? 0 : clamp( Math.round( H.meadowArea / 350 ), 1, 4 ), members: [ 1, 1 ],
			// the carapace 0.8 to 1.05 m (the model's carapace is 0.72 of its length)
			scale: [ 0.8 / 0.72, 1.05 / 0.72 ], speed: [ 0.25, 0.4 ], freq: [ 0.28, 0.36 ], amp: 1, fold: 0,
			clear: 0.3, ceiling: - 0.12, pitch: 0.6, bank: 0.4,
			formation: () => ( { a: 0, b: 0, c: 0 } ),
			wander: [ 0.3, 0.4, 0.1 ], wanderPeriod: [ 8, 14 ],
			// a breath every 2 to 4 minutes, some 40 s up and back
			period: [ 120, 240 ],
			home: { cell: 6, apart: 14, fits: ( H ) => ( x, z ) => band( H, 6, 18, - 2.5 )( x, z ) && H.grass( x, z ) >= 0.45 },
			route: ( H, home, rng ) => SwimPath.around( home, rng, { points: 5, radius: [ 5, 10 ], margin: 1.2, height: ( x, z ) => H.floor( x, z ) + 0.45 }, band( H, 3, 23, - 1.8 ) ),
			height: ( y, t, m ) => y + ( - 0.12 * m.scale - y ) * breath( t, m.period, m.offset, 40, 0.38 ),
		},
		{
			name: 'red stingrays', motion: 'stingray', paint: raySkin( SP.STINGRAY_SKIN ), geometry: () => rayGeometry( false, 0 ),
			shadow: { across: false, half: 0.08, radius: 0.45 },
			capacity: 5, groups: ( H ) => clamp( Math.round( H.shelfArea / 900 ), 2, 5 ), members: [ 1, 1 ],
			scale: [ 0.6, 0.9 ], speed: [ 0.2, 0.32 ], freq: [ 0.8, 1.1 ], amp: 0.05, fold: 0,
			clear: 0.12, ceiling: - 0.8, pitch: 0.15, bank: 0.3,
			formation: () => ( { a: 0, b: 0, c: 0 } ),
			wander: [ 0.3, 0.3, 0.03 ], wanderPeriod: [ 8, 14 ],
			home: { cell: 6, apart: 12, fits: ( H ) => ( x, z ) => band( H, 3, 10, - 1.8 )( x, z ) && H.floor( x, z ) >= - 5.5 && H.grass( x, z ) < 0.15 },
			route: ( H, home, rng ) => SwimPath.around( home, rng, { points: 5, radius: [ 4, 9 ], margin: 1, height: ( x, z ) => H.floor( x, z ) + 0.18 }, ( x, z ) => band( H, 1.5, 16, - 1.5 )( x, z ) && H.floor( x, z ) >= - 7 ),
		},
		{
			name: 'eagle rays', motion: 'eagleRay', paint: raySkin( SP.EAGLE_RAY_SKIN ), geometry: () => rayGeometry( true, 0 ),
			shadow: { across: true, half: 0.3, radius: 0.16 },
			capacity: 2 * 6, groups: ( H ) => clamp( Math.round( H.coastLength / 220 ), 1, 2 ), members: [ 3, 6 ],
			scale: [ 1.2, 1.6 ], speed: [ 0.7, 0.9 ], freq: [ 0.38, 0.45 ], amp: 0.16, fold: 0,
			clear: 0.8, ceiling: - 0.9, pitch: 0.25, bank: 0.7,
			// in a line, each a little to the side of the one ahead, its flaps a beat behind
			formation: ( rng, k ) => ( { a: - k * 2.4 + ( rng() - 0.5 ) * 0.4, b: ( k % 2 ? 1 : - 1 ) * 0.4 * Math.min( k, 1 ) + ( rng() - 0.5 ) * 0.3, c: ( rng() - 0.5 ) * 0.3, offset: - k * 0.6 } ),
			wander: [ 0.15, 0.2, 0.1 ], wanderPeriod: [ 9, 14 ],
			// a glide every 8 to 12 s
			period: [ 8, 12 ],
			home: { cell: 8, apart: 40, fits: ( H ) => band( H, 8, 20, - 4 ) },
			route: ( H, home, rng ) => SwimPath.around( home, rng, { points: 6, radius: [ 10, 18 ], margin: 2, height: ( x, z ) => Math.max( H.floor( x, z ) + 1.4, - 2.4 ) }, band( H, 5, 23.5, - 3 ) ),
			ampAt: ( t, m ) => 0.3 + 0.7 * ( 1 - breath( t, m.period, m.offset, m.period * 0.45, 0.3 ) ),
		},
		{
			name: 'dolphins', motion: 'cetacean', anatomy: SP.DOLPHIN, paint: fishSkin( SP.DOLPHIN_SKIN ), geometry: () => fishGeometry( SP.DOLPHIN, 0 ),
			shadow: { across: false, half: 0.36, radius: 0.09 },
			capacity: 9, groups: () => 1, members: [ 6, 9 ],
			scale: [ 2.2, 2.6 ], speed: [ 2.2, 2.6 ], freq: [ 1.1, 1.4 ], amp: 0.075, fold: 0,
			clear: 1, ceiling: - 0.05, pitch: 0.45, bank: 0.5,
			// in pairs, each pair breathing together
			formation: ( rng, k ) => {

				const pair = k >> 1, r = mulberry32( 0xd0 + pair );
				const a = ( r() - 0.6 ) * 12, b = ( r() - 0.5 ) * 8;
				return { a: a + ( k & 1 ) * 0.5 + ( rng() - 0.5 ) * 0.2, b: b + ( k & 1 ) * 1.1, c: ( rng() - 0.5 ) * 0.3, offset: r() * 20 };

			},
			wander: [ 0.8, 0.6, 0.15 ], wanderPeriod: [ 6, 11 ],
			// a breath every 8 to 20 s (the pair's), 2.6 s from the dive to the dive
			period: [ 8, 20 ],
			route: ( H, _home, rng ) => SwimPath.ring( H.centre, ( x, z ) => H.coast( x, z ) < 0, rng, { points: 8, off: [ 16, 26 ], margin: 4, height: () => - 1.5 }, band( H, 14, Infinity, - 8 ) ),
			height: ( y, t, m ) => y + ( - 0.05 - y ) * breath( t, m.period, m.offset, 2.6, 0.5 ),
		},
		{
			name: 'whale shark', motion: 'fish', anatomy: SP.WHALE_SHARK, paint: fishSkin( SP.WHALE_SHARK_SKIN ), geometry: () => fishGeometry( SP.WHALE_SHARK, 0 ),
			shadow: { across: false, half: 0.36, radius: 0.085 },
			capacity: 1, groups: () => 1, members: [ 1, 1 ],
			scale: [ 7, 8 ], speed: [ 0.8, 1.0 ], freq: [ 0.25, 0.3 ], amp: 0.06, fold: 0,
			clear: 1.5, ceiling: - 1.2, pitch: 0.15, bank: 0.3,
			formation: () => ( { a: 0, b: 0, c: 0 } ),
			wander: [ 0, 0.8, 0.25 ], wanderPeriod: [ 18, 26 ],
			route: ( H, _home, rng ) => SwimPath.ring( H.centre, ( x, z ) => H.coast( x, z ) < 0, rng, { points: 8, off: [ 28, 42 ], margin: 6, height: ( _x, _z, r ) => - 1.8 - r() * 0.5 }, band( H, 20, Infinity, - 8.8 ) ),
		},
		{
			// drifting in loose swarms in the upper water over the shelf's edge, each bell pulsing
			// about once a second; the bell's diameter 15 to 30 cm
			name: 'moon jellies', motion: 'jelly', paint: jellySkin( SP.JELLY_SKIN ), geometry: jellyGeometry,
			capacity: 4 * 30, groups: ( H ) => clamp( Math.round( H.coastLength / 120 ), 1, 4 ), members: [ 12, 30 ],
			scale: [ 0.15, 0.3 ], speed: [ 0.03, 0.06 ], freq: [ 0.6, 0.9 ], amp: 1, fold: 0,
			clear: 0.8, ceiling: - 0.5, pitch: 0, bank: 0,
			formation: ( rng, _k, n ) => inEllipsoid( rng, 3 * Math.sqrt( n / 20 ), 3 * Math.sqrt( n / 20 ), 0.9 ),
			wander: [ 0.4, 0.4, 0.35 ], wanderPeriod: [ 10, 20 ],
			home: { cell: 10, apart: 25, fits: ( H ) => band( H, 8, 22, - 3 ) },
			route: ( H, home, rng ) => SwimPath.around( home, rng, { points: 5, radius: [ 3, 6 ], margin: 3, height: ( x, z ) => clamp( H.floor( x, z ) * 0.4, - 3, - 1.2 ) }, band( H, 5, 23.5, - 2.5 ) ),
		},
		// the reef's fish, round the reef stones (SeaHabitat.ts `reefs`): their numbers follow the
		// stones'; a stone's footprint reaches about 1.2 times its size from its centre
		{
			name: 'chromis', motion: 'fish', anatomy: SP.CHROMIS, paint: fishSkin( SP.CHROMIS_SKIN ), geometry: () => fishGeometry( SP.CHROMIS, 2 ),
			capacity: 8 * 50, groups: ( H ) => reefGroups( H, 5, 8 ), members: [ 20, 50 ],
			scale: [ 0.1, 0.15 ], speed: [ 0.1, 0.16 ], freq: [ 4.5, 6.5 ], amp: 0.08, fold: 0.4,
			clear: 0.5, ceiling: - 0.6, pitch: 0.3, bank: 0.4,
			// a loose cloud over the stone, each fish hovering and darting about its place
			formation: ( rng, _k, n ) => {

				const s = Math.sqrt( n / 30 );
				return inEllipsoid( rng, 1.1 * s, 0.9 * s, 0.45 * s );

			},
			wander: [ 0.35, 0.35, 0.2 ], wanderPeriod: [ 3, 6 ],
			home: { reef: true, apart: 4 },
			route: ( H, home, rng ) => {

				const r = home.rock!, top = r.y + r.sy;
				return SwimPath.around( home, rng, { points: 5, radius: [ r.s * 0.4, r.s * 0.4 + 1.2 ], margin: 0.5, height: ( _x, _z, q ) => Math.min( top + 0.5 + q() * 0.6, - 0.7 ) }, ( x, z ) => H.floor( x, z ) < - 1.2 );

			},
		},
		{
			name: 'butterflyfish', motion: 'fish', anatomy: SP.BUTTERFLYFISH, paint: fishSkin( SP.BUTTERFLYFISH_SKIN ), geometry: () => fishGeometry( SP.BUTTERFLYFISH, 1 ),
			capacity: 6 * 2, groups: ( H ) => reefGroups( H, 8, 6 ), members: [ 2, 2 ],
			scale: [ 0.14, 0.2 ], speed: [ 0.15, 0.25 ], freq: [ 3, 4.5 ], amp: 0.06, fold: 0.3,
			clear: 0.35, ceiling: - 0.6, pitch: 0.4, bank: 0.4,
			// a pair, side by side, one a little behind
			formation: ( rng, k ) => ( { a: - k * 0.3 + ( rng() - 0.5 ) * 0.1, b: k * 0.25, c: ( rng() - 0.5 ) * 0.1 } ),
			wander: [ 0.3, 0.3, 0.15 ], wanderPeriod: [ 4, 8 ],
			home: { reef: true, apart: 6 },
			route: ( H, home, rng ) => {

				const r = home.rock!, foot = r.s * 1.25;
				return SwimPath.around( home, rng, { points: 6, radius: [ foot + 0.4, foot + 2.5 ], margin: 0.4, height: ( x, z, q ) => H.floor( x, z ) + 0.5 + q() * 0.4 }, ( x, z ) => H.offReef( x, z, 0.35 ) && H.floor( x, z ) < - 1 );

			},
		},
		{
			name: 'knifejaw', motion: 'fish', anatomy: SP.KNIFEJAW, paint: fishSkin( SP.KNIFEJAW_SKIN ), geometry: () => fishGeometry( SP.KNIFEJAW, 1 ),
			capacity: 4 * 3, groups: ( H ) => reefGroups( H, 12, 4 ), members: [ 1, 3 ],
			scale: [ 0.3, 0.5 ], speed: [ 0.3, 0.45 ], freq: [ 2.4, 3.2 ], amp: 0.07, fold: 0.5,
			clear: 0.5, ceiling: - 0.8, pitch: 0.35, bank: 0.45,
			formation: ( rng ) => inEllipsoid( rng, 1.2, 0.8, 0.3 ),
			wander: [ 0.5, 0.4, 0.2 ], wanderPeriod: [ 5, 9 ],
			home: { reef: true, apart: 10 },
			route: ( H, home, rng ) => {

				const r = home.rock!, foot = r.s * 1.25;
				return SwimPath.around( home, rng, { points: 6, radius: [ foot + 1, foot + 5 ], margin: 0.6, height: ( x, z, q ) => H.floor( x, z ) + 0.9 + q() * 0.5 }, ( x, z ) => H.offReef( x, z, 0.6 ) && H.floor( x, z ) < - 1.4 );

			},
		},
	];

}

// ------------------------------------------------------------------ the sea's life

const _q = new THREE.Quaternion(), _e = new THREE.Euler( 0, 0, 0, 'YXZ' );
// the least darkest share of a shadow worth a caster's place (render/lighting/SwimmerShadows.ts)
const SHADOW_LEAST = 0.15;

export class SeaLife {

	readonly group = new THREE.Group();
	private readonly kinds: Kind[];
	private readonly meshes: Swimmers[];
	private habitat: SeaHabitat;
	private groups: Group[] = [];
	private readonly at: PathPoint = { x: 0, z: 0, y: 0, hx: 0, hz: 1, curve: 0 };
	private readonly pose: Pose = { x: 0, y: 0, z: 0, scale: 1, qx: 0, qy: 0, qz: 0, qw: 1, phase: 0, amp: 0, bend: 0, fold: 0, px: 0, py: 0, pz: 0, pphase: 0 };

	private readonly shared: Shared;

	constructor( data: WorldData, shared: Shared, waveMaps: WaveMaps, fft: OceanFFT, time: number ) {

		this.group.name = 'sea life';
		this.shared = shared;
		this.kinds = kinds();
		const sway = ( p: THREE.Node<'vec3'> ) => swimmerSway( fft, p, shared.waterLevel );
		this.meshes = this.kinds.map( ( K ) => {

			const material = makeSwimmerMaterial( { name: K.name, motion: K.motion, paint: K.paint, anatomy: K.anatomy, shared, waveMaps, sway } );
			const s = new Swimmers( K.name, K.geometry(), material, K.capacity );
			this.group.add( s.mesh );
			return s;

		} );
		this.habitat = new SeaHabitat( data );
		this.layout();
		this.update( time, 0 );

	}

	/** The land changed (a Grow): the groups laid out again from it, as a fresh load would. */
	setWorld( data: WorldData ): void {

		this.habitat = new SeaHabitat( data );
		this.layout();

	}

	/** How many of each kind swim (the diagnostics). */
	counts(): Record<string, number> {

		const out: Record<string, number> = {};
		for ( const g of this.groups ) out[ g.kind.name ] = ( out[ g.kind.name ] ?? 0 ) + g.members.length;
		return out;

	}

	/** Writes every creature at scene time `time`; `dt` the clock's step since the last frame (0
	 * paused: the previous position is the current one). */
	update( time: number, dt: number ): void {

		for ( const m of this.meshes ) m.begin();
		const casters = this.casters;
		casters.length = 0;
		let n = 0;
		for ( const g of this.groups ) {

			const mesh = this.meshes[ this.kinds.indexOf( g.kind ) ];
			for ( const m of g.members ) {

				const P = this.write( g, m, time, dt );
				mesh.push( P );
				if ( g.kind.shadow ) this.caster( g.kind.shadow, P, n ++ );

			}

		}
		for ( const m of this.meshes ) m.end();
		// the shadows worth drawing: the strongest, a body near the floor before one high over it
		casters.sort( ( a, b ) => b.strength - a.strength || a.order - b.order );
		setSwimmerShadows( this.shared.swimmerShadows, casters.slice( 0, SWIMMER_SHADOWS ) );

	}

	private readonly casters: ( SwimmerCapsule & { strength: number; order: number } )[] = [];
	private readonly pool: ( SwimmerCapsule & { strength: number; order: number } )[] = [];
	private readonly _axis = new THREE.Vector3();

	// a swimmer's capsule (render/lighting/SwimmerShadows.ts), kept if its shadow's darkest share
	// reaches SHADOW_LEAST: a band 2r wide blurred over 2 forwardAngle times its height over the floor
	private caster( shadow: NonNullable<Kind[ 'shadow' ]>, P: Pose, order: number ): void {

		const r = shadow.radius * P.scale;
		const h = Math.max( P.y - this.habitat.floor( P.x, P.z ), 0 );
		const strength = Math.min( 1, 2 * r / Math.max( 2 * this.shared.forwardAngle.value * h, 0.02 ) );
		if ( strength < SHADOW_LEAST ) return;
		const axis = this._axis.set( shadow.across ? 1 : 0, 0, shadow.across ? 0 : 1 ).applyQuaternion( _q.set( P.qx, P.qy, P.qz, P.qw ) ).multiplyScalar( shadow.half * P.scale );
		const c = this.pool[ this.casters.length ] ?? ( this.pool[ this.casters.length ] = { ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, r: 0, strength: 0, order: 0 } );
		c.ax = P.x - axis.x; c.ay = P.y - axis.y; c.az = P.z - axis.z;
		c.bx = P.x + axis.x; c.by = P.y + axis.y; c.bz = P.z + axis.z;
		c.r = r; c.strength = strength; c.order = order;
		this.casters.push( c );

	}

	// ------------------------------------------------------------------ the layout

	private layout(): void {

		const H = this.habitat;
		this.groups = [];
		this.kinds.forEach( ( K, i ) => {

			const want = K.groups( H );
			const routes = K.home ? homeRoutes( H, K, 0x5e00 + i, want ) : this.rings( K, i, want );
			let room = K.capacity;
			for ( const { path, rng } of routes ) {

				const n = Math.min( room, Math.round( between( rng, [ K.members[ 0 ], K.members[ 1 ] + 0.49 ] ) ) );
				if ( n <= 0 ) break;
				room -= n;
				const members: Member[] = [];
				for ( let k = 0; k < n; k ++ ) {

					const f = K.formation( rng, k, n );
					const wf = TAU / between( rng, K.wanderPeriod );
					// (members given an offset share it, and their period with it: a pair breathes together)
					const period = ! K.period ? 1 : f.offset === undefined ? between( rng, K.period ) : between( mulberry32( Math.round( f.offset * 1e3 ) + i ), K.period );
					members.push( {
						a: f.a, b: f.b, c: f.c,
						wa: K.wander[ 0 ] * ( 0.5 + rng() ), wb: K.wander[ 1 ] * ( 0.5 + rng() ), wc: K.wander[ 2 ] * ( 0.5 + rng() ),
						wf, pa: rng() * TAU, pb: rng() * TAU, pc: rng() * TAU,
						scale: between( rng, K.scale ), freq: between( rng, K.freq ), phase: rng() * TAU,
						period, offset: f.offset ?? rng() * period,
					} );

				}
				this.groups.push( { kind: K, path, speed: between( rng, K.speed ), s0: rng() * path.length, members } );

			}

		} );

	}

	// the offshore kinds' rings round the island, a few tries each
	private rings( K: Kind, i: number, count: number ): { path: SwimPath; rng: Rng }[] {

		const out: { path: SwimPath; rng: Rng }[] = [];
		for ( let k = 0; k < count * 4 && out.length < count; k ++ ) {

			const rng = mulberry32( 0x0ff5 + i * 97 + k );
			const path = K.route( this.habitat, this.habitat.centre, rng );
			if ( path ) out.push( { path, rng } );

		}
		return out;

	}

	// ------------------------------------------------------------------ the motion

	// the member's place at time t, into `out`
	private where( g: Group, m: Member, t: number, out: { x: number; y: number; z: number } ): void {

		const K = g.kind, H = this.habitat, q = this.at;
		const w = m.wf * t;
		g.path.at( g.s0 + g.speed * t + m.a + m.wa * Math.sin( w + m.pa ), q );
		const b = m.b + m.wb * Math.sin( w * 0.83 + m.pb );
		const x = q.x - q.hz * b, z = q.z + q.hx * b;
		let y = q.y + m.c + m.wc * Math.sin( w * 1.27 + m.pc );
		// kept clear of the floor (a soft floor: it eases up over a rise) and under the surface
		const floor = H.floor( x, z ) + K.clear, d = y - floor, soft = 0.3;
		y = floor + ( d > soft * 6 ? d : soft * Math.log1p( Math.exp( d / soft ) ) );
		y = Math.min( y, K.ceiling );
		if ( K.height ) y = Math.max( K.height( y, t, m, x, z, H ), floor );
		out.x = x; out.y = y; out.z = z;

	}

	private readonly p0 = { x: 0, y: 0, z: 0 };
	private readonly p1 = { x: 0, y: 0, z: 0 };

	private write( g: Group, m: Member, t: number, dt: number ): Pose {

		const K = g.kind, P = this.pose, p0 = this.p0, p1 = this.p1;
		this.where( g, m, t, p0 );
		// the route's curvature where the member is (the last `where` left it in `at`)
		const curve = this.at.curve;
		this.where( g, m, t - STEP, p1 );
		const vx = p0.x - p1.x, vy = p0.y - p1.y, vz = p0.z - p1.z;
		const vh = Math.hypot( vx, vz ) + 1e-9;
		const yaw = Math.atan2( vx, vz );
		const pitch = clamp( Math.atan2( vy, vh ), - K.pitch, K.pitch );
		const speed = vh / STEP;
		// a coordinated turn's bank: tan( bank ) = v^2 kappa / g, scaled per kind (left turns bank
		// left, a negative roll about the forward axis)
		let roll = - Math.atan( speed * speed * curve / 9.81 ) * K.bank * 4;
		if ( K.flash ) roll += K.flash * Math.sin( t * 1.6 - m.a * 1.3 + m.b * 0.4 );
		roll = clamp( roll, - 0.7, 0.7 );
		_e.set( - pitch, yaw, roll );
		_q.setFromEuler( _e );
		P.x = p0.x; P.y = p0.y; P.z = p0.z; P.scale = m.scale;
		P.qx = _q.x; P.qy = _q.y; P.qz = _q.z; P.qw = _q.w;
		// the body bends along the arc it swims (model units: the curvature times the length over
		// two, the tail toward the outside of the turn)
		P.bend = clamp( - curve * m.scale / 2, - 0.3, 0.3 );
		P.amp = K.amp * ( K.ampAt ? K.ampAt( t, m ) : 1 );
		P.fold = K.fold;
		P.phase = ( m.phase + TAU * m.freq * t ) % TAU;
		P.pphase = ( m.phase + TAU * m.freq * ( t - dt ) ) % TAU;
		if ( dt > 0 ) {

			this.where( g, m, t - dt, p1 );
			P.px = p1.x; P.py = p1.y; P.pz = p1.z;

		} else {

			P.px = p0.x; P.py = p0.y; P.pz = p0.z;

		}
		return P;

	}

}
