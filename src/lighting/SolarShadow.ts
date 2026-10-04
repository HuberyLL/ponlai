import * as THREE from 'three/webgpu';
import {
	Fn, Loop, texture, textureLoad, reference, screenCoordinate, float, vec2, vec3, vec4, ivec2, uv,
	max, abs, clamp, cos, sin, pow, tan, dot, select, dFdx, dFdy, floor, fract, mix,
} from 'three/tsl';
import { SUN_ANGULAR_RADIUS } from './Radiometry.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

const BLOCKER_SAMPLES = 6, FILTER_SAMPLES = 8;

// PCSS: Fernando, "Percentage-Closer Soft Shadows", SIGGRAPH 2005 sketches.
// For a directional disk the penumbra radius is blocker-receiver distance * tan(solar radius),
// rather than the perspective-light size ratio. No upstream source code is used here.
export const solarShadowDiskOffset = Fn( ( [ index, count, rotation, exponent ]: [ F, F, F, F ] ) => {

	const radius = pow( index.add( 0.5 ).div( count ), exponent );
	const angle = index.mul( 2.399963229728653 ).add( rotation );
	return vec2( cos( angle ), sin( angle ) ).mul( radius );

} ).setLayout( { name: 'solarShadowDiskOffset', type: 'vec2', inputs: [
	{ name: 'index', type: 'float' }, { name: 'count', type: 'float' },
	{ name: 'rotation', type: 'float' }, { name: 'exponent', type: 'float' },
] } );

export const solarPenumbraRadius = Fn( ( [ receiverDepth, blockerDepth, depthRange, angularRadius, worldSpan ]: [ F, F, F, F, V2 ] ) => {

	return max( receiverDepth.sub( blockerDepth ), 0 ).mul( depthRange )
		.mul( tan( max( angularRadius, 0 ) ) ).div( max( worldSpan, vec2( 1e-3 ) ) );

} ).setLayout( { name: 'solarPenumbraRadius', type: 'vec2', inputs: [
	{ name: 'receiverDepth', type: 'float' }, { name: 'blockerDepth', type: 'float' },
	{ name: 'depthRange', type: 'float' }, { name: 'angularRadius', type: 'float' },
	{ name: 'worldSpan', type: 'vec2' },
] } );

const receiverGradient = Fn( ( [ dx, dy ]: [ V3, V3 ] ) => {

	const determinant = dx.x.mul( dy.y ).sub( dx.y.mul( dy.x ) ).toVar();
	const valid = abs( determinant ).greaterThan( 1e-10 );
	const denominator = select( valid, determinant, float( 1 ) );
	const gradient = vec2( dx.z.mul( dy.y ).sub( dy.z.mul( dx.y ) ),
		dy.z.mul( dx.x ).sub( dx.z.mul( dy.x ) ) ).div( denominator );
	return select( valid, clamp( gradient, vec2( - 16 ), vec2( 16 ) ), vec2( 0 ) );

} ).setLayout( { name: 'solarShadowReceiverGradient', type: 'vec2', inputs: [
	{ name: 'dx', type: 'vec3' }, { name: 'dy', type: 'vec3' },
] } );

export interface SolarShadowParameters {
	mapSize: V2;
	worldSpan: V2;
	depthRange: F;
	angularRadius?: F;
	depthKind?: 'depth' | 'color';
}

// Texture access stays in a material-local node factory. A shared layout function must never
// close over a texture or uniform binding generated for a different material.
export function solarShadowVisibility( depth: THREE.Texture | THREE.TextureNode, coordinate: V3,
	{ mapSize, worldSpan, depthRange, angularRadius = float( SUN_ANGULAR_RADIUS ), depthKind = 'depth' }: SolarShadowParameters ): F {

	return Fn( () => {

		const sc = coordinate.toVar();
		// Derivatives and comparison samples all execute in uniform control flow. The depth slope
		// removes receiver-plane self-shadowing without moving the contact by a large fixed bias.
		const gradient = receiverGradient( dFdx( sc ), dFdy( sc ) ).toVar();
		const p = screenCoordinate.xy;
		const rotation = p.x.mul( 0.06711056 ).add( p.y.mul( 0.00583715 ) ).fract().mul( 52.9829189 ).fract().mul( 2 * Math.PI ).toVar();
		const size = max( mapSize, vec2( 1 ) ).toVar();
		const span = max( worldSpan, vec2( 1e-3 ) ).toVar();
		const loadDepth = ( pixel: THREE.Node<'ivec2'> ): F => {

			const loaded = textureLoad( depth, pixel );
			return depthKind === 'color' ? loaded.x : loaded as unknown as F;

		};
		const compareSample = ( q: V2, compareDepth: F ): F => {

			if ( depthKind === 'depth' ) return texture( depth, clamp( q, vec2( 0 ), vec2( 1 ) ) ).compare( compareDepth ) as unknown as F;
			// Float colour depth cannot use a comparison sampler. Compare four nearest depths
			// before bilinear interpolation, matching hardware PCF rather than blending depths.
			const texel = q.mul( size ).sub( 0.5 ).toVar(), base = floor( texel ).toVar();
			const weight = fract( texel ).toVar();
			const compare = ( x: number, y: number ) => select( compareDepth.lessThanEqual(
				loadDepth( ivec2( clamp( base.add( vec2( x, y ) ), vec2( 0 ), size.sub( 1 ) ) ) ) ), float( 1 ), float( 0 ) );
			return mix( mix( compare( 0, 0 ), compare( 1, 0 ), weight.x ),
				mix( compare( 0, 1 ), compare( 1, 1 ), weight.x ), weight.y );

		};
		// Three deduplicates texture uniforms by UUID and chooses the first access's sampler
		// type. Register this real centre comparison before raw blocker loads, so the shared
		// DepthTexture binding is a comparison sampler. It is also the first filter sample.
		const centre = compareSample( sc.xy, sc.z ).toVar();
		// This conservative search covers any caster between the receiver and the near plane.
		// Progressive radii retain samples close to a thin leaf or a sharp contact, as well as
		// finding more distant blockers. The first sample is the centre itself.
		const searchRadius = solarPenumbraRadius( max( sc.z, 0 ), float( 0 ), depthRange, angularRadius, span ).toVar();
		const blockerDepth = float( 0 ).toVar(), blockerCount = float( 0 ).toVar();
		Loop( BLOCKER_SAMPLES, ( { i } ) => {

			const index = float( i );
			const offset = select( index.equal( 0 ), vec2( 0 ),
				solarShadowDiskOffset( max( index.sub( 1 ), 0 ), float( BLOCKER_SAMPLES - 1 ), rotation, float( 2 ) ) ).mul( searchRadius ).toVar();
			const q = sc.xy.add( offset ).toVar();
			const inside = q.x.greaterThanEqual( 0 ).and( q.y.greaterThanEqual( 0 ) )
				.and( q.x.lessThanEqual( 1 ) ).and( q.y.lessThanEqual( 1 ) );
			const pixel = ivec2( clamp( q.mul( size ), vec2( 0 ), size.sub( 1 ) ) );
			const stored = loadDepth( pixel ).toVar();
			const corrected = stored.sub( dot( gradient, offset ) ).toVar();
			const blocker = select( inside.and( corrected.lessThan( sc.z ) ), float( 1 ), float( 0 ) ).toVar();
			blockerDepth.addAssign( corrected.mul( blocker ) );
			blockerCount.addAssign( blocker );

		} );
		const average = select( blockerCount.greaterThan( 0 ), blockerDepth.div( max( blockerCount, 1 ) ), sc.z );
		const radius = solarPenumbraRadius( sc.z, average, depthRange, angularRadius, span ).toVar();
		const visibility = centre.toVar();
		Loop( FILTER_SAMPLES - 1, ( { i } ) => {

			const offset = solarShadowDiskOffset( float( i ).add( 1 ), float( FILTER_SAMPLES ), rotation, float( 0.5 ) ).mul( radius ).toVar();
			const q = sc.xy.add( offset ).toVar();
			const inside = q.x.greaterThanEqual( 0 ).and( q.y.greaterThanEqual( 0 ) )
				.and( q.x.lessThanEqual( 1 ) ).and( q.y.lessThanEqual( 1 ) );
			const compareDepth = sc.z.add( dot( gradient, offset ) );
			const sample = compareSample( q, compareDepth );
			visibility.addAssign( select( inside, sample, float( 1 ) ) );

		} );
		const inside = sc.x.greaterThanEqual( 0 ).and( sc.y.greaterThanEqual( 0 ) )
			.and( sc.x.lessThanEqual( 1 ) ).and( sc.y.lessThanEqual( 1 ) )
			.and( sc.z.greaterThanEqual( 0 ) ).and( sc.z.lessThanEqual( 1 ) );
		return select( inside, visibility.div( FILTER_SAMPLES ), float( 1 ) );

	} )();

}

// Standard receivers and custom water share the same projection dimensions and angular source.
export function installSolarShadowFilter( sun: THREE.DirectionalLight ): void {

	const camera = sun.shadow.camera;
	const mapSize = reference( 'mapSize', 'vec2', sun.shadow );
	const worldSpan = vec2( reference( 'right', 'float', camera ).sub( reference( 'left', 'float', camera ) ),
		reference( 'top', 'float', camera ).sub( reference( 'bottom', 'float', camera ) ) );
	const depthRange = reference( 'far', 'float', camera ).sub( reference( 'near', 'float', camera ) );
	const filter = Fn( ( { depthTexture, shadowCoord }: { depthTexture: THREE.DepthTexture; shadowCoord: V3 } ) =>
		solarShadowVisibility( depthTexture, shadowCoord, { mapSize, worldSpan, depthRange } ) );
	// The runtime exposes filterNode; @types/three has not declared this WebGPU hook yet.
	( sun.shadow as unknown as { filterNode: typeof filter } ).filterNode = filter;

}

// Isolated dev-server regression probe. This export is unused by the app and tree-shaken from
// production: it renders a known depth discontinuity without island geometry or post effects.
export async function verifySolarShadow( renderer: THREE.WebGPURenderer ) {

	const width = 512, height = 64, span = 2, depthRange = 16;
	const depthTexture = new THREE.DepthTexture( width, width, THREE.FloatType );
	depthTexture.compareFunction = THREE.LessEqualCompare;
	depthTexture.minFilter = THREE.LinearFilter;
	depthTexture.magFilter = THREE.LinearFilter;
	const field = new THREE.RenderTarget( width, width, { type: THREE.FloatType, depthTexture, depthBuffer: true } );
	const output = new THREE.RenderTarget( width, height, { type: THREE.FloatType, depthBuffer: false } );
	const fieldMaterial = new THREE.NodeMaterial(), outputMaterial = new THREE.NodeMaterial();
	const fieldDepth = select( uv().x.lessThan( 0.5 ), float( 0.25 ), float( 0.95 ) );
	fieldMaterial.fragmentNode = vec4( fieldDepth, fieldDepth, fieldDepth, float( 1 ) );
	fieldMaterial.depthNode = fieldDepth;
	fieldMaterial.toneMapped = false;
	fieldMaterial.depthTest = false;
	fieldMaterial.depthWrite = true;
	fieldMaterial.blending = THREE.NoBlending;
	outputMaterial.depthTest = false;
	outputMaterial.depthWrite = false;
	outputMaterial.toneMapped = false;
	outputMaterial.blending = THREE.NoBlending;
	const sun = new THREE.DirectionalLight();
	sun.shadow.camera.left = - span / 2; sun.shadow.camera.right = span / 2;
	sun.shadow.camera.top = span / 2; sun.shadow.camera.bottom = - span / 2;
	sun.shadow.camera.near = 0; sun.shadow.camera.far = depthRange;
	sun.shadow.mapSize.set( width, width );
	installSolarShadowFilter( sun );
	const standardFilter = ( sun.shadow as unknown as { filterNode: ( input: { depthTexture: THREE.DepthTexture; shadowCoord: V3 } ) => F } ).filterNode;
	const parameters = { mapSize: vec2( width ), worldSpan: vec2( span ), depthRange: float( depthRange ) };
	outputMaterial.fragmentNode = Fn( () => {

		const q = uv();
		const far = vec3( q, 0.875 ), near = vec3( q, 0.250625 );
		const standard = standardFilter( { depthTexture, shadowCoord: far } );
		const color = solarShadowVisibility( field.texture, far, { ...parameters, depthKind: 'color' } );
		const contact = solarShadowVisibility( depthTexture, near, parameters );
		const hard = solarShadowVisibility( depthTexture, far, { ...parameters, angularRadius: float( 0 ) } );
		return vec4( standard, color, contact, hard );

	} )();
	const fieldQuad = new THREE.QuadMesh( fieldMaterial ), outputQuad = new THREE.QuadMesh( outputMaterial );
	const diagnosticTarget = new THREE.RenderTarget( 4, 1, { type: THREE.FloatType, depthBuffer: false } );
	const diagnosticMaterial = new THREE.NodeMaterial();
	diagnosticMaterial.depthTest = diagnosticMaterial.depthWrite = false;
	diagnosticMaterial.toneMapped = false;
	diagnosticMaterial.blending = THREE.NoBlending;
	diagnosticMaterial.fragmentNode = Fn( () => {

		const q = vec2( uv().x, 0.5 );
		const comparison = ( texture( depthTexture, q ).compare( float( 0.875 ) ) as unknown as F ).toVar();
		const rawDepth = textureLoad( depthTexture, ivec2( q.mul( width ) ) ) as unknown as F;
		const rawColor = texture( field.texture, q ).level( float( 0 ) ).x;
		return vec4( rawDepth, rawColor, comparison, 1 );

	} )();
	const diagnosticQuad = new THREE.QuadMesh( diagnosticMaterial );
	const animation = renderer.getAnimationLoop();
	await renderer.setAnimationLoop( null );
	const state = THREE.RendererUtils.resetRendererState( renderer, {} as THREE.RendererUtils.RendererState );
	// QuadMesh temporarily installs its own full-screen vertex node during render. Capture that
	// node for compileAsync so the precompiled cache key is identical to the subsequent draw.
	const renderReady = async ( quad: THREE.QuadMesh ) => {

		const material = quad.material as THREE.NodeMaterial;
		const before = quad.onBeforeRender, originalVertex = material.vertexNode;
		let fullscreenVertex = originalVertex;
		quad.onBeforeRender = ( ...args ) => {

			fullscreenVertex = material.vertexNode;
			before.apply( quad, args );

		};
		try {

			quad.render( renderer );
			material.vertexNode = fullscreenVertex;
			await renderer.compileAsync( quad, quad.camera );
			material.vertexNode = originalVertex;
			quad.render( renderer );

		} finally {

			quad.onBeforeRender = before;
			material.vertexNode = originalVertex;

		}

	};
	try {

		renderer.setScissorTest( false );
		renderer.autoClear = true;
		renderer.setRenderTarget( field );
		await renderReady( fieldQuad );
		renderer.setRenderTarget( diagnosticTarget );
		await renderReady( diagnosticQuad );
		renderer.setRenderTarget( output );
		await renderReady( outputQuad );
		const raw = await renderer.readRenderTargetPixelsAsync( diagnosticTarget, 0, 0, 4, 1 ) as Float32Array;
		const fieldChecks = Array.from( { length: 4 }, ( _, i ) => ( {
			uvX: ( i + 0.5 ) / 4, depth: raw[ i * 4 ], color: raw[ i * 4 + 1 ],
			comparison: raw[ i * 4 + 2 ], drawMarker: raw[ i * 4 + 3 ],
		} ) );
		const pixels = await renderer.readRenderTargetPixelsAsync( output, 0, 0, width, height ) as Float32Array;
		const profiles = Array.from( { length: 4 }, () => new Array<number>( width ).fill( 0 ) );
		let maximumDifference = 0;
		for ( let k = 0; k < width * height; k ++ ) {

			for ( let c = 0; c < 4; c ++ ) {

				const value = pixels[ k * 4 + c ];
				if ( ! Number.isFinite( value ) || value < 0 || value > 1.00001 ) throw new Error( 'Solar shadow probe returned an invalid visibility' );
				const row = Math.floor( k / width );
				if ( row >= height / 4 && row < height * 3 / 4 ) profiles[ c ][ k % width ] += value / ( height / 2 );

			}
			maximumDifference = Math.max( maximumDifference, Math.abs( pixels[ k * 4 ] - pixels[ k * 4 + 1 ] ) );

		}
		const widths = profiles.map( ( p ) => p.filter( ( v ) => v > 0.1 && v < 0.9 ).length );
		const profileChecks = profiles.map( ( p ) => ( {
			minimum: Math.min( ...p ), maximum: Math.max( ...p ), first: p[ 0 ], last: p[ width - 1 ],
			center: p.slice( width / 2 - 4, width / 2 + 4 ),
		} ) );
		const diagnostics = { widths, fieldChecks, profileChecks, maximumDifference };
		for ( let i = 0; i < 4; i ++ ) {

			const expectedDepth = i < 2 ? 0.25 : 0.95, expectedComparison = i < 2 ? 0 : 1;
			const check = fieldChecks[ i ];
			if ( Math.abs( check.depth - expectedDepth ) > 1e-4 || Math.abs( check.color - expectedDepth ) > 1e-4 ||
				Math.abs( check.comparison - expectedComparison ) > 1e-4 || check.drawMarker < 0.99999 ) {

				throw new Error( `Solar shadow test field was not rendered correctly: ${ JSON.stringify( diagnostics ) }` );

			}

		}
		if ( widths[ 0 ] < 4 || widths[ 2 ] > widths[ 0 ] * 0.5 || widths[ 3 ] > 2 ) throw new Error( `Solar contact-hardening failed: ${ JSON.stringify( diagnostics ) }` );
		if ( maximumDifference > 0.01 ) throw new Error( `Colour-depth and standard shadow samplers disagree by ${ maximumDifference }` );
		for ( const profile of profiles ) {

			// Samples outside the map are intentionally lit. Test interior regions beyond the
			// filter support, so the map border cannot contaminate the umbra assertion.
			if ( profile.slice( width / 4 - 50, width / 4 + 50 ).some( ( v ) => v > 1e-5 ) ||
				profile.slice( width * 3 / 4 - 50, width * 3 / 4 + 50 ).some( ( v ) => v < 0.99999 ) ) {

				throw new Error( `Solar shadow probe lost its interior umbra or lit region: ${ JSON.stringify( diagnostics ) }` );

			}

		}
		return { ...diagnostics, physicalFarDiameterMetres: 2 * 10 * Math.tan( SUN_ANGULAR_RADIUS ),
			farReceiverGapMetres: 10, contactReceiverGapMetres: 0.01, width, height, profiles };

	} finally {

		THREE.RendererUtils.restoreRendererState( renderer, state );
		field.dispose(); output.dispose(); diagnosticTarget.dispose();
		fieldMaterial.dispose(); outputMaterial.dispose(); diagnosticMaterial.dispose();
		// QuadMesh owns shared geometry; the test must leave it for other render passes.
		await renderer.setAnimationLoop( animation );

	}

}
