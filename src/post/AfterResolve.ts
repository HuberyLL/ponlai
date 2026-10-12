import * as THREE from 'three/webgpu';
import {
	abs, cameraProjectionMatrix, clamp, floor, float, int, ivec2, length, max, min, mix, mrt, output, positionView,
	screenCoordinate, screenSize, smoothstep, texture, textureLoad, textureSize, uniform, varying, vec2, vec4,
} from 'three/tsl';
import { jitter } from './Jitter.ts';

// Rain after the resolve (Antialiasing.ts `AFTER_RESOLVE`: aa=taa|taau). The rain's streaks, its
// splashes, its veil and the storm's spray are thin, fast or brief, and translucent: drawn into the jittered frame they leave
// no motion of their own a history can follow, so the resolve either kept its history under them
// (they faded and trailed) or, told by a reactive mask, took them from one jittered frame (the faint
// distant streaks vanished and the near ones broke into dashes). Under the temporal modes they are
// drawn after the resolve instead, at the canvas's resolution and unjittered, as engines draw
// translucency after their temporal upscaler (Unreal's after-motion-blur translucency): every frame
// shows each streak whole, at output pixels. MSAA keeps its rain as it was, and the ground truth
// (aa=gt) keeps it before its resolve, the supersampled image the streaks are measured against.
//
// - The pass (`rainAfter`, Pipeline.ts): after the resolve's passes, at the canvas's size,
//   unjittered, a scene pass that draws the streaks, splashes and rings and the spray into `rainOverlay` (RGBA16F,
//   cleared to zero through its MRT, `afterMRT`): premultiplied scene radiance in rgb and their
//   coverage in alpha, as each material blends. It has no depth buffer. One sample a pixel and
//   nothing averaging it: the streaks are prefiltered (RainDrops.ts: widened to their profile
//   convolved with a pixel, faded by the ratio), as is the veil (at least 0.8 of a pixel
//   half-wide).
// - Occlusion: the scene's nearest surface (`surfaceDepth`, the sea's included) is at the render's
//   size and was drawn jittered. A fragment finds the four render texels around the point it shows
//   (its canvas position scaled to the render, less this frame's jitter, so the texels line up with
//   the resolved image: `afterTexels`) and tests its depth against each; the tests are weighted
//   bilinearly (`afterResolveCover`). An edge then covers a streak by a fraction over about a render
//   pixel, as the resolve antialiased the edge itself, rather than in the render's steps; a streak
//   in front of both sides is untouched.
// - Depth of field: the display pass mixes the tilt-shift blur over the sharp image by the circle of
//   confusion of what lies at the pixel, so a streak drawn before it kept only (1 - that weight) of
//   its sharp self over a blurred background and spread the rest into a faint haze along it. The
//   same weight fades it here, taken over the blur's footprint at each vertex (`afterSharpness`), so
//   it fades evenly along a streak as the blur spread it (the haze itself is left out). Per
//   fragment, at its own texels and four more, the pass cost twice as much. The drops' own widening
//   by their distance stays (RainDrops.ts).
// - Air, fog and shafts: the composite is affine in the scene colour at each pixel,
//   hdr = A scene + B (A the air's transmittance; B the light the air, fog and shafts add). Under
//   AFTER_RESOLVE the composite writes A (`rainAir`, R16F at the render's size, in place of
//   veilReactive: the same cost in fair weather) and no veil; B is the grade's input less A times
//   the scene colour, so a streak takes the air of what lies behind it, as it did drawn into the
//   scene before the composite.
// - The veil (Rain.veil): evaluated at the canvas pixel's unjittered ray (interpolated from the
//   pass's vertices), in front of what lies at the render texel nearest the point it shows, as the
//   composite laid it over the air (the shafts the composite added over it now lie under it); the
//   rest of a shell's work only where a streak may show. Evaluated in the composite instead, along
//   the render texels' unjittered rays and read bilinearly, it cost as much at equal sizes and,
//   below the canvas, lost its faint streaks against the ground truth (ghosting 1.5 x MSAA's, from
//   0.2 x).
// - Grade: a pass at the canvas's size (`rainLayer`, Pipeline.ts), while it rains or the overlay
//   holds something, draws the change the rain makes to the graded colour, which the canvas pass
//   adds after RCAS and before the grain (TemporalAA.ts `layer`). At the render texel nearest the
//   point the pixel shows, the display pass's grade input (the sharp image, its depth of field and
//   the look's glow) is evaluated again; the veil, then the overlay, are laid over it in scene
//   radiance, as they were before the grade, and that goes through the display pass's grade
//   (exposure, curve, grade, look, in linear light); the change is its difference from what the
//   display pass graded at the texel, which it reads (one grade a pixel: grading the input too cost
//   a third of the pass). The change is added to the resolved image decoded to linear light (the
//   S-curve and the sRGB transfer undone, on changed pixels only), which is encoded again; the
//   vignette applies to it as to the image. It is taken at the rain's coverage of a single sample
//   (Pipeline.ts AFTER_COVERAGE) and spread over the pixel, as a supersampled image grades each
//   sample before it averages them. Laid over the graded image instead, faint rain over the dark
//   sea and meadow, in the curve's toe, came out brighter and harder (the rings on the sea most);
//   laid over it before the grade at its full coverage, thin streaks came out fainter than the
//   ground truth's. (In the canvas pass itself the rain's work held so many registers that the
//   whole pass slowed.) The depth of field's blur, bloom and the look's glow of the rain are left
//   out.
// - At rest (TemporalRest.ts): the passes draw over the frame's own jitter and jittered depth, and
//   once the rest has converged the jitter runs on through the running sequence, whose place
//   depends on the frames rendered. So while the rest holds its image neither pass runs: the
//   overlay and the layer the completing frame drew (at the rest sequence's last jitter) stay, and a
//   paused frame's rain repeats however it was reached (Pipeline.ts `afterHeld`).
// - Nothing of the rain stays before the resolve: the overlay pass does not run, no rain or spray
//   writes a velocity or a reactive weight, and there is no `veilReactive`. The splashes stayed there
//   at first, on the surfaces they lie on, with their reactive weight: a glint of a few frames, they
//   still lost most of themselves to the history (the storm's remaining ghosting, against the
//   ground truth, was theirs).

type F = THREE.Node<'float'>;
type IV2 = THREE.Node<'ivec2'>;

/** The overlay's resource name (the MRT finds its output by it). */
export const RAIN_OVERLAY = 'rainOverlay';

/** The display pass's depth of field, as the after pass's materials fade by it (Pipeline sets them
 * every frame): the focus distance and sharp range (m), the blur's strength, and its widest radius
 * (render pixels). */
export const afterFocus = { focus: uniform( 50 ), range: uniform( 8 ), dof: uniform( 0.65 ), radius: uniform( 6 ) };

/** The after pass's MRT: the overlay, cleared to zero, blended as each material says. */
export const afterMRT: THREE.MRTNode = mrt( { [ RAIN_OVERLAY ]: output } )
	.setBlendMode( RAIN_OVERLAY, new THREE.BlendMode( THREE.MaterialBlending ) )
	.setClearColor( RAIN_OVERLAY, new THREE.Color( 0, 0, 0 ), 0 );

/** The four render texels around the point a canvas pixel shows, and their bilinear weights: the
 * pixel's centre scaled to the render (`renderSize`, over `outputSize`), less this frame's jitter
 * (a texel's centre shows the unjittered point a jitter's offset from it). */
export function afterTexels( renderSize: THREE.Node<'vec2'>, outputSize: THREE.Node<'vec2'> = screenSize ): { texel: IV2; weight: F }[] {

	const t = screenCoordinate.xy.mul( renderSize.div( outputSize ) ).sub( jitter.uniforms.px ).sub( 0.5 ).toVar();
	const base = floor( t ).toVar();
	const f = t.sub( base ).toVar();
	const last = renderSize.sub( 1 );
	return [ [ 0, 0 ], [ 1, 0 ], [ 0, 1 ], [ 1, 1 ] ].map( ( [ x, y ] ) => ( {
		texel: ivec2( clamp( base.add( vec2( x, y ) ), vec2( 0 ), last ) ),
		weight: ( x ? f.x : float( 1 ).sub( f.x ) ).mul( y ? f.y : float( 1 ).sub( f.y ) ) as F,
	} ) );

}

/** In a material of the after pass: how much of the fragment shows, from the scene's nearest
 * surface (`surfaceDepth`, linear view z at the render's size). `visible` tests one render texel
 * (its coordinate and its nearest surface's view z); the four tests are weighted bilinearly and
 * faded by `afterSharpness`. */
export function afterResolveCover( surfaceDepth: THREE.Texture, visible: ( texel: IV2, surfaceZ: F ) => F ): F {

	const depth = texture( surfaceDepth );
	const size = vec2( textureSize( depth, int( 0 ) ) as unknown as IV2 );
	let cover: F = float( 0 );
	for ( const { texel, weight } of afterTexels( size ) ) cover = cover.add( visible( texel, textureLoad( depth, texel ) as unknown as F ).mul( weight ) ) as F;
	return max( cover, 0 ).mul( afterSharpness( surfaceDepth ) );

}

/** What of a fragment of the after pass the depth of field leaves sharp: one less the display
 * pass's blur weight (`afterFocus`) over the blur's footprint around the point, the mean of the
 * weight there and at four points half the widest blur away, diagonally. Taken per vertex (a
 * varying): a fragment's own texels made a near streak in front of leaves against the blurred sea
 * fade leaf by leaf into dashes, where the blur the display pass gave it spread it evenly along its
 * length; and at the vertices it costs a fraction of what it cost per fragment. */
export function afterSharpness( surfaceDepth: THREE.Texture ): F {

	const depth = texture( surfaceDepth );
	const size = vec2( textureSize( depth, int( 0 ) ) as unknown as IV2 );
	// (in the vertex stage: the point's unjittered screen position, less this frame's jitter, in render
	// pixels; and the distance to a surface at view z `z` along its ray)
	const clip = cameraProjectionMatrix.mul( vec4( positionView, 1 ) );
	const ndc = clip.xy.div( max( clip.w, 1e-4 ) );
	const at = vec2( ndc.x.mul( 0.5 ).add( 0.5 ), float( 0.5 ).sub( ndc.y.mul( 0.5 ) ) ).mul( size ).sub( jitter.uniforms.px );
	const ray = length( positionView ).div( min( positionView.z, - 1e-4 ) );
	const reach = afterFocus.radius.mul( 0.5 );
	let blur: F = float( 0 );
	for ( const [ x, y ] of [ [ 0, 0 ], [ 1, 1 ], [ - 1, 1 ], [ 1, - 1 ], [ - 1, - 1 ] ] ) {

		const texel = ivec2( clamp( at.add( vec2( x, y ).mul( reach ) ), vec2( 0 ), size.sub( 1 ) ) );
		const distance = ( textureLoad( depth, texel ) as unknown as F ).mul( ray );
		// the display pass's circle of confusion and its blur's weight (Pipeline.ts cocAt, dofMix)
		const far = mix( float( 1 ), float( 0.15 ), smoothstep( 1500, 15000, distance ) );
		const coc = clamp( abs( distance.sub( afterFocus.focus ) ).sub( afterFocus.range ).div( afterFocus.focus.mul( 0.55 ) ), 0, 1 ).mul( far );
		blur = blur.add( smoothstep( 0, 0.35, coc ).mul( afterFocus.dof ) ) as F;

	}
	return varying( float( 1 ).sub( blur.div( 5 ) ) );

}
