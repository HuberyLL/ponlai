import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './island-look.mjs';
import { Wind, createWindUniforms as windUniforms, flutterWave, plantRate, plantWave, wave, weatherWind, windResponse, CLOCK_PERIOD, GUST_TILE, GUST_TRAVEL, GUST_TIME_PERIOD, GUST_EVOLUTION, PLANT_RATE_BANDS, REFERENCE_SPEED, REFERENCE_GUSTINESS, plantSpeedOf as speedOf } from '../packages/render/weather/Wind.ts';
import { ISLAND_LOOK } from '../packages/island/look/IslandLook.ts';
import { Weather, WIND_LEVELS, PREVAILING_HEADING } from '../packages/render/sky/Weather.ts';
import { debugFlags } from '../packages/render/debug/DebugFlags.ts';

// the island's wind look, as the page's shared uniforms take it (shared.ts `createShared`)
const response = windResponse( ISLAND_LOOK.wind );
const createWindUniforms = () => windUniforms( response );
const plantSpeedOf = ( u10 ) => speedOf( response, u10 );
const PLANT_RATE_SPREAD = response.plantRateSpread;
const near = ( a, b, tolerance = 1e-9 ) => assert.ok( Math.abs( a - b ) <= tolerance, `${ a } != ${ b }` );
const wind = new Wind( createWindUniforms(), { time: 12 } );
const start = wind.uniforms.displacement.value.clone();
wind.update( 0, 5.2 );
assert.ok( wind.uniforms.displacement.value.equals( start ), 'A preset change while paused must not move the air' );
wind.update( 0.1, 5.2 );
assert.ok( wind.uniforms.displacement.value.distanceTo( start ) > 0 );
assert.ok( wind.uniforms.displacement.value.dot( wind.uniforms.direction.value ) > 0 );

const run = ( step ) => {

	const weather = new Weather( 'clear' );
	const local = new Wind( createWindUniforms(), weatherWind( weather.state ) );
	weather.setWeather( 'cloudy', 8, { level: 'fresh', heading: 130 } );
	for ( let t = 0; t < 12 - 1e-8; t += step ) {

		weather.update( step );
		local.update( step, weather.state.windSpeed, weather.state.windDirection, weather.state.gustiness );

	}
	return local;

};
const coarse = run( 0.05 ), fine = run( 0.01 );
assert.ok( coarse.uniforms.displacement.value.distanceTo( fine.uniforms.displacement.value ) < 1e-6 );
// the sea stays within its calm design in the light and gentle winds; the fresh and strong ones
// build it beyond (Wind.ts `publish`)
for ( const level of [ 'light', 'gentle' ] ) assert.equal( new Wind( createWindUniforms(), { speed: WIND_LEVELS[ level ].windSpeed } ).uniforms.gale.value, 0, level );
wind.reset( { time: 12 } );
assert.ok( wind.uniforms.displacement.value.equals( start ), 'Explicit fixed-time reset must reproduce startup' );
for ( const invalid of [ NaN, Infinity, - 1 ] ) assert.throws( () => wind.update( invalid ), RangeError );
for ( const invalid of [ NaN, 0.9 ] ) assert.throws( () => wind.update( 0, 3.8, 40, invalid ), RangeError );
// Every wind level gives the wind its speed and gust factor, and the parts read them from Wind alone.
for ( const [ name, level ] of Object.entries( WIND_LEVELS ) ) {

	for ( const key of [ 'windSpeed', 'gustiness' ] ) assert.ok( Number.isFinite( level[ key ] ), `${ name }: ${ key }` );
	assert.ok( level.gustiness >= 1, `${ name }: a gust factor below 1` );

}
// fair's load is the wind the plants and the sea were tuned at
assert.deepEqual( weatherWind( new Weather( 'fair' ).state ), { speed: REFERENCE_SPEED, heading: PREVAILING_HEADING, gustiness: REFERENCE_GUSTINESS } );
// A plant's own sway rate (Wind.ts `plantRate`, `plantWave`'s): its kind's and up to
// the look's plantRateSpread of it quicker, in PLANT_RATE_BANDS bands from the kind's own to the spread's
// top, always whole cycles per CLOCK_PERIOD (the bamboo's culms, the yunpeng and the branches, the
// sprays: Deform.ts).
for ( const rate of [ 0.095, 0.16, 0.21 ] ) {

	const bands = new Set();
	for ( let i = 0; i < 1024; i ++ ) {

		const f = plantRate( response, rate, ( i + 0.5 ) / 1024 );
		near( f * CLOCK_PERIOD, Math.round( f * CLOCK_PERIOD ), 1e-6 );
		assert.ok( f >= rate - 1e-12 && f <= rate * ( 1 + PLANT_RATE_SPREAD ) + 0.0005 + 1e-12, `${ rate }: ${ f }` );
		bands.add( f );

	}
	assert.equal( bands.size, PLANT_RATE_BANDS, `${ rate }: ${ [ ...bands ] }` );
	assert.ok( bands.has( rate ) && Math.max( ...bands ) >= rate * ( 1 + PLANT_RATE_SPREAD ) - 0.0005, `${ rate }: ${ [ ...bands ] }` );

}
// The sea's spectrum starts from the reference speed and the prevailing heading, whatever the
// weather's wind (OceanFFT.setWind then takes the weather's speed and heading for the wind sea),
// and its swell keeps the prevailing heading.
assert.deepEqual( new Wind( createWindUniforms(), { speed: 11, heading: 25 } ).spectrumWind, { windSpeed: REFERENCE_SPEED, windDirection: PREVAILING_HEADING, swellHeading: PREVAILING_HEADING } );
// The leaves' flutter keeps its rate in any wind: their clock is the same at any speed, while the
// gusts travel GUST_TRAVEL times the plants' speed and the grass and the plants sway on the plants'
// travel; the gusts' time axis runs at GUST_EVOLUTION whatever the wind.
for ( const t of [ 0, 12, 37.25, 86400 * 3 + 0.5 ] ) {

	const calm = new Wind( createWindUniforms(), { speed: 1, time: t } ), gale = new Wind( createWindUniforms(), { speed: 11, time: t } );
	assert.equal( calm.uniforms.clock.value, gale.uniforms.clock.value );
	assert.equal( calm.uniforms.gustTime.value, gale.uniforms.gustTime.value );
	near( gale.uniforms.gustTime.value, t * GUST_EVOLUTION % GUST_TIME_PERIOD, 1e-9 );
	near( gale.uniforms.gustScroll.value, GUST_TRAVEL * t * plantSpeedOf( 11 ) % GUST_TILE, 1e-6 );
	// the plants' phase clock is their travel (their speed, U10 mapped): the grass's and the
	// plants' swing quickens with the wind
	near( gale.uniforms.plantClock.value, t * plantSpeedOf( 11 ) % CLOCK_PERIOD, 1e-6 );
	near( calm.uniforms.plantClock.value, t * plantSpeedOf( 1 ) % CLOCK_PERIOD, 1e-6 );

}
// the gusts' time wraps where the clock does: GUST_EVOLUTION cells a second over CLOCK_PERIOD
near( GUST_TIME_PERIOD, GUST_EVOLUTION * CLOCK_PERIOD, 1e-12 );
// The vegetation's clocks and the gusts' scroll and time: frozen while paused, the same after a seek as after
// running there at a constant speed, wrapped within their periods and tiles.
const veg = ( w ) => [ w.uniforms.clock.value, w.uniforms.gustScroll.value, w.uniforms.gustTime.value, w.uniforms.plantClock.value ];
const ran = new Wind( createWindUniforms(), { speed: 11, time: 30 } );
const frozen = veg( ran );
ran.update( 0, 11 );
assert.deepEqual( veg( ran ), frozen, 'A paused frame must not move the plants' );
for ( let i = 0; i < 600; i ++ ) ran.update( 1 / 60, 11 );
const sought = new Wind( createWindUniforms(), { speed: 11, time: 40 } );
veg( ran ).forEach( ( v, i ) => near( v, veg( sought )[ i ], 1e-6 ) );
assert.equal( sought.uniforms.breeze.value, 11 / 3.8 );
// the plants' speed: the levels' points, a line between them and past the last one
for ( const [ u, p ] of [ [ 0, 0 ], [ 1.5, 4 ], [ 3.8, 9.5 ], [ 7, 13 ], [ 11, 17 ], [ 5.4, 11.25 ], [ 15, 21 ] ] ) near( plantSpeedOf( u ), p, 1e-9 );
assert.equal( sought.uniforms.plantSpeed.value, plantSpeedOf( 11 ) );
const long = new Wind( createWindUniforms(), { speed: 11, time: 86400 * 3 + 0.5 } );
const [ clock, gustTravel, gustTime, plantClock ] = veg( long );
assert.ok( plantClock >= 0 && plantClock < CLOCK_PERIOD );
assert.ok( clock >= 0 && clock < CLOCK_PERIOD );
assert.ok( gustTravel >= 0 && gustTravel < GUST_TILE && gustTime >= 0 && gustTime < GUST_TIME_PERIOD );
// The previous frame's wind (for motion vectors) is what the last update published, and equals
// the current one after a reset and on a paused frame.
const prev = ( w ) => { const p = w.uniforms.previous; return [ p.clock.value, p.gustScroll.value, p.gustTime.value, p.plantClock.value, p.breeze.value, p.plantSpeed.value ]; };
const cur = ( w ) => [ ...veg( w ), w.uniforms.breeze.value, w.uniforms.plantSpeed.value ];
const step = new Wind( createWindUniforms(), { speed: 6, time: 12 } );
assert.deepEqual( prev( step ), cur( step ), 'A reset leaves no motion' );
const last = cur( step );
step.update( 1 / 60, 7 );
assert.deepEqual( prev( step ), last, 'previous holds the last frame' );
assert.notDeepEqual( cur( step ), last );
step.update( 0, 7 );
assert.deepEqual( prev( step ), cur( step ), 'A paused frame has no motion' );
// Motion vectors read the previous frame's wind (`previous`): every value the sway reads, as the
// last RENDERED frame drew it. main.ts updates the wind once per tick and every tick renders, so
// before each update the current state is the frame just drawn. Steps of dt and then 2 dt, a
// change of speed and heading, and paused frames.
// (`response` is no uniform: the look's numbers, one object both states share)
const state = ( w ) => Object.fromEntries( Object.entries( w ).filter( ( [ k ] ) => k !== 'response' ).map( ( [ k, u ] ) => [ k, typeof u.value === 'number' ? u.value : u.value.toArray() ] ) );
const vegetationKeys = Object.keys( createWindUniforms().previous );
assert.equal( wind.uniforms.previous.response, wind.uniforms.response, 'both states carry the wind\'s one response' );
const current = ( w ) => state( Object.fromEntries( vegetationKeys.map( ( k ) => [ k, w.uniforms[ k ] ] ) ) );
const previous = ( w ) => state( w.uniforms.previous );
const frames = new Wind( createWindUniforms(), { speed: 5, heading: 30, time: 997 } );
let drawn = current( frames );
for ( const [ dt, speed, heading ] of [ [ 1 / 60, 5, 30 ], [ 2 / 60, 5, 30 ], [ 0, 5, 30 ], [ 1 / 60, 9, 55 ], [ 0, 9, 55 ], [ 2 / 60, 3, 10 ], ...Array.from( { length: 240 }, () => [ 1 / 60, 7, 20 ] ) ] ) {

	frames.update( dt, speed, heading );
	assert.deepEqual( previous( frames ), drawn, 'previous is the last rendered frame\'s wind' );
	if ( dt === 0 && frames.speed === speed ) assert.deepEqual( current( frames ), drawn, 'a paused frame does not move the wind' );
	drawn = current( frames );

}
assert.ok( frames.time > CLOCK_PERIOD, 'the frames above crossed the clocks\' wrap' );
// a seek (setTime: reset) and a cut (Motion.ts taaCut -> onTaaCut -> cut) leave no motion
frames.update( 1 / 60, 8, 25 );
assert.notDeepEqual( previous( frames ), current( frames ) );
frames.reset( { speed: 8, heading: 25, time: 40 } );
assert.deepEqual( previous( frames ), current( frames ), 'a seek leaves no motion' );
frames.update( 1 / 60, 8, 25 );
assert.notDeepEqual( previous( frames ), current( frames ) );
const beforeCut = current( frames );
frames.cut();
assert.deepEqual( previous( frames ), current( frames ), 'a cut leaves no motion' );
assert.deepEqual( current( frames ), beforeCut, 'a cut does not move the wind' );
// windFreeze holds the vegetation's wind, previous and current, while the clock runs
const held = current( frames );
debugFlags.windFreeze = true;
for ( let i = 0; i < 30; i ++ ) frames.update( 1 / 60, 8, 25 );
assert.deepEqual( current( frames ), held, 'windFreeze holds the vegetation\'s wind' );
assert.deepEqual( previous( frames ), held, 'windFreeze leaves no motion' );
assert.ok( frames.time > 40.4, 'the scene clock runs under windFreeze' );
delete debugFlags.windFreeze;
frames.update( 1 / 60, 8, 25 );
assert.notDeepEqual( current( frames ), held );
// The wrapped clocks may differ by a wrap between previous and current: every shader reads them
// only through functions periodic in their wraps. Sources: every read of a wind state's `clock`
// or `plantClock` (the plants' phase clock, which wraps there too) is the time of `wave` (sin of fract( time x rate ), which refuses any rate without whole cycles
// per CLOCK_PERIOD when the shader is built, so a rate passed by name is checked too) or, in Wind.ts, of `plantWave` (the plants'
// sway on `plantClock`, at rates rounded to whole cycles per CLOCK_PERIOD) and `flutterWave` (the leaves', on `clock`, whole cycles per CLOCK_PERIOD), and the gusts' scroll and time are read only in Wind.ts, by
// gustAt (windField and the sea's gusts), windBefore (the falling leaves' back-dated steps) and evolutionTime (the fog's banks, whose field repeats where it wraps): the noise repeats over GUST_TILE and GUST_TIME_PERIOD, where they wrap.
const root = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const sources = [];
const walk = ( dir ) => { for ( const e of readdirSync( dir, { withFileTypes: true } ) ) { const f = path.join( dir, e.name ); if ( e.isDirectory() ) walk( f ); else if ( f.endsWith( '.ts' ) ) sources.push( [ path.relative( root, f ), readFileSync( f, 'utf8' ) ] ); } };
walk( path.join( root, 'packages' ) );
walk( path.join( root, 'app' ) );
let reads = 0;
for ( const [ file, text ] of sources ) {

	if ( file === path.join( 'packages', 'render', 'weather', 'Wind.ts' ) ) continue;
	for ( const m of text.matchAll( /\b(?:wind|state|previous)\.(?:clock|plantClock)\b/g ) ) {

		reads ++;
		const call = /wave\(\s*$/.test( text.slice( Math.max( 0, m.index - 12 ), m.index ) );
		const line = text.slice( 0, m.index ).split( '\n' ).length;
		assert.ok( call, `${ file }:${ line }: a wind clock read outside wave()` );

	}
	assert.ok( ! /gustScroll|gustTime/.test( text ), `${ file }: a wind scroll read outside Wind.ts` );

}
// (the grass's blades read them today: the scan must find them)
assert.ok( reads >= 1, `found ${ reads } wind clock reads` );
assert.throws( () => plantWave( createWindUniforms(), 0.0951, null, null ), RangeError, 'plantWave takes whole cycles per clock period' );
assert.throws( () => flutterWave( createWindUniforms(), 2.6001, null ), RangeError, 'flutterWave takes whole cycles per clock period' );
assert.throws( () => wave( createWindUniforms().clock, 2.6001 ), RangeError, 'wave takes whole cycles per clock period' );
assert.ok( wave( createWindUniforms().clock, 4.207 ), 'wave takes rates of three decimals' );
// numerically: across the wraps the shaders' arguments move by the step alone
const wrap = new Wind( createWindUniforms(), { speed: 6, time: CLOCK_PERIOD - 0.01 } );
const atWrap = { clock: wrap.uniforms.clock.value, gustTime: wrap.uniforms.gustTime.value };
const turn = ( a, b ) => { const d = ( ( b - a ) % 1 + 1.5 ) % 1 - 0.5; return d; };
const grassWrap = new Wind( createWindUniforms(), { speed: 6, time: CLOCK_PERIOD / plantSpeedOf( 6 ) - 0.01 } );
const g0 = grassWrap.uniforms.plantClock.value;
grassWrap.update( 0.02, 6 );
const g1 = grassWrap.uniforms.plantClock.value;
assert.ok( g1 < g0, 'the plants\' clock wrapped' );
// the grass's rate, and each band of the bamboo's culms
for ( const rate of [ 0.084, ...[ 0, 0.3, 0.6, 0.9 ].map( ( xi ) => plantRate( response, 0.095, xi / 16 ) ) ] ) near( turn( g0 * rate, g1 * rate ), 0.02 * plantSpeedOf( 6 ) * rate, 1e-6 );
wrap.update( 0.02, 6 );
assert.ok( wrap.uniforms.clock.value < atWrap.clock, 'the clock wrapped' );
assert.ok( wrap.uniforms.gustTime.value < atWrap.gustTime, 'the gusts\' time wrapped' );
near( turn( atWrap.clock * 0.702, wrap.uniforms.clock.value * 0.702 ), 0.02 * 0.702, 1e-6 );
near( turn( atWrap.gustTime / GUST_TIME_PERIOD, wrap.uniforms.gustTime.value / GUST_TIME_PERIOD ), 0.02 * GUST_EVOLUTION / GUST_TIME_PERIOD, 1e-9 );
const gustSpeed = GUST_TRAVEL * plantSpeedOf( 6 );
const tiles = new Wind( createWindUniforms(), { speed: 6, time: GUST_TILE / gustSpeed - 0.01 } );
const s0 = tiles.uniforms.gustScroll.value;
tiles.update( 0.02, 6 );
assert.ok( tiles.uniforms.gustScroll.value < s0, 'the gust scroll wrapped' );
near( turn( s0 / GUST_TILE, tiles.uniforms.gustScroll.value / GUST_TILE ), 0.02 * gustSpeed / GUST_TILE, 1e-9 );
console.log( 'Wind: pause, advection direction, update cadence, calm ocean bounds in light and gentle winds, the levels\' numbers and fair\'s wind, the plants\' own rates and bands, the sea\'s spectrum wind, the flutter\'s fixed rate and the sway\'s clock, the gusts\' scroll and time, deterministic seek and the previous frame of the vegetation wind (rendered frames, seek, cut, windFreeze, periodic reads of the wrapped clocks) pass.' );
