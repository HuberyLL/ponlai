import * as THREE from 'three/webgpu';
import {
	Fn, If, attribute, positionGeometry, positionLocal, normalViewGeometry, materialColor, vec3, vec4, float, mix, dot, sin, cos, pow, clamp,
	mx_noise_float,
} from 'three/tsl';
import { mulberry32, type Rng } from './noise.ts';
import { leafTexture, leafAlphaTexture, LEAF_ALPHA_TEST } from './Foliage.ts';
import { VegetationLighting, useLighting } from './VegetationLighting.ts';
import { useRestPoseShadows } from './VegetationShadow.ts';
import type { PlantSite } from './PlantSites.ts';
import type { Shared } from '../shared.ts';

// The island top's shrubs and small trees. Every plant is grown once from its own seed, so no
// two share a silhouette: round shrubs of small or larger leaves, broad-leaved clumps, ferns and
// small trees with a forked trunk under clustered crowns. They use the rim bushes' folded leaf
// (one texture, its coverage-preserving alpha mips) and their light model, and merge into one
// mesh in world space: one draw, one shadow draw. Per vertex: plantMotion ( sway amplitude in
// metres, wind phase, stem flag, bark flag ) and plantShade ( ambient occlusion, direct light ).

const UP = new THREE.Vector3( 0, 1, 0 );
// A texel inside the leaf body: bark and stalks take an opaque, constant colour from the map.
const SOLID_UV: [ number, number ] = [ 0.3, 0.5 ];

type RGB = [ number, number, number ];

// linear albedo before the leaf map; each list is one family of plants
const PALETTES: Record<string, RGB[]> = {
	smallLeaf: [ [ 0.045, 0.12, 0.04 ], [ 0.06, 0.145, 0.045 ], [ 0.075, 0.16, 0.055 ] ],
	largeLeaf: [ [ 0.11, 0.19, 0.05 ], [ 0.15, 0.205, 0.055 ], [ 0.085, 0.17, 0.045 ] ],
	broadleaf: [ [ 0.05, 0.13, 0.04 ], [ 0.07, 0.15, 0.04 ], [ 0.045, 0.12, 0.05 ] ],
	fern: [ [ 0.13, 0.22, 0.045 ], [ 0.16, 0.235, 0.05 ], [ 0.105, 0.2, 0.04 ] ],
	tree: [ [ 0.06, 0.15, 0.045 ], [ 0.09, 0.175, 0.05 ], [ 0.14, 0.19, 0.05 ] ],
};
const BARK: RGB = [ 0.1, 0.088, 0.072 ];
const STALK: RGB = [ 0.09, 0.13, 0.04 ];

interface Look {
	envelope: THREE.Vector3; // outward from the plant's mass, local
	envelopeWeight: number;
	light: number; // 0 deep inside the plant, 1 on its outer shell
	phase: number;
	flutter: number; // extra sway (m) of this part on top of the plant's bend
}

class PlantBuilder {

	readonly P: number[] = []; readonly U: number[] = []; readonly C: number[] = [];
	readonly M: number[] = []; readonly S: number[] = []; readonly I: number[] = [];
	readonly intended: number[] = []; readonly envelope: number[] = []; readonly envelopeWeight: number[] = [];
	// the plant being grown: its frame on the ground, its sky visibility and how it bends
	readonly frame = new THREE.Matrix4();
	readonly turn = new THREE.Matrix3();
	visibility = 1;
	bend: ( local: THREE.Vector3 ) => number = () => 0;
	private readonly w = new THREE.Vector3(); private readonly n = new THREE.Vector3(); private readonly e = new THREE.Vector3();

	place( site: PlantSite, yaw: number, tilt: THREE.Vector3 ): void {

		const q = new THREE.Quaternion().setFromUnitVectors( UP, tilt ).multiply( new THREE.Quaternion().setFromAxisAngle( UP, yaw ) );
		this.frame.compose( new THREE.Vector3( site.x, site.y - 0.03, site.z ), q, new THREE.Vector3( 1, 1, 1 ) );
		this.turn.setFromMatrix4( this.frame );
		this.visibility = site.visibility;

	}

	vertex( p: THREE.Vector3, u: number, v: number, color: RGB, shade: number, normal: THREE.Vector3, look: Look, stem: boolean, bark: boolean, flutter = 0 ): number {

		const index = this.P.length / 3;
		this.w.copy( p ).applyMatrix4( this.frame );
		this.P.push( this.w.x, this.w.y, this.w.z );
		this.U.push( u, v );
		this.C.push( color[ 0 ] * shade, color[ 1 ] * shade, color[ 2 ] * shade );
		this.M.push( this.bend( p ) + flutter * look.flutter, look.phase, stem ? 1 : 0, bark ? 1 : 0 );
		const light = THREE.MathUtils.clamp( look.light, 0, 1 );
		this.S.push( THREE.MathUtils.lerp( 0.32, 1, light ) * this.visibility, THREE.MathUtils.lerp( 0.7, 1, light ) );
		this.n.copy( normal ).applyMatrix3( this.turn ).normalize();
		this.e.copy( look.envelope ).applyMatrix3( this.turn ).normalize();
		this.intended.push( this.n.x, this.n.y, this.n.z );
		this.envelope.push( this.e.x, this.e.y, this.e.z );
		this.envelopeWeight.push( bark ? 0 : look.envelopeWeight );
		return index;

	}

	// A thin flat stalk from a to b (twigs, leaf stalks, fern stems): under a shadow texel
	// across, so it stays out of the sun's map.
	stalk( a: THREE.Vector3, b: THREE.Vector3, w0: number, w1: number, color: RGB, shade: number, look: Look, bark = false ): void {

		const dir = new THREE.Vector3().subVectors( b, a ).normalize();
		const side = new THREE.Vector3().crossVectors( UP, dir );
		if ( side.lengthSq() < 1e-4 ) side.set( 1, 0, 0 );
		side.normalize();
		const n = new THREE.Vector3().crossVectors( dir, side ).normalize();
		if ( n.y < 0 ) n.negate();
		const v = new THREE.Vector3();
		const i = this.vertex( v.copy( a ).addScaledVector( side, - w0 ), ...SOLID_UV, color, shade * 0.75, n, look, true, bark );
		this.vertex( v.copy( a ).addScaledVector( side, w0 ), ...SOLID_UV, color, shade * 0.75, n, look, true, bark );
		this.vertex( v.copy( b ).addScaledVector( side, w1 ), ...SOLID_UV, color, shade, n, look, true, bark, 1 );
		this.vertex( v.copy( b ).addScaledVector( side, - w1 ), ...SOLID_UV, color, shade, n, look, true, bark, 1 );
		this.I.push( i, i + 1, i + 2, i, i + 2, i + 3 );

	}

	// A folded leaf with a raised midrib, as on the rim bushes: base, two flanks, the fold, tip.
	leaf( p: THREE.Vector3, along: THREE.Vector3, n: THREE.Vector3, L: number, W: number, fold: number, color: RGB, shade: number, look: Look ): void {

		const width = new THREE.Vector3().crossVectors( n, along ).normalize();
		const v = new THREE.Vector3();
		const i = this.vertex( p, 0.5, 0, color, shade * 0.82, n, look, false, false, 0.3 );
		this.vertex( v.copy( p ).addScaledVector( along, L * 0.48 ).addScaledVector( width, - W * 0.5 ), 0, 0.5, color, shade, n, look, false, false, 0.7 );
		this.vertex( v.copy( p ).addScaledVector( along, L * 0.51 ).addScaledVector( n, fold ), 0.5, 0.5, color, shade * 1.03, n, look, false, false, 0.7 );
		this.vertex( v.copy( p ).addScaledVector( along, L * 0.48 ).addScaledVector( width, W * 0.5 ), 1, 0.5, color, shade, n, look, false, false, 0.7 );
		this.vertex( v.copy( p ).addScaledVector( along, L ).addScaledVector( n, fold * 0.32 ), 0.5, 1, color, shade * 1.04, n, look, false, false, 1 );
		this.I.push( i, i + 1, i + 2, i + 1, i + 4, i + 2, i, i + 2, i + 3, i + 2, i + 4, i + 3 );

	}

	// A large leaf blade that arches and droops along its length: rows of edge, midrib, edge.
	blade( p: THREE.Vector3, along: THREE.Vector3, n: THREE.Vector3, L: number, W: number, fold: number, droop: number, color: RGB, shade: number, look: Look, rows = 4 ): void {

		const width = new THREE.Vector3().crossVectors( n, along ).normalize();
		const c = new THREE.Vector3(), v = new THREE.Vector3(), rowN = new THREE.Vector3();
		const first = this.P.length / 3;
		for ( let r = 0; r <= rows; r ++ ) {

			const t = r / rows;
			// the blade bends down toward its tip
			c.copy( p ).addScaledVector( along, L * t ).addScaledVector( UP, - droop * t * t );
			rowN.copy( n ).addScaledVector( along, droop * 2 * t / L ).normalize();
			const s = shade * ( 0.84 + 0.2 * t );
			this.vertex( v.copy( c ).addScaledVector( width, - W * 0.5 ).addScaledVector( rowN, - fold * 0.4 ), 0, t, color, s, rowN, look, false, false, t );
			this.vertex( v.copy( c ).addScaledVector( rowN, fold ), 0.5, t, color, s * 1.04, rowN, look, false, false, t );
			this.vertex( v.copy( c ).addScaledVector( width, W * 0.5 ).addScaledVector( rowN, - fold * 0.4 ), 1, t, color, s, rowN, look, false, false, t );

		}
		for ( let r = 0; r < rows; r ++ ) {

			const a = first + r * 3, b = a + 3;
			this.I.push( a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2 );

		}

	}

	// A round, tapering limb along `points`. A limb that leaves its parent thinner than a shadow
	// texel stays out of the sun's map, like the stalks. The flag is one per limb, not per ring: a
	// triangle with masked and unmasked corners would stretch to the origin in the shadow pass
	// (masked corners collapse there) and cast a long straight streak across the meadow.
	tube( points: THREE.Vector3[], radii: number[], sides: number, color: RGB, look: Look ): void {

		const first = this.P.length / 3;
		const stem = Math.max( ...radii ) < 0.03;
		const t = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), dir = new THREE.Vector3(), v = new THREE.Vector3();
		for ( let k = 0; k < points.length; k ++ ) {

			t.subVectors( points[ Math.min( k + 1, points.length - 1 ) ], points[ Math.max( k - 1, 0 ) ] ).normalize();
			a.set( 1, 0, 0 );
			if ( Math.abs( t.x ) > 0.9 ) a.set( 0, 0, 1 );
			a.addScaledVector( t, - a.dot( t ) ).normalize();
			b.crossVectors( t, a );
			const shade = 0.75 + 0.25 * Math.min( 1, points[ k ].y / 1.5 );
			for ( let s = 0; s <= sides; s ++ ) {

				const angle = s / sides * Math.PI * 2;
				dir.copy( a ).multiplyScalar( Math.cos( angle ) ).addScaledVector( b, Math.sin( angle ) );
				this.vertex( v.copy( points[ k ] ).addScaledVector( dir, radii[ k ] ), ...SOLID_UV, color, shade, dir, look, stem, true );

			}

		}
		for ( let k = 0; k + 1 < points.length; k ++ ) for ( let s = 0; s < sides; s ++ ) {

			const i = first + k * ( sides + 1 ) + s, j = i + sides + 1;
			this.I.push( i, j, i + 1, i + 1, j, j + 1 );

		}

	}

	geometry(): THREE.BufferGeometry {

		const g = new THREE.BufferGeometry();
		g.setAttribute( 'position', new THREE.Float32BufferAttribute( this.P, 3 ) );
		g.setAttribute( 'uv', new THREE.Float32BufferAttribute( this.U, 2 ) );
		g.setAttribute( 'color', new THREE.Float32BufferAttribute( this.C, 3 ) );
		g.setAttribute( 'plantMotion', new THREE.Float32BufferAttribute( this.M, 4 ) );
		g.setAttribute( 'plantShade', new THREE.Float32BufferAttribute( this.S, 2 ) );
		g.setIndex( this.I );
		g.computeVertexNormals();
		// Each leaf keeps its fold's lighting, turned to the side it was grown to face (a
		// double-sided leaf's winding is arbitrary) and eased toward the plant's rounded mass.
		const normals = g.getAttribute( 'normal' );
		const n = new THREE.Vector3(), want = new THREE.Vector3(), env = new THREE.Vector3();
		for ( let i = 0; i < normals.count; i ++ ) {

			n.fromBufferAttribute( normals, i );
			want.fromArray( this.intended, i * 3 );
			if ( n.lengthSq() < 1e-8 ) n.copy( want );
			if ( n.dot( want ) < 0 ) n.negate();
			const w = this.envelopeWeight[ i ];
			n.normalize().multiplyScalar( 1 - w ).add( env.fromArray( this.envelope, i * 3 ).multiplyScalar( w ) ).normalize();
			normals.setXYZ( i, n.x, n.y, n.z );

		}
		g.computeBoundingSphere();
		g.computeBoundingBox();
		return g;

	}

}

const pick = <T>( rng: Rng, list: T[] ): T => list[ Math.floor( rng() * list.length ) ];
const tint = ( rng: Rng, c: RGB, spread = 0.3 ): RGB => {

	const k = 1 - spread / 2 + rng() * spread;
	return [ c[ 0 ] * k, c[ 1 ] * k, c[ 2 ] * k ];

};
const randomUnit = ( rng: Rng, out = new THREE.Vector3() ) => {

	const z = rng() * 2 - 1, a = rng() * Math.PI * 2, r = Math.sqrt( 1 - z * z );
	return out.set( r * Math.cos( a ), z, r * Math.sin( a ) );

};

// Branching sprays of opposite leaf pairs around a centre, as on the rim bushes; `outward`
// biases them away from the plant's middle so the mass reads round.
function leafCluster( b: PlantBuilder, rng: Rng, centre: THREE.Vector3, radius: number, sprays: number, middle: THREE.Vector3,
	extent: number, leafSize: [ number, number ], color: RGB, height: number, lift = 0.45 ): void {

	const dir = new THREE.Vector3(), across = new THREE.Vector3(), start = new THREE.Vector3(), end = new THREE.Vector3();
	const p = new THREE.Vector3(), n = new THREE.Vector3(), along = new THREE.Vector3(), out = new THREE.Vector3(), j = new THREE.Vector3();
	const twig: RGB = [ 0.42, 0.31, 0.17 ];
	for ( let s = 0; s < sprays; s ++ ) {

		out.subVectors( centre, middle ).setY( 0 );
		if ( out.lengthSq() > 1e-6 ) out.normalize();
		dir.copy( randomUnit( rng, j ) ).addScaledVector( out, 0.7 ).addScaledVector( UP, lift ).normalize();
		across.crossVectors( UP, dir );
		if ( across.lengthSq() < 1e-4 ) across.set( 1, 0, 0 );
		across.normalize();
		const length = radius * ( 0.6 + rng() * 0.45 );
		start.copy( centre ).add( randomUnit( rng, j ).multiplyScalar( radius * 0.25 ) );
		end.copy( start ).addScaledVector( dir, length );
		const phase = rng() * Math.PI * 2;
		const look = ( q: THREE.Vector3 ): Look => ( {
			envelope: new THREE.Vector3().subVectors( q, middle ).normalize(), envelopeWeight: 0.24,
			light: 0.25 + 0.75 * Math.min( 1, q.distanceTo( middle ) / extent ), phase, flutter: 0.006,
		} );
		b.stalk( start, end, 0.005, 0.0018, twig, 0.5, look( start ) );
		const pairs = Math.max( 3, Math.min( 7, Math.round( length / 0.075 ) ) );
		for ( let k = 0; k < pairs; k ++ ) for ( const side of [ - 1, 1 ] ) {

			const t = 0.12 + k / pairs * 0.86 + ( rng() - 0.5 ) * 0.06;
			p.copy( start ).addScaledVector( dir, length * t ).addScaledVector( across, side * 0.008 );
			n.copy( dir ).multiplyScalar( 0.38 ).addScaledVector( UP, 0.65 );
			n.add( j.set( ( rng() - 0.5 ) * 0.7, ( rng() - 0.5 ) * 0.35, ( rng() - 0.5 ) * 0.7 ) ).normalize();
			along.copy( across ).multiplyScalar( side ).addScaledVector( dir, 0.3 + rng() * 0.25 );
			along.addScaledVector( n, - along.dot( n ) ).normalize();
			const L = ( leafSize[ 0 ] + rng() * ( leafSize[ 1 ] - leafSize[ 0 ] ) ) * ( k === pairs - 1 ? 0.8 : 1 );
			const W = L * ( 0.48 + rng() * 0.18 );
			const shade = 0.62 + 0.28 * Math.min( 1, p.y / height ) + rng() * 0.16;
			b.leaf( p, along, n, L, W, L * ( 0.08 + rng() * 0.07 ), color, shade, look( p ) );

		}

	}

}

// A rounded shrub of several offset crowns on woody stems, knee to head high. Two leaf
// families: dense small leaves, or looser larger ones in fresher greens.
function roundShrub( b: PlantBuilder, rng: Rng, H: number ): void {

	const small = rng() < 0.55;
	const color = tint( rng, pick( rng, small ? PALETTES.smallLeaf : PALETTES.largeLeaf ) );
	const leafSize: [ number, number ] = small ? [ 0.095, 0.145 ] : [ 0.15, 0.22 ];
	const middle = new THREE.Vector3( 0, H * 0.42, 0 );
	b.bend = ( q ) => 0.022 * Math.min( 1, Math.max( 0, q.y ) / Math.max( 0.72, H * 0.8 ) );
	const crowns = 4 + Math.round( H * 3 );
	const stemLook: Look = { envelope: UP, envelopeWeight: 0, light: 0.2, phase: rng() * 6.28, flutter: 0 };
	for ( let c = 0; c < crowns; c ++ ) {

		const top = c === crowns - 1;
		const cr = H * ( 0.26 + rng() * 0.1 );
		const a = c / crowns * Math.PI * 2 + ( rng() - 0.5 ) * 0.9;
		const ring = top ? H * 0.05 : H * ( 0.16 + rng() * 0.16 );
		// the lower crowns sit down on the ground, so no bare stems show under the mass
		const centre = new THREE.Vector3( Math.cos( a ) * ring, top ? H - cr * 1.05 : Math.max( cr * 0.75, H * ( 0.24 + rng() * 0.26 ) ), Math.sin( a ) * ring );
		b.tube( [ new THREE.Vector3( 0, - 0.02, 0 ), centre.clone().multiplyScalar( 0.5 ).setY( centre.y * 0.45 ), centre ], [ 0.022, 0.015, 0.008 ], 4, BARK, stemLook );
		// sprays spread level as much as up: a shrub is leafy down to its skirt
		leafCluster( b, rng, centre, cr, Math.round( ( small ? 16 : 10 ) + cr * ( small ? 30 : 18 ) ), middle, H * 0.6, leafSize, color, H, 0.12 );

	}

}

// A clump of large, broad leaves on long stalks from one crown: the old leaves spread low and
// wide, the young ones stand up in the middle.
function broadleafClump( b: PlantBuilder, rng: Rng, H: number ): void {

	const color = tint( rng, pick( rng, PALETTES.broadleaf ) );
	b.bend = ( q ) => 0.018 * Math.min( 1, Math.max( 0, q.y ) / H );
	const count = 11 + Math.floor( rng() * 6 );
	// successive leaves turn by the golden angle, as in a rosette (H. Vogel's phyllotaxis, 1979)
	const golden = Math.PI * ( 3 - Math.sqrt( 5 ) );
	const offset = rng() * Math.PI * 2;
	const dirH = new THREE.Vector3(), base = new THREE.Vector3(), tip = new THREE.Vector3(), mid = new THREE.Vector3();
	const along = new THREE.Vector3(), n = new THREE.Vector3(), width = new THREE.Vector3();
	for ( let i = 0; i < count; i ++ ) {

		const young = i / count; // later leaves are younger: smaller, more upright, inside
		const a = offset + i * golden + ( rng() - 0.5 ) * 0.4;
		dirH.set( Math.cos( a ), 0, Math.sin( a ) );
		const rise = THREE.MathUtils.degToRad( 38 + 30 * young + rng() * 14 );
		const stalkLength = H * ( 0.35 + rng() * 0.25 ) * ( 1 - 0.3 * young );
		base.copy( dirH ).multiplyScalar( 0.03 );
		tip.copy( base ).addScaledVector( dirH, Math.cos( rise ) * stalkLength ).addScaledVector( UP, Math.sin( rise ) * stalkLength );
		mid.lerpVectors( base, tip, 0.5 ).addScaledVector( UP, stalkLength * 0.06 );
		const look: Look = { envelope: dirH.clone().addScaledVector( UP, 0.8 ).normalize(), envelopeWeight: 0.15,
			light: 0.45 + 0.55 * ( 1 - young * 0.4 ), phase: rng() * Math.PI * 2, flutter: 0.012 };
		b.stalk( base, mid, 0.008, 0.006, STALK, 0.6, look );
		b.stalk( mid, tip, 0.006, 0.004, STALK, 0.7, look );
		const L = THREE.MathUtils.clamp( H * ( 0.5 + rng() * 0.3 ) * ( 1 - 0.35 * young ), 0.16, 0.42 );
		const lift = THREE.MathUtils.degToRad( 8 + 30 * young + rng() * 12 );
		along.copy( dirH ).multiplyScalar( Math.cos( lift ) ).addScaledVector( UP, Math.sin( lift ) ).normalize();
		width.crossVectors( UP, dirH ).normalize();
		n.crossVectors( along, width ).normalize();
		if ( n.y < 0 ) n.negate();
		b.blade( tip, along, n, L, L * ( 0.62 + rng() * 0.12 ), L * 0.05, L * ( 0.18 + rng() * 0.22 ) * ( 1 - young * 0.6 ),
			color, 0.72 + rng() * 0.2, look );

	}

}

// A fern: pinnate fronds rising from one crown and arching out, leaflets shortening toward
// the base and the tip; a few young fronds still stand upright.
function fern( b: PlantBuilder, rng: Rng, H: number ): void {

	const color = tint( rng, pick( rng, PALETTES.fern ) );
	b.bend = ( q ) => 0.01 * Math.min( 1, Math.max( 0, q.y ) / H );
	const fronds = 9 + Math.floor( rng() * 6 );
	const golden = Math.PI * ( 3 - Math.sqrt( 5 ) );
	const offset = rng() * Math.PI * 2;
	const dirH = new THREE.Vector3(), p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), p2 = new THREE.Vector3();
	const c = new THREE.Vector3(), tan = new THREE.Vector3(), side = new THREE.Vector3(), nf = new THREE.Vector3();
	const along = new THREE.Vector3(), n = new THREE.Vector3(), prev = new THREE.Vector3();
	const at = ( t: number, out: THREE.Vector3 ) => out.set( 0, 0, 0 ).addScaledVector( p0, ( 1 - t ) * ( 1 - t ) ).addScaledVector( p1, 2 * t * ( 1 - t ) ).addScaledVector( p2, t * t );
	for ( let f = 0; f < fronds; f ++ ) {

		const young = rng() < 0.18;
		const a = offset + f * golden + ( rng() - 0.5 ) * 0.5;
		dirH.set( Math.cos( a ), 0, Math.sin( a ) );
		const reach = H * ( young ? 0.35 : 0.85 + rng() * 0.35 );
		p0.copy( dirH ).multiplyScalar( 0.025 );
		p1.copy( p0 ).addScaledVector( UP, H * ( young ? 1.1 : 1.3 + rng() * 0.2 ) ).addScaledVector( dirH, reach * 0.3 );
		p2.copy( p0 ).addScaledVector( dirH, reach ).addScaledVector( UP, H * ( young ? 0.95 : 0.35 + rng() * 0.3 ) );
		const look: Look = { envelope: dirH.clone().addScaledVector( UP, 0.6 ).normalize(), envelopeWeight: 0.12, light: 0.85, phase: rng() * Math.PI * 2, flutter: 0.016 };
		const segments = 6;
		prev.copy( p0 );
		for ( let s = 1; s <= segments; s ++ ) {

			at( s / segments, c );
			look.light = 0.45 + 0.55 * s / segments;
			b.stalk( prev, c, 0.006 * ( 1 - ( s - 1 ) / segments ) + 0.002, 0.006 * ( 1 - s / segments ) + 0.0015, STALK, 0.7, look );
			prev.copy( c );

		}
		const pairs = 12 + Math.floor( rng() * 5 );
		const size = H * ( young ? 0.1 : 0.17 + rng() * 0.05 );
		for ( let k = 0; k < pairs; k ++ ) {

			const t = 0.14 + 0.85 * k / pairs;
			at( t, c );
			at( Math.min( 1, t + 0.01 ), tan ).sub( c ).normalize();
			side.crossVectors( tan, UP );
			if ( side.lengthSq() < 1e-4 ) side.crossVectors( tan, dirH );
			side.normalize();
			nf.crossVectors( side, tan ).normalize();
			if ( nf.y < 0 ) nf.negate();
			const L = size * Math.pow( Math.sin( Math.PI * Math.min( 1, t * 1.02 ) ), 0.6 ) * ( 1 - 0.3 * t ) + 0.02;
			look.light = 0.5 + 0.5 * t;
			const shade = 0.7 + 0.25 * t + rng() * 0.1;
			for ( const s of [ - 1, 1 ] ) {

				along.copy( side ).multiplyScalar( s ).addScaledVector( tan, 0.5 ).addScaledVector( nf, - 0.15 ).normalize();
				n.copy( nf ).addScaledVector( side, s * 0.25 ).normalize();
				b.leaf( c, along, n, L, L * 0.34, L * 0.06, color, shade, look );

			}

		}

	}

}

// A small tree 2.5 - 3.5 m tall: a leaning, flared trunk forks into four or five limbs that
// spread and turn up, each with a side branch or two. Leaf clusters sit at the branch ends and
// along the limbs, filling a rounded crown that still shows gaps and a few clouds of leaves, as
// young broadleaf trees do.
function smallTree( b: PlantBuilder, rng: Rng, H: number ): void {

	const color = tint( rng, pick( rng, PALETTES.tree ), 0.2 );
	b.bend = ( q ) => 0.035 * Math.pow( Math.min( 1, Math.max( 0, q.y ) / H ), 2 );
	const barkLook: Look = { envelope: UP, envelopeWeight: 0, light: 0.6, phase: rng() * 6.28, flutter: 0 };
	const leanA = rng() * Math.PI * 2, lean = 0.05 + rng() * 0.08;
	const leanDir = new THREE.Vector3( Math.cos( leanA ), 0, Math.sin( leanA ) );
	const bendDir = new THREE.Vector3( - leanDir.z, 0, leanDir.x ).multiplyScalar( rng() < 0.5 ? - 1 : 1 );
	const fork = H * ( 0.36 + rng() * 0.08 );
	const R0 = 0.07 + H * 0.011;
	const trunk: THREE.Vector3[] = [], radii: number[] = [];
	const rings = 9;
	for ( let k = 0; k <= rings; k ++ ) {

		const s = k / rings;
		trunk.push( new THREE.Vector3().addScaledVector( leanDir, lean * fork * s * s ).addScaledVector( bendDir, 0.05 * Math.sin( Math.PI * s ) ).setY( fork * s - 0.05 ) );
		radii.push( R0 * ( 1 - 0.3 * s ) * ( 1 + 0.55 * Math.pow( Math.max( 0, 1 - s / 0.14 ), 2 ) ) );

	}
	b.tube( trunk, radii, 8, BARK, barkLook );
	const top = trunk[ rings ];
	const scale = H / 3;
	// the crown's rounded mass, for the leaves' light and the limbs' reach
	const crown = new THREE.Vector3( top.x, H * 0.66, top.z );
	const crownR = H * 0.36;
	const clusters: { centre: THREE.Vector3; radius: number }[] = [];
	// A limb that leaves `from` along `dir` and turns up toward its end.
	const limb = ( from: THREE.Vector3, dir: THREE.Vector3, length: number, r0: number, r1: number, rise: number ) => {

		const points: THREE.Vector3[] = [], rs: number[] = [];
		const wobble = randomUnit( rng ).multiplyScalar( length * 0.06 );
		for ( let k = 0; k <= 5; k ++ ) {

			const s = k / 5;
			points.push( from.clone().addScaledVector( dir, length * s ).addScaledVector( UP, length * rise * s * s )
				.addScaledVector( wobble, Math.sin( Math.PI * s ) ) );
			rs.push( THREE.MathUtils.lerp( r0, r1, Math.pow( s, 0.8 ) ) );

		}
		b.tube( points, rs, r0 > 0.03 ? 6 : 4, BARK, barkLook );
		return points;

	};
	const limbs = 4 + ( rng() < 0.45 ? 1 : 0 );
	const a0 = rng() * Math.PI * 2;
	for ( let l = 0; l < limbs; l ++ ) {

		const a = a0 + l / limbs * Math.PI * 2 + ( rng() - 0.5 ) * 0.8;
		const rise = THREE.MathUtils.degToRad( 24 + rng() * 26 );
		const dir = new THREE.Vector3( Math.cos( a ) * Math.cos( rise ), Math.sin( rise ), Math.sin( a ) * Math.cos( rise ) );
		// limbs leave the trunk at staggered heights just below the fork
		const from = top.clone().addScaledVector( UP, - rng() * 0.18 * scale );
		const length = H * ( 0.3 + rng() * 0.14 );
		const points = limb( from, dir, length, R0 * 0.55, 0.018, 0.35 + rng() * 0.25 );
		const end = points[ points.length - 1 ];
		clusters.push( { centre: end.clone().addScaledVector( UP, 0.1 * scale ), radius: ( 0.5 + rng() * 0.2 ) * scale } );
		clusters.push( { centre: points[ 3 ].clone().addScaledVector( UP, 0.18 * scale ), radius: ( 0.38 + rng() * 0.12 ) * scale } );
		const sides = 1 + ( rng() < 0.5 ? 1 : 0 );
		for ( let k = 0; k < sides; k ++ ) {

			// a side branch from the limb's middle, turned off to one side
			const at = points[ 2 + k ];
			const side = new THREE.Vector3( - dir.z, 0.3, dir.x ).multiplyScalar( ( k + l ) % 2 ? - 1 : 1 ).add( dir ).normalize();
			const twig = limb( at, side, H * ( 0.13 + rng() * 0.08 ), 0.026, 0.012, 0.4 );
			clusters.push( { centre: twig[ twig.length - 1 ].clone().addScaledVector( UP, 0.06 ), radius: ( 0.36 + rng() * 0.14 ) * scale } );

		}

	}
	// the leader carries the crown's top
	const leader = limb( top, new THREE.Vector3( lean, 1, 0 ).normalize(), H - fork - 0.65 * scale, R0 * 0.5, 0.018, 0 );
	clusters.push( { centre: leader[ leader.length - 1 ].clone(), radius: 0.6 * scale } );
	clusters.push( { centre: leader[ 3 ].clone(), radius: 0.45 * scale } );
	const extent = Math.max( ...clusters.map( ( c ) => c.centre.distanceTo( crown ) + c.radius ), crownR );
	for ( const c of clusters ) {

		// pull outlying clusters a little toward the crown so it reads as one rounded mass
		const pull = Math.max( 0, c.centre.distanceTo( crown ) - crownR ) * 0.3;
		c.centre.addScaledVector( new THREE.Vector3().subVectors( crown, c.centre ).normalize(), pull );
		leafCluster( b, rng, c.centre, c.radius, Math.round( 12 + c.radius * 28 ), crown, extent, [ 0.13, 0.2 ], tint( rng, color, 0.14 ), H );

	}

}

const GROW: Record<PlantSite[ 'kind' ], ( b: PlantBuilder, rng: Rng, H: number ) => void> = {
	round: roundShrub, broadleaf: broadleafClump, fern, tree: smallTree,
};

function plantMaterial( shared: Shared ): THREE.MeshStandardNodeMaterial {

	const map = leafTexture();
	const mat = new THREE.MeshStandardNodeMaterial( {
		map, alphaTest: LEAF_ALPHA_TEST, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.82, metalness: 0, vertexColors: true,
	} );
	mat.alphaMap = leafAlphaTexture( map.image.width );
	const motion = attribute<'vec4'>( 'plantMotion', 'vec4' );
	const shade = attribute<'vec2'>( 'plantShade', 'vec2' );
	const bark = motion.w;
	const wetness = clamp( shared.wetness, 0, 1 );
	// Bark: grey-brown furrows along the stem, from the rest pose so they do not swim in the wind.
	// Leaves skip the noise: only bark fragments take the branch.
	const furrows = Fn( () => {

		const f = float( 1 ).toVar();
		If( bark.greaterThan( 0.5 ), () => {

			const g = positionGeometry;
			const ridge = mx_noise_float( vec3( g.x.mul( 16 ), g.y.mul( 1.8 ), g.z.mul( 16 ) ) ).mul( 0.5 ).add( 0.5 );
			const lichen = mx_noise_float( g.mul( 3.1 ) ).mul( 0.5 ).add( 0.5 );
			f.assign( mix( float( 0.62 ), float( 1.18 ), ridge ).mul( mix( float( 0.95 ), float( 1.25 ), lichen.mul( lichen ) ) ) );

		} );
		return f;

	} )();
	// Wet bark darkens far more than a leaf, whose waxy surface sheds the water.
	const wetTint = mix( float( 1 ), mix( float( 0.92 ), float( 0.62 ), bark ), wetness ).mul( furrows );
	// materialColor retains the leaf map and its alpha; the vertex colours multiply in after.
	mat.colorNode = materialColor.mul( vec4( wetTint, wetTint, wetTint, 1 ) );
	mat.roughnessNode = mix( mix( float( 0.82 ), float( 0.9 ), bark ), float( 0.68 ), wetness );
	// The same travelling sway as the rim bushes (Foliage.ts), at the same rates of the shared
	// phase; each spray, frond or leaf keeps its own phase, the trunk bends as a whole.
	const p = positionLocal; // the mesh sits at the origin: world space
	const wind = shared.wind.direction;
	const ph = dot( p.xz, wind ).mul( 0.45 ).sub( shared.wind.phase.mul( 1.3 / 1.6 ) ).add( motion.y );
	const along = vec3( wind.x, 0, wind.y ).mul( sin( ph ) );
	const across = vec3( wind.y.negate(), 0, wind.x ).mul( cos( ph.mul( 1.3 ) ).mul( 0.35 ) );
	useRestPoseShadows( mat, p, p.add( along.add( across ).mul( motion.x.mul( shared.wind.strength ) ) ), float( 1 ).sub( motion.z ) );
	mat.normalNode = normalViewGeometry;
	mat.aoNode = shade.x;
	useLighting( mat, () => new VegetationLighting( shade.y, ( L, V, N ) => {

		// leaves: wrapped light and a glow against the sun; bark is opaque
		const back = pow( clamp( dot( V.negate(), L ), 0, 1 ), 4 );
		const rim = float( 1 ).sub( clamp( dot( N, V ), 0, 1 ) );
		const wrap = clamp( dot( N, L ).mul( 0.5 ).add( 0.5 ), 0, 1 );
		return wrap.mul( wrap ).mul( 0.13 ).add( back.mul( rim.mul( rim ).mul( 0.9 ).add( 0.1 ) ) ).mul( float( 1 ).sub( bark ) );

	} ) );
	mat.name = 'plants';
	return mat;

}

/** Grow every site into one mesh (world space). */
export function buildPlants( sites: PlantSite[], shared: Shared ): THREE.Mesh {

	const b = new PlantBuilder();
	const tilt = new THREE.Vector3();
	for ( const site of sites ) {

		const rng = mulberry32( site.seed );
		// shrubs follow the ground a little; trees grow toward the light
		tilt.set( site.nx, site.ny, site.nz ).lerp( UP, site.kind === 'tree' ? 1 : 0.5 ).normalize();
		b.place( site, rng() * Math.PI * 2, tilt );
		GROW[ site.kind ]( b, rng, site.height );

	}
	const mesh = new THREE.Mesh( b.geometry(), plantMaterial( shared ) );
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	mesh.name = 'plants';
	mesh.renderOrder = - 1; // before the terrain: the turf it covers then fails the depth test
	mesh.userData.sites = sites;
	return mesh;

}
