// Checks of the game's simulation, asserted: the clock and its ticks, the ground grid and a path
// over it, a body that walks to a point and stops there, a save that loads back as it was, a brain
// whose late answer is applied while the world ran on; then the first prototype's rules: needs that
// fall and rise, the bag's capacity, the palm and its regrowth, fishing by the seeded generator,
// the chest placed as a blueprint and built, actions that replace each other, a perception
// without positions, the stand-in brain building the chest and keeping the islander fed and
// watered for days, and a save taken mid-action.
// Pure CPU; Node 22.18+ strips the imported TypeScript.
// Run: node tools/verify-game.mjs
import assert from 'node:assert/strict';
import { newGame, loadGame } from '../src/game/sim/Sim.ts';
import { findPath, goalAt, lineClear } from '../src/game/sim/path.ts';
import { perceive } from '../src/game/sim/agent.ts';
import { StandInBrain } from '../src/game/sim/standin.ts';
import { BAG_CAPACITY, COCONUT_HYDRATION, FISH_SATIETY } from '../src/game/sim/items.ts';
import { HYDRATION_PER_DAY, SATIETY_PER_DAY } from '../src/game/sim/needs.ts';
import { FISH_SECONDS, PALM_COCONUTS, PALM_REGROW_SECONDS, PICK_SECONDS } from '../src/game/sim/places.ts';
import { CHEST_WORK, progressOf, stageOf } from '../src/game/sim/buildings.ts';
import { input } from './game-fixture.mjs';

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
	for ( const o of [ ...input.bushes, ...input.plants ] ) assert.ok( ! grid.openAt( o.x, o.z ), 'a bush or a plant blocks its ground' );
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
		return new Promise( ( resolve ) => setTimeout( () => resolve( [ { tool: 'go', args: { place: 'palm' } }, { tool: 'fly' } ] ), 5 ) );

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
	assert.equal( v.action.call.args.place, 'palm', 'the body now goes where the answer said' );
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

/** the chest placed at the first open ground that takes it, outward from the island's middle */
function placeChest( sim ) {

	const grid = sim.grid;
	const cells = [];
	for ( let k = 0; k < grid.open.length; k ++ ) if ( grid.region[ k ] === grid.main ) cells.push( k );
	cells.sort( ( a, b ) => Math.hypot( grid.centreX( a ), grid.centreZ( a ) ) - Math.hypot( grid.centreX( b ), grid.centreZ( b ) ) || a - b );
	for ( const k of cells ) if ( sim.placeBlueprint( 'chest', grid.centreX( k ), grid.centreZ( k ) ) === null ) return grid.centreOf( k );
	throw new Error( 'no ground took the chest' );

}

/** the chest placed and built by the islander, who stands at it after */
function buildChest( sim ) {

	const at = placeChest( sim );
	assert.equal( run( sim, { tool: 'go', args: { place: 'chest' } } ).ok, true );
	assert.deepEqual( run( sim, { tool: 'do', args: { action: 'build' } } ), { ok: true, value: 'built the chest' } );
	return at;

}

// needs fall, and drinking and eating raise them
{

	const sim = newGame( input );
	const v = sim.state.villagers[ 0 ];
	const before = { ...v.needs };
	sim.step( HOUR );
	assert.ok( Math.abs( before.hydration - v.needs.hydration - HYDRATION_PER_DAY / 24 ) < 1e-9, 'hydration falls by its hourly rate' );
	assert.ok( Math.abs( before.satiety - v.needs.satiety - SATIETY_PER_DAY / 24 ) < 1e-9, 'satiety falls by its hourly rate' );
	assert.ok( HYDRATION_PER_DAY > SATIETY_PER_DAY, 'thirst comes faster than hunger' );
	sim.step( 2 * 24 * HOUR );
	assert.deepEqual( v.needs, { satiety: 0, hydration: 0 }, 'needs clamp at 0' );
	v.bag = { coconut: 2, fish: 1 };
	assert.deepEqual( run( sim, { tool: 'use', args: { item: 'coconut' } } ), { ok: true, value: 'drank a coconut' } );
	assert.equal( v.needs.hydration, COCONUT_HYDRATION, 'a coconut raises hydration' );
	assert.equal( run( sim, { tool: 'use', args: { item: 'fish' } } ).ok, true );
	assert.equal( v.needs.satiety, FISH_SATIETY, 'a fish raises satiety' );
	assert.deepEqual( v.bag, { coconut: 1 }, 'using an item spends it' );
	assert.equal( run( sim, { tool: 'use', args: { item: 'fish' } } ).ok, false, 'no fish to eat' );
	v.needs.hydration = 95;
	run( sim, { tool: 'use', args: { item: 'coconut' } } );
	assert.equal( v.needs.hydration, 100, 'needs top out at 100' );
	console.log( 'needs: fall per tick, clamp, drinking and eating raise them' );

}

// the palm: placed on the ground, picked, regrown; the bag's capacity
{

	const sim = newGame( input );
	const v = sim.state.villagers[ 0 ], grid = sim.grid;
	assert.equal( sim.state.palms.length, 1, 'one palm' );
	const palm = sim.state.palms[ 0 ];
	assert.ok( ! grid.openAt( palm.x, palm.z ), 'the palm blocks its ground' );
	assert.deepEqual( newGame( input, { seed: 9 } ).state.palms, sim.state.palms, 'the palm grows where the ground says, whatever the seed' );
	assert.equal( run( sim, { tool: 'do', args: { action: 'pick' } } ).ok, false, 'nothing to pick away from the palm' );
	assert.deepEqual( run( sim, { tool: 'go', args: { place: 'palm' } } ), { ok: true, value: 'arrived at the palm' } );
	assert.deepEqual( perceive( sim, v ).atHand, [ { place: 'palm', options: [ 'pick' ] } ], 'the palm is at hand' );
	const tick = sim.state.tick;
	assert.deepEqual( run( sim, { tool: 'do', args: { action: 'pick' } } ), { ok: true, value: 'picked a coconut' } );
	assert.equal( sim.state.tick - tick, PICK_SECONDS, 'picking takes its while' );
	assert.equal( palm.coconuts, PALM_COCONUTS - 1 );
	assert.deepEqual( v.bag, { coconut: 1 } );
	for ( let n = 1; n < BAG_CAPACITY; n ++ ) run( sim, { tool: 'do', args: { action: 'pick' } } );
	assert.equal( v.bag.coconut, BAG_CAPACITY, 'items of a kind stack' );
	assert.deepEqual( run( sim, { tool: 'do', args: { action: 'pick' } } ), { ok: false, reason: 'the bag is full' }, 'a full bag refuses more' );
	assert.equal( palm.coconuts, PALM_COCONUTS - BAG_CAPACITY );
	// the next coconut has grown since the first was picked
	assert.ok( palm.growth > 0 );
	sim.step( PALM_REGROW_SECONDS - palm.growth - 1 );
	assert.equal( palm.coconuts, PALM_COCONUTS - BAG_CAPACITY, 'not yet regrown' );
	sim.step( 1 );
	assert.equal( palm.coconuts, PALM_COCONUTS - BAG_CAPACITY + 1, 'a coconut regrows' );
	sim.step( 10 * PALM_REGROW_SECONDS );
	assert.equal( palm.coconuts, PALM_COCONUTS, 'up to the palm\'s full count' );
	console.log( `palm: at ${ palm.x }, ${ palm.z }; picked, a full bag refused, regrown` );

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
	console.log( `fishing: ${ a.filter( ( c ) => c === 'caught a fish' ).length } of 12 tries caught a fish` );

}

// the chest: placed once on open ground, put and take
{

	const sim = newGame( input );
	const v = sim.state.villagers[ 0 ], palm = sim.state.palms[ 0 ];
	assert.equal( typeof sim.placeBlueprint( 'chest', 1e4, 0 ), 'string', 'not off the island' );
	assert.equal( typeof sim.placeBlueprint( 'chest', palm.x, palm.z ), 'string', 'not on the palm' );
	assert.equal( typeof sim.placeBlueprint( 'chest', v.pos.x, v.pos.z ), 'string', 'not on the islander' );
	assert.deepEqual( sim.state.buildings, [] );
	assert.equal( typeof sim.placeBlueprint( 'tower', 0, 0 ), 'string', 'no such kind' );
	const at = buildChest( sim );
	assert.ok( ! sim.grid.openAt( at.x, at.z ), 'it blocks its ground' );
	assert.equal( sim.placeBlueprint( 'chest', at.x, at.z ), 'The chest is already placed', 'placed once' );
	run( sim, { tool: 'go', args: { place: 'shore' } } );
	assert.equal( perceive( sim, v ).seen.find( ( s ) => s.place === 'chest' ).shows, undefined, 'its contents do not show from afar' );
	assert.equal( run( sim, { tool: 'go', args: { place: 'chest' } } ).ok, true );
	v.bag = { fish: 2, coconut: 1 };
	assert.equal( run( sim, { tool: 'do', args: { action: 'put', item: 'fish', count: 2 } } ).ok, true );
	assert.equal( run( sim, { tool: 'do', args: { action: 'put', item: 'fish', count: 1 } } ).ok, false, 'cannot put what the bag lacks' );
	assert.equal( run( sim, { tool: 'do', args: { action: 'put', item: 'stone' } } ).ok, false, 'no such item' );
	assert.deepEqual( sim.state.buildings[ 0 ].items, { fish: 2 } );
	assert.deepEqual( v.bag, { coconut: 1 } );
	assert.deepEqual( perceive( sim, v ).seen.find( ( s ) => s.place === 'chest' ).shows, { items: { fish: 2 } }, 'its contents show while at it' );
	assert.equal( run( sim, { tool: 'do', args: { action: 'take', item: 'fish', count: 3 } } ).ok, false, 'cannot take more than it holds' );
	assert.equal( run( sim, { tool: 'do', args: { action: 'take', item: 'fish' } } ).ok, true, 'one by default' );
	assert.deepEqual( sim.state.buildings[ 0 ].items, { fish: 1 } );
	assert.deepEqual( v.bag, { coconut: 1, fish: 1 } );
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
	assert.deepEqual( site, { id: 'chest', kind: 'chest', x: at.x, z: at.z, worked: 0, items: {} } );
	assert.equal( stageOf( site ), 'planned' );
	assert.ok( ! sim.grid.openAt( at.x, at.z ), 'the site blocks its ground from the start' );
	assert.deepEqual( perceive( sim, v ).seen.find( ( s ) => s.place === 'chest' ).shows, { construction: 'marked out, not begun' }, 'a planned site shows as one' );
	assert.equal( run( sim, { tool: 'go', args: { place: 'chest' } } ).ok, true );
	assert.deepEqual( perceive( sim, v ).atHand.find( ( h ) => h.place === 'chest' ).options, [ 'build' ], 'an unbuilt site offers only build' );
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
	assert.deepEqual( perceive( sim, v ).seen.find( ( s ) => s.place === 'chest' ).shows, { construction: 'being built, about a quarter done' }, 'how far along, in words' );

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
		assert.deepEqual( body.last.result, { ok: true, value: 'built the chest' } );

	}
	assert.equal( loaded.save(), sim.save(), 'a game saved mid-build finishes it the same' );
	assert.equal( part + 30 + sim.state.tick - tick, CHEST_WORK, 'building takes the kind\'s work in all' );
	assert.equal( stageOf( site ), 'built' );
	assert.equal( progressOf( site ), 1 );
	assert.deepEqual( perceive( sim, v ).atHand.find( ( h ) => h.place === 'chest' ).options, [ 'put' ], 'the finished chest offers its own options' );
	assert.equal( perceive( sim, v ).seen.find( ( s ) => s.place === 'chest' ).shows.construction, undefined, 'and shows no construction' );
	assert.deepEqual( run( sim, { tool: 'do', args: { action: 'build' } } ), { ok: false, reason: 'nothing here offers build' }, 'build is gone' );
	assert.equal( run( sim, { tool: 'do', args: { action: 'put', item: 'fish' } } ).ok, true );
	assert.equal( run( sim, { tool: 'do', args: { action: 'take', item: 'fish' } } ).ok, true, 'put and take' );
	console.log( `blueprint: planned, built in ${ CHEST_WORK } s of work across an interruption and a save, then a chest` );

}

// actions replace each other; a refused one replaces nothing
{

	const sim = newGame( input );
	const v = sim.state.villagers[ 0 ];
	const tools = sim.tools;
	assert.deepEqual( [ ...tools.keys() ].sort(), [ 'do', 'go', 'say', 'use', 'wait' ], 'exactly five actions' );
	assert.equal( tools.get( 'go' )( v, { place: 'palm' }, sim ).ok, true );
	assert.ok( v.path, 'walking' );
	assert.equal( tools.get( 'go' )( v, { place: 'moon' }, sim ).ok, false );
	assert.ok( v.path && v.action.call.args.place === 'palm', 'a refused action leaves the walk under way' );
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
	run( sim, { tool: 'go', args: { place: 'chest' } } );
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
	assert.deepEqual( p.seen.map( ( s ) => s.place ).sort(), [ 'chest', 'palm', 'shore' ], 'the whole small island is in sight' );
	assert.equal( p.time.day, 1 );
	p.body.bag.coconut = 99;
	assert.deepEqual( v.bag, {}, 'the perception is a copy' );
	console.log( 'perception: time, seen, at hand, body and the last outcome, no positions' );

}

// the stand-in brain keeps the islander fed and watered for days, the same for a seed
{

	const days = 4;
	const play = ( seed, store ) => {

		const sim = newGame( input, { seed } );
		sim.brain = new StandInBrain();
		if ( store ) placeChest( sim );
		const v = sim.state.villagers[ 0 ];
		let low = 100, built = - 1;
		for ( let t = 0; t < days * 24 * HOUR; t ++ ) {

			sim.step( 1 );
			if ( built < 0 && store && stageOf( sim.state.buildings[ 0 ] ) === 'built' ) built = sim.state.tick;
			// from the first evening on: it starts at 80 with nothing in the bag
			if ( t > 12 * HOUR ) low = Math.min( low, v.needs.satiety, v.needs.hydration );

		}
		return { sim, low, built };

	};
	const bare = play( 2, false ), stocked = play( 2, true );
	assert.ok( bare.low > 45, `needs kept up without a chest (lowest ${ bare.low.toFixed( 1 ) })` );
	assert.ok( stocked.low > 45, `needs kept up with a chest (lowest ${ stocked.low.toFixed( 1 ) })` );
	assert.ok( stocked.built > 0 && stocked.built < 24 * HOUR, `it builds the placed chest on the first day (by ${ ( stocked.built / HOUR ).toFixed( 1 ) } h)` );
	const items = stocked.sim.state.buildings[ 0 ].items;
	assert.ok( ( items.coconut ?? 0 ) > 0 && ( items.fish ?? 0 ) > 0, 'and it stocks the chest a little' );
	assert.equal( play( 2, true ).sim.save(), stocked.sim.save(), 'deterministic for a seed' );
	console.log( `stand-in: ${ days } days, needs never below ${ Math.min( bare.low, stocked.low ).toFixed( 1 ) }; chest built by ${ ( stocked.built / HOUR ).toFixed( 1 ) } h, holds ${ JSON.stringify( items ) }` );

}

// a save taken mid-action plays on as the original
{

	for ( const [ what, call ] of [ [ 'fishing', { tool: 'do', args: { action: 'fish' } } ], [ 'walking', { tool: 'go', args: { place: 'palm' } } ] ] ) {

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

console.log( 'verify-game: all checks passed' );
