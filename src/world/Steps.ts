import * as THREE from 'three/webgpu';

// Typed arrays from long plain arrays a slice at a time, for builders that run as generators (the
// growth's idle-time steps, Growth.ts): the same values as the one-shot conversions three makes
// (`Float32BufferAttribute`, `setIndex` with an array).

const SLICE = 1 << 16;

/** `new Float32Array( values )` in steps. */
export function* float32Steps( values: readonly number[] ): Generator<void, Float32Array> {

	const out = new Float32Array( values.length );
	for ( let k = 0; k < values.length; k += SLICE ) {

		for ( let i = k, end = Math.min( k + SLICE, values.length ); i < end; i ++ ) out[ i ] = values[ i ];
		yield;

	}
	return out;

}

/** The index three's `setIndex( array )` makes (16-bit unless a value needs 32), in steps. */
export function* indexSteps( values: readonly number[] ): Generator<void, THREE.BufferAttribute> {

	// (three's arrayNeedsUint32)
	let wide = false;
	for ( let i = values.length - 1; i >= 0; -- i ) if ( values[ i ] >= 65535 ) { wide = true; break; }
	const out = wide ? new Uint32Array( values.length ) : new Uint16Array( values.length );
	for ( let k = 0; k < values.length; k += SLICE ) {

		for ( let i = k, end = Math.min( k + SLICE, values.length ); i < end; i ++ ) out[ i ] = values[ i ];
		yield;

	}
	return new THREE.BufferAttribute( out, 1 );

}
