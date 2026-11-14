/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater), src/world/Fish.js.
 * SPDX-FileCopyrightText: Copyright (c) 2026 DRG Software Solutions LLC
 * SPDX-License-Identifier: MIT
 */

import * as THREE from 'three/webgpu';
import { type Shared, type WaveMaps, markSwimmer, swimmerSway, type OceanFFT } from '../../render/index.ts';
import type { WorldData } from '../world/types.ts';
import { type ShoreField, hash3i, mulberry32, type Rng } from '../../render/data.ts';
import { fishGeometry, wingRoot, type Anatomy } from './FishGeometry.ts';
import { makeFishMaterial, type Skin } from './FishMaterial.ts';

// The wenyao: schools of flying fish off the island that swim, take flight and glide.
//
// The wenyao: the Shanhaijing's flying fish ("shaped like a carp, a fish's body with a bird's
// wings, blue-grey markings, a white head and a red beak ... it flies by night"), in schools off
// the island (docs/design/life-and-islanders.md, The cast). The body and the ways are a real flying fish's
// (Exocoetidae, a four-winged one): a slender, round fish of the surface waters, its long pectoral
// fins and its pelvic fins spread as wings in flight and folded along its flank in the water, the
// tail fin's lower lobe the longer. The fantasy is the text's: the white head, the red snout and
// the markings on the back; its schools take flight more often by night; it is the size of a
// carp, about half a metre, which also keeps it visible from the island's view (a real flying
// fish is some 30 cm).
//
// Where: the surface waters round the island, between 4 and 14 m out from the coast where the
// water is at least 3.5 m deep (just past the pale shelf, inside the island view's frame), from 0.25 to 0.9 m under the surface. Schools: one for about every
// 60 m of the coast (measured on the shore's distance field), at most six, each of 34 to 53 fish; each grows
// from a cell of a world-anchored 12 m grid whose jittered point lies in that water, the cells
// taken by a hash of their own, at least 30 m apart, so the layout is a function of the land.
//
// How they move: a per-frame simulation on the CPU, as shipped games move their ambient life
// (tidewater's schooling fish, Fish.js: separation, alignment and cohesion within the school, a
// goal it swims to in long straight runs, turning back from shallow water and from the coast),
// with the flight added. Now and then a school bursts out of the water (an exponential wait of 28 s
// on average by day, 11 s by night): a share of its fish whose course stays over the sea for the
// next 35 m, each after a short delay, speeds up to
// the surface, breaks it and taxis with its tail in the water, its wings spread, until it reaches
// its take-off speed (11 - 13 m/s); then it glides, held up by a lift that falls with the square
// of its slowing speed (about 1.5 m high, 30 m and 3 s), and either touches its tail down to taxi
// again (once at most, a third of the time) or folds its wings and dives back in.
//
// History: the state is integrated with the scene clock's step (none while paused) and drawn from
// random streams seeded per school, so a stepped clip repeats. The layout it starts from is a
// function of the land alone: a scene jump (`reset`) returns to it, and a page loaded paused (the
// test mode) never steps away from it, so a paused frame equals a fresh load's. A Grow resets it if
// it has not stepped since; otherwise it keeps its fish and moves only those the land took, or that
// lie in water too shallow now, back into their school.
//
// Drawn as one instanced mesh (FishMaterial.ts) in the opaque pass only, marked as a swimmer
// (Refraction.ts markSwimmer) and moved to where the eye sees it through the waves (Water.ts
// swimmerSway): the water shows a fish from that pass's image, at the render's resolution and
// samples, and reads the floor behind it from the refraction image, which leaves it out. It casts no
// shadow.

const WENYAO: Anatomy = {
	body: 0.8, sec: 2.4,
	top: [ [ 0, 0.004 ], [ 0.03, 0.022 ], [ 0.08, 0.045 ], [ 0.18, 0.064 ], [ 0.35, 0.072 ], [ 0.55, 0.066 ], [ 0.75, 0.047 ], [ 0.9, 0.032 ], [ 1, 0.026 ] ],
	bot: [ [ 0, 0.004 ], [ 0.03, 0.02 ], [ 0.08, 0.04 ], [ 0.18, 0.057 ], [ 0.35, 0.064 ], [ 0.55, 0.058 ], [ 0.75, 0.041 ], [ 0.9, 0.028 ], [ 1, 0.022 ] ],
	wid: [ [ 0, 0.004 ], [ 0.04, 0.024 ], [ 0.12, 0.044 ], [ 0.3, 0.054 ], [ 0.5, 0.049 ], [ 0.7, 0.035 ], [ 0.9, 0.02 ], [ 1, 0.014 ] ],
	dorsal: [ { from: 0.66, to: 0.82, rays: 11, h: [ [ 0, 0.05 ], [ 1, 0.028 ] ], rake: [ 0.6, 0.95 ], notch: 0.015 } ],
	anal: [ { from: 0.7, to: 0.84, rays: 10, h: [ [ 0, 0.042 ], [ 1, 0.024 ] ], rake: [ 0.6, 0.95 ], notch: 0.015 } ],
	// high on the flank behind the gill cover, reaching back to the tail when folded
	pectoral: { u: 0.21, y: 0.022, rays: 14, lead: 1.32, last: 0.32, len: 0.56, tail: 0.42, dihedral: 0.1 },
	pelvic: { u: 0.55, y: - 0.045, rays: 6, lead: 1.15, last: 0.38, len: 0.26, tail: 0.5, dihedral: 0.04 },
	caudal: { len: 0.21, span: 0.13, fork: 0.38, lower: 1.3, rays: 15 },
};

const SKIN: Skin = {
	back: 0x4b7486, marks: 0x173240, flank: 0xb4c7d3, belly: 0xedefea, head: 0xe9e6dc, snout: 0xb5321d,
	fin: 0x627a88, finEdge: 0x2b3c46, iris: 0xcdc49e,
	headEnd: 0.17, snoutEnd: 0.03,
	eye: { u: 0.06, y: 0.012, r: 0.03 },
};

// the habitat (m): its distance from the coast, the least depth, the swimming band
const COAST = [ 4, 14 ] as const, DEPTH = 3.5, BAND = [ - 0.9, - 0.25 ] as const;
const LENGTH = [ 0.45, 0.56 ] as const;
const SCHOOL = { per: 60, max: 6, fish: [ 34, 53 ], cell: 12, apart: 30 } as const;
const CAPACITY = SCHOOL.max * SCHOOL.fish[ 1 ];
// steering, in body lengths and per second (tidewater's school and surface modes)
const STEER = { cruise: 2.4, max: 4.5, accel: 3, sep: 1.6, nbr: 5, wSep: 5, wAli: 1.8, wCoh: 1.0, wGoal: 0.8 };
// the flight: the wait between bursts by day and by night (s), the take-off speed (m/s), the
// glide's lift (its share of the weight at take-off speed), drag (per m) and vertical damping (/s)
const FLIGHT = { day: 28, night: 11, takeoff: [ 11, 13 ], lift: 1.06, drag: 0.007, damp: 1.1, climb: [ 1.6, 2.2 ], retaxi: 0.35 };
const GRAVITY = 9.81, TAU = Math.PI * 2;
const SWIM = 0, LAUNCH = 1, TAXI = 2, GLIDE = 3;

// bilinear lookup in a world field (texel centres at x0 + ( i + 0.5 ) * cell); NaN outside
function lookup( f: ShoreField ): ( x: number, z: number ) => number {

	return ( x, z ) => {

		const fx = ( x - f.x0 ) / f.cell - 0.5, fz = ( z - f.z0 ) / f.cell - 0.5;
		const i = Math.floor( fx ), j = Math.floor( fz );
		if ( i < 0 || j < 0 || i + 1 >= f.nx || j + 1 >= f.nz ) return NaN;
		const u = fx - i, v = fz - j, d = f.data, k = j * f.nx + i;
		return ( d[ k ] * ( 1 - u ) + d[ k + 1 ] * u ) * ( 1 - v ) + ( d[ k + f.nx ] * ( 1 - u ) + d[ k + f.nx + 1 ] * u ) * v;

	};

}

class Habitat {

	readonly coast: ( x: number, z: number ) => number;
	readonly floor: ( x: number, z: number ) => number;
	readonly bounds: { x0: number; z0: number; x1: number; z1: number };

	constructor( data: WorldData ) {

		this.coast = lookup( data.shore );
		this.floor = lookup( data.seabedField );
		const f = data.shore;
		this.bounds = { x0: f.x0, z0: f.z0, x1: f.x0 + f.nx * f.cell, z1: f.z0 + f.nz * f.cell };

	}

	fits( x: number, z: number ): boolean {

		const d = this.coast( x, z );
		return d >= COAST[ 0 ] && d <= COAST[ 1 ] && this.floor( x, z ) <= - DEPTH;

	}

	// the swimming height at a point: inside the band and clear of the floor
	clampY( x: number, z: number, y: number ): number {

		const floor = this.floor( x, z );
		return Math.min( BAND[ 1 ] + 0.05, Math.max( Number.isNaN( floor ) ? BAND[ 0 ] : Math.max( BAND[ 0 ], floor + 0.8 ), y ) );

	}

}

interface School {
	offset: number; count: number; rng: Rng;
	home: THREE.Vector3; goal: THREE.Vector3; center: THREE.Vector3; heading: THREE.Vector3;
	timer: number; burst: number;
}

const _q = new THREE.Quaternion(), _e = new THREE.Euler( 0, 0, 0, 'YXZ' );

export class Wenyao {

	readonly mesh: THREE.Mesh;
	private habitat: Habitat;
	private coastLength: number;
	private schools: School[] = [];
	private n = 0;
	// whether the simulation has stepped since its last reset
	private stepped = false;
	// per fish: position, velocity, heading, the previous position
	private readonly pos = new Float32Array( CAPACITY * 3 );
	private readonly vel = new Float32Array( CAPACITY * 3 );
	private readonly head = new Float32Array( CAPACITY * 3 );
	private readonly prev = new Float32Array( CAPACITY * 3 );
	private readonly size = new Float32Array( CAPACITY );
	private readonly roll = new Float32Array( CAPACITY );
	private readonly bend = new Float32Array( CAPACITY );
	private readonly phase = new Float32Array( CAPACITY );
	private readonly prevPhase = new Float32Array( CAPACITY );
	private readonly amp = new Float32Array( CAPACITY );
	private readonly fold = new Float32Array( CAPACITY ).fill( 1 );
	private readonly speedMul = new Float32Array( CAPACITY );
	// the flight: its state, the delay before a launch, the take-off speed, the touches left, the
	// glide's turn rate
	private readonly state = new Uint8Array( CAPACITY );
	private readonly delay = new Float32Array( CAPACITY );
	private readonly takeoff = new Float32Array( CAPACITY );
	private readonly touches = new Uint8Array( CAPACITY );
	private readonly turnRate = new Float32Array( CAPACITY );
	// boids accumulators: separation, alignment, cohesion; neighbour counts
	private readonly acc = new Float32Array( CAPACITY * 9 );
	private readonly nbrs = new Uint16Array( CAPACITY );
	private readonly attrs: Record<'iPose' | 'iTurn' | 'iMotion' | 'iBefore', THREE.InstancedBufferAttribute>;

	constructor( data: WorldData, shared: Shared, waveMaps: WaveMaps, fft: OceanFFT ) {

		const base = fishGeometry( WENYAO, 0 );
		const geometry = new THREE.InstancedBufferGeometry();
		geometry.index = base.index;
		for ( const name of [ 'position', 'normal', 'aData' ] ) geometry.setAttribute( name, base.getAttribute( name ) );
		const attr = () => new THREE.InstancedBufferAttribute( new Float32Array( CAPACITY * 4 ), 4 );
		this.attrs = { iPose: attr(), iTurn: attr(), iMotion: attr(), iBefore: attr() };
		for ( const [ name, a ] of Object.entries( this.attrs ) ) geometry.setAttribute( name, a );
		const material = makeFishMaterial( WENYAO, SKIN, shared, waveMaps, { pectoral: wingRoot( WENYAO, WENYAO.pectoral ), pelvic: wingRoot( WENYAO, WENYAO.pelvic ) }, ( p ) => swimmerSway( fft, p, shared.waterLevel ) );
		markSwimmer( material );
		this.mesh = new THREE.Mesh( geometry, material );
		this.mesh.name = 'wenyao';
		this.mesh.frustumCulled = false;
		this.habitat = new Habitat( data );
		this.coastLength = coastLength( data.shore );
		this.reset();

	}

	/** The land changed (a Grow): reset if nothing moved since the last reset, else keep the fish
	 * and bring those the land or the shallows took back into their school. */
	setWorld( data: WorldData ): void {

		this.habitat = new Habitat( data );
		this.coastLength = coastLength( data.shore );
		if ( ! this.stepped ) return this.reset();
		const H = this.habitat;
		for ( const g of this.schools ) {

			if ( ! H.fits( g.home.x, g.home.z ) ) {

				const spot = this.findSpot( g.rng, g.home.x, g.home.z, 60 );
				if ( spot ) g.home.copy( spot );

			}
			for ( let k = 0; k < g.count; k ++ ) {

				const i = g.offset + k, i3 = i * 3;
				const x = this.pos[ i3 ], z = this.pos[ i3 + 2 ];
				if ( this.state[ i ] !== SWIM || H.floor( x, z ) <= - DEPTH * 0.6 ) continue;
				this.place( g, i );

			}
			g.goal.copy( g.home );

		}

	}

	/** Back to the layout the land gives (a scene jump, a new land). */
	reset(): void {

		const H = this.habitat, B = H.bounds;
		const count = Math.max( 1, Math.min( SCHOOL.max, Math.round( this.coastLength / SCHOOL.per ) ) );
		// the candidate cells, each with its own stream
		const cands: { x: number; z: number; key: number; seed: number }[] = [];
		const C = SCHOOL.cell;
		for ( let cj = Math.floor( B.z0 / C ); cj * C < B.z1; cj ++ ) for ( let ci = Math.floor( B.x0 / C ); ci * C < B.x1; ci ++ ) {

			const seed = hash3i( ci, cj, 0x7e2 );
			const rng = mulberry32( seed );
			const x = ( ci + 0.5 + ( rng() - 0.5 ) * 0.8 ) * C, z = ( cj + 0.5 + ( rng() - 0.5 ) * 0.8 ) * C;
			if ( H.fits( x, z ) ) cands.push( { x, z, key: rng(), seed } );

		}
		cands.sort( ( a, b ) => a.key - b.key );
		this.schools = [];
		this.n = 0;
		for ( const c of cands ) {

			if ( this.schools.length >= count ) break;
			if ( this.schools.some( ( g ) => Math.hypot( g.home.x - c.x, g.home.z - c.z ) < SCHOOL.apart ) ) continue;
			const rng = mulberry32( c.seed ^ 0x5a17 );
			const fish = SCHOOL.fish[ 0 ] + Math.floor( rng() * ( SCHOOL.fish[ 1 ] - SCHOOL.fish[ 0 ] + 1 ) );
			const home = new THREE.Vector3( c.x, ( BAND[ 0 ] + BAND[ 1 ] ) / 2, c.z );
			const a = rng() * TAU;
			const g: School = {
				offset: this.n, count: fish, rng, home, goal: home.clone(), center: home.clone(),
				heading: new THREE.Vector3( Math.cos( a ), 0, Math.sin( a ) ), timer: 0, burst: 0,
			};
			g.burst = this.wait( g, 0 );
			this.schools.push( g );
			for ( let k = 0; k < fish; k ++ ) this.spawn( g, this.n + k );
			this.n += fish;
			this.retarget( g );

		}
		( this.mesh.geometry as THREE.InstancedBufferGeometry ).instanceCount = this.n;
		this.stepped = false;
		this.write( 0 );

	}

	/** One step of the scene clock (`dt` 0 while paused); `night` 0 by day .. 1 by night. */
	update( dt: number, night: number ): void {

		this.prev.set( this.pos );
		this.prevPhase.set( this.phase );
		if ( dt > 0 ) {

			this.stepped = true;
			const steps = Math.min( 3, Math.ceil( dt * 30 ) ), h = dt / steps;
			for ( let s = 0; s < steps; s ++ ) for ( const g of this.schools ) this.step( g, h, night );

		}
		this.write( dt );

	}

	// ------------------------------------------------------------------ layout

	// a fish of the school at a free spot near its home, swimming along the school's heading
	private spawn( g: School, i: number ): void {

		const rng = g.rng;
		const L = LENGTH[ 0 ] + ( LENGTH[ 1 ] - LENGTH[ 0 ] ) * rng();
		this.size[ i ] = L;
		this.speedMul[ i ] = 0.88 + rng() * 0.24;
		this.phase[ i ] = rng() * TAU;
		this.amp[ i ] = 0.08;
		this.bend[ i ] = 0;
		this.roll[ i ] = 0;
		this.state[ i ] = SWIM;
		this.fold[ i ] = 1;
		this.place( g, i );
		this.prev.set( this.pos.subarray( i * 3, i * 3 + 3 ), i * 3 );
		this.prevPhase[ i ] = this.phase[ i ];

	}

	// a place in the school's polarised shoal round its centre (its home at a reset)
	private place( g: School, i: number ): void {

		const rng = g.rng, H = this.habitat, h = g.heading;
		let x = g.home.x, z = g.home.z;
		for ( let t = 0; t < 10; t ++ ) {

			const along = ( rng() - 0.5 ) * 6, across = ( rng() - 0.5 ) * 3.6;
			const tx = g.home.x + h.x * along - h.z * across, tz = g.home.z + h.z * along + h.x * across;
			if ( H.fits( tx, tz ) ) { x = tx; z = tz; break; }

		}
		const y = H.clampY( x, z, BAND[ 0 ] + ( BAND[ 1 ] - BAND[ 0 ] ) * rng() );
		const s = STEER.cruise * this.size[ i ] * this.speedMul[ i ];
		const d = Math.atan2( h.z, h.x ) + ( rng() - 0.5 ) * 0.3;
		this.pos.set( [ x, y, z ], i * 3 );
		this.vel.set( [ Math.cos( d ) * s, 0, Math.sin( d ) * s ], i * 3 );
		this.head.set( [ Math.cos( d ), 0, Math.sin( d ) ], i * 3 );

	}

	// a point in the habitat within `radius` of ( x, z )
	private findSpot( rng: Rng, x: number, z: number, radius: number ): THREE.Vector3 | null {

		for ( let k = 0; k < 40; k ++ ) {

			const a = rng() * TAU, r = Math.sqrt( rng() ) * radius;
			const tx = x + Math.cos( a ) * r, tz = z + Math.sin( a ) * r;
			if ( this.habitat.fits( tx, tz ) ) return new THREE.Vector3( tx, ( BAND[ 0 ] + BAND[ 1 ] ) / 2, tz );

		}
		return null;

	}

	// the next goal: a long straight run ahead within the habitat, or back toward home
	private retarget( g: School ): void {

		const rng = g.rng, H = this.habitat;
		for ( let k = 0; k < 24; k ++ ) {

			const a = Math.atan2( g.heading.z, g.heading.x ) + ( rng() - 0.5 ) * ( k < 12 ? 1.6 : 4 );
			const d = 18 + rng() * 17;
			const x = g.center.x + Math.cos( a ) * d, z = g.center.z + Math.sin( a ) * d;
			if ( ! H.fits( x, z ) || ! H.fits( ( x + g.center.x ) / 2, ( z + g.center.z ) / 2 ) ) continue;
			g.goal.set( x, H.clampY( x, z, BAND[ 0 ] + ( BAND[ 1 ] - BAND[ 0 ] ) * rng() ), z );
			g.timer = 10 + rng() * 10;
			return;

		}
		g.goal.copy( g.home );
		g.timer = 8;

	}

	// the wait before the school's next burst
	private wait( g: School, night: number ): number {

		const mean = FLIGHT.day + ( FLIGHT.night - FLIGHT.day ) * night;
		return - Math.log( 1 - g.rng() * 0.999 ) * mean;

	}

	// ------------------------------------------------------------------ simulation

	private step( g: School, dt: number, night: number ): void {

		const n = g.count, o = g.offset, P = this.pos, V = this.vel, A = this.acc, C = this.nbrs, H = this.habitat;
		let cx = 0, cy = 0, cz = 0, swimming = 0;
		for ( let k = 0; k < n; k ++ ) {

			if ( this.state[ o + k ] !== SWIM ) continue;
			const i = ( o + k ) * 3;
			cx += P[ i ]; cy += P[ i + 1 ]; cz += P[ i + 2 ];
			swimming ++;

		}
		if ( swimming > 0 ) g.center.set( cx / swimming, cy / swimming, cz / swimming );
		g.timer -= dt;
		const gx = g.goal.x - g.center.x, gz = g.goal.z - g.center.z;
		if ( g.timer <= 0 || gx * gx + gz * gz < 4 ) this.retarget( g );

		// a burst: a share of the swimming fish, each after its own delay
		g.burst -= dt;
		if ( g.burst <= 0 ) {

			g.burst = this.wait( g, night );
			if ( H.fits( g.center.x, g.center.z ) ) {

				const share = 0.3 + g.rng() * 0.55;
				for ( let k = 0; k < n; k ++ ) {

					const i = o + k;
					if ( this.state[ i ] !== SWIM || g.rng() > share || ! this.clear( i ) ) continue;
					this.state[ i ] = LAUNCH;
					this.delay[ i ] = g.rng() * 1.1;
					this.takeoff[ i ] = FLIGHT.takeoff[ 0 ] + ( FLIGHT.takeoff[ 1 ] - FLIGHT.takeoff[ 0 ] ) * g.rng();
					this.touches[ i ] = 1;
					this.turnRate[ i ] = ( g.rng() - 0.5 ) * 0.16;

				}

			}

		}

		// neighbours within the school (swimming fish only)
		const Lmax = LENGTH[ 1 ];
		const nbr2 = ( STEER.nbr * Lmax ) ** 2, sepR = STEER.sep * Lmax, sep2 = sepR * sepR;
		A.fill( 0, o * 9, ( o + n ) * 9 );
		C.fill( 0, o, o + n );
		for ( let a = 0; a < n; a ++ ) {

			const i = o + a;
			if ( this.state[ i ] !== SWIM ) continue;
			const ix = P[ i * 3 ], iy = P[ i * 3 + 1 ], iz = P[ i * 3 + 2 ];
			for ( let b = a + 1; b < n; b ++ ) {

				const j = o + b;
				if ( this.state[ j ] !== SWIM ) continue;
				const dx = P[ j * 3 ] - ix, dy = P[ j * 3 + 1 ] - iy, dz = P[ j * 3 + 2 ] - iz;
				const d2 = dx * dx + dy * dy + dz * dz;
				if ( d2 > nbr2 ) continue;
				C[ i ] ++; C[ j ] ++;
				const ai = i * 9, aj = j * 9;
				A[ ai + 3 ] += V[ j * 3 ]; A[ ai + 4 ] += V[ j * 3 + 1 ]; A[ ai + 5 ] += V[ j * 3 + 2 ];
				A[ aj + 3 ] += V[ i * 3 ]; A[ aj + 4 ] += V[ i * 3 + 1 ]; A[ aj + 5 ] += V[ i * 3 + 2 ];
				A[ ai + 6 ] += dx; A[ ai + 7 ] += dy; A[ ai + 8 ] += dz;
				A[ aj + 6 ] -= dx; A[ aj + 7 ] -= dy; A[ aj + 8 ] -= dz;
				if ( d2 < sep2 ) {

					const d = Math.sqrt( d2 ) + 1e-4, f = ( sepR - d ) / ( sepR * d );
					A[ ai ] -= dx * f; A[ ai + 1 ] -= dy * f; A[ ai + 2 ] -= dz * f;
					A[ aj ] += dx * f; A[ aj + 1 ] += dy * f; A[ aj + 2 ] += dz * f;

				}

			}

		}

		for ( let a = 0; a < n; a ++ ) {

			const i = o + a, i3 = i * 3, ai = i * 9;
			const L = this.size[ i ];
			let x = P[ i3 ], y = P[ i3 + 1 ], z = P[ i3 + 2 ];
			let vx = V[ i3 ], vy = V[ i3 + 1 ], vz = V[ i3 + 2 ];
			const state = this.state[ i ];

			if ( state === TAXI || state === GLIDE ) {

				// out of the water: along its heading, turning a little as it glides
				let vh = Math.hypot( vx, vz ) + 1e-6;
				let hx = vx / vh, hz = vz / vh;
				if ( state === TAXI ) {

					// the tail sculls in the water: speeding up to take off, the body level on the surface
					vh += 14 * dt;
					y = 0.01;
					vy = 0;
					if ( vh >= this.takeoff[ i ] ) {

						this.state[ i ] = GLIDE;
						vy = FLIGHT.climb[ 0 ] + ( FLIGHT.climb[ 1 ] - FLIGHT.climb[ 0 ] ) * g.rng();

					}

				} else {

					const lift = GRAVITY * FLIGHT.lift * ( vh / this.takeoff[ i ] ) ** 2;
					vy += ( lift - GRAVITY - FLIGHT.damp * vy ) * dt;
					vh -= FLIGHT.drag * vh * vh * dt;
					const turn = this.turnRate[ i ] * dt, c = Math.cos( turn ), s = Math.sin( turn );
					[ hx, hz ] = [ hx * c - hz * s, hx * s + hz * c ];
					y += vy * dt;
					if ( y <= 0.02 && vy < 0 ) {

						if ( this.touches[ i ] > 0 && vh > 9 && g.rng() < FLIGHT.retaxi ) {

							// a touch of the tail: taxi up to speed again
							this.touches[ i ] --;
							this.state[ i ] = TAXI;
							this.takeoff[ i ] = Math.max( vh + 1.5, this.takeoff[ i ] * 0.95 );
							y = 0.01;
							vy = 0;

						} else {

							// back into the water
							this.state[ i ] = SWIM;
							vh = Math.min( vh * 0.3, 3 );
							y = - 0.12;
							vy = - 1.2;

						}

					}

				}
				vx = hx * vh;
				vz = hz * vh;
				x += vx * dt;
				z += vz * dt;
				P[ i3 ] = x; P[ i3 + 1 ] = y; P[ i3 + 2 ] = z;
				V[ i3 ] = vx; V[ i3 + 1 ] = vy; V[ i3 + 2 ] = vz;
				continue;

			}

			const cruise = STEER.cruise * L * this.speedMul[ i ];
			let ax = A[ ai ] * STEER.wSep, ay = A[ ai + 1 ] * STEER.wSep, az = A[ ai + 2 ] * STEER.wSep;
			const c = C[ i ];
			if ( c > 0 ) {

				const inv = 1 / c;
				ax += ( A[ ai + 3 ] * inv - vx ) * STEER.wAli + A[ ai + 6 ] * inv * STEER.wCoh;
				ay += ( A[ ai + 4 ] * inv - vy ) * STEER.wAli + A[ ai + 7 ] * inv * STEER.wCoh;
				az += ( A[ ai + 5 ] * inv - vz ) * STEER.wAli + A[ ai + 8 ] * inv * STEER.wCoh;

			}
			// the goal
			let want = cruise, ty = g.goal.y;
			const dx = g.goal.x - x, dz = g.goal.z - z, dl = Math.hypot( dx, ty - y, dz ) + 1e-6;
			ax += ( dx / dl * want - vx ) * STEER.wGoal;
			ay += ( ( ty - y ) / dl * want - vy ) * STEER.wGoal;
			az += ( dz / dl * want - vz ) * STEER.wGoal;
			// out of the habitat ahead (the coast, the shallows): turn back
			if ( ! H.fits( x + vx * 1.5, z + vz * 1.5 ) ) {

				ax -= vx * 3;
				az -= vz * 3;
				const hx = g.home.x - x, hz = g.home.z - z, hl = Math.hypot( hx, hz ) + 1e-6;
				ax += hx / hl * cruise * 2;
				az += hz / hl * cruise * 2;

			}
			let amax = STEER.accel * L * 4;
			if ( state === LAUNCH ) this.delay[ i ] -= dt;
			const rising = state === LAUNCH && this.delay[ i ] <= 0;
			if ( rising ) {

				// up to the surface, fast
				want = 6;
				const vh = Math.hypot( vx, vz ) + 1e-6;
				ax += ( vx / vh * want - vx ) * 3;
				az += ( vz / vh * want - vz ) * 3;
				ay += 8;
				amax = 30;

			} else {

				// the band: under the surface and over the floor; level swimming
				const top = BAND[ 1 ] + 0.05, bottom = H.clampY( x, z, BAND[ 0 ] );
				if ( y > top ) ay -= ( y - top ) * 8;
				if ( y < bottom ) ay += ( bottom - y ) * 8;
				ay -= vy * 1.5;

			}
			const al = Math.hypot( ax, ay, az );
			if ( al > amax ) { ax *= amax / al; ay *= amax / al; az *= amax / al; }
			vx += ax * dt; vy += ay * dt; vz += az * dt;
			const speed = Math.hypot( vx, vy, vz ) + 1e-6;
			const vmax = rising ? 9 : STEER.max * L, vmin = cruise * 0.3;
			const sc = speed > vmax ? vmax / speed : speed < vmin ? vmin / speed : 1;
			vx *= sc; vy *= sc; vz *= sc;
			x += vx * dt; y += vy * dt; z += vz * dt;
			if ( rising && y > - 0.08 ) {

				// it breaks the surface and taxis
				this.state[ i ] = TAXI;
				y = 0.01;
				vy = 0;

			} else if ( ! rising ) y = Math.min( y, - 0.2 );
			P[ i3 ] = x; P[ i3 + 1 ] = y; P[ i3 + 2 ] = z;
			V[ i3 ] = vx; V[ i3 + 1 ] = vy; V[ i3 + 2 ] = vz;

		}

		const hx = g.goal.x - g.center.x, hz = g.goal.z - g.center.z, hl = Math.hypot( hx, hz );
		if ( hl > 0.5 ) g.heading.set( hx / hl, 0, hz / hl );

	}

	// whether a fish's course stays over the sea for a flight (the open sea beyond the shore's
	// field counts as sea)
	private clear( i: number ): boolean {

		const i3 = i * 3, vx = this.vel[ i3 ], vz = this.vel[ i3 + 2 ], vl = Math.hypot( vx, vz ) + 1e-6;
		for ( const d of [ 8, 16, 24, 35 ] ) {

			if ( this.habitat.coast( this.pos[ i3 ] + vx / vl * d, this.pos[ i3 + 2 ] + vz / vl * d ) < 3 ) return false;

		}
		return true;

	}

	// ------------------------------------------------------------------ the instances

	// Turns each fish to its course, advances its swimming wave and its wings, and writes the
	// instances (`dt` 0: only the pose as it is).
	private write( dt: number ): void {

		const P = this.pos, V = this.vel, Hd = this.head, R = this.prev;
		const pose = this.attrs.iPose.array as Float32Array, turn = this.attrs.iTurn.array as Float32Array;
		const motion = this.attrs.iMotion.array as Float32Array, before = this.attrs.iBefore.array as Float32Array;
		const kHead = 1 - Math.exp( - dt * 6 ), kRoll = 1 - Math.exp( - dt * 3 );
		for ( let i = 0; i < this.n; i ++ ) {

			const i3 = i * 3, i4 = i * 4, L = this.size[ i ], state = this.state[ i ];
			const vx = V[ i3 ], vy = V[ i3 + 1 ], vz = V[ i3 + 2 ];
			const speed = Math.hypot( vx, vy, vz ) + 1e-6;
			const air = state === TAXI || state === GLIDE;
			if ( dt > 0 ) {

				// the heading follows the velocity (at once in the air), its pitch limited
				const kh = air ? 1 : kHead * Math.min( 1, speed / ( L * 0.5 ) + 0.15 );
				const ohx = Hd[ i3 ], ohz = Hd[ i3 + 2 ];
				let hx = ohx + ( vx / speed - ohx ) * kh, hy = Hd[ i3 + 1 ] + ( vy / speed - Hd[ i3 + 1 ] ) * kh, hz = ohz + ( vz / speed - ohz ) * kh;
				const pitch = state === GLIDE ? 0.35 : state === TAXI ? 0.12 : 0.45;
				hy = state === TAXI ? 0.12 : Math.max( - pitch, Math.min( pitch, hy ) );
				const hl = Math.hypot( hx, hy, hz ) || 1;
				Hd[ i3 ] = hx / hl; Hd[ i3 + 1 ] = hy / hl; Hd[ i3 + 2 ] = hz / hl;
				const yawRate = ( ohz * hx - ohx * hz ) / dt;
				this.roll[ i ] += ( Math.max( - 0.5, Math.min( 0.5, yawRate * ( air ? 0.3 : 0.12 ) ) ) - this.roll[ i ] ) * kRoll;
				this.bend[ i ] += ( Math.max( - 0.25, Math.min( 0.25, yawRate * 0.06 ) ) - this.bend[ i ] ) * kRoll;
				// the tail: its beat grows with the speed; fast and short as it taxis, still in a glide
				const bl = speed / L;
				const freq = state === TAXI ? 16 : state === GLIDE ? 0 : Math.min( 10, 1.6 + 0.9 * bl );
				this.phase[ i ] = ( this.phase[ i ] + dt * TAU * freq ) % ( TAU * 64 );
				const amp = state === TAXI ? 0.14 : state === GLIDE ? 0 : 0.08 * ( 0.55 + 0.45 * Math.min( 2.5, bl / STEER.cruise ) );
				this.amp[ i ] += ( amp - this.amp[ i ] ) * ( 1 - Math.exp( - dt * 8 ) );
				// the wings open as it nears the surface and close as it dives back in
				const open = air || ( state === LAUNCH && this.delay[ i ] <= 0 && P[ i3 + 1 ] > - 0.35 );
				this.fold[ i ] += ( ( open ? 0 : 1 ) - this.fold[ i ] ) * ( 1 - Math.exp( - dt * ( open ? 14 : 7 ) ) );

			}
			_e.set( - Math.asin( Hd[ i3 + 1 ] ), Math.atan2( Hd[ i3 ], Hd[ i3 + 2 ] ), this.roll[ i ] );
			_q.setFromEuler( _e );
			pose[ i4 ] = P[ i3 ]; pose[ i4 + 1 ] = P[ i3 + 1 ]; pose[ i4 + 2 ] = P[ i3 + 2 ]; pose[ i4 + 3 ] = L;
			turn[ i4 ] = _q.x; turn[ i4 + 1 ] = _q.y; turn[ i4 + 2 ] = _q.z; turn[ i4 + 3 ] = _q.w;
			motion[ i4 ] = this.phase[ i ]; motion[ i4 + 1 ] = this.amp[ i ]; motion[ i4 + 2 ] = this.bend[ i ]; motion[ i4 + 3 ] = this.fold[ i ];
			before[ i4 ] = R[ i3 ]; before[ i4 + 1 ] = R[ i3 + 1 ]; before[ i4 + 2 ] = R[ i3 + 2 ]; before[ i4 + 3 ] = this.prevPhase[ i ];

		}
		for ( const a of Object.values( this.attrs ) ) a.needsUpdate = true;

	}

}

// The coast's length (m) on the shore's distance field: the crossings of its zero between
// neighbours of a 0.5 m lattice, times the spacing, times pi / 4 (a curve's crossings of a square
// lattice count its length in the city-block metric, 4 / pi times its own on average).
function coastLength( f: ShoreField ): number {

	const step = Math.max( 1, Math.round( 0.5 / f.cell ) ), d = f.data;
	let crossings = 0;
	for ( let j = 0; j + step < f.nz; j += step ) for ( let i = 0; i + step < f.nx; i += step ) {

		const k = j * f.nx + i, v = d[ k ] < 0;
		if ( v !== d[ k + step ] < 0 ) crossings ++;
		if ( v !== d[ k + step * f.nx ] < 0 ) crossings ++;

	}
	return crossings * step * f.cell * Math.PI / 4;

}
