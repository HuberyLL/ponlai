import 'lxgw-wenkai-gb-web/lxgwwenkaigb-regular/result.css';
import '@fontsource/ma-shan-zheng/400.css';
import '../ui/ui.css';
import './front.css';
import { LOAD_STAGES, type LoadStage } from '../../render/setup.ts';
import { el, svgEl, text } from '../ui/dom.ts';
import { levelStroke } from '../ui/Brush.ts';
import { locale, t } from '../ui/i18n/i18n.ts';
import { PALETTE } from '../ui/Palette.ts';

// The loading screen: the game's name and one brush stroke that fills with the load's real progress.
//
// The loading screen (docs/design/ui.md, The front end): the name 蓬莱 in calligraphy over the
// page's dark sea colour, one brush stroke beneath it that fills as the load passes its stages, the
// stage's line (苍) and the exact percentage. It is the page's loading element (index.html
// `#loading`), which the render pipeline's host lifts once the scene shows (render/browser.ts
// `browserHost`: the first `span` takes a status line, the class `done` fades it out), so the
// same screen covers a first load and the reload a setting asks for.
//
// The progress is real, never a timer: the share of each stage is the share of a first load's time
// it ends at, measured on the high tier at 4K output (the startup marks of a frame profile: the
// world's generation is the longest wait, the warm-up's pipeline precompilation the next), and the
// bar moves when the render pipeline tells the host a stage is passed (`progress`, its
// `LOAD_STAGES`). Between two stages it eases toward the next one's share, never past it, so a slow
// stage reads as slow rather than finished.
//
// It shows before the game's code loads: the app's entry (app/Boot.ts) loads it through the
// game's front-end entry point (game/front.ts), with the fonts and the interface's styles, so the
// title is in its face from the first painted frame the font allows.

// the share of the load each stage ends at (measured: see the header)
// a first load's time to its first frame (s), on the measured load
const TOTAL = 2.2;
const SHARE: Record<LoadStage, number> = { renderer: 0.03, sky: 0.14, ground: 0.42, world: 0.5, plants: 0.66, water: 0.7, haze: 0.74, 'warm-up': 0.93, loop: 0.96 };
// the stroke's frame (viewBox units)
const W = 420, H = 18;

export interface LoadingScreen {
	/** the element the render pipeline's host lifts */
	readonly element: HTMLElement;
	/** the load passed `stage` */
	progress( stage: LoadStage ): void;
	/** the load failed: the screen says so, with the error's words */
	fail( message: string ): void;
}

/** Turns the page's loading element into the loading screen and returns it. */
export function showLoading( element: HTMLElement ): LoadingScreen {

	for ( const [ name, colour ] of Object.entries( PALETTE ) ) element.style.setProperty( `--${ name }`, colour );
	element.replaceChildren();
	document.documentElement.lang = locale;
	// the interface's scale (GameUi's: its 1600 x 900 frame to the window)
	const rescale = () => element.style.setProperty( '--k', String( Math.min( Math.max( Math.min( innerWidth / 1600, innerHeight / 900 ), 0.75 ), 3 ) ) );
	rescale();
	addEventListener( 'resize', rescale );
	element.classList.add( 'pl-loading' );
	// (the host writes a status line into the first span: a failure such as no WebGPU)
	el( 'span', 'pl-load-status', element );
	const box = el( 'div', 'pl-load-box', element );
	const name = el( 'div', 'pl-load-name pl-title pl-xb', box, t( 'front.name' ) );
	name.setAttribute( 'lang', document.documentElement.lang );
	const bar = svgEl( 'svg', { class: 'pl-load-bar', viewBox: `0 0 ${ W } ${ H }`, 'aria-hidden': 'true' }, box );
	const stroke = levelStroke( 6, W - 6, H / 2, 7, 1.6, { entry: 0.06, exit: 0.3 } ).d;
	svgEl( 'path', { d: stroke, fill: 'currentColor', class: 'paper' }, bar );
	const clip = svgEl( 'clipPath', { id: 'pl-load-clip' }, bar );
	const reach = svgEl( 'rect', { x: 0, y: 0, width: 0, height: H }, clip );
	svgEl( 'path', { d: stroke, fill: 'currentColor', class: 'ink', 'clip-path': 'url(#pl-load-clip)' }, bar );
	const line = el( 'div', 'pl-load-line', box );
	const stage = el( 'span', 'pl-load-stage', line );
	const percent = el( 'span', 'pl-load-percent pl-num', line );
	element.setAttribute( 'role', 'progressbar' );
	element.setAttribute( 'aria-valuemin', '0' );
	element.setAttribute( 'aria-valuemax', '100' );

	// The bar is a CSS transition of the ink's clip (no script per frame: the load's own work has the
	// main thread, and an animation-frame loop of the page's held a tool's headless load at the
	// haze's bake): a passed stage moves it to its share within 0.6 s, then it creeps toward the next
	// stage's share over the time that stage took on the measured load, stopping short of it.
	reach.setAttribute( 'width', String( W ) );
	reach.style.transformBox = 'fill-box';
	reach.style.transformOrigin = '0 0';
	const moveTo = ( share: number, seconds: number ) => {

		reach.style.transition = `transform ${ seconds }s ${ seconds > 1 ? 'cubic-bezier( 0.2, 0.6, 0.4, 1 )' : 'ease-out' }`;
		reach.style.transform = `scaleX( ${ share } )`;

	};
	moveTo( 0, 0 );
	let passed = 0;
	const set = ( s: LoadStage ) => {

		const share = SHARE[ s ];
		if ( share < passed ) return;
		passed = share;
		const i = LOAD_STAGES.indexOf( s );
		const next = i + 1 < LOAD_STAGES.length ? SHARE[ LOAD_STAGES[ i + 1 ] ] : 1;
		moveTo( share, 0.6 );
		// then the creep, once the step has landed
		setTimeout( () => {

			if ( passed === share ) moveTo( share + ( next - share ) * 0.8, ( next - share ) * TOTAL );

		}, 650 );
		const p = Math.round( share * 100 );
		text( percent, `${ p }%` );
		text( stage, t( `front.load.${ s }` as const ) );
		element.setAttribute( 'aria-valuenow', String( p ) );
		element.setAttribute( 'aria-valuetext', t( 'front.load.label', { percent: p } ) );

	};
	text( stage, t( 'front.load.renderer' ) );
	text( percent, '0%' );
	setTimeout( () => { if ( passed === 0 ) moveTo( SHARE.renderer * 0.8, SHARE.renderer * TOTAL ); }, 0 );
	// the lift: the bar ends whole as the screen fades
	new MutationObserver( () => {

		if ( ! element.classList.contains( 'done' ) ) return;
		passed = 1;
		moveTo( 1, 0.4 );
		text( percent, '100%' );
		text( stage, t( 'front.load.shown' ) );

	} ).observe( element, { attributes: true, attributeFilter: [ 'class' ] } );
	const fail = ( message: string ) => {

		passed = 2;
		element.classList.add( 'failed' );
		text( stage, t( 'front.load.failed' ) );
		text( percent, '' );
		// the host's own line, where it wrote one (no WebGPU), says it better than the error
		const status = element.querySelector( '.pl-load-status' );
		if ( status && ! status.textContent ) text( status, message );

	};
	return { element, progress: set, fail };

}
