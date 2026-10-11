import type * as THREE from 'three/webgpu';
import type { Game } from './Game.ts';
import { ChestPlacement } from './Placement.ts';
import { describeCall } from './sim/actions.ts';
import { BAG_CAPACITY, total } from './sim/items.ts';
import type { Villager } from './sim/types.ts';

// The player's on-screen interface in ?game, a prototype HUD rather than the final UI: a small
// readout of the islander (name, day and time, satiety and hydration as bars with numbers, the bag,
// what they are doing, the last thing they said and how their last action ended) and the one
// control the player has, placing the chest (Placement.ts). Plain DOM over the canvas in a
// warm, quiet style that sits over the scene, not lil-gui (the debug panel stays the developer's).
//
// Rules: it reads the simulation and acts only through the Game's methods. It never touches the
// canvas's pixels, so paused frames stay exact; the DOM is written only where its text changed, so
// a steady readout costs a string comparison per field and frame.

const STYLE = `
.ponlai-hud { position: fixed; inset: 0; pointer-events: none; z-index: 5;
	font: 500 13px/1.35 ui-sans-serif, system-ui, -apple-system, "PingFang SC", sans-serif; color: #f4e9d2;
	font-variant-numeric: tabular-nums; }
.ponlai-hud .panel { position: absolute; left: 16px; top: 16px; width: 236px; padding: 10px 12px 11px;
	background: rgba( 30, 24, 16, 0.6 ); border: 1px solid rgba( 255, 232, 190, 0.16 ); border-radius: 12px;
	box-shadow: 0 4px 18px rgba( 0, 0, 0, 0.25 ); backdrop-filter: blur( 6px ); -webkit-backdrop-filter: blur( 6px ); }
.ponlai-hud .head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 7px; }
.ponlai-hud .name { font-weight: 650; font-size: 15px; letter-spacing: 0.02em; }
.ponlai-hud .time { color: rgba( 244, 233, 210, 0.75 ); font-size: 12px; }
.ponlai-hud .need { display: grid; grid-template-columns: 68px 1fr 26px; align-items: center; gap: 7px; margin: 3px 0; }
.ponlai-hud .label { color: rgba( 244, 233, 210, 0.75 ); font-size: 12px; }
.ponlai-hud .track { height: 7px; border-radius: 4px; background: rgba( 255, 240, 210, 0.13 ); overflow: hidden; }
.ponlai-hud .fill { height: 100%; border-radius: 4px; transition: width 0.25s linear; }
.ponlai-hud .satiety .fill { background: linear-gradient( 90deg, #c9853a, #ebb565 ); }
.ponlai-hud .hydration .fill { background: linear-gradient( 90deg, #3f97ad, #79cfe0 ); }
.ponlai-hud .value { text-align: right; font-size: 12px; }
.ponlai-hud .row { display: grid; grid-template-columns: 68px 1fr; gap: 7px; margin-top: 4px; font-size: 12px; }
.ponlai-hud .said { margin-top: 6px; font-style: italic; color: #fff4dc; }
.ponlai-hud .said:empty, .ponlai-hud .last:empty { display: none; }
.ponlai-hud .last { margin-top: 3px; font-size: 11.5px; color: rgba( 244, 233, 210, 0.6 ); }
.ponlai-hud .place { position: absolute; left: 50%; bottom: 22px; transform: translateX( -50% );
	display: flex; flex-direction: column; align-items: center; gap: 8px; }
.ponlai-hud .place button { pointer-events: auto; cursor: pointer; border: 0; border-radius: 999px; padding: 9px 18px;
	font: 650 13px/1 ui-sans-serif, system-ui, -apple-system, sans-serif; letter-spacing: 0.02em; color: #2b1d0c;
	background: linear-gradient( #f0cf8a, #d29f4c ); box-shadow: 0 3px 12px rgba( 0, 0, 0, 0.3 ), inset 0 1px 0 rgba( 255, 255, 255, 0.45 ); }
.ponlai-hud .place button:hover { filter: brightness( 1.06 ); }
.ponlai-hud .place.armed button { color: #f4e9d2; background: rgba( 30, 24, 16, 0.72 ); box-shadow: 0 3px 12px rgba( 0, 0, 0, 0.3 ), inset 0 0 0 1px rgba( 255, 232, 190, 0.3 ); }
.ponlai-hud .hint { padding: 6px 12px; border-radius: 8px; background: rgba( 30, 24, 16, 0.6 ); font-size: 12px; }
.ponlai-hud .hint:empty { display: none; }
.ponlai-hud .hint.refused { color: #ffc4b4; }
`;

interface NeedRow { fill: HTMLElement; value: HTMLElement }

function element<K extends keyof HTMLElementTagNameMap>( tag: K, className: string, parent: HTMLElement ): HTMLElementTagNameMap[ K ] {

	const e = document.createElement( tag );
	e.className = className;
	parent.appendChild( e );
	return e;

}

/** Set a node's text only when it changed. */
function text( e: HTMLElement, value: string ): void {

	if ( e.textContent !== value ) e.textContent = value;

}

/** The bag as words: "2 coconut · 1 fish", or "empty". */
function bagText( v: Villager ): string {

	const kinds = Object.keys( v.bag ).sort();
	const items = kinds.map( ( kind ) => `${ v.bag[ kind ] } ${ kind }` ).join( ' · ' );
	return `${ items || 'empty' } (${ total( v.bag ) }/${ BAG_CAPACITY })`;

}

export interface HudContext {
	canvas: HTMLCanvasElement;
	camera: THREE.Camera;
	scene: THREE.Scene;
}

export class GameHud {

	private readonly game: Game;
	private readonly root: HTMLElement;
	private readonly name: HTMLElement;
	private readonly time: HTMLElement;
	private readonly satiety: NeedRow;
	private readonly hydration: NeedRow;
	private readonly bag: HTMLElement;
	private readonly doing: HTMLElement;
	private readonly said: HTMLElement;
	private readonly last: HTMLElement;
	private readonly placement: ChestPlacement;

	constructor( game: Game, context: HudContext ) {

		this.game = game;
		const style = document.createElement( 'style' );
		style.textContent = STYLE;
		document.head.appendChild( style );
		const root = this.root = element( 'div', 'ponlai-hud', document.body );
		const panel = element( 'div', 'panel', root );
		const head = element( 'div', 'head', panel );
		this.name = element( 'span', 'name', head );
		this.time = element( 'span', 'time', head );
		const need = ( label: string, kind: string ): NeedRow => {

			const row = element( 'div', `need ${ kind }`, panel );
			element( 'span', 'label', row ).textContent = label;
			const fill = element( 'div', 'fill', element( 'div', 'track', row ) );
			return { fill, value: element( 'span', 'value', row ) };

		};
		this.satiety = need( 'Satiety', 'satiety' );
		this.hydration = need( 'Hydration', 'hydration' );
		const row = ( label: string ): HTMLElement => {

			const r = element( 'div', 'row', panel );
			element( 'span', 'label', r ).textContent = label;
			return element( 'span', '', r );

		};
		this.bag = row( 'Bag' );
		this.doing = row( 'Doing' );
		this.said = element( 'div', 'said', panel );
		this.last = element( 'div', 'last', panel );
		this.placement = new ChestPlacement( game, context, element( 'div', 'place', root ) );

	}

	/** A new simulation was installed (start, load). */
	reset(): void {

		this.placement.reset();

	}

	/** Per frame, after the simulation advanced. */
	update(): void {

		const sim = this.game.sim;
		const v = sim.state.villagers[ 0 ];
		this.root.style.display = v ? '' : 'none';
		this.placement.update();
		if ( ! v ) return;
		const hour = this.game.hour(), minutes = Math.floor( hour * 60 ) % ( 24 * 60 );
		text( this.name, v.name );
		text( this.time, `Day ${ sim.day() + 1 } · ${ String( Math.floor( minutes / 60 ) ).padStart( 2, '0' ) }:${ String( minutes % 60 ).padStart( 2, '0' ) }` );
		this.need( this.satiety, v.needs.satiety );
		this.need( this.hydration, v.needs.hydration );
		text( this.bag, bagText( v ) );
		text( this.doing, v.action ? describeCall( v.action.call ) : v.path ? 'walking' : sim.thinking( v.id ) ? 'thinking' : 'idle' );
		text( this.said, v.said ? `“${ v.said.words }”` : '' );
		const last = v.last;
		text( this.last, last ? `${ describeCall( last.call ) }: ${ last.result.ok ? last.result.value ?? 'done' : last.result.reason }` : '' );

	}

	private need( row: NeedRow, value: number ): void {

		const n = Math.round( value );
		text( row.value, String( n ) );
		const width = `${ n }%`;
		if ( row.fill.style.width !== width ) row.fill.style.width = width;

	}

}
