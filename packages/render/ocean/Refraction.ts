/*!
 * Adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import { float } from 'three/tsl';

// The water's refraction source: the scene below the water only, drawn at half density.
//
// The water's refraction source (tidewater's RefractionPass, 4811ba4): the scene below the water
// only, drawn by the frame graph's `refraction` pass (Pipeline.ts) right after the opaque pass, with
// the same (jittered) camera through a wider view, at half the render's pixel density. The water
// samples it at the end point of its refracted view ray (Water.ts).
//
// The opaque copy cannot serve for this alone: wherever something above the water (the cliffs above
// the waterline, a figure on the rim) stands in front of the refracted end point, the floor there
// was never drawn, and the water fell back to what lies straight behind it. Here fragments higher
// than the sea level + CLIP_MARGIN are clipped, so those surfaces never enter the image, and the
// submerged ones (the floor, the stones, the cliffs' feet) are shaded with their full materials and
// lighting.
//
// What it draws: the world's group (World.ts: the island, the stones, the floor) is a ClippingGroup
// whose plane keeps what lies below that height, and it lies in REFRACTED_LAYER alone; its meshes
// and the key light lie in REFRACTED_LAYER as well as the default layer. The pass's camera sees
// REFRACTED_LAYER only: the group is visible to it, so its clipping applies, and of the scene it
// draws those meshes lit by the key light (the plants, the islanders, the sky never enter). Every
// other camera sees the default layer, to which the group itself is invisible: three applies a
// ClippingGroup's planes only where the group is visible, and it draws the children of an invisible
// group as usual, so the opaque pass and the shadow maps draw the world unclipped. A mesh that can
// reach under the sea and should show through it joins with `showUnderwater`: under the world's
// group if it also rises above the clip height, anywhere if it stays below it. A light it is lit
// by joins too (the key light does: main.ts).
//
// The target: rgb the lit colour, a its coverage (cleared to 0: where nothing below the water was
// drawn, the water falls back to the opaque copy), and its own depth. Most of the screen's floor the
// opaque image holds as well, and the water reads it from there (the underwater pyramid), so a mask
// drawn first into the depth at the nearest depth (Pipeline.ts) leaves those texels unshaded: the
// pass shades what stands behind the surfaces above the water, beside them, and the part of the
// guard band the water's lookups reach in this frame's view.
//
// The view is wider than the screen (a guard band): light bends down into the water, so a refracted
// ray lands on floor lower on the screen than the pixel it is seen through, and near the bottom edge
// below the screen. The band holds that floor, so the water never has to invent it. GUARD: the extra
// view in NDC units (1 = half the screen) on each side. tidewater widens the sides by 0.15; here
// they take 0.3, which makes the view as much wider as it is taller (1.3 times both ways), so the
// target is one of the graph's render-relative size classes (one scale for both axes).
// REFRACTION_GUARD is the clip-space scale ( sx, sy ) and centre ( cx, cy ):
// ndc_refraction = ( ndc_screen - c ) / s, as the water maps its lookups.

/** Fragments above this height over the sea level are left out (m): the troughs and crests move
 * the real surface around it. */
export const CLIP_MARGIN = 0.4;

/** The layer of what the refraction's camera draws. */
export const REFRACTED_LAYER = 7;

const GUARD = { left: 0.3, right: 0.3, bottom: 0.6, top: 0 };
export const REFRACTION_GUARD = {
	cx: ( GUARD.right - GUARD.left ) / 2, cy: ( GUARD.top - GUARD.bottom ) / 2,
	sx: 1 + ( GUARD.left + GUARD.right ) / 2, sy: 1 + ( GUARD.top + GUARD.bottom ) / 2,
};

/** The target's size: half the render's pixel density over the wider view. */
export const REFRACTION_SIZE = { of: 'render', scale: 0.5 * REFRACTION_GUARD.sx, min: 1 } as const;
if ( REFRACTION_GUARD.sx !== REFRACTION_GUARD.sy ) throw new Error( 'Refraction: the guard band must widen both axes alike' );

const guardMatrix = new THREE.Matrix4().set(
	1 / REFRACTION_GUARD.sx, 0, 0, - REFRACTION_GUARD.cx / REFRACTION_GUARD.sx,
	0, 1 / REFRACTION_GUARD.sy, 0, - REFRACTION_GUARD.cy / REFRACTION_GUARD.sy,
	0, 0, 1, 0,
	0, 0, 0, 1,
);

/** The refraction pass's camera: the scene camera, as it draws this frame, through the guard band. */
export class RefractionView {

	readonly camera = new THREE.PerspectiveCamera();

	constructor() {

		this.camera.layers.set( REFRACTED_LAYER );
		this.camera.matrixAutoUpdate = false;
		this.camera.matrixWorldAutoUpdate = false;

	}

	/** Before the pass: the scene camera's place and projection (with this frame's jitter, so the
	 * temporal resolve sees the floor as in the scene). */
	update( camera: THREE.Camera ): void {

		const c = this.camera, scene = camera as THREE.PerspectiveCamera;
		c.matrixWorld.copy( camera.matrixWorld );
		c.matrixWorldInverse.copy( camera.matrixWorldInverse );
		c.projectionMatrix.multiplyMatrices( guardMatrix, camera.projectionMatrix );
		c.projectionMatrixInverse.copy( c.projectionMatrix ).invert();
		c.near = scene.near;
		c.far = scene.far;

	}

}

/** A ClippingGroup that keeps what lies below the sea level + CLIP_MARGIN, for the refraction's
 * camera only (see the header). */
export function refractedGroup( seaLevel: number ): THREE.ClippingGroup {

	const group = new THREE.ClippingGroup();
	group.clippingPlanes = [ new THREE.Plane( new THREE.Vector3( 0, - 1, 0 ), seaLevel + CLIP_MARGIN ) ];
	group.layers.set( REFRACTED_LAYER );
	return group;

}

/** Marks `material` as something that swims in the water (the wenyao), which the refraction
 * image leaves out: it writes an alpha of 0 into the opaque image (three assigns opaque materials
 * an alpha of 1 under normal blending, so the mark takes none), the underwater pyramid leaves it
 * out (Pipeline.ts), and the water finds it along its refracted rays (Water.ts). A swimmer is not
 * shown to the refraction's camera: there it would stand in front of the floor that the rays
 * passing beside it reach, which the water then could not read anywhere. */
export function markSwimmer( material: THREE.NodeMaterial ): void {

	material.blending = THREE.NoBlending;
	material.opacityNode = float( 0 );

}

/** Shows `object` (a mesh that reaches under the sea, or a light) to the refraction's camera. */
export function showUnderwater( object: THREE.Object3D ): void {

	object.layers.enable( REFRACTED_LAYER );

}
