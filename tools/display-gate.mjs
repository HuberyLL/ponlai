// Headed browser runs (profile-frame --display, any script that opens a visible Chrome window) take
// over the screen of whoever is using the machine. They run only while the user has allowed them:
// a file under the user's home holds the time the permission ends. Everything else runs headless.
//   node tools/display-gate.mjs allow [hours]   (default 8)
//   node tools/display-gate.mjs deny
//   node tools/display-gate.mjs status          (exit code 0 when allowed, 1 when not)
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GATE_FILE = path.join( os.homedir(), '.ponlai', 'display-allowed' );

/** When the permission for headed runs ends, or null if they are not allowed now. */
export function displayAllowedUntil() {

	try {

		const until = new Date( readFileSync( GATE_FILE, 'utf8' ).trim() );
		return Number.isFinite( until.getTime() ) && until.getTime() > Date.now() ? until : null;

	} catch {

		return null;

	}

}

/** Throws unless the user currently allows headed runs on the screen. */
export function requireDisplayAllowed( label = 'a headed run' ) {

	if ( displayAllowedUntil() ) return;
	throw new Error( `${ label } would open a window on the user's screen, and headed runs are not allowed now (${ GATE_FILE }). ` +
		'Use a headless run instead, or record this run as pending in your report: the main session runs pending ' +
		'display runs together while the user allows them (node tools/display-gate.mjs allow <hours>).' );

}

if ( process.argv[ 1 ] && path.resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url ) ) {

	const [ command = 'status', value ] = process.argv.slice( 2 );
	if ( command === 'allow' ) {

		const hours = Number( value ?? 8 );
		if ( ! ( hours > 0 ) ) throw new Error( 'allow takes a positive number of hours' );
		mkdirSync( path.dirname( GATE_FILE ), { recursive: true } );
		const until = new Date( Date.now() + hours * 3600e3 );
		writeFileSync( GATE_FILE, until.toISOString() + '\n' );
		console.log( `headed runs allowed until ${ until.toLocaleString() }` );

	} else if ( command === 'deny' ) {

		rmSync( GATE_FILE, { force: true } );
		console.log( 'headed runs not allowed' );

	} else if ( command === 'status' ) {

		const until = displayAllowedUntil();
		console.log( until ? `headed runs allowed until ${ until.toLocaleString() }` : 'headed runs not allowed' );
		process.exitCode = until ? 0 : 1;

	} else {

		throw new Error( `unknown command ${ command }: allow [hours], deny or status` );

	}

}
