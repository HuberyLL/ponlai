import * as THREE from 'three/webgpu';
import { float, mix, mx_noise_float, positionGeometry, vertexColor } from 'three/tsl';

// What the game's stand-in props (the palm, the chest) are built from: faceted pieces in
// linear albedo, baked into vertex colours and merged into one geometry per prop, under one rough
// material in the island's own light. Pieces are copied out of templates, so the templates never
// reach the GPU; each copy is unindexed, so its normals are flat facet normals: the chunky,
// chiselled forms the art direction asks of things people make, and a stylised stand-in for a
// plant until the island grows its own palms.
//
// Rules: colours are linear albedo near the island's own (turf and stone sit near a tenth, a
// pale plank or dry bark a little above); a piece may carry extra per-vertex data (`extra`, for a
// prop's own shader inputs), the same width for every piece of one builder.

export type RGB = readonly [ number, number, number ];

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _p = new THREE.Vector3(), _s = new THREE.Vector3();

/** A placement matrix: position, Euler rotation (radians, XYZ) and scale. */
export function at( x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0 ): THREE.Matrix4 {

	return _m.compose( _p.set( x, y, z ), _q.setFromEuler( _e.set( rx, ry, rz ) ), _s.set( sx, sy, sz ) );

}

// templates, unit sized
export const BOX = new THREE.BoxGeometry( 1, 1, 1 );
export const BALL = new THREE.IcosahedronGeometry( 1, 1 );
/** a unit cylinder along y, from 0 to 1 */
export const LOG = new THREE.CylinderGeometry( 1, 1, 1, 7, 1 ).translate( 0, 0.5, 0 );

export class PropBuilder {

	private readonly parts: THREE.BufferGeometry[] = [];
	/** floats of `extra` per vertex (0: none) */
	readonly width: number;

	constructor( width = 0 ) {

		this.width = width;

	}

	/** A coloured, faceted copy of a template; `extra` fills each vertex's extra data. */
	add( source: THREE.BufferGeometry, colour: RGB, matrix: THREE.Matrix4, extra?: ( p: THREE.Vector3 ) => readonly number[] ): void {

		const g = source.index ? source.toNonIndexed() : source.clone();
		for ( const name of Object.keys( g.attributes ) ) if ( name !== 'position' ) g.deleteAttribute( name );
		g.applyMatrix4( matrix );
		this.finish( g, colour, extra );

	}

	/** Triangles given by their corners (world or prop space, three per triangle). */
	triangles( points: readonly THREE.Vector3[], colour: RGB | ( ( p: THREE.Vector3, k: number ) => RGB ), extra?: ( p: THREE.Vector3 ) => readonly number[] ): void {

		const g = new THREE.BufferGeometry();
		const a = new Float32Array( points.length * 3 );
		points.forEach( ( p, k ) => p.toArray( a, k * 3 ) );
		g.setAttribute( 'position', new THREE.BufferAttribute( a, 3 ) );
		this.finish( g, colour, extra );

	}

	private finish( g: THREE.BufferGeometry, colour: RGB | ( ( p: THREE.Vector3, k: number ) => RGB ), extra?: ( p: THREE.Vector3 ) => readonly number[] ): void {

		g.computeVertexNormals();
		const position = g.getAttribute( 'position' );
		const n = position.count, p = new THREE.Vector3();
		const col = new Float32Array( n * 3 ), more = new Float32Array( n * this.width );
		for ( let k = 0; k < n; k ++ ) {

			p.fromBufferAttribute( position, k );
			const c = typeof colour === 'function' ? colour( p, k ) : colour;
			col.set( c, k * 3 );
			if ( this.width > 0 ) more.set( extra ? extra( p ) : new Array( this.width ).fill( 0 ), k * this.width );

		}
		g.setAttribute( 'color', new THREE.BufferAttribute( col, 3 ) );
		if ( this.width > 0 ) g.setAttribute( 'extra', new THREE.BufferAttribute( more, this.width ) );
		this.parts.push( g );

	}

	/** One merged geometry; `extraName` renames the extra data. */
	geometry( name: string, extraName = 'extra' ): THREE.BufferGeometry {

		const g = new THREE.BufferGeometry();
		let count = 0;
		for ( const part of this.parts ) count += part.getAttribute( 'position' ).count;
		const merged: Record<string, Float32Array> = {};
		const widths: Record<string, number> = { position: 3, normal: 3, color: 3 };
		if ( this.width > 0 ) widths.extra = this.width;
		for ( const key in widths ) merged[ key ] = new Float32Array( count * widths[ key ] );
		let offset = 0;
		for ( const part of this.parts ) {

			const n = part.getAttribute( 'position' ).count;
			for ( const key in widths ) merged[ key ].set( part.getAttribute( key ).array as Float32Array, offset * widths[ key ] );
			offset += n;
			part.dispose();

		}
		this.parts.length = 0;
		for ( const key in widths ) g.setAttribute( key === 'extra' ? extraName : key, new THREE.BufferAttribute( merged[ key ], widths[ key ] ) );
		g.computeBoundingSphere();
		g.computeBoundingBox();
		g.name = name;
		return g;

	}

}

/** The props' surface: vertex colours, a little broken up by low-frequency noise (grain and
 * weathering at the scale of a plank), rough and matte. */
export function propMaterial( name: string, side: THREE.Side = THREE.FrontSide ): THREE.MeshStandardNodeMaterial {

	const material = new THREE.MeshStandardNodeMaterial( { roughness: 0.9, metalness: 0, side } );
	const grain = mx_noise_float( positionGeometry.mul( 7 ) ).mul( 0.5 ).add( 0.5 );
	material.colorNode = vertexColor().rgb.mul( mix( float( 0.84 ), float( 1.12 ), grain ) );
	material.name = name;
	return material;

}

/** A hash of a point (world metres, rounded to the centimetre) and a seed to 0..1: props take
 * their variation from where they stand, so a loaded game draws them the same. */
export function hashAt( x: number, z: number, seed: number ): number {

	let h = Math.imul( Math.round( x * 100 ) | 0, 0x27d4eb2d ) ^ Math.imul( Math.round( z * 100 ) | 0, 0x165667b1 ) ^ Math.imul( seed, 0x9e3779b1 );
	h = Math.imul( h ^ ( h >>> 15 ), 0x85ebca6b );
	h = Math.imul( h ^ ( h >>> 13 ), 0xc2b2ae35 );
	return ( ( h ^ ( h >>> 16 ) ) >>> 0 ) / 4294967296;

}
