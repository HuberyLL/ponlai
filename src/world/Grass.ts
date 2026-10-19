import * as THREE from 'three/webgpu';
import {
	Fn, attribute, positionLocal, workgroupId, localId, normalViewGeometry, vec2, vec3, vec4, float, mix, max, min, dot, pow, clamp, fract, sin, select, normalize, floor as floorN,
	length, cameraPosition, cameraViewMatrix, cameraProjectionMatrix, screenSize, varying, varyingProperty, uniform,
	smoothstep as smoothstepN, instanceIndex, vertexIndex, normalLocal, transformNormal, instanceColor, sign, abs, cos, step, specularColor, specularColorBlended, specularF90,
	positionGeometry, cross, If, mat4,
} from 'three/tsl';
import { LIP_INFO, sampleRimGround, rimGrassCover } from './RimGround.ts';
import type { RimGroundField, RimLipData, ShoreField } from './types.ts';
import { shoreDistance } from './ShoreSample.ts';
import { mulberry32, smoothstep } from './noise.ts';
import { anchorStream, cellStream } from './Anchors.ts';
import { BAMBOO } from './Bamboo.ts';
import { LAWN_COLOUR, SHORE_RIM, SWARD_HEIGHT, meadowColor, meadowMoisture, meadowSoil, meadowShallow, meadowTurf, meadowVigour, supportsMeadow, type ShoreAt } from '../materials/Meadow.ts';
import { soilUniforms } from '../materials/Soil.ts';
import { rootHash, type WindState } from '../weather/Wind.ts';
import { bendBlade, bladePhase, drown, screenHeight, swayFade, tuftWind, type TrampleBlade, type TuftWind } from './vegetation/Deform.ts';
import { TRAMPLE_RECORD, trampleKernel, trampleShare } from './vegetation/Trample.ts';
import { CANOPY_TOP, TURF_CANOPY_DEPTH, meadowCanopyLight, meadowCastLight } from '../lighting/MeadowCanopy.ts';
import { PUDDLE_WET, puddleCover } from '../weather/Puddles.ts';
import { VEGETATION_STRIDE as STRIDE } from './types.ts';
import { GRASS_BLADE, gravityNumber, type StrandMaterial } from './vegetation/Physics.ts';
import { runSteps } from './Steps.ts';
import { canopySteps, canopyTop, crownSteps, setCanopyTop, setSwardField, swardSteps } from './SwardField.ts';
import { ALPHA_TO_COVERAGE } from './vegetation/Coverage.ts';
import { backlight, forwardLight, vegetationMaterial, type VegetationOptions } from './vegetation/Material.ts';
import { debugFlags } from '../debug/DebugFlags.ts';
import { TEMPORAL } from '../post/Antialiasing.ts';
import { MEADOW_SHADE, meadowShadeAt } from '../post/MeadowShade.ts';
import { CULL_GROUP, VegetationCull, poolBuffers, poolSteps, type CullBatchInput, type CullBuffers, type CullPayload, type CullPool, type CullRange } from './vegetation/VegetationCull.ts';
import { AttributeType, textureSteps, uploadSteps } from './Upload.ts';
import { screenShare, screenShareNode } from './vegetation/Lod.ts';
import type { VegetationKind } from './vegetation/Registry.ts';
import type { Shared } from '../shared.ts';
import type { SunShadow } from '../lighting/SunShadow.ts';

// The meadow on the island top: a sward of tussocks, one instanced tuft on every planting anchor
// and a second beside it on about a quarter of them (one tussock of 12 to 30 blades), grouped into
// clumps about a metre across whose tussocks stand, lean and colour alike (CLUMP), so the sward
// closes as a whole, reads from the game's view in strokes of a painter's brush rather than a grain
// of tussocks, and sways with the wind as its clumps do. The blades are long and thin (0.5 m on
// ordinary soil, 1.2 to 1.5 cm at the root), sword-shaped, wide to two thirds up and running to a
// point; each takes its own length, facing, root angle and stiffness, all hashed from the blade and
// its anchor, and the shape its weight gives it (vegetation/Physics.ts, fitted to a curve:
// `restBlade`): long blades arc over and droop, short ones stand nearly straight. Long, thin blades
// are what lets the wind show: a short blade's tip barely travels. One grass colour (Meadow.ts) as
// the blades' mean, from a deeper, cooler root to a lighter, yellower tip, where the key light
// shines through the blade, its place on a palette of greens its stroke's (STROKE: a few clumps
// share one) and each blade only a little apart from it; the sward darkening toward its roots by
// its density, with a faint gloss along the blades and little of a dielectric's specular; soft
// upward normals join the blades to the turf rather than lighting every tuft as a cushion, and each
// blade is folded along its midrib, one half turned to
// the light and the other from it, with a thin lighter edge; far off a blade takes its clump's
// normal, unfolded (FAR). The light through a blade is the light toward the sun's half of the view
// alone (`forwardLight`). The sward
// has a real meadow's layers from the ground up
// (CULM_*, DRY_*): dead leaves drooped low and the old leaves' straw sheaths at the bottom, the green
// leaves, and over them a few of each tall tussock's blades grown as flowering stems whose
// spike-like panicles, purple brown to straw, stand above the leaves.
// Anchors come from
// the world worker (x, y, z, normal, rim distance, kind and local sky visibility); every choice
// below is a seeded hash of the anchor, so the meadow grows with the island's footprint and needs
// no placed features.
//
// Rules (the look is in docs/art-direction.md; the reasons are below, where each is built):
// - Variation lives between the clumps, not within them: the
//   clumps of a world-anchored lattice (CLUMP) give their tussocks most of their height, their lean,
//   their blade count and, by the strokes of a coarser lattice (STROKE), their colour; a tussock
//   keeps a little of its own height and lean (TUSSOCK), and each blade its length and pose
//   (`restBlade`) and a tenth of its value and a fifth of the palette's run (BLADE_TINT), the means
//   kept. Each tussock and blade drawing its height, lean, value and tint by itself (a third either
//   way), with a gap in every twentieth, drew the sward from the game's view as a grain of
//   tussocks over the dark ground between them. The soil sets the odds and the level those draws take, never a zone: the tall
//   sward's level rises and falls a little with its soil's vigour over some 14 m (LUSH), and pockets
//   of shallow soil a few metres across pull their tussocks down toward a short turf, each tussock
//   part of the way by a draw of its own and some not at all, so the sward slopes into them with
//   tussocks standing in them (GRADE; Meadow.ts `meadowVigour`, `meadowShallow`); small low patches
//   of one to a few tussocks (LOW) lie anywhere. No tiers or tints by the soil's zones, which read
//   from above as zoning, no two levels, which read as hollows, and no noise's low end, whose valleys
//   read as footpaths. The short turf is a closed mat, its blades spread out over the ground (MAT),
//   its ground its own base (SwardField.ts, TerrainMaterial.ts), so a shallow pocket reads as short
//   turf rather than a dark blotch or bare earth; only a gap shows the soil (THIN_GAP, in a shallow
//   pocket). The soil's exposure and moisture (Meadow.ts) pick the flowers' species.
//   The sward runs to the edge on every coast. The extra tufts fold away beyond about 35 m and are not drawn
//   past their fold, 42 m. Toward the coast the sward rolls over a rounded shoulder: over its last
//   metre and a half the tufts lean out more and stand a little lower (SHOULDER) and stiffer
//   (LIP_STIFF).
// - The grass over the cliff's edge is the meadow's own tufts draping over it: every lawn tuft
//   rooted within EDGE_REACH of the edge carries the nearest sample of the worker's lip
//   (RimGround.ts `buildRimLip`) in the cull's `edge` buffer (`edgeTuftSteps`: the coast's offset
//   along its outward direction, the roof's height, the outward direction and LIP_WALLS offsets of
//   the stone every LIP_DEPTH down), and the vertex stage lays the part of a third of the bent
//   blades past the edge round a curl and down over it (`drape`, DRAPE_SHARE), the rest arching out
//   over it, and holds every point past the coast outside the stone (`holdOff`), so a blade that
//   reaches the stone lies along it, downward, and none passes into it, while the blades over the
//   turf's shoulder inland of the coast keep their shape; its previous position takes the same
//   drape and hold. Both are 0 for the tufts without a record, which draw as the rest of the meadow.
// - Blades do not cast into the sun's shadow map (narrower than a texel, they flicker as the sun
//   moves). The meadow shades itself: at 4x outside the temporal modes the blades in front of the
//   light shade those behind them at each pixel (post/MeadowShade.ts, its march over the
//   vegetation's depth, `meadowShadeAt`), in place of a level canopy's mean shade (MeadowCanopy,
//   which the temporal modes keep); the taller tussocks shade their neighbours through the sward's
//   top (SwardField.ts `canopyTop`, MeadowCanopy.ts `meadowCastLight`), once per tuft with the
//   larger casters' shade below (off with `flags.meadowCast = false` at load); and the turf takes
//   the crowns' shade toward the light (TerrainMaterial.ts, MeadowCanopy.ts `meadowGroundLight`).
//   What the larger casters
//   (rock, the islanders, the game's props) throw onto the blades is soft and light: a few bilinear lookups
//   of the sun's map around each tuft (`SunShadow.softVisibility`), no penumbra search, taken once
//   per tuft in a compute pass whenever the sun's maps change (`meadowStill`), read by the vertex
//   stage and handed to the sun's filter in place of its own (`userData.sunVisibility`); the
//   clouds' shade multiplies in as on every surface (SolarShadow's `installOpenShadow`).
// - On screen a blade stays at least 1.5 pixels wide at 4x (0.75 on the outer rim, where partly
//   covered pixels show a pale fringe over the sea), and under the temporal modes the tier's
//   `minWidth` (0 on high, the rim's no wider), so the meadow does not crawl as the camera moves, and
//   the coverage the widening would lower is kept by whole blades instead: a widened blade draws
//   solid as far up as its coverage stays above its own hash. No pixel of a blade is partly
//   covered (alpha to coverage drew its sample patterns as a grid of dots along the blades). Close
//   up blades render unchanged. Single-sampled (`msaa=1`) blades stay one pixel wide.
// - Each tuft draws fewer blades the farther it stands from the view camera: on high 24 of its 48
//   within 20 m, easing to 12 at 40 m and to 6 at 70 m (GrassQuality, Quality.ts), and beyond that
//   as vegetation/Lod.ts's rule has it, by ( 70 m / distance )^2 (2 at about 120 m), never
//   fewer than two (LEAST_BLADES). A dropped blade narrows to nothing over a short distance of its
//   own, and the kept ones widen and cover for it (`tuftLod`, `pixelWideBlade`), so density and
//   brightness hold. The island view sees its whole meadow from 120 to 200 m: it drew 4 blades a
//   tuft there, so the meadow's cost grew with the island's area (its vertex stage: hiding it saved
//   as much at 1080p as at 1440p), and draws two now. A blade standing in for several of
//   the 70 m blades draws as that many strips, each its own fold and tint, so the far lawn keeps
//   its grain (`bladeStrips`). It is a function of the
//   tuft's distance from the camera's position alone (no hysteresis), so a paused frame does not
//   depend on the camera's path; other cameras draw every blade. The cull sorts the view's tufts
//   into bands by the blades they keep and draws each band with only those (`bandCaps`,
//   vegetation/VegetationCull.ts), so the narrowed blades cost no vertex work either.
// - The view camera's draws are culled per tuft on the GPU (vegetation/VegetationCull.ts, the
//   tufts' payload and spheres `GRASS_PAYLOAD`); every other draw over
//   the same geometry draws every tuft. Tufts bend with the wind field at their root and their
//   normals turn with the bend, so a gust shows as a sheen (vegetation/Deform.ts `bendBlade`, its
//   numbers GRASS_WIND, which the wind probe reads too). The wind at a tuft's root and its
//   tussock's own values are the same for all its vertices: compute passes write them into the
//   tuft's record (`meadowStill`, `meadowWind`: the wind every frame), and the vertices read them.
// - The islanders part the meadow as they walk through it (vegetation/Trample.ts): each blade reads
//   its tuft's record of the walkers' recent tracks (the cull pool's `trail`, written by the trail's
//   kernel) at its own root (a flower's head at its tuft's origin) as a load,
//   their legs' push away from their way and their feet's weight, which the elastica takes with
//   the wind's (`bendBlade`); a pushed blade rises back as a released spring, so a walker leaves a
//   short wake that closes a couple of seconds behind it. A parted blade keeps its shading.
//   `flags.trample = false` at load leaves it out of the shader.
// - Under MSAA a tuft's sway and shiver fade out as it shrinks to a few pixels on screen, its
//   head with it, while its lean in the gusts stays (Deform.ts `swayFade`): far off, a swinging
//   flower head or blade under a pixel crosses the multisamples and flashes from frame to frame,
//   and the slow lean alone shows the gusts sweeping the meadow. A function of the tuft's root and the current
//   camera, so a paused frame repeats; tufts large on screen sway to the bit as before. MSAA only:
//   the temporal modes resolve the far sway's flicker over frames, so the far meadow keeps it.
// - Under the temporal modes a blade's previous position (motion vectors) is its bend under the
//   previous frame's wind from the same rooted point, widened by this frame's offset: the culled
//   list keeps each tuft's own slot, so the tuft is the same whichever instance draws it.
// - The meadow's flowers are part of it: some lawn tufts carry one flower head on a thin stem,
//   the low species on lower tussocks (LOW_FLOWER), the tall one in tall tussocks a little over
//   their leaves, the tussock's leaves its species' (LEAVES). Two species of Penglai's texts, each in
//   swaths of its own, a few metres across, as a painter lays a field's flowers in broad strokes
//   (`FlowerSwaths`, SWATH: one species a swath, by the habitat at its centre, the moisture and turf
//   fields of Meadow.ts), dense over most of a swath and thinning at its rim, a few single flowers
//   between the swaths, and none on the stacks, on the islander's walking loop or in the bamboo's
//   shade. The flowering tufts are a batch of their own
//   over the lawn's blades, a head and its stem (`flowerTuftGeometry`), so the other tufts run no
//   head vertices; the head's and the stem's indices come first, so every band keeps them whole
//   while its tuft drops blades. A stem is a blade on the stem's curve (STEM_TIP); a head goes
//   through the blades' stages (placed by its tuft, bent by the wind, shaded by the larger
//   casters, out of the sun's map); it and its stem sway on their own, leaning with the gust
//   field and nodding about it whatever their tuft's height (Deform.ts GRASS_WIND.head), taking its own pose, petal colour and
//   light in a blend by its vertex flag (`headPose`, `headShape`: no new varying, the head's
//   values ride in the blade's; its species by the tuft's flower code). Far off it widens to a
//   least size on screen and is drawn whole by its hash, as the blades are, and rises above its
//   tuft's widened blades as they thin (HEAD_LIFT), so the island view shows the meadow's flowers
//   as a swath of fine coloured specks.

interface TuftShape {
	// the blades, their segments, and their levels along their length (segs + 1 of them, 0 to 1)
	blades: number; segs: number; rows: number[];
	r0: [ number, number ]; // base offset from the tuft's axis
	w: [ number, number ]; // blade width at the root (m)
}

// Lawn: 16 long, thin blades a tuft (0.5 m on the plateau's ordinary soil, 1.2 to 1.5 cm wide at the
// root, 30 to 40 to one), their roots spread evenly over a disc of about twice the anchors' spacing
// (r0 is drawn by area), so neighbouring tufts meet in one sward instead of rosettes, and a tall
// tussock's blades arc out over its neighbours. Each blade's
// shape is its own rest pose under its weight (`restBlade`), drawn as a strip of four segments of
// equal length, sword-shaped (Physics.ts's section: wide to two thirds up, running to a point).
// Long, thin blades are what shows the wind (a short blade's tip barely travels); 16 of them cover the
// ground from the game's camera as the 16 broad short blades did, and four segments draw the arc of a
// drooping blade without a visible kink at the 22 m view.
const FUR = 3;
// A blade's levels: its root, half way up, three quarters up and its tip. A blade bends mostly toward
// its tip (its offset grows as the square of the way up) and a culm's panicle widens between 0.62
// and 0.72 of it (CULM_HEAD), so the level at a quarter, of four even segments, shaped nothing the
// game's view shows (1.9 levels of mean difference at 22 m) and cost a fifth of the meadow's
// vertices, about 2 ms in the island views; three even segments cut the panicles short.
const LAWN_ROWS = [ 0, 0.5, 0.75, 1 ];
const LAWN: TuftShape = { blades: 16 * FUR, segs: LAWN_ROWS.length - 1, rows: LAWN_ROWS, r0: [ 0, 0.2 ], w: [ 0.012, 0.015 ] };
// Each blade's own rest pose, a hash of the blade and its tuft's anchor (`restBlade`): its length
// times 0.75 to 1.25 of the tuft's height scale (and one in twelve a fifth longer, the mean kept at
// 1), the direction it bends toward (out from the tuft's axis, within FACING / 2 either way), its
// root angle (ROOT_ANGLE, rad above the tuft's plane: most stand steep) and its stiffness (STIFFNESS,
// a factor on E f, log-even). Its shape is the planar elastica of a cantilever under its own weight
// (vegetation/Physics.ts), a function of its gravity number G (from its length in metres, the
// stiffness and BLADE_MATERIAL, at most G_MAX) and its root angle, fitted offline to a cubic Bezier
// from the root whose control points are polynomials of the two (`bladeCurve`), so the vertex stage
// solves nothing. A short blade (the exposed coast's 20 cm turf) stands nearly straight, a long one
// arcs over and droops: G grows with the cube of the length. HEIGHT_MAX bounds the cull's box
// (`restBox`): a blade reaches no higher and no farther out than its length.
const TALL_SHARE = 1 / 12, TALL = 1.2;
// (SHEAR: how much longer a tussock's blades grow on the side it leans to, see TUSSOCK)
const SHEAR = 0.35;
// The meadow is a mix of grasses, as a real one is: fine leaves (the fescues of exposed turf, about
// 1 - 3 mm wide, rolled and wiry, on the exposed turf; ryegrass and the meadow grasses, 3 - 6 mm,
// in the tall sward) with broad ones among them (cocksfoot, tall fescue, Yorkshire fog: 8 - 14 mm,
// flat, stiffer for their midrib), about three times as wide. Each blade is `fine` or `broad` by a
// draw against its tussock's share of broad leaves (`COARSE`), so the broad leaves gather in
// tussocks, as each species grows in its own, and the short, exposed turf is fine-leaved. The
// factors scale the tuft's widths (LAWN.w) and stiffness, the widths' mean over the tall sward
// kept at 1 (the coverage holds): a tuft draws a few times fewer leaves than a real sward holds, so
// each stands for several and is wider than a real leaf, and the ratio and the shares are the real
// ones. At the game's 22 to 45 m every leaf was under two pixels wide and drew at the same least
// width (`pixelWideBlade`): one width read as a mat of hairs, while the broad leaves now draw
// several pixels wide among them. (Broad leaves a fifth longer, as the coarse grasses grow, raised
// the tufts' bounds above the sea's reflection box for a difference the game's view did not show.)
const GRASSES = { fine: { width: 0.65, stiffness: 1 }, broad: { width: 1.86, stiffness: 1.6 } } as const;
// A tall tussock's share of broad leaves, by a hash of its own draws: `shares` below `at[ 0 ]`,
// between and above `at[ 1 ]` (mostly fine, mixed, mostly broad): 0.29 over the tall sward.
const COARSE = { shares: [ 0.12, 0.35, 0.8 ], at: [ 0.55, 0.85 ] } as const;
// The short turf's tufts (LEVEL.short, at most about 0.24 m) take none: the share fades in over these
// height scales (m), below the tall sward's least.
const SHORT_TOP = [ 0.22, 0.28 ] as const;
// The short turf is a closed mat, as a wind-cropped or shallow-soil turf is: its tillers many and
// spreading, its leaves splayed out over the ground. A tuft draws a few times fewer leaves than a
// real turf holds, so a short tussock's (from its height scale MAT.level[ 1 ] (m) down to
// MAT.level[ 0 ], fully) stand for more: MAT.width wider, reaching MAT.spread farther out and MAT.flat
// less high, the same length nearly (`restBlade`). Upright short blades, a pixel wide from the game's
// camera, stood as sticks over the earth: a short turf read as bare ground.
const MAT = { level: [ 0.24, 0.36 ], width: 0.6, spread: 0.6, flat: 0.3 } as const;
const HEIGHT_MAX = 1.25 * TALL / ( 1 + TALL_SHARE * ( TALL - 1 ) ) * ( 1 + SHEAR );
const FACING = 2.2, ROOT_ANGLE = [ 1.0, 1.45 ], STIFFNESS = [ 0.75, 1.35 ];
// The meadow's blade: a grass leaf (Physics.ts GRASS_BLADE) 0.6 mm thick at the root, as a tall
// sward's leaves are, so a 0.5 m blade (G about 3.5) arcs over rather than hanging: at the rim's
// 0.4 mm a blade that long drapes below its root. The tallest tussocks stiffen with their
// height (TUSSOCK.levelStiff), so their 0.7 m blades take G about 6 rather than hanging. The fit
// holds for G up to G_MAX (12, a 0.75 m blade of mean stiffness and the ordinary level's
// thickness), where a blade from the shallowest root angle droops its tip to its root's height;
// heavier blades take that shape, so no blade passes below its root.
const BLADE_MATERIAL: StrandMaterial = { ...GRASS_BLADE, thickness: 6e-4 };
const G_UNIT = gravityNumber( BLADE_MATERIAL, 1 ), G_MAX = 12;
// The tuft's scale across (its local x and z, m per unit) about which its own jitter varies.
const PLANT_SPREAD = 1;
// The share of the anchors that take a second tuft (the extra tufts, folded away by distance), part
// of the anchor's tussock: as many as the growth field's thick patches gave before, so the lawn
// keeps its blade budget.
const THIN_SHARE = 0.28;
// The sward's ordinary level (SWARD_HEIGHT, `ordinary`), which the soil's vigour raises or lowers a
// little (LUSH below), and the short turf's (`short`, the wind-cropped turf's height): no tiers by
// the soil (short exposed turf and the deep soil's taller grass, and their tints, read from above
// as zoning across the island top). Its layering is the tussocks' own (TUSSOCK): each its own
// height, from 0.6 to 1.4 times the level, lower toward the short turf's in the shallow pockets and
// now and then in a low patch (LOW) of one to a few tussocks (GRADE), and the low wildflowers' own
// tufts lower (LOW_FLOWER). The sward runs to the edge on every coast, keeping its level and density
// there (`spill`). SHORT_STAY of the tussocks stay short anywhere.
const LEVEL = { short: 0.21, ordinary: SWARD_HEIGHT };
const SHORT_STAY = 0.03;
// The low patches: a world-anchored lattice of `cell` (m), `share` of its cells holding one, its
// centre clear of the cell's sides by its largest radius (so a tussock looks at its own cell
// alone), its radius `radius` (m: one to a few tussocks). Its weight (full over its inner `core` of
// the radius) pulls a tussock in it down toward the short turf's level as a shallow pocket does
// (GRADE).
const LOW ={ cell: 2.5, share: 0.3, radius: [ 0.2, 0.55 ], core: 0.6 };
function lowPatch( x: number, z: number ): number {

	const i = Math.floor( x / LOW.cell ), j = Math.floor( z / LOW.cell ), r = cellStream( i, j, 307 );
	if ( r() >= LOW.share ) return 0;
	const m = LOW.radius[ 1 ], span = LOW.cell - 2 * m;
	const cx = i * LOW.cell + m + r() * span, cz = j * LOW.cell + m + r() * span;
	const radius = LOW.radius[ 0 ] + r() * ( LOW.radius[ 1 ] - LOW.radius[ 0 ] );
	return 1 - smoothstep( LOW.core, 1, Math.hypot( x - cx, z - cz ) / radius );

}
// Each tussock (one per planting anchor, its extra tuft beside it part of it: TUSSOCK) takes its own
// height about its level (times 1 +- `spread`, the short turf's `shortSpread`; in a clump only its
// clump's `own` of it, CLUMP), stiffness (times 1 +- `stiffness`; a taller tussock's blades are
// thicker, so they stiffen by its height over the level's to the power `levelStiff`, and the
// tallest droop like the others rather than hanging at the curve's limit), its own lean (`lean`, at
// most, in a direction of its own: its blades turn toward it and grow longer on that side by SHEAR;
// in a clump mostly its clump's) and its share of the tuft's 16 blades (`blades`, the least and the
// most, by its clump's draw: a clump stands denser or sparser as a whole). Within a clump the
// tussocks differ little: drawing their height (+-40 %), lean (0.3) and blade count each by itself,
// with a gap in one of twenty and a tall one's roots gathered to its centre, drew the sward from the
// game's view as separate tussocks over the dark ground between them. Only in a pocket of shallow
// soil does a tussock now and then leave a gap (THIN_GAP); the short turf keeps every tuft and blade,
// a closed sward as thick as the lawn (a tussock's share of blades rises to all of them as it comes
// down).
const TUSSOCK = { spread: 0.1, shortSpread: 0.1, stiffness: 0.3, levelStiff: 1.5, lean: 0.12, blades: [ 12 * FUR, 16 * FUR ], extraBlades: [ 12 * FUR, 14 * FUR ] };
// Clumps (the technique of Wohllaib, GDC 2021: blades grouped into Voronoi clumps
// that share their height, facing and colour, so a field is not a golf course's lawn, the clumps
// differing from each other only a little to keep the painted look): the tussocks share a clump
// of a world-anchored Voronoi lattice of `cell` (m), its centre jittered within its cell. A clump
// is one of `types` (by `share`), a little taller or shorter (`height` times its level), its
// tussocks leaning together toward its own side (`same`, the share of the clump's lean in theirs);
// a short one keeps all of its blades (`full`). Each tussock keeps `own` of the height spread its
// own, and one at its rim leaves a gap more often (`rimGap`, from `rim` of the way out). The short
// turf keeps its level (a clump's share falls as a tussock comes down). The tallest stand `cap`
// times the ordinary level. Clumps grown as visible shapes, a quarter of them mounds 1.3 to 1.65
// times the level leaning out from their centres, a fifth 0.7 to 0.9, each lit and shaded as a dome,
// drew the meadow from the game's view as a field of lumps rather than one sward. Off with
// `flags=grassClumps:false` at load.
const CLUMP = {
	cell: 0.9, own: 0.05, rimGap: 0, rim: 0.7, cap: 2, same: 0.8,
	types: [
		{ share: 0.25, height: [ 1.05, 1.15 ], full: 0 },
		{ share: 0.55, height: [ 0.95, 1.05 ], full: 0 },
		{ share: 0.2, height: [ 0.88, 0.95 ], full: 1 },
	],
} as const;
const CLUMPS = debugFlags.grassClumps !== false;
// The blades' colour by their clump (the technique of Wohllaib, GDC 2021: a 2D
// gradient whose v runs along the blade, dark at the root and light at the tip, and whose u the
// blade's clump picks rather than each blade drawing its own colour, so a field shows splashes of
// colour): each clump takes a place on the palette's run (fresh green, yellow green, olive: PALETTE)
// and a value, its stroke's, the cell of a coarser Voronoi lattice of `cell` (m) its centre falls in,
// with `own` of the run and of the value's draw its own; the value varies by `value` either way.
// The place rides in the tuft's record (`tint`, Tuft) to the fragment stage, where each blade takes
// BLADE_TINT.run of the run about it and BLADE_TINT.value of a value its own. Strokes of a few
// clumps read from the game's view as a painter's strokes over the lawn; a clump's own colour, under
// a metre, cut the lawn's grain at the blades' scale by a tenth there and showed no strokes.
const STROKE = { cell: 3, own: 0.15, value: 0.1 };
const BLADE_TINT = { value: 0.06, run: 0.1 };
// Far off, a blade takes its clump's normal (its tuft's up turned by the gust's tilt), unfolded, and loses FAR.sheen of its gloss, so blades lean their normals
// toward their clump's with the distance and drop their gloss (the variance of their normals under a
// pixel): the share rises from none where the tuft stands FAR.pixels[ 1 ] pixels tall on screen to
// `share` where it stands FAR.pixels[ 0 ], so a gust sweeps the far meadow as a sheen of whole
// clumps rather than a glitter of blades. A function of the tuft and the current camera, so a
// paused frame repeats. `flags=grassFar:<k>` scales it at load (0: off).
const FAR = { share: 0.8 * ( typeof debugFlags.grassFar === 'number' ? debugFlags.grassFar : 1 ), pixels: [ 8, 40 ], sheen: 0.7 };
interface Clump { cx: number; cz: number; t: number; type: number; height: number; turn: number; value: number; tint: number; blades: number }
const _clump: Clump = { cx: 0, cz: 0, t: 0, type: 0, height: 1, turn: 0, value: 0.5, tint: 0.5, blades: 0.5 };
/** The stroke whose cell holds ( x, z ) (STROKE): its value and its place on the palette's run. */
function strokeAt( x: number, z: number ): { value: number; tint: number } {

	const cell = STROKE.cell, ci = Math.floor( x / cell ), cj = Math.floor( z / cell );
	let best = Infinity, bi = 0, bj = 0;
	for ( let j = cj - 1; j <= cj + 1; j ++ ) for ( let i = ci - 1; i <= ci + 1; i ++ ) {

		const r = cellStream( i, j, 503 );
		const d = Math.hypot( x - ( i + r() ) * cell, z - ( j + r() ) * cell );
		if ( d < best ) { best = d; bi = i; bj = j; }

	}
	const r = cellStream( bi, bj, 503 );
	r(); r();
	return { value: r(), tint: r() };

}
// The clump at ( x, z ): the nearest of the 3 x 3 cells' centres, `t` the way from it toward the
// border (0 at the centre, 1 where the next nearest is as near), its draws from its cell's stream.
function clumpAt( x: number, z: number ): Clump {

	const ci = Math.floor( x / CLUMP.cell ), cj = Math.floor( z / CLUMP.cell );
	let best = Infinity, next = Infinity, bi = 0, bj = 0, bx = 0, bz = 0;
	for ( let j = cj - 1; j <= cj + 1; j ++ ) for ( let i = ci - 1; i <= ci + 1; i ++ ) {

		const r = cellStream( i, j, 401 );
		const px = ( i + r() ) * CLUMP.cell, pz = ( j + r() ) * CLUMP.cell, d = Math.hypot( x - px, z - pz );
		if ( d < best ) {

			next = best;
			best = d; bi = i; bj = j; bx = px; bz = pz;

		} else if ( d < next ) next = d;

	}
	const r = cellStream( bi, bj, 401 );
	r(); r();
	const pick = r();
	let type = 0;
	for ( let acc = 0; type < CLUMP.types.length - 1; type ++ ) if ( pick < ( acc += CLUMP.types[ type ].share ) ) break;
	const T = CLUMP.types[ type ];
	_clump.cx = bx; _clump.cz = bz;
	_clump.t = Math.min( 2 * best / ( best + next ), 1 );
	_clump.type = type;
	_clump.height = T.height[ 0 ] + ( T.height[ 1 ] - T.height[ 0 ] ) * r();
	r(); // (the draw of a mound's outward lean, kept so the later draws stay)
	_clump.turn = r() * Math.PI * 2;
	_clump.value = r();
	_clump.tint = r();
	_clump.blades = r();
	return _clump;

}
// The sward follows its soil (Meadow.ts SWARD_SOIL): a tall tussock's level is the ordinary level
// times LUSH (from the first at the vigour VIGOUR_LUSH[ 0 ] to the second at VIGOUR_LUSH[ 1 ]), no
// taller than the tallest tussock of the ordinary level (the meadow's bounds hold); and in a pocket
// of shallow soil (`meadowShallow`) THIN_GAP of the tussocks leave a gap, each by its own draw.
// So deep, damp ground grows a slightly taller sward: no line and no zone (two levels by the soil,
// 4 times apart over 2 - 4 m, read as a mower's line).
const LUSH = [ 0.88, 1.15 ], VIGOUR_LUSH = [ 0.25, 0.75 ], THIN_GAP = 0.1;
// A tussock stands part of the way from its tall level down to the short turf's (its `short`, 0 to
// 1, the level, spread and share of blades blended by it), as far as its spot pulls it (the `pull`:
// a pocket of shallow soil or a low patch, their weights falling over their frayed rims) answered by
// a draw of its own: GRADE.stand of the tussocks keep their level whatever the pull, the rest come
// down by `answer` (the least and the most) times it. So the sward slopes down into a pocket over its
// rim, a tussock lower here and there, and tall tussocks still stand in its middle. Two levels, the
// short turf's or the tall sward's by a draw against the pull, drew every pocket and every low
// flower's patch as a hollow with a wall of tall tussocks round it.
const GRADE = { stand: 0.25, answer: [ 0.55, 1.15 ] };
// A low species' flowering tuft (the zhuyu: it grows among shorter grass) stands
// at least LOW_FLOWER of the way down, a tall species' at its tall level; its neighbours stand as
// their own spot has them (a low species' patch cut every tussock in it to the short turf, a hollow).
const LOW_FLOWER = 0.55;
// A tussock's word in its colour's fourth channel: its stiffness (STIFF_RANGE, a byte), its lean
// (a byte) and the lean's direction in its own frame (a byte), packed as integers under 2^24 so a
// float holds them exactly.
const STIFF_RANGE = [ 0.5, 3 ];
// The tussocks at the lip stand (they stiffen by LIP_STIFF times the lip's `spill`): grown long, the
// blades that arc out over the edge drooped down the cliff as a fringe of fur.
const LIP_STIFF = 0.1;
// The turf rolls over a rounded shoulder (a sea cliff's turf mat): over its last SHOULDER (m) the
// tufts lean out by the square of the way there (SHOULDER_LEAN: the least and the most more), each
// toward its own side of straight out (within SHOULDER_TURN, rad, either way), and stand a little
// lower (SHOULDER_LOW), wind-cropped, so the sward bends toward the edge rather than standing up to
// a line it folds down from. (Every tuft leaning straight out by much the same drew the short
// turf's straight blades at the edge as a comb of parallel strands.)
const SHOULDER = 1.2, SHOULDER_LEAN = [ 0.3, 1.0 ], SHOULDER_TURN = 0.6, SHOULDER_LOW = [ 0, 0.1 ];

// The wall an edge tuft's blades lie on: its outward offset from the coast (m, `holdOff`) at every
// LIP_DEPTH (m) under the roof, LIP_WALLS of them, from the roof down: the first at the coast
// itself, the rest the worker's (RimGround.ts LIP_WALL, 10 cm apart), each LIE farther out, and
// each blade up to LIE_SPREAD (m) farther again by a hash of its own, so the blades lying on the stone
// do not lie in one sheet. A point is held out by a smooth maximum over HOLD_SOFT (m), so a blade
// meeting the stone bends onto it rather than kinking, and the hold eases in over HOLD_ROOT (m) from
// the root, which sits on the ground the profile only approximates, and over HOLD_INLAND (m) inland of
// the coast to none (the turf's shoulder, not the stone, lies there).
const LIP_DEPTH = 0.1, LIP_WALLS = 16, LIE = 0.012, LIE_SPREAD = 0.04, HOLD_SOFT = 0.03, HOLD_ROOT = [ 0.01, 0.05 ], HOLD_INLAND = 0.04;
// The meadow at the edge: its tufts rooted within EDGE_REACH (m) of the cliff's edge carry the
// edge (`edgeTuftSteps`), and DRAPE_SHARE of their blades, by a hash of their own, flop over it: the
// part past it bends down over it (`drape`) round a curl of DRAPE_RADIUS (m, the least and the
// most, by the blade, times the square root of its tussock's stiffness) and then hangs; the others
// keep their own shape out over the edge, as a free blade does, held off the stone where they meet
// it. So the sward rolls over the edge, the more of a tuft the nearer it roots (a separate fringe of
// tufts along the edge read as a row of eyelashes and broke into clumps), with blades arching out
// over it among the hanging ones. Every blade draped round a curl of 8 to 20 cm drew every part of it
// past the edge as a vertical line just outside it, lying on the stone at one offset: from the game's
// view a comb of parallel bright strands along the whole lip. EDGE_PAD (m) widens such a tuft's
// cull sphere for the drape's reach.
const EDGE_REACH = 1, DRAPE_SHARE = 0.35, DRAPE_RADIUS = [ 0.12, 0.4 ], EDGE_PAD = 0.05;

// The meadow's flowers are heads on some of its lawn tufts (`flowerTuftGeometry`), each species in
// swaths of its own, one kind to a swath as if painted
// there by a giant brush stroke (Wohllaib, GDC 2021) rather than many kinds intermingled. They are
// Penglai's, after the texts on the immortals' islands:
// - The yaoxiang (遙香草) of Daiyu, "its flowers like cinnabar, shining to the moon, its leaves long,
//   narrow and white, like the day lily's" (Wang Jia, Shiyi ji, book 10): a day lily's form, cinnabar
//   flowers gold in the throat, pale silvery leaves (the tussock's colour, LEAVES), the most in the
//   sheltered sward and where the soil is deep or damp.
// - The zhuyu (祝餘) of Zhaoyao mountain, "like chives, with blue-green flowers; who eats it is not
//   hungry" (Shanhai jing, Nanshan jing): chives' leaves, blue-green (LEAVES), a round head of sky
//   blue florets on a stalk over them, low among short turf: the exposed coast's wind-cropped turf,
//   the shallow pockets and dry ground (the habitat fields, `meadowMoisture`, `meadowTurf` and
//   `meadowShallow`, Meadow.ts).
const YAOXIANG = 0, ZHUYU = 1;
/** The flower heads by number (a flowering tuft's code is 1.5 + its number), for probes. */
export const FLOWER_SPECIES = [ 'yaoxiang', 'zhuyu' ];
// A flowering tussock's leaves (its colour times these, linear): the yaoxiang's pale and silvery, the
// zhuyu's a chive's blue-green.
const LEAVES = [ [ 1.9, 1.5, 2.8 ], [ 0.8, 1, 1.7 ] ];
// The swaths: the cells of a world-anchored Voronoi lattice of `cell` (m), each centre jittered over
// its cell; one cell in each block of `block` x `block` cells flowers, the first in an order the
// block draws whose centre lies on the meadow (LAND m in from the edge) and clear of the bamboo
// (GROVE_CLEAR m from a stand's centre: its shade, where a sunlit meadow's flowers do not bloom), so
// the swaths spread evenly and even the small starting island holds a few (a cell's own draw left
// it one or none). Each is of one species, drawn by the habitat's weights at its centre. In a swath
// `peak` of the tufts flower, out to `edge[ 0 ]` of the way from its centre to its border, thinning
// to none at `edge[ 1 ]`: a broad swath with a soft rim. The peak keeps the meadow's count of
// flowers (about one tuft in twelve, `tools/verify-world-stats.mjs`), so the island's flowers are
// a few broad swaths where they were many small drifts: from the game's view the drifts, a metre or
// two across and strung along the coast, read as a scatter of specks over the whole island top, the
// swaths as strokes of one colour. None within FLOWER_LIP (m from the edge: from the first to the
// second) of the cliff's edge, where its tufts drape over it. As the island grows, a block at the
// coast may move its swath onto the new land.
const SWATH = { cell: 6, block: 2, peak: 0.6, edge: [ 0.55, 0.92 ] };
const LAND = - 1.2;
const FLOWER_LIP = [ - 0.6, - 0.35 ], GROVE_CLEAR = BAMBOO.radius;
// Between the swaths STRAY of the tufts flower alone, of the species their own spot favours. None
// on the rock stacks or within FLOWER_CLEAR (m) of the islander's walking loop (WalkLoop.ts),
// where the walker's legs pass.
const STRAY = 0.007, FLOWER_CLEAR = 0.5;

/** The species' weights in the habitat of moisture `wet`, sward `tall` and shallow soil `shallow`
 * (Meadow.ts): the yaoxiang anywhere, the more in the sheltered sward and where it is deep or damp;
 * the zhuyu in the exposed coast's short turf, the shallow pockets and on dry ground. */
function habitat( wet: number, tall: number, shallow: number, out: number[] ): number[] {

	out[ YAOXIANG ] = 0.45 + 0.6 * smoothstep( 0.35, 0.65, tall ) + 0.8 * smoothstep( 0.5, 0.72, wet );
	out[ ZHUYU ] = 1.2 * smoothstep( 0.45, 0.15, tall ) + 0.7 * shallow + 0.4 * smoothstep( 0.42, 0.22, wet );
	return out;

}

/** The species a habitat's weights `w` give the draw `u` (0 to 1). */
function pickSpecies( w: number[], u: number ): number {

	let at = u * w.reduce( ( a, b ) => a + b, 0 );
	for ( let s = 0; s < w.length; s ++ ) {

		if ( at < w[ s ] ) return s;
		at -= w[ s ];

	}
	return w.length - 1;

}

/** The meadow's flower swaths (SWATH): a function of position, the land's edge and the bamboo's
 * stands, each cell's and block's draws their own. */
class FlowerSwaths {

	private weights = [ 0, 0 ];
	private chosen = new Map<number, number>();
	private turfAt: ( x: number, z: number ) => number;
	private rimAt: ( x: number, z: number ) => number;
	private grove: ArrayLike<number>;

	/** `turfAt`: the sward the soil grows at a point (Meadow.ts `meadowTurf`); `rimAt`: the distance
	 * to the cliff's edge (m, negative inland; RimGround.ts); `grove`: the bamboo stands, x, z and
	 * depth each (Bamboo.ts). */
	constructor( turfAt: ( x: number, z: number ) => number, rimAt: ( x: number, z: number ) => number, grove: ArrayLike<number> = [] ) {

		this.turfAt = turfAt;
		this.rimAt = rimAt;
		this.grove = grove;

	}

	/** The cell ( i + 65536 j ) that flowers in block ( bi, bj ), or NaN if none of its cells can. */
	private blockCell( bi: number, bj: number ): number {

		const key = bi * 65536 + bj;
		const known = this.chosen.get( key );
		if ( known !== undefined ) return known;
		const n = SWATH.block * SWATH.block, order = Array.from( { length: n }, ( _, k ) => k ), r = cellStream( bi, bj, 607 );
		for ( let k = n - 1; k > 0; k -- ) {

			const m = Math.floor( r() * ( k + 1 ) );
			[ order[ k ], order[ m ] ] = [ order[ m ], order[ k ] ];

		}
		let found = NaN;
		for ( const k of order ) {

			const i = bi * SWATH.block + k % SWATH.block, j = bj * SWATH.block + Math.floor( k / SWATH.block );
			const c = cellStream( i, j, 601 ), x = ( i + c() ) * SWATH.cell, z = ( j + c() ) * SWATH.cell;
			if ( this.rimAt( x, z ) >= LAND ) continue;
			let shaded = false;
			for ( let g = 0; g < this.grove.length; g += 3 ) if ( Math.hypot( x - this.grove[ g ], z - this.grove[ g + 1 ] ) < GROVE_CLEAR ) shaded = true;
			if ( shaded ) continue;
			found = i + 65536 * j;
			break;

		}
		this.chosen.set( key, found );
		return found;

	}

	/** The flower head of the swath at ( x, z ), `rim` m from the edge, and the share of its tufts
	 * that flower there (0 between the swaths). */
	at( x: number, z: number, rim: number ): { head: number; share: number } {

		const cell = SWATH.cell, ci = Math.floor( x / cell ), cj = Math.floor( z / cell );
		let best = Infinity, next = Infinity, bi = 0, bj = 0, bx = 0, bz = 0;
		for ( let j = cj - 1; j <= cj + 1; j ++ ) for ( let i = ci - 1; i <= ci + 1; i ++ ) {

			const r = cellStream( i, j, 601 );
			const px = ( i + r() ) * cell, pz = ( j + r() ) * cell, d = Math.hypot( x - px, z - pz );
			if ( d < best ) {

				next = best;
				best = d; bi = i; bj = j; bx = px; bz = pz;

			} else if ( d < next ) next = d;

		}
		if ( this.blockCell( Math.floor( bi / SWATH.block ), Math.floor( bj / SWATH.block ) ) !== bi + 65536 * bj ) return { head: - 1, share: 0 };
		const r = cellStream( bi, bj, 601 );
		r(); r();
		const head = pickSpecies( habitat( meadowMoisture( bx, bz ), this.turfAt( bx, bz ), meadowShallow( bx, bz ), this.weights ), r() );
		const t = Math.min( 2 * best / ( best + next ), 1 );
		return { head, share: SWATH.peak * ( 1 - smoothstep( SWATH.edge[ 0 ], SWATH.edge[ 1 ], t ) ) * ( 1 - smoothstep( FLOWER_LIP[ 0 ], FLOWER_LIP[ 1 ], rim ) ) };

	}

	/** The head a stray flower at ( x, z ), `rim` m from the edge, takes by its own spot's habitat
	 * (the draw `u`), or -1 where no flower grows. */
	stray( x: number, z: number, rim: number, u: number ): number {

		if ( rim > FLOWER_LIP[ 0 ] ) return - 1;
		return pickSpecies( habitat( meadowMoisture( x, z ), this.turfAt( x, z ), meadowShallow( x, z ), this.weights ), u );

	}

}

/** The meadow's cost knobs for a quality tier. They shape the meshes and shaders, so they apply
 * when the grass is planted and built (set them before `plantGrass`); the defaults are the high tier's. */
export interface GrassQuality {
	/** Lawn blades drawn per tuft (of 48) at the camera distances `bladeBands`: the first count up
	 * to the first distance, easing linearly to the second count at the second distance and to the
	 * third at the third, and the third beyond (see `tuftLod`). The counts change the cost only:
	 * the kept blades cover for the rest at every count. */
	lawnBlades: [ number, number, number ];
	/** Camera distances (m) from a tuft where its blade counts `lawnBlades` apply. */
	bladeBands: [ number, number, number ];
	/** Whether the extra tufts of thick patches exist at all. */
	thinTufts: boolean;
	/** Camera distances (m) over which the extra tufts fold into their roots; past the second the
	 * cull drops them (1e4: never). */
	thinFold: [ number, number ];
	/** Light through the canopy per vertex instead of per pixel: the dapple inside a blade is
	 * lost close up, so it suits the lower tiers only. */
	canopyPerVertex: boolean;
	/** The least width of a blade on screen (render pixels, see `pixelWideBlade`) under the
	 * temporal modes; 4x multisampling keeps 2 and one sample outside them 1. */
	minWidth: number;
}
const grassQuality: GrassQuality = { lawnBlades: [ 24, 12, 6 ], bladeBands: [ 20, 40, 70 ], thinTufts: true, thinFold: [ 1e4, 1e4 + 12 ], canopyPerVertex: false, minWidth: 0 };

export function setGrassQuality( quality: Partial<GrassQuality> ): void {

	Object.assign( grassQuality, quality );

}

function tuftGeometry( shape: TuftShape, seed = 3 ) {

	const rng = mulberry32( seed );
	const range = ( [ a, b ]: [ number, number ] ) => a + rng() * ( b - a );
	const { blades, segs } = shape;
	// position: the blade's root plus its half width across at this level (x, z) and, in y, the
	// direction it bends toward in the tuft's plane (rad: out from the tuft's axis); blade: its
	// parameter along its length, the angle of its width axis in the tuft's plane (across the
	// direction it bends), its half width there and its side ( -1, 1 ) times one plus its hash within
	// the tuft (the vertex stage shapes the blade, turns the width axis and reads the side for the
	// fold, `restBlade`, `grassMaterial`)
	const P: number[] = [], N: number[] = [], T: number[] = [], I: number[] = [];
	for ( let b = 0; b < blades; b ++ ) {

		const a = rng() * Math.PI * 2;
		const r0 = shape.r0[ 0 ] + Math.sqrt( rng() ) * ( shape.r0[ 1 ] - shape.r0[ 0 ] ); // even over the disc
		const ox = Math.cos( a ) * r0, oz = Math.sin( a ) * r0;
		const w = range( shape.w );
		const id = rng();
		const tw = a + Math.PI / 2 + ( rng() - 0.5 ) * 0.5; // width axis, across the bend, a little twisted
		const wx = Math.cos( tw ), wz = Math.sin( tw );
		const base = P.length / 3;
		for ( let i = 0; i <= segs; i ++ ) {

			// the shape's levels along the blade (LAWN_ROWS); its width keeps most of itself (0.7) to
			// two thirds up and runs to a point
			const t = shape.rows[ i ];
			const hw = w * 0.5 * Math.sqrt( Math.max( 1 - t * t, 0 ) );
			for ( const sg of [ - 1, 1 ] ) {

				const px = ox + wx * hw * sg, pz = oz + wz * hw * sg;
				P.push( px, a, pz );
				const l = Math.hypot( px, 0.9, pz );
				N.push( px / l, 0.9 / l, pz / l );
				T.push( t, tw, hw, sg * ( 1 + id ) );

			}

		}

		for ( let i = 0; i < segs; i ++ ) {

			const k = base + i * 2;
			I.push( k, k + 1, k + 2, k + 1, k + 3, k + 2 );

		}

	}

	const g = new THREE.BufferGeometry();
	g.setAttribute( 'position', new THREE.Float32BufferAttribute( P, 3 ) );
	g.setAttribute( 'normal', new THREE.Float32BufferAttribute( N, 3 ) );
	g.setAttribute( 'blade', new THREE.Float32BufferAttribute( T, 4 ) );
	g.setIndex( I );
	// The box of the blades' roots up to the longest blade's length (`restBlade`), and how far beyond
	// it a blade may reach in every direction (`reach`, in units of the tuft's height scale, which the
	// cull scales by the tuft's own: a blade's shape is isotropic in metres while the tuft's scale is
	// not): the cull bounds a tuft by both (`tuftSphere`).
	// The halfWidth below is the root half width of the widest blade, which the cull pads for the widening.
	g.userData.halfWidth = shape.w[ 1 ] * 0.5 * GRASSES.broad.width + 0.004;
	const out = shape.r0[ 1 ] + shape.w[ 1 ];
	g.userData.restBox = new THREE.Box3( new THREE.Vector3( - out, 0, - out ), new THREE.Vector3( out, HEIGHT_MAX, out ) );
	g.userData.reach = HEIGHT_MAX;
	// (the position's y holds the blade's direction, not a height: three's bounds of the tuft, which
	// the water's check of its reflection's box reads, take the box the blades reach instead, at the
	// rim's tussocks' height scale: an ordinary one's at most, the tallest lying inland)
	const across = HEIGHT_MAX / ( 1 + SHEAR ) * LEVEL.ordinary * 1.25;
	g.boundingBox = g.userData.restBox.clone().expandByVector( new THREE.Vector3( across, 0, across ) );
	return g;

}

// A flowering tuft: the lawn tuft's blades, one flower head, a flat disc of HEAD_SECTORS
// triangles round a centre, and its stem, a narrow strip of STEM_SEGS segments from the tuft's root
// to the head. The head's and the stem's vertices follow the blades' (so a blade's index by vertex,
// `tuftLod`, is unchanged), and their indices come first: every draw range and band of the batch
// starts with them (`baseIndices`), so a far tuft that drops blades always keeps its flower.
// A head vertex carries `blade` = ( 1, its angle, its radius 0 or 1, HEAD_FLAG ) and in its
// position's x its place across a petal: 0 at the centre, -1 and 1 on alternate rim vertices, so
// the fragment stage reads where it lies across its sector's petal (`headShape`) without an atan.
// A stem vertex carries ( its parameter along the stem, 0, its half width STEM_HALF, its side times
// STEM_FLAG ), its position's x its offset across, so its centreline starts at the tuft's axis.
const HEAD_SECTORS = 10;
const HEAD_FLAG = 3, STEM_FLAG = 4, STEM_SEGS = 4, STEM_HALF = 0.0015;
function flowerTuftGeometry( lawn: THREE.BufferGeometry ): THREE.BufferGeometry {

	const P = Array.from( lawn.getAttribute( 'position' ).array as Float32Array );
	const N = Array.from( lawn.getAttribute( 'normal' ).array as Float32Array );
	const T = Array.from( lawn.getAttribute( 'blade' ).array as Float32Array );
	const centre = P.length / 3;
	P.push( 0, 0, 0 ); N.push( 0, 1, 0 ); T.push( 1, 0, 0, HEAD_FLAG );
	for ( let i = 0; i < HEAD_SECTORS; i ++ ) {

		P.push( i % 2 === 0 ? - 1 : 1, 0, 0 ); N.push( 0, 1, 0 ); T.push( 1, i / HEAD_SECTORS * Math.PI * 2, 1, HEAD_FLAG );

	}
	const head: number[] = [];
	for ( let i = 0; i < HEAD_SECTORS; i ++ ) head.push( centre, centre + 1 + i, centre + 1 + ( i + 1 ) % HEAD_SECTORS );
	const stem = P.length / 3;
	for ( let i = 0; i <= STEM_SEGS; i ++ ) for ( const sg of [ - 1, 1 ] ) {

		P.push( STEM_HALF * sg, 0, 0 ); N.push( 0, 1, 0 ); T.push( i / STEM_SEGS, 0, STEM_HALF, sg * STEM_FLAG );

	}
	for ( let i = 0; i < STEM_SEGS; i ++ ) {

		const k = stem + i * 2;
		head.push( k, k + 1, k + 2, k + 1, k + 3, k + 2 );

	}
	const g = new THREE.BufferGeometry();
	g.setAttribute( 'position', new THREE.Float32BufferAttribute( P, 3 ) );
	g.setAttribute( 'normal', new THREE.Float32BufferAttribute( N, 3 ) );
	g.setAttribute( 'blade', new THREE.Float32BufferAttribute( T, 4 ) );
	g.setIndex( [ ...head, ...Array.from( lawn.getIndex()!.array ) ] );
	// the head rises past the blades' box (`headPose`: at most 0.5 of the tuft's height, a yaoxiang's
	// disc 0.14 m across near the camera and a widened one about 0.3 m far off) by less than the
	// box's bounding sphere and the cull's pad leave (WIDEN_REACH, about 0.7 m far off, and SWAY_PAD);
	// its stem stays within the blades' reach
	g.userData.restBox = lawn.userData.restBox;
	g.userData.reach = lawn.userData.reach;
	g.boundingBox = lawn.boundingBox!.clone();
	g.userData.halfWidth = lawn.userData.halfWidth;
	g.userData.baseIndices = head.length;
	return g;

}

// Thin blades alias. Their tips are a few millimetres wide, a fraction of a pixel from the
// overview, so 4x MSAA catches them on some frames and misses them on others and the meadow
// crawls as the camera moves. Each blade is kept at least `minWidth` pixels wide on screen,
// widened across the view, and its coverage falls by the same factor, so it hides as much of the
// ground as the thin blade did at every distance. This is the treatment of thin wires after Emil
// Persson ("Phone-wire AA", Humus, 2012). Two pixels brought a slow orbit's meadow flicker most of
// the way to a supersampled render's; wider ones soften the blades further for little gain. At 4x
// a blade keeps 1.5: high's 24 blades a tuft (Quality.ts) draw a third thinner at the island
// view than 16 at two pixels, with the same flicker relative to the many-sample reference; one
// pixel under 32 or 48 blades grained more against it. The coverage is not drawn as partly covered pixels but as whole
// blades (`grassMaterial`'s opacity): a blade draws solid where its coverage is above its own hash.
// Without multisampling a blade keeps one pixel (a blade dithered at half its pixels across two
// read as a dotted line, sharpened further by the upscale, and one pixel kept the meadow's
// brightness as at two). Under the temporal modes a blade keeps the tier's `minWidth` (set by
// `buildGrass`; two pixels on the parked tiers, where one darkened the meadow and lost the flower
// heads between the blades).
// The outer rim's least width (`rimEdge` in plantGrass), never above the meadow's (`buildGrass`).
const RIM_MIN_WIDTH = 0.75;
const grassUniforms = {
	minWidth: uniform( ALPHA_TO_COVERAGE ? 1.5 : 1 ), // render-target pixels
	rimMinWidth: uniform( RIM_MIN_WIDTH ), // on the outer rim, see `rimEdge` in plantGrass
	// The extra lawn tufts of thick patches fold away between these view distances (m): beyond
	// them a blade is under a pixel wide and the widened blades of the remaining tufts already
	// cover the turf, so the extras would only cost vertices.
	thinNear: uniform( 1e4 ),
	thinFar: uniform( 1e4 + 12 ),
};
// Beyond this the blade is seen nearly edge on; widening further would only smear it.
const MAX_WIDEN = 8;
const bladeCoverage = varyingProperty( 'float', 'vGrassBladeCoverage' );
// A tuft drawing c of its n blades (`tuftLod`) widens and covers with each kept blade n / c times
// as much (its gain), so the meadow hides as much ground as with every blade: a kept blade stands
// in for the dropped ones beside it. 1 with every blade drawn. The stand-in only holds where a
// blade is a few pixels across: a blade seen 16 or more pixels wide keeps its own width and
// coverage (gain 1), or near tufts with fewer blades would draw each one several times as broad
// and solid. Between 16 and 4 pixels the gain eases in.
const GAIN_FULL_PIXELS = 4;
const GAIN_NONE_PIXELS = 16;

type V3 = THREE.Node<'vec3'>;
type F = THREE.Node<'float'>;

// Per object: whether this draw thins the tufts by distance (`grassLod`, set by `selectBatch` for
// the view camera's draws and copied onto the prepass's depth copy), and per geometry the tuft's
// blades and the vertices of one blade (its blades follow one another in the index order).
const lodOn = uniform( 0 ).onObjectUpdate( ( { object } ) => object?.userData.grassLod === true ? 1 : 0 );
const tuftBlades = uniform( 16 ).onObjectUpdate( ( { object } ) => ( object as THREE.Mesh | undefined )?.geometry?.userData.grassBlades ?? 16 );
const tuftFloor = uniform( 0 ).onObjectUpdate( ( { object } ) => ( object as THREE.Mesh | undefined )?.geometry?.userData.grassFloor ?? 0 );
const bladeVerts = uniform( 6, 'uint' ).onObjectUpdate( ( { object } ) => ( object as THREE.Mesh | undefined )?.geometry?.userData.grassBladeVerts ?? 6 );
// The blade-count curve (`GrassQuality.lawnBlades` over `bladeBands`), the counts as shares of
// the lawn's 16; set by `buildGrass`.
const lodUniforms = { bands: uniform( new THREE.Vector3( 25, 45, 70 ) ), shares: uniform( new THREE.Vector3( 1, 0.5, 0.25 ) ) };
// Beyond the curve's last distance a tuft keeps its last count times vegetation/Lod.ts's share by
// distance, but never fewer than this many blades: one widened blade, even drawn as strips, read
// at the island view as long parallel streaks where the four blades showed a fine grain; two keep
// the grain at about half the four's cost.
const LEAST_BLADES = 2;
// Each tuft's cutoffs move out by up to this share of its distance (a hash of its anchor), so
// neighbouring tufts drop a given blade at different distances and no ring of half-narrowed
// blades forms around the camera; never in, so a tuft within the first band keeps every blade.
const LOD_STAGGER = 0.1;
// The cull's view of the curve: it bands the tufts by the same count (`bladeCount`); `on` follows
// `flags.grassLod` for the view's draws, `bands` `flags.grassBands` (false: every tuft in its
// batch's first band, the one draw of before, for A/Bs).
// `pad` is how much farther than its sphere's pad (WIDEN_REACH) a far tuft's widened blades reach.
const cullLod = {
	count: ( origin: V3, camera: V3, blades: F, floor: F, on: F ) => bladeCount( origin, camera, blades, floor, on ), on: uniform( 1 ), bands: uniform( 1, 'uint' ),
	pad: ( count: F, blades: F ) => max( blades.div( count ).sub( NEAR_GAIN ), 0 ).mul( MAX_WIDEN * PAD_HALF_WIDTH ),
};

/** The share of its blades a tuft of floor `floor` keeps at `distance` (m) from the view camera,
 * the curve `tuftLod` follows ( 1 near on high ); the batches' draw ranges take it at their nearest
 * tuft. */
function bladeShare( distance: number, floor: number ): number {

	const [ b0, b1, b2 ] = grassQuality.bladeBands, [ c0, c1, c2 ] = grassQuality.lawnBlades;
	const s = ( x: number ) => Math.min( Math.max( x, 0 ), 1 );
	const near = ( c0 + ( c1 - c0 ) * s( ( distance - b0 ) / ( b1 - b0 ) ) + ( c2 - c1 ) * s( ( distance - b1 ) / ( b2 - b1 ) ) ) / LAWN.blades;
	return Math.max( near * screenShare( distance, b2 ), floor, LEAST_BLADES / LAWN.blades );

}

// The cull's bands as shares of a tuft's blades (vegetation/VegetationCull.ts): a visible tuft draws in the band of
// the least cap at or above the blades it keeps. Six bands of a lawn tuft (16, 12, 8, 6, 4 and,
// from the least a tuft keeps, LEAST_BLADES, 2 on high) leave about a blade and a half of waste
// in the 25 to 45 m ring and one beyond, a blade at most past 70 m; each band is a draw of its own
// (and one of the depth prepass), most of them nearly empty in close views.
const BAND_SHARES = [ 1, 0.75, 0.5, 0.375, 0.25 ];

/** A batch's band caps (blades, descending): its most at the tier's nearest share (all its blades
 * without `grassLod`, through the first band's draw range), the shares above between, and its
 * least at the fewest a visible tuft of it keeps (`minShare`: the curve's last, or the thin tufts'
 * share at their fold). */
function bandCaps( blades: number, floor: number, minShare: number ): number[] {

	const top = Math.min( blades, Math.ceil( blades * Math.max( ...grassQuality.lawnBlades.map( ( c ) => c / LAWN.blades ), floor ) - 1e-6 ) );
	const least = Math.min( top, Math.ceil( blades * Math.max( minShare, floor ) - 1e-6 ) );
	const caps = [ top ];
	for ( const share of BAND_SHARES ) {

		const cap = Math.ceil( blades * share - 1e-6 );
		if ( cap < caps[ caps.length - 1 ] && cap > least ) caps.push( cap );

	}
	if ( least < caps[ caps.length - 1 ] ) caps.push( least );
	return caps;

}

// The blades a tuft keeps (`tuftLod`), as a node: also the cull's, which bands the tufts by it
// (VegetationCull's `CullLod`), so both compute it alike.
function bladeCount( origin: V3, camera: V3, blades: F, floor: F, on: F ): F {

	const stagger = fract( sin( dot( origin.xz, vec2( 39.3468, 11.1351 ) ) ).mul( 24634.6345 ) );
	const d = length( camera.sub( origin ) ).mul( float( 1 ).sub( stagger.mul( LOD_STAGGER ) ) );
	const { bands, shares } = lodUniforms;
	const share = mix( shares.x, shares.y, clamp( d.sub( bands.x ).div( bands.y.sub( bands.x ) ), 0, 1 ) )
		.add( shares.z.sub( shares.y ).mul( clamp( d.sub( bands.y ).div( bands.z.sub( bands.y ) ), 0, 1 ) ) );
	// (the share by distance is exactly 1 within the last band and the least count under the
	// curve's there, so a tuft within 70 m keeps the count it had to the bit)
	const far = share.mul( screenShareNode( d, bands.z ) );
	return mix( blades, blades.mul( max( far, max( floor, float( LEAST_BLADES ).div( blades ) ) ) ), on );

}

// A tuft's blades by distance, after tidewater's GrassField tier fade (Daniel Greenheck, MIT;
// the technique only): the tuft keeps c of its n blades, c falling with its distance from the view
// camera along the curve above (never below its floor, `tuftFloor`), and blade b (blades are
// generated in a random order, so any first ones are a fair subset) keeps the share
// clamp( c - b, 0, 1 ) of its width: each blade narrows to nothing over the distance in which c
// falls by one, at its own distance, rather than a batch stepping between counts. A blade of zero
// width is a degenerate triangle pair, never rasterised, and the cull's bands leave out the blades
// at or past their cap (`bandCaps`).
// The kept widths sum to c, and the gain n / c widens them back to the tuft's whole width
// (`pixelWideBlade`). Off (other cameras, `flags.grassLod = false`) every blade keeps its width
// and the gain is 1. A tuft in thin soil's core keeps only the share `density` of those (plantGrass) at
// the same gain, so its cover falls by that share at every distance, the far lawn's included, and
// the ground shows between its blades. Returns the blade's width share and the tuft's gain.
function tuftLod( origin: V3, density: F ): { keep: F; gain: F } {

	const count = bladeCount( origin, cameraPosition, tuftBlades, tuftFloor, lodOn ).toVar();
	const blade = float( vertexIndex.div( bladeVerts ) );
	return { keep: clamp( count.mul( density ).sub( blade ), 0, 1 ), gain: tuftBlades.div( count ) };

}

// Returns the widened vertex and passes its coverage to the fragment stage. Positions are world
// positions: the meadow mesh stays at the origin, untransformed. `keep` narrows the blade (the
// share of its width it keeps, `tuftLod`) and `bladeGain` is its tuft's gain. A flower head's
// vertex (`head` 1) has no half width and keeps its place; its coverage is the head's own
// (`headPose`).
function pixelWideBlade( position: V3, halfWidth: V3, minWidth: F, keep: F, bladeGain: F, head: F, headCoverage: F ): V3 {

	return Fn( () => {

		const p = position.toVar();
		const toCamera = cameraPosition.sub( p ).toVar();
		const view = toCamera.div( max( length( toCamera ), 1e-4 ) ).toVar();
		// The half width as the view sees it: the part along the line of sight does not show.
		const seen = halfWidth.sub( view.mul( dot( halfWidth, view ) ) ).toVar();
		// Metres per pixel at this depth; ( 1, 1 ) of the projection is 1 / tan( fov / 2 ).
		const depth = max( cameraViewMatrix.mul( vec4( p, 1 ) ).z.negate(), 1e-3 );
		const p11 = ( cameraProjectionMatrix as unknown as { element( i: number ): { element( i: number ): F } } ).element( 1 ).element( 1 );
		const pixel = depth.mul( 2 ).div( p11.mul( screenSize.y ) );
		const halfSeen = max( length( seen ), 1e-6 ).toVar();
		// The blade's own width on screen in pixels sets how much of the tuft's gain applies;
		// written as 1 + ( gain - 1 ) * s so a gain of 1 stays exactly 1.
		const gainShare = float( 1 ).sub( smoothstepN( GAIN_FULL_PIXELS, GAIN_NONE_PIXELS, halfSeen.mul( 2 ).div( pixel ) ) );
		const gain = bladeGain.sub( 1 ).mul( gainShare ).add( 1 ).toVar();
		// A narrowing blade is widened from its narrowed width, so it keeps its coverage share
		// (keep 1 leaves every term as it was).
		const narrowed = max( halfSeen.mul( keep ), 1e-6 );
		const widen = clamp( minWidth.mul( 0.5 ).mul( pixel ).div( narrowed ), gain, gain.mul( MAX_WIDEN ) ).toVar();
		bladeCoverage.assign( mix( gain.div( widen ), headCoverage, head ) );
		return p.add( seen.mul( keep.mul( widen ).sub( 1 ) ) );

	} )() as V3;

}

// The tuft a vertex belongs to. The meadow's instance data lives in the cull's storage buffers,
// one slot per tuft (each batch from its own first slot, `grassBase`): the view camera's draws read
// the slot from the culled list it wrote, every other draw (the rain's collision bake, a draw with
// the cull switched off) takes each slot in turn, as an instanced draw of every tuft did.
const cullBase = uniform( 0, 'uint' ).onObjectUpdate( ( { object } ) => ( object as THREE.Mesh | undefined )?.geometry?.userData.grassBase ?? 0 );
const cullOn = uniform( 0, 'uint' ).onObjectUpdate( ( { object } ) => object?.userData.grassCulled === true ? 1 : 0 );
// 1 on the flowering batch (`flowerTuftGeometry`), the only one whose vertices take a head's pose
const flowering = uniform( 0, 'uint' ).onObjectUpdate( ( { object } ) => ( object as THREE.Mesh | undefined )?.geometry?.userData.grassFlowers ?? 0 );

const TAU = Math.PI * 2;

// A hash of a blade (its id within the tuft, `restBlade`) and its tuft's anchor (`pick`), one per
// `k`: every choice a blade makes, fixed to the world as the anchors are.
function bladeHash( id: F, pick: F, k: number ): F {

	return fract( sin( id.mul( 91.7 + k * 17.3 ).add( pick.mul( 37.3 + k * 11.1 ) ) ).mul( 43758.5453 ) );

}

// A blade's rest shape under its own weight (Physics.ts `drape`, the free cantilever of the meadow's
// section and taper), as a cubic Bezier from the root in the plane it bends in, in units of its
// length: x along its root's direction in the plane it stands on, y up (the load's opposite). The
// first control point lies along the root's direction (d1 of the length out), the other two are
// free; the five numbers are polynomials of degree 3 in s = G / 6 - 1 and c = ( angle - 1.225 ) /
// 0.225 (G 0 to G_MAX, the root angle 1.0 to 1.45 rad, ROOT_ANGLE), coefficients by s^i c^j, i fastest.
// Fitted by least squares to drape's 48-segment shapes on a 40 x 24 grid of the range, at equal arc
// length (the Bezier's parameter is the blade's): its nodes lie within 1.6 % of the length of
// drape's (0.2 % rms), its length within 1 % of the blade's, none below its root. Linear in G rather
// than log: a small bend is linear in the load, and in log G the fit missed the floppy end by 7 %.
// Under a combined load (the blade's weight and the wind's pressure, to come) the same curves hold
// in the frame of the load's direction: G becomes the combined load number and the angle the root's
// angle from the plane across it, and the shape turns with the frame.
const BLADE_CURVE = [
	[ 0.33591, 0.00829, 0.00985, 0.00421, - 0.00312, - 0.00771, - 0.00213, 0.00306, 0.00022, - 0.0008, - 0.00281, - 0.0018, 0.00042, 0.00097, - 0.00078, - 0.00154 ],
	[ 0.32828, 0.14534, 0.04277, - 0.00199, - 0.18505, - 0.03576, 0.03594, 0.02919, - 0.02515, - 0.03934, - 0.01244, 0.00982, 0.00198, - 0.00544, - 0.01174, - 0.00513 ],
	[ 0.58076, - 0.08204, - 0.05222, - 0.01665, 0.10536, 0.08254, 0.01515, - 0.01545, - 0.02463, - 0.00164, 0.01702, 0.00986, - 0.00506, - 0.00918, 0.00158, 0.00713 ],
	[ 0.55277, 0.29493, 0.03978, - 0.04809, - 0.28573, - 0.01663, 0.11732, 0.0583, - 0.05827, - 0.09765, - 0.00506, 0.05084, - 0.00064, - 0.02757, - 0.0285, 0.00033 ],
	[ 0.82573, - 0.22576, - 0.14448, - 0.03099, 0.20454, 0.19597, - 0.00075, - 0.07792, - 0.03584, 0.02323, 0.05552, 0.01724, - 0.01376, - 0.02216, 0.01789, 0.03004 ],
];

/** The blade's point at `t` (0 root, 1 tip) of its rest shape at gravity number `gravity` and root
 * angle `angle`, in units of its length: ( along, up, the tip's along ). */
const bladeCurve = Fn( ( [ gravity, angle, t ]: [ F, F, F ] ) => {

	const s = gravity.div( G_MAX / 2 ).sub( 1 ).toVar(), c = angle.sub( 1.225 ).div( 0.225 ).toVar();
	// Horner in s within each power of c, then in c
	const poly = ( k: number[] ) => {

		const inS = ( j: number ) => float( k[ j * 4 + 3 ] ).mul( s ).add( k[ j * 4 + 2 ] ).mul( s ).add( k[ j * 4 + 1 ] ).mul( s ).add( k[ j * 4 ] );
		return inS( 3 ).mul( c ).add( inS( 2 ) ).mul( c ).add( inS( 1 ) ).mul( c ).add( inS( 0 ) );

	};
	const [ d1, x2, y2, x3, y3 ] = BLADE_CURVE.map( poly );
	const u = float( 1 ).sub( t );
	const b1 = u.mul( u ).mul( t ).mul( 3 ), b2 = u.mul( t ).mul( t ).mul( 3 ), b3 = t.mul( t ).mul( t );
	const x3v = x3.toVar();
	return vec3(
		b1.mul( d1 ).mul( cos( angle ) ).add( b2.mul( x2 ) ).add( b3.mul( x3v ) ),
		b1.mul( d1 ).mul( sin( angle ) ).add( b2.mul( y2 ) ).add( b3.mul( y3 ) ),
		x3v,
	);

} ).setLayout( { name: 'meadowBladeCurve', type: 'vec3', inputs: [
	{ name: 'gravity', type: 'float' }, { name: 'angle', type: 'float' }, { name: 't', type: 'float' },
] } );

// A flower's stem is a strip of the blades' family of curves (`bladeCurve`), stiffer than a blade
// and bent a little by its head's weight: gravity number STEM_G from its steepest root angle
// STEM_ANGLE, scaled so that its tip reaches the head's height; the head sits on that tip
// (`headPose`). STEM_TIP is the curve's tip ( along, up ) in units of the stem's length.
const STEM_G = 1.2, STEM_ANGLE = 1.45;
const STEM_TIP = ( () => {

	const s = STEM_G / ( G_MAX / 2 ) - 1, c = ( STEM_ANGLE - 1.225 ) / 0.225;
	const poly = ( k: number[] ) => {

		const inS = ( j: number ) => ( ( k[ j * 4 + 3 ] * s + k[ j * 4 + 2 ] ) * s + k[ j * 4 + 1 ] ) * s + k[ j * 4 ];
		return ( ( inS( 3 ) * c + inS( 2 ) ) * c + inS( 1 ) ) * c + inS( 0 );

	};
	return [ poly( BLADE_CURVE[ 3 ] ), poly( BLADE_CURVE[ 4 ] ) ];

} )();

/** A tussock's own values in the vertex stage (from its word, `plantGrass`): its stiffness, its lean
 * (0 to 1), the lean's direction in the tuft's frame (local x, z) and its share of broad leaves
 * (COARSE). */
interface Tussock { stiffness: F; lean: F; dir: THREE.Node<'vec2'>; coarse: F }

/** A tussock's own values (`Tussock`) from its word (`plantGrass`: its stiffness, lean and the lean's
 * direction, a byte each) and its tuft's height scale `scaleY` (m). */
function tussockOf( word: F, scaleY: F ): Tussock {

	const high = floorN( word.div( 65536 ) ), rest = word.sub( high.mul( 65536 ) ), mid = floorN( rest.div( 256 ) ), lowByte = rest.sub( mid.mul( 256 ) );
	const leanAngle = high.mul( TAU / 256 );
	return {
		stiffness: lowByte.mul( ( STIFF_RANGE[ 1 ] - STIFF_RANGE[ 0 ] ) / 255 ).add( STIFF_RANGE[ 0 ] ).toVar(),
		lean: mid.div( 255 ).toVar(), dir: vec2( cos( leanAngle ), sin( leanAngle ) ).toVar(),
		// (a hash of its stiffness and lean bytes, its own draws; none on the short turf)
		coarse: ( () => {

			const u = fract( sin( lowByte.mul( 12.9898 ).add( mid.mul( 78.233 ) ) ).mul( 43758.5453 ) );
			const share = mix( mix( float( COARSE.shares[ 0 ] ), float( COARSE.shares[ 1 ] ), step( COARSE.at[ 0 ], u ) ), float( COARSE.shares[ 2 ] ), step( COARSE.at[ 1 ], u ) );
			return share.mul( smoothstepN( SHORT_TOP[ 0 ], SHORT_TOP[ 1 ], scaleY ) ).toVar();

		} )(),
	};

}

// A blade's own rest pose, before the tuft's transform: the shared tuft geometry's blade (attribute
// `blade`, tuftGeometry) longer or shorter, turned toward its own side and shaped by its weight
// (`bladeCurve`), all by hashes of the blade and its anchor (HEIGHT_MAX, FACING, ROOT_ANGLE,
// STIFFNESS). So the lawn stays even as a whole while no two neighbouring blades stand alike, and a
// grown island draws each blade as a fresh load does. The wind bends this pose (`bendBlade`). The
// tuft's local units are metres across and its height scale `scaleY` (m) up: the curve's reach
// across takes `aspect` (the height scale over the scale across), so the shape is the same in
// metres. Returns the local position, the half-width offset and the width axis (local x, z), the
// lean (local x, z: the blade's tilt for the normals), the side of the blade's centreline the vertex
// lies on, the blade's id, the hash it is kept by where it is widened (`grassMaterial`'s opacity),
// its length (m) and its root (local x, z: where the islanders' trail is read, Trample.ts).
// The blade's tussock (`clump`) turns it toward its lean and lengthens it on that side (SHEAR: the
// lengths' mean over a tussock stays) and stiffens it by its own stiffness. A flower's stem (`isStem` 1, `stem`: its direction in the tuft's frame and its length
// in the tuft's units, `headPose`) takes the same curve at the stem's numbers.
// At the cliff's edge the vertex stage drapes the rest pose's bent blade over it (`drape`).
function restBlade( blade: THREE.Node<'vec4'>, pick: F, scaleY: F, aspect: F, clump: Tussock, isStem: F, stem: { dir: THREE.Node<'vec2'>; length: F } ) {

	const t = blade.x;
	const side = sign( blade.w );
	// (a flower's head and stem take one id, so they take one phase in the wind)
	const id = min( abs( blade.w ).sub( 1 ), 2 );
	const tall = select( bladeHash( id, pick, 1 ).lessThan( TALL_SHARE ), float( TALL ), float( 1 ) );
	// a culm or a dead leaf (`bladeKind`; a flower's stem is neither)
	const kind = bladeKind( bladeHash( id, pick, 6 ), scaleY );
	const culm = kind.culm.mul( float( 1 ).sub( isStem ) ).toVar(), dead = kind.dry.mul( float( 1 ).sub( isStem ) ).toVar();
	const turn = bladeHash( id, pick, 3 ).sub( 0.5 ).mul( FACING );
	const facing = positionLocal.y.add( turn );
	const out = vec2( cos( facing ), sin( facing ) ).toVar();
	const dir = normalize( out.add( clump.dir.mul( clump.lean.mul( 0.8 ) ) ) ).toVar();
	// its grass (GRASSES): broad by a draw against its tussock's share; a stem keeps its own width
	const broad = step( bladeHash( id, pick, 8 ), clump.coarse ).toVar();
	const grass = ( k: 'width' | 'stiffness' ) => mix( float( GRASSES.fine[ k ] ), float( GRASSES.broad[ k ] ), broad );
	const leaf = bladeHash( id, pick, 0 ).mul( 0.5 ).add( 0.75 ).mul( tall ).div( 1 + TALL_SHARE * ( TALL - 1 ) )
		.mul( clump.lean.mul( dot( out, clump.dir ) ).mul( SHEAR ).add( 1 ) ).mul( mix( float( 1 ), float( DRY_LENGTH ), dead ) );
	const length = mix( leaf, bladeHash( id, pick, 0 ).mul( CULM_LENGTH[ 1 ] - CULM_LENGTH[ 0 ] ).add( CULM_LENGTH[ 0 ] ), culm ).toVar();
	const metres = length.mul( scaleY ).toVar();
	const stiffness = pow( float( STIFFNESS[ 1 ] / STIFFNESS[ 0 ] ), bladeHash( id, pick, 2 ) ).mul( STIFFNESS[ 0 ] ).mul( clump.stiffness ).mul( grass( 'stiffness' ) ).mul( mix( float( 1 ), float( DRY_STIFF ), dead ) );
	const gravity = min( metres.mul( metres ).mul( metres ).mul( G_UNIT ).div( stiffness ), G_MAX );
	const angle = bladeHash( id, pick, 4 ).sqrt().mul( ROOT_ANGLE[ 1 ] - ROOT_ANGLE[ 0 ] ).add( ROOT_ANGLE[ 0 ] );
	const culmWidth = mix( float( CULM_STEM ), float( CULM_WIDTH ), smoothstepN( CULM_HEAD[ 0 ], CULM_HEAD[ 1 ], t ) );
	// a short tussock's blades spread out as a mat (MAT): wider, and splayed out and down from its root
	const mat = float( 1 ).sub( smoothstepN( MAT.level[ 0 ], MAT.level[ 1 ], scaleY ) ).mul( float( 1 ).sub( isStem ) ).mul( float( 1 ).sub( culm ) ).toVar();
	const half = blade.z.mul( side ).mul( mix( mix( grass( 'width' ), culmWidth, culm ), float( 1 ), isStem ) ).mul( mat.mul( MAT.width ).add( 1 ) );
	const offset0 = vec2( cos( blade.y ), sin( blade.y ) ).mul( half );
	const axis = mix( vec2( cos( blade.y.add( turn ) ), sin( blade.y.add( turn ) ) ), vec2( stem.dir.y.negate(), stem.dir.x ), isStem ).toVar();
	const offset = axis.mul( half );
	const curve = bladeCurve( mix( mix( gravity, CULM_G, culm ), STEM_G, isStem ), mix( mix( angle, CULM_ANGLE, culm ), STEM_ANGLE, isStem ), t ).toVar();
	const along = mix( dir, stem.dir, isStem ), reach = mix( length, stem.length, isStem ).toVar();
	const base = positionLocal.xz.sub( offset0 );
	const centre = base.add( along.mul( curve.x.mul( reach ).mul( aspect ).mul( mat.mul( MAT.spread ).add( 1 ) ) ) );
	const position = vec3( centre.x.add( offset.x ), curve.y.mul( reach ).mul( float( 1 ).sub( mat.mul( MAT.flat ) ) ), centre.y.add( offset.y ) );
	return { position, offset, axis, lean: along.mul( curve.z.mul( LEAN_NORMAL ) ), side, id, hash: bladeHash( id, pick, 7 ), metres, base, facing: along };

}

// What the larger casters throw onto the blades (`SunShadow.softVisibility`, once per tuft:
// `meadowStill`): its ring's radius (m), so a caster's shade ends in a soft edge a few decimetres
// wide; how deep it shades (a share of the direct light), lighter than on the ground, as light
// scatters through the blades; and where over its root a tuft looks up, a share of its height and a
// lift (m), so it takes neither the ground it stands in nor only its tips' light.
const SHADE_RADIUS = 0.3, SHADE_DEPTH = 0.8, SHADE_HEIGHT = 0.5, SHADE_LIFT = 0.08;
// The blades' colour and light (grassMaterial): the root's and the tip's colour against the lawn's
// (the mean of the blades' palette, PALETTE), the key light left at the root, the sky's at the root,
// light through the upper blades (a broad lobe toward the sun and a faint floor from any side,
// tinted against the albedo), the gloss along them (its colour and the sine's power) and their
// specular against a plain dielectric's (see `grassMaterial`).
const ROOT = new THREE.Vector3( 0.42, 0.7, 0.56 ), TIP = new THREE.Vector3( 1.2, 1.17, 0.88 );
// The blades' palette, after SimonDev's Quick_Grass (MIT; the technique only: a mix of base and tip
// colours, and the sward darkened toward the ground by its height and density): a blade takes a root
// and a tip colour from one place along fresh green, yellow green and olive (`PALETTE`, factors on
// ROOT and TIP), its stroke's with a little of its own (STROKE, BLADE_TINT), and DRY_SHARE of them a
// dry, yellower leaf. The palette is divided by its mean over the run, which the strokes' places
// cover evenly, so the lawn's average colour stays ROOT to TIP of the lawn's. Blades only +-4 %
// apart in value and of one tint everywhere read as plastic; each blade a third apart from its
// neighbours (as real leaves are) grained the lawn from the game's view; the strokes carry the
// colour's variety and the blades keep a little of their own.
const DRY_SHARE = 0.12;
// The sward's layers, as a real meadow's from the ground up: the dead leaves and the old leaves'
// straw sheaths at the bottom, the green leaves, and the flowering stems over them.
// - Of a tall tussock's blades CULM_SHARE are flowering stems, culms (fading in over the height
//   scales CULM_TALL, m: the short turf's flower too low to show). A culm is CULM_LENGTH times its
//   tussock's height scale long and stands nearly upright, bent a little by its head (gravity
//   number CULM_G, root angle CULM_ANGLE rad): a thin stem, CULM_STEM of a leaf's width, swelling
//   into a spike-like panicle over its upper part (from CULM_HEAD[ 0 ] to CULM_HEAD[ 1 ] of its
//   length, CULM_WIDTH of a leaf's width, running to the leaf's point), its stem a straw green and
//   its panicle between a purple brown and a straw tan (PANICLE, linear albedo), as the meadow
//   grasses flower in summer: Yorkshire fog's pink, cocksfoot's purple, bent's purple haze ripening
//   to straw. From the game's camera the panicles over the leaves are the sward's top layer.
// - The dead leaves (DRY_SHARE of the others) lie low: DRY_LENGTH of a leaf's length and DRY_STIFF
//   of its stiffness, so they droop into the sward's bottom, and the green leaves' bases take up to
//   SHEATH of the dead leaves' straw at the root (their old sheaths), each by a hash of its own. A
//   dead leaf of full length stood among the green ones as a yellow streak at every height.
// A blade's kind is a function of its tint hash and its tussock's height scale (`bladeKind`), so the
// vertex stage (its shape) and the fragment stage (its colour) agree without another varying.
const CULM_SHARE = 0.04, CULM_TALL = [ 0.3, 0.42 ], CULM_LENGTH = [ 1.25, 1.5 ], CULM_G = 1.6, CULM_ANGLE = 1.38;
const CULM_STEM = 0.3, CULM_WIDTH = 1.25, CULM_HEAD = [ 0.62, 0.72 ];
const PANICLE = [ [ 0.115, 0.07, 0.065 ], [ 0.18, 0.14, 0.075 ] ];
const DRY_LENGTH = 0.5, DRY_STIFF = 0.4, SHEATH = 0.5;

/** A blade's kind by its tint hash `tint` (the same at every vertex of the blade) and its tussock's
 * height scale `scaleY` (m): a culm (1 or 0) or a dead leaf (1 or 0, never a culm). */
function bladeKind( tint: F, scaleY: F ): { culm: F; dry: F } {

	const culm = step( fract( tint.mul( 31.7 ) ), smoothstepN( CULM_TALL[ 0 ], CULM_TALL[ 1 ], scaleY ).mul( CULM_SHARE ) );
	return { culm, dry: step( 1 - DRY_SHARE, fract( tint.mul( 13.7 ) ) ).mul( float( 1 ).sub( culm ) ) };

}
// The palette's mean against ROOT and TIP: lighter, as the sward's depth (ROOT_DARK) and the faint
// translucent floor took about 18 % of the long sward's brightness in the game's view.
const PALETTE_GAIN = [ 0.85, 0.75 ];
const PALETTE = ( () => {

	const fresh = [ [ 0.95, 1.03, 1.08 ], [ 0.92, 1.04, 1.1 ] ], yellow = [ [ 1.12, 1, 0.85 ], [ 1.15, 1, 0.8 ] ];
	const olive = [ [ 1, 0.88, 0.78 ], [ 0.98, 0.86, 0.74 ] ], dry = [ [ 1.3, 1.05, 0.9 ], [ 1.65, 1.28, 0.95 ] ];
	const ends = [ ROOT, TIP ];
	const entry = ( e: number[][] ) => e.map( ( f, k ) => new THREE.Vector3( ...f ).multiply( ends[ k ] ) );
	// the mean over the draw: the green run is piecewise linear, fresh to yellow green to olive
	const mean = [ 0, 1 ].map( ( k ) => new THREE.Vector3( ...[ 0, 1, 2 ].map( ( c ) => ( 1 - DRY_SHARE ) * ( 0.25 * fresh[ k ][ c ] + 0.5 * yellow[ k ][ c ] + 0.25 * olive[ k ][ c ] ) + DRY_SHARE * dry[ k ][ c ] ) ) );
	const norm = ( e: THREE.Vector3[] ) => e.map( ( v, k ) => v.divide( mean[ k ] ).multiplyScalar( PALETTE_GAIN[ k ] ) );
	return { fresh: norm( entry( fresh ) ), yellow: norm( entry( yellow ) ), olive: norm( entry( olive ) ), dry: norm( entry( dry ) ) };

} )();
// The sward's depth (after Quick_Grass's, as above): a blade darkens toward its root by its
// tussock's density (its height scale over DENSE, its share of blades) to ROOT_DARK at the root of
// the densest, by the cube of the way down from the tip (the square, Quick_Grass's, left the
// game's view of the long sward 7 % darker: from above it sees the blades' middles); the short turf
// barely darkens.
// A deep green, never black: the root colour and the canopy's shade multiply in.
const ROOT_DARK = 0.3, DENSE = [ 0.2, 0.6 ];
const ROOT_KEY = 0.45, ROOT_SKY = 0.55;
// The light through the blades comes from the half of the view toward the sun alone: a share of it
// from any side (once 0.6, then 0.3) lit the blades turned from the sun as those against it, and
// with the shade's lift (Sky.ts CLEAR_SHADE) the meadow showed no side the light came from.
// A tussock's depth (`dense`: its height scale over DENSE times its share of blades) is the share
// of the full darkening its roots take; the tall sward's mean depth over its tussocks' heights
// (TUSSOCK.spread about the level) and blades is TALL_DENSE. The shade over a root, its canopy's
// depth and the key's and the sky's loss there (ROOT_KEY, ROOT_SKY), is full from TALL_DENSE up and
// falls to OPEN of it as the depth falls to none: the short turf's leaves stand nearly upright
// and let the light down to their roots and the ground (SwardField.ts), where the full shade drew
// the short patches about the low flowers as dark holes in the lawn.
const TALL_DENSE = ( () => {

	let d = 0;
	const n = 64;
	for ( let k = 0; k < n; k ++ ) d += smoothstep( DENSE[ 0 ], DENSE[ 1 ], LEVEL.ordinary * ( 1 + TUSSOCK.spread * ( 2 * ( k + 0.5 ) / n - 1 ) ) );
	return d / n * ( TUSSOCK.blades[ 0 ] + TUSSOCK.blades[ 1 ] ) / 2 / LAWN.blades;

} )();
const OPEN = 0.35;
// (the sward's depth where no anchor holds turf: the mean over the sward, SHORT_STAY of it short)
const SWARD_FALLBACK = TALL_DENSE * ( 1 - SHORT_STAY );
/** The blades' roots as the ground between them takes them (TerrainMaterial.ts's meadow ground):
 * the palette's mean at the root against the lawn (`colour`, the sward's shaded bottom), the key's
 * and the sky's light left at the root under the full shade (`key`, `sky`), the share of its colour
 * the deepest sward darkens (`darkening`: times the sward's depth there, the field of
 * SwardField.ts), the tall sward's mean depth (`tall`: the full shade from it up), the shade left
 * under the shortest turf (`open`) and the blade-count curve's distances (`bands`, a uniform: the
 * litter fades out where the tufts thin). */
export const GRASS_ROOTS = {
	colour: [ ROOT.x * PALETTE_GAIN[ 0 ], ROOT.y * PALETTE_GAIN[ 0 ], ROOT.z * PALETTE_GAIN[ 0 ] ],
	key: ROOT_KEY, sky: ROOT_SKY, bands: lodUniforms.bands,
	darkening: 1 - ROOT_DARK, tall: TALL_DENSE, open: OPEN,
};
const TRANSLUCENT_FORWARD = 1, FORWARD_POWER = 3;
const TRANSLUCENT_TINT = new THREE.Vector3( 1.2, 1.2, 0.8 );
const SHEEN = new THREE.Vector3( 0.03, 0.0325, 0.0225 ), SHEEN_POWER = 2, SPECULAR = 0.35;
// The blade's fold (how far each half's normal turns toward its edge), how far its own lean tilts
// its normal, and the lift of its thin bright edge (on the outer share EDGE_FROM of each half).
const FOLD = 0.6, LEAN_NORMAL = 0.25, EDGE = 0.25, EDGE_FROM = 0.7;
// The ring's lookups besides the centre (taken per vertex, each cost 0.05 - 0.08 ms a frame in the
// island views; per tuft, all of them together a few hundredths of a millisecond).
const SHADE_TAPS = 2;

// A far blade's strips (fragment stage): `side` runs from -1 to 1 across the blade, `strips` is
// how many blades it stands for. Returns the side within the fragment's strip and the strip's own
// value and tint hashes; a blade of one strip keeps its own, unchanged.
function bladeStrips( side: F, jitter: F, tint: F, strips: F ) {

	const across = side.mul( 0.5 ).add( 0.5 ).mul( strips ).toVar();
	const k = across.floor();
	const far = strips.greaterThan( 1 );
	return {
		side: select( far, fract( across ).mul( 2 ).sub( 1 ), side ),
		jitter: select( far, fract( sin( jitter.mul( 91.7 ).add( k.mul( 37.3 ) ) ).mul( 43758.5453 ) ), jitter ),
		tint: select( far, fract( sin( tint.mul( 73.1 ).add( k.mul( 19.7 ) ) ).mul( 43758.5453 ) ), tint ),
	};

}

// The flower heads (`headPose`, `headShape`), each its own (`HEADS`, by head number: the species
// in the order of `SPECIES`). A head is a disc of HEAD_RADIUS times its `size` times 0.8 to 1.25 (a
// hash of its tuft), about twice a small flower's real size and less for a large one: at half that
// the game's 22 m view showed the small heads as dots, not flowers. It stands at its `height` of its
// tuft's height (local units). The zhuyu grows only on lower tussocks (`plantGrass`, LOW_FLOWER), its
// round head on its stalk over their blades; the yaoxiang only on tall tussocks, most of its heads
// a little over the leaves, as its tall stems carry them, so the few that grow alone in the tall
// sward show (heads up to 0.5 m above the long blades' roots floated without a stem).
// It sits on its stem's tip, the stem leaning out from its tuft's axis toward a direction of its
// own (its curve, STEM_TIP), tilted from
// upright toward the tuft's own facing by HEAD_TILT (rad), as an open flower turns: from the game's
// low view a level disc showed as a sliver, one turned up to the sky as a round speck. A head is
// kept at least HEAD_MIN_PIXELS times the blades' least width across on screen (a smaller least
// size left the mid view's far meadow plain green), at most HEAD_MAX_WIDEN times its own size, its
// coverage falling by the square of the widening: as with the blades, the widened heads are drawn
// whole where their coverage is above their own hash, so the far meadow keeps as much colour as
// the near. As its tuft thins its blades with distance (its gain from 1 to NEAR_GAIN, 25 to 70 m) a
// head rises by up to HEAD_LIFT of its tuft's height: the widened far blades hid nearly every head
// at 70 m.
const HEAD_RADIUS = 0.064, HEAD_TILT = [ 0.35, 1.0 ];
const HEAD_MIN_PIXELS = 2, HEAD_MAX_WIDEN = 4, HEAD_LIFT = 0.35;
// Each head: its petals' colour and its inner colour (linear albedo, soft rather than vivid: the
// first heads' saturated colours read as confetti on the lawn, and yellow and white ones at their
// real albedo outshone it), the radii over which the inner colour gives way to the petals' (`inner`,
// from, to), its size and height range, and its outline (`headShape`): `lobe` scallops each sector
// round, `point` runs it to a point, `fringe` cuts teeth into its tip, `rays` makes it a ray round
// a disc of the inner colour (a daisy's form).
type Head = { petal: [ number, number, number ]; centre: [ number, number, number ]; inner: [ number, number ];
	size: number; height: [ number, number ]; lobe: number; point: number; fringe: number; rays: number };
const HEADS: Head[] = [
	// yaoxiang: a day lily's trumpet, its pointed tepals cinnabar, gold in the throat
	{ petal: [ 0.42, 0.022, 0.018 ], centre: [ 0.55, 0.24, 0.02 ], inner: [ 0.04, 0.3 ], size: 1.5, height: [ 0.98, 1.22 ], lobe: 0.3, point: 0.25, fringe: 0, rays: 0 },
	// zhuyu: a round head of small sky blue florets, deeper at its middle, its rim starry
	{ petal: [ 0.1, 0.22, 0.46 ], centre: [ 0.05, 0.11, 0.3 ], inner: [ 0, 0.6 ], size: 0.95, height: [ 1.0, 1.35 ], lobe: 0.1, point: 0, fringe: 0.14, rays: 0 },
];

/** A value of each head (`values`, by head number) for the head number `h`. */
function perHead( values: number[], h: F ): F {

	let v: F = float( values[ 0 ] );
	for ( let i = 1; i < values.length; i ++ ) v = mix( v, float( values[ i ] ), step( i - 0.5, h ) );
	return v;

}

function perHead3( values: [ number, number, number ][], h: F ): V3 {

	let v: V3 = vec3( ...values[ 0 ] );
	for ( let i = 1; i < values.length; i ++ ) v = mix( v, vec3( ...values[ i ] ), step( i - 0.5, h ) );
	return v;

}

// A flowering tuft's head, in the vertex stage: its centre in the tuft's local space (placed by
// the tuft's transform as a blade's vertex is), the vertex's offset from it in world space (the
// disc's plane from the tuft's own axes `xAxis`, `zAxis`, tilted), its normal and its radius; all
// hashes of the tuft (`pick`) and its head number (`kind`), so a grown island draws each head as a
// fresh load does. Its stem (`stem`: its direction in the tuft's plane and its length in the tuft's
// units) ends at the centre; `aspect` is the tuft's height scale over its scale across.
function headPose( blade: THREE.Node<'vec4'>, pick: F, kind: F, xAxis: V3, zAxis: V3, gain: F, aspect: F ) {

	const hash = ( k: number ) => bladeHash( float( 16 ), pick, k );
	const turn = hash( 10 ).mul( TAU );
	const dir = vec2( cos( turn ), sin( turn ) ).toVar();
	const lift = clamp( gain.sub( 1 ).div( NEAR_GAIN - 1 ), 0, 1 ).mul( HEAD_LIFT );
	const low = perHead( HEADS.map( ( h ) => h.height[ 0 ] ), kind ), high = perHead( HEADS.map( ( h ) => h.height[ 1 ] ), kind );
	const height = hash( 8 ).mul( high.sub( low ) ).add( low ).add( lift ).toVar();
	const length = height.div( STEM_TIP[ 1 ] ).toVar();
	const away = dir.mul( length.mul( aspect ).mul( STEM_TIP[ 0 ] ) );
	const centre = vec3( away.x, height, away.y );
	const x = normalize( xAxis ), z = normalize( zAxis ), y = cross( z, x );
	const tilt = hash( 11 ).mul( HEAD_TILT[ 1 ] - HEAD_TILT[ 0 ] ).add( HEAD_TILT[ 0 ] );
	const across = z.mul( cos( tilt ) ).add( y.mul( sin( tilt ) ) );
	const radius = hash( 12 ).mul( 0.45 ).add( 0.8 ).mul( perHead( HEADS.map( ( h ) => h.size * HEAD_RADIUS ), kind ) );
	const offset = x.mul( cos( blade.y ) ).add( across.mul( sin( blade.y ) ) ).mul( blade.z.mul( radius ) );
	return { centre, offset, normal: y.mul( cos( tilt ) ).sub( z.mul( sin( tilt ) ) ), radius, hash: hash( 13 ), stem: { dir, length } };

}

// How far a head at `centre` (world) widens to stay HEAD_MIN_PIXELS blade widths across, and the
// coverage that leaves it.
function headWiden( centre: V3, radius: F, minWidth: F ): { widen: F; coverage: F } {

	const depth = max( cameraViewMatrix.mul( vec4( centre, 1 ) ).z.negate(), 1e-3 );
	const p11 = ( cameraProjectionMatrix as unknown as { element( i: number ): { element( i: number ): F } } ).element( 1 ).element( 1 );
	const pixel = depth.mul( 2 ).div( p11.mul( screenSize.y ) );
	const widen = clamp( minWidth.mul( HEAD_MIN_PIXELS * 0.5 ).mul( pixel ).div( radius ), 1, HEAD_MAX_WIDEN ).toVar();
	return { widen, coverage: float( 1 ).div( widen.mul( widen ) ) };

}

// The vertex stage's branches (`grassMaterial`) are functions of their own with a layout: an inline
// `Fn` reached by a varying's type (`vGrassBlade` reads the head's hash) is set up again in the
// fragment stage, which then took the tuft's slot as two more varyings, past WebGPU's sixteen
// under the temporal modes.
// A head's pose as four columns ( centre, radius ), ( offset, hash ), ( normal, stem length ),
// ( stem direction, 0, 0 ), worked out on the flowering batch only (`on`: `flowering`, passed in, as a
// uniform read inside a function with a layout can be emitted under another material's name);
// elsewhere a level disc at the root with no stem, which the blends by `isHead` and `isStem` drop.
const flowerHead = Fn( ( [ on, blade, pick, code, xAxis, zAxis, gain, aspect ]: [ F, THREE.Node<'vec4'>, F, F, V3, V3, F, F ] ) => {

	const m = mat4( vec4( 0 ), vec4( 0 ), vec4( 0, 1, 0, 0 ), vec4( 1, 0, 0, 0 ) ).toVar();
	If( on.greaterThan( 0.5 ), () => {

		const h = headPose( blade, pick, code, xAxis, zAxis, gain, aspect );
		m.assign( mat4( vec4( h.centre, h.radius ), vec4( h.offset, h.hash ), vec4( h.normal, h.stem.length ), vec4( h.stem.dir, 0, 0 ) ) );

	} );
	return m;

} ).setLayout( { name: 'meadowFlowerHead', type: 'mat4', inputs: [
	{ name: 'on', type: 'float' }, { name: 'blade', type: 'vec4' }, { name: 'pick', type: 'float' }, { name: 'code', type: 'float' }, { name: 'xAxis', type: 'vec3' },
	{ name: 'zAxis', type: 'vec3' }, { name: 'gain', type: 'float' }, { name: 'aspect', type: 'float' },
] } );
// Standing water's cover (`puddleCover`), its noise taken only once the ground holds any (PUDDLE_WET)
const wetPuddle = Fn( ( [ xz, wetness ]: [ THREE.Node<'vec2'>, F ] ) => {

	const cover = float( 0 ).toVar();
	If( wetness.greaterThan( PUDDLE_WET ), () => {

		cover.assign( puddleCover( xz, wetness ) );

	} );
	return cover;

} ).setLayout( { name: 'meadowPuddle', type: 'float', inputs: [ { name: 'xz', type: 'vec2' }, { name: 'wetness', type: 'float' } ] } );

// A head's petals and colour, in the fragment stage, from where the fragment lies on the disc
// (`radius`, 0 at the centre to 1 at the rim, and `across`, -1 to 1 across its sector) and the
// head's number (`kind`): each sector is a petal, its outline and colours the head's (`HEADS`).
// Returns the colour and whether the fragment is on a petal (0 or 1).
function headShape( across: F, radius: F, kind: F ): { colour: V3; mask: F } {

	// (blends of 0 / 1 weights rather than select(): see AGENTS.md, a select of built nodes)
	const h = kind.toVar();
	const get = ( key: 'lobe' | 'point' | 'fringe' | 'rays' ) => perHead( HEADS.map( ( head ) => head[ key ] ), h );
	const rays = get( 'rays' );
	const side = abs( across ).div( max( radius, 1e-3 ) );
	// a petal's outline: scalloped, pointed and toothed by the head's measures
	const teeth = fract( side.mul( 2.5 ).add( radius.mul( 3 ) ) );
	const outline = float( 1 ).sub( side.mul( side ).mul( get( 'lobe' ) ) ).sub( side.mul( get( 'point' ) ) ).sub( teeth.mul( get( 'fringe' ) ) );
	const ray = step( side, mix( float( 0.8 ), float( 0.25 ), radius.mul( radius ) ) );
	const inner0 = perHead( HEADS.map( ( head ) => head.inner[ 0 ] ), h ), inner1 = perHead( HEADS.map( ( head ) => head.inner[ 1 ] ), h );
	const disc = step( radius, inner1 ).mul( rays );
	const mask = mix( step( radius, outline ), max( ray, disc ), rays );
	const petal = perHead3( HEADS.map( ( head ) => head.petal ), h ), centre = perHead3( HEADS.map( ( head ) => head.centre ), h );
	return { colour: mix( centre, petal, smoothstepN( inner0, inner1, radius ) ), mask };

}

// A head's light, wrapped round the blades' light hook (the hook's own lines stay the blades'): its
// petals take light through them as the old wildflowers' did, untinted and a little from any side,
// in place of the blades' yellow translucency, and no gloss; the canopy's light is the blades' at
// the head's height (about their tips'). `head` is 1 on a head's fragments.
function withHeadLight( head: F, options: VegetationOptions ): VegetationOptions {

	const light = options.light;
	return { ...options, light: ( rest ) => {

		const blades = typeof light === 'function' ? light( rest ) : light;
		const extra = blades.extra!, sheen = blades.sheen!;
		return {
			scale: blades.scale,
			extra: ( L, V, N ) => mix( extra( L, V, N ) as V3, vec3( backlight( L, V, 3 ).mul( 0.6 ).add( 0.12 ) ), head ),
			sheen: ( L, V, N ) => sheen( L, V, N ).mul( float( 1 ).sub( head ) ),
		};

	} };

}

function grassMaterial( shared: Shared, cull: GrassCull ): THREE.MeshStandardNodeMaterial {

	// The blades' opacity is 0 or 1 (whole blades, below): the factory's 'blade' family draws a
	// fragment or drops it whole, by alpha to coverage or, without multisampling, by
	// `coverageDither`'s threshold (vegetation/Material.ts).
	const slot = instanceIndex.add( cullBase );
	const tuftSlot = select( cullOn.equal( 1 ), cull.node( 'visible', 'uint', true ).element( slot ), slot ).toVar( 'grassTuft' );
	const input = tuftInputs( cull, tuftSlot );
	// The tuft's instance data, read as the instanced attributes were: what the fragment stage
	// reads passes as a varying, as an attribute did.
	// (the tuft's local x axis is its matrix's first column; its slots in `ground` hold its stroke's
	// place on the palette's run and the thin flag)
	const ground0 = input.ground( 0 ), groundMid = input.ground( 1 ), ground2 = input.ground( 2 );
	const ground1 = vec4( ( input.matrix as unknown as Columns ).element( 0 ).xyz, groundMid.w );
	const tuftOrigin = varying( input.origin, 'vGrassTuftOrigin' );
	// The tuft's sky visibility, its stroke's place on the palette's run (STROKE) and its far share
	// (FAR), in one varying (the meadow's varyings are near WebGPU's limit).
	const farShare = FAR.share > 0 ? float( 1 ).sub( smoothstepN( FAR.pixels[ 0 ], FAR.pixels[ 1 ], screenHeight( input.origin.xyz, input.origin.w ) ) ).mul( FAR.share ).toVar( 'grassFarShare' ) : float( 0 );
	const tuftLook = varying( vec3( ground0.x, groundMid.z, farShare ), 'vGrassTuftLook' );
	const skyVisibility = tuftLook.x;
	const blade = attribute<'vec4'>( 'blade', 'vec4' );
	const t = blade.x;
	const t2 = t.mul( t );
	const tuft = tuftOrigin;
	const origin = tuft.xyz;
	const pick = rootHash( origin.xz );
	// (the tuft's height scale, m: its top over CANOPY_TOP; and over its scale across, its local x axis)
	const scaleY = tuft.w.div( CANOPY_TOP ).toVar();
	// The tuft's own values that every vertex of it would work out alike, from its record
	// (`TUFT_RECORD`): its tussock's (`tussockOf`), the aspect and its shade, and the wind at its
	// origin below.
	const record = cull.node( 'tuft', 'vec4', true ), recordAt = tuftSlot.mul( TUFT_RECORD ).toVar( 'grassRecord' );
	const own = record.element( recordAt ).toVar( 'grassTussock' ), ownMore = record.element( recordAt.add( 1 ) ).toVar( 'grassTussockDir' );
	const aspect = ownMore.z;
	// A flowering tuft's head and stem (`flowerTuftGeometry`): the head's vertices take the head's
	// pose, colour and light in place of a blade's, through the same stages; the stem's are a blade's
	// on the stem's curve.
	// (1 on a head's or a stem's vertex; every choice between them is a blend, exact for the blades)
	const flowerPart = step( HEAD_FLAG - 0.5, abs( blade.w ) ), isStem = step( STEM_FLAG - 0.5, abs( blade.w ) );
	const isHead = flowerPart.sub( isStem );
	const lod = tuftLod( origin, ground2.w );
	// The vertex stage's per-tuft work that most tufts do not need runs in branches on uniforms or on
	// the tuft's own record, each tuft's vertices taking one side together: a head's pose and size
	// on the flowering batch alone (`flowering`), the standing water's noise only once the ground is
	// wet enough to hold any (PUDDLE_WET), and the drape and the hold off the wall only on a tuft at
	// the edge (`edgeOn`). What a branch skips is what the blends by `isHead`, `isStem`, the pool and
	// `edgeOn` dropped, so every vertex takes the values it took before (a paused frame is unchanged
	// to the byte).
	// The head's and the water's are functions with a layout (`flowerHead`, `wetPuddle`); the
	// drape's (`settle`) reads its inputs into variables before its branch, so a node it shares with
	// the rest of the stage is declared outside it (a select's pitfall, AGENTS.md). Together they took about a
	// quarter of the meadow's time at the island view, the standing water's two noise lookups a
	// vertex most of it.
	// (the other batches' vertices take a level disc at the root, with no stem)
	const headColumns = flowerHead( float( flowering ), blade, pick, ground0.y.sub( 1.5 ), ground1.xyz, ground2.xyz, lod.gain, aspect ).toVar( 'grassHead' ) as unknown as { element( i: number ): THREE.Node<'vec4'> };
	const head = {
		centre: headColumns.element( 0 ).xyz, radius: headColumns.element( 0 ).w, offset: headColumns.element( 1 ).xyz, hash: headColumns.element( 1 ).w,
		normal: headColumns.element( 2 ).xyz, stem: { dir: headColumns.element( 3 ).xy, length: headColumns.element( 2 ).w },
	};
	const clump: Tussock = { stiffness: own.x, lean: own.y, coarse: own.w, dir: ownMore.xy };
	// A tuft's edge record (`edgeTuftSteps`, zeros away from the edge): the coast's offset along its
	// outward direction, the roof's height, the outward direction, then the wall (LIP_WALLS offsets).
	const edgeRecord = input.edge( 0 );
	const walls = [ 1, 2, 3, 4 ].map( ( k ) => input.edge( k ) );
	const pose = restBlade( blade, pick, scaleY, aspect, clump, isStem, head.stem );
	// Whole blades instead of partial coverage (after tidewater's GrassField, Daniel Greenheck, MIT;
	// the technique only): a widened blade's fragment is drawn solid where the blade's coverage
	// there (`pixelWideBlade`) is at or above the blade's own hash and not at all below it. A blade
	// then ends where it narrows past its hash and the meadow covers as much on average as with
	// partial coverage, while no pixel of a blade takes a share of the samples: partial coverage
	// drew alpha to coverage's fixed sample patterns as a grid of dots along the narrow upper
	// blades, plainest on the lit tips. In a wind-still clip at the game camera's close end the
	// meadow flickers as much as with partial coverage (a little less in its high-pass part);
	// drawing the widened blades solid near the camera instead raised it by about a third and
	// brightened the lawn.
	// What the fragment stage reads of the blade, in one varying (the meadow's varyings are near
	// WebGPU's limit): its keep hash, the side of its centreline, and its value and tint hashes
	// (taken per vertex: the blade's id comes from its attribute's magnitude, whose sign flips
	// across the blade, so interpolated it is the id only at the edges).
	// A head's vertex passes instead its keep hash, its place across its petal and from the centre,
	// and 2 + its flower code, which tells it apart in the fragment stage (blade hashes are below 1).
	const bladeVarying = varying( mix(
		vec4( pose.hash, pose.side, bladeHash( pose.id, pick, 5 ), bladeHash( pose.id, pick, 6 ) ),
		vec4( head.hash, positionGeometry.x, blade.z, ground0.y.add( 1 ) ), isHead ), 'vGrassBlade' );
	// sway: gusts travel across the meadow, the tips move most. `p` is the vertex of the blade's
	// rest pose placed by the tuft's transform, i.e. in world space (the mesh itself stays
	// untransformed), computed as three's instancing did; held in a variable as three's was,
	// which keeps the rounding of every expression built on it.
	const placed = input.matrix.mul( vec4( mix( pose.position, head.centre, isHead ), 1 ) ).xyz.toVar( 'grassPlaced' );
	const minWidth = mix( grassUniforms.minWidth, grassUniforms.rimMinWidth, ground0.w );
	// a head's vertex: its centre placed, then its offset on the disc, widened about the centre
	const headSize = headWiden( placed, head.radius, minWidth );
	const p = placed.add( head.offset.mul( headSize.widen.mul( isHead ) ) );
	// Folding a thinned tuft into its root: a scale about the anchor, applied like the drowning.
	const thin = max( ground1.w, 0 );
	const kept = float( 1 ).sub( thin.mul( smoothstepN( grassUniforms.thinNear, grassUniforms.thinFar, length( cameraPosition.sub( origin ) ) ) ) );
	// Standing water drowns the blades: the tufts sink below the waterline (the ground, which
	// carries the water's surface, hides them). About a third keep a few centimetres of their
	// tips above it, so sparse drowned spikes stand in an open sheet of water rather than a
	// meadow that hides it. Which tufts and how much is a hash of the planting anchor, fixed.
	const pool = wetPuddle( origin.xz, shared.wetness ).toVar( 'grassPool' );
	const drowned = float( 1 ).sub( pool.mul( 0.15 ) ).mul( kept );
	const tip = select( pick.greaterThan( 0.66 ), pick.sub( 0.66 ).mul( 0.25 ).add( 0.03 ), float( - 0.03 ) );
	// The tallest blade of a tuft reaches about 0.9 of its height ( tuft.w / CANOPY_TOP ).
	const sink = max( tuft.w.div( CANOPY_TOP ).mul( drowned ).mul( 0.9 ).sub( tip ), 0 );
	const rooted = drown( p.sub( origin ).mul( drowned ).add( origin ), origin.xz, sink, shared.wetness, pool );
	const phase = bladePhase( pose.id, pick );
	// The blade's half width at this vertex in world space: its local offset from the centreline
	// through the instance's own axes, then the same drowning scale as `rooted` (an affine map of
	// the position, so it scales offsets alike; the bend barely varies across a blade).
	const across = ground1.xyz.mul( pose.offset.x ).add( ground2.xyz.mul( pose.offset.y ) ).mul( drowned ).mul( float( 1 ).sub( isHead ) );
	// a head and its stem are always kept whole, whatever its tuft keeps of its blades
	const keep = mix( lod.keep, 1, flowerPart ), gain = mix( lod.gain, 1, flowerPart );
	// Under MSAA the tuft's sway fades out as it shrinks to a few pixels on screen, its gusts' lean
	// kept (`swayFade`); one share for the whole tuft, its head with it. The temporal modes resolve
	// the far sway themselves and keep it whole.
	const fade = TEMPORAL ? undefined : swayFade( origin, tuft.w ).toVar( 'grassSwayFade' );
	// Each blade bends in the wind by its own length (the wind's load grows with its cube), a head and
	// its stem by its tuft's height on a sway of their own (Deform.ts GRASS_WIND.head). The bend keeps every vertex at its distance from the root, so a blade above
	// its root stays above it; on sloping ground a blade pressed flat could still pass into the
	// slope, so the bent blade is held on the tuft's plane through its (sunk) root (`grounded`).
	const bendHeight = mix( pose.metres.mul( CANOPY_TOP ), tuft.w, flowerPart ).toVar();
	const tuftUp = normalize( cross( ground2.xyz, ground1.xyz ) ).toVar();
	const floor = origin.sub( vec3( 0, pool.mul( sink ), 0 ) ).toVar();
	const grounded = ( q: V3 ) => q.add( tuftUp.mul( max( dot( floor.sub( q ), tuftUp ), 0 ) ) );
	// A meadow tuft at the edge (`edgeTuftSteps`: its record's outward direction set) drapes the part
	// of DRAPE_SHARE of its blades past the edge over it: its distance past the edge, along the
	// outward direction, is laid round a quarter curl of the blade's own radius (DRAPE_RADIUS), then
	// straight down.
	const edgeOn = step( 1e-6, dot( edgeRecord.zw, edgeRecord.zw ) ).toVar();
	const drape = ( q: V3 ) => {

		const drapeRadius = mix( float( DRAPE_RADIUS[ 0 ] ), float( DRAPE_RADIUS[ 1 ] ), bladeHash( pose.id, pick, 8 ) ).mul( clump.stiffness.sqrt() ).toVar();
		const out = edgeRecord.zw;
		const flops = step( bladeHash( pose.id, pick, 9 ), DRAPE_SHARE );
		const past = max( dot( q.xz, out ).sub( edgeRecord.x ), 0 ).mul( edgeOn ).mul( flops ).toVar();
		const angle = min( past.div( drapeRadius ), Math.PI / 2 );
		const along = drapeRadius.mul( sin( angle ) ), drop = drapeRadius.mul( float( 1 ).sub( cos( angle ) ) ).add( max( past.sub( drapeRadius.mul( Math.PI / 2 ) ), 0 ) );
		return q.sub( vec3( out.x, 0, out.y ).mul( past.sub( along ) ) ).sub( vec3( float( 0 ), drop, float( 0 ) ) );

	};
	// An edge tuft's draped blade is held off the stone (its wall, LIP_WALLS offsets from the coast
	// along the outward direction, every LIP_DEPTH under the roof, linear between them and held
	// below the last): a point the wall would pass is moved out to it by a smooth maximum
	// (HOLD_SOFT), so a blade that reaches the stone lies along it, downward; above the roof nothing
	// bounds it, the wall falling away over 2 cm, and inland of the coast nothing either (from
	// HOLD_INLAND m in): there the ground is the turf's, which rounds down over the lip's shoulder below
	// the roof, and the blades over it are in the air (held out to the wall line, every blade of the
	// shoulder's tufts below the roof's height stood in one vertical sheet along the coast, a comb of
	// bright strands from the game's view). The hold eases in from the root (HOLD_ROOT). 0 away from
	// the edge (`edgeOn`).
	const holdOff = ( q: V3 ) => {

		const outward = mix( ground1.xz.div( max( length( ground1.xz ), 1e-6 ) ), edgeRecord.zw, edgeOn ).toVar();
		const o = dot( q.xz, outward ).sub( edgeRecord.x ).toVar();
		const depth = edgeRecord.y.sub( q.y ).toVar();
		const u = clamp( depth.div( LIP_DEPTH ), 0, LIP_WALLS - 1 ).toVar();
		let wall: F = float( 0 );
		walls.forEach( ( w, j ) => {

			wall = wall.add( dot( w, max( float( 1 ).sub( abs( vec4( u ).sub( vec4( 4 * j, 4 * j + 1, 4 * j + 2, 4 * j + 3 ) ) ) ), 0 ) ) );

		} );
		const stone = wall.sub( float( 1 ).sub( smoothstepN( - 0.02, 0, depth ) ) ).add( bladeHash( pose.id, pick, 10 ).mul( LIE_SPREAD ) ).toVar();
		const soft = max( float( HOLD_SOFT ).sub( abs( o.sub( stone ) ) ), 0 ).div( HOLD_SOFT );
		const held = max( o, stone ).add( soft.mul( soft ).mul( HOLD_SOFT * 0.25 ) );
		const ease = smoothstepN( HOLD_ROOT[ 0 ], HOLD_ROOT[ 1 ], length( q.sub( origin ) ) ).mul( smoothstepN( - HOLD_INLAND, 0, o ) );
		return q.add( vec3( outward.x, 0, outward.y ).mul( held.sub( o ).mul( ease ).mul( edgeOn ) ) );

	};
	const settle = ( q: V3 ) => Fn( () => {

		const r = grounded( q ).toVar();
		If( edgeOn.greaterThan( 0.5 ), () => {

			r.assign( holdOff( drape( r ) ) );

		} );
		return r;

	} )();
	// The islanders' trail (Trample.ts) at the blade's root, a head's at its stem's (the tuft's
	// origin); left out of the shader altogether under `flags.trample = false` at load. Under the
	// temporal modes the previous position takes the previous frame's trail.
	const trampled = debugFlags.trample !== false;
	const bladeRoot = () => mix( input.matrix.mul( vec4( pose.base.x, 0, pose.base.y, 1 ) ).xz, origin.xz, isHead );
	// the blade's share of the trail by its tuft's record (`frame` 0, or 1 for the previous frame's),
	// and its root and own facing (world) where that is not 0
	const trail = trampled ? cull.node( 'trail', 'vec4', true ) : null;
	const trampleOf = ( frame: number ): TrampleBlade => ( {
		share: trampleShare( ( k ) => trail!.element( tuftSlot.mul( TRAMPLE_RECORD ).add( frame * 2 + k ) ), bladeRoot ),
		root: () => {

			const r = bladeRoot().toVar();
			return vec3( r.x, origin.y, r.y );

		},
		facing: () => normalize( ground1.xz.mul( pose.facing.x ).add( ground2.xz.mul( pose.facing.y ) ) ),
	} );
	const trample = trampled ? trampleOf( 0 ) : undefined;
	if ( trample ) trample.share = trample.share.toVar( 'grassTrample' );
	const trampleBefore = trampled && TEMPORAL ? trampleOf( 1 ) : undefined;
	// The wind at the tuft's origin (`meadowWind`): the frame being rendered's and under the
	// temporal modes the previous one's; any other wind state is worked out here.
	const windAt = ( k: number ): TuftWind => {

		const sway = record.element( recordAt.add( k + 3 ) ).toVar( `grassWindSway${ k }` );
		return { field: record.element( recordAt.add( k + 2 ) ).toVar( `grassWind${ k }` ), travel: sway.x, swing: sway.y, shiver: sway.z, load: sway.w };

	};
	const winds = new Map<WindState, TuftWind>( [ [ shared.wind, windAt( 0 ) ] ] );
	if ( TEMPORAL ) winds.set( shared.wind.previous, windAt( 2 ) );
	const windOf = ( state: WindState ) => winds.get( state ) ?? tuftWind( state, origin.xz );
	const bend = bendBlade( shared.wind, rooted, origin, bendHeight, t2, phase, fade, clump.stiffness, flowerPart, trample, windOf( shared.wind ) );
	const bent = settle( bend.position ).toVar( 'grassBent' );
	// A blade of a tuft past 70 m stands for as many of the blades it drew there as its gain over
	// NEAR_GAIN (exactly 1 within 70 m) and is drawn as that many strips side by side, each with its
	// own fold, edge and tint (`bladeStrips`): one plain blade 16 times as wide read at the island
	// view as a cover of broad leaves, coarser than the blades a few pixels wide it stands for. The
	// count rides with the rim cover in one varying (the meadow's varyings are near WebGPU's limit).
	const rimVarying = varying( vec2( ground0.z, max( gain.div( NEAR_GAIN ), 1 ) ), 'vGrassRimCover' );
	// dark, shaded roots to the tuft's own colour at the tips (the instance colour multiplies in)
	const cover = rimVarying.x;
	const strip = bladeStrips( bladeVarying.y, bladeVarying.z, bladeVarying.w, rimVarying.y );
	// Each blade takes its root and tip colours from the palette at its stroke's place and a little of
	// its own, and a value a little apart (BLADE_TINT), by hashes of the blade and its tuft's anchor;
	// DRY_SHARE dry leaves by a draw of their own. The palette's mean is the lawn's colour.
	const jitter = strip.jitter, tint = strip.tint;
	// (its place on the run its stroke's, BLADE_TINT.run of it the blade's own about it)
	const onRun = clamp( tuftLook.y.add( tint.sub( 0.5 ).mul( BLADE_TINT.run ) ), 0, 1 );
	const run = ( k: number ) => mix( mix( vec3( PALETTE.fresh[ k ] ), vec3( PALETTE.yellow[ k ] ), clamp( onRun.mul( 2 ), 0, 1 ) ), vec3( PALETTE.olive[ k ] ), clamp( onRun.mul( 2 ).sub( 1 ), 0, 1 ) );
	// (the blade's kind by its own tint, not a far strip's: its shape is the blade's, `bladeKind`)
	const culm = bladeKind( bladeVarying.w, tuft.w.div( CANOPY_TOP ) ).culm;
	const dry = step( 1 - DRY_SHARE, fract( tint.mul( 13.7 ) ) ).mul( float( 1 ).sub( culm ) );
	const sheath = fract( tint.mul( 5.31 ) ).mul( SHEATH );
	const value = jitter.mul( 2 ).sub( 1 ).mul( BLADE_TINT.value ).add( 1 );
	// A deeper, cooler green at the root to a light, fresh green at the tip (the instance colour
	// multiplies in), so the gaps between blades read as a deeper green, never near black (that
	// read as holes in a bright lawn), and the sward has depth without looking dirty. The light
	// through the tips (below) adds the yellow. At the rim's soil pockets the roots take the soil's
	// colour.
	const tipColour = mix( run( 1 ), vec3( PALETTE.dry[ 1 ] ), dry );
	const root = mix( mix( mix( run( 0 ), vec3( PALETTE.dry[ 0 ] ), sheath ), vec3( PALETTE.dry[ 0 ] ), dry ), vec3( 0.55, 0.38, 0.23 ), float( 1 ).sub( cover ).mul( 0.55 ).mul( soilUniforms.strength ) );
	// a culm's colour: its straw green stem, its panicle (PANICLE, against the lawn's colour, which
	// the instance colour multiplies in) from where it swells
	const lawn = vec3( ...LAWN_COLOUR );
	const panicle = mix( vec3( ...PANICLE[ 0 ] ), vec3( ...PANICLE[ 1 ] ), fract( bladeVarying.w.mul( 3.7 ) ) ).div( lawn );
	const culmColour = mix( mix( run( 1 ), vec3( PALETTE.dry[ 1 ] ), 0.5 ), panicle, smoothstepN( CULM_HEAD[ 0 ], CULM_HEAD[ 1 ], t ) );
	// The blade's side and width axis, for the edge here and the fold below. The edge is a lighter
	// rim along the blade's margins, only seen where a blade is several pixels wide.
	const side = strip.side;
	const axisView = varying( cameraViewMatrix.mul( vec4( normalize( ground1.xyz.mul( pose.axis.x ).add( ground2.xyz.mul( pose.axis.y ) ) ), 0 ) ).xyz, 'vGrassAxis' );
	const edge = smoothstepN( EDGE_FROM, 1, abs( side ) ).mul( EDGE ).add( 1 );
	// A blade's depth in the canopy is its share of the way down its own tuft times the turf's one
	// canopy depth (MeadowCanopy.ts TURF_CANOPY_DEPTH), not its metres below the tuft's top, and
	// that depth and the key's and the sky's loss at its root (ROOT_KEY, ROOT_SKY) take its
	// tussock's shade (`rootShade`: full in the tall sward, OPEN in the short turf), the shade the
	// ground about it takes from the sward's field (SwardField.ts), so its roots meet the ground.
	// The head's fragments: its petals' colour and shape (`headShape`), lit as a petal.
	const onHead = step( 1.5, bladeVarying.w );
	// (only a head's fragments work out its shape and colour: a blade's take zeros, which the blends
	// by `onHead` drop; worked out for every fragment, the species' measures cost the whole meadow)
	const headLook = Fn( () => {

		const look = vec4( 0 ).toVar( 'grassHeadLook' );
		If( onHead.greaterThan( 0.5 ), () => {

			const shape = headShape( bladeVarying.y, bladeVarying.z, bladeVarying.w.sub( 2.5 ) );
			look.assign( vec4( shape.colour, shape.mask ) );

		} );
		return look;

	} )();
	const headFragment = { colour: headLook.xyz, mask: headLook.w };
	const bladeOnly = float( 1 ).sub( onHead );
	const rootShade = mix( float( OPEN ), float( 1 ), clamp( smoothstepN( DENSE[ 0 ], DENSE[ 1 ], tuft.w.div( CANOPY_TOP ) ).div( TALL_DENSE ), 0, 1 ) );
	const canopyDepth = ( at: THREE.Node<'vec3'> ) => max( float( 1 ).sub( at.y.sub( origin.y ).div( tuft.w ) ), 0 ).mul( rootShade.mul( TURF_CANOPY_DEPTH ) );
	const mat = vegetationMaterial( shared, withHeadLight( onHead, {
		family: 'blade', roughness: 0.86,
		wet: { tint: 0.92, roughness: 0.76 },
		color: ( wet ) => mix( mix( mix( root, tipColour, smoothstepN( 0.12, 1, t ) ), culmColour, culm ).mul( value ).mul( edge ), headFragment.colour, onHead ).mul( wet ),
		rest: rooted,
		// Short growth needs a smaller world-space sway to keep its tips above the soil.
		// The widening and the narrowing by distance (`pixelWideBlade`, `tuftLod`) follow the current
		// camera: a previous frame's pose from the registered displacement keeps them as they are now.
		displacement: ( state ) => pixelWideBlade(
			state === shared.wind ? bent : settle( bendBlade( state, rooted, origin, bendHeight, t2, phase, fade, clump.stiffness, flowerPart, state === shared.wind.previous ? trampleBefore : trample, windOf( state ) ).position ), across, minWidth, keep, gain, isHead, headSize.coverage ),
		// Motion vectors (temporal modes): the blade bent by the previous frame's wind from the same
		// rooted point, widened by the offset the current pose took (the widening follows the camera,
		// whose motion Motion.ts adds): swayed - ( bent now - bent before ).
		previous: ( swayed ) => TEMPORAL ? swayed.sub( bent ).add( settle( bendBlade( shared.wind.previous, rooted, origin, bendHeight, t2, phase, fade, clump.stiffness, flowerPart, trampleBefore, windOf( shared.wind.previous ) ).position ) ) : undefined,
		// The rest of three's instancing: the normal and the instance colour, before the blade moves.
		beforePosition: () => {

			// A bent blade's normal turns with it, so a gust shows as it sweeps by, as a sheen.
			// The blade's own lean tilts it too, so blades leaning apart take the light apart.
			const normal = transformNormal( normalLocal, input.matrix );
			const leanWorld = ground1.xyz.mul( pose.lean.x ).add( ground2.xyz.mul( pose.lean.y ) );
			let bladeNormal = normalize( normal.add( bend.tilt.mul( t.mul( 1.5 ) ) ).add( leanWorld.mul( t ) ) );
			// (far off, its clump's: FAR)
			if ( FAR.share > 0 ) bladeNormal = normalize( mix( bladeNormal, normalize( tuftUp.add( bend.tilt.mul( 0.75 ) ) ), farShare ) );
			normalLocal.assign( mix( bladeNormal, normalize( head.normal.add( bend.tilt.mul( 1.5 ) ) ), isHead ) );
			// (a head takes its own colour, not the lawn's)
			// (a blade lying over in a strong wind shows its paler side, `bendBlade`'s `pale`: 1 up to fair's wind)
			// (the sward's depth, ROOT_DARK: per vertex, the blade's segments ease it in smoothly)
			const dense = smoothstepN( DENSE[ 0 ], DENSE[ 1 ], scaleY ).mul( ground2.w );
			const below = float( 1 ).sub( t ).toVar();
			const depth = float( 1 ).sub( dense.mul( 1 - ROOT_DARK ).mul( below.mul( below ).mul( below ) ) );
			instanceColor.assign( mix( input.color.mul( bend.pale ).mul( depth ), vec3( 1 ), isHead ) );

		},
		sway: () => bend.lean.xz,
		// The tuft's envelope, the same from both sides, folded: each half of a blade turns its normal
		// toward its own edge, so one half takes the light and the other turns from it (FOLD), as a
		// leaf folded along its midrib does.
		// A head is not folded.
		normal: normalize( normalViewGeometry.add( axisView.mul( clamp( side.mul( 4 ), - 1, 1 ).mul( FOLD ).mul( bladeOnly ).mul( float( 1 ).sub( tuftLook.z ) ) ) ) ),
		// The static visibility affects indirect illumination only; sunlight keeps its own shadows.
		// Both the sky's light (here) and the key light (`VegetationLighting` below) fall off toward
		// the root.
		ao: mix( mix( float( 1 ), float( ROOT_SKY ), rootShade ), float( 1 ), smoothstepN( 0.08, 0.85, t ) ).mul( skyVisibility ),
		// Light through the blades: strongest when the grass stands against the sun. Blades do not
		// cast into the sun's shadow map; see MeadowCanopy. Per vertex (lower tiers) it takes the
		// rest pose before the widening, as the shadows do; the mesh is untransformed, so `rooted`
		// is that pose in world space.
		light: ( rest ) => {

			// (with the meadow's shade its march shades the blades in front of the light, at each
			// pixel, in place of the canopy's mean: post/MeadowShade.ts)
			const canopy = MEADOW_SHADE ? float( 1 ) : grassQuality.canopyPerVertex
				? varying( meadowCanopyLight( canopyDepth( rooted ), shared.sunDir ) )
				: meadowCanopyLight( canopyDepth( rest ), shared.sunDir );
			// Light through the upper blades, yellower than the light off them (it crosses the
			// leaf): over the whole half of the view that faces the sun, strongest looking into it
			// (`forwardLight`; the game camera looks down, so a narrow lobe round the sun never met
			// the lawn by day), so lit tips glow yellow-green over roots the key reaches at
			// ROOT_KEY, below the canopy's own shade. A soft gloss along the blades (`SHEEN`): a blade is a thin strip standing
			// along its envelope's normal, so it reflects as a fibre about that axis (Kajiya and
			// Kay's sine of the half vector), broad and faint, brightest on the tips toward a low
			// sun; at half its first strength, as with the specular it paled the lawn toward a coated
			// look. Both follow the key light alone, so by night they stay as faint as the moon.
			return {
				scale: () => mix( mix( float( 1 ), float( ROOT_KEY ), rootShade ), float( 1 ), t ).mul( canopy ),
				extra: ( L, V ) => forwardLight( L, V, FORWARD_POWER ).mul( TRANSLUCENT_FORWARD ).mul( t2 ).mul( vec3( TRANSLUCENT_TINT ) ),
				sheen: ( L, V, N ) => {

					const along = dot( N, normalize( L.add( V ) ) );
					const facing = clamp( dot( N, L ).add( 0.35 ), 0, 1 );
					return vec3( SHEEN ).mul( pow( clamp( float( 1 ).sub( along.mul( along ) ), 0, 1 ), SHEEN_POWER ).mul( facing ).mul( t2 ) ).mul( float( 1 ).sub( tuftLook.z.mul( FAR.sheen ) ) );

				},
			};

		},
	} ) );
	mat.opacityNode = step( bladeVarying.x, bladeCoverage ).mul( mix( float( 1 ), headFragment.mask, onHead ) );
	// The yaoxiang's flowers "shine to the moon": a light of their own, its petals' colour times
	// `flags=yaoxiangGlow:<strength>` set at load (none without it: the look is still being chosen).
	const glow = Number( debugFlags.yaoxiangGlow ?? 0 );
	if ( glow > 0 ) mat.emissiveNode = headFragment.colour.mul( onHead.mul( step( bladeVarying.w, 2.5 + YAOXIANG + 0.5 ) ).mul( glow ) );
	// A blade's specular at SPECULAR of a plain dielectric's (F0 0.04, F90 1): seen edge on, as the
	// game camera sees upright blades, the full Fresnel term laid a pale sky reflection over the
	// whole meadow, a grey veil that read as plastic and took a quarter of its saturation.
	( mat as unknown as { setupSpecular: () => void } ).setupSpecular = () => {

		specularColor.assign( vec3( 0.04 * SPECULAR ) );
		specularColorBlended.assign( vec3( 0.04 * SPECULAR ) );
		specularF90.assign( SPECULAR );

	};
	// The larger casters' shade on the blades, soft and light (SHADE_*), the tuft's (`meadowStill`):
	// the sun's filter takes it in place of its own (SunShadow `install`).
	// With the meadow's shade (post/MeadowShade.ts) the blades and tussocks in front of the light
	// shade it too, at the fragment's pixel.
	const visibility = varying( ownMore.w, 'vGrassSunVisibility' );
	mat.userData.sunVisibility = MEADOW_SHADE ? visibility.mul( meadowShadeAt() ) : visibility;
	mat.userData.wind = shared.wind.direction;
	return mat;

}

/** A tuft's record; a tuft at the cliff's edge also its `edge` record (20 floats: `edgeTuftSteps`)
 * and how far past its blades' reach the drape and the hold off the wall may move them (`pad`, m). */
export interface Tuft { m: THREE.Matrix4; col: THREE.Color; visibility: number; cover: number; rimEdge: number; thin: number; top: number; origin: THREE.Vector3; flower: number; density: number; clump: number; tint?: number; edge?: Float32Array; pad?: number }

type GrassCull = VegetationCull<Tuft>;
// a mat4 node's columns (TSL has them; @types/three does not declare them)
type Columns = { element( i: number ): THREE.Node<'vec4'> };

// The cull's bounds of a tuft (`tuftSphere`). Its widened blades reach out by at most WIDEN_REACH
// times their half width (`MAX_WIDEN` times the blade gain at 70 m, NEAR_GAIN: a tuft there keeps
// a quarter of its blades, less the blade itself), see `pixelWideBlade` and `tuftLod`; a tuft
// farther out keeps fewer and widens them further, and the cull adds that reach in its kernel
// (`cullLod.pad`, 0 up to NEAR_GAIN, so the near tufts' test is the one before). SWAY_PAD is slack
// (m) for rounding: 0.2, wider than the rounding needs, since a tighter sphere changes the visible
// list and with it a few isolated meadow pixels behind the prepass (VegetationCull's rules); a
// smaller pad is a performance step of its own. The wind's bend (Deform.ts `bendBlade`) keeps
// every vertex at its distance from the tuft's origin, so it stays inside the sphere when that is
// padded by twice the origin's distance from the sphere's centre, whatever the wind. The thin
// tufts are culled FOLD_PAD past their fold, so the test never takes a tuft the vertex stage would
// still draw a sliver of.
const NEAR_GAIN = 4;
const WIDEN_REACH = MAX_WIDEN * NEAR_GAIN - 1;
// The most a blade's root half width can be in world space, for the far pad: the widest blade's
// (`tuftGeometry`'s halfWidth) at the widest tuft's scale (PLANT_SPREAD, 1.1 at most).
const PAD_HALF_WIDTH = ( LAWN.w[ 1 ] * 0.5 * GRASSES.broad.width + 0.004 ) * PLANT_SPREAD * 1.1;
const SWAY_PAD = 0.2;
const FOLD_PAD = 0.01;

const _corner = new THREE.Vector3(), _world = new THREE.Box3(), _sphere = new THREE.Sphere();

// A tuft's sphere: the box of its blades' rest poses (its geometry's `restBox`) in world space,
// extended down by its own height (standing water sinks the blades below their anchor), then
// padded for the widening and the sway.
function tuftSphere( t: Tuft, geometry: THREE.BufferGeometry, spheres: Float32Array, i: number ): void {

	const box = geometry.userData.restBox as THREE.Box3, e = t.m.elements;
	_world.makeEmpty();
	for ( let c = 0; c < 8; c ++ ) {

		_corner.set( c & 1 ? box.max.x : box.min.x, c & 2 ? box.max.y : box.min.y, c & 4 ? box.max.z : box.min.z ).applyMatrix4( t.m );
		_world.expandByPoint( _corner );

	}
	_world.min.y -= _world.max.y - _world.min.y;
	// a blade's reach from its root, in metres of the tuft's height scale (its matrix's y axis)
	const reach = ( geometry.userData.reach as number ) * Math.hypot( e[ 4 ], e[ 5 ], e[ 6 ] );
	_world.expandByScalar( reach );
	_world.getBoundingSphere( _sphere );
	const axisScale = Math.max( Math.hypot( e[ 0 ], e[ 1 ], e[ 2 ] ), Math.hypot( e[ 8 ], e[ 9 ], e[ 10 ] ) );
	_sphere.center.toArray( spheres, i * 4 );
	// Every vertex lies in the box, so within the box's radius plus the origin's offset from its
	// centre of the origin; a vertex turned about the origin stays that close to it, so within the
	// radius plus twice the offset of the centre.
	const bend = 2 * _sphere.center.distanceTo( t.origin );
	spheres[ i * 4 + 3 ] = _sphere.radius + bend + WIDEN_REACH * ( geometry.userData.halfWidth as number ) * axisScale + SWAY_PAD + ( t.pad ?? 0 );

}

// A tuft's record (vec4s, the pool's `tuft`), what every vertex of it would work out alike: its
// tussock's values (`tussockOf`: stiffness, lean, none, coarse), the lean's direction with the
// aspect and its shade (`meadowStill`), then the wind at its origin (`meadowWind`: two vec4s of the
// frame being rendered, and under the temporal modes two of the previous one after them). One
// buffer: the vertex stage binds eight storage buffers, WebGPU's least limit. Every draw of the
// meadow reads it, the rain's collision bake's rest pose included, so the page writes it before
// the first (the grass group's `update`, main.ts) and a new pool's before its first draw.
const TUFT_RECORD = TEMPORAL ? 6 : 4;

// The tufts' data in the cull's storage buffers, a slot each: the instance transform, the colour,
// the ground inputs (three vec4s), the planting anchor with the tuft's height and an edge tuft's
// record (five vec4s, zeros for the others).
const GRASS_PAYLOAD: CullPayload<Tuft> = {
	buffers: [ { name: 'matrices', floats: 16, itemSize: 16 }, { name: 'colors', floats: 4, itemSize: 4 }, { name: 'ground', floats: 12, itemSize: 4 }, { name: 'origins', floats: 4, itemSize: 4 },
		{ name: 'edge', floats: 20, itemSize: 4 } ],
	origin: 'origins',
	matrices: 'matrices',
	// each tuft's record (TUFT_RECORD) and its record of the islanders' trail (Trample.ts
	// `trampleKernel`)
	scratch: [ { name: 'tuft', floats: TUFT_RECORD * 4 }, ...( debugFlags.trample !== false ? [ { name: 'trail', floats: TRAMPLE_RECORD * 4 } ] : [] ) ],
	write( t, i, { matrices, colors, ground, origins, edge } ) {

		t.m.toArray( matrices, i * 16 );
		// (the fourth channel: the tussock's word, `plantGrass`)
		colors[ i * 4 ] = t.col.r; colors[ i * 4 + 1 ] = t.col.g; colors[ i * 4 + 2 ] = t.col.b; colors[ i * 4 + 3 ] = t.clump;
		const e = t.m.elements;
		// x: sky visibility, y: the flower code of a flowering tuft (1.5 + its head, `FLOWER_SPECIES`, else 0), z: rim cover, w: rim edge (1 on the plateau's outer rim,
		// where blades stand against the sea and stay narrower at 4x: the opaque pass's MSAA edge pixels
		// there resolve against the sky-coloured clear, so every partly covered pixel a widened
		// blade adds shows as a pale fringe over the sea); then the instance's local x axis with the
		// thin flag (1 for the extra tufts that fold away with distance; the shader takes the x axis
		// from the matrix, its slot here holds its stroke's place on the palette's run: STROKE), and its local z axis with
		// the share of its blades the soil lets it keep (`density`, `tuftLod`). A blade's width lies
		// in the plane of those axes: the vertex stage keeps thin blades a minimum width on screen
		// in world space.
		ground.set( [ t.visibility, t.flower, t.cover, t.rimEdge, 0, 0, t.tint ?? 0.5, t.thin, e[ 8 ], e[ 9 ], e[ 10 ], t.density ], i * 12 );
		t.origin.toArray( origins, i * 4 );
		origins[ i * 4 + 3 ] = t.top;
		if ( t.edge ) edge.set( t.edge, i * 20 );

	},
	sphere: tuftSphere,
	// the thin extra tufts have folded into their roots beyond thinFar
	fold: {
		far: grassUniforms.thinFar,
		folded: ( slot, origin, camera, node ) => node( 'ground' ).element( slot.mul( 3 ).add( 1 ) ).w.greaterThan( 0.5 ).and( length( camera.sub( origin ) ).greaterThanEqual( grassUniforms.thinFar.add( FOLD_PAD ) ) ),
	},
};

/** The still part of every tuft's record (TUFT_RECORD): its tussock's values and the larger
 * casters' shade on it (SHADE_*) times its taller neighbours' (`meadowCastLight`), which the blades
 * read as their sun visibility (`grassMaterial`).
 * Taken per vertex, the shade's lookups of both stepped maps were about a third of the meadow's
 * vertex work, for a shade whose ring is wider than a tuft. The kernel runs over every slot
 * whenever the sun's maps or their blend have changed (a redraw, the blend's weight as the sun
 * turns, the first call), the key light has turned or the pool has: the returned function, which the frame calls after the
 * sun's maps update and before it renders, as the trail's kernels run, outside the scene's passes
 * (the grass group's `update`; a paused clock runs it once). */
function meadowStill( cull: GrassCull, sunShadow: SunShadow, shared: Shared ): ( renderer: THREE.Renderer ) => void {

	const origins = cull.node( 'origins', 'vec4', true ), colors = cull.node( 'colors', 'vec4', true ), matrices = cull.node( 'matrices', 'mat4', true );
	const record = cull.node( 'tuft', 'vec4' );
	const cast = debugFlags.meadowCast !== false;
	const kernel = Fn( () => {

		const slot = workgroupId.x.mul( CULL_GROUP ).add( localId.x ).toVar();
		const origin = origins.element( slot ).toVar();
		const at = origin.xyz.add( vec3( 0, origin.w.mul( SHADE_HEIGHT ).add( SHADE_LIFT ), 0 ) );
		const caster = mix( float( 1 ), sunShadow.softVisibility( at, SHADE_RADIUS, SHADE_TAPS ), SHADE_DEPTH );
		const shade = cast ? caster.mul( meadowCastLight( canopyTop, origin.xyz.add( vec3( 0, origin.w, 0 ) ), shared.sunDir ) ) : caster;
		const scaleY = origin.w.div( CANOPY_TOP ).toVar();
		const own = tussockOf( colors.element( slot ).w, scaleY );
		const aspect = scaleY.div( length( ( matrices.element( slot ) as unknown as Columns ).element( 0 ).xyz ) );
		record.element( slot.mul( TUFT_RECORD ) ).assign( vec4( own.stiffness, own.lean, 0, own.coarse ) );
		record.element( slot.mul( TUFT_RECORD ).add( 1 ) ).assign( vec4( own.dir, aspect, shade ) );

	} )().computeKernel( [ CULL_GROUP ] ).setName( 'Grass.Still' );
	// (the pool's filled workgroups: a new pool's size reaches it)
	kernel.dispatchSize = cull.workgroups;
	let draws = - 1, weight = - 1, ready = - 1, buffer: THREE.StorageBufferAttribute | null = null;
	const key = new THREE.Vector3( NaN, NaN, NaN );
	return ( renderer ) => {

		const pool = cull.buffer( 'tuft' );
		if ( sunShadow.draws === draws && sunShadow.weight.value === weight && sunShadow.ready.value === ready && pool === buffer && ( ! cast || key.equals( shared.sunDir.value ) ) ) return;
		key.copy( shared.sunDir.value );
		draws = sunShadow.draws;
		weight = sunShadow.weight.value;
		ready = sunShadow.ready.value;
		buffer = pool;
		renderer.compute( kernel );

	};

}

/** The wind part of every tuft's record (TUFT_RECORD): the wind at its origin (Deform.ts
 * `tuftWind`), which its blades bend by (`grassMaterial`): per vertex, its two lookups of the gust
 * map were the vertex stage's only texture reads but the shade's. The returned function runs the
 * kernel over every slot: the frame calls it every frame once the wind has stepped (main.ts, the
 * grass group's `update`), and each of the meadow's draws with `fresh`, which runs it only for a
 * pool a growth's swap brought after that call. */
function meadowWind( cull: GrassCull, shared: Shared ): ( renderer: THREE.Renderer, fresh?: boolean ) => void {

	const origins = cull.node( 'origins', 'vec4', true ), record = cull.node( 'tuft', 'vec4' );
	const kernel = Fn( () => {

		const slot = workgroupId.x.mul( CULL_GROUP ).add( localId.x ).toVar();
		const root = origins.element( slot ).xz.toVar();
		const write = ( state: WindState, k: number ) => {

			const w = tuftWind( state, root );
			record.element( slot.mul( TUFT_RECORD ).add( k + 2 ) ).assign( w.field );
			record.element( slot.mul( TUFT_RECORD ).add( k + 3 ) ).assign( vec4( w.travel, w.swing, w.shiver, w.load ) );

		};
		write( shared.wind, 0 );
		if ( TEMPORAL ) write( shared.wind.previous, 2 );

	} )().computeKernel( [ CULL_GROUP ] ).setName( 'Grass.Wind' );
	kernel.dispatchSize = cull.workgroups;
	let buffer: THREE.StorageBufferAttribute | null = null;
	return ( renderer, fresh = false ) => {

		const pool = cull.buffer( 'tuft' );
		if ( fresh && pool === buffer ) return;
		buffer = pool;
		renderer.compute( kernel );

	};

}

/** The vertex stage's view of the culled buffers: `index` is the drawn tuft's slot. */
function tuftInputs( cull: GrassCull, index: THREE.Node<'uint'> ) {

	const ground = cull.node( 'ground', 'vec4', true );
	return {
		matrix: cull.node( 'matrices', 'mat4', true ).element( index ),
		color: cull.node( 'colors', 'vec4', true ).element( index ).xyz,
		clump: cull.node( 'colors', 'vec4', true ).element( index ).w,
		ground: ( k: number ) => ground.element( index.mul( 3 ).add( k ) ),
		origin: cull.node( 'origins', 'vec4', true ).element( index ),
		edge: ( k: number ) => cull.node( 'edge', 'vec4', true ).element( index.mul( 5 ).add( k ) ),
	};

}

// One instanced mesh per batch of tufts of one kind, over its own geometry (the draw range and the
// indirect arguments belong to it) that shares the tuft's vertex buffers. Its instance data (the
// transform, colour, ground inputs and anchor) live in the cull's storage buffers from the
// batch's first slot on, read by the material through the drawn tuft's slot; `instanceMatrix`
// and `instanceColor` point at those buffers for code that looks for them, and since neither is an
// instanced attribute three leaves the instancing to the material.
function tuftMesh( source: THREE.BufferGeometry, shape: TuftShape, floor: number, material: THREE.Material, cull: GrassCull, range: CullRange, name: string ): THREE.InstancedMesh {

	const geometry = new THREE.BufferGeometry();
	for ( const key of [ 'position', 'normal', 'blade' ] ) geometry.setAttribute( key, source.getAttribute( key ) );
	geometry.setIndex( source.getIndex() );
	geometry.boundingBox = source.boundingBox!.clone();
	geometry.userData.grassBase = range.start;
	geometry.userData.grassBlades = shape.blades;
	geometry.userData.grassFloor = floor;
	geometry.userData.grassBladeVerts = ( shape.segs + 1 ) * 2;
	geometry.userData.grassFlowers = ( source.userData.baseIndices ?? 0 ) > 0 ? 1 : 0;
	const mesh = new THREE.InstancedMesh( geometry, material, Math.max( range.count, 1 ) );
	mesh.instanceMatrix.array = new Float32Array( 16 ); // replaced below; drop the copy InstancedMesh allocates
	( mesh as unknown as { instanceMatrix: THREE.BufferAttribute } ).instanceMatrix = cull.buffer( 'matrices' );
	( mesh as unknown as { instanceColor: THREE.BufferAttribute } ).instanceColor = cull.buffer( 'colors' );
	mesh.count = range.count;
	// its whole count (it picks its count per view draw): the rain's collision bake draws them all
	mesh.userData.bakeCount = range.count;
	mesh.frustumCulled = false;
	mesh.castShadow = false; // see MeadowCanopy
	mesh.receiveShadow = true;
	mesh.name = name;
	mesh.renderOrder = - 1; // before the terrain: the turf it covers then fails the depth test
	return mesh;

}

// Every draw of the meadow chooses what it needs as it is rendered, from the view camera's
// distance to the box of the batch's planting anchors. It is a function of the camera's
// position alone, never of the path it came by, so a paused frame repeats exactly:
// - the thin extra tufts are skipped once the camera is beyond `thinFar` of every one of them,
//   where all of them have folded into their roots (the fold is the shader's, unchanged);
// - each tuft keeps its blades by its own distance in the vertex stage (`tuftLod`); the batch's
//   draw range ends after the blades its nearest possible tuft keeps (the box's nearest point,
//   at the least staggered distance), so blades no tuft keeps are not even run through the vertex
//   stage. Culled, that range is the first band's index count, and the cull draws every other
//   band with its own cap's blades (`bandCaps`), so a far tuft runs only the blades it keeps (and
//   at most a band's step more).
// A batch is one per kind, holding every chunk's tufts in the chunks' order (the cull's pool),
// not one per chunk: that would add render objects per meadow chunk. Its bands are draws of the
// one render object (the geometry's indirect offsets), and so are its depth copy's.
// Other cameras (the rain's collision bake looks straight down, orthographic) see every tuft
// with all its blades, as before.
// The view camera's draws are then culled per tuft on the GPU (`VegetationCull`): one compute pass
// for all batches, before the first of them draws, and only when the view or the selection
// changed; each batch draws its surviving tufts through indirect arguments, set on its geometry
// for that draw alone, so any other mesh over the same geometry (the collision bake's proxies)
// draws every tuft.
const _cameraPosition = new THREE.Vector3(), _leaves = new THREE.Color();

// (`base`: the indices drawn before the blades, a flowering tuft's head)
interface Batch { mesh: THREE.InstancedMesh; box: THREE.Box3; shape: TuftShape; floor: number; thin: boolean; count: number; range: CullRange; base: number }

function selectBatch( batch: Batch, camera: THREE.Camera ): void {

	const { mesh, shape } = batch;
	const full = batch.base + shape.blades * shape.segs * 6;
	if ( ! ( camera as THREE.PerspectiveCamera ).isPerspectiveCamera ) {

		mesh.count = batch.count;
		mesh.geometry.drawRange.count = full;
		mesh.userData.grassLod = false;
		return;

	}

	const d = batch.box.distanceToPoint( _cameraPosition.setFromMatrixPosition( camera.matrixWorld ) );
	mesh.count = batch.thin && debugFlags.grassThinCull !== false && d >= grassUniforms.thinFar.value ? 0 : batch.count;
	const lod = debugFlags.grassLod !== false;
	// (the shader's count rounds a little differently: a blade it keeps a sliver of past the range
	// is a hair's width, and the full range at the first band is exact)
	const blades = lod ? Math.min( shape.blades, Math.ceil( shape.blades * bladeShare( d * ( 1 - LOD_STAGGER ), batch.floor ) - 1e-6 ) ) : shape.blades;
	mesh.geometry.drawRange.count = batch.base + blades * shape.segs * 6;
	mesh.userData.grassLod = lod;

}

function drawBatch( batches: Batch[], cull: GrassCull, batch: Batch, renderer: THREE.Renderer, camera: THREE.Camera ): void {

	// Off (`flags.grassCull = false`): every tuft, as an instanced draw of all of them.
	const culled = ( camera as THREE.PerspectiveCamera ).isPerspectiveCamera && debugFlags.grassCull !== false;
	if ( ! culled ) {

		selectBatch( batch, camera );
		batch.mesh.userData.grassCulled = false;
		return;

	}
	// The first batch drawn for this view selects every batch and culls them all at once.
	if ( batch === batches.find( ( b ) => b.range.count > 0 ) ) {

		for ( const b of batches ) {

			selectBatch( b, camera );
			b.range.indexCount.value = b.mesh.geometry.drawRange.count;

		}
		cullLod.on.value = debugFlags.grassLod !== false ? 1 : 0;
		cullLod.bands.value = debugFlags.grassBands !== false ? 1 : 0;
		cull.update( renderer, camera );

	} else selectBatch( batch, camera );
	batch.mesh.userData.grassCulled = true;
	// a draw per band (three issues one for each offset)
	( batch.mesh.geometry as unknown as { setIndirect( a: THREE.IndirectStorageBufferAttribute, offsets: number[] ): void } ).setIndirect( cull.indirect, batch.range.indirectOffsets );

}

function batchOf( source: THREE.BufferGeometry, shape: TuftShape, floor: number, material: THREE.Material, cull: GrassCull, range: CullRange, tufts: Tuft[], name: string, thin = false ): Batch {

	const mesh = tuftMesh( source, shape, floor, material, cull, range, name );
	const box = new THREE.Box3();
	for ( const t of tufts ) box.expandByPoint( t.origin );
	return { mesh, box, shape, floor, thin, count: tufts.length, range, base: source.userData.baseIndices ?? 0 };

}

/** The meadow's tufts of each kind, one record per instance: the lawn, its thin extra tufts and its
 * flowering tufts; and the sward's depth at every anchor that holds turf ( x, z, depth each: the
 * ground's field, SwardField.ts). */
export interface GrassTufts { lawn: Tuft[]; lawnThin: Tuft[]; lawnFlower: Tuft[]; sward: number[] }
type TuftKind = 'lawn' | 'lawnThin' | 'lawnFlower';

/** The tufts grown on the anchors `veg` (any of them: each anchor's tufts depend on that anchor
 * alone); `walkDistance` (m from a point to the islander's loop) keeps the flowers off the path;
 * `shore` (the world's shore field) gives the soil's depth its coast term, as the ground reads it
 * (the anchor's own rim distance without it); `rimLip` (the worker's lip) gives the tufts near the
 * cliff's edge their edge records (`edgeTuftSteps`). */
export function plantGrass( veg: Float32Array, rimGround?: RimGroundField, walkDistance?: ( x: number, z: number ) => number, shore?: ShoreField, rimLip?: RimLipData, grove?: ArrayLike<number> ): GrassTufts {

	const n = veg.length / STRIDE;
	const lawn: Tuft[] = [], lawnThin: Tuft[] = [], lawnFlower: Tuft[] = [], sward: number[] = [];
	// The soil (Meadow.ts `meadowSoil`) from the shore field as the ground samples it; without it, from
	// each anchor's own rim distance alone (no side of the wind: tools that plant without the field).
	let ownRim = 0;
	const shoreAt: ShoreAt = shore ? ( x, z ) => shoreDistance( shore, x, z ) : () => ownRim - SHORE_RIM;
	const swaths = new FlowerSwaths( ( x, z ) => meadowTurf( meadowSoil( x, z, shoreAt ) ), rimGround ? ( x, z ) => sampleRimGround( rimGround, x, z ).distance : () => - Infinity, grove );
	const draws = new Float32Array( 8 ), own = new Float32Array( 8 );
	const q = new THREE.Quaternion(), qy = new THREE.Quaternion(), inverse = new THREE.Quaternion();
	const up = new THREE.Vector3( 0, 1, 0 ), dir = new THREE.Vector3(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
	const out = new THREE.Vector3(), lean = new THREE.Vector3(), local = new THREE.Vector3();
	const col = new THREE.Color();
	let density = 1, stiffByte = 0, leanByte = 0;
	let tint = 0.5;
	// the tussock's word for a tuft turned by `rotation`: its lean's direction in the tuft's frame
	const word = ( rotation: THREE.Quaternion ) => {

		local.copy( lean ).applyQuaternion( inverse.copy( rotation ).invert() );
		const angle = ( Math.atan2( local.z, local.x ) / ( Math.PI * 2 ) + 1 ) % 1;
		return stiffByte + 256 * leanByte + 65536 * ( Math.round( angle * 256 ) % 256 );

	};
	const plant = ( list: Tuft[], at: THREE.Vector3, rotation: THREE.Quaternion, scale: THREE.Vector3, color: THREE.Color,
		k: number, cover: number, rimEdge: number, thin: number, flower = 0 ) => list.push( {
		m: new THREE.Matrix4().compose( at, rotation, scale ), col: color.clone(), visibility: veg[ k + 8 ], cover, rimEdge, thin,
		top: scale.y * CANOPY_TOP, origin: at.clone(), flower, density, clump: word( rotation ), tint,
	} );

	for ( let i = 0; i < n; i ++ ) {

		const k = i * STRIDE;
		const x = veg[ k ], y = veg[ k + 1 ], z = veg[ k + 2 ];
		const rim = veg[ k + 6 ];
		ownRim = rim;
		// Streams of the anchor's own cell: the lawn's, one for everything added since (a fixed
		// count of draws) and the tussock's, so no anchor's planting depends on another's.
		const rng = anchorStream( x, z, 99 ), more = anchorStream( x, z, 131 ), tussock = anchorStream( x, z, 233 );
		// stand with the ground, leaning out a little more over the rim
		dir.set( veg[ k + 3 ], veg[ k + 4 ], veg[ k + 5 ] ).lerp( up, 0.3 ).normalize();
		q.setFromUnitVectors( up, dir );
		qy.setFromAxisAngle( up, rng() * Math.PI * 2 );
		q.multiply( qy );

		const onStack = veg[ k + 7 ] > 0;
		rng(); // (the lawn's former height draw, kept so the stream's later draws stay)
		pos.set( x, y - 0.018, z );
		scl.set( PLANT_SPREAD * ( 0.9 + rng() * 0.2 ), 1, PLANT_SPREAD * ( 0.9 + rng() * 0.2 ) );

		// The lawn's one colour, as the turf under it shows it (Meadow.ts).
		meadowColor( x, z, col );
		for ( let d = 0; d < draws.length; d ++ ) draws[ d ] = more();
		for ( let d = 0; d < own.length; d ++ ) own[ d ] = tussock();
		if ( ! supportsMeadow( y, veg[ k + 4 ] ) ) continue;
		const rimEdge = smoothstep( - 1.5, - 0.3, rim );

		// The meadow runs to the lip. Toward the coast the tufts lean out over its shoulder (SHOULDER),
		// along the coast field's gradient (any coast line, wherever the footprint puts it), so they
		// meet the root soil instead of stopping short of it, and stand stiffer (LIP_STIFF); those near
		// the edge drape over it (`edgeTuftSteps`). Where that field exposes a soil pocket
		// the tufts narrow only a little: the pocket shows between them.
		let cover = 1, spill = 0;
		if ( rimGround ) {

			const g = sampleRimGround( rimGround, x, z );
			cover = rimGrassCover( g );
			spill = smoothstep( - SHOULDER, - 0.05, g.distance );
			const e = 0.2;
			out.set( sampleRimGround( rimGround, x + e, z ).distance - sampleRimGround( rimGround, x - e, z ).distance, 0,
				sampleRimGround( rimGround, x, z + e ).distance - sampleRimGround( rimGround, x, z - e ).distance );

		} else {

			spill = smoothstep( - 1.1, - 0.2, rim );
			out.set( veg[ k + 3 ], 0, veg[ k + 5 ] );

		}
		if ( out.lengthSq() > 1e-8 ) out.normalize();
		// (draws added since, from a stream of their own: the tussock's answer to its spot's pull,
		// GRADE, and its side of straight out at the shoulder, SHOULDER_TURN)
		const grade = anchorStream( x, z, 263 );
		const g0 = grade(), g1 = grade(), g2 = grade();
		if ( spill > 0 && ! onStack ) {

			const side = ( 2 * g2 - 1 ) * SHOULDER_TURN, c = Math.cos( side ), s = Math.sin( side );
			out.set( out.x * c - out.z * s, 0, out.x * s + out.z * c );
			dir.addScaledVector( out, spill * spill * ( SHOULDER_LEAN[ 0 ] + SHOULDER_LEAN[ 1 ] * draws[ 0 ] ) ).normalize();
			q.setFromUnitVectors( up, dir ).multiply( qy );

		}
		// Whether the tuft flowers, and which head, from a stream of its own (the lawn's draws stay
		// as they were): by the swath at it, or now and then alone between the swaths.
		const bloom = anchorStream( x, z, 211 );
		const b0 = bloom(), b1 = bloom();
		let flower = 0, head = - 1;
		if ( ! onStack && ( ! walkDistance || walkDistance( x, z ) >= FLOWER_CLEAR ) ) {

			const swath = swaths.at( x, z, rim );
			head = swath.share > 0 ? ( b0 < swath.share ? swath.head : - 1 ) : b0 < STRAY ? swaths.stray( x, z, rim, b1 ) : - 1;
			if ( head >= 0 ) flower = 1.5 + head;

		}

		// The tussock (LEVEL, TUSSOCK): short on the stacks' thin soil and for SHORT_STAY of them
		// anywhere, else part of the way down as its spot pulls it (a shallow pocket or a low patch,
		// GRADE); a flowering one as its species grows (LOW_FLOWER), so the flowers keep their
		// habitat and count.
		const lowFlower = head === ZHUYU;
		const vigour = meadowVigour( x, z ), thin = meadowShallow( x, z );
		let short = 0;
		if ( onStack || own[ 0 ] >= 1 - SHORT_STAY ) short = 1;
		else if ( g0 >= GRADE.stand ) short = Math.min( Math.max( thin, lowPatch( x, z ) ) * ( GRADE.answer[ 0 ] + ( GRADE.answer[ 1 ] - GRADE.answer[ 0 ] ) * g1 ), 1 );
		if ( flower > 0 ) short = lowFlower ? Math.max( short, LOW_FLOWER ) : 0;
		// its clump (CLUMP), the more the taller it stands
		const clump = CLUMPS && ! onStack ? clumpAt( x, z ) : null;
		const clumped = clump ? 1 - short : 0;
		const rimGap = clump ? CLUMP.rimGap * smoothstep( CLUMP.rim, 1, clump.t ) * clumped : 0;
		if ( short < 0.5 && flower === 0 && own[ 7 ] < THIN_GAP * thin + rimGap ) {

			sward.push( x, z, - 1 );
			continue;

		}
		const lush = LUSH[ 0 ] + ( LUSH[ 1 ] - LUSH[ 0 ] ) * smoothstep( VIGOUR_LUSH[ 0 ], VIGOUR_LUSH[ 1 ], vigour );
		const level = LEVEL.ordinary * lush + ( LEVEL.short - LEVEL.ordinary * lush ) * short;
		const spread = TUSSOCK.spread + ( TUSSOCK.shortSpread - TUSSOCK.spread ) * short;
		const ownSpread = clump ? spread + ( CLUMP.own - spread ) * clumped : spread;
		const clumpHeight = clump ? 1 + ( clump.height - 1 ) * clumped : 1;
		const height = Math.min( level * clumpHeight * ( 1 + ownSpread * ( 2 * own[ 1 ] - 1 ) ), LEVEL.ordinary * ( clump ? CLUMP.cap : 1 + TUSSOCK.spread ) );
		scl.y = height;
		if ( spill > 0 && ! onStack ) scl.y *= 1 - spill * ( SHOULDER_LOW[ 0 ] + SHOULDER_LOW[ 1 ] * draws[ 1 ] );
		scl.x *= 0.65 + 0.35 * cover;
		scl.z *= 0.65 + 0.35 * cover;
		scl.y *= 0.8 + 0.2 * cover;
		// its stiffness (a byte of STIFF_RANGE), its lean: one of its own toward a direction of its own
		const stiffness = ( 1 + TUSSOCK.stiffness * ( 2 * own[ 2 ] - 1 ) ) * Math.max( 1, height / LEVEL.ordinary ) ** TUSSOCK.levelStiff * ( 1 + LIP_STIFF * spill );
		stiffByte = Math.round( Math.min( Math.max( ( stiffness - STIFF_RANGE[ 0 ] ) / ( STIFF_RANGE[ 1 ] - STIFF_RANGE[ 0 ] ), 0 ), 1 ) * 255 );
		const turn = own[ 3 ] * Math.PI * 2, mine = TUSSOCK.lean * own[ 4 ];
		lean.set( Math.cos( turn ) * mine, 0, Math.sin( turn ) * mine );
		if ( clump ) {

			// its clump's lean toward the clump's own side, a fifth of its own kept
			const cx = Math.cos( clump.turn ) * TUSSOCK.lean * CLUMP.same, cz = Math.sin( clump.turn ) * TUSSOCK.lean * CLUMP.same;
			const keep = 1 - 0.8 * clumped;
			lean.set( lean.x * keep + cx * clumped, 0, lean.z * keep + cz * clumped );

		}
		leanByte = Math.round( Math.min( lean.length(), 1 ) * 255 );
		// Each tussock keeps its clump's share of the blades (TUSSOCK.blades), all of them as it comes
		// down; one out of the clumps (the stacks') its own.
		const share = clump ? clump.blades : own[ 5 ];
		const tallShare = ( TUSSOCK.blades[ 0 ] + ( TUSSOCK.blades[ 1 ] - TUSSOCK.blades[ 0 ] ) * share ) / LAWN.blades;
		let blades = tallShare + ( 1 - tallShare ) * short;
		if ( clump ) blades += ( 1 - blades ) * CLUMP.types[ clump.type ].full * clumped;
		density = blades;
		sward.push( x, z, smoothstep( DENSE[ 0 ], DENSE[ 1 ], scl.y ) * density );
		// Its colour: the lawn's everywhere, a flowering tussock's its species' leaves' (LEAVES, the
		// extra tuft beside it too).
		if ( flower > 0 ) col.multiply( _leaves.fromArray( LEAVES[ head ] ) );
		// Its place on the palette's run and its value: its clump's stroke's, a little of the clump's own
		// (STROKE); the middle of the run out of the clumps.
		tint = 0.5;
		if ( clump ) {

			const stroke = strokeAt( clump.cx, clump.cz );
			tint = Math.min( Math.max( stroke.tint + ( clump.tint - 0.5 ) * 2 * STROKE.own, 0 ), 1 );
			col.multiplyScalar( 1 + STROKE.value * ( 2 * ( stroke.value + ( clump.value - 0.5 ) * 2 * STROKE.own ) - 1 ) );

		}
		plant( flower > 0 ? lawnFlower : lawn, pos, q, scl, col, k, cover, rimEdge, 0, flower );

		// About a quarter of the tussocks take a second tuft, picked by the anchor's own hash (no
		// field: a field made patches of denser sward): beside the first, of its height and its
		// tussock's word, so the tussock holds 24 - 30 blades. Clear of the rim, where an offset root
		// could leave the turf.
		if ( draws[ 2 ] < THIN_SHARE * ( 1 - smoothstep( - 0.7, - 0.35, rim ) ) && ! onStack ) {

			pos.set( x + ( draws[ 3 ] - 0.5 ) * 0.06, y - 0.018, z + ( draws[ 4 ] - 0.5 ) * 0.06 );
			dir.set( veg[ k + 3 ], veg[ k + 4 ], veg[ k + 5 ] ).lerp( up, 0.3 ).normalize();
			q.setFromUnitVectors( up, dir ).multiply( qy.setFromAxisAngle( up, draws[ 5 ] * Math.PI * 2 ) );
			scl.set( PLANT_SPREAD * ( 0.9 + draws[ 6 ] * 0.2 ), scl.y * ( 0.96 + draws[ 7 ] * 0.08 ), PLANT_SPREAD * ( 0.9 + draws[ 6 ] * 0.2 ) );
			density = ( TUSSOCK.extraBlades[ 0 ] + ( TUSSOCK.extraBlades[ 1 ] - TUSSOCK.extraBlades[ 0 ] ) * ( clump ? clump.blades : own[ 6 ] ) ) / LAWN.blades;
			if ( grassQuality.thinTufts ) plant( lawnThin, pos, q, scl, col, k, cover, rimEdge, 1 );

		}

	}
	if ( rimLip ) runSteps( edgeTuftSteps( [ lawn, lawnThin, lawnFlower ], rimLip ) );
	return { lawn, lawnThin, lawnFlower, sward };

}

/** The edge record of every meadow tuft rooted within EDGE_REACH of the cliff's edge (the nearest
 * of the worker's lip samples, `lip`): the coast's offset along its outward direction, the roof's
 * height, the outward direction ( x, z ), then its wall (LIP_WALLS offsets out of the coast, every
 * LIP_DEPTH under the roof, LIE added; the first at the coast itself). The vertex stage drapes the
 * parts of its blades past the edge over it and holds them off the wall (`drape`, `holdOff`). */
export function* edgeTuftSteps( lists: Tuft[][], lip: RimLipData, per = Infinity ): Generator<void, void> {

	const { info, pieces } = lip;
	// the samples by cells of EDGE_REACH, in the lip's order
	const cells = new Map<string, number[]>();
	const key = ( i: number, j: number ) => i + ',' + j;
	for ( let l = 0; l < pieces.length; l += 2 ) for ( let s = pieces[ l ]; s < pieces[ l ] + pieces[ l + 1 ]; s ++ ) {

		const k = key( Math.floor( info[ s * LIP_INFO ] / EDGE_REACH ), Math.floor( info[ s * LIP_INFO + 1 ] / EDGE_REACH ) );
		let list = cells.get( k );
		if ( ! list ) cells.set( k, list = [] );
		list.push( s );

	}
	let done = 0;
	for ( const tufts of lists ) for ( const t of tufts ) {

		if ( ++ done % per === 0 ) yield;
		const x = t.origin.x, z = t.origin.z, ci = Math.floor( x / EDGE_REACH ), cj = Math.floor( z / EDGE_REACH );
		let best = - 1, nearest = EDGE_REACH * EDGE_REACH;
		for ( let dj = - 1; dj <= 1; dj ++ ) for ( let di = - 1; di <= 1; di ++ ) for ( const s of cells.get( key( ci + di, cj + dj ) ) ?? [] ) {

			const dx = info[ s * LIP_INFO ] - x, dz = info[ s * LIP_INFO + 1 ] - z, d = dx * dx + dz * dz;
			if ( d < nearest ) { nearest = d; best = s; }

		}
		if ( best < 0 ) continue;
		const [ sx, sz, nx, nz, , roof ] = info.subarray( best * LIP_INFO, best * LIP_INFO + 6 );
		const record = new Float32Array( 20 );
		record.set( [ sx * nx + sz * nz, roof, nx, nz, LIE ] );
		for ( let k = 1; k < LIP_WALLS; k ++ ) record[ 4 + k ] = info[ best * LIP_INFO + 5 + k ] + LIE;
		t.edge = record;
		t.pad = EDGE_PAD;

	}

}

/** The meadow: its lawn meshes in one group, drawing the tufts `plantGrass` grew; `sunShadow`
 * gives the blades the larger casters' soft shade. */
export function buildGrass( { lawn, lawnThin, lawnFlower, sward }: GrassTufts, shared: Shared, sunShadow: SunShadow ): THREE.Group {

	const crowns = runSteps( crownSteps( [ lawn, lawnThin, lawnFlower ] ) );
	setSwardField( runSteps( swardSteps( sward, SWARD_FALLBACK, crowns ) ) );
	setCanopyTop( runSteps( canopySteps( crowns ) ) );

	// (the tier's least blade width applies under the temporal modes only: 4x and one sample keep
	// theirs, see `grassUniforms`)
	if ( TEMPORAL ) grassUniforms.minWidth.value = grassQuality.minWidth;
	// (the rim keeps its blades narrower than the rest at 4x, never wider: on high the temporal
	// meadow draws its blades at their own width, and its rim alone widened to 0.75 px drew the
	// cliff's edge as a band of coarser, darker blades than the meadow inside it)
	grassUniforms.rimMinWidth.value = Math.min( RIM_MIN_WIDTH, grassUniforms.minWidth.value );
	lodUniforms.bands.value.fromArray( grassQuality.bladeBands );
	lodUniforms.shares.value.fromArray( grassQuality.lawnBlades ).divideScalar( LAWN.blades );
	grassUniforms.thinNear.value = grassQuality.thinFold[ 0 ];
	grassUniforms.thinFar.value = grassQuality.thinFold[ 1 ];
	const group = new THREE.Group();
	group.name = 'grass';
	const lawnGeometry = tuftGeometry( LAWN, 3 );
	// The extra tufts of thick patches draw on their own, so they can be skipped as a whole.
	// The least share a visible tuft keeps: two blades far away (LEAST_BLADES), or a thin tuft's at its
	// fold (the cull drops it past thinFar).
	const minShare = LEAST_BLADES / LAWN.blades;
	const thinShare = bladeShare( grassUniforms.thinFar.value + 0.01, 0 );
	const kinds: { geometry: THREE.BufferGeometry; shape: TuftShape; floor: number; tufts: Tuft[]; name: string; key: TuftKind; thin: boolean; minShare: number }[] = [
		{ geometry: lawnGeometry, shape: LAWN, floor: 0, tufts: lawn, name: 'grass-lawn', key: 'lawn', thin: false, minShare },
	];
	// (the thin batch exists whenever the tier grows thin tufts, even with none yet, and the
	// flowering batch always: a grown island's meadow then fills the same batches, and the cull's
	// kernels stay the same)
	if ( grassQuality.thinTufts ) kinds.push( { geometry: lawnGeometry, shape: LAWN, floor: 0, tufts: lawnThin, name: 'grass-lawn-thin', key: 'lawnThin', thin: true, minShare: thinShare } );
	// The flowering tufts draw on their own, over the lawn's blades and a head, so the tufts without
	// a flower run no head vertices.
	kinds.push( { geometry: flowerTuftGeometry( lawnGeometry ), shape: LAWN, floor: 0, tufts: lawnFlower, name: 'grass-lawn-flower', key: 'lawnFlower', thin: false, minShare } );
	const cull: GrassCull = new VegetationCull( { name: 'Grass', payload: GRASS_PAYLOAD, lod: cullLod }, kinds.map( ( k ) => ( {
		records: k.tufts, geometry: k.geometry, blades: k.shape.blades, floor: k.floor,
		caps: bandCaps( k.shape.blades, k.floor, k.minShare ), bladeIndices: k.shape.segs * 6, baseIndices: k.geometry.userData.baseIndices ?? 0,
	} ) ) );
	const material = grassMaterial( shared, cull );
	const still = meadowStill( cull, sunShadow, shared ), wind = meadowWind( cull, shared );
	// the tufts' records of the islanders' trail, written by Trample whenever the trail changes
	if ( debugFlags.trample !== false ) shared.trample.kernels.push( group.userData.trail = trampleKernel( shared.trample, cull.node( 'origins', 'vec4', true ), cull.node( 'trail', 'vec4' ), cull.workgroups ) );
	const batches = kinds.map( ( k, i ) => batchOf( k.geometry, k.shape, k.floor, material, cull, cull.ranges[ i ], k.tufts, k.name, k.thin ) );
	for ( const b of batches ) {

		b.mesh.onBeforeRender = ( renderer, _scene, camera ) => {

			// (nothing to do but in the frame a growth's swap brought a new pool after the frame's own
			// call: its records, zeros, are written before it draws)
			still( renderer as unknown as THREE.Renderer );
			wind( renderer as unknown as THREE.Renderer, true );
			drawBatch( batches, cull, b, renderer as unknown as THREE.Renderer, camera );

		};
		// the indirect arguments belong to this draw alone
		b.mesh.onAfterRender = () => {

			b.mesh.geometry.indirect = null;

		};
		group.add( b.mesh );

	}
	// for probes and tuning from the console ( __PONLAI__.grass )
	group.userData.minWidth = grassUniforms.minWidth;
	group.userData.rimMinWidth = grassUniforms.rimMinWidth;
	group.userData.thinNear = grassUniforms.thinNear;
	group.userData.thinFar = grassUniforms.thinFar;
	group.userData.batches = batches;
	group.userData.cull = cull;
	// the tufts' records, which the frame writes after the sun's maps and the wind update (main.ts)
	group.userData.update = ( renderer: THREE.Renderer ) => {

		still( renderer );
		wind( renderer );

	};
	group.userData.kinds = kinds.map( ( k ) => ( { geometry: k.geometry, key: k.key } ) );
	// the flowering tufts' anchors on the land shown, [ x, y, z ] each (the parity views find the
	// flowers by them: tools/parity/views.mjs)
	// the roots of the tufts at the cliff's edge (those with an edge record, `edgeTuftSteps`) on the
	// land shown, [ x, y, z, the share of its blades the tuft keeps ] each (the parity views face the
	// edge's densest stretch by them)
	group.userData.edgeRoots = () => {

		const origins = cull.buffer( 'origins' ).array as Float32Array, ground = cull.buffer( 'ground' ).array as Float32Array, edge = cull.buffer( 'edge' ).array as Float32Array;
		const roots: number[][] = [];
		for ( const range of cull.ranges ) for ( let i = range.start; i < range.start + range.count; i ++ ) {

			if ( edge[ i * 20 + 2 ] !== 0 || edge[ i * 20 + 3 ] !== 0 ) roots.push( [ ...origins.subarray( i * 4, i * 4 + 3 ), ground[ i * 12 + 11 ] ] );

		}
		return roots;

	};
	group.userData.flowerHeads = () => {

		const range = cull.ranges[ kinds.findIndex( ( k ) => k.key === 'lawnFlower' ) ], origins = cull.buffer( 'origins' ).array as Float32Array;
		return Array.from( { length: range.count }, ( _, i ) => Array.from( origins.subarray( ( range.start + i ) * 4, ( range.start + i ) * 4 + 3 ) ) );

	};
	return group;

}

/** A meadow grown on another land, ready for `setGrass`: the pool of its tufts in the meadow's
 * batches, the buffers made for it (to be uploaded before the swap), each batch's planting box
 * and count, and the sward's field over its ground (SwardField.ts, uploaded). */
export interface GrassPrepared { pool: CullPool; buffers: CullBuffers; boxes: THREE.Box3[]; counts: number[]; sward: THREE.DataTexture; crowns: THREE.DataTexture }

/** The pool of `tufts` for the meadow `group` (buildGrass), in steps (VegetationCull's `poolSteps`): the
 * growth (Growth.ts) takes them in idle time. */
function* grassSteps( group: THREE.Group, tufts: GrassTufts, per = 4000 ): Generator<void, Omit<GrassPrepared, 'sward' | 'crowns'>> {

	const kinds = group.userData.kinds as { geometry: THREE.BufferGeometry; key: TuftKind }[];
	const inputs: CullBatchInput<Tuft>[] = kinds.map( ( k ) => ( { records: tufts[ k.key ], geometry: k.geometry } ) );
	const pool = yield* poolSteps( GRASS_PAYLOAD, inputs, per );
	const boxes: THREE.Box3[] = [];
	for ( const b of inputs ) {

		const box = new THREE.Box3();
		for ( let k = 0; k < b.records.length; k ++ ) {

			box.expandByPoint( b.records[ k ].origin );
			if ( k % ( per * 4 ) === per * 4 - 1 ) yield;

		}
		boxes.push( box );
		yield;

	}
	return { pool, buffers: poolBuffers( GRASS_PAYLOAD, pool ), boxes, counts: inputs.map( ( b ) => b.records.length ) };

}

/** Swaps the meadow `group` to a prepared one in place: the same meshes, materials and kernels over
 * the new pool's buffers. Returns the buffers it replaced (dispose of them once drawn no more). */
function setGrass( group: THREE.Group, prepared: GrassPrepared ): CullBuffers {

	const cull = group.userData.cull as GrassCull, batches = group.userData.batches as Batch[];
	const old = cull.setPool( prepared.pool, prepared.buffers );
	batches.forEach( ( b, k ) => {

		b.box.copy( prepared.boxes[ k ] );
		b.count = prepared.counts[ k ];
		b.mesh.count = b.count;
		b.mesh.userData.bakeCount = b.count;
		b.mesh.geometry.userData.grassBase = b.range.start;
		( b.mesh as unknown as { instanceMatrix: THREE.BufferAttribute } ).instanceMatrix = cull.buffer( 'matrices' );
		( b.mesh as unknown as { instanceColor: THREE.BufferAttribute } ).instanceColor = cull.buffer( 'colors' );
		for ( const child of b.mesh.children ) if ( ( child as THREE.InstancedMesh ).isInstancedMesh ) ( child as unknown as { instanceMatrix: THREE.BufferAttribute } ).instanceMatrix = cull.buffer( 'matrices' );

	} );
	return old;

}

// The meadow as a vegetation kind (vegetation/Registry.ts): a grown island's meadow is planted a
// slice of anchors at a step and its cull pool filled and uploaded ahead; the swap points the
// pool's storage nodes at the new buffers (`setGrass`, no pipeline), and the old buffers leave the
// renderer's attributes once nothing draws them; the sward's field over its ground and its top
// (SwardField.ts) are baked from the new tufts and uploaded ahead too, and set on their base nodes
// in the swap. It
// stays out of the sun's caster box, as it always has.
export function grassKind( group: THREE.Group, renderer: THREE.WebGPURenderer ): VegetationKind<GrassPrepared> {

	return {
		name: 'grass', root: group, prepass: true, shadowFilter: 'vegetation', sunCaster: false, rainBake: true,
		growth: {
			*prepare( input ) {

				const veg = input.data.vegetation, anchors = veg.length / STRIDE;
				const tufts: GrassTufts = { lawn: [], lawnThin: [], lawnFlower: [], sward: [] };
				for ( let a = 0; a < anchors; a += 16 ) {

					const part = plantGrass( veg.subarray( a * STRIDE, Math.min( anchors, a + 16 ) * STRIDE ), input.data.rimGround, ( x, z ) => input.walkDistance( x, z ), input.data.shore, undefined, input.data.grove );
					tufts.lawn.push( ...part.lawn );
					tufts.lawnThin.push( ...part.lawnThin );
					tufts.lawnFlower.push( ...part.lawnFlower );
					tufts.sward.push( ...part.sward );
					yield;

				}
				yield* edgeTuftSteps( [ tufts.lawn, tufts.lawnThin, tufts.lawnFlower ], input.data.rimLip, 256 );
				const grass = yield* grassSteps( group, tufts, 256 );
				yield;
				for ( const buffer of Object.values( grass.buffers ) ) yield* uploadSteps( input.renderer, buffer, AttributeType.STORAGE );
				const crownData = yield* crownSteps( [ tufts.lawn, tufts.lawnThin, tufts.lawnFlower ] );
				const sward = yield* swardSteps( tufts.sward, SWARD_FALLBACK, crownData );
				yield* textureSteps( input.renderer, sward );
				const crowns = yield* canopySteps( crownData );
				yield* textureSteps( input.renderer, crowns );
				return { ...grass, sward, crowns };

			},
			swap( prepared ) {

				const old = setGrass( group, prepared ), oldSward = setSwardField( prepared.sward ), oldCrowns = setCanopyTop( prepared.crowns );
				// (the new pool's records of the islanders' trail are zeros until written: Trample.ts)
				if ( group.userData.trail ) renderer.compute( group.userData.trail );
				return () => {

					const attributes = ( renderer as unknown as { _attributes?: { delete( attribute: unknown ): void } } )._attributes;
					for ( const buffer of Object.values( old ) ) attributes?.delete( buffer );
					oldSward.dispose();
					oldCrowns.dispose();

				};

			},
		},
	};

}
