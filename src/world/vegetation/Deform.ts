import type * as THREE from 'three/webgpu';
import { vec3, float, fract, mix, dot, max, normalize, length } from 'three/tsl';
import { LEAN_REF, gustWave, swayJitter, swingOf, wave, windField, type WindState } from '../../weather/Wind.ts';
import { puddleCover } from '../../weather/Puddles.ts';

// How the vegetation moves: the plants' main bend (`mainBend`: the rim bushes, the flowers, the
// plateau's plants, the game's palm), the meadow's blades (`bendBlade`, each on its own phase,
// `bladePhase`), the rim trails' pendulum (`hangingSway`), the turf skirt's lean (`skirtLean`) and
// standing water drowning a plant (`drown`: the flowers, the meadow). Each kind's wind numbers (its
// amplitude, its swings per gust tile, `slow`) are the exported constants below, which its material
// and the wind probe (debug/WindProbe.ts) both read. Each function returns nodes; it builds the
// graph its kind built in place before, in the same order, so the shaders are unchanged.

const TAU = Math.PI * 2;

type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type F = THREE.Node<'float'>;

/** The rim bushes: the crown's bend (m at LEAN_REF, times the square of the height over the crown's)
 * and its sway's swings per gust tile (about 0.9 Hz in a fair wind). */
export const BUSH_WIND = { amplitude: 0.022, cycles: 30 } as const;
/** The flowers: the head's bend per metre of the plant's height (m at LEAN_REF, times the square of
 * the lift), nodding at 40 swings per gust tile (about 1.2 Hz). */
export const FLOWER_WIND = { amplitude: LEAN_REF, cycles: 40 } as const;
/** The plateau's plants: 30 swings per gust tile, trees at half that rate (`slow` from 1.4 to 2.6 m
 * tall); each plant's amplitudes come with its vertices (Plants.ts `plantWind`). */
export const PLANT_WIND = { cycles: 30, slow: [ 1.4, 2.6 ] } as const;
/** The game's palm: a shrub's 30 swings per gust tile at half that rate (`slow`); its crown's bend
 * comes with its vertices (PalmView.ts `palmSway`). */
export const PALM_WIND = { cycles: 30, slow: 1 } as const;
/** The meadow's blades: their sway's swings per gust tile (about 1.5 Hz in a fair wind) and how far
 * apart the blades swing (a share of a swing), the sway's and the shiver's lean (per metre of the
 * tuft's height, in a still breeze and added at a full gust: `base + gust * field.w`). */
export const GRASS_WIND = { cycles: 50, spread: 0.8, swing: { base: 0.009, gust: 0.02 }, shiver: { base: 0.003, gust: 0.006 } } as const;
/** The rim's trails: the sway at their tips (m at LEAN_REF: about 2 cm in a fair gust, 8 - 10 cm in
 * a gale's), the pendulum's swings per gust tile along and across the wind (about 0.4 Hz), how far
 * the wall may press them back (their nodes hang 0.11 m off the stone, their leaves a little
 * further) and their leaves' flutter at the tip (m). */
export const RIM_WIND = { amplitude: 0.012, cycles: 14, across: 10, press: 0.03, leafEdge: 0.004 } as const;
/** The turf skirt's thatch: its lean at the blade tips (m at LEAN_REF) and its shiver's swings per
 * gust tile (about 1.9 Hz in a fair wind). */
export const SKIRT_WIND = { amplitude: 0.012, cycles: 64 } as const;

/** A plant's main bend, after Sousa's "Vegetation Procedural Animation and Shading in Crysis"
 * (GPU Gems 3, ch. 16): the whole plant leans with the gust field at its root and sways a little
 * about that lean, each vertex by `amplitude` (metres at a fair day's typical gust, see LEAN_REF;
 * it carries the plant's stiffness and grows from the root up), keeping its distance from the root
 * so the plant arcs over instead of shearing. The sway travels with the gusts (Wind.ts `gustWave`):
 * neighbours swing together, each plant only a little
 * apart (`swayJitter`), about a sixth of the lean (`swingOf`), a third of that across the wind.
 * `cycles` is the sway's rate in whole swings per gust tile (an even number: about 0.9 Hz at 30
 * in a fair wind), and `slow` (0..1) eases it to half that rate for taller plants (the small
 * trees, Plants.ts; the game's palm). `wind` is the frame's wind state (`shared.wind`, or `.previous`). Returns the bent
 * position, the wind field's ( direction x, direction z, lean, gust ) at the root and the plant's
 * sway: its horizontal offset over `amplitude` times LEAN_REF, the lean and swing as a tip offset
 * over height (world x, z; for the wind view and probe, src/debug/WindView.ts; a shader that does
 * not read it compiles as before). */
export function mainBend( wind: WindState, position: V3, root: V3, amplitude: F, cycles: number, slow?: F ): { position: V3; field: THREE.Node<'vec4'>; sway: V2 } {

	if ( cycles % 2 !== 0 ) throw new RangeError( `mainBend: ${ cycles } swings per gust tile is not even` );
	const field = windField( wind, root.xz ).toVar();
	const own = swayJitter( root.xz );
	// The sway grows with the wind and in a gust; the lean follows the gust field.
	const swing = swingOf( wind, field.w ).mul( own.gain );
	const sway = ( c: number, ph: F ) => slow ? mix( gustWave( wind, root.xz, c, ph ), gustWave( wind, root.xz, c / 2, ph ), slow ) : gustWave( wind, root.xz, c, ph );
	const response = field.z.div( LEAN_REF ).add( sway( cycles, own.phase ).mul( swing ) );
	const sideways = sway( 2 * Math.round( cycles * 0.4 ), own.phase.mul( 1.7 ).add( 1.3 ) ).mul( swing ).mul( 0.35 );
	const unit = vec3( field.x, 0, field.y ).mul( response ).add( vec3( field.y.negate(), 0, field.x ).mul( sideways ) );
	const offset = unit.mul( amplitude );
	const rel = position.sub( root ).toVar();
	return { position: normalize( rel.add( offset ).add( vec3( 0, 1e-5, 0 ) ) ).mul( length( rel ) ).add( root ), field, sway: unit.xz.mul( LEAN_REF ) };

}

/** The meadow's response to `windField`:
 * each tuft leans with the gust field at its root, its blades bending along their length (the
 * offset grows with the square of the blade parameter, `t2`) while every vertex keeps its distance
 * from the root, so a bent blade arcs over and sinks rather than stretching. About that lean the
 * blades sway along the wind with their neighbours (Wind.ts `gustWave`, GRASS_WIND.cycles swings
 * per gust tile), each a little apart (`phase`, the blade's own, `bladePhase`, within +-0.4 rad),
 * and shiver across it on their own phase, a quarter of that sway. `wind` is the frame's wind
 * state (`shared.wind`, or `.previous`). Returns the bent position and the lean as a world-space
 * vector, for the normals (its x, z are the blade's sway for the wind view and probe,
 * src/debug/WindView.ts). The islanders' trail through the grass (a later field) would join the
 * lean here, so the blade arcs over and sinks as under the wind. */
export function bendBlade( wind: WindState, rooted: V3, origin: V3, height: F, t2: F, phase: F ): { position: V3; lean: V3 } {

	const field = windField( wind, origin.xz ).toVar();
	const along = vec3( field.x, 0, field.y ), across = vec3( field.y.negate(), 0, field.x );
	const { cycles, spread, swing: sw, shiver: sh } = GRASS_WIND;
	const swing = gustWave( wind, origin.xz, cycles, phase.div( TAU ).sub( 0.5 ).mul( spread ) ).mul( wind.breeze.mul( field.w.mul( sw.gust ).add( sw.base ) ) );
	const flutter = wave( wind.flutter, 1.7, phase ).mul( 0.65 ).add( wave( wind.flutter, 2.9, phase.mul( 2.3 ) ).mul( 0.35 ) );
	const shiver = wind.breeze.mul( field.w.mul( sh.gust ).add( sh.base ) ).mul( flutter );
	const lean = along.mul( field.z.add( swing ) ).add( across.mul( shiver ) ).toVar();
	const rel = rooted.sub( origin ).toVar();
	const reach = length( rel );
	const bent = normalize( rel.add( lean.mul( height.mul( t2 ) ) ).add( vec3( 0, 1e-5, 0 ) ) ).mul( reach ).add( origin );
	return { position: bent, lean };

}

/** A blade's own phase (0..2 pi) from its id within its tuft and a hash of its tuft's root
 * (Wind.ts `rootHash`). */
export function bladePhase( id: F, root: F ): F {

	return fract( id.mul( 17.31 ).add( root.mul( 5.13 ) ) ).mul( TAU );

}

/** What a hanging strand's vertex brings to its pendulum (RimFoliage.ts): its place, its sway
 * weight (0 at the stone, 1 at the tip), its strand's phase, the wall's outward normal where it
 * hangs, its normal, how far it lies toward a leaf's edge (0 on stems) and its leaf's phase. */
export interface HangingInputs { position: V3; weight: F; phase: F; out: V3; normal: V3; leafEdge: F; leafPhase: F }

/** A hanging strand leans with the gust field and swings like a pendulum (RIM_WIND) with the plants
 * about it (Wind.ts `gustWave`), its own phase a little apart, its forks with it; its leaves flutter
 * along their normals from stalk to tip on their own phase. The wall bounds it: wind into the cliff
 * presses the strand back by at most RIM_WIND.press, and a gust lifts it off the stone a little.
 * Returns the swayed position and the sway (as mainBend's). */
export function hangingSway( wind: WindState, v: HangingInputs ): { position: V3; sway: V2 } {

	const field = windField( wind, v.position.xz ).toVar();
	const along = vec3( field.x, 0, field.y ), across = vec3( field.y.negate(), 0, field.x );
	const lively = wind.breeze.mul( field.w.mul( 0.6 ).add( 0.3 ) );
	const own = fract( v.phase.div( TAU ) ).sub( 0.5 ).mul( 0.8 );
	const swing = swingOf( wind, field.w ).mul( 1.5 );
	const unit = along.mul( field.z.div( LEAN_REF ).add( gustWave( wind, v.position.xz, RIM_WIND.cycles, own ).mul( swing ) ) )
		.add( across.mul( gustWave( wind, v.position.xz, RIM_WIND.across, own.mul( 1.6 ).add( 1.3 ) ).mul( swing ).mul( 0.35 ) ) );
	const sway = unit.xz.mul( LEAN_REF );
	const free = unit.mul( v.weight.mul( RIM_WIND.amplitude ) ).toVar();
	const offset = free.add( v.out.mul( max( float( - RIM_WIND.press ).sub( dot( free, v.out ) ), 0 ).add( field.w.mul( wind.breeze ).mul( v.weight ).mul( 0.01 ) ) ) );
	const flutter = wave( wind.flutter, 3.7, v.leafPhase );
	return { position: v.position.add( offset ).add( v.normal.mul( flutter.mul( v.leafEdge ).mul( lively ).mul( RIM_WIND.leafEdge ) ) ), sway };

}

/** The turf skirt's thatch leans with the meadow's gust field and shivers with it (Wind.ts
 * `gustWave`, SKIRT_WIND), a sixth of its lean, each vertex by its `weight` (0 on the sod). Returns
 * the leaning position and the sway (as mainBend's). */
export function skirtLean( wind: WindState, position: V3, weight: F ): { position: V3; sway: V2 } {

	const field = windField( wind, position.xz );
	const shiver = gustWave( wind, position.xz, SKIRT_WIND.cycles ).mul( swingOf( wind, field.w ) );
	const sway = field.xy.mul( field.z.div( LEAN_REF ).add( shiver ) ).mul( LEAN_REF );
	return { position: position.add( vec3( field.x, 0.25, field.y ).mul( field.z.div( LEAN_REF ).add( shiver ) ).mul( weight ).mul( SKIRT_WIND.amplitude ) ), sway };

}

/** Standing water drowns a whole plant rooted at `root` (x, z): it sinks by `depth` (m) as the
 * puddle there covers it (Puddles.ts `puddleCover`, or `pool` when the plant has read it already),
 * under the ground, which carries the water. */
export function drown( position: V3, root: V2, depth: F, wetness: F, pool: F = puddleCover( root, wetness ) ): V3 {

	return position.sub( vec3( 0, pool.mul( depth ), 0 ) );

}
