import * as THREE from 'three/webgpu';
import { uniform, vec4, select, positionLocal, positionPrevious } from 'three/tsl';
import { motionNode, motionState, velocityOutput, debugFlags } from '../../render/index.ts';

// What every figure's material shares: the shading channels and the motion vectors.
//
// The figures' painted parts carry a shading channel per vertex (`KIND`, the `shade` attribute's
// x), which their materials (FigureSurfaces.ts) read to tell skin and leather from cloth. Under the
// temporal modes each figure material writes its motion vectors through `addSkinnedMotion`.

// Shading channel per vertex (the `shade` attribute's x).
export const KIND = { cloth: 0, skin: 1, hair: 2, leather: 3, metal: 4 } as const;

// ---- motion vectors (the temporal modes: Antialiasing.ts, Motion.ts)

// A figure's motion is its object's (the walk moves and turns the figure's group: Motion.ts takes
// its world matrix a rendered frame ago) and its skin's (the clips move the bones under it).
// three's skinning gives the vertex skinned by the previous frame's bones (`positionPrevious`,
// whenever the draw needs previous data), but in the mesh's CURRENT space: in the attached bind
// mode the bones' matrices are world matrices, so they carry the walk too, and three's
// `bindMatrixInverse` is the inverse of the mesh's world matrix now. Taken as it is, under
// Motion's previous model matrix, the walk would count twice. It is rebased here into the mesh's
// space a rendered frame ago, inverse( previous world ) x world now, so the previous world point
// is the previous bones' and the two motions stay apart: `flags.mv.object = false` leaves the walk
// out, `flags.mv.skin = false` the clips (the previous skinned vertex is the current one). Across
// a cut (`taaCut`), or when the figure was not drawn in the previous rendered frame, its skin does
// not move either: three's previous bones are then those of whenever it was last drawn.

interface SkinTrack { frame: number; current: THREE.Matrix4; previous: THREE.Matrix4; rebase: THREE.Matrix4; moving: boolean }
const skinTracks = new WeakMap<THREE.Object3D, SkinTrack>();

// the figure's state for the rendered frame being drawn, updated at its first draw in that frame
function skinTrackOf( object: THREE.Object3D ): SkinTrack {

	const frame = motionState.frame;
	let t = skinTracks.get( object );
	if ( t === undefined ) {

		t = { frame: - 1, current: object.matrixWorld.clone(), previous: new THREE.Matrix4(), rebase: new THREE.Matrix4(), moving: false };
		skinTracks.set( object, t );

	}
	if ( t.frame !== frame ) {

		const continuous = t.frame === frame - 1 && ! motionState.cut;
		t.previous.copy( continuous ? t.current : object.matrixWorld );
		t.current.copy( object.matrixWorld );
		t.rebase.copy( t.previous ).invert().multiply( t.current );
		t.moving = continuous && debugFlags.mv.skin !== false;
		t.frame = frame;

	}
	return t;

}

// (object uniforms: set for each draw before its bindings are uploaded)
const skinRebase = uniform( new THREE.Matrix4() ).onObjectUpdate( ( { object } ) => object ? skinTrackOf( object ).rebase : undefined );
const skinMoving = uniform( 0 ).onObjectUpdate( ( { object } ) => object ? ( skinTrackOf( object ).moving ? 1 : 0 ) : undefined );

/** A figure's velocity under the temporal modes: class character, its skin's previous vertex in
 * the mesh's previous space (see above). */
export function addSkinnedMotion( mat: THREE.MeshStandardNodeMaterial ): void {

	const material = mat as unknown as { setupPosition( builder: THREE.NodeBuilder ): THREE.Node };
	const setupPosition = material.setupPosition.bind( mat );
	material.setupPosition = ( builder: THREE.NodeBuilder ) => {

		// after three's skinning, which assigns both positions
		const position = setupPosition( builder );
		const b = builder as unknown as { object: THREE.Object3D | null; needsPreviousData(): boolean };
		if ( ( b.object as THREE.SkinnedMesh | null )?.isSkinnedMesh === true && b.needsPreviousData() ) {

			const rebased = skinRebase.mul( vec4( positionPrevious, 1 ) ).xyz;
			positionPrevious.assign( select( skinMoving.greaterThan( 0.5 ), rebased, positionLocal ) );

		}
		return position;

	};
	mat.mrtNode = velocityOutput( motionNode( 'character' ) );

}
