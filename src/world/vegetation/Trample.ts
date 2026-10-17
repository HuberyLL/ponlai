import * as THREE from 'three/webgpu';
import { Fn, If, Loop, int, float, vec2, uniform, uniformArray, dot, max, clamp, mix, length, exp, smoothstep } from 'three/tsl';
import { debugFlags } from '../../debug/DebugFlags.ts';

// The islanders' trail through the meadow: the blades about an islander's legs are parted to either
// side and lie down, and stay down for a while once the islander has passed before they rise again,
// so a walker leaves a furrow through the grass that closes several seconds behind it. The meadow's
// blades read it in their vertex stage (`trampleLean`), where it joins the wind's lean (Deform.ts
// `bendBlade`), so a pressed blade arcs over and sinks as under the wind, keeping its length.
//
// Rules:
// - The trail is a function of where the walkers were, never a field that accumulates frames: each
//   frame every walker is asked for its ground track at TRAMPLE.samples ages a TRAMPLE.step apart
//   (`TrampleWalker.track`), from now back to the trail's end, and the blades read that polyline.
//   The art-review islander's track is its walking schedule at the scene clock's earlier times
//   (characters/Villagers.ts), so a paused frame, a scene jump and a grown island's page draw the
//   trail a fresh load of the same query draws, with nothing to clear or freeze in the test mode.
//   The game's islanders keep the positions their views have shown since they appeared, by the
//   game's clock (game/view/VillagerView.ts): a paused game holds its trails, and a new view (a
//   game started or loaded) starts with none.
// - A blade takes the push of the nearest part of each track (a capsule between two samples, its
//   age interpolated along it): full within TRAMPLE.reach[ 0 ] of the track, none beyond reach[ 1 ],
//   times the recovery at that age (`recovery`: held for TRAMPLE.hold, then the critically damped
//   return of a released spring, time constant TRAMPLE.recover, faded out to 0 by the trail's end).
//   It leans away from the track, to the side its root stands on, and a little forward along the
//   walker's motion (TRAMPLE.forward), so the blades are parted into a furrow: combed forward along
//   the track (half the strength of the push away from it, tried first), they filled it as one
//   swath of flattened grass instead. A standing islander presses the grass round its feet as a
//   walking one does, and it stays down while the islander stands (its samples all lie at its feet,
//   the newest of age 0): pressed only once the islander set off, a standing islander's grass lay
//   down as it began to walk. Several pushes on one blade take their strongest strength along their
//   weighted direction.
// - The push is read at each blade's own root, so the blades of one tussock part either side of a
//   leg; a flower's head takes its stem's, at the tuft's origin.
// - The furrow shows from the game's camera, where the parted blades are a few pixels across, by its
//   trough: a parted blade keeps its shading (Grass.ts), so its lower half, laid out of the canopy,
//   darkens the trough between the blades heaped at its sides. Lit as its tip along its whole length
//   instead, a laid blade filled the trough with pale grass and the furrow read as a flat band. A
//   pressed blade's tip shows its paler side (TRAMPLE.pale, as a lean in the wind does:
//   `bendBlade`'s `pale`).
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

/** The trail's numbers: the walkers drawn at most and the samples of each one's track, their spacing
 * (s: the track reaches back ( samples - 1 ) * step), how far a meadow blade's root may stand from
 * its tuft's origin (m: 0.2 at the tuft's widest scale of 1.1, Grass.ts), the distance from the
 * track (m) within which a blade is fully pressed and beyond which it is not touched (the furrow
 * about twice an islander's width: at 0.2 and 0.55 m it was two and a half times as wide and read as
 * a broad band), the lean of a fully pressed blade (per metre of its height: a tip about 80 degrees
 * over at 6), the share of the walker's direction in the lean's, how long a blade stays down after the walker has passed (s)
 * and the time constant of its return (s: the push at half its strength about 4.9 s after the pass,
 * at an eighth by 6.6 s and gone by the trail's end at 7.8 s, so a walker's furrow lies across a
 * good part of the island behind it), and how much lighter a blade lying flat shows (as the wind's
 * `underside`). */
export const TRAMPLE = { walkers: 16, samples: 14, step: 0.6, spread: 0.25, reach: [ 0.12, 0.4 ], lean: 6, forward: 0.1, hold: 2.5, recover: 1.4, pale: 0.6 } as const;

// The age at which the trail ends, its last sample's.
const LAST = ( TRAMPLE.samples - 1 ) * TRAMPLE.step;

/** Something that parts the meadow: its feet's ground track (world x, z) `age` seconds ago, by the
 * clock it moves by, into `out`. */
export interface TrampleWalker {
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

/** How pressed a blade still is `age` seconds after the walker's nearest pass: 1 for TRAMPLE.hold,
 * then ( 1 + x ) e^-x at x = ( age - hold ) / recover, eased to 0 over the trail's last quarter. */
function recovery( age: F ): F {

	const x = max( age.sub( TRAMPLE.hold ), 0 ).div( TRAMPLE.recover );
	return x.add( 1 ).mul( exp( x.negate() ) ).mul( float( 1 ).sub( smoothstep( LAST * 0.75, LAST, age ) ) );

}

/** The trail's lean on a blade rooted at `root()` (world x, z) in a tuft standing at `centre`
 * (world x, z; its blades' roots within TRAMPLE.spread of it): a horizontal vector, its length the
 * lean per metre of the blade's height (`bendBlade` adds it to the wind's); exactly 0 away from
 * every walker. The walkers' circles are tested at the tuft, and the root is built only for the
 * tufts inside one: away from the walkers a vertex pays for the tests alone. */
export function trampleLean( state: TrampleState, centre: V2, root: () => V2 ): V2 {

	const { samples, reach, forward } = TRAMPLE;
	// (in a function of its own: the loops and the branch need a stack to build into)
	return Fn( () => {

		const push = vec2( 0 ).toVar(), most = float( 0 ).toVar();
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
					const span = length( run );
					const u = clamp( dot( a.xy.sub( at ), run ).div( max( span.mul( span ), 1e-8 ) ), 0, 1 );
					const side = at.sub( a.xy.sub( run.mul( u ) ) ).toVar();
					const d = length( side );
					const strength = float( 1 ).sub( smoothstep( reach[ 0 ], reach[ 1 ], d ) ).mul( recovery( mix( a.z, b.z, u ) ) );
					// away from the track, and forward along the walker's motion (none for a standing one);
					// on the track itself forward alone
					const away = side.div( max( d, 1e-4 ) ).mul( smoothstep( 0, reach[ 0 ], d ) );
					const ahead = run.div( max( span, 0.05 ) ).mul( forward );
					push.addAssign( away.add( ahead ).mul( strength ) );
					most.assign( max( most, strength ) );

				} );

			} );

		} );
		return push.mul( most.mul( TRAMPLE.lean ).div( max( length( push ), 1e-6 ) ) );

	} )();

}

// 1 - 1 / sqrt( 1 + y ), the share a chord has turned from upright (1 - cos) at a lean whose square
// is y, written so that y = 0 gives exactly 0
function turned( y: F ): F {

	return y.div( y.add( 1 ).add( y.add( 1 ).sqrt() ) );

}

/** The paler side a pressed blade shows: a factor on its colour, 1 + TRAMPLE.pale times the share
 * its chord has turned from upright under the trail's lean `lean` at the blade parameter's square
 * `t2`; exactly 1 where the lean is 0. */
export function tramplePale( lean: V2, t2: F ): F {

	return float( 1 ).add( turned( dot( lean, lean ).mul( t2 ) ).mul( TRAMPLE.pale ) );

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
		const reach = TRAMPLE.reach[ 1 ] + TRAMPLE.spread;
		for ( let w = 0; w < count; w ++ ) {

			let x0 = Infinity, z0 = Infinity, x1 = - Infinity, z1 = - Infinity;
			for ( let s = 0; s < TRAMPLE.samples; s ++ ) {

				const age = s * TRAMPLE.step;
				order[ w ].walker.track( age, _p );
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
