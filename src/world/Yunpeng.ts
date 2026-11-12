import * as THREE from 'three/webgpu';
import { attribute, float, mix, smoothstep, uniform, vec3 } from 'three/tsl';
import { GroundBounceLightingModel } from '../lighting/GroundBounce.ts';
import { receiveScreenAO } from '../post/GTAO.ts';
import { receiveScreenShadow } from '../post/MeadowShade.ts';
import type { Shared } from '../shared.ts';
import { debugFlags } from '../debug/DebugFlags.ts';
import { NIGHT_METER_LIFT } from '../sky/DayCycle.ts';
import { mulberry32, type Rng } from './noise.ts';
import { SEABED_TILE } from './SeabedTile.ts';
import { runSteps } from './Steps.ts';
import type { WorldData } from './types.ts';
import { islandSurfaceHeight } from './WorldShapes.ts';
import { plantClumps, type ClumpLand, type ClumpSite } from './YunpengSites.ts';
import { leafFlutter, mainBend } from './vegetation/Deform.ts';
import { useVegetationMotion } from './vegetation/Material.ts';
import { PLANT_PART, PlantInstances, levelDraws, placeVertex, plantPoint, type PlantDraw, type PlantInstance, type PlantPool } from './vegetation/PlantInstances.ts';
import { IDENTITY_COLOUR, plantTint, type PlantTint } from './vegetation/TreeSurfaces.ts';
import { rootHash } from '../weather/Wind.ts';
import type { KindGrowth, VegetationKind } from './vegetation/Registry.ts';
import type { LocalSource } from '../lighting/LocalLights.ts';
import { writeMeter } from '../lighting/MeterLight.ts';

// The yunpeng (芸蓬) of Yuanjiao: "a grass named yunpeng, white as snow, a stem two zhang long; seen
// at night it gives a white light; it makes a staff" (Wang Jia, Shiyi ji, book 10). Yuanjiao and
// Daiyu drifted to the north pole and sank (Liezi, Tangwen); here its grass lives on. It grows in
// the meadow, single clumps far apart, an accent among the grass and never a stand: about ten on a
// grown island, at least about 13 m apart, maybe none on the starting island (YunpengSites.ts:
// where they stand, their size and their stalks' seed).
//
// Its form, after the tall herbaceous stalks of giant reed and giant fennel (a grass two zhang high
// is a tall herb's stem, not a tree's trunk):
// - A clump of straight, slender stalks, snow white, from a foot's disc (YUNPENG.foot), each leaning
//   a little out from the clump and bowing over at its top; a tall clump's tallest about 5 m (two
//   zhang), a lower one's younger (YUNPENG.height; YunpengSites.ts MEADOW_CLUMPS.tall their
//   share). A stalk is round, thinning upward, a faint node every YUNPENG.internode (its colour),
//   and stiff and straight enough to cut a staff from.
// - Long, narrow leaves up its lower part (YUNPENG.leaves, YUNPENG.leafy), arching out and
//   drooping, white and greyer near the ground.
// - At the top a slim spindle of pale seed (YUNPENG.head) and round it a plume of fine tassels
//   arching out and hanging (YUNPENG.plume), the tangle of a 蓬.
// - White as snow: a high, slightly cool albedo, a waxy sheen; by night a white light of its own
//   (YUNPENG.glow, as emission, times the night's share, `yunpengNight`: none by day;
//   `flags=yunpengGlow:<strength>` at load sets it for A/Bs), which lights the ground and the plants
//   round the clump: a local light per clump (lighting/LocalLights.ts, `Yunpeng.lights`) at the
//   centroid of its glowing surface, of the intensity that surface gives, its glow's radiance times
//   its area seen from outside (a thin round stalk shows a quarter of its surface on average from
//   all directions, a two-sided leaf or tassel half of one face's), so the light and the glow are
//   one quantity. Its range: YUNPENG.reach.
// - The glow and its light are scaled by one constant, 2 to minus DayCycle.ts NIGHT_METER_LIFT, the
//   stops the metered exposure rises by from the twilight to a clear night: a lamp does not know the
//   hour or the weather, so a clear night shows it as the glow's value was set for, it shows later
//   in the dusk (the exposure has not yet risen), and brighter on a darker night, as a lamp does.
// - It bends in the one wind from each stalk's foot, its top the most, with the drag on it, each
//   stalk by its own stiffness and drag (`stalkLoad`) and swinging at its own rate and phase
//   (Deform.ts mainBend), the leaves and the plume's tassels fluttering from their foot as the
//   gusts pass (Deform.ts leafFlutter).
//
// Drawn as instances (vegetation/PlantInstances.ts): a few prototypes, each one upright stalk with
// its leaves and plume built at the origin (YUNPENG.prototypes: bands of a stalk's height, each from
// a fixed seed, so the same on every page); every stalk of a clump an instance of the band its
// height falls in, scaled to its height (its tube thickened as the height to the 0.6, its leaves and
// tassels kept at their size), turned to the way it leans, leaning and bowing (`stemAxis`). A
// clump's stalks draw from one stream seeded by its site. Each prototype has a far level
// (YUNPENG.far: a stalk of four sides, rings far apart below the head, half its leaves, widened to
// keep their cover, every tassel) that takes over where its stalk is a few pixels wide
// (vegetation/Lod.ts LEVEL_SWITCH). A clump's light is summed from its stalks' prototypes' glow
// (`prototypeGlow`), so it needs no mesh of its own.
//
// One vegetation kind (an ordinary shadow, no depth prepass), present with no clump too (a pool of
// no plant), so a growth that brings the first clump builds no pipeline. The clumps are a function
// of the land's fields (YunpengSites.ts), planted per land chunk in the chunks' order ( cj, ci ), so
// the yunpeng follows the land's version: a growth step plants every land chunk again and, where
// the clumps changed, fills a new instance pool in idle-time steps, and the swap points the cull at
// it (PlantInstances.ts `prepare`, `swap`) and moves the lights (main.ts `onSwap`).

export const YUNPENG = {
	stalks: [ 14, 9 ] as const, // stalks in a tall clump and in a lower one
	height: [ [ 3.2, 5 ], [ 2.2, 3.4 ] ] as const, // a stalk's height (m, the least and the most) in a tall clump and a lower one
	foot: 0.4, // the clump's radius at the ground (m)
	radius: 0.017, // a 5 m stalk's radius at its foot (m)
	lean: [ 0.03, 0.14 ] as const, // a stalk's lean out from the clump (rad)
	bow: 0.25, // how far a 5 m stalk's top bows over (m)
	internode: 0.45, // between nodes (m)
	leaves: [ 5, 8 ] as const, // leaves a stalk carries, over its lower `leafy` share
	leafy: 0.65,
	leaf: [ 0.5, 0.95 ] as const, // a leaf's length (m)
	head: 0.3, // the seed spindle's length (m)
	plume: [ 12, 0.25, 0.45 ] as const, // the plume's tassels and their length (m, the least and the most)
	load: 0.035, // a 5 m stalk's wind load in fair's mean wind (Deform.ts mainBend's lambda_0: `stalkLoad`)
	flutter: 0.03, // a leaf's flutter at its tip (m, Deform.ts leafFlutter's A_l; the weight from its foot squared)
	glow: 0.004, // the white light by night (emission, of the albedo)
	reach: 6.5, // where a clump's light ends (m from its centroid)
	// the stalks' prototypes: bands of a stalk's height (m) over every height a clump gives one
	prototypes: { count: 4, height: [ 2.5, 5 ] as const },
	// the far level: the stalk's sides, its rings' spacing below the head (m), the leaves kept
	far: { sides: 4, ring: 0.4, leaves: 0.5 },
};

/** The night's share of the glow and the light (0 by day: DayCycle.ts `yunpengNightShare`), each
 * frame. */
export const yunpengNight = uniform( 0 );
/** The glow's strength in scene units: the flag's at load (`yunpengGlow`), else YUNPENG.glow, both
 * set for a clear night's exposure, over the night's rise in the metered exposure (the header). */
const glowLevel = (): number => Number( debugFlags.yunpengGlow ?? YUNPENG.glow ) * 2 ** - NIGHT_METER_LIFT;

// linear albedo: snow white, a little cool; greyer at the foot
const WHITE = [ 0.72, 0.74, 0.76 ], FOOT = [ 0.42, 0.44, 0.4 ];
// each stalk's own tint over its leaves (TreeSurfaces.ts plantTint, by its foot's hash): a little
// warmer, neutral, a little cooler; and the material's colour matrix. Its glow keeps the untinted
// white, so the clump's light (`prototypeGlow`) stays its glow's.
const TINT: PlantTint = { keys: [ [ 0.52, 0.5, 0.48 ], [ 0.5, 0.5, 0.5 ], [ 0.48, 0.5, 0.52 ] ], keep: 0.5, matrix: IDENTITY_COLOUR };
/** The yunpeng's wind: its stalks' sway rate (swings a metre of the plants' travel, Deform.ts
 * mainBend: 1.5 Hz on a fair day), the drag's exponent of the wind (`stalkLoad`: mostly the bare
 * stalk's, which does not streamline) and its leaves' flutter (Hz). */
export const YUNPENG_WIND = { rate: 0.16, drag: 1.8, flutter: 2.2 } as const;

// ------------------------------------------------------------------ a stalk's mesh

class Builder {

	readonly P: number[] = [];
	readonly N: number[] = [];
	readonly sway: number[] = []; // `leafSway`: x eta^2 at the point it hangs from, y the flutter, z the phase, w eta, its share of the stalk's height
	readonly hang: number[] = []; // `plantPart`: the share of the stalk it hangs from, 1 on the tube
	readonly part: number[] = []; // 0 stalk, 1 leaf, 2 head
	readonly I: number[] = [];

	vertex( p: THREE.Vector3, n: THREE.Vector3, sway: number[], hang: number[], part: number ): number {

		this.P.push( p.x, p.y, p.z );
		this.N.push( n.x, n.y, n.z );
		this.sway.push( ...sway );
		this.hang.push( ...hang );
		this.part.push( part );
		return this.P.length / 3 - 1;

	}

	geometry( name: string ): THREE.BufferGeometry {

		const g = new THREE.BufferGeometry();
		g.setAttribute( 'position', new THREE.Float32BufferAttribute( this.P, 3 ) );
		g.setAttribute( 'normal', new THREE.Float32BufferAttribute( this.N, 3 ) );
		g.setAttribute( 'leafSway', new THREE.Float32BufferAttribute( this.sway, 4 ) );
		g.setAttribute( PLANT_PART, new THREE.Float32BufferAttribute( this.hang, 2 ) );
		g.setAttribute( 'yunpengPart', new THREE.Float32BufferAttribute( this.part, 1 ) );
		g.setIndex( new THREE.Uint32BufferAttribute( this.I, 1 ) );
		g.name = name;
		return g;

	}

}

/** What a level builds: the tube's sides and rings' spacing below the head (null: the head's), the
 * head's rings, the leaves' share kept and every ribbon's segments. */
interface Level { sides: number; ring: number | null; headRings: number; leaves: number; segs: number }
const RING = 0.12;
const NEAR: Level = { sides: 7, ring: null, headRings: 0, leaves: 1, segs: 8 };
const FAR: Level = { sides: YUNPENG.far.sides, ring: YUNPENG.far.ring, headRings: 2, leaves: YUNPENG.far.leaves, segs: 4 };

const UP = new THREE.Vector3( 0, 1, 0 );

/** The stalk's tube: up the axis from below the ground to the head's foot, then the head's spindle,
 * upright at the origin, the prototype's +x the way its instances lean. */
function stalk( b: Builder, height: number, level: Level ): void {

	const sides = level.sides;
	const r0 = YUNPENG.radius * Math.pow( height / 5, 0.6 );
	const headFrom = 1 - YUNPENG.head / height;
	// the rings' shares: evenly at the near level; below the head at the far level's spacing, then
	// the head's few
	const shares: number[] = [];
	if ( level.ring === null ) {

		const rings = Math.ceil( height / RING );
		for ( let i = 0; i <= rings; i ++ ) shares.push( i / rings );

	} else {

		const body = Math.max( 1, Math.ceil( headFrom * height / level.ring ) );
		for ( let i = 0; i <= body; i ++ ) shares.push( headFrom * i / body );
		for ( let i = 1; i <= level.headRings; i ++ ) shares.push( headFrom + ( 1 - headFrom ) * i / level.headRings );

	}
	const first = b.P.length / 3;
	const d = new THREE.Vector3(), p = new THREE.Vector3();
	for ( const s of shares ) {

		// thinning upward, then the head: swelling to a spindle and drawn to a point
		const h = Math.max( 0, ( s - headFrom ) / ( 1 - headFrom ) );
		const r = s < headFrom ? r0 * ( 1 - 0.5 * s ) : r0 * 0.5 * ( 1 + 1.6 * Math.sin( Math.PI * Math.min( h * 1.15, 1 ) ) ) * ( 1 - h ** 3 );
		for ( let j = 0; j < sides; j ++ ) {

			const a = j / sides * Math.PI * 2;
			d.set( Math.cos( a ), 0, Math.sin( a ) );
			p.set( 0, s * height, 0 ).addScaledVector( d, r );
			// the foot a little into the ground
			if ( s === 0 ) p.y -= 0.08;
			b.vertex( p, d, [ s * s, 0, 0, s ], [ s, 1 ], s < headFrom ? 0 : 2 );

		}

	}
	for ( let i = 0; i < shares.length - 1; i ++ ) for ( let j = 0; j < sides; j ++ ) {

		const a = first + i * sides + j, bb = first + i * sides + ( j + 1 ) % sides, cc = a + sides, dd = bb + sides;
		b.I.push( a, cc, bb, bb, cc, dd );

	}

}

/** A leaf from share s of a stalk `height` tall (or a plume's tassel, `wide` of a leaf's width): a
 * narrow ribbon arching out and drooping (a quadratic curve), in `dir`, drawn on both sides; its
 * draws taken whether or not the level keeps it (`keep`, its width times `widen`), so both levels
 * place the same leaves. */
function leaf( b: Builder, height: number, s: number, dir: THREE.Vector3, length: number, rng: Rng, wide: number, level: Level, keep: boolean, widen: number ): void {

	const base = new THREE.Vector3( 0, s * height, 0 );
	const rise = 0.3 + 0.2 * rng(), droop = 0.25 + 0.25 * rng();
	const width = 0.032 * wide * ( 0.8 + 0.4 * rng() ) * widen, phase = rng();
	if ( ! keep ) return;
	const mid = base.clone().addScaledVector( dir, 0.45 * length ).addScaledVector( UP, rise * length );
	const tip = base.clone().addScaledVector( dir, 0.85 * length ).addScaledVector( UP, ( rise - droop ) * length );
	const curve = new THREE.QuadraticBezierCurve3( base, mid, tip );
	const across = new THREE.Vector3().crossVectors( UP, dir ).normalize();
	const segs = level.segs;
	const first = b.P.length / 3;
	const t = new THREE.Vector3(), n = new THREE.Vector3();
	for ( let i = 0; i <= segs; i ++ ) {

		const u = i / segs;
		const p = curve.getPoint( u );
		curve.getTangent( u, t );
		n.crossVectors( across, t ).normalize();
		const w = width * 0.5 * Math.sin( Math.PI * Math.min( 0.15 + u * 0.95, 1 ) ) * ( 1 - 0.85 * u );
		const share = Math.max( s + ( p.y - base.y ) / height, 0 );
		for ( const side of [ - 1, 1 ] ) b.vertex( p.clone().addScaledVector( across, side * w ), n, [ s * s, YUNPENG.flutter * u * u, phase, share ], [ s, 0 ], 1 );

	}
	for ( let i = 0; i < segs; i ++ ) {

		const a = first + i * 2;
		b.I.push( a, a + 2, a + 1, a + 1, a + 2, a + 3 );

	}

}

/** Prototype `k`'s stalk height: its band's middle. */
function prototypeHeight( k: number ): number {

	const { count, height: [ lo, hi ] } = YUNPENG.prototypes;
	return lo + ( hi - lo ) * ( k + 0.5 ) / count;

}

/** Prototype `k` at a level: one stalk, its leaves and its plume, from its fixed seed. */
function prototypeMesh( k: number, level: Level ): THREE.BufferGeometry {

	const P = YUNPENG, b = new Builder(), rng = mulberry32( 0x9e7e00 + k );
	const height = prototypeHeight( k );
	stalk( b, height, level );
	// the leaves' mean count, rounded down and up on alternate prototypes (so a clump carries as many
	// as stalks of random counts would); the far level every other one, widened to keep the cover
	const mean = ( P.leaves[ 0 ] + P.leaves[ 1 ] ) / 2;
	const leaves = k % 2 === 0 ? Math.floor( mean ) : Math.ceil( mean );
	const every = Math.round( 1 / level.leaves );
	for ( let l = 0; l < leaves; l ++ ) {

		const turn = rng() * Math.PI * 2;
		const along = 0.04 + ( P.leafy - 0.04 ) * ( l + rng() ) / leaves;
		const length = ( P.leaf[ 0 ] + ( P.leaf[ 1 ] - P.leaf[ 0 ] ) * rng() ) * ( 1 - 0.4 * along );
		leaf( b, height, along, new THREE.Vector3( Math.cos( turn ), 0, Math.sin( turn ) ), length, rng, 1, level, l % every === 0, Math.sqrt( every ) );

	}
	// the plume: fine tassels from the head's foot, arching out and hanging
	const [ tassels, t0, t1 ] = P.plume;
	for ( let l = 0; l < tassels; l ++ ) {

		const turn = ( l + rng() ) / tassels * Math.PI * 2;
		const s = 1 - P.head / height * ( 0.3 + 0.5 * rng() );
		leaf( b, height, s, new THREE.Vector3( Math.cos( turn ), 0, Math.sin( turn ) ), t0 + ( t1 - t0 ) * rng(), rng, 0.35, level, true, 1 );

	}
	return b.geometry( `yunpeng ${ k } ${ level === NEAR ? 'near' : 'far' }` );

}

// ------------------------------------------------------------------ the glow

/** A prototype's glowing surface (its near level), split as its instances scale it: the tube's
 * (scaled along by the height and across by the girth) and the leaves' and tassels' (kept at their
 * size): the area each shows from outside, its glow's radiance per unit glow (rgb) and its
 * centroid, with the share of the stalk it hangs from. */
interface Glow { area: number; rgb: number[]; centre: THREE.Vector3; s: number }

/** The glow of a prototype's geometry: the tube's and the limbs' (see `Glow`). A stalk's or the
 * head's triangles show a quarter of their area (a thin round body's mean projection), a leaf's
 * or a tassel's half (a two-sided ribbon's); the radiance the albedo (`white` in the material,
 * without the nodes' faint bands). */
function prototypeGlow( g: THREE.BufferGeometry ): { tube: Glow; limbs: Glow } {

	const P = g.attributes.position.array, sway = g.attributes.leafSway.array, hang = g.attributes[ PLANT_PART ].array, part = g.attributes.yunpengPart.array;
	const index = g.index!.array;
	const sum = (): Glow => ( { area: 0, rgb: [ 0, 0, 0 ], centre: new THREE.Vector3(), s: 0 } );
	const tube = sum(), limbs = sum();
	const a = new THREE.Vector3(), c = new THREE.Vector3(), d = new THREE.Vector3(), m = new THREE.Vector3();
	const albedo = ( v: number, k: number ) => FOOT[ k ] + ( WHITE[ k ] - FOOT[ k ] ) * THREE.MathUtils.smoothstep( sway[ v * 4 + 3 ], 0, 0.25 );
	for ( let i = 0; i < index.length; i += 3 ) {

		const v0 = index[ i ], v1 = index[ i + 1 ], v2 = index[ i + 2 ];
		a.fromArray( P, v0 * 3 );
		c.fromArray( P, v1 * 3 ).sub( a );
		d.fromArray( P, v2 * 3 ).sub( a );
		const leafy = part[ v0 ] === 1;
		const shown = c.cross( d ).length() / 2 * ( leafy ? 0.5 : 0.25 );
		const into = leafy ? limbs : tube;
		m.fromArray( P, v0 * 3 ).add( c.fromArray( P, v1 * 3 ) ).add( d.fromArray( P, v2 * 3 ) ).divideScalar( 3 );
		into.centre.addScaledVector( m, shown );
		into.s += shown * ( hang[ v0 * 2 ] + hang[ v1 * 2 ] + hang[ v2 * 2 ] ) / 3;
		into.area += shown;
		for ( let k = 0; k < 3; k ++ ) into.rgb[ k ] += shown * ( albedo( v0, k ) + albedo( v1, k ) + albedo( v2, k ) ) / 3;

	}
	for ( const glow of [ tube, limbs ] ) {

		glow.centre.divideScalar( Math.max( glow.area, 1e-9 ) );
		glow.s /= Math.max( glow.area, 1e-9 );

	}
	return { tube, limbs };

}

/** A clump's light from its stalks' instances: at the centroid of their glowing surface, the
 * intensity (rgb, the illuminance at 1 m) its glow gives at full night. */
function clumpLight( stalks: PlantInstance[], glows: { tube: Glow; limbs: Glow }[] ): LocalSource {

	const glow = glowLevel();
	const centre = new THREE.Vector3(), intensity = new THREE.Vector3(), at = new THREE.Vector3();
	let area = 0;
	for ( const plant of stalks ) {

		const { tube, limbs } = glows[ plant.prototype ];
		for ( const [ g, scale, onTube ] of [ [ tube, plant.scale * plant.girth, true ], [ limbs, plant.limb * plant.limb, false ] ] as const ) {

			const shown = g.area * scale;
			plantPoint( plant, g.centre.x, g.centre.y, g.centre.z, g.s, onTube, at );
			centre.addScaledVector( at, shown );
			area += shown;
			intensity.x += g.rgb[ 0 ] * scale * glow;
			intensity.y += g.rgb[ 1 ] * scale * glow;
			intensity.z += g.rgb[ 2 ] * scale * glow;

		}

	}
	return { position: centre.divideScalar( Math.max( area, 1e-9 ) ), intensity, range: YUNPENG.reach };

}

// ------------------------------------------------------------------ the clumps' instances

/** A stalk's wind load (Deform.ts mainBend's lambda_0, the load in fair's mean wind, and
 * YUNPENG_WIND.drag), fitted to the stalk's own bend: a hollow tube of its mesh's radius (`stalk`:
 * YUNPENG.radius at 5 m, as the height to the 0.6, thinning to half at the head), bent as an
 * elastica under the drag on it, each part's area falling as the cosine of its tilt, the wind at
 * each height by the log law (Wind.ts `logLaw`). The stalk's drag: the standard's ceiling on a
 * smooth circular cylinder's force coefficient, C_D 1.2 (EN 1991-1-4, as given in
 * A. Padewska-Jurczak, P. Szczepaniak and R. Walentynski, "Experimental and numerical analyses of
 * airflow around two cylinders angled to the direction of wind", Bulletin of the Polish Academy of
 * Sciences: Technical Sciences 71 (1), 2023, Eq. 6), taken below that paper's range of Reynolds
 * numbers, on its width; its wall and stiffness, the giant reed's (Arundo donax, the stalk's
 * model): a wall 0.14 of the diameter (3.3 mm at 24 mm; a thin stalk's share runs a little higher,
 * 1.55 mm at 10.4 mm, F. S. Coppolino, "Prove di caratterizzazione meccanica della canna comune
 * (Arundo Donax) in prospettiva di un uso strutturale sostenibile", master's thesis, University of
 * Bologna, 2020, Tables 1 and 3) and a modulus of 9 GPa, the parenchyma's in longitudinal bending,
 * the rind's in tension about 10 (H.-C. Spatz et al., "Biomechanics of the giant reed Arundo
 * donax", Philosophical Transactions of the Royal Society B 352, 1997, as Coppolino reports
 * them). The leaves and the plume (YUNPENG.leaves, leaf, plume: their own mesh's areas, seen
 * at half a face as a randomly turned ribbon is) take a leaved crown's drag (Deform.ts CROWN_DRAG),
 * which no measurement gives for leaves this sparse: an assumption, though they carry under a fifth
 * of the load. A 5 m stalk's top then leans 0.13, 0.70, 2.2 and 5.2 degrees from the light level to
 * the strong, a 2.2 m one's 0.07, 0.31, 0.86 and 1.9: the stalk is stiff and its drag grows about
 * as U^1.8. YUNPENG.load ( H / 5 )^1.07 with that exponent is the least-squares fit over heights
 * from 2.2 to 5 m and the four levels, within 0.65 degrees of the bend (the strong level's 5 m
 * stalk short by 12 %). The clump's stalks still bend apart: a shorter one less. */
export const stalkLoad = ( height: number ): number => YUNPENG.load * Math.pow( height / 5, 1.07 );

/** A clump's stalks as instances, every draw from one stream seeded by its site; standing on the
 * ground `groundAt` gives. */
function clumpStalks( site: ClumpSite, groundAt: ( x: number, z: number ) => number ): PlantInstance[] {

	const P = YUNPENG, B = P.prototypes;
	const rng = mulberry32( site.seed );
	const count = P.stalks[ site.size ], [ h0, h1 ] = P.height[ site.size ];
	const stalks: PlantInstance[] = [];
	for ( let n = 0; n < count; n ++ ) {

		const a = rng() * Math.PI * 2, r = Math.sqrt( rng() ) * P.foot;
		const x = site.x + Math.cos( a ) * r, z = site.z + Math.sin( a ) * r;
		// out from the clump's middle, turned a little
		const yaw = a + ( rng() - 0.5 ) * 0.8;
		// the clump's middle stalks the tallest
		const height = h0 + ( h1 - h0 ) * ( 1 - 0.6 * r / P.foot ) * ( 0.75 + 0.25 * rng() );
		const k = Math.min( B.count - 1, Math.max( 0, Math.floor( ( height - B.height[ 0 ] ) / ( B.height[ 1 ] - B.height[ 0 ] ) * B.count ) ) );
		const scale = height / prototypeHeight( k );
		const lean = P.lean[ 0 ] + ( P.lean[ 1 ] - P.lean[ 0 ] ) * ( r / P.foot ) + ( rng() - 0.5 ) * 0.03;
		const bow = P.bow * ( height / 5 ) * ( 0.5 + rng() );
		stalks.push( {
			prototype: k, x, y: groundAt( x, z ), z, yaw,
			height, scale, girth: Math.pow( scale, 0.6 ), limb: 1,
			lean, bow, load: stalkLoad( height ),
			width: 2 * P.radius * Math.pow( height / 5, 0.6 ), reach: P.leaf[ 1 ],
			look: [ 0, 0, 0, 0 ],
		} );

	}
	return stalks;

}

// ------------------------------------------------------------------ the page's yunpeng

/** What a growth step prepared: the clumps, their lights and their pool, or null where the clumps
 * did not change. */
export type YunpengPrepared = { sites: ClumpSite[]; lights: LocalSource[]; pool: PlantPool } | null;

// the chunks' order ( cj, ci ), as the island's meshes are ordered (Growth.ts)
const order = ( a: { ci: number; cj: number }, b: { ci: number; cj: number } ) => a.cj - b.cj || a.ci - b.ci;
// the chunk's square (Chunks.ts chunkBox)
const chunkBox = ( ci: number, cj: number ) => ( { x0: ci * SEABED_TILE, z0: cj * SEABED_TILE, x1: ci * SEABED_TILE + SEABED_TILE, z1: cj * SEABED_TILE + SEABED_TILE } );

/** The clumps over `data`'s land: every land chunk planted in the chunks' order (YunpengSites.ts),
 * a row of cells a step. */
export function* plantSteps( data: WorldData ): Generator<void, ClumpSite[]> {

	const land: ClumpLand = { rim: data.rimGround, shore: data.shore };
	const sites: ClumpSite[] = [];
	for ( const { ci, cj } of [ ...data.islands ].sort( order ) ) sites.push( ...yield* plantClumps( land, islandSurfaceHeight, chunkBox( ci, cj ) ) );
	return sites;

}

/** The yunpeng over the land's top: its prototypes' draws under `root`, the plants its clumps'
 * stalks (PlantInstances.ts). */
export class Yunpeng {

	readonly plants: PlantInstances;
	readonly root: THREE.Group;
	private shown: ClumpSite[];
	private shownLights: LocalSource[];
	private readonly glows: { tube: Glow; limbs: Glow }[] = [];

	constructor( sites: ClumpSite[], shared: Shared ) {

		const draws: PlantDraw[] = [];
		for ( let k = 0; k < YUNPENG.prototypes.count; k ++ ) {

			const near = prototypeMesh( k, NEAR );
			this.glows.push( prototypeGlow( near ) );
			draws.push( ...levelDraws( 0, k, near, prototypeMesh( k, FAR ), true ) );

		}
		const { plants, lights } = this.instances( sites );
		this.shown = sites;
		this.shownLights = lights;
		this.plants = new PlantInstances( { name: 'Yunpeng', parts: [ 'yunpeng' ], draws, plants, material: yunpengMaterials( shared ) } );
		this.root = this.plants.roots[ 0 ];

	}

	/** The clumps standing now (for the diagnostics). */
	sites(): ClumpSite[] {

		return this.shown;

	}

	/** The clumps' lights now, one per clump (lighting/LocalLights.ts). */
	lights(): LocalSource[] {

		return this.shownLights;

	}

	/** The lights of stand-in clumps on level ground, a tall one and two lower ones (about the
	 * share the meadow plants: YunpengSites.ts MEADOW_CLUMPS.tall), whatever the land holds: what
	 * the test sources take their light from (LocalLights.ts `testSources`). */
	sampleLights(): LocalSource[] {

		return ( [ 0, 1, 1 ] as const ).map( ( size, k ) => clumpLight( clumpStalks( { x: 0, z: 0, size, seed: k + 1 }, () => 0 ), this.glows ) );

	}

	/** The yunpeng of `data`'s land, in steps (the growth's idle time): planted again, and where the
	 * clumps changed their instance pool filled and uploaded. */
	* prepare( data: WorldData, renderer: THREE.WebGPURenderer | null ): Generator<void, YunpengPrepared> {

		const sites = yield* plantSteps( data );
		if ( sites.length === this.shown.length && sites.every( ( s, k ) => s.x === this.shown[ k ].x && s.z === this.shown[ k ].z && s.size === this.shown[ k ].size && s.seed === this.shown[ k ].seed ) ) return null;
		const { plants, lights } = this.instances( sites );
		return { sites, lights, pool: yield* this.plants.prepare( plants, renderer ) };

	}

	/** Swaps `prepared` in (PlantInstances.ts `swap`): the page moves the lights after it. Returns
	 * what frees the old pool. */
	swap( prepared: YunpengPrepared ): ( () => void ) | null {

		if ( ! prepared ) return null;
		this.shown = prepared.sites;
		this.shownLights = prepared.lights;
		return this.plants.swap( prepared.pool );

	}

	// every clump's stalks, in the clumps' order, and a light per clump
	private instances( sites: ClumpSite[] ): { plants: PlantInstance[]; lights: LocalSource[] } {

		const plants: PlantInstance[] = [], lights: LocalSource[] = [];
		for ( const site of sites ) {

			const stalks = clumpStalks( site, islandSurfaceHeight );
			plants.push( ...stalks );
			lights.push( clumpLight( stalks, this.glows ) );

		}
		return { plants, lights };

	}

}

// ------------------------------------------------------------------ the material

/** The yunpeng's material over a plant draw (PlantInstances.ts): snow white over a greyer foot, a
 * faint node every YUNPENG.internode, a waxy sheen and a faint white light of its own; swaying from
 * each stalk's foot by `leafSway` x, the prototype's eta^2, under the stalk's wind load
 * (`stalkLoad`). */
function material( shared: Shared, plants: PlantInstances ): THREE.MeshStandardNodeMaterial {

	const m = new THREE.MeshStandardNodeMaterial( { roughness: 0.45, metalness: 0, side: THREE.DoubleSide } );
	const v = plants.vertex(), place = placeVertex( v );
	const eta = attribute<'vec4'>( 'leafSway', 'vec4' ).w, part = attribute<'float'>( 'yunpengPart', 'float' );
	let trunk: THREE.Node<'vec2'> | undefined;
	const rest = useVegetationMotion( m, shared.wind, {
		rest: place.position,
		displacement: ( wind ) => {

			const bent = mainBend( wind, place.position, place.root, place.sway.x, place.sway.w, place.load, YUNPENG_WIND );
			if ( wind === shared.wind ) trunk = bent.sway;
			return bent.position.add( leafFlutter( wind, bent.field, place.normal, place.sway.y, place.sway.z, YUNPENG_WIND.flutter, place.position ) );

		},
		sway: () => trunk,
		beforePosition: place.before,
	} );
	// a node's faint band on the stalk: where the height over its foot crosses a multiple of the
	// internode
	const height = rest.y.sub( v.footVarying.y );
	const node = smoothstep( 0.965, 1, height.div( YUNPENG.internode ).fract() ).mul( float( 1 ).sub( part.min( 1 ) ) );
	const white = mix( vec3( ...FOOT ), vec3( ...WHITE ), smoothstep( 0, 0.25, eta ) ).mul( float( 1 ).sub( node.mul( 0.45 ) ) );
	m.colorNode = plantTint( white, rootHash( v.footVarying.xz ), part.equal( 1 ).select( float( 1 ), float( 0 ) ), TINT );
	const glow = glowLevel();
	if ( glow > 0 ) m.emissiveNode = white.mul( yunpengNight.mul( glow ) );
	m.name = 'yunpeng';
	( m as unknown as { setupLightingModel: () => THREE.LightingModel } ).setupLightingModel = () => new GroundBounceLightingModel();
	writeMeter( m );
	receiveScreenAO( m );
	// the whole scene's screen-space shade on the key (post/MeadowShade.ts)
	receiveScreenShadow( m );
	return m;

}

/** Each plant draw's material (PlantInstances.ts `material`): the whole draws one, the fading
 * draws one with the level stipple. */
function yunpengMaterials( shared: Shared ): ( draw: PlantDraw, plants: PlantInstances ) => THREE.Material {

	let whole: THREE.Material | null = null, fading: THREE.Material | null = null;
	return ( draw, plants ) => {

		if ( draw.fade === 0 ) return whole ??= material( shared, plants );
		if ( ! fading ) {

			const m = material( shared, plants );
			plants.useStipple( m );
			fading = m;

		}
		return fading;

	};

}

/** The yunpeng over `data`'s land (`Yunpeng`). */
export function buildYunpeng( data: WorldData, shared: Shared ): Yunpeng {

	return new Yunpeng( runSteps( plantSteps( data ) ), shared );

}

/** The yunpeng as a vegetation kind (vegetation/Registry.ts), following the growth. */
export function yunpengKind( yunpeng: Yunpeng ): VegetationKind<unknown, WorldData> {

	const growth: KindGrowth<YunpengPrepared, WorldData> = {
		prepare: ( input ) => yunpeng.prepare( input.data, input.renderer ),
		swap: ( prepared ) => yunpeng.swap( prepared ),
	};
	return { name: 'yunpeng', root: yunpeng.root, prepass: false, shadowFilter: 'ordinary', sunCaster: true, rainBake: true, growth: growth as KindGrowth<unknown, WorldData> };

}
