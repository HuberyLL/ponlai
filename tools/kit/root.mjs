// Where the repository and its tools are, found from this file's place (tools/kit/), so every tool
// reaches them the same way, whichever group's folder it is in.
//   import { ROOT, TOOLS } from '../kit/root.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The tools' folder, `<repository>/tools`. */
export const TOOLS = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );

/** The repository's root: the checkout these tools are in. */
export const ROOT = path.resolve( TOOLS, '..' );
