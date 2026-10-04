import * as THREE from 'three/webgpu';
import { Fn, float, floor as floorNode, uint, vec2, vec3, vec4, screenCoordinate, select, texture, uniform, uniformArray, uv } from 'three/tsl';
import { waterColumnRadiance, waterShadowedColumnRadiance } from './WaterTransport.ts';
import { solarVolumeVisibility, volumeShadowRayMayIntersect } from '../lighting/SolarShadow.ts';
import { RefractedSun, refractedSunDirection, refractedSurfaceEntryNode } from '../lighting/RefractedSun.ts';
import type { OceanFFT } from './OceanFFT.ts';

type F = THREE.Node<'float'>;
type V4 = THREE.Node<'vec4'>;
type RGB = [ number, number, number ];

// This module is dynamically imported only by the dev runner. It exercises the actual
// TSL helpers with float readback, independent of the island's art direction and camera.
export async function verifyWaterVolume( renderer: THREE.WebGPURenderer ) {

	const pixels = 128, source: RGB = [ 0.3, 0.5, 0.7 ], attenuation: RGB = [ 0.12, 0.18, 0.24 ];
	const output = new THREE.RenderTarget( pixels, 1, { type: THREE.FloatType, depthBuffer: false } );
	const materials: THREE.NodeMaterial[] = [];
	const sun = new THREE.Vector3( Math.cos( Math.PI / 3 ), Math.sin( Math.PI / 3 ), 0 );
	const sunNode = uniform( sun ), waterSun = refractedSunDirection( sun ), slope = waterSun.x / waterSun.y;
	const refracted = new RefractedSun( renderer, { waterLevel: uniform( 0 ), sunDir: sunNode }, { mapSize: 1024 } );
	const placeholder = new THREE.NodeMaterial();
	placeholder.userData.refractedSolarReceiver = true;
	const floor = new THREE.Mesh( new THREE.PlaneGeometry( 20, 20 ).rotateX( - Math.PI / 2 ), placeholder );
	floor.position.y = - 8;
	floor.userData.refractedSolarFloor = true;
	const wetBox = new THREE.Mesh( new THREE.BoxGeometry( 2, 1, 2 ), placeholder );
	wetBox.position.set( 2, - 2, 0 );
	const group = new THREE.Group();
	group.add( floor, wetBox );
	group.updateMatrixWorld( true );
	refracted.setCasters( group );

	// A real depth attachment contains a known step: the left half blocks z=0.5,
	// the right half transmits it. Refracted entry points must cross that step at depth.
	const mapSize = 64, mapExtent = 8;
	const depth = new THREE.DepthTexture( mapSize, mapSize, THREE.FloatType );
	depth.compareFunction = THREE.LessEqualCompare;
	const airTarget = new THREE.RenderTarget( mapSize, mapSize, { depthTexture: depth } );
	const fieldMaterial = new THREE.NodeMaterial();
	fieldMaterial.depthTest = fieldMaterial.depthWrite = true;
	fieldMaterial.toneMapped = false;
	fieldMaterial.blending = THREE.NoBlending;
	fieldMaterial.fragmentNode = vec4( 0, 0, 0, 1 );
	fieldMaterial.depthNode = select( uv().x.lessThan( 0.5 ), float( 0.25 ), float( 0.75 ) );
	materials.push( fieldMaterial );
	const animation = renderer.getAnimationLoop();
	await renderer.setAnimationLoop( null );
	const state = THREE.RendererUtils.resetRendererState( renderer, {} as THREE.RendererUtils.RendererState );
	const renderReady = async ( material: THREE.NodeMaterial ) => {

		const quad = new THREE.QuadMesh( material );
		const before = quad.onBeforeRender, originalVertex = material.vertexNode;
		let fullscreenVertex = originalVertex;
		quad.onBeforeRender = ( ...args ) => {

			fullscreenVertex = material.vertexNode;
			before.apply( quad, args );

		};
		try {

			// QuadMesh installs its vertex node during draw. Compile that exact cache key
			// before readback; otherwise an asynchronous first pipeline can skip the draw.
			quad.render( renderer );
			material.vertexNode = fullscreenVertex;
			await renderer.compileAsync( quad, quad.camera );
			material.vertexNode = originalVertex;
			quad.render( renderer );

		} finally { quad.onBeforeRender = before; material.vertexNode = originalVertex; }

	};
	const render = async ( fragment: V4 ) => {

		const material = new THREE.NodeMaterial();
		materials.push( material );
		material.depthTest = material.depthWrite = false;
		material.toneMapped = false;
		material.blending = THREE.NoBlending;
		material.fragmentNode = fragment;
		renderer.setRenderTarget( output );
		await renderReady( material );
		return await renderer.readRenderTargetPixelsAsync( output, 0, 0, pixels, 1 ) as Float32Array;

	};
	const pathAcross = ( extent: number ) => screenCoordinate.x.sub( 0.5 ).div( pixels - 1 ).mul( extent );
	const integral = ( channel: number, start: number, end: number ) =>
		source[ channel ] * ( Math.exp( - attenuation[ channel ] * start ) - Math.exp( - attenuation[ channel ] * end ) ) / attenuation[ channel ];
	const rgb = ( data: Float32Array, pixel = 0 ) => Array.from( data.slice( pixel * 4, pixel * 4 + 3 ) ) as RGB;
	const allFinite = ( data: Float32Array ) => data.every( Number.isFinite );
	try {

		renderer.setScissorTest( false );
		const lit = await render( Fn( () => vec4( waterShadowedColumnRadiance( vec3( ...source ), vec3( ...attenuation ),
			pathAcross( 200 ), () => float( 1 ) ), 1 ) )() );
		const analytic = await render( Fn( () => vec4( waterColumnRadiance( vec3( ...source ), vec3( ...attenuation ), pathAcross( 200 ) ), 1 ) )() );
		const blocked = await render( Fn( () => vec4( waterShadowedColumnRadiance( vec3( ...source ), vec3( ...attenuation ),
			pathAcross( 200 ), () => float( 0 ) ), 1 ) )() );
		let maximumLitError = 0, maximumAnalyticDifference = 0, maximumBlockedRadiance = 0;
		for ( let x = 0; x < pixels; x ++ ) for ( let c = 0; c < 3; c ++ ) {

			const index = x * 4 + c, expected = integral( c, 0, x / ( pixels - 1 ) * 200 );
			maximumLitError = Math.max( maximumLitError, Math.abs( lit[ index ] - expected ) );
			maximumAnalyticDifference = Math.max( maximumAnalyticDifference, Math.abs( lit[ index ] - analytic[ index ] ) );
			maximumBlockedRadiance = Math.max( maximumBlockedRadiance, Math.abs( blocked[ index ] ) );

		}
		let maximumStepError = 0;
		const steps = [];
		for ( const shadowAtStart of [ true, false ] ) {

			const path = 12;
			const data = await render( Fn( () => {

				const edge = pathAcross( path ).toVar();
				return vec4( waterShadowedColumnRadiance( vec3( ...source ), vec3( ...attenuation ), float( path ), ( distance ) =>
					select( shadowAtStart ? distance.greaterThanEqual( edge ) : distance.lessThan( edge ), float( 1 ), float( 0 ) ) ), 1 );

			} )() );
			let maximumNormalizedError = 0;
			for ( let x = 0; x < pixels; x ++ ) for ( let c = 0; c < 3; c ++ ) {

				const edge = x / ( pixels - 1 ) * path;
				const expected = shadowAtStart ? integral( c, edge, path ) : integral( c, 0, edge );
				maximumNormalizedError = Math.max( maximumNormalizedError, Math.abs( data[ x * 4 + c ] - expected ) / integral( c, 0, path ) );

			}
			maximumStepError = Math.max( maximumStepError, maximumNormalizedError );
			steps.push( { shadowAtStart, maximumNormalizedError, finite: allFinite( data ) } );

		}

		// An asymmetric two-axis field catches gather-tap rotation, Y flips and incorrect
		// edge addressing; the CPU reference compares each clamped texel before bilinear mixing.
		fieldMaterial.depthNode = Fn( () => {

			const pixel = floorNode( screenCoordinate.xy );
			return pixel.x.mul( 3 ).add( pixel.y.mul( 5 ) ).mod( 11 ).mul( 0.08 ).add( 0.1 );

		} )();
		fieldMaterial.needsUpdate = true;
		renderer.setRenderTarget( airTarget );
		await renderReady( fieldMaterial );
		const borderCoordinates: RGB[] = [
			[ 0, 0, 0.33 ], [ 1, 0, 0.57 ], [ 0, 1, 0.81 ], [ 1, 1, 0.33 ],
			[ 0, 0.375, 0.57 ], [ 1, 0.625, 0.81 ], [ 0.375, 0, 0.33 ], [ 0.625, 1, 0.57 ],
			[ 0.25 / mapSize, 0.375, 0.81 ], [ 1 - 0.25 / mapSize, 0.625, 0.33 ],
			[ 0.375, 0.25 / mapSize, 0.57 ], [ 0.625, 1 - 0.25 / mapSize, 0.81 ],
			[ - 0.25 / mapSize, 0.375, 0.33 ], [ 1 + 0.25 / mapSize, 0.625, 0.57 ],
			[ 0.375, - 0.25 / mapSize, 0.81 ], [ 0.625, 1 + 0.25 / mapSize, 0.33 ],
			[ 0.375, 0.625, - 0.01 ], [ 0.625, 0.375, 1.01 ],
			[ 0.375, 0.625, 0 ], [ 0.625, 0.375, 1 ],
		];
		const samplerCoordinates = Array.from( { length: pixels - borderCoordinates.length }, ( _, i ): RGB => [
			( ( i * 13 ) % 63 + 0.5 + [ 0.125, 0.375, 0.625, 0.875 ][ i % 4 ] ) / mapSize,
			( ( i * 29 + 7 ) % 63 + 0.5 + [ 0.25, 0.75 ][ Math.floor( i / 4 ) % 2 ] ) / mapSize,
			[ 0.33, 0.57, 0.81 ][ i % 3 ],
		] ).concat( borderCoordinates );
		const samplerInputs = uniformArray<'vec3'>( samplerCoordinates.map( value => new THREE.Vector3( ...value ) ), 'vec3' );
		const samplerData = await render( Fn( () => vec4( vec3( solarVolumeVisibility( depth,
			samplerInputs.element( uint( screenCoordinate.x ) ), vec2( mapSize ) ) ), 1 ) )() );
		const cpuVisibility = ( [ u, v, z ]: RGB ) => {

			if ( u < 0 || u > 1 || v < 0 || v > 1 || z < 0 || z > 1 ) return 1;
			const tx = u * mapSize - 0.5, ty = v * mapSize - 0.5;
			const bx = Math.floor( tx ), by = Math.floor( ty ), wx = tx - bx, wy = ty - by;
			const compare = ( x: number, y: number ) => {

				const px = Math.min( mapSize - 1, Math.max( 0, x ) ), py = Math.min( mapSize - 1, Math.max( 0, y ) );
				return z <= ( ( px * 3 + py * 5 ) % 11 ) * 0.08 + 0.1 ? 1 : 0;

			};
			return ( compare( bx, by ) * ( 1 - wx ) + compare( bx + 1, by ) * wx ) * ( 1 - wy )
				+ ( compare( bx, by + 1 ) * ( 1 - wx ) + compare( bx + 1, by + 1 ) * wx ) * wy;

		};
		let maximumSamplerError = 0, fractionalSamplerResults = 0;
		const samplerFailures: { coordinate: RGB; expected: number; actual: number }[] = [];
		for ( let i = 0; i < samplerCoordinates.length; i ++ ) {

			const expected = cpuVisibility( samplerCoordinates[ i ] ), actual = samplerData[ i * 4 ];
			maximumSamplerError = Math.max( maximumSamplerError, Math.abs( actual - expected ) );
			if ( expected > 0 && expected < 1 ) fractionalSamplerResults ++;
			if ( Math.abs( actual - expected ) > 1e-6 ) samplerFailures.push( { coordinate: samplerCoordinates[ i ], expected, actual } );

		}
		const sampler = { samples: samplerCoordinates.length, borderSamples: borderCoordinates.length, maximumAbsoluteError: maximumSamplerError,
			fractionalResults: fractionalSamplerResults, failures: samplerFailures, finite: allFinite( samplerData ) };
		const rayFixtures: { name: string; start: RGB; end: RGB; expected: boolean }[] = [
			{ name: 'outside endpoints cross x', start: [ - 1, 0.5, 0.5 ], end: [ 2, 0.5, 0.5 ], expected: true },
			{ name: 'outside endpoints cross y', start: [ 0.5, - 1, 0.5 ], end: [ 0.5, 2, 0.5 ], expected: true },
			{ name: 'outside endpoints cross z', start: [ 0.5, 0.5, - 1 ], end: [ 0.5, 0.5, 2 ], expected: true },
			{ name: 'outside diagonal crosses', start: [ - 1, - 1, - 1 ], end: [ 2, 2, 2 ], expected: true },
			{ name: 'face contact remains conservative', start: [ - 1, 1, 0.5 ], end: [ 2, 1, 0.5 ], expected: true },
			{ name: 'entirely inside', start: [ 0.2, 0.3, 0.4 ], end: [ 0.8, 0.7, 0.6 ], expected: true },
			{ name: 'disjoint left', start: [ - 2, 0.2, 0.2 ], end: [ - 0.1, 0.8, 0.8 ], expected: false },
			{ name: 'disjoint right', start: [ 1.1, 0, 0 ], end: [ 2, 1, 1 ], expected: false },
			{ name: 'disjoint below', start: [ 0.2, - 2, 0.2 ], end: [ 0.8, - 0.1, 0.8 ], expected: false },
			{ name: 'disjoint beyond depth', start: [ 0.2, 0.2, 1.1 ], end: [ 0.8, 0.8, 2 ], expected: false },
		];
		const rayStarts = uniformArray<'vec3'>( rayFixtures.map( value => new THREE.Vector3( ...value.start ) ), 'vec3' );
		const rayEnds = uniformArray<'vec3'>( rayFixtures.map( value => new THREE.Vector3( ...value.end ) ), 'vec3' );
		const rayData = await render( Fn( () => {

			const index = uint( screenCoordinate.x ).mod( rayFixtures.length );
			return vec4( vec3( select( volumeShadowRayMayIntersect( rayStarts.element( index ), rayEnds.element( index ) ), float( 1 ), float( 0 ) ) ), 1 );

		} )() );
		const rays = rayFixtures.map( ( fixture, i ) => ( { ...fixture, actual: rayData[ i * 4 ], passed: rayData[ i * 4 ] === Number( fixture.expected ) } ) );

		// Restore the vertical step used by the independent depth-varying air fixtures.
		fieldMaterial.depthNode = select( uv().x.lessThan( 0.5 ), float( 0.25 ), float( 0.75 ) );
		fieldMaterial.needsUpdate = true;
		renderer.setRenderTarget( airTarget );
		await renderReady( fieldMaterial );
		const airVisibility = ( startX: number, directionX: number, directionY: number, distance: F ) => {

			const point = vec3( distance.mul( directionX ).add( startX ), distance.mul( directionY ), 0 );
			const entry = refractedSurfaceEntryNode( point, sunNode, float( 0 ) );
			return solarVolumeVisibility( depth, vec3( entry.x.div( mapExtent ).add( 0.5 ), 0.5, 0.5 ), vec2( mapSize ) );

		};
		const airFixtures = [];
		for ( const fixture of [
			{ name: 'shadowed surface with lit deeper water', startX: - 1, directionX: 0, directionY: - 1, shadowAtStart: true },
			{ name: 'lit surface with shadowed deeper water', startX: 0.75, directionX: - 0.6, directionY: - 0.8, shadowAtStart: false },
		] ) {

			const path = 6, derivative = fixture.directionX - fixture.directionY * slope;
			const edge = - fixture.startX / derivative;
			const visibilityAt = ( distance: F ) => airVisibility( fixture.startX, fixture.directionX, fixture.directionY, distance );
			const visibility = await render( Fn( () => vec4( vec3( visibilityAt( pathAcross( path ) ) ), 1 ) )() );
			const radiance = rgb( await render( Fn( () => vec4( waterShadowedColumnRadiance( vec3( ...source ), vec3( ...attenuation ), float( path ), visibilityAt ), 1 ) )() ) );
			let mismatchedInteriorPixels = 0;
			for ( let x = 0; x < pixels; x ++ ) {

				const entryX = fixture.startX + derivative * x / ( pixels - 1 ) * path;
				if ( Math.abs( entryX ) < mapExtent / mapSize ) continue;
				if ( Math.abs( visibility[ x * 4 ] - ( entryX > 0 ? 1 : 0 ) ) > 1e-5 ) mismatchedInteriorPixels ++;

			}
			const expected = attenuation.map( ( _, c ) => fixture.shadowAtStart ? integral( c, edge, path ) : integral( c, 0, edge ) ) as RGB;
			const normalizedError = radiance.map( ( value, c ) => Math.abs( value - expected[ c ] ) / integral( c, 0, path ) );
			const surfaceMaskDifference = radiance.map( ( value, c ) => Math.abs( value - ( fixture.shadowAtStart ? 0 : integral( c, 0, path ) ) ) / integral( c, 0, path ) );
			airFixtures.push( { name: fixture.name, transitionDistance: edge, surfaceVisibility: visibility[ 0 ], bottomVisibility: visibility[ ( pixels - 1 ) * 4 ],
				mismatchedInteriorPixels, radiance, expected, normalizedError, surfaceMaskDifference, finite: allFinite( visibility ) && radiance.every( Number.isFinite ) } );

		}

		await refracted.prepare();
		const wetPath = 6, wetStart = 1.5 + 1 / slope;
		const wetVisibilityAt = ( distance: F ) => refracted.submergedVolumeVisibilityNode( vec3( 0, distance.negate(), 0 ) );
		const wetVisibility = await render( Fn( () => vec4( vec3( wetVisibilityAt( pathAcross( wetPath ) ) ), 1 ) )() );
		const wetRadiance = rgb( await render( Fn( () => vec4( waterShadowedColumnRadiance( vec3( ...source ), vec3( ...attenuation ), float( wetPath ), wetVisibilityAt ), 1 ) )() ) );
		let wetMismatchedInteriorPixels = 0;
		for ( let x = 0; x < pixels; x ++ ) {

			const distance = x / ( pixels - 1 ) * wetPath;
			// Exclude only the map footprint and the deliberate 2cm contact clearance.
			if ( Math.abs( distance - wetStart ) < 0.08 ) continue;
			if ( Math.abs( wetVisibility[ x * 4 ] - ( distance < wetStart ? 1 : 0 ) ) > 1e-5 ) wetMismatchedInteriorPixels ++;

		}
		const wetExpected = attenuation.map( ( _, c ) => integral( c, 0, wetStart ) ) as RGB;
		const wetError = wetRadiance.map( ( value, c ) => Math.abs( value - wetExpected[ c ] ) / integral( c, 0, wetPath ) );
		const wetSurfaceDifference = wetRadiance.map( ( value, c ) => ( integral( c, 0, wetPath ) - value ) / integral( c, 0, wetPath ) );
		const submerged = { transitionDistance: wetStart, surfaceVisibility: wetVisibility[ 0 ], bottomVisibility: wetVisibility[ ( pixels - 1 ) * 4 ],
			mismatchedInteriorPixels: wetMismatchedInteriorPixels, radiance: wetRadiance, expected: wetExpected, normalizedError: wetError,
			surfaceMaskDifference: wetSurfaceDifference, finite: allFinite( wetVisibility ) && wetRadiance.every( Number.isFinite ) };
		const tolerance = 0.10;
		const passed = allFinite( lit ) && allFinite( analytic ) && allFinite( blocked ) && maximumLitError < 2e-6 && maximumAnalyticDifference < 2e-6
			&& maximumBlockedRadiance < 1e-7 && maximumStepError <= tolerance && steps.every( sample => sample.finite )
			&& sampler.finite && sampler.maximumAbsoluteError <= 1e-6 && sampler.fractionalResults > 20 && rays.every( fixture => fixture.passed )
			&& airFixtures.every( fixture => fixture.finite && fixture.mismatchedInteriorPixels === 0 && fixture.normalizedError.every( value => value <= tolerance )
				&& fixture.surfaceMaskDifference.every( value => value > 0.1 ) && Math.abs( fixture.surfaceVisibility - fixture.bottomVisibility ) > 0.999 )
			&& submerged.finite && submerged.mismatchedInteriorPixels === 0 && submerged.normalizedError.every( value => value <= tolerance )
			&& submerged.surfaceMaskDifference.every( value => value > 0.1 ) && submerged.surfaceVisibility > 0.999 && submerged.bottomVisibility < 0.001;
		return { passed, pixels, samples: 8, source, attenuation, normalizedErrorTolerance: tolerance,
			fullyLit: { maximumAbsoluteError: maximumLitError, maximumAnalyticHelperDifference: maximumAnalyticDifference, pathRange: [ 0, 200 ] },
			fullyBlocked: { maximumRadiance: maximumBlockedRadiance }, steps, sampler, rays, airFixtures, submerged,
			limitations: 'Eight exponential strata approximate visibility discontinuities; analytic reference is single scattering with a flat mean interface.' };

	} finally {

		THREE.RendererUtils.restoreRendererState( renderer, state );
		output.dispose();
		airTarget.dispose();
		refracted.dispose();
		for ( const material of materials ) material.dispose();
		placeholder.dispose();
		floor.geometry.dispose();
		wetBox.geometry.dispose();
		await renderer.setAnimationLoop( animation );

	}

}

// Packing must preserve the live, persistent foam field, including interpolation and
// periodic seams. A stressed spectrum ensures zero default foam cannot make this pass.
export async function verifyWhitecapPacking( renderer: THREE.WebGPURenderer, fft: OceanFFT ) {

	if ( fft.velocityTextures.length !== 3 ) throw new Error( 'Whitecap packing probe expects three ocean cascades' );
	const size = 128, frames = 12, step = 0.1;
	const target = new THREE.RenderTarget( size, size, { type: THREE.FloatType, depthBuffer: false } );
	const materials: THREE.NodeMaterial[] = [];
	const originalAmplitude = fft.params.amplitude, originalChoppiness = fft.params.choppiness;
	// The phase is internal because ordinary clients advance it through update(). Restore
	// it after this isolated fixture so the next scene frame cannot inherit its test clock.
	const originalPhase = ( fft as unknown as { time: { value: number } } ).time.value;
	const fixture = { amplitude: Math.max( originalAmplitude * 12, 12 ), choppiness: Math.max( originalChoppiness * 12, 8 ) };
	const animation = renderer.getAnimationLoop();
	await renderer.setAnimationLoop( null );
	const state = THREE.RendererUtils.resetRendererState( renderer, {} as THREE.RendererUtils.RendererState );
	const render = async ( difference: boolean ) => {

		const material = new THREE.NodeMaterial();
		materials.push( material );
		material.depthTest = material.depthWrite = false;
		material.toneMapped = false;
		material.blending = THREE.NoBlending;
		material.fragmentNode = Fn( () => {

			// Different cascade UVs match Water.ts. The field covers negative coordinates,
			// repeat boundaries and fractional texels; both inputs use the same linear LOD 0.
			const world = uv().sub( 0.5 ).mul( 160 ).add( vec2( 0.137, - 0.291 ) );
			const coordinates = fft.sizes.map( scale => world.div( scale ) );
			const packed = vec3( texture( fft.whitecapTexture, coordinates[ 0 ] ).level( float( 0 ) ).r,
				texture( fft.whitecapTexture, coordinates[ 1 ] ).level( float( 0 ) ).g,
				texture( fft.whitecapTexture, coordinates[ 2 ] ).level( float( 0 ) ).b );
			const channels = fft.velocityTextures.map( ( input, c ) => texture( input, coordinates[ c ] ).level( float( 0 ) ).a );
			const original = vec3( channels[ 0 ], channels[ 1 ], channels[ 2 ] );
			return vec4( difference ? packed.sub( original ) : original, 1 );

		} )();
		const quad = new THREE.QuadMesh( material );
		const before = quad.onBeforeRender, originalVertex = material.vertexNode;
		let fullscreenVertex = originalVertex;
		quad.onBeforeRender = ( ...args ) => {

			fullscreenVertex = material.vertexNode;
			before.apply( quad, args );

		};
		try {

			renderer.setRenderTarget( target );
			quad.render( renderer );
			material.vertexNode = fullscreenVertex;
			await renderer.compileAsync( quad, quad.camera );
			material.vertexNode = originalVertex;
			quad.render( renderer );
			return await renderer.readRenderTargetPixelsAsync( target, 0, 0, size, size ) as Float32Array;

		} finally { quad.onBeforeRender = before; material.vertexNode = originalVertex; }

	};
	try {

		renderer.setScissorTest( false );
		fft.params.amplitude = fixture.amplitude;
		fft.params.choppiness = fixture.choppiness;
		fft.rebuildSpectrum();
		// The first frame resets history; following frames have dt <= 0.25 and accumulate it.
		for ( let i = 0; i < frames; i ++ ) fft.update( step, 20 + i * step );
		const differences = await render( true ), sources = await render( false );
		const cascades = fft.velocityTextures.map( ( _, c ) => {

			let maximumAbsoluteDifference = 0, minimumSource = Infinity, maximumSource = - Infinity, nonzeroSamples = 0;
			for ( let i = 0; i < size * size; i ++ ) {

				const at = i * 4 + c, source = sources[ at ];
				maximumAbsoluteDifference = Math.max( maximumAbsoluteDifference, Math.abs( differences[ at ] ) );
				minimumSource = Math.min( minimumSource, source );
				maximumSource = Math.max( maximumSource, source );
				if ( source > 1e-4 ) nonzeroSamples ++;

			}
			return { cascade: c, maximumAbsoluteDifference, minimumSource, maximumSource, nonzeroSamples };

		} );
		const tolerance = 1e-7;
		const passed = differences.every( Number.isFinite ) && sources.every( Number.isFinite ) && cascades.every( sample =>
			sample.maximumAbsoluteDifference <= tolerance && sample.maximumSource > 0.01 && sample.nonzeroSamples > 100
			&& sample.maximumSource - sample.minimumSource > 0.01 && sample.minimumSource >= - tolerance && sample.maximumSource <= 1 + tolerance );
		return { passed, samplesPerCascade: size * size, frames, step, fixture, tolerance, cascades,
			filter: 'matching linear LOD 0 at per-cascade UVs, including negative coordinates and repeat seams',
			restore: 'original spectrum parameters and phase; temporary whitecap history is reset' };

	} finally {

		try {

			fft.params.amplitude = originalAmplitude;
			fft.params.choppiness = originalChoppiness;
			fft.rebuildSpectrum();
			fft.update( 0, originalPhase );

		} finally {

			THREE.RendererUtils.restoreRendererState( renderer, state );
			target.dispose();
			for ( const material of materials ) material.dispose();
			await renderer.setAnimationLoop( animation );

		}

	}

}
