import * as THREE from 'three/webgpu';
import { abs, clamp, cos, exp, float, max, smoothstep } from 'three/tsl';
import { debugFlags, type DisplacementField } from '../../render/index.ts';

// The islanders' trail through the meadow, drawn as sprites into the displacement field.
//
// The islanders' trail through the meadow: a walker lays the blades in its way over forward and
// out, the middle of its way the deepest and nearly straight ahead, those to either side the more
// to the side the farther out (a chevron); once it has gone on, a blade lies a moment, springs up
// nearly upright, is pressed down again by about a quarter and again by less, so two or three
// bands of pressed grass follow some three metres apart behind a walking islander, and the trail
// is gone in about six seconds. Trample draws that as sprites into the displacement field
// (Displacement.ts), which the blades read (Grass.ts).
//
// Rules:
// - The trail is a function of where the walkers were, never a field that accumulates frames: each
//   frame every walker is asked for its ground track at TRAMPLE.samples ages (`TrampleWalker.track`),
//   now and at whole steps of its own clock (`TrampleWalker.clock`) back to the trail's end, and the
//   sprites are drawn along that polyline. Pinned to the clock's steps, the older samples stay where
//   they are from frame to frame and only the newest stretch follows the walker: taken at fixed ages
//   instead, every sample slid along the way each frame, and on a bend the chords swept the blades
//   near the middle from one side to the other several times a second. The art-review islander's
//   track is its walking schedule at the scene clock's earlier times (characters/Villagers.ts), so a
//   paused frame, a scene jump and a grown island's page draw the trail a fresh load of the same
//   query draws, with nothing to clear or freeze in the test mode. The game's islanders keep the
//   positions their views have shown since they appeared, by the game's clock
//   (game/view/VillagerView.ts): a paused game holds its trails, and a new view (a game started or
//   loaded) starts with none.
// - The way: a strip sprite along each stretch of track between two samples, its axis toward the
//   walker, of the trail's cross-section and chevron (Displacement.ts `trailPush`) out to
//   TRAMPLE.reach either side; a half disc ahead of the newest sample closes it, of the same
//   section and the same directions where it meets the strip, turning straight ahead in front.
//   Each strip covers only the band between its own two ends: overlapping at the samples they
//   share, the pushes there would add up to twice one push. The oldest end needs no closing, the
//   trail being gone there. A sample closer than STRETCH to the one kept before it joins that one
//   and takes the older age, the time since the walker came there: a standing walker's samples, all
//   at its feet, make one point as old as its stop, so the trail behind it goes as it would had it
//   walked on, and its feet keep no push of the way.
// - Standing: a disc at the feet pushes the grass about them out a little (TRAMPLE.stand: `share`
//   of the way's push, Displacement.ts `standPush`), the more the slower the walker over the last
//   step of its clock, none once it walks at `speed` m/s; it does not age.
// - What a blade keeps of a push is a share of its lean, the tangent of the angle a full push lays
//   the reference blade (Displacement.ts RESPONSE) over by (TRAMPLE.angle): the trail's curve at
//   the sprite's age (`trailCurve`), along a strip by the age interpolated from one end's to the
//   other's. The curve is a rectified damped oscillation, e^( -t / tau ) | cos( pi t / P ) | from
//   the deepest press on, after an onset that presses the blades from a quarter to full over
//   TRAMPLE.onset s (without it the grass just ahead of a walker would lie down at once, as before
//   an invisible board). Linear in the lean, a long blade lies flat through the first lobe, springs
//   up quickly and is pressed down again: the rise and fall the bands are made of. Rectified, it
//   never changes sign, so a blade never swings over to the other side of upright.
// - Order: the walkers nearest the camera's point of interest (at most TRAMPLE.walkers, more than
//   the island's population at its largest), by distance then by their index, each one's strips
//   from the newest stretch to the oldest, then its half disc and its disc: a fixed order, so the
//   field's sums repeat from frame to frame. Sprites whose push is 0 (past the trail's end, or the
//   disc of a walker on its way) are left out.
// - `debugFlags.trample = false` at load builds no field (Displacement.ts `displacementField` null,
//   the blades reading none); set at run time it empties the walkers (profile-frame's --toggle).

type F = THREE.Node<'float'>;

const DEG = Math.PI / 180;

/** The trail's numbers: the walkers drawn at most and the samples of each one's track, their spacing
 * (s: the track reaches back ( samples - 1 ) * step at most); how far either side of the way a
 * walker reaches the grass (m, the sprites' half width: Displacement.ts `trailPush` is 0 there);
 * the angle (rad) a full push lays the reference blade over by; the onset (s) over which the push
 * rises from `start` of it at the feet to all of it (eased out); the curve's time constant `decay`
 * (s) and its lobes' period (s: the first lobe gone about 0.85 s after the deepest press, the
 * second press about 0.25 of the first at 1.5 s); and the standing push (`share` of the way's
 * push at a standstill, gone by `speed` m/s, out to `radius` m). */
export const TRAMPLE = {
	walkers: 80, samples: 27, step: 0.25, reach: 1.5, angle: 73 * DEG,
	onset: { time: 0.3, start: 0.25 }, decay: 1.1, period: 1.65,
	stand: { share: 0.1, speed: 0.3, radius: 1 },
} as const;

// The age at which the trail ends: the oldest sample's age lies between this and a step more, and
// the push is gone there (eased out over the last half second), so a sample dropped at a step of
// the clock takes nothing with it.
const END = ( TRAMPLE.samples - 2 ) * TRAMPLE.step;
const FADE = 0.5;

// A sample closer than this (m) to the one kept before it joins that one: the newest stretch is
// shorter just after a step of the walker's clock, and a standing walker's have no length.
const STRETCH = 0.03;

// the field's sprite shapes (Displacement.ts SPRITE, repeated: this module imports only its types,
// so the two never load each other)
const STRIP = 0, AHEAD = 1, DISC = 2;

/** Something that parts the meadow: its clock (s) now, by which it moves, and its feet's ground
 * track (world x, z) `age` seconds of that clock ago, into `out`. */
export interface TrampleWalker {
	clock(): number;
	track( age: number, out: THREE.Vector2 ): void;
}

/** The share of a full push's lean the trail keeps `age` seconds after the walker's feet were there
 * (TRAMPLE): the onset's ease from `start` to 1, then e^( -t / decay ) | cos( pi t / period ) |
 * at t = age - onset, eased to 0 over the trail's last FADE seconds. */
export function trailCurve( age: F ): F {

	const { onset, decay, period } = TRAMPLE;
	const x = clamp( age.div( onset.time ), 0, 1 );
	const rise = x.mul( float( 2 ).sub( x ) ).mul( 1 - onset.start ).add( onset.start );
	const t = max( age.sub( onset.time ), 0 );
	const lobes = abs( cos( t.mul( Math.PI / period ) ) );
	return rise.mul( exp( t.div( decay ).negate() ) ).mul( lobes ).mul( float( 1 ).sub( smoothstep( END - FADE, END, age ) ) );

}

const _p = new THREE.Vector2();

/** Draws the walkers' trails into the displacement field once per rendered frame, as the field's
 * source of sprites: it gives the field the trail's curve (`trailCurve`) when it is made. */
export class Trample {

	private readonly field: DisplacementField | null;
	private readonly order: { walker: TrampleWalker; d: number; i: number }[] = [];
	// one walker's track once the near samples have joined: ( x, z, age ) each
	private readonly points = new Float32Array( TRAMPLE.samples * 3 );

	constructor( field: DisplacementField | null ) {

		this.field = field;
		field?.source( trailCurve );

	}

	/** The sprites of `walkers` (the TRAMPLE.walkers nearest `near` when there are more). */
	update( walkers: readonly TrampleWalker[], near: THREE.Vector3 ): void {

		const field = this.field;
		if ( ! field ) return;
		field.begin();
		const order = this.order;
		order.length = 0;
		if ( debugFlags.trample !== false ) walkers.forEach( ( walker, i ) => {

			walker.track( 0, _p );
			order.push( { walker, d: Math.hypot( _p.x - near.x, _p.y - near.z ), i } );

		} );
		if ( order.length > TRAMPLE.walkers ) order.sort( ( a, b ) => a.d - b.d || a.i - b.i );
		const count = Math.min( order.length, TRAMPLE.walkers );
		for ( let w = 0; w < count; w ++ ) this.walker( field, order[ w ].walker );
		field.end();

	}

	private walker( field: DisplacementField, walker: TrampleWalker ): void {

		const { reach, angle, step, stand } = TRAMPLE;
		const p = this.points;
		// now, then the whole steps of the walker's clock before it; a sample that joins the one
		// kept before it gives that one its older age
		const since = ( walker.clock() % step + step ) % step;
		let n = 0;
		for ( let s = 0; s < TRAMPLE.samples; s ++ ) {

			const age = s === 0 ? 0 : since + ( s - 1 ) * step;
			walker.track( age, _p );
			if ( n > 0 && Math.hypot( _p.x - p[ n * 3 - 3 ], _p.y - p[ n * 3 - 2 ] ) < STRETCH ) {

				p[ n * 3 - 1 ] = age;
				continue;

			}
			p[ n * 3 ] = _p.x;
			p[ n * 3 + 1 ] = _p.y;
			p[ n * 3 + 2 ] = age;
			n ++;

		}
		// the way: a strip per stretch, newest first, its axis from the older sample to the newer;
		// the way's direction (toward the walker) at the newest sample
		let fx = 1, fz = 0;
		for ( let k = 0; k + 1 < n; k ++ ) {

			const x1 = p[ k * 3 ], z1 = p[ k * 3 + 1 ], a1 = p[ k * 3 + 2 ];
			const x0 = p[ k * 3 + 3 ], z0 = p[ k * 3 + 4 ], a0 = p[ k * 3 + 5 ];
			const dx = ( x1 - x0 ) / 2, dz = ( z1 - z0 ) / 2, half = Math.hypot( dx, dz );
			if ( k === 0 ) {

				fx = dx / half;
				fz = dz / half;

			}
			if ( a1 < END ) field.sprite( ( x0 + x1 ) / 2, ( z0 + z1 ) / 2, dx, dz, reach, STRIP, a0, a1, angle, 1 );

		}
		// the half disc ahead of the newest sample
		if ( p[ 2 ] < END ) field.sprite( p[ 0 ], p[ 1 ], fx * reach, fz * reach, reach, AHEAD, p[ 2 ], p[ 2 ], angle, 1 );
		// standing: the walker's speed over the last step of its clock
		walker.track( step, _p );
		const speed = Math.hypot( _p.x - p[ 0 ], _p.y - p[ 1 ] ) / step;
		const share = stand.share * ( 1 - THREE.MathUtils.smoothstep( speed, 0, stand.speed ) );
		if ( share > 0 ) field.sprite( p[ 0 ], p[ 1 ], stand.radius, 0, stand.radius, DISC, 0, 0, angle, share );

	}

}
