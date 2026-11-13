import type { Game } from '../Game.ts';
import { upright } from './Brush.ts';
import type { Stroke } from './Brush.ts';
import { iconSvg, setIcon } from './Icons.ts';
import type { WeatherName } from '../../render/index.ts';
import { nightness, weatherIcon, weatherKind } from './data/weather.ts';
import type { WeatherKind } from './data/weather.ts';
import { attr, css, el, svgEl } from './dom.ts';
import { InkPath } from './InkPath.ts';
import { t } from './i18n/i18n.ts';

// The weather in the top row (docs/explanation/ui.md, Weather forecast; the design canvas's WeatherAnim): the
// weather now as one live icon in parts, and the next 24 game hours as one brush stroke beside it.
//
// - The live icon is the sun (or moon), a cloud and a cloud behind, each part's weight and place
//   blended from the kinds of the front under way (data/weather.ts `live`): a cloud slides in and
//   the sun shrinks behind it through a mask; at sunset the sun sinks and the moon rises. Its small
//   motions (the rays turning, the cloud drifting) follow the game's clock, so a paused game holds
//   it still and a paused page's frame is still.
// - The stroke spans 24 game hours at 9 px an hour, thick by day and thin by night, with a tick at
//   midnight; its wobble is tied to the hour, so it flows left as time passes. It is inked
//   (InkPath.ts), its dry tail toward the far hours, and drawn again as it moves a quarter pixel. A
//   small icon stands at each turn of the weather (the middle of its front), in the kind turned to
//   (its night face by night); of two turns closer than 20 px the first keeps its place and the
//   worse kind stays. The turns are the engine's auto chain read ahead (Game.forecast), read again
//   each game minute.
//
// Rules: it writes only what changed (the stroke as it moves a quarter pixel, a mark when it moves a
// tenth of a pixel); its label for screen readers says the weather now and its turns.

const PX_PER_HOUR = 9, WIDTH = 216, LEFT = 40, MARKS = 8, TICKS = 2, MARK_GAP = 20;
const smooth = ( a: number, b: number, x: number ) => {

	const k = Math.min( Math.max( ( x - a ) / ( b - a ), 0 ), 1 );
	return k * k * ( 3 - 2 * k );

};
const f2 = ( v: number ) => v.toFixed( 2 );
const hourOfDay = ( t: number ) => ( ( t % 24 ) + 24 ) % 24;

// the live icon's parts, from the design canvas: rays and a ring for the sun, the moon's crescent,
// the cloud's line and its base, and the faint cloud behind
const RAYS = 'M24.8 16 Q26.6 17.15 28.4 16 Q26.6 14.85 24.8 16 Z M22.22 22.22 Q22.62 24.37 24.77 24.77 Q24.37 22.62 22.22 22.22 Z M16 24.8 Q14.85 26.6 16 28.4 Q17.15 26.6 16 24.8 Z M9.78 22.22 Q7.63 22.62 7.23 24.77 Q9.38 24.37 9.78 22.22 Z M7.2 16 Q5.4 14.85 3.6 16 Q5.4 17.15 7.2 16 Z M9.78 9.78 Q9.38 7.63 7.23 7.23 Q7.63 9.38 9.78 9.78 Z M16 7.2 Q17.15 5.4 16 3.6 Q14.85 5.4 16 7.2 Z M22.22 9.78 Q24.37 9.38 24.77 7.23 Q22.62 7.63 22.22 9.78 Z';
const CORE = 'M16 9.4 a6.6 6.6 0 1 0 0.01 0 Z M16.5 11 a4.8 4.8 0 1 0 0.01 0 Z';
const MOON = 'M23.46 19.6 A9.2 9.2 0 1 1 14.04 6.85 A8 8 0 0 0 23.46 19.6 Z';
const CLOUD_LINE = 'M5.6 16.6 C2.8 16.2 3.2 11.8 6.5 12 C6.5 7.5 12.5 6.5 14 10 C15.5 5 23.5 5.5 23.5 11 C27.3 10.6 28.8 15.6 26 16.6';
const CLOUD_BASE = 'M4.6 16.4 C11 19.3 20 19.1 27 16.2 C20 18 11 18.2 4.6 16.4 Z';
const CLOUD_FILL = 'M5.6 16.6 C2.8 16.2 3.2 11.8 6.5 12 C6.5 7.5 12.5 6.5 14 10 C15.5 5 23.5 5.5 23.5 11 C27.3 10.6 28.8 15.6 26 16.6 C20 18.6 11 18.8 5.6 16.6 Z';
const BACK = 'M14.6 12.3 C15 8.6 20.4 7.6 21.9 10.6 C23.8 8.5 28.9 9.5 28.6 13.7';

let masks = 0;

interface Turn { x: number; at: number; kind: WeatherKind }

export class Forecast {

	readonly root: HTMLElement;
	private readonly sun: SVGGElement;
	private readonly rays: SVGGElement;
	private readonly core: SVGPathElement;
	private readonly moon: SVGGElement;
	private readonly moonFace: SVGPathElement;
	private readonly back: SVGGElement;
	private readonly backDrift: SVGGElement;
	private readonly cloud: SVGGElement;
	private readonly cloudDrift: SVGGElement;
	private readonly cut: SVGGElement;
	private readonly stroke: InkPath;
	private readonly marks: SVGSVGElement[] = [];
	private readonly ticks: SVGSVGElement[] = [];
	private turns: Turn[] = [];
	private readAt = NaN;

	constructor( parent: Element ) {

		const root = this.root = el( 'div', 'pl-forecast pl-sh', parent );
		root.setAttribute( 'role', 'img' );
		const live = svgEl( 'svg', { class: 'live', viewBox: '0 0 32 32', 'aria-hidden': 'true' }, root );
		const id = `pl-wx${ masks ++ }`;
		const mask = svgEl( 'mask', { id, maskUnits: 'userSpaceOnUse', x: - 10, y: - 10, width: 52, height: 52 }, svgEl( 'defs', {}, live ) );
		svgEl( 'rect', { x: - 10, y: - 10, width: 52, height: 52, fill: '#fff' }, mask );
		// the cloud cuts the light behind it, a little wider than itself
		this.cut = svgEl( 'g', { opacity: 0 }, mask );
		svgEl( 'path', { d: CLOUD_FILL, fill: '#000', stroke: '#000', 'stroke-width': 3.4, 'stroke-linejoin': 'round' }, this.cut );
		const lit = svgEl( 'g', { mask: `url(#${ id })` }, live );
		this.sun = svgEl( 'g', {}, lit );
		this.rays = svgEl( 'g', {}, this.sun );
		svgEl( 'path', { d: RAYS, fill: 'currentColor' }, this.rays );
		this.core = svgEl( 'path', { d: CORE, fill: 'currentColor', 'fill-rule': 'evenodd' }, this.sun );
		this.moon = svgEl( 'g', { opacity: 0 }, lit );
		this.moonFace = svgEl( 'path', { d: MOON, fill: 'currentColor' }, this.moon );
		this.back = svgEl( 'g', { opacity: 0 }, live );
		this.backDrift = svgEl( 'g', {}, this.back );
		svgEl( 'path', { d: BACK, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3, 'stroke-linecap': 'round', opacity: 0.7 }, this.backDrift );
		this.cloud = svgEl( 'g', { opacity: 0 }, live );
		this.cloudDrift = svgEl( 'g', {}, this.cloud );
		svgEl( 'path', { d: CLOUD_LINE, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round' }, this.cloudDrift );
		svgEl( 'path', { d: CLOUD_BASE, fill: 'currentColor' }, this.cloudDrift );

		const stroke = svgEl( 'svg', { class: 'stroke', width: WIDTH, height: 34, viewBox: `0 0 ${ WIDTH } 34`, 'aria-hidden': 'true' }, root );
		this.stroke = new InkPath( stroke, { colour: 'currentColor', gradient: { x1: 0, x2: WIDTH, stops: [ [ 0, 0.95 ], [ 1, 0.3 ] ] } }, 21 );
		for ( let i = 0; i < MARKS; i ++ ) this.marks.push( root.appendChild( iconSvg( 'sun', 18, 'mark' ) ) );
		for ( let i = 0; i < TICKS; i ++ ) {

			const tick = svgEl( 'svg', { class: 'tick', viewBox: '0 0 4 12', 'aria-hidden': 'true' }, root );
			svgEl( 'path', { d: upright( 2, 0.5, 11.5, 1.4 ), fill: 'currentColor' }, tick );
			this.ticks.push( tick );

		}

	}

	/** Per frame: the weather at game hour `t` (hours since day one's midnight). */
	update( game: Game, t: number ): void {

		const now = game.weatherNow(), n = nightness( t );
		this.drawLive( this.weights( now.from, now.to, now.progress ), n, t );
		// the turns, read again each game minute (and at once after a jump of the clock)
		if ( ! ( Math.abs( t - this.readAt ) < 1 / 60 ) ) {

			this.readAt = t;
			this.turns = this.read( game, t );
			attr( this.root, 'aria-label', this.label( weatherKind( now.shown ) ) );

		}
		// (at a quarter pixel's steps: the stroke moves a fifth of a pixel a second at 1x)
		this.stroke.set( strokePath( Math.round( t * PX_PER_HOUR * 4 ) / ( PX_PER_HOUR * 4 ) ) );
		const fade = ( x: number ) => smooth( 0, 16, x ) * ( 1 - smooth( WIDTH - 18, WIDTH, x ) );
		for ( let i = 0; i < MARKS; i ++ ) {

			const mark = this.marks[ i ], turn = this.turns[ i ];
			if ( ! turn ) {

				css( mark, 'opacity', '0' );
				continue;

			}
			const x = ( turn.at - t ) * PX_PER_HOUR;
			setIcon( mark, weatherIcon( turn.kind, turn.at ) );
			css( mark, 'opacity', ( ( 0.95 - 0.5 * x / WIDTH ) * fade( x ) ).toFixed( 3 ) );
			css( mark, 'transform', `translateX(${ ( LEFT + x - 9 ).toFixed( 1 ) }px)` );

		}
		// a tick at each midnight ahead
		const first = Math.floor( t / 24 ) * 24 + 24;
		for ( let i = 0; i < TICKS; i ++ ) {

			const x = ( first + 24 * i - t ) * PX_PER_HOUR, tick = this.ticks[ i ];
			css( tick, 'opacity', x <= WIDTH ? ( 0.55 * fade( x ) ).toFixed( 3 ) : '0' );
			css( tick, 'transform', `translateX(${ ( LEFT + x - 2 ).toFixed( 1 ) }px)` );

		}

	}

	// The kinds of the front under way as weights summing to one (eased across the front).
	private weights( from: WeatherName, to: WeatherName, progress: number ): Map<WeatherKind, number> {

		const w = new Map<WeatherKind, number>(), q = smooth( 0, 1, progress );
		const add = ( kind: WeatherKind, a: number ) => w.set( kind, ( w.get( kind ) ?? 0 ) + a );
		add( weatherKind( from ), 1 - q );
		add( weatherKind( to ), q );
		return w;

	}

	// The live icon's parts from the kinds' weights and the night factor n; `t` (game hours) drives
	// its small motions.
	private drawLive( weights: Map<WeatherKind, number>, n: number, t: number ): void {

		let day = 0, night = 0, coverDay = 0, coverNight = 0, cloud = 0, cx = 0, cy = 0, back = 0;
		for ( const [ kind, w ] of weights ) {

			const live = kind.live, toNight = kind.night ? n : 0;
			day += w * live.light * ( 1 - toNight );
			night += w * live.light * toNight;
			coverDay += w * live.light * live.cover * ( 1 - toNight );
			coverNight += w * live.light * live.cover * toNight;
			back += w * live.back;
			if ( live.cloud ) {

				cloud += w;
				cx += w * live.cloud[ 0 ];
				cy += w * live.cloud[ 1 ];

			}

		}
		const kS = day > 0 ? coverDay / day : 0, kM = night > 0 ? coverNight / night : 0;
		// the sun shrinks toward the upper left as cloud takes the sky and sinks a little at sunset;
		// the moon the other way
		const sS = 1 - 0.4 * kS, sx = 16 - 6 * kS, sy = 16 - 6.4 * kS + 5 * n;
		const sM = 1 - 0.46 * kM, mx = 15 - 5 * kM, my = 16 - 7 * kM + 5 * ( 1 - n );
		if ( cloud > 0.001 ) {

			cx /= cloud;
			cy /= cloud;

		} else {

			cx = 2;
			cy = 7;

		}
		cloud = Math.min( cloud, 1 );
		// a cloud coming or going drifts in from the right or out to it
		cx += ( 1 - cloud ) * 7;
		const cloudAt = `translate(${ f2( cx ) } ${ f2( cy ) })`;
		attr( this.sun, 'opacity', f2( day ) );
		attr( this.sun, 'transform', `translate(${ f2( sx - 16 * sS ) } ${ f2( sy - 16 * sS ) }) scale(${ f2( sS ) })` );
		attr( this.moon, 'opacity', f2( night ) );
		attr( this.moon, 'transform', `translate(${ f2( mx - 15 * sM ) } ${ f2( my - 16 * sM ) }) scale(${ f2( sM ) })` );
		attr( this.back, 'opacity', f2( Math.min( back, 1 ) ) );
		attr( this.back, 'transform', `translate(${ f2( ( 1 - Math.min( back, 1 ) ) * 5 ) } 0)` );
		attr( this.cloud, 'opacity', f2( cloud ) );
		attr( this.cloud, 'transform', cloudAt );
		attr( this.cut, 'opacity', f2( cloud ) );
		attr( this.cut, 'transform', cloudAt );
		// the small motions, by game time: the rays turn once in 18 game minutes (18 s at 1x), the
		// sun's ring breathes, the moon rocks and the clouds drift a pixel and a half
		const minutes = t * 60;
		attr( this.rays, 'transform', `rotate(${ f2( ( minutes / 18 * 360 ) % 360 ) } 16 16)` );
		attr( this.core, 'transform', `translate(16 16) scale(${ ( 1 + 0.035 * ( 1 - Math.cos( minutes / 3.2 * 2 * Math.PI ) ) ).toFixed( 3 ) }) translate(-16 -16)` );
		attr( this.moonFace, 'transform', `rotate(${ f2( - 5 * Math.cos( minutes / 7 * 2 * Math.PI ) ) } 16 16)` );
		const drift = - 1.5 * Math.cos( minutes / 10 * 2 * Math.PI );
		attr( this.cloudDrift, 'transform', `translate(${ f2( drift ) } 0)` );
		attr( this.backDrift, 'transform', `translate(${ f2( - drift ) } 0)` );

	}

	// The turns of the next 24 hours as marks: at the middle of each front that changes the kind
	// shown; of two closer than MARK_GAP px the first keeps its place and the worse kind stays.
	private read( game: Game, t: number ): Turn[] {

		const marks: Turn[] = [];
		for ( const turn of game.forecast( 25 ) ) {

			const mid = turn.at + turn.duration / 2;
			const from = weatherKind( turn.from ), to = weatherKind( turn.to );
			if ( mid <= 0 || mid > 24 || from === to ) continue;
			const mark = { x: mid * PX_PER_HOUR, at: t + mid, kind: to }, last = marks[ marks.length - 1 ];
			if ( last && mark.x - last.x < MARK_GAP ) {

				if ( to.rank > last.kind.rank ) last.kind = to;
				continue;

			}
			marks.push( mark );

		}
		return marks.slice( 0, MARKS );

	}

	private label( now: WeatherKind ): string {

		const turns = this.turns.map( ( m ) => t( 'weather.turn', { hour: Math.floor( hourOfDay( m.at ) ), kind: m.kind.name } ) );
		return t( 'weather.label', { now: now.name, turns: turns.length > 0 ? turns.join( t( 'list.then' ) ) : t( 'weather.steady' ) } );

	}

}

/** The 24 hours' stroke at game hour t: thick by day and thin by night, tapering at both ends; its
 * wobble is tied to the hour, so it flows left with time. */
function strokePath( t: number ): Stroke {

	let top = '', bottom = '';
	const frame: Stroke[ 'frame' ] = { points: [], half: [] };
	for ( let x = 0; x <= WIDTH; x += 3 ) {

		const tt = t + x / PX_PER_HOUR;
		let hw = ( 0.5 + 1.1 * ( 1 - nightness( tt ) ) ) * ( 1 + 0.14 * Math.sin( tt * 1.9 + 1.3 ) );
		hw *= Math.min( 1, 0.3 + x / 12 ) * Math.min( 1, ( WIDTH - x ) / 40 + 0.05 );
		const y = 26 + 0.55 * Math.sin( tt * 0.85 ) + 0.3 * Math.sin( tt * 2.3 + 0.7 );
		top += `${ x ? ' L' : 'M' }${ x } ${ ( y - hw ).toFixed( 2 ) }`;
		bottom = ` L${ x } ${ ( y + hw ).toFixed( 2 ) }${ bottom }`;
		frame.points.push( { x, y } );
		frame.half.push( hw );

	}
	return { d: `${ top }${ bottom } Z`, frame };

}
