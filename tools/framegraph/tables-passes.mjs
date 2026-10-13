// The frame graph's passes: today's msaa4 graph with every draw a pass of its own, the graph
// Pipeline declares (src/post/Pipeline.ts, mirrored in its order of declaration: it compiles to
// today's graph), their load-time and runtime variants, a mock temporal graph, and the compiler's
// checks of order, culling, hazards, readOptional and determinism. Run by
// tools/verify-framegraph.mjs.

import assert from 'node:assert/strict';
import { GraphDecl, GraphError, compileGraph, resolveSize } from '../../src/post/graph/GraphCompiler.ts';

const RENDER = { of: 'render' };
const CANVAS = { of: 'canvas' };
// half the render, at least a texel: the blooms' results, the blur and the light shafts
const HALF = { of: 'render', scale: 0.5, min: 1 };

/** Today's msaa4 graph with a pass for every draw (Pipeline, AerialPerspective.passes, FSR), as
 * the expected table: the graph Pipeline declares (declarePipeline below) compiles to it. For the
 * post options of a variant:
 * `fogScale` (1: the full-resolution fog of post=full-fog), `bankSize` (0: no-bank),
 * `dofDistance` (false: inline-coc), `fsrPort` (false: three-fsr), `compositeOnce` (false:
 * inline-composite), `bloomChains` (1: the low tier's one bloom), `samples` (the scene's). */
export function declareToday( options = {} ) {

	const o = { fogScale: 0.5, bankSize: 2048, dofDistance: true, fsrPort: true, compositeOnce: true, bloomChains: 2, ...options };
	const g = new GraphDecl();
	const k = Math.round( 1 / o.fogScale );
	const h = {};
	h.sceneColor = g.color( 'sceneColor', { size: RENDER, format: 'RGBA', type: 'HalfFloat', samples: 'scene' } );
	h.sceneDepth = g.depth( 'sceneDepth', { size: RENDER, type: 'Float', samples: 'scene' } );
	h.linearDepth = g.color( 'linearDepth', { size: RENDER, format: 'RG', type: 'Float' } );
	h.opaqueColor = g.color( 'opaqueColor', { size: RENDER, format: 'RGBA', type: 'HalfFloat' } );
	h.surfaceDepth = g.color( 'surfaceDepth', { size: RENDER, format: 'Red', type: 'Float' } );
	if ( o.bankSize > 0 ) h.fogBanks = g.color( 'fogBanks', { size: { of: 'fixed', width: o.bankSize, height: o.bankSize }, format: 'Red', type: 'HalfFloat' }, true );
	if ( o.fogScale < 1 ) {

		h.fogNearestDepth = g.color( 'fogNearestDepth', { size: { of: 'render', divisor: k }, format: 'Red', type: 'Float' } );
		h.fogMarch = g.color( 'fogMarch', { size: { of: 'render', divisor: k }, format: 'RGBA', type: 'HalfFloat' } );

	}
	if ( o.dofDistance ) h.viewDistance = g.color( 'viewDistance', { size: RENDER, format: 'Red', type: 'Float' } );
	if ( o.compositeOnce ) h.hdr = g.color( 'hdr', { size: RENDER, format: 'RGBA', type: 'HalfFloat' } );
	h.sharp = g.color( 'sharp', { size: RENDER, format: 'RGBA', type: 'HalfFloat' } );
	h.blur = g.color( 'blur', { size: HALF, format: 'RGBA', type: 'HalfFloat' } );
	h.shaftsSource = g.color( 'shafts.source', { size: HALF, format: 'RGBA', type: 'HalfFloat' } );
	h.shaftsRays = g.color( 'shafts.rays', { size: HALF, format: 'RGBA', type: 'HalfFloat' } );
	// the bloom chains' results and the look glow's (three's targets, imported)
	h.blooms = [ 'bloom', 'glow' ].slice( 0, o.bloomChains ).map( ( name ) => g.import( name, { size: HALF, format: 'RGBA', type: 'HalfFloat' } ) );
	h.diffusion = g.import( 'diffusion', { size: HALF, format: 'RGBA', type: 'HalfFloat' } );
	h.display = g.color( 'display', { size: RENDER, format: 'RGBA', type: 'Float' } );
	if ( o.fsrPort ) h.easu = g.color( 'FSR.easu', { size: CANVAS, format: 'RGBA', type: 'HalfFloat' } );
	h.canvas = g.import( 'canvas', { size: CANVAS }, true );

	g.addPass( 'opaque', 'scene', ( b ) => {

		h.sceneColor = b.write( h.sceneColor, { clear: true } );
		h.sceneDepth = b.depth( h.sceneDepth, { write: true, clear: true } );
		return { label: 'opaque scene' };

	} );
	g.addPass( 'depthResolve', 'quad', ( b ) => {

		b.read( h.sceneDepth, 'samples' );
		h.linearDepth = b.write( h.linearDepth );
		return { label: 'depth & copy resolves' };

	} );
	g.addPass( 'opaqueCopy', 'quad', ( b ) => {

		b.read( h.sceneColor );
		h.opaqueColor = b.write( h.opaqueColor );
		return { label: 'depth & copy resolves' };

	} );
	g.addPass( 'water', 'scene', ( b ) => {

		b.read( h.opaqueColor );
		b.read( h.linearDepth );
		h.sceneColor = b.write( h.sceneColor );
		h.sceneDepth = b.depth( h.sceneDepth, { write: true } );
		return { label: 'water' };

	} );
	g.addPass( 'surfaceResolve', 'quad', ( b ) => {

		b.read( h.sceneDepth, 'samples' );
		h.surfaceDepth = b.write( h.surfaceDepth );
		return { label: 'depth & copy resolves' };

	} );
	g.addPass( 'rain', 'scene', ( b ) => {

		b.read( h.linearDepth );
		b.read( h.surfaceDepth );
		h.sceneColor = b.write( h.sceneColor );
		b.depth( h.sceneDepth, { write: false } );
		return { label: 'rain draw', when: () => true, whenLabel: 'rainVisible' };

	} );
	if ( h.fogBanks ) g.addPass( 'fogBank', 'quad', ( b ) => {

		h.fogBanks = b.write( h.fogBanks );
		return { label: 'composite (air, fog, veil)', when: () => true, whenLabel: 'fog && bankDue' };

	} );
	if ( h.fogMarch ) {

		g.addPass( 'fogDepth', 'quad', ( b ) => {

			b.read( h.surfaceDepth );
			h.fogNearestDepth = b.write( h.fogNearestDepth );
			return { label: 'composite (air, fog, veil)', when: () => true, whenLabel: 'fog' };

		} );
		g.addPass( 'fogMarch', 'quad', ( b ) => {

			b.readOptional( h.fogNearestDepth );
			if ( h.fogBanks ) b.readOptional( h.fogBanks );
			h.fogMarch = b.write( h.fogMarch );
			return { label: 'composite (air, fog, veil)', when: () => true, whenLabel: 'fog' };

		} );

	}
	if ( h.viewDistance ) g.addPass( 'viewDistance', 'quad', ( b ) => {

		b.read( h.surfaceDepth );
		h.viewDistance = b.write( h.viewDistance );
		return { label: 'tilt-shift blur', when: () => true, whenLabel: 'dof > 0' };

	} );
	// the light shafts: the open sky near the sun, the rays marched over it
	g.addPass( 'shaftsSource', 'quad', ( b ) => {

		b.read( h.surfaceDepth );
		h.shaftsSource = b.write( h.shaftsSource );
		return { label: 'light shafts' };

	} );
	g.addPass( 'shaftsRays', 'quad', ( b ) => {

		b.read( h.shaftsSource );
		h.shaftsRays = b.write( h.shaftsRays );
		return { label: 'light shafts' };

	} );
	// what the composite reads: the scene after the rain, the surface depth, the sea fog and the shafts
	const compositeReads = ( b ) => {

		b.readOptional( h.sceneColor );
		b.read( h.surfaceDepth );
		if ( h.fogMarch ) {

			b.readOptional( h.fogMarch );
			b.readOptional( h.fogNearestDepth );

		}
		if ( h.fogBanks ) b.readOptional( h.fogBanks );
		b.read( h.shaftsSource );
		b.read( h.shaftsRays );

	};
	// the composite of air, fog, veil and shafts, rendered once into hdr
	if ( h.hdr ) g.addPass( 'composite', 'quad', ( b ) => {

		compositeReads( b );
		h.hdr = b.write( h.hdr );
		return { label: 'composite (air, fog, veil)' };

	} );
	// the blooms: three's bloom chains, a pass each (the tight bloom; the wide glow)
	h.blooms = h.blooms.map( ( out, i ) => {

		g.addPass( i === 0 ? 'bloom' : 'glow', 'chain', ( b ) => {

			if ( h.hdr ) {

				b.read( h.hdr );
				b.read( h.surfaceDepth );

			} else compositeReads( b );
			out = b.write( out );
			return { label: i === 0 ? 'bloom' : 'wide glow' };

		} );
		return out;

	} );
	// the sharp image (the composite and the blooms; the composite inline, inline-composite)
	g.addPass( 'sharp', 'quad', ( b ) => {

		if ( h.hdr ) b.read( h.hdr );
		else compositeReads( b );
		for ( const x of h.blooms ) b.read( x );
		h.sharp = b.write( h.sharp );
		return { label: h.hdr ? 'sharp (composite + blooms)' : 'composite (air, fog, veil)' };

	} );
	// the depth of field's half-resolution gather
	g.addPass( 'blur', 'quad', ( b ) => {

		b.read( h.sharp );
		if ( h.viewDistance ) b.readOptional( h.viewDistance );
		else b.read( h.surfaceDepth );
		h.blur = b.write( h.blur );
		return { label: 'tilt-shift blur' };

	} );
	// the look's glow, a bloom chain over the sharp image, while it shows
	g.addPass( 'diffusion', 'chain', ( b ) => {

		b.read( h.sharp );
		b.read( h.surfaceDepth );
		h.diffusion = b.write( h.diffusion );
		return { label: 'look glow', when: () => true, whenLabel: 'look glow' };

	} );
	// the depth of field's mix, the glow, grade and look
	g.addPass( 'display', 'quad', ( b ) => {

		b.read( h.sharp );
		b.read( h.blur );
		b.readOptional( h.diffusion );
		b.read( h.surfaceDepth );
		if ( h.viewDistance ) b.readOptional( h.viewDistance );
		h.display = b.write( h.display );
		return { label: 'grade & look' };

	} );
	g.addPass( 'output', 'chain', ( b ) => {

		b.read( h.display );
		h.canvas = b.write( h.canvas );
		return { label: 'output', when: () => true, whenLabel: '!upscaling' };

	} );
	if ( o.fsrPort ) {

		g.addPass( 'easu', 'quad', ( b ) => {

			b.read( h.display );
			h.easu = b.write( h.easu );
			return { label: 'output & FSR', when: () => true, whenLabel: 'upscaling' };

		} );
		g.addPass( 'upscaledOutput', 'chain', ( b ) => {

			b.readOptional( h.easu );
			h.canvas = b.write( h.canvas );
			return { label: 'output & FSR', when: () => true, whenLabel: 'upscaling' };

		} );

	} else {

		// three's FSR1Node: its passes run inside the chain, at the canvas's size
		g.addPass( 'upscaledOutputThree', 'chain', ( b ) => {

			b.read( h.display );
			h.canvas = b.write( h.canvas );
			return { label: 'output & FSR', when: () => true, whenLabel: 'upscaling' };

		} );

	}
	return { g, h };

}

export const compileToday = ( options = {}, samples = 4, legacyDiscard ) =>
	compileGraph( declareToday( options ).g, { sceneSamples: samples, ...( legacyDiscard ? { legacyDiscard } : {} ) } );

/** The graph Pipeline declares (Pipeline's constructor and declarePasses, AerialPerspective.apply
 * and passes), in its order of declaration, for the post options of a variant as in declareToday:
 * every draw of the frame is a pass of its own. Compiled, it is today's graph (declareToday). */
export function declarePipeline( options = {} ) {

	const o = { fogScale: 0.5, bankSize: 2048, dofDistance: true, fsrPort: true, compositeOnce: true, bloomChains: 2, ...options };
	const g = new GraphDecl();
	const k = Math.round( 1 / o.fogScale );
	const h = {};
	// Pipeline's constructor
	h.sceneColor = g.color( 'sceneColor', { size: RENDER, format: 'RGBA', type: 'HalfFloat', samples: 'scene' } );
	h.sceneDepth = g.depth( 'sceneDepth', { size: RENDER, type: 'Float', samples: 'scene' } );
	h.linearDepth = g.color( 'linearDepth', { size: RENDER, format: 'RG', type: 'Float' } );
	h.opaqueColor = g.color( 'opaqueColor', { size: RENDER, format: 'RGBA', type: 'HalfFloat' } );
	h.surfaceDepth = g.color( 'surfaceDepth', { size: RENDER, format: 'Red', type: 'Float' } );
	if ( o.compositeOnce ) h.hdr = g.color( 'hdr', { size: RENDER, format: 'RGBA', type: 'HalfFloat' } );
	h.sharp = g.color( 'sharp', { size: RENDER, format: 'RGBA', type: 'HalfFloat' } );
	h.blur = g.color( 'blur', { size: HALF, format: 'RGBA', type: 'HalfFloat' } );
	h.display = g.color( 'display', { size: RENDER, format: 'RGBA', type: 'Float' } );
	if ( o.dofDistance ) h.viewDistance = g.color( 'viewDistance', { size: RENDER, format: 'Red', type: 'Float' } );
	if ( o.fsrPort ) h.easu = g.color( 'FSR.easu', { size: CANVAS, format: 'RGBA', type: 'HalfFloat' } );
	h.canvas = g.import( 'canvas', { size: CANVAS }, true );
	// AerialPerspective.apply
	if ( o.bankSize > 0 ) h.fogBanks = g.color( 'fogBanks', { size: { of: 'fixed', width: o.bankSize, height: o.bankSize }, format: 'Red', type: 'HalfFloat' }, true );
	if ( o.fogScale < 1 ) {

		h.fogNearestDepth = g.color( 'fogNearestDepth', { size: { of: 'render', divisor: k }, format: 'Red', type: 'Float' } );
		h.fogMarch = g.color( 'fogMarch', { size: { of: 'render', divisor: k }, format: 'RGBA', type: 'HalfFloat' } );

	}
	// LightShafts.build
	h.shaftsSource = g.color( 'shafts.source', { size: HALF, format: 'RGBA', type: 'HalfFloat' } );
	h.shaftsRays = g.color( 'shafts.rays', { size: HALF, format: 'RGBA', type: 'HalfFloat' } );
	// Pipeline's constructor, after the composite: the bloom chains' results and the look glow's
	// (three's targets)
	h.blooms = [ 'bloom', 'glow' ].slice( 0, o.bloomChains ).map( ( name ) => g.import( name, { size: HALF, format: 'RGBA', type: 'HalfFloat' } ) );
	h.diffusion = g.import( 'diffusion', { size: HALF, format: 'RGBA', type: 'HalfFloat' } );

	// declarePasses: the scene half
	g.addPass( 'opaque', 'scene', ( b ) => {

		h.sceneColor = b.write( h.sceneColor, { clear: true } );
		h.sceneDepth = b.depth( h.sceneDepth, { write: true, clear: true } );
		return { label: 'opaque scene' };

	} );
	g.addPass( 'depthResolve', 'quad', ( b ) => {

		b.read( h.sceneDepth, 'samples' );
		h.linearDepth = b.write( h.linearDepth );
		return { label: 'depth & copy resolves' };

	} );
	g.addPass( 'opaqueCopy', 'quad', ( b ) => {

		b.read( h.sceneColor );
		h.opaqueColor = b.write( h.opaqueColor );
		return { label: 'depth & copy resolves' };

	} );
	g.addPass( 'water', 'scene', ( b ) => {

		b.read( h.opaqueColor );
		b.read( h.linearDepth );
		h.sceneColor = b.write( h.sceneColor );
		h.sceneDepth = b.depth( h.sceneDepth, { write: true } );
		return { label: 'water' };

	} );
	g.addPass( 'surfaceResolve', 'quad', ( b ) => {

		b.read( h.sceneDepth, 'samples' );
		h.surfaceDepth = b.write( h.surfaceDepth );
		return { label: 'depth & copy resolves' };

	} );
	g.addPass( 'rain', 'scene', ( b ) => {

		b.read( h.linearDepth );
		b.read( h.surfaceDepth );
		h.sceneColor = b.write( h.sceneColor );
		b.depth( h.sceneDepth, { write: false } );
		return { label: 'rain draw', when: () => true, whenLabel: 'rainVisible' };

	} );
	// AerialPerspective.passes
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
	// declarePasses: the post passes
	if ( h.viewDistance ) g.addPass( 'viewDistance', 'quad', ( b ) => ( b.read( h.surfaceDepth ), h.viewDistance = b.write( h.viewDistance ), { label: 'tilt-shift blur', when: () => true, whenLabel: 'dof > 0' } ) );
	// LightShafts.passes
	const shaftReads = [];
	g.addPass( 'shaftsSource', 'quad', ( b ) => ( b.read( h.surfaceDepth ), shaftReads[ 0 ] = b.write( h.shaftsSource ), { label: 'light shafts' } ) );
	g.addPass( 'shaftsRays', 'quad', ( b ) => ( b.read( shaftReads[ 0 ] ), shaftReads[ 1 ] = b.write( h.shaftsRays ), { label: 'light shafts' } ) );
	const compositeReads = ( b ) => {

		b.readOptional( h.sceneColor );
		b.read( h.surfaceDepth );
		for ( const x of fogReads ) b.readOptional( x );
		for ( const x of shaftReads ) b.read( x );

	};
	if ( h.hdr ) g.addPass( 'composite', 'quad', ( b ) => ( compositeReads( b ), h.hdr = b.write( h.hdr ), { label: 'composite (air, fog, veil)' } ) );
	const hdrReads = ( b ) => {

		if ( h.hdr ) {

			b.read( h.hdr );
			b.read( h.surfaceDepth );

		} else compositeReads( b );

	};
	h.blooms = h.blooms.map( ( out, i ) => ( g.addPass( i === 0 ? 'bloom' : 'glow', 'chain', ( b ) => ( hdrReads( b ), out = b.write( out ), { label: i === 0 ? 'bloom' : 'wide glow' } ) ), out ) );
	g.addPass( 'sharp', 'quad', ( b ) => {

		if ( h.hdr ) b.read( h.hdr );
		else compositeReads( b );
		for ( const x of h.blooms ) b.read( x );
		h.sharp = b.write( h.sharp );
		return { label: h.hdr ? 'sharp (composite + blooms)' : 'composite (air, fog, veil)' };

	} );
	g.addPass( 'blur', 'quad', ( b ) => {

		b.read( h.sharp );
		if ( h.viewDistance ) b.readOptional( h.viewDistance );
		else b.read( h.surfaceDepth );
		h.blur = b.write( h.blur );
		return { label: 'tilt-shift blur' };

	} );
	g.addPass( 'diffusion', 'chain', ( b ) => ( b.read( h.sharp ), b.read( h.surfaceDepth ), h.diffusion = b.write( h.diffusion ), { label: 'look glow', when: () => true, whenLabel: 'look glow' } ) );
	g.addPass( 'display', 'quad', ( b ) => {

		b.read( h.sharp );
		b.read( h.blur );
		b.readOptional( h.diffusion );
		b.read( h.surfaceDepth );
		if ( h.viewDistance ) b.readOptional( h.viewDistance );
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
	return { g, h };

}

export const compilePipeline = ( options = {}, samples = 4, legacyDiscard ) =>
	compileGraph( declarePipeline( options ).g, { sceneSamples: samples, ...( legacyDiscard ? { legacyDiscard } : {} ) } );

// ---- the expected table of today's msaa4 graph

const R = 'render:1:0:0', C = 'canvas:1', H = 'render:0.5:0:1';
const w = ( name, size, format, type, samples = 1 ) => ( { name, size, format, type, samples } );
export const TODAY = [
	{ name: 'opaque', kind: 'scene', label: 'opaque scene', when: null, size: R, writes: [ w( 'sceneColor', R, 'RGBA', 'HalfFloat', 4 ) ], depth: { ...w( 'sceneDepth', R, null, 'Float', 4 ), write: true }, target: 'sceneColor|sceneDepth' },
	{ name: 'depthResolve', kind: 'quad', label: 'depth & copy resolves', when: null, size: R, writes: [ w( 'linearDepth', R, 'RG', 'Float' ) ], depth: null, target: 'linearDepth|-' },
	{ name: 'opaqueCopy', kind: 'quad', label: 'depth & copy resolves', when: null, size: R, writes: [ w( 'opaqueColor', R, 'RGBA', 'HalfFloat' ) ], depth: null, target: 'opaqueColor|-' },
	{ name: 'water', kind: 'scene', label: 'water', when: null, size: R, writes: [ w( 'sceneColor', R, 'RGBA', 'HalfFloat', 4 ) ], depth: { ...w( 'sceneDepth', R, null, 'Float', 4 ), write: true }, target: 'sceneColor|sceneDepth' },
	{ name: 'surfaceResolve', kind: 'quad', label: 'depth & copy resolves', when: null, size: R, writes: [ w( 'surfaceDepth', R, 'Red', 'Float' ) ], depth: null, target: 'surfaceDepth|-' },
	{ name: 'rain', kind: 'scene', label: 'rain draw', when: 'rainVisible', size: R, writes: [ w( 'sceneColor', R, 'RGBA', 'HalfFloat', 4 ) ], depth: { ...w( 'sceneDepth', R, null, 'Float', 4 ), write: false }, target: 'sceneColor|sceneDepth' },
	{ name: 'fogBank', kind: 'quad', label: 'composite (air, fog, veil)', when: 'fog && bankDue', size: 'fixed:2048x2048', writes: [ w( 'fogBanks', 'fixed:2048x2048', 'Red', 'HalfFloat' ) ], depth: null, target: 'fogBanks|-' },
	{ name: 'fogDepth', kind: 'quad', label: 'composite (air, fog, veil)', when: 'fog', size: 'render:1:2:0', writes: [ w( 'fogNearestDepth', 'render:1:2:0', 'Red', 'Float' ) ], depth: null, target: 'fogNearestDepth|-' },
	{ name: 'fogMarch', kind: 'quad', label: 'composite (air, fog, veil)', when: 'fog', size: 'render:1:2:0', writes: [ w( 'fogMarch', 'render:1:2:0', 'RGBA', 'HalfFloat' ) ], depth: null, target: 'fogMarch|-' },
	{ name: 'viewDistance', kind: 'quad', label: 'tilt-shift blur', when: 'dof > 0', size: R, writes: [ w( 'viewDistance', R, 'Red', 'Float' ) ], depth: null, target: 'viewDistance|-' },
	{ name: 'shaftsSource', kind: 'quad', label: 'light shafts', when: null, size: H, writes: [ w( 'shafts.source', H, 'RGBA', 'HalfFloat' ) ], depth: null, target: 'shafts.source|-' },
	{ name: 'shaftsRays', kind: 'quad', label: 'light shafts', when: null, size: H, writes: [ w( 'shafts.rays', H, 'RGBA', 'HalfFloat' ) ], depth: null, target: 'shafts.rays|-' },
	{ name: 'composite', kind: 'quad', label: 'composite (air, fog, veil)', when: null, size: R, writes: [ w( 'hdr', R, 'RGBA', 'HalfFloat' ) ], depth: null, target: 'hdr|-' },
	{ name: 'bloom', kind: 'chain', label: 'bloom', when: null, size: H, writes: [ w( 'bloom', H, 'RGBA', 'HalfFloat' ) ], depth: null, target: 'bloom|-' },
	{ name: 'glow', kind: 'chain', label: 'wide glow', when: null, size: H, writes: [ w( 'glow', H, 'RGBA', 'HalfFloat' ) ], depth: null, target: 'glow|-' },
	{ name: 'sharp', kind: 'quad', label: 'sharp (composite + blooms)', when: null, size: R, writes: [ w( 'sharp', R, 'RGBA', 'HalfFloat' ) ], depth: null, target: 'sharp|-' },
	{ name: 'blur', kind: 'quad', label: 'tilt-shift blur', when: null, size: H, writes: [ w( 'blur', H, 'RGBA', 'HalfFloat' ) ], depth: null, target: 'blur|-' },
	{ name: 'diffusion', kind: 'chain', label: 'look glow', when: 'look glow', size: H, writes: [ w( 'diffusion', H, 'RGBA', 'HalfFloat' ) ], depth: null, target: 'diffusion|-' },
	{ name: 'display', kind: 'quad', label: 'grade & look', when: null, size: R, writes: [ w( 'display', R, 'RGBA', 'Float' ) ], depth: null, target: 'display|-' },
	{ name: 'output', kind: 'chain', label: 'output', when: '!upscaling', size: C, writes: [ w( 'canvas', C, null, null ) ], depth: null, target: 'canvas|-' },
	{ name: 'easu', kind: 'quad', label: 'output & FSR', when: 'upscaling', size: C, writes: [ w( 'FSR.easu', C, 'RGBA', 'HalfFloat' ) ], depth: null, target: 'FSR.easu|-' },
	{ name: 'upscaledOutput', kind: 'chain', label: 'output & FSR', when: 'upscaling', size: C, writes: [ w( 'canvas', C, null, null ) ], depth: null, target: 'canvas|-' },
];

// what each pass of today's graph reads (`resource@version:mode`, `?` optional)
export const TODAY_READS = {
	opaque: [], depthResolve: [ 'sceneDepth@1:samples' ], opaqueCopy: [ 'sceneColor@1:sample' ],
	water: [ 'opaqueColor@1:sample', 'linearDepth@1:sample' ], surfaceResolve: [ 'sceneDepth@2:samples' ],
	rain: [ 'linearDepth@1:sample', 'surfaceDepth@1:sample' ], fogBank: [], fogDepth: [ 'surfaceDepth@1:sample' ],
	fogMarch: [ 'fogNearestDepth@1:sample?', 'fogBanks@1:sample?' ], viewDistance: [ 'surfaceDepth@1:sample' ],
	shaftsSource: [ 'surfaceDepth@1:sample' ], shaftsRays: [ 'shafts.source@1:sample' ],
	composite: [ 'sceneColor@3:sample?', 'surfaceDepth@1:sample', 'fogMarch@1:sample?', 'fogNearestDepth@1:sample?', 'fogBanks@1:sample?', 'shafts.source@1:sample', 'shafts.rays@1:sample' ],
	bloom: [ 'hdr@1:sample', 'surfaceDepth@1:sample' ], glow: [ 'hdr@1:sample', 'surfaceDepth@1:sample' ],
	sharp: [ 'hdr@1:sample', 'bloom@1:sample', 'glow@1:sample' ], blur: [ 'sharp@1:sample', 'viewDistance@1:sample?' ],
	diffusion: [ 'sharp@1:sample', 'surfaceDepth@1:sample' ],
	display: [ 'sharp@1:sample', 'blur@1:sample', 'diffusion@1:sample?', 'surfaceDepth@1:sample', 'viewDistance@1:sample?' ],
	output: [ 'display@1:sample' ], easu: [ 'display@1:sample' ], upscaledOutput: [ 'FSR.easu@1:sample?' ],
};

const ALL = TODAY.map( ( p ) => p.name );
const without = ( ...names ) => ALL.filter( ( n ) => ! names.includes( n ) );

function compareTable( summary, expected ) {

	const got = summary.passes.map( ( p ) => ( { name: p.name, kind: p.kind, label: p.label, when: p.when, size: p.size, writes: p.writes, depth: p.depth, target: p.target } ) );
	assert.deepEqual( got, expected );
	assert.ok( summary.passes.every( ( p ) => ! p.culled ), 'nothing of today\'s graph is culled' );

}

// ---- checks

export const checks = [

	[ 'pipeline: the graph Pipeline declares is today\'s graph, in every variant (passes, reads, targets, ops)', () => {

		const c = compilePipeline();
		const s = c.summary();
		compareTable( s, TODAY );
		assert.deepEqual( Object.fromEntries( s.passes.map( ( p ) => [ p.name, p.reads ] ) ), TODAY_READS );
		const dump = ( x ) => JSON.stringify( {
			summary: x.summary(),
			ops: Array.from( { length: x.fullMask + 1 }, ( _, m ) => [ x.ops( 'legacy', m ), x.ops( 'derived', m ) ] ),
		} );
		const variants = [ {}, { fogScale: 1 }, { fogScale: 0.25 }, { bankSize: 0 }, { dofDistance: false }, { fsrPort: false }, { compositeOnce: false }, { bloomChains: 1 }, { fogScale: 1, bankSize: 0, dofDistance: false, fsrPort: false, compositeOnce: false, bloomChains: 1 } ];
		for ( const options of variants ) for ( const [ samples, discard ] of [ [ 4, undefined ], [ 1, undefined ], [ 4, [] ] ] ) {

			const what = `${ JSON.stringify( options ) } samples ${ samples }${ discard ? ' store-scene' : '' }`;
			const pipeline = compilePipeline( options, samples, discard ), today = compileToday( options, samples, discard );
			assert.equal( dump( pipeline ), dump( today ), what );
			assert.deepEqual( pipeline.culled, [], what );

		}

	} ],

	[ 'pipeline: the legacy ops discard the scene target\'s samples in the rain only (msaa 4, discardScene)', () => {

		const c = compilePipeline();
		const rows = ( t ) => t.passes.map( ( p ) => [ p.pass, p.colors.map( ( x ) => `${ x.resource }:${ x.load }/${ x.store }${ x.resolve === null ? '' : x.resolve ? '/resolve' : '/no-resolve' }` ), p.depth && `${ p.depth.resource }:${ p.depth.load }/${ p.depth.store }`, p.rewrite ] );
		const rainOn = c.ops( 'legacy', c.maskOf( [ 'rain', 'fogBank', 'fogDepth', 'fogMarch', 'viewDistance', 'diffusion', 'output' ] ) );
		assert.deepEqual( rows( rainOn ), [
			[ 'opaque', [ 'sceneColor:clear/store/resolve' ], 'sceneDepth:clear/store', false ],
			[ 'depthResolve', [ 'linearDepth:clear/store' ], null, false ],
			[ 'opaqueCopy', [ 'opaqueColor:clear/store' ], null, false ],
			[ 'water', [ 'sceneColor:load/store/resolve' ], 'sceneDepth:load/store', false ],
			[ 'surfaceResolve', [ 'surfaceDepth:clear/store' ], null, false ],
			[ 'rain', [ 'sceneColor:load/discard/resolve' ], 'sceneDepth:load/discard', true ],
			[ 'fogBank', [ 'fogBanks:clear/store' ], null, false ],
			[ 'fogDepth', [ 'fogNearestDepth:clear/store' ], null, false ],
			[ 'fogMarch', [ 'fogMarch:clear/store' ], null, false ],
			[ 'viewDistance', [ 'viewDistance:clear/store' ], null, false ],
			[ 'shaftsSource', [ 'shafts.source:clear/store' ], null, false ],
			[ 'shaftsRays', [ 'shafts.rays:clear/store' ], null, false ],
			[ 'composite', [ 'hdr:clear/store' ], null, false ],
			[ 'bloom', [ 'bloom:clear/store' ], null, false ],
			[ 'glow', [ 'glow:clear/store' ], null, false ],
			[ 'sharp', [ 'sharp:clear/store' ], null, false ],
			[ 'blur', [ 'blur:clear/store' ], null, false ],
			[ 'diffusion', [ 'diffusion:clear/store' ], null, false ],
			[ 'display', [ 'display:clear/store' ], null, false ],
			[ 'output', [ 'canvas:clear/store' ], null, false ],
		] );
		assert.equal( rainOn.rewrites, 1 );
		const upscaled = c.ops( 'legacy', c.maskOf( [ 'rain', 'easu', 'upscaledOutput' ] ) );
		assert.deepEqual( upscaled.running.slice( - 10 ), [ 'shaftsSource', 'shaftsRays', 'composite', 'bloom', 'glow', 'sharp', 'blur', 'display', 'easu', 'upscaledOutput' ] );
		assert.equal( upscaled.rewrites, 1, 'the upscale rewrites nothing' );
		assert.equal( c.ops( 'legacy', c.maskOf( [ 'output' ] ) ).rewrites, 0, 'without the rain nothing is discarded (the water\'s stores stay)' );
		const single = compilePipeline( {}, 1 );
		assert.equal( single.ops( 'legacy', single.fullMask ).rewrites, 0, 'msaa=1: no samples to discard' );
		const stored = compilePipeline( {}, 4, [] );
		assert.equal( stored.ops( 'legacy', stored.fullMask ).rewrites, 0, 'post=store-scene keeps the samples' );

	} ],

	[ 'today: the msaa4 graph matches its table (order, kinds, labels, whens, sizes, formats, samples)', () => {

		const c = compileToday();
		compareTable( c.summary(), TODAY );
		assert.deepEqual( c.passNames, ALL );
		assert.deepEqual( c.conditional.map( ( i ) => c.decl.passes[ i ].name ), [ 'rain', 'fogBank', 'fogDepth', 'fogMarch', 'viewDistance', 'diffusion', 'output', 'easu', 'upscaledOutput' ] );
		assert.deepEqual( c.summary().targets.map( ( t ) => [ t.key, t.size, t.samples ] ), [
			[ 'sceneColor|sceneDepth', R, 4 ], [ 'linearDepth|-', R, 1 ], [ 'opaqueColor|-', R, 1 ], [ 'surfaceDepth|-', R, 1 ],
			[ 'fogBanks|-', 'fixed:2048x2048', 1 ], [ 'fogNearestDepth|-', 'render:1:2:0', 1 ], [ 'fogMarch|-', 'render:1:2:0', 1 ],
			[ 'viewDistance|-', R, 1 ], [ 'shafts.source|-', H, 1 ], [ 'shafts.rays|-', H, 1 ], [ 'hdr|-', R, 1 ], [ 'bloom|-', H, 1 ], [ 'glow|-', H, 1 ], [ 'sharp|-', R, 1 ], [ 'blur|-', H, 1 ],
			[ 'diffusion|-', H, 1 ], [ 'display|-', R, 1 ], [ 'canvas|-', C, 1 ], [ 'FSR.easu|-', C, 1 ],
		] );
		assert.equal( c.jitterSpan, null );

	} ],

	[ 'today: msaa=1 keeps the graph with single-sampled scene targets', () => {

		const c = compileToday( {}, 1 );
		const one = TODAY.map( ( p ) => ( {
			...p,
			writes: p.writes.map( ( x ) => ( { ...x, samples: 1 } ) ),
			depth: p.depth && { ...p.depth, samples: 1 },
		} ) );
		compareTable( c.summary(), one );

	} ],

	[ 'sizes: the rounding of each class (rtt floor, fog max(floor(w/k),1), halfRes min 1, canvas >= render)', () => {

		const e = { render: { width: 1673, height: 941 }, canvas: { width: 2560, height: 1440 } };
		assert.deepEqual( resolveSize( { of: 'render' }, e ), { width: 1673, height: 941 } );
		assert.deepEqual( resolveSize( { of: 'render', scale: 0.5 }, e ), { width: 836, height: 470 } );
		assert.deepEqual( resolveSize( { of: 'render', divisor: 2 }, e ), { width: 836, height: 470 } );
		assert.deepEqual( resolveSize( { of: 'render', divisor: 4 }, { render: { width: 3, height: 2 }, canvas: { width: 3, height: 2 } } ), { width: 1, height: 1 } );
		assert.deepEqual( resolveSize( { of: 'render', scale: 0.5, min: 1 }, { render: { width: 1, height: 1 }, canvas: { width: 1, height: 1 } } ), { width: 1, height: 1 } );
		assert.deepEqual( resolveSize( { of: 'canvas' }, e ), { width: 2560, height: 1440 } );
		assert.deepEqual( resolveSize( { of: 'canvas' }, { render: { width: 3000, height: 900 }, canvas: { width: 2560, height: 1440 } } ), { width: 3000, height: 1440 } );
		assert.deepEqual( resolveSize( { of: 'fixed', width: 2048, height: 2048 }, e ), { width: 2048, height: 2048 } );

	} ],

	[ 'variants: post=legacy parts change the graph as Pipeline builds it', () => {

		const cases = [
			[ 'full-fog', { fogScale: 1 }, without( 'fogDepth', 'fogMarch' ) ],
			[ 'no-bank', { bankSize: 0 }, without( 'fogBank' ) ],
			[ 'inline-coc', { dofDistance: false }, without( 'viewDistance' ) ],
			[ 'three-fsr', { fsrPort: false }, [ ...without( 'easu', 'upscaledOutput' ), 'upscaledOutputThree' ] ],
			// (store-scene changes the ops only)
			[ 'inline-composite', { compositeOnce: false }, without( 'composite' ) ],
			[ 'one bloom chain (low)', { bloomChains: 1 }, without( 'glow' ) ],
			[ 'legacy (all)', { fogScale: 1, bankSize: 0, dofDistance: false, fsrPort: false, compositeOnce: false }, [ ...without( 'fogBank', 'fogDepth', 'fogMarch', 'viewDistance', 'composite', 'easu', 'upscaledOutput' ), 'upscaledOutputThree' ] ],
		];
		for ( const [ name, options, passes ] of cases ) {

			const c = compileToday( options );
			assert.deepEqual( c.passNames, passes, name );
			assert.deepEqual( c.culled, [], name );

		}

	} ],

	[ 'variants: rain off, fog off, dof 0 and upscaling select the passes that run', () => {

		const c = compileToday();
		const run = ( ...enabled ) => c.running( c.maskOf( enabled ) ).map( ( i ) => c.decl.passes[ i ].name );
		const base = [ 'opaque', 'depthResolve', 'opaqueCopy', 'water', 'surfaceResolve' ];
		assert.deepEqual( run( 'rain', 'fogBank', 'fogDepth', 'fogMarch', 'viewDistance', 'output' ), [ ...base, 'rain', 'fogBank', 'fogDepth', 'fogMarch', 'viewDistance', 'shaftsSource', 'shaftsRays', 'composite', 'bloom', 'glow', 'sharp', 'blur', 'display', 'output' ] );
		assert.deepEqual( run( 'fogDepth', 'fogMarch', 'viewDistance', 'output' ), [ ...base, 'fogDepth', 'fogMarch', 'viewDistance', 'shaftsSource', 'shaftsRays', 'composite', 'bloom', 'glow', 'sharp', 'blur', 'display', 'output' ], 'rain off' );
		assert.deepEqual( run( 'rain', 'viewDistance', 'output' ), [ ...base, 'rain', 'viewDistance', 'shaftsSource', 'shaftsRays', 'composite', 'bloom', 'glow', 'sharp', 'blur', 'display', 'output' ], 'fog off' );
		assert.deepEqual( run( 'rain', 'output' ), [ ...base, 'rain', 'shaftsSource', 'shaftsRays', 'composite', 'bloom', 'glow', 'sharp', 'blur', 'display', 'output' ], 'fog off, dof 0' );
		assert.deepEqual( run( 'viewDistance', 'easu', 'upscaledOutput' ), [ ...base, 'viewDistance', 'shaftsSource', 'shaftsRays', 'composite', 'bloom', 'glow', 'sharp', 'blur', 'display', 'easu', 'upscaledOutput' ], 'upscaling' );
		assert.deepEqual( run( 'rain', 'diffusion', 'output' ), [ ...base, 'rain', 'shaftsSource', 'shaftsRays', 'composite', 'bloom', 'glow', 'sharp', 'blur', 'diffusion', 'display', 'output' ], 'the look glow' );
		assert.equal( c.fullMask, 511 );

	} ],

	[ 'temporal mock: velocity MRT, overlay with an mrt, ping-pong history, frame-end copy', () => {

		const { g, c } = declareTemporal();
		const s = c.summary();
		assert.deepEqual( c.passNames, [ 'opaque', 'depthResolve', 'opaqueCopy', 'water', 'surfaceResolve', 'overlay', 'display', 'resolve', 'output' ] );
		assert.deepEqual( c.culled, [] );
		assert.deepEqual( s.targets.map( ( t ) => [ t.key, t.samples, t.pingPong ] ), [
			[ 'sceneColor+velocity|sceneDepth', 1, false ], [ 'linearDepth|-', 1, false ], [ 'opaqueColor|-', 1, false ],
			[ 'surfaceDepth|-', 1, false ], [ 'display|-', 1, false ], [ 'history|-', 1, true ], [ 'canvas|-', 1, false ],
		] );
		assert.deepEqual( s.copies, [ 'surfaceDepth->surfaceDepthPrev' ] );
		assert.deepEqual( s.jitterSpan, [ 'opaque', 'overlay' ] );
		const resolve = s.passes.find( ( p ) => p.name === 'resolve' );
		assert.ok( resolve.reads.includes( 'history@prev:sample' ) && resolve.reads.includes( 'surfaceDepthPrev@0:sample' ) );
		assert.ok( g.passes.find( ( p ) => p.name === 'overlay' ).hasMrt );

	} ],

	[ 'culling: unread passes go, the canvas, persistent resources, neverCull and the debug view stay', () => {

		const build = ( extra ) => {

			const g = new GraphDecl();
			const a = g.color( 'a', { size: RENDER } );
			const dead = g.color( 'dead', { size: RENDER } );
			const keep = g.color( 'keep', { size: RENDER }, true );
			let canvas = g.import( 'canvas', { size: CANVAS }, true );
			let ah;
			g.addPass( 'produce', 'quad', ( b ) => {

				ah = b.write( a );
				return { label: 'p' };

			} );
			let deadH;
			g.addPass( 'unread', 'quad', ( b ) => {

				b.read( ah );
				deadH = b.write( dead );
				return { label: 'u', neverCull: extra === 'neverCull' };

			} );
			g.addPass( 'persist', 'quad', ( b ) => {

				b.write( keep );
				return { label: 'k' };

			} );
			g.addPass( 'present', 'quad', ( b ) => {

				b.read( ah );
				canvas = b.write( canvas );
				return { label: 'o' };

			} );
			if ( extra === 'debug' ) g.setDebugView( deadH );
			return compileGraph( g, { sceneSamples: 4 } );

		};
		assert.deepEqual( build().culled, [ 'unread' ] );
		assert.deepEqual( build( 'neverCull' ).culled, [] );
		assert.deepEqual( build( 'debug' ).culled, [] );
		// the producer of a version read through a skippable pass stays live with the pass before it
		const g = new GraphDecl();
		let x = g.color( 'x', { size: RENDER } );
		let canvas = g.import( 'canvas', { size: CANVAS }, true );
		g.addPass( 'first', 'quad', ( b ) => {

			x = b.write( x );
			return { label: 'f' };

		} );
		g.addPass( 'maybe', 'scene', ( b ) => {

			x = b.write( x );
			return { label: 'm', when: () => true };

		} );
		g.addPass( 'present', 'quad', ( b ) => {

			b.readOptional( x );
			canvas = b.write( canvas );
			return { label: 'o' };

		} );
		assert.deepEqual( compileGraph( g, { sceneSamples: 1 } ).culled, [] );
		// a pass that clears (or overwrites full screen) needs nothing earlier: the writer before it
		// is culled; a blended full-screen pass loads, so its producer stays
		const over = ( kind, options ) => {

			const d = new GraphDecl();
			let y = d.color( 'y', { size: RENDER } );
			let out = d.import( 'canvas', { size: CANVAS }, true );
			d.addPass( 'A', 'scene', ( b ) => ( y = b.write( y, { clear: true } ), { label: 'a' } ) );
			d.addPass( 'B', kind, ( b ) => ( y = b.write( y, options ), { label: 'b' } ) );
			d.addPass( 'present', 'quad', ( b ) => ( b.read( y ), out = b.write( out ), { label: 'o' } ) );
			return compileGraph( d, { sceneSamples: 1 } ).culled;

		};
		assert.deepEqual( over( 'scene', { clear: true } ), [ 'A' ], 'a clearing overwrite' );
		assert.deepEqual( over( 'quad', {} ), [ 'A' ], 'a full-screen overwrite' );
		assert.deepEqual( over( 'quad', { blend: 'additive' } ), [], 'a blended full-screen pass' );
		assert.deepEqual( over( 'scene', {} ), [], 'a scene pass drawing over' );
		// a depth write that clears does not keep the earlier depth writer either
		const dd = new GraphDecl();
		let c1 = dd.color( 'c1', { size: RENDER } ), c2 = dd.color( 'c2', { size: RENDER } ), z = dd.depth( 'z', { size: RENDER } );
		let out2 = dd.import( 'canvas', { size: CANVAS }, true );
		dd.addPass( 'first', 'scene', ( b ) => ( c1 = b.write( c1, { clear: true } ), z = b.depth( z, { write: true, clear: true } ), { label: 'f' } ) );
		dd.addPass( 'second', 'scene', ( b ) => ( c2 = b.write( c2, { clear: true } ), z = b.depth( z, { write: true, clear: true } ), { label: 's' } ) );
		dd.addPass( 'present', 'quad', ( b ) => ( b.read( c2 ), b.read( z, 'samples' ), out2 = b.write( out2 ), { label: 'o' } ) );
		assert.deepEqual( compileGraph( dd, { sceneSamples: 1 } ).culled, [ 'first' ] );

	} ],

	[ 'hazards: every misdeclaration is refused with its reason', () => {

		const cases = [
			[ 'read before write', ( g, r ) => g.addPass( 'p', 'quad', ( b ) => ( b.read( r.a ), b.write( r.b ), { label: '' } ) ), /before any pass writes it/ ],
			[ 'read an overwritten version', ( g, r ) => {

				g.addPass( 'p1', 'quad', ( b ) => ( b.write( r.a ), { label: '' } ) );
				const a1 = { ...r.a, version: 1 };
				g.addPass( 'p2', 'scene', ( b ) => ( b.write( a1 ), { label: '' } ) );
				g.addPass( 'p3', 'quad', ( b ) => ( b.read( a1 ), b.write( r.b ), { label: '' } ) );

			}, /overwritten by v2/ ],
			[ 'write a stale version', ( g, r ) => {

				g.addPass( 'p1', 'quad', ( b ) => ( b.write( r.a ), { label: '' } ) );
				g.addPass( 'p2', 'quad', ( b ) => ( b.write( r.a ), { label: '' } ) );

			}, /stale version/ ],
			[ 'read and write one texture in a pass', ( g, r ) => {

				let a;
				g.addPass( 'p1', 'quad', ( b ) => ( a = b.write( r.a ), { label: '' } ) );
				g.addPass( 'p2', 'scene', ( b ) => ( b.read( a ), b.write( a ), { label: '' } ) );

			}, /reads and writes 'a'/ ],
			[ 'read and depth-test one texture in a pass', ( g, r ) => {

				let d;
				g.addPass( 'p1', 'scene', ( b ) => ( b.write( r.a ), d = b.depth( r.d, { write: true, clear: true } ), { label: '' } ) );
				g.addPass( 'p2', 'scene', ( b ) => ( b.read( d, 'samples' ), b.write( r.b ), b.depth( d, { write: false } ), { label: '' } ) );

			}, /reads and writes 'd'/ ],
			[ 'read a skippable producer without readOptional', ( g, r ) => {

				let a;
				g.addPass( 'p1', 'quad', ( b ) => ( a = b.write( r.a ), { label: '', when: () => true } ) );
				g.addPass( 'p2', 'quad', ( b ) => ( b.read( a ), b.write( r.b ), { label: '' } ) );

			}, /use readOptional/ ],
			[ 'several attachments without an mrt', ( g, r ) => g.addPass( 'p', 'scene', ( b ) => ( b.write( r.a ), b.write( r.b ), { label: '' } ) ), /without an mrt/ ],
			[ 'attachments of different size classes', ( g, r ) => g.addPass( 'p', 'scene', ( b ) => ( b.write( r.a ), b.write( r.half ), { label: '', mrt: {} } ) ), /different size classes/ ],
			[ 'attachments of different sample counts', ( g, r ) => g.addPass( 'p', 'scene', ( b ) => ( b.write( r.a ), b.depth( r.ms, { write: true, clear: true } ), { label: '' } ) ), /different sample counts/ ],
			[ 'a depth resource as colour', ( g, r ) => g.addPass( 'p', 'scene', ( b ) => ( b.write( r.d ), { label: '' } ) ), /use depth\(\)/ ],
			[ 'a compute pass with attachments', ( g, r ) => g.addPass( 'p', 'compute', ( b ) => ( b.write( r.a ), { label: '' } ) ), /compute pass has no attachments/ ],
			[ 'a previous version without previous()', ( g, r ) => g.addPass( 'p', 'quad', ( b ) => ( b.read( { ...r.a, version: - 1, previous: true } ), b.write( r.b ), { label: '' } ) ), /without previous/ ],
			[ 'a copy into a resource a pass writes', ( g, r ) => {

				let a;
				g.addPass( 'p1', 'quad', ( b ) => ( a = b.write( r.a ), { label: '' } ) );
				g.addPass( 'p2', 'quad', ( b ) => ( b.write( r.keep ), { label: '' } ) );
				g.copyToPersistent( a, r.keep );
				compileGraph( g, { sceneSamples: 1 } );

			}, /frame-end copy's target/ ],
			[ 'a copy into a transient resource', ( g, r ) => g.copyToPersistent( r.a, r.b ), /not a persistent resource/ ],
			[ 'jittered passes that are not contiguous', ( g, r ) => {

				let a, b2;
				g.addPass( 'p1', 'scene', ( b ) => ( a = b.write( r.a, { clear: true } ), { label: '', jittered: true } ) );
				g.addPass( 'p2', 'quad', ( b ) => ( b.read( a ), b2 = b.write( r.b ), { label: '' } ) );
				g.addPass( 'p3', 'scene', ( b ) => ( b.read( b2 ), b.write( a ), { label: '', jittered: true } ) );
				compileGraph( g, { sceneSamples: 1 } );

			}, /contiguous/ ],
			[ 'a depth-only pass', ( g, r ) => g.addPass( 'p', 'scene', ( b ) => ( b.depth( r.d, { write: true, clear: true } ), { label: '' } ) ), /depth-only passes are not supported/ ],
			[ 'an mrt pass that clears one attachment and loads another', ( g, r ) => {

				g.addPass( 'p1', 'quad', ( b ) => ( b.write( r.b ), { label: '' } ) );
				g.addPass( 'p2', 'scene', ( b ) => ( b.write( r.a, { clear: true } ), b.write( { ...r.b, version: 1 } ), { label: '', mrt: {} } ) );

			}, /clears some of its attachments and loads others/ ],
			[ 'an mrt quad that blends one attachment and overwrites another', ( g, r ) => {

				g.addPass( 'p1', 'quad', ( b ) => ( b.write( r.b ), { label: '' } ) );
				g.addPass( 'p2', 'quad', ( b ) => ( b.write( r.a ), b.write( { ...r.b, version: 1 }, { blend: 'additive' } ), { label: '', mrt: {} } ) );

			}, /clears some of its attachments and loads others/ ],
			[ 'ping-pong attachments of one target written apart', ( g, r ) => {

				const pa = g.previous( r.a ), pb = g.previous( r.b );
				let canvas = g.import( 'canvas', { size: CANVAS }, true );
				let a, b2;
				g.addPass( 'both', 'quad', ( b ) => ( b.read( pa ), b.read( pb ), a = b.write( r.a ), b2 = b.write( r.b ), { label: '', mrt: {} } ) );
				g.addPass( 'one', 'scene', ( b ) => ( b.write( b2 ), { label: '' } ) );
				g.addPass( 'present', 'quad', ( b ) => ( b.read( a ), canvas = b.write( canvas ), { label: '' } ) );
				compileGraph( g, { sceneSamples: 1 } );

			}, /writes some of the ping-pong attachments/ ],
			[ 'a resource declared twice', ( g ) => g.color( 'a', { size: RENDER } ), /declared twice/ ],
			[ 'a pass declared twice', ( g, r ) => {

				g.addPass( 'p', 'quad', ( b ) => ( b.write( r.a ), { label: '' } ) );
				g.addPass( 'p', 'quad', ( b ) => ( b.write( r.b ), { label: '' } ) );

			}, /declared twice/ ],
		];
		for ( const [ name, declare, reason ] of cases ) {

			const g = new GraphDecl();
			const r = {
				a: g.color( 'a', { size: RENDER } ), b: g.color( 'b', { size: RENDER } ), half: g.color( 'half', { size: { of: 'render', scale: 0.5 } } ),
				keep: g.color( 'keep', { size: RENDER }, true ), d: g.depth( 'd', { size: RENDER } ), ms: g.depth( 'ms', { size: RENDER, samples: 4 } ),
			};
			assert.throws( () => declare( g, r ), ( e ) => e instanceof GraphError && reason.test( e.message ), name );
			// a refused pass is not left declared, nor the versions its setup made: every version's
			// producer is a declared pass
			for ( const res of g.resources ) {

				assert.equal( res.producers.length, res.latest + 1, name );
				for ( const i of res.producers ) assert.ok( i < g.passes.length, `${ name }: '${ res.name }' produced by a refused pass` );

			}

		}

	} ],

	[ 'readOptional: required for skippable producers, accepted otherwise', () => {

		const g = new GraphDecl();
		let a = g.color( 'a', { size: RENDER } );
		let canvas = g.import( 'canvas', { size: CANVAS }, true );
		g.addPass( 'always', 'quad', ( b ) => ( a = b.write( a ), { label: '' } ) );
		g.addPass( 'reader', 'quad', ( b ) => ( b.readOptional( a ), canvas = b.write( canvas ), { label: '' } ) );
		const c = compileGraph( g, { sceneSamples: 1 } );
		assert.deepEqual( c.passNames, [ 'always', 'reader' ] );
		// today's graph declares readOptional exactly where a skippable pass produced the version
		const today = declareToday().g;
		for ( const p of today.passes ) for ( const r of p.reads ) {

			const producer = today.resources[ r.resource ].producers[ r.version ];
			const skippable = producer >= 0 && today.passes[ producer ].conditional;
			assert.equal( r.optional, skippable, `${ p.name } reads ${ today.resources[ r.resource ].name }` );

		}

	} ],

	[ 'determinism: the same declarations compile to the same tables', () => {

		const dump = ( c ) => JSON.stringify( {
			summary: c.summary(),
			ops: Array.from( { length: c.fullMask + 1 }, ( _, m ) => [ c.ops( 'legacy', m ), c.ops( 'derived', m ) ] ),
		} );
		const a = dump( compileToday() ), b = dump( compileToday() );
		assert.equal( a, b );
		const c = compileToday();
		assert.equal( JSON.stringify( c.ops( 'derived', 5 ) ), JSON.stringify( c.ops( 'derived', 5 ) ) );
		assert.equal( dump( declareTemporal().c ), dump( declareTemporal().c ) );

	} ],

];

/** A mock of the temporal graph (M6): single-sampled scene with a velocity MRT, an overlay pass
 * drawing over both with an mrt, the TAA history in two textures, surfaceDepthPrev by a copy. */
export function declareTemporal() {

	const g = new GraphDecl();
	let sceneColor = g.color( 'sceneColor', { size: RENDER, format: 'RGBA', type: 'HalfFloat' } );
	let velocity = g.color( 'velocity', { size: RENDER, format: 'RGBA', type: 'HalfFloat' } );
	let sceneDepth = g.depth( 'sceneDepth', { size: RENDER, type: 'Float' } );
	let linearDepth = g.color( 'linearDepth', { size: RENDER, format: 'RG', type: 'Float' } );
	let opaqueColor = g.color( 'opaqueColor', { size: RENDER, format: 'RGBA', type: 'HalfFloat' } );
	let surfaceDepth = g.color( 'surfaceDepth', { size: RENDER, format: 'Red', type: 'Float' } );
	const surfaceDepthPrev = g.color( 'surfaceDepthPrev', { size: RENDER, format: 'Red', type: 'Float' }, true );
	let display = g.color( 'display', { size: RENDER, format: 'RGBA', type: 'Float' } );
	let history = g.color( 'history', { size: CANVAS, format: 'RGBA', type: 'HalfFloat' } );
	const historyPrev = g.previous( history );
	let canvas = g.import( 'canvas', { size: CANVAS }, true );
	const sceneMRT = { id: 1 }, overlayMRT = { id: 2 };
	g.addPass( 'opaque', 'scene', ( b ) => {

		sceneColor = b.write( sceneColor, { clear: true } );
		velocity = b.write( velocity, { clear: true } );
		sceneDepth = b.depth( sceneDepth, { write: true, clear: true } );
		return { label: 'opaque scene', mrt: sceneMRT, jittered: true };

	} );
	g.addPass( 'depthResolve', 'quad', ( b ) => ( b.read( sceneDepth, 'samples' ), linearDepth = b.write( linearDepth ), { label: 'depth & copy resolves', jittered: true } ) );
	g.addPass( 'opaqueCopy', 'quad', ( b ) => ( b.read( sceneColor ), opaqueColor = b.write( opaqueColor ), { label: 'depth & copy resolves', jittered: true } ) );
	g.addPass( 'water', 'scene', ( b ) => {

		b.read( opaqueColor );
		b.read( linearDepth );
		sceneColor = b.write( sceneColor );
		velocity = b.write( velocity );
		sceneDepth = b.depth( sceneDepth, { write: true } );
		return { label: 'water', mrt: sceneMRT, jittered: true };

	} );
	g.addPass( 'surfaceResolve', 'quad', ( b ) => ( b.read( sceneDepth, 'samples' ), surfaceDepth = b.write( surfaceDepth ), { label: 'depth & copy resolves', jittered: true } ) );
	g.addPass( 'overlay', 'scene', ( b ) => {

		b.read( linearDepth );
		b.read( surfaceDepth );
		sceneColor = b.write( sceneColor, { blend: 'material' } );
		velocity = b.write( velocity, { blend: 'keep-max' } );
		b.depth( sceneDepth, { write: false } );
		return { label: 'overlay', mrt: overlayMRT, when: () => true, whenLabel: 'rain || spray', jittered: true };

	} );
	g.addPass( 'display', 'chain', ( b ) => ( b.readOptional( sceneColor ), b.read( surfaceDepth ), display = b.write( display ), { label: 'grade & look' } ) );
	g.addPass( 'resolve', 'quad', ( b ) => {

		b.read( display );
		b.readOptional( velocity );
		b.read( surfaceDepth );
		b.read( surfaceDepthPrev );
		b.read( historyPrev );
		history = b.write( history );
		return { label: 'TAA resolve' };

	} );
	g.addPass( 'output', 'chain', ( b ) => ( b.read( history ), canvas = b.write( canvas ), { label: 'output' } ) );
	g.copyToPersistent( surfaceDepth, surfaceDepthPrev );
	return { g, c: compileGraph( g, { sceneSamples: 1 } ) };

}
