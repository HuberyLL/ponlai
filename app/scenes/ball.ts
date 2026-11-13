// The material balls: the light on plain surfaces. On level grey ground stand a row of balls whose
// roughness runs from 0 to 1, a row whose albedo runs from 0.03 to 0.8, an 18 % grey card and a
// white card lying flat, and an upright post that casts a shadow. It shows the key against the
// ambient light, the shade on flat ground, the specular's answer to the sky and the exposure a
// grey card lands at, by day, at a low sun and by night.
//
// The layout (m, x to the east): the rows run along x, so the long shadows of a low sun, which
// fall east or west, run along the rows and miss the cards in front of them; the post stands
// apart to the north-east, and its shade's reading follows the key.
import * as THREE from 'three/webgpu';
import type { ReadingContext, SceneReading, TestScene, Triple } from './TestScene.ts';
import { groundDisc, surface } from './TestScene.ts';

const GROUND = 2, GREY = 0.18;
const BALLS = 7, RADIUS = 0.5, STEP = 1.5;
// the rows' z: the roughness row in front, the albedo row behind it
const ROUGH_Z = 0, ALBEDO_Z = - 4;
// the albedo row's ends (linear)
const ALBEDO = [ 0.03, 0.8 ];
// the roughness row's albedo, and the albedo row's roughness
const ROUGH_ALBEDO = 0.5, ALBEDO_ROUGHNESS = 0.6;
// the cards (1 m squares lying flat) and the post (a square column)
const CARD_Z = 3, CARD = 1, GREY_X = - 1.25, WHITE_X = 1.25, WHITE = 0.9;
const POST = { x: 9, z: - 9, side: 1, height: 3 };

const ballX = ( k: number ) => ( k - ( BALLS - 1 ) / 2 ) * STEP;
// the albedo row's albedos: even steps of lightness (a geometric run)
const albedoAt = ( k: number ) => ALBEDO[ 0 ] * ( ALBEDO[ 1 ] / ALBEDO[ 0 ] ) ** ( k / ( BALLS - 1 ) );

// Where the post's shade lies on the ground: the shadow of the point half way up the post, at
// most 2.5 m from it (a key near the horizon throws it farther, behind the balls as the front view
// sees them). The post is a metre wide, so the reading's box lies inside the shade, clear of its
// soft edges. `aside` moves the point out of the shade, to the side the views look from.
function shade( { key }: ReadingContext, aside = 0 ): Triple {

	const flat = Math.hypot( key.x, key.z ) || 1;
	const reach = Math.min( 0.5 * POST.height * flat / Math.max( key.y, 1e-3 ), 2.5 );
	const dx = - key.x / flat, dz = - key.z / flat;
	return [ POST.x + dx * reach + dz * aside, GROUND, POST.z + dz * reach - dx * aside ];

}

const readings: SceneReading[] = [
	{ name: 'grey-card', at: [ GREY_X, GROUND + 0.02, CARD_Z ] },
	{ name: 'white-card', at: [ WHITE_X, GROUND + 0.02, CARD_Z ] },
	{ name: 'ground-lit', at: ( context ) => shade( context, 2.5 ) },
	{ name: 'ground-shade', at: ( context ) => shade( context ), size: 0.008 },
	// the middle of each ball's disc
	...Array.from( { length: BALLS }, ( _, k ): SceneReading => ( { name: `rough-${ k }`, at: [ ballX( k ), GROUND + RADIUS, ROUGH_Z ], size: 0.008 } ) ),
	...Array.from( { length: BALLS }, ( _, k ): SceneReading => ( { name: `albedo-${ k }`, at: [ ballX( k ), GROUND + RADIUS, ALBEDO_Z ], size: 0.008 } ) ),
];

export const ball: TestScene = {
	name: 'ball',
	about: 'the light on plain surfaces: balls by roughness and by albedo, a grey and a white card, a post\'s shade',
	ground: { kind: 'land', height: GROUND, albedo: [ GREY, GREY, GREY ] },
	build() {

		const ground = groundDisc( GROUND, surface( 'ground', [ GREY, GREY, GREY ] ) );
		const things = new THREE.Group();
		things.name = 'things';
		const add = ( mesh: THREE.Mesh, name: string ) => {

			mesh.name = name;
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			things.add( mesh );

		};
		const sphere = new THREE.SphereGeometry( RADIUS, 48, 24 );
		for ( let k = 0; k < BALLS; k ++ ) {

			const rough = new THREE.Mesh( sphere, surface( `rough-${ k }`, [ ROUGH_ALBEDO, ROUGH_ALBEDO, ROUGH_ALBEDO ], { roughness: k / ( BALLS - 1 ) } ) );
			rough.position.set( ballX( k ), GROUND + RADIUS, ROUGH_Z );
			add( rough, `rough-${ k }` );
			const a = albedoAt( k );
			const pale = new THREE.Mesh( sphere, surface( `albedo-${ k }`, [ a, a, a ], { roughness: ALBEDO_ROUGHNESS } ) );
			pale.position.set( ballX( k ), GROUND + RADIUS, ALBEDO_Z );
			add( pale, `albedo-${ k }` );

		}
		const card = new THREE.BoxGeometry( CARD, 0.02, CARD );
		const grey = new THREE.Mesh( card, surface( 'grey-card', [ GREY, GREY, GREY ] ) );
		grey.position.set( GREY_X, GROUND + 0.01, CARD_Z );
		add( grey, 'grey-card' );
		const white = new THREE.Mesh( card, surface( 'white-card', [ WHITE, WHITE, WHITE ] ) );
		white.position.set( WHITE_X, GROUND + 0.01, CARD_Z );
		add( white, 'white-card' );
		const post = new THREE.Mesh( new THREE.BoxGeometry( POST.side, POST.height, POST.side ), surface( 'post', [ GREY, GREY, GREY ] ) );
		post.position.set( POST.x, GROUND + POST.height / 2, POST.z );
		add( post, 'post' );
		things.updateMatrixWorld( true );
		return { objects: [ ground, things ], casters: new THREE.Box3().setFromObject( things ) };

	},
	views: [
		// the whole layout from the south, a little above eye height
		{ name: 'front', eye: [ 1.5, GROUND + 7, 19 ], target: [ 1.5, GROUND, - 2.5 ], fov: 34 },
		// from above the cards, steep, for the cards, the balls' tops and the post's shade
		{ name: 'high', eye: [ 2, GROUND + 22, 12 ], target: [ 2, GROUND, - 2 ], fov: 34 },
	],
	times: [
		{ name: 'clear-noon', query: 'weather=clear&preset=noon' },
		{ name: 'clear-afternoon', query: 'weather=clear&hour=15' },
		// the sun about 12 degrees up: long shadows that still miss the cards
		{ name: 'clear-low-sun', query: 'weather=clear&hour=17' },
		{ name: 'clear-night', query: 'weather=clear&preset=midnight' },
		{ name: 'fair-noon', query: 'weather=fair&preset=noon' },
	],
	readings,
};
