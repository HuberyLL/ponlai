import * as THREE from 'three/webgpu';
import {
	attribute, float, vec3, vec4, mix, uniform, instanceIndex, select, positionGeometry, normalGeometry, normalLocal, materialColor, clamp, dot, pow, varying, cameraWorldMatrix, max, length, normalViewGeometry, faceDirection, cameraPosition, fract, sin, vec2, step,
} from 'three/tsl';
import { mainBend, leafFlutter, swayFade } from './vegetation/Deform.ts';
import { screenShareNode } from './vegetation/Lod.ts';
import { leafTransmission, vegetationMaterial } from './vegetation/Material.ts';
import { LeafPainter, type LeafAtlas } from './vegetation/TreeSurfaces.ts';
import { MeshBuilder, UP } from './vegetation/TreeMesh.ts';
import { VegetationCull, poolBuffers, poolSteps, type CullBuffers, type CullPayload, type CullPool, type CullRange } from './vegetation/VegetationCull.ts';
import { mulberry32, type Rng } from './noise.ts';
import { debugFlags } from '../debug/DebugFlags.ts';
import type { Shared } from '../shared.ts';

// The meadow's flowers as whole plants, in swaths of one kind (Grass.ts FlowerSwaths decides where,
// and gives every species a swath on an island of two or more): a plant artists would author,
// drawn as instances that the GPU culls (vegetation/VegetationCull.ts), a technique
// Eric Wohllaib presented in Procedural Grass in Ghost of Tsushima, GDC 2021. From the
// game's view a swath is one stroke of colour, its flowers covering about a third of its middle
// (Grass.ts PLANT_SHARE: the green shows between them). Penglai's, after the immortals' islands:
// - The yaoxiang (遙香草) of Daiyu, "its flowers like cinnabar, shining to the moon, its leaves long,
//   narrow and white, like the day lily's" (Wang Jia, Shiyi ji, book 10): a day lily's clump, a
//   fountain of narrow, pale silvery leaves and two to four scapes over the sward, each holding
//   three to six cinnabar trumpets out at a slant, each its own way (the face, and the trumpet
//   behind it from the pedicel), dark in the throat, and a bud or two; a few closed trumpets and
//   spent flowers among them.
// - The zhuyu (祝餘) of Zhaoyao mountain, "like chives, with blue-green flowers" (Shanhai jing,
//   Nanshan jing): a chive's clump, dark blue-green leaves and nine to sixteen round heads of sky
//   blue star florets on stalks just over the sward (the tussocks round it lower, Grass.ts
//   LOW_FLOWER), loose enough to see the stars (packed, they read as cotton balls); tight pale buds
//   and half-open heads among them. A head is a ball drawn as a card facing the view, its corners
//   spread in the vertex stage (crossed cards drew a cross of bright slivers), its lower half in its
//   own shade.
//
// They differ: scapes taller and shorter (some heads held low among the blades), flowers larger and
// smaller and a little apart in value and warmth (`flowerTint`); all alike, a swath read as a toy's.
// They are lit as the meadow is: every part shaded by its height in the sward (`shadeAt`, deeper low
// in it); a petal is thin, its light wrapping round to the side turned from the sun, glowing only
// against it, never by a constant share (that lit every flower from within), its normal the same
// from either side of its card (flipped, a flower seen from behind drew dark), a lily's face shading
// as a cup open up and out. Measured at noon from the island view they stand at about the brightest
// grass tips, never over them.
//
// A plant (PLANTS): its leaves, scapes and flowers are ribbons and cards on one painted atlas
// (`flowerAtlas`: the lily's face, its trumpet and bud, the allium's head, the leaves' and scapes'
// strips, each strip over its own colour), the leaf family of the vegetation's materials
// (vegetation/Material.ts). Each species has VARIANTS built from fixed seeds, a batch each; a plant
// takes one by its hash, turned and scaled by its own. The flowers and scapes come first in a
// plant's indices, its leaves after, all of one size, so the cull's bands keep the flowers whole and
// drop the far plants' leaves (LEAF_REF, `leafCount`), each dropped leaf drawn in to the foot; past
// the falloff's distance the plants can be dropped at random (off by default).
//
// Instances: the cull's storage buffers (`FLOWER_PAYLOAD`: the transform, the root with the plant's
// scale and the tint), read by the drawn plant's slot (`visible`, from the batch's base); the
// material places the vertex by the transform (held in a variable, VegetationCull.ts) and turns its
// normal with it, and the plant sways from its root in the one wind (Deform.ts mainBend), its
// flowers and leaves fluttering on their own phases, the sway fading as the plant shrinks to a few
// pixels (Deform.ts swayFade, as the meadow's tufts do under MSAA). Out of the sun's map, as the
// meadow's blades are; in the depth prepass (the meadow's group holds it). A grown island's plants
// are a new pool, filled and uploaded in the growth's idle steps and swapped in with the meadow's
// (`flowerSteps`, `setFlowers`: new buffers on the same storage nodes, no pipeline).

/** The species by number, as the swaths name them (Grass.ts FLOWER_SPECIES). */
export const YAOXIANG = 0, ZHUYU = 1;

const PLANTS = [
	// yaoxiang: a day lily's clump
	{
		leaves: 16, leaf: [ 0.42, 0.7 ], leafWidth: 0.03, rise: [ 0.5, 0.75 ], droop: [ 0.35, 0.6 ], ahead: [ 0.12, 0.25 ],
		scapes: [ 2, 4 ], scape: [ 0.5, 0.95 ], flowers: [ 3, 6 ], buds: [ 1, 3 ], flower: 0.15, bud: 0.08,
		bend: 0.05, flutter: 0.02,
		// a flower's state (open, a closed trumpet, spent), the rest open; its size about the mean
		states: [ 0.12, 0.06 ], size: [ 0.7, 1.25 ],
	},
	// zhuyu: a chive's clump
	{
		leaves: 18, leaf: [ 0.24, 0.4 ], leafWidth: 0.014, rise: [ 0.85, 1 ], droop: [ 0.08, 0.25 ], ahead: [ 0.02, 0.08 ],
		scapes: [ 9, 16 ], scape: [ 0.3, 0.6 ], flowers: [ 1, 1 ], buds: [ 0, 0 ], flower: 0.09, bud: 0,
		bend: 0.035, flutter: 0.012,
		// a head's state (a tight bud, half open), the rest open; its size about the mean
		states: [ 0.22, 0.2 ], size: [ 0.7, 1.15 ],
	},
] as const;
const VARIANTS = 2;
// a leaf ribbon's segments (every leaf the same, so a band's cap is a whole number of leaves)
const LEAF_SEGS = 5;

// the plants' wind: quick and light, a meadow herb's
const WIND = { cycles: 40, slow: 0.3, flutter: 2.4 } as const;

// ------------------------------------------------------------------------------------------ atlas

// sRGB: the lily's tepals from their base to their tips, its throat and stamens; its bud; the
// allium's florets and its head's shaded heart; the leaves' and scapes' strips
const LILY = { throat: [ 104, 28, 14 ], base: [ 170, 74, 24 ], tepal: [ 162, 30, 20 ], tip: [ 140, 24, 16 ], rib: [ 206, 86, 56 ], stamen: [ 96, 30, 16 ] };
const BUD = { foot: [ 98, 122, 56 ], tip: [ 180, 70, 34 ] };
const ALLIUM = { floret: [ 52, 110, 214 ], heart: [ 28, 56, 132 ], edge: [ 64, 124, 224 ] };
const STRIPS = [
	{ blade: [ 150, 168, 140 ], foot: [ 112, 128, 100 ], rib: [ 190, 200, 178 ] }, // yaoxiang: narrow and whitish
	{ blade: [ 58, 98, 80 ], foot: [ 48, 80, 62 ], rib: [ 78, 120, 100 ] }, // zhuyu: a chive's blue green
	{ blade: [ 104, 136, 66 ], foot: [ 84, 110, 54 ], rib: [ 104, 136, 66 ] }, // a lily's scape
	{ blade: [ 98, 138, 110 ], foot: [ 82, 116, 92 ], rib: [ 98, 138, 110 ] }, // an allium's stalk
];
const TILE = { face: 0, side: 1, head: 2, strips: 3 } as const;
const STRIP = { yaoxiang: 0, zhuyu: 1, scape: 2, stalk: 3 } as const;

const rgb = ( c: readonly number[], a = 1 ) => `rgba(${ Math.round( c[ 0 ] ) },${ Math.round( c[ 1 ] ) },${ Math.round( c[ 2 ] ) },${ a })`;

/** Fills `path` on the colour (in `style`) and the silhouette. */
function fill( p: LeafPainter, path: Path2D, style: string | CanvasGradient ): void {

	p.colour.fillStyle = style;
	p.colour.fill( path );
	p.shape.fillStyle = '#fff';
	p.shape.fill( path );

}

/** A tepal from ( x, y ) at `angle`, `length` long and `width` wide: a pointed oval, a little wavy. */
function tepal( x: number, y: number, angle: number, length: number, width: number, rng: Rng ): Path2D {

	const path = new Path2D(), c = Math.cos( angle ), s = Math.sin( angle );
	const at = ( u: number, v: number ): [ number, number ] => [ x + c * u - s * v, y + s * u + c * v ];
	const wave = 0.06 * width * ( rng() - 0.5 );
	path.moveTo( ...at( 0, 0 ) );
	path.bezierCurveTo( ...at( length * 0.25, width * 0.55 ), ...at( length * 0.7, width * 0.6 + wave ), ...at( length, 0 ) );
	path.bezierCurveTo( ...at( length * 0.7, - width * 0.6 - wave ), ...at( length * 0.25, - width * 0.55 ), ...at( 0, 0 ) );
	return path;

}

/** The lily's face in a tile: six tepals round a gold throat (the inner three wider), stamens. */
function paintFace( p: LeafPainter, ox: number, oy: number, T: number, rng: Rng ): void {

	const cx = ox + T / 2, cy = oy + T / 2, R = T * 0.47;
	for ( const inner of [ false, true ] ) for ( let k = 0; k < 3; k ++ ) {

		const angle = ( k + ( inner ? 0.5 : 0 ) ) * Math.PI * 2 / 3 - Math.PI / 2 + ( rng() - 0.5 ) * 0.12;
		const length = R * ( inner ? 0.95 : 1 ), width = R * ( inner ? 0.62 : 0.46 );
		const path = tepal( cx, cy, angle, length, width, rng );
		const g = p.colour.createRadialGradient( cx, cy, 0, cx, cy, length );
		// the throat dark and deep, a little gold where it opens
		g.addColorStop( 0, rgb( LILY.throat ) );
		g.addColorStop( 0.14, rgb( LILY.base ) );
		g.addColorStop( 0.3, rgb( LILY.tepal ) );
		g.addColorStop( 1, rgb( LILY.tip ) );
		fill( p, path, g );
		// its pale midrib
		p.colour.strokeStyle = rgb( LILY.rib, 0.55 );
		p.colour.lineWidth = T * 0.012;
		p.colour.beginPath();
		p.colour.moveTo( cx, cy );
		p.colour.lineTo( cx + Math.cos( angle ) * length * 0.85, cy + Math.sin( angle ) * length * 0.85 );
		p.colour.stroke();

	}
	// the stamens: thin, curving out of the throat, dark anthers
	for ( let k = 0; k < 6; k ++ ) {

		const angle = rng() * Math.PI * 2, l = R * ( 0.45 + 0.2 * rng() );
		const x = cx + Math.cos( angle ) * l, y = cy + Math.sin( angle ) * l;
		p.colour.strokeStyle = rgb( LILY.base, 0.8 );
		p.colour.lineWidth = T * 0.006;
		p.colour.beginPath();
		p.colour.moveTo( cx, cy );
		p.colour.lineTo( x, y );
		p.colour.stroke();
		p.colour.fillStyle = rgb( LILY.stamen );
		p.colour.beginPath();
		p.colour.ellipse( x, y, T * 0.02, T * 0.01, angle, 0, Math.PI * 2 );
		p.colour.fill();

	}

}

/** The lily's trumpet from the side in the tile's left half (its foot at the half's foot) and a
 * bud in its right half. */
function paintSide( p: LeafPainter, ox: number, oy: number, T: number, rng: Rng ): void {

	const H = T / 2, fx = ox + H / 2, fy = oy + T - 4;
	// the trumpet: a narrow tube flaring to tepals curling back at the mouth
	const path = new Path2D();
	path.moveTo( fx - H * 0.04, fy );
	path.bezierCurveTo( fx - H * 0.06, fy - T * 0.45, fx - H * 0.3, fy - T * 0.7, fx - H * 0.47, fy - T * 0.86 );
	path.quadraticCurveTo( fx - H * 0.3, fy - T * 0.82, fx - H * 0.2, fy - T * 0.9 );
	path.quadraticCurveTo( fx, fy - T * 0.98, fx + H * 0.2, fy - T * 0.9 );
	path.quadraticCurveTo( fx + H * 0.3, fy - T * 0.82, fx + H * 0.47, fy - T * 0.86 );
	path.bezierCurveTo( fx + H * 0.3, fy - T * 0.7, fx + H * 0.06, fy - T * 0.45, fx + H * 0.04, fy );
	path.closePath();
	const g = p.colour.createLinearGradient( 0, fy, 0, fy - T * 0.95 );
	// (its tube the tepals' own red in their shade, not the dark throat: seen from the side a closed
	// trumpet read as a hole in the swath)
	g.addColorStop( 0, rgb( BUD.foot ) );
	g.addColorStop( 0.25, rgb( LILY.base ) );
	g.addColorStop( 0.55, rgb( LILY.tepal ) );
	g.addColorStop( 1, rgb( LILY.tepal ) );
	fill( p, path, g );
	// the bud: a closed, pointed club, green at its foot, orange at its tip
	const bx = ox + H + H / 2;
	const bud = new Path2D();
	bud.moveTo( bx - H * 0.03, fy );
	bud.bezierCurveTo( bx - H * 0.05, fy - T * 0.4, bx - H * 0.16, fy - T * 0.6, bx, fy - T * 0.92 );
	bud.bezierCurveTo( bx + H * 0.16, fy - T * 0.6, bx + H * 0.05, fy - T * 0.4, bx + H * 0.03, fy );
	bud.closePath();
	const b = p.colour.createLinearGradient( 0, fy, 0, fy - T * 0.92 );
	b.addColorStop( 0, rgb( BUD.foot ) );
	b.addColorStop( 0.55, rgb( BUD.foot ) );
	b.addColorStop( 1, rgb( BUD.tip ) );
	fill( p, bud, b );
	rng();

}

/** The allium's head in a tile: a loose ball of star florets on their pedicels, each its own
 * star with gaps between (a cotton ball where they were packed), a small shaded heart. */
function paintHead( p: LeafPainter, ox: number, oy: number, T: number, rng: Rng ): void {

	const cx = ox + T / 2, cy = oy + T / 2, R = T * 0.46;
	const heart = new Path2D();
	heart.arc( cx, cy, R * 0.32, 0, Math.PI * 2 );
	fill( p, heart, rgb( ALLIUM.heart ) );
	for ( let k = 0; k < 120; k ++ ) {

		// a floret on its pedicel out from the heart, the outer ones the lighter (the heart's own shade
		// the material adds)
		const r = R * ( 0.25 + 0.75 * Math.sqrt( rng() ) ), a = rng() * Math.PI * 2;
		const x = cx + Math.cos( a ) * r, y = cy + Math.sin( a ) * r, size = T * ( 0.05 + 0.025 * rng() );
		for ( const ctx of [ p.colour, p.shape ] ) {

			ctx.strokeStyle = ctx === p.colour ? rgb( ALLIUM.heart, 0.9 ) : '#fff';
			ctx.lineWidth = T * 0.005;
			ctx.beginPath();
			ctx.moveTo( cx + Math.cos( a ) * R * 0.25, cy + Math.sin( a ) * R * 0.25 );
			ctx.lineTo( x, y );
			ctx.stroke();

		}
		const star = new Path2D(), turn = rng() * Math.PI;
		for ( let s = 0; s < 6; s ++ ) {

			const sa = turn + s * Math.PI / 3, inner = turn + ( s + 0.5 ) * Math.PI / 3;
			star.lineTo( x + Math.cos( sa ) * size, y + Math.sin( sa ) * size );
			star.lineTo( x + Math.cos( inner ) * size * 0.35, y + Math.sin( inner ) * size * 0.35 );

		}
		star.closePath();
		const tone = 0.85 + 0.3 * ( r / R );
		fill( p, star, rgb( ( r > R * 0.8 ? ALLIUM.edge : ALLIUM.floret ).map( ( v ) => Math.min( 255, v * tone ) ) ) );

	}

}

/** A strip of the strips' tile: a leaf or a scape up its whole height, its foot at the tile's
 * foot, a pale midrib; leaves narrow to a point. */
function paintStrip( p: LeafPainter, ox: number, oy: number, T: number, k: number ): void {

	const s = STRIPS[ k ], w = T / STRIPS.length, x = ox + ( k + 0.5 ) * w, half = w * 0.38;
	const leaf = k < 2;
	const path = new Path2D();
	path.moveTo( x - half, oy + T - 1 );
	if ( leaf ) {

		path.quadraticCurveTo( x - half * 1.05, oy + T * 0.4, x, oy + 3 );
		path.quadraticCurveTo( x + half * 1.05, oy + T * 0.4, x + half, oy + T - 1 );

	} else {

		path.lineTo( x - half * 0.8, oy + 1 );
		path.lineTo( x + half * 0.8, oy + 1 );
		path.lineTo( x + half, oy + T - 1 );

	}
	path.closePath();
	const g = p.colour.createLinearGradient( 0, oy + T, 0, oy );
	g.addColorStop( 0, rgb( s.foot ) );
	g.addColorStop( 0.35, rgb( s.blade ) );
	g.addColorStop( 1, rgb( s.blade ) );
	fill( p, path, g );
	p.colour.save();
	p.colour.clip( path );
	p.colour.strokeStyle = rgb( s.rib, 0.7 );
	p.colour.lineWidth = Math.max( 1, w * 0.06 );
	p.colour.beginPath();
	p.colour.moveTo( x, oy + T );
	p.colour.lineTo( x, oy );
	p.colour.stroke();
	p.colour.restore();

}

/** The flowers' atlas, painted once (a fixed seed). */
export function flowerAtlas( size = 1024 ): LeafAtlas {

	const rng = mulberry32( 0x5f10 );
	const paint = new LeafPainter( size, rng, 0, rgb( LILY.tepal ) );
	const T = size / 2;
	// under each tile its parts' own colour, so its mips do not tint their edges
	const under = [ LILY.tepal, LILY.tepal, ALLIUM.floret, STRIPS[ 0 ].blade ];
	for ( let t = 0; t < 4; t ++ ) {

		paint.colour.fillStyle = rgb( under[ t ] );
		paint.colour.fillRect( ( t % 2 ) * T, Math.floor( t / 2 ) * T, T, T );

	}
	paint.tile( TILE.face, ( ox, oy ) => paintFace( paint, ox, oy, T, rng ) );
	paint.tile( TILE.side, ( ox, oy ) => paintSide( paint, ox, oy, T, rng ) );
	paint.tile( TILE.head, ( ox, oy ) => paintHead( paint, ox, oy, T, rng ) );
	paint.tile( TILE.strips, ( ox, oy ) => {

		for ( let k = 0; k < STRIPS.length; k ++ ) {

			// (under each strip its own colour: the tile's one under-colour bled the yaoxiang's white
			// into the chives' narrow leaves in the mips, drawing the zhuyu's clumps pale)
			paint.colour.fillStyle = rgb( STRIPS[ k ].blade );
			paint.colour.fillRect( ox + k * T / STRIPS.length, oy, T / STRIPS.length, T );
			paintStrip( paint, ox, oy, T, k );

		}

	} );
	return paint.finish( 'flowers' );

}

// ------------------------------------------------------------------------------------------- mesh

const INSET = 2 / 1024;

/** The atlas coordinates of tile `t` at ( u, v ) within it (v 0 at its foot), over its part
 * [ u0, u1 ] across. */
function atlasUv( t: number, u: number, v: number, u0 = 0, u1 = 1 ): [ number, number ] {

	const tu = ( t % 2 ) * 0.5, tv = ( 1 - Math.floor( t / 2 ) ) * 0.5;
	const across = u0 + ( u1 - u0 ) * u;
	return [ tu + INSET + across * ( 0.5 - 2 * INSET ), tv + INSET + v * ( 0.5 - 2 * INSET ) ];

}

// a plant's vertex layout: the card's normal, atlas coordinates, shade (colour), sway (x the bend's
// amplitude at the vertex, y the flutter, z the phase, w the height over the plant's), and its part
// (x: 0 leaf, 1 scape, 2 flower)
// and a billboard's corner (x, y: its offset across the view and up it, m; 0 elsewhere)
// and a leaf's number in its plant (-1 elsewhere: the far plants drop their leaves, `leafKeep`)
const layout = () => new MeshBuilder( { normal: 3, uv: 2, color: 3, leafSway: 4, flowerPart: 1, flowerCorner: 2, flowerLeaf: 1 } );

const _a = new THREE.Vector3(), _t = new THREE.Vector3();

interface Vertex { p: THREE.Vector3; n: THREE.Vector3; uv: [ number, number ]; shade: number; sway: [ number, number, number, number ]; part: number; corner?: [ number, number ]; tint?: readonly number[]; leaf?: number }

function vertex( mesh: MeshBuilder, v: Vertex ): number {

	const t = v.tint ?? [ 1, 1, 1 ];
	return mesh.vertex( v.p, { normal: [ v.n.x, v.n.y, v.n.z ], uv: v.uv, color: [ v.shade * t[ 0 ], v.shade * t[ 1 ], v.shade * t[ 2 ] ], leafSway: v.sway, flowerPart: [ v.part ], flowerCorner: v.corner ?? [ 0, 0 ], flowerLeaf: [ v.leaf ?? - 1 ] } );

}

// The sward the plants stand in (m): a part's shade by its height in it, as the meadow's own blades
// darken toward their roots (Grass.ts): low in the grass a deeper shade, over its top in the light;
// a flower held low among the blades is shaded with them.
const SWARD_TOP = 0.55;
const shadeAt = ( y: number ) => 0.4 + 0.6 * Math.min( 1, Math.max( 0, y ) / SWARD_TOP ) ** 0.8;

/** A ribbon through `points`, `width` wide across `across`, on strip `strip` of the strips' tile
 * (u over the strip, v from its foot); its normals bent up, its shade from the plant's foot up. */
function ribbon( mesh: MeshBuilder, points: THREE.Vector3[], across: THREE.Vector3, width: number, strip: number, height: number, bend: number, flutter: number, phase: number, part: number, leaf = - 1 ): void {

	const first = mesh.count, u0 = strip / STRIPS.length, u1 = ( strip + 1 ) / STRIPS.length;
	for ( let i = 0; i < points.length; i ++ ) {

		const p = points[ i ], h = Math.max( 0, p.y ) / height;
		_t.subVectors( points[ Math.min( i + 1, points.length - 1 ) ], points[ Math.max( i - 1, 0 ) ] ).normalize();
		const n = new THREE.Vector3().crossVectors( across, _t ).normalize().lerp( UP, 0.4 ).normalize();
		for ( const side of [ 0, 1 ] ) vertex( mesh, {
			p: _a.copy( p ).addScaledVector( across, ( side - 0.5 ) * width ), n, uv: atlasUv( TILE.strips, side, i / ( points.length - 1 ), u0, u1 ),
			shade: shadeAt( p.y ), sway: [ bend * h * h, flutter * i / ( points.length - 1 ), phase, h ], part, leaf,
		} );

	}
	for ( let i = 0; i < points.length - 1; i ++ ) {

		const a = first + i * 2;
		mesh.indices.push( a, a + 2, a + 1, a + 1, a + 2, a + 3 );

	}

}

/** A square card of `size` centred at `at`, facing `normal`, turned about it so its v runs along
 * `up` (projected), on tile `tile` (`u0`..`u1` across it); swaying as the plant does at its height. */
function card( mesh: MeshBuilder, at: THREE.Vector3, normal: THREE.Vector3, up: THREE.Vector3, size: number, width: number, tile: number, u0: number, u1: number, height: number, bend: number, flutter: number, phase: number, part: number, foot = false, ball = false, lit?: THREE.Vector3, tint?: readonly number[] ): void {

	const v = new THREE.Vector3().copy( up ).addScaledVector( normal, - up.dot( normal ) ).normalize();
	const u = new THREE.Vector3().crossVectors( v, normal ).normalize();
	const first = mesh.count, h = Math.max( 0, at.y ) / height;
	for ( const [ cu, cv ] of [ [ 0, 0 ], [ 1, 0 ], [ 1, 1 ], [ 0, 1 ] ] ) {

		// (a card standing on its foot, a bud's or a trumpet's: v from its foot up, else from its centre)
		const p = _a.copy( at ).addScaledVector( u, ( cu - 0.5 ) * width ).addScaledVector( v, foot ? cv * size : ( cv - 0.5 ) * size );
		// (a ball's cards, an allium's head: normals out from its centre and up, so the crossed cards
		// shade as one ball rather than as discs lit apart)
		// (`lit`: the normal it shades by, where its plane's would turn it from the light: a trumpet
		// across its flower shades as the flower's face does)
		const n = ball ? new THREE.Vector3().subVectors( p, at ).normalize().lerp( UP, 0.45 ).normalize() : lit ?? normal;
		vertex( mesh, {
			p, n, uv: atlasUv( tile, cu, cv, u0, u1 ), shade: shadeAt( p.y ), tint,
			sway: [ bend * h * h, flutter * ( foot ? cv : 0.5 + 0.5 * cv ), phase, h ], part,
		} );

	}
	mesh.indices.push( first, first + 1, first + 2, first, first + 2, first + 3 );

}

const lerp = ( a: readonly number[], t: number ) => a[ 0 ] + ( a[ 1 ] - a[ 0 ] ) * t;

/** A flower's own tint: its value and hue a little apart from its neighbours'. */
const flowerTint = ( rng: Rng ): number[] => {

	const v = 0.88 + 0.24 * rng(), warm = ( rng() - 0.5 ) * 0.12;
	return [ v * ( 1 + warm ), v, v * ( 1 - warm ) ];

};

/** A scape from the foot toward `out`, `height` tall, bowing a little: its points. */
function scapePoints( foot: THREE.Vector3, out: THREE.Vector3, height: number, lean: number, segs: number ): THREE.Vector3[] {

	const points: THREE.Vector3[] = [];
	for ( let i = 0; i <= segs; i ++ ) {

		const s = i / segs;
		points.push( foot.clone().addScaledVector( out, height * ( lean * s + 0.08 * s * s ) ).add( _t.set( 0, height * s, 0 ) ) );

	}
	return points;

}

/** One plant of `species` from the stream `rng`: its geometry, its flowers' and scapes' indices
 * first, then its leaves (`leafIndices` each). */
function plantGeometry( species: number, rng: Rng ): THREE.BufferGeometry {

	const P = PLANTS[ species ];
	const mesh = layout();
	const tallest = P.scape[ 1 ];
	// the scapes and their flowers
	const scapes = P.scapes[ 0 ] + Math.floor( rng() * ( P.scapes[ 1 ] - P.scapes[ 0 ] + 1 ) );
	for ( let k = 0; k < scapes; k ++ ) {

		const a = ( k + rng() ) / scapes * Math.PI * 2, out = new THREE.Vector3( Math.cos( a ), 0, Math.sin( a ) );
		const foot = new THREE.Vector3().addScaledVector( out, 0.04 * rng() );
		const h = lerp( P.scape, rng() ), lean = 0.06 + 0.16 * rng(), phase = rng();
		const points = scapePoints( foot, out, h, lean, 4 );
		const top = points[ points.length - 1 ];
		const across = new THREE.Vector3().crossVectors( UP, out ).normalize();
		const width = species === YAOXIANG ? 0.008 : 0.005;
		for ( const face of [ across, out ] ) ribbon( mesh, points, face, width, species === YAOXIANG ? STRIP.scape : STRIP.stalk, tallest, P.bend, 0, phase, 1 );
		if ( species === YAOXIANG ) {

			// the lilies: on short pedicels round the scape's top, each held out at a slant its own way
			// (a day lily's trumpet looks out more than up), open, closed or spent, with a bud or two
			const flowers = P.flowers[ 0 ] + Math.floor( rng() * ( P.flowers[ 1 ] - P.flowers[ 0 ] + 1 ) );
			const buds = P.buds[ 0 ] + Math.floor( rng() * ( P.buds[ 1 ] - P.buds[ 0 ] + 1 ) );
			for ( let f = 0; f < flowers + buds; f ++ ) {

				const b = a + ( f + rng() ) / ( flowers + buds ) * Math.PI * 2;
				const dir = new THREE.Vector3( Math.cos( b ), 0, Math.sin( b ) );
				const at = top.clone().addScaledVector( dir, 0.03 + 0.03 * rng() ).add( _t.set( 0, ( rng() - 0.6 ) * 0.08, 0 ) );
				const flutter = P.flutter * ( 0.7 + 0.6 * rng() ), ph = rng(), tint = flowerTint( rng );
				const size = P.flower * lerp( P.size, rng() ), state = rng();
				if ( f >= flowers ) {

					// a bud: a closed club leaning out
					const bud = P.bud * ( 0.8 + 0.4 * rng() );
					const lean = dir.clone().multiplyScalar( 0.45 ).add( UP ).normalize();
					card( mesh, at, new THREE.Vector3().crossVectors( lean, UP ).normalize(), lean, bud, bud * 0.4, TILE.side, 0.5, 1, tallest, P.bend, flutter, ph, 2, true, false, lean, tint );

				} else if ( state < P.states[ 0 ] ) {

					// a closed trumpet: the side view alone, held out and up
					const out = dir.clone().addScaledVector( UP, 0.5 + 0.5 * rng() ).normalize();
					card( mesh, at, new THREE.Vector3().crossVectors( out, UP ).normalize(), out, size * 0.85, size * 0.4, TILE.side, 0, 0.5, tallest, P.bend, flutter, ph, 2, true, false, out, tint );

				} else {

					// open (or spent: smaller, dull and drooping): its face slanting out, the trumpet
					// behind it from the pedicel to the face, so it reads as a trumpet from the side
					const spent = state < P.states[ 0 ] + P.states[ 1 ];
					const facing = dir.clone().addScaledVector( UP, spent ? - 0.25 : 0.15 + 0.45 * rng() ).normalize();
					const s = spent ? size * 0.75 : size;
					const t = spent ? tint.map( ( v, i ) => v * [ 0.86, 0.72, 0.66 ][ i ] ) : tint;
					const mouth = at.clone().addScaledVector( facing, s * 0.55 );
					// (its face shades as a cup open up and out, its inside turned to the sky: lit by its
					// plane alone, every face turned from the sun drew a dark star)
					const cup = facing.clone().addScaledVector( UP, 0.6 ).normalize();
					card( mesh, mouth, facing, UP, s, s, TILE.face, 0, 1, tallest, P.bend, flutter, ph, 2, false, false, cup, t );
					card( mesh, at, new THREE.Vector3().crossVectors( facing, UP ).normalize(), facing, s * 0.6, s * 0.5, TILE.side, 0, 0.5, tallest, P.bend, flutter, ph, 2, true, false, facing, t );

				}

			}

		} else {

			// the allium's head: a ball, drawn as a card facing the view (its corners spread in the
			// vertex stage, `flowerMaterial`), so it is round from every side (crossed cards drew a
			// cross of bright slivers over it); its lower half in its own shade. A tight bud (small, a
			// papery green white) or half open (smaller), the rest open.
			const state = rng(), bud = state < P.states[ 0 ], half = ! bud && state < P.states[ 0 ] + P.states[ 1 ];
			const size = P.flower * lerp( P.size, rng() ) * ( bud ? 0.45 : half ? 0.75 : 1 ), ph = rng();
			const tint = bud ? [ 1.05, 1.18, 0.82 ] : flowerTint( rng );
			const at = top.clone().add( _t.set( 0, size * 0.35, 0 ) ), h = at.y / tallest, first = mesh.count, shade = shadeAt( at.y );
			for ( const [ cu, cv ] of [ [ 0, 0 ], [ 1, 0 ], [ 1, 1 ], [ 0, 1 ] ] ) vertex( mesh, {
				p: at, n: UP, uv: atlasUv( TILE.head, cu, cv ), shade: shade * ( cv === 0 ? 0.62 : 1 ), tint, sway: [ P.bend * h * h, P.flutter, ph, h ], part: 2, corner: [ ( cu - 0.5 ) * size, ( cv - 0.5 ) * size ],
			} );
			mesh.indices.push( first, first + 1, first + 2, first, first + 2, first + 3 );

		}

	}
	const base = mesh.indices.length;
	// the leaves: a fountain from the foot, all round it
	for ( let l = 0; l < P.leaves; l ++ ) {

		const a = ( l + rng() ) / P.leaves * Math.PI * 2, dir = new THREE.Vector3( Math.cos( a ), 0, Math.sin( a ) );
		const length = lerp( P.leaf, rng() ), rise = lerp( P.rise, rng() ), droop = lerp( P.droop, rng() ), ahead = lerp( P.ahead, rng() );
		const foot = new THREE.Vector3().addScaledVector( dir, 0.03 * rng() ).add( _t.set( 0, - 0.02, 0 ) );
		const curve = new THREE.QuadraticBezierCurve3( foot, foot.clone().addScaledVector( dir, ahead * length ).addScaledVector( UP, rise * length ),
			foot.clone().addScaledVector( dir, ( ahead + 0.5 ) * length ).addScaledVector( UP, ( rise - droop ) * length ) );
		const points = Array.from( { length: LEAF_SEGS + 1 }, ( _, i ) => curve.getPoint( i / LEAF_SEGS ) );
		const across = new THREE.Vector3().crossVectors( UP, dir ).normalize().applyAxisAngle( dir, ( rng() - 0.5 ) * 0.8 );
		ribbon( mesh, points, across, P.leafWidth, species === YAOXIANG ? STRIP.yaoxiang : STRIP.zhuyu, tallest, P.bend, P.flutter, rng(), 0, l );

	}
	const geometry = mesh.geometry( `flowers ${ species }` );
	geometry.userData.baseIndices = base;
	geometry.userData.leafIndices = LEAF_SEGS * 6;
	geometry.userData.leaves = P.leaves;
	return geometry;

}

// --------------------------------------------------------------------------------------- instances

/** A flowering plant (Grass.ts plantGrass): its root on the ground, its transform (turned and
 * scaled), its species and variant, and its tint (a factor on its colours). */
export interface FlowerPlant { origin: THREE.Vector3; m: THREE.Matrix4; species: number; variant: number; tint: number }

/** The batch of a species' variant. */
const batchOf = ( species: number, variant: number ) => species * VARIANTS + variant;

// The plants' level of detail (vegetation/Lod.ts's rule): beyond LEAF_REF (m) from the view camera a
// plant keeps the share ( LEAF_REF / distance )^2 of its leaves, its flowers and scapes always (so
// a far swath keeps its colour), each dropped leaf drawn in to its plant's
// foot over the distance in which its count falls by one (`leafKeep`), so none pops. At the island
// view's 45 m a plant keeps them all; at 110 m about a sixth. The cull bands the plants by the same
// count and draws each band with only its leaves (LEAF_CAPS: shares of a plant's leaves, the last
// band its flowers alone). `on` is 1 for the view camera's draws.
const LEAF_REF = 45;
const LEAF_CAPS = [ 1, 0.5, 0.25, 0.125, 0 ];
const leafCount = ( origin: THREE.Node<'vec3'>, camera: THREE.Node<'vec3'>, leaves: THREE.Node<'float'>, on: THREE.Node<'float'> ) =>
	mix( leaves, leaves.mul( screenShareNode( length( camera.sub( origin ) ), float( LEAF_REF ) ) ), on );
// Far off, the last plants can be dropped at random, each by a hash of its root (stochastic
// instance falloff: Matt Pohlmann, Samurai Landscapes, GDC 2021): past `start` (m) the share
// ( start / distance )^2 of them is kept. Off by default (`start` far past
// the island view's 190 m: the swaths there are a few pixels and the plants cost little);
// `flags=flowerFalloff:<m>` sets it.
const falloff = uniform( Number( debugFlags.flowerFalloff ?? 1e6 ) );
/** The plants' data in the cull's storage buffers, a slot each: the transform, the root with the
 * plant's scale, the tint. */
const FLOWER_PAYLOAD: CullPayload<FlowerPlant> = {
	buffers: [ { name: 'matrices', floats: 16, itemSize: 16 }, { name: 'origins', floats: 4, itemSize: 4 }, { name: 'params', floats: 4, itemSize: 4 } ],
	origin: 'origins',
	matrices: 'matrices',
	write( f, i, { matrices, origins, params } ) {

		f.m.toArray( matrices, i * 16 );
		f.origin.toArray( origins, i * 4 );
		origins[ i * 4 + 3 ] = _a.setFromMatrixScale( f.m ).y;
		params[ i * 4 ] = f.tint;

	},
	fold: {
		far: falloff,
		folded: ( _slot, origin, camera ) => {

			const d = length( camera.sub( origin ) ), r = falloff.div( max( d, 1e-3 ) );
			const pick = fract( sin( dot( origin.xz, vec2( 12.9898, 78.233 ) ) ).mul( 43758.5453 ) );
			return d.greaterThan( falloff ).and( pick.greaterThan( r.mul( r ) ) );

		},
	},
	sphere( f, geometry, spheres, i ) {

		const s = _a.setFromMatrixScale( f.m ).y, sphere = geometry.boundingSphere!;
		spheres[ i * 4 ] = f.origin.x + sphere.center.x * s;
		spheres[ i * 4 + 1 ] = f.origin.y + sphere.center.y * s;
		spheres[ i * 4 + 2 ] = f.origin.z + sphere.center.z * s;
		// (room for the sway)
		spheres[ i * 4 + 3 ] = sphere.radius * s + 0.1;

	},
};

type FlowerCull = VegetationCull<FlowerPlant>;
// (a mat4 node's columns)
type Columns = { element( i: number ): THREE.Node<'vec4'> };

// the drawn batch's first slot, and whether the view's cull drew it (the depth prepass's copy reads
// the same: VegetationPrepass.ts copies `grassCulled`)
const cullBase = uniform( 0, 'uint' ).onObjectUpdate( ( { object } ) => ( object as THREE.Mesh | undefined )?.geometry?.userData.flowerBase ?? 0 );
const cullOn = uniform( 0, 'uint' ).onObjectUpdate( ( { object } ) => object?.userData.grassCulled === true ? 1 : 0 );
// the drawn batch's leaves a plant, and whether the draw thins them by distance
const leafTotal = uniform( 0 ).onObjectUpdate( ( { object } ) => ( object as THREE.Mesh | undefined )?.geometry?.userData.leaves ?? 0 );
const lodOn = uniform( 0 ).onObjectUpdate( ( { object } ) => object?.userData.grassLod === true ? 1 : 0 );

/** The plants' material: the leaf family on the atlas, instanced from the cull's buffers. */
function flowerMaterial( shared: Shared, atlas: LeafAtlas, cull: FlowerCull ): THREE.MeshStandardNodeMaterial {

	const slot = instanceIndex.add( cullBase );
	const plant = select( cullOn.equal( 1 ), cull.node( 'visible', 'uint', true ).element( slot ), slot ).toVar( 'flowerPlant' );
	const matrix = cull.node( 'matrices', 'mat4', true ).element( plant ).toVar( 'flowerMatrix' );
	const origin = cull.node( 'origins', 'vec4', true ).element( plant ).toVar( 'flowerOrigin' );
	const tint = varying( cull.node( 'params', 'vec4', true ).element( plant ).x, 'vFlowerTint' );
	// the placed position, held in a variable (VegetationCull.ts), and the normal turned with it
	// a billboard's corners spread across the view and up it, at the plant's scale; its normal a
	// ball's, out from its centre toward the view and up
	const corner = attribute<'vec2'>( 'flowerCorner', 'vec2' );
	const view = cameraWorldMatrix as unknown as Columns;
	const right = view.element( 0 ).xyz, upward = view.element( 1 ).xyz, toward = view.element( 2 ).xyz;
	const offset = right.mul( corner.x ).add( upward.mul( corner.y ) ).toVar( 'flowerCornerOffset' );
	// a far plant's dropped leaves drawn in to its foot (`leafCount`, as the cull bands it)
	const leaf = attribute<'float'>( 'flowerLeaf', 'float' );
	// (blended by a 0/1 weight, never a `select` of the count: compiled into a branch, it left the
	// flowers' own vertices drawn in to the foot as well)
	const leafKeep = clamp( leafCount( origin.xyz, cameraPosition, leafTotal, lodOn ).sub( leaf ), 0, 1 ).toVar( 'flowerLeafKeep' );
	const keep = mix( float( 1 ), leafKeep, step( 0, leaf ) );
	const placed = matrix.mul( vec4( positionGeometry.mul( keep ), 1 ) ).xyz.add( offset.mul( origin.w ) ).toVar( 'flowerPlaced' );
	const billboard = select( corner.x.abs().greaterThan( 0 ), float( 1 ), float( 0 ) );
	const ballNormal = offset.div( max( length( offset ), 1e-4 ) ).mul( 0.6 ).add( toward.mul( 0.7 ) ).add( vec3( 0, 0.5, 0 ) ).normalize();
	const turned = mix( matrix.mul( vec4( normalGeometry, 0 ) ).xyz.normalize(), ballNormal, billboard ).normalize().toVar( 'flowerNormal' );
	const sway = attribute<'vec4'>( 'leafSway', 'vec4' );
	const flower = attribute<'float'>( 'flowerPart', 'float' ).greaterThan( 1.5 ).select( float( 1 ), float( 0 ) );
	// a leaf's or a scape's normal turns with the side seen, as a thin blade's; a flower's is the
	// same from either side of its cards (a tepal's back is no darker than its face; flipped, every
	// flower seen from behind drew a dark maroon star)
	const shadingNormal = mix( normalViewGeometry.mul( faceDirection ), normalViewGeometry, flower ).normalize();
	// far off, where a plant is a few pixels, its sway fades (as the meadow's tufts' does under MSAA)
	const fade = swayFade( origin.xyz, origin.w.mul( 0.8 ) );
	let bend: THREE.Node<'vec2'> | undefined;
	return vegetationMaterial( shared, {
		family: 'leaf', name: 'flowers', roughness: 0.82,
		leaf: { map: atlas.map, alphaMap: atlas.alpha },
		wet: { tint: 0.8, roughness: 0.3 },
		color: ( wet ) => materialColor.mul( vec4( vec3( wet.mul( tint ) ), 1 ) ),
		rest: placed,
		displacement: ( wind ) => {

			const bent = mainBend( wind, placed, origin.xyz, sway.x.mul( origin.w ).mul( fade ), WIND.cycles, float( WIND.slow ) );
			if ( wind === shared.wind ) bend = bent.sway;
			return bent.position.add( leafFlutter( wind, bent.field, turned, sway.y.mul( origin.w ).mul( fade ), sway.z, WIND.flutter ) );

		},
		sway: () => bend,
		beforePosition: () => {

			normalLocal.assign( turned );

		},
		normal: shadingNormal,
		// a petal is thin: light wraps round to its side turned from the sun (a tepal facing away
		// from it is lit through, not black) and it glows when lit from behind, by its albedo; a
		// constant share of light lit every flower as from within
		light: { scale: float( 1 ), extra: ( L, V, N ) => {

			const wrap = clamp( dot( N, L ).mul( 0.5 ).add( 0.5 ), 0, 1 );
			return mix( leafTransmission( L, V, N ) as THREE.Node<'float'>, wrap.mul( wrap ).mul( 0.35 ).add( pow( clamp( dot( V.negate(), L ), 0, 1 ), 3 ).mul( 0.6 ) ), flower );

		} },
	} );

}

/** A batch's mesh over the cull's buffers (the meadow's way, Grass.ts tuftMesh): instancing is the
 * material's. */
function batchMesh( geometry: THREE.BufferGeometry, material: THREE.Material, cull: FlowerCull, range: CullRange, name: string ): THREE.InstancedMesh {

	const g = new THREE.BufferGeometry();
	for ( const key of [ 'position', 'normal', 'uv', 'color', 'leafSway', 'flowerPart', 'flowerCorner', 'flowerLeaf' ] ) g.setAttribute( key, geometry.getAttribute( key ) );
	g.setIndex( geometry.getIndex() );
	g.boundingBox = geometry.boundingBox!.clone();
	g.boundingSphere = geometry.boundingSphere!.clone();
	g.userData.flowerBase = range.start;
	g.userData.leaves = geometry.userData.leaves;
	const mesh = new THREE.InstancedMesh( g, material, Math.max( range.count, 1 ) );
	mesh.instanceMatrix.array = new Float32Array( 16 );
	( mesh as unknown as { instanceMatrix: THREE.BufferAttribute } ).instanceMatrix = cull.buffer( 'matrices' );
	mesh.count = range.count;
	mesh.userData.bakeCount = range.count;
	mesh.frustumCulled = false;
	mesh.castShadow = false;
	mesh.receiveShadow = true;
	mesh.name = name;
	mesh.renderOrder = - 1;
	return mesh;

}

/** The variants' geometries, built once from fixed seeds. */
let geometries: THREE.BufferGeometry[] | null = null;
function plantGeometries(): THREE.BufferGeometry[] {

	if ( ! geometries ) {

		geometries = [];
		for ( let s = 0; s < PLANTS.length; s ++ ) for ( let v = 0; v < VARIANTS; v ++ ) geometries.push( plantGeometry( s, mulberry32( 0x3a17 + 97 * s + 13 * v ) ) );

	}
	return geometries;

}

const cullLod = {
	count: ( origin: THREE.Node<'vec3'>, camera: THREE.Node<'vec3'>, blades: THREE.Node<'float'>, _floor: THREE.Node<'float'>, on: THREE.Node<'float'> ) => leafCount( origin, camera, blades, on ),
	on: uniform( 1 ), bands: uniform( 1, 'uint' ),
};

/** A batch's band caps (leaves, descending, the last 0: flowers alone). */
function leafCaps( leaves: number ): number[] {

	const caps: number[] = [];
	for ( const share of LEAF_CAPS ) {

		const cap = Math.ceil( leaves * share - 1e-6 );
		if ( caps.length === 0 || cap < caps[ caps.length - 1 ] ) caps.push( cap );

	}
	return caps;

}

/** The plants by batch. */
function byBatch( plants: FlowerPlant[] ): FlowerPlant[][] {

	const out: FlowerPlant[][] = Array.from( { length: PLANTS.length * VARIANTS }, () => [] );
	for ( const p of plants ) out[ batchOf( p.species, p.variant ) ].push( p );
	return out;

}

interface Batch { mesh: THREE.InstancedMesh; range: CullRange; count: number; indexCount: number }

/** The meadow's flowering plants `plants` (Grass.ts plantGrass), a group of one mesh per batch. */
export function buildFlowers( plants: FlowerPlant[], shared: Shared, atlas: LeafAtlas ): THREE.Group {

	const group = new THREE.Group();
	group.name = 'flowers';
	const geos = plantGeometries(), sorted = byBatch( plants );
	const cull: FlowerCull = new VegetationCull( { name: 'Flowers', payload: FLOWER_PAYLOAD, lod: cullLod }, geos.map( ( g, k ) => ( {
		records: sorted[ k ], geometry: g, blades: g.userData.leaves, bladeIndices: g.userData.leafIndices, baseIndices: g.userData.baseIndices, caps: leafCaps( g.userData.leaves ),
	} ) ) );
	const material = flowerMaterial( shared, atlas, cull );
	const batches: Batch[] = geos.map( ( g, k ) => ( { mesh: batchMesh( g, material, cull, cull.ranges[ k ], `flowers ${ k }` ), range: cull.ranges[ k ], count: sorted[ k ].length, indexCount: g.getIndex()!.count } ) );
	for ( const b of batches ) {

		b.mesh.onBeforeRender = ( renderer, _scene, camera ) => {

			const culled = ( camera as THREE.PerspectiveCamera ).isPerspectiveCamera && debugFlags.grassCull !== false;
			b.mesh.userData.grassCulled = culled;
			// (the prepass's depth copy takes the same: VegetationPrepass.ts copies `grassLod`)
			b.mesh.userData.grassLod = ( camera as THREE.PerspectiveCamera ).isPerspectiveCamera && debugFlags.grassLod !== false;
			if ( ! culled ) return;
			// the first batch drawn for the view culls them all
			if ( b === batches.find( ( c ) => c.range.count > 0 ) ) {

				for ( const c of batches ) c.range.indexCount.value = c.indexCount;
				cull.update( renderer as unknown as THREE.Renderer, camera );

			}
			( b.mesh.geometry as unknown as { setIndirect( a: THREE.IndirectStorageBufferAttribute, offsets: number[] ): void } ).setIndirect( cull.indirect, b.range.indirectOffsets );

		};
		b.mesh.onAfterRender = () => {

			b.mesh.geometry.indirect = null;

		};
		group.add( b.mesh );

	}
	group.userData.cull = cull;
	group.userData.batches = batches;
	// the plants' flowers on the land shown, [ x, y, z ] each (the parity views find the flowers by
	// them: tools/parity/views.mjs, through the meadow's `flowerHeads`)
	group.userData.heads = () => {

		const origins = cull.buffer( 'origins' ).array as Float32Array, out: number[][] = [];
		for ( const range of cull.ranges ) for ( let i = range.start; i < range.start + range.count; i ++ ) out.push( [ origins[ i * 4 ], origins[ i * 4 + 1 ] + 0.6 * origins[ i * 4 + 3 ], origins[ i * 4 + 2 ] ] );
		return out;

	};
	return group;

}

/** Flowers grown on another land, ready for `setFlowers`. */
export interface FlowersPrepared { pool: CullPool; buffers: CullBuffers; counts: number[] }

/** The pool of `plants` for the flowers `group` (buildFlowers), in steps. */
export function* flowerSteps( plants: FlowerPlant[], per = 256 ): Generator<void, FlowersPrepared> {

	const geos = plantGeometries(), sorted = byBatch( plants );
	const pool = yield* poolSteps( FLOWER_PAYLOAD, geos.map( ( g, k ) => ( { records: sorted[ k ], geometry: g } ) ), per );
	return { pool, buffers: poolBuffers( FLOWER_PAYLOAD, pool ), counts: sorted.map( ( s ) => s.length ) };

}

/** Swaps the flowers `group` to a prepared pool in place (no pipeline); returns the old buffers. */
export function setFlowers( group: THREE.Group, prepared: FlowersPrepared ): CullBuffers {

	const cull = group.userData.cull as FlowerCull, batches = group.userData.batches as Batch[];
	const old = cull.setPool( prepared.pool, prepared.buffers );
	batches.forEach( ( b, k ) => {

		b.count = prepared.counts[ k ];
		b.mesh.count = b.count;
		b.mesh.userData.bakeCount = b.count;
		b.mesh.geometry.userData.flowerBase = b.range.start;
		( b.mesh as unknown as { instanceMatrix: THREE.BufferAttribute } ).instanceMatrix = cull.buffer( 'matrices' );
		for ( const child of b.mesh.children ) if ( ( child as THREE.InstancedMesh ).isInstancedMesh ) ( child as unknown as { instanceMatrix: THREE.BufferAttribute } ).instanceMatrix = cull.buffer( 'matrices' );

	} );
	return old;

}

/** The plants' count by batch, for probes. */
export function flowerCounts( group: THREE.Group ): number[] {

	return ( group.userData.batches as Batch[] ).map( ( b ) => b.count );

}

export { VARIANTS as FLOWER_VARIANTS };
