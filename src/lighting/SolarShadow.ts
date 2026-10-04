import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, uniform, texture, textureLoad, reference, float, vec2, vec3, vec4, ivec2, uv,
	min, max, abs, clamp, cos, sin, pow, tan, dot, select, dFdx, dFdy, floor, fract, mix, smoothstep,
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
	// Judge the projected plane's conditioning relative to its derivative lengths. An
	// absolute determinant threshold changes with viewport size and camera distance.
	const scale = max( dot( dx.xy, dx.xy ).mul( dot( dy.xy, dy.xy ) ), 1e-30 );
	const condition = determinant.mul( determinant ).div( scale ).toVar();
	const valid = condition.greaterThan( 1e-6 ).and( abs( determinant ).greaterThan( 1e-20 ) );
	const denominator = select( valid, determinant, float( 1 ) );
	const gradient = vec2( dx.z.mul( dy.y ).sub( dy.z.mul( dx.y ) ),
		dy.z.mul( dx.x ).sub( dx.z.mul( dy.x ) ) ).div( denominator );
	return select( valid, clamp( gradient, vec2( - 16 ), vec2( 16 ) ), vec2( 0 ) )
		.mul( smoothstep( 1e-6, 1e-4, condition ) );

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

// An orthographic ray stays inside its endpoints' bounds. Reject only disjoint
// bounds so a ray crossing a shadow map between two outside endpoints is retained.
export const volumeShadowRayMayIntersect = Fn( ( [ start, end ]: [ V3, V3 ] ) => {

	const low = min( start, end ).toVar(), high = max( start, end ).toVar();
	return low.x.lessThanEqual( 1 ).and( low.y.lessThanEqual( 1 ) ).and( low.z.lessThanEqual( 1 ) )
		.and( high.x.greaterThanEqual( 0 ) ).and( high.y.greaterThanEqual( 0 ) ).and( high.z.greaterThanEqual( 0 ) );

} ).setLayout( { name: 'volumeShadowRayMayIntersect', type: 'bool', inputs: [
	{ name: 'start', type: 'vec3' }, { name: 'end', type: 'vec3' },
] } );

// Volume samples have no receiver plane. Gather four base-level depth comparisons
// without derivatives, so depth integration can run in nonuniform control flow.
// Keep texture bindings local to the material, as for the surface-shadow factory below.
export function solarVolumeVisibility( depth: THREE.Texture | THREE.TextureNode, coordinate: V3, mapSize: V2 ): F {

	return Fn( () => {

		const sc = coordinate.toVar();
		const inside = sc.x.greaterThanEqual( 0 ).and( sc.y.greaterThanEqual( 0 ) )
			.and( sc.x.lessThanEqual( 1 ) ).and( sc.y.lessThanEqual( 1 ) )
			.and( sc.z.greaterThanEqual( 0 ) ).and( sc.z.lessThanEqual( 1 ) );
		const visibility = float( 1 ).toVar();
		If( inside, () => {

			const size = max( mapSize, vec2( 1 ) ).toVar();
			const weight = fract( sc.xy.mul( size ).sub( 0.5 ) ).toVar();
			// TSL gather().compare() emits textureGatherCompare, which has no implicit LOD
			// or uniform-flow restriction. WGSL returns (0,1), (1,1), (1,0), (0,0).
			const taps = texture( depth, sc.xy ).gather().compare( sc.z ).toVar();
			visibility.assign( mix( mix( taps.w, taps.z, weight.x ), mix( taps.x, taps.y, weight.x ), weight.y ) );

		} );
		return visibility;

	} )();

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
		// A fixed disk pattern stays attached to the light projection. Screen noise would
		// change a surface's sparse blocker samples as the camera moves, without a TAA pass.
		const rotation = float( 0.7 );
		const size = max( mapSize, vec2( 1 ) ).toVar();
		const span = max( worldSpan, vec2( 1e-3 ) ).toVar();
		const loadDepth = ( pixel: THREE.Node<'ivec2'> ): F => {

			const loaded = textureLoad( depth, pixel );
			return depthKind === 'color' ? loaded.x : loaded as unknown as F;

		};
		const compareSample = ( q: V2, compareDepth: F ): F => {

			// Hardware PCF applies one comparison depth to four texels. The receiver plane
			// changes inside that footprint too, even when the solar disk radius is zero.
			// Compare at each actual texel centre before interpolation: no extra slope bias
			// is needed, so a nearby caster keeps its contact on a steep receiver.
			const texel = q.mul( size ).sub( 0.5 ).toVar(), base = floor( texel ).toVar();
			const weight = fract( texel ).toVar();
			const compare = ( x: number, y: number ) => {

				const pixel = clamp( base.add( vec2( x, y ) ), vec2( 0 ), size.sub( 1 ) ).toVar();
				const centreOffset = pixel.add( 0.5 ).div( size ).sub( q );
				const receiverDepth = compareDepth.add( dot( gradient, centreOffset ) );
				return select( receiverDepth.lessThanEqual( loadDepth( ivec2( pixel ) ) ), float( 1 ), float( 0 ) );

			};
			return mix( mix( compare( 0, 0 ), compare( 1, 0 ), weight.x ),
				mix( compare( 0, 1 ), compare( 1, 1 ), weight.x ), weight.y );

		};
		// Three deduplicates texture uniforms by UUID and chooses the first access's sampler
		// type. Register a real comparison before raw loads. It remains the exact centre
		// result for a depth-constant receiver; sloped receivers use texel-plane comparisons.
		const centre = ( depthKind === 'depth' ? texture( depth, clamp( sc.xy, vec2( 0 ), vec2( 1 ) ) )
			.compare( sc.z ) as unknown as F : float( 1 ) ).toVar();
		const inside = sc.x.greaterThanEqual( 0 ).and( sc.y.greaterThanEqual( 0 ) )
			.and( sc.x.lessThanEqual( 1 ) ).and( sc.y.lessThanEqual( 1 ) )
			.and( sc.z.greaterThanEqual( 0 ) ).and( sc.z.lessThanEqual( 1 ) );
		const visibility = float( 1 ).toVar();
		// Ocean pixels beyond the island's light frustum need no raw shadow-map accesses.
		// Derivatives and the binding's comparison sample above still run uniformly.
		If( inside, () => {

			visibility.assign( depthKind === 'depth' ? centre : compareSample( sc.xy, sc.z ) );
			if ( depthKind === 'depth' ) If( max( abs( gradient.x ), abs( gradient.y ) ).greaterThan( 1e-7 ), () => {

				visibility.assign( compareSample( sc.xy, sc.z ) );

			} );
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
				const pixel = clamp( floor( q.mul( size ) ), vec2( 0 ), size.sub( 1 ) ).toVar();
				const stored = loadDepth( ivec2( pixel ) ).toVar();
				// A raw load uses the containing texel centre, not the requested disk position.
				// Correcting only the requested offset mistakes a sloped clear plane for a blocker.
				const centreOffset = pixel.add( 0.5 ).div( size ).sub( sc.xy );
				const corrected = stored.sub( dot( gradient, centreOffset ) ).toVar();
				const blocker = select( inside.and( corrected.lessThan( sc.z ) ), float( 1 ), float( 0 ) ).toVar();
				blockerDepth.addAssign( corrected.mul( blocker ) );
				blockerCount.addAssign( blocker );

			} );
			const average = select( blockerCount.greaterThan( 0 ), blockerDepth.div( max( blockerCount, 1 ) ), sc.z );
			const radius = solarPenumbraRadius( sc.z, average, depthRange, angularRadius, span ).toVar();
			const radiusTexels = max( radius.x.mul( size.x ), radius.y.mul( size.y ) ).toVar();
			// Bilinear comparison already covers a texel footprint. A solar penumbra below a
			// quarter texel needs no extra disk taps; fade them in to avoid a threshold jump.
			If( blockerCount.greaterThan( 0 ).and( radiusTexels.greaterThan( 0.25 ) ), () => {

				const filtered = visibility.toVar();

				Loop( FILTER_SAMPLES - 1, ( { i } ) => {

					const offset = solarShadowDiskOffset( float( i ).add( 1 ), float( FILTER_SAMPLES ), rotation, float( 0.5 ) ).mul( radius ).toVar();
					const q = sc.xy.add( offset ).toVar();
					const inside = q.x.greaterThanEqual( 0 ).and( q.y.greaterThanEqual( 0 ) )
						.and( q.x.lessThanEqual( 1 ) ).and( q.y.lessThanEqual( 1 ) );
					const compareDepth = sc.z.add( dot( gradient, offset ) );
					const sample = compareSample( q, compareDepth );
					filtered.addAssign( select( inside, sample, float( 1 ) ) );

				} );
				visibility.assign( mix( visibility, filtered.div( FILTER_SAMPLES ), smoothstep( 0.25, 0.75, radiusTexels ) ) );

			} );
		} );
		return visibility;

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

// QuadMesh temporarily installs its own full-screen vertex node during render. Capture that
// node for compileAsync so the precompiled cache key is identical to the subsequent draw.
async function renderSolarProbeQuad( renderer: THREE.WebGPURenderer, quad: THREE.QuadMesh ): Promise<void> {

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
	const renderReady = ( quad: THREE.QuadMesh ) => renderSolarProbeQuad( renderer, quad );
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

// A clear tilted depth field must stay fully lit at every subtexel phase. The reference native
// PCF intentionally omits the four-corner correction, proving that the fixture exercises the bug.
// A 3 cm blocker on that same plane must keep its attached contact instead of needing slope bias.
export async function verifySolarShadowRamp( renderer: THREE.WebGPURenderer ) {

	const mapSize = 256, width = 512, height = 32, span = 8, depthRange = 219;
	const depthTexture = new THREE.DepthTexture( mapSize, mapSize, THREE.FloatType );
	depthTexture.compareFunction = THREE.LessEqualCompare;
	depthTexture.minFilter = depthTexture.magFilter = THREE.LinearFilter;
	const field = new THREE.RenderTarget( mapSize, mapSize, { type: THREE.FloatType, depthTexture } );
	const output = new THREE.RenderTarget( width, height, { type: THREE.FloatType, depthBuffer: false } );
	const fieldMaterial = new THREE.NodeMaterial(), outputMaterial = new THREE.NodeMaterial();
	for ( const material of [ fieldMaterial, outputMaterial ] ) {

		material.depthTest = false;
		material.depthWrite = material === fieldMaterial;
		material.toneMapped = false;
		material.blending = THREE.NoBlending;

	}
	const gradient = uniform( new THREE.Vector2() ), phase = uniform( new THREE.Vector2() ), gap = uniform( 0 );
	const planeDepth = ( q: V2 ) => float( 0.5 ).add( dot( gradient, q.sub( 0.5 ) ) );
	const fieldDepth = planeDepth( uv() ).sub( select( uv().x.lessThan( 0.5 ), gap, float( 0 ) ) );
	fieldMaterial.fragmentNode = vec4( fieldDepth, fieldDepth, fieldDepth, float( 1 ) );
	fieldMaterial.depthNode = fieldDepth;
	const sun = new THREE.DirectionalLight();
	sun.shadow.camera.left = - span / 2; sun.shadow.camera.right = span / 2;
	sun.shadow.camera.top = span / 2; sun.shadow.camera.bottom = - span / 2;
	sun.shadow.camera.near = 0; sun.shadow.camera.far = depthRange;
	sun.shadow.mapSize.set( mapSize, mapSize );
	installSolarShadowFilter( sun );
	const standardFilter = ( sun.shadow as unknown as { filterNode: ( input: { depthTexture: THREE.DepthTexture; shadowCoord: V3 } ) => F } ).filterNode;
	const parameters = { mapSize: vec2( mapSize ), worldSpan: vec2( span ), depthRange: float( depthRange ) };
	outputMaterial.fragmentNode = Fn( () => {

		const q = uv().mul( vec2( 0.4, 0.2 ) ).add( vec2( 0.3, 0.4 ) ).add( phase.div( mapSize ) ).toVar();
		// Only 1 cm of physical ray clearance: a slope-dependent blanket bias would erase
		// this nearby 3 cm blocker at the lower elevation instead of fixing interpolation.
		const receiverDepth = planeDepth( q ).sub( 0.01 / depthRange ).toVar();
		const native = ( texture( depthTexture, q ).compare( receiverDepth ) as unknown as F ).toVar();
		const coordinate = vec3( q, receiverDepth );
		const standard = standardFilter( { depthTexture, shadowCoord: coordinate } );
		const color = solarShadowVisibility( field.texture, coordinate, { ...parameters, depthKind: 'color' } );
		return vec4( standard, color, native, float( 1 ) );

	} )();
	const fieldQuad = new THREE.QuadMesh( fieldMaterial ), outputQuad = new THREE.QuadMesh( outputMaterial );
	const animation = renderer.getAnimationLoop();
	await renderer.setAnimationLoop( null );
	const state = THREE.RendererUtils.resetRendererState( renderer, {} as THREE.RendererUtils.RendererState );
	const cases: { elevation: number; slopeDegrees: number; phase: number[]; clearMinimum: number[];
		nativeClearMinimum: number; contactMaximumUmbra: number[]; contactMinimumLit: number[];
		contactWidthMetres: number[]; contactEdgeErrorMetres: number[]; maximumDifference: number }[] = [];
	let ready = false;
	try {

		renderer.setScissorTest( false );
		renderer.autoClear = true;
		for ( const elevation of [ 32, 10 ] ) for ( const slopeDegrees of [ 0, 37 ] ) for ( const subpixel of [
			[ 0.125, 0.375 ], [ 0.375, 0.625 ], [ 0.625, 0.875 ], [ 0.875, 0.125 ],
		] ) {

			const slope = span / ( depthRange * Math.tan( THREE.MathUtils.degToRad( elevation ) ) );
			const angle = THREE.MathUtils.degToRad( slopeDegrees );
			gradient.value.set( Math.cos( angle ) * slope, Math.sin( angle ) * slope );
			phase.value.set( subpixel[ 0 ], subpixel[ 1 ] );
			const clearMinimum = [ 1, 1 ], maximumUmbra = [ 0, 0 ], minimumLit = [ 1, 1 ];
			let nativeMinimum = 1, maximumDifference = 0;
			const profiles = [ new Array<number>( width ).fill( 0 ), new Array<number>( width ).fill( 0 ) ];
			for ( const contact of [ false, true ] ) {

				gap.value = contact ? 0.03 / depthRange : 0;
				renderer.setRenderTarget( field );
				if ( ! ready ) await renderSolarProbeQuad( renderer, fieldQuad );
				else fieldQuad.render( renderer );
				renderer.setRenderTarget( output );
				if ( ! ready ) await renderSolarProbeQuad( renderer, outputQuad );
				else outputQuad.render( renderer );
				ready = true;
				const pixels = await renderer.readRenderTargetPixelsAsync( output, 0, 0, width, height ) as Float32Array;
				for ( let k = 0; k < width * height; k ++ ) {

					const x = k % width, y = Math.floor( k / width );
					const qx = ( x + 0.5 ) / width * 0.4 + 0.3 + subpixel[ 0 ] / mapSize;
					if ( pixels[ k * 4 + 3 ] < 0.99999 ) throw new Error( 'Solar slope fixture did not draw' );
					for ( let c = 0; c < 3; c ++ ) {

						const value = pixels[ k * 4 + c ];
						if ( ! Number.isFinite( value ) || value < 0 || value > 1.00001 ) throw new Error( 'Solar slope fixture contains an invalid visibility' );
						if ( ! contact ) {

							if ( c < 2 ) clearMinimum[ c ] = Math.min( clearMinimum[ c ], value );
							else nativeMinimum = Math.min( nativeMinimum, value );

						} else if ( c < 2 ) {

							if ( qx < 0.48 ) maximumUmbra[ c ] = Math.max( maximumUmbra[ c ], value );
							if ( qx > 0.52 ) minimumLit[ c ] = Math.min( minimumLit[ c ], value );
							if ( y >= height / 4 && y < height * 3 / 4 ) profiles[ c ][ x ] += value / ( height / 2 );

						}

					}
					maximumDifference = Math.max( maximumDifference, Math.abs( pixels[ k * 4 ] - pixels[ k * 4 + 1 ] ) );

				}

			}
			const contactWidthMetres = profiles.map( ( p ) => p.filter( ( v ) => v > 0.1 && v < 0.9 ).length * span * 0.4 / width );
			const contactEdgeErrorMetres = profiles.map( ( p ) => {

				let nearest = 0;
				for ( let x = 1; x < width; x ++ ) if ( Math.abs( p[ x ] - 0.5 ) < Math.abs( p[ nearest ] - 0.5 ) ) nearest = x;
				const q = ( nearest + 0.5 ) / width * 0.4 + 0.3 + subpixel[ 0 ] / mapSize;
				return Math.abs( q - 0.5 ) * span;

			} );
			const result = { elevation, slopeDegrees, phase: subpixel, clearMinimum, nativeClearMinimum: nativeMinimum,
				contactMaximumUmbra: maximumUmbra, contactMinimumLit: minimumLit, contactWidthMetres, contactEdgeErrorMetres, maximumDifference };
			cases.push( result );
			if ( clearMinimum.some( ( v ) => v < 0.99999 ) || nativeMinimum > 0.95 ||
				maximumUmbra.some( ( v ) => v > 1e-5 ) || minimumLit.some( ( v ) => v < 0.99999 ) ||
				contactWidthMetres.some( ( v ) => v > 1.5 * span / mapSize ) ||
				contactEdgeErrorMetres.some( ( v ) => v > span / mapSize ) || maximumDifference > 1e-4 ) {

				throw new Error( `Solar receiver-plane interpolation failed: ${ JSON.stringify( result ) }` );

			}

		}
		return { mapSize, width, height, texelMetres: span / mapSize, physicalClearanceMetres: 0.01,
			contactBlockerGapMetres: 0.03, blockerPositions: BLOCKER_SAMPLES, filterPositions: FILTER_SAMPLES,
			maximumRawDepthReads: BLOCKER_SAMPLES + 4 * FILTER_SAMPLES, clearPlaneRawDepthReads: BLOCKER_SAMPLES + 4,
			maximumNativeComparisons: 1, cases };

	} finally {

		THREE.RendererUtils.restoreRendererState( renderer, state );
		field.dispose(); output.dispose();
		fieldMaterial.dispose(); outputMaterial.dispose();
		await renderer.setAnimationLoop( animation );

	}

}
