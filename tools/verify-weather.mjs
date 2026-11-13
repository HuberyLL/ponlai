// Integrated weather evidence and contracts. CPU transition tests remain in verify-weather-state.
// Run against the completed weather debug API, one WebGPU page at a time:
//   node tools/verify-weather.mjs http://127.0.0.1:5190 [--coupling]
// Its rain preset and the rain parts are parked with the rain (packages/render/sky/Weather.ts PARKED_WEATHER):
// out of the default checks until the parked weathers are revived; it still runs on a debug build.
// Its steps wait for the page's rendered frames (tools/page-eval.mjs, "Rendered frames").
// Overcast's direct light is checked on the key's floor under its closed deck (packages/render/sky/Sky.ts
// `deckKeyFloor`), only for holding back a share of the clear day's key: the floor's level is a
// tune (look/SkyLook.ts `keyThroughCloud`), so the bound stays clear of it.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { acquireGpuLock } from './gpu-lock.mjs';
import './island-look.mjs';
import { DAY_PRESETS } from '../packages/render/sky/DayCycle.ts';
import { renderedFrames } from './page-eval.mjs';

const base = process.argv.slice( 2 ).find( ( arg ) => ! arg.startsWith( '--' ) ) || 'http://127.0.0.1:5190';
const coupling = process.argv.includes( '--coupling' );
const out = `artifacts/verification/weather${ coupling ? '-coupling' : '' }`;
const presets = [ 'clear', 'fair', 'cloudy', 'overcast', 'rain' ];
const report = { base, coupling, presets: [], transition: {}, resources: {}, checks: [], errors: [], warnings: [], failures: [] };
const near = ( a, b, tolerance, label ) => assert.ok( Math.abs( a - b ) <= tolerance, `${ label }: ${ a } vs ${ b }` );
const luma = ( rgb ) => rgb[ 0 ] * 0.2126 + rgb[ 1 ] * 0.7152 + rgb[ 2 ] * 0.0722;
const same = ( a, b, label ) => a.forEach( ( value, i ) => near( value, b[ i ], 1e-6, `${ label }[${ i }]` ) );
await mkdir( out, { recursive: true } );
// shared with other probes (their pixels do not depend on the GPU load), never during a timing
// run (tools/gpu-lock.mjs; released when the process exits)
await acquireGpuLock( 'verify-weather', { shared: true } );
const browser = await chromium.launch( {
	headless: true,
	...( process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' } ),
	args: [ '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit' ],
} );

try {
	const page = await browser.newPage( { viewport: { width: 1672, height: 941 }, deviceScaleFactor: 1 } );
	page.setDefaultTimeout( 90000 );
	page.on( 'pageerror', ( error ) => report.errors.push( `pageerror: ${ error.message }` ) );
	page.on( 'console', ( message ) => {
		if ( message.type() === 'error' ) report.errors.push( message.text() );
		if ( message.type() === 'warning' ) report.warnings.push( message.text() );
	} );
	page.on( 'response', ( response ) => { if ( response.status() >= 400 ) report.failures.push( `${ response.status() } ${ response.url() }` ); } );
	page.on( 'requestfailed', ( request ) => report.failures.push( `${ request.failure()?.errorText } ${ request.url() }` ) );
	const url = new URL( base );
	for ( const [ key, value ] of Object.entries( { debug: '', paused: '', preset: 'golden-hour', t: '12', dpr: '1', weather: 'clear', dist: '58', polar: '50', az: '318' } ) ) url.searchParams.set( key, value );
	await page.goto( url.href );
	await page.waitForFunction( () => window.__PONLAI__?.weather && typeof window.__PONLAI__.setWeather === 'function' &&
		window.__PONLAI__.pipeline.air && window.__THREE_GAME_DIAGNOSTICS__?.frame > 60 &&
		document.getElementById( 'loading' )?.classList.contains( 'done' ) );
	await page.evaluate( async () => {
		const s = window.__PONLAI__;
		s.dayCycle.paused = true;
		s.dayCycle.moonPhase = 0.5;
		s.dayCycle.advanceMoonPhase = false;
		s.controls.enableDamping = false;
		await s.setPreset( 'golden-hour' );
	} );
	// two of the page's rendered frames (tools/page-eval.mjs, "Rendered frames")
	const frames = () => renderedFrames( page, 2 );
	const camera = async ( view ) => {
		await page.evaluate( ( view ) => {
			const s = window.__PONLAI__;
			if ( view === 'clouds' ) {
				const elevation = 25 * Math.PI / 180, azimuth = - 30 * Math.PI / 180;
				s.controls.maxPolarAngle = Math.PI;
				s.camera.position.set( s.land.centroid.x, 8, s.land.centroid.z );
				s.controls.target.set( s.land.centroid.x + Math.cos( elevation ) * Math.cos( azimuth ) * 100,
					8 + Math.sin( elevation ) * 100, s.land.centroid.z + Math.cos( elevation ) * Math.sin( azimuth ) * 100 );
			} else {
				const horizon = view === 'horizon';
				s.controls.maxPolarAngle = 82 * Math.PI / 180;
				// the page's island and horizon views on its land
				s.controls.target.fromArray( s.land.target );
				s.camera.position.setFromSphericalCoords( ( horizon ? 110 : 58 ) * s.land.scale,
					( horizon ? 82 : 50 ) * Math.PI / 180, ( horizon ? 125 : 318 ) * Math.PI / 180 ).add( s.controls.target );
			}
			s.controls.update();
			s.camera.updateMatrixWorld();
		}, view );
		await frames();
	};
	const screenshots = async ( name, views = [ 'overview', 'horizon', 'clouds' ] ) => {
		const result = {};
		for ( const view of views ) {
			await camera( view );
			result[ view ] = [];
			for ( const frame of [ 'a', 'b' ] ) {
				await frames();
				const path = `${ out }/${ name }-${ view }-${ frame }.png`;
				await page.screenshot( { path } );
				result[ view ].push( path );
			}
		}
		return result;
	};
	const cropDifferences = async ( before, after, regions ) => {
		const pngs = await Promise.all( [ before, after ].map( async ( path ) => ( await readFile( path ) ).toString( 'base64' ) ) );
		return page.evaluate( async ( { pngs, regions } ) => {
			// Decode the captured files at their original size. Detached 2D canvases only read
			// pixels for measurement; the PNG evidence is never resized, recoloured or rewritten.
			const images = await Promise.all( pngs.map( async ( png ) => {
				const image = new Image();
				image.src = `data:image/png;base64,${ png }`;
				await image.decode();
				const canvas = document.createElement( 'canvas' );
				canvas.width = image.naturalWidth;
				canvas.height = image.naturalHeight;
				const context = canvas.getContext( '2d', { willReadFrequently: true, colorSpace: 'srgb' } );
				context.drawImage( image, 0, 0 );
				return context.getImageData( 0, 0, canvas.width, canvas.height );
			} ) );
			const [ a, b ] = images;
			if ( a.width !== b.width || a.height !== b.height ) throw new Error( 'Fog capture dimensions changed' );
			const result = {};
			for ( const [ name, fractions ] of Object.entries( regions ) ) {
				const bounds = fractions.map( ( value, i ) => Math.round( value * ( i % 2 === 0 ? a.width : a.height ) ) );
				const [ x0, y0, x1, y1 ] = bounds;
				let rgb = 0, luma = 0, pixels = 0, maximum = 0;
				for ( let y = y0; y < y1; y ++ ) for ( let x = x0; x < x1; x ++ ) {
					const i = ( y * a.width + x ) * 4;
					const dr = b.data[ i ] - a.data[ i ], dg = b.data[ i + 1 ] - a.data[ i + 1 ], db = b.data[ i + 2 ] - a.data[ i + 2 ];
					rgb += Math.abs( dr ) + Math.abs( dg ) + Math.abs( db );
					luma += Math.abs( dr * 0.2126 + dg * 0.7152 + db * 0.0722 );
					maximum = Math.max( maximum, Math.abs( dr ), Math.abs( dg ), Math.abs( db ) );
					pixels ++;
				}
				result[ name ] = { bounds, pixels, meanAbsolutePixelDifference: rgb / ( pixels * 3 ),
					meanAbsoluteLumaDifference: luma / pixels, maximumChannelDifference: maximum };
			}
			return result;
		}, { pngs, regions } );
	};
	const snapshot = () => page.evaluate( async ( coupling ) => {
		const s = window.__PONLAI__, sky = s.sky;
		const scalar = ( node ) => node?.value ?? node;
		const pixels = await s.renderer.readRenderTargetPixelsAsync( sky.small, 0, 0, sky.small.width, sky.small.height );
		let minimum = Infinity, maximum = - Infinity, finite = true;
		for ( let i = 0; i < pixels.length; i += 4 ) for ( let c = 0; c < 3; c ++ ) {
			finite &&= Number.isFinite( pixels[ i + c ] );
			minimum = Math.min( minimum, pixels[ i + c ] );
			maximum = Math.max( maximum, pixels[ i + c ] );
		}
		const state = {
			hour: s.dayCycle.hour, clockPaused: s.dayCycle.paused,
			weather: s.weather.snapshot(), target: s.weather.target, progress: s.weather.progress,
			coverage: sky.clouds.coverage.value, density: sky.clouds.density.value,
			keyColor: sky.keyColor.toArray(), keyDir: sky.keyDir.toArray(), deckKeyFloor: sky.deckKeyFloor,
			lightColor: s.sun.color.clone().multiplyScalar( s.sun.intensity ).toArray(),
			sharedColor: s.shared.sunColor.value.toArray(), sharedDir: s.shared.sunDir.value.toArray(),
			skyIrradiance: sky.skyIrradiance.toArray(),
			sunIntoWater: s.shared.sunIntoWater.value, muSun: s.shared.muSun.value,
			displayedHaze: sky.weather.haze, haze: scalar( s.pipeline.air.haze ), hazeAmount: s.hazeKey.amount,
			exposure: s.pipeline.settings.exposure,
			radiance: { finite, minimum, maximum },
			memory: { ...s.renderer.info.memory }, diagnostics: { ...window.__THREE_GAME_DIAGNOSTICS__ },
		};
		if ( coupling ) {
			const wind = s.shared.wind;
			state.coupling = {
				wind: wind ? { direction: wind.direction.value.toArray(), velocity: wind.velocity.value.toArray(),
					breeze: wind.breeze.value, travel: wind.displacement.value.length(), speed: s.wind.speed } : null,
				rain: s.rain ? { amount: s.rain.uniforms.rain.value, wind: s.rain.uniforms.wind.value.toArray(),
					visible: s.rain.mesh.visible, count: s.rain.mesh.count } : null,
				wetness: scalar( s.shared.wetness ?? s.shared.rainWetness ),
				seaWind: s.fft.params.windSpeed, spectrumRevision: s.fft.spectrumRevision,
			};
		}
		return state;
	}, coupling );
	const validate = ( state, label ) => {
		assert.ok( Object.values( state.weather ).every( Number.isFinite ), `${ label }: finite weather` );
		for ( const key of [ 'rain', 'wetness', 'coverage', 'directVisibility' ] ) assert.ok( state.weather[ key ] >= 0 && state.weather[ key ] <= 1, `${ label }: bounded ${ key }` );
		for ( const key of [ 'keyColor', 'lightColor', 'sharedColor', 'skyIrradiance' ] ) assert.ok( state[ key ].every( ( value ) => Number.isFinite( value ) && value >= 0 ), `${ label }: finite non-negative ${ key }` );
		assert.ok( state.radiance.finite && Number.isFinite( state.radiance.minimum ) && Number.isFinite( state.radiance.maximum ) && state.radiance.minimum >= - 1e-7, `${ label }: finite non-negative sky pixels` );
		near( state.coverage, state.weather.coverage, 1e-6, `${ label }: weather drives cloud coverage` );
		near( state.density, state.weather.density, 1e-6, `${ label }: weather drives cloud density` );
		same( state.keyColor, state.lightColor, `${ label }: scene lighting` );
		same( state.keyColor, state.sharedColor, `${ label }: water lighting` );
		same( state.keyDir, state.sharedDir, `${ label }: water light direction` );
		assert.ok( Number.isFinite( state.haze ) && state.haze >= 0, `${ label }: air haze` );
		near( state.displayedHaze, state.weather.haze, 1e-8, `${ label }: displayed weather haze` );
		near( state.haze, state.displayedHaze * state.hazeAmount, 1e-8, `${ label }: pipeline haze is the displayed sky's times the hour's key amount` );
		assert.ok( Number.isFinite( state.exposure ) && state.exposure > 0, `${ label }: exposure` );
		assert.ok( Number.isFinite( state.sunIntoWater ) && state.sunIntoWater >= 0 && state.sunIntoWater <= 1, `${ label }: water transmission` );
		assert.ok( Number.isFinite( state.muSun ) && state.muSun > 0 && state.muSun <= 1, `${ label }: refracted light elevation` );
		if ( coupling ) {
			const linked = state.coupling;
			assert.ok( linked.wind && linked.rain && Number.isFinite( linked.seaWind ), '--coupling requires shared.wind, debug rain and the FFT' );
			near( linked.rain.amount, state.weather.rain, 1e-6, `${ label }: rainfall binding` );
			near( linked.wetness, state.weather.wetness, 1e-6, `${ label }: material wetness binding` );
			same( linked.rain.wind, linked.wind.velocity, `${ label }: rain wind` );
			near( linked.seaWind, linked.wind.speed, 1e-9, `${ label }: ocean wind response` );
			assert.ok( linked.rain.count >= 0 && linked.rain.count <= 49152, `${ label }: bounded rain draw` );
			assert.equal( linked.rain.visible, linked.rain.amount > 0.0001 && linked.rain.count > 0, `${ label }: skip idle rain` );
		}
	};

	for ( const name of presets ) {
		await page.evaluate( ( name ) => window.__PONLAI__.setWeather( name, 0 ), name );
		await frames();
		const state = { name, ...await snapshot(), screenshots: await screenshots( name ) };
		report.presets.push( state );
		validate( state, name );
		near( state.hour, DAY_PRESETS[ 'golden-hour' ], 1e-8, `${ name }: fixed hour` );
		near( state.progress, 1, 1e-8, `${ name }: instant preset completed` );
	}
	const clear = report.presets[ 0 ], overcast = report.presets[ 3 ], rain = report.presets[ 4 ];
	assert.ok( luma( clear.keyColor ) > 1e-5, 'Clear afternoon must have usable direct light' );
	// (overcast's sun reaches the land through the deck alone: its key stays whole, `directVisibility`
	// 1, and this frame's floor under the deck sets the land's direct light, packages/render/sky/Sky.ts
	// `deckKeyFloor`: a share of what the cloud layer passes down, clamped at 1, where the deck would
	// hold back nothing, so 0.95 checks that the deck does hold back a share of it without pinning
	// the tune)
	assert.ok( Number.isFinite( overcast.deckKeyFloor ), 'overcast: the key\'s floor under the deck' );
	assert.ok( luma( overcast.keyColor ) * overcast.deckKeyFloor < luma( clear.keyColor ) * 0.95, 'Overcast must hold back part of the land\'s direct light under its deck' );
	assert.ok( luma( rain.keyColor ) < luma( clear.keyColor ) * 0.4, 'Rain must materially suppress direct light' );
	assert.ok( rain.haze > clear.haze, 'Rain must affect distant air, not only cloud geometry' );
	report.checks.push( 'Five deterministic weather states drive coherent sky, scene/water lighting and air perspective' );

	// Isolate aerial perspective from the already baked rainy sky and lighting. The sky reads
	// the weather state every frame; a paused clock leaves that state alone between frames.
	const savedHaze = await page.evaluate( () => window.__PONLAI__.weather.state.haze );
	report.fog = { hour: DAY_PRESETS[ 'golden-hour' ], weather: 'rain', restoredHaze: savedHaze, units: 'absolute display RGB/luma differences, 0..255' };
	try {
		await page.evaluate( () => { window.__PONLAI__.weather.state.haze = 0; } );
		await frames();
		near( await page.evaluate( () => window.__PONLAI__.pipeline.air.haze.value ), 0, 1e-8, 'Fog-off state reaches the pipeline' );
		report.fog.off = await screenshots( 'fog-off', [ 'overview', 'horizon' ] );
		await page.evaluate( ( haze ) => { window.__PONLAI__.weather.state.haze = haze; }, savedHaze );
		await frames();
		const amount = await page.evaluate( () => window.__PONLAI__.hazeKey.amount );
		near( await page.evaluate( () => window.__PONLAI__.pipeline.air.haze.value ), savedHaze * amount, 1e-8, 'Fog-on state reaches the pipeline (the weather\'s haze times the hour\'s key amount)' );
		report.fog.on = await screenshots( 'fog-on', [ 'overview', 'horizon' ] );
		report.fog.overview = await cropDifferences( report.fog.off.overview[ 0 ], report.fog.on.overview[ 0 ], {
			meadow: [ 0.28708, 0.25505, 0.66388, 0.59511 ], cliff: [ 0.19139, 0.63762, 0.65789, 0.83953 ],
			'shallow-water': [ 0.01196, 0.46759, 0.13158, 0.78640 ],
		} );
		report.fog.horizon = await cropDifferences( report.fog.off.horizon[ 0 ], report.fog.on.horizon[ 0 ], {
			island: [ 0.38, 0.40, 0.66, 0.58 ], 'distant-sea': [ 0.05, 0.34, 0.95, 0.395 ],
			'foreground-sea': [ 0.05, 0.64, 0.95, 0.94 ], horizon: [ 0.02, 0.23, 0.98, 0.33 ],
		} );
		// The haze varies with height alone, so the near island and water take their share of it and
		// their crops are recorded, not asserted (the rain's own checks return with the rain). The far
		// sea's rays run longer through the low air than the foreground sea's, so its change is larger.
		const fogSea = report.fog.horizon;
		assert.ok( fogSea[ 'distant-sea' ].meanAbsolutePixelDifference > 0.05, 'Haze must affect actual distant-sea pixels' );
		assert.ok( fogSea[ 'distant-sea' ].meanAbsolutePixelDifference > fogSea[ 'foreground-sea' ].meanAbsolutePixelDifference,
			'Haze must change the distant sea more than the foreground sea' );
		report.checks.push( 'Fog A/B pixel crops change the distant sea more than the foreground sea' );
	} finally {
		await page.evaluate( ( haze ) => { window.__PONLAI__.weather.state.haze = haze; }, savedHaze );
		await frames();
	}

	await page.evaluate( () => window.__PONLAI__.setHour( 0 ) );
	await frames();
	report.nightRain = { ...await snapshot(), screenshots: await screenshots( 'midnight-rain', [ 'overview', 'horizon' ] ) };
	validate( report.nightRain, 'night rain' );
	assert.ok( luma( report.nightRain.keyColor ) + luma( report.nightRain.skyIrradiance ) <
		( luma( rain.keyColor ) + luma( rain.skyIrradiance ) ) * 0.3, 'Rain at night must remain darker than afternoon rain' );
	report.checks.push( 'Rain remains finite and visibly differentiated between afternoon and night' );

	if ( coupling ) {
		assert.ok( rain.coupling.wind.breeze > clear.coupling.wind.breeze, 'Weather must strengthen vegetation wind' );
		assert.ok( rain.coupling.fftGain.every( ( gain, i ) => gain > clear.coupling.fftGain[ i ] ), 'Weather must change actual wave output' );
		assert.equal( rain.coupling.spectrumRevision, clear.coupling.spectrumRevision, 'Weather must not rebuild the CPU spectrum for each preset' );
		const before = rain.weather.wetness;
		await page.evaluate( async () => { const s = window.__PONLAI__; s.weather.update( 25 ); await s.refreshEnvironment(); } );
		await frames();
		report.soaked = await snapshot();
		validate( report.soaked, 'soaked surfaces' );
		assert.ok( report.soaked.weather.wetness > before, 'Rain must accumulate bound material wetness' );
		await page.evaluate( async () => { const s = window.__PONLAI__; await s.setWeather( 'clear', 0 ); s.weather.update( 60 ); await s.refreshEnvironment(); } );
		await frames();
		report.drying = await snapshot();
		validate( report.drying, 'drying surfaces' );
		assert.ok( report.drying.weather.wetness < report.soaked.weather.wetness && report.drying.weather.wetness > 0, 'Clearing weather must dry gradually' );
		report.checks.push( 'Weather reaches plant/rain wind, FFT amplitude, draw visibility and persistent material moisture' );
	}

	// Resume scene animation, then separately freeze the celestial clock. Weather must keep
	// evolving while the requested afternoon lighting time stays fixed.
	await camera( 'overview' );
	await page.keyboard.press( 'Space' );
	await page.evaluate( async () => { const s = window.__PONLAI__; s.dayCycle.paused = true; await s.setPreset( 'golden-hour' ); await s.setWeather( 'clear', 0 ); } );
	report.transition = await page.evaluate( async () => {
		const s = window.__PONLAI__;
		const take = () => ( { elapsed: performance.now(), hour: s.dayCycle.hour, weather: s.weather.snapshot(),
			progress: s.weather.progress, target: s.weather.target, keyColor: s.sky.keyColor.toArray(), windTravel: s.shared.wind?.displacement.value.length() } );
		await s.setWeather( 'rain', 5 );
		const towardRain = [ take() ];
		while ( performance.now() - towardRain[ 0 ].elapsed < 1600 ) {
			await new Promise( ( resolve ) => setTimeout( resolve, 100 ) );
			towardRain.push( take() );
		}
		const beforeInterrupt = take();
		await s.setWeather( 'clear', 5 );
		const afterInterrupt = take(), towardClear = [ afterInterrupt ];
		while ( s.weather.progress < 1 && performance.now() - afterInterrupt.elapsed < 12000 ) {
			await new Promise( ( resolve ) => setTimeout( resolve, 100 ) );
			towardClear.push( take() );
		}
		return { towardRain, beforeInterrupt, afterInterrupt, towardClear };
	} );
	const transition = report.transition;
	assert.ok( transition.beforeInterrupt.weather.coverage > 0.03 && transition.beforeInterrupt.progress < 1, 'Live rain transition must make partial progress before interruption' );
	for ( const key of [ 'coverage', 'density', 'rain', 'directVisibility', 'windSpeed', 'wetness' ] ) near(
		transition.beforeInterrupt.weather[ key ], transition.afterInterrupt.weather[ key ], 0.03, `Interrupted ${ key } must not jump to a preset` );
	for ( const samples of [ transition.towardRain, transition.towardClear ] ) {
		for ( let i = 0; i < samples.length; i ++ ) {
			const current = samples[ i ];
			near( current.hour, DAY_PRESETS[ 'golden-hour' ], 1e-8, 'Weather transition must respect paused celestial clock' );
			assert.ok( Object.values( current.weather ).every( Number.isFinite ) && current.keyColor.every( ( value ) => Number.isFinite( value ) && value >= 0 ), 'Live state must stay finite' );
			if ( i === 0 ) continue;
			const previous = samples[ i - 1 ], dt = ( current.elapsed - previous.elapsed ) / 1000;
			assert.ok( Math.abs( current.weather.coverage - previous.weather.coverage ) <= 0.38 * dt + 0.03, 'Live cloud coverage must progress continuously' );
			assert.ok( Math.abs( luma( current.keyColor ) - luma( previous.keyColor ) ) <= luma( clear.keyColor ) * ( dt * 0.8 + 0.08 ), 'Displayed direct light must not abruptly switch weather endpoints' );
		}
	}
	assert.ok( luma( transition.towardRain.at( - 1 ).keyColor ) < luma( transition.towardRain[ 0 ].keyColor ) * 0.99, 'The live transition must reach rendered lighting, not only CPU weather state' );
	near( transition.towardClear.at( - 1 ).progress, 1, 1e-8, 'Interrupted transition must finish' );
	near( transition.towardClear.at( - 1 ).weather.coverage, clear.weather.coverage, 1e-6, 'Clear endpoint coverage' );
	if ( coupling ) assert.ok( transition.towardClear.at( - 1 ).windTravel > transition.towardRain[ 0 ].windTravel, 'Wind animation must advance independently of celestial time' );
	await page.keyboard.press( 'Space' );
	await page.evaluate( () => window.__PONLAI__.refreshEnvironment() );
	await frames();
	validate( await snapshot(), 'completed interrupted transition' );
	report.checks.push( 'A live five-second weather transition can be interrupted continuously while the day clock stays paused' );

	for ( const name of [ 'clear', 'rain', 'clear', 'rain' ] ) await page.evaluate( ( name ) => window.__PONLAI__.setWeather( name, 0 ), name );
	await frames();
	report.resources.baseline = await page.evaluate( () => ( { ...window.__PONLAI__.renderer.info.memory } ) );
	report.resources.samples = [];
	for ( let i = 0; i < 12; i ++ ) {
		await page.evaluate( ( name ) => window.__PONLAI__.setWeather( name, 0 ), presets[ i % presets.length ] );
		await frames();
		report.resources.samples.push( await page.evaluate( () => ( { ...window.__PONLAI__.renderer.info.memory } ) ) );
	}
	assert.ok( Math.max( ...report.resources.samples.map( ( item ) => item.textures ) ) <= report.resources.baseline.textures + 4, 'Weather switches must not retain a new texture each time' );
	assert.ok( Math.max( ...report.resources.samples.map( ( item ) => item.geometries ) ) <= report.resources.baseline.geometries + 2, 'Weather switches must not accumulate geometry' );
	report.checks.push( 'Twelve repeated weather changes retain bounded GPU resources' );
	assert.deepEqual( report.errors, [], 'No browser/GPU errors' );
	assert.deepEqual( report.failures, [], 'No failed requests' );
	report.passed = true;
	console.log( `Weather: ${ report.checks.length } checks passed. Evidence: ${ out }/report.json` );
} catch ( error ) {
	report.passed = false;
	report.fatal = error.stack || String( error );
	console.error( report.fatal );
	process.exitCode = 1;
} finally {
	await writeFile( `${ out }/report.json`, JSON.stringify( report, null, 2 ) + '\n' );
	await browser.close();
}
