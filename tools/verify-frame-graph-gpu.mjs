// GPU probe of the frame graph's compile path (src/post/graph/Compile.ts, ThreePatches.ts) and its
// warm-up. Needs the dev server (it imports src modules into the page):
//   node tools/verify-frame-graph-gpu.mjs http://127.0.0.1:5190
//
// 1. MRT cache keys, on fresh renderers in a bare page. One material is drawn into a single
//    target without an MRT and into a two-attachment target with mrt( { output, velocity } ), in
//    both orders; then again with each draw compiled first through the warm-up's compile
//    (`compileInto`, under the draw's target and MRT), whose draw must then create no pipeline.
//    Each draw's fragment shader must have the outputs its target has (one, or two) and every
//    attachment the values the material writes. With the cache-key patches installed
//    (`installCacheKeyPatches`, as main.ts does), all must pass. Two controls show that the probe
//    sees the faults it guards against: the same MRT drawn into two targets of one layout whose
//    attachments are named in the other order (unpatched three serves the first draw's shader to
//    the second, whose outputs land in the wrong attachments), and a scene of two meshes compiled
//    with three's own compileAsync under the MRT (the second mesh builds after the MRT is unbound,
//    without the velocity output), beside the same scene through `compileInto`, which must pass.
//    The controls must fail where they are expected to.
// 2. The app (`?debug`): the cache-key patches installed on its renderer, the warm-up done
//    (FrameGraph.warmStats), and no pipeline created in the 60 frames after its first 60.
// Shared GPU lock (no timing), headless (CHROME_PATH or Playwright's Chromium).

import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { acquireGpuLock } from './gpu-lock.mjs';

const base = ( process.argv[ 2 ] || 'http://127.0.0.1:5190' ).replace( /\/$/, '' );
await acquireGpuLock( 'verify-frame-graph-gpu', { shared: true } );
const browser = await chromium.launch( {
	headless: true,
	...( process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' } ),
	args: [ '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu' ],
} );
const report = { mrt: null, app: null };
let failed = false;
const check = ( ok, what ) => {

	console.log( `${ ok ? 'ok  ' : 'FAIL' }  ${ what }` );
	if ( ! ok ) failed = true;

};

try {

	// ---- 1. MRT cache keys
	const page = await browser.newPage();
	const pageErrors = [];
	page.on( 'pageerror', ( e ) => pageErrors.push( e.message ) );
	// a bare page of the dev server's origin (a module's source), so src modules import
	await page.goto( `${ base }/src/post/graph/ThreePatches.ts` );
	report.mrt = await page.evaluate( probeMrt );
	for ( const c of report.mrt.cases ) check( c.pass === c.expected, `${ c.name }: ${ c.detail }${ c.expected ? '' : ' (a control: expected to fail)' }` );
	check( pageErrors.length === 0, `no page errors${ pageErrors.length ? `: ${ pageErrors.slice( 0, 3 ).join( '; ' ) }` : '' }` );
	await page.close();

	// ---- 2. the app
	const app = await browser.newPage( { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 } );
	const appErrors = [];
	app.on( 'pageerror', ( e ) => appErrors.push( `pageerror: ${ e.message }` ) );
	app.on( 'console', ( m ) => { if ( m.type() === 'error' ) appErrors.push( m.text() ); } );
	await app.goto( `${ base }/?debug&quality=high` );
	await app.waitForFunction( () => window.__PONLAI__?.renderer?.info?.frame > 0 && document.getElementById( 'loading' )?.classList.contains( 'done' ), null, { timeout: 180000, polling: 250 } );
	report.app = await app.evaluate( async () => {

		const s = window.__PONLAI__;
		const frames = ( n ) => new Promise( ( resolve ) => {

			const end = s.renderer.info.frame + n;
			const tick = () => s.renderer.info.frame >= end ? resolve() : requestAnimationFrame( tick );
			tick();

		} );
		await frames( 60 );
		const before = s.pipelines.total;
		const perFrame = [];
		for ( let i = 0; i < 60; i ++ ) {

			const n = s.pipelines.total;
			await frames( 1 );
			perFrame.push( s.pipelines.total - n );

		}
		const nodes = s.renderer._nodes;
		return {
			patched: Object.prototype.hasOwnProperty.call( nodes, 'getForRenderCacheKey' ),
			warm: s.pipeline.graph.warmStats,
			created: s.pipelines.total - before,
			perFrameMax: Math.max( ...perFrame ),
		};

	} );
	check( report.app.patched, 'the app\'s renderer has the cache-key patches' );
	check( report.app.warm !== null && report.app.warm.passes > 0 && ( report.app.warm.failed ?? [] ).length === 0, `the warm-up ran, nothing failed (${ JSON.stringify( report.app.warm ) })` );
	check( report.app.created === 0, `no pipeline in the 60 frames after the first 60 (${ report.app.created })` );
	check( appErrors.length === 0, `no errors in the app${ appErrors.length ? `: ${ appErrors.slice( 0, 3 ).join( '; ' ) }` : '' }` );
	report.appErrors = appErrors;

} finally {

	await browser.close();

}
await mkdir( 'artifacts/verification', { recursive: true } );
await writeFile( 'artifacts/verification/frame-graph-gpu.json', JSON.stringify( report, null, 2 ) );
assert.equal( failed, false, 'frame graph GPU probe failed' );

// ---------------------------------------------------------------- in the page

async function probeMrt() {

	// three as the dev server serves it to src modules (the same module instances)
	const source = await ( await fetch( '/src/post/graph/FrameGraph.ts' ) ).text();
	const url = ( name ) => source.match( new RegExp( `from\\s*["'](/[^"']*${ name }[^"']*)["']` ) )?.[ 1 ];
	const THREE = await import( url( 'three_webgpu' ) );
	const TSL = await import( url( 'three_tsl' ) );
	const { installCacheKeyPatches } = await import( '/src/post/graph/ThreePatches.ts' );
	const { compileInto } = await import( '/src/post/graph/Compile.ts' );

	const SIZE = 4;
	const COLOR = [ 0.25, 0.5, 0.75, 1 ], VELOCITY = [ 0.125, 0.25, 0.375, 0.5 ], CLEAR = [ 4, 4, 4, 4 ];
	const cases = [];
	let serial = 0;

	async function setup( patched ) {

		const renderer = new THREE.WebGPURenderer();
		await renderer.init();
		if ( patched && ! installCacheKeyPatches( renderer ) ) throw new Error( 'installCacheKeyPatches failed' );
		renderer.setClearColor( new THREE.Color( CLEAR[ 0 ], CLEAR[ 1 ], CLEAR[ 2 ] ), CLEAR[ 3 ] );
		const device = renderer.backend.device;
		// fragment shader modules by label, and pipelines created
		const modules = new Map();
		const counts = { pipelines: 0, errors: [] };
		const createShaderModule = device.createShaderModule.bind( device );
		device.createShaderModule = ( d ) => {

			modules.set( d.label, d.code );
			return createShaderModule( d );

		};
		for ( const method of [ 'createRenderPipeline', 'createRenderPipelineAsync' ] ) {

			const original = device[ method ].bind( device );
			device[ method ] = ( d ) => {

				counts.pipelines ++;
				return original( d );

			};

		}
		device.addEventListener( 'uncapturederror', ( e ) => counts.errors.push( e.error.message.split( '\n' )[ 0 ] ) );
		renderer.onError = ( e ) => counts.errors.push( String( e?.message ?? e ).split( '\n' )[ 0 ] );
		return { renderer, modules, counts };

	}

	const target = ( names ) => {

		const rt = new THREE.RenderTarget( SIZE, SIZE, { count: names.length, type: THREE.HalfFloatType, depthBuffer: false } );
		names.forEach( ( name, i ) => { rt.textures[ i ].name = name; } );
		return rt;

	};
	// one material per case, named for its shader modules; the MRT's velocity is a constant
	const material = () => {

		const m = new THREE.MeshBasicNodeMaterial();
		m.name = `probe${ ++ serial }`;
		m.colorNode = TSL.vec4( ...COLOR );
		return m;

	};
	const velocityMrt = () => TSL.mrt( { output: TSL.output, velocity: TSL.vec4( ...VELOCITY ) } );

	async function read( renderer, rt, index ) {

		const data = await renderer.readRenderTargetPixelsAsync( rt, 1, 1, 1, 1, index );
		return Array.from( data.slice( 0, 4 ), ( h ) => + THREE.DataUtils.fromHalfFloat( h ).toFixed( 3 ) );

	}
	const near = ( a, b ) => a.every( ( v, i ) => Math.abs( v - b[ i ] ) < 2e-3 );
	const outputs = ( code ) => ( code?.match( /@location\(\s*\d+\s*\)/g ) ?? [] ).length;
	// the fragment code a draw of `m` built most recently (three labels it fragment_<name>)
	const fragment = ( env, m ) => env.modules.get( `fragment_${ m.name }` );

	async function draw( env, quad, rt, mrt ) {

		const { renderer } = env;
		renderer.setRenderTarget( rt );
		renderer.setMRT( mrt );
		renderer.autoClear = true;
		quad.render( renderer );
		renderer.setRenderTarget( null );
		renderer.setMRT( null );

	}

	async function verifyDraw( env, m, rt, names ) {

		const got = [];
		for ( let i = 0; i < names.length; i ++ ) got.push( await read( env.renderer, rt, i ) );
		const want = names.map( ( n ) => n === 'velocity' ? VELOCITY : COLOR );
		const count = outputs( fragment( env, m ) );
		return { ok: count === names.length && got.every( ( v, i ) => near( v, want[ i ] ) ), count, got };

	}

	// the material drawn without and with the MRT, in `order`; `warm`: each draw compiled first
	// through the warm-up's compile under its own target and MRT, the draw then creating no pipeline
	async function orders( patched, order, warm ) {

		const env = await setup( patched );
		const m = material();
		const quad = new THREE.QuadMesh( m );
		const single = target( [ 'output' ] ), double = target( [ 'output', 'velocity' ] );
		const mrt = velocityMrt();
		const steps = order === 'plain-first' ? [ [ single, null, [ 'output' ] ], [ double, mrt, [ 'output', 'velocity' ] ] ] : [ [ double, mrt, [ 'output', 'velocity' ] ], [ single, null, [ 'output' ] ] ];
		const results = [];
		for ( const [ rt, mrtNode, names ] of steps ) {

			if ( warm ) await compileInto( env.renderer, quad, quad.camera, rt, null, mrtNode );
			const pipelinesBefore = env.counts.pipelines;
			await draw( env, quad, rt, mrtNode );
			const r = await verifyDraw( env, m, rt, names );
			results.push( { ...r, attachments: names.length, pipelinesAtDraw: env.counts.pipelines - pipelinesBefore } );

		}
		const ok = results.every( ( r ) => r.ok && ( ! warm || r.pipelinesAtDraw === 0 ) ) && env.counts.errors.length === 0;
		const detail = results.map( ( r ) => `${ r.attachments } attachment(s): ${ r.count } output(s)${ warm ? `, ${ r.pipelinesAtDraw } pipeline(s) at the draw` : '' }` ).join( ', then ' ) + ( env.counts.errors.length ? `; errors: ${ env.counts.errors.slice( 0, 2 ).join( '; ' ) }` : '' );
		env.renderer.dispose();
		return { ok, detail, results };

	}

	for ( const warm of [ false, true ] ) for ( const order of [ 'plain-first', 'mrt-first' ] ) {

		const r = await orders( true, order, warm );
		cases.push( { name: `${ warm ? 'warmed' : 'drawn' }, ${ order }`, expected: true, pass: r.ok, detail: r.detail, results: r.results } );

	}

	// control: one material drawn by two meshes into two targets of one layout, their attachments
	// named in the other order (one render context: unpatched, the second mesh's draw is served the
	// first one's shader, whose outputs go by the first target's names)
	async function swapped( patched ) {

		const env = await setup( patched );
		const m = material();
		const a = target( [ 'output', 'velocity' ] ), b = target( [ 'velocity', 'output' ] );
		const mrt = velocityMrt();
		await draw( env, new THREE.QuadMesh( m ), a, mrt );
		const first = await verifyDraw( env, m, a, [ 'output', 'velocity' ] );
		await draw( env, new THREE.QuadMesh( m ), b, mrt );
		const got = [ await read( env.renderer, b, 0 ), await read( env.renderer, b, 1 ) ];
		const ok = first.ok && near( got[ 0 ], VELOCITY ) && near( got[ 1 ], COLOR ) && env.counts.errors.length === 0;
		env.renderer.dispose();
		return { ok, detail: `the second target's attachments (velocity, output) read ${ JSON.stringify( got ) }` };

	}
	for ( const patched of [ false, true ] ) {

		const r = await swapped( patched );
		cases.push( { name: `attachments named in another order, ${ patched ? 'patched' : 'unpatched' }`, expected: patched, pass: r.ok, detail: r.detail } );

	}

	// a scene of two meshes compiled under the MRT: three's own compileAsync builds the second one
	// after an await, once the MRT is unbound (a control: its shader lacks the velocity output);
	// the warm-up's compile builds both under it
	for ( const bound of [ false, true ] ) {

		const env = await setup( true );
		const scene = new THREE.Scene();
		const camera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );
		// (two shaders: materials of one code would share the first one's program)
		const ms = [ material(), material() ];
		ms[ 1 ].colorNode = TSL.vec4( ...VELOCITY );
		for ( const m of ms ) {

			const mesh = new THREE.Mesh( new THREE.PlaneGeometry( 2, 2 ), m );
			mesh.frustumCulled = false;
			scene.add( mesh );

		}
		const double = target( [ 'output', 'velocity' ] );
		const mrt = velocityMrt();
		if ( bound ) await compileInto( env.renderer, scene, camera, double, null, mrt );
		else {

			env.renderer.setRenderTarget( double );
			env.renderer.setMRT( mrt );
			const compiling = env.renderer.compileAsync( scene, camera );
			env.renderer.setRenderTarget( null );
			env.renderer.setMRT( null );
			await compiling;

		}
		const counts = ms.map( ( m ) => outputs( fragment( env, m ) ) );
		cases.push( { name: `${ bound ? 'compileInto' : 'compileAsync' } of a two-mesh scene under the MRT`, expected: bound, pass: counts.every( ( c ) => c === 2 ) && env.counts.errors.length === 0, detail: `fragment outputs ${ JSON.stringify( counts ) } for 2 attachments` } );
		env.renderer.dispose();

	}
	return { cases };

}
