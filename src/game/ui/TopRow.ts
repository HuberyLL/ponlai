import { SPEED_FACTORS } from '../sim/types.ts';
import type { Speed } from '../sim/types.ts';
import { upright } from './Brush.ts';
import { dayName } from './data/record.ts';
import { attr, el, flag, iconButton, strokeSvg, text } from './dom.ts';
import { Forecast } from './Forecast.ts';
import { t } from './i18n/i18n.ts';
import { ResourceRow } from './ResourceRow.ts';
import type { UiShared } from './Shared.ts';

// The top row (docs/ui.md, Top row): at the left the day in calligraphy and the time in the brush
// numerals (08:00, the game's clock: telling time in 时辰 is not decided), the speeds (pause, 1x,
// 3x, 6x; the current one 缟, the others 苍) and the weather with its forecast (Forecast.ts); at the
// right the island's resources (ResourceRow.ts) and the record's scroll (沧海录), split by brush
// strokes. The speeds act through Game.setSpeed, the scroll opens the record (Record.ts).

const SPEEDS: readonly { speed: Speed; label: string; icon: string }[] = [
	{ speed: 0, label: t( 'top.pause' ), icon: 'pause' },
	{ speed: 1, label: t( 'top.speed1' ), icon: 'speed1' },
	{ speed: 2, label: t( 'top.speed3' ), icon: 'speed3' },
	{ speed: 3, label: t( 'top.speed6' ), icon: 'speed6' },
];
// each speed's icon size: the arrows grow with the speed
const SPEED_SIZE: Readonly<Record<string, [ number, number ]>> = { pause: [ 12, 14 ], speed1: [ 12, 14 ], speed3: [ 20, 14 ], speed6: [ 28, 14 ] };

const DIVIDER = upright( 3, 1, 39, 2.4, 0.6 );

export class TopRow {

	readonly root: HTMLElement;
	private readonly shared: UiShared;
	private readonly day: HTMLElement;
	private readonly clock: HTMLElement;
	private readonly speeds: HTMLButtonElement[] = [];
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
		strokeSvg( 6, 40, DIVIDER, 'pl-divider pl-sh', top ).svg.style.opacity = '0.8';
		const speeds = el( 'div', 'pl-speeds', top );
		speeds.setAttribute( 'role', 'group' );
		speeds.setAttribute( 'aria-label', t( 'top.speeds' ) );
		for ( const s of SPEEDS ) {

			const b = iconButton( s.label, s.icon, 14, speeds, () => shared.game.setSpeed( s.speed ) );
			const [ w, h ] = SPEED_SIZE[ s.icon ];
			const svg = b.querySelector( 'svg' )!;
			svg.setAttribute( 'width', String( w ) );
			svg.setAttribute( 'height', String( h ) );
			b.style.width = `${ Math.max( 28, w + 16 ) }px`;
			this.speeds.push( b );

		}
		strokeSvg( 6, 40, DIVIDER, 'pl-divider pl-sh', top ).svg.style.opacity = '0.8';
		this.forecast = new Forecast( top );
		this.stock = new ResourceRow( root, shared );
		strokeSvg( 6, 40, DIVIDER, 'pl-divider pl-stock-divider pl-sh', root ).svg.style.opacity = '0.8';
		iconButton( t( 'record.title' ), 'record', 30, root, openRecord, 'pl-record-btn' );

	}

	update(): void {

		const game = this.shared.game, sim = game.sim;
		// game hours since day one's midnight, between ticks
		const hour = sim.state.startHour + ( sim.state.tick + sim.alpha ) / 3600;
		const minutes = Math.floor( hour * 60 ) % ( 24 * 60 );
		const day = Math.floor( hour / 24 ) + 1;
		if ( day !== this.dayShown ) text( this.day, dayName( this.dayShown = day ) );
		text( this.clock, `${ String( Math.floor( minutes / 60 ) ).padStart( 2, '0' ) }:${ String( minutes % 60 ).padStart( 2, '0' ) }` );
		for ( let i = 0; i < SPEEDS.length; i ++ ) {

			const current = SPEED_FACTORS[ sim.speed ] === SPEED_FACTORS[ SPEEDS[ i ].speed ];
			flag( this.speeds[ i ], 'dim', ! current );
			attr( this.speeds[ i ], 'aria-pressed', String( current ) );

		}
		this.forecast.update( game, hour );
		this.stock.update();

	}

}
