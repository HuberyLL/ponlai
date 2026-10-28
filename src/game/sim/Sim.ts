import { actionTools, advanceAction, findWaysAgain } from './actions.ts';
import { act, perceive } from './agent.ts';
import type { Brain, ToolCall, ToolRegistry, ToolResult } from './agent.ts';
import { dayOf, hourOf } from './clock.ts';
import { Grid, topOf } from './grid.ts';
import { fallNeeds, START_NEEDS } from './needs.ts';
import { findPath, goalAt } from './path.ts';
import { BUILDING_KINDS, blueprintRefusal, newBuilding } from './buildings.ts';
import { obstructPlaces } from './places.ts';
import { random } from './rng.ts';
import { ageOf, drawLifespan, paceOf } from './life.ts';
import { SAVE_VERSION } from '../save.ts';
import { GROWTH_STEPS, POPULATION_START, SECONDS_PER_GAME_DAY, SECONDS_PER_YEAR, WALK_SPEED, piecesFor } from './types.ts';
import type { EntityId, IslandInput, SimState, Vec2, Villager } from './types.ts';
import type { Body, Sex } from '../../characters/Ages.ts';

// The island simulation: a fixed step of one game second, with every change kept in SimState, so
// a save is the state itself. One seeded generator (SimState.rng) is its only source of chance.
// The islanders are bodies on the ground grid with needs that fall (needs.ts), a bag (items.ts) and
// an action under way (actions.ts), and are places to one another (people.ts: they hear each other,
// give and follow); the places they act at (places.ts) keep their own state here too (the
// buildings). A brain may think for them (agent.ts) beside the world, never holding up a tick.
// The weather is the page's own: nothing in the simulation depends on it.
//
// Each tick: the needs fall, each body walks a step (at its age's pace) and its action advances,
// those who reached their lifespan die (life.ts), then the temporary trigger asks the brain for a
// thought for every islander with nothing under way (no action, no walk) and no thought in flight.
// A brain that answers at once (the stand-in) acts within the tick, so a game with it is
// deterministic for a seed; a slow one acts when it answers.
//
// The island grows with the population (docs/game-design.md, "How the island grows"): the
// population is the islanders' count, and each step of GROWTH_STEPS (types.ts) is one piece. The
// simulation only says when growth is due (`growthDue`) and how near the next step is
// (`approach`); the page grows the island (Game.ts `island`, world/Growth.ts), and the swap hands
// the new land back as `addPiece`, which opens its cells and counts the piece (SimState.pieces: the
// land step the game stands on, so a save loads its world at it). The piece to come is known ahead:
// its cells are `comingLand` from the moment the page has it, for planning.
//
// A new game starts with three grown islanders: a man, a woman and one of either, each 20 to 35
// years old, from the seed. An islander who dies leaves the roll for the list of the dead
// (SimState.dead), and ids are never reused.

export { SAVE_VERSION };
// the islanders' names by sex, the first that no living islander holds: Chinese, the language the
// interface is written in (docs/ui.md); a name is content kept in the save, not a word of the
// interface's catalogue (ui/i18n/)
const NAMES: Readonly<Record<Sex, readonly string[]>> = {
	male: [ '阿凯', '阿木', '石头', '阿海', '竹生', '阿林' ],
	female: [ '小禾', '阿青', '阿月', '小满', '阿岚', '阿珠' ],
};
// the ages of the islanders a game starts with, and of those the debug panel adds (years)
const GROWN = [ 20, 35 ] as const;
// islanders after the first stand round the island's middle a golden angle apart
const GOLDEN_ANGLE = Math.PI * ( 3 - Math.sqrt( 5 ) );

export class Sim {

	readonly state: SimState;
	readonly grid: Grid;
	/** the game runs at the day clock's own rate, or not at all */
	paused = false;
	/** fraction of the next tick already elapsed (0..1), for interpolating positions */
	alpha = 0;
	/** the tools a brain acts through, by name: the five actions (actions.ts) */
	tools: ToolRegistry = actionTools();
	/** what thinks for the islanders; null: nothing, they stand idle */
	brain: Brain | null = null;
	private carry = 0;
	/** the islanders with a thought in flight */
	private readonly thoughts = new Map<EntityId, Promise<ToolResult[]>>();
	/** the cells the next piece opens (1 per ground cell, on the grid's indices), once the page has
	 * the piece; null until then and after it arrived. Derived from the world, not saved. */
	comingLand: Uint8Array | null = null;

	constructor( state: SimState, input: IslandInput ) {

		this.state = state;
		this.grid = new Grid( input );
		obstructPlaces( this );

	}

	// ------------------------------------------------------------------ the island's growth

	/** the islanders' count, which the island's growth follows */
	population(): number {

		return this.state.villagers.length;

	}

	/** Whether the population has reached a step the island has not grown for yet. */
	growthDue(): boolean {

		return piecesFor( this.population() ) > this.state.pieces;

	}

	/** How near the population is to the next step, 0..1 (1: due); 0 past the last step. */
	approach(): number {

		const k = this.state.pieces;
		if ( k >= GROWTH_STEPS.length ) return 0;
		const from = k > 0 ? GROWTH_STEPS[ k - 1 ] : POPULATION_START;
		return Math.min( Math.max( ( this.population() - from ) / ( GROWTH_STEPS[ k ] - from ), 0 ), 1 );

	}

	/** The next piece is known (the page's pending land, Growth.ts): its cells become `comingLand`,
	 * those on its top not on the island's now. */
	setComing( input: IslandInput ): void {

		const next = topOf( input ), now = this.grid.top;
		const coming = new Uint8Array( next.length );
		for ( let k = 0; k < next.length; k ++ ) coming[ k ] = next[ k ] & ~ now[ k ] & 1;
		this.comingLand = coming;

	}

	/** The island grew by a piece (Growth.ts's swap): the ground of the new land (the grid only
	 * opens cells: every index, path and place stays valid), the game's obstacles on it again, every
	 * walk under way finds its way again, and the piece is counted. */
	addPiece( input: IslandInput ): void {

		this.grid.setIsland( input );
		obstructPlaces( this );
		findWaysAgain( this );
		this.state.pieces ++;
		this.comingLand = null;

	}

	/** A new islander of a sex and age, standing near the island's middle; what is not given is
	 * drawn: either sex, grown (20 to 35). Without a body it is the debug panel's population bump,
	 * as how islanders arrive is not designed yet. Returns its id. */
	addIslander( body: Partial<Body> = {} ): EntityId {

		const state = this.state, grid = this.grid, n = state.villagers.length;
		const sex = body.sex ?? ( this.random() < 0.5 ? 'male' : 'female' );
		const age = body.age ?? GROWN[ 0 ] + ( GROWN[ 1 ] - GROWN[ 0 ] ) * this.random();
		const a = n * GOLDEN_ANGLE;
		const k = grid.nearestOpen( grid.indexAt( Math.cos( a ) * 1.5, Math.sin( a ) * 1.5 ), 40, grid.main );
		if ( k < 0 ) throw new Error( 'No open ground near the island\'s centre' );
		const p = grid.centreOf( k );
		const count = n + state.dead.length;
		const pool = NAMES[ sex ], name = pool.find( ( x ) => ! state.villagers.some( ( v ) => v.name === x ) ) ?? pool[ count % pool.length ];
		const id = `v${ count + 1 }`;
		state.villagers.push( {
			id, name, look: count, sex, born: state.tick - Math.round( age * SECONDS_PER_YEAR ), lifespan: drawLifespan( state, sex, age ),
			pos: { ...p }, prev: { ...p }, heading: Math.atan2( - p.x, - p.z ), path: null,
			needs: { ...START_NEEDS }, bag: {}, action: null, last: null, said: null, gave: null, noticed: [],
		} );
		return id;

	}

	/** An islander's age (years) now, between ticks too (`alpha`), as the figures show it. */
	age( v: Readonly<Villager> ): number {

		return ageOf( v, this.state.tick + this.alpha );

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

	/** Run forward by real seconds at the day clock's rate (nothing while paused), given the day
	 * clock's length in real seconds; returns the game seconds (ticks) run. */
	advance( realSeconds: number, secondsPerDay: number ): number {

		if ( this.paused ) return 0;
		this.carry += realSeconds * SECONDS_PER_GAME_DAY / secondsPerDay;
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
		for ( const v of state.villagers ) {

			v.prev.x = v.pos.x;
			v.prev.z = v.pos.z;
			fallNeeds( v.needs );
			this.walk( v );
			advanceAction( this, v );

		}
		if ( state.villagers.some( ( v ) => ageOf( v, state.tick ) >= v.lifespan ) ) this.die();
		if ( ! this.brain ) return;
		for ( const v of state.villagers ) if ( ! v.action && ! v.path && ! this.thoughts.has( v.id ) ) this.think( v.id );

	}

	/** Those who reached their lifespan leave the roll for the list of the dead. */
	private die(): void {

		const state = this.state;
		state.villagers = state.villagers.filter( ( v ) => {

			if ( ageOf( v, state.tick ) < v.lifespan ) return true;
			state.dead.push( { id: v.id, name: v.name, sex: v.sex, born: v.born, died: state.tick } );
			return false;

		} );

	}

	// ------------------------------------------------------------------ bodies

	villager( id: EntityId ): Villager | undefined {

		return this.state.villagers.find( ( v ) => v.id === id );

	}

	/** An islander's name by id, the dead's included. */
	nameOf( id: EntityId ): string | undefined {

		return ( this.villager( id ) ?? this.state.dead.find( ( d ) => d.id === id ) )?.name;

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
		this.state.buildings.push( newBuilding( this.state, kind, x, z ) );
		this.grid.obstruct( x, z, BUILDING_KINDS[ kind ].radius );
		findWaysAgain( this );
		return null;

	}

	/** One game second along the body's path. */
	private walk( v: Villager ): void {

		const path = v.path;
		if ( ! path ) return;
		let left = WALK_SPEED * paceOf( v, this.state.tick );
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
		const perception = perceive( this, v );
		// what it noticed is the thought's once its answer is acted on, not before: a thought in flight
		// is not saved, and a loaded game asks again with the notices still there. Those that came
		// meanwhile stay for the next thought (by identity: the oldest may have been forgotten since)
		const taken = new Set( v.noticed );
		const answered = ( calls: ToolCall[] ) => {

			v.noticed = v.noticed.filter( ( n ) => ! taken.has( n ) );
			return act( this, v, calls );

		};
		const answer = this.brain.think( perception, v.id );
		if ( ! ( answer instanceof Promise ) ) return Promise.resolve( answered( answer ) );
		const thought = answer.then( answered ).finally( () => this.thoughts.delete( id ) );
		this.thoughts.set( id, thought );
		return thought;

	}

	save(): string {

		return JSON.stringify( this.state );

	}

}

/** A new game on an island grown by `pieces` (0: the starting island): its islanders standing
 * near the island's centre, facing it, a man, a woman and one of either, grown (`bodies` gives
 * others: the `bodies` URL option, Game.ts). */
export function newGame( input: IslandInput, options: { seed?: number; startHour?: number; pieces?: number; bodies?: readonly Body[] } = {} ): Sim {

	const seed = ( options.seed ?? 1 ) >>> 0;
	const sim = new Sim( { version: SAVE_VERSION, seed, tick: 0, startHour: options.startHour ?? 8, rng: seed, villagers: [], dead: [], buildings: [], placed: {}, pieces: options.pieces ?? 0 }, input );
	const bodies: readonly Partial<Body>[] = options.bodies?.length ? options.bodies : [ { sex: 'male' }, { sex: 'female' }, {} ];
	for ( const body of bodies ) sim.addIslander( body );
	return sim;

}

/** A saved game, from its state or that state's JSON (Sim.save); throws when it is from another
 * version (a whole save is read by ../save.ts readSave). */
export function loadGame( saved: string | SimState, input: IslandInput ): Sim {

	const state = typeof saved === 'string' ? JSON.parse( saved ) as SimState : saved;
	if ( state.version !== SAVE_VERSION ) throw new Error( 'This save is from another version of the game' );
	return new Sim( state, input );

}
