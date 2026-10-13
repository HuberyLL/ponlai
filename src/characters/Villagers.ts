import * as THREE from 'three/webgpu';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeVertexColourCharacterMaterial, KIND } from './CharacterMaterial.ts';
import { CharacterShadow } from './CharacterShadow.ts';
import { pointedEars } from './Ears.ts';
import { reproportion, PROPORTIONS, type Proportions } from './Proportions.ts';
import type { Shared } from '../shared.ts';

// Islanders assembled from modular low-poly parts (Ultimate Modular Characters by Quaternius,
// CC0): every outfit shares one rig, so a head, body, legs and feet from different outfits fit
// one skeleton and its animation clips. The parts are repainted in the island's palette as
// vertex colours and merged into one skinned mesh, lit by the island's character light. One
// walks a loop through the meadow; the walk clip's rate follows its speed so feet do not slide.
// Its place on the loop is a function of the scene clock; its clips cross-fade on the frame delta,
// which a paused clock holds, so a scene jump restarts them (`reset`).
// Their dress stays plain while the basic look settles: undyed linen and calm earthy tones, leather
// shoes, no hat (looks.ts). While the character art is settled the models load from the
// git-ignored artifacts/assets/ (tools/vite-assets.mjs serves and links them). A small moving
// sun-shadow map of the figures is multiplied into the island's (CharacterShadow.ts).

export type GroundFn = ( x: number, z: number ) => number;

/** A part: the outfit file and part name, and its repaint (original material -> colour, kind). */
export interface PartSpec {
	from: string; part: string; paint: Record<string, [ THREE.ColorRepresentation, number ]>;
	// a repaint for vertices driven mostly by the wrists and fingers (one material can cover sleeve and glove)
	hands?: [ THREE.ColorRepresentation, number ];
}

const HEIGHT = 1.68;
const FADE = 0.35;

export interface Villager {
	group: THREE.Group;
	mixer: THREE.AnimationMixer;
	actions: Record<string, THREE.AnimationAction>;
	strideSpeed: number;
}

/** Bake a part's material groups into vertex colours and shading channels. */
function paintPart( mesh: THREE.SkinnedMesh, paint: PartSpec[ 'paint' ], hands?: PartSpec[ 'hands' ] ): THREE.BufferGeometry {

	const src = mesh.geometry;
	const g = new THREE.BufferGeometry();
	for ( const name of [ 'position', 'normal', 'skinIndex', 'skinWeight' ] ) g.setAttribute( name, src.getAttribute( name ) );
	g.setIndex( src.getIndex() );
	const n = src.getAttribute( 'position' ).count;
	const colour = new Float32Array( n * 3 ), shade = new Float32Array( n * 4 );
	const materials = Array.isArray( mesh.material ) ? mesh.material : [ mesh.material ];
	const groups = src.groups.length ? src.groups : [ { start: 0, count: src.getIndex()!.count, materialIndex: 0 } ];
	const index = src.getIndex()!;
	const c = new THREE.Color(), h = new THREE.Color( hands?.[ 0 ] ?? 0 );
	const skinIndex = src.getAttribute( 'skinIndex' ), skinWeight = src.getAttribute( 'skinWeight' );
	const handBone = mesh.skeleton.bones.map( ( b ) => /^(Wrist|Index|Middle|Ring|Pinky|Thumb)/.test( b.name ) );
	const onHand = ( v: number ) => {

		let w = 0;
		for ( let k = 0; k < 4; k ++ ) if ( handBone[ skinIndex.getComponent( v, k ) ] ) w += skinWeight.getComponent( v, k );
		return w > 0.5;

	};
	for ( const grp of groups ) {

		const mat = materials[ grp.materialIndex ?? 0 ] as THREE.MeshStandardMaterial;
		const [ col, kind ] = paint[ mat.name ] ?? [ mat.color, KIND.cloth ];
		c.set( col );
		for ( let i = grp.start; i < grp.start + grp.count; i ++ ) {

			const v = index.getX( i );
			const hand = hands !== undefined && onHand( v );
			const cc = hand ? h : c;
			colour.set( [ cc.r, cc.g, cc.b ], v * 3 );
			shade.set( [ hand ? hands[ 1 ] : kind, 1, 0, 0 ], v * 4 );

		}

	}
	g.setAttribute( 'color', new THREE.BufferAttribute( colour, 3 ) );
	g.setAttribute( 'shade', new THREE.BufferAttribute( shade, 4 ) );
	return g;

}

/**
 * Assemble parts on the rig of the first part's file, with that file's animation clips, and
 * re-proportion the figure (Proportions.ts; the kit's own proportions by default).
 */
export async function loadVillager( base: string, parts: PartSpec[], shared: Shared, proportions: Proportions = PROPORTIONS.stock ): Promise<Villager> {

	const loader = new GLTFLoader();
	const files = new Map<string, GLTF>();
	for ( const name of new Set( [ base, ...parts.map( ( p ) => p.from ) ] ) ) files.set( name, await loader.loadAsync( name ) );
	const rig = files.get( base )!;
	const model = rig.scene;
	let bound: THREE.SkinnedMesh | null = null;
	const geometries: THREE.BufferGeometry[] = [];
	for ( const spec of parts ) {

		// a part with several materials loads as a group of single-material skinned meshes
		const node = files.get( spec.from )!.scene.getObjectByName( spec.part )!;
		const painted: THREE.BufferGeometry[] = [];
		let skinned: THREE.SkinnedMesh | null = null;
		node.traverse( ( o ) => {

			if ( ! ( o as THREE.SkinnedMesh ).isSkinnedMesh ) return;
			skinned = o as THREE.SkinnedMesh;
			painted.push( paintPart( skinned, spec.paint, spec.hands ) );

		} );
		geometries.push( ...painted );
		// every head of the kit (named *_Head) grows the islanders' pointed ears
		const ears = skinned && /Head$/.test( spec.part ) ? pointedEars( skinned, painted ) : null;
		if ( ears ) geometries.push( ears );

	}
	// drop the rig file's own meshes; keep its armature
	model.traverse( ( o ) => { if ( ( o as THREE.SkinnedMesh ).isSkinnedMesh && ! bound ) bound = o as THREE.SkinnedMesh; } );
	const template = bound! as THREE.SkinnedMesh;
	const parent = template.parent!;
	const old: THREE.Object3D[] = [];
	model.traverse( ( o ) => { if ( ( o as THREE.Mesh ).isMesh ) old.push( o ); } );
	for ( const o of old ) o.removeFromParent();
	const mesh = new THREE.SkinnedMesh( mergeGeometries( geometries )!, makeVertexColourCharacterMaterial( shared ) );
	mesh.name = 'villager';
	parent.add( mesh );
	mesh.bind( template.skeleton, template.bindMatrix );
	reproportion( mesh, rig.animations, proportions );
	mesh.castShadow = false;
	mesh.receiveShadow = true;
	mesh.frustumCulled = false;
	mesh.layers.enable( CharacterShadow.LAYER );

	const group = new THREE.Group();
	group.add( model );
	model.updateMatrixWorld( true );
	const box = new THREE.Box3().setFromObject( mesh, true );
	model.scale.setScalar( HEIGHT / ( box.max.y - box.min.y ) );
	model.position.y = - box.min.y * model.scale.y;
	const mixer = new THREE.AnimationMixer( model );
	const actions: Record<string, THREE.AnimationAction> = {};
	for ( const clip of rig.animations ) actions[ clip.name ] = mixer.clipAction( clip );
	return { group, mixer, actions, strideSpeed: measureStride( model, mixer, actions.Walk ) };

}

/** Ground speed of a walk clip: how fast a planted foot moves back under the hips. */
function measureStride( model: THREE.Object3D, mixer: THREE.AnimationMixer, walk: THREE.AnimationAction ): number {

	// GLTFLoader drops the dot from node names (Foot.L -> FootL)
	const foot = model.getObjectByName( 'FootL' )!;
	const clip = walk.getClip();
	walk.play();
	const samples: { t: number; y: number; z: number }[] = [];
	const p = new THREE.Vector3();
	const n = 120;
	for ( let i = 0; i <= n; i ++ ) {

		mixer.setTime( clip.duration * i / n );
		model.updateMatrixWorld( true );
		foot.getWorldPosition( p );
		samples.push( { t: clip.duration * i / n, y: p.y, z: p.z } );

	}
	walk.stop();
	mixer.setTime( 0 );
	const minY = Math.min( ...samples.map( ( s ) => s.y ) );
	const v: number[] = [];
	for ( let i = 1; i < samples.length; i ++ ) {

		const a = samples[ i - 1 ], b = samples[ i ];
		if ( a.y < minY + 0.015 && b.y < minY + 0.015 ) v.push( - ( b.z - a.z ) / ( b.t - a.t ) );

	}
	v.sort( ( x, y ) => x - y );
	return Math.abs( v[ Math.floor( v.length / 2 ) ] ?? 1 );

}

export class Villagers {

	readonly group = new THREE.Group();
	readonly walker: Villager;
	private path: THREE.CatmullRomCurve3;
	private length: number;
	private readonly ground: GroundFn;
	private readonly shadow: CharacterShadow;
	private readonly centre = new THREE.Vector3();
	private readonly speed: number;
	private walking = false;
	private heading = NaN;

	constructor( walker: Villager, waypoints: [ number, number ][], ground: GroundFn, shadow: CharacterShadow, speed = 0.9 ) {

		this.walker = walker;
		this.ground = ground;
		this.shadow = shadow;
		this.speed = speed;
		( { path: this.path, length: this.length } = Villagers.loop( waypoints ) );
		this.group.add( walker.group );
		walker.actions.Idle_Neutral.play();

	}

	/** The walking loop through `waypoints` and its length (its arc lengths measured). */
	static loop( waypoints: [ number, number ][] ): { path: THREE.CatmullRomCurve3; length: number } {

		const path = new THREE.CatmullRomCurve3( waypoints.map( ( [ x, z ] ) => new THREE.Vector3( x, 0, z ) ), true, 'centripetal' );
		path.arcLengthDivisions = 800;
		return { path, length: path.getLength() };

	}

	/** Walk another loop (a grown island's, made ahead with `Villagers.loop`: Growth.ts): the
	 * walker stands where the schedule puts it on the new loop at the next update, as on a page
	 * loaded on that land. */
	setLoop( loop: { path: THREE.CatmullRomCurve3; length: number } ): void {

		this.path = loop.path;
		this.length = loop.length;

	}

	/** Swap the walking figure (another build of it), keeping its place on the loop and its clips' phase. */
	setWalker( next: Villager ): void {

		const old = this.walker;
		for ( const name in old.actions ) {

			const from = old.actions[ name ], to = next.actions[ name ];
			if ( ! to || ! from.isRunning() ) continue;
			to.reset().play();
			to.time = from.time;
			to.setEffectiveWeight( from.getEffectiveWeight() );

		}
		next.group.position.copy( old.group.position );
		next.group.rotation.copy( old.group.rotation );
		this.group.remove( old.group );
		this.group.add( next.group );
		old.mixer.stopAllAction();
		old.group.traverse( ( o ) => {

			const mesh = o as THREE.SkinnedMesh;
			if ( ! mesh.isSkinnedMesh ) return;
			mesh.geometry.dispose();
			( mesh.material as THREE.Material ).dispose();

		} );
		( this as { walker: Villager } ).walker = next;

	}

	/** The walker as constructed: standing, its clips from their start, its heading taken afresh on
	 * the next update (a scene jump, main.ts `establishScene`: a paused clock never finishes a
	 * cross-fade the scene before began). */
	reset(): void {

		const w = this.walker;
		w.mixer.stopAllAction();
		w.mixer.setTime( 0 );
		w.actions.Idle_Neutral.reset().play();
		this.walking = false;
		this.heading = NaN;

	}

	/** Distance along the loop at time t: walk 9 s, stand 4 s. */
	private schedule( t: number ): { s: number; walking: boolean } {

		const walk = 9, pause = 4, period = walk + pause;
		const k = Math.floor( t / period ), r = t - k * period;
		return { s: this.speed * ( k * walk + Math.min( r, walk ) ), walking: r < walk };

	}

	update( renderer: THREE.WebGPURenderer, scene: THREE.Scene, sun: THREE.DirectionalLight, time: number, dt: number ): void {

		const w = this.walker;
		const { s, walking } = this.schedule( time );
		const u = ( ( s / this.length ) % 1 + 1 ) % 1;
		const p = this.path.getPointAt( u );
		const tan = this.path.getTangentAt( u );
		w.group.position.set( p.x, this.ground( p.x, p.z ), p.z );
		// turn toward the path heading over a few frames rather than snapping
		const target = Math.atan2( tan.x, tan.z );
		if ( Number.isNaN( this.heading ) || dt <= 0 ) this.heading = target;
		else {

			const d = Math.atan2( Math.sin( target - this.heading ), Math.cos( target - this.heading ) );
			this.heading += d * Math.min( 1, dt * 6 );

		}
		w.group.rotation.y = this.heading;
		if ( walking !== this.walking ) {

			const from = this.walking ? w.actions.Walk : w.actions.Idle_Neutral;
			const to = walking ? w.actions.Walk : w.actions.Idle_Neutral;
			to.reset().play();
			from.crossFadeTo( to, FADE, false );
			this.walking = walking;

		}
		w.actions.Walk.timeScale = this.speed / w.strideSpeed;
		w.mixer.update( Math.max( dt, 0 ) );
		this.centre.copy( w.group.position ).y += 0.85;
		this.shadow.update( renderer, scene, sun, this.centre );

	}

}
