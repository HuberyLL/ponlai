import * as THREE from 'three/webgpu';
import {
	attribute, positionGeometry, positionLocal, normalViewGeometry, vec3, float, mix, dot, sin, cos, pow, clamp,
	smoothstep as smoothstepN,
} from 'three/tsl';
import { mulberry32, noise3, smoothstep, type Rng } from './noise.ts';
import { VegetationLighting, useLighting } from './VegetationLighting.ts';
import { useRestPoseShadows } from './VegetationShadow.ts';
import { VEGETATION_STRIDE as STRIDE } from './types.ts';
import type { Shared } from '../shared.ts';

interface Site { x: number; y: number; z: number; r: number; rim: number; nx: number; ny: number; nz: number; visibility: number }

// Individual folded leaves on short branching sprays. Three offset crowns keep bushes
// irregular; real leaf normals separate sunlit faces from their shaded neighbours.

export function leafTexture( size = 128 ): THREE.CanvasTexture {

	const c = document.createElement( 'canvas' );
	c.width = c.height = size;
	const g = c.getContext( '2d' )!;
	g.clearRect( 0, 0, size, size );
	g.save();
	g.scale( size, size );
	const shade = g.createLinearGradient( 0.06, 0.6, 0.96, 0.25 );
	shade.addColorStop( 0, '#b5b5b5' );
	shade.addColorStop( 0.47, '#eeeeee' );
	shade.addColorStop( 0.55, '#cbcbcb' );
	shade.addColorStop( 1, '#f7f7f7' );
	g.fillStyle = shade;
	g.beginPath();
	g.moveTo( 0.5, 0.99 );
	g.bezierCurveTo( 0.44, 0.8, 0.08, 0.63, 0.065, 0.5 );
	g.bezierCurveTo( 0.09, 0.3, 0.4, 0.16, 0.5, 0.015 );
	g.bezierCurveTo( 0.65, 0.21, 0.92, 0.32, 0.935, 0.5 );
	g.bezierCurveTo( 0.9, 0.67, 0.57, 0.81, 0.5, 0.99 );
	g.fill();
	g.strokeStyle = 'rgba(255,255,235,0.44)';
	g.lineWidth = 0.009;
	g.beginPath();
	g.moveTo( 0.5, 0.95 );
	g.quadraticCurveTo( 0.47, 0.53, 0.5, 0.06 );
	g.stroke();
	g.lineWidth = 0.004;
	g.strokeStyle = 'rgba(110,120,90,0.18)';
	for ( let i = 0; i < 4; i ++ ) {

		const y = 0.36 + i * 0.12;
		const w = Math.sin( y * Math.PI ) * 0.31;
		g.beginPath();
		g.moveTo( 0.5, y + 0.09 );
		g.quadraticCurveTo( 0.5 - w * 0.6, y + 0.015, 0.5 - w, y - 0.08 );
		g.moveTo( 0.5, y + 0.08 );
		g.quadraticCurveTo( 0.5 + w * 0.6, y, 0.5 + w, y - 0.09 );
		g.stroke();

	}
	g.restore();
	const tex = new THREE.CanvasTexture( c );
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.minFilter = THREE.LinearMipmapLinearFilter;
	tex.anisotropy = 4;
	return tex;

}

export function leafAlphaTexture( map: THREE.CanvasTexture ): THREE.CanvasTexture {

	const c = document.createElement( 'canvas' );
	c.width = map.image.width;
	c.height = map.image.height;
	const g = c.getContext( '2d' )!;
	g.drawImage( map.image, 0, 0 );
	g.globalCompositeOperation = 'source-in';
	g.fillStyle = '#fff';
	g.fillRect( 0, 0, c.width, c.height );
	// Alpha maps read color channels, not alpha. A white silhouette keeps shaded leaf
	// veins from being cut away or casting incomplete shadows.
	const tex = new THREE.CanvasTexture( c );
	tex.minFilter = THREE.LinearMipmapLinearFilter;
	tex.anisotropy = 4;
	return tex;

}

// Three loose crowns, each with twelve branching sprays and six opposing leaf pairs.
// Every leaf has a raised midrib, curved tip and its own normal: no large foliage cards.
function bushGeometry( seed = 5 ) {

	const rng = mulberry32( seed );
	const P: number[] = [], U: number[] = [], C: number[] = [], E: number[] = [], I: number[] = [];
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

function foliageMaterial( shared: Shared, map: THREE.CanvasTexture ): THREE.MeshStandardNodeMaterial {

	const mat = new THREE.MeshStandardNodeMaterial( {
		map, alphaTest: 0.3, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.82, metalness: 0, vertexColors: true,
	} );
	mat.alphaMap = leafAlphaTexture( map );
	const g = positionGeometry; // the unit bush, before the instance places it
	const vH = clamp( g.y.div( 0.72 ), 0, 1 );
	const p = positionLocal; // placed: world space
	const ph = p.x.mul( 0.4 ).add( p.z.mul( 0.3 ) ).sub( shared.time.mul( 1.3 ) );
	useRestPoseShadows( mat, p, p.add( vec3( sin( ph.add( g.y.mul( 3 ) ) ), 0, cos( ph.mul( 1.3 ).add( g.x.mul( 3 ) ) ) ).mul( vH.mul( 0.02 ) ) ) );
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

// pick bush sites among the turf anchors: crowded along the rim, scattered inland
function pickSites( veg: Float32Array, rng: Rng ): Site[] {

	const n = veg.length / STRIDE;
	const order = Array.from( { length: n }, ( _, i ) => i );
	for ( let i = n - 1; i > 0; i -- ) {

		const j = Math.floor( rng() * ( i + 1 ) );
		[ order[ i ], order[ j ] ] = [ order[ j ], order[ i ] ];

	}

	const sites: Site[] = [];
	for ( const i of order ) {

		const k = i * STRIDE;
		const x = veg[ k ], y = veg[ k + 1 ], z = veg[ k + 2 ], rim = veg[ k + 6 ];
		const onStack = veg[ k + 7 ] > 0;
		const nearRim = smoothstep( - 2.2, - 0.6, rim );
		const clump = noise3( x * 0.3, 7.7, z * 0.3 ) * 0.5 + 0.5;
		const p = onStack ? 0.08 : nearRim * 0.3 * smoothstep( 0.3, 0.7, clump ) + 0.015 * smoothstep( 0.6, 0.85, clump );
		if ( rng() > p ) continue;
		const r = onStack ? 0.35 + rng() * 0.25 : ( 0.35 + Math.pow( rng(), 1.5 ) * 0.75 ) * ( 0.8 + 0.5 * nearRim );
		if ( sites.some( ( s ) => Math.hypot( s.x - x, s.z - z ) < ( s.r + r ) * 0.75 ) ) continue;
		sites.push( { x, y, z, r, rim, nx: veg[ k + 3 ], ny: veg[ k + 4 ], nz: veg[ k + 5 ], visibility: veg[ k + 8 ] } );

	}

	return sites;

}

export function buildFoliage( veg: Float32Array, shared: Shared ): THREE.InstancedMesh {

	const rng = mulberry32( 7 );
	const sites = pickSites( veg, rng );
	const map = leafTexture();
	const geo = bushGeometry();
	const visibility = new Float32Array( sites.length );
	geo.setAttribute( 'skyVisibility', new THREE.InstancedBufferAttribute( visibility, 1 ) );
	const mat = foliageMaterial( shared, map );
	const mesh = new THREE.InstancedMesh( geo, mat, sites.length );
	const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qy = new THREE.Quaternion();
	const up = new THREE.Vector3( 0, 1, 0 ), dir = new THREE.Vector3(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
	const col = new THREE.Color();
	const greens = [ [ 0.065, 0.16, 0.04 ], [ 0.095, 0.19, 0.048 ], [ 0.15, 0.205, 0.046 ], [ 0.04, 0.12, 0.043 ], [ 0.18, 0.22, 0.058 ] ].map( ( [ r, gr, b ] ) => new THREE.Color( r, gr, b ) );

	sites.forEach( ( s, i ) => {

		visibility[ i ] = s.visibility;
		// lean with the ground: bushes on the rim tip out over the edge
		dir.set( s.nx, s.ny, s.nz ).lerp( up, 0.4 ).normalize();
		q.setFromUnitVectors( up, dir );
		qy.setFromAxisAngle( up, rng() * Math.PI * 2 );
		q.multiply( qy );
		pos.set( s.x, s.y - 0.08 * s.r, s.z );
		scl.set( s.r * ( 0.9 + rng() * 0.25 ), s.r * ( 1.1 + rng() * 0.4 ), s.r * ( 0.9 + rng() * 0.25 ) );
		m.compose( pos, q, scl );
		mesh.setMatrixAt( i, m );
		col.copy( greens[ Math.floor( rng() * greens.length ) ] ).multiplyScalar( 0.85 + rng() * 0.35 );
		mesh.setColorAt( i, col );

	} );

	mesh.instanceMatrix.needsUpdate = true;
	if ( mesh.instanceColor ) mesh.instanceColor.needsUpdate = true;
	mesh.frustumCulled = false;
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	mesh.name = 'foliage';
	mesh.renderOrder = - 1; // before the terrain: the turf it covers then fails the depth test
	return mesh;

}
