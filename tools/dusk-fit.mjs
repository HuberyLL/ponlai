// Dusk fit: the endpoints of each night share's slope through the dusk and the dawn, solved from a
// dusk-grid run with --split (tools/dusk-grid.mjs), so that a lower sun never makes a judged
// quantity brighter. dusk-grid --fit runs it on its own points; on its own it reads a run's output:
//
//   node tools/dusk-fit.mjs <dusk-grid out dir> [--judge 0.02] [--views island]
//
// It writes fit.txt in that directory and prints its path. No page, no GPU.
//
// The form (each share's): w( e ) = 1 - smoothstep( e_full, e_top, e ), whole at and below e_full
// and none at and above e_top. DayCycle.ts writes the clouded weathers' shares in this form; the
// clear dusk's (duskIn) are written by stops of the twilight's fall instead, so for them the fit
// gives where a slope may start and end, not the shape their code draws between.
//
// The quantities: those dusk-grid judges (E, Edeck, mS2, landA, seaRadiance, airAmb0, and each
// view's Mfar). A share's own states give each point q0 (forced to 0) and q1 (forced to 1), the
// others as they are; every share is a lerp or an addition in its weight, so the point with the
// share at w is q0 + w ( q1 - q0 ), exactly, and so is a share placed anew.
//
// The fit, per weather, side and share (one with no judged effect, q1 = q0 within a thousandth
// everywhere, is listed and skipped):
//   - Points: the run's grid points but void ones; a quantity at a point whose residual (dusk-grid's
//     sum of the shares' terms less the point: shares acting on each other) is over 1 % of its
//     value is left out of every pair it is in.
//   - The step condition with half the judge's margin, at every adjacent pair of points (a higher,
//     b lower) and every judged quantity: q( b ) - q( a ) <= judge / 2 q( a ). A pair and quantity
//     that break it with the share held whole across the pair and held at none (a rise from the
//     other terms, which no placement of this share mends) are listed and not judged.
//   - Not fitted: moonKey and moonSky (they follow the moon's visibility, no dusk window), the
//     yunpeng and the local lights (lamps, on a form of their own).
//   - The slope's width: the twilight's fall k (stops per degree) is the mean over the slope of
//     -log2 slope of T (the run's cumulative T, every night share at 0) over the slope and the grid
//     points either side of it, for each judged quantity
//     the share moves by over a thousandth of q, taking the slowest; the width must be at least
//     1.5 / ( k ln 2 ), where a smoothstep's steepest slope (1.5 / width) meets the twilight's fall
//     (an addition q = T + w N with T >= N at the slope's foot). A slope where T does not fall
//     (k <= 0), or that the grid cannot measure it over, is refused.
//   - The solution (or, where none holds, the placement that breaks the fewest pairs, listed with
//     them): the highest e_top on a 0.25 degree lattice from +2.5 (the day above it is
//     dusk-grid's unchanged window) down to -18, with the
//     narrowest width (1, 1.5, 2, 3, 4, 5, 6, 8 degrees) that holds both; then the condition's
//     margin at every pair, and the overall condition (q( e' ) <= ( 1 + judge ) q( e ) for every
//     e' < e, midnight included) on the share's own series.
//   - All shares placed at once (each at its solved endpoints, the others' changes added: exact
//     where the shares act on separate terms, the residual otherwise): the step and overall
//     conditions over the whole grid, as dusk-grid judges them.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const JUDGED = [ 'E', 'Edeck', 'mS2', 'landA', 'seaRadiance', 'airAmb0' ];
const TWILIGHT = [ 'sun', 'hazeSun', 'hazeSky' ];
const WIDTHS = [ 1, 1.5, 2, 3, 4, 5, 6, 8 ];
// shares whose form is not a dusk window: the moon's key and its sky follow the moon's own
// visibility, the yunpeng and the local lights are lamps on a form of their own
const KEPT = [ 'moonKey', 'moonSky', 'yunpeng', 'localLights' ];
// (the top: dusk-grid's day window starts at +2.5, which no share may reach)
const LATTICE = { top: 2.5, bottom: - 18, step: 0.25 };

const smoothstep = ( a, b, x ) => { const t = Math.min( Math.max( ( x - a ) / ( b - a ), 0 ), 1 ); return t * t * ( 3 - 2 * t ); };
const shareAt = ( full, top, e ) => e === null ? 1 : 1 - smoothstep( full, top, e );
const fmt = ( x, d = 4 ) => x === null || x === undefined || Number.isNaN( x ) ? '-' : x === 0 ? '0' : Math.abs( x ) >= 1e5 || Math.abs( x ) < 1e-3 ? x.toExponential( d - 1 ) : x.toPrecision( d );
const pad = ( s, n ) => String( s ).padStart( n );
const label = ( p ) => p.at === 'midnight' ? 'midnight' : p.key;
const num = ( x ) => typeof x === 'number' && Number.isFinite( x );

/** The fit of `files` (dusk-grid's per weather and side: { weather, side, points }), as lines. */
export function fitDusk( files, { judge = 0.02, views = [ 'island' ] } = {} ) {

	const keys = [ ...JUDGED, ...views.map( ( v ) => `${ v }.Mfar` ) ];
	const half = judge / 2;
	const out = [ `dusk-fit: w = 1 - smoothstep( e_full, e_top, e ); the step condition at half the judge (${ ( half * 100 ).toFixed( 1 )} %), the overall at ${ ( 1 + judge ).toFixed( 3 ) }; quantities ${ keys.join( ', ' ) }` ];
	for ( const f of files ) {

		const all = f.points.filter( ( p ) => p.values && p.shares ).sort( ( a, b ) => ( b.e ?? - Infinity ) - ( a.e ?? - Infinity ) );
		const excluded = all.filter( ( p ) => p.void );
		// a quantity at a point whose residual is over 1 % of it
		const off = ( p, k ) => num( p.residual?.[ k ] ) && num( p.values[ k ] ) && Math.abs( p.residual[ k ] ) > 0.01 * Math.abs( p.values[ k ] );
		const grid = all.filter( ( p ) => p.grid && p.e !== null && ! excluded.includes( p ) );
		const night = all.find( ( p ) => p.at === 'midnight' && ! excluded.includes( p ) );
		const offList = keys.map( ( k ) => { const at = all.filter( ( p ) => off( p, k ) ); return at.length ? `${ k } ${ at.length } (${ label( at[ 0 ] ) } to ${ label( at[ at.length - 1 ] ) })` : null; } ).filter( Boolean );
		out.push( '', `== ${ f.weather } ${ f.side }: ${ grid.length } grid points${ night ? ' and midnight' : '' }; void: ${ excluded.map( label ).join( ' ' ) || 'none' }; residual over 1 %: ${ offList.join( ', ' ) || 'none' }` );
		const names = Object.keys( all[ 0 ]?.shares ?? {} ).filter( ( n ) => ! TWILIGHT.includes( n ) );
		const solved = {};
		for ( const n of names ) {

			const at = ( p, w, k ) => { const s = p.shares[ n ]; return s.q0[ k ] + w * ( s.q1[ k ] - s.q0[ k ] ); };
			const moved = keys.filter( ( k ) => all.some( ( p ) => num( p.shares[ n ].q1[ k ] ) && num( p.values[ k ] ) && Math.abs( p.shares[ n ].q1[ k ] - p.shares[ n ].q0[ k ] ) > 1e-3 * Math.abs( p.values[ k ] ) ) );
			if ( KEPT.includes( n ) ) { out.push( `  ${ pad( n, 13 ) } kept on its own form, not fitted` ); continue; }
			if ( ! moved.length ) { out.push( `  ${ pad( n, 13 ) } no judged effect (q1 - q0 under a thousandth of q everywhere)` ); continue; }
			// pairs no placement of this share mends
			const pairs = [], lost = [];
			for ( let i = 0; i + 1 < grid.length; i ++ ) for ( const k of keys ) {

				const a = grid[ i ], b = grid[ i + 1 ];
				if ( ! num( a.values[ k ] ) || ! num( b.values[ k ] ) || off( a, k ) || off( b, k ) ) continue;
				const breaks = ( w ) => at( b, w, k ) - at( a, w, k ) > half * at( a, w, k );
				if ( breaks( 0 ) && breaks( 1 ) ) lost.push( `${ label( a ) }>${ label( b ) } ${ k }` );
				else pairs.push( { a, b, k } );

			}
			const k_ = ( full, top ) => {

				let k = Infinity;
				for ( const q of moved ) {

					// (the slope's span, grown to the grid points either side of it)
					const span = grid.filter( ( p ) => p.e <= top + 0.5 + 1e-9 && p.e >= full - 0.5 - 1e-9 && num( p.cumulative?.T[ q ] ) && p.cumulative.T[ q ] > 0 );
					if ( span.length < 2 ) return - Infinity;
					const hi = span[ 0 ], lo = span[ span.length - 1 ];
					k = Math.min( k, Math.log2( hi.cumulative.T[ q ] / lo.cumulative.T[ q ] ) / ( hi.e - lo.e ) );

				}
				return k;

			};
			const breaking = ( full, top ) => pairs.filter( ( { a, b, k: q } ) => at( b, shareAt( full, top, b.e ), q ) - at( a, shareAt( full, top, a.e ), q ) > half * at( a, shareAt( full, top, a.e ), q ) );
			let fit = null, best = null;
			for ( let top = LATTICE.top; top >= LATTICE.bottom - 1e-9 && ! fit; top -= LATTICE.step ) for ( const width of WIDTHS ) {

				const full = top - width, k = k_( full, top );
				if ( ! ( k > 0 && k < Infinity ) || width < 1.5 / ( k * Math.LN2 ) ) continue;
				const broken = breaking( full, top );
				if ( ! broken.length ) { fit = { full, top, width, k }; break; }
				if ( ! best || broken.length < best.broken.length ) best = { full, top, width, k, broken };

			}
			const w0 = ( p ) => num( p.shares[ n ].w ) ? p.shares[ n ].w : null;
			const some = grid.filter( ( p ) => w0( p ) > 0 ), whole = grid.filter( ( p ) => w0( p ) === 1 );
			const nowText = grid.some( ( p ) => w0( p ) === null ) ? 'now a range of weights at some points' : `now in from ${ some.length ? some[ 0 ].key : 'none' }, whole from ${ whole.length ? whole[ 0 ].key : 'none' }`;
			if ( ! fit ) {

				out.push( `  ${ pad( n, 13 ) } no endpoints on the lattice hold (${ nowText }); moves ${ moved.join( ',' ) }; ${ lost.length } pairs rise with it whole and none (not judged)` );
				if ( best ) out.push( `  ${ pad( '', 13 ) } fewest broken: e_full ${ best.full.toFixed( 2 ) } e_top ${ best.top.toFixed( 2 ) } width ${ best.width } k ${ best.k.toFixed( 2 ) }, ${ best.broken.length } pairs: ${ best.broken.slice( 0, 6 ).map( ( { a, b, k: q } ) => `${ label( a ) }>${ label( b ) } ${ q }` ).join( '; ' ) }${ best.broken.length > 6 ? ' ...' : '' }` );
				continue;

			}
			solved[ n ] = fit;
			// the margin at each pair (the least over the quantities, in % of q( a ), left of the limit)
			const margins = [];
			for ( let i = 0; i + 1 < grid.length; i ++ ) {

				const a = grid[ i ], b = grid[ i + 1 ];
				let m = Infinity;
				for ( const { k: q } of pairs.filter( ( x ) => x.a === a ) ) {

					const qa = at( a, shareAt( fit.full, fit.top, a.e ), q ), qb = at( b, shareAt( fit.full, fit.top, b.e ), q );
					m = Math.min( m, half - ( qb - qa ) / qa );

				}
				if ( m !== Infinity && shareAt( fit.full, fit.top, a.e ) !== shareAt( fit.full, fit.top, b.e ) ) margins.push( `${ label( b ) } ${ ( m * 100 ).toFixed( 2 ) }` );

			}
			const series = [ ...grid, ...( night ? [ night ] : [] ) ];
			const overall = overallOf( series, keys, judge, ( p, q ) => at( p, shareAt( fit.full, fit.top, p.e ), q ) );
			out.push( `  ${ pad( n, 13 ) } e_full ${ pad( fit.full.toFixed( 2 ), 6 ) }  e_top ${ pad( fit.top.toFixed( 2 ), 6 ) }  width ${ fit.width }  k ${ fit.k === Infinity ? '-' : fit.k.toFixed( 2 ) } stops/deg  (${ nowText }); moves ${ moved.join( ',' ) }` );
			out.push( `  ${ pad( '', 13 ) } margin on the slope (% of q, the least quantity): ${ margins.join( ', ' ) || '-' }` );
			out.push( `  ${ pad( '', 13 ) } overall ${ overall.text }${ lost.length ? `; ${ lost.length } pairs rise with this share whole and none (not judged): ${ lost.slice( 0, 6 ).join( '; ' ) }${ lost.length > 6 ? ' ...' : '' }` : '' }` );

		}
		// every solved share placed at once
		const placed = ( p, q ) => {

			let v = p.values[ q ];
			for ( const [ n, fit ] of Object.entries( solved ) ) {

				const s = p.shares[ n ], w = num( s.w ) ? s.w : null;
				if ( w === null ) continue;
				v += ( shareAt( fit.full, fit.top, p.e ) - w ) * ( s.q1[ q ] - s.q0[ q ] );

			}
			return v;

		};
		const skipped = Object.keys( solved ).filter( ( n ) => all.some( ( p ) => ! num( p.shares[ n ].w ) ) );
		let steps = 0;
		const bad = [];
		for ( let i = 0; i + 1 < grid.length; i ++ ) for ( const q of keys ) {

			const a = placed( grid[ i ], q ), b = placed( grid[ i + 1 ], q );
			if ( ! num( a ) || ! num( b ) || off( grid[ i ], q ) || off( grid[ i + 1 ], q ) ) continue;
			if ( b - a > judge * a + 1e-12 ) { steps ++; bad.push( `${ label( grid[ i ] ) }>${ label( grid[ i + 1 ] ) } ${ q } ${ ( ( b / a - 1 ) * 100 ).toFixed( 2 ) } %` ); }

		}
		const overall = overallOf( [ ...grid, ...( night ? [ night ] : [] ) ], keys, judge, placed );
		out.push( `  all placed (${ Object.keys( solved ).length } shares${ skipped.length ? `; a share without one weight per point kept as is: ${ skipped.join( ',' ) }` : '' }): ${ steps } steps over ${ ( judge * 100 ).toFixed( 1 ) } %${ bad.length ? ` (${ bad.slice( 0, 6 ).join( '; ' ) }${ bad.length > 6 ? ' ...' : '' })` : '' }; overall ${ overall.text }` );

	}
	return out;

}

// the overall condition over a series in falling elevation (midnight last): the largest
// q( e' ) / q( e ) for e' < e of each quantity, and whether all lie within 1 + judge
function overallOf( series, keys, judge, value ) {

	let worst = { r: - Infinity };
	const over = [];
	for ( const q of keys ) {

		let best = { r: - Infinity };
		for ( let i = 0; i < series.length; i ++ ) for ( let j = i + 1; j < series.length; j ++ ) {

			const hi = value( series[ i ], q ), lo = value( series[ j ], q );
			if ( ! num( hi ) || ! num( lo ) || hi <= 0 ) continue;
			const r = lo / hi;
			if ( r > best.r ) best = { r, q, hi: series[ i ], lo: series[ j ] };

		}
		if ( best.r > 1 + judge + 1e-12 ) over.push( `${ q } ${ best.r.toFixed( 3 ) } at ${ label( best.lo ) } over ${ label( best.hi ) }` );
		if ( best.r > worst.r ) worst = best;

	}
	return { text: worst.r === - Infinity ? '-' : over.length ? `# ${ over.join( '; ' ) }` : `held (largest ${ worst.r.toFixed( 4 ) }, ${ worst.q } at ${ label( worst.lo ) } over ${ label( worst.hi ) })` };

}

/** Reads a dusk-grid output directory's per weather and side files. */
export function readRun( dir ) {

	return readdirSync( dir ).filter( ( f ) => /^[a-z]+-(evening|morning)\.json$/.test( f ) ).map( ( f ) => JSON.parse( readFileSync( path.join( dir, f ), 'utf8' ) ) );

}

if ( process.argv[ 1 ] && path.resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url ) ) {

	const args = process.argv.slice( 2 );
	const dir = args.find( ( a ) => ! a.startsWith( '--' ) && ! [ '--judge', '--views' ].includes( args[ args.indexOf( a ) - 1 ] ) );
	const opt = ( name, fallback ) => { const i = args.indexOf( `--${ name }` ); return i >= 0 ? args[ i + 1 ] : fallback; };
	if ( ! dir || ! existsSync( dir ) ) {

		console.error( 'usage: node tools/dusk-fit.mjs <dusk-grid out dir> [--judge 0.02] [--views island]' );
		process.exit( 2 );

	}
	const files = readRun( dir );
	const lines = fitDusk( files, { judge: Number( opt( 'judge', '0.02' ) ), views: opt( 'views', files[ 0 ]?.views?.join( ',' ) ?? 'island' ).split( ',' ) } );
	writeFileSync( path.join( dir, 'fit.txt' ), lines.join( '\n' ) + '\n' );
	console.log( path.join( dir, 'fit.txt' ) );

}
