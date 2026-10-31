import * as THREE from 'three/webgpu';
import { normalWorldGeometry, select, vec3 } from 'three/tsl';
import { debugFlags } from './DebugFlags.ts';

// The kinds' view (debug builds, `flags=classes`, read at load): every lit surface drawn unlit in a
// flat colour that names its kind, so a script reads what each pixel shows (a script that reads cells:
// `__PONLAI__.radiance( { aov: 'class' } )`, debug/RadianceAov.ts).
//
// The kinds (FIT_CLASSES, by index k): sky, sea, ground (the terrain's turf and the sea floor),
// rock (the cliffs and the stones), grass (the meadow's blades and flowers), leaves (the bamboo's
// and the yunpeng's), wood (the bamboo's culms), figure (the islanders) and other (anything else
// lit). The sky and the sea are not lit by these models: a reader finds them by depth (the sky's
// view z beyond the far sentinel, the sea's surface in front of the opaque pass). A kind's colour
// is the linear ( 1, t, t^2 ) with t = ( k + 1 ) / 10, decoded from the ratios G / R and B / R, so
// the decoding holds whatever scale the target stores at (the pre-exposure) and a pixel whose
// samples mix two kinds decodes to none. Under MSAA that is every pixel the cut-out leaves cover in
// part (half the island's pixels seen from above), and two kinds' blends of four samples can equal
// two others', so a page read for its kinds loads with `aa=off` (the classes page of a script that reads cells).
//
// The kind comes from the material and the mesh it is built for (their names and userData, set
// where they are made), never from colours: the terrain's material (`userData.topY` or
// `terrainVariant`) is rock on the 'rocks' mesh, ground on the 'seabed', and on the island's chunks
// ground where the geometry's normal is within 40 degrees of up, rock elsewhere; a material marked
// `userData.vegetation` is grass on the meadow's blade meshes ('grass-blades…'), leaves otherwise;
// the culms' mesh (`userData.culms`) and the yunpeng are wood and leaves; the islanders' materials
// ('figure', 'feathers', 'weave') are figure.
//
// Run from debug/LightLayer.ts's hook (the lighting model roots' constructors), it overrides the
// model's light like `albedoOnly` and leaves what a material adds after its lighting: a material's
// emission (the yunpeng's glow at night) lands on the code, and those pixels decode to none.

/** The kinds' names, by index. */
export const FIT_CLASSES = [ 'sky', 'sea', 'ground', 'rock', 'grass', 'leaves', 'wood', 'figure', 'other' ] as const;
export type FitClass = typeof FIT_CLASSES[ number ];

/** Whether the page draws the kinds' view. */
export const CLASSES = debugFlags.classes === true || debugFlags.classes === 1;

// the 40 degrees from up that split the island's ground from its cliff
const GROUND_COS = Math.cos( 40 * Math.PI / 180 );

const code = ( kind: FitClass ) => {

	const t = ( FIT_CLASSES.indexOf( kind ) + 1 ) / 10;
	return vec3( 1, t, t * t );

};

type Reflected = { directDiffuse: THREE.Node<'vec3'>; directSpecular: THREE.Node<'vec3'>; indirectDiffuse: THREE.Node<'vec3'>; indirectSpecular: THREE.Node<'vec3'> };

// the kind's colour for the mesh and material a build is for
function kindColour( object: THREE.Object3D | null, material: THREE.Material | null ): THREE.Node<'vec3'> {

	const mud = ( material?.userData ?? {} ) as Record<string, unknown>;
	const name = object?.name ?? '', parent = object?.parent?.name ?? '';
	if ( mud.topY !== undefined || mud.terrainVariant !== undefined ) {

		if ( name === 'rocks' ) return code( 'rock' );
		if ( name === 'seabed' ) return code( 'ground' );
		return select( normalWorldGeometry.y.greaterThan( GROUND_COS ), code( 'ground' ), code( 'rock' ) );

	}
	if ( mud.vegetation ) return name.startsWith( 'grass' ) ? code( 'grass' ) : code( 'leaves' );
	if ( object?.userData.culms ) return code( 'wood' );
	const mname = material?.name ?? '';
	if ( mname === 'yunpeng' ) return code( 'leaves' );
	if ( mname === 'figure' || mname === 'feathers' || mname === 'weave' || parent.startsWith( 'Hanming' ) ) return code( 'figure' );
	return code( 'other' );

}

/** Overrides a lighting model so it draws its kind's colour (see the header). */
export function useClasses( model: THREE.LightingModel ): void {

	const m = model as unknown as { direct(): void; indirect( builder: THREE.NodeBuilder ): void };
	m.direct = () => {};
	m.indirect = ( builder ) => {

		const reflected = ( builder.context as unknown as { reflectedLight: Reflected } ).reflectedLight;
		reflected.directDiffuse.assign( kindColour( builder.object as THREE.Object3D | null, builder.material as THREE.Material | null ) );
		reflected.directSpecular.assign( vec3( 0 ) );
		reflected.indirectDiffuse.assign( vec3( 0 ) );
		reflected.indirectSpecular.assign( vec3( 0 ) );

	};

}
