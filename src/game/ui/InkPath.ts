import type { Stroke } from './Brush.ts';
import { inkShares } from './Ink.ts';
import { svgEl } from './dom.ts';

// A long brush stroke of the interface drawn with its ink (Ink.ts): in place of a filled SVG path,
// a canvas inside the same SVG (a foreignObject over the stroke's bounds), so the stroke keeps its
// place, its SVG's filter (the mist shadow) and any stretch or mirror of that SVG. The outline is
// filled as the path would be (its colour, opacity or gradient of opacities along x, fill rule),
// then each pixel keeps the share of its ink the ink leaves (Ink.ts `inkShares`).
//
// Rules: it draws only when its stroke, its paint or the interface's scale changed; a stroke that
// only moves (given in its own coordinates and placed `at` a point: the leader to the tag, the ring
// at the feet) moves its canvas and does not draw again. Strokes the same in everything share one
// drawing (the list's washes). A draw is synchronous, so nothing flickers, and costs a few
// milliseconds for a long stroke. The canvas holds device pixels: the interface's scale
// (`setInkUnit`, GameUi: its scale times the device pixel ratio) sets them, and a change of it
// draws every ink path again. Strokes too short for the ink to show (icons, ticks) stay SVG paths.

export interface InkPaint {
	/** a CSS colour, or 'currentColor' (the SVG's colour when it draws) */
	colour: string;
	/** the fill's opacity */
	opacity?: number;
	/** opacities along x (the SVG's units) between x1 and x2, as [ offset 0..1, opacity ] stops */
	gradient?: { x1: number; x2: number; stops: readonly ( readonly [ number, number ] )[] };
	/** the even-odd fill rule (a ring) */
	evenOdd?: boolean;
}

// device pixels per unit of the interface, and the ink paths there are
let unit = 1;
const live = new Set<InkPath>();
// the drawings made last, by what they show (strokes the same in everything draw once), and how
// many are kept
const drawings = new Map<string, { canvas: HTMLCanvasElement; x0: number; y0: number }>();
const KEPT = 24;

/** The interface's device pixels per unit changed: every ink path draws again (one no longer in the
 * page is dropped). */
export function setInkUnit( pixels: number ): void {

	if ( pixels === unit ) return;
	unit = pixels;
	drawings.clear();
	for ( const path of live ) {

		if ( path.element.isConnected ) path.draw();
		else live.delete( path );

	}

}

const XHTML = 'http://www.w3.org/1999/xhtml';

export class InkPath {

	readonly element: SVGForeignObjectElement;
	private readonly canvas: HTMLCanvasElement;
	private readonly seed: number;
	private readonly dry: number;
	private paint: InkPaint;
	private stroke: Stroke | null = null;
	private at = { x: 0, y: 0 };
	// what the canvas shows: the outline, the paint, the seed and the scale it was drawn with; and
	// where its bounds lie in the stroke's coordinates
	private drawn = '';
	private x0 = 0;
	private y0 = 0;

	/** A stroke in `parent` (an SVG), its marks from `seed`, filled with `paint`; `dry`: how dry its
	 * tail runs, as a share of the ink's (Ink.ts InkStroke). */
	constructor( parent: SVGElement, paint: InkPaint, seed: number, dry = 1 ) {

		this.element = svgEl( 'foreignObject', { width: 0, height: 0, 'pointer-events': 'none' }, parent );
		this.canvas = document.createElementNS( XHTML, 'canvas' ) as HTMLCanvasElement;
		this.canvas.style.cssText = 'display: block; width: 100%; height: 100%';
		this.element.appendChild( this.canvas );
		this.paint = paint;
		this.seed = seed;
		this.dry = dry;
		live.add( this );

	}

	/** Show a stroke (null: none), its own coordinates placed at `at` in the SVG's. */
	set( stroke: Stroke | null, at = { x: 0, y: 0 } ): void {

		this.stroke = stroke && stroke.d ? stroke : null;
		if ( at.x !== this.at.x || at.y !== this.at.y ) {

			this.at = { x: at.x, y: at.y };
			this.place();

		}
		this.draw();

	}

	/** Fill with another paint (a need's colour as it runs low). */
	setPaint( paint: InkPaint ): void {

		this.paint = paint;
		this.draw();

	}

	/** Draw the stroke, if anything it shows changed. */
	draw(): void {

		const stroke = this.stroke, paint = this.paint;
		const key = stroke ? `${ unit } ${ this.seed } ${ this.dry } ${ JSON.stringify( paint ) } ${ stroke.d }` : '';
		if ( key === this.drawn ) return;
		this.drawn = key;
		if ( ! stroke ) {

			this.element.setAttribute( 'width', '0' );
			return;

		}
		const canvas = this.canvas, same = drawings.get( key );
		if ( same ) {

			canvas.width = same.canvas.width;
			canvas.height = same.canvas.height;
			canvas.getContext( '2d' )!.drawImage( same.canvas, 0, 0 );
			this.x0 = same.x0;
			this.y0 = same.y0;
			this.place();
			return;

		}
		// the stroke's bounds, a unit and two pixels wider, on the device's pixel grid
		const { points, half } = stroke.frame, reach = Math.max( ...half ) + 1 + 2 / unit;
		let x0 = Infinity, y0 = Infinity, x1 = - Infinity, y1 = - Infinity;
		for ( const p of points ) {

			x0 = Math.min( x0, p.x - reach );
			y0 = Math.min( y0, p.y - reach );
			x1 = Math.max( x1, p.x + reach );
			y1 = Math.max( y1, p.y + reach );

		}
		x0 = this.x0 = Math.floor( x0 * unit ) / unit;
		y0 = this.y0 = Math.floor( y0 * unit ) / unit;
		const W = Math.ceil( ( x1 - x0 ) * unit ), H = Math.ceil( ( y1 - y0 ) * unit );
		canvas.width = W;
		canvas.height = H;
		const ctx = canvas.getContext( '2d', { willReadFrequently: true } )!;
		ctx.setTransform( unit, 0, 0, unit, - x0 * unit, - y0 * unit );
		const outline = new Path2D( stroke.d ), rule = paint.evenOdd ? 'evenodd' : 'nonzero';
		// the outline's coverage, then the ink each pixel keeps, in the canvas's pixels
		ctx.fillStyle = '#fff';
		ctx.fill( outline, rule );
		const frame = { points: points.map( ( p ) => ( { x: ( p.x - x0 ) * unit, y: ( p.y - y0 ) * unit } ) ), half: half.map( ( h ) => h * unit ) };
		const shares = inkShares( ctx.getImageData( 0, 0, W, H ), [ { frame, seed: this.seed, dry: this.dry } ], unit );
		// the outline as the path would fill it, its alpha times the ink's share
		ctx.clearRect( x0, y0, W / unit, H / unit );
		const colour = paint.colour === 'currentColor' ? getComputedStyle( this.element ).color : paint.colour;
		if ( paint.gradient ) {

			const g = ctx.createLinearGradient( paint.gradient.x1, 0, paint.gradient.x2, 0 );
			for ( const [ offset, opacity ] of paint.gradient.stops ) g.addColorStop( offset, rgba( colour, opacity ) );
			ctx.fillStyle = g;

		} else ctx.fillStyle = rgba( colour, paint.opacity ?? 1 );
		ctx.fill( outline, rule );
		const image = ctx.getImageData( 0, 0, W, H ), data = image.data;
		for ( let k = 0; k < W * H; k ++ ) if ( shares[ k ] < 1 ) data[ k * 4 + 3 ] = Math.round( data[ k * 4 + 3 ] * shares[ k ] );
		ctx.putImageData( image, 0, 0 );
		this.place();
		// kept for a stroke the same in everything (a copy: this one's canvas may draw again)
		const copy = document.createElement( 'canvas' );
		copy.width = W;
		copy.height = H;
		copy.getContext( '2d' )!.drawImage( canvas, 0, 0 );
		drawings.set( key, { canvas: copy, x0, y0 } );
		if ( drawings.size > KEPT ) drawings.delete( drawings.keys().next().value! );

	}

	// The canvas over the stroke's bounds, where the stroke is placed.
	private place(): void {

		const e = this.element, canvas = this.canvas;
		if ( ! this.stroke ) return;
		e.setAttribute( 'x', String( this.x0 + this.at.x ) );
		e.setAttribute( 'y', String( this.y0 + this.at.y ) );
		e.setAttribute( 'width', String( canvas.width / unit ) );
		e.setAttribute( 'height', String( canvas.height / unit ) );

	}

	/** Leave the page: it no longer draws. */
	dispose(): void {

		live.delete( this );
		this.element.remove();

	}

}

// A CSS colour (#rrggbb, or rgb() as a computed style gives it) at an opacity.
function rgba( colour: string, opacity: number ): string {

	const c = colour.startsWith( '#' )
		? [ 1, 3, 5 ].map( ( i ) => parseInt( colour.slice( i, i + 2 ), 16 ) )
		: ( colour.match( /[\d.]+/g ) ?? [ '0', '0', '0' ] ).slice( 0, 3 ).map( Number );
	return `rgba(${ c[ 0 ] }, ${ c[ 1 ] }, ${ c[ 2 ] }, ${ opacity })`;

}
