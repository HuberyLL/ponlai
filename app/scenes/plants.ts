// A patch of plants: one plant kind registered without art of its own, so the registry draws it with
// the default plant (vegetation/DefaultPlant.ts), scattered over a 32 m square of level grey
// ground, and an upright post among them whose shade falls across them. It shows a plant kind
// placed, lit, shadowed and measured through the registry alone: the leaves in the key and in the
// shade, against the sky's light, by day, at a low sun and in a light and a strong wind.
//
// The layout (m): the patch is a square round the origin, a site in each cell of a world-anchored
// grid that a hash of the cell keeps or leaves and moves about inside the cell, so the scatter is a
// function of the cell alone. The post stands at the origin, the plants kept clear of it. The views
// look from the north-west over the patch, toward the noon sun, so the post's shade falls toward
// them by day and to the west at a low sun.
import * as THREE from 'three/webgpu';
import type { PlantSite } from '../../packages/render/index.ts';
import type { ReadingContext, SceneReading, TestScene, Triple } from './TestScene.ts';
import { groundDisc, surface } from './TestScene.ts';

const GROUND = 2, GREY = 0.18;
// the patch: its half side, its cells' side, the share of cells that hold a plant, how far a site
// moves inside its cell (a share of the cell) and the clearing round the post
const HALF = 16, CELL = 1, KEEP = 0.7, JITTER = 0.35, CLEAR = 0.3;
const POST = { side: 1, height: 4 };
// the plants' middle height, where the readings look at them
const LEAVES = 0.5;

// A hash of a cell and a salt to [ 0, 1 ): integer mixing (a murmur3-style finaliser), so a cell's
// draw is its own and never the next one's of a running stream.
function hash( i: number, j: number, salt: number ): number {

	let h = Math.imul( i, 0x27d4eb2d ) ^ Math.imul( j, 0x165667b1 ) ^ Math.imul( salt + 1, 0x9e3779b1 );
	h = Math.imul( h ^ ( h >>> 15 ), 0x85ebca6b );
	h = Math.imul( h ^ ( h >>> 13 ), 0xc2b2ae35 );
	return ( ( h ^ ( h >>> 16 ) ) >>> 0 ) / 4294967296;

}

// the patch's sites, row by row
function sites(): PlantSite[] {

	const out: PlantSite[] = [];
	const n = HALF / CELL;
	for ( let j = - n; j < n; j ++ ) for ( let i = - n; i < n; i ++ ) {

		if ( hash( i, j, 0 ) >= KEEP ) continue;
		const x = ( i + 0.5 + ( hash( i, j, 1 ) * 2 - 1 ) * JITTER ) * CELL;
		const z = ( j + 0.5 + ( hash( i, j, 2 ) * 2 - 1 ) * JITTER ) * CELL;
		if ( Math.max( Math.abs( x ), Math.abs( z ) ) < POST.side / 2 + CLEAR ) continue;
		out.push( { x, y: GROUND, z } );

	}
	return out;

}

// Where the post's shade lies on the plants: the shadow, at the leaves' height, of the point three
// quarters up the post (past the clearing at noon), at most 4 m from it. `aside` moves the point
// out of the shade, sideways.
function shade( { key }: ReadingContext, aside = 0 ): Triple {

	const flat = Math.hypot( key.x, key.z ) || 1;
	const reach = Math.min( ( POST.height * 0.75 - LEAVES ) * flat / Math.max( key.y, 1e-3 ), 4 );
	const dx = - key.x / flat, dz = - key.z / flat;
	return [ dx * reach + dz * aside, GROUND + LEAVES, dz * reach - dx * aside ];

}

const readings: SceneReading[] = [
	{ name: 'patch-shade', at: ( context ) => shade( context ), size: 0.015 },
	{ name: 'patch-lit', at: ( context ) => shade( context, 2.5 ), size: 0.015 },
	// the patch near the views and across it, and the open ground before it
	{ name: 'patch-near', at: [ 0, GROUND + LEAVES, - 12 ], size: 0.03 },
	{ name: 'patch-far', at: [ 0, GROUND + LEAVES, 12 ], size: 0.02 },
	{ name: 'ground-open', at: [ 0, GROUND, - 20 ], size: 0.02 },
];

export const plants: TestScene = {
	name: 'plants',
	about: 'a plant kind through the registry, drawn with the default plant: leaves in the key and in a post\'s shade, at noon, at a low sun, in a light and a strong wind',
	ground: { kind: 'land', height: GROUND, albedo: [ GREY, GREY, GREY ] },
	build() {

		const ground = groundDisc( GROUND, surface( 'ground', [ GREY, GREY, GREY ] ) );
		const post = new THREE.Mesh( new THREE.BoxGeometry( POST.side, POST.height, POST.side ), surface( 'post', [ GREY, GREY, GREY ] ) );
		post.name = 'post';
		post.position.set( 0, GROUND + POST.height / 2, 0 );
		post.castShadow = true;
		post.receiveShadow = true;
		post.updateMatrixWorld( true );
		return {
			objects: [ ground, post ],
			casters: new THREE.Box3().setFromObject( post ),
			plants: [ {
				name: 'patch', sites: sites(),
				prepass: true, shadowFilter: 'vegetation', sunCaster: true, rainBake: true,
				cost: 'none', testMode: 'stateless', land: 'independent',
			} ],
		};

	},
	views: [
		// the patch from the north-west, a little above it
		{ name: 'front', eye: [ - 4, GROUND + 5, - 36 ], target: [ 0, GROUND + LEAVES, 0 ], fov: 34 },
		// from above the patch, steep
		{ name: 'high', eye: [ 0, GROUND + 24, - 16 ], target: [ 0, GROUND, 0 ], fov: 34 },
	],
	times: [
		{ name: 'clear-noon', query: 'weather=clear&preset=noon' },
		{ name: 'clear-low-sun', query: 'weather=clear&hour=17' },
		{ name: 'wind-light', query: 'weather=clear&preset=noon&wind=light' },
		{ name: 'wind-strong', query: 'weather=clear&preset=noon&wind=strong' },
	],
	readings,
};
