// Pure CPU checks; Node 22.18+ strips the imported TypeScript without a build or browser.
// Run: node tools/verify-day-cycle.mjs
import assert from 'node:assert/strict';
import { DayCycle, DAY_PRESETS, NOON_ELEVATION, MOON, cloudMoonShare, displayNight, exposureNight, moonDirection, moonKeyShare, nightAmbientAt, nightAmbientShare, skyNight, starNight, sunElevationAt, morningHour, eveningHour, yunpengNightShare } from '../packages/render/sky/DayCycle.ts';
import { createDayWindows } from '../packages/render/look/DayLook.ts';
import { createExposure } from '../packages/render/look/ExposureLook.ts';
import { ISLAND_LOOK } from '../packages/island/look/IslandLook.ts';

// the island's exposure, which the day cycle takes as the page's sky stage hands it over
const exposure = createExposure( ISLAND_LOOK );
const { day: DAY_EXPOSURE, night: NIGHT_EXPOSURE, nightGain: NIGHT_EXPOSURE_GAIN, nightSky: NIGHT_SKY_EXPOSURE } = exposure;
const exposureAt = ( elevation ) => exposure.at( elevation );
// the island's day windows, which the day cycle and the night's shares take as the sky stage hands
// them over
const windows = createDayWindows( ISLAND_LOOK.day );
const { handoffTop: HANDOFF_TOP, moonKeyTop: MOON_KEY_TOP, dusk: DUSK_WINDOWS } = windows;

const near = ( actual, expected, tolerance = 1e-10 ) => assert.ok( Math.abs( actual - expected ) <= tolerance, `${ actual } != ${ expected }` );
const cycle = new DayCycle( exposure, windows );
// The clock starts at the golden hour, its sun 26.2 degrees up in the afternoon.
near( cycle.hour, DAY_PRESETS[ 'golden-hour' ] );
near( cycle.snapshot().elevation, 26.2, 1e-9 );
// (its azimuth follows from the noon meridian's: a change there or to the west's sign shows here)
near( cycle.snapshot().azimuth, - 0.5566173487906707, 1e-9 );
assert.ok( cycle.hour > 12 );
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

for ( const [ hour, elevation ] of [ [ 0, - NOON_ELEVATION ], [ 6, 0 ], [ 12, NOON_ELEVATION ], [ 18, 0 ] ] ) {

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
// Each preset is the hour its sun stands at its elevation, on its side of noon.
for ( const [ preset, elevation, morning ] of [ [ 'dawn', - 8.6, true ], [ 'sunrise', 2, true ], [ 'golden-hour', 26.2, false ], [ 'sunset', 2, false ], [ 'dusk', - 8.6, false ] ] ) {

	near( sunElevationAt( DAY_PRESETS[ preset ] ), elevation, 1e-9 );
	assert.equal( DAY_PRESETS[ preset ] < 12, morning, `${ preset } is on the wrong side of noon` );

}
assert.equal( DAY_PRESETS.noon, 12 );
assert.equal( DAY_PRESETS.midnight, 0 );
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
	const nightAmbient = nightAmbientAt( windows, s.elevation );
	assert.ok( nightAmbient >= 0 && nightAmbient <= 1 && nightAmbient >= s.nightVisibility );
	if ( s.elevation <= DUSK_WINDOWS.ambient.clouded[ 0 ] ) assert.equal( nightAmbient, 1 );
	if ( s.elevation >= DUSK_WINDOWS.ambient.clouded[ 1 ] ) assert.equal( nightAmbient, 0 );
	// The deep night holds one exposure, so moonlight does not dim as the evening goes on.
	if ( s.elevation <= - 12 ) assert.equal( s.exposure, NIGHT_EXPOSURE );
	// A closed deck's night takes no adaptation of its own; above -1 degree its adaptation is unchanged.
	if ( s.elevation <= - 6 ) assert.equal( s.overcastAdaptation, 0 );
	if ( s.elevation >= - 1 ) near( s.overcastAdaptation, 5 * ( 1 - s.daylight ), 1e-12 );
	// The night sky's own light keeps its tuned brightness (times the night's gain): it scales back
	// as the exposure rises.
	assert.ok( s.nightSkyLevel > 0 && s.nightSkyLevel <= 1 );
	if ( s.elevation >= 8 ) assert.equal( s.nightSkyLevel, 1 );
	if ( s.elevation <= - 14 ) near( s.exposure * s.nightSkyLevel, NIGHT_SKY_EXPOSURE * NIGHT_EXPOSURE_GAIN, 1e-9 );

}
// Every dusk share only grows as the sun sinks, on both sides of the day and under a clear and a
// clouded sky, from +2 to -14 degrees in steps of 0.05, and is exactly 0 from +2.5 degrees up (the
// shares' own shape, the day windows' `dusk`; no GPU).
{

	const daylightAt = ( elevation, rising ) => {

		cycle.setHour( rising ? morningHour( elevation ) : eveningHour( elevation ) );
		return cycle.snapshot().daylight;

	};
	const shares = {
		display: ( e, rising, cloud ) => displayNight( windows, daylightAt( e, rising ), e, rising, cloud ),
		exposure: ( e, rising, cloud ) => exposureNight( windows, e, rising, cloud ),
		stars: ( e, rising, cloud ) => starNight( windows, daylightAt( e, rising ), e, rising, cloud ),
		sky: ( e, rising, cloud ) => skyNight( windows, e, rising, cloud ),
		ambient: ( e, rising, cloud ) => nightAmbientShare( windows, e, rising, cloud ),
		yunpeng: ( e, rising, cloud ) => yunpengNightShare( windows, e, rising, cloud ),
		cloudMoon: ( e, rising, cloud ) => cloudMoonShare( windows, e, rising, cloud ),
		moonKey: ( e ) => moonKeyShare( windows, e ),
	};
	for ( const [ name, share ] of Object.entries( shares ) ) for ( const rising of [ false, true ] ) for ( const cloud of [ 0, 1 ] ) {

		for ( const e of [ 2.5, 3, 4, 6, 10 ] ) assert.equal( share( e, rising, cloud ), 0, `${ name } at ${ e } degrees` );
		let previous = share( 2, rising, cloud );
		for ( let i = 1; i <= 320; i ++ ) {

			const e = 2 - i * 0.05, value = share( e, rising, cloud );
			assert.ok( value >= previous - 1e-12, `${ name } (${ rising ? 'morning' : 'evening' }, cloud ${ cloud }) falls at ${ e.toFixed( 2 ) } degrees` );
			previous = value;

		}

	}

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
	near( nightAmbientAt( windows, before.elevation ), nightAmbientAt( windows, after.elevation ), 1e-5 );
	// (the exposure and the deck's adaptation are several units and steep at the horizon: the
	// same relative step)
	near( before.exposure, after.exposure, 1e-4 );
	near( before.overcastAdaptation, after.overcastAdaptation, 1e-4 );

}
// The moon stands fixed in the sky at every hour and phase. By default its direction is, to within
// rounding, the night's shading direction before the moon was fixed (lighting/KeyLift.ts
// MOON_SHADE then, printed with String()).
const FIXED_MOON = [ 0.3696658004048259, 0.3420201433256687, 0.8639267431736032 ];
cycle.setHour( 0 );
cycle.moonPhase = 0.5;
const moon = cycle.snapshot().moonDir.clone();
moon.toArray().forEach( ( v, i ) => near( v, FIXED_MOON[ i ], 1e-12 ) );
// MOON's turn moves it round from the noon meridian (positive toward the west) at its elevation;
// the disk's light at the first quarter (the west made square to the moon) stays square to it.
const noonSide = Math.atan2( moon.z, moon.x );
const horizontal = ( v ) => v.clone().setY( 0 ).normalize();
for ( const turn of [ 0, 90, 180 ] ) {

	MOON.turn = turn;
	const m = moonDirection( moon.clone() );
	near( m.length(), 1, 1e-12 );
	near( Math.asin( m.y ) * 180 / Math.PI, MOON.elevation, 1e-9 );
	const off = Math.atan2( m.z, m.x ) - ( noonSide - turn * Math.PI / 180 );
	near( Math.atan2( Math.sin( off ), Math.cos( off ) ), 0, 1e-12 );
	cycle.setHour( 18 );
	const west = horizontal( cycle.snapshot().sunDir );
	if ( turn === 90 ) assert.ok( horizontal( m ).distanceTo( west ) < 1e-12 );
	if ( turn === 180 ) assert.ok( horizontal( m ).distanceTo( horizontal( moon ).negate() ) < 1e-12 );
	cycle.setHour( 0 );
	cycle.moonPhase = 0.25;
	const s = cycle.snapshot();
	assert.ok( s.moonDir.distanceTo( m ) < 1e-15, `the snapshot's moon is not moonDirection's at a turn of ${ turn }` );
	near( s.moonSunDir.length(), 1, 1e-12 );
	near( s.moonSunDir.dot( s.moonDir ), 0, 1e-12 );
	cycle.moonPhase = 0.5;

}
MOON.turn = 0;
cycle.setHour( 18 );
const west = cycle.snapshot().sunDir.clone();
const moonWest = west.clone().addScaledVector( moon, - west.dot( moon ) ).normalize();
for ( let minute = 0; minute < 1440; minute += 7 ) {

	cycle.setHour( minute / 60 );
	cycle.moonPhase = 0.5;
	const full = cycle.snapshot();
	for ( const phase of [ 0, 0.125, 0.25, 0.5, 0.75, 0.875, 1 ] ) {

		cycle.moonPhase = phase;
		const s = cycle.snapshot();
		assert.ok( s.moonDir.equals( moon ), `the moon moved at minute ${ minute }` );
		// The phase lights only the disk: the key and its gain are the same at every phase.
		assert.ok( s.keyDir.distanceTo( full.keyDir ) < 1e-12, `the key follows the phase at minute ${ minute }` );
		near( s.moonKeyGain, full.moonKeyGain );
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

		for ( const hour of [ eveningHour( elevation ), morningHour( elevation ) ] ) {

			cycle.setHour( hour );
			const state = cycle.snapshot();
			near( state.keyDir.length(), 1 );
			assert.ok( state.keyDir.toArray().every( Number.isFinite ) );
			// (the moon's key rises from the end of the handoff, MOON_KEY_TOP)
			if ( elevation >= MOON_KEY_TOP ) near( state.moonKeyGain, 0 );
			if ( elevation >= 0 ) assert.equal( state.moonVisibility, 0 );
			if ( elevation >= HANDOFF_TOP ) assert.ok( state.keyDir.distanceTo( state.sunDir ) < 1e-10 );
			if ( elevation <= MOON_KEY_TOP ) assert.ok( state.keyDir.distanceTo( state.moonDir ) < 1e-10 );
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
assert.equal( new DayCycle( exposure, windows ).moonPhase, 0.5 );
for ( let minute = 0; minute < 1440; minute ++ ) {

	cycle.setHour( minute / 60 );
	const s = cycle.snapshot();
	if ( s.elevation >= 0 ) assert.equal( s.moonVisibility, 0 );
	if ( s.elevation <= - 5 ) assert.equal( s.moonVisibility, 1 );

}
// The stars' sky is fixed (STARS): one frame at every hour of the night, on the first day and a
// hundred days on.
const starClock = new DayCycle( exposure, windows, { hour: 0 } );
const starFrame = starClock.snapshot().starFrame.elements.slice();
for ( const days of [ 0, 100 ] ) {

	starClock.setHour( 0 );
	if ( days ) starClock.advance( days * starClock.dayLength );
	assert.equal( starClock.day, days );
	for ( const hour of [ 19, 0, 4 ] ) {

		starClock.setHour( hour );
		starClock.snapshot().starFrame.elements.forEach( ( v, i ) => assert.ok( Object.is( v, starFrame[ i ] ), `the stars moved at ${ hour }h on day ${ days }` ) );

	}

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
	assert.throws( () => new DayCycle( exposure, windows, { hour: invalid } ), RangeError );

}
for ( const invalid of [ 0, - 1 ] ) {

	assert.throws( () => { cycle.dayLength = invalid; }, RangeError );
	assert.throws( () => { cycle.lunarPeriodDays = invalid; }, RangeError );

}
assert.throws( () => cycle.advance( - 1 ), RangeError );
assert.throws( () => cycle.setPreset( 'missing' ), RangeError );
console.log( 'Day cycle: wrapping, presets, speed, pause, rollover, the hours of elevations, continuous directions and grade, phase geometry, fixed stars, isolation and validation passed.' );
