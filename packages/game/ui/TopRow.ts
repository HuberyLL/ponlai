import { uprightStroke } from './Brush.ts';
import { dayName } from './data/record.ts';
import { attr, el, flag, iconButton, svgEl, text } from './dom.ts';
import { InkPath } from './InkPath.ts';
import { PALETTE } from './Palette.ts';
import { Forecast } from './Forecast.ts';
import { t } from './i18n/i18n.ts';
import { ResourceRow } from './ResourceRow.ts';
import type { UiShared } from './Shared.ts';

// The top row: the day and time, pause and play, the weather, the resources and the record.
//
// The top row (docs/explanation/ui.md, Top row): at the left the day in calligraphy and the time in the brush
// numerals (08:00, the game's clock: telling time in 时辰 is not decided), pause and play (the
// game runs at one speed; the current one 缟, the other 苍) and the weather with its forecast (Forecast.ts); at the
// right the island's resources (ResourceRow.ts) and the record's scroll (沧海录), split by brush
// strokes. They act through Game.setPaused, the scroll opens the record (Record.ts).

const CLOCK: readonly { paused: boolean; label: string; icon: string }[] = [
	{ paused: true, label: t( 'top.pause' ), icon: 'pause' },
	{ paused: false, label: t( 'top.play' ), icon: 'play' },
];
// each icon's size
const ICON_SIZE: Readonly<Record<string, [ number, number ]>> = { pause: [ 12, 14 ], play: [ 12, 14 ] };

const DIVIDER = uprightStroke( 3, 1, 39, 2.4, 0.6 );

// A divider of the row: an upright inked stroke (InkPath.ts), each its own seed.
function divider( className: string, parent: Element, seed: number ): void {

	const svg = svgEl( 'svg', { class: className, width: 6, height: 40, viewBox: '0 0 6 40', 'aria-hidden': 'true' }, parent );
	svg.style.opacity = '0.8';
	new InkPath( svg, { colour: PALETTE.gao }, seed ).set( DIVIDER );

}

export class TopRow {

	readonly root: HTMLElement;
	private readonly shared: UiShared;
	private readonly day: HTMLElement;
	private readonly clock: HTMLElement;
	private readonly clockButtons: HTMLButtonElement[] = [];
	private readonly forecast: Forecast;
	private readonly stock: ResourceRow;
	private dayShown = 0;

	constructor( parent: Element, shared: UiShared, openRecord: () => void ) {

		this.shared = shared;
		const root = this.root = el( 'div', 'pl-hud', parent );
		const top = el( 'div', 'pl-top', root );
		const when = el( 'div', 'pl-when', top );
		this.day = el( 'div', 'pl-day pl-title pl-xb', when );
		this.clock = el( 'div', 'pl-clock pl-num big pl-xb', when, '08:00' );
		divider( 'pl-divider pl-sh', top, 11 );
		const buttons = el( 'div', 'pl-run', top );
		buttons.setAttribute( 'role', 'group' );
		buttons.setAttribute( 'aria-label', t( 'top.run' ) );
		for ( const s of CLOCK ) {

			const b = iconButton( s.label, s.icon, 14, buttons, () => shared.game.setPaused( s.paused ) );
			const [ w, h ] = ICON_SIZE[ s.icon ];
			const svg = b.querySelector( 'svg' )!;
			svg.setAttribute( 'width', String( w ) );
			svg.setAttribute( 'height', String( h ) );
			b.style.width = `${ Math.max( 28, w + 16 ) }px`;
			this.clockButtons.push( b );

		}
		divider( 'pl-divider pl-sh', top, 12 );
		this.forecast = new Forecast( top );
		this.stock = new ResourceRow( root, shared );
		divider( 'pl-divider pl-stock-divider pl-sh', root, 13 );
		iconButton( t( 'record.title' ), 'record', 30, root, openRecord, 'pl-record-btn' );

	}

	update(): void {

		const game = this.shared.game, sim = game.sim;
		// game hours since day one's midnight, between ticks; the day and the minute in whole seconds,
		// as the simulation counts them (sim/clock.ts), so a minute's first second shows that minute
		const hour = sim.state.startHour + ( sim.state.tick + sim.alpha ) / 3600;
		const seconds = Math.round( sim.state.startHour * 3600 ) + sim.state.tick + sim.alpha;
		const minutes = Math.floor( seconds / 60 ) % ( 24 * 60 );
		const day = Math.floor( seconds / 86400 ) + 1;
		if ( day !== this.dayShown ) text( this.day, dayName( this.dayShown = day ) );
		text( this.clock, `${ String( Math.floor( minutes / 60 ) ).padStart( 2, '0' ) }:${ String( minutes % 60 ).padStart( 2, '0' ) }` );
		for ( let i = 0; i < CLOCK.length; i ++ ) {

			const current = sim.paused === CLOCK[ i ].paused;
			flag( this.clockButtons[ i ], 'dim', ! current );
			attr( this.clockButtons[ i ], 'aria-pressed', String( current ) );

		}
		this.forecast.update( game, hour );
		this.stock.update();

	}

}
