import { Field2D } from './Field2D.ts';
import { ISLAND_TOP, islandSurfaceHeight, layoutBounds } from './WorldShapes.ts';
import { noise3, smoothstep } from './noise.ts';
import type { RimGroundField, RimSkirtData, SDF } from './types.ts';

export const RIM_FRINGE_FADE = 0.12;
export const RIM_INNER_LIMIT = 0.70;
export const RIM_MAX_DROP = 0.30;

export interface RimGroundSample { distance: number; roofY: number; retreat: number; depth: number }

// The top coast differs from the nominal tile footprint. Trace its actual solid just below
// the roof so grass thinning, exposed root soil and stone shoulders share one boundary.
export function buildRimGround( sdf: SDF ): RimGroundField {

	const b = layoutBounds(), pad = 2, cell = 0.10;
	const coast = Field2D.covering( b.x0 - pad, b.x1 + pad, b.z0 - pad, b.z1 + pad, cell )
		.fill( ( x, z ) => sdf( x, islandSurfaceHeight( x, z ) - 0.25, z ) ).signedDistance();
	const data = new Float32Array( coast.nx * coast.nz * 4 );
	for ( let row = 0; row < coast.nz; row ++ ) for ( let col = 0; col < coast.nx; col ++ ) {

		const x = coast.x0 + ( col + 0.5 ) * cell, z = coast.z0 + ( row + 0.5 ) * cell;
		const broad = noise3( x * 0.49 + 3.8, 8.7, z * 0.49 - 2.1 ) * 0.5 + 0.5;
		const broken = noise3( x * 1.17 - 6.2, 3.4, z * 1.17 + 7.1 ) * 0.5 + 0.5;
		const pocket = Math.pow( smoothstep( 0.38, 0.68, broad * 0.72 + broken * 0.28 ), 1.7 );
		const roots = noise3( x * 0.67 - 2.6, 5.8, z * 0.67 + 9.3 ) * 0.5 + 0.5;
		const k = ( row * coast.nx + col ) * 4;
		data[ k ] = coast.data[ k / 4 ];
		data[ k + 1 ] = islandSurfaceHeight( x, z );
		data[ k + 2 ] = - 0.09 + pocket * 0.43;
		// The root bed's depth below the roof, patchy along the coast: deep cuts expose a band of
		// root soil, and where it runs shallow the turf creeps down over the lip instead (see
		// TerrainMaterial), so the edge alternates between earth and overgrown stretches.
		data[ k + 3 ] = 0.035 + Math.pow( smoothstep( 0.3, 0.72, roots ), 1.4 ) * 0.17;

	}
	return { data, nx: coast.nx, nz: coast.nz, x0: coast.x0, z0: coast.z0, cell };

}

// CPU bilinear lookup matches a linear-filtered texture whose texels are the cell centres.
export function sampleRimGround( field: RimGroundField, x: number, z: number ): RimGroundSample {

	const { nx, nz, cell, data } = field;
	const fx = Math.min( Math.max( ( x - field.x0 ) / cell - 0.5, 0 ), nx - 1 );
	const fz = Math.min( Math.max( ( z - field.z0 ) / cell - 0.5, 0 ), nz - 1 );
	const i = Math.floor( fx ), j = Math.floor( fz ), i1 = Math.min( i + 1, nx - 1 ), j1 = Math.min( j + 1, nz - 1 );
	const u = fx - i, v = fz - j;
	const sample = ( channel: number ) => {

		const a = data[ ( j * nx + i ) * 4 + channel ], b = data[ ( j * nx + i1 ) * 4 + channel ];
		const c = data[ ( j1 * nx + i ) * 4 + channel ], d = data[ ( j1 * nx + i1 ) * 4 + channel ];
		return ( a + ( b - a ) * u ) * ( 1 - v ) + ( c + ( d - c ) * u ) * v;

	};
	return { distance: sample( 0 ), roofY: sample( 1 ), retreat: sample( 2 ), depth: sample( 3 ) };

}

// Thin the grass only where the same field exposes a little root soil or stone beneath it.
export function rimGrassCover( ground: RimGroundSample ): number {

	return smoothstep( ground.retreat - RIM_FRINGE_FADE, ground.retreat + RIM_FRINGE_FADE, - ground.distance );

}

// ------------------------------------------------------------------ turf skirt

// The sod's mat of roots overhangs the stone a little and drapes over the lip, so the meadow
// spills over the edge instead of stopping on a line. Its shape is a function of position and
// of the same root bed: retreat pockets, where the turf already gives way to soil and stone,
// stay bare. Nothing is placed by hand, so the skirt follows any coast the island takes.
// Reach and droop are the sod's where it is fully present; the skirt scales them by presence
// after easing it along the coast.
export interface RimSkirtShape { presence: number; reach: number; droop: number }

export function rimSkirtShape( x: number, z: number, retreat: number ): RimSkirtShape {

	// About half the coast is left bare in stretches of one to a few metres.
	const broad = noise3( x * 0.41 + 1.3, 6.1, z * 0.41 - 4.4 ) * 0.5 + 0.5;
	const thick = noise3( x * 0.93 - 5.2, 2.4, z * 0.93 + 3.3 ) * 0.5 + 0.5;
	// A finer field breaks the longest runs, so no stretch reads as a continuous hem.
	const breakup = noise3( x * 1.6 - 3.7, 0.9, z * 1.6 + 8.1 ) * 0.5 + 0.5;
	const presence = smoothstep( 0.27, 0.48, broad ) * smoothstep( 0.30, 0.50, breakup ) * ( 1 - smoothstep( - 0.03, 0.09, retreat ) );
	// Ragged lower edge: rounded lobes of sod a few decimetres wide between torn notches where it
	// barely curls over, each lobe frayed by shorter tongues, so the edge never reads as a smooth
	// hem. (Tongues alone, a hand's width apart, cut it into even saw teeth.)
	const tongue = noise3( x * 6.3 + 0.7, 9.2, z * 6.3 - 1.9 ) * 0.5 + 0.5;
	const lobe = smoothstep( 0.3, 0.62, noise3( x * 2.9 - 6.1, 3.3, z * 2.9 + 0.4 ) * 0.5 + 0.5 );
	const vigour = smoothstep( 0.30, 0.80, broad * 0.6 + thick * 0.4 );
	const reach = ( 0.07 + 0.17 * vigour ) * ( 0.65 + 0.4 * lobe );
	const droop = ( 0.09 + 0.23 * vigour ) * ( 0.25 + 0.85 * lobe ) * ( 0.8 + 0.4 * tongue );
	return { presence, reach, droop };

}

// Where the noise fields cross their thresholds steeply, a run of sod would end in a cut face.
// A triangular filter along the coast (half-width `radius` samples) thins every end out over a
// few decimetres instead, wrapping round a closed loop.
function easeAlong( values: number[], radius: number, closed: boolean ): number[] {

	const n = values.length;
	return values.map( ( _, i ) => {

		let sum = 0, weight = 0;
		for ( let j = - radius; j <= radius; j ++ ) {

			let k = i + j;
			if ( closed ) k = ( k + n ) % n;
			else if ( k < 0 || k >= n ) continue;
			const w = radius + 1 - Math.abs( j );
			sum += values[ k ] * w; weight += w;

		}
		return sum / weight;

	} );

}

// The highest solid surface in a column, marched down from above the plateau.
export function topAt( sdf: SDF, x: number, z: number ): number | undefined {

	let y = ISLAND_TOP + 0.6;
	for ( let i = 0; i < 70; i ++ ) {

		const d = sdf( x, y, z );
		if ( d < 0.002 ) return y;
		y -= Math.max( 0.004, d * 0.7 );
		if ( y < ISLAND_TOP - 0.3 ) return;

	}

}

// Cross-section of the skirt, outward offset from the traced coast (m) and its height
// relative to the roof. The first ring is buried in the turf; the last is the ragged lower edge.
export const SKIRT_RING = 7;

// The coast iso-line of the root bed (marching squares, chained into loops), resampled every
// `step` metres; `closed` where a loop meets itself rather than the field's border.
export interface CoastPath { points: [ number, number ][]; closed: boolean }

export function coastPaths( field: RimGroundField, step = 0.05 ): CoastPath[] {

	const paths: CoastPath[] = [];
	for ( const loop of coastLoops( field ) ) {

		const points = resample( loop, step );
		if ( points.length < 12 ) continue;
		const [ fx, fz ] = points[ 0 ], [ lx, lz ] = points[ points.length - 1 ];
		paths.push( { points, closed: Math.hypot( fx - lx, fz - lz ) < step * 2 } );

	}
	return paths;

}

// Sweep the cross-section along the traced coast, kept clear of the rock.
export function buildRimSkirt( sdf: SDF, field: RimGroundField ): RimSkirtData {

	const points: number[] = [], info: number[] = [], spans: number[] = [];
	for ( const { points: samples, closed } of coastPaths( field ) ) {

		const start = points.length / ( SKIRT_RING * 3 );
		const shapes = samples.map( ( [ x, z ] ) => rimSkirtShape( x, z, sampleRimGround( field, x, z ).retreat ) );
		const eased = easeAlong( shapes.map( ( shape ) => shape.presence ), 4, closed );
		for ( let i = 0; i < samples.length; i ++ ) {

			const [ x, z ] = samples[ i ];
			const g = sampleRimGround( field, x, z );
			const e = 0.15;
			let nx = sampleRimGround( field, x + e, z ).distance - sampleRimGround( field, x - e, z ).distance;
			let nz = sampleRimGround( field, x, z + e ).distance - sampleRimGround( field, x, z - e ).distance;
			const l = Math.hypot( nx, nz ) || 1;
			nx /= l; nz /= l;
			const presence = eased[ i ], reach = shapes[ i ].reach * presence, droop = shapes[ i ].droop * presence;
			const roof = topAt( sdf, x - nx * 0.22, z - nz * 0.22 ) ?? g.roofY;
			// ( outward offset, height above the roof ). The sod bulges a little over the lip
			// before it curls down and tucks back toward the wall at its lower edge.
			const ring: [ number, number ][] = [
				[ - 0.42, - 0.02 ], [ - 0.22, 0.012 * presence ], [ - 0.05, 0.018 * presence ],
				[ reach * 0.72, 0.008 * presence - droop * 0.12 ], [ reach, - droop * 0.42 ],
				[ reach * 0.9, - droop * 0.76 ], [ reach * 0.74, - droop ],
			];
			for ( let k = 0; k < SKIRT_RING; k ++ ) {

				const [ s, h ] = ring[ k ];
				let px = x + nx * s, pz = z + nz * s, py = roof + h;
				if ( k < 3 ) {

					// On the plateau the sod follows the ground; the buried ring meets it.
					const ground = topAt( sdf, px, pz );
					if ( ground !== undefined ) py = k === 0 ? ground - 0.02 : Math.max( py, ground + 0.004 + 0.01 * presence );

				}
				// Over the edge, keep every ring a little clear of the stone ( batter, chips, bulges ).
				for ( let i = 0; i < 8 && k >= 2; i ++ ) {

					const d = sdf( px, py, pz );
					if ( d >= 0.018 ) break;
					px += nx * ( 0.022 - d ); pz += nz * ( 0.022 - d );

				}
				points.push( px, py, pz );

			}
			info.push( nx, nz, presence, droop );

		}
		spans.push( start, samples.length );

	}
	return { points: new Float32Array( points ), info: new Float32Array( info ), loops: new Int32Array( spans ) };

}

// Iso-line d = 0 of the field's distance channel, as closed (or border-clipped) polylines.
function coastLoops( field: RimGroundField ): [ number, number ][][] {

	const { nx, nz, cell, data } = field;
	const d = ( i: number, j: number ) => data[ ( j * nx + i ) * 4 ];
	const px = ( i: number ) => field.x0 + ( i + 0.5 ) * cell, pz = ( j: number ) => field.z0 + ( j + 0.5 ) * cell;
	// Crossing on a cell edge: horizontal edge id 2 * ( j * nx + i ), vertical + 1.
	const crossing = new Map<number, [ number, number ]>();
	const at = ( id: number ): [ number, number ] => {

		let p = crossing.get( id );
		if ( p ) return p;
		const k = id >> 1, i = k % nx, j = Math.floor( k / nx );
		const a = d( i, j ), b = id & 1 ? d( i, j + 1 ) : d( i + 1, j );
		const t = a / ( a - b );
		p = id & 1 ? [ px( i ), pz( j ) + t * cell ] : [ px( i ) + t * cell, pz( j ) ];
		crossing.set( id, p );
		return p;

	};
	const next = new Map<number, number>();
	for ( let j = 0; j + 1 < nz; j ++ ) for ( let i = 0; i + 1 < nx; i ++ ) {

		const v0 = d( i, j ), v1 = d( i + 1, j ), v2 = d( i + 1, j + 1 ), v3 = d( i, j + 1 );
		const code = ( v0 < 0 ? 1 : 0 ) | ( v1 < 0 ? 2 : 0 ) | ( v2 < 0 ? 4 : 0 ) | ( v3 < 0 ? 8 : 0 );
		if ( code === 0 || code === 15 ) continue;
		const bottom = 2 * ( j * nx + i ), top = 2 * ( ( j + 1 ) * nx + i );
		const left = 2 * ( j * nx + i ) + 1, right = 2 * ( j * nx + i + 1 ) + 1;
		// Segments run with the solid on one consistent side, so loops chain in one direction.
		const centre = ( v0 + v1 + v2 + v3 ) < 0;
		const segs: [ number, number ][] = ( {
			1: [ [ left, bottom ] ], 2: [ [ bottom, right ] ], 3: [ [ left, right ] ], 4: [ [ right, top ] ],
			5: centre ? [ [ left, top ], [ right, bottom ] ] : [ [ left, bottom ], [ right, top ] ],
			6: [ [ bottom, top ] ], 7: [ [ left, top ] ], 8: [ [ top, left ] ], 9: [ [ top, bottom ] ],
			10: centre ? [ [ bottom, left ], [ top, right ] ] : [ [ bottom, right ], [ top, left ] ],
			11: [ [ top, right ] ], 12: [ [ right, left ] ], 13: [ [ right, bottom ] ], 14: [ [ bottom, left ] ],
		} as Record<number, [ number, number ][]> )[ code ];
		for ( const [ a, b ] of segs ) next.set( a, b );

	}
	const loops: [ number, number ][][] = [];
	const seen = new Set<number>();
	for ( const first of next.keys() ) {

		if ( seen.has( first ) ) continue;
		const loop: [ number, number ][] = [];
		let id: number | undefined = first;
		while ( id !== undefined && ! seen.has( id ) ) {

			seen.add( id );
			loop.push( at( id ) );
			id = next.get( id );

		}
		if ( id === first ) loop.push( at( first ) );
		loops.push( loop );

	}
	return loops;

}

function resample( line: [ number, number ][], step: number ): [ number, number ][] {

	const out: [ number, number ][] = [];
	let carry = 0;
	for ( let i = 0; i + 1 < line.length; i ++ ) {

		const [ ax, az ] = line[ i ], [ bx, bz ] = line[ i + 1 ];
		const len = Math.hypot( bx - ax, bz - az );
		let s = carry;
		for ( ; s < len; s += step ) out.push( [ ax + ( bx - ax ) * s / len, az + ( bz - az ) * s / len ] );
		carry = s - len;

	}
	return out;

}
