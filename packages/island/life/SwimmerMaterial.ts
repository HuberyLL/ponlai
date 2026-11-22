/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater), src/world/fish/FishMaterial.js.
 * SPDX-FileCopyrightText: Copyright (c) 2026 DRG Software Solutions LLC
 * SPDX-License-Identifier: MIT
 */

import * as THREE from 'three/webgpu';
import {
	Fn, attribute, float, vec2, vec3, color, sin, cos, mix, smoothstep, floor, fract, abs, sign, select, length, dot, max,
	normalize, cross, positionGeometry, normalGeometry, normalLocal, positionPrevious, atan, pow, step,
} from 'three/tsl';
import { type Shared, type WaveMaps, underwaterLight, UnderwaterLightingModel, TEMPORAL, writeMeter } from '../../render/index.ts';
import { PART, wingRoot, type Anatomy } from './FishGeometry.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

// The material of the sea's creatures, one per kind, posed and painted from the vertex's data.
//
// Drawn from instances (SeaLife.ts), posed in the vertex stage and painted in the fragment stage
// from the vertex's place on the body.
//
// The vertex stage poses the model by how the kind swims (`Motion`), as tidewater's swimVertex
// does (4811ba4):
//   - a fish: a travelling wave down the body that grows toward the tail, sideways, and the
//     turning bend; its paired fins (wings) turn back about their roots by `fold` (the instance's)
//   - a cetacean: the same wave up and down, the flukes beating, as a dolphin's or whale's spine
//     bends in the vertical plane
//   - a stingray: its disc's margins undulate in a wave running back; an eagle ray: its wings flap
//     as a whole; the whip tail trails
//   - the turtle: the front flippers stroke in long beats, the hind ones paddle
// Then it scales, turns and places the creature by its instance (iPose, iTurn: no instance matrix,
// the pose is local), and adds the sway it is given (Water.ts swimmerSway: where the eye sees it
// through the waves). Under the temporal modes the same pose at the instance's previous position
// and phase, with the sway as it is now, is the previous position.
//
// The fragment stage paints the skin from aData (FishGeometry.ts, CreatureGeometry.ts) by the
// kind's painter (FishSkin and the others below): counter-shading, the species' markings and fins,
// a painted eye. A fish's silvery flank is a metal-like specular layer (guanine), so a school that
// turns flashes. It is lit as everything under the water is (Underwater.ts: the key down the water
// column, the ambient dimmer with depth); above the water (a dolphin's back, a turtle's head
// taking a breath), as in the air. Its ambient diffuse is the ambient volume's
// (lighting/AmbientSample.ts) through the model's default, weighted by depth.

/** How a kind swims (the vertex stage's pose). */
export type Motion = 'fish' | 'cetacean' | 'stingray' | 'eagleRay' | 'turtle';

/** What a painter returns: the albedo (linear), the metalness and the roughness. */
export interface Surface { color: V3; metal: F; rough: F }

/** A painter: the surface from aData, the part and the rest position (the model's units). */
export type Painter = ( aData: V4, part: F, p: V3 ) => Surface;

/** A wing's rays turn back to this share of their spread angle when folded. */
const FOLD = 0.1;

// rotates v by the unit quaternion q
const rotateQ = ( q: V4, v: V3 ): V3 => v.add( cross( q.xyz, cross( q.xyz, v ).add( v.mul( q.w ) ) ).mul( 2 ) );

// turns v about the vertical by angle a; about the body's cross axis (x) by angle a
const turnY = ( v: V3, a: F ) => vec3( v.x.mul( cos( a ) ).add( v.z.mul( sin( a ) ) ), v.y, v.z.mul( cos( a ) ).sub( v.x.mul( sin( a ) ) ) );
const turnX = ( v: V3, a: F ) => vec3( v.x, v.y.mul( cos( a ) ).sub( v.z.mul( sin( a ) ) ), v.y.mul( sin( a ) ).add( v.z.mul( cos( a ) ) ) );

// a cheap hash and value noise for blotches and markings
const hash21 = ( p: V2 ): F => fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ).mul( 43758.5453 ) );
const vnoise = ( p: V2 ): F => {

	const i = floor( p ), f = fract( p );
	const w = f.mul( f ).mul( f.mul( - 2 ).add( 3 ) );
	const a = hash21( i ), b = hash21( i.add( vec2( 1, 0 ) ) ), c = hash21( i.add( vec2( 0, 1 ) ) ), d = hash21( i.add( vec2( 1, 1 ) ) );
	return mix( mix( a, b, w.x ), mix( c, d, w.x ), w.y );

};

const c = ( hex: number ): V3 => color( hex ) as unknown as V3;
const isPart = ( part: F, id: number ) => abs( part.sub( id ) ).lessThan( 0.5 );

/** The material for a mesh whose instances carry iPose ( x, y, z, length ), iTurn (quaternion),
 * iMotion ( phase, amplitude, bend, fold ) and iBefore ( the previous x, y, z, phase ). `anatomy`:
 * a lofted kind's table (its wings fold about their roots); `sway`: an offset added to each placed
 * vertex (the water's swimmerSway). */
export function makeSwimmerMaterial( o: { name: string; motion: Motion; paint: Painter; anatomy?: Anatomy; shared: Shared; waveMaps: WaveMaps; sway?: ( at: V3 ) => V3 } ): THREE.MeshStandardNodeMaterial {

	const mat = new THREE.MeshStandardNodeMaterial();
	mat.name = o.name;
	const aData = attribute( 'aData', 'vec4' );
	const pose = attribute( 'iPose', 'vec4' ), turn = attribute( 'iTurn', 'vec4' );
	const motion = attribute( 'iMotion', 'vec4' ), before = attribute( 'iBefore', 'vec4' );
	const part = floor( aData.y.add( 0.01 ) );
	const u = aData.x;
	const S = o.anatomy;

	// the model at a phase of its stroke
	const posed = ( phase: F ): { p: V3; n: V3 } => {

		const p = positionGeometry.toVar(), n = normalGeometry.toVar();
		if ( o.motion === 'fish' || o.motion === 'cetacean' ) {

			// the paired fins fold back about their roots
			if ( S ) for ( const [ id, W ] of [ [ PART.PECTORAL, S.pectoral ], [ PART.PELVIC, S.pelvic ] ] as const ) {

				if ( W.rays === 0 ) continue;
				const t = aData.w.div( Math.max( W.rays - 1, 1 ) );
				const spread = mix( float( W.lead ), float( W.last ), t );
				const side = sign( p.x );
				const angle = spread.mul( 1 - FOLD ).mul( motion.w ).mul( side ).mul( select( isPart( part, id ), 1, 0 ) );
				const pivot = vec3( side.mul( wingRoot( S, W ) ), W.y, 0.5 - W.u * S.body );
				p.assign( turnY( p.sub( pivot ), angle ).add( pivot ) );
				n.assign( turnY( n, angle ) );

			}
			// the travelling wave, larger toward the tail, and the turn's bend (sideways for a
			// fish, up and down for a cetacean, whose wave is longer: the body rides it whole and the
			// flukes beat)
			const k = o.motion === 'fish' ? 5.6 : 2.4;
			const env = o.motion === 'fish'
				? u.mul( u ).mul( 0.85 ).add( 0.08 ).mul( smoothstep( 0, 0.25, u ).mul( 0.7 ).add( 0.3 ) )
				: u.mul( u ).mul( u ).mul( 0.9 ).add( 0.04 );
			const wave = phase.sub( u.mul( k ) );
			const swing = sin( wave ).mul( env ).mul( motion.y );
			const slope = cos( wave ).mul( - k ).mul( env ).mul( motion.y );
			const bend = motion.z.mul( u.mul( u ) ), bendSlope = motion.z.mul( u ).mul( 2 );
			if ( o.motion === 'fish' ) {

				p.assign( p.add( vec3( swing.add( bend ), 0, 0 ) ) );
				n.assign( turnY( n, slope.add( bendSlope ).negate().atan() ) );

			} else {

				p.assign( p.add( vec3( bend, swing, 0 ) ) );
				n.assign( turnX( turnY( n, bendSlope.negate().atan() ), slope.atan() ) );

			}

		} else if ( o.motion === 'stingray' || o.motion === 'eagleRay' ) {

			// the disc's margins: a wave running back (a stingray's, several along the disc) or a
			// flap of the whole wing (an eagle ray's), growing toward the tips
			const eagle = o.motion === 'eagleRay';
			const k = eagle ? 1.2 : 8.0;
			const side = aData.z;
			const wave = phase.sub( u.mul( k ) );
			const reach = pow( max( side, 0 ), 1.6 );
			const disc = isPart( part, PART.DISC ).or( isPart( part, PART.EYE ) );
			const lift = sin( wave ).mul( reach ).mul( motion.y ).mul( select( disc, 1, 0 ) );
			// its slope across the wing tilts the normal about the body's axis
			const slopeX = sin( wave ).mul( 1.6 ).mul( pow( max( side, 1e-3 ), 0.6 ) ).mul( motion.y ).mul( 2 ).mul( sign( p.x ) ).mul( select( disc, 1, 0 ) );
			// the whip trails, swinging a little
			const whip = isPart( part, PART.WHIP );
			const trail = sin( phase.mul( 0.5 ).sub( u.mul( 3 ) ) ).mul( u.sub( 0.4 ).max( 0 ) ).mul( 0.08 ).mul( select( whip, 1, 0 ) );
			p.assign( p.add( vec3( trail.add( motion.z.mul( u.mul( u ) ) ), lift, 0 ) ) );
			// (the back's normal leans against the slope, the belly's with it)
			n.assign( normalize( n.add( vec3( slopeX.negate().mul( n.y ), 0, 0 ) ) ) );

		} else {

			// the turtle: the front flippers stroke down and back (an underwater flight), the hind
			// ones paddle; each about its shoulder, growing toward its tip
			const flip = isPart( part, PART.FLIPPER );
			const front = aData.w.lessThan( 1.5 );
			const along = aData.z;
			const beat = vec3( 0, sin( phase ).mul( select( front, 0.3, 0.07 ) ), cos( phase ).mul( select( front, 0.14, 0.0 ) ) ).mul( along ).mul( motion.y );
			p.assign( p.add( beat.mul( select( flip, 1, 0 ) ) ) );
			n.assign( turnX( n, sin( phase.add( 1.57 ) ).mul( 0.6 ).mul( along ).mul( motion.y ).mul( select( flip.and( front ), 1, 0 ) ) ) );

		}
		return { p, n: normalize( n ) };

	};
	const place = ( p: V3, at: V3 ) => {

		const placed = rotateQ( turn, p.mul( pose.w ) ).add( at ).toVar();
		return o.sway ? placed.add( o.sway( placed ) ) : placed;

	};

	mat.positionNode = Fn( () => {

		const now = posed( motion.x );
		normalLocal.assign( rotateQ( turn, now.n ) );
		if ( TEMPORAL ) positionPrevious.assign( place( posed( before.w ).p, before.xyz ) );
		return place( now.p, pose.xyz );

	} )();
	if ( TEMPORAL ) mat.userData.previousPosition = true;

	const surface = o.paint( aData, part, positionGeometry );
	mat.colorNode = surface.color;
	mat.metalnessNode = surface.metal;
	mat.roughnessNode = surface.rough;

	const light = underwaterLight( o.shared, o.waveMaps );
	( mat as unknown as { setupLightingModel: () => THREE.LightingModel } ).setupLightingModel = () => new UnderwaterLightingModel( light, { terminator: false } );
	writeMeter( mat );
	return mat;

}

// ------------------------------------------------------------------ fish

/** A fish's skin (sRGB hex colours). `pattern`: the markings over the counter-shading. */
export interface FishSkin {
	back: number; flank: number; belly: number; fin: number; finEdge: number; iris: number;
	// the guanine's silver on the flank (0 none .. 1 a mirror-sided fish) and the roughness
	silver: number; rough: number;
	// the head's colour and where it ends (fraction of the total length); none: the body's
	head?: { color: number; end: number };
	// the eye: its place along the fish and height (fractions of the total length) and radius
	eye: { u: number; y: number; r: number };
	pattern?:
		| { kind: 'bars'; color: number } // broken dark bars across the back
		| { kind: 'stripes'; color: number; count: number } // thin dark lines along the flank
		| { kind: 'band'; color: number; h: number; width: number } // one band along the flank
		| { kind: 'spotRow'; color: number; h: number; count: number } // a row of dark spots along the flank
		| { kind: 'chequer'; color: number }; // a whale shark's pale spots and stripes over the back
}

/** The painter of a lofted fish (or a whale shark, or a cetacean with `silver` 0). */
export function fishSkin( skin: FishSkin ): Painter {

	return ( aData, part, p ) => {

		const u = aData.x, h = aData.w, arc = aData.z;
		const body = isPart( part, PART.BODY );
		// counter-shading: the pale belly, the flank, the dark back over the upper half
		const flank = mix( c( skin.belly ), c( skin.flank ), smoothstep( - 0.7, - 0.05, h ) );
		const backShare = smoothstep( - 0.1, 0.35, h );
		let col: V3 = mix( flank, c( skin.back ), backShare );
		const P = skin.pattern;
		if ( P?.kind === 'bars' ) {

			const bars = sin( u.mul( 46 ).add( sin( arc.mul( 31 ).add( u.mul( 9 ) ) ).mul( 1.4 ) ) ).mul( 0.5 ).add( 0.5 );
			col = mix( col, c( P.color ), smoothstep( 0.62, 0.8, bars ).mul( smoothstep( 0.1, 0.4, h ) ).mul( smoothstep( 0.18, 0.24, u ) ) );

		} else if ( P?.kind === 'stripes' ) {

			const lines = abs( fract( h.mul( P.count ).add( 0.5 ) ).sub( 0.5 ) );
			col = mix( col, c( P.color ), float( 1 ).sub( smoothstep( 0.08, 0.2, lines ) ).mul( smoothstep( - 0.6, - 0.2, h ) ).mul( smoothstep( 0.2, 0.3, u ) ).mul( 0.55 ) );

		} else if ( P?.kind === 'band' ) {

			col = mix( col, c( P.color ), float( 1 ).sub( smoothstep( P.width * 0.6, P.width, abs( h.sub( P.h ) ) ) ).mul( smoothstep( 0.08, 0.16, u ) ) );

		} else if ( P?.kind === 'spotRow' ) {

			const q = fract( u.mul( P.count ) ).sub( 0.5 );
			const spot = float( 1 ).sub( smoothstep( 0.18, 0.32, length( vec2( q, h.sub( P.h ).mul( 2.5 ) ) ) ) );
			col = mix( col, c( P.color ), spot.mul( smoothstep( 0.22, 0.28, u ) ).mul( float( 1 ).sub( smoothstep( 0.5, 0.6, u ) ) ) );

		} else if ( P?.kind === 'chequer' ) {

			// pale spots in loose rows between fainter pale stripes across the back: cells some 15 cm
			// along a whale shark's length and round its girth, a spot in most, of varied size, placed
			// anywhere in its cell
			const g = vec2( u.mul( 40 ), arc.mul( 34 ) );
			const cell = floor( g ), f = fract( g ).sub( 0.5 );
			const jit = vec2( hash21( cell ), hash21( cell.add( 7.3 ) ) ).sub( 0.5 ).mul( 0.55 );
			const r = hash21( cell.add( 3.1 ) ).mul( 0.12 ).add( 0.1 );
			const kept = step( 0.22, hash21( cell.add( 5.7 ) ) );
			const spot = float( 1 ).sub( smoothstep( r, r.add( 0.08 ), length( f.sub( jit ) ) ) ).mul( kept );
			const stripe = float( 1 ).sub( smoothstep( 0.04, 0.09, abs( fract( u.mul( 14 ).add( sin( arc.mul( 9 ) ).mul( 0.15 ) ) ).sub( 0.5 ) ) ) ).mul( smoothstep( 0.2, 0.3, u ) );
			col = mix( col, c( P.color ), max( spot.mul( 0.85 ), stripe.mul( 0.45 ) ).mul( smoothstep( - 0.35, 0.1, h ) ) );

		}
		if ( skin.head ) col = mix( col, c( skin.head.color ), float( 1 ).sub( smoothstep( skin.head.end - 0.025, skin.head.end + 0.01, u ) ) );
		// the painted eye on each side of the head
		const eye = length( p.zy.sub( vec2( 0.5 - skin.eye.u, skin.eye.y ) ) ).div( skin.eye.r );
		col = mix( col, c( skin.iris ), float( 1 ).sub( smoothstep( 0.85, 1, eye ) ) );
		col = mix( col, c( 0x07090b ), float( 1 ).sub( smoothstep( 0.42, 0.55, eye ) ) );
		// the fins: darker toward the edge, the rays a shade darker than the membrane between them
		const ray = abs( fract( aData.w.add( 0.5 ) ).sub( 0.5 ) );
		const fin = mix( c( skin.fin ), c( skin.finEdge ), smoothstep( 0.45, 1, aData.z ) ).mul( mix( 0.78, 1, smoothstep( 0.05, 0.22, ray ) ) );
		// the guanine's silver on the flank, little on the back and none on the fins
		const silver = smoothstep( - 0.8, - 0.1, h ).mul( float( 1 ).sub( backShare.mul( 0.75 ) ) ).mul( skin.silver );
		return {
			color: select( body, col, fin ),
			metal: select( body, silver.mul( 0.6 ), float( 0 ) ),
			rough: select( body, mix( float( skin.rough ), float( 0.24 ), silver ), float( Math.max( skin.rough, 0.45 ) ) ),
		};

	};

}

// ------------------------------------------------------------------ rays and the turtle

/** A ray's skin: the back mottled (or plain), the belly pale. */
export function raySkin( o: { back: number; mottle: number; margin: number; belly: number; rough: number } ): Painter {

	return ( aData, part, p ) => {

		const top = aData.w.greaterThan( 0 );
		const mottle = vnoise( p.xz.mul( 34 ) ).mul( 0.35 ).add( vnoise( p.xz.mul( 9 ) ).mul( 0.3 ) ).add( 0.55 );
		let dorsal: V3 = mix( c( o.back ), c( o.mottle ), smoothstep( 0.55, 0.9, mottle ) ).mul( mix( 0.85, 1.1, mottle ) );
		dorsal = mix( dorsal, c( o.margin ), smoothstep( 0.75, 1.0, aData.z ).mul( 0.5 ) );
		const col = select( top, dorsal, c( o.belly ) );
		const eye = isPart( part, PART.EYE );
		return { color: select( eye, c( 0x0a0a08 ), select( isPart( part, PART.WHIP ), c( o.back ).mul( 0.7 ), col ) ), metal: float( 0 ), rough: select( eye, float( 0.15 ), float( o.rough ) ) };

	};

}

/** The green turtle: the carapace's scutes with dark seams and radiating streaks, scaled skin, a
 * pale plastron. */
export function turtleSkin( o: { shell: number; streak: number; skin: number; scale: number; plastron: number } ): Painter {

	return ( aData, part, p ) => {

		// the carapace (tidewater's scutes: a vertebral row, the costals, the marginals)
		const X = aData.z, Y = aData.w;
		const ax = abs( X ), rr = length( vec2( X, Y ) );
		const vert = ax.lessThan( 0.3 );
		const yc = Y.add( ax.mul( ax ).mul( 0.25 ) );
		const seamsA = [ - 0.42, - 0.02, 0.36, 2.0 ], seamsB = [ - 0.58, - 0.22, 0.14, 0.5 ];
		let dY: F = float( 10 );
		for ( let i = 0; i < 4; i ++ ) dY = dY.min( abs( yc.sub( select( vert, float( seamsB[ i ] ), float( seamsA[ i ] ) ) ) ) );
		const dX = abs( ax.sub( 0.3 ) );
		const angle = atan( Y, X );
		const dM = abs( rr.sub( 0.84 ) ).min( abs( fract( angle.mul( 12 / Math.PI ) ).sub( 0.5 ) ).mul( 0.25 ) );
		const seam = select( rr.greaterThan( 0.84 ), dM, dY.min( dX ) ).min( abs( rr.sub( 0.84 ) ) );
		const n2 = vnoise( vec2( X, Y ).mul( 5 ) );
		const streak = sin( atan( yc.sub( floor( yc.mul( 2.8 ) ).add( 0.5 ).div( 2.8 ) ), X.sub( sign( X ).mul( 0.55 ) ) ).mul( 11 ).add( n2.mul( 6 ) ) ).mul( 0.5 ).add( 0.5 );
		const blotch = smoothstep( 0.45, 0.8, vnoise( vec2( X, Y ).mul( 9 ) ) );
		const shell = mix( c( o.shell ), c( o.streak ), streak.mul( 0.55 ).add( blotch.mul( 0.45 ) ) ).mul( mix( 0.45, 1, smoothstep( 0.003, 0.012, seam ) ) );
		// the skin: scales some 3 cm across on a metre-long turtle, with thin pale margins, of
		// varied size and tone; the plastron pale
		const q = vec2( p.x.add( p.y ), p.z ).mul( 34 ).add( vec2( vnoise( p.xz.mul( 40 ) ), vnoise( p.zx.mul( 40 ) ) ).mul( 0.35 ) );
		const row = floor( q.y );
		const q2 = q.add( vec2( row.mul( 0.5 ), 0 ) );
		const ff = fract( q2 ).sub( 0.5 );
		const scale = smoothstep( 0.4, 0.49, abs( ff.x ).max( abs( ff.y ) ) );
		const tone = hash21( floor( q2 ) ).mul( 0.35 ).add( 0.8 );
		const skin = mix( c( o.skin ).mul( tone ), c( o.scale ), scale.mul( 0.18 ) );
		const plastron = isPart( part, PART.SKIN ).and( aData.w.greaterThan( 1.5 ) );
		const carapace = isPart( part, PART.CARAPACE );
		const eye = isPart( part, PART.EYE );
		const col = select( carapace, shell, select( plastron, c( o.plastron ), skin ) );
		return { color: select( eye, c( 0x0a0806 ), col ), metal: float( 0 ), rough: select( carapace, float( 0.35 ), select( eye, float( 0.1 ), float( 0.5 ) ) ) };

	};

}
