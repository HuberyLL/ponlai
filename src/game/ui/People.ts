import * as THREE from 'three/webgpu';
import { FIGURE_HEIGHT } from '../../characters/Villagers.ts';
import { CLICK_SLOP } from '../../camera/IslandCameraControls.ts';
import { BAG_CAPACITY, total } from '../sim/items.ts';
import { CRITICAL_NEED, LOW_NEED } from '../sim/needs.ts';
import type { EntityId, Needs, Villager } from '../sim/types.ts';
import { along, cubic, level, ring } from './Brush.ts';
import { iconSvg, setIcon } from './Icons.ts';
import { PALETTE, mix } from './Palette.ts';
import { doingWords, itemName } from './data/words.ts';
import { attr, css, el, flag, svgEl, text, under } from './dom.ts';
import type { UiShared } from './Shared.ts';

// The islanders' marks over the scene (docs/ui.md, Islanders: selection and alerts; Speaking):
//
// - Selected (a click on an islander, again or on open ground to let go): a ring at the feet, thick
//   in front and thin behind, with one 金 stroke beneath its front, and the tag beside them (人旁
//   浮签), joined to the shoulder by a short brush leader: the name in calligraphy, what they are
//   doing (缟, faint), satiety and hydration as thin bars with their numbers (琥珀 and 天水碧, each
//   blending to 朱 from LOW_NEED down to CRITICAL_NEED, where the icon and number turn 朱 too), and
//   the bag as slots (a kind and its count, then a faint ring for each free place; a click marks
//   one with a 金 stroke, which does nothing more yet).
// - An unselected islander with a critical need: its icon in 朱 over the head, no ring, no backing;
//   both side by side, satiety on the left.
// - Thinking (a thought in flight, Sim.thinking, after hearing the player): the characters heard
//   circle above the head, at most six at a time, the whole line taking turns as each passes behind
//   the head; words heard meanwhile wait for the next thought.
// - Speaking (Villager.said changed): the characters pop out above the head one at a time, sized by
//   the figure's size on screen; the line holds 2.5 s and 0.3 s a character, then melts away one by
//   one. A line still showing melts first.
//
// Everything is placed each frame from the islanders as drawn (Game.anchor: their feet) through the
// camera, in the interface's units; over the head from the bottom up, always in the same places:
// the thinking ring, the alerts, the words. The ring and the leader are paths of one SVG layer.
//
// Rules: it reads the simulation and the drawn figures, and changes nothing but the selection (and
// the shadow's focus, which follows it: Game.focus). It is DOM over the canvas: a paused frame's
// pixels never change for it. Its own motion (words, the thinking ring) runs on real time, as a
// mind's does; nothing of it shows on a page loaded paused with nobody selected.

const RING_RADIUS = 0.42, RING_POINTS = 40;
// the tag's place from the head's top (interface px): its lower left corner, the leader's ends
const TAG = { x: 62, y: - 46 }, LEADER = { x0: 9, y0: 10, x1: 56, y1: - 40 };
const THINK_SLOTS = 6, THINK_ROUND = 4800;
const POP_EVERY = 70, HOLD = 2500, HOLD_PER_CHAR = 300, MELT = 700;

const _p = new THREE.Vector3(), _q = new THREE.Vector3();

interface Talk { chars: HTMLSpanElement[]; start: number; until: number; gone: number; out: boolean }

interface Mark {
	id: EntityId;
	root: HTMLElement;
	alerts: HTMLElement;
	alertIcons: SVGSVGElement[];
	think: HTMLElement;
	thinkChars: HTMLSpanElement[];
	talkBox: HTMLElement;
	talk: Talk | null;
	/** the line last shown (Villager.said: each line said is a new object, whatever the tick) */
	said: Villager[ 'said' ];
	/** characters heard (landed from the speak bar), each with the line it came in */
	heard: { c: string; line: number }[];
	/** the thought in flight: the last line said before it began (it thinks over the lines up to
	 * that one; later ones wait for the next thought), and when it began */
	thought: { upTo: number; t0: number } | null;
	/** this frame: on screen, the head's top and the figure's height (interface px) */
	shown: boolean;
	x: number;
	y: number;
	size: number;
	seen: number;
}

/** Where an islander's head is on screen this frame, for the words flying to it. */
export interface HeadPoint { x: number; y: number; size: number }

export class People {

	readonly root: HTMLElement;
	private readonly shared: UiShared;
	private readonly camera: THREE.PerspectiveCamera;
	private readonly marks = new Map<EntityId, Mark>();
	private readonly svg: SVGSVGElement;
	private readonly ringPath: SVGPathElement;
	private readonly goldPath: SVGPathElement;
	private readonly leaderPath: SVGPathElement;
	private readonly tag: Tag;
	private frame = 0;
	private down: { x: number; y: number } | null = null;
	/** whether a click on the scene may select (not while a building is being placed) */
	selectable = (): boolean => true;

	constructor( parent: Element, shared: UiShared, camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement ) {

		this.shared = shared;
		this.camera = camera;
		this.root = el( 'div', 'pl-people', parent );
		this.svg = svgEl( 'svg', { class: 'marks pl-sh', width: 1, height: 1, 'aria-hidden': 'true' }, this.root );
		this.ringPath = svgEl( 'path', { fill: PALETTE.gao, 'fill-rule': 'evenodd' }, this.svg );
		this.goldPath = svgEl( 'path', { fill: PALETTE.jin }, this.svg );
		this.leaderPath = svgEl( 'path', { fill: PALETTE.gao }, this.svg );
		this.tag = new Tag( this.root, shared );
		canvas.addEventListener( 'pointerdown', this.onDown );
		canvas.addEventListener( 'pointerup', this.onUp );

	}

	/** A new simulation (start, load): every mark starts over, nobody selected. */
	reset(): void {

		for ( const m of this.marks.values() ) m.root.remove();
		this.marks.clear();
		this.select( null );

	}

	/** Select an islander (null: nobody); the figures' shadow follows. */
	select( id: EntityId | null ): void {

		if ( this.shared.selected === id ) return;
		this.shared.selected = id;
		this.shared.game.focus( id );

	}

	/** Where an islander's head is this frame, or null when off screen. */
	head( id: EntityId ): HeadPoint | null {

		const m = this.marks.get( id );
		return m && m.shown ? { x: m.x, y: m.y, size: m.size } : null;

	}

	/** The islanders on screen now, left to right (the listeners of words to everyone). */
	inView(): EntityId[] {

		return [ ...this.marks.values() ].filter( ( m ) => m.shown ).sort( ( a, b ) => a.x - b.x ).map( ( m ) => m.id );

	}

	/** A character of the player's `line` (UiShared.lines) has sunk into an islander's head: it is heard. */
	hear( id: EntityId, c: string, line: number ): void {

		const m = this.marks.get( id );
		if ( m && ! /[，。！？、；：,.!?;:\s]/.test( c ) ) m.heard.push( { c, line } );

	}

	update(): void {

		const shared = this.shared, sim = shared.game.sim, frame = ++ this.frame;
		this.camera.updateMatrixWorld();
		// the interface's size in its own pixels (the window's, over its scale)
		const w = innerWidth / shared.k, h = innerHeight / shared.k;
		attr( this.svg, 'width', String( w ) );
		attr( this.svg, 'height', String( h ) );
		attr( this.svg, 'viewBox', `0 0 ${ w } ${ h }` );
		let ringD = '', goldD = '', leaderD = '';
		for ( const v of sim.state.villagers ) {

			let m = this.marks.get( v.id );
			if ( ! m ) this.marks.set( v.id, m = this.mark( v ) );
			m.seen = frame;
			this.place( m, w, h );
			const selected = shared.selected === v.id;
			flag( m.root, 'hidden', ! m.shown );
			if ( m.shown ) css( m.root, 'transform', `translate(${ m.x.toFixed( 1 ) }px,${ m.y.toFixed( 1 ) }px)` );
			this.alerts( m, v.needs, selected );
			this.thinking( m, sim.thinking( v.id ) );
			this.talking( m, v );
			if ( selected && m.shown ) {

				const r = this.ring( v.id, w, h );
				ringD = r.ring;
				goldD = r.gold;
				leaderD = along( cubic( { x: m.x + LEADER.x0, y: m.y + LEADER.y0 }, { x: m.x + LEADER.x0 + 12, y: m.y + LEADER.y0 - 18 }, { x: m.x + LEADER.x1 - 18, y: m.y + LEADER.y1 + 14 }, { x: m.x + LEADER.x1, y: m.y + LEADER.y1 }, 16 ), 2.6, { entry: 0.3, exit: 0.5, start: 0.5, end: 0.15 } );

			}

		}
		for ( const [ id, m ] of this.marks ) {

			if ( m.seen === frame ) continue;
			m.root.remove();
			this.marks.delete( id );
			if ( shared.selected === id ) this.select( null );

		}
		attr( this.ringPath, 'd', ringD );
		attr( this.goldPath, 'd', goldD );
		attr( this.leaderPath, 'd', leaderD );
		const selected = shared.selected !== null ? this.marks.get( shared.selected ) : undefined;
		const v = selected && sim.villager( selected.id );
		this.tag.update( v && selected.shown ? v : null, selected ? selected.x + TAG.x : 0, selected ? selected.y + TAG.y : 0, w, h );

	}

	private mark( v: Villager ): Mark {

		const root = el( 'div', 'pl-person', this.root );
		const alerts = el( 'div', 'pl-alerts pl-sh', root );
		const alertIcons = [ iconSvg( 'satiety', 20 ), iconSvg( 'drop', 20 ) ];
		for ( const icon of alertIcons ) alerts.appendChild( icon );
		const think = el( 'div', 'pl-think', root );
		const thinkChars: HTMLSpanElement[] = [];
		for ( let i = 0; i < THINK_SLOTS; i ++ ) thinkChars.push( el( 'span', '', think ) );
		const talkBox = el( 'div', 'pl-talk', root );
		return { id: v.id, root, alerts, alertIcons, think, thinkChars, talkBox, talk: null, said: v.said, heard: [], thought: null,
			shown: false, x: 0, y: 0, size: 0, seen: 0 };

	}

	// The islander's head on screen (interface px) and its height there, from its drawn feet.
	private place( m: Mark, w: number, h: number ): void {

		m.shown = false;
		if ( ! this.shared.game.anchor( m.id, _p ) ) return;
		_q.copy( _p );
		_q.y += FIGURE_HEIGHT;
		_p.project( this.camera );
		_q.project( this.camera );
		if ( _q.z > 1 || _q.z < - 1 ) return;
		m.x = ( _q.x + 1 ) / 2 * w;
		m.y = ( 1 - _q.y ) / 2 * h;
		m.size = Math.abs( _p.y - _q.y ) / 2 * h;
		m.shown = m.x > - 100 && m.x < w + 100 && m.y > - 100 && m.y < h + 100;

	}

	// The ring at the feet (thick in front, thin behind) and its 金 stroke, as paths.
	private ring( id: EntityId, w: number, h: number ): { ring: string; gold: string } {

		const sim = this.shared.game.sim;
		if ( ! this.shared.game.anchor( id, _p ) ) return { ring: '', gold: '' };
		const cx = _p.x, cz = _p.z, pts: { x: number; y: number }[] = [];
		for ( let i = 0; i < RING_POINTS; i ++ ) {

			const a = i / RING_POINTS * Math.PI * 2, x = cx + Math.cos( a ) * RING_RADIUS, z = cz + Math.sin( a ) * RING_RADIUS;
			_q.set( x, sim.grid.height( x, z ) + 0.03, z ).project( this.camera );
			pts.push( { x: ( _q.x + 1 ) / 2 * w, y: ( 1 - _q.y ) / 2 * h } );

		}
		let top = Infinity, bottom = - Infinity, left = Infinity, right = - Infinity;
		for ( const p of pts ) {

			top = Math.min( top, p.y );
			bottom = Math.max( bottom, p.y );
			left = Math.min( left, p.x );
			right = Math.max( right, p.x );

		}
		// the nearer side (lower on screen) carries the weight
		const front = ( p: { y: number } ) => ( p.y - top ) / Math.max( bottom - top, 1e-3 );
		const scale = Math.min( Math.max( ( right - left ) / 56, 0.5 ), 1.6 );
		const widths = pts.map( ( p ) => ( 0.7 + 2.6 * front( p ) ** 1.5 ) * scale );
		const mid = ( left + right ) / 2, span = ( right - left ) * 0.32;
		return { ring: ring( pts, widths ), gold: level( mid - span, mid + span, bottom + 4 * scale, 2.2 * scale, - 1.5 * scale, { entry: 0.2, exit: 0.45 } ) };

	}

	private alerts( m: Mark, needs: Needs, selected: boolean ): void {

		const hungry = needs.satiety <= CRITICAL_NEED, thirsty = needs.hydration <= CRITICAL_NEED;
		css( m.alertIcons[ 0 ], 'display', hungry ? '' : 'none' );
		css( m.alertIcons[ 1 ], 'display', thirsty ? '' : 'none' );
		css( m.alerts, 'opacity', ! selected && ( hungry || thirsty ) ? '1' : '0' );
		// over the thinking ring's room
		css( m.alerts, 'bottom', `${ ( this.ringRoom( m ) + 4 ).toFixed( 1 ) }px` );

	}

	// the height kept over the head for the thinking ring (interface px)
	private ringRoom( m: Mark ): number {

		return Math.max( 9, this.wordSize( m ) * 0.58 ) * 2.2 + 8;

	}

	// the size of the words over the head, from the figure's size on screen (about 0.4 of it)
	private wordSize( m: Mark ): number {

		return Math.min( Math.max( 0.4 * m.size, 13 ), 24 );

	}

	// The thinking ring: while a thought is in flight, the characters of the lines heard before it
	// began, as they land; a thought's end lets them go, and lines heard meanwhile wait for the next.
	private thinking( m: Mark, inFlight: boolean ): void {

		const now = this.shared.now;
		if ( inFlight && ! m.thought ) m.thought = { upTo: this.shared.lines, t0: now };
		if ( ! inFlight && m.thought ) {

			const upTo = m.thought.upTo;
			m.heard = m.heard.filter( ( h ) => h.line > upTo );
			m.thought = null;

		}
		const upTo = m.thought?.upTo ?? - 1;
		const chars = m.thought ? m.heard.filter( ( h ) => h.line <= upTo ).map( ( h ) => h.c ) : [];
		const th = m.thought && chars.length > 0 ? { chars, t0: m.thought.t0 } : null;
		css( m.think, 'opacity', th ? '1' : '0' );
		if ( ! th ) return;
		const gp = Math.max( 9, this.wordSize( m ) * 0.58 ), nr = Math.min( THINK_SLOTS, th.chars.length );
		const rx = Math.min( Math.max( gp * 1.6 + 10, nr * gp * 0.62 ), THINK_SLOTS * gp * 0.62 ), ry = rx * 0.18 + 1;
		for ( let k = 0; k < THINK_SLOTS; k ++ ) {

			const span = m.thinkChars[ k ];
			if ( k >= nr ) {

				css( span, 'opacity', '0' );
				continue;

			}
			// place k is k / nr ahead on the ring; with more words than places, a place changes word
			// as it passes behind the head, so the words come round the front in the order heard
			const u = ( ( now - th.t0 ) / THINK_ROUND + k / nr ) % 1;
			const count = th.chars.length, turn = Math.floor( ( now - th.t0 ) / THINK_ROUND + k / nr + 0.25 );
			const at = count <= nr ? k : turn * nr - k + Math.ceil( nr / 2 ) - 1;
			text( span, th.chars[ ( ( at % count ) + count ) % count ] );
			// round from the right, across the front to the left, and back behind
			const a = u * Math.PI * 2, x = rx * Math.cos( a ), y = ry * Math.sin( a ) - gp * 0.6 - 6;
			const frontness = Math.sin( a );
			const opacity = frontness >= 0 ? 0.35 + 0.45 * frontness : Math.max( 0, 0.35 + 0.6 * frontness ) * ( 1 - smoothBack( u ) );
			const scale = 1 + 0.12 * Math.max( frontness, 0 ) - 0.13 * Math.max( - frontness, 0 );
			css( span, 'font-size', `${ gp.toFixed( 1 ) }px` );
			css( span, 'opacity', opacity.toFixed( 3 ) );
			css( span, 'transform', `translate(${ x.toFixed( 1 ) }px,${ y.toFixed( 1 ) }px) translate(-50%,-50%) scale(${ scale.toFixed( 3 ) })` );

		}

	}

	// Speech over the head: a new line pops out a character at a time, holds, then melts.
	private talking( m: Mark, v: Villager ): void {

		const now = this.shared.now;
		if ( v.said !== m.said && v.said ) {

			m.said = v.said;
			const lead = m.talk && ! m.talk.out ? MELT : 0;
			if ( m.talk && ! m.talk.out ) this.melt( m.talk );
			const old = m.talk;
			const chars = Array.from( v.said.words );
			const start = now + lead;
			const talk: Talk = { chars: [], start, until: start + ( chars.length - 1 ) * POP_EVERY + HOLD + HOLD_PER_CHAR * chars.length, gone: 0, out: false };
			const size = this.wordSize( m );
			const build = () => {

				old?.chars.forEach( ( s ) => s.remove() );
				talk.chars = chars.map( ( c, q ) => {

					const s = el( 'span', 'wait', m.talkBox, c );
					s.style.setProperty( '--dx', `${ ( ( ( chars.length - 1 ) / 2 - q ) * size * 1.04 ).toFixed( 0 ) }px` );
					s.style.setProperty( '--dy', `${ ( size * 1.6 ).toFixed( 0 ) }px` );
					return s;

				} );

			};
			if ( lead === 0 ) build();
			else window.setTimeout( build, lead );
			m.talk = talk;

		}
		const talk = m.talk;
		css( m.talkBox, 'font-size', `${ this.wordSize( m ).toFixed( 1 ) }px` );
		css( m.talkBox, 'bottom', `${ ( this.ringRoom( m ) + ( m.alerts.style.opacity === '1' ? 30 : 6 ) ).toFixed( 1 ) }px` );
		if ( ! talk || talk.chars.length === 0 ) return;
		const shown = Math.floor( ( now - talk.start ) / POP_EVERY ) + 1;
		if ( ! talk.out ) talk.chars.forEach( ( s, q ) => {

			if ( q < shown && s.className === 'wait' ) s.className = 'pop';

		} );
		if ( ! talk.out && now >= talk.until ) this.melt( talk );
		if ( talk.out && now >= talk.gone ) {

			talk.chars.forEach( ( s ) => s.remove() );
			if ( m.talk === talk ) m.talk = null;

		}

	}

	private melt( talk: Talk ): void {

		talk.out = true;
		talk.gone = this.shared.now + MELT + 40 * talk.chars.length;
		talk.chars.forEach( ( s, q ) => {

			s.style.animationDelay = `${ ( q * 0.04 ).toFixed( 2 ) }s`;
			s.className = 'gone';

		} );

	}

	// A click on the scene (not a drag of the camera): the islander under it, or nobody.
	private readonly onDown = ( e: PointerEvent ): void => {

		this.down = e.button === 0 && ! e.altKey && ! e.ctrlKey ? { x: e.clientX, y: e.clientY } : null;

	};

	private readonly onUp = ( e: PointerEvent ): void => {

		const down = this.down;
		this.down = null;
		if ( ! down || e.button !== 0 || Math.hypot( e.clientX - down.x, e.clientY - down.y ) >= CLICK_SLOP || ! this.selectable() ) return;
		const k = this.shared.k, x = e.clientX / k, y = e.clientY / k;
		let best: Mark | null = null, bestD = Infinity;
		for ( const m of this.marks.values() ) {

			if ( ! m.shown ) continue;
			// within the figure: from the head's top to the feet, a third of its height either side
			const half = Math.max( m.size / 3, 10 );
			const dy = y < m.y ? m.y - y : y > m.y + m.size ? y - m.y - m.size : 0;
			const d = Math.hypot( Math.max( Math.abs( x - m.x ) - half, 0 ), dy );
			if ( d < 12 && d < bestD ) {

				bestD = d;
				best = m;

			}

		}
		this.select( best && best.id !== this.shared.selected ? best.id : null );

	};

}

// the back half of the ring's round, hidden behind the head around three quarters of it
function smoothBack( u: number ): number {

	const d = Math.abs( u - 0.75 );
	return d < 0.03 ? 1 : d > 0.07 ? 0 : 1 - ( d - 0.03 ) / 0.04;

}

/** The tag beside the selected islander. */
class Tag {

	private readonly shared: UiShared;
	private readonly root: HTMLElement;
	private readonly name: HTMLElement;
	private readonly doing: HTMLElement;
	private readonly needs: { key: keyof Needs; colour: string; icon: SVGSVGElement; fill: SVGPathElement; num: HTMLElement; shown: number }[] = [];
	private readonly bag: HTMLElement;
	private readonly slots: { box: HTMLButtonElement; icon: SVGSVGElement; count: HTMLElement }[] = [];
	private chosenSlot = - 1;
	private who: EntityId | null = null;
	// the tag's size, measured again only when what it shows changed
	private size = { key: '', w: 0, h: 0 };

	constructor( parent: Element, shared: UiShared ) {

		this.shared = shared;
		const root = this.root = el( 'section', 'pl-tag', parent );
		root.style.opacity = '0';
		const head = el( 'div', 'head', root );
		this.name = el( 'div', 'name pl-title pl-xb', head );
		this.doing = el( 'div', 'doing pl-mist', head );
		const track = level( 1, 129, 4, 2.6, 0.4, { entry: 0.06, exit: 0.2, start: 0.4, end: 0.3, swell: 0 } );
		for ( const [ key, icon, colour, label ] of [ [ 'satiety', 'satiety', PALETTE.hupo, '饱食' ], [ 'hydration', 'drop', PALETTE.tianshuibi, '水分' ] ] as const ) {

			const row = el( 'div', 'need', root );
			const svg = row.appendChild( iconSvg( icon, 18, 'pl-sh' ) );
			svg.setAttribute( 'role', 'img' );
			svg.setAttribute( 'aria-label', label );
			svg.removeAttribute( 'aria-hidden' );
			const bar = svgEl( 'svg', { class: 'pl-sh', width: 130, height: 8, viewBox: '0 0 130 8', 'aria-hidden': 'true' }, row );
			svgEl( 'path', { d: track, fill: PALETTE.gao, 'fill-opacity': 0.2 }, bar );
			const fill = svgEl( 'path', { fill: colour }, bar );
			this.needs.push( { key, colour, icon: svg, fill, num: el( 'span', 'pl-num pl-mist', row ), shown: - 1 } );

		}
		this.bag = el( 'div', 'bag', root );
		this.bag.setAttribute( 'aria-label', '行囊' );
		for ( let i = 0; i < BAG_CAPACITY; i ++ ) {

			const box = el( 'button', 'pl-btn pl-slot', this.bag );
			box.type = 'button';
			const icon = box.appendChild( iconSvg( 'slot', 26, 'pl-sh' ) );
			const count = el( 'span', 'count pl-num pl-mist', box );
			under( box );
			box.addEventListener( 'click', ( e ) => {

				this.chosenSlot = this.chosenSlot === i ? - 1 : i;
				if ( e.detail > 0 ) box.blur();

			} );
			this.slots.push( { box, icon, count } );

		}

	}

	/** Show an islander's tag with its lower left corner at ( x, y ) (null: hide it), kept inside the
	 * interface (w x h). */
	update( v: Villager | null, x: number, y: number, w: number, h: number ): void {

		css( this.root, 'opacity', v ? '1' : '0' );
		css( this.root, 'pointer-events', v ? 'auto' : 'none' );
		if ( ! v ) return;
		if ( this.who !== v.id ) {

			this.who = v.id;
			this.chosenSlot = - 1;

		}
		const shared = this.shared, sim = shared.game.sim;
		const doing = doingWords( sim, v, shared.buildingName );
		text( this.name, v.name );
		attr( this.root, 'aria-label', v.name );
		text( this.doing, doing );
		for ( const n of this.needs ) {

			const value = Math.round( v.needs[ n.key ] ), critical = value <= CRITICAL_NEED;
			text( n.num, String( value ) );
			css( n.num, 'color', critical ? PALETTE.zhu : '' );
			css( n.icon, 'color', critical ? PALETTE.zhu : '' );
			if ( n.shown !== value ) {

				n.shown = value;
				// the bar's own colour, blending to 朱 as the need runs low
				const t = ( LOW_NEED - value ) / ( LOW_NEED - CRITICAL_NEED );
				attr( n.fill, 'fill', mix( n.colour, PALETTE.zhu, t ) );
				attr( n.fill, 'd', value > 0 ? level( 1, 1 + 128 * value / 100, 4, 4.4, 0.4, { entry: 0.05, exit: Math.min( 0.6, 12 / Math.max( value, 1 ) ), start: 0.5, end: 0.2, swell: 0 } ) : '' );

			}

		}
		// the bag: a slot per kind with its count, then a faint ring for each free place
		const kinds = Object.keys( v.bag ).sort();
		const free = BAG_CAPACITY - total( v.bag );
		for ( let i = 0; i < this.slots.length; i ++ ) {

			const s = this.slots[ i ], kind = kinds[ i ];
			const shown = kind !== undefined || i < kinds.length + free;
			css( s.box, 'display', shown ? '' : 'none' );
			setIcon( s.icon, kind ?? 'slot' );
			text( s.count, kind && v.bag[ kind ] > 1 ? String( v.bag[ kind ] ) : kind ? '1' : '' );
			flag( s.box, 'empty', ! kind );
			flag( s.box, 'on', i === this.chosenSlot );
			attr( s.box, 'aria-label', kind ? `${ itemName( kind ) } ${ v.bag[ kind ] }` : '空' );

		}
		// beside the islander, kept inside the interface
		const key = `${ v.name }|${ doing }|${ Math.round( v.needs.satiety ) }|${ Math.round( v.needs.hydration ) }|${ kinds.length + free }`;
		if ( key !== this.size.key ) this.size = { key, w: this.root.offsetWidth, h: this.root.offsetHeight };
		const tw = this.size.w, th = this.size.h;
		const left = Math.min( Math.max( x, 8 ), w - tw - 8 ), top = Math.min( Math.max( y - th, 90 ), h - th - 110 );
		css( this.root, 'transform', `translate(${ left.toFixed( 1 ) }px,${ top.toFixed( 1 ) }px)` );

	}

}
