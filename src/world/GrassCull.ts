import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, uniform, storage, workgroupArray, workgroupBarrier, workgroupId, localId, uint, select, length, dot, min, max,
} from 'three/tsl';
import { TEMPORAL } from '../post/Antialiasing.ts';
import { jitter } from '../post/Jitter.ts';

// GPU-driven culling for the meadow's tufts. Every tuft of every batch lives in one set of storage
// buffers (instance transform, colour, the ground inputs, the planting anchor and a bounding
// sphere). Before the view camera draws the meadow, a compute pass tests each tuft's sphere
// against the view frustum (and folds the thin extra tufts away beyond their fold distance, where
// the vertex stage would collapse them to a point anyway), and writes the indices of the tufts
// that pass, in their original order, plus each batch's indirect draw arguments. The draw then
// runs the vertex stage only for those tufts. The compaction is a scan, not an atomic append: the
// surviving tufts keep the order every tuft drew in before, so depth ties and the alpha-to-coverage
// result are those of the full draw, and a paused frame repeats exactly.
//
// Two dispatches: the first counts each workgroup's visible tufts, the second sums the counts of
// the batch's earlier workgroups, scans its own and scatters. Each batch is padded to whole
// workgroups, so no workgroup spans two batches.
//
// The meadow is one pool (chunk design, section 8): a batch per kind (lawn, tussocks, the thin
// extra tufts) holds every chunk's tufts in the chunks' order ( cj, ci ), as the anchors come
// (ChunkMerge.ts), each drawn in one draw. The buffers hold a capacity, the next power of two of
// the slots the batches fill; the dispatches cover the filled workgroups, and the slots past them
// are never visible. A grown island's meadow (World growth, Growth.ts) is a new pool: its arrays
// are filled in steps (`poolSteps`) and its buffers made and uploaded ahead (`GrassCull.buffers`),
// and `setPool` points every storage node at them (one node per buffer, type and access: `node`):
// new bind groups, no pipeline (AGENTS.md, tools/verify-storage-realloc.mjs). The kernels read
// the batches' bounds, the last workgroup and the scatter's passes from uniforms, and every batch
// keeps its place even while empty (an empty batch starts where the next one does and writes no
// arguments), so no pool changes their code.
//
// Rules:
// - Each tuft's sphere is padded for the widening's 31 half widths, the sway and standing water's
//   sink, and by twice its origin's offset from the sphere's centre, since the wind's bend turns
//   every vertex about that origin.
// - The dispatch is skipped while the view and the blade selection are unchanged.
// - Without the prepass, or with coverage kept in its shaded draw, the image is that of a draw of
//   every tuft to the byte; behind the prepass's opaque shaded draw a few isolated meadow pixels
//   differ from it (the set depends on the drawn instance list).
// - Indirect arguments are set on a batch's geometry for its own draw only: other draws over the
//   same geometry (the rain's collision proxies, orthographic cameras) draw every tuft.
//   `flags.grassCull = false` draws every tuft through the same storage path.
// - A material that applies instancing itself from storage buffers must hold the placed position
//   in a variable (`toVar`), as three's instancing assigns it to `positionLocal`: an inline
//   expression rounds differently and flips a few hundred edge samples. `instanceColor` multiplies
//   the diffuse colour whenever the object has a truthy `instanceColor`: assign it in the vertex
//   stage.

type UintMax = ( a: THREE.Node<'uint'>, b: THREE.Node<'uint'> ) => THREE.Node<'uint'>;

const GROUP = 256;
const LOG2_GROUP = 8;
// A tuft's widened blades reach out by at most this many times their half width (`MAX_WIDEN` times
// the largest blade gain, 4: a far tuft keeps a quarter of its blades, less the blade itself), see
// `pixelWideBlade` and `tuftLod` in Grass.ts.
export const WIDEN_REACH = 31;
// Slack (m) for rounding, kept at the width it had for the old global-sine sway (a few
// centimetres at the tips in a gale): a smaller pad changes the visible list. The wind's bend (`bendBlade` in Grass.ts) keeps every vertex at its
// distance from the tuft's origin, so it stays inside the sphere when that is padded by twice
// the origin's distance from the sphere's centre (see below), whatever the wind.
const SWAY_PAD = 0.2;
// The thin tufts are culled a little past their fold, so the test never takes a tuft the vertex
// stage would still draw a sliver of.
const FOLD_PAD = 0.01;

export interface CullTuft {
	m: THREE.Matrix4; col: THREE.Color; visibility: number; soil: number; cover: number; rimEdge: number; thin: number;
	top: number; origin: THREE.Vector3;
}

export interface CullBatchInput { tufts: CullTuft[]; geometry: THREE.BufferGeometry; halfWidth: number }

export interface CullRange {
	/** First slot of the batch in the shared buffers (and in the visible list). */
	start: number;
	count: number;
	groupStart: number;
	groupEnd: number;
	/** The batch's index count for this draw (its blade selection), written into its arguments. */
	indexCount: THREE.UniformNode<'uint', number>;
	/** Byte offset of the batch's five indirect arguments. */
	indirectOffset: number;
}

/** A pool's contents: the slots (a power of two of workgroups), the workgroups its batches fill,
 * each batch's range, and the per-slot arrays the storage buffers take. */
export interface CullPool {
	slots: number;
	groups: number;
	ranges: { start: number; count: number; groupStart: number; groupEnd: number }[];
	matrices: Float32Array; colors: Float32Array; ground: Float32Array; origins: Float32Array; spheres: Float32Array;
}

/** A pool's storage buffers, made ahead of `setPool` so they can be uploaded before the frame that
 * takes them (`visible` holds every slot's own index, `counts` a count per workgroup). */
export interface CullBuffers {
	matrices: THREE.StorageBufferAttribute; colors: THREE.StorageBufferAttribute; ground: THREE.StorageBufferAttribute;
	origins: THREE.StorageBufferAttribute; spheres: THREE.StorageBufferAttribute; visible: THREE.StorageBufferAttribute;
	counts: THREE.StorageBufferAttribute;
}

/** The pool's arrays for `batches`, filled `per` tufts at a step (a generator, so the growth can
 * spread the work over idle time: World growth, Growth.ts); `fillPool` runs it to the end. The
 * result is the same however it is stepped. */
export function* poolSteps( batches: CullBatchInput[], per = Infinity ): Generator<void, CullPool> {

	const ranges: CullPool[ 'ranges' ] = [];
	let slot = 0;
	for ( const b of batches ) {

		const count = b.tufts.length;
		const groups = Math.ceil( count / GROUP );
		ranges.push( { start: slot, count, groupStart: slot / GROUP, groupEnd: slot / GROUP + groups } );
		slot += groups * GROUP;

	}
	const groups = Math.max( slot, GROUP ) / GROUP;
	const n = 2 ** Math.ceil( Math.log2( groups ) ) * GROUP;
	const matrices = new Float32Array( n * 16 ), colors = new Float32Array( n * 4 ), ground = new Float32Array( n * 12 );
	const origins = new Float32Array( n * 4 ), spheres = new Float32Array( n * 4 ).fill( - 1 );
	let done = 0;
	for ( let k = 0; k < batches.length; k ++ ) {

		const b = batches[ k ], range = ranges[ k ];
		b.geometry.computeBoundingBox();
		_box.copy( b.geometry.boundingBox! );
		for ( let j = 0; j < b.tufts.length; j ++ ) {

			const t = b.tufts[ j ], i = range.start + j;
			t.m.toArray( matrices, i * 16 );
			colors[ i * 4 ] = t.col.r; colors[ i * 4 + 1 ] = t.col.g; colors[ i * 4 + 2 ] = t.col.b;
			const e = t.m.elements;
			// x: sky visibility, y: soil cover, z: rim cover, w: rim edge (1 on the plateau's
			// outer rim, where blades stand against the sea and stay narrower: the opaque
			// pass's MSAA edge pixels there resolve against the sky-coloured clear, so every
			// partly covered pixel a widened blade adds shows as a pale fringe over the sea);
			// then the instance's local x axis with the thin flag (1 for the extra tufts that
			// fold away with distance), and its local z axis. A blade's width lies in the
			// plane of those axes: the vertex stage keeps thin blades a minimum width on screen
			// in world space.
			ground.set( [ t.visibility, t.soil, t.cover, t.rimEdge, e[ 0 ], e[ 1 ], e[ 2 ], t.thin, e[ 8 ], e[ 9 ], e[ 10 ], 0 ], i * 12 );
			t.origin.toArray( origins, i * 4 );
			origins[ i * 4 + 3 ] = t.top;
			// The tuft's box in world space, extended down by its own height (standing water
			// sinks the blades below their anchor), then padded for the widening and the sway.
			_world.makeEmpty();
			for ( let c = 0; c < 8; c ++ ) {

				_corner.set( c & 1 ? _box.max.x : _box.min.x, c & 2 ? _box.max.y : _box.min.y, c & 4 ? _box.max.z : _box.min.z ).applyMatrix4( t.m );
				_world.expandByPoint( _corner );

			}
			_world.min.y -= _world.max.y - _world.min.y;
			_world.getBoundingSphere( _sphere );
			const axisScale = Math.max( Math.hypot( e[ 0 ], e[ 1 ], e[ 2 ] ), Math.hypot( e[ 8 ], e[ 9 ], e[ 10 ] ) );
			_sphere.center.toArray( spheres, i * 4 );
			// Every vertex lies in the box, so within the box's radius plus the origin's offset
			// from its centre of the origin; a vertex turned about the origin stays that close to
			// it, so within the radius plus twice the offset of the centre.
			const bend = 2 * _sphere.center.distanceTo( t.origin );
			spheres[ i * 4 + 3 ] = _sphere.radius + bend + WIDEN_REACH * b.halfWidth * axisScale + SWAY_PAD;
			if ( ++ done % per === 0 ) {

				yield;
				// (another pool's steps may have run meanwhile)
				_box.copy( b.geometry.boundingBox! );

			}

		}

	}
	// A batch's padding to whole workgroups repeats its first tuft's transform: never drawn (its
	// sphere is never visible), but three's InstancedMesh box reads the matrices from slot 0 up to a
	// batch's count, and a zero matrix there divides by a zero w (a NaN box: Water.ts's reflection
	// check). Slots past the last batch are never read.
	for ( const range of ranges ) for ( let i = range.start + range.count; i < range.groupEnd * GROUP && range.count > 0; i ++ ) matrices.copyWithin( i * 16, range.start * 16, range.start * 16 + 16 );
	return { slots: n, groups, ranges, matrices, colors, ground, origins, spheres };

}

/** `poolSteps` run to the end. */
export function fillPool( batches: CullBatchInput[] ): CullPool {

	const steps = poolSteps( batches );
	for ( ;; ) {

		const next = steps.next();
		if ( next.done ) return next.value;

	}

}

const _box = new THREE.Box3(), _corner = new THREE.Vector3(), _world = new THREE.Box3(), _sphere = new THREE.Sphere();
const _frustum = new THREE.Frustum(), _projScreen = new THREE.Matrix4(), _viewInverse = new THREE.Matrix4(), _camera = new THREE.Vector3();
const _padded = new THREE.Matrix4(), _size = new THREE.Vector2();

// Under the temporal modes the view camera draws the meadow with its projection jittered by up to
// half a render pixel (Jitter.ts), a different one every frame. Keyed and culled by it, the cull
// would dispatch every frame of a still view. It takes the unjittered projection instead, widened
// by one render pixel on each side: the jittered frustum lies inside it whatever the offset. Any
// other camera keeps its own projection. Null when `camera` is not the jittered view camera.
function unjitteredPadded( renderer: THREE.Renderer, camera: THREE.Camera ): THREE.Matrix4 | null {

	const q = jitter.uniforms.unjitteredProjection.value.elements, p = camera.projectionMatrix.elements;
	const d = jitter.uniforms.ndc.value;
	// The jitter adds a multiple of the projection's last row to its first two (`Jitter.begin`): for
	// a perspective camera only elements 8 and 9 move, by the offset in NDC.
	for ( let i = 0; i < 16; i ++ ) if ( i !== 8 && i !== 9 && p[ i ] !== q[ i ] ) return null;
	if ( Math.abs( p[ 8 ] - q[ 8 ] ) > Math.abs( d.x ) + 1e-9 || Math.abs( p[ 9 ] - q[ 9 ] ) > Math.abs( d.y ) + 1e-9 ) return null;
	const target = renderer.getRenderTarget();
	if ( target ) _size.set( target.width, target.height );
	else renderer.getDrawingBufferSize( _size );
	// Scaling the clip x (y) row by w / ( w + 2 ) moves the frustum's sides out by a pixel (2 / w in NDC).
	const sx = _size.x / ( _size.x + 2 ), sy = _size.y / ( _size.y + 2 );
	const e = _padded.copy( jitter.uniforms.unjitteredProjection.value ).elements;
	for ( const i of [ 0, 4, 8, 12 ] ) e[ i ] *= sx;
	for ( const i of [ 1, 5, 9, 13 ] ) e[ i ] *= sy;
	return _padded;

}

type Buffer = keyof CullBuffers;
type StorageType = 'uint' | 'vec4' | 'mat4';
type Storage<T extends StorageType = StorageType> = THREE.StorageBufferNode<T>;
// (the map holds every type; each node is read back as the type it was made with)
type AnyStorage = { toReadOnly(): unknown; value: THREE.StorageBufferAttribute };

export class GrassCull {

	/** The buffers' slots: the capacity, a power of two. */
	slots: number;
	/** The workgroups dispatched: those the batches fill. */
	groups: number;
	readonly ranges: CullRange[] = [];
	readonly indirect: THREE.IndirectStorageBufferAttribute;
	private buffers: CullBuffers;
	// every storage node over the pool's buffers, by buffer, type and access: `setPool` points them
	// at new buffers (a new bind group, no pipeline: AGENTS.md)
	private readonly nodes = new Map<string, { buffer: Buffer; node: AnyStorage }>();
	// the batches' bounds, as the kernels read them (uniforms, so a new pool builds no pipeline)
	private readonly bounds: { start: THREE.UniformNode<'uint', number>; groupStart: THREE.UniformNode<'uint', number>; groupEnd: THREE.UniformNode<'uint', number> }[];
	private readonly lastGroup = uniform( 0, 'uint' );
	// the scatter's passes over a batch's earlier workgroups: its longest batch's workgroups / GROUP
	private readonly sumPasses = uniform( 0, 'uint' );
	private readonly dispatch: [ number, number, number ] = [ 1, 1, 1 ];
	private readonly planes = Array.from( { length: 5 }, () => uniform( new THREE.Vector4() ) );
	private readonly cameraPosition = uniform( new THREE.Vector3() );
	private readonly kernels: THREE.ComputeNode[];
	private readonly lastKey = new Float64Array( 16 + 3 + 8 ).fill( NaN );
	/** Debug diagnostics: views culled (dispatches) and updates skipped as unchanged, since load. */
	readonly stats = { dispatches: 0, skipped: 0 };

	constructor( batches: CullBatchInput[], private readonly thinFar: THREE.UniformNode<'float', number> ) {

		const pool = fillPool( batches );
		this.slots = pool.slots;
		this.groups = pool.groups;
		this.buffers = GrassCull.buffers( pool );
		this.indirect = new THREE.IndirectStorageBufferAttribute( new Uint32Array( batches.length * 5 ), 1 );
		this.bounds = batches.map( () => ( { start: uniform( 0, 'uint' ), groupStart: uniform( 0, 'uint' ), groupEnd: uniform( 0, 'uint' ) } ) );
		pool.ranges.forEach( ( r, k ) => this.ranges.push( { ...r, indexCount: uniform( 0, 'uint' ), indirectOffset: k * 20 } ) );
		this.setRanges( pool );
		this.kernels = this.buildKernels();

	}

	/** The storage buffers of `pool`, for upload before `setPool` takes them. */
	static buffers( pool: CullPool ): CullBuffers {

		const n = pool.slots, visible = new Uint32Array( n );
		for ( let i = 0; i < n; i ++ ) visible[ i ] = i;
		return {
			matrices: new THREE.StorageBufferAttribute( pool.matrices, 16 ),
			colors: new THREE.StorageBufferAttribute( pool.colors, 4 ),
			ground: new THREE.StorageBufferAttribute( pool.ground, 4 ),
			origins: new THREE.StorageBufferAttribute( pool.origins, 4 ),
			spheres: new THREE.StorageBufferAttribute( pool.spheres, 4 ),
			visible: new THREE.StorageBufferAttribute( visible, 1 ),
			counts: new THREE.StorageBufferAttribute( new Uint32Array( n / GROUP ), 1 ),
		};

	}

	get matrices(): THREE.StorageBufferAttribute { return this.buffers.matrices; }
	get colors(): THREE.StorageBufferAttribute { return this.buffers.colors; }

	/** A storage node over one of the pool's buffers (one per buffer, type and access), which
	 * follows the pool when `setPool` replaces it. */
	node<T extends StorageType>( buffer: Buffer, type: T, readOnly = false ): Storage<T> {

		const key = `${ buffer } ${ type } ${ readOnly }`;
		let entry = this.nodes.get( key );
		if ( ! entry ) {

			const attribute = this.buffers[ buffer ];
			const node = storage( attribute, type, attribute.count ) as unknown as AnyStorage;
			if ( readOnly ) node.toReadOnly();
			this.nodes.set( key, entry = { buffer, node } );

		}
		return entry.node as unknown as Storage<T>;

	}

	/** Takes `pool` (the same batches in the same order), with its buffers made by `buffers`: the
	 * nodes are pointed at them, the bounds and the dispatch follow, and the next update culls
	 * again. Returns the buffers it replaced, to dispose of once nothing draws with them. */
	setPool( pool: CullPool, buffers: CullBuffers = GrassCull.buffers( pool ) ): CullBuffers {

		const old = this.buffers;
		this.buffers = buffers;
		for ( const { buffer, node } of this.nodes.values() ) node.value = buffers[ buffer ];
		this.slots = pool.slots;
		this.groups = pool.groups;
		pool.ranges.forEach( ( r, k ) => Object.assign( this.ranges[ k ], r ) );
		this.setRanges( pool );
		this.invalidate();
		return old;

	}

	private setRanges( pool: CullPool ): void {

		const args = this.indirect.array as Uint32Array;
		pool.ranges.forEach( ( r, k ) => {

			const b = this.bounds[ k ];
			b.start.value = r.start;
			b.groupStart.value = r.groupStart;
			b.groupEnd.value = r.groupEnd;
			// (a batch's arguments are the scatter's from its first dispatch on; an empty batch's stay 0)
			args.fill( 0, k * 5, k * 5 + 5 );
			args[ k * 5 + 1 ] = r.count;

		} );
		this.indirect.needsUpdate = true;
		this.lastGroup.value = pool.groups - 1;
		this.sumPasses.value = Math.ceil( Math.max( ...pool.ranges.map( ( r ) => r.groupEnd - r.groupStart ) ) / GROUP );
		this.dispatch[ 0 ] = pool.groups;

	}

	private buildKernels(): THREE.ComputeNode[] {

		const spheres = this.node( 'spheres', 'vec4', true );
		const origins = this.node( 'origins', 'vec4', true );
		const ground = this.node( 'ground', 'vec4', true );
		const visible = this.node( 'visible', 'uint' );
		const counts = this.node( 'counts', 'uint' );
		const args = storage( this.indirect, 'uint', this.ranges.length * 5 );
		const planes = this.planes, cameraPosition = this.cameraPosition, thinFar = this.thinFar, bounds = this.bounds;
		// Per workgroup: its batch's first workgroup or first slot. The batches lie in order, so the
		// last batch starting at or before the workgroup holds it (an empty batch starts where the
		// next one does, and loses to it).
		const pick = ( g: THREE.Node<'uint'>, value: ( b: typeof bounds[ number ] ) => THREE.Node<'uint'> ) => {

			let node: THREE.Node<'uint'> = value( bounds[ 0 ] );
			for ( let k = 1; k < bounds.length; k ++ ) node = select( g.greaterThanEqual( bounds[ k ].groupStart ), value( bounds[ k ] ), node );
			return node;

		};

		const isVisible = ( gi: THREE.Node<'uint'> ) => {

			const s = spheres.element( gi ).toVar();
			let inside = s.w.greaterThanEqual( 0 );
			for ( const p of planes ) inside = inside.and( dot( p.xyz, s.xyz ).add( p.w ).greaterThanEqual( s.w.negate() ) );
			// the thin extra tufts have folded into their roots beyond thinFar
			const o = origins.element( gi ).xyz;
			const folded = ground.element( gi.mul( 3 ).add( 1 ) ).w.greaterThan( 0.5 ).and( length( cameraPosition.sub( o ) ).greaterThanEqual( thinFar.add( FOLD_PAD ) ) );
			return select( inside.and( folded.not() ), uint( 1 ), uint( 0 ) );

		};
		// Inclusive scan of one flag per thread over the workgroup (Hillis-Steele, ping-ponged
		// between two arrays so each step needs one barrier). Returns the array holding the result.
		const scan = ( flag: THREE.Node<'uint'> ) => {

			const lanes = [ workgroupArray( 'uint', GROUP ), workgroupArray( 'uint', GROUP ) ] as unknown as { element: ( i: THREE.Node<'uint'> ) => THREE.Node<'uint'> }[];
			const i = localId.x;
			lanes[ 0 ].element( i ).assign( flag );
			for ( let s = 0; s < LOG2_GROUP; s ++ ) {

				workgroupBarrier();
				const from = lanes[ s & 1 ], to = lanes[ ( s + 1 ) & 1 ];
				const off = 1 << s;
				const before = select( i.greaterThanEqual( uint( off ) ), from.element( ( max as unknown as UintMax )( i, uint( off ) ).sub( off ) ), uint( 0 ) );
				to.element( i ).assign( from.element( i ).add( before ) );

			}
			workgroupBarrier();
			return lanes[ LOG2_GROUP & 1 ];

		};

		const count = Fn( () => {

			const g = workgroupId.x, i = localId.x;
			const result = scan( isVisible( g.mul( GROUP ).add( i ) ) );
			If( i.equal( uint( GROUP - 1 ) ), () => {

				counts.element( g ).assign( result.element( uint( GROUP - 1 ) ) );

			} );

		} )().computeKernel( [ GROUP ] );

		const scatter = Fn( () => {

			const g = workgroupId.x, i = localId.x;
			const gi = g.mul( GROUP ).add( i );
			const flag = isVisible( gi ).toVar();
			const result = scan( flag );
			const inclusive = result.element( i ).toVar();
			const total = result.element( uint( GROUP - 1 ) ).toVar();
			// the visible tufts of the batch's earlier workgroups
			const first = pick( g, ( b ) => b.groupStart ).toVar();
			const partial = uint( 0 ).toVar();
			Loop( { start: uint( 0 ), end: this.sumPasses, type: 'uint', condition: '<' }, ( { i: pass } ) => {

				const j = first.add( i ).add( pass.mul( GROUP ) );
				partial.addAssign( select( j.lessThan( g ), counts.element( ( min as unknown as UintMax )( j, this.lastGroup ) ), uint( 0 ) ) );

			} );
			const sum = workgroupArray( 'uint', GROUP ) as unknown as { element: ( i: THREE.Node<'uint'> ) => THREE.Node<'uint'> };
			sum.element( i ).assign( partial );
			for ( let s = GROUP >> 1; s >= 1; s >>= 1 ) {

				workgroupBarrier();
				If( i.lessThan( uint( s ) ), () => {

					sum.element( i ).addAssign( sum.element( i.add( s ) ) );

				} );

			}
			workgroupBarrier();
			const offset = sum.element( uint( 0 ) ).toVar();
			If( flag.equal( 1 ), () => {

				visible.element( pick( g, ( b ) => b.start ).add( offset ).add( inclusive ).sub( 1 ) ).assign( gi );

			} );
			// The batch's last workgroup writes its draw arguments: index count, instance count
			// (first index, base vertex and first instance stay 0). An empty batch has none.
			bounds.forEach( ( b, k ) => {

				If( g.add( 1 ).equal( b.groupEnd ).and( b.groupEnd.greaterThan( b.groupStart ) ).and( i.equal( 0 ) ), () => {

					args.element( uint( k * 5 ) ).assign( this.ranges[ k ].indexCount );
					args.element( uint( k * 5 + 1 ) ).assign( offset.add( total ) );

				} );

			} );

		} )().computeKernel( [ GROUP ] );

		for ( const kernel of [ count, scatter ] ) {

			// (the same array, so a new pool's size reaches both: an array is read at each dispatch,
			// never part of the pipeline)
			kernel.dispatchSize = this.dispatch;
			kernel.setName( kernel === count ? 'Grass.CullCount' : 'Grass.CullScatter' );

		}
		return [ count, scatter ];

	}

	/** Cull for `camera` unless the last dispatch was for the same view and the same draws. The
	 * caller has set every batch's `indexCount`. */
	update( renderer: THREE.Renderer, camera: THREE.Camera ): void {

		const key = this.lastKey;
		const projection = ( TEMPORAL ? unjitteredPadded( renderer, camera ) : null ) ?? camera.projectionMatrix;
		const e = camera.matrixWorld.elements, p = projection.elements;
		let same = true;
		const check = ( i: number, v: number ) => {

			if ( key[ i ] !== v ) {

				key[ i ] = v;
				same = false;

			}

		};
		for ( let i = 0; i < 16; i ++ ) check( i, e[ i ] );
		check( 16, p[ 0 ] ); check( 17, p[ 5 ] ); check( 18, p[ 8 ] );
		check( 19, p[ 9 ] ); check( 20, p[ 10 ] ); check( 21, p[ 14 ] );
		check( 22, this.thinFar.value );
		this.ranges.forEach( ( r, k ) => check( 23 + k, r.indexCount.value ) );
		if ( same ) {

			this.stats.skipped ++;
			return;

		}
		this.stats.dispatches ++;
		_projScreen.multiplyMatrices( projection, _viewInverse.copy( camera.matrixWorld ).invert() );
		_frustum.setFromProjectionMatrix( _projScreen, camera.coordinateSystem, camera.reversedDepth );
		// left, right, bottom, top, near: the meadow never reaches the far plane
		for ( let k = 0; k < 4; k ++ ) this.writePlane( k, _frustum.planes[ k ] );
		this.writePlane( 4, _frustum.planes[ 5 ] );
		this.cameraPosition.value.copy( _camera.setFromMatrixPosition( camera.matrixWorld ) );
		renderer.compute( this.kernels );

	}

	/** Forget the last view: the next update dispatches again. */
	invalidate(): void {

		this.lastKey.fill( NaN );

	}

	private writePlane( k: number, plane: THREE.Plane ): void {

		this.planes[ k ].value.set( plane.normal.x, plane.normal.y, plane.normal.z, plane.constant );

	}

}

/** The vertex stage's view of the culled buffers: `index` is the drawn tuft's slot. */
export function cullInputs( cull: GrassCull, index: THREE.Node<'uint'> ) {

	const ground = cull.node( 'ground', 'vec4', true );
	return {
		matrix: cull.node( 'matrices', 'mat4', true ).element( index ),
		color: cull.node( 'colors', 'vec4', true ).element( index ).xyz,
		ground: ( k: number ) => ground.element( index.mul( 3 ).add( k ) ),
		origin: cull.node( 'origins', 'vec4', true ).element( index ),
	};

}
