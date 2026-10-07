// Pure CPU checks; Node 22.18+ strips the imported TypeScript without a build or browser.
// Run: node tools/verify-day-cycle.mjs
import assert from 'node:assert/strict';
import { DayCycle, DAY_PRESETS } from '../src/sky/DayCycle.ts';

const near = ( actual, expected, tolerance = 1e-10 ) => assert.ok( Math.abs( actual - expected ) <= tolerance, `${ actual } != ${ expected }` );
const cycle = new DayCycle();
near( cycle.hour, 16 );
near( cycle.snapshot().azimuth, - 8 );
for ( const [ input, expected ] of [ [ 24, 0 ], [ 49, 1 ], [ - 1, 23 ], [ - 48, 0 ] ] ) {

	cycle.setHour( input );
	near( cycle.hour, expected );

}
for ( const [ preset, hour ] of Object.entries( DAY_PRESETS ) ) {

	cycle.setPreset( preset );
	near( cycle.hour, hour );

}
cycle.setHour( 23 );
cycle.dayLength = 240;
cycle.advance( 20 );
near( cycle.hour, 1 );
assert.equal( cycle.day, 1 );
cycle.advance( 480 );
near( cycle.hour, 1 );
assert.equal( cycle.day, 3 );
cycle.paused = true;
cycle.advance( 240 );
near( cycle.hour, 1 );
assert.equal( cycle.day, 3 );
cycle.paused = false;
cycle.dayLength = 120;
cycle.advance( 5 );
near( cycle.hour, 2 );

for ( const [ hour, elevation ] of [ [ 0, - 62 ], [ 6, 0 ], [ 12, 62 ], [ 18, 0 ] ] ) {

	cycle.setHour( hour );
	near( cycle.snapshot().elevation, elevation );

}
for ( let minute = 0; minute <= 1440; minute ++ ) {

	cycle.setHour( minute / 60 );
	const s = cycle.snapshot();
	near( s.sunDir.length(), 1 );
	near( s.moonDir.length(), 1 );
	near( s.keyDir.length(), 1 );
	for ( const key of [ 'daylight', 'nightVisibility', 'moonVisibility', 'moonIllumination', 'moonKeyGain' ] ) assert.ok( Number.isFinite( s[ key ] ) && s[ key ] >= 0 && s[ key ] <= 1, key );
	assert.ok( s.exposure >= 2.6 && s.exposure <= 4.4 * 1.6 );
	assert.ok( s.blackLift >= 0.002 - 1e-12 && s.blackLift <= 0.027 + 1e-12 );

}
// Probe direction and suggested grade on both sides of horizon, midnight and solar noon.
for ( const hour of [ 0, 6, 12, 18, 24 ] ) {

	cycle.setHour( hour - 1e-6 );
	const before = cycle.snapshot();
	cycle.setHour( hour + 1e-6 );
	const after = cycle.snapshot();
	assert.ok( before.sunDir.distanceTo( after.sunDir ) < 1e-6 );
	assert.ok( before.moonDir.distanceTo( after.moonDir ) < 1e-6 );
	assert.ok( before.keyDir.distanceTo( after.keyDir ) < 1e-6 );
	for ( const key of [ 'daylight', 'nightVisibility', 'exposure', 'blackLift' ] ) near( before[ key ], after[ key ], 1e-5 );

}
cycle.setHour( 16 );
for ( const phase of [ 0, 0.125, 0.25, 0.5, 0.75, 0.875, 1 ] ) {

	cycle.moonPhase = phase;
	const s = cycle.snapshot();
	near( s.sunDir.dot( s.moonDir ), Math.cos( 2 * Math.PI * phase ) );
	near( s.moonIllumination, ( 1 - Math.cos( 2 * Math.PI * phase ) ) / 2 );

}
// Every moon phase has a finite key throughout both handoffs, including the antipodal full
// moon. Radiance stays exactly zero while that direction changes from one source to the other.
for ( const phase of [ 0, 0.125, 0.25, 0.499999, 0.5, 0.500001, 0.75, 0.875, 0.999999 ] ) {

	cycle.moonPhase = phase;
	for ( const elevation of [ - 7, - 3.01, - 3, - 2.5, - 1.6, - 0.7, - 0.25, 0, 0.5 ] ) {

		const sunsetHour = 12 + Math.acos( Math.sin( elevation * Math.PI / 180 ) / Math.sin( 62 * Math.PI / 180 ) ) * 12 / Math.PI;
		for ( const hour of [ sunsetHour, 24 - sunsetHour ] ) {

			cycle.setHour( hour );
			const state = cycle.snapshot();
			near( state.keyDir.length(), 1 );
			assert.ok( state.keyDir.toArray().every( Number.isFinite ) );
			if ( elevation >= - 3 ) near( state.moonKeyGain, 0 );
			if ( phase === 0 || state.moonElevation <= 0 ) assert.equal( state.moonKeyGain, 0 );
			if ( elevation >= - 0.7 ) assert.ok( state.keyDir.distanceTo( state.sunDir ) < 1e-10 );
			if ( elevation <= - 2.5 ) assert.ok( state.keyDir.distanceTo( state.moonDir ) < 1e-10 );
			cycle.setHour( hour - 1e-7 );
			const before = cycle.snapshot();
			cycle.setHour( hour + 1e-7 );
			const after = cycle.snapshot();
			assert.ok( before.keyDir.distanceTo( after.keyDir ) < 2e-5 );
			near( before.moonKeyGain, after.moonKeyGain, 1e-6 );
			// Sampling different phases must never move the atmosphere's real sun.
			cycle.moonPhase = ( phase + 0.3 ) % 1;
			assert.ok( cycle.snapshot().sunDir.distanceTo( after.sunDir ) < 1e-10 );
			cycle.moonPhase = phase;

		}

	}

}
cycle.moonPhase = 0.25;
cycle.setHour( 18 );
near( cycle.snapshot().moonElevation, 62 );
cycle.moonPhase = 0.75;
cycle.setHour( 6 );
near( cycle.snapshot().moonElevation, 62 );
cycle.moonPhase = - 0.25;
near( cycle.moonPhase, 0.75 );
cycle.moonPhase = 0.5;
cycle.advance( cycle.dayLength );
near( cycle.moonPhase, 0.5 );
cycle.advanceMoonPhase = true;
cycle.lunarPeriodDays = 30;
cycle.advance( cycle.dayLength );
near( cycle.moonPhase, 0.5 + 1 / 30 );

cycle.setHour( 12 );
const day = cycle.snapshot();
cycle.setHour( 0 );
const night = cycle.snapshot();
assert.equal( day.daylight, 1 );
assert.equal( day.nightVisibility, 0 );
assert.equal( night.daylight, 0 );
assert.equal( night.nightVisibility, 1 );
// Less than one photographic stop of adaptation keeps night visibly darker.
assert.ok( night.exposure / day.exposure < 2 );
assert.ok( night.blackLift < day.blackLift / 10 );
night.sunDir.set( 0, 0, 0 );
near( cycle.snapshot().sunDir.length(), 1 );

for ( const invalid of [ NaN, Infinity, - Infinity ] ) {

	assert.throws( () => cycle.setHour( invalid ), RangeError );
	assert.throws( () => { cycle.moonPhase = invalid; }, RangeError );
	assert.throws( () => { cycle.dayLength = invalid; }, RangeError );
	assert.throws( () => { cycle.lunarPeriodDays = invalid; }, RangeError );
	assert.throws( () => cycle.advance( invalid ), RangeError );
	assert.throws( () => new DayCycle( { hour: invalid } ), RangeError );

}
for ( const invalid of [ 0, - 1 ] ) {

	assert.throws( () => { cycle.dayLength = invalid; }, RangeError );
	assert.throws( () => { cycle.lunarPeriodDays = invalid; }, RangeError );

}
assert.throws( () => cycle.advance( - 1 ), RangeError );
assert.throws( () => cycle.setPreset( 'missing' ), RangeError );
console.log( 'Day cycle: wrapping, presets, speed, pause, rollover, continuous directions and grade, phase geometry, isolation and validation passed.' );
