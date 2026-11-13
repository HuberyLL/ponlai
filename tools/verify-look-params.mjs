// Checks that the systems which take their look tables at creation hold the tables they were
// given: two made from different tables in one process each read their own numbers, and making
// one leaves another as it was. CPU only, no GPU, a few seconds (the second part loads the page's
// modules through Vite's SSR loader, as tools/verify-extensions.mjs does: TypeScript and
// `import.meta.env`).
//   node tools/verify-look-params.mjs
//
// The exposure (packages/render/look/ExposureLook.ts `createExposure`), in plain node. It makes
// three exposures: from the island's look (packages/island/look/IslandLook.ts), from the
// renderer's neutral one (packages/render/look/NeutralLook.ts) and from a copy of the island's whose
// base exposure is doubled at every elevation, every key's `key` raised by a stop and the night's
// numbers changed. Guarantees, each a failure (exit 1) when broken:
// - Each exposure reads its own table: its day, night, night sky, night gain and night lift, its
//   base exposure at every row's elevation and held beyond the ends, and its keys' elevations and
//   values (a shared value reading the key it names).
// - Making the others leaves the island's exposure as it was: its base exposure and its keys for a
//   frame (`keysAt`) over a grid of elevations, night weights, skies and the rising sun are the same
//   numbers bit for bit before and after.
// - The changed copy differs from the island's by exactly its changes: twice the base exposure
//   everywhere, a stop more in the keys' `key` for every sky (overcast's terms included), the other
//   keys unchanged.
// - The day cycle (packages/render/sky/DayCycle.ts) reads the exposure it is given.
//
// The day's windows (packages/render/look/DayLook.ts `createDayWindows`), in plain node, made from
// the island's day table, the neutral one and a copy of the island's with every window moved a
// degree, the handoff and the moon's key lowered, the clouded daylight's window raised, every depth
// a stop deeper and the ease half a degree longer. Guarantees, each a failure:
// - Each set holds its own table's numbers: the handoff's top, the moon key's top, every dusk
//   window (the moon key's and the handoff's made from the two tops), the clouded daylight's window,
//   the depths and the ease.
// - Making the others leaves the island's as it was: every night share of the day cycle (the
//   display's, the exposure's, the stars', the sky's, the ambient's, the yunpeng's, the clouds'
//   moonlight, the moon's key) over a grid of elevations, sides, clouded shares and daylights is the
//   same number bit for bit before and after.
// - Every share read with the changed copy differs from the island's somewhere, and the neutral
//   set's somewhere.
// - The day cycle reads the windows it is given: its handoff and the moon's key gain are its own
//   set's, and differ under the changed copy.
//
// The wind's look (packages/render/weather/Wind.ts `windResponse`), in plain node, made from the
// island's wind table, the neutral one and a copy of the island's with every number changed.
// Guarantees, each a failure:
// - Each response holds its own table's numbers, and the plants' speed by the wind (`plantSpeedOf`)
//   follows its own table.
// - Making the others leaves the island's as it was.
// - A wind made on a response (`Wind`, `createWindUniforms`) sets the plants' speed from that
//   response at every wind, and the previous frame's uniforms hold the same response.
//
// The ambient light's look (packages/render/look/AmbientLook.ts `createAmbientTables`,
// `createKeyLift`), in plain node, made from the island's ambient table, the neutral one and a copy
// of the island's with every knob of every row moved, both gains under overcast's deck and the gain
// on the sun's bounce raised, and the lift's rows and corner moved. Guarantees, each a failure:
// - Each set holds its own table's numbers: the gain on the sun's bounce, the sun's and the moon's
//   parts of the land gain under overcast's deck, the grade (setting and rising) at every row's
//   elevation in every sky alone (the knobs at no grade under a row's changes), held beyond the end
//   rows, and the knobs at no grade under no sky; the lift's shading at every row's elevation, held
//   below the first, the key's own elevation well above the last, and none at all from the neutral
//   set (every elevation shading as itself: its single row's slopes and its corner of no width
//   divide by nothing).
// - Making the others leaves the island's as it was: the grade over a grid of elevations, skies and
//   both sides, and the lift over a grid of elevations, are the same numbers bit for bit before and
//   after.
// - The changed copy differs from the island's in every knob and every gain, and in the lift.
// - The lifted key (packages/render/lighting/KeyLift.ts) follows the lift it is given: its height
//   and its direction's elevation for a sun key are the lift's shading elevation, the key's own
//   under the neutral set.
// Under node the tune table is off (packages/render/debug/Tune.ts `TUNE_ON`), so each system's
// tunables are its own; on a debug page they share one table by name (ExposureLook.ts's,
// DayLook.ts's, Wind.ts's and AmbientLook.ts's headers).
//
// The other systems that take their tables at creation, through Vite's SSR loader with the
// island's look installed (so a number that came from the installed look instead of the table
// given would show): the shared uniforms (packages/render/shared.ts `createShared`: the ambient
// occlusion's floor and the meadow canopy's two media), the local lights (packages/render/lighting/
// LocalLights.ts `LocalLights`: the gain), the sea's detail (packages/render/ocean/SeaDetail.ts:
// its three strengths), the FFT ocean's distant swell (packages/render/ocean/OceanFFT.ts: every
// field of it), the wind's look the shared uniforms' wind carries (every field but the limbs'
// reference speed, a tunable, which the plain node part checks) and the ambient grade's controller
// (packages/render/lighting/AmbientGrade.ts `createAmbientGrade`, which loads only there: the
// tables it holds and the grade it writes into the lighting models' uniforms, worked out here from
// its own tables; its two gains are tunables, so they are read through those tables, which the
// plain node part checks per table). The ambient light's relight (lighting/AmbientRelight.ts) is
// not made: it needs a renderer and the probes' volume, and builds its kernel as it is made; it
// reads the controller's tables, which the stage hands it (RenderStages.ts `createAmbient`). Each
// is made from the island's
// look, the neutral one and a copy of the island's with every one of these numbers changed, in
// that order. Guarantees, each a failure:
// - Each reads its own table's numbers, equal to the table's and none from another.
// - Making the others leaves the island's as it was.
// - The three differ wherever their tables do (the changed copy everywhere).
import assert from 'node:assert/strict';
import { installIslandLook } from './island-look.mjs';
import { createExposure } from '../packages/render/look/ExposureLook.ts';
import { DayCycle, cloudMoonShare, displayNight, eveningHour, exposureNight, morningHour, moonKeyShare, nightAmbientAt, nightAmbientShare, rampIn, skyNight, starNight, yunpengNightShare } from '../packages/render/sky/DayCycle.ts';
import { createDayWindows } from '../packages/render/look/DayLook.ts';
import { Wind, createWindUniforms, plantSpeedOf, windResponse } from '../packages/render/weather/Wind.ts';
import { AMBIENT_COLUMNS, AMBIENT_KNOBS, DEFAULT_KNOBS, createAmbientTables, createKeyLift } from '../packages/render/look/AmbientLook.ts';
import { liftedKeyDirection, liftedKeyHeight } from '../packages/render/lighting/KeyLift.ts';
import * as THREE from 'three/webgpu';
import { ISLAND_LOOK } from '../packages/island/look/IslandLook.ts';
import { NEUTRAL_LOOK } from '../packages/render/look/NeutralLook.ts';

const near = ( actual, expected, what, tolerance = 1e-12 ) => assert.ok( Math.abs( actual - expected ) <= tolerance, `${ what }: ${ actual } != ${ expected }` );

// the exposure's part of a look, as createExposure takes it
const tables = ( look ) => ( { exposure: look.exposure, day: { exposure: look.day.exposure, nightMeterLift: look.day.nightMeterLift, nightExposureGain: look.day.nightExposureGain, nightSkyExposure: look.day.nightSkyExposure } } );

// the island's tables changed: the base exposure doubled, every key a stop up, the night's numbers moved
function changed( look ) {

	const t = tables( look );
	const exposure = structuredClone( t.exposure );
	// (the table's sides share keys, and the copy keeps them shared: each raised once)
	const raised = new Set();
	for ( const list of [ exposure.keys.day, exposure.keys.rising, exposure.keys.cloudy ] ) for ( const key of list ) if ( ! raised.has( key.values ) ) {

		raised.add( key.values );
		key.values.key += 1;

	}
	exposure.keys.night.key += 1;
	return {
		exposure,
		day: {
			exposure: t.day.exposure.map( ( [ e, x ] ) => [ e, x * 2 ] ),
			nightMeterLift: t.day.nightMeterLift + 1,
			nightExposureGain: t.day.nightExposureGain * 2,
			nightSkyExposure: t.day.nightSkyExposure * 2,
		},
	};

}

const ELEVATIONS = [];
for ( let e = - 20; e <= 60; e += 0.25 ) ELEVATIONS.push( e );
const NIGHTS = [ 0, 0.3, 1 ];
const SKIES = [ [ 1, 0, 0, 0 ], [ 0, 1, 0, 0 ], [ 0, 0, 1, 0 ], [ 0, 0, 0, 1 ], [ 0.4, 0.1, 0.3, 0.2 ] ];
const keyNames = [ 'key', 'highlight', 'sky', 'adaptUp', 'adaptDown' ];

// every number the exposure gives over the grid, in order
function readings( x ) {

	const out = [];
	for ( const e of ELEVATIONS ) {

		out.push( x.at( e ) );
		for ( const night of NIGHTS ) for ( const sky of SKIES ) for ( const rising of [ false, true ] ) {

			const k = x.keysAt( e, night, sky, { key: 0, highlight: 0, sky: 0, adaptUp: 0, adaptDown: 0 }, rising );
			for ( const n of keyNames ) out.push( k[ n ] );

		}

	}
	return out;

}

// each exposure reads its own table
function ownTable( x, t, name ) {

	const rows = t.day.exposure;
	assert.equal( x.day, rows[ rows.length - 1 ][ 1 ], `${ name }: day` );
	assert.equal( x.night, rows[ 0 ][ 1 ], `${ name }: night` );
	assert.equal( x.nightSky, t.day.nightSkyExposure, `${ name }: nightSky` );
	assert.equal( x.nightGain, t.day.nightExposureGain, `${ name }: nightGain` );
	assert.equal( x.nightMeterLift, t.day.nightMeterLift, `${ name }: nightMeterLift` );
	for ( const [ e, v ] of rows ) assert.equal( x.at( e ), v, `${ name }: at( ${ e } )` );
	assert.equal( x.at( rows[ 0 ][ 0 ] - 10 ), rows[ 0 ][ 1 ], `${ name }: held below` );
	assert.equal( x.at( rows[ rows.length - 1 ][ 0 ] + 10 ), x.day, `${ name }: held above` );
	const lists = [ 'day', 'rising', 'cloudy' ];
	const byName = new Map();
	for ( const l of lists ) for ( const key of t.exposure.keys[ l ] ) byName.set( key.name, key );
	for ( const l of lists ) {

		const given = t.exposure.keys[ l ], made = x.keys[ l ];
		assert.equal( made.length, given.length, `${ name }: ${ l } keys` );
		given.forEach( ( key, i ) => {

			assert.equal( made[ i ].at, key.at, `${ name }: ${ l }[ ${ i } ].at` );
			for ( const n of keyNames ) {

				const from = key.shares?.[ n ];
				assert.equal( made[ i ].values[ n ], from === undefined ? key.values[ n ] : byName.get( from ).values[ n ], `${ name }: ${ l }[ ${ i } ].${ n }` );

			}

		} );

	}
	for ( const n of keyNames ) assert.equal( x.keys.night[ n ], t.exposure.keys.night[ n ], `${ name }: night.${ n }` );

}

const islandTables = tables( ISLAND_LOOK ), neutralTables = tables( NEUTRAL_LOOK ), changedTables = changed( ISLAND_LOOK );
const island = createExposure( islandTables );
const before = readings( island );
const neutral = createExposure( neutralTables );
const shifted = createExposure( changedTables );
const after = readings( island );

ownTable( island, islandTables, 'island' );
ownTable( neutral, neutralTables, 'neutral' );
ownTable( shifted, changedTables, 'changed' );

// making the others left the island's as it was, bit for bit
assert.equal( after.length, before.length );
for ( let i = 0; i < before.length; i ++ ) assert.ok( Object.is( after[ i ], before[ i ] ), `island reading ${ i } moved: ${ before[ i ] } -> ${ after[ i ] }` );

// the neutral look's exposure is not the island's
assert.ok( readings( neutral ).some( ( v, i ) => v !== before[ i ] ), 'the neutral exposure reads as the island\'s' );

// the changed copy differs by its changes alone
const per = 1 + NIGHTS.length * SKIES.length * 2 * keyNames.length;
const moved = readings( shifted );
for ( let i = 0; i < before.length; i ++ ) {

	const slot = i % per;
	if ( slot === 0 ) assert.equal( moved[ i ], 2 * before[ i ], `changed: at, reading ${ i }` );
	else if ( ( slot - 1 ) % keyNames.length === 0 ) near( moved[ i ], before[ i ] + 1, `changed: key, reading ${ i }` );
	else near( moved[ i ], before[ i ], `changed: ${ keyNames[ ( slot - 1 ) % keyNames.length ] }, reading ${ i }` );

}

// the day cycle reads the exposure it is given
const islandWindows = createDayWindows( ISLAND_LOOK.day );
for ( const hour of [ 3, 7, 12, 18.5 ] ) {

	const a = new DayCycle( island, islandWindows, { hour, paused: true } ).snapshot(), b = new DayCycle( shifted, islandWindows, { hour, paused: true } ).snapshot();
	assert.equal( a.exposure, island.at( a.elevation ), `day cycle at ${ hour }: island` );
	assert.equal( b.exposure, shifted.at( b.elevation ), `day cycle at ${ hour }: changed` );
	assert.equal( b.exposure, 2 * a.exposure, `day cycle at ${ hour }: changed over island` );

}

console.log( `Exposure: three exposures from three tables, each its own (${ before.length } readings), the island's unmoved by the others, the changed copy off by its changes alone, the day cycle reading its own: passed.` );

// ---- the day's windows

// the island's day table changed: every window a degree lower, the tops lowered, the clouded
// daylight's window raised, every depth a stop deeper and the ease half a degree longer
function changedDay( look ) {

	const day = structuredClone( look.day );
	day.handoffTop -= 0.25;
	day.moonKeyTop -= 0.5;
	for ( const share of Object.values( day.duskWindows ) ) for ( const side of Object.keys( share ) ) share[ side ] = share[ side ].map( ( e ) => e - 1 );
	day.cloudedDaylight = day.cloudedDaylight.map( ( d ) => d + 0.05 );
	for ( const layer of Object.keys( day.duskDepth ) ) day.duskDepth[ layer ] += 1;
	day.duskEase += 0.5;
	return day;

}

// every number a set of windows holds, by name
const windowNumbers = ( w ) => ( {
	handoffTop: w.handoffTop, moonKeyTop: w.moonKeyTop,
	...Object.fromEntries( Object.entries( w.dusk ).flatMap( ( [ share, sides ] ) => Array.isArray( sides ) ? [ [ `dusk.${ share }`, [ ...sides ] ] ] : Object.entries( sides ).map( ( [ side, span ] ) => [ `dusk.${ share }.${ side }`, [ ...span ] ] ) ) ),
	cloudedDaylight: [ ...w.cloudedDaylight ],
	...Object.fromEntries( Object.entries( w.depth ).map( ( [ k, v ] ) => [ `depth.${ k }`, v ] ) ),
	ease: w.ease.degrees,
} );
// the same names, read from a day table
const dayNumbers = ( day ) => windowNumbers( {
	handoffTop: day.handoffTop, moonKeyTop: day.moonKeyTop,
	dusk: { ...day.duskWindows, moonKey: [ day.moonKeyTop - 2, day.moonKeyTop ], handoff: [ day.moonKeyTop, day.handoffTop ] },
	cloudedDaylight: day.cloudedDaylight, depth: day.duskDepth, ease: { degrees: day.duskEase },
} );

// every night share a set of windows makes, by share, over a grid of elevations, sides, clouded
// shares and daylights
const DUSK_ELEVATIONS = [];
for ( let e = - 16; e <= 4; e += 0.125 ) DUSK_ELEVATIONS.push( e );
function shareReadings( w ) {

	const out = { display: [], exposure: [], stars: [], sky: [], ambient: [], ambientAt: [], yunpeng: [], cloudMoon: [], moonKey: [] };
	for ( const e of DUSK_ELEVATIONS ) {

		out.ambientAt.push( nightAmbientAt( w, e ) );
		out.moonKey.push( moonKeyShare( w, e ) );
		for ( const rising of [ false, true ] ) for ( const cloud of [ 0, 0.5, 1 ] ) {

			out.exposure.push( exposureNight( w, e, rising, cloud ) );
			out.sky.push( skyNight( w, e, rising, cloud ) );
			out.ambient.push( nightAmbientShare( w, e, rising, cloud ) );
			out.yunpeng.push( yunpengNightShare( w, e, rising, cloud ) );
			out.cloudMoon.push( cloudMoonShare( w, e, rising, cloud ) );
			for ( const daylight of [ 0.1, 0.3, 0.6 ] ) {

				out.display.push( displayNight( w, daylight, e, rising, cloud ) );
				out.stars.push( starNight( w, daylight, e, rising, cloud ) );

			}

		}

	}
	return out;

}

const dayLooks = { island: ISLAND_LOOK.day, neutral: NEUTRAL_LOOK.day, changed: changedDay( ISLAND_LOOK ) };
const islandDayBefore = shareReadings( islandWindows );
const windowSets = { island: islandWindows, neutral: createDayWindows( dayLooks.neutral ), changed: createDayWindows( dayLooks.changed ) };
for ( const [ name, w ] of Object.entries( windowSets ) ) assert.deepEqual( windowNumbers( w ), dayNumbers( dayLooks[ name ] ), `${ name } windows: the table's numbers` );
const dayRead = Object.fromEntries( Object.entries( windowSets ).map( ( [ name, w ] ) => [ name, shareReadings( w ) ] ) );
let shareCount = 0;
for ( const [ share, values ] of Object.entries( islandDayBefore ) ) {

	values.forEach( ( v, i ) => assert.ok( Object.is( dayRead.island[ share ][ i ], v ), `island ${ share } share moved at reading ${ i }: ${ v } -> ${ dayRead.island[ share ][ i ] }` ) );
	assert.ok( dayRead.changed[ share ].some( ( v, i ) => v !== values[ i ] ), `changed: the ${ share } share reads as the island's` );
	shareCount += values.length;

}
assert.ok( Object.keys( islandDayBefore ).some( ( share ) => dayRead.neutral[ share ].some( ( v, i ) => v !== islandDayBefore[ share ][ i ] ) ), 'the neutral windows read as the island\'s' );

// the day cycle reads the windows it is given
let cycleMoved = false;
for ( const elevation of [ 1, - 0.5, - 1, - 1.5, - 2.5, - 3, - 4, - 6 ] ) for ( const hour of [ eveningHour( elevation ), morningHour( elevation ) ] ) {

	const a = new DayCycle( island, islandWindows, { hour, paused: true } ).snapshot(), b = new DayCycle( island, windowSets.changed, { hour, paused: true } ).snapshot();
	for ( const [ name, w, snap ] of [ [ 'island', islandWindows, a ], [ 'changed', windowSets.changed, b ] ] ) {

		assert.equal( snap.handoff, rampIn( snap.elevation, w.dusk.handoff ), `day cycle at ${ hour }: ${ name } handoff` );
		assert.equal( snap.moonKeyGain, moonKeyShare( w, snap.elevation ) * snap.moonVisibility, `day cycle at ${ hour }: ${ name } moon key` );

	}
	cycleMoved ||= a.handoff !== b.handoff || a.moonKeyGain !== b.moonKeyGain;

}
assert.ok( cycleMoved, 'the day cycle reads the island\'s windows under the changed copy' );

console.log( `Day windows: three sets from three tables, each its own (${ Object.keys( windowNumbers( islandWindows ) ).length } numbers, ${ shareCount } share readings), the island's unmoved by the others, the changed copy and the neutral set off the island's, the day cycle reading its own: passed.` );

// ---- the wind's look

// the island's wind table changed: every number moved
function changedWind( look ) {

	const wind = structuredClone( look.wind );
	wind.gustGain += 0.5;
	wind.gustJitter += 0.25;
	wind.plantWind = wind.plantWind.map( ( [ u, p ] ) => [ u, p + 1 ] );
	wind.plantSpeed += 10;
	wind.plantRateSpread += 0.05;
	return wind;

}

const WIND_SPEEDS = [];
for ( let u = 0; u <= 16; u += 0.25 ) WIND_SPEEDS.push( u );
// a response's numbers by name, with the plants' speed it gives at every wind
const responseReadings = ( r ) => ( {
	gustGain: r.gustGain, gustJitter: r.gustJitter, plantSpeed: r.plantSpeed, plantRateSpread: r.plantRateSpread,
	plantWind: r.plantWind.map( ( p ) => [ ...p ] ),
	speeds: WIND_SPEEDS.map( ( u ) => plantSpeedOf( r, u ) ),
} );
// the plants' speed a table gives at wind `u`: a line through its points, past the last one on
// along its last piece's slope (weather/Wind.ts `plantSpeedOf`, worked out here from the table)
function tableSpeed( table, u ) {

	const k = table.plantWind;
	let i = 1;
	while ( i < k.length - 1 && u > k[ i ][ 0 ] ) i ++;
	return Math.max( 0, k[ i - 1 ][ 1 ] + ( k[ i ][ 1 ] - k[ i - 1 ][ 1 ] ) * ( u - k[ i - 1 ][ 0 ] ) / ( k[ i ][ 0 ] - k[ i - 1 ][ 0 ] ) );

}
const windLooks = { island: ISLAND_LOOK.wind, neutral: NEUTRAL_LOOK.wind, changed: changedWind( ISLAND_LOOK ) };
const islandResponse = windResponse( windLooks.island );
const islandWindBefore = responseReadings( islandResponse );
const responses = { island: islandResponse, neutral: windResponse( windLooks.neutral ), changed: windResponse( windLooks.changed ) };
for ( const [ name, r ] of Object.entries( responses ) ) {

	const table = windLooks[ name ], read = responseReadings( r );
	for ( const k of [ 'gustGain', 'gustJitter', 'plantSpeed', 'plantRateSpread' ] ) assert.equal( read[ k ], table[ k ], `${ name } wind: ${ k }` );
	assert.deepEqual( read.plantWind, table.plantWind, `${ name } wind: plantWind` );
	read.speeds.forEach( ( v, i ) => near( v, tableSpeed( table, WIND_SPEEDS[ i ] ), `${ name } wind: plants' speed at ${ WIND_SPEEDS[ i ] } m/s` ) );
	// a wind made on the response takes the plants' speed from it, at rest and at every wind, and
	// its previous frame holds the same response
	const uniforms = createWindUniforms( r );
	assert.equal( uniforms.response, r, `${ name } wind: the uniforms' response` );
	assert.equal( uniforms.previous.response, r, `${ name } wind: the previous frame's response` );
	for ( const u of [ 0.5, 3.8, 7, 11, 15 ] ) assert.equal( new Wind( createWindUniforms( r ), { speed: u } ).uniforms.plantSpeed.value, plantSpeedOf( r, u ), `${ name } wind: the wind's plants' speed at ${ u } m/s` );

}
assert.deepEqual( responseReadings( islandResponse ), islandWindBefore, 'the island\'s wind moved' );
for ( const k of Object.keys( islandWindBefore ) ) assert.notDeepEqual( responseReadings( responses.changed )[ k ], islandWindBefore[ k ], `changed wind: ${ k } reads as the island's` );

console.log( `Wind: three responses from three tables, each its own (${ WIND_SPEEDS.length } plants' speeds each), the island's unmoved by the others, the wind and its previous frame on their own response: passed.` );

// ---- the ambient light's look

// the island's ambient table changed: every knob of every row moved (by its column), the gains raised,
// the lift's rows and corner moved
function changedAmbient( look ) {

	const a = look.ambient;
	const row = ( r ) => ( { at: r.at, ...Object.fromEntries( AMBIENT_COLUMNS.map( ( column, c ) => [ column, Object.fromEntries( AMBIENT_KNOBS.map( ( k ) => [ k, ( r[ column ]?.[ k ] ?? DEFAULT_KNOBS[ k ] ) + 0.125 * ( c + 1 ) ] ) ) ] ) ) } );
	return {
		grade: a.grade.map( row ),
		gradeRising: a.gradeRising.map( row ),
		sunBounceGain: a.sunBounceGain * 2,
		overcastLand: a.overcastLand + 0.25,
		overcastMoonLand: a.overcastMoonLand + 0.25,
		keyLift: { rows: a.keyLift.rows.map( ( r ) => ( { at: r.at + 1, shading: r.shading + 2 } ) ), join: a.keyLift.join + 0.5 },
	};

}

const ONE_SKY = AMBIENT_COLUMNS.map( ( _, c ) => AMBIENT_COLUMNS.map( ( __, d ) => ( c === d ? 1 : 0 ) ) );
const AMBIENT_SKIES = [ ...ONE_SKY, [ 0.4, 0.1, 0.3, 0.2 ] ];
const LIFT_ELEVATIONS = [];
for ( let e = - 30; e <= 60; e += 0.125 ) LIFT_ELEVATIONS.push( e );
// every number a set gives over the grid, in order: its gains, the grade, the lift
function ambientReadings( tables, lift ) {

	const out = [ tables.sunBounceGain(), tables.overcastLand(), tables.overcastMoonLand ];
	const knobs = { ...DEFAULT_KNOBS };
	for ( const e of ELEVATIONS ) for ( const sky of AMBIENT_SKIES ) for ( const rising of [ false, true ] ) {

		tables.evaluate( e, sky, knobs, rising );
		for ( const k of AMBIENT_KNOBS ) out.push( knobs[ k ] );

	}
	for ( const e of LIFT_ELEVATIONS ) out.push( lift( e ) );
	return out;

}

// each set reads its own table
function ownAmbient( tables, lift, table, name ) {

	assert.equal( tables.sunBounceGain(), table.sunBounceGain, `${ name } ambient: sunBounceGain` );
	assert.equal( tables.overcastLand(), table.overcastLand, `${ name } ambient: overcastLand` );
	assert.equal( tables.overcastMoonLand, table.overcastMoonLand, `${ name } ambient: overcastMoonLand` );
	const knobs = { ...DEFAULT_KNOBS };
	for ( const [ side, rows, rising ] of [ [ 'grade', table.grade, false ], [ 'gradeRising', table.gradeRising, true ] ] ) {

		const at = ( r, e, label ) => AMBIENT_COLUMNS.forEach( ( column, c ) => {

			tables.evaluate( e, ONE_SKY[ c ], knobs, rising );
			for ( const k of AMBIENT_KNOBS ) assert.equal( knobs[ k ], r[ column ]?.[ k ] ?? DEFAULT_KNOBS[ k ], `${ name } ambient: ${ side } ${ label } ${ column } ${ k }` );

		} );
		for ( const r of rows ) at( r, r.at, `at ${ r.at }` );
		at( rows[ 0 ], rows[ 0 ].at + 10, 'held above' );
		at( rows[ rows.length - 1 ], rows[ rows.length - 1 ].at - 10, 'held below' );
		tables.evaluate( 10, [ 0, 0, 0, 0 ], knobs, rising );
		for ( const k of AMBIENT_KNOBS ) assert.equal( knobs[ k ], DEFAULT_KNOBS[ k ], `${ name } ambient: ${ side } under no sky, ${ k }` );

	}
	const rows = table.keyLift.rows, last = rows[ rows.length - 1 ];
	for ( const r of rows ) assert.equal( lift( r.at ), r.at >= last.shading + table.keyLift.join ? r.at : r.shading, `${ name } lift: at ${ r.at }` );
	assert.equal( lift( rows[ 0 ].at - 5 ), rows[ 0 ].shading, `${ name } lift: held below` );
	for ( const e of [ 30, 45, 60, 89 ] ) assert.equal( lift( e ), e, `${ name } lift: the key's own at ${ e }` );

}

const ambientLooks = { island: ISLAND_LOOK.ambient, neutral: NEUTRAL_LOOK.ambient, changed: changedAmbient( ISLAND_LOOK ) };
const makeAmbient = ( table ) => ( { tables: createAmbientTables( table ), lift: createKeyLift( table.keyLift ) } );
const islandAmbient = makeAmbient( ambientLooks.island );
const islandAmbientBefore = ambientReadings( islandAmbient.tables, islandAmbient.lift );
const ambients = { island: islandAmbient, neutral: makeAmbient( ambientLooks.neutral ), changed: makeAmbient( ambientLooks.changed ) };
for ( const [ name, { tables, lift } ] of Object.entries( ambients ) ) ownAmbient( tables, lift, ambientLooks[ name ], name );
ambientReadings( islandAmbient.tables, islandAmbient.lift ).forEach( ( v, i ) => assert.ok( Object.is( v, islandAmbientBefore[ i ] ), `the island's ambient reading ${ i } moved: ${ islandAmbientBefore[ i ] } -> ${ v }` ) );
// the neutral set lifts nothing: every elevation shades as itself
for ( const e of LIFT_ELEVATIONS ) assert.equal( ambients.neutral.lift( e ), e, `neutral lift: at ${ e }` );
// the changed copy differs from the island's in every knob, every gain and the lift
{

	const knobs = { ...DEFAULT_KNOBS }, island = { ...DEFAULT_KNOBS };
	for ( const k of AMBIENT_KNOBS ) {

		const moved = ELEVATIONS.some( ( e ) => AMBIENT_SKIES.some( ( sky ) => {

			ambients.changed.tables.evaluate( e, sky, knobs );
			islandAmbient.tables.evaluate( e, sky, island );
			return knobs[ k ] !== island[ k ];

		} ) );
		assert.ok( moved, `changed ambient: ${ k } reads as the island's` );

	}
	for ( const g of [ 'sunBounceGain', 'overcastLand' ] ) assert.notEqual( ambients.changed.tables[ g ](), islandAmbient.tables[ g ](), `changed ambient: ${ g } reads as the island's` );
	assert.notEqual( ambients.changed.tables.overcastMoonLand, islandAmbient.tables.overcastMoonLand, 'changed ambient: overcastMoonLand reads as the island\'s' );
	assert.ok( LIFT_ELEVATIONS.some( ( e ) => ambients.changed.lift( e ) !== islandAmbient.lift( e ) ), 'changed lift reads as the island\'s' );

}
// the lifted key follows the lift it is given: a sun key's height and direction take its shading
let liftedKeys = 0;
for ( const [ name, { lift } ] of Object.entries( ambients ) ) for ( const e of [ 0.5, 3, 5.5, 6.5, 10, 14, 20, 45 ] ) {

	const r = THREE.MathUtils.degToRad( e ), key = new THREE.Vector3( Math.cos( r ) * 0.6, Math.sin( r ), Math.cos( r ) * 0.8 );
	const shading = lift( THREE.MathUtils.radToDeg( Math.atan2( key.y, Math.hypot( key.x, key.z ) ) ) );
	near( liftedKeyHeight( lift, key ), Math.sin( THREE.MathUtils.degToRad( shading ) ), `${ name } lifted key: height at ${ e }` );
	const d = liftedKeyDirection( lift, key, false, new THREE.Vector3() );
	near( THREE.MathUtils.radToDeg( Math.atan2( d.y, Math.hypot( d.x, d.z ) ) ), shading, `${ name } lifted key: elevation at ${ e }`, 1e-9 );
	if ( name === 'neutral' ) assert.ok( d.equals( key ), `neutral lifted key: moved at ${ e }` );
	liftedKeys ++;

}
assert.ok( [ 0.5, 3, 5.5 ].every( ( e ) => islandAmbient.lift( e ) !== e ), 'the island\'s lift lifts a low sun' );

console.log( `Ambient light: three sets from three tables, each its own (${ islandAmbientBefore.length } readings), the island's unmoved by the others, the changed copy off the island's in every knob, gain and the lift, the neutral set lifting nothing, the lifted key on its own lift (${ liftedKeys } keys): passed.` );

// ---- the systems that load through Vite's SSR loader

// every number a system made from `look` holds, by name, in order
function systemReadings( made ) {

	const { shared, lights, detail, fft } = made;
	return {
		'shared.aoFloor': shared.aoFloor,
		'shared.meadowCanopy.density': shared.meadowCanopy.density.value,
		'shared.meadowCanopy.open': shared.meadowCanopy.open.value,
		'shared.meadowCast.density': shared.meadowCast.density.value,
		'shared.meadowCast.open': shared.meadowCast.open.value,
		'localLights.gain': lights.gain,
		'seaDetail.gust': detail.gustAmount.value,
		'seaDetail.slick': detail.slickAmount.value,
		'seaDetail.streak': detail.streakAmount.value,
		...Object.fromEntries( Object.entries( fft.swell ).map( ( [ k, v ] ) => [ `swell.${ k }`, v ] ) ),
		...windNumbers( shared.wind.response ),
	};

}

// the wind's numbers by name (a response's or a table's). Not the limbs' reference speed: Vite's
// loader runs in its dev mode, where the tune table is on (debug/Tune.ts `TUNE_ON`) and shared by
// name, so every response after the first reads the first one's `wind.plants.speed`, as on a debug
// page (weather/Wind.ts `windResponse`); the plain node part checks it per table.
const windNumbers = ( w ) => ( {
	'shared.wind.gustGain': w.gustGain, 'shared.wind.gustJitter': w.gustJitter,
	'shared.wind.plantRateSpread': w.plantRateSpread, 'shared.wind.plantWind': w.plantWind.flat().join( ' ' ),
} );

// the same names, read from a look's tables
function tableReadings( look ) {

	return {
		'shared.aoFloor': look.occlusion.floor,
		'shared.meadowCanopy.density': look.meadowCanopy.canopy.density,
		'shared.meadowCanopy.open': look.meadowCanopy.canopy.open,
		'shared.meadowCast.density': look.meadowCanopy.cast.density,
		'shared.meadowCast.open': look.meadowCanopy.cast.open,
		'localLights.gain': look.localLights.gain,
		'seaDetail.gust': look.sea.detail.gust,
		'seaDetail.slick': look.sea.detail.slick,
		'seaDetail.streak': look.sea.detail.streak,
		...Object.fromEntries( Object.entries( look.sea.swell ).map( ( [ k, v ] ) => [ `swell.${ k }`, v ] ) ),
		...windNumbers( look.wind ),
	};

}

// the island's look with every number these systems take changed
function changedSystems( look ) {

	const out = structuredClone( { occlusion: look.occlusion, meadowCanopy: look.meadowCanopy, localLights: look.localLights, sea: look.sea, wind: look.wind } );
	out.occlusion.floor += 0.125;
	for ( const medium of [ out.meadowCanopy.canopy, out.meadowCanopy.cast ] ) {

		medium.density += 1;
		medium.open += 0.125;

	}
	out.localLights.gain += 2;
	for ( const k of Object.keys( out.sea.detail ) ) out.sea.detail[ k ] += 0.5;
	for ( const k of Object.keys( out.sea.swell ) ) out.sea.swell[ k ] += 1;
	out.wind = changedWind( look );
	out.ambient = changedAmbient( look );
	return out;

}

const { createServer } = await import( 'vite' );
const ROOT = new URL( '..', import.meta.url ).pathname;
const server = await createServer( {
	root: ROOT, logLevel: 'error', appType: 'custom', clearScreen: false,
	server: { middlewareMode: true, hmr: false, ws: false, watch: null },
	optimizeDeps: { noDiscovery: true, include: [] },
} );
let systems = 0, grades = 0;
try {

	const load = ( file ) => server.ssrLoadModule( `/${ file }` );
	const { installSettings, parseSettings } = await load( 'packages/render/Settings.ts' );
	installSettings( parseSettings( '' ) );
	await installIslandLook( load );
	const { createShared } = await load( 'packages/render/shared.ts' );
	const { LocalLights } = await load( 'packages/render/lighting/LocalLights.ts' );
	const { SeaDetail } = await load( 'packages/render/ocean/SeaDetail.ts' );
	const { OceanFFT } = await load( 'packages/render/ocean/OceanFFT.ts' );
	const { createAmbientTables: ssrAmbientTables } = await load( 'packages/render/look/AmbientLook.ts' );
	const { createAmbientGrade, ambient } = await load( 'packages/render/lighting/AmbientGrade.ts' );
	const { overcastDeckLight, withMoon } = await load( 'packages/render/sky/Weather.ts' );
	const make = ( look ) => {

		const shared = createShared( look );
		return {
			shared,
			lights: new LocalLights( look ),
			detail: new SeaDetail( shared, look.sea.detail ),
			// (the stage passes the swell with the sea state's scale over the look's: RenderStages.ts)
			fft: new OceanFFT( null, { windSpeed: 5, windDirection: 0, distantSwell: look.sea.swell } ),
		};

	};
	const looks = { island: ISLAND_LOOK, neutral: NEUTRAL_LOOK, changed: changedSystems( ISLAND_LOOK ) };
	const islandMade = make( looks.island );
	const islandBefore = systemReadings( islandMade );
	const made = { island: islandMade, neutral: make( looks.neutral ), changed: make( looks.changed ) };
	const read = Object.fromEntries( Object.entries( made ).map( ( [ name, m ] ) => [ name, systemReadings( m ) ] ) );
	for ( const name of Object.keys( looks ) ) {

		const want = tableReadings( looks[ name ] );
		assert.deepEqual( Object.keys( read[ name ] ), Object.keys( want ), `${ name }: the numbers read` );
		for ( const [ k, v ] of Object.entries( want ) ) assert.equal( read[ name ][ k ], v, `${ name }: ${ k }` );

	}
	for ( const [ k, v ] of Object.entries( islandBefore ) ) assert.ok( Object.is( read.island[ k ], v ), `island ${ k } moved: ${ v } -> ${ read.island[ k ] }` );
	for ( const k of Object.keys( islandBefore ) ) {

		assert.notEqual( read.changed[ k ], read.island[ k ], `changed: ${ k } reads as the island's` );
		const differs = tableReadings( looks.neutral )[ k ] !== tableReadings( looks.island )[ k ];
		if ( differs ) assert.notEqual( read.neutral[ k ], read.island[ k ], `neutral: ${ k } reads as the island's` );

	}
	systems = Object.keys( islandBefore ).length;

	// The ambient grade's controller: made on each look's tables, it holds them, its table is theirs
	// (the moon's part of the key's bounce from the rows at the moon's height) and the uniforms it
	// writes are its own table's, with its own gains (the gains read through its tables: tunables,
	// shared by name here).
	const GRADE_INPUTS = [ [ 45, [ 1, 0, 0, 0 ], false, 20, 0 ], [ 4, [ 0, 0.5, 0, 0.5 ], false, 18, 0.2 ], [ - 1, [ 0, 0, 0.3, 0.7 ], true, 25, 0.6 ], [ - 12, [ 0, 0, 0, 1 ], false, 30, 1 ], [ 12, [ 0.2, 0.2, 0.3, 0.3 ], true, 16, 0 ] ];
	const gradeReadings = ( grade ) => GRADE_INPUTS.map( ( input ) => {

		grade.update( ...input );
		return { table: { ...grade.table }, uniforms: Object.fromEntries( AMBIENT_KNOBS.map( ( k ) => [ k, ambient[ k ].value ] ) ) };

	} );
	// what a controller on `tables` writes, worked out from them (lighting/AmbientGrade.ts `update`)
	const gradeWanted = ( tables ) => GRADE_INPUTS.map( ( [ elevation, weights, rising, moonElevation, moonShare ] ) => {

		const table = tables.evaluate( elevation, weights, { ...DEFAULT_KNOBS }, rising );
		table.sunBounce = withMoon( table.sunBounce, tables.evaluate( moonElevation, weights, { ...DEFAULT_KNOBS } ).sunBounce, moonShare );
		const uniforms = Object.fromEntries( AMBIENT_KNOBS.map( ( k ) => [ k, table[ k ] ] ) );
		const land = tables.overcastLand(), moon = tables.overcastMoonLand, overcast = weights[ 3 ] ?? 0;
		uniforms.sunBounce *= tables.sunBounceGain();
		uniforms.sunBounce *= moon === 1
			? 1 + ( land - 1 ) * ( overcast * withMoon( overcastDeckLight( elevation ), 0, moonShare ) )
			: 1 + ( moon - 1 ) * ( overcast * withMoon( overcastDeckLight( elevation ) * ( land - 1 ) / ( moon - 1 ), overcastDeckLight( moonElevation ), moonShare ) );
		return { table, uniforms };

	} );
	const gradeTables = Object.fromEntries( Object.entries( looks ).map( ( [ name, look ] ) => [ name, ssrAmbientTables( look.ambient ) ] ) );
	const islandGrade = createAmbientGrade( gradeTables.island );
	const islandGradeBefore = gradeReadings( islandGrade );
	const gradeMade = { island: islandGrade, neutral: createAmbientGrade( gradeTables.neutral ), changed: createAmbientGrade( gradeTables.changed ) };
	const gradeRead = {};
	for ( const [ name, grade ] of Object.entries( gradeMade ) ) {

		assert.equal( grade.tables, gradeTables[ name ], `${ name } grade: the tables it holds` );
		gradeRead[ name ] = gradeReadings( grade );
		assert.deepEqual( gradeRead[ name ], gradeWanted( gradeTables[ name ] ), `${ name } grade: the table and the uniforms it writes` );

	}
	assert.deepEqual( gradeReadings( islandGrade ), islandGradeBefore, 'the island\'s grade moved' );
	assert.notDeepEqual( gradeRead.changed.map( ( r ) => r.table ), islandGradeBefore.map( ( r ) => r.table ), 'changed grade: reads as the island\'s' );
	assert.notDeepEqual( gradeRead.neutral.map( ( r ) => r.table ), islandGradeBefore.map( ( r ) => r.table ), 'neutral grade: reads as the island\'s' );
	grades = GRADE_INPUTS.length;

} finally {

	await server.close();

}
console.log( `Shared uniforms (the wind's look among them), local lights, sea detail and swell: three of each from three tables, each its own (${ systems } numbers), the island's unmoved by the others: passed.` );
console.log( `Ambient grade: three controllers on three tables, each holding and writing its own (${ grades } frames), the island's unmoved by the others: passed.` );
