import { levelStroke, upright } from './Brush.ts';
import { iconSvg } from './Icons.ts';
import { BUILD_GROUPS } from './data/buildings.ts';
import type { BuildGroup, BuildingRow } from './data/buildings.ts';
import { refusalWords } from './data/words.ts';
import { attr, css, el, flag, iconButton, svgEl, text } from './dom.ts';
import { InkPath } from './InkPath.ts';
import { PALETTE } from './Palette.ts';
import { t } from './i18n/i18n.ts';
import type { UiShared } from './Shared.ts';

// The build bar: the mallet's two tiers of brush strokes, the groups and their buildings.
//
// The build bar (docs/design/ui.md, Build bar): opened by the mallet at the bottom right,
// which toggles it; the speak bar steps aside while it is open. Two
// tiers of brush strokes run leftward from the mallet:
// - the groups (tier 1), a fixed handful in data/buildings.ts BUILD_GROUPS' order, the recently
//   placed group (近用) nearest the mallet, the magnifier at the far left;
// - the buildings of the chosen group (tier 2), in small groups split by space with their names
//   small and 苍 beneath, the group's name in calligraphy at the head; about eight in view (VIEW
//   px), the rest reached by the wheel, the brush arrows at the ends or ←/→, faded at an edge only
//   where more lies that way.
// Search (the magnifier or /, never any key: a Chinese input method would lose the first letter)
// matches name, use, group, small group and search words across all groups. 1-9 pick from what is
// in view; Esc clears the search, then the choice, then closes; Enter closes and returns to talking.
// The chosen building lifts with one 金 stroke beneath, and its name, use, cost and hours float
// above it; a material it lacks shows 朱, here and in the top row (UiShared.shown). A row not yet
// buildable is faint and cannot be chosen, but still shows its detail on hover (还不能建). The
// recent group lists what the island has had placed, one of each kind, the latest first.
//
// Choosing a building the simulation knows (its row's `kind`) hands it to the placement in the
// scene (Placement.ts: the ring under the pointer, a click to place); the detail then says how, or
// why the spot is refused. Placing it clears the choice; the record notes it (Chronicle.ts).
//
// Rules: everything it lists comes from the rows (UiShared.roster, data/buildings.ts) and the stock
// (UiShared.stock); the shortfall is the simulation's (sim/stock.ts shortfall), never the bar's own
// sum. Its keys come before the speak bar's (GameUi routes them).

const SLOT = 64, GAP = 30, VIEW = 600, RIGHT = 1500, TIER1 = 130, TIER2 = 54, RECENT_X = 1456, GROUP_STEP = 54;

/** What the build bar hands to the placement in the scene (Placement.ts). */
export interface PlacementHandle {
	/** arm placing a building of the simulation's kind (null: disarm) */
	arm( kind: string | null ): void;
	readonly armed: string | null;
	/** while placing: why the spot under the pointer is refused (the simulation's reason, data/words.ts
	 * puts it in words), or null where it would place (the bar then says how) */
	readonly hint: { refusal: string | null } | null;
}

interface Item { row: BuildingRow; x: number; button: HTMLButtonElement; inView: boolean }

export class BuildBar {

	readonly root: HTMLElement;
	readonly mallet: HTMLButtonElement;
	private readonly shared: UiShared;
	private readonly placement: PlacementHandle;
	private readonly onToggle: ( open: boolean ) => void;
	private readonly onTalk: () => void;
	private readonly groups: { id: string; button: HTMLButtonElement }[] = [];
	private readonly tier2: HTMLElement;
	private readonly line: SVGSVGElement;
	private readonly lineInk: InkPath;
	private readonly clip: HTMLElement;
	private readonly shift: HTMLElement;
	private readonly back: HTMLButtonElement;
	private readonly on: HTMLButtonElement;
	private readonly groupName: HTMLElement;
	private readonly search: HTMLInputElement;
	private readonly none: HTMLElement;
	private readonly detail: HTMLElement;
	private readonly detailName: HTMLElement;
	private readonly detailUse: HTMLElement;
	private readonly detailCost: HTMLElement;
	private readonly detailNote: HTMLElement;
	private items: Item[] = [];
	private built = '';
	private width = 0;
	private view = 0;
	private wheelAt = 0;
	open = false;
	private group = BUILD_GROUPS[ 0 ].id;
	private query = '';
	private chosen: string | null = null;
	private hover: string | null = null;
	private scroll = 0;

	constructor( parent: Element, shared: UiShared, placement: PlacementHandle, onToggle: ( open: boolean ) => void, onTalk: () => void ) {

		this.shared = shared;
		this.placement = placement;
		this.onToggle = onToggle;
		this.onTalk = onTalk;
		const root = this.root = el( 'div', 'pl-build closed', parent );
		root.setAttribute( 'aria-label', t( 'build.title' ) );
		this.mallet = iconButton( t( 'build.title' ), 'build', 32, parent, () => this.setOpen( ! this.open ), 'pl-mallet' );
		this.mallet.setAttribute( 'aria-expanded', 'false' );

		// tier 1: the groups, leftward from the mallet: the recent group, a tick, the others, a tick, the magnifier
		const regular = BUILD_GROUPS.filter( ( g ) => ! g.recent ), recent = BUILD_GROUPS.filter( ( g ) => g.recent );
		const firstX = RECENT_X - 58 - GROUP_STEP * ( regular.length - 1 );
		const searchX = firstX - 62;
		const strokes = svgEl( 'svg', { class: 'strokes pl-sh', width: 1600, height: 200, viewBox: '0 0 1600 200', 'aria-hidden': 'true' }, root );
		new InkPath( strokes, { colour: PALETTE.gao, opacity: 0.85 }, 41 ).set( levelStroke( searchX - 12, 1532, 176, 3.4, 1.4, { entry: 0.06, exit: 0.3 } ) );
		for ( const x of [ firstX - 12, RECENT_X - 10 ] ) svgEl( 'path', { d: upright( x + 3, TIER1 + 9, TIER1 + 35, 2, 0.4 ), fill: 'var(--gao)', 'fill-opacity': 0.4 }, strokes );
		regular.forEach( ( g, i ) => this.addGroup( g.id, g.name, g.icon, firstX + GROUP_STEP * i ) );
		for ( const g of recent ) this.addGroup( g.id, g.name, g.icon, RECENT_X );
		const magnifier = iconButton( t( 'build.search' ), 'search', 22, root, () => this.search.focus(), 'bi' );
		css( magnifier, 'left', `${ searchX }px` );
		css( magnifier, 'top', `${ TIER1 }px` );

		// tier 2: the buildings in view, scrolled
		const tier2 = this.tier2 = el( 'div', 'tier2', root );
		css( tier2, 'top', `${ TIER2 }px` );
		tier2.addEventListener( 'wheel', this.onWheel, { passive: true } );
		this.line = svgEl( 'svg', { class: 'line pl-sh', height: 12, 'aria-hidden': 'true' }, tier2 );
		this.lineInk = new InkPath( this.line, { colour: PALETTE.gao, opacity: 0.8 }, 42 );
		this.clip = el( 'div', 'clip', tier2 );
		this.shift = el( 'div', 'shift', this.clip );
		this.none = el( 'div', 'none', this.shift, t( 'build.notFound' ) );
		this.back = iconButton( t( 'build.back' ), 'chevron', 30, tier2, () => this.scrollBy( - 1 ), 'arrow' );
		css( this.back, 'left', '-44px' );
		this.on = iconButton( t( 'build.on' ), 'chevron', 30, tier2, () => this.scrollBy( 1 ), 'arrow' );
		css( this.on, 'right', '-40px' );
		this.on.querySelector( 'svg' )!.style.transform = 'scaleX(-1)';
		const head = el( 'div', 'head', tier2 );
		css( head, 'right', 'calc(100% + 46px)' );
		this.groupName = el( 'div', 'group-name pl-title pl-xb', head );
		const search = this.search = el( 'input', 'search', head );
		search.setAttribute( 'aria-label', t( 'build.search' ) );
		search.autocomplete = 'off';
		search.spellcheck = false;
		search.addEventListener( 'input', () => {

			this.query = search.value;
			this.scroll = 0;

		} );
		search.addEventListener( 'focus', () => {

			this.hover = null;

		} );
		search.addEventListener( 'keydown', ( e ) => {

			// a key while an input method composes belongs to it
			if ( e.isComposing || e.keyCode === 229 ) return;
			if ( e.key === 'Escape' ) {

				e.preventDefault();
				e.stopPropagation();
				this.clearSearch();

			} else if ( e.key === 'Enter' ) {

				e.preventDefault();
				this.talk();

			}

		} );

		// the chosen building's detail, floating over it
		const detail = this.detail = el( 'div', 'detail', root );
		css( detail, 'top', '-108px' );
		const body = el( 'div', 'body', detail );
		this.detailName = el( 'div', 'name pl-title pl-xb', body );
		this.detailUse = el( 'div', 'use', body );
		this.detailCost = el( 'div', 'cost pl-sh', body );
		this.detailNote = el( 'div', 'note', body );

	}

	private addGroup( id: BuildGroup[ 'id' ], name: string, icon: string, x: number ): void {

		const b = iconButton( name, icon, 26, this.root, () => this.pickGroup( id ), 'bi group' );
		css( b, 'left', `${ x }px` );
		css( b, 'top', `${ TIER1 }px` );
		this.groups.push( { id, button: b } );

	}

	/** Open or close the bar (the mallet, Esc, Enter). */
	setOpen( open: boolean ): void {

		if ( this.open === open ) return;
		this.open = open;
		flag( this.root, 'closed', ! open );
		flag( this.mallet, 'on', open );
		this.mallet.setAttribute( 'aria-expanded', String( open ) );
		this.hover = null;
		if ( ! open ) {

			this.choose( null );
			if ( document.activeElement === this.search ) this.search.blur();

		}
		this.onToggle( open );

	}

	/** Enter: the bar closes (if open) and the player talks. */
	talk(): void {

		this.setOpen( false );
		this.onTalk();

	}

	/** A new simulation: the bar closes, nothing chosen, no search. */
	reset(): void {

		this.setOpen( false );
		this.clearSearch();

	}

	private pickGroup( id: BuildGroup[ 'id' ] ): void {

		this.clearSearch();
		this.group = id;
		this.scroll = 0;
		this.hover = null;
		this.choose( null );

	}

	private clearSearch(): void {

		this.search.value = '';
		this.query = '';
		this.scroll = 0;
		if ( document.activeElement === this.search ) this.search.blur();

	}

	// Choose a building (null: none); one the simulation knows goes to the placement in the scene.
	private choose( id: string | null ): void {

		const row = id !== null ? this.shared.roster.find( ( r ) => r.id === id ) : undefined;
		if ( row && ! row.buildable ) return;
		this.chosen = row ? row.id : null;
		this.placement.arm( row?.kind ?? null );

	}

	/** The bar's keys while it is open; true when it took the key. */
	key( e: KeyboardEvent ): boolean {

		if ( ! this.open || e.target === this.search || e.metaKey || e.ctrlKey || e.altKey ) return false;
		if ( /^[1-9]$/.test( e.key ) ) {

			const it = this.items.filter( ( i ) => i.inView )[ Number( e.key ) - 1 ];
			if ( it && it.row.buildable ) this.choose( it.row.id );
			return true;

		}
		if ( e.key === 'ArrowLeft' || e.key === 'ArrowRight' ) {

			this.scrollBy( e.key === 'ArrowLeft' ? - 1 : 1 );
			return true;

		}
		if ( e.key === 'Escape' ) {

			if ( this.query ) this.clearSearch();
			else if ( this.chosen ) this.choose( null );
			else this.setOpen( false );
			return true;

		}
		if ( e.key === '/' ) {

			this.search.focus();
			return true;

		}
		return false;

	}

	/** The building placed: the choice is spent. */
	placed(): void {

		this.chosen = null;

	}

	private scrollBy( d: number ): void {

		const max = Math.max( 0, this.width - this.view );
		this.scroll = Math.min( Math.max( 0, this.scroll + d * SLOT * 3 ), max );

	}

	private readonly onWheel = ( e: WheelEvent ): void => {

		// eslint-disable-next-line ponlai/scene-clock -- the wheel's repeat limit, in the player's time
		const now = performance.now();
		if ( now - this.wheelAt < 120 ) return;
		const d = Math.abs( e.deltaX ) > Math.abs( e.deltaY ) ? e.deltaX : e.deltaY;
		if ( Math.abs( d ) < 4 ) return;
		this.wheelAt = now;
		this.scrollBy( d > 0 ? 1 : - 1 );

	};

	// What tier 2 lists: the chosen group in small groups, the recent ones, or what the search finds.
	private list(): { rows: BuildingRow[]; grouped: boolean } {

		const roster = this.shared.roster, q = this.query.trim().toLocaleLowerCase();
		if ( q ) {

			const groupName = ( id: string ) => BUILD_GROUPS.find( ( g ) => g.id === id )?.name ?? '';
			return { rows: roster.filter( ( r ) => [ r.name, r.use, groupName( r.group ), r.subName, ...r.words ].some( ( w ) => w && w.toLocaleLowerCase().includes( q ) ) ), grouped: false };

		}
		if ( BUILD_GROUPS.find( ( g ) => g.id === this.group )?.recent ) {

			// what the island has had placed, the latest first, one of each
			const kinds: string[] = [];
			const buildings = this.shared.game.sim.state.buildings;
			for ( let i = buildings.length - 1; i >= 0; i -- ) if ( ! kinds.includes( buildings[ i ].kind ) ) kinds.push( buildings[ i ].kind );
			return { rows: kinds.map( ( k ) => roster.find( ( r ) => r.kind === k ) ).filter( ( r ): r is BuildingRow => r !== undefined ), grouped: false };

		}
		return { rows: roster.filter( ( r ) => r.group === this.group ), grouped: true };

	}

	// Lay tier 2 out afresh when what it lists changed: slots, small groups' names and the gaps.
	private build( rows: BuildingRow[], grouped: boolean ): void {

		this.shift.querySelectorAll( '.item, .sub, .gap' ).forEach( ( e ) => e.remove() );
		this.items = [];
		let x = 0, prev: string | null = null, sub: { name: string; from: number; to: number } | null = null;
		const subs: { name: string; from: number; to: number }[] = [];
		for ( const row of rows ) {

			if ( grouped && prev !== null && row.sub !== prev ) {

				const gap = svgEl( 'svg', { class: 'gap pl-sh', width: 6, height: 30, viewBox: '0 0 6 34', preserveAspectRatio: 'none', 'aria-hidden': 'true' }, this.shift );
				svgEl( 'path', { d: upright( 3, 1, 33, 1.8, 0.3 ), fill: 'var(--gao)', 'fill-opacity': 0.3 }, gap );
				css( gap, 'left', `${ x + GAP / 2 - 3 }px` );
				x += GAP;

			}
			if ( grouped && row.sub && row.sub !== prev ) subs.push( sub = { name: row.subName, from: x, to: x + SLOT } );
			else if ( grouped && row.sub && sub ) sub.to = x + SLOT;
			prev = row.sub;
			const button = iconButton( row.name, row.icon, 40, this.shift, () => {

				this.choose( this.chosen === row.id ? null : row.id );

			}, 'item' );
			button.addEventListener( 'pointerenter', () => {

				this.hover = row.id;

			} );
			button.addEventListener( 'pointerleave', () => {

				if ( this.hover === row.id ) this.hover = null;

			} );
			css( button, 'left', `${ x + SLOT / 2 - 26 }px` );
			this.items.push( { row, x: x + SLOT / 2, button, inView: false } );
			x += SLOT;

		}
		for ( const s of subs ) {

			const label = el( 'div', 'sub', this.shift, s.name );
			css( label, 'left', `${ s.from }px` );
			css( label, 'width', `${ s.to - s.from }px` );

		}
		this.width = Math.max( x, SLOT );
		this.view = Math.min( this.width, VIEW );
		this.scroll = Math.min( this.scroll, Math.max( 0, this.width - this.view ) );
		const left = RIGHT - this.view;
		css( this.tier2, 'left', `${ left }px` );
		css( this.tier2, 'width', `${ this.view }px` );
		css( this.clip, 'width', `${ this.view }px` );
		attr( this.line, 'width', String( this.view + 20 ) );
		attr( this.line, 'viewBox', `0 0 ${ this.view + 20 } 12` );
		this.lineInk.set( levelStroke( 1, this.view + 19, 6.2, 3, 0.8, { entry: 0.06, exit: 0.3 } ) );

	}

	update(): void {

		const shared = this.shared;
		// closed, it shows nothing and costs nothing
		if ( ! this.open ) {

			shared.shown = null;
			return;

		}
		const { rows, grouped } = this.list();
		const key = `${ shared.lists }|${ this.query.trim() }|${ this.group }|${ rows.map( ( r ) => r.id ).join() }`;
		if ( key !== this.built ) {

			this.built = key;
			this.build( rows, grouped );

		}
		// the chosen building may have gone from the roster (the debug panel's lists)
		if ( this.chosen && ! shared.roster.some( ( r ) => r.id === this.chosen ) ) this.choose( null );
		const searching = this.query.trim() !== '' || document.activeElement === this.search;
		for ( const g of this.groups ) {

			const current = ! searching && g.id === this.group;
			flag( g.button, 'dim', ! current );
			flag( g.button, 'current', current );
			attr( g.button, 'aria-pressed', String( current ) );

		}
		text( this.groupName, searching ? '' : BUILD_GROUPS.find( ( g ) => g.id === this.group )?.name ?? '' );
		css( this.groupName, 'display', searching ? 'none' : '' );
		flag( this.search, 'open', searching );
		css( this.search, 'width', searching ? `${ Math.max( 40, Array.from( this.query ).length * 20 + 8 ) }px` : '0' );
		css( this.none, 'display', rows.length === 0 ? '' : 'none' );
		text( this.none, this.query.trim() ? t( 'build.notFound' ) : t( 'build.noneRecent' ) );
		const max = Math.max( 0, this.width - this.view );
		css( this.shift, 'transform', `translateX(${ - this.scroll }px)` );
		const fade = `linear-gradient(90deg, ${ this.scroll > 0 ? 'transparent 0, #000 40px' : '#000 0' }, ${ this.scroll < max ? '#000 calc(100% - 40px), transparent 100%' : '#000 100%' })`;
		css( this.clip, 'mask-image', fade );
		css( this.clip, '-webkit-mask-image', fade );
		flag( this.back, 'off', this.scroll <= 0 );
		flag( this.on, 'off', this.scroll >= max );
		for ( const it of this.items ) {

			it.inView = it.x - this.scroll > 6 && it.x - this.scroll < this.view - 6;
			const chosen = it.row.id === this.chosen, locked = ! it.row.buildable;
			flag( it.button, 'chosen', chosen );
			flag( it.button, 'on', chosen );
			flag( it.button, 'locked', locked );
			flag( it.button, 'short', Object.keys( shared.short( it.row ) ).length > 0 );
			attr( it.button, 'aria-disabled', String( locked ) );
			attr( it.button, 'aria-pressed', String( chosen ) );
			attr( it.button, 'tabindex', it.inView ? '0' : '-1' );
			// (a row not yet buildable still tells what it is on hover; choosing refuses it)
			css( it.button, 'pointer-events', it.inView ? 'auto' : 'none' );

		}
		// the detail floats over the building it tells of, kept on screen
		const id = this.hover ?? this.chosen;
		const it = id !== null ? this.items.find( ( i ) => i.row.id === id ) : undefined;
		shared.shown = this.open && it ? it.row : null;
		const visible = this.open && it !== undefined && it.inView;
		css( this.detail, 'opacity', visible ? '1' : '0' );
		if ( ! it ) return;
		const px = Math.min( Math.max( RIGHT - this.view + it.x - this.scroll, 240 ), 1360 );
		css( this.detail, 'left', `${ px - 210 }px` );
		this.describe( it.row );

	}

	// The detail of a building: name, use, its cost (what it lacks in 朱) and hours, or why not yet.
	private describe( row: BuildingRow ): void {

		const shared = this.shared;
		text( this.detailName, row.name );
		text( this.detailUse, row.use );
		const lacks = shared.short( row );
		const costKey = `${ row.id }|${ Object.keys( lacks ).join() }|${ shared.lists }`;
		if ( this.detailCost.dataset.key !== costKey ) {

			this.detailCost.dataset.key = costKey;
			this.detailCost.textContent = '';
			if ( row.buildable ) {

				for ( const id in row.cost ) {

					const res = shared.resources.find( ( r ) => r.id === id );
					const part = el( 'span', '', this.detailCost );
					part.setAttribute( 'aria-label', t( 'build.cost', { name: res?.name ?? id, count: row.cost[ id ] } ) );
					part.appendChild( iconSvg( res?.icon ?? null, 18 ) );
					el( 'span', `pl-num${ Object.hasOwn( lacks, id ) ? ' pl-zhu' : '' }`, part, String( row.cost[ id ] ) );

				}
				const hours = el( 'span', 'hours', this.detailCost );
				el( 'span', 'pl-num', hours, String( row.hours ) );
				el( 'span', '', hours, t( 'build.hours' ) );

			}

		}
		css( this.detailCost, 'display', row.buildable ? '' : 'none' );
		// a building the simulation places says how, or why the spot under the pointer is refused
		const hint = row.id === this.chosen && row.kind && this.placement.armed === row.kind ? this.placement.hint : null;
		text( this.detailNote, ! row.buildable ? t( 'build.locked' ) : hint ? ( hint.refusal !== null ? refusalWords( hint.refusal ) : t( 'build.place' ) ) : '' );
		flag( this.detailNote, 'refused', hint !== null && hint.refusal !== null );

	}

}
