import * as THREE from 'three/webgpu';
import { attribute, positionLocal, vec2, vec3, vec4, float, mix, sin, dot, pow, clamp, materialColor } from 'three/tsl';
import { meadowColor } from '../materials/Meadow.ts';
import { SOIL_PALETTE } from '../materials/Soil.ts';
import { SKIRT_RING } from './RimGround.ts';
import { VegetationLighting, useLighting } from './VegetationLighting.ts';
import { useRestPoseShadows } from './VegetationShadow.ts';
import { mulberry32, noise3 } from './noise.ts';
import type { Shared } from '../shared.ts';
import type { RimSkirtData } from './types.ts';

// The turf skirt: the meadow's sod curling a little over the rim, swept along the coast the
// worker traced (RimGround.buildRimSkirt), with a fringe of short blades on its shoulder and
// hanging grass and root hairs along its ragged lower edge. One mesh, one draw.

const SHADE = [ 0.86, 0.94, 1, 0.9, 0.7, 0.52, 0.4 ];

export function buildTurfSkirt( skirt: RimSkirtData, shared: Shared ): THREE.Mesh {

	const P: number[] = [], C: number[] = [], N: number[] = [], B: number[] = [], W: number[] = [], I: number[] = [];
	const { points, info, loops } = skirt;
	const col = new THREE.Color(), earth = new THREE.Color( ...SOIL_PALETTE.root );
	const base = new THREE.Vector3(), dir = new THREE.Vector3(), side = new THREE.Vector3(), up = new THREE.Vector3( 0, 1, 0 );
	const normal = new THREE.Vector3(), v = new THREE.Vector3();
	const ring = ( s: number, k: number, target = v ) => target.fromArray( points, ( s * SKIRT_RING + k ) * 3 );
	const rng = mulberry32( 5501 );
	let blades = 0;

	// Body: the sod sheet, smooth-shaded from its own triangles.
	for ( let l = 0; l < loops.length; l += 2 ) {

		const first = loops[ l ], count = loops[ l + 1 ];
		for ( let s = first; s < first + count; s ++ ) for ( let k = 0; k < SKIRT_RING; k ++ ) {

			ring( s, k );
			P.push( v.x, v.y, v.z );
			// Shaded turf under the thatch, mottled with moss and bare earth.
			const mottle = noise3( v.x * 3.1 + 2.2, v.y * 3.1, v.z * 3.1 - 1.4 ) * 0.5 + 0.5;
			meadowColor( v.x, v.z, col ).multiplyScalar( 0.55 + mottle * 0.3 );
			// The underside of the curl shows the dark root mat, not lit grass.
			const roots = Math.max( 0, ( k - 3 ) / 3 ) * ( 0.45 + 0.25 * noise3( v.x * 2.3, v.y * 2.3, v.z * 2.3 ) );
			col.lerp( earth, roots ).multiplyScalar( SHADE[ k ] );
			C.push( col.r, col.g, col.b );
			N.push( 0, 1, 0 ); B.push( 0 ); W.push( 0 );

		}
		for ( let s = 0; s < count; s ++ ) {

			// Closed loops wrap around; the traced iso-line returns to its start.
			const a = first + s, b = first + ( s + 1 ) % count;
			if ( Math.max( info[ a * 4 + 2 ], info[ b * 4 + 2 ] ) < 0.03 ) continue;
			if ( s === count - 1 && ring( a, 0 ).distanceTo( ring( b, 0, base ) ) > 0.2 ) continue;
			for ( let k = 0; k + 1 < SKIRT_RING; k ++ ) {

				const a0 = a * SKIRT_RING + k, a1 = a0 + 1, b0 = b * SKIRT_RING + k, b1 = b0 + 1;
				I.push( a0, b0, a1, a1, b0, b1 );

			}

		}

	}
	const bodyVertices = P.length / 3;

	// A tapered, slightly bent blade: two quads and a tip, 5 vertices.
	const blade = ( root: THREE.Vector3, direction: THREE.Vector3, length: number, width: number, bend: number, color: THREE.Color, n: THREE.Vector3 ) => {

		side.crossVectors( direction, n ).normalize();
		if ( side.lengthSq() < 0.5 ) side.set( 1, 0, 0 );
		const start = P.length / 3;
		const put = ( t: number, w: number, shade: number ) => {

			v.copy( root ).addScaledVector( direction, length * t ).addScaledVector( up, - bend * length * t * t ).addScaledVector( side, w );
			P.push( v.x, v.y, v.z );
			C.push( color.r * shade, color.g * shade, color.b * shade );
			N.push( n.x, n.y, n.z ); B.push( 1 ); W.push( t * t );

		};
		put( 0, - width, 0.62 ); put( 0, width, 0.62 );
		put( 0.5, - width * 0.62, 0.92 ); put( 0.5, width * 0.62, 0.92 );
		put( 1, 0, 1.12 );
		I.push( start, start + 1, start + 2, start + 1, start + 3, start + 2, start + 2, start + 3, start + 4 );
		blades ++;

	};
	const a = new THREE.Vector3(), b = new THREE.Vector3(), tangent = new THREE.Vector3(), out = new THREE.Vector3();
	for ( let l = 0; l < loops.length; l += 2 ) {

		const first = loops[ l ], count = loops[ l + 1 ];
		for ( let s = first; s < first + count; s ++ ) {

			const nx = info[ s * 4 ], nz = info[ s * 4 + 1 ], presence = info[ s * 4 + 2 ], droop = info[ s * 4 + 3 ];
			if ( presence < 0.12 ) continue;
			const along = new THREE.Vector3( - nz, 0, nx );
			out.set( nx, 0, nz );
			// The sod's outer face is a thatch of short blades over the dark root mat, as the meadow
			// is blades over turf: it reads as grass spilling over, not as a smooth green sheet.
			const n = Math.round( presence * ( 12 + rng() * 6 ) );
			for ( let i = 0; i < n; i ++ ) {

				// Where on the cross-section: shoulder to lower edge. Over the top of the curl they
				// stand up out of the sod, so its crest reads as tufts rather than a smooth sheet.
				const r = 1.6 + Math.pow( rng(), 0.8 ) * 4.3, k = Math.min( SKIRT_RING - 2, Math.floor( r ) ), f = r - k;
				ring( s, k, a ); ring( s, k + 1, b );
				base.lerpVectors( a, b, f ).addScaledVector( along, ( rng() - 0.5 ) * 0.05 );
				tangent.subVectors( b, a ).normalize();
				const low = Math.min( 1, Math.max( 0, ( r - 2.5 ) / 3 ) );
				dir.copy( tangent ).multiplyScalar( 0.55 ).addScaledVector( out, 0.55 - low * 0.25 )
					.addScaledVector( up, 0.8 - low * 1.25 ).addScaledVector( along, ( rng() - 0.5 ) * 0.8 ).normalize();
				meadowColor( base.x, base.z, col ).multiplyScalar( ( 0.8 + rng() * 0.35 ) * ( 1 - low * 0.3 ) );
				if ( rng() < 0.1 ) col.setRGB( 0.34, 0.29, 0.13 );
				normal.copy( out ).multiplyScalar( 0.5 ).addScaledVector( up, 1 - low * 0.6 ).normalize();
				blade( base, dir, ( 0.06 + rng() * 0.11 ) * ( 0.7 + presence * 0.4 ), 0.006 + rng() * 0.004, 0.3, col, normal );

			}
			// Lower edge: hanging grass and root hairs, the ragged end of the sod.
			if ( droop < 0.04 || rng() > 0.3 + presence * 0.5 ) continue;
			ring( s, 6, base ).lerp( ring( s, 5 ), rng() * 0.4 ).addScaledVector( along, ( rng() - 0.5 ) * 0.05 );
			const hair = rng() < 0.4;
			dir.copy( out ).multiplyScalar( 0.15 + rng() * 0.25 ).addScaledVector( up, - 1 ).addScaledVector( along, ( rng() - 0.5 ) * 0.5 ).normalize();
			if ( hair ) col.setRGB( 0.13, 0.095, 0.05 ).multiplyScalar( 0.8 + rng() * 0.4 );
			else meadowColor( base.x, base.z, col ).multiplyScalar( 0.6 + rng() * 0.3 );
			normal.set( nx, 0.3, nz ).normalize();
			blade( base, dir, ( hair ? 0.05 + rng() * 0.12 : 0.06 + rng() * 0.14 ) * ( 0.7 + droop ), hair ? 0.0025 : 0.005, - 0.1, col, normal );

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( P, 3 ) );
	geometry.setAttribute( 'normal', new THREE.Float32BufferAttribute( N, 3 ) );
	geometry.setAttribute( 'color', new THREE.Float32BufferAttribute( C, 3 ) );
	geometry.setAttribute( 'skirtBlade', new THREE.Float32BufferAttribute( B, 1 ) );
	geometry.setAttribute( 'skirtSway', new THREE.Float32BufferAttribute( W, 1 ) );
	geometry.setIndex( I );
	// Smooth normals for the sod sheet only; blades keep their soft, upward-leaning normals.
	const blade0 = new Float32Array( N.slice( bodyVertices * 3 ) );
	geometry.computeVertexNormals();
	const normals = geometry.getAttribute( 'normal' ) as THREE.BufferAttribute;
	( normals.array as Float32Array ).set( blade0, bodyVertices * 3 );
	geometry.computeBoundingSphere();

	const mesh = new THREE.Mesh( geometry, skirtMaterial( shared ) );
	mesh.name = 'turfSkirt';
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	// Like the other vegetation: drawn before the terrain, so the rim's turf under it fails the depth test.
	mesh.renderOrder = - 1;
	mesh.userData = { blades, triangles: I.length / 3 };
	return mesh;

}

function skirtMaterial( shared: Shared ): THREE.MeshStandardNodeMaterial {

	const mat = new THREE.MeshStandardNodeMaterial( { vertexColors: true, side: THREE.DoubleSide, roughness: 0.93, metalness: 0 } );
	const wetness = clamp( shared.wetness, 0, 1 );
	const wetTint = mix( 1, 0.9, wetness );
	mat.colorNode = materialColor.mul( vec4( wetTint, wetTint, wetTint, 1 ) );
	mat.roughnessNode = mix( 0.93, 0.74, wetness );
	const blade = attribute<'float'>( 'skirtBlade', 'float' ), sway = attribute<'float'>( 'skirtSway', 'float' );
	const wind = shared.wind.direction;
	const phase = shared.wind.phase.mul( 1.3 ).add( dot( positionLocal.xz, vec2( 2.1, 1.7 ) ) );
	const swayed = positionLocal.add( vec3( wind.x, 0.25, wind.y ).mul( sin( phase ).mul( sway ).mul( shared.wind.strength ).mul( 0.012 ) ) );
	// Blades are a few millimetres wide, far under a shadow texel: only the sod casts.
	useRestPoseShadows( mat, positionLocal, swayed, float( 1 ).sub( blade ) );
	useLighting( mat, () => new VegetationLighting( float( 1 ), ( L, V ) =>
		pow( clamp( dot( V.negate(), L ), 0, 1 ), 4 ).mul( 0.4 ).add( 0.03 ).mul( blade ) ) );
	mat.name = 'turfSkirt';
	return mat;

}
