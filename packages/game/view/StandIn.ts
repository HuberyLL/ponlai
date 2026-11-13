import * as THREE from 'three/webgpu';
import { vertexColor } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CharacterShadow, type LookColours } from '../../island/index.ts';
import { GroundBounceLightingModel, writeMeter } from '../../render/index.ts';

// A plain islander built in code, shown when a figure's model cannot load (the models are
// git-ignored local assets), so an islander stays seen: faceted low-poly pieces in its look's
// colours, baked into vertex colours, under one rough material in the island's own light.

// Painted colours are authored as they read in sunlight; the island's turf and stone sit near a
// tenth albedo, so the palette scales down into that range like the figures' (characterLook).
const ALBEDO = 0.42;

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _a = new THREE.Vector3();
const X = new THREE.Vector3( 1, 0, 0 );

function at( x: number, y: number, z: number, sx = 1, sy = 1, sz = 1 ): THREE.Matrix4 {

	return _m.compose( _p.set( x, y, z ), _q.setFromEuler( _e.set( 0, 0, 0 ) ), _s.set( sx, sy, sz ) );

}

/** A matrix that lays a unit x-axis piece (a limb) from a to b with the given radius. */
function span( a: THREE.Vector3, b: THREE.Vector3, radius: number ): THREE.Matrix4 {

	_a.subVectors( b, a );
	const len = _a.length();
	_q.setFromUnitVectors( X, _a.normalize() );
	return _m.compose( _p.addVectors( a, b ).multiplyScalar( 0.5 ), _q, _s.set( len, radius, radius ) );

}

// templates only: pieces are copied out of these, so they never reach the GPU
const LIMB = new THREE.CylinderGeometry( 1, 1, 1, 7, 1 ).rotateZ( Math.PI / 2 );
const BOX = new THREE.BoxGeometry( 1, 1, 1 );
const BALL = new THREE.IcosahedronGeometry( 1, 1 );
const DISC = new THREE.CylinderGeometry( 1, 1, 1, 10, 1 ).translate( 0, 0.5, 0 );
// shoulders broader than the waist, 1 m tall from its base
const TORSO = new THREE.CylinderGeometry( 0.22, 0.17, 1, 8, 1 ).translate( 0, 0.5, 0 );

/** A coloured, faceted copy of a template piece. */
function piece( source: THREE.BufferGeometry, colour: string, matrix: THREE.Matrix4 ): THREE.BufferGeometry {

	const g = source.toNonIndexed();
	for ( const name of Object.keys( g.attributes ) ) if ( name !== 'position' ) g.deleteAttribute( name );
	g.applyMatrix4( matrix );
	// no vertex is shared once unindexed, so these are flat facet normals: chiselled forms
	g.computeVertexNormals();
	const c = new THREE.Color( colour );
	const col = new Float32Array( g.getAttribute( 'position' ).count * 3 );
	for ( let i = 0; i < col.length; i += 3 ) c.toArray( col, i );
	g.setAttribute( 'color', new THREE.BufferAttribute( col, 3 ) );
	return g;

}

/** 1.68 m from the feet (the origin), facing +z like the loaded figures. */
function standInGeometry( c: LookColours ): THREE.BufferGeometry {

	const parts: THREE.BufferGeometry[] = [];
	const from = new THREE.Vector3(), to = new THREE.Vector3();
	for ( const side of [ - 1, 1 ] ) {

		parts.push( piece( BOX, c.shoes, at( side * 0.1, 0.05, 0.03, 0.12, 0.1, 0.24 ) ) );
		parts.push( piece( DISC, c.trousers, at( side * 0.1, 0.1, 0, 0.075, 0.72, 0.075 ) ) );
		// arms hang from the shoulders, a little out from the body
		parts.push( piece( LIMB, c.shirt, span( from.set( side * 0.25, 1.33, 0 ), to.set( side * 0.29, 0.86, 0.03 ), 0.055 ) ) );
		parts.push( piece( BALL, c.skin, at( side * 0.29, 0.83, 0.03, 0.055, 0.06, 0.055 ) ) );
		// eyes, so the heading reads
		parts.push( piece( BOX, '#2a1d18', at( side * 0.045, 1.5, 0.11, 0.025, 0.03, 0.02 ) ) );

	}
	parts.push( piece( DISC, c.trousers, at( 0, 0.78, 0, 0.19, 0.2, 0.15 ) ) );
	parts.push( piece( TORSO, c.shirt, at( 0, 0.96, 0, 1, 0.42, 0.75 ) ) );
	parts.push( piece( DISC, c.skin, at( 0, 1.36, 0, 0.06, 0.06, 0.06 ) ) );
	parts.push( piece( BALL, c.skin, at( 0, 1.5, 0, 0.11, 0.125, 0.11 ) ) );
	// bare-headed, as the islanders go: a cap of hair over the crown and the back of the head
	parts.push( piece( BALL, c.hair, at( 0, 1.53, - 0.015, 0.118, 0.1, 0.118 ) ) );
	const g = mergeGeometries( parts )!;
	for ( const p of parts ) p.dispose();
	g.name = 'standIn';
	return g;

}

let material: THREE.MeshStandardNodeMaterial | null = null;
const geometries = new Map<number, THREE.BufferGeometry>();

/** A stand-in mesh for a look (its geometry cached by look, one material for all). */
export function standIn( look: number, colours: LookColours ): THREE.Mesh {

	if ( ! material ) {

		material = new THREE.MeshStandardNodeMaterial( { roughness: 0.92, metalness: 0 } );
		material.colorNode = vertexColor().rgb.mul( ALBEDO );
		material.name = 'standIn';
		( material as unknown as { setupLightingModel: () => THREE.LightingModel } ).setupLightingModel = () => new GroundBounceLightingModel();
		writeMeter( material );

	}
	let g = geometries.get( look );
	if ( ! g ) geometries.set( look, g = standInGeometry( colours ) );
	const mesh = new THREE.Mesh( g, material );
	mesh.name = 'standIn';
	mesh.receiveShadow = true;
	// it casts into the figures' own small shadow map, as a figure does
	mesh.layers.enable( CharacterShadow.LAYER );
	return mesh;

}
