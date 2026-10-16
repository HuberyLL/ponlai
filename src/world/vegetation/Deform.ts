import type * as THREE from 'three/webgpu';
import { vec3, vec4, float, fract, mix, dot, max, normalize, length, smoothstep, inverseSqrt, cameraViewMatrix, cameraProjectionMatrix, screenSize } from 'three/tsl';
import { LEAN_REF, gustWave, leanLoad, pressedLean, pressedStiffening, pressing, swayJitter, swingOf, wave, windField, type WindState } from '../../weather/Wind.ts';
import { puddleCover } from '../../weather/Puddles.ts';

// How the vegetation moves: the plants' main bend (`mainBend`: today only the game's palm), the
// meadow's blades and flower heads (`bendBlade`, each on its own phase, `bladePhase`), a hanging
// strand's pendulum (`hangingSway`: the grass hanging from the rim's lip, which passes its own
// HangingWind) and standing water drowning a plant (`drown`: the meadow). Each kind's wind numbers (its amplitude, its swings per gust tile,
// `slow`) are the exported constants below, which its material and the wind probe
// (debug/WindProbe.ts) both read. The swings per gust tile set the kind's natural frequency,
// `swayFrequency( cycles )` Hz (Wind.ts), the same in every wind: a stronger wind leans a plant
// further and widens its swing (`pressure`, `breeze`), never quickens it. The rates are fair's
// before the sway and the wind were parted, so a fair day moves as it did. Far off the meadow's
// sway fades out by the tufts' size on screen (`swayFade`) while their lean in the gusts stays: in
// a still-camera clip of the island view the far meadow's flicker followed the sway (freezing the
// wind took it to nothing; no sway at all, the gusts' lean kept, halved it), its single-frame
// flashes mostly flower heads under a pixel crossing the multisamples as they swung, and the slow
// lean is what shows the wind sweeping the island from afar. Each function returns nodes; it
// builds the graph its kind built in place before, in the same order, so the shaders are unchanged
// (the fade multiplies the sway by exactly 1 where a tuft is large on screen).

const TAU = Math.PI * 2;

type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type F = THREE.Node<'float'>;

/** The game's palm: mainBend's 30 swings per gust tile (0.89 Hz) at half that rate (`slow`,
 * 0.45 Hz); its crown's bend comes with its vertices (PalmView.ts `palmSway`). */
export const PALM_WIND = { cycles: 30, slow: 1 } as const;
/** The meadow's blades and their flower heads: their sway's swings per gust tile (1.48 Hz) and
 * how far apart the blades swing (a share of a swing), the sway's and the shiver's lean (per metre of the
 * tuft's height, in a still breeze and added at a full gust: `base + gust * field.w`), and the
 * tuft's height on screen (render pixels) below which the sway and shiver fade out (`swayFade`):
 * whole from `full` up, gone at `none`. At 7 pixels a tuft's blades are well under a pixel wide
 * before widening; every tuft of the 22 m close view stands taller than that (its frame is
 * unchanged to the byte, while a full fade at 9 already moved its far edge), and at the island
 * view the far meadow's sway is gone, which cut its single-frame flashes by two thirds (a later
 * window, 6.5 to 8.5, cut them only a few per cent more). */
export const GRASS_WIND = { cycles: 50, spread: 0.8, swing: { base: 0.009, gust: 0.02 }, shiver: { base: 0.003, gust: 0.006 }, fade: { none: 4, full: 7 },
	pressed: { length: 0.28, stiffness: 1, underside: 1, always: true } } as const;
// `pressed`: the meadow under a wind above fair's (`bendBlade`): the tuft height (m) at which the
// wind's load is the lean the gust field gives (the lawn's, Meadow.ts SWARD_HEIGHT), the blades'
// flexural rigidity in that unit, and how much lighter the blades' pale side shows where they lie
// over (1: twice as light lying flat). At rigidity 1 the lawn's short blades leaned 16 degrees
// between a strong wind's gusts and 43 at their cores: from the island view the wind still did not
// show. At 0.4 they lean 34 and 64 (16 and 47 in a fresh wind), and the meadow reads combed
// downwind. Blades 2.5 times as long (tried in place of the lawn's) lie nearly flat at 0.4 in any
// wind above fair's, so their gusts no longer press deeper; at 1 they lean 56 degrees between a
// fresh wind's gusts and 72 in a strong one's, the gusts pressing them to 77 and 82. The meadow's
// blades are long now (0.2 - 0.75 m by the soil, arcing under their weight: Grass.ts), and each
// bends by its own length (`bendBlade`'s `height`), so they take rigidity 1; `always` presses them in every wind, fair's
// included (Wind.ts `pressing` would keep the eased lean up to fair's pressure): the load then
// follows the blade's length at a fair wind too, so a long blade shows it there and the short
// exposed turf barely moves. Each tussock adds its own rigidity (`bendBlade`'s `rigidity`), so a
// gust presses neighbouring tussocks apart rather than combing the sward in one direction.
/** The grass hanging from the rim's lip (RimGrass.ts) swings as a hanging strand (`hangingSway`'s
 * numbers): a blade's weight is its length times the square of the way down it, so a metre-long
 * blade's tip sways about 3 cm in a fair gust, at 0.71 Hz (0.48 Hz across), and lies on the wall
 * rather than pressing into it. */
export const RIM_GRASS_WIND = { amplitude: 0.018, cycles: 24, across: 16, press: 0.02, leafEdge: 0, lift: 0.08 } as const;

/** A plant's main bend, after Sousa's "Vegetation Procedural Animation and Shading in Crysis"
 * (GPU Gems 3, ch. 16): the whole plant leans with the gust field at its root and sways a little
 * about that lean, each vertex by `amplitude` (metres at a fair day's typical gust, see LEAN_REF;
 * it carries the plant's stiffness and grows from the root up), keeping its distance from the root
 * so the plant arcs over instead of shearing. The sway travels downwind (Wind.ts `gustWave`):
 * neighbours swing together, each plant only a little
 * apart (`swayJitter`), about a sixth of the lean (`swingOf`), a third of that across the wind.
 * `cycles` is the sway's rate in whole swings per gust tile (an even number: 0.89 Hz at 30), and
 * `slow` (0..1) eases it to half that rate for taller plants (the game's palm). `wind` is the frame's wind state (`shared.wind`, or `.previous`). Returns the bent
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
 * and shiver across it on their own phase, a quarter of that sway. `fade` (0..1, `swayFade`)
 * scales the sway and shiver but not the lean; the frame's bend and the previous frame's take the
 * same one. `wind` is the frame's wind state (`shared.wind`, or `.previous`). `rigidity` (the
 * blade's tussock's, 1 when not given) divides the wind's load.
 * Above fair's wind (Wind.ts `pressing`, 0 up to fair's pressure, so a fair day's blades bend to
 * the bit as before) the blade takes the elastica's shape under the wind's pressure (Wind.ts
 * `pressedLean`), its load the linear lean and sway scaled by the cube of the tuft's height over
 * GRASS_WIND.pressed.length and by its rigidity (the load number q L^3 / EI): a blade twice as
 * long takes eight times the load, so long blades lie over in a strong wind while short ones only
 * lean. The sway rides in the load, so a pressed blade answers it by the elastica's slope and its
 * shiver by its secant: held down, it trembles about a deep lean at the same rate, as grass under
 * a sustained wind does. A blade lying over shows its paler, glossier side (the underside of a
 * grass leaf, which gusts turn up as light bands sweeping a field): `pale` lifts the blade's
 * colour by `underside` times the share its chord has turned from upright, 1 - cos, so the bands
 * follow the gusts' deeper lean. Returns the bent position, the lean as a world-space vector (its
 * x, z are the blade's sway for the wind view and probe, src/debug/WindView.ts), `tilt`, the lean
 * the normals turn by, and `pale`, the colour's factor (exactly 1 up to fair's wind). The normals
 * keep the eased lean in every wind: turned by the pressed one, the blades' soft upward normals
 * fell away from a high sun and a strong wind's gusts swept the meadow as dark bands, where a
 * field's pressed grass shows light ones. The islanders' trail through the
 * grass (a later field) would join the lean here, so the blade arcs over and sinks as under the
 * wind. */
export function bendBlade( wind: WindState, rooted: V3, origin: V3, height: F, t2: F, phase: F, fade?: F, rigidity?: F ): { position: V3; lean: V3; tilt: V3; pale: F } {

	const field = windField( wind, origin.xz ).toVar();
	const along = vec3( field.x, 0, field.y ), across = vec3( field.y.negate(), 0, field.x );
	const { cycles, spread, swing: sw, shiver: sh } = GRASS_WIND;
	const faded = ( n: F ) => fade ? n.mul( fade ) : n;
	const swing = gustWave( wind, origin.xz, cycles, phase.div( TAU ).sub( 0.5 ).mul( spread ) ).mul( faded( wind.breeze.mul( field.w.mul( sw.gust ).add( sw.base ) ) ) );
	const flutter = wave( wind.clock, 1.7, phase ).mul( 0.65 ).add( wave( wind.clock, 2.9, phase.mul( 2.3 ) ).mul( 0.35 ) );
	const shiver = faded( wind.breeze.mul( field.w.mul( sh.gust ).add( sh.base ) ) ).mul( flutter );
	const eased = along.mul( field.z.add( swing ) ).add( across.mul( shiver ) ).toVar();
	// the elastica's lean under the tuft's own load (above), and how far the wind has gone over to it
	const { length: reference, stiffness, underside, always } = GRASS_WIND.pressed;
	const cube = height.mul( height ).mul( height ).mul( 1 / ( reference ** 3 * stiffness ) );
	const scale = rigidity ? cube.div( rigidity ) : cube;
	const load = leanLoad( wind, field.w ).add( swing ).mul( scale ).toVar();
	const pressed = pressedLean( load );
	const press = always ? float( 1 ) : pressing( wind );
	const held = along.mul( pressed ).add( across.mul( shiver.mul( scale ).mul( pressedStiffening( load ) ) ) );
	const lean = eased.add( held.sub( eased ).mul( press ) ).toVar();
	const pale = float( 1 ).add( float( 1 ).sub( inverseSqrt( pressed.mul( pressed ).mul( t2 ).add( 1 ) ) ).mul( press.mul( underside ) ) );
	const rel = rooted.sub( origin ).toVar();
	const reach = length( rel );
	const bent = normalize( rel.add( lean.mul( height.mul( t2 ) ) ).add( vec3( 0, 1e-5, 0 ) ) ).mul( reach ).add( origin );
	return { position: bent, lean, tilt: eased, pale };

}

/** The share of its sway (`bendBlade`'s `fade`) a meadow tuft rooted at `root` keeps by its
 * `height` (m) on screen in render pixels, height * P[1][1] * screen height / ( 2 * view depth ):
 * all of it from GRASS_WIND.fade.full pixels up, none below GRASS_WIND.fade.none. Pixels rather
 * than metres, so the dynamic scale and the zoom's fov keep the rule; the projection's ( 1, 1 ) is
 * the same jittered or not (the temporal jitter shifts only the clip offsets), so the scene's
 * projection gives the unjittered size. */
export function swayFade( root: V3, height: F ): F {

	const depth = max( cameraViewMatrix.mul( vec4( root, 1 ) ).z.negate(), 1e-3 );
	const p11 = ( cameraProjectionMatrix as unknown as { element( i: number ): { element( i: number ): F } } ).element( 1 ).element( 1 );
	return smoothstep( GRASS_WIND.fade.none, GRASS_WIND.fade.full, height.mul( p11 ).mul( screenSize.y ).div( depth.mul( 2 ) ) );

}

/** A blade's own phase (0..2 pi) from its id within its tuft and a hash of its tuft's root
 * (Wind.ts `rootHash`). */
export function bladePhase( id: F, root: F ): F {

	return fract( id.mul( 17.31 ).add( root.mul( 5.13 ) ) ).mul( TAU );

}

/** What a hanging strand's vertex brings to its pendulum: its place, its sway weight (0 at the
 * stone, 1 at the tip), its strand's phase, the wall's outward normal where it hangs, its normal,
 * how far it lies toward a leaf's edge (0 on stems) and its leaf's phase. */
export interface HangingInputs { position: V3; weight: F; phase: F; out: V3; normal: V3; leafEdge: F; leafPhase: F }

/** A hanging kind's wind numbers: the sway at its tips (m at LEAN_REF), the pendulum's swings per
 * gust tile along and across the wind, how far the wall may press it back (m), its leaves'
 * flutter at the tip (m) and how far a pressing wind lifts its tip off the stone (m per unit of
 * lean, above fair's wind). The removed leaf trails took { 0.012, 14, 10, 0.03, 0.004 }: about 2 cm
 * of sway in a fair gust, 0.42 Hz, nodes 0.11 m off the stone. */
export interface HangingWind { amplitude: number; cycles: number; across: number; press: number; leafEdge: number; lift: number }

/** A hanging strand leans with the gust field and swings like a pendulum (`numbers`) with the
 * plants about it (Wind.ts `gustWave`), its own phase a little apart, its forks with it; its leaves
 * flutter along their normals from stalk to tip on their own phase. The wall bounds it: wind into
 * the cliff presses the strand back by at most `numbers.press`, and a gust lifts it off the stone a
 * little, and a wind above fair's, whose lean grows as the elastica's (Wind.ts `pressedLean`), lifts it
 * further, `numbers.lift` per unit of lean: in a strong wind the curtain blows out downwind. Returns
 * the swayed position and the sway (as mainBend's). */
export function hangingSway( wind: WindState, v: HangingInputs, numbers: HangingWind ): { position: V3; sway: V2 } {

	const field = windField( wind, v.position.xz ).toVar();
	const along = vec3( field.x, 0, field.y ), across = vec3( field.y.negate(), 0, field.x );
	const lively = wind.breeze.mul( field.w.mul( 0.6 ).add( 0.3 ) );
	const own = fract( v.phase.div( TAU ) ).sub( 0.5 ).mul( 0.8 );
	const swing = swingOf( wind, field.w ).mul( 1.5 );
	const unit = along.mul( field.z.div( LEAN_REF ).add( gustWave( wind, v.position.xz, numbers.cycles, own ).mul( swing ) ) )
		.add( across.mul( gustWave( wind, v.position.xz, numbers.across, own.mul( 1.6 ).add( 1.3 ) ).mul( swing ).mul( 0.35 ) ) );
	const sway = unit.xz.mul( LEAN_REF );
	const free = unit.mul( v.weight.mul( numbers.amplitude ) ).toVar();
	// above fair's wind the lean grows as the elastica's (Wind.ts `pressing`) and the wind's drag
	// lifts the strand off the stone in proportion to it (0 at fair; added last, after the sum the
	// shader formed before, so a fair day's strands stay to the bit)
	const lift = pressing( wind ).mul( field.z ).mul( v.weight ).mul( numbers.lift );
	const offset = free.add( v.out.mul( max( float( - numbers.press ).sub( dot( free, v.out ) ), 0 ).add( field.w.mul( wind.breeze ).mul( v.weight ).mul( 0.01 ) ).add( lift ) ) );
	const flutter = wave( wind.clock, 3.7, v.leafPhase );
	return { position: v.position.add( offset ).add( v.normal.mul( flutter.mul( v.leafEdge ).mul( lively ).mul( numbers.leafEdge ) ) ), sway };

}

/** Standing water drowns a whole plant rooted at `root` (x, z): it sinks by `depth` (m) as the
 * puddle there covers it (Puddles.ts `puddleCover`, or `pool` when the plant has read it already),
 * under the ground, which carries the water. */
export function drown( position: V3, root: V2, depth: F, wetness: F, pool: F = puddleCover( root, wetness ) ): V3 {

	return position.sub( vec3( 0, pool.mul( depth ), 0 ) );

}
