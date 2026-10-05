import * as THREE from 'three/webgpu';
import {
	Fn, If, uniform, vec2, vec3, float, floor, fract, sin, dot, cross, atan,
	normalize, length, fwidth, abs, clamp, max, min, mix, pow, smoothstep, exp, sqrt, select, acos,
} from 'three/tsl';
import { SCENE_RADIANCE_SCALE, SUN_DISPLAY_RADIUS } from '../lighting/Radiometry.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

// As wide as the displayed sun, as in reality; both are drawn at twice their true size.
export const MOON_ANGULAR_RADIUS = SUN_DISPLAY_RADIUS;

const nightHash = Fn( ( [ p ]: [ V2 ] ) => {

	return fract( sin( dot( p, vec2( 153.71, 61.39 ) ) ).mul( 39241.173 ) );

} ).setLayout( { name: 'soomiNightHash', type: 'float', inputs: [ { name: 'p', type: 'vec2' } ] } );

const nightNoise = Fn( ( [ p ]: [ V2 ] ) => {

	const cell = floor( p ).toVar();
	const f = fract( p ).toVar();
	const w = f.mul( f ).mul( float( 3 ).sub( f.mul( 2 ) ) ).toVar();
	return mix( mix( nightHash( cell ), nightHash( cell.add( vec2( 1, 0 ) ) ), w.x ),
		mix( nightHash( cell.add( vec2( 0, 1 ) ) ), nightHash( cell.add( vec2( 1, 1 ) ) ), w.x ), w.y );

} ).setLayout( { name: 'soomiNightNoise', type: 'float', inputs: [ { name: 'p', type: 'vec2' } ] } );

const hash3 = Fn( ( [ p ]: [ V3 ] ) => {

	return fract( sin( dot( p, vec3( 127.1, 311.7, 74.7 ) ) ).mul( 43758.5453 ) );

} ).setLayout( { name: 'soomiNightHash3', type: 'float', inputs: [ { name: 'p', type: 'vec3' } ] } );

// Value noise on the celestial sphere, for the Milky Way's clouds and dust lanes.
const noise3 = Fn( ( [ p ]: [ V3 ] ) => {

	const i = floor( p ).toVar();
	const f = fract( p ).toVar();
	const w = f.mul( f ).mul( float( 3 ).sub( f.mul( 2 ) ) ).toVar();
	const at = ( x: number, y: number, z: number ) => hash3( i.add( vec3( x, y, z ) ) );
	return mix(
		mix( mix( at( 0, 0, 0 ), at( 1, 0, 0 ), w.x ), mix( at( 0, 1, 0 ), at( 1, 1, 0 ), w.x ), w.y ),
		mix( mix( at( 0, 0, 1 ), at( 1, 0, 1 ), w.x ), mix( at( 0, 1, 1 ), at( 1, 1, 1 ), w.x ), w.y ), w.z );

} ).setLayout( { name: 'soomiNightNoise3', type: 'float', inputs: [ { name: 'p', type: 'vec3' } ] } );

// Galactic plane and centre in the celestial frame. At midnight the band arches from the
// horizon review view's sky, with its bright centre 35 degrees up, across near the zenith.
const GALACTIC_NORMAL = new THREE.Vector3( - 0.0331, 0.8106, - 0.5846 ).normalize();
const GALACTIC_CENTRE = new THREE.Vector3( 0.5864, - 0.4580, - 0.6681 ).projectOnPlane( GALACTIC_NORMAL ).normalize();

// Brightness of the Milky Way (0 to about 1): a soft band, brighter toward the centre, broken
// into grainy star clouds and split along its length by a dark rift and scattered dark clouds.
// `fine` is 0 for blurred lookups (reflections, bakes), which skip the small-scale structure.
const milkyWay = Fn( ( [ c, fine ]: [ V3, F ] ) => {

	const n = vec3( GALACTIC_NORMAL.x, GALACTIC_NORMAL.y, GALACTIC_NORMAL.z );
	const g = vec3( GALACTIC_CENTRE.x, GALACTIC_CENTRE.y, GALACTIC_CENTRE.z );
	const latitude = dot( c, n ).toVar();
	const core = pow( max( dot( c, g ), 0 ), 3 ).toVar();
	// The band's edges wander, so it reads as clouds of stars rather than a painted stripe.
	const edge = noise3( c.mul( 5 ).add( 9.1 ) ).sub( 0.5 ).mul( 0.05 );
	const width = mix( float( 0.09 ), float( 0.19 ), core ).add( edge );
	const band = exp( latitude.mul( latitude ).div( width.mul( width ) ).mul( - 0.5 ) ).toVar();
	const result = float( 0 ).toVar();
	// The structure costs a dozen noise lookups; most of the sky lies outside the band.
	If( band.greaterThan( 0.004 ), () => {

		const clouds = noise3( c.mul( 7 ) ).mul( 0.5 ).add( noise3( c.mul( 17 ).add( 3.1 ) ).mul( 0.35 ) ).add( 0.075 ).toVar();
		// The rift runs the band's length a little off its centre line, wandering and widening.
		const offset = latitude.sub( 0.012 ).add( noise3( c.mul( 5 ).add( 2.2 ) ).sub( 0.5 ).mul( 0.06 ) ).toVar();
		const riftWidth = mix( float( 0.006 ), float( 0.03 ), noise3( c.mul( 3.5 ).add( 5.3 ) ) ).toVar();
		const shade = float( 1 ).toVar();
		If( fine.greaterThan( 0.5 ), () => {

			clouds.addAssign( noise3( c.mul( 41 ).add( 7.7 ) ).sub( 0.5 ).mul( 0.15 ).add( noise3( c.mul( 97 ).add( 1.3 ) ).sub( 0.5 ).mul( 0.1 ) ) );
			// Unresolved stars: a fine mottling over the clouds.
			shade.assign( noise3( c.mul( 130 ).add( 4.4 ) ).mul( 0.6 ).add( noise3( c.mul( 270 ).add( 8.8 ) ).mul( 0.4 ) ).mul( 0.35 ).add( 0.82 ) );
			offset.addAssign( noise3( c.mul( 17 ).add( 6.1 ) ).sub( 0.5 ).mul( 0.02 ) );
			// The rift breaks into patches; smaller dark clouds lie scattered over the band.
			const rift = exp( offset.mul( offset ).div( riftWidth.mul( riftWidth ) ).mul( - 0.5 ) )
				.mul( smoothstep( 0.2, 0.65, noise3( c.mul( 9 ).add( 1.7 ) ) ).mul( 0.75 ).add( 0.25 ) );
			const patches = smoothstep( 0.58, 0.82, noise3( c.mul( 13 ).add( 3.3 ) ) ).mul( smoothstep( 0.35, 0.75, noise3( c.mul( 31 ).add( 7.2 ) ) ) );
			shade.mulAssign( float( 1 ).sub( max( rift.mul( 0.7 ), patches.mul( 0.4 ) ) ) );

		} ).Else( () => {

			shade.assign( float( 1 ).sub( exp( offset.mul( offset ).div( riftWidth.mul( riftWidth ) ).mul( - 0.5 ) ).mul( 0.45 ) ) );

		} );
		result.assign( band.mul( clouds.mul( 0.85 ).add( 0.15 ) ).mul( core.mul( 1.6 ).add( 0.45 ) ).mul( shade ) );

	} );
	return result;

} ).setLayout( { name: 'soomiMilkyWay', type: 'float', inputs: [ { name: 'c', type: 'vec3' }, { name: 'fine', type: 'float' } ] } );

// Footprint (radians across a pixel's derivative) at which a baked star carries the energy of a
// star drawn on screen. On screen a star stays a fixed fraction of a pixel wide and keeps its
// brightness at any resolution or zoom, as the eye sees a point; bakes conserve its energy.
const STAR_REFERENCE_FOOTPRINT = 0.0015;
// Star image width in footprints: a little under a pixel, wide enough that a star drifting with
// the sky's rotation keeps its brightness as it crosses pixels instead of shimmering.
const STAR_WIDTH = 0.5;

// One layer of stars on the faces of a cube around the celestial sphere: at most one star per
// cell, kept away from the cell's edges, so a direction only ever needs its own cell. Brightness
// follows the sky's own statistics: every magnitude brighter holds about a third as many stars,
// so most are faint and a few dozen stand out. `faintest` is the dimmest star's peak and `range`
// how many times brighter the brightest may be.
const starLayer = ( c: V3, footprint: F, conserve: boolean, cells: number, occupancy: F, seed: number, faintest: number, range: number, time: F, elevation: F ) => {

	const radiance = vec3( 0 ).toVar();
	const a = abs( c ).toVar();
	const xMajor = a.x.greaterThanEqual( a.y ).and( a.x.greaterThanEqual( a.z ) );
	const yMajor = a.y.greaterThanEqual( a.z );
	// Face index and in-face coordinates in [-1, 1].
	const face = select( xMajor, select( c.x.greaterThan( 0 ), float( 0 ), float( 1 ) ),
		select( yMajor, select( c.y.greaterThan( 0 ), float( 2 ), float( 3 ) ), select( c.z.greaterThan( 0 ), float( 4 ), float( 5 ) ) ) ).toVar();
	const major = select( xMajor, a.x, select( yMajor, a.y, a.z ) );
	const uv = select( xMajor, c.zy, select( yMajor, c.xz, c.xy ) ).div( major ).toVar();
	const cell = floor( uv.mul( 0.5 ).add( 0.5 ).mul( cells ) ).toVar();
	const key = cell.add( vec2( face.mul( 1031 ).add( seed ), face.mul( 557 ).sub( seed ) ) ).toVar();
	If( nightHash( key ).lessThan( occupancy ), () => {

		const jitter = vec2( nightHash( key.add( vec2( 29.3, 71.7 ) ) ), nightHash( key.add( vec2( 83.1, 17.6 ) ) ) ).mul( 0.6 ).add( 0.2 );
		const st = cell.add( jitter ).div( cells ).mul( 2 ).sub( 1 ).toVar();
		const onFace = select( xMajor, vec3( select( c.x.greaterThan( 0 ), float( 1 ), float( - 1 ) ), st.y, st.x ),
			select( yMajor, vec3( st.x, select( c.y.greaterThan( 0 ), float( 1 ), float( - 1 ) ), st.y ),
				vec3( st.x, st.y, select( c.z.greaterThan( 0 ), float( 1 ), float( - 1 ) ) ) ) );
		const starDir = normalize( onFace );
		// Counts grow by about 2.8 per magnitude, so the brightness of a uniform draw u is u^-0.9.
		const draw = max( nightHash( key.add( vec2( 41.7, 113.9 ) ) ), 1e-4 ).toVar();
		const brightness = min( pow( draw, - 0.9 ), range ).mul( faintest ).toVar();
		const variance = footprint.mul( footprint ).mul( STAR_WIDTH * STAR_WIDTH ).toVar();
		const separation = c.sub( starDir ).toVar();
		const profile = exp( dot( separation, separation ).div( variance ).mul( - 0.5 ) ).toVar();
		if ( conserve ) profile.mulAssign( float( STAR_REFERENCE_FOOTPRINT * STAR_REFERENCE_FOOTPRINT * STAR_WIDTH * STAR_WIDTH ).div( variance ) );
		const temperature = nightHash( key.add( vec2( 197.1, 7.3 ) ) ).toVar();
		const color = mix( mix( vec3( 1, 0.72, 0.5 ), vec3( 1, 0.95, 0.88 ), smoothstep( 0, 0.35, temperature ) ),
			vec3( 0.7, 0.82, 1 ), smoothstep( 0.55, 1, temperature ) );
		// Only low stars scintillate, seen through the thick air near the horizon: an irregular
		// flicker, not a steady pulse; high stars burn steadily.
		const flicker = nightNoise( vec2( time.mul( 2.3 ).add( temperature.mul( 57 ) ), draw.mul( 91 ) ) ).sub( 0.5 );
		const twinkle = flicker.mul( float( 1 ).sub( smoothstep( 0.02, 0.2, elevation ) ) ).mul( 0.4 ).add( 1 );
		radiance.assign( color.mul( brightness ).mul( profile ).mul( twinkle ) );

	} );
	return radiance;

};

// The near side as seen from the northern hemisphere, north up, in disk units: the major maria
// (centre x, y, radii) and the brightest young craters (centre, radius, brightness). Positions
// are approximate, read from the well-known face of the full moon.
const MARIA: ReadonlyArray<readonly [ number, number, number, number ]> = [
	[ - 0.6, 0.15, 0.28, 0.42 ], // Oceanus Procellarum
	[ - 0.25, 0.55, 0.26, 0.2 ], // Mare Imbrium
	[ 0.25, 0.43, 0.15, 0.14 ], // Mare Serenitatis
	[ 0.4, 0.14, 0.19, 0.15 ], // Mare Tranquillitatis
	[ 0.68, 0.28, 0.11, 0.09 ], // Mare Crisium
	[ 0.58, - 0.12, 0.13, 0.17 ], // Mare Fecunditatis
	[ 0.38, - 0.27, 0.09, 0.09 ], // Mare Nectaris
	[ - 0.18, - 0.35, 0.17, 0.13 ], // Mare Nubium
	[ - 0.5, - 0.38, 0.09, 0.09 ], // Mare Humorum
	[ - 0.3, 0.02, 0.12, 0.1 ], // Mare Cognitum and Insularum
	[ 0.04, 0.25, 0.08, 0.06 ], // Mare Vaporum
	[ 0.05, 0.78, 0.42, 0.07 ], // Mare Frigoris
];
const CRATERS: ReadonlyArray<readonly [ number, number, number, number ]> = [
	[ - 0.1, - 0.68, 0.035, 0.45 ], // Tycho
	[ - 0.28, 0.17, 0.03, 0.3 ], // Copernicus
	[ - 0.66, 0.38, 0.016, 0.5 ], // Aristarchus
	[ - 0.45, 0.13, 0.016, 0.25 ], // Kepler
];

// Relative albedo of the lunar surface at a disk position: dark maria with soft, broken shores,
// bright highlands and young craters, and Tycho's faint ray system.
const lunarAlbedo = Fn( ( [ q ]: [ V2 ] ) => {

	const shore = nightNoise( q.mul( 7 ).add( vec2( 3.1, 7.7 ) ) ).sub( 0.5 ).mul( 0.5 )
		.add( nightNoise( q.mul( 19 ).add( vec2( 8.3, 1.2 ) ) ).sub( 0.5 ).mul( 0.25 ) ).toVar();
	// Neighbouring maria flow into each other: sum their soft footprints, then threshold.
	const field = float( 0 ).toVar();
	for ( const [ x, y, rx, ry ] of MARIA ) {

		const e = q.sub( vec2( x, y ) ).div( vec2( rx * 1.2, ry * 1.2 ) );
		field.addAssign( float( 1 ).sub( smoothstep( 0.45, 1.25, length( e ).add( shore ) ) ) );

	}
	const mare = smoothstep( 0.25, 0.75, field ).toVar();
	const texture = nightNoise( q.mul( 6.7 ).add( vec2( 23.4, 3.9 ) ) ).mul( 0.6 ).add( nightNoise( q.mul( 17 ).add( vec2( 3.4, 9.9 ) ) ).mul( 0.4 ) );
	// Maria are not uniform: lighter and darker lava flows within them.
	const albedo = mix( float( 0.92 ), mix( float( 0.52 ), float( 0.66 ), texture ), mare ).mul( texture.sub( 0.5 ).mul( 0.12 ).add( 1 ) ).toVar();
	for ( const [ x, y, r, brightness ] of CRATERS ) {

		albedo.addAssign( float( 1 ).sub( smoothstep( r * 0.5, r * 1.6, length( q.sub( vec2( x, y ) ) ) ) ).mul( brightness ) );

	}
	// Tycho's rays: narrow radial streaks that fade with distance from the crater.
	const fromTycho = q.sub( vec2( - 0.1, - 0.68 ) ).toVar();
	const spokes = smoothstep( 0.7, 0.95, nightNoise( vec2( atan( fromTycho.y, fromTycho.x ).mul( 9 ), 1.7 ) ) );
	albedo.addAssign( spokes.mul( float( 1 ).sub( smoothstep( 0.05, 0.9, length( fromTycho ) ) ) ).mul( 0.18 ) );
	return albedo;

} ).setLayout( { name: 'soomiLunarAlbedo', type: 'float', inputs: [ { name: 'q', type: 'vec2' } ] } );

const nightMoon = Fn( ( [ direction, footprint, sunDir, moonDir, moonColor ]: [ V3, F, V3, V3, V3 ] ) => {

	const radiance = vec3( 0 ).toVar();
	const facing = dot( direction, moonDir ).toVar();
	const tangent = direction.sub( moonDir.mul( facing ) ).div( MOON_ANGULAR_RADIUS ).toVar();
	const radius = length( tangent ).toVar();
	const edgeWidth = max( footprint.div( MOON_ANGULAR_RADIUS ).mul( 0.65 ), 0.008 ).toVar();
	If( facing.greaterThan( 0 ).and( radius.lessThan( float( 1 ).add( edgeWidth ) ) ), () => {

		const disk = float( 1 ).sub( smoothstep( float( 1 ).sub( edgeWidth ), float( 1 ).add( edgeWidth ), radius ) );
		const depth = sqrt( max( float( 1 ).sub( radius.mul( radius ) ), 0 ) ).toVar();
		// The visible sphere normal faces the observer at the disk center. Its incidence
		// against the actual solar direction produces new, crescent, quarter, and full moon
		// with the terminator oriented toward the sun; no independently painted phase mask.
		const normal = normalize( tangent.sub( moonDir.mul( depth ) ) ).toVar();
		const incidence = dot( normal, sunDir ).toVar();
		const terminator = smoothstep( edgeWidth.mul( - 0.5 ), edgeWidth.mul( 0.5 ), incidence )
			.mul( pow( max( incidence, 0 ), 0.36 ) ).toVar();
		// The observer's right and up across the disk: lunar north stays up.
		const up = select( abs( moonDir.y ).greaterThan( 0.98 ), vec3( 0, 0, 1 ), vec3( 0, 1, 0 ) );
		const right = normalize( cross( moonDir, up ) ).toVar();
		const north = cross( right, moonDir ).toVar();
		const q = vec2( dot( tangent, right ), dot( tangent, north ) ).toVar();
		// The near side's maria and craters, with a faint limb darkening.
		const albedo = lunarAlbedo( q ).mul( mix( float( 0.85 ), float( 1 ), depth ) );
		const horizon = smoothstep( - MOON_ANGULAR_RADIUS, 0.015, direction.y );
		// At exact conjunction, roundoff in the tangent plane can leave a faint positive
		// incidence outside the antialiased rim. Suppress only this vanishing phase interval.
		const phase = smoothstep( 0, 0.0002, float( 1 ).sub( dot( sunDir, moonDir ) ).mul( 0.5 ) );
		radiance.assign( moonColor.mul( albedo ).mul( terminator ).mul( disk ).mul( horizon ).mul( phase ) );

	} );
	return radiance;

} ).setLayout( { name: 'soomiNightMoon', type: 'vec3', inputs: [
	{ name: 'direction', type: 'vec3' }, { name: 'footprint', type: 'float' },
	{ name: 'sunDir', type: 'vec3' }, { name: 'moonDir', type: 'vec3' }, { name: 'moonColor', type: 'vec3' },
] } );

// Forward scattering by haze around the moon: a tight aureole and a wide, faint halo, scaled
// by how much of the disk is lit.
const nightMoonGlow = Fn( ( [ direction, sunDir, moonDir, moonColor ]: [ V3, V3, V3, V3 ] ) => {

	const angle = acos( clamp( dot( direction, moonDir ), - 1, 1 ) ).toVar();
	const lit = float( 1 ).sub( dot( sunDir, moonDir ) ).mul( 0.5 );
	const glow = exp( angle.div( - 0.035 ) ).mul( 0.12 ).add( exp( angle.div( - 0.3 ) ).mul( 0.015 ) );
	return moonColor.mul( glow ).mul( lit ).mul( smoothstep( - 0.05, 0.05, moonDir.y ) );

} ).setLayout( { name: 'soomiNightMoonGlow', type: 'vec3', inputs: [
	{ name: 'direction', type: 'vec3' }, { name: 'sunDir', type: 'vec3' },
	{ name: 'moonDir', type: 'vec3' }, { name: 'moonColor', type: 'vec3' },
] } );

// Airglow: the upper atmosphere's own faint light, mostly the green 557.7 nm oxygen line from a
// layer about 100 km up. Seen through that thin shell it brightens toward the horizon (the van
// Rhijn factor) until extinction in the thick low air wins, so it peaks some 10 - 15 degrees up.
// After H. W. Jensen et al., "A Physically-Based Night Sky Model" (SIGGRAPH 2001); a bright moon
// halves it, as a-starry-sky (https://github.com/Dante83/a-starry-sky) does. Soft green, a faint
// band low on a clear moonless sky; zenith extinction per channel as at a clear sea-level site.
const AIRGLOW_SHELL = ( 6371 / ( 6371 + 100 ) ) ** 2;
const AIRGLOW_COLOR = new THREE.Vector3( 0.35, 1, 0.3 ).multiplyScalar( 0.0016 * SCENE_RADIANCE_SCALE );
const nightAirglow = Fn( ( [ direction, moonWash ]: [ V3, F ] ) => {

	const height = max( direction.y, 0 ).toVar();
	const vanRhijn = float( 1 ).div( sqrt( float( 1 ).sub( height.mul( height ).oneMinus().mul( AIRGLOW_SHELL ) ) ) );
	// Kasten and Young's (1989) air mass stays finite at the horizon.
	const elevation = float( 90 ).sub( acos( height ).mul( 180 / Math.PI ) );
	const airMass = float( 1 ).div( height.add( pow( elevation.add( 6.07995 ), - 1.6364 ).mul( 0.50572 ) ) );
	const transmittance = exp( vec3( 0.1, 0.17, 0.28 ).mul( airMass ).negate() );
	return vec3( AIRGLOW_COLOR.x, AIRGLOW_COLOR.y, AIRGLOW_COLOR.z ).mul( vanRhijn ).mul( transmittance )
		.mul( float( 1 ).sub( clamp( moonWash, 0, 1 ).mul( 0.5 ) ) );

} ).setLayout( { name: 'soomiNightAirglow', type: 'vec3', inputs: [ { name: 'direction', type: 'vec3' }, { name: 'moonWash', type: 'float' } ] } );

export class NightSky {

	readonly sunDir = uniform( new THREE.Vector3( 1, 0, 0 ) );
	readonly moonDir = uniform( new THREE.Vector3( - 1, 0, 0 ) );
	// Full illuminated disk radiance in scene units. Phase comes only from the directions.
	readonly moonColor = uniform( new THREE.Color( 0.035, 0.04, 0.0475 ) );
	readonly starVisibility = uniform( 0 );
	// World to celestial frame: the stars turn about the pole of the sun's own path.
	readonly frame = uniform( new THREE.Matrix3() );
	readonly time = uniform( 0 );
	// A bright moon's scattered light washes out the Milky Way and the faintest stars.
	readonly moonWash = uniform( 0 );
	// Strength of the haze glow around the moon (an art control; 0 leaves the bare disk).
	readonly glow = uniform( 1 );

	stars( direction: V3, angularFootprint?: F, visibility: F = this.starVisibility ): V3 {

		// The dome derives its pixel footprint before varying control flow. Reflection and
		// bake callers may supply a roughness/texel footprint explicitly, avoiding derivatives
		// in their branches. A separate bake visibility keeps future endpoints off the dome.
		const footprint = max( angularFootprint ?? length( fwidth( direction ) ), 1e-5 ).toVar();
		const conserve = angularFootprint !== undefined;
		const radiance = vec3( 0 ).toVar();
		const v = clamp( visibility, 0, 1 ).toVar();
		If( v.greaterThan( 0.0001 ), () => {

			const c = normalize( this.frame.mul( direction ) ).toVar();
			const band = milkyWay( c, float( conserve ? 0 : 1 ) ).toVar();
			const elevation = direction.y;
			// Bright scattered stars, a dense faint field thickening along the Milky Way, and the
			// band's own unresolved glow.
			// About five thousand stars on the whole sphere span six magnitudes; below them, a dense
			// field at the edge of visibility thickens along the Milky Way.
			const bright = starLayer( c, footprint, conserve, 64, float( 0.2 ), 0, 0.014, 160, this.time, elevation );
			const wash = clamp( this.moonWash, 0, 1 );
			const faint = starLayer( c, footprint, conserve, 180, band.mul( 0.5 ).add( 0.05 ), 17, 0.006, 3, this.time, elevation )
				.mul( float( 1 ).sub( wash.mul( 0.7 ) ) );
			const glow = mix( vec3( 0.62, 0.72, 1 ), vec3( 1, 0.86, 0.72 ), smoothstep( 0.5, 1.4, band ) ).mul( band ).mul( 0.03 )
				.mul( float( 1 ).sub( wash.mul( 0.88 ) ) );
			// Thick air near the horizon dims the stars and the band.
			const horizon = smoothstep( - 0.01, 0.12, elevation );
			radiance.assign( bright.add( faint ).add( glow ).mul( v ).mul( horizon ).mul( SCENE_RADIANCE_SCALE ) );

		} );
		return radiance;

	}

	/** 1 except over the moon's disk, which hides the stars behind it. */
	moonOcclusion( direction: V3 ): F {

		const facing = dot( direction, this.moonDir );
		const radius = length( direction.sub( this.moonDir.mul( facing ) ) ).div( MOON_ANGULAR_RADIUS );
		return select( facing.greaterThan( 0 ), smoothstep( 0.98, 1.06, radius ), float( 1 ) );

	}

	moon( direction: V3 ): V3 {

		const footprint = max( length( fwidth( direction ) ), 1e-5 ).toVar();
		return nightMoon( direction, footprint, this.sunDir, this.moonDir, this.moonColor.rgb )
			.add( nightMoonGlow( direction, this.sunDir, this.moonDir, this.moonColor.rgb ).mul( this.glow ) );

	}

	/** The night sky's faint glow of its own, fading with twilight, moonlight and cloud like the stars. */
	airglow( direction: V3, visibility: F = this.starVisibility ): V3 {

		return nightAirglow( direction, this.moonWash ).mul( clamp( visibility, 0, 1 ) );

	}

}
