// Integrated day/night checks and fixed-camera evidence. One WebGPU page stays open throughout.
// Run after the dynamic-sky debug API is installed:
//   node tools/verify-dynamic-sky.mjs http://127.0.0.1:5190
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { acquireGpuLock } from './gpu-lock.mjs';
import { DAY_PRESETS } from '../src/sky/DayCycle.ts';

const base = process.argv[ 2 ] || 'http://127.0.0.1:5190';
const out = 'artifacts/verification/dynamic-sky';
const hours = Object.entries( DAY_PRESETS );
const report = { base, hours: [], phases: {}, clock: {}, resources: {}, checks: [], errors: [], failures: [] };
await mkdir( out, { recursive: true } );
// shared with other probes (their pixels do not depend on the GPU load), never during a timing
// run (tools/gpu-lock.mjs; released when the process exits)
await acquireGpuLock( 'verify-dynamic-sky', { shared: true } );
const browser = await chromium.launch( {
	headless: true,
	...( process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' } ),
	args: [ '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit' ],
} );

const luma = ( rgb ) => rgb[ 0 ] * 0.2126 + rgb[ 1 ] * 0.7152 + rgb[ 2 ] * 0.0722;
const near = ( actual, expected, tolerance, label ) => assert.ok( Math.abs( actual - expected ) <= tolerance, `${ label }: ${ actual } vs ${ expected }` );
const colour = ( rgb, label ) => assert.ok( rgb.length === 3 && rgb.every( ( value ) => Number.isFinite( value ) && value >= 0 ), `${ label }: ${ rgb }` );
const sameVector = ( actual, expected, label ) => {
	assert.equal( actual.length, expected.length, label );
	actual.forEach( ( value, index ) => near( value, expected[ index ], 1e-6, `${ label }[${ index }]` ) );
};

try {
	const page = await browser.newPage( { viewport: { width: 1672, height: 941 }, deviceScaleFactor: 1 } );
	page.setDefaultTimeout( 90000 );
	page.on( 'pageerror', ( error ) => report.errors.push( `pageerror: ${ error.message }` ) );
	page.on( 'console', ( message ) => { if ( message.type() === 'error' ) report.errors.push( message.text() ); } );
	page.on( 'response', ( response ) => { if ( response.status() >= 400 ) report.failures.push( `${ response.status() } ${ response.url() }` ); } );
	page.on( 'requestfailed', ( request ) => report.failures.push( `${ request.failure()?.errorText } ${ request.url() }` ) );
	const url = new URL( base );
	for ( const [ key, value ] of Object.entries( { debug: '', paused: '', t: '12', dpr: '1', dist: '58', polar: '50', az: '318' } ) ) url.searchParams.set( key, value );
	await page.goto( url.href );
	await page.waitForFunction( () => window.__PONLAI__?.dayCycle && typeof window.__PONLAI__.setHour === 'function' &&
		typeof window.__PONLAI__.setPreset === 'function' && typeof window.__PONLAI__.refreshEnvironment === 'function' &&
		window.__THREE_GAME_DIAGNOSTICS__?.frame > 60 && document.getElementById( 'loading' )?.classList.contains( 'done' ) );
	await page.evaluate( () => {
		const s = window.__PONLAI__;
		s.dayCycle.paused = true;
		s.dayCycle.advanceMoonPhase = false;
		s.dayCycle.moonPhase = 0.5;
		s.controls.enableDamping = false;
	} );

	// Two successive presentations separate each pair. The animation clock remains frozen,
	// making unexpected changes visible without conflating them with moving water or grass.
	const twoFrames = () => page.evaluate( () => new Promise( ( resolve ) => requestAnimationFrame( () => requestAnimationFrame( resolve ) ) ) );
	const camera = async ( horizon ) => {
		await page.evaluate( ( horizon ) => {
			const s = window.__PONLAI__;
			// the page's island and horizon views on its land (window.__PONLAI__.land)
			const distance = ( horizon ? 110 : 58 ) * s.land.scale, polar = horizon ? 82 : 50, azimuth = horizon ? 125 : 318;
			s.controls.target.fromArray( s.land.target );
			s.camera.position.setFromSphericalCoords( distance, polar * Math.PI / 180, azimuth * Math.PI / 180 ).add( s.controls.target );
			s.controls.update();
			s.camera.updateMatrixWorld();
		}, horizon );
		await twoFrames();
	};
	const screenshotPair = async ( name ) => {
		const paths = [];
		for ( const frame of [ 'a', 'b' ] ) {
			await twoFrames();
			const path = `${ out }/${ name }-${ frame }.png`;
			await page.screenshot( { path } );
			paths.push( path );
		}
		return paths;
	};
	const snapshot = () => page.evaluate( async () => {
		const s = window.__PONLAI__, sky = s.sky;
		const pixels = await s.renderer.readRenderTargetPixelsAsync( sky.small, 0, 0, sky.small.width, sky.small.height );
		const gpuIrradiance = await s.renderer.readRenderTargetPixelsAsync( sky.irradianceDisplay, 0, 0, 1, 1 );
		let minimum = Infinity, maximum = - Infinity, finite = true, samples = 0;
		const mean = [ 0, 0, 0 ];
		for ( let i = 0; i < pixels.length; i += 4 ) {
			for ( let channel = 0; channel < 3; channel ++ ) {
				const value = pixels[ i + channel ];
				finite &&= Number.isFinite( value );
				minimum = Math.min( minimum, value );
				maximum = Math.max( maximum, value );
			}
			if ( pixels[ i + 3 ] <= 0 ) continue;
			for ( let channel = 0; channel < 3; channel ++ ) mean[ channel ] += pixels[ i + channel ];
			samples ++;
		}
		return {
			hour: s.dayCycle.hour, phase: s.dayCycle.moonPhase,
			sunDir: sky.sunDir.toArray(), moonDir: sky.moonDir.toArray(), keyDir: sky.keyDir.toArray(),
			lightDir: s.sun.position.clone().sub( s.sun.target.position ).normalize().toArray(),
			sharedDir: s.shared.sunDir.value.toArray(),
			sunColor: sky.sunColor.toArray(), keyColor: sky.keyColor.toArray(),
			lightColor: s.sun.color.clone().multiplyScalar( s.sun.intensity ).toArray(),
			sharedColor: s.shared.sunColor.value.toArray(),
			skyIrradiance: sky.skyIrradiance.toArray(), sharedIrradiance: s.shared.skyIrradiance.value.toArray(),
			gpuIrradiance: Array.from( gpuIrradiance.slice( 0, 3 ) ),
			sunIntoWater: s.shared.sunIntoWater.value, muSun: s.shared.muSun.value,
			exposure: s.pipeline.settings.exposure,
			// (the environment's atlases store the radiance at a power of two, which its intensity
			// divides out with the fill: Sky.ts `environmentRead`)
			environmentFill: s.scene.environmentIntensity / sky.environmentRead,
			environmentMatches: Boolean( sky.envMap && s.scene.environment === sky.envMap.texture ),
			radiance: { finite, minimum, maximum, samples, mean: mean.map( ( value ) => value / Math.max( samples, 1 ) ) },
			memory: { ...s.renderer.info.memory },
			diagnostics: { ...window.__THREE_GAME_DIAGNOSTICS__ },
		};
	} );
	const validateState = ( state, label ) => {
		for ( const key of [ 'sunColor', 'keyColor', 'lightColor', 'sharedColor', 'skyIrradiance', 'sharedIrradiance' ] ) colour( state[ key ], `${ label } ${ key }` );
		for ( const key of [ 'sunDir', 'moonDir', 'keyDir' ] ) {
			assert.ok( state[ key ].every( Number.isFinite ), `${ label } ${ key } must be finite` );
			near( Math.hypot( ...state[ key ] ), 1, 1e-6, `${ label } ${ key } length` );
		}
		sameVector( state.lightDir, state.keyDir, `${ label } scene key direction` );
		sameVector( state.sharedDir, state.keyDir, `${ label } water key direction` );
		sameVector( state.lightColor, state.keyColor, `${ label } scene key colour` );
		sameVector( state.sharedColor, state.keyColor, `${ label } water key colour` );
		sameVector( state.sharedIrradiance, state.skyIrradiance.map( ( value ) => value * state.environmentFill ), `${ label } shared environment irradiance` );
		sameVector( state.gpuIrradiance, state.skyIrradiance, `${ label } GPU hemisphere integral agrees with CPU reference` );
		assert.ok( state.environmentMatches, `${ label } environment must publish the completed sky` );
		assert.ok( state.radiance.finite && state.radiance.minimum >= 0 && state.radiance.samples > 0, `${ label } sky radiance must be finite and non-negative` );
		assert.ok( Number.isFinite( state.exposure ) && state.exposure > 0, `${ label } exposure` );
		assert.ok( Number.isFinite( state.sunIntoWater ) && state.sunIntoWater >= 0 && state.sunIntoWater <= 1, `${ label } water transmission` );
		assert.ok( Number.isFinite( state.muSun ) && state.muSun > 0 && state.muSun <= 1, `${ label } refracted elevation` );
		if ( state.keyDir[ 1 ] > 0.05 && luma( state.keyColor ) > 1e-6 ) assert.ok( state.sunIntoWater > 0, `${ label } visible key must transmit into water` );
		if ( state.keyDir[ 1 ] <= 0 ) near( state.sunIntoWater, 0, 1e-8, `${ label } below-horizon beam` );
	};

	for ( const [ name, hour ] of hours ) {
		await page.evaluate( ( hour ) => window.__PONLAI__.setHour( hour ), hour );
		await camera( false );
		const record = { name, ...await snapshot(), overview: await screenshotPair( `${ name }-overview` ) };
		if ( [ 'sunrise', 'sunset', 'midnight' ].includes( name ) ) {
			await camera( true );
			record.horizon = await screenshotPair( `${ name }-horizon` );
		}
		report.hours.push( record );
		near( record.hour, hour, 1e-8, `${ name } explicit time` );
		validateState( record, name );
	}
	report.checks.push( 'Seven fixed hours: finite sky radiance, coherent direct light/environment/water and valid underwater transmission' );
	const noon = report.hours.find( ( state ) => state.name === 'noon' );
	const midnight = report.hours.find( ( state ) => state.name === 'midnight' );
	const energy = ( state ) => luma( state.sharedColor ) + luma( state.sharedIrradiance );
	assert.ok( energy( noon ) > 1e-4, 'Noon must contain usable lighting' );
	assert.ok( energy( midnight ) < energy( noon ) * 0.15, 'Night must remain substantially darker than noon' );
	assert.ok( luma( midnight.keyColor ) > 0, 'A visible full moon must supply restrained direct light' );
	report.checks.push( 'Night lighting energy is less than 15% of noon' );

	await page.evaluate( async () => { window.__PONLAI__.dayCycle.moonPhase = 0; await window.__PONLAI__.setHour( 0 ); } );
	report.phases.newMoon = await snapshot();
	validateState( report.phases.newMoon, 'new moon' );
	await page.evaluate( async () => { window.__PONLAI__.dayCycle.moonPhase = 0.5; await window.__PONLAI__.refreshEnvironment(); } );
	report.phases.fullMoon = await snapshot();
	validateState( report.phases.fullMoon, 'full moon' );
	// The phase shapes only the drawn moon (DayCycle's header): the key is the full moon's at every
	// phase, and the night's light moves only by the drawn disk's share of the sky.
	near( luma( report.phases.newMoon.keyColor ), luma( report.phases.fullMoon.keyColor ), luma( report.phases.fullMoon.keyColor ) * 1e-6, 'The phase must not change the moon\'s key' );
	assert.ok( energy( report.phases.newMoon ) > energy( report.phases.fullMoon ) * 0.95, 'The phase must not darken the night' );
	report.checks.push( 'Moon phase leaves the night lighting as it is' );
	await page.evaluate( () => window.__PONLAI__.setPreset( 'golden-hour' ) );
	near( await page.evaluate( () => window.__PONLAI__.dayCycle.hour ), DAY_PRESETS[ 'golden-hour' ], 1e-8, 'Golden-hour preset' );

	// Warm both day and night paths before counting retained resources. A small allowance
	// accommodates renderer-internal pooling; an allocation retained on each bake must fail.
	for ( const hour of [ 0, 12, 0, 12 ] ) await page.evaluate( ( hour ) => window.__PONLAI__.setHour( hour ), hour );
	await twoFrames();
	report.resources.baseline = await page.evaluate( () => ( { ...window.__PONLAI__.renderer.info.memory } ) );
	report.resources.samples = [];
	for ( let i = 0; i < 12; i ++ ) {
		await page.evaluate( ( hour ) => window.__PONLAI__.setHour( hour ), [ DAY_PRESETS.dawn, DAY_PRESETS.noon, DAY_PRESETS.sunset, DAY_PRESETS.midnight ][ i % 4 ] );
		await twoFrames();
		report.resources.samples.push( await page.evaluate( () => ( { ...window.__PONLAI__.renderer.info.memory } ) ) );
	}
	assert.ok( Math.max( ...report.resources.samples.map( ( state ) => state.textures ) ) <= report.resources.baseline.textures + 4, 'Repeated completed sky bakes must not retain a texture per update' );
	assert.ok( Math.max( ...report.resources.samples.map( ( state ) => state.geometries ) ) <= report.resources.baseline.geometries + 2, 'Repeated sky bakes must not accumulate geometry' );
	report.checks.push( 'Repeated explicit refreshes retain bounded textures and geometry' );

	await camera( false );
	await page.evaluate( () => window.__PONLAI__.setHour( 10 ) );
	// The page was opened globally paused for image evidence. Resume scene animation before
	// checking the independently controllable day clock, then pause that clock itself.
	await page.keyboard.press( 'Space' );
	report.clock.running = await page.evaluate( async () => {
		const cycle = window.__PONLAI__.dayCycle;
		cycle.dayLength = 120;
		cycle.paused = false;
		const start = performance.now(), hour = cycle.hour, keyDir = window.__PONLAI__.sky.keyDir.toArray(), samples = [];
		while ( performance.now() - start < 3000 ) {
			await new Promise( ( resolve ) => setTimeout( resolve, 200 ) );
			samples.push( { elapsed: ( performance.now() - start ) / 1000, hour: cycle.hour, keyDir: window.__PONLAI__.sky.keyDir.toArray() } );
		}
		cycle.paused = true;
		return { startHour: hour, endHour: cycle.hour, startKeyDir: keyDir, wallSeconds: ( performance.now() - start ) / 1000, samples };
	} );
	const advance = report.clock.running.endHour - report.clock.running.startHour;
	assert.ok( advance > 0.25 && advance < 0.9, `A 120-second day must advance continuously over three seconds; received ${ advance } hours` );
	const finalKeyDir = report.clock.running.samples.at( - 1 ).keyDir;
	assert.ok( Math.hypot( ...finalKeyDir.map( ( value, index ) => value - report.clock.running.startKeyDir[ index ] ) ) > 0.001, 'The running clock must actually move scene lighting' );
	for ( let i = 1; i < report.clock.running.samples.length; i ++ ) assert.ok( report.clock.running.samples[ i ].hour >= report.clock.running.samples[ i - 1 ].hour, 'Day clock must not reverse between polls' );
	report.clock.paused = await page.evaluate( async () => {
		const cycle = window.__PONLAI__.dayCycle, before = cycle.hour;
		const samples = [];
		for ( let i = 0; i < 6; i ++ ) {
			await new Promise( ( resolve ) => setTimeout( resolve, 150 ) );
			samples.push( cycle.hour );
		}
		return { before, samples };
	} );
	for ( const hour of report.clock.paused.samples ) near( hour, report.clock.paused.before, 1e-10, 'Paused day clock' );
	// Pause the scene again before the explicit refresh. While it runs, the clouds keep drifting
	// and the sky rebakes on its own cadence; the snapshot's two readbacks take a second or more
	// each under load, so one of those live bakes could start between them and leave the CPU
	// irradiance (diagnostic only during a live transition) behind the blended GPU value. With
	// the scene paused the explicit bake is the last one, as the coherence check assumes.
	await page.keyboard.press( 'Space' );
	await twoFrames();
	await page.evaluate( () => window.__PONLAI__.refreshEnvironment() );
	validateState( await snapshot(), 'paused live clock' );
	report.checks.push( 'Accelerated live clock advances monotonically and freezes while the scene keeps rendering' );
	assert.deepEqual( report.errors, [], 'No browser or GPU validation errors' );
	assert.deepEqual( report.failures, [], 'No failed asset requests' );
	report.passed = true;
	console.log( `Dynamic sky: ${ report.checks.length } checks passed. Evidence: ${ out }/report.json` );
} catch ( error ) {
	report.passed = false;
	report.fatal = error.stack || String( error );
	console.error( report.fatal );
	process.exitCode = 1;
} finally {
	await writeFile( `${ out }/report.json`, JSON.stringify( report, null, 2 ) + '\n' );
	await browser.close();
}
