import type { EntityId } from '../sim/types.ts';
import { level, upright } from './Brush.ts';
import { PALETTE } from './Palette.ts';
import { css, el, flag, svgEl, text } from './dom.ts';
import { t } from './i18n/i18n.ts';
import type { People } from './People.ts';
import type { UiShared } from './Shared.ts';

// The speak bar (docs/ui.md, Speaking; the design canvas's SpeakFlow): the player talks to the
// islanders in words. At rest it is 说话 between two brush strokes fading outwards at the bottom
// centre; it unfolds from the middle as characters are typed, holds about 27 characters (MAX_W)
// and then scrolls left, fading out at its left edge. The caret is one brush stroke. With an
// islander selected, their name stands above it; to everyone, nothing does.
//
// Enter sends (Game.speak: the words go into the record and to their listeners) and the bar stays
// open; the line flies off a character at a time and each that leaves makes room for the next:
// - to one islander, from the first character on, one leaves about every 0.08 s (a little longer
//   after punctuation and between words, each gap and curve a little different, from a fixed hash
//   of the line and the character) and travels about 1.3 s along an arc on the listener's left into
//   their head, shrinking and fading; the end follows the head every frame, so the words turn when
//   the islander walks; a character sinking into the head is heard (People.hear), with no effect;
// - to everyone, the line is cut into runs, left to right across the listeners in view, and the
//   runs fly at once; with fewer characters than listeners, the outer listeners take them.
// A line sent while one is still leaving queues behind it; with nobody on screen to hear, the
// characters rise a little and fade where they stand.
//
// Rules: Enter while an input method is composing belongs to the input method. The bar's keys come
// after the build bar's (GameUi routes them); while the build bar is open the bar steps aside and
// keeps an unsent line in its field. The flights run on real time.

const MAX_W = 560, REST_MID = 68, SLOT_LEAVE = 100, SLOT_CLOSE = 350, WAIT = 450, FLY = 1600, ARC = 0.82;
const PUNCTUATION = /[，。！？、；：,.!?;:]/;

interface Flight {
	el: HTMLElement;
	c: string;
	/** where it stands on the bar while it waits (centre x), and its height */
	cx: number;
	y: number;
	/** its slot on the bar (to the next character) and its own width */
	w: number;
	gw: number;
	person: EntityId | null;
	/** the line it belongs to (UiShared.lines) */
	line: number;
	start: number;
	dur: number;
	c1: [ number, number ];
	c2: [ number, number ];
	sway: number;
	turns: number;
	phase: number;
	tilt: number;
	/** where it left from, once it has */
	x?: number;
	hidden?: boolean;
	heard?: boolean;
}

// cubic-bezier( 0.45, 0, 0.25, 1 ), solved for x by a few Newton steps
function ease( x: number ): number {

	const bx = ( t: number ) => 3 * ( 1 - t ) * ( 1 - t ) * t * 0.45 + 3 * ( 1 - t ) * t * t * 0.25 + t * t * t;
	const dx = ( t: number ) => 3 * ( 1 - t ) * ( 1 - t ) * 0.45 + 6 * ( 1 - t ) * t * ( 0.25 - 0.45 ) + 3 * t * t * ( 1 - 0.25 );
	let t = x;
	for ( let k = 0; k < 6; k ++ ) {

		const d = dx( t );
		if ( Math.abs( d ) < 1e-6 ) break;
		t = Math.min( Math.max( t - ( bx( t ) - x ) / d, 0 ), 1 );

	}
	return 3 * ( 1 - t ) * t * t + t * t * t;

}

export class SpeakBar {

	readonly root: HTMLElement;
	readonly field: HTMLInputElement;
	private readonly shared: UiShared;
	private readonly people: People;
	private readonly layer: HTMLElement;
	private readonly who: HTMLElement;
	private readonly row: HTMLElement;
	private readonly mid: HTMLElement;
	private readonly hint: HTMLElement;
	private readonly mirror: HTMLElement;
	private readonly caret: SVGSVGElement;
	private flights: Flight[] = [];
	private composing = false;
	private textW = 0;
	private textX: number | undefined;
	private midW = REST_MID;
	private snap = false;
	private nextFree = 0;
	private sentences = 0;
	private last = 0;

	constructor( parent: Element, flights: HTMLElement, shared: UiShared, people: People ) {

		this.shared = shared;
		this.people = people;
		this.layer = flights;
		const root = this.root = el( 'div', 'pl-speak', parent );
		this.who = el( 'div', 'who', root );
		const row = this.row = el( 'div', 'row', root );
		row.addEventListener( 'click', () => this.field.focus() );
		// the two strokes fade outwards: the left one drawn toward the middle, the right its mirror
		const stroke = ( mirrored: boolean ) => {

			const svg = svgEl( 'svg', { class: 'pl-sh', viewBox: '0 0 260 12', preserveAspectRatio: 'none', 'aria-hidden': 'true' }, row );
			if ( mirrored ) svg.style.transform = 'scaleX(-1)';
			const id = `pl-sf${ mirrored ? 'r' : 'l' }`;
			const g = svgEl( 'linearGradient', { id, x1: 0, y1: 0, x2: 260, y2: 0, gradientUnits: 'userSpaceOnUse' }, svgEl( 'defs', {}, svg ) );
			svgEl( 'stop', { offset: 0, 'stop-color': PALETTE.gao, 'stop-opacity': 0 }, g );
			svgEl( 'stop', { offset: 0.6, 'stop-color': PALETTE.gao, 'stop-opacity': 0.85 }, g );
			svgEl( 'stop', { offset: 1, 'stop-color': PALETTE.gao }, g );
			svgEl( 'path', { d: level( 2, 257, 6.4, 2.4, 0.9, { entry: 0.1, exit: 0.12, start: 0.3, end: 0.35 } ), fill: `url(#${ id })` }, svg );

		};
		stroke( false );
		this.mid = el( 'div', 'mid', row );
		this.hint = el( 'span', 'hint', this.mid, t( 'speak.title' ) );
		stroke( true );
		this.mirror = el( 'div', 'pl-mirror', root );
		this.mirror.setAttribute( 'aria-hidden', 'true' );
		const field = this.field = el( 'input', 'pl-field', root );
		field.setAttribute( 'aria-label', t( 'speak.title' ) );
		field.autocomplete = 'off';
		field.spellcheck = false;
		this.caret = svgEl( 'svg', { class: 'pl-caret', viewBox: '0 0 6 22', 'aria-hidden': 'true' }, root );
		svgEl( 'path', { d: upright( 3, 1, 21, 2.2, 0.5, { exit: 0.5 } ), fill: 'currentColor' }, this.caret );
		field.addEventListener( 'input', this.measure );
		field.addEventListener( 'compositionstart', () => { this.composing = true; } );
		field.addEventListener( 'compositionend', () => {

			this.composing = false;
			this.measure();

		} );
		field.addEventListener( 'keydown', this.onFieldKey );
		for ( const type of [ 'focus', 'blur', 'select', 'keyup', 'pointerup' ] ) field.addEventListener( type, this.blink );

	}

	/** Whether the player is typing into the bar. */
	get typing(): boolean {

		return document.activeElement === this.field;

	}

	/** The build bar is open: the bar steps aside (its unsent line kept), or comes back. */
	set away( on: boolean ) {

		flag( this.root, 'away', on );
		if ( on && this.typing ) this.field.blur();

	}

	focus(): void {

		this.field.focus();

	}

	/** Empty the field and leave it. */
	close(): void {

		this.field.value = '';
		this.measure();
		this.field.blur();

	}

	/** A new simulation: words in flight are dropped. */
	reset(): void {

		for ( const g of this.flights ) g.el.remove();
		this.flights = [];
		this.nextFree = 0;

	}

	update(): void {

		const shared = this.shared, now = shared.now, k = shared.k;
		const w = innerWidth / k, cx = w / 2, wl = cx - MAX_W / 2, wr = cx + MAX_W / 2;
		// (read before this frame's writes: whether the field has scrolled past its cap)
		const scrolled = this.field.value.length > 0 && this.field.scrollLeft > 0;
		const selected = shared.selected !== null ? shared.game.sim.villager( shared.selected ) : undefined;
		text( this.who, selected?.name ?? '' );
		flag( this.who, 'shown', selected !== undefined );
		// the bar laid out afresh every frame: the characters still waiting, then the field, together
		// centred and at most MAX_W wide; every character and the field glide to their places, so the
		// line closes up as soon as a character has left
		const dt = Math.min( 0.05, ( now - ( this.last || now ) ) / 1000 );
		this.last = now;
		const kf = 1 - Math.exp( - dt / 0.04 );
		// a slot narrows smoothly once its character has set off, so the line closes up behind it
		const slot = ( g: Flight ) => {

			const t = ( now - g.start - SLOT_LEAVE ) / SLOT_CLOSE;
			return t <= 0 ? g.w : t >= 1 ? 0 : g.w * ( 1 - t * t * ( 3 - 2 * t ) );

		};
		const waiting = this.flights.filter( ( g ) => now < g.start + WAIT );
		const c = waiting.reduce( ( a, g ) => a + slot( g ), 0 ) + this.textW;
		let lx = c <= MAX_W ? cx - c / 2 : wr - c;
		for ( const g of waiting ) {

			g.cx += ( lx + g.gw / 2 - g.cx ) * kf;
			lx += slot( g );

		}
		// right after sending the caret jumps to the end of the line instead of sliding across it
		this.textX = this.snap || this.textX === undefined ? lx : this.textX + ( lx - this.textX ) * kf;
		this.snap = false;
		const open = this.typing || this.field.value.length > 0 || waiting.length > 0;
		flag( this.row, 'open', open );
		css( this.hint, 'opacity', open ? '0' : '1' );
		css( this.field, 'opacity', open ? '1' : '0' );
		this.midW += ( ( open ? Math.min( c, MAX_W ) + 48 : REST_MID ) - this.midW ) * kf;
		css( this.mid, 'width', `${ this.midW.toFixed( 1 ) }px` );
		// the field runs ahead of its text, so it scrolls only past the cap, fading at its left edge then
		const fl = Math.max( wl, this.textX );
		css( this.field, 'left', `${ fl.toFixed( 1 ) }px` );
		css( this.field, 'width', `${ Math.max( 24, Math.min( this.textW + 160, wr + 2 - fl ) ).toFixed( 1 ) }px` );
		const fade = scrolled ? 'linear-gradient(90deg, transparent 0, #000 28px)' : 'none';
		css( this.field, 'mask-image', fade );
		css( this.field, '-webkit-mask-image', fade );
		css( this.mirror, 'left', `${ fl.toFixed( 1 ) }px` );
		this.placeCaret( fl );
		this.fly( now, wl );

	}

	// The caret: a brush stroke after the character before the selection.
	private placeCaret( fl: number ): void {

		const show = this.typing && this.field.selectionStart === this.field.selectionEnd;
		css( this.caret, 'display', show ? '' : 'none' );
		if ( ! show ) return;
		const at = this.field.selectionStart ?? 0, spans = this.mirror.children;
		const k = this.shared.k, left = this.mirror.getBoundingClientRect().left / k;
		const x = at === 0 || spans.length === 0 ? fl : spans[ Math.min( at, spans.length ) - 1 ].getBoundingClientRect().right / k - left + fl;
		css( this.caret, 'left', `${ ( x - this.field.scrollLeft - 2 ).toFixed( 1 ) }px` );

	}

	// Restart the caret's blink, so it shows at once after a key or a click.
	private readonly blink = (): void => {

		this.caret.classList.remove( 'blink' );
		void this.caret.getBoundingClientRect();
		this.caret.classList.add( 'blink' );

	};

	// The field's text width, measured on its mirror, a span per character (pinyin included while composing).
	private readonly measure = (): void => {

		const chars = Array.from( this.field.value );
		this.mirror.textContent = '';
		for ( const c of chars ) el( 'span', '', this.mirror, c );
		this.textW = chars.length > 0 ? this.mirror.getBoundingClientRect().width / this.shared.k : 0;
		this.blink();

	};

	private readonly onFieldKey = ( e: KeyboardEvent ): void => {

		// Enter while picking a word in the input method belongs to the input method
		if ( this.composing || e.isComposing || e.keyCode === 229 ) return;
		if ( e.key === 'Enter' ) {

			e.preventDefault();
			this.send();

		} else if ( e.key === 'Escape' ) {

			e.preventDefault();
			this.close();

		}

	};

	// Enter: the line goes to its listeners and flies; the field stays open for the next.
	private send(): void {

		const words = this.field.value;
		if ( ! words.trim() ) {

			this.close();
			return;

		}
		const shared = this.shared, k = shared.k, now = shared.now;
		const fieldBox = this.field.getBoundingClientRect();
		const y = ( fieldBox.top + fieldBox.height / 2 ) / k, scroll = this.field.scrollLeft;
		// every character on its own, from where it stands in the field (out of sight past the left
		// edge, if the field has scrolled); each keeps a slot reaching to the next, so spaces keep their gaps
		const pts = Array.from( this.mirror.children ).filter( ( s ) => ( s.textContent ?? '' ).trim() ).map( ( s ) => {

			const r = s.getBoundingClientRect();
			return { c: s.textContent ?? '', l: r.left / k - scroll, gw: r.width / k, w: 0, x: 0 };

		} );
		pts.forEach( ( p, i ) => {

			p.w = i + 1 < pts.length ? pts[ i + 1 ].l - p.l : p.gw;
			p.x = p.l + p.gw / 2;

		} );
		const n = pts.length;
		const to = shared.selected, line = ++ shared.lines;
		shared.game.speak( words, to !== null ? [ to ] : 'all' );
		// to the one selected, or cut into runs across everyone in view, left to right as they stand now
		const listeners = to !== null ? ( this.people.head( to ) ? [ to ] : [] ) : this.people.inView();
		const runs = Math.max( 1, Math.min( listeners.length, n ) );
		const runOf = ( i: number ) => Math.floor( i * runs / n );
		const firstOf = ( r: number ) => Math.ceil( r * n / runs );
		const sent = ++ this.sentences;
		const rnd = ( i: number, j: number ) => {

			const v = Math.sin( ( sent * 977 + i * 131 + j * 17.3 ) * 12.9898 ) * 43758.5453;
			return 2 * ( v - Math.floor( v ) ) - 1;

		};
		const start = Math.max( now, this.nextFree );
		// the gaps breathe like speech: a little uneven, longer after punctuation and between words
		const gapAfter = ( i: number ) => {

			const spaced = i + 1 < n && pts[ i + 1 ].l - ( pts[ i ].l + pts[ i ].gw ) > 3;
			return 80 * ( 1 + 0.3 * rnd( i, 0 ) ) + ( PUNCTUATION.test( pts[ i ].c ) ? 150 : spaced ? 60 : 0 );

		};
		const offs: number[] = [], arrive: number[] = [];
		let longest = 0;
		for ( let i = 0; i < n; i ++ ) {

			const p = pts[ i ], r = runOf( i );
			offs[ i ] = i === firstOf( r ) ? 0 : offs[ i - 1 ] + gapAfter( i - 1 );
			let dur = FLY * ( 1 + 0.1 * rnd( i, 1 ) );
			// never overtake the character before in the same run
			if ( i > firstOf( r ) ) dur = Math.max( dur, ( arrive[ i - 1 ] + 40 - offs[ i ] ) / ARC );
			arrive[ i ] = offs[ i ] + dur * ARC;
			longest = Math.max( longest, offs[ i ] + gapAfter( i ) );
			// fewer characters than listeners: they go to listeners spread across the group
			const person = listeners.length === 0 ? null : listeners[ runs === listeners.length ? r : Math.round( r * ( listeners.length - 1 ) / Math.max( 1, runs - 1 ) ) ];
			const e = el( 'div', 'pl-fly', this.layer, p.c );
			e.setAttribute( 'aria-hidden', 'true' );
			this.flights.push( { el: e, c: p.c, cx: p.x, y, w: p.w, gw: p.gw, person, line, start: start + offs[ i ], dur,
				c1: [ 110 * rnd( i, 2 ), 70 * rnd( i, 3 ) ], c2: [ 80 * rnd( i, 4 ), 60 * rnd( i, 5 ) ],
				sway: 10 + 8 * Math.abs( rnd( i, 6 ) ), turns: 1.2 + 0.6 * rnd( i, 7 ), phase: Math.PI * rnd( i, 8 ), tilt: 10 * rnd( i, 9 ) } );

		}
		this.nextFree = start + longest;
		this.snap = true;
		this.field.value = '';
		this.measure();

	}

	// Every character in the air follows the head it is going to, wherever it is now.
	private fly( now: number, wl: number ): void {

		for ( let j = this.flights.length - 1; j >= 0; j -- ) {

			const g = this.flights[ j ], e = g.el;
			if ( now < g.start ) {

				// still on the bar, fading out towards the left edge like the field's text
				css( e, 'transform', `translate(${ g.cx.toFixed( 1 ) }px,${ g.y.toFixed( 1 ) }px) translate(-50%,-50%)` );
				css( e, 'opacity', Math.max( 0, Math.min( 1, ( g.cx - wl ) / 28 ) ).toFixed( 3 ) );
				continue;

			}
			// leaving: from where it stands now; one out of sight leaves from the left edge
			if ( g.x === undefined ) {

				g.hidden = g.cx - wl < 10;
				g.x = Math.max( wl, g.cx );

			}
			const u = Math.min( Math.max( ( now - g.start ) / g.dur, 0 ), 1 );
			const head = g.person !== null ? this.people.head( g.person ) : null;
			if ( u >= 1 || ( ! head && u > 0.35 ) ) {

				if ( head && ! g.heard ) this.people.hear( g.person!, g.c, g.line );
				e.remove();
				this.flights.splice( j, 1 );
				continue;

			}
			if ( ! head ) {

				// nobody on screen to hear it: it rises a little and fades where it stands
				const t = u / 0.35;
				css( e, 'transform', `translate(${ g.x.toFixed( 1 ) }px,${ ( g.y - 30 * t ).toFixed( 1 ) }px) translate(-50%,-50%)` );
				css( e, 'opacity', ( 1 - t ).toFixed( 3 ) );
				continue;

			}
			const hx = head.x + head.size * 0.03, hy = head.y + head.size * 0.12;
			// along the arc over the first 82 % of the time, eased; then sinking into the head
			const a = u < ARC ? ease( u / ARC ) : 1;
			const b = u < ARC ? 0 : ease( ( u - ARC ) / ( 1 - ARC ) );
			if ( u >= ARC && ! g.heard ) {

				g.heard = true;
				this.people.hear( g.person!, g.c, g.line );

			}
			const p0 = [ g.x, g.y ], p1 = [ g.x + ( hx - g.x ) * 0.1 - 210 + g.c1[ 0 ], g.y - 120 + g.c1[ 1 ] ], p2 = [ hx - 160 + g.c2[ 0 ], hy + 120 + g.c2[ 1 ] ], p3 = [ hx, hy ];
			const v = 1 - a;
			const x = v * v * v * p0[ 0 ] + 3 * v * v * a * p1[ 0 ] + 3 * v * a * a * p2[ 0 ] + a * a * a * p3[ 0 ];
			const yy = v * v * v * p0[ 1 ] + 3 * v * v * a * p1[ 1 ] + 3 * v * a * a * p2[ 1 ] + a * a * a * p3[ 1 ];
			// drifting: a sway across the path and a slight tilt, swelling in mid-flight, gone at either end
			const tx = 3 * v * v * ( p1[ 0 ] - p0[ 0 ] ) + 6 * v * a * ( p2[ 0 ] - p1[ 0 ] ) + 3 * a * a * ( p3[ 0 ] - p2[ 0 ] );
			const ty = 3 * v * v * ( p1[ 1 ] - p0[ 1 ] ) + 6 * v * a * ( p2[ 1 ] - p1[ 1 ] ) + 3 * a * a * ( p3[ 1 ] - p2[ 1 ] );
			const tl = Math.hypot( tx, ty ) || 1, d = g.sway * Math.sin( 2 * Math.PI * g.turns * a + g.phase ) * Math.sin( Math.PI * a );
			const sx = - ty / tl * d, sy = tx / tl * d;
			const tilt = g.tilt * Math.sin( Math.PI * a );
			const scale = u < ARC ? 1 - 0.5 * a : 0.5 - 0.15 * b;
			const opacity = u < 0.1 ? 1 : u < ARC ? 1 - 0.4 * ease( ( u - 0.1 ) / ( ARC - 0.1 ) ) : 0.6 * ( 1 - b );
			css( e, 'transform', `translate(${ ( x + sx ).toFixed( 1 ) }px,${ ( yy + sy ).toFixed( 1 ) }px) translate(-50%,-50%) rotate(${ tilt.toFixed( 1 ) }deg) scale(${ scale.toFixed( 3 ) })` );
			// one from out of sight shows only once it has left the edge
			const shown = g.hidden ? Math.min( 1, Math.max( 0, ( now - g.start ) / 150 ) ) : 1;
			css( e, 'opacity', ( opacity * shown ).toFixed( 3 ) );

		}

	}

}
