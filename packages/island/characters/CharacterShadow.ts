import * as THREE from 'three/webgpu';
import { Fn, uniform, vec2, vec3, vec4, float, floor } from 'three/tsl';
import { solarVolumeVisibility, compileLatentInto } from '../../render/index.ts';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type FilterInput = { depthTexture: THREE.DepthTexture; shadowCoord: V3 };
type Filter = ( input: FilterInput ) => F;

// The figures' own shadow map along the sun, drawn every frame and read with a tent filter.
//
// The island's sun shadow map is drawn once and redrawn only when the light changes. Moving
// figures get a small map of their own along the same sun direction, drawn every frame, and
// every shadow receiver multiplies both visibilities through the sun's shadow filter: the
// meadow, the game's props and the figures themselves take the figures' shadows. This map is read
// with a 5 x 5 texel tent made of nine bilinear comparisons (`tentVisibility`; Castaño's PCF
// weights, "Shadow Mapping Summary - Part 1", 2013), each a 2 x 2 footprint gathered with a comparison
// (textureGatherCompare): only figures cast into it, so it needs no receiver plane. Under a low key the island's map is drawn along the
// key's lifted direction (lighting/SunShadow.ts, lighting/KeyLift.ts), and so is this one (`along`).

// sun shadow coordinates: x, y from NDC to texture space (v down), WebGPU depth unchanged
const NDC_TO_TEXTURE = new THREE.Matrix4().set(
	0.5, 0, 0, 0.5,
	0, - 0.5, 0, 0.5,
	0, 0, 1, 0,
	0, 0, 0, 1,
);

// A 5 x 5 texel tent from nine bilinear comparisons: per axis three taps whose bilinear weights
// and offsets add up to the tent's five texel weights at any sub-texel position s (Castaño).
function tentVisibility( depth: THREE.DepthTexture, coordinate: V3, size: number ): F {

	const texel = 1 / size;
	const at = coordinate.xy.mul( size );
	const base = floor( at.add( 0.5 ) );
	const s = at.add( 0.5 ).sub( base );
	const corner = base.sub( 0.5 ).mul( texel );
	// per axis: weights ( 4 - 3s, 7, 1 + 3s ), offsets in texels
	const weights = [ float( 4 ).sub( s.mul( 3 ) ), vec2( 7 ), float( 1 ).add( s.mul( 3 ) ) ];
	const offsets = [ float( 3 ).sub( s.mul( 2 ) ).div( weights[ 0 ] ).sub( 2 ), float( 3 ).add( s ).div( 7 ), s.div( weights[ 2 ] ).add( 2 ) ];
	let sum: F = float( 0 );
	for ( let j = 0; j < 3; j ++ ) for ( let i = 0; i < 3; i ++ ) {

		const q = corner.add( vec2( offsets[ i ].x, offsets[ j ].y ).mul( texel ) );
		sum = sum.add( weights[ i ].x.mul( weights[ j ].y ).mul( solarVolumeVisibility( depth, vec3( q, coordinate.z ), vec2( size ) ) ) );

	}
	return sum.div( 144 );

}

export class CharacterShadow {

	// figures that cast into this map render on this layer as well as the default one
	static readonly LAYER = 5;
	readonly camera: THREE.OrthographicCamera;
	readonly target: THREE.RenderTarget;
	private readonly depth: THREE.DepthTexture;
	private readonly size: number;
	private readonly range: number;
	private readonly bias: number;
	// static sun shadow coordinates -> this map's coordinates
	private readonly toLocal = uniform( new THREE.Matrix4() );
	private readonly material = new THREE.MeshBasicNodeMaterial();
	private readonly sunToTexture = new THREE.Matrix4();
	private readonly localToTexture = new THREE.Matrix4();
	private readonly direction = new THREE.Vector3();
	/** The world direction toward the light the map is drawn along, read at every update (main.ts
	 * `shadowDirection`: the key's, lifted under a low key); the light's own where it is unset or
	 * the light already stands along it. */
	along: THREE.Vector3 | null = null;

	/** size: texels; half: half the covered width (m) across the sun; range: depth span (m). */
	constructor( size = 1024, half = 1.25, range = 24 ) {

		this.size = size;
		this.range = range;
		this.bias = - 0.006 / range;
		this.depth = new THREE.DepthTexture( size, size, THREE.FloatType );
		this.depth.compareFunction = THREE.LessEqualCompare;
		this.depth.minFilter = this.depth.magFilter = THREE.LinearFilter;
		// The colour is never written. One channel keeps this map's render context its own: three
		// shares one between targets of the same attachments (colour format, samples, depth flag)
		// whatever their depth format, and a compile that builds after its awaits (three's
		// compileAsync, Compile.ts's fallback) builds with the context it collected in, so with the
		// sun's map drawn in between it built a pipeline for that map's depth format.
		this.target = new THREE.RenderTarget( size, size, { depthTexture: this.depth, depthBuffer: true, format: THREE.RedFormat } );
		this.target.texture.name = 'characterShadowColor';
		this.camera = new THREE.OrthographicCamera( - half, half, half, - half, 0, range );
		this.camera.layers.set( CharacterShadow.LAYER );
		this.material.colorWrite = false;
		// No blending: three sets an override's `transparent` from each drawn material and can leave
		// it null rather than false (Renderer.renderObject, r186), which reads as blended; a blended
		// pipeline into this one-channel target reads an alpha its shader does not output, so
		// WebGPU refuses it and every draw of the map uses an invalid pipeline (this map's shader is
		// built for its own target, graph/Compile.ts).
		this.material.blending = THREE.NoBlending;
		this.material.side = THREE.DoubleSide;
		this.material.name = 'characterShadowDepth';

	}

	/** Multiply this map into the sun's existing shadow filter. */
	install( sun: THREE.DirectionalLight ): void {

		const shadow = sun.shadow as unknown as { filterNode: Filter };
		const island = shadow.filterNode;
		const depth = this.depth, toLocal = this.toLocal;
		const size = this.size;
		shadow.filterNode = Fn( ( input: FilterInput ) => {

			// TSL hands a Fn its arguments behind a proxy; pass the island's filter a plain object
			const own = { depthTexture: input.depthTexture, shadowCoord: input.shadowCoord };
			const local = toLocal.mul( vec4( input.shadowCoord, 1 ) ).xyz;
			return island( own ).mul( tentVisibility( depth, local, size ) );

		} ) as unknown as Filter;

	}

	/** Compile the pipelines `object` draws into this map with, off the frame (a figure loaded
	 * mid-game would build them in the frame that first draws the map with it). The pass material
	 * takes no nodes from the figure's own, so only the scene's override is set while the compile
	 * collects its draws (graph/Compile.ts `compileLatentInto`). */
	compile( renderer: THREE.WebGPURenderer, scene: THREE.Scene, object: THREE.Object3D ): Promise<void> {

		const override = scene.overrideMaterial;
		scene.overrideMaterial = this.material;
		try {

			return compileLatentInto( renderer, [ object ], scene, this.camera, this.target );

		} finally {

			scene.overrideMaterial = override;

		}

	}

	/** Follow the figures (centre: a point near their hips) and draw their depth from the sun. */
	update( renderer: THREE.WebGPURenderer, scene: THREE.Scene, sun: THREE.DirectionalLight, centre: THREE.Vector3 ): void {

		const cam = this.camera, sunCam = sun.shadow.camera;
		cam.coordinateSystem = sunCam.coordinateSystem = renderer.coordinateSystem;
		cam.updateProjectionMatrix();
		sunCam.updateProjectionMatrix();
		sun.updateMatrixWorld();
		sun.target.updateMatrixWorld();
		// The island depth map updates at a bounded cadence during day motion. Keep its
		// matrix paired with that raster; the figures still get their own fresh map below.
		if ( sun.shadow.needsUpdate || sun.shadow.autoUpdate ) sun.shadow.updateMatrices( sun );
		this.direction.subVectors( sun.position, sun.target.position ).normalize();
		if ( this.along && this.direction.angleTo( this.along ) > 1e-6 ) this.direction.copy( this.along ).normalize();
		cam.position.copy( centre ).addScaledVector( this.direction, this.range * 0.5 );
		cam.up.set( 0, 1, 0 );
		cam.lookAt( centre );
		cam.updateMatrixWorld();

		// static coordinate s = T( s.xyz - bias_sun ): undo the sun's matrix, apply this one
		this.sunToTexture.multiplyMatrices( NDC_TO_TEXTURE, sunCam.projectionMatrix ).multiply( sunCam.matrixWorldInverse );
		this.localToTexture.multiplyMatrices( NDC_TO_TEXTURE, cam.projectionMatrix ).multiply( cam.matrixWorldInverse );
		const m = this.toLocal.value;
		m.makeTranslation( 0, 0, this.bias ).multiply( this.localToTexture ).multiply( this.sunToTexture.invert() )
			.multiply( new THREE.Matrix4().makeTranslation( 0, 0, - sun.shadow.bias ) );

		const target = renderer.getRenderTarget();
		const override = scene.overrideMaterial;
		scene.overrideMaterial = this.material;
		renderer.setRenderTarget( this.target );
		renderer.render( scene, cam );
		renderer.setRenderTarget( target );
		scene.overrideMaterial = override;

	}

}
