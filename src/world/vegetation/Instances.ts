import * as THREE from 'three/webgpu';

// The instance store of the instanced vegetation kinds (the rim bushes, Foliage.ts; the flowers,
// Flowers.ts): one `InstancePool` per kind, which names the kind's per-instance buffers beside the
// matrices and keeps its capacity rule, and every write into those buffers goes through it. The
// kind keeps its geometry, material and placement; the pool keeps the buffers.
// - Capacity: an instanced mesh's buffers hold a capacity, not the count, so a grown island's
//   instances are written into the same mesh (`set`) and draw with the pipeline it drew with. Up to
//   1024 instances three keeps the matrices in a uniform array of exactly the capacity, which the
//   shader names; over 1024 in an instanced attribute, whose shader does not name the count. So a
//   kind's capacities stay on one side of 1024: a fixed pool (`grows: false`) holds `floor`
//   instances whatever the land (at most 1024: the bushes) and draws only the first `floor` of a
//   larger land (warned); a growing pool (`grows: true`) holds at least `floor`, else the next power
//   of two of twice the count (`floor` over 1024: the flowers), and a land that outgrows a mesh gets
//   a new mesh of the same material and layout (`replacement`, made and compiled ahead of the swap,
//   then put in its predecessor's place by `replace`).
// - Writes (`writes`, `set`): each buffer's used part, from its start; the update range covers the
//   values written (at least one item), the count follows, and the mesh's box and sphere are cleared
//   or set to the box found ahead (`box`: InstancedMesh.computeBoundingBox's, found in the
//   preparation's steps; the sun's caster box reads it). A grown island's writes are staged ahead
//   (Growth.ts, Upload.ts stagedWriteSteps), so the swap's write is a copy on the GPU.
// - Layout: the attributes go on the geometry in the order the pool names them (`instanceColor` is
//   the mesh's own, set after the mesh is made, as three's setColorAt would), and the writes go in
//   that order after the matrices.

/** One per-instance buffer beside the matrices: `key` names its values in the instances, `name` the
 * geometry's attribute (or `instanceColor`, the mesh's colour), `itemSize` its floats per instance. */
export interface InstanceAttribute<K extends string> { key: K; name: string; itemSize: number }

/** A kind's instances as its mesh's buffers take them: `count` instances, 16 floats of matrix each
 * and each attribute's `itemSize` floats under its key. */
export type Instances<K extends string> = { count: number; matrices: Float32Array } & { [ key in K ]: Float32Array };

type Write = [ THREE.BufferAttribute, Float32Array ];

export class InstancePool<K extends string> {

	readonly attributes: readonly InstanceAttribute<K>[];
	readonly floor: number;
	readonly grows: boolean;

	constructor( attributes: readonly InstanceAttribute<K>[], options: { floor: number; grows: boolean } ) {

		if ( options.grows ? options.floor <= 1024 : options.floor > 1024 ) throw new RangeError( `InstancePool: a ${ options.grows ? 'growing' : 'fixed' } pool of ${ options.floor } would cross 1024 instances` );
		this.attributes = attributes;
		this.floor = options.floor;
		this.grows = options.grows;

	}

	/** The capacity of a mesh made for `count` instances. */
	capacity( count: number ): number {

		return this.grows ? Math.max( this.floor, 2 ** Math.ceil( Math.log2( Math.max( 2 * count, 1 ) ) ) ) : this.floor;

	}

	/** How many of `count` instances a fixed pool draws (all of them in a growing one); `what` names
	 * the kind in the warning. */
	fit( count: number, what: string ): number {

		if ( this.grows || count <= this.floor ) return count;
		console.warn( `${ count } ${ what }: only the first ${ this.floor } are drawn` );
		return this.floor;

	}

	/** Empty instances of `count`, to fill. */
	empty( count: number ): Instances<K> {

		const out = { count, matrices: new Float32Array( count * 16 ) } as Instances<K>;
		for ( const a of this.attributes ) ( out as Record<string, Float32Array> )[ a.key ] = new Float32Array( count * a.itemSize );
		return out;

	}

	/** Puts the pool's per-instance attributes of `capacity` instances on `geometry`. */
	addAttributes( geometry: THREE.BufferGeometry, capacity: number ): THREE.BufferGeometry {

		for ( const a of this.attributes ) {

			if ( a.name !== 'instanceColor' ) geometry.setAttribute( a.name, new THREE.InstancedBufferAttribute( new Float32Array( capacity * a.itemSize ), a.itemSize ) );

		}
		return geometry;

	}

	/** An instanced mesh of `capacity` instances on `geometry` (its attributes added: addAttributes),
	 * empty: `set` fills it. */
	mesh( geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number ): THREE.InstancedMesh {

		const mesh = new THREE.InstancedMesh( geometry, material, capacity );
		// (a colour per instance whatever the count, so the shader is the same on every land)
		const color = this.attributes.find( ( a ) => a.name === 'instanceColor' );
		if ( color ) mesh.instanceColor = new THREE.InstancedBufferAttribute( new Float32Array( capacity * color.itemSize ), color.itemSize );
		return mesh;

	}

	/** The mesh's buffers `instances` are written into, each with its values. */
	writes( mesh: THREE.InstancedMesh, instances: Instances<K> ): Write[] {

		const out: Write[] = [ [ mesh.instanceMatrix, instances.matrices ] ];
		for ( const a of this.attributes ) {

			const attribute = a.name === 'instanceColor' ? mesh.instanceColor! : mesh.geometry.getAttribute( a.name ) as THREE.BufferAttribute;
			out.push( [ attribute, instances[ a.key ] ] );

		}
		return out;

	}

	/** Writes `instances` into the mesh's buffers (their used part re-uploaded), sets the count and
	 * the box (`box`, or cleared, with the sphere, for three to find). */
	set( mesh: THREE.InstancedMesh, instances: Instances<K>, box: THREE.Box3 | null = null ): void {

		for ( const [ attribute, values ] of this.writes( mesh, instances ) ) {

			( attribute.array as Float32Array ).set( values );
			attribute.clearUpdateRanges();
			attribute.addUpdateRange( 0, Math.max( values.length, attribute.itemSize ) );
			attribute.needsUpdate = true;

		}
		mesh.count = instances.count;
		mesh.boundingBox = null;
		mesh.boundingSphere = null;
		if ( box ) mesh.boundingBox = box;

	}

	/** The box of `instances` on `mesh`'s geometry, as InstancedMesh.computeBoundingBox finds it. */
	box( mesh: THREE.InstancedMesh, instances: Instances<K> ): THREE.Box3 {

		const geometry = mesh.geometry;
		if ( geometry.boundingBox === null ) geometry.computeBoundingBox();
		const box = new THREE.Box3(), part = new THREE.Box3(), m = new THREE.Matrix4();
		for ( let i = 0; i < instances.count; i ++ ) {

			m.fromArray( instances.matrices, i * 16 );
			part.copy( geometry.boundingBox! ).applyMatrix4( m );
			box.union( part );

		}
		return box;

	}

	/** Null when `instances` fit `mesh`, else a new mesh holding them, made by `make` for the pool's
	 * capacity of their count, with its box (to compile ahead, then `replace`). */
	replacement( mesh: THREE.InstancedMesh, instances: Instances<K>, make: ( capacity: number ) => THREE.InstancedMesh ): THREE.InstancedMesh | null {

		if ( instances.count <= mesh.instanceMatrix.count ) return null;
		const next = make( this.capacity( instances.count ) );
		next.computeBoundingBox();
		return next;

	}

	/** Puts `next` in `mesh`'s place among its parent's children (the meshes draw in that order),
	 * drawing with the material `mesh` drew with. Returns `mesh`, to dispose of once nothing draws it. */
	static replace( mesh: THREE.InstancedMesh, next: THREE.InstancedMesh ): THREE.InstancedMesh {

		const parent = mesh.parent!;
		next.material = mesh.material;
		parent.children[ parent.children.indexOf( mesh ) ] = next;
		next.parent = parent;
		mesh.parent = null;
		return mesh;

	}

}
