import type { WeatherName } from '../../sky/Weather.ts';
import type { RecordEntry } from '../Chronicle.ts';
import type { EntityId, Speed } from '../sim/types.ts';
import { cubic, lensFrame, stroke, uprightStroke } from './Brush.ts';
import type { Point } from './Brush.ts';
import { iconSvg, setIcon } from './Icons.ts';
import { PALETTE } from './Palette.ts';
import { LANDINGS, RECORD_KINDS, dayName } from './data/record.ts';
import type { RecordNames } from './data/record.ts';
import { WEATHER_KINDS, weatherKind } from './data/weather.ts';
import type { WeatherKind } from './data/weather.ts';
import { attr, css, el, flag, iconButton, svgEl, text } from './dom.ts';
import { InkPath } from './InkPath.ts';
import { t } from './i18n/i18n.ts';
import type { UiShared } from './Shared.ts';

// 沧海录, the record (docs/ui.md; the design canvas's RecMain and RecPerson): opened by the scroll
// at the top right over the dimmed, stopped world (the game paused while it is open, its speed
// given back on closing); the rest of the interface hides. Esc or × closes it; ←/→ step the days.
// - Left: 蓬莱 (the whole island) pinned on top, then every islander who has landed, scrolling past
//   about seven names (no scrollbar; a fade at an edge only where more names lie beyond).
// - A page: 蓬莱's logs everything; an islander's is their life from landing on, under a large
//   brush figure (the list's person drawn big; no portraits) and their name. Each row: the game
//   time, then words (the speaker, and the line: the player's 精白, an islander's 缟) or a deed.
// - The river of days: one ink drop a day, seven in view, the rest reached by the wheel, the brush
//   arrows (shown only where more lie) or ←/→; days slide in and out; the chosen day is ringed; an
//   islander's river starts at their landing. Over a drop the day's notable happening by its kind's
//   rank (a landing as a boat, a building as the mallet, a critical need in 朱; 蓬莱 groups landings
//   as N人登岛), with +N for more; under it the day's weather, the kind that held longest.
//
// Rules: it reads the game's record (Chronicle.ts) and turns each entry into words by its kind's
// row (data/record.ts), so a new kind never changes this file. It rebuilds only when the record or
// the view changed. The days it knows are the record's (since the game was installed on the page).

const VIS = 7, DAY_STEP = 146;
const RIVER = 'M380 742 C560 728 760 756 960 742 C1160 728 1360 756 1540 742 C1360 760 1160 736 960 750 C760 764 560 736 380 742 Z';
// its frame for the ink: a lens, its upper side out and its lower side back
const chain = ( ...curves: [ Point, Point, Point, Point ][] ) => curves.flatMap( ( c, i ) => cubic( ...c, 64 ).slice( i ? 1 : 0 ) );
const RIVER_FRAME = lensFrame(
	chain( [ { x: 380, y: 742 }, { x: 560, y: 728 }, { x: 760, y: 756 }, { x: 960, y: 742 } ], [ { x: 960, y: 742 }, { x: 1160, y: 728 }, { x: 1360, y: 756 }, { x: 1540, y: 742 } ] ),
	chain( [ { x: 1540, y: 742 }, { x: 1360, y: 760 }, { x: 1160, y: 736 }, { x: 960, y: 750 } ], [ { x: 960, y: 750 }, { x: 760, y: 764 }, { x: 560, y: 736 }, { x: 380, y: 742 } ] ) );
// the wash behind the chosen entry of the list, a lens, and its frame
const WASH = 'M2 26 C40 12 140 10 218 22 C140 40 40 42 2 26 Z';
const WASH_FRAME = lensFrame( cubic( { x: 2, y: 26 }, { x: 40, y: 12 }, { x: 140, y: 10 }, { x: 218, y: 22 }, 48 ), cubic( { x: 218, y: 22 }, { x: 140, y: 40 }, { x: 40, y: 42 }, { x: 2, y: 26 }, 48 ) );
const DROP = 'M0 -9 a9 9 0 1 0 0.01 0 Z';
const RING = 'M0 -16 a16 16 0 1 0 0.01 0 Z M1 -13 a13 13 0 1 0 0.01 0 Z';
// an islander a placeholder entry names but the game has not (the debug panel's placeholder days)
const PLACEHOLDER = '~';

interface DayView { day: number; button: HTMLButtonElement; mark: HTMLElement; markIcon: SVGSVGElement; markText: HTMLElement; wx: HTMLElement; wxIcon: SVGSVGElement; wxName: HTMLElement; drop: SVGPathElement; label: HTMLElement; today: HTMLElement }

export class Record {

	readonly root: HTMLElement;
	private readonly shared: UiShared;
	private readonly onOpen: ( open: boolean ) => void;
	private readonly island: HTMLButtonElement;
	private readonly list: HTMLElement;
	private readonly person: HTMLElement;
	private readonly personName: HTMLElement;
	private readonly log: HTMLElement;
	private readonly dayTitle: HTMLElement;
	private readonly rows: HTMLElement;
	private readonly days: HTMLElement;
	private readonly earlier: HTMLButtonElement;
	private readonly later: HTMLButtonElement;
	private names: { id: string; button: HTMLButtonElement }[] = [];
	private dayViews: DayView[] = [];
	open = false;
	private who: EntityId | 'all' = 'all';
	private day = 1;
	private start = 1;
	private resume: Speed = 1;
	private drawn = '';
	private wheelAt = 0;
	private returnFocus: HTMLElement | null = null;

	constructor( parent: Element, shared: UiShared, onOpen: ( open: boolean ) => void ) {

		this.shared = shared;
		this.onOpen = onOpen;
		const root = this.root = el( 'div', 'pl-record', parent );
		root.setAttribute( 'role', 'dialog' );
		root.setAttribute( 'aria-modal', 'true' );
		root.setAttribute( 'aria-label', t( 'record.title' ) );
		// the dialog itself takes the focus on opening (not its ×, which Space or Enter would press)
		root.tabIndex = - 1;
		el( 'div', 'dim', root );
		const page = el( 'div', 'page', root );
		el( 'h2', 'pl-title pl-xb', page, t( 'record.title' ) );
		iconButton( t( 'record.close' ), 'close', 22, page, () => this.setOpen( false ), 'close' );

		const nav = el( 'nav', '', page );
		nav.setAttribute( 'aria-label', t( 'record.contents' ) );
		this.island = this.entry( nav, t( 'record.island' ), 'island', 'all' );
		this.list = el( 'div', 'list', nav );
		this.list.addEventListener( 'scroll', this.fadeList );
		const rule = svgEl( 'svg', { class: 'rule', width: 8, height: 500, viewBox: '0 0 8 500', 'aria-hidden': 'true' }, page );
		new InkPath( rule, { colour: PALETTE.gao, opacity: 0.3 }, 31 ).set( uprightStroke( 4, 1, 499, 3, 0.8, { entry: 0.08, exit: 0.3 } ) );

		this.person = el( 'div', 'person', page );
		this.person.appendChild( iconSvg( 'figure', 150, 'pl-sh' ) ).setAttribute( 'height', '180' );
		this.personName = el( 'div', 'name pl-title pl-xb', this.person );
		this.log = el( 'section', 'log', page );
		const head = el( 'div', 'day', this.log );
		this.dayTitle = el( 'span', 'pl-title pl-xb', head );
		const line = svgEl( 'svg', { width: 420, height: 8, viewBox: '0 0 420 8', 'aria-hidden': 'true' }, head );
		new InkPath( line, { colour: PALETTE.gao, gradient: { x1: 0, x2: 420, stops: [ [ 0, 0.7 ], [ 1, 0 ] ] } }, 32 )
			.set( stroke( cubic( { x: 1, y: 4.6 }, { x: 120, y: 3 }, { x: 300, y: 3.2 }, { x: 419, y: 4 } ), 2.2, { entry: 0.05, exit: 0.6 } ) );
		this.rows = el( 'div', 'rows', this.log );
		this.rows.setAttribute( 'aria-live', 'polite' );

		const river = el( 'div', 'river', page );
		river.addEventListener( 'wheel', this.onWheel, { passive: true } );
		const strokes = svgEl( 'svg', { class: 'pl-sh', width: 1160, height: 300, viewBox: '380 600 1160 300', 'aria-hidden': 'true' }, river );
		new InkPath( strokes, { colour: PALETTE.gao, gradient: { x1: 380, x2: 1540, stops: [ [ 0, 0 ], [ 0.08, 0.85 ], [ 0.92, 0.85 ], [ 1, 0 ] ] } }, 33 ).set( { d: RIVER, frame: RIVER_FRAME } );
		this.days = el( 'div', 'days', river );
		this.earlier = iconButton( t( 'record.earlier' ), 'chevron', 40, river, () => this.shift( - 1 ), 'arrow' );
		css( this.earlier, 'left', '12px' );
		this.later = iconButton( t( 'record.later' ), 'chevron', 40, river, () => this.shift( 1 ), 'arrow' );
		css( this.later, 'left', '1088px' );
		this.later.querySelector( 'svg' )!.style.transform = 'scaleX(-1)';

	}

	// An entry of the list: 蓬莱, or an islander.
	private entry( parent: Element, name: string, icon: string, who: EntityId | 'all' ): HTMLButtonElement {

		const b = el( 'button', 'pl-btn', parent );
		b.type = 'button';
		const wash = svgEl( 'svg', { class: 'wash', width: 220, height: 52, viewBox: '0 0 220 52', 'aria-hidden': 'true' }, b );
		new InkPath( wash, { colour: PALETTE.gao, gradient: { x1: 0, x2: 220, stops: [ [ 0, 0.18 ], [ 1, 0 ] ] } }, 34 ).set( { d: WASH, frame: WASH_FRAME } );
		b.appendChild( iconSvg( icon, 28 ) );
		el( 'span', '', b, name );
		b.addEventListener( 'click', ( e ) => {

			this.show( who, this.today(), this.today() );
			if ( e.detail > 0 ) b.blur();

		} );
		return b;

	}

	/** Open or close the record: the world stops while it is open. */
	setOpen( open: boolean ): void {

		if ( this.open === open ) return;
		this.open = open;
		const game = this.shared.game;
		flag( this.root, 'open', open );
		if ( open ) {

			this.resume = game.sim.speed;
			if ( game.sim.speed !== 0 ) game.setSpeed( 0 );
			// the focus goes back on closing only to where the keyboard had it: a button the pointer
			// pressed keeps no focus, so Space stays the game's pause
			const before = document.activeElement;
			this.returnFocus = before instanceof HTMLElement && before !== document.body && before.matches( ':focus-visible' ) ? before : null;
			this.show( 'all', this.today(), this.today() );
			this.root.focus( { preventScroll: true } );

			this.onOpen( open );

		} else {

			if ( game.sim.speed === 0 && this.resume !== 0 ) game.setSpeed( this.resume );
			// the interface shows again first: a hidden element cannot take the focus back
			this.onOpen( open );
			if ( this.returnFocus ) this.returnFocus.focus( { preventScroll: true } );
			else if ( this.root.contains( document.activeElement ) ) ( document.activeElement as HTMLElement ).blur();
			this.returnFocus = null;

		}

	}

	/** A new simulation: the record closes. */
	reset(): void {

		this.setOpen( false );
		this.drawn = '';

	}

	/** The record's own keys while it is open (Esc, ←/→); true when it took the key. */
	key( e: KeyboardEvent ): boolean {

		if ( ! this.open ) return false;
		if ( e.key === 'Escape' ) this.setOpen( false );
		else if ( e.key === 'ArrowLeft' || e.key === 'ArrowRight' ) this.step( e.key === 'ArrowLeft' ? - 1 : 1 );
		else return false;
		return true;

	}

	private today(): number {

		return this.shared.game.sim.day() + 1;

	}

	// the days a page's river runs over: from the island's first, or the islander's landing, to today
	// (or the last day the record names: the debug panel's placeholder days may run past it)
	private range( who: EntityId | 'all' ): [ number, number ] {

		const record = this.shared.game.record;
		const last = record.entries.reduce( ( d, e ) => Math.max( d, e.day ), this.today() );
		const landed = who === 'all' ? 1 : record.landed.get( who ) ?? 1;
		return [ Math.min( landed, last ), last ];

	}

	// Show a page and a day, the river keeping that day in view.
	private show( who: EntityId | 'all', day: number, start: number ): void {

		const [ lo, hi ] = this.range( who );
		this.who = who;
		this.day = Math.max( lo, Math.min( hi, day ) );
		let s = Math.max( lo, Math.min( start, hi - VIS + 1 ) );
		if ( this.day < s ) s = this.day;
		if ( this.day > s + VIS - 1 ) s = this.day - VIS + 1;
		this.start = Math.max( lo, s );

	}

	private step( delta: number ): void {

		this.show( this.who, this.day + delta, this.start );

	}

	private shift( delta: number ): void {

		const [ lo, hi ] = this.range( this.who );
		this.start = Math.max( lo, Math.min( Math.max( lo, hi - VIS + 1 ), this.start + delta ) );

	}

	private readonly onWheel = ( e: WheelEvent ): void => {

		const now = performance.now();
		if ( now - this.wheelAt < 140 ) return;
		const d = Math.abs( e.deltaX ) > Math.abs( e.deltaY ) ? e.deltaX : e.deltaY;
		if ( Math.abs( d ) < 4 ) return;
		this.wheelAt = now;
		this.shift( d > 0 ? 1 : - 1 );

	};

	// the list fades at an edge only where more names lie beyond it
	private readonly fadeList = (): void => {

		const l = this.list, top = l.scrollTop > 2, bottom = l.scrollTop + l.clientHeight < l.scrollHeight - 2;
		const g = `linear-gradient(180deg, ${ top ? 'transparent 0, #000 16%' : '#000 0' }, ${ bottom ? '#000 84%, transparent 100%' : '#000 100%' })`;
		css( this.list, 'mask-image', g );
		css( this.list, '-webkit-mask-image', g );

	};

	private readonly naming: RecordNames = {
		person: ( id: string ) => id.startsWith( PLACEHOLDER ) ? id.slice( PLACEHOLDER.length ) : this.shared.personName( id ),
		building: ( kind: string ) => this.shared.buildingName( kind ),
	};

	update(): void {

		if ( ! this.open ) return;
		const record = this.shared.game.record, today = this.today();
		const key = `${ record.version }|${ this.who }|${ this.day }|${ this.start }|${ today }|${ this.shared.game.sim.state.villagers.length }`;
		if ( key === this.drawn ) return;
		this.drawn = key;
		this.drawList();
		this.drawPage();
		this.drawRiver();

	}

	// everyone who has landed: the game's islanders, then those only the record names
	private people(): string[] {

		const ids = this.shared.game.sim.state.villagers.map( ( v ) => v.id );
		for ( const id of this.shared.game.record.landed.keys() ) if ( ! ids.includes( id ) ) ids.push( id );
		return ids;

	}

	private drawList(): void {

		const ids = this.people();
		if ( ids.join() !== this.names.map( ( n ) => n.id ).join() ) {

			this.list.textContent = '';
			this.names = ids.map( ( id ) => ( { id, button: this.entry( this.list, this.naming.person( id ), 'person', id ) } ) );
			this.fadeList();

		}
		flag( this.island, 'current', this.who === 'all' );
		attr( this.island, 'aria-current', String( this.who === 'all' ) );
		for ( const n of this.names ) {

			flag( n.button, 'current', n.id === this.who );
			attr( n.button, 'aria-current', String( n.id === this.who ) );

		}

	}

	// what a page holds: everything for 蓬莱; for an islander, their own entries, words to them or to
	// everyone, and the island's deeds, from their landing on
	private mine( e: RecordEntry ): boolean {

		const who = this.who;
		if ( who === 'all' ) return true;
		if ( e.who === who || ( Array.isArray( e.to ) && e.to.includes( who ) ) ) return true;
		return ( e.to === 'all' || e.who === 'island' ) && e.day >= this.range( who )[ 0 ];

	}

	private drawPage(): void {

		const own = this.who !== 'all';
		css( this.person, 'display', own ? '' : 'none' );
		text( this.personName, own ? this.naming.person( this.who ) : '' );
		css( this.log, 'left', own ? '640px' : '380px' );
		css( this.log, 'width', own ? '760px' : '780px' );
		text( this.dayTitle, dayName( this.day ) );
		const box = el( 'div', '' );
		const entries = this.shared.game.record.entries.filter( ( e ) => e.day === this.day && this.mine( e ) ).sort( ( a, b ) => a.minute - b.minute );
		for ( const e of entries ) {

			const kind = RECORD_KINDS[ e.kind ];
			if ( ! kind ) continue;
			const row = el( 'div', 'entry', box );
			el( 'span', 't pl-num', row, `${ String( Math.floor( e.minute / 60 ) ).padStart( 2, '0' ) }:${ String( e.minute % 60 ).padStart( 2, '0' ) }` );
			if ( kind.words ) {

				const to = e.to === 'all' ? t( 'record.toAll' ) : Array.isArray( e.to ) ? t( 'record.toSome', { names: e.to.map( this.naming.person ).join( t( 'list.and' ) ) } ) : '';
				el( 'span', 'who', row, e.who === 'player' ? t( 'record.you', { to } ) : this.naming.person( e.who ) );
				el( 'span', `say${ e.who === 'player' ? ' player' : '' }`, row, kind.deed( e, this.naming, false ) );

			} else el( 'span', 'deed', row, kind.deed( e, this.naming, own && e.who === this.who ) );

		}
		if ( entries.length === 0 ) el( 'div', 'empty', box, t( 'record.empty' ) );
		this.rows.textContent = '';
		this.rows.appendChild( box );

	}

	// The day's notable happening on this page: the most notable kind's mark, and how many more.
	private notable( day: number ): { icon: string; text: string; alarm: boolean } | null {

		const marks = this.shared.game.record.entries.filter( ( e ) => e.day === day && this.mine( e ) && RECORD_KINDS[ e.kind ]?.mark && ( e.kind !== 'landed' || this.who === 'all' || e.who === this.who ) )
			.sort( ( a, b ) => RECORD_KINDS[ a.kind ].rank - RECORD_KINDS[ b.kind ].rank );
		const top = marks[ 0 ];
		if ( ! top ) return null;
		const kind = RECORD_KINDS[ top.kind ], own = this.who !== 'all';
		const landings = top.kind === 'landed' && ! own ? marks.filter( ( e ) => e.kind === 'landed' ).length : 1;
		const words = top.kind === 'landed' && ! own && landings > 1 ? LANDINGS( landings ) : kind.deed( top, this.naming, own && top.who === this.who );
		const more = marks.length - landings;
		return { icon: kind.mark!.icon( top ), text: more > 0 ? t( 'record.more', { mark: words, count: more } ) : words, alarm: kind.mark!.alarm === true };

	}

	// The day's weather: the kind that held longest while the record watched (today, before any
	// time has passed, the sky now).
	private dayWeather( day: number ): WeatherKind | null {

		const game = this.shared.game, skies = game.record.skies.get( day );
		if ( ! skies ) return day === this.today() ? weatherKind( game.weatherNow().shown ) : null;
		const hours = new Map<WeatherKind, number>();
		for ( const [ sky, h ] of skies ) hours.set( weatherKind( sky as WeatherName ), ( hours.get( weatherKind( sky as WeatherName ) ) ?? 0 ) + h );
		let best: WeatherKind | null = null, most = 0;
		for ( const kind of WEATHER_KINDS ) {

			const h = hours.get( kind ) ?? 0;
			if ( h > most ) {

				most = h;
				best = kind;

			}

		}
		return best;

	}

	private drawRiver(): void {

		const [ lo, hi ] = this.range( this.who ), today = this.today();
		// a drop for every day so far, built as the days come
		while ( this.dayViews.length < hi ) this.dayViews.push( this.dayView( this.dayViews.length + 1 ) );
		for ( const v of this.dayViews ) {

			const d = v.day, slot = d - this.start, shown = d >= lo && d <= hi && slot >= 0 && slot < VIS;
			css( v.button, 'left', `${ 80 + Math.max( - 1, Math.min( VIS, slot ) ) * DAY_STEP }px` );
			css( v.button, 'opacity', shown ? '1' : '0' );
			css( v.button, 'pointer-events', shown ? 'auto' : 'none' );
			v.button.tabIndex = shown ? 0 : - 1;
			flag( v.button, 'current', d === this.day );
			attr( v.button, 'aria-current', String( d === this.day ) );
			attr( v.drop, 'd', d === this.day ? RING : DROP );
			const mark = this.notable( d ), wx = this.dayWeather( d );
			css( v.mark, 'visibility', mark ? '' : 'hidden' );
			flag( v.mark, 'alarm', mark?.alarm === true );
			if ( mark ) setIcon( v.markIcon, mark.icon );
			text( v.markText, mark?.text ?? '' );
			css( v.wx, 'visibility', wx ? '' : 'hidden' );
			if ( wx ) setIcon( v.wxIcon, wx.icon );
			text( v.wxName, wx?.name ?? '' );
			css( v.today, 'display', d === today ? '' : 'none' );
			const said = [ dayName( d ), d === today ? t( 'record.today' ) : '', wx?.name ?? '', mark?.text ?? '' ];
			attr( v.button, 'aria-label', said.filter( Boolean ).join( t( 'list.then' ) ) );

		}
		flag( this.earlier, 'off', this.start <= lo );
		flag( this.later, 'off', this.start + VIS - 1 >= hi );

	}

	private dayView( day: number ): DayView {

		const button = el( 'button', 'pl-btn rday', this.days );
		button.type = 'button';
		button.addEventListener( 'click', ( e ) => {

			this.show( this.who, day, this.start );
			if ( e.detail > 0 ) button.blur();

		} );
		const mark = el( 'div', 'mark', button );
		const markIcon = mark.appendChild( iconSvg( 'boat', 18 ) );
		const markText = el( 'span', '', mark );
		const wx = el( 'div', 'wx pl-sh', button );
		const wxIcon = wx.appendChild( iconSvg( 'sun', 18 ) );
		const wxName = el( 'span', '', wx );
		const dropSvg = svgEl( 'svg', { class: 'drop pl-sh', width: 40, height: 40, viewBox: '-20 -20 40 40', 'aria-hidden': 'true' }, button );
		const drop = svgEl( 'path', { d: DROP, fill: PALETTE.gao, 'fill-rule': 'evenodd' }, dropSvg );
		svgEl( 'circle', { cx: 0, cy: 0, r: 6, fill: PALETTE.gao, class: 'core' }, dropSvg );
		const label = el( 'div', 'label', button );
		el( 'div', 'pl-title', label, dayName( day ) );
		const today = el( 'div', 'today', label, t( 'record.today' ) );
		return { day, button, mark, markIcon, markText, wx, wxIcon, wxName, drop, label, today };

	}

}
