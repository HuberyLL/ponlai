import * as THREE from 'three/webgpu';
import { PART, fishGeometry, wingRoot, type Anatomy, type Wing } from '../../life/FishGeometry.ts';
import { FOLD, type Skin } from '../../life/FishMaterial.ts';
import { SKIN, WENYAO } from '../../life/Wenyao.ts';
import { THING_KINDS } from '../sim/things.ts';
import type { Sim } from '../sim/Sim.ts';
import { propMaterial } from './Props.ts';

// The things lying on the ground (sim/things.ts): one InstancedMesh per item kind, each thing an
// instance at its pose between the last two ticks (`prev` to `pos` by Sim.alpha: the position
// lerped, the rotation slerped), as the islanders are drawn between ticks.
//
// The fish is the island's own (life/Wenyao.ts) at the length of its body in the simulation
// (THING_KINDS: 0.30 m), its wings folded along the flank as the swimming material folds them
// (FishMaterial.ts FOLD), done here on the CPU since this mesh does not swim; its skin's colours
// (the dark back, the pale flank and belly, the white head and red snout, the fins) baked into its
// vertices, without the markings and the eye the swimming material paints per pixel, which a fish
// seen from the island's view does not show. It lies on land: not a swimmer, under the props'
// plain material in the island's light (Props.ts propMaterial: GroundBounce), a little glossy as
// a wet fish is. Drawn at its true proportions, it is a little slimmer than its body in the
// simulation (a rounded box), so it lies a few millimetres above the ground on its flank.
//
// Rules: each kind's mesh holds CAPACITY instances, its `count` set each frame, so a new thing
// never builds a pipeline (more than CAPACITY of a kind are not drawn); its geometry and material
// are made once for the page, shared with the sample the game compiles at start (`thingSamples`,
// GameView "First draws"), and never disposed. The instance matrices upload only on a frame where
// something moved, came or went; such a frame also redraws the sun's shadow map (the things cast
// and receive). A thing seen for the first time grows the sun's casters and the sea's reflection
// box by its box (GameViewOptions.holdOpaque). Under the temporal modes the velocity comes from
// three's InstanceNode, which keeps each instance's previous matrix: nothing of its own here.

/** instances per kind */
const CAPACITY = 64;

/** The sRGB hex as linear RGB. */
const linear = ( hex: number ) => new THREE.Color( hex );

/** The fish's mesh at `length` (m), its wings folded, its skin in vertex colours. */
function fishThingGeometry( S: Anatomy, skin: Skin, length: number ): THREE.BufferGeometry {

	const g = fishGeometry( S, 1 );
	const pos = g.getAttribute( 'position' ) as THREE.BufferAttribute;
	const nor = g.getAttribute( 'normal' ) as THREE.BufferAttribute;
	const data = g.getAttribute( 'aData' ) as THREE.BufferAttribute;
	const wings: [ number, Wing, number ][] = [ [ PART.PECTORAL, S.pectoral, wingRoot( S, S.pectoral ) ], [ PART.PELVIC, S.pelvic, wingRoot( S, S.pelvic ) ] ];
	const colours = new Float32Array( pos.count * 3 );
	const c = { back: linear( skin.back ), flank: linear( skin.flank ), belly: linear( skin.belly ), head: linear( skin.head ), snout: linear( skin.snout ), fin: linear( skin.fin ), finEdge: linear( skin.finEdge ) };
	const col = new THREE.Color(), tmp = new THREE.Color();
	for ( let k = 0; k < pos.count; k ++ ) {

		const part = Math.floor( data.getY( k ) + 0.01 );
		let x = pos.getX( k ), z = pos.getZ( k ), nx = nor.getX( k ), nz = nor.getZ( k );
		// folded as FishMaterial folds a swimming fish's wings: each ray turned back about the root
		for ( const [ id, F, rootX ] of wings ) {

			if ( part !== id ) continue;
			const t = data.getW( k ) / Math.max( F.rays - 1, 1 );
			const side = Math.sign( x );
			const a = ( F.lead + ( F.last - F.lead ) * t ) * ( 1 - FOLD ) * side;
			const px = side * rootX, pz = 0.5 - F.u * S.body;
			const cos = Math.cos( a ), sin = Math.sin( a );
			const dx = x - px, dz = z - pz;
			x = dx * cos + dz * sin + px;
			z = dz * cos - dx * sin + pz;
			[ nx, nz ] = [ nx * cos + nz * sin, nz * cos - nx * sin ];

		}
		pos.setXYZ( k, x * length, pos.getY( k ) * length, z * length );
		nor.setXYZ( k, nx, nor.getY( k ), nz );

		// the skin, as FishMaterial paints it in the large
		const u = data.getX( k ), h = data.getW( k );
		const smooth = ( a: number, b: number, v: number ) => THREE.MathUtils.smoothstep( v, a, b );
		if ( part === PART.BODY ) {

			col.copy( c.belly ).lerp( c.flank, smooth( - 0.7, - 0.05, h ) );
			col.lerp( c.back, smooth( - 0.1, 0.3, h ) );
			col.lerp( c.head, 1 - smooth( skin.headEnd - 0.025, skin.headEnd + 0.01, u ) );
			col.lerp( c.snout, 1 - smooth( skin.snoutEnd * 0.6, skin.snoutEnd, u ) );

		} else col.copy( c.fin ).lerp( tmp.copy( c.finEdge ), smooth( 0.45, 1, data.getZ( k ) ) );
		col.toArray( colours, k * 3 );

	}
	g.deleteAttribute( 'aData' );
	g.setAttribute( 'color', new THREE.BufferAttribute( colours, 3 ) );
	g.computeBoundingSphere();
	return g;

}

/** Each item kind's mesh, made once for the page (see Rules above). */
interface KindDraw { geometry: THREE.BufferGeometry; material: THREE.Material }
let kinds: Map<string, KindDraw> | null = null;

function kindDraws(): Map<string, KindDraw> {

	if ( kinds ) return kinds;
	const material = propMaterial( 'thing' );
	material.roughness = 0.45;
	kinds = new Map( [ [ 'fish', { geometry: fishThingGeometry( WENYAO, SKIN, THING_KINDS.fish.size.z ), material } ] ] );
	return kinds;

}

function kindMesh( kind: string ): THREE.InstancedMesh {

	const draw = kindDraws().get( kind )!;
	const mesh = new THREE.InstancedMesh( draw.geometry, draw.material, CAPACITY );
	mesh.name = `things ${ kind }`;
	mesh.count = 0;
	// the instances move: a bounding sphere of the first ones would cull the later
	mesh.frustumCulled = false;
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	return mesh;

}

/** One of each kind's mesh, one instance drawn, for the game to compile at start (GameView "First draws"). */
export function thingSamples(): THREE.Object3D[] {

	return [ ...kindDraws().keys() ].map( ( kind ) => {

		const mesh = kindMesh( kind );
		mesh.count = 1;
		return mesh;

	} );

}

const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _q = new THREE.Quaternion(), _r = new THREE.Quaternion(), _one = new THREE.Vector3( 1, 1, 1 );
const _m = new THREE.Matrix4(), _box = new THREE.Box3();

export class ThingsView {

	private readonly meshes = new Map<string, THREE.InstancedMesh>();
	/** what each mesh's instances showed last frame, by slot: the thing's id */
	private readonly shown = new Map<string, string[]>();
	/** the things whose box was handed to holdOpaque */
	private readonly held = new Set<string>();
	private moving = false;
	/** this frame's instances per kind */
	private readonly counts = new Map<string, number>();

	constructor( group: THREE.Group, private readonly holdOpaque: ( box: THREE.Box3 ) => void ) {

		for ( const kind of kindDraws().keys() ) {

			const mesh = kindMesh( kind );
			this.meshes.set( kind, mesh );
			this.shown.set( kind, [] );
			group.add( mesh );

		}

	}

	/** Draw the things as the state holds them; true when what casts a shadow changed. */
	update( sim: Sim ): boolean {

		const things = sim.state.things, alpha = sim.alpha;
		let moving = false, changed = false;
		const counts = this.counts;
		counts.clear();
		for ( const t of things ) {

			const mesh = this.meshes.get( t.item );
			if ( ! mesh ) continue;
			const slot = counts.get( t.item ) ?? 0;
			if ( slot >= CAPACITY ) continue;
			counts.set( t.item, slot + 1 );
			const { pos, rot, prev } = t;
			const still = prev.pos.x === pos.x && prev.pos.y === pos.y && prev.pos.z === pos.z && prev.rot.every( ( q, k ) => q === rot[ k ] );
			if ( ! still ) moving = true;
			const shown = this.shown.get( t.item )!;
			// a still thing in the slot it held last frame, after a still frame: drawn as it was
			if ( still && ! this.moving && shown[ slot ] === t.id ) continue;
			shown[ slot ] = t.id;
			_p.set( prev.pos.x, prev.pos.y, prev.pos.z ).lerp( _t.set( pos.x, pos.y, pos.z ), alpha );
			_q.set( prev.rot[ 0 ], prev.rot[ 1 ], prev.rot[ 2 ], prev.rot[ 3 ] ).slerp( _r.set( rot[ 0 ], rot[ 1 ], rot[ 2 ], rot[ 3 ] ), alpha );
			mesh.setMatrixAt( slot, _m.compose( _p, _q, _one ) );
			mesh.instanceMatrix.needsUpdate = true;
			changed = true;
			if ( ! this.held.has( t.id ) ) {

				this.held.add( t.id );
				const r = Math.max( ...Object.values( THING_KINDS[ t.item ].size ) ) / 2;
				this.holdOpaque( _box.setFromCenterAndSize( _p, _t.setScalar( 2 * r ) ) );

			}

		}
		for ( const [ kind, mesh ] of this.meshes ) {

			const n = counts.get( kind ) ?? 0;
			const shown = this.shown.get( kind )!;
			if ( mesh.count !== n ) {

				mesh.count = n;
				shown.length = n;
				changed = true;

			}

		}
		if ( this.held.size > things.length ) for ( const id of this.held ) if ( ! things.some( ( t ) => t.id === id ) ) this.held.delete( id );
		this.moving = moving;
		return changed;

	}

	dispose(): void {

		for ( const mesh of this.meshes.values() ) {

			mesh.removeFromParent();
			// its instance buffers only: the geometry and material are the page's (see Rules)
			mesh.dispose();

		}
		this.meshes.clear();

	}

}
