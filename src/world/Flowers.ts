import * as THREE from 'three/webgpu';
import { attribute, positionGeometry, positionLocal, normalViewGeometry, vec3, clamp, mix, step, smoothstep as smoothstepN } from 'three/tsl';
import { mulberry32, noise3, smoothstep } from './noise.ts';
import { VEGETATION_STRIDE as STRIDE } from './types.ts';
import { useRestPoseShadows } from './VegetationShadow.ts';
import { windGust } from '../weather/Wind.ts';
import type { Shared } from '../shared.ts';
import { supportsMeadow } from '../materials/Meadow.ts';

// Small cupped wildflowers, grouped in quiet drifts. Folded geometry catches the sun on the
// petal edges while the throat stays shaded; the meadow should never read as a carpet of icons.

function blossomGeometry() {

	const P: number[] = [], N: number[] = [], C: number[] = [], T: number[] = [], I: number[] = [];
	const add = ( x: number, y: number, z: number, nx: number, ny: number, nz: number, shade: number, part: number ) => {

		P.push( x, y, z );
		const l = Math.hypot( nx, ny, nz );
		N.push( nx / l, ny / l, nz / l );
		C.push( shade, shade, shade );
		T.push( part );
		return P.length / 3 - 1;

	};

	// Five folded petals: three triangles each, with a shaded throat and gently lifted tips.
	for ( let petal = 0; petal < 5; petal ++ ) {

		const a = petal / 5 * Math.PI * 2;
		const dx = Math.cos( a ), dz = Math.sin( a ), tx = - dz, tz = dx;
		const base = add( dx * 0.045, 1, dz * 0.045, - dx * 0.2, 1, - dz * 0.2, 0.58, 1 );
		add( dx * 0.23 + tx * 0.1, 1.075, dz * 0.23 + tz * 0.1, tx * 0.4 - dx * 0.25, 1, tz * 0.4 - dz * 0.25, 0.88, 1 );
		add( dx * 0.34 + tx * 0.06, 1.14, dz * 0.34 + tz * 0.06, - dx * 0.45, 1, - dz * 0.45, 1, 1 );
		add( dx * 0.34 - tx * 0.06, 1.14, dz * 0.34 - tz * 0.06, - dx * 0.45, 1, - dz * 0.45, 0.97, 1 );
		add( dx * 0.23 - tx * 0.1, 1.075, dz * 0.23 - tz * 0.1, - tx * 0.4 - dx * 0.25, 1, - tz * 0.4 - dz * 0.25, 0.8, 1 );
		I.push( base, base + 1, base + 2, base, base + 2, base + 3, base, base + 3, base + 4 );

		const center = add( 0, 1.04, 0, 0, 1, 0, 1, 2 );
		add( Math.cos( a ) * 0.085, 1.02, Math.sin( a ) * 0.085, 0, 1, 0, 0.8, 2 );
		add( Math.cos( a + Math.PI * 2 / 5 ) * 0.085, 1.02, Math.sin( a + Math.PI * 2 / 5 ) * 0.085, 0, 1, 0, 0.9, 2 );
		I.push( center, center + 1, center + 2 );

	}

	// part - 1: the stem, coloured as the leaves (part 0) but kept out of the sun's shadow map
	const stem = add( - 0.016, 0, 0, 0, 0.25, 1, 0.65, - 1 );
	add( 0.016, 0, 0, 0, 0.25, 1, 0.65, - 1 );
	add( 0.025, 1, 0, 0, 0.25, 1, 1, - 1 );
	add( - 0.009, 1, 0, 0, 0.25, 1, 1, - 1 );
	I.push( stem, stem + 1, stem + 2, stem, stem + 2, stem + 3 );
	for ( const side of [ - 1, 1 ] ) {

		const h = side < 0 ? 0.28 : 0.48;
		const leaf = add( 0, h, 0, 0, 1, 0, 0.75, 0 );
		add( side * 0.18, h + 0.04, - 0.045, side * 0.4, 1, 0, 0.85, 0 );
		add( side * 0.36, h + 0.18, 0, side * 0.4, 1, 0, 1, 0 );
		add( side * 0.18, h + 0.04, 0.045, side * 0.4, 1, 0, 0.75, 0 );
		I.push( leaf, leaf + 1, leaf + 2, leaf, leaf + 2, leaf + 3 );

	}

	const g = new THREE.BufferGeometry();
	g.setAttribute( 'position', new THREE.Float32BufferAttribute( P, 3 ) );
	g.setAttribute( 'normal', new THREE.Float32BufferAttribute( N, 3 ) );
	g.setAttribute( 'color', new THREE.Float32BufferAttribute( C, 3 ) );
	g.setAttribute( 'flowerPart', new THREE.Float32BufferAttribute( T, 1 ) );
	g.setIndex( I );
	return g;

}

function flowerMaterial( shared: Shared ): THREE.MeshStandardNodeMaterial {

	const mat = new THREE.MeshStandardNodeMaterial( { side: THREE.DoubleSide, roughness: 0.79, vertexColors: true } );
	const part = attribute<'float'>( 'flowerPart', 'float' );
	const petal = attribute<'vec3'>( 'flowerColor', 'vec3' );
	const bloom = mix( petal, vec3( 0.32, 0.18, 0.027 ), smoothstepN( 1.1, 1.9, part ) );
	const wetness = clamp( shared.wetness, 0, 1 );
	mat.colorNode = mix( vec3( 0.035, 0.095, 0.018 ), bloom, smoothstepN( 0.2, 0.8, part ) ).mul( mix( 1, 0.95, wetness ) );
	mat.roughnessNode = mix( 0.79, 0.72, wetness );
	const g = positionGeometry, p = positionLocal;
	const wind = shared.wind.direction;
	const gust = windGust( p.xz, wind, shared.wind.phase ).mul( shared.wind.strength );
	useRestPoseShadows( mat, p, p.add( vec3( wind.x, 0, wind.y ).mul( gust.mul( 0.035 ).mul( g.y.mul( g.y ) ) ) ), step( - 0.5, part ) );
	mat.normalNode = normalViewGeometry;
	mat.aoNode = attribute<'float'>( 'skyVisibility', 'float' );
	return mat;

}

export function buildFlowers( veg: Float32Array, shared: Shared ): THREE.InstancedMesh {

	const rng = mulberry32( 31 );
	const palette = [
		[ 0.52, 0.50, 0.38 ], // ivory
		[ 0.65, 0.39, 0.045 ], // butter yellow
		[ 0.39, 0.18, 0.26 ], // muted rose
		[ 0.23, 0.2, 0.47 ], // lavender
	].map( ( [ r, g, b ] ) => new THREE.Color( r, g, b ) );

	const n = veg.length / STRIDE;
	const picks: number[] = [];
	for ( let i = 0; i < n; i ++ ) {

		const k = i * STRIDE;
		if ( veg[ k + 7 ] > 0 ) continue;
		const x = veg[ k ], z = veg[ k + 2 ];
		const drift = noise3( x * 0.28 + 11.0, 4.4, z * 0.28 ) * 0.5 + 0.5;
		const p = smoothstep( 0.57, 0.79, drift ) * 0.66 + 0.012;
		const count = rng() < p ? 1 + ( rng() < 0.24 ? 1 : 0 ) : 0;
		for ( let c = 0; c < count; c ++ ) picks.push( k );

	}

	const count = picks.length;
	const geo = blossomGeometry();
	const colors = new Float32Array( count * 3 );
	const visibility = new Float32Array( count );
	geo.setAttribute( 'flowerColor', new THREE.InstancedBufferAttribute( colors, 3 ) );
	geo.setAttribute( 'skyVisibility', new THREE.InstancedBufferAttribute( visibility, 1 ) );
	const mesh = new THREE.InstancedMesh( geo, flowerMaterial( shared ), count );
	const m = new THREE.Matrix4(), q = new THREE.Quaternion(), tilt = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
	const up = new THREE.Vector3( 0, 1, 0 ), lean = new THREE.Vector3(), col = new THREE.Color();
	let visible = 0;
	for ( let i = 0; i < count; i ++ ) {

		const k = picks[ i ];
		const x = veg[ k ] + ( rng() - 0.5 ) * 0.22, z = veg[ k + 2 ] + ( rng() - 0.5 ) * 0.22;
		const hue = noise3( x * 0.11 + 2.0, 8.8, z * 0.11 ) * 0.5 + 0.5;
		const ci = Math.floor( ( ( hue * 3.7 ) % 1 ) * 4 );
		q.setFromAxisAngle( up, rng() * Math.PI * 2 );
		lean.set( ( rng() - 0.5 ) * 0.3, 1, ( rng() - 0.5 ) * 0.3 ).normalize();
		tilt.setFromUnitVectors( up, lean );
		q.premultiply( tilt );
		const h = 0.32 + rng() * 0.26, w = 0.22 + rng() * 0.1;
		pos.set( x, veg[ k + 1 ] - 0.02, z );
		scl.set( w, h, w );
		m.compose( pos, q, scl );
		col.copy( palette[ ci ] ).multiplyScalar( 0.82 + rng() * 0.28 );
		// Filtering after the original draws preserves every retained flower's pose and colour.
		if ( ! supportsMeadow( veg[ k + 1 ], veg[ k + 4 ] ) ) continue;
		visibility[ visible ] = veg[ k + 8 ];
		mesh.setMatrixAt( visible, m );
		col.toArray( colors, visible ++ * 3 );

	}

	mesh.count = visible;
	mesh.instanceMatrix.needsUpdate = true;
	mesh.frustumCulled = false;
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	mesh.name = 'flowers';
	mesh.renderOrder = - 1;
	return mesh;

}
