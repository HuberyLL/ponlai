import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, Break, uniform, texture, texture3D, textureStore, instanceIndex, uint, int, float,
	vec2, vec3, vec4, ivec2, fract, dot, mix, smoothstep, clamp, max, min, exp, sqrt, select,
	asin, atan, cos, sin, normalize,
} from 'three/tsl';
import { bakeCloudNoise, cloudRemap as remap, type CloudNoise } from '../materials/CloudNoise.ts';
import type { Atmosphere } from './Atmosphere.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

// Volumetric clouds on a curved layer a few kilometres up. Coverage, type and height come from a
// tileable weather map; a Perlin-Worley shape eroded by Worley detail gives flat-based heaps with
// billowed tops. Lighting marches toward the key light and sums a few scattering octaves
// (Wrenninge et al., "Oz: The Great and Volumetric", 2013) under a two-lobe phase, so
// tops glow, bases shade and edges toward the sun silver. Distance fades clouds into the clear
// sky's own colour at the horizon. The technique follows Schneider (Horizon Zero Dawn, 2015).
//
// The view is direction-only: clouds are kilometres away while the camera moves metres. A
// 3072 x 768 upper-hemisphere map (latitude stretched toward the horizon) is refreshed one
// sixteenth per frame and sampled by the dome; the reflection panorama, environment and
// cloud shadows read the same field.

export const EARTH_RADIUS = 6_360_000;
const LAYER_BOTTOM = 700, LAYER_TOP = 5200;
// Noise tiles divide the wrap period, so the wrapped wind offset is seamless.
const WRAP = 48000, WEATHER_TILE = 48000, SHAPE_TILE = 3000, DETAIL_TILE = 800;
const SIGMA = 0.03; // extinction per metre at unit density
const MAX_SPAN = 30000; // metres of layer marched along one view ray
export const DOME_WIDTH = 3072, DOME_HEIGHT = 768;
const STRIDE = 4; // refresh pattern: one texel in STRIDE x STRIDE per frame
const SHADOW_SIZE = 256, SHADOW_SPAN = 8000;
const MAX_STEPS = 96;
const MULTIPLE_SCATTERING = 2.5;
// A weather change sweeps across this many metres of sky, arriving from upwind.
const FRONT_SPAN = 25000;

// Upper-hemisphere map: longitude across, sqrt(latitude) up, denser near the horizon.
export const directionToDome = Fn( ( [ d ]: [ V3 ] ) => {

	const lat = asin( clamp( d.y, 0, 1 ) ).mul( 2 / Math.PI );
	return vec2( atan( d.z, d.x ).mul( 0.5 / Math.PI ).add( 0.5 ), sqrt( max( lat, 0 ) ) );

} ).setLayout( { name: 'cloudDirectionToDome', type: 'vec2', inputs: [ { name: 'd', type: 'vec3' } ] } );

const domeToDirection = Fn( ( [ q ]: [ V2 ] ) => {

	const lat = q.y.mul( q.y ).mul( Math.PI / 2 ).toVar(), phi = q.x.sub( 0.5 ).mul( 2 * Math.PI ).toVar();
	return vec3( cos( lat ).mul( cos( phi ) ), sin( lat ), cos( lat ).mul( sin( phi ) ) );

} ).setLayout( { name: 'cloudDomeToDirection', type: 'vec3', inputs: [ { name: 'q', type: 'vec2' } ] } );

// Distance along a ray from height h (metres) with vertical cosine mu to the sphere `a` metres
// above sea level, for a viewer below it. Written without R^2 terms to keep float precision.
const layerDistance = Fn( ( [ h, mu, a ]: [ F, F, F ] ) => {

	const rho = h.add( EARTH_RADIUS ).toVar();
	const b = rho.mul( mu ).toVar();
	const inside = a.sub( h ).mul( h.add( a ).add( 2 * EARTH_RADIUS ) ).toVar(); // r^2 - rho^2 > 0
	const root = sqrt( max( b.mul( b ).add( inside ), 0 ) ).toVar();
	return select( b.greaterThan( 0 ), inside.div( root.add( b ) ), root.sub( b ) );

} ).setLayout( { name: 'cloudLayerDistance', type: 'float', inputs: [
	{ name: 'h', type: 'float' }, { name: 'mu', type: 'float' }, { name: 'a', type: 'float' },
] } );

// Weather-map value at a cloud's edge for a coverage: the field is roughly normal (deviation
// .18), so the threshold is its quantile (Tukey's approximation of the probit). The mean is
// calibrated on the rendered sky: fair weather (.32) clouds about a quarter of it, cloudy (.67)
// about two thirds.
const coverThreshold = ( coverage: F ) => {

	const c = clamp( coverage, 0.001, 0.999 );
	return float( 1 ).sub( c ).pow( 0.14 ).sub( c.pow( 0.14 ) ).mul( 4.91 * 0.177 ).add( 0.235 );

};

// Normalised Henyey-Greenstein phase.
const henyeyGreenstein = ( cosTheta: F, g: number ) =>
	float( 1 - g * g ).div( float( 1 + g * g ).sub( cosTheta.mul( 2 * g ) ).pow( 1.5 ).mul( 4 * Math.PI ) );

export class Clouds {

	// Coverage and density over the island; they drive the lighting decisions for the deck.
	readonly coverage = uniform( 0.28 );
	readonly density = uniform( 1 );
	// The weather front: values before and after, the linear progress over the island and the
	// unit horizontal direction the weather comes from.
	readonly coverageFrom = uniform( 0.28 );
	readonly coverageTo = uniform( 0.28 );
	readonly densityFrom = uniform( 1 );
	readonly densityTo = uniform( 1 );
	readonly frontProgress = uniform( 1 );
	readonly rainFrom = uniform( 0 );
	// High cirrus: amount and the unit direction its fibres are combed along (the wind).
	readonly cirrus = uniform( 0 );
	readonly cirrusAxis = uniform( new THREE.Vector2( 1, 0 ) );
	readonly rainTo = uniform( 0 );
	readonly frontAxis = uniform( new THREE.Vector2( 1, 0 ) );
	// Set through setWindOffset, which keeps it within one noise period.
	readonly windOffset = uniform( new THREE.Vector2() );
	readonly lightDir = uniform( new THREE.Vector3( 0.75, 0.53, - 0.12 ).normalize() );
	// Irradiance arriving at the cloud layer from the key light (scene units).
	readonly lightColor = uniform( new THREE.Color( 0.5, 0.45, 0.38 ) );
	// Night sky glow and moonlit fill, added to the atmosphere's own sky light.
	readonly nightAmbient = uniform( new THREE.Color( 0, 0, 0 ) );
	readonly seaBounce = uniform( new THREE.Color( 0, 0, 0 ) );
	// Art balance of beam to sky light inside the clouds. A low sun's beam is already reddened
	// by the atmosphere; favouring it keeps sunset clouds glowing instead of muddy.
	readonly directGain = uniform( 1 );
	readonly ambientGain = uniform( 1 );
	readonly evolve = uniform( 0 );
	readonly origin = uniform( new THREE.Vector3( 0, 15, 0 ) );
	// Steps per view ray: 40 / 56 / 72 for low / medium / high.
	readonly quality = uniform( 56 );
	readonly dome: THREE.StorageTexture;
	readonly shadowMap: THREE.StorageTexture;
	private noise: CloudNoise | null = null;
	private phase = uniform( new THREE.Vector2() );
	private partialKernel: THREE.ComputeNode | null = null;
	private shadowKernel: THREE.ComputeNode | null = null;
	private frame = 0;
	private needsFull = true;

	constructor( private readonly atmosphere: Atmosphere ) {

		this.dome = new THREE.StorageTexture( DOME_WIDTH, DOME_HEIGHT );
		this.dome.type = THREE.HalfFloatType;
		this.dome.wrapS = THREE.RepeatWrapping;
		this.dome.wrapT = THREE.ClampToEdgeWrapping;
		this.dome.minFilter = this.dome.magFilter = THREE.LinearFilter;
		this.dome.generateMipmaps = false;
		this.dome.name = 'cloudDome';
		this.shadowMap = new THREE.StorageTexture( SHADOW_SIZE, SHADOW_SIZE );
		this.shadowMap.type = THREE.UnsignedByteType;
		this.shadowMap.minFilter = this.shadowMap.magFilter = THREE.LinearFilter;
		this.shadowMap.generateMipmaps = false;
		this.shadowMap.name = 'cloudShadow';

	}

	get ready(): boolean { return this.noise !== null; }

	/** Bakes the noise once and builds the update kernels. Needs an initialised renderer. */
	init( renderer: THREE.WebGPURenderer ): void {

		if ( this.noise ) return;
		this.noise = bakeCloudNoise( renderer );
		const { shape, detail, weather } = this.noise;
		const shapeNode = texture3D( shape ), detailNode = texture3D( detail ), weatherNode = texture( weather );

		// `near` (1 close, 0 far) fades small-scale structure that coarse grazing steps would
		// stretch into streaks toward the horizon.
		const densityAt = ( xz: V2, altitude: F, withDetail: boolean, near: F = float( 1 ) ) => {

			const result = float( 0 ).toVar();
			// Upwind sky is further through a weather change than the island; downwind lags.
			const reached = clamp( this.frontProgress.add( dot( xz, this.frontAxis ).div( FRONT_SPAN ) ), 0, 1 ).toVar();
			const sweep = reached.mul( reached ).mul( float( 3 ).sub( reached.mul( 2 ) ) );
			const p = xz.add( this.windOffset ).toVar();
			const w = weatherNode.sample( p.div( WEATHER_TILE ) ).level( float( 0 ) ).toVar();
			const cov = clamp( mix( this.coverageFrom, this.coverageTo, sweep ), 0, 1 ).toVar();
			const localDensity = mix( this.densityFrom, this.densityTo, sweep ).toVar();
			const overcast = smoothstep( 0.72, 0.97, cov ).toVar();
			// Coverage carves the clumped weather field; a full overcast closes it into a deck.
			const threshold = coverThreshold( cov ).toVar();
			const local = smoothstep( threshold.sub( 0.12 ), threshold.add( 0.1 ), w.r );
			const cover = max( local, overcast.mul( w.r.mul( 0.3 ).add( 0.7 ) ) ).toVar();
			// Heaped cumulus by default; flat stratus decks under overcast and in a few drifts.
			const stratus = max( overcast, smoothstep( 0.62, 0.95, float( 1 ).sub( w.g ) ).mul( 0.4 ) ).toVar();
			const base = mix( float( 1350 ), float( 950 ), stratus ).add( w.b.sub( 0.5 ).mul( 260 ) ).toVar();
			const thickness = mix( w.b.mul( 1900 ).add( 1200 ).mul( cover.mul( 0.5 ).add( 0.5 ) ), float( 750 ), stratus ).toVar();
			const reach = altitude.sub( base ).div( thickness ).toVar();
			// Towers reach up to 1.25 x the layer's thickness; skip the noise outside that span.
			If( reach.greaterThan( 0 ).and( reach.lessThan( 1.25 ) ).and( cover.greaterThan( 0.001 ) ), () => {

				const shapeSample = shapeNode.sample( vec3( p.x, altitude.add( this.evolve ), p.y ).div( SHAPE_TILE ) ).level( float( 0 ) ).toVar();
				const lowFbm = shapeSample.g.mul( 0.625 ).add( shapeSample.b.mul( 0.25 ) ).add( shapeSample.a.mul( 0.125 ) );
				// A distant deck is seen through so much of itself that its texture averages out;
				// coarse grazing steps would otherwise turn that texture into grain.
				const heap = mix( float( 0.62 ), clamp( remap( shapeSample.r, lowFbm.sub( 1 ), 1, 0, 1 ), 0, 1 ), mix( float( 1 ), near, stratus ) );
				// Cellular towers of uneven height above one flat base; stratus stays level.
				const towers = mix( mix( float( 0.5 ), float( 1.25 ), shapeSample.g ), float( 1 ), stratus );
				const hf = reach.div( towers ).toVar();
				// Flat bases, rounded tops: cumulus taper from mid-height, stratus near the top.
				const profile = smoothstep( 0, 0.08, hf ).mul( smoothstep( 1, mix( float( 0.3 ), float( 0.7 ), stratus ), hf ) );
				// Inside a clump, the heap noise still splits the mass into separate cumuli.
				const body = clamp( remap( heap.mul( profile ), float( 1 ).sub( cover.mul( mix( float( 0.82 ), float( 1 ), stratus ) ) ), 1, 0, 1 ), 0, 1 ).mul( cover ).toVar();
				// A deck's underside breaks into rolls and cells (stratocumulus), thinner between
				// them so light leaks through; heavy rain decks (dense) stay more uniform.
				const cells = smoothstep( 0.3, 0.6, shapeSample.b.mul( 0.6 ).add( shapeSample.a.mul( 0.4 ) ) );
				const underside = float( 1 ).sub( smoothstep( 0.3, 0.85, hf ) ).mul( stratus ).mul( smoothstep( 2.6, 1.4, localDensity ).mul( 0.65 ).add( 0.3 ) ).mul( near );
				body.mulAssign( mix( float( 1 ), cells.mul( 0.96 ).add( 0.04 ), underside ) );
				if ( withDetail ) {

					If( body.greaterThan( 0 ), () => {

						const d = detailNode.sample( vec3( p.x, altitude.add( this.evolve.mul( 2 ) ), p.y ).div( DETAIL_TILE ) ).level( float( 0 ) );
						const fbm = d.r.mul( 0.625 ).add( d.g.mul( 0.25 ) ).add( d.b.mul( 0.125 ) );
						// Wispy, torn bases; billowed tops. Fades toward the horizon with the cells.
						const erosion = mix( fbm, float( 1 ).sub( fbm ), clamp( hf.mul( 4 ), 0, 1 ) ).mul( near.mul( 0.35 ).add( 0.2 ) );
						body.assign( clamp( remap( body, erosion, 1, 0, 1 ), 0, 1 ) );

					} );

				}
				result.assign( body.mul( max( localDensity, 0 ) ) );

			} );
			return result;

		};

		const altitudeAt = ( h: F, mu: F, t: F ) =>
			h.add( t.mul( mu ) ).add( t.mul( t ).mul( float( 1 ).sub( mu.mul( mu ) ) ).div( 2 * EARTH_RADIUS ) );

		// Optical depth toward the key light: six samples on a widening cone, without detail. The
		// near samples resolve a deck's cells shading each other; far samples see the deck without
		// them. The cell texture's trilinear creases lie along the noise grid's axes; summed along
		// light paths and seen at grazing angles they read as lines converging on the horizon, so
		// distant view points (small `near`) drop the cells along their light paths as well.
		const lightDepth = ( xz: V2, altitude: F, near: F ) => {

			const depth = float( 0 ).toVar();
			const L = this.lightDir;
			let travelled = 0;
			for ( const step of [ 60, 140, 300, 600, 1200, 2400 ] ) {

				const t = travelled + step * 0.5;
				const cells = step < 600 ? near : float( 0 );
				depth.addAssign( densityAt( xz.add( L.xz.mul( t ) ), altitude.add( L.y.mul( t ) ), false, cells ).mul( step ) );
				travelled += step;

			}
			return depth.mul( SIGMA );

		};

		// Distant rain below the cloud base: grey curtains where the clouds above are raining.
		// Showers also fall from the heaviest clumps of a cloudy sky. Streaks follow the fall,
		// so curtains read as vertical strands that fade out before reaching the sea.
		const rainShafts = ( direction: V3, cloudBase: F, light: V3 ) => {


			const radiance = vec3( 0 ).toVar();
			const through = float( 1 ).toVar();
			// Rain under a cloud is lit by the shaded base above it: a dull, neutral grey.
			const grey = mix( light, vec3( dot( light, vec3( 0.2126, 0.7152, 0.0722 ) ) ), 0.75 ).mul( 0.4 ).toVar();
			const start = float( 1500 ), end = min( cloudBase, 32000 ).toVar();
			If( end.greaterThan( start ), () => {

				for ( let i = 0; i < 8; i ++ ) {

					// Logarithmic spacing: curtains a few kilometres off are resolved, far ones merge.
					const a = Math.pow( i / 8, 1.6 ), b = Math.pow( ( i + 1 ) / 8, 1.6 );
					const t = start.add( end.sub( start ).mul( ( a + b ) / 2 ) ).toVar();
					const dt = end.sub( start ).mul( b - a );
					const xz = this.origin.xz.add( direction.xz.mul( t ) ).toVar();
					const altitude = this.origin.y.add( direction.y.mul( t ) );
					const reached = clamp( this.frontProgress.add( dot( xz, this.frontAxis ).div( FRONT_SPAN ) ), 0, 1 );
					const cov = clamp( mix( this.coverageFrom, this.coverageTo, reached ), 0, 1 );
					const rain = mix( this.rainFrom, this.rainTo, reached );
					const p = xz.add( this.windOffset );
					const w = weatherNode.sample( p.div( WEATHER_TILE ) ).level( float( 0 ) );
					// The thickest part of each clump, well inside its cloud edge.
					const core = smoothstep( coverThreshold( cov ).add( 0.1 ), coverThreshold( cov ).add( 0.28 ), w.r );
					const showers = smoothstep( 0.5, 0.7, cov ).mul( core );
					const heavy = max( rain.mul( core.mul( 0.6 ).add( 0.4 ) ), showers );
					// Vertical strands, slanted slightly downwind, broken up along their length.
					// Few samples per ray: keep the strands broad so they do not alias into a barcode.
					const strands = shapeNode.sample( vec3( p.x.mul( 1 / 2600 ), altitude.mul( 1 / 6000 ).add( this.evolve.mul( 0.0001 ) ), p.y.mul( 1 / 2600 ) ) ).level( float( 0 ) ).g;
					const below = float( 1 ).sub( smoothstep( LAYER_BOTTOM * 0.7, LAYER_BOTTOM * 1.2, altitude ) );
					const density = heavy.mul( strands.mul( 0.9 ).add( 0.35 ) ).mul( below ).mul( 0.00035 );
					const step = exp( density.mul( dt ).negate() );
					radiance.addAssign( grey.mul( through ).mul( float( 1 ).sub( step ) ) );
					through.mulAssign( step );

				}

			} );
			return vec4( radiance, through );

		};

		// Thin ice cloud about eight kilometres up: fibrous streaks drawn out along the wind, very
		// bright toward the sun (strong forward scattering from ice crystals), and golden or pink
		// when the sun is low. Returns scattered radiance and transmittance like the cumulus.
		const cirrusVeil = ( direction: V3 ) => {

			const result = vec4( 0, 0, 0, 1 ).toVar();
			If( this.cirrus.greaterThan( 0.01 ).and( direction.y.greaterThan( 0.02 ) ), () => {

				const t = float( 8000 ).div( direction.y ).toVar();
				const p = direction.xz.mul( t ).add( this.windOffset.mul( 1.6 ) ).toVar();
				const w = this.cirrusAxis;
				const along = dot( p, w ).toVar();
				// Shear in the upper wind bends the strands into long, gentle curves.
				const sideways = dot( p, vec2( w.y.negate(), w.x ) ).toVar();
				const bend = weatherNode.sample( vec2( along.div( 30000 ), sideways.div( 12000 ) ).add( 0.71 ) ).level( float( 0 ) ).g.sub( 0.5 ).mul( 7000 )
					.add( weatherNode.sample( vec2( along.div( 9000 ), sideways.div( 5000 ) ).add( 0.29 ) ).level( float( 0 ) ).b.sub( 0.5 ).mul( 900 ) );
				const across = sideways.add( bend ).toVar();
				// Patches of veil a few tens of kilometres long, combed into fibres along the wind.
				// The weather field's known distribution sets how much of the sky the veil covers.
				const broad = weatherNode.sample( vec2( along.div( 96000 ), across.div( 30000 ) ).add( 0.37 ) ).level( float( 0 ) ).r;
				// Fine strands a few hundred metres apart, sharp across and drawn out along the wind.
				const fibres = shapeNode.sample( vec3( along.div( 9000 ), 0.71, across.div( 420 ) ) ).level( float( 0 ) ).r;
				const fine = detailNode.sample( vec3( along.div( 2500 ), 0.23, across.div( 150 ) ) ).level( float( 0 ) ).r;
				const strands = smoothstep( 0.5, 0.78, fibres.mul( 0.75 ).add( fine.mul( 0.25 ) ) );
				// Tufts: strands thicken into heads here and there and trail off thin between them.
				const heads = smoothstep( 0.35, 0.8, detailNode.sample( vec3( along.div( 6000 ), 0.53, across.div( 1200 ) ) ).level( float( 0 ) ).g );
				const amount = this.cirrus;
				const edge = coverThreshold( amount.mul( 0.6 ) ).toVar();
				const veil = smoothstep( edge.sub( 0.05 ), edge.add( 0.12 ), broad );
				const opacity = veil.mul( strands ).mul( heads.mul( 0.6 ).add( 0.4 ) ).mul( 0.4 ).mul( smoothstep( 0.02, 0.15, direction.y ) ).toVar();
				// Ice scatters strongly forward, but a thin veil only brightens near the sun; it does
				// not turn into a white blaze around it.
				const cosine = dot( direction, this.lightDir );
				const forward = float( 0.64 ).div( float( 1.36 ).sub( cosine.mul( 1.2 ) ).pow( 1.5 ).mul( 4 * Math.PI ) );
				// The veil passes most of the sky behind it on, scattered rather than absorbed.
				result.assign( vec4( this.lightColor.rgb.mul( forward.mul( 0.25 ).add( 0.06 ) ).mul( this.directGain ).mul( opacity ), float( 1 ).sub( opacity.mul( 0.12 ) ) ) );

			} );
			return result;

		};

		const march = Fn( ( [ direction, jitter ]: [ V3, F ] ) => {

			const result = vec4( 0, 0, 0, 1 ).toVar();
			If( direction.y.greaterThan( 0 ).and( this.coverage.greaterThan( 0.001 ) ), () => {

				const h = this.origin.y.toVar();
				const t0 = layerDistance( h, direction.y, float( LAYER_BOTTOM ) ).toVar();
				const t1 = layerDistance( h, direction.y, float( LAYER_TOP ) ).toVar();
				const span = min( t1.sub( t0 ), MAX_SPAN ).toVar();
				// Grazing rays cross far more of the layer; give them more, still bounded, steps.
				const steps = clamp( this.quality.mul( span.div( MAX_SPAN ).mul( 0.7 ).add( 1 ) ), 8, MAX_STEPS ).floor().toVar();
				// Steps grow quadratically: a cloud is opaque within a few tens of metres, so fine steps
				// where the ray enters the layer resolve its surface, and coarse ones suffice beyond.
				const inverseSteps = float( 1 ).div( steps ).toVar();
				const cosTheta = dot( direction, this.lightDir ).toVar();
				// Two lobes: a forward silver lining and a soft back-scatter for the shaded side.
				const phases = [ 1, 0.5, 0.25 ].map( ( c ) =>
					mix( henyeyGreenstein( cosTheta, - 0.25 * c ), henyeyGreenstein( cosTheta, 0.7 * c ), 0.7 ).toVar() );
				// Sky light on the tops, the sea's bounce on the bases. Shaded sides face away from the
				// sun, so they take the cooler sky opposite it (violet at sunset), not its warm glow.
				const skyLight = this.atmosphere.skyRadiance( vec3( 0, 1, 0 ) ).mul( 0.5 )
					.add( this.atmosphere.skyRadiance( normalize( vec3( this.lightDir.x.negate(), 0.15, this.lightDir.z.negate() ) ) ).mul( 0.3 ) )
					.add( this.nightAmbient.rgb ).toVar();
				const deck = smoothstep( 0.7, 0.95, this.coverage ).toVar();
				const transmittance = float( 1 ).toVar();
				const scattered = vec3( 0 ).toVar();
				Loop( MAX_STEPS, ( { i } ) => {

					If( float( i ).greaterThanEqual( steps ).or( transmittance.lessThan( 0.01 ) ), () => {

						Break();

					} );
					const u = float( i ).add( jitter ).mul( inverseSteps ).toVar();
					const t = t0.add( span.mul( u ).mul( u ) ).toVar();
					const dt = span.mul( u.mul( 2 ).add( inverseSteps ) ).mul( inverseSteps ).toVar();
					const altitude = altitudeAt( h, direction.y, t ).toVar();
					const xz = this.origin.xz.add( direction.xz.mul( t ) ).toVar();
					const near = float( 1 ).sub( smoothstep( 3500, 13000, t ) ).toVar();
					const d = densityAt( xz, altitude, true, near ).toVar();
					If( d.greaterThan( 0.0005 ), () => {

						const od = lightDepth( xz, altitude, near ).toVar();
						// Scattering octaves: each one less extinguished and less forward. A thick cloud
						// returns most of its light after many bounces, several times the single
						// scattering a phase function alone predicts at side angles.
						const sun = phases[ 0 ].mul( exp( od.negate() ) )
							.add( phases[ 1 ].mul( exp( od.mul( - 0.5 ) ) ).mul( 0.5 ) )
							.add( phases[ 2 ].mul( exp( od.mul( - 0.25 ) ) ).mul( 0.25 ) ).mul( MULTIPLE_SCATTERING );
						// Bright where the cloud is thin toward the light, dark inside thick heaps.
						const powder = float( 1 ).sub( exp( d.mul( - 6 ) ) ).mul( 0.6 ).add( 0.4 );
						const heightShade = clamp( altitude.sub( LAYER_BOTTOM ).div( 2600 ), 0, 1 ).toVar();
						// A closed deck shades its own interior from the sky above it.
						const ambient = mix( this.seaBounce.rgb.add( skyLight.mul( 0.25 ) ), skyLight, heightShade ).mul( mix( float( 1 ), float( 0.5 ), deck ) );
						// Under a closed deck light arrives diffused rather than along the beam: two-stream
						// transmission 1 / (1 + 0.75 (1 - g) tau) with g = 0.85, spread over 4 pi, beyond
						// what the octaves carry. Separate heaps keep their contrast from the octaves alone.
						// Many bounces also wash out the beam's colour.
						// Heavier rain decks (higher density) pass less, colder light.
						const diffuse = max( float( 1 ).div( od.mul( 0.11 ).add( 1 ) ).sub( exp( od.mul( - 0.25 ) ) ), 0 )
							.mul( deck.mul( 1 / ( 4 * Math.PI ) ) ).div( max( this.density, 0.5 ).sqrt() );
						const neutral = mix( this.lightColor.rgb, vec3( dot( this.lightColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) ).mul( vec3( 0.94, 0.98, 1.06 ) ), mix( float( 0.6 ), float( 0.9 ), deck ) );
						const radiance = this.lightColor.rgb.mul( sun ).mul( powder ).mul( this.directGain ).add( neutral.mul( diffuse ) ).add( ambient.mul( this.ambientGain ) );
						const stepTransmittance = exp( d.mul( - SIGMA ).mul( dt ) );
						scattered.addAssign( radiance.mul( transmittance ).mul( float( 1 ).sub( stepTransmittance ) ) );
						transmittance.mulAssign( stepTransmittance );

					} );

				} );
				// Air between the viewer and distant clouds: they take the clear sky's colour. A closed
				// deck reaches the horizon instead of opening onto a bright clear band beneath it.
				const fade = mix( exp( max( t0.sub( 12000 ), 0 ).div( - 38000 ) ), float( 1 ), deck );
				const horizon = mix( smoothstep( 0, 0.035, direction.y ), float( 1 ), deck ).mul( fade );
				const haze = this.atmosphere.skyRadiance( direction ).add( this.nightAmbient.rgb ).mul( float( 1 ).sub( transmittance ) );
				const cloudRadiance = mix( haze, scattered, horizon ).toVar();
				const cloudThrough = mix( float( 1 ), transmittance, mix( smoothstep( 0, 0.02, direction.y ), float( 1 ), deck ) ).toVar();
				// High cirrus behind the cumulus; rain shafts hang below the cloud base in front.
				const veil = cirrusVeil( direction ).toVar();
				// Curtains fade into the haze with the clouds they fall from; otherwise showers far off
				// under a broken sky hang as grey blocks on the horizon below clouds already lost in it.
				const rain = rainShafts( direction, t0, skyLight );
				const shafts = vec4( rain.rgb.mul( horizon ), mix( float( 1 ), rain.a, horizon ) ).toVar();
				const layered = vec4( cloudRadiance.add( veil.rgb.mul( cloudThrough ) ), cloudThrough.mul( veil.a ) );
				result.assign( vec4( shafts.rgb.add( layered.rgb.mul( shafts.a ) ), layered.a.mul( shafts.a ) ) );

			} );
			// A clear sky can still carry cirrus.
			If( direction.y.greaterThan( 0 ).and( this.coverage.lessThanEqual( 0.001 ) ), () => {

				result.assign( cirrusVeil( direction ) );

			} );
			return result;

		} );

		const domeTexel = ( x: THREE.Node<'uint'>, y: THREE.Node<'uint'> ) => {

			const q = vec2( float( x ).add( 0.5 ).div( DOME_WIDTH ), float( y ).add( 0.5 ).div( DOME_HEIGHT ) );
			// A fixed, unstructured per-texel offset breaks step banding; the sampling tent filter
			// averages it out. (A structured pattern shows up as hatching on grazing rays.)
			const jitter = fract( sin( dot( vec2( float( x ), float( y ) ), vec2( 12.9898, 78.233 ) ) ).mul( 43758.5453 ) );
			textureStore( this.dome, ivec2( int( x ), int( y ) ), march( domeToDirection( q ), jitter ) );

		};
		const columns = DOME_WIDTH / STRIDE;
		this.partialKernel = Fn( () => {

			const x = instanceIndex.mod( uint( columns ) ).mul( uint( STRIDE ) ).add( uint( this.phase.x ) );
			const y = instanceIndex.div( uint( columns ) ).mul( uint( STRIDE ) ).add( uint( this.phase.y ) );
			domeTexel( x, y );

		} )().compute( DOME_WIDTH * DOME_HEIGHT / ( STRIDE * STRIDE ), [ 64 ] ).setName( 'Clouds.DomePartial' );

		this.shadowKernel = Fn( () => {

			const n = uint( SHADOW_SIZE );
			const x = instanceIndex.mod( n ), y = instanceIndex.div( n );
			const ground = vec2( float( x ), float( y ) ).add( 0.5 ).div( SHADOW_SIZE ).sub( 0.5 ).mul( SHADOW_SPAN ).toVar();
			const L = this.lightDir;
			const visibility = float( 1 ).toVar();
			If( L.y.greaterThan( 0.02 ), () => {

				const t0 = float( LAYER_BOTTOM ).div( L.y ).toVar();
				const span = min( float( LAYER_TOP - LAYER_BOTTOM ).div( L.y ), 12000 ).toVar();
				const depth = float( 0 ).toVar();
				Loop( 12, ( { i } ) => {

					const t = t0.add( float( i ).add( 0.5 ).mul( span ).div( 12 ) );
					depth.addAssign( densityAt( ground.add( L.xz.mul( t ) ), L.y.mul( t ), false ) );

				} );
				visibility.assign( exp( depth.mul( span ).div( 12 ).mul( - SIGMA ) ) );

			} );
			textureStore( this.shadowMap, ivec2( int( x ), int( y ) ), vec4( visibility ) );

		} )().compute( SHADOW_SIZE * SHADOW_SIZE, [ 64 ] ).setName( 'Clouds.Shadow' );

	}

	/** Refreshes part of the dome (or all of it after a jump) and the whole shadow map. */
	update( renderer: THREE.WebGPURenderer, viewer: THREE.Vector3 ): void {

		if ( ! this.partialKernel || ! this.shadowKernel ) return;
		this.origin.value.copy( viewer );
		// A 4 x 4 ordered pattern spreads each frame's texels evenly over the map. A full refresh
		// runs all sixteen phases through the same kernel, so every texel always comes from one
		// compiled program and a refreshed map matches a progressively updated one exactly.
		const order = [ 0, 10, 2, 8, 5, 15, 7, 13, 1, 11, 3, 9, 4, 14, 6, 12 ];
		const phases = this.needsFull ? order : [ order[ this.frame ++ % 16 ] ];
		this.needsFull = false;
		for ( const k of phases ) {

			this.phase.value.set( k % STRIDE, Math.floor( k / STRIDE ) );
			renderer.compute( this.partialKernel );

		}
		renderer.compute( this.shadowKernel );

	}

	/** The next update recomputes the whole map, e.g. after a jump in time or weather. */
	invalidate(): void { this.needsFull = true; }

	/** In-scattered radiance (rgb) and transmittance (a) of the clouds in a direction. A small
	 * tent filter over four bilinear taps hides the per-texel march offsets. */
	sample( direction: V3 ): V4 {

		const q = directionToDome( direction ).toVar();
		const texel = vec2( 0.5 / DOME_WIDTH, 0.5 / DOME_HEIGHT );
		const tap = ( x: number, y: number ) => texture( this.dome, q.add( texel.mul( vec2( x, y ) ) ) ).level( float( 0 ) );
		return tap( - 1, - 1 ).add( tap( 1, - 1 ) ).add( tap( - 1, 1 ) ).add( tap( 1, 1 ) ).mul( 0.25 );

	}

	/** Direct-light visibility under the clouds at a world position. */
	shadow( worldPosition: V3 ): F {

		const q = worldPosition.xz.div( SHADOW_SPAN ).add( 0.5 );
		return texture( this.shadowMap, q ).level( float( 0 ) ).r;

	}

	setWindOffset( offset: THREE.Vector2 ): void {

		const wrap = ( v: number ) => v - WRAP * Math.round( v / WRAP );
		this.windOffset.value.set( wrap( offset.x ), wrap( offset.y ) );

	}

	dispose(): void {

		this.dome.dispose();
		this.shadowMap.dispose();
		if ( this.noise ) for ( const t of [ this.noise.shape, this.noise.detail, this.noise.weather ] ) t.dispose();

	}

}
