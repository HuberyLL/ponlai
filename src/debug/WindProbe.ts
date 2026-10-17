import * as THREE from 'three/webgpu';
import { Fn, If, float, instanceIndex, instancedArray, uint, vec2, vec3, vec4 } from 'three/tsl';
import { WIND_STATE_VEC4S, Wind, createWindUniforms, gustAt, packWindState, rootHash, swayFrequency, windField, windStateOf, type WindState } from '../weather/Wind.ts';
import { plantGrass } from '../world/Grass.ts';
import { GRASS_WIND, PALM_WIND, bendBlade, bladePhase, mainBend } from '../world/vegetation/Deform.ts';
import { windDisplacement } from '../weather/Wind.ts';
import { debugFlags } from './DebugFlags.ts';
import type { WorldData } from '../world/types.ts';
import type { Vegetation } from '../world/vegetation/Registry.ts';
import type { Shared } from '../shared.ts';
import { OPEN_DRIFT, type SeaDetail } from '../ocean/SeaDetail.ts';
import type { Bounds } from '../world/WorldShapes.ts';

// `__PONLAI__.windProbe( options )`: the numbers behind the wind view (WindView.ts), as JSON for
// tools/probe.mjs. Every sway comes from the shaders' own TSL functions (Wind.ts `windField`,
// vegetation/Deform.ts `bendBlade` and `mainBend` with each kind's constants), evaluated in a compute kernel built on the first
// call (none exists on a page that never calls it, so the page's pipelines are unchanged), for the
// plants' own inputs: tufts grown as the page grows them (`plantGrass`, sampled; the flowering
// tufts' heads, which sway on their own, `bendBlade`'s `flower`, are not), the game's palms. The wind is a copy of the page's (`Wind`, the same
// speed, heading, gustiness and scene time), stepped on the CPU and handed to the kernel per step through a
// storage buffer, so the page's own wind is never touched. Two time series: fast (64 x 0.05 s,
// the swing) and slow (40 x 0.5 s, the gusts' travel). Options: DEFAULTS below. The result is
// large and deep: probe.mjs takes it as `--eval "JSON.stringify( await P.windProbe( { ... } ) )"`.
//
// Per kind of plant, for each series: the sway s (tip offset over height, LEAN_REF's unit) against
// the local wind d (`windField`'s direction at the root, the eddies' veer included) and the mean
// wind D: histograms of its angle in 15 degree bins, the share pointing upwind (s . d < 0) and
// beyond +-30 degrees; the mean lean along the wind L, the plants' own temporal deviation along and
// across it (RMS over plants), and their ratios; the swing alone (s . d less the lean `windField`
// gives at the root: what the plant adds to the gusts' lean), against L and the across sway; between neighbouring plants, by distance bin, the
// mean correlation of their along-wind series, raw ("total", uncentred cosine: lean and swing) and
// Pearson ("swing", each series less its mean), over all pairs, pairs separated along the wind
// (within 30 degrees of it) and across it (within 30 degrees of square); and the Pearson
// correlation of the swing alone, the same way (`swingCorrelation`). The gust field itself on
// a grid over the land: its correlation length along and across the wind (lag where the
// autocorrelation of `field.w` falls under 1/e), its travel velocity (the peak of the
// cross-correlation between slow steps, against the wind's), and the share of the land in a gust
// (w > 0.5), over the land's box along and across the wind (`gustSpan`: a square of that side
// about its centre instead, for lengths the land is too small to show). `gust.sea`: the sea's gusts
// (SeaDetail.ts `gustOf`, the water's own function, with the island's gust and the air's
// displacement of each step) on a grid over the land's box grown by `seaMargin` metres (`seaGrid`
// apart), with the meadow's gust on the same grid: each one's travel and correlation lengths, and
// their Pearson correlation by distance from the land's box (1 where the sea's gusts are the
// meadow's, falling to tidewater's own pattern far out). `natural`: each kind's
// natural sway frequency (Hz, the same in every wind). `w4`: every vegetation mesh and palm,
// whether its material has a wind displacement.
// `w5` (scene jumps and seeks, so last): for each kept weather and a few presets where every part
// travels, as angles and speeds: the vegetation's wind, the weather's heading, the sea and its
// swell (the FFT's headings), the open sea's gusts (SeaDetail.ts: the air's displacement times
// OPEN_DRIFT; around the island they are the meadow's, `gust.sea`), the sea fog (the air's
// displacement), the cumulus (their weather map
// and shape noise drift together; `evolve` moves the shape vertically, in place) and the cirrus,
// each by minus the change of its sampling offset (Clouds.ts `layerOffsets`). The drifts are
// read off the page across a seek of 1 s (`setTime`), so they are the page's own, and every gap is
// to the vegetation's wind.

type V2 = THREE.Node<'vec2'>;
type V4 = THREE.Node<'vec4'>;

export interface WindProbeContext {

	renderer: THREE.WebGPURenderer;
	scene: THREE.Scene;
	shared: Shared;
	wind: Wind;
	weather: { state: { windSpeed: number; windDirection: number; gustiness: number } };
	sky: { clouds: { frontAxis?: { value: THREE.Vector2 }; cirrusAxis?: { value: THREE.Vector2 }; layerOffsets?: () => { cumulus: THREE.Vector2; cirrus: THREE.Vector2 } } };
	fft: { params: { windDirection: number }; swell: { directionOffset: number } };
	establishScene: ( scene: never ) => Promise<unknown>; // main.ts's, with { weather, preset }
	setTime: ( t: number ) => Promise<unknown>; // main.ts's seek of the scene clock
	data: () => WorldData;
	vegetation: Vegetation;
	seaDetail: SeaDetail;
	land: () => Bounds; // the land's box (WorldShapes.landBounds)

}

interface Series { steps: number; dt: number }
interface Options {
	tufts: number; fast: Series; slow: Series; anchors: number; grid: number;
	w5: boolean; kinds: string[]; seed: number; weathers: string[]; presets: string[]; gustSpan: number;
	seaMargin: number; seaGrid: number;
}
const DEFAULTS: Options = {
	tufts: 20000, fast: { steps: 64, dt: 0.05 }, slow: { steps: 40, dt: 0.5 }, anchors: 1500, grid: 0.5,
	w5: true, kinds: [ 'grass', 'palm' ], seed: 1,
	weathers: [ 'clear', 'fair', 'cloudy', 'overcast' ], presets: [ 'sunrise', 'noon', 'golden-hour', 'midnight' ], gustSpan: 0,
	seaMargin: 160, seaGrid: 3,
};
// vec4s per wind step: the vegetation's wind state, then the air's ( displacement, scene time, 0 )
const STATE = WIND_STATE_VEC4S + 1;
const BINS = [ 0, 0.5, 1, 2, 4, 8, 16 ];
const r3 = ( v: number ) => Math.round( v * 1000 ) / 1000;

function rng( seed: number ) {

	let s = seed >>> 0;
	return () => {

		s = ( s + 0x6d2b79f5 ) >>> 0;
		let t = Math.imul( s ^ ( s >>> 15 ), 1 | s );
		t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

// The page's wind at its scene time, stepped `steps` times by `dt` on a copy: per step its state
// as Wind.ts's packWindState packs it.
function windStates( ctx: WindProbeContext, { steps, dt }: Series ): { states: Float32Array; speed: number; heading: number; direction: THREE.Vector2 } {

	const { speed, heading, gustiness } = ctx.wind;
	const freeze = debugFlags.windFreeze;
	debugFlags.windFreeze = false;
	const copy = new Wind( createWindUniforms(), { speed, heading, gustiness, time: ctx.wind.time } );
	const u = copy.uniforms, states = new Float32Array( steps * STATE * 4 );
	for ( let k = 0; k < steps; k ++ ) {

		if ( k > 0 ) copy.update( dt, speed, heading, gustiness );
		states.set( [ ...packWindState( u ), u.displacement.value.x, u.displacement.value.y, copy.time, 0 ], k * STATE * 4 );

	}
	debugFlags.windFreeze = freeze;
	return { states, speed, heading, direction: u.direction.value.clone() };

}

// d: the local wind's direction times the lean `windField` gives there; `air` the step's
// ( displacement, scene time, 0 )
type Body = ( wind: WindState, input: V4, air: V4 ) => { s: V2; d: V2 };

// One dispatch of `body` for every input and step: out[ plant * steps + k ] = ( s, d ).
async function evaluate( renderer: THREE.WebGPURenderer, inputs: Float32Array, states: Float32Array, steps: number, body: Body ): Promise<Float32Array> {

	const n = inputs.length / 4, total = n * steps;
	const input = instancedArray( inputs, 'vec4' ), state = instancedArray( states, 'vec4' ), out = instancedArray( total, 'vec4' );
	const kernel = Fn( () => {

		const i = instanceIndex;
		If( i.lessThan( uint( total ) ), () => {

			const plant = i.div( uint( steps ) ), k = i.mod( uint( steps ) ).mul( uint( STATE ) );
			const s0 = state.element( k ).toVar(), s1 = state.element( k.add( 1 ) ).toVar(), s2 = state.element( k.add( 2 ) ).toVar();
			const wind = windStateOf( s0, s1, s2 );
			const r = body( wind, input.element( plant ).toVar(), state.element( k.add( 3 ) ).toVar() );
			out.element( i ).assign( vec4( r.s, r.d ) );

		} );

	} )().compute( total, [ 64 ] );
	await renderer.computeAsync( kernel );
	const buffer = await renderer.getArrayBufferAsync( out.value as THREE.StorageBufferAttribute );
	kernel.dispose();
	return new Float32Array( buffer.slice( 0 ) );

}

// The kinds of plant: their inputs ( x, z, two kind values ) and their sway in the kernel.
interface Kind { name: string; inputs: Float32Array; root: Float32Array; body: Body }

function kinds( ctx: WindProbeContext, o: Options ): Kind[] {

	const data = ctx.data(), random = rng( o.seed ), out: Kind[] = [];
	const add = ( name: string, points: number[][], body: Body ) => {

		if ( points.length === 0 ) return;
		const inputs = new Float32Array( points.length * 4 ), root = new Float32Array( points.length * 2 );
		points.forEach( ( p, i ) => { inputs.set( p, i * 4 ); root.set( [ p[ 0 ], p[ 1 ] ], i * 2 ); } );
		out.push( { name, inputs, root, body } );

	};
	if ( o.kinds.includes( 'grass' ) ) {

		// Grass.ts grassMaterial: the blade's phase from its id and a hash of the tuft's origin
		const { lawn: all } = plantGrass( data.vegetation, data.rimGround, undefined, data.shore );
		const keep = Math.min( 1, o.tufts / all.length );
		const points = all.filter( () => random() < keep ).map( ( t ) => [ t.origin.x, t.origin.z, t.top, random() ] );
		add( 'grass', points, ( wind, p ) => {

			const origin = vec3( p.x, 0, p.y ), phase = bladePhase( p.w, rootHash( origin.xz ) );
			const field = windField( wind, origin.xz );
			return { s: bendBlade( wind, vec3( p.x, p.z, p.y ), origin, p.z, float( 1 ), phase ).lean.xz, d: field.xy.mul( field.z ) };

		} );

	}
	if ( o.kinds.includes( 'palm' ) ) {

		// the game's palms, as its view registers them (PalmView.ts `kind`)
		const points: number[][] = [];
		for ( const root of ctx.vegetation.roots( ( kind ) => kind.name === 'palm' ) ) {

			const place = root.userData.palm as { root: THREE.Vector3 };
			points.push( [ place.root.x, place.root.z, place.root.y, 0 ] );

		}
		add( 'palm', points, ( wind, p ) => {

			const root = vec3( p.x, p.z, p.y );
			const bend = mainBend( wind, root.add( vec3( 0, 4, 0 ) ), root, float( 0.3 ), PALM_WIND.cycles, float( PALM_WIND.slow ) );
			return { s: bend.sway, d: bend.field.xy.mul( bend.field.z ) };

		} );

	}
	return out;

}

// ---- statistics on the host

const histogram = ( angles: number[] ) => {

	const bins = new Array( 24 ).fill( 0 );
	for ( const a of angles ) bins[ Math.min( 23, Math.floor( ( a + 180 ) / 15 ) ) ] ++;
	return bins.map( ( c ) => r3( c / Math.max( 1, angles.length ) ) );

};
const angle = ( sx: number, sz: number, dx: number, dz: number ) => Math.atan2( dx * sz - dz * sx, dx * sx + dz * sz ) * 180 / Math.PI;

function sways( kind: Kind, result: Float32Array, steps: number, D: THREE.Vector2, random: () => number, anchors: number ) {

	const n = kind.inputs.length / 4;
	const local: number[] = [], mean: number[] = [];
	let upwind = 0, wide = 0, count = 0, leanSum = 0, varAlong = 0, varAcross = 0, own = 0;
	const along = new Float32Array( n * steps ); // s against the local wind, per plant and step
	const ownSeries = new Float32Array( n * steps ); // less the field's lean: the plant's own swing
	for ( let i = 0; i < n; i ++ ) {

		let a1 = 0, a2 = 0, c1 = 0, c2 = 0;
		for ( let k = 0; k < steps; k ++ ) {

			const o = ( i * steps + k ) * 4, sx = result[ o ], sz = result[ o + 1 ];
			const dl = Math.hypot( result[ o + 2 ], result[ o + 3 ] ) || 1, dx = result[ o + 2 ] / dl, dz = result[ o + 3 ] / dl;
			const a = sx * dx + sz * dz, c = dx * sz - dz * sx;
			own += ( a - dl ) ** 2; // the plant's own swing along the wind: s less the field's lean
			ownSeries[ i * steps + k ] = a - dl;
			along[ i * steps + k ] = a;
			a1 += a; a2 += a * a; c1 += c; c2 += c * c;
			const al = angle( sx, sz, dx, dz );
			local.push( al );
			mean.push( angle( sx, sz, D.x, D.y ) );
			if ( a < 0 ) upwind ++;
			if ( Math.abs( al ) > 30 ) wide ++;
			count ++;

		}
		leanSum += a1;
		varAlong += a2 / steps - ( a1 / steps ) ** 2;
		varAcross += c2 / steps - ( c1 / steps ) ** 2;

	}
	const L = leanSum / count, sAlong = Math.sqrt( Math.max( 0, varAlong / n ) ), sAcross = Math.sqrt( Math.max( 0, varAcross / n ) );
	const swing = Math.sqrt( own / count );
	return {
		plants: n,
		angleLocal: histogram( local ), angleMean: histogram( mean ),
		upwindShare: r3( upwind / count ), beyond30Share: r3( wide / count ),
		lean: r3( L ), sigmaAlong: r3( sAlong ), sigmaAcross: r3( sAcross ),
		sigmaAlongOverLean: r3( sAlong / L ), sigmaAcrossOverLean: r3( sAcross / L ), acrossOverAlong: r3( sAcross / sAlong ),
		// the swing alone (RMS of s . d less the field's lean), against the lean and the across sway
		swingAlong: r3( swing ), swingOverLean: r3( swing / L ), acrossOverSwing: r3( sAcross / swing ),
		correlation: correlations( kind.root, along, steps, D, random, anchors ),
		// the same pairs' correlation of the swing alone (Pearson)
		swingCorrelation: correlations( kind.root, ownSeries, steps, D, rng( 99 ), anchors ),
	};

}

// mean correlation of the along-wind series between plants, by distance bin and direction
function correlations( root: Float32Array, along: Float32Array, steps: number, D: THREE.Vector2, random: () => number, anchors: number ) {

	const n = root.length / 2, cell = 16, grid = new Map<string, number[]>();
	for ( let i = 0; i < n; i ++ ) {

		const key = `${ Math.floor( root[ i * 2 ] / cell ) },${ Math.floor( root[ i * 2 + 1 ] / cell ) }`;
		( grid.get( key ) ?? grid.set( key, [] ).get( key )! ).push( i );

	}
	const stats = ( i: number ) => {

		let m = 0, q = 0;
		for ( let k = 0; k < steps; k ++ ) { const v = along[ i * steps + k ]; m += v; q += v * v; }
		m /= steps;
		return { m, raw: Math.sqrt( q ), dev: Math.sqrt( Math.max( 1e-20, q - steps * m * m ) ) };

	};
	const cache = new Map<number, ReturnType<typeof stats>>();
	const get = ( i: number ) => cache.get( i ) ?? cache.set( i, stats( i ) ).get( i )!;
	const groups = [ 'all', 'along', 'across' ] as const;
	const acc = groups.map( () => BINS.slice( 1 ).map( () => ( { pairs: 0, total: 0, swing: 0 } ) ) );
	const perBin = 4000;
	for ( let a = 0; a < Math.min( anchors, n ); a ++ ) {

		const i = Math.floor( random() * n );
		const xi = root[ i * 2 ], zi = root[ i * 2 + 1 ], gi = Math.floor( xi / cell ), gj = Math.floor( zi / cell );
		for ( let dj = - 1; dj <= 1; dj ++ ) for ( let di = - 1; di <= 1; di ++ ) for ( const j of grid.get( `${ gi + di },${ gj + dj }` ) ?? [] ) {

			if ( j === i ) continue;
			const dx = root[ j * 2 ] - xi, dz = root[ j * 2 + 1 ] - zi, r = Math.hypot( dx, dz );
			const b = BINS.findIndex( ( edge, k ) => k > 0 && r < edge ) - 1;
			if ( b < 0 || acc[ 0 ][ b ].pairs >= perBin ) continue;
			const si = get( i ), sj = get( j );
			let dot = 0;
			for ( let k = 0; k < steps; k ++ ) dot += along[ i * steps + k ] * along[ j * steps + k ];
			const total = dot / ( si.raw * sj.raw || 1 );
			const swing = ( dot - steps * si.m * sj.m ) / ( si.dev * sj.dev );
			const cos = Math.abs( dx * D.x + dz * D.y ) / ( r || 1 );
			for ( const [ g, on ] of [ [ 0, true ], [ 1, cos > Math.cos( Math.PI / 6 ) ], [ 2, cos < Math.sin( Math.PI / 6 ) ] ] as [ number, boolean ][] ) {

				if ( ! on ) continue;
				const e = acc[ g ][ b ];
				e.pairs ++; e.total += total; e.swing += swing;

			}

		}

	}
	return Object.fromEntries( groups.map( ( g, gi ) => [ g, acc[ gi ].map( ( e, b ) => ( {
		bin: `${ BINS[ b ] }-${ BINS[ b + 1 ] } m`, pairs: e.pairs, total: e.pairs ? r3( e.total / e.pairs ) : null, swing: e.pairs ? r3( e.swing / e.pairs ) : null,
	} ) ) ] ) );

}

// The gust field on a grid over the land (axes along and across the mean wind), and the sea's gusts
// around it (`gust.sea`).
async function gustField( ctx: WindProbeContext, o: Options, slow: ReturnType<typeof windStates>, roots: Float32Array ) {

	const D = slow.direction, C = new THREE.Vector2( - D.y, D.x );
	let a0 = Infinity, a1 = - Infinity, c0 = Infinity, c1 = - Infinity;
	for ( let i = 0; i < roots.length; i += 2 ) {

		const a = roots[ i ] * D.x + roots[ i + 1 ] * D.y, c = roots[ i ] * C.x + roots[ i + 1 ] * C.y;
		a0 = Math.min( a0, a ); a1 = Math.max( a1, a ); c0 = Math.min( c0, c ); c1 = Math.max( c1, c );

	}
	if ( o.gustSpan > 0 ) { // a square of that side about the land's centre instead

		const am = ( a0 + a1 ) / 2, cm = ( c0 + c1 ) / 2;
		a0 = am - o.gustSpan / 2; a1 = am + o.gustSpan / 2; c0 = cm - o.gustSpan / 2; c1 = cm + o.gustSpan / 2;

	}
	const meadow = await gustGrid( ctx, o, slow, { a0, a1, c0, c1 }, o.grid, ( wind, p ) => windField( wind, p ).w );
	// the sea's gusts and the meadow's over the land's box grown by seaMargin, in the same frame
	const box = ctx.land(), m = o.seaMargin;
	const corners = [ [ box.x0, box.z0 ], [ box.x1, box.z0 ], [ box.x0, box.z1 ], [ box.x1, box.z1 ] ];
	const along = corners.map( ( [ x, z ] ) => x * D.x + z * D.y ), across = corners.map( ( [ x, z ] ) => x * C.x + z * C.y );
	const seaBox = { a0: Math.min( ...along ) - m, a1: Math.max( ...along ) + m, c0: Math.min( ...across ) - m, c1: Math.max( ...across ) + m };
	const detail = ctx.seaDetail;
	const sea = await gustGrid( ctx, o, slow, seaBox, o.seaGrid, ( wind, p, air ) => detail.gustOf( p, gustAt( wind, p ), air.xy, air.z ) );
	const land = await gustGrid( ctx, o, slow, seaBox, o.seaGrid, ( wind, p ) => gustAt( wind, p ) );
	// Pearson correlation of the two by distance outside the land's box (0: over it)
	const bands = [ 0, 1e-6, 60, 140, 220, Infinity ];
	const acc = bands.slice( 1 ).map( () => ( { n: 0, x: 0, y: 0, xx: 0, yy: 0, xy: 0 } ) );
	for ( let j = 0; j < sea.nc; j ++ ) for ( let i = 0; i < sea.na; i ++ ) {

		const a = seaBox.a0 + i * sea.h, c = seaBox.c0 + j * sea.h;
		const x = a * D.x + c * C.x, z = a * D.y + c * C.y;
		const out = Math.hypot( Math.max( box.x0 - x, 0, x - box.x1 ), Math.max( box.z0 - z, 0, z - box.z1 ) );
		const b = bands.findIndex( ( edge, k ) => k > 0 && out < edge ) - 1;
		const e = acc[ b < 0 ? 0 : b ];
		for ( let k = 0; k < sea.steps; k ++ ) {

			const u = sea.w( i, j, k ), v = land.w( i, j, k );
			e.n ++; e.x += u; e.y += v; e.xx += u * u; e.yy += v * v; e.xy += u * v;

		}

	}
	const withMeadow = acc.map( ( e, b ) => {

		const cov = e.xy / e.n - e.x / e.n * ( e.y / e.n ), vx = e.xx / e.n - ( e.x / e.n ) ** 2, vy = e.yy / e.n - ( e.y / e.n ) ** 2;
		return { band: b === 0 ? 'over the land' : `${ bands[ b ] < 1 ? 0 : bands[ b ] }-${ bands[ b + 1 ] } m`, samples: e.n, correlation: e.n ? r3( cov / Math.sqrt( vx * vy ) ) : null };

	} );
	return {
		...meadow.stats,
		sea: { margin: m, gust: sea.stats, meadowOnSameGrid: land.stats, withMeadow },
	};

}

// One gust field `sample` on a grid of cell h over a box along ( a ) and across ( c ) the mean wind,
// over the slow steps: its values ( `w( i, j, k )` ) and statistics.
async function gustGrid( ctx: WindProbeContext, o: Options, slow: ReturnType<typeof windStates>, box: { a0: number; a1: number; c0: number; c1: number },
	h: number, sample: ( wind: WindState, p: V2, air: V4 ) => THREE.Node<'float'> ) {

	const D = slow.direction, C = new THREE.Vector2( - D.y, D.x );
	const { a0, a1, c0, c1 } = box;
	const na = Math.floor( ( a1 - a0 ) / h ) + 1, nc = Math.floor( ( c1 - c0 ) / h ) + 1, steps = o.slow.steps;
	const inputs = new Float32Array( na * nc * 4 );
	for ( let j = 0; j < nc; j ++ ) for ( let i = 0; i < na; i ++ ) {

		const a = a0 + i * h, c = c0 + j * h;
		inputs.set( [ a * D.x + c * C.x, a * D.y + c * C.y, 0, 0 ], ( j * na + i ) * 4 );

	}
	const out = await evaluate( ctx.renderer, inputs, slow.states, steps, ( wind, p, air ) => ( { s: vec2( 0, sample( wind, p.xy, air ) ), d: vec2( 0 ) } ) );
	const w = ( i: number, j: number, k: number ) => out[ ( ( j * na + i ) * steps + k ) * 4 + 1 ];
	let mean = 0, gusty = 0;
	for ( let j = 0; j < nc; j ++ ) for ( let i = 0; i < na; i ++ ) for ( let k = 0; k < steps; k ++ ) { const v = w( i, j, k ); mean += v; if ( v > 0.5 ) gusty ++; }
	const N = na * nc * steps;
	mean /= N;
	let variance = 0;
	for ( let j = 0; j < nc; j ++ ) for ( let i = 0; i < na; i ++ ) for ( let k = 0; k < steps; k ++ ) variance += ( w( i, j, k ) - mean ) ** 2;
	variance /= N;
	// autocorrelation along a (di) and across c (dj), over every row and step
	const auto = ( di: number, dj: number ) => {

		let s = 0, c = 0;
		for ( let k = 0; k < steps; k += 4 ) for ( let j = 0; j + dj < nc; j ++ ) for ( let i = 0; i + di < na; i ++ ) { s += ( w( i, j, k ) - mean ) * ( w( i + di, j + dj, k ) - mean ); c ++; }
		return c ? s / c / variance : 0;

	};
	const length = ( along: boolean ) => {

		let prev = 1;
		const max = Math.floor( ( along ? na : nc ) * 0.6 );
		for ( let l = 1; l < max; l ++ ) {

			const r = along ? auto( l, 0 ) : auto( 0, l );
			if ( r < 1 / Math.E ) return r3( ( l - 1 + ( prev - 1 / Math.E ) / ( prev - r ) ) * h );
			prev = r;

		}
		return null;

	};
	// travel: the shift ( da, dc ) of the field between steps k and k + m, by the peak of the
	// cross-correlation, refined by a parabola
	const travel = ( m: number ) => {

		const range = Math.ceil( slow.speed * 1.6 * o.slow.dt * m / h ) + 2, across = Math.ceil( 3 / h );
		let best = - Infinity, bi = 0, bj = 0;
		const score = new Map<string, number>();
		const corr = ( di: number, dj: number ) => {

			let s = 0, c = 0;
			for ( let k = 0; k + m < steps; k += 2 ) for ( let j = Math.max( 0, - dj ); j < nc - Math.max( 0, dj ); j += 2 ) for ( let i = Math.max( 0, - di ); i < na - Math.max( 0, di ); i += 2 ) {

				s += ( w( i, j, k ) - mean ) * ( w( i + di, j + dj, k + m ) - mean ); c ++;

			}
			return c ? s / c / variance : - Infinity;

		};
		for ( let dj = - across; dj <= across; dj ++ ) for ( let di = - range; di <= range; di ++ ) {

			const v = corr( di, dj );
			score.set( `${ di },${ dj }`, v );
			if ( v > best ) { best = v; bi = di; bj = dj; }

		}
		const peak = ( a: number | undefined, b: number, c: number | undefined ) => a === undefined || c === undefined || a - 2 * b + c >= 0 ? 0 : 0.5 * ( a - c ) / ( a - 2 * b + c );
		const fi = bi + peak( score.get( `${ bi - 1 },${ bj }` ), best, score.get( `${ bi + 1 },${ bj }` ) );
		const fj = bj + peak( score.get( `${ bi },${ bj - 1 }` ), best, score.get( `${ bi },${ bj + 1 }` ) );
		const t = m * o.slow.dt, va = fi * h / t, vc = fj * h / t;
		return { stepGap: m, seconds: t, along: r3( va ), across: r3( vc ), speed: r3( Math.hypot( va, vc ) ), angleFromWind: r3( Math.atan2( vc, va ) * 180 / Math.PI ), peakCorrelation: r3( best ) };

	};
	return { w, na, nc, h, steps, stats: {
		grid: { along: na, across: nc, cell: h, metres: [ r3( a1 - a0 ), r3( c1 - c0 ) ] },
		meanGust: r3( mean ), gustShare: r3( gusty / N ),
		correlationLength: { along: length( true ), across: length( false ) },
		travel: [ 1, 2, 4 ].map( travel ),
		windSpeed: slow.speed,
	} };

}

// W4: every vegetation mesh and palm, and what its material does with the wind
function inventory( ctx: WindProbeContext ) {

	const rows: Record<string, unknown>[] = [];
	ctx.scene.traverse( ( object ) => {

		const mesh = object as THREE.Mesh;
		if ( ! mesh.isMesh ) return;
		const material = ( Array.isArray( mesh.material ) ? mesh.material[ 0 ] : mesh.material ) as THREE.Material;
		const named = /palm|tree|bush|grass|reed|fern|plant|foliage|leaf|rim/i.test( `${ mesh.name } ${ material.name }` );
		if ( ! material.userData.vegetation && ! mesh.userData.palm && ! windDisplacement( material ) && ! named ) return;
		rows.push( {
			mesh: mesh.name || mesh.type, material: material.name || material.type, parent: mesh.parent?.name,
			vegetationTag: material.userData.vegetation === true, windDisplacement: !! windDisplacement( material ),
			palm: !! mesh.userData.palm, visible: mesh.visible,
		} );

	} );
	return { meshes: rows };

}

// each kind's natural sway frequency, Hz (Wind.ts `swayFrequency`; Deform.ts's numbers)
const naturalFrequencies = () => ( {
	grassAndFlowers: r3( swayFrequency( GRASS_WIND.cycles ) ),
	palm: r3( swayFrequency( PALM_WIND.cycles / 2 ) ), // `slow`: half mainBend's rate
} );

// W5: the directions things travel in, degrees in the world's x-z plane ( atan2( z, x ) ), and
// their speeds (m/s)
async function directions( ctx: WindProbeContext, o: Options ) {

	const deg = ( v: { x: number; y: number } ) => r3( Math.atan2( v.y, v.x ) * 180 / Math.PI );
	const gap = ( a: number, b: number ) => r3( Math.abs( ( ( a - b ) % 360 + 540 ) % 360 - 180 ) );
	const frames = async () => { for ( let i = 0; i < 3; i ++ ) await new Promise( ( resolve ) => requestAnimationFrame( resolve ) ); };
	const clouds = ctx.sky.clouds;
	// what moves the clouds and the fog, as the page drew its last frame
	const read = () => {

		const layers = clouds.layerOffsets?.() ?? { cumulus: new THREE.Vector2(), cirrus: new THREE.Vector2() };
		return { time: ctx.wind.time, ...layers, displacement: ctx.shared.wind.displacement.value.clone() };

	};
	const rows: Record<string, unknown>[] = [];
	for ( const weather of o.weathers ) for ( const preset of o.presets ) {

		await ctx.establishScene( { weather, preset } as never );
		await frames();
		const vegetation = deg( ctx.shared.wind.direction.value );
		// across a seek of one second (more if the page runs), per second
		const a = read();
		await ctx.setTime( a.time + 1 );
		await frames();
		const b = read(), dt = b.time - a.time;
		// each cloud layer is sampled at p + its offset: it drifts by minus the offset's change
		const cumulus = a.cumulus.clone().sub( b.cumulus ).divideScalar( dt );
		const cirrusDrift = a.cirrus.clone().sub( b.cirrus ).divideScalar( dt );
		// the fog is sampled at p - displacement: it drifts by d( displacement ); the open sea's
		// gusts at p - OPEN_DRIFT displacement
		const fog = b.displacement.clone().sub( a.displacement ).divideScalar( dt );
		const seaGusts = fog.clone().multiplyScalar( OPEN_DRIFT );
		// the FFT's heading is the spectrum's; the positive inverse FFT travels opposite it
		const h = ctx.fft.params.windDirection * Math.PI / 180, hs = ( ctx.fft.params.windDirection + ctx.fft.swell.directionOffset ) * Math.PI / 180;
		const sea = deg( { x: - Math.cos( h ), y: - Math.sin( h ) } ), swell = deg( { x: - Math.cos( hs ), y: - Math.sin( hs ) } );
		const heading = ctx.weather.state.windDirection;
		const weatherTravel = deg( { x: - Math.cos( heading * Math.PI / 180 ), y: - Math.sin( heading * Math.PI / 180 ) } );
		const front = clouds.frontAxis?.value, cirrus = clouds.cirrusAxis?.value;
		const travel = { vegetation, weather: weatherTravel, sea, swell, seaGusts: deg( seaGusts ), fog: deg( fog ), cumulus: deg( cumulus ), cirrus: deg( cirrusDrift ),
			cloudFrontAxis: front ? deg( front ) : null, cirrusAxis: cirrus ? deg( cirrus ) : null };
		rows.push( {
			weather, preset, weatherHeading: heading, fftHeading: ctx.fft.params.windDirection,
			windSpeed: ctx.weather.state.windSpeed, gustiness: ctx.weather.state.gustiness,
			travel, speed: { seaGusts: r3( seaGusts.length() ), fog: r3( fog.length() ), cumulus: r3( cumulus.length() ), cirrus: r3( cirrusDrift.length() ) },
			gapToVegetation: Object.fromEntries( Object.entries( travel ).filter( ( [ k, v ] ) => k !== 'vegetation' && v !== null ).map( ( [ k, v ] ) => [ k, gap( v as number, vegetation ) ] ) ),
		} );

	}
	return rows;

}

export async function windProbe( ctx: WindProbeContext, options: Partial<Options> = {} ) {

	const o: Options = { ...DEFAULTS, ...options };
	const t0 = performance.now();
	const fast = windStates( ctx, o.fast ), slow = windStates( ctx, o.slow );
	const list = kinds( ctx, o );
	const plants: Record<string, unknown> = {};
	for ( const kind of list ) {

		const body = kind.body;
		const random = rng( o.seed + 7 );
		const f = await evaluate( ctx.renderer, kind.inputs, fast.states, o.fast.steps, body );
		const s = await evaluate( ctx.renderer, kind.inputs, slow.states, o.slow.steps, body );
		plants[ kind.name ] = { fast: sways( kind, f, o.fast.steps, fast.direction, random, o.anchors ), slow: sways( kind, s, o.slow.steps, slow.direction, random, o.anchors ) };

	}
	const grass = list.find( ( k ) => k.name === 'grass' );
	const gust = grass ? await gustField( ctx, o, slow, grass.root ) : null;
	const w4 = inventory( ctx );
	const time = ctx.wind.time;
	const w5 = o.w5 ? await directions( ctx, o ) : null;
	return {
		time, windSpeed: fast.speed, heading: fast.heading, gustiness: ctx.wind.gustiness, meanDirection: [ r3( fast.direction.x ), r3( fast.direction.y ) ],
		natural: naturalFrequencies(),
		series: { fast: o.fast, slow: o.slow }, plants, gust, w4, w5, ms: Math.round( performance.now() - t0 ),
	};

}

