// The open sea: the water alone, far from any shore and equally deep everywhere, with two balls in
// it, one floating high on the surface and one sunk to its middle, so the waterline, the light under
// the surface and the refraction through it show on plain surfaces. It shows the far sea against the
// sky over the horizon, the water's own colour seen from above and from low over it, the sun's
// glitter, and the sea's answer to the four levels of the wind.
//
// The layout (m): the sea's mean level at the renderer's sea level, its floor DEPTH under it (deep
// enough that the floor's light hardly reaches the eye: the water's own colour is what shows); the
// balls side by side along x at the origin. The glitter view follows the key: it looks toward the
// sun's reflection, down at the key's elevation (at least a few degrees), its eye at a fixed height.
import * as THREE from 'three/webgpu';
import { refractedGroup, shared, showUnderwater, underwaterLight, UnderwaterLightingModel, writeMeter, type RenderParts } from '../../packages/render/index.ts';
import type { ReadingContext, SceneReading, TestScene, Triple } from './TestScene.ts';
import { groundDisc } from './TestScene.ts';

const SEA = 0, DEPTH = 40, FLOOR = 0.18;
const RADIUS = 1, BALL = 0.5, BALL_ROUGHNESS = 0.5;
// the floating ball rides with most of it above the surface; the sunk one has its middle at it
const FLOAT: Triple = [ - 1.5, SEA + 0.6, 0 ], SUNK: Triple = [ 1.5, SEA, 0 ];
// the glitter view: the eye's height, the least elevation it looks down at, where it looks (past
// the balls toward the sun, and aside of them, so they stand beside the reflection, not in it)
const GLITTER_EYE = 10, GLITTER_LEAST = 3, GLITTER_BEYOND = 2, GLITTER_ASIDE = 3;

/** A surface lit as everything that reaches under the water is (lighting/Underwater.ts): above
 * the surface as every other surface, below it by the light carried down the water column. */
function underwaterSurface( render: RenderParts, name: string, albedo: number, roughness: number ): THREE.MeshStandardNodeMaterial {

	const material = new THREE.MeshStandardNodeMaterial( { roughness, metalness: 0 } );
	material.color.setRGB( albedo, albedo, albedo, THREE.LinearSRGBColorSpace );
	material.name = name;
	const light = underwaterLight( shared, render.waveMaps );
	( material as unknown as { setupLightingModel: () => THREE.LightingModel } ).setupLightingModel = () => new UnderwaterLightingModel( light );
	writeMeter( material );
	return material;

}

// The glitter view's pose for a key: the point GLITTER_BEYOND past the balls toward the sun and
// GLITTER_ASIDE beside them, seen along the sun's reflection from GLITTER_EYE over the sea.
function glitter( key: THREE.Vector3 ): { eye: Triple; target: Triple } {

	const flat = Math.hypot( key.x, key.z ) || 1;
	const hx = key.x / flat, hz = key.z / flat;
	const e = Math.max( Math.asin( THREE.MathUtils.clamp( key.y, - 1, 1 ) ), THREE.MathUtils.degToRad( GLITTER_LEAST ) );
	const back = GLITTER_EYE / Math.tan( e );
	const target: Triple = [ hx * GLITTER_BEYOND - hz * GLITTER_ASIDE, SEA, hz * GLITTER_BEYOND + hx * GLITTER_ASIDE ];
	return { eye: [ target[ 0 ] - hx * back, SEA + GLITTER_EYE, target[ 2 ] - hz * back ], target };

}

// a direction at an elevation (degrees) over the heading the view looks along
function ahead( { camera }: ReadingContext, elevation: number ): Triple {

	const forward = camera.getWorldDirection( new THREE.Vector3() );
	const flat = Math.hypot( forward.x, forward.z ) || 1;
	const e = THREE.MathUtils.degToRad( elevation );
	return [ forward.x / flat * Math.cos( e ), Math.sin( e ), forward.z / flat * Math.cos( e ) ];

}

const readings: SceneReading[] = [
	// the far sea just under the horizon and the sky just over it, along the view
	{ name: 'sea-far', toward: ( context ) => ahead( context, - 0.5 ), size: 0.01 },
	{ name: 'sky-low', toward: ( context ) => ahead( context, 2 ), size: 0.02 },
	// the sea near the balls, beside them and behind them
	{ name: 'sea-near', at: [ 4, SEA, 4 ], size: 0.03 },
	{ name: 'sea-behind', at: [ 0, SEA, - 6 ], size: 0.01 },
	// the sun's reflection, from wherever the eye is
	{ name: 'glitter', toward: ( { key } ) => [ key.x, - key.y, key.z ], size: 0.02 },
	// the balls' middles: the floating one's, and the sunk one's over the surface and under it
	{ name: 'float-ball', at: FLOAT, size: 0.008 },
	{ name: 'sunk-ball-above', at: [ SUNK[ 0 ], SEA + 0.5, SUNK[ 2 ] ], size: 0.008 },
	{ name: 'sunk-ball-under', at: [ SUNK[ 0 ], SEA - 0.5, SUNK[ 2 ] ], size: 0.008 },
];

export const sea: TestScene = {
	name: 'sea',
	about: 'the open sea far from any shore: the water\'s colour, the far sea against the sky, the glitter, a floating and a half-sunk ball, the wind\'s four levels',
	ground: { kind: 'sea', depth: DEPTH, floor: [ FLOOR, FLOOR, FLOOR ] },
	build( render ) {

		// everything here reaches under the surface: the refraction's camera sees it below its clip
		// height (ocean/Refraction.ts)
		const group = refractedGroup( SEA );
		group.name = 'sea things';
		const floor = groundDisc( SEA - DEPTH, underwaterSurface( render, 'floor', FLOOR, 0.9 ) );
		floor.name = 'floor';
		showUnderwater( floor );
		group.add( floor );
		const sphere = new THREE.SphereGeometry( RADIUS, 48, 24 );
		const balls = new THREE.Group();
		balls.name = 'balls';
		for ( const [ name, at ] of [ [ 'float-ball', FLOAT ], [ 'sunk-ball', SUNK ] ] as const ) {

			const ball = new THREE.Mesh( sphere, underwaterSurface( render, name, BALL, BALL_ROUGHNESS ) );
			ball.name = name;
			ball.position.set( ...at );
			ball.castShadow = true;
			ball.receiveShadow = true;
			showUnderwater( ball );
			balls.add( ball );

		}
		group.add( balls );
		group.updateMatrixWorld( true );
		return { objects: [ group ], casters: new THREE.Box3().setFromObject( balls ) };

	},
	views: [
		// the balls from above, steep, the sea round them
		{ name: 'high', eye: [ 0, SEA + 18, 22 ], target: [ 0, SEA, 0 ], fov: 34 },
		// low over the water, looking level: the horizon across the middle of the frame
		{ name: 'level', eye: [ 0, SEA + 1.2, 16 ], target: [ 0, SEA + 1.2, 0 ] },
		// toward the sun's glitter, the balls beside it
		{ name: 'glitter', eye: ( key ) => glitter( key ).eye, target: ( key ) => glitter( key ).target },
	],
	times: [
		{ name: 'clear-noon', query: 'weather=clear&preset=noon' },
		{ name: 'clear-low-sun', query: 'weather=clear&hour=17' },
		{ name: 'fair-noon', query: 'weather=fair&preset=noon' },
		// the wind's four levels (sky/Weather.ts WIND_LEVELS), at a clear noon
		{ name: 'wind-light', query: 'weather=clear&preset=noon&wind=light' },
		{ name: 'wind-gentle', query: 'weather=clear&preset=noon&wind=gentle' },
		{ name: 'wind-fresh', query: 'weather=clear&preset=noon&wind=fresh' },
		{ name: 'wind-strong', query: 'weather=clear&preset=noon&wind=strong' },
	],
	readings,
};
