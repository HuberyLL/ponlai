import * as THREE from 'three/webgpu';
import { animate, FIGURE_HEIGHT, type Villager as Figure } from '../../characters/Villagers.ts';
import type { Sex } from '../../characters/Ages.ts';
import type { EntityId, GridApi, Villager } from '../sim/types.ts';
import { TRAMPLE, type TrampleWalker } from '../../world/vegetation/Trample.ts';

// One islander on screen: the sim's body drawn by a loaded figure (or a plain stand-in when the
// figure cannot load). Position interpolates between the last two ticks, the heading turns
// smoothly toward the sim's facing, and the body's motion picks the idle or walk clip with a
// short crossfade. The figure's clock runs at the game's pace, so speeding the game up speeds the
// islanders up and a paused game freezes them mid-step. A figure with a body shows the islander's
// age each frame, and puts on the body prepared for it, one figure a frame (GameView;
// characters/FigureAge.ts).
// It parts the meadow (world/vegetation/Trample.ts) along the positions it has shown, kept by the
// game's clock for the trail's length (`record`, `track`): a paused game holds its trail, and a new
// view (a game started or loaded) starts without one.

// real seconds a change of clip takes to blend
const FADE = 0.35;

export class VillagerView implements TrampleWalker {

	readonly id: EntityId;
	/** at the feet, turned to the heading */
	readonly root = new THREE.Group();
	/** hips, for the figure's shadow map */
	readonly centre = new THREE.Vector3();
	/** the look index its figure was loaded for (Villager.look) and the sex it wears */
	readonly look: number;
	readonly sex: Sex;
	figure: Figure | null = null;
	loading = false;
	stamp = 0;
	private standIn: THREE.Mesh | null = null;
	private current: THREE.AnimationAction | null = null;
	private heading = NaN;
	// the positions shown (x, z) and their times (game ticks), oldest first, and ticks per second of
	// the trail's clock
	private readonly shown: number[] = [];
	private readonly times: number[] = [];
	private ticksPerSecond = 1;

	constructor( id: EntityId, look: number, sex: Sex ) {

		this.id = id;
		this.look = look;
		this.sex = sex;
		this.root.name = `villager:${ id }`;

	}

	/** True once something is drawn for the islander: its figure or a stand-in. */
	get drawn(): boolean {

		return this.figure !== null || this.standIn !== null;

	}

	/** Draw a plain stand-in until (unless) the figure loads. */
	showStandIn( m: THREE.Mesh ): void {

		if ( this.figure || this.standIn ) return;
		this.standIn = m;
		this.root.add( m );

	}

	/** Show the loaded figure, idling. */
	attach( figure: Figure ): void {

		this.standIn?.removeFromParent();
		this.standIn = null;
		this.figure = figure;
		// a figure may come from an earlier view: start it from rest
		figure.mixer.stopAllAction();
		for ( const name in figure.actions ) figure.actions[ name ].timeScale = 1;
		figure.mixer.setTime( 0 );
		this.root.add( figure.group );
		this.current = null;
		this.play( 'Idle_Neutral', 0 );

	}

	private play( name: string, fade: number ): void {

		const next = this.figure!.actions[ name ];
		if ( ! next || next === this.current ) return;
		next.reset().setEffectiveWeight( 1 ).play();
		if ( this.current && fade > 0 ) next.crossFadeFrom( this.current, fade, false );
		else this.current?.stop();
		this.current = next;

	}

	/**
	 * Per frame. realDt drives smoothing that should not change with game speed; gameDt (real
	 * seconds times the speed factor) drives everything the islander does, so a pause holds it.
	 * pace: game seconds per game-paced second this frame (NaN when unknown); age: the islander's
	 * (years); swap: whether this frame may put on a body prepared for the age (FigureAge.ts swap),
	 * which it returns once it has.
	 */
	update( v: Readonly<Villager>, age: number, grid: GridApi, alpha: number, realDt: number, factor: number, pace: number, swap: boolean ): boolean {

		const gameDt = realDt * factor;
		const x = v.prev.x + ( v.pos.x - v.prev.x ) * alpha;
		const z = v.prev.z + ( v.pos.z - v.prev.z ) * alpha;
		const y = grid.height( x, z );
		if ( Number.isNaN( this.heading ) ) {

			// a new view (a game just started or loaded) shows the pose at once, paused or not
			this.heading = v.heading;

		} else if ( gameDt > 0 ) {

			const d = Math.atan2( Math.sin( v.heading - this.heading ), Math.cos( v.heading - this.heading ) );
			this.heading += d * Math.min( 1, gameDt * 6 );

		}
		this.root.position.set( x, y, z );
		this.root.rotation.y = this.heading;

		const walking = v.path !== null;
		const f = this.figure;
		let swapped = false;
		this.centre.copy( this.root.position ).y += ( f ? f.height : FIGURE_HEIGHT ) / 2;
		if ( f ) {

			f.age?.set( age );
			if ( swap && f.age?.ready ) {

				f.age.swap();
				swapped = true;

			}
			// Crossfades last FADE real seconds at any speed; the mixer runs at the game's pace.
			this.play( walking ? 'Walk' : 'Idle_Neutral', FADE * Math.max( factor, 1 ) );
			const walk = f.actions.Walk;
			if ( walk && walking && pace > 0 ) {

				// A tick is a game second, so this tick's step is the ground speed in metres per game
				// second (constant along a path); pace turns it into the mixer's seconds so feet hold.
				const step = Math.hypot( v.pos.x - v.prev.x, v.pos.z - v.prev.z );
				walk.timeScale = THREE.MathUtils.clamp( step * pace / f.strideSpeed, 0.15, 3 );

			}
			animate( f, gameDt );

		}
		return swapped;

	}

	/** Keep the position shown this frame at game time `time` (ticks; `ticksPerSecond` of them a
	 * second of the trail's clock) for the trail, and drop what lies beyond the trail's end. */
	record( time: number, ticksPerSecond: number ): void {

		const n = this.times.length;
		if ( n > 0 && time < this.times[ n - 1 ] ) {

			this.times.length = 0;
			this.shown.length = 0;

		}
		this.ticksPerSecond = ticksPerSecond;
		const { x, z } = this.root.position;
		if ( this.times.length > 0 && time === this.times[ this.times.length - 1 ] ) this.shown.splice( - 2, 2, x, z );
		else {

			this.times.push( time );
			this.shown.push( x, z );

		}
		// one sample older than the trail's end stays, for the interpolation there
		const end = time - ( TRAMPLE.samples - 1 ) * TRAMPLE.step * ticksPerSecond;
		let drop = 0;
		while ( drop + 1 < this.times.length && this.times[ drop + 1 ] <= end ) drop ++;
		if ( drop > 0 ) {

			this.times.splice( 0, drop );
			this.shown.splice( 0, drop * 2 );

		}

	}

	/** The trail's clock at the last record (s: game ticks over ticks per second), by which its
	 * track's ages count. */
	clock(): number {

		const n = this.times.length;
		return n > 0 ? this.times[ n - 1 ] / this.ticksPerSecond : 0;

	}

	/** Where the islander's feet were `age` seconds of the trail's clock before the last record (x,
	 * z), between the positions shown (its oldest before them). */
	track( age: number, out: THREE.Vector2 ): void {

		const times = this.times, n = times.length;
		if ( n === 0 ) {

			out.set( this.root.position.x, this.root.position.z );
			return;

		}
		const t = times[ n - 1 ] - age * this.ticksPerSecond;
		let i = n - 1;
		while ( i > 0 && times[ i ] > t ) i --;
		if ( i === n - 1 || times[ i ] >= t ) {

			out.set( this.shown[ i * 2 ], this.shown[ i * 2 + 1 ] );
			return;

		}
		const f = ( t - times[ i ] ) / ( times[ i + 1 ] - times[ i ] );
		out.set( this.shown[ i * 2 ] + ( this.shown[ i * 2 + 2 ] - this.shown[ i * 2 ] ) * f, this.shown[ i * 2 + 1 ] + ( this.shown[ i * 2 + 3 ] - this.shown[ i * 2 + 1 ] ) * f );

	}

	/** Take the figure off this view (for another view to use); the view is disposed after. */
	release(): Figure | null {

		const f = this.figure;
		f?.group.removeFromParent();
		this.figure = null;
		return f;

	}

	dispose(): void {

		this.root.removeFromParent();
		if ( this.figure ) disposeFigure( this.figure );
		this.figure = null;

	}

}

/** Release a loaded figure's GPU resources (each load builds its own mesh, material and skeleton). */
export function disposeFigure( f: Figure ): void {

	f.mixer.stopAllAction();
	f.mixer.uncacheRoot( f.mixer.getRoot() );
	f.group.removeFromParent();
	f.group.traverse( ( o ) => {

		const mesh = o as THREE.SkinnedMesh;
		if ( ! mesh.isSkinnedMesh ) return;
		mesh.geometry.dispose();
		( mesh.material as THREE.Material ).dispose();
		mesh.skeleton.dispose();

	} );

}
