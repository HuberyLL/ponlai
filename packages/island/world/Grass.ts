import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, abs, acos, atan, cameraPosition, ceil, cameraViewMatrix, clamp, cos, cross, diffuseColor, dot, exp, exp2, faceDirection,
	float, floor, fract, instanceIndex, int, ivec2, length, localId, log2, max, min, mix, normalize,
	select, sin, smoothstep, sqrt, step, storage, texture, textureLoad, uint, uniform, varying, vec2, vec3, vec4,
	positionWorld, specularColor, specularColorBlended, specularF90, vertexIndex, workgroupArray, workgroupBarrier, workgroupId,
} from 'three/tsl';
import { LAWN_GAIN, MEADOW_EXTENT, MEADOW_MIN_UP, MEADOW_SIZE, groundGains } from '../materials/Meadow.ts';
import { GUST_MEAN, gustAt, gustJitter, wave, windStrength, type WindState, RESPONSE, displacementAt, runSteps, CANOPY_SHADE, transmission, vegetationMaterial, unjitteredPadded, TEMPORAL, debugFlags, MEADOW_SHADOWS, meadowShadowAt, meadowShadowFloor, receiveScreenAO, textureSteps, type VegetationKind, type Shared, selectVec3, tune, tuneApply, tuneUniform, liftKeyWorld } from '../../render/index.ts';
import type { WorldData } from './types.ts';
import { GROUND_A, HEIGHT_MAP, LIP, SINK, SWARD_DEPTH, grassSteps, type GrassPlan } from './GrassGround.ts';
import { GROVES } from './BambooGroves.ts';
import { soilGroveAt } from '../materials/Soil.ts';
export { plantGrass, type GrassPlan } from './GrassGround.ts';
import { canopySteps, crownSteps, setCanopyTop, setSwardField, swardSteps } from './SwardField.ts';

// The meadow: one grass blade per cell of a world grid, generated on the GPU as the view changes.
// Each blade is drawn on its own, not as a card of many, so the wind moves every blade and the
// meadow draws no overdraw of transparent cards: a technique Eric Wohllaib presented
// ("Procedural Grass in 'Ghost of Tsushima'", GDC 2021; cited below by minute), which took its
// start from Outerra ("Procedural grass rendering", 2012-05-27).
//
// - Generation: the meadow is covered by world-aligned tiles of TILE_CELLS x TILE_CELLS cells
//   (CELL m). For the tiles near enough and inside the view, a compute pass runs one thread per
//   cell and decides whether its blade grows: the ground map says whether grass grows there (the
//   blade picks one of the four nearest texels with the bilinear weights as probabilities, so
//   the edge of the meadow is dithered rather than stepped) and where the ground lies. A cell's
//   random values are hashes of its world cell, so a blade stays itself as the view moves. The
//   tiles are taken near to far. Grown blades are compacted into one list (count, scan, scatter:
//   deterministic, no atomics, so a paused frame is bit-identical) in two segments, the near blades and
//   from LOW.from m on the far ones, drawn by two indirect draws, BLADES blades an instance, of
//   VERTS and LOW.verts vertices a blade. A blade's make (`scatter`): its height from the grass-height map, its
//   clump (a Voronoi cell) and its own hash; its facing's static sum (its own, out of its clump,
//   the clump's way and down the slope of the ground map), to which the vertex stage adds the
//   wind's heading (`bladeFacing`); its lean, bend and tip offset; its width, from its clump too,
//   which the LOD widens as it thins the blades far off.
// - The blade (`bladeVertex`): a quadratic Bezier from the root, of one width along it and closed
//   at its tip, generated from the vertex and instance index alone; a short blade folds its strip
//   into two leaves of its length, splayed apart about its facing (in the far draw the shorter
//   leaf's tip left open: `bladeGeometry`). The wind
//   (Wind.ts) sets the meadow's heading and each blade's sway, both in the vertex stage, so
//   the blades are a function of the scene clock and the weather; the displacement field
//   (vegetation/Displacement.ts), where the islanders walk, turns them and lays them over (PARTING).
//   A blade's pose is a continuous function of the push: the push adds to the lean as a level
//   vector, and turns the facing only by its part across it; never is a sum of directions that can
//   cancel (the push, the wind's heading, the blade's own facing) normalised into a direction,
//   which flips the blades half a turn in one frame where the sum passes through 0 (a walker
//   heading into the wind pushes its way's middle against the blades' facing).
// - The surface (`grassMaterial`): a few key colours along the blade, in one of two columns by
//   its clump (BLADE_COLOUR), the root's darkness an occlusion (times the screen-space one,
//   post/GTAO.ts), normals leaned out toward the edges, a translucency that rises from root to tip,
//   by which the key's diffuse wraps round to the far side and light comes through the blade
//   (`TRANSLUCENCY`); the gloss lowered with the distance (`SURFACE.farGloss`) and, far off,
//   normals pulled toward the ground's up. Its ambient diffuse is the
//   ambient volume's (lighting/AmbientSample.ts), degree 2, read per pixel half a metre above the
//   blade's point, weighted by its translucency (`TRANSLUCENCY`). Not per tuft at generation: the blades and their cull are made when the view
//   moves, while the volume is relit every frame the clock runs, so values stored then would lag
//   the light; and per pixel, behind the vegetation's depth prepass, reads fewer texels than the
//   blades' vertices would.
// - Shadow: the blades stay out of the sun's map; the meadow shades its own layer, a top at
//   0.628 of the blades' mean length over their roots, where it is read (`meadowLayerLight`,
//   `GRASS_SHADOW`): whatever lies under the top (the lower blades, the turf under them, the
//   ground beside it where the light comes over it) takes exp( -l / s ) of the key, l its ray's
//   length under the top (`LAYER`), the ray running along the lifted key (lighting/KeyLift.ts,
//   the direction the sun's map is cast along). The finer shadowing of blade on blade is the
//   meadow's screen-space shadows (post/MeadowShadows.ts, `sunOcclusion`), held above the shadows' floor by translucency
//   (`meadowShadowFloor`); the floor does not raise the layer's.
// - The ground under the blades (TerrainMaterial.ts, `GRASS_ROOTS`): brown soil at every distance,
//   seen through the gaps between the blades; darker on screen by the shadows alone.
//
// The ground map (`grassSteps`): over the meadow's square (MEADOW_EXTENT, MEADOW_SIZE texels), the
// turf anchors splatted bilinearly (those on the cliff's face under the lip left out): the share of
// the anchors that hold turf (inland `supportsMeadow`, on the rim the rim's turf that
// TerrainMaterial.ts draws, RimGround.ts `rimTurfCover`, and thinning into the bamboo groves:
// BambooGroves.ts `grassOnLitter`), their mean height (on the lip a line in the rim distance, LIP)
// and mean sky
// visibility, and the grass-height map (HEIGHT_MAP), which shortens toward the land's edge only:
// the grass round a clearing in the litter keeps its height up to it. Its A holds that height map
// free of the land's edge as well as what the edge takes off it (GROUND_A): the blades read the
// shortened one (their lengths, their layer's shadow, and the shadow on what is not turf), and only
// the turf's run under the layer reads the free one (`meadowGroundRuns`), so the turf along the rim,
// under blades that shorten and thin, lies as deep in the layer as the turf inland and does not take
// the key the layer's edge would let in. Generation
// reads it with texel loads, and beside it the lip's map of the same size (`lipMap`: per texel the
// rim distance, the roots' slope in it and the turf's reach, LIP), by which each blade on the lip
// takes its own roots' height and grows no further out than the turf; a growth step bakes new ones
// and swaps them in through the two texture nodes, with the sward and crown fields the ground
// under the meadow reads
// (SwardField.ts). The blades follow the land as it grows, the same function of it as at load.

type F = THREE.Node<'float'>;
type U = THREE.Node<'uint'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;
type UintMax = ( a: U, b: U ) => U;
type Lanes = { element: ( i: U ) => U };

// --- generation

/** The cells per m^2 over the base of 100: 1.25, times the load-time flag `grassDensity`. With the
 * blades 2 cm wide, edge-on ones widened (THICKEN) and those under 0.6 m folded
 * (LENGTH), the blades covered 0.44 of the lawn in the island camera's view at 1, 0.5 at 1.2 and
 * 0.53 at 1.35, where the lawn's cover is 0.5 to 0.7 (tools/island/meadow-light.mjs); at 1.25, 0.51 there,
 * 0.61 from 24 m at 50 degrees (the mean of three headings) and 0.64 from 45 m. The centimetre
 * blades (WIDTH) keep their widths' mean of 1.2 cm by fewer cells: 1.04, as many blades' area as
 * 1.25 of 1 cm. (Measured before the LOD widened its kept blades only twice per level, not four
 * times, which thins the far meadow's cover: the cover is left to the meadow's tuning.) */
const DENSITY = 1.04 * Number( debugFlags.grassDensity ?? 1 );
const CELL = 0.1 / Math.sqrt( DENSITY ), TILE_CELLS = 256, TILE = CELL * TILE_CELLS;
// (tile indices are offset by this many tiles to keep cell indices unsigned)
const TILE_OFFSET = 128;
const GROUP = 256, LOG2_GROUP = 8, BLOCK = 16;
const GROUPS_PER_TILE = ( TILE_CELLS / BLOCK ) ** 2;
const MAX_TILES = Math.ceil( 81 * Math.max( DENSITY, 1 ) );
const CAPACITY = Math.ceil( ( 1 << 20 ) * Math.max( DENSITY, 1 ) );
/** Blades an instance of the draws and the vertices of one blade (a strip, or two leaves of a
 * folded blade: `bladeGeometry`), near and in the far draw (LOW). */
const BLADES = 64, VERTS = 15, INDICES = ( VERTS - 2 ) * 3;
/** The far draw: blades from `from` m off along the ground (at generation) take `verts` vertices,
 * three rows and the tip, half the near draw's; a near blade's rows move to the far draw's over
 * `start` to `start` + `width` m, a random `spread` m earlier per blade, so the far blades take
 * over with no change of shape (`bladeVertex`; the near shorter leaf's tip row opens over the
 * same band, as the far one's is open). A 0.3 m blade at 30 m is some twenty pixels tall
 * in the baseline's render under the island camera's view, where three segments draw its curve. */
const LOW = { from: 30, verts: 7, start: 25, width: 5, spread: 3 };
const LOW_INDICES = ( LOW.verts - 2 ) * 3;
/** A blade of `verts` vertices: its rows (two vertices each, the tip one), its segments as a
 * single blade, and a folded blade's root row (`bladeGeometry`): near, the longer leaf first (four
 * segments) and the shorter after the root (three); far, the shorter first (one segment, its tip
 * open) and the longer after it (two). */
const shapeOf = ( verts: number ) => ( { segments: ( verts - 1 ) / 2, root: verts === VERTS ? 4 : 1 } );
/** The farthest blade (m from the eye, along the ground), the band over which the blades thin to
 * nothing (m), and the pad of the view's planes (m). The island camera stands at most 190 m off.
 * A cell keeps sat( ( REACH - d ) / REACH_FADE - 0.5 * its own random ) of its blade (its width;
 * none at 0, where it does not grow), so the meadow's last ring goes out blade by blade, each at a
 * distance of its own over half the band, never along one edge (`cell`). */
const REACH = 240, REACH_FADE = 20, FRUSTUM_PAD = 1;
/** The tallest a blade stands (m), for the tiles' boxes and the longest blade. */
const TALLEST = 1;

// --- the blades' make

const DEG = Math.PI / 180, TAU = Math.PI * 2;
/** The blades' heights (m): h = `full` ( `vary` ( c xi_clump - 1/4 ) + m ) ( 1 - `mix` + `mix` xi ),
 * m the grass-height map (0..1), `full` the height where it stands at 1 (the map's calibration:
 * 0.4 m at its mean), c the blade's nearness to its clump's centre and xi_clump the mean of three of
 * the clump's randoms (`CLUMP`), so the clump term is positive about the centre and negative toward
 * the edge; at least `least`, at most TALLEST; where the map is below `bare` no blade grows. Blades
 * shorter than `fold` fold into two leaves of their length (`bladeGeometry`, FOLD). */
const LENGTH = { full: 0.5, vary: 0.6, mix: 0.3, least: 0.04, bare: 0.05, fold: 0.6 };
/** A blade's width (m): `least` + `vary` xi, times 1 + `clump` ( c xi_clump - 1/4 ) (wider toward
 * its clump's centre) and the LOD's widening (`LOD`); the same along the whole blade, which closes
 * at its tip's one vertex. `grassWidth` (load-time flag) scales it. */
const WIDTH = { least: 0.007, vary: 0.01, clump: 0.5, scale: Number( debugFlags.grassWidth ?? 1 ) };
/** The rows along a blade: a single blade's rows stand evenly over t in [ `from`, `to` ] of its
 * curve (the tip at 1); a folded blade's leaves at t = 1 - ( 1 - u )^2, u even along the leaf, their
 * rows closer together toward the tip. (The rows' spacing along the blade a parameter of its own:
 * Wohllaib 08:30.) */
const ROWS = { from: 0, to: 1 };
/** A blade's lean, stored as the tangent of its chord's angle from upright:
 * tan = `lean` ( 0.3 + 1.4 xi ) ( 1 + 0.25 m ), from 0.15 to 0.85 where the map is 0 (a fifth more
 * where it is 1). */
const TILT = { lean: 0.5 };
/** A blade's bend off its chord: b = `arch` ( xi + 0.5 ) of its height, either way at random (its
 * curve's middle control point, `middle` of the way to the tip, pushed b times its height below the
 * chord or lifted above it); its tip set `offset` ( 2 xi - 1 ) of its height across its facing. */
const BEND = { arch: 0.3, offset: 0, middle: 0.5 };
/** A folded blade's two leaves (`bladeVertex`), which should read as two blades from one root, not
 * as a V: of the blade's length and tilt, facing normalize( f +- `split` across ) (about 31 degrees
 * either side of the blade's facing f, level); both bend `bend` of a single blade's bend, so the
 * four and three segments of their rows hold the curve without a visible kink. */
const FOLD = { split: 0.6, bend: 0.6 };
/** The blades' facing in the vertex stage, before the displacement field turns it (PARTING): their
 * static sum (`scatter`, FACING) plus `wind` times the wind's heading, normalised. A strong wind
 * shows in the blades' sway and its gusts (SWING), not in their facing. `wind`, 1.05, is set in
 * our scenes; tunable at load (`grass.pose.wind`). */
const POSE = { wind: tune( 'grass.pose.wind', 1.05, { min: 0, max: 4, load: true } )() };
/** The facing's static sum (`scatter`, not normalised; the vertex stage adds the wind's heading:
 * POSE): two uniform randoms in [ -1, 1 ], plus `out` xi_clump times the unit way out from the
 * clump's centre (0 at the centre), `clump` c times the clump's own way (each part a uniform in
 * [ -1, 1 ]) and `slope` times the level part of the ground's normal, so a tuft splays out, some
 * clumps lie one way together and the blades on a slope lie down it. */
const FACING = { out: 0.5, clump: 1, slope: 5 };
/** The clumps: Voronoi cells of jittered points `size` m apart (the nearest of the nine around a
 * blade); c, a blade's nearness to its clump's centre, is 1 there and 0 at about the clump's edge,
 * and xi_clump the mean of three of the clump's randoms. They set the blades' height and width
 * (LENGTH, WIDTH); a blade's root is drawn sat( c `pull` xi xi_clump ) of the way to the centre;
 * the clumps whose own random falls below `column` take the second colour column (BLADE_COLOUR
 * `b`), the rest the first. Off with `flags=grassClumps:false` (at load). */
const CLUMP = { size: 1, pull: 0.3, column: 0.2, on: debugFlags.grassClumps !== false };
/** The blades' sway s, which pushes the curve's control points (`bladeVertex`). The blade's local
 * wind is u = S ( 1 + `flutter` w ): S the plants' gusted speed (m/s, below) and w =
 * sin( 2 pi xi + 2 pi `rate` phi - `lag` t ) a wave that runs up the blade, xi the blade's phase (its
 * hash), phi the grass's clock (Wind.ts `plantClock`: `rate` swings a metre of the plants' travel,
 * 0.8 Hz at the gentle level's plants' speed of 9.5 m/s and faster as the wind rises) and t the
 * place along the blade. So u flutters about the gusted speed, `flutter` of it either way: 0.3, a
 * typical intensity of the wind's turbulence near the ground. `lag` pi / 2 sets the tip a quarter
 * of a swing behind the root. S is the plants' speed U_p (Wind.ts `plantSpeed`) gusted as the
 * plants' main bend gusts its wind (Wind.ts `plantWind`): the wind's strength at the gust q_g at
 * the blade's root (`windStrength`, U_p ( 1 + gustGain q_g ), q_g 0 between gusts and 1 at a full
 * gust's core) over its mean ( 1 + gustGain GUST_MEAN ), so its mean is U_p and a full gust
 * takes it to 4/3 of that, a gust factor within the levels' 1.3 to 1.5 (sky/Weather.ts
 * WIND_LEVELS). The blade's load is
 * q = ( u / `half` )^2, the wind's pressure on it in units of a `half` m/s wind's. The sway is the
 * load's saturating share, s = q / ( 1 + q ), as the plants' main bend saturates in the shared
 * deform (vegetation/Deform.ts, L / ( |L| + L_h )): smooth, 0 in still air, 1/2 where u = `half`
 * and below 1 under any load, with no clamp. `half` is the blades' stiffness: the plants' speed at
 * which the load's share reaches 1/2, where the drag's turning reaches half its bound (below). Its
 * value, 14.7, is set in our scenes: the mean blade's tip at the gentle level stands 0.73 of the
 * blade's length high. Tunable without a reload (`grass.swing.half`, a uniform).
 * The mean blade's s is 0.07, 0.29, 0.44 and 0.57 from the light level to the strong, and the
 * flutter swings it from 0.17 to 0.41 at the gentle level and from 0.40 to 0.69 at the strong. A
 * full gust takes the mean blade's s to 0.12, 0.43, 0.58 and 0.70 from the light level to the
 * strong, past its flutter's crest at every level, and the lull between gusts down to 0.03, 0.16,
 * 0.26 and 0.37.
 * The sway bends the blade from its root: by the Euler-Bernoulli relation the curvature a load adds
 * at a point is in proportion to its bending moment there (M = EI kappa), and the moment of a drag
 * spread along a cantilevered blade of unit length is in proportion to ( 1 - x )^2 at x along it
 * (0 root, 1 tip): largest at the root, nothing at the tip. The blade at rest is straight, leaning
 * theta0 (`rest`) from upright along its facing: 0.52 rad, the blades' mean chord angle (TILT: the
 * mean of atan( lean ( 0.3 + 1.4 xi ) ( 1 + 0.25 m ) ) at the height map's mean). Under the sway
 * its tangent stands at theta( x ) = theta0 + Delta ( 1 - ( 1 - x )^3 ) from upright, the integral
 * of that curvature, with Delta = s ( pi / 2 - theta0 ): the drag turns the root most and the tip
 * follows, so the blade lies down from its base. A blade under the wind's drag alone bends toward
 * the flow, its frontal area shrinking as it does (the area-reduction regime of Gosselin, de Langre
 * and Machado-Almeida, "Drag reduction of flexible plates by reconfiguration", J. Fluid Mech. 650,
 * 2010; for blades, Luhar and Nepf, "Flow-induced reconfiguration of buoyant and flexible aquatic
 * vegetation", Limnol. Oceanogr. 56, 2011), and the drag on a part of it fades as that part comes
 * to lie along the wind, so no point's tangent passes the wind's direction: theta( 1 ) stays below
 * pi / 2, as s stays below 1. The point a along the blade is P( a ), the integral of ( sin theta,
 * cos theta ) from the root to a (along the facing, up), taken by three-point Gauss-Legendre
 * (`bladePoint`: exact for a polynomial of degree 5, within 7e-4 of the integral for s up to 0.95);
 * the tip is P( 1 ), the middle P( 1/2 ). The tip's push is the tip's move from the rest blade's
 * ( sin theta0, cos theta0 ), so the mean blade keeps its length as it bends and the tip sinks as it
 * goes over, and its reach along the facing grows with s throughout, so a stronger load always
 * moves the tip further. The middle control point takes the push that moves the curve's middle
 * ( p1 / 2 + p2 / 4 at t = 1/2 ) with the blade's own middle: 2 m - p / 2 for the middle's move m (from half the
 * rest tip) and the tip's p. The tip lies ( 0.50, 0.87 ) of the height along the facing and up at
 * rest, ( 0.68, 0.73 ) for the mean blade at the gentle level and ( 0.81, 0.56 ) at the strong. At
 * the strong level the flutter takes s from 0.40 to 0.69 (theta( 1 ) 0.94 to 1.25 rad), a full gust
 * there up to 0.70 (1.26 rad) and a full gust at the flutter's crest up to 0.80 (1.36 rad): the
 * tip then lies 0.89 of the height along the facing and 0.39 up. The tip's sway along the wind
 * (the wind probe's sigmaAlong) is 0.016, 0.043, 0.044 and 0.039 from the light level to the
 * strong: the load's share saturates, so the flutter swings s over about the same range at every
 * level past the light one, and the tip's reach grows more slowly as the blade lies down, so the
 * sway peaks at the gentle and fresh levels while its speed (the sway times the swing's rate,
 * which follows the plants' speed) rises with every level. The sway itself rises with every level
 * for a `half` of 20 or more (0.010, 0.035, 0.041 and 0.044 at 20). */
const SWING_FLUTTER = 0.3;
const SWING = { rate: 0.084, lag: Math.PI / 2, flutter: SWING_FLUTTER, half: /*@__PURE__*/ tuneUniform( 'grass.swing.half', 14.7, { min: 5, max: 40, scale: 'log' } ), rest: 0.52 };
/** The displacement field's parting (vegetation/Displacement.ts `displacementAt`), read at two
 * points along the blade's facing f before the field turns it: d_hi `high` of its height h out from
 * the root and d_lo `low` of it. The facing turns about the vertical by theta = `face` atan( h
 * cross( f, d_hi ) ), at most `turn` (rad) either way: by the push's part across it alone, so a
 * push straight along or against it does not turn it. The lean is a level vector, in tangent: the
 * blade's own lean along its turned facing plus `lean` h d_lo (RESPONSE.lean, per m, the response
 * the field's sprites are given for), at most `most` long (where trails cross, their pushes add
 * up), the chord toward ( lean, 1 ), so a push against the blade's own lean stands it up and lays
 * it over the other way through upright, never flipping it. Where something walks the blades turn
 * along the push and lie over. The two points are where the field pushes the resting blade: `high`
 * at its tip, which lies sin( atan( tan ) ) of its length out along the facing for its chord's
 * tangent tan (TILT), 0.49 on average over the blades at the height map's mean, where a push across
 * the blade has the longest lever to turn it; `low` at its middle, the curve's point at t = 1/2,
 * half that reach (0.25: the middle control point's bend falls either way at random), where a push
 * spread along the blade acts in sum, so it sets the lean. `high` and `low` are tunable at load
 * (`grass.parting.high`, `low`). */
const PARTING = {
	high: tune( 'grass.parting.high', 0.49, { min: 0.3, max: 1, load: true } )(),
	low: tune( 'grass.parting.low', 0.25, { min: 0, max: 0.4, load: true } )(),
	face: 1, turn: Math.PI / 2, lean: RESPONSE.lean, most: 15,
};
/** The blades whose middle lies within `reach` m of the eye (in space) lean away from it, their tips
 * pushed `push` of their length out along the ground, so a camera low in the meadow looks through
 * it. A camera above the sward sees them stand as they grow: with the distance along the ground
 * (and a reach of 3 m), every blade under a close look down from 1.3 m lay over away from the
 * camera's foot, its lean on screen a median of 43 degrees where the blades' own is 22
 * (tools/island/meadow-light.mjs `lean`). (The camera's position among what shapes a blade: Wohllaib
 * 05:09.) */
const NEAR = { reach: 1, push: 0.6 };
/** The LOD: from `near` / 2 m along the ground on, each doubling of the distance keeps a quarter of
 * the blades (the cells on every second row and column of the last level's, up to `levels`
 * levels), the others going out one by one over its second half, and the kept ones widen to twice
 * their width over it; each level's blades are jittered over `jitter` of its spacing (`cell`). At
 * 20 m a centimetre blade is about a render pixel wide at the baseline's 1440p in the island
 * camera's view, where the LOD used to start by the blades' size on screen; now fixed, so the
 * blades a view shows do not depend on its resolution. Off by default: thinned blades left the
 * island view's meadow sparse over its ground. On with `flags=grassLod:true` (at load). */
const LOD = { near: 40, levels: 5, jitter: 1, on: debugFlags.grassLod === true };
/** Seen side on, a blade's edges are pushed apart across the view (along view x tangent) by
 * Delta = ( w / 2 ) e ( 1 + ramp( d ) ), e = 1 - | n . v | (1 edge on, 0 face on), ramp rising
 * from 0 at its start to 1 `far` - `near` m beyond it, d the distance from the eye; the start is
 * `near` m times 0.5 to 1.5 at random per blade, so the widening does not begin on one ring. Edge
 * on, a blade shows one half width more on either side, beyond `far` two. */
const THICKEN = { near: 5, far: 25 };

// --- the ground under the meadow (TerrainMaterial.ts, SwardField.ts)

/** The ground under the meadow (TerrainMaterial.ts's meadow ground): the key's and the sky's light
 * left there under the full sward (`key`, `sky`), the share of its colour the sward darkens
 * (`darkening`), the sward's depth where the meadow grows (`tall`) and the shadow left under the
 * shortest turf (`open`). `sky` is the sky a blade's root sees (AO at the median length), so the
 * gaps render darker than the blades by their shade alone, near the eye and far alike; tunable
 * (`grass.roots.sky`, the uniform `rootsSky` the ground reads). */
export const GRASS_ROOTS = {
	key: 1, sky: 0.407,
	darkening: 0, tall: SWARD_DEPTH, open: 1,
};
export const rootsSky = /*@__PURE__*/ tuneUniform( 'grass.roots.sky', GRASS_ROOTS.sky, { min: 0.2, max: 1 } );
const SWARD_FALLBACK = SWARD_DEPTH * 0.97;

function groundTexture( ground: Float32Array, size = MEADOW_SIZE, name = 'grassGround' ): THREE.DataTexture {

	const map = new THREE.DataTexture( ground, size, size, THREE.RGBAFormat, THREE.FloatType );
	map.magFilter = map.minFilter = THREE.NearestFilter;
	map.generateMipmaps = false;
	map.name = name;
	map.needsUpdate = true;
	return map;

}

/** The ground map's node, which the blades' generation and the meadow's shade read, its value
 * swapped as the land grows (`MeadowBlades.setGround`): a texel of no turf until the meadow is
 * planted. */
const groundMap = texture( groundTexture( new Float32Array( 4 ), 1 ) );
/** The lip's map beside it, of its size and swapped with it (`MeadowBlades.setGround`): per texel
 * the rim distance at its centre, the slope of its roots' line in that distance and the farthest
 * distance out a blade over it grows to (LIP); only the blades' generation reads it. */
const lipMap = texture( groundTexture( new Float32Array( [ 0, 0, LIP.none, 0 ] ), 1, 'grassLip' ) );

/** The two height maps in a texel's A (GROUND_A): `free` of the land's edge, and `short`, as the
 * blades' lengths take it. */
function groundHeights( a: F ): { free: F; short: F } {

	const free = fract( a );
	return { free, short: free.mul( float( 1 ).sub( floor( a ).div( GROUND_A.steps ) ) ) };

}

// --- hashes (PCG's output permutation on one word: Jarzynski and Olano, "Hash Functions for GPU
// Rendering", JCGT 2020)

function pcg( n: U ): U {

	const state = n.mul( uint( 747796405 ) ).add( uint( 2891336453 ) );
	const word = state.shiftRight( state.shiftRight( uint( 28 ) ).add( uint( 4 ) ) ).bitXor( state ).mul( uint( 277803737 ) );
	return word.shiftRight( uint( 22 ) ).bitXor( word );

}

/** A stream of uniform values in [ 0, 1 ) for the word `seed`. */
function stream( seed: U ): ( k: number ) => F {

	return ( k: number ) => float( pcg( seed.add( uint( k * 0x9e3779b9 >>> 0 ) ) ).shiftRight( uint( 8 ) ) ).mul( 1 / 16777216 );

}

function cellSeed( x: U, z: U, salt: number ): U {

	return pcg( x.bitXor( pcg( z.add( uint( salt ) ) ) ) );

}

// --- the generation's GPU side

/** The blades' storage (four vec4 per blade: ( root x, y, z, height ), ( width, lean, bend,
 * offset ), ( facing x, z, clump, column ) and ( sky visibility, random, far, start ); see `scatter`),
 * the near blades first and the far ones after them, their counts (the near ones', the far ones')
 * and the two draws' arguments, the tiles of the view and the kernels that fill them. */
class MeadowBlades {

	readonly a = new THREE.StorageBufferAttribute( new Float32Array( CAPACITY * 4 ), 4 );
	readonly b = new THREE.StorageBufferAttribute( new Float32Array( CAPACITY * 4 ), 4 );
	readonly c = new THREE.StorageBufferAttribute( new Float32Array( CAPACITY * 4 ), 4 );
	readonly d = new THREE.StorageBufferAttribute( new Float32Array( CAPACITY * 4 ), 4 );
	readonly count = new THREE.StorageBufferAttribute( new Uint32Array( 4 ), 1 );
	/** The two draws' arguments: the near draw's at byte 0, the far draw's at byte 20. */
	readonly indirect = new THREE.IndirectStorageBufferAttribute( new Uint32Array( 10 ), 1 );
	// per workgroup: its near blades in the low 16 bits and its far ones in the high 16
	private readonly counts = new THREE.StorageBufferAttribute( new Uint32Array( MAX_TILES * GROUPS_PER_TILE ), 1 );
	// per workgroup: the near blades' offset, then (MAX_TILES * GROUPS_PER_TILE on) the far ones'
	private readonly offsets = new THREE.StorageBufferAttribute( new Uint32Array( 2 * MAX_TILES * GROUPS_PER_TILE ), 1 );
	private readonly tiles = new THREE.StorageBufferAttribute( new Uint32Array( MAX_TILES * 4 ), 4 );
	private readonly eye = uniform( new THREE.Vector3() );
	/** The view's direction. */
	private readonly forward = uniform( new THREE.Vector3() );
	private readonly planes = [ 0, 1, 2, 3 ].map( () => uniform( new THREE.Vector4() ) );
	private readonly groups = uniform( 0, 'uint' );
	private readonly dispatch = [ 1, 1, 1 ];
	private kernels: THREE.ComputeNode[] | null = null;
	private readonly key = new Float64Array( 24 ).fill( NaN );
	private box = new THREE.Box3();
	/** The ground map's node (`groundMap`, its value swapped as the land grows). */
	readonly ground = groundMap;
	/** The lip's map's node (`lipMap`, swapped with the ground map). */
	readonly lip = lipMap;
	readonly stats = { dispatches: 0, skipped: 0, tiles: 0 };

	constructor( map: THREE.DataTexture, lip: THREE.DataTexture, box: THREE.Box3 ) {

		this.ground.value = map;
		this.lip.value = lip;
		this.box.copy( box );
		this.indirect.array.set( [ BLADES * INDICES, 0, 0, 0, 0, BLADES * LOW_INDICES, 0, 0, 0, 0 ] );

	}

	/** Takes a new ground map, lip's map and box (a growth step); returns the old maps. */
	setGround( map: THREE.DataTexture, lip: THREE.DataTexture, box: THREE.Box3 ): THREE.Texture[] {

		const old = [ this.ground.value, this.lip.value ];
		this.ground.value = map;
		this.lip.value = lip;
		this.box.copy( box );
		this.key.fill( NaN );
		return old;

	}

	/** Read-only views of the blades for the vertex stage. */
	reads() {

		const read = <T extends 'vec4' | 'uint'>( attribute: THREE.StorageBufferAttribute, type: T, count: number ) => {

			const node = storage( attribute, type, count );
			( node as unknown as { toReadOnly(): void } ).toReadOnly();
			return node as unknown as { element( i: U ): THREE.Node<T> };

		};
		return {
			a: read( this.a, 'vec4', CAPACITY ), b: read( this.b, 'vec4', CAPACITY ), c: read( this.c, 'vec4', CAPACITY ), d: read( this.d, 'vec4', CAPACITY ),
			count: read( this.count, 'uint', 4 ),
		};

	}

	/** Generate the blades for `camera` unless the last generation was for the same view. */
	update( renderer: THREE.Renderer, camera: THREE.Camera ): void {

		if ( ! ( camera as THREE.PerspectiveCamera ).isPerspectiveCamera ) return;
		const projection = ( TEMPORAL ? unjitteredPadded( renderer, camera ) : null ) ?? camera.projectionMatrix;
		const e = camera.matrixWorld.elements, p = projection.elements, key = this.key;
		let same = true;
		const check = ( i: number, v: number ) => {

			if ( key[ i ] !== v ) {

				key[ i ] = v;
				same = false;

			}

		};
		for ( let i = 0; i < 16; i ++ ) check( i, e[ i ] );
		[ 0, 5, 8, 9, 10, 14 ].forEach( ( j, i ) => check( 16 + i, p[ j ] ) );
		if ( same ) {

			this.stats.skipped ++;
			return;

		}
		this.stats.dispatches ++;
		_projScreen.multiplyMatrices( projection, _viewInverse.copy( camera.matrixWorld ).invert() );
		_frustum.setFromProjectionMatrix( _projScreen, camera.coordinateSystem, ( camera as unknown as { reversedDepth?: boolean } ).reversedDepth );
		for ( let k = 0; k < 4; k ++ ) {

			const plane = _frustum.planes[ k ];
			this.planes[ k ].value.set( plane.normal.x, plane.normal.y, plane.normal.z, plane.constant );

		}
		_eye.setFromMatrixPosition( camera.matrixWorld );
		this.eye.value.copy( _eye );
		this.forward.value.set( - e[ 8 ], - e[ 9 ], - e[ 10 ] ).normalize();
		const n = this.selectTiles( _eye );
		this.stats.tiles = n;
		this.groups.value = n * GROUPS_PER_TILE;
		// a row of workgroups per tile: one dimension holds at most 65535 workgroups
		this.dispatch[ 0 ] = GROUPS_PER_TILE;
		this.dispatch[ 1 ] = Math.max( 1, n );
		this.kernels ??= this.buildKernels();
		renderer.compute( this.kernels );

	}

	/** The tiles over the meadow within REACH of `eye` and inside the view, near to far. */
	private selectTiles( eye: THREE.Vector3 ): number {

		const box = this.box;
		if ( box.isEmpty() ) return 0;
		const found: { i: number; j: number; d: number }[] = [];
		for ( let j = Math.floor( box.min.z / TILE ); j <= Math.floor( box.max.z / TILE ); j ++ ) for ( let i = Math.floor( box.min.x / TILE ); i <= Math.floor( box.max.x / TILE ); i ++ ) {

			_tile.min.set( i * TILE, box.min.y - FRUSTUM_PAD, j * TILE );
			_tile.max.set( ( i + 1 ) * TILE, box.max.y + FRUSTUM_PAD + TALLEST, ( j + 1 ) * TILE );
			_level.set( THREE.MathUtils.clamp( eye.x, _tile.min.x, _tile.max.x ), THREE.MathUtils.clamp( eye.z, _tile.min.z, _tile.max.z ) );
			const d = _level.distanceTo( _eyeLevel.set( eye.x, eye.z ) );
			if ( d < REACH && _frustum.intersectsBox( _tile ) ) found.push( { i, j, d } );

		}
		found.sort( ( p, q ) => p.d - q.d || p.j - q.j || p.i - q.i );
		const n = Math.min( found.length, MAX_TILES );
		const array = this.tiles.array as Uint32Array;
		for ( let t = 0; t < n; t ++ ) {

			const { i, j } = found[ t ];
			array.set( [ i + TILE_OFFSET, j + TILE_OFFSET, 0, 0 ], t * 4 );

		}
		this.tiles.needsUpdate = true;
		return n;

	}

	private buildKernels(): THREE.ComputeNode[] {

		const node = <T extends 'vec4' | 'uint' | 'uvec4'>( attribute: THREE.StorageBufferAttribute, type: T, count: number, readOnly = false ) => {

			const s = storage( attribute, type, count );
			if ( readOnly ) ( s as unknown as { toReadOnly(): void } ).toReadOnly();
			return s as unknown as { element( i: U ): THREE.Node<T> & { assign( v: THREE.Node ): void } };

		};
		const a = node( this.a, 'vec4', CAPACITY ), b = node( this.b, 'vec4', CAPACITY ), c = node( this.c, 'vec4', CAPACITY ), dd = node( this.d, 'vec4', CAPACITY );
		const counts = node( this.counts, 'uint', MAX_TILES * GROUPS_PER_TILE );
		const offsets = node( this.offsets, 'uint', 2 * MAX_TILES * GROUPS_PER_TILE );
		const tiles = node( this.tiles, 'uvec4', MAX_TILES, true );
		const total = node( this.count, 'uint', 4 );
		const args = node( this.indirect as unknown as THREE.StorageBufferAttribute, 'uint', 10 );
		const { planes, groups, ground, lip, eye } = this;

		// The ground map at ( x, z ): the bilinear weights of the four nearest texels and the texels.
		const groundAt = ( x: F, z: F ) => {

			const f = vec2( x, z ).div( MEADOW_EXTENT ).add( 0.5 ).mul( MEADOW_SIZE ).sub( 0.5 ).toVar();
			const i0 = floor( f ).toVar();
			const t = f.sub( i0 ).toVar();
			const texel = ( dx: number, dz: number ) => textureLoad( ground, ivec2( clamp( i0.add( vec2( dx, dz ) ), 0, MEADOW_SIZE - 1 ) ) ) as unknown as V4;
			const texels = [ texel( 0, 0 ).toVar(), texel( 1, 0 ).toVar(), texel( 0, 1 ).toVar(), texel( 1, 1 ).toVar() ];
			const weights = [ t.x.oneMinus().mul( t.y.oneMinus() ), t.x.mul( t.y.oneMinus() ), t.x.oneMinus().mul( t.y ), t.x.mul( t.y ) ].map( ( w ) => w.toVar() );
			// the root's height: the mean over the texels that hold turf; the sky visibility and the
			// height map, bilinear
			let sum: F = float( 0 ), weight: F = float( 0 ), sky: F = float( 0 ), map: F = float( 0 );
			texels.forEach( ( p, k ) => {

				const holds = step( 1e-9, p.y );
				sum = sum.add( weights[ k ].mul( holds ).mul( p.x ) );
				weight = weight.add( weights[ k ].mul( holds ) );
				sky = sky.add( weights[ k ].mul( p.z ) );
				map = map.add( weights[ k ].mul( groundHeights( p.w ).short ) );

			} );
			const height = sum.div( max( weight, 1e-6 ) );
			// on the lip (LIP): the rim distance here, bilinear; the roots' height, each holding
			// texel's line at that distance (inland its mean: a slope of 0); and the farthest distance
			// out a holding texel's turf reaches
			const atLip = () => {

				const lips = [ [ 0, 0 ], [ 1, 0 ], [ 0, 1 ], [ 1, 1 ] ].map( ( [ dx, dz ] ) => ( textureLoad( lip, ivec2( clamp( i0.add( vec2( dx, dz ) ), 0, MEADOW_SIZE - 1 ) ) ) as unknown as V4 ).toVar() );
				let distance: F = float( 0 );
				lips.forEach( ( q, k ) => {

					distance = distance.add( weights[ k ].mul( q.x ) );

				} );
				const d = distance.toVar();
				let rooted: F = float( 0 ), farthest: F = float( - LIP.none );
				texels.forEach( ( p, k ) => {

					const holds = step( 1e-9, p.y );
					rooted = rooted.add( weights[ k ].mul( holds ).mul( p.x.add( lips[ k ].y.mul( d.sub( lips[ k ].x ) ) ) ) );
					farthest = max( farthest, select( p.y.greaterThan( 1e-9 ), lips[ k ].z, float( - LIP.none ) ) );

				} );
				return { height: rooted.div( max( weight, 1e-6 ) ), on: d.lessThanEqual( farthest ) };

			};
			// grass where the texel picked by `pick` (0..1) with the bilinear weights holds it (one of
			// the four texels chosen at random, weighted by the position among them: Wohllaib 04:04)
			const holds = ( pick: F ) => {

				const c0 = weights[ 0 ], c1 = c0.add( weights[ 1 ] ), c2 = c1.add( weights[ 2 ] );
				const share = select( pick.lessThan( c0 ), texels[ 0 ].y, select( pick.lessThan( c1 ), texels[ 1 ].y, select( pick.lessThan( c2 ), texels[ 2 ].y, texels[ 3 ].y ) ) );
				return share.greaterThanEqual( 0.5 );

			};
			return { height, weight, holds, sky, map, atLip };

		};

		// The blade of this thread's cell: where it stands, its LOD and whether it grows (a blade per
		// cell of a tile's grid, offset at random, culled by distance and by the view: Wohllaib
		// 02:58-03:30). The cell's level (`top`) is the last LOD level whose lattice holds it (cells on
		// every 2^level-th row and column, world-anchored), and its blade is jittered over that level's
		// block of cells (LOD.jitter of it, wrapped), so the blades each level keeps are spread as
		// evenly as the full meadow's and never show the grid. The level at the blade (`level`, ℓ) is
		// the halvings that bring x = d / LOD.near into ( 0.5, 1 ] (0 nearer), d its distance along the
		// ground: the blades thin from a fixed distance, the same whatever the view's resolution. A
		// blade grows while its cell's level reaches ℓ; one that the next level leaves behind (its
		// level ℓ) goes out at a distance of its own over the second half of the doubling, narrowing
		// just before (`share`), and the ones the next level keeps widen from 2^ℓ to 2^( ℓ + 1 ) over
		// it (`scatter`). A level keeps one blade of four (Wohllaib 09:02: the near tiles drop three of
		// every four blades before the far ones take over) and doubles the width of the rest.
		const cell = () => {

			const g = workgroupId.y.mul( uint( GROUPS_PER_TILE ) ).add( workgroupId.x ), i = localId.x;
			const tile = tiles.element( ( min as unknown as UintMax )( g.shiftRight( uint( LOG2_GROUP ) ), uint( MAX_TILES - 1 ) ) );
			const block = g.bitAnd( uint( GROUPS_PER_TILE - 1 ) );
			const lx = block.bitAnd( uint( 15 ) ).mul( uint( BLOCK ) ).add( i.bitAnd( uint( 15 ) ) );
			const lz = block.shiftRight( uint( 4 ) ).mul( uint( BLOCK ) ).add( i.shiftRight( uint( 4 ) ) );
			const ix = tile.x.mul( uint( TILE_CELLS ) ).add( lx ).toVar();
			const iz = tile.y.mul( uint( TILE_CELLS ) ).add( lz ).toVar();
			const random = stream( cellSeed( ix, iz, 17 ) );
			const r = [ random( 0 ).toVar(), random( 1 ).toVar(), random( 2 ).toVar(), random( 3 ).toVar() ];
			// (TILE_OFFSET * TILE_CELLS is a power of two past LOD.levels, so the lattices are the
			// world's)
			const corner = ix.bitOr( iz );
			let levels: F = float( 0 );
			for ( let s = 1; s <= LOD.levels; s ++ ) levels = levels.add( select( corner.bitAnd( uint( ( 1 << s ) - 1 ) ).equal( uint( 0 ) ), float( 1 ), float( 0 ) ) );
			const top = ( LOD.on ? levels : float( 0 ) ).toVar();
			const spacing = exp2( top ).toVar();
			const origin = - TILE_OFFSET * TILE_CELLS;
			// the jitter: LOD.jitter of the level's spacing, less a spacing where it goes past one
			const jitter = ( u: F ) => {

				const j = u.mul( LOD.jitter );
				return j.sub( step( 1, j ) ).mul( spacing );

			};
			const x = float( ix ).add( jitter( r[ 0 ] ) ).add( origin ).mul( CELL ).toVar();
			const z = float( iz ).add( jitter( r[ 1 ] ) ).add( origin ).mul( CELL ).toVar();
			const at = groundAt( x, z );
			const p = vec3( x, at.height, z ).toVar();
			let inside = g.lessThan( groups );
			for ( const plane of planes ) inside = inside.and( dot( plane.xyz, p ).add( plane.w ).greaterThan( - FRUSTUM_PAD ) );
			const distance = length( p.xz.sub( eye.xz ) ).toVar();
			// the reach's fade: the share of its blade the cell keeps
			const keep = clamp( float( REACH ).sub( distance ).div( REACH_FADE ).sub( r[ 3 ].mul( 0.5 ) ), 0, 1 ).toVar();
			// the level ℓ and x within its doubling ( 0.5, 1 ], held at 0.5 nearer than LOD.near / 2;
			// `lod` the doublings past LOD.near / 2, continuous
			const ratio = distance.div( LOD.near ).toVar();
			const level = ( LOD.on ? clamp( ceil( log2( max( ratio, 1e-6 ) ) ), 0, LOD.levels ) : float( 0 ) ).toVar();
			const within = ( LOD.on ? max( ratio.div( exp2( level ) ), 0.5 ) : float( 0.5 ) ).toVar();
			const lod = ( LOD.on ? max( log2( ratio.mul( 2 ) ), 0 ) : float( 0 ) ).toVar();
			// a cell the next level leaves behind goes out at its own x, narrowing over a quarter of
			// the doubling before: its share of the blade sat( xi + 3 - 4x ), within the reach's
			const leaving = top.equal( level ).and( level.lessThan( LOD.levels ) ).toVar();
			const share = select( leaving, min( keep, clamp( random( 24 ).add( 3 ).sub( within.mul( 4 ) ), 0, 1 ) ), keep ).toVar();
			const grow = inside.and( at.holds( r[ 2 ] ) ).and( at.atLip().on ).and( at.map.greaterThanEqual( LENGTH.bare ) )
				.and( share.greaterThan( 0 ) ).and( top.greaterThanEqual( level ) ).toVar();
			// in the far draw from LOW.from m on (the near blades a 1 in the word's low half, the far
			// ones in its high half: `count`, `scatter`)
			const word = select( grow, select( distance.lessThan( LOW.from ), uint( 1 ), uint( 1 << 16 ) ), uint( 0 ) );
			return { g, i, ix, iz, x, z, r, random, at, grow, lod, level, within, leaving, share, word };

		};

		// Inclusive scan of one word per thread over the workgroup (Hillis-Steele, ping-ponged
		// between two arrays so each step needs one barrier).
		const scan = ( word: U ): Lanes => {

			const pair = [ workgroupArray( 'uint', GROUP ), workgroupArray( 'uint', GROUP ) ] as unknown as ( Lanes & { element( i: U ): U & { assign( v: U ): void } } )[];
			const i = localId.x;
			pair[ 0 ].element( i ).assign( word );
			for ( let s = 0; s < LOG2_GROUP; s ++ ) {

				workgroupBarrier();
				const off = 1 << s, from = pair[ s & 1 ], to = pair[ ( s + 1 ) & 1 ];
				const before = select( i.greaterThanEqual( uint( off ) ), from.element( ( max as unknown as UintMax )( i, uint( off ) ).sub( uint( off ) ) ), uint( 0 ) );
				to.element( i ).assign( from.element( i ).add( before ) );

			}
			workgroupBarrier();
			return pair[ LOG2_GROUP & 1 ];

		};

		const count = Fn( () => {

			const { g, i, word } = cell();
			const sums = scan( word );
			If( i.equal( uint( GROUP - 1 ) ), () => {

				counts.element( g ).assign( sums.element( uint( GROUP - 1 ) ) );

			} );

		} )().computeKernel( [ GROUP ] );

		// One workgroup: each thread sums a run of the workgroups' counts, near and far, the runs are
		// scanned, and each thread writes its run's offsets (the far ones' from the far segment's
		// start, which follows the near blades); the last writes the counts and the draws' arguments
		// (the blades counted in a compute pass and the count moved into an indirect draw's arguments
		// by a second: Wohllaib 06:51-07:23; the scan is ours, so the list's order never varies).
		const RUN = MAX_TILES * GROUPS_PER_TILE / GROUP;
		const offsetsKernel = Fn( () => {

			const i = localId.x;
			const first = i.mul( uint( RUN ) ).toVar();
			const counted = ( e: U ) => select( e.lessThan( groups ), counts.element( e ), uint( 0 ) );
			const nearOf = ( w: U ) => w.bitAnd( uint( 0xffff ) ), farOf = ( w: U ) => w.shiftRight( uint( 16 ) );
			const runNear = uint( 0 ).toVar(), runFar = uint( 0 ).toVar();
			Loop( { start: uint( 0 ), end: uint( RUN ), type: 'uint', condition: '<' }, ( { i: k } ) => {

				const w = counted( first.add( k ) ).toVar();
				runNear.addAssign( nearOf( w ) );
				runFar.addAssign( farOf( w ) );

			} );
			const inclusiveNear = scan( runNear ).element( i ).toVar();
			const inclusiveFar = scan( runFar ).element( i ).toVar();
			const atNear = inclusiveNear.sub( runNear ).toVar(), atFar = inclusiveFar.sub( runFar ).toVar();
			Loop( { start: uint( 0 ), end: uint( RUN ), type: 'uint', condition: '<' }, ( { i: k } ) => {

				const e = first.add( k );
				const w = counted( e ).toVar();
				offsets.element( e ).assign( atNear );
				offsets.element( e.add( uint( MAX_TILES * GROUPS_PER_TILE ) ) ).assign( atFar );
				atNear.addAssign( nearOf( w ) );
				atFar.addAssign( farOf( w ) );

			} );
			If( i.equal( uint( GROUP - 1 ) ), () => {

				const near = ( min as unknown as UintMax )( inclusiveNear, uint( CAPACITY ) ).toVar();
				const far = ( min as unknown as UintMax )( inclusiveFar, uint( CAPACITY ).sub( near ) ).toVar();
				total.element( uint( 0 ) ).assign( near );
				total.element( uint( 1 ) ).assign( far );
				args.element( uint( 0 ) ).assign( uint( BLADES * INDICES ) );
				args.element( uint( 1 ) ).assign( near.add( uint( BLADES - 1 ) ).div( uint( BLADES ) ) );
				args.element( uint( 5 ) ).assign( uint( BLADES * LOW_INDICES ) );
				args.element( uint( 6 ) ).assign( far.add( uint( BLADES - 1 ) ).div( uint( BLADES ) ) );

			} );

		} )().computeKernel( [ GROUP ] );

		// The clump at ( x, z ): the nearest of the jittered points around it, one per CLUMP.size cell
		// of a world-anchored grid (the nine cells around), its centre, how near the blade stands to
		// it (1 at the centre, 0 at about the clump's edge) and its own random stream. (Clumps as a
		// Voronoi of the nearest nine jittered points, setting the blades' height and direction and
		// drawing them toward the centre: Wohllaib 05:43-06:51.)
		const clumpAt = ( x: F, z: F ) => {

			const cx = floor( x.div( CLUMP.size ) ).toVar(), cz = floor( z.div( CLUMP.size ) ).toVar();
			const nearest = vec3( 0, 0, 1e9 ).toVar();
			const seed = uint( 0 ).toVar();
			for ( let dz = - 1; dz <= 1; dz ++ ) for ( let dx = - 1; dx <= 1; dx ++ ) {

				const gx = cx.add( dx ), gz = cz.add( dz );
				const own = cellSeed( uint( int( gx ).add( 1 << 15 ) ), uint( int( gz ).add( 1 << 15 ) ), 29 ).toVar();
				const jitter = stream( own );
				const point = vec2( gx.add( jitter( 0 ) ), gz.add( jitter( 1 ) ) ).mul( CLUMP.size ).toVar();
				const d2 = dot( point.sub( vec2( x, z ) ), point.sub( vec2( x, z ) ) ).toVar();
				If( d2.lessThan( nearest.z ), () => {

					nearest.assign( vec3( point, d2 ) );
					seed.assign( own );

				} );

			}
			const near = float( 1 ).sub( smoothstep( 0, CLUMP.size * 0.7, sqrt( nearest.z ) ) );
			// (the point's jitter took the clump's randoms 0 and 1; xi_clump the mean of the next three)
			const random = stream( seed );
			const mean = random( 2 ).add( random( 3 ) ).add( random( 4 ) ).div( 3 );
			return { centre: nearest.xy, near: CLUMP.on ? near : float( 0.5 ), mean: CLUMP.on ? mean : float( 0.5 ), random };

		};

		// The blade's sixteen numbers (four vec4, read by `bladeVertex`; a record of floats per blade
		// instance: Wohllaib 04:37):
		//   a ( root x, y, z, height )          the root, drawn into its clump, and the height (m)
		//   b ( width, lean, bend, offset )      the width (m: the LOD's widening and the blade's share
		//                                        in it), the lean (the tangent of the chord's angle
		//                                        from upright), the bend and the tip's offset across
		//                                        (shares of the height, signed)
		//   c ( facing x, z, clump, column )     the facing's static sum (not normalised), the
		//                                        nearness to the clump's centre and the colour column
		//                                        (0 column a, 1 column b: BLADE_COLOUR)
		//   d ( sky, random, far, start )        the anchors' sky visibility, the blade's own random
		//                                        (the sway's phase), how far the LOD has gone (0 near,
		//                                        1 from two levels on) and a second random (0 to 1)
		//                                        for three things: the start of the side view's
		//                                        widening (THICKEN), the same start of the gloss's
		//                                        lowering with distance (SURFACE.farGloss rides
		//                                        THICKEN's ramp) and how much earlier the blade morphs
		//                                        into the far draw's shape (LOW.spread)
		// The bend's middle share is a constant of the blade's curve (BEND.middle), and a blade folds
		// by its height (LENGTH.fold).
		const scatter = Fn( () => {

			const blade = cell();
			const { g, i, grow, word } = blade;
			// the blade's place: among the near blades, or in the far segment after them all
			const sums = scan( word ).element( i ).toVar();
			const isNear = word.equal( uint( 1 ) );
			const nearPlace = offsets.element( g ).add( sums.bitAnd( uint( 0xffff ) ) ).sub( uint( 1 ) );
			const farRank = offsets.element( g.add( uint( MAX_TILES * GROUPS_PER_TILE ) ) ).add( sums.shiftRight( uint( 16 ) ) ).sub( uint( 1 ) );
			const place = select( isNear, nearPlace, total.element( uint( 0 ) ).add( farRank ) ).toVar();
			const room = select( isNear, total.element( uint( 0 ) ), total.element( uint( 0 ) ).add( total.element( uint( 1 ) ) ) );
			If( grow.and( place.lessThan( room ) ), () => {

				const { random, at, lod, level, within, leaving, share } = blade;
				const u = ( k: number ) => random( 4 + k );
				const clump = clumpAt( blade.x, blade.z );
				// the clump's term in the height and the width: positive about its centre, negative
				// toward its edge
				const centred = clump.near.mul( clump.mean ).sub( 0.25 ).toVar();
				// the root, drawn toward the clump's centre
				const pull = CLUMP.on ? clamp( clump.near.mul( CLUMP.pull ).mul( u( 6 ) ).mul( clump.mean ), 0, 1 ) : float( 0 );
				const pulled = mix( vec2( blade.x, blade.z ), clump.centre, pull ).toVar();
				// (drawn no further out than the lip's turf: off it, the root stays at its cell's point)
				const root = select( groundAt( pulled.x, pulled.y ).atLip().on, pulled, vec2( blade.x, blade.z ) ).toVar();
				const y = groundAt( root.x, root.y ).atLip().height.toVar();
				const height = clamp( centred.mul( LENGTH.vary ).add( at.map ).mul( LENGTH.full ).mul( u( 0 ).mul( LENGTH.mix ).add( 1 - LENGTH.mix ) ), LENGTH.least, TALLEST ).toVar();
				const lean = u( 2 ).mul( 1.4 ).add( 0.3 ).mul( TILT.lean ).mul( at.map.mul( 0.25 ).add( 1 ) );
				const bend = u( 3 ).add( 0.5 ).mul( BEND.arch ).mul( select( u( 4 ).lessThan( 0.5 ), float( - 1 ), float( 1 ) ) );
				const offset = u( 5 ).mul( 2 ).sub( 1 ).mul( BEND.offset );
				// the facing's static sum: the blade's own, out from its clump's centre, the clump's own
				// way and down the slope (the ground's normal's level part, from the ground map's heights
				// a texel to either side; a side without turf takes the root's)
				const side = ( dx: number, dz: number ) => {

					const g = groundAt( root.x.add( dx ), root.y.add( dz ) );
					return select( g.weight.greaterThan( 1e-6 ), g.height, y );

				};
				const texel = MEADOW_EXTENT / MEADOW_SIZE;
				const rise = vec2( side( texel, 0 ).sub( side( - texel, 0 ) ), side( 0, texel ).sub( side( 0, - texel ) ) ).div( 2 * texel ).toVar();
				const slope = rise.negate().div( sqrt( dot( rise, rise ).add( 1 ) ) );
				const out = vec2( blade.x, blade.z ).sub( clump.centre ).toVar();
				const outward = out.div( max( length( out ), 1e-4 ) ).mul( CLUMP.on ? clump.mean.mul( FACING.out ) : float( 0 ) );
				const clumpWay = vec2( clump.random( 6 ), clump.random( 7 ) ).mul( 2 ).sub( 1 ).mul( CLUMP.on ? clump.near.mul( FACING.clump ) : float( 0 ) );
				const facing = vec2( u( 7 ), u( 8 ) ).mul( 2 ).sub( 1 ).add( outward ).add( clumpWay ).add( slope.mul( FACING.slope ) );
				// the width: the blade's own, the clump's, the LOD's (2^ℓ, and for a blade the next level
				// keeps 2x more, so it doubles over the doubling) and its share (the reach's fade, and a
				// leaving blade's narrowing)
				const widen = exp2( level ).mul( select( leaving, float( 1 ), within.mul( 2 ) ) );
				const width = u( 1 ).mul( WIDTH.vary ).add( WIDTH.least ).mul( centred.mul( WIDTH.clump ).add( 1 ) ).mul( WIDTH.scale ).mul( widen ).mul( share );
				const far = smoothstep( 0, 2, lod );
				const column = CLUMP.on ? select( clump.random( 5 ).lessThan( CLUMP.column ), float( 1 ), float( 0 ) ) : float( 0 );
				a.element( place ).assign( vec4( root.x, y, root.y, height ) );
				b.element( place ).assign( vec4( width, lean, bend, offset ) );
				c.element( place ).assign( vec4( facing, clump.near, column ) );
				dd.element( place ).assign( vec4( at.sky, u( 9 ), far, u( 10 ) ) );

			} );

		} )().computeKernel( [ GROUP ] );

		count.dispatchSize = this.dispatch;
		scatter.dispatchSize = this.dispatch;
		offsetsKernel.dispatchSize = [ 1, 1, 1 ];
		count.setName( 'grass.count' );
		offsetsKernel.setName( 'grass.offsets' );
		scatter.setName( 'grass.scatter' );
		return [ count, offsetsKernel, scatter ];

	}

}

const _projScreen = new THREE.Matrix4(), _viewInverse = new THREE.Matrix4(), _frustum = new THREE.Frustum();
const _eye = new THREE.Vector3(), _tile = new THREE.Box3(), _level = new THREE.Vector2(), _eyeLevel = new THREE.Vector2();

// --- the blade in the vertex stage

interface BladeVertex { position: V3; normal: V3; along: F; ao: F; column: F; far: F; winding: F; lean?: V2 }

/** A blade's facing (world x, z, unit) under the wind state `wind`: its facing's static sum `sum`
 * (`scatter`) plus POSE.wind times the wind's heading, normalised (POSE). The heading is the
 * weather's, the same over the whole meadow, so the blades turn with it. (The blades' facing taken
 * from the wind: Wohllaib 12:54.) */
function bladeFacing( wind: WindState, sum: V2 ): V2 {

	const toward = sum.add( wind.direction.mul( POSE.wind ) );
	return toward.div( max( length( toward ), 1e-4 ) );

}

/** A blade's sway s at `t` along it (0 root, 1 tip) on its `phase` (0..1), under the gust `gust`
 * at its root (Wind.ts `gustAt`; SWING). (A sine's bob, its phase from each blade's hash and the
 * place along the blade: Wohllaib 12:54-13:27.) */
function swingAt( wind: WindState, phase: F, t: F, gust: F ): F {

	const flutter = wave( wind.plantClock, SWING.rate, phase.mul( TAU ).sub( t.mul( SWING.lag ) ) );
	const u = windStrength( wind, gust ).mul( flutter.mul( SWING.flutter ).add( 1 ) ).div( SWING.half.mul( 1 + wind.response.gustGain * GUST_MEAN ) );
	const q = u.mul( u );
	return q.div( q.add( 1 ) );

}

/** The three-point Gauss-Legendre rule on [ 0, 1 ]: its nodes and weights. */
const GAUSS = [ [ 0.5 - 0.5 * Math.sqrt( 0.6 ), 5 / 18 ], [ 0.5, 4 / 9 ], [ 0.5 + 0.5 * Math.sqrt( 0.6 ), 5 / 18 ] ];

/** The point `a` along the blade bent by the turning `delta` (SWING): the integral of ( sin theta,
 * cos theta ) from the root to `a`, ( along the facing, up ), as plain nodes; each node's share of
 * the turning, 1 - ( 1 - x )^3, is a constant. */
const bladePoint = ( delta: F, a: number ): V2 => {

	let sum: V2 | undefined;
	for ( const [ node, weight ] of GAUSS ) {

		const x = a * node;
		const angle = delta.mul( 1 - ( 1 - x ) ** 3 ).add( SWING.rest );
		const term = vec2( sin( angle ), cos( angle ) ).mul( weight * a );
		sum = sum ? sum.add( term ) : term;

	}
	return sum!;

};
const REST_TIP = [ Math.sin( SWING.rest ), Math.cos( SWING.rest ) ];

/** The pushes for a sway s on the blade bent from its root (SWING), over the blade's height, each
 * ( along the facing, down ): `tip` the tip's, `middle` the middle control point's. */
const swingPush = ( s: F ): { tip: V2; middle: V2 } => {

	const delta = s.mul( Math.PI / 2 - SWING.rest );
	const tip = bladePoint( delta, 1 );
	const middle = bladePoint( delta, 0.5 );
	const tipPush = vec2( tip.x.sub( REST_TIP[ 0 ] ), float( REST_TIP[ 1 ] ).sub( tip.y ) );
	const middleMove = vec2( middle.x.sub( REST_TIP[ 0 ] / 2 ), float( REST_TIP[ 1 ] / 2 ).sub( middle.y ) );
	return { tip: tipPush, middle: middleMove.mul( 2 ).sub( tipPush.mul( 0.5 ) ) };

};

/** The vertex of the blade drawn at this instance and vertex index, under the wind state `wind`
 * and the displacement field of the frame being drawn (or with `previous` of the previous frame):
 * plain nodes (no function), so its values can reach varyings. After Wohllaib: vertices made from
 * the index and instance alone, 15 a blade (07:56); a short blade folded into two leaves (09:36,
 * an idea the talk credits to Outerra); a quadratic Bezier whose tip the tilt and facing place and
 * whose middle control point the bend pushes off the chord, the width the same along the blade and
 * stepped along the axis square to the facing, the normal the curve's derivative crossed with that
 * axis (10:09-11:49); edge-on blades thickened across the view (14:00). */
function bladeVertex( reads: ReturnType<MeadowBlades[ 'reads' ]>, wind: WindState, previous = false, lowLod = false ): BladeVertex {

	const verts = lowLod ? LOW.verts : VERTS;
	const shape = shapeOf( verts ), lowShape = shapeOf( LOW.verts );
	const local = vertexIndex.div( uint( verts ) );
	const k = vertexIndex.sub( local.mul( uint( verts ) ) );
	// (the far draw's blades follow the near ones in the list)
	const nearCount = reads.count.element( uint( 0 ) );
	const index = instanceIndex.mul( uint( BLADES ) ).add( local ).add( lowLod ? nearCount : uint( 0 ) );
	const live = index.lessThan( lowLod ? nearCount.add( reads.count.element( uint( 1 ) ) ) : nearCount );
	const at = ( min as unknown as UintMax )( index, uint( CAPACITY - 1 ) );
	const A = reads.a.element( at ), B = reads.b.element( at ), C = reads.c.element( at ), D = reads.d.element( at );
	// the leaf, its row and its side (`bladeGeometry`): a single blade's segments from the root
	// (seven near, three far, then the tip), or a folded blade's first leaf from its tip to the root
	// (rows 0 - 4 near, the longer leaf; rows 0 - 1 far, the shorter) and its second from the root
	// to its tip (the rest and the tip), the root's row shared
	const L = A.w.toVar();
	const folded = L.lessThan( LENGTH.fold );
	const row = float( k.shiftRight( uint( 1 ) ) ).toVar();
	const R = shape.root, n = shape.segments;
	const first = folded.and( row.lessThan( R ) );
	const second = folded.and( row.greaterThan( R ) );
	// the longer leaf and the shorter: near the first and the second, far the other way round
	const longer = lowLod ? second : first, shorter = lowLod ? first : second;
	const j = select( first, float( R ).sub( row ), select( second, row.sub( R ), select( folded, float( 0 ), row ) ) );
	const segments = select( first, float( R ), select( second, float( n - R ), float( n ) ) );
	let u: F = j.div( segments );
	// how open the shorter leaf's tip row is: the far draw's stays open (LOW), the near draw's opens
	// over the morph into it, so the hand-over keeps the leaf's shape
	let tipOpen: F = select( first, float( 1 ), float( 0 ) );
	if ( ! lowLod ) {

		// near the far draw, each row moves to the far draw's row it rounds to, so the near blade
		// takes the far one's shape before the far draw takes it over (LOW)
		// (the near draw's first leaf is the longer, the far draw's second)
		const lowSegments = select( first, float( lowShape.segments - lowShape.root ), select( second, float( lowShape.root ), float( lowShape.segments ) ) );
		const lowU = floor( u.mul( lowSegments ).add( 0.5 ) ).div( lowSegments );
		const away = length( A.xz.sub( cameraPosition.xz ) );
		const morph = clamp( away.add( D.w.mul( LOW.spread ) ).sub( LOW.start ).div( LOW.width ), 0, 1 );
		u = mix( u, lowU, morph );
		tipOpen = select( second, morph, float( 0 ) );

	}
	const t = select( folded, float( 1 ).sub( u.oneMinus().mul( u.oneMinus() ) ), u.mul( ROWS.to - ROWS.from ).add( ROWS.from ) ).toVar();
	const side = select( k.bitAnd( uint( 1 ) ).equal( uint( 1 ) ), float( 1 ), float( - 1 ) );
	const split = select( longer, float( FOLD.split ), select( shorter, float( - FOLD.split ), float( 0 ) ) );
	const bend = select( folded, float( FOLD.bend ), float( 1 ) );
	// the gust at the root moved by the blade's own offset, so a gust's edge frays (Wind.ts
	// `gustJitter`)
	const root = A.xyz;
	const gust = gustAt( wind, root.xz.add( gustJitter( wind, root.xz ) ) ).toVar();
	// the displacement field's parting, read along the facing before the field turns it (PARTING)
	const unparted = bladeFacing( wind, C.xy ).toVar();
	const high = displacementAt( root.xz.add( unparted.mul( L.mul( PARTING.high ) ) ), previous ).toVar();
	const low = displacementAt( root.xz.add( unparted.mul( L.mul( PARTING.low ) ) ), previous ).toVar();
	// the leaf's frame: its facing, turned by the push across it (a folded leaf's turned to its side
	// of the blade's, level; the shared root's row the blade's own), up and the width's axis, level
	// across the facing
	const turn = clamp( atan( L.mul( unparted.x.mul( high.y ).sub( unparted.y.mul( high.x ) ) ) ).mul( PARTING.face ), - PARTING.turn, PARTING.turn ).toVar();
	const ca = cos( turn ), sa = sin( turn );
	const facing = vec2( unparted.x.mul( ca ).sub( unparted.y.mul( sa ) ), unparted.x.mul( sa ).add( unparted.y.mul( ca ) ) ).toVar();
	const blade = vec3( facing.x, 0, facing.y );
	const leaf = blade.add( vec3( facing.y.negate(), 0, facing.x ).mul( split ) );
	const f = normalize( leaf ).toVar();
	const up = vec3( 0, 1, 0 );
	const across = vec3( f.z.negate(), 0, f.x ).toVar();
	// the leaf's lean, a level vector in tangent: its own along its facing plus the push (PARTING)
	const own = vec2( f.x, f.z ).mul( B.y ).add( low.mul( L.mul( PARTING.lean ) ) );
	const leans = own.mul( min( float( 1 ), float( PARTING.most ).div( max( length( own ), 1e-6 ) ) ) ).toVar();
	const tilt = atan( length( leans ) ).toVar();
	// the leaf's curve, a quadratic Bezier from the root: the tip along the chord at the tilt, set
	// across by the tip's offset; the middle control point BEND.middle of the way to the tip, pushed
	// off the chord by the bend along the unit normal to the chord square to the width's axis (up
	// positive), below it for a positive bend. The chord never lies level, so neither degenerates.
	const chord = normalize( vec3( leans.x, 1, leans.y ) ).toVar();
	const lift = normalize( cross( across, chord ) );
	// the sway pushes the control points before the curve is taken (SWING): the tip and the middle
	// as the bent blade's tip and middle move, forward and down
	const push = swingPush( swingAt( wind, D.y, t, gust ) );
	const tipPush = push.tip.mul( L ).toVar(), middlePush = push.middle.mul( L ).toVar();
	const tip = chord.add( across.mul( B.w ) ).mul( L ).toVar();
	const p1 = tip.mul( BEND.middle ).sub( lift.mul( B.z.mul( bend ).mul( L ) ) ).add( f.mul( middlePush.x ) ).sub( up.mul( middlePush.y ) ).toVar();
	const p2 = tip.add( f.mul( tipPush.x ) ).sub( up.mul( tipPush.y ) ).toVar();
	const s = t.oneMinus();
	const curve = p1.mul( s.mul( t ).mul( 2 ) ).add( p2.mul( t.mul( t ) ) );
	const T = normalize( p1.mul( s ).add( p2.sub( p1 ).mul( t ) ) ).toVar();
	// the width's axis across the curve (the leaf's, made square to the tangent, so a bend keeps
	// its width round the bend) and the normal, the axis crossed with the tangent (the upper face)
	const wide = normalize( across.sub( T.mul( dot( T, across ) ) ) ).toVar();
	const face = normalize( cross( wide, T ) );
	// the push away from a near eye
	// (the eye's distance from the leaf's middle, in space: NEAR)
	const away = root.xz.sub( cameraPosition.xz ).toVar();
	const near = length( root.add( chord.mul( L.mul( 0.5 ) ) ).sub( cameraPosition ) );
	const shove = vec3( away.x, 0, away.y ).div( max( length( away ), 1e-3 ) ).mul( smoothstep( NEAR.reach, 0, near ).mul( NEAR.push ).mul( L ) ).toVar();
	const pushed = shove.mul( t.mul( t ) );
	// the width: the same along the leaf, closed at its tip (t = 1: a single blade's last vertex, a
	// folded blade's first row and last vertex), except the shorter leaf's tip row, open by `tipOpen`
	// (the far draw's open, the near draw's opening over the morph); seen side on, its edges pushed
	// apart across the view (THICKEN), the more the farther the blade
	const half = B.x.mul( 0.5 ).mul( select( t.greaterThanEqual( 1 ), tipOpen, float( 1 ) ) );
	const centre = A.xyz.add( curve ).add( pushed ).toVar();
	const toEye = cameraPosition.sub( centre ).toVar();
	const distance = length( toEye ).toVar();
	const square = cross( toEye, T ).toVar();
	const view = square.div( max( length( square ), 1e-6 ) ).toVar();
	// (the push's way along the view's axis that carries each edge outward, on its own side)
	const outward = select( dot( wide, view ).greaterThanEqual( 0 ), float( 1 ), float( - 1 ) );
	const edge = float( 1 ).sub( abs( dot( face, toEye.div( max( distance, 1e-6 ) ) ) ) );
	const start = D.w.add( 0.5 ).mul( THICKEN.near );
	const ramp = clamp( distance.sub( start ).div( THICKEN.far - THICKEN.near ), 0, 1 );
	const thicken = view.mul( outward ).mul( edge.mul( ramp.add( 1 ) ) );
	const position = centre.add( wide.add( thicken ).mul( half.mul( side ) ) );
	// the occlusion along the leaf (AO): deeper at a tall blade's root, none on its top third, far
	// flattened toward its mean along the blade; times the sky the anchors see, raised toward the tip
	const deep = mix( float( AO.short ), float( AO.tall ), smoothstep( AO.lengths[ 0 ], AO.lengths[ 1 ], A.w ) );
	const rise = min( t.add( aoRise ), 1 );
	const height = mix( deep.add( deep.oneMinus().mul( rise.mul( rise ) ) ), deep.add( deep.oneMinus().mul( 0.75 ) ), D.z );
	const tipward = t.mul( t ).mul( aoTipLift );
	let ao: F = height.mul( D.x.add( D.x.oneMinus().mul( tipward ) ) );
	if ( ! CANOPY_SHADE ) {

		// the grove's canopy over the root, taken relative to the tip (`aoCanopy`): 1 on the open meadow
		const g = float( 1 ).sub( aoCanopy.mul( soilGroveAt( root.xz ) ) ).toVar();
		ao = ao.mul( g.add( g.oneMinus().mul( tipward ) ).div( g.add( g.oneMinus().mul( aoTipLift ) ) ) );

	}
	const normal = normalize( face.add( wide.mul( side.mul( SURFACE.round ) ) ) );
	// the first leaf of a folded blade runs from its tip to the root on the strip, so its triangles
	// wind the other way: -1 there (0 on the shared root's row, which only the sign of its
	// interpolation reads), 1 elsewhere, for the material's face (`grassMaterial`)
	const winding = select( first, float( - 1 ), select( folded.and( row.equal( R ) ), float( 0 ), float( 1 ) ) );
	// (`grassMask:lean`) the leaf's lean as drawn, its chord from the root to the tip with the sway and
	// the push, and its pose's tilt alone, in degrees from upright
	let lean: V2 | undefined;
	if ( GRASS_MASK_LEAN ) {

		const atTip = swingPush( swingAt( wind, D.y, float( 1 ), gust ) ).tip.mul( L );
		const drawn = tip.add( f.mul( atTip.x ).sub( up.mul( atTip.y ) ) ).add( shove );
		lean = vec2( acos( clamp( drawn.y.div( max( length( drawn ), 1e-6 ) ), - 1, 1 ) ), tilt ).mul( 1 / DEG );

	}
	// (the clump's column, 0 or 1, and the gloss's ramp with the distance, THICKEN's, in one value:
	// 2 column + ramp, `grassMaterial`; the position as WGSL's select, render's `selectVec3`)
	return { position: selectVec3( live, position, vec3( 0 ) ), normal, along: t, ao, column: C.w.mul( 2 ).add( ramp ), far: D.z, winding, lean };

}

// --- the material

/** The blades' albedo (linear) in two columns, `a` and `b`, a clump taking one (CLUMP.column):
 * each a set of key colours along the blade's length at the root, the middle and the tip, nearly
 * flat (the middle a shade darker; the root's darkness is the occlusion's, AO, not the colour's,
 * so its hue holds in every light), at the lawn's gain over LAWN_GAIN. Column `a` a deep olive
 * green of value about 0.08, its red 0.65 of its green at the root to 0.8 at the tip and its blue
 * about an eighth, so the sunlit meadow stays green and never goes grey or blue in the distance;
 * column `b` the same a little warmer (red 6 % up, blue 10 % down), so the clumps differ only
 * slightly. No shade across the blade: a blade about a centimetre wide is under a render pixel
 * in the game's views. (The colour along the blade's length, chosen per clump between two
 * columns, the clumps' colours kept close: Wohllaib 15:06-15:40.) */
const COLUMN_A = { root: [ 0.0619, 0.0952, 0.0114 ], middle: [ 0.0572, 0.0842, 0.0101 ], tip: [ 0.0754, 0.0943, 0.0094 ] };
const COLUMN_B = { red: 1.06, blue: 0.9 };
const warmer = ( c: number[] ) => [ c[ 0 ] * COLUMN_B.red, c[ 1 ], c[ 2 ] * COLUMN_B.blue ];
const PARTS = [ 'root', 'middle', 'tip' ] as const;
const BLADE_COLOUR = { a: COLUMN_A, b: { root: warmer( COLUMN_A.root ), middle: warmer( COLUMN_A.middle ), tip: warmer( COLUMN_A.tip ) } };
// Column b's red and blue factors are tunable (`grass.columnB.red`, `.blue`): the blades read
// column b's colours from uniforms worked out here, the numbers they read as constants at the
// defaults.
const columnBColour = Object.fromEntries( PARTS.map( ( part ) => [ part, uniform( new THREE.Vector3() ) ] ) ) as Record<typeof PARTS[ number ], THREE.UniformNode<'vec3', THREE.Vector3>>;
const recolourColumnB = () => {

	for ( const part of PARTS ) {

		BLADE_COLOUR.b[ part ] = warmer( COLUMN_A[ part ] );
		columnBColour[ part ].value.fromArray( BLADE_COLOUR.b[ part ] );

	}

};
tuneApply( 'grass.columnB.red', COLUMN_B.red, { min: 0.9, max: 1.2 }, ( r ) => { COLUMN_B.red = r; recolourColumnB(); } );
tuneApply( 'grass.columnB.blue', COLUMN_B.blue, { min: 0.7, max: 1.1 }, ( b ) => { COLUMN_B.blue = b; recolourColumnB(); } );
/** The occlusion along a blade, [ a + ( 1 - a ) min( t + 0.3, 1 )^2 ] [ s + ( 1 - s ) 0.3 t^2 ]:
 * a, at the root, `short` for a blade of `lengths[ 0 ]` m or shorter and `tall` from
 * `lengths[ 1 ]` m, rising to none by seven tenths of the length (the top third unoccluded); s
 * the sky its anchors see, raised toward the tip, which stands above its neighbours. (Occlusion
 * and light through the blade given as values along its length, the occlusion dark at the base
 * where other blades hide the light: Wohllaib 16:13.) Under a grove, times the canopy's share
 * (`aoCanopy`, `grass.ao.canopy`). */
const AO = { short: 0.6, tall: 0.35, lengths: [ 0.2, 0.8 ] };
/** The occlusion's rise along the blade and the tip's lift, the two 0.3 of AO's law, tunable
 * (`grass.ao.rise`, `grass.ao.tipLift`), uniforms. */
const aoRise = /*@__PURE__*/ tuneUniform( 'grass.ao.rise', 0.3, { min: 0, max: 0.7 } );
const aoTipLift = /*@__PURE__*/ tuneUniform( 'grass.ao.tipLift', 0.3, { min: 0, max: 1 } );
/** Under a grove the sward is shaded from root to tip by the canopy as well. Where the
 * materials read the ambient volume (lighting/AmbientSample.ts CANOPY_SHADE false) the anchors' sky
 * s leaves the canopy out, since the probe a blade reads already sees it, at about the tips'
 * height: so the canopy's share g = 1 - u d (d the groves' density at the root, the soil map's
 * second layer: materials/Soil.ts; u `grass.ao.canopy`, the share a full grove hides, GROVES
 * `shade` by default, as `groveSky` gives) is a factor of its own, raised toward the tip as s is,
 * and divided by its value at the tip, [ g + ( 1 - g ) 0.3 t^2 ] / [ g + ( 1 - g ) 0.3 ]: the
 * factor is 1 at the tip, which keeps the volume's light alone, and about 0.56 at a root under a
 * full grove (0.8 stop below a root on the open meadow against its tip), the canopy not counted
 * twice. On the open meadow (d 0), or at u 0, g is exactly 1 and the occlusion the same number
 * as without it. Under CANOPY_SHADE s holds the canopy already and this is left out. */
const aoCanopy = /*@__PURE__*/ tuneUniform( 'grass.ao.canopy', GROVES.shade, { min: 0, max: 0.95 } );
/** The light through a blade: its translucency t (VegetationLighting's) is `mask` ( `root` +
 * ( `tip` - `root` ) h ), a straight line in the position along the blade h (0 root, 1 tip; far off
 * flattened to its value at 0.6 of the way, as the colours are), so the tip lets through 1.5 times
 * what the root does; `mask` is the grass's own share of the light it lets through, 0.92, set in
 * our scenes. The blade's diffuse wraps round to its far side by smoothstep( 0, 0.55, t ),
 * whole along the whole blade (t is at least 0.55, the ramp's end: lighting/AmbientSample.ts WRAP_WHOLE), so a lit sward reads as one soft surface
 * from root to tip; through it (`light.extra`, Material.ts `transmission`: from behind the blade's
 * face, its forward lobe weighted by saturate( 2 t - 1 ), 0.11 at the root and 0.66 at the tip) t of
 * the diffuse, tinted `tint` (light through a leaf comes out yellower). The same t floors the
 * blades' screen-space shade (post/MeadowShadows.ts `meadowShadowFloor`) and weights the ambient
 * volume's light (lighting/AmbientSample.ts): toward the tip it flattens, brightens and turns a
 * little toward the light from behind. */
const TRANSLUCENCY = { mask: 0.922, root: 0.6, tip: 0.9, tint: [ 1.15, 1, 0.55 ] };
/** TRANSLUCENCY.mask, tunable (`grass.translucency.mask`), a uniform. */
const translucencyMask = /*@__PURE__*/ tuneUniform( 'grass.translucency.mask', TRANSLUCENCY.mask, { min: 0.5, max: 1 } );
/** The surface: its normals leaned out toward its edges (`round`: the edge's lean, against the
 * face's 1), so the light falls across a blade in a soft ramp, not a hard fold; its roughness
 * close up, the gloss ( 1 - roughness ) lowered by `farGloss` of itself with the distance (the
 * ramp of THICKEN: from 0 at a start random per blade to 1 twenty metres on), so the blades'
 * sub-pixel normals do not glint far off (`farGloss` 0.75 takes 0.4 to 0.85); and far off (two LOD levels on), its normal pulled `flatten` of the way to the ground's
 * up, as a clump's, so the blades' sub-pixel normals do not glint. `round` 0.3 leans the edges
 * about 17 degrees: under the wrapped key (VegetationLighting.ts) a blade's half toward the light
 * takes 1.28 times the other's light at 45 degrees of incidence and 1.41 at 60, a soft ramp, 1.3
 * to 1.45 on screen, where 0.45 (24 degrees) took 1.43 and 1.65. It shows close
 * up: from the game's views a blade is narrower than a pixel, and the change moved the sunlit
 * sward's light and lit share there by under 1 % (tools/island/meadow-light.mjs). Its specular reflectance
 * (`f0`, the sky's reflection and the key's glint alike) is a leaf's waxy cuticle's, well under the
 * 0.04 of three's default: at 0.04 the sky's reflection gave the sunlit blades close up a linear
 * B/G of 0.27, a blue sheen, where a B/G of 0.16 to 0.26 reads as a leaf; 0.016 took it to 0.2, and 0.01 to
 * 0.2 to 0.24 with a narrower lobe, where the reflection at grazing angles (whole, whatever `f0`)
 * keeps half the sunlit blades' blue. A `roughness` of 0.4 draws the key's highlight as a streak
 * along the blades that lie toward it, about 1 % of the sunlit blades' pixels brighter by it than
 * by their diffuse light (none at 0.65), while the rest stay saturated green; these figures, the
 * `f0` ones with them, were measured before GGX's alpha became the roughness squared
 * (lighting/SurfaceBRDF.ts) and are to be measured again on the GPU. (Normals tilted outward
 * for a rounded blade: Wohllaib 13:27; far off, the normal leaned toward a common one and the
 * gloss lowered: 14:33, where it leans toward the clump's normal.) */
const SURFACE = { round: 0.3, roughness: 0.4, farGloss: 0.75, flatten: 0.6, f0: 0.01 };
/** `flags=grassMask` (at load) paints the blades red, with no light through them, over the green
 * ground, so a capture's red pixels are the blades' cover (tools/kit/img.py `stats --cover`).
 * `flags=grassMask:exact` draws them unlit in pure red of MASK_EXACT instead, far above any lit
 * radiance: in the resolved opaque colour a pixel's red over MASK_EXACT is the share of it the blades
 * cover, and a pixel with neither green nor blue is covered whole (tools/island/meadow-light.mjs).
 * `flags=grassMask:albedo` draws them unlit in their own diffuse colour (what the lighting takes as
 * their albedo, the darkening toward the roots and a wet tint included), so the opaque colour holds
 * the albedo of each fully covered pixel. `flags=grassMask:lean` draws them as `exact` does, with each
 * leaf's lean from upright in green (degrees: its chord as drawn, the sway and the push away from a
 * near eye included) and its pose's tilt alone in blue (tools/island/meadow-light.mjs's `lean` page). */
const GRASS_MASK = debugFlags.grassMask === true;
const GRASS_MASK_EXACT = debugFlags.grassMask === 'exact';
const GRASS_MASK_ALBEDO = debugFlags.grassMask === 'albedo';
const GRASS_MASK_LEAN = debugFlags.grassMask === 'lean';
const MASK_EXACT = 256;

function grassMaterial( shared: Shared, blades: MeadowBlades, low = false ): THREE.MeshStandardNodeMaterial {

	const reads = blades.reads();
	const current = bladeVertex( reads, shared.wind, false, low );
	const vN = varying( vec4( current.normal, current.ao ), 'vGrassNormal' );
	const vB = varying( vec4( current.along, current.column, current.far, current.winding ), 'vGrassBlade' );
	const along = vB.x, far = vB.z;
	// the clump's column and the gloss's ramp (`bladeVertex`)
	const columnB = step( 1.5, vB.y ), glossRamp = clamp( vB.y.sub( columnB.mul( 2 ) ), 0, 1 );
	// the normal, turned to the eye on either face (the triangle's face times its leaf's winding),
	// far pulled toward the ground's up
	const up = cameraViewMatrix.mul( vec4( 0, 1, 0, 0 ) ).xyz;
	const facing = normalize( cameraViewMatrix.mul( vec4( vN.xyz, 0 ) ).xyz ).mul( faceDirection ).mul( select( vB.w.lessThan( 0 ), float( - 1 ), float( 1 ) ) );
	const normal = normalize( mix( facing, up, far.mul( SURFACE.flatten ) ) );
	// the key colours along the blade, far off their mean
	const key = ( c: number[] ) => vec3( c[ 0 ], c[ 1 ], c[ 2 ] );
	// (the clump's column: BLADE_COLOUR)
	const column = ( part: 'root' | 'middle' | 'tip' ) => mix( key( BLADE_COLOUR.a[ part ] ), columnBColour[ part ], columnB );
	const root = column( 'root' ), middle = column( 'middle' ), tip = column( 'tip' );
	const lower = mix( root, middle, smoothstep( 0, 0.5, along ) );
	const upper = mix( middle, tip, smoothstep( 0.5, 1, along ) );
	const mean = root.mul( 0.3 ).add( middle.mul( 0.4 ) ).add( tip.mul( 0.3 ) );
	const albedo = mix( mix( lower, upper, step( 0.5, along ) ), mean, far ).mul( groundGains.lawnGain.div( LAWN_GAIN ) );
	const translucency = mix( float( TRANSLUCENCY.root ), float( TRANSLUCENCY.tip ), mix( along, float( 0.6 ), far ) ).mul( translucencyMask );
	const mat = vegetationMaterial( shared, {
		family: 'blade', name: 'grass', roughness: SURFACE.roughness,
		wet: { tint: 0.75, roughness: 0.35 },
		color: ( tint ) => GRASS_MASK ? vec4( 0.4, 0, 0, 1 ) : vec4( albedo.mul( tint ), 1 ),
		rest: current.position,
		displacement: ( state ) => state === shared.wind ? current.position : bladeVertex( reads, state, state === shared.wind.previous, low ).position,
		normal, ao: vN.w,
		light: {
			// the ambient volume read straight above the blade's point (lighting/AmbientSample.ts):
			// per pixel, as every material reads it (see the meadow's light in the header)
			ambient: { bands: 2, offset: 'up', kind: 'meadow' },
			scale: float( 1 ),
			translucency,
			extra: ( L, V, N ) => vec3( ...TRANSLUCENCY.tint ).mul( GRASS_MASK ? 0 : 1 ).mul( transmission( translucency )( L, V, N ) ),
		},
	} );
	mat.roughnessNode = float( 1 ).sub( float( 1 ).sub( mat.roughnessNode as F ).mul( glossRamp.mul( - SURFACE.farGloss ).add( 1 ) ) );
	// the blade's specular reflectance (SURFACE.f0), the sky's reflection and the key's glint alike
	( mat as unknown as { setupSpecular: () => void } ).setupSpecular = () => {

		specularColor.assign( vec3( SURFACE.f0 ) );
		specularColorBlended.assign( vec3( SURFACE.f0 ) );
		specularF90.assign( 1 );

	};
	mat.userData.wind = shared.wind.direction;
	// the screen-space ambient occlusion, times the blades' own (post/GTAO.ts)
	receiveScreenAO( mat );
	// on the sun's map, the blades' screen-space shade (floored) and their layer's (`meadowLayerLight`)
	const shades: F[] = [];
	if ( MEADOW_SHADOWS ) shades.push( max( meadowShadowAt(), meadowShadowFloor( translucency ) ) );
	if ( GRASS_SHADOW ) shades.push( meadowLayerLight( meadowLayerDepth( positionWorld, liftKeyWorld( shared.sunDir ) ) ) );
	if ( shades.length ) mat.userData.sunOcclusion = shades.reduce( ( a, b ) => a.mul( b ) );
	// `flags=grassSunMap:false`: the blades keep their own shades but read nothing from the sun's map
	if ( debugFlags.grassSunMap === false ) mat.userData.sunVisibility = shades.length ? mat.userData.sunOcclusion : float( 1 );
	if ( GRASS_MASK_EXACT ) mat.outputNode = vec4( MASK_EXACT, 0, 0, 1 );
	if ( GRASS_MASK_ALBEDO ) mat.outputNode = vec4( diffuseColor.rgb, 1 );
	if ( GRASS_MASK_LEAN ) mat.outputNode = vec4( MASK_EXACT, varying( current.lean!, 'vGrassLean' ), 1 );
	return mat;

}

/** The tip's offset over its height (world x, z) the wind gives a blade on its `seed` (0..1: its
 * facing, lean and phase), under the wind field `field` at its root (Wind.ts `windAt`: the gust in
 * w), for the wind probe (packages/island/debug/WindProbe.ts): the vertex stage's lean and sway at the tip
 * (`bladeFacing`, `swingAt`), for a plain blade (no bend or fold); the sway's push is a share of
 * the height, so the offset over it holds for every height. */
export function bladeWindOffset( wind: WindState, field: V4, seed: F ): THREE.Node<'vec2'> {

	const random = stream( uint( seed.mul( 16777216 ) ) );
	const sum = vec2( random( 0 ), random( 1 ) ).mul( 2 ).sub( 1 );
	const tilt = atan( random( 2 ).mul( 1.4 ).add( 0.3 ).mul( TILT.lean * ( 1 + 0.25 * HEIGHT_MAP.mean ) ) );
	const facing = bladeFacing( wind, sum );
	const sway = swingAt( wind, random( 3 ), float( 1 ), field.w );
	return facing.mul( sin( tilt ).add( swingPush( sway ).tip.x ) );

}

/** A draw's geometry: BLADES blades of `verts` vertices (VERTS near, LOW.verts far; no attributes
 * the shader reads), one strip each, as a list. A single blade is the whole strip: seven rows of
 * two and its tip near, three far. The far draw lays a folded blade's shorter leaf first, from
 * its open tip row (vertices 0 - 1) to the root's (2 - 3), one segment, then the longer leaf's row
 * and its closed tip (4 - 6), two segments: the shorter leaf keeps its tip open, so the far
 * blade's two leaves cover about what the near blade's do. Near, a
 * folded blade lays its two leaves on the same strip through their shared root (`bladeVertex`):
 * the first leaf from its tip, whose row of two meets at the point (vertices 0 - 1, so the strip's
 * first triangle has no area), down its three rows to the root's (2 - 9), then the second leaf's
 * two rows and its tip (10 - 14): four segments and three over the same length, twelve triangles
 * of the thirteen. (Two
 * leaves on one strip of 15 vertices, one of them a vertex short and its tip our own: Wohllaib
 * 07:56-09:36; sharing the root row is ours.) */
function bladeGeometry( verts = VERTS ): THREE.BufferGeometry {

	const geometry = new THREE.BufferGeometry();
	const vertices = BLADES * verts;
	geometry.setAttribute( 'position', new THREE.BufferAttribute( new Float32Array( vertices * 3 ), 3 ) );
	const normals = new Float32Array( vertices * 3 );
	for ( let i = 0; i < vertices; i ++ ) normals[ i * 3 + 1 ] = 1;
	geometry.setAttribute( 'normal', new THREE.BufferAttribute( normals, 3 ) );
	const index = new Uint32Array( BLADES * ( verts - 2 ) * 3 );
	let n = 0;
	for ( let blade = 0; blade < BLADES; blade ++ ) {

		const base = blade * verts;
		for ( let t = 0; t < verts - 2; t ++ ) {

			if ( t % 2 === 0 ) index.set( [ base + t, base + t + 1, base + t + 2 ], n );
			else index.set( [ base + t + 1, base + t, base + t + 2 ], n );
			n += 3;

		}

	}
	geometry.setIndex( new THREE.BufferAttribute( index, 1 ) );
	geometry.boundingSphere = new THREE.Sphere( new THREE.Vector3(), 1e4 );
	return geometry;

}

// --- the meadow's shadow
//
// The blades stay out of the sun's map: generated per view, they would need the whole pipeline run
// again for the light. The meadow shades its own layer instead: a layer whose top stands LAYER.top
// of the blades' mean length over their roots (the ground map's turf and grass-height map), as a
// volume the key's light crosses. A point under the top (a blade low in the sward, the turf under
// it, a stone's foot beside it) takes exp( -l / s ) of the key, l the length of its ray toward the
// light under the top (m: its depth under the top over the light's height over the horizon) and s
// LAYER.mean (m, along the ray); above the top it takes all of it. Blades, turf and stones take the
// one law, with no floor: the deeper and the lower the sun, the darker. It is the mean shade of a
// proxy of the ground raised to the layer's top whose depths are pushed down by exponentially
// distributed lengths along the light, as a filtered shadow map would give it, multiplied into the
// whole key light (wrap, light through, highlight); the translucency's floor raises the meadow's
// screen-space shadows only (post/MeadowShadows.ts), never this one, and the two multiply: the layer
// is the sward's mean depth, the screen-space march the shadowing of blade on blade. (A shadow proxy of the terrain
// raised to the grass's height, whose filtered shadow gives the grass's shadow density, and
// screen-space shadows for the fine detail: Wohllaib 21:14-21:47; working it out where it is
// received, not through the map, is ours.) Drawn into the sun's map with its depth dithered over
// 4 x 4 texels, the layer was averaged only by the blades' filter: every other receiver's,
// contact-hardened so near its caster, printed the dither as a grid of dots on the soil between the
// blades, the rock lip and the rim, at the game's views too. Worked out where it is received
// (`meadowLayerDepth`), it gives the dither's mean shade with no pattern, for two bilinear lookups
// of the ground map per blade fragment (the ground's eleven per vertex: the two at itself and at its
// ring's four points and one at its own column, forty-four texel loads for its two runs and the
// meadow's foot) where the dither's filter took thirty-two of the sun's map.

/** The meadow left out at load (`flags=bareGround`): the blades hidden, no shade of their layer,
 * and the turf lit as bare ground (TerrainMaterial.ts), for the lighting layer's reading of bare
 * ground under the light the sward takes (debug/LightLayer.ts). */
export const BARE_GROUND = debugFlags.bareGround === true;
/** The meadow shades its own layer (`meadowLayerLight`: the blades, the turf under them and the
 * ground beside it; on unless `flags=grassShadow:false` at load); the ground under it then takes no
 * crowns' shade of its own (TerrainMaterial.ts). */
export const GRASS_SHADOW = debugFlags.grassShadow !== false && ! BARE_GROUND;
// the least share of the ground map the layer stands on, and the share either side of it across
// which it fades in (`share`, `edge`); the layer's top over the roots as a share of the blades'
// mean upright length there (`top`; the mean length per unit of the grass-height map is
// LENGTH.full); the mean length (m) the key's light runs under the top for each 1 / e of it
// (`mean`, along the ray, `meadowLayerLight`); the light's least height over the horizon (sin) the
// ray's run divides by, so a low sun does not reach across the meadow (`least`: the lifted key's
// daytime height is at least sin 14° ≈ 0.24, so it acts only with the lift off,
// `flags=keyLift:false`); and the radius (m) of the ring the ground's depth is averaged over
// (`spread`), a shadow filter's footprint, so the ground beside the meadow (the rock lip, the rim)
// fades out of its shade over that width, as it did under the sun's filter, rather than where the
// layer's height falls to nothing (without it the rock lip beside the meadow rendered 6 % brighter
// at the game's view than under the filter, in a pale band along the meadow's edge; the mean alone,
// not held to the point's own depth, lit the sparse turf inside the edge as well). `top` 0.628 and
// `mean` 0.395 m are tunable (`grass.layer.top`, `grass.layer.mean`): the shaders read uniforms of
// the top's terms worked out here, the numbers they read as constants at the default. The mean is
// read once as the page loads (a new value reloads the page): the shader divides by it as a constant,
// which compiles to other code than any uniform form of it (a division, a reciprocal's product or
// an exp2's factor all moved pixels a level).
const LAYER = { share: 0.5, edge: 0.1, top: 0.628, mean: 0.395, least: 0.15, spread: 0.6 };
const layerDepthScale = uniform( 0 ), layerRunScale = uniform( 0 );
tuneApply( 'grass.layer.top', LAYER.top, { min: 0.4, max: 0.7 }, ( a ) => { layerDepthScale.value = a * LENGTH.full; layerRunScale.value = a * LENGTH.full * HEIGHT_MAP.mean; } );
const layerMean = tune( 'grass.layer.mean', LAYER.mean, { min: 0.2, max: 0.6, load: true } )();

/** The layer over ( x, z ), bilinear in the ground map: its top (the roots' height, the mean over
 * the texels that hold turf, less the blades' sink, and LAYER.top of the blades' mean length), the
 * share of the ground that holds turf, and the roots' height with the texels' weight that holds
 * turf (`held`: under 1e-6 the roots' height means nothing). */
function layerAt( xz: V2 ) {

	const f = xz.div( MEADOW_EXTENT ).add( 0.5 ).mul( MEADOW_SIZE ).sub( 0.5 ).toVar();
	const i0 = floor( f ).toVar();
	const t = f.sub( i0 ).toVar();
	let sum: F = float( 0 ), held: F = float( 0 ), share: F = float( 0 ), map: F = float( 0 ), free: F = float( 0 );
	for ( const [ dx, dz ] of [ [ 0, 0 ], [ 1, 0 ], [ 0, 1 ], [ 1, 1 ] ] ) {

		const p = ( textureLoad( groundMap, ivec2( clamp( i0.add( vec2( dx, dz ) ), 0, MEADOW_SIZE - 1 ) ) ) as unknown as V4 ).toVar();
		const w = ( dx ? t.x : t.x.oneMinus() ).mul( dz ? t.y : t.y.oneMinus() );
		const holds = w.mul( step( 1e-9, p.y ) );
		const heights = groundHeights( p.w );
		sum = sum.add( holds.mul( p.x ) );
		held = held.add( holds );
		share = share.add( w.mul( p.y ) );
		map = map.add( w.mul( heights.short ) );
		free = free.add( w.mul( heights.free ) );

	}
	const depth = map.mul( layerDepthScale ).toVar();
	const roots = sum.div( max( held, 1e-6 ) ).sub( SINK ).toVar();
	const freeDepth = free.mul( layerDepthScale );
	return { top: roots.add( depth ).toVar(), depth, share, freeTop: roots.add( freeDepth ), freeDepth, roots, held };

}

/** The ray from `at` (world) toward the key light (`key`, unit: the lifted key, KeyLift.ts
 * `liftKeyWorld`, as the layer's shade is part of the sun's shadow and falls along its map's
 * direction, under a low sun as well as the map's and the screen-space shade) under the meadow's
 * layer: how far (m) it runs there, its depth under the layer's top, held to the layer's depth, over
 * max( key.y, LAYER.least ), 0 above it and off the meadow, under the layer as the blades shorten
 * it (`run`) and free of the land's edge (`turf`), both at the second lookup of the first's ray: one
 * walk has one second look. `ground` is the roots' height where the ray meets the layer, and `path`
 * the higher of the roots' heights at the walk's two looks, each less the ray's climb to it, a height
 * at `at`: a point over it has its ray over the ground at both (`meadowGroundRuns`). */
function layerRuns( at: V3, key: V3 ): { run: F; turf: F; ground: F; path: F } {

	// where the ray toward the light meets the layer's top: the top looked up first where the ray
	// has climbed the layer's mean height, then where it reaches the top found there
	const rise = max( key.y, LAYER.least ).toVar();
	const run = key.xz.div( rise ).toVar();
	const first = layerAt( at.xz.add( run.mul( layerRunScale ) ) );
	const climb = max( first.top.sub( at.y ), 0 );
	const hit = layerAt( at.xz.add( run.mul( climb ) ) );
	// a point whose ray is over the top a step on (a blade or the turf where the layer's top falls
	// away toward the light) crosses at most its own depth under the top there; a point under the
	// layer's foot, which the same step finds (a cliff's face under the meadow's lip, the ground map
	// holding the lip's turf over it), is the ground's to leave out (`meadowGroundRuns`)
	const over = ( top: F, depth: F ) => clamp( top.sub( at.y ), 0, depth ).div( rise ).mul( smoothstep( LAYER.share - LAYER.edge, LAYER.share + LAYER.edge, hit.share ) );
	return { run: over( hit.top, hit.depth ), turf: over( hit.freeTop, hit.freeDepth ), ground: hit.roots, path: max( first.roots.sub( layerRunScale ), hit.roots.sub( climb ) ) };

}

/** How far (m) the ray from `at` toward the key runs under the meadow's layer as the blades stand
 * (`layerRuns`), for `meadowLayerLight`. Texel loads only: for any stage and inside any branch. */
export function meadowLayerDepth( at: V3, key: V3 ): F {

	return layerRuns( at, key ).run;

}

/** How far (m) under the turf's roots (or the ground at its ray's looks) a point of the ground lies
 * before it is under the meadow's foot (`under`), the band over which it leaves the layer's shade
 * (`band`), and the surface's least and most height of its normal over which it may (`up`): a face
 * under the lip lies its depth under the turf, and only a face steeper than any turf can lie under
 * it (the turf grows where the ground's normal rises MEADOW_MIN_UP and more), so the turf keeps its
 * runs where along the rim the bilinear mean of the roots (a texel's turf beside a higher one's)
 * lies over its own points. */
const FOOT = { under: 0.05, band: 0.1, up: [ MEADOW_MIN_UP - 0.25, MEADOW_MIN_UP - 0.05 ] };

/** The island's ground's two runs (`layerRuns`), for one set of texel loads: x as everything but the
 * turf takes it, y as the turf does, each at least its mean over four points on a level ring of
 * LAYER.spread around `at`. The second is free of the land's edge: the same run inland, and along
 * the rim the run of the turf inland, where a depth falling to nothing over HEIGHT_MAP.edge let the
 * key through to a band of turf about 1.3 m wide under the shortened blades, at about twice the
 * meadow's lightness at a low sun. The ground beside the meadow keeps the first: a depth held to the
 * rim darkens lit rock on the ring.
 * The first is taken only where the ray toward the key goes through the sward. On a face steeper
 * than the turf (`up`, the surface's normal's height), a ring's point that lies under the ground its
 * ray meets the layer over is inside the rock under the meadow's foot, and the point's own ray
 * leaves the layer out where the point lies under the turf of its own column (the ground map, of a
 * quarter metre, holds the lip's turf over the top of a cliff's face) and its walk finds the ground
 * over the ray at either look (`layerRuns`' `path`): such a face's light goes out from the face,
 * over the sea, and only rock lies between it and the sward (the sun's map shades it where that rock
 * does). Without it the faces under the lip took the full layer down their height when the key went
 * out over the sea (a ring's point under the lip and the point's own column fall back to the turf's
 * depth over them: `layerRuns`). The own ray's test is the ray's own, not the ground's height over
 * the point: a ray that crosses air to a higher sward in front, as from a gully's wall under its
 * rim (Cliff.ts' gullies are 0.4 - 0.84 m wide, the meadow on both rims), runs over the ground at
 * both looks and keeps its run where the walk's first look reaches the far rim (the ray's climb of
 * the layer's mean height: about a metre at a 14 degree key, a quarter of one at 45). A higher
 * sward beyond that, across a gap whose floor lies under the point, the walk does not see, and the
 * face there takes no shadow of the layer. A ring's point keeps the ground's test, and takes none
 * from a sward across a gap, so there the shadow is the point's own, not widened over the ring: it
 * lies off the surface, often in the rock under the lip, where the walk climbs over the lip's turf
 * and the path's test passes it (taken for the ring as well, it put the layer back on the top 0.3 m
 * or so of the faces under the lip, a darker band along the rims at every sun height). The meadow's
 * ground keeps its runs, and the turf's run (y) keeps its ring whole: the turf takes it, never a
 * face. */
export function meadowGroundRuns( at: V3, key: V3, up: F ): V2 {

	// the share of a point's run kept, by the height of the ground over it (where its ray meets the
	// layer, or along its own ray's walk) and by how steep the surface is
	const steep = float( 1 ).sub( smoothstep( FOOT.up[ 0 ], FOOT.up[ 1 ], up ) ).toVar();
	const kept = ( ground: F ) => float( 1 ).sub( smoothstep( FOOT.under, FOOT.under + FOOT.band, ground.sub( at.y ) ).mul( steep ) );
	// the turf's roots at the point itself, the most a ring's point's ground counts (a level ring's
	// points lie under a sloped turf's), or none where its column holds no turf
	const column = layerAt( at.xz );
	const cap = column.roots.add( float( 1 ).sub( step( 1e-6, column.held ) ).mul( 1e4 ) );
	// a ring turned off the ground map's axes, so its taps do not line up with the texels; the
	// point's own depth where it is deeper, so the footprint widens the shadow past the meadow's
	// edge without thinning it inside
	let run: F = float( 0 ), turf: F = float( 0 );
	for ( const [ x, z ] of [ [ 2, 1 ], [ - 1, 2 ], [ - 2, - 1 ], [ 1, - 2 ] ] ) {

		const ring = layerRuns( at.add( vec3( x, 0, z ).mul( LAYER.spread / Math.sqrt( 5 ) ) ), key );
		run = run.add( ring.run.mul( kept( min( ring.ground, cap ) ) ) );
		turf = turf.add( ring.turf );

	}
	const own = layerRuns( at, key );
	return vec2( max( own.run.mul( kept( min( own.path, column.roots ) ) ), run.mul( 0.25 ) ), max( own.turf, turf.mul( 0.25 ) ) );

}

/** The share of the key light the meadow's layer lets through to a point whose ray toward it runs
 * `run` m under the layer's top (`meadowLayerDepth`): exp( -run / LAYER.mean ), for the blades, the
 * turf and the stones alike. */
export function meadowLayerLight( run: F ): F {

	// held at 0: an interpolated run (the ground's, a varying) taken outside its triangle at a
	// multisampled edge can fall below it, where the exponential would light the pixel many times over
	return exp( max( run, 0 ).div( - layerMean ) );

}

/** The meadow's group: its one mesh of blades, generated for each view as it draws. */
export function buildGrass( plan: GrassPlan, shared: Shared ): THREE.Group {

	const crowns = runSteps( crownSteps( [ plan.crowns ] ) );
	setSwardField( runSteps( swardSteps( plan.sward, SWARD_FALLBACK, crowns ) ) );
	setCanopyTop( runSteps( canopySteps( crowns ) ) );
	const blades = new MeadowBlades( groundTexture( plan.ground ), groundTexture( plan.lip, MEADOW_SIZE, 'grassLip' ), plan.box );
	// the near draw and the far one (LOW), each from its own arguments in the one indirect buffer;
	// the first to draw for a camera generates the blades (`update` does nothing again for it)
	const draw = ( low: boolean ) => {

		const mesh = new THREE.Mesh( bladeGeometry( low ? LOW.verts : VERTS ), grassMaterial( shared, blades, low ) );
		mesh.name = low ? 'grass-blades-far' : 'grass-blades';
		mesh.frustumCulled = false;
		mesh.castShadow = false;
		mesh.receiveShadow = true;
		mesh.renderOrder = - 1;
		mesh.visible = ! BARE_GROUND;
		mesh.userData.grassCulled = true;
		const geometry = mesh.geometry as unknown as { setIndirect( a: THREE.IndirectStorageBufferAttribute, offset: number ): void; indirect: unknown };
		mesh.onBeforeRender = ( renderer, _scene, camera ) => {

			blades.update( renderer as unknown as THREE.Renderer, camera );
			geometry.setIndirect( blades.indirect, low ? 20 : 0 );

		};
		mesh.onAfterRender = () => {

			geometry.indirect = null;

		};
		return mesh;

	};
	const group = new THREE.Group();
	group.name = 'grass';
	group.add( draw( false ), draw( true ) );
	group.userData.blades = blades;
	group.userData.plan = plan;
	// (the blades are generated as they draw: nothing to do ahead)
	group.userData.update = () => {};
	group.userData.edgeRoots = () => ( group.userData.plan as GrassPlan ).roots;
	// (no flowers: the parity views that look for them find none)
	group.userData.flowerHeads = () => [];
	return group;

}

interface GrassPrepared { plan: GrassPlan; ground: THREE.DataTexture; lip: THREE.DataTexture; sward: THREE.DataTexture; crowns: THREE.DataTexture }

/** The meadow as a vegetation kind (vegetation/Registry.ts): a growth step bakes the next ground
 * map and the fields under the meadow, and swaps them in. */
export function grassKind( group: THREE.Group ): VegetationKind<GrassPrepared, WorldData> {

	return { name: 'grass', root: group, prepass: true, shadowFilter: 'vegetation', sunCaster: false, rainBake: false, cost: 'none', testMode: 'stateless', land: { follower: 'its growth' },
		growth: {
			*prepare( input ) {

				const plan = yield* grassSteps( input.data.vegetation, input.data.rimGround );
				const crownData = yield* crownSteps( [ plan.crowns ] );
				const sward = yield* swardSteps( plan.sward, SWARD_FALLBACK, crownData );
				yield* textureSteps( input.renderer, sward );
				const crowns = yield* canopySteps( crownData );
				yield* textureSteps( input.renderer, crowns );
				const ground = groundTexture( plan.ground );
				yield* textureSteps( input.renderer, ground );
				const lip = groundTexture( plan.lip, MEADOW_SIZE, 'grassLip' );
				yield* textureSteps( input.renderer, lip );
				return { plan, ground, lip, sward, crowns };

			},
			swap( prepared ) {

				const blades = group.userData.blades as MeadowBlades;
				const oldGround = blades.setGround( prepared.ground, prepared.lip, prepared.plan.box );
				group.userData.plan = prepared.plan;
				const oldSward = setSwardField( prepared.sward ), oldCrowns = setCanopyTop( prepared.crowns );
				return () => {

					for ( const map of oldGround ) map.dispose();
					oldSward.dispose();
					oldCrowns.dispose();

				};

			},
		},
	};

}
