// CPU-only transition contracts; Node's native TypeScript stripping needs no browser/GPU.
// Run: node --experimental-strip-types tools/verify-weather-state.mjs
import assert from 'node:assert/strict';
import { Weather, WEATHER_PRESETS, WEATHER_QUALITY } from '../src/sky/Weather.ts';

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
for ( const invalid of [ 'storm', '__proto__', '', null ] ) {
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
assert.ok( WEATHER_QUALITY.low.cloudSteps < WEATHER_QUALITY.high.cloudSteps );
assert.ok( WEATHER_QUALITY.low.rainDrops < WEATHER_QUALITY.high.rainDrops );
console.log( 'weather state: transition, interruption, pause, presets, heading wrap, moisture, ranges and validation passed' );
