#!/usr/bin/env node
// Compares the readings of several runs (hash-targets.js's output, one JSON file per page) and lists
// every key whose value is not the same in all of them, textures first.
//
//   node compare-runs.mjs <run.json>... [--limit 80]
//
// A file may hold hash-targets.js's object itself or any JSON that contains it (a tool's output that
// nests the page's value): the first object found with a `textures` key is taken. Each differing key
// is printed with its pattern over the runs in the order given (`AABAC`: runs 1, 2 and 4 agree, run 3
// and run 5 each differ), and the number of distinct values. Keys present in some runs only are
// listed apart: a different set of keys means the pages did not build the same objects, which is
// itself a finding. Keys that differ only in their indices (`[3]`, `layer 12`) are listed as one row
// (`[*]`, `layer *`) with their count, and with their pattern when all of them share it.
// Exit 0 when every run agrees, 1 when a key differs, 2 on bad input.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice( 2 );
let limit = 80;
const files = [];
for ( let i = 0; i < args.length; i ++ ) {

	if ( args[ i ] === '--limit' ) limit = Number( args[ ++ i ] );
	else files.push( args[ i ] );

}

if ( files.length < 2 ) {

	console.error( 'usage: compare-runs.mjs <run.json> <run.json>... [--limit 80]   (at least two runs)' );
	process.exit( 2 );

}

const find = ( v ) => {

	if ( ! v || typeof v !== 'object' ) {

		// a nested value may itself be a JSON string
		if ( typeof v === 'string' && v.startsWith( '{' ) ) { try { return find( JSON.parse( v ) ); } catch { return null; } }
		return null;

	}

	if ( v.textures && v.numbers ) return v;
	for ( const x of Object.values( v ) ) { const r = find( x ); if ( r ) return r; }
	return null;

};

const runs = files.map( ( f ) => {

	let json;
	try { json = JSON.parse( readFileSync( f, 'utf8' ) ); } catch ( e ) { console.error( `${ f }: not JSON (${ e.message })` ); process.exit( 2 ); }
	const r = find( json );
	if ( ! r ) { console.error( `${ f }: no object with 'textures' and 'numbers' in it` ); process.exit( 2 ); }
	return r;

} );

console.log( `runs: ${ files.map( ( f, i ) => `${ i + 1 }=${ path.basename( f ) }` ).join( ' ' ) }` );
let differing = 0;
for ( const section of [ 'textures', 'numbers' ] ) {

	const keys = [ ...new Set( runs.flatMap( ( r ) => Object.keys( r[ section ] ) ) ) ].sort();
	const partial = keys.filter( ( k ) => runs.some( ( r ) => ! ( k in r[ section ] ) ) );
	const groups = new Map();
	let count = 0;
	for ( const k of keys ) {

		if ( partial.includes( k ) ) continue;
		const ids = new Map();
		const label = runs.map( ( r ) => String.fromCharCode( 65 + ( ids.has( r[ section ][ k ] ) ? ids.get( r[ section ][ k ] ) : ids.set( r[ section ][ k ], ids.size ).get( r[ section ][ k ] ) ) ) ).join( '' );
		if ( ids.size < 2 ) continue;
		count ++;
		const g = k.replace( /\[\d+\]/g, '[*]' ).replace( /\b(layer|level) \d+/g, '$1 *' );
		if ( ! groups.has( g ) ) groups.set( g, { keys: 0, labels: new Set(), values: 0, first: k } );
		const e = groups.get( g );
		e.keys ++; e.labels.add( label ); e.values = Math.max( e.values, ids.size );

	}

	const rows = [ ...groups ].map( ( [ g, e ] ) => `  ${ e.labels.size === 1 ? [ ...e.labels ][ 0 ] : 'mixed'.padEnd( runs.length ) }  ${ e.values } values  ${ e.keys > 1 ? `${ g }  (${ e.keys } keys)` : e.first }` );
	differing += count + partial.length;
	console.log( `${ section }: ${ count } of ${ keys.length - partial.length } differ, in ${ rows.length } groups${ partial.length ? `; ${ partial.length } present in some runs only` : '' }` );
	for ( const row of rows.slice( 0, limit ) ) console.log( row );
	if ( rows.length > limit ) console.log( `  ... ${ rows.length - limit } more (--limit)` );
	for ( const k of partial.slice( 0, 10 ) ) console.log( `  only in runs ${ runs.map( ( r, i ) => k in r[ section ] ? i + 1 : '' ).filter( Boolean ).join( ',' ) }: ${ k }` );

}

const skipped = new Set( runs.map( ( r ) => JSON.stringify( r.skipped ?? [] ) ) );
if ( skipped.size > 1 ) console.log( 'the runs skipped different textures: compare their `skipped` lists' );
else if ( runs[ 0 ].skipped?.length ) console.log( `skipped in every run (${ runs[ 0 ].skipped.length }): ${ runs[ 0 ].skipped.join( '; ' ) }` );
process.exit( differing ? 1 : 0 );
