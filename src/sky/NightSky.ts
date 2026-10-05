import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, uniform, vec2, vec3, float, int, uint, floor, fract, sin, dot, cross, atan,
	normalize, length, fwidth, abs, clamp, max, min, mix, pow, smoothstep, exp, sqrt, select, acos,
} from 'three/tsl';
import { SCENE_RADIANCE_SCALE, SUN_DISPLAY_RADIUS } from '../lighting/Radiometry.ts';
import { STAR_CELLS, CELL_SLOTS, CELL_COUNT, MILKY_WAY_WIDTH, MILKY_WAY_HEIGHT, skyWords, starRecords, loadNightSkyData } from './StarCatalog.ts';

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

// The Milky Way's floor: the mask's darkest open sky (about its median) holds the unresolved
// light of faint stars everywhere; the stylised night keeps that sky dark.
const MILKY_WAY_FLOOR = 0.03;

// Brightness of the Milky Way (0 to about 2) in the equatorial direction c, from its mask value.
// Its shape, the bulge toward Sagittarius, the Great Rift and the dark clouds come from the
// NASA/Gaia mask; procedural grain breaks it up finer than the mask's third of a degree, so it
// reads as unresolved stars rather than a blurred photograph. `fine` is 0 for blurred lookups
// (reflections, bakes), which skip the small-scale structure.
const milkyWay = Fn( ( [ c, mask, fine ]: [ V3, F, F ] ) => {

	const light = max( mask.mul( mask ).sub( MILKY_WAY_FLOOR ), 0 ).div( 1 - MILKY_WAY_FLOOR );
	// A gentle lift keeps the faint outer band visible beside the bright core.
	const result = pow( light, 0.75 ).mul( 2.2 ).toVar();
	// The grain costs four noise lookups; most of the sky lies outside the band.
	If( result.greaterThan( 0.01 ).and( fine.greaterThan( 0.5 ) ), () => {

		const clouds = noise3( c.mul( 61 ).add( 7.7 ) ).sub( 0.5 ).mul( 0.2 ).add( 1 );
		// Unresolved stars: a fine mottling over the clouds.
		const grain = noise3( c.mul( 170 ).add( 4.4 ) ).mul( 0.55 ).add( noise3( c.mul( 390 ).add( 8.8 ) ).mul( 0.45 ) );
		result.mulAssign( clouds.mul( grain.mul( 0.5 ).add( 0.75 ) ) );

	} );
	return result;

} ).setLayout( { name: 'soomiMilkyWay', type: 'float', inputs: [ { name: 'c', type: 'vec3' }, { name: 'mask', type: 'float' }, { name: 'fine', type: 'float' } ] } );

// One byte of the Milky Way mask, as 0 to 1.
const maskTexel = ( x: THREE.Node<'int'>, y: THREE.Node<'int'> ) => {

	const index = y.mul( MILKY_WAY_WIDTH ).add( x ).toVar();
	const word = skyWords.element( index.shiftRight( 2 ).add( CELL_COUNT ) );
	return float( word.shiftRight( uint( index.bitAnd( 3 ).mul( 8 ) ) ).bitAnd( uint( 255 ) ) ).div( 255 );

};

// The mask bilinearly filtered in the equatorial direction c (its layout: right ascension 0h at
// the centre, increasing to the left; declination +90 on the first row), wrapping in right
// ascension. Read here rather than in the shader function above, which cannot bind buffers.
const milkyWayMaskAt = ( c: V3 ) => {

	const x = fract( float( 0.5 ).sub( atan( c.y, c.x ).div( 2 * Math.PI ) ) ).mul( MILKY_WAY_WIDTH ).sub( 0.5 ).toVar();
	const y = acos( clamp( c.z, - 1, 1 ) ).div( Math.PI ).mul( MILKY_WAY_HEIGHT ).sub( 0.5 ).toVar();
	const x0 = floor( x ).toVar(), y0 = floor( y ).toVar();
	const fx = x.sub( x0 ), fy = y.sub( y0 );
	const left = int( x0 ).bitAnd( MILKY_WAY_WIDTH - 1 ).toVar();
	const right = left.add( 1 ).bitAnd( MILKY_WAY_WIDTH - 1 ).toVar();
	const top = int( clamp( y0, 0, MILKY_WAY_HEIGHT - 1 ) ).toVar();
	const bottom = int( clamp( y0.add( 1 ), 0, MILKY_WAY_HEIGHT - 1 ) ).toVar();
	return mix( mix( maskTexel( left, top ), maskTexel( right, top ), fx ),
		mix( maskTexel( left, bottom ), maskTexel( right, bottom ), fx ), fy );

};

// Footprint (radians across a pixel's derivative) at which a baked star carries the energy of a
// star drawn on screen. On screen a star stays a fixed fraction of a pixel wide and keeps its
// brightness at any resolution or zoom, as the eye sees a point; bakes conserve its energy.
const STAR_REFERENCE_FOOTPRINT = 0.0015;
// Star image width in footprints: a little under a pixel, wide enough that a star drifting with
// the sky's rotation keeps its brightness as it crosses pixels instead of shimmering.
const STAR_WIDTH = 0.5;

// The face of a cube around the celestial sphere that c points through, and c's cell in a grid of
// cells x cells on that face. StarCatalog.ts buckets the catalogue with the same selection.
const cubeCell = ( c: V3, cells: number ) => {

	const a = abs( c ).toVar();
	const xMajor = a.x.greaterThanEqual( a.y ).and( a.x.greaterThanEqual( a.z ) );
	const yMajor = a.y.greaterThanEqual( a.z );
	// Face index and in-face coordinates in [-1, 1].
	const face = select( xMajor, select( c.x.greaterThan( 0 ), float( 0 ), float( 1 ) ),
		select( yMajor, select( c.y.greaterThan( 0 ), float( 2 ), float( 3 ) ), select( c.z.greaterThan( 0 ), float( 4 ), float( 5 ) ) ) ).toVar();
	const major = select( xMajor, a.x, select( yMajor, a.y, a.z ) );
	const uv = select( xMajor, c.zy, select( yMajor, c.xz, c.xy ) ).div( major ).toVar();
	const cell = min( floor( uv.mul( 0.5 ).add( 0.5 ).mul( cells ) ), cells - 1 ).toVar();
	return { xMajor, yMajor, face, cell };

};

// A star image: a Gaussian a little under a pixel wide around its direction. Bakes widen it to
// their own footprint and keep its energy.
const starProfile = ( c: V3, starDir: V3, footprint: F, conserve: boolean ) => {

	const variance = footprint.mul( footprint ).mul( STAR_WIDTH * STAR_WIDTH ).toVar();
	const separation = c.sub( starDir ).toVar();
	const profile = exp( dot( separation, separation ).div( variance ).mul( - 0.5 ) ).toVar();
	if ( conserve ) profile.mulAssign( float( STAR_REFERENCE_FOOTPRINT * STAR_REFERENCE_FOOTPRINT * STAR_WIDTH * STAR_WIDTH ).div( variance ) );
	return profile;

};

// Only low stars scintillate, seen through the thick air near the horizon: an irregular flicker,
// not a steady pulse; high stars burn steadily. seed and phase are two per-star constants.
const scintillation = ( time: F, elevation: F, seed: F, phase: F ) => {

	const flicker = nightNoise( vec2( time.mul( 2.3 ).add( seed.mul( 57 ) ), phase.mul( 91 ) ) ).sub( 0.5 );
	return flicker.mul( float( 1 ).sub( smoothstep( 0.02, 0.2, elevation ) ) ).mul( 0.4 ).add( 1 );

};

// The real stars, from the Yale Bright Star Catalogue: the stars of the cell c falls in
// (StarCatalog.ts lists each star in every cell its image reaches).
const catalogueStars = ( c: V3, footprint: F, conserve: boolean, time: F, elevation: F ) => {

	const radiance = vec3( 0 ).toVar();
	const { face, cell } = cubeCell( c, STAR_CELLS );
	const packed = skyWords.element( int( cell.y ).mul( 6 ).add( int( face ) ).mul( STAR_CELLS ).add( int( cell.x ) ) ).toVar();
	const start = int( packed.shiftRight( uint( Math.log2( CELL_SLOTS ) ) ) ).toVar();
	const count = int( packed.bitAnd( uint( CELL_SLOTS - 1 ) ) ).toVar();
	Loop( { start: int( 0 ), end: count, type: 'int', condition: '<' }, ( { i } ) => {

		const record = start.add( i ).mul( 2 ).toVar();
		const star = starRecords.element( record ).toVar();
		const profile = starProfile( c, star.xyz, footprint, conserve );
		If( profile.greaterThan( 1e-4 ), () => {

			const look = starRecords.element( record.add( 1 ) ).toVar();
			radiance.addAssign( look.rgb.mul( star.w ).mul( profile ).mul( scintillation( time, elevation, look.w, star.w ) ) );

		} );

	} );
	return radiance;

};

// A procedural layer of stars too faint for the catalogue: at most one star per cube cell, kept
// away from the cell's edges, so a direction only ever needs its own cell. Brightness follows the
// sky's own statistics: every magnitude brighter holds about a third as many stars. `faintest`
// is the dimmest star's peak and `range` how many times brighter the brightest may be.
const starLayer = ( c: V3, footprint: F, conserve: boolean, cells: number, occupancy: F, seed: number, faintest: number, range: number, time: F, elevation: F ) => {

	const radiance = vec3( 0 ).toVar();
	const { xMajor, yMajor, face, cell } = cubeCell( c, cells );
	const key = cell.add( vec2( face.mul( 1031 ).add( seed ), face.mul( 557 ).sub( seed ) ) ).toVar();
	If( nightHash( key ).lessThan( occupancy ), () => {

		const jitter = vec2( nightHash( key.add( vec2( 29.3, 71.7 ) ) ), nightHash( key.add( vec2( 83.1, 17.6 ) ) ) ).mul( 0.6 ).add( 0.2 );
		const st = cell.add( jitter ).div( cells ).mul( 2 ).sub( 1 ).toVar();
		const onFace = select( xMajor, vec3( select( c.x.greaterThan( 0 ), float( 1 ), float( - 1 ) ), st.y, st.x ),
			select( yMajor, vec3( st.x, select( c.y.greaterThan( 0 ), float( 1 ), float( - 1 ) ), st.y ),
				vec3( st.x, st.y, select( c.z.greaterThan( 0 ), float( 1 ), float( - 1 ) ) ) ) );
		// Counts grow by about 2.8 per magnitude, so the brightness of a uniform draw u is u^-0.9.
		const draw = max( nightHash( key.add( vec2( 41.7, 113.9 ) ) ), 1e-4 ).toVar();
		const brightness = min( pow( draw, - 0.9 ), range ).mul( faintest );
		const profile = starProfile( c, normalize( onFace ), footprint, conserve );
		const temperature = nightHash( key.add( vec2( 197.1, 7.3 ) ) ).toVar();
		const color = mix( mix( vec3( 1, 0.72, 0.5 ), vec3( 1, 0.95, 0.88 ), smoothstep( 0, 0.35, temperature ) ),
			vec3( 0.7, 0.82, 1 ), smoothstep( 0.55, 1, temperature ) );
		radiance.assign( color.mul( brightness ).mul( profile ).mul( scintillation( time, elevation, temperature, draw ) ) );

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

	get ready(): boolean { return this.loaded; }
	private loaded = false;

	/** Load the star catalogue and the Milky Way mask; the sky waits for them before its first bake. */
	async init(): Promise<void> {

		await loadNightSkyData();
		this.loaded = true;

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
			const band = milkyWay( c, milkyWayMaskAt( c ), float( conserve ? 0 : 1 ) ).toVar();
			const elevation = direction.y;
			// The catalogue's nine thousand real stars, down to the edge of naked-eye visibility;
			// below them a dense procedural field thickening along the Milky Way; and the band's
			// own unresolved glow.
			const bright = catalogueStars( c, footprint, conserve, this.time, elevation );
			const wash = clamp( this.moonWash, 0, 1 );
			// Two procedural layers below the catalogue: a field everywhere, and a dense dust of
			// barely resolved stars that only the Milky Way's star clouds hold, so the band reads
			// as stars rather than mist.
			const faint = starLayer( c, footprint, conserve, 180, band.mul( 0.4 ).add( 0.05 ), 17, 0.004, 3, this.time, elevation )
				.add( starLayer( c, footprint, conserve, 400, band.mul( 0.6 ), 29, 0.004, 3, this.time, elevation ) )
				.mul( float( 1 ).sub( wash.mul( 0.7 ) ) );
			// Blue-white star clouds, warming only in the bulge toward Sagittarius.
			const glow = mix( vec3( 0.66, 0.75, 1 ), vec3( 1, 0.88, 0.74 ), smoothstep( 0.9, 2, band ) ).mul( band ).mul( 0.03 )
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

}
