import * as THREE from 'three/webgpu';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeVertexColourCharacterMaterial, KIND } from './CharacterMaterial.ts';
import { CharacterShadow } from './CharacterShadow.ts';
import { makeFeatherMaterial, makeLitFigureMaterial, makeWeaveMaterial } from './FigureSurfaces.ts';
import { pointedEars } from './Ears.ts';
import { reproportion, PROPORTIONS, type Proportions } from './Proportions.ts';
import { FigureAge, derivedShapeKeys, mergeShapeKeys, strideSteps, takeShapeKeys, type ShapeKeys } from './FigureAge.ts';
import { runSteps, type Shared } from '../../render/index.ts';
import type { Body, Sex } from './Ages.ts';
import type { TrampleWalker } from '../world/Trample.ts';

// The islanders assembled from modular parts on one rig, one of them walking a loop in the meadow.
//
// Islanders assembled from modular low-poly parts (Ultimate Modular Characters by Quaternius,
// CC0): every outfit shares one rig, so a head, body, legs and feet from different outfits fit
// one skeleton and its animation clips. The parts are repainted in the island's palette as
// vertex colours and merged into one skinned mesh. One walks a loop through the meadow; the walk
// clip's rate follows its speed so feet do not slide.
// Its place on the loop is a function of the scene clock; its clips cross-fade on the frame delta,
// which a paused clock holds, so a scene jump restarts them (`reset`).
// Their dress is the Hanming look (looks.ts). A small moving sun-shadow map of the figures is
// multiplied into the island's (CharacterShadow.ts).
// The walker parts the meadow (world/Trample.ts): its track there is its schedule at the
// scene clock's earlier times (`track`), so the trail behind it is a function of the clock as well.
// A `lit` look (the feather-robed islanders, looks.ts HANMING) has its painted parts take the
// island's light (FigureSurfaces.ts), a look without it the cel light (CharacterMaterial.ts); its
// textured parts (`surface`: the feathers, the woven hat) draw as meshes of their own on the same
// skeleton, re-proportioned with it; the feathers stay out of the figures' shadow map, and the
// figure's height is its painted body's, hat left out.
// A figure loaded with a body (a sex and an age: Ages.ts) wears its sex's parts and takes its
// age's shape and proportions instead of a fixed build (FigureAge.ts): its height follows the
// age, and its clips animate through `animate`, which lays the old's stoop on them. Every part's
// shape keys come off its geometry as it loads, so no figure draws morph targets.

export type GroundFn = ( x: number, z: number ) => number;

/** A part: the outfit file and part name, and its repaint (original material -> colour, kind). */
export interface PartSpec {
	from: string; part: string; paint: Record<string, [ THREE.ColorRepresentation, number ]>;
	// a repaint for vertices driven mostly by the wrists and fingers (one material can cover sleeve and glove)
	hands?: [ THREE.ColorRepresentation, number ];
	/** a textured part drawn with its own surface (FigureSurfaces.ts) instead of painted */
	surface?: 'feather' | 'weave';
	/** worn by one sex only (a figure without a body is a man) */
	sex?: Sex;
}

/** the height of a figure without a body, feet to crown (m) */
export const FIGURE_HEIGHT = 1.68;
const FADE = 0.35;
/** the clips the islanders play: a figure with a body keeps only these, which each body it puts on
 * makes again (FigureAge.ts) */
export const CLIPS = [ 'Idle_Neutral', 'Walk' ];

export interface Villager {
	group: THREE.Group;
	mixer: THREE.AnimationMixer;
	actions: Record<string, THREE.AnimationAction>;
	/** its walk's ground speed (m per second of the clip) */
	readonly strideSpeed: number;
	/** feet to crown as it stands (m), hat left out: the game's interface hangs its marks over it */
	readonly height: number;
	/** its body's age (a figure loaded with a body), else null */
	age: FigureAge | null;
}

/** Animate a figure by `dt` seconds of its clips (and its age's stoop on them). */
export function animate( figure: Villager, dt: number ): void {

	figure.age?.unbend();
	figure.mixer.update( dt );
	figure.age?.bend();

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
 * re-proportion the figure (Proportions.ts; the kit's own proportions by default), or give it a
 * body's sex and age, its proportions those of its age against these (FigureAge.ts).
 */
export async function loadVillager( base: string, parts: PartSpec[], shared: Shared, proportions: Proportions = PROPORTIONS.stock, lit = false, body?: Body ): Promise<Villager> {

	const loader = new GLTFLoader();
	const files = new Map<string, GLTF>();
	const worn = parts.filter( ( p ) => ! p.sex || p.sex === ( body?.sex ?? 'male' ) );
	for ( const name of new Set( [ base, ...worn.map( ( p ) => p.from ) ] ) ) files.set( name, await loader.loadAsync( name ) );
	const rig = files.get( base )!;
	const model = rig.scene;
	let bound: THREE.SkinnedMesh | null = null;
	// the painted geometries and their shape keys, in the order they merge
	const geometries: THREE.BufferGeometry[] = [];
	const keyed: ( ShapeKeys | null )[] = [];
	const surfaces: { geometry: THREE.BufferGeometry; material: THREE.Material; casts: boolean; keys: ShapeKeys }[] = [];
	for ( const spec of worn ) {

		// a part with several materials loads as a group of single-material skinned meshes
		const node = files.get( spec.from )!.scene.getObjectByName( spec.part )!;
		const painted: THREE.BufferGeometry[] = [];
		const paintedKeys: ShapeKeys[] = [];
		let skinned: THREE.SkinnedMesh | null = null;
		node.traverse( ( o ) => {

			if ( ! ( o as THREE.SkinnedMesh ).isSkinnedMesh ) return;
			skinned = o as THREE.SkinnedMesh;
			const keys = takeShapeKeys( skinned );
			if ( spec.surface ) {

				const source = skinned.material as THREE.MeshStandardMaterial;
				const material = spec.surface === 'feather' ? makeFeatherMaterial( source.map! ) : makeWeaveMaterial( source );
				surfaces.push( { geometry: skinned.geometry, material, casts: spec.surface !== 'feather', keys } );

			} else {

				painted.push( paintPart( skinned, spec.paint, spec.hands ) );
				paintedKeys.push( keys );

			}

		} );
		geometries.push( ...painted );
		keyed.push( ...paintedKeys );
		// every head of the kit (named *_Head) grows the islanders' pointed ears, which follow the
		// head's keys as they are grown again on each keyed head
		const head = skinned as THREE.SkinnedMesh | null;
		const ears = head && /Head$/.test( spec.part ) ? pointedEars( head, painted ) : null;
		if ( head && ears ) {

			geometries.push( ears );
			keyed.push( body ? derivedShapeKeys( painted, paintedKeys, ears, ( keyedHead ) => pointedEars( head, keyedHead ) ) : null );

		}

	}
	// drop the rig file's own meshes; keep its armature
	model.traverse( ( o ) => { if ( ( o as THREE.SkinnedMesh ).isSkinnedMesh && ! bound ) bound = o as THREE.SkinnedMesh; } );
	const template = bound! as THREE.SkinnedMesh;
	const parent = template.parent!;
	const old: THREE.Object3D[] = [];
	model.traverse( ( o ) => { if ( ( o as THREE.Mesh ).isMesh ) old.push( o ); } );
	for ( const o of old ) o.removeFromParent();
	const merged = mergeGeometries( geometries )!;
	const mesh = new THREE.SkinnedMesh( merged, lit ? makeLitFigureMaterial() : makeVertexColourCharacterMaterial( shared ) );
	mesh.name = 'villager';
	const meshes: THREE.SkinnedMesh<THREE.BufferGeometry, THREE.Material>[] = [ mesh ];
	for ( const s of surfaces ) {

		const part = new THREE.SkinnedMesh( s.geometry, s.material );
		part.name = `villager ${ s.material.name }`;
		if ( s.casts ) part.layers.enable( CharacterShadow.LAYER );
		meshes.push( part );

	}
	for ( const m of meshes ) {

		parent.add( m );
		m.bind( template.skeleton, template.bindMatrix );
		m.castShadow = false;
		m.receiveShadow = true;
		m.frustumCulled = false;

	}
	mesh.layers.enable( CharacterShadow.LAYER );
	const group = new THREE.Group();
	group.add( model );
	let age: FigureAge | null = null;
	if ( body ) {

		const ageing: { mesh: THREE.SkinnedMesh; keys: ShapeKeys }[] = [ { mesh, keys: mergeShapeKeys( geometries.map( ( geometry, i ) => ( { geometry, keys: keyed[ i ] } ) ), merged ) } ];
		surfaces.forEach( ( s, i ) => ageing.push( { mesh: meshes[ i + 1 ], keys: s.keys } ) );
		rig.animations = rig.animations.filter( ( c ) => CLIPS.includes( c.name ) );
		age = new FigureAge( { model, meshes: ageing, clips: rig.animations, build: proportions }, body.sex );
		age.set( body.age );

	} else {

		reproportion( meshes, rig.animations, proportions );
		model.updateMatrixWorld( true );
		const box = new THREE.Box3().setFromObject( mesh, true );
		model.scale.setScalar( FIGURE_HEIGHT / ( box.max.y - box.min.y ) );
		model.position.y = - box.min.y * model.scale.y;

	}
	const mixer = new THREE.AnimationMixer( model );
	const actions: Record<string, THREE.AnimationAction> = {};
	for ( const clip of rig.animations ) actions[ clip.name ] = mixer.clipAction( clip );
	const stride = age ? 0 : runSteps( strideSteps( model, actions.Walk.getClip() ) );
	const figure: Villager = { group, mixer, actions, get strideSpeed() {

		return age ? age.strideSpeed : stride;

	}, get height() {

		return age ? age.height : FIGURE_HEIGHT;

	}, age };
	return figure;

}

const _track = new THREE.Vector3();

export class Villagers implements TrampleWalker {

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
	// the scene time of the last update
	private time = 0;

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
	 * the next update (a scene jump, packages/render/assemble/SceneJump.ts `establishScene`: a paused clock never finishes a
	 * cross-fade the scene before began). */
	reset(): void {

		const w = this.walker;
		w.mixer.stopAllAction();
		w.mixer.setTime( 0 );
		w.actions.Idle_Neutral.reset().play();
		this.walking = false;
		this.heading = NaN;

	}

	/** The scene time of the last update, the clock its track's ages count by (Trample.ts). */
	clock(): number {

		return this.time;

	}

	/** Where the walker's feet were `age` scene seconds before the last update (x, z), by its
	 * schedule on the loop it walks now (Trample.ts). */
	track( age: number, out: THREE.Vector2 ): void {

		const { s } = this.schedule( this.time - age );
		const p = this.path.getPointAt( ( ( s / this.length ) % 1 + 1 ) % 1, _track );
		out.set( p.x, p.z );

	}

	/** Distance along the loop at time t: walk 9 s, stand 4 s. */
	private schedule( t: number ): { s: number; walking: boolean } {

		const walk = 9, pause = 4, period = walk + pause;
		const k = Math.floor( t / period ), r = t - k * period;
		return { s: this.speed * ( k * walk + Math.min( r, walk ) ), walking: r < walk };

	}

	update( renderer: THREE.WebGPURenderer, scene: THREE.Scene, sun: THREE.DirectionalLight, time: number, dt: number ): void {

		const w = this.walker;
		this.time = time;
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
		// a body prepared for an age that has moved on (FigureAge.ts)
		if ( w.age?.ready ) w.age.swap();
		w.actions.Walk.timeScale = this.speed / w.strideSpeed;
		animate( w, Math.max( dt, 0 ) );
		this.centre.copy( w.group.position ).y += w.height / 2;
		this.shadow.update( renderer, scene, sun, this.centre );

	}

}
