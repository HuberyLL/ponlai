import * as THREE from 'three/webgpu';
import {
	attribute, positionGeometry, positionLocal, normalViewGeometry, materialColor, vec3, vec4, float, mix, dot, pow, clamp,
	smoothstep as smoothstepN, normalize, length,
} from 'three/tsl';
import { LEAN_REF, gustWave, setWindDisplacement, swayJitter, swingOf, wave, windField, type WindState } from '../weather/Wind.ts';
import { followWindMotionFlag } from './WindMotion.ts';
import { showSway } from '../debug/WindView.ts';
import { mulberry32 } from './noise.ts';
import { BUSH_STRIDE } from './FoliageSites.ts';
import { VegetationLighting, useLighting } from './VegetationLighting.ts';
import { previousSway, useRestPoseShadows } from './VegetationShadow.ts';
import { ALPHA_TO_COVERAGE, markVegetation, useLeafCoverage } from './vegetation/Coverage.ts';
import { LEAF_ALPHA_TEST, leafAlphaTexture, leafTexture } from './vegetation/LeafTexture.ts';
import type { Shared } from '../shared.ts';

// Individual folded leaves on short branching sprays. Three offset crowns keep bushes
// irregular; real leaf normals separate sunlit faces from their shaded neighbours.
//
// This module also holds the plants' main bend (`mainBend`), which the flowers, the plateau's
// plants and the game's palm share, and the leaf-stem flag (`LEAF_STEM`). What every vegetation
// material shares lives in vegetation/: the folded leaf's textures (LeafTexture.ts), the coverage
// paths and the vegetation tag (Coverage.ts, re-exported here for the grass).
// - Vegetation draws before the terrain (`renderOrder = -1`), so the turf under it fails the depth
//   test.
// - Twigs, stems and leaf stalks (a few millimetres across) stay out of the sun's shadow map
//   (`LEAF_STEM`, VegetationShadow.ts).

export { ALPHA_TO_COVERAGE, coverageAlphaTest, coverageDither, markVegetation, useLeafCoverage } from './vegetation/Coverage.ts';
export { LEAF_ALPHA_TEST, leafAlphaTexture, leafTexture } from './vegetation/LeafTexture.ts';

// Per-vertex flag on twigs, stems and leaf stalks, which stay out of the sun's shadow map.
export const LEAF_STEM = 'leafStem';
export const leafCastMask = () => float( 1 ).sub( attribute<'float'>( LEAF_STEM, 'float' ) );

// Three loose crowns, each with twelve branching sprays and six opposing leaf pairs.
// Every leaf has a raised midrib, curved tip and its own normal: no large foliage cards.
function bushGeometry( seed = 5 ) {

	const rng = mulberry32( seed );
	const P: number[] = [], U: number[] = [], C: number[] = [], E: number[] = [], S: number[] = [], I: number[] = [];
	const crowns = [
		new THREE.Vector3( - 0.28, 0.29, 0.08 ),
		new THREE.Vector3( 0.27, 0.35, 0.15 ),
		new THREE.Vector3( 0.02, 0.48, - 0.24 ),
	];
	const up = new THREE.Vector3( 0, 1, 0 );
	const branch = new THREE.Vector3(), across = new THREE.Vector3(), start = new THREE.Vector3(), end = new THREE.Vector3();
	const p = new THREE.Vector3(), n = new THREE.Vector3(), along = new THREE.Vector3(), width = new THREE.Vector3(), v = new THREE.Vector3();
	const add = ( point: THREE.Vector3, u: number, vv: number, shade: number, envelope: THREE.Vector3, stem = false ) => {

		P.push( point.x, point.y, point.z );
		U.push( u, vv );
		if ( stem ) C.push( shade * 0.68, shade * 0.52, shade * 0.28 );
		else C.push( shade * 0.97, shade, shade * 0.9 );
		E.push( envelope.x, envelope.y, envelope.z );
		S.push( stem ? 1 : 0 );

	};

	for ( let crown = 0; crown < crowns.length; crown ++ ) {

		for ( let spray = 0; spray < 12; spray ++ ) {

			const a = spray / 12 * Math.PI * 2 + ( rng() - 0.5 ) * 0.72 + crown * 1.7;
			branch.set( Math.cos( a ), 0.15 + rng() * 0.9, Math.sin( a ) ).normalize();
			across.crossVectors( up, branch ).normalize();
			const length = 0.3 + rng() * 0.23;
			start.copy( crowns[ crown ] ).add( v.set( ( rng() - 0.5 ) * 0.13, ( rng() - 0.5 ) * 0.14, ( rng() - 0.5 ) * 0.13 ) );
			end.copy( start ).addScaledVector( branch, length );
			const twig = P.length / 3;
			n.copy( up ).addScaledVector( branch, 0.25 ).normalize();
			add( v.copy( start ).addScaledVector( across, - 0.006 ), 0.5, 0.5, 0.45, n, true );
			add( v.copy( start ).addScaledVector( across, 0.006 ), 0.5, 0.5, 0.45, n, true );
			add( v.copy( end ).addScaledVector( across, 0.002 ), 0.5, 0.5, 0.65, n, true );
			add( v.copy( end ).addScaledVector( across, - 0.002 ), 0.5, 0.5, 0.65, n, true );
			I.push( twig, twig + 1, twig + 2, twig, twig + 2, twig + 3 );

			for ( let pair = 0; pair < 6; pair ++ ) {

				for ( const side of [ - 1, 1 ] ) {

					const t = 0.1 + pair * 0.17 + ( rng() - 0.5 ) * 0.08;
					p.copy( start ).addScaledVector( branch, length * t ).addScaledVector( across, side * 0.01 );
					n.copy( branch ).multiplyScalar( 0.38 ).addScaledVector( up, 0.65 );
					n.add( v.set( ( rng() - 0.5 ) * 0.7, ( rng() - 0.5 ) * 0.35, ( rng() - 0.5 ) * 0.7 ) ).normalize();
					along.copy( across ).multiplyScalar( side ).addScaledVector( branch, 0.3 + rng() * 0.25 );
					along.addScaledVector( n, - along.dot( n ) ).normalize();
					width.crossVectors( n, along ).normalize();
					const L = ( 0.16 + rng() * 0.10 ) * ( pair === 5 ? 0.8 : 1 );
					const W = 0.07 + rng() * 0.05;
					const fold = L * ( 0.08 + rng() * 0.07 );
					const shade = 0.64 + Math.min( 0.3, p.y * 0.38 ) + rng() * 0.16;
					const base = P.length / 3;
					add( p, 0.5, 0, shade * 0.82, n );
					add( v.copy( p ).addScaledVector( along, L * 0.48 ).addScaledVector( width, - W * 0.5 ), 0, 0.5, shade, n );
					add( v.copy( p ).addScaledVector( along, L * 0.51 ).addScaledVector( n, fold ), 0.5, 0.5, shade * 1.03, n );
					add( v.copy( p ).addScaledVector( along, L * 0.48 ).addScaledVector( width, W * 0.5 ), 1, 0.5, shade, n );
					add( v.copy( p ).addScaledVector( along, L ).addScaledVector( n, fold * 0.32 ), 0.5, 1, shade * 1.04, n );
					I.push( base, base + 1, base + 2, base + 1, base + 4, base + 2, base, base + 2, base + 3, base + 2, base + 4, base + 3 );

				}

			}

		}

	}

	const g = new THREE.BufferGeometry();
	g.setAttribute( 'position', new THREE.Float32BufferAttribute( P, 3 ) );
	g.setAttribute( 'uv', new THREE.Float32BufferAttribute( U, 2 ) );
	g.setAttribute( 'color', new THREE.Float32BufferAttribute( C, 3 ) );
	g.setAttribute( LEAF_STEM, new THREE.Float32BufferAttribute( S, 1 ) );
	g.setIndex( I );
	g.computeVertexNormals();
	const normals = g.getAttribute( 'normal' );
	for ( let i = 0; i < normals.count; i ++ ) {

		// Keep the folded leaf's lighting while softening only a little toward its crown.
		n.fromBufferAttribute( normals, i ).multiplyScalar( 0.82 );
		n.add( v.fromArray( E, i * 3 ).multiplyScalar( 0.18 ) ).normalize();
		normals.setXYZ( i, n.x, n.y, n.z );

	}
	return g;

}

type V3 = THREE.Node<'vec3'>;
type F = THREE.Node<'float'>;

/** A plant's main bend, after Sousa's "Vegetation Procedural Animation and Shading in Crysis"
 * (GPU Gems 3, ch. 16): the whole plant leans with the gust field at its root and sways a little
 * about that lean, each vertex by `amplitude` (metres at a fair day's typical gust, see LEAN_REF;
 * it carries the plant's stiffness and grows from the root up), keeping its distance from the root
 * so the plant arcs over instead of shearing. The sway travels with the gusts (Wind.ts `gustWave`):
 * neighbours swing together, each plant only a little
 * apart (`swayJitter`), about a sixth of the lean (`swingOf`), a third of that across the wind.
 * `cycles` is the sway's rate in whole swings per gust tile (an even number: about 0.9 Hz at 30
 * in a fair wind), and `slow` (0..1) eases it to half that rate for taller plants (the small
 * trees, Plants.ts; the game's palm). `wind` is the frame's wind state (`shared.wind`, or `.previous`). Returns the bent
 * position, the wind field's ( direction x, direction z, lean, gust ) at the root and the plant's
 * sway: its horizontal offset over `amplitude` times LEAN_REF, the lean and swing as a tip offset
 * over height (world x, z; for the wind view and probe, src/debug/WindView.ts; a shader that does
 * not read it compiles as before). */
export function mainBend( wind: WindState, position: V3, root: V3, amplitude: F, cycles: number, slow?: F ): { position: V3; field: THREE.Node<'vec4'>; sway: THREE.Node<'vec2'> } {

	if ( cycles % 2 !== 0 ) throw new RangeError( `mainBend: ${ cycles } swings per gust tile is not even` );
	const field = windField( wind, root.xz ).toVar();
	const own = swayJitter( root.xz );
	// The sway grows with the wind and in a gust; the lean follows the gust field.
	const swing = swingOf( wind, field.w ).mul( own.gain );
	const sway = ( c: number, ph: F ) => slow ? mix( gustWave( wind, root.xz, c, ph ), gustWave( wind, root.xz, c / 2, ph ), slow ) : gustWave( wind, root.xz, c, ph );
	const response = field.z.div( LEAN_REF ).add( sway( cycles, own.phase ).mul( swing ) );
	const sideways = sway( 2 * Math.round( cycles * 0.4 ), own.phase.mul( 1.7 ).add( 1.3 ) ).mul( swing ).mul( 0.35 );
	const unit = vec3( field.x, 0, field.y ).mul( response ).add( vec3( field.y.negate(), 0, field.x ).mul( sideways ) );
	const offset = unit.mul( amplitude );
	const rel = position.sub( root ).toVar();
	return { position: normalize( rel.add( offset ).add( vec3( 0, 1e-5, 0 ) ) ).mul( length( rel ) ).add( root ), field, sway: unit.xz.mul( LEAN_REF ) };

}

function foliageMaterial( shared: Shared, map: THREE.CanvasTexture ): THREE.MeshStandardNodeMaterial {

	const mat = new THREE.MeshStandardNodeMaterial( {
		map, alphaTest: LEAF_ALPHA_TEST, alphaToCoverage: ALPHA_TO_COVERAGE, side: THREE.DoubleSide, roughness: 0.82, metalness: 0, vertexColors: true,
	} );
	mat.alphaMap = leafAlphaTexture( map.image.width );
	markVegetation( mat );
	useLeafCoverage( mat );
	const wetness = clamp( shared.wetness, 0, 1 );
	const wetTint = mix( 1, 0.92, wetness );
	// materialColor retains the leaf map and its alpha; Three applies vertex and instance
	// colours afterward. Wetness must not darken the cutout silhouette itself.
	mat.colorNode = materialColor.mul( vec4( wetTint, wetTint, wetTint, 1 ) );
	mat.roughnessNode = mix( 0.82, 0.68, wetness );
	const g = positionGeometry; // the unit bush, before the instance places it
	const vH = clamp( g.y.div( 0.72 ), 0, 1 );
	const p = positionLocal; // placed: world space
	// The bush bends from its root (2 cm at the crown in a fair gust) and sways with its
	// neighbours (about 0.9 Hz); its sprays flutter on top, each leaf on a phase of its place in
	// the bush, a few millimetres.
	const root = attribute<'vec4'>( 'bushRoot', 'vec4' ).xyz;
	const ph = dot( g, vec3( 4.1, 3.3, 5.7 ) );
	let sway: THREE.Node<'vec2'> | undefined;
	const swayed = setWindDisplacement( mat, ( wind ) => {

		const bend = mainBend( wind, p, root, vH.mul( vH ).mul( 0.022 ), 30 );
		if ( wind === shared.wind ) sway = bend.sway;
		const field = bend.field;
		const shake = wind.breeze.mul( field.w.mul( 0.7 ).add( 0.3 ) ).mul( vH ).mul( 0.006 );
		const flutter = vec3( 0, wave( wind.flutter, 2.3, ph ), 0 )
			.add( vec3( field.y.negate(), 0, field.x ).mul( wave( wind.flutter, 3.1, ph.mul( 1.3 ) ).mul( 0.6 ) ) );
		return bend.position.add( flutter.mul( shake ) );

	}, shared.wind );
	useRestPoseShadows( mat, p, swayed, leafCastMask(), previousSway( mat, shared.wind ) );
	if ( sway ) showSway( mat, sway, shared.wind );
	// Each folded leaf keeps its own highlights and shading across the canopy.
	mat.normalNode = normalViewGeometry;
	// deep inside and underneath a bush the light is gone
	mat.aoNode = mix( float( 0.32 ), float( 1 ), smoothstepN( 0, 0.85, vH ) ).mul( attribute<'float'>( 'skyVisibility', 'float' ) );
	useLighting( mat, () => new VegetationLighting( mix( float( 0.7 ), float( 1 ), smoothstepN( 0, 0.6, vH ) ), ( L, V, N ) => {

		// wrapped light (leaves scatter light round to the shadow side) + glow against the sun
		const back = pow( clamp( dot( V.negate(), L ), 0, 1 ), 4 );
		const rim = float( 1 ).sub( clamp( dot( N, V ), 0, 1 ) );
		const wrap = clamp( dot( N, L ).mul( 0.5 ).add( 0.5 ), 0, 1 );
		return wrap.mul( wrap ).mul( 0.13 ).add( back.mul( rim.mul( rim ).mul( 0.9 ).add( 0.1 ) ) );

	} ) );
	return mat;

}

// The bushes' instance buffers hold BUSH_CAPACITY instances whatever the island's size: three keeps
// up to 1024 instance matrices in a uniform array of exactly the capacity, which the shader names,
// so a fixed capacity lets a grown island's bushes be written into the same mesh (`setBushes`)
// without a new pipeline. A land past it would need another mesh and shader (warned; the
// growth horizon's land has well under a thousand).
export const BUSH_CAPACITY = 1024;

/** The bushes' instance arrays, as the mesh's buffers take them. */
export interface BushInstances { count: number; matrices: Float32Array; colors: Float32Array; visibility: Float32Array; roots: Float32Array }

/** The instance arrays of the rim bushes the world generator placed (BUSH_STRIDE floats each). */
export function bushInstances( bushes: Float32Array ): BushInstances {

	let count = bushes.length / BUSH_STRIDE;
	if ( count > BUSH_CAPACITY ) {

		console.warn( `${ count } rim bushes: only the first ${ BUSH_CAPACITY } are drawn (Foliage.ts BUSH_CAPACITY)` );
		count = BUSH_CAPACITY;

	}
	const out = { count, matrices: new Float32Array( count * 16 ), colors: new Float32Array( count * 3 ), visibility: new Float32Array( count ), roots: new Float32Array( count * 4 ) };
	const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qy = new THREE.Quaternion();
	const up = new THREE.Vector3( 0, 1, 0 ), dir = new THREE.Vector3(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
	for ( let i = 0; i < count; i ++ ) {

		const [ x, y, z, r, nx, ny, nz, yaw, sx, sy, sz, cr, cg, cb, sky ] = bushes.subarray( i * BUSH_STRIDE, ( i + 1 ) * BUSH_STRIDE );
		// lean with the ground: bushes on the rim tip out over the edge
		dir.set( nx, ny, nz ).lerp( up, 0.4 ).normalize();
		q.setFromUnitVectors( up, dir );
		qy.setFromAxisAngle( up, yaw );
		q.multiply( qy );
		pos.set( x, y - 0.08 * r, z );
		m.compose( pos, q, scl.set( sx, sy, sz ) );
		out.visibility[ i ] = sky;
		out.roots.set( [ pos.x, pos.y, pos.z, 0 ], i * 4 );
		m.toArray( out.matrices, i * 16 );
		out.colors.set( [ cr, cg, cb ], i * 3 );

	}
	return out;

}

/** The bushes' buffers `instances` are written into, each with its values (a grown island's are
 * staged ahead: Growth.ts, Upload.ts stagedWriteSteps). */
export function bushWrites( mesh: THREE.InstancedMesh, instances: BushInstances ): [ THREE.BufferAttribute, Float32Array ][] {

	return [
		[ mesh.instanceMatrix, instances.matrices ],
		[ mesh.instanceColor!, instances.colors ],
		[ mesh.geometry.getAttribute( 'skyVisibility' ) as THREE.BufferAttribute, instances.visibility ],
		[ mesh.geometry.getAttribute( 'bushRoot' ) as THREE.BufferAttribute, instances.roots ],
	];

}

/** Writes `instances` into the bushes' buffers (their used part re-uploaded) and sets the count. */
export function setBushes( mesh: THREE.InstancedMesh, instances: BushInstances ): void {

	for ( const [ attribute, values ] of bushWrites( mesh, instances ) ) {

		( attribute.array as Float32Array ).set( values );
		attribute.clearUpdateRanges();
		attribute.addUpdateRange( 0, Math.max( values.length, attribute.itemSize ) );
		attribute.needsUpdate = true;

	}
	mesh.count = instances.count;
	// (its box and sphere follow the instances: the sun's caster box reads them)
	mesh.boundingBox = null;
	mesh.boundingSphere = null;

}

/** The rim bushes the world generator placed (FoliageSites' BUSH_STRIDE floats each), one instance each. */
export function buildFoliage( bushes: Float32Array, shared: Shared ): THREE.InstancedMesh {

	const map = leafTexture();
	const geo = bushGeometry();
	geo.setAttribute( 'skyVisibility', new THREE.InstancedBufferAttribute( new Float32Array( BUSH_CAPACITY ), 1 ) );
	// each bush's root in world space, where it leans from and reads the gust field
	geo.setAttribute( 'bushRoot', new THREE.InstancedBufferAttribute( new Float32Array( BUSH_CAPACITY * 4 ), 4 ) );
	const mat = foliageMaterial( shared, map );
	const mesh = new THREE.InstancedMesh( geo, mat, BUSH_CAPACITY );
	followWindMotionFlag( mat );
	// (a colour per instance whatever the count, so the shader is the same on every land)
	mesh.instanceColor = new THREE.InstancedBufferAttribute( new Float32Array( BUSH_CAPACITY * 3 ), 3 );
	setBushes( mesh, bushInstances( bushes ) );
	mesh.frustumCulled = false;
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	mesh.name = 'foliage';
	mesh.renderOrder = - 1; // before the terrain: the turf it covers then fails the depth test
	return mesh;

}
