import * as THREE from 'three/webgpu';
import { attribute, float, mix, mx_noise_float, positionGeometry, smoothstep, vec3 } from 'three/tsl';
import { GroundBounceLightingModel } from '../lighting/GroundBounce.ts';
import { CANOPY_SHADE } from '../lighting/AmbientSample.ts';
import { receiveScreenAO } from '../post/GTAO.ts';
import { receiveScreenShadow, screenThickness } from '../post/MeadowShade.ts';
import type { Shared } from '../shared.ts';
import { mulberry32 } from './noise.ts';
import { GROVES } from './BambooGroves.ts';
import { CROWN_DRAG, branchBend, mainBend } from './vegetation/Deform.ts';
import { useVegetationMotion } from './vegetation/Material.ts';
import { placeVertex, type PlantDraw, type PlantInstances } from './vegetation/PlantInstances.ts';
import { IDENTITY_COLOUR, LeafPainter, leafMaterial as treeLeaves, plantTint, type LeafAtlas, type PlantTint } from './vegetation/TreeSurfaces.ts';
import { rootHash } from '../weather/Wind.ts';
import { writeMeter } from '../lighting/MeterLight.ts';
import { tuneUniform } from '../debug/Tune.ts';

// The bamboo's surfaces (Bamboo.ts): its culms and its leaves.
//
// Culms: smooth with a soft sheen, green the first year, then purple in blotches that spread until
// the culm is a muted purple (the culm's age, from its `culm` attribute, against a noise stretched
// along the culm); a thin pale ring of wax just under each node, a fine streaking along the grain.
// As light as the meadow's grass and the leaves, whatever their age (the green a little lighter):
// a painted grove keeps its materials close in value, the culms reading against the dark between
// them by their light and shade, not by a dark colour of their own (so the purple is a dusty one).
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
// atlas of sprays on the trees' painter, vegetation/TreeSurfaces.ts). A clear green, the old
// leaves a few yellow. Here and there a cluster of pale, lustrous seeds, as big as pearls.

/** The culms' colours (linear albedo): new green, purple, the wax under the nodes. */
const CULM = { green: [ 0.124, 0.146, 0.056 ], purple: [ 0.13, 0.082, 0.09 ], wax: [ 0.25, 0.24, 0.2 ] } as const;

/** The culms' occlusion on the ambient volume's path: a soft grounding alone, the culm `foot`
 * darker at its foot and back to its light by `footHeight` m up (the ground at the foot has no term
 * of its own). The grove's darkness is the volume's: a culm in a grove's shade stands lighter than
 * the floor at its foot, which looks up into the canopy while the culm's sides look out level
 * through the grove. A share of the canopy's height term kept on the volume (the `culm`
 * attribute's third) darkened them twice: without it the culms in a grove's shade came out about a
 * quarter lighter, those at its edge as light as the open shade's ground beside them. */
const CULM_SHADE = { foot: 0.05, footHeight: 1 } as const;

/** Each culm's own tint over its leaves (TreeSurfaces.ts plantTint): a little cooler, neutral, a
 * little yellower, by the culm's hash; and the leaves' colour matrix. The culms' wood takes only
 * its matrix (no leaf there). */
export const BAMBOO_TINT: PlantTint = { keys: [ [ 0.47, 0.5, 0.52 ], [ 0.5, 0.5, 0.5 ], [ 0.54, 0.52, 0.46 ] ], keep: 0.4, matrix: IDENTITY_COLOUR };
const CULM_TINT: PlantTint = { ...BAMBOO_TINT, matrix: IDENTITY_COLOUR };

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
	// blotches along the culm, through which the purple spreads as it ages: on the prototype's rest
	// position (so they hold still on a swaying culm) moved by the culm's foot (so no two culms of a
	// prototype share them)
	const grain = positionGeometry.add( v.footVarying );
	const blotch = mx_noise_float( grain.mul( vec3( 22, 2.5, 22 ) ) ).mul( 0.5 ).add( 0.5 );
	const purple = smoothstep( blotch.sub( 0.18 ), blotch.add( 0.18 ), age );
	const streak = mx_noise_float( grain.mul( vec3( 160, 1.2, 160 ) ) ).mul( 0.12 ).add( 1 );
	// the ring of wax just under the node above
	const wax = smoothstep( 0.9, 0.96, phase ).mul( float( 1 ).sub( smoothstep( 0.985, 1, phase ) ) ).mul( 0.5 );
	material.colorNode = plantTint( mix( mix( vec3( ...CULM.green ), vec3( ...CULM.purple ), purple ).mul( streak ), vec3( ...CULM.wax ), wax ), rootHash( v.footVarying.xz ), float( 0 ), CULM_TINT );
	material.roughnessNode = mix( mix( float( 0.55 ), float( 0.45 ), purple ), float( 0.75 ), wax );
	material.name = 'bamboo culms';
	receiveScreenAO( material );
	// the whole scene's screen-space shade on the key (post/MeadowShade.ts); as a caster in it, a
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

// sRGB leaf colours: a clear green, a deeper one, a lighter one, young leaves and a few old yellow
// ones; the twigs purple-brown; the seeds pale and lustrous
const LEAF_COLOURS = [ [ 62, 100, 36 ], [ 50, 84, 30 ], [ 76, 114, 42 ], [ 100, 132, 50 ], [ 150, 140, 66 ] ] as const;
const LEAF_SHARE = [ 0.42, 0.27, 0.2, 0.08, 0.03 ];
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
	const paint = new LeafPainter( size, rng, CURVE, 'rgb(56,90,38)' );
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

/** How much light a bamboo leaf lets through (vegetation/Material.ts): the crowns'. Tunable on debug pages (debug/Tune.ts: `lighting.vegetation.bambooTranslucency`). */
export const LEAF_TRANSLUCENCY = tuneUniform( 'lighting.vegetation.bambooTranslucency', 0.5, { min: 0.2, max: 1 } );

/** The leaves' material: the trees' leaf material on the atlas over a plant draw's prototype
 * (PlantInstances.ts), swaying with each culm (from its foot), fluttering, toned by the plant's
 * `look` z (a shoot's depth in its grove); half translucent (`LEAF_TRANSLUCENCY`: the strength of
 * the light through them, VegetationLighting; a leaf's diffuse does not wrap), firmer leaves than
 * the meadow's blades. */
export function leafMaterial( shared: Shared, atlas: LeafAtlas, plants: PlantInstances ): THREE.MeshStandardNodeMaterial {

	const v = plants.vertex();
	const material = treeLeaves( shared, atlas, v.foot, {
		name: 'bamboo leaves', roughness: 0.75, wind: BAMBOO_WIND, branches: true, tint: BAMBOO_TINT, tone: 0.22, translucency: LEAF_TRANSLUCENCY,
		place: placeVertex( v ), shade: v.lookVarying.z,
	} );
	// the screen-space ambient occlusion (post/GTAO.ts) and shade on the key (post/MeadowShade.ts)
	receiveScreenAO( material );
	receiveScreenShadow( material );
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
