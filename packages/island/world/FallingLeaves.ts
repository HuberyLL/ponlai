import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, instancedArray, instanceIndex, uniform, varying, positionGeometry, normalLocal, materialColor, texture,
	vec2, vec3, vec4, float, int, uint, floor, fract, select, max, mix, clamp, smoothstep, sin, cos, mx_noise_vec3,
} from 'three/tsl';
import { type Shared, type ExtraPass, gustAt, windBefore, type Wind, vegetationMaterial, type LeafAtlas, receiveScreenAO, receiveScreenShadow, debugFlags } from '../../render/index.ts';
import type { WorldFields } from './WorldFields.ts';
import { ISLAND_TOP } from './WorldShapes.ts';
import { SOIL_EXTENT, SOIL_HEIGHT_RANGE, soilGroveSwell } from '../materials/Soil.ts';
import { LEAF_TINTS, LEAF_TRANSLUCENCY } from './BambooMaterials.ts';

// Bamboo leaves the wind takes off the island: a pool of leaves simulated on the GPU, one compute
// pass on the frame graph (`leavesPass`), drawn as one instanced mesh in the opaque scene.
//
// The pool is a ring of CAPACITY slots, fixed at load, so a Grow or a change of weather swaps no
// buffer and builds no pipeline. Births. Each frame the main thread turns the scene clock's step
// times the attempt rate, k pi R^2 U (U the mean wind's speed, no gusts), into a whole count,
// carrying the fraction to the next frame, and the slots after a write pointer (which wraps at the
// capacity) take that many new leaves: no atomics, free list or compaction. A leaf lives under
// LIFE[ 1 ] seconds, and the capacity covers the strongest kept wind's births over that, so the
// ring never overwrites a living leaf there. A new leaf's point is drawn uniformly by area over a
// disc of RADIUS around the camera's target (where the view looks, not the camera, which stands
// tens of metres off in the air), and dropped within CLEAR of the camera itself (no leaf born
// against the lens) or off the land (the shore field): so the leaves appear wherever the view is
// and never over the sea, and the births that stand are k times the land inside the disc times U.
// A leaf that stands starts 5 to 12 m over the ground there. Its point, life, fall speed, size,
// spin, tilt and tint are hashes of the scene clock's whole-step count and its place in the
// frame's births, so a stepped clip replays; the sky's leaves depend on the camera's path, which
// rendering history may (AGENTS.md).
//
// Motion, at fixed steps of STEP seconds on a grid of the scene clock: a frame takes the steps it
// crosses and draws between the last two by the fraction past the last; each step reads the frame's
// wind moved back to the step's time (Wind.ts `windBefore`, so the gusts' scroll and time are still
// read in Wind.ts alone). A leaf's velocity relaxes at RELAX toward the air's, the mean wind times
// a gust factor (`gustAt` where the leaf is: 1 up to the weather's gustiness) times a gain by
// height over the ground (HEIGHT_GAIN: still air at the ground, a fast thin layer just above it,
// slower aloft), plus a divergence-free turbulence (`leafCurl`, the curl of a noise potential whose
// vertical component is the strongest, so it swirls mostly level), and falls at its own terminal
// speed in still air; symplectic Euler. It spins about the vertical at its own rate and keeps its
// birth tilt. Within LAND_GAP of the ground with the force downward it lands: velocity zero, and
// from then it reads only the ground's height at its point (the plateau from the soil map, Soil.ts,
// or the sea level off the land), so a grown island carries it, and lies down within FLATTEN
// seconds to REST_TILT. It fades in and out by its size over the ends of its life. A frame born
// leaves take their first step at the next frame.
//
// History. A scene jump or a load (`reset`) clears the pool and prewarms it in one dispatch of a
// second kernel (`prewarm`, only then): the births of the last LIFE[ 1 ] seconds at the present
// rate, in the present disc, each integrated from its birth to now with the same step (the steps
// a prewarm replays take the present wind moved back to their time, Wind.ts `windBefore`, as the
// live steps of a frame do between its wind's updates), so the sky holds its steady count at once.
// A Grow needs nothing: new land takes births from the next frame, and landed leaves follow the
// ground. The test mode turns the leaves off whole (main.ts does not make them: TestMode.ts), so
// `settled` never waits for them; outside it their frames are compared within a tolerance.
//
// Drawn with the bamboo crowns' leaf light (vegetation/Material.ts's 'leaf' family: alpha to
// coverage under MSAA, the vegetation tag, translucency, the screen-space AO and shade), from one
// leaf of the bamboo's own atlas (BambooMaterials.ts `singleLeaf`) tinted per leaf in the crowns'
// mix of colours. It casts no shadow and stays out of the water's reflection (its box ends at 3 m:
// a leaf of this size reads as nothing there). Under the temporal modes it writes its motion from
// the previous rendered frame's position, angle and tilt, which the kernels keep once per frame.
// `debugFlags.fallingLeaves = false` skips the pass and hides the leaves (read every frame; on
// unless false); turned back on, the pool goes on from where it stopped.

type F = THREE.Node<'float'>;
type I = THREE.Node<'int'>;
type U = THREE.Node<'uint'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

/** The fixed step, s. */
const STEP = 1 / 60;
/** The steps' epoch, s: steps are counted from its start (a whole number of turbulence shapes). */
const EPOCH = 24;
const EPOCH_STEPS = Math.round( EPOCH / STEP );
/** The ring's slots. */
export const CAPACITY = 8192;
/** Births per second per m² of land per m/s of mean wind. */
const RATE = 0.5e-3;
/** The births' disc around the camera's target, and the clearance around the camera, m. */
const RADIUS = 120;
const CLEAR = 9;
/** A leaf's life, s, and its fall speed in still air, m/s (each uniform between the two). */
const LIFE: readonly [ number, number ] = [ 17, 19 ];
const FALL: readonly [ number, number ] = [ 1.5, 1.8 ];
/** The birth height over the ground, m. */
const BIRTH_HEIGHT: readonly [ number, number ] = [ 5, 12 ];
/** The relaxation rate toward the air's velocity, 1/s. */
const RELAX = 0.6;
/** The gain on the wind by height over the ground (m, gain), linear between the keys. */
const HEIGHT_GAIN: readonly ( readonly [ number, number ] )[] = [ [ 0, 0.05 ], [ 0.05, 0.5 ], [ 0.2, 0.3 ], [ 3, 0.1 ] ];
/** The turbulence: its cell, m, how long one shape holds, s, the share of its potential's level
 * components (the vertical one 1), its strength per m/s of mean wind, and how far it drifts with
 * the wind (a share of the wind's displacement). */
const TURB_CELL = 2.5;
const TURB_SHAPE = 6;
const TURB_LEVEL = 0.4;
const TURB = 0.25;
const TURB_DRIFT = 0.01;
/** The spin about the vertical, rad/s: |omega| = SPIN[ 0 ] + SPIN[ 1 ] r^SPIN[ 2 ], either sign. */
const SPIN: readonly [ number, number, number ] = [ 0.5, 5.5, 1.3 ];
/** The leaf's tilt in flight (its normal from the vertical, degrees) by a uniform hash: a quantile
 * function through these keys. */
const TILT: readonly ( readonly [ number, number ] )[] = [ [ 0, 0 ], [ 0.1, 8 ], [ 0.5, 35 ], [ 0.9, 70 ], [ 1, 85 ] ];
/** Landing: the gap to the ground, m; the time to lie down, s; the tilt it lies at, degrees. */
const LAND_GAP = 0.03;
const FLATTEN = 0.4;
const REST_TILT = 10;
/** The quad's side, m, times a hashed SIZE[ 0 ]..SIZE[ 1 ]; its lift over the ground, m. */
const LEAF_SIZE = 0.6;
const SIZE: readonly [ number, number ] = [ 0.7, 1.3 ];
const LIFT = 0.02;
/** The share of a life over which a leaf fades in, and out. */
const FADE_IN = 0.05;
const FADE_OUT = 0.1;
/** The most steps a frame takes (main.ts caps a frame's step at 1/20 s). */
const MAX_STEPS = 4;
const DEG = Math.PI / 180;

// leaf states
const NONE = 0, FLYING = 1, LANDED = 2;

// PCG's output permutation on one word (Jarzynski and Olano, "Hash Functions for GPU Rendering",
// JCGT 2020).
function pcg( n: U ): U {

	const state = n.mul( uint( 747796405 ) ).add( uint( 2891336453 ) );
	const word = state.shiftRight( state.shiftRight( uint( 28 ) ).add( uint( 4 ) ) ).bitXor( state ).mul( uint( 277803737 ) );
	return word.shiftRight( uint( 22 ) ).bitXor( word );

}

/** A hash of two words and a salt, as a word. */
const hashWord = ( a: U, b: U, salt: number ): U => pcg( pcg( b.add( uint( salt * 0x9e3779b9 >>> 0 ) ) ).bitXor( a ) );
/** The same in 0..1. */
const hashUnit = ( a: U, b: U, salt: number ): F => float( hashWord( a, b, salt ).shiftRight( uint( 8 ) ) ).mul( 1 / 16777216 );
/** A leaf's value of a salt, from its seed. */
const leafUnit = ( seed: U, salt: number ): F => hashUnit( seed, uint( 0 ), salt );

/** A piecewise-linear function through `keys` ( x, y ), constant past the ends. */
function piecewise( x: F, keys: readonly ( readonly [ number, number ] )[] ): F {

	let result: F = float( keys[ keys.length - 1 ][ 1 ] );
	for ( let i = keys.length - 2; i >= 0; i -- ) {

		const [ x0, y0 ] = keys[ i ], [ x1, y1 ] = keys[ i + 1 ];
		const segment = mix( float( y0 ), float( y1 ), clamp( x.sub( x0 ).div( x1 - x0 ), 0, 1 ) );
		result = select( x.lessThan( x1 ), segment, result );

	}
	return result;

}

// The turbulence's velocity at p (noise cells): the curl of a potential psi = ( TURB_LEVEL n.x,
// n.y, TURB_LEVEL n.z ), n a vector noise, by central differences; divergence-free, its level
// components ( d psi_z / dy - d psi_y / dz, d psi_y / dx - d psi_x / dy ) carried by the strong
// vertical potential. (Curl noise: Bridson, Hourihan and Nordenstam, SIGGRAPH 2007.)
const leafCurl = /*@__PURE__*/ Fn( ( [ p ]: [ V3 ] ) => {

	const e = 0.1;
	const dx = mx_noise_vec3( p.add( vec3( e, 0, 0 ) ) ).sub( mx_noise_vec3( p.sub( vec3( e, 0, 0 ) ) ) ).toVar();
	const dy = mx_noise_vec3( p.add( vec3( 0, e, 0 ) ) ).sub( mx_noise_vec3( p.sub( vec3( 0, e, 0 ) ) ) ).toVar();
	const dz = mx_noise_vec3( p.add( vec3( 0, 0, e ) ) ).sub( mx_noise_vec3( p.sub( vec3( 0, 0, e ) ) ) ).toVar();
	return vec3(
		dy.z.mul( TURB_LEVEL ).sub( dz.y ),
		dz.x.sub( dx.z ).mul( TURB_LEVEL ),
		dx.y.sub( dy.x.mul( TURB_LEVEL ) ),
	).mul( 1 / ( 2 * e ) );

} ).setLayout( { name: 'leafCurl', type: 'vec3', inputs: [ { name: 'p', type: 'vec3' } ] } );

/** A leaf's quad corner (geometry x, y in -0.5..0.5) placed: laid level, tilted by `tilt` about its
 * length, turned by `angle` about the vertical, at `centre`. */
function leafCorner( centre: V3, angle: F, tilt: F, scale: F ): V3 {

	const g = positionGeometry;
	const z = g.y.negate().mul( scale );
	const y = z.mul( sin( tilt ) ).negate(), zt = z.mul( cos( tilt ) );
	const x = g.x.mul( scale );
	const c = cos( angle ), s = sin( angle );
	return centre.add( vec3( x.mul( c ).add( zt.mul( s ) ), y, x.mul( s ).negate().add( zt.mul( c ) ) ) );

}

export interface FallingLeavesOptions {
	shared: Shared;
	fields: WorldFields;
	/** The soil map (Soil.ts): the plateau's height. */
	soil: THREE.Texture;
	wind: Wind;
	atlas: LeafAtlas;
}

export class FallingLeaves {

	readonly mesh: THREE.Mesh;
	/** The live step, every frame but a reset's. */
	readonly kernel: THREE.ComputeNode;
	/** The reset: clears the pool and prewarms it, in a reset's frame only. */
	readonly prewarm: THREE.ComputeNode;
	private readonly wind: Wind;
	private readonly u = {
		last: uniform( 0, 'int' ), // the last step taken, counted from the epoch's start
		steps: uniform( 0, 'int' ), // the steps this frame takes
		alpha: uniform( 0 ), // the fraction of a step past the last
		slice: uniform( 0, 'int' ), // the epoch's first turbulence shape
		frame: uniform( 0, 'uint' ), // the scene clock's whole-step count: the births' hash
		head: uniform( 0, 'uint' ), // the write pointer: the first slot this frame's births take
		count: uniform( 0, 'uint' ), // this frame's births (a reset's: the prewarm's)
		rate: uniform( 1 ), // the attempt rate, 1/s
		centre: uniform( new THREE.Vector2() ), // the births' disc's centre, x z
		eye: uniform( new THREE.Vector2() ), // the camera, x z
		gust: uniform( 1 ), // the gust factor's top
		turbulence: uniform( 0 ), // the turbulence's strength, m/s
	};
	private lastStep = 0;
	private resetPending = true;
	private head = 0;
	// the births' fraction carried to the next frame
	private carry = 0;
	/** This frame resets the pool: the pass dispatches `prewarm` instead of `kernel`. */
	resetting = false;
	private readonly buffers: Record<'pos' | 'vel' | 'state', THREE.StorageBufferNode<'vec4'>>;

	constructor( { shared, fields, soil, wind, atlas }: FallingLeavesOptions ) {

		this.wind = wind;
		const u = this.u;
		const pos = instancedArray( CAPACITY, 'vec4' ); // xyz, angle
		const vel = instancedArray( CAPACITY, 'vec4' ); // velocity, age
		const state = instancedArray( CAPACITY, 'vec4' ); // mode, time since landing, a hash for the colour, the leaf's seed
		const before = instancedArray( CAPACITY, 'vec4' ); // pos before the last step
		const shown = instancedArray( CAPACITY, 'vec4' ); // drawn: centre, angle
		const shownPrev = instancedArray( CAPACITY, 'vec4' ); // the previous rendered frame's
		const look = instancedArray( CAPACITY, 'vec4' ); // drawn: size, tilt; the previous frame's
		this.buffers = { pos, vel, state };
		const w = shared.wind;

		const groundOf = ( xz: V2 ) => {

			const shore = fields.shore.sample( xz.sub( shared.shoreXform.xy ).mul( shared.shoreXform.zw ) ).level( float( 0 ) ).r;
			const top = texture( soil, xz.div( SOIL_EXTENT ).add( 0.5 ) ).depth( float( 0 ) ).level( float( 0 ) ).r;
			const plateau = float( ISLAND_TOP ).add( soilGroveSwell( soil, xz ).swell ).add( top.sub( 0.5 ).mul( SOIL_HEIGHT_RANGE ) );
			const land = shore.lessThan( 0 ).toVar();
			return { land, height: select( land, plateau, shared.waterLevel ).toVar() };

		};

		// the body both kernels share: `prewarm` clears the slot and gives the first `count` slots
		// the last LIFE[ 1 ] seconds' births, integrated from each one's birth; the live kernel
		// gives the `count` slots from `head` this frame's births and steps the rest
		const simulate = ( prewarm: boolean ) => Fn( () => {

			const i = instanceIndex;
			const p = pos.element( i ).toVar();
			const v = vel.element( i ).toVar();
			const st = state.element( i ).toVar();
			const prior = before.element( i ).toVar();
			const seed = uint( st.w ).toVar();
			shownPrev.element( i ).assign( shown.element( i ) );
			const lookNow = look.element( i ).toVar();
			const lifeOf = ( n: U ) => mix( float( LIFE[ 0 ] ), float( LIFE[ 1 ] ), leafUnit( n, 2 ) );

			// a leaf born from a hash of the frame and its place in the frame's births: it stands if
			// its point in the disc is on land and clear of the camera
			const spawn = ( place: U, salt: number ) => {

				seed.assign( hashWord( u.frame, place, salt ).shiftRight( uint( 8 ) ) );
				const r = leafUnit( seed, 3 ).sqrt().mul( RADIUS ), a = leafUnit( seed, 4 ).mul( Math.PI * 2 );
				const xz = u.centre.add( vec2( cos( a ), sin( a ) ).mul( r ) ).toVar();
				const ground = groundOf( xz );
				st.assign( vec4( NONE, 0, leafUnit( seed, 15 ), float( seed ) ) );
				If( ground.land.and( xz.sub( u.eye ).length().greaterThanEqual( CLEAR ) ), () => {

					const y = ground.height.add( mix( float( BIRTH_HEIGHT[ 0 ] ), float( BIRTH_HEIGHT[ 1 ] ), leafUnit( seed, 5 ) ) );
					p.assign( vec4( xz.x, y, xz.y, leafUnit( seed, 6 ).mul( Math.PI * 2 ) ) );
					v.assign( vec4( 0 ) );
					st.x.assign( FLYING );
					prior.assign( p );

				} );

			};

			// one fixed step, s
			const step = ( s: I ) => {

				If( st.x.notEqual( NONE ), () => {

					prior.assign( p );
					v.w.addAssign( STEP );
					If( v.w.greaterThan( lifeOf( seed ) ), () => {

						st.x.assign( NONE );

					} ).ElseIf( st.x.equal( FLYING ), () => {

						// the wind's state at this step: the frame's moved back to it (Wind.ts)
						const back = float( u.last.sub( s ) ).add( u.alpha ).mul( STEP ).toVar();
						const air = windBefore( w, back );
						const drift = air.displacement;
						const ground = groundOf( p.xz );
						const height = p.y.sub( ground.height ).toVar();
						const gust = mix( float( 1 ), u.gust, clamp( gustAt( air, p.xz ).mul( 1.5 ), 0, 1 ) );
						// the turbulence: its shape crossfaded between slices TURB_SHAPE apart, each at an offset of its own
						const t = float( s ).mul( STEP / TURB_SHAPE ).toVar();
						const k = int( floor( t ) ).add( u.slice ).toVar();
						const q = p.xyz.sub( vec3( drift.x, 0, drift.y ).mul( TURB_DRIFT ) ).div( TURB_CELL ).toVar();
						const offset = ( slice: I ) => {

							const h = uint( slice.bitAnd( int( 255 ) ) );
							return vec3( hashUnit( h, uint( 0 ), 7 ), hashUnit( h, uint( 0 ), 8 ), hashUnit( h, uint( 0 ), 9 ) ).mul( 64 );

						};
						const turbulence = mix( leafCurl( q.add( offset( k ) ) ), leafCurl( q.add( offset( k.add( int( 1 ) ) ) ) ), smoothstep( 0, 1, fract( t ) ) );
						const target = vec3( w.velocity.x, 0, w.velocity.y ).mul( piecewise( height, HEIGHT_GAIN ).mul( gust ) ).add( turbulence.mul( u.turbulence ) );
						const fall = mix( float( FALL[ 0 ] ), float( FALL[ 1 ] ), leafUnit( seed, 10 ) );
						const a = target.sub( v.xyz ).sub( vec3( 0, fall, 0 ) ).mul( RELAX ).toVar();
						If( height.lessThan( LAND_GAP ).and( a.y.lessThan( 0 ) ), () => {

							v.xyz.assign( vec3( 0 ) );
							p.y.assign( ground.height );
							st.xy.assign( vec2( LANDED, 0 ) );

						} ).Else( () => {

							v.xyz.addAssign( a.mul( STEP ) );
							p.xyz.addAssign( v.xyz.mul( STEP ) );
							const r = leafUnit( seed, 11 );
							const spin = r.pow( SPIN[ 2 ] ).mul( SPIN[ 1 ] ).add( SPIN[ 0 ] );
							p.w.addAssign( select( leafUnit( seed, 12 ).lessThan( 0.5 ), spin, spin.negate() ).mul( STEP ) );

						} );

					} ).Else( () => {

						// landed: on the ground where it lies, which a Grow may move
						p.y.assign( groundOf( p.xz ).height );
						st.y.addAssign( STEP );

					} );

				} );

			};

			const stepTo = ( from: I ) => {

				Loop( { start: from, end: u.last, type: 'int', condition: '<=' }, ( { i: s } ) => {

					step( s as unknown as I );

				} );

			};
			if ( prewarm ) {

				st.assign( vec4( NONE, 0, 0, 0 ) );
				p.assign( vec4( 0 ) );
				v.assign( vec4( 0 ) );
				prior.assign( p );
				If( i.lessThan( u.count ), () => {

					// slot i holds the birth ( i + 0.5 ) / rate seconds ago, in steps
					const ago = int( floor( float( i ).add( 0.5 ).div( u.rate.mul( STEP ) ).add( 0.5 ) ) ).toVar();
					spawn( i, 16 );
					stepTo( u.last.sub( ago ).add( int( 1 ) ) );

				} );

			} else {

				const place = i.add( uint( CAPACITY ) ).sub( u.head ).mod( uint( CAPACITY ) ).toVar();
				If( place.lessThan( u.count ), () => {

					spawn( place, 0 );

				} ).Else( () => {

					stepTo( u.last.sub( u.steps ).add( int( 1 ) ) );

				} );

			}

			pos.element( i ).assign( p );
			vel.element( i ).assign( v );
			state.element( i ).assign( st );
			before.element( i ).assign( prior );

			// what is drawn: between the last two steps; sized by the fades; landed, lying down
			const life = lifeOf( seed ).toVar();
			const age = v.w;
			const fade = smoothstep( 0, life.mul( FADE_IN ), age ).mul( float( 1 ).sub( smoothstep( life.mul( 1 - FADE_OUT ), life, age ) ) );
			const size = mix( float( SIZE[ 0 ] ), float( SIZE[ 1 ] ), leafUnit( seed, 13 ) ).mul( LEAF_SIZE );
			const scale = select( st.x.equal( NONE ), float( 0 ), size.mul( fade ) ).toVar();
			const flight = piecewise( leafUnit( seed, 14 ), TILT ).mul( DEG );
			const flat = select( st.x.equal( LANDED ), clamp( st.y.div( FLATTEN ), 0, 1 ), float( 0 ) );
			const tilt = mix( flight, float( REST_TILT * DEG ), smoothstep( 0, 1, flat ) ).toVar();
			const at = mix( prior, p, u.alpha ).toVar();
			// clear of the ground by its tilted half width
			at.y.assign( max( at.y, groundOf( at.xz ).height.add( scale.mul( 0.5 ).mul( sin( tilt ) ) ).add( LIFT ) ) );
			shown.element( i ).assign( at );
			if ( prewarm ) {

				// a reset leaves no motion behind it
				shownPrev.element( i ).assign( at );
				look.element( i ).assign( vec4( scale, tilt, scale, tilt ) );

			} else {

				look.element( i ).assign( vec4( scale, tilt, lookNow.xy ) );

			}

		} )().compute( CAPACITY, [ 64 ] ).setName( prewarm ? 'falling leaves prewarm' : 'falling leaves' );
		this.kernel = simulate( false );
		this.prewarm = simulate( true );

		// ---- the draw
		const now = shown.toAttribute() as unknown as V4;
		const was = shownPrev.toAttribute() as unknown as V4;
		const looks = look.toAttribute() as unknown as V4;
		const position = leafCorner( now.xyz, now.w, looks.y, looks.x );
		const previous = leafCorner( was.xyz, was.w, looks.w, looks.z );
		// the crowns' mix of colours, picked by share
		const pick = ( state.toAttribute() as unknown as V4 ).z;
		let colour: V3 = vec3( ...LEAF_TINTS[ LEAF_TINTS.length - 1 ].tint );
		let end = 1;
		for ( let k = LEAF_TINTS.length - 2; k >= 0; k -- ) {

			end -= LEAF_TINTS[ k + 1 ].share;
			colour = select( pick.lessThan( end ), vec3( ...LEAF_TINTS[ k ].tint ), colour );

		}
		const leafTint = varying( colour, 'vFallingLeafTint' );
		const material = vegetationMaterial( shared, {
			family: 'leaf', name: 'falling leaves', roughness: 0.75,
			leaf: { map: atlas.map, alphaMap: atlas.alpha },
			wet: { tint: 0.75, roughness: 0.25 },
			color: ( wet ) => materialColor.mul( vec4( leafTint.mul( wet ).mul( shared.leafGain ), 1 ) ),
			rest: position,
			displacement: () => position,
			previous: () => previous,
			beforePosition: () => {

				const tilt = looks.y, angle = now.w;
				normalLocal.assign( vec3( sin( tilt ).mul( sin( angle ) ), cos( tilt ), sin( tilt ).mul( cos( angle ) ) ) );

			},
			light: { scale: float( 1 ), translucency: LEAF_TRANSLUCENCY },
		} );
		receiveScreenAO( material );
		receiveScreenShadow( material );
		const mesh = new THREE.Mesh( new THREE.PlaneGeometry( 1, 1 ), material );
		mesh.name = 'falling leaves';
		mesh.count = CAPACITY;
		mesh.frustumCulled = false;
		mesh.castShadow = false;
		mesh.receiveShadow = true;
		this.mesh = mesh;

	}

	/** The pass will dispatch this frame (and the mesh draws). */
	get active(): boolean {

		return debugFlags.fallingLeaves !== false;

	}

	/** The frame's uniforms at scene time `time` (s), before the frame renders: the births' disc
	 * around `target` (the camera's, or the camera itself in free flight), clear of `eye`. */
	update( time: number, target: THREE.Vector3, eye: THREE.Vector3 ): void {

		const u = this.u;
		this.mesh.visible = this.active;
		// (off, the pool waits: back on, it takes at most MAX_STEPS and goes on)
		if ( ! this.active ) return;
		const step = Math.floor( time / STEP );
		const epoch = Math.floor( step / EPOCH_STEPS );
		u.last.value = step - epoch * EPOCH_STEPS;
		u.alpha.value = time / STEP - step;
		u.slice.value = ( epoch * ( EPOCH / TURB_SHAPE ) ) % 256;
		u.frame.value = step >>> 0;
		const reset = this.resetPending || step < this.lastStep;
		const steps = reset ? 0 : Math.min( step - this.lastStep, MAX_STEPS );
		this.resetPending = false;
		this.resetting = reset;
		this.lastStep = step;
		const speed = this.wind.speed;
		const rate = RATE * Math.PI * RADIUS * RADIUS * speed;
		u.steps.value = steps;
		u.rate.value = Math.max( rate, 1e-6 );
		u.centre.value.set( target.x, target.z );
		u.eye.value.set( eye.x, eye.z );
		u.gust.value = this.wind.gustiness;
		u.turbulence.value = TURB * speed;
		if ( reset ) {

			// the last LIFE[ 1 ] seconds' births
			const count = Math.min( Math.floor( rate * LIFE[ 1 ] ), CAPACITY );
			u.count.value = count;
			this.head = count % CAPACITY;
			this.carry = 0;
			return;

		}
		this.carry += steps * STEP * rate;
		const count = Math.min( Math.floor( this.carry ), CAPACITY );
		this.carry -= Math.floor( this.carry );
		u.head.value = this.head;
		u.count.value = count;
		this.head = ( this.head + count ) % CAPACITY;

	}

	/** A scene jump: the next frame clears and prewarms the pool. */
	reset(): void {

		this.resetPending = true;

	}

	/** (debug) The pool read back: leaves alive, flying and landed, and the flying leaves' speeds
	 * over the mean wind (median and p90) and level share of their speed. */
	async stats( renderer: THREE.WebGPURenderer ): Promise<{ alive: number; flying: number; landed: number; speedMedian: number; speedP90: number; level: number }> {

		const read = async ( node: THREE.StorageBufferNode<'vec4'> ) => new Float32Array( await renderer.getArrayBufferAsync( node.value as THREE.StorageBufferAttribute ) );
		const [ vel, state ] = await Promise.all( [ read( this.buffers.vel ), read( this.buffers.state ) ] );
		const speeds: number[] = [];
		let flying = 0, landed = 0, level = 0, total = 0;
		const U = Math.max( this.wind.speed, 1e-6 );
		for ( let k = 0; k < CAPACITY; k ++ ) {

			const mode = state[ k * 4 ];
			if ( mode === LANDED ) landed ++;
			if ( mode !== FLYING ) continue;
			flying ++;
			const x = vel[ k * 4 ], y = vel[ k * 4 + 1 ], z = vel[ k * 4 + 2 ];
			const s = Math.hypot( x, y, z );
			speeds.push( s / U );
			level += Math.hypot( x, z );
			total += s;

		}
		speeds.sort( ( a, b ) => a - b );
		const at = ( q: number ) => speeds.length ? speeds[ Math.min( speeds.length - 1, Math.floor( q * speeds.length ) ) ] : 0;
		return { alive: flying + landed, flying, landed, speedMedian: at( 0.5 ), speedP90: at( 0.9 ), level: total > 0 ? level / total : 0 };

	}

}

/** The leaves' compute pass as an extra pass of the pipeline (post/ExtraPass.ts), declared before
 * the scene passes: fixed in size (the ring's slots), reading and writing only its own buffers; a
 * reset's frame dispatches the prewarm instead of the live step. `leaves` gives the pool once the
 * world exists (the warm-up runs before, and `main.ts` registers both kernels as latents then), or
 * null when the test mode leaves it out. Its declarations: no tier changes its cost; it keeps the
 * leaves' flight from frame to frame, which the test mode turns off whole (the pool is not made,
 * so nothing waits for it); a Grow needs nothing of it (see the header). */
export function leavesPass( leaves: () => FallingLeaves | null ): ExtraPass {

	return {
		name: 'falling leaves',
		cost: 'none',
		testMode: { held: 'off', by: 'the page, which does not make the pool in the test mode (debug/TestMode.ts)', settled: 'nothing: it does not run' },
		land: 'independent',
		declare: ( g ) => {

			g.addPass( 'fallingLeaves', 'compute', () => ( {
				label: 'falling leaves', size: { of: 'fixed', width: CAPACITY, height: 1 }, neverCull: true,
				when: () => leaves()?.active === true, whenLabel: 'falling leaves',
				compute: () => {

					const pool = leaves();
					return pool ? [ pool.kernel, pool.prewarm ] : null;

				},
				run: ( _f, graph ) => {

					const pool = leaves();
					if ( pool ) graph.renderer.compute( pool.resetting ? pool.prewarm : pool.kernel );

				},
			} ) );

		},
	};

}
