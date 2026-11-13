// Checks the frame graph's compiler and runtime on the CPU, with no browser and no GPU.
//
// It covers the frame graph (packages/render/post/graph/): the msaa4 graph and its variants
// declared on the compiler; the order, culling, hazard and determinism rules; both attachment-op
// tables, and AttachmentOps stacked with other wrappers of the command encoder; the runtime on a
// mock renderer (histories, resizes, clear flags), its warm-up and its introspection (describe,
// dot, the counters, fgview's parsing); and the temporal modes' graph (one sample, the velocity
// MRT, the overlay, the jitter hooks). Run it after a change to the graph or a pass's declaration;
// it is part of `npm run check`. What three's backend does with the graph on the GPU is checked by
// tools/render/verify-frame-graph-gpu.mjs.
//
// Usage:
//   node tools/render/verify-framegraph.mjs [filter]
//   node tools/render/verify-framegraph.mjs runtime
//
// Options:
//   filter   run only the checks whose `group: name` contains this text (default: every check)
//
// The tables live in tools/render/framegraph/, one file per concern (passes, ops, runtime, warm,
// introspect, temporal), so separate changes edit separate files.
//
// Output: on stdout, `ok` or `FAIL` per check (a failure with the first lines of its stack), then
// the count passed of the count run.
//
// GPU lock and browser: neither.
//
// Cost: about a second, CPU only.
//
// Exit codes: 0 every check run passes; 1 a check failed or the filter matched none.
import '../kit/help.mjs';

import { checks as passes } from './framegraph/tables-passes.mjs';
import { checks as ops } from './framegraph/tables-ops.mjs';
import { checks as runtime } from './framegraph/tables-runtime.mjs';
import { checks as warm } from './framegraph/tables-warm.mjs';
import { checks as introspect } from './framegraph/tables-introspect.mjs';
import { checks as temporal } from './framegraph/tables-temporal.mjs';

const filter = process.argv[ 2 ] ?? '';
const groups = [ [ 'passes', passes ], [ 'ops', ops ], [ 'runtime', runtime ], [ 'warm', warm ], [ 'introspect', introspect ], [ 'temporal', temporal ] ];
let failed = 0, ran = 0;
for ( const [ group, list ] of groups ) {

	for ( const [ name, run ] of list ) {

		if ( filter && ! `${ group }: ${ name }`.includes( filter ) ) continue;
		ran ++;
		try {

			await run();
			console.log( `ok    ${ group }: ${ name }` );

		} catch ( error ) {

			failed ++;
			console.log( `FAIL  ${ group }: ${ name }\n      ${ String( error?.stack ?? error ).split( '\n' ).slice( 0, 12 ).join( '\n      ' ) }` );

		}

	}

}
console.log( `\n${ ran - failed } of ${ ran } frame graph checks passed` );
process.exitCode = failed > 0 || ran === 0 ? 1 : 0;
