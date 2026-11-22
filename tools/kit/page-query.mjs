// The island page's query for a tool: the art-review scene (`review`) unless the query asks for the game.
//
// The page at `/` is the game; the art-review scene, which the capture, parity, probe, profile and
// verify tools render, is `?review` (app/AppSettings.ts). A tool hands every query it loads the
// island page with through `reviewQuery`: `review` is added, unless the query names `game` (the
// old switch, kept as a tool's word for the game's page: taken off, since the game is the page
// itself) or `review` already. The test scenes' page (`scenes.html`) takes no such option.
//   import { reviewQuery } from '../kit/page-query.mjs';
//   page.goto( `${ base }?${ reviewQuery( 'paused&t=12' ) }` );

/** `query` (with or without its `?`) as the island page's: the review scene unless it names `game`. */
export function reviewQuery( query ) {

	const params = new URLSearchParams( String( query ).replace( /^\?/, '' ) );
	if ( params.has( 'game' ) ) {

		params.delete( 'game' );
		return params.toString().replace( /=(?=&|$)/g, '' );

	}
	if ( params.has( 'review' ) ) return String( query ).replace( /^\?/, '' );
	const rest = String( query ).replace( /^\?/, '' );
	return rest ? `review&${ rest }` : 'review';

}

/** A URL (string or URL) of the island page, its query passed through `reviewQuery`. */
export function reviewUrl( url ) {

	const u = new URL( String( url ) );
	if ( u.pathname.endsWith( '.html' ) && ! u.pathname.endsWith( 'index.html' ) ) return u.href;
	u.search = reviewQuery( u.search );
	return u.href;

}
