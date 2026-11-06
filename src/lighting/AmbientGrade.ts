import * as THREE from 'three/webgpu';
import { negateOnBackSide, normalView, normalViewGeometry, positionViewDirection, roughness, uniform, vec3 } from 'three/tsl';
import { floorOcclusion, screenAOAt } from '../post/GTAO.ts';
import { ambientEnvironment, ambientVolumeOn, specularOcclusion, type AmbientReceiver } from './AmbientSample.ts';
import { meterAmbient } from './MeterLight.ts';
import { tune } from '../debug/Tune.ts';
import { overcastDeckLight } from '../sky/Weather.ts';

// The ambient grade: one table of knobs on the island's ambient light, per sun elevation and per
// weather, so the art direction can depart from the physically lit result by the hour and the sky
// (a style grade on a physically based base, the approach Patry describes: lighting
// knobs, among them the ambient diffuse and specular balance and the sky's brightness, adjusted
// globally at the granularity of the weather and time-of-day states; "Real-Time Samurai Cinema",
// SIGGRAPH 2021, p. 10, and "Samurai Shading in Ghost of Tsushima", SIGGRAPH 2020, p. 9). The
// table multiplies on top of the sky's own grading (main.ts `skyFill`, Sky.ts ISLAND_SKY), which
// it leaves as it is.
//
// Every cell starts from the same values (`D`): identity but for the volume's directionality,
// 0.25 at every hour and in every weather, so that a surface in shade turned toward the open sky
// keeps a little more of it than one turned toward the grove or the cliff (a small change: a culm's
// two sides in a grove's shade move by a few per cent apart). The value is Patry's ("Real-Time
// Samurai Cinema", p. 43: a 25 % boost toward the direction of the harmonics' linear maximum, used
// throughout the game), kept after an A/B in our scenes. The other knobs are set by the hour and
// the sky as the scene's light is tuned, so that they grade style rather than stand in for
// light the scene does not yet carry.
//
// Set so far: the sun's bounce. The sky's diffuse light takes no knob: the volume's sky term and
// the sky it bounces follow the sky itself at gain 1 (AmbientRelight.ts) at every hour and in every
// weather, so the evening and the night take the light their own sky gives, and the metering
// illuminance takes the sky's light as it stands (it is the incident light: Pipeline.ts
// `meterLight`). The sky's reflection takes half from a sun at 5.5 degrees to one at -1.3
// (`skySpecular`), under clear and fair skies alike, so a low sun's shade stands dark against the
// lit rock and does not rise back through the sunset; the night's row returns it by -2.6 degrees.
// A clear evening keeps the day's exposure to -7 degrees (DayCycle.ts `displayNight`), but its
// reflection there is of a warm or a deep sky: on the island view the rock's mean C is 0.022 to
// 0.028 from -7 to -10 degrees, under a clear morning's 0.035 to 0.042 at -8 and -9 with the
// reflection held at 0.1. A clear morning takes the day's exposure long before the sun
// (DayCycle.ts `displayNight`, post/Exposure.ts `dawn`), and under it the night's full reflection
// of a bright, saturated sky lit the rock's ledges and the leaves cyan (at -8 degrees the cliff's
// brightest tenth L 0.33, C 0.11 with it, 0.19, 0.03 without), so the rising sun's rows
// (AMBIENT_GRADE_RISING) hold the clear and the fair sky's reflection at 0.1 from -2.6 down to
// -12, where the display's night is whole again (DayCycle.ts `displayNight`), and give it back to
// the night's by -13. A return from -7 still lit the rock's edges from -9 to -7 degrees (on the
// island view their brightest tenth C 0.083 to 0.085 at -9 and -8, 0.066 or less held). What blue
// they keep (C about a fifth of their L at -6.5 degrees, whether the reflection is 0.1 or none) is
// the dawn's display white over a grey surface (post/Pipeline.ts WHITE_BALANCE), not this light.
//
// The sun's bounce is 1 under the clear and the fair sky from the high sun to its last light at
// -1.3 degrees, set with the probes' sky gain (AmbientRelight.ts PROBE_SKY) by the lit ground's
// share of the key's direct light and the shade's depth under it (there); the moon's is 3.2 from
// -2.6 degrees down, where its key comes in. Under the cloudy sky every row takes about half of
// clear's (8 / 15 to the sun's last light, 1.7 by night); under overcast the day's rows take a
// third (0.33 from 2 degrees down) and the night's half, as under cloudy. The volume bounces the
// key as an even lobe over the whole bounced visibility, weighed by level ground's cosine of the
// key (AmbientRelight.ts), so it falls with the sun as the light on the ground does and reaches a
// face as far as bounced light reaches it from any side: it lights what faces lit ground or a lit
// crown (a blade's underside, a culm's sides, the leaves, the islanders). Read at degree 2, the
// island's receivers' read, under the clear sky the bounces (the sky's and the key's) make 16 % of
// open level ground's light in shade at 62 degrees (the noon of the sun's earlier, higher path),
// 13 % at 50, 9 % at 30, 6 % at 20, 4.5 % at 13 and 10 and 3 % at 4. With the day's bounce at 4.5, at 20 degrees bare ground in a grove's shadow
// at its edge took 13 to 22 % of its shade from the key's bounce and a grove's floor 2 to 4 m in 33
// to 37 % (reading 0.61 to 0.63 of the edge's shade); a culm at the edge read on its side toward
// the open 0.85 to 1.2 times the open shade beside it (the volume does not know the sun's shadow:
// AmbientRelight.ts), a culm's two sides in the grove's shade read 1.25 to 1.4 apart at its heart
// and about 1.65 at its edge, and a culm's side in the grove 1.1 to 1.35 times its floor; the
// meadow's blades in the umbra (their ambient then read from both faces at 0.75: world/Grass.ts)
// read about 1.8 times bare ground in the same shade at 50 degrees and 1.2 to 1.3 at 20. It also
// scales the sea's bounce onto the cliffs (GroundBounce.ts) and the islanders' bounce.
//
// Overcast is a dark grey sky with the sun still shining (Weather.ts): its sun's bounce takes a
// third of clear's, times the weather's gain on all of the land's ambient light under its deck
// (OVERCAST_LAND, which its sky light takes too: AmbientRelight.ts).
// Under a cloud's shadow the open ground beside a grove reads 1.2 to 1.8 times its shade inside the
// grove's shadow; under overcast a grove's floor reads about 0.6 to 0.7 of the open ground.
//
// The table: rows by the sun's elevation (degrees, descending), interpolated linearly, the end rows
// held beyond them (ISLAND_SKY's form), from the high sun down to the night; columns the kept
// weathers (clear, fair, cloudy, overcast), weighted by the weather's own blend of them
// (Weather.ts `skyMix`: a front moves the weights as it moves the sky; a parked weather counts as
// overcast). Evaluated on the CPU once a frame from the scene clock's sun and the weather (`update`)
// into the uniforms below, so it is a function of the clock and the weather alone, and a change of
// hour or weather writes uniforms only, never building a pipeline.
//
// The knobs and what reads them:
//   skySpecular     the environment's specular light (with three's multiple-scattering share of
//                   the ambient), and the islanders' sky rim.
//   skyBounce       the ambient volume's bounced sky on top of the sky's light (AmbientRelight.ts): a
//                   style knob, 1 in every row.
//   sunBounce       the sunlight the ground bounces up (GroundBounce.ts `groundBounceLight`, where
//                   every material takes it: by default its sea alone, the volume carrying the
//                   land's), and the ambient volume's bounce of the key (AmbientRelight.ts).
//   directionality  the ambient volume's directionality boost (AmbientRelight.ts; 0 none).
//   aoStrength      how much of the ambient occlusion applies, mix( 1, ao, k ): the physical models'
//                   occlusion (`aoNode`: the terrain's vertex AO, the bamboo's canopy over the
//                   ground and the meadow, `groveSky`, where the volume does not carry it, the
//                   plants' own), times the screen-space
//                   occlusion on the materials that take it (post/GTAO.ts `receiveScreenAO`; the
//                   island's ground takes it in its own `aoNode`), the product held at
//                   post/GTAO.ts AO_FLOOR where the two multiply, and the islanders' baked
//                   occlusion in their fill. The local lights take the same occlusion
//                   (`diffuseOcclusion`, lighting/LocalLights.ts).
// The water, the sky, the clouds, the haze and the rain are not the island's ambient and do not
// read it.
//
// The GUI's Ambient folder shows the values and, with `override`, replaces the table's output with
// its sliders for live tuning; debug builds expose the controller as `__PONLAI__.ambient` and its
// values in the diagnostics.

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

export interface AmbientKnobs {
	skySpecular: number;
	skyBounce: number;
	sunBounce: number;
	directionality: number;
	aoStrength: number;
}
export const AMBIENT_KNOBS: ReadonlyArray<keyof AmbientKnobs> = [ 'skySpecular', 'skyBounce', 'sunBounce', 'directionality', 'aoStrength' ];

/** The table's columns, the kept weathers (Weather.ts KEPT_SKIES' order). */
export const AMBIENT_COLUMNS = [ 'clear', 'fair', 'cloudy', 'overcast' ] as const;
type Column = typeof AMBIENT_COLUMNS[ number ];
type AmbientRow = { at: number } & Record<Column, Readonly<AmbientKnobs>>;

const D: Readonly<AmbientKnobs> = { skySpecular: 1, skyBounce: 1, sunBounce: 1, directionality: 0.25, aoStrength: 1 };

// The key's bounce by day under the clouded skies, in clear's unit (`D`, 1): the cloudy sky's about
// half (8 / 15), overcast's a third (the header). Overcast's keeps 0.33 from 2 degrees down.
const CLOUDY_BOUNCE = 8 / 15, OVERCAST_BOUNCE = 1 / 3;

// the high sun, the afternoon, the low sun (13 to 7 degrees), the sky's reflection letting go (5.5
// to 4 degrees), golden hour,
// where the sky's gain starts toward the night key (2 degrees), sunset, the afterglow (-1.3 and -2.6 degrees), the
// blue hour, the night
export const AMBIENT_GRADE: readonly AmbientRow[] = [
	{ at: 60, clear: { ...D }, fair: { ...D }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: OVERCAST_BOUNCE } },
	{ at: 30, clear: { ...D }, fair: { ...D }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: OVERCAST_BOUNCE } },
	{ at: 20, clear: { ...D }, fair: { ...D }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: OVERCAST_BOUNCE } },
	{ at: 13, clear: { ...D }, fair: { ...D }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: OVERCAST_BOUNCE } },
	{ at: 10, clear: { ...D }, fair: { ...D }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: OVERCAST_BOUNCE } },
	{ at: 9, clear: { ...D }, fair: { ...D }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: OVERCAST_BOUNCE } },
	{ at: 7, clear: { ...D }, fair: { ...D }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: OVERCAST_BOUNCE } },
	{ at: 5.5, clear: { ...D, skySpecular: 0.5 }, fair: { ...D, skySpecular: 0.5 }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: OVERCAST_BOUNCE } },
	{ at: 4, clear: { ...D, skySpecular: 0.5 }, fair: { ...D, skySpecular: 0.5 }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: OVERCAST_BOUNCE } },
	{ at: 2, clear: { ...D, skySpecular: 0.5 }, fair: { ...D, skySpecular: 0.5 }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: 0.33 } },
	{ at: 0, clear: { ...D, skySpecular: 0.5 }, fair: { ...D, skySpecular: 0.5 }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: 0.33 } },
	{ at: - 1.3, clear: { ...D, skySpecular: 0.5 }, fair: { ...D, skySpecular: 0.5 }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: 0.33 } },
	{ at: - 2.6, clear: { ...D, sunBounce: 3.2 }, fair: { ...D, sunBounce: 3.2 }, cloudy: { ...D, sunBounce: 1.7 }, overcast: { ...D, sunBounce: 1.7 } },
	{ at: - 4, clear: { ...D, sunBounce: 3.2 }, fair: { ...D, sunBounce: 3.2 }, cloudy: { ...D, sunBounce: 1.7 }, overcast: { ...D, sunBounce: 1.7 } },
	{ at: - 18, clear: { ...D, sunBounce: 3.2 }, fair: { ...D, sunBounce: 3.2 }, cloudy: { ...D, sunBounce: 1.7 }, overcast: { ...D, sunBounce: 1.7 } },
];

// The rising sun's (the header): the clear and the fair sky's reflection at 0.1 from -2.6 to -12
// degrees, the night's from -13 down; the clouded columns are the evening's.
const DAWN_SPECULAR = 0.1;
const dawn = ( row: AmbientRow, skySpecular: number ): AmbientRow => ( { ...row, at: row.at, clear: { ...row.clear, skySpecular }, fair: { ...row.fair, skySpecular } } );
export const AMBIENT_GRADE_RISING: readonly AmbientRow[] = [
	...AMBIENT_GRADE.filter( ( row ) => row.at > - 2.6 ),
	dawn( AMBIENT_GRADE[ AMBIENT_GRADE.length - 3 ], DAWN_SPECULAR ),
	dawn( AMBIENT_GRADE[ AMBIENT_GRADE.length - 2 ], DAWN_SPECULAR ),
	dawn( { ...AMBIENT_GRADE[ AMBIENT_GRADE.length - 2 ], at: - 12 }, DAWN_SPECULAR ),
	{ ...AMBIENT_GRADE[ AMBIENT_GRADE.length - 1 ], at: - 13 },
	AMBIENT_GRADE[ AMBIENT_GRADE.length - 1 ],
];

/** The table at a sun elevation (degrees), `rising` or setting, and the weather's column weights,
 * into `out`. */
export function evaluateAmbient( elevation: number, weights: readonly number[], out: AmbientKnobs, rising = false ): AmbientKnobs {

	const rows = rising ? AMBIENT_GRADE_RISING : AMBIENT_GRADE;
	let a = rows[ rows.length - 1 ], b = a, t = 0;
	if ( elevation >= rows[ 0 ].at ) a = b = rows[ 0 ];
	else for ( let i = 1; i < rows.length; i ++ ) if ( elevation >= rows[ i ].at ) {

		a = rows[ i ]; b = rows[ i - 1 ];
		t = ( elevation - a.at ) / ( b.at - a.at );
		break;

	}
	for ( const key of AMBIENT_KNOBS ) {

		let sum = 0, weight = 0;
		AMBIENT_COLUMNS.forEach( ( column, c ) => {

			const w = weights[ c ] ?? 0, x = a[ column ][ key ];
			sum += w * ( x + ( b[ column ][ key ] - x ) * t );
			weight += w;

		} );
		out[ key ] = weight > 0 ? sum / weight : D[ key ];

	}
	return out;

}

/** A gain on the table's `sunBounce` at every hour and in every weather: scales the key's bounce
 * throughout without reshaping the table. One now the near air no longer lifts the shade: the
 * shade's level is the light the ground sends up. */
const sunBounceGain = tune( 'lighting.grade.sunBounce', 1, { min: 0.25, max: 4, scale: 'log' } );

/** The weather's gain under overcast's deck, per unit, on all of the land's ambient light: on the
 * sky's light per unit of the bake (after the unit that makes it a clear day's in the same place:
 * AmbientRelight.ts OVERCAST_LAND_UNIT), its bounce with it, and on the sun's bounce per unit of
 * the table's (`update`), by overcast's share and its deck's light (`overcastLandWeight`). It is
 * not the land's whole ambient light under the deck over a clear day's: that ratio also holds the
 * bake's ratio of the two skies and the sun's bounce's share of the light. 1 leaves the land as the
 * sky and the table give it; it stands at 1.75, set with the key's gain under the deck (sky/Sky.ts
 * OVERCAST_KEY_GAIN) and the day sky (sky/Weather.ts `daySky`) on the lit open ground of seven
 * eye-height views of the overcast island: with the sun 14.5, 18 and 21 degrees up that ground's
 * ambient light reads 1.18 to 1.20 times a clear day's in the same place (the views' median; 1.15
 * to 1.26 over the views), the meadow's 0.97 to 1.03 (the views' median): the meadow's clear day
 * holds a larger share of the sun's bounce, which the deck takes away, and the gain is one for all
 * of the land. Tunable: `lighting.relight.overcastLand`. */
export const OVERCAST_LAND = tune( 'lighting.relight.overcastLand', 1.75, { min: 1, max: 2 } );

/** The weight of the weather's land gain under overcast (OVERCAST_LAND) at the sun's `elevation`
 * (degrees), of which overcast's share is `overcast` (sky/Weather.ts `skyMix`, a parked sky
 * counting as overcast): the share times its deck's light (sky/Weather.ts `overcastDeckLight`: at
 * every sun by day, gone by -6 degrees), one weight for the land's sky light (AmbientRelight.ts) and
 * its sun's bounce (`update`). */
export function overcastLandWeight( elevation: number, overcast: number ): number {

	return overcast * overcastDeckLight( elevation );

}

/** The grade's uniforms, read by the lighting models. */
export const ambient = {
	skySpecular: uniform( 1 ),
	skyBounce: uniform( 1 ),
	sunBounce: uniform( 1 ),
	directionality: uniform( D.directionality ),
	aoStrength: uniform( 1 ),
	/** The land's sky gains under a deck over the sky's bake (sky/Weather.ts `deckSkyGain`, the land's
	 * own under overcast: AmbientRelight.ts OVERCAST_LAND_UNIT times OVERCAST_LAND), which the volume
	 * carries: the environment's diffuse takes them where it stands in for the volume (a material
	 * built without a receiver, which by default is the sea floor: materials/TerrainMaterial.ts; and
	 * the volume's share under the water), so the ground under the water keeps the land's light (its
	 * ambient diffuse below the water under overcast takes the sea's, `seaSky`). 1 under a clear or
	 * fair sky. Written by AmbientRelight.ts. */
	landSky: uniform( 1 ),
	/** The sea's sky gain over the land's under overcast's deck, on its share (AmbientRelight.ts
	 * `seaScale` over `skyScale`: the water's deck gain, sky/Weather.ts DECK_SKY_GAIN, and its low
	 * sun's lift, over the land's gain), which the ambient diffuse under the water takes
	 * (lighting/Underwater.ts): the light down there is the light going down through the sea. 1
	 * under every other sky. Written by AmbientRelight.ts. */
	seaSky: uniform( 1 ),
};

/** The grade's controller: the values it wrote last, and the GUI's override. */
export const ambientGrade = {
	/** The values in the uniforms. */
	current: { ...D } as AmbientKnobs,
	/** While on, `manual` replaces the table's output. */
	override: false,
	manual: { ...D } as AmbientKnobs,
	/** The table's output (whatever the override) at the last update. */
	table: { ...D } as AmbientKnobs,
	/** Once a frame: the sun's elevation (degrees) and the weather's column weights (Weather `skyMix`). */
	update( elevation: number, weights: readonly number[], rising = false ): void {

		evaluateAmbient( elevation, weights, this.table, rising );
		Object.assign( this.current, this.override ? this.manual : this.table );
		for ( const key of AMBIENT_KNOBS ) ambient[ key ].value = this.current[ key ];
		ambient.sunBounce.value *= sunBounceGain();
		// the weather's land gain under overcast's deck (OVERCAST_LAND), the override's value too
		ambient.sunBounce.value *= 1 + ( OVERCAST_LAND() - 1 ) * overcastLandWeight( elevation, weights[ 3 ] ?? 0 );

	},
};

/** The ambient occlusion `ao` at the grade's strength, mix( 1, ao, k ), written so that k = 1 gives
 * ao exactly (a lerp's ao - 1 rounds). */
export function gradeOcclusion( ao: F ): F {

	return ao.mul( ambient.aoStrength ).add( ambient.aoStrength.oneMinus() );

}

type Reflected = { directDiffuse: V3; directSpecular: V3; indirectDiffuse: V3; indirectSpecular: V3 };
type Context = { reflectedLight: Reflected; ambientOcclusion: F; iblIrradiance: V3; radiance: V3; thinIrradiance?: V3 };

const occlusions = new WeakMap<THREE.NodeBuilder, F>();

/** The occlusion the ambient diffuse takes, graded: the material's, times the screen's where the
 * material receives it (post/GTAO.ts). Built once per build, where it is first asked for (a model's
 * local lights read it before the ambient's occlusion: lighting/LocalLights.ts), and shared. */
export function diffuseOcclusion( builder: THREE.NodeBuilder ): F {

	let occlusion = occlusions.get( builder );
	if ( ! occlusion ) {

		const ao = ( builder.context as unknown as Context ).ambientOcclusion;
		const screen = ( builder as unknown as { material: THREE.Material | null } ).material?.userData.screenAO === true;
		occlusion = gradeOcclusion( screen ? floorOcclusion( ao.mul( screenAOAt() ) ) : ao ).toVar();
		occlusions.set( builder, occlusion );

	}
	return occlusion;

}

/** Applies the grade to a physical lighting model (three's PhysicalLightingModel or a subclass):
 * called in the constructor of the model root, GroundBounceLightingModel. Its environment terms
 * (three adds the environment's diffuse and specular in `indirectSpecular`, and nothing else
 * there) are gathered apart and added back, the specular scaled by skySpecular; its `ambientOcclusion`
 * takes the occlusion at aoStrength. With the ambient volume on and a `receiver` (the model's way
 * of reading it, lighting/AmbientSample.ts), the volume's irradiance (graded already) replaces the
 * environment's there, and the environment's specular takes the volume's occlusion. Its
 * `ambientOcclusion` is replaced: the occlusion multiplies the ambient diffuse, and the occlusion
 * times the reflection cone against the horizon (AmbientSample.ts `specularOcclusion`) the
 * environment's specular, on every receiver. A thin layer's light (a receiver's `thin`:
 * AmbientSample.ts) is left on the context as `thinIrradiance` for its model (the environment's
 * stand-in without the volume: its irradiance, a uniform sky's). With every knob at 1 the sums and products are exactly those
 * without the grade; the compiled shaders still differ, which moved a few dozen pixels of a 4K
 * frame by one level against the frame without it. */
export function useAmbientGrade( model: THREE.LightingModel, receiver: () => AmbientReceiver | null = () => null ): void {

	const m = model as unknown as {
		indirectSpecular( builder: THREE.NodeBuilder ): void;
		ambientOcclusion( builder: THREE.NodeBuilder ): void;
	};
	const indirectSpecular = m.indirectSpecular.bind( model );
	m.indirectSpecular = ( builder ) => {

		const context = builder.context as unknown as Context;
		const r = context.reflectedLight;
		const diffuse = r.indirectDiffuse, specular = r.indirectSpecular;
		r.indirectDiffuse = vec3( 0 ).toVar();
		r.indirectSpecular = vec3( 0 ).toVar();
		const wanted = receiver();
		const name = ( builder as unknown as { material: THREE.Material | null } ).material?.name;
		const reads = wanted && ambientVolumeOn( wanted.kind ?? name ) ? wanted : null;
		if ( reads ) {

			// the volume's irradiance in the environment's place (graded by the relight already),
			// the environment's specular occluded by it (lighting/AmbientSample.ts)
			const iblIrradiance = context.iblIrradiance, radiance = context.radiance;
			const volume = ambientEnvironment( iblIrradiance.mul( ambient.landSky ), reads );
			context.iblIrradiance = volume.irradiance;
			// a thin layer's light (AmbientSample.ts `thin`), for its model to read
			context.thinIrradiance = volume.thin;
			context.radiance = radiance.mul( volume.occlusion );
			indirectSpecular( builder );
			context.iblIrradiance = iblIrradiance;
			context.radiance = radiance;
			diffuse.addAssign( r.indirectDiffuse );

		} else {

			// the environment in the volume's place, its diffuse with the land's sky gains the volume
			// carries; its specular as in the volume's branch, without them
			const iblIrradiance = context.iblIrradiance;
			context.iblIrradiance = iblIrradiance.mul( ambient.landSky );
			if ( wanted?.thin ) context.thinIrradiance = context.iblIrradiance;
			indirectSpecular( builder );
			context.iblIrradiance = iblIrradiance;
			diffuse.addAssign( r.indirectDiffuse );

		}
		specular.addAssign( r.indirectSpecular.mul( ambient.skySpecular ) );
		r.indirectDiffuse = diffuse;
		r.indirectSpecular = specular;

	};
	// three's occlusion replaced: the ambient diffuse takes the occlusion, the environment's
	// specular the occlusion times the reflection cone against the horizon (AmbientSample.ts
	// `specularOcclusion`), in place of three's estimate from the occlusion and N.V; alpha is the
	// model's GGX alpha (GroundBounceLightingModel sets roughness to its square root)
	m.ambientOcclusion = ( builder ) => {

		const context = builder.context as unknown as Context;
		const occlusion = diffuseOcclusion( builder );
		const Ng = negateOnBackSide( normalViewGeometry ) as unknown as V3;
		const cone = specularOcclusion( normalView, Ng, positionViewDirection, roughness.mul( roughness ) );
		context.reflectedLight.indirectDiffuse.mulAssign( occlusion );
		// the metering illuminance's ambient takes the ambient diffuse's occlusion (MeterLight.ts)
		meterAmbient.mulAssign( occlusion );
		context.reflectedLight.indirectSpecular.mulAssign( cone.mul( occlusion ) );

	};

}
