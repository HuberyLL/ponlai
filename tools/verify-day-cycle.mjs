// Pure CPU checks; Node 22.18+ strips the imported TypeScript without a build or browser.
// Run: node tools/verify-day-cycle.mjs
import assert from 'node:assert/strict';
import { DayCycle, DAY_PRESETS, DAY_EXPOSURE, NIGHT_EXPOSURE, NIGHT_EXPOSURE_GAIN, NIGHT_SKY_EXPOSURE, NOON_ELEVATION, exposureAt, nightAmbientAt, sunElevationAt, morningHour, eveningHour } from '../src/sky/DayCycle.ts';

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
// The hour of an elevation is the inverse of the elevation of an hour, on either side of noon, and
// the sun's path agrees with the clock's sun.
for ( let hour = 0; hour < 24; hour ++ ) {

	const elevation = sunElevationAt( hour );
	near( hour <= 12 ? morningHour( elevation ) : eveningHour( elevation ), hour, 1e-9 );
	cycle.setHour( hour );
	near( cycle.snapshot().elevation, elevation, 1e-9 );

}
near( morningHour( NOON_ELEVATION ), 12, 1e-9 );
near( eveningHour( NOON_ELEVATION ), 12, 1e-9 );
near( morningHour( - NOON_ELEVATION ), 0, 1e-9 );
near( eveningHour( - NOON_ELEVATION ), 24, 1e-9 );
for ( const invalid of [ NOON_ELEVATION + 1e-6, - NOON_ELEVATION - 1e-6, NaN ] ) {

	assert.throws( () => morningHour( invalid ), RangeError );
	assert.throws( () => eveningHour( invalid ), RangeError );

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
// The moon stands fixed in the sky at every hour and phase. Its direction keeps the bits of the
// night's shading direction before the moon was fixed (lighting/KeyLift.ts MOON_SHADE then, printed
// with String()), so the night's paused frames kept theirs.
const FIXED_MOON = [ 0.3696658004048259, 0.3420201433256687, 0.8639267431736032 ];
cycle.setHour( 0 );
cycle.moonPhase = 0.5;
const moon = cycle.snapshot().moonDir.clone();
moon.toArray().forEach( ( v, i ) => assert.ok( Object.is( v, FIXED_MOON[ i ] ), `moon ${ i }: ${ v } != ${ FIXED_MOON[ i ] }` ) );
cycle.setHour( 18 );
const west = cycle.snapshot().sunDir.clone();
const moonWest = west.clone().addScaledVector( moon, - west.dot( moon ) ).normalize();
for ( let minute = 0; minute < 1440; minute += 7 ) {

	cycle.setHour( minute / 60 );
	for ( const phase of [ 0, 0.125, 0.25, 0.5, 0.75, 0.875, 1 ] ) {

		cycle.moonPhase = phase;
		const s = cycle.snapshot();
		assert.ok( s.moonDir.equals( moon ), `the moon moved at minute ${ minute }` );
		near( s.moonElevation, 20 );
		near( s.moonSunDir.dot( s.moonDir ), Math.cos( 2 * Math.PI * phase ) );
		near( s.moonIllumination, ( 1 - Math.cos( 2 * Math.PI * phase ) ) / 2 );
		// (a new moon is lit from behind, the first quarter from the west, the full moon from the front)
		if ( phase === 0 ) assert.ok( s.moonSunDir.distanceTo( moon ) < 1e-12 );
		if ( phase === 0.25 ) assert.ok( s.moonSunDir.distanceTo( moonWest ) < 1e-12 );
		if ( phase === 0.5 ) assert.ok( s.moonSunDir.distanceTo( moon.clone().negate() ) < 1e-12 );

	}

}
cycle.moonPhase = 0.5;
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
			if ( elevation >= 0 ) assert.equal( state.moonVisibility, 0 );
			if ( elevation >= - 0.7 ) assert.ok( state.keyDir.distanceTo( state.sunDir ) < 1e-10 );
			if ( elevation <= - 2.5 ) assert.ok( state.keyDir.distanceTo( state.moonDir ) < 1e-10 );
			// Between them the key lies on the great circle from the sun to the moon.
			near( state.keyDir.angleTo( state.sunDir ) + state.keyDir.angleTo( state.moonDir ), state.sunDir.angleTo( state.moonDir ), 1e-9 );
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
// A new clock's moon is full; it shows only once the sun is five degrees down.
assert.equal( new DayCycle().moonPhase, 0.5 );
for ( let minute = 0; minute < 1440; minute ++ ) {

	cycle.setHour( minute / 60 );
	const s = cycle.snapshot();
	if ( s.elevation >= 0 ) assert.equal( s.moonVisibility, 0 );
	if ( s.elevation <= - 5 ) assert.equal( s.moonVisibility, 1 );

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
console.log( 'Day cycle: wrapping, presets, speed, pause, rollover, the hours of elevations, continuous directions and grade, phase geometry, isolation and validation passed.' );
