import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, vec4, mix } from 'three/tsl';
import { solarShadowVisibility, solarVolumeVisibility } from './SolarShadow.ts';

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
const STEP = THREE.MathUtils.degToRad( 0.2 );
// A larger turn in one frame is a cut (a new hour, preset or manual sun): redraw without history.
const CUT = THREE.MathUtils.degToRad( 1 );
const PREVIOUS = 0, CURRENT = 1;

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
	// Bias along the light ray, in metres; converted to the map's depth range.
	bias?: number;
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
	private readonly drawn = new THREE.Vector3();
	private readonly bias: number;
	// the light's turn between redraws (radians)
	step = STEP;
	private hasPrevious = false;
	private cut = true;
	private readonly previousCoordinate = new THREE.Matrix4();
	private readonly currentCoordinate = new THREE.Matrix4();
	private readonly currentLayer = new THREE.Box3( new THREE.Vector3( 0, 0, CURRENT ), new THREE.Vector3( 1, 1, CURRENT + 1 ) );
	private readonly toCurrentLayer = new THREE.Vector3( 0, 0, CURRENT );
	private readonly toPreviousLayer = new THREE.Vector3( 0, 0, PREVIOUS );

	constructor( sun: THREE.DirectionalLight, { bias = 0.01 }: SunShadowOptions = {} ) {

		this.sun = sun;
		this.bias = bias;
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

		const filter = Fn( ( { shadowCoord }: FilterInput ) => this.surfaceVisibility( shadowCoord ) );
		// The runtime exposes filterNode; @types/three has not declared this WebGPU hook yet.
		( this.sun.shadow as unknown as { filterNode: typeof filter } ).filterNode = filter;

	}

	/** The previous map's coordinate for a coordinate in the current map (both orthographic). */
	previousCoordinateNode( coordinate: V3 ): V3 {

		return this.toPrevious.mul( vec4( coordinate, 1 ) ).xyz;

	}

	/** A surface's visibility from its coordinate in the current map (three's shadow coordinate). */
	surfaceVisibility( coordinate: V3 ): F {

		const mapSize = this.mapSize;
		return mix(
			solarShadowVisibility( this.depth, this.previousCoordinateNode( coordinate ), {
				mapSize, worldSpan: this.previousSpan, depthRange: this.previousRange, active: this.weight.lessThan( 1 ), layer: PREVIOUS } ),
			solarShadowVisibility( this.depth, coordinate, {
				mapSize, worldSpan: this.span, depthRange: this.range, active: this.ready.greaterThan( 0 ), layer: CURRENT } ),
			this.weight );

	}

	/** The same for a point in a volume (no receiver plane, no derivatives). */
	volumeVisibility( coordinate: V3 ): F {

		return mix(
			solarVolumeVisibility( this.depth, this.previousCoordinateNode( coordinate ), this.mapSize, this.weight.lessThan( 1 ), PREVIOUS ),
			solarVolumeVisibility( this.depth, coordinate, this.mapSize, this.ready.greaterThan( 0 ), CURRENT ),
			this.weight );

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

		} else if ( turned >= this.step ) {

			// the current map becomes the previous one, with its projection
			renderer.copyTextureToTexture( this.maps.depthTexture!, this.maps.depthTexture!, this.currentLayer, this.toPreviousLayer );
			shadowCoordinateMatrix( shadow, this.previousCoordinate );
			this.previousSpan.value.copy( this.span.value );
			this.previousRange.value = this.range.value;
			this.draw( renderer, scene, camera, node, map, keyDir );
			this.hasPrevious = true;

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
		this.project( renderer );
		// Draw now rather than inside the next scene render, so the copy below lands before any
		// receiver reads the array. This is what ShadowNode.updateBefore would do with the flag.
		node.updateShadow( { renderer, scene, camera } );
		shadow.needsUpdate = false;
		if ( this.maps.width !== map.width || this.maps.height !== map.height ) this.maps.setSize( map.width, map.height, 2 );
		renderer.copyTextureToTexture( map.depthTexture!, this.maps.depthTexture!, null, this.toCurrentLayer );
		this.currentLayer.max.set( map.width, map.height, CURRENT + 1 );
		this.mapSize.value.set( map.width, map.height );
		this.span.value.set( shadowCamera.right - shadowCamera.left, shadowCamera.top - shadowCamera.bottom );
		this.range.value = shadowCamera.far - shadowCamera.near;
		this.ready.value = 1;

	}

	// The projection for the light's current direction, as LightShadow.updateMatrices builds it.
	private project( renderer: THREE.WebGPURenderer ): void {

		const sun = this.sun, shadow = sun.shadow, camera = shadow.camera;
		sun.updateMatrixWorld();
		sun.target.updateMatrixWorld();
		camera.coordinateSystem = renderer.coordinateSystem;
		camera.updateProjectionMatrix();
		shadow.bias = - this.bias / ( camera.far - camera.near );
		shadow.updateMatrices( sun );

	}

}
