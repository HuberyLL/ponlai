import * as THREE from 'three/webgpu';
import {
	attribute, positionGeometry, positionLocal, normalViewGeometry, materialColor, vec3, vec4, float, mix, dot, sin, cos, pow, clamp,
	smoothstep as smoothstepN, normalize, length,
} from 'three/tsl';
import { LEAN_REF, rootPhase, setWindDisplacement, wave, windField, type WindState } from '../weather/Wind.ts';
import { keepLegacyWind } from './WindVariants.ts';
import { mulberry32 } from './noise.ts';
import { pickFoliageSites } from './FoliageSites.ts';
import { VegetationLighting, useLighting } from './VegetationLighting.ts';
import { useRestPoseShadows } from './VegetationShadow.ts';
import { supportsMeadow } from '../materials/Meadow.ts';
import { SCENE_SAMPLES } from '../post/SceneSamples.ts';
import type { Shared } from '../shared.ts';

// Individual folded leaves on short branching sprays. Three offset crowns keep bushes
// irregular; real leaf normals separate sunlit faces from their shaded neighbours.

// The leaf as a transparent silhouette; the colour map and the coverage map are both made
// from it, so they always agree.
function drawLeaf( size: number ): HTMLCanvasElement {

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
	return c;

}

// The leaf's colour, opaque. Its silhouette lives only in leafAlphaTexture, whose mips keep
// the leaf's coverage: an alpha here would be box-filtered by the GPU and, multiplied into the
// alpha map, thin distant leaves again. Shadow passes read the alpha map alone, so both passes
// now cut the same silhouette. The card around the leaf stays black, as the transparent texels
// were, so the colour mips match the previous ones.
export function leafTexture( size = 128 ): THREE.CanvasTexture {

	const c = document.createElement( 'canvas' );
	c.width = c.height = size;
	const g = c.getContext( '2d' )!;
	g.fillStyle = '#000';
	g.fillRect( 0, 0, size, size );
	g.drawImage( drawLeaf( size ), 0, 0 );
	const tex = new THREE.CanvasTexture( c );
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.minFilter = THREE.LinearMipmapLinearFilter;
	tex.anisotropy = 4;
	return tex;

}

export const LEAF_ALPHA_TEST = 0.3;

// Whether the vegetation's cut-outs and thin blades use alpha to coverage. WebGPU multisamples
// with 4 samples or none (three maps any other count to one sample), and with one sample there
// is no coverage to give: the pipeline then ignores alpha, so the softened alpha-tested edges and
// the grass's lowered coverage would all draw solid. Without it leaves take a plain alpha test at
// the cutoff their coverage-preserving mips were built for (`leafAlphaTexture`), and grass blades
// an ordered 4x4 dither (`coverageDither` in Grass.ts).
export const ALPHA_TO_COVERAGE = SCENE_SAMPLES >= 4;

// Tags a material as vegetation (leaves and grass blades) for passes that treat it apart, such
// as a lighter shadow filter. `alphaToCoverage` cannot tell: it is off without multisampling.
// The tag lives in userData, so a cloned material keeps it.
export function markVegetation( material: THREE.Material ): void {

	material.userData.vegetation = true;

}

// Per-vertex flag on twigs, stems and leaf stalks, which stay out of the sun's shadow map.
export const LEAF_STEM = 'leafStem';
export const leafCastMask = () => float( 1 ).sub( attribute<'float'>( LEAF_STEM, 'float' ) );

// Share of a w x w alpha level above the cutoff once bilinearly filtered (clamped at the
// edges, as the texture is), sampled on a grid at least 64 samples across.
function filteredCoverage( alpha: Float32Array, w: number, cutoff: number ): number {

	const steps = Math.max( 1, Math.ceil( 64 / w ) ), n = w * steps;
	const at = ( x: number, y: number ) => alpha[ Math.min( w - 1, Math.max( 0, y ) ) * w + Math.min( w - 1, Math.max( 0, x ) ) ];
	let covered = 0;
	for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) {

		const u = ( i + 0.5 ) / steps - 0.5, v = ( j + 0.5 ) / steps - 0.5;
		const x = Math.floor( u ), y = Math.floor( v ), fx = u - x, fy = v - y;
		const top = at( x, y ) + ( at( x + 1, y ) - at( x, y ) ) * fx;
		const bottom = at( x, y + 1 ) + ( at( x + 1, y + 1 ) - at( x, y + 1 ) ) * fx;
		if ( top + ( bottom - top ) * fy > cutoff ) covered ++;

	}
	return covered / ( n * n );

}

// Coverage-preserving alpha mips, after Ignacio Castano, "Computing Alpha Mipmaps" (2010). The
// leaf covers under half its card, yet its mean alpha (~0.46) is above the 0.3 cutoff, so plain
// box mips fill the card: distant leaves turned into squares. Each level is box-filtered from
// the unremapped level above, then remapped so the share of its bilinearly filtered surface
// above the cutoff matches the full-size leaf. Castano scales alpha down; alpha-to-coverage turns
// anything short of cutoff + fwidth into partial coverage, so a scaled-down interior would make
// whole leaves see-through. The remap is a steep ramp through the cutoff instead: leaves stay
// solid, with a filtered edge. Built once on the CPU; the GPU does not regenerate them. The
// levels are opaque grey canvases (alpha maps read colour, not alpha), uploaded with the same
// flip as the colour map.
export function leafAlphaTexture( size = 128, cutoff = LEAF_ALPHA_TEST ): THREE.CanvasTexture {

	const leaf = drawLeaf( size ).getContext( '2d' )!.getImageData( 0, 0, size, size ).data;
	let level = new Float32Array( size * size );
	for ( let i = 0; i < level.length; i ++ ) level[ i ] = leaf[ i * 4 + 3 ] / 255;
	let covered = 0;
	for ( const a of level ) if ( a > cutoff ) covered ++;
	const coverage = covered / level.length;

	const mips: HTMLCanvasElement[] = [];
	for ( let w = size; ; w >>= 1 ) {

		let remapped = level;
		if ( w < size ) {

			let peak = 0;
			for ( const a of level ) peak = Math.max( peak, a );
			const ramp = ( 1 - cutoff ) / ( 0.1 * peak );
			const remap = ( threshold: number ) => level.map( ( a ) => Math.min( 1, Math.max( 0, cutoff + ( a - threshold ) * ramp ) ) );
			// Coverage falls as the threshold rises: bisect for the full-size leaf's share,
			// but keep the densest texel solid so a far bush never vanishes outright.
			let lo = 0, hi = peak * 0.9;
			for ( let i = 0; i < 20; i ++ ) {

				const mid = ( lo + hi ) * 0.5;
				if ( filteredCoverage( remap( mid ), w, cutoff ) > coverage ) lo = mid; else hi = mid;

			}
			remapped = remap( ( lo + hi ) * 0.5 );

		}
		const c = document.createElement( 'canvas' );
		c.width = c.height = w;
		const g = c.getContext( '2d' )!;
		const image = g.createImageData( w, w );
		for ( let i = 0; i < remapped.length; i ++ ) {

			const v = Math.round( remapped[ i ] * 255 );
			image.data[ i * 4 ] = image.data[ i * 4 + 1 ] = image.data[ i * 4 + 2 ] = v;
			image.data[ i * 4 + 3 ] = 255;

		}
		g.putImageData( image, 0, 0 );
		mips.push( c );
		if ( w === 1 ) break;

		const half = w >> 1, next = new Float32Array( half * half );
		for ( let y = 0; y < half; y ++ ) for ( let x = 0; x < half; x ++ ) {

			const i = 2 * y * w + 2 * x;
			next[ y * half + x ] = ( level[ i ] + level[ i + 1 ] + level[ i + w ] + level[ i + w + 1 ] ) * 0.25;

		}
		level = next;

	}

	const tex = new THREE.CanvasTexture( mips[ 0 ] );
	tex.mipmaps = mips as unknown as THREE.Texture[ 'mipmaps' ];
	tex.generateMipmaps = false;
	tex.minFilter = THREE.LinearMipmapLinearFilter;
	tex.anisotropy = 4;
	return tex;

}

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
 * (GPU Gems 3, ch. 16): the whole plant leans with the gust field at its root and sways about
 * that lean at its own natural rate, each vertex by `amplitude` (metres at a fair day's typical
 * gust, see LEAN_REF; it carries the plant's stiffness and grows from the root up), keeping its
 * distance from the root so the plant arcs over instead of shearing. As in God of War's wind
 * (Santa Monica Studio; Rupert Renard, GDC 2019), each plant answers the local wind like a spring
 * at its own natural frequency, swinging wider in a gust rather than in step with its
 * neighbours. `rate` is the sway's
 * frequency (Hz, an even number of thousandths), and `slow` (0..1) eases it to half that rate for
 * taller plants. `wind` is the frame's wind state (`shared.wind`, or `.previous`). Returns the
 * bent position and the wind field's ( direction x, direction z, lean, gust ) at the root. */
export function mainBend( wind: WindState, position: V3, root: V3, amplitude: F, rate: number, slow?: F ): { position: V3; field: THREE.Node<'vec4'> } {

	const field = windField( wind, root.xz ).toVar();
	const phase = rootPhase( root.xz );
	// The sway grows with the wind and in a gust; the lean follows the gust field.
	const swing = wind.breeze.mul( field.w.mul( 0.45 ).add( 0.25 ) );
	const sway = ( r: number, ph: F ) => slow ? mix( wave( wind.clock, r, ph ), wave( wind.clock, r / 2, ph ), slow ) : wave( wind.clock, r, ph );
	const response = field.z.div( LEAN_REF ).add( sway( rate, phase ).mul( swing ) );
	const sideways = sway( rate * 0.78, phase.mul( 1.7 ) ).mul( swing ).mul( 0.35 );
	const offset = vec3( field.x, 0, field.y ).mul( response ).add( vec3( field.y.negate(), 0, field.x ).mul( sideways ) ).mul( amplitude );
	const rel = position.sub( root ).toVar();
	return { position: normalize( rel.add( offset ).add( vec3( 0, 1e-5, 0 ) ) ).mul( length( rel ) ).add( root ), field };

}

function foliageMaterial( shared: Shared, map: THREE.CanvasTexture, legacy = false, alphaMap?: THREE.Texture ): THREE.MeshStandardNodeMaterial {

	const mat = new THREE.MeshStandardNodeMaterial( {
		map, alphaTest: LEAF_ALPHA_TEST, alphaToCoverage: ALPHA_TO_COVERAGE, side: THREE.DoubleSide, roughness: 0.82, metalness: 0, vertexColors: true,
	} );
	mat.alphaMap = alphaMap ?? leafAlphaTexture( map.image.width );
	markVegetation( mat );
	const wetness = clamp( shared.wetness, 0, 1 );
	const wetTint = mix( 1, 0.92, wetness );
	// materialColor retains the leaf map and its alpha; Three applies vertex and instance
	// colours afterward. Wetness must not darken the cutout silhouette itself.
	mat.colorNode = materialColor.mul( vec4( wetTint, wetTint, wetTint, 1 ) );
	mat.roughnessNode = mix( 0.82, 0.68, wetness );
	const g = positionGeometry; // the unit bush, before the instance places it
	const vH = clamp( g.y.div( 0.72 ), 0, 1 );
	const p = positionLocal; // placed: world space
	const wind = shared.wind.direction;
	let swayed: V3;
	if ( legacy ) {

		const ph = dot( p.xz, wind ).mul( 0.45 ).sub( shared.wind.phase.mul( 1.3 / 1.6 ) );
		const along = vec3( wind.x, 0, wind.y ).mul( sin( ph.add( g.y.mul( 3 ) ) ) );
		const across = vec3( wind.y.negate(), 0, wind.x ).mul( cos( ph.mul( 1.3 ).add( g.x.mul( 3 ) ) ).mul( 0.35 ) );
		swayed = p.add( along.add( across ).mul( vH.mul( 0.02 ).mul( shared.wind.strength ) ) );

	} else {

		// The bush bends from its root (2 cm at the crown in a fair gust); its sprays flutter on
		// top, each leaf on a phase of its place in the bush, so neighbours move nearly together.
		const root = attribute<'vec4'>( 'bushRoot', 'vec4' ).xyz;
		const ph = dot( g, vec3( 4.1, 3.3, 5.7 ) );
		swayed = setWindDisplacement( mat, ( wind ) => {

			const bend = mainBend( wind, p, root, vH.mul( vH ).mul( 0.022 ), 0.9 );
			const field = bend.field;
			const shake = wind.breeze.mul( field.w.mul( 0.7 ).add( 0.3 ) ).mul( vH ).mul( 0.006 );
			const flutter = vec3( 0, wave( wind.flutter, 2.3, ph ), 0 )
				.add( vec3( field.y.negate(), 0, field.x ).mul( wave( wind.flutter, 3.1, ph.mul( 1.3 ) ).mul( 0.6 ) ) );
			return bend.position.add( flutter.mul( shake ) );

		}, shared.wind );

	}
	useRestPoseShadows( mat, p, swayed, leafCastMask() );
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

export function buildFoliage( veg: Float32Array, shared: Shared ): THREE.InstancedMesh {

	const rng = mulberry32( 7 );
	const sites = pickFoliageSites( veg, rng );
	const map = leafTexture();
	const geo = bushGeometry();
	const visibility = new Float32Array( sites.length );
	geo.setAttribute( 'skyVisibility', new THREE.InstancedBufferAttribute( visibility, 1 ) );
	// each bush's root in world space, where it leans from and reads the gust field
	const roots = new Float32Array( sites.length * 4 );
	geo.setAttribute( 'bushRoot', new THREE.InstancedBufferAttribute( roots, 4 ) );
	const mat = foliageMaterial( shared, map );
	const mesh = new THREE.InstancedMesh( geo, mat, sites.length );
	keepLegacyWind( mesh, foliageMaterial( shared, map, true, mat.alphaMap! ) );
	const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qy = new THREE.Quaternion();
	const up = new THREE.Vector3( 0, 1, 0 ), dir = new THREE.Vector3(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
	const col = new THREE.Color();
	const greens = [ [ 0.065, 0.16, 0.04 ], [ 0.095, 0.19, 0.048 ], [ 0.15, 0.205, 0.046 ], [ 0.04, 0.12, 0.043 ], [ 0.18, 0.22, 0.058 ] ].map( ( [ r, gr, b ] ) => new THREE.Color( r, gr, b ) );

	let count = 0;
	sites.forEach( ( s ) => {

		// lean with the ground: bushes on the rim tip out over the edge
		dir.set( s.nx, s.ny, s.nz ).lerp( up, 0.4 ).normalize();
		q.setFromUnitVectors( up, dir );
		qy.setFromAxisAngle( up, rng() * Math.PI * 2 );
		q.multiply( qy );
		pos.set( s.x, s.y - 0.08 * s.r, s.z );
		scl.set( s.r * ( 0.9 + rng() * 0.25 ), s.r * ( 1.1 + rng() * 0.4 ), s.r * ( 0.9 + rng() * 0.25 ) );
		m.compose( pos, q, scl );
		col.copy( greens[ Math.floor( rng() * greens.length ) ] ).multiplyScalar( 0.85 + rng() * 0.35 );
		// Keep proposal collisions and random draws stable, then omit bushes rooted on stone.
		if ( ! supportsMeadow( s.y, s.ny ) ) return;
		visibility[ count ] = s.visibility;
		roots.set( [ pos.x, pos.y, pos.z, 0 ], count * 4 );
		mesh.setMatrixAt( count, m );
		mesh.setColorAt( count ++, col );

	} );

	mesh.count = count;
	mesh.instanceMatrix.needsUpdate = true;
	if ( mesh.instanceColor ) mesh.instanceColor.needsUpdate = true;
	mesh.frustumCulled = false;
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	mesh.name = 'foliage';
	mesh.renderOrder = - 1; // before the terrain: the turf it covers then fails the depth test
	return mesh;

}
