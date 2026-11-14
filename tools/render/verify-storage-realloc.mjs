// Checks on the GPU that replacing a storage buffer with a larger one builds no new pipeline in three.
//
// Pools that outgrow their capacity (the meadow's, packages/render/vegetation/VegetationCull.ts)
// replace their storage buffers. This probe of three's WebGPU backend runs a compute kernel and an
// instanced draw that read and write storage buffers, as the cull's kernels and the grass material
// do, then:
//   in place   the same buffers rewritten (`needsUpdate`), the dispatch and draw repeated;
//   realloc    each storage node's `value` replaced by a new, twice as large attribute, the kernel
//              dispatched and the draw instanced over all of it;
//   grow       (for the record) a larger array assigned to an existing attribute.
// For each it counts the pipelines, shader modules and bind groups the GPU device was asked for,
// and checks the results read back (every element written, every instance drawn). Run it again
// after an upgrade of three (docs/how-to/upgrade-three.md) or a change to how a pool grows
// (docs/reference/three-behaviour.md, Storage buffers).
//
// Usage:
//   node tools/render/verify-storage-realloc.mjs [--port 5627]
//
// Options:
//   --port n   the port of its own Vite server (default 5627)
//
// Output: the steps' counts and results and the page's errors and warnings as JSON on stdout, then
// `passed` or `FAILED`.
//
// GPU lock and browser: takes the GPU lock shared (docs/reference/gpu-lock.md) and opens headless
// Chrome (CHROME_PATH, else Playwright's Chromium). It serves its own page from a Vite server over
// the repository on 127.0.0.1 (three alone, without the app's config), so it needs no dev server.
//
// Cost: seconds.
//
// Exit codes: 0 passed; 1 rewriting in place or reallocating built a pipeline (or reallocating a
// shader module), a result is wrong, or the page failed.
import '../kit/help.mjs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { acquireGpuLock } from '../kit/gpu-lock.mjs';
import { ROOT } from '../kit/root.mjs';

const argument = ( name, fallback ) => {

	const i = process.argv.indexOf( name );
	return i < 0 ? fallback : process.argv[ i + 1 ];

};

// The page: Vite resolves its imports as the app's (the same three build).
const PAGE = `<!doctype html><html><head><link rel="icon" href="data:,"></head><body><script type="module">
import * as THREE from 'three/webgpu';
import { Fn, storage, workgroupId, localId, instanceIndex, vec4, vec3, float, uint, positionLocal } from 'three/tsl';

const GROUP = 64, N = 1024, SIDE = 64;
const created = { pipelines: 0, shaderModules: 0, bindGroups: 0 };
for ( const [ name, key ] of [ [ 'createComputePipeline', 'pipelines' ], [ 'createComputePipelineAsync', 'pipelines' ],
	[ 'createRenderPipeline', 'pipelines' ], [ 'createRenderPipelineAsync', 'pipelines' ], [ 'createShaderModule', 'shaderModules' ],
	[ 'createBindGroup', 'bindGroups' ] ] ) {

	const original = GPUDevice.prototype[ name ];
	GPUDevice.prototype[ name ] = function ( ...args ) { created[ key ] ++; return original.apply( this, args ); };

}

async function run() {

	const renderer = new THREE.WebGPURenderer();
	await renderer.init();
	const device = renderer.backend.device;
	const vec4s = ( n, f ) => { const a = new Float32Array( n * 4 ); for ( let i = 0; i < n; i ++ ) a.set( f( i ), i * 4 ); return a; };

	// compute: element i += ( 1, 2, 3, 4 ), over whole workgroups (as VegetationCull dispatches)
	const pool = storage( new THREE.StorageBufferAttribute( vec4s( N, ( i ) => [ i, 0, 0, 0 ] ), 4 ), 'vec4', N );
	const kernel = Fn( () => {

		const i = workgroupId.x.mul( GROUP ).add( localId.x );
		pool.element( i ).assign( pool.element( i ).add( vec4( 1, 2, 3, 4 ) ) );

	} )().computeKernel( [ GROUP ] );
	kernel.dispatchSize = [ N / GROUP, 1, 1 ];

	// draw: instance i a small triangle over pixel ( i mod SIDE, i / SIDE ), placed from storage
	const places = storage( new THREE.StorageBufferAttribute( vec4s( N, ( i ) => [ i % SIDE + 0.5, Math.floor( i / SIDE ) + 0.5, 0, 0 ] ), 4 ), 'vec4', N ).toReadOnly();
	const triangle = new THREE.BufferGeometry();
	triangle.setAttribute( 'position', new THREE.Float32BufferAttribute( [ - 0.4, - 0.4, 0, 0.4, - 0.4, 0, 0, 0.4, 0 ], 3 ) );
	const material = new THREE.MeshBasicNodeMaterial();
	material.positionNode = positionLocal.add( vec3( places.element( instanceIndex ).xy, 0 ) );
	material.colorNode = vec4( 1 );
	const mesh = new THREE.InstancedMesh( triangle, material, 2 * N );
	mesh.count = N;
	mesh.frustumCulled = false;
	const scene = new THREE.Scene();
	scene.add( mesh );
	const camera = new THREE.OrthographicCamera( 0, SIDE, SIDE, 0, - 1, 1 );
	const target = new THREE.RenderTarget( SIDE, SIDE );

	const dispatch = async ( attribute, n ) => {

		renderer.compute( kernel );
		const values = new Float32Array( await renderer.getArrayBufferAsync( attribute ) );
		let wrong = 0;
		for ( let i = 0; i < n; i ++ ) if ( values[ i * 4 ] !== attribute.expect( i ) || values[ i * 4 + 3 ] !== 4 * attribute.passes ) wrong ++;
		return wrong;

	};
	const draw = async () => {

		renderer.setRenderTarget( target );
		renderer.setClearColor( 0x000000, 0 );
		renderer.clear();
		renderer.render( scene, camera );
		renderer.setRenderTarget( null );
		const pixels = await renderer.readRenderTargetPixelsAsync( target, 0, 0, SIDE, SIDE );
		let lit = 0;
		for ( let k = 3; k < pixels.length; k += 4 ) if ( pixels[ k ] > 0 ) lit ++;
		return lit;

	};
	const step = async ( name, change ) => {

		const before = { ...created };
		const result = await change();
		const made = Object.fromEntries( Object.keys( created ).map( ( k ) => [ k, created[ k ] - before[ k ] ] ) );
		return { name, ...result, created: made };

	};

	const a = pool.value;
	a.passes = 0;
	a.expect = ( i ) => i + a.passes;
	const steps = [];
	steps.push( await step( 'first', async () => {

		a.passes ++;
		const wrong = await dispatch( a, N );
		return { wrongElements: wrong, litPixels: await draw() };

	} ) );
	steps.push( await step( 'in place', async () => {

		a.array.set( vec4s( N, ( i ) => [ 2 * i, 0, 0, 0 ] ) );
		a.needsUpdate = true;
		a.passes = 1;
		a.expect = ( i ) => 2 * i + a.passes;
		places.value.array.set( vec4s( N, ( i ) => [ ( N - 1 - i ) % SIDE + 0.5, Math.floor( ( N - 1 - i ) / SIDE ) + 0.5, 0, 0 ] ) );
		places.value.needsUpdate = true;
		return { wrongElements: await dispatch( a, N ), litPixels: await draw() };

	} ) );
	steps.push( await step( 'realloc', async () => {

		const b = new THREE.StorageBufferAttribute( vec4s( 2 * N, ( i ) => [ 3 * i, 0, 0, 0 ] ), 4 );
		b.passes = 1;
		b.expect = ( i ) => 3 * i + 1;
		pool.value = b;
		kernel.dispatchSize = [ 2 * N / GROUP, 1, 1 ];
		places.value = new THREE.StorageBufferAttribute( vec4s( 2 * N, ( i ) => [ i % SIDE + 0.5, Math.floor( i / SIDE ) + 0.5, 0, 0 ] ), 4 );
		mesh.count = 2 * N;
		return { wrongElements: await dispatch( b, 2 * N ), litPixels: await draw() };

	} ) );
	steps.push( await step( 'grow', async () => {

		const b = pool.value;
		device.pushErrorScope( 'validation' );
		b.array = vec4s( 4 * N, ( i ) => [ i, 0, 0, 0 ] );
		b.needsUpdate = true;
		kernel.dispatchSize = [ 4 * N / GROUP, 1, 1 ];
		renderer.compute( kernel );
		await renderer.getArrayBufferAsync( b );
		const error = await device.popErrorScope();
		return { validationError: error ? error.message.split( '\\n' )[ 0 ] : null };

	} ) );
	return { three: THREE.REVISION, steps };

}

window.result = run().catch( ( e ) => ( { failure: String( e && e.stack || e ) } ) );
</script></body></html>`;

await acquireGpuLock( 'verify-storage-realloc', { shared: true } );
const root = ROOT + '/';
const server = await createServer( {
	root, configFile: false, logLevel: 'error',
	// three alone (the app's entry needs the app's Vite config, which this page does not)
	optimizeDeps: { noDiscovery: true, include: [ 'three/webgpu', 'three/tsl' ] },
	server: { host: '127.0.0.1', port: Number( argument( '--port', '5627' ) ) },
	plugins: [ { name: 'storage-realloc-page', configureServer( vite ) {

		vite.middlewares.use( '/__storage-realloc', async ( _req, res ) => {

			res.setHeader( 'Content-Type', 'text/html' );
			res.end( await vite.transformIndexHtml( '/__storage-realloc', PAGE ) );

		} );

	} } ],
} );
await server.listen();
const browser = await chromium.launch( {
	headless: true,
	...( process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' } ),
	args: [ '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu' ],
} );
let failed = true;
try {

	const page = await browser.newPage();
	const messages = [];
	page.on( 'console', ( m ) => { if ( m.type() === 'error' || m.type() === 'warning' ) messages.push( `${ m.type() }: ${ m.text() }` ); } );
	page.on( 'pageerror', ( e ) => messages.push( `pageerror: ${ e.message }` ) );
	await page.goto( `${ server.resolvedUrls.local[ 0 ] }__storage-realloc` );
	const result = await page.evaluate( () => window.result );
	console.log( JSON.stringify( { ...result, messages }, null, 2 ) );
	const by = Object.fromEntries( ( result.steps ?? [] ).map( ( s ) => [ s.name, s ] ) );
	failed = ! by.realloc || result.failure !== undefined
		|| by[ 'in place' ].created.pipelines !== 0 || by.realloc.created.pipelines !== 0 || by.realloc.created.shaderModules !== 0
		|| [ by.first, by[ 'in place' ], by.realloc ].some( ( s ) => s.wrongElements !== 0 )
		|| by.first.litPixels !== 1024 || by[ 'in place' ].litPixels !== 1024 || by.realloc.litPixels !== 2048;
	console.log( failed ? 'FAILED' : 'passed: a reallocated storage buffer builds no pipeline (new bind groups only)' );

} finally {

	await browser.close();
	await server.close();

}
process.exit( failed ? 1 : 0 );
