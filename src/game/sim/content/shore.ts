import { shoreMask } from '../ground.ts';
import { planar } from '../maths.ts';
import type { Place } from '../places.ts';
import { optionsAt, register } from '../registry.ts';
import type { Sim } from '../Sim.ts';

// The shore: the island's edge band of walkable ground (ground.ts SHORE_BAND), one place all round
// by the id `shore`, which shows nothing. What it offers is the options registered at `shore`
// (fishing: food.ts).

// per shore mask (ground.ts shoreMask: one per island top, so a grown island has its own): the
// shore's cells (the place is built anew each time it is looked up, every tick of a `go` or a
// timed `do`)
const shoreCells = new WeakMap<Uint8Array, number[]>();

function shore( sim: Sim ): Place {

	const grid = sim.grid, mask = shoreMask( grid );
	let cells = shoreCells.get( mask );
	if ( ! cells ) {

		cells = [];
		for ( let k = 0; k < mask.length; k ++ ) if ( mask[ k ] ) cells.push( k );
		shoreCells.set( mask, cells );

	}
	return {
		id: 'shore',
		kind: 'shore',
		reaches: ( k ) => k >= 0 && mask[ k ] === 1,
		near: () => cells,
		distance: ( p ) => {

			let d = Infinity;
			for ( const k of cells ) if ( grid.open[ k ] ) d = Math.min( d, planar( grid.centreX( k ) - p.x, grid.centreZ( k ) - p.z ) );
			return d;

		},
		shows: () => null,
		options: optionsAt( 'shore', null ),
	};

}

register( { places: [ { id: 'shore', all: ( sim ) => [ shore( sim ) ], byId: ( sim, id ) => id === 'shore' ? shore( sim ) : null } ] } );
