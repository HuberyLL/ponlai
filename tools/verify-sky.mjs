// GPU regression checks for the shared atmosphere, lighting and camera-relative solar disk.
// Run against the dev server: node tools/verify-sky.mjs http://127.0.0.1:5190
import { chromium } from 'playwright';
import { acquireGpuLock } from './gpu-lock.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const base = process.argv[ 2 ] || 'http://127.0.0.1:5190';
const out = 'artifacts/verification';
await mkdir( out, { recursive: true } );
const errors = [], failures = [], checks = [];
const report = { base, checks, errors, failures };
// one rendering browser at a time on this machine (released when the process exits)
await acquireGpuLock( 'verify-sky' );
const browser = await chromium.launch( {
	headless: true,
	...( process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' } ),
	args: [ '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit' ],
} );

const closeArray = ( actual, expected, tolerance, label ) => {
	assert.equal( actual.length, expected.length, label );
	for ( let i = 0; i < actual.length; i ++ ) assert.ok( Math.abs( actual[ i ] - expected[ i ] ) <= tolerance, `${ label }[${ i }]: ${ actual[ i ] } vs ${ expected[ i ] }` );
};
const finiteColour = ( colour, label ) => assert.ok( colour.every( ( c ) => Number.isFinite( c ) && c >= 0 ), `${ label }: ${ colour }` );
const halfRadiance = ( lower, higher, label ) => {
	finiteColour( lower, label );
	finiteColour( higher, label );
	assert.ok( higher.some( ( c ) => c > 1e-5 ), `${ label } must contain daylight` );
	for ( let i = 0; i < higher.length; i ++ ) {
		const expected = higher[ i ] * 0.5;
		assert.ok( Math.abs( lower[ i ] - expected ) <= Math.max( 1e-5, expected * 0.05 ), `${ label }[${ i }] does not follow illuminance: ${ lower[ i ] } vs ${ expected }` );
	}
};

try {
	// One page keeps other WebGPU scenes from competing with these checks.
	const page = await browser.newPage( { viewport: { width: 1672, height: 941 }, deviceScaleFactor: 1 } );
	page.on( 'pageerror', ( e ) => errors.push( e.message ) );
	page.on( 'console', ( m ) => { if ( m.type() === 'error' ) errors.push( m.text() ); } );
	page.on( 'response', ( r ) => { if ( r.status() >= 400 ) failures.push( `${ r.status() } ${ r.url() }` ); } );
	page.on( 'requestfailed', ( r ) => failures.push( `${ r.failure()?.errorText } ${ r.url() }` ) );
	const url = new URL( base );
	// A clear sky: the shell's clouds reach the horizon and could hide the setting disk under test.
	url.search = 'debug&paused&t=12&dpr=1&weather=clear&clouds=0';
	await page.goto( url.href );
	await page.waitForFunction( () => window.__SOOMI__?.applySun && window.__THREE_GAME_DIAGNOSTICS__?.frame > 60 && document.getElementById( 'loading' )?.classList.contains( 'done' ), null, { timeout: 90000 } );

	const measurements = await page.evaluate( async () => {
		const s = window.__SOOMI__, renderer = s.renderer, sky = s.sky;
		const original = { elevation: sky.elevation, azimuth: sky.azimuth, illuminance: sky.sunIlluminance };
		const animation = renderer.getAnimationLoop(), previousTarget = renderer.getRenderTarget();
		const elevations = [], memory = [];
		let diskTarget = null, diskScene = null, diskDome = null;
		await renderer.setAnimationLoop( null );

		const state = () => ( {
			elevation: sky.elevation,
			skyDir: sky.sunDir.toArray(),
			atmosphereDir: sky.atmosphere.sunDir.value.toArray(),
			lightDir: s.sun.position.clone().sub( s.sun.target.position ).normalize().toArray(),
			waterDir: s.shared.sunDir.value.toArray(),
			sunColor: sky.sunColor.toArray(),
			lightColor: s.sun.color.clone().multiplyScalar( s.sun.intensity ).toArray(),
			waterSunColor: s.shared.sunColor.value.toArray(),
			skyIrradiance: sky.skyIrradiance.toArray(),
			waterIrradiance: s.shared.skyIrradiance.value.toArray(),
			sunIntoWater: s.shared.sunIntoWater.value,
			muSun: s.shared.muSun.value,
		} );
		const update = async ( elevation, illuminance = 11, azimuth = - 8 ) => {
			sky.elevation = elevation;
			sky.azimuth = azimuth;
			sky.sunIlluminance = illuminance;
			await s.applySun();
		};
		const radiance = async () => {
			const px = await renderer.readRenderTargetPixelsAsync( sky.small, 0, 0, sky.small.width, sky.small.height );
			const rgb = [ 0, 0, 0 ];
			let samples = 0, finite = true, minimum = Infinity;
			for ( let k = 0; k < px.length; k += 4 ) {
				for ( let c = 0; c < 3; c ++ ) {
					finite &&= Number.isFinite( px[ k + c ] );
					minimum = Math.min( minimum, px[ k + c ] );
				}
				if ( px[ k + 3 ] <= 0 ) continue;
				for ( let c = 0; c < 3; c ++ ) rgb[ c ] += px[ k + c ];
				samples ++;
			}
			return { rgb: rgb.map( ( c ) => c / samples ), finite, minimum, samples };
		};

		try {
			for ( const elevation of [ 32, 0.5, 0, - 0.5, - 5 ] ) {
				await update( elevation );
				elevations.push( state() );
			}
			await update( 32, 11 );
			const full = { ...state(), radiance: await radiance() };
			await update( 32, 5.5 );
			const half = { ...state(), radiance: await radiance() };

			// Warm the same sky and PMREM passes before looking for a retained target per update.
			for ( const elevation of [ 31, 32, 31, 32 ] ) await update( elevation );
			const textureBaseline = renderer.info.memory.textures;
			for ( let i = 0; i < 12; i ++ ) {
				await update( 20 + ( i % 3 ) * 6, 11, [ - 8, - 30, 20, 60 ][ i % 4 ] );
				memory.push( renderer.info.memory.textures );
			}

			// Clone the mesh only: its geometry and material remain owned by the real sky.
			diskScene = new s.scene.constructor();
			diskDome = sky.dome.clone();
			diskDome.onBeforeRender = ( _renderer, _scene, camera ) => {
				diskDome.position.copy( camera.position );
				diskDome.updateMatrixWorld();
			};
			diskScene.add( diskDome );
			const size = 256;
			diskTarget = new sky.small.constructor( size, size, { type: sky.small.texture.type, depthBuffer: false } );
			const camera = s.camera.clone();
			camera.fov = 27;
			camera.aspect = 1;
			camera.updateProjectionMatrix();
			const disk = async ( position, direction, threshold ) => {
				camera.position.copy( position );
				camera.lookAt( position.clone().addScaledVector( direction, 100 ) );
				camera.updateMatrixWorld();
				renderer.setRenderTarget( diskTarget );
				renderer.render( diskScene, camera );
				renderer.setRenderTarget( previousTarget );
				const px = await renderer.readRenderTargetPixelsAsync( diskTarget, 0, 0, size, size );
				let count = 0, xSum = 0, ySum = 0, maximum = 0, finite = true;
				for ( let k = 0; k < size * size; k ++ ) {
					const r = px[ k * 4 ], g = px[ k * 4 + 1 ], b = px[ k * 4 + 2 ];
					finite &&= Number.isFinite( r ) && Number.isFinite( g ) && Number.isFinite( b );
					const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
					maximum = Math.max( maximum, luma );
					if ( luma <= threshold ) continue;
					count ++;
					xSum += k % size + 0.5;
					ySum += Math.floor( k / size ) + 0.5;
				}
				// Project a direction with w = 0, so camera translation cannot affect the reference.
				const d = sky.sunDir.clone().transformDirection( camera.matrixWorldInverse ), e = camera.projectionMatrix.elements;
				const clipX = e[ 0 ] * d.x + e[ 4 ] * d.y + e[ 8 ] * d.z;
				const clipY = e[ 1 ] * d.x + e[ 5 ] * d.y + e[ 9 ] * d.z;
				const clipW = e[ 3 ] * d.x + e[ 7 ] * d.y + e[ 11 ] * d.z;
				return { count, centroid: count ? [ xSum / count, ySum / count ] : null,
					projected: [ ( clipX / clipW * 0.5 + 0.5 ) * size, ( 0.5 - clipY / clipW * 0.5 ) * size ], maximum, finite, threshold };
			};
			await update( 32 );
			const position = s.camera.position.clone();
			const firstDisk = await disk( position, sky.sunDir, 100 );
			const movedPosition = position.clone();
			movedPosition.x += 150;
			movedPosition.z += 50;
			const movedDisk = await disk( movedPosition, sky.sunDir, 100 );
			// The solar centre is below the horizon, but the upper part of the displayed disk (0.54 degree
			// radius, twice the true sun) remains visible.
			await update( - 0.3 );
			const horizontal = sky.sunDir.clone();
			horizontal.y = 0;
			horizontal.normalize();
			const sunsetDisk = await disk( position, horizontal, 20 );
			await update( - 0.8 );
			const hiddenDisk = await disk( position, horizontal, 20 );
			return { elevations, full, half, textureBaseline, memory, firstDisk, movedDisk, sunsetDisk, hiddenDisk };
		} finally {
			renderer.setRenderTarget( previousTarget );
			diskTarget?.dispose();
			if ( diskDome ) diskScene.remove( diskDome );
			// Do not dispose the clone's shared geometry or material.
			try {
				await update( original.elevation, original.illuminance, original.azimuth );
			} finally {
				await renderer.setAnimationLoop( animation );
			}
		}
	} );
	report.measurements = measurements;
	for ( const state of measurements.elevations ) {
		for ( const key of [ 'atmosphereDir', 'lightDir', 'waterDir' ] ) closeArray( state[ key ], state.skyDir, 1e-6, `${ state.elevation }° ${ key }` );
		for ( const key of [ 'sunColor', 'lightColor', 'waterSunColor', 'skyIrradiance', 'waterIrradiance' ] ) finiteColour( state[ key ], `${ state.elevation }° ${ key }` );
		closeArray( state.lightColor, state.sunColor, 1e-6, 'Direct light shares solar irradiance' );
		closeArray( state.waterSunColor, state.sunColor, 1e-6, 'Water shares solar irradiance' );
		assert.ok( Number.isFinite( state.sunIntoWater ) && state.sunIntoWater >= 0 && state.sunIntoWater <= 1 );
		assert.ok( Number.isFinite( state.muSun ) && state.muSun >= 0 && state.muSun <= 1 );
		if ( state.elevation < 0 ) assert.equal( state.sunIntoWater, 0, 'No direct sunlight enters the sea below the horizon' );
		// The key fades with the drawn disk (twice the true sun, 0.54 degree radius) as it sinks,
		// not at its centre (Atmosphere.sunlightAt): at -0.5 degrees its upper limb still shines.
		// Earth blocks the sunlight completely once the whole drawn disk has set.
		if ( state.elevation < - 0.54 ) assert.ok( state.sunColor.every( ( c ) => c <= 1e-6 ), 'Earth blocks direct sunlight once the drawn disk has set' );
	}
	const sunAt = ( elevation ) => measurements.elevations.find( ( state ) => state.elevation === elevation ).sunColor;
	sunAt( - 0.5 ).forEach( ( c, i ) => assert.ok( c < sunAt( 0 )[ i ] * 0.1, `A sinking disk fades the direct sunlight[${ i }]: ${ c } vs ${ sunAt( 0 )[ i ] }` ) );
	checks.push( 'Shared solar direction, finite nonnegative irradiance and planet occlusion at 32°, +0.5°, 0°, −0.5° (fading with the drawn disk) and −5°' );
	for ( const key of [ 'sunColor', 'lightColor', 'waterSunColor', 'skyIrradiance', 'waterIrradiance' ] ) halfRadiance( measurements.half[ key ], measurements.full[ key ], key );
	assert.ok( measurements.full.radiance.finite && measurements.half.radiance.finite );
	assert.ok( measurements.full.radiance.minimum >= 0 && measurements.half.radiance.minimum >= 0 );
	halfRadiance( measurements.half.radiance.rgb, measurements.full.radiance.rgb, 'GPU sky radiance' );
	checks.push( 'Halving solar illuminance halves GPU sky radiance, sky irradiance, direct light and water lighting within 5%' );
	assert.ok( measurements.memory.every( ( n ) => n <= measurements.textureBaseline + 2 ), `Texture targets accumulate: ${ measurements.textureBaseline } → ${ measurements.memory }` );
	assert.ok( measurements.memory.at( - 1 ) <= measurements.textureBaseline + 1 );
	checks.push( 'Twelve sky and PMREM updates do not retain a growing number of GPU textures after warmup' );
	for ( const disk of [ measurements.firstDisk, measurements.movedDisk ] ) {
		assert.ok( disk.finite && disk.count > 0, 'HDR render must contain a visible solar disk' );
		closeArray( disk.centroid, disk.projected, 1, 'Solar disk matches directional projection within one pixel' );
	}
	closeArray( measurements.firstDisk.centroid, measurements.movedDisk.centroid, 1, 'Solar disk does not move when the camera translates' );
	checks.push( 'The HDR solar disk matches its projected direction within one pixel before and after a 150 m × 50 m camera translation' );
	assert.ok( measurements.sunsetDisk.finite && measurements.sunsetDisk.count > 0, 'Upper solar rim remains visible with its centre at −0.3°' );
	assert.ok( measurements.hiddenDisk.finite && measurements.hiddenDisk.count === 0, 'The disk is fully hidden at −0.8°' );
	checks.push( 'A partial solar disk survives at −0.3° and disappears at −0.8°' );
	assert.deepEqual( errors, [] );
	assert.deepEqual( failures, [] );
	console.log( JSON.stringify( { checks, errors, failures, textureCounts: measurements.memory } ) );
} catch ( error ) {
	report.failure = error.stack || String( error );
	throw error;
} finally {
	await writeFile( `${ out }/sky-report.json`, JSON.stringify( report, null, 2 ) );
	await browser.close();
}
