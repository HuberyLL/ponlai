import * as THREE from 'three/webgpu';
import { attribute, positionLocal, positionGeometry, normalGeometry, normalViewGeometry, materialColor, uv, vec3, vec4, float, fract, mix, dot, pow, clamp, max } from 'three/tsl';
import { LEAN_REF, gustWave, setWindDisplacement, swingOf, wave, windField } from '../weather/Wind.ts';

const TAU = Math.PI * 2;
import { followWindMotionFlag } from './WindMotion.ts';
import { showSway } from '../debug/WindView.ts';
import { boundsSteps, float32Steps, indexSteps, Growing } from './Steps.ts';
import { leafTexture, leafAlphaTexture, LEAF_ALPHA_TEST, ALPHA_TO_COVERAGE, LEAF_STEM, leafCastMask, markVegetation, useLeafCoverage } from './Foliage.ts';
import { VegetationLighting, useLighting } from './VegetationLighting.ts';
import { previousSway, useRestPoseShadows } from './VegetationShadow.ts';
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

// The trails' sway at their tips (m) at a fair day's typical gust (see LEAN_REF): about 2 cm in a
// fair gust, 8 - 10 cm in a gale's. Their nodes hang 0.11 m off the stone and their leaves a
// little further, so they may be pressed toward the wall by at most PRESS (m).
const RIM_SWAY = 0.012;
const PRESS = 0.03;
const LEAF_EDGE = 0.004;

function rimMaterial( shared: Shared, foliage?: THREE.InstancedMesh ): THREE.MeshStandardNodeMaterial {

	const source = Array.isArray( foliage?.material ) ? foliage.material[ 0 ] : foliage?.material;
	const mat = source instanceof THREE.MeshStandardNodeMaterial ? source.clone() : new THREE.MeshStandardNodeMaterial( {
		map: leafTexture(), alphaTest: LEAF_ALPHA_TEST, alphaToCoverage: ALPHA_TO_COVERAGE, side: THREE.DoubleSide,
		roughness: 0.82, metalness: 0, vertexColors: true,
	} );
	// Reusing both silhouettes also keeps the shadow pass consistent with the existing bush.
	if ( ! mat.alphaMap ) mat.alphaMap = leafAlphaTexture();
	markVegetation( mat );
	// (the clone keeps no numeric alphaTest: three's NodeMaterial.copy skips Material's setter, so
	// the shadow passes and 4x cut these leaves by their alpha alone; under the temporal modes the
	// coverage band is set here and cuts them at the bush's cutoff)
	useLeafCoverage( mat );
	const wetness = clamp( shared.wetness, 0, 1 );
	const wetTint = mix( 1, 0.92, wetness );
	// Replace the cloned colour graph so wetness applies once, including the fallback material.
	mat.colorNode = materialColor.mul( vec4( wetTint, wetTint, wetTint, 1 ) );
	mat.roughnessNode = mix( 0.82, 0.68, wetness );
	const weight = attribute( 'rimSway', 'float' );
	const strandPhase = attribute( 'rimPhase', 'float' );
	// A hanging strand leans with the gust field and swings like a pendulum (1.5 - 2.6 m: about
	// 0.4 Hz, 14 swings per gust tile) with the plants about it (Wind.ts `gustWave`), its own
	// phase a little apart, its forks with it; its leaves flutter along their normals from
	// stalk to tip on their own phase. The wall bounds it: wind into the cliff presses the
	// strand back by at most PRESS, and a gust lifts it off the stone a little.
	const out = attribute<'vec3'>( 'rimOut', 'vec3' );
	const leafEdge = float( 1 ).sub( attribute<'float'>( LEAF_STEM, 'float' ) ).mul( uv().y );
	const leafPhase = strandPhase.mul( 3 ).add( dot( positionGeometry, vec3( 9.1, 7.3, 8.7 ) ) );
	let sway: THREE.Node<'vec2'> | undefined;
	const swayed = setWindDisplacement( mat, ( wind ) => {

		const field = windField( wind, positionLocal.xz ).toVar();
		const along = vec3( field.x, 0, field.y ), across = vec3( field.y.negate(), 0, field.x );
		const lively = wind.breeze.mul( field.w.mul( 0.6 ).add( 0.3 ) );
		const own = fract( strandPhase.div( TAU ) ).sub( 0.5 ).mul( 0.8 );
		const swing = swingOf( wind, field.w ).mul( 1.5 );
		const unit = along.mul( field.z.div( LEAN_REF ).add( gustWave( wind, positionLocal.xz, 14, own ).mul( swing ) ) )
			.add( across.mul( gustWave( wind, positionLocal.xz, 10, own.mul( 1.6 ).add( 1.3 ) ).mul( swing ).mul( 0.35 ) ) );
		if ( wind === shared.wind ) sway = unit.xz.mul( LEAN_REF );
		const free = unit.mul( weight.mul( RIM_SWAY ) ).toVar();
		const offset = free.add( out.mul( max( float( - PRESS ).sub( dot( free, out ) ), 0 ).add( field.w.mul( wind.breeze ).mul( weight ).mul( 0.01 ) ) ) );
		const flutter = wave( wind.flutter, 3.7, leafPhase );
		return positionLocal.add( offset ).add( normalGeometry.mul( flutter.mul( leafEdge ).mul( lively ).mul( LEAF_EDGE ) ) );

	}, shared.wind );
	// The cloned bush material has shadow hooks for its own wind graph. Replace both
	// hooks with this mesh's rest pose.
	useRestPoseShadows( mat, positionLocal, swayed, leafCastMask(), previousSway( mat, shared.wind ) );
	if ( sway ) showSway( mat, sway, shared.wind );
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
	const steps = rimFoliageSteps( strands );
	let next = steps.next();
	while ( ! next.done ) next = steps.next();
	const built = next.value;
	group.userData = built.counts;
	if ( ! built.geometry ) return group;
	const mesh = new THREE.Mesh( built.geometry, rimMaterial( shared, foliage ) );
	followWindMotionFlag( mesh.material as THREE.Material );
	mesh.name = 'rimFoliageLeaves';
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	mesh.renderOrder = - 1;
	group.add( mesh );
	return group;

}

/** The trails' geometry (null: no strand drew), and their counts (strands, leaves, sprays, root
 * clusters, clumps). */
export interface RimFoliageBuilt { geometry: THREE.BufferGeometry | null; counts: Record<string, number> }

/** Swaps the trails of `group` (buildRimFoliage) to `built` in place, the depth prepass's copy with
 * them. Returns the geometry replaced, to dispose of once nothing draws it (null: none). */
export function setRimFoliage( group: THREE.Group, built: RimFoliageBuilt ): THREE.BufferGeometry | null {

	group.userData = built.counts;
	const mesh = group.children[ 0 ] as THREE.Mesh | undefined;
	if ( ! mesh ) {

		if ( built.geometry ) console.warn( 'The rim trails had no mesh on the first land: a grown island\'s trails are not drawn (RimFoliage.ts)' );
		return null;

	}
	const old = mesh.geometry;
	const geometry = built.geometry ?? emptyGeometry( old );
	mesh.geometry = geometry;
	for ( const child of mesh.children ) if ( ( child as THREE.Mesh ).geometry === old ) ( child as THREE.Mesh ).geometry = geometry;
	mesh.visible = built.geometry !== null;
	return old;

}

// A geometry with the attributes of `like` and nothing to draw.
function emptyGeometry( like: THREE.BufferGeometry ): THREE.BufferGeometry {

	const geometry = new THREE.BufferGeometry();
	for ( const [ name, attribute ] of Object.entries( like.attributes ) ) geometry.setAttribute( name, new THREE.BufferAttribute( new Float32Array( attribute.itemSize ), attribute.itemSize ) );
	geometry.setIndex( [] );
	return geometry;

}

/** The trails' geometry in steps (a generator, `per` strands a step, then its arrays and normals in
 * parts), so the growth (Growth.ts) builds a grown island's in idle time; `buildRimFoliage` runs it
 * to the end. The result is the same however it is stepped. */
export function* rimFoliageSteps( strands: RimStrand[], per = Infinity ): Generator<void, RimFoliageBuilt> {

	// each drawn strand's first vertex and index (its vertices and triangles are its own)
	const blocks: number[] = [];
	const P = new Growing(), U = new Growing(), C = new Growing(), E = new Growing(), W = new Growing(), F = new Growing(), S = new Growing(), I = new Growing();
	const O = new Growing(); // the wall's outward normal where the vertex hangs, for the wind
	const up = new THREE.Vector3( 0, 1, 0 );
	const point = new THREE.Vector3(), outward = new THREE.Vector3(), tangent = new THREE.Vector3(), lateral = new THREE.Vector3();
	const normal = new THREE.Vector3(), along = new THREE.Vector3(), width = new THREE.Vector3(), vertex = new THREE.Vector3(), radial = new THREE.Vector3();
	let leafCount = 0, strandCount = 0, sprayCount = 0, rootClusterCount = 0, clumpCount = 0;
	// Per strand, what its forks continue from: wind phase, the sway weight and hanging progress at
	// each node, and its leaf colour and scale.
	const built = new Map<number, { phase: number; weights: number[]; progress: number[]; color: THREE.Color; scale: number }>();
	const add = ( p: THREE.Vector3, u: number, v: number, color: THREE.Color, shade: number, envelope: THREE.Vector3, weight: number, phase: number, stem = false ) => {

		P.push( p.x, p.y, p.z ); U.push( u, v );
		C.push( color.r * shade, color.g * shade, color.b * shade );
		E.push( envelope.x, envelope.y, envelope.z ); W.push( weight ); F.push( phase ); S.push( stem ? 1 : 0 );
		O.push( outward.x, outward.y, outward.z );

	};
	for ( let index = 0; index < strands.length; index ++ ) {

		if ( index > 0 && index % per === 0 ) yield;
		const strand = strands[ index ];
		const nodes = strandNodes( strand );
		if ( nodes.length < 2 || nodes[ nodes.length - 1 ].distance < 0.08 ) continue;
		const rng = mulberry32( strand.seed );
		const parent = strand.parent !== undefined ? built.get( strand.parent ) : undefined;
		const fork = parent !== undefined;
		const from = Math.min( strand.from ?? 0, ( parent?.weights.length ?? 1 ) - 1 );
		const length = nodes[ nodes.length - 1 ].distance;
		// A fork moves with its parent: same phase, and its sway starts from the parent's at the joint.
		const ownPhase = rng() * Math.PI * 2, phase = parent ? parent.phase : ownPhase;
		// the leaves of the bush the worker found beside the root (RimTrails' `leaf`)
		const [ r, g, b, scale, distance ] = strand.leaf ?? [ 0, 0, 0, 0.75, Infinity ];
		const bush = parent ? { color: parent.color, scale: parent.scale, distance: 0 } : { color: new THREE.Color( r, g, b ), scale, distance };
		const stemColor = new THREE.Color( 0.08, 0.057, 0.022 );
		const w0 = parent ? parent.weights[ from ] : 0, p0 = parent ? parent.progress[ from ] : 0;
		const sway = ( t: number ) => w0 + ( 1 - w0 ) * t * t * smoothstep( 0, 0.18, t );
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
			const radius = ( fork ? 0.0026 : 0.0045 ) * ( 1 - t ) + 0.0013 * t;
			for ( let side = 0; side < 4; side ++ ) {

				const angle = side * Math.PI / 2;
				radial.copy( lateral ).multiplyScalar( Math.cos( angle ) ).addScaledVector( width, Math.sin( angle ) );
				vertex.copy( point ).addScaledVector( radial, radius );
				add( vertex, 0.5, 0.5, stemColor, 0.85 + t * 0.15, radial, sway( t ), phase, true );

			}
			if ( i === 0 ) continue;
			for ( let side = 0; side < 4; side ++ ) {

				const a = stemStart + ( i - 1 ) * 4 + side, b = stemStart + ( i - 1 ) * 4 + ( side + 1 ) % 4;
				const c = stemStart + i * 4 + side, d = stemStart + i * 4 + ( side + 1 ) % 4;
				I.push( a, b, c, b, d, c );

			}

		}
		const leaf = ( anchor: THREE.Vector3, direction: THREE.Vector3, surface: THREE.Vector3, t: number, side: number, windT = t, size?: number ) => {

			point.copy( anchor ); outward.copy( surface ); tangent.copy( direction );
			lateral.crossVectors( tangent, outward ).normalize();
			if ( lateral.lengthSq() < 0.5 ) lateral.set( 1, 0, 0 );
			const origin = point.clone().addScaledVector( outward, 0.040 ).addScaledVector( lateral, side * 0.006 );
			normal.copy( outward ).multiplyScalar( 0.88 ).addScaledVector( up, 0.28 ).addScaledVector( lateral, ( rng() - 0.5 ) * 0.18 ).normalize();
			along.copy( lateral ).multiplyScalar( side ).addScaledVector( tangent, 0.25 + rng() * 0.25 ).addScaledVector( outward, 0.30 );
			along.addScaledVector( normal, - along.dot( normal ) ).normalize();
			width.crossVectors( normal, along ).normalize();
			const baseLength = Math.max( 0.11, Math.min( 0.17, ( 0.17 + rng() * 0.045 ) * bush.scale * 1.10 ) );
			// Leaves shrink from the lip toward the tip (1.3x to 0.6x), as on a real trailing shoot;
			// a fork carries on from its parent's progress at the joint.
			const L = baseLength * ( size ?? 1.3 - 0.7 * progressAt( t ) );
			const B = L * ( 0.46 + rng() * 0.12 ), fold = L * ( 0.08 + rng() * 0.07 ), shade = 0.84 + rng() * 0.18;
			// A small real stalk connects each individual blade to the woody spray.
			const stalk = P.length / 3;
			add( vertex.copy( point ).addScaledVector( width, - 0.0012 ), 0.5, 0.5, stemColor, 0.85, normal, sway( windT ), phase, true );
			add( vertex.copy( point ).addScaledVector( width, 0.0012 ), 0.5, 0.5, stemColor, 0.85, normal, sway( windT ), phase, true );
			add( vertex.copy( origin ).addScaledVector( width, 0.0006 ), 0.5, 0.5, stemColor, 1, normal, sway( windT ), phase, true );
			add( vertex.copy( origin ).addScaledVector( width, - 0.0006 ), 0.5, 0.5, stemColor, 1, normal, sway( windT ), phase, true );
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
		const lip = fork ? 0 : Math.max( 1, Math.min( nodes.length - 1, strand.lip ) );
		const lipT = nodes[ lip ].distance / length;
		const progressAt = ( t: number ) => p0 + ( 1 - p0 ) * Math.max( 0, ( t - lipT ) / Math.max( 0.001, 1 - lipT ) );
		built.set( index, { phase, weights: nodes.map( ( n ) => sway( n.distance / length ) ), progress: nodes.map( ( n ) => progressAt( n.distance / length ) ), color: bush.color, scale: bush.scale } );
		// The patch's mound over the lip, swaying a little: its leaves stay a little under the trails'
		// at the lip, so it reads as a low mound rather than a coarse-leaved bush.
		if ( strand.clump ) {

			const anchor = new THREE.Vector3(), surface = new THREE.Vector3(), direction = new THREE.Vector3();
			for ( let i = 0; i + 5 < strand.clump.length; i += 6 ) {

				anchor.fromArray( strand.clump, i );
				surface.fromArray( strand.clump, i + 3 ).normalize();
				direction.set( rng() - 0.5, - 0.3 - rng() * 0.4, rng() - 0.5 ).addScaledVector( surface, 0.8 );
				direction.addScaledVector( surface, - direction.dot( surface ) ).normalize();
				if ( direction.lengthSq() < 0.5 ) direction.set( 1, 0, 0 );
				leaf( anchor, direction, surface, 0, i % 12 ? 1 : - 1, 0.12 + rng() * 0.1, 0.95 + rng() * 0.25 );
				if ( i % ( 6 * 64 ) === 6 * 63 ) yield;

			}
			clumpCount ++;

		}
		// Meadow-rooted trails borrow the nearest bush's palette. A few low folded leaves on the
		// existing root stem conceal an exposed attachment where no bush stands close.
		if ( ! fork && bush.distance > Math.max( 0.30, bush.scale * 0.88 ) ) {

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
		const hiddenPairs = fork ? 0 : 2 + Math.floor( rng() * 2 );
		const spacing = 0.065 + rng() * 0.021;
		const visiblePairs = Math.max( fork ? 2 : 4, Math.min( 38, Math.round( ( length - nodes[ lip ].distance ) / spacing ) ) );
		// The hidden root arc gets only a few leaves. Most foliage belongs beyond the lip,
		// where irregular opposing pairs form small hanging sprays rather than sparse bead chains.
		for ( const [ begin, end, pairs ] of [ [ 0.07, lipT, hiddenPairs ], [ fork ? 0.06 : lipT, 0.98, visiblePairs ] ] ) {

			for ( let pair = 0; pair < pairs; pair ++ ) {

				if ( pair % 16 === 15 ) yield;
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
					add( vertex, 0.5, 0.5, stemColor, 0.90, radial, sway( Math.min( 1, t + u * 0.04 ) ), phase, true );

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
		blocks.push( stemStart, I.length );

	}
	const counts = { strands: strandCount, leaves: leafCount, sprays: sprayCount, rootClusters: rootClusterCount, clumps: clumpCount };
	if ( ! P.length ) return { geometry: null, counts };
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( yield* float32Steps( P ), 3 ) );
	geometry.setAttribute( 'uv', new THREE.BufferAttribute( yield* float32Steps( U ), 2 ) );
	geometry.setAttribute( 'color', new THREE.BufferAttribute( yield* float32Steps( C ), 3 ) );
	geometry.setAttribute( 'rimSway', new THREE.BufferAttribute( yield* float32Steps( W ), 1 ) );
	geometry.setAttribute( 'rimPhase', new THREE.BufferAttribute( yield* float32Steps( F ), 1 ) );
	geometry.setAttribute( LEAF_STEM, new THREE.BufferAttribute( yield* float32Steps( S ), 1 ) );
	geometry.setAttribute( 'rimOut', new THREE.BufferAttribute( yield* float32Steps( O ), 3 ) );
	geometry.setIndex( yield* indexSteps( I ) );
	// The normals as three's computeVertexNormals makes them (each triangle's cross product added to
	// its corners in index order, then normalised), a block of strands at a time: no vertex is shared
	// between strands, so each vertex sums the same triangles in the same order. Then each leans a
	// little toward the wall's outward normal.
	const position = geometry.getAttribute( 'position' ).array as Float32Array, index = geometry.getIndex()!.array;
	const n = new Float32Array( position.length );
	geometry.setAttribute( 'normal', new THREE.BufferAttribute( n, 3 ) );
	const STEP = 4;
	for ( let b = 0; b < blocks.length; b += 2 * STEP ) {

		const v0 = blocks[ b ], i0 = b === 0 ? 0 : blocks[ b - 1 ];
		const last = Math.min( b + 2 * STEP, blocks.length ), v1 = last < blocks.length ? blocks[ last ] : position.length / 3, i1 = blocks[ last - 1 ];
		for ( let t = i0; t < i1; t += 3 ) {

			const a = index[ t ], bb = index[ t + 1 ], c = index[ t + 2 ];
			const ax = position[ a * 3 ], ay = position[ a * 3 + 1 ], az = position[ a * 3 + 2 ];
			const bx = position[ bb * 3 ], by = position[ bb * 3 + 1 ], bz = position[ bb * 3 + 2 ];
			const cx = position[ c * 3 ] - bx, cy = position[ c * 3 + 1 ] - by, cz = position[ c * 3 + 2 ] - bz;
			const ex = ax - bx, ey = ay - by, ez = az - bz;
			const x = cy * ez - cz * ey, y = cz * ex - cx * ez, z = cx * ey - cy * ex;
			// (all three corners read before any is written, as three does)
			const na = [ n[ a * 3 ] + x, n[ a * 3 + 1 ] + y, n[ a * 3 + 2 ] + z ], nb = [ n[ bb * 3 ] + x, n[ bb * 3 + 1 ] + y, n[ bb * 3 + 2 ] + z ];
			const nc = [ n[ c * 3 ] + x, n[ c * 3 + 1 ] + y, n[ c * 3 + 2 ] + z ];
			n.set( na, a * 3 ); n.set( nb, bb * 3 ); n.set( nc, c * 3 );

		}
		for ( let v = v0; v < v1; v ++ ) {

			const x = n[ v * 3 ], y = n[ v * 3 + 1 ], z = n[ v * 3 + 2 ], scale = 1 / ( Math.sqrt( x * x + y * y + z * z ) || 1 );
			n[ v * 3 ] = x * scale; n[ v * 3 + 1 ] = y * scale; n[ v * 3 + 2 ] = z * scale;
			normal.set( n[ v * 3 ], n[ v * 3 + 1 ], n[ v * 3 + 2 ] ).multiplyScalar( 0.82 ).addScaledVector( outward.set( E.get( v * 3 ), E.get( v * 3 + 1 ), E.get( v * 3 + 2 ) ), 0.18 ).normalize();
			n[ v * 3 ] = normal.x; n[ v * 3 + 1 ] = normal.y; n[ v * 3 + 2 ] = normal.z;

		}
		yield;

	}
	yield* boundsSteps( geometry );
	geometry.boundingSphere!.radius += 0.15; // the trails' sway in a gale
	return { geometry, counts };

}
