import type { GraphicsOption, QualityTier } from '../../render/setup.ts';
import { el, flag, under } from '../ui/dom.ts';
import { locale, t } from '../ui/i18n/i18n.ts';
import type { GraphicsControl, LanguageControl } from './Front.ts';

// The settings: the 画面 (graphics) page, its preset row and its options, and the 语言 (language) page.
//
// The settings over the dimmed world (docs/design/ui.md, Settings): the heading 设置 in calligraphy,
// the pages beneath it (画面 and 语言; the column leaves room for sound and controls without
// showing empty pages), 返回 at the foot. The 画面 page: the preset row (低 中 高 and 自定义, which
// lights by itself once an option differs from every preset), then the options in two groups,
// 显示 and 画质, each a row of exclusive choices (the chosen one 缟 with one 金 stroke beneath, the
// others 苍), a short 苍 line on what it costs, and the mark 重载 on an option that takes a reload.
// A live option applies at once; a reload option is kept and named at the foot with 重新载入, and
// leaving the page with one pending asks first (the game is saved before the reload).
//
// The resolution's choices are named by their size in pixels as the output stands (its height, the
// width the view's aspect: 1920 × 1080), and only those below the output's own height are offered,
// with 原生 (native) naming the output's size; a stored height the output no longer exceeds shows
// as native, which is what it renders. The 语言 page: 自动 (the system's or the browser's language)
// and each language by its own name, a reload option (the words are taken as the page loads).
//
// Keys: ↑/↓ move between rows (the pages' column is the first row), ←/→ change the row's choice, Enter takes the focused one, Esc goes
// back (closing the question first). The choices and their words are data: the options come from the
// render pipeline's table (GraphicsOptions.ts) through the app's control, their words from the
// catalogue by id (`front.option.<id>.<choice>`).

type Page = 'graphics' | 'language';
type Row = { id: string; page: Page | null; buttons: Map<string, HTMLButtonElement>; choose( choice: string ): void; current(): string };

export class SettingsPage {

	private readonly screen: HTMLElement;
	private readonly graphics: GraphicsControl;
	private readonly language: LanguageControl;
	private readonly rows: Row[] = [];
	private readonly bodies = new Map<Page, HTMLElement>();
	private page: Page = 'graphics';
	// the page the rows being built belong to
	private building: Page | null = null;
	private readonly pending: HTMLElement;
	private readonly confirm: HTMLElement;
	private readonly onClose: () => void;
	private readonly into: () => 'play' | 'title';

	constructor( parent: Element, graphics: GraphicsControl, language: LanguageControl, onClose: () => void, into: () => 'play' | 'title' ) {

		this.graphics = graphics;
		this.language = language;
		this.onClose = onClose;
		this.into = into;
		const screen = this.screen = el( 'div', 'pl-screen pl-settings', parent );
		screen.setAttribute( 'role', 'dialog' );
		screen.setAttribute( 'aria-label', t( 'front.settings.title' ) );
		el( 'div', 'pl-settings-name pl-title pl-xb', screen, t( 'front.settings.title' ) );
		const pages = el( 'nav', 'pl-settings-pages', screen );
		const pageButtons = new Map<string, HTMLButtonElement>();
		const pageRow: Row = { id: 'page', page: null, buttons: pageButtons, current: () => this.page, choose: ( c ) => {

			this.page = c as Page;
			this.refresh();

		} };
		for ( const [ id, words ] of [ [ 'graphics', t( 'front.settings.graphics' ) ], [ 'language', t( 'front.settings.language' ) ] ] as const ) {

			pageButtons.set( id, this.button( words, pages, () => pageRow.choose( id ) ) );

		}
		this.rows.push( pageRow );
		this.button( t( 'front.settings.back' ), el( 'div', 'pl-settings-back', screen ), () => this.leave() );

		const body = el( 'div', 'pl-settings-body', screen );
		this.bodies.set( 'graphics', body );
		this.building = 'graphics';
		this.addPresetRow( body );
		const groups: Array<[ 'display' | 'quality', string ]> = [ [ 'display', t( 'front.settings.display' ) ], [ 'quality', t( 'front.settings.quality' ) ] ];
		for ( const [ group, name ] of groups ) {

			el( 'div', 'pl-settings-group pl-label', body, name );
			if ( group === 'display' ) this.addDisplayRow( body );
			for ( const option of graphics.options ) if ( option.group === group ) this.addOptionRow( body, option );

		}
		const words = el( 'div', 'pl-settings-body', screen );
		this.bodies.set( 'language', words );
		this.building = 'language';
		this.addLanguageRow( words );
		this.building = null;
		this.pending = el( 'div', 'pl-settings-pending', screen );
		this.confirm = el( 'div', 'pl-confirm', screen );
		const box = el( 'div', 'pl-confirm-box', this.confirm );
		el( 'div', '', box, t( 'front.settings.confirm' ) );
		const answers = el( 'div', 'pl-confirm-row', box );
		this.button( t( 'front.settings.yes' ), answers, () => this.graphics.reload( this.into() ) );
		// later: the choice is kept and applies at the next load; leaving goes on
		this.button( t( 'front.settings.no' ), answers, () => {

			const leaving = this.leaving;
			this.ask( false );
			if ( leaving ) this.onClose();

		} );

	}

	set shown( on: boolean ) {

		flag( this.screen, 'shown', on );
		if ( ! on ) this.ask( false );

	}

	/** Opened on the 画面 page: every row shows the choice as it stands. */
	open(): void {

		this.page = 'graphics';
		this.refresh();
		this.rows[ 0 ]?.buttons.get( this.rows[ 0 ].current() )?.focus( { preventScroll: true } );

	}

	/** A key while the page is up; true when it took it. */
	key( e: KeyboardEvent ): boolean {

		if ( this.confirm.classList.contains( 'shown' ) ) {

			if ( e.key === 'Escape' ) this.ask( false );
			return e.key === 'Escape';

		}
		if ( e.key === 'Escape' ) {

			this.leave();
			return true;

		}
		// the pages' column and the shown page's rows
		const rows = this.rows.filter( ( r ) => r.page === null || r.page === this.page );
		const at = rows.findIndex( ( r ) => [ ...r.buttons.values() ].includes( document.activeElement as HTMLButtonElement ) );
		if ( e.key === 'ArrowDown' || e.key === 'ArrowUp' ) {

			const next = rows[ at < 0 ? 0 : Math.min( Math.max( at + ( e.key === 'ArrowDown' ? 1 : - 1 ), 0 ), rows.length - 1 ) ];
			const b = next.buttons.get( next.current() ) ?? [ ...next.buttons.values() ][ 0 ];
			b.focus();
			b.scrollIntoView( { block: 'nearest' } );
			return true;

		}
		if ( ( e.key === 'ArrowLeft' || e.key === 'ArrowRight' ) && at >= 0 ) {

			const row = rows[ at ];
			const ids = [ ...row.buttons.keys() ].filter( ( id ) => ! row.buttons.get( id )!.hidden );
			const i = ids.indexOf( row.current() );
			const next = ids[ Math.min( Math.max( i + ( e.key === 'ArrowRight' ? 1 : - 1 ), 0 ), ids.length - 1 ) ];
			row.choose( next );
			row.buttons.get( row.current() )?.focus();
			return true;

		}
		return false;

	}

	private button( label: string, parent: Element, onClick: () => void ): HTMLButtonElement {

		const b = el( 'button', 'pl-btn text', parent );
		b.type = 'button';
		el( 'span', 'pl-face', b, label );
		under( b );
		b.addEventListener( 'click', ( e ) => {

			onClick();
			if ( e.detail > 0 ) b.blur();

		} );
		return b;

	}

	private row( body: Element, id: string, label: string, cost: string, reload: boolean, choices: ReadonlyArray<readonly [ string, string ]>, current: () => string, choose: ( choice: string ) => void, className = '' ): void {

		const line = el( 'div', `pl-set-row ${ className }`.trim(), body );
		const name = el( 'div', 'pl-set-label', line, label );
		if ( reload ) el( 'span', 'mark', name, t( 'front.settings.reload' ) );
		const list = el( 'div', 'pl-set-choices', line );
		list.setAttribute( 'role', 'radiogroup' );
		list.setAttribute( 'aria-label', label );
		const buttons = new Map<string, HTMLButtonElement>();
		const row: Row = { id, page: this.building, buttons, current, choose: ( c ) => {

			choose( c );
			this.refresh();

		} };
		for ( const [ choice, words ] of choices ) {

			const b = this.button( words, list, () => row.choose( choice ) );
			b.setAttribute( 'role', 'radio' );
			buttons.set( choice, b );

		}
		if ( cost ) el( 'div', 'pl-set-cost', line, cost );
		this.rows.push( row );

	}

	private addPresetRow( body: Element ): void {

		const tiers: QualityTier[] = [ 'low', 'medium', 'high' ];
		const choices = [ ...tiers, 'custom' ].map( ( p ) => [ p, t( `front.preset.${ p as QualityTier | 'custom' }` ) ] as const );
		this.row( body, 'preset', t( 'front.settings.preset' ), '', false, choices, () => this.graphics.record.preset, ( c ) => {

			if ( c !== 'custom' ) this.graphics.setPreset( c as QualityTier );

		}, 'preset' );

	}

	private addDisplayRow( body: Element ): void {

		const g = this.graphics;
		const words = ( c: 'full' | 'window' ) => t( `front.option.display.${ c }` );
		this.row( body, 'display', t( 'front.option.display.name' ), t( 'front.option.display.cost' ), false, [ [ 'full', words( 'full' ) ], [ 'window', words( 'window' ) ] ], () => g.fullscreen() ? 'full' : 'window', ( c ) => g.setFullscreen( c === 'full' ) );

	}

	private addOptionRow( body: Element, option: GraphicsOption ): void {

		const g = this.graphics;
		// (the catalogue's keys are typed: an option or choice without words fails the type check there)
		const say = ( key: string ) => t( key as 'front.name' );
		// the resolution's sizes are named as the output stands (`sizes`)
		const words = ( id: string ) => option.id === 'resolution' && id !== 'auto' ? '' : say( `front.option.${ option.id }.${ id }` );
		const current = option.id === 'resolution' ? () => this.shownHeight( g.record.options.resolution ) : () => g.record.options[ option.id ];
		this.row( body, option.id, say( `front.option.${ option.id }.name` ), say( `front.option.${ option.id }.cost` ), option.applies === 'reload',
			option.choices.map( ( c ) => [ c.id, words( c.id ) ] as const ), current, ( c ) => g.set( option.id, c ) );

	}

	private addLanguageRow( body: Element ): void {

		const l = this.language;
		// (a language is named in its own words, the same in every catalogue)
		const words = ( c: string ) => t( `front.option.lang.${ c }` as 'front.name' );
		this.row( body, 'lang', t( 'front.option.lang.name' ), t( 'front.option.lang.cost' ), true, l.choices.map( ( c ) => [ c, words( c ) ] as const ), () => l.choice, ( c ) => l.set( c ) );

	}

	// the resolution's height of a choice (0 for auto, -1 for native)
	private rowsOf( choice: string ): number {

		const option = this.graphics.options.find( ( o ) => o.id === 'resolution' );
		return Number( option?.choices.find( ( c ) => c.id === choice )?.values[ 'render.dynamic.rows' ] ?? 0 );

	}

	// a stored height the output no longer exceeds renders natively, and shows so
	private shownHeight( choice: string ): string {

		const rows = this.rowsOf( choice );
		return rows > 0 && rows >= this.graphics.output().height ? 'native' : choice;

	}

	// the resolution's choices named and offered as the output stands
	private sizes(): void {

		const row = this.rows.find( ( r ) => r.id === 'resolution' );
		if ( ! row ) return;
		const { width, height } = this.graphics.output();
		const aspect = width / Math.max( height, 1 );
		for ( const [ choice, b ] of row.buttons ) {

			const rows = this.rowsOf( choice );
			if ( rows === 0 ) continue;
			b.hidden = rows > 0 && rows >= height;
			const face = b.querySelector( '.pl-face' );
			if ( face ) face.textContent = rows > 0
				? t( 'front.option.resolution.size', { width: Math.round( rows * aspect ), height: rows } )
				: t( 'front.option.resolution.native', { width, height } );

		}

	}

	private refresh(): void {

		for ( const [ page, body ] of this.bodies ) body.hidden = page !== this.page;
		this.sizes();
		for ( const row of this.rows ) {

			const current = row.current();
			for ( const [ choice, b ] of row.buttons ) {

				flag( b, 'on', choice === current );
				flag( b, 'dim', choice !== current );
				b.setAttribute( 'aria-checked', String( choice === current ) );

			}

		}
		// an option another one turns off reads as off and takes no choice (the ambient occlusion reads
		// the meadow shadows' prepass, and neither is built under a temporal anti-aliasing)
		const o = this.graphics.record.options;
		const temporal = o.aa !== 'msaa';
		this.inactive( 'meadowShadows', temporal );
		this.inactive( 'ao', temporal || o.meadowShadows === 'off' );
		// the custom preset is shown, never chosen
		const custom = this.rows[ 0 ]?.buttons.get( 'custom' );
		if ( custom ) custom.disabled = this.graphics.record.preset !== 'custom';
		const pending = this.pendingNames();
		this.pending.replaceChildren();
		if ( pending.length ) {

			const names = pending.map( ( id ) => id === 'preset' ? t( 'front.settings.preset' ) : t( `front.option.${ id }.name` as 'front.name' ) ).join( t( 'list.and' ) );
			el( 'span', '', this.pending, t( 'front.settings.pending', { list: names } ) );
			this.button( t( 'front.settings.apply' ), this.pending, () => this.ask( true ) );

		}

	}

	// the reload options changed since this load: the graphics' and the language's
	private pendingNames(): string[] {

		const language = this.language.resolve( this.language.choice ) !== locale ? [ 'lang' ] : [];
		return this.graphics.pending().concat( language );

	}

	private leaving = false;

	private inactive( id: string, off: boolean ): void {

		const row = this.rows.find( ( r ) => r.id === id );
		if ( ! row ) return;
		for ( const [ choice, b ] of row.buttons ) {

			b.disabled = off;
			if ( off ) {

				flag( b, 'on', choice === 'off' );
				flag( b, 'dim', choice !== 'off' );

			}

		}

	}

	private ask( on: boolean, leaving = false ): void {

		this.leaving = on && leaving;
		flag( this.confirm, 'shown', on );
		if ( on ) this.confirm.querySelector<HTMLButtonElement>( '.pl-btn' )?.focus();

	}

	private leave(): void {

		if ( this.pendingNames().length ) this.ask( true, true );
		else this.onClose();

	}

}
