// The frame graph's runtime (src/post/graph/FrameGraph.ts) on a CPU mock of three's renderer:
// ping-pong histories under a skippable writer, the initialisation of every target after a resize
// (textures shared by two targets, depth sized by the graph), the clear flags a pass binds, the
// second history texture, and the dev check of the rewrites that reached the encoder. Run by
// tools/verify-framegraph.mjs.

import assert from 'node:assert/strict';
import { FrameGraph } from '../../src/post/graph/FrameGraph.ts';

const RENDER = { of: 'render' };
const CANVAS = { of: 'canvas' };

// what FrameGraph calls on three's renderer, recorded in `log`
function mockRenderer() {

	const log = [];
	let target = null, mrt = null;
	const r = {
		log,
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
		initRenderTarget( rt ) {

			log.push( [ 'init', rt ] );

		},
		copyTextureToTexture( src, dst ) {

			log.push( [ 'copy', src, dst ] );

		},
		getDrawingBufferSize( v ) {

			return v.set( 64, 32 );

		},
		render() {},
		compute() {},
	};
	return r;

}

const extents = ( w, h ) => ( { render: { width: w, height: h }, canvas: { width: w, height: h } } );

export const checks = [

	[ 'runtime: a ping-pong history swaps only in frames that wrote it', () => {

		const r = mockRenderer();
		const g = new FrameGraph( r, { sceneSamples: 1 } );
		let history = g.color( 'history', { size: CANVAS } );
		const historyPrev = g.previous( history );
		let canvas = g.import( 'canvas', null, CANVAS );
		const events = [];
		let resolveOn = true;
		g.addPass( 'resolve', 'callback', ( b ) => {

			b.read( historyPrev );
			history = b.write( history );
			return {
				label: 'TAA resolve', when: () => resolveOn,
				run: ( f, graph ) => events.push( { reads: graph.texture( historyPrev ), writes: graph.texture( history ), target: graph.renderer.getRenderTarget() } ),
			};

		} );
		g.addPass( 'output', 'callback', ( b ) => {

			b.readOptional( history );
			canvas = b.write( canvas );
			return { label: 'output', run: ( f, graph ) => events.push( { shows: graph.texture( history ) } ) };

		} );
		g.compile();
		g.setExtents( extents( 64, 32 ) );
		const [ t0, t1 ] = [ g.texture( history, 0 ), g.texture( history, 1 ) ];
		assert.notEqual( t0, t1 );
		assert.notEqual( t0.source, t1.source, 'the second texture has a source (image) of its own' );
		g.execute( {} ); // frame 1 writes t0
		resolveOn = false;
		g.execute( {} ); // frame 2: the resolve is skipped
		resolveOn = true;
		g.execute( {} ); // frame 3 must read frame 1's history and write the other texture
		const resolves = events.filter( ( e ) => e.writes );
		assert.equal( resolves.length, 2 );
		assert.equal( resolves[ 0 ].writes, t0 );
		assert.equal( resolves[ 1 ].reads, t0, 'after a skipped frame the previous history is still the newest' );
		assert.equal( resolves[ 1 ].writes, t1, 'and the write does not overwrite it' );
		assert.equal( resolves[ 0 ].target.textures[ 0 ], t0 );
		assert.equal( resolves[ 1 ].target.textures[ 0 ], t1, 'the bound target follows the resource\'s parity' );
		// the skipped frame's output shows the newest history
		const shows = events.filter( ( e ) => e.shows ).map( ( e ) => e.shows );
		assert.deepEqual( shows, [ t0, t0, t1 ] );
		assert.equal( g.parityOf( history ), 0 );
		g.resetHistory( history );
		assert.equal( g.historyValid( history ), false );
		g.execute( {} );
		assert.equal( g.historyValid( history ), true );

	} ],

	[ 'runtime: after a resize the targets that share a texture, and the copy destination\'s, are initialised in order before a pass draws; depth is sized by the graph', () => {

		const r = mockRenderer();
		const g = new FrameGraph( r, { sceneSamples: 1 } );
		// sceneColor sits in two targets: with velocity (the opaque pass) and alone (an overlay)
		let sceneColor = g.color( 'sceneColor', { size: RENDER } );
		let velocity = g.color( 'velocity', { size: RENDER } );
		let depth = g.depth( 'sceneDepth', { size: RENDER } );
		const prev = g.color( 'surfaceDepthPrev', { size: RENDER }, true );
		let surface = g.color( 'surfaceDepth', { size: RENDER } );
		let canvas = g.import( 'canvas', null, CANVAS );
		let opaqueOn = true;
		const drawn = [];
		g.addPass( 'opaque', 'callback', ( b ) => {

			sceneColor = b.write( sceneColor, { clear: true } );
			velocity = b.write( velocity, { clear: true } );
			depth = b.depth( depth, { write: true, clear: true } );
			return { label: 'opaque scene', mrt: { id: 1 }, when: () => opaqueOn, run: () => drawn.push( r.getRenderTarget() ) };

		} );
		g.addPass( 'overlay', 'callback', ( b ) => {

			sceneColor = b.write( sceneColor );
			b.depth( depth, { write: true } );
			return { label: 'overlay', run: () => drawn.push( r.getRenderTarget() ) };

		} );
		g.addPass( 'surface', 'quad', ( b ) => {

			b.readOptional( velocity );
			surface = b.write( surface );
			return { label: 'depth & copy resolves', quad: { render: () => drawn.push( r.getRenderTarget() ) } };

		} );
		g.addPass( 'output', 'callback', ( b ) => {

			b.read( sceneColor );
			b.read( surface );
			b.read( prev );
			canvas = b.write( canvas );
			return { label: 'output', run: () => {} };

		} );
		g.copyToPersistent( surface, prev );
		g.compile();
		g.setExtents( extents( 64, 32 ) );
		g.execute( {} );
		const inits = r.log.filter( ( e ) => e[ 0 ] === 'init' ).map( ( e ) => e[ 1 ] );
		// (the surface target shares nothing: it initialises itself when the pass draws into it)
		assert.equal( inits.length, 3, 'opaque and overlay (they share sceneColor and the depth) and the copy destination\'s own target' );
		assert.deepEqual( inits.slice( 0, 2 ), drawn.slice( 0, 2 ), 'in declaration order' );
		assert.ok( ! inits.includes( drawn[ 2 ] ), 'a target that shares nothing is not initialised ahead' );
		const [ opaqueRT, overlayRT ] = inits;
		assert.equal( opaqueRT.textures[ 0 ], overlayRT.textures[ 0 ], 'the two targets share sceneColor' );
		assert.equal( opaqueRT.depthTexture, overlayRT.depthTexture );
		// a resize with the depth's owner (the opaque pass) skipped: the depth is still resized, and
		// every target is initialised again before the overlay draws
		r.log.length = 0;
		drawn.length = 0;
		opaqueOn = false;
		g.setExtents( extents( 40, 20 ) );
		assert.equal( g.historyValid( prev ), false, 'a resized persistent history is invalid until written' );
		g.execute( {} );
		assert.equal( g.historyValid( prev ), true );
		const depthImage = opaqueRT.depthTexture.image;
		assert.deepEqual( [ depthImage.width, depthImage.height ], [ 40, 20 ] );
		assert.deepEqual( [ overlayRT.width, overlayRT.height, opaqueRT.width ], [ 40, 20, 40 ] );
		assert.equal( r.log.filter( ( e ) => e[ 0 ] === 'init' ).length, 3 );
		assert.ok( r.log.findIndex( ( e ) => e[ 0 ] === 'copy' ) > 2, 'initialised before the frame-end copy' );
		// no resize: no initialisation
		r.log.length = 0;
		g.setExtents( extents( 40, 20 ) );
		g.execute( {} );
		assert.equal( r.log.filter( ( e ) => e[ 0 ] === 'init' ).length, 0 );

	} ],

	[ 'runtime: a blended full-screen pass loads, an overwriting one clears', () => {

		const r = mockRenderer();
		const g = new FrameGraph( r, { sceneSamples: 1 } );
		let x = g.color( 'x', { size: RENDER } );
		let canvas = g.import( 'canvas', null, CANVAS );
		const flags = {};
		const record = ( name ) => ( { render: () => ( flags[ name ] = r.autoClearColor ) } );
		g.addPass( 'base', 'quad', ( b ) => ( x = b.write( x ), { label: 'b', quad: record( 'base' ) } ) );
		g.addPass( 'add', 'quad', ( b ) => ( x = b.write( x, { blend: 'additive' } ), { label: 'a', quad: record( 'add' ) } ) );
		g.addPass( 'output', 'quad', ( b ) => ( b.read( x ), canvas = b.write( canvas ), { label: 'o', quad: record( 'output' ) } ) );
		g.compile();
		g.setExtents( extents( 8, 8 ) );
		for ( const mode of [ 'legacy', 'derived', 'off' ] ) {

			Object.defineProperty( g.attachmentOps, 'mode', { value: mode } );
			g.execute( {} );
			assert.deepEqual( flags, { base: true, add: false, output: true }, mode );

		}
		assert.equal( r.autoClearColor, true, 'the renderer\'s flags are restored after the frame' );

	} ],

	[ 'runtime: a pass without a depth resource clears the depth the graph does not own (the canvas\'s, a chain\'s own targets\'); a declared depth clears or loads as declared', () => {

		const r = mockRenderer();
		const g = new FrameGraph( r, { sceneSamples: 1 } );
		let color = g.color( 'sceneColor', { size: RENDER } );
		let depth = g.depth( 'sceneDepth', { size: RENDER } );
		let x = g.color( 'x', { size: RENDER } );
		let canvas = g.import( 'canvas', null, CANVAS );
		const flags = {};
		const record = ( name ) => () => ( flags[ name ] = r.autoClearDepth && r.autoClearStencil );
		g.addPass( 'opaque', 'callback', ( b ) => ( color = b.write( color, { clear: true } ), depth = b.depth( depth, { write: true, clear: true } ), { label: 'o', run: record( 'opaque' ) } ) );
		g.addPass( 'overlay', 'callback', ( b ) => ( color = b.write( color ), b.depth( depth, { write: false } ), { label: 'v', run: record( 'overlay' ) } ) );
		// a chain's own rtt() passes draw into targets with depth and inherit the flags its pass binds
		g.addPass( 'display', 'chain', ( b ) => ( b.read( color ), x = b.write( x ), { label: 'd', pipeline: { render: record( 'display' ) } } ) );
		g.addPass( 'output', 'chain', ( b ) => ( b.read( x ), canvas = b.write( canvas ), { label: 'out', pipeline: { render: record( 'output' ) } } ) );
		g.compile();
		g.setExtents( extents( 8, 8 ) );
		assert.equal( g.targetOf( 2 ).depthBuffer, false, 'the chain\'s graph target holds no depth' );
		for ( const mode of [ 'legacy', 'derived', 'off' ] ) {

			Object.defineProperty( g.attachmentOps, 'mode', { value: mode } );
			r.autoClearDepth = r.autoClearStencil = false;
			g.execute( {} );
			assert.deepEqual( flags, { opaque: true, overlay: false, display: true, output: true }, mode );
			assert.equal( r.autoClearDepth, false, 'the renderer\'s depth flag is restored after the frame' );

		}

	} ],

	[ 'runtime: the dev check counts frames whose rewrites did not reach the encoder', () => {

		const r = mockRenderer();
		const g = new FrameGraph( r, { sceneSamples: 4, dev: true } );
		let color = g.color( 'sceneColor', { size: RENDER, samples: 'scene' } );
		let depth = g.depth( 'sceneDepth', { size: RENDER, samples: 'scene' } );
		let canvas = g.import( 'canvas', null, CANVAS );
		g.addPass( 'opaque', 'callback', ( b ) => ( color = b.write( color, { clear: true } ), depth = b.depth( depth, { write: true, clear: true } ), { label: 'o', run: () => {} } ) );
		g.addPass( 'rain', 'callback', ( b ) => ( color = b.write( color ), b.depth( depth, { write: false } ), { label: 'r', run: () => {} } ) );
		g.addPass( 'output', 'quad', ( b ) => ( b.read( color ), canvas = b.write( canvas ), { label: 'out', quad: { render() {} } } ) );
		g.compile();
		g.setExtents( extents( 64, 32 ) );
		const warn = console.warn;
		console.warn = () => {};
		try {

			g.execute( {} );
			assert.equal( g.opsMismatchFrames, 0, 'not installed: nothing to check' );
			g.attachmentOps.install();
			// the passes never begin a render pass here, so the table's rewrites are missed
			g.execute( {} );
			assert.equal( g.opsMismatchFrames, 1 );
			g.attachmentOps.uninstall();

		} finally {

			console.warn = warn;

		}

	} ],

	[ 'runtime: renderTarget() makes a tuple\'s target ahead of the passes, which then draw into it', () => {

		const r = mockRenderer();
		const g = new FrameGraph( r, { sceneSamples: 4 } );
		let color = g.color( 'sceneColor', { size: RENDER, samples: 'scene' } );
		let depth = g.depth( 'sceneDepth', { size: RENDER, samples: 'scene' } );
		let linear = g.color( 'linearDepth', { size: RENDER } );
		const fog = g.color( 'fogMarch', { size: { of: 'render', divisor: 2 } } );
		let canvas = g.import( 'canvas', null, CANVAS );
		const sceneRT = g.renderTarget( [ color ], depth );
		assert.equal( g.renderTarget( [ color ], depth ), sceneRT, 'one target per tuple' );
		assert.equal( sceneRT.samples, 4, 'samples: scene' );
		assert.equal( sceneRT.depthTexture, g.texture( depth ) );
		assert.equal( g.target( color ), sceneRT );
		assert.equal( g.target( depth ), sceneRT );
		const fogRT = g.renderTarget( [ fog ] );
		assert.equal( fogRT.depthBuffer, false );
		assert.throws( () => g.renderTarget( [ color, fog ] ), /different size classes/ );
		assert.throws( () => g.renderTarget( [ linear ], depth ), /different sample counts/ );
		assert.throws( () => g.renderTarget( [], depth ), /no colour attachment/ );
		assert.throws( () => g.previous( fog ), /a render target already holds it/ );
		const drawn = [];
		g.addPass( 'opaque', 'callback', ( b ) => ( color = b.write( color, { clear: true } ), depth = b.depth( depth, { write: true, clear: true } ), { label: 'o', run: () => drawn.push( r.getRenderTarget() ) } ) );
		g.addPass( 'resolve', 'callback', ( b ) => ( b.read( depth, 'samples' ), linear = b.write( linear ), { label: 'r', run: () => drawn.push( r.getRenderTarget() ) } ) );
		g.addPass( 'output', 'callback', ( b ) => ( b.read( color ), b.read( linear ), canvas = b.write( canvas ), { label: 'out', run: () => {} } ) );
		g.compile();
		g.setExtents( extents( 101, 51 ) );
		g.execute( {} );
		assert.equal( drawn[ 0 ], sceneRT, 'the pass draws into the target made ahead' );
		assert.equal( g.target( linear ), drawn[ 1 ] );
		assert.deepEqual( [ sceneRT.width, sceneRT.height, fogRT.width, fogRT.height ], [ 101, 51, 50, 25 ], 'every target the graph made follows its class' );
		assert.deepEqual( [ g.texture( depth ).image.width, g.texture( depth ).image.height ], [ 101, 51 ] );
		assert.equal( r.log.filter( ( e ) => e[ 0 ] === 'init' ).length, 0, 'nothing shared: every target initialises itself when drawn' );

	} ],

	[ 'runtime: resize hooks get their class\'s size with its rounding, once per change; validateSizes finds a target resized behind the graph', () => {

		const r = mockRenderer();
		const g = new FrameGraph( r, { sceneSamples: 1 } );
		const a = g.color( 'a', { size: RENDER } );
		const rt = g.renderTarget( [ a ] );
		const calls = [];
		g.onResize( RENDER, ( w, h ) => calls.push( [ 'render', w, h ] ) );
		g.onResize( { of: 'render', scale: 0.5, min: 1 }, ( w, h ) => calls.push( [ 'half', w, h ] ) );
		g.onResize( CANVAS, ( w, h ) => calls.push( [ 'canvas', w, h ] ) );
		assert.deepEqual( calls, [], 'nothing before the extents are set' );
		g.setExtents( { render: { width: 1673, height: 941 }, canvas: { width: 2560, height: 1440 } } );
		assert.deepEqual( calls, [ [ 'render', 1673, 941 ], [ 'half', 836, 470 ], [ 'canvas', 2560, 1440 ] ] );
		calls.length = 0;
		g.setExtents( { render: { width: 1673, height: 941 }, canvas: { width: 2560, height: 1440 } } );
		assert.deepEqual( calls, [], 'unchanged extents call no hook' );
		g.setExtents( { render: { width: 1500, height: 844 }, canvas: { width: 2560, height: 1440 } } );
		assert.deepEqual( calls, [ [ 'render', 1500, 844 ], [ 'half', 750, 422 ] ], 'a render change leaves the canvas class alone' );
		const late = [];
		g.onResize( RENDER, ( w, h ) => late.push( [ w, h ] ) );
		assert.deepEqual( late, [ [ 1500, 844 ] ], 'a hook added after the extents runs at once' );
		const e = g.extent( { of: 'render', divisor: 4 } );
		assert.deepEqual( [ e.value.x, e.value.y ], [ 375, 211 ] );
		const error = console.error;
		console.error = () => {};
		try {

			assert.equal( g.validateSizes(), 0 );
			rt.setSize( 10, 10 );
			assert.equal( g.validateSizes(), 1 );
			assert.equal( g.sizeErrors, 1 );

		} finally {

			console.error = error;

		}

	} ],

];
