import * as THREE from 'three/webgpu';
import { Fn, If, float, instanceIndex, instancedArray, uint, vec3, vec4 } from 'three/tsl';
import { Wind, createWindUniforms, packWindState, rootHash, windField, windStateOf, type WindState } from '../weather/Wind.ts';
import { plantGrass } from '../world/Grass.ts';
import { bushInstances } from '../world/Foliage.ts';
import { BUSH_WIND, PALM_WIND, bendBlade, bladePhase, mainBend } from '../world/vegetation/Deform.ts';
import { windDisplacement } from '../weather/Wind.ts';
import { debugFlags } from './DebugFlags.ts';
import type { WorldData } from '../world/types.ts';
import type { Vegetation } from '../world/vegetation/Registry.ts';
import type { Shared } from '../shared.ts';

// `__PONLAI__.windProbe( options )`: the numbers behind the wind view (WindView.ts), as JSON for
// tools/probe.mjs. Every sway comes from the shaders' own TSL functions (Wind.ts `windField`,
// vegetation/Deform.ts `bendBlade` and `mainBend` with each kind's constants), evaluated in a compute kernel built on the first
// call (none exists on a page that never calls it, so the page's pipelines are unchanged), for the
// plants' own inputs: tufts grown as the page grows them (`plantGrass`, sampled; the flowering
// tufts' heads bend as their blades' tips), the rim bushes' roots, the game's palms. The wind is a copy of the page's (`Wind`, the same
// speed, heading and scene time), stepped on the CPU and handed to the kernel per step through a
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
// about its centre instead, for lengths the land is too small to show). `w4`: every vegetation mesh and palm, whether its material has a wind displacement.
// `w5` (scene jumps, so last): for each kept weather and a few presets the
// vegetation's wind, the clouds' drift, the sea's travel and the weather's heading, their angles.

type V2 = THREE.Node<'vec2'>;
type V4 = THREE.Node<'vec4'>;

export interface WindProbeContext {

	renderer: THREE.WebGPURenderer;
	scene: THREE.Scene;
	shared: Shared;
	wind: Wind;
	sky: { weather: { windSpeed: number; windDirection: number }; clouds: { frontAxis?: { value: THREE.Vector2 }; cirrusAxis?: { value: THREE.Vector2 } } };
	fft: { params: { windDirection: number }; swell: { directionOffset: number } };
	establishScene: ( scene: never ) => Promise<unknown>; // main.ts's, with { weather, preset }
	data: () => WorldData;
	vegetation: Vegetation;

}

interface Series { steps: number; dt: number }
interface Options {
	tufts: number; fast: Series; slow: Series; anchors: number; grid: number;
	w5: boolean; kinds: string[]; seed: number; weathers: string[]; presets: string[]; gustSpan: number;
}
const DEFAULTS: Options = {
	tufts: 20000, fast: { steps: 64, dt: 0.05 }, slow: { steps: 40, dt: 0.5 }, anchors: 1500, grid: 0.5,
	w5: true, kinds: [ 'grass', 'bush', 'palm' ], seed: 1,
	weathers: [ 'clear', 'fair', 'cloudy', 'overcast' ], presets: [ 'sunrise', 'noon', 'golden-hour', 'midnight' ], gustSpan: 0,
};
const STATE = 2; // vec4s per wind step
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

// The page's wind at its scene time, stepped `steps` times by `dt` on a copy: per step
// ( direction, pressure, breeze ), ( clock, flutter, gust scroll ) (Wind.ts packWindState).
function windStates( ctx: WindProbeContext, { steps, dt }: Series ): { states: Float32Array; speed: number; heading: number; direction: THREE.Vector2; travel: THREE.Vector2[] } {

	const speed = ctx.sky.weather.windSpeed, heading = ctx.sky.weather.windDirection;
	const freeze = debugFlags.windFreeze;
	debugFlags.windFreeze = false;
	const copy = new Wind( createWindUniforms(), { speed, heading, time: ctx.wind.time } );
	const u = copy.uniforms, states = new Float32Array( steps * STATE * 4 ), travel: THREE.Vector2[] = [];
	for ( let k = 0; k < steps; k ++ ) {

		if ( k > 0 ) copy.update( dt, speed, heading );
		states.set( packWindState( u ), k * STATE * 4 );
		travel.push( u.cloudOffset.value.clone() );

	}
	debugFlags.windFreeze = freeze;
	return { states, speed, heading, direction: u.direction.value.clone(), travel };

}

// d: the local wind's direction times the lean `windField` gives there
type Body = ( wind: WindState, input: V4 ) => { s: V2; d: V2 };

// One dispatch of `body` for every input and step: out[ plant * steps + k ] = ( s, d ).
async function evaluate( renderer: THREE.WebGPURenderer, inputs: Float32Array, states: Float32Array, steps: number, body: Body ): Promise<Float32Array> {

	const n = inputs.length / 4, total = n * steps;
	const input = instancedArray( inputs, 'vec4' ), state = instancedArray( states, 'vec4' ), out = instancedArray( total, 'vec4' );
	const kernel = Fn( () => {

		const i = instanceIndex;
		If( i.lessThan( uint( total ) ), () => {

			const plant = i.div( uint( steps ) ), k = i.mod( uint( steps ) ).mul( uint( STATE ) );
			const s0 = state.element( k ).toVar(), s1 = state.element( k.add( 1 ) ).toVar();
			const wind = windStateOf( s0, s1 );
			const r = body( wind, input.element( plant ).toVar() );
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
		const { lawn: all } = plantGrass( data.vegetation, data.rimGround );
		const keep = Math.min( 1, o.tufts / all.length );
		const points = all.filter( () => random() < keep ).map( ( t ) => [ t.origin.x, t.origin.z, t.top, random() ] );
		add( 'grass', points, ( wind, p ) => {

			const origin = vec3( p.x, 0, p.y ), phase = bladePhase( p.w, rootHash( origin.xz ) );
			const field = windField( wind, origin.xz );
			return { s: bendBlade( wind, vec3( p.x, p.z, p.y ), origin, p.z, float( 1 ), phase ).lean.xz, d: field.xy.mul( field.z ) };

		} );

	}
	if ( o.kinds.includes( 'bush' ) ) {

		const b = bushInstances( data.bushes ), points: number[][] = [];
		for ( let i = 0; i < b.count; i ++ ) points.push( [ b.roots[ i * 4 ], b.roots[ i * 4 + 2 ], b.roots[ i * 4 + 1 ], 0 ] );
		add( 'bush', points, ( wind, p ) => {

			const root = vec3( p.x, p.z, p.y );
			const bend = mainBend( wind, root.add( vec3( 0, 1, 0 ) ), root, float( BUSH_WIND.amplitude ), BUSH_WIND.cycles );
			return { s: bend.sway, d: bend.field.xy.mul( bend.field.z ) };

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

// The gust field on a grid over the land (axes along and across the mean wind).
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
	const h = o.grid, na = Math.floor( ( a1 - a0 ) / h ) + 1, nc = Math.floor( ( c1 - c0 ) / h ) + 1, steps = o.slow.steps;
	const inputs = new Float32Array( na * nc * 4 );
	for ( let j = 0; j < nc; j ++ ) for ( let i = 0; i < na; i ++ ) {

		const a = a0 + i * h, c = c0 + j * h;
		inputs.set( [ a * D.x + c * C.x, a * D.y + c * C.y, 0, 0 ], ( j * na + i ) * 4 );

	}
	const out = await evaluate( ctx.renderer, inputs, slow.states, steps, ( wind, p ) => {

		const field = windField( wind, p.xy );
		return { s: field.zw, d: field.xy };

	} );
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
	return {
		grid: { along: na, across: nc, cell: h, metres: [ r3( a1 - a0 ), r3( c1 - c0 ) ] },
		meanGust: r3( mean ), gustShare: r3( gusty / N ),
		correlationLength: { along: length( true ), across: length( false ) },
		travel: [ 1, 2, 4 ].map( travel ),
		windSpeed: slow.speed,
	};

}

// W4: every vegetation mesh and palm, and what its material does with the wind
function inventory( ctx: WindProbeContext ) {

	const rows: Record<string, unknown>[] = [];
	ctx.scene.traverse( ( object ) => {

		const mesh = object as THREE.Mesh;
		if ( ! mesh.isMesh ) return;
		const material = ( Array.isArray( mesh.material ) ? mesh.material[ 0 ] : mesh.material ) as THREE.Material;
		const named = /palm|tree|bush|grass|reed|fern|plant|foliage|leaf|skirt|rim/i.test( `${ mesh.name } ${ material.name }` );
		if ( ! material.userData.vegetation && ! mesh.userData.palm && ! windDisplacement( material ) && ! named ) return;
		rows.push( {
			mesh: mesh.name || mesh.type, material: material.name || material.type, parent: mesh.parent?.name,
			vegetationTag: material.userData.vegetation === true, windDisplacement: !! windDisplacement( material ),
			palm: !! mesh.userData.palm, visible: mesh.visible,
		} );

	} );
	return { meshes: rows };

}

// W5: the directions things travel in, degrees in the world's x-z plane ( atan2( z, x ) )
async function directions( ctx: WindProbeContext, o: Options ) {

	const deg = ( v: { x: number; y: number } ) => r3( Math.atan2( v.y, v.x ) * 180 / Math.PI );
	const gap = ( a: number, b: number ) => r3( Math.abs( ( ( a - b ) % 360 + 540 ) % 360 - 180 ) );
	const frame = () => new Promise( ( resolve ) => requestAnimationFrame( resolve ) );
	const rows: Record<string, unknown>[] = [];
	for ( const weather of o.weathers ) for ( const preset of o.presets ) {

		await ctx.establishScene( { weather, preset } as never );
		for ( let i = 0; i < 3; i ++ ) await frame();
		const vegetation = deg( ctx.shared.wind.direction.value );
		// the clouds sample their density at p + cloudOffset: they drift by - d( cloudOffset )
		const states = windStates( ctx, { steps: 2, dt: 1 } );
		const drift = states.travel[ 0 ].clone().sub( states.travel[ 1 ] );
		const clouds = deg( drift );
		// the FFT's heading is the spectrum's; the positive inverse FFT travels opposite it
		const h = ctx.fft.params.windDirection * Math.PI / 180, hs = ( ctx.fft.params.windDirection + ctx.fft.swell.directionOffset ) * Math.PI / 180;
		const sea = deg( { x: - Math.cos( h ), y: - Math.sin( h ) } ), swell = deg( { x: - Math.cos( hs ), y: - Math.sin( hs ) } );
		const heading = ctx.sky.weather.windDirection;
		const weatherTravel = deg( { x: - Math.cos( heading * Math.PI / 180 ), y: - Math.sin( heading * Math.PI / 180 ) } );
		const front = ctx.sky.clouds.frontAxis?.value, cirrus = ctx.sky.clouds.cirrusAxis?.value;
		rows.push( {
			weather, preset, weatherHeading: heading, fftHeading: ctx.fft.params.windDirection, windSpeed: ctx.sky.weather.windSpeed,
			travel: { vegetation, weather: weatherTravel, clouds, sea, swell, cloudFrontAxis: front ? deg( front ) : null, cirrusAxis: cirrus ? deg( cirrus ) : null },
			gapToVegetation: { clouds: gap( clouds, vegetation ), sea: gap( sea, vegetation ), swell: gap( swell, vegetation ), weather: gap( weatherTravel, vegetation ) },
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
		time, windSpeed: fast.speed, heading: fast.heading, meanDirection: [ r3( fast.direction.x ), r3( fast.direction.y ) ],
		series: { fast: o.fast, slow: o.slow }, plants, gust, w4, w5, ms: Math.round( performance.now() - t0 ),
	};

}

