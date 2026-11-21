/*!
 * The filters and the order of their draws are adapted from three.js's PMREMGenerator
 * (src/renderers/common/extras/PMREMGenerator.js) and PMREMUtils (src/nodes/pmrem/PMREMUtils.js).
 * SPDX-FileCopyrightText: Copyright © 2010-2026 three.js authors
 * SPDX-License-Identifier: MIT
 */

import * as THREE from 'three/webgpu';
import { compileInto } from '../post/graph/Compile.ts';
import { Fn, If, Loop, abs, cos, cross, cubeTexture, dot, equirectUV, float, int, inverseSqrt, log2, max, normalize, positionWorldDirection, select, sin, sqrt, texture, uint, uniform, vec2, vec3, vec4 } from 'three/tsl';

// The environment's GGX prefilter, drawn one cube at a time.
//
// An equirect is drawn into a source cube, then each level of a PMREM is filtered from that cube.
//
// The result is a PMREM as three's `pmremTexture` samples it: a half-float cube render target whose
// mip levels hold GGX-filtered radiance, level `lod` filtered for the roughness
// `PMREMGenerator.lodToRoughness( lod, maxLod )` (three's public mapping, whose inverse the
// sampler applies), down to an 8 px face. Marking its texture `isPMREMTexture` tells the sampler to
// take it as it is. The filters are three's own (Heitz 2018, "Sampling the GGX Distribution of
// Visible Normals", JCGT 7(4), for the sharp levels; a weighted sum over every texel of a 16 px
// source level for the three roughest), copied here with the order of their draws, so a PMREM
// comes out as three's generator makes it. Owning them lets a bake run as steps, one cube (six
// render passes) at a time (sky/SkyBake.ts `environmentSlices`), with no private member of three.
//
// The levels read the source cube alone, so they do not depend on each other; the source cube is
// this prefilter's own between the steps, so a bake spread over frames finishes before another
// starts (Sky.ts `update`).

// the smallest face of a PMREM; a smaller source is drawn up to it, so every PMREM has its levels
const MIN_SIZE = 256;
// log2 of the roughest level's face: a smaller face cannot hold the diffuse lobe it stores
const LOD_MIN = 3;
// the sharp levels' GGX samples
const GGX_SAMPLES = 256;
// the source level the rough levels sum over, and how many of the roughest levels do
const INTEGRATION_SIZE = 16;
const INTEGRATION_LEVELS = 3;

// Van der Corput's radical inverse, and the Hammersley point i of N.
const radicalInverse = Fn( ( [ bitsImmutable ]: [ U ] ) => {

	const bits = uint( bitsImmutable ).toVar();
	bits.assign( bits.shiftLeft( uint( 16 ) ).bitOr( bits.shiftRight( uint( 16 ) ) ) );
	bits.assign( bits.bitAnd( uint( 0x55555555 ) ).shiftLeft( uint( 1 ) ).bitOr( bits.bitAnd( uint( 0xAAAAAAAA ) ).shiftRight( uint( 1 ) ) ) );
	bits.assign( bits.bitAnd( uint( 0x33333333 ) ).shiftLeft( uint( 2 ) ).bitOr( bits.bitAnd( uint( 0xCCCCCCCC ) ).shiftRight( uint( 2 ) ) ) );
	bits.assign( bits.bitAnd( uint( 0x0F0F0F0F ) ).shiftLeft( uint( 4 ) ).bitOr( bits.bitAnd( uint( 0xF0F0F0F0 ) ).shiftRight( uint( 4 ) ) ) );
	bits.assign( bits.bitAnd( uint( 0x00FF00FF ) ).shiftLeft( uint( 8 ) ).bitOr( bits.bitAnd( uint( 0xFF00FF00 ) ).shiftRight( uint( 8 ) ) ) );
	return float( bits ).mul( 2.3283064365386963e-10 );

} );
const hammersley = Fn( ( [ i, n ]: [ U, U ] ) => vec2( float( i ).div( float( n ) ), radicalInverse( i ) ) );

type F = THREE.Node<'float'>;
type I = THREE.Node<'int'>;
type U = THREE.Node<'uint'>;
type CubeNode = ReturnType<typeof cubeTexture>;

// A sharp level: GGX with visible-normal sampling, the view along the normal. Each sample reads the
// source level whose texels match its solid angle (filtered importance sampling), so a small, very
// bright source stays smooth.
const ggxConvolution = ( roughness: F, lodBias: F, envMap: CubeNode ) => Fn( () => {

	const N = vec3( positionWorldDirection ).toVar();
	const prefiltered = vec3( 0.0 ).toVar();
	If( roughness.lessThan( 0.001 ), () => {

		prefiltered.assign( envMap.sample( N ).level( float( 0 ) ).rgb );

	} ).Else( () => {

		const alpha = roughness.mul( roughness ).toConst();
		const alpha2 = alpha.mul( alpha ).toConst();
		const up = select( abs( N.z ).lessThan( 0.999 ), vec3( 0.0, 0.0, 1.0 ), vec3( 1.0, 0.0, 0.0 ) );
		const tangent = normalize( cross( up, N ) ).toVar();
		const bitangent = cross( N, tangent ).toVar();
		const totalWeight = float( 0.0 ).toVar();
		Loop( { start: uint( 0 ), end: uint( GGX_SAMPLES ) }, ( { i } ) => {

			const Xi = hammersley( i, uint( GGX_SAMPLES ) );
			// with V = N, the reflected direction is sampled directly
			const invQ = float( 1.0 ).div( Xi.x.oneMinus().add( alpha2.mul( Xi.x ) ) ).toConst();
			const NdotL = Xi.x.oneMinus().sub( alpha2.mul( Xi.x ) ).mul( invQ ).toConst();
			If( NdotL.greaterThan( 0.0 ), () => {

				const phi = Xi.y.mul( 2.0 * Math.PI ).toConst();
				const sinTheta = alpha.mul( 2.0 ).mul( sqrt( Xi.x.mul( Xi.x.oneMinus() ) ) ).mul( invQ ).toConst();
				const L = N.mul( NdotL ).add( tangent.mul( cos( phi ) ).add( bitangent.mul( sin( phi ) ) ).mul( sinTheta ) ).toConst();
				// the source level that matches the sample's solid angle (see `lodBias`)
				const lod = max( log2( alpha2.mul( invQ ) ).add( lodBias ), 0.0 );
				prefiltered.addAssign( envMap.sample( L ).level( lod ).rgb.mul( NdotL ) );
				totalWeight.addAssign( NdotL );

			} );

		} );
		prefiltered.divAssign( totalWeight );

	} );
	return vec4( prefiltered, 1.0 );

} )();

// A rough level: every texel of a small source level weighted by the GGX lobe, free of sampling
// noise and, for wide lobes, cheaper than importance sampling.
const ggxIntegration = ( roughness: F, sourceLod: F, sourceSize: I, envMap: CubeNode ) => Fn( () => {

	const N = vec3( positionWorldDirection ).toVar();
	const alpha = roughness.mul( roughness ).toConst();
	const alpha2 = alpha.mul( alpha ).toConst();
	const texelSize = float( 2.0 ).div( float( sourceSize ) ).toConst();
	const prefiltered = vec3( 0.0 ).toVar();
	const totalWeight = float( 0.0 ).toVar();
	// opposite texels in pairs: only the one in N's hemisphere contributes
	// (the rows and columns of a face as one counter, in the same order: three counters exceed one Loop)
	Loop( { start: int( 0 ), end: int( 3 ) }, { start: int( 0 ), end: sourceSize.mul( sourceSize ) }, ( { i: face, j: texel }: { i: I; j: I } ) => {

		const y = texel.div( sourceSize ), x = texel.mod( sourceSize );

		const uv = vec2( x, y ).add( 0.5 ).mul( texelSize ).sub( 1.0 ).toConst();
		const texelDirection = select( face.equal( 0 ), vec3( 1.0, uv ), select( face.equal( 1 ), vec3( uv.x, 1.0, uv.y ), vec3( uv, 1.0 ) ) ).toVar();
		const invDistance = inverseSqrt( dot( uv, uv ).add( 1.0 ) ).toConst();
		const NdotL = dot( N, texelDirection ).toVar();
		texelDirection.mulAssign( select( NdotL.lessThan( 0.0 ), - 1.0, 1.0 ) );
		NdotL.assign( abs( NdotL ).mul( invDistance ) );
		// with V = N, NdotH squared is ( 1 + NdotL ) / 2; the factors common to the GGX
		// distribution and the texel's solid angle cancel in the normalisation
		const d = alpha2.add( 1.0 ).add( alpha2.sub( 1.0 ).mul( NdotL ) );
		const weight = NdotL.mul( invDistance ).mul( invDistance ).mul( invDistance ).div( d.mul( d ) ).toConst();
		prefiltered.addAssign( envMap.sample( texelDirection ).level( sourceLod ).rgb.mul( weight ) );
		totalWeight.addAssign( weight );

	} );
	return vec4( prefiltered.div( totalWeight ), 1.0 );

} )();

// three's public mapping of a PMREM's level to its roughness, which @types/three does not declare
type LodToRoughness = { lodToRoughness( lod: number, maxLod: number ): number };

function cubeTarget( size: number, generateMipmaps: boolean ): THREE.CubeRenderTarget {

	return new THREE.CubeRenderTarget( size, {
		minFilter: THREE.LinearMipmapLinearFilter,
		generateMipmaps,
		type: THREE.HalfFloatType,
		colorSpace: THREE.LinearSRGBColorSpace,
		depthBuffer: false,
	} );

}

function filterMaterial( name: string, fragmentNode: THREE.Node ): THREE.NodeMaterial {

	const material = new THREE.NodeMaterial();
	material.name = `PMREM_${ name }`;
	material.fragmentNode = fragmentNode;
	material.side = THREE.BackSide;
	material.blending = THREE.NoBlending;
	material.depthTest = false;
	material.depthWrite = false;
	return material;

}

/** Prefilters an equirect environment into PMREMs, whole or one cube at a time. */
export class EnvironmentPrefilter {

	private readonly renderer: THREE.WebGPURenderer;
	private readonly box = new THREE.Mesh( new THREE.BoxGeometry( 5, 5, 5 ) );
	private readonly camera = new THREE.CubeCamera( 1, 10, null as unknown as THREE.CubeCamera[ 'renderTarget' ] );
	private size = MIN_SIZE;
	private source: THREE.CubeRenderTarget | null = null;

	private readonly equirectMap = texture();
	private readonly equirect: THREE.NodeMaterial;
	private readonly ggxMap = cubeTexture();
	private readonly ggxRoughness = uniform( 0 );
	private readonly ggxLodBias = uniform( 0 );
	private readonly ggx: THREE.NodeMaterial;
	private readonly integrationMap = cubeTexture();
	private readonly integrationRoughness = uniform( 0 );
	private readonly integrationLod = uniform( 0 );
	private readonly integration: THREE.NodeMaterial;

	constructor( renderer: THREE.WebGPURenderer ) {

		this.renderer = renderer;
		const map = this.equirectMap;
		// four subpixel samples a texel, so small, bright features keep their energy
		this.equirect = filterMaterial( 'equirect', Fn( () => {

			const direction = positionWorldDirection;
			const dx = direction.dFdx().mul( 0.25 ).toConst();
			const dy = direction.dFdy().mul( 0.25 ).toConst();
			const color = map.sample( equirectUV( direction.sub( dx ).sub( dy ).normalize() ) ).level( float( 0 ) ).rgb
				.add( map.sample( equirectUV( direction.add( dx ).sub( dy ).normalize() ) ).level( float( 0 ) ).rgb )
				.add( map.sample( equirectUV( direction.sub( dx ).add( dy ).normalize() ) ).level( float( 0 ) ).rgb )
				.add( map.sample( equirectUV( direction.add( dx ).add( dy ).normalize() ) ).level( float( 0 ) ).rgb );
			return vec4( color.mul( 0.25 ), 1.0 );

		} )() );
		this.ggx = filterMaterial( 'ggx', ggxConvolution( this.ggxRoughness, this.ggxLodBias, this.ggxMap ) );
		// the source size a uniform, so the loops are not unrolled
		this.integration = filterMaterial( 'integration', ggxIntegration( this.integrationRoughness, this.integrationLod, uniform( INTEGRATION_SIZE, 'int' ), this.integrationMap ) );

	}

	/** Compiles the equirect's draw into the source cube it draws into, ahead of the first bake of
	 * `source`. */
	compile( source: THREE.Texture ): Promise<void> {

		this.box.material = this.equirect;
		return compileInto( this.renderer, this.box, this.camera.children[ 0 ] as THREE.Camera, this.sourceCube( source ) );

	}

	/** A PMREM for `source`'s size: a face a quarter of its width, a power of two of at least 256. */
	allocate( source: THREE.Texture ): THREE.CubeRenderTarget {

		const size = this.faceSize( source );
		const target = cubeTarget( size, false );
		for ( let lod = 0; lod <= Math.log2( size ) - LOD_MIN; lod ++ ) ( target.texture.mipmaps as { width: number; height: number }[] ).push( { width: size >> lod, height: size >> lod } );
		target.texture.name = 'PMREM';
		( target.texture as THREE.Texture & { isPMREMTexture: boolean } ).isPMREMTexture = true;
		return target;

	}

	/** `source` (an equirect) drawn into the source cube, with its mip chain, which every level is
	 * filtered from. */
	convert( source: THREE.Texture ): void {

		this.equirectMap.value = source;
		this.draw( this.sourceCube( source ), 0, this.equirect );

	}

	/** The level count of `target`, a PMREM this prefilter allocated. */
	levels( target: THREE.CubeRenderTarget ): number {

		return target.texture.mipmaps.length;

	}

	/** Level `level` of `target` filtered from the source cube (six render passes). */
	filter( target: THREE.CubeRenderTarget, level: number ): void {

		const source = this.source!.texture, maxLod = this.levels( target ) - 1;
		const roughness = ( THREE.PMREMGenerator as unknown as LodToRoughness ).lodToRoughness( level, maxLod );
		if ( level > maxLod - INTEGRATION_LEVELS ) {

			this.integrationMap.value = source;
			this.integrationLod.value = Math.log2( this.size / INTEGRATION_SIZE );
			this.integrationRoughness.value = roughness;
			this.draw( target, level, this.integration );

		} else {

			// With V = N, pdf( L ) = D( H ) / 4: a source texel's solid angle matched to
			// 1 / ( GGX_SAMPLES * pdf ), half a level sharper against the sampling noise; the
			// shader adds log2 of GGX's denominator.
			this.ggxMap.value = source;
			this.ggxRoughness.value = roughness;
			this.ggxLodBias.value = roughness > 0 ? Math.log2( this.size ) + 0.5 * Math.log2( 6 / ( GGX_SAMPLES * Math.pow( roughness, 4 ) ) ) + 0.5 : 0;
			this.draw( target, level, this.ggx );

		}

	}

	/** The whole prefilter: `source` into `target` (allocated if null), every level. */
	run( source: THREE.Texture, target: THREE.CubeRenderTarget | null ): THREE.CubeRenderTarget {

		const pmrem = target ?? this.allocate( source );
		this.convert( source );
		for ( let level = 0; level < this.levels( pmrem ); level ++ ) this.filter( pmrem, level );
		return pmrem;

	}

	dispose(): void {

		this.source?.dispose();
		this.box.geometry.dispose();
		this.equirect.dispose();
		this.ggx.dispose();
		this.integration.dispose();

	}

	// the source cube for `source`'s size, made again when the size changes
	private sourceCube( source: THREE.Texture ): THREE.CubeRenderTarget {

		this.size = this.faceSize( source );
		if ( ! this.source || this.source.width !== this.size ) {

			this.source?.dispose();
			this.source = cubeTarget( this.size, true );

		}
		return this.source;

	}

	private faceSize( source: THREE.Texture ): number {

		return Math.max( MIN_SIZE, THREE.MathUtils.floorPowerOfTwo( ( source.image as { width: number } ).width / 4 ) );

	}

	// the box drawn with `material` into the six faces of `target`'s level `lod`
	private draw( target: THREE.CubeRenderTarget, lod: number, material: THREE.NodeMaterial ): void {

		this.box.material = material;
		this.camera.renderTarget = target as unknown as THREE.CubeCamera[ 'renderTarget' ];
		this.camera.activeMipmapLevel = lod;
		this.camera.update( this.renderer, this.box );

	}

}
