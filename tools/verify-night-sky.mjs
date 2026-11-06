// GPU checks and fixed evidence for moon phases, stable stars, and the daylight fade.
// Run after the stage-three Sky hooks are installed; keep other GPU tabs closed:
//   node tools/verify-night-sky.mjs http://127.0.0.1:5190
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { acquireGpuLock } from './gpu-lock.mjs';
import { eveningHour } from '../src/sky/DayCycle.ts';

const base = process.argv[ 2 ] || 'http://127.0.0.1:5190';
const out = 'artifacts/verification/night-sky';
// the evening's fade of the stars, by the sun's elevation: noon, 2 degrees up, then 3.3, 8.6, 13.9 and
// 26.2 under the horizon, and midnight
const fadeHours = [ 12, ...[ 2, - 3.3, - 8.6, - 13.9, - 26.2 ].map( eveningHour ), 0 ];
const phases = [
	// (the moon is fixed in the sky, at every hour and phase: DayCycle.ts)
	{ name: 'new', phase: 0, hour: 0 },
	{ name: 'crescent', phase: 0.125, hour: 0 },
	{ name: 'quarter', phase: 0.25, hour: 0 },
	{ name: 'full', phase: 0.5, hour: 0 },
];
const report = { base, phases: [], checks: [], errors: [], failures: [] };
await mkdir( out, { recursive: true } );
// shared with other probes (their pixels do not depend on the GPU load), never during a timing
// run (tools/gpu-lock.mjs; released when the process exits)
await acquireGpuLock( 'verify-night-sky', { shared: true } );
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
	url.search = 'debug&paused&t=12&dpr=1&hour=0&moon=0.5&clouds=0&quality=high';
	await page.goto( url.href );
	await page.waitForFunction( () => window.__PONLAI__?.sky?.night && window.__PONLAI__?.setHour &&
		window.__THREE_GAME_DIAGNOSTICS__?.frame > 60 && document.getElementById( 'loading' )?.classList.contains( 'done' ) );
	// Fast paused frames can finish before the loading overlay's one-second CSS fade.
	await page.waitForFunction( () => getComputedStyle( document.getElementById( 'loading' ) ).opacity === '0' );
	await page.evaluate( () => {
		const s = window.__PONLAI__;
		s.dayCycle.paused = true;
		s.dayCycle.advanceMoonPhase = false;
		s.controls.enableDamping = false;
		s.controls.minPolarAngle = 0;
		s.controls.maxPolarAngle = Math.PI;
		// The narrow moon evidence tests actual geometry, without a defocused camera lens.
		s.pipeline.settings.dof = 0;
	} );
	const frames = () => page.evaluate( () => new Promise( ( resolve ) => requestAnimationFrame( () => requestAnimationFrame( resolve ) ) ) );
	const setState = ( phase, hour ) => page.evaluate( async ( { phase, hour } ) => {
		const s = window.__PONLAI__;
		s.dayCycle.moonPhase = phase;
		await s.setHour( hour );
	}, { phase, hour } );
	const setView = async ( moon, fov = 8 ) => {
		await page.evaluate( ( { moon, fov } ) => {
			const s = window.__PONLAI__;
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
			const s = window.__PONLAI__, snapshot = s.dayCycle.snapshot();
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
	report.gpu = await page.evaluate( async ( { phases, fadeHours } ) => {
		const s = window.__PONLAI__, r = s.renderer, sky = s.sky;
		const animation = r.getAnimationLoop(), previousTarget = r.getRenderTarget();
		const scene = new s.scene.constructor();
		const dome = sky.dome.clone();
		// The dome writes its metering light to the scene pass's MRT (Motion.ts `meterOutput`); this
		// target has none, so the copy drawn here writes its colour alone.
		dome.material = sky.dome.material.clone();
		dome.material.mrtNode = null;
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
		// The disk's luminance with the moon on, less the same render with it off.
		const luminance = ( on, off ) => {
			const values = new Float32Array( on.length / 4 );
			for ( let i = 0; i < values.length; i ++ ) {
				values[ i ] = ( on[ i * 4 ] - off[ i * 4 ] ) * 0.2126 + ( on[ i * 4 + 1 ] - off[ i * 4 + 1 ] ) * 0.7152 + ( on[ i * 4 + 2 ] - off[ i * 4 + 2 ] ) * 0.0722;
			}
			return values;
		};
		const result = { moons: [], fade: [] }, disks = {};
		await r.setAnimationLoop( null );
		try {
			for ( const phase of phases ) {
				s.dayCycle.moonPhase = phase.phase;
				await s.setHour( phase.hour );
				aim( sky.moonDir, 8 );
				const color = sky.night.moonColor.value.clone();
				// Measure the bare disk: the haze glow around it is separate.
				sky.night.glow.value = 0;
				const on = await render();
				sky.night.moonColor.value.setRGB( 0, 0, 0 );
				const off = await render();
				sky.night.moonColor.value.copy( color );
				const repeat = await render();
				sky.night.glow.value = 1;
				// (about a quarter of the full disk's peak at the night's exposure: the count is the
				// resolved disk's size; the phase's share of it is `lit` below)
				result.moons.push( { name: phase.name, ...compare( on, off, 0.0004 ), determinism: difference( on, repeat ) } );
				disks[ phase.name ] = luminance( on, off );
			}
			// The share of the resolved disk a phase lights, pixel by pixel against the full moon: a
			// pixel is lit when it shows more than a twentieth of what it shows at full. The ratio
			// divides out the albedo's pattern, a veil of cloud over the disk and the moon's level,
			// which a count above a fixed radiance does not: above a quarter of the full peak a
			// quarter moon, shaded toward its terminator and dark in its maria, covers only 0.16 of
			// the full disk's count.
			const full = disks.full;
			const peak = full.reduce( ( a, b ) => Math.max( a, b ), 0 );
			for ( const entry of result.moons ) {
				const values = disks[ entry.name ];
				let disk = 0, lit = 0;
				for ( let i = 0; i < full.length; i ++ ) {
					if ( full[ i ] <= 0.05 * peak ) continue;
					disk ++;
					if ( values[ i ] > 0.05 * full[ i ] ) lit ++;
				}
				entry.lit = lit / disk;
			}

			s.dayCycle.moonPhase = 0.5;
			for ( const hour of fadeHours ) {
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
			dome.material.dispose();
			// The clone shares the live geometry; its lifetime belongs to Sky.
			try { await s.setHour( 0 ); } finally { await r.setAnimationLoop( animation ); }
		}
	}, { phases, fadeHours } );

	const moon = Object.fromEntries( report.gpu.moons.map( ( entry ) => [ entry.name, entry ] ) );
	for ( const entry of report.gpu.moons ) {
		assert.ok( entry.finite && entry.minimum > - 1e-5, `${ entry.name } disk radiance must be finite and nonnegative` );
		assert.ok( entry.determinism.maximum <= 1e-7, `${ entry.name } raw disk must be deterministic` );
	}
	assert.ok( moon.new.maximum < 1e-7 && moon.new.count === 0, 'New moon must emit no visible disk radiance' );
	// The disk's radiance scales back as the night's exposure rises (DayCycleSnapshot.nightSkyLevel):
	// compare what the display shows, at the exposure the night sky was tuned with (4.4).
	const fullExposure = report.phases.find( ( phase ) => phase.name === 'full' ).exposure;
	assert.ok( moon.full.count > 1000 && moon.full.maximum * fullExposure > 0.009 * 4.4, 'Full moon must show a resolved illuminated disk' );
	// A sphere lit from the side shows its illuminated fraction, ( 1 - cos( 2 pi phase ) ) / 2, as
	// the lit share of its disk; the measured share falls about 0.02 short of it, where the shading
	// fades into the terminator.
	const illumination = ( name ) => report.phases.find( ( phase ) => phase.name === name ).illumination;
	assert.ok( Math.abs( moon.quarter.lit - illumination( 'quarter' ) ) < 0.05, 'Quarter moon must illuminate roughly half the resolved disk' );
	assert.ok( Math.abs( moon.crescent.lit - illumination( 'crescent' ) ) < 0.05 && moon.crescent.lit < moon.quarter.lit, 'Crescent must illuminate a smaller curved fraction' );
	report.checks.push( 'New, crescent, quarter, full disks use geometric phases and deterministic scene-linear radiance' );
	assert.ok( report.gpu.stars.finite && report.gpu.stars.count > 12 && report.gpu.stars.maximum > 1e-4, 'Night must show resolved analytic stars' );
	assert.ok( report.gpu.stars.determinism.maximum <= 1e-7 && report.gpu.stars.returnToView.maximum <= 1e-7, 'Stars must remain stable after repeated rendering and camera rotation back to the same view' );
	assert.ok( report.gpu.daylightStars.maximum <= 1e-7, 'Stars must add no radiance in daylight' );
	// (the moon is up all night and dims the stars a little: Sky.ts `starVisibility`)
	assert.ok( report.gpu.fade[ 0 ].visibility === 0 && report.gpu.fade.at( - 1 ).visibility > 0.15, 'Night fade must be driven by the celestial state' );
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
