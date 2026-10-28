// Checks of the game's simulation, asserted: the clock and its ticks, the ground grid and a path
// over it, a body that walks to a point and stops there, a save that loads back as it was, a brain
// whose late answer is applied while the world ran on; then the first prototype's rules: needs that
// fall and rise (thirst off: hydration holds), fishing by the seeded generator and the bag's capacity,
// the chest placed as a blueprint and built, several of a kind with ids of their own, two
// islanders building one site, the island's stock (its stores) and a cost's shortfall, actions that replace each other, a perception
// without positions, the stand-in brain building the chest and keeping the islander fed for
// days, and a save taken mid-action; the islanders' lives (the starting three, ages that run a year
// a game day, lifespans drawn by Gompertz's law, a death noted in the record, a slower pace at the
// ends of life, ids never reused); the save file (the simulation and its record read back as
// written, a save of another version refused, and a record restored from a save that keeps the
// entries the original keeps, a game resumed at its start included); then the island's growth: a land grown by IslandGrowth, the population steps, the
// coming piece's cells, a step crossed adding exactly one piece, the grid opening cells without
// reindexing, islanders walking onto the new piece, the shore moving to the new coast as on a
// fresh load, and a save that keeps its piece count; then the islanders among themselves: words
// heard within earshot and noticed until the next thought, the others in sight by name, age and
// what they do, `do` naming its place, giving (and its refusals and record entry), going to someone
// who walks away, following until replaced or the one followed dies, the stand-in asking for food
// and being given it, and a save mid-follow that plays on the same; then the things on the ground,
// in the simulation's physics world: dropped fish that fall and come to rest on the island, apart,
// the same bit for bit over two runs, after a save taken mid-fall and whatever the ticks' split;
// taking one (refused for a full bag), going to one that slides; the sea taking what falls past
// the rim; a death's bag and a catch past a full bag on the ground; a walker pushing a resting
// fish; a grown island's new ground under resting things; the hungry stand-in picking one up
// before fishing; and the cost of a tick and of a save with things in it (printed, not asserted).
// Pure CPU; Node 22.18+ strips the imported TypeScript.
// Run: node tools/verify-game.mjs
import assert from 'node:assert/strict';
import { initPhysics } from '../src/game/sim/physics.ts';
import { newGame, loadGame } from '../src/game/sim/Sim.ts';
import { findPath, goalAt, lineClear } from '../src/game/sim/path.ts';
import { perceive } from '../src/game/sim/agent.ts';
import { HUNGRY_WORDS, StandInBrain, THANKS_WORDS } from '../src/game/sim/standin.ts';
import { EARSHOT, FOLLOW_GAP, NOTICED_KEPT, PERSON_REACH } from '../src/game/sim/people.ts';
import { BAG_CAPACITY, FISH_SATIETY } from '../src/game/sim/items.ts';
import { HYDRATION_PER_DAY, SATIETY_PER_DAY, START_NEEDS } from '../src/game/sim/needs.ts';
import { FISH_SECONDS, placesAt } from '../src/game/sim/places.ts';
import { CHEST_WORK, progressOf, stageOf } from '../src/game/sim/buildings.ts';
import { GROWTH_STEPS, POPULATION_START, SECONDS_PER_GAME_DAY, SECONDS_PER_YEAR, WALK_SPEED, piecesFor } from '../src/game/sim/types.ts';
import { ageOf, drawLifespan } from '../src/game/sim/life.ts';
import { hourOf } from '../src/game/sim/clock.ts';
import { SAVE_VERSION, readSave, savedPieces, writeSave } from '../src/game/save.ts';
import { Chronicle } from '../src/game/Chronicle.ts';
import { shortfall, stockOf } from '../src/game/sim/stock.ts';
import { shoreMask } from '../src/game/sim/ground.ts';
import { REACH, THING_KINDS, dropThing } from '../src/game/sim/things.ts';
import { input, inputAt } from './game-fixture.mjs';

await initPhysics();

const HOUR = 3600;

/** the open cell of the main ground farthest from a point */
function farthestOpen( grid, p ) {

	let best = - 1, bestD = - 1;
	for ( let k = 0; k < grid.open.length; k ++ ) {

		if ( grid.region[ k ] !== grid.main ) continue;
		const d = Math.hypot( grid.centreX( k ) - p.x, grid.centreZ( k ) - p.z );
		if ( d > bestD ) {

			best = k;
			bestD = d;

		}

	}
	return grid.centreOf( best );

}

// ------------------------------------------------------------------ clock and ticks

{

	const sim = newGame( input, { startHour: 8 } );
	assert.equal( sim.hour(), 8, 'a new game starts at its hour' );
	sim.step( HOUR );
	assert.equal( sim.state.tick, HOUR, 'one tick per game second' );
	assert.equal( sim.hour(), 9 );
	// at 1x a game day lasts the day clock's length: a 1440 s day runs 60 game seconds a real one
	assert.equal( sim.advance( 1, 1440 ), 60, 'the speed and the day length set the ticks per real second' );
	sim.speed = 0;
	assert.equal( sim.advance( 1, 1440 ), 0, 'a paused game runs no ticks' );
	sim.speed = 1;
	sim.step( 16 * HOUR );
	assert.equal( sim.day(), 1, 'the day turns at midnight' );
	const a = newGame( input, { seed: 7 } ), b = newGame( input, { seed: 7 } );
	assert.deepEqual( [ a.random(), a.random() ], [ b.random(), b.random() ], 'one seed, one sequence' );
	console.log( 'clock: ticks, speed, day and the seeded generator' );

}

// ------------------------------------------------------------------ the ground and a path

{

	const sim = newGame( input );
	const grid = sim.grid;
	assert.ok( grid.main >= 0, 'the island has open ground' );
	for ( const v of sim.state.villagers ) assert.equal( grid.region[ grid.indexAt( v.pos.x, v.pos.z ) ], grid.main, `${ v.name } stands on the main ground` );
	const from = sim.state.villagers[ 0 ].pos, to = farthestOpen( grid, from );
	const path = findPath( grid, from, goalAt( grid, to ) );
	assert.ok( path && path.length > 0, 'a path across the island' );
	let at = from;
	for ( const p of path ) {

		assert.ok( lineClear( grid, at, p ), 'every leg of the path stays on open ground' );
		at = p;

	}
	assert.ok( Math.hypot( at.x - to.x, at.z - to.z ) < 1e-9, 'the path ends at its point' );
	console.log( `ground: ${ grid.cols } x ${ grid.rows } cells, a path of ${ path.length } legs across` );

}

// ------------------------------------------------------------------ a body walks to a point and stops

{

	const sim = newGame( input );
	const v = sim.state.villagers[ 0 ];
	const to = farthestOpen( sim.grid, v.pos );
	assert.equal( sim.walkTo( v.id, to ), null, 'the body sets off' );
	assert.ok( v.path, 'it is walking' );
	let ticks = 0;
	while ( v.path && ticks < HOUR ) {

		sim.step( 1 );
		ticks ++;

	}
	assert.equal( v.path, null, 'it arrives' );
	assert.ok( Math.hypot( v.pos.x - to.x, v.pos.z - to.z ) < 1e-9, 'it stands at the point' );
	const there = { ...v.pos };
	sim.step( 600 );
	assert.deepEqual( v.pos, there, 'and stays there' );
	assert.equal( typeof sim.walkTo( v.id, { x: 1e4, z: 0 } ), 'string', 'a point off the island is refused with a reason' );
	console.log( `walk: arrived after ${ ticks } game seconds and stopped` );

}

// ------------------------------------------------------------------ save and load

{

	const sim = newGame( input, { seed: 4 } );
	const v = sim.state.villagers[ 0 ];
	sim.walkTo( v.id, farthestOpen( sim.grid, v.pos ) );
	sim.step( 20 );
	sim.random();
	const json = sim.save();
	const loaded = loadGame( json, input );
	assert.equal( loaded.save(), json, 'a loaded game saves back the same' );
	assert.deepEqual( loaded.grid.open, sim.grid.open, 'a loaded game rebuilds the same ground' );
	sim.step( 600 );
	loaded.step( 600 );
	assert.equal( loaded.save(), sim.save(), 'a loaded game goes on as the original, mid-walk' );
	assert.equal( loaded.random(), sim.random(), 'and draws the same numbers next' );
	assert.throws( () => loadGame( JSON.stringify( { ...JSON.parse( json ), version: 0 } ), input ), /version/ );
	console.log( `save: ${ json.length } bytes, loaded back the same and played on` );

}

// ------------------------------------------------------------------ a brain that answers later

{

	const sim = newGame( input );
	const v = sim.state.villagers[ 0 ];
	const far = farthestOpen( sim.grid, v.pos );
	let perceived = null;
	assert.equal( sim.walkTo( v.id, far ), null );
	sim.brain = { think: ( p ) => {

		perceived = p;
		return new Promise( ( resolve ) => setTimeout( () => resolve( [ { tool: 'go', args: { place: 'shore' } }, { tool: 'fly' } ] ), 5 ) );

	} };
	const tick = sim.state.tick, start = { ...v.pos };
	const thought = sim.think( v.id );
	assert.ok( thought && sim.thinking( v.id ), 'a thought is in flight' );
	assert.equal( perceived.body.hydration, 80, 'the brain perceives the islander' );
	assert.equal( sim.think( v.id ), null, 'one thought at a time' );
	sim.step( 120 );
	assert.equal( sim.state.tick, tick + 120, 'the world runs on while the brain thinks' );
	assert.ok( Math.hypot( v.pos.x - start.x, v.pos.z - start.z ) > 1, 'and the body keeps walking' );
	const results = await thought;
	assert.equal( sim.thinking( v.id ), false, 'the thought has landed' );
	assert.equal( results[ 0 ].ok, true, 'its tool call ran on the body' );
	assert.equal( results[ 1 ].ok, false, 'a tool that does not exist fails with a reason' );
	assert.equal( v.action.call.args.place, 'shore', 'the body now goes where the answer said' );
	sim.brain = null;
	assert.equal( sim.think( v.id ), null, 'without a brain nothing thinks' );
	console.log( 'brain: a late answer ran on the body while the world went on' );

}

// ------------------------------------------------------------------ the first prototype's rules

/** run one action on the islander and step until it ends; returns its outcome */
function run( sim, call, limit = 86400 ) {

	const v = sim.state.villagers[ 0 ];
	const begun = sim.tools.get( call.tool )( v, call.args, sim );
	if ( ! begun.ok ) return begun;
	for ( let t = 0; ( v.action || v.path ) && t < limit; t ++ ) sim.step( 1 );
	assert.equal( v.action, null, `${ call.tool } ends` );
	return v.last.result;

}

/** a chest placed at the first open ground that takes it, outward from the island's middle: its point and id */
function placeChest( sim ) {

	const grid = sim.grid;
	const cells = [];
	for ( let k = 0; k < grid.open.length; k ++ ) if ( grid.region[ k ] === grid.main ) cells.push( k );
	cells.sort( ( a, b ) => Math.hypot( grid.centreX( a ), grid.centreZ( a ) ) - Math.hypot( grid.centreX( b ), grid.centreZ( b ) ) || a - b );
	for ( const k of cells ) if ( sim.placeBlueprint( 'chest', grid.centreX( k ), grid.centreZ( k ) ) === null ) return { ...grid.centreOf( k ), id: sim.state.buildings.at( - 1 ).id };
	throw new Error( 'no ground took the chest' );

}

/** the chest placed and built by the islander, who stands at it after */
function buildChest( sim ) {

	const at = placeChest( sim );
	assert.equal( run( sim, { tool: 'go', args: { place: at.id } } ).ok, true );
	assert.deepEqual( run( sim, { tool: 'do', args: { action: 'build' } } ), { ok: true, value: `built ${ at.id }` } );
	return at;

}

// needs: satiety falls and eating raises it; thirst is off, so hydration holds
{

	const sim = newGame( input );
	const v = sim.state.villagers[ 0 ];
	const before = { ...v.needs };
	sim.step( HOUR );
	assert.equal( HYDRATION_PER_DAY, 0, 'thirst is off' );
	assert.equal( v.needs.hydration, before.hydration, 'hydration holds' );
	assert.ok( Math.abs( before.satiety - v.needs.satiety - SATIETY_PER_DAY / 24 ) < 1e-9, 'satiety falls by its hourly rate' );
	sim.step( 2 * 24 * HOUR );
	assert.deepEqual( v.needs, { satiety: 0, hydration: START_NEEDS.hydration }, 'satiety clamps at 0' );
	v.bag = { fish: 2 };
	assert.equal( run( sim, { tool: 'use', args: { item: 'fish' } } ).ok, true );
	assert.equal( v.needs.satiety, FISH_SATIETY, 'a fish raises satiety' );
	assert.deepEqual( v.bag, { fish: 1 }, 'using an item spends it' );
	v.needs.satiety = 95;
	run( sim, { tool: 'use', args: { item: 'fish' } } );
	assert.equal( v.needs.satiety, 100, 'needs top out at 100' );
	assert.equal( run( sim, { tool: 'use', args: { item: 'fish' } } ).ok, false, 'no fish to eat' );
	console.log( 'needs: satiety falls per tick, clamps, eating raises it; hydration holds' );

}

// fishing: takes a while, a fish by the seeded generator's chance
{

	const fishing = ( seed ) => {

		const sim = newGame( input, { seed } );
		const v = sim.state.villagers[ 0 ];
		assert.equal( run( sim, { tool: 'go', args: { place: 'shore' } } ).ok, true );
		const tick = sim.state.tick, catches = [];
		for ( let n = 0; n < 12; n ++ ) {

			v.bag = {};
			catches.push( run( sim, { tool: 'do', args: { action: 'fish' } } ).value );

		}
		assert.equal( sim.state.tick - tick, 12 * FISH_SECONDS, 'each try takes its while' );
		return catches;

	};
	const a = fishing( 5 );
	assert.deepEqual( fishing( 5 ), a, 'one seed, the same catches' );
	assert.ok( a.includes( 'caught a fish' ) && a.includes( 'caught nothing' ), 'a fish by chance' );
	assert.notDeepEqual( fishing( 6 ), a, 'another seed, other catches' );
	// the bag: fish stack up to its capacity, and a full bag refuses more
	const sim = newGame( input );
	const v = sim.state.villagers[ 0 ];
	run( sim, { tool: 'go', args: { place: 'shore' } } );
	v.bag = { fish: BAG_CAPACITY - 1 };
	for ( let n = 0; n < 50 && v.bag.fish < BAG_CAPACITY; n ++ ) run( sim, { tool: 'do', args: { action: 'fish' } } );
	assert.deepEqual( v.bag, { fish: BAG_CAPACITY }, 'items of a kind stack' );
	assert.deepEqual( run( sim, { tool: 'do', args: { action: 'fish' } } ), { ok: false, reason: 'the bag is full' }, 'a full bag refuses more' );
	console.log( `fishing: ${ a.filter( ( c ) => c === 'caught a fish' ).length } of 12 tries caught a fish; a full bag refused` );

}

// the chest: placed once on open ground, put and take
{

	const sim = newGame( input );
	const v = sim.state.villagers[ 0 ];
	assert.equal( typeof sim.placeBlueprint( 'chest', 1e4, 0 ), 'string', 'not off the island' );
	assert.equal( typeof sim.placeBlueprint( 'chest', v.pos.x, v.pos.z ), 'string', 'not on the islander' );
	assert.deepEqual( sim.state.buildings, [] );
	assert.equal( typeof sim.placeBlueprint( 'tower', 0, 0 ), 'string', 'no such kind' );
	const at = buildChest( sim );
	assert.ok( ! sim.grid.openAt( at.x, at.z ), 'it blocks its ground' );
	assert.equal( typeof sim.placeBlueprint( 'chest', at.x, at.z ), 'string', 'not on the chest' );
	run( sim, { tool: 'go', args: { place: 'shore' } } );
	assert.equal( perceive( sim, v ).seen.find( ( s ) => s.place === 'chest1' ).shows, undefined, 'its contents do not show from afar' );
	assert.equal( run( sim, { tool: 'go', args: { place: 'chest1' } } ).ok, true );
	v.bag = { fish: 3 };
	assert.equal( run( sim, { tool: 'do', args: { action: 'put', item: 'fish', count: 2 } } ).ok, true );
	assert.equal( run( sim, { tool: 'do', args: { action: 'put', item: 'fish', count: 2 } } ).ok, false, 'cannot put what the bag lacks' );
	assert.equal( run( sim, { tool: 'do', args: { action: 'put', item: 'stone' } } ).ok, false, 'no such item' );
	assert.deepEqual( sim.state.buildings[ 0 ].items, { fish: 2 } );
	assert.deepEqual( v.bag, { fish: 1 } );
	assert.deepEqual( perceive( sim, v ).seen.find( ( s ) => s.place === 'chest1' ).shows, { items: { fish: 2 } }, 'its contents show while at it' );
	assert.equal( run( sim, { tool: 'do', args: { action: 'take', item: 'fish', count: 3 } } ).ok, false, 'cannot take more than it holds' );
	assert.equal( run( sim, { tool: 'do', args: { action: 'take', item: 'fish' } } ).ok, true, 'one by default' );
	assert.deepEqual( sim.state.buildings[ 0 ].items, { fish: 1 } );
	assert.deepEqual( v.bag, { fish: 2 } );
	const json = sim.save();
	assert.deepEqual( loadGame( json, input ).grid.open, sim.grid.open, 'a loaded game blocks the same ground' );
	console.log( `chest: placed at ${ at.x }, ${ at.z }, refused elsewhere, put and take` );

}

// the chest as a blueprint: an unbuilt site with only `build`, built by work that survives an
// interruption and a save, then the chest's own options
{

	const sim = newGame( input, { seed: 3 } );
	const v = sim.state.villagers[ 0 ];
	const at = placeChest( sim );
	const site = sim.state.buildings[ 0 ];
	assert.deepEqual( site, { id: 'chest1', kind: 'chest', x: at.x, z: at.z, worked: 0, items: {}, collider: null } );
	assert.equal( stageOf( site ), 'planned' );
	assert.ok( ! sim.grid.openAt( at.x, at.z ), 'the site blocks its ground from the start' );
	assert.deepEqual( perceive( sim, v ).seen.find( ( s ) => s.place === 'chest1' ).shows, { construction: 0 }, 'a planned site shows as one, not begun' );
	assert.equal( run( sim, { tool: 'go', args: { place: 'chest1' } } ).ok, true );
	assert.deepEqual( perceive( sim, v ).atHand.find( ( h ) => h.place === 'chest1' ).options, [ 'build' ], 'an unbuilt site offers only build' );
	v.bag = { fish: 1 };
	assert.deepEqual( run( sim, { tool: 'do', args: { action: 'put', item: 'fish' } } ), { ok: false, reason: 'nothing here offers put' }, 'nothing goes in before it is built' );

	// work for a while, then a new action interrupts: the work done stays
	const part = 1000;
	assert.equal( sim.tools.get( 'do' )( v, { action: 'build' }, sim ).ok, true );
	sim.step( part );
	assert.equal( site.worked, part, 'a second of work a tick' );
	assert.equal( stageOf( site ), 'building' );
	assert.equal( sim.tools.get( 'wait' )( v, { seconds: 60 }, sim ).ok, true );
	sim.step( 60 );
	assert.equal( site.worked, part, 'the work done stays when the building stops' );
	assert.deepEqual( perceive( sim, v ).seen.find( ( s ) => s.place === 'chest1' ).shows, { construction: Math.floor( part / CHEST_WORK * 100 ) }, 'how far along, in percent' );

	// a save mid-build plays on as the original
	assert.equal( sim.tools.get( 'do' )( v, { action: 'build' }, sim ).ok, true );
	sim.step( 30 );
	const loaded = loadGame( sim.save(), input );
	assert.equal( loaded.save(), sim.save() );
	assert.deepEqual( loaded.grid.open, sim.grid.open, 'a loaded game blocks the site\'s ground' );
	const tick = sim.state.tick;
	for ( const game of [ sim, loaded ] ) {

		const body = game.state.villagers[ 0 ];
		while ( body.action ) game.step( 1 );
		assert.deepEqual( body.last.result, { ok: true, value: 'built chest1' } );

	}
	assert.equal( loaded.save(), sim.save(), 'a game saved mid-build finishes it the same' );
	assert.equal( part + 30 + sim.state.tick - tick, CHEST_WORK, 'building takes the kind\'s work in all' );
	assert.equal( stageOf( site ), 'built' );
	assert.equal( progressOf( site ), 1 );
	assert.deepEqual( perceive( sim, v ).atHand.find( ( h ) => h.place === 'chest1' ).options, [ 'put' ], 'the finished chest offers its own options' );
	assert.equal( perceive( sim, v ).seen.find( ( s ) => s.place === 'chest1' ).shows.construction, undefined, 'and shows no construction' );
	assert.deepEqual( run( sim, { tool: 'do', args: { action: 'build' } } ), { ok: false, reason: 'chest1 is built' }, 'build is closed' );
	assert.equal( run( sim, { tool: 'do', args: { action: 'put', item: 'fish' } } ).ok, true );
	assert.equal( run( sim, { tool: 'do', args: { action: 'take', item: 'fish' } } ).ok, true, 'put and take' );
	console.log( `blueprint: planned, built in ${ CHEST_WORK } s of work across an interruption and a save, then a chest` );

}

// several of a kind: each its own place with an id that is never reused and survives a save; two
// islanders on one site both end when it is built
{

	const sim = newGame( input, { seed: 5 } );
	const v = sim.state.villagers[ 0 ];
	const first = buildChest( sim ), second = placeChest( sim );
	assert.deepEqual( [ first.id, second.id ], [ 'chest1', 'chest2' ], 'ids: the kind and its count' );
	assert.equal( stageOf( sim.state.buildings[ 1 ] ), 'planned', 'the second is a site of its own' );
	assert.deepEqual( perceive( sim, v ).seen.filter( ( s ) => s.kind === 'chest' ).map( ( s ) => s.place ), [ 'chest1', 'chest2' ] );

	// a second islander, standing where the first does
	const other = structuredClone( v );
	other.id = 'v2';
	sim.state.villagers.push( other );
	assert.equal( run( sim, { tool: 'go', args: { place: second.id } } ).ok, true );
	other.pos = { ...v.pos };
	other.prev = { ...v.pos };
	const tools = sim.tools;
	assert.equal( tools.get( 'do' )( v, { action: 'build' }, sim ).ok, true );
	assert.equal( tools.get( 'do' )( other, { action: 'build' }, sim ).ok, true );
	const tick = sim.state.tick;
	while ( v.action || other.action ) {

		sim.step( 1 );
		assert.ok( sim.state.tick - tick <= CHEST_WORK, 'neither builder runs on past the work' );

	}
	const site = sim.state.buildings[ 1 ];
	assert.equal( site.worked, CHEST_WORK, 'no work beyond the kind\'s' );
	assert.ok( Math.abs( ( sim.state.tick - tick ) - CHEST_WORK / 2 ) <= 1, `two build it in half the time (${ sim.state.tick - tick } s)` );
	assert.deepEqual( [ v.last.result, other.last.result ].map( ( r ) => r.value ).sort(), [ 'built chest2', 'chest2 is built' ], 'both end, one finishing it, the other finding it done' );

	// a save keeps the ids and the count: the next chest is chest3
	const loaded = loadGame( sim.save(), input );
	assert.deepEqual( loaded.state.buildings.map( ( b ) => b.id ), [ 'chest1', 'chest2' ], 'ids stable across a save' );
	assert.equal( placeChest( loaded ).id, 'chest3' );
	assert.equal( new Set( loaded.state.buildings.map( ( b ) => b.id ) ).size, 3, 'ids unique' );
	console.log( `many: ${ loaded.state.buildings.map( ( b ) => b.id ).join( ', ' ) }; two builders finished a chest in ${ sim.state.tick - tick } s, both ended` );

}

// actions replace each other; a refused one replaces nothing
{

	const sim = newGame( input );
	const v = sim.state.villagers[ 0 ];
	const tools = sim.tools;
	assert.deepEqual( [ ...tools.keys() ].sort(), [ 'do', 'go', 'say', 'use', 'wait' ], 'exactly five actions' );
	assert.equal( tools.get( 'go' )( v, { place: 'shore' }, sim ).ok, true );
	assert.ok( v.path, 'walking' );
	assert.equal( tools.get( 'go' )( v, { place: 'moon' }, sim ).ok, false );
	assert.ok( v.path && v.action.call.args.place === 'shore', 'a refused action leaves the walk under way' );
	assert.equal( v.last.result.ok, false, 'but its refusal is perceived' );
	assert.equal( tools.get( 'wait' )( v, { seconds: 60 }, sim ).ok, true );
	assert.equal( v.path, null, 'a new action replaces the walk' );
	assert.equal( v.action.call.tool, 'wait' );
	assert.equal( tools.get( 'say' )( v, { words: 'Hello' }, sim ).ok, true );
	assert.equal( v.action.call.tool, 'wait', 'saying goes alongside the action under way' );
	assert.equal( v.last.result.ok, false, 'and leaves the last outcome as it was' );
	assert.deepEqual( v.said, { words: 'Hello', tick: sim.state.tick } );
	console.log( 'actions: five, a new one replaces the one under way, saying goes alongside' );

}

// perception: what a person perceives, never positions
{

	const sim = newGame( input );
	const v = sim.state.villagers[ 0 ];
	placeChest( sim );
	run( sim, { tool: 'go', args: { place: 'chest1' } } );
	const p = perceive( sim, v );
	const banned = new Set( [ 'x', 'z', 'pos', 'prev', 'path', 'heading', 'distance', 'cells' ] );
	const walk = ( o, at ) => {

		if ( typeof o !== 'object' || o === null ) return;
		for ( const [ key, value ] of Object.entries( o ) ) {

			assert.ok( ! banned.has( key ), `the perception holds no ${ key } (${ at })` );
			walk( value, `${ at }.${ key }` );

		}

	};
	walk( p, 'perception' );
	const numbers = JSON.stringify( p ).match( /-?\d+(\.\d+)?/g ).map( Number );
	assert.ok( numbers.every( ( n ) => Number.isInteger( n ) ), 'every number in it is a count, a need or the time' );
	assert.deepEqual( Object.keys( p ).sort(), [ 'atHand', 'body', 'last', 'noticed', 'seen', 'time' ] );
	assert.deepEqual( p.seen.map( ( s ) => `${ s.place } ${ s.kind }` ).sort(), [ 'chest1 chest', 'ground ground', 'shore shore', 'v2 person', 'v3 person' ], 'the whole small island is in sight, each place and the others by id and kind' );
	assert.equal( p.time.day, 1 );
	p.body.bag.fish = 99;
	assert.deepEqual( v.bag, {}, 'the perception is a copy' );
	console.log( 'perception: time, seen, at hand, body and the last outcome, no positions' );

}

// the stand-in brain keeps the islander fed for days, builds the chests placed and
// stocks the first, the same for a seed
{

	const days = 4;
	const play = ( seed, store ) => {

		const sim = newGame( input, { seed } );
		sim.brain = new StandInBrain();
		for ( let n = 0; n < store; n ++ ) placeChest( sim );
		const v = sim.state.villagers[ 0 ];
		let low = 100, built = - 1;
		for ( let t = 0; t < days * 24 * HOUR; t ++ ) {

			sim.step( 1 );
			if ( built < 0 && store && sim.state.buildings.every( ( b ) => stageOf( b ) === 'built' ) ) built = sim.state.tick;
			// from the first evening on: it starts at 80 with nothing in the bag
			if ( t > 12 * HOUR ) low = Math.min( low, v.needs.satiety, v.needs.hydration );

		}
		return { sim, low, built };

	};
	const bare = play( 2, 0 ), stocked = play( 2, 2 );
	assert.ok( bare.low > 45, `needs kept up without a chest (lowest ${ bare.low.toFixed( 1 ) })` );
	assert.ok( stocked.low > 45, `needs kept up with a chest (lowest ${ stocked.low.toFixed( 1 ) })` );
	assert.ok( stocked.built > 0 && stocked.built < 24 * HOUR, `it builds both placed chests on the first day (by ${ ( stocked.built / HOUR ).toFixed( 1 ) } h)` );
	const items = stocked.sim.state.buildings[ 0 ].items;
	assert.ok( ( items.fish ?? 0 ) > 0, 'and it stocks the chest a little' );
	assert.equal( play( 2, 2 ).sim.save(), stocked.sim.save(), 'deterministic for a seed' );
	// the island's stock is what its stores hold, not what the islander carries (the interface's top row)
	const stock = stockOf( stocked.sim.state );
	const stored = {};
	for ( const b of stocked.sim.state.buildings ) for ( const kind in b.items ) stored[ kind ] = ( stored[ kind ] ?? 0 ) + b.items[ kind ];
	assert.deepEqual( stock, stored, 'the stock sums the stores' );
	assert.deepEqual( stockOf( bare.sim.state ), {}, 'with no store the island holds nothing, whatever the bag holds' );
	assert.deepEqual( shortfall( { fish: stock.fish }, stock ), {}, 'a cost the stock meets lacks nothing' );
	assert.deepEqual( shortfall( { fish: stock.fish + 2, wood: 3 }, stock ), { fish: 2, wood: 3 }, 'a shortfall names each kind and how many more' );
	console.log( `stand-in: ${ days } days, needs never below ${ Math.min( bare.low, stocked.low ).toFixed( 1 ) }; two chests built by ${ ( stocked.built / HOUR ).toFixed( 1 ) } h, holds ${ JSON.stringify( items ) }; the stock and its shortfall` );

}

// a save taken mid-action plays on as the original
{

	for ( const [ what, call ] of [ [ 'fishing', { tool: 'do', args: { action: 'fish' } } ], [ 'walking', { tool: 'go', args: { place: 'shore' } } ] ] ) {

		const sim = newGame( input, { seed: 11 } );
		const v = sim.state.villagers[ 0 ];
		if ( what === 'fishing' ) run( sim, { tool: 'go', args: { place: 'shore' } } );
		sim.brain = new StandInBrain();
		assert.equal( sim.tools.get( call.tool )( v, call.args, sim ).ok, true );
		sim.step( 30 );
		assert.deepEqual( v.action.call.args, { ...call.args, ...( what === 'fishing' ? { place: 'shore' } : {} ) }, `mid-${ what }` );
		const loaded = loadGame( sim.save(), input );
		loaded.brain = new StandInBrain();
		assert.equal( loaded.save(), sim.save() );
		sim.step( 2 * 24 * HOUR );
		loaded.step( 2 * 24 * HOUR );
		assert.equal( loaded.save(), sim.save(), `a game saved mid-${ what } plays on as the original` );

	}
	console.log( 'save: mid-action, loaded back and played on for two days the same' );

}

// ------------------------------------------------------------------ the islanders' lives

{

	// the starting three: a man, a woman and one of either, grown, named by sex
	for ( let seed = 1; seed <= 20; seed ++ ) {

		const sim = newGame( input, { seed } );
		const [ a, b, c ] = sim.state.villagers;
		assert.deepEqual( [ a.sex, b.sex ], [ 'male', 'female' ], 'a man and a woman' );
		assert.ok( c.sex === 'male' || c.sex === 'female' );
		for ( const v of sim.state.villagers ) {

			assert.ok( sim.age( v ) >= 20 && sim.age( v ) <= 35, `${ v.name } is grown (${ sim.age( v ).toFixed( 1 ) })` );
			assert.ok( v.lifespan > sim.age( v ), 'and lives on' );

		}
		assert.equal( new Set( sim.state.villagers.map( ( v ) => v.name ) ).size, 3, 'three names' );

	}
	const sim = newGame( input, { seed: 9 } );
	const v = sim.state.villagers[ 0 ], age0 = sim.age( v );
	sim.step( SECONDS_PER_GAME_DAY );
	assert.ok( Math.abs( sim.age( v ) - age0 - 1 ) < 1e-9, 'a game day is a year' );
	assert.deepEqual( newGame( input, { bodies: [ { sex: 'female', age: 6 }, { sex: 'male', age: 80 } ] } ).state.villagers.map( ( u ) => [ u.sex, Math.round( ageOf( u, 0 ) ) ] ), [ [ 'female', 6 ], [ 'male', 80 ] ], 'a new game with the bodies asked for' );

	// lifespans: Gompertz's law, a man's drawn at 20 averaging about 82, a woman's about 88, none
	// before the age drawn at
	const draws = { male: [], female: [] }, rng = { rng: 12345 };
	for ( const sex of [ 'male', 'female' ] ) for ( let k = 0; k < 20000; k ++ ) draws[ sex ].push( drawLifespan( rng, sex, 20 ) );
	const mean = ( xs ) => xs.reduce( ( s, x ) => s + x, 0 ) / xs.length;
	const [ man, woman ] = [ mean( draws.male ), mean( draws.female ) ];
	assert.ok( man > 81 && man < 83 && woman > 87 && woman < 89, `mean lifespans at 20: ${ man.toFixed( 1 ) }, ${ woman.toFixed( 1 ) }` );
	assert.ok( Math.min( ...draws.male, ...draws.female ) >= 20, 'none dies before the age it was drawn at' );
	for ( let k = 0; k < 1000; k ++ ) assert.ok( drawLifespan( rng, 'male', 95 ) >= 95 );

	// the old and the young walk slower
	const pace = ( age ) => {

		const g = newGame( input, { seed: 4, bodies: [ { sex: 'male', age } ] } );
		const u = g.state.villagers[ 0 ], from = { ...u.pos };
		g.walkTo( u.id, farthestOpen( g.grid, u.pos ) );
		g.step( 10 );
		return Math.hypot( u.pos.x - from.x, u.pos.z - from.z ) / 10;

	};
	assert.ok( Math.abs( pace( 30 ) - WALK_SPEED ) < 1e-9, 'an adult walks at the walking speed' );
	assert.ok( pace( 85 ) < 0.8 * WALK_SPEED && pace( 4 ) < 0.8 * WALK_SPEED, 'the old and a small child slower' );

	// a death: the islander leaves the roll for the list of the dead at its lifespan, the record
	// notes it at the tick it died at and names it, and a newcomer takes a new id
	const record = new Chronicle();
	record.observe( sim, 'fair', 0 );
	const dying = sim.state.villagers[ 1 ];
	dying.lifespan = sim.age( dying ) + 0.5;
	for ( let t = 0; t < 2; t ++ ) {

		sim.step( 12 * HOUR );
		record.observe( sim, 'fair', 0 );

	}
	assert.equal( sim.villager( dying.id ), undefined, 'the dead leave the roll' );
	assert.equal( sim.population(), 2 );
	const dead = sim.state.dead[ 0 ];
	assert.equal( dead.id, dying.id );
	assert.ok( Math.abs( ( dead.died - dead.born ) / SECONDS_PER_YEAR - dying.lifespan ) < 2 / SECONDS_PER_YEAR, 'at its lifespan' );
	assert.equal( sim.nameOf( dying.id ), dying.name, 'still named' );
	const noted = record.entries.filter( ( e ) => e.kind === 'died' );
	assert.equal( noted.length, 1, 'the record notes the death once' );
	assert.equal( noted[ 0 ].who, dying.id );
	assert.equal( noted[ 0 ].text, String( Math.floor( dying.lifespan ) ) );
	assert.equal( noted[ 0 ].minute, Math.floor( hourOf( { tick: dead.died, startHour: sim.state.startHour } ) * 60 ), 'at the minute it died' );
	const id = sim.addIslander();
	assert.ok( id !== dying.id && ! sim.state.villagers.slice( 0, - 1 ).some( ( u ) => u.id === id ), 'a newcomer takes an id never used' );
	const loaded = loadGame( sim.save(), input );
	sim.step( 2 * HOUR );
	loaded.step( 2 * HOUR );
	assert.equal( loaded.save(), sim.save(), 'a game with its dead loads back and plays on the same' );
	console.log( `lives: the starting three grown, a year a game day; mean lifespans at 20 of ${ man.toFixed( 1 ) } (men) and ${ woman.toFixed( 1 ) } (women); a slower pace young and old; a death noted and named` );

}

// the save file: the simulation and its record (Chronicle) read back as written; a record restored
// and watching the same ticks keeps the entries the original keeps, a need noted before the save not
// noted again, a landing not noted again on a game resumed at its start; a save of another version
// refused
{

	// the page's frames: the simulation runs a minute, then the record looks (the sky by the day)
	const watch = ( sim, record, seconds ) => {

		for ( let t = 0; t < seconds; t += 60 ) {

			sim.step( 60 );
			record.observe( sim, sim.day() % 2 ? 'cloudy' : 'fair', 60 / HOUR );

		}

	};
	const sim = newGame( input, { seed: 2 } );
	sim.brain = new StandInBrain();
	const record = new Chronicle();
	record.observe( sim, 'fair', 0 );
	placeChest( sim );
	watch( sim, record, 30 * HOUR );
	record.add( sim, { kind: 'said', who: 'player', to: 'all', text: 'words' } );
	sim.state.villagers[ 0 ].needs.satiety = 5;
	watch( sim, record, 60 );
	const kinds = new Set( record.entries.map( ( e ) => e.kind ) );
	for ( const kind of [ 'landed', 'placed', 'built', 'said', 'need' ] ) assert.ok( kinds.has( kind ), `the record holds a ${ kind } entry` );
	assert.deepEqual( record.save().alerted, [ `${ sim.state.villagers[ 0 ].id }:satiety` ], 'and the need it noted' );
	// saved between the line and its re-arm: noted already, as the save must say
	sim.state.villagers[ 0 ].needs.satiety = 25;
	record.observe( sim, 'cloudy', 0 );

	const json = writeSave( sim.snapshot(), record.save() );
	const save = readSave( json );
	assert.equal( save.version, SAVE_VERSION );
	assert.equal( JSON.stringify( save.sim ), sim.save(), 'the save holds the simulation\'s state' );
	assert.equal( JSON.stringify( save.record ), JSON.stringify( record.save() ), 'and the record' );
	assert.equal( savedPieces( json ), 0 );
	const loaded = loadGame( save.sim, input );
	loaded.brain = new StandInBrain();
	const restored = new Chronicle();
	restored.restore( save.record );
	restored.observe( loaded, 'cloudy', 0 );
	assert.equal( JSON.stringify( restored.save() ), JSON.stringify( record.save() ), 'the first look at the loaded game notes nothing again' );
	assert.deepEqual( [ ...restored.landed ], [ ...record.landed ], 'the landings come back' );
	for ( const [ game, book ] of [ [ sim, record ], [ loaded, restored ] ] ) {

		game.state.villagers[ 0 ].needs.satiety = 10;
		book.observe( game, 'cloudy', 0 );

	}
	assert.equal( JSON.stringify( restored.save() ), JSON.stringify( record.save() ), 'a need noted before the save is not noted again' );
	watch( sim, record, 2 * 24 * HOUR );
	watch( loaded, restored, 2 * 24 * HOUR );
	assert.equal( loaded.save(), sim.save() );
	assert.equal( JSON.stringify( restored.save() ), JSON.stringify( record.save() ), 'a restored record keeps the entries the original keeps' );

	// a game saved before its first tick (?game&paused) and resumed again and again: each islander
	// landed once
	{

		const fresh = newGame( input, { seed: 5 } );
		let book = new Chronicle(), file;
		book.observe( fresh, 'fair', 0 );
		for ( let load = 0; load < 3; load ++ ) {

			file = readSave( writeSave( fresh.snapshot(), book.save() ) );
			book = new Chronicle();
			book.restore( file.record );
			book.observe( loadGame( file.sim, input ), 'fair', 0 );

		}
		assert.equal( book.entries.filter( ( e ) => e.kind === 'landed' ).length, fresh.population(), 'a game resumed at its start keeps one landing per islander' );

	}

	// a save of another version, older or newer, is not read (the page sets it aside)
	const older = { ...save, version: SAVE_VERSION - 1, sim: { ...save.sim, version: SAVE_VERSION - 1 } };
	for ( const bad of [ null, '', 'not json', '[]', '{}', JSON.stringify( older ), JSON.stringify( { ...save, version: SAVE_VERSION + 1 } ), JSON.stringify( { ...save, sim: null } ) ] ) {

		assert.equal( readSave( bad ), null, `refused: ${ String( bad ).slice( 0, 40 ) }` );

	}
	assert.equal( savedPieces( JSON.stringify( older ) ), null );
	console.log( `save file: ${ json.length } bytes with ${ record.entries.length } record entries, read back and played on two days the same, record included; other versions refused` );

}

// ------------------------------------------------------------------ the island's growth

{

	// the steps: one piece per 2 islanders above the starting 3, none below
	assert.equal( GROWTH_STEPS[ 0 ], POPULATION_START + 2 );
	assert.deepEqual( [ 1, 4, 5, 6, 7, 8 ].map( piecesFor ), [ 0, 0, 1, 1, 2, 2 ], 'a piece per step reached' );
	assert.equal( piecesFor( 1e6 ), GROWTH_STEPS.length, 'no piece past the growth horizon' );

	// a fixture land from IslandGrowth: the next step's land holds the starting island's and more
	const next = inputAt( 1 );
	let gained = 0;
	for ( let j = 0; j < 768; j ++ ) for ( let i = 0; i < 768; i ++ ) {

		if ( input.land.has( i, j ) ) assert.ok( next.land.has( i, j ), 'a piece never takes land away' );
		else if ( next.land.has( i, j ) ) gained ++;

	}
	assert.ok( gained * 0.0625 > 50, `the piece adds land (${ gained * 0.0625 } m^2)` );

	const sim = newGame( input, { seed: 3 } );
	assert.equal( sim.state.pieces, 0 );
	assert.equal( sim.population(), POPULATION_START );
	const grid = sim.grid, top0 = grid.top.slice(), dims = [ grid.cols, grid.rows, grid.x0, grid.z0 ];
	// the shore as the islanders know it before the growth (they fish there)
	const shore0 = shoreMask( grid ).slice();
	const kai = sim.state.villagers[ 0 ], kaiCell = grid.indexAt( kai.pos.x, kai.pos.z );
	// a chest's cell, as indexed before the growth
	const chest = placeChest( sim ), chestCell = grid.indexAt( chest.x, chest.z );
	assert.ok( ! grid.open[ chestCell ], 'the chest blocks its ground' );

	// the population approaches the step: 3 islanders are at the start; 4 halfway; 5 due
	sim.addIslander();
	assert.equal( sim.growthDue(), false, '4 islanders: no growth yet' );
	assert.equal( sim.approach(), 0.5, '4 islanders: halfway to the first step' );
	for ( const v of sim.state.villagers ) assert.equal( grid.region[ grid.indexAt( v.pos.x, v.pos.z ) ], grid.main, `${ v.name } arrives on the main ground` );
	assert.equal( new Set( sim.state.villagers.map( ( v ) => v.id ) ).size, 4, 'each islander an id of its own' );

	// the coming piece's cells, exposed once the page has the piece
	assert.equal( sim.comingLand, null, 'no coming land before the page has the piece' );
	sim.setComing( next );
	const coming = sim.comingLand;
	let comingCells = 0;
	for ( let k = 0; k < coming.length; k ++ ) if ( coming[ k ] ) {

		comingCells ++;
		assert.equal( top0[ k ], 0, 'a coming cell is not on the island yet' );

	}
	assert.ok( comingCells * 0.25 > 20, `the coming land has cells (${ comingCells * 0.25 } m^2)` );

	// a path planned before the growth, across the island
	const far = farthestOpen( grid, kai.pos );
	sim.walkTo( kai.id, far );
	const planned = kai.path.map( ( p ) => grid.indexAt( p.x, p.z ) );

	// a population crossing the step: the page's loop (Game.update) grows once while due, and the
	// swap hands the land back as addPiece; then nothing more is due
	sim.addIslander();
	assert.equal( sim.approach(), 1 );
	let grows = 0;
	for ( let frame = 0; frame < 120; frame ++ ) {

		if ( sim.growthDue() ) {

			grows ++;
			sim.addPiece( next );

		}
		sim.step( 10 );

	}
	assert.equal( grows, 1, 'a step crossed grows exactly one piece' );
	assert.equal( sim.state.pieces, 1 );
	assert.equal( sim.approach(), 0, '5 islanders: the start of the next step' );
	assert.equal( sim.comingLand, null, 'the coming land arrived' );

	// the grid opens cells without reindexing: the same lattice, every cell on the top before still
	// on it, the coming cells now on it, the chest's cell still blocked, the planned path walkable
	assert.deepEqual( [ grid.cols, grid.rows, grid.x0, grid.z0 ], dims, 'the grid keeps its lattice' );
	assert.equal( sim.grid, grid, 'the same grid object' );
	let opened = 0;
	for ( let k = 0; k < top0.length; k ++ ) {

		if ( top0[ k ] ) assert.equal( grid.top[ k ], 1, 'a cell on the island stays on it' );
		if ( coming[ k ] ) {

			assert.equal( grid.top[ k ], 1, 'a coming cell is on the island' );
			opened ++;

		}

	}
	assert.equal( opened, comingCells );
	assert.equal( grid.indexAt( chest.x, chest.z ), chestCell );
	assert.ok( ! grid.open[ chestCell ], 'the chest still blocks its ground' );
	assert.equal( grid.region[ kaiCell ] >= 0, true );
	for ( const k of planned ) assert.equal( grid.top[ k ], 1, 'a path planned before stays on the island' );

	// islanders walk onto the new piece: the open coming cell of the main ground farthest from the first islander
	let target = - 1, best = - 1;
	for ( let k = 0; k < coming.length; k ++ ) {

		if ( ! coming[ k ] || grid.region[ k ] !== grid.main ) continue;
		const d = Math.hypot( grid.centreX( k ) - kai.pos.x, grid.centreZ( k ) - kai.pos.z );
		if ( d > best ) { best = d; target = k; }

	}
	assert.ok( target >= 0, 'the new piece joins the main ground' );
	for ( const v of sim.state.villagers ) {

		v.action = null;
		assert.equal( sim.walkTo( v.id, grid.centreOf( target ) ), null, `${ v.name } sets off onto the new piece` );

	}
	sim.brain = null;
	sim.step( 3600 );
	for ( const v of sim.state.villagers ) assert.ok( coming[ grid.indexAt( v.pos.x, v.pos.z ) ] || Math.hypot( v.pos.x - grid.centreX( target ), v.pos.z - grid.centreZ( target ) ) < 1.5, `${ v.name } stands on the new piece` );

	// a save keeps its piece count, and loads back on its land at it
	const json = sim.save(), file = writeSave( sim.snapshot(), new Chronicle().save() );
	assert.equal( savedPieces( file ), 1, 'the save stands on one piece' );
	assert.equal( savedPieces( JSON.stringify( { ...JSON.parse( file ), version: SAVE_VERSION + 1 } ) ), null, 'a save no step reaches stands on none' );
	assert.equal( savedPieces( null ), null );
	const loaded = loadGame( json, next );
	assert.equal( loaded.state.pieces, 1 );
	assert.equal( loaded.save(), json, 'a grown game loads back the same' );
	assert.deepEqual( loaded.grid.open, grid.open, 'and rebuilds the same ground on its land' );
	assert.equal( loaded.growthDue(), false );
	loaded.step( 600 );
	sim.step( 600 );
	assert.equal( loaded.save(), sim.save(), 'and plays on as the original' );
	// the shore follows the new coast: a grown game's is a fresh load's, and the islanders fishing and
	// stocking on it play on the same in both
	assert.deepEqual( shoreMask( sim.grid ), shoreMask( loaded.grid ), 'the grown game\'s shore is a fresh load\'s' );
	let newShore = 0, inland = 0;
	for ( let k = 0; k < coming.length; k ++ ) {

		if ( shoreMask( sim.grid )[ k ] && ! top0[ k ] ) newShore ++;
		if ( shore0[ k ] && ! shoreMask( sim.grid )[ k ] ) inland ++;

	}
	assert.ok( newShore > 0 && inland > 0, 'the shore runs along the new piece, and the old coast it met is inland' );
	sim.brain = new StandInBrain();
	loaded.brain = new StandInBrain();
	sim.step( 24 * HOUR );
	loaded.step( 24 * HOUR );
	assert.equal( loaded.save(), sim.save(), 'and the islanders play on as on a fresh load, a day of fishing included' );

	// a new game on a grown island starts at its piece count
	assert.equal( newGame( next, { pieces: 1 } ).state.pieces, 1 );
	console.log( `growth: ${ ( gained * 0.0625 ).toFixed( 0 ) } m^2 of land, ${ comingCells } coming cells opened at 5 islanders, one piece, ${ sim.population() } islanders walked onto it; the shore moved (${ newShore } cells on the piece, ${ inland } inland); saved at 1 piece and loaded back` );

}

// ------------------------------------------------------------------ the islanders among themselves

const adults = [ { sex: 'male', age: 30 }, { sex: 'female', age: 30 }, { sex: 'male', age: 30 } ];
const dist = ( p, q ) => Math.hypot( p.x - q.x, p.z - q.z );
const act = ( sim, v, tool, args ) => sim.tools.get( tool )( v, args, sim );
/** stand a body on the centre of the open main cell whose centre lies nearest d metres from p */
const standAt = ( sim, v, p, d ) => {

	const grid = sim.grid;
	let best = - 1, err = Infinity;
	for ( let k = 0; k < grid.open.length; k ++ ) {

		if ( grid.region[ k ] !== grid.main ) continue;
		const e = Math.abs( Math.hypot( grid.centreX( k ) - p.x, grid.centreZ( k ) - p.z ) - d );
		if ( e < err ) { err = e; best = k; }

	}
	const c = grid.centreOf( best );
	v.pos = { ...c };
	v.prev = { ...c };
	v.path = null;
	v.action = null;
	return c;

};
/** what a brain is handed for an islander: a thought by a brain that only looks */
const perceived = ( sim, v ) => {

	let seen = null;
	sim.brain = { think: ( p ) => { seen = p; return []; } };
	sim.think( v.id );
	sim.brain = null;
	return seen;

};

{

	// hearing: within earshot, the others only, noticed until the next thought, at most NOTICED_KEPT
	{

		const sim = newGame( input, { seed: 3, bodies: adults } );
		const [ a, b, c ] = sim.state.villagers;
		standAt( sim, b, a.pos, 8 );
		standAt( sim, c, a.pos, EARSHOT + 5 );
		assert.ok( dist( a.pos, c.pos ) > EARSHOT && dist( a.pos, b.pos ) < EARSHOT );
		sim.step( 10 );
		assert.equal( act( sim, a, 'say', { words: 'hello' } ).ok, true );
		assert.deepEqual( b.noticed, [ { who: a.id, tick: sim.state.tick, said: 'hello' } ], 'heard within earshot' );
		assert.deepEqual( a.noticed, [], 'not by the speaker' );
		assert.deepEqual( c.noticed, [], 'not by one out of earshot' );
		const minutes = Math.floor( sim.hour() * 60 );
		assert.deepEqual( perceived( sim, b ).noticed, [ { who: a.id, name: a.name, time: { day: 1, hour: Math.floor( minutes / 60 ), minute: minutes % 60 }, said: 'hello' } ], 'perceived with the speaker\'s name and the time' );
		assert.deepEqual( b.noticed, [], 'and gone once perceived' );
		assert.deepEqual( perceived( sim, b ).noticed, [], 'the next thought hears nothing again' );
		for ( let n = 0; n < NOTICED_KEPT + 2; n ++ ) act( sim, a, 'say', { words: `w${ n }` } );
		assert.deepEqual( b.noticed.map( ( x ) => x.said ), Array.from( { length: NOTICED_KEPT }, ( _, n ) => `w${ n + 2 }` ), `at most ${ NOTICED_KEPT } kept, the oldest forgotten` );
		// a thought in flight is not saved: what it perceived stays noticed until its answer is acted
		// on, so a game saved meanwhile and loaded perceives it again; what came meanwhile stays after
		perceived( sim, b );
		act( sim, a, 'say', { words: 'one' } );
		let answer = null, slow = null;
		sim.brain = { think: ( p ) => { slow = p; return new Promise( ( resolve ) => { answer = resolve; } ); } };
		const thought = sim.think( b.id );
		sim.brain = null;
		assert.deepEqual( slow.noticed.map( ( x ) => x.said ), [ 'one' ] );
		act( sim, a, 'say', { words: 'two' } );
		const loaded = loadGame( sim.save(), input );
		const lb = loaded.villager( b.id );
		assert.deepEqual( lb.noticed.map( ( x ) => x.said ), [ 'one', 'two' ], 'saved with a thought in flight: still noticed' );
		assert.deepEqual( perceived( loaded, lb ).noticed.map( ( x ) => x.said ), [ 'one', 'two' ], 'and perceived again once loaded' );
		answer( [] );
		await thought;
		assert.deepEqual( b.noticed.map( ( x ) => x.said ), [ 'two' ], 'the answer takes what its thought perceived, and no more' );
		console.log( `hearing: within ${ EARSHOT } m by the others, perceived once with name and time, ${ NOTICED_KEPT } kept; kept through a save with a thought in flight` );

	}

	// people in sight, never oneself; `do` naming its place
	{

		const sim = newGame( input, { seed: 3, bodies: adults } );
		const [ a, b ] = sim.state.villagers;
		const chest = buildChest( sim );
		run( sim, { tool: 'go', args: { place: 'shore' } } );
		standAt( sim, b, a.pos, 1 );
		act( sim, b, 'wait', { seconds: 600 } );
		const p = perceive( sim, a );
		assert.deepEqual( p.seen.find( ( s ) => s.place === b.id ), { place: b.id, kind: 'person', shows: { name: b.name, age: Math.floor( sim.age( b ) ), doing: 'wait' } }, 'a person shows name, age and doing' );
		assert.ok( ! p.seen.some( ( s ) => s.place === a.id ) && ! p.atHand.some( ( h ) => h.place === a.id ), 'never oneself' );
		assert.equal( p.seen.find( ( s ) => s.place === chest.id ).shows, undefined, 'a chest\'s contents not from afar' );
		assert.deepEqual( p.atHand.find( ( h ) => h.place === b.id ).options, [ 'give', 'follow' ], 'beside someone: give and follow' );
		standAt( sim, b, a.pos, 6 );
		assert.deepEqual( act( sim, b, 'go', { place: chest.id } ), { ok: true, value: 'under way' } );
		assert.equal( perceive( sim, a ).seen.find( ( s ) => s.place === b.id ).shows.doing, 'go' );
		sim.walkTo( b.id, a.pos );
		assert.equal( perceive( sim, a ).seen.find( ( s ) => s.place === b.id ).shows.doing, 'walk', 'a walk without an action' );
		standAt( sim, b, a.pos, 1 );
		a.bag = { fish: 1 };
		assert.deepEqual( act( sim, a, 'do', { action: 'give', place: chest.id, item: 'fish' } ), { ok: false, reason: `not at ${ chest.id }` }, 'a place not at hand is refused' );
		assert.deepEqual( act( sim, a, 'do', { action: 'fish', place: b.id } ), { ok: false, reason: `${ b.id } does not offer fish` } );
		assert.equal( act( sim, a, 'do', { action: 'fish', place: 'shore' } ).ok, true, 'a place at hand runs it' );
		assert.equal( a.action.call.args.place, 'shore' );
		assert.deepEqual( act( sim, a, 'do', { action: 'give', place: b.id, item: 'fish' } ), { ok: true, value: `gave 1 fish to ${ b.id }` } );
		console.log( 'people: seen by name, age and doing, never oneself; do runs at the place it names' );

	}

	// giving: the items move, the receiver notices, the record notes it; refused whole
	{

		const sim = newGame( input, { seed: 4, bodies: adults } );
		const [ a, b ] = sim.state.villagers;
		standAt( sim, b, a.pos, 1 );
		const record = new Chronicle();
		record.observe( sim, 'fair', 0 );
		a.bag = { fish: 3 };
		b.bag = { fish: BAG_CAPACITY - 1 };
		assert.deepEqual( act( sim, a, 'do', { action: 'give', place: b.id, item: 'fish', count: 2 } ), { ok: false, reason: `${ b.id }'s bag has no room for that` } );
		assert.deepEqual( [ a.bag, b.bag, a.gave ], [ { fish: 3 }, { fish: BAG_CAPACITY - 1 }, null ], 'nothing moves' );
		b.bag = {};
		assert.deepEqual( act( sim, a, 'do', { action: 'give', item: 'fish', count: 2 } ), { ok: true, value: `gave 2 fish to ${ b.id }` }, 'unnamed: the person at hand' );
		assert.deepEqual( [ a.bag, b.bag ], [ { fish: 1 }, { fish: 2 } ], 'the items move' );
		assert.deepEqual( b.noticed, [ { who: a.id, tick: sim.state.tick, gave: { fish: 2 } } ], 'the receiver notices the gift' );
		assert.deepEqual( a.gave, { to: b.id, item: 'fish', count: 2, tick: sim.state.tick } );
		assert.deepEqual( act( sim, a, 'do', { action: 'give', place: b.id, item: 'fish', count: 2 } ), { ok: false, reason: 'the bag holds 1 fish' }, 'a giver gives only what it carries' );
		assert.deepEqual( [ a.bag, b.bag ], [ { fish: 1 }, { fish: 2 } ] );
		record.observe( sim, 'fair', 0 );
		record.observe( sim, 'fair', 0 );
		const gifts = record.entries.filter( ( e ) => e.kind === 'gave' );
		assert.equal( gifts.length, 1, 'one record entry' );
		assert.deepEqual( [ gifts[ 0 ].who, gifts[ 0 ].to, gifts[ 0 ].text, gifts[ 0 ].count ], [ a.id, [ b.id ], 'fish', 2 ] );
		const again = new Chronicle();
		again.restore( record.save() );
		again.observe( loadGame( sim.save(), input ), 'fair', 0 );
		assert.equal( again.entries.filter( ( e ) => e.kind === 'gave' ).length, 1, 'a load notes nothing old' );
		console.log( 'give: items moved and noticed, refused whole for a full bag or a short one, recorded once' );

	}

	// go( person ): reaches someone walking away
	{

		const sim = newGame( input, { seed: 5, bodies: adults } );
		const [ a, b ] = sim.state.villagers;
		standAt( sim, b, a.pos, 6 );
		assert.equal( sim.walkTo( b.id, farthestOpen( sim.grid, a.pos ) ), null );
		assert.equal( act( sim, a, 'go', { place: b.id } ).ok, true );
		let ticks = 0;
		while ( a.action && ticks < 2 * HOUR ) { sim.step( 1 ); ticks ++; }
		assert.deepEqual( a.last.result, { ok: true, value: `arrived at the ${ b.id }` } );
		assert.ok( dist( a.pos, b.pos ) <= PERSON_REACH + 0.4, `beside them (${ dist( a.pos, b.pos ).toFixed( 2 ) } m)` );
		assert.equal( b.path, null, 'once they stopped' );
		assert.deepEqual( act( sim, a, 'go', { place: a.id } ), { ok: false, reason: `there is no place called ${ a.id }` }, 'never to oneself' );
		console.log( `go: caught up with a walker in ${ ticks } s` );

	}

	// follow: within the gap while the leader walks, at rest beside them whenever both stand,
	// replaced by a new action, ended by a death; a save mid-follow plays on the same
	{

		const sim = newGame( input, { seed: 6, bodies: adults } );
		const [ a, b ] = sim.state.villagers;
		const beside = () => placesAt( sim, a ).some( ( p ) => p.id === b.id );
		// beside the leader where it stood when the follower looked (the leader walks after it in a tick)
		const besideBefore = () => {

			const k = sim.grid.indexAt( a.pos.x, a.pos.z );
			return dist( sim.grid.centreOf( k ), b.prev ) <= PERSON_REACH;

		};
		standAt( sim, a, b.pos, 1 );
		assert.equal( act( sim, a, 'do', { action: 'follow', place: b.id } ).ok, true );
		assert.equal( a.action.until, null, 'without an end' );
		const far = farthestOpen( sim.grid, b.pos );
		assert.equal( sim.walkTo( b.id, far ), null );
		let gap = 0, ticks = 0, stops = 0, apart = 0, walking = a.path !== null;
		act( sim, b, 'say', { words: 'this way' } );
		sim.step( 30 );
		const loaded = loadGame( sim.save(), input );
		assert.equal( loaded.save(), sim.save() );
		const tick = () => {

			sim.step( 1 );
			loaded.step( 1 );
			ticks ++;
			gap = Math.max( gap, dist( a.pos, b.pos ) );
			// it comes to rest beside them, and stands apart only while they walk on
			if ( walking && ! a.path ) {

				stops ++;
				assert.ok( besideBefore(), `the follower stopped beside the leader (tick ${ ticks }, ${ dist( a.pos, b.pos ).toFixed( 2 ) } m)` );

			}
			if ( ! a.path && ! b.path && ! beside() ) apart ++;
			walking = a.path !== null;

		};
		while ( b.path && ticks < 2 * HOUR ) tick();
		const walked = ticks;
		for ( let i = 0; i < 120; i ++ ) tick();
		assert.equal( loaded.save(), sim.save(), 'a game saved mid-follow plays on the same' );
		assert.ok( walked > 300, `the leader walked a while (${ walked } s)` );
		assert.ok( gap <= FOLLOW_GAP + 0.25, `the follower kept within the gap (at most ${ gap.toFixed( 2 ) } m)` );
		assert.ok( stops > 0, 'the follower stood on the way' );
		assert.ok( apart <= 2, `with both standing, the leader at hand (apart ${ apart } s)` );
		assert.equal( a.action.call.args.action, 'follow', 'still following once the leader stopped' );
		assert.ok( beside(), `at rest beside the leader (${ dist( a.pos, b.pos ).toFixed( 2 ) } m)` );
		assert.equal( act( sim, a, 'wait', { seconds: 60 } ).ok, true );
		assert.equal( a.action.call.tool, 'wait', 'a new action replaces it' );
		assert.equal( act( sim, a, 'do', { action: 'follow', place: b.id } ).ok, true, 'following again from where it rests, without a go' );
		b.lifespan = sim.age( b ) + 10 / SECONDS_PER_YEAR;
		sim.step( 20 );
		assert.equal( sim.villager( b.id ), undefined );
		assert.deepEqual( [ a.action, a.last.result ], [ null, { ok: false, reason: `${ b.id } is gone` } ], 'it ends when the one followed dies' );
		console.log( `follow: ${ walked } s behind a walker, never more than ${ gap.toFixed( 2 ) } m away, stopped ${ stops } times, each beside them; both standing apart ${ apart } s; at rest beside them; replaced, followed again without a go, then ended by a death; saved and loaded mid-follow` );

	}

	// the stand-in: the hungry one asks, a fed one within earshot walks over and gives, thanks
	{

		const play = () => {

			const sim = newGame( input, { seed: 8, bodies: adults.slice( 0, 2 ) } );
			const [ a, b ] = sim.state.villagers;
			standAt( sim, b, a.pos, 8 );
			a.needs.satiety = 50;
			b.needs.satiety = 90;
			b.bag = { fish: 1 };
			sim.brain = new StandInBrain();
			const events = [];
			let said = null, gave = null, went = false;
			for ( let t = 0; t < 2 * HOUR && ! ( said && said.words === THANKS_WORDS ); t ++ ) {

				sim.step( 1 );
				if ( a.said !== said ) events.push( `${ a.id } says ${ ( said = a.said ).words }` );
				if ( ! went && b.action?.call.tool === 'go' && b.action.call.args.place === a.id ) events.push( `${ b.id } goes to ${ a.id }` ), went = true;
				if ( b.gave !== gave ) events.push( `${ ( gave = b.gave ).to } given ${ gave.count } ${ gave.item }` );

			}
			return { sim, a, b, events };

		};
		const { sim, a, b, events } = play();
		assert.deepEqual( events, [ `${ a.id } says ${ HUNGRY_WORDS }`, `${ b.id } goes to ${ a.id }`, `${ a.id } given 1 fish`, `${ a.id } says ${ THANKS_WORDS }` ], 'asked, walked over, given, thanked' );
		assert.ok( a.needs.satiety > 60, `and the hungry one ate (satiety ${ a.needs.satiety.toFixed( 1 ) })` );
		assert.equal( play().sim.save(), sim.save(), 'deterministic' );
		console.log( `stand-in: ${ events.join( ', ' ) } by ${ ( sim.state.tick / 60 ).toFixed( 0 ) } min; ${ b.name } gave, ${ a.name } ate` );

	}

}

// ------------------------------------------------------------------ things on the ground

{

	const kind = THING_KINDS.fish;
	/** the centre of the open cell nearest d metres from p (standAt's, standing no one there) */
	const cellAt = ( sim, p, d ) => standAt( sim, {}, p, d );
	const poses = ( sim ) => JSON.stringify( sim.state.things.map( ( t ) => [ t.id, t.pos, t.rot ] ) );
	/** step until every thing sleeps (or `limit` ticks); the ticks it took */
	const settle = ( sim, limit = 600 ) => {

		let ticks = 0;
		while ( ticks < limit && sim.state.things.some( ( t ) => ! sim.physics.sleeping( t.body ) ) ) {

			sim.step( 1 );
			ticks ++;

		}
		return ticks;

	};
	/** a game with an islander standing still on a cell well inside the island, two fish dropped from its hand */
	const dropped = ( seed = 9 ) => {

		const sim = newGame( input, { seed, bodies: adults } );
		const [ a, b, c ] = sim.state.villagers;
		standAt( sim, a, { x: 0, z: 0 }, 0 );
		standAt( sim, b, a.pos, 12 );
		standAt( sim, c, a.pos, 14 );
		sim.step( 1 );
		a.bag = { fish: 2 };
		assert.deepEqual( act( sim, a, 'do', { action: 'drop', item: 'fish', count: 2 } ), { ok: true, value: 'dropped 2 fish' } );
		return { sim, a };

	};

	// two fish fall, collide and come to rest on the ground, apart, on the island
	{

		const { sim, a } = dropped();
		assert.deepEqual( a.bag, {}, 'the bag gave them' );
		assert.equal( sim.state.things.length, 2 );
		assert.deepEqual( act( sim, a, 'do', { action: 'drop', item: 'fish' } ), { ok: false, reason: 'the bag holds 0 fish' }, 'a bag drops only what it carries' );
		const ticks = settle( sim );
		assert.ok( ticks < 300, `asleep within a few seconds on screen (${ ticks } ticks)` );
		const shrunk = { x: kind.size.x - 0.01, y: kind.size.y - 0.01, z: kind.size.z - 0.01 };
		const rests = [];
		for ( const t of sim.state.things ) {

			const ground = sim.grid.height( t.pos.x, t.pos.z );
			rests.push( t.pos.y - ground );
			assert.ok( Math.abs( t.pos.y - ground - kind.size.x / 2 ) < 0.012, `${ t.id } rests on its flank on the ground (${ ( t.pos.y - ground ).toFixed( 3 ) } m over it)` );
			assert.equal( sim.physics.overlaps( shrunk, kind.border - 0.005, t.pos, t.rot, t.body ), false, `${ t.id } inside nothing` );
			assert.equal( sim.grid.top[ sim.grid.indexAt( t.pos.x, t.pos.z ) ], 1, `${ t.id } on the island` );
			assert.ok( dist( t.pos, a.pos ) < 1.5, `${ t.id } beside the islander` );
			assert.deepEqual( t.prev, { pos: t.pos, rot: t.rot }, 'at rest, its pose before is its pose' );

		}
		console.log( `things: two fish asleep in ${ ticks } ticks, ${ rests.map( ( r ) => r.toFixed( 3 ) ).join( ' and ' ) } m over the ground, apart` );

	}

	// deterministic: the same calls twice; saved mid-fall and loaded; ticks split otherwise
	{

		const a = dropped(), b = dropped();
		a.sim.step( 10 );
		b.sim.step( 10 );
		assert.ok( a.sim.state.things.every( ( t ) => t.pos.y > a.sim.grid.height( t.pos.x, t.pos.z ) + 0.2 ), 'mid-fall' );
		const loaded = loadGame( a.sim.save(), input );
		assert.equal( loaded.save(), a.sim.save(), 'loaded mid-fall as saved' );
		a.sim.step( 300 );
		for ( let t = 0; t < 300; t ++ ) b.sim.step( 1 );
		loaded.step( 7 );
		loaded.step( 293 );
		assert.equal( poses( b.sim ), poses( a.sim ), 'the same seed and calls, every pose the same, however the ticks are split' );
		assert.equal( poses( loaded ), poses( a.sim ), 'loaded mid-fall, every pose the same' );
		assert.equal( loaded.save(), a.sim.save(), 'and the whole game' );
		console.log( 'things: the same poses bit for bit over two runs, a save mid-fall and ticks split otherwise' );

	}

	// take: refused with a full bag; taken from beside; a rolling thing reached by go
	{

		const { sim, a } = dropped();
		settle( sim );
		const [ t ] = sim.state.things, body = t.body;
		a.bag = { fish: BAG_CAPACITY };
		const options = perceive( sim, a ).atHand.find( ( h ) => h.place === t.id )?.options;
		assert.deepEqual( options, [], 'a full bag: take is not offered' );
		assert.deepEqual( act( sim, a, 'do', { action: 'take', place: t.id } ), { ok: false, reason: 'the bag is full' }, 'and refused' );
		a.bag = {};
		assert.deepEqual( act( sim, a, 'do', { action: 'take', place: t.id } ), { ok: true, value: 'took 1 fish' } );
		assert.deepEqual( [ a.bag, sim.state.things.length, sim.physics.world.getRigidBody( body ) ], [ { fish: 1 }, 1, null ], 'the bag gains it, the thing and its body are gone' );
		// a fish thrown off along the ground, followed while it slides
		const far = cellAt( sim, a.pos, 6 );
		const rolling = dropThing( sim, 'fish', { x: far.x, y: sim.grid.height( far.x, far.z ) + 0.1, z: far.z }, { x: 3, y: 0, z: 0 } );
		sim.step( 1 );
		assert.equal( act( sim, a, 'go', { place: rolling.id } ).ok, true );
		let ticks = 0;
		while ( a.action && ticks < HOUR ) { sim.step( 1 ); ticks ++; }
		assert.deepEqual( a.last.result, { ok: true, value: `arrived at the ${ rolling.id }` } );
		assert.ok( dist( a.pos, rolling.pos ) <= REACH + 0.01, `beside it where it lies (${ dist( a.pos, rolling.pos ).toFixed( 2 ) } m)` );
		console.log( `take: refused for a full bag, taken with its body; a sliding fish reached in ${ ticks } s` );

	}

	// the sea takes what falls past the rim
	{

		const sim = newGame( input, { seed: 9 } );
		const rim = farthestOpen( sim.grid, { x: 0, z: 0 } ), r = Math.hypot( rim.x, rim.z );
		const out = { x: rim.x * ( r + 4 ) / r, z: rim.z * ( r + 4 ) / r };
		const t = dropThing( sim, 'fish', { x: out.x, y: 2, z: out.z }, { x: 0, y: 0, z: 0 } );
		let ticks = 0;
		while ( sim.state.things.length && ticks < 600 ) { sim.step( 1 ); ticks ++; }
		assert.deepEqual( [ sim.state.things.length, sim.physics.world.getRigidBody( t.body ) ], [ 0, null ], `fallen into the sea and gone (${ ticks } ticks)` );
		console.log( `sea: a fish past the rim gone in ${ ticks } ticks` );

	}

	// a death drops the bag where the islander stood; a catch the bag cannot hold falls to the ground
	{

		const sim = newGame( input, { seed: 10, bodies: adults } );
		const [ a, b ] = sim.state.villagers;
		const at = { ...a.pos };
		a.bag = { fish: 3 };
		a.lifespan = sim.age( a ) + 5 / SECONDS_PER_YEAR;
		sim.step( 10 );
		assert.equal( sim.villager( a.id ), undefined );
		settle( sim );
		assert.equal( sim.state.things.length, 3, 'the bag on the ground' );
		for ( const t of sim.state.things ) assert.ok( dist( t.pos, at ) < 0.6, `where it stood (${ dist( t.pos, at ).toFixed( 2 ) } m)` );
		// b fishes on: fishing begun with room, the bag full by the time a fish bites
		assert.equal( sim.state.villagers[ 0 ], b );
		assert.equal( run( sim, { tool: 'go', args: { place: 'shore' } } ).ok, true );
		let caught = null;
		for ( let n = 0; n < 30 && caught === null; n ++ ) {

			b.bag = { fish: BAG_CAPACITY - 1 };
			assert.equal( act( sim, b, 'do', { action: 'fish' } ).ok, true );
			b.bag = { fish: BAG_CAPACITY };
			const before = sim.state.things.length;
			while ( b.action ) sim.step( 1 );
			if ( b.last.result.value === 'caught a fish' ) caught = sim.state.things.length - before;

		}
		assert.equal( caught, 1, 'a catch into a full bag lands on the ground' );
		assert.deepEqual( b.bag, { fish: BAG_CAPACITY }, 'and the bag stays full' );
		console.log( 'drops: a death\'s bag where the islander stood, a catch past a full bag on the ground' );

	}

	// an islander walking through a resting fish pushes it
	{

		const { sim, a } = dropped();
		settle( sim );
		const [ t ] = sim.state.things;
		const lay = { ...t.pos };
		// from 3 m before it to 3 m past it, straight over it
		const from = standAt( sim, a, lay, 3 );
		const to = { x: lay.x + ( lay.x - from.x ), z: lay.z + ( lay.z - from.z ) };
		sim.step( 1 );
		assert.equal( sim.walkTo( a.id, to ), null );
		let ticks = 0;
		while ( a.path && ticks < HOUR ) { sim.step( 1 ); ticks ++; }
		settle( sim );
		const moved = Math.hypot( t.pos.x - lay.x, t.pos.z - lay.z );
		assert.ok( moved > 0.05, `pushed (${ moved.toFixed( 2 ) } m)` );
		console.log( `push: a walker moved a resting fish ${ moved.toFixed( 2 ) } m` );

	}

	// a grown island: the ground's collider replaced, resting things still where they lay
	{

		const { sim } = dropped();
		settle( sim );
		const ground = sim.state.ground, colliders = sim.physics.world.colliders.len(), lay = poses( sim );
		sim.addPiece( inputAt( 1 ) );
		// (a handle's slot is reused: a lookup by the old handle finds the new collider)
		assert.notEqual( sim.state.ground, ground, 'a new ground collider' );
		assert.equal( sim.physics.world.colliders.len(), colliders, 'in place of the old one' );
		sim.step( 120 );
		settle( sim );
		for ( const [ k, t ] of sim.state.things.entries() ) {

			const before = JSON.parse( lay )[ k ][ 1 ];
			assert.ok( Math.hypot( t.pos.x - before.x, t.pos.y - before.y, t.pos.z - before.z ) < 1e-3, `${ t.id } stays put` );

		}
		console.log( 'growth: the ground collider replaced, resting things stay put' );

	}

	// the stand-in: hungry, it picks up a fish in sight before going to fish
	{

		const play = () => {

			const sim = newGame( input, { seed: 11, bodies: adults.slice( 0, 1 ) } );
			const [ a ] = sim.state.villagers;
			standAt( sim, a, { x: 0, z: 0 }, 0 );
			const c = cellAt( sim, a.pos, 6 );
			const t = dropThing( sim, 'fish', { x: c.x, y: sim.grid.height( c.x, c.z ) + 0.3, z: c.z }, { x: 0, y: 0, z: 0 } );
			settle( sim );
			a.needs.satiety = 50;
			// the stand-in, its calls noted as it answers
			const brain = new StandInBrain(), calls = [];
			sim.brain = { think: ( p, who ) => {

				const answer = brain.think( p, who );
				calls.push( ...answer );
				return answer;

			} };
			for ( let tick = 0; tick < HOUR && ! calls.some( ( c ) => c.tool === 'use' ); tick ++ ) sim.step( 1 );
			return { sim, a, t, calls };

		};
		const { sim, a, t, calls } = play();
		const said = calls.map( ( c ) => c.tool === 'do' ? `do ${ c.args.action } ${ c.args.place }` : `${ c.tool } ${ c.args.place ?? c.args.item ?? '' }` );
		assert.deepEqual( said, [ `go ${ t.id }`, `do take ${ t.id }`, 'use fish' ], 'went to the fish, took it and ate it, never fishing' );
		assert.equal( sim.state.things.length, 0 );
		assert.ok( a.needs.satiety > 60 );
		assert.equal( play().sim.save(), sim.save(), 'deterministic' );
		console.log( `stand-in: ${ said.join( ', ' ) } by ${ ( sim.state.tick / 60 ).toFixed( 0 ) } min` );

	}

	// the cost of a step: everything asleep with three walking; twenty fish falling
	{

		const time = ( sim, ticks ) => {

			const t0 = performance.now();
			sim.step( ticks );
			return ( performance.now() - t0 ) / ticks * 1000;

		};
		const walking = ( fish ) => {

			const sim = newGame( input, { seed: 12, bodies: adults } );
			if ( fish ) {

				const a = sim.state.villagers[ 0 ];
				a.bag = { fish: 10 };
				act( sim, a, 'do', { action: 'drop', item: 'fish', count: 10 } );
				settle( sim, 2000 );

			}
			for ( const v of sim.state.villagers ) sim.walkTo( v.id, farthestOpen( sim.grid, v.pos ) );
			sim.step( 60 );
			return sim;

		};
		const bare = time( walking( false ), 600 ), asleep = time( walking( true ), 600 );
		const falling = newGame( input, { seed: 12, bodies: adults } );
		for ( let k = 0; k < 20; k ++ ) {

			const c = cellAt( falling, { x: 0, z: 0 }, 1 + k * 0.4 );
			dropThing( falling, 'fish', { x: c.x, y: falling.grid.height( c.x, c.z ) + 1.2 + 0.1 * k, z: c.z }, { x: 0, y: 0, z: 0 } );

		}
		falling.step( 1 );
		const fall = time( falling, 60 );
		const tenFish = walking( true ), size = tenFish.save().length, none = newGame( input, { seed: 12, bodies: adults } ).save().length;
		console.log( `cost: a tick ${ bare.toFixed( 1 ) } us with three walking, ${ asleep.toFixed( 1 ) } us with ten fish asleep besides, ${ fall.toFixed( 1 ) } us with twenty falling; a save with ten fish ${ size } bytes, without ${ none }` );

	}

}

console.log( 'verify-game: all checks passed' );
