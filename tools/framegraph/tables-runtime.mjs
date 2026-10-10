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

	[ 'runtime: after a resize every target is initialised in order before a pass draws; depth is sized by the graph', () => {

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
		assert.equal( inits.length, 4, 'opaque, overlay, surface and the copy destination\'s own target' );
		assert.deepEqual( inits.slice( 0, 3 ), drawn.slice( 0, 3 ), 'in declaration order' );
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
		assert.equal( r.log.filter( ( e ) => e[ 0 ] === 'init' ).length, 4 );
		assert.ok( r.log.findIndex( ( e ) => e[ 0 ] === 'copy' ) > 3, 'initialised before the frame-end copy' );
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
			// the passes never begin a render pass here, so the legacy discard in the rain is missed
			g.execute( {} );
			assert.equal( g.opsMismatchFrames, 1 );
			g.attachmentOps.uninstall();

		} finally {

			console.warn = warn;

		}

	} ],

];
