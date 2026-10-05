import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, Break, uniform, vec3, vec4, float, floor, fract, dot, mix, smoothstep,
	clamp, max, min, exp, pow, sin, vec2, int, mod,
} from 'three/tsl';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

export const CLOUD_BASE = 110;
export const CLOUD_TOP = 145;
const CLOUD_EXTINCTION = 0.085;
// Cloud groups sit on a 110 m grid and the erosion lattice has 1 / 0.075 m cells, both along the
// field's rotated axes. The wind offset wraps every CLOUD_PERIOD metres on those axes (100 groups,
// 825 lattice cells) and hash inputs repeat with it, so the drift is seamless and hash arguments
// stay small however long the session runs. Cells within half a period of the origin are unchanged.
const CLOUD_GROUP = 110, EROSION_SCALE = 0.075;
const CLOUD_PERIOD = 11000;
const FIELD_C = 0.83205, FIELD_S = 0.55470; // field axes: x' = c x + s z, z' = c z - s x
const wrapCell = ( cell: F, cells: number ) => mod( cell.add( Math.floor( cells / 2 ) ), cells ).sub( Math.floor( cells / 2 ) );
const EROSION_CELLS = Math.round( CLOUD_PERIOD * EROSION_SCALE );
const latticeHash = ( cell: V3, x: number, y: number, z: number ) =>
	cloudHash( vec3( wrapCell( cell.x.add( x ), EROSION_CELLS ), cell.y.add( y ), wrapCell( cell.z.add( z ), EROSION_CELLS ) ) );

// Original procedural cloud field. Rounded groups provide the silhouette; lattice noise only
// erodes their edges. No frame-dependent noise is used, so the panorama, reflected sky, and
// world-space shadow all move through the same stable volume.
const cloudHash = Fn( ( [ p ]: [ V3 ] ) => {

	return fract( sin( dot( p, vec3( 91.17, 37.43, 173.31 ) ) ).mul( 42741.371 ) );

} ).setLayout( { name: 'soomiCloudHash', type: 'float', inputs: [ { name: 'p', type: 'vec3' } ] } );

// Value noise whose lattice repeats every `period` cells in x and z.
const cloudNoise = Fn( ( [ p ]: [ V3 ] ) => {

	const cell = floor( p ).toVar();
	const f = fract( p ).toVar();
	const w = f.mul( f ).mul( float( 3 ).sub( f.mul( 2 ) ) ).toVar();
	const low = mix(
		mix( latticeHash( cell, 0, 0, 0 ), latticeHash( cell, 1, 0, 0 ), w.x ),
		mix( latticeHash( cell, 0, 1, 0 ), latticeHash( cell, 1, 1, 0 ), w.x ), w.y );
	const high = mix(
		mix( latticeHash( cell, 0, 0, 1 ), latticeHash( cell, 1, 0, 1 ), w.x ),
		mix( latticeHash( cell, 0, 1, 1 ), latticeHash( cell, 1, 1, 1 ), w.x ), w.y );
	return mix( low, high, w.z );

} ).setLayout( { name: 'soomiCloudNoise', type: 'float', inputs: [ { name: 'p', type: 'vec3' } ] } );

const cloudDensity = Fn( ( [ position, wind, coverage, density ]: [ V3, V2, F, F ] ) => {

	const h = position.y.sub( CLOUD_BASE ).div( CLOUD_TOP - CLOUD_BASE ).toVar();
	const result = float( 0 ).toVar();
	// Light probes above or below the layer have exactly zero density. Avoid evaluating
	// the neighborhood and erosion field only to multiply their result by a zero envelope.
	If( h.greaterThan( 0 ).and( h.lessThan( 1 ) ), () => {

		const envelope = smoothstep( 0, 0.1, h ).mul( float( 1 ).sub( smoothstep( 0.76, 1, h ) ) ).toVar();
		const advected = position.xz.add( wind ).toVar();
		const p = vec3( advected.x.mul( FIELD_C ).add( advected.y.mul( FIELD_S ) ), position.y,
			advected.y.mul( FIELD_C ).sub( advected.x.mul( FIELD_S ) ) ).toVar();
		const cell = floor( p.xz.div( CLOUD_GROUP ) ).toVar();
		const body = float( 0 ).toVar();
		// Search adjacent cells so irregular cloud groups can overlap without tile seams.
		// Each group is three offset ellipsoids; random placement and sizes break up rows.
		Loop( { start: int( - 1 ), end: int( 2 ), type: 'int' }, { start: int( - 1 ), end: int( 2 ), type: 'int' }, ( { i, j } ) => {

			const id = cell.add( vec2( float( i ), float( j ) ) ).toVar();
			// Positions use the true cell; only the hash repeats with the wrapped wind offset.
			const seed = cloudHash( vec3( wrapCell( id.x, CLOUD_PERIOD / CLOUD_GROUP ), 11.7, wrapCell( id.y, CLOUD_PERIOD / CLOUD_GROUP ) ) ).toVar();
			const random = fract( vec3( 37.17, 73.91, 113.23 ).mul( seed ) ).toVar();
			const centerXZ = id.add( random.xy.mul( 0.56 ).add( 0.22 ) ).mul( CLOUD_GROUP );
			const center = vec3( centerXZ.x, random.z.mul( 9 ).add( 122 ), centerXZ.y ).toVar();
			const radius = mix( 30, 56, clamp( coverage, 0, 1 ) ).mul( mix( 0.85, 1.17, random.z ) ).toVar();
			const local = p.sub( center ).div( vec3( radius, 17, radius ) ).toVar();
			const offset = random.xy.sub( 0.5 ).mul( 1.2 ).toVar();
			const puffA = local.sub( vec3( offset.x, 0.23, offset.y ) ).div( vec3( 0.73, 0.83, 0.73 ) ).toVar();
			const puffB = local.sub( vec3( offset.y.negate(), 0.38, offset.x ) ).div( vec3( 0.65, 0.81, 0.65 ) ).toVar();
			const shape = float( 1 ).sub( min( dot( local, local ), min( dot( puffA, puffA ), dot( puffB, puffB ) ) ) );
			const active = smoothstep( seed.sub( 0.055 ), seed.add( 0.055 ), coverage );
			body.assign( max( body, smoothstep( 0.02, 0.35, shape ).mul( active ) ) );

		} );
		const erosion = cloudNoise( p.mul( vec3( EROSION_SCALE, 0.11, EROSION_SCALE ) ).add( vec3( 7.4, 2.8, 13.1 ) ) ).toVar();
		const billows = max( body.sub( float( 1 ).sub( erosion ).mul( 0.18 ) ), 0 ).toVar();
		// High coverage joins the puffs into a stratified overcast bank continuously.
		const overcast = smoothstep( 0.76, 0.98, coverage ).mul( erosion.mul( 0.18 ).add( 0.45 ) );
		result.assign( max( billows, overcast ).mul( envelope ).mul( max( density, 0 ) ).mul( smoothstep( 0, 0.02, coverage ) ) );

	} );
	return result;

} ).setLayout( { name: 'soomiCloudDensity', type: 'float', inputs: [
	{ name: 'position', type: 'vec3' }, { name: 'wind', type: 'vec2' },
	{ name: 'coverage', type: 'float' }, { name: 'density', type: 'float' },
] } );

const cloudRadiance = Fn( ( [ direction, background, wind, coverage, density, lightDir, lightColor, ambientColor, samples ]:
	[ V3, V3, V2, F, F, V3, V3, V3, F ] ) => {

	const result = vec4( background, 1 ).toVar();
	If( direction.y.greaterThan( 0.045 ).and( coverage.greaterThan( 0.001 ) ), () => {

		// A horizon fade bounds grazing paths and lets the existing atmospheric scattering own
		// the distant horizon. The volume never lays a white film over the sea or island.
		const horizon = smoothstep( 0.045, 0.18, direction.y ).toVar();
		const count = clamp( floor( samples.add( 0.5 ) ), 6, 14 ).toVar();
		const near = float( CLOUD_BASE ).div( direction.y ).toVar();
		const step = float( CLOUD_TOP - CLOUD_BASE ).div( direction.y.mul( count ) ).toVar();
		const transmission = float( 1 ).toVar();
		const scattered = vec3( 0 ).toVar();
		const towardLight = max( dot( direction, lightDir ), 0 ).toVar();
		const phase = pow( towardLight, 8 ).mul( 0.1 ).add( 0.07 ).toVar();
		Loop( 14, ( { i } ) => {

			If( float( i ).greaterThanEqual( count ), () => {

				Break();

			} );
			const distance = near.add( float( i ).add( 0.5 ).mul( step ) ).toVar();
			const p = direction.mul( distance ).toVar();
			const d = cloudDensity( p, wind, coverage, density ).toVar();
			// Empty samples neither scatter nor absorb. Most clear-weather rays spend their
			// time between puffs, where both otherwise expensive light probes can be skipped.
			If( d.greaterThan( 0.0001 ), () => {

				const opacity = float( 1 ).sub( exp( d.mul( step ).mul( - CLOUD_EXTINCTION ) ) ).toVar();
				// Two light-path probes give soft internal shade and sunlit rims without a second
				// ray march. A small density-dependent fill approximates light scattered within a
				// billow; all radiance remains proportional to the supplied celestial/sky light.
				const lightNear = cloudDensity( p.add( lightDir.mul( 8 ) ), wind, coverage, density );
				const lightFar = cloudDensity( p.add( lightDir.mul( 20 ) ), wind, coverage, density );
				const lightThrough = exp( lightNear.mul( 8 ).add( lightFar.mul( 16 ) ).mul( - CLOUD_EXTINCTION ) ).toVar();
				const height = clamp( p.y.sub( CLOUD_BASE ).div( CLOUD_TOP - CLOUD_BASE ), 0, 1 ).toVar();
				const ambient = ambientColor.mul( mix( 0.13, 0.34, height ) );
				const direct = lightColor.mul( phase ).mul( lightThrough.mul( 0.88 ).add( 0.12 ) );
				scattered.addAssign( ambient.add( direct ).mul( transmission ).mul( opacity ) );
				transmission.mulAssign( float( 1 ).sub( opacity ) );

			} );

		} );
		result.assign( vec4( mix( background, scattered.add( background.mul( transmission ) ), horizon ),
			mix( 1, transmission, horizon ) ) );

	} );
	return result;

} ).setLayout( { name: 'soomiCloudRadiance', type: 'vec4', inputs: [
	{ name: 'direction', type: 'vec3' }, { name: 'background', type: 'vec3' },
	{ name: 'wind', type: 'vec2' }, { name: 'coverage', type: 'float' }, { name: 'density', type: 'float' },
	{ name: 'lightDir', type: 'vec3' }, { name: 'lightColor', type: 'vec3' },
	{ name: 'ambientColor', type: 'vec3' }, { name: 'samples', type: 'float' },
] } );

const cloudTransmittance = Fn( ( [ origin, direction, wind, coverage, density ]: [ V3, V3, V2, F, F ] ) => {

	const transmission = float( 1 ).toVar();
	If( direction.y.greaterThan( 0.015 ).and( origin.y.lessThan( CLOUD_TOP ) ).and( coverage.greaterThan( 0.001 ) ), () => {

		const near = max( float( CLOUD_BASE ).sub( origin.y ), 0 ).div( direction.y ).toVar();
		const far = float( CLOUD_TOP ).sub( origin.y ).div( direction.y ).toVar();
		// The three equally spaced taps sample the exact field seen in the panorama. Limit
		// grazing optical length to avoid distant low-sun clouds blacking out the whole island.
		const step = far.sub( near ).div( 3 ).toVar();
		const opticalDepth = float( 0 ).toVar();
		Loop( 3, ( { i } ) => {

			const p = origin.add( direction.mul( near.add( float( i ).add( 0.5 ).mul( step ) ) ) );
			opticalDepth.addAssign( cloudDensity( p, wind, coverage, density ).mul( min( step, 35 ) ) );

		} );
		transmission.assign( exp( opticalDepth.mul( - CLOUD_EXTINCTION ) ) );

	} );
	return transmission;

} ).setLayout( { name: 'soomiCloudTransmittance', type: 'float', inputs: [
	{ name: 'origin', type: 'vec3' }, { name: 'direction', type: 'vec3' }, { name: 'wind', type: 'vec2' },
	{ name: 'coverage', type: 'float' }, { name: 'density', type: 'float' },
] } );

export class Clouds {

	readonly coverage = uniform( 0.28 );
	readonly density = uniform( 1 );
	// Set through setWindOffset, which keeps it within one field period.
	readonly windOffset = uniform( new THREE.Vector2() );
	readonly lightDir = uniform( new THREE.Vector3( 0.75, 0.53, - 0.12 ).normalize() );
	readonly lightColor = uniform( new THREE.Color( 0.5, 0.45, 0.38 ) );
	readonly ambientColor = uniform( new THREE.Color( 0.026, 0.035, 0.044 ) );
	// Set to 6 / 10 / 14 for low / medium / high; the shader has a fixed upper bound.
	readonly quality = uniform( 10 );

	/** Wraps an unbounded advection offset (density sampled at xz + offset) to an equivalent one. */
	setWindOffset( offset: THREE.Vector2 ): void {

		const wrap = ( v: number ) => v - CLOUD_PERIOD * Math.round( v / CLOUD_PERIOD );
		const x = wrap( FIELD_C * offset.x + FIELD_S * offset.y ), z = wrap( FIELD_C * offset.y - FIELD_S * offset.x );
		const det = FIELD_C * FIELD_C + FIELD_S * FIELD_S;
		this.windOffset.value.set( ( FIELD_C * x - FIELD_S * z ) / det, ( FIELD_S * x + FIELD_C * z ) / det );

	}

	/** RGB is composited scene-linear radiance; alpha is remaining transmittance, not opacity. */
	radiance( direction: V3, background: V3 ): V4 {

		return cloudRadiance( direction, background, this.windOffset, this.coverage, this.density,
			this.lightDir, this.lightColor.rgb, this.ambientColor.rgb, this.quality );

	}

	/** Intended for a small world-space shadow bake, avoiding noise evaluation on every surface. */
	transmittance( origin: V3, direction: V3 ): F {

		return cloudTransmittance( origin, direction, this.windOffset, this.coverage, this.density );

	}

}
