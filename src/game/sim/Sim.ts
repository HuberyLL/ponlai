import { actionTools, advanceAction, findWaysAgain } from './actions.ts';
import { act, perceive } from './agent.ts';
import type { Brain, ToolRegistry, ToolResult } from './agent.ts';
import { dayOf, hourOf } from './clock.ts';
import { Grid } from './grid.ts';
import { fallNeeds, START_NEEDS } from './needs.ts';
import { findPath, goalAt } from './path.ts';
import { BUILDING_KINDS, blueprintRefusal, newBuilding } from './buildings.ts';
import { growPalms, newPalms, obstructPlaces } from './places.ts';
import { random } from './rng.ts';
import { SECONDS_PER_GAME_DAY, SPEED_FACTORS, WALK_SPEED } from './types.ts';
import type { EntityId, IslandInput, SimState, Speed, Vec2, Villager } from './types.ts';

// The island simulation: a fixed step of one game second, with every change kept in SimState, so
// a save is the state itself. One seeded generator (SimState.rng) is its only source of chance.
// The islanders are bodies on the ground grid with needs that fall (needs.ts), a bag (items.ts) and
// an action under way (actions.ts); the places they act at (places.ts) keep their own state here
// too (the palms' coconuts, the buildings). A brain may think for them (agent.ts) beside the
// world, never holding up a tick. The weather is the page's own: nothing in the simulation depends
// on it.
//
// Each tick: the needs fall, the palms grow, each body walks a step and its action advances, then
// the temporary trigger asks the brain for a thought for every islander with nothing under way
// (no action, no walk) and no thought in flight. A brain that answers at once (the stand-in) acts
// within the tick, so a game with it is deterministic for a seed; a slow one acts when it answers.

/** the state's shape this build reads; a save of another is refused */
export const SAVE_VERSION = 13;
const NAMES = [ 'Kai' ];

export class Sim {

	readonly state: SimState;
	readonly grid: Grid;
	speed: Speed = 1;
	/** fraction of the next tick already elapsed (0..1), for interpolating positions */
	alpha = 0;
	/** the tools a brain acts through, by name: the five actions (actions.ts) */
	tools: ToolRegistry = actionTools();
	/** what thinks for the islanders; null: nothing, they stand idle */
	brain: Brain | null = null;
	private carry = 0;
	/** the islanders with a thought in flight */
	private readonly thoughts = new Map<EntityId, Promise<ToolResult[]>>();

	constructor( state: SimState, input: IslandInput ) {

		this.state = state;
		this.grid = new Grid( input );
		obstructPlaces( this );

	}

	// ------------------------------------------------------------------ clock

	/** hour of day, 0..24 */
	hour(): number {

		return hourOf( this.state );

	}

	/** whole days since the game began */
	day(): number {

		return dayOf( this.state );

	}

	/** uniform in [ 0, 1 ), from the seeded generator the save carries */
	random(): number {

		return random( this.state );

	}

	/** Run forward by real seconds at the current speed, given the day clock's length in real
	 * seconds; returns the game seconds (ticks) run. */
	advance( realSeconds: number, secondsPerDay: number ): number {

		this.carry += realSeconds * SPEED_FACTORS[ this.speed ] * SECONDS_PER_GAME_DAY / secondsPerDay;
		const ticks = Math.floor( this.carry );
		this.carry -= ticks;
		this.alpha = this.carry;
		this.step( ticks );
		return ticks;

	}

	/** Run whole ticks. */
	step( ticks: number ): void {

		for ( let i = 0; i < ticks; i ++ ) this.tick();

	}

	private tick(): void {

		const state = this.state;
		state.tick ++;
		growPalms( state );
		for ( const v of state.villagers ) {

			v.prev.x = v.pos.x;
			v.prev.z = v.pos.z;
			fallNeeds( v.needs );
			this.walk( v );
			advanceAction( this, v );

		}
		if ( ! this.brain ) return;
		for ( const v of state.villagers ) if ( ! v.action && ! v.path && ! this.thoughts.has( v.id ) ) this.think( v.id );

	}

	// ------------------------------------------------------------------ bodies

	villager( id: EntityId ): Villager | undefined {

		return this.state.villagers.find( ( v ) => v.id === id );

	}

	/** The body's motor: find a path to a point and walk it from the next tick on, dropping the
	 * action under way (the debug panel's walk; a brain walks by `go`). Null when it sets off (or
	 * already stands there), else why it cannot. */
	walkTo( id: EntityId, target: Vec2 ): string | null {

		const v = this.villager( id );
		if ( ! v ) return 'No such islander';
		const goal = goalAt( this.grid, target );
		if ( ! goal ) return 'Nowhere to stand there';
		const path = findPath( this.grid, v.pos, goal );
		if ( ! path ) return 'No way there';
		v.action = null;
		v.path = path.length > 0 ? path : null;
		return null;

	}

	// ------------------------------------------------------------------ the player

	/** Place a building of a kind (buildings.ts) at a point of the ground (world metres): null
	 * when it stands there, else why not (blueprintRefusal). */
	placeBlueprint( kind: string, x: number, z: number ): string | null {

		const reason = blueprintRefusal( this, kind, { x, z } );
		if ( reason ) return reason;
		this.state.buildings.push( newBuilding( kind, x, z ) );
		this.grid.obstruct( x, z, BUILDING_KINDS[ kind ].radius );
		findWaysAgain( this );
		return null;

	}

	/** One game second along the body's path. */
	private walk( v: Villager ): void {

		const path = v.path;
		if ( ! path ) return;
		let left = WALK_SPEED;
		while ( left > 0 && path.length > 0 ) {

			const wp = path[ 0 ];
			const dx = wp.x - v.pos.x, dz = wp.z - v.pos.z;
			const d = Math.hypot( dx, dz );
			if ( d > 1e-9 ) v.heading = Math.atan2( dx, dz );
			if ( d <= left ) {

				v.pos.x = wp.x;
				v.pos.z = wp.z;
				left -= d;
				path.shift();

			} else {

				v.pos.x += dx / d * left;
				v.pos.z += dz / d * left;
				left = 0;

			}

		}
		if ( path.length === 0 ) v.path = null;

	}

	// ------------------------------------------------------------------ thinking

	/** Whether an islander has a thought in flight. */
	thinking( id: EntityId ): boolean {

		return this.thoughts.has( id );

	}

	/**
	 * Ask the brain to think for an islander now, from what it perceives. Thinking is asynchronous
	 * to the world: the simulation never waits for it, the body goes on with what it is doing
	 * meanwhile, and the answer's tool calls run on the body when it arrives (at once for an answer
	 * that is not a Promise). Resolves to the calls' results; null when there is no brain, no such
	 * islander, or a thought already in flight for it.
	 */
	think( id: EntityId ): Promise<ToolResult[]> | null {

		const v = this.villager( id );
		if ( ! v || ! this.brain || this.thoughts.has( id ) ) return null;
		const answer = this.brain.think( perceive( this, v ) );
		if ( ! ( answer instanceof Promise ) ) return Promise.resolve( act( this, v, answer ) );
		const thought = answer.then( ( calls ) => act( this, v, calls ) ).finally( () => this.thoughts.delete( id ) );
		this.thoughts.set( id, thought );
		return thought;

	}

	save(): string {

		return JSON.stringify( this.state );

	}

}

/** A new game: its palm, and one islander standing near the island's centre, facing it. */
export function newGame( input: IslandInput, options: { seed?: number; startHour?: number } = {} ): Sim {

	const seed = ( options.seed ?? 1 ) >>> 0;
	const sim = new Sim( { version: SAVE_VERSION, seed, tick: 0, startHour: options.startHour ?? 8, rng: seed, villagers: [], palms: [], buildings: [] }, input );
	const grid = sim.grid;
	sim.state.palms = newPalms( sim );
	obstructPlaces( sim );
	NAMES.forEach( ( name, n ) => {

		const a = n / NAMES.length * Math.PI * 2;
		const k = grid.nearestOpen( grid.indexAt( Math.cos( a ) * 1.5, Math.sin( a ) * 1.5 ), 40, grid.main );
		if ( k < 0 ) throw new Error( 'No open ground near the island\'s centre' );
		const p = grid.centreOf( k );
		sim.state.villagers.push( {
			id: `v${ n + 1 }`, name, look: n, pos: { ...p }, prev: { ...p }, heading: Math.atan2( - p.x, - p.z ), path: null,
			needs: { ...START_NEEDS }, bag: {}, action: null, last: null, said: null,
		} );

	} );
	return sim;

}

/** A saved game; throws when the save is from another version. */
export function loadGame( json: string, input: IslandInput ): Sim {

	const state = JSON.parse( json ) as SimState;
	if ( state.version !== SAVE_VERSION ) throw new Error( 'This save is from another version of the game' );
	return new Sim( state, input );

}
