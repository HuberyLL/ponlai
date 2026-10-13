import * as THREE from 'three/webgpu';
import {
	Fn, If, uniform, storage, workgroupArray, workgroupBarrier, workgroupId, localId, uint, select, length, dot, min, max,
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
// the slots the batches fill, so a grown island's meadow can be written into them in place (a
// rewrite calls `invalidate`); the dispatches cover the filled workgroups, and the slots past them
// are never visible. Outgrowing the capacity takes new buffers, set as the storage nodes' `value`:
// new bind groups, no pipeline (AGENTS.md, tools/verify-storage-realloc.mjs). The kernels take the
// batches' bounds as constants: contents that move them need those as uniforms first.
//
// Rules:
// - Each tuft's sphere is padded for the widening's 15 half widths, the sway and standing water's
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
// the largest blade gain, 16 / 8, less the blade itself), see `pixelWideBlade` in Grass.ts.
export const WIDEN_REACH = 15;
// Slack (m) for the old global-sine sway (`flags.windLegacy`: a few centimetres at the tips in a
// gale) and rounding. The wind's bend (`bendBlade` in Grass.ts) keeps every vertex at its
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

export class GrassCull {

	/** The buffers' slots: the capacity, a power of two. */
	readonly slots: number;
	/** The workgroups dispatched: those the batches fill. */
	readonly groups: number;
	readonly ranges: CullRange[] = [];
	readonly matrices: THREE.StorageBufferAttribute;
	readonly colors: THREE.StorageBufferAttribute;
	readonly ground: THREE.StorageBufferAttribute;
	readonly origins: THREE.StorageBufferAttribute;
	readonly visible: THREE.StorageBufferAttribute;
	readonly indirect: THREE.IndirectStorageBufferAttribute;
	private readonly spheres: THREE.StorageBufferAttribute;
	private readonly counts: THREE.StorageBufferAttribute;
	private readonly planes = Array.from( { length: 5 }, () => uniform( new THREE.Vector4() ) );
	private readonly cameraPosition = uniform( new THREE.Vector3() );
	private readonly kernels: THREE.ComputeNode[];
	private readonly lastKey = new Float64Array( 16 + 3 + 8 ).fill( NaN );
	/** Debug diagnostics: views culled (dispatches) and updates skipped as unchanged, since load. */
	readonly stats = { dispatches: 0, skipped: 0 };

	constructor( batches: CullBatchInput[], private readonly thinFar: THREE.UniformNode<'float', number> ) {

		let slot = 0;
		for ( const b of batches ) {

			const count = b.tufts.length;
			const groups = Math.ceil( count / GROUP );
			this.ranges.push( { start: slot, count, groupStart: slot / GROUP, groupEnd: slot / GROUP + groups, indexCount: uniform( 0, 'uint' ), indirectOffset: this.ranges.length * 20 } );
			slot += groups * GROUP;

		}
		this.groups = Math.max( slot, GROUP ) / GROUP;
		this.slots = 2 ** Math.ceil( Math.log2( this.groups ) ) * GROUP;
		const n = this.slots;
		const matrices = new Float32Array( n * 16 ), colors = new Float32Array( n * 4 ), ground = new Float32Array( n * 12 );
		const origins = new Float32Array( n * 4 ), spheres = new Float32Array( n * 4 ).fill( - 1 ), visible = new Uint32Array( n );
		for ( let i = 0; i < n; i ++ ) visible[ i ] = i;
		const args = new Uint32Array( batches.length * 5 );
		batches.forEach( ( b, k ) => {

			const range = this.ranges[ k ];
			b.geometry.computeBoundingBox();
			_box.copy( b.geometry.boundingBox! );
			args[ k * 5 + 1 ] = range.count;
			b.tufts.forEach( ( t, j ) => {

				const i = range.start + j;
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

			} );

		} );
		this.matrices = new THREE.StorageBufferAttribute( matrices, 16 );
		this.colors = new THREE.StorageBufferAttribute( colors, 4 );
		this.ground = new THREE.StorageBufferAttribute( ground, 4 );
		this.origins = new THREE.StorageBufferAttribute( origins, 4 );
		this.spheres = new THREE.StorageBufferAttribute( spheres, 4 );
		this.visible = new THREE.StorageBufferAttribute( visible, 1 );
		this.counts = new THREE.StorageBufferAttribute( new Uint32Array( n / GROUP ), 1 );
		this.indirect = new THREE.IndirectStorageBufferAttribute( args, 1 );
		this.kernels = this.buildKernels();

	}

	private buildKernels(): THREE.ComputeNode[] {

		const n = this.slots;
		const spheres = storage( this.spheres, 'vec4', n ).toReadOnly();
		const origins = storage( this.origins, 'vec4', n ).toReadOnly();
		const ground = storage( this.ground, 'vec4', n * 3 ).toReadOnly();
		const visible = storage( this.visible, 'uint', n );
		const counts = storage( this.counts, 'uint', n / GROUP );
		const args = storage( this.indirect, 'uint', this.ranges.length * 5 );
		const planes = this.planes, cameraPosition = this.cameraPosition, thinFar = this.thinFar;
		const ranges = this.ranges.filter( ( r ) => r.count > 0 );
		// Per workgroup: its batch's first workgroup and first slot, by the batches' fixed bounds.
		const pick = ( g: THREE.Node<'uint'>, value: ( r: CullRange ) => number ) => {

			let node: THREE.Node<'uint'> = uint( value( ranges[ 0 ] ) );
			for ( let k = 1; k < ranges.length; k ++ ) node = select( g.greaterThanEqual( uint( ranges[ k ].groupStart ) ), uint( value( ranges[ k ] ) ), node );
			return node;

		};
		const maxGroups = Math.max( ...ranges.map( ( r ) => r.groupEnd - r.groupStart ) );

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
			const first = pick( g, ( r ) => r.groupStart ).toVar();
			const partial = uint( 0 ).toVar();
			for ( let k = 0; k * GROUP < maxGroups; k ++ ) {

				const j = first.add( i ).add( uint( k * GROUP ) );
				partial.addAssign( select( j.lessThan( g ), counts.element( ( min as unknown as UintMax )( j, uint( this.groups - 1 ) ) ), uint( 0 ) ) );

			}
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

				visible.element( pick( g, ( r ) => r.start ).add( offset ).add( inclusive ).sub( 1 ) ).assign( gi );

			} );
			// The batch's last workgroup writes its draw arguments: index count, instance count
			// (first index, base vertex and first instance stay 0).
			for ( const r of ranges ) {

				const k = this.ranges.indexOf( r );
				If( g.equal( uint( r.groupEnd - 1 ) ).and( i.equal( 0 ) ), () => {

					args.element( uint( k * 5 ) ).assign( r.indexCount );
					args.element( uint( k * 5 + 1 ) ).assign( offset.add( total ) );

				} );

			}

		} )().computeKernel( [ GROUP ] );

		for ( const kernel of [ count, scatter ] ) {

			kernel.dispatchSize = [ this.groups, 1, 1 ];
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

	const n = cull.slots;
	const ground = storage( cull.ground, 'vec4', n * 3 ).toReadOnly();
	return {
		matrix: storage( cull.matrices, 'mat4', n ).toReadOnly().element( index ),
		color: storage( cull.colors, 'vec4', n ).toReadOnly().element( index ).xyz,
		ground: ( k: number ) => ground.element( index.mul( 3 ).add( k ) ),
		origin: storage( cull.origins, 'vec4', n ).toReadOnly().element( index ),
	};

}
