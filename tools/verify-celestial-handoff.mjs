// Regression for a fast clock skipping the sun/moon controller's dark handoff interval.
// Run against the dev server: node tools/verify-celestial-handoff.mjs http://127.0.0.1:5190
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.argv[ 2 ] || 'http://127.0.0.1:5190';
const errors = [];
const report = { base, errors, runs: [] };
const browser = await chromium.launch( {
	headless: true,
	...( process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' } ),
	args: [ '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu' ],
} );

try {

	const page = await browser.newPage( { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 } );
	page.on( 'pageerror', ( error ) => errors.push( error.message ) );
	page.on( 'console', ( message ) => { if ( message.type() === 'error' ) errors.push( message.text() ); } );
	const url = new URL( base );
	url.search = 'debug&paused&t=12&dpr=1';
	await page.goto( url.href );
	await page.waitForFunction( () => window.__SOOMI__?.sky?.grade && window.__THREE_GAME_DIAGNOSTICS__?.frame > 30, null, { timeout: 90000 } );
	const result = await page.evaluate( async () => {

		const s = window.__SOOMI__;
		s.dayCycle.paused = true;
		s.dayCycle.moonPhase = 0.5;
		await s.setWeather( 'clear', 0 );
		const read = () => ( {
			amount: s.sky.blend.value, dir: s.sky.keyDir.toArray(), color: s.sky.keyColor.toArray(),
			grade: { ...s.sky.grade }, exposure: s.pipeline.settings.exposure, transitioning: s.sky.transitioning,
		} );
		const runs = [];
		// A 30-second day advances 0.4 hours per 0.5-second bake. Also exercise a larger
		// skipped interval and the reverse sunrise handoff with nonzero endpoint radiance.
		// Long same-source steps model a low frame rate with the fastest allowed day.
		// They must preserve direct energy even though their angular motion exceeds 15°.
		const cases = [
			{ from: 17.8, to: 18.2, kind: 'handoff' }, { from: 17.8, to: 18.5, kind: 'handoff' },
			{ from: 5.5, to: 6.2, kind: 'handoff' }, { from: 10, to: 12, kind: 'same-sun' },
			{ from: 22, to: 0, kind: 'same-moon' },
		];
		for ( const { from, to, kind } of cases ) {

			await s.setHour( from );
			await new Promise( ( resolve ) => requestAnimationFrame( resolve ) );
			const before = read();
			s.dayCycle.setHour( to );
			const destination = s.dayCycle.snapshot();
			const cosine = destination.keyDir.x * before.dir[ 0 ] + destination.keyDir.y * before.dir[ 1 ] + destination.keyDir.z * before.dir[ 2 ];
			// Keep the scheduler's clock unchanged while explicitly exercising its two baked
			// endpoints, so it cannot start a second identical transition during our samples.
			s.dayCycle.setHour( from );
			s.sky.setCelestial( destination );
			const pending = s.sky.update( 0.6 );
			const duringBake = read();
			await pending;
			const initial = read();
			const samples = [];
			const end = performance.now() + 5000;
			do {

				await new Promise( ( resolve ) => requestAnimationFrame( resolve ) );
				samples.push( read() );

			} while ( s.sky.transitioning && performance.now() < end );
			runs.push( { from, to, kind, before, duringBake, initial,
				angle: Math.acos( Math.min( 1, Math.max( - 1, cosine ) ) ) * 180 / Math.PI,
				expectedGrade: { exposure: destination.exposure, blackLift: destination.blackLift, daylight: destination.daylight }, samples } );
			await s.refreshEnvironment();

		}
		return { runs, diagnostics: window.__THREE_GAME_DIAGNOSTICS__ };

	} );
	Object.assign( report, result );
	for ( const run of report.runs ) {

		assert.deepEqual( run.duringBake.grade, run.before.grade, 'Pending bake must retain the displayed grade' );
		assert.deepEqual( run.initial.grade, run.before.grade, 'Transition must start with the old displayed grade' );
		const middle = run.samples.filter( ( sample ) => sample.amount >= 0.2 && sample.amount <= 0.8 );
		assert.ok( middle.length >= 2, 'Transition must have multiple middle samples' );
		const finalColor = run.samples.at( - 1 ).color;
		if ( run.kind !== 'handoff' ) {

			assert.ok( run.angle > 15, `${ run.kind } must exercise a large direction change` );
			assert.ok( run.before.color.every( ( value ) => value > 0 ) && finalColor.every( ( value ) => value > 0 ),
				`${ run.kind } needs two illuminated endpoints` );

		}
		for ( const sample of run.samples ) {

			assert.ok( sample.dir.every( Number.isFinite ) );
			assert.ok( Math.abs( Math.hypot( ...sample.dir ) - 1 ) < 1e-8 );
			if ( run.kind === 'handoff' && sample.amount >= 0.2 && sample.amount <= 0.8 ) {

				assert.deepEqual( sample.color, [ 0, 0, 0 ], 'Changing the primary source must carry zero energy' );

			} else if ( run.kind !== 'handoff' ) {

				for ( let channel = 0; channel < 3; channel ++ ) {

					const expected = run.before.color[ channel ] + ( finalColor[ channel ] - run.before.color[ channel ] ) * sample.amount;
					assert.ok( Math.abs( sample.color[ channel ] - expected ) < 1e-8,
						`${ run.kind } must retain interpolated direct energy at blend ${ sample.amount }` );

				}

			}
			for ( const key of [ 'exposure', 'blackLift', 'daylight' ] ) {

				const expected = run.before.grade[ key ] + ( run.expectedGrade[ key ] - run.before.grade[ key ] ) * sample.amount;
				assert.ok( Math.abs( sample.grade[ key ] - expected ) < 1e-8, `${ key } must use the displayed blend` );

			}
			assert.ok( Math.abs( sample.exposure - sample.grade.exposure ) < 1e-8, 'Main exposure must use the displayed sky grade' );

		}
		assert.equal( run.samples.at( - 1 ).transitioning, false, 'Handoff must complete' );

	}
	assert.deepEqual( errors, [] );
	console.log( JSON.stringify( { runs: report.runs.map( ( run ) => ( { from: run.from, to: run.to, kind: run.kind,
		angle: run.angle, samples: run.samples.length, zeroEnergySamples: run.samples.filter( ( sample ) => sample.color.every( ( value ) => value === 0 ) ).length } ) ), errors } ) );

} finally {

	await mkdir( 'artifacts/verification', { recursive: true } );
	await writeFile( 'artifacts/verification/celestial-handoff.json', JSON.stringify( report, null, 2 ) );
	await browser.close();

}
