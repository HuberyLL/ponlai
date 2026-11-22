// Checks on the GPU that three draws the frame graph's passes into their MRT layouts as the graph expects.
//
// It covers the frame graph's compile path (packages/render/post/graph/Compile.ts, the cache-key
// patches in packages/render/three/ThreePatches.ts) and its warm-up, the blends per attachment the
// temporal modes rest on, and the app's own materials under their passes' MRT. The graph's
// compiler and runtime on the CPU are checked by tools/render/verify-framegraph.mjs. Run it after a
// change to the patches, the graph's compile or warm-up, the motion MRTs, or an upgrade of three
// (packages/render/three/README.md).
//
// Usage:
//   node tools/render/verify-frame-graph-gpu.mjs [url]
//
// Options:
//   url   the dev server (default http://127.0.0.1:5190); it imports the source modules into the page
//
// What it checks, each a failure when broken:
// 1. MRT cache keys, on fresh renderers in a bare page. One material is drawn into a single
//    target without an MRT and into a two-attachment target with mrt( { output, velocity } ), in
//    both orders; then again with each draw compiled first through the warm-up's compile
//    (`compileInto`, under the draw's target and MRT), whose draw must then create no pipeline.
//    Each draw's fragment shader must have the outputs its target has (one, or two) and every
//    attachment the values the material writes. With the cache-key patches installed
//    (`installCacheKeyPatches`, as main.ts does), all must pass. A control shows that the probe
//    sees the fault it guards against: the same MRT drawn into two targets of one layout whose
//    attachments are named in the other order (unpatched three serves the first draw's shader to
//    the second, whose outputs land in the wrong attachments); it must fail. A scene of two meshes
//    is compiled under the MRT with three's own compileAsync (since r187 it builds each draw under
//    the binding it was called with, so the MRT is unbound before the second mesh builds) and
//    through `compileInto`; both must give each mesh the velocity output.
// 2. What the temporal frame graph rests on, in three r187 (bare page, patched renderer): blending
//    per attachment comes only from the renderer's context MRT, here Motion.ts's sceneMRT and
//    overlayMRT, the passes' own. Into a two-attachment target
//    (`sceneColor`, `velocity`, half float, as the graph names them), each read back:
//    - the scene MRT's clear: the colour takes the renderer's clear colour, the velocity its own
//      clear colour (0, 0, 1, 0);
//    - a base draw writes its velocity; an overlay drawn under the overlay MRT (the colour with the
//      material's blending, the velocity kept: colour Zero / One, alpha One / One with Max) leaves
//      the velocity's rgb as the base wrote it and its alpha the larger of the two, whether the
//      material's velocity comes from its own mrtNode or from a fragmentNode's outputStruct (the
//      rain's and the spray's), and a smaller alpha after it leaves the larger;
//    - a transparent additive material under the scene MRT (no blend mode of its own for the
//      velocity) overwrites the velocity while its colour adds;
//    - `renderer.copyTextureToTexture` between single-sampled render-target textures, RGBA16F and
//      R32F, copies every texel exactly.
// 3. The app (`?debug`), in its default mode and under taa: the cache-key patches installed on its
//    renderer, the warm-up done (FrameGraph.warmStats), and no pipeline created in the 60 frames
//    after its first 60.
// 4. The app's own materials (the taa page): a vegetation mesh with its depth copy (the meadow's
//    near draw, a plain mesh whose blades its compute pass generates in the probe's renderer for
//    the probe's camera and draws from indirect arguments), under a shadow-casting sun (whose pass
//    builds their nodes without an MRT), and the storm's spray, each
//    drawn by a fresh patched renderer into a plain target and into its pass's layout and MRT (the
//    scene MRT; the spray's after-resolve MRT), in both orders, drawn and warmed (`compileInto`
//    first). Each draw needs its own pipeline (a warmed one none), a fragment shader with one output
//    per attachment, and the vegetation's velocity its motion class over a tenth of the target.
//
// Output: on stdout, `ok` or `FAIL` per check; the report as JSON in
// artifacts/verification/frame-graph-gpu.json.
//
// GPU lock and browser: takes the GPU lock shared (docs/reference/gpu-lock.md; it measures no time)
// and opens headless Chrome (CHROME_PATH, else Playwright's Chromium). It needs the dev server: on
// any other server it stops before the lock (tools/kit/dev-server.mjs).
//
// Cost: a few bare pages, and two loads of the app (its default mode and taa) of 120 frames each.
//
// Exit codes: 0 every check passes; 1 a check failed (the final assertion is thrown), a page threw,
// or the url is not the dev server.
import '../kit/help.mjs';

import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { acquireGpuLock } from '../kit/gpu-lock.mjs';
import { requireDevServer } from '../kit/dev-server.mjs';
import { reviewUrl } from '../kit/page-query.mjs';

const base = ( process.argv[ 2 ] || 'http://127.0.0.1:5190' ).replace( /\/$/, '' );
await requireDevServer( process.argv[ 2 ] || 'http://127.0.0.1:5190', 'verify-frame-graph-gpu' );
await acquireGpuLock( 'verify-frame-graph-gpu', { shared: true } );
const browser = await chromium.launch( {
	headless: true,
	...( process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' } ),
	args: [ '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu' ],
} );
const report = { mrt: null, temporal: null, app: null, real: null };
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
	await page.goto( `${ base }/packages/render/three/ThreePatches.ts` );
	report.mrt = await page.evaluate( probeMrt );
	for ( const c of report.mrt.cases ) check( c.pass === c.expected, `${ c.name }: ${ c.detail }${ c.expected ? '' : ' (a control: expected to fail)' }` );

	// ---- 2. the temporal graph's blends and copies
	report.temporal = await page.evaluate( probeTemporal );
	for ( const c of report.temporal.cases ) check( c.pass, `${ c.name }: ${ c.detail }` );
	check( pageErrors.length === 0, `no page errors${ pageErrors.length ? `: ${ pageErrors.slice( 0, 3 ).join( '; ' ) }` : '' }` );
	await page.close();

	// ---- 3. the app, in its default mode and under taa; 4. the real materials (taa page)
	for ( const aa of [ null, 'taa' ] ) {

		const app = await browser.newPage( { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 } );
		const appErrors = [];
		app.on( 'pageerror', ( e ) => appErrors.push( `pageerror: ${ e.message }` ) );
		app.on( 'console', ( m ) => { if ( m.type() === 'error' ) appErrors.push( m.text() ); } );
		await app.goto( reviewUrl( `${ base }/?debug&quality=high${ aa ? `&aa=${ aa }` : '' }` ) );
		await app.waitForFunction( () => window.__PONLAI__?.renderer?.info?.frame > 0 && document.getElementById( 'loading' )?.classList.contains( 'done' ), null, { timeout: 180000, polling: 250 } );
		const result = await app.evaluate( async () => {

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
		const mode = aa ?? 'default mode';
		check( result.patched, `${ mode }: the app's renderer has the cache-key patches` );
		check( result.warm !== null && result.warm.passes > 0 && ( result.warm.failed ?? [] ).length === 0, `${ mode }: the warm-up ran, nothing failed (${ JSON.stringify( result.warm ) })` );
		check( result.created === 0, `${ mode }: no pipeline in the 60 frames after the first 60 (${ result.created })` );
		if ( aa === 'taa' ) {

			report.real = await app.evaluate( probeReal );
			for ( const c of report.real.cases ) check( c.pass, `${ c.name }: ${ c.detail }` );

		}
		check( appErrors.length === 0, `${ mode }: no errors in the app${ appErrors.length ? `: ${ appErrors.slice( 0, 3 ).join( '; ' ) }` : '' }` );
		report.app = { ...report.app, [ mode ]: { ...result, errors: appErrors } };
		await app.close();

	}

} finally {

	await browser.close();

}
await mkdir( 'artifacts/verification', { recursive: true } );
await writeFile( 'artifacts/verification/frame-graph-gpu.json', JSON.stringify( report, null, 2 ) );
assert.equal( failed, false, 'frame graph GPU probe failed' );

// ---------------------------------------------------------------- in the page

async function probeMrt() {

	// three as the dev server serves it to src modules (the same module instances)
	const source = await ( await fetch( '/packages/render/post/graph/FrameGraph.ts' ) ).text();
	const url = ( name ) => source.match( new RegExp( `from\\s*["'](/[^"']*${ name }[^"']*)["']` ) )?.[ 1 ];
	const THREE = await import( url( 'three_webgpu' ) );
	const TSL = await import( url( 'three_tsl' ) );
	const { installCacheKeyPatches } = await import( '/packages/render/three/ThreePatches.ts' );
	const { compileInto } = await import( '/packages/render/post/graph/Compile.ts' );

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

	// a scene of two meshes compiled under the MRT, the MRT unbound before the second one builds:
	// three's own compileAsync (r187 builds each draw under the binding of its call) and the
	// warm-up's compile both build the two under it
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
		cases.push( { name: `${ bound ? 'compileInto' : 'compileAsync' } of a two-mesh scene under the MRT`, expected: true, pass: counts.every( ( c ) => c === 2 ) && env.counts.errors.length === 0, detail: `fragment outputs ${ JSON.stringify( counts ) } for 2 attachments` } );
		env.renderer.dispose();

	}
	return { cases };

}

async function probeTemporal() {

	const source = await ( await fetch( '/packages/render/post/graph/FrameGraph.ts' ) ).text();
	const url = ( name ) => source.match( new RegExp( `from\\s*["'](/[^"']*${ name }[^"']*)["']` ) )?.[ 1 ];
	const THREE = await import( url( 'three_webgpu' ) );
	const TSL = await import( url( 'three_tsl' ) );
	const { installCacheKeyPatches } = await import( '/packages/render/three/ThreePatches.ts' );

	const SIZE = 4;
	const CLEAR = [ 0.125, 0.25, 0.375, 1 ];
	// the base's colour and velocity, the overlays' and the additive draw's (halves represent them exactly)
	const C0 = [ 0.25, 0.5, 0.75, 1 ], V0 = [ 0.125, - 0.25, 0.375, 0.25 ];
	const C1 = [ 1, 0.5, 0, 0.5 ], V1 = [ 0.75, 0.75, 0.5, 0.625 ];
	const C2 = [ 0.5, 0.25, 0.125, 0.5 ], V2 = [ 0.875, 0.875, 0.875, 0.125 ];
	const C3 = [ 0.25, 0.125, 0.0625, 0.5 ], V3 = [ - 0.5, 0.5, 0.25, 0.75 ];
	const cases = [];

	const renderer = new THREE.WebGPURenderer();
	await renderer.init();
	if ( ! installCacheKeyPatches( renderer ) ) throw new Error( 'installCacheKeyPatches failed' );
	renderer.setClearColor( new THREE.Color( CLEAR[ 0 ], CLEAR[ 1 ], CLEAR[ 2 ] ), CLEAR[ 3 ] );
	const errors = [];
	renderer.backend.device.addEventListener( 'uncapturederror', ( e ) => errors.push( e.error.message.split( '\n' )[ 0 ] ) );
	renderer.onError = ( e ) => errors.push( String( e?.message ?? e ).split( '\n' )[ 0 ] );

	// the graph's scene target under the temporal modes: the colour and the motion vectors, named as
	// its resources (an MRT finds its outputs, and its blend modes, by the textures' names)
	const sceneTarget = () => {

		const rt = new THREE.RenderTarget( SIZE, SIZE, { count: 2, type: THREE.HalfFloatType, depthBuffer: false } );
		rt.textures[ 0 ].name = 'sceneColor';
		rt.textures[ 1 ].name = 'velocity';
		return rt;

	};
	// Motion.ts's MRTs: the scene MRT draws the colour with the material's blending, overwrites the
	// velocity (no blend mode) and clears it to ( 0, 0, 1, 0 ); the overlay MRT draws the colour with
	// the material's blending and keeps the velocity's rgb (Zero / One), its alpha the larger (One /
	// One, Max). Each material below gives its velocity through its own MRT node or outputStruct.
	const { sceneMRT, overlayMRT } = await import( '/packages/render/post/Motion.ts' );

	// a material writing a colour and (through its mrtNode) a velocity; `blending` makes it transparent
	const meshMaterial = ( colour, velocity, blending = null ) => {

		const m = new THREE.MeshBasicNodeMaterial();
		m.colorNode = TSL.vec4( ...colour );
		m.mrtNode = TSL.mrt( { velocity: TSL.vec4( ...velocity ) } );
		if ( blending !== null ) {

			m.transparent = true;
			m.blending = blending;
			m.depthWrite = false;
			m.opacity = 1;

		}
		return m;

	};
	// a fragmentNode material writing both attachments by position, as the rain's drops and the spray do
	const structMaterial = ( colour, velocity, blending ) => {

		const m = new THREE.NodeMaterial();
		m.fragmentNode = TSL.outputStruct( TSL.vec4( ...colour ), TSL.vec4( ...velocity ) );
		m.transparent = true;
		m.blending = blending;
		m.depthWrite = false;
		return m;

	};
	const draw = ( rt, mrt, material, clear ) => {

		renderer.setRenderTarget( rt );
		renderer.setMRT( mrt );
		renderer.autoClear = clear;
		new THREE.QuadMesh( material ).render( renderer );
		renderer.setRenderTarget( null );
		renderer.setMRT( null );

	};
	const clearOnly = ( rt, mrt ) => {

		renderer.setRenderTarget( rt );
		renderer.setMRT( mrt );
		renderer.autoClear = true;
		renderer.render( new THREE.Scene(), new THREE.OrthographicCamera() );
		renderer.setRenderTarget( null );
		renderer.setMRT( null );

	};
	// one texel's channels (a red target's one)
	const read = async ( rt, index ) => {

		const data = await renderer.readRenderTargetPixelsAsync( rt, 1, 1, 1, 1, index );
		const channels = rt.textures[ index ].format === THREE.RedFormat ? 1 : 4;
		return data instanceof Uint16Array ? Array.from( data.slice( 0, channels ), ( h ) => THREE.DataUtils.fromHalfFloat( h ) ) : Array.from( data.slice( 0, channels ) );

	};
	const near = ( a, b, e = 2e-3 ) => a.length === b.length && a.every( ( v, i ) => Math.abs( v - b[ i ] ) < e );
	const show = ( v ) => `[${ v.map( ( x ) => + x.toFixed( 4 ) ).join( ', ' ) }]`;
	const normal = ( dst, src ) => [ 0, 1, 2 ].map( ( i ) => src[ i ] * src[ 3 ] + dst[ i ] * ( 1 - src[ 3 ] ) ).concat( src[ 3 ] + dst[ 3 ] * ( 1 - src[ 3 ] ) );
	const additive = ( dst, src ) => [ 0, 1, 2 ].map( ( i ) => src[ i ] * src[ 3 ] + dst[ i ] ).concat( src[ 3 ] + dst[ 3 ] );
	const expect = async ( name, rt, colour, velocity ) => {

		const got = [ await read( rt, 0 ), await read( rt, 1 ) ];
		const pass = near( got[ 0 ], colour ) && near( got[ 1 ], velocity );
		cases.push( { name, pass, detail: `colour ${ show( got[ 0 ] ) } (want ${ show( colour ) }), velocity ${ show( got[ 1 ] ) } (want ${ show( velocity ) })` } );

	};

	// the scene MRT's clear
	const a = sceneTarget();
	clearOnly( a, sceneMRT );
	await expect( 'scene MRT clear: the renderer\'s clear colour, the velocity ( 0, 0, 1, 0 )', a, CLEAR, [ 0, 0, 1, 0 ] );
	// a base, then overlays under the overlay MRT
	draw( a, sceneMRT, meshMaterial( C0, V0 ), true );
	await expect( 'scene MRT base draw: its colour and velocity', a, C0, V0 );
	let colour = normal( C0, C1 );
	draw( a, overlayMRT, meshMaterial( C1, V1, THREE.NormalBlending ), false );
	await expect( 'overlay MRT, normal-blended mrtNode material: colour blended, velocity rgb kept, alpha max', a, colour, [ V0[ 0 ], V0[ 1 ], V0[ 2 ], Math.max( V0[ 3 ], V1[ 3 ] ) ] );
	colour = additive( colour, C2 );
	draw( a, overlayMRT, structMaterial( C2, V2, THREE.AdditiveBlending ), false );
	await expect( 'overlay MRT, additive outputStruct material with a smaller alpha: colour added, velocity unchanged', a, colour, [ V0[ 0 ], V0[ 1 ], V0[ 2 ], Math.max( V0[ 3 ], V1[ 3 ], V2[ 3 ] ) ] );
	// a transparent additive material under the scene MRT overwrites the velocity
	const b = sceneTarget();
	draw( b, sceneMRT, meshMaterial( C0, V0 ), true );
	draw( b, sceneMRT, meshMaterial( C3, V3, THREE.AdditiveBlending ), false );
	await expect( 'scene MRT, transparent additive material: colour added, velocity overwritten', b, additive( C0, C3 ), V3 );

	// copyTextureToTexture between single-sampled render-target textures
	const copyCase = async ( name, make, value ) => {

		const src = make(), dst = make();
		const m = new THREE.NodeMaterial();
		m.fragmentNode = TSL.vec4( ...value );
		draw( src, null, m, true );
		clearOnly( dst, null );
		renderer.copyTextureToTexture( src.texture, dst.texture );
		const got = await read( dst, 0 );
		const want = value.slice( 0, got.length );
		const exact = got.every( ( v, i ) => v === ( src.texture.type === THREE.FloatType ? Math.fround( want[ i ] ) : want[ i ] ) );
		cases.push( { name, pass: exact, detail: `${ show( got ) } (want ${ show( want ) }, exact)` } );

	};
	await copyCase( 'copyTextureToTexture, RGBA16F', () => new THREE.RenderTarget( SIZE, SIZE, { type: THREE.HalfFloatType, depthBuffer: false } ), [ 0.25, - 0.5, 0.75, 2.5 ] );
	await copyCase( 'copyTextureToTexture, R32F', () => new THREE.RenderTarget( SIZE, SIZE, { type: THREE.FloatType, format: THREE.RedFormat, depthBuffer: false } ), [ - 1234.5678, 0, 0, 1 ] );

	await renderer.backend.device.queue.onSubmittedWorkDone();
	cases.push( { name: 'no WebGPU errors', pass: errors.length === 0, detail: errors.length ? errors.slice( 0, 3 ).join( '; ' ) : 'none' } );
	renderer.dispose();
	return { cases };

}

// In the app's page under taa (dev server): the cache keys with the app's own materials, a
// vegetation mesh (its depth copy and its shaded draw, and a shadow pass over them, which builds
// their nodes without an MRT) and the storm's spray, each drawn by a fresh patched renderer into a
// plain target and into the target and MRT its pass draws with (the scene MRT; the spray's
// after-resolve MRT), in both orders, and again with each draw compiled first by the warm-up's
// compile (`compileInto`). Every draw of the material must have its own pipeline for its layout (a
// second draw into the other layout makes a new one; a warmed draw makes none), its fragment
// shader as many outputs as its target has attachments, and the vegetation's velocity its class.
async function probeReal() {

	const source = await ( await fetch( '/packages/render/post/graph/FrameGraph.ts' ) ).text();
	const url = ( name ) => source.match( new RegExp( `from\\s*["'](/[^"']*${ name }[^"']*)["']` ) )?.[ 1 ];
	const THREE = await import( url( 'three_webgpu' ) );
	const { installCacheKeyPatches } = await import( '/packages/render/three/ThreePatches.ts' );
	const { compileInto } = await import( '/packages/render/post/graph/Compile.ts' );
	const { sceneMRT, MOTION_CLASS } = await import( '/packages/render/post/Motion.ts' );
	const { afterMRT, RAIN_OVERLAY } = await import( '/packages/render/post/AfterResolve.ts' );
	const s = window.__PONLAI__;
	const SIZE = 64;
	const cases = [];

	// the subjects: a vegetation mesh with its depth copy, and the spray. The vegetation is the
	// meadow's near draw (Grass.ts): a plain mesh whose blades a compute pass generates for the view
	// it draws in, drawn from indirect arguments (`grassCulled`); no vegetation kind casts into the
	// sun's map today, so its copy is made to cast, see `stage`.
	let vegetation = null;
	s.scene.traverse( ( o ) => { if ( ! vegetation && o.isMesh && ! o.isInstancedMesh && o.userData.grassCulled === true && o.material?.userData?.vegetation === true && o.children.length > 0 ) vegetation = o; } );
	const spray = s.stormSea?.spray?.mesh ?? null;

	async function setup() {

		const renderer = new THREE.WebGPURenderer();
		await renderer.init();
		if ( ! installCacheKeyPatches( renderer ) ) throw new Error( 'installCacheKeyPatches failed' );
		renderer.shadowMap.enabled = true;
		renderer.setClearColor( new THREE.Color( 0, 0, 0 ), 0 );
		const device = renderer.backend.device;
		const env = { renderer, modules: [], pipelines: [], errors: [] };
		const createShaderModule = device.createShaderModule.bind( device );
		device.createShaderModule = ( d ) => {

			env.modules.push( { label: d.label, code: d.code } );
			return createShaderModule( d );

		};
		for ( const method of [ 'createRenderPipeline', 'createRenderPipelineAsync' ] ) {

			const original = device[ method ].bind( device );
			device[ method ] = ( d ) => {

				env.pipelines.push( d.label ?? '' );
				return original( d );

			};

		}
		// The subjects' materials sample the app's render targets (the displacement field). Since
		// r187 a renderer that samples a render target's texture first sets the target up, and
		// setting it up at a size it has not seen marks its textures for update. That bumps their
		// version, which the app's renderer then reads as an update: it destroys and remakes its
		// own texture while commands that use it wait to be submitted. A target the app's renderer
		// owns keeps its versions here.
		const textures = renderer._textures, owner = s.renderer._textures;
		const updateRenderTarget = textures.updateRenderTarget.bind( textures );
		textures.updateRenderTarget = ( rt, ...rest ) => {

			const foreign = textures.get( rt ).initialized !== true && owner.has( rt ) && owner.get( rt ).initialized === true;
			const versions = foreign ? rt.textures.map( ( t ) => t.version ) : null;
			updateRenderTarget( rt, ...rest );
			if ( foreign ) rt.textures.forEach( ( t, i ) => { t.version = versions[ i ]; } );

		};
		device.addEventListener( 'uncapturederror', ( e ) => env.errors.push( e.error.message.split( '\n' )[ 0 ] ) );
		renderer.onError = ( e ) => env.errors.push( String( e?.message ?? e ).split( '\n' )[ 0 ] );
		return env;

	}
	const target = ( names ) => {

		const rt = new THREE.RenderTarget( SIZE, SIZE, { count: names.length, type: THREE.HalfFloatType, depthBuffer: true } );
		names.forEach( ( name, i ) => { rt.textures[ i ].name = name; } );
		return rt;

	};
	// the fragment stage's outputs: its entry point's return type, a location or a struct of them
	// (its inputs, the varyings, have locations too)
	const outputs = ( code ) => {

		const ret = code?.match( /fn main\b[^{]*?->\s*(@location|[A-Za-z_]\w*)/ )?.[ 1 ];
		if ( ! ret ) return 0;
		if ( ret.startsWith( '@location' ) ) return 1;
		const struct = code.match( new RegExp( `struct ${ ret }\\s*\\{([^}]*)\\}` ) );
		return struct ? ( struct[ 1 ].match( /@location/g ) ?? [] ).length : 0;

	};
	async function pixels( renderer, rt, index ) {

		const data = await renderer.readRenderTargetPixelsAsync( rt, 0, 0, SIZE, SIZE, index );
		return Array.from( data, ( h ) => THREE.DataUtils.fromHalfFloat( h ) );

	}

	// a scene drawing a copy of `mesh` (its children too: the vegetation's depth copy) under a
	// shadow-casting sun, over a ground that receives its shadow, and a camera on its first instance,
	// or for the meadow on a turf anchor near the middle of its box
	function stage( mesh ) {

		const scene = new THREE.Scene();
		const copy = mesh.clone();
		// (a clone leaves out the draw's handlers, which for the meadow generate its blades for the
		// camera in the renderer that draws and set the indirect arguments; its depth copy's call the
		// mesh's)
		const sources = [], copies = [];
		mesh.traverse( ( o ) => sources.push( o ) );
		copy.traverse( ( o ) => copies.push( o ) );
		sources.forEach( ( o, i ) => {

			copies[ i ].onBeforeRender = o.onBeforeRender;
			// The meadow casts here only (the page's never does). Its draw is the first receiver's,
			// so three renders the sun's map between its handler and its draw (`updateBefore`), and
			// the map's draw of the meadow would end by clearing the indirect arguments the view's
			// draw is about to read: only the view's draw clears them, and `run` after each render.
			const after = o.onAfterRender;
			copies[ i ].onAfterRender = o.userData.grassCulled ? function ( renderer, scene, camera, ...rest ) {

				if ( camera.isPerspectiveCamera ) after.call( this, renderer, scene, camera, ...rest );

			} : after;

		} );
		// (a vegetation subject casts here whether or not its kind does on the page, so the shadow
		// pass builds its nodes)
		if ( mesh.material?.userData?.vegetation === true ) copy.castShadow = true;
		// (the spray hides in calm weather)
		copy.traverse( ( o ) => {

			o.frustumCulled = false;
			o.visible = true;

		} );
		const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), k = new THREE.Vector3();
		if ( mesh.isInstancedMesh ) mesh.getMatrixAt( 0, m );
		m.premultiply( mesh.matrixWorld ).decompose( p, q, k );
		const plan = mesh.parent?.userData?.plan;
		if ( plan ) {

			const middle = plan.box.getCenter( new THREE.Vector3() );
			let best = Infinity;
			for ( const { origin } of plan.crowns ) {

				const d = ( origin.x - middle.x ) ** 2 + ( origin.z - middle.z ) ** 2;
				if ( d < best ) {

					best = d;
					p.copy( origin );

				}

			}

		}
		const r = Math.max( k.x, k.y, k.z, 0.5 );
		scene.add( copy );
		const ground = new THREE.Mesh( new THREE.PlaneGeometry( 16 * r, 16 * r ).rotateX( - Math.PI / 2 ), new THREE.MeshStandardNodeMaterial() );
		ground.position.copy( p ).add( new THREE.Vector3( 0, - 0.05 * r, 0 ) );
		ground.receiveShadow = true;
		scene.add( ground );
		const sun = new THREE.DirectionalLight( 0xffffff, 3 );
		sun.position.copy( p ).add( new THREE.Vector3( 1, 3, 2 ).multiplyScalar( r * 4 ) );
		sun.target.position.copy( p );
		sun.castShadow = true;
		sun.shadow.mapSize.set( 256, 256 );
		Object.assign( sun.shadow.camera, { left: - 4 * r, right: 4 * r, top: 4 * r, bottom: - 4 * r, near: 0.1, far: 40 * r } );
		// (the shadow pass sees the subject on either layer: see `shadow` below)
		sun.shadow.camera.layers.enableAll();
		scene.add( sun, sun.target );
		const camera = new THREE.PerspectiveCamera( 40, 1, 0.05, 100 * r );
		camera.position.copy( p ).add( new THREE.Vector3( 0, 0.6 * r, 3.5 * r ) );
		camera.lookAt( p );
		camera.updateMatrixWorld();
		return { scene, camera, copy, sun };

	}

	// One subject's draws in `order`; `warm`: each draw compiled first. The steps: `plain` (the
	// subject into a target of one attachment, no MRT), `pass` (into its pass's layout, under its
	// MRT), `shadow` (only the sun's shadow pass draws the subject: it is on a layer the camera does
	// not see, the ground shows the map), and `pass` without the sun's shadow (`noShadow`).
	async function run( subject, order, warm ) {

		const env = await setup();
		const { scene, camera, copy, sun } = stage( subject.mesh );
		// (the meadow skips its generation for a view it generated last, in whichever renderer: this
		// fresh one must generate its own)
		subject.mesh.parent?.userData?.blades?.key?.fill( NaN );
		const plainRt = target( [ 'output' ] ), passRt = target( subject.layout );
		const results = [];
		for ( const step of order ) {

			const pass = step.startsWith( 'pass' );
			const rt = pass ? passRt : plainRt, mrt = pass ? subject.mrt : null;
			copy.traverse( ( o ) => o.layers.set( step === 'shadow' ? 1 : 0 ) );
			// the vegetation's depth copies draw only in its pass (under the temporal modes their only
			// colour output is the velocity: drawn without it, their shader would have none)
			for ( const child of copy.children ) child.visible = pass;
			sun.castShadow = step !== 'pass-noShadow';
			const m0 = env.modules.length;
			if ( warm ) await compileInto( env.renderer, scene, camera, rt, null, mrt );
			const p0 = env.pipelines.length;
			env.renderer.setRenderTarget( rt );
			env.renderer.setMRT( mrt );
			env.renderer.render( scene, camera );
			env.renderer.setRenderTarget( null );
			env.renderer.setMRT( null );
			// (other draws of the meadow's geometry draw every record: see `stage`)
			copy.traverse( ( o ) => { if ( o.userData.grassCulled ) o.geometry.indirect = null; } );
			await env.renderer.backend.device.queue.onSubmittedWorkDone();
			const result = { step, pipelinesAtDraw: env.pipelines.slice( p0 ).filter( ( label ) => label.includes( subject.name ) ).length, shadowPipelines: env.pipelines.slice( p0 ).filter( ( label ) => label.includes( 'ShadowMaterial' ) ).length };
			if ( step !== 'shadow' ) {

				// the subject's fragment shaders built for this draw (none new: three serves a program
				// of the same code, its last one)
				const label = `fragment_${ subject.name }`;
				let built = env.modules.slice( m0 ).filter( ( m ) => m.label === label );
				if ( built.length === 0 ) built = env.modules.filter( ( m ) => m.label === label ).slice( - 1 );
				result.outputs = built.map( ( m ) => outputs( m.code ) );
				result.want = pass ? subject.layout.length : 1;

			}
			if ( subject.velocityClass !== undefined && pass ) {

				const v = await pixels( env.renderer, rt, 1 );
				let hits = 0;
				for ( let i = 0; i < v.length; i += 4 ) if ( Math.abs( v[ i + 2 ] - subject.velocityClass ) < 0.01 ) hits ++;
				result.velocityPixels = hits;

			}
			results.push( result );

		}
		await env.renderer.backend.device.queue.onSubmittedWorkDone();
		const drawn = results.filter( ( r ) => r.want !== undefined );
		const ok = env.errors.length === 0
			&& drawn.every( ( r ) => r.outputs.length > 0 && r.outputs.every( ( n ) => n === r.want ) && ( r.velocityPixels ?? Infinity ) >= ( subject.minPixels ?? 1 ) )
			// warmed: no draw builds a pipeline of the subject's; drawn: its first draw into each
			// layout builds one
			&& ( warm ? drawn.every( ( r ) => r.pipelinesAtDraw === 0 ) : drawn.filter( ( r, i ) => drawn.findIndex( ( x ) => x.want === r.want ) === i ).every( ( r ) => r.pipelinesAtDraw > 0 ) )
			// the shadow pass drew the subject
			&& results.filter( ( r ) => r.step === 'shadow' ).every( ( r ) => r.shadowPipelines > 0 || results.some( ( x ) => x !== r && x.shadowPipelines > 0 ) );
		const detail = results.map( ( r ) => `${ r.step }: ${ r.pipelinesAtDraw } pipeline(s) at the draw${ r.outputs ? `, fragment outputs ${ JSON.stringify( r.outputs ) } (want ${ r.want })` : '' }${ r.shadowPipelines ? `, ${ r.shadowPipelines } shadow-pass pipeline(s)` : '' }${ r.velocityPixels !== undefined ? `, ${ r.velocityPixels } px of class ${ subject.velocityClass }` : '' }` ).join( '; then ' )
			+ ( env.errors.length ? `; errors: ${ env.errors.slice( 0, 2 ).join( '; ' ) }` : '' );
		plainRt.dispose();
		passRt.dispose();
		env.renderer.dispose();
		return { ok, detail };

	}

	// The vegetation: its nodes first built by the sun's shadow pass (no MRT), then drawn in its
	// pass; or drawn in its pass first (no shadow), then the shadow pass, then the pass again. Under
	// the temporal modes it draws only in its pass (its velocity is its own MRT output). The spray:
	// plain and in its pass, both ways round.
	const subjects = [];
	if ( vegetation ) subjects.push( { name: 'probeVegetation', what: `vegetation (${ vegetation.name }, drawn indirectly)`, mesh: vegetation, layout: [ 'sceneColor', 'velocity' ], mrt: sceneMRT, velocityClass: MOTION_CLASS.vegetation,
		// (the camera stands in the meadow, whose blades cover about 40 % of the target: a draw with
		// no blades generated for it leaves a few pixels at most)
		minPixels: SIZE * SIZE / 10,
		orders: { 'shadow-first': [ 'shadow', 'pass' ], 'pass-first': [ 'pass-noShadow', 'shadow', 'pass' ] } } );
	else cases.push( { name: 'vegetation', pass: false, detail: 'no meadow draw (a plain vegetation mesh drawn indirectly) with a depth copy in the scene' } );
	if ( spray ) subjects.push( { name: 'probeSpray', what: 'spray (after-resolve MRT)', mesh: spray, layout: [ RAIN_OVERLAY ], mrt: afterMRT,
		orders: { 'plain-first': [ 'plain', 'pass' ], 'pass-first': [ 'pass', 'plain' ] } } );
	else cases.push( { name: 'spray', pass: false, detail: 'no spray mesh' } );
	for ( const subject of subjects ) {

		// named for the probe's shader modules and pipelines (the name is not part of a build's key)
		const material = subject.mesh.material;
		const name = material.name;
		material.name = subject.name;
		try {

			for ( const warm of [ false, true ] ) for ( const [ order, steps ] of Object.entries( subject.orders ) ) {

				const r = await run( subject, steps, warm );
				cases.push( { name: `${ subject.what }, ${ warm ? 'warmed' : 'drawn' }, ${ order }`, pass: r.ok, detail: r.detail } );

			}

		} finally {

			material.name = name;

		}

	}
	return { cases };

}
