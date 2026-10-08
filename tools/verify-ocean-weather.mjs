// GPU readback contracts for the weather envelope on the existing FFT/shore outputs.
// Run only when the integrated renderer is idle elsewhere:
//   node tools/verify-ocean-weather.mjs http://127.0.0.1:5190
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { acquireGpuLock } from './gpu-lock.mjs';
import { Wind } from '../src/weather/Wind.ts';
import { WEATHER_PRESETS } from '../src/sky/Weather.ts';

const base = process.argv[ 2 ] || 'http://127.0.0.1:5190';
const out = 'artifacts/verification/ocean-weather.json';
const report = { base, time: 12, errors: [], failures: [] };
const gains = Object.fromEntries( [ 'clear', 'rain' ].map( ( name ) => {
	const state = WEATHER_PRESETS[ name ];
	return [ name, new Wind( undefined, { speed: state.windSpeed, heading: state.windDirection } ).uniforms.oceanGain.value.toArray() ];
} ) );
// one rendering browser at a time on this machine (released when the process exits)
await acquireGpuLock( 'verify-ocean-weather' );
const browser = await chromium.launch( {
	headless: true,
	...( process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' } ),
	args: [ '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit' ],
} );

try {
	const page = await browser.newPage( { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 } );
	page.setDefaultTimeout( 90000 );
	page.on( 'pageerror', ( error ) => report.errors.push( error.message ) );
	page.on( 'console', ( message ) => { if ( message.type() === 'error' ) report.errors.push( message.text() ); } );
	page.on( 'response', ( response ) => { if ( response.status() >= 400 ) report.failures.push( `${ response.status() } ${ response.url() }` ); } );
	page.on( 'requestfailed', ( request ) => report.failures.push( `${ request.failure()?.errorText } ${ request.url() }` ) );
	const url = new URL( base );
	for ( const [ key, value ] of Object.entries( { debug: '', paused: '', t: '12', dpr: '1', hour: '16', weather: 'clear' } ) ) url.searchParams.set( key, value );
	await page.goto( url.href );
	await page.waitForFunction( () => window.__SOOMI__?.fft.weatherGain && ! window.__SOOMI__.sky.busy &&
		! window.__SOOMI__.sky.transitioning && window.__THREE_GAME_DIAGNOSTICS__?.frame > 80 &&
		document.getElementById( 'loading' )?.classList.contains( 'done' ) );
	report.result = await page.evaluate( async ( gains ) => {
		const s = window.__SOOMI__, fft = s.fft, shore = s.shoreWaves, renderer = s.renderer;
		const animation = renderer.getAnimationLoop();
		const originalGain = fft.weatherGain.value.clone(), originalTime = s.shared.time.value;
		const originalTarget = renderer.getRenderTarget();
		const originalRevision = fft.spectrumRevision, originalFieldRevision = shore.fieldRevision;
		// The debug handles deliberately expose the real output targets. Reading them directly
		// avoids a second shader that could accidentally duplicate the implementation under test.
		const outputs = fft.outputs, shoreTargets = shore.targets;
		if ( ! Array.isArray( outputs ) || ! Array.isArray( shoreTargets ) ) throw new Error( 'FFT/shore output targets are unavailable to the GPU probe' );
		const fromHalf = ( bits ) => {
			const sign = bits & 0x8000 ? - 1 : 1, exponent = bits >> 10 & 31, fraction = bits & 1023;
			if ( exponent === 0 ) return sign * 2 ** - 14 * fraction / 1024;
			if ( exponent === 31 ) return fraction ? NaN : sign * Infinity;
			return sign * 2 ** ( exponent - 15 ) * ( 1 + fraction / 1024 );
		};
		const read = async ( target ) => {
			const pixels = await renderer.readRenderTargetPixelsAsync( target, 0, 0, target.width, target.height );
			if ( pixels instanceof Float32Array ) return pixels;
			if ( pixels instanceof Uint16Array ) return Float32Array.from( pixels, fromHalf );
			throw new Error( `Unsupported GPU readback storage: ${ pixels.constructor.name }` );
		};
		const take = async ( name ) => {
			fft.weatherGain.value.fromArray( gains[ name ] );
			fft.update( 0, 12 );
			const before = renderer.info.render.drawCalls;
			shore.update( fft, 12 );
			const shoreDraws = renderer.info.render.drawCalls - before;
			const fields = [];
			for ( const output of outputs ) fields.push( await read( output.rt ) );
			const shoreline = [];
			for ( const target of shoreTargets ) shoreline.push( await read( target ) );
			const beforeCache = renderer.info.render.drawCalls;
			shore.update( fft, 12 );
			return { fields, shoreline, shoreDraws, cachedDraws: renderer.info.render.drawCalls - beforeCache,
				spectrumRevision: fft.spectrumRevision, fieldRevision: shore.fieldRevision };
		};
		const scaling = ( before, after, channels, factor ) => {
			let count = 0, error2 = 0, expected2 = 0, maximum = 0, finite = true;
			for ( let i = 0; i < before.length; i += 4 ) for ( const channel of channels ) {
				const expected = before[ i + channel ] * factor, actual = after[ i + channel ];
				finite &&= Number.isFinite( expected ) && Number.isFinite( actual );
				const error = actual - expected;
				error2 += error * error;
				expected2 += expected * expected;
				maximum = Math.max( maximum, Math.abs( error ) );
				count ++;
			}
			return { factor, finite, count, expectedRMS: Math.sqrt( expected2 / count ),
				rmsError: Math.sqrt( error2 / count ), relativeRMSError: Math.sqrt( error2 / Math.max( expected2, 1e-20 ) ), maximumError: maximum };
		};
		const jacobian = ( displacement, derivatives, moments ) => {
			let maximum = 0, error2 = 0, minimum = Infinity, maxValue = - Infinity, finite = true;
			for ( let i = 0; i < displacement.length; i += 4 ) {
				const expected = ( 1 + derivatives[ i + 2 ] ) * ( 1 + derivatives[ i + 3 ] ) - moments[ i + 3 ] ** 2;
				const actual = displacement[ i + 3 ], error = actual - expected;
				finite &&= Number.isFinite( actual ) && Number.isFinite( expected );
				maximum = Math.max( maximum, Math.abs( error ) );
				error2 += error * error;
				minimum = Math.min( minimum, actual );
				maxValue = Math.max( maxValue, actual );
			}
			return { finite, maximumError: maximum, rmsError: Math.sqrt( error2 / ( displacement.length / 4 ) ), minimum, maximum: maxValue };
		};
		const changed = ( a, b ) => {
			let pixels = 0, maximum = 0, finite = true;
			for ( let i = 0; i < a.length; i += 4 ) {
				let difference = 0;
				for ( let channel = 0; channel < 3; channel ++ ) {
					finite &&= Number.isFinite( a[ i + channel ] ) && Number.isFinite( b[ i + channel ] );
					difference = Math.max( difference, Math.abs( b[ i + channel ] - a[ i + channel ] ) );
				}
				maximum = Math.max( maximum, difference );
				if ( difference > 1e-7 ) pixels ++;
			}
			return { finite, changedPixels: pixels, maximumDifference: maximum };
		};
		await renderer.setAnimationLoop( null );
		try {
			// Prime the frozen cache with a different gain, so both measured presets must draw.
			fft.weatherGain.value.set( 1, 1, 1 );
			fft.update( 0, 12 );
			shore.update( fft, 12 );
			const clear = await take( 'clear' ), rain = await take( 'rain' );
			const cascades = [];
			for ( let c = 0; c < fft.sizes.length; c ++ ) {
				const factor = gains.rain[ c ] / gains.clear[ c ], at = c * 4;
				cascades.push( {
					cascade: c, tile: fft.sizes[ c ], gain: { clear: gains.clear[ c ], rain: gains.rain[ c ] },
					displacement: scaling( clear.fields[ at ], rain.fields[ at ], [ 0, 1, 2 ], factor ),
					derivatives: scaling( clear.fields[ at + 1 ], rain.fields[ at + 1 ], [ 0, 1, 2, 3 ], factor ),
					velocity: scaling( clear.fields[ at + 3 ], rain.fields[ at + 3 ], [ 0, 1, 2 ], factor ),
					slopeMoments: scaling( clear.fields[ at + 2 ], rain.fields[ at + 2 ], [ 0, 1, 2 ], factor * factor ),
					crossDerivative: scaling( clear.fields[ at + 2 ], rain.fields[ at + 2 ], [ 3 ], factor ),
					jacobianClear: jacobian( clear.fields[ at ], clear.fields[ at + 1 ], clear.fields[ at + 2 ] ),
					jacobianRain: jacobian( rain.fields[ at ], rain.fields[ at + 1 ], rain.fields[ at + 2 ] ),
				} );
			}
			return { time: 12, gains, cascades,
				shore: { clearDraws: clear.shoreDraws, rainDraws: rain.shoreDraws, cachedDraws: [ clear.cachedDraws, rain.cachedDraws ],
					fields: clear.shoreline.map( ( field, i ) => changed( field, rain.shoreline[ i ] ) ) },
				spectrumRevision: [ originalRevision, clear.spectrumRevision, rain.spectrumRevision ],
				shoreFieldRevision: [ originalFieldRevision, clear.fieldRevision, rain.fieldRevision ],
				diagnostics: { ...window.__THREE_GAME_DIAGNOSTICS__ },
			};
		} finally {
			fft.weatherGain.value.copy( originalGain );
			fft.update( 0, originalTime );
			shore.update( fft, originalTime );
			renderer.setRenderTarget( originalTarget );
			await renderer.setAnimationLoop( animation );
		}
	}, gains );
	const result = report.result;
	for ( const cascade of result.cascades ) {
		for ( const field of [ 'displacement', 'derivatives', 'velocity', 'slopeMoments', 'crossDerivative' ] ) {
			const metric = cascade[ field ];
			assert.ok( metric.finite && metric.expectedRMS > 1e-10, `Cascade ${ cascade.cascade } ${ field } must contain finite wave energy` );
			// fp16 output quantisation can dominate the smallest moments; compare the actual
			// field's RMS energy instead of dividing individual values near a zero crossing.
			assert.ok( metric.relativeRMSError < 0.006, `Cascade ${ cascade.cascade } ${ field } fails gain scaling: ${ metric.relativeRMSError }` );
		}
		for ( const key of [ 'jacobianClear', 'jacobianRain' ] ) assert.ok( cascade[ key ].finite && cascade[ key ].maximumError < 0.003,
			`Cascade ${ cascade.cascade } ${ key } must be recomputed from the scaled derivatives` );
	}
	assert.ok( result.spectrumRevision.every( ( value ) => value === result.spectrumRevision[ 0 ] ), 'Weather must not regenerate the base spectrum' );
	assert.ok( result.shoreFieldRevision.every( ( value ) => value === result.shoreFieldRevision[ 0 ] ), 'Weather must not rebuild shore geometry/shelter' );
	assert.equal( result.shore.clearDraws, 2, 'Paused gain change must refresh both shoreline outputs' );
	assert.equal( result.shore.rainDraws, 2, 'A second paused gain change must refresh both shoreline outputs' );
	assert.deepEqual( result.shore.cachedDraws, [ 0, 0 ], 'An unchanged frozen state must retain the shoreline cache' );
	for ( const field of result.shore.fields ) assert.ok( field.finite && field.changedPixels > 10 && field.maximumDifference > 1e-7, 'Rain wind must reach actual paused shoreline pixels' );
	assert.deepEqual( report.errors, [], 'No GPU/browser errors' );
	assert.deepEqual( report.failures, [], 'No failed asset requests' );
	report.passed = true;
	console.log( `Ocean weather: coherent FFT gains, moments, Jacobian, frozen shore updates and unchanged spectra passed. ${ out }` );
} catch ( error ) {
	report.passed = false;
	report.fatal = error.stack || String( error );
	console.error( report.fatal );
	process.exitCode = 1;
} finally {
	await mkdir( 'artifacts/verification', { recursive: true } );
	await writeFile( out, JSON.stringify( report, null, 2 ) + '\n' );
	await browser.close();
}
