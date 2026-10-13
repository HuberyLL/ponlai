import * as THREE from 'three/webgpu';
import {
	Fn, attribute, positionGeometry, positionLocal, normalViewGeometry, materialColor, vec3, vec4, float, mix, dot, sin, cos, pow, clamp,
	smoothstep as smoothstepN, normalize, length, max, fwidth, diffuseColor, screenCoordinate, ivec2, int,
} from 'three/tsl';
import { LEAN_REF, rootPhase, setWindDisplacement, wave, windField, type WindState } from '../weather/Wind.ts';
import { keepLegacyWind } from './WindVariants.ts';
import { mulberry32 } from './noise.ts';
import { ALPHA_TO_COVERAGE, TEMPORAL } from '../post/Antialiasing.ts';
import { jitter } from '../post/Jitter.ts';
import { BUSH_STRIDE } from './FoliageSites.ts';
import { VegetationLighting, useLighting } from './VegetationLighting.ts';
import { previousSway, useRestPoseShadows } from './VegetationShadow.ts';
import type { Shared } from '../shared.ts';

// Individual folded leaves on short branching sprays. Three offset crowns keep bushes
// irregular; real leaf normals separate sunlit faces from their shaded neighbours.
//
// This module also holds what every vegetation material shares:
// - Shadow passes keep `alphaTest` and `alphaMap` but not `map`, so alpha-tested foliage sets both:
//   the leaf `map` is opaque and the silhouette lives in `alphaMap` alone, whose mips are built on
//   the CPU to keep the leaf's coverage at the cutoff (box-filtered mips fill the card). Alpha to
//   coverage turns alpha short of cutoff + `fwidth` into partial coverage, so leaf interiors stay
//   at 1 rather than scaled down.
// - `ALPHA_TO_COVERAGE` picks the coverage path by the scene's samples; single-sampled, leaves take
//   a plain alpha test and blades a dither (`coverageDither`). Under the temporal modes the leaves'
//   test is a coverage band about the cutoff instead, dithered by the same threshold
//   (`coverageAlphaTest`, `useLeafCoverage`). To find vegetation materials read
//   `userData.vegetation` (`markVegetation`), never `alphaToCoverage`: it is off without
//   multisampling, and the depth prepass (VegetationPrepass.ts) turns it off on the shaded draws.
//   The terrain's meadow detail is flagged `userData.meadowDetail` instead, so it never takes the
//   vegetation's shadow filter.
// - Vegetation draws before the terrain (`renderOrder = -1`), so the turf under it fails the depth
//   test.
// - Twigs, stems and leaf stalks (a few millimetres across) stay out of the sun's shadow map
//   (`LEAF_STEM`, VegetationShadow.ts).

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

// Whether the vegetation's cut-outs and thin blades use alpha to coverage (the AA mode's plan,
// post/Antialiasing.ts: with 4 samples only). WebGPU multisamples with 4 samples or none (three
// maps any other count to one sample), and with one sample there is no coverage to give: the
// pipeline then ignores alpha, so the softened alpha-tested edges and the grass's lowered coverage
// would all draw solid. Without it leaves take a plain alpha test at the cutoff their
// coverage-preserving mips were built for (`leafAlphaTexture`), and grass blades an ordered 4x4
// dither (`coverageDither`); under the temporal modes the leaves take a dithered band about the
// cutoff (`coverageAlphaTest`).
export { ALPHA_TO_COVERAGE };

// Tags a material as vegetation (leaves and grass blades) for passes that treat it apart, such
// as a lighter shadow filter. `alphaToCoverage` cannot tell: it is off without multisampling.
// The tag lives in userData, so a cloned material keeps it.
export function markVegetation( material: THREE.Material ): void {

	material.userData.vegetation = true;

}

// The single-sample stand-in for alpha to coverage: a 4x4 Bayer threshold (16 levels, as many as
// the hardware's 4x pattern gives). Like that pattern it is the same for every blade and leaf over a
// pixel, so overlapping blades share their covered pixels rather than adding up: the soil and
// the flowers keep showing through a stack of widened blades as they do at 4x. A hash per blade
// (alphaHash) drew independent pixels for each and closed the meadow over them.
// Under the temporal modes the threshold steps through the pattern from frame to frame, the
// pixel's Bayer value plus 5 times the jitter's dither index (Jitter.ts), mod 16: over 16 frames
// every pixel takes every threshold once (5 is coprime to 16), so the resolve sees each blade's
// coverage rather than a fixed pattern of its pixels, while the blades over a pixel still share
// one threshold in each frame. A scene at rest takes the rest sequence's indices, so a paused
// frame does not depend on the frames before it.
export const coverageDither = Fn( () => {

	const p = ivec2( screenCoordinate.xy );
	const x = p.x.bitAnd( 3 ), y = p.y.bitAnd( 3 );
	const d = x.bitXor( y );
	const bayer = d.bitAnd( 1 ).shiftLeft( 3 ).bitOr( y.bitAnd( 1 ).shiftLeft( 2 ) ).bitOr( d.bitAnd( 2 ) ).bitOr( y.shiftRight( 1 ) );
	const index = TEMPORAL ? bayer.add( int( jitter.uniforms.ditherIndex ).mul( 5 ) ).bitAnd( 15 ) : bayer;
	return float( index ).add( 0.5 ).div( 16 );

} );

/** The temporal modes' leaf cut-out: a pixel keeps a share of an alpha-tested edge, as alpha to
 * coverage gives at 4x. The leaf's alpha crosses its cutoff over about one pixel (`fwidth`); the
 * share kept is ( alpha - cutoff ) / fwidth + 0.5, a band centred on the cutoff, and a pixel keeps
 * the leaf in a frame when the share reaches the frame's dither threshold (`coverageDither`), so the
 * resolve averages the edge's coverage instead of a hard step that crawls as the leaf moves across
 * pixels (a plain test at one sample a pixel). Centred on the cutoff, the band keeps the area the
 * coverage-preserving mips were built for (`leafAlphaTexture`). Returns the threshold for three's
 * alpha test, which discards alpha at or below it: alpha <= cutoff + ( threshold - 0.5 ) fwidth is
 * the band below the threshold. fwidth is taken at the top of the alpha test, before any branch of
 * three's (derivatives need uniform control flow). */
export function coverageAlphaTest( alpha: F, cutoff: F ): F {

	const width = max( fwidth( alpha ), 1e-4 );
	return cutoff.add( coverageDither().sub( 0.5 ).mul( width ) );

}

/** Under the temporal modes the leaf material's alpha test is the coverage band
 * (`coverageAlphaTest`), as its `alphaTestNode`: the depth prepass's copy takes it
 * (VegetationPrepass.ts) and the shaded draw leaves it out of its shader there, while the shadow
 * passes copy only the numeric `alphaTest` and keep their plain cut-out. 4x and one sample outside
 * the temporal modes keep theirs (alpha to coverage, the plain test). Set explicitly on every leaf
 * material: a cloned node material loses its numeric `alphaTest` (RimFoliage.ts), so its depth copy
 * had no cut-out at all under the temporal modes before this. */
export function useLeafCoverage( material: THREE.NodeMaterial, cutoff = LEAF_ALPHA_TEST ): void {

	if ( TEMPORAL ) material.alphaTestNode = coverageAlphaTest( diffuseColor.a, float( cutoff ) );

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
 * taller plants (the game's palm). `wind` is the frame's wind state (`shared.wind`, or
 * `.previous`). Returns the bent position and the wind field's ( direction x, direction z, lean,
 * gust ) at the root. */
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
	useRestPoseShadows( mat, p, swayed, leafCastMask(), previousSway( mat, shared.wind ) );
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

/** Writes `instances` into the bushes' buffers (their used part re-uploaded) and sets the count. */
export function setBushes( mesh: THREE.InstancedMesh, instances: BushInstances ): void {

	const put = ( attribute: THREE.BufferAttribute, values: Float32Array ) => {

		( attribute.array as Float32Array ).set( values );
		attribute.clearUpdateRanges();
		attribute.addUpdateRange( 0, Math.max( values.length, attribute.itemSize ) );
		attribute.needsUpdate = true;

	};
	put( mesh.instanceMatrix, instances.matrices );
	put( mesh.instanceColor!, instances.colors );
	put( mesh.geometry.getAttribute( 'skyVisibility' ) as THREE.BufferAttribute, instances.visibility );
	put( mesh.geometry.getAttribute( 'bushRoot' ) as THREE.BufferAttribute, instances.roots );
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
	keepLegacyWind( mesh, foliageMaterial( shared, map, true, mat.alphaMap! ) );
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
