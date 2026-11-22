import type { GraphicsOption, QualityTier } from '../../render/setup.ts';
import { el, flag, under } from '../ui/dom.ts';
import { t } from '../ui/i18n/i18n.ts';
import type { GraphicsControl } from './Front.ts';

// The settings: the 画面 (graphics) page, its preset row and its options.
//
// The settings over the dimmed world (docs/design/ui.md, Settings): the heading 设置 in calligraphy,
// the pages beneath it (画面 alone for now; the column leaves room for sound, controls and language
// without showing empty pages), 返回 at the foot. The page: the preset row (低 中 高 and 自定义, which
// lights by itself once an option differs from every preset), then the options in two groups,
// 显示 and 画质, each a row of exclusive choices (the chosen one 缟 with one 金 stroke beneath, the
// others 苍), a short 苍 line on what it costs, and the mark 重载 on an option that takes a reload.
// A live option applies at once; a reload option is kept and named at the foot with 重新载入, and
// leaving the page with one pending asks first (the game is saved before the reload).
//
// Keys: ↑/↓ move between rows, ←/→ change the row's choice, Enter takes the focused one, Esc goes
// back (closing the question first). The choices and their words are data: the options come from the
// render pipeline's table (GraphicsOptions.ts) through the app's control, their words from the
// catalogue by id (`front.option.<id>.<choice>`).

type Row = { id: string; buttons: Map<string, HTMLButtonElement>; choose( choice: string ): void; current(): string };

export class SettingsPage {

	private readonly screen: HTMLElement;
	private readonly graphics: GraphicsControl;
	private readonly rows: Row[] = [];
	private readonly pending: HTMLElement;
	private readonly confirm: HTMLElement;
	private readonly onClose: () => void;
	private readonly into: () => 'play' | 'title';

	constructor( parent: Element, graphics: GraphicsControl, onClose: () => void, into: () => 'play' | 'title' ) {

		this.graphics = graphics;
		this.onClose = onClose;
		this.into = into;
		const screen = this.screen = el( 'div', 'pl-screen pl-settings', parent );
		screen.setAttribute( 'role', 'dialog' );
		screen.setAttribute( 'aria-label', t( 'front.settings.title' ) );
		el( 'div', 'pl-settings-name pl-title pl-xb', screen, t( 'front.settings.title' ) );
		const pages = el( 'nav', 'pl-settings-pages', screen );
		const page = this.button( t( 'front.settings.graphics' ), pages, () => {} );
		page.classList.add( 'on' );
		page.tabIndex = - 1;
		this.button( t( 'front.settings.back' ), el( 'div', 'pl-settings-back', screen ), () => this.leave() );

		const body = el( 'div', 'pl-settings-body', screen );
		this.addPresetRow( body );
		const groups: Array<[ 'display' | 'quality', string ]> = [ [ 'display', t( 'front.settings.display' ) ], [ 'quality', t( 'front.settings.quality' ) ] ];
		for ( const [ group, name ] of groups ) {

			el( 'div', 'pl-settings-group pl-label', body, name );
			if ( group === 'display' ) this.addDisplayRow( body );
			for ( const option of graphics.options ) if ( option.group === group ) this.addOptionRow( body, option );

		}
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

	/** Opened: every row shows the choice as it stands. */
	open(): void {

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
		const at = this.rows.findIndex( ( r ) => [ ...r.buttons.values() ].includes( document.activeElement as HTMLButtonElement ) );
		if ( e.key === 'ArrowDown' || e.key === 'ArrowUp' ) {

			const next = this.rows[ at < 0 ? 0 : Math.min( Math.max( at + ( e.key === 'ArrowDown' ? 1 : - 1 ), 0 ), this.rows.length - 1 ) ];
			const b = next.buttons.get( next.current() ) ?? [ ...next.buttons.values() ][ 0 ];
			b.focus();
			b.scrollIntoView( { block: 'nearest' } );
			return true;

		}
		if ( ( e.key === 'ArrowLeft' || e.key === 'ArrowRight' ) && at >= 0 ) {

			const row = this.rows[ at ];
			const ids = [ ...row.buttons.keys() ];
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
		const row: Row = { id, buttons, current, choose: ( c ) => {

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
		this.row( body, option.id, say( `front.option.${ option.id }.name` ), say( `front.option.${ option.id }.cost` ), option.applies === 'reload',
			option.choices.map( ( c ) => [ c.id, say( `front.option.${ option.id }.${ c.id }` ) ] as const ), () => g.record.options[ option.id ], ( c ) => g.set( option.id, c ) );

	}

	private refresh(): void {

		for ( const row of this.rows ) {

			const current = row.current();
			for ( const [ choice, b ] of row.buttons ) {

				flag( b, 'on', choice === current );
				flag( b, 'dim', choice !== current );
				b.setAttribute( 'aria-checked', String( choice === current ) );

			}

		}
		// the custom preset is shown, never chosen
		const custom = this.rows[ 0 ]?.buttons.get( 'custom' );
		if ( custom ) custom.disabled = this.graphics.record.preset !== 'custom';
		const pending = this.graphics.pending();
		this.pending.replaceChildren();
		if ( pending.length ) {

			const names = pending.map( ( id ) => t( `front.option.${ id }.name` as 'front.name' ) ).join( t( 'list.and' ) );
			el( 'span', '', this.pending, t( 'front.settings.pending', { list: names } ) );
			this.button( t( 'front.settings.apply' ), this.pending, () => this.ask( true ) );

		}

	}

	private leaving = false;

	private ask( on: boolean, leaving = false ): void {

		this.leaving = on && leaving;
		flag( this.confirm, 'shown', on );
		if ( on ) this.confirm.querySelector<HTMLButtonElement>( '.pl-btn' )?.focus();

	}

	private leave(): void {

		if ( this.graphics.pending().length ) this.ask( true, true );
		else this.onClose();

	}

}
