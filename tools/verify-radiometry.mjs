// Integrate the rendered HDR solar disk, rather than testing its brightness coefficient.
// Usage: node tools/verify-radiometry.mjs http://127.0.0.1:5190
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { SCENE_RADIANCE_SCALE, SUN_PROJECTED_SOLID_ANGLE } from '../src/lighting/Radiometry.ts';

assert.ok( SUN_PROJECTED_SOLID_ANGLE > 0 );
const errors = [];
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
	await page.goto( `${ process.argv[ 2 ] || 'http://127.0.0.1:5190' }/?debug&paused&t=12&dpr=1` );
	await page.waitForFunction( () => window.__SOOMI__?.applySun && window.__THREE_GAME_DIAGNOSTICS__?.frame > 30, null, { timeout: 90000 } );
	const measurements = await page.evaluate( async () => {

		const s = window.__SOOMI__, r = s.renderer, sky = s.sky;
		const animation = r.getAnimationLoop(), previous = r.getRenderTarget();
		const original = { elevation: sky.elevation, illuminance: sky.sunIlluminance, weather: s.weather.target };
		// The disk's integral equals the direct light only where no cloud covers it, cirrus included.
		await s.setWeather( 'clear', 0 );
		await r.setAnimationLoop( null );
		const scene = new s.scene.constructor(), dome = sky.dome.clone();
		dome.onBeforeRender = ( _renderer, _scene, camera ) => { dome.position.copy( camera.position ); dome.updateMatrixWorld(); };
		scene.add( dome );
		const camera = s.camera.clone(), size = 512, fov = 1.2;
		camera.fov = fov; camera.aspect = 1; camera.updateProjectionMatrix();
		const rt = new sky.small.constructor( size, size, { type: sky.small.texture.type, depthBuffer: false } );
		const output = [];
		try {

			for ( const [ elevation, illuminance ] of [ [ 10, 11 ], [ 32, 11 ], [ 60, 11 ], [ 70, 20 ] ] ) {

				sky.elevation = elevation; sky.sunIlluminance = illuminance;
				await s.applySun();
				sky.clouds.cirrus.value = 0;
				sky.clouds.invalidate();
				sky.clouds.update( r, null, 1, 1, 0 );
				camera.lookAt( camera.position.clone().addScaledVector( sky.sunDir, 100 ) ); camera.updateMatrixWorld();
				r.setRenderTarget( rt ); r.render( scene, camera ); r.setRenderTarget( previous );
				const px = await r.readRenderTargetPixelsAsync( rt, 0, 0, size, size );
				const irradiance = [ 0, 0, 0 ], tangent = Math.tan( fov * Math.PI / 360 ), delta = 2 * tangent / size;
				let maximum = 0, nonfinite = 0;
				for ( let y = 0; y < size; y ++ ) for ( let x = 0; x < size; x ++ ) {

					const a = ( ( x + 0.5 ) * 2 / size - 1 ) * tangent, b = ( ( y + 0.5 ) * 2 / size - 1 ) * tangent;
					const weight = delta * delta / ( 1 + a * a + b * b ) ** 2;
					for ( let c = 0; c < 3; c ++ ) {

						const v = px[ ( y * size + x ) * 4 + c ];
						if ( ! Number.isFinite( v ) ) nonfinite ++;
						maximum = Math.max( maximum, v ); irradiance[ c ] += v * weight;

					}

				}
				output.push( { elevation, illuminance, irradiance, direct: sky.sunColor.toArray(), maximum, nonfinite } );

			}

		} finally {

			rt.dispose(); r.setRenderTarget( previous );
			sky.elevation = original.elevation; sky.sunIlluminance = original.illuminance; await s.setWeather( original.weather, 0 ); await s.applySun();
			await r.setAnimationLoop( animation );

		}
		return output;

	} );
	for ( const state of measurements ) {

		assert.equal( state.nonfinite, 0 );
		assert.ok( state.maximum < 65504, 'solar radiance exceeds fp16 range' );
		for ( let c = 0; c < 3; c ++ ) assert.ok( Math.abs( state.irradiance[ c ] / state.direct[ c ] - 1 ) < 0.02,
			`disk and directional irradiance disagree at ${ state.elevation } degrees, channel ${ c }` );

	}
	assert.deepEqual( errors, [] );
	await mkdir( 'artifacts/verification', { recursive: true } );
	await writeFile( 'artifacts/verification/radiometry.json', JSON.stringify( { SCENE_RADIANCE_SCALE, measurements, errors }, null, 2 ) );
	console.log( JSON.stringify( { measurements, errors } ) );

} finally {
	await browser.close();
}
