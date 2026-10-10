import assert from 'node:assert/strict';
import { Wind, createWindUniforms, CLOCK_PERIOD, GUST_ALONG, EDDY_TILE } from '../src/weather/Wind.ts';
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
// The vegetation's clocks and gust scroll: frozen while paused, the same after a seek as after
// running there at a constant speed, wrapped within their periods and tiles.
const veg = ( w ) => [ w.uniforms.clock.value, w.uniforms.flutter.value, w.uniforms.gustScroll.value.x, w.uniforms.gustScroll.value.y ];
const ran = new Wind( createWindUniforms(), { speed: 11, time: 30 } );
const frozen = veg( ran );
ran.update( 0, 11 );
assert.deepEqual( veg( ran ), frozen, 'A paused frame must not move the plants' );
for ( let i = 0; i < 600; i ++ ) ran.update( 1 / 60, 11 );
const sought = new Wind( createWindUniforms(), { speed: 11, time: 40 } );
veg( ran ).forEach( ( v, i ) => near( v, veg( sought )[ i ], 1e-6 ) );
assert.equal( sought.uniforms.pressure.value, ( 11 / 3.8 ) ** 2 );
const long = new Wind( createWindUniforms(), { speed: 11, time: 86400 * 3 + 0.5 } );
const [ clock, flutter, gusts, eddies ] = veg( long );
assert.ok( clock >= 0 && clock < CLOCK_PERIOD && flutter >= 0 && flutter < CLOCK_PERIOD );
assert.ok( gusts >= 0 && gusts < GUST_ALONG && eddies >= 0 && eddies < EDDY_TILE );
// The previous frame's wind (for motion vectors) is what the last update published, and equals
// the current one after a reset and on a paused frame.
const prev = ( w ) => { const p = w.uniforms.previous; return [ p.clock.value, p.flutter.value, p.gustScroll.value.x, p.gustScroll.value.y, p.pressure.value ]; };
const cur = ( w ) => [ ...veg( w ), w.uniforms.pressure.value ];
const step = new Wind( createWindUniforms(), { speed: 6, time: 12 } );
assert.deepEqual( prev( step ), cur( step ), 'A reset leaves no motion' );
const last = cur( step );
step.update( 1 / 60, 7 );
assert.deepEqual( prev( step ), last, 'previous holds the last frame' );
assert.notDeepEqual( cur( step ), last );
step.update( 0, 7 );
assert.deepEqual( prev( step ), cur( step ), 'A paused frame has no motion' );
const map = long.uniforms.gustMap.image;
assert.equal( map.data.length, map.width * map.height * 2 );
console.log( 'Wind: pause, phase continuity and wrap, advection direction, update cadence, calm ocean bounds, deterministic seek and the previous frame of the vegetation wind pass.' );
