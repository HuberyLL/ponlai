import * as THREE from 'three/webgpu';
import { negateOnBackSide, normalView, normalViewGeometry, positionViewDirection, roughness, uniform, vec3 } from 'three/tsl';
import { floorOcclusion, screenAOAt } from '../post/GTAO.ts';
import { ambientEnvironment, ambientVolumeOn, specularOcclusion, type AmbientReceiver } from './AmbientSample.ts';
import { meterAmbient } from './MeterLight.ts';
import { tune } from '../debug/Tune.ts';

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
// lit rock and does not rise back through the sunset; the night's row returns it by -2.6 degrees,
// under the night's exposure.
//
// The sun's bounce is 4.5 by day under the clear and the fair sky down to 9 degrees, lets go along
// a smooth step to 1.1 at 4 degrees and holds about 1 to its last light at -1.3; the moon's is 3.2
// from -2.6 degrees down, where its key comes in. Under the cloudy sky every row takes about half
// of clear's, 0.52 to 0.6 (2.4 by day, 1.7 by night); under overcast the day's rows take a third
// (1.5) and the night's half, as under cloudy. The volume bounces the key
// as an even lobe over the whole bounced visibility, weighed by level ground's cosine of the key
// (AmbientRelight.ts), so it falls with the sun as the light on the ground does and reaches a face as
// far as bounced light reaches it from any side: it lights what faces lit ground or a lit crown (a
// blade's underside, a culm's sides, the leaves, the islanders). Read at degree 2, the island's
// receivers' read, under the clear sky the bounces (the sky's and the key's) make 25 % of open
// level ground's light in shade at 62 degrees, 23 % at 50, 17 % at 30, 14 % at 20, 9 to 10 % at 13
// to 10 and 4 % at 4. At 20 degrees bare ground in a grove's shadow at its edge takes 13 to 22 % of
// its shade from the key's bounce and a grove's floor 2 to 4 m in 33 to 37 % (reading 0.61 to 0.63
// of the edge's shade); a culm at the edge reads on its side toward the open 0.85 to 1.2 times the
// open shade beside it (the volume does not know the sun's shadow: AmbientRelight.ts), a culm's two
// sides in the grove's shade read 1.25 to 1.4 apart at its heart and about 1.65 at its edge, and a
// culm's side in the grove 1.1 to 1.35 times its floor; the meadow's blades in the umbra (their
// ambient then read from both faces at 0.75: world/Grass.ts) read about 1.8 times bare ground in the same
// shade at 50 degrees and 1.2 to 1.3 at 20. It also scales the sea's bounce onto the cliffs
// (GroundBounce.ts) and the islanders' bounce.
//
// Overcast is a dark grey sky with the sun still shining (Weather.ts): its sun's bounce takes a
// third of clear's.
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

// the high sun, the afternoon, the low sun, the lift letting go (13 and 10 degrees), the sun's
// bounce letting go (9 to 5.5 degrees), golden hour,
// where the sky's gain starts toward the night key (2 degrees), sunset, the afterglow (-1.3 and -2.6 degrees), the
// blue hour, the night
export const AMBIENT_GRADE: readonly AmbientRow[] = [
	{ at: 60, clear: { ...D, sunBounce: 4.5 }, fair: { ...D, sunBounce: 4.5 }, cloudy: { ...D, sunBounce: 2.4 }, overcast: { ...D, sunBounce: 1.5 } },
	{ at: 30, clear: { ...D, sunBounce: 4.5 }, fair: { ...D, sunBounce: 4.5 }, cloudy: { ...D, sunBounce: 2.4 }, overcast: { ...D, sunBounce: 1.5 } },
	{ at: 20, clear: { ...D, sunBounce: 4.5 }, fair: { ...D, sunBounce: 4.5 }, cloudy: { ...D, sunBounce: 2.4 }, overcast: { ...D, sunBounce: 1.5 } },
	{ at: 13, clear: { ...D, sunBounce: 4.5 }, fair: { ...D, sunBounce: 4.5 }, cloudy: { ...D, sunBounce: 2.4 }, overcast: { ...D, sunBounce: 1.5 } },
	{ at: 10, clear: { ...D, sunBounce: 4.5 }, fair: { ...D, sunBounce: 4.5 }, cloudy: { ...D, sunBounce: 2.4 }, overcast: { ...D, sunBounce: 1.5 } },
	{ at: 9, clear: { ...D, sunBounce: 4.5 }, fair: { ...D, sunBounce: 4.5 }, cloudy: { ...D, sunBounce: 2.4 }, overcast: { ...D, sunBounce: 1.5 } },
	{ at: 7, clear: { ...D, sunBounce: 3.45 }, fair: { ...D, sunBounce: 3.45 }, cloudy: { ...D, sunBounce: 1.85 }, overcast: { ...D, sunBounce: 1.15 } },
	{ at: 5.5, clear: { ...D, skySpecular: 0.5, sunBounce: 2.05 }, fair: { ...D, skySpecular: 0.5, sunBounce: 2.05 }, cloudy: { ...D, sunBounce: 1.1 }, overcast: { ...D, sunBounce: 0.68 } },
	{ at: 4, clear: { ...D, skySpecular: 0.5, sunBounce: 1.1 }, fair: { ...D, skySpecular: 0.5, sunBounce: 1.1 }, cloudy: { ...D, sunBounce: 0.6 }, overcast: { ...D, sunBounce: 0.37 } },
	{ at: 2, clear: { ...D, skySpecular: 0.5 }, fair: { ...D, skySpecular: 0.5 }, cloudy: { ...D, sunBounce: 0.6 }, overcast: { ...D, sunBounce: 0.33 } },
	{ at: 0, clear: { ...D, skySpecular: 0.5 }, fair: { ...D, skySpecular: 0.5 }, cloudy: { ...D, sunBounce: 0.6 }, overcast: { ...D, sunBounce: 0.33 } },
	{ at: - 1.3, clear: { ...D, skySpecular: 0.5 }, fair: { ...D, skySpecular: 0.5 }, cloudy: { ...D, sunBounce: 0.6 }, overcast: { ...D, sunBounce: 0.33 } },
	{ at: - 2.6, clear: { ...D, sunBounce: 3.2 }, fair: { ...D, sunBounce: 3.2 }, cloudy: { ...D, sunBounce: 1.7 }, overcast: { ...D, sunBounce: 1.7 } },
	{ at: - 4, clear: { ...D, sunBounce: 3.2 }, fair: { ...D, sunBounce: 3.2 }, cloudy: { ...D, sunBounce: 1.7 }, overcast: { ...D, sunBounce: 1.7 } },
	{ at: - 18, clear: { ...D, sunBounce: 3.2 }, fair: { ...D, sunBounce: 3.2 }, cloudy: { ...D, sunBounce: 1.7 }, overcast: { ...D, sunBounce: 1.7 } },
];

/** The table at a sun elevation (degrees) and the weather's column weights, into `out`. */
export function evaluateAmbient( elevation: number, weights: readonly number[], out: AmbientKnobs ): AmbientKnobs {

	const rows = AMBIENT_GRADE;
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

/** The grade's uniforms, read by the lighting models. */
export const ambient = {
	skySpecular: uniform( 1 ),
	skyBounce: uniform( 1 ),
	sunBounce: uniform( 1 ),
	directionality: uniform( D.directionality ),
	aoStrength: uniform( 1 ),
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
	update( elevation: number, weights: readonly number[] ): void {

		evaluateAmbient( elevation, weights, this.table );
		Object.assign( this.current, this.override ? this.manual : this.table );
		for ( const key of AMBIENT_KNOBS ) ambient[ key ].value = this.current[ key ];
		ambient.sunBounce.value *= sunBounceGain();

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
			const volume = ambientEnvironment( iblIrradiance, reads );
			context.iblIrradiance = volume.irradiance;
			// a thin layer's light (AmbientSample.ts `thin`), for its model to read
			context.thinIrradiance = volume.thin;
			context.radiance = radiance.mul( volume.occlusion );
			indirectSpecular( builder );
			context.iblIrradiance = iblIrradiance;
			context.radiance = radiance;
			diffuse.addAssign( r.indirectDiffuse );

		} else {

			if ( wanted?.thin ) context.thinIrradiance = context.iblIrradiance;
			indirectSpecular( builder );
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
