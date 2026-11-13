import * as THREE from 'three/webgpu';
import { KIND } from './CharacterMaterial.ts';

// The islanders' long pointed ears, grown on each head at its own ear and bound to the head bone.
//
// The islanders are a Hylian-like people: human but for long pointed ears that sweep back and a
// little up. Rather than editing each head of the kit, a small faceted ear is grown at the place
// the head's own ear sits, found from the head's skin in the head bone's frame. Any head with
// skin gets a pair (helmets, with no skin at the sides, get none), sized from the head's width,
// painted with the skin's colour and bound wholly to the head bone, so the ears follow the head
// through every clip.

// Ear outline in the ear's plane, in head half-widths: along the ear (back from the root to the
// tip) and across it (up). The root starts inside the head so no seam shows at any turn; the
// tip rides a little above the axis so the ear reads as pointing up as well as back.
const OUTLINE: [ number, number ][] = [
	[ - 0.15, 0.3 ], // root, top (inside the head)
	[ 0.5, 0.2 ], // upper rim
	[ 1.4, 0.15 ], // tip
	[ 0.7, 0.0 ], // lower rim
	[ 0.15, - 0.25 ], // lobe
	[ - 0.15, - 0.2 ], // root, bottom
];
// the ridge each face of the ear rises to, and its height above the ear's plane
const RIDGE: [ number, number ] = [ 0.35, 0.04 ];
const THICKNESS = 0.07;
// direction of the ear in the head bone's frame (x out to the side, y up, z forward), before
// mirroring: swept 55 - 60 degrees back from the side and raised a little, so the ear lies
// along the head instead of standing out like a wing
const DIRECTION = new THREE.Vector3( 0.65, 0.3, - 1 ).normalize();
// share of the head's half-width beyond which skin belongs to the ear (the kit's ears sit at
// 0.84 - 1 of it)
const EAR_ZONE = 0.84;
// how far into the head the root sits, as a share of the half-width
const ROOT_INSET = 0.86;

/**
 * A pair of pointed ears for a painted head part (one geometry per material, all bound like
 * `mesh`), in the part's mesh space with its attribute layout, or null when the part has no skin
 * at its sides.
 */
export function pointedEars( mesh: THREE.SkinnedMesh, parts: THREE.BufferGeometry[] ): THREE.BufferGeometry | null {

	const head = mesh.skeleton.bones.findIndex( ( b ) => b.name === 'Head' );
	if ( head < 0 ) return null;
	// mesh space -> head bone space at bind time, as the skinning maps it
	const toBone = new THREE.Matrix4().multiplyMatrices( mesh.skeleton.boneInverses[ head ], mesh.bindMatrix );
	const fromBone = toBone.clone().invert();
	const p = new THREE.Vector3();
	const skin: { p: THREE.Vector3; colour: THREE.Color }[] = [];
	let halfWidth = 0;
	for ( const painted of parts ) {

		const position = painted.getAttribute( 'position' ), colour = painted.getAttribute( 'color' ) as THREE.BufferAttribute;
		const shade = painted.getAttribute( 'shade' );
		const skinIndex = painted.getAttribute( 'skinIndex' ), skinWeight = painted.getAttribute( 'skinWeight' );
		for ( let v = 0; v < position.count; v ++ ) {

			if ( shade.getX( v ) !== KIND.skin ) continue;
			let w = 0;
			for ( let k = 0; k < 4; k ++ ) if ( skinIndex.getComponent( v, k ) === head ) w += skinWeight.getComponent( v, k );
			if ( w < 0.5 ) continue;
			p.fromBufferAttribute( position, v ).applyMatrix4( toBone );
			skin.push( { p: p.clone(), colour: new THREE.Color().fromBufferAttribute( colour, v ) } );
			halfWidth = Math.max( halfWidth, Math.abs( p.x ) );

		}

	}
	if ( halfWidth === 0 ) return null;

	const positions: number[] = [], normals: number[] = [];
	const tint = new THREE.Color();
	let tintCount = 0, side = 0;
	for ( const s of [ 1, - 1 ] ) {

		// the head's own ear on this side: its centre places the new one
		const centre = new THREE.Vector3();
		let n = 0;
		for ( const { p: q, colour } of skin ) {

			if ( q.x * s < halfWidth * EAR_ZONE ) continue;
			centre.add( q );
			tint.add( colour );
			n ++;

		}
		if ( n === 0 ) continue;
		tintCount += n;
		side ++;
		centre.divideScalar( n );
		const w = halfWidth;
		const root = new THREE.Vector3( s * w * ROOT_INSET, centre.y, centre.z );
		const along = DIRECTION.clone().setX( DIRECTION.x * s );
		const across = new THREE.Vector3( 0, 1, 0 ).addScaledVector( along, - along.y ).normalize();
		const face = new THREE.Vector3().crossVectors( along, across ).normalize();
		const at = ( a: number, b: number, h = 0 ) => root.clone()
			.addScaledVector( along, a * w ).addScaledVector( across, b * w ).addScaledVector( face, h * w );
		const rim = OUTLINE.map( ( [ a, b ] ) => at( a, b ) );
		const middle = at( RIDGE[ 0 ], RIDGE[ 1 ] );
		for ( const h of [ THICKNESS, - THICKNESS ] ) {

			const ridge = at( RIDGE[ 0 ], RIDGE[ 1 ], h );
			for ( let i = 0; i < rim.length; i ++ ) {

				let a = rim[ i ], b = rim[ ( i + 1 ) % rim.length ];
				// wind each facet to face away from the ear's middle
				const nrm = new THREE.Vector3().crossVectors( b.clone().sub( ridge ), a.clone().sub( ridge ) ).normalize();
				const mid = ridge.clone().add( a ).add( b ).divideScalar( 3 ).sub( middle );
				if ( nrm.dot( mid ) < 0 ) {

					[ a, b ] = [ b, a ];
					nrm.negate();

				}
				for ( const q of [ ridge, b, a ] ) positions.push( q.x, q.y, q.z );
				for ( let k = 0; k < 3; k ++ ) normals.push( nrm.x, nrm.y, nrm.z );

			}

		}

	}
	if ( side === 0 ) return null;
	tint.multiplyScalar( 1 / tintCount );

	// into the part's mesh space and attribute layout (merging needs matching array types)
	const count = positions.length / 3;
	const g = new THREE.BufferGeometry();
	const like = ( name: string ) => {

		const src = parts[ 0 ].getAttribute( name ) as THREE.BufferAttribute;
		const Array = src.array.constructor as new ( n: number ) => THREE.TypedArray;
		const attribute = new THREE.BufferAttribute( new Array( count * src.itemSize ), src.itemSize, src.normalized );
		g.setAttribute( name, attribute );
		return attribute;

	};
	const pos = like( 'position' ), nor = like( 'normal' ), col = like( 'color' ), shd = like( 'shade' );
	const si = like( 'skinIndex' ), sw = like( 'skinWeight' );
	const normalMatrix = new THREE.Matrix3().getNormalMatrix( fromBone );
	const nv = new THREE.Vector3();
	for ( let v = 0; v < count; v ++ ) {

		p.fromArray( positions, v * 3 ).applyMatrix4( fromBone );
		pos.setXYZ( v, p.x, p.y, p.z );
		nv.fromArray( normals, v * 3 ).applyMatrix3( normalMatrix ).normalize();
		nor.setXYZ( v, nv.x, nv.y, nv.z );
		col.setXYZ( v, tint.r, tint.g, tint.b );
		shd.setXYZW( v, KIND.skin, 1, 0, 0 );
		si.setXYZW( v, head, 0, 0, 0 );
		sw.setXYZW( v, 1, 0, 0, 0 );

	}
	const index = parts[ 0 ].getIndex()!;
	const IndexArray = index.array.constructor as new ( n: number ) => THREE.TypedArray;
	const order = new IndexArray( count );
	for ( let i = 0; i < count; i ++ ) order[ i ] = i;
	g.setIndex( new THREE.BufferAttribute( order, 1 ) );
	return g;

}
