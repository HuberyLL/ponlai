import * as THREE from 'three/webgpu';
import {
	Fn, If, uniform, vec2, vec3, float, floor, fract, sin, dot, cross,
	normalize, length, fwidth, abs, clamp, max, mix, pow, smoothstep, exp, sqrt, select, acos,
} from 'three/tsl';
import { SCENE_RADIANCE_SCALE } from '../lighting/Radiometry.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

// A slightly enlarged moon reads better at this scene's scale than the true 0.26 degrees.
export const MOON_ANGULAR_RADIUS = 0.014;

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
// into star clouds and cut by darker dust lanes.
const milkyWay = Fn( ( [ c ]: [ V3 ] ) => {

	const n = vec3( GALACTIC_NORMAL.x, GALACTIC_NORMAL.y, GALACTIC_NORMAL.z );
	const g = vec3( GALACTIC_CENTRE.x, GALACTIC_CENTRE.y, GALACTIC_CENTRE.z );
	const latitude = dot( c, n ).toVar();
	const core = pow( max( dot( c, g ), 0 ), 3 ).toVar();
	const width = mix( float( 0.1 ), float( 0.2 ), core );
	const band = exp( latitude.mul( latitude ).div( width.mul( width ) ).mul( - 0.5 ) ).toVar();
	const clouds = noise3( c.mul( 7 ) ).mul( 0.55 ).add( noise3( c.mul( 17 ).add( 3.1 ) ).mul( 0.3 ) ).add( noise3( c.mul( 41 ).add( 7.7 ) ).mul( 0.15 ) );
	// The dust lane runs along the plane, a little off its centre line, and frays at its edges.
	const offset = latitude.sub( 0.015 ).add( noise3( c.mul( 9 ).add( 2.2 ) ).sub( 0.5 ).mul( 0.03 ) );
	const lane = exp( offset.mul( offset ).div( - 2 * 0.02 * 0.02 ) )
		.mul( smoothstep( 0.32, 0.6, noise3( c.mul( 4.5 ).add( 5.3 ) ) ) )
		.mul( smoothstep( 0.2, 0.7, noise3( c.mul( 15 ).add( 1.7 ) ) ).mul( 0.6 ).add( 0.4 ) );
	return band.mul( clouds.mul( 0.8 ).add( 0.2 ) ).mul( core.mul( 1.6 ).add( 0.45 ) ).mul( float( 1 ).sub( lane.mul( 0.6 ) ) );

} ).setLayout( { name: 'soomiMilkyWay', type: 'float', inputs: [ { name: 'c', type: 'vec3' } ] } );

// One layer of stars on the faces of a cube around the celestial sphere: at most one star per
// cell, kept away from the cell's edges, so a direction only ever needs its own cell.
const starLayer = ( c: V3, footprint: F, cells: number, occupancy: F, seed: number, sizeMin: number, sizeMax: number, peak: number, time: F, elevation: F ) => {

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
		// Many faint stars, few bright ones.
		const magnitude = nightHash( key.add( vec2( 41.7, 113.9 ) ) ).toVar();
		const radius = mix( float( sizeMin ), float( sizeMax ), pow( magnitude, 4 ) ).toVar();
		const radiusSquared = radius.mul( radius ).toVar();
		// Convolve an angular Gaussian with the pixel footprint, preserving its energy.
		const variance = radiusSquared.add( footprint.mul( footprint ).mul( 0.18 ) ).toVar();
		const separation = c.sub( starDir ).toVar();
		const profile = exp( dot( separation, separation ).div( variance ).mul( - 0.5 ) ).mul( radiusSquared.div( variance ) );
		const temperature = nightHash( key.add( vec2( 197.1, 7.3 ) ) ).toVar();
		const color = mix( mix( vec3( 1, 0.72, 0.5 ), vec3( 1, 0.95, 0.88 ), smoothstep( 0, 0.35, temperature ) ),
			vec3( 0.7, 0.82, 1 ), smoothstep( 0.55, 1, temperature ) );
		// Low stars scintillate a little through the thicker air near the horizon.
		const twinkle = sin( time.mul( magnitude.mul( 5 ).add( 3 ) ).add( temperature.mul( 41 ) ) )
			.mul( float( 1 ).sub( smoothstep( 0.05, 0.45, elevation ) ) ).mul( 0.35 ).add( 1 );
		const brightness = pow( magnitude, 6 ).mul( peak ).add( peak * 0.02 );
		radiance.assign( color.mul( brightness ).mul( profile ).mul( twinkle ) );

	} );
	return radiance;

};

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
		const up = select( abs( moonDir.y ).greaterThan( 0.98 ), vec3( 0, 0, 1 ), vec3( 0, 1, 0 ) );
		const right = normalize( cross( up, moonDir ) ).toVar();
		const north = cross( moonDir, right ).toVar();
		const q = vec2( dot( tangent, right ), dot( tangent, north ) ).toVar();
		// Dark maria, a few brighter highland blotches and a faint limb darkening.
		const maria = nightNoise( q.mul( 2.8 ).add( vec2( 7.3, 19.1 ) ) ).mul( 0.6 )
			.add( nightNoise( q.mul( 6.7 ).add( vec2( 23.4, 3.9 ) ) ).mul( 0.28 ) )
			.add( nightNoise( q.mul( 15 ).add( vec2( 3.4, 9.9 ) ) ).mul( 0.12 ) ).toVar();
		const albedo = float( 0.96 ).sub( smoothstep( 0.4, 0.68, maria ).mul( 0.3 ) ).mul( mix( float( 0.82 ), float( 1 ), depth ) );
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
	const glow = exp( angle.div( - 0.035 ) ).mul( 0.05 ).add( exp( angle.div( - 0.3 ) ).mul( 0.006 ) );
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
	// Strength of the haze glow around the moon (an art control; 0 leaves the bare disk).
	readonly glow = uniform( 1 );

	stars( direction: V3, angularFootprint?: F, visibility: F = this.starVisibility ): V3 {

		// The dome derives its pixel footprint before varying control flow. Reflection and
		// bake callers may supply a roughness/texel footprint explicitly, avoiding derivatives
		// in their branches. A separate bake visibility keeps future endpoints off the dome.
		const footprint = max( angularFootprint ?? length( fwidth( direction ) ), 1e-5 ).toVar();
		const radiance = vec3( 0 ).toVar();
		const v = clamp( visibility, 0, 1 ).toVar();
		If( v.greaterThan( 0.0001 ), () => {

			const c = normalize( this.frame.mul( direction ) ).toVar();
			const band = milkyWay( c ).toVar();
			const elevation = direction.y;
			// Bright scattered stars, a dense faint field thickening along the Milky Way, and the
			// band's own unresolved glow.
			const bright = starLayer( c, footprint, 40, float( 0.32 ), 0, 0.0004, 0.0011, 2.2, this.time, elevation );
			const faint = starLayer( c, footprint, 150, band.mul( 0.45 ).add( 0.22 ), 17, 0.00025, 0.0005, 0.5, this.time, elevation );
			const glow = mix( vec3( 0.62, 0.72, 1 ), vec3( 1, 0.86, 0.72 ), smoothstep( 0.5, 1.4, band ) ).mul( band ).mul( 0.024 );
			// Thick air near the horizon dims the stars and the band.
			const horizon = smoothstep( - 0.01, 0.12, elevation );
			radiance.assign( bright.add( faint ).add( glow ).mul( v ).mul( horizon ).mul( SCENE_RADIANCE_SCALE ) );

		} );
		return radiance;

	}

	moon( direction: V3 ): V3 {

		const footprint = max( length( fwidth( direction ) ), 1e-5 ).toVar();
		return nightMoon( direction, footprint, this.sunDir, this.moonDir, this.moonColor.rgb )
			.add( nightMoonGlow( direction, this.sunDir, this.moonDir, this.moonColor.rgb ).mul( this.glow ) );

	}

}
