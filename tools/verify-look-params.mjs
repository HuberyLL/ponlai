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
// Under node the tune table is off (packages/render/debug/Tune.ts `TUNE_ON`), so each exposure's
// tunables are its own; on a debug page they share one table by name (ExposureLook.ts's header).
//
// The other systems that take their tables at creation, through Vite's SSR loader with the
// island's look installed (so a number that came from the installed look instead of the table
// given would show): the shared uniforms (packages/render/shared.ts `createShared`: the ambient
// occlusion's floor and the meadow canopy's two media), the local lights (packages/render/lighting/
// LocalLights.ts `LocalLights`: the gain), the sea's detail (packages/render/ocean/SeaDetail.ts:
// its three strengths) and the FFT ocean's distant swell (packages/render/ocean/OceanFFT.ts: every
// field of it). Each is made from the island's look, the neutral one and a copy of the island's
// with every one of these numbers changed, in that order. Guarantees, each a failure:
// - Each reads its own table's numbers, equal to the table's and none from another.
// - Making the others leaves the island's as it was.
// - The three differ wherever their tables do (the changed copy everywhere).
import assert from 'node:assert/strict';
import { installIslandLook } from './island-look.mjs';
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

console.log( `Exposure: three exposures from three tables, each its own (${ before.length } readings), the island's unmoved by the others, the changed copy off by its changes alone, the day cycle reading its own: passed.` );

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
	};

}

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
	return out;

}

const { createServer } = await import( 'vite' );
const ROOT = new URL( '..', import.meta.url ).pathname;
const server = await createServer( {
	root: ROOT, logLevel: 'error', appType: 'custom', clearScreen: false,
	server: { middlewareMode: true, hmr: false, ws: false, watch: null },
	optimizeDeps: { noDiscovery: true, include: [] },
} );
let systems = 0;
try {

	const load = ( file ) => server.ssrLoadModule( `/${ file }` );
	const { installSettings, parseSettings } = await load( 'packages/render/Settings.ts' );
	installSettings( parseSettings( '' ) );
	await installIslandLook( load );
	const { createShared } = await load( 'packages/render/shared.ts' );
	const { LocalLights } = await load( 'packages/render/lighting/LocalLights.ts' );
	const { SeaDetail } = await load( 'packages/render/ocean/SeaDetail.ts' );
	const { OceanFFT } = await load( 'packages/render/ocean/OceanFFT.ts' );
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

} finally {

	await server.close();

}
console.log( `Shared uniforms, local lights, sea detail and swell: three of each from three tables, each its own (${ systems } numbers), the island's unmoved by the others: passed.` );
