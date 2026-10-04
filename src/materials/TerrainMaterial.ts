import * as THREE from 'three/webgpu';
import {
	Fn, If, struct, texture, attribute, uniform, float, vec2, vec3, vec4, mat2, positionWorld, normalWorldGeometry, cameraViewMatrix,
	normalize, abs, pow, max, min, dot, sign, mix, smoothstep, clamp, fract, sin, exp, select, dFdx, dFdy,
} from 'three/tsl';
import type { Shared } from '../shared.ts';
import type { DetailTextures } from './ProceduralTextures.ts';
import { MEADOW_EXTENT } from './Meadow.ts';
import { causticsAt, type Caustics } from '../ocean/Caustics.ts';
import { refractedSunDirectionNode, refractedSunBeamScaleNode } from '../lighting/RefractedSun.ts';

// PBR materials for the rock and the sea floor: MeshStandardNodeMaterial (lights, shadows, IBL)
// with the surface built procedurally in world space (triplanar baked detail, moss, wet band,
// algae, sediment) and the light below the water attenuated on its way down (sun path through
// the water column, caustics, ambient) by a lighting model of its own, so the water shader only
// has to add the view path.
//
// kind 'cliff'  : island block, sea stacks and rocks (triplanar)
// kind 'seabed' : sand, ripples, seagrass and rubble (planar)

type V3 = THREE.Node<'vec3'>;
type V2 = THREE.Node<'vec2'>;
type F = THREE.Node<'float'>;

const Surface = struct( { albedo: 'vec3', normal: 'vec3', rough: 'float', ao: 'float' } );
interface SurfaceNode { get( name: 'albedo' | 'normal' ): V3; get( name: 'rough' | 'ao' ): F }

// Whiteout triplanar blend (after Ben Golus), with the projection handedness preserved.
// A principal axis must retain the geometry normal's sign: abs() would turn every west- or
// south-facing wall toward the light and paint false bright patches across the rock.
const triNormal = Fn( ( [ tx, ty, tz, n, w, k ]: [ V2, V2, V2, V3, V3, F ] ) => {

	const sg = sign( n );
	const nx = vec3( n.x, n.y.add( tx.y.mul( k ) ), n.z.add( tx.x.mul( k ).mul( sg.x ) ) );
	const ny = vec3( n.x.add( ty.x.mul( k ).mul( sg.y ) ), n.y, n.z.add( ty.y.mul( k ) ) );
	const nz = vec3( n.x.sub( tz.x.mul( k ).mul( sg.z ) ), n.y.add( tz.y.mul( k ) ), n.z );
	return normalize( nx.mul( w.x ).add( ny.mul( w.y ) ).add( nz.mul( w.z ) ) );

} ).setLayout( {
	name: 'terrainTriplanarNormal', type: 'vec3',
	inputs: [
		{ name: 'tx', type: 'vec2' }, { name: 'ty', type: 'vec2' }, { name: 'tz', type: 'vec2' },
		{ name: 'n', type: 'vec3' }, { name: 'w', type: 'vec3' }, { name: 'k', type: 'float' },
	],
} );

const unpack2 = ( v: THREE.Node<'vec4'> | V2 ) => ( v as V2 ).mul( 2 ).sub( 1 );
// Convert tangent normals to slopes before whiteout blending, retaining the scan's +Y axis.
const stoneSlope = Fn( ( [ v ]: [ THREE.Node<'vec4'> ] ) => {

	return unpack2( v.xy ).div( max( v.z.mul( 2 ).sub( 1 ), 0.3 ) );

} ).setLayout( { name: 'stoneNormalSlope', type: 'vec2', inputs: [ { name: 'sample', type: 'vec4' } ] } );

interface Ctx { tex: DetailTextures; shared: Shared; topY: F; vegetation: boolean; shore: THREE.Texture }
interface TerrainOptions { topY?: number; vegetation?: boolean }

function cliffSurface( { tex, shared, topY, vegetation }: Ctx ) {

	return Fn( () => {

		const p = positionWorld;
		const n0 = normalize( normalWorldGeometry ).toVar();
		// Bare stone must always sample its mineral maps, including upward sea-stack caps.
		const turf = ( vegetation ? smoothstep( 0.85, 0.97, n0.y ).mul( smoothstep( topY.sub( 0.6 ), topY.sub( 0.2 ), p.y ) ) : float( 0 ) ).toVar();
		const vAO = attribute<'float'>( 'ao', 'float' ), vTint = attribute<'float'>( 'tint', 'float' ), vCurv = attribute<'float'>( 'curv', 'float' );

		// triplanar weights; projections with a negligible share are skipped (most pixels need one
		// or two of the three), gradients taken outside the branches so mip selection stays right
		const w0 = pow( abs( n0 ), vec3( 4 ) );
		const w1 = max( w0.div( dot( w0, vec3( 1 ) ) ).sub( 0.02 ), 0 );
		const w = w1.div( dot( w1, vec3( 1 ) ) ).toVar();
		const S = 0.55; // ~1.8 m per tile
		const sg = sign( n0 );
		const uvX = vec2( p.z.mul( sg.x ), p.y ).mul( S ).toVar(), uvY = vec2( p.x.mul( sg.y ), p.z ).mul( S ).toVar(), uvZ = vec2( p.x.negate().mul( sg.z ), p.y ).mul( S ).toVar();
		const gxX = dFdx( uvX ).toVar(), gyX = dFdy( uvX ).toVar(), gxY = dFdx( uvY ).toVar(), gyY = dFdy( uvY ).toVar(), gxZ = dFdx( uvZ ).toVar(), gyZ = dFdy( uvZ ).toVar();
		const half = vec4( 0.5 );
		const hX = half.toVar(), hY = half.toVar(), hZ = half.toVar();
		const aX = half.toVar(), aY = half.toVar(), aZ = half.toVar();
		const fX = vec4( 0.5, 0.5, 1, 0.9 ).toVar(), fY = fX.toVar(), fZ = fX.toVar();
		const cX = half.toVar(), cY = half.toVar(), cZ = half.toVar();
		const stoneScale = ( 1 / 1.8 ) / S; // Art-direct the 2.7 m scan to smaller flakes beneath the mesh fractures.
		If( w.x.greaterThan( 0 ), () => {

			hX.assign( texture( tex.heights, uvX ).grad( gxX, gyX ) );
			if ( vegetation ) aX.assign( texture( tex.normalsA, uvX ).grad( gxX, gyX ) );
			If( turf.lessThan( 1 ), () => {

				fX.assign( texture( tex.rockDetail, uvX.mul( stoneScale ) ).grad( gxX.mul( stoneScale ), gyX.mul( stoneScale ) ) );
				cX.assign( texture( tex.rockAlbedo, uvX.mul( stoneScale ) ).grad( gxX.mul( stoneScale ), gyX.mul( stoneScale ) ) );

			} );

		} );
		If( w.y.greaterThan( 0 ), () => {

			hY.assign( texture( tex.heights, uvY ).grad( gxY, gyY ) );
			if ( vegetation ) aY.assign( texture( tex.normalsA, uvY ).grad( gxY, gyY ) );
			If( turf.lessThan( 1 ), () => {

				fY.assign( texture( tex.rockDetail, uvY.mul( stoneScale ) ).grad( gxY.mul( stoneScale ), gyY.mul( stoneScale ) ) );
				cY.assign( texture( tex.rockAlbedo, uvY.mul( stoneScale ) ).grad( gxY.mul( stoneScale ), gyY.mul( stoneScale ) ) );

			} );

		} );
		If( w.z.greaterThan( 0 ), () => {

			hZ.assign( texture( tex.heights, uvZ ).grad( gxZ, gyZ ) );
			if ( vegetation ) aZ.assign( texture( tex.normalsA, uvZ ).grad( gxZ, gyZ ) );
			If( turf.lessThan( 1 ), () => {

				fZ.assign( texture( tex.rockDetail, uvZ.mul( stoneScale ) ).grad( gxZ.mul( stoneScale ), gyZ.mul( stoneScale ) ) );
				cZ.assign( texture( tex.rockAlbedo, uvZ.mul( stoneScale ) ).grad( gxZ.mul( stoneScale ), gyZ.mul( stoneScale ) ) );

			} );

		} );
		const H = hX.mul( w.x ).add( hY.mul( w.y ) ).add( hZ.mul( w.z ) ).toVar();
		const Fc = fX.mul( w.x ).add( fY.mul( w.y ) ).add( fZ.mul( w.z ) ).toVar();
		const stoneColor = cX.rgb.mul( w.x ).add( cY.rgb.mul( w.y ) ).add( cZ.rgb.mul( w.z ) ).toVar();
		const big = texture( tex.normalsB, p.xz.mul( 0.019 ).add( p.y.mul( 0.011 ) ) ).a.toVar(); // large-scale variation
		const big2 = texture( tex.normalsB, p.zx.mul( 0.047 ).add( vec2( 0.31, p.y.mul( 0.03 ) ) ) ).a.toVar();

		// Geometry owns the large fractures. Low-amplitude mineral relief avoids inflated,
		// unrelated Voronoi facets that fight those planes and read as moulded plastic.
		const nRock = triNormal( stoneSlope( fX ), stoneSlope( fY ), stoneSlope( fZ ), n0, w, float( 0.6 ) );

		// --- limestone: broad cool-grey faces with restrained mineral variation. Geometry and
		// sunlight define the edges; curvature only adds a little weathering, never a white outline.
		const convex = smoothstep( 1.6, 5.0, vCurv );
		const concave = smoothstep( - 0.5, - 3.0, vCurv ).toVar();
		const stoneLuma = dot( stoneColor, vec3( 0.2126, 0.7152, 0.0722 ) ).toVar();
		const rock = mix( vec3( 0.155, 0.162, 0.158 ), vec3( 0.235, 0.238, 0.22 ), vTint ).toVar();
		rock.mulAssign( mix( vec3( 0.97, 0.99, 1.03 ), vec3( 1.025, 1.0, 0.965 ), fract( vTint.mul( 7.31 ) ) ) );
		// Desaturate the source to fit this limestone palette, but keep its correlated grain,
		// mineral stains and roughness. Fine colour follows the same relief as the normal map.
		const mineral = clamp( mix( vec3( stoneLuma ), stoneColor, 0.25 ).div( 0.22 ), vec3( 0.42 ), vec3( 1.7 ) );
		rock.mulAssign( mix( vec3( 1 ), mineral, 0.72 ) );
		rock.mulAssign( big.sub( 0.5 ).mul( 0.18 ).add( 0.98 ) );
		rock.assign( mix( rock, rock.mul( vec3( 1.12, 1.02, 0.86 ) ), smoothstep( 0.55, 0.85, big2 ).mul( 0.5 ) ) ); // faint ochre
		// runoff: faint darker streaks down the faces
		const along = mix( p.z, p.x, w.z.div( max( w.x.add( w.z ), 1e-3 ) ) );
		const streaks = texture( tex.normalsB, vec2( along.mul( 0.55 ), p.y.mul( 0.018 ).add( along.mul( 0.002 ) ) ) ).a;
		const streaks2 = texture( tex.normalsB, vec2( along.mul( 2.3 ).add( 0.37 ), p.y.mul( 0.04 ) ) ).a;
		const vert = float( 1 ).sub( smoothstep( 0.35, 0.75, abs( n0.y ) ) );
		rock.mulAssign( mix( float( 1 ), mix( float( 0.83 ), float( 1.055 ), smoothstep( 0.3, 0.7, streaks.mul( 0.65 ).add( streaks2.mul( 0.45 ) ) ) ), vert ) );
		rock.assign( mix( rock, min( rock.mul( 1.09 ), vec3( 0.5 ) ), convex.mul( 0.24 ) ) );
		rock.mulAssign( mix( float( 1 ), float( 0.9 ), concave ) );
		// lichen: pale crusts and dark spots on the dry stone
		const lichen = H.a.mul( smoothstep( 0.4, 1.4, p.y ) ).mul( smoothstep( 0.3, 0.6, big2 ) );
		rock.assign( mix( rock, vec3( 0.42, 0.41, 0.33 ), lichen.mul( 0.45 ) ) );
		const spots = smoothstep( 0.62, 0.8, H.g ).mul( smoothstep( 0.45, 0.7, big ) ).mul( smoothstep( 0.5, 1.5, p.y ) );
		rock.mulAssign( float( 1 ).sub( spots.mul( 0.35 ) ) );

		const up = n0.y;
		const Hg = H.g.toVar();
		const albedo = rock.toVar();
		const nW = nRock.toVar();
		const stoneRough = clamp( Fc.a.mul( 0.34 ).add( 0.62 ), 0.8, 0.98 );
		const rough = stoneRough.toVar();

		// Soil-connected island ledges carry moss and turf. Bare sea stacks and reefs omit
		// these nodes entirely, so an upward rock face cannot turn into a green cap.
		if ( vegetation ) {

			const mossN = H.g.sub( 0.5 ).mul( 0.5 ).add( big.sub( 0.5 ).mul( 0.6 ) );
			const dry = smoothstep( 0.7, 1.6, p.y );
			const lip = smoothstep( topY.sub( 0.55 ), topY.sub( 0.1 ), p.y.add( mossN.mul( 0.6 ) ) );
			const streak = texture( tex.normalsB, vec2( p.x.add( p.z ).mul( 0.9 ), p.y.mul( 0.05 ) ) ).a;
			const hang = smoothstep( topY.sub( 0.5 ).sub( streak.mul( 1.6 ) ), topY.sub( 0.2 ).sub( streak.mul( 0.9 ) ), p.y ).mul( smoothstep( 0.55, 0.72, streak.add( H.g.mul( 0.25 ) ) ) );
			// Only ledges connected to the soil can carry an unbroken carpet. Isolated upward
			// fracture facets receive sparse weathering, rather than a solid green triangle.
			const nearSoil = smoothstep( topY.sub( 0.75 ), topY.sub( 0.22 ), p.y );
			const ledgePatch = smoothstep( 0.38, 0.67, H.g.mul( 0.7 ).add( big2.mul( 0.3 ) ) );
			const ledgeMoss = smoothstep( 0.55, 0.88, up.add( mossN ) ).mul( mix( ledgePatch.mul( 0.3 ), float( 1 ), nearSoil ) );
			// Fully covered turf skips stone scan samples; slope transitions retain mineral shading.
			const moss = max( turf, clamp( max( ledgeMoss, max( lip.mul( smoothstep( - 0.35, 0.3, up ) ), hang.mul( 0.6 ) ) ).mul( dry ), 0, 1 ) ).toVar();
			const mossC = mix( vec3( 0.025, 0.06, 0.015 ), vec3( 0.11, 0.2, 0.035 ), smoothstep( 0.2, 0.9, H.g ) ).toVar();
			mossC.mulAssign( smoothstep( 0.3, 0.8, texture( tex.heights, p.xz.mul( 0.9 ).add( p.y.mul( 0.5 ) ) ).g ).mul( 0.6 ).add( 0.7 ) );
			mossC.assign( mix( mossC, vec3( 0.2, 0.21, 0.06 ), smoothstep( 0.6, 0.9, big2 ).mul( 0.35 ) ) ); // sun-dried
			// Continue the short meadow bed over the rounded shoulder before yielding to rock.
			const turfRim = smoothstep( 0.4, 0.88, up ).mul( smoothstep( topY.sub( 0.48 ), topY.sub( 0.12 ), p.y.add( mossN.mul( 0.15 ) ) ) );
			const turfCover = max( turf, turfRim ).toVar();
			If( turfCover.greaterThan( 0 ), () => {

				const q1 = p.xz.mul( 0.23 ), q2 = mat2( 0.8, - 0.6, 0.6, 0.8 ).mul( p.xz ).mul( 0.61 ).add( 0.37 );
				const c1 = texture( tex.heights, q1 ).level( float( 0 ) ).g, c2 = texture( tex.heights, q2 ).level( float( 0 ) ).g;
				const meadow = texture( tex.meadow, p.xz.div( MEADOW_EXTENT ).add( 0.5 ) ).level( float( 0 ) );
				// Broad growth and colour match the instanced blades. Fine relief stays subdued so
				// the bed reads as soil-bound turf, rather than a second layer of rounded moss lumps.
				const fibres = smoothstep( 0.2, 0.65, c1.mul( 0.55 ).add( c2.mul( 0.45 ) ) );
				const grassC = meadow.rgb.mul( mix( float( 0.75 ), float( 1.2 ), fibres ) ).mul( 0.9 ).toVar();
				// A little exposed humus in the shortest patches interrupts the continuous green lid.
				const sparse = smoothstep( 0.2, 0.03, meadow.a );
				grassC.assign( mix( grassC, vec3( 0.072, 0.064, 0.036 ), sparse.mul( 0.45 ) ) );
				mossC.assign( mix( mossC, grassC, turfCover ) );
				Hg.assign( mix( Hg, c1.mul( 0.5 ).add( c2.mul( 0.5 ) ), turf ) );

			} );

			const nMoss = triNormal( unpack2( aX.zw ), unpack2( aY.zw ), unpack2( aZ.zw ), n0, w, float( 0.8 ) );
			albedo.assign( mix( rock, mossC, moss ) );
			const nBed = normalize( mix( nMoss, n0, turfCover.mul( 0.2 ) ) );
			nW.assign( normalize( mix( nRock, nBed, moss ) ) );
			rough.assign( mix( stoneRough, float( 0.94 ), moss ) );

		}

		// --- the tidal band: wet, dark, glossy; green-black algae just below the waterline;
		// silt and sediment on the submerged ledges
		const wl = shared.waterLevel.add( sin( shared.time.mul( 0.9 ).add( p.x.mul( 0.4 ) ).add( p.z.mul( 0.3 ) ) ).mul( 0.08 ) );
		const wet = float( 1 ).sub( smoothstep( 0, 0.32, p.y.sub( wl ).sub( 0.06 ).sub( H.r.sub( 0.5 ).mul( 0.25 ) ) ) );
		const algae = float( 1 ).sub( smoothstep( - 0.05, 0.35, p.y.sub( wl ).add( Hg.sub( 0.5 ).mul( 0.5 ) ) ) );
		const deep = smoothstep( - 0.6, - 2.5, p.y );
		const algaeC = mix( vec3( 0.035, 0.05, 0.02 ), vec3( 0.09, 0.085, 0.045 ), deep );
		const silt = smoothstep( 0.35, 0.8, up ).mul( smoothstep( - 0.4, - 1.2, p.y ) );

		// Keep a dark tidal band, but reveal mineral faces farther below it. A deeper
		// water column should show a submerged cliff, rather than a solid green plinth.
		const algaeCoverage = algae.mul( mix( float( 0.85 ), float( 0.5 ), deep ) );
		albedo.assign( mix( albedo, algaeC.mul( H.r.mul( 0.6 ).add( 0.7 ) ), algaeCoverage ) );
		albedo.assign( mix( albedo, vec3( 0.30, 0.26, 0.19 ), silt.mul( 0.7 ) ) );
		albedo.mulAssign( mix( float( 1 ), float( 0.5 ), wet.mul( float( 1 ).sub( algae.mul( 0.5 ) ) ) ) );
		rough.assign( mix( rough, float( 0.28 ), wet.mul( float( 1 ).sub( deep ) ) ) );

		const ao = max( vAO, 0.3 ).mul( mix( float( 1 ), float( 0.72 ), concave ) );
		return Surface( albedo, nW, rough, ao );

	} )();

}

function seabedSurface( { tex, shore }: Ctx, shoreXform: THREE.Node<'vec4'> ) {

	return Fn( () => {

		const p = positionWorld;
		const n0 = normalize( normalWorldGeometry ).toVar();
		const S = 0.27; // ripple tile ~3.7 m
		const q = p.xz.mul( S );
		const H = texture( tex.heights, q ).toVar();
		const A = texture( tex.normalsA, q.mul( 0.7 ).add( 0.13 ) );
		const B = texture( tex.normalsB, q );
		const big = texture( tex.normalsB, p.xz.mul( 0.013 ).add( 0.2 ) ).a;
		const big2 = texture( tex.normalsB, p.zx.mul( 0.031 ).add( 0.6 ) ).a;
		const sd = texture( shore, p.xz.sub( shoreXform.xy ).mul( shoreXform.zw ) ).r;

		// Broad sand colour carries the shallows; low-relief ripples stay subordinate so the
		// ocean does not look like a transparent lid over an engraved, striped floor.
		const nearIsland = float( 1 ).sub( smoothstep( 2, 14, sd ) );
		const sand = mix( vec3( 0.19, 0.2, 0.18 ), vec3( 0.38, 0.38, 0.33 ), smoothstep( 0.1, 0.9, H.b.mul( 0.23 ).add( big.mul( 0.87 ) ) ) )
			.mul( H.g.mul( 0.1 ).add( 0.95 ) ).mul( mix( float( 0.7 ), float( 1.1 ), nearIsland ) );
		// seagrass and algae beds: dark olive patches with soft edges
		const grass = smoothstep( 0.5, 0.62, big2.add( H.r.sub( 0.5 ).mul( 0.2 ) ) ).mul( smoothstep( 2, 6, sd ) );
		const grassC = mix( vec3( 0.035, 0.06, 0.03 ), vec3( 0.09, 0.13, 0.06 ), H.g );
		// rubble and boulders shed from the cliffs
		const rubble = float( 1 ).sub( smoothstep( 0.5, big.mul( 3 ).add( 5 ), sd ) ).mul( smoothstep( 0.3, 0.55, H.r ) );
		const rubbleC = mix( vec3( 0.10, 0.11, 0.10 ), vec3( 0.24, 0.24, 0.21 ), H.r );

		const nSand = normalize( vec3( B.r.mul( 2 ).sub( 1 ), 0, B.g.mul( 2 ).sub( 1 ) ).mul( 0.18 ).add( vec3( 0, 1, 0 ) ) );
		const nRock = normalize( vec3( A.r.mul( 2 ).sub( 1 ), 0, A.g.mul( 2 ).sub( 1 ) ).mul( 1.3 ).add( vec3( 0, 1, 0 ) ) );
		// keep the macro slope of the mesh
		const t = normalize( n0.cross( vec3( 0, 0, 1 ) ) );
		const b = t.cross( n0 );
		const dn = mix( nSand, nRock, max( rubble, grass.mul( 0.6 ) ) );
		const nW = normalize( t.mul( dn.x ).add( n0.mul( dn.y ) ).add( b.mul( dn.z ) ) );

		const albedo = mix( mix( sand, grassC, grass ), rubbleC, rubble );
		const ao = mix( float( 1 ), float( 0.75 ), rubble ).mul( mix( float( 0.8 ), float( 1 ), H.b ) );
		return Surface( albedo, nW, float( 0.92 ), ao );

	} )();

}

// Light below the surface: the sun path through the water column (with caustics) and the
// dimmer, bluer ambient; above the water, a faint caustic shimmer reflected onto the rock.
class TerrainLightingModel extends THREE.PhysicalLightingModel {

	sunAtt: V3; ambMul: V3; specMul: V3;
	sunDirection: V3; underwater: THREE.Node<'bool'>;

	constructor( sunAtt: V3, ambMul: V3, specMul: V3, sunDirection: V3, underwater: THREE.Node<'bool'> ) {

		super();
		this.sunAtt = sunAtt; this.ambMul = ambMul; this.specMul = specMul;
		this.sunDirection = sunDirection; this.underwater = underwater;

	}

	direct( input: THREE.LightingModelDirectInput, builder: THREE.NodeBuilder ): void {

		super.direct( { ...input,
			lightDirection: select( this.underwater, this.sunDirection, input.lightDirection as V3 ),
			lightColor: ( input.lightColor as V3 ).mul( this.sunAtt ),
		}, builder );

	}

	indirect( builder: THREE.NodeBuilder ): void {

		super.indirect( builder );
		const reflected = ( builder.context as unknown as { reflectedLight: { indirectDiffuse: V3; indirectSpecular: V3 } } ).reflectedLight;
		reflected.indirectDiffuse.mulAssign( this.ambMul );
		reflected.indirectSpecular.mulAssign( this.specMul );

	}

}

export function makeTerrainMaterial( kind: 'cliff' | 'seabed', tex: DetailTextures, shared: Shared, caustics: Caustics, shore: THREE.Texture, { topY = 3.1, vegetation = true }: TerrainOptions = {} ): THREE.MeshStandardNodeMaterial {

	const mat = new THREE.MeshStandardNodeMaterial( { roughness: 0.85, metalness: 0 } );
	const topYU = uniform( topY );
	const ctx: Ctx = { tex, shared, topY: topYU, vegetation, shore };
	const call = kind === 'seabed' ? seabedSurface( ctx, shared.shoreXform ) : cliffSurface( ctx );
	const surf = ( call as unknown as { toVar( name: string ): SurfaceNode } ).toVar( 'surf' );
	mat.colorNode = surf.get( 'albedo' );
	mat.roughnessNode = surf.get( 'rough' );
	mat.normalNode = normalize( cameraViewMatrix.mul( vec4( surf.get( 'normal' ), 0 ) ).xyz );
	mat.aoNode = surf.get( 'ao' );

	// the water column above this point
	const p = positionWorld;
	const dW = shared.waterLevel.sub( p.y );
	const sigT = shared.sigA.add( shared.sigS );
	const under = dW.greaterThan( 0 );
	const caus = causticsAt( caustics, p, dW.max( 0 ) );
	// Snell's direction and the beam-area factor must change together. For a horizontal
	// floor, muWater * (muAir / muWater) preserves transmitted horizontal irradiance;
	// steep submerged walls now receive the correct refracted projection as well.
	const waterSun = refractedSunDirectionNode( shared.sunDir );
	const waterSunView = normalize( cameraViewMatrix.mul( vec4( waterSun, 0 ) ).xyz );
	const sunAtt = select( under, exp( sigT.negate().mul( dW ).div( waterSun.y ) )
		.mul( shared.sunIntoWater ).mul( refractedSunBeamScaleNode( shared.sunDir ) ).mul( caus ), vec3( 1 ) );
	const ambAtt = exp( sigT.negate().mul( dW.max( 0 ) ).mul( 1.25 ) );
	const above = p.y.sub( shared.waterLevel );
	const shimmer = causticsAt( caustics, p, above.mul( 0.6 ).add( 1.4 ) ).sub( 0.6 ).mul( 0.9 ).mul( float( 1 ).sub( smoothstep( 0, 1.2, above ) ) );
	const ambMul = select( under, ambAtt, vec3( float( 1 ).add( shimmer ) ) );
	const specMul = select( under, ambAtt.mul( 0.5 ), vec3( 1 ) );
	( mat as unknown as { setupLightingModel: () => THREE.LightingModel } ).setupLightingModel = () => new TerrainLightingModel( sunAtt, ambMul, specMul, waterSunView, under );
	mat.userData.refractedSolarReceiver = true;
	mat.userData.refractedSolarFloor = kind === 'seabed';
	mat.userData.topY = topYU;
	mat.userData.vegetation = vegetation;
	return mat;

}

export type { F };
