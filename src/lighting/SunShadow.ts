import * as THREE from 'three/webgpu';
import { Fn, uniform, uniformArray, texture, vec4, int, float, clamp, floor, dot, select, mix, positionLocal, modelWorldMatrixInverse } from 'three/tsl';
import { compileDraws } from '../post/Warm.ts';
import { solarSteppedShadowVisibility, solarVolumeVisibility, SOLAR_SHADOW_TAPS, SHADOW_FILTER_PATH, type SolarShadowTaps } from './SolarShadow.ts';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type FilterInput = { shadowCoord: V3 };
type ShadowRenderer = { updateShadow( frame: { renderer: THREE.Renderer; scene: THREE.Scene; camera: THREE.Camera } ): void; shadowMap: THREE.RenderTarget | null };

// The key light's shadow map, redrawn in steps of the light's direction and cross-faded.
//
// Stems, leaf stalks and leaves seen edge-on are thinner than a shadow texel. Whether such a
// caster covers a texel centre flips as the projection turns, so a map redrawn every frame
// made their shadows boil while the clock ran, even though the light moves a shadow edge by
// less than a tenth of a pixel per frame. Instead the map is redrawn only after the key light
// has turned by STEP, the previous map is kept, and every receiver blends the two by how far
// the light has turned since the last redraw. A texel that changes between two redraws then
// fades over a step instead of popping, and the blended shadow still moves continuously: it
// trails the light by about one step, 3.5 mm per metre of throw, a third of the sun's own
// penumbra there. Each redraw re-rolls every sub-texel caster (the projection's turn moves a
// point 10 m from its centre by more than a texel), so a longer step also means fewer of those
// fades. The blend is a function of the key direction alone, so a paused clock holds it exactly.
//
// The map is fitted to the island's casters; the sea floor's stones cast only into the refracted
// map (RefractedSun.ts). Grass blades, stems, leaf stalks and twigs stay out of it (MeadowCanopy,
// VegetationShadow.ts). Both stepped maps always share one filter mode, each with its own blocker
// search, so the cross-fade stays continuous across a redraw; the mode is set per quality tier
// (`setFilter`) before the materials build. Receivers read the maps through SolarShadow's gather
// filter (see its rules on sampler types and derivatives). The caster-depth grid
// (`nearestCasterDepth`) lets a march through the water skip the 2x2 volume lookups where nothing
// casts, never the surface filter's PCSS search.
//
// Closed solids (the island's terrain, `castFrontFaces`) cast their front faces into this map,
// not the back faces three casts for a FrontSide material. At the cliff's creases, scar-notch
// corners and sharp arrises a wall turned away from the sun has, as its only back-face occluder,
// the crease's other side a few millimetres off, inside the bias: such pixels read lit and showed
// as bright specks in the shade. Back faces also read every point inside the rock as lit, and
// submerged receivers read this map at their refracted entry point on the surface (RefractedSun),
// which for the sea floor and walls along the cliff's foot lies inside the rock: thin lines and
// patches of sun showed there inside the island's shadow. The front faces put the occluder at the
// solid's sunlit skin, a body's thickness away. Lit ground then receives its own depth: the
// receiver-plane filter and the normal bias keep the turf itself clean, but grass blades and stems
// a few centimetres over it caught the turf in their filter's taps and darkened. So the solids'
// cast depth is pushed FRONT_PUSH away from the light (the map's own bias stays small, for the
// vegetation's contact shadows); rock thinner than that along the light leaks again, so it stays
// a few centimetres. Only this map changes: three's `shadowSide` is set for the draw and restored,
// and the refracted map draws its casters with a material of its own.
const STEP = THREE.MathUtils.degToRad( 0.2 );
// how far closed solids' cast depth is pushed away from the light (m), see above
const FRONT_PUSH = 0.03;
// A larger turn in one frame is a cut (a new hour, preset or manual sun): redraw without history.
const CUT = THREE.MathUtils.degToRad( 1 );
const PREVIOUS = 0, CURRENT = 1;
// the side three draws a caster's faces into a (non-VSM) map with: Renderer's _shadowSide (r186)
const SHADOW_SIDE = { [ THREE.FrontSide ]: THREE.BackSide, [ THREE.BackSide ]: THREE.FrontSide, [ THREE.DoubleSide ]: THREE.DoubleSide };
// A lighter filter for vegetation (grass blades and leaves, `markVegetation`), for the quality
// tiers below high (setFilter): it fills much of the frame with small, overlapping receivers whose
// own dapple hides a coarser penumbra. Not the default: fewer blocker taps re-roll the dapple's
// penumbrae, which a close view of shaded foliage shows as scattered pixels changing by up to half
// their brightness.
export const VEGETATION_TAPS: Readonly<SolarShadowTaps> = { soft: true, blockerSamples: 4, filterSamples: 4 };
// The caster-depth grid (nearestCasterDepth): light-space cells per side of each map, world cells
// along the casters' longer side, and the padding for what the rest pose leaves out (wind sway,
// the rim's lean): metres up, and world cells sideways.
const GRID = 16, WORLD_CELLS = 64, GRID_HEIGHT_PAD = 0.35, GRID_SIDE_PAD = 1;
// a cell without casters: farther than any receiver's depth
const NO_CASTER = 2;
// a cell not projected yet: nearer than any receiver, so nothing is skipped on its word
const UNKNOWN = 0;

// three's shadow coordinate is ( s.x, 1 - s.y, s.z + bias ) for s = shadow.matrix * world
const FLIP_Y = new THREE.Matrix4().set(
	1, 0, 0, 0,
	0, - 1, 0, 1,
	0, 0, 1, 0,
	0, 0, 0, 1,
);

function shadowCoordinateMatrix( shadow: THREE.LightShadow, target: THREE.Matrix4 ): THREE.Matrix4 {

	return target.makeTranslation( 0, 0, shadow.bias ).multiply( FLIP_Y ).multiply( shadow.matrix );

}

export interface SunShadowOptions {
	// Bias along the light ray, in metres; converted to each fitted map's depth range.
	bias?: number;
	// Lowest surface that reads this map: the sea's wave troughs. Submerged receivers read it at
	// their refracted entry point on the surface (see RefractedSun), never below it.
	floor?: number;
	// light-space margin around the casters (m): the filter's footprint and the normal bias
	margin?: number;
}

export class SunShadow {

	// share of the current map; 1 while there is no previous one
	readonly weight = uniform( 1 );
	// the current map's shadow coordinate -> the previous map's
	readonly toPrevious = uniform( new THREE.Matrix4() );
	readonly mapSize = uniform( new THREE.Vector2( 1, 1 ) );
	readonly span = uniform( new THREE.Vector2( 1, 1 ) );
	readonly range = uniform( 1 );
	readonly previousSpan = uniform( new THREE.Vector2( 1, 1 ) );
	readonly previousRange = uniform( 1 );
	// false until the first map has been drawn: receivers are lit rather than reading an empty layer
	readonly ready = uniform( 0 );
	private readonly sun: THREE.DirectionalLight;
	// Both maps share one array texture (previous, current), so a receiver binds one texture as
	// before: the water already binds as many as WebGPU guarantees. three's own map is only the
	// raster each step is drawn into. A render target owns the array, though nothing draws into
	// it: a depth texture without one is taken for a multisampled attachment of the main pass.
	private readonly maps: THREE.RenderTarget;
	private readonly depth: THREE.TextureNode;
	private readonly casters = new THREE.Box3();
	// materials of closed solids, cast by their front faces (see the header)
	private readonly frontCasters = new Set<THREE.Material>();
	// their cast depth, pushed FRONT_PUSH away from the light (world space, set at each draw)
	private readonly frontPush = uniform( new THREE.Vector3() );
	private readonly drawn = new THREE.Vector3();
	private readonly bias: number;
	private readonly floor: number;
	private readonly margin: number;
	// the light's turn between redraws (radians)
	step = STEP;
	// The filter for ordinary receivers and for vegetation (`userData.vegetation`). They compile into
	// each receiver's material, so set them (setFilter) before the first receiver is built.
	private taps: Readonly<SolarShadowTaps> = SOLAR_SHADOW_TAPS;
	private vegetationTaps: Readonly<SolarShadowTaps> = SHADOW_FILTER_PATH.vegetation ? VEGETATION_TAPS : SOLAR_SHADOW_TAPS;
	private hasPrevious = false;
	private cut = true;
	private readonly previousCoordinate = new THREE.Matrix4();
	private readonly currentCoordinate = new THREE.Matrix4();
	private readonly corner = new THREE.Vector3();
	private readonly target = new THREE.Vector3();
	private readonly lightBounds = new THREE.Box3();
	private readonly currentLayer = new THREE.Box3( new THREE.Vector3( 0, 0, CURRENT ), new THREE.Vector3( 1, 1, CURRENT + 1 ) );
	private readonly toCurrentLayer = new THREE.Vector3( 0, 0, CURRENT );
	private readonly toPreviousLayer = new THREE.Vector3( 0, 0, PREVIOUS );
	// Per map (previous, current), the nearest caster's depth in each GRID x GRID light-space cell,
	// four cells per vec4. Built only once a receiver asks for it (nearestCasterDepth); until then
	// every cell reads UNKNOWN, which never lets a march skip a lookup.
	private readonly casterDepths = uniformArray( Array.from( { length: 2 * GRID * GRID / 4 }, () => new THREE.Vector4().setScalar( UNKNOWN ) ), 'vec4' );
	private gridWanted = false;
	// A receiver asked for the grid since the last projection: project both halves on the next
	// update, whether or not the map is redrawn then (a paused clock may never redraw it).
	private gridDirty = false;
	// world-space caster columns: per WORLD_CELLS cell, the lowest and highest caster point
	private columns: { x0: number; z0: number; cell: number; nx: number; nz: number; low: Float32Array; high: Float32Array } | null = null;

	constructor( sun: THREE.DirectionalLight, { bias = 0.01, floor = - 3, margin = 0.6 }: SunShadowOptions = {} ) {

		this.sun = sun;
		this.bias = bias;
		this.floor = floor;
		this.margin = margin;
		// the format three gives the sun's own map (ShadowNode.setupRenderTarget, PCF filtering)
		const { width, height } = sun.shadow.mapSize;
		const depth = new THREE.DepthTexture( width, height, THREE.UnsignedIntType, undefined, undefined, undefined,
			THREE.LinearFilter, THREE.LinearFilter, undefined, THREE.DepthFormat, 2 );
		depth.compareFunction = THREE.LessEqualCompare;
		depth.name = 'sunShadowSteps';
		this.maps = new THREE.RenderTarget( width, height, { depth: 2, depthTexture: depth, depthBuffer: true } );
		this.depth = texture( depth );
		sun.shadow.autoUpdate = false;

	}

	/** Install the blended filter on the sun's shadow; receivers built afterwards use it. */
	install(): void {

		const filter = Fn( ( { shadowCoord }: FilterInput, builder: THREE.NodeBuilder ) => this.surfaceVisibility( shadowCoord,
			// Vegetation is told by its tag, not by alphaToCoverage, which is off without multisampling.
			( builder.material as THREE.Material | null )?.userData.vegetation === true ? this.vegetationTaps : this.taps ) );
		// The runtime exposes filterNode; @types/three has not declared this WebGPU hook yet.
		( this.sun.shadow as unknown as { filterNode: typeof filter } ).filterNode = filter;

	}

	/** The previous map's coordinate for a coordinate in the current map (both orthographic). */
	previousCoordinateNode( coordinate: V3 ): V3 {

		return this.toPrevious.mul( vec4( coordinate, 1 ) ).xyz;

	}

	/** The filter's taps for receivers built from now on (a quality tier's mode): ordinary
	 * receivers and the vegetation (`markVegetation`). `soft: false` keeps the bilinear comparison
	 * of both stepped maps alone. Materials already built keep the filter they compiled with. */
	setFilter( taps: Readonly<SolarShadowTaps>, vegetationTaps: Readonly<SolarShadowTaps> = taps ): void {

		this.taps = { ...taps };
		this.vegetationTaps = { ...vegetationTaps };

	}

	/** A surface's visibility from its coordinate in the current map (three's shadow coordinate).
	 * Both maps keep the same filter, so the cross-fade between them stays continuous. */
	surfaceVisibility( coordinate: V3, taps: Readonly<SolarShadowTaps> = this.taps ): F {

		return solarSteppedShadowVisibility( this.depth,
			{ coordinate: this.previousCoordinateNode( coordinate ), worldSpan: this.previousSpan, depthRange: this.previousRange, active: this.weight.lessThan( 1 ), layer: PREVIOUS },
			{ coordinate, worldSpan: this.span, depthRange: this.range, active: this.ready.greaterThan( 0 ), layer: CURRENT },
			this.weight, { mapSize: this.mapSize, taps } );

	}

	/** The same for a point in a volume (no receiver plane, no derivatives). */
	volumeVisibility( coordinate: V3 ): F {

		return mix(
			solarVolumeVisibility( this.depth, this.previousCoordinateNode( coordinate ), this.mapSize, this.weight.lessThan( 1 ), PREVIOUS ),
			solarVolumeVisibility( this.depth, coordinate, this.mapSize, this.ready.greaterThan( 0 ), CURRENT ),
			this.weight );

	}

	/** The nearest caster's depth (in that map's shadow coordinate z, bias included) over the
	 * light-space cell holding a coordinate of the current map, or of the previous one with
	 * `previous`; 2 where nothing casts, 0 before the grid's first projection. A point of that
	 * map no deeper than it is lit by the 2x2 bilinear lookups (volumeVisibility, the water
	 * column), whose footprint the cells already include, so a march may skip those lookups. It
	 * does not bound the surface filter's PCSS search, which can reach many texels further: never
	 * skip surfaceVisibility on its word. The grid comes from the casters' geometry at rest,
	 * padded for wind and the rim's lean, and is re-projected at each step. */
	nearestCasterDepth( coordinate: V3, previous = false ): F {

		if ( ! this.gridWanted ) this.gridWanted = this.gridDirty = true;
		const cell = clamp( floor( coordinate.xy.mul( GRID ) ), 0, GRID - 1 );
		const index = int( cell.y.mul( GRID ).add( cell.x ) ).add( previous ? 0 : GRID * GRID );
		const packed = this.casterDepths.element( index.div( 4 ) ) as unknown as THREE.Node<'vec4'>;
		const lane = index.mod( 4 );
		const pick = ( k: number ) => select( lane.equal( k ), float( 1 ), float( 0 ) );
		return dot( packed, vec4( pick( 0 ), pick( 1 ), pick( 2 ), pick( 3 ) ) );

	}

	/** World-space bounds of everything that casts into this map (static). Only their part
	 * above the floor can shade a receiver of this map. */
	setCasters( box: THREE.Box3 ): void {

		this.casters.copy( box );
		this.casters.min.y = Math.max( this.casters.min.y, this.floor );
		this.columns = null;
		this.cut = true;

	}

	/**
	 * Compile the pipelines `casters` draw with into this map, off the frame (renderer.compileAsync),
	 * so that a caster first added mid-game (a game's prop) builds none in the frame that redraws
	 * the map. Null until three has built the map and its node (with the first receiver compiled
	 * or drawn). The casters need not be in the scene.
	 *
	 * three draws a caster into the map with the shadow node's material in its own's place
	 * (scene.overrideMaterial), taking the caster's colour, depth and position nodes and side into
	 * it per draw and restoring them after (Renderer.renderObject, r186). compileAsync builds its
	 * draws after that restore, so each caster here compiles with a pass material of its own that
	 * already holds what the draw takes into it: the restore then leaves it as it was. This mirrors
	 * three's shadow material and its non-VSM side rule: re-check it on a three upgrade.
	 */
	compileCasters( renderer: THREE.WebGPURenderer, casters: THREE.Object3D[] ): Promise<void> | null {

		const node = this.sun.shadow.shadowNode as unknown as ShadowRenderer | undefined;
		const map = node?.shadowMap;
		if ( ! node || ! map ) return null;
		const { _getShadowNodes: shadowNodes } = renderer as unknown as { _getShadowNodes( material: THREE.Material ): { colorNode: THREE.Node<'vec4'> | null; depthNode: THREE.Node<'float'> | null; positionNode: THREE.Node<'vec3'> | null } };
		const meshes: THREE.Mesh[] = [];
		for ( const root of casters ) root.traverse( ( object ) => {

			if ( ( object as THREE.Mesh ).isMesh && object.castShadow ) meshes.push( object as THREE.Mesh );

		} );
		// one caster at a time, as a frame draws them (see main.ts on the game's props)
		const compile = ( mesh: THREE.Mesh ): Promise<void> => {

			const material = mesh.material as THREE.NodeMaterial;
			// three's shadow material (ShadowBaseNode), as the draw leaves it for this caster
			const pass = new THREE.NodeMaterial();
			( pass as unknown as { isShadowPassMaterial: boolean } ).isShadowPassMaterial = true;
			pass.name = 'ShadowMaterial';
			pass.blending = THREE.NoBlending;
			pass.fog = false;
			pass.colorNode = vec4( 0, 0, 0, 1 );
			const nodes = shadowNodes.call( renderer, material );
			if ( material.positionNode ) pass.positionNode = material.positionNode;
			if ( nodes.colorNode ) pass.colorNode = nodes.colorNode;
			if ( nodes.depthNode ) pass.depthNode = nodes.depthNode;
			if ( nodes.positionNode ) pass.positionNode = nodes.positionNode;
			pass.side = material.shadowSide ?? SHADOW_SIDE[ material.side ];
			pass.alphaTest = material.alphaTest;
			( pass as unknown as { alphaMap: unknown } ).alphaMap = ( material as unknown as { alphaMap: unknown } ).alphaMap;
			pass.transparent = material.transparent;
			const scene = new THREE.Scene();
			scene.overrideMaterial = pass;
			return compileDraws( renderer, [ mesh ], scene, this.sun.shadow.camera, map );

		};
		return meshes.reduce( ( done, mesh ) => done.then( () => compile( mesh ) ), Promise.resolve() );

	}

	/** Cast the front faces of every shadow-casting mesh under `root` into this map: for closed
	 * solids only (see the header), never for open sheets or cards. Their materials' cast
	 * position becomes the push away from this light, so no other light's shadow may draw them. */
	castFrontFaces( root: THREE.Object3D ): void {

		root.traverse( ( object ) => {

			const mesh = object as THREE.Mesh;
			if ( ! mesh.isMesh || ! mesh.castShadow ) return;
			for ( const material of Array.isArray( mesh.material ) ? mesh.material : [ mesh.material ] ) {

				if ( this.frontCasters.has( material ) ) continue;
				this.frontCasters.add( material );
				const node = material as THREE.NodeMaterial;
				node.castShadowPositionNode = positionLocal.add( modelWorldMatrixInverse.mul( vec4( this.frontPush, 0 ) ).xyz );
				node.needsUpdate = true;

			}

		} );
		this.cut = true;

	}

	/** Redraw from scratch on the next update: casters changed or the light jumped. */
	invalidate(): void {

		this.cut = true;

	}

	/** Once per frame, after the light has moved and before anything renders with the map. */
	update( renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, keyDir: THREE.Vector3 ): void {

		const shadow = this.sun.shadow;
		// three builds its map and the node drawing it with the first receiver's material
		const node = shadow.shadowNode as unknown as ShadowRenderer | undefined;
		const map = node?.shadowMap;
		if ( ! node || ! map ) {

			shadow.needsUpdate = false;
			return;

		}
		const turned = this.drawn.lengthSq() > 0 ? this.drawn.angleTo( keyDir ) : Infinity;
		const resized = this.maps.width !== shadow.mapSize.width || this.maps.height !== shadow.mapSize.height;
		if ( this.cut || turned > CUT || resized ) {

			this.draw( renderer, scene, camera, node, map, keyDir );
			this.hasPrevious = false;
			this.cut = false;
			if ( this.gridWanted ) {

				this.projectGrid( scene, CURRENT, shadowCoordinateMatrix( shadow, new THREE.Matrix4() ) );
				this.clearGrid( PREVIOUS );

			}

		} else if ( turned >= this.step ) {

			// the current map becomes the previous one, with its projection
			renderer.copyTextureToTexture( this.maps.depthTexture!, this.maps.depthTexture!, this.currentLayer, this.toPreviousLayer );
			shadowCoordinateMatrix( shadow, this.previousCoordinate );
			this.previousSpan.value.copy( this.span.value );
			this.previousRange.value = this.range.value;
			this.draw( renderer, scene, camera, node, map, keyDir );
			this.hasPrevious = true;
			if ( this.gridWanted ) {

				this.shiftGrid();
				this.projectGrid( scene, CURRENT, shadowCoordinateMatrix( shadow, new THREE.Matrix4() ) );

			}

		}
		if ( this.gridDirty ) {

			// a receiver arrived after the last redraw: project what is drawn now
			this.projectGrid( scene, CURRENT, shadowCoordinateMatrix( shadow, new THREE.Matrix4() ) );
			if ( this.hasPrevious ) this.projectGrid( scene, PREVIOUS, this.previousCoordinate );
			else this.clearGrid( PREVIOUS );
			this.gridDirty = false;

		}
		if ( this.hasPrevious ) {

			shadowCoordinateMatrix( shadow, this.currentCoordinate ).invert();
			this.toPrevious.value.multiplyMatrices( this.previousCoordinate, this.currentCoordinate );

		}
		this.weight.value = this.hasPrevious ? Math.min( this.drawn.angleTo( keyDir ) / this.step, 1 ) : 1;

	}

	private draw( renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, node: ShadowRenderer, map: THREE.RenderTarget, keyDir: THREE.Vector3 ): void {

		const shadow = this.sun.shadow, shadowCamera = shadow.camera;
		this.drawn.copy( keyDir );
		this.fit( renderer, keyDir );
		// closed solids cast their front faces into this map alone (see the header)
		const sides = new Map( [ ...this.frontCasters ].map( ( material ) => [ material, material.shadowSide ] ) );
		for ( const material of this.frontCasters ) material.shadowSide = THREE.FrontSide;
		this.frontPush.value.copy( keyDir ).normalize().multiplyScalar( - FRONT_PUSH );
		// Draw now rather than inside the next scene render, so the copy below lands before any
		// receiver reads the array. This is what ShadowNode.updateBefore would do with the flag.
		node.updateShadow( { renderer, scene, camera } );
		for ( const [ material, side ] of sides ) material.shadowSide = side;
		shadow.needsUpdate = false;
		if ( this.maps.width !== map.width || this.maps.height !== map.height ) this.maps.setSize( map.width, map.height, 2 );
		renderer.copyTextureToTexture( map.depthTexture!, this.maps.depthTexture!, null, this.toCurrentLayer );
		this.currentLayer.max.set( map.width, map.height, CURRENT + 1 );
		this.mapSize.value.set( map.width, map.height );
		this.span.value.set( shadowCamera.right - shadowCamera.left, shadowCamera.top - shadowCamera.bottom );
		this.range.value = shadowCamera.far - shadowCamera.near;
		this.ready.value = 1;

	}

	// The casters' columns on a world-space grid over their bounds: the lowest and highest point
	// of every shadow-casting mesh in each cell (instances by their bounding boxes), padded for
	// what the rest pose leaves out. Generic: it follows whatever casts, on any layout. It walks
	// every casting vertex once, so each is binned into its own cell and the sideways padding is
	// a separate pass over the cells.
	private buildColumns( scene: THREE.Scene ): void {

		const box = this.casters;
		const cell = Math.max( box.max.x - box.min.x, box.max.z - box.min.z, 1e-3 ) / WORLD_CELLS;
		const nx = Math.ceil( ( box.max.x - box.min.x ) / cell ) + 2 * GRID_SIDE_PAD + 1, nz = Math.ceil( ( box.max.z - box.min.z ) / cell ) + 2 * GRID_SIDE_PAD + 1;
		const x0 = box.min.x - GRID_SIDE_PAD * cell, z0 = box.min.z - GRID_SIDE_PAD * cell;
		const binLow = new Float64Array( nx * nz ).fill( Infinity ), binHigh = new Float64Array( nx * nz ).fill( - Infinity );
		// a caster outside the bounds lands in the nearest border cell, which only adds to it
		const column = ( x: number ) => Math.min( Math.max( Math.floor( ( x - x0 ) / cell ), 0 ), nx - 1 );
		const row = ( z: number ) => Math.min( Math.max( Math.floor( ( z - z0 ) / cell ), 0 ), nz - 1 );
		const mark = ( xa: number, xb: number, za: number, zb: number, ya: number, yb: number ) => {

			const ib = column( xb ), jb = row( zb );
			for ( let j = row( za ); j <= jb; j ++ ) for ( let i = column( xa ); i <= ib; i ++ ) {

				const k = j * nx + i;
				if ( ya < binLow[ k ] ) binLow[ k ] = ya;
				if ( yb > binHigh[ k ] ) binHigh[ k ] = yb;

			}

		};
		const bounds = new THREE.Box3(), instance = new THREE.Matrix4();
		const shadowLayers = this.sun.shadow.camera.layers;
		scene.updateMatrixWorld();
		scene.traverseVisible( ( object ) => {

			const mesh = object as THREE.Mesh;
			if ( ! mesh.isMesh || ! mesh.castShadow || ! mesh.layers.test( shadowLayers ) ) return;
			const geometry = mesh.geometry;
			if ( ! geometry.boundingBox ) geometry.computeBoundingBox();
			const instanced = mesh as THREE.InstancedMesh;
			const position = geometry.getAttribute( 'position' );
			if ( instanced.isInstancedMesh ) {

				for ( let n = 0; n < instanced.count; n ++ ) {

					instanced.getMatrixAt( n, instance );
					bounds.copy( geometry.boundingBox! ).applyMatrix4( instance.premultiply( mesh.matrixWorld ) );
					mark( bounds.min.x, bounds.max.x, bounds.min.z, bounds.max.z, bounds.min.y, bounds.max.y );

				}

			} else if ( position && ! position.normalized && ! ( mesh as THREE.SkinnedMesh ).isSkinnedMesh ) {

				// a mesh's world matrix is affine: apply it by hand, without Vector3's divide
				const e = mesh.matrixWorld.elements;
				const interleaved = position as THREE.InterleavedBufferAttribute;
				const values = interleaved.isInterleavedBufferAttribute ? interleaved.data.array : position.array;
				const stride = interleaved.isInterleavedBufferAttribute ? interleaved.data.stride : position.itemSize;
				const offset = interleaved.isInterleavedBufferAttribute ? interleaved.offset : 0;
				for ( let v = offset, end = offset + position.count * stride; v < end; v += stride ) {

					const px = values[ v ], py = values[ v + 1 ], pz = values[ v + 2 ];
					const x = e[ 0 ] * px + e[ 4 ] * py + e[ 8 ] * pz + e[ 12 ];
					const y = e[ 1 ] * px + e[ 5 ] * py + e[ 9 ] * pz + e[ 13 ];
					const z = e[ 2 ] * px + e[ 6 ] * py + e[ 10 ] * pz + e[ 14 ];
					const k = row( z ) * nx + column( x );
					if ( y < binLow[ k ] ) binLow[ k ] = y;
					if ( y > binHigh[ k ] ) binHigh[ k ] = y;

				}

			} else {

				bounds.copy( geometry.boundingBox! ).applyMatrix4( mesh.matrixWorld );
				mark( bounds.min.x, bounds.max.x, bounds.min.z, bounds.max.z, bounds.min.y, bounds.max.y );

			}

		} );
		// pad each column by its neighbours within GRID_SIDE_PAD cells, and upward
		const low = new Float32Array( nx * nz ).fill( Infinity ), high = new Float32Array( nx * nz ).fill( - Infinity );
		for ( let j = 0; j < nz; j ++ ) for ( let i = 0; i < nx; i ++ ) {

			const k = j * nx + i;
			if ( ! ( binHigh[ k ] >= binLow[ k ] ) ) continue;
			const top = binHigh[ k ] + GRID_HEIGHT_PAD;
			const jb = Math.min( j + GRID_SIDE_PAD, nz - 1 ), ib = Math.min( i + GRID_SIDE_PAD, nx - 1 );
			for ( let b = Math.max( j - GRID_SIDE_PAD, 0 ); b <= jb; b ++ ) for ( let a = Math.max( i - GRID_SIDE_PAD, 0 ); a <= ib; a ++ ) {

				const c = b * nx + a;
				if ( binLow[ k ] < low[ c ] ) low[ c ] = binLow[ k ];
				if ( top > high[ c ] ) high[ c ] = top;

			}

		}
		this.columns = { x0, z0, cell, nx, nz, low, high };

	}

	// The previous map's half becomes the current one's on a step.
	private shiftGrid(): void {

		const values = this.casterDepths.array as THREE.Vector4[];
		const half = GRID * GRID / 4;
		for ( let k = 0; k < half; k ++ ) values[ PREVIOUS * half + k ].copy( values[ CURRENT * half + k ] );

	}

	private clearGrid( layer: number ): void {

		const values = this.casterDepths.array as THREE.Vector4[];
		const half = GRID * GRID / 4;
		for ( let k = 0; k < half; k ++ ) values[ layer * half + k ].setScalar( UNKNOWN );

	}

	// Project the columns into one map's light-space grid, through that map's shadow coordinate.
	private projectGrid( scene: THREE.Scene, layer: number, matrix: THREE.Matrix4 ): void {

		if ( ! this.columns ) this.buildColumns( scene );
		const { x0, z0, cell, nx, nz, low, high } = this.columns!;
		const values = this.casterDepths.array as THREE.Vector4[];
		const half = GRID * GRID / 4;
		const depth = new Float32Array( GRID * GRID ).fill( NO_CASTER );
		const p = new THREE.Vector3();
		// the bilinear footprint beyond a cell's edge, in map units
		const reach = 2 / Math.max( this.mapSize.value.x, 1 );
		for ( let j = 0; j < nz; j ++ ) for ( let i = 0; i < nx; i ++ ) {

			const k = j * nx + i;
			if ( ! ( high[ k ] >= low[ k ] ) ) continue;
			let minX = Infinity, maxX = - Infinity, minY = Infinity, maxY = - Infinity, nearest = Infinity;
			for ( let c = 0; c < 8; c ++ ) {

				p.set( x0 + ( i + ( c & 1 ) ) * cell, c & 4 ? high[ k ] : low[ k ], z0 + ( j + ( ( c >> 1 ) & 1 ) ) * cell ).applyMatrix4( matrix );
				minX = Math.min( minX, p.x ); maxX = Math.max( maxX, p.x );
				minY = Math.min( minY, p.y ); maxY = Math.max( maxY, p.y );
				nearest = Math.min( nearest, p.z );

			}
			const ia = Math.max( Math.floor( ( minX - reach ) * GRID ), 0 ), ib = Math.min( Math.floor( ( maxX + reach ) * GRID ), GRID - 1 );
			const ja = Math.max( Math.floor( ( minY - reach ) * GRID ), 0 ), jb = Math.min( Math.floor( ( maxY + reach ) * GRID ), GRID - 1 );
			for ( let b = ja; b <= jb; b ++ ) for ( let a = ia; a <= ib; a ++ ) depth[ b * GRID + a ] = Math.min( depth[ b * GRID + a ], nearest );

		}
		for ( let k = 0; k < half; k ++ ) values[ layer * half + k ].fromArray( depth, k * 4 );

	}

	// Fit the orthographic frustum to the casters and the shadows they throw down to the floor.
	// Light-space x and y of a shadow equal its caster's, so the casters' footprint bounds every
	// shadowed receiver; only the depth range reaches down to the floor. The island's footprint
	// is far smaller than the sea floor's stones' (which cast into the refracted map, not this
	// one), so its texels are a few times finer than a fixed frame around both.
	private fit( renderer: THREE.WebGPURenderer, keyDir: THREE.Vector3 ): void {

		const sun = this.sun, shadow = sun.shadow, camera = shadow.camera;
		sun.updateMatrixWorld();
		sun.target.updateMatrixWorld();
		if ( ! this.casters.isEmpty() ) {

			// the view LightShadow.updateMatrices builds, before its projection is known
			camera.position.setFromMatrixPosition( sun.matrixWorld );
			camera.lookAt( this.target.setFromMatrixPosition( sun.target.matrixWorld ) );
			camera.updateMatrixWorld();
			const bounds = this.lightBounds.makeEmpty(), box = this.casters;
			// Toward the horizon the depth reach is bounded; the key light has faded out by then.
			const rise = Math.max( keyDir.y, 0.02 );
			for ( let i = 0; i < 8; i ++ ) {

				const corner = this.corner.set( i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z );
				const drop = Math.max( corner.y - this.floor, 0 ) / rise;
				bounds.expandByPoint( this.target.copy( corner ).applyMatrix4( camera.matrixWorldInverse ) );
				bounds.expandByPoint( corner.addScaledVector( keyDir, - drop ).applyMatrix4( camera.matrixWorldInverse ) );

			}
			const margin = this.margin;
			camera.left = bounds.min.x - margin;
			camera.right = bounds.max.x + margin;
			camera.bottom = bounds.min.y - margin;
			camera.top = bounds.max.y + margin;
			camera.near = Math.max( 0.1, - bounds.max.z - margin );
			camera.far = - bounds.min.z + margin;

		}
		camera.coordinateSystem = renderer.coordinateSystem;
		camera.updateProjectionMatrix();
		shadow.bias = - this.bias / ( camera.far - camera.near );
		shadow.updateMatrices( sun );

	}

}
