import * as THREE from 'three/webgpu';

// The islanders are the stylised layer of the art: friendlier, chunkier proportions than the
// kit's slender stock figure (a larger head, shorter legs and neck, a broader torso, thicker
// limbs, larger hands and feet), in the spirit of Alba, Sky and Tchia. Rather than editing
// each part, the assembled figure is re-proportioned once at build time, on its bind pose:
//
// - every bone moves to a new bind position (bone offsets scaled: legs, arms, neck, hands, the
//   spine's segments, the shoulders and hip joints spread), its rotation kept;
// - every vertex follows the bones it is skinned to, each bone carrying its flesh along and
//   scaling it about the bone's origin (uniformly for the head and hands, across the bone for
//   the limbs' thickness, along it for their length, sideways for the torso), blended by the
//   skin weights, so a seam between two bones stays closed;
// - the clips' bone translations move by the same offsets, and since the kit's feet are IK
//   targets under the root rather than children of the shins, the hips and feet are re-solved
//   for the shorter legs at every key: the hips sink so that a foot planted at the bind pose's
//   height stays planted, and each foot sits where the scaled leg now ends (the ankle lies on
//   the shin's axis in the kit, so leg and foot stay joined). Rotations are never touched.
//
// Everything is derived from the shared rig's bone names, so any figure assembled from the kit
// takes the same proportions, and the ears (bound wholly to the head) grow with the head. Per-frame
// skinning stays plain (bone matrices only).
//
// The kit-dressed islanders use the medium build (about 4.7 heads tall, against the kit's 5.5),
// chosen by the user from four builds; the feather-robed Hanming islanders the realistic `real`
// build (about 6.5 heads); `stock` (the kit's own) stays selectable for comparison (`?islander`).
// A figure drawn as several meshes on one skeleton (a painted body, its textured parts) is
// re-proportioned as one: the bones and clips once, every mesh's geometry alike.
// The work comes in three parts: the plan on the bind pose (`planProportions`), the vertices
// (`reshape`) and the rig and clips (`rerig`). `reproportion` runs them at once; a figure that
// changes with its age runs them on copies, a few vertices at a time (FigureAge.ts).

export interface Proportions {
	/** uniform scale of the head (and ears) about the top of the neck */
	head: number;
	/** neck length */
	neck: number;
	/** width of the torso and the spread of the shoulders (depth follows by 60 %) */
	torso: number;
	/** spread of the hip joints and width of the pelvis */
	hips: number;
	/** length of the spine, from the hips to the neck (the abdomen, torso and chest; an old
	 * figure's spine is shorter: FigureAge.ts) */
	spine: number;
	/** thickness of the arms and legs */
	limbs: number;
	/** upper and lower arm length */
	arms: number;
	/** uniform scale of the hands about the wrist */
	hands: number;
	/** thigh and shin length */
	legs: number;
	/** width of the feet */
	feet: number;
	/** degrees the arms are held further out from the body, about its forward axis */
	armsOut: number;
}

const STOCK: Proportions = { head: 1, neck: 1, torso: 1, hips: 1, spine: 1, limbs: 1, arms: 1, hands: 1, legs: 1, feet: 1, armsOut: 0 };

export const PROPORTIONS = {
	stock: STOCK,
	subtle: { head: 1.08, neck: 0.9, torso: 1.06, hips: 1.03, spine: 1, limbs: 1.06, arms: 0.97, hands: 1.1, legs: 0.93, feet: 1.05, armsOut: 1.5 },
	medium: { head: 1.16, neck: 0.8, torso: 1.12, hips: 1.06, spine: 1, limbs: 1.12, arms: 0.94, hands: 1.2, legs: 0.86, feet: 1.1, armsOut: 2.5 },
	strong: { head: 1.26, neck: 0.68, torso: 1.2, hips: 1.1, spine: 1, limbs: 1.2, arms: 0.9, hands: 1.3, legs: 0.78, feet: 1.16, armsOut: 3.5 },
	// about 6.5 heads tall: a smaller head and longer legs than the kit's, the arms held out a little
	// over the feathers (looks.ts HANMING)
	real: { head: 0.85, neck: 1, torso: 1, hips: 1, spine: 1, limbs: 1, arms: 1, hands: 1, legs: 1.07, feet: 1, armsOut: 3 },
} satisfies Record<string, Proportions>;

export type ProportionName = keyof typeof PROPORTIONS;
export const PROPORTION_NAMES = Object.keys( PROPORTIONS ) as ProportionName[];

export function isStock( p: Proportions ): boolean {

	return ( Object.keys( STOCK ) as ( keyof Proportions )[] ).every( ( k ) => p[ k ] === STOCK[ k ] );

}

// the kit's bones, as GLTFLoader names them (it drops the dot: Foot.L -> FootL)
const SIDES = [ 'L', 'R' ] as const;
const SPINE = /^(Body|Hips|Abdomen|Torso|Chest)$/;
// the spine's segments, each from its parent: the hips to the abdomen, on to the neck
const SEGMENTS = /^(Abdomen|Torso|Chest|Neck)$/;

/** A scale of `along` along the unit axis d and `across` perpendicular to it. */
function axial( d: THREE.Vector3, along: number, across: number ): THREE.Matrix3 {

	const m = new THREE.Matrix3().set(
		d.x * d.x, d.x * d.y, d.x * d.z,
		d.y * d.x, d.y * d.y, d.y * d.z,
		d.z * d.x, d.z * d.y, d.z * d.z,
	).multiplyScalar( along - across );
	const e = m.elements;
	e[ 0 ] += across; e[ 4 ] += across; e[ 8 ] += across;
	return m;

}

const diagonal = ( x: number, y: number, z: number ) => new THREE.Matrix3().set( x, 0, 0, 0, y, 0, 0, 0, z );
const uniform = ( s: number ) => diagonal( s, s, s );

/** A re-proportioning planned on a skeleton's bind pose: each bone's bind origin and the one it
 * moves to, the map of the flesh it carries about its origin, the legs' bones, the body's (the
 * hips' parent) and the feet's height. */
export interface Plan {
	p: Proportions;
	parent: number[];
	bind: THREE.Matrix4[];
	origin: THREE.Vector3[];
	moved: THREE.Vector3[];
	flesh: THREE.Matrix3[];
	inverseFlesh: THREE.Matrix3[];
	legs: { upper: number; lower: number; foot: number }[];
	body: number;
	ground: number;
}

/**
 * Re-proportion a skinned figure built on the kit's rig: its geometry (every mesh bound to the
 * one skeleton), its skeleton's bind pose and rest pose, and the bone translations of its clips
 * (changed in place). In three parts, which a figure that changes with age runs on copies, a few
 * vertices at a time (FigureAge.ts): the plan, the vertices (`reshape`) and the rig (`rerig`).
 */
export function reproportion( meshes: THREE.SkinnedMesh | THREE.SkinnedMesh[], clips: THREE.AnimationClip[], p: Proportions ): void {

	if ( isStock( p ) ) return;
	const list = Array.isArray( meshes ) ? meshes : [ meshes ];
	const skeleton = list[ 0 ].skeleton;
	const plan = planProportions( skeleton, p );
	for ( const mesh of list ) {

		const geometry = mesh.geometry;
		const position = geometry.getAttribute( 'position' ) as THREE.BufferAttribute;
		const normal = geometry.getAttribute( 'normal' ) as THREE.BufferAttribute;
		reshape( mesh, plan, position, normal, 0, position.count );
		position.needsUpdate = true;
		normal.needsUpdate = true;
		geometry.computeBoundingBox();
		geometry.computeBoundingSphere();

	}
	rerig( skeleton, clips, plan );

}

/** Plan the proportions on a skeleton's bind pose (its bone inverses). */
export function planProportions( skeleton: THREE.Skeleton, p: Proportions ): Plan {

	const bones = skeleton.bones;
	const n = bones.length;
	const find = ( name: string ) => bones.findIndex( ( b ) => b.name === name );
	const parent = bones.map( ( b ) => bones.indexOf( b.parent as THREE.Bone ) );
	// bind pose in the armature's space: each bone's matrix, origin and axis (bones run along +y)
	const bind = skeleton.boneInverses.map( ( m ) => m.clone().invert() );
	const origin = bind.map( ( m ) => new THREE.Vector3().setFromMatrixPosition( m ) );
	const axis = bind.map( ( m ) => new THREE.Vector3().setFromMatrixColumn( m, 1 ).normalize() );

	// per bone: the map of its offset from its parent, and of its flesh about its origin
	const offset = bones.map( () => uniform( 1 ) );
	const flesh = bones.map( () => uniform( 1 ) );
	const depth = ( w: number ) => 1 + ( w - 1 ) * 0.6;
	const torso = diagonal( p.torso, 1, depth( p.torso ) );
	for ( let i = 0; i < n; i ++ ) {

		const name = bones[ i ].name;
		if ( name === 'Head' ) flesh[ i ] = uniform( p.head );
		else if ( name === 'Neck' ) flesh[ i ] = axial( axis[ i ], p.neck, 1 );
		else if ( name === 'Body' || name === 'Hips' ) flesh[ i ] = diagonal( p.hips, 1, depth( p.hips ) );
		else if ( SPINE.test( name ) ) flesh[ i ] = torso.clone();
		// a shorter spine: its three segments, and the neck's root on the chest, come down; their
		// flesh shrinks along them
		if ( p.spine !== 1 && SEGMENTS.test( name ) ) {

			offset[ i ] = diagonal( 1, p.spine, 1 );
			if ( name !== 'Neck' ) flesh[ i ].multiply( axial( axis[ i ], p.spine, 1 ) );

		}

	}
	const head = find( 'Head' );
	if ( head >= 0 ) offset[ head ] = uniform( p.neck );
	// the hands: the wrist and every finger below it scale about the wrist
	const scaleSubtree = ( root: number, s: number ) => {

		flesh[ root ] = uniform( s );
		for ( let i = 0; i < n; i ++ ) {

			let j = parent[ i ];
			while ( j >= 0 && j !== root ) j = parent[ j ];
			if ( j === root ) {

				offset[ i ] = uniform( s );
				flesh[ i ] = uniform( s );

			}

		}

	};
	const legs: { upper: number; lower: number; foot: number }[] = [];
	for ( const s of SIDES ) {

		const shoulder = find( 'Shoulder' + s ), upperArm = find( 'UpperArm' + s ), lowerArm = find( 'LowerArm' + s ), wrist = find( 'Wrist' + s );
		if ( shoulder >= 0 ) {

			// the arm's root moves out with the broader chest
			offset[ shoulder ] = diagonal( p.torso, 1, 1 );
			flesh[ shoulder ] = torso.clone();

		}
		if ( upperArm >= 0 ) {

			offset[ upperArm ] = diagonal( p.torso, 1, 1 );
			flesh[ upperArm ] = axial( axis[ upperArm ], p.arms, p.limbs );

		}
		if ( lowerArm >= 0 ) {

			offset[ lowerArm ] = uniform( p.arms );
			flesh[ lowerArm ] = axial( axis[ lowerArm ], p.arms, p.limbs );

		}
		if ( wrist >= 0 ) {

			scaleSubtree( wrist, p.hands );
			offset[ wrist ] = uniform( p.arms );

		}
		const upper = find( 'UpperLeg' + s ), lower = find( 'LowerLeg' + s ), foot = find( 'Foot' + s );
		if ( upper < 0 || lower < 0 || foot < 0 ) continue;
		offset[ upper ] = diagonal( p.hips, 1, 1 );
		flesh[ upper ] = axial( axis[ upper ], p.legs, p.limbs );
		offset[ lower ] = uniform( p.legs );
		flesh[ lower ] = axial( axis[ lower ], p.legs, p.limbs );
		// broader shoes, as long and as high as before: a longer foot would dig its toe into the
		// ground as it rolls off, a higher one sink its sole (the foot's origin is at the heel)
		flesh[ foot ] = diagonal( p.feet, 1, 1 );
		legs.push( { upper, lower, foot } );

	}
	// The hips sink with the shorter legs so that a foot at the bind pose's height stays there:
	// a hip joint at height y over the feet' height c moves to c + legs (y - c).
	const body = find( 'Body' );
	const ground = legs.length ? legs.reduce( ( a, l ) => a + origin[ l.foot ].y, 0 ) / legs.length : 0;
	const hipHeight = ( o: THREE.Vector3[] ) => legs.reduce( ( a, l ) => a + o[ l.upper ].y, 0 ) / legs.length;

	// new bind origins, parents first; the feet (children of the root) follow their shins
	const moved = origin.map( ( o ) => o.clone() );
	const done = new Array<boolean>( n ).fill( false );
	const place = ( i: number ) => {

		if ( done[ i ] ) return;
		const j = parent[ i ];
		if ( j >= 0 ) {

			place( j );
			moved[ i ].copy( origin[ i ] ).sub( origin[ j ] ).applyMatrix3( offset[ i ] ).add( moved[ j ] );

		}
		done[ i ] = true;

	};
	for ( let i = 0; i < n; i ++ ) place( i );
	if ( body >= 0 && legs.length ) {

		const drop = ( p.legs - 1 ) * ( hipHeight( origin ) - ground );
		for ( let i = 0; i < n; i ++ ) {

			let j = i;
			while ( j >= 0 && j !== body ) j = parent[ j ];
			if ( j === body ) moved[ i ].y += drop;

		}

	}
	for ( const { lower, foot } of legs ) moved[ foot ].copy( origin[ foot ] ).sub( origin[ lower ] ).multiplyScalar( p.legs ).add( moved[ lower ] );
	return { p, parent, bind, origin, moved, flesh, inverseFlesh: flesh.map( ( m ) => m.clone().invert() ), legs, body, ground };

}

/**
 * The geometry, in the armature's bind space: each bone carries its flesh to its new origin. The
 * mesh's vertices from `start` up to `end`, read from and written to `position` and `normal` (the
 * mesh's own, or copies of the same layout), its skin and bind matrix as bound.
 */
export function reshape( mesh: THREE.SkinnedMesh, plan: Plan, position: THREE.BufferAttribute, normal: THREE.BufferAttribute, start: number, end: number ): void {

	const { origin, moved, flesh, inverseFlesh } = plan;
	const geometry = mesh.geometry;
	const skinIndex = geometry.getAttribute( 'skinIndex' ), skinWeight = geometry.getAttribute( 'skinWeight' );
	const toBind = mesh.bindMatrix, fromBind = mesh.bindMatrixInverse;
	const normalTo = _m.getNormalMatrix( toBind ), normalFrom = _n.getNormalMatrix( fromBind );
	const v = _v, q = _q, sum = _sum, nrm = _nrm, nsum = _nsum;
	for ( let k = start; k < end; k ++ ) {

		v.fromBufferAttribute( position, k ).applyMatrix4( toBind );
		nrm.fromBufferAttribute( normal, k ).applyMatrix3( normalTo );
		sum.set( 0, 0, 0 );
		nsum.set( 0, 0, 0 );
		let total = 0;
		for ( let c = 0; c < 4; c ++ ) {

			const w = skinWeight.getComponent( k, c );
			if ( w === 0 ) continue;
			const b = skinIndex.getComponent( k, c );
			q.copy( v ).sub( origin[ b ] ).applyMatrix3( flesh[ b ] ).add( moved[ b ] );
			sum.addScaledVector( q, w );
			q.copy( nrm ).applyMatrix3( inverseFlesh[ b ] );
			nsum.addScaledVector( q, w );
			total += w;

		}
		if ( total === 0 ) continue;
		sum.divideScalar( total ).applyMatrix4( fromBind );
		position.setXYZ( k, sum.x, sum.y, sum.z );
		nsum.applyMatrix3( normalFrom ).normalize();
		normal.setXYZ( k, nsum.x, nsum.y, nsum.z );

	}

}

const _m = new THREE.Matrix3(), _n = new THREE.Matrix3();
const _v = new THREE.Vector3(), _q = new THREE.Vector3(), _sum = new THREE.Vector3(), _nrm = new THREE.Vector3(), _nsum = new THREE.Vector3();

/** The rig: the skeleton's bind and rest poses and the clips' keys, moved as planned. */
export function rerig( skeleton: THREE.Skeleton, clips: THREE.AnimationClip[], plan: Plan ): void {

	const { p, parent, bind, origin, moved, legs, body, ground } = plan;
	const bones = skeleton.bones;
	const n = bones.length;
	const find = ( name: string ) => bones.findIndex( ( b ) => b.name === name );

	// the bind pose: the same rotations at the new origins
	for ( let i = 0; i < n; i ++ ) skeleton.boneInverses[ i ].multiply( new THREE.Matrix4().makeTranslation( origin[ i ].clone().sub( moved[ i ] ) ) );

	// each bone's translation in its parent's frame moves by its offset's change there
	const shift = bones.map( ( _, i ) => {

		const j = parent[ i ];
		if ( j < 0 ) return new THREE.Vector3();
		const local = new THREE.Matrix3().setFromMatrix4( skeleton.boneInverses[ j ] );
		return moved[ i ].clone().sub( moved[ j ] ).sub( origin[ i ].clone().sub( origin[ j ] ) ).applyMatrix3( local );

	} );
	const special = new Set<number>( body >= 0 && legs.length ? [ body, ...legs.map( ( l ) => l.foot ) ] : [] );
	// (the body's hips and the feet are solved below; the legs' own offsets shift as any other)
	// the hip joints in the body's frame and the body's rest, before anything moves
	const hipOld = legs.map( ( l ) => bones[ l.upper ].position.clone() );
	const hipNew = legs.map( ( l, k ) => hipOld[ k ].clone().add( shift[ l.upper ] ) );
	const restT = body >= 0 ? bones[ body ].position.clone() : new THREE.Vector3();
	const restQ = body >= 0 ? bones[ body ].quaternion.clone() : new THREE.Quaternion();
	const kneeOld = legs.map( ( l ) => bones[ l.lower ].position.clone() );
	const restUpper = legs.map( ( l ) => bones[ l.upper ].quaternion.clone() );
	const restLower = legs.map( ( l ) => bones[ l.lower ].quaternion.clone() );
	const restFoot = legs.map( ( l ) => bones[ l.foot ].position.clone() );
	for ( let i = 0; i < n; i ++ ) if ( ! special.has( i ) ) bones[ i ].position.add( shift[ i ] );
	for ( const clip of clips ) {

		for ( const track of clip.tracks ) {

			if ( ! track.name.endsWith( '.position' ) ) continue;
			const i = find( track.name.slice( 0, - '.position'.length ) );
			if ( i < 0 || special.has( i ) ) continue;
			// GLTFLoader shares an accessor's array between the tracks that use it
			const values = track.values = track.values.slice(), d = shift[ i ];
			for ( let k = 0; k < values.length; k += 3 ) {

				values[ k ] += d.x; values[ k + 1 ] += d.y; values[ k + 2 ] += d.z;

			}

		}

	}
	// The arms are held a little further out, so the larger hands clear the broader hips and
	// thicker thighs at the sides in every clip: a fixed turn of each upper arm about the body's
	// forward axis, in its parent's frame (the shoulder's), applied to the rest pose and every key.
	if ( p.armsOut !== 0 ) for ( const s of SIDES ) {

		const upperArm = find( 'UpperArm' + s );
		if ( upperArm < 0 || parent[ upperArm ] < 0 ) continue;
		const frame = new THREE.Quaternion().setFromRotationMatrix( bind[ parent[ upperArm ] ] );
		// bind space is y up with the arms along x; a turn about +z moves a hanging arm toward +x
		const out = Math.sign( origin[ upperArm ].x ) * p.armsOut * Math.PI / 180;
		const turn = frame.clone().invert().multiply( new THREE.Quaternion().setFromAxisAngle( new THREE.Vector3( 0, 0, 1 ), out ) ).multiply( frame );
		bones[ upperArm ].quaternion.premultiply( turn );
		const q = new THREE.Quaternion();
		for ( const clip of clips ) for ( const track of clip.tracks ) {

			if ( track.name !== `${ bones[ upperArm ].name }.quaternion` ) continue;
			const values = track.values = track.values.slice();
			for ( let k = 0; k < values.length; k += 4 ) q.fromArray( values, k ).premultiply( turn ).toArray( values, k );

		}

	}
	if ( special.size === 0 ) return;

	// The hips and legs, re-solved at every key in the root's frame (the parent of the body and
	// the feet): the hips sink by the legs' share of the hip joints' height over the ground; each
	// ankle keeps its height (heel lift, toe roll and the foot's own rotation stay as they were,
	// so the sole meets the ground as before) while its reach from the hip joint scales with the
	// legs; and the thigh and shin turn as a two-bone IK chain to reach it, the knee in the plane
	// it bent in before. A planted foot thus stays planted, and the stride shortens with the legs
	// (the walk's rate follows the stride, so feet do not slide).
	const root = parent[ body ];
	const rootLinear = root >= 0 ? new THREE.Matrix3().setFromMatrix4( skeleton.boneInverses[ root ] ) : new THREE.Matrix3();
	const up = new THREE.Vector3( 0, 1, 0 ).applyMatrix3( rootLinear ).normalize();
	const groundLocal = root >= 0 ? origin[ legs[ 0 ].foot ].clone().applyMatrix4( skeleton.boneInverses[ root ] ).dot( up ) : ground;
	const AXIS = new THREE.Vector3( 0, 1, 0 );
	const chain = legs.map( ( l, k ) => ( {
		hipOld: hipOld[ k ], hipNew: hipNew[ k ], kneeOld: kneeOld[ k ],
		thigh: bones[ l.lower ].position.length(),
		shin: origin[ l.foot ].distanceTo( origin[ l.lower ] ) * p.legs,
	} ) );
	const hipsAt = ( bodyT: THREE.Vector3, bodyQ: THREE.Quaternion ) => {

		const height = hipOld.reduce( ( a, h ) => a + h.clone().applyQuaternion( bodyQ ).add( bodyT ).dot( up ), 0 ) / hipOld.length;
		return bodyT.clone().addScaledVector( up, ( p.legs - 1 ) * ( height - groundLocal ) );

	};
	const minimal = ( from: THREE.Vector3, to: THREE.Vector3 ) => new THREE.Quaternion().setFromUnitVectors( from.clone().normalize(), to.clone().normalize() );
	/** One leg at one key: new thigh and shin rotations (local) and ankle position. */
	const leg = ( k: number, bodyT: THREE.Vector3, bodyQ: THREE.Quaternion, upperQ: THREE.Quaternion, lowerQ: THREE.Quaternion, ankle: THREE.Vector3 ) => {

		const c = chain[ k ];
		const hip = c.hipOld.clone().applyQuaternion( bodyQ ).add( bodyT );
		const upperWorld = bodyQ.clone().multiply( upperQ );
		const knee = c.kneeOld.clone().applyQuaternion( upperWorld ).add( hip );
		const hip2 = c.hipNew.clone().applyQuaternion( bodyQ ).add( hipsAt( bodyT, bodyQ ) );
		// the ankle's reach from the hip scales with the legs; its height over the ground stays
		const reach = ankle.clone().sub( hip ).multiplyScalar( p.legs );
		const ankle2 = hip2.clone().add( reach );
		ankle2.addScaledVector( up, ankle.dot( up ) - ankle2.dot( up ) );
		// two-bone IK in the old knee's bend plane
		const d = ankle2.clone().sub( hip2 );
		const length = Math.min( d.length(), ( c.thigh + c.shin ) * 0.99999 );
		const dir = d.normalize();
		const bend = knee.clone().sub( hip );
		bend.addScaledVector( dir, - bend.dot( dir ) );
		if ( bend.lengthSq() < 1e-12 ) bend.copy( AXIS ).applyQuaternion( upperWorld ).cross( dir ).cross( dir ).negate();
		bend.normalize();
		const along = ( c.thigh * c.thigh - c.shin * c.shin + length * length ) / ( 2 * length );
		const across = Math.sqrt( Math.max( c.thigh * c.thigh - along * along, 0 ) );
		const knee2 = hip2.clone().addScaledVector( dir, along ).addScaledVector( bend, across );
		const upperWorld2 = minimal( knee.clone().sub( hip ), knee2.clone().sub( hip2 ) ).multiply( upperWorld );
		const lowerWorld = upperWorld2.clone().multiply( lowerQ );
		const lowerWorld2 = minimal( AXIS.clone().applyQuaternion( lowerWorld ), ankle2.clone().sub( knee2 ) ).multiply( lowerWorld );
		return {
			upper: bodyQ.clone().invert().multiply( upperWorld2 ),
			lower: upperWorld2.clone().invert().multiply( lowerWorld2 ),
			ankle: knee2.clone().add( AXIS.clone().applyQuaternion( lowerWorld2 ).multiplyScalar( c.shin ) ),
		};

	};
	// the rest pose
	legs.forEach( ( l, k ) => {

		const r = leg( k, restT, restQ, bones[ l.upper ].quaternion, bones[ l.lower ].quaternion, bones[ l.foot ].position );
		bones[ l.upper ].quaternion.copy( r.upper );
		bones[ l.lower ].quaternion.copy( r.lower );
		bones[ l.foot ].position.copy( r.ankle );

	} );
	bones[ body ].position.copy( hipsAt( restT, restQ ) );
	// the clips, resampled for each leg at the union of its chain's keys (the kit's share them)
	type Sampled = THREE.KeyframeTrack & { createInterpolant(): { evaluate( t: number ): ArrayLike<number> } };
	const bodyName = bones[ body ].name;
	for ( const clip of clips ) {

		const track = ( i: number, property: string ) => clip.tracks.find( ( x ) => x.name === `${ bones[ i ].name }.${ property }` ) as Sampled | undefined;
		const sampler = ( x: Sampled | undefined ) => {

			const at = x?.createInterpolant();
			return ( t: number ) => at ? Array.from( at.evaluate( t ) ) : null;

		};
		const bodyPosition = track( body, 'position' );
		const bodyT = sampler( bodyPosition ), bodyR = sampler( track( body, 'quaternion' ) );
		const bodyAt = ( t: number ) => {

			const a = bodyT( t ), b = bodyR( t );
			return { t: a ? new THREE.Vector3().fromArray( a ) : restT, q: b ? new THREE.Quaternion().fromArray( b ).normalize() : restQ };

		};
		const replaced = new Map<THREE.KeyframeTrack, THREE.KeyframeTrack>();
		legs.forEach( ( l, k ) => {

			const upperTrack = track( l.upper, 'quaternion' ), lowerTrack = track( l.lower, 'quaternion' ), footTrack = track( l.foot, 'position' );
			if ( ! upperTrack && ! lowerTrack && ! footTrack && ! bodyPosition ) return;
			const keys = new Set<number>();
			for ( const x of [ upperTrack, lowerTrack, footTrack, bodyPosition, track( body, 'quaternion' ) ] ) x?.times.forEach( ( t ) => keys.add( t ) );
			if ( keys.size === 0 ) return;
			const times = Float32Array.from( [ ...keys ].sort( ( a, b ) => a - b ) );
			const upperAt = sampler( upperTrack ), lowerAt = sampler( lowerTrack ), footAt = sampler( footTrack );
			const uq = new Float32Array( times.length * 4 ), lq = new Float32Array( times.length * 4 ), fp = new Float32Array( times.length * 3 );
			times.forEach( ( t, m ) => {

				const b = bodyAt( t );
				const u = upperAt( t ), w = lowerAt( t ), f = footAt( t );
				const r = leg( k, b.t, b.q,
					u ? new THREE.Quaternion().fromArray( u ).normalize() : restUpper[ k ],
					w ? new THREE.Quaternion().fromArray( w ).normalize() : restLower[ k ],
					f ? new THREE.Vector3().fromArray( f ) : restFoot[ k ] );
				r.upper.toArray( uq, m * 4 );
				r.lower.toArray( lq, m * 4 );
				r.ankle.toArray( fp, m * 3 );

			} );
			const swap = ( old: THREE.KeyframeTrack | undefined, next: THREE.KeyframeTrack ) => {

				if ( old ) replaced.set( old, next );
				else clip.tracks.push( next );

			};
			swap( upperTrack, new THREE.QuaternionKeyframeTrack( `${ bones[ l.upper ].name }.quaternion`, times, uq ) );
			swap( lowerTrack, new THREE.QuaternionKeyframeTrack( `${ bones[ l.lower ].name }.quaternion`, times, lq ) );
			swap( footTrack, new THREE.VectorKeyframeTrack( `${ bones[ l.foot ].name }.position`, times, fp ) );

		} );
		if ( bodyPosition ) {

			const values = new Float32Array( bodyPosition.values.length );
			for ( let m = 0; m < bodyPosition.times.length; m ++ ) hipsAt( bodyAt( bodyPosition.times[ m ] ).t, bodyAt( bodyPosition.times[ m ] ).q ).toArray( values, m * 3 );
			replaced.set( bodyPosition, new THREE.VectorKeyframeTrack( `${ bodyName }.position`, bodyPosition.times, values ) );

		}
		clip.tracks = clip.tracks.map( ( x ) => replaced.get( x ) ?? x );

	}

}
