import { pickFoliageSites, type FoliageSite } from './FoliageSites.ts';
import { supportsMeadow } from './MeadowSurface.ts';
import { mulberry32, noise3 } from './noise.ts';
import { ISLAND_TOP, type Footprint } from './WorldShapes.ts';
import type { RimStrand, SDF } from './types.ts';

type Point = [ number, number, number ];

function normalAt( sdf: SDF, x: number, y: number, z: number ): Point {

	const e = 0.025;
	const nx = sdf( x + e, y, z ) - sdf( x - e, y, z );
	const ny = sdf( x, y + e, z ) - sdf( x, y - e, z );
	const nz = sdf( x, y, z + e ) - sdf( x, y, z - e );
	const l = Math.hypot( nx, ny, nz ) || 1;
	return [ nx / l, ny / l, nz / l ];

}

function topAt( sdf: SDF, x: number, z: number ): number | undefined {

	let y = ISLAND_TOP + 0.6;
	for ( let i = 0; i < 70; i ++ ) {

		const d = sdf( x, y, z );
		if ( d < 0.002 ) return y;
		y -= Math.max( 0.004, d * 0.7 );
		if ( y < ISLAND_TOP - 0.3 ) return;

	}

}

// Find the first visible edge along an outward ray, not a second tile across a concave bay.
function edgeAt( sdf: SDF, x: number, y: number, z: number, nx: number, nz: number ): number | undefined {

	let lo = - 0.6;
	const d = sdf( x + nx * lo, y, z + nz * lo );
	if ( d > 0 ) return;
	for ( let hi = lo + 0.08; hi <= 2.52; hi += 0.08 ) {

		const next = sdf( x + nx * hi, y, z + nz * hi );
		if ( next >= 0 ) {

			for ( let j = 0; j < 18; j ++ ) {

				const mid = ( lo + hi ) * 0.5;
				if ( sdf( x + nx * mid, y, z + nz * mid ) < 0 ) lo = mid;
				else hi = mid;

			}
			return ( lo + hi ) * 0.5;

		}
		lo = hi;

	}

}

// Keep established shrub roots first, then fill the long shores with roots in the top meadow.
// A separate seed preserves the original bushes while spreading the hanging patches all round.
function rimSites( vegetation: Float32Array ): FoliageSite[] {

	const sites = pickFoliageSites( vegetation, mulberry32( 7 ) );
	const extra: FoliageSite[] = [], rng = mulberry32( 8143 );
	for ( let k = 0; k < vegetation.length; k += 8 ) {

		const y = vegetation[ k + 1 ], ny = vegetation[ k + 4 ], rim = vegetation[ k + 6 ];
		if ( ! supportsMeadow( y, ny ) || rim < - 1.45 || rim > 0.45 ) continue;
		extra.push( { x: vegetation[ k ], y, z: vegetation[ k + 2 ], r: 0.65 + rng() * 0.25,
			rim, nx: vegetation[ k + 3 ], ny, nz: vegetation[ k + 5 ] } );

	}
	for ( let i = extra.length - 1; i > 0; i -- ) {

		const j = Math.floor( rng() * ( i + 1 ) );
		[ extra[ i ], extra[ j ] ] = [ extra[ j ], extra[ i ] ];

	}
	return sites.concat( extra );

}

// Top-rooted sprays cross the lip before bending down. Unequal patch spacing and mixed
// lengths inside each crown leave exposed stone between overlapping short and long tails.
export function makeRimTrails( sdf: SDF, fp: Footprint, vegetation: Float32Array ): RimStrand[] {

	const sites = rimSites( vegetation );
	const rng = mulberry32( 9067 );
	const strands: RimStrand[] = [];
	const patches: Point[] = [];
	for ( const site of sites ) {

		if ( ! supportsMeadow( site.y, site.ny ) || site.rim < - 1.8 ) continue;
		const e = 0.16;
		const gx = fp.dist( site.x + e, site.z ) - fp.dist( site.x - e, site.z );
		const gz = fp.dist( site.x, site.z + e ) - fp.dist( site.x, site.z - e );
		const g = Math.hypot( gx, gz );
		if ( g < 0.02 ) continue;
		const nx = gx / g, nz = gz / g;
		const edge = edgeAt( sdf, site.x, site.y - 0.18, site.z, nx, nz );
		if ( edge === undefined || edge < 0.08 || edge > Math.min( 1.12, site.r + 0.30 ) ) continue;
		const lipX = site.x + nx * edge, lipZ = site.z + nz * edge;
		const spacing = 0.80 + ( noise3( lipX * 0.23, 3.6, lipZ * 0.23 ) * 0.5 + 0.5 ) * 0.45 + rng() * 0.13;
		if ( patches.some( ( p ) => Math.hypot( p[ 0 ] - lipX, p[ 2 ] - lipZ ) < spacing ) || rng() > 0.96 ) continue;
		if ( patches.length >= 96 ) break;
		const patchStart = strands.length;
		const branches = 3 + Math.floor( rng() * 3 );
		const spread = Math.min( 0.43, site.r * 0.50 );
		for ( let branch = 0; branch < branches; branch ++ ) {

			const offset = ( branch / Math.max( 1, branches - 1 ) - 0.5 ) * spread * 2 + ( rng() - 0.5 ) * 0.10;
			const x = site.x - nz * offset + nx * 0.07, z = site.z + nx * offset + nz * 0.07;
			const y = topAt( sdf, x, z );
			if ( y === undefined ) continue;
			const rootNormal = normalAt( sdf, x, y, z );
			if ( ! supportsMeadow( y, rootNormal[ 1 ] ) ) continue;
			const topEdge = edgeAt( sdf, x, y - 0.18, z, nx, nz );
			if ( topEdge === undefined || topEdge > 1.25 || topEdge < 0.02 ) continue;
			const tier = rng();
			const drop = tier < 0.28 ? 0.20 + rng() * 0.20 : tier < 0.75 ? 0.45 + rng() * 0.40 : 0.90 + rng() * 0.55;
			const drift = ( rng() - 0.5 ) * 0.34;
			const air = 0.13 + rng() * 0.04;
			const points: number[] = [];
			let valid = true;
			const append = ( px: number, py: number, pz: number, root = false ) => {

				if ( ! root ) {

					for ( let i = 0; i < 6; i ++ ) {

						const d = sdf( px, py, pz );
						if ( d >= 0.105 ) break;
						const n = normalAt( sdf, px, py, pz );
						px += n[ 0 ] * ( 0.112 - d ); py += n[ 1 ] * ( 0.112 - d ); pz += n[ 2 ] * ( 0.112 - d );

					}
					if ( sdf( px, py, pz ) < 0.09 || py < 1.30 ) { valid = false; return; }

				}
				const n = root ? rootNormal : normalAt( sdf, px, py, pz );
				points.push( px, py, pz, n[ 0 ], n[ 1 ], n[ 2 ] );

			};
			append( x, y - 0.02, z, true );
			// The short arch hides in the crown before its outside section turns down.
			for ( let j = 1; j <= 16; j ++ ) {

				const u = j / 16;
				const out = ( topEdge + air ) * u;
				const side = Math.sin( u * Math.PI ) * drift * 0.35;
				append( x + nx * out - nz * side, y + 0.20 * Math.sin( u * Math.PI * 0.90 ) - 0.04 * u,
					z + nz * out + nx * side );

			}
			for ( let j = 1; j <= 20; j ++ ) {

				const u = j / 20, py = y + 0.022 - drop * u;
				const side = drift * u + Math.sin( u * Math.PI ) * drift * 0.25;
				const baseX = x - nz * side, baseZ = z + nx * side;
				const wall = edgeAt( sdf, baseX, py, baseZ, nx, nz );
				if ( wall === undefined ) { valid = false; break; }
				// A ray near the roof can hit a shallow top dip before the outside wall.
				// Once the branch crosses the lip, it cannot turn back into that dip.
				const out = Math.max( topEdge, wall ) + air + Math.sin( u * Math.PI ) * 0.06;
				append( baseX + nx * out, py, baseZ + nz * out );

			}
			if ( valid && points.length === 37 * 6 ) strands.push( { points: new Float32Array( points ), seed: Math.floor( rng() * 0x7fffffff ), lip: 16 } );

		}
		if ( strands.length > patchStart ) patches.push( [ lipX, site.y, lipZ ] );

	}
	return strands;

}
