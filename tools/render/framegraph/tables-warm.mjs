// The frame graph's warm-up (FrameGraph.warm, packages/render/post/graph/Compile.ts) on a CPU mock of three's
// renderer and the internals the bound compile builds through: every compiled pass compiled once
// under its own binding (a conditional one too), the renderer's binding restored, latent objects
// compiled shown whatever their visibility (registered before the warm-up, or after it at once), a
// bloom nested in a pass one call depth down, a chain of three's nodes (a bloom run as a pass of its
// own) at the top level, and priming: only what the walker cannot reach, at the
// real extents, persistent writes invalidated, and off with `prime: false`. Run by
// tools/render/verify-framegraph.mjs.

import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { texture } from 'three/tsl';
import BloomNode from 'three/addons/tsl/display/BloomNode.js';
import { FrameGraph } from '../../../packages/render/post/graph/FrameGraph.ts';

const RENDER = { of: 'render' };
const CANVAS = { of: 'canvas' };
const extents = ( w, h ) => ( { render: { width: w, height: h }, canvas: { width: w, height: h } } );

// A renderer whose compileAsync collects the visible meshes of what it is given through
// `_createObjectPipeline`, as three r187's does (between its precompilation state's begin and end), and whose node builds record the binding they see.
// A material's `userData.before` lists the nodes its build names as rendering before it.
function mockRenderer() {

	let target = null, mrt = null;
	const builds = [], renders = [], computes = [];
	const contexts = new Map();
	const context = ( rt, m, depth ) => {

		const key = `${ rt?.uuid ?? 'canvas' }|${ m?.id ?? '-' }|${ depth }`;
		if ( ! contexts.has( key ) ) contexts.set( key, { id: contexts.size, callDepth: depth, textures: null, depthTexture: null, depth: true, stencil: false } );
		return contexts.get( key );

	};
	const r = {
		builds, renders, computes,
		backend: { device: { createCommandEncoder() { return { beginRenderPass() {} }; } }, beginRender() {} },
		depth: true, stencil: false, autoClear: true, autoClearColor: true, autoClearDepth: true, autoClearStencil: true,
		toneMapping: THREE.ACESFilmicToneMapping, outputColorSpace: THREE.SRGBColorSpace,
		getRenderTarget: () => target,
		setRenderTarget( rt ) { target = rt; },
		getMRT: () => mrt,
		setMRT( m ) { mrt = m; },
		initRenderTarget() {},
		copyTextureToTexture() {},
		getDrawingBufferSize( v ) { return v.set( 64, 32 ); },
		render( scene ) { renders.push( { object: scene, target } ); },
		compute() {},
		compileComputeAsync( nodes ) { computes.push( ...( Array.isArray( nodes ) ? nodes : [ nodes ] ) ); return Promise.resolve(); },
		// ---- the internals Compile.ts builds through
		_compilationPromises: null,
		_currentRenderContext: null,
		_precompilationState: null,
		_createObjectPipeline() { throw new Error( 'three\'s own _createObjectPipeline: the bound compile did not stand in' ); },
		_renderContexts: { get: ( rt, m, depth, camera ) => context( rt, m, depth, camera ) },
		_objects: { get: ( object, material, scene, camera, lightsNode, renderContext ) => ( { object, material, context: renderContext } ) },
		_nodes: {
			getForRender: ( ro ) => {

				builds.push( { object: ro.object, material: ro.material, side: ro.material.side, target, mrt, contextDepth: ro.context.callDepth, toneMapping: r.toneMapping, vertexNode: ro.material.vertexNode ?? null } );
				return { updateBeforeNodes: ro.material.userData.before ?? [] };

			},
			updateForRender() {},
		},
		_geometries: { updateForRender() {} },
		_bindings: { updateForRender() {} },
		_pipelines: { getForRender() {} },
		compileAsync( object, camera ) {

			const ctx = context( target, mrt, 0 );
			r._currentRenderContext = ctx;
			r._precompilationState = { renderContext: ctx };
			const visit = ( o ) => {

				if ( ! o.visible ) return;
				if ( o.isMesh ) {

					// a transparent double-sided material draws back faces, then front faces
					if ( o.material.transparent && o.material.side === THREE.DoubleSide && ! o.material.forceSinglePass ) {

						o.material.side = THREE.BackSide;
						r._createObjectPipeline( o, o.material, null, camera, null, null, null, 'backSide' );
						o.material.side = THREE.FrontSide;
						r._createObjectPipeline( o, o.material, null, camera, null, null, null, null );
						o.material.side = THREE.DoubleSide;

					} else r._createObjectPipeline( o, o.material, null, camera, null, null, null, null );

				}
				for ( const child of o.children ) visit( child );

			};
			visit( object );
			r._precompilationState = null;
			return Promise.resolve();

		},
	};
	return r;

}

const quadOf = ( name, before = [] ) => {

	const material = new THREE.NodeMaterial();
	material.name = name;
	material.userData.before = before;
	return new THREE.QuadMesh( material );

};

export const checks = [

	[ 'warm: every compiled pass compiles once under its own binding, a conditional one too, and the binding is restored', async () => {

		const r = mockRenderer();
		const g = new FrameGraph( r, { sceneSamples: 1 } );
		let color = g.color( 'color', { size: RENDER } );
		let depth = g.depth( 'depth', { size: RENDER } );
		let fog = g.color( 'fog', { size: { of: 'render', divisor: 2 } } );
		let canvas = g.import( 'canvas', null, CANVAS );
		const scene = new THREE.Scene();
		const mesh = new THREE.Mesh( new THREE.BufferGeometry(), new THREE.MeshBasicNodeMaterial() );
		scene.add( mesh );
		const mrt = { id: 7, getBlendMode: () => new THREE.BlendMode() };
		g.addPass( 'opaque', 'scene', ( b ) => {

			color = b.write( color, { clear: true } );
			depth = b.depth( depth, { write: true, clear: true } );
			return { label: 'opaque scene', mrt, scene: ( f ) => f.scene, camera: ( f ) => f.camera };

		} );
		const fogQuad = quadOf( 'fog' );
		g.addPass( 'fog', 'quad', ( b ) => {

			b.read( depth );
			fog = b.write( fog );
			return { label: 'fog', when: () => false, quad: fogQuad };

		} );
		const output = new THREE.RenderPipeline( r );
		g.addPass( 'output', 'chain', ( b ) => {

			b.read( color );
			b.readOptional( fog );
			canvas = b.write( canvas );
			return { label: 'output', pipeline: output };

		} );
		g.compile();
		const outsideTarget = { uuid: 'outside' };
		r.setRenderTarget( outsideTarget );
		r.depth = true;
		const camera = new THREE.PerspectiveCamera();
		const warming = g.warm( { scene, camera } );
		assert.equal( g.warm( { scene, camera } ), warming, 'runs once' );
		assert.equal( r.getRenderTarget(), outsideTarget, 'the binding is restored before anything is awaited' );
		await warming;
		const of = ( name ) => r.builds.filter( ( b ) => b.material.name === name || b.object === mesh && name === 'mesh' );
		assert.equal( of( 'mesh' ).length, 1 );
		assert.equal( of( 'mesh' )[ 0 ].target, g.target( color ) );
		assert.equal( of( 'mesh' )[ 0 ].mrt, mrt, 'the pass\'s MRT is bound while it builds' );
		assert.equal( of( 'fog' ).length, 1, 'a pass whose `when` is false compiles too' );
		assert.equal( of( 'fog' )[ 0 ].target, g.target( fog ) );
		assert.ok( of( 'fog' )[ 0 ].vertexNode, 'a quad builds with the vertex node QuadMesh.render sets' );
		assert.equal( fogQuad.material.vertexNode, null, 'and gets its own back' );
		const out = r.builds.filter( ( b ) => b.material.name === 'RenderPipeline' );
		assert.equal( out.length, 1 );
		assert.equal( out[ 0 ].target, null, 'the output chain compiles for the canvas' );
		assert.equal( out[ 0 ].toneMapping, THREE.NoToneMapping, 'under the state its render() sets' );
		assert.deepEqual( g.warmStats.primed, [] );
		assert.equal( g.warmStats.passes, 3 );
		assert.equal( r.renders.length, 0, 'nothing rendered' );

	} ],

	[ 'warm: latents compile shown, a double-sided one as a copy per side; registered after the warm-up, at once', async () => {

		const r = mockRenderer();
		const g = new FrameGraph( r, { sceneSamples: 1 } );
		let color = g.color( 'color', { size: RENDER } );
		let canvas = g.import( 'canvas', null, CANVAS );
		const scene = new THREE.Scene();
		g.addPass( 'opaque', 'scene', ( b ) => {

			color = b.write( color, { clear: true } );
			return { label: 'opaque scene', scene: ( f ) => f.scene, camera: ( f ) => f.camera };

		} );
		g.addPass( 'output', 'callback', ( b ) => {

			b.read( color );
			canvas = b.write( canvas );
			return { label: 'output', run: () => {} };

		} );
		g.compile();
		const bolt = new THREE.Mesh( new THREE.BufferGeometry(), new THREE.MeshBasicNodeMaterial( { transparent: true, side: THREE.DoubleSide } ) );
		bolt.visible = false;
		const group = new THREE.Group();
		group.add( bolt );
		scene.add( group );
		const kernel = { isComputeNode: true };
		const early = g.latent( 'opaque', [ group ], [ kernel ] );
		// a pass the graph does not have (another variant): reported, never thrown at the page
		const warn = console.warn;
		console.warn = () => {};
		try {

			await g.latent( 'output', [ group ] );

		} finally {

			console.warn = warn;

		}
		await g.warm( { scene, camera: new THREE.PerspectiveCamera() } );
		await early;
		assert.match( g.warmStats.failed.join( ';' ), /latent\( 'output' \): the graph has no scene pass/, 'kept in the warm-up\'s failures' );
		const sides = r.builds.filter( ( b ) => b.object.geometry === bolt.geometry ).map( ( b ) => b.side );
		assert.deepEqual( sides, [ THREE.BackSide, THREE.FrontSide ], 'one copy per side, each built with its side' );
		assert.ok( r.builds.every( ( b ) => b.object !== bolt ), 'the double-sided mesh itself goes as its copies' );
		assert.equal( bolt.visible, false, 'visibility restored' );
		assert.equal( bolt.material.side, THREE.DoubleSide );
		assert.deepEqual( r.computes, [ kernel ] );
		assert.equal( r.builds[ 0 ].target, g.target( color ) );
		// late: compiled at once, under the pass's binding
		const spray = new THREE.Mesh( new THREE.BufferGeometry(), new THREE.MeshBasicNodeMaterial() );
		spray.visible = false;
		scene.add( spray );
		const before = r.builds.length;
		const late = g.latent( 'opaque', [ spray ] );
		assert.equal( r.builds.length, before + 1 );
		assert.equal( r.builds.at( - 1 ).object, spray );
		assert.equal( r.builds.at( - 1 ).target, g.target( color ) );
		await late;
		assert.equal( g.warmStats.latents, 2 );

	} ],

	[ 'warm: a bloom nested in a pass compiles a call depth down; what the walker cannot reach is primed once the extents are set, if it keeps no state', async () => {

		const r = mockRenderer();
		const g = new FrameGraph( r, { sceneSamples: 1 } );
		let display = g.color( 'display', { size: RENDER } );
		let canvas = g.import( 'canvas', null, CANVAS );
		const bloom = new BloomNode( texture( new THREE.Texture() ) );
		bloom.setup( { getSharedContext: () => ( {} ) } );
		// three's FSR1Node: out of the walker's reach, known to keep nothing between frames
		const stranger = { type: 'FSR1Node' };
		const chainQuad = quadOf( 'display', [ bloom ] );
		g.addPass( 'display', 'quad', ( b ) => {

			display = b.write( display );
			return { label: 'display', quad: chainQuad };

		} );
		const strangeQuad = quadOf( 'strange', [ stranger ] );
		let rendered = 0;
		strangeQuad.render = function ( renderer ) { if ( renderer === r ) rendered ++; else THREE.QuadMesh.prototype.render.call( this, renderer ); };
		g.addPass( 'output', 'quad', ( b ) => {

			b.read( display );
			canvas = b.write( canvas );
			return { label: 'output', quad: strangeQuad };

		} );
		g.compile();
		const warming = g.warm( {} );
		const nested = r.builds.find( ( b ) => b.material.name === 'Bloom_highPass' );
		assert.equal( nested.target, bloom._renderTargetBright, 'the nested pass compiles into its own target' );
		assert.equal( nested.contextDepth, 1, 'one call depth down, in the context its render draws in' );
		assert.equal( r.builds.filter( ( b ) => b.material.name.startsWith( 'Bloom_' ) ).length, 12, 'the high pass, ten blurs and the composite' );
		await Promise.resolve();
		await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
		assert.equal( rendered, 0, 'priming waits for the real extents' );
		g.setExtents( extents( 64, 32 ) );
		await warming;
		assert.equal( rendered, 1, 'the pass with a node the walker does not know is primed' );
		assert.deepEqual( g.warmStats.primed, [ 'output (FSR1Node)' ] );

		// a node that may keep state of its own (a history) is primed only when the pass's owner
		// resets what priming wrote
		for ( const invalidate of [ false, true ] ) {

			const r2 = mockRenderer();
			const g2 = new FrameGraph( r2, { sceneSamples: 1 } );
			let canvas2 = g2.import( 'canvas', null, CANVAS );
			const quad = quadOf( 'history', [ { type: 'TRAANode' } ] );
			let drawn = 0, reset = 0;
			quad.render = function ( renderer ) { if ( renderer === r2 ) drawn ++; else THREE.QuadMesh.prototype.render.call( this, renderer ); };
			g2.addPass( 'output', 'quad', ( b ) => {

				canvas2 = b.write( canvas2 );
				return { label: 'output', quad, ...( invalidate ? { invalidate: () => { reset ++; } } : {} ) };

			} );
			g2.compile();
			g2.setExtents( extents( 64, 32 ) );
			await g2.warm( {} );
			assert.equal( drawn, invalidate ? 1 : 0, invalidate ? 'primed, its owner invalidating it' : 'a node that may keep state is not primed' );
			assert.equal( reset, invalidate ? 1 : 0 );
			if ( ! invalidate ) assert.match( g2.warmStats.skipped.join( ';' ), /output: not primed, it may keep state \(TRAANode\)/ );

		}

	} ],

	[ 'warm and run: a chain of three\'s nodes (a bloom as a pass) runs their updateBefore with the renderer and compiles their own passes at the top level', async () => {

		const r = mockRenderer();
		const g = new FrameGraph( r, { sceneSamples: 1 } );
		// a bloom set up without a material holding it, as a chain pass sets up three's display nodes
		const bloom = new BloomNode( texture( new THREE.Texture() ) );
		bloom.setup( { getSharedContext: () => ( {} ) } );
		const output = g.import( 'bloom', bloom._renderTargetsHorizontal[ 0 ], { of: 'render', scale: 0.5, min: 1 } );
		let canvas = g.import( 'canvas', null, CANVAS );
		const frames = [];
		bloom.updateBefore = ( frame ) => { frames.push( frame ); };
		let out;
		g.addPass( 'bloom', 'chain', ( b ) => {

			out = b.write( output );
			return { label: 'bloom', nodes: [ bloom ] };

		} );
		g.addPass( 'output', 'callback', ( b ) => {

			b.read( out );
			canvas = b.write( canvas );
			return { label: 'output', run: () => {} };

		} );
		g.compile();
		g.setExtents( extents( 64, 32 ) );
		await g.warm( {} );
		const draws = r.builds.filter( ( x ) => x.material.name.startsWith( 'Bloom_' ) );
		// the high pass, two blurs per mip (five), the composite
		assert.deepEqual( draws.map( ( x ) => x.material.name ), [ 'Bloom_highPass', ...Array( 10 ).fill( 'Bloom_separable' ), 'Bloom_comp' ] );
		assert.ok( draws.every( ( x ) => x.contextDepth === 0 ), 'at the top level, where the pass renders them' );
		assert.equal( draws[ 0 ].target, bloom._renderTargetBright );
		assert.equal( draws.at( - 1 ).target, bloom._renderTargetsHorizontal[ 0 ], 'the composite into the imported result' );
		assert.deepEqual( g.warmStats.primed, [] );
		assert.deepEqual( g.warmStats.failed, [] );
		g.execute( {} );
		assert.equal( frames.length, 1, 'the pass runs the node once' );
		assert.equal( frames[ 0 ].renderer, r );
		assert.equal( g.describe().passes.find( ( p ) => p.name === 'bloom' ).kind, 'chain' );

	} ],

	[ 'warm: priming leaves no persistent resource written (invalidated, or not primed), and prime: false turns it off', async () => {

		for ( const prime of [ true, false ] ) {

			const r = mockRenderer();
			const g = new FrameGraph( r, { sceneSamples: 1, prime } );
			let bank = g.color( 'bank', { size: { of: 'fixed', width: 8, height: 8 } }, true );
			let other = g.color( 'other', { size: { of: 'fixed', width: 8, height: 8 } }, true );
			let canvas = g.import( 'canvas', null, CANVAS );
			const stranger = { type: 'StrangeNode' };
			let invalidated = 0;
			const renders = { bank: 0, other: 0 };
			const bankQuad = quadOf( 'bank', [ stranger ] ), otherQuad = quadOf( 'other', [ stranger ] );
			bankQuad.render = function ( renderer ) { if ( renderer === r ) renders.bank ++; else THREE.QuadMesh.prototype.render.call( this, renderer ); };
			otherQuad.render = function ( renderer ) { if ( renderer === r ) renders.other ++; else THREE.QuadMesh.prototype.render.call( this, renderer ); };
			g.addPass( 'bank', 'quad', ( b ) => {

				bank = b.write( bank );
				return { label: 'bank', quad: bankQuad, invalidate: () => { invalidated ++; } };

			} );
			g.addPass( 'other', 'quad', ( b ) => {

				other = b.write( other );
				return { label: 'other', quad: otherQuad };

			} );
			g.addPass( 'output', 'callback', ( b ) => {

				b.read( bank );
				b.read( other );
				canvas = b.write( canvas );
				return { label: 'output', run: () => {} };

			} );
			g.compile();
			g.setExtents( extents( 64, 32 ) );
			await g.warm( {} );
			if ( prime ) {

				assert.deepEqual( renders, { bank: 1, other: 0 }, 'a pass writing a persistent resource is primed only with an invalidate' );
				assert.equal( invalidated, 1 );
				assert.equal( g.historyValid( bank ), false, 'its history is reset' );
				assert.match( g.warmStats.skipped.join( ';' ), /other: not primed, it writes other/ );

			} else {

				assert.deepEqual( renders, { bank: 0, other: 0 } );
				assert.equal( invalidated, 0 );
				assert.equal( g.warmStats.skipped.filter( ( s ) => /fgPrime=0/.test( s ) ).length, 2 );

			}

		}

	} ],

];
