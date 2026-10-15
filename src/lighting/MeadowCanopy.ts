import { Fn, exp, float, max, min, mix, uniform } from 'three/tsl';
import type * as THREE from 'three/webgpu';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

// Grass blades are narrower than a sun-shadow texel, so the meadow does not cast into the sun's
// shadow map: as the sun turns, re-rasterising sub-texel blades reshuffles their whole shadow
// pattern at every map update. Larger casters (rock, flowers, figures) keep the map.
// Shading inside the meadow is instead the light that survives the canopy above a point on its way
// to the key light, the same at every point of the meadow at one depth: a lawn of even blades
// darkens evenly toward the ground. A field of gaps once let light through in patches, which from
// the overview read as fine dark blotches and, under a low sun, as dark streaks along its azimuth;
// the lawn's own root-to-tip colour (Grass.ts) carries the darkening near the ground instead. Of
// the key light, `open` passes as if through the gaps between blades, and the rest falls off with
// the path through the canopy, so a low sun deepens the shade without turning the meadow olive.
export const meadowCanopy = {
	density: uniform( 5 ), // extinction per metre of canopy along the ray
	// The share of the key light that reaches any depth between the blades: the mean open share of
	// the former gap field, so the meadow's mean brightness stays as it was.
	open: uniform( 0.5 ),
};

// Uniforms reach a layout function only as arguments.
const canopyLight = Fn( ( [ depth, key, density, open ]: [ F, V3, F, F ] ) => {

	// Grazing light crosses at most this much canopy; beyond it the key is dark anyway.
	const rise = max( key.y, 0.12 );
	const reach = min( max( depth, 0 ).div( rise ), 2.5 );
	return mix( exp( density.negate().mul( reach ) ), float( 1 ), open );

} ).setLayout( { name: 'ponlaiMeadowCanopy', type: 'float', inputs: [
	{ name: 'depth', type: 'float' }, { name: 'key', type: 'vec3' }, { name: 'density', type: 'float' }, { name: 'open', type: 'float' },
] } );

// Light transmitted to a point `depth` metres below the canopy top. `key` is the unit direction
// toward the light. Uses no textures or derivatives, so it is safe inside branches and in the
// vertex stage.
export function meadowCanopyLight( depth: F, key: V3 ): F {

	return canopyLight( depth, key, meadowCanopy.density, meadowCanopy.open );

}

// A tuft's top stands CANOPY_TOP times its height scale above its root (plantGrass). The canopy's
// depth above the turf is one value for the whole meadow, about the lawn's tuft top: the turf's
// shade then varies with the sun's height alone. A blade takes this depth scaled by its share of
// the way down its own tuft (Grass.ts), so its root meets the turf's shade; the flowers, which
// stand in the sward, take their depth below its top.
export const CANOPY_TOP = 0.8;
export const TURF_CANOPY_DEPTH = 0.2;
