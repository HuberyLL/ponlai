import * as THREE from 'three/webgpu';
import {
	Fn, If, uniform, vec2, vec3, float, floor, fract, sin, cos, atan, asin, dot, cross,
	normalize, length, fwidth, abs, clamp, max, mix, pow, smoothstep, exp, sqrt, select,
} from 'three/tsl';
import { SCENE_RADIANCE_SCALE } from '../lighting/Radiometry.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

export const MOON_ANGULAR_RADIUS = 0.0072;

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

const nightStars = Fn( ( [ direction, footprint, visibility ]: [ V3, F, F ] ) => {

	const radiance = vec3( 0 ).toVar();
	If( visibility.greaterThan( 0.0001 ), () => {

		// Hash a fixed celestial grid, not a screen pixel. Sparse centers stay well inside
		// their cells, so neither the longitude wrap nor adjacent hash cells clip a star.
		const longitude = atan( direction.z, direction.x ).div( 2 * Math.PI ).add( 0.5 );
		const latitude = asin( clamp( direction.y, - 1, 1 ) ).div( Math.PI ).add( 0.5 );
		const cell = floor( vec2( longitude, latitude ).mul( vec2( 160, 80 ) ) ).toVar();
		const chance = nightHash( cell ).toVar();
		// Occupancy belongs to the cell, not to the moving view direction. In particular,
		// crossing a star's own footprint must not change whether that star exists.
		const latitudeWeight = cos( cell.y.add( 0.5 ).div( 80 ).sub( 0.5 ).mul( Math.PI ) ).toVar();
		If( chance.lessThan( latitudeWeight.mul( 0.11 ) ), () => {

			const jitter = vec2( nightHash( cell.add( vec2( 29.3, 71.7 ) ) ),
				nightHash( cell.add( vec2( 83.1, 17.6 ) ) ) ).mul( 0.4 ).add( 0.3 );
			const starUV = cell.add( jitter ).div( vec2( 160, 80 ) ).toVar();
			const phi = starUV.x.sub( 0.5 ).mul( 2 * Math.PI ).toVar();
			const theta = starUV.y.sub( 0.5 ).mul( Math.PI ).toVar();
			const starDir = vec3( cos( theta ).mul( cos( phi ) ), sin( theta ), cos( theta ).mul( sin( phi ) ) );
			const magnitude = nightHash( cell.add( vec2( 41.7, 113.9 ) ) ).toVar();
			const radius = mix( 0.00038, 0.00085, pow( magnitude, 3 ) ).toVar();
			const radiusSquared = radius.mul( radius ).toVar();
			// Convolve an angular Gaussian with the pixel footprint, preserving its energy.
			// This is deliberately deterministic: no per-frame twinkle or screen-space jitter.
			const variance = radiusSquared.add( footprint.mul( footprint ).mul( 0.18 ) ).toVar();
			const separation = direction.sub( starDir ).toVar();
			const profile = exp( dot( separation, separation ).div( variance ).mul( - 0.5 ) )
				.mul( radiusSquared.div( variance ) ).toVar();
			const temperature = nightHash( cell.add( vec2( 197.1, 7.3 ) ) ).toVar();
			const color = mix( vec3( 1, 0.79, 0.61 ), vec3( 0.72, 0.83, 1 ), temperature );
			const brightness = pow( magnitude, 5 ).mul( 1.55 ).add( 0.045 );
			const horizon = smoothstep( - 0.01, 0.075, direction.y );
			// The narrow polar cap avoids squeezing longitude cells into a bright artificial
			// rosette at the pole, which is outside the island's normal viewing directions.
			const polar = float( 1 ).sub( smoothstep( 0.93, 0.995, abs( direction.y ) ) );
			radiance.assign( color.mul( brightness ).mul( profile ).mul( visibility )
				.mul( horizon ).mul( polar ).mul( SCENE_RADIANCE_SCALE ) );

		} );

	} );
	return radiance;

} ).setLayout( { name: 'soomiNightStars', type: 'vec3', inputs: [
	{ name: 'direction', type: 'vec3' }, { name: 'footprint', type: 'float' },
	{ name: 'visibility', type: 'float' },
] } );

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
		const maria = nightNoise( q.mul( 2.8 ).add( vec2( 7.3, 19.1 ) ) ).mul( 0.75 )
			.add( nightNoise( q.mul( 6.7 ).add( vec2( 23.4, 3.9 ) ) ).mul( 0.25 ) ).toVar();
		const albedo = float( 0.94 ).sub( smoothstep( 0.38, 0.69, maria ).mul( 0.23 ) );
		const horizon = smoothstep( - MOON_ANGULAR_RADIUS, 0.015, direction.y );
		radiance.assign( moonColor.mul( albedo ).mul( terminator ).mul( disk ).mul( horizon ) );

	} );
	return radiance;

} ).setLayout( { name: 'soomiNightMoon', type: 'vec3', inputs: [
	{ name: 'direction', type: 'vec3' }, { name: 'footprint', type: 'float' },
	{ name: 'sunDir', type: 'vec3' }, { name: 'moonDir', type: 'vec3' }, { name: 'moonColor', type: 'vec3' },
] } );

export class NightSky {

	readonly sunDir = uniform( new THREE.Vector3( 1, 0, 0 ) );
	readonly moonDir = uniform( new THREE.Vector3( - 1, 0, 0 ) );
	// Full illuminated disk radiance in scene units. Phase comes only from the directions.
	readonly moonColor = uniform( new THREE.Color( 0.14, 0.16, 0.19 ) );
	readonly starVisibility = uniform( 0 );

	stars( direction: V3, angularFootprint?: F, visibility: F = this.starVisibility ): V3 {

		// The dome derives its pixel footprint before varying control flow. Reflection and
		// bake callers may supply a roughness/texel footprint explicitly, avoiding derivatives
		// in their branches. A separate bake visibility keeps future endpoints off the dome.
		const footprint = max( angularFootprint ?? length( fwidth( direction ) ), 1e-5 ).toVar();
		return nightStars( direction, footprint, clamp( visibility, 0, 1 ) );

	}

	moon( direction: V3 ): V3 {

		const footprint = max( length( fwidth( direction ) ), 1e-5 ).toVar();
		return nightMoon( direction, footprint, this.sunDir, this.moonDir, this.moonColor.rgb );

	}

}
