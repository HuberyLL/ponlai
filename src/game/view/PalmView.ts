import * as THREE from 'three/webgpu';
import { attribute, float, positionGeometry, select, uniform, vec3 } from 'three/tsl';
import { shared } from '../../shared.ts';
import { setWindDisplacement, wave } from '../../weather/Wind.ts';
import { mainBend } from '../../world/Foliage.ts';
import { useRestPoseShadows } from '../../world/VegetationShadow.ts';
import { PALM_COCONUTS } from '../sim/places.ts';
import type { PalmState } from '../sim/types.ts';
import { BALL, PropBuilder, at, hashAt, propMaterial } from './Props.ts';
import type { RGB } from './Props.ts';

// A coconut palm (places.ts) drawn where the simulation stands it: a stand-in built in code until
// the island grows its own palms, in the props' faceted style (Props.ts). A ringed trunk curves
// up and leans a little (its lean and the fronds' turn come from a hash of where it stands, so a
// loaded game draws the same palm), a crown of arching fronds with sawtooth leaflets, and
// PALM_COCONUTS coconuts under the crown, of which the first `coconuts` show: the others are
// collapsed onto the crown in the vertex stage, so picking one changes a uniform, not the mesh.
//
// It moves in the one wind (Wind.ts): the whole palm bends from its foot with the gust field at
// its root, slowly, as the island's trees do (Foliage.ts mainBend), and each frond swings on its
// own phase from the crown out. Its shadow keeps the rest pose, as the vegetation's does
// (VegetationShadow.ts). The geometry is in world space (the mesh sits at the origin), as the
// wind field is sampled at world positions. Its top stays below the island's tallest trees, inside
// the sea's reflection box and the sun shadow's casters (Water.ts, SunShadow.ts).
//
// Every palm draws with one material (`palmMaterial`), kept for the page's life: what differs
// between palms (its root, its crown, its coconut count) reaches the shader as per-object uniforms
// rather than as constants. With a material of its own, a loaded game's palm built its shaders and
// its two pipelines (the scene's pass and the sun's map) in the frame it first drew, as the old
// view's palm had released them: about 20 ms of script, and a frame of about 0.35 s on a cold shader
// cache. The game compiles a sample palm with the props at start and keeps it (GameView "First
// draws"), so no palm builds a pipeline in a frame.

const TRUNK_HEIGHT = 2.9;
const TRUNK_SEGMENTS = 9;
const TRUNK_SIDES = 7;
const FRONDS = 8;
const FROND_LENGTH = 1.55;
const LEAFLETS = 9;
// the crown's bend in a fair day's typical gust (m, see Wind.ts LEAN_REF), and the fronds' swing
const CROWN_BEND = 0.07;
const FROND_SWING = 0.1;

// linear albedo: grey-brown bark (near the trees' furrowed bark), green fronds
// yellowing toward the older lower ones, coconuts from green to husk brown
const BARK: RGB = [ 0.15, 0.12, 0.085 ];
const BARK_RING: RGB = [ 0.1, 0.078, 0.055 ];
const CROWN: RGB = [ 0.11, 0.12, 0.045 ];
const FROND: RGB = [ 0.075, 0.16, 0.035 ];
const FROND_OLD: RGB = [ 0.16, 0.17, 0.05 ];
const COCONUT: RGB = [ 0.13, 0.14, 0.035 ];
const COCONUT_RIPE: RGB = [ 0.2, 0.12, 0.045 ];

const mixRGB = ( a: RGB, b: RGB, t: number, shade = 1 ): RGB => [
	( a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t ) * shade, ( a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t ) * shade, ( a[ 2 ] + ( b[ 2 ] - a[ 2 ] ) * t ) * shade,
];

interface PalmShape { geometry: THREE.BufferGeometry; crown: THREE.Vector3 }

/** The palm's geometry at its place; per vertex `palmSway` ( crown bend m, frond swing m, phase, coconut index or -1 ). */
function palmGeometry( palm: PalmState, ground: number ): PalmShape {

	const b = new PropBuilder( 4 );
	const base = new THREE.Vector3( palm.x, ground - 0.15, palm.z );
	const yaw = hashAt( palm.x, palm.z, 1 ) * Math.PI * 2;
	const lean = 0.35 + 0.3 * hashAt( palm.x, palm.z, 2 );
	const leanDir = new THREE.Vector3( Math.sin( yaw ), 0, Math.cos( yaw ) );
	const height = TRUNK_HEIGHT + 0.15;
	// the trunk's axis: rises, curving over toward the lean
	const axis = ( t: number ) => base.clone().addScaledVector( leanDir, lean * t * t ).setY( base.y + height * t );
	const bend = ( p: THREE.Vector3 ) => CROWN_BEND * Math.min( 1, Math.max( 0, ( p.y - base.y ) / height ) ) ** 2;
	const still = ( p: THREE.Vector3 ) => [ bend( p ), 0, 0, - 1 ];

	// trunk: stacked rings, each a little wider at its foot (the old leaf bases), flared at the ground
	const ring = ( c: THREE.Vector3, r: number, k: number ) => {

		const a = ( k / TRUNK_SIDES + 0.5 / TRUNK_SIDES ) * Math.PI * 2;
		return new THREE.Vector3( c.x + Math.cos( a ) * r, c.y, c.z + Math.sin( a ) * r );

	};
	for ( let s = 0; s < TRUNK_SEGMENTS; s ++ ) {

		const t0 = s / TRUNK_SEGMENTS, t1 = ( s + 1 ) / TRUNK_SEGMENTS;
		const radius = ( t: number ) => 0.13 - 0.04 * t + 0.1 * Math.max( 0, 1 - t * 6 ) ** 2;
		const c0 = axis( t0 ), c1 = axis( t1 );
		const r0 = radius( t0 ) * 1.1, r1 = radius( t1 ) * 0.92;
		const sides: THREE.Vector3[] = [], ledges: THREE.Vector3[] = [];
		for ( let k = 0; k < TRUNK_SIDES; k ++ ) {

			const a0 = ring( c0, r0, k ), a1 = ring( c0, r0, k + 1 ), b0 = ring( c1, r1, k ), b1 = ring( c1, r1, k + 1 );
			sides.push( a0, b0, a1, a1, b0, b1 );
			// the ledge where this ring sits on the one below
			const l0 = ring( c0, radius( t0 ) * 0.92, k ), l1 = ring( c0, radius( t0 ) * 0.92, k + 1 );
			if ( s > 0 ) ledges.push( l0, a0, l1, l1, a0, a1 );

		}
		b.triangles( sides, BARK, still );
		if ( ledges.length > 0 ) b.triangles( ledges, BARK_RING, still );

	}

	// the crown's heart, where the fronds leave the trunk
	const crown = axis( 1 );
	b.add( BALL, CROWN, at( crown.x, crown.y + 0.02, crown.z, 0.17, 0.13, 0.17 ), still );

	// fronds: a midrib arching up and out, then drooping, with leaflets folded down in a shallow V
	const up = new THREE.Vector3( 0, 1, 0 );
	for ( let f = 0; f < FRONDS; f ++ ) {

		const turn = yaw + ( f + 0.35 * hashAt( palm.x, palm.z, 10 + f ) ) / FRONDS * Math.PI * 2;
		const out = new THREE.Vector3( Math.sin( turn ), 0, Math.cos( turn ) );
		const side = new THREE.Vector3().crossVectors( up, out ).normalize();
		// alternate fronds rise higher; the low ones are older, longer and yellower
		const low = f % 2;
		const rise = THREE.MathUtils.degToRad( low ? 18 : 42 );
		const length = FROND_LENGTH * ( low ? 1.08 : 0.92 ) * ( 0.94 + 0.12 * hashAt( palm.x, palm.z, 30 + f ) );
		const phase = hashAt( palm.x, palm.z, 50 + f ) * Math.PI * 2;
		const age = low ? 0.55 : 0.1;
		const rib: THREE.Vector3[] = [ crown.clone().addScaledVector( out, 0.08 ).setY( crown.y + 0.06 ) ];
		const steps = LEAFLETS + 1;
		for ( let i = 1; i <= steps; i ++ ) {

			const s = i / steps;
			const elevation = rise - THREE.MathUtils.degToRad( 115 ) * s ** 1.4;
			const dir = out.clone().multiplyScalar( Math.cos( elevation ) ).addScaledVector( up, Math.sin( elevation ) );
			rib.push( rib[ i - 1 ].clone().addScaledVector( dir, length / steps ) );

		}
		const sway = ( p: THREE.Vector3 ) => {

			const s = Math.min( 1, p.distanceTo( crown ) / length );
			return [ bend( p ), FROND_SWING * s ** 1.5, phase, - 1 ];

		};
		const tris: THREE.Vector3[] = [];
		const shades: number[] = [];
		for ( let i = 0; i < steps; i ++ ) {

			const s = ( i + 0.5 ) / steps;
			const a = rib[ i ], c = rib[ i + 1 ];
			const forward = c.clone().sub( a ).normalize();
			const width = 0.06 + 0.42 * Math.sin( Math.PI * Math.min( 1, s * 1.15 ) ) ** 0.8;
			for ( const hand of [ - 1, 1 ] ) {

				// out to the side, folded down, swept toward the tip: a sawtooth edge
				const blade = side.clone().multiplyScalar( hand ).addScaledVector( up, - 0.45 ).addScaledVector( forward, 0.75 ).normalize();
				const tip = a.clone().lerp( c, 0.5 ).addScaledVector( blade, width );
				if ( hand > 0 ) tris.push( a, tip, c );
				else tris.push( a, c, tip );
				// darker toward the crown, where the fronds shade each other
				shades.push( 0.62 + 0.38 * s );

			}

		}
		b.triangles( tris, ( _p, k ) => mixRGB( FROND, FROND_OLD, age * ( 0.4 + 0.6 * ( k / tris.length ) ), shades[ Math.floor( k / 3 ) ] ), sway );

	}

	// coconuts in a ring under the crown, alternately higher and lower
	for ( let n = 0; n < PALM_COCONUTS; n ++ ) {

		const a = yaw + ( n + 0.3 * hashAt( palm.x, palm.z, 70 + n ) ) / PALM_COCONUTS * Math.PI * 2;
		const r = 0.15 + 0.03 * ( n % 2 );
		const c = new THREE.Vector3( crown.x + Math.sin( a ) * r, crown.y - 0.1 - 0.09 * ( n % 2 ), crown.z + Math.cos( a ) * r );
		const ripe = hashAt( palm.x, palm.z, 90 + n );
		b.add( BALL, mixRGB( COCONUT, COCONUT_RIPE, ripe ), at( c.x, c.y, c.z, 0.085, 0.095, 0.085, 0, a, 0.2 ), ( p ) => [ bend( p ), 0, 0, n ] );

	}
	const geometry = b.geometry( 'palm', 'palmSway' );
	// room for the bend: a gale lays the crown over by a few decimetres
	geometry.boundingSphere!.radius += 0.6;
	return { geometry, crown };

}

/** What differs between palms, read by the shared material per draw (`palmMaterial`). */
interface PalmPlace { root: THREE.Vector3; crown: THREE.Vector3; coconuts: number }

let material: THREE.MeshStandardNodeMaterial | null = null;

/** The one material every palm draws with (see the header): its root, crown and coconut count
 * are per-object uniforms, read from the mesh's `userData.palm` (PalmPlace) as it draws. */
function palmMaterial(): THREE.MeshStandardNodeMaterial {

	if ( material ) return material;
	const m = material = propMaterial( 'palm', THREE.DoubleSide );
	const place = ( object: THREE.Object3D | null ) => object!.userData.palm as PalmPlace;
	const root = uniform( new THREE.Vector3() ).onObjectUpdate( ( { object } ) => place( object ).root );
	const crown = uniform( new THREE.Vector3() ).onObjectUpdate( ( { object } ) => place( object ).crown );
	const coconuts = uniform( 0 ).onObjectUpdate( ( { object } ) => place( object ).coconuts );
	const sway = attribute<'vec4'>( 'palmSway', 'vec4' );
	// coconuts past the palm's count collapse onto the crown (zero-area triangles)
	const rest = select( sway.w.lessThan( coconuts ), positionGeometry, crown ).toVar();
	const swayed = setWindDisplacement( m, ( wind ) => {

		// the whole palm bends slowly from its foot (half a shrub's rate)
		const bent = mainBend( wind, rest, root, sway.x, 0.9, float( 1 ) );
		const field = bent.field;
		const along = vec3( field.x, 0, field.y ), across = vec3( field.y.negate(), 0, field.x );
		const lively = wind.breeze.mul( field.w.mul( 0.7 ).add( 0.3 ) );
		// each frond swings and lifts on its own phase, its tip the most
		const swing = wave( wind.flutter, 0.7, sway.z ).mul( 0.6 ).add( wave( wind.flutter, 1.13, sway.z.mul( 1.9 ) ).mul( 0.4 ) );
		const toss = wave( wind.flutter, 0.53, sway.z.mul( 2.3 ) ).mul( 0.5 ).add( 0.35 );
		const frond = vec3( 0, swing.mul( 0.8 ), 0 ).add( along.mul( toss ) ).add( across.mul( swing.mul( 0.5 ) ) ).mul( sway.y.mul( lively ) );
		return bent.position.add( frond );

	}, shared.wind );
	useRestPoseShadows( m, rest, swayed );
	return m;

}

export class PalmView {

	readonly id: string;
	readonly mesh: THREE.Mesh;
	stamp = 0;
	private readonly place: PalmPlace;

	constructor( palm: PalmState, ground: number ) {

		this.id = palm.id;
		const { geometry, crown } = palmGeometry( palm, ground );
		this.place = { root: new THREE.Vector3( palm.x, ground, palm.z ), crown, coconuts: - 1 };
		this.mesh = new THREE.Mesh( geometry, palmMaterial() );
		this.mesh.userData.palm = this.place;
		this.mesh.name = `palm:${ palm.id }`;
		this.mesh.castShadow = true;
		this.mesh.receiveShadow = true;
		this.update( palm );

	}

	/** The palm's coconuts; true when the count changed (its shadow changes with it). */
	update( palm: Readonly<PalmState> ): boolean {

		const n = Math.min( palm.coconuts, PALM_COCONUTS );
		if ( this.place.coconuts === n ) return false;
		this.place.coconuts = n;
		return true;

	}

	dispose(): void {

		this.mesh.removeFromParent();
		this.mesh.geometry.dispose();

	}

}
