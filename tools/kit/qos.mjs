// The tools' scheduling policy on macOS: every tool runs as an application would, not as a daemon.
//
// Processes an agent starts (its shell, node, Python, tsc, the tools) are not applications to macOS:
// their threads run at the legacy QoS whatever they ask for (a thread that requests user-initiated
// is still accounted as legacy), and when the machine is busy the scheduler keeps that work on the
// efficiency cores while the performance cores stand idle. Measured while several agents captured
// and built at once (most of the CPU idle, the efficiency cores full), the same work took 3-14x as
// long as in a process started with the application policy (`taskpolicy -a`): a single-thread
// loop 3-14x, the capture tool's PNG decode for readiness 5-10x and its frame compare 4x, tsc 3-14x.
// On a quiet machine both run alike.
// Chrome's helper processes (GPU, renderers, the world's workers) set their own QoS and are not held
// back, so the page's own work is unaffected; the node side of a capture (decode, compare, PNG
// writes, while it holds a GPU slot) and every CPU tool are.
//
// The policy is a property of the process, given when it is started, and its children do not
// inherit it: each process has to be started with it. So:
//   - importing this module re-executes the current node process under `taskpolicy -a` in place
//     (process.execve: same pid, same stdio and arguments) unless it already runs so.
//     tools/kit/gpu-lock.mjs and tools/kit/capture-browser.mjs import it, so every tool that renders or
//     reads captures raises itself before it does anything;
//   - `appPolicy( cmd, args )` gives the command line that starts a child with the policy, for a
//     child that cannot re-execute itself (one with an IPC channel, which an exec closes:
//     capture-set's capture.mjs workers; `gpu-lock run`'s command);
//   - the Python tools (clip-metrics.py, diff-set.py, compare-captures.py, compare-sky-captures.py)
//     re-execute themselves the same way with os.execv;
//   - `node tools/kit/qos.mjs <command> [args]` runs any command with it (the npm build and typecheck
//     scripts start tsc and vite through it).
// PONLAI_QOS holds the pid of the process that runs with the policy, so a process knows it already
// does and its children (another pid) still raise themselves. PONLAI_QOS=off keeps the policy a
// process was given (for an A/B of this module). Elsewhere than macOS nothing changes.
//
// The application policy is what the user's own apps get: it puts the tools on par with them, not
// above them.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TASKPOLICY = '/usr/sbin/taskpolicy';
const enabled = process.platform === 'darwin' && process.env.PONLAI_QOS !== 'off';

/** The command line that starts `cmd args` with the application policy: [ cmd, args ] unchanged
 * elsewhere. The child is told through PONLAI_QOS (its own pid, set by the shell that becomes it)
 * that it already runs so. */
export function appPolicy( cmd, args = [] ) {

	if ( ! enabled ) return [ cmd, args ];
	return [ TASKPOLICY, [ '-a', '/bin/sh', '-c', 'PONLAI_QOS=$$ exec "$@"', 'sh', cmd, ...args ] ];

}

const cli = process.argv[ 1 ] && path.resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url );

if ( cli ) {

	const [ cmd, ...args ] = process.argv.slice( 2 );
	if ( ! cmd ) {

		console.error( 'usage: node tools/kit/qos.mjs <command> [args ...]' );
		process.exit( 2 );

	}
	const [ file, argv ] = appPolicy( cmd, args );
	// through the shell, which looks the command up in PATH (npm scripts put node_modules/.bin there)
	if ( file === TASKPOLICY ) process.execve( file, [ file, ...argv ] );
	else process.execve( '/bin/sh', [ 'sh', '-c', 'exec "$@"', 'sh', cmd, ...args ] );

} else if ( enabled && process.env.PONLAI_QOS !== String( process.pid ) && ! process.channel ) {

	// (a child with an IPC channel was started raised by its parent, through appPolicy)
	process.execve( TASKPOLICY, [ TASKPOLICY, '-a', process.execPath, ...process.execArgv, ...process.argv.slice( 1 ) ],
		{ ...process.env, PONLAI_QOS: String( process.pid ) } );

}
