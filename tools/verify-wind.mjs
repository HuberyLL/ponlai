import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wind, createWindUniforms, gustWave, weatherWind, swayFrequency, CLOCK_PERIOD, GUST_ALONG, EDDY_TILE, EDDY_RATE, REFERENCE_SPEED, REFERENCE_GUSTINESS } from '../src/weather/Wind.ts';
import { Weather, WEATHER_PRESETS } from '../src/sky/Weather.ts';
import { debugFlags } from '../src/debug/DebugFlags.ts';

const near = ( a, b, tolerance = 1e-9 ) => assert.ok( Math.abs( a - b ) <= tolerance, `${ a } != ${ b }` );
const wind = new Wind( createWindUniforms(), { time: 12 } );
const start = wind.uniforms.displacement.value.clone();
const offset = wind.uniforms.cloudOffset.value.clone();
wind.update( 0, 5.2 );
assert.ok( wind.uniforms.displacement.value.equals( start ), 'A preset change while paused must not move the air' );
assert.ok( wind.uniforms.cloudOffset.value.equals( offset ), 'A preset change while paused must not teleport clouds' );
wind.update( 0.1, 5.2 );
assert.ok( wind.uniforms.displacement.value.distanceTo( start ) > 0 );
assert.ok( wind.uniforms.displacement.value.dot( wind.uniforms.direction.value ) > 0 );
assert.ok( wind.uniforms.cloudOffset.value.dot( wind.uniforms.direction.value ) < 0, 'Density coordinates advect against physical travel' );

const run = ( step ) => {

	const weather = new Weather( 'clear' );
	const local = new Wind( createWindUniforms(), weatherWind( weather.state ) );
	weather.setWeather( 'rain', 8 );
	for ( let t = 0; t < 12 - 1e-8; t += step ) {

		weather.update( step );
		local.update( step, weather.state.windSpeed, weather.state.windDirection, weather.state.gustiness );

	}
	return local;

};
const coarse = run( 0.05 ), fine = run( 0.01 );
assert.ok( coarse.uniforms.displacement.value.distanceTo( fine.uniforms.displacement.value ) < 1e-6 );
assert.ok( coarse.uniforms.cloudOffset.value.distanceTo( fine.uniforms.cloudOffset.value ) < 1e-7 );
assert.ok( coarse.uniforms.oceanGain.value.toArray().every( ( gain ) => gain > 0 && gain < 1.4 ) );
wind.reset( { time: 12 } );
assert.ok( wind.uniforms.displacement.value.equals( start ), 'Explicit fixed-time reset must reproduce startup' );
assert.ok( wind.uniforms.cloudOffset.value.equals( offset ), 'Explicit fixed-time reset must reproduce startup' );
for ( const invalid of [ NaN, Infinity, - 1 ] ) assert.throws( () => wind.update( invalid ), RangeError );
for ( const invalid of [ NaN, 0.9 ] ) assert.throws( () => wind.update( 0, 3.8, 40, invalid ), RangeError );
// Every preset gives the wind its three numbers, and the parts read them from Wind alone.
for ( const [ name, preset ] of Object.entries( WEATHER_PRESETS ) ) {

	for ( const key of [ 'windSpeed', 'windDirection', 'gustiness' ] ) assert.ok( Number.isFinite( preset[ key ] ), `${ name }: ${ key }` );
	assert.ok( preset.gustiness >= 1, `${ name }: a gust factor below 1` );

}
// The gusts' lean: fair's gust factor gives the lean the plants were tuned at, exactly; it grows
// with the gust's excess pressure, and a gustless wind leans the plants by its mean alone.
const gusts = ( g ) => new Wind( createWindUniforms(), { gustiness: g } ).uniforms.gustLean.value;
assert.equal( gusts( REFERENCE_GUSTINESS ), 0.13, 'fair\'s gusts lean the plants as before' );
assert.equal( gusts( 1 ), 0 );
near( gusts( 1.5 ) / gusts( REFERENCE_GUSTINESS ), ( 1.5 ** 2 - 1 ) / ( REFERENCE_GUSTINESS ** 2 - 1 ), 1e-12 );
// The sea's spectrum is built from the weather's heading and the reference speed, whatever the
// weather's speed: a weather change only scales its amplitudes.
assert.deepEqual( new Wind( createWindUniforms(), { speed: 11, heading: 25 } ).spectrumWind, { windSpeed: REFERENCE_SPEED, windDirection: 25 } );
// The plants' sway keeps its natural frequency in any wind: its scroll and the leaves' clock are
// the same at any speed, while the gusts travel with the wind. In a fair wind the sway's scroll is
// the gusts' own, bit for bit, as the sway took it before the two were parted (fair's paused frames
// do not change), after a seek and after steps alike.
for ( const t of [ 0, 12, 37.25, 86400 * 3 + 0.5 ] ) {

	const calm = new Wind( createWindUniforms(), { speed: 1, time: t } ), gale = new Wind( createWindUniforms(), { speed: 11, time: t } );
	assert.equal( calm.uniforms.swayScroll.value, gale.uniforms.swayScroll.value );
	assert.equal( calm.uniforms.clock.value, gale.uniforms.clock.value );
	const fair = new Wind( createWindUniforms(), { ...weatherWind( WEATHER_PRESETS.fair ), time: t } );
	assert.equal( fair.uniforms.swayScroll.value, fair.uniforms.gustScroll.value.x, 'fair\'s sway is the gusts\' scroll' );
	for ( let i = 0; i < 90; i ++ ) fair.update( i % 3 ? 1 / 60 : 1 / 30, WEATHER_PRESETS.fair.windSpeed );
	assert.equal( fair.uniforms.swayScroll.value, fair.uniforms.gustScroll.value.x, 'fair\'s sway is the gusts\' scroll after steps' );

}
near( swayFrequency( 50 ), 50 * 3.8 / GUST_ALONG, 1e-12 );
// The vegetation's clocks and gust scroll: frozen while paused, the same after a seek as after
// running there at a constant speed, wrapped within their periods and tiles.
const veg = ( w ) => [ w.uniforms.clock.value, w.uniforms.swayScroll.value, w.uniforms.gustScroll.value.x, w.uniforms.gustScroll.value.y ];
const ran = new Wind( createWindUniforms(), { speed: 11, time: 30 } );
const frozen = veg( ran );
ran.update( 0, 11 );
assert.deepEqual( veg( ran ), frozen, 'A paused frame must not move the plants' );
for ( let i = 0; i < 600; i ++ ) ran.update( 1 / 60, 11 );
const sought = new Wind( createWindUniforms(), { speed: 11, time: 40 } );
veg( ran ).forEach( ( v, i ) => near( v, veg( sought )[ i ], 1e-6 ) );
assert.equal( sought.uniforms.pressure.value, ( 11 / 3.8 ) ** 2 );
const long = new Wind( createWindUniforms(), { speed: 11, time: 86400 * 3 + 0.5 } );
const [ clock, sway, gustTravel, eddies ] = veg( long );
assert.ok( clock >= 0 && clock < CLOCK_PERIOD && sway >= 0 && sway < GUST_ALONG );
assert.ok( gustTravel >= 0 && gustTravel < GUST_ALONG && eddies >= 0 && eddies < EDDY_TILE );
// The previous frame's wind (for motion vectors) is what the last update published, and equals
// the current one after a reset and on a paused frame.
const prev = ( w ) => { const p = w.uniforms.previous; return [ p.clock.value, p.swayScroll.value, p.gustScroll.value.x, p.gustScroll.value.y, p.pressure.value ]; };
const cur = ( w ) => [ ...veg( w ), w.uniforms.pressure.value ];
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
const state = ( w ) => Object.fromEntries( Object.entries( w ).map( ( [ k, u ] ) => [ k, typeof u.value === 'number' ? u.value : u.value.toArray() ] ) );
const vegetationKeys = Object.keys( createWindUniforms().previous );
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
// is the time of `wave` (sin of fract( time x rate ), at rates with whole cycles per
// CLOCK_PERIOD), the gust scroll is read only in Wind.ts by windField (the gust map repeats over
// GUST_ALONG and EDDY_TILE, where the scroll wraps), and the sway scroll only in Wind.ts by
// gustWave, the plants' sway, which takes whole swings per GUST_ALONG and refuses any other rate.
const root = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '../src' );
const sources = [];
const walk = ( dir ) => { for ( const e of readdirSync( dir, { withFileTypes: true } ) ) { const f = path.join( dir, e.name ); if ( e.isDirectory() ) walk( f ); else if ( f.endsWith( '.ts' ) ) sources.push( [ path.relative( root, f ), readFileSync( f, 'utf8' ) ] ); } };
walk( root );
const whole = ( rate ) => Math.abs( rate * CLOCK_PERIOD - Math.round( rate * CLOCK_PERIOD ) ) < 1e-6;
let reads = 0;
for ( const [ file, text ] of sources ) {

	if ( file === path.join( 'weather', 'Wind.ts' ) ) continue;
	for ( const m of text.matchAll( /\b(?:wind|state|previous)\.clock\b/g ) ) {

		reads ++;
		const call = /wave\(\s*$/.test( text.slice( Math.max( 0, m.index - 12 ), m.index ) );
		const line = text.slice( 0, m.index ).split( '\n' ).length;
		assert.ok( call, `${ file }:${ line }: a wind clock read outside wave()` );
		const rate = text.slice( m.index + m[ 0 ].length ).match( /^\s*,\s*([^,)]+)/ )[ 1 ].trim();
		if ( /^[\d.]+$/.test( rate ) ) assert.ok( whole( Number( rate ) ), `${ file }:${ line }: rate ${ rate } is not whole cycles per period` );
		else assert.fail( `${ file }:${ line }: rate ${ rate } is not checked` );

	}
	assert.ok( ! /gustScroll|swayScroll/.test( text ), `${ file }: a wind scroll read outside Wind.ts` );

}
// (the grass, its flowers, the skirt, the palm and hangingSway read them today: the scan must find them)
assert.ok( reads >= 6, `found ${ reads } wind clock reads` );
assert.throws( () => gustWave( createWindUniforms(), null, 2.5 ), RangeError, 'gustWave takes whole swings per gust tile' );
// numerically: across the wraps the shaders' arguments move by the step alone
const wrap = new Wind( createWindUniforms(), { speed: 6, time: CLOCK_PERIOD - 0.01 } );
const atWrap = { clock: wrap.uniforms.clock.value, scroll: wrap.uniforms.gustScroll.value.clone() };
wrap.update( 0.02, 6 );
assert.ok( wrap.uniforms.clock.value < atWrap.clock, 'the clock wrapped' );
const turn = ( a, b ) => { const d = ( ( b - a ) % 1 + 1.5 ) % 1 - 0.5; return d; };
near( turn( atWrap.clock * 0.702, wrap.uniforms.clock.value * 0.702 ), 0.02 * 0.702, 1e-6 );
const sways = new Wind( createWindUniforms(), { speed: 6, time: GUST_ALONG / REFERENCE_SPEED - 0.01 } );
const sw0 = sways.uniforms.swayScroll.value;
sways.update( 0.02, 6 );
assert.ok( sways.uniforms.swayScroll.value < sw0, 'the sway scroll wrapped' );
near( turn( sw0 / GUST_ALONG, sways.uniforms.swayScroll.value / GUST_ALONG ), 0.02 * REFERENCE_SPEED / GUST_ALONG, 1e-9 );
const tiles = new Wind( createWindUniforms(), { speed: 6, time: GUST_ALONG / 6 - 0.01 } );
const s0 = tiles.uniforms.gustScroll.value.clone();
tiles.update( 0.02, 6 );
assert.ok( tiles.uniforms.gustScroll.value.x < s0.x, 'the gust scroll wrapped' );
near( turn( s0.x / GUST_ALONG, tiles.uniforms.gustScroll.value.x / GUST_ALONG ), 0.02 * 6 / GUST_ALONG, 1e-9 );
near( turn( s0.y / EDDY_TILE, tiles.uniforms.gustScroll.value.y / EDDY_TILE ), 0.02 * 6 * EDDY_RATE / EDDY_TILE, 1e-9 );
const map = long.uniforms.gustMap.image;
assert.equal( map.data.length, map.width * map.height * 2 );
console.log( 'Wind: pause, advection direction, update cadence, calm ocean bounds, the presets\' three numbers, the gusts\' lean, the sea\'s spectrum wind, the sway\'s natural frequency (fair\'s bit for bit), deterministic seek and the previous frame of the vegetation wind (rendered frames, seek, cut, windFreeze, periodic reads of the wrapped clocks) pass.' );
