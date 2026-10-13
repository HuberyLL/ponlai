import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wind, createWindUniforms, CLOCK_PERIOD, GUST_ALONG, EDDY_TILE } from '../src/weather/Wind.ts';
import { Weather } from '../src/sky/Weather.ts';
import { debugFlags } from '../src/debug/DebugFlags.ts';

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
// or `flutter` is the time of `wave` (sin of fract( time x rate ), at rates with whole cycles per
// CLOCK_PERIOD), and the gust scroll is read only by Wind.ts's windField (the gust map repeats
// over GUST_ALONG and EDDY_TILE, where the scroll wraps).
const root = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '../src' );
const sources = [];
const walk = ( dir ) => { for ( const e of readdirSync( dir, { withFileTypes: true } ) ) { const f = path.join( dir, e.name ); if ( e.isDirectory() ) walk( f ); else if ( f.endsWith( '.ts' ) ) sources.push( [ path.relative( root, f ), readFileSync( f, 'utf8' ) ] ); } };
walk( root );
const whole = ( rate ) => Math.abs( rate * CLOCK_PERIOD - Math.round( rate * CLOCK_PERIOD ) ) < 1e-6;
let reads = 0;
for ( const [ file, text ] of sources ) {

	if ( file === path.join( 'weather', 'Wind.ts' ) ) continue;
	for ( const m of text.matchAll( /\b(?:wind|state|previous)\.(?:clock|flutter)\b/g ) ) {

		reads ++;
		const call = /wave\(\s*$/.test( text.slice( Math.max( 0, m.index - 12 ), m.index ) );
		const line = text.slice( 0, m.index ).split( '\n' ).length;
		assert.ok( call, `${ file }:${ line }: a wind clock read outside wave()` );
		const rate = text.slice( m.index + m[ 0 ].length ).match( /^\s*,\s*([^,)]+)/ )[ 1 ].trim();
		if ( /^[\d.]+$/.test( rate ) ) assert.ok( whole( Number( rate ) ), `${ file }:${ line }: rate ${ rate } is not whole cycles per period` );
		else assert.ok( file === path.join( 'world', 'Foliage.ts' ) && ( rate === 'r' || rate === 'r / 2' ), `${ file }:${ line }: rate ${ rate } is not checked` );

	}
	assert.ok( ! /gustScroll/.test( text ), `${ file }: the gust scroll read outside Wind.ts` );

}
assert.ok( reads >= 12, `found ${ reads } wind clock reads` );
// mainBend's `sway( r, ... )`: rate, its multiples in mainBend and their halves (slow), at every call's rate
const foliage = sources.find( ( [ f ] ) => f === path.join( 'world', 'Foliage.ts' ) )[ 1 ];
const multiples = [ 1, ...[ ...foliage.matchAll( /sway\(\s*rate\s*\*\s*([\d.]+)/g ) ].map( ( m ) => Number( m[ 1 ] ) ) ];
assert.ok( /wave\( wind\.clock, r \/ 2, ph \)/.test( foliage ) && multiples.length === 2 );
let bends = 0;
for ( const [ file, text ] of sources ) for ( const m of text.matchAll( /mainBend\(.*,\s*([\d.]+)\s*(?:,\s*\w+\s*)?\)/g ) ) {

	bends ++;
	for ( const k of multiples ) for ( const half of [ 1, 0.5 ] ) assert.ok( whole( Number( m[ 1 ] ) * k * half ), `${ file }: mainBend at ${ m[ 1 ] } Hz x ${ k * half }` );

}
assert.ok( bends >= 2, `found ${ bends } mainBend calls` );
// numerically: across the wraps the shaders' arguments move by the step alone
const wrap = new Wind( createWindUniforms(), { speed: 6, time: CLOCK_PERIOD - 0.01 } );
const atWrap = { clock: wrap.uniforms.clock.value, scroll: wrap.uniforms.gustScroll.value.clone() };
wrap.update( 0.02, 6 );
assert.ok( wrap.uniforms.clock.value < atWrap.clock, 'the clock wrapped' );
const turn = ( a, b ) => { const d = ( ( b - a ) % 1 + 1.5 ) % 1 - 0.5; return d; };
near( turn( atWrap.clock * 0.702, wrap.uniforms.clock.value * 0.702 ), 0.02 * 0.702, 1e-6 );
const tiles = new Wind( createWindUniforms(), { speed: 6, time: GUST_ALONG / 6 - 0.01 } );
const s0 = tiles.uniforms.gustScroll.value.clone();
tiles.update( 0.02, 6 );
assert.ok( tiles.uniforms.gustScroll.value.x < s0.x, 'the gust scroll wrapped' );
near( turn( s0.x / GUST_ALONG, tiles.uniforms.gustScroll.value.x / GUST_ALONG ), 0.02 * 6 / GUST_ALONG, 1e-9 );
near( turn( s0.y / EDDY_TILE, tiles.uniforms.gustScroll.value.y / EDDY_TILE ), 0.02 * 6 * 1.25 / EDDY_TILE, 1e-9 );
const map = long.uniforms.gustMap.image;
assert.equal( map.data.length, map.width * map.height * 2 );
console.log( 'Wind: pause, phase continuity and wrap, advection direction, update cadence, calm ocean bounds, deterministic seek and the previous frame of the vegetation wind (rendered frames, seek, cut, windFreeze, periodic reads of the wrapped clocks) pass.' );
