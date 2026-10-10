// Locality checks for the world generators (plain node, CPU only):
//   node tools/verify-world-local.mjs [--seeds 1,2] [--grow 0,8]
//
// A generator is local when what it makes inside a box depends only on that box (and the land and
// fields every box shares), never on what else was built before it: that is what lets a chunk be
// rebuilt alone when the island grows. Each case is a module in tools/world-local/*.mjs exporting
//   name                      a short label for the report;
//   setup( { seed, grow } )   builds what the case needs once per seed and step (the land, shared
//                             fields) and returns a context with `boxes`, the boxes to check, each
//                             { x0, z0, x1, z1 } in world metres (half-open);
//   build( ctx, box )         makes the records whose position lies in `box`, from `box` alone, as
//                             parallel fields of one record set, { field: typedArray } (one value
//                             per record) or { field: { records, stride } }, every field with the
//                             same record count and the position the first field (a build that
//                             makes several kinds of record checks each kind in its own case).
// For every seed, step and box the runner builds the box whole and as 2 x 2 sub-boxes and compares
// the whole against the union as position-sorted sets, bit for bit, every field sorted by the same
// permutation so an attribute must stay on its own record (`subBoxCheck` in world-node.mjs).
// A mismatch prints the first differing field, record and the largest difference, and the run exits
// with 1. One file per case, so tasks that add cases never edit the same file.
import { readdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { subBoxCheck } from './world-node.mjs';

const argument = ( name, fallback ) => {

	const i = process.argv.indexOf( name );
	return ( i < 0 ? fallback : process.argv[ i + 1 ] ).split( ',' ).map( Number );

};
const seeds = argument( '--seeds', '1,2' ), steps = argument( '--grow', '0,8' );

const directory = new URL( './world-local/', import.meta.url );
const files = ( await readdir( directory ) ).filter( ( file ) => file.endsWith( '.mjs' ) ).sort();
if ( files.length === 0 ) {

	console.log( 'No cases in tools/world-local/.' );
	process.exit( 0 );

}

let failed = 0;
for ( const file of files ) {

	const { name, setup, build } = await import( new URL( file, directory ) );
	for ( const seed of seeds ) for ( const grow of steps ) {

		const start = performance.now();
		const ctx = await setup( { seed, grow } );
		let ok = true;
		for ( const box of ctx.boxes ) {

			const label = `${ name } seed ${ seed } grow ${ grow } box [${ box.x0 }, ${ box.z0 }]-[${ box.x1 }, ${ box.z1 }] `;
			if ( ! await subBoxCheck( { build: ( b ) => build( ctx, b ), box, label } ) ) ok = false;

		}
		console.log( `${ ok ? 'ok  ' : 'FAIL' } ${ name } seed ${ seed } grow ${ grow } (${ ctx.boxes.length } boxes, ${ ( performance.now() - start ).toFixed( 0 ) } ms)` );
		if ( ! ok ) failed ++;

	}

}
if ( failed ) {

	console.log( `${ failed } case runs failed.` );
	process.exit( 1 );

}
