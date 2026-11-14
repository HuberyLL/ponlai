// Checks the repository's licensing: REUSE compliance, and SPDX tags in every third-party notice.
//
// Ponlai follows the REUSE specification 3.3 (https://reuse.software/spec-3.3/): every file says
// who holds its copyright and under which licence, and LICENSES/ holds the text of each licence
// used, named by its SPDX id. Ponlai's own files get theirs in bulk from REUSE.toml. A file holding
// third-party code carries that code's copyright and licence as SPDX-FileCopyrightText and
// SPDX-License-Identifier tags inside its /*! */ notice (the notice the build keeps in the bundle).
// The bulk entry aggregates with them, so `reuse lint` alone passes a notice whose tags were
// dropped; the second check here fails it. It is part of `npm run check`.
//
// Usage:
//   node tools/repo/verify-licences.mjs
//
// Options: none.
//
// What it checks, each a failure when broken:
// - `reuse lint` passes: every file has copyright and licence information, each licence used has
//   its text in LICENSES/ and no text there is unused, every SPDX expression is valid.
// - Every /*! notice that opens a line in a tracked code file (.ts, .mts, .js, .mjs, .cjs) carries
//   at least one copyright tag and one licence tag, and every line in it that names a copyright
//   ("Copyright" or the copyright sign) is a copyright tag. A notice that is not the file's own
//   licensing (one that travels with bundled npm code) holds REUSE-IgnoreStart and REUSE-IgnoreEnd
//   (or lies between them) and is skipped.
//
// The REUSE tool runs through uv, pinned (REUSE below), offline once it is in uv's cache; the
// first run on a machine fetches it (a few megabytes) and says so.
//
// Output: the REUSE tool's problems one per line, the notices' failures with their file and line,
// then PASS or FAIL.
//
// GPU lock and browser: neither. Cost: about a second, CPU only.
//
// Exit codes: 0 everything passes; 1 a failure (listed), an unknown option, or uv missing.
import '../kit/help.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../kit/root.mjs';

const REUSE = [ '--from', 'reuse[charset-normalizer]==6.3.0', 'reuse' ];
const CODE = /\.(ts|mts|js|mjs|cjs)$/;
// The tags' names, built so this file's own source holds no tag the REUSE tool would read.
const COPYRIGHT_TAG = 'SPDX-' + 'FileCopyrightText:';
const LICENCE_TAG = 'SPDX-' + 'License-Identifier:';
const IGNORED = new RegExp( 'REUSE-' + 'IgnoreStart[\\s\\S]*?REUSE-' + 'IgnoreEnd', 'g' );

for ( const a of process.argv.slice( 2 ) ) {

	console.error( `verify-licences: unknown option '${ a }'` );
	process.exit( 1 );

}

const failures = [];

// 1. The REUSE tool, from uv's cache; fetched once when the cache does not hold it.
const uvx = ( offline, args, stdio ) => spawnSync( 'uvx', [ ...( offline ? [ '--offline' ] : [] ), ...REUSE, ...args ], { cwd: ROOT, encoding: 'utf8', stdio } );
let probe = uvx( true, [ '--version' ], 'pipe' );
if ( probe.error ) {

	console.error( `verify-licences: cannot run uvx (${ probe.error.message }); install uv (https://docs.astral.sh/uv/)` );
	process.exit( 1 );

}
if ( probe.status !== 0 ) {

	console.log( 'verify-licences: the REUSE tool is not in uv\'s cache; fetching it once' );
	probe = uvx( false, [ '--version' ], 'pipe' );
	if ( probe.status !== 0 ) {

		console.error( `verify-licences: cannot fetch the REUSE tool:\n${ probe.stderr }` );
		process.exit( 1 );

	}

}
const lint = uvx( true, [ 'lint', '--lines' ], 'pipe' );
const lintOut = ( lint.stdout + lint.stderr ).trim();
if ( lint.status !== 0 ) failures.push( `reuse lint failed:\n${ lintOut }` );

// 2. The notices' tags.
const tracked = execFileSync( 'git', [ 'ls-files', '-z' ], { cwd: ROOT, encoding: 'utf8' } ).split( '\0' ).filter( ( f ) => CODE.test( f ) );
let notices = 0;
for ( const file of tracked ) {

	let text;
	try {

		text = readFileSync( path.join( ROOT, file ), 'utf8' );

	} catch {

		continue; // deleted in the working tree, not yet staged

	}
	if ( ! text.includes( '/*!' ) ) continue;
	const fenced = [ ...text.matchAll( IGNORED ) ].map( ( m ) => [ m.index, m.index + m[ 0 ].length ] );
	for ( const m of text.matchAll( /^\/\*![\s\S]*?\*\//gm ) ) {

		const end = m.index + m[ 0 ].length;
		if ( fenced.some( ( [ a, b ] ) => a < end && b > m.index ) ) continue; // not this file's own licensing
		notices ++;
		const line = text.slice( 0, m.index ).split( '\n' ).length;
		const lines = m[ 0 ].split( '\n' ).map( ( l ) => l.replace( /^\s*(\/\*!|\*\/|\*)?\s?/, '' ) );
		if ( ! lines.some( ( l ) => l.startsWith( COPYRIGHT_TAG ) ) ) failures.push( `${ file }:${ line }: the notice has no ${ COPYRIGHT_TAG } tag` );
		if ( ! lines.some( ( l ) => l.startsWith( LICENCE_TAG ) ) ) failures.push( `${ file }:${ line }: the notice has no ${ LICENCE_TAG } tag` );
		lines.forEach( ( l, i ) => {

			if ( /\bCopyright\b|\u00a9/.test( l ) && ! l.startsWith( COPYRIGHT_TAG ) ) failures.push( `${ file }:${ line + i }: a copyright line outside a ${ COPYRIGHT_TAG } tag: ${ l.trim() }` );

		} );

	}

}

console.log( `verify-licences: reuse lint ${ lint.status === 0 ? 'passes' : 'fails' }; ${ notices } third-party notices in ${ tracked.length } code files` );
if ( failures.length ) {

	console.log( `FAIL (${ failures.length })` );
	for ( const f of failures ) console.log( `  ${ f }` );
	process.exit( 1 );

}
console.log( 'PASS' );
