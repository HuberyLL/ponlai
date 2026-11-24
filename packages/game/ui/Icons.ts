// The interface's icons: white line art drawn with the brush, as SVG bodies in `currentColor`.
//
// The interface's icons: white line art drawn with the brush (docs/design/ui.md, Principles: icons are
// the buttons, white line art with no label). The art is IconArt.ts's; this module draws it. Each
// is an SVG body in its own view box, filled with `currentColor`, so its colour comes from the
// element that holds it (缟, 精白 on hover, 苍, 朱). An icon is data like the rows that name it: a
// new building or resource adds its line to IconArt.ts, and a row without one shows the 未绘 glyph
// (`b_none`) until it is drawn.
import { ICONS } from './IconArt.ts';

const SVG = 'http://www.w3.org/2000/svg';

/** An icon as an inline SVG element of a size (CSS px), hidden from screen readers (the control
 * that holds it carries the label); an unknown id draws the 未绘 glyph. */
export function iconSvg( id: string | null, size: number, className = '' ): SVGSVGElement {

	const svg = document.createElementNS( SVG, 'svg' );
	setIcon( svg, id );
	svg.setAttribute( 'width', String( size ) );
	svg.setAttribute( 'height', String( size ) );
	svg.setAttribute( 'aria-hidden', 'true' );
	if ( className ) svg.setAttribute( 'class', className );
	return svg;

}

/** Draw another icon in an icon element (only when it changed). */
export function setIcon( svg: SVGSVGElement, id: string | null ): void {

	const key = id !== null && Object.hasOwn( ICONS, id ) ? id : 'b_none';
	if ( svg.dataset.icon === key ) return;
	svg.dataset.icon = key;
	const [ viewBox, body ] = ICONS[ key ];
	svg.setAttribute( 'viewBox', viewBox );
	// (the bodies are IconArt.ts's own constants)
	svg.innerHTML = body;

}
