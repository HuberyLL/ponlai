// Checks that the rendered sun disk, integrated over its pixels, gives the displayed share of the key's light.
//
// It integrates the HDR solar disk as the sky dome draws it, rather than testing its brightness
// coefficient. The disk's integral, less the sky behind it, is the displayed share of the key's
// irradiance (lighting/SunDisc.ts SUN_DISC_RADIANCE, read from the page's tunable) in luminance,
// within 2 %, with the sun at 32, 60 and 70 degrees, and every value is finite and within half
// float's range. Only the luminance: the disk takes the atmosphere's own colour (Atmosphere.ts
// discTransmittance) and the haze laid over the dome, while the key's hue is a white of its own
// (look/SkyLook.ts `keyHue`), so the disk's blue reads 10 - 25 % under the key's. Below 30 degrees
// it is measured and printed but not checked: the disk's transmittance leaves the ozone out and the
// key's takes it in (about 9 % more light at 10 degrees, 2 - 3 % from 32 up), and with the 2 - 4 %
// the dome takes off at every height the disk stands about 4 % over the key's share at 10. Run it
// after a change to the sun's disk, the sky's radiance or the scene's radiance scale
// (packages/render/lighting/Radiometry.ts).
//
// Usage:
//   node tools/render/verify-radiometry.mjs [url]
//
// Options:
//   url   the server (default http://127.0.0.1:5190, the dev server); the page loads with `debug`
//
// Output: the measurements and the page's errors as JSON on stdout, then a line with the disk's
// luminance over the key's share at each elevation; with the radiance scale in
// artifacts/verification/radiometry.json.
//
// GPU lock and browser: takes the GPU lock shared (docs/reference/gpu-lock.md; its pixels do not
// depend on the GPU's load) and opens headless Chrome (CHROME_PATH, else Playwright's Chromium).
//
// Cost: a page load and its first 30 frames, then a render per elevation: seconds.
//
// Exit codes: 0 every check passes; 1 a check failed or the page logged an error (a failed
// assertion is thrown, before the JSON is written).
import '../kit/help.mjs';
import { chromium } from 'playwright';
import { acquireGpuLock } from '../kit/gpu-lock.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { SCENE_RADIANCE_SCALE, SUN_DISPLAY_RADIUS, SUN_PROJECTED_SOLID_ANGLE } from '../../packages/render/lighting/Radiometry.ts';
import { reviewUrl } from '../kit/page-query.mjs';

assert.ok( SUN_PROJECTED_SOLID_ANGLE > 0 );
const errors = [];
// the sun's elevation (degrees) below which the luminance is printed, not checked
const LOW_SUN = 30;
// shared with other probes (their pixels do not depend on the GPU load), never during a timing
// run (tools/kit/gpu-lock.mjs; released when the process exits)
await acquireGpuLock( 'verify-radiometry', { shared: true } );
const browser = await chromium.launch( {
	headless: true,
	...( process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' } ),
	args: [ '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit' ],
} );
try {
	const page = await browser.newPage( { viewport: { width: 1200, height: 800 } } );
	page.on( 'pageerror', e => errors.push( e.message ) );
	page.on( 'console', m => { if ( m.type() === 'error' ) errors.push( m.text() ); } );
	page.on( 'requestfailed', r => errors.push( r.url() ) );
	await page.goto( reviewUrl( `${ process.argv[ 2 ] || 'http://127.0.0.1:5190' }/?debug&paused&t=12&dpr=1` ) );
	await page.waitForFunction( () => window.__PONLAI__?.applySun && window.__THREE_GAME_DIAGNOSTICS__?.frame > 30, null, { timeout: 90000 } );
	const measurements = await page.evaluate( async ( displayRadius ) => {

		const s = window.__PONLAI__, r = s.renderer, sky = s.sky;
		const animation = r.getAnimationLoop(), previous = r.getRenderTarget();
		const original = { elevation: sky.elevation, illuminance: sky.sunIlluminance, weather: s.weather.target };
		// The disk's integral equals the direct light only where no cloud covers it, cirrus included.
		await s.setWeather( 'clear', 0 );
		await r.setAnimationLoop( null );
		const scene = new s.scene.constructor(), dome = sky.dome.clone();
		// The dome's material writes the exposure's metering light as its MRT, which takes the place
		// of its colour in a target without one (post/Motion.ts `meterOutput`): draw its colour alone.
		dome.material = sky.dome.material.clone();
		dome.material.mrtNode = null;
		dome.onBeforeRender = ( _renderer, _scene, camera ) => { dome.position.copy( camera.position ); dome.updateMatrixWorld(); };
		scene.add( dome );
		const share = s.tune.get( 'lighting.sun.discRadiance' ), radius = displayRadius * s.tune.get( 'lighting.sun.discScale' );
		// a field half again as wide as the disk, its edge well inside; the sky round the disk, past
		// 1.05 of its radius, gives the sky's radiance behind it
		const camera = s.camera.clone(), size = 512, fov = 3 * radius * 180 / Math.PI, rim = Math.cos( 1.05 * radius );
		camera.fov = fov; camera.aspect = 1; camera.updateProjectionMatrix();
		const rt = new sky.small.constructor( size, size, { type: sky.small.texture.type, depthBuffer: false } );
		const output = [];
		try {

			for ( const [ elevation, illuminance ] of [ [ 10, 11 ], [ 32, 11 ], [ 60, 11 ], [ 70, 20 ] ] ) {

				sky.elevation = elevation; sky.sunIlluminance = illuminance;
				await s.applySun();
				sky.clouds.streaks.value = 0;
				sky.clouds.invalidate();
				sky.clouds.update( r, null, 1, 1, 0 );
				camera.lookAt( camera.position.clone().addScaledVector( sky.sunDir, 100 ) ); camera.updateMatrixWorld();
				r.setRenderTarget( rt ); r.render( scene, camera ); r.setRenderTarget( previous );
				const px = await r.readRenderTargetPixelsAsync( rt, 0, 0, size, size );
				const field = [ 0, 0, 0 ], around = [ 0, 0, 0 ], tangent = Math.tan( fov * Math.PI / 360 ), delta = 2 * tangent / size;
				let maximum = 0, nonfinite = 0, fieldAngle = 0, aroundAngle = 0;
				for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) {

					const a = ( ( x + 0.5 ) * 2 / size - 1 ) * tangent, b = ( ( y + 0.5 ) * 2 / size - 1 ) * tangent;
					// the pixel's solid angle times its cosine to the sun: its share of the irradiance
					const weight = delta * delta / ( 1 + a * a + b * b ) ** 2, outside = 1 / Math.sqrt( 1 + a * a + b * b ) < rim;
					fieldAngle += weight;
					if ( outside ) aroundAngle += weight;
					for ( let c = 0; c < 3; c ++ ) {

						const v = px[ ( y * size + x ) * 4 + c ];
						if ( ! Number.isFinite( v ) ) nonfinite ++;
						maximum = Math.max( maximum, v ); field[ c ] += v * weight;
						if ( outside ) around[ c ] += v * weight;

					}

				}
				const irradiance = field.map( ( v, c ) => v - around[ c ] / aroundAngle * fieldAngle );
				output.push( { elevation, illuminance, share, irradiance, sky: around.map( ( v ) => v / aroundAngle ), direct: sky.sunColor.toArray(), maximum, nonfinite } );

			}

		} finally {

			rt.dispose(); dome.material.dispose(); r.setRenderTarget( previous );
			sky.elevation = original.elevation; sky.sunIlluminance = original.illuminance; await s.setWeather( original.weather, 0 ); await s.applySun();
			await r.setAnimationLoop( animation );

		}
		return output;

	}, SUN_DISPLAY_RADIUS );
	const luminance = ( c ) => 0.2126 * c[ 0 ] + 0.7152 * c[ 1 ] + 0.0722 * c[ 2 ];
	for ( const state of measurements ) {

		assert.equal( state.nonfinite, 0 );
		assert.ok( state.maximum < 65504, 'solar radiance exceeds fp16 range' );
		assert.ok( state.share > 0, 'the page lists no lighting.sun.discRadiance' );
		state.ratio = luminance( state.irradiance ) / ( state.share * luminance( state.direct ) );
		if ( state.elevation < LOW_SUN ) continue;
		assert.ok( Math.abs( state.ratio - 1 ) < 0.02,
			`the disk's luminance is ${ state.ratio.toFixed( 4 ) } of the displayed share of the key's at ${ state.elevation } degrees` );

	}
	assert.deepEqual( errors, [] );
	await mkdir( 'artifacts/verification', { recursive: true } );
	await writeFile( 'artifacts/verification/radiometry.json', JSON.stringify( { SCENE_RADIANCE_SCALE, measurements, errors }, null, 2 ) );
	console.log( JSON.stringify( { measurements, errors } ) );
	console.log( `Radiometry: the disk's luminance over the share of the key's ${ measurements.map( ( m ) => `${ m.elevation } degrees ${ m.ratio.toFixed( 4 ) }` ).join( ', ' ) }; checked from ${ LOW_SUN } degrees up.` );

} finally {
	await browser.close();
}
