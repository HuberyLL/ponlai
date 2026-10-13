import * as THREE from 'three/webgpu';
import { texture, vec2 } from 'three/tsl';
import { SEABED_TILE } from './SeabedTile.ts';
import { RIM_CELL } from './RimGround.ts';
import type { WorldData, ShoreField } from './types.ts';

// The world fields on the GPU (ChunkMerge.ts assembles them on the CPU): the shore's sea-level
// distance and the floor's height (32-bit floats), the floor's beds and the rim ground (half
// floats: filterable everywhere, and half the memory of floats as the land grows; the rim's
// distance is clamped to 1.5 m and the beds are shares, so they keep them to a millimetre).
//
// Every material samples a field through one base node per field (`texture( node, uv )` follows
// the base node's `value`), so a field can be swapped for a texture of another size without
// touching a material: a new texture is a new bind group, never a pipeline.
//
// A growth step (Growth.ts):
// - keeps a field's texture while the land's fields keep their bounds (the land's box and 32 m
//   round it, out to the world's 32 m grid: ChunkMerge.ts fieldBounds; the rim ground's own,
//   rimBounds), and writes only the squares of the changed chunks whose texels changed into it:
//   packed into a staging buffer ahead, then copied into place on the GPU in the swap's frame,
//   which sends no texel data (three r186's WebGPU backend writes a DataTexture whole and has no
//   update ranges);
// - takes a new texture once the land outgrows them, made and filled ahead (`uploadTexture`) and
//   set as the base node's value in the swap's frame.
// Texels go up through buffers mapped at creation and copies on the GPU, never queue.writeTexture:
// a write sends its data through the GPU process's command stream, and with the GPU busy a few
// megabytes stalled the main thread for hundreds of milliseconds, in the swap's frame or the idle
// time before it.
// Either way the textures hold what a page loaded on the grown land holds, bit for bit: the CPU
// fields are the same merge's, and a half float is a function of its float alone (the rim's half
// floats are carried over where the chunks did not change and converted where they did).

type FieldKey = 'shore' | 'floor' | 'beds' | 'rim';
// the WebGPU calls made here (the page has no WebGPU typings); through SubmitBatch.ts's wrappers
type GpuTexture = object;
type GpuBuffer = { getMappedRange(): ArrayBuffer; unmap(): void; destroy(): void };
type GpuDevice = {
	createBuffer( descriptor: { size: number; usage: number; mappedAtCreation: boolean } ): GpuBuffer;
	createCommandEncoder(): {
		copyBufferToTexture( source: { buffer: GpuBuffer; offset: number; bytesPerRow: number; rowsPerImage: number }, destination: { texture: GpuTexture; origin: { x: number; y: number } }, size: { width: number; height: number } ): void;
		finish(): unknown;
	};
	queue: { submit( buffers: unknown[] ): void };
};
type Backend = { get( object: unknown ): { texture?: GpuTexture }; device: GpuDevice };
// (WebGPU's GPUBufferUsage.COPY_SRC; a copy's rows start on 256-byte boundaries)
const COPY_SRC = 0x0004, ROW_ALIGN = 256;
/** A square of a field to copy from the staging buffer: x, y, side, and its offset there. */
type Rect = [ number, number, number, number ];
/** The changed squares of a field and the staging buffer holding them (rows `pitch` bytes apart). */
interface Staged { rects: Rect[]; buffer: GpuBuffer; pitch: number }

// A buffer the GPU copies from, holding `fill`'s bytes (written through its mapping: no queue write).
function stagingBuffer( device: GpuDevice, size: number, fill: ( bytes: Uint8Array ) => void ): GpuBuffer {

	const buffer = device.createBuffer( { size: Math.ceil( size / 4 ) * 4, usage: COPY_SRC, mappedAtCreation: true } );
	fill( new Uint8Array( buffer.getMappedRange() ) );
	buffer.unmap();
	return buffer;

}

/** Makes `texture`'s GPU texture and fills it from its data through a staging buffer and a copy on
 * the GPU (see the header: no queue write); three's own upload where the internals are missing. */
export function uploadTexture( renderer: THREE.WebGPURenderer, texture: THREE.DataTexture ): void {

	const backend = renderer.backend as unknown as Backend;
	const data = texture.image.data as ArrayBufferView, { width, height } = texture.image;
	texture.source.dataReady = false;
	renderer.initTexture( texture );
	texture.source.dataReady = true;
	const gpu = backend.get( texture ).texture;
	if ( ! gpu || ! backend.device?.createBuffer ) {

		texture.needsUpdate = true;
		renderer.initTexture( texture );
		return;

	}
	const row = data.byteLength / height, pitch = Math.ceil( row / ROW_ALIGN ) * ROW_ALIGN;
	const source = new Uint8Array( data.buffer, data.byteOffset, data.byteLength );
	const buffer = stagingBuffer( backend.device, pitch * height, ( bytes ) => {

		if ( pitch === row ) bytes.set( source );
		else for ( let j = 0; j < height; j ++ ) bytes.set( source.subarray( j * row, ( j + 1 ) * row ), j * pitch );

	} );
	const encoder = backend.device.createCommandEncoder();
	encoder.copyBufferToTexture( { buffer, offset: 0, bytesPerRow: pitch, rowsPerImage: height }, { texture: gpu, origin: { x: 0, y: 0 } }, { width, height } );
	backend.device.queue.submit( [ encoder.finish() ] );
	// (freed once the copy has run)
	buffer.destroy();

}

interface Texel { format: THREE.PixelFormat; type: THREE.TextureDataType; channels: number; bytes: number }
const TEXEL: Record<FieldKey, Texel> = {
	shore: { format: THREE.RedFormat, type: THREE.FloatType, channels: 1, bytes: 4 },
	floor: { format: THREE.RedFormat, type: THREE.FloatType, channels: 1, bytes: 4 },
	beds: { format: THREE.RGFormat, type: THREE.HalfFloatType, channels: 2, bytes: 4 },
	rim: { format: THREE.RGBAFormat, type: THREE.HalfFloatType, channels: 4, bytes: 8 },
};
const NAMES: Record<FieldKey, string> = { shore: 'shore-distance', floor: 'seabed-height', beds: 'seabed-beds', rim: 'rim-root-bed' };

/** A field's texels: the float field, or its half floats. */
type Texels = Float32Array | Uint16Array;

/** What a growth step prepared for the fields (`steps`), for `apply` in the swap's frame. */
export interface FieldsPrepared {
	data: WorldData;
	texels: Record<FieldKey, Texels>;
	// per field: the squares of the changed chunks whose texels changed, staged (to copy into its
	// texture), or (bounds changed) a new texture; both uploaded ahead
	staged: Partial<Record<FieldKey, Staged | null>>;
	textures: Partial<Record<FieldKey, THREE.DataTexture>>;
}

function half( from: Float32Array, to: Uint16Array, start: number, end: number ): void {

	for ( let k = start; k < end; k ++ ) to[ k ] = THREE.DataUtils.toHalfFloat( from[ k ] );

}

function fieldTexture( key: FieldKey, texels: Texels, nx: number, nz: number ): THREE.DataTexture {

	const t = TEXEL[ key ];
	const tex = new THREE.DataTexture( texels, nx, nz, t.format, t.type );
	tex.minFilter = tex.magFilter = THREE.LinearFilter;
	tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
	tex.generateMipmaps = false;
	tex.needsUpdate = true;
	tex.name = NAMES[ key ];
	return tex;

}

// The texels of the rectangle ( i0, j0, w, h ) of a field nx wide, packed, or null when they are the
// same in `old` (a rebuilt chunk can keep a field's square: the shore far from the new land).
function pack( texels: Texels, old: Texels, nx: number, channels: number, i0: number, j0: number, w: number, h: number ): Texels | null {

	const out = new ( texels.constructor as Float32ArrayConstructor | Uint16ArrayConstructor )( w * h * channels );
	// (compared by their bits: a float's -0 and 0 differ there)
	const bits = ( t: Texels ) => t instanceof Float32Array ? new Uint32Array( t.buffer, t.byteOffset, t.length ) : t;
	const now = bits( texels ), before = bits( old );
	let same = true;
	for ( let j = 0; j < h; j ++ ) {

		const from = ( ( j0 + j ) * nx + i0 ) * channels;
		out.set( texels.subarray( from, from + w * channels ), j * w * channels );
		if ( same ) for ( let k = from; k < from + w * channels; k ++ ) if ( now[ k ] !== before[ k ] ) { same = false; break; }

	}
	return same ? null : out;

}

/** A changed square of a field: x, y and its texels, packed. */
type Square = [ number, number, Texels ];

// The squares of a field (each side x side texels) one after another in a staging buffer, each row
// on a ROW_ALIGN boundary: null when there are none.
function stage( key: FieldKey, squares: Square[], side: number, device: GpuDevice ): Staged | null {

	if ( squares.length === 0 ) return null;
	const row = side * TEXEL[ key ].bytes, pitch = Math.ceil( row / ROW_ALIGN ) * ROW_ALIGN, size = pitch * side;
	const rects: Rect[] = [];
	const buffer = stagingBuffer( device, size * squares.length, ( bytes ) => squares.forEach( ( [ x, y, texels ], k ) => {

		const source = new Uint8Array( texels.buffer, texels.byteOffset, texels.byteLength );
		for ( let j = 0; j < side; j ++ ) bytes.set( source.subarray( j * row, ( j + 1 ) * row ), k * size + j * pitch );
		rects.push( [ x, y, side, k * size ] );

	} ) );
	return { rects, buffer, pitch };

}

const sameBounds = ( a: ShoreField, b: ShoreField ) => a.x0 === b.x0 && a.z0 === b.z0 && a.nx === b.nx && a.nz === b.nz;

export class WorldFields {

	/** The base nodes the materials sample the fields through. */
	readonly shore: THREE.TextureNode;
	readonly floor: THREE.TextureNode;
	readonly beds: THREE.TextureNode;
	readonly rim: THREE.TextureNode;
	/** The shore's ( x0, z0, 1 / width, 1 / depth ) (shared.shoreXform's value: the floor and beds
	 * share its bounds) and the rim ground's. */
	readonly shoreXform: THREE.Vector4;
	readonly rimXform = new THREE.Vector4();
	private data: WorldData;
	private texels: Record<FieldKey, Texels>;

	constructor( data: WorldData, shoreXform: THREE.Vector4 ) {

		this.data = data;
		this.shoreXform = shoreXform;
		const beds = new Uint16Array( data.seabedBeds.data.length ), rim = new Uint16Array( data.rimGround.data.length );
		half( data.seabedBeds.data, beds, 0, beds.length );
		half( data.rimGround.data, rim, 0, rim.length );
		this.texels = { shore: data.shore.data, floor: data.seabedField.data, beds, rim };
		// (each made with a uv of its own, which every sampling node replaces: a node made without one
		// passes its copies three's uv matrix, an extra uniform and multiply in every shader)
		const base = ( tex: THREE.DataTexture ) => texture( tex, vec2( 0 ) );
		this.shore = base( fieldTexture( 'shore', data.shore.data, data.shore.nx, data.shore.nz ) );
		this.floor = base( fieldTexture( 'floor', data.seabedField.data, data.seabedField.nx, data.seabedField.nz ) );
		this.beds = base( fieldTexture( 'beds', beds, data.seabedBeds.nx, data.seabedBeds.nz ) );
		this.rim = base( fieldTexture( 'rim', rim, data.rimGround.nx, data.rimGround.nz ) );
		this.setTransforms( data );

	}

	private setTransforms( data: WorldData ): void {

		const s = data.shore, r = data.rimGround;
		this.shoreXform.set( s.x0, s.z0, 1 / ( s.nx * s.cell ), 1 / ( s.nz * s.cell ) );
		this.rimXform.set( r.x0, r.z0, 1 / ( r.nx * r.cell ), 1 / ( r.nz * r.cell ) );

	}

	/** The fields of `data` (a version merged from these chunks and `changed`, those whose data
	 * differs from the shown version's), in steps: the half floats, and for fields whose bounds
	 * changed new textures uploaded through `upload` (one per step). */
	* steps( data: WorldData, changed: readonly { ci: number; cj: number }[], renderer: THREE.WebGPURenderer ): Generator<void, FieldsPrepared> {

		const device = ( renderer.backend as unknown as Backend ).device;

		const old = this.data, staged: FieldsPrepared[ 'staged' ] = {}, textures: FieldsPrepared[ 'textures' ] = {};
		const same = sameBounds( old.shore, data.shore ), sameRim = sameBounds( old.rimGround, data.rimGround );
		// the beds: small (0.5 m), converted whole
		const beds = new Uint16Array( data.seabedBeds.data.length );
		const ROWS = 1 << 16;
		for ( let k = 0; k < beds.length; k += ROWS ) {

			half( data.seabedBeds.data, beds, k, Math.min( k + ROWS, beds.length ) );
			yield;

		}
		// the rim ground: carried over where it can be, converted where its chunks changed
		const r = data.rimGround, rim = new Uint16Array( r.data.length );
		const rimTile = Math.round( SEABED_TILE / RIM_CELL );
		const inRim = ( c: { ci: number; cj: number } ) => {

			const i = Math.round( c.ci * SEABED_TILE / RIM_CELL ) - Math.round( r.x0 / RIM_CELL ), j = Math.round( c.cj * SEABED_TILE / RIM_CELL ) - Math.round( r.z0 / RIM_CELL );
			return i >= 0 && j >= 0 && i < r.nx && j < r.nz ? [ i, j ] as const : null;

		};
		if ( sameRim ) {

			const from = this.texels.rim as Uint16Array;
			for ( let k = 0; k < rim.length; k += ROWS * 16 ) {

				rim.set( from.subarray( k, Math.min( k + ROWS * 16, rim.length ) ), k );
				yield;

			}
			const squares: Square[] = [];
			for ( const c of changed ) {

				const at = inRim( c );
				if ( ! at ) continue;
				const [ i0, j0 ] = at;
				for ( let j = j0; j < j0 + rimTile; j ++ ) half( r.data, rim, ( j * r.nx + i0 ) * 4, ( j * r.nx + i0 + rimTile ) * 4 );
				const packed = pack( rim, from, r.nx, 4, i0, j0, rimTile, rimTile );
				if ( packed ) squares.push( [ i0, j0, packed ] );
				yield;

			}
			staged.rim = stage( 'rim', squares, rimTile, device );

		} else {

			for ( let k = 0; k < rim.length; k += ROWS ) {

				half( r.data, rim, k, Math.min( k + ROWS, rim.length ) );
				yield;

			}

		}
		const texels = { shore: data.shore.data, floor: data.seabedField.data, beds, rim };
		const fields: Record<FieldKey, ShoreField> = { shore: data.shore, floor: data.seabedField, beds: data.seabedBeds, rim: data.rimGround };
		for ( const key of [ 'shore', 'floor', 'beds' ] as const ) {

			if ( ! same ) continue;
			const f = fields[ key ], tile = SEABED_TILE / f.cell, channels = TEXEL[ key ].channels, squares: Square[] = [];
			for ( const c of changed ) {

				const i0 = ( c.ci * SEABED_TILE - f.x0 ) / f.cell, j0 = ( c.cj * SEABED_TILE - f.z0 ) / f.cell;
				const packed = pack( texels[ key ], this.texels[ key ], f.nx, channels, i0, j0, tile, tile );
				if ( packed ) squares.push( [ i0, j0, packed ] );

			}
			staged[ key ] = stage( key, squares, tile, device );
			yield;

		}
		for ( const key of [ 'shore', 'floor', 'beds', 'rim' ] as const ) {

			if ( staged[ key ] !== undefined ) continue;
			const tex = textures[ key ] = fieldTexture( key, texels[ key ], fields[ key ].nx, fields[ key ].nz );
			uploadTexture( renderer, tex );
			yield;

		}
		return { data, texels, staged, textures };

	}

	/** Takes the prepared fields, in the swap's frame: the changed squares written into the textures
	 * kept, or the new textures set on the nodes. Returns what to dispose of once no frame draws with
	 * it (the textures replaced, the staging buffers). */
	apply( prepared: FieldsPrepared, renderer: THREE.WebGPURenderer ): ( () => void )[] {

		const nodes: Record<FieldKey, THREE.TextureNode> = { shore: this.shore, floor: this.floor, beds: this.beds, rim: this.rim };
		const backend = renderer.backend as unknown as Backend;
		const replaced: ( () => void )[] = [];
		let encoder: ReturnType<GpuDevice[ 'createCommandEncoder' ]> | null = null;
		for ( const key of [ 'shore', 'floor', 'beds', 'rim' ] as const ) {

			const node = nodes[ key ], current = node.value as THREE.DataTexture, texels = prepared.texels[ key ];
			const fresh = prepared.textures[ key ];
			if ( fresh ) {

				replaced.push( () => current.dispose() );
				node.value = fresh;
				continue;

			}
			const gpu = backend.get( current ).texture, staging = prepared.staged[ key ];
			if ( gpu && staging ) {

				encoder ??= backend.device.createCommandEncoder();
				for ( const [ x, y, side, offset ] of staging.rects ) encoder.copyBufferToTexture( { buffer: staging.buffer, offset, bytesPerRow: staging.pitch, rowsPerImage: side }, { texture: gpu, origin: { x, y } }, { width: side, height: side } );

			}
			// (what three would upload again, should it ever: the version's texels)
			current.image.data = texels;
			// (without a GPU texture yet, three uploads the whole field at its first use)
			if ( ! gpu ) current.needsUpdate = true;

		}
		if ( encoder ) backend.device.queue.submit( [ encoder.finish() ] );
		this.data = prepared.data;
		this.texels = prepared.texels;
		this.setTransforms( prepared.data );
		// (the staging buffers go with the replaced textures, once the copies have run)
		for ( const staging of Object.values( prepared.staged ) ) if ( staging ) replaced.push( () => staging.buffer.destroy() );
		return replaced;

	}

	/** The fields' GPU bytes. */
	bytes(): Record<FieldKey | 'total', number> {

		const out = { shore: 0, floor: 0, beds: 0, rim: 0, total: 0 };
		for ( const [ key, node ] of [ [ 'shore', this.shore ], [ 'floor', this.floor ], [ 'beds', this.beds ], [ 'rim', this.rim ] ] as const ) {

			const image = ( node.value as THREE.DataTexture ).image;
			out[ key ] = image.width * image.height * TEXEL[ key ].bytes;
			out.total += out[ key ];

		}
		return out;

	}

}
