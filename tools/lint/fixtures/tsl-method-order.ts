// Fixture for ponlai/tsl-method-order (tools/verify-lint.mjs): each line marked `reported` must be
// reported by that rule, and no other line. The method forms on TSL nodes are reported; the plain
// maths and our classes' simulation steps of the same names are not.
import * as THREE from 'three/webgpu';
import { Fn, float, mix, smoothstep, step, uniform, vec3 } from 'three/tsl';

const t = uniform( 0.5 ), edge = float( 0.2 ), colour = vec3( 1, 0, 0 );
export const wrongMix = colour.mix( vec3( 0 ), t ); // reported
export const wrongStep = t.step( edge ); // reported
export const wrongSmooth = t.smoothstep( 0.1, 0.9 ); // reported
export const inFn = Fn( ( [ a, b ]: [ THREE.Node<'float'>, THREE.Node<'float'> ] ) => a.mix( b, 0.5 ) ); // reported
export const untyped = Fn( ( [ a ] ) => a.smoothstep( 0, 1 ) ); // reported

// the function forms
export const rightMix = mix( colour, vec3( 0 ), t );
export const rightStep = step( edge, t );
export const rightSmooth = smoothstep( 0.1, 0.9, t );

// plain maths and simulation steps: not TSL
export const plain = THREE.MathUtils.smoothstep( 0.5, 0.1, 0.9 );
class Sim {

	ticks = 0;
	step( n: number ): void { this.ticks += n; }
	run(): void { this.step( 1 ); }

}
class Storm {

	spray = new Sim();
	update( dt: number ): void { this.spray.step( Math.round( dt ) ); }

}
export const storm = new Storm();
