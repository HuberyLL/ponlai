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
// 2. What the temporal frame graph rests on, in three r186 (bare page, patched renderer): blending
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
// 3. The app (`?debug`): the cache-key patches installed on its renderer, the warm-up done
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
const report = { mrt: null, temporal: null, app: null };
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

	// ---- 2. the temporal graph's blends and copies
	report.temporal = await page.evaluate( probeTemporal );
	for ( const c of report.temporal.cases ) check( c.pass, `${ c.name }: ${ c.detail }` );
	check( pageErrors.length === 0, `no page errors${ pageErrors.length ? `: ${ pageErrors.slice( 0, 3 ).join( '; ' ) }` : '' }` );
	await page.close();

	// ---- 3. the app
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

async function probeTemporal() {

	const source = await ( await fetch( '/src/post/graph/FrameGraph.ts' ) ).text();
	const url = ( name ) => source.match( new RegExp( `from\\s*["'](/[^"']*${ name }[^"']*)["']` ) )?.[ 1 ];
	const THREE = await import( url( 'three_webgpu' ) );
	const TSL = await import( url( 'three_tsl' ) );
	const { installCacheKeyPatches } = await import( '/src/post/graph/ThreePatches.ts' );

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
	const { sceneMRT, overlayMRT } = await import( '/src/post/Motion.ts' );

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
