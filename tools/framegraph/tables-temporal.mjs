// The frame graph under the temporal modes (aa=taa|taau, Pipeline.declareTemporalScene): the graph
// Pipeline declares, mirrored in its order of declaration, compiled to its expected table (passes,
// reads, targets, the jittered span, the frame-end copy), its attachment ops with the overlay on and
// off, and the runtime around it on a CPU mock of three's renderer (the jitter hooks around the
// passes that run, the opaque copy and the frame-end copy). Run by tools/verify-framegraph.mjs.

import assert from 'node:assert/strict';
import { GraphDecl, compileGraph } from '../../src/post/graph/GraphCompiler.ts';
import { FrameGraph } from '../../src/post/graph/FrameGraph.ts';
import { bloomPasses, declareBloomPasses, declareBloomTargets } from './tables-passes.mjs';

const RENDER = { of: 'render' };
const CANVAS = { of: 'canvas' };
const HALF = { of: 'render', scale: 0.5, min: 1 };

/** The graph Pipeline declares under the temporal modes (its constructor, declareTemporalScene, the
 * post passes of declarePasses, AerialPerspective and LightShafts), for the post options of a
 * variant as tables-passes.mjs's declarePipeline takes them. `debugView`: a resource name the
 * debug view keeps (its pass is left out). */
export function declarePipelineTemporal( options = {} ) {

	const o = { fogScale: 0.5, bankSize: 2048, dofDistance: true, fsrPort: true, compositeOnce: true, bloomChains: 2, debugView: null, ...options };
	const g = new GraphDecl();
	const k = Math.round( 1 / o.fogScale );
	const h = {};
	// Pipeline's constructor (the scene's sample count is 1: 'scene' resolves to it)
	h.sceneColor = g.color( 'sceneColor', { size: RENDER, format: 'RGBA', type: 'HalfFloat', samples: 'scene' } );
	h.sceneDepth = g.depth( 'sceneDepth', { size: RENDER, type: 'Float', samples: 'scene' } );
	h.linearDepth = g.color( 'linearDepth', { size: RENDER, format: 'RG', type: 'Float' } );
	h.opaqueColor = g.color( 'opaqueColor', { size: RENDER, format: 'RGBA', type: 'HalfFloat' } );
	h.surfaceDepth = g.color( 'surfaceDepth', { size: RENDER, format: 'Red', type: 'Float' } );
	h.velocity = g.color( 'velocity', { size: RENDER, format: 'RGBA', type: 'HalfFloat', samples: 'scene' } );
	h.surfaceDepthPrev = g.color( 'surfaceDepthPrev', { size: RENDER, format: 'Red', type: 'Float' }, true );
	if ( o.compositeOnce ) h.hdr = g.color( 'hdr', { size: RENDER, format: 'RGBA', type: 'HalfFloat' } );
	h.sharp = g.color( 'sharp', { size: RENDER, format: 'RGBA', type: 'HalfFloat' } );
	h.blur = g.color( 'blur', { size: HALF, format: 'RGBA', type: 'HalfFloat' } );
	h.display = g.color( 'display', { size: RENDER, format: 'RGBA', type: 'Float' } );
	if ( o.dofDistance ) h.viewDistance = g.color( 'viewDistance', { size: RENDER, format: 'Red', type: 'Float' } );
	if ( o.fsrPort ) h.easu = g.color( 'FSR.easu', { size: CANVAS, format: 'RGBA', type: 'HalfFloat' } );
	h.canvas = g.import( 'canvas', { size: CANVAS }, true );
	h.constants = g.color( 'postConstants', { size: { of: 'fixed', width: 1, height: 1 }, format: 'RGBA', type: 'Float' } );
	if ( o.bankSize > 0 ) h.fogBanks = g.color( 'fogBanks', { size: { of: 'fixed', width: o.bankSize, height: o.bankSize }, format: 'Red', type: 'HalfFloat' }, true );
	if ( o.fogScale < 1 ) {

		h.fogNearestDepth = g.color( 'fogNearestDepth', { size: { of: 'render', divisor: k }, format: 'Red', type: 'Float' } );
		h.fogMarch = g.color( 'fogMarch', { size: { of: 'render', divisor: k }, format: 'RGBA', type: 'HalfFloat' } );

	}
	h.shaftsSource = g.color( 'shafts.source', { size: HALF, format: 'RGBA', type: 'HalfFloat' } );
	h.shaftsRays = g.color( 'shafts.rays', { size: HALF, format: 'RGBA', type: 'HalfFloat' } );
	h.blooms = declareBloomTargets( g, o.bloomChains );
	h.diffusion = g.import( 'diffusion', { size: HALF, format: 'RGBA', type: 'HalfFloat' } );
	const sceneMRT = { name: 'sceneMRT' }, overlayMRT = { name: 'overlayMRT' };

	// declareTemporalScene
	g.addPass( 'opaque', 'scene', ( b ) => {

		h.sceneColor = b.write( h.sceneColor, { clear: true } );
		h.velocity = b.write( h.velocity, { clear: true } );
		h.sceneDepth = b.depth( h.sceneDepth, { write: true, clear: true } );
		return { label: 'opaque scene', mrt: sceneMRT, jittered: true };

	} );
	g.addPass( 'depthResolve', 'quad', ( b ) => ( b.read( h.sceneDepth, 'samples' ), h.linearDepth = b.write( h.linearDepth ), { label: 'depth & copy resolves', jittered: true } ) );
	g.addPass( 'opaqueCopy', 'callback', ( b ) => ( b.read( h.sceneColor ), h.opaqueColor = b.write( h.opaqueColor, { clear: true } ), { label: 'depth & copy resolves', jittered: true } ) );
	g.addPass( 'water', 'scene', ( b ) => {

		b.read( h.opaqueColor );
		b.read( h.linearDepth );
		h.sceneColor = b.write( h.sceneColor );
		h.velocity = b.write( h.velocity );
		h.sceneDepth = b.depth( h.sceneDepth, { write: true } );
		return { label: 'water', mrt: sceneMRT, jittered: true };

	} );
	g.addPass( 'surfaceResolve', 'quad', ( b ) => {

		b.read( h.sceneDepth, 'samples' );
		h.surfaceDepth = b.write( h.surfaceDepth );
		if ( h.viewDistance ) h.viewDistance = b.write( h.viewDistance );
		return { label: 'depth & copy resolves', jittered: true, mrt: h.viewDistance ? {} : null };

	} );
	g.addPass( 'overlay', 'scene', ( b ) => {

		b.read( h.linearDepth );
		b.read( h.surfaceDepth );
		h.sceneColor = b.write( h.sceneColor, { blend: 'material' } );
		h.velocity = b.write( h.velocity, { blend: 'keep-max' } );
		b.depth( h.sceneDepth, { write: false } );
		return { label: 'overlay', mrt: overlayMRT, jittered: true, when: () => true, whenLabel: 'rain || spray' };

	} );
	g.copyToPersistent( h.surfaceDepth, h.surfaceDepthPrev );
	// the post passes, as under msaa (declarePasses, AerialPerspective.passes, LightShafts.passes)
	const FOG = 'composite (air, fog, veil)';
	if ( h.fogBanks ) g.addPass( 'fogBank', 'quad', ( b ) => ( h.fogBanks = b.write( h.fogBanks ), { label: FOG, when: () => true, whenLabel: 'fog && bankDue' } ) );
	if ( h.fogMarch ) {

		g.addPass( 'fogDepth', 'quad', ( b ) => ( b.read( h.surfaceDepth ), h.fogNearestDepth = b.write( h.fogNearestDepth ), { label: FOG, when: () => true, whenLabel: 'fog' } ) );
		g.addPass( 'fogMarch', 'quad', ( b ) => {

			b.readOptional( h.fogNearestDepth );
			if ( h.fogBanks ) b.readOptional( h.fogBanks );
			h.fogMarch = b.write( h.fogMarch );
			return { label: FOG, when: () => true, whenLabel: 'fog' };

		} );

	}
	const fogReads = [ h.fogMarch, h.fogNearestDepth, h.fogBanks ].filter( Boolean );
	const shaftReads = [];
	g.addPass( 'shaftsSource', 'quad', ( b ) => ( b.read( h.surfaceDepth ), shaftReads[ 0 ] = b.write( h.shaftsSource ), { label: 'light shafts', when: () => true, whenLabel: 'facing > 0' } ) );
	g.addPass( 'shaftsRays', 'quad', ( b ) => ( b.readOptional( shaftReads[ 0 ] ), shaftReads[ 1 ] = b.write( h.shaftsRays ), { label: 'light shafts', when: () => true, whenLabel: 'facing > 0' } ) );
	g.addPass( 'postConstants', 'quad', ( b ) => ( b.readOptional( shaftReads[ 0 ] ), h.constants = b.write( h.constants ), { label: FOG } ) );
	const compositeReads = ( b ) => {

		b.readOptional( h.sceneColor );
		b.read( h.surfaceDepth );
		for ( const x of fogReads ) b.readOptional( x );
		for ( const x of shaftReads ) b.readOptional( x );
		b.read( h.constants );

	};
	if ( h.hdr ) g.addPass( 'composite', 'quad', ( b ) => ( compositeReads( b ), h.hdr = b.write( h.hdr ), { label: FOG } ) );
	const hdrReads = ( b ) => {

		if ( h.hdr ) {

			b.read( h.hdr );
			b.read( h.surfaceDepth );

		} else compositeReads( b );

	};
	h.blooms = declareBloomPasses( g, h.blooms, hdrReads );
	g.addPass( 'sharp', 'quad', ( b ) => {

		if ( h.hdr ) b.read( h.hdr );
		else compositeReads( b );
		for ( const x of h.blooms ) b.read( x );
		h.sharp = b.write( h.sharp );
		return { label: h.hdr ? 'sharp (composite + blooms)' : FOG };

	} );
	g.addPass( 'blur', 'quad', ( b ) => {

		b.read( h.sharp );
		b.read( h.viewDistance ?? h.surfaceDepth );
		h.blur = b.write( h.blur );
		return { label: 'tilt-shift blur', when: () => true, whenLabel: 'dof > 0' };

	} );
	g.addPass( 'diffusion', 'chain', ( b ) => ( b.read( h.sharp ), b.read( h.surfaceDepth ), h.diffusion = b.write( h.diffusion ), { label: 'look glow', when: () => true, whenLabel: 'look glow' } ) );
	g.addPass( 'display', 'quad', ( b ) => {

		b.read( h.sharp );
		b.readOptional( h.blur );
		b.readOptional( h.diffusion );
		b.read( h.viewDistance ?? h.surfaceDepth );
		h.display = b.write( h.display );
		return { label: 'grade & look' };

	} );
	g.addPass( 'output', 'chain', ( b ) => ( b.read( h.display ), h.canvas = b.write( h.canvas ), { label: 'output', when: () => true, whenLabel: '!upscaling' } ) );
	if ( h.easu ) {

		g.addPass( 'easu', 'quad', ( b ) => ( b.read( h.display ), h.easu = b.write( h.easu ), { label: 'output & FSR', when: () => true, whenLabel: 'upscaling' } ) );
		g.addPass( 'upscaledOutput', 'chain', ( b ) => ( b.readOptional( h.easu ), h.canvas = b.write( h.canvas ), { label: 'output & FSR', when: () => true, whenLabel: 'upscaling' } ) );

	} else {

		g.addPass( 'upscaledOutputThree', 'chain', ( b ) => ( b.read( h.display ), h.canvas = b.write( h.canvas ), { label: 'output & FSR', when: () => true, whenLabel: 'upscaling' } ) );

	}
	if ( o.debugView ) g.setDebugView( { resource: g.resources.find( ( r ) => r.name === o.debugView ).id, version: 0, name: o.debugView } );
	return { g, h };

}

export const compileTemporal = ( options = {} ) => compileGraph( declarePipelineTemporal( options ).g, { sceneSamples: 1, legacyDiscard: [ 'rain' ] } );

// ---- the expected table

const R = 'render:1:0:0', C = 'canvas:1', H = 'render:0.5:0:1';
const w = ( name, size, format, type ) => ( { name, size, format, type, samples: 1 } );
const SCENE = [ w( 'sceneColor', R, 'RGBA', 'HalfFloat' ), w( 'velocity', R, 'RGBA', 'HalfFloat' ) ];
const DEPTH = ( write ) => ( { ...w( 'sceneDepth', R, null, 'Float' ), write } );
export const TEMPORAL_SCENE = [
	{ name: 'opaque', kind: 'scene', label: 'opaque scene', when: null, jittered: true, writes: SCENE, depth: DEPTH( true ), target: 'sceneColor+velocity|sceneDepth' },
	{ name: 'depthResolve', kind: 'quad', label: 'depth & copy resolves', when: null, jittered: true, writes: [ w( 'linearDepth', R, 'RG', 'Float' ) ], depth: null, target: 'linearDepth|-' },
	{ name: 'opaqueCopy', kind: 'callback', label: 'depth & copy resolves', when: null, jittered: true, writes: [ w( 'opaqueColor', R, 'RGBA', 'HalfFloat' ) ], depth: null, target: 'opaqueColor|-' },
	{ name: 'water', kind: 'scene', label: 'water', when: null, jittered: true, writes: SCENE, depth: DEPTH( true ), target: 'sceneColor+velocity|sceneDepth' },
	{ name: 'surfaceResolve', kind: 'quad', label: 'depth & copy resolves', when: null, jittered: true, writes: [ w( 'surfaceDepth', R, 'Red', 'Float' ), w( 'viewDistance', R, 'Red', 'Float' ) ], depth: null, target: 'surfaceDepth+viewDistance|-' },
	{ name: 'overlay', kind: 'scene', label: 'overlay', when: 'rain || spray', jittered: true, writes: SCENE, depth: DEPTH( false ), target: 'sceneColor+velocity|sceneDepth' },
];
const POST = [ 'fogBank', 'fogDepth', 'fogMarch', 'shaftsSource', 'shaftsRays', 'postConstants', 'composite', ...bloomPasses( 2 ), 'sharp', 'blur', 'diffusion', 'display', 'output', 'easu', 'upscaledOutput' ];
const READS = {
	opaque: [], depthResolve: [ 'sceneDepth@1:samples' ], opaqueCopy: [ 'sceneColor@1:sample' ],
	water: [ 'opaqueColor@1:sample', 'linearDepth@1:sample' ], surfaceResolve: [ 'sceneDepth@2:samples' ],
	overlay: [ 'linearDepth@1:sample', 'surfaceDepth@1:sample' ],
	composite: [ 'sceneColor@3:sample?', 'surfaceDepth@1:sample', 'fogMarch@1:sample?', 'fogNearestDepth@1:sample?', 'fogBanks@1:sample?', 'shafts.source@1:sample?', 'shafts.rays@1:sample?', 'postConstants@1:sample' ],
};

const col = ( resource, load, store, resolve = null ) => ( { resource, load, store, resolve } );
const dep = ( resource, write, load, store ) => ( { resource, write, load, store } );
const opsOf = ( t, pass ) => {

	const p = t.passes.find( ( x ) => x.pass === pass );
	return p && { colors: p.colors, depth: p.depth, rewrite: p.rewrite };

};
// every conditional pass of a frame with fog, the light shafts, the depth of field, the look's glow,
// drawn directly
const BASE = [ 'fogBank', 'fogDepth', 'fogMarch', 'shaftsSource', 'shaftsRays', 'blur', 'diffusion', 'output' ];

// a CPU mock of what FrameGraph calls on three's renderer (as tables-runtime.mjs's)
function mockRenderer( log ) {

	let target = null, mrt = null;
	return {
		backend: { device: { createCommandEncoder: () => ( { beginRenderPass() {} } ) }, beginRender() {} },
		depth: true, stencil: false, autoClear: true, autoClearColor: true, autoClearDepth: true, autoClearStencil: true,
		getRenderTarget: () => target, setRenderTarget: ( rt ) => { target = rt; },
		getMRT: () => mrt, setMRT: ( m ) => { mrt = m; },
		initRenderTarget: ( rt ) => log.push( `init ${ rt.textures.map( ( t ) => t.name ).join( '+' ) }` ),
		copyTextureToTexture: ( src, dst ) => log.push( `copy ${ src.name } -> ${ dst.name }` ),
		getDrawingBufferSize: ( v ) => v.set( 64, 32 ),
		render() {}, compute() {},
	};

}

export const checks = [

	[ 'temporal: the graph Pipeline declares compiles to its table (one sample, the velocity MRT, the overlay, the jittered span, the copy)', () => {

		const c = compileTemporal();
		const s = c.summary();
		assert.deepEqual( c.culled, [] );
		assert.deepEqual( c.passNames, [ ...TEMPORAL_SCENE.map( ( p ) => p.name ), ...POST ] );
		const scene = s.passes.slice( 0, TEMPORAL_SCENE.length ).map( ( p ) => ( { name: p.name, kind: p.kind, label: p.label, when: p.when, jittered: p.jittered, writes: p.writes, depth: p.depth, target: p.target } ) );
		assert.deepEqual( scene, TEMPORAL_SCENE );
		for ( const p of s.passes ) if ( READS[ p.name ] ) assert.deepEqual( p.reads, READS[ p.name ], p.name );
		// the post passes are msaa's, none jittered
		assert.ok( s.passes.slice( TEMPORAL_SCENE.length ).every( ( p ) => ! p.jittered ) );
		assert.deepEqual( s.jitterSpan, [ 'opaque', 'overlay' ] );
		assert.deepEqual( s.copies, [ 'surfaceDepth->surfaceDepthPrev' ] );
		assert.ok( s.targets.every( ( t ) => t.samples === 1 ), 'every target single-sampled' );
		assert.deepEqual( s.targets.find( ( t ) => t.key === 'sceneColor+velocity|sceneDepth' ), { key: 'sceneColor+velocity|sceneDepth', size: R, samples: 1, pingPong: false } );
		const { g } = declarePipelineTemporal();
		assert.deepEqual( g.passes.filter( ( p ) => p.hasMrt ).map( ( p ) => p.name ), [ 'opaque', 'water', 'surfaceResolve', 'overlay', ...bloomPasses( 2 ).filter( ( p ) => ! p.startsWith( 'bloomComposite' ) ) ] );
		// the history the next frame reads is persistent; nothing writes it but the copy
		const prev = g.resources.find( ( r ) => r.name === 'surfaceDepthPrev' );
		assert.ok( prev.persistent && prev.producers.length === 1 );

	} ],

	[ 'temporal: every post option variant compiles, its scene half unchanged', () => {

		for ( const variant of [ { fogScale: 1 }, { bankSize: 0 }, { dofDistance: false }, { fsrPort: false }, { compositeOnce: false }, { bloomChains: 1 } ] ) {

			const c = compileTemporal( variant );
			assert.deepEqual( c.culled, [], JSON.stringify( variant ) );
			assert.deepEqual( c.passNames.slice( 0, 6 ), TEMPORAL_SCENE.map( ( p ) => p.name ), JSON.stringify( variant ) );
			assert.deepEqual( c.summary().jitterSpan, [ 'opaque', 'overlay' ] );

		}

	} ],

	[ 'temporal derived ops: velocity and depth stored while a later pass loads them, discarded after; nothing resolved', () => {

		const c = compileTemporal();
		const wet = c.ops( 'derived', c.maskOf( [ ...BASE, 'overlay' ] ) );
		assert.deepEqual( opsOf( wet, 'opaque' ), { colors: [ col( 'sceneColor', 'clear', 'store' ), col( 'velocity', 'clear', 'store' ) ], depth: dep( 'sceneDepth', true, 'clear', 'store' ), rewrite: false } );
		assert.deepEqual( opsOf( wet, 'opaqueCopy' ), { colors: [ col( 'opaqueColor', 'clear', 'store' ) ], depth: null, rewrite: false } );
		assert.deepEqual( opsOf( wet, 'water' ), { colors: [ col( 'sceneColor', 'load', 'store' ), col( 'velocity', 'load', 'store' ) ], depth: dep( 'sceneDepth', true, 'load', 'store' ), rewrite: false } );
		// the overlay is the last pass into the scene target: its velocity (read by nothing until the
		// resolve) and its depth go
		assert.deepEqual( opsOf( wet, 'overlay' ), { colors: [ col( 'sceneColor', 'load', 'store' ), col( 'velocity', 'load', 'discard' ) ], depth: dep( 'sceneDepth', false, 'load', 'discard' ), rewrite: true } );
		assert.equal( wet.rewrites, 1 );
		const dry = c.ops( 'derived', c.maskOf( BASE ) );
		assert.deepEqual( opsOf( dry, 'water' ), { colors: [ col( 'sceneColor', 'load', 'store' ), col( 'velocity', 'load', 'discard' ) ], depth: dep( 'sceneDepth', true, 'load', 'store' ), rewrite: true } );
		assert.equal( dry.rewrites, 1 );
		// the surface depth is stored for its frame-end copy whatever reads it
		for ( let m = 0; m <= c.fullMask; m ++ ) assert.equal( opsOf( c.ops( 'derived', m ), 'surfaceResolve' ).colors[ 0 ].store, 'store' );
		// no resolve anywhere (one sample), and the legacy table (msaa's discard in the rain) rewrites nothing
		for ( let m = 0; m <= c.fullMask; m ++ ) {

			for ( const p of c.ops( 'derived', m ).passes ) for ( const x of p.colors ) assert.equal( x.resolve, null, `${ p.pass } ${ x.resource }` );
			assert.equal( c.ops( 'legacy', m ).rewrites, 0 );
			assert.equal( c.ops( 'store', m ).rewrites, 0 );

		}

	} ],

	[ 'temporal derived ops: a debug view of the velocity keeps it stored through the frame', () => {

		const c = compileTemporal( { debugView: 'velocity' } );
		for ( const mask of [ c.maskOf( [ ...BASE, 'overlay' ] ), c.maskOf( BASE ) ] ) {

			const t = c.ops( 'derived', mask );
			for ( const p of t.passes ) for ( const x of p.colors ) if ( x.resource === 'velocity' ) assert.equal( x.store, 'store', `${ p.pass } mask ${ mask }` );

		}

	} ],

	[ 'temporal runtime: the jitter hooks frame the jittered passes that run, even when one throws; the opaque copy and the frame-end copy, their destinations initialised after resizes', () => {

		const log = [];
		const g = new FrameGraph( mockRenderer( log ), { sceneSamples: 1 } );
		let sceneColor = g.color( 'sceneColor', { size: RENDER, format: 'RGBA', type: 'HalfFloat' } );
		let velocity = g.color( 'velocity', { size: RENDER, format: 'RGBA', type: 'HalfFloat' } );
		let opaqueColor = g.color( 'opaqueColor', { size: RENDER, format: 'RGBA', type: 'HalfFloat' } );
		let surfaceDepth = g.color( 'surfaceDepth', { size: RENDER, format: 'Red', type: 'Float' } );
		const surfaceDepthPrev = g.color( 'surfaceDepthPrev', { size: RENDER, format: 'Red', type: 'Float' }, true );
		let canvas = g.import( 'canvas', null, CANVAS );
		const mrt = { name: 'sceneMRT' }, overlayMRT = { name: 'overlayMRT' };
		let failing = null;
		const pass = ( name ) => ( f, graph ) => {

			if ( failing === name ) throw new Error( `${ name } failed` );
			log.push( `${ name }${ graph.renderer.getMRT() ? ` (${ graph.renderer.getMRT().name })` : '' }` );

		};
		let overlay = true;
		g.addPass( 'opaque', 'callback', ( b ) => {

			sceneColor = b.write( sceneColor, { clear: true } );
			velocity = b.write( velocity, { clear: true } );
			return { label: 'opaque scene', mrt, jittered: true, run: pass( 'opaque' ) };

		} );
		const from = g.texture( sceneColor ), to = g.texture( opaqueColor );
		g.addPass( 'opaqueCopy', 'callback', ( b ) => ( b.read( sceneColor ), opaqueColor = b.write( opaqueColor, { clear: true } ), { label: 'copy', jittered: true, copy: true, run: ( f, graph ) => graph.renderer.copyTextureToTexture( from, to ) } ) );
		g.addPass( 'water', 'callback', ( b ) => ( b.read( opaqueColor ), sceneColor = b.write( sceneColor ), velocity = b.write( velocity ), { label: 'water', mrt, jittered: true, run: pass( 'water' ) } ) );
		g.addPass( 'surfaceResolve', 'callback', ( b ) => ( surfaceDepth = b.write( surfaceDepth ), { label: 'resolve', jittered: true, run: pass( 'surfaceResolve' ) } ) );
		g.addPass( 'overlay', 'callback', ( b ) => {

			b.read( surfaceDepth );
			sceneColor = b.write( sceneColor );
			velocity = b.write( velocity );
			return { label: 'overlay', mrt: overlayMRT, jittered: true, when: () => overlay, run: pass( 'overlay' ) };

		} );
		g.addPass( 'composite', 'callback', ( b ) => ( b.readOptional( sceneColor ), b.read( surfaceDepth ), canvas = b.write( canvas ), { label: 'composite', run: pass( 'composite' ) } ) );
		g.copyToPersistent( surfaceDepth, surfaceDepthPrev );
		g.hooks.jitterBegin = () => log.push( 'jitter on' );
		g.hooks.jitterEnd = () => log.push( 'jitter off' );
		g.compile();
		g.setExtents( { render: { width: 64, height: 32 }, canvas: { width: 64, height: 32 } } );
		assert.equal( g.historyValid( surfaceDepthPrev ), false, 'no history before the first copy' );
		g.execute( {} );
		// the copies' destinations, which no pass draws into, are initialised before the frame
		assert.deepEqual( log.splice( 0, 2 ).sort(), [ 'init opaqueColor', 'init surfaceDepthPrev' ] );
		assert.deepEqual( log.splice( 0 ), [ 'jitter on', 'opaque (sceneMRT)', 'copy sceneColor -> opaqueColor', 'water (sceneMRT)', 'surfaceResolve', 'overlay (overlayMRT)', 'jitter off', 'composite', 'copy surfaceDepth -> surfaceDepthPrev' ] );
		assert.equal( g.historyValid( surfaceDepthPrev ), true );
		// without the overlay the span ends after the surface resolve
		overlay = false;
		g.execute( {} );
		assert.deepEqual( log.splice( 0 ), [ 'jitter on', 'opaque (sceneMRT)', 'copy sceneColor -> opaqueColor', 'water (sceneMRT)', 'surfaceResolve', 'jitter off', 'composite', 'copy surfaceDepth -> surfaceDepthPrev' ] );
		// a resize empties the history until the next copy, and initialises the copies' destinations
		// again (three would keep their old size: a copy is no draw)
		g.setExtents( { render: { width: 32, height: 16 }, canvas: { width: 64, height: 32 } } );
		assert.equal( g.historyValid( surfaceDepthPrev ), false );
		g.execute( {} );
		assert.deepEqual( log.filter( ( e ) => e.startsWith( 'init' ) ).sort(), [ 'init opaqueColor', 'init surfaceDepthPrev' ] );
		assert.equal( g.historyValid( surfaceDepthPrev ), true );
		// a pass that throws inside the span still takes the jitter off the camera (the next frame
		// would take the shifted projection for the camera's own)
		log.splice( 0 );
		failing = 'water';
		assert.throws( () => g.execute( {} ), /water failed/ );
		assert.deepEqual( log.filter( ( e ) => e.startsWith( 'jitter' ) ), [ 'jitter on', 'jitter off' ] );
		failing = null;

	} ],

];
