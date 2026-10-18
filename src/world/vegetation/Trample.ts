import * as THREE from 'three/webgpu';
import { Fn, If, Loop, int, float, vec2, vec3, uniform, uniformArray, dot, max, clamp, mix, length, exp, smoothstep, atan, tan } from 'three/tsl';
import { pressedLean, pressedLoadRatio } from '../../weather/Wind.ts';
import { debugFlags } from '../../debug/DebugFlags.ts';

// The islanders' trail through the meadow: an islander is a load on the blades about it, as the
// wind is. Its legs push the blades out of their way and its feet press down those they stand on;
// the meadow's blades take that load with the wind's in their vertex stage (`trampleShare`, then
// Deform.ts `bendBlade`), so a pressed blade bends by the same elastica as under the wind. Once the
// islander has gone on, the blade rises back as a damped spring released, and a walker leaves a
// short wake of parted grass that closes a couple of seconds behind it.
//
// Rules:
// - The trail is a function of where the walkers were, never a field that accumulates frames: each
//   frame every walker is asked for its ground track at TRAMPLE.samples ages (`TrampleWalker.track`),
//   now and at whole steps of its own clock (`TrampleWalker.clock`) back to the trail's end, and the
//   blades read that polyline. Pinned to the clock's steps, the older samples stay where they are
//   from frame to frame and only the newest stretch follows the walker: taken at fixed ages instead,
//   every sample slid along the way each frame, and on a bend the chords swept the blades near the
//   middle from one side to the other several times a second. The art-review islander's track is
//   its walking schedule at the scene clock's earlier times (characters/Villagers.ts), so a paused
//   frame, a scene jump and a grown island's page draw the trail a fresh load of the same query
//   draws, with nothing to clear or freeze in the test mode. The game's islanders keep the
//   positions their views have shown since they appeared, by the game's clock
//   (game/view/VillagerView.ts): a paused game holds its trails, and a new view (a game started or
//   loaded) starts with none.
// - A blade reads each stretch of track (a capsule between two samples, its age interpolated along
//   it) at its own root: the legs push it straight away from the walker's way, full within
//   TRAMPLE.legs[ 0 ], none beyond legs[ 1 ], the push turning in over the feet's reach from the
//   middle of the way, where it has no side; the feet press it down within TRAMPLE.feet. Pushed
//   from several stretches, it goes the way of the strongest ones, weighted by the square of their
//   push: the push is never set to a full lean along a normalised direction, so where the pushes
//   from two sides cancel the blade is pushed less, not swung over. A standing walker's samples all
//   lie at its feet, the newest of age 0, so it pushes the grass about it for as long as it stands.
// - What a blade keeps of a push is its deflection, the angle the push laid it over by, which
//   returns as a released spring critically damped (`recovery`, time constant TRAMPLE.settle, eased
//   out to 0 by the trail's end), the same for long and short blades: a blade is pushed at once and
//   rises slowly (`trampleLoad`). Its lean (the angle's tangent) would not do: a 0.75 m blade's
//   full push leans it 14.5 (86 degrees over), and half that lean is still 82 degrees, so a long
//   blade would lie flat for most of its return. The deflection is turned back into the load that
//   holds it (Wind.ts `pressedLoadRatio`) and added to the wind's, so a blade the walker's legs
//   push across the wind leans over downwind as well, one pushed against the wind stands up a
//   little where the two cancel, and one held flat answers the wind's sway only by the elastica's
//   flat slope there. The feet's weight bends a blade further the way it faces (a vertical load
//   bends a strand further the way it leans), so the blades a walker stands on are trodden over
//   each its own way, as a tussock splays under a foot: along the sum of the wind and the push, the
//   weight flipped a blade over where a push against the wind cancelled it.
// - The load is the elastica's linear lean (Wind.ts `leanLoad`) at the reference blade's length
//   (Deform.ts GRASS_WIND.pressed.length) and scaled as the wind's by each blade's length cubed and
//   its tussock's rigidity: tall blades are laid flat and parted widely, the short turf leans.
//   The meadow's herbs take none (Grass.ts): pushed sideways, a plantain's leaf lying flat on the
//   ground swung up through the upright.
// - Cost: per vertex a loop over the walkers (`count`, the TRAMPLE.walkers nearest the camera) with
//   a test of its track's bounding circle at the tuft's origin (grown by TRAMPLE.spread); only the
//   vertices of the tufts inside one work out their blade's root and read the track's capsules.
//   `debugFlags.trample = false` leaves the trail out of the meadow's shader when set at load (the
//   shader of a page without it), and at run time empties the walkers (profile-frame's --toggle).
// - Under the temporal modes the blade's previous position takes the previous rendered frame's
//   trail (`previous`), kept as the wind's is: copied once per rendered frame, and made the current
//   one on a cut of the histories.

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

/** The trail's numbers: the walkers drawn at most and the samples of each one's track, their spacing
 * (s: the track reaches back ( samples - 1 ) * step at most), how far a meadow blade's root may
 * stand from its tuft's origin (m: 0.2 at the tuft's widest scale of 1.1, Grass.ts), the distance
 * of a blade's root from the walker's way (m) within which its legs push the blade fully and beyond
 * which they do not touch it (the long blades rooted that far out reach the legs: within 0.1 and
 * 0.38 m a standing islander's grass barely moved, hidden under its body from above), the same for
 * its feet's weight, the legs' push and the feet's weight as a load (the linear lean of the
 * reference blade: 5 lays a 0.45 m blade 83 degrees over, the reference's 0.28 m one 73, the short
 * turf's 0.2 m 56), and the time constant of a blade's return (s: half way up 1 s after the walker
 * has passed, at a tenth by 2.3 s, so the wake behind a walking islander is a metre or two long). */
export const TRAMPLE = { walkers: 16, samples: 13, step: 0.25, spread: 0.25, legs: [ 0.2, 0.55 ], feet: [ 0.08, 0.22 ], push: 5, weight: 5, settle: 0.6 } as const;

// The age at which the trail ends: the oldest sample's age lies between this and a step more, and
// the push is gone there, so a sample dropped at a step of the clock takes nothing with it.
const END = ( TRAMPLE.samples - 2 ) * TRAMPLE.step;

/** Something that parts the meadow: its clock (s) now, by which it moves, and its feet's ground
 * track (world x, z) `age` seconds of that clock ago, into `out`. */
export interface TrampleWalker {
	clock(): number;
	track( age: number, out: THREE.Vector2 ): void;
}

function trampleState() {

	// per walker: its track's bounding circle, grown by the reach and a tuft's spread, ( x, z, squared
	// radius, 0 ); and its track's samples, newest first, ( x, z, age, 0 ): the arrays the uniforms
	// read on every render
	const circles = Array.from( { length: TRAMPLE.walkers }, () => new THREE.Vector4() );
	const samples = Array.from( { length: TRAMPLE.walkers * TRAMPLE.samples }, () => new THREE.Vector4() );
	return {
		// the walkers in use
		count: uniform( 0, 'int' ),
		walkers: uniformArray<'vec4'>( circles, 'vec4' ),
		points: uniformArray<'vec4'>( samples, 'vec4' ),
		circles, samples,
	};

}

/** The trail as a frame draws it, its uniforms. */
export type TrampleState = ReturnType<typeof trampleState>;

/** Add this object to shared before the meadow's material is built, then give it to Trample: the
 * frame being rendered and the frame rendered before it (`previous`). */
export function createTrampleUniforms(): TrampleState & { previous: TrampleState } {

	return { ...trampleState(), previous: trampleState() };

}

/** The share of its deflection a blade keeps `age` seconds after a push: ( 1 + x ) e^-x at x = age /
 * TRAMPLE.settle, a released spring's return, critically damped, eased to 0 over the last quarter
 * of the trail. */
function recovery( age: F ): F {

	const x = age.div( TRAMPLE.settle );
	return x.add( 1 ).mul( exp( x.negate() ) ).mul( float( 1 ).sub( smoothstep( END * 0.75, END, age ) ) );

}

/** The trail on a blade rooted at `root()` (world x, z) in a tuft standing at `centre` (world x, z;
 * its blades' roots within TRAMPLE.spread of it): ( x, z ) the legs' push, a horizontal vector whose
 * length is the share of a full push the blade still keeps (0..1), and the feet's weight's share;
 * exactly 0 away from every walker (`trampleLoad` turns it into the blade's load). The walkers'
 * circles are tested at the tuft, and the root is built only for the tufts inside one: away from
 * the walkers a vertex pays for the tests alone. */
export function trampleShare( state: TrampleState, centre: V2, root: () => V2 ): V3 {

	const { samples, legs, feet } = TRAMPLE;
	// (in a function of its own: the loops and the branch need a stack to build into)
	return Fn( () => {

		const way = vec2( 0 ).toVar(), weights = float( 0 ).toVar(), side = float( 0 ).toVar(), down = float( 0 ).toVar();
		Loop( { start: int( 0 ), end: state.count, type: 'int', condition: '<' }, ( { i } ) => {

			const walker = state.walkers.element( i );
			const off = centre.sub( walker.xy );
			If( dot( off, off ).lessThan( walker.z ), () => {

				const at = root().toVar();
				// (its counter named apart from the walkers' loop's)
				const range = { start: int( 0 ), end: int( samples - 1 ), type: 'int' as const, condition: '<', name: 'j' };
				Loop( range, ( inputs ) => {

					const j = ( inputs as unknown as { j: THREE.Node<'int'> } ).j;
					const k = i.mul( int( samples ) ).add( j );
					// a capsule from the newer sample `a` to the older `b` (a standing walker's has no length:
					// its nearest point is then `a`, the newer)
					const a = state.points.element( k ), b = state.points.element( k.add( int( 1 ) ) );
					const run = a.xy.sub( b.xy ).toVar();
					const u = clamp( dot( a.xy.sub( at ), run ).div( max( dot( run, run ), 1e-8 ) ), 0, 1 );
					const away = at.sub( a.xy.sub( run.mul( u ) ) ).toVar();
					const d = length( away );
					const kept = recovery( mix( a.z, b.z, u ) ).toVar();
					// the legs' push, turning in from the middle of the way over the feet's reach, and the
					// feet's weight
					const push = float( 1 ).sub( smoothstep( legs[ 0 ], legs[ 1 ], d ) ).mul( smoothstep( 0, feet[ 1 ], d ) ).mul( kept );
					const weight = push.mul( push );
					way.addAssign( away.mul( weight.div( max( d, 1e-4 ) ) ) );
					weights.addAssign( weight );
					side.assign( max( side, push ) );
					down.assign( max( down, float( 1 ).sub( smoothstep( feet[ 0 ], feet[ 1 ], d ) ).mul( kept ) ) );

				} );

			} );

		} );
		return vec3( way.mul( side.div( max( weights, 1e-8 ) ) ), down );

	} )();

}

/** The trail's load on a blade (`trampleShare`'s `share`) whose own load scale is `scale` (its
 * length cubed and its rigidity, as `bendBlade` scales the wind's): the legs' push as a horizontal
 * load (world x, z) and the feet's weight's load, each the linear lean that holds the blade at the
 * share it keeps of the angle a full push lays it over by. */
export function trampleLoad( share: V3, scale: F ): { push: V2; weight: F } {

	// the angle a full push or weight lays the blade over by, and the lean (tangent) of a share of it
	const over = ( load: number ) => atan( pressedLean( scale.mul( load ) ) );
	const held = ( part: F, load: number ) => tan( part.mul( over( load ) ) );
	const kept = length( share.xy );
	const push = held( kept, TRAMPLE.push ).toVar(), weight = held( share.z, TRAMPLE.weight ).toVar();
	return {
		push: share.xy.mul( push.mul( pressedLoadRatio( push ) ).div( max( kept, 1e-6 ) ) ),
		weight: weight.mul( pressedLoadRatio( weight ) ),
	};

}

const _p = new THREE.Vector2();

/** Writes the walkers' tracks into the trail's uniforms once per rendered frame. */
export class Trample {

	private readonly uniforms: ReturnType<typeof createTrampleUniforms>;
	private readonly order: { walker: TrampleWalker; d: number; i: number }[] = [];

	constructor( uniforms: ReturnType<typeof createTrampleUniforms> ) {

		this.uniforms = uniforms;

	}

	/** The trail of `walkers` (the TRAMPLE.walkers nearest `near` when there are more), after the
	 * previous frame's has been kept. */
	update( walkers: readonly TrampleWalker[], near: THREE.Vector3 ): void {

		this.keepPrevious();
		const u = this.uniforms;
		const order = this.order;
		order.length = 0;
		if ( debugFlags.trample !== false ) walkers.forEach( ( walker, i ) => {

			walker.track( 0, _p );
			order.push( { walker, d: Math.hypot( _p.x - near.x, _p.y - near.z ), i } );

		} );
		if ( order.length > TRAMPLE.walkers ) order.sort( ( a, b ) => a.d - b.d || a.i - b.i );
		const count = Math.min( order.length, TRAMPLE.walkers );
		// (a tuft's blades reach the track from up to TRAMPLE.spread beyond the tuft's origin)
		const reach = TRAMPLE.legs[ 1 ] + TRAMPLE.spread, step = TRAMPLE.step;
		for ( let w = 0; w < count; w ++ ) {

			// now, then the whole steps of the walker's clock before it
			const walker = order[ w ].walker, since = ( walker.clock() % step + step ) % step;
			let x0 = Infinity, z0 = Infinity, x1 = - Infinity, z1 = - Infinity;
			for ( let s = 0; s < TRAMPLE.samples; s ++ ) {

				const age = s === 0 ? 0 : since + ( s - 1 ) * step;
				walker.track( age, _p );
				u.samples[ w * TRAMPLE.samples + s ].set( _p.x, _p.y, age, 0 );
				x0 = Math.min( x0, _p.x ); z0 = Math.min( z0, _p.y ); x1 = Math.max( x1, _p.x ); z1 = Math.max( z1, _p.y );

			}
			const radius = Math.hypot( x1 - x0, z1 - z0 ) / 2 + reach;
			u.circles[ w ].set( ( x0 + x1 ) / 2, ( z0 + z1 ) / 2, radius * radius, 0 );

		}
		u.count.value = count;

	}

	/** A cut of the temporal modes' history (Motion.ts `taaCut`): the previous frame's trail becomes
	 * the current one, so nothing moves across the cut. */
	cut(): void {

		this.keepPrevious();

	}

	private keepPrevious(): void {

		const u = this.uniforms, p = u.previous;
		p.count.value = u.count.value;
		u.circles.forEach( ( v, i ) => p.circles[ i ].copy( v ) );
		u.samples.forEach( ( v, i ) => p.samples[ i ].copy( v ) );

	}

}
