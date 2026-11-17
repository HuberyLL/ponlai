import * as THREE from 'three/webgpu';
import { attribute, float, fwidth, mix, mx_noise_float, positionGeometry, smoothstep, vec3 } from 'three/tsl';
import { GroundBounceLightingModel, CANOPY_SHADE, receiveScreenAO, receiveScreenShadow, screenThickness, type Shared, CROWN_DRAG, branchBend, mainBend, useSpecular, useVegetationMotion, placeVertex, type PlantDraw, type PlantInstances, IDENTITY_COLOUR, LeafPainter, leafMaterial as treeLeaves, plantTint, type LeafAtlas, type PlantTint, rootHash, writeMeter, tuneUniform } from '../../render/index.ts';
import { mulberry32 } from '../../render/data.ts';
import { CULM, LEAF_ATLAS_MEAN, LEAF_BAND_FACTORS, LEAF_COLOURS, LEAF_MEAN, LEAF_SHARE, LEAF_UNDER, MOTTLE, NODE_RING, leafBandColour, leafBandOf, srgbToLinear } from './BambooColours.ts';
import { GROVES } from './BambooGroves.ts';

// The bamboo's surfaces (Bamboo.ts): its culms and its leaves.
//
// Culms: smooth with a soft sheen, a warm olive green (BambooColours.ts CULM): fresh the first year,
// then darker and browner in blotches that spread until the culm is the old colour (the
// culm's age, from its `look` x, against a noise stretched along the culm); on the old culms a
// dull brown mottle in soft patches of a few centimetres to a few tens (MOTTLE), its cover growing
// with the age and thinning up the culm; a thin pale yellowish ring at each node with a darker band
// above it (NODE_RING), a paler band of wax just under it, a fine streaking along the grain; each
// culm a little lighter or darker than the next (`CULM_TINT`, by a hash of its foot). They are the
// plants' own colour: darker than a lit crown, stems that read dark against the light and lit where
// the sun finds them, never the palest thing in a grove. Their specular is close to a leaf's
// (`CULM_F0`), a smooth cuticle.
// The node's ring is narrower than a pixel at a distance: where `fwidth` of the internode's phase
// says so, it fades to its mean over the internode, so a far culm shows no bands.
// The sky reaches a culm's lower part only through its grove's canopy, so a grove is dark inside
// and its culms light where the sun finds them: the ambient volume's irradiance
// (lighting/AmbientSample.ts) sees the grove and darkens it, read at the culm's own normal, so a
// face toward the grove's open side takes more than one toward its inside; without the volume the
// `culm` attribute's third (Bamboo.ts) darkens it on the environment's irradiance.
// No maps: the colour is a function of the rest position, so it holds still on a swaying culm.
//
// Leaves: narrow, lance-shaped, about a hand long and a finger wide, drawn to a long point and
// curving a little; two to four at a twig's end in a narrow fan pointing on with it (the
// painters' 个, not a star), the twigs off a branchlet (a 2x2
// atlas of sprays on the trees' painter, vegetation/TreeSurfaces.ts). The atlas is a clear green
// with small changes of lightness between its leaves and a few old yellow ones; each plant lays its
// own colour over it from a band (BambooColours.ts LEAF_BAND: a dull grey green, a clear saturated
// green, a pale yellow green), at its place on the band carried in its instance's `look` w (Bamboo.ts,
// from the culm's seed), so crown differs from crown in hue and lightness while their mean stays
// the crowns'. Here and there a cluster of pale, lustrous seeds, as big as pearls.
// The leaves the wind takes off the crowns (world/FallingLeaves.ts) are one such leaf on a card
// of its own (`singleLeaf`), tinted per leaf in the plants' colours along the band (`LEAF_TINTS`).

/** The culms' specular reflectance (vegetation/Material.ts useSpecular). */
const CULM_F0 = 0.016;

/** The culms' occlusion on the ambient volume's path: a soft grounding alone, the culm `foot`
 * darker at its foot and back to its light by `footHeight` m up (the ground at the foot has no term
 * of its own). The grove's darkness is the volume's: a culm in a grove's shade takes more light
 * than the floor at its foot, which looks up into the canopy while the culm's sides look out level
 * through the grove. A share of the canopy's height term kept on the volume (the `culm`
 * attribute's third) darkened them twice: without it the culms in a grove's shade came out about a
 * quarter lighter, those at its edge as light as the open shade's ground beside them. */
const CULM_SHADE = { foot: 0.05, footHeight: 1 } as const;

/** Each culm's own colour over its leaves (TreeSurfaces.ts plantTint, at its place on the leaf
 * band): the band's keys as overlay keys over the atlas (an overlay on an albedo below a half
 * multiplies it by twice the key, so a key is half the plant's factor over the atlas's mean), none
 * of the atlas's colour kept, so the band's dark end takes the atlas to about a quarter. */
export const BAMBOO_TINT: PlantTint = { keys: LEAF_BAND_FACTORS.map( ( f ) => f.map( ( v ) => v / 2 ) as [ number, number, number ] ), keep: 0, matrix: IDENTITY_COLOUR };
/** Each culm's own lightness on its wood: 0.85 to 1.15 times by a hash of its foot (overlay keys
 * about 0.5), apart from its leaves' tint. */
const CULM_TINT: PlantTint = { keys: [ [ 0.425, 0.425, 0.425 ], [ 0.5, 0.5, 0.5 ], [ 0.575, 0.575, 0.575 ] ], keep: 0, matrix: IDENTITY_COLOUR };

/** The mottle's noise: two octaves of MaterialX's Perlin noise, their sum's standard deviation
 * (measured over 400 000 points), which sets the threshold for a cover. */
const MOTTLE_SD = 0.29;

/** The bamboo's wind: the culms' sway rate (swings a metre of the plants' travel, Deform.ts
 * mainBend: 0.9 Hz on a fair day), the drag's exponent of the wind, its leaved crown's
 * (2 + Deform.ts CROWN_DRAG.v), and the narrow leaves' flutter (Hz). */
export const BAMBOO_WIND = { rate: 0.095, drag: 2 + CROWN_DRAG.v, flutter: 2.6 } as const;

/** The culms and branches of a plant draw (PlantInstances.ts): their colour by the culm's age
 * (its instance's `look` x) and place in the internode (the `culm` attribute), bending from the
 * culm's foot by `leafSway` x, the prototype's eta^2, eta (its share of the culm's height) in w,
 * under the culm's wind load (its instance's); a branch then bends on its own about its start
 * (Deform.ts branchBend, `branchFrom`, `branchTo`, placed with the culm). */
export function culmMaterial( shared: Shared, plants: PlantInstances ): THREE.MeshStandardNodeMaterial {

	const material = new THREE.MeshStandardNodeMaterial( { roughness: 0.5, metalness: 0 } );
	const v = plants.vertex(), place = placeVertex( v );
	const phase = attribute<'float'>( 'culm', 'float' );
	const age = v.lookVarying.x, grove = v.lookVarying.y;
	const eta = attribute<'vec4'>( 'leafSway', 'vec4' ).w;
	// blotches along the culm, through which its age spreads: on the prototype's rest
	// position (so they hold still on a swaying culm) moved by the culm's foot (so no two culms of a
	// prototype share them)
	// the node's ring: the phase's change across a pixel, taken first (a derivative, in uniform
	// control flow)
	// (floored: on the branches the phase is constant, and smoothstep's edges must differ)
	const across = fwidth( phase ).max( 1e-4 ).toVar();
	const grain = positionGeometry.add( v.footVarying );
	const blotch = mx_noise_float( grain.mul( vec3( 22, 2.5, 22 ) ) ).mul( 0.5 ).add( 0.5 );
	const aged = smoothstep( blotch.sub( 0.18 ), blotch.add( 0.18 ), age );
	// the brown mottle: soft patches over the noise's threshold for the cover the culm's age and
	// height give (the normal quantile, Schmeiser's approximation, times the noise's deviation)
	const mottleNoise = mx_noise_float( grain.mul( vec3( 4, 2, 4 ) ) ).add( mx_noise_float( grain.mul( vec3( 9.6, 4.8, 9.6 ) ).add( vec3( 31.7, 11.3, 5.1 ) ) ).mul( 0.5 ) );
	const cover = age.mul( MOTTLE.cover ).mul( mix( float( 1 ), float( MOTTLE.top ), smoothstep( 0.15, 0.85, eta ) ) ).clamp( 1e-4, 0.5 );
	const threshold = float( 1 ).sub( cover ).pow( 0.14 ).sub( cover.pow( 0.14 ) ).mul( 4.91 * MOTTLE_SD );
	const mottle = smoothstep( threshold.sub( 0.05 ), threshold.add( 0.05 ), mottleNoise );
	const streak = mx_noise_float( grain.mul( vec3( 160, 1.2, 160 ) ) ).mul( 0.12 ).add( 1 );
	// the ring of wax just under the node above
	const wax = smoothstep( 0.9, 0.96, phase ).mul( float( 1 ).sub( smoothstep( 0.985, 1, phase ) ) ).mul( 0.5 );
	// the node's pale ring at the internode's foot and the darker band over it, faded to their mean
	// where the ring is under two pixels wide and gone to it at one
	const R = NODE_RING.width;
	const ring = float( 1 ).sub( smoothstep( across.negate().add( R ), across.add( R ), phase ) );
	const band = smoothstep( across.negate().add( R ), across.add( R ), phase ).mul( float( 1 ).sub( smoothstep( across.negate().add( 2 * R ), across.add( 2 * R ), phase ) ) );
	const light = vec3( ...NODE_RING.light );
	const rings = mix( vec3( 1 ), light, ring ).mul( mix( float( 1 ), float( NODE_RING.dark ), band ) );
	const ringsMean = vec3( ...NODE_RING.light.map( ( l ) => 1 + ( l - 1 ) * R + ( NODE_RING.dark - 1 ) * R ) );
	const node = mix( rings, ringsMean, smoothstep( 0.5 * R, R, across ) );
	const wood = mix( mix( vec3( ...CULM.green ), vec3( ...CULM.old ), aged ), vec3( ...CULM.mottle ), mottle ).mul( streak );
	// (the foot's hash on z, x: apart from the wind's phase, Deform.ts, which hashes x, z)
	material.colorNode = plantTint( mix( wood, vec3( ...CULM.wax ), wax ).mul( node ), rootHash( v.footVarying.zx ), float( 1 ), CULM_TINT );
	material.roughnessNode = mix( mix( float( 0.62 ), float( 0.55 ), aged ), float( 0.75 ), wax );
	useSpecular( material, float( CULM_F0 ) );
	material.name = 'bamboo culms';
	receiveScreenAO( material );
	// the whole scene's screen-space shade on the key (post/MeadowShadows.ts); as a caster in it, a
	// grown culm's foot diameter deep, so the march does not take a culm for a wall far behind it
	receiveScreenShadow( material );
	screenThickness( material, GROVES.height / GROVES.slender );
	// the ambient volume at degree 2, as the island's other receivers (lighting/AmbientSample.ts)
	( material as unknown as { setupLightingModel: () => THREE.LightingModel } ).setupLightingModel = () => new GroundBounceLightingModel( { bands: 2, kind: 'culms' } );
	writeMeter( material );
	let bend: THREE.Node<'vec2'> | undefined;
	const rest = useVegetationMotion( material, shared.wind, {
		rest: place.position,
		displacement: ( wind ) => {

			const bent = mainBend( wind, place.position, place.root, place.sway.x, place.sway.w, place.load, BAMBOO_WIND );
			if ( wind === shared.wind ) bend = bent.sway;
			return bent.position.add( branchBend( wind, place.position, place.root, place.limb( 'branchFrom' ), place.limb( 'branchTo' ), bent.field ) );

		},
		sway: () => bend,
		beforePosition: place.before,
	} );
	// the sky's light past the grove's canopy (`groveSky`'s form by the culm's grove density and
	// the point's share of its height), where the ambient volume does not carry it
	// (AmbientSample.ts CANOPY_SHADE; 1 keeps the occlusion's path for the screen-space one); on the
	// volume's path the foot's grounding alone; the sun keeps its own shadows
	const sky = float( 1 ).sub( grove.mul( GROVES.shade ).mul( float( 1 ).sub( smoothstep( 0.3, 0.9, eta ) ) ) );
	const foot = smoothstep( 0, CULM_SHADE.footHeight, rest.y.sub( v.footVarying.y ) ).mul( CULM_SHADE.foot ).add( 1 - CULM_SHADE.foot );
	material.aoNode = CANOPY_SHADE ? sky : foot;
	return material;

}

// ----------------------------------------------------------------------------------------- leaves

// the leaves' colours are in BambooColours.ts; the twigs purple-brown, the seeds pale and lustrous
const TWIG = 'rgb(74,60,56)';
const PEARL = [ 230, 224, 204 ] as const;
// how far a leaf's facet tilt turns across its width (of the id map's 255)
const CURVE = 30;

/** A bamboo leaf's outline, its stalk at the origin and its tip near ( length, 0 ): narrow at the
 * stalk, widest a third along, drawn out to a long point, curving `bend` (m of its length) to one
 * side toward the tip. */
function leafPath( length: number, width: number, bend: number ): Path2D {

	const L = length, W = width;
	const half = ( sign: number ) => {

		const curves = [
			[ [ 0, 0 ], [ 0.04 * L, sign * 0.45 * W ], [ 0.16 * L, sign * 0.52 * W ], [ 0.32 * L, sign * 0.5 * W ] ],
			[ [ 0.32 * L, sign * 0.5 * W ], [ 0.58 * L, sign * 0.44 * W ], [ 0.84 * L, sign * 0.16 * W ], [ L, 0 ] ],
		];
		const out: [ number, number ][] = [];
		for ( const [ a, b, c, d ] of curves ) for ( let i = 0; i < 16; i ++ ) {

			const t = i / 16, u = 1 - t;
			const x = u * u * u * a[ 0 ] + 3 * u * u * t * b[ 0 ] + 3 * u * t * t * c[ 0 ] + t * t * t * d[ 0 ];
			const y = u * u * u * a[ 1 ] + 3 * u * u * t * b[ 1 ] + 3 * u * t * t * c[ 1 ] + t * t * t * d[ 1 ];
			out.push( [ x, y + bend * ( x / L ) ** 2 ] );

		}
		out.push( [ L, bend ] );
		return out;

	};
	const path = new Path2D();
	path.moveTo( 0, 0 );
	for ( const [ x, y ] of half( - 1 ) ) path.lineTo( x, y );
	const back = half( 1 );
	for ( let i = back.length - 1; i >= 0; i -- ) path.lineTo( back[ i ][ 0 ], back[ i ][ 1 ] );
	path.closePath();
	return path;

}

/** The four sprays, drawn once (a fixed seed): colour, silhouette and per-leaf ids. A tile's
 * foot is where its card meets the branch, its spray reaching up the tile (Bamboo.ts spray). */
export function leafAtlas( size = 512 ): LeafAtlas {

	const rng = mulberry32( 0xb3b0 );
	const paint = new LeafPainter( size, rng, CURVE, LEAF_UNDER );
	const tile = size / 2;

	const pick = () => {

		let k = rng(), i = 0;
		while ( i < LEAF_SHARE.length - 1 && k >= LEAF_SHARE[ i ] ) k -= LEAF_SHARE[ i ++ ];
		return LEAF_COLOURS[ i ];

	};

	const leaf = ( x: number, y: number, angle: number, length: number ) => {

		const base = pick();
		const tone = 0.88 + 0.24 * rng();
		const [ r, g, b ] = base.map( ( v ) => Math.round( Math.min( 255, v * tone ) ) );
		const width = length * ( 0.13 + 0.04 * rng() );
		const bend = ( rng() - 0.5 ) * length * 0.25;
		const path = leafPath( length, width, bend );
		paint.leaf( path, x, y, angle, width, [ r, g, b ], ( gc ) => {

			// the midrib, lighter; the half away from the light a little darker
			gc.save();
			gc.clip( path );
			gc.fillStyle = 'rgba(0,0,0,0.1)';
			gc.fillRect( 0, 0, length * 1.1, width + Math.abs( bend ) );
			gc.restore();
			gc.strokeStyle = `rgba(${ Math.min( 255, r + 30 ) },${ Math.min( 255, g + 30 ) },${ Math.min( 255, b + 18 ) },0.45)`;
			gc.lineWidth = Math.max( 0.5, width * 0.09 );
			gc.beginPath();
			gc.moveTo( 0, 0 );
			for ( let k = 1; k <= 8; k ++ ) gc.lineTo( length * 0.92 * k / 8, bend * ( 0.92 * k / 8 ) ** 2 );
			gc.stroke();

		} );

	};

	// a few seeds as big as pearls, clustered at a twig's end
	const pearls = ( x: number, y: number, angle: number ) => {

		const count = 4 + Math.floor( rng() * 4 ), r = tile * 0.018;
		for ( let k = 0; k < count; k ++ ) {

			const d = r * 1.9 * ( 0.4 + 0.8 * rng() ), a = angle + ( rng() - 0.5 ) * 2.4;
			const path = new Path2D();
			path.arc( 0, 0, r * ( 0.85 + 0.3 * rng() ), 0, Math.PI * 2 );
			paint.leaf( path, x + Math.cos( a ) * d, y + Math.sin( a ) * d, 0, r * 2, PEARL, ( gc ) => {

				gc.fillStyle = 'rgba(255,255,255,0.6)';
				gc.beginPath();
				gc.arc( - r * 0.3, - r * 0.3, r * 0.35, 0, Math.PI * 2 );
				gc.fill();
				gc.fillStyle = 'rgba(120,110,90,0.25)';
				gc.beginPath();
				gc.arc( r * 0.25, r * 0.3, r * 0.5, 0, Math.PI * 2 );
				gc.fill();

			} );

		}

	};

	// a twig: a short stroke, its leaves off its last part alternately and from its end, all
	// pointing on with it in a narrow fan (the painters' 个), unequal in length
	const twig = ( x0: number, y0: number, angle: number, length: number, fan: number, seeds: boolean ) => {

		const x1 = x0 + Math.cos( angle ) * length, y1 = y0 + Math.sin( angle ) * length;
		paint.twig( x0, y0, x1, y1, tile * 0.006, TWIG );
		if ( seeds ) pearls( x1, y1, angle );
		for ( let k = 0; k < fan; k ++ ) {

			// the first ones off the twig's side, the last from its end, between its neighbours
			const at = k === fan - 1 ? 1 : 0.55 + 0.4 * k / fan;
			const side = k === fan - 1 ? 0 : k % 2 === 0 ? 1 : - 1;
			const px = x0 + ( x1 - x0 ) * at, py = y0 + ( y1 - y0 ) * at;
			leaf( px, py, angle + side * ( 0.3 + 0.25 * rng() ) + ( rng() - 0.5 ) * 0.15, tile * ( 0.24 + 0.12 * rng() ) * ( k === fan - 1 ? 1.1 : 1 ) );

		}

	};

	for ( let t = 0; t < 4; t ++ ) paint.tile( t, ( ox, oy ) => {

		// a branchlet up the tile from its foot, twigs off it alternately, a fan at its end
		const bx = ox + tile * ( 0.45 + 0.1 * rng() ), by = oy + tile * 0.99;
		const lean = - Math.PI / 2 + ( rng() - 0.5 ) * 0.3;
		const length = tile * 0.6;
		const steps = 12, bend = ( rng() - 0.5 ) * 0.5;
		let x = bx, y = by, a = lean;
		const points: [ number, number, number ][] = [];
		for ( let i = 0; i < steps; i ++ ) {

			const nx = x + Math.cos( a ) * length / steps, ny = y + Math.sin( a ) * length / steps;
			paint.twig( x, y, nx, ny, tile * 0.009, TWIG );
			points.push( [ nx, ny, a ] );
			x = nx; y = ny; a += bend / steps;

		}
		const twigs = 5 + Math.floor( rng() * 3 );
		const seeded = rng() < 0.75 ? Math.floor( rng() * twigs ) : - 1;
		for ( let k = 0; k < twigs; k ++ ) {

			const [ px, py, pa ] = points[ Math.floor( ( 0.12 + 0.8 * k / twigs ) * ( steps - 1 ) ) ];
			const side = k % 2 === 0 ? 1 : - 1;
			twig( px, py, pa + side * ( 0.55 + 0.35 * rng() ), tile * ( 0.07 + 0.06 * rng() ), 2 + Math.floor( rng() * 3 ), k === seeded );

		}
		twig( x, y, a, tile * 0.06, 3 + Math.floor( rng() * 2 ), false );

	} );

	return paint.finish( 'bamboo leaves' );

}

/** A single leaf's tints (world/FallingLeaves.ts) as linear factors over the clear green it is
 * drawn in, and their shares: the plants' colours at the middles of ten equal shares of their places
 * on the band, and the atlas's old yellow leaves at their share, at the plants' mean factor, so a
 * leaf off the crowns takes their mix of colours. */
const FALLING_TINTS = 10, YELLOW = LEAF_COLOURS.length - 1;
const clearGreen = ( v: number, k: number ) => v / srgbToLinear( LEAF_COLOURS[ 0 ][ k ] );
export const LEAF_TINTS: readonly { tint: readonly [ number, number, number ]; share: number }[] = [
	...Array.from( { length: FALLING_TINTS }, ( _, i ) => ( {
		tint: leafBandColour( leafBandOf( ( i + 0.5 ) / FALLING_TINTS ) ).map( clearGreen ) as [ number, number, number ],
		share: ( 1 - LEAF_SHARE[ YELLOW ] ) / FALLING_TINTS,
	} ) ),
	{
		tint: LEAF_COLOURS[ YELLOW ].map( ( v, k ) => clearGreen( srgbToLinear( v ) * LEAF_MEAN[ k ] / LEAF_ATLAS_MEAN[ k ], k ) ) as [ number, number, number ],
		share: LEAF_SHARE[ YELLOW ],
	},
];

/** One bamboo leaf across a square texture in the clear green (the first of LEAF_COLOURS), its
 * stalk at the left edge's middle and its tip near the right edge, with the crowns' midrib and
 * shading: the falling leaves' card (world/FallingLeaves.ts), which tints it per leaf
 * (LEAF_TINTS). */
export function singleLeaf( size = 128 ): LeafAtlas {

	const paint = new LeafPainter( size, mulberry32( 0x1eaf ), CURVE, LEAF_UNDER );
	const length = size * 0.9, width = length * 0.15, bend = length * 0.05;
	const path = leafPath( length, width, bend );
	const [ r, g, b ] = LEAF_COLOURS[ 0 ];
	paint.leaf( path, size * 0.05, size / 2 - bend / 2, 0, width, [ r, g, b ], ( gc ) => {

		gc.save();
		gc.clip( path );
		gc.fillStyle = 'rgba(0,0,0,0.1)';
		gc.fillRect( 0, 0, length * 1.1, width + bend );
		gc.restore();
		gc.strokeStyle = `rgba(${ r + 30 },${ g + 30 },${ b + 18 },0.45)`;
		gc.lineWidth = Math.max( 0.5, width * 0.09 );
		gc.beginPath();
		gc.moveTo( 0, 0 );
		for ( let k = 1; k <= 8; k ++ ) gc.lineTo( length * 0.92 * k / 8, bend * ( 0.92 * k / 8 ) ** 2 );
		gc.stroke();

	} );
	return paint.finish( 'falling bamboo leaf' );

}

/** How much light a bamboo leaf lets through (vegetation/Material.ts): the crowns' and a fallen
 * leaf's. Tunable on debug pages (debug/Tune.ts: `lighting.vegetation.bambooTranslucency`). */
export const LEAF_TRANSLUCENCY = tuneUniform( 'lighting.vegetation.bambooTranslucency', 0.5, { min: 0.2, max: 1 } );

/** The leaves' material: the trees' leaf material on the atlas over a plant draw's prototype
 * (PlantInstances.ts), swaying with each culm (from its foot), fluttering, toned by the plant's
 * `look` z (1 for every culm), coloured by its place on the leaf band (`look` w,
 * `BAMBOO_TINT`); half translucent (`LEAF_TRANSLUCENCY`: the strength of
 * the light through them, VegetationLighting; a leaf's diffuse does not wrap), firmer leaves than
 * the meadow's blades. */
export function leafMaterial( shared: Shared, atlas: LeafAtlas, plants: PlantInstances ): THREE.MeshStandardNodeMaterial {

	const v = plants.vertex();
	const material = treeLeaves( shared, atlas, v.foot, {
		name: 'bamboo leaves', roughness: 0.75, wind: BAMBOO_WIND, branches: true, tint: BAMBOO_TINT, tone: 0.22, translucency: LEAF_TRANSLUCENCY,
		place: placeVertex( v ), shade: v.lookVarying.z, tintAt: v.lookVarying.w,
	} );
	// the screen-space ambient occlusion (post/GTAO.ts) and shade on the key (post/MeadowShadows.ts)
	receiveScreenAO( material );
	receiveScreenShadow( material );
	// what the leaves over a shaded leaf pass on of the key (vegetation/LeafLight.ts)
	material.userData.keyThrough = true;
	return material;

}

/** The bamboo's parts (Bamboo.ts): its culms' draws and its leaves'. */
export const BAMBOO_PARTS = [ 'bamboo culms', 'bamboo leaves' ];

/** Each plant draw's material (PlantInstances.ts `material`): the culms' whole draws one, their
 * fading draws one with the level stipple, the leaves one with it (all their draws fade). */
export function bambooMaterials( surfaces: { shared: Shared; atlas: LeafAtlas } ): ( draw: PlantDraw, plants: PlantInstances ) => THREE.Material {

	let whole: THREE.Material | null = null, fading: THREE.Material | null = null, leaves: THREE.Material | null = null;
	const stippled = ( material: THREE.MeshStandardNodeMaterial, plants: PlantInstances ) => {

		plants.useStipple( material );
		return material;

	};
	return ( draw, plants ) => {

		if ( draw.part === 1 ) return leaves ??= stippled( leafMaterial( surfaces.shared, surfaces.atlas, plants ), plants );
		if ( draw.fade === 0 ) return whole ??= culmMaterial( surfaces.shared, plants );
		return fading ??= stippled( culmMaterial( surfaces.shared, plants ), plants );

	};

}
