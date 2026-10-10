import * as THREE from 'three/webgpu';
import { attribute, positionLocal, normalViewGeometry, vec3, float, clamp, mix, max, pow, dot, step, smoothstep as smoothstepN } from 'three/tsl';
import { mulberry32, noise3, smoothstep } from './noise.ts';
import { anchorStream } from './Anchors.ts';
import { VEGETATION_STRIDE as STRIDE } from './types.ts';
import { useRestPoseShadows } from './VegetationShadow.ts';
import { VegetationLighting, useLighting } from './VegetationLighting.ts';
import { LEAN_REF, setWindDisplacement, windGust } from '../weather/Wind.ts';
import { mainBend } from './Foliage.ts';
import { keepLegacyWind } from './WindVariants.ts';
import { puddleCover } from '../weather/Puddles.ts';
import { meadowCanopyLight } from '../lighting/MeadowCanopy.ts';
import { islandSurfaceHeight } from './WorldShapes.ts';
import type { Shared } from '../shared.ts';
import { sampleMeadow, supportsMeadow } from '../materials/Meadow.ts';

// Wildflowers as plants rather than coloured stars on the lawn: four species (a rayed daisy, a
// flat umbel, a tall spike and a cupped buttercup), each a low rosette of leaves under the grass
// with a thin stem that lifts a small head just above the sward. They grow in beds of 3-9 of one
// species and colour, and the beds gather in drifts. Bed sites come from noise fields and a seeded
// draw per planting anchor, so the meadow anywhere on a larger island flowers the same way.

// Every geometry is drawn with its head at REF_HEIGHT; the stem then stretches in the vertex stage
// (`flowerColor.w`) to put the head where the plant's own sward ends, without squashing the head.
const REF_HEIGHT = 0.15;
// Heads a little larger than life: a 3 cm daisy is a single pixel from the overview.
const HEAD = 1.7;

// petal: x, vertex shade; y, part (-1 stem, 0 leaf, 1 petal, 2 flower centre); z, lift (0 at the
// ground, 1 at the head: how far the stem's stretch and the wind move the vertex)
class PlantBuilder {

	P: number[] = []; N: number[] = []; A: number[] = []; I: number[] = [];

	add( x: number, y: number, z: number, nx: number, ny: number, nz: number, shade: number, part: number, lift: number ): number {

		this.P.push( x, y, z );
		const l = Math.hypot( nx, ny, nz ) || 1;
		this.N.push( nx / l, ny / l, nz / l );
		this.A.push( shade, part, lift, 0 );
		return this.P.length / 3 - 1;

	}

	tri( a: number, b: number, c: number ) { this.I.push( a, b, c ); }

	// A low rosette of leaves, rising a little from the root: it fills the plant's base under
	// the grass, so the stem does not stand bare on the turf.
	rosette( rng: () => number, leaves: number, length: [ number, number ], width: number ) {

		for ( let i = 0; i < leaves; i ++ ) {

			const a = ( i + rng() * 0.6 ) / leaves * Math.PI * 2;
			const dx = Math.cos( a ), dz = Math.sin( a ), tx = - dz, tz = dx;
			const len = length[ 0 ] + rng() * ( length[ 1 ] - length[ 0 ] ), rise = 0.25 + rng() * 0.35;
			const w = width * ( 0.8 + rng() * 0.4 );
			const b = this.add( 0, 0.004, 0, 0, 1, 0, 0.55, 0, 0 );
			this.add( dx * len * 0.42 + tx * w, len * rise * 0.42, dz * len * 0.42 + tz * w, dx * 0.3, 1, dz * 0.3, 0.85, 0, 0 );
			this.add( dx * len, len * rise * 0.7, dz * len, dx * 0.5, 1, dz * 0.5, 1, 0, 0 );
			this.add( dx * len * 0.42 - tx * w, len * rise * 0.42, dz * len * 0.42 - tz * w, dx * 0.3, 1, dz * 0.3, 0.75, 0, 0 );
			this.tri( b, b + 1, b + 2 ); this.tri( b, b + 2, b + 3 );

		}

	}

	// Two crossed thin quads from the root to `top`. Kept out of the sun's map (see flowerMaterial).
	stem( top: number, width = 0.004 ) {

		for ( const [ ax, az ] of [ [ 1, 0 ], [ 0, 1 ] ] ) {

			const s = this.add( - ax * width, 0, - az * width, az, 0.2, ax, 0.6, - 1, 0 );
			this.add( ax * width, 0, az * width, az, 0.2, ax, 0.6, - 1, 0 );
			this.add( ax * width * 0.7, top, az * width * 0.7, az, 0.2, ax, 0.95, - 1, 1 );
			this.add( - ax * width * 0.7, top, - az * width * 0.7, az, 0.2, ax, 0.95, - 1, 1 );
			this.tri( s, s + 1, s + 2 ); this.tri( s, s + 2, s + 3 );

		}

	}

	// A small disc of `n` rim vertices around a raised centre.
	disc( cx: number, cy: number, cz: number, r: number, n: number, raise: number, part: number, shade = 1 ) {

		const c = this.add( cx, cy + raise, cz, 0, 1, 0, shade, part, 1 );
		for ( let i = 0; i < n; i ++ ) {

			const a = i / n * Math.PI * 2;
			this.add( cx + Math.cos( a ) * r, cy, cz + Math.sin( a ) * r, Math.cos( a ) * 0.3, 1, Math.sin( a ) * 0.3, shade * 0.8, part, 1 );

		}
		for ( let i = 0; i < n; i ++ ) this.tri( c, c + 1 + i, c + 1 + ( i + 1 ) % n );

	}

	// A petal: a diamond from `base` (r0) through its widest point to the tip, in the plane
	// spanned by the direction ( dx, dz ) and the rise.
	petal( a: number, cy: number, r0: number, r1: number, rMid: number, halfWidth: number, yMid: number, yTip: number, shades: [ number, number, number ], ox = 0, oz = 0 ) {

		const dx = Math.cos( a ), dz = Math.sin( a ), tx = - dz, tz = dx;
		const ny = 1, nx = - dx * ( yTip - cy ) * 6, nz = - dz * ( yTip - cy ) * 6; // cupped petals face inward
		const b = this.add( ox + dx * r0, cy, oz + dz * r0, nx, ny, nz, shades[ 0 ], 1, 1 );
		this.add( ox + dx * rMid + tx * halfWidth, yMid, oz + dz * rMid + tz * halfWidth, nx + tx * 0.3, ny, nz + tz * 0.3, shades[ 1 ], 1, 1 );
		this.add( ox + dx * r1, yTip, oz + dz * r1, nx, ny, nz, shades[ 2 ], 1, 1 );
		this.add( ox + dx * rMid - tx * halfWidth, yMid, oz + dz * rMid - tz * halfWidth, nx - tx * 0.3, ny, nz - tz * 0.3, shades[ 1 ] * 0.92, 1, 1 );
		this.tri( b, b + 1, b + 2 ); this.tri( b, b + 2, b + 3 );

	}

	geometry(): THREE.BufferGeometry {

		const g = new THREE.BufferGeometry();
		g.setAttribute( 'position', new THREE.Float32BufferAttribute( this.P, 3 ) );
		g.setAttribute( 'normal', new THREE.Float32BufferAttribute( this.N, 3 ) );
		g.setAttribute( 'petal', new THREE.Float32BufferAttribute( this.A, 4 ) );
		g.setIndex( this.I );
		return g;

	}

}

const H = REF_HEIGHT;

// Oxeye daisy: a ring of narrow rays round a raised golden disc.
function daisyGeometry(): THREE.BufferGeometry {

	const b = new PlantBuilder(), rng = mulberry32( 41 );
	b.rosette( rng, 6, [ 0.06, 0.1 ], 0.012 );
	b.stem( H );
	const rays = 13;
	for ( let i = 0; i < rays; i ++ ) {

		const a = ( i + rng() * 0.3 ) / rays * Math.PI * 2;
		b.petal( a, H, 0.008 * HEAD, 0.043 * HEAD, 0.026 * HEAD, 0.0055 * HEAD, H + 0.002, H - 0.004 * HEAD, [ 0.82, 0.97, 1 ] );

	}
	b.disc( 0, H + 0.002, 0, 0.011 * HEAD, 7, 0.007 * HEAD, 2 );
	return b.geometry();

}

// Yarrow-like umbel: a flat, slightly domed head of small florets on short spokes.
function umbelGeometry(): THREE.BufferGeometry {

	const b = new PlantBuilder(), rng = mulberry32( 43 );
	b.rosette( rng, 5, [ 0.07, 0.12 ], 0.016 );
	b.stem( H );
	const florets = 9;
	for ( let i = 0; i < florets; i ++ ) {

		const a = i * 2.39996, rho = Math.sqrt( ( i + 0.5 ) / florets ) * 0.05 * HEAD;
		const fx = Math.cos( a ) * rho, fz = Math.sin( a ) * rho, fy = H + 0.03 * HEAD - rho * rho * 4;
		// the spoke, a sliver from the stem top to the floret
		const s = b.add( - 0.002, H, 0, 0, 0.3, 1, 0.8, - 1, 1 );
		b.add( 0.002, H, 0, 0, 0.3, 1, 0.8, - 1, 1 );
		b.add( fx, fy, fz, 0, 0.3, 1, 0.9, - 1, 1 );
		b.tri( s, s + 1, s + 2 );
		b.disc( fx, fy, fz, ( 0.014 + rng() * 0.004 ) * HEAD, 5, 0.004 * HEAD, 1, 0.85 + rng() * 0.15 );

	}
	return b.geometry();

}

// A spike of small florets in whorls up the top of the stem, tapering to a bud: the bed's height.
function spikeGeometry(): THREE.BufferGeometry {

	const b = new PlantBuilder(), rng = mulberry32( 47 );
	b.rosette( rng, 6, [ 0.08, 0.13 ], 0.014 );
	const whorls = 8, length = 0.12 * HEAD;
	b.stem( H + length );
	for ( let w = 0; w < whorls; w ++ ) {

		const f = w / ( whorls - 1 ), y = H + f * length;
		const r = ( 0.022 - f * 0.013 ) * HEAD;
		for ( let j = 0; j < 3; j ++ ) {

			const a = w * 0.95 + j * Math.PI * 2 / 3 + rng() * 0.4;
			b.petal( a, y, 0.002, r, r * 0.55, r * 0.42, y + r * 0.35, y + r * 0.6, [ 0.62 + f * 0.2, 0.9, 1 ] );

		}

	}
	return b.geometry();

}

// Buttercup: five glossy petals cupped round a dark centre, the throat in shade.
function cupGeometry(): THREE.BufferGeometry {

	const b = new PlantBuilder(), rng = mulberry32( 53 );
	b.rosette( rng, 5, [ 0.05, 0.09 ], 0.018 );
	b.stem( H );
	const petals = 5;
	for ( let i = 0; i < petals; i ++ ) {

		const a = ( i + rng() * 0.2 ) / petals * Math.PI * 2;
		b.petal( a, H, 0.004 * HEAD, 0.03 * HEAD, 0.019 * HEAD, 0.012 * HEAD, H + 0.013 * HEAD, H + 0.027 * HEAD, [ 0.5, 0.86, 1 ] );

	}
	b.disc( 0, H + 0.003, 0, 0.007 * HEAD, 5, 0.004 * HEAD, 2 );
	return b.geometry();

}

interface Species {
	name: string;
	geometry: () => THREE.BufferGeometry;
	palette: number[][]; // linear petal colours, one per bed
	centre: number[]; // the flower centre's colour
	lift: [ number, number ]; // head height above the plant's sward top (m)
	size: [ number, number ];
	clear: number; // minimum distance to the walking loop (m)
}

const SPECIES: Species[] = [
	{ name: 'daisy', geometry: daisyGeometry, palette: [ [ 0.62, 0.6, 0.5 ], [ 0.68, 0.42, 0.045 ], [ 0.6, 0.44, 0.46 ] ], centre: [ 0.55, 0.33, 0.03 ], lift: [ 0.02, 0.1 ], size: [ 0.85, 1.2 ], clear: 0.55 },
	{ name: 'umbel', geometry: umbelGeometry, palette: [ [ 0.56, 0.53, 0.42 ], [ 0.62, 0.46, 0.06 ], [ 0.56, 0.34, 0.37 ] ], centre: [ 0.4, 0.38, 0.28 ], lift: [ 0.06, 0.18 ], size: [ 0.85, 1.2 ], clear: 0.7 },
	{ name: 'spike', geometry: spikeGeometry, palette: [ [ 0.25, 0.21, 0.5 ], [ 0.18, 0.18, 0.47 ], [ 0.47, 0.2, 0.31 ] ], centre: [ 0.2, 0.15, 0.3 ], lift: [ 0.08, 0.24 ], size: [ 0.85, 1.25 ], clear: 1.1 },
	{ name: 'cup', geometry: cupGeometry, palette: [ [ 0.65, 0.39, 0.045 ], [ 0.7, 0.46, 0.05 ], [ 0.62, 0.24, 0.055 ] ], centre: [ 0.3, 0.17, 0.03 ], lift: [ 0.02, 0.12 ], size: [ 0.85, 1.2 ], clear: 0.55 },
];

function flowerMaterial( shared: Shared, centre: number[], legacy = false ): THREE.MeshStandardNodeMaterial {

	const mat = new THREE.MeshStandardNodeMaterial( { side: THREE.DoubleSide, roughness: 0.79 } );
	const attr = attribute<'vec4'>( 'petal', 'vec4' );
	const shade = attr.x, part = attr.y, lift = attr.z;
	const tint = attribute<'vec4'>( 'flowerColor', 'vec4' );
	const ground = attribute<'vec4'>( 'flowerGround', 'vec4' ); // xyz root, w the sward top above it
	const bloom = mix( tint.rgb, vec3( ...centre as [ number, number, number ] ), smoothstepN( 1.1, 1.9, part ) );
	const wetness = clamp( shared.wetness, 0, 1 );
	const isBloom = smoothstepN( 0.2, 0.8, part );
	mat.colorNode = mix( vec3( 0.04, 0.1, 0.02 ), bloom, isBloom ).mul( shade ).mul( mix( 1, 0.95, wetness ) );
	mat.roughnessNode = mix( 0.79, 0.72, wetness );
	// The stem stretches to its plant's height (positionLocal is already placed by the instance).
	const p = positionLocal;
	const raised = p.add( vec3( 0, tint.w.mul( lift ), 0 ) );
	// Standing water drowns the whole plant: it sinks under the ground, which carries the water.
	const pool = puddleCover( ground.xz, shared.wetness );
	const rooted = raised.sub( vec3( 0, pool.mul( ground.w.add( tint.w ).add( 0.3 ) ), 0 ) );
	const wind = shared.wind.direction;
	const gust = windGust( p.xz, wind, shared.wind.phase ).mul( shared.wind.strength );
	// The stem bends from its root with the gust field as the grass around it does (its lean
	// times its height, growing with the square of the lift), nodding on its own at 1.2 Hz.
	const swayed = legacy ? rooted.add( vec3( wind.x, 0, wind.y ).mul( gust.mul( 0.03 ).mul( lift.mul( lift ) ) ) )
		: setWindDisplacement( mat, ( state ) => mainBend( state, rooted, ground.xyz, ground.w.add( tint.w ).add( 0.1 ).mul( lift.mul( lift ) ).mul( LEAN_REF ), 1.2 ).position, shared.wind );
	// Only the heads cast into the sun's map: stems and the rosette under the grass are thinner
	// than a texel (see useRestPoseShadows), and the meadow's canopy shades the rosette instead.
	const rest = useRestPoseShadows( mat, rooted, swayed, step( 0.5, part ) );
	mat.normalNode = normalViewGeometry;
	mat.aoNode = mix( float( 0.6 ), float( 1 ), lift ).mul( attribute<'float'>( 'skyVisibility', 'float' ) );
	// Lit as the other plants: the grass canopy shades what stands in it, and thin petals glow
	// with light from behind (more than the leaves, which are thicker and darker).
	const canopy = meadowCanopyLight( rest.xz, max( ground.w.sub( rest.y.sub( ground.y ) ), 0 ), shared.sunDir );
	useLighting( mat, () => new VegetationLighting( canopy, ( L, V ) =>
		pow( clamp( dot( V.negate(), L ), 0, 1 ), 3 ).mul( mix( float( 0.25 ), float( 0.6 ), isBloom ) ).add( mix( float( 0.04 ), float( 0.12 ), isBloom ) ) ) );
	return mat;

}

export interface Plant { m: THREE.Matrix4; color: THREE.Color; stretch: number; root: THREE.Vector3; sward: number; visibility: number }

/** The wildflowers grown on the anchors `veg` (any of them: a bed belongs to its anchor), one list
 * per species. `walkDistance` (m from a point to the islander's loop) keeps the beds, and the tall
 * spikes further, off the path. */
export function plantFlowers( veg: Float32Array, walkDistance?: ( x: number, z: number ) => number ): Plant[][] {

	const plants: Plant[][] = SPECIES.map( () => [] );
	const n = veg.length / STRIDE;
	const draws = new Float32Array( 6 );
	const q = new THREE.Quaternion(), tilt = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
	const up = new THREE.Vector3( 0, 1, 0 ), lean = new THREE.Vector3();
	for ( let i = 0; i < n; i ++ ) {

		const k = i * STRIDE;
		const x = veg[ k ], y = veg[ k + 1 ], z = veg[ k + 2 ];
		// The anchor's draws and its bed's come from streams of its own cell.
		const rng = anchorStream( x, z, 31 );
		for ( let d = 0; d < draws.length; d ++ ) draws[ d ] = rng();
		if ( veg[ k + 7 ] > 0 || ! supportsMeadow( y, veg[ k + 4 ] ) ) continue;
		// Beds stay a bed's width inside the coast, so every plant roots on the plateau.
		if ( veg[ k + 6 ] > - 0.8 ) continue;
		// Drifts: beds gather where the drift field is high, with a few strays elsewhere.
		const drift = noise3( x * 0.28 + 11.0, 4.4, z * 0.28 ) * 0.5 + 0.5;
		if ( draws[ 0 ] > smoothstep( 0.5, 0.72, drift ) * 0.17 + 0.006 ) continue;
		// The species follows a broad field (neighbouring beds tend to match), loosened per bed.
		const sp = noise3( x * 0.16 - 3.3, 9.2, z * 0.16 + 5.5 ) * 0.5 + 0.5;
		const s = Math.min( SPECIES.length - 1, Math.floor( ( ( sp * 2.6 + draws[ 1 ] * 0.35 ) % 1 ) * SPECIES.length ) );
		const species = SPECIES[ s ];
		const clearance = walkDistance ? walkDistance( x, z ) : Infinity;
		const radius = 0.3 + draws[ 2 ] * 0.3;
		if ( clearance < species.clear + radius ) continue;
		const color = new THREE.Color().fromArray( species.palette[ Math.floor( draws[ 3 ] * species.palette.length ) ] );
		const count = 3 + Math.floor( draws[ 4 ] * 7 );
		const bed = anchorStream( x, z, 7919 );
		for ( let c = 0; c < count; c ++ ) {

			// spread over the bed, denser toward its middle
			const a = bed() * Math.PI * 2, r = Math.pow( bed(), 0.7 ) * radius;
			const px = x + Math.cos( a ) * r, pz = z + Math.sin( a ) * r;
			const py = islandSurfaceHeight( px, pz );
			if ( Math.abs( py - y ) > 0.08 ) continue;
			// The sward top here, as plantGrass grows it: the head stands a little clear of it.
			const growth = sampleMeadow( px, pz ).growth;
			const sward = ( 0.17 + 0.14 * growth ) * 0.85;
			const size = species.size[ 0 ] + bed() * ( species.size[ 1 ] - species.size[ 0 ] );
			const head = sward + species.lift[ 0 ] + bed() * ( species.lift[ 1 ] - species.lift[ 0 ] );
			q.setFromAxisAngle( up, bed() * Math.PI * 2 );
			// most heads stand nearly upright; about a third lean further, as stems bend
			const bend = bed() < 0.3 ? 0.18 + bed() * 0.22 : bed() * 0.12;
			const ba = bed() * Math.PI * 2;
			lean.set( Math.cos( ba ) * Math.sin( bend ), Math.cos( bend ), Math.sin( ba ) * Math.sin( bend ) );
			tilt.setFromUnitVectors( up, lean );
			q.premultiply( tilt );
			pos.set( px, py - 0.01, pz );
			scl.setScalar( size );
			plants[ s ].push( {
				m: new THREE.Matrix4().compose( pos, q, scl ),
				color: color.clone().multiplyScalar( 0.9 + bed() * 0.2 ),
				stretch: Math.max( head - REF_HEIGHT * size, - REF_HEIGHT * size * 0.4 ),
				root: pos.clone(), sward, visibility: veg[ k + 8 ],
			} );

		}

	}
	return plants;

}

/** Wildflower beds on the meadow: the plants `plantFlowers` grew, one instanced mesh per species. */
export function buildFlowers( plants: Plant[][], shared: Shared ): THREE.Group {

	const group = new THREE.Group();
	group.name = 'flowers';
	SPECIES.forEach( ( species, s ) => {

		const list = plants[ s ], count = Math.max( list.length, 1 );
		const geo = species.geometry();
		const colors = new Float32Array( count * 4 ), ground = new Float32Array( count * 4 ), visibility = new Float32Array( count );
		geo.setAttribute( 'flowerColor', new THREE.InstancedBufferAttribute( colors, 4 ) );
		geo.setAttribute( 'flowerGround', new THREE.InstancedBufferAttribute( ground, 4 ) );
		geo.setAttribute( 'skyVisibility', new THREE.InstancedBufferAttribute( visibility, 1 ) );
		const mesh = new THREE.InstancedMesh( geo, flowerMaterial( shared, species.centre ), count );
		keepLegacyWind( mesh, flowerMaterial( shared, species.centre, true ) );
		list.forEach( ( plant, i ) => {

			mesh.setMatrixAt( i, plant.m );
			plant.color.toArray( colors, i * 4 );
			colors[ i * 4 + 3 ] = plant.stretch;
			plant.root.toArray( ground, i * 4 );
			ground[ i * 4 + 3 ] = plant.sward;
			visibility[ i ] = plant.visibility;

		} );
		mesh.count = list.length;
		mesh.instanceMatrix.needsUpdate = true;
		mesh.frustumCulled = false;
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		mesh.name = `flowers-${ species.name }`;
		mesh.renderOrder = - 1;
		group.add( mesh );

	} );
	return group;

}
