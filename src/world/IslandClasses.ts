import { classifyBy, type ClassRule } from '../debug/Classes.ts';

// The island's kinds for the kinds' view (debug/Classes.ts, `flags=classes`): which of the scene's
// meshes and materials are ground, rock, grass, leaves, wood and figure, told by the names and
// userData they are given where they are made. The terrain's material (`userData.topY` or
// `terrainVariant`) is rock on the 'rocks' mesh, ground on the 'seabed', and on the island's chunks
// ground where the geometry's normal is within 40 degrees of up, rock elsewhere; a material marked
// `userData.vegetation` is grass on the meadow's blade meshes ('grass-blades…'), leaves otherwise;
// the culms' mesh (`userData.culms`) and the yunpeng are wood and leaves; the islanders' materials
// ('figure', 'feathers', 'weave') are figure.

const islandClasses: ClassRule = ( object, material ) => {

	const mud = ( material?.userData ?? {} ) as Record<string, unknown>;
	const name = object?.name ?? '', parent = object?.parent?.name ?? '';
	if ( mud.topY !== undefined || mud.terrainVariant !== undefined ) return name === 'rocks' ? 'rock' : name === 'seabed' ? 'ground' : 'slope';
	if ( mud.vegetation ) return name.startsWith( 'grass' ) ? 'grass' : 'leaves';
	if ( object?.userData.culms ) return 'wood';
	const mname = material?.name ?? '';
	if ( mname === 'yunpeng' ) return 'leaves';
	if ( mname === 'figure' || mname === 'feathers' || mname === 'weave' || parent.startsWith( 'Hanming' ) ) return 'figure';
	return null;

};

/** Registers the island's kinds with the kinds' view; called once, before any material builds. */
export function registerIslandClasses(): void {

	classifyBy( islandClasses );

}
