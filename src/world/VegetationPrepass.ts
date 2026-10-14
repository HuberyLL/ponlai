import * as THREE from 'three/webgpu';
import { materialColor, vec4 } from 'three/tsl';
import { debugFlags } from '../debug/DebugFlags.ts';
import { TEMPORAL } from '../post/Antialiasing.ts';
import { VELOCITY_CLEAR, velocityOutput } from '../post/Motion.ts';

// A depth prepass for the alpha-to-coverage vegetation (grass, bushes, rim leaves).
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
// Under the temporal modes (Antialiasing.ts: aa=taa|taau) the scene has one sample and no
// coverage: the vegetation is alpha-tested instead (leaves by a coverage band about their cutoff,
// grass blades by their coverage, both against the per-frame dither: `coverageAlphaTest` and
// `coverageDither` in Foliage.ts), and the same pair is drawn. The depth copy then discards what
// the alpha test discards, and the shaded draw again keeps neither coverage nor an alpha test:
// equal depth limits it to the pixels the copy kept, and an opaque draw rejects the hidden blades
// and leaves before they are shaded (an alpha-tested one cannot: its discard is decided by the
// shader). Without multisampling and outside the temporal modes (aa=off) nothing changes.
//
// debugFlags (A/B in one page with tools/profile-frame.mjs --toggle):
// - vegPrepass = false: the old single coverage pass.
// - vegPrepassOpaque = false: the shaded draw keeps its coverage and alpha test after the
//   prepass (under the temporal modes its alpha test alone). The image is then the old one, but
//   it saves far less.
// URL options, read at load: vegPrepass=0, vegPrepass=coverage (vegPrepassOpaque = false).
//
// Rules for anything that touches it:
// - At 4x the vegetation's coverage is decided by the prepass alone: the shaded draw is plain
//   opaque geometry limited by equal depth to the prepass's samples.
// - A depth copy follows its mesh's per-draw choices (blade count, `grassLod`, the culled list and
//   its bands, which are the shared geometry's indirect offsets), so the equal test holds for
//   every batch; a per-object uniform (`onObjectUpdate`) reads the drawn object's own userData, so
//   each copy carries the fields its shader reads.
// - Keep `material.alphaTest` itself at its value (the shadow passes copy it) and leave it out of
//   the shaded draw's shader build only.
// - A new alpha-to-coverage vegetation group joins `installVegetationPrepass`'s list; anything
//   that finds vegetation after the first frame reads `userData.vegetation` (this turns
//   `alphaToCoverage` off).

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
// alpha map's, or the blades' coverage) and alpha test, nothing else. Under the temporal modes it
// takes the alpha test without coverage (one sample: three would draw a coverage material's alpha
// above zero solid; the test is the material's `alphaTestNode`, the leaves' coverage band or the
// blades' dither, Foliage.ts), and a constant velocity of its own: `colorWrite = false` masks every
// attachment, so the prepass writes no motion, and the copy need not compute the motion the
// scene's MRT would ask of it (nor carry the varying).
function depthMaterial( source: THREE.MeshStandardNodeMaterial ): THREE.MeshBasicNodeMaterial {

	const m = new THREE.MeshBasicNodeMaterial( { side: source.side, alphaToCoverage: ! TEMPORAL } );
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
	if ( TEMPORAL ) m.mrtNode = velocityOutput( vec4( ...VELOCITY_CLEAR ) );
	m.name = ( source.name || 'vegetation' ) + '-depth';
	invariantPosition( m );
	return m;

}

// the shaded mesh, its material and its depth copy
type Pair = { mesh: THREE.Mesh; material: THREE.MeshStandardNodeMaterial; depth: THREE.Mesh };

/** What `installVegetationPrepass` installed (kept on `scene.userData.vegetationPrepass` for the
 * diagnostics): its pairs of a depth copy and a shaded mesh, and the shaded materials patched. */
export interface VegetationPrepassInfo { pairs: number; materials: number }

/** Give every alpha-to-coverage mesh under `roots` its depth prepass, and under the temporal modes
 * every vegetation mesh (`markVegetation`: their coverage materials are alpha-tested there). With
 * one sample outside the temporal modes there is no coverage material, and nothing changes. */
export function installVegetationPrepass( scene: THREE.Scene, roots: THREE.Object3D[] ): VegetationPrepassInfo {

	const params = new URLSearchParams( location.search );
	const option = params.get( 'vegPrepass' );
	if ( option === '0' ) debugFlags.vegPrepass = false;
	if ( option === 'coverage' ) debugFlags.vegPrepassOpaque = false;

	const meshes: THREE.Mesh[] = [];
	for ( const root of roots ) root.traverse( ( object ) => {

		const mesh = object as THREE.Mesh;
		if ( ! mesh.isMesh || Array.isArray( mesh.material ) ) return;
		// (`alphaToCoverage` is off under the temporal modes: the vegetation's tag finds the same
		// meshes there, the grass, bushes, plants and rim leaves)
		const material = mesh.material as THREE.Material;
		if ( TEMPORAL ? material.userData.vegetation === true : material.alphaToCoverage === true ) meshes.push( mesh );

	} );

	const pairs: Pair[] = [];
	const patched = new Set<THREE.Material>();
	for ( const mesh of meshes ) {

		const material = mesh.material as THREE.MeshStandardNodeMaterial;
		const depthCopy = depthMaterial( material );
		let depth: THREE.Mesh;
		if ( ( mesh as THREE.InstancedMesh ).isInstancedMesh ) {

			const source = mesh as THREE.InstancedMesh;
			const copy = new THREE.InstancedMesh( source.geometry, depthCopy, source.instanceMatrix.count );
			copy.instanceMatrix = source.instanceMatrix;
			copy.count = source.count;
			depth = copy;

		} else depth = new THREE.Mesh( mesh.geometry, depthCopy );
		depth.name = mesh.name + '-depth';
		// (the rain's collision bake, RainCollision.ts, leaves the copies out: they print the same shape)
		depth.userData.prepassCopy = true;
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
			depth.userData.grassLod = mesh.userData.grassLod;
			depth.userData.grassCulled = mesh.userData.grassCulled;

		};
		// a child: it follows the mesh's transform and visibility
		mesh.add( depth );
		if ( ! patched.has( material ) ) {

			patched.add( material );
			invariantPosition( material );
			// The opaque shaded draw leaves the alpha test out of its shader only: the shadow
			// passes copy `alphaTest` from the material as they draw, and keep the leaf shapes. The
			// grass's dither (its `alphaTestNode`, single-sampled) goes the same way.
			const setup = material.setupDiffuseColor;
			( material as unknown as { setupDiffuseColor: ( b: THREE.NodeBuilder ) => void } ).setupDiffuseColor = function ( this: THREE.MeshStandardNodeMaterial, builder: THREE.NodeBuilder ) {

				const test = this.alphaTest, testNode = this.alphaTestNode;
				if ( this.userData.prepassOpaque ) {

					this.alphaTest = 0;
					this.alphaTestNode = null;

				}
				setup.call( this, builder );
				this.alphaTest = test;
				this.alphaTestNode = testNode;

			};
			// Under the temporal modes coverage stays off either way, and three's cache key leaves
			// out userData: the shader with the alpha test and the one without need keys of their own.
			if ( TEMPORAL ) {

				const key = material.customProgramCacheKey;
				material.customProgramCacheKey = function ( this: THREE.MeshStandardNodeMaterial ) {

					return key.call( this ) + ( this.userData.prepassOpaque ? '|prepassOpaque' : '' );

				};

			}

		}
		pairs.push( { mesh, material, depth } );

	}

	// Applied before each render of the scene, so the debug flags switch it at run time.
	let state = '';
	const apply = () => {

		const on = debugFlags.vegPrepass !== false;
		const opaque = on && debugFlags.vegPrepassOpaque !== false;
		const key = `${ on } ${ opaque }`;
		if ( key === state ) return;
		state = key;
		for ( const p of pairs ) {

			p.depth.visible = on;
			const m = p.material;
			if ( m.depthWrite === ! on && m.userData.prepassOpaque === opaque && m.userData.prepassOn === on ) continue;
			m.depthWrite = ! on;
			m.depthFunc = on ? THREE.EqualDepth : THREE.LessEqualDepth;
			m.alphaToCoverage = ! opaque && ! TEMPORAL;
			m.userData.prepassOpaque = opaque;
			m.userData.prepassOn = on;
			m.needsUpdate = true;

		}

	};
	const previous = scene.onBeforeRender;
	scene.onBeforeRender = ( ...args ) => {

		apply();
		previous.apply( scene, args );

	};
	const info: VegetationPrepassInfo = { pairs: pairs.length, materials: patched.size };
	scene.userData.vegetationPrepass = info;
	return info;

}
