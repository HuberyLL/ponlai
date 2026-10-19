import * as THREE from 'three/webgpu';
import { Fn, Loop, texture, textureLoad, vec2, vec4, float, int, ivec2, floor, exp, exp2, log2, max, min, clamp, select, screenCoordinate, luminance, mix, uniform } from 'three/tsl';
import type { FrameGraph, GraphResources, ResourceHandle } from './graph/FrameGraph.ts';
import type { PassBuilder } from './graph/GraphCompiler.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

// Local tone mapping: a detail-preserving contrast change on the frame's log luminance, after
// Patry, "Real-Time Samurai Cinema" (SIGGRAPH 2021), on the bilateral grid of Chen, Paris and
// Durand, "Real-time Edge-Aware Image Processing with the Bilateral Grid" (SIGGRAPH 2007). A
// bright sky or sea and the darker land each keep their colour through the curve: the frame's
// large-scale brightness (the base, B) is drawn toward mid grey while the detail about it is kept,
//   out = c ( B - M ) + d ( in - B ) + M
// in log2 luminance: `in` the pixel's, M mid grey (0.18 of the exposed image), c the contrast
// (above mid grey and below it apart: `high`, `low`), d the detail.
// The base is 40 % the bilateral grid's value at the pixel and 60 % a wide Gaussian blur of the
// frame (B-spline upsampled), as Patry blends them: the grid alone rings on smooth gradients (clouds,
// soft shadows, highlights), the blur alone haloes at edges.
// Four passes, every target of a fixed size, so the dynamic resolution never rebuilds them:
// - `luma`: the exposed image's log2 luminance (over M) at LUMA (eight by eight samples a grid
//   cell), a bilinear tap a sample, a 2x2 block of them in a texel (PACK);
// - `grid`: the grid, GRID cells over the frame by GRID.depth slices of log luminance (RANGE, the
//   ends clamped), as homogeneous ( w V, w ) in an atlas of the slices stacked in rows, with one
//   slice more, the cells' plain means ( V, 1 ), for the wide blur. Each cell gathers its tile's
//   samples, each weighted by a Gaussian of its distance from the slice (RANGE_SIGMA): the grid's
//   blur along its luminance axis, done in the gather;
// - `gridX`, `gridY`: the Gaussian blur across the cells (BLUR: narrower for the grid, Patry's
//   radius of 13 cells for the wide slice), a separable pair, within each slice;
// - and in the grade (Pipeline.ts), `apply`: the grid read at the pixel and its own luminance
//   (two bilinear taps, the slices on either side), divided out, and the wide slice read by a
//   cubic B-spline (four bilinear taps).
// The weights are kept normalised (a tile's weights sum to one over its slices), so the half-float
// sums hold their precision.
// It reads nothing from an earlier frame: a function of the frame, so a paused frame repeats.

const GRID = { width: 64, height: 32, depth: 64 };
const TILE = 8;
const LUMA = { width: GRID.width * TILE, height: GRID.height * TILE };
// the luma target packs a 2x2 block of samples in a texel's channels (x, y, z, w: the block's
// top left, top right, bottom left, bottom right), so a cell takes its tile's 64 samples in 16
// loads and the luma pass reads neighbouring pixels together
const PACK = 2;
// the atlas: the slices, then the wide slice, each GRID.height rows
const ATLAS = { width: GRID.width, height: GRID.height * ( GRID.depth + 1 ) };
// mid grey of the exposed image (the grade's input, before the curve's own exposure)
const MID = Math.log2( 0.18 );
// the slices' range, in stops about mid grey, and their spacing
const RANGE = { low: - 10, high: 6 };
const SLICE = ( RANGE.high - RANGE.low ) / ( GRID.depth - 1 );
// the grid's blur along its luminance axis (stops): wide enough that the meadow's and the sea's
// texture fall in one base with their surroundings, narrow enough to part the sea from the land
const RANGE_SIGMA = 0.5;
// the blurs across the cells (sigma in cells; taps out to `radius` either side)
const BLUR = { grid: 1.5, wide: 13 / 3, radius: 13 };
// the bilateral share of the base
const BILATERAL = 0.4;
// a pixel whose luminance the grid holds nowhere near it is its own base
const EMPTY = 1e-3;

/** The contrast above and below mid grey, and the detail. The contrasts are Patry's typical
 * in-game settings (75 % high contrast, 100 % low contrast); detail 1 keeps the detail as it is. */
export const LOCAL_TONE = { high: 0.75, low: 1, detail: 1 } as const;

export class LocalTone {

	readonly uniforms = { high: uniform( LOCAL_TONE.high ), low: uniform( LOCAL_TONE.low ), detail: uniform( LOCAL_TONE.detail ) };
	private luma: ResourceHandle;
	private grid: ResourceHandle;
	private gridX: ResourceHandle;
	private gridXY: ResourceHandle;
	private readonly quads: THREE.QuadMesh[];
	private readonly tGrid: THREE.TextureNode;

	/** `source`: the image the grade takes (scene radiance); `exposure` scales it to the exposed
	 * image. The targets are declared on `graph`. */
	constructor( graph: GraphResources, source: THREE.TextureNode, exposure: F ) {

		const target = ( name: string, width: number, height: number, format: THREE.PixelFormat ) =>
			graph.color( name, { size: { of: 'fixed', width, height }, format, type: THREE.HalfFloatType } );
		this.luma = target( 'localTone.luma', LUMA.width / PACK, LUMA.height / PACK, THREE.RGBAFormat );
		this.grid = target( 'localTone.grid', ATLAS.width, ATLAS.height, THREE.RGFormat );
		this.gridX = target( 'localTone.gridX', ATLAS.width, ATLAS.height, THREE.RGFormat );
		this.gridXY = target( 'localTone.gridXY', ATLAS.width, ATLAS.height, THREE.RGFormat );
		this.tGrid = texture( graph.texture( this.gridXY ) );
		this.quads = [
			quad( 'LocalTone.Luma', lumaPass( source, exposure ) ),
			quad( 'LocalTone.Grid', gridPass( graph.texture( this.luma ) ) ),
			quad( 'LocalTone.GridX', blurPass( graph.texture( this.grid ), 0 ) ),
			quad( 'LocalTone.GridY', blurPass( graph.texture( this.gridX ), 1 ) ),
		];

	}

	/** Adds the passes to `graph` (the first one's reads of the source declared by `reads`). Returns
	 * the grid's version the grade reads. */
	passes<Frame>( graph: FrameGraph<Frame>, reads: ( b: PassBuilder ) => void ): ResourceHandle {

		const [ lumaQuad, gridQuad, xQuad, yQuad ] = this.quads;
		graph.addPass( 'localToneLuma', 'quad', ( b ) => {

			reads( b );
			this.luma = b.write( this.luma );
			return { label: 'local tone luma', quad: lumaQuad };

		} );
		graph.addPass( 'localToneGrid', 'quad', ( b ) => {

			b.read( this.luma );
			this.grid = b.write( this.grid );
			return { label: 'local tone grid', quad: gridQuad };

		} );
		graph.addPass( 'localToneGridX', 'quad', ( b ) => {

			b.read( this.grid );
			this.gridX = b.write( this.gridX );
			return { label: 'local tone blur', quad: xQuad };

		} );
		graph.addPass( 'localToneGridY', 'quad', ( b ) => {

			b.read( this.gridX );
			this.gridXY = b.write( this.gridXY );
			return { label: 'local tone blur', quad: yQuad };

		} );
		return this.gridXY;

	}

	/** The exposed colour `c` at screen uv `at`, locally tone mapped. Explicit levels only, so it may
	 * run inside branches. */
	apply( c: V3, at: V2 ): V3 {

		const u = this.uniforms;
		const v = log2( max( luminance( c ), 2 ** - 24 ) ).sub( MID ).toVar();
		// the grid at the pixel's own luminance: the two slices about it, bilinear in each
		const zf = clamp( v, RANGE.low, RANGE.high ).sub( RANGE.low ).div( SLICE ).toVar();
		const z0 = min( floor( zf ), GRID.depth - 2 ).toVar();
		const row = clamp( at.y.mul( GRID.height ), 0.5, GRID.height - 0.5 ).toVar();
		const slice = ( z: F ): V2 => ( this.tGrid.sample( vec2( at.x, z.mul( GRID.height ).add( row ).div( ATLAS.height ) ) ).level( float( 0 ) ) as unknown as V4 ).xy;
		const g = mix( slice( z0 ), slice( z0.add( 1 ) ), zf.sub( z0 ) ).toVar();
		const bilateral = g.x.add( v.mul( EMPTY ) ).div( g.y.add( EMPTY ) );
		const wide = this.wide( at );
		const base = mix( wide, bilateral, BILATERAL ).toVar();
		const contrast = select( base.greaterThan( 0 ), u.high, u.low );
		const out = base.mul( contrast ).add( v.sub( base ).mul( u.detail ) );
		return c.mul( exp2( out.sub( v ) ) );

	}

	// the wide slice at screen uv `at`: a cubic B-spline over its cells, four bilinear taps (rows
	// kept inside the slice)
	private wide( at: V2 ): F {

		const size = vec2( GRID.width, GRID.height );
		const st = at.mul( size ).sub( 0.5 ).toVar();
		const i = floor( st ).toVar();
		const f = st.sub( i ).toVar();
		const f2 = f.mul( f ), f3 = f2.mul( f );
		const w0 = float( 1 ).sub( f ).pow( 3 ).div( 6 );
		const w1 = f3.mul( 3 ).sub( f2.mul( 6 ) ).add( 4 ).div( 6 );
		const w2 = f3.mul( - 3 ).add( f2.mul( 3 ) ).add( f.mul( 3 ) ).add( 1 ).div( 6 );
		const w3 = f3.div( 6 );
		const g0 = w0.add( w1 ).toVar(), g1 = w2.add( w3 ).toVar();
		// the taps' positions, in cells (centres at + 0.5)
		const p0 = i.sub( 0.5 ).add( w1.div( g0 ) ).toVar();
		const p1 = i.add( 1.5 ).add( w3.div( g1 ) ).toVar();
		const top = GRID.depth * GRID.height;
		const tap = ( x: F, y: F ): V2 => ( this.tGrid.sample( vec2(
			clamp( x, 0.5, GRID.width - 0.5 ).div( GRID.width ),
			clamp( y, 0.5, GRID.height - 0.5 ).add( top ).div( ATLAS.height ),
		) ).level( float( 0 ) ) as unknown as V4 ).xy;
		const s = tap( p0.x, p0.y ).mul( g0.x.mul( g0.y ) )
			.add( tap( p1.x, p0.y ).mul( g1.x.mul( g0.y ) ) )
			.add( tap( p0.x, p1.y ).mul( g0.x.mul( g1.y ) ) )
			.add( tap( p1.x, p1.y ).mul( g1.x.mul( g1.y ) ) ).toVar();
		return s.x.div( max( s.y, 1e-6 ) );

	}

}

function quad( name: string, fragment: V4 ): THREE.QuadMesh {

	const material = new THREE.NodeMaterial();
	material.name = name;
	material.fragmentNode = fragment;
	const mesh = new THREE.QuadMesh( material );
	mesh.name = name;
	return mesh;

}

// the exposed log2 luminance over mid grey, at LUMA, a 2x2 block a texel (PACK): one bilinear tap
// a sample (a cell's 64 samples are averaged and blurred, so a sparser footprint shows nowhere)
function lumaPass( source: THREE.TextureNode, exposure: F ): V4 {

	return Fn( () => {

		const p = floor( screenCoordinate.xy ).toVar();
		const sample = ( x: number, y: number ): F => {

			const at = vec2( p.x.mul( PACK ).add( x + 0.5 ).div( LUMA.width ), p.y.mul( PACK ).add( y + 0.5 ).div( LUMA.height ) );
			const l = luminance( source.sample( at ).rgb ).mul( exposure );
			return log2( max( l, 2 ** - 24 ) ).sub( MID );

		};
		return vec4( sample( 0, 0 ), sample( 1, 0 ), sample( 0, 1 ), sample( 1, 1 ) );

	} )() as unknown as V4;

}

// a cell of the atlas from its tile's samples (see the header)
function gridPass( luma: THREE.Texture ): V4 {

	return Fn( () => {

		const p = ivec2( screenCoordinate.xy ).toVar();
		const z = p.y.div( int( GRID.height ) ).toVar();
		const tile = ivec2( p.x, p.y.sub( z.mul( int( GRID.height ) ) ) ).mul( int( TILE / PACK ) ).toVar();
		const wide = z.equal( int( GRID.depth ) ).toVar();
		const sum = vec2( 0 ).toVar();
		const k = - 0.5 * ( SLICE / RANGE_SIGMA ) ** 2;
		Loop( { start: int( 0 ), end: int( TILE / PACK ), type: 'int' }, { start: int( 0 ), end: int( TILE / PACK ), type: 'int' }, ( { i, j } ) => {

			const four = ( textureLoad( luma, tile.add( ivec2( j, i ) ) ) as unknown as V4 ).toVar();
			for ( const c of [ 'x', 'y', 'z', 'w' ] as const ) {

				const v = four[ c ];
				const t = clamp( v, RANGE.low, RANGE.high ).sub( RANGE.low ).div( SLICE ).sub( float( z ) );
				const w = select( wide, float( 1 ), exp( t.mul( t ).mul( k ) ) );
				sum.addAssign( vec2( v.mul( w ), w ) );

			}

		} );
		// a tile's weights over all its slices sum to about TILE^2 times the kernel's sum
		const norm = Math.sqrt( 2 * Math.PI ) * RANGE_SIGMA / SLICE;
		return vec4( sum.div( select( wide, float( TILE * TILE ), float( TILE * TILE * norm ) ) ), 0, 1 );

	} )() as unknown as V4;

}

// the Gaussian across the cells along one axis (0: x, 1: y), within each slice: the taps unrolled
// with constant weights, the wide slice's or the grid's
function blurPass( source: THREE.Texture, axis: 0 | 1 ): V4 {

	const weights = ( sigma: number ) => {

		const w = Array.from( { length: 2 * BLUR.radius + 1 }, ( _, i ) => Math.exp( - 0.5 * ( ( i - BLUR.radius ) / sigma ) ** 2 ) );
		const sum = w.reduce( ( a, b ) => a + b );
		return w.map( ( x ) => x / sum );

	};
	const grid = weights( BLUR.grid ), wide = weights( BLUR.wide );
	return Fn( () => {

		const p = ivec2( screenCoordinate.xy ).toVar();
		const z = p.y.div( int( GRID.height ) ).toVar();
		const y = p.y.sub( z.mul( int( GRID.height ) ) ).toVar();
		const isWide = z.equal( int( GRID.depth ) ).toVar();
		const along = ( axis === 0 ? p.x : y ).toVar();
		const length = axis === 0 ? GRID.width : GRID.height;
		const sum = vec2( 0 ).toVar();
		for ( let i = - BLUR.radius; i <= BLUR.radius; i ++ ) {

			const k = i + BLUR.radius;
			// (taps outside the slice hold nothing: the homogeneous sums renormalise themselves)
			const q = along.add( int( i ) );
			const inside = q.greaterThanEqual( int( 0 ) ).and( q.lessThan( int( length ) ) );
			// (clamp on an int: TSL's typings take floats only)
			const c = clamp( q as unknown as F, int( 0 ) as unknown as F, int( length - 1 ) as unknown as F ) as unknown as THREE.Node<'int'>;
			const at = axis === 0 ? ivec2( c, p.y ) : ivec2( p.x, c.add( z.mul( int( GRID.height ) ) ) );
			const w = select( isWide, float( wide[ k ] ), float( grid[ k ] ) );
			sum.addAssign( ( textureLoad( source, at ) as unknown as V4 ).xy.mul( select( inside, w, float( 0 ) ) ) );

		}
		return vec4( sum, 0, 1 );

	} )() as unknown as V4;

}
