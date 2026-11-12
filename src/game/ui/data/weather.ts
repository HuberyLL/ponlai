import { DAY_PRESETS } from '../../../sky/DayCycle.ts';
import type { WeatherName } from '../../../sky/Weather.ts';
import { t } from '../i18n/i18n.ts';
import type { Catalogue } from '../i18n/i18n.ts';

// The kinds of weather the player is shown (docs/explanation/ui.md, Weather forecast): 晴 (clear and fair: a third of
// the sky in small cloud is still a fine day), 多云 (the parked cloudy) and 阴 (the parked overcast), with night faces for 晴 (the moon) and
// 多云 (the moon behind cloud). The parked kinds (雨, 风暴, 雾) join as rows when their weathers
// return (src/sky/Weather.ts PARKED_WEATHER); until then a wet sky loaded in a debug build shows
// as the nearest kind, 阴.
//
// Each kind says how the live icon draws it (Forecast.ts blends the kinds of a front by these
// numbers, so a new kind needs no new code there): `light` whether the sun (or moon) shows, `cover`
// how far its cloud has taken the sky (the light shrinks toward the upper left behind it), `cloud`
// where its cloud sits (the cloud's offset in the icon's units; null: none) and `back` whether a
// second cloud stands behind. `rank` orders kinds from fine to bad: of two turns of the forecast
// too close to show both, the worse one stays. A kind's name is the catalogue's (i18n/zh-CN.json
// `weather.kind`, by id), resolved when the table loads.

type KindId = keyof Catalogue[ 'weather' ][ 'kind' ];

export interface WeatherKind {
	id: KindId;
	name: string;
	/** the engine's skies this kind shows */
	engine: readonly WeatherName[];
	rank: number;
	/** its icon by day, and by night when it has a night face (Icons.ts) */
	icon: string;
	night?: string;
	live: { light: number; cover: number; cloud: readonly [ number, number ] | null; back: number };
}

const kind = ( k: Omit<WeatherKind, 'name'> ): WeatherKind => ( { ...k, name: t( `weather.kind.${ k.id }` ) } );

export const WEATHER_KINDS: readonly WeatherKind[] = [
	kind( { id: 'clear', engine: [ 'clear', 'fair' ], rank: 0, icon: 'sun', night: 'moon', live: { light: 1, cover: 0, cloud: null, back: 0 } } ),
	kind( { id: 'cloudy', engine: [ 'cloudy' ], rank: 1, icon: 'cloud', night: 'cloudNight', live: { light: 1, cover: 1, cloud: [ 2, 7 ], back: 0 } } ),
	kind( { id: 'overcast', engine: [ 'overcast' ], rank: 2, icon: 'overcast', live: { light: 0, cover: 1, cloud: [ - 1, 7 ], back: 1 } } ),
];

/** The kind a sky of the engine shows as (a wet sky: the nearest kind, 阴). */
export function weatherKind( sky: WeatherName ): WeatherKind {

	return WEATHER_KINDS.find( ( k ) => k.engine.includes( sky ) ) ?? WEATHER_KINDS[ WEATHER_KINDS.length - 1 ];

}

/** A kind's icon at an hour of the day: its night face from sunset to sunrise, if it has one. */
export function weatherIcon( kind: WeatherKind, hour: number ): string {

	return kind.night && isNight( hour ) ? kind.night : kind.icon;

}

const SUNRISE = DAY_PRESETS.sunrise, SUNSET = DAY_PRESETS.sunset;
const smooth = ( a: number, b: number, x: number ) => {

	const k = Math.min( Math.max( ( x - a ) / ( b - a ), 0 ), 1 );
	return k * k * ( 3 - 2 * k );

};
const wrap = ( hour: number ) => ( ( hour % 24 ) + 24 ) % 24;

/** Whether an hour of the day is night (the day cycle's sunset to sunrise). */
export function isNight( hour: number ): boolean {

	const h = wrap( hour );
	return h < SUNRISE || h >= SUNSET;

}

/** 0 by day, 1 by night, turning over the forty minutes around sunrise and sunset. */
export function nightness( hour: number ): number {

	const h = wrap( hour );
	return 1 - smooth( SUNRISE - 0.35, SUNRISE + 0.35, h ) + smooth( SUNSET - 0.35, SUNSET + 0.35, h );

}
