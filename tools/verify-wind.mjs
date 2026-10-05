import assert from 'node:assert/strict';
import { Wind, createWindUniforms } from '../src/weather/Wind.ts';
import { Weather } from '../src/sky/Weather.ts';

const near = ( a, b, tolerance = 1e-9 ) => assert.ok( Math.abs( a - b ) <= tolerance, `${ a } != ${ b }` );
const wind = new Wind( createWindUniforms(), { time: 12 } );
const start = wind.uniforms.phase.value;
const offset = wind.uniforms.cloudOffset.value.clone();
wind.update( 0, 5.2 );
near( wind.uniforms.phase.value, start );
assert.ok( wind.uniforms.cloudOffset.value.equals( offset ), 'A preset change while paused must not teleport clouds' );
wind.update( 0.1, 5.2 );
assert.ok( wind.uniforms.phase.value > start );
assert.ok( wind.uniforms.displacement.value.dot( wind.uniforms.direction.value ) > 0 );
assert.ok( wind.uniforms.cloudOffset.value.dot( wind.uniforms.direction.value ) < 0, 'Density coordinates advect against physical travel' );

const run = ( step ) => {

	const weather = new Weather( 'clear' );
	const local = new Wind( createWindUniforms(), { speed: weather.state.windSpeed } );
	weather.setWeather( 'rain', 8 );
	for ( let t = 0; t < 12 - 1e-8; t += step ) {

		weather.update( step );
		local.update( step, weather.state.windSpeed, weather.state.windDirection );

	}
	return local;

};
const coarse = run( 0.05 ), fine = run( 0.01 );
near( coarse.uniforms.phase.value, fine.uniforms.phase.value, 1e-7 );
assert.ok( coarse.uniforms.cloudOffset.value.distanceTo( fine.uniforms.cloudOffset.value ) < 1e-7 );
assert.ok( coarse.uniforms.oceanGain.value.toArray().every( ( gain ) => gain > 0 && gain < 1.4 ) );
wind.reset( { time: 12 } );
near( wind.uniforms.phase.value, start );
assert.ok( wind.uniforms.cloudOffset.value.equals( offset ), 'Explicit fixed-time reset must reproduce startup' );
for ( const invalid of [ NaN, Infinity, - 1 ] ) assert.throws( () => wind.update( invalid ), RangeError );
// The phase wraps where every shader rate completes whole turns, so long sessions stay seamless.
const period = 1600 * 2 * Math.PI;
const late = new Wind( createWindUniforms(), { time: period / 1.6 - 0.01 } );
const before = late.uniforms.phase.value;
late.update( 0.02 );
assert.ok( late.uniforms.phase.value < before, 'phase must wrap' );
for ( const rate of [ 1, 2.7, 13 / 16, 13 / 16 * 1.3, 13 / 16 * 0.91, 13 / 16 * 0.83 ] ) {
	near( Math.sin( rate * late.uniforms.phase.value ), Math.sin( rate * ( before + 0.032 ) ), 1e-6 );
}
const day = new Wind( createWindUniforms(), { time: 86400 } );
assert.ok( day.uniforms.phase.value >= 0 && day.uniforms.phase.value < period );
console.log( 'Wind: pause, phase continuity and wrap, advection direction, update cadence, calm ocean bounds and deterministic seek pass.' );
