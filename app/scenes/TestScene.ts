// A test scene's declaration: what it tests, its views, hours, weathers and readings.
//
// A test scene's declaration and the parts every scene is built from. A test scene is a small scene
// of the render pipeline alone, which the scene page (ScenePage.ts) builds with the render
// pipeline's stages on the render pipeline's neutral inputs (NeutralInputs.ts): level ground of one
// albedo under an open sky, or the open sea over a level floor, and whatever the scene places there
// (plant kinds among it, drawn with the registry's default plant). It declares what it tests, its
// views, the hours and weathers it is captured at and the readings taken of it, so a tool captures
// and reads it without knowing the scene (tools/render/scenes.mjs).
//
// Rules:
// - A scene imports the render pipeline through its entry points only (render/index.ts, render/setup.ts,
//   render/data.ts), never the island or the game, and never another layer's module by its path
//   (tools/repo/verify-layers.mjs).
// - Its surfaces are lit as every other surface is (`surface`: the shared lighting model and the
//   metering light, docs/bindings/building-cinematic-stylised-realism.md, Materials).
// - Everything it places is a function of constants: no random stream, no clock, so every load is bit-identical.
import * as THREE from 'three/webgpu';
import { GroundBounceLightingModel, writeMeter, type RenderParts, type VegetationKind } from '../../packages/render/index.ts';

/** A point or a linear colour. */
export type Triple = readonly [ number, number, number ];

/** A view: where the camera stands, what it looks at, and its vertical field of view (degrees;
 * the render pipeline's 27 without one). A view may follow the key (`eye` and `target` functions of
 * its direction, unit, toward the sun or the moon), posed when it is shown; the first view, which a
 * scene jump poses before the key is the new hour's, is fixed. */
export interface SceneView {
	name: string;
	eye: Triple | ( ( key: THREE.Vector3 ) => Triple );
	target: Triple | ( ( key: THREE.Vector3 ) => Triple );
	fov?: number;
}

/** An hour and a weather the scene is captured at: the scene options of its query (`weather`, `hour`,
 * `preset`, `moon`, ...), as a load's address or a scene jump takes them. */
export interface SceneTime { name: string; query: string }

/** What a reading's place is worked out from, when it is taken. */
export interface ReadingContext {
	/** the key's direction (unit, toward the sun, or the moon by night) */
	key: THREE.Vector3;
	/** the camera of the view */
	camera: THREE.PerspectiveCamera;
}

/** A reading: the scene's radiance over a small box of the frame round a point of the scene
 * (`at`, m) or round a direction of the sky from the eye (`toward`, unit). `size` is the box's
 * side as a share of the frame's height (0.02 without one). */
export interface SceneReading {
	name: string;
	at?: Triple | ( ( context: ReadingContext ) => Triple );
	toward?: Triple | ( ( context: ReadingContext ) => Triple );
	size?: number;
}

/** What a scene builds. */
export interface SceneContent {
	/** what it draws in the opaque scene: the ground and everything on it */
	objects: THREE.Object3D[];
	/** the box of everything that casts into the sun's map (m), or null where nothing does; the
	 * plant kinds' casters are added to it */
	casters: THREE.Box3 | null;
	/** the plant kinds it registers (vegetation/Registry.ts), each without a root, drawn with the
	 * registry's default plant at its sites */
	plants?: VegetationKind[];
}

/** The scene's ground: level land of a linear albedo at a height over the sea's mean level (m), or
 * the open sea, far from any shore, over a level floor of a linear albedo at a depth (m). */
export type SceneGround =
	| { kind: 'land'; height: number; albedo: Triple }
	| { kind: 'sea'; depth: number; floor: Triple };

export interface TestScene {
	name: string;
	/** what the scene tests, in a sentence */
	about: string;
	/** the level ground, or the open sea */
	ground: SceneGround;
	/** Builds the scene's content, once, after the render pipeline's light exists. */
	build( render: RenderParts ): SceneContent;
	/** the views, the first the one a load shows */
	views: SceneView[];
	/** the hours and weathers it is captured at */
	times: SceneTime[];
	/** the readings taken in each view; a view takes those its frame holds */
	readings: SceneReading[];
}

/** A lit surface of one albedo (linear), as every other surface is lit: the shared lighting
 * model and the metering light beside the colour. */
export function surface( name: string, albedo: Triple, { roughness = 0.9, metalness = 0 }: { roughness?: number; metalness?: number } = {} ): THREE.MeshStandardNodeMaterial {

	const material = new THREE.MeshStandardNodeMaterial( { roughness, metalness } );
	material.color.setRGB( albedo[ 0 ], albedo[ 1 ], albedo[ 2 ], THREE.LinearSRGBColorSpace );
	material.name = name;
	( material as unknown as { setupLightingModel: () => THREE.LightingModel } ).setupLightingModel = () => new GroundBounceLightingModel();
	writeMeter( material );
	return material;

}

// The ground's rings (m): each ring's radius is twice the one inside it, so the triangles near
// the views are small (a varying interpolated over a triangle tens of kilometres wide loses the
// centimetres the shadow's lookup needs) and the disc still reaches the horizon.
const GROUND_RINGS = 14, GROUND_INNER = 4, GROUND_SEGMENTS = 64;
/** The radius the ground reaches (m): past the horizon of every view. */
export const GROUND_RADIUS = GROUND_INNER * 2 ** ( GROUND_RINGS - 1 );

/** The level ground: a disc at `height` (m) out to GROUND_RADIUS, which receives shadows and
 * casts none. */
export function groundDisc( height: number, material: THREE.Material ): THREE.Mesh {

	const positions: number[] = [ 0, 0, 0 ], indices: number[] = [];
	for ( let ring = 0; ring < GROUND_RINGS; ring ++ ) {

		const r = GROUND_INNER * 2 ** ring;
		for ( let s = 0; s < GROUND_SEGMENTS; s ++ ) {

			const a = s / GROUND_SEGMENTS * 2 * Math.PI;
			positions.push( r * Math.cos( a ), 0, r * Math.sin( a ) );

		}

	}
	const at = ( ring: number, s: number ) => 1 + ring * GROUND_SEGMENTS + s % GROUND_SEGMENTS;
	// (counter-clockwise seen from above: the angle runs from +x toward +z, clockwise from above)
	for ( let s = 0; s < GROUND_SEGMENTS; s ++ ) indices.push( 0, at( 0, s + 1 ), at( 0, s ) );
	for ( let ring = 1; ring < GROUND_RINGS; ring ++ ) for ( let s = 0; s < GROUND_SEGMENTS; s ++ ) {

		indices.push( at( ring - 1, s ), at( ring - 1, s + 1 ), at( ring, s ) );
		indices.push( at( ring - 1, s + 1 ), at( ring, s + 1 ), at( ring, s ) );

	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'normal', new THREE.Float32BufferAttribute( positions.map( ( _, k ) => k % 3 === 1 ? 1 : 0 ), 3 ) );
	geometry.setIndex( new THREE.Uint32BufferAttribute( indices, 1 ) );
	geometry.computeBoundingSphere();
	geometry.computeBoundingBox();
	const mesh = new THREE.Mesh( geometry, material );
	mesh.name = 'ground';
	mesh.position.y = height;
	mesh.receiveShadow = true;
	mesh.castShadow = false;
	mesh.updateMatrixWorld();
	return mesh;

}
