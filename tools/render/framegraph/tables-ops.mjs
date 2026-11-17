// The frame graph's attachment ops: the derived table (the default), the legacy one (the
// multisampled stores discarded in the rain pass only) and the all-store one (`post=store-scene`),
// for today's graph at msaa 4 and 1 with the rain on and off, direct and upscaled, its variants and
// the temporal mock; the per-mask cache; the URL option; plus a CPU mock of AttachmentOps stacking
// with a prototype patch of the command encoder (as SubmitBatch installs) in either order. Run by
// tools/render/verify-framegraph.mjs.

import assert from 'node:assert/strict';
import { BLOOM_PASSES, bloomTable, compilePipeline, compileToday, declareTemporal } from './tables-passes.mjs';
import { GraphDecl, compileGraph } from '../../../packages/render/post/graph/GraphCompiler.ts';
import { AttachmentOps, opsModeFromURL } from '../../../packages/render/post/graph/AttachmentOps.ts';
import { parseSettings } from '../../../packages/render/Settings.ts';

const col = ( resource, load, store, resolve = null ) => ( { resource, load, store, resolve } );
const dep = ( resource, write, load, store ) => ( { resource, write, load, store } );
const row = ( pass, colors, depth = null ) => ( { pass, colors, depth } );

// every conditional pass but the upscale: the refraction, rain, the haze's shadow, the light
// shafts
const FULL = [ 'refractionReach', 'refractionMask', 'refraction', 'rain', 'hazeShadow', 'shaftsSource', 'shaftsRays', 'output' ];

const POST = [
	// the haze's kernels: no attachments, so no ops (their volumes are written through storage)
	row( 'hazeShadow', [] ),
	row( 'hazeLight', [] ),
	row( 'shaftsSource', [ col( 'shafts.source', 'clear', 'store' ) ] ),
	row( 'shaftsRays', [ col( 'shafts.rays', 'clear', 'store' ) ] ),
	row( 'postConstants', [ col( 'postConstants', 'clear', 'store' ) ] ),
	row( 'composite', [ col( 'hdr', 'clear', 'store' ) ] ),
	...bloomTable( [] ).rows.map( ( r ) => row( r.name, r.writes.map( ( x ) => col( x.name, 'clear', 'store' ) ) ) ),
	row( 'sharp', [ col( 'sharp', 'clear', 'store' ) ] ),
	row( 'display', [ col( 'display', 'clear', 'store' ) ] ),
	row( 'output', [ col( 'canvas', 'clear', 'store' ) ] ),
];
// the refraction's own single-sampled target, cleared, both stored for the water
const REFRACTION_ROW = row( 'refraction', [ col( 'refraction', 'load', 'store' ) ], dep( 'refractionDepth', true, 'load', 'store' ) );
// the mask before it: cleared, its nearest depth drawn where the opaque image holds the floor
const MASK_ROW = row( 'refractionMask', [ col( 'refraction', 'clear', 'store' ) ], dep( 'refractionDepth', true, 'clear', 'store' ) );
// and the lookups' reach it reads
const REACH_ROW = row( 'refractionReach', [ col( 'refractionReach', 'clear', 'store' ) ] );
// the meadow's screen-space shadows (at 4x): the depth's nearest view z and the shadows, both read
// by the next pass
const MEADOW_ROWS = [
	row( 'meadowDepthResolve', [ col( 'meadowDepth', 'clear', 'store' ) ] ),
	row( 'meadowShadows', [ col( 'meadowShadows', 'clear', 'store' ) ] ),
];
const RESOLVES = {
	depthResolve: row( 'depthResolve', [ col( 'linearDepth', 'clear', 'store' ) ] ),
	opaqueCopy: row( 'opaqueCopy', [ col( 'opaqueColor', 'clear', 'store' ) ] ),
	underwaterPyramid: row( 'underwaterPyramid', [ col( 'underwater', 'clear', 'store' ) ] ),
	surfaceResolve: row( 'surfaceResolve', [ col( 'surfaceDepth', 'clear', 'store' ) ] ),
};

export const LEGACY_FULL = [
	row( 'meadowDepth', [ col( 'meadowCoverage', 'clear', 'store', true ) ], dep( 'sceneDepth', true, 'clear', 'store' ) ),
	...MEADOW_ROWS,
	row( 'opaque', [ col( 'sceneColor', 'clear', 'store', true ) ], dep( 'sceneDepth', true, 'load', 'store' ) ),
	RESOLVES.underwaterPyramid, REACH_ROW, MASK_ROW, REFRACTION_ROW, RESOLVES.depthResolve, RESOLVES.opaqueCopy,
	row( 'water', [ col( 'sceneColor', 'load', 'store', true ) ], dep( 'sceneDepth', true, 'load', 'store' ) ),
	RESOLVES.surfaceResolve,
	row( 'rain', [ col( 'sceneColor', 'load', 'discard', true ) ], dep( 'sceneDepth', false, 'load', 'discard' ) ),
	...POST,
];

export const DERIVED_FULL = [
	// the vegetation's coverage is never read: its samples discarded (still resolved, as the last
	// write of a multisampled colour is); its depth stored for the resolve and the opaque scene
	row( 'meadowDepth', [ col( 'meadowCoverage', 'clear', 'discard', true ) ], dep( 'sceneDepth', true, 'clear', 'store' ) ),
	...MEADOW_ROWS,
	// the copy samples the resolve before the water loads the samples; the depth loads the
	// vegetation's
	row( 'opaque', [ col( 'sceneColor', 'clear', 'store', true ) ], dep( 'sceneDepth', true, 'load', 'store' ) ),
	RESOLVES.underwaterPyramid, REACH_ROW, MASK_ROW, REFRACTION_ROW, RESOLVES.depthResolve, RESOLVES.opaqueCopy,
	// the rain draws over the water's samples before anything samples them: no resolve
	row( 'water', [ col( 'sceneColor', 'load', 'store', false ) ], dep( 'sceneDepth', true, 'load', 'store' ) ),
	RESOLVES.surfaceResolve,
	// the last draw into the samples: resolved, samples and depth discarded
	row( 'rain', [ col( 'sceneColor', 'load', 'discard', true ) ], dep( 'sceneDepth', false, 'load', 'discard' ) ),
	...POST,
];

// the masks a frame can have: the canvas written either directly or through the upscale
const frameMasks = ( c ) => {

	const direct = c.maskOf( [ 'output' ] ), upscaled = c.maskOf( [ 'easu', 'upscaledOutput', 'upscaledOutputThree' ] );
	const masks = [];
	for ( let m = 0; m <= c.fullMask; m ++ ) {

		const out = m & ( direct | upscaled );
		if ( out === direct || out === upscaled ) masks.push( m );

	}
	return masks;

};
const strip = ( table ) => table.passes.map( ( p ) => row( p.pass, p.colors, p.depth ) );
const find = ( table, name ) => table.passes.find( ( p ) => p.pass === name );

// ---- a CPU mock of the WebGPU objects AttachmentOps wraps (r186's beginRender path)

function mockWebGPU() {

	const base = [];
	class GPUCommandEncoder {

		beginRenderPass( descriptor ) {

			base.push( { encoder: this, descriptor } );
			return {};

		}

	}
	class GPUDevice {

		createCommandEncoder() {

			return new GPUCommandEncoder();

		}

	}
	class Backend {

		constructor() {

			this.device = new GPUDevice();

		}

		// as WebGPUBackend.beginRender: the descriptor (cached by three), then an encoder of its own
		beginRender( renderContext ) {

			const encoder = this.device.createCommandEncoder( { label: 'renderContext' } );
			encoder.beginRenderPass( renderContext.descriptor );

		}

	}
	// a prototype patch as SubmitBatch's: it records `this` and the descriptor it is handed
	const patched = [];
	const patchPrototype = () => {

		const original = GPUCommandEncoder.prototype.beginRenderPass;
		GPUCommandEncoder.prototype.beginRenderPass = function ( descriptor ) {

			patched.push( { encoder: this, descriptor } );
			return original.call( this, descriptor );

		};

	};
	// a command recorder (CommandBatch, tried for the frame pacing and not shipped; the shipped
	// SubmitBatch is a prototype patch, mocked above): an instance wrapper of createCommandEncoder
	// that, while batching, returns a recording encoder without calling the earlier wrapper, and
	// replays the recording into real encoders through the device method it saved, outside
	// beginRender
	const installBatch = ( device ) => {

		const create = device.createCommandEncoder.bind( device );
		const pending = [];
		class DeferredEncoder {

			constructor() {

				this.ops = [];
				pending.push( this );

			}

			beginRenderPass( descriptor ) {

				// a deep copy, as CommandBatch's snap()
				this.ops.push( JSON.parse( JSON.stringify( descriptor ) ) );
				return {};

			}

		}
		device.createCommandEncoder = function () {

			return new DeferredEncoder();

		};
		return {
			flush() {

				const encoder = create( { label: 'batch' } );
				for ( const d of pending.splice( 0 ) ) for ( const descriptor of d.ops ) encoder.beginRenderPass( descriptor );

			},
		};

	};
	return { base, patched, Backend, GPUCommandEncoder, patchPrototype, installBatch };

}

const msaaDescriptor = () => ( {
	colorAttachments: [ { view: 'samples', resolveTarget: 'resolved', loadOp: 'load', storeOp: 'store' } ],
	depthStencilAttachment: { view: 'depth', depthLoadOp: 'load', depthStoreOp: 'store' },
} );

export const checks = [

	[ 'legacy ops: today\'s discard in the rain pass only', () => {

		const c = compileToday();
		const full = c.ops( 'legacy', c.maskOf( FULL ) );
		assert.deepEqual( strip( full ), LEGACY_FULL );
		assert.equal( full.rewrites, 1 );
		// rain off: nothing is rewritten (the water's samples are stored, as before)
		const dry = c.ops( 'legacy', c.maskOf( FULL.filter( ( n ) => n !== 'rain' ) ) );
		assert.equal( dry.rewrites, 0 );
		assert.deepEqual( find( dry, 'water' ).colors, [ col( 'sceneColor', 'load', 'store', true ) ] );
		// post=store-scene: no discard anywhere
		const kept = compileToday( {}, 4, [] );
		for ( let m = 0; m <= kept.fullMask; m ++ ) assert.equal( kept.ops( 'legacy', m ).rewrites, 0 );
		// msaa=1: the hook only touched a multisampled pass resolving into its target
		const single = compileToday( {}, 1 );
		for ( let m = 0; m <= single.fullMask; m ++ ) assert.equal( single.ops( 'legacy', m ).rewrites, 0 );

	} ],

	[ 'derived ops: rain discards colour and depth, the water drops its resolve under rain', () => {

		const c = compileToday();
		const full = c.ops( 'derived', c.maskOf( FULL ) );
		assert.deepEqual( strip( full ), DERIVED_FULL );
		// (the vegetation depth pass's discarded coverage, the water, the rain)
		assert.equal( full.rewrites, 3 );

	} ],

	[ 'derived ops: rain off, the water discards its samples, keeps its resolve and stores depth', () => {

		const c = compileToday();
		const dry = c.ops( 'derived', c.maskOf( FULL.filter( ( n ) => n !== 'rain' ) ) );
		assert.deepEqual( find( dry, 'water' ), {
			pass: 'water', index: 10, target: 'sceneColor|sceneDepth',
			colors: [ col( 'sceneColor', 'load', 'discard', true ) ], depth: dep( 'sceneDepth', true, 'load', 'store' ), rewrite: true,
		} );
		assert.deepEqual( find( dry, 'opaque' ).colors, [ col( 'sceneColor', 'clear', 'store', true ) ] );
		// (and the vegetation depth pass's coverage)
		assert.equal( dry.rewrites, 2 );

	} ],

	[ 'derived ops: the haze\'s shadow held, the sun away, refraction off, upscaling and msaa=1', () => {

		const c = compileToday();
		const clear = c.ops( 'derived', c.maskOf( [ 'refractionReach', 'refractionMask', 'refraction', 'rain', 'output' ] ) );
		assert.deepEqual( clear.running, [ 'meadowDepth', 'meadowDepthResolve', 'meadowShadows', 'opaque', 'underwaterPyramid', 'refractionReach', 'refractionMask', 'refraction', 'depthResolve', 'opaqueCopy', 'water', 'surfaceResolve', 'rain', 'hazeLight', 'postConstants', 'composite', ...BLOOM_PASSES, 'sharp', 'display', 'output' ] );
		assert.deepEqual( strip( clear ).slice( 0, 10 ), DERIVED_FULL.slice( 0, 10 ) );
		// without the refraction the scene target's ops are the same (the water reads it optionally)
		const dry = c.ops( 'derived', c.maskOf( [ 'rain', 'output' ] ) );
		assert.deepEqual( strip( dry ).slice( 0, 9 ), DERIVED_FULL.filter( ( r ) => r.pass !== 'refraction' && r.pass !== 'refractionMask' && r.pass !== 'refractionReach' ).slice( 0, 9 ) );
		const up = c.ops( 'derived', c.maskOf( [ 'refractionReach', 'refractionMask', 'refraction', 'rain', 'easu', 'upscaledOutput' ] ) );
		assert.deepEqual( find( up, 'easu' ).colors, [ col( 'FSR.easu', 'clear', 'store' ) ] );
		assert.deepEqual( find( up, 'upscaledOutput' ).colors, [ col( 'canvas', 'clear', 'store' ) ] );
		assert.equal( up.rewrites, 3 );
		// single-sampled: every colour is read later; only the rain's depth goes unread
		const single = compileToday( {}, 1 );
		const s = single.ops( 'derived', single.maskOf( FULL ) );
		assert.deepEqual( find( s, 'water' ).colors, [ col( 'sceneColor', 'load', 'store' ) ] );
		assert.deepEqual( find( s, 'rain' ).colors, [ col( 'sceneColor', 'load', 'store' ) ] );
		assert.deepEqual( find( s, 'rain' ).depth, dep( 'sceneDepth', false, 'load', 'discard' ) );
		assert.equal( s.rewrites, 1 );
		// every mask: a store discarded only where no later pass loads or reads the attachment
		// (the masks a frame can have: the canvas written either directly or through the upscale)
		const direct = c.maskOf( [ 'output' ] ), upscaled = c.maskOf( [ 'easu', 'upscaledOutput' ] );
		for ( let m = 0; m <= c.fullMask; m ++ ) {

			const out = m & ( direct | upscaled );
			if ( out !== direct && out !== upscaled ) continue;
			const t = c.ops( 'derived', m );
			for ( const p of t.passes ) for ( const x of p.colors ) {

				// (the vegetation's coverage is never read)
				if ( x.resource !== 'sceneColor' ) assert.equal( x.store, x.resource === 'meadowCoverage' ? 'discard' : 'store', `${ p.pass } ${ x.resource } mask ${ m }` );

			}
			// the last draw into the samples always resolves
			const last = t.passes.filter( ( p ) => p.target === 'sceneColor|sceneDepth' ).pop();
			assert.equal( last.colors[ 0 ].resolve, true, `mask ${ m }` );

		}

	} ],

	[ 'derived ops: the temporal mock (MRT, overlay, ping-pong history, copied depth)', () => {

		const { c } = declareTemporal();
		const t = c.ops( 'derived', c.fullMask );
		assert.deepEqual( strip( t ), [
			row( 'opaque', [ col( 'sceneColor', 'clear', 'store' ), col( 'velocity', 'clear', 'store' ) ], dep( 'sceneDepth', true, 'clear', 'store' ) ),
			row( 'depthResolve', [ col( 'linearDepth', 'clear', 'store' ) ] ),
			row( 'opaqueCopy', [ col( 'opaqueColor', 'clear', 'store' ) ] ),
			row( 'water', [ col( 'sceneColor', 'load', 'store' ), col( 'velocity', 'load', 'store' ) ], dep( 'sceneDepth', true, 'load', 'store' ) ),
			row( 'surfaceResolve', [ col( 'surfaceDepth', 'clear', 'store' ) ] ),
			row( 'overlay', [ col( 'sceneColor', 'load', 'store' ), col( 'velocity', 'load', 'store' ) ], dep( 'sceneDepth', false, 'load', 'discard' ) ),
			row( 'display', [ col( 'display', 'clear', 'store' ) ] ),
			row( 'resolve', [ col( 'history', 'clear', 'store' ) ] ),
			row( 'output', [ col( 'canvas', 'clear', 'store' ) ] ),
		] );
		assert.equal( t.rewrites, 1 );
		const legacy = c.ops( 'legacy', c.fullMask );
		assert.equal( legacy.rewrites, 0, 'single-sampled: the legacy hook rewrites nothing' );

	} ],

	[ 'blended full-screen pass: loads in both tables, and its producer stores', () => {

		const g = new GraphDecl();
		let x = g.color( 'x', { size: { of: 'render' } } );
		let canvas = g.import( 'canvas', { size: { of: 'canvas' } }, true );
		g.addPass( 'base', 'scene', ( b ) => ( x = b.write( x, { clear: true } ), { label: 'b' } ) );
		g.addPass( 'add', 'quad', ( b ) => ( x = b.write( x, { blend: 'additive' } ), { label: 'a' } ) );
		g.addPass( 'over', 'quad', ( b ) => ( b.read( x ), canvas = b.write( canvas ), { label: 'o' } ) );
		const c = compileGraph( g, { sceneSamples: 1 } );
		for ( const mode of [ 'legacy', 'derived' ] ) {

			const t = c.ops( mode, 0 );
			assert.deepEqual( find( t, 'base' ).colors, [ col( 'x', 'clear', 'store' ) ], mode );
			assert.deepEqual( find( t, 'add' ).colors, [ col( 'x', 'load', 'store' ) ], mode );
			assert.deepEqual( find( t, 'over' ).colors, [ col( 'canvas', 'clear', 'store' ) ], mode );

		}

	} ],

	[ 'derived ops, msaa 4: the scene target per rain on/off, direct and upscaled, refraction, the haze\'s shadow and the shafts on or off', () => {

		// the scene target's rows depend on the rain alone; every other attachment is stored but the
		// vegetation's coverage, which nothing reads
		const VEGETATION = DERIVED_FULL[ 0 ];
		const WET = [
			VEGETATION,
			row( 'opaque', [ col( 'sceneColor', 'clear', 'store', true ) ], dep( 'sceneDepth', true, 'load', 'store' ) ),
			row( 'water', [ col( 'sceneColor', 'load', 'store', false ) ], dep( 'sceneDepth', true, 'load', 'store' ) ),
			row( 'rain', [ col( 'sceneColor', 'load', 'discard', true ) ], dep( 'sceneDepth', false, 'load', 'discard' ) ),
		];
		const DRY = [
			WET[ 0 ], WET[ 1 ],
			row( 'water', [ col( 'sceneColor', 'load', 'discard', true ) ], dep( 'sceneDepth', true, 'load', 'store' ) ),
		];
		const variants = [ {}, { fsrPort: false }, { compositeOnce: false }, { fsrPort: false, compositeOnce: false } ];
		for ( const [ compile, options ] of [ compileToday, compilePipeline ].flatMap( ( f ) => variants.map( ( o ) => [ f, o ] ) ) ) {

			const c = compile( options );
			const OUT = [ 'output', 'easu', 'upscaledOutput', 'upscaledOutputThree' ];
			const rain = c.maskOf( [ 'rain' ] ), direct = c.maskOf( [ 'output' ] ), upscaled = c.maskOf( OUT.slice( 1 ) );
			const masks = frameMasks( c );
			const outputs = c.conditional.filter( ( i ) => OUT.includes( c.decl.passes[ i ].name ) ).length;
			assert.equal( masks.length, 2 ** ( c.conditional.length - outputs ) * 2, 'every frame mask is checked' );
			for ( const m of masks ) {

				const out = m & ( direct | upscaled );
				const t = c.ops( 'derived', m );
				const wet = ( m & rain ) !== 0;
				const what = `${ compile.name } ${ JSON.stringify( options ) } mask ${ m } (rain ${ wet ? 'on' : 'off' }, ${ out === direct ? 'direct' : 'upscaled' })`;
				assert.deepEqual( strip( t ).filter( ( p ) => [ 'meadowDepth', 'opaque', 'water', 'rain' ].includes( p.pass ) ), wet ? WET : DRY, what );
				assert.equal( t.rewrites, wet ? 3 : 2, what );
				for ( const p of t.passes ) {

					if ( p.target === 'sceneColor|sceneDepth' || p.pass === 'meadowDepth' ) continue;
					for ( const x of p.colors ) assert.deepEqual( [ x.store, x.resolve ], [ 'store', null ], `${ what } ${ p.pass }` );
					// (the refraction's depth, single-sampled, is stored for the water)
					assert.deepEqual( p.depth, p.pass === 'refraction' ? REFRACTION_ROW.depth : p.pass === 'refractionMask' ? MASK_ROW.depth : null, `${ what } ${ p.pass }` );
					assert.equal( p.rewrite, false, `${ what } ${ p.pass }` );

				}
				// derived and legacy differ only in the vegetation's coverage store and the water's
				// resolve (rain on) or its colour store (rain off), and the rain's ops are legacy's
				const legacy = c.ops( 'legacy', m );
				const diff = t.passes.flatMap( ( p, i ) => JSON.stringify( p ) === JSON.stringify( legacy.passes[ i ] ) ? [] : [ p.pass ] );
				assert.deepEqual( diff, [ 'meadowDepth', 'water' ], what );

			}

		}

	} ],

	[ 'derived ops, msaa 1: only the rain\'s depth is discarded, nothing else changes', () => {

		const c = compileToday( {}, 1 );
		const rain = c.maskOf( [ 'rain' ] );
		for ( const m of frameMasks( c ) ) {

			const t = c.ops( 'derived', m );
			const wet = ( m & rain ) !== 0;
			assert.equal( t.rewrites, wet ? 1 : 0, `mask ${ m }` );
			for ( const p of t.passes ) {

				for ( const x of p.colors ) assert.deepEqual( [ x.store, x.resolve ], [ 'store', null ], `mask ${ m } ${ p.pass }` );
				if ( p.depth ) assert.equal( p.depth.store, p.pass === 'rain' ? 'discard' : 'store', `mask ${ m } ${ p.pass }` );

			}

		}

	} ],

	[ 'store ops (post=store-scene): every store and resolve kept, the loads derived\'s, nothing rewritten', () => {

		for ( const [ samples, compile ] of [ [ 4, compileToday ], [ 1, compileToday ], [ 4, compilePipeline ] ] ) {

			const c = compile( {}, samples, [] );
			for ( const m of frameMasks( c ) ) {

				const t = c.ops( 'store', m ), d = c.ops( 'derived', m );
				const what = `${ compile.name } samples ${ samples } mask ${ m }`;
				assert.equal( t.rewrites, 0, what );
				assert.deepEqual( t.running, d.running, what );
				t.passes.forEach( ( p, i ) => {

					assert.equal( p.rewrite, false, what );
					p.colors.forEach( ( x, j ) => {

						assert.equal( x.store, 'store', `${ what } ${ p.pass }` );
						// (the multisampled targets: the scene's, and the vegetation's coverage beside its depth)
						assert.equal( x.resolve, samples > 1 && p.target.endsWith( '|sceneDepth' ) ? true : null, `${ what } ${ p.pass }` );
						assert.equal( x.load, d.passes[ i ].colors[ j ].load, `${ what } ${ p.pass }` );

					} );
					if ( p.depth ) assert.deepEqual( { ...p.depth, store: 'discard' }, { ...d.passes[ i ].depth, store: 'discard' }, `${ what } ${ p.pass }` );
					if ( p.depth ) assert.equal( p.depth.store, 'store', `${ what } ${ p.pass }` );

				} );

			}

		}
		// the legacy table under store-scene (legacyDiscard []) is the same all-store table
		const kept = compilePipeline( {}, 4, [] );
		for ( let m = 0; m <= kept.fullMask; m ++ ) assert.deepEqual( strip( kept.ops( 'legacy', m ) ), strip( kept.ops( 'store', m ) ) );

	} ],

	[ 'ops cache: one table per mode and enabled mask, derived once', () => {

		const c = compileToday();
		const wet = c.maskOf( FULL ), dry = c.maskOf( FULL.filter( ( n ) => n !== 'rain' ) );
		const a = c.ops( 'derived', wet );
		assert.equal( c.ops( 'derived', wet ), a, 'the same object for the same mask' );
		assert.notEqual( c.ops( 'derived', dry ), a );
		assert.notEqual( c.ops( 'legacy', wet ), a );
		assert.notEqual( c.ops( 'store', wet ), a );
		assert.equal( a.mask, wet );
		assert.equal( a.mode, 'derived' );
		// a fresh compile derives equal tables (deterministic)
		assert.deepEqual( compileToday().ops( 'derived', wet ), a );
		assert.throws( () => c.ops( 'bogus', wet ), /unknown ops mode/ );

	} ],

	[ 'fgOps: the URL picks the table, derived by default, all-store under post=store-scene', () => {

		assert.equal( opsModeFromURL( parseSettings( '?fgOps=derived' ) ), 'derived' );
		assert.equal( opsModeFromURL( parseSettings( '?fgOps=legacy' ) ), 'legacy' );
		assert.equal( opsModeFromURL( parseSettings( '?fgOps=store' ) ), 'store' );
		assert.equal( opsModeFromURL( parseSettings( '?fgOps=off' ) ), 'off' );
		assert.equal( opsModeFromURL( parseSettings( '?fgOps=bogus' ) ), 'derived' );
		assert.equal( opsModeFromURL( parseSettings( '' ) ), 'derived' );
		assert.equal( opsModeFromURL( null ), 'derived' );
		assert.equal( opsModeFromURL( parseSettings( '?post=store-scene' ) ), 'store' );
		assert.equal( opsModeFromURL( parseSettings( '?post=three-fsr,store-scene' ) ), 'store' );
		assert.equal( opsModeFromURL( parseSettings( '?post=legacy' ) ), 'store', 'post=legacy includes store-scene' );
		assert.equal( opsModeFromURL( parseSettings( '?post=three-fsr' ) ), 'derived' );
		assert.equal( opsModeFromURL( parseSettings( '?post=store-scene&fgOps=derived' ) ), 'derived', 'an explicit fgOps wins' );
		assert.equal( opsModeFromURL( parseSettings( '?post=store-scene&fgOps=legacy' ) ), 'legacy' );
		assert.equal( new AttachmentOps( { backend: mockWebGPU().Backend.prototype } ).mode, 'derived', 'the default in a page without the option (node: no location)' );

	} ],

	[ 'AttachmentOps stacks over a prototype patch installed before or after it', () => {

		const c = compileToday();
		const table = c.ops( 'derived', c.maskOf( FULL ) );
		for ( const order of [ 'patch first', 'ops first' ] ) {

			const m = mockWebGPU();
			const backend = new m.Backend();
			const ops = new AttachmentOps( { backend }, { mode: 'derived', dev: false } );
			if ( order === 'patch first' ) m.patchPrototype();
			ops.install();
			if ( order === 'ops first' ) m.patchPrototype();
			assert.equal( Object.hasOwn( m.GPUCommandEncoder.prototype, 'beginRenderPass' ), true );

			const sceneRT = { name: 'sceneRT' }, shadowRT = { name: 'shadow' };
			const water = msaaDescriptor(), rain = msaaDescriptor();
			ops.begin( table );
			ops.enterPass( sceneRT, find( table, 'water' ) );
			backend.beginRender( { renderTarget: sceneRT, textures: [ {} ], descriptor: water } );
			// a nested render into another target inside the pass (a shadow map) is untouched
			backend.beginRender( { renderTarget: shadowRT, textures: [ {} ], descriptor: msaaDescriptor() } );
			ops.leavePass();
			ops.enterPass( sceneRT, find( table, 'rain' ) );
			backend.beginRender( { renderTarget: sceneRT, textures: [ {} ], descriptor: rain } );
			ops.leavePass();
			assert.equal( ops.applied, 2, order );
			ops.end();
			// outside the graph's frame: untouched
			backend.beginRender( { renderTarget: sceneRT, textures: [ {} ], descriptor: msaaDescriptor() } );

			assert.equal( m.base.length, 4, order );
			assert.equal( m.patched.length, 4, `${ order }: the prototype patch sees every pass` );
			m.base.forEach( ( b, i ) => {

				assert.equal( m.patched[ i ].encoder, b.encoder, `${ order }: the patch runs with the encoder as this` );
				assert.equal( m.patched[ i ].descriptor, b.descriptor, `${ order }: the patch sees the rewritten descriptor` );

			} );
			const [ w, shadow, r, after ] = m.base.map( ( b ) => b.descriptor );
			assert.equal( w.colorAttachments[ 0 ].resolveTarget, undefined, order );
			assert.equal( w.colorAttachments[ 0 ].storeOp, 'store', order );
			assert.equal( w.depthStencilAttachment.depthStoreOp, 'store', order );
			assert.equal( r.colorAttachments[ 0 ].resolveTarget, 'resolved', order );
			assert.equal( r.colorAttachments[ 0 ].storeOp, 'discard', order );
			assert.equal( r.depthStencilAttachment.depthStoreOp, 'discard', order );
			assert.deepEqual( shadow, msaaDescriptor(), order );
			assert.deepEqual( after, msaaDescriptor(), order );
			// three's cached descriptors are left as they were
			assert.deepEqual( water, msaaDescriptor(), order );
			assert.deepEqual( rain, msaaDescriptor(), order );

			ops.uninstall();
			assert.equal( Object.hasOwn( backend, 'beginRender' ), false, order );
			assert.equal( Object.hasOwn( backend.device, 'createCommandEncoder' ), false, order );

		}

	} ],

	[ 'AttachmentOps composes with an instance wrapper, checks attachment counts, and stays off when told', () => {

		const c = compileToday();
		const table = c.ops( 'legacy', c.maskOf( FULL ) );
		const m = mockWebGPU();
		const backend = new m.Backend();
		// an instance wrapper installed before (as Pipeline's own scene-store hook wrapped the device)
		const device = backend.device;
		const create = device.createCommandEncoder.bind( device );
		device.createCommandEncoder = ( d ) => {

			const encoder = create( d );
			const begin = encoder.beginRenderPass.bind( encoder );
			encoder.beginRenderPass = ( descriptor ) => begin( { ...descriptor, tagged: true } );
			return encoder;

		};
		const ops = new AttachmentOps( { backend }, { mode: 'legacy' } );
		ops.install();
		const sceneRT = {};
		ops.begin( table );
		ops.enterPass( sceneRT, find( table, 'rain' ) );
		backend.beginRender( { renderTarget: sceneRT, textures: [ {} ], descriptor: msaaDescriptor() } );
		// two attachments where the ops know one: left as three made it, and counted
		const two = msaaDescriptor();
		two.colorAttachments.push( { view: 'velocity', storeOp: 'store' } );
		backend.beginRender( { renderTarget: sceneRT, textures: [ {}, {} ], descriptor: two } );
		ops.end();
		assert.equal( m.base[ 0 ].descriptor.tagged, true );
		assert.equal( m.base[ 0 ].descriptor.colorAttachments[ 0 ].storeOp, 'discard' );
		assert.equal( m.base[ 1 ].descriptor.colorAttachments[ 0 ].storeOp, 'store' );
		assert.equal( ops.mismatches, 1 );
		ops.uninstall();
		assert.equal( Object.hasOwn( device, 'createCommandEncoder' ), true, 'the earlier instance wrapper is restored' );

		// uninstall with a wrapper installed after it: the later wrapper stays (it calls ours,
		// which now only passes calls on)
		const late = new m.Backend();
		const lateOps = new AttachmentOps( { backend: late }, { mode: 'legacy' } );
		lateOps.install();
		const ours = late.device.createCommandEncoder;
		const after = function ( d ) {

			return ours.call( late.device, d );

		};
		late.device.createCommandEncoder = after;
		lateOps.uninstall();
		assert.equal( late.device.createCommandEncoder, after, 'a later wrapper survives uninstall' );
		assert.equal( Object.hasOwn( late, 'beginRender' ), false, 'our own beginRender wrapper is removed' );
		lateOps.begin( table );
		lateOps.enterPass( sceneRT, find( table, 'rain' ) );
		late.beginRender( { renderTarget: sceneRT, textures: [ {} ], descriptor: msaaDescriptor() } );
		lateOps.end();
		assert.equal( lateOps.applied, 0, 'an uninstalled AttachmentOps rewrites nothing' );
		assert.deepEqual( m.base[ m.base.length - 1 ].descriptor, msaaDescriptor() );

		// fgOps=off: installed, inside a frame, still nothing is rewritten
		const offBackend = new m.Backend();
		const off = new AttachmentOps( { backend: offBackend }, { mode: 'off' } );
		off.install();
		off.begin( table );
		off.enterPass( sceneRT, find( table, 'rain' ) );
		offBackend.beginRender( { renderTarget: sceneRT, textures: [ {} ], descriptor: msaaDescriptor() } );
		off.end();
		off.uninstall();
		assert.equal( off.applied, 0 );
		assert.deepEqual( m.base[ m.base.length - 1 ].descriptor, msaaDescriptor() );

	} ],

	[ 'AttachmentOps after CommandBatch: the recorded passes carry the rewrite; before it: bypassed and flagged', () => {

		const c = compileToday();
		const table = c.ops( 'derived', c.maskOf( FULL ) );
		const frame = ( backend, ops ) => {

			const sceneRT = {};
			ops.begin( table );
			for ( const name of [ 'water', 'rain' ] ) {

				ops.enterPass( sceneRT, find( table, name ) );
				backend.beginRender( { renderTarget: sceneRT, textures: [ {} ], descriptor: msaaDescriptor() } );
				ops.leavePass();

			}
			const applied = ops.applied;
			ops.end();
			return applied;

		};
		// the required order: CommandBatch first, AttachmentOps last
		{

			const m = mockWebGPU();
			const backend = new m.Backend();
			const batch = m.installBatch( backend.device );
			const ops = new AttachmentOps( { backend }, { mode: 'derived' } );
			ops.install();
			// (the frame enters the water and the rain only, both rewritten)
			assert.equal( frame( backend, ops ), 2 );
			assert.equal( ops.overwrapped, false );
			assert.equal( m.base.length, 0, 'nothing reaches WebGPU before the flush' );
			batch.flush();
			const [ water, rain ] = m.base.map( ( b ) => b.descriptor );
			assert.equal( water.colorAttachments[ 0 ].resolveTarget, undefined );
			assert.equal( rain.colorAttachments[ 0 ].storeOp, 'discard' );
			assert.equal( rain.depthStencilAttachment.depthStoreOp, 'discard' );

		}
		// the wrong order: the batch's encoders never pass through AttachmentOps; the count and the
		// flag make it visible
		{

			const m = mockWebGPU();
			const backend = new m.Backend();
			const ops = new AttachmentOps( { backend }, { mode: 'derived' } );
			ops.install();
			const batch = m.installBatch( backend.device );
			assert.equal( frame( backend, ops ), 0 );
			assert.notEqual( table.rewrites, 0 );
			assert.equal( ops.overwrapped, true );
			batch.flush();
			assert.deepEqual( m.base.map( ( b ) => b.descriptor ), [ msaaDescriptor(), msaaDescriptor() ] );

		}

	} ],

	[ 'AttachmentOps rewrites only the first pass begun on an encoder', () => {

		const c = compileToday();
		const table = c.ops( 'derived', c.maskOf( FULL ) );
		const m = mockWebGPU();
		const backend = new m.Backend();
		// as copyFramebufferToTexture: the pass is ended and begun again on the same encoder
		backend.beginRender = function ( renderContext ) {

			const encoder = this.device.createCommandEncoder( { label: 'renderContext' } );
			encoder.beginRenderPass( renderContext.descriptor );
			encoder.beginRenderPass( { ...renderContext.descriptor, again: true } );

		};
		const ops = new AttachmentOps( { backend }, { mode: 'derived' } );
		ops.install();
		const sceneRT = {};
		ops.begin( table );
		ops.enterPass( sceneRT, find( table, 'rain' ) );
		backend.beginRender( { renderTarget: sceneRT, textures: [ {} ], descriptor: msaaDescriptor() } );
		ops.end();
		ops.uninstall();
		assert.equal( ops.applied, 1 );
		assert.equal( ops.rebegins, 1 );
		const [ first, second ] = m.base.map( ( b ) => b.descriptor );
		assert.equal( first.colorAttachments[ 0 ].storeOp, 'discard' );
		assert.equal( second.again, true );
		assert.equal( second.colorAttachments[ 0 ].storeOp, 'store', 'the re-begun pass is left as three made it' );

	} ],

];
