// Fixed-camera A/B evidence for the integrated wet surfaces, impact rings and rain streaks.
// Uses one WebGPU page; coordinate with other GPU probes/benchmarks before running:
//   node tools/verify-weather-effects.mjs http://127.0.0.1:5190
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { acquireGpuLock } from './gpu-lock.mjs';

const base = process.argv[ 2 ] || 'http://127.0.0.1:5190';
const out = 'artifacts/verification/weather-effects';
const report = { base, time: 12, hour: 16, weather: 'rain', captures: {}, comparisons: {}, quality: {}, checks: [], errors: [], warnings: [], failures: [] };
const regions = {
	overview: {
		meadow: [ 0.28708, 0.25505, 0.66388, 0.59511 ], cliff: [ 0.19139, 0.63762, 0.65789, 0.83953 ],
		'shallow-water': [ 0.01196, 0.46759, 0.13158, 0.7864 ], 'foreground-sea': [ 0.02, 0.88, 0.98, 0.985 ],
	},
	horizon: {
		island: [ 0.38, 0.40, 0.66, 0.58 ], 'distant-sea': [ 0.05, 0.34, 0.95, 0.395 ],
		'foreground-sea': [ 0.05, 0.64, 0.95, 0.94 ], sky: [ 0.02, 0.02, 0.98, 0.23 ],
	},
	'near-water': { 'resolved-water': [ 0.05, 0.15, 0.95, 0.85 ] },
};
const scenarios = [
	{ name: 'dry', wetness: false, rain: false, count: 32768 },
	{ name: 'wet', wetness: true, rain: false, count: 32768 },
	{ name: 'ripples', wetness: true, rain: true, count: 0 },
	{ name: 'rain', wetness: true, rain: true, count: 32768 },
];
await mkdir( out, { recursive: true } );
// shared with other probes (their pixels do not depend on the GPU load), never during a timing
// run (tools/gpu-lock.mjs; released when the process exits)
await acquireGpuLock( 'verify-weather-effects', { shared: true } );
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
	const frames = () => page.evaluate( () => new Promise( ( resolve ) => requestAnimationFrame( () => requestAnimationFrame( resolve ) ) ) );
	const load = async ( quality ) => {
		const url = new URL( base );
		url.search = '';
		for ( const [ key, value ] of Object.entries( { debug: '', paused: '', hour: '16', t: '12', dpr: '1', weather: 'rain', quality, dist: '58', polar: '50', az: '318' } ) ) url.searchParams.set( key, value );
		await page.goto( url.href );
		await page.waitForFunction( () => {
			const s = window.__PONLAI__, loading = document.getElementById( 'loading' );
			return s?.rain && s.weatherEffects && s.shared.wetness && ! s.sky.busy && ! s.sky.transitioning &&
				window.__THREE_GAME_DIAGNOSTICS__?.frame > 80 && loading?.classList.contains( 'done' ) &&
				Number( getComputedStyle( loading ).opacity ) === 0;
		} );
		await page.evaluate( () => {
			const s = window.__PONLAI__;
			s.dayCycle.paused = true;
			s.dayCycle.advanceMoonPhase = false;
			s.controls.enableDamping = false;
		} );
		await frames();
	};
	const snapshot = () => page.evaluate( () => {
		const s = window.__PONLAI__;
		return {
			time: s.shared.time.value, hour: s.dayCycle.hour, paused: s.dayCycle.paused,
			weather: s.weather.snapshot(), target: s.weather.target, effects: { ...s.weatherEffects },
			rain: s.shared.rain.value, wetness: s.shared.wetness.value,
			streaks: { amount: s.rain.uniforms.rain.value, count: s.rain.mesh.count, visible: s.rain.mesh.visible, time: s.rain.uniforms.time.value },
			key: s.sky.keyColor.toArray(), ambient: s.sky.skyIrradiance.toArray(), haze: s.pipeline.air.haze.value,
			windPhase: s.shared.wind.phase.value, oceanGain: s.fft.weatherGain.value.toArray(),
			transmission: s.shared.sunIntoWater.value, exposure: s.pipeline.settings.exposure,
			camera: { position: s.camera.position.toArray(), target: s.controls.target.toArray(), fov: s.camera.fov },
			memory: { ...s.renderer.info.memory }, diagnostics: { ...window.__THREE_GAME_DIAGNOSTICS__ },
		};
	} );
	const setCamera = async ( view ) => {
		await page.evaluate( ( view ) => {
			const s = window.__PONLAI__, horizon = view === 'horizon';
			s.controls.minDistance = view === 'near-water' ? 2 : 22;
			if ( view === 'near-water' ) {
				// Resolve the small impact rings in front of the southern shoreline (8 m past the
				// land's box). At the overview/horizon distance their footprint filter intentionally
				// removes them.
				const { centroid, bounds } = s.land;
				s.controls.target.set( centroid.x, 0, bounds.z1 + 8 );
				s.camera.position.set( centroid.x - 6, 4.5, bounds.z1 + 15 );
			} else {
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
	const setEffects = async ( state ) => {
		await page.evaluate( ( state ) => {
			const s = window.__PONLAI__;
			s.weatherEffects.rain = state.rain;
			s.weatherEffects.wetness = state.wetness;
			s.rain.setQuality( state.count );
		}, state );
		await frames();
	};
	const capture = async ( name ) => {
		const paths = [ `${ out }/${ name }-a.png`, `${ out }/${ name }-b.png` ];
		await frames();
		const a = await page.screenshot( { path: paths[ 0 ] } );
		await frames();
		const b = await page.screenshot( { path: paths[ 1 ] } );
		const result = { paths, byteStable: a.equals( b ), ...await snapshot() };
		report.captures[ name ] = result;
		assert.ok( result.byteStable, `${ name }: two paused frames must be byte-identical` );
		assert.equal( result.time, 12, `${ name }: frozen wave/vegetation clock` );
		assert.equal( result.streaks.time, 12, `${ name }: frozen precipitation clock` );
		assert.ok( result.paused && Object.values( result.weather ).every( Number.isFinite ), `${ name }: finite paused weather` );
		assert.ok( result.transmission >= 0 && result.transmission <= 1 && result.exposure > 0, `${ name }: bounded water transmission/exposure` );
		assert.ok( [ ...result.key, ...result.ambient ].every( ( value ) => Number.isFinite( value ) && value >= 0 ), `${ name }: finite lighting` );
		return result;
	};
	const compare = async ( before, after, view ) => {
		const pngs = await Promise.all( [ before.paths[ 0 ], after.paths[ 0 ] ].map( async ( path ) => ( await readFile( path ) ).toString( 'base64' ) ) );
		return page.evaluate( async ( { pngs, crops } ) => {
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
			const [ a, b ] = images, result = {};
			if ( a.width !== b.width || a.height !== b.height ) throw new Error( 'A/B capture dimensions differ' );
			for ( const [ name, fractions ] of Object.entries( { full: [ 0, 0, 1, 1 ], ...crops } ) ) {
				const bounds = fractions.map( ( value, i ) => Math.round( value * ( i % 2 === 0 ? a.width : a.height ) ) );
				const [ x0, y0, x1, y1 ] = bounds, sums = [ 0, 0 ], squares = [ 0, 0 ], clipped = [ 0, 0 ];
				let pixels = 0, rgb = 0, luma = 0, changed = 0, maximum = 0;
				for ( let y = y0; y < y1; y ++ ) for ( let x = x0; x < x1; x ++ ) {
					const i = ( y * a.width + x ) * 4;
					const ys = images.map( ( im ) => im.data[ i ] * 0.2126 + im.data[ i + 1 ] * 0.7152 + im.data[ i + 2 ] * 0.0722 );
					let difference = 0;
					for ( let c = 0; c < 3; c ++ ) {
						const delta = Math.abs( b.data[ i + c ] - a.data[ i + c ] );
						rgb += delta;
						difference = Math.max( difference, delta );
					}
					for ( let k = 0; k < 2; k ++ ) { sums[ k ] += ys[ k ]; squares[ k ] += ys[ k ] ** 2; if ( ys[ k ] >= 245 ) clipped[ k ] ++; }
					luma += Math.abs( ys[ 1 ] - ys[ 0 ] );
					if ( difference > 1 ) changed ++;
					maximum = Math.max( maximum, difference );
					pixels ++;
				}
				result[ name ] = { bounds, pixels, meanAbsolutePixelDifference: rgb / ( pixels * 3 ), meanAbsoluteLumaDifference: luma / pixels,
					changedPixelsAboveOne: changed, changedFractionAboveOne: changed / pixels, maximumChannelDifference: maximum,
					before: { lumaMean: sums[ 0 ] / pixels, lumaStdDev: Math.sqrt( Math.max( 0, squares[ 0 ] / pixels - ( sums[ 0 ] / pixels ) ** 2 ) ), clippedFraction: clipped[ 0 ] / pixels },
					after: { lumaMean: sums[ 1 ] / pixels, lumaStdDev: Math.sqrt( Math.max( 0, squares[ 1 ] / pixels - ( sums[ 1 ] / pixels ) ** 2 ) ), clippedFraction: clipped[ 1 ] / pixels } };
			}
			return result;
		}, { pngs, crops: regions[ view ] } );
	};
	// Read the opaque pass's resolved HDR colour (the copy the water reads, taken before the sea
	// and the rain are drawn over it), using its actual depth to classify surfaces. This
	// separates material preservation below the tide from legitimate changes in water SSR.
	const opaqueProbe = async ( mode ) => page.evaluate( async ( mode ) => {
		const s = window.__PONLAI__, rt = s.pipeline.opaqueRT, depthRT = s.pipeline.depthRT;
		// Three's WebGPU readback returns the mapped buffer without removing its 256-byte
		// row alignment; the last row alone has no tail padding. Colour and RG32F depth
		// require different strides. Compact each one before indexing screen pixels.
		const compactRows = ( storage, width, height, channels ) => {
			const tightElements = width * channels, bytes = storage.BYTES_PER_ELEMENT;
			const rowBytes = Math.ceil( tightElements * bytes / 256 ) * 256, rowElements = rowBytes / bytes;
			const tightCount = tightElements * height;
			if ( storage.length === tightCount ) return storage;
			if ( storage.length !== rowElements * ( height - 1 ) + tightElements ) throw new Error( 'Unexpected WebGPU readback row layout' );
			const packed = new storage.constructor( tightCount );
			for ( let y = 0; y < height; y ++ ) packed.set( storage.subarray( y * rowElements, y * rowElements + tightElements ), y * tightElements );
			return packed;
		};
		const half = ( bits ) => {
			const sign = bits & 0x8000 ? - 1 : 1, exponent = bits >> 10 & 31, fraction = bits & 1023;
			return exponent === 0 ? sign * 2 ** - 14 * fraction / 1024 : exponent === 31 ? ( fraction ? NaN : sign * Infinity ) : sign * 2 ** ( exponent - 15 ) * ( 1 + fraction / 1024 );
		};
		const storage = await s.renderer.readRenderTargetPixelsAsync( rt, 0, 0, rt.width, rt.height );
		if ( ! ( storage instanceof Uint16Array || storage instanceof Float32Array ) ) throw new Error( 'Unsupported opaque HDR readback' );
		const packedColor = compactRows( storage, rt.width, rt.height, 4 );
		const color = packedColor instanceof Uint16Array ? Float32Array.from( packedColor, half ) : packedColor;
		const depthStorage = await s.renderer.readRenderTargetPixelsAsync( depthRT, 0, 0, depthRT.width, depthRT.height );
		if ( ! ( depthStorage instanceof Float32Array ) ) throw new Error( 'Expected RG32F linear-depth readback' );
		// sample 0's view z (the farthest sample's in the second channel)
		const depth = compactRows( depthStorage, depthRT.width, depthRT.height, 2 ).filter( ( _, i ) => i % 2 === 0 );
		const readback = { width: rt.width, height: rt.height, colorBytes: storage.byteLength, depthBytes: depthStorage.byteLength,
			colorRowBytes: Math.ceil( rt.width * 4 * storage.BYTES_PER_ELEMENT / 256 ) * 256,
			depthRowBytes: Math.ceil( depthRT.width * 2 * depthStorage.BYTES_PER_ELEMENT / 256 ) * 256 };
		if ( mode === 'before' ) {
			window.__weatherEffectsProbe = { color, depth, width: rt.width, height: rt.height };
			return null;
		}
		const previous = window.__weatherEffectsProbe;
		delete window.__weatherEffectsProbe;
		if ( ! previous || previous.width !== rt.width || previous.height !== rt.height ) throw new Error( 'Opaque probe dimensions changed' );
		const p = s.camera.projectionMatrixInverse.elements, m = s.camera.matrixWorld.elements;
		const width = rt.width, height = rt.height, wl = s.shared.waterLevel.value;
		const result = { readback, dry: { pixels: 0, sum: 0, maximum: 0 }, tidal: { pixels: 0, sum: 0, maximum: 0 }, submerged: { pixels: 0, sum: 0, maximum: 0 }, finite: true, changedDepthPixels: 0, movedBelowPlateau: 0 };
		for ( let y = 1; y < height - 1; y ++ ) for ( let x = 1; x < width - 1; x ++ ) {
			const pixel = y * width + x, z = depth[ pixel ];
			if ( z !== previous.depth[ pixel ] ) result.changedDepthPixels ++;
			if ( z < - 200 || z >= 0 || ! Number.isFinite( z ) ) continue;
			// Avoid MSAA silhouette mixtures and reject sky/edge depths before classifying heights.
			if ( [ pixel - 1, pixel + 1, pixel - width, pixel + width ].some( ( i ) => Math.abs( depth[ i ] - z ) > 0.08 ) ) continue;
			const nx = ( x + 0.5 ) / width * 2 - 1, ny = 1 - ( y + 0.5 ) / height * 2;
			const vx = p[ 0 ] * nx + p[ 4 ] * ny + p[ 8 ] * 0.5 + p[ 12 ];
			const vy = p[ 1 ] * nx + p[ 5 ] * ny + p[ 9 ] * 0.5 + p[ 13 ];
			const vz = p[ 2 ] * nx + p[ 6 ] * ny + p[ 10 ] * 0.5 + p[ 14 ], scale = z / vz;
			const worldY = m[ 1 ] * vx * scale + m[ 5 ] * vy * scale + m[ 9 ] * z + m[ 13 ] - wl;
			// Standing water shortens meadow blades on the island top; the tide band and below must not move.
			// A shortened blade may uncover cliff or sea behind it; count only pixels that showed
			// low geometry before as well.
			const before = previous.depth[ pixel ], beforeScale = before / vz;
			const beforeY = m[ 1 ] * vx * beforeScale + m[ 5 ] * vy * beforeScale + m[ 9 ] * before + m[ 13 ] - wl;
			if ( z !== before && worldY < 1.25 && beforeY < 1.25 ) result.movedBelowPlateau ++;
			const key = worldY > 1.25 ? 'dry' : worldY > - 0.15 && worldY < 0.3 ? 'tidal' : worldY < - 0.3 && worldY > - 6 ? 'submerged' : null;
			if ( ! key ) continue;
			const metric = result[ key ];
			metric.pixels ++;
			for ( let c = 0; c < 3; c ++ ) {
				const a = previous.color[ pixel * 4 + c ], b = color[ pixel * 4 + c ], difference = Math.abs( b - a );
				result.finite &&= Number.isFinite( a ) && Number.isFinite( b ) && a >= 0 && b >= 0;
				metric.sum += difference;
				metric.maximum = Math.max( metric.maximum, difference );
			}
		}
		for ( const key of [ 'dry', 'tidal', 'submerged' ] ) {
			result[ key ].meanAbsoluteRadianceDifference = result[ key ].sum / Math.max( 1, result[ key ].pixels * 3 );
			delete result[ key ].sum;
		}
		return result;
	}, mode );

	await load( 'medium' );
	report.quality.medium = await snapshot();
	assert.ok( report.quality.medium.weather.wetness > 0.2, 'Established rain URL must provide wet surfaces before a paused A/B' );
	for ( const view of [ 'overview', 'horizon' ] ) {
		await setCamera( view );
		for ( const state of scenarios ) {
			await setEffects( state );
			const shot = await capture( `${ view }-${ state.name }` );
			assert.equal( shot.streaks.count, state.count, 'Requested precipitation geometry budget' );
			assert.equal( shot.rain, state.rain ? shot.weather.rain : 0, 'Effects toggle reaches ripple uniform' );
			assert.equal( shot.streaks.amount, shot.rain, 'Streak amount follows the same rain state' );
			assert.equal( shot.wetness, state.wetness ? shot.weather.wetness : 0, 'Wetness toggle reaches material uniform' );
			assert.equal( shot.streaks.visible, state.rain && state.count > 0, 'Zero streak instances preserve ripples without a rain draw' );
			if ( view === 'overview' && state.name === 'dry' ) await opaqueProbe( 'before' );
			if ( view === 'overview' && state.name === 'wet' ) report.opaqueWetness = await opaqueProbe( 'after' );
		}
		const shots = Object.fromEntries( scenarios.map( ( state ) => [ state.name, report.captures[ `${ view }-${ state.name }` ] ] ) );
		for ( const [ effect, before, after ] of [ [ 'wetness', 'dry', 'wet' ], [ 'ripples', 'wet', 'ripples' ], [ 'streaks', 'ripples', 'rain' ], [ 'combined', 'dry', 'rain' ] ] ) {
			for ( const key of [ 'weather', 'key', 'ambient', 'haze', 'windPhase', 'oceanGain', 'camera' ] ) assert.deepEqual( shots[ before ][ key ], shots[ after ][ key ], `${ effect }: fixed ${ key }` );
			report.comparisons[ `${ view }-${ effect }` ] = await compare( shots[ before ], shots[ after ], view );
		}
	}
	await setCamera( 'near-water' );
	await setEffects( scenarios[ 1 ] );
	const nearWaterOff = await capture( 'near-water-wet' );
	await setEffects( scenarios[ 2 ] );
	const nearWaterOn = await capture( 'near-water-ripples' );
	for ( const key of [ 'weather', 'key', 'ambient', 'haze', 'windPhase', 'oceanGain', 'camera' ] ) assert.deepEqual( nearWaterOff[ key ], nearWaterOn[ key ], `Near-water ripples: fixed ${ key }` );
	report.comparisons[ 'near-water-ripples' ] = await compare( nearWaterOff, nearWaterOn, 'near-water' );
	const opaque = report.opaqueWetness;
	assert.ok( opaque.finite && opaque.dry.pixels > 100 && opaque.tidal.pixels > 100 && opaque.submerged.pixels > 100, 'Depth-classified terrain samples must contain finite dry, tidal and submerged radiance' );
	assert.equal( opaque.movedBelowPlateau, 0, 'Wetness may only shorten meadow blades; cliffs, tide and seabed must not move' );
	assert.ok( opaque.dry.meanAbsoluteRadianceDifference > 1e-6, 'Wetness must reach actual above-tide material pixels' );
	for ( const band of [ 'tidal', 'submerged' ] ) assert.ok( opaque[ band ].meanAbsoluteRadianceDifference < 1e-5,
		`Rain wetness must preserve existing ${ band } material radiance` );
	const wet = report.comparisons[ 'overview-wetness' ];
	assert.ok( wet.cliff.meanAbsolutePixelDifference > 0.02, 'Wet mineral response must be visible in the exposed-cliff crop' );
	let streakPixels = 0;
	for ( const view of [ 'overview', 'horizon' ] ) {
		const streaks = report.comparisons[ `${ view }-streaks` ];
		streakPixels += streaks.full.changedPixelsAboveOne;
		assert.ok( streaks.full.changedFractionAboveOne < 0.2, 'Rain streaks must remain spatially sparse rather than covering the image' );
		for ( const [ name, metric ] of Object.entries( report.comparisons[ `${ view }-combined` ] ) ) {
			assert.ok( metric.after.lumaMean >= metric.before.lumaMean * 0.45 && metric.after.lumaMean <= metric.before.lumaMean * 1.4 + 1,
				`${ view } ${ name }: weather effects must retain scene brightness/readability` );
			assert.ok( metric.after.lumaStdDev >= metric.before.lumaStdDev * 0.55, `${ view } ${ name }: retain local tonal variation` );
			assert.ok( metric.after.clippedFraction <= metric.before.clippedFraction + 0.01, `${ view } ${ name }: no broad white clipping` );
		}
	}
	assert.ok( report.comparisons[ 'near-water-ripples' ][ 'resolved-water' ].changedPixelsAboveOne > 10,
		'Impact rings must alter resolved near-water pixels with streak geometry disabled' );
	assert.ok( streakPixels > 10, 'Restoring streak geometry must alter actual pixels independently of rings' );
	report.checks.push( 'Frozen rain/wetness/ripple A/B captures are byte-stable, with unchanged sky, wind, time and camera' );
	report.checks.push( 'Actual opaque HDR readback changes above-tide surfaces while preserving tidal and submerged material pixels' );
	report.checks.push( 'Isolated water rings and sparse rain streaks affect rendered pixels without flattening or whitening the scene' );

	await page.evaluate( () => window.__PONLAI__.setHour( 0 ) );
	await setCamera( 'overview' );
	await setEffects( scenarios[ 2 ] );
	const nightOff = await capture( 'night-ripples' );
	await setEffects( scenarios[ 3 ] );
	const nightOn = await capture( 'night-rain' );
	report.comparisons[ 'night-streaks' ] = await compare( nightOff, nightOn, 'overview' );
	report.comparisons[ 'day-night' ] = await compare( report.captures[ 'overview-rain' ], nightOn, 'overview' );
	assert.ok( report.comparisons[ 'day-night' ].full.after.lumaMean < report.comparisons[ 'day-night' ].full.before.lumaMean * 0.65,
		'Night rain must remain visibly darker than afternoon rain' );
	assert.ok( report.comparisons[ 'night-streaks' ].full.after.clippedFraction <= report.comparisons[ 'night-streaks' ].full.before.clippedFraction + 0.001,
		'Night rain must not introduce glowing white streaks' );
	report.checks.push( 'Rain follows the night lighting and retains a darker, unclipped image' );

	// Load each real application quality preset in the same page. These are integration
	// checks of actual instance counts, rather than a duplicate of the profile calculation.
	for ( const quality of [ 'low', 'high' ] ) {
		await load( quality );
		report.quality[ quality ] = await capture( `quality-${ quality }` );
	}
	for ( const [ quality, count ] of Object.entries( { low: 16384, medium: 32768, high: 49152 } ) ) {
		assert.equal( report.quality[ quality ].diagnostics.quality, quality, 'Requested quality preset is active' );
		assert.equal( report.quality[ quality ].streaks.count, count, `${ quality }: actual bounded rain instance count` );
	}
	const resources = Object.values( report.captures ).filter( ( shot ) => shot.diagnostics.quality === 'medium' ).map( ( shot ) => shot.memory );
	assert.ok( Math.max( ...resources.map( ( state ) => state.textures ) ) - Math.min( ...resources.map( ( state ) => state.textures ) ) <= 4,
		'Effects toggles must not accumulate textures after first use' );
	report.checks.push( 'Low/medium/high application presets simulate 16384/32768/49152 drops; effect toggles keep texture use bounded' );
	assert.deepEqual( report.errors, [], 'No GPU/browser errors' );
	assert.deepEqual( report.failures, [], 'No failed asset requests' );
	report.passed = true;
	console.log( `Weather effects: ${ report.checks.length } checks passed. ${ out }/report.json` );
} catch ( error ) {
	report.passed = false;
	report.fatal = error.stack || String( error );
	console.error( report.fatal );
	process.exitCode = 1;
} finally {
	await writeFile( `${ out }/report.json`, JSON.stringify( report, null, 2 ) + '\n' );
	await browser.close();
}
