import * as THREE from 'three/webgpu';
import {
	Fn, If, attribute, float, vec2, vec3, color, sin, mix, smoothstep, floor, fract, abs, select, dot, max, min,
	cross, positionGeometry, normalGeometry, normalLocal, positionPrevious, cameraPosition, distance, exp, step, length, pow,
} from 'three/tsl';
import { type Shared, type WaveMaps, underwaterLight, UnderwaterLightingModel, TEMPORAL, writeMeter } from '../../render/index.ts';
import { FLOOR_PART } from './FloorGeometry.ts';
import type { FloorPalette } from './FloorSpecies.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

// The material of the sea floor's fixed life.
//
// The material of the sea floor's fixed life, one per kind: placed from its instance, moved by the
// swell, painted from the vertex's data.
//
// The instances carry iPlace ( x, y, z, scale ), iTurn (a unit quaternion: the model's up onto the
// surface it grows on, and its own heading) and iVary ( a random number, the morph, unused, the
// kind's stiffness length in metres ). The vertex stage:
//   - widens a thin blade seen from far (`thin`: the blade's full width at scale 1, m): where the
//     blade is narrower than MIN_PIXELS times the pixel's footprint at the instance, by the ratio,
//     and keeps only that share of the shoots (by their random number), so the meadow keeps its
//     coverage as it recedes instead of breaking into flickering sub-pixel blades (the meadow's
//     grass does the same: world/Grass.ts). The footprint is `pixelAngle` (the view's angle per
//     pixel) times the distance. A dropped shoot collapses to a point before the swell's work.
//   - moves the free parts with the water: under a swell the water near the bed moves back and forth
//     along the swell's heading, its excursion that of linear wave theory, a / sinh( k h ) for a
//     surface amplitude a, wavenumber k at the depth h and the swell's peak frequency (the orbit
//     flattens to a line at the bed; a long swell reaches the bed of the shelf almost whole). The
//     amplitude is the open sea's times the share the surface keeps there (WaveMaps.swellShare:
//     the shallows and the island's lee), so the bed moves with the sea seen over it. A
//     flexible blade goes with the water, its base held: the displacement at an arc length s from the
//     holdfast is the excursion times s^2 / ( s^2 + l^2 ), l the kind's stiffness length (iVary.w),
//     at most 0.7 s, and the point sinks by the displacement's square over twice s, so the blade
//     keeps about its length. The phase runs with the wave, omega t - k x, so the meadow sways in
//     travelling bands; a smaller beat across it is the turbulence of the flow round the plants.
//     FloorLife.ts sets the swell's terms from the sea's spectrum each frame.
// Under the temporal modes the previous position is the same at the previous scene time.
//
// It is lit as everything under the water is (Underwater.ts), its specular at living tissue's share
// under the water (TISSUE_UNDER_WATER), and receives the refracted sun's
// shadow (`refractedSolarReceiver`: RefractedSun.ts bindTerrain), so a reef in the cliff's shadow
// is in shade; it casts into neither map (its sway would not follow there).

/** What the swell does at the bed, set each frame (FloorLife.ts). */
export interface FloorSwell {
	// the travel direction ( x, z ) and the peak angular frequency (rad/s)
	wave: THREE.UniformNode<'vec3', THREE.Vector3>;
	// the surface amplitude (m): a regular wave's of the same energy, the significant height over
	// twice the square root of two
	amplitude: THREE.UniformNode<'float', number>;
	time: THREE.UniformNode<'float', number>;
	previousTime: THREE.UniformNode<'float', number>;
	// the view's angle per pixel (rad)
	pixelAngle: THREE.UniformNode<'float', number>;
}

/** What a painter returns: the albedo (linear) and the roughness. */
export interface FloorSurface { color: V3; rough: F }

/** A painter: from aData, the part, the model's rest position and the morph's colours. */
export type FloorPainter = ( aData: V4, part: F, p: V3, main: V3, tip: V3, seed: F ) => FloorSurface;

// the most the water moves a plant's tip (m): a cap for a storm's swell, far past what a kept
// weather's swell moves at the plants' depths
const MAX_EXCURSION = 0.8;
// The reflectance of living tissue under the water over its reflectance in the air (three's 0.04):
// Fresnel's at normal incidence for an index of about 1.40, ( ( 1.40 - 1.33 ) / ( 1.40 + 1.33 ) )^2.
// At the air's reflectance the sky lay over the leaves and corals as a pale sheen.
export const TISSUE_UNDER_WATER = 0.016;
// the least width of a thin kind's blade on screen (render pixels): a narrower one is widened and
// its shoots thinned to keep the coverage; two, as a blade a pixel wide shades about twice its
// pixels in the GPU's 2x2 quads
const MIN_PIXELS = 2;

const c = ( hex: number ): V3 => color( hex ) as unknown as V3;
// rotates v by the unit quaternion q
const rotateQ = ( q: V4, v: V3 ): V3 => v.add( cross( q.xyz, cross( q.xyz, v ).add( v.mul( q.w ) ) ).mul( 2 ) );
const hash21 = ( p: V2 ): F => fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ).mul( 43758.5453 ) );
const vnoise = ( p: V2 ): F => {

	const i = floor( p ), f = fract( p );
	const w = f.mul( f ).mul( f.mul( - 2 ).add( 3 ) );
	const a = hash21( i ), b = hash21( i.add( vec2( 1, 0 ) ) ), cc = hash21( i.add( vec2( 0, 1 ) ) ), d = hash21( i.add( vec2( 1, 1 ) ) );
	return mix( mix( a, b, w.x ), mix( cc, d, w.x ), w.y );

};
const isPart = ( part: F, id: number ) => abs( part.sub( id ) ).lessThan( 0.5 );
// the morph's colour of a list, by the morph index
const pick = ( list: readonly number[], m: F ): V3 => {

	let out = c( list[ list.length - 1 ] );
	for ( let i = list.length - 2; i >= 0; i -- ) out = select( m.lessThan( i + 0.5 ), c( list[ i ] ), out );
	return out;

};

/** The material of a kind drawn from instances (FloorLife.ts). */
export function makeFloorMaterial( o: { name: string; palette: FloorPalette; paint: FloorPainter; thin?: number; doubleSided?: boolean; shared: Shared; waveMaps: WaveMaps; swell: FloorSwell } ): THREE.MeshStandardNodeMaterial {

	const mat = new THREE.MeshStandardNodeMaterial();
	mat.name = o.name;
	if ( o.doubleSided ) mat.side = THREE.DoubleSide;
	const aData = attribute( 'aData', 'vec4' ), aSide = attribute( 'aSide', 'vec3' );
	const place = attribute( 'iPlace', 'vec4' ), turn = attribute( 'iTurn', 'vec4' ), vary = attribute( 'iVary', 'vec4' );
	const part = floor( aData.y.add( 0.01 ) );
	const S = o.swell;

	// the swell's terms at this vertex that do not change with the time: the wavenumber and the
	// reach of the water's excursion at the point's arc length
	const reachOf = ( share: F ) => {

		const omega = S.wave.z;
		const h = max( o.shared.waterLevel.sub( place.y ), 0.3 );
		// the wavenumber at this depth: Guo's explicit form of omega^2 = g k tanh( k h ) (2002, within
		// 0.75 per cent)
		const x = omega.mul( h.div( 9.81 ).sqrt() );
		const kh = x.mul( x ).mul( pow( float( 1 ).sub( exp( pow( x, 2.5 ).negate() ) ), - 0.4 ) ).toVar();
		const excursion = min( S.amplitude.mul( share ).mul( 2 ).div( exp( kh ).sub( exp( kh.negate() ) ) ), MAX_EXCURSION );
		const s = aData.x.mul( place.w );
		const l = vary.w;
		const reach = min( excursion.mul( s.mul( s ) ).div( s.mul( s ).add( l.mul( l ) ) ), s.mul( 0.7 ) );
		return { k: kh.div( h ).toVar(), reach: reach.toVar(), s: max( s, 0.05 ).toVar() };

	};
	// placed in the world at scene time t, swayed by the swell
	const placed = ( at: V3, t: F, w: { k: F; reach: F; s: F } ): V3 => {

		const dir = S.wave.xy, omega = S.wave.z;
		const phase = omega.mul( t ).sub( w.k.mul( dot( place.xz, dir ) ) ).add( vary.x.mul( 0.8 ) );
		const along = w.reach.mul( sin( phase ) );
		const across = w.reach.mul( 0.18 ).mul( sin( omega.mul( t ).mul( 1.73 ).add( vary.x.mul( 13 ) ).add( w.s.mul( 4 ) ) ) );
		const shift = vec3( dir.x.mul( along ).sub( dir.y.mul( across ) ), along.mul( along ).add( across.mul( across ) ).div( w.s.mul( 2 ) ).negate(), dir.y.mul( along ).add( dir.x.mul( across ) ) );
		return at.add( shift );

	};

	mat.positionNode = Fn( () => {

		normalLocal.assign( rotateQ( turn, normalGeometry ) );
		// the model's point, widened with the distance (a thin kind); a shoot past its share is not
		// drawn: its vertices collapse to one point, without the swell's work
		const p = positionGeometry.toVar();
		const keep = float( 1 ).toVar();
		if ( o.thin ) {

			const footprint = distance( cameraPosition, place.xyz ).mul( S.pixelAngle );
			const widen = max( footprint.mul( MIN_PIXELS ).div( place.w.mul( o.thin ) ), 1 ).toVar();
			keep.assign( step( vary.x, float( 1 ).div( widen ) ) );
			p.addAssign( aSide.mul( widen.sub( 1 ) ) );

		}
		const now = vec3( 0 ).toVar(), before = vec3( 0 ).toVar();
		If( keep.greaterThan( 0.5 ), () => {

			// built here, with the shader: the sea's waves are attached after the world is made
			const w = reachOf( o.waveMaps.swellShare( place.xz ) );
			const at = rotateQ( turn, p.mul( place.w ) ).add( place.xyz ).toVar();
			now.assign( placed( at, S.time, w ) );
			if ( TEMPORAL ) before.assign( placed( at, S.previousTime, w ) );

		} );
		if ( TEMPORAL ) positionPrevious.assign( before );
		return now;

	} )();
	if ( TEMPORAL ) mat.userData.previousPosition = true;

	const seed = vary.x, morph = vary.y;
	const surface = o.paint( aData, part, positionGeometry, pick( o.palette.main, morph ), pick( o.palette.tip, morph ), seed );
	mat.colorNode = surface.color;
	mat.roughnessNode = surface.rough;
	mat.metalnessNode = float( 0 );

	const light = underwaterLight( o.shared, o.waveMaps, { specular: TISSUE_UNDER_WATER } );
	( mat as unknown as { setupLightingModel: () => THREE.LightingModel } ).setupLightingModel = () => new UnderwaterLightingModel( light, { terminator: false } );
	mat.userData.refractedSolarReceiver = true;
	writeMeter( mat );
	return mat;

}

// ------------------------------------------------------------------ painters

/** Eelgrass: the morph's green, paler at the sheath, browner toward the old leaves' tips. */
export const eelgrassPaint = ( rough: number ): FloorPainter => ( aData, _part, _p, main, tip, seed ) => {

	const t = aData.w, leaf = aData.z;
	const old = smoothstep( 0.35, 0.9, fract( leaf.add( seed ) ) );
	let col: V3 = mix( main, main.mul( 1.15 ), leaf );
	col = mix( col, tip, smoothstep( 0.55, 1, t ).mul( old ) );
	col = mix( c( 0xa4a277 ), col, smoothstep( 0.0, 0.08, t ) );
	return { color: col, rough: float( rough ) };

};

/** Kelp: the olive brown blades, wrinkled, the stipe darker. */
export const kelpPaint = ( rough: number ): FloorPainter => ( aData, part, p, main, tip ) => {

	const wrinkle = vnoise( vec2( p.x.add( p.z ).mul( 60 ), p.y.mul( 40 ) ) );
	let col: V3 = mix( main, tip, aData.w.mul( 0.6 ).add( wrinkle.mul( 0.3 ) ) );
	col = select( isPart( part, FLOOR_PART.STIPE ), main.mul( 0.75 ), col );
	return { color: col, rough: float( rough ) };

};

/** A stony coral: the morph's colour over fine corallites, paler toward the rims or tips. */
export const coralPaint = ( rough: number, cells: number, tipFrom: number ): FloorPainter => ( aData, part, p, main, tip ) => {

	const q = vec2( p.x.add( p.y.mul( 0.7 ) ), p.z.sub( p.y.mul( 0.5 ) ) ).mul( cells );
	const cell = vnoise( q ), pit = smoothstep( 0.55, 0.8, vnoise( q.mul( 2.3 ).add( 7.1 ) ) );
	let col: V3 = main.mul( cell.mul( 0.45 ).add( 0.75 ) ).mul( float( 1 ).sub( pit.mul( 0.3 ) ) );
	col = mix( col, tip, smoothstep( tipFrom, 1, aData.w ) );
	// a plate's underside lies in its own shade and grows less
	col = select( isPart( part, FLOOR_PART.PLATE ).and( aData.z.lessThan( 0.5 ) ), col.mul( 0.72 ), col );
	col = select( isPart( part, FLOOR_PART.STALK ), main.mul( 0.8 ), col );
	return { color: col, rough: float( rough ) };

};

/** Dendronephthya: the pale stalk with its red spicules showing through, the coloured polyps. */
export const softCoralPaint = ( rough: number ): FloorPainter => ( _aData, part, p, main, tip ) => {

	const spicules = smoothstep( 0.6, 0.85, vnoise( vec2( p.x.add( p.z ).mul( 140 ), p.y.mul( 90 ) ) ) );
	const stalk = mix( main, tip, spicules.mul( 0.55 ) );
	const col = select( isPart( part, FLOOR_PART.POLYP ), tip, stalk );
	return { color: col, rough: float( rough ) };

};

/** A gorgonian: the morph's colour, the branches' tips a little paler. */
export const seaFanPaint = ( rough: number ): FloorPainter => ( aData, _part, _p, main, tip ) => ( { color: mix( main, tip, aData.w ), rough: float( rough ) } );

/** Diadema: black, the spines faintly banded, an orange ring round the top of the test. */
export const urchinPaint = ( rough: number ): FloorPainter => ( aData, part, p, main, tip ) => {

	const band = smoothstep( 0.4, 0.6, sin( aData.w.mul( 26 ) ) ).mul( 0.25 );
	const spine = main.mul( float( 1 ).add( band ) );
	const ring = smoothstep( 0.006, 0.003, abs( length( p.xz ).sub( 0.009 ) ) ).mul( step( 0.045, p.y ) );
	const test = mix( main, tip, ring );
	return { color: select( isPart( part, FLOOR_PART.SPINE ), spine, test ), rough: float( rough ) };

};
