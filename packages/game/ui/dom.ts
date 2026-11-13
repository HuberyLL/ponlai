import { level } from './Brush.ts';
import { iconSvg } from './Icons.ts';

// The interface's DOM helpers. Each frame writes only what changed (docs/explanation/ui.md, Rules for the code),
// so the setters below compare first: a steady interface costs a comparison per field and frame.

const SVG = 'http://www.w3.org/2000/svg';

export function el<K extends keyof HTMLElementTagNameMap>( tag: K, className: string, parent?: Element | null, content?: string ): HTMLElementTagNameMap[ K ] {

	const e = document.createElement( tag );
	if ( className ) e.className = className;
	if ( content !== undefined ) e.textContent = content;
	parent?.appendChild( e );
	return e;

}

/** An SVG element with attributes. */
export function svgEl<K extends keyof SVGElementTagNameMap>( tag: K, attrs: Record<string, string | number>, parent?: Element | null ): SVGElementTagNameMap[ K ] {

	const e = document.createElementNS( SVG, tag );
	for ( const name in attrs ) e.setAttribute( name, String( attrs[ name ] ) );
	parent?.appendChild( e );
	return e;

}

/** Set a node's text only when it changed. */
export function text( e: Element, value: string ): void {

	if ( e.textContent !== value ) e.textContent = value;

}

/** Set an attribute only when it changed. */
export function attr( e: Element, name: string, value: string ): void {

	if ( e.getAttribute( name ) !== value ) e.setAttribute( name, value );

}

// the values `css` wrote, by element and property: compared instead of the style's own reading,
// which the browser normalises ('1.000' reads '1', a translate gains spaces), so that a steady
// value is written once and a still interface writes nothing
const written = new WeakMap<Element, Map<string, string>>();

/** Set an inline style property only when it changed (set it through here only). */
export function css( e: HTMLElement | SVGElement, name: string, value: string ): void {

	let values = written.get( e );
	if ( ! values ) written.set( e, values = new Map() );
	if ( values.get( name ) === value ) return;
	values.set( name, value );
	e.style.setProperty( name, value );

}

/** Toggle a class only when it changed. */
export function flag( e: Element, name: string, on: boolean ): void {

	if ( e.classList.contains( name ) !== on ) e.classList.toggle( name, on );

}

// the stroke that rises beneath a hovered button, and lies 金 under a chosen one
const UNDER = level( 2, 38, 3.4, 2.6, 0.6, { entry: 0.15, exit: 0.5 } );

/** The faint stroke beneath a button (hover; 金 when chosen). */
export function under( parent: Element ): SVGSVGElement {

	const svg = svgEl( 'svg', { class: 'pl-under', viewBox: '0 0 40 6', preserveAspectRatio: 'none', 'aria-hidden': 'true' }, parent );
	svgEl( 'path', { d: UNDER, fill: 'currentColor' }, svg );
	return svg;

}

/**
 * An icon button: the icon is the button, its name only for screen readers (docs/explanation/ui.md, Button
 * states). A click from the pointer gives the focus back to the page, so Space stays the game's
 * pause; from the keyboard the focus stays.
 */
export function iconButton( label: string, icon: string | null, size: number, parent: Element | null, onClick: ( e: MouseEvent ) => void, className = '' ): HTMLButtonElement {

	const b = el( 'button', `pl-btn ${ className }`.trim(), parent );
	b.type = 'button';
	b.setAttribute( 'aria-label', label );
	const face = el( 'span', 'pl-face pl-sh', b );
	face.appendChild( iconSvg( icon, size ) );
	under( b );
	b.addEventListener( 'click', ( e ) => {

		onClick( e );
		if ( e.detail > 0 ) b.blur();

	} );
	return b;

}
