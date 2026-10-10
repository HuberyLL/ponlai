// CPU checks of the frame graph (src/post/graph/): today's msaa4 graph and its variants declared
// on the compiler, the order, culling, hazard and determinism rules, both attachment-op tables,
// AttachmentOps stacking with other wrappers of the command encoder, the runtime on a mock
// renderer (histories, resizes, clear flags) and its warm-up. Plain node, no GPU:
//   node tools/verify-framegraph.mjs [filter]
// The tables live in tools/framegraph/, one file per concern, so later work edits disjoint files.

import { checks as passes } from './framegraph/tables-passes.mjs';
import { checks as ops } from './framegraph/tables-ops.mjs';
import { checks as runtime } from './framegraph/tables-runtime.mjs';
import { checks as warm } from './framegraph/tables-warm.mjs';

const filter = process.argv[ 2 ] ?? '';
const groups = [ [ 'passes', passes ], [ 'ops', ops ], [ 'runtime', runtime ], [ 'warm', warm ] ];
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
