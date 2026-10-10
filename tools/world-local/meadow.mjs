// The meadow's planting is local: the turf anchors a box keeps (`scatterTop`, by their jittered
// point), and the grass tufts and wildflowers grown on them (`plantGrass`, `plantFlowers`, from
// streams of each anchor's own cell), are the same built whole or in parts. One record set holds
// all three kinds: the position (an anchor's surface point, a tuft's origin, a flower's root), the
// kind, and every value the page draws from (padded to one stride).
//
// Setup also grows the whole island's meadow as the page does and compares its density per m^2 of
// land with the planting before the anchors were hashed (the running streams):
// the hashes move the plants, not their statistics. Each island's densities are printed; the
// criterion is their sum over the grown islands run (step 8 on), within 5 % for every kind. A
// starting island is printed only: it differs by sampling alone, since it holds about 400 tussocks
// and 250 flower beds and a fresh draw of either moves their count by up to 15 % there (2 sigma),
// as it would with any other seed. A run of starting islands alone judges no density.
//
// Grass.ts and Flowers.ts build three.js materials (and modules plain node cannot strip), so they
// load through Vite's SSR loader. The anchors' sky visibility (a function of the anchor's position
// and the world's solids, computed by the worker) is left at 1 here.
import { createServer } from 'vite';
import { growLand } from '../../src/world/IslandGrowth.ts';
import { buildFootprint, makeIslandSDF, landArea, ISLAND_TOP } from '../../src/world/WorldShapes.ts';
import { buildRimGround } from '../../src/world/RimGround.ts';
import { scatterTop } from '../../src/world/Anchors.ts';
import { VEGETATION_STRIDE } from '../../src/world/types.ts';

globalThis.location ??= { search: '', href: 'http://localhost/' };
const server = await createServer( {
	root: new URL( '../../', import.meta.url ).pathname, configFile: false, logLevel: 'error', appType: 'custom',
	server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] },
} );
const { plantGrass } = await server.ssrLoadModule( '/src/world/Grass.ts' );
const { plantFlowers } = await server.ssrLoadModule( '/src/world/Flowers.ts' );
const { walkLoop, walkLoopDistance } = await server.ssrLoadModule( '/src/world/WalkLoop.ts' );
await server.close();

export const name = 'meadow';

// Counts on the whole island before the hashes (the world worker's
// anchors, then buildGrass and buildFlowers with the walking loop), by seed / growth step.
const M2 = {
	'1/0': { anchors: 7105, lawn: 7004, tussocks: 486, thin: 1789, flowers: 1556 },
	'1/8': { anchors: 36163, lawn: 35910, tussocks: 2144, thin: 10150, flowers: 8227 },
	'1/12': { anchors: 49465, lawn: 49189, tussocks: 2846, thin: 13931, flowers: 11779 },
	'2/0': { anchors: 7081, lawn: 7013, tussocks: 369, thin: 1555, flowers: 1702 },
	'2/8': { anchors: 38584, lawn: 38349, tussocks: 2521, thin: 9271, flowers: 9008 },
	'2/12': { anchors: 52357, lawn: 52084, tussocks: 3357, thin: 13629, flowers: 12921 },
};

const BOX = 16, DATA = 25;

// counts over the grown islands run, against M2's: judged once the runner is done
const pooled = {};
process.once( 'beforeExit', () => {

	if ( ! Object.keys( pooled ).length ) {

		console.log( '     meadow density not judged: no grown island run (step 8 on) has M2 counts' );
		return;

	}
	const off = Object.entries( pooled ).filter( ( [ , [ n, m ] ] ) => Math.abs( n / m - 1 ) > 0.05 );
	console.log( `${ off.length ? 'FAIL' : 'ok  ' } meadow density over the grown islands run against M2: ${ Object.entries( pooled ).map( ( [ kind, [ n, m ] ] ) =>
		`${ kind } ${ ( ( n / m - 1 ) * 100 ).toFixed( 1 ) } %` ).join( ', ' ) }` );
	if ( off.length ) process.exitCode = 1;

} );

export function setup( { seed, grow } ) {

	const { land } = growLand( seed, grow );
	const fp = buildFootprint( land ), sdf = makeIslandSDF( fp ), b = fp.bounds;
	const ctx = { fp, sdf, rimGround: buildRimGround( sdf, b ), walkDistance: walkLoopDistance( walkLoop( land ) ) };

	// the page's planting over the whole island, as the worker scatters it
	const whole = plant( ctx, { x0: b.x0 - 0.6, z0: b.z0 - 0.6, x1: b.x1 + 0.6, z1: b.z1 + 0.6 } );
	const counts = { anchors: whole.anchors.length / VEGETATION_STRIDE, lawn: whole.tufts.lawn.length,
		tussocks: whole.tufts.tussocks.length, thin: whole.tufts.lawnThin.length, flowers: whole.flowers.flat().length };
	const area = landArea( land ), reference = M2[ `${ seed }/${ grow }` ];
	const percent = ( n, m ) => `${ ( ( n / m - 1 ) * 100 ).toFixed( 1 ) } %`;
	console.log( `     meadow density seed ${ seed } grow ${ grow }: ${ Object.entries( counts ).map( ( [ kind, n ] ) =>
		`${ kind } ${ ( n / area ).toFixed( 2 ) }/m2${ reference ? ` (${ percent( n, reference[ kind ] ) })` : '' }` ).join( ', ' ) }${ reference ? ' against M2' : '' }` );
	if ( reference && grow >= 8 ) for ( const kind in counts ) {

		pooled[ kind ] ??= [ 0, 0 ];
		pooled[ kind ][ 0 ] += counts[ kind ];
		pooled[ kind ][ 1 ] += reference[ kind ];

	}

	// the 16 m boxes of the world grid that hold land
	ctx.boxes = [];
	for ( let z = Math.floor( b.z0 / BOX ) * BOX; z < b.z1; z += BOX ) for ( let x = Math.floor( b.x0 / BOX ) * BOX; x < b.x1; x += BOX ) {

		ctx.boxes.push( { x0: x, z0: z, x1: x + BOX, z1: z + BOX } );

	}
	return ctx;

}

function plant( { fp, sdf, rimGround, walkDistance }, box ) {

	const raw = [];
	scatterTop( sdf, box, ISLAND_TOP, ( x, z ) => fp.dist( x, z ), raw );
	const anchors = new Float32Array( raw.length / 8 * VEGETATION_STRIDE );
	for ( let i = 0; i < raw.length / 8; i ++ ) {

		for ( let j = 0; j < 8; j ++ ) anchors[ i * VEGETATION_STRIDE + j ] = raw[ i * 8 + j ];
		anchors[ i * VEGETATION_STRIDE + 8 ] = 1;

	}
	return { anchors, tufts: plantGrass( anchors, rimGround, walkDistance ), flowers: plantFlowers( anchors, walkDistance ) };

}

export function build( ctx, box ) {

	const { anchors, tufts, flowers } = plant( ctx, box );
	const records = [];
	const add = ( kind, position, data ) => records.push( { kind, position, data } );
	for ( let k = 0; k < anchors.length; k += VEGETATION_STRIDE ) add( 0, anchors.subarray( k, k + 3 ), anchors.subarray( k, k + VEGETATION_STRIDE ) );
	[ tufts.lawn, tufts.tussocks, tufts.lawnThin ].forEach( ( list, kind ) => {

		for ( const t of list ) add( 1 + kind, t.origin.toArray(), [ ...t.m.elements, ...t.col.toArray(), t.visibility, t.soil, t.cover, t.rimEdge, t.thin, t.top ] );

	} );
	flowers.forEach( ( list, species ) => {

		for ( const p of list ) add( 4 + species, p.root.toArray(), [ ...p.m.elements, ...p.color.toArray(), p.stretch, p.sward, p.visibility ] );

	} );
	const position = new Float64Array( records.length * 3 ), kind = new Float64Array( records.length ), data = new Float64Array( records.length * DATA );
	records.forEach( ( r, i ) => {

		position.set( r.position, i * 3 );
		kind[ i ] = r.kind;
		data.set( r.data, i * DATA );

	} );
	return { position: { records: position, stride: 3 }, kind, data: { records: data, stride: DATA } };

}
