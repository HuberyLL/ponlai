/*!
 * The lunar disk is adapted from three-geospatial by Shota Matsuda
 * (https://github.com/takram-design-engineering/three-geospatial).
 * Copyright (c) 2024 Shota Matsuda
 * Licensed under the MIT License; see ./three-geospatial.LICENSE.txt.
 *
 * Earthshine is adapted from a-starry-sky by David Evans (https://github.com/Dante83/a-starry-sky).
 * Copyright (c) 2018-2026 David Evans
 * Licensed under the MIT License; see ./a-starry-sky.LICENSE.txt.
 *
 * The moon's colour and heights come from NASA's Scientific Visualization Studio CGI Moon Kit
 * (public domain), processed by tools/build-moon-textures.py.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, If, uniform, vec2, vec3, float, floor, fract, sin, tan, log, dot, cross, atan, asin,
	normalize, length, fwidth, dFdx, dFdy, abs, clamp, max, min, mix, pow, smoothstep, exp, sqrt, select, acos,
	sign, texture,
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

// The lunar disk follows takram's MoonNode (three-geospatial): the view ray meets a sphere for
// the surface normal, which looks up NASA's colour map and is bent by the LOLA heights through
// a screen-space cotangent frame, and an Oren-Nayar surface of roughness 1 is lit by the sun.

// The kit's mean lunar radius in metres: heights over it give slopes on the unit sphere.
const LUNAR_RADIUS = 1737400;
// Mean linear luminance of the colour map's near side, weighted by projected area on the disk
// (printed by tools/build-moon-textures.py). Dividing by it keeps the disk's brightness in
// moonColor, so the map only redistributes it into maria, highlands and craters.
const NEAR_SIDE_LUMINANCE = 0.397;
// Oren-Nayar (roughness 1) radiance at normal incidence and view: the full moon's centre.
const OREN_NAYAR_A = ( 1 / Math.PI ) * ( 1 - 0.5 * ( 1 / 1.33 ) + 0.17 * ( 1 / 1.13 ) );
const OREN_NAYAR_B = ( 1 / Math.PI ) * ( 0.45 * ( 1 / 1.09 ) );
// Scales the textured disk so a full moon sends as much light as the painted disk it replaced
// (within 1 % over the disk): the moon's brightness and the night grade were tuned against it.
const MOON_BRIGHTNESS = 0.72;
// Past first quarter the sunlit side turns away and the brightest point of the disk dims, so a
// physically shaded crescent reads as a grey sliver. The eye, adapted to the little crescent,
// sees it bright: this share of that loss is given back (an art direction; 0 is physical).
const CRESCENT_LIFT = 0.7;
// Earthshine, after a-starry-sky: the faint, bluish light of the sunlit Earth on the lunar
// night side. FULL_EARTHSHINE is a-starry-sky's strength under a full Earth (at new moon, half
// of 0.19) against its sunlit surface, which is about twice the albedo; the colour is its
// blue-biased Earth albedo.
const FULL_EARTHSHINE = 0.5 * 0.19 * 0.5;
const EARTHSHINE_COLOR = new THREE.Vector3( 0.18, 0.30, 0.55 );
// Steepest slope the relief may give the normal (about 22 degrees); the height map's own slopes
// rarely pass 0.17.
const MAX_MOON_SLOPE = 0.4;
// Largest map footprint per pixel over the footprint at the disk's centre.
const MOON_FOOTPRINT_CAP = 3;
// Squared chord between the view ray and the moon's centre at the disk's edge.
const MOON_CHORD = 2 * ( 1 - Math.cos( MOON_ANGULAR_RADIUS ) );

// Unit normal of the near side of a sphere of the given angular radius where the view ray
// meets it. Off the disk it continues smoothly (unnormalised), so screen derivatives stay
// meaningful across the rim.
const raySphereNormal = Fn( ( [ ray, center, angularRadius ]: [ V3, V3, F ] ) => {

	const cosRay = dot( center, ray );
	// From the centre to its projection on the ray, and the half chord along the ray.
	const p = ray.mul( cosRay ).sub( center ).toVar();
	const s = sqrt( max( angularRadius.mul( angularRadius ).sub( dot( p, p ) ), 0 ) );
	return p.sub( ray.mul( s ) ).div( angularRadius );

} ).setLayout( { name: 'soomiMoonNormal', type: 'vec3', inputs: [
	{ name: 'ray', type: 'vec3' }, { name: 'center', type: 'vec3' }, { name: 'angularRadius', type: 'float' },
] } );

// Oren-Nayar diffuse with roughness 1 and albedo 1 (Yasuhiro Fujii's improved form,
// https://mimosa-pudica.net/improved-oren-nayar.html): the dusty regolith keeps a full moon
// nearly flat to its limb instead of the darkening of a Lambertian ball.
const orenNayar = Fn( ( [ light, view, normal ]: [ V3, V3, V3 ] ) => {

	const cosLight = dot( normal, light ).toVar();
	const cosView = dot( normal, view ).toVar();
	const s = dot( light, view ).sub( cosLight.mul( cosView ) ).toVar();
	// Avoids a seam at the edge, where max( cosLight, cosView ) goes to zero.
	const t = mix( float( 1 ), max( max( cosLight, cosView ), 0.1 ), smoothstep( 0, 0.1, s ) );
	return max( cosLight, 0 ).mul( s.div( t ).mul( OREN_NAYAR_B ).add( OREN_NAYAR_A ) );

} ).setLayout( { name: 'soomiMoonOrenNayar', type: 'float', inputs: [
	{ name: 'light', type: 'vec3' }, { name: 'view', type: 'vec3' }, { name: 'normal', type: 'vec3' },
] } );

// How much sunlit Earth the moon sees: the Lommel-Seeliger phase law from a-starry-sky's
// earthshine, taken at Earth's phase angle as seen from the moon, which is the moon's
// elongation from the sun (zero, a full Earth, at new moon).
const earthPhaseLaw = Fn( ( [ elongation ]: [ F ] ) => {

	const x = clamp( elongation.mul( 0.5 ), 1e-3, Math.PI / 2 - 1e-3 ).toVar();
	return clamp( float( 1 ).sub( sin( x ).mul( tan( x ) ).mul( log( float( 1 ).div( tan( x.mul( 0.5 ) ) ) ) ) ), 0, 1 );

} ).setLayout( { name: 'soomiEarthPhaseLaw', type: 'float', inputs: [ { name: 'elongation', type: 'float' } ] } );

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
	// Scale of the lunar relief over its true height (an art control; 0 leaves a smooth ball).
	readonly relief = uniform( 1 );
	// Strength of the earthshine over a-starry-sky's (an art control).
	readonly earthshine = uniform( 1 );
	// The near side's colour and LOLA heights (see tools/build-moon-textures.py). Loading
	// starts with the sky; the first bake waits for it, so no frame shows an untextured moon.
	readonly colorMap: THREE.Texture;
	readonly heightMap: THREE.Texture;
	private readonly loading: Promise<void>;

	constructor() {

		const loader = new THREE.TextureLoader();
		const base = import.meta.env.BASE_URL + 'sky/moon/';
		const load = ( name: string, colorSpace: string ): [ THREE.Texture, Promise<void> ] => {

			let map!: THREE.Texture;
			const loaded = new Promise<void>( ( resolve, reject ) => {

				map = loader.load( base + name, () => resolve(), undefined, () => reject( new Error( `Moon texture ${ name } failed to load` ) ) );

			} );
			map.colorSpace = colorSpace;
			// Longitude wraps; latitude ends at the poles.
			map.wrapS = THREE.RepeatWrapping;
			// The map stretches toward its poles, and the disk toward its limb.
			map.anisotropy = 4;
			return [ map, loaded ];

		};
		const [ colorMap, colorLoaded ] = load( 'moon_color.jpg', THREE.SRGBColorSpace );
		const [ heightMap, heightLoaded ] = load( 'moon_height.png', THREE.NoColorSpace );
		this.colorMap = colorMap;
		this.heightMap = heightMap;
		this.loading = Promise.all( [ colorLoaded, heightLoaded ] ).then( () => undefined );

	}

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

	/** Resolves once the moon's colour and height maps have loaded. */
	load(): Promise<void> {

		return this.loading;

	}

	moon( direction: V3 ): V3 {

		return this.lunarDisk( direction )
			.add( nightMoonGlow( direction, this.sunDir, this.moonDir, this.moonColor.rgb ).mul( this.glow ) );

	}

	// After takram's MoonNode: the disk's normal from a ray/sphere intersection, NASA's colour,
	// LOLA relief through a screen-space cotangent frame, Oren-Nayar shading and a limb
	// antialiased by the chord's screen derivative. The phase still comes only from the sun and
	// moon directions, and lunar north stays up as before.
	private lunarDisk( direction: V3 ): V3 {

		return Fn( () => {

			const moonDir = this.moonDir, sunDir = this.sunDir;
			// Squared chord to the moon's centre: its screen derivative gives the limb a one-pixel
			// edge at any field of view.
			const chord = direction.sub( moonDir ).toVar();
			const chordLength = dot( chord, chord ).toVar();
			const filterWidth = fwidth( chordLength ).toVar();
			// The lunar frame: x toward the observer (0 degrees longitude), y lunar east (the
			// observer's right), z lunar north. The normal, its map coordinates and their screen
			// derivatives are all taken here in uniform control flow; past the rim the normal
			// continues smoothly, so the derivatives hold up to the edge.
			const up = select( abs( moonDir.y ).greaterThan( 0.98 ), vec3( 0, 0, 1 ), vec3( 0, 1, 0 ) );
			const east = normalize( cross( moonDir, up ) ).toVar();
			const north = cross( east, moonDir ).toVar();
			const normal = raySphereNormal( direction, moonDir, float( MOON_ANGULAR_RADIUS ) ).toVar();
			const local = vec3( dot( normal, moonDir ).negate(), dot( normal, east ), dot( normal, north ) ).toVar();
			const uv = vec2( atan( local.y, local.x ).mul( 0.5 / Math.PI ).add( 0.5 ),
				asin( clamp( local.z, - 1, 1 ) ).mul( 1 / Math.PI ).add( 0.5 ) ).toVar();
			// The map's footprint grows without bound toward the limb and the poles. Capped at a few
			// times the footprint at the disk's centre, the limb keeps its own albedo instead of the
			// whole map's average from the smallest mips.
			const cap = length( fwidth( direction ) ).mul( MOON_FOOTPRINT_CAP / ( Math.PI * MOON_ANGULAR_RADIUS ) ).toVar();
			const footprint = ( d: V2 ) => d.mul( min( float( 1 ), cap.div( max( length( d ), 1e-9 ) ) ) );
			const uvdx = footprint( dFdx( uv ) ).toVar(), uvdy = footprint( dFdy( uv ) ).toVar();
			const ndx = dFdx( local ).toVar(), ndy = dFdy( local ).toVar();
			const radiance = vec3( 0 ).toVar();
			If( chordLength.lessThan( MOON_CHORD ), () => {

				// Heights in lunar radii, from the map's two filtered bytes (see the build script).
				const height = ( offset: V2 ) => {

					const h = texture( this.heightMap, uv.add( offset ) ).grad( uvdx, uvdy );
					return h.r.mul( 65280 ).add( h.g.mul( 255 ) ).mul( 0.5 / LUNAR_RADIUS );

				};
				const hdx = height( uvdx ).sub( height( uvdx.negate() ) ).mul( 0.5 );
				const hdy = height( uvdy ).sub( height( uvdy.negate() ) ).mul( 0.5 );
				// Cotangent frame: the surface gradient from the screen derivatives of the position
				// on the unit sphere, which is its normal.
				const r1 = cross( ndy, local ).toVar();
				const r2 = cross( local, ndx ).toVar();
				const det = dot( ndx, r1 ).toVar();
				const gradient = r1.mul( hdx ).add( r2.mul( hdy ) ).mul( sign( det ) );
				// The tilt is the gradient over |det|. A small disk's rim pixels share their quad with
				// sky pixels, where the frame can collapse (det near 0) and throw the normal toward the
				// sun; the true slopes at this map's scale stay far below the cap.
				const tilt = gradient.mul( this.relief ).div( max( abs( det ), 1e-20 ) ).toVar();
				const bumped = normalize( local.sub( tilt.mul( min( float( 1 ), float( MAX_MOON_SLOPE ).div( max( length( tilt ), 1e-9 ) ) ) ) ) );
				// Fade the relief toward the limb, where the derivatives grow without bound.
				const n = mix( local, bumped, smoothstep( 0, 0.3, dot( normal, direction ).negate() ) ).toVar();
				const surface = moonDir.mul( n.x.negate() ).add( east.mul( n.y ) ).add( north.mul( n.z ) ).toVar();
				// The colour map's luminance carries the albedo's pattern; moonColor its level.
				const albedo = texture( this.colorMap, uv ).grad( uvdx, uvdy ).rgb.mul( MOON_BRIGHTNESS / NEAR_SIDE_LUMINANCE ).toVar();
				// The disk's brightest point at this phase: the subsolar point while it is in view,
				// then the bright limb, where the Oren-Nayar term above reduces to this.
				const cosPhase = dot( sunDir, moonDir ).negate().toVar();
				const peak = select( cosPhase.greaterThan( 0 ), float( 1 ),
					sqrt( max( float( 1 ).sub( cosPhase.mul( cosPhase ) ), 0 ) ).mul( cosPhase.mul( OREN_NAYAR_B / OREN_NAYAR_A ).add( 1 ) ) );
				const lift = float( 1 ).div( mix( float( 1 ), max( peak, 0.05 ), CRESCENT_LIFT ) );
				const sunlit = orenNayar( sunDir, direction.negate(), surface ).mul( lift.mul( 1 / OREN_NAYAR_A ) );
				// Earthshine on the night side (a-starry-sky): strongest under a full Earth at new
				// moon, gone on the sunlit side and in the sun's glare close to conjunction.
				const elongation = acos( clamp( cosPhase.negate(), - 1, 1 ) ).toVar();
				const night = float( 1 ).sub( smoothstep( 0, 0.1, dot( surface, sunDir ) ) );
				const earthshine = vec3( EARTHSHINE_COLOR.x, EARTHSHINE_COLOR.y, EARTHSHINE_COLOR.z )
					.mul( earthPhaseLaw( elongation ).mul( night ).mul( smoothstep( 0.1, 0.35, elongation ) ).mul( this.earthshine ).mul( FULL_EARTHSHINE ) );
				// (Reversed edges, as takram writes it, are undefined for smoothstep in WGSL.)
				const limb = float( 1 ).sub( smoothstep( float( MOON_CHORD ).sub( filterWidth ), MOON_CHORD, chordLength ) );
				const horizon = smoothstep( - MOON_ANGULAR_RADIUS, 0.015, direction.y );
				// At exact conjunction, roundoff in the tangent plane can leave a faint positive
				// incidence at the rim. Suppress only this vanishing phase interval.
				const phase = smoothstep( 0, 0.0002, float( 1 ).sub( dot( sunDir, moonDir ) ).mul( 0.5 ) );
				radiance.assign( this.moonColor.rgb.mul( albedo ).mul( sunlit.mul( phase ).add( earthshine ) ).mul( limb ).mul( horizon ) );

			} );
			return radiance;

		} )();

	}

}
