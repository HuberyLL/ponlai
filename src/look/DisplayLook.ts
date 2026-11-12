import type { DayKey, DayKeys } from '../post/DayKeys.ts';
import { tuneKeys, tuneObject } from '../debug/Tune.ts';
import type { PipelineSettings } from '../post/Pipeline.ts';

// The look's display tables (src/look/: the numbers chosen for the look, their tunables and the
// CPU code that reads only them): the shade's contrast, the desaturation, overcast's highlights
// toward grey, tidewater's grade (the bloom's and the vignette's strengths), the vignette's shape
// and the white balance. post/PipelineDisplay.ts builds the display chain's shader from them, and
// post/Pipeline.ts `updateDisplay` keys them by the sun and the weather each frame.

// The shade's contrast: under a pivot each stop of the exposed luminance (the local tone's gain in
// it) darkens by `slope` of a stop more, over it nothing changes; after the local tone, before the
// tone curve. The earlier, softer curve lifted the shade with everything else, and on our frames
// the shade lost its weight; this gives it back without touching the lit ground and the sky. The
// pivot (stops over mid grey) and slope are set per key (keyed by the sun's elevation,
// DayKeys.ts). By day the pivot sits over the lit ground, so the whole shade deepens, from noon down
// to a sun at 9 degrees; the golden hour keeps most of the slope with its pivot nearly a stop under
// mid grey, so only what lies in the long shadows drops, and the sunlit cliff stays as it is. The
// clouded sky deepens
// its darks too, from about 0.9 of a stop over mid grey; the night's slope runs to 0 as well, its
// darks set by the local tone alone (its pivot acts only while the night fades in under a clouded
// sky, beside the cloudy key's: DayKeys.ts `keyed` blends the cloud in first).
// Tunable on debug pages (debug/Tune.ts): `post.shade.<value>@golden`, `@day`, `@cloudy`, `@night`.
export const SHADE_CONTRAST: DayKeys<{ pivot: number; slope: number }> = tuneKeys( 'post.shade', {
	day: [ { at: 4, name: 'golden', values: { pivot: - 0.86, slope: 0.37 } }, { at: 9, name: 'day', values: { pivot: 1.58, slope: 0.449 } } ],
	cloudy: { pivot: 0.902, slope: 0.18 },
	night: { pivot: 0.516, slope: 0 },
}, { pivot: { min: - 3, max: 4 }, slope: { min: 0, max: 0.5 } } );

// The desaturation before the local tone's gain: each colour drawn toward its own luminance by
// `amount` (0 keeps it, 1 grey), c + ( Y( c ) - c ) amount, keyed by the sun and the weather
// (DayKeys.ts); below 0 it saturates. Keyed as the white balance is, so each key sets its own: the
// golden hour saturates by a sixth, the day keeps its colours, the clouded sky fades them by a
// twelfth, the night by about a half. The rising sun's `dawn` key, held from -1 degree down,
// fades the cool colours by 0.6 and passes into the golden key's by 1.5 (the golden key's own
// values, shared): before the sun the clear morning's land, sea and sky took the dawn's white
// (`dawn`, WHITE_BALANCE) on top of their own blue, and the upper sky and the far sea turned violet
// (h 271 to 278 from -4 to 0 degrees). A fade of every colour brought them back to h 250 to 262,
// but it took the warm colours with them: the rose band over the horizon (h 327 to 353, C 0.03 to
// 0.05 from -8 to -1 degrees) went to a grey-blue band (h 263, the white's cast), and the meadow's
// green, under it, to h 231 to 241. So the key's `cool` share of 1 fades only the colours that lie
// toward blue once the white is applied (`coolShare`: blue over red as a share of the colour's
// spread, 0 none to 0.6 all), and the warm band and the meadow keep their own colour under the same
// white: the sky's top stays at h 248 to 257, the band at h 327 to 353, the meadow at h 214 to 226
// from -7 to -4.5 degrees.
// Tunable on debug pages (debug/Tune.ts): `post.desaturate.<amount|cool>@golden`, `@dawn`, `@day`,
// `@cloudy`, `@night`; the cool share's edges `post.desaturate.coolFrom`, `post.desaturate.coolTo`.
// amount: the fade (0 keeps the colour, 1 grey, below 0 saturates); cool: the share of the fade
// that only cool colours take (`coolShare`)
type DesaturationKey = { amount: number; cool: number };
const DESATURATION_DAY: DayKey<DesaturationKey>[] = [ { at: 4, name: 'golden', values: { amount: - 0.163, cool: 0 } }, { at: 9, name: 'day', values: { amount: 0.0122, cool: 0 } } ];
export const DESATURATION: DayKeys<DesaturationKey> = tuneKeys( 'post.desaturate', {
	day: DESATURATION_DAY,
	rising: [ { at: - 1, name: 'dawn', values: { amount: 0.6, cool: 1 } }, { at: 1.5, values: DESATURATION_DAY[ 0 ].values }, ...DESATURATION_DAY ],
	cloudy: { amount: 0.08, cool: 0 },
	night: { amount: 0.481, cool: 0 },
}, { amount: { min: - 0.5, max: 1 }, cool: { min: 0, max: 1 } } );
// The edges of the desaturation's cool share (`coolShare`, post/PipelineDisplay.ts): its blue less its
// red as a share of its spread, from `from` (none of it cool) to `to` (all of it).
// Tunable on debug pages (debug/Tune.ts): `post.desaturate.coolFrom`, `post.desaturate.coolTo`.
export const COOL_SHARE = { from: 0, to: 0.6 };
// Overcast's highlights toward grey: the grade's tables' linear output c becomes
// c + ( Y( c ) - c ) amount smoothstep( from, to, Y( c ) ) share, `share` overcast's share in the sky
// times one less the night's weight (as its white, WHITE_OVERCAST: none at night, and nothing at all
// where the sky holds no overcast). Overcast's white, which turns the deck away from the sun
// blue-green grey and the meadow green, turned the bright sky about the sun cyan too (OKLab a -0.033
// at a lightness of 0.74, 10 to 30 degrees from it), and a warmer white turns the deck and the
// meadow back. The deck lies under `from` (a display lightness of about 0.35, the deck about 0.32)
// and keeps its colour; the meadow straddles it: its hue stays, its median chroma falls by about a
// fifth (0.083 to 0.065), and the lit grass above a lightness of 0.55 keeps under half its chroma.
// `from` and `to` are linear luminances of the tables' output (display lightness about 0.35 and
// 0.70); amount 0.58 brings the sky 10 to 30 degrees from the sun to a -0.014 and 30 to 60 degrees
// to about a -0.024 (-0.024 at a sun of 22 degrees, -0.025 at 15), and the glow within 10 degrees
// of it to a chroma under 0.01.
// Tunable on debug pages (debug/Tune.ts): `post.highlight.amount`, `from`, `to`.
export const HIGHLIGHT_GREY = { amount: 0.58, from: 0.067, to: 0.4 };

/** The bloom's strength (times the time's and the weather's, and its share is the threshold's:
 * PhysicalBloom.ts BLOOM) and the vignette's strength (VIGNETTE). No grain: a dither of half a
 * code value is all the noise the frame takes. */
export const TIDEWATER_GRADE: Readonly<Pick<PipelineSettings, 'bloom' | 'vignette'>> = {
	bloom: 1.36, vignette: 1,
};
// The vignette's shape: with r the distance from the frame's centre in its own uv (round in uv,
// not in pixels), the factor mix( 1, 1 - depth smoothstep( inner, outer, r ), strength ), a radial
// smoothstep. Nothing changes out to the middle of each edge (r = 0.5); the smoothstep leaves 1
// with no slope there, so the darkening starts with no visible edge, and at strength 1 the corners
// (r = 0.71) end at about 0.73, about 0.45 stops (the falloff spans to r = 1, past the corners, so
// they sit on its steepening first half: 0.98 at r = 0.55, 0.92 at 0.6, 0.84 at 0.65).
export const VIGNETTE = { inner: 0.5, outer: 1, depth: 0.73 };
// The white balance, as the colour white becomes (linear Rec.709), by the sun's elevation, under a
// clouded sky and at night (DayKeys.ts), set with the light. A clear day pushes the display past
// neutral toward cool, the sun's warmth on the lit ground held back: furthest at a sun of 9 degrees
// (red half of green, blue 1.36), which keeps the low sun's rock and meadow, and less by 40 degrees
// (red 0.59, blue 1.25, the `high` key), where the stronger cast would turn sunlit rock blue. The
// high key moves with the sky's (look/SkyLook.ts SKY_LIGHT), which takes the inverse, so the sky holds its
// colour. The golden hour warms a little further (red 1.05, blue 0.9); the clouded skies take a cool
// white too (red 0.78, blue 1.16), their grey light kept from reading warm. Overcast takes a cooler
// white of its own (red 0.49, blue 1.14, WHITE_OVERCAST): under the clouded key its slightly warm
// grey deck read as a neutral grey and the meadow under it as yellow-green (hue 120); its own key
// brings the deck to a blue-green grey (OKLab a -0.022, b -0.008) and the meadow to green (hue
// 132), the lightness all but unchanged. It comes in over the clouded day's white by overcast's share in
// the sky, before the night's, so an overcast night takes the night's white as any other.
// The night takes a cool white too (red 0.53, blue 1.2), on top of the moon's light and the rods'
// (Purkinje.ts).
// The rising sun takes a cold white where the setting sun takes the warm one (`dawn`, in place of
// the golden key while the sun climbs: DayKeys.ts `rising`; red 0.4, blue 2, tuned on our own
// views): all that the sun does not reach at dawn is blue, sky, water and rock alike, and a face turned
// to the sun takes a pale warm colour, far less orange than the same face at the same height in
// the evening. It is what moves the rose band over the horizon, which the sky's own light
// (look/SkyLook.ts SKY_LIGHT, its `dawn` key) cannot reach. The sides are one from the `day` key up.
// Tunable on debug pages (debug/Tune.ts): `post.white.<r|g|b>@golden`, `@dawn`, `@day`, `@high`,
// `@cloudy`, `@overcast`, `@night`.
const WHITE_RANGE = { r: { min: 0.2, max: 1.5 }, g: { min: 0.5, max: 1.5 }, b: { min: 0.5, max: 3 } };
const WHITE_FROM_DAY: DayKey<{ r: number; g: number; b: number }>[] = [ { at: 9, name: 'day', values: { r: 0.5, g: 1, b: 1.36 } }, { at: 40, name: 'high', values: { r: 0.593, g: 1, b: 1.248 } } ];
export const WHITE_BALANCE: DayKeys<{ r: number; g: number; b: number }> = tuneKeys( 'post.white', {
	day: [ { at: 4, name: 'golden', values: { r: 1.05, g: 1, b: 0.9 } }, ...WHITE_FROM_DAY ],
	rising: [ { at: 4, name: 'dawn', values: { r: 0.4, g: 1, b: 2.0 } }, ...WHITE_FROM_DAY ],
	cloudy: { r: 0.775, g: 1, b: 1.16 },
	night: { r: 0.527, g: 1, b: 1.2 },
}, WHITE_RANGE );
// overcast's own white (WHITE_BALANCE's header), over the clouded day's by overcast's share
export const WHITE_OVERCAST = tuneObject( { r: 0.49, g: 1, b: 1.14 },
	{ r: 'post.white.r@overcast', g: 'post.white.g@overcast', b: 'post.white.b@overcast' }, WHITE_RANGE );
