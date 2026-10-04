import * as THREE from 'three/webgpu';
import { positionGeometry, positionLocal, normalViewGeometry, vec3, float, dot, sin, cos, pow, clamp } from 'three/tsl';
import { mulberry32 } from './noise.ts';
import { leafAlphaTexture } from './Foliage.ts';
import { VegetationLighting, useLighting } from './VegetationLighting.ts';
import { useRestPoseShadows } from './VegetationShadow.ts';
import type { Shared } from '../shared.ts';

// Ivy hanging from the island's rim: leaf cards strung down the strands the world worker traced
// over the rock faces (x, y, z, outward x, outward z, t along the strand). The cards face out from
// the rock, tipped down the way hanging leaves hang; they shade with the strand's outward normal
// (soft, no per-card facets), glow when backlit, and stir a little in the wind.

const STRIDE = 6;

function ivyTexture( size = 256 ): THREE.CanvasTexture {

	const c = document.createElement( 'canvas' );
	c.width = c.height = size;
	const g = c.getContext( '2d' )!;
	g.clearRect( 0, 0, size, size );
	g.strokeStyle = '#868676';
	g.lineWidth = size * 0.013;
	g.beginPath();
	g.moveTo( size * 0.5, size * 0.04 );
	g.bezierCurveTo( size * 0.4, size * 0.3, size * 0.59, size * 0.55, size * 0.49, size * 0.97 );
	g.stroke();
	for ( let i = 0; i < 4; i ++ ) {

		const side = i % 2 === 0 ? - 1 : 1;
		g.save();
		g.translate( size * ( 0.5 + side * 0.07 ), size * ( 0.2 + i * 0.2 ) );
		g.rotate( side * 0.6 );
		const s = size * ( 0.205 - i * 0.015 );
		const shade = g.createLinearGradient( - s, - s, s, s );
		shade.addColorStop( 0, '#eeeecc' );
		shade.addColorStop( 0.48, '#b9c39a' );
		shade.addColorStop( 0.52, '#7f986d' );
		shade.addColorStop( 1, '#bacaa0' );
		g.fillStyle = shade;
		g.beginPath();
		g.moveTo( 0, - s * 0.64 );
		g.bezierCurveTo( - s * 0.15, - s * 0.25, - s * 0.76, - s * 0.45, - s * 0.94, - s * 0.2 );
		g.lineTo( - s * 0.59, s * 0.16 );
		g.lineTo( - s * 0.8, s * 0.53 );
		g.quadraticCurveTo( - s * 0.27, s * 0.35, 0, s );
		g.quadraticCurveTo( s * 0.3, s * 0.35, s * 0.8, s * 0.53 );
		g.lineTo( s * 0.59, s * 0.16 );
		g.lineTo( s * 0.94, - s * 0.2 );
		g.bezierCurveTo( s * 0.76, - s * 0.45, s * 0.15, - s * 0.25, 0, - s * 0.64 );
		g.fill();
		g.strokeStyle = 'rgba(235,243,207,0.36)';
		g.lineWidth = size * 0.004;
		g.beginPath();
		g.moveTo( 0, - s * 0.48 );
		g.lineTo( 0, s * 0.85 );
		g.moveTo( 0, 0 );
		g.lineTo( - s * 0.58, s * 0.32 );
		g.moveTo( 0, 0 );
		g.lineTo( s * 0.58, s * 0.32 );
		g.stroke();
		g.restore();

	}
	const tex = new THREE.CanvasTexture( c );
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.minFilter = THREE.LinearMipmapLinearFilter;
	tex.anisotropy = 4;
	return tex;

}

function ivyMaterial( shared: Shared, map: THREE.CanvasTexture ): THREE.MeshStandardNodeMaterial {

	const mat = new THREE.MeshStandardNodeMaterial( { map, alphaTest: 0.38, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.8 } );
	mat.alphaMap = leafAlphaTexture( map );
	const g = positionGeometry, p = positionLocal;
	const ph = p.x.mul( 1.7 ).add( p.y.mul( 2.3 ) ).sub( shared.time.mul( 1.4 ) );
	useRestPoseShadows( mat, p, p.add( vec3( sin( ph ), 0, cos( ph.mul( 1.3 ) ) ).mul( g.y.add( 0.5 ).mul( 0.025 ) ) ) );
	mat.normalNode = normalViewGeometry;
	useLighting( mat, () => new VegetationLighting( float( 1 ), ( L, V, N ) => {

		const back = pow( clamp( dot( V.negate(), L ), 0, 1 ), 4 );
		const wrap = clamp( dot( N, L ).mul( 0.5 ).add( 0.5 ), 0, 1 );
		return wrap.mul( wrap ).mul( 0.15 ).add( back.mul( 0.38 ) );

	} ) );
	return mat;

}

export function buildIvy( pts: Float32Array, shared: Shared ): THREE.InstancedMesh {

	const rng = mulberry32( 57 );
	const n = pts.length / STRIDE;
	const cards: number[] = [];
	for ( let i = 0; i < n; i ++ ) cards.push( i, 2 + ( rng() < 0.4 ? 1 : 0 ) );
	let total = 0;
	for ( let i = 0; i < cards.length; i += 2 ) total += cards[ i + 1 ];

	const geo = new THREE.PlaneGeometry( 1, 1 );
	const mesh = new THREE.InstancedMesh( geo, ivyMaterial( shared, ivyTexture() ), total );
	const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qz = new THREE.Quaternion();
	const pos = new THREE.Vector3(), scl = new THREE.Vector3(), out = new THREE.Vector3();
	const zAxis = new THREE.Vector3( 0, 0, 1 ), col = new THREE.Color();
	const dark = new THREE.Color( 0.045, 0.115, 0.038 ), mid = new THREE.Color( 0.105, 0.19, 0.045 ), lit = new THREE.Color( 0.2, 0.235, 0.065 );
	let j = 0;
	for ( let c = 0; c < cards.length; c += 2 ) {

		const k = cards[ c ] * STRIDE;
		const ox = pts[ k + 3 ], oz = pts[ k + 4 ], t = pts[ k + 5 ];
		for ( let r = 0; r < cards[ c + 1 ]; r ++ ) {

			// face out from the rock, tipped down, turned at random in its own plane
			out.set( ox, - 0.35 - rng() * 0.3, oz ).normalize();
			q.setFromUnitVectors( zAxis, out );
			qz.setFromAxisAngle( zAxis, ( rng() - 0.5 ) * 1.1 );
			q.multiply( qz );
			const tx = - oz, tz = ox, jit = ( rng() - 0.5 ) * 0.3, off = 0.06 + rng() * 0.1;
			pos.set( pts[ k ] + tx * jit + ox * off, pts[ k + 1 ] + ( rng() - 0.5 ) * 0.12, pts[ k + 2 ] + tz * jit + oz * off );
			const s = ( 0.35 + rng() * 0.18 ) * ( 1 - 0.48 * t );
			scl.set( s * 0.86, s * 1.12, s );
			m.compose( pos, q, scl );
			mesh.setMatrixAt( j, m );
			col.copy( mid ).lerp( rng() < 0.5 ? dark : lit, rng() * 0.8 ).multiplyScalar( 1 - 0.2 * t );
			mesh.setColorAt( j, col );
			j ++;

		}

	}

	mesh.instanceMatrix.needsUpdate = true;
	if ( mesh.instanceColor ) mesh.instanceColor.needsUpdate = true;
	mesh.frustumCulled = false;
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	mesh.name = 'ivy';
	mesh.renderOrder = - 1; // before the terrain: the turf it covers then fails the depth test
	return mesh;

}
