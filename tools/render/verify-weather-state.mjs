// CPU-only transition contracts; Node's native TypeScript stripping needs no browser/GPU.
// Run: node --experimental-strip-types tools/render/verify-weather-state.mjs
import { assert, assertions } from '../assert-count.mjs';
import { Weather, WEATHER_PRESETS, WIND_LEVELS, PREVAILING_HEADING, PARKED_WEATHER, daySkyAt, deckRamp, deckSkyGain, deckSkyGap, overcastDeckLight, withMoon } from '../../packages/render/sky/Weather.ts';
import { moonKeyShare } from '../../packages/render/sky/DayCycle.ts';
import { createDayWindows } from '../../packages/render/look/DayLook.ts';
import { ISLAND_LOOK } from '../../packages/island/look/IslandLook.ts';
import { QUALITY } from '../../packages/render/Quality.ts';

const close = ( actual, expected, tolerance = 1e-10 ) => assert.ok( Math.abs( actual - expected ) <= tolerance, `${ actual } != ${ expected }` );
const keys = Object.keys( WEATHER_PRESETS.clear );
const weather = new Weather( 'clear' );
weather.setWeather( 'rain', 20 );
weather.update( 10 );
for ( const key of keys ) close( weather.state[ key ], ( WEATHER_PRESETS.clear[ key ] + WEATHER_PRESETS.rain[ key ] ) / 2 );
close( weather.progress, 0.5 );
const halfway = weather.snapshot();
weather.setWeather( 'fair', 6 );
assert.deepEqual( weather.snapshot(), halfway, 'interrupting must preserve displayed values' );
assert.equal( weather.target, 'fair' );
weather.update( 0 );
assert.deepEqual( weather.snapshot(), halfway, 'zero time must freeze all state' );
weather.update( 0.001 );
assert.ok( Math.abs( weather.state.coverage - halfway.coverage ) < 1e-6, 'interruption must ease continuously' );
weather.update( 10 );
assert.equal( weather.progress, 1 );
for ( const key of keys ) assert.equal( weather.state[ key ], WEATHER_PRESETS.fair[ key ] );

const moisture = weather.state.wetness;
weather.setWeather( 'rain', 0 );
assert.equal( weather.state.wetness, moisture, 'changing the sky must preserve accumulated moisture' );
assert.equal( weather.progress, 1 );
for ( const key of keys ) assert.equal( weather.state[ key ], WEATHER_PRESETS.rain[ key ] );
weather.update( 60 );
assert.ok( weather.state.wetness > moisture, 'rain must wet materials' );
const soaked = weather.state.wetness;
weather.setWeather( 'clear', 0 );
weather.update( 60 );
assert.ok( weather.state.wetness < soaked && weather.state.wetness > soaked * 0.7, 'drying must be gradual' );
weather.update( 10000 );
assert.ok( weather.state.wetness < 1e-10, 'dry weather must eventually dry surfaces' );

for ( const name of Object.keys( WEATHER_PRESETS ) ) {
	const initial = new Weather( name );
	assert.deepEqual( initial.snapshot(), new Weather( name ).snapshot(), 'presets must be deterministic' );
	initial.setWeather( 'rain', 0.2 );
	for ( let i = 0; i < 20; i ++ ) {
		initial.update( i === 19 ? 100000 : 0.03 );
		assert.ok( Object.values( initial.state ).every( Number.isFinite ) );
		for ( const key of [ 'rain', 'wetness', 'coverage', 'directVisibility' ] ) assert.ok( initial.state[ key ] >= 0 && initial.state[ key ] <= 1 );
	}
	const copy = initial.snapshot();
	copy.coverage = - 1;
	assert.notEqual( initial.state.coverage, copy.coverage, 'snapshots must be detached' );
}

for ( const invalid of [ NaN, Infinity, - 1, '1' ] ) {
	const before = weather.snapshot();
	assert.throws( () => weather.update( invalid ), RangeError );
	assert.throws( () => weather.setWeather( 'rain', invalid ), RangeError );
	assert.deepEqual( weather.snapshot(), before, 'invalid input must not mutate state' );
}
for ( const invalid of [ 'hail', '__proto__', '', null ] ) {
	assert.throws( () => new Weather( invalid ), RangeError );
	assert.throws( () => weather.setWeather( invalid ), RangeError );
}
// Headings blend along the shorter arc.
{
	const turning = new Weather( 'clear', { heading: 350 } );
	turning.setWind( { heading: 10 }, 20 );
	turning.update( 10 );
	close( ( ( turning.state.windDirection % 360 ) + 360 ) % 360, 0 );
	turning.update( 10 );
	assert.equal( turning.state.windDirection, 10 );
}
// The wind is a dimension of its own: every sky loads with the gentle wind from the prevailing
// heading (fair's wind as it always was) or a parked sky's own, takes any level and heading, keeps
// its wind across a change of sky, and changes its wind alone with setWind.
{
	const fair = new Weather( 'fair' ).state;
	assert.deepEqual( [ fair.windSpeed, fair.windDirection, fair.gustiness ], [ 3.8, PREVAILING_HEADING, 1.4 ], 'fair\'s wind is unchanged' );
	for ( const name of Object.keys( WEATHER_PRESETS ) ) {
		const loaded = new Weather( name );
		if ( ! PARKED_WEATHER.includes( name ) ) assert.deepEqual( loaded.windTarget, { level: 'gentle', heading: PREVAILING_HEADING }, name );
		for ( const [ level, wind ] of Object.entries( WIND_LEVELS ) ) {
			const w = new Weather( name, { level, heading: 130 } );
			assert.equal( w.state.windSpeed, wind.windSpeed );
			assert.equal( w.state.gustiness, wind.gustiness );
			assert.equal( w.state.windDirection, 130 );
			for ( const key of keys ) assert.equal( w.state[ key ], WEATHER_PRESETS[ name ][ key ], `${ name } ${ level }: ${ key }` );
			const jumped = new Weather( 'overcast' );
			jumped.update( 3 );
			jumped.establish( name, { level, heading: 130 } );
			assert.deepEqual( jumped.snapshot(), w.snapshot(), 'establish equals a fresh load' );
		}
	}
	assert.equal( new Weather( 'storm' ).state.windSpeed, WIND_LEVELS.strong.windSpeed, 'a squall brings its strong wind' );
	const kept = new Weather( 'clear', { level: 'fresh', heading: 100 } );
	kept.setWeather( 'overcast', 0 );
	assert.deepEqual( kept.windTarget, { level: 'fresh', heading: 100 }, 'a change of sky keeps the wind' );
	assert.equal( kept.state.windSpeed, 7 );
	kept.setWind( { level: 'strong' }, 10 );
	assert.equal( kept.target, 'overcast', 'a change of wind keeps the sky' );
	kept.update( 5 );
	close( kept.state.windSpeed, 9, 1e-9 );
	assert.equal( kept.state.coverage, WEATHER_PRESETS.overcast.coverage );
	kept.update( 0 );
	close( kept.state.windSpeed, 9, 1e-9 );
	kept.update( 5 );
	assert.deepEqual( [ kept.state.windSpeed, kept.state.windDirection ], [ 11, 100 ] );
	kept.setWind( { heading: - 20 }, 0 );
	assert.equal( kept.state.windDirection, 340, 'headings wrap to 0 - 360' );
	for ( const invalid of [ { level: 'gale' }, { level: '__proto__' }, { heading: NaN }, { heading: '40' } ] ) {
		assert.throws( () => new Weather( 'fair', invalid ), RangeError );
		assert.throws( () => kept.setWind( invalid ), RangeError );
		assert.throws( () => kept.setWeather( 'fair', 1, invalid ), RangeError );
	}
}
// Auto weather is a seeded chain: the same time steps give the same sky, changes move only
// between neighbouring states, and the front reports the transition the clouds sweep through.
{
	const run = () => {
		const auto = new Weather( 'fair' );
		auto.auto = true;
		const seen = [ auto.target ], winds = [ auto.windTarget ];
		for ( let t = 0; t < 3600; t += 0.5 ) {
			auto.update( 0.5 );
			if ( auto.target !== seen.at( - 1 ) ) { seen.push( auto.target ); winds.push( auto.windTarget ); }
			const front = auto.front;
			assert.ok( front.progress >= 0 && front.progress <= 1 );
		}
		return { seen, winds, state: auto.snapshot() };
	};
	const { seen: first, winds } = run(), second = run();
	assert.deepEqual( first, second.seen, 'auto weather must be deterministic' );
	assert.deepEqual( winds, second.winds, 'auto weather\'s wind must be deterministic' );
	// The sky's sequence is the one it was before the wind had levels (the wind draws from a stream
	// of its own).
	assert.deepEqual( first.slice( 0, 6 ), [ 'fair', 'clear', 'fair', 'clear', 'fair', 'clear' ] );
	// A weather jump to the load leaves the chain as a fresh load's: the same sky and wind after the
	// same steps.
	{
		const jumped = new Weather( 'overcast', { level: 'strong' } );
		jumped.auto = true;
		for ( let t = 0; t < 900; t ++ ) jumped.update( 1 );
		jumped.establish( 'fair' );
		for ( let t = 0; t < 3600; t += 0.5 ) jumped.update( 0.5 );
		assert.deepEqual( jumped.snapshot(), second.state, 'establish restarts both of the chain\'s streams' );
	}
	// The wind moves one level at most per change of sky. Over many hours the gentle wind holds
	// about two thirds of the time, the fresh one about a sixth, light winds are rare and strong ones
	// rarer (about one hour in twenty); the heading's offset from the prevailing wind lies within
	// +-40 degrees about nine times in ten and in the opposite quadrant otherwise.
	{
		const order = Object.keys( WIND_LEVELS );
		for ( let i = 1; i < winds.length; i ++ ) assert.ok( Math.abs( order.indexOf( winds[ i ].level ) - order.indexOf( winds[ i - 1 ].level ) ) <= 1, 'the wind skips a level' );
		const long = new Weather( 'fair' );
		long.auto = true;
		const time = Object.fromEntries( order.map( ( level ) => [ level, 0 ] ) );
		let changes = 0, near = 0, opposite = 0, sky = long.target;
		const hours = 200;
		for ( let t = 0; t < hours * 3600; t += 2 ) {
			long.update( 2 );
			time[ long.windTarget.level ] += 2;
			if ( long.target === sky ) continue;
			sky = long.target;
			changes ++;
			const offset = ( ( long.windTarget.heading - PREVAILING_HEADING ) % 360 + 540 ) % 360 - 180;
			if ( Math.abs( offset ) <= 40 ) near ++;
			else if ( Math.abs( offset ) >= 135 ) opposite ++;
			else assert.fail( `a heading offset of ${ offset } degrees` );
		}
		const share = ( level ) => time[ level ] / ( hours * 3600 );
		console.log( `wind over ${ hours } h: ${ order.map( ( level ) => `${ level } ${ ( 100 * share( level ) ).toFixed( 1 ) } %` ).join( ', ' ) }` );
		assert.ok( share( 'gentle' ) > 0.55 && share( 'gentle' ) < 0.78, `gentle ${ share( 'gentle' ) }` );
		assert.ok( share( 'fresh' ) > 0.12 && share( 'fresh' ) < 0.22, `fresh ${ share( 'fresh' ) }` );
		assert.ok( share( 'light' ) > 0.06 && share( 'light' ) < 0.2, `light ${ share( 'light' ) }` );
		assert.ok( share( 'strong' ) > 0.025 && share( 'strong' ) < 0.08, `strong ${ share( 'strong' ) }` );
		assert.ok( near / changes > 0.85 && opposite / changes > 0.06 && opposite / changes < 0.14, `headings: ${ near } near, ${ opposite } opposite of ${ changes }` );
	}
	assert.ok( first.length >= 8 && first.length <= 40, `an hour should hold several changes, saw ${ first.length }` );
	// Fog sits beside clear and fair weather; the cloud states run from fair to rain.
	const order = [ 'clear', 'fair', 'cloudy', 'overcast', 'rain', 'storm' ];
	for ( let i = 1; i < first.length; i ++ ) {
		const pair = [ first[ i - 1 ], first[ i ] ];
		if ( pair.includes( 'fog' ) ) assert.ok( pair.every( ( name ) => [ 'fog', 'clear', 'fair' ].includes( name ) ), `${ pair } leaves fog's neighbours` );
		else assert.ok( Math.abs( order.indexOf( first[ i ] ) - order.indexOf( first[ i - 1 ] ) ) <= 2, `${ first[ i - 1 ] } -> ${ first[ i ] } skips too far` );
	}
	// The parked weathers (Weather.ts PARKED_WEATHER) are out of the rotation: a chain from any
	// kept state never reaches one, and one loaded in a debug build leaves for a kept state.
	for ( const start of Object.keys( WEATHER_PRESETS ) ) {
		const chain = new Weather( start );
		chain.auto = true;
		const visited = new Set();
		for ( let t = 0; t < 4 * 3600; t += 1 ) { chain.update( 1 ); visited.add( chain.target ); }
		const parked = [ ...visited ].filter( ( name ) => PARKED_WEATHER.includes( name ) && name !== start );
		assert.deepEqual( parked, [], `auto weather from ${ start } reaches parked ${ parked }` );
		if ( PARKED_WEATHER.includes( start ) ) assert.ok( visited.size > 1, `auto weather stays in parked ${ start }` );
		else assert.deepEqual( [ ...visited ].sort(), [ 'clear', 'fair' ], `auto weather from ${ start } visits every kept state` );
	}
	const held = new Weather( 'rain' );
	for ( let t = 0; t < 600; t ++ ) held.update( 1 );
	assert.equal( held.target, 'rain', 'without auto the weather holds' );
}
// The forecast is the auto chain read ahead (the game's forecast): run at frame-sized steps, the
// chain takes every turn it said, to the same sky, and reading it ahead moves nothing. The chain
// counts its dwell from the frame after a front ends, so each turn may come up to a step either
// side of the time read ahead, and the k-th turn within k + 1 steps. Mid-front, the front under way
// comes first.
{
	for ( const [ start, step ] of [ [ 'fair', 0.25 ], [ 'overcast', 1.5 ] ] ) {
		const chain = new Weather( start );
		chain.auto = true;
		for ( let t = 0; t < 700; t += step ) chain.update( step );
		const span = 4 * 3600, turns = chain.forecast( span );
		assert.deepEqual( chain.forecast( span ), turns, 'reading ahead must not move the chain' );
		let k = turns.length > 0 && turns[ 0 ].at < 0 ? 1 : 0, sky = chain.target;
		assert.ok( turns.length - k > 30, `four hours of weather should hold many turns, saw ${ turns.length }` );
		// (run past the span by the slack the last turns may need)
		for ( let t = 0; t < span + ( turns.length + 1 ) * step && k < turns.length; t += step ) {
			chain.update( step );
			if ( chain.target === sky ) continue;
			const turn = turns[ k ++ ];
			assert.equal( chain.target, turn.to, `the chain turned to ${ chain.target }, the forecast said ${ turn.to }` );
			assert.equal( chain.origin, turn.from );
			assert.ok( Math.abs( turn.at - t ) <= ( k + 1 ) * step + 1e-9, `turn ${ k } at ${ t } s was forecast at ${ turn.at } s` );
			sky = chain.target;
		}
		assert.equal( k, turns.length, 'every forecast turn must come' );
	}
	const front = new Weather( 'clear' );
	front.setWeather( 'cloudy', 40 );
	front.update( 10 );
	assert.deepEqual( front.forecast( 3600 ), [ { at: - 10, duration: 40, from: 'clear', to: 'cloudy' } ], 'without auto weather only the front under way is forecast' );
}
// Showers linger after the rain overhead stops, so a clearing sky can still hold a rainbow.
{
	const clearing = new Weather( 'rain' );
	clearing.setWeather( 'clear', 10 );
	clearing.update( 10 );
	assert.equal( clearing.state.rain, 0 );
	clearing.update( 60 );
	assert.ok( clearing.state.showers > 0.25, `showers fade too fast: ${ clearing.state.showers }` );
	clearing.update( 600 );
	assert.ok( clearing.state.showers < 0.01, 'showers must clear within minutes' );
}
// The deck's own light leaves with the sun's: at and below -6 degrees overcast's and cloudy's deck
// light are exactly 0, so the sun's part of the deck's gains is exactly neutral.
for ( let elevation = - 6; elevation >= - 90; elevation -= 0.25 ) {
	assert.equal( overcastDeckLight( elevation ), 0, `overcast's deck light at ${ elevation }` );
	assert.equal( deckRamp( elevation ), 0, `cloudy's deck light at ${ elevation }` );
}
// A fixed stream of numbers in [ 0, 1 ) for the checks below (mulberry32), so a failure repeats.
let seed = 0x5eed;
const random = () => {
	seed = ( seed + 0x6d2b79f5 ) | 0;
	let t = Math.imul( seed ^ ( seed >>> 15 ), 1 | seed );
	t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
	return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;
};
// The moon's light takes the gains the sun's light takes, at the moon's own height (Weather.ts
// `withMoon`: the probes' sky gain and the deck's gains on the land's and the sea's sky light,
// lighting/AmbientRelight.ts; the key's bounce, lighting/AmbientGrade.ts; the day sky on the
// moonlit sky and the clouds' moonlight, sky/Sky.ts): with the moon's share whole, as it is all
// night, a gain is exactly its day value at the moon's height, and with none, as by day, exactly
// the sun's alone.
const dayWindows = createDayWindows( ISLAND_LOOK.day );
for ( let elevation = - 4.5; elevation >= - 90; elevation -= 0.5 ) assert.equal( moonKeyShare( dayWindows, elevation ), 1, `the moon's key share at ${ elevation }` );
for ( const [ clouded, overcast ] of [ [ 0, 0 ], [ 1, 0 ], [ 1, 1 ], [ 0.7, 0.3 ] ] ) {
	const gains = [ ( e ) => deckSkyGain( e, clouded, overcast ), ( e ) => deckSkyGap( e, clouded, overcast ), deckRamp, overcastDeckLight, ( e ) => daySkyAt( 0.173 + 0.827 * ( 1 - overcast ), 0.6 * overcast, e ) ];
	for ( const gain of gains ) for ( const moon of [ 15, 20, 31.5, 60 ] ) {
		for ( let elevation = - 4.5; elevation >= - 90; elevation -= 0.5 ) assert.equal( withMoon( gain( elevation ), gain( moon ), 1 ), gain( moon ), `the night's gain at the moon's ${ moon } degrees` );
		for ( let elevation = 2.5; elevation <= 90; elevation += 0.5 ) assert.equal( withMoon( gain( elevation ), gain( moon ), 0 ), gain( elevation ), `the day's gain at ${ elevation }` );
	}
}
for ( let i = 0; i < 1000; i ++ ) {
	const sun = random() * 8, moon = random() * 8;
	assert.equal( withMoon( sun, moon, 1 ), moon );
	assert.equal( withMoon( sun, moon, 0 ), sun );
}
assert.ok( QUALITY.low.cloudMarch.viewSteps < QUALITY.high.cloudMarch.viewSteps );
assert.ok( QUALITY.low.rainDrops < QUALITY.high.rainDrops );
console.log( `weather state: transition, interruption, pause, presets, heading wrap, wind levels and headings with any sky, auto chain and its wind, the forecast read ahead, moisture, parked weathers out of the chain, lingering showers, the deck light gone by night, the moon gains at its height, ranges and validation passed (${ assertions() } assertions)` );
