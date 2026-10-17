import * as THREE from 'three/webgpu';
import {
	Fn, float, int, vec2, vec3, vec4, texture, screenCoordinate, sin, cos, max, abs, clamp, sqrt, exp, dot, length, normalize, cross, select,
} from 'three/tsl';
import { SUN_ANGULAR_RADIUS } from '../lighting/Radiometry.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

// LEAN moments (Olano and Baker, I3D 2010): filter the mean and second moment with the
// same mip/anisotropic kernel. Their difference is the variance of unresolved waves, not
// a wind-speed fit. Spectral bands are independent, so their weighted covariances add.
// https://userpages.cs.umbc.edu/olano/papers/lean/ (technique only; no source code reused).
export const waveSlopeCovariance = Fn( ( [ mean, second ]: [ V2, V3 ] ) => {

	const xx = max( second.x.sub( mean.x.mul( mean.x ) ), 0 ).toVar();
	const zz = max( second.y.sub( mean.y.mul( mean.y ) ), 0 ).toVar();
	// Half-float rounding can put the 2x2 covariance just outside the PSD cone.
	const bound = sqrt( xx.mul( zz ) );
	return vec3( xx, zz, clamp( second.z.sub( mean.x.mul( mean.y ) ), bound.negate(), bound ) );

} ).setLayout( { name: 'waveSlopeCovariance', type: 'vec3', inputs: [
	{ name: 'mean', type: 'vec2' }, { name: 'second', type: 'vec3' },
] } );

// A camera-distance LOD attenuates the resolved mean, not the physical spectrum.
// Keep M2: unresolved covariance is M2 - (weight * mean)(weight * mean)^T.
export const waveLodCovariance = Fn( ( [ mean, second, weight ]: [ V2, V3, F ] ) => {

	return waveSlopeCovariance( mean.mul( clamp( weight, 0, 1 ) ), second );

} ).setLayout( { name: 'waveLodCovariance', type: 'vec3', inputs: [
	{ name: 'mean', type: 'vec2' }, { name: 'second', type: 'vec3' }, { name: 'weight', type: 'float' },
] } );

// The reflection derivative is 2[(V dot deltaN)N + (N dot V)deltaN]. Its
// average angular variance across the two reflected tangent axes depends on view and
// anisotropy; using 2 * trace(C) would overblur the low-variance axis at grazing angles.
export const waveReflectionAngularVariance = Fn( ( [ view, covariance ]: [ V3, V3 ] ) => {

	const projected = covariance.x.mul( view.x.mul( view.x ) ).add( covariance.y.mul( view.z.mul( view.z ) ) )
		.add( covariance.z.mul( view.x ).mul( view.z ).mul( 2 ) );
	return max( view.y.mul( view.y ).mul( covariance.x.add( covariance.y ) ).add( projected ).mul( 2 ), 0 );

} ).setLayout( { name: 'waveReflectionAngularVariance', type: 'float', inputs: [
	{ name: 'view', type: 'vec3' }, { name: 'covariance', type: 'vec3' },
] } );

// Backfacing facets have no outward air-side interface radiance. This is a consistent
// self-occlusion approximation; transport from neighboring waves is not reconstructed.
export const waveAirFacing = Fn( ( [ normal, view ]: [ V3, V3 ] ) => {

	return select( dot( normal, view ).greaterThan( 0 ), float( 1 ), float( 0 ) );

} ).setLayout( { name: 'waveAirFacing', type: 'float', inputs: [
	{ name: 'normal', type: 'vec3' }, { name: 'view', type: 'vec3' },
] } );

// Convert screen derivatives to derivatives with respect to the undisplaced surface xz.
// This includes gradients of the shore damping and the finest cascade's geometry fade.
export const waveParameterGradient = Fn( ( [ dx, dy, valueDx, valueDy ]: [ V2, V2, F, F ] ) => {

	const det = dx.x.mul( dy.y ).sub( dx.y.mul( dy.x ) ).toVar();
	const valid = abs( det ).greaterThan( 1e-10 );
	const denominator = select( valid, det, float( 1 ) );
	return select( valid, vec2( valueDx.mul( dy.y ).sub( valueDy.mul( dx.y ) ),
		valueDy.mul( dx.x ).sub( valueDx.mul( dy.x ) ) ).div( denominator ), vec2( 0 ) );

} ).setLayout( { name: 'waveParameterGradient', type: 'vec2', inputs: [
	{ name: 'dx', type: 'vec2' }, { name: 'dy', type: 'vec2' },
	{ name: 'valueDx', type: 'float' }, { name: 'valueDy', type: 'float' },
] } );

// horizontal = ( dX/dx, dX/dz, dZ/dx, dZ/dz ), including identity and weight gradients.
// The signed cross derivatives matter: dividing each height slope by its own diagonal
// alone cannot describe the displaced surface. This normal never depends on view direction.
export const waveSurfaceNormal = Fn( ( [ heightGradient, horizontal ]: [ V2, V4 ] ) => {

	const x = vec3( horizontal.x, heightGradient.x, horizontal.z );
	const z = vec3( horizontal.y, heightGradient.y, horizontal.w );
	const n = cross( z, x ).toVar();
	return n.div( max( length( n ), 1e-8 ) );

} ).setLayout( { name: 'waveSurfaceNormal', type: 'vec3', inputs: [
	{ name: 'heightGradient', type: 'vec2' }, { name: 'horizontal', type: 'vec4' },
] } );

const waveTangent = Fn( ( [ normal ]: [ V3 ] ) => {

	const t = vec3( normal.y, normal.x.negate(), 0 );
	return normalize( select( dot( t, t ).greaterThan( 1e-10 ), t, vec3( 1, 0, 0 ) ) );

} ).setLayout( { name: 'waveTangent', type: 'vec3', inputs: [ { name: 'normal', type: 'vec3' } ] } );

const covarianceBilinear = Fn( ( [ covariance, a, b ]: [ V3, V2, V2 ] ) => {

	return covariance.x.mul( a.x ).mul( b.x ).add( covariance.y.mul( a.y ).mul( b.y ) )
		.add( covariance.z.mul( a.x.mul( b.y ).add( a.y.mul( b.x ) ) ) );

} ).setLayout( { name: 'waveCovarianceBilinear', type: 'float', inputs: [
	{ name: 'covariance', type: 'vec3' }, { name: 'a', type: 'vec2' }, { name: 'b', type: 'vec2' },
] } );

// Locally affine choppy-wave approximation: transform height-gradient covariance through
// the complete horizontal Jacobian and into the resolved normal's tangent frame. The same
// Jacobian generates the normal. We do not model covariance of the Jacobian itself.
// N.y / det(J) equals 1 / length(cross(tangentZ,tangentX)); using that identity avoids a
// singular inverse near a crest while preserving the signed geometry normal.
export const waveCovarianceToTangent = Fn( ( [ covariance, heightGradient, horizontal ]: [ V3, V2, V4 ] ) => {

	const x = vec3( horizontal.x, heightGradient.x, horizontal.z );
	const z = vec3( horizontal.y, heightGradient.y, horizontal.w );
	const n0 = cross( z, x ).toVar(), area = max( length( n0 ), 1e-8 ).toVar();
	const n = n0.div( area ).toVar(), t = waveTangent( n ).toVar(), b = cross( t, n ).toVar();
	const row = ( direction: V3 ) => vec2( direction.x.mul( horizontal.w ).sub( direction.z.mul( horizontal.y ) ),
		direction.z.mul( horizontal.x ).sub( direction.x.mul( horizontal.z ) ) ).div( area );
	const rt = row( t ).toVar(), rb = row( b ).toVar();
	return vec3( max( covarianceBilinear( covariance, rt, rt ), 0 ),
		max( covarianceBilinear( covariance, rb, rb ), 0 ), covarianceBilinear( covariance, rt, rb ) );

} ).setLayout( { name: 'waveCovarianceToTangent', type: 'vec3', inputs: [
	{ name: 'covariance', type: 'vec3' }, { name: 'heightGradient', type: 'vec2' }, { name: 'horizontal', type: 'vec4' },
] } );

export const waveLocalDirection = Fn( ( [ direction, normal ]: [ V3, V3 ] ) => {

	const t = waveTangent( normal ).toVar(), b = cross( t, normal );
	return vec3( dot( direction, t ), dot( direction, normal ), dot( direction, b ) );

} ).setLayout( { name: 'waveLocalDirection', type: 'vec3', inputs: [
	{ name: 'direction', type: 'vec3' }, { name: 'normal', type: 'vec3' },
] } );

const positiveCovariance = Fn( ( [ covariance ]: [ V3 ] ) => {

	const xx = max( covariance.x, 1e-8 ).toVar(), zz = max( covariance.y, 1e-8 ).toVar();
	const bound = sqrt( xx.mul( zz ) ).mul( 0.99999 );
	return vec3( xx, zz, clamp( covariance.z, bound.negate(), bound ) );

} ).setLayout( { name: 'wavePositiveCovariance', type: 'vec3', inputs: [ { name: 'covariance', type: 'vec3' } ] } );

// A Gaussian sea-slope distribution has finite covariance. Beckmann therefore follows
// directly from the measured moments; GGX's infinite second moment cannot equal them.
// Include the cos(theta)^-4 Jacobian, as noted in the LEAN paper's normalization erratum.
export const waveBeckmannD = Fn( ( [ halfVector, covariance ]: [ V3, V3 ] ) => {

	const c = positiveCovariance( covariance ).toVar();
	const det = max( c.x.mul( c.y ).sub( c.z.mul( c.z ) ), 1e-20 ).toVar();
	const ny = max( halfVector.y, 1e-5 ).toVar(), slope = halfVector.xz.div( ny ).toVar();
	const q = c.y.mul( slope.x.mul( slope.x ) ).add( c.x.mul( slope.y.mul( slope.y ) ) )
		.sub( c.z.mul( slope.x ).mul( slope.y ).mul( 2 ) ).div( det );
	const density = exp( q.mul( - 0.5 ) ).div( sqrt( det ).mul( 2 * Math.PI ).mul( ny.mul( ny ).mul( ny ).mul( ny ) ) );
	return select( halfVector.y.greaterThan( 0 ), density, float( 0 ) );

} ).setLayout( { name: 'waveBeckmannD', type: 'float', inputs: [
	{ name: 'halfVector', type: 'vec3' }, { name: 'covariance', type: 'vec3' },
] } );

// Smith's Gaussian masking function, generalized by stretch invariance (Heitz, JCGT 2014).
// https://jcgt.org/published/0003/02/03/ (equations only; no source code reused).
// erfc uses the Abramowitz-Stegun 7.1.26 polynomial, evaluated in its stable exp(-a*a) form.
const waveBeckmannLambda = Fn( ( [ direction, covariance ]: [ V3, V3 ] ) => {

	const c = positiveCovariance( covariance );
	const variance = max( c.x.mul( direction.x.mul( direction.x ) ).add( c.y.mul( direction.z.mul( direction.z ) ) )
		.add( c.z.mul( direction.x ).mul( direction.z ).mul( 2 ) ), 1e-12 );
	const a = clamp( abs( direction.y ).div( sqrt( variance.mul( 2 ) ) ), 1e-5, 12 ).toVar();
	const t = float( 1 ).div( a.mul( 0.3275911 ).add( 1 ) ).toVar();
	const polynomial = float( 1.061405429 ).mul( t ).sub( 1.453152027 ).mul( t ).add( 1.421413741 )
		.mul( t ).sub( 0.284496736 ).mul( t ).add( 0.254829592 ).mul( t );
	return max( exp( a.mul( a ).negate() ).mul( float( 1 ).div( a.mul( Math.sqrt( Math.PI ) ) ).sub( polynomial ) ).mul( 0.5 ), 0 );

} ).setLayout( { name: 'waveBeckmannLambda', type: 'float', inputs: [
	{ name: 'direction', type: 'vec3' }, { name: 'covariance', type: 'vec3' },
] } );

export const waveSmithVisibility = Fn( ( [ light, view, covariance ]: [ V3, V3, V3 ] ) => {

	const masking = float( 1 ).div( waveBeckmannLambda( light, covariance ).add( waveBeckmannLambda( view, covariance ) ).add( 1 ) );
	const visibility = masking.div( max( light.y.mul( view.y ).mul( 4 ), 1e-8 ) );
	return select( light.y.greaterThan( 0 ).and( view.y.greaterThan( 0 ) ), visibility, float( 0 ) );

} ).setLayout( { name: 'waveSmithVisibility', type: 'float', inputs: [
	{ name: 'light', type: 'vec3' }, { name: 'view', type: 'vec3' }, { name: 'covariance', type: 'vec3' },
] } );

// Approximate the uniform solar disk with a normalized Gaussian of the same angular
// covariance (radius^2 / 4). Propagate it through normalize(V+L) and half-vector slopes;
// at normal incidence its contribution to the normal-slope covariance is radius^2 / 16.
// Only the direct sun's NDF is broadened: the physical sea covariance still controls Smith.
export const waveSolarSlopeCovariance = Fn( ( [ light, view ]: [ V3, V3 ] ) => {

	const sum = light.add( view ).toVar(), h = normalize( sum ).toVar();
	const hy = max( h.y, 0.01 ).toVar(), denominator = hy.mul( max( length( sum ), 1e-5 ) );
	const rx = vec3( 1, h.x.div( hy ).negate(), 0 ).div( denominator ).toVar();
	const rz = vec3( 0, h.z.div( hy ).negate(), 1 ).div( denominator ).toVar();
	const projected = ( a: V3, b: V3 ) => dot( a, b ).sub( dot( a, light ).mul( dot( b, light ) ) );
	const variance = SUN_ANGULAR_RADIUS * SUN_ANGULAR_RADIUS / 4;
	return vec3( max( projected( rx, rx ), 0 ), max( projected( rz, rz ), 0 ), projected( rx, rz ) ).mul( variance );

} ).setLayout( { name: 'waveSolarSlopeCovariance', type: 'vec3', inputs: [
	{ name: 'light', type: 'vec3' }, { name: 'view', type: 'vec3' },
] } );

// Dev-only isolated GPU verification. Import dynamically from the verification runner;
// the application does not import this function, so production can tree-shake the probe.
export async function verifyWaveOptics( renderer: THREE.WebGPURenderer, fft: {
	cascades: number; displacement: THREE.Texture; derivatives: THREE.Texture; slopeMoments: THREE.Texture;
} ) {

	const size = 256;
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
		new THREE.QuadMesh( material ).render( renderer );
		return await renderer.readRenderTargetPixelsAsync( target, 0, 0, size, size ) as Float32Array;

	};
	const reports: { cascade: number; mip: number; trace: number; maximumTrace: number; minimumDeterminant: number; meanEnergy: number }[] = [];
	let maximumNormalResidual = 0, maximumJacobianError = 0, crossMinimum = Infinity, crossMaximum = - Infinity;
	try {

		renderer.setScissorTest( false );
		const layer = ( field: THREE.Texture, c: number, q: THREE.Node<'vec2'> ) => texture( field, q ).depth( int( c ) );
		for ( let c = 0; c < fft.cascades; c ++ ) {

			for ( const mip of [ 0, 2, 4, 8 ] ) {

				const pixels = await render( Fn( () => {

					const q = screenCoordinate.xy.div( size );
					const mean = layer( fft.derivatives, c, q ).level( float( mip ) ).xy.toVar();
					const moments = layer( fft.slopeMoments, c, q ).level( float( mip ) ).xyz.toVar();
					const covariance = waveSlopeCovariance( mean, moments ).toVar();
					return vec4( covariance.x, covariance.y, covariance.z, dot( mean, mean ) );

				} )() );
				let trace = 0, meanEnergy = 0, maximumTrace = 0, minimumDeterminant = Infinity;
				for ( let i = 0; i < size * size; i ++ ) {

					const xx = pixels[ i * 4 ], zz = pixels[ i * 4 + 1 ], xz = pixels[ i * 4 + 2 ], energy = pixels[ i * 4 + 3 ];
					if ( ! [ xx, zz, xz, energy ].every( Number.isFinite ) || xx < 0 || zz < 0 || energy < 0 ) throw new Error( 'Wave moment probe contains invalid values' );
					trace += ( xx + zz ) / ( size * size );
					meanEnergy += energy / ( size * size );
					maximumTrace = Math.max( maximumTrace, xx + zz );
					minimumDeterminant = Math.min( minimumDeterminant, xx * zz - xz * xz );

				}
				reports.push( { cascade: c, mip, trace, maximumTrace, minimumDeterminant, meanEnergy } );
				if ( minimumDeterminant < - 1e-9 ) throw new Error( `Wave covariance is not positive semidefinite: ${ JSON.stringify( reports.at( - 1 ) ) }` );

			}
			const base = reports.at( - 4 )!, global = reports.at( - 1 )!;
			if ( base.trace > base.meanEnergy * 0.002 + 1e-8 ) throw new Error( `Mip-zero unresolved variance exceeds half-float roundoff: ${ JSON.stringify( base ) }` );
			if ( Math.abs( global.trace - base.meanEnergy ) > base.meanEnergy * 0.006 + 1e-7 ) throw new Error( `Wave slope energy was lost by mip filtering: ${ JSON.stringify( { base, global } ) }` );
			const normals = await render( Fn( () => {

				const q = screenCoordinate.xy.div( size );
				const d = layer( fft.derivatives, c, q ).level( float( 0 ) ).toVar();
				const crossDerivative = layer( fft.slopeMoments, c, q ).level( float( 0 ) ).w.toVar();
				const j = vec4( d.z.add( 1 ), crossDerivative, crossDerivative, d.w.add( 1 ) ).toVar();
				const normal = waveSurfaceNormal( d.xy, j ).toVar();
				const jacobian = j.x.mul( j.w ).sub( j.y.mul( j.z ) );
				const stored = layer( fft.displacement, c, q ).level( float( 0 ) ).w;
				return vec4( dot( normal, vec3( j.x, d.x, j.z ) ), dot( normal, vec3( j.y, d.y, j.w ) ),
					jacobian.sub( stored ), crossDerivative );

			} )() );
			for ( let i = 0; i < size * size; i ++ ) {

				maximumNormalResidual = Math.max( maximumNormalResidual, Math.abs( normals[ i * 4 ] ), Math.abs( normals[ i * 4 + 1 ] ) );
				maximumJacobianError = Math.max( maximumJacobianError, Math.abs( normals[ i * 4 + 2 ] ) );
				crossMinimum = Math.min( crossMinimum, normals[ i * 4 + 3 ] );
				crossMaximum = Math.max( crossMaximum, normals[ i * 4 + 3 ] );

			}

		}
		if ( maximumNormalResidual > 1e-5 || maximumJacobianError > 0.01 || ! ( crossMinimum < 0 && crossMaximum > 0 ) ) {

			throw new Error( `Wave full-J differential mismatch: ${ JSON.stringify( { maximumNormalResidual, maximumJacobianError, crossMinimum, crossMaximum } ) }` );

		}
		const covariance = [ 0.0025, 0.0064, 0.0012 ];
		const sx = Math.sqrt( covariance[ 0 ] ), sz = Math.sqrt( covariance[ 1 ] );
		const distribution = await render( Fn( () => {

			const slopes = screenCoordinate.xy.div( size ).mul( 10 ).sub( 5 ).mul( vec2( sx, sz ) ).toVar();
			const h = normalize( vec3( slopes.x, 1, slopes.y ) ).toVar();
			const c = vec3( ...covariance );
			const l = normalize( vec3( 0.3, 0.9, 0.2 ) ).toVar(), v = normalize( vec3( 0.1, 0.7, 0.5 ) ).toVar();
			const density = waveBeckmannD( h, c ).mul( h.y.mul( h.y ).mul( h.y ).mul( h.y ) );
			const height = vec2( 0.4, - 0.2 ), j = vec4( 1.2, 0.1, 0.1, 0.8 );
			const n = waveSurfaceNormal( height, j ).toVar();
			const orthogonal = max( abs( dot( n, vec3( 1.2, 0.4, 0.1 ) ) ), abs( dot( n, vec3( 0.1, - 0.2, 0.8 ) ) ) );
			return vec4( density, waveSmithVisibility( l, v, c ).mul( l.y.mul( v.y ).mul( 4 ) ), length( n ).sub( 1 ), orthogonal );

		} )() );
		let mass = 0, xx = 0, zz = 0, xz = 0, maximumFixtureError = 0, maskingMinimum = 1, maskingMaximum = 0;
		const area = 100 * sx * sz / ( size * size );
		for ( let i = 0; i < size * size; i ++ ) {

			const density = distribution[ i * 4 ], masking = distribution[ i * 4 + 1 ];
			if ( ! Number.isFinite( density ) || density < 0 || ! Number.isFinite( masking ) || masking < 0 || masking > 1.00001 ) throw new Error( 'Wave Beckmann probe contains an invalid density or masking value' );
			const x = ( ( i % size + 0.5 ) / size * 10 - 5 ) * sx;
			const z = ( ( Math.floor( i / size ) + 0.5 ) / size * 10 - 5 ) * sz;
			mass += density * area; xx += x * x * density * area; zz += z * z * density * area; xz += x * z * density * area;
			maximumFixtureError = Math.max( maximumFixtureError, Math.abs( distribution[ i * 4 + 2 ] ), Math.abs( distribution[ i * 4 + 3 ] ) );
			maskingMinimum = Math.min( maskingMinimum, masking ); maskingMaximum = Math.max( maskingMaximum, masking );

		}
		const measured = [ xx, zz, xz ];
		if ( Math.abs( mass - 1 ) > 0.001 || measured.some( ( value, i ) => Math.abs( value - covariance[ i ] ) > Math.abs( covariance[ i ] ) * 0.001 ) || maximumFixtureError > 1e-5 ) {

			throw new Error( `Wave Beckmann normalization or covariance mismatch: ${ JSON.stringify( { mass, measured, covariance, maximumFixtureError } ) }` );

		}
		// Perfect-reflector white furnace: integrate the actual GPU BRDF over the incoming
		// hemisphere. Smith single scattering may lose energy, but must not create it.
		const furnace: { viewDegrees: number; reflectedEnergy: number; maximumReciprocityError: number }[] = [];
		for ( const viewDegrees of [ 0, 60, 80 ] ) {

			const angle = viewDegrees * Math.PI / 180;
			const pixels = await render( Fn( () => {

				const q = screenCoordinate.xy.div( size );
				const mu = q.x, phi = q.y.mul( 2 * Math.PI ), radial = sqrt( max( float( 1 ).sub( mu.mul( mu ) ), 0 ) );
				const l = vec3( radial.mul( cos( phi ) ), mu, radial.mul( sin( phi ) ) ).toVar();
				const v = vec3( Math.sin( angle ), Math.cos( angle ), 0 );
				const c = vec3( 0.02, 0.08, 0.02 );
				const h = normalize( l.add( v ) ).toVar(), d = waveBeckmannD( h, c ).toVar();
				const forward = d.mul( waveSmithVisibility( l, v, c ) ).toVar();
				const reverse = d.mul( waveSmithVisibility( v, l, c ) );
				return vec4( forward.mul( mu ), abs( forward.sub( reverse ) ), 0, 1 );

			} )() );
			let reflectedEnergy = 0, maximumReciprocityError = 0;
			for ( let i = 0; i < size * size; i ++ ) {

				const energy = pixels[ i * 4 ], reciprocity = pixels[ i * 4 + 1 ];
				if ( ! Number.isFinite( energy ) || energy < 0 || ! Number.isFinite( reciprocity ) ) throw new Error( 'Wave white furnace contains invalid BRDF values' );
				reflectedEnergy += energy * 2 * Math.PI / ( size * size );
				maximumReciprocityError = Math.max( maximumReciprocityError, reciprocity );

			}
			furnace.push( { viewDegrees, reflectedEnergy, maximumReciprocityError } );
			if ( reflectedEnergy > 1.01 || reflectedEnergy < 0.4 || maximumReciprocityError > 1e-5 ) {

				throw new Error( `Wave BRDF violates energy conservation or reciprocity: ${ JSON.stringify( furnace ) }` );

			}

		}
		const corrections = await verifyWaveCovarianceCorrections( renderer );
		return { corrections, reports, maximumNormalResidual, maximumJacobianError, crossMinimum, crossMaximum,
			beckmann: { mass, measured, covariance, maximumFixtureError, maskingMinimum, maskingMaximum }, furnace,
			additionalTargets: 1, momentBytesIncludingMips: fft.cascades * size * size * 8 * 4 / 3 };

	} finally {

		THREE.RendererUtils.restoreRendererState( renderer, state );
		target.dispose();
		for ( const material of materials ) material.dispose();
		await renderer.setAnimationLoop( animation );

	}

}

// Focused GPU fixture for LOD conservation, grazing anisotropy and the air-facing policy.
// It can run alone while the main FFT/NDF regression already has a passing result.
export async function verifyWaveCovarianceCorrections( renderer: THREE.WebGPURenderer ) {

	const size = 64, target = new THREE.RenderTarget( size, size, { type: THREE.FloatType, depthBuffer: false } );
	const material = new THREE.NodeMaterial();
	material.depthTest = material.depthWrite = false; material.toneMapped = false; material.blending = THREE.NoBlending;
	material.fragmentNode = Fn( () => {

		const q = screenCoordinate.xy.div( size );
		const weight = q.x, mean = vec2( 0.2, - 0.1 ), second = vec3( 0.08, 0.05, - 0.01 );
		const covariance = waveLodCovariance( mean, second, weight ).toVar();
		const resolved = mean.mul( weight ).toVar();
		const reconstructed = covariance.add( vec3( resolved.x.mul( resolved.x ), resolved.y.mul( resolved.y ), resolved.x.mul( resolved.y ) ) );
		const error = max( abs( reconstructed.x.sub( 0.08 ) ), max( abs( reconstructed.y.sub( 0.05 ) ), abs( reconstructed.z.add( 0.01 ) ) ) );
		const grazing = waveReflectionAngularVariance( vec3( 1, 0, 0 ), vec3( 0.0001, 0.01, 0 ) );
		const normal = waveReflectionAngularVariance( vec3( 0, 1, 0 ), vec3( 0.0001, 0.01, 0 ) );
		const view = select( q.y.lessThan( 0.5 ), vec3( 0, 1, 0 ), vec3( 0, - 1, 0 ) );
		return vec4( error, grazing, normal, waveAirFacing( vec3( 0, 1, 0 ), view ) );

	} )();
	const animation = renderer.getAnimationLoop(); await renderer.setAnimationLoop( null );
	const state = THREE.RendererUtils.resetRendererState( renderer, {} as THREE.RendererUtils.RendererState );
	try {

		renderer.setScissorTest( false ); renderer.setRenderTarget( target ); new THREE.QuadMesh( material ).render( renderer );
		const pixels = await renderer.readRenderTargetPixelsAsync( target, 0, 0, size, size ) as Float32Array;
		let maximumEnergyError = 0, maximumProjectionError = 0, maximumFacingError = 0;
		for ( let i = 0; i < size * size; i ++ ) {

			maximumEnergyError = Math.max( maximumEnergyError, Math.abs( pixels[ i * 4 ] ) );
			maximumProjectionError = Math.max( maximumProjectionError, Math.abs( pixels[ i * 4 + 1 ] - 0.0002 ), Math.abs( pixels[ i * 4 + 2 ] - 0.0202 ) );
			maximumFacingError = Math.max( maximumFacingError, Math.abs( pixels[ i * 4 + 3 ] - ( Math.floor( i / size ) < size / 2 ? 1 : 0 ) ) );

		}
		const report = { maximumEnergyError, maximumProjectionError, maximumFacingError, expectedGrazingVariance: 0.0002, expectedNormalVariance: 0.0202 };
		if ( ! Object.values( report ).every( Number.isFinite ) || maximumEnergyError > 1e-6 || maximumProjectionError > 1e-6 || maximumFacingError > 1e-6 ) throw new Error( `Wave covariance correction fixture failed: ${ JSON.stringify( report ) }` );
		return report;

	} finally {

		THREE.RendererUtils.restoreRendererState( renderer, state ); target.dispose(); material.dispose(); await renderer.setAnimationLoop( animation );

	}

}
