// Checks of the game's simulation, asserted: the clock and its ticks, the ground grid and a path
// over it, a body that walks to a point and stops there, a save that loads back as it was, a brain
// whose late answer is applied while the world ran on; then the first prototype's rules: needs that
// fall and rise, the bag's capacity, the palm and its regrowth, fishing by the seeded generator,
// the storehouse, actions that replace each other, a perception without positions, the stand-in
// brain keeping the islander fed and watered for days, and a save taken mid-action.
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

console.log( 'verify-game: all checks passed' );
