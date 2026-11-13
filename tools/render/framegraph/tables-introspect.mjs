// The frame graph's introspection (packages/render/post/graph/FrameGraph.ts describe(), dot(), currentPass,
// the counters the diagnostics report) and the debug view's parsing (DebugView.ts), on a CPU mock
// of three's renderer. Run by tools/render/verify-framegraph.mjs.

import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { FrameGraph } from '../../../packages/render/post/graph/FrameGraph.ts';
import { parseDebugView } from '../../../packages/render/post/graph/DebugView.ts';

const RENDER = { of: 'render' };
const CANVAS = { of: 'canvas' };

function mockRenderer() {

	let target = null, mrt = null;
	return {
		backend: { device: { createCommandEncoder() {

			return { beginRenderPass() {} };

		} }, beginRender() {} },
		depth: true, stencil: false, autoClear: true, autoClearColor: true, autoClearDepth: true, autoClearStencil: true,
		getRenderTarget: () => target,
		setRenderTarget( rt ) {

			target = rt;

		},
		getMRT: () => mrt,
		setMRT( m ) {

			mrt = m;

		},
		initRenderTarget() {},
		copyTextureToTexture() {},
		getDrawingBufferSize( v ) {

			return v.set( 64, 32 );

		},
		render() {},
		compute() {},
	};

}

// a small graph of every kind of pass and resource: multisampled scene colour and depth, a resolve,
// a conditional pass writing a persistent fixed-size map, a compute pass, the canvas output
function smallGraph() {

	const g = new FrameGraph( mockRenderer(), { sceneSamples: 4 } );
	let color = g.color( 'sceneColor', { size: RENDER, format: THREE.RGBAFormat, type: THREE.HalfFloatType, samples: 'scene' } );
	let depth = g.depth( 'sceneDepth', { size: RENDER, samples: 'scene' } );
	let linear = g.color( 'linearDepth', { size: RENDER, format: THREE.RGFormat, type: THREE.FloatType } );
	let banks = g.color( 'fogBanks', { size: { of: 'fixed', width: 8, height: 8 }, format: THREE.RedFormat, type: THREE.HalfFloatType }, true );
	let canvas = g.import( 'canvas', null, CANVAS );
	const state = { bankOn: false, scales: [] };
	g.hooks.onPassBegin = ( p ) => state.scales.push( [ p.name, p.scales ] );
	g.addPass( 'opaque', 'scene', ( b ) => {

		color = b.write( color, { clear: true } );
		depth = b.depth( depth, { write: true, clear: true } );
		return { label: 'opaque scene', scene: {}, camera: {} };

	} );
	g.addPass( 'depthResolve', 'callback', ( b ) => {

		b.read( depth, 'samples' );
		linear = b.write( linear );
		return { label: 'depth & copy resolves', run() {} };

	} );
	g.addPass( 'fogBank', 'callback', ( b ) => {

		banks = b.write( banks );
		return { label: 'fog "bank"', when: () => state.bankOn, whenLabel: 'bankDue', run() {} };

	} );
	g.addPass( 'cull', 'compute', () => ( { label: 'cull', size: RENDER, neverCull: true, compute: [] } ) );
	g.addPass( 'output', 'callback', ( b ) => {

		b.read( color );
		b.read( linear );
		b.readOptional( banks );
		canvas = b.write( canvas );
		return { label: 'output', run() {} };

	} );
	return { g, state, handles: { color, depth, linear } };

}

export const checks = [

	[ 'introspect: describe() lists the passes in order with what ran, sizes, versions and bytes', () => {

		const { g, state } = smallGraph();
		let hooked = 0;
		const extend = ( graph ) => {

			hooked ++;
			assert.equal( graph, g, 'beforeCompile gets the graph it compiles' );

		};
		FrameGraph.beforeCompile.push( extend );
		try {

			g.compile();
			g.compile();

		} finally {

			FrameGraph.beforeCompile.splice( FrameGraph.beforeCompile.indexOf( extend ), 1 );

		}
		assert.equal( hooked, 1, 'beforeCompile runs once, before the one compile' );
		assert.equal( g.describe().ready, false, 'not ready before its extents are set' );
		g.setExtents( { render: { width: 100, height: 50 }, canvas: { width: 200, height: 100 } } );
		g.execute( {} );
		const d = g.describe();
		assert.equal( d.ready, true );
		assert.deepEqual( d.passes.map( ( p ) => p.name ), [ 'opaque', 'depthResolve', 'fogBank', 'cull', 'output' ] );
		assert.deepEqual( d.passes.map( ( p ) => p.runs ), [ true, true, false, true, true ] );
		assert.deepEqual( d.passes[ 1 ].reads, [ { resource: 'sceneDepth', version: 1, mode: 'samples', optional: false } ] );
		assert.deepEqual( d.passes[ 0 ].actual, { width: 100, height: 50 } );
		// the cost class the dynamic resolution reads: render-sized draws follow the pixel count
		// (a compute pass that declares a render-class size follows the render's pixels, as FSR 3's kernels do)
		assert.deepEqual( state.scales, [ [ 'opaque', 'pixel' ], [ 'depthResolve', 'pixel' ], [ 'cull', 'pixel' ], [ 'output', 'fixed' ] ] );
		assert.equal( g.currentPass, null, 'no pass outside execute()' );
		const r = Object.fromEntries( d.resources.map( ( x ) => [ x.name, x ] ) );
		assert.equal( r.sceneColor.format, 'RGBA' );
		assert.equal( r.sceneColor.type, 'HalfFloat' );
		assert.deepEqual( r.sceneColor.versions, [ null, 'opaque' ] );
		assert.equal( r.sceneColor.bytes, 100 * 50 * 8 * 5, 'four samples and the resolve' );
		assert.equal( r.sceneDepth.bytes, 100 * 50 * 4 * 4 );
		assert.equal( r.linearDepth.bytes, 100 * 50 * 8 );
		assert.equal( r.fogBanks.bytes, 8 * 8 * 2 );
		assert.equal( r.canvas.bytes, 0, 'the canvas is not the graph\'s' );
		assert.equal( d.bytes, 100 * 50 * 8 * 5 + 100 * 50 * 16 + 100 * 50 * 8 + 128 );
		assert.match( d.variant, /^s4-derived-[0-9a-f]{8}$/ );
		assert.equal( d.rebuilds, 0 );

	} ],

	[ 'introspect: describe() hands out copies of the ops the frames apply, and is deterministic', () => {

		const { g } = smallGraph();
		g.setExtents( { render: { width: 64, height: 32 }, canvas: { width: 64, height: 32 } } );
		g.execute( {} );
		const first = g.describe();
		const ops = first.passes[ 0 ].ops;
		assert.ok( ops, 'the scene pass has ops' );
		const before = JSON.stringify( g.opsTable( g.lastMask ) );
		ops.colors?.forEach?.( ( c ) => { c.store = 'tampered'; } );
		ops.index = - 1;
		assert.equal( JSON.stringify( g.opsTable( g.lastMask ) ), before, 'editing a description leaves the applied table alone' );
		g.execute( {} );
		assert.deepEqual( g.describe(), JSON.parse( JSON.stringify( g.describe() ) ), 'plain JSON' );
		const again = g.describe();
		assert.notEqual( again.passes[ 0 ].ops.index, - 1 );
		assert.equal( JSON.stringify( again.passes.map( ( p ) => p.ops ) ), JSON.stringify( smallDescribed() ), 'the same graph describes the same' );

	} ],

	[ 'introspect: dot() escapes labels and draws reads, writes, loads and depth tests', () => {

		const { g } = smallGraph();
		g.setExtents( { render: { width: 64, height: 32 }, canvas: { width: 64, height: 32 } } );
		g.execute( {} );
		const dot = g.dot();
		assert.match( dot, /^digraph FrameGraph \{/ );
		assert.match( dot, /"pass:fogBank" \[shape=box, label="2\. fogBank \(callback\)\\nfog \\"bank\\"\\nwhen bankDue"\];/, 'quotes escaped, line breaks as \\n' );
		assert.match( dot, /"sceneDepth@1" -> "pass:depthResolve" \[style=bold\];/, 'the multisampled samples read' );
		assert.match( dot, /"fogBanks@1" -> "pass:output" \[style=dashed\];/, 'an optional read' );
		assert.match( dot, /"pass:opaque" -> "sceneDepth@1" \[label="depth"\];/ );

		// a pass that tests and extends the depth another drew, and draws over its colour
		const g2 = new FrameGraph( mockRenderer(), { sceneSamples: 1 } );
		let color = g2.color( 'scene', { size: RENDER } );
		let depth = g2.depth( 'depth', { size: RENDER } );
		let canvas = g2.import( 'canvas', null, CANVAS );
		g2.addPass( 'opaque', 'scene', ( b ) => {

			color = b.write( color, { clear: true } );
			depth = b.depth( depth, { write: true, clear: true } );
			return { label: 'opaque', scene: {}, camera: {} };

		} );
		g2.addPass( 'water', 'scene', ( b ) => {

			color = b.write( color );
			depth = b.depth( depth, { write: true } );
			return { label: 'water', scene: {}, camera: {} };

		} );
		g2.addPass( 'output', 'callback', ( b ) => {

			b.read( color );
			b.read( depth );
			canvas = b.write( canvas );
			return { label: 'output', run() {} };

		} );
		g2.compile();
		const dot2 = g2.dot();
		assert.match( dot2, /"scene@1" -> "pass:water" \[style=dotted, label="load"\];/, 'the colour the water draws over' );
		assert.match( dot2, /"depth@1" -> "pass:water" \[style=dotted\];/, 'the depth the water tests' );
		assert.match( dot2, /"pass:water" -> "depth@2" \[label="depth"\];/ );

	} ],

	[ 'introspect: rebuilds counts render targets made after the first frame, not resizes', () => {

		const { g, handles } = smallGraph();
		g.setExtents( { render: { width: 64, height: 32 }, canvas: { width: 64, height: 32 } } );
		g.execute( {} );
		g.setExtents( { render: { width: 80, height: 40 }, canvas: { width: 80, height: 40 } } );
		g.execute( {} );
		assert.equal( g.rebuilds, 0, 'a resize resizes the targets in place' );
		g.renderTarget( [ handles.color ], handles.depth );
		assert.equal( g.rebuilds, 0, 'a target the graph already has is returned, not made' );
		// a target of attachments no pass draws into together, made by hand after the first frame
		const late = new FrameGraph( mockRenderer(), { sceneSamples: 1 } );
		let a = late.color( 'a', { size: RENDER } ), b = late.color( 'b', { size: RENDER } );
		let canvas = late.import( 'canvas', null, CANVAS );
		late.addPass( 'drawA', 'callback', ( p ) => {

			a = p.write( a );
			return { label: 'a', run() {} };

		} );
		late.addPass( 'drawB', 'callback', ( p ) => {

			b = p.write( b );
			return { label: 'b', run() {} };

		} );
		late.addPass( 'output', 'callback', ( p ) => {

			p.read( a );
			p.read( b );
			canvas = p.write( canvas );
			return { label: 'output', run() {} };

		} );
		late.setExtents( { render: { width: 8, height: 8 }, canvas: { width: 8, height: 8 } } );
		late.execute( {} );
		late.renderTarget( [ a, b ] );
		assert.equal( late.rebuilds, 1, 'a target made after the first frame is a rebuild' );

	} ],

	[ 'introspect: fgview names a resource, with dots in names, and an output', () => {

		assert.deepEqual( parseDebugView( 'FSR.easu', [ 'FSR.easu', 'display' ] ), { resource: 'FSR.easu', output: null } );
		assert.deepEqual( parseDebugView( 'linearDepth.g', [ 'linearDepth' ] ), { resource: 'linearDepth', output: 'g' } );
		assert.deepEqual( parseDebugView( 'FSR.easu.a', [ 'FSR.easu' ] ), { resource: 'FSR.easu', output: 'a' } );
		assert.equal( parseDebugView( 'nope', [ 'linearDepth' ] ), null );

	} ],

];

// the ops of a fresh small graph's first frame, for the determinism check
function smallDescribed() {

	const { g } = smallGraph();
	g.setExtents( { render: { width: 64, height: 32 }, canvas: { width: 64, height: 32 } } );
	g.execute( {} );
	g.execute( {} );
	return g.describe().passes.map( ( p ) => p.ops );

}
