import * as THREE from 'three/webgpu';
import { Fn, If, exp, float, int, ivec2, max, min, mix, screenCoordinate, texture, textureLoad, uniform, vec2, vec4 } from 'three/tsl';
import { SCENE_SAMPLES, TEMPORAL } from './Antialiasing.ts';
import { debugFlags } from '../debug/DebugFlags.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type M4 = THREE.UniformNode<'mat4', THREE.Matrix4>;

// The meadow's screen-space shadows: the key light's shade the blades and tussocks cast on each
// other, at the scale the sun's map cannot hold (the blades do not cast into it, MeadowCanopy.ts).
// The technique of Bend Studio's screen-space shadows (Days Gone; Wohllaib's grass talk, GDC 2021, also gives
// the grass its fine shade from screen-space shadows beside a coarse shadow of its
// heights), as a per-pixel march: from the
// point a pixel sees, toward the light, over the depth the vegetation's prepass drew, the light
// falling off with the length the ray runs behind the blades in front of it, as through the
// canopy (MeadowCanopy.ts). A tussock's side turned from the sun and the sward behind it lie in
// its shade, the tips over it stay lit, and the meadow shows where the light comes from. It stands
// in for the canopy's mean shade on the blades (Grass.ts): the mean gave every blade at one depth
// the same share of the key, so no blade was lit and none shaded.
//
// The frame (Pipeline.ts): the vegetation's depth copies draw first, in a scene and a pass of their
// own (VegetationPrepass.ts `prepassScene`), into the scene's multisampled depth; that depth's
// nearest sample per pixel is resolved (`meadowDepthMaterial`), marched (`meadowShadeMaterial`),
// and the opaque pass then loads the depth, its shaded vegetation drawing to the copies' samples
// as before, and the blades take the shade into their sun visibility (Grass.ts, `meadowShadeAt`).
// It is a function of the frame's depth alone: no noise, so a paused frame repeats.
// At 4x outside the temporal modes (the prepass draws the coverage there; the temporal modes keep
// it in the opaque pass); off with `flags=meadowShade:false` at load.
export const MEADOW_SHADE = SCENE_SAMPLES === 4 && ! TEMPORAL && debugFlags.meadowShade !== false;

// The march: STEPS lookups over REACH (m) toward the light. A lookup whose depth lies in front of
// the ray by more than its bias (BIAS m, and BIAS_FAR of the distance, the depth's and the
// receiving blade's own) and by less than THICK (m, a tussock's depth: a surface farther in front
// is no wall behind which the ray runs) counts its step as run through blades; DENSITY (per m) and
// OPEN (the share that passes between them) as the canopy's. A march twice as long and a wall
// three times as thick shaded the game's view by about a quarter more, still in specks: the clumps'
// broad shade is the crowns' (MeadowCanopy.ts `meadowCastLight`) and the clumps' dome (Grass.ts).
const STEPS = 16, REACH = 0.8, BIAS = 0.02, BIAS_FAR = 0.001, THICK = 0.3;
export const meadowShadeUniforms = { density: uniform( 6 ), open: uniform( 0.2 ) };

/** The base node the blades load the shade through, at their pixel: the frame graph's texture
 * (Pipeline.ts sets it). */
export const meadowShade = texture( new THREE.DataTexture( new Uint8Array( [ 255, 255, 255, 255 ] ), 1, 1 ) );

/** The shade at the fragment's pixel (1 lit). */
export function meadowShadeAt(): F {

	return ( textureLoad( meadowShade, ivec2( screenCoordinate.xy ) ) as unknown as THREE.Node<'vec4'> ).x;

}

/** The resolve: the nearest sample's view z of the multisampled depth `depth` (-1e5 where nothing
 * was drawn). */
export function meadowDepthMaterial( depth: THREE.Texture, size: V2, projInv: M4 ): THREE.NodeMaterial {

	const ms = texture( depth );
	const m = new THREE.NodeMaterial();
	m.fragmentNode = Fn( () => {

		const coord = screenCoordinate.xy;
		const at = ( i: number ) => textureLoad( ms, ivec2( coord ), int( i ) ) as unknown as F;
		const d = min( min( at( 0 ), at( 1 ) ), min( at( 2 ), at( 3 ) ) ).toVar();
		const z = float( - 1e5 ).toVar();
		If( d.lessThan( 0.999999 ), () => {

			const q = coord.div( size );
			const v = projInv.mul( vec4( q.x.mul( 2 ).sub( 1 ), float( 1 ).sub( q.y ).mul( 2 ).sub( 1 ), d, 1 ) ).toVar();
			z.assign( v.z.div( v.w ) );

		} );
		return vec4( z, 0, 0, 0 );

	} )();
	m.name = 'meadowDepth';
	return m;

}

/** The march over the resolved view z `depth` toward `key` (view space, unit). */
export function meadowShadeMaterial( depth: THREE.Texture, size: V2, proj: M4, projInv: M4, key: V3 ): THREE.NodeMaterial {

	const zMap = texture( depth );
	const m = new THREE.NodeMaterial();
	m.fragmentNode = Fn( () => {

		const coord = screenCoordinate.xy;
		const z = ( textureLoad( zMap, ivec2( coord ) ) as unknown as THREE.Node<'vec4'> ).x.toVar();
		const shade = float( 1 ).toVar();
		If( z.greaterThan( - 1e4 ), () => {

			// the point the pixel sees, from its ray through the far plane
			const q = coord.div( size );
			const ray = projInv.mul( vec4( q.x.mul( 2 ).sub( 1 ), float( 1 ).sub( q.y ).mul( 2 ).sub( 1 ), 1, 1 ) ).toVar();
			const p = ray.xyz.div( ray.w ).mul( z.div( ray.z.div( ray.w ) ) ).toVar();
			const bias = z.negate().mul( BIAS_FAR ).add( BIAS ).toVar();
			const path = float( 0 ).toVar();
			for ( let i = 1; i <= STEPS; i ++ ) {

				const at = p.add( key.mul( REACH * i / STEPS ) ).toVar();
				const clip = proj.mul( vec4( at, 1 ) ).toVar();
				const uv = clip.xy.div( clip.w ).mul( vec2( 0.5, - 0.5 ) ).add( 0.5 );
				const pixel = uv.mul( size ).toVar();
				const inside = pixel.x.greaterThanEqual( 0 ).and( pixel.y.greaterThanEqual( 0 ) ).and( pixel.x.lessThan( size.x ) ).and( pixel.y.lessThan( size.y ) );
				const front = ( textureLoad( zMap, ivec2( max( min( pixel, size.sub( 1 ) ), vec2( 0 ) ) ) ) as unknown as THREE.Node<'vec4'> ).x.sub( at.z );
				If( inside.and( front.greaterThan( bias ) ).and( front.lessThan( THICK ) ), () => {

					path.addAssign( REACH / STEPS );

				} );

			}
			shade.assign( mix( exp( meadowShadeUniforms.density.negate().mul( path ) ), float( 1 ), meadowShadeUniforms.open ) );

		} );
		return vec4( shade, 0, 0, 1 );

	} )();
	m.name = 'meadowShade';
	return m;

}
