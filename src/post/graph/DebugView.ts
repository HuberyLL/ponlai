import * as THREE from 'three/webgpu';
import {
	Fn, abs, atan, clamp, float, floor, fract, int, ivec2, length, log2, max, min, neutralToneMapping, screenCoordinate,
	sRGBTransferOETF, select, texture, textureLoad, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { FrameGraph, type GraphDescription } from './FrameGraph.ts';
import type { ResourceDecl, ResourceHandle } from './GraphCompiler.ts';

// The frame graph's debug view (debug and dev builds): `fgview=<resource>[.<output>]` shows one of
// the graph's resources on the canvas in place of the frame. Only when the URL asks for it, it
// appends a pass to the graph before the graph compiles (`FrameGraph.beforeCompile`): the pass
// reads the resource (marked as the debug view, so the graph keeps it live and stored) and draws it
// over the whole canvas after the canvas passes, so what it shows is exactly what the frame's own
// passes left there, the canvas output's input (`display`) and the upscale's (`FSR.easu`)
// included. Its shader is built only then; without the option nothing is declared, compiled or
// drawn, and the frame is the same to the byte. The graph compiles once, so another choice (the
// Debug folder's dropdown, filled from `describe()`) reloads the page with it.
//
// How a resource is shown follows what it holds:
//   hdr       scene radiance (the scene colour, the opaque copy, the fog's in-scatter): the
//             grade's exposure and PBR Neutral's curve, then the sRGB encoding
//   display   display values (the graded image, the upscale's EASU image): as they are
//   depth     a depth buffer, its sample 0 when multisampled (`.sample<n>` picks another): turned
//             into view z with the frame's camera, then
//   viewZ     a linear view z or distance (`linearDepth`, `surfaceDepth`, the fog's nearest depth,
//             the blur's distances): grey on a log scale from 0.5 m (black) to 2 km (white; the
//             sky and the far sea too)
//   velocity  a motion vector (NDC delta): its direction as a hue, its length (in render pixels,
//             full at 16) as the brightness
//   single    one channel (a red format, or the `.r` / `.g` / `.b` / `.a` output): grey, clamped
//   history   a persistent or ping-pong colour (`.previous`: the ping-pong's previous texture): as
//             colour, clamped
// Every texel is loaded, not filtered, at the resource's own size stretched over the canvas. The
// legacy attachment ops (`fgOps=legacy`) discard the scene target's samples in the rain pass
// whatever reads them, so a view of `sceneDepth` while it rains needs the derived ops.

export type DebugViewKind = 'hdr' | 'display' | 'depth' | 'viewZ' | 'velocity' | 'single' | 'history' | 'colour';

export interface DebugViewRequest { resource: string; output: string | null }

export interface DebugViewOptions {
	// the grade's exposure on scene radiance (the HDR view's)
	exposure(): number;
}

// resources that hold display values rather than scene radiance
const DISPLAY_REFERRED = new Set( [ 'display', 'FSR.easu' ] );
const CHANNELS = [ 'r', 'g', 'b', 'a' ];
// the log scale of the depth views, in metres (the island and its sea span about 1 m to 1 km)
const NEAR = 0.5, FAR = 2000;
// velocity at full brightness, in render pixels
const VELOCITY_FULL = 16;

/** `fgview` from the URL (null: none). */
export function debugViewFromURL( search: string = location.search ): string | null {

	const value = new URLSearchParams( search ).get( 'fgview' );
	return value && value !== 'off' ? value : null;

}

/** Splits `fgview`'s value into a resource of `names` and an output: the whole value when it names
 * a resource (names may hold dots, `FSR.easu`), else the part before the last dot. */
export function parseDebugView( value: string, names: readonly string[] ): DebugViewRequest | null {

	if ( names.includes( value ) ) return { resource: value, output: null };
	const dot = value.lastIndexOf( '.' );
	if ( dot > 0 && names.includes( value.slice( 0, dot ) ) ) return { resource: value.slice( 0, dot ), output: value.slice( dot + 1 ) };
	return null;

}

function kindOf( r: ResourceDecl, output: string | null ): DebugViewKind {

	const viewZ = /depth|distance/i.test( r.name ) && r.kind !== 'depth';
	if ( output && CHANNELS.includes( output ) ) return viewZ ? 'viewZ' : 'single';
	if ( r.kind === 'depth' ) return 'depth';
	if ( /velocity/i.test( r.name ) ) return 'velocity';
	if ( DISPLAY_REFERRED.has( r.name ) ) return 'display';
	if ( viewZ ) return 'viewZ';
	if ( r.desc.format === THREE.RedFormat ) return 'single';
	if ( r.persistent || r.pingPong ) return 'history';
	if ( r.desc.type === THREE.HalfFloatType || r.desc.type === THREE.FloatType ) return 'hdr';
	return 'colour';

}

/** The choices the Debug folder offers for a graph: every resource but the canvas, plus the
 * channels worth a look of their own (a two-channel resource's second channel, an HDR colour's
 * alpha). */
export function debugViewChoices( d: GraphDescription ): string[] {

	const choices: string[] = [];
	for ( const r of d.resources ) {

		if ( r.canvas ) continue;
		choices.push( r.name );
		if ( r.kind !== 'color' || DISPLAY_REFERRED.has( r.name ) ) continue;
		if ( r.format === 'RG' ) choices.push( `${ r.name }.g` );
		else if ( r.format === 'RGBA' && ( r.type === 'HalfFloat' || r.type === 'Float' ) ) choices.push( `${ r.name }.a` );

	}
	return choices;

}

/** Appends the debug view of `value` (`<resource>[.<output>]`) to the next graph compiled. */
export function installDebugView( value: string, options: DebugViewOptions ): void {

	const extend = ( graph: FrameGraph<unknown> ) => {

		FrameGraph.beforeCompile = FrameGraph.beforeCompile.filter( ( e ) => e !== extend );
		try {

			declareDebugView( graph, value, options );

		} catch ( error ) {

			console.warn( `fgview=${ value }: ${ ( error as Error ).message }` );

		}

	};
	FrameGraph.beforeCompile.push( extend );

}

function declareDebugView( graph: FrameGraph<unknown>, value: string, options: DebugViewOptions ): void {

	const decl = graph.decl;
	const names = decl.resources.filter( ( r ) => ! r.canvas ).map( ( r ) => r.name );
	const request = parseDebugView( value, names );
	if ( ! request ) throw new Error( `no such resource (the graph has ${ names.join( ', ' ) })` );
	const r = decl.resources.find( ( x ) => x.name === request.resource )!;
	const canvas = decl.resources.find( ( x ) => x.canvas );
	if ( ! canvas ) throw new Error( 'the graph draws no canvas' );
	const output = request.output;
	const sampleIndex = output && /^sample\d+$/.test( output ) ? Number( output.slice( 6 ) ) : 0;
	if ( output && ! CHANNELS.includes( output ) && output !== 'previous' && ! ( r.kind === 'depth' && /^sample\d+$/.test( output ) ) ) {

		throw new Error( `unknown output '${ output }' (r, g, b, a, previous, or sample<n> of a depth)` );

	}
	if ( output === 'previous' && ! r.pingPong ) throw new Error( `'${ r.name }' keeps no previous texture` );
	const handle: ResourceHandle = output === 'previous'
		? { resource: r.id, version: - 1, name: r.name, previous: true }
		: { resource: r.id, version: r.latest, name: r.name };
	const kind = kindOf( r, output );

	// the texel under each canvas pixel, at the resource's own size
	const size = graph.extent( r.desc.size );
	const canvasSize = graph.extent( { of: 'canvas' } );
	const node = texture( graph.texture( handle ) );
	const coord = ivec2( clamp( floor( screenCoordinate.xy.mul( size ).div( canvasSize ) ), vec2( 0 ), size.sub( 1 ) ) );
	const exposure = uniform( 1 );
	const projInv = uniform( new THREE.Matrix4() );
	const toViewZ = ( d: THREE.Node<'float'> ) => {

		const v = projInv.mul( vec4( 0, 0, d, 1 ) );
		return select( d.lessThan( 0.999999 ), v.z.div( v.w ), float( - 1e5 ) );

	};
	const logDepth = ( z: THREE.Node<'float'> ) => clamp( log2( max( abs( z ), NEAR ).div( NEAR ) ).div( Math.log2( FAR / NEAR ) ), 0, 1 );
	const channel = output && CHANNELS.includes( output ) ? output : 'r';

	const shown = Fn( () => {

		if ( kind === 'depth' ) {

			const d = ( textureLoad( node, coord, int( sampleIndex ) ) as unknown as THREE.Node<'vec4'> ).x;
			return vec3( logDepth( toViewZ( d ) ) );

		}
		const t = textureLoad( node, coord ) as unknown as THREE.Node<'vec4'>;
		const c = ( t as unknown as Record<string, THREE.Node<'float'>> )[ channel ];
		switch ( kind ) {

			case 'viewZ': return vec3( logDepth( c ) );
			case 'single': return vec3( clamp( c, 0, 1 ) );
			case 'display': return t.rgb;
			case 'hdr': return sRGBTransferOETF( clamp( neutralToneMapping( t.rgb, exposure ) as THREE.Node<'vec3'>, 0, 1 ) );
			case 'velocity': {

				// hue from the direction (an HSV wheel at full saturation), brightness from the length
				const px = t.xy.mul( size ).mul( 0.5 );
				const h = fract( atan( px.y, px.x ).div( 2 * Math.PI ) );
				const wheel = clamp( abs( fract( vec3( h ).add( vec3( 1, 2 / 3, 1 / 3 ) ) ).mul( 6 ).sub( 3 ) ).sub( 1 ), 0, 1 );
				return wheel.mul( min( length( px ).div( VELOCITY_FULL ), 1 ) );

			}
			default: return clamp( t.rgb, 0, 1 );

		}

	} );
	const pipeline = new THREE.RenderPipeline( graph.renderer, vec4( shown() as THREE.Node<'vec3'>, 1 ) );
	pipeline.outputColorTransform = false;

	decl.setDebugView( handle );
	graph.addPass( 'debugView', 'chain', ( b ) => {

		b.readOptional( handle, kind === 'depth' ? 'samples' : 'sample' );
		b.write( { resource: canvas.id, version: canvas.latest, name: canvas.name } );
		return {
			label: 'debug view',
			pipeline,
			run: ( f, g ) => {

				exposure.value = options.exposure();
				const camera = ( f as { camera?: THREE.Camera } | undefined )?.camera;
				if ( camera ) projInv.value.copy( camera.projectionMatrixInverse );
				// a ping-pong resource's current (or previous) texture moves every frame
				if ( r.pingPong ) node.value = g.texture( handle );
				pipeline.render();

			},
		};

	} );

}
