import * as THREE from 'three/webgpu';
import { Fn, If, uniform, texture, textureLoad, uv, ivec2, vec3, vec4, float, max, clamp, length, normalize, exp, mix } from 'three/tsl';
import type { Sky } from '../sky/Sky.ts';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

/** Distant air over the completed opaque/water image. The protected foreground retains
 * the existing underwater transport; this pass never changes the refraction source. */
export class AerialPerspective {

	readonly haze = uniform( 0 );
	readonly clearDistance = uniform( 85 );
	private projectionInverse = uniform( new THREE.Matrix4() );
	private cameraWorld = uniform( new THREE.Matrix4() );
	private resolution = uniform( new THREE.Vector2( 1, 1 ) );

	apply( color: V3, depth: THREE.Texture, waterDepth: THREE.Texture, sky: Sky ): V3 {

		const sceneDepth = texture( depth ), surfaceDepth = texture( waterDepth );
		return Fn( () => {

			const q = uv().toVar();
			const px = ivec2( clamp( q.mul( this.resolution ), 0, this.resolution.sub( 1 ) ) );
			const z = ( textureLoad( sceneDepth, px ) as unknown as F ).toVar();
			const dw = ( textureLoad( surfaceDepth, px ) as unknown as F ).toVar();
			const ndc = vec3( q.x.mul( 2 ).sub( 1 ), float( 1 ).sub( q.y ).mul( 2 ).sub( 1 ), 1 ).toVar();
			const viewFar = this.projectionInverse.mul( vec4( ndc, 1 ) ).toVar();
			const ray = viewFar.xyz.div( viewFar.w ).toVar();
			const direction = normalize( this.cameraWorld.mul( vec4( normalize( ray ), 0 ) ).xyz ).toVar();
			const air = sky.sampleBackground( normalize( vec3( direction.x, 0.035, direction.z ) ), float( 3 ) ).toVar();
			If( dw.lessThan( 1 ), () => {

				const water = this.projectionInverse.mul( vec4( ndc.xy, dw, 1 ) ).toVar();
				z.assign( max( z, water.z.div( water.w ) ) );

			} );
			const amount = float( 0 ).toVar();
			If( z.greaterThan( - 1e4 ), () => {

				const distance = length( ray.mul( z.div( ray.z ) ) ).toVar();
				amount.assign( float( 1 ).sub( exp( max( distance.sub( this.clearDistance ), 0 ).mul( this.haze ).negate() ) ) );

			} );
			return mix( color, air, amount );

		} )();

	}

	update( camera: THREE.Camera, width: number, height: number ): void {

		this.projectionInverse.value.copy( ( camera as THREE.PerspectiveCamera ).projectionMatrixInverse );
		this.cameraWorld.value.copy( camera.matrixWorld );
		this.resolution.value.set( width, height );

	}

}
