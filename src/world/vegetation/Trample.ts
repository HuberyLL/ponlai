import * as THREE from 'three/webgpu';
import { Fn, If, Loop, int, float, vec2, vec3, vec4, uniform, uniformArray, dot, min, max, clamp, mix, length, exp, smoothstep, step, select, atan, tan, workgroupId, localId } from 'three/tsl';
import { TEMPORAL } from '../../post/Antialiasing.ts';
import { CULL_GROUP } from './VegetationCull.ts';
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
// - Each tuft of the meadow keeps a record of the trail (`trampleKernel`, a compute pass over the
//   cull's pool that Trample dispatches after it writes the uniforms): of every stretch of track
//   (a capsule between two samples, its age interpolated along it) the one that presses the tuft
//   hardest, as its point nearest the tuft's anchor, the way's direction there, the age there and
//   its change along the way, and how far on the walker's feet are now. A blade reads it at its own
//   root (`trampleShare`), the stretch standing for the way across the tuft, straight, ending at the
//   feet: the legs push it straight away from the way, full within TRAMPLE.legs[ 0 ], none beyond
//   legs[ 1 ], the push turning in over the feet's reach from the middle of the way, where it has no
//   side; the feet press it down within TRAMPLE.feet. The push is never set to a full lean along a
//   normalised direction, so the middle of the way is pushed less, not swung over. A standing
//   walker's samples all lie at its feet, the newest of age 0, so it pushes the grass about it for
//   as long as it stands. The direction comes from the next older stretch where the stretch itself
//   is shorter than STRETCH (the newest, just after a step of the clock).
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
// - Cost: the record's kernel loops over the walkers (`count`, the TRAMPLE.walkers nearest the
//   camera) per tuft, testing its track's bounding circle at the tuft's anchor (grown by
//   TRAMPLE.legs[ 1 ] and TRAMPLE.spread), and runs only while a walker is drawn or was in the frame
//   before (and once more to empty the records). A vertex reads its tuft's record and tests it; only
//   the vertices of the tufts the trail reaches work out their blade's root and the push. Read by
//   every vertex, the loops over the walkers and the track's stretches cost the island view about a
//   millisecond whether or not a walker was near: the shader that carried them was slower
//   throughout. `debugFlags.trample = false` leaves the trail out of the meadow's shader when set at
//   load (the shader of a page without it, and no records), and at run time empties the walkers
//   (profile-frame's --toggle).
// - Under the temporal modes the blade's previous position takes the previous rendered frame's
//   trail (`previous`, a second record per tuft), kept as the wind's is: copied once per rendered
//   frame, and made the current one on a cut of the histories.

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type Storage<T extends 'vec4'> = THREE.StorageBufferNode<T>;
// (three's types give `min` float operands only)
type IntMin = ( a: THREE.Node<'int'>, b: THREE.Node<'int'> ) => THREE.Node<'int'>;

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
 * frame being rendered and the frame rendered before it (`previous`), and the kernels that write
 * the records the kinds read the trail by (`trampleKernel`), which Trample dispatches. */
export function createTrampleUniforms(): TrampleState & { previous: TrampleState; kernels: THREE.ComputeNode[] } {

	return { ...trampleState(), previous: trampleState(), kernels: [] };

}

/** The trail's uniforms with their kernels (`createTrampleUniforms`). */
export type TrampleUniforms = ReturnType<typeof createTrampleUniforms>;

/** The vec4s of a tuft's record of the trail: two per frame, the frame being rendered's and, under
 * the temporal modes, the previous one's after them. */
export const TRAMPLE_RECORD = TEMPORAL ? 4 : 2;

/** The share of its deflection a blade keeps `age` seconds after a push: ( 1 + x ) e^-x at x = age /
 * TRAMPLE.settle, a released spring's return, critically damped, eased to 0 over the last quarter
 * of the trail. */
function recovery( age: F ): F {

	const x = age.div( TRAMPLE.settle );
	return x.add( 1 ).mul( exp( x.negate() ) ).mul( float( 1 ).sub( smoothstep( END * 0.75, END, age ) ) );

}

// The way's direction is taken from a stretch at least this long (m): the newest stretch is
// shorter just after a step of the walker's clock, and a standing walker's have no length.
const STRETCH = 0.03;

/** Writes a tuft's record of `state`'s trail at its anchor `centre` (world x, z) into `records` at
 * `at`: the stretch of track that presses its blades hardest, as the point of the way nearest the
 * anchor and the way's direction there, toward the walker (world x, z; 0 for a standing walker),
 * then the age at that point, the age per metre back along the way, the distance along it to the
 * walker's feet now, and 1 (0 and an empty record where no walker reaches the tuft). */
function writeRecord( state: TrampleState, centre: V2, records: Storage<'vec4'>, at: THREE.Node<'uint'> ): void {

	const { samples, legs, spread } = TRAMPLE;
	const best = float( 0 ).toVar(), near = vec2( 0 ).toVar(), way = vec2( 0 ).toVar();
	const age = float( 0 ).toVar(), slope = float( 0 ).toVar(), ahead = float( 0 ).toVar();
	Loop( { start: int( 0 ), end: state.count, type: 'int', condition: '<' }, ( { i } ) => {

		const walker = state.walkers.element( i );
		const off = centre.sub( walker.xy );
		If( dot( off, off ).lessThan( walker.z ), () => {

			const first = i.mul( int( samples ) ).toVar();
			const feet = state.points.element( first ).xy;
			// (its counter named apart from the walkers' loop's)
			const range = { start: int( 0 ), end: int( samples - 1 ), type: 'int' as const, condition: '<', name: 'j' };
			Loop( range, ( inputs ) => {

				const j = ( inputs as unknown as { j: THREE.Node<'int'> } ).j;
				const k = first.add( j );
				// a stretch from the newer sample `a` to the older `b`, and the one after it, from `b` to `c`
				const a = state.points.element( k ), b = state.points.element( k.add( int( 1 ) ) );
				const c = state.points.element( first.add( ( min as unknown as IntMin )( j.add( int( 2 ) ), int( samples - 1 ) ) ) );
				const run = a.xy.sub( b.xy ).toVar(), span = length( run ).toVar();
				const u = clamp( dot( a.xy.sub( centre ), run ).div( max( span.mul( span ), 1e-8 ) ), 0, 1 );
				const point = a.xy.sub( run.mul( u ) ).toVar();
				const when = mix( a.z, b.z, u ).toVar();
				const score = recovery( when ).mul( float( 1 ).sub( smoothstep( legs[ 0 ], legs[ 1 ] + spread, length( centre.sub( point ) ) ) ) );
				If( score.greaterThan( best ), () => {

					const next = b.xy.sub( c.xy ).toVar(), nextSpan = length( next ).toVar();
					const own = span.greaterThanEqual( STRETCH ), after = nextSpan.greaterThanEqual( STRETCH );
					const dir = run.div( max( span, 1e-6 ) ).toVar(), nextDir = next.div( max( nextSpan, 1e-6 ) ).toVar();
					const rate = b.z.sub( a.z ).div( max( span, 1e-6 ) ).toVar(), nextRate = c.z.sub( b.z ).div( max( nextSpan, 1e-6 ) ).toVar();
					const toward = select( own, dir, select( after, nextDir, vec2( 0 ) ) ).toVar();
					best.assign( score );
					near.assign( point );
					way.assign( toward );
					age.assign( when );
					slope.assign( select( own, rate, select( after, nextRate, float( 0 ) ) ) );
					ahead.assign( max( dot( feet.sub( point ), toward ), 0 ) );

				} );

			} );

		} );

	} );
	records.element( at ).assign( vec4( near, way ) );
	records.element( at.add( 1 ) ).assign( vec4( age, slope, ahead, step( 1e-6, best ) ) );

}

/** The kernel that writes every meadow tuft's record of the trail (TRAMPLE_RECORD vec4s per slot of
 * the cull's pool, from each slot's anchor in `origins`: VegetationCull.ts), the frame being
 * rendered's and under the temporal modes the previous one's; dispatched by `workgroups` (the
 * cull's, which follow its pool) whenever the trail changes (`Trample`). */
export function trampleKernel( uniforms: TrampleUniforms, origins: Storage<'vec4'>, records: Storage<'vec4'>, workgroups: [ number, number, number ] ): THREE.ComputeNode {

	const kernel = Fn( () => {

		const slot = workgroupId.x.mul( CULL_GROUP ).add( localId.x ).toVar();
		const centre = origins.element( slot ).xz.toVar();
		const at = slot.mul( TRAMPLE_RECORD ).toVar();
		writeRecord( uniforms, centre, records, at );
		if ( TEMPORAL ) writeRecord( uniforms.previous, centre, records, at.add( 2 ) );

	} )().computeKernel( [ CULL_GROUP ] );
	kernel.dispatchSize = workgroups;
	kernel.setName( 'Grass.Trample' );
	return kernel;

}

/** The trail on a blade rooted at `root()` (world x, z) in a tuft whose record of it is `record`
 * (`record( 0 )`, `record( 1 )`: `trampleKernel`'s): ( x, z ) the legs' push, a horizontal vector
 * whose length is the share of a full push the blade still keeps (0..1), and the feet's weight's
 * share; exactly 0 in a tuft no walker reaches (`trampleLoad` turns it into the blade's load). The
 * root is built only for the tufts the trail reaches: elsewhere a vertex reads one vec4 and tests
 * it. The tuft's stretch of track stands for the way across the tuft, straight, its age along it
 * linear, and ends at the walker's feet. */
export function trampleShare( record: ( k: number ) => THREE.Node<'vec4'>, root: () => V2 ): V3 {

	const { legs, feet } = TRAMPLE;
	// (in a function of its own: the branch needs a stack to build into)
	return Fn( () => {

		const share = vec3( 0 ).toVar();
		const r1 = record( 1 ).toVar();
		If( r1.w.greaterThan( 0 ), () => {

			const r0 = record( 0 ).toVar();
			const at = root().toVar();
			const along = min( dot( at.sub( r0.xy ), r0.zw ), r1.z ).toVar();
			const away = at.sub( r0.xy.add( r0.zw.mul( along ) ) ).toVar();
			const d = length( away ).toVar();
			const kept = recovery( max( r1.x.sub( r1.y.mul( along ) ), 0 ) ).toVar();
			// the legs' push, turning in from the middle of the way over the feet's reach, and the
			// feet's weight
			const push = float( 1 ).sub( smoothstep( legs[ 0 ], legs[ 1 ], d ) ).mul( smoothstep( 0, feet[ 1 ], d ) ).mul( kept );
			share.assign( vec3( away.mul( push.div( max( d, 1e-4 ) ) ), float( 1 ).sub( smoothstep( feet[ 0 ], feet[ 1 ], d ) ).mul( kept ) ) );

		} );
		return share;

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

	private readonly uniforms: TrampleUniforms;
	private readonly order: { walker: TrampleWalker; d: number; i: number }[] = [];
	// whether the records hold no trail (the kernel's for no walkers; a new pool's are zeros too):
	// false at first, so the first update writes them and builds the kernel's pipeline at load, never
	// in a growth's swap
	private empty = false;

	constructor( uniforms: TrampleUniforms ) {

		this.uniforms = uniforms;

	}

	/** The trail of `walkers` (the TRAMPLE.walkers nearest `near` when there are more), after the
	 * previous frame's has been kept, and the kinds' records of it written by `renderer`. */
	update( walkers: readonly TrampleWalker[], near: THREE.Vector3, renderer: THREE.Renderer ): void {

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
		this.write( renderer );

	}

	/** A cut of the temporal modes' history (Motion.ts `taaCut`): the previous frame's trail becomes
	 * the current one, so nothing moves across the cut. */
	cut( renderer: THREE.Renderer ): void {

		this.keepPrevious();
		this.write( renderer );

	}

	/** The kinds' records, written every frame a walker is drawn or was in the frame before, and
	 * once more to empty them when none is: a function of the uniforms alone, whatever came before. */
	private write( renderer: THREE.Renderer ): void {

		const u = this.uniforms;
		const none = u.count.value === 0 && ( ! TEMPORAL || u.previous.count.value === 0 );
		if ( u.kernels.length === 0 || ( none && this.empty ) ) return;
		renderer.compute( u.kernels );
		this.empty = none;

	}

	private keepPrevious(): void {

		const u = this.uniforms, p = u.previous;
		p.count.value = u.count.value;
		u.circles.forEach( ( v, i ) => p.circles[ i ].copy( v ) );
		u.samples.forEach( ( v, i ) => p.samples[ i ].copy( v ) );

	}

}
