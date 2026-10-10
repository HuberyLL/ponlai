// The frame graph's attachment ops: the legacy table (today's: the multisampled stores discarded
// in the rain pass only) and the derived one, for today's graph, its variants and the temporal
// mock, plus a CPU mock of AttachmentOps stacking with a prototype patch of the command encoder
// (as fix/stutter's SubmitBatch installs) in either order. Run by tools/verify-framegraph.mjs.

import assert from 'node:assert/strict';
import { compileToday, declareTemporal } from './tables-passes.mjs';
import { GraphDecl, compileGraph } from '../../src/post/graph/GraphCompiler.ts';
import { AttachmentOps, opsModeFromURL } from '../../src/post/graph/AttachmentOps.ts';

const col = ( resource, load, store, resolve = null ) => ( { resource, load, store, resolve } );
const dep = ( resource, write, load, store ) => ( { resource, write, load, store } );
const row = ( pass, colors, depth = null ) => ( { pass, colors, depth } );

// every conditional pass but the upscale: rain, fog with a bank bake, the depth of field
const FULL = [ 'rain', 'fogBank', 'fogDepth', 'fogMarch', 'viewDistance', 'output' ];

const POST = [
	row( 'fogBank', [ col( 'fogBanks', 'clear', 'store' ) ] ),
	row( 'fogDepth', [ col( 'fogNearestDepth', 'clear', 'store' ) ] ),
	row( 'fogMarch', [ col( 'fogMarch', 'clear', 'store' ) ] ),
	row( 'viewDistance', [ col( 'viewDistance', 'clear', 'store' ) ] ),
	row( 'display', [ col( 'display', 'clear', 'store' ) ] ),
	row( 'output', [ col( 'canvas', 'clear', 'store' ) ] ),
];
const RESOLVES = {
	depthResolve: row( 'depthResolve', [ col( 'linearDepth', 'clear', 'store' ) ] ),
	opaqueCopy: row( 'opaqueCopy', [ col( 'opaqueColor', 'clear', 'store' ) ] ),
	surfaceResolve: row( 'surfaceResolve', [ col( 'surfaceDepth', 'clear', 'store' ) ] ),
};

export const LEGACY_FULL = [
	row( 'opaque', [ col( 'sceneColor', 'clear', 'store', true ) ], dep( 'sceneDepth', true, 'clear', 'store' ) ),
	RESOLVES.depthResolve, RESOLVES.opaqueCopy,
	row( 'water', [ col( 'sceneColor', 'load', 'store', true ) ], dep( 'sceneDepth', true, 'load', 'store' ) ),
	RESOLVES.surfaceResolve,
	row( 'rain', [ col( 'sceneColor', 'load', 'discard', true ) ], dep( 'sceneDepth', false, 'load', 'discard' ) ),
	...POST,
];

export const DERIVED_FULL = [
	// the copy samples the resolve before the water loads the samples
	row( 'opaque', [ col( 'sceneColor', 'clear', 'store', true ) ], dep( 'sceneDepth', true, 'clear', 'store' ) ),
	RESOLVES.depthResolve, RESOLVES.opaqueCopy,
	// the rain draws over the water's samples before anything samples them: no resolve
	row( 'water', [ col( 'sceneColor', 'load', 'store', false ) ], dep( 'sceneDepth', true, 'load', 'store' ) ),
	RESOLVES.surfaceResolve,
	// the last draw into the samples: resolved, samples and depth discarded
	row( 'rain', [ col( 'sceneColor', 'load', 'discard', true ) ], dep( 'sceneDepth', false, 'load', 'discard' ) ),
	...POST,
];

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
		assert.equal( full.rewrites, 2 );

	} ],

	[ 'derived ops: rain off, the water discards its samples, keeps its resolve and stores depth', () => {

		const c = compileToday();
		const dry = c.ops( 'derived', c.maskOf( FULL.filter( ( n ) => n !== 'rain' ) ) );
		assert.deepEqual( find( dry, 'water' ), {
			pass: 'water', index: 3, target: 'sceneColor|sceneDepth',
			colors: [ col( 'sceneColor', 'load', 'discard', true ) ], depth: dep( 'sceneDepth', true, 'load', 'store' ), rewrite: true,
		} );
		assert.deepEqual( find( dry, 'opaque' ).colors, [ col( 'sceneColor', 'clear', 'store', true ) ] );
		assert.equal( dry.rewrites, 1 );

	} ],

	[ 'derived ops: fog off, dof 0, upscaling and msaa=1', () => {

		const c = compileToday();
		const clear = c.ops( 'derived', c.maskOf( [ 'rain', 'output' ] ) );
		assert.deepEqual( clear.running, [ 'opaque', 'depthResolve', 'opaqueCopy', 'water', 'surfaceResolve', 'rain', 'display', 'output' ] );
		assert.deepEqual( strip( clear ).slice( 0, 6 ), DERIVED_FULL.slice( 0, 6 ) );
		const up = c.ops( 'derived', c.maskOf( [ 'rain', 'viewDistance', 'easu', 'upscaledOutput' ] ) );
		assert.deepEqual( find( up, 'easu' ).colors, [ col( 'FSR.easu', 'clear', 'store' ) ] );
		assert.deepEqual( find( up, 'upscaledOutput' ).colors, [ col( 'canvas', 'clear', 'store' ) ] );
		assert.equal( up.rewrites, 2 );
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

				if ( x.resource !== 'sceneColor' ) assert.equal( x.store, 'store', `${ p.pass } ${ x.resource } mask ${ m }` );

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

	[ 'fgOps: the URL picks the table, legacy by default', () => {

		assert.equal( opsModeFromURL( '?fgOps=derived' ), 'derived' );
		assert.equal( opsModeFromURL( '?fgOps=off' ), 'off' );
		assert.equal( opsModeFromURL( '?fgOps=bogus' ), 'legacy' );
		assert.equal( opsModeFromURL( '' ), 'legacy' );
		assert.equal( opsModeFromURL( null ), 'legacy' );

	} ],

	[ 'AttachmentOps stacks over a prototype patch installed before or after it', () => {

		const c = compileToday();
		const table = c.ops( 'derived', c.maskOf( FULL ) );
		for ( const order of [ 'patch first', 'ops first' ] ) {

			const m = mockWebGPU();
			const backend = new m.Backend();
			const ops = new AttachmentOps( backend, { mode: 'derived', dev: false } );
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
		const ops = new AttachmentOps( backend, { mode: 'legacy' } );
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
		const lateOps = new AttachmentOps( late, { mode: 'legacy' } );
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
		const off = new AttachmentOps( offBackend, { mode: 'off' } );
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
			const ops = new AttachmentOps( backend, { mode: 'derived' } );
			ops.install();
			assert.equal( frame( backend, ops ), table.rewrites );
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
			const ops = new AttachmentOps( backend, { mode: 'derived' } );
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
		const ops = new AttachmentOps( backend, { mode: 'derived' } );
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
