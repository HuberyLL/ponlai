// The trap tools/repo/verify-tool-manuals.mjs runs each entry tool's `--help` under, so reaching the
// GPU lock, a browser, a server or another process is an error instead of a side effect.
//   node --import ./tools/repo/verify-tool-manuals-trap.mjs <tool> --help
// The modules in TRAPPED are loaded as they are (so a tool's imports still link) but throw as they
// start to run, and a call that starts a process (child_process, process.execve), opens a
// connection (a socket, fetch) or starts a worker thread throws. A tool that answers `--help`
// before its other imports run (tools/kit/help.mjs, imported first) meets none of them and exits 0.
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import childProcess from 'node:child_process';
import net from 'node:net';
import workerThreads from 'node:worker_threads';

/** The modules that throw as they start to run, by the end of their URL. */
export const TRAPPED = [
	'/tools/kit/gpu-lock.mjs', '/tools/kit/gpu-lock-impl.mjs', '/tools/gpu-lock-impl.mjs',
	'/tools/kit/qos.mjs', '/tools/kit/capture-browser.mjs',
	'/node_modules/playwright/index.mjs', '/node_modules/playwright-core/index.mjs',
	'/node_modules/vite/dist/node/index.js',
];

const refuse = ( what ) => () => {

	throw new Error( `--help reached ${ what }` );

};

// the tool being checked is never trapped itself (tools/kit/qos.mjs answers its own `--help`)
const self = process.argv[ 1 ] ? pathToFileURL( path.resolve( process.argv[ 1 ] ) ).href : null;

registerHooks( {
	load( url, context, nextLoad ) {

		const result = nextLoad( url, context );
		const hit = url !== self && TRAPPED.find( ( end ) => url.endsWith( end ) );
		if ( ! hit || result.source == null ) return result;
		return { ...result, source: `throw new Error( '--help reached ${ hit }' );\n${ String( result.source ) }` };

	},
} );

for ( const name of [ 'spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork' ] ) childProcess[ name ] = refuse( `child_process.${ name }` );
process.execve = refuse( 'process.execve' );
net.Socket.prototype.connect = refuse( 'a socket' );
globalThis.fetch = refuse( 'fetch' );
workerThreads.Worker = class {

	constructor() {

		throw new Error( '--help reached a worker thread' );

	}

};
syncBuiltinESMExports();
