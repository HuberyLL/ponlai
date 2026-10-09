import * as THREE from 'three/webgpu';
import { materialColor, vec4 } from 'three/tsl';
import { debugFlags } from '../debug/DebugFlags.ts';
import { legacyWind, windVariants } from './WindVariants.ts';

// A depth prepass for the alpha-to-coverage vegetation (grass, bushes, plants, rim leaves).
//
// Profiling at 4x MSAA showed that nearly all of the vegetation's cost is its fragment shading:
// the same draws with a flat shader were 4.4 ms (render scale 1) to 5.9 ms (1.5) cheaper over the
// island, almost as much as hiding them. Coverage written from the shader keeps the GPU from
// rejecting hidden fragments before they are shaded, so every blade and leaf behind the front one
// is shaded too, and a coverage pipeline shades more finely than a plain one besides.
//
// So every coverage mesh is drawn twice:
// - a depth-only copy first (`-depth`, drawn two steps earlier): the same vertex stage, alpha and
//   coverage, with a shader that computes nothing else and writes no colour;
// - then the shaded mesh, testing depth for equality without writing it, and without coverage or
//   an alpha test of its own: equal depth already limits it to the samples the copy covered, the
//   copy's coverage. It is an ordinary opaque draw, so hidden fragments are rejected before they
//   are shaded.
// The samples each blade and leaf covers stay exactly as before; only the shading of the visible
// ones changes a little (same brightness, slightly crisper detail inside the canopy), since a
// coverage pipeline shaded them more finely.
//
// debugFlags (A/B in one page with tools/profile-frame.mjs --toggle):
// - vegPrepass = false: the old single coverage pass.
// - vegPrepassOpaque = false: the shaded draw keeps its coverage and alpha test after the
//   prepass. The image is then the old one, but it saves far less.
// URL options, read at load: vegPrepass=0, vegPrepass=coverage (vegPrepassOpaque = false).

// Equal depth needs the prepass and the shaded draw to place every vertex bit for bit alike. The
// two programs differ (the shaded one computes much more), and the shader compiler then reorders
// or contracts the position's arithmetic differently: a few samples fail the test and show the
// clear colour behind. WGSL's `@invariant` on the clip position forbids that. three does not emit
// it, so both materials patch the declarations of the builder that compiles them.
function invariantPosition( material: THREE.NodeMaterial ): void {

	const setup = material.setup;
	material.setup = function ( this: THREE.NodeMaterial, builder: THREE.NodeBuilder ) {

		const b = builder as unknown as { getBuiltins?: ( stage: string ) => string };
		const builtins = b.getBuiltins;
		if ( builtins && ! Object.prototype.hasOwnProperty.call( b, 'getBuiltins' ) ) {

			b.getBuiltins = function ( stage: string ) {

				return builtins.call( this, stage ).replace( '@builtin( position )', '@invariant @builtin( position )' );

			};

		}
		return setup.call( this, builder );

	};

}

// The depth-only copy of a coverage material: its vertex stage, alpha (the leaf map's and the
// alpha map's, or the blades' coverage) and alpha test, nothing else.
function depthMaterial( source: THREE.MeshStandardNodeMaterial ): THREE.MeshBasicNodeMaterial {

	const m = new THREE.MeshBasicNodeMaterial( { side: source.side, alphaToCoverage: true } );
	m.positionNode = source.positionNode;
	m.opacityNode = source.opacityNode;
	m.alphaTestNode = source.alphaTestNode;
	m.alphaTest = source.alphaTest;
	m.alphaMap = source.alphaMap;
	if ( source.map ) {

		m.map = source.map;
		m.colorNode = vec4( 1, 1, 1, ( materialColor as unknown as THREE.Node<'vec4'> ).w );

	} else m.colorNode = vec4( 1 );
	m.colorWrite = false;
	m.name = ( source.name || 'vegetation' ) + '-depth';
	invariantPosition( m );
	return m;

}

// `materials` holds the shaded mesh's material and, while the wind keeps its old sway for A/Bs
// (WindVariants.ts), the old one; `depths` their depth copies, in the same order.
type Pair = { mesh: THREE.Mesh; materials: THREE.MeshStandardNodeMaterial[]; depth: THREE.Mesh; depths: THREE.Material[] };

/** Give every alpha-to-coverage mesh under `roots` its depth prepass. Without multisampling there
 * is no coverage material, and nothing changes. */
export function installVegetationPrepass( scene: THREE.Scene, roots: THREE.Object3D[] ): void {

	const params = new URLSearchParams( location.search );
	const option = params.get( 'vegPrepass' );
	if ( option === '0' ) debugFlags.vegPrepass = false;
	if ( option === 'coverage' ) debugFlags.vegPrepassOpaque = false;

	const meshes: THREE.Mesh[] = [];
	for ( const root of roots ) root.traverse( ( object ) => {

		const mesh = object as THREE.Mesh;
		if ( mesh.isMesh && ! Array.isArray( mesh.material ) && ( mesh.material as THREE.Material ).alphaToCoverage === true ) meshes.push( mesh );

	} );

	const pairs: Pair[] = [];
	const patched = new Set<THREE.Material>();
	for ( const mesh of meshes ) {

		const variants = windVariants( mesh );
		const materials = ( variants ? [ variants.shipped, variants.legacy ] : [ mesh.material ] ) as THREE.MeshStandardNodeMaterial[];
		const depths = materials.map( depthMaterial );
		let depth: THREE.Mesh;
		if ( ( mesh as THREE.InstancedMesh ).isInstancedMesh ) {

			const source = mesh as THREE.InstancedMesh;
			const copy = new THREE.InstancedMesh( source.geometry, depths[ 0 ], source.instanceMatrix.count );
			copy.instanceMatrix = source.instanceMatrix;
			copy.count = source.count;
			depth = copy;

		} else depth = new THREE.Mesh( mesh.geometry, depths[ 0 ] );
		depth.name = mesh.name + '-depth';
		depth.frustumCulled = mesh.frustumCulled;
		depth.castShadow = false;
		depth.receiveShadow = false;
		depth.renderOrder = mesh.renderOrder - 2;
		depth.visible = false;
		// The grass picks its instances and blade count as it is drawn (Grass.ts); the copy draws
		// first, so it makes the same choice for the same camera. It reads the culled list only
		// when the mesh does (`grassCulled`): otherwise it would draw the first tufts in slot order
		// and the shaded draw's equal test would fail over most of the meadow.
		const before = mesh.onBeforeRender;
		depth.onBeforeRender = ( renderer, s, camera, geometry, mat, group ) => {

			before.call( mesh, renderer, s, camera, geometry, mat, group );
			if ( ( depth as THREE.InstancedMesh ).isInstancedMesh ) ( depth as THREE.InstancedMesh ).count = ( mesh as THREE.InstancedMesh ).count;
			depth.userData.bladeGain = mesh.userData.bladeGain;
			depth.userData.grassCulled = mesh.userData.grassCulled;

		};
		// a child: it follows the mesh's transform and visibility
		mesh.add( depth );
		for ( const material of materials ) {

			if ( patched.has( material ) ) continue;

			patched.add( material );
			invariantPosition( material );
			// The opaque shaded draw leaves the alpha test out of its shader only: the shadow
			// passes copy `alphaTest` from the material as they draw, and keep the leaf shapes.
			const setup = material.setupDiffuseColor;
			( material as unknown as { setupDiffuseColor: ( b: THREE.NodeBuilder ) => void } ).setupDiffuseColor = function ( this: THREE.MeshStandardNodeMaterial, builder: THREE.NodeBuilder ) {

				const test = this.alphaTest;
				if ( this.userData.prepassOpaque ) this.alphaTest = 0;
				setup.call( this, builder );
				this.alphaTest = test;

			};

		}
		pairs.push( { mesh, materials, depth, depths } );

	}

	// Applied before each render of the scene, so the debug flags switch it at run time.
	let state = '';
	const apply = () => {

		const on = debugFlags.vegPrepass !== false;
		const opaque = on && debugFlags.vegPrepassOpaque !== false;
		const legacy = legacyWind();
		const key = `${ on } ${ opaque } ${ legacy }`;
		if ( key === state ) return;
		state = key;
		for ( const p of pairs ) {

			p.depth.visible = on;
			p.depth.material = p.depths[ legacy ? p.depths.length - 1 : 0 ];
			for ( const m of p.materials ) {

				if ( m.depthWrite === ! on && m.userData.prepassOpaque === opaque && m.userData.prepassOn === on ) continue;
				m.depthWrite = ! on;
				m.depthFunc = on ? THREE.EqualDepth : THREE.LessEqualDepth;
				m.alphaToCoverage = ! opaque;
				m.userData.prepassOpaque = opaque;
				m.userData.prepassOn = on;
				m.needsUpdate = true;

			}

		}

	};
	const previous = scene.onBeforeRender;
	scene.onBeforeRender = ( ...args ) => {

		apply();
		previous.apply( scene, args );

	};

}
