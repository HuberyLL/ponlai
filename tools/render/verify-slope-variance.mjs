// Checks the sea's distribution of the slopes no pixel resolves on the CPU, with no GPU.
//
// It checks two things: the table of the slope variance the FFT cascades' filtered reads lose, and
// the water's means over that distribution.
//
// The table (packages/render/ocean/UnresolvedSlopes.ts) says what a cascade's reads lose at each
// footprint from the spectrum alone. Here each of the water's four cascades (OceanFFT.ts
// `cascadeBands`, the real tiles and bands) has its field of slopes built on the CPU (a 256 x 256
// FFT of modes of the spectrum's amplitude and random phases, the waves even over the directions as
// the table takes them), its box mips made, and it is read by the table's model of the sampler
// (trilinear, and at ratios 2 and 4 two and four reads evenly spread along the footprint's long axis,
// at the level of the short axis) at random positions and headings. What those reads keep of the
// field's variance, along the long axis and across it, plus what the table says is lost must be the
// field's variance, for two seeds, at ten levels between the table's rows (from under a texel to near
// the whole tile) and the ratios 1, 2 and 4. The table is read through the packing the water's
// uniform array holds (`fillSlopeEntries`) and the reader that mirrors the shader's
// (`readSlopeEntries`). The table's total must equal the field's.
//
// The budget (OceanFFT.ts `slopeBudget`): at each wind level, with the island's distant swell, and
// with the share of the slope held below every pixel at 0, 0.2, 0.35, 0.5 and 0.8, what the cascades
// and the near ripples hold plus what no read holds must be Cox and Munk's mean square slope, what no
// read holds at least the share while the finest cascade holds any slope (within a thousandth of
// the budget: the scale is solved from the spectrum's integral, the table sums its own grid), and the
// finest cascade's scale must not grow with the share.
//
// What it does not cover: the shader's own indexing of the uniform array and its footprint's axes
// (UnresolvedSlopes.ts `slopeReader` and Water.ts `surface`, TSL that this check does not run;
// `readSlopeEntries` restates the indexing); the ratios between the columns (the shader interpolates them, the reads here are whole); and
// the hardware's anisotropic rule, which is the implementation's own and may differ from the model
// (the model is checked against itself, built two ways, not against a GPU's reads).
//
// The means (packages/render/ocean/SlopeLobe.ts `reflectionLobe`, the formulas restated here) against a
// numerical integration over the same Gaussian slopes, the facets weighted by their projected area
// toward the eye: the visible facets' mean cosine; the mean Fresnel, F at the mean cosine less and
// plus its spread, averaged; the reflected rays' share over the horizon; and Smith's shadowing of
// the rays that rise, at the lobe's centre and edges. The slopes' spread along the view runs to
// 0.13 (the strong wind's farthest sea) and the view from grazing (cosine 0.02) to 0.8.
//
// Tolerances, set from the method's own errors: a cascade's conservation within 2 % of its variance
// per axis (the reads' positions sampled, the response's grid of wavenumbers, levels and directions,
// the table read between its rows, and the anisotropic reads taken as one filter); the totals within 3 % (the field's modes against
// the spectrum's integral); the means within 5 %, the share over the horizon and the shadowing within
// 5 % and 4 % absolute.
//
// Usage:
//   node tools/render/verify-slope-variance.mjs
//
// Options: none.
//
// Output: one line on stdout naming what passed, the count of assertions and the largest error of
// each kind; a failed assertion's message and stack on stderr.
//
// GPU lock and browser: neither; node strips the imported TypeScript itself.
//
// Cost: a few seconds, CPU only.
//
// Exit codes: 0 every check passes; 1 a check failed (the assertion is thrown).
import '../kit/qos.mjs';
import '../kit/help.mjs';
import { assert, assertions } from '../kit/assert-count.mjs';
import { slopeDensity, seaState } from '../../packages/render/ocean/OceanSpectrum.ts';
import { SLOPE_ENTRIES, slopeTable, fillSlopeEntries, readSlopeEntries, cascadeLevel } from '../../packages/render/ocean/UnresolvedSlopes.ts';
import { CASCADE_SIZES, FFT_SIZE, cascadeBands, slopeBudget } from '../../packages/render/ocean/OceanFFT.ts';
import { WIND_LEVELS } from '../../packages/render/sky/Weather.ts';
import { SEA } from '../../packages/island/look/Sea.ts';

const N = FFT_SIZE;
const SYSTEM = { windSpeed: 3.8, windDirection: 0, fetch: seaState( 3.8 ).fetch, spread: 0.85, swell: 0.05, peakEnhancement: 3.3, shortWavesFade: 0.01 };
const DEPTH = 500;
const density = slopeDensity( SYSTEM, DEPTH );

// ---- the table's conservation

function rng( seed ) {

	let a = seed >>> 0;
	return () => {

		a = ( a + 0x6D2B79F5 ) >>> 0;
		let t = a;
		t = Math.imul( t ^ ( t >>> 15 ), t | 1 );
		t ^= t + Math.imul( t ^ ( t >>> 7 ), t | 61 );
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

// an in-place radix-2 FFT of n complex values (re, im), inverse sign, unnormalised
function fft1( re, im, n, stride, offset ) {

	for ( let i = 1, j = 0; i < n; i ++ ) {

		let bit = n >> 1;
		for ( ; j & bit; bit >>= 1 ) j ^= bit;
		j ^= bit;
		if ( i < j ) {

			const a = offset + i * stride, b = offset + j * stride;
			[ re[ a ], re[ b ] ] = [ re[ b ], re[ a ] ];
			[ im[ a ], im[ b ] ] = [ im[ b ], im[ a ] ];

		}

	}
	for ( let len = 2; len <= n; len <<= 1 ) {

		const ang = 2 * Math.PI / len, wr = Math.cos( ang ), wi = Math.sin( ang );
		for ( let i = 0; i < n; i += len ) {

			let cr = 1, ci = 0;
			for ( let j = 0; j < len / 2; j ++ ) {

				const a = offset + ( i + j ) * stride, b = offset + ( i + j + len / 2 ) * stride;
				const xr = re[ b ] * cr - im[ b ] * ci, xi = re[ b ] * ci + im[ b ] * cr;
				re[ b ] = re[ a ] - xr; im[ b ] = im[ a ] - xi;
				re[ a ] += xr; im[ a ] += xi;
				const t = cr * wr - ci * wi;
				ci = cr * wi + ci * wr; cr = t;

			}

		}

	}

}

function ifft2( re, im ) {

	for ( let r = 0; r < N; r ++ ) fft1( re, im, N, 1, r * N );
	for ( let c = 0; c < N; c ++ ) fft1( re, im, N, N, c );

}

// A cascade's field of slopes ( x, z ) from its band: each mode of the half plane in the band a wave
// of random phase whose slope variance is the spectrum's over the mode's cell, the directions even.
function slopeField( band, seed ) {

	const random = rng( seed ), dk = 2 * Math.PI / band.size;
	const xr = new Float64Array( N * N ), xi = new Float64Array( N * N ), zr = new Float64Array( N * N ), zi = new Float64Array( N * N );
	let total = 0;
	for ( let j = - N / 2 + 1; j < N / 2; j ++ ) for ( let i = - N / 2 + 1; i < N / 2; i ++ ) {

		if ( j < 0 || ( j === 0 && i <= 0 ) ) continue;
		const kx = i * dk, kz = j * dk, k = Math.hypot( kx, kz );
		if ( k < band.k0 || ( ! band.square && k >= band.k1 ) ) continue;
		// both modes of the pair hold w each; the one wave holds 2 w
		const w = density( k ) / ( 2 * Math.PI * k ) * dk * dk * band.gain;
		const amplitude = Math.sqrt( 4 * w ) / k, phase = 2 * Math.PI * random();
		const at = ( ( j + N ) % N ) * N + ( ( i + N ) % N );
		// i k a e^( i phase ): its real part, the slope
		xr[ at ] = - kx * amplitude * Math.sin( phase ); xi[ at ] = kx * amplitude * Math.cos( phase );
		zr[ at ] = - kz * amplitude * Math.sin( phase ); zi[ at ] = kz * amplitude * Math.cos( phase );
		total += 2 * w;

	}
	ifft2( xr, xi );
	ifft2( zr, zi );
	// the box mips of both components
	const mips = [ { x: Float64Array.from( xr ), z: Float64Array.from( zr ), n: N } ];
	while ( mips[ mips.length - 1 ].n > 1 ) {

		const p = mips[ mips.length - 1 ], n = p.n / 2, x = new Float64Array( n * n ), z = new Float64Array( n * n );
		for ( let r = 0; r < n; r ++ ) for ( let c = 0; c < n; c ++ ) {

			const a = 2 * r * p.n + 2 * c, b = a + p.n;
			x[ r * n + c ] = ( p.x[ a ] + p.x[ a + 1 ] + p.x[ b ] + p.x[ b + 1 ] ) / 4;
			z[ r * n + c ] = ( p.z[ a ] + p.z[ a + 1 ] + p.z[ b ] + p.z[ b + 1 ] ) / 4;

		}
		mips.push( { x, z, n } );

	}
	let sxx = 0, szz = 0, sxz = 0;
	for ( let i = 0; i < N * N; i ++ ) {

		sxx += xr[ i ] * xr[ i ]; szz += zr[ i ] * zr[ i ]; sxz += xr[ i ] * zr[ i ];

	}
	return { mips, total, sxx: sxx / ( N * N ), szz: szz / ( N * N ), sxz: sxz / ( N * N ) };

}

// a bilinear read of level m at ( u, v ) in level 0's texels, wrapped
function bilinear( mip, u, v, out ) {

	const s = N / mip.n, n = mip.n;
	const fu = u / s - 0.5, fv = v / s - 0.5, iu = Math.floor( fu ), iv = Math.floor( fv ), tu = fu - iu, tv = fv - iv;
	const u0 = ( ( iu % n ) + n ) % n, u1 = ( u0 + 1 ) % n, v0 = ( ( iv % n ) + n ) % n, v1 = ( v0 + 1 ) % n;
	const w00 = ( 1 - tu ) * ( 1 - tv ), w10 = tu * ( 1 - tv ), w01 = ( 1 - tu ) * tv, w11 = tu * tv;
	out[ 0 ] += w00 * mip.x[ v0 * n + u0 ] + w10 * mip.x[ v0 * n + u1 ] + w01 * mip.x[ v1 * n + u0 ] + w11 * mip.x[ v1 * n + u1 ];
	out[ 1 ] += w00 * mip.z[ v0 * n + u0 ] + w10 * mip.z[ v0 * n + u1 ] + w01 * mip.z[ v1 * n + u0 ] + w11 * mip.z[ v1 * n + u1 ];

}

// The sampler's read at level `level` (below 0: level 0) with 2^delta reads spread along the heading
// over 2^( level + delta ) texels, the mean of trilinear reads.
function read( field, u, v, level, delta, cos, sin, out ) {

	const n = 2 ** delta, length = 2 ** ( level + delta ), l = Math.max( level, 0 );
	const m = Math.min( Math.floor( l ), field.mips.length - 2 ), f = l - m;
	out[ 0 ] = 0; out[ 1 ] = 0;
	const a = [ 0, 0 ], b = [ 0, 0 ];
	for ( let t = 0; t < n; t ++ ) {

		const o = n === 1 ? 0 : ( ( t + 0.5 ) / n - 0.5 ) * length;
		a[ 0 ] = a[ 1 ] = b[ 0 ] = b[ 1 ] = 0;
		bilinear( field.mips[ m ], u + o * cos, v + o * sin, a );
		bilinear( field.mips[ m + 1 ], u + o * cos, v + o * sin, b );
		out[ 0 ] += ( a[ 0 ] * ( 1 - f ) + b[ 0 ] * f ) / n;
		out[ 1 ] += ( a[ 1 ] * ( 1 - f ) + b[ 1 ] * f ) / n;

	}

}

const SAMPLES = 64000;
// the water's cascades as the spectrum fills them (their amplitudes do not matter here: each is
// checked against its own variance)
const BANDS = cascadeBands( CASCADE_SIZES, 1, 1 );
const table = slopeTable( [ SYSTEM ], DEPTH, BANDS, N );
// the table packed as the water's uniform array holds it, read as the water's shader reads it
const entries = Array.from( { length: SLOPE_ENTRIES }, () => ( { x: 0, y: 0, z: 0, w: 0, set( x, y, z, w ) {

	Object.assign( this, { x, y, z, w } );

} } ) );
fillSlopeEntries( table, entries );
// levels between the table's rows (the cascades' texels are not powers of two, so the rows fall at
// a different fraction of a level in each), from under a texel to near the whole tile
const LEVELS = [ - 1.7, - 0.6, 0.15, 0.4, 0.85, 1.3, 2.1, 3.65, 5.2, 6.9 ];
let worstKept = 0, worstTotal = 0;
const worstBy = BANDS.map( () => 0 );
BANDS.forEach( ( band, c ) => {

	for ( const seed of [ 1, 2 ] ) {

		const field = slopeField( band, seed * 7919 + c );
		const totalError = Math.abs( field.total / table.total[ c ] - 1 );
		worstTotal = Math.max( worstTotal, totalError );
		assert.ok( totalError < 0.03, `the ${ band.size } m cascade's field holds ${ field.total }, the table ${ table.total[ c ] }` );
		const texel = Math.log2( band.size / N );
		for ( const level of LEVELS ) {

			const row = level + texel;
			assert.ok( Math.abs( cascadeLevel( band.size, N, row ) - level ) < 1e-9 );
			for ( const delta of [ 0, 1, 2 ] ) {

				const random = rng( seed * 1000 + delta * 100 + Math.round( level * 20 ) + c * 7 );
				let along = 0, across = 0, fieldAlong = 0, fieldAcross = 0;
				const s = [ 0, 0 ];
				for ( let i = 0; i < SAMPLES; i ++ ) {

					const psi = 2 * Math.PI * random(), cs = Math.cos( psi ), sn = Math.sin( psi );
					read( field, N * random(), N * random(), level, delta, cs, sn, s );
					const a = s[ 0 ] * cs + s[ 1 ] * sn, b = - s[ 0 ] * sn + s[ 1 ] * cs;
					along += a * a; across += b * b;
					fieldAlong += field.sxx * cs * cs + field.szz * sn * sn + 2 * field.sxz * cs * sn;
					fieldAcross += field.sxx * sn * sn + field.szz * cs * cs - 2 * field.sxz * cs * sn;

				}
				const lost = readSlopeEntries( entries, row, delta );
				const half = table.total[ c ] / 2;
				const keptAlong = along / fieldAlong, keptAcross = across / fieldAcross;
				const errAlong = keptAlong - ( 1 - lost.along[ c ] / half ), errAcross = keptAcross - ( 1 - lost.across[ c ] / half );
				const err = Math.max( Math.abs( errAlong ), Math.abs( errAcross ) );
				worstKept = Math.max( worstKept, err );
				worstBy[ c ] = Math.max( worstBy[ c ], err );
				if ( process.env.SLOPE_VERBOSE ) console.log( band.size, seed, level, delta, errAlong.toFixed( 4 ), errAcross.toFixed( 4 ) );
				assert.ok( Math.abs( errAlong ) < 0.02 && Math.abs( errAcross ) < 0.02,
					`the ${ band.size } m cascade at level ${ level }, ratio ${ 2 ** delta }: the reads keep ${ keptAlong.toFixed( 4 ) } along and ${ keptAcross.toFixed( 4 ) } across, the table ${ ( 1 - lost.along[ c ] / half ).toFixed( 4 ) } and ${ ( 1 - lost.across[ c ] / half ).toFixed( 4 ) }` );

			}

		}

	}

} );

// ---- the budget (OceanFFT.ts `slopeBudget`)

const SHARES = [ 0, 0.2, 0.35, 0.5, 0.8 ];
for ( const [ level, { windSpeed } ] of Object.entries( WIND_LEVELS ) ) {

	const sea = seaState( windSpeed );
	const systems = [
		{ ...SYSTEM, windSpeed, fetch: sea.fetch },
		{ ...SEA.swell, scale: sea.swell, windDirection: SEA.swell.directionOffset },
	];
	let scale = Infinity;
	for ( const share of SHARES ) {

		const b = slopeBudget( systems, DEPTH, CASCADE_SIZES, 1, windSpeed, share );
		const at = `at the ${ level } wind with a share of ${ share } below the pixel`;
		if ( process.env.SLOPE_VERBOSE ) console.log( level, share, b.fineScale.toFixed( 4 ), ( b.held / b.budget ).toFixed( 4 ), ( b.residual / b.budget ).toFixed( 4 ) );
		assert.ok( b.fineScale <= scale, `the finest cascade's scale ${ b.fineScale } grows with the share ${ at }` );
		scale = b.fineScale;
		if ( b.held <= b.budget ) assert.ok( Math.abs( b.held + b.residual - b.budget ) < 1e-9 * b.budget, `held ${ b.held } and lost ${ b.residual } make ${ b.held + b.residual }, not Cox and Munk's ${ b.budget }, ${ at }` );
		if ( b.fineScale > 0 ) assert.ok( b.residual >= ( share - 1e-3 ) * b.budget, `no read holds ${ b.residual }, under the share's ${ share * b.budget }, ${ at }` );

	}

}

// ---- the means over the distribution (SlopeLobe.ts `reflectionLobe`)

const IOR = 1.333;
function fresnel( cosI ) {

	const c = Math.min( Math.max( cosI, 0 ), 1 ), g2 = IOR * IOR - 1 + c * c;
	if ( g2 < 0 ) return 1;
	const g = Math.sqrt( g2 ), a = ( g - c ) / ( g + c ), b = ( c * ( g + c ) - 1 ) / ( c * ( g - c ) + 1 );
	return 0.5 * a * a * ( 1 + b * b );

}

function erf( x ) {

	const s = Math.sign( x ), z = Math.abs( x ), t = 1 / ( 1 + 0.3275911 * z );
	return s * ( 1 - ( ( ( ( 1.061405429 * t - 1.453152027 ) * t + 1.421413741 ) * t - 0.284496736 ) * t + 0.254829592 ) * t * Math.exp( - z * z ) );

}

const cdf = ( x ) => 0.5 * ( 1 + erf( x / Math.SQRT2 ) ), pdf = ( x ) => Math.exp( - x * x / 2 ) / Math.sqrt( 2 * Math.PI );
// Smith's G1 of Gaussian slopes of spread s along the ray, exact; and the shader's rational form
function smithExact( y, s ) {

	if ( y <= 0 ) return 0;
	if ( y >= 1 ) return 1;
	const a = y / Math.sqrt( 1 - y * y ) / ( s * Math.SQRT2 );
	return 1 / ( 1 + ( erf( a ) - 1 ) / 2 + Math.exp( - a * a ) / ( 2 * a * Math.sqrt( Math.PI ) ) );

}

function smithShader( y, s ) {

	const c = Math.min( Math.max( y, 0 ), 0.9999 ), a = c / ( Math.sqrt( 1 - c * c ) * s * Math.SQRT2 );
	return a < 1.6 ? ( 3.535 * a + 2.181 * a * a ) / ( 1 + 2.276 * a + 2.577 * a * a ) : 1;

}

const LIFT = 2, EDGE = 0.05;
let worstCos = 0, worstFresnel = 0, worstShare = 0, worstShadow = 0;
for ( const s of [ 0.03, 0.06, 0.1, 0.13 ] ) for ( const c of [ 0.02, 0.05, 0.1, 0.2, 0.4, 0.8 ] ) {

	// the integration: the slopes on a grid over five spreads, each facet weighted by its density and
	// its projected area toward the eye, its reflected ray shadowed by Smith's exact G1
	const v = [ Math.sqrt( 1 - c * c ), c, 0 ], K = 160, R = 5;
	let W = 0, cosSum = 0, fresnelSum = 0, upSum = 0, shadowSum = 0;
	for ( let i = 0; i < K; i ++ ) for ( let j = 0; j < K; j ++ ) {

		const sx = ( ( i + 0.5 ) / K * 2 - 1 ) * R * s, sz = ( ( j + 0.5 ) / K * 2 - 1 ) * R * s;
		const L = Math.hypot( sx, 1, sz ), m = [ - sx / L, 1 / L, - sz / L ];
		const vm = v[ 0 ] * m[ 0 ] + v[ 1 ] * m[ 1 ];
		if ( vm <= 0 ) continue;
		const w = Math.exp( - ( sx * sx + sz * sz ) / ( 2 * s * s ) ) * vm / m[ 1 ];
		const ly = 2 * vm * m[ 1 ] - v[ 1 ];
		W += w; cosSum += w * vm; fresnelSum += w * fresnel( vm );
		if ( ly > 0 ) {

			upSum += w; shadowSum += w * smithExact( ly, s );

		}

	}
	// the shader's
	const m = c / s, e1 = c * cdf( m ) + s * pdf( m ), e2 = ( c * c + s * s ) * cdf( m ) + c * s * pdf( m );
	const e3 = ( c * c + 3 * s * s ) * c * cdf( m ) + ( c * c + 2 * s * s ) * s * pdf( m );
	const cosVisible = Math.min( e2 / e1, 1 ), spread = Math.sqrt( Math.max( e3 / e1 - ( e2 / e1 ) ** 2, 0 ) );
	const facetFresnel = ( fresnel( Math.max( cosVisible - spread, 1e-4 ) ) + fresnel( Math.min( cosVisible + spread, 1 ) ) ) / 2;
	const lobeY = Math.min( c + ( cosVisible - c ) * LIFT, 1 ), lobeW = 2 * s;
	const share = cdf( lobeY / Math.max( spread * LIFT, EDGE ) );
	const shadow = 0.25 * smithShader( lobeY - lobeW, s ) + 0.5 * smithShader( lobeY, s ) + 0.25 * smithShader( lobeY + lobeW, s );
	const errCos = Math.abs( cosVisible / ( cosSum / W ) - 1 ), errFresnel = Math.abs( facetFresnel / ( fresnelSum / W ) - 1 );
	const errShare = Math.abs( share - upSum / W ), errShadow = Math.abs( shadow - shadowSum / upSum );
	worstCos = Math.max( worstCos, errCos ); worstFresnel = Math.max( worstFresnel, errFresnel );
	worstShare = Math.max( worstShare, errShare ); worstShadow = Math.max( worstShadow, errShadow );
	const at = `at a spread of ${ s } and a view's cosine of ${ c }`;
	assert.ok( errCos < 0.05, `the visible facets' mean cosine ${ cosVisible } against ${ cosSum / W } ${ at }` );
	assert.ok( errFresnel < 0.05, `the mean Fresnel ${ facetFresnel } against ${ fresnelSum / W } ${ at }` );
	assert.ok( errShare < 0.05, `the share over the horizon ${ share } against ${ upSum / W } ${ at }` );
	assert.ok( errShadow < 0.04, `the rising rays' shadowing ${ shadow } against ${ shadowSum / upSum } ${ at }` );

}

const pct = ( x ) => `${ ( x * 100 ).toFixed( 1 ) } %`;
console.log( `Slope variance: the table's lost variance and the reads' kept variance make each cascade's own (worst ${ pct( worstKept ) } of an axis's variance; totals within ${ pct( worstTotal ) }), the slope held and lost make Cox and Munk's at every wind and share below the pixel, and the lobe's means hold against integration (mean cosine ${ pct( worstCos ) }, mean Fresnel ${ pct( worstFresnel ) }, share over the horizon ${ worstShare.toFixed( 3 ) }, shadowing ${ worstShadow.toFixed( 3 ) }) (${ assertions() } assertions).` );
