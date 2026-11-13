// tools/wgsl-build.mjs's entry for the night's drawing: the moon on the dome (packages/render/sky/NightSky.ts:
// its disk, the painted glow and the stars it hides, as the dome reads them), the flare and its
// visibility (packages/render/post/LightShafts.ts `flare`, `occlusion`: the sun's or the moon's, chosen by a
// uniform) with the rods' colour's retinal scale beside it in the post constants' texel, and the
// composite's rods' colour (packages/render/post/Purkinje.ts, its scale read as the composite reads it). The
// dome's stars, its sky and clouds, the bloom around the flare and the rest of the composite need
// the sky's data, the frame graph and the pipeline, which this entry does not build. The moon's maps never load in node: the disk samples two stand-in textures of their kind.

import * as THREE from 'three/webgpu';
import { Fn, float, ivec2, normalize, texture, textureLoad, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { NightSky } from '../../packages/render/sky/NightSky.ts';
import { LightShafts } from '../../packages/render/post/LightShafts.ts';
import { purkinjeScale, purkinjeShift } from '../../packages/render/post/Purkinje.ts';
import { ISLAND_LOOK } from '../../packages/island/look/IslandLook.ts';

export default function () {

	// (the loader needs a browser: hand the disk empty textures instead)
	THREE.TextureLoader.prototype.load = () => new THREE.Texture();
	const night = new NightSky();
	// a view toward the moon: a ray per pixel, so the disk's screen derivatives vary as on the dome
	const ray = Fn( () => normalize( vec3( uv().sub( 0.5 ).mul( vec2( 0.9, - 0.5 ) ), - 1 ) ) );
	const moon = new THREE.NodeMaterial();
	moon.name = 'night-moon';
	moon.fragmentNode = Fn( () => {

		const d = ray().toVar();
		return vec4( night.moon( d ).mul( night.moonOcclusion( d ) ), 1 );

	} )();

	const shafts = new LightShafts();
	const depth = new THREE.RenderTarget( 4, 4, { type: THREE.FloatType, format: THREE.RedFormat } ).texture;
	const cloud = uniform( new THREE.Vector2( 1, 1 ) );
	const light = uniform( 0.01 );
	const constants = new THREE.NodeMaterial();
	constants.name = 'flare-visibility';
	constants.fragmentNode = vec4( purkinjeScale( ISLAND_LOOK.display.purkinje.retina, light ), 0, 0, shafts.occlusion( depth, vec2( 4, 4 ), cloud.x, cloud.y ) );
	const visible = uniform( 1 ), gain = uniform( 1 );
	const flare = new THREE.NodeMaterial();
	flare.name = 'flare';
	flare.fragmentNode = Fn( () => vec4( shafts.flare( uv(), float( 16 / 9 ), visible, gain ), 1 ) )();

	const scene = new THREE.RenderTarget( 4, 4, { type: THREE.HalfFloatType } ).texture;
	const post = new THREE.RenderTarget( 1, 1, { type: THREE.FloatType } ).texture;
	const amount = uniform( 0.01 );
	const composite = new THREE.NodeMaterial();
	composite.name = 'purkinje-composite';
	composite.fragmentNode = Fn( () => {

		const scale = textureLoad( texture( post ), ivec2( 0 ) ).r;
		return vec4( purkinjeShift( texture( scene, uv() ).rgb, scale, amount ), 1 );

	} )();
	return [ [ 'night-moon', moon ], [ 'flare-visibility', constants ], [ 'flare', flare ], [ 'purkinje-composite', composite ] ];

}
