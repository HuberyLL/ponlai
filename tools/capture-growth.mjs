// Side-by-side look reviews of the growing island: captures a set of views of a base and a
// candidate page at given seeds and growth steps, and writes a page that sets them next to each
// other with region statistics per pair.
//
//   node tools/capture-growth.mjs --base url [--cand url] [--seeds 1] [--grow 0,12] [--views v1,v3]
//     [--label name] [--q "extra&query"] [--jobs 2]
//
// Views: v1 overview (at noon and in golden hour), v2 top-down (polar 8 degrees), v3 cliff close,
// v4 meadow close, v5 rim close, v6 sea floor; the close views at noon. Every shot is
// `tools/capture.mjs` (headless, paused, 1672 x 941) under `gpu-lock.mjs run --shared`, a few at a
// time. A URL's own query parameters, and then `--q`, pass through to every shot of it and override
// the tool's own (paused, t, dpr, preset, weather, seed, grow).
//
// The framing follows the land in the page (`window.__PONLAI__.land`): the overview and top-down
// orbit the page's own pivot (`land.target`) at distances scaled by the land's equivalent radius
// against the first island's (`land.scale`), as the page frames its island view; the close views
// find the meadow's lip on the camera's ground grid, walking out from the land's centroid along the
// overview's azimuth, and look at it from the sea (cliff, rim), from inside it back across the
// meadow, or down onto the shelf beyond it. A page without `land` gets today's framing.
//
// Writes artifacts/captures/growth/<label>/index.html (and stats.json). Each pair's crops (the whole
// frame, its centre and its upper and lower bands) are measured with compare-captures.py's
// `metrics` (`uv run --with pillow --with numpy`) plus the mean saturation; deltas beyond 10 % are
// flagged. Shapes differ between steps and builds, so judge the look by eye and these statistics,
// not by pixel difference.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const args = process.argv.slice( 2 );
const opt = ( k, d ) => { const i = args.indexOf( '--' + k ); return i >= 0 ? args[ i + 1 ] : d; };
const list = ( k, d ) => opt( k, d ).split( ',' ).map( ( v ) => v.trim() ).filter( Boolean );

const base = opt( 'base', 'http://127.0.0.1:5190/' );
const cand = opt( 'cand', '' );
const seeds = list( 'seeds', '1' );
const grows = list( 'grow', '0,12' );
const views = list( 'views', 'v1,v2,v3,v4,v5,v6' );
const label = opt( 'label', new Date().toISOString().slice( 0, 16 ).replace( /[:T]/g, '-' ) );
const extra = opt( 'q', '' );
const jobs = Number( opt( 'jobs', 2 ) );
const W = 1672, H = 941;
const FLAG = 0.1;

const VIEWS = {
	v1: { name: 'overview', presets: [ 'noon', 'golden-hour' ] },
	v2: { name: 'top-down', presets: [ 'noon' ] },
	v3: { name: 'cliff close', presets: [ 'noon' ] },
	v4: { name: 'meadow close', presets: [ 'noon' ] },
	v5: { name: 'rim close', presets: [ 'noon' ] },
	v6: { name: 'sea floor', presets: [ 'noon' ] },
};
for ( const v of views ) if ( ! VIEWS[ v ] ) throw new Error( `unknown view ${ v } (v1-v6)` );

// Runs in the page (as `--eval`): places the camera for one view.
function placeCamera( s, view ) {

	const DEG = Math.PI / 180;
	// the page's own island view on this land: its pivot, and the ratio of the land's equivalent
	// radius to the first island's; without `land`, today's tile island framed about ( 1.5, 0.5, 1 )
	const land = s.land;
	const k = land ? land.scale : 1;
	const target = s.controls.target.clone().set( ...( land ? land.target : [ 1.5, 0.5, 1.0 ] ) );
	const c = land ? land.centroid : { x: 1.5, z: 1.0 };
	const camera = s.camera;

	const orbit = ( distance, polar, azimuth ) => {

		if ( s.cameraSettings.mode !== 'orbit' ) s.setCameraMode( 'orbit' );
		s.setCameraView( 'island' );
		s.controls.maxDistance = Math.max( s.controls.maxDistance, distance );
		s.controls.target.copy( target );
		camera.position.setFromSphericalCoords( distance, polar * DEG, azimuth * DEG ).add( target );
		camera.lookAt( target );
		s.controls.settle();

	};
	const look = ( eye, at, fov ) => {

		s.setCameraView( 'island' );
		s.setCameraMode( 'free' );
		camera.position.set( eye.x, eye.y, eye.z );
		camera.lookAt( at.x, at.y, at.z );
		camera.fov = fov;
		camera.updateProjectionMatrix();

	};

	// the default view's azimuth (318 degrees): the close views look at the coast it faces
	const az = 318;
	if ( view === 'v1' ) return orbit( 58 * k, 50, az );
	if ( view === 'v2' ) return orbit( 75 * k, 8, az );

	// walk out from the centroid on the camera's ground grid: onto the meadow, then to its lip
	const g = s.controls.ground, d = { x: Math.sin( az * DEG ), z: Math.cos( az * DEG ) };
	const at = ( r ) => ( { x: c.x + d.x * r, z: c.z + d.z * r } );
	const high = ( r ) => { const p = at( r ); return g.heightAt( p.x, p.z ) > 2; };
	let r = 0;
	while ( ! high( r ) && r < 150 ) r += 0.25;
	while ( high( r ) && r < 150 ) r += 0.25;
	const rim = at( r ), inland = at( r * 0.5 );
	const top = g.heightAt( inland.x, inland.z ); // the meadow's height
	const p = ( q, along, y ) => ( { x: q.x + d.x * along, y, z: q.z + d.z * along } );
	// across the coast, so the cliff is seen a little from the side
	const side = ( q, w ) => ( { x: q.x - d.z * w, y: q.y, z: q.z + d.x * w } );

	if ( view === 'v3' ) return look( side( p( rim, 14, 2.2 ), 4 ), p( rim, 0.5, 0.8 ), 45 );
	// from just inside the lip, back across the meadow
	if ( view === 'v4' ) return look( p( rim, - 2.5, top + 1.6 ), p( rim, - 12.5, top - 0.2 ), 55 );
	if ( view === 'v5' ) return look( side( p( rim, 6, top + 1.8 ), 1.5 ), p( rim, - 0.5, top - 1 ), 45 );
	// steeply down onto the shelf, short of the sun's glare
	if ( view === 'v6' ) return look( p( rim, 7, 6 ), p( rim, 10, - 3 ), 55 );

}

const shots = [];
const pages = cand ? [ [ 'base', base ], [ 'cand', cand ] ] : [ [ 'base', base ] ];
for ( const seed of seeds ) for ( const grow of grows ) for ( const view of views ) for ( const preset of VIEWS[ view ].presets ) {

	const key = `s${ seed }-g${ grow }-${ view }-${ preset }`;
	for ( const [ side, url ] of pages ) shots.push( { key, side, url, seed, grow, view, preset, file: `shots/${ side }-${ key }` } );

}

const outDir = path.join( ROOT, 'artifacts/captures/growth', label );
await mkdir( path.join( outDir, 'shots' ), { recursive: true } );

function capture( shot ) {

	const u = new URL( shot.url );
	// the page reads the first value of a key: the URL's query and `--q` replace the tool's
	const query = new URLSearchParams( { paused: '', t: 12, dpr: 1, preset: shot.preset, weather: 'clear', seed: shot.seed, grow: shot.grow } );
	for ( const given of [ u.searchParams, new URLSearchParams( extra ) ] ) for ( const key of new Set( given.keys() ) ) {

		query.delete( key );
		for ( const value of given.getAll( key ) ) query.append( key, value );

	}
	const evalJs = `(${ placeCamera.toString() })( window.__PONLAI__, ${ JSON.stringify( shot.view ) } )`;
	const argv = [ 'tools/gpu-lock.mjs', 'run', '--shared', '--label', `capture-growth ${ shot.side } ${ shot.key }`, '--',
		'node', 'tools/capture.mjs', `growth/${ label }/${ shot.file }`, '--w', String( W ), '--h', String( H ),
		'--url', u.origin + u.pathname, '--q', query.toString().replace( /=(?=&|$)/g, '' ), '--eval', evalJs ];
	return new Promise( ( resolve ) => {

		const child = spawn( process.execPath, argv, { cwd: ROOT, stdio: [ 'ignore', 'pipe', 'pipe' ] } );
		let output = '';
		child.stdout.on( 'data', ( b ) => output += b );
		child.stderr.on( 'data', ( b ) => output += b );
		child.on( 'close', ( code ) => resolve( { code, output } ) );

	} );

}

const t0 = performance.now();
let next = 0, done = 0;
await Promise.all( Array.from( { length: Math.min( jobs, shots.length ) }, async () => {

	while ( next < shots.length ) {

		const shot = shots[ next ++ ];
		// a page that loads slowly while other pages render (the shared lock) gets a second try
		let { code, output } = await capture( shot );
		if ( code !== 0 && /TimeoutError/.test( output ) ) ( { code, output } = await capture( shot ) );
		// capture.mjs exits with 1 on console errors too, after it has written the shot: those
		// are listed with it
		shot.ok = output.includes( `${ shot.file }.png ` );
		if ( shot.ok ) {

			const info = JSON.parse( await readFile( path.join( outDir, shot.file + '.json' ), 'utf8' ) );
			shot.messages = [ ...info.errors, ...info.failures ];

		} else {

			shot.messages = [ output.split( '\n' ).filter( ( l ) => /error|exceeded/i.test( l ) ).slice( 0, 3 ).join( '\n' ) || `exit ${ code }` ];

		}
		done ++;
		console.log( `[${ done }/${ shots.length }] ${ shot.side } ${ shot.key } ${ shot.ok ? 'ok' : 'FAILED' }${ shot.messages.length ? ` (${ shot.messages.length } messages)` : '' }` );

	}

} ) );

// region statistics, by compare-captures.py's `metrics` (taken from its source, which runs its own
// overview comparison at the top level) plus the mean HSV saturation
const PY = `
import ast, json, sys
import numpy as np
from PIL import Image
job = json.load(sys.stdin)
ns = {"np": np}
src = open(job["compare"]).read()
for node in ast.parse(src).body:
    if isinstance(node, ast.FunctionDef) and node.name == "metrics":
        exec(compile(ast.Module([node], []), job["compare"], "exec"), ns)
metrics = ns["metrics"]
def stats(im):
    m = metrics(im)
    a = np.asarray(im, dtype=np.float64)
    hi, lo = a.max(axis=2), a.min(axis=2)
    sat = np.where(hi > 0, (hi - lo) / np.maximum(hi, 1e-9), 0)
    return {"luma": m["lumaMean"], "saturation": round(float(sat.mean()) * 100, 2), "edges": m["meanAdjacentLumaDifference"]}
out = {}
for path in job["images"]:
    try:
        im = Image.open(path).convert("RGB")
    except Exception:
        continue
    w, h = im.size
    out[path] = {name: stats(im.crop((round(x0 * w), round(y0 * h), round(x1 * w), round(y1 * h)))) for name, (x0, y0, x1, y1) in job["regions"].items()}
print(json.dumps(out))
`;
const REGIONS = { frame: [ 0, 0, 1, 1 ], centre: [ 0.25, 0.25, 0.75, 0.75 ], upper: [ 0, 0, 1, 0.4 ], lower: [ 0, 0.6, 1, 1 ] };
const images = shots.filter( ( s ) => s.ok ).map( ( s ) => path.join( outDir, s.file + '.png' ) );
const stats = await new Promise( ( resolve, reject ) => {

	const child = spawn( 'uv', [ 'run', '--quiet', '--with', 'pillow', '--with', 'numpy', 'python', '-I', '-c', PY ], { cwd: ROOT, stdio: [ 'pipe', 'pipe', 'inherit' ] } );
	let output = '';
	child.stdout.on( 'data', ( b ) => output += b );
	child.on( 'close', ( code ) => code === 0 ? resolve( JSON.parse( output ) ) : reject( new Error( `region statistics failed (${ code })` ) ) );
	child.stdin.end( JSON.stringify( { compare: path.join( ROOT, 'tools/compare-captures.py' ), images, regions: REGIONS } ) );

} );
for ( const s of shots ) s.stats = stats[ path.join( outDir, s.file + '.png' ) ] ?? null;

// pairs: the candidate's change against the base, per region and metric
const rows = [];
for ( const key of [ ...new Set( shots.map( ( s ) => s.key ) ) ] ) {

	const [ b, c ] = [ 'base', 'cand' ].map( ( side ) => shots.find( ( s ) => s.key === key && s.side === side ) );
	const deltas = {};
	if ( b?.stats && c?.stats ) for ( const region of Object.keys( REGIONS ) ) {

		deltas[ region ] = {};
		for ( const m of [ 'luma', 'saturation', 'edges' ] ) {

			const x = b.stats[ region ][ m ], y = c.stats[ region ][ m ];
			deltas[ region ][ m ] = Math.abs( x ) > 1e-6 ? ( y - x ) / Math.abs( x ) : ( y === x ? 0 : Infinity );

		}

	}
	rows.push( { key, base: b, cand: c, deltas, flagged: Object.values( deltas ).some( ( r ) => Object.values( r ).some( ( v ) => Math.abs( v ) > FLAG ) ) } );

}

await writeFile( path.join( outDir, 'stats.json' ), JSON.stringify( { base, cand, seeds, grows, views, extra, regions: REGIONS,
	shots, deltas: Object.fromEntries( rows.map( ( r ) => [ r.key, r.deltas ] ) ) }, null, 2 ) );

const esc = ( s ) => String( s ).replace( /[&<>"]/g, ( ch ) => ( { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } )[ ch ] );
const pct = ( v ) => ( ! Number.isFinite( v ) ? '∞' : `${ v >= 0 ? '+' : '' }${ ( v * 100 ).toFixed( 1 ) } %` );
const cell = ( s ) => ! s ? '<div class="shot missing">not captured</div>' : `<figure class="shot">
	${ s.ok ? `<a href="${ s.file }.png"><img src="${ s.file }.png" loading="lazy" alt="${ s.side } ${ esc( s.key ) }"></a>` : '<div class="missing">capture failed</div>' }
	<figcaption>${ s.side === 'base' ? 'base' : 'candidate' }${ s.messages.length ? ` <span class="warn" title="${ esc( s.messages.join( '\n' ) ) }">${ s.messages.length } console messages</span>` : '' }</figcaption>
</figure>`;
const table = ( r ) => {

	const one = r.base?.stats ? [ r.base ] : [];
	if ( ! r.cand ) return one.length ? `<table><tr><th></th><th>luma</th><th>saturation %</th><th>edges</th></tr>${ Object.entries( r.base.stats ).map( ( [ region, m ] ) =>
		`<tr><th>${ region }</th><td>${ m.luma }</td><td>${ m.saturation }</td><td>${ m.edges }</td></tr>` ).join( '' ) }</table>` : '';
	if ( ! r.base?.stats || ! r.cand?.stats ) return '';
	return `<table><tr><th></th><th>luma</th><th>saturation</th><th>edges</th></tr>${ Object.keys( REGIONS ).map( ( region ) =>
		`<tr><th>${ region }</th>${ [ 'luma', 'saturation', 'edges' ].map( ( m ) => {

			const v = r.deltas[ region ][ m ];
			return `<td class="${ Math.abs( v ) > FLAG ? 'flag' : '' }" title="${ r.base.stats[ region ][ m ] } → ${ r.cand.stats[ region ][ m ] }">${ pct( v ) }</td>`;

		} ).join( '' ) }</tr>` ).join( '' ) }</table>`;

};
const section = ( r ) => {

	const s = r.base ?? r.cand;
	return `<section${ r.flagged ? ' class="flagged"' : '' }>
<h2>${ esc( VIEWS[ s.view ].name ) } <small>seed ${ esc( s.seed ) } · grow ${ esc( s.grow ) } · ${ esc( s.preset ) }${ r.flagged ? ' · <b>beyond ±10 %</b>' : '' }</small></h2>
<div class="pair${ cand ? '' : ' single' }">${ cell( r.base ) }${ cand ? cell( r.cand ) : '' }</div>
${ table( r ) }
</section>`;

};

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Growth captures ${ esc( label ) }</title>
<style>
:root { --bg: #f6f5f1; --fg: #1d2326; --muted: #65706f; --line: #d9d7d0; --flag: #b4421f; --flag-bg: #f8e3da; }
@media (prefers-color-scheme: dark) { :root { --bg: #15191b; --fg: #e4e6e3; --muted: #94a09e; --line: #2c3437; --flag: #f08a63; --flag-bg: #3a2219; } }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; }
header p { color: var(--muted); margin: 4px 0; word-break: break-all; }
section { border-top: 1px solid var(--line); padding: 12px 0 18px; }
h1 { font-size: 20px; margin: 0 0 6px; } h2 { font-size: 16px; margin: 0 0 8px; } h2 small { color: var(--muted); font-weight: normal; }
.flagged h2 b { color: var(--flag); }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; } .pair.single { grid-template-columns: 1fr; max-width: 900px; }
@media (max-width: 700px) { .pair { grid-template-columns: 1fr; } }
figure { margin: 0; } img { width: 100%; height: auto; display: block; border-radius: 3px; }
figcaption { color: var(--muted); font-size: 12px; margin-top: 3px; } .warn { color: var(--flag); cursor: help; }
.missing { padding: 40px; text-align: center; color: var(--flag); border: 1px dashed var(--line); }
table { border-collapse: collapse; margin-top: 8px; font-variant-numeric: tabular-nums; font-size: 13px; }
th, td { padding: 2px 10px; text-align: right; } th { color: var(--muted); font-weight: normal; }
td.flag { color: var(--flag); background: var(--flag-bg); font-weight: 600; }
</style></head><body>
<header><h1>Growth captures · ${ esc( label ) }</h1>
<p>base: ${ esc( base ) }${ cand ? `<br>candidate: ${ esc( cand ) }` : '' }${ extra ? `<br>extra query: ${ esc( extra ) }` : '' }</p>
<p>${ shots.length } shots at ${ W } × ${ H }, paused at t = 12, weather clear. Deltas are the candidate's change against the base per crop (mean luma, mean saturation, edge density as the mean adjacent luma difference); beyond ±10 % is flagged. Shapes differ between steps and builds: judge by eye and these statistics, not by pixel difference.</p></header>
${ rows.map( section ).join( '\n' ) }
</body></html>
`;
await writeFile( path.join( outDir, 'index.html' ), html );
const flagged = rows.filter( ( r ) => r.flagged ).length;
console.log( `${ path.relative( ROOT, path.join( outDir, 'index.html' ) ) }: ${ rows.length } views, ${ flagged } flagged, ${ shots.filter( ( s ) => ! s.ok ).length } failed, ${ ( ( performance.now() - t0 ) / 1000 ).toFixed( 0 ) } s` );
