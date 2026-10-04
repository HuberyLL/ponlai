import * as THREE from 'three/webgpu';
import { attribute, positionLocal, normalViewGeometry, vec3, float, mix, sin, cos, dot, pow, clamp } from 'three/tsl';
import { leafTexture, leafAlphaTexture } from './Foliage.ts';
import { VegetationLighting, useLighting } from './VegetationLighting.ts';
import { useRestPoseShadows } from './VegetationShadow.ts';
import { mulberry32, smoothstep } from './noise.ts';
import type { Shared } from '../shared.ts';
import type { RimStrand } from './types.ts';

interface StrandNode { point: THREE.Vector3; outward: THREE.Vector3; distance: number }

function strandNodes( strand: RimStrand ): StrandNode[] {

	const nodes: StrandNode[] = [];
	let distance = 0;
	for ( let i = 0; i + 5 < strand.points.length; i += 6 ) {

		const point = new THREE.Vector3().fromArray( strand.points, i );
		const outward = new THREE.Vector3().fromArray( strand.points, i + 3 ).normalize();
		if ( ! [ point.x, point.y, point.z, outward.x, outward.y, outward.z ].every( Number.isFinite ) ) return [];
		if ( outward.lengthSq() < 0.5 ) outward.set( 0, 1, 0 );
		if ( nodes.length ) distance += point.distanceTo( nodes[ nodes.length - 1 ].point );
		nodes.push( { point, outward, distance } );

	}
	return nodes;

}

function closestBush( root: THREE.Vector3, foliage: THREE.InstancedMesh | undefined, fallback: THREE.Color ): { color: THREE.Color; scale: number; distance: number } {

	const color = fallback.clone();
	if ( ! foliage?.instanceColor ) return { color, scale: 0.75, distance: Infinity };
	const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3();
	let closest = Infinity, index = - 1, leafScale = 0.75;
	for ( let i = 0; i < foliage.count; i ++ ) {

		foliage.getMatrixAt( i, matrix );
		position.setFromMatrixPosition( matrix );
		const distance = position.distanceToSquared( root );
		if ( distance < closest ) { closest = distance; index = i; scale.setFromMatrixScale( matrix ); leafScale = Math.sqrt( scale.x * scale.z ); }

	}
	if ( index >= 0 ) foliage.getColorAt( index, color );
	return { color, scale: index >= 0 ? leafScale : 0.75, distance: Math.sqrt( closest ) };

}

function rimMaterial( shared: Shared, foliage?: THREE.InstancedMesh ): THREE.MeshStandardNodeMaterial {

	const source = Array.isArray( foliage?.material ) ? foliage.material[ 0 ] : foliage?.material;
	const mat = source instanceof THREE.MeshStandardNodeMaterial ? source.clone() : new THREE.MeshStandardNodeMaterial( {
		map: leafTexture(), alphaTest: 0.3, alphaToCoverage: true, side: THREE.DoubleSide,
		roughness: 0.82, metalness: 0, vertexColors: true,
	} );
	// Reusing both silhouettes also keeps the shadow pass consistent with the existing bush.
	if ( ! mat.alphaMap ) mat.alphaMap = leafAlphaTexture( mat.map as THREE.CanvasTexture );
	const weight = attribute( 'rimSway', 'float' );
	const phase = attribute( 'rimPhase', 'float' ).sub( shared.time.mul( 1.3 ) );
	// The cloned bush material has shadow hooks for its own wind graph. Replace both
	// hooks with this mesh's rest pose, keeping its visible 4.8 mm sway unchanged.
	useRestPoseShadows( mat, positionLocal, positionLocal.add( vec3( sin( phase ), sin( phase.mul( 0.83 ) ).mul( 0.10 ), cos( phase.mul( 0.91 ) ) )
		.mul( weight.mul( 0.0048 ) ) ) );
	mat.normalNode = normalViewGeometry;
	mat.aoNode = mix( float( 0.72 ), float( 0.96 ), weight );
	useLighting( mat, () => new VegetationLighting( float( 0.94 ), ( L, V, N ) => {

		const back = pow( clamp( dot( V.negate(), L ), 0, 1 ), 4 );
		const rim = float( 1 ).sub( clamp( dot( N, V ), 0, 1 ) );
		const wrap = clamp( dot( N, L ).mul( 0.5 ).add( 0.5 ), 0, 1 );
		return wrap.mul( wrap ).mul( 0.13 ).add( back.mul( rim.mul( rim ).mul( 0.9 ).add( 0.1 ) ) );

	} ) );
	mat.name = 'rimFoliage';
	return mat;

}

export function buildRimFoliage( strands: RimStrand[], shared: Shared, foliage?: THREE.InstancedMesh ): THREE.Group {

	const group = new THREE.Group();
	group.name = 'rimFoliage';
	const P: number[] = [], U: number[] = [], C: number[] = [], E: number[] = [], W: number[] = [], F: number[] = [], I: number[] = [];
	const up = new THREE.Vector3( 0, 1, 0 );
	const palette = [ [ 0.065, 0.16, 0.04 ], [ 0.095, 0.19, 0.048 ], [ 0.15, 0.205, 0.046 ], [ 0.04, 0.12, 0.043 ], [ 0.18, 0.22, 0.058 ] ];
	const point = new THREE.Vector3(), outward = new THREE.Vector3(), tangent = new THREE.Vector3(), lateral = new THREE.Vector3();
	const normal = new THREE.Vector3(), along = new THREE.Vector3(), width = new THREE.Vector3(), vertex = new THREE.Vector3(), radial = new THREE.Vector3();
	let leafCount = 0, strandCount = 0, sprayCount = 0, rootClusterCount = 0;
	const add = ( p: THREE.Vector3, u: number, v: number, color: THREE.Color, shade: number, envelope: THREE.Vector3, weight: number, phase: number ) => {

		P.push( p.x, p.y, p.z ); U.push( u, v );
		C.push( color.r * shade, color.g * shade, color.b * shade );
		E.push( envelope.x, envelope.y, envelope.z ); W.push( weight ); F.push( phase );

	};
	for ( const strand of strands ) {

		const nodes = strandNodes( strand );
		if ( nodes.length < 2 || nodes[ nodes.length - 1 ].distance < 0.08 ) continue;
		const rng = mulberry32( strand.seed );
		const length = nodes[ nodes.length - 1 ].distance, phase = rng() * Math.PI * 2;
		const bush = closestBush( nodes[ 0 ].point, foliage, new THREE.Color( ...palette[ Math.floor( rng() * palette.length ) ] as [ number, number, number ] ) );
		const stemColor = new THREE.Color( 0.08, 0.057, 0.022 );
		const sway = ( t: number ) => t * t * smoothstep( 0, 0.18, t );
		const sample = ( t: number ) => {

			const distance = t * length;
			let i = 0;
			while ( i + 2 < nodes.length && nodes[ i + 1 ].distance < distance ) i ++;
			const a = nodes[ i ], b = nodes[ i + 1 ];
			const f = ( distance - a.distance ) / Math.max( 0.0001, b.distance - a.distance );
			point.lerpVectors( a.point, b.point, f );
			outward.lerpVectors( a.outward, b.outward, f ).normalize();
			tangent.subVectors( b.point, a.point ).normalize();
			lateral.crossVectors( tangent, outward ).normalize();
			if ( lateral.lengthSq() < 0.5 ) lateral.crossVectors( up, outward ).normalize();
			if ( lateral.lengthSq() < 0.5 ) lateral.set( 1, 0, 0 );

		};
		// Small polygonal stems expose real branch silhouettes between the separate leaves.
		// Their shared phase and arc-length weights keep every attachment together in wind.
		const stemStart = P.length / 3;
		for ( let i = 0; i < nodes.length; i ++ ) {

			const t = nodes[ i ].distance / length;
			sample( t );
			width.crossVectors( tangent, lateral ).normalize();
			const radius = 0.0045 * ( 1 - t ) + 0.0015 * t;
			for ( let side = 0; side < 4; side ++ ) {

				const angle = side * Math.PI / 2;
				radial.copy( lateral ).multiplyScalar( Math.cos( angle ) ).addScaledVector( width, Math.sin( angle ) );
				vertex.copy( point ).addScaledVector( radial, radius );
				add( vertex, 0.5, 0.5, stemColor, 0.85 + t * 0.15, radial, sway( t ), phase );

			}
			if ( i === 0 ) continue;
			for ( let side = 0; side < 4; side ++ ) {

				const a = stemStart + ( i - 1 ) * 4 + side, b = stemStart + ( i - 1 ) * 4 + ( side + 1 ) % 4;
				const c = stemStart + i * 4 + side, d = stemStart + i * 4 + ( side + 1 ) % 4;
				I.push( a, b, c, b, d, c );

			}

		}
		const leaf = ( anchor: THREE.Vector3, direction: THREE.Vector3, surface: THREE.Vector3, t: number, side: number, windT = t ) => {

			point.copy( anchor ); outward.copy( surface ); tangent.copy( direction );
			lateral.crossVectors( tangent, outward ).normalize();
			if ( lateral.lengthSq() < 0.5 ) lateral.set( 1, 0, 0 );
			const origin = point.clone().addScaledVector( outward, 0.040 ).addScaledVector( lateral, side * 0.006 );
			normal.copy( outward ).multiplyScalar( 0.88 ).addScaledVector( up, 0.28 ).addScaledVector( lateral, ( rng() - 0.5 ) * 0.18 ).normalize();
			along.copy( lateral ).multiplyScalar( side ).addScaledVector( tangent, 0.25 + rng() * 0.25 ).addScaledVector( outward, 0.30 );
			along.addScaledVector( normal, - along.dot( normal ) ).normalize();
			width.crossVectors( normal, along ).normalize();
			const baseLength = Math.max( 0.11, Math.min( 0.17, ( 0.17 + rng() * 0.045 ) * bush.scale * 1.10 ) );
			const hangingProgress = Math.max( 0, ( t - lipT ) / Math.max( 0.001, 1 - lipT ) );
			const terminal = 0.07 + rng() * 0.04, taper = smoothstep( 0.73, 0.99, hangingProgress );
			const L = baseLength * ( 1 - taper ) + terminal * taper;
			const B = L * ( 0.46 + rng() * 0.12 ), fold = L * ( 0.08 + rng() * 0.07 ), shade = 0.84 + rng() * 0.18;
			// A small real stalk connects each individual blade to the woody spray.
			const stalk = P.length / 3;
			add( vertex.copy( point ).addScaledVector( width, - 0.0012 ), 0.5, 0.5, stemColor, 0.85, normal, sway( windT ), phase );
			add( vertex.copy( point ).addScaledVector( width, 0.0012 ), 0.5, 0.5, stemColor, 0.85, normal, sway( windT ), phase );
			add( vertex.copy( origin ).addScaledVector( width, 0.0006 ), 0.5, 0.5, stemColor, 1, normal, sway( windT ), phase );
			add( vertex.copy( origin ).addScaledVector( width, - 0.0006 ), 0.5, 0.5, stemColor, 1, normal, sway( windT ), phase );
			I.push( stalk, stalk + 1, stalk + 2, stalk, stalk + 2, stalk + 3 );
			const base = P.length / 3;
			const leafVertex = ( length: number, breadth: number, lift: number, u: number, v: number, brightness: number ) => {

				vertex.copy( origin ).addScaledVector( along, length ).addScaledVector( width, breadth ).addScaledVector( normal, lift );
				// Folded wings remain outside the traced local wall, even at maximum tip wind.
				const clearance = ( vertex.x - point.x ) * outward.x + ( vertex.y - point.y ) * outward.y + ( vertex.z - point.z ) * outward.z;
				if ( clearance < 0.025 ) vertex.addScaledVector( outward, 0.025 - clearance );
				add( vertex, u, v, bush.color, shade * brightness, normal, sway( windT ), phase );

			};
			// The same five-vertex fold, raised midrib and curved tip as the existing bush.
			leafVertex( 0, 0, 0, 0.5, 0, 0.82 );
			leafVertex( L * 0.48, - B * 0.5, 0, 0, 0.5, 1 );
			leafVertex( L * 0.51, 0, fold, 0.5, 0.5, 1.03 );
			leafVertex( L * 0.48, B * 0.5, 0, 1, 0.5, 1 );
			leafVertex( L, 0, fold * 0.32, 0.5, 1, 1.04 );
			I.push( base, base + 1, base + 2, base + 1, base + 4, base + 2, base, base + 2, base + 3, base + 2, base + 4, base + 3 );
			leafCount ++;

		};
		const lip = Math.max( 1, Math.min( nodes.length - 1, strand.lip ) );
		const lipT = nodes[ lip ].distance / length;
		// Meadow-rooted trails borrow the nearest shrub's palette. A few low folded leaves on
		// the existing root stem conceal an exposed attachment without adding a separate bush.
		if ( bush.distance > Math.max( 0.30, bush.scale * 0.88 ) ) {

			const leaves = 3 + Math.floor( rng() * 3 );
			const rotation = rng() * Math.PI * 2;
			for ( let i = 0; i < leaves; i ++ ) {

				const node = nodes[ 1 + i % Math.min( 3, lip ) ];
				const angle = rotation + i / leaves * Math.PI * 2 + ( rng() - 0.5 ) * 0.45;
				const direction = new THREE.Vector3( Math.cos( angle ), 0.14, Math.sin( angle ) ).normalize();
				leaf( node.point, direction, node.outward, 0, i % 2 ? - 1 : 1, 0 );

			}
			rootClusterCount ++;

		}
		const hiddenPairs = 2 + Math.floor( rng() * 2 );
		const spacing = 0.065 + rng() * 0.021;
		const visiblePairs = Math.max( 4, Math.min( 19, Math.round( ( length - nodes[ lip ].distance ) / spacing ) ) );
		// The hidden root arc gets only a few leaves. Most foliage belongs beyond the lip,
		// where irregular opposing pairs form small hanging sprays rather than sparse bead chains.
		for ( const [ begin, end, pairs ] of [ [ 0.07, lipT, hiddenPairs ], [ lipT, 0.98, visiblePairs ] ] ) {

			for ( let pair = 0; pair < pairs; pair ++ ) {

				const t = begin + ( end - begin ) * ( pair + 0.22 + rng() * 0.65 ) / ( pairs + 0.25 );
				const hangingProgress = Math.max( 0, ( t - lipT ) / Math.max( 0.001, 1 - lipT ) );
				for ( const side of [ - 1, 1 ] ) {

					if ( side > 0 && rng() < 0.12 + smoothstep( 0.72, 0.98, hangingProgress ) * 0.55 ) continue;
					const leafT = Math.min( 0.985, Math.max( 0.04, t + ( rng() - 0.5 ) * spacing / length * 0.42 ) );
					sample( leafT );
					leaf( point, tangent, outward, leafT, side );

				}

			}

		}
		const hangingLength = length - nodes[ lip ].distance;
		const sprays = rng() < 0.76 ? ( rng() < ( hangingLength > 0.80 ? 0.40 : 0.20 ) ? 2 : 1 ) : 0;
		for ( let spray = 0; spray < sprays; spray ++ ) {

			const t = lipT + ( 1 - lipT ) * ( 0.08 + rng() * 0.32 + spray * ( 0.06 + rng() * 0.14 ) );
			sample( t );
			if ( outward.y > 0.65 ) continue;
			const root = point.clone(), surface = outward.clone();
			const side = spray ? - 1 : rng() < 0.5 ? - 1 : 1;
			const direction = lateral.clone().multiplyScalar( side * ( 0.52 + rng() * 0.30 ) ).addScaledVector( outward, 0.58 + rng() * 0.17 ).addScaledVector( tangent, 0.20 + rng() * 0.22 );
			direction.y -= 0.30;
			if ( direction.dot( surface ) < 0.32 ) direction.addScaledVector( surface, 0.32 - direction.dot( surface ) );
			direction.normalize();
			const extent = 0.11 + rng() * 0.10, forkStart = P.length / 3;
			lateral.crossVectors( direction, surface ).normalize();
			width.crossVectors( direction, lateral ).normalize();
			for ( let ring = 0; ring < 4; ring ++ ) {

				const u = ring / 3, radius = 0.0026 * ( 1 - u ) + 0.0012 * u;
				for ( let side = 0; side < 4; side ++ ) {

					const angle = side * Math.PI / 2;
					radial.copy( lateral ).multiplyScalar( Math.cos( angle ) ).addScaledVector( width, Math.sin( angle ) );
					vertex.copy( root ).addScaledVector( direction, extent * u ).addScaledVector( radial, radius );
					add( vertex, 0.5, 0.5, stemColor, 0.90, radial, sway( Math.min( 1, t + u * 0.04 ) ), phase );

				}
				if ( ring === 0 ) continue;
				for ( let side = 0; side < 4; side ++ ) {

					const a = forkStart + ( ring - 1 ) * 4 + side, b = forkStart + ( ring - 1 ) * 4 + ( side + 1 ) % 4;
					const c = forkStart + ring * 4 + side, d = forkStart + ring * 4 + ( side + 1 ) % 4;
					I.push( a, b, c, b, d, c );

				}

			}
			const leaves = 3 + Math.floor( rng() * 3 );
			for ( let i = 0; i < leaves; i ++ ) {

				const u = ( i + 0.45 + rng() * 0.30 ) / leaves;
				const anchor = root.clone().addScaledVector( direction, extent * u );
				leaf( anchor, direction, surface, t, i % 2 ? - side : side, Math.min( 1, t + u * 0.04 ) );

			}
			sprayCount ++;

		}
		strandCount ++;

	}
	group.userData = { strands: strandCount, leaves: leafCount, sprays: sprayCount, rootClusters: rootClusterCount, maxWind: 0.007 };
	if ( ! P.length ) return group;
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( P, 3 ) );
	geometry.setAttribute( 'uv', new THREE.Float32BufferAttribute( U, 2 ) );
	geometry.setAttribute( 'color', new THREE.Float32BufferAttribute( C, 3 ) );
	geometry.setAttribute( 'rimSway', new THREE.Float32BufferAttribute( W, 1 ) );
	geometry.setAttribute( 'rimPhase', new THREE.Float32BufferAttribute( F, 1 ) );
	geometry.setIndex( I );
	geometry.computeVertexNormals();
	const normals = geometry.getAttribute( 'normal' );
	for ( let i = 0; i < normals.count; i ++ ) {

		normal.fromBufferAttribute( normals, i ).multiplyScalar( 0.82 ).addScaledVector( outward.fromArray( E, i * 3 ), 0.18 ).normalize();
		normals.setXYZ( i, normal.x, normal.y, normal.z );

	}
	geometry.computeBoundingSphere();
	geometry.boundingSphere!.radius += 0.01;
	const mesh = new THREE.Mesh( geometry, rimMaterial( shared, foliage ) );
	mesh.name = 'rimFoliageLeaves';
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	mesh.renderOrder = - 1;
	group.add( mesh );
	return group;

}
