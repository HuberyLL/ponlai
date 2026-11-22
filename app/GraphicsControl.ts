// The graphics menu's control: the player's choice stored, the live options applied, a reload for the rest.
//
// The app's side of the game's graphics menu (game/front/Front.ts `GraphicsControl`): it holds the
// player's choice (GraphicsSettings.ts: the stored record, or this load's tier's preset), stores
// every change, applies a live option at once through the render pipeline's own setters (the render
// resolution and dynamic resolution through the frame's sizing, `setResolution`; the frame-rate cap
// through the pacer, `setRate`; the clouds and the sky's refresh through `applySkyQuality`, with the
// profile's other runtime settings as this load built them) and tells the menu which reload
// options differ from what this load built. A reload saves the game first, says where the next load
// opens (session storage, read once by main.ts) and reloads the same address: the stored record
// is read again as the page loads (PageSettings.ts). The display mode is the Fullscreen API's.
//
// Under a page that does not keep the player's settings (an automated browser, `graphicsStore=off`)
// the choices still apply on the page but are not stored.
import { GRAPHICS_OPTIONS, choiceValues, presetRecord, withChoice, type GraphicsRecord, type QualityProfile, type QualityTier } from '../packages/render/setup.ts';
import type { RenderParts, SceneFrame } from '../packages/render/index.ts';
import type { Game, GraphicsControl } from '../packages/game/index.ts';
import { saveGraphics } from './GraphicsSettings.ts';
import { pageStore } from './PageSettings.ts';

/** Where the load after a reload for a setting opens (main.ts reads it once). */
export const OPENING_KEY = 'ponlai.front.opening';

function setPath( target: Record<string, unknown>, path: string, value: unknown ): void {

	const names = path.split( '.' );
	let node = target;
	for ( const name of names.slice( 0, - 1 ) ) node = node[ name ] as Record<string, unknown>;
	node[ names[ names.length - 1 ] ] = structuredClone( value );

}

export function createGraphicsControl( render: RenderParts, frame: SceneFrame, game: Game | null, start: GraphicsRecord, stores: boolean ): GraphicsControl {

	// what this load built: a reload option differs from it until the reload
	const loaded = start;
	let record = start;
	// the live part of the profile, as this load built it and as the player changes it
	const runtime = structuredClone( render.runtimeQuality ) as QualityProfile;

	const applyLive = ( id: string, choice: string ) => {

		const values = choiceValues( id, choice );
		if ( id === 'resolution' || id === 'dynamic' ) {

			const share = Number( choiceValues( 'resolution', record.options.resolution )[ 'render.dynamic.share' ] ?? 0 );
			const pinned = Boolean( choiceValues( 'dynamic', record.options.dynamic )[ 'render.dynamic.pinned' ] ?? false );
			frame.sizing.setResolution( { share, pinned } );

		} else if ( id === 'frameRate' ) {

			const rate = Number( values.frameRate );
			// the rate this load built is the pacer's own (its fallback on a fast display stays), any other a fixed cap
			frame.pacer.setRate( rate === render.quality.frameRate ? 'auto' : rate );

		} else if ( Object.keys( values ).length ) {

			for ( const [ path, value ] of Object.entries( values ) ) setPath( runtime as unknown as Record<string, unknown>, path, value );
			render.applySkyQuality( runtime );

		}

	};
	const change = ( next: GraphicsRecord ) => {

		const before = record;
		record = next;
		if ( stores ) saveGraphics( pageStore, record );
		for ( const option of GRAPHICS_OPTIONS ) if ( option.applies === 'live' && before.options[ option.id ] !== record.options[ option.id ] ) applyLive( option.id, record.options[ option.id ] );

	};

	// eslint-disable-next-line ponlai/scene-clock -- the frame-rate readout: frames shown a second, not what is drawn
	let frames = 0, since = performance.now(), fps = 0;
	const countFrames = () => {

		frames ++;
		// eslint-disable-next-line ponlai/scene-clock -- the frame-rate readout: frames shown a second, not what is drawn
		const now = performance.now();
		if ( now - since >= 1000 ) {

			fps = frames * 1000 / ( now - since );
			frames = 0;
			since = now;

		}
		requestAnimationFrame( countFrames );

	};
	requestAnimationFrame( countFrames );

	return {
		options: GRAPHICS_OPTIONS,
		get record() { return record; },
		set( id, choice ) { change( withChoice( record, id, choice ) ); },
		setPreset( tier: QualityTier ) { change( { ...presetRecord( tier ), options: { ...presetRecord( tier ).options, fps: record.options.fps } } ); },
		pending() {

			return GRAPHICS_OPTIONS.filter( ( o ) => o.applies === 'reload' && o.fields.some( ( f ) => JSON.stringify( choiceValues( o.id, record.options[ o.id ] )[ f ] ) !== JSON.stringify( choiceValues( o.id, loaded.options[ o.id ] )[ f ] ) ) ).map( ( o ) => o.id );

		},
		reload( into ) {

			game?.autosave();
			try { sessionStorage.setItem( OPENING_KEY, into ); } catch { /* storage refused: the load opens on the title */ }
			location.reload();

		},
		fullscreen: () => document.fullscreenElement !== null,
		setFullscreen( on ) {

			if ( on && ! document.fullscreenElement ) void document.documentElement.requestFullscreen?.().catch( () => {} );
			else if ( ! on && document.fullscreenElement ) void document.exitFullscreen().catch( () => {} );

		},
		fps: () => frame.frameTimes.length ? fps : 0,
	};

}
