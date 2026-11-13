// Checks that the exposure takes its look tables at creation (packages/render/look/ExposureLook.ts
// `createExposure`): exposures made from different tables in one process each hold their own
// numbers, and making one leaves another as it was. CPU only, no GPU, under a second.
//   node tools/verify-exposure-look.mjs
//
// It makes three exposures: from the island's look (packages/island/look/IslandLook.ts), from the
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
// Under node the tune table is off (packages/render/debug/Tune.ts `TUNE_ON`), so each exposure's
// tunables are its own; on a debug page they share one table by name (ExposureLook.ts's header).
import assert from 'node:assert/strict';
import './island-look.mjs';
import { createExposure } from '../packages/render/look/ExposureLook.ts';
import { DayCycle } from '../packages/render/sky/DayCycle.ts';
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
for ( const hour of [ 3, 7, 12, 18.5 ] ) {

	const a = new DayCycle( island, { hour, paused: true } ).snapshot(), b = new DayCycle( shifted, { hour, paused: true } ).snapshot();
	assert.equal( a.exposure, island.at( a.elevation ), `day cycle at ${ hour }: island` );
	assert.equal( b.exposure, shifted.at( b.elevation ), `day cycle at ${ hour }: changed` );
	assert.equal( b.exposure, 2 * a.exposure, `day cycle at ${ hour }: changed over island` );

}

console.log( `Exposure look: three exposures from three tables, each its own (${ before.length } readings), the island's unmoved by the others, the changed copy off by its changes alone, the day cycle reading its own: passed.` );
