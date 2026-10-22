import { iconSvg } from './Icons.ts';
import { RESOURCE_GROUPS, ROW_MAX } from './data/resources.ts';
import type { ResourceRow as Row } from './data/resources.ts';
import { attr, el, flag, text } from './dom.ts';
import type { UiShared } from './Shared.ts';

// The island's resources at the top right (docs/ui.md, Resources): always in view, one icon and one
// tabular number per kind, in groups (materials, food, water) with space between them. They count
// what the stores hold (UiShared.stock). While the build bar shows a building, each count its cost
// lacks turns 朱, here as in the bar. With more than ROW_MAX kinds a group keeps its common kinds
// and merges the rest into one 苍 mark (+ how many), which opens the group on hover or focus; the
// mark turns 朱 when a kind it holds is short.
//
// Rules: it is drawn from the rows (data/resources.ts), rebuilt only when the list changes
// (UiShared.lists); each frame writes only the numbers and colours that changed.

interface Cell { row: Row; box: HTMLElement; num: HTMLElement }
interface Group { more: HTMLElement | null; hidden: Cell[] }

export class ResourceRow {

	readonly root: HTMLElement;
	private readonly shared: UiShared;
	private cells: Cell[] = [];
	private groups: Group[] = [];
	private built = - 1;

	constructor( parent: Element, shared: UiShared ) {

		this.shared = shared;
		this.root = el( 'div', 'pl-stock pl-sh', parent );
		this.root.setAttribute( 'role', 'img' );

	}

	private build(): void {

		const rows = this.shared.resources, merge = rows.length > ROW_MAX;
		this.root.textContent = '';
		this.cells = [];
		this.groups = [];
		for ( const g of RESOURCE_GROUPS ) {

			const members = rows.filter( ( r ) => r.group === g.id );
			if ( members.length === 0 ) continue;
			const box = el( 'div', 'pl-stock-group', this.root );
			const group: Group = { more: null, hidden: [] };
			for ( const row of members ) {

				const cell = el( 'div', 'pl-res', box );
				cell.appendChild( iconSvg( row.icon, 22 ) );
				const c = { row, box: cell, num: el( 'span', 'pl-num', cell ) };
				this.cells.push( c );
				if ( merge && ! row.common ) {

					cell.classList.add( 'extra' );
					group.hidden.push( c );

				}

			}
			if ( group.hidden.length > 0 ) {

				// the merged mark: how many kinds the group keeps out of view; focusable, so the
				// keyboard opens the group as the pointer does
				group.more = el( 'span', 'pl-more pl-num', box, `+${ group.hidden.length }` );
				group.more.tabIndex = 0;
				group.more.setAttribute( 'aria-label', `另有${ group.hidden.map( ( c ) => c.row.name ).join( '、' ) }` );

			}
			this.groups.push( group );

		}
		this.built = this.shared.lists;

	}

	update(): void {

		const shared = this.shared;
		if ( this.built !== shared.lists ) this.build();
		const lacks = shared.shown ? shared.short( shared.shown ) : {};
		const parts: string[] = [];
		for ( const c of this.cells ) {

			const n = shared.stock[ c.row.id ] ?? 0;
			text( c.num, String( n ) );
			flag( c.box, 'short', Object.hasOwn( lacks, c.row.id ) );
			parts.push( `${ c.row.name }${ n }` );

		}
		for ( const g of this.groups ) if ( g.more ) flag( g.more, 'short', g.hidden.some( ( c ) => Object.hasOwn( lacks, c.row.id ) ) );
		attr( this.root, 'aria-label', `现有：${ parts.join( '，' ) }` );

	}

}
