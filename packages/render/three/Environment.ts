import type { PMREMGenerator, RenderTarget, Texture } from 'three/webgpu';
import { missing } from './Internals.ts';

// PMREMGenerator's own steps, driven one at a time so a bake's prefilter spreads over frames.
//
// PMREMGenerator's own steps (three r187), which a whole `fromEquirectangular` takes in one call
// (its `_fromTexture`), driven one at a time so a periodic bake's prefilter spreads over frames
// (sky/SkyBake.ts `environmentSlices`). The generator first draws the source into a cube of its
// own, with a mip chain (`_textureToCubemap`), then filters each level of the PMREM, a cube render
// target, from that cube alone (`_applyPMREM`), so the levels do not depend on each other. A level
// is drawn by running `_applyPMREM` with its `_renderCube` passing on only that level's draw: the
// loop sets the level's uniforms right before the draw, so the draw is the one a whole bake makes.
// Taken in its order and with its arguments, the PMREM comes out the same.
//
// The source cube is the generator's own between the steps: a caller must finish a spread bake
// before it starts another bake on the same generator.

type RenderCube = ( this: unknown, target: RenderTarget, lod: number, material: unknown ) => void;
type Steps = {
	_setSize( cubeSize: number ): void;
	_textureToCubemap( texture: Texture ): void;
	_applyPMREM( target: RenderTarget ): void;
	_renderCube: RenderCube;
};

/** A PMREM generator's bake of an environment into a PMREM it made before, as steps. */
export interface EnvironmentSteps {
	/** The equirectangular source drawn into the generator's source cube (its size taken from the
	 * source), from which every level is filtered. */
	convert( source: Texture ): void;
	/** The level count of `target` (a PMREM the generator made). */
	levels( target: RenderTarget ): number;
	/** Level `level` of `target` filtered from the source cube (one cube: six render passes). */
	filter( target: RenderTarget, level: number ): void;
}

/** `pmrem`'s steps; throws, naming the first one missing, on a three without them. */
export function environmentSteps( pmrem: PMREMGenerator ): EnvironmentSteps {

	const p = pmrem as unknown as Steps;
	const members: [ string, boolean ][] = [
		[ 'PMREMGenerator._setSize', typeof p._setSize === 'function' ],
		[ 'PMREMGenerator._textureToCubemap', typeof p._textureToCubemap === 'function' ],
		[ 'PMREMGenerator._applyPMREM', typeof p._applyPMREM === 'function' ],
		[ 'PMREMGenerator._renderCube', typeof p._renderCube === 'function' ],
	];
	for ( const [ entry, holds ] of members ) if ( ! holds ) throw missing( entry, 'environmentSteps (packages/render/three/Environment.ts)' );
	return {
		convert( source ) {

			// (`_fromTexture`'s equirectangular branch)
			p._setSize( ( source.image as { width: number } ).width / 4 );
			p._textureToCubemap( source );

		},
		levels: ( target ) => target.texture.mipmaps.length,
		filter( target, level ) {

			const own = Object.prototype.hasOwnProperty.call( p, '_renderCube' ) ? p._renderCube : null;
			const render = p._renderCube;
			p._renderCube = function ( this: unknown, cube, lod, material ) {

				if ( lod === level ) render.call( this, cube, lod, material );

			};
			try {

				p._applyPMREM( target );

			} finally {

				if ( own ) p._renderCube = own;
				else delete ( p as Partial<Steps> )._renderCube;

			}

		},
	};

}
