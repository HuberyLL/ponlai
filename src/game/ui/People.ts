import * as THREE from 'three/webgpu';
import { CLICK_SLOP } from '../../camera/IslandCameraControls.ts';
import { BAG_CAPACITY, total } from '../sim/items.ts';
import { CRITICAL_NEED, LOW_NEED } from '../sim/needs.ts';
import { needs as needKinds } from '../sim/registry.ts';
import type { EntityId, Needs, Villager } from '../sim/types.ts';
import { cubic, levelStroke, ringStroke, stroke } from './Brush.ts';
import type { Stroke } from './Brush.ts';
import { iconSvg, setIcon } from './Icons.ts';
import { PALETTE, mix } from './Palette.ts';
import { needLook, needName } from './data/needs.ts';
import { doingWords, itemName } from './data/words.ts';
import { attr, css, el, flag, svgEl, text, under } from './dom.ts';
import { InkPath } from './InkPath.ts';
import { t } from './i18n/i18n.ts';
import type { UiShared } from './Shared.ts';
import { Space } from './Space.ts';

// The islanders' marks (docs/explanation/ui.md, Islanders: selection and alerts; Speaking; Screen and world):
//
// - Selected (a click on an islander, again or on open ground to let go): a ring at the feet, thick
//   in front and thin behind, with one 金 stroke beneath its front, and the tag beside them (人旁
//   浮签), joined to the shoulder by a short brush leader: the name in calligraphy, what they are
//   doing (缟, faint), each need registered (sim/registry.ts) as a thin bar with its number, in the
//   order registered (its icon and colour from data/needs.ts, satiety's 琥珀 and hydration's 天水碧,
//   a need without a look of its own the default; each blending to 朱 from LOW_NEED down to
//   CRITICAL_NEED, where the icon and number turn 朱 too), and the bag as slots (a kind and its
//   count, then a faint ring for each free place; a click marks one with a 金 stroke, which does
//   nothing more yet).
// - An unselected islander with a critical need: its icon in 朱 over the head, no ring, no backing;
//   several side by side in the needs' order (satiety on the left).
// - Thinking (a thought in flight, Sim.thinking, after hearing the player): the characters heard
//   circle the head, at most six at a time, the whole line taking turns as each passes behind the
//   head; words heard meanwhile wait for the next thought. Only a brain that hears keeps the
//   characters that land (Game.hears): the stand-in's islanders hear none.
// - Speaking (an islander's `said` event, sim/events.ts, heard through Game.listen: the latest
//   line each islander said, never the state polled): the characters pop out of the mouth one at a time, each
//   swinging open to face the viewer, sized by the figure's size on screen; the line holds 2.5 s
//   and 0.3 s a character, then melts away one by one, each turning aside as it rises. A line still
//   showing melts first (MELT), and the new one comes out as it goes; a line said before the new one
//   came out takes its place.
//
// What belongs to the islander's world stands in it: the ring lies on the ground at the feet (its
// points on the land, seen through the camera each frame, the near side the heavier); the
// thinking ring turns round the head in 3D, each character facing out from it and turned half
// toward the viewer, so the characters at the sides show foreshortened and those behind the head
// edge on; the speech stands over the head facing the viewer (both DOM laid into the scene through
// the camera: Space.ts). What the player reads about an islander stays on the screen, beside
// them: the tag and its leader, the alerts. Everything is placed each frame from the islanders as
// drawn (Game.anchor: their feet), at sizes from their size on screen, so near and far islanders
// keep readable words; over the head from the bottom up, always in the same places: the thinking
// ring, the alerts, the words. The ring, its 金 stroke and the leader are inked strokes of one SVG
// layer over the screen (InkPath.ts), drawn again as they change: laid into the scene as an image
// in perspective instead, the browser resampled the ring's thin back into dashes. The ring is an
// ensō that starts at its front left and goes round the back, so its dry tail falls on its heavy
// near side.
//
// Rules: it reads the simulation and the drawn figures, and changes nothing but the selection (and
// the shadow's focus, which follows it: Game.focus). It is DOM over the canvas: a paused frame's
// pixels never change for it. Its own motion (words, the thinking ring) runs on real time, as a
// mind's does; nothing of it shows on a page loaded paused with nobody selected.

const RING_RADIUS = 0.42, RING_POINTS = 40, RING_LIFT = 0.03;
// the tag's place from the head's top (interface px): its lower left corner, the leader's ends
const TAG = { x: 62, y: - 46 }, LEADER = { x0: 9, y0: 10, x1: 56, y1: - 40 };
// the leader from the head's top, placed there each frame
const LEADER_STROKE = stroke( cubic( { x: LEADER.x0, y: LEADER.y0 }, { x: LEADER.x0 + 12, y: LEADER.y0 - 18 }, { x: LEADER.x1 - 18, y: LEADER.y1 + 14 }, { x: LEADER.x1, y: LEADER.y1 }, 16 ), 2.6, { entry: 0.3, exit: 0.5, start: 0.5, end: 0.15 } );
const THINK_SLOTS = 6, THINK_ROUND = 4800;
// the thinking ring is seen from this far above its plane (its height over its width on screen),
// whatever the camera's pitch: tilted toward a camera looking down, so it never reads as a halo
// seen from above; and the share by which its characters turn from facing out toward the viewer
const THINK_FLAT = 0.18, THINK_FACE = 0.45;
const POP_EVERY = 70, POP = 280, HOLD = 2500, HOLD_PER_CHAR = 300, MELT = 700, MELT_EVERY = 40;
// the speech's lines: characters to a line, a character's advance and a line's height (em)
const TALK_LINE = 14, TALK_ADVANCE = 1.04, TALK_LEADING = 1.45;
// a character in the world: its element's own size (px; its font size, so it rasterises sharp at
// the sizes it is seen at), and the mouth under the head's top (m) the speech comes out of
export const GLYPH = 64;
const MOUTH = 0.2;

const _p = new THREE.Vector3(), _q = new THREE.Vector3(), _c = new THREE.Vector3(), _n = new THREE.Vector3();
const _r = new THREE.Vector3(), _d = new THREE.Vector3(), _v = new THREE.Vector3();
const _gx = new THREE.Vector3(), _gy = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
const UP = new THREE.Vector3( 0, 1, 0 );

interface Talk { chars: HTMLSpanElement[]; start: number; until: number; out: boolean; melted: number; gone: number }

interface Mark {
	id: EntityId;
	/** on screen, at the head: the alerts */
	root: HTMLElement;
	alerts: HTMLElement;
	alertIcons: SVGSVGElement[];
	/** in the world (Space.ts): the thinking ring's characters and the speech's */
	think: HTMLElement;
	thinkChars: HTMLSpanElement[];
	talkBox: HTMLElement;
	talk: Talk | null;
	/** the line before it, melting until the new one comes out */
	leaving: Talk | null;
	/** the line last shown, by its number (`lines`; 0: none) */
	said: number;
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
	/** this frame: the head's top in the world, its depth from the camera and the interface px a
	 * metre spans across the view there, and up the figure */
	head: THREE.Vector3;
	depth: number;
	across: number;
	upright: number;
	seen: number;
}

/** Where an islander's head is this frame, for the words flying to it: on screen (interface px),
 * the figure's height there, and its depth from the camera (m). */
export interface HeadPoint { x: number; y: number; size: number; depth: number }

export class People {

	readonly root: HTMLElement;
	/** the world the marks stand in (the speak bar's words in flight too), updated first each frame */
	readonly space: Space;
	private readonly shared: UiShared;
	private readonly world: HTMLElement;
	private readonly marks = new Map<EntityId, Mark>();
	// each islander's latest line said (its `said` events), numbered as heard, so a mark shows a line
	// once, and two lines said within a frame show as the newer
	private readonly lines = new Map<EntityId, { words: string; n: number }>();
	private heardLines = 0;
	private readonly svg: SVGSVGElement;
	private readonly ringInk: InkPath;
	private readonly goldInk: InkPath;
	private readonly leaderInk: InkPath;
	private readonly tag: Tag;
	private frame = 0;
	private down: { x: number; y: number } | null = null;
	/** whether a click on the scene may select (not while a building is being placed) */
	selectable = (): boolean => true;

	constructor( parent: Element, shared: UiShared, camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement ) {

		this.shared = shared;
		this.space = new Space( camera );
		this.root = el( 'div', 'pl-people', parent );
		this.svg = svgEl( 'svg', { class: 'marks pl-sh', width: 1, height: 1, 'aria-hidden': 'true' }, this.root );
		this.ringInk = new InkPath( this.svg, { colour: PALETTE.gao, evenOdd: true }, 61 );
		this.goldInk = new InkPath( this.svg, { colour: PALETTE.jin }, 62 );
		this.leaderInk = new InkPath( this.svg, { colour: PALETTE.gao }, 63 );
		// the words in the world, over the ring
		this.world = el( 'div', 'pl-space', this.root );
		this.tag = new Tag( this.root, shared );
		canvas.addEventListener( 'pointerdown', this.onDown );
		canvas.addEventListener( 'pointerup', this.onUp );
		shared.game.listen( ( e ) => {

			if ( e.kind === 'said' && e.who !== 'player' ) this.lines.set( e.who, { words: e.words, n: ++ this.heardLines } );

		} );

	}

	/** A new simulation (start, load): every mark starts over, nobody selected. */
	reset(): void {

		for ( const m of this.marks.values() ) this.drop( m );
		this.marks.clear();
		this.lines.clear();
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
		return m && m.shown ? { x: m.x, y: m.y, size: m.size, depth: m.depth } : null;

	}

	/** The islanders on screen now, left to right (the listeners of words to everyone). */
	inView(): EntityId[] {

		return [ ...this.marks.values() ].filter( ( m ) => m.shown ).sort( ( a, b ) => a.x - b.x ).map( ( m ) => m.id );

	}

	/** A character of the player's `line` (UiShared.lines) has sunk into an islander's head: it is
	 * heard, by a brain that hears. */
	hear( id: EntityId, c: string, line: number ): void {

		const m = this.marks.get( id );
		if ( m && this.shared.game.hears() && ! /[，。！？、；：,.!?;:\s]/.test( c ) ) m.heard.push( { c, line } );

	}

	update(): void {

		const shared = this.shared, sim = shared.game.sim, frame = ++ this.frame, hears = shared.game.hears();
		// the interface's size in its own pixels (the window's, over its scale)
		const w = innerWidth / shared.k, h = innerHeight / shared.k;
		this.space.update( w, h );
		attr( this.svg, 'width', String( w ) );
		attr( this.svg, 'height', String( h ) );
		attr( this.svg, 'viewBox', `0 0 ${ w } ${ h }` );
		let ring: ReturnType<People[ 'ring' ]> = null, leaderAt: { x: number; y: number } | null = null;
		for ( const v of sim.state.villagers ) {

			let m = this.marks.get( v.id );
			if ( ! m ) this.marks.set( v.id, m = this.mark( v ) );
			m.seen = frame;
			this.place( m, w, h );
			const selected = shared.selected === v.id;
			flag( m.root, 'hidden', ! m.shown );
			flag( m.think, 'hidden', ! m.shown );
			flag( m.talkBox, 'hidden', ! m.shown );
			if ( m.shown ) css( m.root, 'transform', `translate(${ m.x.toFixed( 1 ) }px,${ m.y.toFixed( 1 ) }px)` );
			this.alerts( m, v.needs, selected );
			// (a brain that does not hear, put in its slot, keeps nothing heard for the next that does)
			if ( ! hears && m.heard.length > 0 ) m.heard = [];
			this.thinking( m, sim.thinking( v.id ) );
			this.talking( m, v );
			if ( selected && m.shown ) {

				ring = this.ring( v.id );
				leaderAt = { x: m.x, y: m.y };

			}

		}
		for ( const [ id, m ] of this.marks ) {

			if ( m.seen === frame ) continue;
			this.drop( m );
			this.marks.delete( id );
			if ( shared.selected === id ) this.select( null );

		}
		this.ringInk.set( ring?.ring ?? null, ring?.at );
		this.goldInk.set( ring?.gold ?? null, ring?.at );
		this.leaderInk.set( leaderAt && LEADER_STROKE, leaderAt ?? undefined );
		const selected = shared.selected !== null ? this.marks.get( shared.selected ) : undefined;
		const v = selected && sim.villager( selected.id );
		this.tag.update( v && selected.shown ? v : null, selected ? selected.x + TAG.x : 0, selected ? selected.y + TAG.y : 0, w, h );

	}

	private mark( v: Villager ): Mark {

		const root = el( 'div', 'pl-person', this.root );
		const alerts = el( 'div', 'pl-alerts pl-sh', root );
		const alertIcons = needKinds().map( ( need ) => iconSvg( needLook( need.id ).icon, 20 ) );
		for ( const icon of alertIcons ) alerts.appendChild( icon );
		const think = el( 'div', 'pl-think', this.world );
		const thinkChars: HTMLSpanElement[] = [];
		for ( let i = 0; i < THINK_SLOTS; i ++ ) thinkChars.push( el( 'span', 'pl-glyph', think ) );
		const talkBox = el( 'div', 'pl-talk', this.world );
		return { id: v.id, root, alerts, alertIcons, think, thinkChars, talkBox, talk: null, leaving: null, said: this.lines.get( v.id )?.n ?? 0, heard: [], thought: null,
			shown: false, x: 0, y: 0, size: 0, head: new THREE.Vector3(), depth: 0, across: 1, upright: 1, seen: 0 };

	}

	private drop( m: Mark ): void {

		m.root.remove();
		m.think.remove();
		m.talkBox.remove();

	}

	// The islander's head on screen (interface px), the figure's height there, and the head in the
	// world, from its drawn feet.
	private place( m: Mark, w: number, h: number ): void {

		m.shown = false;
		if ( ! this.shared.game.anchor( m.id, _p ) ) return;
		const height = this.shared.game.figureHeight( m.id );
		m.head.copy( _p );
		m.head.y += height;
		const space = this.space;
		if ( ! space.project( _p, _q ) || ! space.project( m.head, _c ) ) return;
		m.x = _c.x;
		m.y = _c.y;
		m.size = Math.abs( _q.y - _c.y );
		m.depth = _c.z;
		m.across = space.pixelsPerMetre( m.depth );
		// (a camera right overhead sees the figure from its head: kept from shrinking to nothing)
		m.upright = Math.max( m.size / height, 0.3 * m.across );
		m.shown = m.x > - 100 && m.x < w + 100 && m.y > - 100 && m.y < h + 100;

	}

	// The ring at the feet (thick in front, thin behind) and its 金 stroke, as strokes about the
	// ring's middle on screen (`at`).
	private ring( id: EntityId ): { at: { x: number; y: number }; ring: Stroke; gold: Stroke } | null {

		const sim = this.shared.game.sim;
		if ( ! this.shared.game.anchor( id, _p ) ) return null;
		const cx = _p.x, cz = _p.z, pts: { x: number; y: number }[] = [];
		for ( let i = 0; i < RING_POINTS; i ++ ) {

			const a = i / RING_POINTS * Math.PI * 2, x = cx + Math.cos( a ) * RING_RADIUS, z = cz + Math.sin( a ) * RING_RADIUS;
			if ( ! this.space.project( _q.set( x, sim.grid.height( x, z ) + RING_LIFT, z ), _c ) ) return null;
			pts.push( { x: _c.x, y: _c.y } );

		}
		// the ring in its own coordinates about its middle, to a quarter unit: while it only moves (an
		// islander walking under a still camera) its ink is moved, not drawn again (InkPath.ts)
		let top = Infinity, bottom = - Infinity, left = Infinity, right = - Infinity;
		for ( const p of pts ) {

			top = Math.min( top, p.y );
			bottom = Math.max( bottom, p.y );
			left = Math.min( left, p.x );
			right = Math.max( right, p.x );

		}
		const at = { x: ( left + right ) / 2, y: ( top + bottom ) / 2 }, quarter = ( v: number ) => Math.round( v * 4 ) / 4;
		const own = pts.map( ( p ) => ( { x: quarter( p.x - at.x ), y: quarter( p.y - at.y ) } ) );
		const back = Math.min( ...own.map( ( p ) => p.y ) ), near = Math.max( ...own.map( ( p ) => p.y ) );
		const wide = Math.max( ...own.map( ( p ) => p.x ) ) - Math.min( ...own.map( ( p ) => p.x ) );
		// the nearer side (lower on screen) carries the weight
		const front = ( p: { y: number } ) => ( p.y - back ) / Math.max( near - back, 1e-3 );
		const scale = Math.min( Math.max( wide / 56, 0.5 ), 1.6 );
		const widths = own.map( ( p ) => ( 0.7 + 2.6 * front( p ) ** 1.5 ) * scale );
		const span = wide * 0.32;
		// as a stroke: from the point at the front left (as seen), round the back first
		const start = Math.PI * 0.87;
		let from = 0, nearest = Infinity;
		own.forEach( ( p, i ) => {

			const off = Math.abs( ( ( Math.atan2( p.y, p.x ) - start ) % ( 2 * Math.PI ) + 3 * Math.PI ) % ( 2 * Math.PI ) - Math.PI );
			if ( off < nearest ) {

				nearest = off;
				from = i;

			}

		} );
		const step = own[ ( from + 1 ) % own.length ].y < own[ from ].y ? 1 : - 1;
		return { at, ring: ringStroke( own, widths, from, step ), gold: levelStroke( - span, span, near + 4 * scale, 2.2 * scale, - 1.5 * scale, { entry: 0.2, exit: 0.45 } ) };

	}

	// A character in the world: its middle at `centre`, its x and y (down) along `ax` and `ay`
	// (unit vectors), `size` metres to an em.
	private glyph( e: HTMLElement, centre: THREE.Vector3, ax: THREE.Vector3, ay: THREE.Vector3, size: number ): void {

		this.space.place( e, centre, _a.copy( ax ).multiplyScalar( size / GLYPH ), _b.copy( ay ).multiplyScalar( size / GLYPH ), GLYPH, GLYPH );

	}

	private alerts( m: Mark, needs: Needs, selected: boolean ): void {

		const kinds = needKinds();
		let any = false;
		for ( let i = 0; i < kinds.length; i ++ ) {

			const critical = needs[ kinds[ i ].id ] <= CRITICAL_NEED;
			css( m.alertIcons[ i ], 'display', critical ? '' : 'none' );
			any ||= critical;

		}
		css( m.alerts, 'opacity', ! selected && any ? '1' : '0' );
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
		if ( ! th || ! m.shown ) return;
		const gp = Math.max( 9, this.wordSize( m ) * 0.58 ), nr = Math.min( THINK_SLOTS, th.chars.length );
		const rx = Math.min( Math.max( gp * 1.6 + 10, nr * gp * 0.62 ), THINK_SLOTS * gp * 0.62 );
		// the ring's middle over the head; its axes: to the right as seen, toward the viewer in its
		// plane, and its plane's normal, tilted toward the viewer until it is seen THINK_FLAT
		_c.copy( m.head ).addScaledVector( UP, ( gp * 0.6 + 6 ) / m.upright );
		_v.subVectors( this.space.eye, _c ).normalize();
		_d.set( _v.x, 0, _v.z );
		if ( _d.lengthSq() < 1e-8 ) _d.copy( this.space.up ).negate().setY( 0 );
		_d.normalize();
		_r.crossVectors( UP, _d ).normalize();
		const tilt = Math.asin( Math.min( Math.max( _v.y, - 1 ), 1 ) ) - Math.asin( THINK_FLAT );
		_n.copy( UP ).multiplyScalar( Math.cos( tilt ) ).addScaledVector( _d, - Math.sin( tilt ) );
		_d.multiplyScalar( Math.cos( tilt ) ).addScaledVector( UP, Math.sin( tilt ) );
		const radius = rx / m.across;
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
			const a = u * Math.PI * 2, frontness = Math.sin( a );
			const opacity = frontness >= 0 ? 0.35 + 0.45 * frontness : Math.max( 0, 0.35 + 0.6 * frontness ) * ( 1 - smoothBack( u ) );
			const scale = 1 + 0.12 * Math.max( frontness, 0 ) - 0.13 * Math.max( - frontness, 0 );
			_p.copy( _c ).addScaledVector( _r, radius * Math.cos( a ) ).addScaledVector( _d, radius * frontness );
			// facing out from the ring, turned toward the viewer by THINK_FACE (from the front)
			const off = ( ( a - Math.PI / 2 ) % ( 2 * Math.PI ) + 3 * Math.PI ) % ( 2 * Math.PI ) - Math.PI;
			const b = Math.PI / 2 + off * ( 1 - THINK_FACE );
			_gx.copy( _r ).multiplyScalar( Math.sin( b ) ).addScaledVector( _d, - Math.cos( b ) );
			_gy.copy( _n ).negate();
			this.glyph( span, _p, _gx, _gy, gp * scale / m.across );
			css( span, 'opacity', opacity.toFixed( 3 ) );

		}

	}

	// Speech over the head: a new line pops out a character at a time, holds, then melts. A line still
	// showing melts first, drawn as it goes until the new one comes out (`leaving`); a new line that
	// has not come out yet gives way to a newer one, which comes out when it would have.
	private talking( m: Mark, v: Villager ): void {

		const now = this.shared.now, line = this.lines.get( v.id );
		if ( line && line.n !== m.said ) {

			m.said = line.n;
			const old = m.talk;
			let start = now;
			if ( old && now < old.start ) {

				clear( old );
				start = old.start;

			} else if ( old ) {

				if ( ! old.out ) {

					this.melt( old );
					start = now + MELT;

				}
				if ( m.leaving ) clear( m.leaving );
				m.leaving = old;

			}
			const chars = Array.from( line.words );
			m.talk = { chars: chars.map( ( c ) => el( 'span', 'pl-glyph', m.talkBox, c ) ), start, until: start + ( chars.length - 1 ) * POP_EVERY + HOLD + HOLD_PER_CHAR * chars.length, out: false, melted: 0, gone: 0 };

		}
		if ( m.leaving && ( ! m.talk || now >= m.talk.start ) ) {

			clear( m.leaving );
			m.leaving = null;

		}
		if ( m.leaving ) this.say( m, m.leaving );
		const talk = m.talk;
		if ( ! talk ) return;
		if ( ! talk.out && now >= talk.until ) this.melt( talk );
		if ( talk.out && now >= talk.gone ) {

			clear( talk );
			m.talk = null;
			return;

		}
		this.say( m, talk );

	}

	// A line's characters over the head, as far as it has come out (or melted) now.
	private say( m: Mark, talk: Talk ): void {

		const now = this.shared.now;
		if ( talk.chars.length === 0 || ! m.shown ) return;
		// facing the viewer over the thinking ring's room (and the alerts', when they show), in lines
		// of TALK_LINE centred and stacked upward from the last
		const space = this.space, size = this.wordSize( m ) / m.across, n = talk.chars.length, lines = Math.ceil( n / TALK_LINE );
		const bottom = this.ringRoom( m ) + ( m.alerts.style.opacity === '1' ? 30 : 6 );
		_c.copy( m.head ).addScaledVector( UP, bottom / m.upright );
		// where each character comes from: the mouth
		_q.copy( m.head ).addScaledVector( UP, - MOUTH );
		talk.chars.forEach( ( s, q ) => {

			const line = Math.floor( q / TALK_LINE ), col = q % TALK_LINE, inLine = Math.min( TALK_LINE, n - line * TALK_LINE );
			_p.copy( _c ).addScaledVector( space.up, ( lines - line - 0.5 ) * TALK_LEADING * size )
				.addScaledVector( space.right, ( col - ( inLine - 1 ) / 2 ) * TALK_ADVANCE * size );
			const popped = Math.min( Math.max( ( now - talk.start - q * POP_EVERY ) / POP, 0 ), 1 );
			if ( popped <= 0 ) {

				css( s, 'opacity', '0' );
				return;

			}
			// out of the mouth, small and edge on, swinging open to face the viewer (overshooting a little)
			const e = backOut( popped ), side = q % 2 ? 1 : - 1;
			_p.lerpVectors( _q, _p, e );
			let opacity = Math.min( 1, popped / 0.55 ), yaw = side * ( 1 - e ) * 1.4, scale = 0.3 + 0.7 * e, blur = 0;
			if ( talk.out ) {

				// melting: rising a little, turning aside and blurring as it fades
				const g = smooth( Math.min( Math.max( ( now - talk.melted - q * MELT_EVERY ) / MELT, 0 ), 1 ) );
				_p.addScaledVector( space.up, 8 * g / m.across );
				opacity *= 1 - g;
				yaw += side * 0.9 * g;
				blur = 2 * g;

			}
			space.facing( yaw, 0, 0, _gx, _gy );
			this.glyph( s, _p, _gx, _gy, size * scale );
			css( s, 'opacity', opacity.toFixed( 3 ) );
			css( s, 'filter', blur > 0.01 ? `blur(${ ( blur * GLYPH / Math.max( this.wordSize( m ) * scale, 1 ) ).toFixed( 1 ) }px)` : 'none' );

		} );

	}

	private melt( talk: Talk ): void {

		talk.out = true;
		talk.melted = this.shared.now;
		talk.gone = this.shared.now + MELT + MELT_EVERY * talk.chars.length;

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

const smooth = ( t: number ) => t * t * ( 3 - 2 * t );

// rising past 1 and settling back (an ease out with an overshoot)
function backOut( t: number ): number {

	const c = 1.4, u = t - 1;
	return 1 + ( c + 1 ) * u * u * u + c * u * u;

}

// a line's characters off the page
function clear( talk: Talk ): void {

	talk.chars.forEach( ( s ) => s.remove() );

}

/** The tag beside the selected islander. */
class Tag {

	private readonly shared: UiShared;
	private readonly root: HTMLElement;
	private readonly name: HTMLElement;
	private readonly doing: HTMLElement;
	private readonly needs: { key: string; colour: string; icon: SVGSVGElement; fill: InkPath; num: HTMLElement; shown: number }[] = [];
	private readonly bag: HTMLElement;
	private readonly slots: { box: HTMLButtonElement; icon: SVGSVGElement; count: HTMLElement; label: string }[] = [];
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
		const track = levelStroke( 1, 129, 4, 2.6, 0.4, { entry: 0.06, exit: 0.2, start: 0.4, end: 0.3, swell: 0 } );
		for ( const [ i, need ] of needKinds().entries() ) {

			const key = need.id, { icon, colour } = needLook( key );
			const row = el( 'div', 'need', root );
			const svg = row.appendChild( iconSvg( icon, 18, 'pl-sh' ) );
			svg.setAttribute( 'role', 'img' );
			svg.setAttribute( 'aria-label', needName( key ) );
			svg.removeAttribute( 'aria-hidden' );
			const bar = svgEl( 'svg', { class: 'pl-sh', width: 130, height: 8, viewBox: '0 0 130 8', 'aria-hidden': 'true' }, row );
			// (a gauge: its ends say the value and the whole, so it does not dry out; each need's
			// strokes their own seeds, so the bars differ as hand-drawn ones do)
			new InkPath( bar, { colour: PALETTE.gao, opacity: 0.2 }, 64 + 2 * i, 0 ).set( track );
			const fill = new InkPath( bar, { colour }, 65 + 2 * i, 0 );
			this.needs.push( { key, colour, icon: svg, fill, num: el( 'span', 'pl-num pl-mist', row ), shown: - 1 } );

		}
		this.bag = el( 'div', 'bag', root );
		this.bag.setAttribute( 'aria-label', t( 'tag.bag' ) );
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
			this.slots.push( { box, icon, count, label: '' } );

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

			// (critical as the alerts and the record read it: the need itself, not the number shown)
			const value = Math.round( v.needs[ n.key ] ), critical = v.needs[ n.key ] <= CRITICAL_NEED;
			text( n.num, String( value ) );
			css( n.num, 'color', critical ? PALETTE.zhu : '' );
			css( n.icon, 'color', critical ? PALETTE.zhu : '' );
			if ( n.shown !== value ) {

				n.shown = value;
				// the bar's own colour, blending to 朱 as the need runs low
				const t = ( LOW_NEED - value ) / ( LOW_NEED - CRITICAL_NEED );
				n.fill.setPaint( { colour: mix( n.colour, PALETTE.zhu, t ) } );
				n.fill.set( value > 0 ? levelStroke( 1, 1 + 128 * value / 100, 4, 4.4, 0.4, { entry: 0.05, exit: Math.min( 0.6, 12 / Math.max( value, 1 ) ), start: 0.5, end: 0.2, swell: 0 } ) : null );

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
			// (its label only when its kind or count changed: a word costs a lookup)
			const label = `${ kind }|${ kind ? v.bag[ kind ] : 0 }`;
			if ( s.label !== label ) {

				s.label = label;
				attr( s.box, 'aria-label', kind ? t( 'tag.slot', { name: itemName( kind ), count: v.bag[ kind ] } ) : t( 'tag.empty' ) );

			}

		}
		// beside the islander, kept inside the interface
		let key = `${ v.name }|${ doing }|${ kinds.length + free }`;
		for ( const n of this.needs ) key += `|${ n.shown }`;
		if ( key !== this.size.key ) this.size = { key, w: this.root.offsetWidth, h: this.root.offsetHeight };
		const tw = this.size.w, th = this.size.h;
		const left = Math.min( Math.max( x, 8 ), w - tw - 8 ), top = Math.min( Math.max( y - th, 90 ), h - th - 110 );
		css( this.root, 'transform', `translate(${ left.toFixed( 1 ) }px,${ top.toFixed( 1 ) }px)` );

	}

}
