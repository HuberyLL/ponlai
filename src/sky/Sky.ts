/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, uv, uniform, texture, positionWorld, cameraPosition, normalize, smoothstep, dot,
	vec2, vec3, vec4, ivec2, float, sqrt, max, atan, asin, clamp, cos, sin, mix, abs, select,
	pmremTexture, textureLoad, Loop, cross, exp2, log2, positionView, fwidth, length, step,
} from 'three/tsl';
import { Atmosphere, SUN_ILLUMINANCE } from './Atmosphere.ts';
import { SCENE_RADIANCE_SCALE, SUN_ANGULAR_RADIUS, SUN_LIMB_U1, SUN_LIMB_U2 } from '../lighting/Radiometry.ts';
import { SUN_DISC_RADIUS, SUN_DISC_SOLID_ANGLE, SUN_DISC_RADIANCE } from '../lighting/SunDisc.ts';
import { CLOUD_FORM, Clouds, EARTH_RADIUS, SHADOW_SLOPE_FLOOR, SHELL_BOTTOM, SHELL_THICKNESS, forwardLevel, type CloudViewScale } from './Clouds.ts';
import { MOON_ANGULAR_RADIUS, NightSky } from './NightSky.ts';
import { Lightning } from '../weather/Lightning.ts';
import { debugFlags } from '../debug/DebugFlags.ts';
import { shared } from '../shared.ts';
import { compileInto } from '../post/graph/Compile.ts';
import { FSR3, TEMPORAL } from '../post/Antialiasing.ts';
import { jitter } from '../post/Jitter.ts';
import { MOTION_CLASS, meterOutput, motionNode } from '../post/Motion.ts';
import { DAY_EXPOSURE, displayNight, skyNight, sunRising, twilightMoon, type DayCycleSnapshot } from './DayCycle.ts';
import { KEPT_SKIES, WEATHER_PRESETS, cloudedHighSun, cloudedShare, deckTakeover, type WeatherFront, type WeatherState } from './Weather.ts';
import { keyed, type DayKey, type DayKeys } from '../post/DayKeys.ts';
import { tune, tuneKeys, tuneObject } from '../debug/Tune.ts';
import { markSkyRetune } from './SkyRetune.ts';
import { moonDirection } from '../lighting/KeyLift.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;
// The haze toward a view direction, out to a distance (the sky's own by default): the light it adds
// and its transmittance (VolumetricHaze.ts `skyHaze`).
export type SkyHaze = ( d: V3, distance?: THREE.Node<'float'> ) => { light: V3; transmittance: V3 };
// Directions the discs' cloud transmittance averages over each disc (discCloudTransmittance): the
// disc is about a degree wide, and 32 dim it without visible steps.
const DISC_SAMPLES = 32;
// The sky's metering illuminance against its geometric-mean luminance (k_m), and the floor of the
// luminance whose log the mean takes (scene units: far below a moonless night's sky).
const METER_SKY = 1;
const METER_FLOOR = 2 ** - 40;
type DisplayedWeather = Pick<WeatherState, 'haze' | 'rain' | 'fog' | 'windSpeed' | 'windDirection'>;

// The sky: atmosphere, clouds, night sky and the baked environment. One cloud field feeds the
// visible sky, water reflections, environment lighting and cloud shadows; on the island's direct
// light the shadows keep the weather's floor (`keyCloudVisibility`), and under a closed deck the key
// and the clouds' sunlight lose their colour, not their luminance (Weather.ts), as from a cloudy sky on
// the sunlight the clouds scatter many times does (trackClouds). By day the sky's light, the
// sun's in-scattered light and the cirrus' sunlight, takes one gain
// against the sun's own (SKY_LIGHT, an illuminance colour), which everything that reads the sky
// takes, and under a clear or fair day's sun another that holds it against the key (CLEAR_SKY);
// a cloud deck does not mute the clear sky's colour behind it. At night the clear sky is the
// moon's in-scatter, drawn with the moon's key light (MOON_KEY), and the stars: no airglow and no
// night floor of its own. The moon, while it is up, is drawn and lights the sky (and through the
// atmosphere's `moonDir` the clouds and the haze) from the night key's fixed direction, where the
// island takes its light from (lighting/KeyLift.ts `moonDirection`), and the key's direction
// (`keyDir`) turns there over the handoff and holds there all night, so the water's glint and the
// clouds' light see the moon where it is drawn; its phase keeps the orbit's
// angle to the sun (`track`). The clouds take their own path between the two in the twilight, while
// no light reaches them (CLOUD_TURN). After sunset the light the sky lends the island takes a gain
// of its own (ISLAND_SKY), and under a clouded high sun a tint of its own (CLOUD_LIGHT_TINT), which
// the sky the eye sees, the sea's reflection of it and the sea's own body never take. The dome lays the air's haze over
// itself (`fogDome`, VolumetricHaze.ts `skyHaze`): the clouds at the distance to their shell's middle
// height (the weather's shell: CLOUD_SHELL, low under cloudy and overcast skies), under the low
// deck's share at the march's own opacity-weighted depth (Clouds `sampleViewDepth`), the sky behind
// them along the whole way; so the haze's composite leaves the sky's pixels. Measured on the horizon
// views (paused, fresh loads): overcast's sky box spread .067 to .059, its gradient p99 .019 to .043
// and its scale std under 3 degrees .0017 to .0030, the deck's rolls showing from about 8 degrees
// up; cloudy's gradient p99 .042 to .071 and mass x 3.6 to 3.5 degrees.
// The environment's bake lays the same haze over its source as the dome does (`fogEnvironment`,
// VolumetricHaze.ts `openSky`, toward every direction from the sea's level, unshadowed): the environment and the dome
// are one sky, its haze light included, so the ground's sky light takes the light the haze scatters
// and the sea reflects it (the seen panorama, above the horizon).
// The sun's disc and the moon's are dimmed by the clouds' mean transmittance over each disc, read
// from the panorama into a texel ahead of the scene (`discCloudTransmittance`), and hidden by the
// clouds' opacity once, in the composite. The key light's colour does not take that mean: the lit
// surfaces already read the clouds' shadow map along the same ray, and both would darken it twice.
// Under a low key that map's rays spread over the key's disc (SHADOW_DISC): whatever lights the
// ground and feeds the meter from it reads the whole disc, the air's shafts its centre from about
// 5 degrees up (SHADOW_AIR_NARROW).
// The dome writes the exposure's metering illuminance (Motion.ts `meterOutput`): one value for all
// its pixels, the sky's geometric-mean luminance exp( mean ln Y ) over the upper hemisphere by solid
// angle, times METER_SKY. The irradiance probe's pass reduces it from the same panorama once per
// bake, as log2 in its alpha, so the cross-fade between bakes blends it geometrically; the exposure
// reads that log directly (`meterLog2Node`, shared.ts `skyMeterLog2`).
//
// Only the reflection panorama, environment and irradiance cross-fade between bakes. A periodic
// bake on a running clock spreads over frames: its panoramas and irradiance in the frame that asks
// for it, then the environment's PMREM conversion and GGX filters at most four render passes a
// frame, published (with the same products as a whole bake) a few frames later. Explicit bakes
// (presets, seeks, weather jumps, the first bake) and any bake while the scene clock is paused run
// whole, so paused frames stay exact. A paused page keeps its last explicit bake's products, and
// every explicit bake (the load's, a scene jump's, a seek's, a retune's) starts from the state
// before a page's first bake, the clouds set to the scene clock (`reset`), so each makes the ones
// a fresh load of its scene makes. A bake waits for the warm-up's
// pipelines (`warm`) before it draws: three r186 skips a draw whose pipeline an asynchronous
// compile is still creating, so a bake drawn meanwhile left its products empty (the irradiance
// probe at 0: no sky light, and the exposure about five stops off at noon), and a paused page,
// which bakes no more, kept them. The spread drives three's
// `PMREMGenerator` private steps
// (`_setSizeFromTexture`, `_init`, `_textureToCubeUV`, `_applyGGXFilter`, `_setViewport`): re-check
// them on a three upgrade; without them it falls back to `fromEquirectangular`.

// Baked products. Directions, colours, the grade and the clouds themselves are evaluated every
// frame; only these slower reflection, environment and irradiance products cross-fade. The
// environment's two atlases are kept apart (Sky.environments), so a tier may refresh it on only
// every few bakes.
interface SkyEndpoint {
	equirect: THREE.RenderTarget;
	clouds: THREE.RenderTarget;
	irradianceMap: THREE.RenderTarget;
	// the cloudless sky's (Sky.clearIrradianceNode)
	clearIrradianceMap: THREE.RenderTarget;
	// the sky's without the haze over it, its clouds included (Sky.deckIrradianceNode)
	deckIrradianceMap: THREE.RenderTarget;
	version: number;
	irradiance: THREE.Color;
}

// One bake: its endpoint, whether it is explicit (reads its irradiance back and shows at once),
// and the environment atlas it refreshes (null: it keeps the one shown).
interface Bake {
	version: number;
	readback: boolean;
	transitionSeconds: number;
	next: number;
	state: SkyEndpoint;
	environment: number | null;
}

// A step of a periodic bake spread over frames; `cost` counts its render passes.
interface Slice {
	cost: number;
	run: () => void;
}

// PMREMGenerator's own steps (three r186), driven one at a time so a periodic bake's GGX filter
// chain spreads over frames. Their order and arguments are those of its _fromTexture, so the
// atlas comes out the same; Sky.environmentSlices falls back to the whole call without them.
interface PMREMSteps {
	_lodMeshes: unknown[] | undefined;
	_setSizeFromTexture( texture: THREE.Texture ): void;
	_init( target: THREE.RenderTarget ): void;
	_textureToCubeUV( texture: THREE.Texture, target: THREE.RenderTarget ): void;
	_applyGGXFilter( target: THREE.RenderTarget, lodIn: number, lodOut: number ): void;
	_setViewport( target: THREE.RenderTarget, x: number, y: number, width: number, height: number ): void;
}

// Render passes of a periodic bake per frame after its first (the panoramas): the conversion to
// the cube atlas and its GGX filters (two passes each), a fraction of a millisecond each at high.
// A frame takes whole steps up to this many passes: the conversion and one filter, then two
// filters a frame.
const SLICE_PASSES = 4;
// A periodic bake whose frames stop coming (a stopped loop, a hidden page) completes after this
// long, so it never holds the sky busy.
const SLICE_TIMEOUT_MS = 250;

function makeEndpoint(): SkyEndpoint {

	const equirect = new THREE.RenderTarget( 512, 256, {
		type: THREE.HalfFloatType, generateMipmaps: true,
		minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
		wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping, depthBuffer: false,
	} );
	equirect.texture.mapping = THREE.EquirectangularReflectionMapping;
	equirect.texture.name = 'skyEquirect';
	// Upper hemisphere only: in-scattered cloud radiance (rgb) and transmittance (a), composed
	// over the live clear sky when displayed.
	const clouds = new THREE.RenderTarget( 512, 128, {
		type: THREE.HalfFloatType, depthBuffer: false,
		minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
		wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping,
	} );
	clouds.texture.name = 'skyCloudLayer';
	return {
		equirect,
		clouds,
		irradianceMap: new THREE.RenderTarget( 1, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter } ),
		clearIrradianceMap: new THREE.RenderTarget( 1, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter } ),
		deckIrradianceMap: new THREE.RenderTarget( 1, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter } ),
		version: 0,
		irradiance: new THREE.Color( 0, 0, 0 ),
	};

}

// The atmosphere is the single source of sky radiance and solar extinction. The visible sky
// includes the sun disk; the water panorama and PMREM omit it because direct lighting already
// reflects the sun. This follows tidewater's separation of view and reflection radiance.
export const dirToEquirect = Fn( ( [ d ]: [ V3 ] ) => {

	return vec2( atan( d.z, d.x ).mul( 0.5 / Math.PI ).add( 0.5 ), asin( clamp( d.y, - 1, 1 ) ).div( Math.PI ).add( 0.5 ) );

} ).setLayout( { name: 'dirToEquirect', type: 'vec2', inputs: [ { name: 'd', type: 'vec3' } ] } );

const equirectToDir = Fn( ( [ q ]: [ V2 ] ) => {

	const phi = q.x.sub( 0.5 ).mul( 2 * Math.PI ).toVar(), th = q.y.sub( 0.5 ).mul( Math.PI ).toVar();
	return vec3( cos( th ).mul( cos( phi ) ), sin( th ), cos( th ).mul( sin( phi ) ) );

} ).setLayout( { name: 'equirectToDir', type: 'vec3', inputs: [ { name: 'q', type: 'vec2' } ] } );

// Art direction: the island stays readable after sunset. Through the minutes after it the sun's
// skylight has faded while the moon's key and the night ambient are not yet in, which left the
// meadow at about half its night brightness. The light the sky lends the island takes a gain and
// a warm cast per sun elevation, ISLAND_SKY: the environment's source panorama, which lights the
// terrain and plants, in its bake, and the islanders' sky fill (`islandIrradianceNode`, the
// irradiance probe graded the same way). The seen sky, the panorama the sea reflects and the
// irradiance probe itself, which lights the sea's body, keep the atmosphere's own, so the evening's
// sky and sea look as they did. Each row is an elevation (degrees, descending): the colour the
// light is drawn toward (linear, at the light's own luminance), how far, and the gain; rows
// interpolate linearly and the end rows hold beyond them. From 2 degrees up the light is the
// atmosphere's alone; from -13.2 down it is drawn 0.6 of the way to a deep blue, so the moonlit
// island's shade, lit by this sky alone, reads a deep blue rather than ink, bluer than the moonlit
// ground and the moon's own key. The gains set the island's exposed brightness (the top view's
// land, with the moon's key; the metering illuminance holds this light too) through the twilight.
// A clear evening keeps its day exposure on the golden hour's key until the night's comes in from
// -7 degrees (post/Exposure.ts, DayCycle.ts `displayNight`), and the land keeps the probes' golden
// gain on the sky's light (lighting/AmbientRelight.ts PROBE_SKY), both held from the golden hour
// down; so past a lift of about 1.2 through the sunset itself, the light lent from -1.3 degrees
// down stands a little under the sky's own (gains of 0.85 to 0.96 down to -5.3 degrees), set on
// the meadow on the plateau in the island view, which reads about L 0.2 at -3.3 and -5.3 degrees.
// The rows at -1.3, -2.6 and -4 take a scale near their neighbours', the row at -8.6 keeps the
// 0.76 it was set with, and the gains return to none as the night's exposure comes in (by -13.2).
// The rows at 1, 0.5 and 0 degrees take the colour the rows around them gave there. From -2.6 to
// -5.3 degrees the light is drawn 0.9 of the way to an orange (red over green about 1.95, blue
// over green about 0.2), 0.7 of the way at -1.3: the afterglow's light on the land. The sky's own
// light after sunset is near grey (red over green about 1.05, its dusk key near neutral:
// SKY_LIGHT), and the air over the land, which had laid the glow's orange over the meadow, is thin
// after sunset (HazeKeys.ts AFTER_SUNSET); under the sky's own light, or drawn half way to the
// colour the warmer key gave, the meadow on the plateau read an olive green (Oklab hue 112 - 124
// against about 82 here).
// The afterglow is a clear sky's: under a deck there is no glow to lend the land its orange, and
// these rows laid it on the cliffs of a cloudy or overcast evening as a warm brown under a blue
// deck and sea (the rock at -5 degrees red over green 0.83, against 0.5 and a blue grey under the
// rows before them). A clouded sky takes those rows (ISLAND_SKY_CLOUDED: a light warm cast, the
// gains of 0.65 and 0.5 at -4 and -5.3 degrees) by its clouded share (`islandSky`).
// The rising sun has rows of its own (ISLAND_SKY_RISING).
// By day a clouded sky lends the island its own light: a deck of cloud passes on little of the blue
// of the sky's high key (SKY_LIGHT), so from 12 to 40 degrees, as that key climbs, the light lent to
// the island is drawn most of the way to a warm grey (CLOUD_LIGHT_TINT, Weather.ts `cloudedHighSun`). The land
// keeps its green under a high sun; the meter's level is the same, the tint keeping the luminance.
const CLOUD_LIGHT_TINT = ( ( r: number, g: number, b: number, amount: number ) => {

	const l = r * 0.2126 + g * 0.7152 + b * 0.0722;
	return [ r / l, g / l, b / l, amount ] as const;

} )( 1.2, 1, 0.5, 0.6 );
interface IslandRow { at: number; tint?: readonly [ number, number, number ]; amount?: number; gain?: number }
const ISLAND_SKY: readonly IslandRow[] = [
	{ at: 2 },
	{ at: 1, tint: [ 1.085, 0.988, 0.872 ], amount: 0.15, gain: 1.16 },
	{ at: 0.5, tint: [ 1.128, 0.982, 0.807 ], amount: 0.225, gain: 1.24 },
	{ at: 0, tint: [ 1.17, 0.976, 0.743 ], amount: 0.3, gain: 1.16 },
	{ at: - 1.3, tint: [ 1.66, 0.9, 0.09 ], amount: 0.7, gain: 0.89 },
	{ at: - 2.6, tint: [ 1.78, 0.86, 0.08 ], amount: 0.9, gain: 0.96 },
	{ at: - 3.3, tint: [ 1.78, 0.86, 0.08 ], amount: 0.9, gain: 0.85 },
	{ at: - 4, tint: [ 1.78, 0.86, 0.08 ], amount: 0.9, gain: 0.87 },
	{ at: - 5.3, tint: [ 1.78, 0.86, 0.08 ], amount: 0.9, gain: 0.92 },
	{ at: - 8.6, gain: 0.76 },
	{ at: - 13.2, tint: [ 0.45, 1, 3.6 ], amount: 0.6 },
];
const ISLAND_SKY_CLOUDED: readonly IslandRow[] = [
	...ISLAND_SKY.slice( 0, 4 ),
	{ at: - 1.3, tint: [ 1, 0.75, 0.45 ], amount: 0.5, gain: 0.89 },
	{ at: - 2.6, tint: [ 0.95, 0.8, 0.58 ], amount: 0.5, gain: 0.96 },
	{ at: - 3.3, tint: [ 1.11, 0.99, 0.767 ], amount: 0.5, gain: 0.85 },
	{ at: - 4, tint: [ 0.9, 0.85, 0.7 ], amount: 0.5, gain: 0.65 },
	{ at: - 5.3, tint: [ 1.04, 1, 0.874 ], amount: 0.36, gain: 0.5 },
	...ISLAND_SKY.slice( 9 ),
];

// The rising sun's: none of the evening's warm cast, only the night's deep blue below -10 degrees,
// and gains of its own. A clear morning's day exposure is metered by the sky and the land together
// (post/Exposure.ts, the `dawn` key), so the land's brightness is this light against the sky's: the
// gains keep the land from about 0.55 at -8 degrees, where the sky's light is still deep, and 0.66
// at -6.5, where the land still takes part of the night's gain on its sky light (lighting/
// AmbientRelight.ts PROBE_SKY: about a quarter of it there), through a lift of about 2 at -2.6,
// where the sky's has fallen behind the sun's coming, to none from 2 up.
// A blue cast of its own (the night's, at 0.3) turned the rock's brightest tenth to C 0.08 to 0.09
// at -6.5 degrees, against 0.07 to 0.08 without: the land takes the sky's own colour. A clouded
// morning keeps these tints but takes the evening's gains back by its clouded share (`islandSky`):
// its exposure stays on the clouded keys, which these gains were not set under.
const ISLAND_SKY_RISING: readonly IslandRow[] = [
	{ at: 2 },
	{ at: 1, gain: 1.3 },
	{ at: 0, gain: 1.6 },
	{ at: - 1.3, gain: 2 },
	{ at: - 2.6, gain: 2.2 },
	{ at: - 3.3, gain: 2 },
	{ at: - 4, gain: 1.8 },
	{ at: - 5.3, gain: 1.3 },
	{ at: - 6.5, gain: 0.66 },
	{ at: - 8, gain: 0.55 },
	{ at: - 8.6, gain: 0.6 },
	{ at: - 10, gain: 0.8 },
	ISLAND_SKY[ ISLAND_SKY.length - 1 ],
];

// ISLAND_SKY at `elevation`, on the rising or the setting sun's side: the tint (normalised to unit
// luminance) and its amount into `tint`; returns the gain. A clouded share `cloud` (Weather.ts
// `cloudedShare`) draws the setting rows to the clouded evening's (ISLAND_SKY_CLOUDED). The rising
// rows' tints hold under any sky, but their gains were set on a clear morning's exposure
// (post/Exposure.ts, `dawn`), so the clouded share takes the clouded evening's gain back, as the
// display's night weight does (DayCycle.ts `displayNight`).
function islandSky( elevation: number, rising: boolean, tint: THREE.Vector4, cloud: number ): number {

	const at = ( row: IslandRow ) => {

		const [ r, g, b ] = row.tint ?? [ 1, 1, 1 ], l = r * 0.2126 + g * 0.7152 + b * 0.0722;
		return [ r / l, g / l, b / l, row.amount ?? 0, row.gain ?? 1 ];

	};
	const along = ( rows: readonly IslandRow[] ) => {

		let v = at( rows[ rows.length - 1 ] );
		if ( elevation >= rows[ 0 ].at ) v = at( rows[ 0 ] );
		else for ( let i = 1; i < rows.length; i ++ ) if ( elevation >= rows[ i ].at ) {

			const t = ( elevation - rows[ i ].at ) / ( rows[ i - 1 ].at - rows[ i ].at );
			const a = at( rows[ i ] ), b = at( rows[ i - 1 ] );
			v = a.map( ( x, c ) => x + ( b[ c ] - x ) * t );
			break;

		}
		return v;

	};
	let v = along( ISLAND_SKY );
	if ( cloud > 0 ) {

		const c = along( ISLAND_SKY_CLOUDED );
		v = v.map( ( x, i ) => x + ( c[ i ] - x ) * cloud );

	}
	if ( rising ) {

		const r = along( ISLAND_SKY_RISING );
		if ( cloud > 0 ) r[ 4 ] += ( v[ 4 ] - r[ 4 ] ) * cloud;
		v = r;

	}
	tint.set( v[ 0 ], v[ 1 ], v[ 2 ], v[ 3 ] );
	return v[ 4 ];

}

// Off by default (docs/art-direction.md, The look: the light keeps the sun's and the sky's own
// balance): with the meadow's own soft light the lifted shade left a shaded clump within a
// quarter of a lit one and the meadow showed no side the light came from. `flags=clearShade:<k>`
// (or `true`) brings it back for A/Bs. What it was: the shade clear, never black. Shade is lit by
// the sky alone, so the sky light lent to the island (as ISLAND_SKY's: the environment's source
// and the islanders' fill) takes a gain and turns a touch cooler: the skylit faces of the cliffs
// and the meadow's shaded side open up while what the sky cannot reach (cracks, the meadow's
// floor, what sky occlusion darkens) stays dark. A constant lift in the grade instead greyed
// everything below mid grey alike and veiled the frame. The gain's extra share per sun elevation
// (degrees, descending; linear between rows, the end rows held beyond): a low sun's light already
// holds a larger share of sky, so the same gain brightened a morning island about twice as much as
// a noon one, and the share falls with the sun to none at 2 degrees, where ISLAND_SKY's evening
// rows begin; past them, in the night, the night sky's fill takes a share of its own, so the
// moonlit island's shade stays readable (a film's night, not a dark one). Cloud leaves the whole
// island in shade, where a gain only brightens it: the share fades with the direct visibility,
// none by overcast. A noon gain of 1.8 was chosen over 2.5 by eye (the shade turned cold).
const CLEAR_SHADE: readonly { at: number; share: number }[] = [
	{ at: 45, share: 0.8 },
	{ at: 26, share: 0.55 },
	{ at: 13, share: 0.35 },
	{ at: 5, share: 0.15 },
	{ at: 2, share: 0 },
	{ at: - 13.2, share: 0 },
	{ at: - 18, share: 0.6 },
];
// the sky light's tint (unit luminance) and how far it is drawn toward it at a share of 1
const CLEAR_SHADE_TINT = ( ( r: number, g: number, b: number ) => {

	const l = r * 0.2126 + g * 0.7152 + b * 0.0722;
	return [ r / l, g / l, b / l, 0.44 ] as const;

} )( 0.86, 1, 1.1 );

// Off by default with the clear shade (`flags=lowSun:<k>` or `true` for A/Bs). What it was: a low
// sun's light golden and its shade cool blue-violet. The shade's half: from about 12 degrees down to the horizon the sky light lent to the
// island turns from CLEAR_SHADE's cool cyan toward blue-violet, drawn toward it by up to
// LOW_SUN.amount whatever the gain (a low sun's share of the gain is small), so only the island's
// shade takes it, never the sea or the sky. It fades out above LOW_SUN.top, and below the horizon
// into ISLAND_SKY's warm evening cast; cloud takes it out with the direct sun. (The light's half,
// a warmer grade of what the low sun lit, is gone.)
const LOW_SUN = { full: 12, top: 28, amount: 0.65 };
/** How far a deck draws the key toward white at the same luminance (`update`): overcast's sun is
 * whiter than a clear day's at the same height but keeps some of its warmth; rain's closed deck
 * draws it all the way. */
const KEY_DECK_WHITE = 0.3;
const LOW_SUN_TINT = ( ( r: number, g: number, b: number ) => {

	const l = r * 0.2126 + g * 0.7152 + b * 0.0722;
	return [ r / l, g / l, b / l ] as const;

} )( 0.95, 0.85, 1.2 );

/** How far the low sun's look has come in at `elevation` (degrees) under a sky of direct
 * visibility `direct`: 0 above LOW_SUN.top and below the horizon, 1 from LOW_SUN.full down to
 * 3 degrees (the island's blue-violet shade). */
export function lowSun( elevation: number, direct: number ): number {

	// (off unless a number is set, with the clear shade)
	const scale = typeof debugFlags.lowSun === 'number' ? debugFlags.lowSun : debugFlags.lowSun === true ? 1 : 0;
	return THREE.MathUtils.smoothstep( elevation, 0, 3 ) * ( 1 - THREE.MathUtils.smoothstep( elevation, LOW_SUN.full, LOW_SUN.top ) )
		* THREE.MathUtils.smoothstep( direct, 0.3, 0.95 ) * scale;

}

// CLEAR_SHADE's share at `elevation` under a sky of direct visibility `direct`.
function clearShade( elevation: number, direct: number ): number {

	const rows = CLEAR_SHADE;
	let share = rows[ rows.length - 1 ].share;
	if ( elevation >= rows[ 0 ].at ) share = rows[ 0 ].share;
	else for ( let i = 1; i < rows.length; i ++ ) if ( elevation >= rows[ i ].at ) {

		const t = ( elevation - rows[ i ].at ) / ( rows[ i - 1 ].at - rows[ i ].at );
		share = rows[ i ].share + ( rows[ i - 1 ].share - rows[ i ].share ) * t;
		break;

	}
	// (off unless a number is set: the lifted shade took the light's direction out of the meadow)
	const scale = typeof debugFlags.clearShade === 'number' ? debugFlags.clearShade : debugFlags.clearShade === true ? 1 : 0;
	return share * THREE.MathUtils.smoothstep( direct, 0.3, 0.95 ) * scale;

}

// The sky's light against the sun's. As the atmosphere's march and the cirrus gave it, the clear
// day's sky lit level shade too brightly beside the sun. By day both take one constant gain
// (SKY_LIGHT, an illuminance colour per channel, keyed by the sun's elevation: DayKeys.ts)
// on the light the sun lends them: the atmosphere's in-scattered light (Atmosphere.ts `skyRadiance`)
// and the cirrus' sunlight, at the colour's luminance (Clouds.ts `cirrusSunGain`, at CIRRUS_SHARE of the atmosphere's). So
// everything that reads the sky takes it, the seen sky, the environment's bakes and the irradiance
// probe that light the island, the sea's reflection and the clouds' and the haze's sky light, and
// the sky the eye sees stays the sky that lights. The two light the shade in different colours, the
// atmosphere's blue and the cirrus' warm; the cirrus takes three quarters of the atmosphere's gain
// (set when the noon shade's blue was tuned by eye, before the keys were set), and one gain on
// both keeps that mix at every hour. How the sky's light falls with the sun is the atmosphere's
// own (the aerosol's wide base and the multiple scattering that grows along long paths:
// Atmosphere.ts), not rows by the sun's elevation. Under cloud the gain moves to the night key from
// 2 degrees to -6 under the horizon (a smoothstep); a clear sky's holds the day's keys through the
// twilight and moves from -7 to -11 after sunset, from -13 to -3 before sunrise (DayCycle.ts
// `skyNight`), so the sky after sunset dims with the sun's light it lends
// without the jump to the atmosphere's own light that fading the gain to none gave (several times
// brighter than the golden key, its blue more so). The sun's own light
// (its transmittance, the disk) and the cumulus it lights are untouched. The night key is the moonlit
// sky's gain on the moon's key light (MOON_KEY), which the sky, the clouds and the haze take; the
// island's moonlight takes the key's level with a hue of its own (`moonHue`). The keys set
// the sky's brightness and colour in bands of elevation and of angle from the sun, together with
// the atmosphere's phase and aerosol and the haze's keys, once the environment's bake took the
// haze's light: the golden key takes the sky warm (red over blue about 2.9), the low key near grey,
// the high key blue (blue over red about 1.5), the atmosphere's own colour doing the rest, and the
// night key is about 0.03, its red about twice its green, which the night's white balance takes
// back (Pipeline.ts WHITE_BALANCE): the land's dark colours stay near neutral under it, the clear
// night's dome is dark, its low sky the haze's moonlit light (HazeKeys.ts NIGHT) and its blue the
// moonlit atmosphere's own and the rods' (Purkinje.ts).
// The golden, low and morning keys keep the colour they lent the sky before the ozone's absorption
// was integrated over each channel's band (Atmosphere.ts): with it the bare sky lost red and blue
// against green, by 0.75 and 0.88 times at a sun of 3 degrees, 0.89 and 0.95 at 12 and 0.97 and
// 0.99 at noon, and these keys take the first two back at their luminance (the golden hour's sky,
// far bay and meadow had turned yellow by 10 - 16 degrees of hue, the morning's sea toward cyan).
// The high key, whose sky hardly moved, keeps its own.
// Under cloud the high key has a twin (`cloudyHigh`, taken by the weather's clouded share, Weather.ts
// `cloudedShare`): a deck of cloud gives the sky and the air no such blue, and the air over the land
// takes this light whole (VolumetricHaze.ts), so at the day's blue the crowns under a clouded sky
// turned blue grey, most of all at 30 degrees, where that blue meets the near air's full density
// (HazeKeys.ts). The twin stays near grey, blue over red about 1.1, at about the day's luminance, so
// the air's hue moves and the land's level and the exposure do not. Its golden and low keys are the
// day's own, so a clouded sky parts from a clear one only over 12 degrees.
// On a clear evening the sky takes a key below the golden one (`dusk`, at -1 degrees, not under
// cloud), held through the twilight until the night key takes it from -7 degrees. It is a
// near-neutral warm key at the twilight, at the luminance the warm key before it had: the
// twilight sky's colour is the atmosphere's own (Atmosphere.ts), orange at the glow, yellow above
// it and near grey from 20 degrees up. A warm key (blue under a third of red) laid one tint over
// the whole dome, which turned the sky 20 degrees up magenta (red over green about 2.1, blue over
// green 1.5, with the sun 5.6 degrees under the horizon). The land takes its twilight warmth from
// the light lent to it (ISLAND_SKY).
// The morning is not the evening turned round. These keys hold in every direction, so a warm key
// warms the whole picture: the golden key is the evening's, where the whole sky is alight, and the
// clear morning has keys of its own (`dawn`, `morning`, read while the sun rises: DayKeys.ts
// `rising`). At sunrise the air is already blue and the warm colour stays in the sun's road and the
// low streaks, so `dawn` takes the twilight's near-neutral light (the dusk key's colour, at the
// luminance the cooler key before it had: the sky before sunrise is the same atmosphere's), and the
// display's dawn white balance (Pipeline.ts WHITE_BALANCE) cools it from there: the band over the
// horizon, nearly all the haze's light, and the sea under it stay a quiet blue grey. By 12 degrees
// the picture has gone cool and quiet, and `morning` is the day's light at about two thirds of the
// low key with less green (red a little over blue, green about 0.7 of them), which turns the
// morning's sky and sea from cyan to blue, so the sea stands lighter under the same sky, the meter
// holding the sky's level. Both are fits on our own views, at the luminance they had. From the `high` key up
// the two sides are one. A clouded morning keeps the clouded keys.
// Tunable on debug pages (debug/Tune.ts): `sky.light.<r|g|b>@<dawn|morning|dusk|golden|low|high|cloudyHigh|night>`.
const SKY_LIGHT_LOW_SUN: readonly DayKey<{ r: number; g: number; b: number }>[] = [
	{ at: 3, name: 'golden', values: { r: 0.36, g: 0.162, b: 0.1227 } },
	{ at: 12, name: 'low', values: { r: 0.2409, g: 0.1857, b: 0.1979 } },
];
const SKY_LIGHT_HIGH: DayKey<{ r: number; g: number; b: number }> = { at: 40, name: 'high', values: { r: 0.235, g: 0.232, b: 0.346 } };
const SKY_LIGHT: DayKeys<{ r: number; g: number; b: number }> = tuneKeys( 'sky.light', {
	day: [ { at: - 1, name: 'dusk', values: { r: 0.2263, g: 0.2014, b: 0.1946 } }, ...SKY_LIGHT_LOW_SUN, SKY_LIGHT_HIGH ],
	rising: [
		{ at: 3, name: 'dawn', values: { r: 0.2008, g: 0.1787, b: 0.1727 } },
		{ at: 12, name: 'morning', values: { r: 0.1809, g: 0.1207, b: 0.1683 } },
		SKY_LIGHT_HIGH,
	],
	cloudy: [ ...SKY_LIGHT_LOW_SUN, { at: 40, name: 'cloudyHigh', values: { r: 0.25, g: 0.232, b: 0.28 } } ],
	night: { r: 0.045, g: 0.023, b: 0.028 },
}, { r: { min: 0.001, max: 2, scale: 'log', onChange: markSkyRetune }, g: { min: 0.001, max: 2, scale: 'log', onChange: markSkyRetune }, b: { min: 0.001, max: 2, scale: 'log', onChange: markSkyRetune } } );
const _skyLight = { r: 0, g: 0, b: 0 };
// The clear day's sky against the key. With SKY_LIGHT alone the key's illuminance at normal
// incidence stood 50 - 72 times the sky's irradiance on level ground (the irradiance probe's: the
// environment's sky with its clouds and the haze over it, before any gain of the land's own) from
// 50 down to 6 degrees in the evening, 68 - 91 from 26 down to 7 in the morning, 30 - 45 at 4 and
// 20 - 24 at 3: the island's shade was nearly black against its lit side, and the sky stood dark
// against the key. Under a clear or fair day's sun the sky's light takes a gain of its own over
// SKY_LIGHT (CLEAR_SKY), keyed by the sun's elevation, on every path SKY_LIGHT reaches (`skyGain`):
// the sky the eye sees and the cirrus, the sea's reflection and its body, the clouds' and the haze's
// sky light, the land's (the environment's source: the probes' harmonics, the specular atlas, the
// islanders' fill) and the exposure's sky meter. So the sky the eye sees stays the sky that lights
// and that the exposure meters (post/Exposure.ts). The sky's irradiance takes the gain whole (the
// sky's light, the sun's in-scattered light and the haze's are all SKY_LIGHT's), so the keys are
// the ratio with no gain over the one they hold: 12.1 - 15 from 6 degrees up on either side of the
// day and at the morning's 3 degrees. At the evening's 3 degrees the sky stands brighter against
// the key, about 7.4 - 8.9: it lights the land's shade and the far bay, as far as a view along the
// horizon toward the sun holds the far sea and the sun's strip on the water (post/Exposure.ts, the
// highlight key). The smoothstep between keys (DayKeys.ts) puts the ratio's day high midway, at 21
// degrees in the evening. Under 3 degrees the key falls faster than the sky by itself (the ratio
// 12.4 at 1.6 degrees with no gain), so the gain eases to none at the horizon (`horizon`): the
// twilight and the night keep SKY_LIGHT's light, the ratio falling to about 6 at 2 degrees on the
// way. The gain
// leaves by the weather's clouded share (Weather.ts `cloudedShare`): a cloudy or overcast sky keeps
// the light it had.
// Tunable on debug pages: `sky.clear.gain@<horizon|dawn|early|morning|golden|late|low|high>`.
const CLEAR_SKY_HORIZON: DayKey<{ gain: number }> = { at: 0, name: 'horizon', values: { gain: 1 } };
const CLEAR_SKY_HIGH: DayKey<{ gain: number }> = { at: 40, name: 'high', values: { gain: 4.0 } };
const CLEAR_SKY: DayKeys<{ gain: number }> = tuneKeys( 'sky.clear', {
	day: [ CLEAR_SKY_HORIZON, { at: 3, name: 'golden', values: { gain: 2.7 } }, { at: 6, name: 'late', values: { gain: 3.8 } }, { at: 12, name: 'low', values: { gain: 5.1 } }, CLEAR_SKY_HIGH ],
	rising: [ CLEAR_SKY_HORIZON, { at: 3, name: 'dawn', values: { gain: 2.0 } }, { at: 6, name: 'early', values: { gain: 4.6 } }, { at: 12, name: 'morning', values: { gain: 6.6 } }, CLEAR_SKY_HIGH ],
	night: { gain: 1 },
}, { gain: { min: 0.25, max: 8, scale: 'log', onChange: markSkyRetune } } );
const _clearSky = { gain: 1 };
// CLEAR_SKY's gain at `elevation` under a sky of clouded share `cloud`: exactly 1 with the sun at or
// under the horizon and under a cloudy or overcast sky (`flags=clearSky:false` leaves it 1, for A/Bs)
function clearSky( elevation: number, rising: boolean, cloud: number ): number {

	if ( debugFlags.clearSky === false ) return 1;
	const day = keyed( CLEAR_SKY, elevation, 0, _clearSky, 0, rising ).gain;
	return 1 + ( day - 1 ) * ( 1 - cloud );

}
// per kept sky, the share of the deck's optical depth its shadow is cast with (Weather.ts
// `shadowDensity`, its preset's until tuned), blended by the weather's shares of the kept skies;
// tunable on debug pages: `sky.weather.shadowDensity@<cloudy|overcast>`
const SHADOW_DENSITY = KEPT_SKIES.map( ( name ) => ( { shadowDensity: WEATHER_PRESETS[ name ].shadowDensity } ) );
for ( const [ s, name ] of [ [ 2, 'cloudy' ], [ 3, 'overcast' ] ] as const ) {

	tuneObject( SHADOW_DENSITY[ s ], { shadowDensity: `sky.weather.shadowDensity@${ name }` }, { shadowDensity: { min: 0.02, max: 1, scale: 'log', onChange: markSkyRetune } } );

}
// per kept sky, the cloud shell's base and top (m), blended by the weather's shares of the kept
// skies (Clouds.ts `setDeck`): clear's and fair's cumulus stand high, cloudy's and overcast's deck
// low and shallow, as a stratocumulus deck stands, its masses nearer and so larger in the sky; a
// front between the two crosses both the shell and the noise's space by the shares. The parked
// weathers count as overcast in those shares (Weather.ts), so they take overcast's deck. Tunable on
// debug pages: `sky.clouds.base@<cloudy|overcast>`, `sky.clouds.top@<cloudy|overcast>`.
const CLOUD_SHELL = KEPT_SKIES.map( ( name ) => name === 'cloudy' ? { base: 900, top: 3200 } : name === 'overcast' ? { base: 600, top: 3000 } : { base: SHELL_BOTTOM, top: SHELL_BOTTOM + SHELL_THICKNESS } );
for ( const [ s, name ] of [ [ 2, 'cloudy' ], [ 3, 'overcast' ] ] as const ) {

	tuneObject( CLOUD_SHELL[ s ], { base: `sky.clouds.base@${ name }`, top: `sky.clouds.top@${ name }` }, { base: { min: 300, max: 2000, onChange: markSkyRetune }, top: { min: 1500, max: 6000, onChange: markSkyRetune } } );

}
/** The cloud shell's base (m) under the kept sky `s` (Weather.ts KEPT_SKIES), as tuned: the haze's
 * aerosol ends at a deck's base (weather/HazeKeys.ts `aerosolTop`). */
export const cloudBase = ( s: number ): number => CLOUD_SHELL[ s ].base;
// per kept sky, the cloud's form (Clouds.ts CLOUD_FORM, `setForm`): its soft margin, its
// erosion's strength at the top (a share of the high cumulus'), the height over which its base
// needs richer weather, its lanes and its base's masses, blended by the weather's shares like the
// shell. Clear and fair keep the high cumulus' form. The base's height from 0.1 to 0.3 of the shell
// moves the overcast masses' height on screen from 1.6 to 1.2 degrees (lower as it grows) and their
// edges little. Seen from 50-90 m up, through the clouded skies' own air (weather/HazeKeys.ts), the
// deck's form shows: overcast's lanes keep a tenth or less of the density (0.08: the lanes'
// optical depth about 1-3 under rolls of 15-30, a lane's column light about 3.5-4 times a roll's),
// split at the lanes' field's p20, so a fifth of the deck stands thinned in regions of kilometres;
// overcast's base rises between its masses by 0.4 of the column (Clouds.ts MASS_LOW), which from
// 90 m over six cloud times puts the visible base (the march's opacity-weighted depth) at 0.88 km
// at 20-30 degrees and 0.92 km at 30-45 (medians; p90 1.1-1.16 km) from the shell's 600 m, its
// masses about 5.3 by 1.8 degrees in the 20-30 degree band (the luminance's correlation widths)
// and some 330 m in plan at the base (the correlation's half distance); a share of 0.45 tore dark
// specks into the thinnest columns. Cloudy's margin is 2.6 times the cumulus' (0.25) and lies
// three quarters inside its columns (`inside` 0.5): spread either side of a column's top, as the
// cumulus' is, a margin wide enough to soften the broken cloud's edges filled its gaps with thin
// cloud (at 0.25 the luminance's spread 0.10-0.12), and at 0.15 the gaps 3 - 25 degrees up from
// 50 m were a fifth of a percent of the sky, the rest thin cloud over them. Moved inward, the gaps
// open and the columns thin, and the land under them takes more of the sun: wholly inside (1),
// from 50 m toward the horizon 3 - 25 degrees up 15 % of the sky was clear (transmittance over
// 0.9) and a quarter thick cloud (under 0.1), the edges about 1.4 - 2.2 degrees wide (the step's
// contrast over the gradient's p99 and p95), but under a sun of 30 - 50 degrees the meadow rose
// to 0.46 - 0.48 in Oklab L and the cliff's face to 0.63 - 0.76, from 0.33 - 0.34 and 0.52 - 0.55
// with the margin either side; three quarters inside (0.75), 0.39 - 0.41 and 0.61 - 0.67. Half
// inside, the meadow keeps 0.35 - 0.37 and the face 0.58 - 0.61, and the thin cloud reads as the
// gaps: 1.4 % of the sky clear and 60 % thick cloud, the luminance's spread over the sky 0.16 -
// 0.22 under a sun of 20 - 50 degrees (0.12 - 0.14 with the margin either side), the edges about
// 0.9 - 1.7 degrees, the lit cloud and the clear sky 2.8 times apart in scene radiance. Tunable
// on debug pages:
// `sky.clouds.edge|erosion|baseEnd|lanes|laneSplit|laneSoftness|baseLift|inside@<cloudy|overcast>`.
const CLOUD_FORM_BY_SKY = KEPT_SKIES.map( ( name ) => name === 'overcast' ? { ...CLOUD_FORM, lanes: 0.08, baseLift: 0.4 } : name === 'cloudy' ? { ...CLOUD_FORM, edge: 0.25, inside: 0.5 } : { ...CLOUD_FORM } );
for ( const [ s, name ] of [ [ 2, 'cloudy' ], [ 3, 'overcast' ] ] as const ) {

	tuneObject( CLOUD_FORM_BY_SKY[ s ], { edge: `sky.clouds.edge@${ name }`, erosion: `sky.clouds.erosion@${ name }`, baseEnd: `sky.clouds.baseEnd@${ name }`,
		lanes: `sky.clouds.lanes@${ name }`, laneSplit: `sky.clouds.laneSplit@${ name }`, laneSoftness: `sky.clouds.laneSoftness@${ name }`, baseLift: `sky.clouds.baseLift@${ name }`,
		inside: `sky.clouds.inside@${ name }` },
	{ edge: { min: 0.05, max: 0.4, onChange: markSkyRetune }, erosion: { min: 0.3, max: 1.2, onChange: markSkyRetune }, baseEnd: { min: 0.05, max: 0.4, onChange: markSkyRetune },
		lanes: { min: 0.02, max: 1, onChange: markSkyRetune }, laneSplit: { min: 0.2, max: 0.9, onChange: markSkyRetune }, laneSoftness: { min: 0.005, max: 0.2, onChange: markSkyRetune },
		baseLift: { min: 0, max: 0.8, onChange: markSkyRetune }, inside: { min: 0, max: 1, onChange: markSkyRetune } } );

}
const CIRRUS_SHARE = 0.75;

// The low sun's key. Through twenty air masses and more the atmosphere's transmittance (Atmosphere.ts,
// its aerosol dimming the low sun by about half at the golden hour) still leaves the key too bright
// under the lifted shading (lighting/KeyLift.ts): with the sun at 3 degrees the lit rock's whole face
// goes to a pale gold and the land reads as a bright afternoon. The key (the island's and the sea's
// sunlight) takes a gain under 6 degrees (degrees, descending; linear between rows, the last row
// held down to the horizon), so that face stays a saturated orange under the sky. The shade, lit by
// the sky, does not move; the disk and the sky's own sun are untouched.
const LOW_KEY: readonly { at: number; gain: number }[] = [
	{ at: 6, gain: 1 },
	{ at: 4, gain: 0.78 },
	{ at: 2.6, gain: 0.46 },
];

// a gain by the sun's elevation from rows of descending elevation: linear between rows, the end
// rows held beyond
function byElevation<K extends string>( rows: readonly ( { at: number } & Record<K, number> )[], elevation: number, key: K ): number {

	if ( elevation >= rows[ 0 ].at ) return rows[ 0 ][ key ];
	for ( let i = 1; i < rows.length; i ++ ) if ( elevation >= rows[ i ].at ) {

		const t = ( elevation - rows[ i ].at ) / ( rows[ i - 1 ].at - rows[ i ].at );
		return rows[ i ][ key ] + ( rows[ i - 1 ][ key ] - rows[ i ][ key ] ) * t;

	}
	return rows[ rows.length - 1 ][ key ];

}

// (`flags=skyGain:false` leaves the sky as the atmosphere gives it, `lowKey:false` the key as its
// transmittance gives it, for A/Bs)
const skyGain = ( elevation: number, rising: boolean, cloud: number, target: THREE.Color ) => {

	if ( debugFlags.skyGain === false ) return target.setScalar( 1 );
	const { r, g, b } = keyed( SKY_LIGHT, elevation, skyNight( elevation, rising, cloud ), _skyLight, cloud, rising );
	return target.setRGB( r, g, b ).multiplyScalar( clearSky( elevation, rising, cloud ) );

};
const _skyGain = new THREE.Color();
const cirrusGain = ( elevation: number, rising: boolean, cloud: number ) => ( debugFlags.skyGain === false ? 1 : luma( skyGain( elevation, rising, cloud, _skyGain ) ) * CIRRUS_SHARE ) * ( typeof debugFlags.cirrusSky === 'number' ? debugFlags.cirrusSky : 1 );
const lowKey = ( elevation: number ) => debugFlags.lowKey === false ? 1 : byElevation( LOW_KEY, elevation, 'gain' );

// A sky radiance or irradiance as lent to the island (ISLAND_SKY): drawn toward `tint.rgb` at its
// own luminance by `tint.w`, times `gain`. Linear in the light, so the graded probe's integral is
// the integral of the graded panorama.
// The finite wave grid ends before the geometric horizon. Continue it with the reflection
// of a flat distant sea, approaching unit Fresnel at the horizon without a dark colour step.
const seaPanorama = Fn( ( [ d, clearSky, sea ]: [ V3, V3, V3 ] ) => {

	const c = clamp( abs( d.y ), 0, 1 ).toVar();
	const g = sqrt( c.mul( c ).add( 1.333 * 1.333 - 1 ) ).toVar();
	const a = g.sub( c ).div( g.add( c ) );
	const b = c.mul( g.add( c ) ).sub( 1 ).div( c.mul( g.sub( c ) ).add( 1 ) );
	const fr = a.mul( a ).mul( b.mul( b ).add( 1 ) ).mul( 0.5 );
	return mix( sea, clearSky, select( d.y.greaterThanEqual( 0 ), 1, fr ) );

} ).setLayout( { name: 'skySeaPanorama', type: 'vec3', inputs: [
	{ name: 'd', type: 'vec3' }, { name: 'clearSky', type: 'vec3' }, { name: 'sea', type: 'vec3' },
] } );

const lendIsland = Fn( ( [ light, tint, gain ]: [ V3, V4, F ] ) => {

	return mix( light, tint.rgb.mul( dot( light, vec3( 0.2126, 0.7152, 0.0722 ) ) ), tint.w ).mul( gain );

} ).setLayout( { name: 'lendIsland', type: 'vec3', inputs: [ { name: 'light', type: 'vec3' }, { name: 'tint', type: 'vec4' }, { name: 'gain', type: 'float' } ] } );

// Art direction: within a few degrees of the horizon the sun shines through twenty to forty air
// masses and its light turns an almost pure red (red/blue above 100 at one degree), which paints
// the island like lava. The optical depth that sets the key's hue is capped softly past about
// six degrees (`sky.key.hueDepth`), while its luminance keeps the full extinction: a low sun stays
// orange red (red/green about 1.85 at six degrees, 2.2 at the golden hour and 2.25 at the horizon,
// red/blue at most about 13) and still dims as it sets. The cap stands where it holds the golden
// hour's sunlit faces at a full orange without the extra chroma the clean air aloft gives the key
// (Atmosphere.ts). The rising sun's cap is lower (`sky.key.dawnHueDepth`, binding from about ten
// degrees down): the morning's warm colour lies in the sun's road and the low streaks, and a face
// turned to the rising sun takes a pale warm light, far less orange than the evening's at the same
// height (red/green at most about 1.6, red/blue about 4). Above that the key's hue is
// chosen rather than the air's own course, which reddens evenly with the air mass: a warm
// white while the sun is high (KEY_WHITE: red/green 1.15, blue/green 0.95 at noon, 1.17 and 0.9
// at 30 degrees) that loses its blue first (0.8 at 20 degrees, red/green 1.2) and turns orange
// between 15 and 10 degrees (1.45 and 0.55 at 11.5). So each of the two ratios takes the air's
// change of it in part, by the air's depth in green (`sky.key.reddens` for red/green, `.yellows` for
// blue/green: about none at noon, two thirds at that depth, all of it past twice it). The ozone's
// absorption integrated over each channel's band (Atmosphere.ts) takes red off the air's
// transmittance (red/green 1.45 to 1.29 at 12 degrees), so the red/green share's onset is 0.52
// where it was 0.75, which brings the key back to about 1.45 at 12 degrees (0.75 left it at 1.29,
// a lit face yellow green) and leaves the lower sun a little less red than before. The sky and
// clouds keep their own colours, and the key's luminance is the sun tint's.
const sunHueDepth = tune( 'sky.key.hueDepth', 1.6, { min: 1, max: 4, onChange: markSkyRetune } );
const dawnHueDepth = tune( 'sky.key.dawnHueDepth', 0.8, { min: 0.3, max: 4, onChange: markSkyRetune } );
// the key's white: linear red/green and blue/green while the sun is high
const KEY_WHITE = [ 1.15, 0.96 ] as const;
const keyReddens = tune( 'sky.key.reddens', 0.52, { min: 0.3, max: 1.5, onChange: markSkyRetune } );
const keyYellows = tune( 'sky.key.yellows', 0.52, { min: 0.2, max: 1.2, onChange: markSkyRetune } );
// The low sun's lift of the clouds' beam and fill (trackClouds), fading as the sky closes.
const lowSunOf = ( elevation: number, coverage: number ) => THREE.MathUtils.smoothstep( elevation, - 4, 1 )
	* ( 1 - THREE.MathUtils.smoothstep( elevation, 6, 20 ) ) * ( 1 - THREE.MathUtils.smoothstep( coverage, 0.35, 0.65 ) );
const luma = ( c: THREE.Color ) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
// The key's colour per unit of the sun's illuminance, into `transmittance`: its hue KEY_WHITE
// with the share of the air's change in each ratio its depth gives (the depth capped), its
// luminance the air's full extinction of `tint`.
function keyHue( transmittance: THREE.Color, tint: THREE.Color, rising: boolean ): THREE.Color {

	const { r, g, b } = transmittance;
	if ( g <= 0 ) return transmittance.setRGB( 0, 0, 0 );
	const depth = - Math.log( g );
	const scale = 1 / Math.pow( 1 + Math.pow( depth / ( rising ? dawnHueDepth() : sunHueDepth() ), 6 ), 1 / 6 );
	const share = ( onset: number ) => scale * ( 1 - Math.exp( - Math.pow( depth / onset, 2.5 ) ) );
	const before = luma( transmittance.clone().multiply( tint ) );
	transmittance.setRGB( KEY_WHITE[ 0 ] * Math.pow( r / g, share( keyReddens() ) ), 1, KEY_WHITE[ 1 ] * Math.pow( b / g, share( keyYellows() ) ) );
	return transmittance.multiplyScalar( before / luma( transmittance ) );

}

const NEUTRAL_TINT = new THREE.Vector4( 1, 1, 1, 0 );
const _white = new THREE.Color();
// The sun's elevations (degrees) over which the moon comes into the clouds' light, in full below the
// first: the night sky's ramp, later than the moon's key (DayCycle MOON_KEY_TOP).
const CLOUD_MOON = [ - 7, - 3 ] as const;
// The sun's elevations (degrees) over which the light the clouds march toward sets from the moon's
// key to the sun's height, then comes round to the sun's azimuth: after the moon's light on them has
// gone (CLOUD_MOON) and before the sun's reaches them (`sunlightAt` at 2 km, above about -2).
const CLOUD_TURN = [ - 3, - 2.5, - 2 ] as const;
// The sine of the sun's elevation over which the clouds' shadow comes in as it rises.
const CLOUD_SHADOW_SET = [ - 0.02, 0.02 ] as const;
// The height over a low deck's base (metres) the bake fogs its clouds out to, where a closed deck's
// march gathers most of its light (the dome reads the march's own depth: `domeColour`).
const DECK_LIGHT_HEIGHT = 150;
// The sine of the key's elevation over which the rays of the clouds' shadow gather from the height
// of its disc to its centre as it climbs, from 8 to 11 degrees: from there up a cloud's own edge
// takes longer to pass than the disc does (near 0.8 degree at 10 degrees, 0.15 at 4.7). The rays
// are as many as keep the disc from stepping: four, 0.135 degree apart, stepped the light by a
// quarter of the sun; these are 0.045 degree apart.
// Twelve cost about one percent of the frame's GPU time at their dearest, an overcast sky near
// 11 degrees, and only from about 4.3 to 11 degrees: under that the rays are one ray.
const SHADOW_DISC = [ 0.139, 0.191 ] as const;
const SHADOW_DISC_RAYS = 12;
// The key's elevations (degrees) over which the channel of the clouds' shadow the air reads narrows
// from the whole disc to its two centre rays, a function of the elevation alone. At 6 degrees the
// whole disc leaves the haze no shaft. Under the fade's foot the channel must be the whole disc:
// the sky's dome meters the air's light, and as a gap in the deck left the sun near 4.7 degrees the
// two rays stepped the exposure toward the sun by half a stop per 0.02 degree, the whole disc by a
// seventh of one. Over the fade the band of haze steps less than one ray's does; in a front at 8 degrees
// the air steps up to a third more than under the whole disc, under half a level in 255.
const SHADOW_AIR_NARROW = [ 4.9, 5.6 ] as const;
// The key's elevations (degrees) over which the light march comes to see the low deck's lifted base
// (Clouds.ts `keyLift`): its taps climb the shell's depth times the key's sine, under overcast's
// 2.4 km about 130 m at 3 degrees and 420 m at 10, where the base rises some 300-500 m between the
// masses (CLOUD_FORM_BY_SKY). Under the first they stay in the gaps under the deck; past the second
// they climb into it.
const KEY_LIFT = [ 3, 10 ] as const;

// The moon's key, a share of the sun's illuminance per channel: cool blue (red over green 0.8, blue
// over green 1.4). Its level is the moonlit ground's relation to the night's other light; how bright
// the night shows is the exposure's night key (post/Exposure.ts).
// The moonlit sky, clouds and haze keep this colour (`moonIlluminance`): there it is the sky's night
// gain's and the haze's own to colour. The island's moonlight takes its level and a hue of its own
// (`moonHue`).
const MOON_KEY = [ 0.0108, 0.0135, 0.0189 ] as const;
// MOON_KEY's red and blue over green, as written (the quotients of its channels differ by an ulp),
// so the default hue below is exactly one, and its Rec. 709 luminance, the level the hue keeps
const MOON_KEY_RED = 0.8, MOON_KEY_BLUE = 1.4;
const luminance709 = ( r: number, g: number, b: number ) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const MOON_KEY_LUMINANCE = luminance709( MOON_KEY[ 0 ], MOON_KEY[ 1 ], MOON_KEY[ 2 ] );
// a gain on the moon's key light (keyColor: the land, the sea's glitter, the haze's scatter of the
// key), the moonlit sky and clouds keeping MOON_KEY under the sky's night gain: the
// moonlit ground takes several times the night sky's light on open ground, while the sky keeps
// its moon glow. It is the island's moonlight's level; `moonHue` its colour.
const moonKeyGain = tune( 'lighting.moon.gain', 0.545, { min: 0.05, max: 4, scale: 'log' } );
// The island's moonlight's red and blue over green. They move the moonlit ground's colour without
// its level (the hue keeps MOON_KEY's luminance) and without the moonlit sky's, clouds' and haze's,
// which keep MOON_KEY. At MOON_KEY's own (MOON_KEY_RED, MOON_KEY_BLUE) the hue is exactly white.
// Through the night's white balance these leave moonlit rock a cool grey, the island's brightest
// thing, with no more chroma than the sky over it, and the meadow nearly black.
const moonKeyRed = tune( 'lighting.moon.red', 1, { min: 0.3, max: 1.2 } );
const moonKeyBlue = tune( 'lighting.moon.blue', 1.6, { min: 0.8, max: 4 } );
const _moonKey = new THREE.Color();
const _moonHue = new THREE.Color();

/** The factor per channel that turns MOON_KEY into the tuned hue at MOON_KEY's luminance. */
function moonHue( target: THREE.Color ): THREE.Color {

	const r = moonKeyRed() / MOON_KEY_RED, b = moonKeyBlue() / MOON_KEY_BLUE;
	const level = MOON_KEY_LUMINANCE / luminance709( MOON_KEY[ 0 ] * r, MOON_KEY[ 1 ], MOON_KEY[ 2 ] * b );
	return target.setRGB( r * level, level, b * level );

}
const _moonTurn = new THREE.Quaternion();
const _keyTurn = new THREE.Quaternion(), _keyStep = new THREE.Quaternion(), _noTurn = new THREE.Quaternion(), _keyTo = new THREE.Vector3();

export class Sky {

	renderer: THREE.WebGPURenderer;
	atmosphere: Atmosphere;
	clouds: Clouds;
	night = new NightSky();
	lightning = new Lightning();
	sunIlluminance: number;
	// the moon's key light (MOON_KEY), before the sky's night gain
	private readonly moonKeyColor = new THREE.Color();
	// where the moon is drawn and lights the sky from, and where its disk's phase is lit from
	// (`track`)
	private readonly drawnMoonDir = new THREE.Vector3( 0, - 1, 0 );
	private readonly drawnMoonSunDir = new THREE.Vector3( 0, 1, 0 );
	elevation: number;
	azimuth: number;
	// whether the sun climbs, from where `sunDir` stands on its path (DayCycle.ts `sunRising`): what
	// tells the morning's keys from the evening's at one height
	rising = false;
	// A shared artistic solar tint affects both scattering and direct light.
	sunTint = new THREE.Color( 1.0, 0.97, 0.9 );
	sunDir = new THREE.Vector3();
	sunColor = new THREE.Color(); // irradiance at sea level
	// the key's direction: the sun's by day, by night the moon's where it is drawn, turning between
	// them over the handoff (`track`)
	keyDir = new THREE.Vector3();
	keyColor = new THREE.Color();
	// Whether the key is the moon (its light has come in: DayCycle `moonKeyGain`), which the
	// surfaces take from one fixed direction all night (lighting/KeyLift.ts).
	keyIsMoon = false;
	// The key light's colour before cloud and weather attenuation: what lights the cloud tops.
	keyColorAboveClouds = new THREE.Color();
	// The moon's share of the key before cloud and weather attenuation (the island's moonlight, at
	// its level and hue), which a low deck's column passes down to its base (trackClouds).
	private readonly moonKeyAbove = new THREE.Color();
	// The viewer the cloud map is computed for; clouds are far, so only small moves matter.
	viewer = new THREE.Vector3( 0, 15, 0 );
	private viewCamera: THREE.PerspectiveCamera | null = null;
	private viewWidth = 1;
	private viewHeight = 1;
	private cloudTime = 0;
	solarIlluminance = new THREE.Color();
	readonly grade = { exposure: DAY_EXPOSURE, daylight: 1, night: 0 };
	readonly weather: DisplayedWeather = { haze: 0, rain: 0, fog: 0, windSpeed: 3.8, windDirection: 40 };
	// E / PI over the upper hemisphere, cross-faded between the bakes as the irradiance probe is:
	// each bake's own, read back (an explicit bake's before it shows, a periodic one's a frame or
	// two after its panoramas, while its environment is still being filtered: `readIrradiance`).
	skyIrradiance = new THREE.Color();
	seaColor = new THREE.Color( 0.0045, 0.0125, 0.0140 );
	equirect: THREE.RenderTarget;
	small: THREE.RenderTarget;
	envMap: THREE.RenderTarget | null = null;
	dome: THREE.Mesh;
	lastBakeMs = 0;
	readonly irradianceNode: V3;
	// log2 of the sky's geometric-mean luminance L_geo (scene units): exp( mean ln Y ) over the upper
	// hemisphere of the probe's panorama by solid angle, reduced with the irradiance once per bake and
	// cross-faded with it. The dome's metering illuminance and the exposure's sky term (shared.ts
	// `skyMeterLog2`).
	readonly meterLog2Node: THREE.Node<'float'>;
	// The irradiance probe as lent to the island after sunset (ISLAND_SKY): the islanders' sky fill.
	readonly islandIrradianceNode: V3;
	// The cloudless sky's irradiance over pi (the clear sky the atmosphere gives, with the night's
	// moonlit sky, under no clouds and none of the weather's dimming), baked and cross-faded with
	// irradianceNode: the haze's sky light, which the weather scales instead (weather/HazeKeys.ts).
	readonly clearIrradianceNode: V3;
	// The sky's irradiance over pi with its clouds but without the haze over it (the clear sky in the
	// gaps times their transmittance, plus the clouds' own light, at the weather's ambient gain),
	// baked and cross-faded with irradianceNode: under a deck, the deck's mean base radiance, which
	// lights the air under it (VolumetricHaze.ts `scatterToward`). `bakeDeckIrradianceNode` is the
	// bake's own, for the haze the bake lays over its panoramas (VolumetricHaze.ts `openSky`).
	readonly deckIrradianceNode: V3;
	readonly bakeDeckIrradianceNode: V3;
	busy = false;
	/** Called after each bake renders the environment's source panorama (the starlit, island-lit
	 * radiance without the sun's disk), with the atlases it will be filtered into: both on a first
	 * bake, the one not shown on a bake that refreshes the environment, none otherwise. An atlas
	 * written is at weight 0 in the cross-fade until the bake publishes. For the ambient light's
	 * relight (lighting/AmbientRelight.ts), which keeps its own copy of each atlas's sky. */
	onEnvironmentSource: ( ( source: THREE.Texture, atlases: readonly number[] ) => void ) | null = null;

	private endpoints = [ makeEndpoint(), makeEndpoint() ];
	// The environment's PMREM atlases: the one shown (environmentFront) and the next one.
	private environments: [ THREE.RenderTarget | null, THREE.RenderTarget | null ] = [ null, null ];
	private environmentFront = 0;
	// The atlases the displayed environment cross-fades from and to (by `blend`), as published.
	private environmentPair: [ number, number ] = [ 0, 0 ];
	// The environment refreshes on every environmentEvery-th periodic bake (setEnvironmentCadence).
	private environmentEvery = 1;
	private bakesSinceEnvironment = 0;
	// A periodic bake spread over frames: its remaining steps, and the promise to settle.
	private slices: Slice[] = [];
	private sliceDone: { resolve: () => void; reject: ( error: unknown ) => void } | null = null;
	private sliceTimer: ReturnType<typeof setTimeout> | null = null;
	private sliceMs = 0;
	// The scene clock did not advance over the last cloud update: a paused scene does its bakes whole.
	private clockStill = false;
	private readonly displaySize = new THREE.Vector2();
	private front = 0;
	private destination = 0;
	private initialized = false;
	private celestial: DayCycleSnapshot | null = null;
	private weatherState: WeatherState | null = null;
	private pendingUpdate: Promise<void> | null = null;
	// The warm-up's compiles (`warm`), which every bake waits for; a failed warm-up resolves here
	// too (its caller reports it), so bakes still run.
	private warmed: Promise<void> = Promise.resolve();
	private transitionDuration = 0;
	private transitionElapsed = 0;
	private blend = uniform( 0 );
	private panoramaA: THREE.TextureNode;
	private panoramaB: THREE.TextureNode;
	private environmentA: THREE.TextureNode | null = null;
	private environmentB: THREE.TextureNode | null = null;
	private environment: V3 | null = null;
	private environmentBlendQuad: THREE.QuadMesh | null = null;
	private irradianceQuad: THREE.QuadMesh;
	private irradianceBlendQuad: THREE.QuadMesh;
	private irradianceDisplay = new THREE.RenderTarget( 1, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter } );
	private irradianceA: THREE.TextureNode;
	private irradianceB: THREE.TextureNode;
	private clearIrradianceQuad: THREE.QuadMesh;
	private clearIrradianceBlendQuad: THREE.QuadMesh;
	private clearIrradianceDisplay = new THREE.RenderTarget( 1, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter } );
	private clearIrradianceA: THREE.TextureNode;
	private clearIrradianceB: THREE.TextureNode;
	private deckIrradianceQuad: THREE.QuadMesh;
	private deckIrradianceBlendQuad: THREE.QuadMesh;
	private deckIrradianceDisplay = new THREE.RenderTarget( 1, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter } );
	private deckIrradianceA: THREE.TextureNode;
	private deckIrradianceB: THREE.TextureNode;
	private bakeDeckIrradiance: THREE.TextureNode;
	private bakeVersion = 0;
	// periodic bakes whose irradiance readback is still in flight (`readIrradiance`; `readbacks`)
	private irradiancePending = 0;
	private displaySunDir = uniform( new THREE.Vector3( 0, 1, 0 ) );
	// The sky's constants texel (Pipeline.ts `skyConstants`): the mean cloud transmittance over the
	// sun's disc (r) and the moon's (g), from `discCloudTransmittance`. The pipeline points it at
	// the frame graph's texel before the first frame.
	readonly discCloudTexture = texture( new THREE.DataTexture( new Float32Array( [ 1, 1, 1, 1 ] ), 1, 1, THREE.RGBAFormat, THREE.FloatType ) );
	private displaySolarIlluminance = uniform( new THREE.Color( 0, 0, 0 ) );
	// Live clear-sky terms for the dome; the bake keeps its own copies below.
	private displayNightAmbient = uniform( new THREE.Color( 0, 0, 0 ) );
	private displayAmbientGain = uniform( 1 );
	// the weather's cloud shadow floor and cast shadow on the island (Weather.ts `cloudFloor`, `castShadow`)
	private keyCloudFloor = uniform( 0 );
	readonly castShadow = uniform( 1 );
	private cloudLayer: THREE.TextureNode;
	private pmrem: THREE.PMREMGenerator;
	private quad: THREE.QuadMesh;
	private reflectionSource: THREE.RenderTarget;
	private upperQuad: THREE.QuadMesh;
	private sea = uniform( new THREE.Color() );
	private ambientGain = uniform( 1 );
	private irradiancePass = uniform( 0 );
	private includeStars = uniform( 0 );
	// The night sky's own light at this frame's exposure (DayCycleSnapshot.nightSkyLevel).
	private nightSkyLevel = 1;
	private bakeStarVisibility = uniform( 0 );
	// The light the sky lends the island for this frame's sun (ISLAND_SKY: the tint and its amount,
	// the gain), and the bake's copies: the island's for the environment's source, neutral for the
	// other panoramas.
	private islandTint = uniform( new THREE.Vector4( 1, 1, 1, 0 ) );
	private islandGain = uniform( 1 );
	private bakeIslandTint = uniform( new THREE.Vector4( 1, 1, 1, 0 ) );
	private bakeIslandGain = uniform( 1 );
	// 1 while the bake draws the environment's source or the probe's panorama, which take the haze
	// all round (`fogEnvironment`); the seen panorama takes it above the horizon only, as the dome
	// fogs what it shows of it under the horizon itself
	private bakeHaze = uniform( 0 );
	private starFootprint = uniform( 1 );

	constructor( renderer: THREE.WebGPURenderer, { sunIlluminance = SUN_ILLUMINANCE, elevation = 32, azimuth = - 8 } = {} ) {

		this.renderer = renderer;
		this.sunIlluminance = sunIlluminance;
		this.elevation = elevation;
		this.azimuth = azimuth;
		this.atmosphere = new Atmosphere( renderer );
		this.equirect = this.endpoints[ 0 ].equirect;
		this.clouds = new Clouds( this.atmosphere );
		this.cloudLayer = texture( this.endpoints[ 0 ].clouds.texture );
		// Only the environment source contains filtered stars. The displayed panoramas stay
		// star-free so the dome and water can evaluate sharp/rough stars without double counting.
		this.reflectionSource = this.equirect.clone();
		this.reflectionSource.texture.name = 'skyStarlitEnvironment';
		this.panoramaA = texture( this.equirect.texture );
		this.panoramaB = texture( this.equirect.texture );
		this.small = new THREE.RenderTarget( 64, 32, { type: THREE.FloatType, depthBuffer: false } );
		this.irradianceA = texture( this.endpoints[ 0 ].irradianceMap.texture );
		this.irradianceB = texture( this.endpoints[ 1 ].irradianceMap.texture );
		const irradianceBlendMat = new THREE.NodeMaterial();
		irradianceBlendMat.depthTest = false;
		irradianceBlendMat.depthWrite = false;
		irradianceBlendMat.toneMapped = false;
		irradianceBlendMat.fragmentNode = mix( textureLoad( this.irradianceA, ivec2( 0 ) ),
			textureLoad( this.irradianceB, ivec2( 0 ) ), this.blend );
		this.irradianceBlendQuad = new THREE.QuadMesh( irradianceBlendMat );
		const irradiance = textureLoad( texture( this.irradianceDisplay.texture ), ivec2( 0 ) );
		this.irradianceNode = irradiance.rgb;
		this.meterLog2Node = irradiance.a;
		this.islandIrradianceNode = lendIsland( this.irradianceNode, this.islandTint, this.islandGain );
		this.clearIrradianceA = texture( this.endpoints[ 0 ].clearIrradianceMap.texture );
		this.clearIrradianceB = texture( this.endpoints[ 1 ].clearIrradianceMap.texture );
		const clearBlendMat = new THREE.NodeMaterial();
		clearBlendMat.depthTest = false;
		clearBlendMat.depthWrite = false;
		clearBlendMat.toneMapped = false;
		clearBlendMat.fragmentNode = mix( textureLoad( this.clearIrradianceA, ivec2( 0 ) ),
			textureLoad( this.clearIrradianceB, ivec2( 0 ) ), this.blend );
		this.clearIrradianceBlendQuad = new THREE.QuadMesh( clearBlendMat );
		this.clearIrradianceNode = textureLoad( texture( this.clearIrradianceDisplay.texture ), ivec2( 0 ) ).rgb;
		this.deckIrradianceA = texture( this.endpoints[ 0 ].deckIrradianceMap.texture );
		this.deckIrradianceB = texture( this.endpoints[ 1 ].deckIrradianceMap.texture );
		const deckBlendMat = new THREE.NodeMaterial();
		deckBlendMat.depthTest = false;
		deckBlendMat.depthWrite = false;
		deckBlendMat.toneMapped = false;
		deckBlendMat.fragmentNode = mix( textureLoad( this.deckIrradianceA, ivec2( 0 ) ),
			textureLoad( this.deckIrradianceB, ivec2( 0 ) ), this.blend );
		this.deckIrradianceBlendQuad = new THREE.QuadMesh( deckBlendMat );
		this.deckIrradianceNode = textureLoad( texture( this.deckIrradianceDisplay.texture ), ivec2( 0 ) ).rgb;
		this.bakeDeckIrradiance = texture( this.endpoints[ 0 ].deckIrradianceMap.texture );
		this.bakeDeckIrradianceNode = textureLoad( this.bakeDeckIrradiance, ivec2( 0 ) ).rgb;
		const irradianceMat = new THREE.NodeMaterial();
		irradianceMat.depthTest = false;
		irradianceMat.depthWrite = false;
		irradianceMat.toneMapped = false;
		const smallTexture = texture( this.small.texture );
		irradianceMat.fragmentNode = Fn( () => {

			const sum = vec3( 0 ).toVar();
			const logSum = float( 0 ).toVar(), area = float( 0 ).toVar();
			// The panorama stores sin(latitude) in alpha. Integrate the same cosine-weighted
			// upper hemisphere as the CPU probe, without an orientation-dependent row shortcut.
			Loop( this.small.width * this.small.height, ( { i } ) => {

				const pixel = textureLoad( smallTexture, ivec2( i.mod( this.small.width ), i.div( this.small.width ) ) ).toVar();
				const mu = max( pixel.a, 0 ).toVar();
				const cell = sqrt( max( float( 1 ).sub( mu.mul( mu ) ), 0 ) ).toVar();
				const weight = mu.mul( cell ).mul( 2 * Math.PI / ( this.small.width * this.small.height ) );
				sum.addAssign( pixel.rgb.mul( weight ) );
				// the geometric mean's log luminance, by solid angle (a texel's is cos(latitude)),
				// over the upper hemisphere only
				const open = select( pixel.a.greaterThan( 0 ), cell, float( 0 ) );
				logSum.addAssign( log2( max( dot( pixel.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ), METER_FLOOR ) ).mul( open ) );
				area.addAssign( open );

			} );
			// (alpha: log2 of the sky's geometric-mean luminance, so the endpoints' cross-fade blends
			// it geometrically: `meterLog2Node`)
			return vec4( sum, logSum.div( max( area, 1e-6 ) ) );

		} )();
		this.irradianceQuad = new THREE.QuadMesh( irradianceMat );
		// The cloudless sky's irradiance: the clear sky integrated over the upper hemisphere directly
		// (32 x 16 directions, cosine-weighted, the same E / pi as the probe's), once per bake.
		const clearIrradianceMat = new THREE.NodeMaterial();
		clearIrradianceMat.depthTest = false;
		clearIrradianceMat.depthWrite = false;
		clearIrradianceMat.toneMapped = false;
		clearIrradianceMat.fragmentNode = Fn( () => {

			const sum = vec3( 0 ).toVar();
			Loop( 32 * 16, ( { i } ) => {

				const lon = float( i.mod( 32 ) ).add( 0.5 ).mul( 2 * Math.PI / 32 ).toVar();
				const lat = float( i.div( 32 ) ).add( 0.5 ).mul( 0.5 * Math.PI / 16 ).toVar();
				const d = vec3( cos( lat ).mul( cos( lon ) ), sin( lat ), cos( lat ).mul( sin( lon ) ) ).toVar();
				const radiance = this.clearSky( d );
				// L cos(theta) d(omega) / pi, d(omega) = cos(lat) d(lat) d(lon)
				sum.addAssign( radiance.mul( sin( lat ).mul( cos( lat ) ) ).mul( ( 0.5 * Math.PI / 16 ) * ( 2 * Math.PI / 32 ) / Math.PI ) );

			} );
			return vec4( sum, 1 );

		} )();
		this.clearIrradianceQuad = new THREE.QuadMesh( clearIrradianceMat );
		// The sky's irradiance with its clouds and without the haze over it, over the same directions:
		// the cloud layer composed over the clear sky as the bake composes it (`bakeColour`), at the
		// weather's ambient gain, once per bake, before the panoramas (whose haze reads it).
		const deckIrradianceMat = new THREE.NodeMaterial();
		deckIrradianceMat.depthTest = false;
		deckIrradianceMat.depthWrite = false;
		deckIrradianceMat.toneMapped = false;
		deckIrradianceMat.fragmentNode = Fn( () => {

			const sum = vec3( 0 ).toVar();
			Loop( 32 * 16, ( { i } ) => {

				const lon = float( i.mod( 32 ) ).add( 0.5 ).mul( 2 * Math.PI / 32 ).toVar();
				const lat = float( i.div( 32 ) ).add( 0.5 ).mul( 0.5 * Math.PI / 16 ).toVar();
				const d = vec3( cos( lat ).mul( cos( lon ) ), sin( lat ), cos( lat ).mul( sin( lon ) ) ).toVar();
				const q = dirToEquirect( d ).toVar();
				const cloud = this.cloudLayer.sample( vec2( q.x, q.y.sub( 0.5 ).mul( 2 ) ) ).level( float( 0 ) ).toVar();
				const radiance = this.clearSky( d ).mul( cloud.a ).add( cloud.rgb );
				sum.addAssign( radiance.mul( sin( lat ).mul( cos( lat ) ) ).mul( ( 0.5 * Math.PI / 16 ) * ( 2 * Math.PI / 32 ) / Math.PI ) );

			} );
			return vec4( sum.mul( this.ambientGain ), 1 );

		} )();
		this.deckIrradianceQuad = new THREE.QuadMesh( deckIrradianceMat );
		this.pmrem = new THREE.PMREMGenerator( renderer );

		const upperMat = new THREE.NodeMaterial();
		// The reflection panorama's cloud layer: the live cloud map averaged over each of its
		// coarser texels. The lower panorama is the distant sea reflection, and the irradiance
		// probe reuses the same samples.
		upperMat.fragmentNode = Fn( () => {

			const texel = vec2( 1 / 512, 1 / 128 );
			const sum = vec4( 0 ).toVar();
			for ( const [ x, y ] of [ [ - 0.3, - 0.3 ], [ 0.3, - 0.3 ], [ - 0.3, 0.3 ], [ 0.3, 0.3 ] ] ) {

				const q = uv().add( texel.mul( vec2( x, y ) ) );
				sum.addAssign( this.clouds.sample( equirectToDir( vec2( q.x, clamp( q.y, 0, 1 ).mul( 0.5 ).add( 0.5 ) ) ) ) );

			}
			return sum.mul( 0.25 );

		} )();
		this.upperQuad = new THREE.QuadMesh( upperMat );

		const bake = new THREE.NodeMaterial();
		bake.fragmentNode = this.bakeColour();
		this.quad = new THREE.QuadMesh( bake );

		const domeMat = new THREE.MeshBasicNodeMaterial( { side: THREE.BackSide, depthWrite: false } );
		domeMat.colorNode = this.domeColour();
		// The exposure's metering illuminance on the sky's pixels (Motion.ts `meterOutput`): the sky's
		// geometric-mean luminance times METER_SKY, one value for the whole dome, so the meter reads a
		// sky-filled view by the sky's overall brightness and not by the sun's surroundings.
		const meter = exp2( this.meterLog2Node ).mul( METER_SKY );
		domeMat.mrtNode = meterOutput( meter );
		if ( FSR3 ) {

			// Under fsr3 the dome draws jittered like the rest of the scene, with its motion: FSR takes
			// every input pixel as a sample at its jittered position and reads the sky's motion from the
			// velocity alone. The dome follows the camera's position (onBeforeRender), so its previous
			// world matrix cancels the camera's translation and the motion is the view's rotation, the
			// sky's own.
			domeMat.mrtNode = meterOutput( meter, motionNode( 'sky' ) );

		} else if ( TEMPORAL ) {

			// Under the temporal modes the scene half renders jittered (Jitter.ts), but the dome does
			// not: each pixel keeps the direction it shows without the jitter, so a pure-sky pixel is
			// what an unjittered frame shows, and the clouds, which accumulate in their own history
			// (Clouds' view), are not accumulated a second time by the resolve. The projection is
			// three's own clip position (`cameraProjectionMatrix` times `positionView`) with the
			// unjittered matrix. Its velocity is written explicitly, no motion and class sky: the
			// resolve derives the sky's motion from the view's rotation, and the scene MRT would
			// otherwise overwrite the cleared value with an opaque surface's.
			domeMat.vertexNode = jitter.uniforms.unjitteredProjection.mul( positionView );
			domeMat.mrtNode = meterOutput( meter, vec4( 0, 0, MOTION_CLASS.sky, 0 ) );

		}
		this.dome = new THREE.Mesh( new THREE.SphereGeometry( 1000, 32, 16 ), domeMat );
		this.dome.frustumCulled = false;
		// Render behind the completed opaque depth so covered pixels skip the sky shader.
		this.dome.renderOrder = 1000;
		this.dome.onBeforeRender = ( _renderer, _scene, camera ) => {

			// Translation must not change the angular position of the sun or the horizon.
			this.dome.position.copy( camera.position );
			this.dome.updateMatrixWorld();

		};

	}

	/** The environment's source toward each texel of the panorama: the sky over the island, its
	 * clouds and their reflection in the distant sea, seen through `haze` when given (see
	 * `fogEnvironment`). */
	private bakeColour( haze?: SkyHaze ): V4 {

		return Fn( () => {

			const q = uv();
			const d = equirectToDir( q ).toVar();
			const cloud = this.cloudLayer.sample( vec2( q.x, abs( q.y.sub( 0.5 ) ).mul( 2 ) ) ).level( float( 0 ) ).toVar();
			const up = vec3( d.x, abs( d.y ), d.z );
			// (the environment's source takes the light lent to the island: ISLAND_SKY; the haze as the
			// dome lays it, from the sea's level: see `fogEnvironment`)
			const clear = this.clearSky( up ).toVar();
			const air = clear.mul( cloud.a ).add( cloud.rgb ).toVar();
			let fogged: V3 = air;
			if ( haze ) {

				// the clear sky through the haze along the whole way, the clouds through it out to the
				// shell's middle height (from the sea: the distance to that sphere, as the dome takes it),
				// under the low deck's share to a little above its base instead, where a deck's light comes
				// from (the dome takes the march's own depth there, which the panorama does not keep)
				const sky = haze( up );
				const middle = mix( this.clouds.shellBottom.add( this.clouds.shellThickness.mul( 0.5 ) ), this.clouds.shellBottom.add( DECK_LIGHT_HEIGHT ), this.clouds.lowShare ).toVar();
				const inside = middle.mul( middle.add( EARTH_RADIUS * 2 ) ), b = up.y.mul( EARTH_RADIUS );
				const cloudHaze = haze( up, inside.div( sqrt( b.mul( b ).add( inside ) ).add( b ) ) );
				const seen = sky.light.add( sky.transmittance.mul( clear ) ).mul( cloud.a )
					.add( cloudHaze.light.mul( float( 1 ).sub( cloud.a ) ) ).add( cloudHaze.transmittance.mul( cloud.rgb ) );
				// (the seen panorama only above the horizon, where the water reads it: what the sea
				// reflects is the sky the dome draws, and under cloud the haze's light is nearly all of
				// that; below the horizon the dome fogs it itself)
				fogged = mix( air, seen, max( this.bakeHaze, step( 0, d.y ) ) );

			}
			const sky = lendIsland( fogged.mul( this.ambientGain ), this.bakeIslandTint, this.bakeIslandGain );
			const stars = this.night.stars( up, this.starFootprint, this.bakeStarVisibility.mul( this.includeStars ) );
			const radiance = seaPanorama( d, sky.add( stars.mul( cloud.a ) ), this.sea.rgb );
			return vec4( radiance, mix( cloud.a, d.y, this.irradiancePass ) );

		} )();

	}

	/** Lays the haze over the environment's source, the irradiance probe's panorama and the seen
	 * panorama above the horizon as the dome lays it on itself (`fogDome`), toward every
	 * direction from one height (VolumetricHaze.ts `openSky`): the environment and the dome
	 * are one sky, its haze light included, so the ground's sky light (the irradiance probe, the
	 * relit ambient's SH) takes the light the haze scatters as the sky the eye sees does. Called
	 * once, with `fogDome`. */
	fogEnvironment( haze: SkyHaze ): void {

		const material = this.quad.material as THREE.NodeMaterial;
		material.fragmentNode = this.bakeColour( haze );
		material.needsUpdate = true;

	}

	/** The dome's colour toward each pixel, seen through `haze` when given: a function of a view
	 * direction and a distance along it (the sky's own by default) that returns the light the haze
	 * adds and its transmittance (VolumetricHaze.ts `skyHaze`). The clouds are fogged at the
	 * distance to the shell's middle height, under the low deck's share at the march's depth, the
	 * sky behind them along the whole way. */
	private domeColour( haze?: SkyHaze ): V4 {

		return Fn( () => {

			const d = normalize( positionWorld.sub( cameraPosition ) ).toVar();
			// The disc: cut where the cosine to the sun crosses the radius's, over one pixel's change
			// of that cosine (a clean edge at any size), darkened toward the limb by the quadratic law
			// (Radiometry.ts); the angle from the chord, which keeps its precision near the centre.
			const nu = dot( d, this.displaySunDir ).toVar();
			const mask = clamp( nu.sub( Math.cos( SUN_DISC_RADIUS ) ).div( max( fwidth( nu ), 1e-7 ) ), 0, 1 );
			const r = asin( clamp( length( d.sub( this.displaySunDir ) ).mul( 0.5 ), 0, 1 ) ).mul( 2 / SUN_DISC_RADIUS ).toVar();
			const m = float( 1 ).sub( sqrt( max( float( 1 ).sub( r.mul( r ) ), 0 ) ) ).toVar();
			const limb = float( 1 ).sub( m.mul( SUN_LIMB_U1 ) ).sub( m.mul( m ).mul( SUN_LIMB_U2 ) );
			// The integral of the visible disk is the key light's irradiance, times the displayed share
			// (lighting/SunDisc.ts SUN_DISC_RADIANCE). A shared scene unit
			// scale keeps the normalised disk finite in fp16 without dimming it independently. Its
			// colour is the air's analytic transmittance toward it (Atmosphere.ts discTransmittance).
			// The clouds dim it by their mean transmittance over the disc (`discCloudTransmittance`),
			// smoothly as an edge crosses it, and hide it by their opacity in the composite below.
			const discClouds = textureLoad( this.discCloudTexture, ivec2( 0 ) ).toVar();
			const disk = this.atmosphere.discTransmittance( d ).mul( this.displaySolarIlluminance ).mul( discClouds.r )
				.mul( mask ).mul( limb ).div( SUN_DISC_SOLID_ANGLE / SUN_DISC_RADIANCE ).mul( smoothstep( 0, 0.001, d.y ) );
			// Above the horizon the clear sky and the clouds are both live. Below, the baked distant-sea reflection continues the waves.
			const lower = this.samplePanorama( d, float( 0 ) ).toVar();
			const cloud = this.clouds.sampleView( d ).toVar();
			const above = d.y.greaterThanEqual( 0 ).toVar();
			const stars = this.night.stars( d ).mul( this.night.moonOcclusion( d ) );
			// What the clouds hide: the clear sky, the discs and the stars (below the horizon, the
			// reflection with its own clouds), seen through the haze along the whole way; the disc is
			// hidden by the clouds' opacity once, here.
			const behind = select( above, this.clearSky( vec3( d.x, max( d.y, 0 ), d.z ) ).mul( this.displayAmbientGain ), lower.rgb )
				.add( disk.add( this.night.moon( d ).mul( discClouds.g ) ).add( stars ).mul( select( above, float( 1 ), lower.a ) ) );
			const through = select( above, cloud.a, float( 1 ) ).toVar();
			const clouds = select( above, cloud.rgb.mul( this.displayAmbientGain ), vec3( 0 ) ).toVar();
			if ( ! haze ) return vec4( behind.mul( through ).add( clouds ), 1 );
			const sky = haze( d );
			// The clouds through the haze out to the shell's middle height: its light over their
			// opacity, their own (premultiplied) through its transmittance.
			// (from the march's own camera height, held under the base (Clouds `camY`): the depths
			// `sampleViewDepth` returns are measured from there, and above the middle the root's
			// argument would turn negative)
			const middle = this.clouds.shellBottom.add( this.clouds.shellThickness.mul( 0.5 ) ).toVar();
			const camY = this.clouds.camY;
			const r0 = camY.add( EARTH_RADIUS ).toVar(), b = r0.mul( max( d.y, 0 ) ).toVar();
			// (the distance to that sphere, written without a difference of near-equal terms)
			const inside = middle.sub( camY ).mul( r0.add( middle.add( EARTH_RADIUS ) ) ).toVar();
			const mid = inside.div( sqrt( b.mul( b ).add( inside ) ).add( b ) ).toVar();
			// Under the low deck's share, out to the march's own opacity-weighted depth instead
			// (Clouds `sampleViewDepth`): a closed deck's light comes from its lowest hundred metres,
			// and at a low deck the middle lies some 2.5 times farther, which fogged the deck at 5 - 12
			// degrees about twice as densely as its distance does.
			const reach = mix( mid, this.clouds.sampleViewDepth( d, mid ), this.clouds.lowShare );
			const cloudHaze = haze( d, reach );
			const fogged = cloudHaze.light.mul( float( 1 ).sub( through ) ).add( cloudHaze.transmittance.mul( clouds ) );
			return vec4( sky.light.add( sky.transmittance.mul( behind ) ).mul( through ).add( fogged ), 1 );

		} )();

	}

	/** The mean cloud transmittance over the sun's disc (r) and over the moon's (g): DISC_SAMPLES
	 * directions spread over each disc (a Vogel spiral, uniform by area) read from the clouds'
	 * panorama, for the sky's constants texel (Pipeline.ts `skyConstants`). One ray would switch the
	 * disc on and off as a cloud's edge crosses it. */
	discCloudTransmittance(): V4 {

		const mean = ( centre: V3, radius: number ) => {

			const tangent = normalize( select( abs( centre.y ).greaterThan( 0.99 ), vec3( 1, 0, 0 ), vec3( centre.z, 0, centre.x.negate() ) ) ).toVar();
			const bitangent = cross( centre, tangent ).toVar();
			const sum = float( 0 ).toVar();
			Loop( DISC_SAMPLES, ( { i } ) => {

				const r = sqrt( float( i ).add( 0.5 ).div( DISC_SAMPLES ) ).mul( radius );
				const a = float( i ).mul( 2.399963 );
				sum.addAssign( this.clouds.sample( normalize( centre.add( tangent.mul( cos( a ).mul( r ) ) ).add( bitangent.mul( sin( a ).mul( r ) ) ) ) ).a );

			} );
			return sum.div( DISC_SAMPLES );

		};
		return Fn( () => vec4( mean( this.displaySunDir, SUN_DISC_RADIUS ), mean( this.night.moonDir, MOON_ANGULAR_RADIUS ), 0, 1 ) )();

	}

	/** Lays the haze over the dome (VolumetricHaze.ts `skyHaze`: see `domeColour`). The sky fogs
	 * itself, so the haze's composite leaves the sky's pixels as they are. Called once, before the
	 * dome first draws. */
	fogDome( haze: SkyHaze ): void {

		const material = this.dome.material as THREE.MeshBasicNodeMaterial;
		material.colorNode = this.domeColour( haze );
		material.needsUpdate = true;

	}

	/** Periodic bakes whose irradiance is still being read back: a paused page that starts one draws
	 * frames while it is in flight, so the settled signal waits for it, and a stepped clip waits until
	 * none is (main.ts `settleFrame`, `loop.step`). */
	get readbacks(): number { return this.irradiancePending; }

	get transitioning(): boolean { return this.transitionDuration > 0 && this.transitionElapsed < this.transitionDuration; }
	get moonDir(): THREE.Vector3 { return this.night.moonDir.value; }
	/** The distant sea's radiance, the environment's lower half, as the latest bake set it. */
	get seaRadiance(): THREE.Color { return this.sea.value; }

	get environmentNode(): V3 {

		if ( ! this.environment ) throw new Error( 'The sky environment is available after the initial update' );
		return this.environment;

	}

	setCelestial( snapshot: DayCycleSnapshot | null ): void {

		// The caller may keep advancing its clock while GPU readback is pending. Each bake
		// owns its requested directions and scalars, never a mutable controller snapshot.
		this.celestial = snapshot ? { ...snapshot, sunDir: snapshot.sunDir.clone(), moonDir: snapshot.moonDir.clone(), moonSunDir: snapshot.moonSunDir.clone(), keyDir: snapshot.keyDir.clone() } : null;

	}

	setWeather( snapshot: WeatherState | null ): void {

		this.weatherState = snapshot ? { ...snapshot } : null;

	}

	/** The cloud view's resolution, a share of the render or of the display (`CloudViewScale`; the
	 * quality tier's `cloudView`). High's share of the display keeps the view's size, and so its
	 * kernels, while the render's scale moves, and does not soften the clouds a second time. */
	setCloudView( scale: CloudViewScale ): void {

		// Fixed targets keep sampler dimensions and both PMREM endpoints compatible while
		// quality changes. Cloud march steps and the caller's bake cadence set the GPU budget.
		this.clouds.setViewScale( scale );
		this.clouds.invalidate();

	}

	/** The environment's PMREM source: an equirect `width` x `width / 2` (512 today; 256 gives
	 * an atlas a quarter the size). It fixes the atlases' size, so it is set before the first bake. */
	setEnvironmentSource( width: number ): void {

		if ( this.initialized ) throw new Error( 'The environment source is fixed by the first bake' );
		if ( ! ( Number.isInteger( Math.log2( width ) ) && width >= 64 ) ) throw new RangeError( 'The environment source width must be a power of two of at least 64' );
		this.reflectionSource.setSize( width, width / 2 );

	}

	/** Refresh the environment (PMREM) on every `every`-th periodic bake only; the panoramas and
	 * irradiance keep their cadence, and explicit bakes always refresh it. */
	setEnvironmentCadence( every: number ): void {

		if ( ! ( Number.isInteger( every ) && every >= 1 ) ) throw new RangeError( 'The environment cadence must be a positive integer' );
		this.environmentEvery = every;

	}

	/** Compile the bake's and the clouds' pipelines ahead of their first use (startup calls this
	 * while the world generates). Bakes wait for it: a draw whose pipeline it is still creating would
	 * be skipped (see the header). The returned promise rejects if a compile fails, for the caller
	 * to report (main.ts awaits it before the loop); the bakes waiting on it go ahead. */
	warm( r: THREE.WebGPURenderer = this.renderer ): Promise<void> {

		const compiled = this.compileAhead( r );
		this.warmed = compiled.catch( () => undefined );
		return compiled;

	}

	private async compileAhead( r: THREE.WebGPURenderer ): Promise<void> {

		await r.init();
		await this.clouds.warm( r );
		// A pipeline depends on the target it draws into: compile each quad for its own.
		const e = this.endpoints[ 0 ];
		const pairs: [ THREE.QuadMesh, THREE.RenderTarget ][] = [
			[ this.upperQuad, e.clouds ], [ this.quad, e.equirect ], [ this.quad, this.small ],
			[ this.irradianceQuad, e.irradianceMap ], [ this.irradianceBlendQuad, this.irradianceDisplay ],
			[ this.clearIrradianceQuad, e.clearIrradianceMap ], [ this.clearIrradianceBlendQuad, this.clearIrradianceDisplay ],
			[ this.deckIrradianceQuad, e.deckIrradianceMap ], [ this.deckIrradianceBlendQuad, this.deckIrradianceDisplay ],
		];
		if ( this.environmentBlendQuad && this.envMap ) pairs.push( [ this.environmentBlendQuad, this.envMap ] );
		const compiling = pairs.map( ( [ quad, target ] ) => compileInto( r, quad, quad.camera, target ) );
		compiling.push( this.pmrem.compileEquirectangularShader() );
		await Promise.all( compiling );

	}

	/** Back to the state before the first bake, so the next `update` bakes as a page's first does: both
	 * endpoints and both environment atlases from one bake, shown without a blend (no trace of the
	 * bakes before), and the clouds with no view yet and the viewer at its start (Clouds.restart),
	 * set to the scene clock `time` and the wind's heading `windDirection` as the frames set them
	 * (`followClock`). Every explicit bake starts from it (main.ts `bakeEnvironment`): a paused page
	 * keeps its last explicit bake's products, so the load, a scene jump, a seek and a retune must
	 * make the same ones from the same state, whatever the frames or the bakes before left behind;
	 * the clouds' drift, evolution and axes are the clock's, so the bake sees the clouds the frame
	 * shows (taken at their constructed state instead, the load's bake of an afternoon's deck read
	 * its sky light about half a stop above a bake of the same scene after a frame). Call it with no
	 * bake in flight. */
	reset( windDirection: THREE.Vector2, time: number ): void {

		if ( this.busy ) throw new Error( 'Sky.reset: a bake is in flight' );
		// a periodic readback still in flight from before the jump lands nowhere (`readIrradiance`)
		for ( const state of this.endpoints ) state.version = ++ this.bakeVersion;
		this.initialized = false;
		this.front = 0;
		this.destination = 0;
		this.environmentFront = 0;
		this.environmentPair = [ 0, 0 ];
		this.bakesSinceEnvironment = 0;
		this.transitionDuration = 0;
		this.transitionElapsed = 0;
		this.blend.value = 0;
		this.viewCamera = null;
		this.viewWidth = 1;
		this.viewHeight = 1;
		this.cloudTime = 0;
		this.clockStill = false;
		this.viewer.set( 0, 15, 0 );
		this.clouds.restart();
		this.followClock( windDirection, time );

	}

	// The clouds' and the night sky's state at the scene clock `time`, the wind from `windDirection`:
	// a function of the clock, set by every frame (`updateClouds`) and by `reset` for a bake.
	private followClock( windDirection: THREE.Vector2, time: number ): void {

		// Weather arrives from upwind.
		this.clouds.frontAxis.value.copy( windDirection ).negate().normalize();
		this.clouds.cirrusAxis.value.copy( windDirection ).normalize();
		this.clouds.setDrift( shared.wind.displacement.value );
		// The clouds' inner structure rises through them at 2.5 m/s, as a cumulus' turrets do
		// (the rain curtains fall by the same clock).
		this.clouds.setEvolution( time );
		this.night.time.value = time;

	}

	update( transitionSeconds = 0 ): Promise<void> {

		if ( ! Number.isFinite( transitionSeconds ) || transitionSeconds < 0 ) return Promise.reject( new RangeError( 'Sky transition duration must be finite and nonnegative' ) );
		if ( this.slices.length > 0 ) {

			// A periodic bake is under way over frames. Another periodic request joins it; anyone
			// else (an explicit bake waiting for it) has it completed now, as a whole bake would be.
			const pending = this.pendingUpdate!;
			if ( transitionSeconds > 0 ) return pending;
			this.finishSlices();
			return pending;

		}
		if ( this.pendingUpdate ) return this.pendingUpdate;
		if ( this.transitioning ) {

			if ( transitionSeconds > 0 ) return Promise.resolve();
			this.advance( this.transitionDuration );

		}
		this.busy = true;
		// A periodic bake on a running clock spreads over frames: its panoramas now, inside this
		// frame, then the environment's filter chain a few passes a frame (see advance()). Its
		// products are those of a whole bake; they arrive a few frames later.
		if ( transitionSeconds > 0 && this.initialized && this.clouds.ready && this.night.ready && debugFlags.skyWholeBake !== true ) {

			const pending = new Promise<void>( ( resolve, reject ) => { this.sliceDone = { resolve, reject }; } );
			this.pendingUpdate = pending;
			try {

				this.startSlices( transitionSeconds );

			} catch ( error ) {

				this.abortSlices( error );

			}
			return pending;

		}
		this.pendingUpdate = this.bake( transitionSeconds ).finally( () => {

			this.busy = false;
			this.pendingUpdate = null;

		} );
		return this.pendingUpdate;

	}

	/** The sky's irradiance over pi as lent to the island (`islandIrradianceNode`) on the CPU, from
	 * `skyIrradiance`. */
	islandSkyIrradiance( target = new THREE.Color() ): THREE.Color {

		const light = this.skyIrradiance, tint = this.islandTint.value, gain = this.islandGain.value;
		const l = 0.2126 * light.r + 0.7152 * light.g + 0.0722 * light.b;
		return target.setRGB(
			( light.r + ( tint.x * l - light.r ) * tint.w ) * gain,
			( light.g + ( tint.y * l - light.g ) * tint.w ) * gain,
			( light.b + ( tint.z * l - light.b ) * tint.w ) * gain,
		);

	}

	/** Evaluate the sun, moon, key light, stars, grade and displayed weather for this frame.
	 * Everything that moves with the clock is continuous here; bakes only capture this state. */
	track( celestial: DayCycleSnapshot | null, weather: Readonly<WeatherState> | null, coverageOverride: number | null = null, front: WeatherFront | null = null, skyMix: readonly number[] | null = null ): void {

		if ( celestial ) {

			this.sunDir.copy( celestial.sunDir );
			this.elevation = celestial.elevation;
			this.azimuth = celestial.azimuth;

		} else {

			const el = THREE.MathUtils.degToRad( this.elevation ), az = THREE.MathUtils.degToRad( this.azimuth );
			this.sunDir.set( Math.cos( el ) * Math.cos( az ), Math.sin( el ), Math.cos( el ) * Math.sin( az ) ).normalize();

		}
		const illuminance = this.sunIlluminance * SCENE_RADIANCE_SCALE;
		this.solarIlluminance.copy( this.sunTint ).multiplyScalar( illuminance );
		// The atmosphere's slices are cut again only when the sun or the moon has moved.
		this.atmosphere.sunDir.value.copy( this.sunDir );
		// While it is up the moon stands in the night key's fixed direction (KeyLift
		// `moonDirection`): drawn there, lighting the sky and the haze from there, as it shades the
		// island. Its phase turns with it, keeping its angle to the orbit's sun. Below the horizon
		// (by day) it keeps its orbit's direction.
		if ( celestial && celestial.moonVisibility > 0 ) {

			moonDirection( celestial.moonDir, this.drawnMoonDir );
			_moonTurn.setFromUnitVectors( celestial.moonDir, this.drawnMoonDir );
			this.drawnMoonSunDir.copy( celestial.moonSunDir ).applyQuaternion( _moonTurn );

		} else if ( celestial ) {

			this.drawnMoonDir.copy( celestial.moonDir );
			this.drawnMoonSunDir.copy( celestial.moonSunDir );

		}
		if ( celestial ) this.atmosphere.moonDir.value.copy( this.drawnMoonDir );
		else this.atmosphere.moonDir.value.copy( this.sunDir ).negate();
		// The moonlit sky is drawn with the moon's key light (MOON_KEY), the island's at its own hue,
		// times the sky's night gain (SKY_LIGHT's night key), which the key leaves out: the key takes
		// the moon's own gain instead (`moonKeyGain`).
		const cloud = skyMix ? cloudedShare( skyMix ) : 0;
		this.rising = sunRising( this.sunDir );
		const moonGain = celestial ? celestial.moonKeyGain * twilightMoon( celestial.elevation, this.rising, cloud ) : 0;
		const moonKey = illuminance * moonGain;
		const moonSky = SKY_LIGHT.night;
		this.moonKeyColor.setRGB( MOON_KEY[ 0 ] * moonKey, MOON_KEY[ 1 ] * moonKey, MOON_KEY[ 2 ] * moonKey );
		this.atmosphere.moonIlluminance.value.setRGB( this.moonKeyColor.r * moonSky.r, this.moonKeyColor.g * moonSky.g, this.moonKeyColor.b * moonSky.b );
		this.atmosphere.sunIlluminance.value.copy( this.solarIlluminance ).multiply( skyGain( this.elevation, this.rising, cloud, _skyGain ) );
		this.clouds.cirrusSunGain.value = cirrusGain( this.elevation, this.rising, cloud );
		this.atmosphere.updateSync();
		// Cap the hue of the air's extinction first, then fade by the disk's visible share, so the
		// setting disk only dims the key and does not bleach it.
		const sunVisible = this.atmosphere.sunVisibleShareToSun();
		if ( sunVisible > 0 ) this.sunColor.copy( keyHue( this.atmosphere.transmittanceToSun(), this.sunTint, this.rising ) ).multiplyScalar( sunVisible * illuminance );
		else this.sunColor.setRGB( 0, 0, 0 );
		// The key turns from the sun to the moon where it is drawn (KeyLift `moonDirection`): over
		// the handoff its turn along the orbits gains, in step, the turn from the moon's orbit to
		// that direction, so it arrives there without a jump and holds there all night. Everything
		// that reads the key's direction (the water's glint, the refracted light
		// under the water, the clouds, the haze) then sees the moon where it is drawn. By day
		// (no handoff) the key is the sun's direction itself.
		this.keyDir.copy( celestial?.keyDir ?? this.sunDir );
		if ( celestial && celestial.handoff > 0 ) {

			_keyTurn.setFromUnitVectors( celestial.moonDir, moonDirection( celestial.moonDir, _keyTo ) );
			if ( celestial.handoff === 1 ) this.keyDir.copy( _keyTo );
			else this.keyDir.applyQuaternion( _keyStep.slerpQuaternions( _noTurn, _keyTurn, celestial.handoff ) );

		}
		this.keyIsMoon = moonGain > 0;
		this.keyColor.copy( this.sunColor ).multiplyScalar( lowKey( this.elevation ) );
		const moonColor = this.night.moonColor.value;
		if ( celestial ) {

			// A modest art-directed moon remains orders darker than daylight on the island (MOON_KEY),
			// in the island's own hue: only the moon's share of the key takes it, so over the handoff
			// it grows with that share, and by day (no moon) the sun's key is untouched.
			this.moonKeyAbove.copy( this.moonKeyColor ).multiply( moonHue( _moonHue ) ).multiplyScalar( moonKeyGain() );
			this.keyColor.add( this.moonKeyAbove );
			this.night.moonDir.value.copy( this.drawnMoonDir );
			this.night.frame.value.copy( celestial.starFrame );
			// (the moon's light does not follow its phase: DayCycle's header)
			this.night.moonWash.value = celestial.moonVisibility;
			// The disk sits in the upper tones at night exposure so its maria stay visible, as to the
			// eye; the moonlight on the island is the key light above, not this disk.
			moonColor.setRGB( 0.04, 0.041, 0.043 ).multiplyScalar( 0.32 * celestial.moonVisibility * this.sunIlluminance / SUN_ILLUMINANCE );
			this.grade.night = displayNight( celestial.daylight, celestial.elevation, this.rising, cloud );
			this.night.starVisibility.value = celestial.nightVisibility * this.grade.night * ( 1 - 0.22 * celestial.moonVisibility );
			this.displayNightAmbient.value.setRGB( 0.001, 0.001625, 0.003125 ).multiplyScalar( illuminance * celestial.nightAmbient );
			this.grade.exposure = celestial.exposure;
			this.grade.daylight = celestial.daylight;
			this.islandGain.value = islandSky( celestial.elevation, this.rising, this.islandTint.value, cloud );
			const direct = weather?.directVisibility ?? 1;
			const shade = clearShade( celestial.elevation, direct ), low = lowSun( celestial.elevation, direct );
			const tint = this.islandTint.value;
			if ( shade > 0 ) {

				this.islandGain.value *= 1 + shade;
				tint.set( CLEAR_SHADE_TINT[ 0 ], CLEAR_SHADE_TINT[ 1 ], CLEAR_SHADE_TINT[ 2 ], CLEAR_SHADE_TINT[ 3 ] * shade );

			}
			if ( low > 0 ) tint.set( tint.x + ( LOW_SUN_TINT[ 0 ] - tint.x ) * low, tint.y + ( LOW_SUN_TINT[ 1 ] - tint.y ) * low,
				tint.z + ( LOW_SUN_TINT[ 2 ] - tint.z ) * low, Math.max( tint.w, LOW_SUN.amount * low ) );
			const clouded = skyMix ? cloudedHighSun( celestial.elevation, skyMix, 12 ) : 0;
			if ( clouded > 0 ) tint.set( CLOUD_LIGHT_TINT[ 0 ], CLOUD_LIGHT_TINT[ 1 ], CLOUD_LIGHT_TINT[ 2 ], CLOUD_LIGHT_TINT[ 3 ] * clouded );

		} else {

			this.night.moonDir.value.copy( this.sunDir ).negate();
			this.moonKeyAbove.setRGB( 0, 0, 0 );
			moonColor.setRGB( 0, 0, 0 );
			this.night.starVisibility.value = 0;
			this.displayNightAmbient.value.setRGB( 0, 0, 0 );
			this.grade.exposure = DAY_EXPOSURE;
			this.grade.daylight = 1;
			this.grade.night = 0;
			this.islandTint.value.set( 1, 1, 1, 0 );
			this.islandGain.value = 1;

		}
		this.keyColorAboveClouds.copy( this.keyColor );
		const coverage = coverageOverride ?? weather?.coverage ?? 0;
		const overcast = weather ? THREE.MathUtils.smoothstep( coverage, 0.65, 0.98 ) : 0;
		const ambientGain = weather?.ambientGain ?? 1;
		const directVisibility = weather?.directVisibility ?? 1;
		// The reference exposure (the frame's is metered from the light: post/Exposure.ts; this one
		// is what the night sky's own light is tuned against) adapts to the dimmer diffuse daylight
		// under a closed deck, as tidewater's auto exposure would: it lifts a frame darker than its
		// target only partly (by the ratio's 0.8th power), 4.7 times under a closed deck; less so in
		// rain.
		this.grade.exposure *= 1 + 3.7 * overcast * this.grade.daylight * ( 1 - 0.7 * ( weather?.rain ?? 0 ) );
		// After dark a closed deck hides the moon and stars; the eye adapts further so a rainy
		// dusk or night stays readable, still darker than a clear moonlit night.
		this.grade.exposure *= 1 + overcast * ( celestial?.overcastAdaptation ?? 0 );
		// The night sky's own light keeps the brightness it was tuned at, under the exposure the
		// night had then (with a closed deck's adaptation fivefold), but for the night's own gain
		// (DayCycle NIGHT_EXPOSURE_GAIN), which brightens it with the island.
		this.nightSkyLevel = celestial ? Math.min( 1, celestial.nightSkyLevel
			* ( 1 + 5 * overcast * ( 1 - celestial.daylight ) ) / ( 1 + overcast * celestial.overcastAdaptation ) ) : 1;
		this.night.starVisibility.value *= this.nightSkyLevel;
		moonColor.multiplyScalar( this.nightSkyLevel );
		this.sunColor.multiplyScalar( directVisibility );
		this.keyColor.multiplyScalar( directVisibility );
		// Under a deck the sun's light is whiter than a clear day's at the same height, part of it
		// scattered in the cloud: the key keeps its luminance and moves KEY_DECK_WHITE of the way to
		// white under overcast, where the sun still shines through, and all the way under rain's
		// closed deck (a rainy evening's light is not a sunset's).
		const keyLuminance = this.keyColor.r * 0.2126 + this.keyColor.g * 0.7152 + this.keyColor.b * 0.0722;
		const rain = weather?.rain ?? 0;
		this.keyColor.lerp( _white.setScalar( keyLuminance ), overcast * ( KEY_DECK_WHITE + ( 1 - KEY_DECK_WHITE ) * rain ) );
		this.solarIlluminance.multiplyScalar( directVisibility );
		moonColor.multiplyScalar( directVisibility );
		this.night.starVisibility.value *= ambientGain;
		// the drawn moon's disk takes its phase's light (DayCycle `moonSunDir`, turned with the disk)
		this.night.sunDir.value.copy( celestial ? this.drawnMoonSunDir : this.sunDir );
		this.displaySunDir.value.copy( this.sunDir );
		this.displaySolarIlluminance.value.copy( this.solarIlluminance );
		this.displayAmbientGain.value = ambientGain;
		// the deck's floor takes over from the clouds' own under the deck (Weather.ts `deckFloor`,
		// `deckTakeover`)
		this.keyCloudFloor.value = THREE.MathUtils.lerp( weather?.cloudFloor ?? 0, weather?.deckFloor ?? 0, skyMix ? deckTakeover( this.elevation, cloudedShare( skyMix ), skyMix[ 3 ] ?? 0 ) : 0 );
		this.castShadow.value = weather?.castShadow ?? 1;
		// A front that has arrived is the sky at rest: its `from` is no longer in the sky, and the
		// bounds that take the larger of the two would keep marching for it.
		this.trackClouds( celestial, weather, coverage, overcast, illuminance, coverageOverride === null && front && front.progress < 1 ? front : null, skyMix );
		this.clouds.cirrus.value = weather?.cirrus ?? 0;
		// A rainbow needs falling rain and direct sun at once, the sun lower than 42 degrees behind
		// the viewer: most often as a shower clears, while it is still raining a few kilometres off.
		// The clouds draw it in their sunlit rain curtains.
		const showers = weather?.showers ?? 0, sunlit = weather?.directVisibility ?? 1;
		this.clouds.showers.value = showers;
		// Drops fall at about 9 m/s and drift with the wind, slower near the sea than aloft; a gale
		// slants them steeply.
		this.clouds.rainSlant.value = Math.min( ( weather?.windSpeed ?? 3.8 ) / 11, 1 );
		// A fog's cover is mist and stratus, not rain cells: its broken sky does not shower.
		this.clouds.heapShowers.value = 1 - THREE.MathUtils.smoothstep( weather?.fog ?? 0, 0.3, 0.8 );
		this.clouds.rainbow.value = THREE.MathUtils.smoothstep( showers, 0.04, 0.3 ) * THREE.MathUtils.smoothstep( sunlit, 0.3, 0.7 )
			* THREE.MathUtils.smoothstep( this.sunDir.y, 0, 0.08 ) * ( 1 - THREE.MathUtils.smoothstep( this.sunDir.y, 0.6, 0.72 ) );
		this.weather.haze = weather?.haze ?? 0;
		this.weather.rain = weather?.rain ?? 0;
		// (the morning mist is the haze's: weather/HazeKeys.ts)
		this.weather.fog = weather?.fog ?? 0;
		this.weather.windSpeed = weather?.windSpeed ?? 3.8;
		this.weather.windDirection = weather?.windDirection ?? 40;

	}

	private trackClouds( celestial: DayCycleSnapshot | null, weather: Readonly<WeatherState> | null, coverage: number, overcast: number, illuminance: number, front: WeatherFront | null, skyMix: readonly number[] | null ): void {

		const clouds = this.clouds;
		clouds.coverage.value = coverage;
		clouds.density.value = weather?.density ?? 1;
		// The shadow's share of the deck by the weather's shares of the kept skies, or the weather's
		// own without them: a weather change or a retune rebakes the whole map (`bake`), a front
		// refreshes it row by row as it does for the coverage.
		clouds.shadowDensity.value = skyMix ? SHADOW_DENSITY.reduce( ( sum, k, s ) => sum + ( skyMix[ s ] ?? 0 ) * k.shadowDensity, 0 ) : weather?.shadowDensity ?? 1;
		// The shell by the same shares (the high one's without them): every reader follows its
		// uniforms, the march, the shadow, the rain, the haze's shafts and the lightning.
		const shell = ( key: 'base' | 'top' ) => skyMix ? CLOUD_SHELL.reduce( ( sum, k, s ) => sum + ( skyMix[ s ] ?? 0 ) * k[ key ], 0 ) : CLOUD_SHELL[ 0 ][ key ];
		const base = shell( 'base' );
		clouds.setDeck( base, shell( 'top' ) - base, skyMix ? cloudedShare( skyMix ) : 0 );
		const form = ( key: keyof typeof CLOUD_FORM ) => skyMix ? CLOUD_FORM_BY_SKY.reduce( ( sum, k, s ) => sum + ( skyMix[ s ] ?? 0 ) * k[ key ], 0 ) : CLOUD_FORM[ key ];
		clouds.setForm( form( 'edge' ), form( 'erosion' ), form( 'baseEnd' ), form( 'lanes' ), form( 'laneSplit' ), form( 'laneSoftness' ), form( 'baseLift' ), form( 'inside' ) );
		clouds.coverageFrom.value = front ? front.from.coverage : coverage;
		clouds.coverageTo.value = front ? front.to.coverage : coverage;
		clouds.densityFrom.value = front ? front.from.density : clouds.density.value;
		clouds.densityTo.value = front ? front.to.density : clouds.density.value;
		clouds.frontProgress.value = front ? front.progress : 1;
		// At mid passage a place half a span upwind is half a front ahead of the island, and has
		// arrived. The lead grows from nothing as the front sets out and closes to nothing as it
		// ends, so a front that sets out from a sky at rest moves no place of the shell in its first
		// frame, and none steps in its last. A low sun's rays meet the shell tens of kilometres
		// out: a lead there from the first frame closed its shadow at once, and a place downwind
		// held the old sky after the island had the new.
		clouds.frontLead.value = front ? 4 * front.progress * ( 1 - front.progress ) : 0;
		clouds.rainFrom.value = front ? front.from.rain : weather?.rain ?? 0;
		clouds.rainTo.value = front ? front.to.rain : weather?.rain ?? 0;
		// Cloud tops a couple of kilometres up keep the sun a little after it has set below. The
		// rising sun's reaches the shell where it stands (its middle, 6.6 km under the clear and
		// fair skies' cumulus), so the clouds take the dawn's light from about -2.6 degrees, as the
		// Earth's shadow sinks below them; the
		// height goes back to the evening's from the sun's rise to 3 degrees, so the morning's
		// higher sun lights them as the afternoon's does, and with a clouded share (Weather.ts
		// `cloudedShare`).
		const cloud = skyMix ? cloudedShare( skyMix ) : 0;
		const rising = this.rising && cloud < 1;
		const toEvening = Math.max( cloud, THREE.MathUtils.smoothstep( celestial?.elevation ?? 90, 0, 3 ) );
		const middle = ( clouds.shellBottom.value + clouds.shellThickness.value / 2 ) / 1000;
		const sunHeight = rising ? 2 + ( middle - 2 ) * ( 1 - toEvening ) : 2;
		const sunAbove = this.atmosphere.sunlightAt( this.sunDir, sunHeight ).multiply( this.sunTint ).multiplyScalar( illuminance );
		// Under a closed deck the sun reaches the deck as it reaches the island, scattered through
		// the cloud: it keeps its luminance and loses its colour as the key does (track), so an
		// overcast evening's deck is not a sunset's.
		sunAbove.lerp( _white.setScalar( luma( sunAbove ) ), overcast );
		// The clouds belong to the seen sky: their moonlight keeps the night sky's own ramp
		// (CLOUD_MOON), not the key's earlier one that keeps the island lit after sunset.
		const moonGain = celestial ? ( 1 - THREE.MathUtils.smoothstep( celestial.elevation, CLOUD_MOON[ 0 ], CLOUD_MOON[ 1 ] ) ) * celestial.moonVisibility : 0;
		const sunUp = ! celestial || celestial.elevation > - 2.5 || rising;
		// The march's depth shades the clouds' sky light as well as their direct light, and the same
		// direction casts their shadow, so it moves without a jump even while no direct light reaches
		// them: a jump there stepped the deck's brightness, half a stop on the meter under overcast.
		// It sets first, its shadow fading out on the way down, so its turn round to the sun, under
		// the horizon, sweeps no shadow across the island.
		const elevation = celestial?.elevation ?? 90;
		const setting = THREE.MathUtils.smoothstep( elevation, CLOUD_TURN[ 0 ], CLOUD_TURN[ 1 ] ), round = THREE.MathUtils.smoothstep( elevation, CLOUD_TURN[ 1 ], CLOUD_TURN[ 2 ] );
		clouds.shadowShare.value = elevation < CLOUD_TURN[ 1 ] ? 1 - setting : THREE.MathUtils.smoothstep( this.sunDir.y, CLOUD_SHADOW_SET[ 0 ], CLOUD_SHADOW_SET[ 1 ] );
		clouds.lightDir.value.copy( setting === 0 ? this.keyDir : this.sunDir );
		if ( celestial && setting > 0 && round < 1 ) {

			const from = moonDirection( celestial.moonDir, _keyTo );
			const y = THREE.MathUtils.lerp( from.y, this.sunDir.y, setting ), start = Math.atan2( from.z, from.x );
			const turn = Math.atan2( this.sunDir.z, this.sunDir.x ) - start;
			const azimuth = start + Math.atan2( Math.sin( turn ), Math.cos( turn ) ) * round, across = Math.sqrt( 1 - y * y );
			clouds.lightDir.value.set( across * Math.cos( azimuth ), y, across * Math.sin( azimuth ) );

		}
		// the low deck's forward lobe's light on level ground at the key's height (Clouds.ts forwardLevel)
		clouds.forwardLevel.value = forwardLevel( clouds.lightDir.value.y, clouds.forwardLobe.value );
		const disc = 1 - THREE.MathUtils.smoothstep( clouds.lightDir.value.y, SHADOW_DISC[ 0 ], SHADOW_DISC[ 1 ] );
		clouds.shadowDisc.value = disc * SUN_ANGULAR_RADIUS;
		// With the whole disc under the floor the rays are one ray.
		clouds.shadowRays.value = disc > 0 && clouds.lightDir.value.y + clouds.shadowDisc.value > SHADOW_SLOPE_FLOOR ? SHADOW_DISC_RAYS : 1;
		const keyElevation = THREE.MathUtils.radToDeg( Math.asin( clouds.lightDir.value.y ) );
		clouds.shadowAirNarrow.value = THREE.MathUtils.smoothstep( keyElevation, SHADOW_AIR_NARROW[ 0 ], SHADOW_AIR_NARROW[ 1 ] );
		clouds.keyLift.value = THREE.MathUtils.smoothstep( keyElevation, KEY_LIFT[ 0 ], KEY_LIFT[ 1 ] );
		clouds.lightColor.value.copy( sunUp ? sunAbove : new THREE.Color( 0, 0, 0 ) );
		// The clouds belong to the night sky: their moonlight and night ambient keep its level.
		const moonLight = illuminance * 0.04 * moonGain * this.nightSkyLevel;
		const light = clouds.lightColor.value;
		light.r += 0.65 * moonLight;
		light.g += 0.76 * moonLight;
		light.b += moonLight;
		// The cumulus take their colours from the atmosphere at their height (Clouds.ts makeMarch):
		// only the lights' gains come from here, the sun's at the luminance of its light above the
		// cloud tops and the moon's at its own, each lifted with the low sun's beam (directGain).
		const beam = 1 + 0.7 * lowSunOf( this.elevation, coverage );
		clouds.sunLight.value = ( sunUp ? luma( sunAbove ) : 0 ) * beam;
		clouds.moonLight.value = moonLight * ( 0.65 * 0.2126 + 0.76 * 0.7152 + 0.0722 ) * beam;
		// The night ambient is the clouds' own (the clear sky draws none); the cirrus takes it under a
		// gain of its own (Clouds.ts `cirrusNightAmbient`).
		clouds.nightAmbient.value.copy( this.displayNightAmbient.value ).multiplyScalar( this.nightSkyLevel );
		// A low deck's column passes down the key's light above its tops: by day the sun's above the
		// cloud, by night the island's moonlight (`moonKeyAbove`), which keeps the island's level and
		// hue, not the clouds' (their moonlight belongs to the seen sky), and loses its colour under a
		// closed deck as the sun's does (above). The deck's base and the land under it then take one
		// moon, as by day they take one sun.
		const moonAbove = _moonKey.copy( this.moonKeyAbove );
		const column = clouds.columnKey.value.copy( moonAbove.lerp( _white.setScalar( luma( moonAbove ) ), overcast ) );
		if ( sunUp ) column.add( sunAbove );
		// Low sun: lift the reddened beam, and the cool violet fill on the shaded sides with it. The
		// lift fades as the sky closes: a fair sky's scattered cumulus keep their golden light, a
		// cloudy sky's cover shows near neutral, and a closed deck, whose sunlight has lost its
		// colour, takes none.
		const lowSun = lowSunOf( this.elevation, coverage );
		clouds.directGain.value = 1 + 0.7 * lowSun;
		clouds.ambientGain.value = 1 + 0.35 * lowSun;

	}

	/** Advance the cloud field for this frame: wind, slow evolution and the view from `camera`,
	 * whose drawing buffer is `width` by `height` pixels. The clouds drift by the surface wind's
	 * integrated displacement (`shared.wind.displacement`, Clouds.setDrift), at their own rates
	 * aloft. */
	updateClouds( camera: THREE.PerspectiveCamera, width: number, height: number, windDirection: THREE.Vector2, time: number ): void {

		if ( ! this.clouds.ready ) return;
		this.viewCamera = camera;
		this.viewWidth = width;
		this.viewHeight = height;
		this.clockStill = time === this.cloudTime;
		this.cloudTime = time;
		const display = this.renderer.getSize( this.displaySize );
		this.clouds.setDisplay( display.x, display.y, this.renderer.getPixelRatio() );
		this.followClock( windDirection, time );
		this.viewer.copy( camera.position );
		this.clouds.update( this.renderer, camera, width, height, time );

	}

	private async bake( transitionSeconds: number ): Promise<void> {

		const started = performance.now();
		const version = ++ this.bakeVersion;
		const readback = transitionSeconds === 0 || ! this.initialized;
		const celestial = this.celestial;
		const weather = this.weatherState ? { ...this.weatherState } : null;
		await this.renderer.init();
		// the warm-up's pipelines first: r186 skips a draw whose pipeline is still being created
		// (see the header)
		await this.warmed;
		if ( ! this.clouds.ready ) await this.clouds.init( this.renderer );
		await this.night.load();
		if ( ! this.night.ready ) await this.night.init();
		// An explicit jump (preset, seek, weather change) refreshes the whole cloud map now.
		if ( readback ) {

			this.clouds.invalidate();
			this.clouds.update( this.renderer, this.viewCamera, this.viewWidth, this.viewHeight, this.cloudTime );

		}
		const bake = this.beginBake( version, readback, transitionSeconds, celestial, weather );
		this.renderPanoramas( bake );
		const r = this.renderer;
		if ( readback ) {

			const W = this.small.width, H = this.small.height;
			const px = await r.readRenderTargetPixelsAsync( this.small, 0, 0, W, H ) as Float32Array;
			const E = [ 0, 0, 0 ];
			const dOmegaLon = 2 * Math.PI / W, dTh = Math.PI / H;
			for ( let k = 0; k < W * H; k ++ ) {

				const sinTh = px[ k * 4 + 3 ];
				if ( sinTh <= 0 ) continue;
				const dOmega = dOmegaLon * dTh * Math.sqrt( Math.max( 0, 1 - sinTh * sinTh ) );
				for ( let c = 0; c < 3; c ++ ) E[ c ] += px[ k * 4 + c ] * sinTh * dOmega;

			}
			bake.state.irradiance.setRGB( E[ 0 ] / Math.PI, E[ 1 ] / Math.PI, E[ 2 ] / Math.PI );

		} else this.readIrradiance( bake.state, version );
		if ( bake.environment !== null ) this.filterEnvironment( bake.environment );
		if ( ! this.initialized ) {

			// The first bake fills both atlases from the same source.
			this.front = bake.next;
			this.filterEnvironment( 1 );

		}
		this.publishBake( bake );
		this.lastBakeMs = performance.now() - started;

	}

	// Pick the endpoint a bake writes and capture the state it bakes: the live state from
	// track() (the atmosphere LUT, key light, clouds and stars already describe this frame's sun
	// and moon) and the weather and day it was requested with.
	private beginBake( version: number, readback: boolean, transitionSeconds: number, celestial: DayCycleSnapshot | null, weather: WeatherState | null ): Bake {

		const illuminance = this.sunIlluminance * SCENE_RADIANCE_SCALE;
		const next = this.initialized ? 1 - this.front : 0;
		const state = this.endpoints[ next ];
		state.version = version;
		const ambientGain = weather?.ambientGain ?? 1;
		this.ambientGain.value = ambientGain;
		const daylight = celestial ? celestial.daylight : 1;
		this.sea.value.copy( this.seaColor ).multiplyScalar( illuminance * daylight )
			.add( this.displayNightAmbient.value.clone().multiplyScalar( 0.22 ) ).multiplyScalar( ambientGain );
		this.bakeStarVisibility.value = this.night.starVisibility.value;
		// The environment refreshes on explicit bakes and on every environmentEvery-th periodic one,
		// into the atlas not shown.
		let environment: number | null = 0;
		if ( this.initialized ) {

			const refresh = readback || ++ this.bakesSinceEnvironment >= this.environmentEvery;
			environment = refresh ? 1 - this.environmentFront : null;

		}
		if ( environment !== null ) this.bakesSinceEnvironment = 0;
		return { version, readback, transitionSeconds, next, state, environment };

	}

	// The cloud layer, the panoramas (seen, starlit environment source, irradiance probe) and the
	// irradiance integral.
	private renderPanoramas( bake: Bake ): void {

		const { state } = bake;
		const r = this.renderer, prev = r.getRenderTarget();
		try {

			r.setRenderTarget( state.clouds );
			this.upperQuad.render( r );
			this.cloudLayer.value = state.clouds.texture;
			// the sky's light without its haze, which the panoramas' haze takes under a deck
			// (VolumetricHaze.ts `openSky`)
			for ( const deck of this.initialized ? [ state.deckIrradianceMap ] : [ state.deckIrradianceMap, this.endpoints[ 1 ].deckIrradianceMap ] ) {

				r.setRenderTarget( deck );
				this.deckIrradianceQuad.render( r );

			}
			this.bakeDeckIrradiance.value = state.deckIrradianceMap.texture;
			// Both samplers must have distinct textures at the first material compilation:
			// Three deduplicates texture uniforms by UUID, even for separate TextureNodes.
			const panoramas = this.initialized ? [ state.equirect, this.reflectionSource, this.small ] :
				[ state.equirect, this.endpoints[ 1 ].equirect, this.reflectionSource, this.small ];
			for ( const rt of panoramas ) {

				this.irradiancePass.value = rt === this.small ? 1 : 0;
				this.includeStars.value = rt === this.small || rt === this.reflectionSource ? 1 : 0;
				// Only the environment's source takes the island's light after sunset (ISLAND_SKY).
				const lends = rt === this.reflectionSource;
				this.bakeIslandTint.value.copy( lends ? this.islandTint.value : NEUTRAL_TINT );
				this.bakeIslandGain.value = lends ? this.islandGain.value : 1;
				this.bakeHaze.value = lends || rt === this.small ? 1 : 0;
				this.starFootprint.value = Math.SQRT2 * Math.PI / rt.height;
				r.setRenderTarget( rt );
				this.quad.render( r );

			}
			for ( const irradiance of this.initialized ? [ state.irradianceMap ] : [ state.irradianceMap, this.endpoints[ 1 ].irradianceMap ] ) {

				r.setRenderTarget( irradiance );
				this.irradianceQuad.render( r );

			}
			// (after the probe's panorama, so the bake's uniforms are the probe's)
			for ( const irradiance of this.initialized ? [ state.clearIrradianceMap ] : [ state.clearIrradianceMap, this.endpoints[ 1 ].clearIrradianceMap ] ) {

				r.setRenderTarget( irradiance );
				this.clearIrradianceQuad.render( r );

			}

		} finally {

			r.setRenderTarget( prev );

		}
		this.onEnvironmentSource?.( this.reflectionSource.texture, this.initialized ? bake.environment !== null ? [ bake.environment ] : [] : [ 0, 1 ] );

	}

	// The environment of the starlit source in atlas `index`, whole.
	private filterEnvironment( index: number ): void {

		this.environments[ index ] = this.pmrem.fromEquirectangular( this.reflectionSource.texture, this.environments[ index ] );

	}

	// The same as filterEnvironment, as steps of one or two render passes: the conversion to the
	// cube atlas, then each level's GGX filter from the one above. Each step restores what
	// PMREMGenerator restores after a whole conversion.
	private environmentSlices( index: number ): Slice[] {

		const pmrem = this.pmrem as unknown as PMREMSteps;
		const target = this.environments[ index ];
		const stepwise = target && pmrem._lodMeshes && [ pmrem._setSizeFromTexture, pmrem._init, pmrem._textureToCubeUV, pmrem._applyGGXFilter, pmrem._setViewport ]
			.every( ( f ) => typeof f === 'function' );
		if ( ! stepwise || ! target ) return [ { cost: 20, run: () => this.filterEnvironment( index ) } ];
		const r = this.renderer, source = this.reflectionSource.texture;
		const step = ( work: () => void ) => () => {

			const previous = r.getRenderTarget(), face = r.getActiveCubeFace(), level = r.getActiveMipmapLevel(), autoClear = r.autoClear;
			try {

				work();

			} finally {

				r.autoClear = autoClear;
				r.setRenderTarget( previous, face, level );
				target.scissorTest = false;
				pmrem._setViewport( target, 0, 0, target.width, target.height );

			}

		};
		const slices: Slice[] = [ { cost: 1, run: step( () => {

			pmrem._setSizeFromTexture( source );
			pmrem._init( target );
			pmrem._textureToCubeUV( source, target );

		} ) } ];
		// _init keeps the levels of the source size the first bake set up, so their count is known.
		const levels = pmrem._lodMeshes!.length;
		for ( let i = 1; i < levels; i ++ ) slices.push( { cost: 2, run: step( () => {

			r.autoClear = false;
			pmrem._applyGGXFilter( target, i - 1, i );

		} ) } );
		return slices;

	}

	// Start a periodic bake over frames: the panoramas now, the rest from advance().
	private startSlices( transitionSeconds: number ): void {

		const started = performance.now();
		const weather = this.weatherState ? { ...this.weatherState } : null;
		const bake = this.beginBake( ++ this.bakeVersion, false, transitionSeconds, this.celestial, weather );
		this.renderPanoramas( bake );
		this.readIrradiance( bake.state, bake.version );
		this.slices = bake.environment === null ? [] : this.environmentSlices( bake.environment );
		this.slices.push( { cost: 0, run: () => this.publishBake( bake ) } );
		this.sliceMs = performance.now() - started;
		// A paused scene does it whole, so a paused frame never depends on how many frames ran.
		if ( this.clockStill ) this.finishSlices();
		else this.armSliceTimer();

	}

	// Run whole steps of the bake under way, up to `passes` render passes (at least one step); its
	// publication ends it. An error ends the bake and rejects its promise, as a whole bake's would,
	// so the sky is free for the next one.
	private runSlices( passes: number ): void {

		const started = performance.now();
		let spent = 0;
		try {

			while ( this.slices.length > 0 && ( spent === 0 || spent + this.slices[ 0 ].cost <= passes ) ) {

				const slice = this.slices.shift()!;
				spent += slice.cost;
				slice.run();

			}

		} catch ( error ) {

			this.abortSlices( error );
			return;

		}
		this.sliceMs += performance.now() - started;
		if ( this.slices.length > 0 ) {

			this.armSliceTimer();
			return;

		}
		if ( this.sliceTimer !== null ) clearTimeout( this.sliceTimer );
		this.sliceTimer = null;
		this.lastBakeMs = this.sliceMs;
		this.busy = false;
		this.pendingUpdate = null;
		const done = this.sliceDone;
		this.sliceDone = null;
		done?.resolve();

	}

	// End the bake under way unfinished: `error` rejects its promise, none resolves it (dispose).
	private abortSlices( error?: unknown ): void {

		if ( this.sliceTimer !== null ) clearTimeout( this.sliceTimer );
		this.sliceTimer = null;
		this.slices = [];
		this.busy = false;
		this.pendingUpdate = null;
		const done = this.sliceDone;
		this.sliceDone = null;
		if ( error === undefined ) done?.resolve();
		else done?.reject( error );

	}

	private finishSlices(): void {

		this.runSlices( Infinity );

	}

	private armSliceTimer(): void {

		if ( this.sliceTimer !== null ) clearTimeout( this.sliceTimer );
		this.sliceTimer = setTimeout( () => {

			this.sliceTimer = null;
			if ( this.slices.length > 0 ) this.finishSlices();

		}, SLICE_TIMEOUT_MS );

	}

	// Show a finished bake: an explicit one at once, a periodic one by cross-fading to it.
	private publishBake( bake: Bake ): void {

		const { state, transitionSeconds } = bake;
		const r = this.renderer;
		const previous = this.endpoints[ this.front ];
		const displayedNext = this.initialized ? state : this.endpoints[ 1 ];
		if ( ! this.initialized ) {

			// Both endpoints start from this bake's cloud layer.
			const prev = r.getRenderTarget();
			r.setRenderTarget( this.endpoints[ 1 ].clouds );
			this.upperQuad.render( r );
			r.setRenderTarget( prev );

		}
		this.panoramaA.value = previous.equirect.texture;
		this.panoramaB.value = displayedNext.equirect.texture;
		this.irradianceA.value = previous.irradianceMap.texture;
		this.irradianceB.value = displayedNext.irradianceMap.texture;
		this.clearIrradianceA.value = previous.clearIrradianceMap.texture;
		this.clearIrradianceB.value = displayedNext.clearIrradianceMap.texture;
		this.deckIrradianceA.value = previous.deckIrradianceMap.texture;
		this.deckIrradianceB.value = displayedNext.deckIrradianceMap.texture;
		// The environment cross-fades from the atlas shown to the one this bake filtered (the
		// first bake filled both); a bake that kept it fades it to itself.
		const shown = this.environments[ this.environmentFront ]!;
		const nextEnvironment = ! this.initialized ? this.environments[ 1 ]! : bake.environment !== null ? this.environments[ bake.environment ]! : shown;
		this.environmentPair = [ this.environmentFront, ! this.initialized ? 1 : bake.environment ?? this.environmentFront ];
		if ( this.initialized && bake.environment !== null ) this.environmentFront = bake.environment;
		if ( ! this.environmentA || ! this.environmentB ) {

			this.environmentA = texture( shown.texture );
			this.environmentB = texture( nextEnvironment.texture );
			this.envMap = shown.clone();
			this.envMap.texture.mapping = THREE.CubeUVReflectionMapping;
			( this.envMap.texture as THREE.Texture & { isPMREMTexture: boolean } ).isPMREMTexture = true;
			this.envMap.texture.name = 'skyDisplayedPMREM';
			this.envMap.scissorTest = false;
			const blendMat = new THREE.NodeMaterial();
			blendMat.depthTest = false;
			blendMat.depthWrite = false;
			blendMat.toneMapped = false;
			// Convolution is linear. Blending the already filtered atlases once keeps terrain
			// within WebGPU's portable 16-texture limit instead of doubling every IBL sample.
			blendMat.fragmentNode = mix( this.environmentA.sample( uv() ).level( float( 0 ) ),
				this.environmentB.sample( uv() ).level( float( 0 ) ), this.blend );
			this.environmentBlendQuad = new THREE.QuadMesh( blendMat );
			this.environment = pmremTexture( this.envMap.texture );

		} else {

			this.environmentA.value = shown.texture;
			this.environmentB.value = nextEnvironment.texture;

		}
		this.destination = bake.next;
		this.transitionElapsed = 0;
		this.transitionDuration = this.initialized ? transitionSeconds : 0;
		this.blend.value = ! this.initialized || this.transitionDuration > 0 ? 0 : 1;
		this.equirect = state.equirect;
		this.initialized = true;
		this.publish( this.blend.value );
		if ( this.transitionDuration === 0 ) this.front = this.destination;

	}

	advance( dt: number ): void {

		if ( ! Number.isFinite( dt ) || dt < 0 ) throw new RangeError( 'Sky dt must be finite and nonnegative' );
		if ( this.slices.length > 0 ) {

			// A periodic bake under way takes this frame's share; once published, its cross-fade
			// starts on the next frame. A paused scene completes it at once.
			if ( this.clockStill ) this.finishSlices();
			else this.runSlices( SLICE_PASSES );
			return;

		}
		if ( ! this.transitioning ) return;
		this.transitionElapsed = Math.min( this.transitionElapsed + dt, this.transitionDuration );
		// Linear: back-to-back bakes then change at a constant rate, never easing to a halt.
		this.blend.value = this.transitionElapsed / this.transitionDuration;
		this.publish( this.blend.value );
		if ( ! this.transitioning ) this.front = this.destination;

	}

	private publish( amount: number ): void {

		const a = this.endpoints[ this.front ], b = this.endpoints[ this.destination ];
		this.skyIrradiance.copy( a.irradiance ).lerp( b.irradiance, amount );
		this.renderDisplayMaps();

	}

	private clearSky( direction: V3 ): V3 {

		// The sun's and the moon's in-scatter (Atmosphere.ts); the night's sky is the moon's, with no
		// floor of its own. Clouds do not mute the clear sky's colour: where they cover it, their own
		// light does.
		return this.atmosphere.skyRadiance( direction );

	}

	private renderDisplayMaps(): void {

		if ( ! this.environmentBlendQuad || ! this.envMap ) return;
		const r = this.renderer, previous = r.getRenderTarget();
		try {

			r.setRenderTarget( this.envMap );
			this.environmentBlendQuad.render( r );
			r.setRenderTarget( this.irradianceDisplay );
			this.irradianceBlendQuad.render( r );
			r.setRenderTarget( this.clearIrradianceDisplay );
			this.clearIrradianceBlendQuad.render( r );
			r.setRenderTarget( this.deckIrradianceDisplay );
			this.deckIrradianceBlendQuad.render( r );

		} finally {

			r.setRenderTarget( previous );

		}

	}

	// A periodic bake's irradiance, read back from its probe (one texel) into its endpoint as soon as
	// the GPU answers, without waiting: it is asked for with the bake's panoramas and lands while the
	// environment's filter steps still run, so normally before the bake shows; one that lands later
	// changes the cross-fade only by the little it has run. A late answer never overwrites an
	// endpoint a newer bake has taken.
	private readIrradiance( state: SkyEndpoint, version: number ): void {

		this.irradiancePending ++;
		void this.renderer.readRenderTargetPixelsAsync( state.irradianceMap, 0, 0, 1, 1 ).then( ( pixels ) => {

			const p = pixels as Float32Array;
			if ( state.version !== version ) return;
			state.irradiance.setRGB( p[ 0 ], p[ 1 ], p[ 2 ] );
			const a = this.endpoints[ this.front ], b = this.endpoints[ this.destination ];
			if ( state === a || state === b ) this.skyIrradiance.copy( a.irradiance ).lerp( b.irradiance, this.blend.value );

		} ).catch( ( error: unknown ) => console.error( error ) ).finally( () => { this.irradiancePending --; } );

	}

	private samplePanorama( direction: V3, mip: F ): V4 {

		const q = dirToEquirect( direction );
		return mix( this.panoramaA.sample( q ).level( mip ), this.panoramaB.sample( q ).level( mip ), this.blend );

	}

	sample( direction: V3, mip: F = float( 0 ) ): V3 {

		const background = this.samplePanorama( direction, mip ).toVar();
		// The ocean already converts its unresolved slope variance to this angular mip.
		// Apply that same footprint to celestial points, keeping their locations fixed while
		// spreading/dimming their finite energy rather than adding screen-space sparkles.
		const footprint = exp2( mip ).mul( Math.SQRT2 * Math.PI / this.equirect.height );
		// Lightning inside the clouds is live, never baked: a flash lasts a fraction of a second.
		return background.rgb.add( this.night.stars( direction, footprint ).mul( background.a ) ).add( this.clouds.flashAt( direction, float( 1 ).sub( background.a ) ) );

	}

	sampleBackground( direction: V3, mip: F = float( 0 ) ): V3 {

		return this.samplePanorama( direction, mip ).rgb;

	}

	/** The displayed environment's cross-fade: from atlas `a` to atlas `b` by `blend`. */
	environmentWeights(): { a: number; b: number; blend: number } {

		return { a: this.environmentPair[ 0 ], b: this.environmentPair[ 1 ], blend: this.blend.value };

	}

	cloudVisibility( worldPosition: V3 ): F {

		return this.clouds.shadow( worldPosition );

	}

	/** The clouds' shadow on the island's direct light: the clouds' own over the weather's floor
	 * (Weather.ts `cloudFloor`). The sea's glitter and the air's sunlit haze take the clouds' own. */
	keyCloudVisibility( worldPosition: V3 ): F {

		return mix( this.keyCloudFloor, float( 1 ), this.clouds.shadow( worldPosition ) );

	}

	dispose(): void {

		this.dome.geometry.dispose();
		( this.dome.material as THREE.Material ).dispose();
		( this.quad.material as THREE.Material ).dispose();
		( this.upperQuad.material as THREE.Material ).dispose();
		this.reflectionSource.dispose();
		this.small.dispose();
		this.clouds.dispose();
		this.envMap?.dispose();
		this.irradianceDisplay.dispose();
		this.clearIrradianceDisplay.dispose();
		this.deckIrradianceDisplay.dispose();
		( this.environmentBlendQuad?.material as THREE.Material | undefined )?.dispose();
		( this.irradianceQuad.material as THREE.Material ).dispose();
		( this.irradianceBlendQuad.material as THREE.Material ).dispose();
		( this.clearIrradianceQuad.material as THREE.Material ).dispose();
		( this.clearIrradianceBlendQuad.material as THREE.Material ).dispose();
		( this.deckIrradianceQuad.material as THREE.Material ).dispose();
		( this.deckIrradianceBlendQuad.material as THREE.Material ).dispose();
		for ( const endpoint of this.endpoints ) {

			endpoint.equirect.dispose();
			endpoint.clouds.dispose();
			endpoint.irradianceMap.dispose();
			endpoint.clearIrradianceMap.dispose();
			endpoint.deckIrradianceMap.dispose();

		}
		for ( const environment of this.environments ) environment?.dispose();
		this.abortSlices();
		this.pmrem.dispose();
		this.atmosphere.dispose();

	}

}
