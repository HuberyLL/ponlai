// CPU-only transition contracts; Node's native TypeScript stripping needs no browser/GPU.
// Run: node --experimental-strip-types tools/verify-weather-state.mjs
import assert from 'node:assert/strict';
import { Weather, WEATHER_PRESETS, PARKED_WEATHER } from '../src/sky/Weather.ts';
import { QUALITY } from '../src/Quality.ts';

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
// Headings blend along the shorter arc. Presets currently share one heading, so swap two in.
{
	const clear = WEATHER_PRESETS.clear.windDirection, rain = WEATHER_PRESETS.rain.windDirection;
	try {
		WEATHER_PRESETS.clear.windDirection = 350;
		WEATHER_PRESETS.rain.windDirection = 10;
		const turning = new Weather( 'clear' );
		turning.setWeather( 'rain', 20 );
		turning.update( 10 );
		close( ( ( turning.state.windDirection % 360 ) + 360 ) % 360, 0 );
		turning.update( 10 );
		assert.equal( turning.state.windDirection, 10 );
	} finally {
		WEATHER_PRESETS.clear.windDirection = clear;
		WEATHER_PRESETS.rain.windDirection = rain;
	}
}
// Auto weather is a seeded chain: the same time steps give the same sky, changes move only
// between neighbouring states, and the front reports the transition the clouds sweep through.
{
	const run = () => {
		const auto = new Weather( 'fair' );
		auto.auto = true;
		const seen = [ auto.target ];
		for ( let t = 0; t < 3600; t += 0.5 ) {
			auto.update( 0.5 );
			if ( auto.target !== seen.at( - 1 ) ) seen.push( auto.target );
			const front = auto.front;
			assert.ok( front.progress >= 0 && front.progress <= 1 );
		}
		return seen;
	};
	const first = run(), second = run();
	assert.deepEqual( first, second, 'auto weather must be deterministic' );
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
		else assert.deepEqual( [ ...visited ].sort(), [ 'clear', 'cloudy', 'fair', 'overcast' ], `auto weather from ${ start } visits every kept state` );
	}
	const held = new Weather( 'rain' );
	for ( let t = 0; t < 600; t ++ ) held.update( 1 );
	assert.equal( held.target, 'rain', 'without auto the weather holds' );
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
assert.ok( QUALITY.low.cloudMarch.viewSteps < QUALITY.high.cloudMarch.viewSteps );
assert.ok( QUALITY.low.rainDrops < QUALITY.high.rainDrops );
console.log( 'weather state: transition, interruption, pause, presets, heading wrap, auto chain, moisture, parked weathers out of the chain, lingering showers, ranges and validation passed' );
