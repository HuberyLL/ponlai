/*!
 * The top-down collision height pass follows "collision rain" in threejs-conference by
 * Anderson Mancini and Sunag (https://github.com/ektogamat/threejs-conference,
 * src/world/weather/createCollisionHeight.js).
 * Copyright (c) 2026 Anderson Mancini and Sunag
 * Licensed under the MIT License; see ./threejs-conference.LICENSE.txt.
 *
 * The same pass is in the three.js example webgpu_compute_particles_rain.html.
 * Copyright (c) 2010-2026 three.js authors
 * Licensed under the MIT License (the three package's licence, shipped with the build).
 */

import * as THREE from 'three/webgpu';
import { Fn, ivec2, max, positionWorld, select, textureLoad, uniform, vec4 } from 'three/tsl';
import { ISLAND_TOP, layoutBounds } from '../world/WorldShapes.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;

// Texels per metre: a drop finds the meadow, a bush's crown or a hanging branch to within
// a few centimetres, finer than a splash.
const TEXELS_PER_METRE = 14;
// Rim foliage hangs and the cliff toe flares beyond the tile footprint.
const PAD = 6;

/** The highest surface under every point of the island, seen from straight above: an
 * orthographic camera draws world height into a small half-float target. Beyond it, and
 * wherever nothing was drawn, the sea is the ground. The island never moves, so the map is
 * drawn once (with the plants at rest), not every frame. */
export class RainCollision {

	readonly target: THREE.RenderTarget;
	readonly camera: THREE.OrthographicCamera;
	// x0, z0 of the map and 1 / its width and depth (m).
	private readonly xform = uniform( new THREE.Vector4() );
	private readonly size = uniform( new THREE.Vector2() );
	readonly waterLevel = uniform( 0 );
	// Highest height in the map: above it a drop cannot have hit anything yet.
	readonly ceiling: number;
	/** Height of the first surface a drop meets falling onto world (x, z): the island's top
	 * wherever it was drawn, else the sea. */
	readonly groundAt: ( xz: V2 ) => F;

	constructor() {

		const bounds = layoutBounds();
		const x0 = bounds.x0 - PAD, z0 = bounds.z0 - PAD;
		const width = bounds.x1 - bounds.x0 + PAD * 2, depth = bounds.z1 - bounds.z0 + PAD * 2;
		const w = Math.ceil( width * TEXELS_PER_METRE ), h = Math.ceil( depth * TEXELS_PER_METRE );
		this.target = new THREE.RenderTarget( w, h, { type: THREE.HalfFloatType, depthBuffer: true } );
		this.target.texture.name = 'rainCollisionHeight';
		// Nearest texels: a filtered lookup would blend the cliff top with the sea below it.
		this.target.texture.minFilter = this.target.texture.magFilter = THREE.NearestFilter;
		this.target.texture.generateMipmaps = false;
		this.xform.value.set( x0, z0, 1 / width, 1 / depth );
		this.size.value.set( w, h );
		// Looking straight down with -z up the image: x runs right, z down the rows from z0.
		this.camera = new THREE.OrthographicCamera( - width / 2, width / 2, depth / 2, - depth / 2, 0, 80 );
		this.camera.up.set( 0, 0, - 1 );
		this.camera.position.set( x0 + width / 2, 40, z0 + depth / 2 );
		this.camera.lookAt( x0 + width / 2, 0, z0 + depth / 2 );
		this.camera.updateMatrixWorld();
		// Bushes reach about a metre and a half above the meadow and the figures two; the ceiling
		// keeps a margin over them, so no drop falls through their tops.
		this.ceiling = ISLAND_TOP + 4;
		const texture = this.target.texture, xform = this.xform, size = this.size, waterLevel = this.waterLevel;
		this.groundAt = Fn( ( [ xz ]: [ V2 ] ) => {

			const uv = xz.sub( xform.xy ).mul( xform.zw ).toVar();
			const inside = uv.x.greaterThanEqual( 0 ).and( uv.x.lessThan( 1 ) ).and( uv.y.greaterThanEqual( 0 ) ).and( uv.y.lessThan( 1 ) );
			const sample = textureLoad( texture, ivec2( uv.clamp( 0, 0.9999 ).mul( size ) ) ).toVar();
			return max( select( inside.and( sample.a.greaterThan( 0.5 ) ), sample.r, waterLevel ), waterLevel );

		} ).setLayout( { name: 'ponlaiRainGround', type: 'float', inputs: [ { name: 'xz', type: 'vec2' } ] } ) as unknown as ( xz: V2 ) => F;

	}

	/** Draw the height of every mesh under `roots` (skinned figures excepted: they move). Each
	 * material's rest-pose position and alpha test are kept, so blades and leaf cards print
	 * their own shapes rather than their bounding quads. */
	bake( renderer: THREE.WebGPURenderer, roots: THREE.Object3D[] ): void {

		const scene = new THREE.Scene();
		const materials = new Map<THREE.Material, THREE.MeshBasicNodeMaterial>();
		const heightOf = ( source: THREE.Material ) => {

			let material = materials.get( source );
			if ( material ) return material;
			const node = source as THREE.MeshStandardNodeMaterial;
			material = new THREE.MeshBasicNodeMaterial( { side: THREE.DoubleSide } );
			material.positionNode = node.castShadowPositionNode ?? node.positionNode ?? null;
			if ( node.alphaMap ) {

				material.alphaMap = node.alphaMap;
				material.alphaTest = node.alphaTest;

			}
			material.outputNode = vec4( positionWorld.y, 0, 0, 1 );
			materials.set( source, material );
			return material;

		};
		for ( const root of roots ) root.traverse( ( object ) => {

			const mesh = object as THREE.Mesh;
			if ( ! mesh.isMesh || ( mesh as THREE.SkinnedMesh ).isSkinnedMesh || ! object.visible ) return;
			const source = Array.isArray( mesh.material ) ? mesh.material[ 0 ] : mesh.material;
			let proxy: THREE.Mesh;
			if ( ( mesh as THREE.InstancedMesh ).isInstancedMesh ) {

				const instanced = mesh as THREE.InstancedMesh;
				const copy = new THREE.InstancedMesh( mesh.geometry, heightOf( source ), instanced.count );
				copy.instanceMatrix = instanced.instanceMatrix;
				proxy = copy;

			} else proxy = new THREE.Mesh( mesh.geometry, heightOf( source ) );
			mesh.updateWorldMatrix( true, false );
			proxy.matrixAutoUpdate = false;
			proxy.matrix.copy( mesh.matrixWorld );
			proxy.frustumCulled = false;
			scene.add( proxy );

		} );
		scene.updateMatrixWorld( true );
		const target = renderer.getRenderTarget();
		const clear = renderer.getClearColor( new THREE.Color() ), alpha = renderer.getClearAlpha();
		renderer.setRenderTarget( this.target );
		renderer.setClearColor( 0x000000, 0 );
		renderer.clear();
		renderer.render( scene, this.camera );
		renderer.setRenderTarget( target );
		renderer.setClearColor( clear, alpha );
		for ( const material of materials.values() ) material.dispose();

	}

	dispose(): void {

		this.target.dispose();

	}

}
