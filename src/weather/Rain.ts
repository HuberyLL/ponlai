import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, uniform, vec2, vec3, float, floor, fract, sin, cos, dot, cross, normalize, length,
	abs, max, clamp, mix, smoothstep, exp, select, acos, atan,
} from 'three/tsl';
import { RainCollision } from './RainCollision.ts';
import { DRIFT, MEAN_FALL, RainDrops, lightRain, type RainLight } from './RainDrops.ts';

export { RAIN_MAX_DROPS } from './RainDrops.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

// The veil: shells around the viewer at these distances (metres), each carrying a sheet of
// streaks. Mapped on the sphere about the rain's own direction, streaks converge on its
// vanishing points as in perspective, and a shell shows only where the scene lies beyond it.
const VEIL_SHELLS = [ 48, 80, 130 ];
const DROP_WIDTH = 0.0016; // metres
const STREAK_LENGTH = 0.4; // metres travelled during the eye's exposure
const STREAK_SPACING = 0.22; // metres between columns of drops on a shell

const FALL_SPEED = MEAN_FALL;

export interface RainOptions {

	count?: number;
	seed?: number;

}

// Original analytic impact rings. A cell holds one short-lived ring whose entire support
// stays inside that cell, so two staggered grids need no nine-neighbour search. Ring centres
// change only between faded-out events; the result is deterministic for frozen captures.
const rainHash = Fn( ( [ p ]: [ V2 ] ) => {

	return fract( sin( dot( p, vec2( 71.73, 139.91 ) ) ).mul( 19687.317 ) );

} ).setLayout( { name: 'soomiRainHash', type: 'float', inputs: [ { name: 'p', type: 'vec2' } ] } );

/** World-space height gradient, in metres/metre. Add J-transpose times this gradient to a
 * displaced ocean's parameter-space height gradient before constructing its normal. The
 * caller supplies its existing world-space pixel footprint; no derivatives are taken here. */
export const rainRippleGradient = Fn( ( [ worldXZ, time, rain, footprint ]: [ V2, F, F, F ] ) => {

	const gradient = vec2( 0 ).toVar();
	const filter = float( 1 ).sub( smoothstep( 0.018, 0.075, footprint ) ).toVar();
	If( rain.greaterThan( 0.0001 ).and( filter.greaterThan( 0.001 ) ), () => {

		Loop( 2, ( { i } ) => {

			const layer = float( i ).toVar();
			const grid = worldXZ.mul( 0.625 ).add( vec2( 0.37, 0.61 ).mul( layer ) ).toVar();
			const cell = floor( grid ).toVar();
			const key = cell.add( vec2( 13.9, 7.3 ).mul( layer ) ).toVar();
			const phase = time.mul( mix( 0.83, 1.07, layer ) ).add( rainHash( key ) ).toVar();
			const age = fract( phase ).toVar();
			const event = floor( phase ).toVar();
			const center = vec2( rainHash( key.add( event.mul( 2.31 ) ) ), rainHash( key.add( vec2( 6.1, 3.7 ) ).add( event.mul( 1.73 ) ) ) )
				.mul( 0.24 ).add( 0.38 ).toVar();
			const offset = fract( grid ).sub( center ).mul( 1.6 ).toVar();
			const distance = max( length( offset ), 1e-4 ).toVar();
			const ring = distance.sub( age.mul( 0.39 ) ).toVar();
			const width = age.mul( 0.018 ).add( 0.026 ).toVar();
			const invWidth2 = float( 1 ).div( width.mul( width ) ).toVar();
			const envelope = smoothstep( 0.04, 0.16, age ).mul( float( 1 ).sub( age ).pow( 2 ) )
				.mul( float( 1 ).sub( smoothstep( 0.46, 0.53, distance ) ) ).toVar();
			const wave = ring.mul( 100 ).toVar();
			const slope = exp( ring.mul( ring ).mul( invWidth2 ).negate() )
				.mul( cos( wave ).mul( 100 ).sub( ring.mul( invWidth2 ).mul( 2 ).mul( sin( wave ) ) ) )
				.mul( envelope ).mul( 0.0003 );
			gradient.addAssign( offset.div( distance ).mul( slope ) );

		} );

	} );
	return gradient.mul( clamp( rain, 0, 1 ) ).mul( filter );

} ).setLayout( { name: 'soomiRainRippleGradient', type: 'vec2', inputs: [
	{ name: 'worldXZ', type: 'vec2' }, { name: 'time', type: 'float' },
	{ name: 'rain', type: 'float' }, { name: 'footprint', type: 'float' },
] } );

/** The rain: GPU drops that fall through the scene and splash where they land (RainDrops,
 * with collision against RainCollision's height map), a veil of distant streaks laid over
 * the composite, and the analytic impact rings on the water normal (`rainRippleGradient`). */
export class Rain {

	readonly uniforms = {
		time: uniform( 0 ),
		rain: uniform( 0 ),
		wind: uniform( new THREE.Vector2() ), // world-space x/z air velocity, m/s
		light: uniform( new THREE.Color( 0, 0, 0 ) ), // linear scene radiance, supplied by the shared sky/key
		waterLevel: uniform( 0 ),
	};
	// Angle subtended by one pixel, for the veil's and the drops' energy-preserving widths.
	readonly pixelAngle = uniform( 0.001 );
	readonly collision = new RainCollision();
	readonly drops: RainDrops;
	/** The drops' streak draw; `group` holds it with the splashes. */
	readonly mesh: THREE.Mesh;
	readonly group: THREE.Group;
	private light: RainLight;

	constructor( { count = 32768, seed = 8371 }: RainOptions = {} ) {

		if ( ! Number.isFinite( count ) || count < 0 ) throw new RangeError( 'Rain count must be finite and non-negative' );
		if ( ! Number.isFinite( seed ) ) throw new RangeError( 'Rain seed must be finite' );
		this.drops = new RainDrops( { collision: this.collision, amount: this.uniforms.rain, wind: this.uniforms.wind, pixelAngle: this.pixelAngle, seed } );
		this.mesh = this.drops.streaks;
		this.group = this.drops.group;
		this.group.visible = false;
		this.setQuality( count );
		this.light = { sky: this.uniforms.light.rgb, skySeen: this.uniforms.light.rgb, keyDirection: vec3( 0, 1, 0 ), key: vec3( 0 ) };
		this.drops.setLight( this.light );

	}

	/** Draw the island's collision heights; call once the island and its plants exist. */
	bakeCollision( renderer: THREE.WebGPURenderer, roots: THREE.Object3D[] ): void {

		this.collision.bake( renderer, roots );

	}

	/** Bind the opaque pass's resolved linear view-Z texture. The water render target keeps
	 * its own depth test; this second test also rejects drops hidden by island/character pixels. */
	bindOpaqueDepth( linearDepth: THREE.Texture ): void {

		this.drops.bindOpaqueDepth( linearDepth );

	}

	/** Light the rain from the displayed sky irradiance over pi (including the GPU interpolation,
	 * so it stays in step with sky transitions, and the lightning's fill) and the key light
	 * (direction toward it, linear irradiance), without an emissive floor. `skySeen` is the sky
	 * as the drops show it, if it differs (default `sky`). Null restores the `light` uniform.
	 * Drops take the light around them (`rainRadiance`): grey under a dark deck and at night,
	 * bright only toward the key or in a flash. */
	setLightNode( sky: V3 | null, keyDirection?: V3, keyColor?: V3, skySeen?: V3 ): void {

		const ambient = sky ?? this.uniforms.light.rgb;
		this.light = { sky: ambient, skySeen: skySeen ?? ambient, keyDirection: keyDirection ?? vec3( 0, 1, 0 ), key: keyColor ?? vec3( 0 ) };
		this.drops.setLight( this.light );

	}

	/** The `background` radiance along a view direction seen through the falling rain, for scene
	 * content at `distance` metres (very large for the sky). Thin drops are widened to a pixel at
	 * reduced coverage; each covers the background with the light it takes from around it, so
	 * the veil only lightens what is darker than the rain and dims what is brighter. */
	veil( direction: V3, distance: F, background: V3 ): V3 {

		const u = this.uniforms;
		const output = background.toVar();
		const result = float( 0 ).toVar();
		If( u.rain.greaterThan( 0.001 ), () => {

			// Axis toward where the rain comes from, tilted by the wind; a frame around it.
			const source = normalize( vec3( u.wind.x.mul( - DRIFT ), FALL_SPEED, u.wind.y.mul( - DRIFT ) ) ).toVar();
			const side = normalize( cross( source, vec3( 0, 0, 1 ) ) ).toVar();
			const other = cross( source, side ).toVar();
			const cosine = clamp( dot( direction, source ), - 1, 1 ).toVar();
			const polar = acos( cosine ).toVar(); // 0 toward the source, pi along the fall
			const azimuth = atan( dot( direction, other ), dot( direction, side ) ).div( 2 * Math.PI ).add( 0.5 ).toVar();
			// Columns crowd toward both vanishing points; fade them out before they alias.
			const away = smoothstep( 0.12, 0.45, abs( sin( polar ) ) ).toVar();
			const amount = clamp( u.rain, 0, 1 ).toVar();
			for ( const [ index, radius ] of VEIL_SHELLS.entries() ) {

				const columns = Math.round( 2 * Math.PI * radius / STREAK_SPACING );
				const column = azimuth.mul( columns ).toVar();
				const cell = floor( column ).toVar();
				const seed = vec2( cell, index * 17.13 ).toVar();
				// Arc length along the fall, scrolling at the fall speed with a per-column offset.
				const fall = polar.mul( radius ).sub( u.time.mul( FALL_SPEED * ( 0.9 + 0.04 * index ) ) ).sub( rainHash( seed ).mul( 37 ) ).toVar();
				const row = floor( fall.div( STREAK_LENGTH * 2.6 ) ).toVar();
				const along = fract( fall.div( STREAK_LENGTH * 2.6 ) ).mul( 2.6 ).toVar();
				const present = rainHash( vec2( cell.add( row.mul( 0.618 ) ), row.add( index * 3.7 ) ) ).lessThan( amount.mul( 0.8 ) );
				const centre = rainHash( seed.add( row ) ).mul( 0.6 ).add( 0.2 );
				// Angular half-width of the streak, at least half a pixel; energy kept by the ratio.
				const drop = DROP_WIDTH / radius;
				const halfWidth = max( float( drop ), this.pixelAngle.mul( 0.5 ) ).toVar();
				const across = abs( fract( column ).sub( centre ) ).mul( 2 * Math.PI / columns ).mul( sin( polar ) );
				const profile = float( 1 ).sub( smoothstep( halfWidth.mul( 0.4 ), halfWidth, across ) ).mul( float( drop ).div( halfWidth ) );
				// Each drop has its own brightness: some catch the light, most are faint.
				const glint = rainHash( seed.add( row.mul( 1.31 ) ).add( 5.1 ) ).pow( 2 ).mul( 1.6 ).add( 0.25 );
				const streak = smoothstep( 0, 0.15, along ).mul( float( 1 ).sub( smoothstep( 0.6, 1, along ) ) ).mul( glint );
				const shown = smoothstep( radius * 0.9, radius * 1.1, distance );
				result.addAssign( select( present, profile.mul( streak ).mul( shown ), float( 0 ) ) );

			}
			const coverage = clamp( result.mul( away ).mul( amount.mul( 0.5 ).add( 0.5 ) ), 0, 1 );
			const drop = lightRain( direction, this.light, float( 0 ) );
			output.assign( mix( background, drop, coverage ) );

		} );
		return output;

	}

	/** Follow the composite's tilt-shift focus (distance and sharp range in metres, the widest
	 * blur in pixels, its strength), so drops blur as the scene around them does. */
	setFocus( distance: number, range: number, radius: number, strength: number ): void {

		const f = this.drops.focus;
		f.distance.value = Math.max( distance, 1 );
		f.range.value = range;
		f.radius.value = radius;
		f.strength.value = strength;

	}

	setQuality( count: number ): void {

		if ( ! Number.isFinite( count ) || count < 0 ) throw new RangeError( 'Rain count must be finite and non-negative' );
		this.drops.setCount( count );

	}

	/** Advance the drops to `time` for this camera and run their simulation. `displacement`
	 * is the wind's integrated travel (m), which carries the drops. */
	update( renderer: THREE.WebGPURenderer, camera: THREE.Camera, time: number, displacement: THREE.Vector2, viewportHeight = 0 ): void {

		if ( ! Number.isFinite( time ) ) throw new RangeError( 'Rain time must be finite' );
		this.uniforms.time.value = time;
		const fov = ( camera as THREE.PerspectiveCamera ).fov;
		if ( fov && viewportHeight > 0 ) this.pixelAngle.value = 2 * Math.tan( fov * Math.PI / 360 ) / viewportHeight;
		this.collision.waterLevel.value = this.uniforms.waterLevel.value;
		const visible = this.drops.count > 0 && this.uniforms.rain.value > 0.0001;
		this.group.visible = this.mesh.visible = visible;
		if ( ! visible ) return;
		this.drops.update( camera, time, displacement );
		renderer.compute( this.drops.compute );

	}

	dispose(): void {

		this.drops.dispose();
		this.collision.dispose();

	}

}
