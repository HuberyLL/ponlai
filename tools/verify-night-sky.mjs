// GPU checks and fixed evidence for moon phases, stable stars, and the daylight fade.
// Run after the stage-three Sky hooks are installed; keep other GPU tabs closed:
//   node tools/verify-night-sky.mjs http://127.0.0.1:5190
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.argv[ 2 ] || 'http://127.0.0.1:5190';
const out = 'artifacts/verification/night-sky';
const phases = [
	{ name: 'new', phase: 0, hour: 12 },
	{ name: 'crescent', phase: 0.125, hour: 17.5 },
	{ name: 'quarter', phase: 0.25, hour: 18 },
	{ name: 'full', phase: 0.5, hour: 0 },
];
const report = { base, phases: [], checks: [], errors: [], failures: [] };
await mkdir( out, { recursive: true } );
const browser = await chromium.launch( {
	headless: true,
	...( process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' } ),
	args: [ '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit' ],
} );

try {
	const page = await browser.newPage( { viewport: { width: 1672, height: 941 }, deviceScaleFactor: 1 } );
	page.setDefaultTimeout( 90000 );
	page.on( 'pageerror', ( error ) => report.errors.push( `pageerror: ${ error.message }` ) );
	page.on( 'console', ( message ) => { if ( message.type() === 'error' ) report.errors.push( message.text() ); } );
	page.on( 'response', ( response ) => { if ( response.status() >= 400 ) report.failures.push( `${ response.status() } ${ response.url() }` ); } );
	page.on( 'requestfailed', ( request ) => report.failures.push( `${ request.failure()?.errorText } ${ request.url() }` ) );
	const url = new URL( base );
	url.search = 'debug&paused&t=12&dpr=1&hour=0&moon=0.5&clouds=0&quality=medium';
	await page.goto( url.href );
	await page.waitForFunction( () => window.__SOOMI__?.sky?.night && window.__SOOMI__?.setHour &&
		window.__THREE_GAME_DIAGNOSTICS__?.frame > 60 && document.getElementById( 'loading' )?.classList.contains( 'done' ) );
	// Fast paused frames can finish before the loading overlay's one-second CSS fade.
	await page.waitForFunction( () => getComputedStyle( document.getElementById( 'loading' ) ).opacity === '0' );
	await page.evaluate( () => {
		const s = window.__SOOMI__;
		s.dayCycle.paused = true;
		s.dayCycle.advanceMoonPhase = false;
		s.controls.enableDamping = false;
		s.controls.minPolarAngle = 0;
		s.controls.maxPolarAngle = Math.PI;
		// The narrow moon evidence tests actual geometry, without a defocused camera lens.
		s.pipeline.settings.dof = 0;
		s.pipeline.settings.grain = 0;
	} );
	const frames = () => page.evaluate( () => new Promise( ( resolve ) => requestAnimationFrame( () => requestAnimationFrame( resolve ) ) ) );
	const setState = ( phase, hour ) => page.evaluate( async ( { phase, hour } ) => {
		const s = window.__SOOMI__;
		s.dayCycle.moonPhase = phase;
		await s.setHour( hour );
	}, { phase, hour } );
	const setView = async ( moon, fov = 8 ) => {
		await page.evaluate( ( { moon, fov } ) => {
			const s = window.__SOOMI__;
			const direction = moon ? s.sky.moonDir.clone() : s.sky.sunDir.clone().set( 0.6, 0.72, 0.35 ).normalize();
			s.camera.position.set( 0, 15, 0 );
			s.controls.target.copy( s.camera.position ).addScaledVector( direction, 100 );
			s.camera.fov = fov;
			s.camera.updateProjectionMatrix();
			s.controls.update();
			s.camera.updateMatrixWorld();
		}, { moon, fov } );
		await frames();
	};
	const capturePair = async ( name ) => {
		const images = [];
		for ( const suffix of [ 'a', 'b' ] ) {
			await frames();
			const path = `${ out }/${ name }-${ suffix }.png`;
			images.push( { path, buffer: await page.screenshot( { path } ) } );
		}
		return { paths: images.map( ( image ) => image.path ), identical: images[ 0 ].buffer.equals( images[ 1 ].buffer ) };
	};

	for ( const phase of phases ) {
		await setState( phase.phase, phase.hour );
		await setView( true );
		const state = await page.evaluate( () => {
			const s = window.__SOOMI__, snapshot = s.dayCycle.snapshot();
			return { illumination: snapshot.moonIllumination, moonElevation: snapshot.moonElevation,
				moonDir: s.sky.moonDir.toArray(), sunDir: s.sky.sunDir.toArray(),
				starVisibility: s.sky.night.starVisibility.value, exposure: s.pipeline.settings.exposure };
		} );
		const capture = await capturePair( `moon-${ phase.name }` );
		report.phases.push( { ...phase, ...state, capture } );
		assert.ok( state.moonElevation > 10, `${ phase.name } must be captured above the horizon` );
		assert.ok( capture.identical, `${ phase.name } paused captures must be deterministic` );
	}

	// Render the real dome material to float targets. Difference against the same render with
	// the moon/star uniform disabled isolates those contributions from the changing atmosphere.
	report.gpu = await page.evaluate( async ( phases ) => {
		const s = window.__SOOMI__, r = s.renderer, sky = s.sky;
		const animation = r.getAnimationLoop(), previousTarget = r.getRenderTarget();
		const scene = new s.scene.constructor();
		const dome = sky.dome.clone();
		dome.onBeforeRender = ( _renderer, _scene, camera ) => {
			dome.position.copy( camera.position );
			dome.updateMatrixWorld();
		};
		scene.add( dome );
		const size = 512;
		const target = new sky.small.constructor( size, size, { type: sky.small.texture.type, depthBuffer: false } );
		const camera = s.camera.clone();
		camera.aspect = 1;
		camera.position.set( 0, 15, 0 );
		const aim = ( direction, fov ) => {
			camera.fov = fov;
			camera.updateProjectionMatrix();
			camera.lookAt( camera.position.clone().addScaledVector( direction, 100 ) );
			camera.updateMatrixWorld();
		};
		const render = async () => {
			r.setRenderTarget( target );
			r.render( scene, camera );
			r.setRenderTarget( previousTarget );
			return r.readRenderTargetPixelsAsync( target, 0, 0, size, size );
		};
		const compare = ( on, off, threshold = 1e-5 ) => {
			let sum = 0, maximum = 0, count = 0, finite = true, minimum = Infinity;
			for ( let i = 0; i < on.length; i += 4 ) {
				for ( let c = 0; c < 3; c ++ ) finite &&= Number.isFinite( on[ i + c ] ) && Number.isFinite( off[ i + c ] );
				const value = ( on[ i ] - off[ i ] ) * 0.2126 + ( on[ i + 1 ] - off[ i + 1 ] ) * 0.7152 + ( on[ i + 2 ] - off[ i + 2 ] ) * 0.0722;
				sum += Math.max( value, 0 );
				maximum = Math.max( maximum, value );
				minimum = Math.min( minimum, value );
				if ( value > threshold ) count ++;
			}
			return { sum, maximum, minimum, count, finite, threshold };
		};
		const difference = ( a, b ) => {
			let maximum = 0, sum = 0;
			for ( let i = 0; i < a.length; i ++ ) {
				const delta = Math.abs( a[ i ] - b[ i ] );
				maximum = Math.max( maximum, delta );
				sum += delta;
			}
			return { maximum, mean: sum / a.length };
		};
		const result = { moons: [], fade: [] };
		await r.setAnimationLoop( null );
		try {
			for ( const phase of phases ) {
				s.dayCycle.moonPhase = phase.phase;
				await s.setHour( phase.hour );
				aim( sky.moonDir, 8 );
				const color = sky.night.moonColor.value.clone();
				const on = await render();
				sky.night.moonColor.value.setRGB( 0, 0, 0 );
				const off = await render();
				sky.night.moonColor.value.copy( color );
				const repeat = await render();
				result.moons.push( { name: phase.name, ...compare( on, off, 0.001 ), determinism: difference( on, repeat ) } );
			}

			s.dayCycle.moonPhase = 0.5;
			for ( const hour of [ 12, 17.85, 18.25, 18.65, 19.05, 20, 0 ] ) {
				await s.setHour( hour );
				result.fade.push( { hour, elevation: s.dayCycle.snapshot().elevation, visibility: sky.night.starVisibility.value } );
			}
			const visibility = sky.night.starVisibility.value;
			sky.night.moonColor.value.setRGB( 0, 0, 0 );
			const direction = sky.sunDir.clone().set( 0.6, 0.72, 0.35 ).normalize();
			aim( direction, 70 );
			const on = await render();
			sky.night.starVisibility.value = 0;
			const off = await render();
			sky.night.starVisibility.value = visibility;
			const repeat = await render();
			aim( direction.clone().set( 0.61, 0.72, 0.34 ).normalize(), 70 );
			await render();
			aim( direction, 70 );
			const returned = await render();
			result.stars = { ...compare( on, off ), determinism: difference( on, repeat ), returnToView: difference( on, returned ) };
			await s.setHour( 12 );
			aim( direction, 70 );
			const daylight = await render();
			sky.night.starVisibility.value = 0;
			const noStars = await render();
			result.daylightStars = difference( daylight, noStars );
			return result;
		} finally {
			r.setRenderTarget( previousTarget );
			target.dispose();
			scene.remove( dome );
			// The clone shares the live material/geometry; their lifetime belongs to Sky.
			try { await s.setHour( 0 ); } finally { await r.setAnimationLoop( animation ); }
		}
	}, phases );

	const moon = Object.fromEntries( report.gpu.moons.map( ( entry ) => [ entry.name, entry ] ) );
	for ( const entry of report.gpu.moons ) {
		assert.ok( entry.finite && entry.minimum > - 1e-5, `${ entry.name } disk radiance must be finite and nonnegative` );
		assert.ok( entry.determinism.maximum <= 1e-7, `${ entry.name } raw disk must be deterministic` );
	}
	assert.ok( moon.new.maximum < 1e-7 && moon.new.count === 0, 'New moon must emit no visible disk radiance' );
	assert.ok( moon.full.count > 1000 && moon.full.maximum > 0.01, 'Full moon must show a resolved illuminated disk' );
	assert.ok( moon.quarter.count / moon.full.count > 0.35 && moon.quarter.count / moon.full.count < 0.7, 'Quarter moon must illuminate roughly half the resolved disk' );
	assert.ok( moon.crescent.count / moon.full.count > 0.04 && moon.crescent.count / moon.full.count < 0.3, 'Crescent must illuminate a smaller curved fraction' );
	report.checks.push( 'New, crescent, quarter, full disks use geometric phases and deterministic scene-linear radiance' );
	assert.ok( report.gpu.stars.finite && report.gpu.stars.count > 12 && report.gpu.stars.maximum > 1e-4, 'Night must show resolved analytic stars' );
	assert.ok( report.gpu.stars.determinism.maximum <= 1e-7 && report.gpu.stars.returnToView.maximum <= 1e-7, 'Stars must remain stable after repeated rendering and camera rotation back to the same view' );
	assert.ok( report.gpu.daylightStars.maximum <= 1e-7, 'Stars must add no radiance in daylight' );
	assert.ok( report.gpu.fade[ 0 ].visibility === 0 && report.gpu.fade.at( - 1 ).visibility > 0.2, 'Night fade must be driven by the celestial state' );
	for ( let i = 1; i < report.gpu.fade.length; i ++ ) {
		assert.ok( report.gpu.fade[ i ].visibility >= report.gpu.fade[ i - 1 ].visibility - 1e-8 && report.gpu.fade[ i ].visibility <= 1, 'Stars must fade in monotonically through evening' );
	}
	report.checks.push( 'Analytic stars are visible at night, absent in daylight, and stable under camera changes' );
	await setState( 0.5, 0 );
	await setView( false, 70 );
	report.starView = await capturePair( 'stars-full-moon' );
	assert.ok( report.starView.identical, 'Paused star screenshots must be deterministic' );
	assert.deepEqual( report.errors, [], 'No browser or GPU errors' );
	assert.deepEqual( report.failures, [], 'No failed asset requests' );
	report.passed = true;
	console.log( `Night sky: ${ report.checks.length } checks passed. Evidence: ${ out }/report.json` );
} catch ( error ) {
	report.passed = false;
	report.fatal = error.stack || String( error );
	console.error( report.fatal );
	process.exitCode = 1;
} finally {
	await writeFile( `${ out }/report.json`, JSON.stringify( report, null, 2 ) + '\n' );
	await browser.close();
}
