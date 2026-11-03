// Pure CPU checks; Node 22.18+ strips the imported TypeScript without a build or browser.
// Run: node tools/verify-day-cycle.mjs
import assert from 'node:assert/strict';
import { DayCycle, DAY_PRESETS, DAY_EXPOSURE, NIGHT_EXPOSURE, NIGHT_EXPOSURE_GAIN, NIGHT_SKY_EXPOSURE, exposureAt, nightAmbientAt } from '../src/sky/DayCycle.ts';

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
	assert.ok( s.exposure >= DAY_EXPOSURE - 1e-12 && s.exposure <= NIGHT_EXPOSURE + 1e-12 );
	assert.equal( s.exposure, exposureAt( s.elevation ) );
	// The night's ambient arrives before the stars, across the band where the sun's sky fades.
	const nightAmbient = nightAmbientAt( s.elevation );
	assert.ok( nightAmbient >= 0 && nightAmbient <= 1 && nightAmbient >= s.nightVisibility );
	if ( s.elevation <= - 5 ) assert.equal( nightAmbient, 1 );
	if ( s.elevation >= 1 ) assert.equal( nightAmbient, 0 );
	// Night holds one exposure, so moonlight does not dim as the evening goes on.
	if ( s.elevation <= - 7 ) assert.equal( s.exposure, NIGHT_EXPOSURE );
	// A closed deck at night keeps the exposure it was tuned with; above -1 degree its
	// adaptation is unchanged.
	if ( s.elevation <= - 7 ) near( s.exposure * ( 1 + s.overcastAdaptation ), NIGHT_EXPOSURE * 3, 1e-9 );
	if ( s.elevation >= - 1 ) near( s.overcastAdaptation, 5 * ( 1 - s.daylight ), 1e-12 );
	// The night sky's own light keeps its tuned brightness (times the night's gain): it scales back
	// as the exposure rises.
	assert.ok( s.nightSkyLevel > 0 && s.nightSkyLevel <= 1 );
	if ( s.elevation >= 8 ) assert.equal( s.nightSkyLevel, 1 );
	if ( s.elevation <= - 14 ) near( s.exposure * s.nightSkyLevel, NIGHT_SKY_EXPOSURE * NIGHT_EXPOSURE_GAIN, 1e-9 );

}
// Through the afternoon and evening the exposure only rises: no hump at twilight.
for ( let minute = 12 * 60 + 1; minute <= 1440; minute ++ ) {

	cycle.setHour( ( minute - 1 ) / 60 );
	const earlier = cycle.snapshot().exposure;
	cycle.setHour( minute / 60 );
	assert.ok( cycle.snapshot().exposure >= earlier - 1e-12, `exposure falls at minute ${ minute }` );

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
	for ( const key of [ 'daylight', 'nightVisibility' ] ) near( before[ key ], after[ key ], 1e-5 );
	near( nightAmbientAt( before.elevation ), nightAmbientAt( after.elevation ), 1e-5 );
	// (the exposure and the deck's adaptation are several units and steep at the horizon: the
	// same relative step)
	near( before.exposure, after.exposure, 1e-4 );
	near( before.overcastAdaptation, after.overcastAdaptation, 1e-4 );

}
// The moon keeps a full moon's place at every phase; the phase lights only its drawn disk, from
// where the sun would stand on the moon's orbit, the phase's angle away. At 6:00 and 18:00, where
// the two orbits meet, the full moon's light is the sun itself.
for ( const hour of [ 0, 6, 18, 21 ] ) {

	cycle.setHour( hour );
	cycle.moonPhase = 0.5;
	const full = cycle.snapshot();
	if ( hour === 6 || hour === 18 ) assert.ok( full.moonSunDir.distanceTo( full.sunDir ) < 1e-10 );
	for ( const phase of [ 0, 0.125, 0.25, 0.5, 0.75, 0.875, 1 ] ) {

		cycle.moonPhase = phase;
		const s = cycle.snapshot();
		assert.ok( s.moonDir.distanceTo( full.moonDir ) < 1e-12 && s.keyDir.distanceTo( full.keyDir ) < 1e-12 );
		near( s.moonKeyGain, full.moonKeyGain );
		near( s.moonSunDir.dot( s.moonDir ), Math.cos( 2 * Math.PI * phase ) );
		near( s.moonIllumination, ( 1 - Math.cos( 2 * Math.PI * phase ) ) / 2 );

	}

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
			// (the moon's key rises from the end of the handoff, -2.5 degrees)
			if ( elevation >= - 2.5 ) near( state.moonKeyGain, 0 );
			if ( state.moonElevation <= 0 ) assert.equal( state.moonKeyGain, 0 );
			if ( elevation >= - 0.7 ) assert.ok( state.keyDir.distanceTo( state.sunDir ) < 1e-10 );
			if ( elevation <= - 2.5 ) assert.ok( state.keyDir.distanceTo( state.moonDir ) < 1e-10 );
			cycle.setHour( hour - 1e-7 );
			const before = cycle.snapshot();
			cycle.setHour( hour + 1e-7 );
			const after = cycle.snapshot();
			assert.ok( before.keyDir.distanceTo( after.keyDir ) < 2e-5 );
			// (2e-6: the moon's key rises over two degrees, so its slope is steep)
			near( before.moonKeyGain, after.moonKeyGain, 2e-6 );
			// Sampling different phases must never move the atmosphere's real sun.
			cycle.moonPhase = ( phase + 0.3 ) % 1;
			assert.ok( cycle.snapshot().sunDir.distanceTo( after.sunDir ) < 1e-10 );
			cycle.moonPhase = phase;

		}

	}

}
// The moon's authored orbit culminates at 20 degrees (the sun's 62 less its 42 degree tilt), at
// midnight whatever the phase; a new clock's moon is full.
assert.equal( new DayCycle().moonPhase, 0.5 );
for ( const phase of [ 0, 0.25, 0.5, 0.75 ] ) {

	cycle.moonPhase = phase;
	cycle.setHour( 0 );
	near( cycle.snapshot().moonElevation, 20 );

}
cycle.moonPhase = 0.5;
// A full moon still rises due east at 18:00, where the sun rose, and sets due west at 6:00, where
// the sun set; through the night it stays above the horizon.
for ( const [ hour, sunHour ] of [ [ 18, 6 ], [ 6, 18 ] ] ) {

	cycle.setHour( sunHour );
	const sun = cycle.snapshot().sunDir;
	cycle.setHour( hour );
	const s = cycle.snapshot();
	near( s.moonElevation, 0, 1e-9 );
	assert.ok( s.moonDir.distanceTo( sun ) < 1e-10 );

}
for ( let minute = 18 * 60 + 1; minute < 30 * 60; minute ++ ) {

	cycle.setHour( minute / 60 );
	assert.ok( cycle.snapshot().moonElevation > 0 );

}
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
// The day and the night hold the table's ends.
assert.equal( day.exposure, DAY_EXPOSURE );
assert.equal( night.exposure, NIGHT_EXPOSURE );
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
