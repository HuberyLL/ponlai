import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, uniform, texture, textureLoad, reference, float, int, vec2, vec3, vec4, ivec2, uv,
	min, max, abs, clamp, cos, sin, pow, tan, dot, select, dFdx, dFdy, floor, fract, mix, smoothstep, step, positionWorld,
	interleavedGradientNoise, vogelDiskSample, screenCoordinate,
} from 'three/tsl';
import { SUN_ANGULAR_RADIUS } from './Radiometry.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type B = THREE.Node<'bool'>;

// The sun's soft shadow: PCSS for the solar disk, each 2x2 footprint read with one
// `textureGather` and compared by hand. three picks one sampler type per depth texture per
// material, so a material whose filter gathers a map reads that map only by gather and compares by
// hand (`solarVolumeVisibility`); a comparison-sampler reference belongs in a material of its own.
// Filters that take `dFdx` / `dFdy` stay out of `select()` / `If` branches (`installOpenShadow`).

const BLOCKER_SAMPLES = 6, FILTER_SAMPLES = 8;

// PCSS: Fernando, "Percentage-Closer Soft Shadows", SIGGRAPH 2005 sketches.
// For a directional disk the penumbra radius is blocker-receiver distance * tan(solar radius),
// rather than the perspective-light size ratio. No upstream source code is used here.
const solarShadowDiskOffset = Fn( ( [ index, count, rotation, exponent ]: [ F, F, F, F ] ) => {

	const radius = pow( index.add( 0.5 ).div( count ), exponent );
	const angle = index.mul( 2.399963229728653 ).add( rotation );
	return vec2( cos( angle ), sin( angle ) ).mul( radius );

} ).setLayout( { name: 'solarShadowDiskOffset', type: 'vec2', inputs: [
	{ name: 'index', type: 'float' }, { name: 'count', type: 'float' },
	{ name: 'rotation', type: 'float' }, { name: 'exponent', type: 'float' },
] } );

const solarPenumbraRadius = Fn( ( [ receiverDepth, blockerDepth, depthRange, angularRadius, worldSpan ]: [ F, F, F, F, V2 ] ) => {

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

// How a receiver filters a shadow map. `soft` false keeps the bilinear comparison alone (no
// blocker search, no penumbra disk): the quality tiers' cheapest mode.
export interface SolarShadowTaps {
	soft: boolean;
	blockerSamples: number;
	filterSamples: number;
}

export const SOLAR_SHADOW_TAPS: Readonly<SolarShadowTaps> = { soft: true, blockerSamples: BLOCKER_SAMPLES, filterSamples: FILTER_SAMPLES };

// Startup switch for timing the shadow filter against its former path (debug A/B only, read once
// at load because the filter compiles into every lit material): `?shadowFilter=legacy` is the
// hardware comparison and four loads per footprint; tokens `sl1` (gather) and `sl3` (the lighter
// vegetation taps, a lower tier's mode) switch the parts on. The default is sl1.
function readShadowFilterPath(): { gather: boolean; vegetation: boolean } {

	const value = typeof location === 'undefined' ? null : new URLSearchParams( location.search ).get( 'shadowFilter' );
	if ( value === null ) return { gather: true, vegetation: false };
	// '+' in a query string decodes to a space
	const tokens = value.toLowerCase().split( /[\s+,]+/ );
	return { gather: tokens.includes( 'sl1' ), vegetation: tokens.includes( 'sl3' ) };

}

export const SHADOW_FILTER_PATH = readShadowFilterPath();

export interface SolarShadowParameters {
	mapSize: V2;
	worldSpan: V2;
	depthRange: F;
	angularRadius?: F;
	depthKind?: 'depth' | 'color';
	// false skips the raw depth reads (the result is then fully lit): a map that is not in use
	active?: B;
	// the layer of an array depth texture
	layer?: number;
	taps?: Readonly<SolarShadowTaps>;
}

// One map of a filtered lookup: its coordinate, projection and layer.
export interface SolarShadowLayer {
	coordinate: V3;
	worldSpan: V2;
	depthRange: F;
	active?: B;
	layer?: number;
}

interface SolarShadowSharedParameters {
	mapSize: V2;
	angularRadius?: F;
	depthKind?: 'depth' | 'color';
	taps?: Readonly<SolarShadowTaps>;
	// one gather per 2x2 footprint, compared by hand (false: the hardware comparison and four loads)
	gather?: boolean;
}

// Address one layer of an array depth texture; a plain texture passes through.
function inLayer( node: THREE.TextureNode, layer?: number ): THREE.TextureNode {

	return layer === undefined ? node : node.depth( int( layer ) ) as unknown as THREE.TextureNode;

}

// textureGather of a 2x2 footprint. WGSL returns (0,1), (1,1), (1,0), (0,0) as x, y, z, w.
function gatherDepth( depth: THREE.Texture | THREE.TextureNode, uvNode: V2, layer?: number ): THREE.Node<'vec4'> {

	return inLayer( texture( depth, uvNode ), layer ).gather() as unknown as THREE.Node<'vec4'>;

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

// Volume samples have no receiver plane. Gather four base-level depths without derivatives, so
// depth integration can run in nonuniform control flow, and compare them by hand: a comparison
// sampler on a map that the surface filter gathers raw would be a second sampler type for one
// binding, which three cannot express.
// Keep texture bindings local to the material, as for the surface-shadow factory below.
export function solarVolumeVisibility( depth: THREE.Texture | THREE.TextureNode, coordinate: V3, mapSize: V2, active?: B, layer?: number ): F {

	const gather = SHADOW_FILTER_PATH.gather;
	return Fn( () => {

		const sc = coordinate.toVar();
		let inside = sc.x.greaterThanEqual( 0 ).and( sc.y.greaterThanEqual( 0 ) )
			.and( sc.x.lessThanEqual( 1 ) ).and( sc.y.lessThanEqual( 1 ) )
			.and( sc.z.greaterThanEqual( 0 ) ).and( sc.z.lessThanEqual( 1 ) );
		if ( active ) inside = inside.and( active );
		const visibility = float( 1 ).toVar();
		If( inside, () => {

			const size = max( mapSize, vec2( 1 ) ).toVar();
			const weight = fract( sc.xy.mul( size ).sub( 0.5 ) ).toVar();
			// textureGather(Compare) has no implicit LOD or uniform-flow restriction.
			// step( z, d ) is 1 where z <= d: the comparison's LessEqual
			const taps = ( gather ? step( vec4( sc.z ), gatherDepth( depth, sc.xy, layer ) )
				: inLayer( texture( depth, sc.xy ), layer ).gather().compare( sc.z ) as unknown as THREE.Node<'vec4'> ).toVar();
			visibility.assign( mix( mix( taps.w, taps.z, weight.x ), mix( taps.x, taps.y, weight.x ), weight.y ) );

		} );
		return visibility;

	} )();

}

// three's PCFShadowFilter, which tidewater's water takes (the waves break up any penumbra detail a
// contact-hardening filter would add): five bilinear comparisons on a Vogel disk of one texel's
// radius, the disk turned per pixel by interleaved gradient noise (fixed per pixel, so a paused
// frame repeats). Each comparison gathers its footprint and compares by hand (solarVolumeVisibility),
// so the map keeps the one sampler type the other filters read it by.
export function solarPCFVisibility( depth: THREE.Texture | THREE.TextureNode, coordinate: V3, mapSize: V2, active?: B, layer?: number ): F {

	return Fn( () => {

		const sc = coordinate.toVar();
		const phi = interleavedGradientNoise( screenCoordinate.xy ).mul( 2 * Math.PI ).toVar();
		const texel = vec2( 1 ).div( max( mapSize, vec2( 1 ) ) ).toVar();
		let sum: F = float( 0 );
		for ( let i = 0; i < 5; i ++ ) {

			const at = vec3( sc.xy.add( ( vogelDiskSample( int( i ), int( 5 ), phi ) as unknown as V2 ).mul( texel ) ), sc.z );
			sum = sum.add( solarVolumeVisibility( depth, at, mapSize, active, layer ) );

		}
		return sum.div( 5 );

	} )();

}

// Percentage-closer soft shadows for one map (or one layer of an array) of a depth texture.
// Call inside a Fn: it returns the visibility variable.
function solarShadowLayer( depth: THREE.Texture | THREE.TextureNode, { coordinate, worldSpan, depthRange, active, layer }: SolarShadowLayer,
	{ mapSize, angularRadius = float( SUN_ANGULAR_RADIUS ), depthKind = 'depth', taps = SOLAR_SHADOW_TAPS, gather = SHADOW_FILTER_PATH.gather }: SolarShadowSharedParameters ): F {

	const { soft, blockerSamples, filterSamples } = taps;
	// Gather reads the raw depths of a 2x2 footprint in one fetch. A colour render target holding
	// depth (the probe's reference) keeps four loads.
	const gathered = gather && depthKind === 'depth';
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

		const loaded = inLayer( textureLoad( depth, pixel ), layer );
		return depthKind === 'color' ? loaded.x : loaded as unknown as F;

	};
	const compareSample = ( q: V2, compareDepth: F, plane: V2 = gradient ): F => {

		// Hardware PCF applies one comparison depth to four texels. The receiver plane
		// changes inside that footprint too, even when the solar disk radius is zero.
		// Compare at each actual texel centre before interpolation: no extra slope bias
		// is needed, so a nearby caster keeps its contact on a steep receiver.
		const texel = q.mul( size ).sub( 0.5 ).toVar(), base = floor( texel ).toVar();
		const weight = fract( texel ).toVar();
		// Gather at the footprint's centre, the corner its four texels share: it picks the same
		// four texels as floor() above at any sub-texel position, with clamp-to-edge at the border
		// matching the clamped loads.
		const footprint = gathered ? gatherDepth( depth, base.add( 1 ).div( size ), layer ).toVar() : null;
		const compare = ( x: number, y: number ) => {

			const pixel = clamp( base.add( vec2( x, y ) ), vec2( 0 ), size.sub( 1 ) ).toVar();
			const centreOffset = pixel.add( 0.5 ).div( size ).sub( q );
			const receiverDepth = compareDepth.add( dot( plane, centreOffset ) );
			const stored = footprint ? footprint[ ( [ 'w', 'z', 'x', 'y' ] as const )[ y * 2 + x ] ] as F : loadDepth( ivec2( pixel ) );
			return select( receiverDepth.lessThanEqual( stored ), float( 1 ), float( 0 ) );

		};
		return mix( mix( compare( 0, 0 ), compare( 1, 0 ), weight.x ),
			mix( compare( 0, 1 ), compare( 1, 1 ), weight.x ), weight.y );

	};
	// Three deduplicates texture uniforms by UUID and chooses the first access's sampler
	// type. Without gather, register a real comparison before raw loads. It remains the exact
	// centre result for a depth-constant receiver; sloped receivers use texel-plane comparisons.
	const centre = ( depthKind === 'depth' && ! gathered ? inLayer( texture( depth, clamp( sc.xy, vec2( 0 ), vec2( 1 ) ) ), layer )
		.compare( sc.z ) as unknown as F : float( 1 ) ).toVar();
	let inside = sc.x.greaterThanEqual( 0 ).and( sc.y.greaterThanEqual( 0 ) )
		.and( sc.x.lessThanEqual( 1 ) ).and( sc.y.lessThanEqual( 1 ) )
		.and( sc.z.greaterThanEqual( 0 ) ).and( sc.z.lessThanEqual( 1 ) );
	if ( active ) inside = inside.and( active );
	const visibility = float( 1 ).toVar();
	// Ocean pixels beyond the island's light frustum need no raw shadow-map accesses.
	// Derivatives and the binding's comparison sample above still run uniformly.
	If( inside, () => {

		if ( depthKind === 'depth' && ! gathered ) {

			visibility.assign( centre );
			If( max( abs( gradient.x ), abs( gradient.y ) ).greaterThan( 1e-7 ), () => {

				visibility.assign( compareSample( sc.xy, sc.z ) );

			} );

		} else {

			// The centre keeps the former split: a receiver plane too flat to matter compares the
			// plain depth, as the hardware comparison did. A NaN gradient fails the test too and
			// takes the same path (comparing along it would shadow the pixel outright); a huge but
			// finite one, where the derivatives straddle a jump such as the refracted entry point
			// at the waterline, passes, already clamped by receiverGradient, as on the legacy path.
			const usable = max( abs( gradient.x ), abs( gradient.y ) ).greaterThan( 1e-7 );
			visibility.assign( compareSample( sc.xy, sc.z, select( usable, gradient, vec2( 0 ) ) ) );

		}
		if ( ! soft ) return;
		// This conservative search covers any caster between the receiver and the near plane.
		// Progressive radii retain samples close to a thin leaf or a sharp contact, as well as
		// finding more distant blockers. The first sample is the centre itself.
		const searchRadius = solarPenumbraRadius( max( sc.z, 0 ), float( 0 ), depthRange, angularRadius, span ).toVar();
		const blockerDepth = float( 0 ).toVar(), blockerCount = float( 0 ).toVar();
		Loop( blockerSamples, ( { i } ) => {

			const index = float( i );
			const offset = select( index.equal( 0 ), vec2( 0 ),
				solarShadowDiskOffset( max( index.sub( 1 ), 0 ), float( blockerSamples - 1 ), rotation, float( 2 ) ) ).mul( searchRadius ).toVar();
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
		// When every search tap is blocked the point lies in the umbra, since the search
		// spans the widest penumbra possible at this depth: the bilinear result stands, and
		// the disk taps are left to the penumbra bands.
		If( blockerCount.greaterThan( 0 ).and( blockerCount.lessThan( blockerSamples ) ).and( radiusTexels.greaterThan( 0.25 ) ), () => {

			const filtered = visibility.toVar();

			Loop( filterSamples - 1, ( { i } ) => {

				const offset = solarShadowDiskOffset( float( i ).add( 1 ), float( filterSamples ), rotation, float( 0.5 ) ).mul( radius ).toVar();
				const q = sc.xy.add( offset ).toVar();
				const inside = q.x.greaterThanEqual( 0 ).and( q.y.greaterThanEqual( 0 ) )
					.and( q.x.lessThanEqual( 1 ) ).and( q.y.lessThanEqual( 1 ) );
				const compareDepth = sc.z.add( dot( gradient, offset ) );
				const sample = compareSample( q, compareDepth );
				filtered.addAssign( select( inside, sample, float( 1 ) ) );

			} );
			visibility.assign( mix( visibility, filtered.div( filterSamples ), smoothstep( 0.25, 0.75, radiusTexels ) ) );

		} );

	} );
	return visibility;

}

// Texture access stays in a material-local node factory. A shared layout function must never
// close over a texture or uniform binding generated for a different material.
export function solarShadowVisibility( depth: THREE.Texture | THREE.TextureNode, coordinate: V3,
	{ mapSize, worldSpan, depthRange, angularRadius, depthKind = 'depth', active, layer, taps }: SolarShadowParameters ): F {

	return Fn( () => solarShadowLayer( depth, { coordinate, worldSpan, depthRange, active, layer },
		{ mapSize, angularRadius, depthKind, taps } ) )();

}

// Two maps of one depth texture blended by weight (the stepped sun: previous, current), each
// filtered on its own with the same taps: a map's result never depends on the other, so the
// cross-fade stays continuous across a redraw, when the current map becomes the previous one.
// (Filtering both in one shared loop was tried and measured no faster.)
export function solarSteppedShadowVisibility( depth: THREE.Texture | THREE.TextureNode, previous: SolarShadowLayer, current: SolarShadowLayer, weight: F,
	{ mapSize, angularRadius, taps }: { mapSize: V2; angularRadius?: F; taps?: Readonly<SolarShadowTaps> } ): F {

	return mix(
		Fn( () => solarShadowLayer( depth, previous, { mapSize, angularRadius, taps } ) )(),
		Fn( () => solarShadowLayer( depth, current, { mapSize, angularRadius, taps } ) )(),
		weight );

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

type ShadowFilterInputs = { filterFn: ( inputs: object ) => F; shadowCoord: V3; depthTexture: unknown; shadow: unknown; depthLayer: unknown };
type FrustumShadowFilter = ( builder: THREE.NodeBuilder, inputs: ShadowFilterInputs ) => F;

// three.js runs a light's shadow filter only inside its shadow camera's frustum and leaves every
// receiver outside it fully lit. A visibility that covers the whole scene (the clouds') would stop
// at the map's edge if it lived in the filter, so it multiplies the frustum-tested result instead:
// once per receiver, inside the frustum or beyond it.
// three also emits the filter inside the frustum test's branch, where the receiver plane's
// derivatives are undefined for a quad that straddles the test (the refracted entry points at the
// waterline jump in and out of the map): such pixels read whatever the neighbouring lanes left and
// changed with any edit to the shader. The filter is evaluated first, in uniform control flow (it
// returns lit outside the map itself), and only its result is selected.
export function installOpenShadow( sun: THREE.DirectionalLight, visibility: ( position: V3 ) => F ): void {

	const node = new THREE.ShadowNode( sun, null ) as unknown as { setupShadowFilter: FrustumShadowFilter };
	node.setupShadowFilter = ( _builder, { filterFn, depthTexture, shadowCoord, shadow, depthLayer } ) => Fn( () => {

		const filtered = filterFn( { depthTexture, shadowCoord, shadow, depthLayer } ).toVar();
		const frustum = shadowCoord.x.greaterThanEqual( 0 ).and( shadowCoord.x.lessThanEqual( 1 ) )
			.and( shadowCoord.y.greaterThanEqual( 0 ) ).and( shadowCoord.y.lessThanEqual( 1 ) )
			.and( shadowCoord.z.lessThanEqual( 1 ) );
		return select( frustum, filtered, float( 1 ) ).mul( visibility( positionWorld ) );

	} )();
	sun.shadow.shadowNode = node as unknown as THREE.Node;

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
// It is the hardware comparison sampler, drawn by a material of its own, so it stays independent
// of the gathered path; the gathered volume lookup (solarVolumeVisibility) must match it.
// A 3 cm blocker on that same plane must keep its attached contact instead of needing slope bias.
// Filtering hardware may hold the bilinear weights to 8 bits per axis: up to 1/256 on each.
const VOLUME_REFERENCE_TOLERANCE = 2 / 255;
export async function verifySolarShadowRamp( renderer: THREE.WebGPURenderer ) {

	const mapSize = 256, width = 512, height = 32, span = 8, depthRange = 219;
	const depthTexture = new THREE.DepthTexture( mapSize, mapSize, THREE.FloatType );
	depthTexture.compareFunction = THREE.LessEqualCompare;
	depthTexture.minFilter = depthTexture.magFilter = THREE.LinearFilter;
	const field = new THREE.RenderTarget( mapSize, mapSize, { type: THREE.FloatType, depthTexture } );
	const output = new THREE.RenderTarget( width, height, { type: THREE.FloatType, depthBuffer: false } );
	const reference = new THREE.RenderTarget( width, height, { type: THREE.FloatType, depthBuffer: false } );
	const fieldMaterial = new THREE.NodeMaterial(), outputMaterial = new THREE.NodeMaterial(), referenceMaterial = new THREE.NodeMaterial();
	for ( const material of [ fieldMaterial, outputMaterial, referenceMaterial ] ) {

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
	const probeCoordinate = () => uv().mul( vec2( 0.4, 0.2 ) ).add( vec2( 0.3, 0.4 ) ).add( phase.div( mapSize ) ).toVar();
	// Only 1 cm of physical ray clearance: a slope-dependent blanket bias would erase
	// this nearby 3 cm blocker at the lower elevation instead of fixing interpolation.
	const probeDepth = ( q: V2 ) => planeDepth( q ).sub( 0.01 / depthRange ).toVar();
	// Hardware PCF semantics: one comparison depth for the four texels, from the comparison
	// sampler. One material cannot bind the depth texture with two sampler types, so this one
	// holds only the comparison.
	referenceMaterial.fragmentNode = Fn( () => {

		const q = probeCoordinate();
		return vec4( texture( depthTexture, q ).compare( probeDepth( q ) ) as unknown as F, 0, 0, 1 );

	} )();
	outputMaterial.fragmentNode = Fn( () => {

		const q = probeCoordinate();
		const receiverDepth = probeDepth( q );
		// The same semantics as the volume lookup reads them (gathered, or a comparison sampler on
		// the legacy path), checked against the reference above.
		const native = solarVolumeVisibility( depthTexture, vec3( q, receiverDepth ), vec2( mapSize ) ).toVar();
		const coordinate = vec3( q, receiverDepth );
		const standard = standardFilter( { depthTexture, shadowCoord: coordinate } );
		const color = solarShadowVisibility( field.texture, coordinate, { ...parameters, depthKind: 'color' } );
		return vec4( standard, color, native, float( 1 ) );

	} )();
	const fieldQuad = new THREE.QuadMesh( fieldMaterial ), outputQuad = new THREE.QuadMesh( outputMaterial );
	const referenceQuad = new THREE.QuadMesh( referenceMaterial );
	const animation = renderer.getAnimationLoop();
	await renderer.setAnimationLoop( null );
	const state = THREE.RendererUtils.resetRendererState( renderer, {} as THREE.RendererUtils.RendererState );
	const cases: { elevation: number; slopeDegrees: number; phase: number[]; clearMinimum: number[];
		nativeClearMinimum: number; volumeClearMinimum: number; volumeReferenceDifference: number;
		contactMaximumUmbra: number[]; contactMinimumLit: number[];
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
			let nativeMinimum = 1, volumeMinimum = 1, volumeDifference = 0, maximumDifference = 0;
			const profiles = [ new Array<number>( width ).fill( 0 ), new Array<number>( width ).fill( 0 ) ];
			for ( const contact of [ false, true ] ) {

				gap.value = contact ? 0.03 / depthRange : 0;
				renderer.setRenderTarget( field );
				if ( ! ready ) await renderSolarProbeQuad( renderer, fieldQuad );
				else fieldQuad.render( renderer );
				renderer.setRenderTarget( output );
				if ( ! ready ) await renderSolarProbeQuad( renderer, outputQuad );
				else outputQuad.render( renderer );
				renderer.setRenderTarget( reference );
				if ( ! ready ) await renderSolarProbeQuad( renderer, referenceQuad );
				else referenceQuad.render( renderer );
				ready = true;
				const pixels = await renderer.readRenderTargetPixelsAsync( output, 0, 0, width, height ) as Float32Array;
				const hardware = await renderer.readRenderTargetPixelsAsync( reference, 0, 0, width, height ) as Float32Array;
				for ( let k = 0; k < width * height; k ++ ) {

					const x = k % width, y = Math.floor( k / width );
					const qx = ( x + 0.5 ) / width * 0.4 + 0.3 + subpixel[ 0 ] / mapSize;
					if ( pixels[ k * 4 + 3 ] < 0.99999 || hardware[ k * 4 + 3 ] < 0.99999 ) throw new Error( 'Solar slope fixture did not draw' );
					const native = hardware[ k * 4 ];
					if ( ! Number.isFinite( native ) || native < 0 || native > 1.00001 ) throw new Error( 'Solar slope reference contains an invalid visibility' );
					if ( ! contact ) nativeMinimum = Math.min( nativeMinimum, native );
					volumeDifference = Math.max( volumeDifference, Math.abs( pixels[ k * 4 + 2 ] - native ) );
					for ( let c = 0; c < 3; c ++ ) {

						const value = pixels[ k * 4 + c ];
						if ( ! Number.isFinite( value ) || value < 0 || value > 1.00001 ) throw new Error( 'Solar slope fixture contains an invalid visibility' );
						if ( ! contact ) {

							if ( c < 2 ) clearMinimum[ c ] = Math.min( clearMinimum[ c ], value );
							else volumeMinimum = Math.min( volumeMinimum, value );

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
				volumeClearMinimum: volumeMinimum, volumeReferenceDifference: volumeDifference, contactMaximumUmbra: maximumUmbra,
				contactMinimumLit: minimumLit, contactWidthMetres, contactEdgeErrorMetres, maximumDifference };
			cases.push( result );
			// The gathered volume lookup must be the hardware comparison's bilinear PCF, to within the
			// filtering hardware's sub-texel weight precision; a misplaced texel differs by a quarter
			// or more somewhere along the step.
			if ( clearMinimum.some( ( v ) => v < 0.99999 ) || nativeMinimum > 0.95 || volumeDifference > VOLUME_REFERENCE_TOLERANCE ||
				maximumUmbra.some( ( v ) => v > 1e-5 ) || minimumLit.some( ( v ) => v < 0.99999 ) ||
				contactWidthMetres.some( ( v ) => v > 1.5 * span / mapSize ) ||
				contactEdgeErrorMetres.some( ( v ) => v > span / mapSize ) || maximumDifference > 1e-4 ) {

				throw new Error( `Solar receiver-plane interpolation failed: ${ JSON.stringify( result ) }` );

			}

		}
		// depth fetches per receiver: a gather or four loads per bilinear footprint, one load per search tap
		const footprintFetches = SHADOW_FILTER_PATH.gather ? 1 : 4;
		return { mapSize, width, height, texelMetres: span / mapSize, physicalClearanceMetres: 0.01,
			contactBlockerGapMetres: 0.03, blockerPositions: BLOCKER_SAMPLES, filterPositions: FILTER_SAMPLES,
			gather: SHADOW_FILTER_PATH.gather, maximumDepthFetches: BLOCKER_SAMPLES + footprintFetches * FILTER_SAMPLES,
			clearPlaneDepthFetches: BLOCKER_SAMPLES + footprintFetches, maximumNativeComparisons: SHADOW_FILTER_PATH.gather ? 0 : 1, cases };

	} finally {

		THREE.RendererUtils.restoreRendererState( renderer, state );
		field.dispose(); output.dispose(); reference.dispose();
		fieldMaterial.dispose(); outputMaterial.dispose(); referenceMaterial.dispose();
		await renderer.setAnimationLoop( animation );

	}

}
