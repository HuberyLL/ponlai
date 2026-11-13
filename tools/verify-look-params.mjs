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
//
// The haze's look (packages/render/look/HazeLook.ts `createHazeTables`), in plain node, made from
// the island's haze table, the neutral one and a copy of the island's with every field of every key
// moved, every row a degree later, the fog layer's fields where a key holds none, the sea fog, and
// per sky the kept colour, the gain, the scales, the deck's end of the aerosol layer and the sun's
// Rayleigh share changed. Guarantees, each a failure:
// - Each set holds its own table's numbers: every key's fields (its own copy, the table left as it
//   was written), the rows' elevations and keys, the keys with a shape of their own and the fog
//   layer each key takes, the fog layer where a key holds none, the sea fog, and per sky the kept
//   colour, the gain, the scales with the weather's preset haze, the deck's end of the aerosol layer
//   and the sun's Rayleigh share.
// - The haze's key (packages/render/weather/HazeKeys.ts `hazeKeyAt`) reads the tables it is given:
//   under a clear sky alone, at each rising row's elevation and each setting row's that does not
//   start the night's segment, it is that row's key with its shape, its fog layer and the clear
//   sky's scales; under a cloudy sky alone, at each clouded setting row's, that row's key with the
//   cloudy sky's scales; with the day's fog off it holds the table's fog layer where a key holds none; with
//   the sea fog on, the table's sea fog.
// - Making the others leaves the island's as it was: the haze's key over a grid of elevations,
//   sides, skies, winds, rains and fog switches is the same numbers bit for bit before and after.
// - The changed copy differs from the island's somewhere in every field of the key the look gives
//   (all but the deck's two shares, which are the weather's), and the neutral set somewhere.
//
// The display's look (packages/render/look/DisplayLook.ts `createDisplayTables`), in plain node,
// made from the island's display table, the neutral one and a copy of the island's with every
// number moved (every key a degree later, every other number by an eighth). Guarantees, each a
// failure:
// - Each set holds its own table's numbers: every field as the table wrote it (the base grade the
//   table's changes over no grade, each change read back), and each table keyed by the sun and the
//   weather (the shade's contrast, the desaturation, the white balance, the bloom: DayKeys.ts
//   `keyed`) read at every key's elevation on both sides, under a full cloud at every clouded key
//   and at full night is that key's, the clouded day's and the night's values.
// - Making the others leaves the island's as it was: its table, and every keyed table over a grid of
//   elevations, nights, clouds and both sides and every other field, the same numbers bit for bit.
// - The changed copy differs from the island's in every field, and the neutral set somewhere.
//
// The sky's look (packages/render/look/SkyLook.ts `createSkyTables`), in plain node, made from the
// island's sky table, the neutral one and a copy of the island's with every number moved (every row
// and key a degree later, every other number by an eighth, the clouds' shell written out where a
// row stands in the cloud model's own). Guarantees, each a failure:
// - Each set holds its own table's numbers: every field as the table wrote it (a tint at unit
//   luminance), and each function that reads them at every row of the table that row's numbers: the
//   light lent to the island (`islandSky`) at every setting row, every clouded row under a full
//   cloud and every rising row, under no cloud and a full one; the clear shade's and the low key's
//   rows; the sky's light, the clear day's gain and the thin layer's colours (DayKeys.ts `keyed`) at
//   every key on both sides, under a full cloud at every clouded key and at full night; the clouds'
//   rows and base (`cloudBase`) per sky, and the shadow's share the weather's; each store's night
//   range (`storeNight`) under each sky alone and with no blend; the sea's knee, the key under cloud
//   and the key's hue's numbers, and the key's hue (`keyHue`) and the moon's (`moonHue`) worked out
//   from the table.
// - Making the others leaves the island's as it was: every reading over a grid of elevations, sides,
//   clouds, nights, skies and transmittances, and every field, the same numbers bit for bit.
// - The changed copy differs from the island's in every field the look gives (all but the shadow's
//   share, the weather's), and the neutral set somewhere.
// - The haze's key reads the sky's tables it is given (weather/HazeKeys.ts `hazeKeyAt`): under each
//   decked sky alone its aerosol ends at that set's cloud base, the changed set's off the island's.
// The sky's state for a frame and its bakes (sky/SkyTrack.ts `trackSky`, sky/SkyBake.ts), which
// read the tables the sky holds (sky/Sky.ts `look`), are not run: they need a renderer and the
// sky's nodes; the sky stage hands the sky its tables (RenderStages.ts `createSky`).
//
// Under node the tune table is off (packages/render/debug/Tune.ts `TUNE_ON`), so each system's
// tunables are its own; on a debug page they share one table by name (ExposureLook.ts's,
// DayLook.ts's, Wind.ts's, AmbientLook.ts's, HazeLook.ts's, DisplayLook.ts's and SkyLook.ts's
// headers). The haze's, the display's and the sky's tables load in plain node, so all of their
// numbers, tunables included, are checked here per table.
//
// The other systems that take their tables at creation, through Vite's SSR loader: the shared
// uniforms (packages/render/shared.ts `createShared`: the ambient occlusion's floor and the meadow
// canopy's two media), the local lights (packages/render/lighting/
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
// The bloom (packages/render/post/PhysicalBloom.ts, which plain node cannot load), made on the
// display's tables of the same three looks over a stand-in graph: its uniforms start at its own
// table's `bloomStart`, not a tunable, so read against the look's table itself; `update` writes its
// own tables' keys over a few frames (tunables, shared by name here: read against the tables it
// holds, and for the island's, made first, against the look's table at its last key); the island's
// readings are unmoved by the others, and the others' starts differ from the island's. The frame's
// passes (packages/render/post/Pipeline.ts), which read the rest of the display's tables each frame
// and build the display chain from them (post/PipelineDisplay.ts), are not made: they need a
// renderer and build their graph as they are made; the stage hands them the tables
// (RenderStages.ts `createSeaAndPipeline`), whose numbers the plain node part checks.
import assert from 'node:assert/strict';
import { createExposure } from '../packages/render/look/ExposureLook.ts';
import { DayCycle, cloudMoonShare, displayNight, eveningHour, exposureNight, morningHour, moonKeyShare, nightAmbientAt, nightAmbientShare, rampIn, skyNight, starNight, yunpengNightShare } from '../packages/render/sky/DayCycle.ts';
import { createDayWindows } from '../packages/render/look/DayLook.ts';
import { Wind, createWindUniforms, plantSpeedOf, windResponse } from '../packages/render/weather/Wind.ts';
import { AMBIENT_COLUMNS, AMBIENT_KNOBS, DEFAULT_KNOBS, createAmbientTables, createKeyLift } from '../packages/render/look/AmbientLook.ts';
import { liftedKeyDirection, liftedKeyHeight } from '../packages/render/lighting/KeyLift.ts';
import { createHazeTables } from '../packages/render/look/HazeLook.ts';
import { hazeKeyAt } from '../packages/render/weather/HazeKeys.ts';
import { createDisplayTables } from '../packages/render/look/DisplayLook.ts';
import { hasKeys, keyed } from '../packages/render/post/DayKeys.ts';
import { gradeOf } from '../packages/render/post/GradeLut.ts';
import { HAZE_KEY_NAMES } from '../packages/render/look/Look.ts';
import { byElevation, cloudBase, createSkyTables, islandSky, keyHue, moonHue, storeNight } from '../packages/render/look/SkyLook.ts';
import { SHELL_BOTTOM, SHELL_THICKNESS } from '../packages/render/sky/CloudModel.ts';
import { MIX_SKIES, WEATHER_PRESETS } from '../packages/render/sky/Weather.ts';
import { FOG_NOISE } from '../packages/render/weather/FogNoise.ts';
import * as THREE from 'three/webgpu';
import { float, texture, uniform } from 'three/tsl';
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

// the island's sky tables (the sky's look, below), made here for the haze's key, which reads their
// clouds' base
const islandSkyWritten = structuredClone( ISLAND_LOOK.sky );
const islandSkyTables = createSkyTables( ISLAND_LOOK.sky );

// ---- the haze's look

// the island's haze table changed: every field of every key moved, every row a degree later, the
// fog layer where a key holds none, the sea fog and every per-sky number changed
function changedHaze( look ) {

	const h = structuredClone( look.haze );
	for ( const name of HAZE_KEY_NAMES ) for ( const f of Object.keys( h.keys[ name ] ) ) h.keys[ name ][ f ] += 0.125;
	for ( const rows of [ h.rising, h.setting, h.settingClouded ] ) for ( const row of rows ) row[ 0 ] += 1;
	for ( const f of Object.keys( h.noFog ) ) h.noFog[ f ] += 0.25;
	for ( const f of Object.keys( h.seaFog ) ) h.seaFog[ f ] += 0.25;
	h.keep = h.keep.map( ( v ) => v * 0.75 );
	h.gain = h.gain.map( ( v ) => v + 0.5 );
	h.scales = h.scales.map( ( scale ) => Object.fromEntries( Object.entries( scale ).map( ( [ k, v ] ) => [ k, v * 1.5 ] ) ) );
	h.decked = h.decked.map( ( v ) => ! v );
	h.sunRayleigh = h.sunRayleigh.map( ( v ) => 0.5 - v / 4 );
	return h;

}

// each set holds its own table's numbers
function ownHaze( tables, table, name ) {

	for ( const k of HAZE_KEY_NAMES ) {

		assert.notEqual( tables.keys[ k ], table.keys[ k ], `${ name } haze: the ${ k } key is the table's own object` );
		assert.deepEqual( { ...tables.keys[ k ] }, table.keys[ k ], `${ name } haze: the ${ k } key` );

	}
	for ( const side of [ 'rising', 'setting', 'settingClouded' ] ) {

		assert.equal( tables[ side ].length, table[ side ].length, `${ name } haze: ${ side } rows` );
		tables[ side ].forEach( ( [ at, key ], i ) => {

			assert.equal( at, table[ side ][ i ][ 0 ], `${ name } haze: ${ side } row ${ i }'s elevation` );
			assert.equal( key, tables.keys[ table[ side ][ i ][ 1 ] ], `${ name } haze: ${ side } row ${ i }'s key` );

		} );

	}
	const { day, golden, night, mist, morning } = tables.keys;
	assert.deepEqual( [ ...tables.shaped ], [ day, golden, night, mist ], `${ name } haze: the keys with a shape` );
	for ( const k of HAZE_KEY_NAMES ) {

		const key = tables.keys[ k ];
		assert.equal( tables.fogOf( key ), [ 'day', 'golden', 'mist' ].includes( k ) ? key : key === morning ? mist : night, `${ name } haze: the ${ k } key's fog layer` );

	}
	assert.deepEqual( { ...tables.noFog }, table.noFog, `${ name } haze: the fog layer where a key holds none` );
	assert.deepEqual( { ...tables.seaFog }, table.seaFog, `${ name } haze: the sea fog` );
	for ( const f of [ 'keep', 'gain', 'decked', 'sunRayleigh' ] ) assert.deepEqual( [ ...tables[ f ] ], table[ f ], `${ name } haze: ${ f }` );
	tables.skyScale.forEach( ( scale, s ) => assert.deepEqual( { ...scale }, { ...table.scales[ s ], haze: WEATHER_PRESETS[ MIX_SKIES[ s ] ].haze }, `${ name } haze: the scales of ${ MIX_SKIES[ s ] }` ) );

}

const HAZE_WINDOWS = createDayWindows( ISLAND_LOOK.day );
const CLEAR = [ 1, 0, 0, 0 ];
const keyAt = ( tables, elevation, rising, sky = CLEAR, wind = 0, rain = 0, dayFog = 1, seaFog = 0, fogWeather = 0, skyTables = islandSkyTables ) =>
	hazeKeyAt( tables, HAZE_WINDOWS, skyTables, elevation, rising, sky, wind, rain, dayFog, seaFog, fogWeather, {} );
const nearHaze = ( actual, expected, what ) => near( actual, expected, what, 1e-12 * Math.max( 1, Math.abs( expected ) ) );

// the haze's key reads the tables it is given: a row's key under a clear sky alone, the fog layer
// where a key holds none with the day's fog off, the sea fog with its switch on
function hazeKeyReadsOwn( tables, name ) {

	const [ scale ] = tables.skyScale;
	const { night } = tables.keys;
	let rows = 0;
	for ( const [ side, rising ] of [ [ 'rising', true ], [ 'setting', false ] ] ) tables[ side ].forEach( ( [ at, k ], i ) => {

		// (the setting night's segment comes in by stops, DayCycle.ts `duskIn`, and the last row closes
		// a segment eased to it: neither is the row's key alone)
		if ( i === tables[ side ].length - 1 || ( ! rising && k === night ) ) return;
		const shape = tables.shaped.has( k ) ? k : tables.keys.day, fog = tables.fogOf( k );
		const key = keyAt( tables, at, rising );
		const what = `${ name } haze key: ${ side } row ${ i }`;
		const want = {
			amount: k.amount * scale.haze / WEATHER_PRESETS.clear.haze,
			sigmaRed: k.sigmaRed * scale.sigmaRed, sigmaGreen: k.sigmaGreen * scale.sigmaGreen, sigmaBlue: k.sigmaBlue * scale.sigmaBlue,
			desaturate: 1 - ( 1 - k.desaturate ) * tables.keep[ 0 ], gain: tables.gain[ 0 ], mist: k.mist,
			sunRayleigh: 1 - ( 1 - k.sunRayleigh ) * ( 1 - tables.sunRayleigh[ 0 ] ), rayleighWeight: k.rayleighWeight, mieWeight: k.mieWeight, skyDepth: k.skyDepth,
			aerosolShare: shape.aerosolShare * scale.aerosolScale, aerosolHeight: shape.aerosolHeight * scale.aerosolHeight,
			aerosolTop: tables.decked[ 0 ] ? cloudBase( islandSkyTables, 0 ) : Infinity,
			top: shape.top * scale.topScale * ( 1 - fog.fogLayer ) + fog.fogTop * fog.fogLayer,
			width: shape.width * scale.widthScale * ( 1 - fog.fogLayer ) + fog.fogWidth * fog.fogLayer,
			fogLayer: fog.fogLayer, droplet: fog.fogLayer, neutral: fog.neutral, scatter: fog.scatter, fogTop: fog.fogTop, fogWidth: fog.fogWidth, visibility: fog.visibility,
			fogCoverHigh: FOG_NOISE.high(),
		};
		for ( const [ f, v ] of Object.entries( want ) ) if ( v === Infinity ) assert.equal( key[ f ], v, `${ what }: ${ f }` );
		else nearHaze( key[ f ], v, `${ what }: ${ f }` );
		// the day's fog off: the table's fog layer where a key holds none
		const off = keyAt( tables, at, rising, CLEAR, 0, 0, 0 );
		for ( const f of [ 'neutral', 'scatter', 'fogTop', 'fogWidth', 'visibility' ] ) nearHaze( off[ f ], tables.noFog[ f ], `${ what }, the day's fog off: ${ f }` );
		nearHaze( off.fogLayer, tables.noFog.fogLayer, `${ what }, the day's fog off: fogLayer` );
		// the sea fog on: the table's sea fog
		const sea = keyAt( tables, at, rising, CLEAR, 0, 0, 1, 1 );
		for ( const f of [ 'neutral', 'scatter', 'fogTop', 'fogWidth', 'visibility' ] ) nearHaze( sea[ f ], tables.seaFog[ f ], `${ what }, the sea fog on: ${ f }` );
		nearHaze( sea.fogCoverHigh, tables.seaFog.coverHigh, `${ what }, the sea fog on: fogCoverHigh` );
		rows ++;

	} );
	// a clouded evening: under a cloudy sky alone, at each of the clouded setting rows' elevations,
	// the clouded row's key with the cloudy sky's scales
	const [ , , cloudy ] = tables.skyScale;
	tables.settingClouded.forEach( ( [ at, k ], i ) => {

		if ( i === tables.settingClouded.length - 1 ) return;
		const key = keyAt( tables, at, false, [ 0, 0, 1, 0 ] );
		const what = `${ name } haze key: settingClouded row ${ i }`;
		nearHaze( key.amount, k.amount * cloudy.haze / WEATHER_PRESETS.cloudy.haze, `${ what }: amount` );
		nearHaze( key.sigmaRed, k.sigmaRed * cloudy.sigmaRed, `${ what }: sigmaRed` );
		nearHaze( key.desaturate, 1 - ( 1 - k.desaturate ) * tables.keep[ 2 ], `${ what }: desaturate` );
		for ( const f of [ 'rayleighWeight', 'mieWeight', 'skyDepth' ] ) nearHaze( key[ f ], k[ f ], `${ what }: ${ f }` );
		rows ++;

	} );
	return rows;

}

const HAZE_ELEVATIONS = [];
for ( let e = - 20; e <= 70; e += 0.5 ) HAZE_ELEVATIONS.push( e );
const HAZE_SKIES = [ ...ONE_SKY, [ 0.4, 0.1, 0.3, 0.2 ], [ 0.5, 0.5, 0, 0 ] ];
// the key's fields the look gives (the deck's two shares are the weather's)
const HAZE_FIELDS = Object.keys( ISLAND_LOOK.haze.keys.day ).filter( ( f ) => f !== 'deck' && f !== 'overcastDeck' );
// every field of the haze's key over the grid, by field
function hazeReadings( tables ) {

	const out = Object.fromEntries( HAZE_FIELDS.map( ( f ) => [ f, [] ] ) );
	for ( const e of HAZE_ELEVATIONS ) for ( const rising of [ false, true ] ) for ( const sky of HAZE_SKIES )
		for ( const wind of [ 0, 4.2 ] ) for ( const rain of [ 0, 0.6 ] ) for ( const dayFog of [ 0, 1 ] ) for ( const seaFog of [ 0, 0.5 ] ) for ( const fogWeather of [ 0, 0.5 ] ) {

			const key = keyAt( tables, e, rising, sky, wind, rain, dayFog, seaFog, fogWeather );
			for ( const f of HAZE_FIELDS ) out[ f ].push( key[ f ] );

		}
	return out;

}

const hazeLooks = { island: ISLAND_LOOK.haze, neutral: NEUTRAL_LOOK.haze, changed: changedHaze( ISLAND_LOOK ) };
const islandHazeWritten = structuredClone( ISLAND_LOOK.haze );
const islandHaze = createHazeTables( hazeLooks.island );
const islandHazeBefore = hazeReadings( islandHaze );
const hazes = { island: islandHaze, neutral: createHazeTables( hazeLooks.neutral ), changed: createHazeTables( hazeLooks.changed ) };
let hazeRows = 0;
for ( const [ name, tables ] of Object.entries( hazes ) ) {

	ownHaze( tables, hazeLooks[ name ], name );
	hazeRows += hazeKeyReadsOwn( tables, name );

}
assert.deepEqual( ISLAND_LOOK.haze, islandHazeWritten, 'the island\'s haze table moved' );
const islandHazeAfter = hazeReadings( islandHaze );
let hazeNumbers = 0;
for ( const f of HAZE_FIELDS ) islandHazeAfter[ f ].forEach( ( v, i ) => {

	assert.ok( Object.is( v, islandHazeBefore[ f ][ i ] ), `the island's haze ${ f } reading ${ i } moved: ${ islandHazeBefore[ f ][ i ] } -> ${ v }` );
	hazeNumbers ++;

} );
{

	const changed = hazeReadings( hazes.changed ), neutral = hazeReadings( hazes.neutral );
	for ( const f of HAZE_FIELDS ) assert.ok( changed[ f ].some( ( v, i ) => ! Object.is( v, islandHazeBefore[ f ][ i ] ) ), `changed haze: ${ f } reads as the island's` );
	assert.ok( HAZE_FIELDS.some( ( f ) => neutral[ f ].some( ( v, i ) => ! Object.is( v, islandHazeBefore[ f ][ i ] ) ) ), 'neutral haze: reads as the island\'s' );

}

console.log( `Haze: three sets from three tables, each its own, the haze's key on its own tables (${ hazeRows } rows), the island's unmoved by the others (${ hazeNumbers } readings), the changed copy off the island's in every field the look gives: passed.` );

// ---- the display's look

// the display's tables keyed by the sun and the weather (DayKeys.ts), and the plain ones
const DISPLAY_KEYED = [ 'shadeContrast', 'desaturation', 'whiteBalance', 'bloom' ];
const DISPLAY_PLAIN = [ 'coolShare', 'highlightGrey', 'strengths', 'vignette', 'whiteOvercast', 'toneCurve', 'bloomStart', 'purkinje' ];
const DISPLAY_FIELDS = [ ...DISPLAY_KEYED, ...DISPLAY_PLAIN, 'baseGrade' ];
// a copy of `look`'s display table with every number moved: a key a degree later, any other number
// by an eighth (a set two keys or two fields share moved once)
function changedDisplay( look ) {

	const out = structuredClone( look.display ), seen = new Set();
	const move = ( o ) => {

		if ( seen.has( o ) ) return;
		seen.add( o );
		for ( const [ k, v ] of Object.entries( o ) ) {

			if ( typeof v === 'number' ) o[ k ] = v + ( k === 'at' ? 1 : 0.125 );
			else if ( v && typeof v === 'object' ) move( v );

		}

	};
	move( out );
	return out;

}

// every number of a nested object, in order, with its path
function leaves( o, path = '' ) {

	return Object.entries( o ).flatMap( ( [ k, v ] ) => ( typeof v === 'number' ? [ [ `${ path }${ k }`, v ] ] : leaves( v, `${ path }${ k }.` ) ) );

}
const at = ( o, path ) => path.split( '.' ).reduce( ( x, k ) => x[ k ], o );

const DISPLAY_ELEVATIONS = [];
for ( let e = - 20; e <= 70; e += 0.25 ) DISPLAY_ELEVATIONS.push( e );
const DISPLAY_CLOUDS = [ 0, 0.4, 1 ];
// every number a set of tables gives, by field: the keyed ones over a grid of elevations, nights,
// clouds and both sides, the others as they are held
function displayReadings( t ) {

	const out = Object.fromEntries( DISPLAY_FIELDS.map( ( f ) => [ f, [] ] ) );
	for ( const f of DISPLAY_KEYED ) for ( const e of DISPLAY_ELEVATIONS ) for ( const night of NIGHTS ) for ( const cloud of DISPLAY_CLOUDS ) for ( const rising of [ false, true ] )
		out[ f ].push( ...Object.values( keyed( t[ f ], e, night, {}, cloud, rising ) ) );
	for ( const f of [ ...DISPLAY_PLAIN, 'baseGrade' ] ) out[ f ] = leaves( t[ f ] ).map( ( [ , v ] ) => v );
	return out;

}

const nearKey = ( actual, expected, what ) => {

	assert.deepEqual( Object.keys( actual ), Object.keys( expected ), `${ what }: its values` );
	for ( const k of Object.keys( expected ) ) near( actual[ k ], expected[ k ], `${ what } ${ k }`, 1e-12 * Math.max( 1, Math.abs( expected[ k ] ) ) );

};
// `t`, made from `table`, holds the table's numbers: each field as written (the base grade the
// table's changes over no grade), and each keyed one read at every key's elevation, under a full
// cloud and at full night is that key's, the clouded day's and the night's values
function ownDisplay( t, table, name ) {

	let reads = 0;
	assert.deepEqual( Object.keys( t ).sort(), [ ...DISPLAY_FIELDS ].sort(), `${ name } display: its fields` );
	for ( const f of DISPLAY_PLAIN ) {

		assert.deepEqual( t[ f ], table[ f ], `${ name } display: ${ f }` );
		reads ++;

	}
	assert.deepEqual( t.baseGrade, gradeOf( table.baseGrade ), `${ name } display: the base grade` );
	for ( const [ path, v ] of leaves( table.baseGrade ) ) {

		assert.equal( at( t.baseGrade, path ), v, `${ name } display: the base grade's ${ path }` );
		reads ++;

	}
	for ( const f of DISPLAY_KEYED ) {

		const keys = table[ f ];
		assert.deepEqual( t[ f ], keys, `${ name } display: ${ f }` );
		for ( const [ side, rising ] of [ [ 'day', false ], [ 'rising', true ] ] ) for ( const key of keys[ side ] ?? [] ) {

			nearKey( keyed( t[ f ], key.at, 0, {}, 0, rising ), key.values, `${ name } display: ${ f } ${ side } at ${ key.at }` );
			reads ++;

		}
		if ( keys.cloudy ) for ( const key of hasKeys( keys.cloudy ) ? keys.cloudy : [ { at: 30, values: keys.cloudy } ] ) {

			nearKey( keyed( t[ f ], key.at, 0, {}, 1 ), key.values, `${ name } display: ${ f } cloudy at ${ key.at }` );
			reads ++;

		}
		if ( keys.night ) for ( const e of [ - 12, 30 ] ) {

			nearKey( keyed( t[ f ], e, 1, {}, 0.4 ), keys.night, `${ name } display: ${ f } at night` );
			reads ++;

		}

	}
	return reads;

}

const displayLooks = { island: ISLAND_LOOK.display, neutral: NEUTRAL_LOOK.display, changed: changedDisplay( ISLAND_LOOK ) };
const islandDisplayWritten = structuredClone( ISLAND_LOOK.display );
const islandDisplay = createDisplayTables( displayLooks.island );
const islandDisplayBefore = displayReadings( islandDisplay );
const displays = { island: islandDisplay, neutral: createDisplayTables( displayLooks.neutral ), changed: createDisplayTables( displayLooks.changed ) };
let displayReads = 0;
for ( const [ name, t ] of Object.entries( displays ) ) displayReads += ownDisplay( t, displayLooks[ name ], name );
assert.deepEqual( ISLAND_LOOK.display, islandDisplayWritten, 'the island\'s display table moved' );
const islandDisplayAfter = displayReadings( islandDisplay );
let displayNumbers = 0;
for ( const f of DISPLAY_FIELDS ) islandDisplayAfter[ f ].forEach( ( v, i ) => {

	assert.ok( Object.is( v, islandDisplayBefore[ f ][ i ] ), `the island's display ${ f } reading ${ i } moved: ${ islandDisplayBefore[ f ][ i ] } -> ${ v }` );
	displayNumbers ++;

} );
{

	const changed = displayReadings( displays.changed ), neutral = displayReadings( displays.neutral );
	for ( const f of DISPLAY_FIELDS ) assert.ok( changed[ f ].some( ( v, i ) => ! Object.is( v, islandDisplayBefore[ f ][ i ] ) ), `changed display: ${ f } reads as the island's` );
	assert.ok( DISPLAY_FIELDS.some( ( f ) => neutral[ f ].length !== islandDisplayBefore[ f ].length || neutral[ f ].some( ( v, i ) => ! Object.is( v, islandDisplayBefore[ f ][ i ] ) ) ), 'neutral display: reads as the island\'s' );

}

console.log( `Display: three sets from three tables, each its own (${ displayReads } readings of a table), the island's unmoved by the others (${ displayNumbers } readings), the changed copy off the island's in every field: passed.` );

// ---- the sky's look

// the island's sky table changed: every number moved (a row's or a key's elevation a degree later,
// any other number by an eighth: a set two rows or two keys share moved once), and the clouds' shell
// written out where a row stands in the cloud model's own
function changedSky( look ) {

	const out = structuredClone( look.sky ), seen = new Set();
	for ( const row of out.cloudSkies ) {

		row.base ??= SHELL_BOTTOM;
		row.top ??= SHELL_BOTTOM + SHELL_THICKNESS;

	}
	const move = ( o ) => {

		if ( seen.has( o ) ) return;
		seen.add( o );
		for ( const [ k, v ] of Object.entries( o ) ) {

			if ( typeof v === 'number' ) o[ k ] = v + ( k === 'at' ? 1 : 0.125 );
			else if ( v && typeof v === 'object' ) move( v );

		}

	};
	move( out );
	return out;

}

const unitOf = ( [ r, g, b ] ) => {

	const l = r * 0.2126 + g * 0.7152 + b * 0.0722;
	return [ r / l, g / l, b / l ];

};
const SKY_ELEVATIONS = [];
for ( let e = - 20; e <= 70; e += 0.25 ) SKY_ELEVATIONS.push( e );
const SKY_CLOUDS = [ 0, 0.4, 1 ];
const SKY_MIXES = [ null, ...ONE_SKY, [ 0.4, 0.1, 0.3, 0.2 ], [ 0.5, 0.5, 0, 0 ] ];
// transmittances toward the sun from a high sun's to one under the horizon's
const SKY_TRANSMITTANCES = [ [ 0.93, 0.95, 0.97 ], [ 0.7, 0.8, 0.88 ], [ 0.3, 0.45, 0.6 ], [ 0.02, 0.08, 0.2 ], [ 1e-4, 2e-3, 2e-2 ], [ 0.5, 0, 0.1 ] ];
const SKY_TINTS = [ [ 1, 1, 1 ], [ 1.1, 0.98, 0.9 ] ];
const SKY_KEYED = [ 'skyLight', 'clearSky', 'streakDirect', 'streakAmbient' ];
const SKY_PLAIN = [ 'cloudLightTint', 'clearShadeTint', 'lowSun', 'lowSunTint', 'keyDeckWhite', 'moonKey', 'moonKeyLuminance', 'moonSkyHue', 'nightAmbientHue', 'nightAmbientShare' ];
const SKY_READ = [ 'islandSky', 'clearShade', 'storeRange', 'lowKey', 'cloudSkies', 'shadowDensity', 'seaKnee', 'keyHue', 'moonHue', 'keyThroughCloud' ];
const SKY_FIELDS = [ ...SKY_KEYED, ...SKY_PLAIN, ...SKY_READ ];

// every number a set of tables gives, by field: what its functions read over a grid of elevations,
// sides, clouds, nights and skies, and the plain fields as they are held
function skyReadings( t ) {

	const out = Object.fromEntries( SKY_FIELDS.map( ( f ) => [ f, [] ] ) );
	const tint = new THREE.Vector4(), colour = new THREE.Color();
	for ( const e of SKY_ELEVATIONS ) for ( const rising of [ false, true ] ) for ( const cloud of SKY_CLOUDS ) {

		out.islandSky.push( islandSky( t, e, rising, tint, cloud ), ...tint.toArray() );
		for ( const f of SKY_KEYED ) for ( const night of NIGHTS ) out[ f ].push( ...Object.values( keyed( t[ f ], e, night, {}, cloud, rising ) ) );

	}
	for ( const e of SKY_ELEVATIONS ) {

		out.lowKey.push( byElevation( t.lowKey, e, 'gain' ) );
		out.clearShade.push( byElevation( t.clearShade, e, 'share' ) );

	}
	for ( const group of [ 'dome', 'layer', 'panorama' ] ) for ( const mix of SKY_MIXES ) out.storeRange.push( storeNight( t, group, mix ) );
	t.cloudSkies.forEach( ( row, s ) => out.cloudSkies.push( cloudBase( t, s ), ...Object.values( row ) ) );
	out.shadowDensity.push( ...t.shadowDensity.map( ( row ) => row.shadowDensity ) );
	out.seaKnee.push( t.seaKnee() );
	out.keyHue.push( t.keyHue.depth(), t.keyHue.dawnDepth(), ...t.keyHue.white, t.keyHue.reddens(), t.keyHue.yellows() );
	for ( const transmittance of SKY_TRANSMITTANCES ) for ( const sunTint of SKY_TINTS ) for ( const rising of [ false, true ] )
		out.keyHue.push( ...keyHue( t, colour.setRGB( ...transmittance ), new THREE.Color( ...sunTint ), rising ).toArray() );
	out.moonHue.push( t.moonHue.red(), t.moonHue.blue(), ...moonHue( t, colour ).toArray() );
	out.keyThroughCloud.push( t.keyThroughCloud() );
	for ( const f of SKY_PLAIN ) out[ f ] = typeof t[ f ] === 'number' ? [ t[ f ] ] : leaves( t[ f ] ).map( ( [ , v ] ) => v );
	return out;

}

// `keys`, a set's keyed table made from the table's `table`, read at every key's elevation on both
// sides, under a full cloud at every clouded key and at full night, is that key's, the clouded
// day's and the night's values; returns the readings
function keysReadOwn( keys, table, what ) {

	let reads = 0;
	for ( const [ side, rising ] of [ [ 'day', false ], [ 'rising', true ] ] ) for ( const key of table[ side ] ?? [] ) {

		nearKey( keyed( keys, key.at, 0, {}, 0, rising ), key.values, `${ what } ${ side } at ${ key.at }` );
		reads ++;

	}
	if ( table.cloudy ) for ( const key of hasKeys( table.cloudy ) ? table.cloudy : [ { at: 30, values: table.cloudy } ] ) {

		nearKey( keyed( keys, key.at, 0, {}, 1 ), key.values, `${ what } cloudy at ${ key.at }` );
		reads ++;

	}
	if ( table.night ) for ( const e of [ - 12, 30 ] ) {

		nearKey( keyed( keys, e, 1, {}, 0.4 ), table.night, `${ what } at night` );
		reads ++;

	}
	return reads;

}

// `t`, made from `table`, holds the table's numbers: each field as written (a tint at unit
// luminance), and each function that reads it at every row of the table that row's numbers
function ownSky( t, table, name ) {

	let reads = 0;
	const read = ( actual, expected, what ) => {

		if ( Number.isFinite( expected ) ) near( actual, expected, `${ name } sky: ${ what }`, 1e-12 * Math.max( 1, Math.abs( expected ) ) );
		else assert.equal( actual, expected, `${ name } sky: ${ what }` );
		reads ++;

	};
	const tinted = ( actual, [ r, g, b, amount ], what ) => {

		unitOf( [ r, g, b ] ).forEach( ( v, c ) => read( actual[ c ], v, `${ what } ${ c }` ) );
		if ( amount !== undefined ) read( actual[ 3 ], amount, `${ what }'s amount` );

	};
	assert.deepEqual( Object.keys( t ).sort(), [ ...SKY_FIELDS ].sort(), `${ name } sky: its fields` );
	tinted( t.cloudLightTint, table.cloudLightTint, 'cloudLightTint' );
	tinted( t.clearShadeTint, table.clearShadeTint, 'clearShadeTint' );
	tinted( t.lowSunTint, table.lowSunTint, 'lowSunTint' );
	for ( const f of [ 'clearShade', 'lowSun', 'keyDeckWhite', 'storeRange', 'lowKey', 'moonKey', 'moonSkyHue', 'nightAmbientHue', 'nightAmbientShare' ] ) {

		assert.deepEqual( t[ f ], table[ f ], `${ name } sky: ${ f }` );
		reads ++;

	}
	assert.deepEqual( t.islandSky, table.islandSky, `${ name } sky: islandSky` );
	// the light lent to the island at each row: the setting rows', the clouded ones' under a full
	// cloud, the rising ones' (under a full cloud with the clouded setting side's gain)
	const tint = new THREE.Vector4(), clouded = new THREE.Vector4();
	for ( const [ side, rising, cloud ] of [ [ 'setting', false, 0 ], [ 'clouded', false, 1 ], [ 'rising', true, 0 ], [ 'rising', true, 1 ] ] ) table.islandSky[ side ].forEach( ( row, i ) => {

		const what = `islandSky ${ side } row ${ i }${ cloud ? ' under cloud' : '' }`;
		const gain = islandSky( t, row.at, rising, tint, cloud );
		tinted( tint.toArray(), [ ...( row.tint ?? [ 1, 1, 1 ] ), row.amount ?? 0 ], what );
		read( gain, rising && cloud ? islandSky( t, row.at, false, clouded, 1 ) : row.gain ?? 1, `${ what }'s gain` );

	} );
	for ( const rows of [ table.clearShade, table.lowKey ] ) for ( const row of rows ) {

		const key = rows === table.lowKey ? 'gain' : 'share';
		read( byElevation( rows === table.lowKey ? t.lowKey : t.clearShade, row.at, key ), row[ key ], `${ key } at ${ row.at }` );

	}
	reads += keysReadOwn( t.skyLight, table.skyLight, `${ name } sky: skyLight` );
	reads += keysReadOwn( t.clearSky, table.clearSky, `${ name } sky: clearSky` );
	for ( const f of [ 'streakDirect', 'streakAmbient' ] ) {

		for ( const side of [ 'day', 'rising' ] ) for ( const key of t[ f ][ side ] ) {

			nearKey( keyed( t[ f ], key.at, 0, {}, 0, side === 'rising' ), table[ f ][ key.name ], `${ name } sky: ${ f } ${ side } at ${ key.at }` );
			reads ++;

		}
		nearKey( keyed( t[ f ], 30, 1, {}, 0 ), table[ f ].night, `${ name } sky: ${ f } at night` );
		reads ++;

	}
	t.shadowDensity.forEach( ( row, s ) => read( row.shadowDensity, WEATHER_PRESETS[ MIX_SKIES[ s ] ].shadowDensity, `shadowDensity of ${ MIX_SKIES[ s ] }` ) );
	table.cloudSkies.forEach( ( row, s ) => {

		const want = { base: row.base ?? SHELL_BOTTOM, top: row.top ?? SHELL_BOTTOM + SHELL_THICKNESS, type: row.type, spread: row.spread, farFade: row.farFade };
		for ( const [ k, v ] of Object.entries( want ) ) read( t.cloudSkies[ s ][ k ], v, `cloudSkies ${ MIX_SKIES[ s ] } ${ k }` );
		read( cloudBase( t, s ), want.base, `cloudBase of ${ MIX_SKIES[ s ] }` );

	} );
	// each store's night range: a sky alone takes its own row, no blend the clear sky's
	for ( const group of [ 'dome', 'layer', 'panorama' ] ) for ( const [ s, mix ] of [ [ 0, null ], ...ONE_SKY.map( ( m, i ) => [ i, m ] ) ] ) {

		const [ top, floor ] = table.storeRange[ group ][ s ];
		// (centred between the floor and the top a night's store must keep, SkyLook.ts NIGHT_FLOOR
		// and NIGHT_TOP: 2^-1 and 2^13)
		read( storeNight( t, group, mix ), ( 13 + ( - 13 + 12 ) - top - floor ) / 2, `storeNight ${ group } ${ mix ? MIX_SKIES[ s ] : 'without a blend' }` );

	}
	read( t.seaKnee(), table.seaKnee, 'seaKnee' );
	read( t.keyThroughCloud(), table.keyThroughCloud, 'keyThroughCloud' );
	read( t.keyHue.depth(), table.keyHue.depth, 'keyHue.depth' );
	read( t.keyHue.dawnDepth(), table.keyHue.dawnDepth, 'keyHue.dawnDepth' );
	read( t.keyHue.reddens(), table.keyHue.reddens, 'keyHue.reddens' );
	read( t.keyHue.yellows(), table.keyHue.yellows, 'keyHue.yellows' );
	assert.deepEqual( t.keyHue.white, table.keyHue.white, `${ name } sky: keyHue.white` );
	// the key's hue from the table's numbers
	for ( const [ r, g, b ] of SKY_TRANSMITTANCES ) for ( const sunTint of SKY_TINTS ) for ( const rising of [ false, true ] ) {

		const what = `keyHue of ${ [ r, g, b ] }${ rising ? ' rising' : '' }`;
		const got = keyHue( t, new THREE.Color( r, g, b ), new THREE.Color( ...sunTint ), rising ).toArray();
		if ( g <= 0 ) {

			got.forEach( ( v, c ) => read( v, 0, `${ what } ${ c }` ) );
			continue;

		}
		const { depth: cap, dawnDepth, white, reddens, yellows } = table.keyHue;
		const depth = - Math.log( g );
		const scale = 1 / Math.pow( 1 + Math.pow( depth / ( rising ? dawnDepth : cap ), 6 ), 1 / 6 );
		const share = ( onset ) => scale * ( 1 - Math.exp( - Math.pow( depth / onset, 2.5 ) ) );
		const luminance = ( [ x, y, z ] ) => x * 0.2126 + y * 0.7152 + z * 0.0722;
		const hue = [ white[ 0 ] * Math.pow( r / g, share( reddens ) ), 1, white[ 1 ] * Math.pow( b / g, share( yellows ) ) ];
		const level = luminance( [ r * sunTint[ 0 ], g * sunTint[ 1 ], b * sunTint[ 2 ] ] ) / luminance( hue );
		hue.forEach( ( v, c ) => read( got[ c ], v * level, `${ what } ${ c }` ) );

	}
	// the moon's key and its hue from the table's numbers
	const [ mr, mg, mb ] = table.moonKey.colour;
	const moonLuminance = mr * 0.2126 + mg * 0.7152 + mb * 0.0722;
	read( t.moonKeyLuminance, moonLuminance, 'moonKeyLuminance' );
	read( t.moonHue.red(), table.moonHue.red, 'moonHue.red' );
	read( t.moonHue.blue(), table.moonHue.blue, 'moonHue.blue' );
	{

		const r = table.moonHue.red / table.moonKey.red, b = table.moonHue.blue / table.moonKey.blue;
		const level = moonLuminance / ( mr * r * 0.2126 + mg * 0.7152 + mb * b * 0.0722 );
		moonHue( t, new THREE.Color() ).toArray().forEach( ( v, c ) => read( v, [ r * level, level, b * level ][ c ], `moonHue ${ c }` ) );

	}
	return reads;

}

const islandSkyBefore = skyReadings( islandSkyTables );
const skyLooks = { island: ISLAND_LOOK.sky, neutral: NEUTRAL_LOOK.sky, changed: changedSky( ISLAND_LOOK ) };
const skies = { island: islandSkyTables, neutral: createSkyTables( skyLooks.neutral ), changed: createSkyTables( skyLooks.changed ) };
let skyReads = 0;
for ( const [ name, t ] of Object.entries( skies ) ) skyReads += ownSky( t, skyLooks[ name ], name );
assert.deepEqual( ISLAND_LOOK.sky, islandSkyWritten, 'the island\'s sky table moved' );
const islandSkyAfter = skyReadings( islandSkyTables );
let skyNumbers = 0;
for ( const f of SKY_FIELDS ) islandSkyAfter[ f ].forEach( ( v, i ) => {

	assert.ok( Object.is( v, islandSkyBefore[ f ][ i ] ), `the island's sky ${ f } reading ${ i } moved: ${ islandSkyBefore[ f ][ i ] } -> ${ v }` );
	skyNumbers ++;

} );
{

	// (the clouds' shadow's share is the weather's, the same in every set)
	const changed = skyReadings( skies.changed ), neutral = skyReadings( skies.neutral );
	for ( const f of SKY_FIELDS ) if ( f !== 'shadowDensity' ) assert.ok( changed[ f ].some( ( v, i ) => ! Object.is( v, islandSkyBefore[ f ][ i ] ) ), `changed sky: ${ f } reads as the island's` );
	assert.ok( SKY_FIELDS.some( ( f ) => neutral[ f ].length !== islandSkyBefore[ f ].length || neutral[ f ].some( ( v, i ) => ! Object.is( v, islandSkyBefore[ f ][ i ] ) ) ), 'neutral sky: reads as the island\'s' );

}
// the haze's key reads the clouds' base of the sky's tables it is given: under each decked sky alone
// the aerosol ends at that sky's base, the changed set's off the island's
let skyHaze = 0;
islandHaze.decked.forEach( ( decked, s ) => {

	if ( ! decked ) return;
	const mix = ONE_SKY[ s ];
	for ( const [ name, t ] of Object.entries( skies ) ) {

		// (one over its inverse: equal to the last bits)
		near( keyAt( islandHaze, 30, false, mix, 0, 0, 1, 0, 0, t ).aerosolTop, cloudBase( t, s ), `${ name } sky: the haze's aerosol top under ${ MIX_SKIES[ s ] }`, 1e-12 * cloudBase( t, s ) );
		skyHaze ++;

	}
	assert.notEqual( keyAt( islandHaze, 30, false, mix, 0, 0, 1, 0, 0, skies.changed ).aerosolTop, keyAt( islandHaze, 30, false, mix ).aerosolTop, `changed sky: the haze's aerosol top under ${ MIX_SKIES[ s ] }` );

} );
assert.ok( skyHaze > 0, 'no decked sky in the island\'s haze' );

console.log( `Sky: three sets from three tables, each its own (${ skyReads } readings of a table), the island's unmoved by the others (${ skyNumbers } readings), the changed copy off the island's in every field the look gives, the haze's aerosol top on its own sky's cloud base (${ skyHaze } readings): passed.` );

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
let systems = 0, grades = 0, bloomCount = 0;
try {

	const load = ( file ) => server.ssrLoadModule( `/${ file }` );
	const { installSettings, parseSettings } = await load( 'packages/render/Settings.ts' );
	installSettings( parseSettings( '' ) );
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

	// The bloom (post/PhysicalBloom.ts), made on each look's display tables over a stand-in graph:
	// its uniforms start at its own tables' `bloomStart` (not a tunable: checked against the look's
	// table itself) and `update` writes its own tables' keys (tunables, shared by name here: checked
	// against the tables it holds, and against the look's table for the island's, made first).
	const { createDisplayTables: ssrDisplayTables } = await load( 'packages/render/look/DisplayLook.ts' );
	const { PhysicalBloom } = await load( 'packages/render/post/PhysicalBloom.ts' );
	const texel = uniform( new THREE.Vector2( 1, 1 ) );
	const graph = { color: ( name ) => ( { name, texture: new THREE.Texture() } ), texture: ( h ) => h.texture, texel: () => texel };
	const BLOOM_NAMES = [ 'threshold', 'knee', 'share', 'cap', 'skyThreshold', 'skyKnee', 'skyShare', 'skyCap' ];
	const BLOOM_INPUTS = [ [ 45, 0, 0 ], [ 4, 0, 0.5 ], [ - 2, 0.3, 1 ], [ - 12, 1, 0 ], [ 12, 0, 1 ] ];
	const bloomNumbers = ( bloom ) => [ ...BLOOM_NAMES.map( ( k ) => bloom.uniforms[ k ].value ), ...bloom.uniforms.weights.map( ( w ) => w.value ) ];
	const bloomWanted = ( key ) => [ ...BLOOM_NAMES.map( ( k ) => key[ k ] ), ...[ 0, 1, 2, 3, 4, 5, 6, 7 ].map( ( i ) => key[ `w${ i }` ] ) ];
	const bloomReadings = ( bloom ) => BLOOM_INPUTS.map( ( input ) => {

		bloom.update( ...input );
		return bloomNumbers( bloom );

	} );
	const bloomLooks = { island: ISLAND_LOOK.display, neutral: NEUTRAL_LOOK.display, changed: changedDisplay( ISLAND_LOOK ) };
	const makeBloom = ( tables ) => new PhysicalBloom( tables, graph, texture( new THREE.Texture() ), float( 1 ), () => float( 0 ) );
	const bloomTables = {}, blooms = {};
	for ( const [ name, table ] of Object.entries( bloomLooks ) ) {

		bloomTables[ name ] = ssrDisplayTables( table );
		blooms[ name ] = makeBloom( bloomTables[ name ] );
		assert.deepEqual( BLOOM_NAMES.map( ( k ) => blooms[ name ].uniforms[ k ].value ), BLOOM_NAMES.map( ( k ) => table.bloomStart[ k ] ), `${ name } bloom: its start` );

	}
	const islandBloomBefore = bloomReadings( blooms.island );
	for ( const [ name, bloom ] of Object.entries( blooms ) ) {

		const tables = bloomTables[ name ];
		assert.deepEqual( bloomReadings( bloom ), BLOOM_INPUTS.map( ( [ e, night, cloud ] ) => bloomWanted( keyed( tables.bloom, e, night, {}, cloud ) ) ), `${ name } bloom: the keys it writes` );
		bloom.update( 70, 0, 0 );
		assert.deepEqual( bloomNumbers( bloom ), bloomWanted( keyed( tables.bloom, 70, 0, {} ) ), `${ name } bloom: the high sun` );

	}
	const high = bloomLooks.island.bloom.day.at( - 1 );
	blooms.island.update( high.at, 0, 0 );
	bloomNumbers( blooms.island ).forEach( ( v, i ) => near( v, bloomWanted( high.values )[ i ], `island bloom: its last key's ${ i }` ) );
	assert.deepEqual( bloomReadings( makeBloom( bloomTables.island ) ), islandBloomBefore, 'the island\'s bloom moved' );
	assert.deepEqual( bloomReadings( blooms.island ), islandBloomBefore, 'the island\'s bloom moved' );
	const started = ( name ) => BLOOM_NAMES.map( ( k ) => makeBloom( bloomTables[ name ] ).uniforms[ k ].value );
	started( 'island' ).forEach( ( v, i ) => {

		assert.notEqual( started( 'changed' )[ i ], v, `changed bloom: its start's ${ BLOOM_NAMES[ i ] } reads as the island's` );

	} );
	assert.notDeepEqual( started( 'neutral' ), started( 'island' ), 'neutral bloom: its start reads as the island\'s' );
	bloomCount = BLOOM_INPUTS.length;

} finally {

	await server.close();

}
console.log( `Shared uniforms (the wind's look among them), local lights, sea detail and swell: three of each from three tables, each its own (${ systems } numbers), the island's unmoved by the others: passed.` );
console.log( `Ambient grade: three controllers on three tables, each holding and writing its own (${ grades } frames), the island's unmoved by the others: passed.` );
console.log( `Bloom: three on three display tables, each starting at its own and writing its own keys (${ bloomCount } frames), the island's unmoved by the others: passed.` );
