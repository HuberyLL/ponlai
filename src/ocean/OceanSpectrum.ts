/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 * Based on the spectrum helpers in src/ocean/OceanFFT.js and the sea states in src/ui/AppUI.js at
 * 4811ba48d795197de5621985f404e765c0b7c0ef.
 */

const GRAVITY = 9.81;

export interface WaveSpectrumSettings {
	scale?: number; // multiplies the whole spectrum (tidewater's WaveSystem.scale)
	windSpeed: number;
	windDirection: number; // degrees in the Fourier convention; the positive IFFT travels oppositely
	fetch: number; // metres, unlike Tidewater's kilometre-valued UI
	spread: number; // blend from broad cosine-squared spreading to frequency-dependent spreading
	swell: number; // extra directional concentration, independently of spectral height
	peakEnhancement: number;
	shortWavesFade: number;
	peakPeriod?: number;
}

// tidewater's distant swell: a second wave system of its own wind and fetch, at a heading of its
// own (tidewater's 5 degrees against the local sea's 25), scaled by the sea state.
export interface SwellParams {
	scale: number;
	windSpeed: number;
	fetch: number; // m
	directionOffset: number; // degrees from the local sea's heading
	spread: number;
	swell: number;
	peakEnhancement: number;
	shortWavesFade: number;
}

export const DEFAULT_SWELL: Readonly<SwellParams> = {
	scale: 0.48, windSpeed: 6, fetch: 1200e3, directionOffset: - 20, spread: 1, swell: 0.9, peakEnhancement: 3.3, shortWavesFade: 0.1,
};

// tidewater's sea states (AppUI.js `SEA`), keyed by the wind 10 m up: the local sea's fetch, the
// choppiness and the swell's scale. The wind levels of weather/Wind.ts fall on them: gentle (3.8 m/s)
// next to Calm, fresh (7) on Breezy, tidewater's default, strong (11) next to Choppy.
const SEA_STATES = [
	{ wind: 3.5, fetch: 40e3, choppiness: 0.75, swell: 0.28 }, // Calm
	{ wind: 7, fetch: 120e3, choppiness: 0.9, swell: 0.48 }, // Breezy
	{ wind: 12, fetch: 300e3, choppiness: 1.05, swell: 0.68 }, // Choppy
	{ wind: 20, fetch: 900e3, choppiness: 1.2, swell: 1.0 }, // Storm
];

/** The sea state at a wind speed, interpolated between tidewater's (held at the first and last). */
export function seaState( windSpeed: number ): { fetch: number; choppiness: number; swell: number } {

	const s = SEA_STATES;
	let i = 0;
	while ( i < s.length - 2 && windSpeed > s[ i + 1 ].wind ) i ++;
	const t = Math.min( Math.max( ( windSpeed - s[ i ].wind ) / ( s[ i + 1 ].wind - s[ i ].wind ), 0 ), 1 );
	const mix = ( a: number, b: number ) => a + ( b - a ) * t;
	return { fetch: mix( s[ i ].fetch, s[ i + 1 ].fetch ), choppiness: mix( s[ i ].choppiness, s[ i + 1 ].choppiness ), swell: mix( s[ i ].swell, s[ i + 1 ].swell ) };

}

function dispersion( k: number, depth: number ): number {

	return Math.sqrt( GRAVITY * k * Math.tanh( Math.min( k * depth, 20 ) ) );

}

function dispersionDerivative( k: number, depth: number ): number {

	if ( k < 1e-8 ) return Math.sqrt( GRAVITY * depth );
	const kd = Math.min( k * depth, 20 ), th = Math.tanh( kd );
	return GRAVITY * ( th + k * depth * ( 1 - th * th ) ) / ( 2 * dispersion( k, depth ) );

}

function tmaCorrection( omega: number, depth: number ): number {

	const omegaH = omega * Math.sqrt( depth / GRAVITY );
	if ( omegaH <= 1 ) return omegaH * omegaH * 0.5;
	if ( omegaH < 2 ) return 1 - ( 2 - omegaH ) ** 2 * 0.5;
	return 1;

}

function normalisationFactor( s: number ): number {

	// Tidewater's fit keeps cos^(2s) direction distributions comparable in energy as
	// their width changes with frequency; spread must not double as an amplitude dial.
	const s2 = s * s, s3 = s2 * s, s4 = s3 * s;
	return s < 5 ? - 0.000564 * s4 + 0.00776 * s3 - 0.044 * s2 + 0.192 * s + 0.163
		: - 4.80e-8 * s4 + 1.07e-5 * s3 - 9.53e-4 * s2 + 0.059 * s + 0.393;

}

/** Returns the two-dimensional k-space energy density, including the omega-to-k Jacobian. */
export function createWaveSpectrum( settings: WaveSpectrumSettings, depth: number ): ( kx: number, kz: number ) => number {

	if ( ! Number.isFinite( depth ) || depth <= 0 ) throw new RangeError( 'Ocean depth must be positive and finite.' );
	if ( settings.peakPeriod !== undefined && ( ! Number.isFinite( settings.peakPeriod ) || settings.peakPeriod <= 0 ) ) throw new RangeError( 'Swell period must be positive and finite.' );
	const U = Math.max( 0.1, settings.windSpeed ), fetch = Math.max( 1, settings.fetch );
	const alpha = 0.076 * Math.pow( U * U / ( fetch * GRAVITY ), 0.22 ) * ( settings.scale ?? 1 );
	const peakOmega = settings.peakPeriod === undefined ? 22 * Math.pow( GRAVITY * GRAVITY / ( U * fetch ), 0.33 ) : 2 * Math.PI / settings.peakPeriod;
	const angle = settings.windDirection * Math.PI / 180;
	const spread = Math.max( 0, Math.min( 1, settings.spread ) );
	const concentration = Math.max( 0, Math.min( 1, settings.swell ) );
	const gamma = Math.max( 1, settings.peakEnhancement ), fade2 = settings.shortWavesFade ** 2;
	return ( kx, kz ) => {

		const k = Math.hypot( kx, kz );
		if ( k < 1e-6 ) return 0;
		const omega = dispersion( k, depth );
		const sigma = omega <= peakOmega ? 0.07 : 0.09;
		const r = Math.exp( - ( ( omega - peakOmega ) ** 2 ) / ( 2 * sigma * sigma * peakOmega * peakOmega ) );
		const jonswap = tmaCorrection( omega, depth ) * alpha * GRAVITY * GRAVITY / omega ** 5
			* Math.exp( - 1.25 * ( peakOmega / omega ) ** 4 ) * gamma ** r;
		const ratio = omega / peakOmega;
		const spreadPower = ( omega > peakOmega ? 9.77 * ratio ** - 2.5 : 6.97 * ratio ** 5 )
			+ Math.tanh( Math.min( ratio, 20 ) ) * 16 * concentration * concentration;
		const theta = Math.atan2( kz, kx ) - angle, c = Math.cos( theta );
		const broad = c > 0 ? c * c * 2 / Math.PI : 0;
		const narrow = normalisationFactor( spreadPower ) * Math.abs( Math.cos( theta * 0.5 ) ) ** ( 2 * spreadPower );
		const direction = broad + ( narrow - broad ) * spread;
		return jonswap * direction * Math.exp( - fade2 * k * k ) * dispersionDerivative( k, depth ) / k;

	};

}
