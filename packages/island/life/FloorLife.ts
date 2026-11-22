import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { type Shared, type WaveMaps, type OceanFFT, showUnderwater } from '../../render/index.ts';
import { hash3i, mulberry32, smoothstep, type Rng } from '../../render/data.ts';
import type { Rock, WorldData } from '../world/types.ts';
import { makeRockSDF, rockExtent } from '../world/Stones.ts';
import { SeaHabitat } from './SeaHabitat.ts';
import * as G from './FloorGeometry.ts';
import * as FS from './FloorSpecies.ts';
import { makeFloorMaterial, eelgrassPaint, kelpPaint, coralPaint, softCoralPaint, seaFanPaint, urchinPaint, type FloorPainter, type FloorSwell } from './FloorMaterial.ts';

// The sea floor's fixed life.
//
// The sea floor's fixed life: the eelgrass meadows, and the reef on the stones of a warm-temperate
// rocky coast (kelp, stony and soft corals, sea fans, long-spined urchins), each at its real size,
// on the substrate and at the depths it grows on (FloorSpecies.ts, FloorGeometry.ts):
//   - eelgrass (Zostera marina) wherever the floor's seagrass cover is (Bathymetry.ts seabedBeds,
//     which the floor's material tints), a shoot per cell of a 0.3 m grid with the cover's chance,
//     its leaves longer in deeper water (from about 0.5 m at 3.5 m to 1 m at 8 m)
//   - on the stones, sessile life needs a hard surface: points on each stone's surface (its own
//     SDF, Stones.ts) facing up or out, their number with the stone's area, each given the kind its
//     depth and slope suit, kept apart by the kinds' sizes. Kelp (Ecklonia cava) on the shallow
//     tops, where the light is strongest; table and branching Acropora on tops and upper faces to
//     about 9 m; massive Porites lower; soft corals (Dendronephthya) and sea fans on the steeper faces
//     and deeper, the fans turned across the swell (a gorgonian grows broadside to the water's
//     motion, to filter it); long-spined urchins at the stones' feet, a few together.
// Everything is a function of the land (the habitat's fields, the stones) and fixed seeds: a Grow
// (`setWorld`) lays it out again as a fresh load does. Nothing integrates: the sway is a function
// of the scene clock (FloorMaterial.ts), so the test mode needs nothing of it
// (docs/reference/test-mode.md).
//
// Drawn as one instanced mesh per kind, its buffers of a fixed capacity for the page's life (a Grow
// changes the count drawn), in the world's group, so the refraction's camera draws it under its
// clipping (Refraction.ts showUnderwater), the refracted sun's map shades it (RefractedSun.ts
// bindTerrain) and the opaque prepass takes it (OpaquePrepass.ts). It casts no shadow and is never
// culled (one mesh spans the island's waters).

type Range = readonly [ number, number ];

interface Site { x: number; y: number; z: number; scale: number; up: THREE.Vector3; yaw: number; seed: number; morph: number }

interface FloorKind {
	name: string;
	palette: FS.FloorPalette; paint: FloorPainter; geometry: () => THREE.BufferGeometry;
	// a ribbon's full width at scale 1 (m), for the far widening; double-sided ribbons
	thin?: number; doubleSided?: boolean;
	capacity: number;
	// the length (m) over which a part bends with the water (FloorMaterial.ts)
	stiffness: number;
	scale: Range;
	// on a stone: the footprint's radius at scale 1 (m), the depth range (m) and the slope (the
	// surface normal's y) it grows on, its weight there, and how far it leans from the surface's
	// normal to the vertical
	radius: number;
	depth?: Range; slope?: Range; weight?: number; upright?: number;
	// turned broadside to the swell
	acrossSwell?: boolean;
}

const TAU = Math.PI * 2;
const between = ( rng: Rng, r: Range ) => r[ 0 ] + ( r[ 1 ] - r[ 0 ] ) * rng();
// an integer seed from a cell's hash
const seedOf = ( i: number, j: number, salt: number ) => Math.floor( hash3i( i, j, salt ) * 4294967296 );

function kinds(): FloorKind[] {

	return [
		{
			name: 'eelgrass', palette: FS.EELGRASS, paint: eelgrassPaint( FS.EELGRASS.rough ), geometry: G.eelgrassGeometry,
			thin: 0.0115, doubleSided: true, capacity: 26000, stiffness: 0.12, scale: [ 0.4, 1.1 ], radius: 0.15,
		},
		{
			name: 'kelp', palette: FS.KELP, paint: kelpPaint( FS.KELP.rough ), geometry: G.kelpGeometry,
			doubleSided: true, capacity: 700, stiffness: 0.35, scale: [ 0.8, 1.35 ], radius: 0.22,
			depth: [ 1.4, 8 ], slope: [ 0.55, 1 ], weight: 1.6, upright: 0.6,
		},
		{
			name: 'table coral', palette: FS.TABLE_CORAL, paint: coralPaint( FS.TABLE_CORAL.rough, 90, 0.82 ), geometry: G.tableCoralGeometry,
			capacity: 260, stiffness: 1e3, scale: [ 0.5, 1.5 ], radius: 0.45,
			depth: [ 2, 9 ], slope: [ 0.7, 1 ], weight: 0.8, upright: 0.85,
		},
		{
			name: 'branching coral', palette: FS.BRANCHING_CORAL, paint: coralPaint( FS.BRANCHING_CORAL.rough, 140, 0.7 ), geometry: G.branchingCoralGeometry,
			capacity: 500, stiffness: 1e3, scale: [ 0.7, 1.7 ], radius: 0.16,
			depth: [ 1.8, 10 ], slope: [ 0.45, 1 ], weight: 1, upright: 0.75,
		},
		{
			name: 'massive coral', palette: FS.MASSIVE_CORAL, paint: coralPaint( FS.MASSIVE_CORAL.rough, 60, 0.95 ), geometry: G.massiveCoralGeometry,
			capacity: 260, stiffness: 1e3, scale: [ 0.3, 0.9 ], radius: 0.5,
			depth: [ 3, 13 ], slope: [ 0.35, 1 ], weight: 0.55, upright: 0.4,
		},
		{
			name: 'soft coral', palette: FS.SOFT_CORAL, paint: softCoralPaint( FS.SOFT_CORAL.rough ), geometry: G.softCoralGeometry,
			capacity: 400, stiffness: 0.6, scale: [ 0.7, 1.4 ], radius: 0.13,
			depth: [ 4, 15 ], slope: [ 0.1, 0.85 ], weight: 0.9, upright: 0.55,
		},
		{
			name: 'sea fan', palette: FS.SEA_FAN, paint: seaFanPaint( FS.SEA_FAN.rough ), geometry: G.seaFanGeometry,
			capacity: 260, stiffness: 1.2, scale: [ 0.6, 1.4 ], radius: 0.2,
			depth: [ 5, 16 ], slope: [ 0.1, 0.8 ], weight: 0.8, upright: 0.7, acrossSwell: true,
		},
		{
			name: 'urchins', palette: FS.URCHIN, paint: urchinPaint( FS.URCHIN.rough ), geometry: G.urchinGeometry,
			capacity: 600, stiffness: 1e3, scale: [ 0.8, 1.2 ], radius: 0.11,
		},
	];

}

/** The sea floor's fixed life (see the header). */
export class FloorLife {

	readonly group = new THREE.Group();
	private readonly kinds: FloorKind[];
	private readonly meshes: THREE.Mesh[];
	private readonly attrs: Record<'iPlace' | 'iTurn' | 'iVary', THREE.InstancedBufferAttribute>[];
	private readonly fft: OceanFFT;
	private readonly swell: FloorSwell = {
		wave: uniform( new THREE.Vector3( 1, 0, 1 ) ), amplitude: uniform( 0 ),
		time: uniform( 0 ), previousTime: uniform( 0 ), pixelAngle: uniform( 0.001 ),
	};
	private shown: Record<string, number> = {};

	constructor( data: WorldData, shared: Shared, waveMaps: WaveMaps, fft: OceanFFT ) {

		this.group.name = 'floor life';
		this.fft = fft;
		this.kinds = kinds();
		this.attrs = [];
		this.meshes = this.kinds.map( ( K ) => {

			const material = makeFloorMaterial( { name: K.name, palette: K.palette, paint: K.paint, thin: K.thin, doubleSided: K.doubleSided, shared, waveMaps, swell: this.swell } );
			const base = K.geometry();
			const geometry = new THREE.InstancedBufferGeometry();
			geometry.index = base.index;
			for ( const a of [ 'position', 'normal', 'aData', 'aSide' ] ) geometry.setAttribute( a, base.getAttribute( a ) );
			const attr = () => new THREE.InstancedBufferAttribute( new Float32Array( K.capacity * 4 ), 4 );
			const attrs = { iPlace: attr(), iTurn: attr(), iVary: attr() };
			for ( const [ a, b ] of Object.entries( attrs ) ) geometry.setAttribute( a, b );
			geometry.instanceCount = 0;
			this.attrs.push( attrs );
			const mesh = new THREE.Mesh( geometry, material );
			mesh.name = K.name;
			mesh.frustumCulled = false;
			mesh.castShadow = false;
			mesh.receiveShadow = true;
			// (the rain's bake would draw its geometry once at the origin; the rain never reaches it)
			mesh.userData.rainBake = false;
			showUnderwater( mesh );
			this.group.add( mesh );
			return mesh;

		} );
		this.layout( new SeaHabitat( data ) );

	}

	/** The land changed (a Grow): laid out again from it, as a fresh load would. */
	setWorld( data: WorldData ): void {

		this.layout( new SeaHabitat( data ) );

	}

	/** How many of each kind grow (the diagnostics). */
	counts(): Record<string, number> {

		return { ...this.shown };

	}

	/** The swell's terms and the clock at scene time `time`, `dt` the clock's step since the last
	 * frame (0 paused); `camera` and `height` (the render's height in pixels) give the pixel's angle. */
	update( time: number, dt: number, camera: THREE.PerspectiveCamera, height: number ): void {

		const s = this.fft.swellState();
		this.swell.wave.value.set( s.x, s.z, s.omega );
		// a regular wave of the same energy: the significant height over 2 sqrt( 2 )
		this.swell.amplitude.value = s.height / ( 2 * Math.SQRT2 );
		this.swell.time.value = time;
		this.swell.previousTime.value = time - dt;
		this.swell.pixelAngle.value = 2 * Math.tan( THREE.MathUtils.degToRad( camera.fov ) / 2 ) / Math.max( height, 1 );

	}

	// ------------------------------------------------------------------ the layout

	private layout( H: SeaHabitat ): void {

		const sites: Site[][] = this.kinds.map( () => [] );
		this.meadow( H, sites[ 0 ] );
		this.reef( H, sites );
		this.kinds.forEach( ( _K, i ) => this.write( i, sites[ i ] ) );

	}

	// eelgrass: a shoot per grid cell with the cover's chance
	private meadow( H: SeaHabitat, out: Site[] ): void {

		const K = this.kinds[ 0 ], cell = 0.3, B = H.bounds;
		for ( let j = Math.floor( B.z0 / cell ); j * cell < B.z1; j ++ ) for ( let i = Math.floor( B.x0 / cell ); i * cell < B.x1; i ++ ) {

			const rng = mulberry32( seedOf( i, j, 0xe31 ) );
			const x = ( i + rng() ) * cell, z = ( j + rng() ) * cell;
			const g = H.grass( x, z );
			if ( g <= 0.15 || rng() > smoothstep( 0.15, 0.6, g ) ) continue;
			const y = H.floor( x, z ), depth = - y;
			if ( depth < 2.5 || H.coast( x, z ) < 1 ) continue;
			// the leaves lengthen with the depth (less light, calmer water); a thin edge's shoots are short
			const length = ( 0.3 + 0.075 * depth ) * ( 0.75 + 0.4 * rng() ) * ( 0.7 + 0.3 * smoothstep( 0.15, 0.6, g ) );
			const tilt = new THREE.Vector3( ( rng() - 0.5 ) * 0.2, 1, ( rng() - 0.5 ) * 0.2 ).normalize();
			out.push( { x, y: y - 0.02, z, scale: Math.min( Math.max( length, K.scale[ 0 ] ), K.scale[ 1 ] ), up: tilt, yaw: rng() * TAU, seed: rng(), morph: Math.floor( rng() * 3 ) } );

		}

	}

	// the reef on the stones and at their feet
	private reef( H: SeaHabitat, sites: Site[][] ): void {

		const urchin = this.kinds.length - 1;
		const swell = this.fft.swellState();
		const swellYaw = Math.atan2( swell.x, swell.z );
		for ( const r of H.reefs ) {

			const rng = mulberry32( ( r.seed * 2654435761 ) >>> 0 ^ 0x4eef );
			const sdf = makeRockSDF( r );
			const taken: { x: number; y: number; z: number; r: number }[] = [];
			const fits = ( x: number, y: number, z: number, rad: number ) => ! taken.some( ( t ) => Math.hypot( t.x - x, t.y - y, t.z - z ) < ( t.r + rad ) * 0.8 );
			// the stone's upper surface, about 2 pi s^2: some 1.8 settlers a square metre
			const want = Math.round( TAU * r.s * r.s * 1.8 );
			for ( let tries = 0, n = 0; tries < want * 4 && n < want; tries ++ ) {

				const p = surfacePoint( r, sdf, rng );
				if ( ! p ) continue;
				const depth = - p.y;
				// the kind by its depth and slope, by weight
				let total = 0;
				const w = this.kinds.map( ( K ) => {

					if ( ! K.depth || ! K.slope ) return 0;
					const inDepth = smoothstep( K.depth[ 0 ] - 0.5, K.depth[ 0 ] + 0.5, depth ) * ( 1 - smoothstep( K.depth[ 1 ] - 1, K.depth[ 1 ] + 1, depth ) );
					const inSlope = smoothstep( K.slope[ 0 ] - 0.1, K.slope[ 0 ] + 0.1, p.n.y ) * ( 1 - smoothstep( K.slope[ 1 ] - 0.05, K.slope[ 1 ] + 0.05, p.n.y ) );
					const v = inDepth * inSlope * ( K.weight ?? 1 );
					total += v;
					return v;

				} );
				if ( total <= 0 ) continue;
				let pick = rng() * total, k = 0;
				while ( k < w.length - 1 && ( pick -= w[ k ] ) > 0 ) k ++;
				const K = this.kinds[ k ];
				const scale = between( rng, K.scale ), rad = K.radius * scale;
				if ( ! fits( p.x, p.y, p.z, rad ) ) continue;
				taken.push( { x: p.x, y: p.y, z: p.z, r: rad } );
				const up = p.n.clone().lerp( new THREE.Vector3( 0, 1, 0 ), K.upright ?? 0.5 ).normalize();
				const yaw = K.acrossSwell ? swellYaw + ( rng() - 0.5 ) * 0.5 : rng() * TAU;
				sites[ k ].push( { x: p.x, y: p.y - 0.01, z: p.z, scale, up, yaw, seed: rng(), morph: Math.floor( rng() * 4 ) } );
				n ++;

			}
			// long-spined urchins at the foot, in the stone's lee, a few together
			if ( - r.floor < 10 && rng() < 0.7 ) {

				const a = rng() * TAU, count = 1 + Math.floor( rng() * 4 );
				for ( let u = 0; u < count; u ++ ) {

					const b = a + ( rng() - 0.5 ) * 1.2;
					const ux = Math.cos( b ), uz = Math.sin( b );
					const d = rockExtent( r, ux, uz ) * ( 1.02 + rng() * 0.25 );
					const x = r.x + ux * d, z = r.z + uz * d, y = H.floor( x, z );
					if ( ! fits( x, y, z, 0.1 ) ) continue;
					taken.push( { x, y, z, r: 0.1 } );
					sites[ urchin ].push( { x, y: y - 0.015, z, scale: between( rng, this.kinds[ urchin ].scale ), up: new THREE.Vector3( 0, 1, 0 ), yaw: rng() * TAU, seed: rng(), morph: 0 } );

				}

			}

		}

	}

	private readonly _q = new THREE.Quaternion();
	private readonly _y = new THREE.Quaternion();

	private write( i: number, sites: Site[] ): void {

		const K = this.kinds[ i ], A = this.attrs[ i ], n = Math.min( sites.length, K.capacity );
		const place = A.iPlace.array as Float32Array, turn = A.iTurn.array as Float32Array, vary = A.iVary.array as Float32Array;
		const yAxis = new THREE.Vector3( 0, 1, 0 );
		for ( let k = 0; k < n; k ++ ) {

			const s = sites[ k ];
			this._q.setFromUnitVectors( yAxis, s.up ).multiply( this._y.setFromAxisAngle( yAxis, s.yaw ) );
			place.set( [ s.x, s.y, s.z, s.scale ], k * 4 );
			turn.set( [ this._q.x, this._q.y, this._q.z, this._q.w ], k * 4 );
			vary.set( [ s.seed, s.morph, 0, K.stiffness ], k * 4 );

		}
		for ( const a of [ A.iPlace, A.iTurn, A.iVary ] ) {

			a.clearUpdateRanges();
			a.addUpdateRange( 0, n * 4 );
			a.needsUpdate = true;

		}
		( this.meshes[ i ].geometry as THREE.InstancedBufferGeometry ).instanceCount = n;
		this.shown[ K.name ] = n;

	}

}

// a point on the stone's surface facing up or out: down a vertical ray from above it, by bisection
// on its SDF; its normal from the SDF's gradient. Null where the ray misses or the face looks down.
function surfacePoint( r: Rock, sdf: ( x: number, y: number, z: number ) => number, rng: Rng ): { x: number; y: number; z: number; n: THREE.Vector3 } | null {

	const a = rng() * TAU, ux = Math.cos( a ), uz = Math.sin( a );
	const d = rockExtent( r, ux, uz ) * Math.sqrt( rng() ) * 0.98;
	const x = r.x + ux * d, z = r.z + uz * d;
	let hi = r.y + r.sy * 2.2, lo = r.floor - 0.05;
	if ( sdf( x, lo, z ) > 0 || sdf( x, hi, z ) < 0 ) return null;
	for ( let k = 0; k < 22; k ++ ) {

		const m = ( hi + lo ) / 2;
		if ( sdf( x, m, z ) > 0 ) hi = m; else lo = m;

	}
	const y = ( hi + lo ) / 2;
	if ( y < r.floor + 0.04 ) return null;
	const e = 0.01;
	const n = new THREE.Vector3(
		sdf( x + e, y, z ) - sdf( x - e, y, z ),
		sdf( x, y + e, z ) - sdf( x, y - e, z ),
		sdf( x, y, z + e ) - sdf( x, y, z - e ),
	).normalize();
	if ( ! ( n.y > 0.05 ) ) return null;
	return { x, y, z, n };

}
