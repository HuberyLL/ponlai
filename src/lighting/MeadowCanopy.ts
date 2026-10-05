import type * as THREE from 'three/webgpu';
import { Fn, dot, exp, float, length, max, min, smoothstep, uniform, vec2 } from 'three/tsl';
import { pnoise } from '../materials/ProceduralTextures.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

// Grass blades are narrower than a sun-shadow texel, so the meadow does not cast into the sun's
// shadow map: as the sun turns, re-rasterising sub-texel blades reshuffles their whole shadow
// pattern at every map update. Larger casters (rock, bushes, flowers, figures) keep the map.
// Shadowing inside the meadow is instead the light that survives the canopy above a point on
// its way to the key light. Gaps are sampled where that ray leaves the canopy, so blades and the
// turf below share one dapple field, and it slides continuously with the sun like a cast shadow.
export const meadowCanopy = {
	density: uniform( 5 ), // extinction per metre of canopy along the ray
	gapScale: uniform( 12 ), // dapple frequency across the light, per metre
	contrast: uniform( 1 ), // 0: uniform canopy, 1: fully open gaps
	softness: uniform( 0.25 ), // width of the gap edges in noise units
	stretch: uniform( 2 ), // elongation along the light's azimuth per unit of shadow length
};

const PERIOD = vec2( 4096 );

// Uniforms reach a layout function only as arguments.
const canopyLight = Fn( ( [ xz, depth, key, density, gapScale, contrast, softness, stretch ]: [ V2, F, V3, F, F, F, F, F ] ) => {

	// Grazing light crosses at most this much canopy; beyond it the key is dark anyway.
	const rise = max( key.y, 0.12 );
	const reach = min( max( depth, 0 ).div( rise ), 2.5 ).toVar();
	const exit = xz.add( key.xz.mul( reach ) ).toVar();
	// Blade shadows lengthen along the sun's azimuth as it sinks: stretch the gaps the same way.
	const flat = length( key.xz );
	const azimuth = key.xz.div( max( flat, 1e-4 ) ).toVar();
	const along = dot( exit, azimuth ).div( float( 1 ).add( min( flat.div( rise ), 3 ).mul( stretch ) ) );
	const across = dot( exit, vec2( azimuth.y.negate(), azimuth.x ) );
	const q = vec2( along, across ).mul( gapScale ).toVar();
	const gaps = pnoise( q, PERIOD ).mul( 0.55 )
		.add( pnoise( q.mul( 2.7 ).add( 17.1 ), PERIOD ).mul( 0.3 ) )
		.add( pnoise( q.mul( 6.1 ).sub( 5.3 ), PERIOD ).mul( 0.15 ) );
	const open = smoothstep( softness.negate().mul( 0.5 ), softness.mul( 0.5 ), gaps ).mul( contrast );
	return exp( density.negate().mul( reach ).mul( float( 1 ).sub( open ) ) );

} ).setLayout( { name: 'soomiMeadowCanopy', type: 'float', inputs: [
	{ name: 'xz', type: 'vec2' }, { name: 'depth', type: 'float' }, { name: 'key', type: 'vec3' },
	{ name: 'density', type: 'float' }, { name: 'gapScale', type: 'float' }, { name: 'contrast', type: 'float' },
	{ name: 'softness', type: 'float' }, { name: 'stretch', type: 'float' },
] } );

// Light transmitted to a point `depth` metres below the canopy top at `xz`. `key` is the unit
// direction toward the light. Uses no textures or derivatives, so it is safe inside branches.
export function meadowCanopyLight( xz: V2, depth: F, key: V3 ): F {

	const c = meadowCanopy;
	return canopyLight( xz, depth, key, c.density, c.gapScale, c.contrast, c.softness, c.stretch );

}

// Canopy top above the turf for a meadow growth value, matching the mean tuft height that
// buildGrass plants there (base growth plus the share of taller shoots), at CANOPY_TOP.
export const CANOPY_TOP = 0.8;
export const meadowCanopyHeight = Fn( ( [ growth ]: [ F ] ) =>
	growth.mul( 0.14 ).add( 0.17 ).add( smoothstep( 0.38, 0.74, growth ).mul( 0.46 * 0.21 ) ).mul( CANOPY_TOP )
).setLayout( { name: 'soomiMeadowCanopyHeight', type: 'float', inputs: [ { name: 'growth', type: 'float' } ] } );
