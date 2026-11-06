import { isBuilt, work, workLeft } from '../buildings.ts';
import { register } from '../registry.ts';
import type { BuildingState } from '../types.ts';

// Building: the option `build` at every building, at every stage (buildings.ts). `do( 'build' )`
// works on a site for the work still left, a game second of work a tick (the buildings system's
// `work`); a new action interrupts it and the work done stays. Several islanders may build one
// site, each adding their work. Once built, `build` stays on it closed (not offered, refused when
// called), so whoever else was building it ends at once on their next tick, with the building done
// as their outcome, instead of standing out the time they had planned.

register( { options: [ { id: 'build', at: 'building', make: ( b: BuildingState ) => ( {
	open: () => ! isBuilt( b ),
	start: () => isBuilt( b ) ? { ok: false, reason: `${ b.id } is built` } : { ok: true, seconds: workLeft( b ) },
	during: ( sim ) => {

		if ( isBuilt( b ) ) return { ok: true, value: `${ b.id } is built` };
		return work( sim, b ) ? { ok: true, value: `built ${ b.id }` } : null;

	},
} ) } ] } );
