import * as THREE from 'three/webgpu';
import { Fn, Loop, float, vec3, vec4, screenCoordinate, exp, log, min, max, clamp, select } from 'three/tsl';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

// The solar beam contains no direct source when its entry point is shadowed. For a
// volume, visibility belongs to each scattering point's light path, not the view entry.
export const waterIncidentSun = Fn( ( [ sunE, visibility, transmittance, beamScale ]: [ V3, F, F, F ] ) => {

	return sunE.mul( clamp( visibility, 0, 1 ) ).mul( clamp( transmittance, 0, 1 ) ).mul( max( beamScale, 0 ) );

} ).setLayout( { name: 'waterIncidentSun', type: 'vec3', inputs: [
	{ name: 'sunE', type: 'vec3' }, { name: 'visibility', type: 'float' },
	{ name: 'transmittance', type: 'float' }, { name: 'beamScale', type: 'float' },
] } );

// Homogeneous analytic column integral, for strictly positive attenuation (1 / m).
// Source radiance per metre * integral (m) gives outgoing radiance. The caller
// constructs the source with the appropriate angular factor for sun E or sky E / PI.
// This integrates a supplied source; the existing multiple-scatter source is empirical.
export const waterColumnRadiance = Fn( ( [ sourcePerLength, attenuation, pathLength ]: [ V3, V3, F ] ) => {

	return sourcePerLength.mul( float( 1 ).sub( exp( attenuation.negate().mul( pathLength ) ) ) ).div( attenuation );

} ).setLayout( { name: 'waterColumnRadiance', type: 'vec3', inputs: [
	{ name: 'sourcePerLength', type: 'vec3' },
	{ name: 'attenuation', type: 'vec3' }, { name: 'pathLength', type: 'float' },
] } );

// Inverse CDF of a truncated exponential. Preserve the exact far endpoint even when
// exp(-rate * length) rounds to zero, and avoid cancellation for a nearly empty column.
const waterColumnDistance = Fn( ( [ fraction, rate, coverage, pathLength ]: [ F, F, F, F ] ) => {

	const distance = log( max( float( 1 ).sub( fraction.mul( coverage ) ), 1e-7 ) ).negate().div( rate );
	return select( fraction.greaterThanEqual( 1 ), pathLength,
		select( rate.mul( pathLength ).lessThan( 1e-3 ), fraction.mul( pathLength ), distance ) );

} ).setLayout( { name: 'waterColumnDistance', type: 'float', inputs: [
	{ name: 'fraction', type: 'float' }, { name: 'rate', type: 'float' },
	{ name: 'coverage', type: 'float' }, { name: 'pathLength', type: 'float' },
] } );

// Integrate the direct solar source along the refracted view ray. Exponential strata
// spend the fixed shadow budget where light survives; even a deep horizon ray samples
// its near water. Exact RGB interval weights retain the fully lit analytic solution.
// Volume transport: PBRT, Light Transport II / Volumetric Light Transport (equations only).
// The visibility factory may capture textures, so keep this node material-local.
export function waterShadowedColumnRadiance( sourcePerLength: V3, attenuation: V3, pathLength: F,
	visibilityAt: ( distance: F ) => F, samples = 8 ): V3 {

	return Fn( () => {

		const path = max( pathLength, 0 ).toVar();
		const rate = max( min( attenuation.x, min( attenuation.y, attenuation.z ) ), 1e-5 ).toVar();
		const coverage = float( 1 ).sub( exp( rate.negate().mul( path ) ) ).toVar();
		const previous = vec3( 1 ).toVar();
		const integral = vec3( 0 ).toVar();
		Loop( samples, ( { i } ) => {

			const index = float( i );
			const middle = waterColumnDistance( index.add( 0.5 ).div( samples ), rate, coverage, path );
			const end = waterColumnDistance( index.add( 1 ).div( samples ), rate, coverage, path );
			const transmittance = exp( attenuation.negate().mul( end ) ).toVar();
			const visibility = clamp( visibilityAt( middle ), 0, 1 );
			integral.addAssign( previous.sub( transmittance ).mul( visibility ) );
			previous.assign( transmittance );

		} );
		return sourcePerLength.mul( integral ).div( attenuation );

	} )();

}

type RGB = [ number, number, number ];
type ProbeInputs = { sigA: RGB; sigS: RGB; backscatter: number };

// The runner dynamically imports this isolated probe. Water imports only the helpers,
// so the probe and its temporary float targets can be tree-shaken from production.
export async function verifyWaterEnergy( renderer: THREE.WebGPURenderer, inputs: ProbeInputs ) {

	if ( ! [ ...inputs.sigA, ...inputs.sigS, inputs.backscatter ].every( x => Number.isFinite( x ) && x >= 0 ) ||
		inputs.sigA.some( ( x, c ) => x + inputs.sigS[ c ] <= 0 ) ) throw new Error( 'Water energy probe requires physical, positive extinction coefficients' );
	const size = 64;
	const target = new THREE.RenderTarget( size, size, { type: THREE.FloatType, depthBuffer: false } );
	const animation = renderer.getAnimationLoop();
	await renderer.setAnimationLoop( null );
	const state = THREE.RendererUtils.resetRendererState( renderer, {} as THREE.RendererUtils.RendererState );
	const materials: THREE.NodeMaterial[] = [];
	const render = async ( fragment: V4 ) => {

		const material = new THREE.NodeMaterial();
		materials.push( material );
		material.depthTest = material.depthWrite = false;
		material.toneMapped = false;
		material.blending = THREE.NoBlending;
		material.fragmentNode = fragment;
		renderer.setRenderTarget( target );
		const quad = new THREE.QuadMesh( material );
		const before = quad.onBeforeRender, originalVertex = material.vertexNode;
		let fullscreenVertex = originalVertex;
		quad.onBeforeRender = ( ...args ) => {

			fullscreenVertex = material.vertexNode;
			before.apply( quad, args );

		};
		try {

			// QuadMesh temporarily installs a fullscreen vertex node. Compile the same
			// cache key before the measured draw; a fresh async pipeline may skip its first draw.
			quad.render( renderer );
			material.vertexNode = fullscreenVertex;
			await renderer.compileAsync( quad, quad.camera );
			material.vertexNode = originalVertex;
			quad.render( renderer );
			return await renderer.readRenderTargetPixelsAsync( target, 0, 0, size, size ) as Float32Array;

		} finally {

			quad.onBeforeRender = before;
			material.vertexNode = originalVertex;

		}

	};
	try {

		renderer.setScissorTest( false );
		// Use the scene's actual coefficients and MS setting, with positive normalized
		// fixtures so a nighttime scene cannot turn this blackout check into a zero-light test.
		const sunE: RGB = [ 1, 0.8, 0.6 ], skyEOverPI: RGB = [ 0.3, 0.4, 0.5 ];
		const transmission = 0.98, beamScale = 0.7, phase = 0.5, muV = 0.6, muS = 0.8;
		const sigT = inputs.sigA.map( ( a, c ) => a + inputs.sigS[ c ] ) as RGB;
		const ms = inputs.sigS.map( ( s, c ) => {

			const bb = s * inputs.backscatter;
			return bb * 1.32 / ( inputs.sigA[ c ] + bb );

		} ) as RGB;
		let maximumSolarBlackout = 0, maximumSkyShadowDifference = 0, maximumColumnError = 0, minimumShadowedSky = Infinity;
		for ( const source of [ 'sun', 'sky' ] ) {

			const pixels = await render( Fn( () => {

				const path = screenCoordinate.x.sub( 0.5 ).div( size - 1 ).mul( 12 );
				const visibility = select( screenCoordinate.y.lessThan( size / 2 ), float( 0 ), float( 1 ) );
				const extinction = vec3( ...sigT ), scattering = vec3( ...inputs.sigS ), empiricalMS = vec3( ...ms );
				const incident = source === 'sun' ? waterIncidentSun( vec3( ...sunE ), visibility, float( transmission ), float( beamScale ) ) : vec3( ...skyEOverPI );
				const coefficient = source === 'sun' ? scattering.mul( phase ).add( empiricalMS.mul( extinction ).div( Math.PI ) ) :
					scattering.mul( 0.25 ).add( empiricalMS.mul( extinction ) );
				const attenuation = extinction.mul( source === 'sun' ? muV / muS + 1 : muV / 0.75 + 1 );
				return vec4( waterColumnRadiance( incident.mul( coefficient ), attenuation, path ), 1 );

			} )() );
			for ( let y = 0; y < size; y ++ ) {

				for ( let x = 0; x < size; x ++ ) {

					const visibility = y < size / 2 ? 0 : 1, path = x / ( size - 1 ) * 12;
					for ( let c = 0; c < 3; c ++ ) {

						const actual = pixels[ ( y * size + x ) * 4 + c ];
						const k = sigT[ c ] * ( source === 'sun' ? muV / muS + 1 : muV / 0.75 + 1 );
						const coefficient = source === 'sun' ? inputs.sigS[ c ] * phase + ms[ c ] * sigT[ c ] / Math.PI : inputs.sigS[ c ] * 0.25 + ms[ c ] * sigT[ c ];
						const incident = source === 'sun' ? sunE[ c ] * visibility * transmission * beamScale : skyEOverPI[ c ];
						const expected = incident * coefficient * - Math.expm1( - k * path ) / k;
						maximumColumnError = Math.max( maximumColumnError, Math.abs( actual - expected ) );
						if ( visibility === 0 && source === 'sun' ) maximumSolarBlackout = Math.max( maximumSolarBlackout, Math.abs( actual ) );
						if ( visibility === 0 && source === 'sky' ) {

							const sunlit = pixels[ ( ( y + size / 2 ) * size + x ) * 4 + c ];
							maximumSkyShadowDifference = Math.max( maximumSkyShadowDifference, Math.abs( actual - sunlit ) );
							if ( x > 0 ) minimumShadowedSky = Math.min( minimumShadowedSky, actual );

						}

					}

				}

			}

		}
		const report = { maximumSolarBlackout, maximumSkyShadowDifference, minimumShadowedSky, maximumColumnError,
			coefficients: inputs, empiricalMultipleScatteringRetained: true };
		if ( ! [ maximumSolarBlackout, maximumSkyShadowDifference, minimumShadowedSky, maximumColumnError ].every( Number.isFinite ) ||
			maximumSolarBlackout > 1e-7 || maximumSkyShadowDifference > 1e-7 || minimumShadowedSky <= 0 || maximumColumnError > 2e-6 ) {

			throw new Error( `Water energy GPU probe failed: ${ JSON.stringify( report ) }` );

		}
		return report;

	} finally {

		THREE.RendererUtils.restoreRendererState( renderer, state );
		target.dispose();
		for ( const material of materials ) material.dispose();
		await renderer.setAnimationLoop( animation );

	}

}
