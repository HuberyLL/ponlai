import * as THREE from 'three/webgpu';
import { ADULT_HEIGHT, STOOP, builtAge, elderAt, growth, type Sex } from './Ages.ts';
import { planProportions, reshape, rerig, type Proportions } from './Proportions.ts';
import { boundsSteps, runSteps } from '../world/Steps.ts';

// A figure's body at an age (Ages.ts's curves), on its own load of the rig. Everything an age
// changes is made again from what the file holds, never from the last body:
//
// - the shape keys (Female, Child and Elder on every part but the hats, Small on the hats, made in
//   Blender) are mixed into the meshes' rest positions and normals on the CPU, and the geometry
//   keeps no morph targets: every figure draws with its look's material and vertex layout,
//   whatever its age, so no age builds a pipeline;
// - the bones' proportions are solved on the bind skeleton for the curves' shares of the height:
//   the legs for the leg's share, the head for the head's, the widths and lengths kept to the
//   height's scale, the spine shortened for the old (Proportions.ts, which also moves the clips'
//   keys);
// - the figure is scaled so that its height before the old's loss is the curve's, its soles on
//   the ground, and its walk's ground speed with it;
// - the old stoop: a fixed bend of the back, neck and head about the body's sideways axis, laid on
//   the clips' pose after each mixer update (`bend`) and taken off before the next (`unbend`).
//
// The body is built again when the age leaves the one it was built for (Ages.ts builtAge: a
// quarter year for a child, a year for the old); between builds the height, the stride and the
// stoop follow the age itself, so a child grows smoothly. A build took about 16 ms at once, so it
// is prepared in idle time instead, the figures' builds one after another, in slices of at most
// SLICE ms of steps of a few tenths of a millisecond (as the growth's preparation is: Growth.ts):
// the keys mixed and the vertices moved a block at a time into copies of the meshes' arrays, the
// rig and the clips on a copy of the skeleton (`shadow`), the stride measured on it. The owner
// then puts it on in one frame (`swap`: copies of arrays, the clips' keys written into the tracks
// the actions read, so a cross-fade runs on). The first body is built at once, by the same steps.

/** A mesh's shape keys as offsets of its rest positions and normals (as glTF morph targets are). */
export interface ShapeKeys {
	position: Float32Array;
	normal: Float32Array;
	keys: Record<string, { position: Float32Array; normal: Float32Array }>;
}

/** Take a mesh's morph targets as shape keys: its geometry draws without them from then on. */
export function takeShapeKeys( mesh: THREE.Mesh ): ShapeKeys {

	const g = mesh.geometry;
	const keys: ShapeKeys[ 'keys' ] = {};
	for ( const [ name, k ] of Object.entries( mesh.morphTargetDictionary ?? {} ) ) {

		const normal = g.morphAttributes.normal?.[ k ];
		keys[ name ] = { position: Float32Array.from( g.morphAttributes.position![ k ].array ), normal: normal ? Float32Array.from( normal.array ) : new Float32Array( 0 ) };

	}
	g.morphAttributes = {};
	mesh.updateMorphTargets();
	return { position: Float32Array.from( g.getAttribute( 'position' ).array ), normal: Float32Array.from( g.getAttribute( 'normal' ).array ), keys };

}

/** The shape keys of a geometry made by a function of a part's geometries (the pointed ears of a
 * head: Ears.ts), as the function's results on the keyed parts less its result on the rest. */
export function derivedShapeKeys( parts: THREE.BufferGeometry[], keys: ShapeKeys[], made: THREE.BufferGeometry, make: ( parts: THREE.BufferGeometry[] ) => THREE.BufferGeometry | null ): ShapeKeys {

	const position = Float32Array.from( made.getAttribute( 'position' ).array );
	const normal = Float32Array.from( made.getAttribute( 'normal' ).array );
	const out: ShapeKeys = { position, normal, keys: {} };
	for ( const name of new Set( keys.flatMap( ( k ) => Object.keys( k.keys ) ) ) ) {

		const keyed = parts.map( ( g, i ) => {

			const key = keys[ i ].keys[ name ];
			const p = Float32Array.from( keys[ i ].position );
			if ( key ) for ( let k = 0; k < p.length; k ++ ) p[ k ] += key.position[ k ];
			return g.clone().setAttribute( 'position', new THREE.BufferAttribute( p, 3 ) );

		} );
		const m = make( keyed );
		const mp = m?.getAttribute( 'position' ), mn = m?.getAttribute( 'normal' );
		const key = { position: new Float32Array( position.length ), normal: new Float32Array( normal.length ) };
		if ( mp && mn && mp.count * 3 === position.length ) for ( let k = 0; k < position.length; k ++ ) {

			key.position[ k ] = ( mp.array[ k ] as number ) - position[ k ];
			key.normal[ k ] = ( mn.array[ k ] as number ) - normal[ k ];

		}
		out.keys[ name ] = key;

	}
	return out;

}

/** The shape keys of geometries merged in order into one (a part's keys null: it has none). */
export function mergeShapeKeys( parts: { geometry: THREE.BufferGeometry; keys: ShapeKeys | null }[], merged: THREE.BufferGeometry ): ShapeKeys {

	const position = Float32Array.from( merged.getAttribute( 'position' ).array );
	const normal = Float32Array.from( merged.getAttribute( 'normal' ).array );
	const keys: ShapeKeys[ 'keys' ] = {};
	for ( const name of new Set( parts.flatMap( ( p ) => p.keys ? Object.keys( p.keys.keys ) : [] ) ) ) keys[ name ] = { position: new Float32Array( position.length ), normal: new Float32Array( normal.length ) };
	let at = 0;
	for ( const p of parts ) {

		if ( p.keys ) for ( const [ name, key ] of Object.entries( p.keys.keys ) ) {

			keys[ name ].position.set( key.position, at );
			if ( key.normal.length ) keys[ name ].normal.set( key.normal, at );

		}
		at += p.geometry.getAttribute( 'position' ).count * 3;

	}
	return { position, normal, keys };

}

/** A walk's ground speed: how fast a planted foot moves back under the hips, in the model's
 * parent's frame (whatever its place and heading), its clip sampled on a mixer of its own, in
 * steps. The model's bones are as before when it ends. */
export function* strideSteps( model: THREE.Object3D, clip: THREE.AnimationClip ): Generator<void, number> {

	// GLTFLoader drops the dot from node names (Foot.L -> FootL)
	const foot = model.getObjectByName( 'FootL' )!;
	const mixer = new THREE.AnimationMixer( model );
	const walk = mixer.clipAction( clip ).play();
	const samples: { t: number; y: number; z: number }[] = [];
	const p = new THREE.Vector3();
	const frame = model.parent ? model.parent.matrixWorld.clone().invert() : new THREE.Matrix4();
	const n = 120;
	for ( let i = 0; i <= n; i ++ ) {

		mixer.setTime( clip.duration * i / n );
		model.updateMatrixWorld( true );
		foot.getWorldPosition( p ).applyMatrix4( frame );
		samples.push( { t: clip.duration * i / n, y: p.y, z: p.z } );
		if ( i % 20 === 19 ) yield;

	}
	walk.stop();
	mixer.uncacheRoot( model );
	const minY = Math.min( ...samples.map( ( s ) => s.y ) );
	const v: number[] = [];
	for ( let i = 1; i < samples.length; i ++ ) {

		const a = samples[ i - 1 ], b = samples[ i ];
		if ( a.y < minY + 0.015 && b.y < minY + 0.015 ) v.push( - ( b.z - a.z ) / ( b.t - a.t ) );

	}
	v.sort( ( x, y ) => x - y );
	return Math.abs( v[ Math.floor( v.length / 2 ) ] ?? 1 );

}

/** What of a figure ages: its meshes on one skeleton with their keys (the painted body first,
 * whose top is the crown and whose bottom the soles), the model they hang in, its clips, and the
 * look's build (Proportions.ts), the adult man the curves are relative to. */
export interface AgeingParts {
	model: THREE.Object3D;
	meshes: { mesh: THREE.SkinnedMesh; keys: ShapeKeys }[];
	clips: THREE.AnimationClip[];
	build: Proportions;
}

/** A body prepared for an age, to be put on (`swap`). */
interface Body {
	age: number;
	ref: number;
	kept: number;
	/** the walk's ground speed at scale 1 */
	stride: number;
	meshes: { position: Float32Array; normal: Float32Array; box: THREE.Box3; sphere: THREE.Sphere }[];
	rest: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }[];
	inverses: THREE.Matrix4[];
	tracks: THREE.KeyframeTrack[][];
}

/** the hats' Small key: their brim at this share of its radius (with its bound rim) */
const SMALL_HAT = 0.61;
// vertices a step mixes and moves (about two tenths of a millisecond)
const VERTICES = 1024;
// the idle time a slice of preparation takes at most (ms)
const SLICE = 1;

// The preparations waiting, run one after another: each call takes a step, true once it is done.
const queue: ( () => boolean )[] = [];
let queued = false;

function schedule(): void {

	if ( queued || queue.length === 0 ) return;
	queued = true;
	const run = ( deadline?: { timeRemaining(): number } ) => {

		queued = false;
		const until = performance.now() + ( deadline ? Math.min( deadline.timeRemaining(), SLICE ) : SLICE );
		try {

			do {

				if ( queue[ 0 ]() ) queue.shift();

			} while ( queue.length > 0 && performance.now() < until );

		} catch ( error ) {

			queue.shift();
			throw error;

		} finally {

			schedule();

		}

	};
	const page = globalThis as { requestIdleCallback?: ( callback: ( deadline: { timeRemaining(): number } ) => void, options?: { timeout: number } ) => number };
	if ( page.requestIdleCallback ) page.requestIdleCallback( run, { timeout: 200 } );
	else setTimeout( run, 0 );

}

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _r = new THREE.Quaternion();

/** A copy of an object's frames and bones, without its meshes. */
function frames( o: THREE.Object3D ): THREE.Object3D {

	const c = ( o as THREE.Bone ).isBone ? new THREE.Bone() : new THREE.Object3D();
	c.name = o.name;
	c.position.copy( o.position );
	c.quaternion.copy( o.quaternion );
	c.scale.copy( o.scale );
	for ( const child of o.children ) if ( ! ( child as THREE.Mesh ).isMesh ) c.add( frames( child ) );
	return c;

}

export class FigureAge {

	readonly sex: Sex;
	/** the age shown (years) */
	age = NaN;
	/** feet to crown as the body stands (m), the hat left out */
	height = 0;
	/** the walk's ground speed (m per second of its clip) */
	strideSpeed = 1;
	private readonly parts: AgeingParts;
	private readonly skeleton: THREE.Skeleton;
	// the file's rest pose, bind pose and clips
	private readonly rest: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }[];
	private readonly inverses: THREE.Matrix4[];
	private readonly tracks: THREE.KeyframeTrack[][];
	// the model's frames and bones copied, under a parent at the origin: a preparation's rig
	private readonly shadow: { model: THREE.Object3D; skeleton: THREE.Skeleton };
	// the rig's heights at the bind pose (its units, y up): the feet's and hip joints' origins, the
	// hips', neck's and head's, the crown over the head and the soles
	private readonly rig: { foot: number; hip: number; hips: number; neck: number; head: number; crown: number; sole: number };
	// the adult man's crown at the bind pose, the body built's before the old's loss, the share of
	// it the old's spine keeps, and the walk's ground speed at scale 1
	private readonly adult: number;
	private ref = 1;
	private kept = 1;
	private stride = 1;
	// the age the body is built for (Ages.ts builtAge), and a body being prepared or ready
	private built = NaN;
	private preparing = NaN;
	private body: Body | null = null;
	private readonly stoop: { bone: THREE.Bone; degrees: number; saved: THREE.Quaternion }[];
	private elder = 0;
	private bent = false;

	constructor( parts: AgeingParts, sex: Sex ) {

		this.parts = parts;
		this.sex = sex;
		const skeleton = this.skeleton = parts.meshes[ 0 ].mesh.skeleton;
		const bones = skeleton.bones;
		this.rest = bones.map( ( b ) => ( { position: b.position.clone(), quaternion: b.quaternion.clone(), scale: b.scale.clone() } ) );
		this.inverses = skeleton.boneInverses.map( ( m ) => m.clone() );
		this.tracks = parts.clips.map( ( c ) => c.tracks.map( ( t ) => t.clone() ) );
		const model = frames( parts.model );
		new THREE.Group().add( model );
		this.shadow = { model, skeleton: new THREE.Skeleton( bones.map( ( b ) => model.getObjectByName( b.name ) as THREE.Bone ), this.inverses.map( ( m ) => m.clone() ) ) };
		const y = ( name: string ) => _v.setFromMatrixPosition( skeleton.boneInverses[ bones.findIndex( ( b ) => b.name === name ) ].clone().invert() ).y;
		const { mesh, keys } = parts.meshes[ 0 ];
		let top = - Infinity, bottom = Infinity;
		for ( let k = 0; k < keys.position.length; k += 3 ) {

			const h = _v.fromArray( keys.position, k ).applyMatrix4( mesh.bindMatrix ).y;
			top = Math.max( top, h );
			bottom = Math.min( bottom, h );

		}
		const head = y( 'Head' );
		this.rig = { foot: ( y( 'FootL' ) + y( 'FootR' ) ) / 2, hip: ( y( 'UpperLegL' ) + y( 'UpperLegR' ) ) / 2, hips: y( 'Hips' ), neck: y( 'Neck' ), head, crown: top - head, sole: bottom };
		this.adult = this.crown( parts.build.legs, 1, parts.build.neck, parts.build.head );
		this.stoop = Object.entries( STOOP ).map( ( [ name, degrees ] ) => ( { bone: bones.find( ( b ) => b.name === name )!, degrees, saved: new THREE.Quaternion() } ) );

	}

	/** The crown's height at the bind pose for these proportions (the rig's units). */
	private crown( legs: number, spine: number, neck: number, head: number ): number {

		const r = this.rig;
		return r.foot + ( r.hip - r.foot ) * legs + ( r.hips - r.hip ) + ( r.neck - r.hips ) * spine + ( r.head - r.neck ) * neck + r.crown * head;

	}

	/** True when a body is prepared for the age shown, to be put on (`swap`). */
	get ready(): boolean {

		return this.body !== null;

	}

	/** Show the figure at an age (years): its height, stride and stoop follow at once, its body once
	 * it is prepared and put on (`swap`; the first one is built and put on here). */
	set( age: number ): void {

		if ( age === this.age ) return;
		this.age = age;
		if ( Number.isNaN( this.built ) ) {

			this.body = runSteps( this.prepare( builtAge( age ) ) );
			this.swap();

		} else this.ask();
		this.show();

	}

	/** Prepare the body of the age shown in idle time, unless it is built, ready or under way. */
	private ask(): void {

		const want = builtAge( this.age );
		if ( ! Number.isNaN( this.preparing ) || want === ( this.body?.age ?? this.built ) ) return;
		this.preparing = want;
		const steps = this.prepare( want );
		queue.push( () => {

			const next = steps.next();
			if ( ! next.done ) return false;
			this.body = next.value;
			this.preparing = NaN;
			// the age may have moved on to another body meanwhile
			this.ask();
			return true;

		} );
		schedule();

	}

	/** The height, stride and stoop of the age shown on the body built. */
	private show(): void {

		const h = growth( this.sex, this.age ).height;
		const s = h / this.ref;
		const model = this.parts.model;
		model.scale.setScalar( s );
		model.position.y = - this.rig.sole * s;
		this.height = h * this.kept;
		this.strideSpeed = this.stride * s;
		this.elder = elderAt( this.age );

	}

	/** Prepare the body of an age, in steps, on copies: the meshes' arrays, the skeleton (`shadow`)
	 * and the clips' tracks. */
	private* prepare( age: number ): Generator<void, Body> {

		const g = growth( this.sex, age );
		const b = this.parts.build, r = this.rig;
		// the leg's and head's shares of the height, and the bind height that gives them with the
		// trunk and neck as they are; then the legs and head that make them
		const legShare = ( r.foot + ( r.hip - r.foot ) * b.legs ) / this.adult * g.legShare;
		const headShare = r.crown * b.head / this.adult * g.headShare;
		const ref = ( ( r.hips - r.hip ) + ( r.neck - r.hips ) + ( r.head - r.neck ) * g.neck ) / ( 1 - legShare - headShare );
		const legs = ( legShare * ref - r.foot ) / ( r.hip - r.foot ), head = headShare * ref / r.crown;
		// widths and lengths keep their share of the height (before the old's spine shrinks)
		const rel = ref / this.adult;
		const p: Proportions = {
			head, neck: g.neck, spine: g.spine, legs, arms: g.arms * rel, armsOut: b.armsOut,
			torso: g.torso * rel, hips: g.hips * rel, limbs: g.limbs * rel, hands: g.hands * rel, feet: g.feet * rel,
		};
		// a hat keeps its share of the height (the adult man's hat at his height): the head bone
		// carries it, so its Small key takes what the head's scale does not
		const headSize = head * g.height / ref * this.adult / ( b.head * ADULT_HEIGHT.male );
		const hat = g.height / ADULT_HEIGHT.male / headSize;
		const weights: Record<string, number> = { Female: g.female, Child: g.child, Elder: g.elder, Small: THREE.MathUtils.clamp( ( 1 - hat ) / ( 1 - SMALL_HAT ), 0, 1 ) };

		// the plan, on the copy of the skeleton at the file's poses
		const { model, skeleton } = this.shadow;
		skeleton.bones.forEach( ( bone, i ) => {

			bone.position.copy( this.rest[ i ].position );
			bone.quaternion.copy( this.rest[ i ].quaternion );
			bone.scale.copy( this.rest[ i ].scale );
			skeleton.boneInverses[ i ].copy( this.inverses[ i ] );

		} );
		const plan = planProportions( skeleton, p );
		yield;

		// the keys mixed into the rest shape, and the vertices moved, a block at a time
		const meshes: Body[ 'meshes' ] = [];
		for ( const { mesh, keys } of this.parts.meshes ) {

			const position = new THREE.BufferAttribute( keys.position.slice(), 3 ), normal = new THREE.BufferAttribute( keys.normal.slice(), 3 );
			const pa = position.array as Float32Array, na = normal.array as Float32Array;
			const mixed = Object.entries( keys.keys ).map( ( [ name, key ] ) => ( { key, w: weights[ name ] ?? 0 } ) ).filter( ( m ) => m.w !== 0 );
			for ( let start = 0; start < position.count; start += VERTICES ) {

				const end = Math.min( start + VERTICES, position.count );
				for ( const { key, w } of mixed ) {

					for ( let k = start * 3; k < end * 3; k ++ ) pa[ k ] += key.position[ k ] * w;
					if ( key.normal.length ) for ( let k = start * 3; k < end * 3; k ++ ) na[ k ] += key.normal[ k ] * w;

				}
				for ( let k = start * 3; k < end * 3; k += 3 ) _v.fromArray( na, k ).normalize().toArray( na, k );
				reshape( mesh, plan, position, normal, start, end );
				yield;

			}
			const bounds = new THREE.BufferGeometry().setAttribute( 'position', position );
			yield* boundsSteps( bounds );
			meshes.push( { position: pa, normal: na, box: bounds.boundingBox!, sphere: bounds.boundingSphere! } );

		}

		// the rig and the clips
		const clips = this.parts.clips.map( ( c, i ) => new THREE.AnimationClip( c.name, c.duration, this.tracks[ i ].map( ( t ) => t.clone() ) ) );
		rerig( skeleton, clips, plan );
		const rest = skeleton.bones.map( ( b ) => ( { position: b.position.clone(), quaternion: b.quaternion.clone(), scale: b.scale.clone() } ) );
		yield;

		// the walk's ground speed, at this age's height
		const s = g.height / ref;
		model.scale.setScalar( s );
		model.position.y = - r.sole * s;
		const stride = ( yield* strideSteps( model, clips.find( ( c ) => c.name === 'Walk' )! ) ) / s;
		return {
			age, ref, kept: this.crown( legs, g.spine, g.neck, head ) / ref, stride, meshes, rest,
			inverses: skeleton.boneInverses.map( ( m ) => m.clone() ),
			tracks: clips.map( ( c ) => c.tracks ),
		};

	}

	/** Put on the body prepared (`ready`), in one frame: the bones' rest and bind poses, the
	 * meshes' arrays and the clips' keys. */
	swap(): void {

		const body = this.body;
		if ( ! body ) return;
		this.body = null;
		this.unbend();
		this.skeleton.bones.forEach( ( bone, i ) => {

			bone.position.copy( body.rest[ i ].position );
			bone.quaternion.copy( body.rest[ i ].quaternion );
			bone.scale.copy( body.rest[ i ].scale );
			this.skeleton.boneInverses[ i ].copy( body.inverses[ i ] );

		} );
		// The first body's tracks replace the file's. Every body's tracks are alike (the same
		// tracks, keyed at the same times: Proportions.ts rerig moves values, and resamples the legs
		// at the union of the file's keys), so a later one's keys are written into them, where the
		// actions' interpolants read them: the actions run on, a cross-fade with them.
		this.parts.clips.forEach( ( clip, i ) => {

			if ( Number.isNaN( this.built ) ) clip.tracks = body.tracks[ i ];
			else clip.tracks.forEach( ( track, k ) => {

				track.times.set( body.tracks[ i ][ k ].times );
				track.values.set( body.tracks[ i ][ k ].values );

			} );

		} );
		this.parts.meshes.forEach( ( { mesh }, i ) => {

			const m = body.meshes[ i ], geometry = mesh.geometry;
			const position = geometry.getAttribute( 'position' ) as THREE.BufferAttribute;
			const normal = geometry.getAttribute( 'normal' ) as THREE.BufferAttribute;
			( position.array as Float32Array ).set( m.position );
			( normal.array as Float32Array ).set( m.normal );
			position.needsUpdate = true;
			normal.needsUpdate = true;
			geometry.boundingBox = m.box;
			geometry.boundingSphere = m.sphere;

		} );
		this.built = body.age;
		this.ref = body.ref;
		this.kept = body.kept;
		this.stride = body.stride;
		this.show();

	}

	/** The old's stoop on the pose the mixer just set: each bone of the back, neck and head turned
	 * about the body's sideways axis, parents first (a parent's turn carries its children). */
	bend(): void {

		if ( this.elder <= 0 || this.bent ) return;
		const model = this.parts.model;
		for ( const s of this.stoop ) {

			// the model's sideways axis in the bone's parent's frame
			_q.identity();
			for ( let o = s.bone.parent; o && o !== model; o = o.parent ) _q.premultiply( o.quaternion );
			_v.set( 1, 0, 0 ).applyQuaternion( _q.invert() );
			s.saved.copy( s.bone.quaternion );
			s.bone.quaternion.premultiply( _r.setFromAxisAngle( _v, THREE.MathUtils.degToRad( s.degrees * this.elder ) ) );

		}
		this.bent = true;

	}

	/** Take the stoop off again, before the mixer's next update (which sets only the bones its
	 * clips move). */
	unbend(): void {

		if ( ! this.bent ) return;
		for ( const s of this.stoop ) s.bone.quaternion.copy( s.saved );
		this.bent = false;

	}

}
