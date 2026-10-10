import * as THREE from 'three/webgpu';
import type { Villager as Figure } from '../../characters/Villagers.ts';
import type { EntityId, GridApi, Villager } from '../sim/types.ts';

// One islander on screen: the sim's body drawn by a loaded figure (or a plain stand-in when the
// figure cannot load). Position interpolates between the last two ticks, the heading turns
// smoothly toward the sim's facing, and the body's motion picks the idle or walk clip with a
// short crossfade. The figure's clock runs at the game's pace, so speeding the game up speeds the
// islanders up and a paused game freezes them mid-step.

// real seconds a change of clip takes to blend
const FADE = 0.35;

export class VillagerView {

	readonly id: EntityId;
	/** at the feet, turned to the heading */
	readonly root = new THREE.Group();
	/** hips, for the figure's shadow map */
	readonly centre = new THREE.Vector3();
	/** the look index its figure was loaded for (Villager.look) */
	readonly look: number;
	figure: Figure | null = null;
	loading = false;
	stamp = 0;
	private standIn: THREE.Mesh | null = null;
	private current: THREE.AnimationAction | null = null;
	private heading = NaN;

	constructor( id: EntityId, look: number ) {

		this.id = id;
		this.look = look;
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
	 * pace: game seconds per game-paced second this frame (NaN when unknown).
	 */
	update( v: Readonly<Villager>, grid: GridApi, alpha: number, realDt: number, factor: number, pace: number ): void {

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
		this.centre.copy( this.root.position ).y += 0.85;

		const walking = v.path !== null;
		const f = this.figure;
		if ( f ) {

			// Crossfades last FADE real seconds at any speed; the mixer runs at the game's pace.
			this.play( walking ? 'Walk' : 'Idle_Neutral', FADE * Math.max( factor, 1 ) );
			const walk = f.actions.Walk;
			if ( walk && walking && pace > 0 ) {

				// A tick is a game second, so this tick's step is the ground speed in metres per game
				// second (constant along a path); pace turns it into the mixer's seconds so feet hold.
				const step = Math.hypot( v.pos.x - v.prev.x, v.pos.z - v.prev.z );
				walk.timeScale = THREE.MathUtils.clamp( step * pace / f.strideSpeed, 0.15, 3 );

			}
			f.mixer.update( gameDt );

		}

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
