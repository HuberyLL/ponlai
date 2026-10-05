import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, attribute, cameraPosition, positionGeometry, positionWorld, positionView, uv, uniform,
	texture, textureLoad, textureSize, screenCoordinate, ivec2, vec2, vec3, float, floor, fract, sin, cos, dot, cross, normalize, length,
	abs, max, clamp, mix, smoothstep, exp, select, acos, atan,
} from 'three/tsl';
import { buildFootprint, islandSurfaceHeight, layoutBounds } from '../world/WorldShapes.ts';
import { mulberry32 } from '../world/noise.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

// The veil: shells around the viewer at these distances (metres), each carrying a sheet of
// streaks. Mapped on the sphere about the rain's own direction, streaks converge on its
// vanishing points as in perspective, and a shell shows only where the scene lies beyond it.
const VEIL_SHELLS = [ 5, 9, 16, 28, 48, 80, 130 ];
const DROP_WIDTH = 0.0016; // metres
const STREAK_LENGTH = 0.4; // metres travelled during the eye's exposure
const STREAK_SPACING = 0.22; // metres between columns of drops on a shell

export const RAIN_MAX_DROPS = 640;
const VOLUME_WIDTH = 128;
const VOLUME_HEIGHT = 45;
const FALL_SPEED = 18;
const ANCHOR_STEP = 24;

export interface RainOptions {

	count?: number;
	seed?: number;
	// Return world-space surface height (sea level outside the island). A caller can reuse
	// its existing world field; the default builds a conservative footprint only once.
	groundHeightAt?: ( x: number, z: number ) => number;

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

/** One transparent, depth-tested streak draw. Render it after water in the transparent
 * water target, retaining water depth and rejecting the resolved opaque depth separately.
 * It contributes scene radiance before exposure/tone mapping, with no emissive minimum. */
export class Rain {

	readonly uniforms = {
		time: uniform( 0 ),
		rain: uniform( 0 ),
		wind: uniform( new THREE.Vector2() ), // world-space x/z air velocity, m/s
		light: uniform( new THREE.Color( 0, 0, 0 ) ), // linear scene radiance, supplied by the shared sky/key
		waterLevel: uniform( 0 ),
	};
	readonly mesh: THREE.InstancedMesh;
	private readonly material: THREE.MeshBasicNodeMaterial;
	private readonly ground: THREE.DataTexture;
	private readonly anchor = uniform( new THREE.Vector2() );
	private readonly focus = uniform( new THREE.Vector2() );
	private readonly groundXform: THREE.Vector4;
	private readonly baseOpacity: F;
	private opaqueDepth: THREE.TextureNode | null = null;
	private lightNode: THREE.Node<'vec3'> | null = null;
	// Angle subtended by one pixel, for the veil's energy-preserving streak width.
	readonly pixelAngle = uniform( 0.001 );

	constructor( { count = 384, seed = 8371, groundHeightAt }: RainOptions = {} ) {

		if ( ! Number.isFinite( count ) || count < 0 ) throw new RangeError( 'Rain count must be finite and non-negative' );
		if ( ! Number.isFinite( seed ) ) throw new RangeError( 'Rain seed must be finite' );
		const bounds = layoutBounds(), pad = 4;
		const x0 = bounds.x0 - pad, z0 = bounds.z0 - pad;
		const width = bounds.x1 - bounds.x0 + pad * 2, depth = bounds.z1 - bounds.z0 + pad * 2;
		this.groundXform = new THREE.Vector4( x0, z0, 1 / width, 1 / depth );
		if ( ! groundHeightAt ) {

			const footprint = buildFootprint();
			// The submerged cliff toe extends beyond the upper tile footprint. A conservative
			// 1.8 m guard stops drops at meadow height before they could travel through its wall.
			groundHeightAt = ( x, z ) => footprint.dist( x, z ) < 1.8 ? islandSurfaceHeight( x, z ) + 0.2 : 0;

		}
		// One small, unfiltered world-space height mask handles drifting drops at their current
		// position, including camera recentering. It replaces per-frame CPU collision/respawn.
		const resolution = 128, heights = new Float32Array( resolution * resolution );
		for ( let z = 0; z < resolution; z ++ ) for ( let x = 0; x < resolution; x ++ ) {

			const height = groundHeightAt( x0 + ( x + 0.5 ) / resolution * width, z0 + ( z + 0.5 ) / resolution * depth );
			heights[ z * resolution + x ] = Number.isFinite( height ) ? Math.max( 0, height ) : 0;

		}
		this.ground = new THREE.DataTexture( heights, resolution, resolution, THREE.RedFormat, THREE.FloatType );
		this.ground.name = 'rainGroundHeight';
		this.ground.minFilter = this.ground.magFilter = THREE.NearestFilter;
		this.ground.generateMipmaps = false;
		this.ground.needsUpdate = true;

		const geometry = new THREE.PlaneGeometry( 1, 1 );
		const seeds = new Float32Array( RAIN_MAX_DROPS * 4 );
		const rng = mulberry32( seed );
		for ( let i = 0; i < RAIN_MAX_DROPS; i ++ ) {

			seeds[ i * 4 ] = ( rng() - 0.5 ) * VOLUME_WIDTH;
			seeds[ i * 4 + 1 ] = ( rng() - 0.5 ) * VOLUME_WIDTH;
			seeds[ i * 4 + 2 ] = rng();
			seeds[ i * 4 + 3 ] = 0.55 + rng() * 0.5;

		}
		geometry.setAttribute( 'rainSeed', new THREE.InstancedBufferAttribute( seeds, 4 ) );
		const u = this.uniforms;
		const material = new THREE.MeshBasicNodeMaterial( {
			transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide,
		} );
		material.forceSinglePass = true;
		const particle = attribute<'vec4'>( 'rainSeed', 'vec4' );
		const lifetime = VOLUME_HEIGHT / FALL_SPEED;
		const age = fract( u.time.div( lifetime ).add( particle.z ) );
		const velocity = vec3( u.wind.x.mul( 0.65 ), - FALL_SPEED, u.wind.y.mul( 0.65 ) );
		const drift = u.wind.mul( age.mul( lifetime * 0.65 ) );
		const drifting = particle.xy.add( drift );
		const tile = floor( this.anchor.sub( drifting ).div( VOLUME_WIDTH ).add( 0.5 ) ).mul( VOLUME_WIDTH );
		const horizontal = drifting.add( tile );
		const center = vec3( horizontal.x, float( 1 ).sub( age ).mul( VOLUME_HEIGHT ).add( u.waterLevel ), horizontal.y );
		const tail = normalize( velocity ).negate();
		const across = normalize( cross( tail, cameraPosition.sub( center ) ).add( vec3( 1e-5, 0, 0 ) ) );
		material.positionNode = center.add( across.mul( positionGeometry.x.mul( 0.014 ) ) )
			.add( tail.mul( positionGeometry.y.mul( particle.w ) ) );
		material.colorNode = u.light;
		const q = uv();
		const streak = float( 1 ).sub( smoothstep( 0.10, 0.5, abs( q.x.sub( 0.5 ) ) ) )
			.mul( smoothstep( 0, 0.12, q.y ) ).mul( float( 1 ).sub( smoothstep( 0.55, 1, q.y ) ) );
		const fadeDistance = length( positionWorld.xz.sub( this.focus ) );
		// The 50 m fade radius is smaller than half a tile minus anchor error. Any wrapped
		// particles therefore move outside visibility, leaving nearby rain fixed in world space.
		const volume = float( 1 ).sub( smoothstep( 38, 50, fadeDistance ) );
		const groundXform = uniform( this.groundXform );
		const groundUV = positionWorld.xz.sub( groundXform.xy ).mul( groundXform.zw );
		const insideGround = groundUV.x.greaterThanEqual( 0 ).and( groundUV.x.lessThanEqual( 1 ) )
			.and( groundUV.y.greaterThanEqual( 0 ) ).and( groundUV.y.lessThanEqual( 1 ) );
		const groundY = max( select( insideGround, texture( this.ground, groundUV ).level( float( 0 ) ).r, u.waterLevel ), u.waterLevel );
		const landing = smoothstep( groundY.add( 0.03 ), groundY.add( 0.25 ), positionWorld.y );
		const ceiling = float( 1 ).sub( smoothstep( VOLUME_HEIGHT - 2, VOLUME_HEIGHT, positionWorld.y.sub( u.waterLevel ) ) );
		this.baseOpacity = clamp( u.rain, 0, 1 ).mul( 0.2 ).mul( streak ).mul( volume ).mul( landing ).mul( ceiling );
		material.opacityNode = this.baseOpacity;
		this.material = material;
		this.mesh = new THREE.InstancedMesh( geometry, material, RAIN_MAX_DROPS );
		this.mesh.name = 'weatherRain';
		this.mesh.frustumCulled = false;
		this.mesh.castShadow = this.mesh.receiveShadow = false;
		this.mesh.visible = false;
		this.setQuality( count );

	}

	/** Bind the opaque pass's resolved linear view-Z texture. The water render target keeps
	 * its own depth test; this second test also rejects drops hidden by island/character pixels. */
	bindOpaqueDepth( linearDepth: THREE.Texture ): void {

		if ( this.opaqueDepth ) {

			this.opaqueDepth.value = linearDepth;
			return;

		}
		this.opaqueDepth = texture( linearDepth );
		const size = vec2( textureSize( this.opaqueDepth ) as unknown as THREE.Node<'ivec2'> );
		const pixel = ivec2( clamp( screenCoordinate.xy, vec2( 0 ), size.sub( 1 ) ) );
		const surfaceZ = textureLoad( this.opaqueDepth, pixel ).r;
		// View Z is negative in front of the camera: a nearer drop has the larger value.
		const visibility = smoothstep( 0, 0.08, positionView.z.sub( surfaceZ ) );
		this.material.opacityNode = this.baseOpacity.mul( visibility );
		this.material.needsUpdate = true;

	}

	/** Supply the displayed sky/key radiance directly, including GPU irradiance interpolation. */
	setLightNode( light: THREE.Node<'vec3'> | null ): void {

		this.lightNode = light;
		this.material.colorNode = light ?? this.uniforms.light.rgb;
		this.material.needsUpdate = true;

	}

	/** Radiance the falling rain adds along a view direction, for scene content at `distance`
	 * metres (very large for the sky). Thin drops are widened to a pixel at reduced energy. */
	veil( direction: V3, distance: F ): V3 {

		const u = this.uniforms;
		const light = this.lightNode ?? u.light.rgb;
		const result = vec3( 0 ).toVar();
		If( u.rain.greaterThan( 0.001 ), () => {

			// Axis toward where the rain comes from, tilted by the wind; a frame around it.
			const source = normalize( vec3( u.wind.x.mul( - 0.65 ), FALL_SPEED, u.wind.y.mul( - 0.65 ) ) ).toVar();
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
			result.assign( light.mul( result ).mul( away ).mul( amount.mul( 0.5 ).add( 0.5 ) ).mul( 0.6 ) );

		} );
		return result;

	}

	setQuality( count: number ): void {

		if ( ! Number.isFinite( count ) || count < 0 ) throw new RangeError( 'Rain count must be finite and non-negative' );
		this.mesh.count = Math.min( RAIN_MAX_DROPS, Math.floor( count ) );

	}

	update( camera: THREE.Camera, time: number, viewportHeight = 0 ): void {

		if ( ! Number.isFinite( time ) ) throw new RangeError( 'Rain time must be finite' );
		this.uniforms.time.value = time;
		const fov = ( camera as THREE.PerspectiveCamera ).fov;
		if ( fov && viewportHeight > 0 ) this.pixelAngle.value = 2 * Math.tan( fov * Math.PI / 360 ) / viewportHeight;
		// Keep the island within the bounded rain field when viewing it from the distant sea.
		// Only tile selection snaps; particle positions never inherit continuous camera motion.
		this.focus.value.set( THREE.MathUtils.clamp( camera.position.x * 0.35, - 32, 32 ),
			THREE.MathUtils.clamp( camera.position.z * 0.35, - 32, 32 ) );
		this.anchor.value.set( Math.round( this.focus.value.x / ANCHOR_STEP ) * ANCHOR_STEP,
			Math.round( this.focus.value.y / ANCHOR_STEP ) * ANCHOR_STEP );
		this.mesh.visible = this.mesh.count > 0 && this.uniforms.rain.value > 0.0001;

	}

	dispose(): void {

		this.mesh.geometry.dispose();
		this.material.dispose();
		this.ground.dispose();
		this.mesh.dispose();

	}

}
