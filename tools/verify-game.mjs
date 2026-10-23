// Checks of the game's simulation, asserted: the clock and its ticks, the ground grid and a path
// over it, a body that walks to a point and stops there, a save that loads back as it was, a brain
// whose late answer is applied while the world ran on; then the first prototype's rules: needs that
// fall and rise (thirst off: hydration holds), fishing by the seeded generator and the bag's capacity,
// the chest placed as a blueprint and built, several of a kind with ids of their own, two
// islanders building one site, the island's stock (its stores) and a cost's shortfall, actions that replace each other, a perception
// without positions, the stand-in brain building the chest and keeping the islander fed for
// days, and a save taken mid-action; the save file (the simulation and its record read back as
// written, a save of version 17 brought to this one, saves no step reaches refused, and a record
// restored from a save that keeps the entries the original keeps); then the island's growth: a land
// grown by IslandGrowth, the population steps, the coming piece's cells, a step crossed adding
// exactly one piece, the grid opening cells without reindexing, islanders walking onto the new
// piece, the shore moving to the new coast as on a fresh load, and a save that keeps its piece count.
// Pure CPU; Node 22.18+ strips the imported TypeScript.
// Run: node tools/verify-game.mjs
import assert from 'node:assert/strict';
import { newGame, loadGame } from '../src/game/sim/Sim.ts';
import { findPath, goalAt, lineClear } from '../src/game/sim/path.ts';
import { perceive } from '../src/game/sim/agent.ts';
import { StandInBrain } from '../src/game/sim/standin.ts';
import { BAG_CAPACITY, FISH_SATIETY } from '../src/game/sim/items.ts';
import { HYDRATION_PER_DAY, SATIETY_PER_DAY, START_NEEDS } from '../src/game/sim/needs.ts';
import { FISH_SECONDS } from '../src/game/sim/places.ts';
import { CHEST_WORK, progressOf, stageOf } from '../src/game/sim/buildings.ts';
import { GROWTH_STEPS, POPULATION_START, piecesFor } from '../src/game/sim/types.ts';
import { SAVE_VERSION, readSave, savedPieces, writeSave } from '../src/game/save.ts';
import { Chronicle } from '../src/game/Chronicle.ts';
import { shortfall, stockOf } from '../src/game/sim/stock.ts';
import { shoreMask } from '../src/game/sim/ground.ts';
import { input, inputAt } from './game-fixture.mjs';

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
	assert.deepEqual( site, { id: 'chest1', kind: 'chest', x: at.x, z: at.z, worked: 0, items: {} } );
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
	assert.deepEqual( Object.keys( p ).sort(), [ 'atHand', 'body', 'last', 'seen', 'time' ] );
	assert.deepEqual( p.seen.map( ( s ) => `${ s.place } ${ s.kind }` ).sort(), [ 'chest1 chest', 'shore shore' ], 'the whole small island is in sight, each place by id and kind' );
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

// the save file: the simulation and its record (Chronicle) read back as written; a record restored
// and watching the same ticks keeps the entries the original keeps, a need noted before the save not
// noted again; a save of version 17 (the state alone) brought to this version; others refused
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

	const json = writeSave( sim.state, record.save() );
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

	// version 17: the simulation's state alone
	const old = JSON.stringify( { ...JSON.parse( sim.save() ), version: 17 } );
	const brought = readSave( old );
	assert.equal( brought.version, SAVE_VERSION );
	assert.equal( JSON.stringify( loadGame( brought.sim, input ).state ), sim.save(), 'a save of version 17 loads as it was' );
	assert.deepEqual( brought.record, { entries: [], skies: {}, alerted: [] }, 'with an empty record' );
	assert.equal( savedPieces( old ), 0 );
	for ( const bad of [ null, '', 'not json', '[]', '{}', JSON.stringify( { ...JSON.parse( old ), version: 16 } ), JSON.stringify( { ...save, version: SAVE_VERSION + 1 } ), JSON.stringify( { ...save, sim: null } ) ] ) {

		assert.equal( readSave( bad ), null, `refused: ${ String( bad ).slice( 0, 40 ) }` );

	}
	console.log( `save file: ${ json.length } bytes with ${ record.entries.length } record entries, read back and played on two days the same, record included; version 17 brought over; others refused` );

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
	assert.equal( sim.population(), 1 );
	const grid = sim.grid, top0 = grid.top.slice(), dims = [ grid.cols, grid.rows, grid.x0, grid.z0 ];
	// the shore as the islanders know it before the growth (they fish there)
	const shore0 = shoreMask( grid ).slice();
	const kai = sim.state.villagers[ 0 ], kaiCell = grid.indexAt( kai.pos.x, kai.pos.z );
	// a chest's cell, as indexed before the growth
	const chest = placeChest( sim ), chestCell = grid.indexAt( chest.x, chest.z );
	assert.ok( ! grid.open[ chestCell ], 'the chest blocks its ground' );

	// the population approaches the step: 1, 2, 3 islanders are at the start; 4 halfway; 5 due
	for ( let p = 2; p <= 4; p ++ ) {

		sim.addIslander();
		assert.equal( sim.growthDue(), false, `${ p } islanders: no growth yet` );

	}
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
	const json = sim.save(), file = writeSave( sim.state, new Chronicle().save() );
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

console.log( 'verify-game: all checks passed' );
