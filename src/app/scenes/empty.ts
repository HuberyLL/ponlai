// The empty scene's light: the sky and level grey ground without end, and nothing else. It shows
// what the sky and the key give a scene by themselves through the day: the sky's luminance toward
// the sun, away from it and overhead, and the ground's light under it, at eight hours of a clear
// and of a fair day, the hours before sunrise, after sunset and at midnight among them. Its
// readings make a day's curve, which is judged by its continuity and by the key's illuminance
// against the sky's.
//
// The views (m): the sun rises in the east (+x) and sets in the west, so one view looks west, one
// east, and one straight up; each hour has the sun before one of them or behind it.
import type { SceneReading, SceneTime, TestScene, Triple } from './TestScene.ts';
import { groundDisc, surface } from './TestScene.ts';

const GROUND = 2, GREY = 0.18, EYE = GROUND + 1.7;

// a direction at an elevation (degrees) over a heading on the ground
const up = ( x: number, z: number, elevation: number ): Triple => {

	const e = elevation * Math.PI / 180;
	return [ x * Math.cos( e ), Math.sin( e ), z * Math.cos( e ) ];

};

// the sky at three heights over the horizon in the two level views, overhead in the third, and the
// ground before each level view
const readings: SceneReading[] = [
	...[ 5, 20, 40 ].flatMap( ( elevation ): SceneReading[] => [
		{ name: `sky-west-${ elevation }`, toward: up( - 1, 0, elevation ), size: 0.04 },
		{ name: `sky-east-${ elevation }`, toward: up( 1, 0, elevation ), size: 0.04 },
	] ),
	{ name: 'sky-zenith', toward: [ 0, 1, 0 ], size: 0.04 },
	{ name: 'ground-west', at: [ - 12, GROUND, 0 ], size: 0.04 },
	{ name: 'ground-east', at: [ 12, GROUND, 0 ], size: 0.04 },
];

const HOURS: [ string, string ][] = [
	[ 'midnight', 'preset=midnight' ],
	[ 'dawn', 'preset=dawn' ],
	[ 'sunrise', 'preset=sunrise' ],
	[ 'morning', 'hour=9' ],
	[ 'noon', 'preset=noon' ],
	[ 'afternoon', 'hour=15' ],
	[ 'sunset', 'preset=sunset' ],
	[ 'dusk', 'preset=dusk' ],
];

export const empty: TestScene = {
	name: 'empty',
	about: 'the sky\'s and the key\'s light on empty level ground through a clear and a fair day',
	ground: { height: GROUND, albedo: [ GREY, GREY, GREY ] },
	build() {

		return { objects: [ groundDisc( GROUND, surface( 'ground', [ GREY, GREY, GREY ] ) ) ], casters: null };

	},
	views: [
		{ name: 'west', eye: [ 0, EYE, 0 ], target: [ - 100, EYE + 30, 0 ], fov: 60 },
		{ name: 'east', eye: [ 0, EYE, 0 ], target: [ 100, EYE + 30, 0 ], fov: 60 },
		{ name: 'zenith', eye: [ 0, EYE, 0 ], target: [ 0.001, EYE + 100, 0 ], fov: 60 },
	],
	times: [ 'clear', 'fair' ].flatMap( ( weather ) => HOURS.map( ( [ name, hour ] ): SceneTime => ( { name: `${ weather }-${ name }`, query: `weather=${ weather }&${ hour }` } ) ) ),
	readings,
};
