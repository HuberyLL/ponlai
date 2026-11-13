// The interface's colours, Chinese traditional colours, the one place they are written.
//
// The interface's colours, Chinese traditional colours (docs/design/ui.md, Palette), the one place they are
// written: GameUi sets each as a CSS variable on the interface's root (`--gao`, ...), and code that
// blends them (a need's bar running low) reads them here.

export const PALETTE = {
	/** 缟: the main white, text and icons */
	gao: '#F2ECDE',
	/** 月白: the sheen inside a white */
	yuebai: '#D6ECF0',
	/** 精白: the player's words only */
	jingbai: '#FFFFFF',
	/** 黛: the mist shadow under text */
	dai: '#0F1E21',
	/** 苍: labels, inactive choices */
	cang: '#8A9D9E',
	/** 金: selection only */
	jin: '#EACD76',
	/** 琥珀: the satiety bar */
	hupo: '#CA6924',
	/** 天水碧: the hydration bar */
	tianshuibi: '#5AA4AE',
	/** 朱: alerts, shortages */
	zhu: '#ED5736',
} as const;

export type PaletteColour = keyof typeof PALETTE;

function channels( hex: string ): [ number, number, number ] {

	const n = parseInt( hex.slice( 1 ), 16 );
	return [ ( n >> 16 ) & 255, ( n >> 8 ) & 255, n & 255 ];

}

/** The blend of two colours (t 0: a, 1: b), as a CSS colour. */
export function mix( a: string, b: string, t: number ): string {

	const ca = channels( a ), cb = channels( b ), k = Math.min( Math.max( t, 0 ), 1 );
	const c = ca.map( ( v, i ) => Math.round( v + ( cb[ i ] - v ) * k ) );
	return `rgb(${ c[ 0 ] }, ${ c[ 1 ] }, ${ c[ 2 ] })`;

}
