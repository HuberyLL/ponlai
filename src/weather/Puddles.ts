import type * as THREE from 'three/webgpu';
import { Fn, float, mix, smoothstep, vec3, mx_noise_float } from 'three/tsl';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;

/** Standing water on level ground, 0 to 1. Puddles fill the hollows of a fixed field as the
 * ground soaks, grow while rain keeps it wet and shrink as it dries, so they always reappear in
 * the same places. `wetness` is the weather's persistent surface moisture. */
export const puddleCover = Fn( ( [ xz, wetness ]: [ V2, F ] ) => {

	const hollows = mx_noise_float( vec3( xz.div( 3.2 ), 0.37 ) ).mul( 0.7 )
		.add( mx_noise_float( vec3( xz.div( 1.1 ), 4.1 ) ).mul( 0.3 ) ).mul( 0.5 ).add( 0.5 );
	// No standing water until the ground is soaked; then the waterline rises through the field.
	const level = mix( float( 0.82 ), float( 0.58 ), smoothstep( 0.35, 1, wetness ) );
	return smoothstep( level, level.add( 0.06 ), hollows ).mul( smoothstep( 0.3, 0.45, wetness ) );

} ).setLayout( { name: 'soomiPuddleCover', type: 'float', inputs: [ { name: 'xz', type: 'vec2' }, { name: 'wetness', type: 'float' } ] } );
