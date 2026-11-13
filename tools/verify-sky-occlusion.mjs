// Run with a Node version supporting TypeScript stripping: node tools/verify-sky-occlusion.mjs.
// --world also generates the page's world twice (from its chunks, tools/world-node.mjs), with and
// without the contact shade, and checks geometry/placement invariance.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { boundedSceneField, localSkyVisibility, contactVisibilitySampler } from '../packages/island/world/SkyOcclusion.ts';
import { surfaceNets } from '../packages/island/world/SurfaceNets.ts';
import { VEGETATION_STRIDE } from '../packages/island/world/types.ts';
import { generateWorld } from './world-node.mjs';

const plane = ( x, y, z ) => y;
const sphere = ( x, y, z ) => Math.hypot( x, y - 0.8, z ) - 0.35;
const wall = ( x, y, z ) => 0.015 - x;
const probe = ( field, options = {} ) => localSkyVisibility( field, 0, 0, 0, 0, 1, 0, options );
assert.equal( probe( plane ), 1, 'An isolated plane must retain its entire outward sky hemisphere.' );
const sphereVisibility = probe( sphere, { samples: 512, steps: 40 } );
const analyticSphereVisibility = 1 - ( 0.35 / ( 0.8 - 0.06 ) ) ** 2;
assert.ok( Math.abs( sphereVisibility - analyticSphereVisibility ) < 0.02, 'An overhead sphere must block its cosine-weighted projected solid angle.' );
const wallVisibility = probe( wall, { samples: 1024, steps: 40 } );
assert.ok( Math.abs( wallVisibility - 0.5 ) < 0.025, 'A wall immediately beside the receiver must block about half of its sky.' );
assert.equal( probe( ( x, y, z ) => Math.hypot( x, y - 4, z ) - 0.5 ), 1, 'Solids outside the finite contact radius must not darken the receiver.' );
assert.equal( probe( ( x, y, z ) => 0.35 - Math.max( Math.abs( x ), Math.abs( y ), Math.abs( z ) ) ), 0, 'The enclosing walls of a small cavity must block the entire local sky.' );

const sphereBounds = { field: sphere, min: [ - 0.35, 0.45, - 0.35 ], max: [ 0.35, 1.15, 0.35 ] };
const planeBounds = { field: plane, min: [ - 2, - 1, - 2 ], max: [ 2, 0, 2 ] };
let remoteEvaluations = 0;
const remote = {
	field: ( x, y, z ) => { remoteEvaluations ++; return Math.hypot( x - 100, y, z ) - 1; },
	min: [ 99, - 1, - 1 ], max: [ 101, 1, 1 ],
};
const bounded = boundedSceneField( [ sphereBounds, planeBounds, remote ] );
for ( let y = - 0.3; y <= 1.4; y += 0.1 ) {

	assert.ok( Math.abs( bounded( 0, y, 0 ) - Math.min( 1.8, plane( 0, y, 0 ), sphere( 0, y, 0 ) ) ) < 1e-10, 'Bounded union must keep the full signed minimum of overlapping nearby solids.' );

}
assert.equal( remoteEvaluations, 0, 'A distant rock must be culled before its expensive SDF is evaluated.' );
const enclosingSphere = {
	field: ( x, y, z ) => Math.hypot( x, y - 0.8, z ) - 0.6,
	min: [ - 0.6, 0.2, - 0.6 ], max: [ 0.6, 1.4, 0.6 ],
};
assert.equal( boundedSceneField( [ sphereBounds, enclosingSphere ] )( 0, 0.8, 0 ), - 0.6, 'The second solid must still contribute when the first signed minimum is already negative.' );
const isolated = contactVisibilitySampler( [ planeBounds ], plane );
const neighbouring = contactVisibilitySampler( [ planeBounds, sphereBounds ], plane );
assert.equal( isolated( 0, 0, 0, 0, 1, 0 ), 1 );
assert.ok( neighbouring( 0, 0, 0, 0, 1, 0 ) < 0.9, 'The same receiver must respond when a separate nearby solid is added.' );

// Exercise the mesher's wiring, including geometry invariance and a cross-object contact.
const options = { min: [ - 0.4, - 0.1, - 0.4 ], max: [ 0.4, 0.1, 0.4 ], voxel: 0.1 };
const original = surfaceNets( plane, options );
const contacted = surfaceNets( plane, { ...options, aoSdf: bounded, contactVisibility: neighbouring } );
for ( const key of [ 'positions', 'normals', 'indices', 'tint', 'curv' ] ) assert.deepEqual( contacted[ key ], original[ key ] );
assert.ok( original.ao.every( ( value ) => value === 1 ) );
assert.ok( contacted.ao.some( ( value ) => value < 0.8 ) );
console.log( JSON.stringify( { isolated: 1, neighbouring: neighbouring( 0, 0, 0, 0, 1, 0 ), sphereVisibility, analyticSphereVisibility, wallVisibility, remoteEvaluations }, null, 2 ) );

if ( process.argv.includes( '--world' ) ) {

	const generate = ( contactOcclusion ) => {

		const start = performance.now();
		const data = generateWorld( { contactOcclusion } );
		return { data, elapsedMs: performance.now() - start };

	};
	const before = generate( false ), after = generate( true );
	assert.equal( 'stacks' in after.data, false, 'The current scene has no exposed stack API.' );
	assert.equal( 'stacks' in before.data, false );
	// the island's parts (a mesh per land chunk) taken together, and the stones
	const meshesOf = ( data ) => {

		const parts = data.islands.map( ( part ) => part.mesh );
		const join = ( key ) => {

			const out = new parts[ 0 ][ key ].constructor( parts.reduce( ( n, p ) => n + p[ key ].length, 0 ) );
			parts.reduce( ( offset, p ) => { out.set( p[ key ], offset ); return offset + p[ key ].length; }, 0 );
			return out;

		};
		const island = Object.fromEntries( [ 'positions', 'normals', 'indices', 'tint', 'curv', 'ao' ].map( ( key ) => [ key, join( key ) ] ) );
		return [ { name: 'island', ...island }, { name: 'rocks', ...data.stones } ];

	};
	const afterMeshes = meshesOf( after.data ), beforeMeshes = meshesOf( before.data );
	const rocksMesh = after.data.stones;
	assert.ok( rocksMesh && rocksMesh.positions.length > 0 );
	let maximumRockY = - Infinity;
	for ( let k = 1; k < rocksMesh.positions.length; k += 3 ) maximumRockY = Math.max( maximumRockY, rocksMesh.positions[ k ] );
	assert.ok( maximumRockY <= - 1.15, 'All offshore stones must remain below the accepted submergence limit.' );
	assert.deepEqual( after.data.rocks, before.data.rocks );
	assert.ok( after.data.rimGround.data.length > 0, 'The meadow transition field must be transferred.' );
	assert.deepEqual( after.data.rimGround, before.data.rimGround );
	assert.deepEqual( after.data.shore, before.data.shore );
	assert.deepEqual( after.data.seabed.positions, before.data.seabed.positions );
	assert.equal( after.data.vegetation.length, before.data.vegetation.length );
	for ( let k = 0; k < after.data.vegetation.length; k += VEGETATION_STRIDE ) {

		assert.equal( after.data.vegetation[ k + 7 ], 0, 'Vegetation must remain on the main island.' );
		for ( let j = 0; j < 8; j ++ ) assert.equal( after.data.vegetation[ k + j ], before.data.vegetation[ k + j ] );

	}
	const finiteVisibility = ( values ) => assert.ok( values.every( ( value ) => Number.isFinite( value ) && value >= 0 && value <= 1 ) );
	finiteVisibility( after.data.seabed.ao );
	const changes = [];
	for ( let m = 0; m < afterMeshes.length; m ++ ) {

		const a = afterMeshes[ m ], b = beforeMeshes[ m ];
		for ( const key of [ 'positions', 'normals', 'indices', 'tint', 'curv' ] ) assert.deepEqual( a[ key ], b[ key ] );
		finiteVisibility( a.ao );
		let changed = 0, visibleChanged = 0, visible = 0, sumChange = 0;
		for ( let i = 0; i < a.ao.length; i ++ ) {

			assert.ok( a.ao[ i ] <= b.ao[ i ] + 1e-6, 'Adding visibility constraints must not brighten the original AO.' );
			if ( a.ao[ i ] < b.ao[ i ] - 0.001 ) changed ++;
			if ( a.positions[ i * 3 + 1 ] > 0 ) {

				visible ++;
				if ( a.ao[ i ] < b.ao[ i ] - 0.001 ) visibleChanged ++;
				sumChange += b.ao[ i ] - a.ao[ i ];

			}

		}
		changes.push( { name: a.name, changed, aboveWaterChanged: visibleChanged, aboveWaterMeanReduction: visible ? sumChange / visible : 0 } );

	}
	const anchors = [];
	for ( let k = 8; k < after.data.vegetation.length; k += VEGETATION_STRIDE ) anchors.push( after.data.vegetation[ k ] );
	finiteVisibility( anchors );
	const minSeabedAO = after.data.seabed.ao.reduce( ( a, b ) => Math.min( a, b ), 1 );
	assert.ok( minSeabedAO < 0.8, 'The sea floor must respond to nearby island/rock geometry.' );
	console.log( JSON.stringify( {
		beforeMs: before.elapsedMs, afterMs: after.elapsedMs, overheadMs: after.elapsedMs - before.elapsedMs,
		beforeTimings: before.data.timings, afterTimings: after.data.timings, geometryAndPlacementUnchanged: true,
		minSeabedAO, maximumRockY, submergedStoneCount: after.data.rocks.length,
		changedVegetationAnchors: anchors.filter( ( value ) => value < 0.999 ).length,
		minVegetationVisibility: Math.min( ...anchors ), meshChanges: changes,
	}, null, 2 ) );

}
