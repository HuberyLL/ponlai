// The frame graph's passes: today's msaa4 graph with every draw a pass of its own, the graph
// Pipeline declares (src/post/Pipeline.ts, mirrored in its order of declaration: it compiles to
// today's graph), their load-time and runtime variants, a mock temporal graph, and the compiler's
// checks of order, culling, hazards, readOptional and determinism. Run by
// tools/verify-framegraph.mjs.

import assert from 'node:assert/strict';
import { GraphDecl, GraphError, compileGraph, resolveSize } from '../../src/post/graph/GraphCompiler.ts';

const RENDER = { of: 'render' };
const CANVAS = { of: 'canvas' };
// half the render, at least a texel: the light shafts
const HALF = { of: 'render', scale: 0.5, min: 1 };
// the water's refraction source (src/ocean/Refraction.ts REFRACTION_SIZE: half the render, times
// the guard band's 1.3; that module imports three, so the scale is restated here)
export const REFRACTION = { of: 'render', scale: 0.5 * 1.3, min: 1 };


// ---- tidewater's physical bloom (src/post/PhysicalBloom.ts): five downsamples from the bloom's
// input to 1/2 ... 1/32 of the render, then four upsamples, each adding the level above it, back
// to 1/2; the reader takes the last upsample

const LEVELS = 5;
const levelSize = ( i ) => ( { of: 'render', scale: 0.5 / 2 ** i, min: 1 } );
const levelKey = ( i ) => `render:${ 0.5 / 2 ** i }:0:1`;
const BLOOM_LABEL = 'bloom';

/** The bloom's targets, in PhysicalBloom's order of declaration. */
export function declareBloomTargets( g ) {

	const color = ( name, size ) => g.color( name, { size, format: 'RGBA', type: 'HalfFloat' } );
	const down = Array.from( { length: LEVELS }, ( _, i ) => color( `bloom.down${ i }`, levelSize( i ) ) );
	const up = Array.from( { length: LEVELS - 1 }, ( _, i ) => color( `bloom.up${ i }`, levelSize( i ) ) );
	return { down, up };

}

/** PhysicalBloom.passes: the first downsample's reads of the input declared by `reads`; returns
 * the result's version (the last upsample's). */
export function declareBloomPasses( g, t, reads ) {

	const down = [ ...t.down ], up = [ ...t.up ];
	for ( let i = 0; i < LEVELS; i ++ ) g.addPass( `bloomDown${ i }`, 'quad', ( b ) => {

		if ( i === 0 ) reads( b );
		else b.read( down[ i - 1 ] );
		down[ i ] = b.write( down[ i ] );
		return { label: BLOOM_LABEL };

	} );
	for ( let i = LEVELS - 2; i >= 0; i -- ) g.addPass( `bloomUp${ i }`, 'quad', ( b ) => {

		b.read( i === LEVELS - 2 ? down[ LEVELS - 1 ] : up[ i + 1 ] );
		b.read( down[ i ] );
		up[ i ] = b.write( up[ i ] );
		return { label: BLOOM_LABEL };

	} );
	return up[ 0 ];

}

/** The bloom's passes, in order. */
export const BLOOM_PASSES = [ ...Array.from( { length: LEVELS }, ( _, i ) => `bloomDown${ i }` ), ...Array.from( { length: LEVELS - 1 }, ( _, i ) => `bloomUp${ LEVELS - 2 - i }` ) ];

/** The bloom's rows of the expected table (`inputReads`: the first downsample's reads, as
 * `resource@version:mode`), what each pass reads, and the result as its reader reads it. */
export function bloomTable( inputReads ) {

	const rows = [], reads = {};
	const pass = ( name, i, target, read ) => {

		const size = levelKey( i );
		rows.push( { name, kind: 'quad', label: BLOOM_LABEL, when: null, size, writes: [ { name: target, size, format: 'RGBA', type: 'HalfFloat', samples: 1 } ], depth: null, target: `${ target }|-` } );
		reads[ name ] = read;

	};
	for ( let i = 0; i < LEVELS; i ++ ) pass( `bloomDown${ i }`, i, `bloom.down${ i }`, i === 0 ? inputReads : [ `bloom.down${ i - 1 }@1:sample` ] );
	for ( let i = LEVELS - 2; i >= 0; i -- ) pass( `bloomUp${ i }`, i, `bloom.up${ i }`, [ i === LEVELS - 2 ? `bloom.down${ LEVELS - 1 }@1:sample` : `bloom.up${ i + 1 }@1:sample`, `bloom.down${ i }@1:sample` ] );
	return { rows, reads, result: 'bloom.up0@1:sample' };

}

/** Today's msaa4 graph with a pass for every draw (Pipeline, the refraction, AerialPerspective and
 * LightShafts.passes, PhysicalBloom, FSR), as the expected table: the graph Pipeline declares
 * (declarePipeline below) compiles to it. For the `post=` switches of a variant: `fogScale` (1: the
 * full-resolution fog of full-fog), `bankSize` (0: no-bank), `fsrPort` (false: three-fsr),
 * `compositeOnce` (false: inline-composite), `meadowShade` (false: the meadow's shade off, as
 * MeadowShade.ts's MEADOW_SHADE is at msaa 1 or with `flags=meadowShade:false`); store-scene changes
 * the ops only (`legacyDiscard`). */
export function declareToday( options = {} ) {

	const o = { fogScale: 0.5, bankSize: 2048, fsrPort: true, compositeOnce: true, meadowShade: true, ...options };
	const g = new GraphDecl();
	const k = Math.round( 1 / o.fogScale );
	const h = {};
	h.sceneColor = g.color( 'sceneColor', { size: RENDER, format: 'RGBA', type: 'HalfFloat', samples: 'scene' } );
	h.sceneDepth = g.depth( 'sceneDepth', { size: RENDER, type: 'Float', samples: 'scene' } );
	h.refraction = g.color( 'refraction', { size: REFRACTION, format: 'RGBA', type: 'HalfFloat' } );
	h.refractionDepth = g.depth( 'refractionDepth', { size: REFRACTION, type: 'Float' } );
	h.linearDepth = g.color( 'linearDepth', { size: RENDER, format: 'RG', type: 'Float' } );
	h.opaqueColor = g.color( 'opaqueColor', { size: RENDER, format: 'RGBA', type: 'HalfFloat' } );
	h.surfaceDepth = g.color( 'surfaceDepth', { size: RENDER, format: 'Red', type: 'Float' } );
	h.underwater = g.color( 'underwater', { size: RENDER, format: 'RGBA', type: 'HalfFloat', mips: true } );
	h.refractionReach = g.color( 'refractionReach', { size: { of: 'fixed', width: 64, height: 1 }, format: 'RGBA', type: 'HalfFloat', filter: 'nearest' } );
	if ( o.bankSize > 0 ) h.fogBanks = g.color( 'fogBanks', { size: { of: 'fixed', width: o.bankSize, height: o.bankSize }, format: 'Red', type: 'HalfFloat' }, true );
	if ( o.fogScale < 1 ) {

		h.fogNearestDepth = g.color( 'fogNearestDepth', { size: { of: 'render', divisor: k }, format: 'Red', type: 'Float' } );
		h.fogMarch = g.color( 'fogMarch', { size: { of: 'render', divisor: k }, format: 'RGBA', type: 'HalfFloat' } );

	}
	h.shaftsSource = g.color( 'shafts.source', { size: HALF, format: 'RGBA', type: 'HalfFloat' } );
	h.shaftsRays = g.color( 'shafts.rays', { size: HALF, format: 'RGBA', type: 'HalfFloat' } );
	h.constants = g.color( 'postConstants', { size: { of: 'fixed', width: 1, height: 1 }, format: 'RGBA', type: 'Float' } );
	if ( o.compositeOnce ) h.hdr = g.color( 'hdr', { size: RENDER, format: 'RGBA', type: 'HalfFloat' } );
	h.bloom = declareBloomTargets( g );
	h.sharp = g.color( 'sharp', { size: RENDER, format: 'RGBA', type: 'HalfFloat' } );
	h.display = g.color( 'display', { size: RENDER, format: 'RGBA', type: 'Float' } );
	if ( o.fsrPort ) h.easu = g.color( 'FSR.easu', { size: CANVAS, format: 'RGBA', type: 'HalfFloat' } );
	h.canvas = g.import( 'canvas', { size: CANVAS }, true );
	// the meadow's shade: the coverage the vegetation's depth pass draws beside the scene's depth
	// (never read), the depth's nearest view z and the shade
	if ( o.meadowShade ) {

		h.meadowCoverage = g.color( 'meadowCoverage', { size: RENDER, format: 'RGBA', type: 'UnsignedByte', samples: 'scene' } );
		h.meadowDepth = g.color( 'meadowDepth', { size: RENDER, format: 'Red', type: 'Float' } );
		h.meadowShade = g.color( 'meadowShade', { size: RENDER, format: 'Red', type: 'UnsignedByte', filter: 'nearest' } );

	}

	// the vegetation's depth into the scene's depth, its nearest sample resolved, the shade marched
	// over it; the opaque pass then loads that depth instead of clearing it
	if ( h.meadowShade ) {

		g.addPass( 'meadowDepth', 'scene', ( b ) => {

			h.meadowCoverage = b.write( h.meadowCoverage, { clear: true } );
			h.sceneDepth = b.depth( h.sceneDepth, { write: true, clear: true } );
			return { label: 'vegetation depth' };

		} );
		g.addPass( 'meadowDepthResolve', 'quad', ( b ) => {

			b.read( h.sceneDepth, 'samples' );
			h.meadowDepth = b.write( h.meadowDepth );
			return { label: 'meadow shade' };

		} );
		g.addPass( 'meadowShade', 'quad', ( b ) => {

			b.read( h.meadowDepth );
			h.meadowShade = b.write( h.meadowShade );
			return { label: 'meadow shade' };

		} );

	}
	g.addPass( 'opaque', 'scene', ( b ) => {

		if ( h.meadowShade ) b.read( h.meadowShade );
		h.sceneColor = b.write( h.sceneColor, { clear: true } );
		h.sceneDepth = b.depth( h.sceneDepth, { write: true, clear: ! h.meadowShade } );
		return { label: 'opaque scene' };

	} );
	// the world under the sea through the refraction's wider view (its own single-sampled target)
	g.addPass( 'underwaterPyramid', 'quad', ( b ) => ( b.read( h.sceneColor ), b.read( h.sceneDepth, 'samples' ), h.underwater = b.write( h.underwater ), { label: 'underwater pyramid' } ) );
	// the lookups' reach past the screen, the mask at the nearest depth where the opaque image holds
	// the floor or beyond that reach, then the refraction over it
	g.addPass( 'refractionReach', 'quad', ( b ) => ( b.read( h.sceneDepth, 'samples' ), b.read( h.underwater ), h.refractionReach = b.write( h.refractionReach ), { label: 'refraction', when: () => true, whenLabel: 'refraction' } ) );
	g.addPass( 'refractionMask', 'quad', ( b ) => {

		b.read( h.underwater );
		b.readOptional( h.refractionReach );
		h.refraction = b.write( h.refraction, { clear: true } );
		h.refractionDepth = b.depth( h.refractionDepth, { write: true, clear: true } );
		return { label: 'refraction', mrt: {}, when: () => true, whenLabel: 'refraction' };

	} );
	g.addPass( 'refraction', 'scene', ( b ) => {

		h.refraction = b.write( h.refraction );
		h.refractionDepth = b.depth( h.refractionDepth, { write: true } );
		return { label: 'refraction', mrt: {}, when: () => true, whenLabel: 'refraction' };

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
		b.read( h.underwater );
		b.readOptional( h.refraction );
		b.readOptional( h.refractionDepth );
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
	// the light shafts: the open sky near the sun, the rays marched over it (while the sun faces
	// the view)
	g.addPass( 'shaftsSource', 'quad', ( b ) => {

		b.read( h.surfaceDepth );
		h.shaftsSource = b.write( h.shaftsSource );
		return { label: 'light shafts', when: () => true, whenLabel: 'facing > 0' };

	} );
	g.addPass( 'shaftsRays', 'quad', ( b ) => {

		b.readOptional( h.shaftsSource );
		h.shaftsRays = b.write( h.shaftsRays );
		return { label: 'light shafts', when: () => true, whenLabel: 'facing > 0' };

	} );
	// the composite's per-frame constants, into a texel
	g.addPass( 'postConstants', 'quad', ( b ) => {

		b.readOptional( h.shaftsSource );
		h.constants = b.write( h.constants );
		return { label: 'composite (air, fog, veil)' };

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
		b.readOptional( h.shaftsSource );
		b.readOptional( h.shaftsRays );
		b.read( h.constants );

	};
	// the composite of air, fog, veil and shafts, rendered once into hdr
	if ( h.hdr ) g.addPass( 'composite', 'quad', ( b ) => {

		compositeReads( b );
		h.hdr = b.write( h.hdr );
		return { label: 'composite (air, fog, veil)' };

	} );
	// the bloom, from hdr (from the scene's colour without the composite pass)
	h.bloom = declareBloomPasses( g, h.bloom, ( b ) => {

		if ( h.hdr ) b.read( h.hdr );
		else b.readOptional( h.sceneColor );

	} );
	// the sharp image: the composite (inline without its pass) and the bloom
	g.addPass( 'sharp', 'quad', ( b ) => {

		if ( h.hdr ) b.read( h.hdr );
		else compositeReads( b );
		b.read( h.bloom );
		h.sharp = b.write( h.sharp );
		return { label: h.hdr ? 'sharp (composite + blooms)' : 'composite (air, fog, veil)' };

	} );
	// the grade
	g.addPass( 'display', 'quad', ( b ) => {

		b.read( h.sharp );
		h.display = b.write( h.display );
		return { label: 'grade' };

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

// (the meadow's shade only at 4x, as MEADOW_SHADE)
export const compileToday = ( options = {}, samples = 4, legacyDiscard ) =>
	compileGraph( declareToday( { meadowShade: samples === 4, ...options } ).g, { sceneSamples: samples, ...( legacyDiscard ? { legacyDiscard } : {} ) } );

/** The graph Pipeline declares (Pipeline's constructor, declarePasses and declareRefraction,
 * AerialPerspective.apply and passes, LightShafts.build and passes, PhysicalBloom), in its order of
 * declaration, for the post options of a variant as in declareToday: every draw of the frame is a
 * pass of its own. Compiled, it is today's graph (declareToday). */
export function declarePipeline( options = {} ) {

	const o = { fogScale: 0.5, bankSize: 2048, fsrPort: true, compositeOnce: true, meadowShade: true, ...options };
	const g = new GraphDecl();
	const k = Math.round( 1 / o.fogScale );
	const h = {};
	// Pipeline's constructor
	h.sceneColor = g.color( 'sceneColor', { size: RENDER, format: 'RGBA', type: 'HalfFloat', samples: 'scene' } );
	h.sceneDepth = g.depth( 'sceneDepth', { size: RENDER, type: 'Float', samples: 'scene' } );
	h.linearDepth = g.color( 'linearDepth', { size: RENDER, format: 'RG', type: 'Float' } );
	h.opaqueColor = g.color( 'opaqueColor', { size: RENDER, format: 'RGBA', type: 'HalfFloat' } );
	h.surfaceDepth = g.color( 'surfaceDepth', { size: RENDER, format: 'Red', type: 'Float' } );
	h.underwater = g.color( 'underwater', { size: RENDER, format: 'RGBA', type: 'HalfFloat', mips: true } );
	h.refractionReach = g.color( 'refractionReach', { size: { of: 'fixed', width: 64, height: 1 }, format: 'RGBA', type: 'HalfFloat', filter: 'nearest' } );
	h.refraction = g.color( 'refraction', { size: REFRACTION, format: 'RGBA', type: 'HalfFloat' } );
	h.refractionDepth = g.depth( 'refractionDepth', { size: REFRACTION, type: 'Float' } );
	if ( o.compositeOnce ) h.hdr = g.color( 'hdr', { size: RENDER, format: 'RGBA', type: 'HalfFloat' } );
	h.sharp = g.color( 'sharp', { size: RENDER, format: 'RGBA', type: 'HalfFloat' } );
	h.display = g.color( 'display', { size: RENDER, format: 'RGBA', type: 'Float' } );
	if ( o.fsrPort ) h.easu = g.color( 'FSR.easu', { size: CANVAS, format: 'RGBA', type: 'HalfFloat' } );
	h.canvas = g.import( 'canvas', { size: CANVAS }, true );
	// (the meadow's shade, after the canvas)
	if ( o.meadowShade ) {

		h.meadowCoverage = g.color( 'meadowCoverage', { size: RENDER, format: 'RGBA', type: 'UnsignedByte', samples: 'scene' } );
		h.meadowDepth = g.color( 'meadowDepth', { size: RENDER, format: 'Red', type: 'Float' } );
		h.meadowShade = g.color( 'meadowShade', { size: RENDER, format: 'Red', type: 'UnsignedByte', filter: 'nearest' } );

	}
	h.constants = g.color( 'postConstants', { size: { of: 'fixed', width: 1, height: 1 }, format: 'RGBA', type: 'Float' } );
	// AerialPerspective.apply
	if ( o.bankSize > 0 ) h.fogBanks = g.color( 'fogBanks', { size: { of: 'fixed', width: o.bankSize, height: o.bankSize }, format: 'Red', type: 'HalfFloat' }, true );
	if ( o.fogScale < 1 ) {

		h.fogNearestDepth = g.color( 'fogNearestDepth', { size: { of: 'render', divisor: k }, format: 'Red', type: 'Float' } );
		h.fogMarch = g.color( 'fogMarch', { size: { of: 'render', divisor: k }, format: 'RGBA', type: 'HalfFloat' } );

	}
	// LightShafts.build
	h.shaftsSource = g.color( 'shafts.source', { size: HALF, format: 'RGBA', type: 'HalfFloat' } );
	h.shaftsRays = g.color( 'shafts.rays', { size: HALF, format: 'RGBA', type: 'HalfFloat' } );
	// Pipeline's constructor, after the composite: PhysicalBloom
	h.bloom = declareBloomTargets( g );

	// declarePasses: the scene half (the meadow's shade before the opaque scene, declareRefraction
	// after it)
	if ( h.meadowShade ) {

		g.addPass( 'meadowDepth', 'scene', ( b ) => {

			h.meadowCoverage = b.write( h.meadowCoverage, { clear: true } );
			h.sceneDepth = b.depth( h.sceneDepth, { write: true, clear: true } );
			return { label: 'vegetation depth' };

		} );
		g.addPass( 'meadowDepthResolve', 'quad', ( b ) => ( b.read( h.sceneDepth, 'samples' ), h.meadowDepth = b.write( h.meadowDepth ), { label: 'meadow shade' } ) );
		g.addPass( 'meadowShade', 'quad', ( b ) => ( b.read( h.meadowDepth ), h.meadowShade = b.write( h.meadowShade ), { label: 'meadow shade' } ) );

	}
	g.addPass( 'opaque', 'scene', ( b ) => {

		if ( h.meadowShade ) b.read( h.meadowShade );
		h.sceneColor = b.write( h.sceneColor, { clear: true } );
		h.sceneDepth = b.depth( h.sceneDepth, { write: true, clear: ! h.meadowShade } );
		return { label: 'opaque scene' };

	} );
	g.addPass( 'underwaterPyramid', 'quad', ( b ) => ( b.read( h.sceneColor ), b.read( h.sceneDepth, 'samples' ), h.underwater = b.write( h.underwater ), { label: 'underwater pyramid' } ) );
	// the lookups' reach past the screen, the mask at the nearest depth where the opaque image holds
	// the floor or beyond that reach, then the refraction over it
	g.addPass( 'refractionReach', 'quad', ( b ) => ( b.read( h.sceneDepth, 'samples' ), b.read( h.underwater ), h.refractionReach = b.write( h.refractionReach ), { label: 'refraction', when: () => true, whenLabel: 'refraction' } ) );
	g.addPass( 'refractionMask', 'quad', ( b ) => {

		b.read( h.underwater );
		b.readOptional( h.refractionReach );
		h.refraction = b.write( h.refraction, { clear: true } );
		h.refractionDepth = b.depth( h.refractionDepth, { write: true, clear: true } );
		return { label: 'refraction', mrt: {}, when: () => true, whenLabel: 'refraction' };

	} );
	g.addPass( 'refraction', 'scene', ( b ) => {

		h.refraction = b.write( h.refraction );
		h.refractionDepth = b.depth( h.refractionDepth, { write: true } );
		return { label: 'refraction', mrt: {}, when: () => true, whenLabel: 'refraction' };

	} );
	g.addPass( 'depthResolve', 'quad', ( b ) => ( b.read( h.sceneDepth, 'samples' ), h.linearDepth = b.write( h.linearDepth ), { label: 'depth & copy resolves' } ) );
	g.addPass( 'opaqueCopy', 'quad', ( b ) => ( b.read( h.sceneColor ), h.opaqueColor = b.write( h.opaqueColor ), { label: 'depth & copy resolves' } ) );
	g.addPass( 'water', 'scene', ( b ) => {

		b.read( h.opaqueColor );
		b.read( h.linearDepth );
		b.read( h.underwater );
		b.readOptional( h.refraction );
		b.readOptional( h.refractionDepth );
		h.sceneColor = b.write( h.sceneColor );
		h.sceneDepth = b.depth( h.sceneDepth, { write: true } );
		return { label: 'water' };

	} );
	g.addPass( 'surfaceResolve', 'quad', ( b ) => ( b.read( h.sceneDepth, 'samples' ), h.surfaceDepth = b.write( h.surfaceDepth ), { label: 'depth & copy resolves' } ) );
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
	// declarePasses: the post passes (LightShafts.passes first)
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
	const bloom = declareBloomPasses( g, h.bloom, ( b ) => {

		if ( h.hdr ) b.read( h.hdr );
		else b.readOptional( h.sceneColor );

	} );
	g.addPass( 'sharp', 'quad', ( b ) => {

		if ( h.hdr ) b.read( h.hdr );
		else compositeReads( b );
		b.read( bloom );
		h.sharp = b.write( h.sharp );
		return { label: h.hdr ? 'sharp (composite + blooms)' : FOG };

	} );
	g.addPass( 'display', 'quad', ( b ) => ( b.read( h.sharp ), h.display = b.write( h.display ), { label: 'grade' } ) );
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
	compileGraph( declarePipeline( { meadowShade: samples === 4, ...options } ).g, { sceneSamples: samples, ...( legacyDiscard ? { legacyDiscard } : {} ) } );

// ---- the expected table of today's msaa4 graph

const R = 'render:1:0:0', C = 'canvas:1', H = 'render:0.5:0:1', RF = 'render:0.65:0:1';
const w = ( name, size, format, type, samples = 1 ) => ( { name, size, format, type, samples } );
const BLOOM = bloomTable( [ 'hdr@1:sample' ] );
export const TODAY = [
	// the meadow's shade: the vegetation's depth into the scene's depth, beside a coverage it never
	// reads, then the depth's nearest view z and the shade over it
	{ name: 'meadowDepth', kind: 'scene', label: 'vegetation depth', when: null, size: R, writes: [ w( 'meadowCoverage', R, 'RGBA', 'UnsignedByte', 4 ) ], depth: { ...w( 'sceneDepth', R, null, 'Float', 4 ), write: true }, target: 'meadowCoverage|sceneDepth' },
	{ name: 'meadowDepthResolve', kind: 'quad', label: 'meadow shade', when: null, size: R, writes: [ w( 'meadowDepth', R, 'Red', 'Float' ) ], depth: null, target: 'meadowDepth|-' },
	{ name: 'meadowShade', kind: 'quad', label: 'meadow shade', when: null, size: R, writes: [ w( 'meadowShade', R, 'Red', 'UnsignedByte' ) ], depth: null, target: 'meadowShade|-' },
	{ name: 'opaque', kind: 'scene', label: 'opaque scene', when: null, size: R, writes: [ w( 'sceneColor', R, 'RGBA', 'HalfFloat', 4 ) ], depth: { ...w( 'sceneDepth', R, null, 'Float', 4 ), write: true }, target: 'sceneColor|sceneDepth' },
	{ name: 'underwaterPyramid', kind: 'quad', label: 'underwater pyramid', when: null, size: R, writes: [ w( 'underwater', R, 'RGBA', 'HalfFloat' ) ], depth: null, target: 'underwater|-' },
	{ name: 'refractionReach', kind: 'quad', label: 'refraction', when: 'refraction', size: 'fixed:64x1', writes: [ w( 'refractionReach', 'fixed:64x1', 'RGBA', 'HalfFloat' ) ], depth: null, target: 'refractionReach|-' },
	{ name: 'refractionMask', kind: 'quad', label: 'refraction', when: 'refraction', size: RF, writes: [ w( 'refraction', RF, 'RGBA', 'HalfFloat' ) ], depth: { ...w( 'refractionDepth', RF, null, 'Float' ), write: true }, target: 'refraction|refractionDepth' },
	{ name: 'refraction', kind: 'scene', label: 'refraction', when: 'refraction', size: RF, writes: [ w( 'refraction', RF, 'RGBA', 'HalfFloat' ) ], depth: { ...w( 'refractionDepth', RF, null, 'Float' ), write: true }, target: 'refraction|refractionDepth' },
	{ name: 'depthResolve', kind: 'quad', label: 'depth & copy resolves', when: null, size: R, writes: [ w( 'linearDepth', R, 'RG', 'Float' ) ], depth: null, target: 'linearDepth|-' },
	{ name: 'opaqueCopy', kind: 'quad', label: 'depth & copy resolves', when: null, size: R, writes: [ w( 'opaqueColor', R, 'RGBA', 'HalfFloat' ) ], depth: null, target: 'opaqueColor|-' },
	{ name: 'water', kind: 'scene', label: 'water', when: null, size: R, writes: [ w( 'sceneColor', R, 'RGBA', 'HalfFloat', 4 ) ], depth: { ...w( 'sceneDepth', R, null, 'Float', 4 ), write: true }, target: 'sceneColor|sceneDepth' },
	{ name: 'surfaceResolve', kind: 'quad', label: 'depth & copy resolves', when: null, size: R, writes: [ w( 'surfaceDepth', R, 'Red', 'Float' ) ], depth: null, target: 'surfaceDepth|-' },
	{ name: 'rain', kind: 'scene', label: 'rain draw', when: 'rainVisible', size: R, writes: [ w( 'sceneColor', R, 'RGBA', 'HalfFloat', 4 ) ], depth: { ...w( 'sceneDepth', R, null, 'Float', 4 ), write: false }, target: 'sceneColor|sceneDepth' },
	{ name: 'fogBank', kind: 'quad', label: 'composite (air, fog, veil)', when: 'fog && bankDue', size: 'fixed:2048x2048', writes: [ w( 'fogBanks', 'fixed:2048x2048', 'Red', 'HalfFloat' ) ], depth: null, target: 'fogBanks|-' },
	{ name: 'fogDepth', kind: 'quad', label: 'composite (air, fog, veil)', when: 'fog', size: 'render:1:2:0', writes: [ w( 'fogNearestDepth', 'render:1:2:0', 'Red', 'Float' ) ], depth: null, target: 'fogNearestDepth|-' },
	{ name: 'fogMarch', kind: 'quad', label: 'composite (air, fog, veil)', when: 'fog', size: 'render:1:2:0', writes: [ w( 'fogMarch', 'render:1:2:0', 'RGBA', 'HalfFloat' ) ], depth: null, target: 'fogMarch|-' },
	{ name: 'shaftsSource', kind: 'quad', label: 'light shafts', when: 'facing > 0', size: H, writes: [ w( 'shafts.source', H, 'RGBA', 'HalfFloat' ) ], depth: null, target: 'shafts.source|-' },
	{ name: 'shaftsRays', kind: 'quad', label: 'light shafts', when: 'facing > 0', size: H, writes: [ w( 'shafts.rays', H, 'RGBA', 'HalfFloat' ) ], depth: null, target: 'shafts.rays|-' },
	{ name: 'postConstants', kind: 'quad', label: 'composite (air, fog, veil)', when: null, size: 'fixed:1x1', writes: [ w( 'postConstants', 'fixed:1x1', 'RGBA', 'Float' ) ], depth: null, target: 'postConstants|-' },
	{ name: 'composite', kind: 'quad', label: 'composite (air, fog, veil)', when: null, size: R, writes: [ w( 'hdr', R, 'RGBA', 'HalfFloat' ) ], depth: null, target: 'hdr|-' },
	...BLOOM.rows,
	{ name: 'sharp', kind: 'quad', label: 'sharp (composite + blooms)', when: null, size: R, writes: [ w( 'sharp', R, 'RGBA', 'HalfFloat' ) ], depth: null, target: 'sharp|-' },
	{ name: 'display', kind: 'quad', label: 'grade', when: null, size: R, writes: [ w( 'display', R, 'RGBA', 'Float' ) ], depth: null, target: 'display|-' },
	{ name: 'output', kind: 'chain', label: 'output', when: '!upscaling', size: C, writes: [ w( 'canvas', C, null, null ) ], depth: null, target: 'canvas|-' },
	{ name: 'easu', kind: 'quad', label: 'output & FSR', when: 'upscaling', size: C, writes: [ w( 'FSR.easu', C, 'RGBA', 'HalfFloat' ) ], depth: null, target: 'FSR.easu|-' },
	{ name: 'upscaledOutput', kind: 'chain', label: 'output & FSR', when: 'upscaling', size: C, writes: [ w( 'canvas', C, null, null ) ], depth: null, target: 'canvas|-' },
];

// what each pass of today's graph reads (`resource@version:mode`, `?` optional; the scene's depth
// is the vegetation depth pass's at v1, the opaque scene's at v2, the water's at v3)
export const TODAY_READS = {
	meadowDepth: [], meadowDepthResolve: [ 'sceneDepth@1:samples' ], meadowShade: [ 'meadowDepth@1:sample' ],
	opaque: [ 'meadowShade@1:sample' ], underwaterPyramid: [ 'sceneColor@1:sample', 'sceneDepth@2:samples' ], refractionReach: [ 'sceneDepth@2:samples', 'underwater@1:sample' ], refractionMask: [ 'underwater@1:sample', 'refractionReach@1:sample?' ], refraction: [],
	depthResolve: [ 'sceneDepth@2:samples' ], opaqueCopy: [ 'sceneColor@1:sample' ],
	water: [ 'opaqueColor@1:sample', 'linearDepth@1:sample', 'underwater@1:sample', 'refraction@2:sample?', 'refractionDepth@2:sample?' ], surfaceResolve: [ 'sceneDepth@3:samples' ],
	rain: [ 'linearDepth@1:sample', 'surfaceDepth@1:sample' ], fogBank: [], fogDepth: [ 'surfaceDepth@1:sample' ],
	fogMarch: [ 'fogNearestDepth@1:sample?', 'fogBanks@1:sample?' ],
	shaftsSource: [ 'surfaceDepth@1:sample' ], shaftsRays: [ 'shafts.source@1:sample?' ], postConstants: [ 'shafts.source@1:sample?' ],
	composite: [ 'sceneColor@3:sample?', 'surfaceDepth@1:sample', 'fogMarch@1:sample?', 'fogNearestDepth@1:sample?', 'fogBanks@1:sample?', 'shafts.source@1:sample?', 'shafts.rays@1:sample?', 'postConstants@1:sample' ],
	...BLOOM.reads,
	sharp: [ 'hdr@1:sample', BLOOM.result ], display: [ 'sharp@1:sample' ],
	output: [ 'display@1:sample' ], easu: [ 'display@1:sample' ], upscaledOutput: [ 'FSR.easu@1:sample?' ],
};

const ALL = TODAY.map( ( p ) => p.name );
// the meadow's shade, at 4x only (MEADOW_SHADE)
const MEADOW = [ 'meadowDepth', 'meadowDepthResolve', 'meadowShade' ];
const without = ( ...names ) => ALL.filter( ( n ) => ! names.includes( n ) );
// the passes the bloom and the sharp image run after, a frame's tail
const TAIL = [ 'postConstants', 'composite', ...BLOOM_PASSES, 'sharp', 'display' ];

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
		const variants = [ {}, { fogScale: 1 }, { fogScale: 0.25 }, { bankSize: 0 }, { fsrPort: false }, { compositeOnce: false }, { meadowShade: false }, { fogScale: 1, bankSize: 0, fsrPort: false, compositeOnce: false } ];
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
		const rainOn = c.ops( 'legacy', c.maskOf( [ 'refractionReach', 'refractionMask', 'refraction', 'rain', 'fogBank', 'fogDepth', 'fogMarch', 'shaftsSource', 'shaftsRays', 'output' ] ) );
		assert.deepEqual( rows( rainOn ), [
			[ 'meadowDepth', [ 'meadowCoverage:clear/store/resolve' ], 'sceneDepth:clear/store', false ],
			[ 'meadowDepthResolve', [ 'meadowDepth:clear/store' ], null, false ],
			[ 'meadowShade', [ 'meadowShade:clear/store' ], null, false ],
			// (over the vegetation's depth)
			[ 'opaque', [ 'sceneColor:clear/store/resolve' ], 'sceneDepth:load/store', false ],
			[ 'underwaterPyramid', [ 'underwater:clear/store' ], null, false ],
			[ 'refractionReach', [ 'refractionReach:clear/store' ], null, false ],
			[ 'refractionMask', [ 'refraction:clear/store' ], 'refractionDepth:clear/store', false ],
			[ 'refraction', [ 'refraction:load/store' ], 'refractionDepth:load/store', false ],
			[ 'depthResolve', [ 'linearDepth:clear/store' ], null, false ],
			[ 'opaqueCopy', [ 'opaqueColor:clear/store' ], null, false ],
			[ 'water', [ 'sceneColor:load/store/resolve' ], 'sceneDepth:load/store', false ],
			[ 'surfaceResolve', [ 'surfaceDepth:clear/store' ], null, false ],
			[ 'rain', [ 'sceneColor:load/discard/resolve' ], 'sceneDepth:load/discard', true ],
			[ 'fogBank', [ 'fogBanks:clear/store' ], null, false ],
			[ 'fogDepth', [ 'fogNearestDepth:clear/store' ], null, false ],
			[ 'fogMarch', [ 'fogMarch:clear/store' ], null, false ],
			[ 'shaftsSource', [ 'shafts.source:clear/store' ], null, false ],
			[ 'shaftsRays', [ 'shafts.rays:clear/store' ], null, false ],
			[ 'postConstants', [ 'postConstants:clear/store' ], null, false ],
			[ 'composite', [ 'hdr:clear/store' ], null, false ],
			...BLOOM.rows.map( ( r ) => [ r.name, r.writes.map( ( x ) => `${ x.name }:clear/store` ), null, false ] ),
			[ 'sharp', [ 'sharp:clear/store' ], null, false ],
			[ 'display', [ 'display:clear/store' ], null, false ],
			[ 'output', [ 'canvas:clear/store' ], null, false ],
		] );
		assert.equal( rainOn.rewrites, 1 );
		const upscaled = c.ops( 'legacy', c.maskOf( [ 'rain', 'shaftsSource', 'shaftsRays', 'easu', 'upscaledOutput' ] ) );
		assert.deepEqual( upscaled.running.slice( - 5 - TAIL.length ), [ 'rain', 'shaftsSource', 'shaftsRays', ...TAIL, 'easu', 'upscaledOutput' ] );
		assert.equal( upscaled.rewrites, 1, 'the upscale rewrites nothing' );
		assert.equal( c.ops( 'legacy', c.maskOf( [ 'refraction', 'output' ] ) ).rewrites, 0, 'without the rain nothing is discarded (the water\'s stores stay)' );
		const single = compilePipeline( {}, 1 );
		assert.equal( single.ops( 'legacy', single.fullMask ).rewrites, 0, 'msaa=1: no samples to discard' );
		const stored = compilePipeline( {}, 4, [] );
		assert.equal( stored.ops( 'legacy', stored.fullMask ).rewrites, 0, 'post=store-scene keeps the samples' );

	} ],

	[ 'today: the msaa4 graph matches its table (order, kinds, labels, whens, sizes, formats, samples)', () => {

		const c = compileToday();
		compareTable( c.summary(), TODAY );
		assert.deepEqual( c.passNames, ALL );
		assert.deepEqual( c.conditional.map( ( i ) => c.decl.passes[ i ].name ), [ 'refractionReach', 'refractionMask', 'refraction', 'rain', 'fogBank', 'fogDepth', 'fogMarch', 'shaftsSource', 'shaftsRays', 'output', 'easu', 'upscaledOutput' ] );
		assert.deepEqual( c.summary().targets.map( ( t ) => [ t.key, t.size, t.samples ] ), [
			[ 'meadowCoverage|sceneDepth', R, 4 ], [ 'meadowDepth|-', R, 1 ], [ 'meadowShade|-', R, 1 ], [ 'sceneColor|sceneDepth', R, 4 ], [ 'underwater|-', R, 1 ], [ 'refractionReach|-', 'fixed:64x1', 1 ], [ 'refraction|refractionDepth', RF, 1 ], [ 'linearDepth|-', R, 1 ], [ 'opaqueColor|-', R, 1 ], [ 'surfaceDepth|-', R, 1 ],
			[ 'fogBanks|-', 'fixed:2048x2048', 1 ], [ 'fogNearestDepth|-', 'render:1:2:0', 1 ], [ 'fogMarch|-', 'render:1:2:0', 1 ],
			[ 'shafts.source|-', H, 1 ], [ 'shafts.rays|-', H, 1 ], [ 'postConstants|-', 'fixed:1x1', 1 ], [ 'hdr|-', R, 1 ], ...BLOOM.rows.map( ( r ) => [ r.target, r.size, 1 ] ), [ 'sharp|-', R, 1 ],
			[ 'display|-', R, 1 ], [ 'canvas|-', C, 1 ], [ 'FSR.easu|-', C, 1 ],
		] );
		// the refraction's view is wider than the screen: 1.3 times both ways at half the render
		assert.deepEqual( resolveSize( REFRACTION, { render: { width: 2560, height: 1440 }, canvas: { width: 3840, height: 2160 } } ), { width: 1664, height: 936 } );
		assert.equal( c.jitterSpan, null );

	} ],

	[ 'today: msaa=1 keeps the graph with single-sampled scene targets, without the meadow\'s shade', () => {

		const c = compileToday( {}, 1 );
		const one = TODAY.filter( ( p ) => ! MEADOW.includes( p.name ) ).map( ( p ) => ( {
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


	[ 'variants: the post= switches change the graph as Pipeline builds it', () => {

		const cases = [
			[ 'full-fog', { fogScale: 1 }, without( 'fogDepth', 'fogMarch' ) ],
			[ 'no-bank', { bankSize: 0 }, without( 'fogBank' ) ],
			[ 'three-fsr', { fsrPort: false }, [ ...without( 'easu', 'upscaledOutput' ), 'upscaledOutputThree' ] ],
			// (store-scene changes the ops only)
			[ 'inline-composite', { compositeOnce: false }, without( 'composite' ) ],
			[ 'legacy (all)', { fogScale: 1, bankSize: 0, fsrPort: false, compositeOnce: false }, [ ...without( 'fogBank', 'fogDepth', 'fogMarch', 'composite', 'easu', 'upscaledOutput' ), 'upscaledOutputThree' ] ],
		];
		for ( const [ name, options, passes ] of cases ) {

			const c = compileToday( options );
			assert.deepEqual( c.passNames, passes, name );
			assert.deepEqual( c.culled, [], name );

		}
		// inline-composite: the bloom takes the scene's colour after the rain (which may be skipped),
		// the sharp image evaluates the composite itself
		const reads = Object.fromEntries( compileToday( { compositeOnce: false } ).summary().passes.map( ( p ) => [ p.name, p.reads ] ) );
		assert.deepEqual( reads.bloomDown0, [ 'sceneColor@3:sample?' ] );
		assert.deepEqual( reads.sharp, [ ...TODAY_READS.composite, BLOOM.result ] );

	} ],

	[ 'variants: refraction, rain, fog, the shafts and upscaling select the passes that run', () => {

		const c = compileToday();
		const run = ( ...enabled ) => c.running( c.maskOf( enabled ) ).map( ( i ) => c.decl.passes[ i ].name );
		const scene = ( ...extra ) => [ ...MEADOW, 'opaque', 'underwaterPyramid', ...extra, 'depthResolve', 'opaqueCopy', 'water', 'surfaceResolve' ];
		const shafts = [ 'shaftsSource', 'shaftsRays' ];
		assert.deepEqual( run( 'refractionReach', 'refractionMask', 'refraction', 'rain', 'fogBank', 'fogDepth', 'fogMarch', ...shafts, 'output' ), [ ...scene( 'refractionReach', 'refractionMask', 'refraction' ), 'rain', 'fogBank', 'fogDepth', 'fogMarch', ...shafts, ...TAIL, 'output' ] );
		assert.deepEqual( run( 'refractionReach', 'refractionMask', 'refraction', 'fogDepth', 'fogMarch', 'output' ), [ ...scene( 'refractionReach', 'refractionMask', 'refraction' ), 'fogDepth', 'fogMarch', ...TAIL, 'output' ], 'rain off, the sun away' );
		assert.deepEqual( run( 'refractionReach', 'refractionMask', 'refraction', 'rain', ...shafts, 'output' ), [ ...scene( 'refractionReach', 'refractionMask', 'refraction' ), 'rain', ...shafts, ...TAIL, 'output' ], 'fog off' );
		assert.deepEqual( run( 'rain', 'output' ), [ ...scene(), 'rain', ...TAIL, 'output' ], 'refraction off (the water refracts the opaque copy alone), fog off, the sun away' );
		assert.deepEqual( run( 'refractionReach', 'refractionMask', 'refraction', 'easu', 'upscaledOutput' ), [ ...scene( 'refractionReach', 'refractionMask', 'refraction' ), ...TAIL, 'easu', 'upscaledOutput' ], 'upscaling' );
		assert.equal( c.fullMask, 4095 );

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

	[ 'storage: a compute pass writes a version without a target, and its readers keep it live', () => {

		const build = ( read ) => {

			const g = new GraphDecl();
			let out = g.import( 'out', { size: CANVAS } );
			let canvas = g.import( 'canvas', { size: CANVAS }, true );
			let a = g.color( 'a', { size: RENDER } );
			let t = g.color( 't', { size: CANVAS } );
			g.addPass( 'scene', 'scene', ( b ) => ( a = b.write( a, { clear: true } ), { label: '' } ) );
			// a kernel of a transient texture, read by the next kernel only
			g.addPass( 'k1', 'compute', ( b ) => ( b.read( a ), t = b.storage( t ), { label: '', size: RENDER } ) );
			g.addPass( 'k2', 'compute', ( b ) => ( b.read( t ), out = b.storage( out ), { label: '', when: () => true } ) );
			g.addPass( 'present', 'quad', ( b ) => ( read ? b.readOptional( out ) : b.read( a ), canvas = b.write( canvas ), { label: '' } ) );
			return compileGraph( g, { sceneSamples: 1 } );

		};
		// (the import's storage write roots k2 either way; k2's read keeps k1)
		for ( const read of [ true, false ] ) {

			const c = build( read );
			assert.deepEqual( c.culled, [], `read ${ read }` );
			// no target for the storage writes
			assert.equal( c.targetOf[ 1 ], null );
			assert.equal( c.targetOf[ 2 ], null );
			assert.equal( c.targets.some( ( x ) => x.colors.length === 1 && c.decl.resources[ x.colors[ 0 ] ].name === 't' ), false );
			const d = c.summary().passes;
			assert.deepEqual( d[ 1 ].storage.map( ( w ) => w.name ), [ 't' ] );
			assert.equal( d[ 0 ].storage, undefined );

		}
		// a transient storage version nothing reads is culled with its pass
		const g = new GraphDecl();
		let canvas = g.import( 'canvas', { size: CANVAS }, true );
		let t = g.color( 't', { size: CANVAS } );
		g.addPass( 'k', 'compute', ( b ) => ( t = b.storage( t ), { label: '' } ) );
		g.addPass( 'present', 'quad', ( b ) => ( canvas = b.write( canvas ), { label: '' } ) );
		assert.deepEqual( compileGraph( g, { sceneSamples: 1 } ).culled, [ 'k' ] );

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
			[ 'a storage write from a draw', ( g, r ) => g.addPass( 'p', 'quad', ( b ) => ( b.storage( r.a ), { label: '' } ) ), /only compute and callback passes/ ],
			[ 'a storage write of depth', ( g, r ) => g.addPass( 'p', 'compute', ( b ) => ( b.storage( r.d ), { label: '' } ) ), /depth and the canvas have no storage/ ],
			[ 'a storage write of a texture the pass reads', ( g, r ) => {

				let a;
				g.addPass( 'p1', 'quad', ( b ) => ( a = b.write( r.a ), { label: '' } ) );
				g.addPass( 'p2', 'compute', ( b ) => ( b.read( a ), b.storage( a ), { label: '' } ) );

			}, /reads and writes 'a'/ ],
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
