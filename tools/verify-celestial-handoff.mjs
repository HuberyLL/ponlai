// Regression for the sun/moon key light handoff. The key light, grade and sky follow the clock
// every frame, so a sweep through the handoff band must carry zero direct energy while the
// key turns from one body to the other, and every frame must show the clock's own state: by day
// the key is the sun's direction, by night it holds where the moon stands (DayCycle.ts MOON), and
// over the handoff it turns from the one to the other (DayCycle `keyDir`, which Sky.ts takes).
// Each sample is read after a rendered frame of its clock (tools/page-eval.mjs, "Rendered frames").
// Run against the dev server:
// node tools/verify-celestial-handoff.mjs http://127.0.0.1:5190
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { acquireGpuLock } from './gpu-lock.mjs';
import { installWaitFrames } from './page-eval.mjs';
import { HANDOFF_TOP, MOON_KEY_TOP } from '../src/look/DayLook.ts';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.argv[ 2 ] || 'http://127.0.0.1:5190';
const errors = [];
const report = { base, errors, runs: [] };
// shared with other probes (their pixels do not depend on the GPU load), never during a timing
// run (tools/gpu-lock.mjs; released when the process exits)
await acquireGpuLock( 'verify-celestial-handoff', { shared: true } );
const browser = await chromium.launch( {
	headless: true,
	...( process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' } ),
	args: [ '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu' ],
} );

try {

	const page = await browser.newPage( { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 } );
	await installWaitFrames( page );
	page.on( 'pageerror', ( error ) => errors.push( error.message ) );
	page.on( 'console', ( message ) => { if ( message.type() === 'error' ) errors.push( message.text() ); } );
	const url = new URL( base );
	url.search = 'debug&paused&t=12&dpr=1';
	await page.goto( url.href );
	await page.waitForFunction( () => window.__PONLAI__?.sky?.grade && window.__THREE_GAME_DIAGNOSTICS__?.frame > 30, null, { timeout: 90000 } );
	const result = await page.evaluate( async () => {

		const s = window.__PONLAI__;
		s.dayCycle.paused = true;
		s.dayCycle.moonPhase = 0.5;
		await s.setWeather( 'clear', 0 );
		// the page's next rendered frame (tools/page-eval.mjs WAIT_FRAMES)
		const frame = () => window.__waitFrames( 1 );
		// the key's direction at this clock, as Sky.ts takes it from the same snapshot
		const clockKey = ( clock ) => clock.keyDir;
		const read = () => {

			const clock = s.dayCycle.snapshot();
			return {
				hour: clock.hour, elevation: clock.elevation, clockKey: clockKey( clock ).toArray(),
				clockGrade: { exposure: clock.exposure, daylight: clock.daylight },
				dir: s.sky.keyDir.toArray(), color: s.sky.keyColor.toArray(),
				grade: { ...s.sky.grade }, exposure: s.pipeline.settings.exposure,
			};

		};
		const runs = [];
		// Sunset and sunrise handoffs, plus long same-source moves.
		const cases = [
			{ from: 17.6, to: 18.6, kind: 'handoff' }, { from: 5.4, to: 6.4, kind: 'handoff' },
			{ from: 10, to: 12, kind: 'same-sun' }, { from: 22, to: 24, kind: 'same-moon' },
		];
		for ( const { from, to, kind } of cases ) {

			await s.setHour( from );
			const samples = [];
			for ( let i = 0; i <= 80; i ++ ) {

				s.dayCycle.setHour( from + ( to - from ) * i / 80 );
				await frame();
				samples.push( read() );

			}
			runs.push( { from, to, kind, samples } );

		}
		await s.refreshEnvironment();
		return { runs, diagnostics: window.__THREE_GAME_DIAGNOSTICS__ };

	} );
	Object.assign( report, result );
	const angle = ( a, b ) => Math.acos( Math.min( 1, Math.max( - 1, a[ 0 ] * b[ 0 ] + a[ 1 ] * b[ 1 ] + a[ 2 ] * b[ 2 ] ) ) ) * 180 / Math.PI;
	const energy = ( c ) => c[ 0 ] + c[ 1 ] + c[ 2 ];
	for ( const run of report.runs ) {

		let turned = 0;
		for ( const [ index, sample ] of run.samples.entries() ) {

			assert.ok( sample.dir.every( Number.isFinite ) );
			assert.ok( Math.abs( Math.hypot( ...sample.dir ) - 1 ) < 1e-8 );
			assert.ok( angle( sample.dir, sample.clockKey ) < 1e-4, 'The key light must follow the clock on the same frame' );
			for ( const key of [ 'exposure', 'daylight' ] ) {

				assert.ok( Math.abs( sample.grade[ key ] - sample.clockGrade[ key ] ) < 1e-8, `${ key } must follow the clock on the same frame` );

			}
			assert.ok( Math.abs( sample.exposure - sample.grade.exposure ) < 1e-8, 'Main exposure must use the displayed sky grade' );
			// The band runs from just above the sun's last light (a tenth of a degree over DayCycle's
			// HANDOFF_TOP) down to where the key has turned to the moon and the moon's key starts to
			// rise (MOON_KEY_TOP).
			if ( sample.elevation < HANDOFF_TOP + 0.1 && sample.elevation > MOON_KEY_TOP ) {

				assert.deepEqual( sample.color, [ 0, 0, 0 ], 'The handoff band must carry zero direct energy' );

			}
			if ( index > 0 ) {

				const previous = run.samples[ index - 1 ];
				const step = angle( previous.dir, sample.dir );
				turned = Math.max( turned, step );
				// The key turns faster than the clock only while it rotates between bodies.
				if ( step > 2 ) assert.ok( energy( previous.color ) === 0 && energy( sample.color ) === 0, 'A turning key must be dark' );

			}

		}
		if ( run.kind !== 'handoff' ) {

			assert.ok( run.samples.every( ( sample ) => energy( sample.color ) > 0 ), `${ run.kind } stays lit throughout` );

		} else {

			assert.ok( turned > 2, 'The handoff must rotate the key between the bodies' );

		}

	}
	assert.deepEqual( errors, [] );
	console.log( JSON.stringify( { runs: report.runs.map( ( run ) => ( { from: run.from, to: run.to, kind: run.kind,
		samples: run.samples.length, zeroEnergySamples: run.samples.filter( ( sample ) => sample.color.every( ( value ) => value === 0 ) ).length } ) ), errors } ) );

} finally {

	await mkdir( 'artifacts/verification', { recursive: true } );
	await writeFile( 'artifacts/verification/celestial-handoff.json', JSON.stringify( report, null, 2 ) );
	await browser.close();

}
