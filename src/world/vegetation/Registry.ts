import type * as THREE from 'three/webgpu';
import type { WorldData } from '../types.ts';

// The vegetation's registry: every plant kind the page draws, once, with what it takes part in.
// The page's lists of vegetation roots read it (main.ts: the scene, the depth prepass, the sun's
// caster box, the rain's collision bake; Growth.ts: the kinds' growth and the rain's bake after a
// swap) instead of naming the kinds at each place.
// - Order: the kinds are registered in the order the scene draws them (today the grass, then the
//   yunpeng, then the bamboo's culms and leaves), and
//   every list keeps it: draws of equal render order and depth keep their order.
// - The depth prepass (`prepass`, VegetationPrepass.ts) and the shadow filter (`shadowFilter`,
//   SunShadow.ts) are separate choices. The shadow filter is still read from the materials'
//   vegetation tag (`userData.vegetation`, vegetation/Coverage.ts markVegetation), which the depth
//   prepass under the temporal modes, the rain's bake and the wind probe read too; `add` checks that
//   a kind's materials carry the tag its `shadowFilter` names.
// - Growth (`growth`): a kind that changes with the land prepares its next version in the growth's
//   idle-time steps and swaps it in, in the swap's frame, without building a pipeline (Growth.ts).
//   The kinds prepare and swap in registry order. A kind that writes its buffers in place at the
//   swap stages the write ahead (`stage`, Upload.ts stagedWriteSteps): kept for the plant kinds to
//   come; no kind uses it today (the grass takes new buffers).

/** A preparation step yields nothing (a slice ends) or a promise (wait for it: a worker, a compile). */
export type GrowthSteps<T> = Generator<void | Promise<unknown>, T>;

/** What a kind's growth preparation reads (Growth.ts). */
export interface GrowthInput {
	renderer: THREE.WebGPURenderer;
	/** the next version's world */
	data: WorldData;
	/** metres from a point to the islander's walking loop on the next land */
	walkDistance( x: number, z: number ): number;
	/** keeps a staged in-place write (Upload.ts stagedWriteSteps) until the swap's frames are done */
	stage( free: ( () => void ) | null ): void;
}

/** A kind's part in the island's growth (Growth.ts). */
export interface KindGrowth<P> {
	/** the kind's next version, in steps of a few tenths of a millisecond, its buffers uploaded */
	prepare( input: GrowthInput ): GrowthSteps<P>;
	/** swaps `prepared` in, in the swap's frame; returns what to dispose of once nothing draws the
	 * old version (a frame or more later), or null */
	swap( prepared: P ): ( () => void ) | null;
}

export interface VegetationKind<P = unknown> {
	/** 'grass', 'yunpeng', 'bamboo', ... */
	name: string;
	/** what the page adds to the scene */
	root: THREE.Object3D;
	/** drawn after a depth-only copy (VegetationPrepass.ts) */
	prepass: boolean;
	/** the sun's shadow filter its materials take (SunShadow.ts) */
	shadowFilter: 'vegetation' | 'ordinary';
	/** inside the sun's caster box (main.ts setSunCasters) */
	sunCaster: boolean;
	/** baked into the rain's collision map */
	rainBake: boolean;
	growth?: KindGrowth<P>;
}

export class Vegetation {

	readonly kinds: VegetationKind[] = [];

	add<P>( kind: VegetationKind<P> ): void {

		const tagged = kind.shadowFilter === 'vegetation';
		kind.root.traverse( ( object ) => {

			const mesh = object as THREE.Mesh;
			if ( ! mesh.isMesh || mesh.userData.prepassCopy ) return;
			for ( const material of Array.isArray( mesh.material ) ? mesh.material : [ mesh.material ] ) {

				if ( ( material.userData.vegetation === true ) !== tagged ) throw new Error( `Vegetation: ${ kind.name }'s material ${ material.name || material.type } is ${ tagged ? 'not ' : '' }tagged as vegetation, against its shadow filter '${ kind.shadowFilter }'` );

			}

		} );
		this.kinds.push( kind );

	}

	/** The kinds' roots in registry order, those `filter` keeps. */
	roots( filter: ( kind: VegetationKind ) => boolean = () => true ): THREE.Object3D[] {

		return this.kinds.filter( filter ).map( ( kind ) => kind.root );

	}

}
