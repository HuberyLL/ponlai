// Builds TSL shaders to WGSL in node, with no GPU and no browser: three's WGSL node builder (the
// code three hands to `createShaderModule`) on a WebGPURenderer that is never initialised, for the
// compute kernels, full-screen passes and materials an entry module returns. It writes each
// shader to a file, lists each one's bindings and uniforms, and flags any stage that exceeds
// WebGPU's default limits.
//
// Usage: node tools/wgsl-build.mjs <entry> [--out <dir>] [--features <a,b>] [--q "<query>"]
//
//   <entry>      a module in this repository (a path), or the name of one in tools/wgsl-build/:
//                `fsr3` builds every kernel of packages/render/post/fsr3/ as the page builds them
//                `ambient-relight` the ambient light's relight and its debug view
//                (packages/render/lighting/AmbientRelight.ts)
//                `ambient-materials` the lit materials that read the ambient volume
//                (packages/render/lighting/AmbientSample.ts)
//                `meadow` the displacement field's sprites and the meadow's blades
//                (packages/render/vegetation/Displacement.ts, packages/island/world/Grass.ts)
//                `plants` the plants that bend in the wind: the bamboo's culms and leaves (its
//                instanced draws' materials) and the yunpeng's whole and fading draws
//                (packages/island/world/BambooMaterials.ts, packages/island/world/Yunpeng.ts)
//                `falling-leaves` the falling leaves' step and prewarm kernels and draw
//                (packages/island/world/FallingLeaves.ts)
//                `local-lights` the local lights' clusters kernel and the lit materials that
//                bind the most (packages/render/lighting/LocalLights.ts)
//                `haze` the volumetric haze's light kernel and the sky dome's haze
//                (packages/render/weather/VolumetricHaze.ts)
//                `night` the moon on the dome, the flare and its visibility, and the
//                composite's rods' colour (packages/render/sky/NightSky.ts, packages/render/post/LightShafts.ts,
//                packages/render/post/Purkinje.ts)
//                `terrain` the island's ground, the stones and the sea floor
//                (packages/island/materials/TerrainMaterial.ts)
//                `wave-maps` the caustics' splats at their focal planes (packages/render/ocean/WaveMaps.ts)
//                `post` the post chain's own passes: the exposure's meter, the bloom's levels
//                and the local tone's grid and slicing (packages/render/post/Metering.ts, Exposure.ts,
//                PhysicalBloom.ts, LocalTone.ts)
//                `clouds` the clouds' panorama, shadow and view kernels (packages/render/sky/Clouds.ts)
//                `atmosphere` the atmosphere's bakes and slices, the earth shadow's mean and the
//                sky's radiance (packages/render/sky/Atmosphere.ts)
//                `sky` the materials that read the clear sky: the environment's panorama bake,
//                the cloudless sky's irradiance and the dome, fogged, in the scene pass's MRT
//                (packages/render/sky/Sky.ts)
//   --out        the output folder (default artifacts/wgsl/<entry name>/); the tool's own files in
//                it (*.wgsl, bindings.txt, report.json) are replaced, nothing else is touched
//   --features   the device features three sees (default none: WebGPU core). The page's device
//                takes every feature its adapter has, and three's WGSL depends on some of them:
//                `float32-filterable` (whether a 32-bit float texture gets a sampler),
//                `texture-formats-tier1` (narrow storage formats, FSR 3's resources), `subgroups`
//   --q          the page's query (its options, packages/render/Settings.ts, which load knobs read as their
//                modules load: `aa=`, `quality=`, debug flags); default none
//
// The entry is loaded through Vite's SSR loader with the project's config (as the dev server
// loads the page's modules: TypeScript, `import.meta.env`, the plugins' virtual modules), with the
// query's options installed first as the page's entry installs them (packages/render/Settings.ts
// `installSettings`), then the island's look (tools/island-look.mjs) and the scene's uniforms (packages/render/shared.ts `installShared`); any browser global a module touches as it loads fails the run. It
// imports what it builds from `packages/` and three as usual (Vite leaves three to node, so the tool
// and the entry share one three) and its default export, given `{ renderer }`, returns the
// shaders (or a promise of them) as `[ name, shader ]` pairs or an object of them, in the order
// the page first builds them (r186 emits code from node state its builds share: AGENTS.md, the
// warm-up's order). A shader is:
//   - a ComputeNode (`Fn( ... )().compute( ... )`): written as <name>.wgsl;
//   - a NodeMaterial: drawn as a full-screen pass (a QuadMesh, as the frame graph's passes draw);
//   - `{ material, object, scene, camera, mrt }` (all but material optional): a draw of
//     `object` (default a QuadMesh) with the scene's lights, `scene.environmentNode` and
//     `scene.fogNode`; written as <name>.vert.wgsl and <name>.frag.wgsl.
// Draws render into one rgba16float render target (not the canvas, so no output transform) with no
// shadow pass or clipping planes, and with no MRT unless the draw gives one (`mrt`, the pass's
// MRTNode, such as Motion.ts `sceneMRT`): then into one rgba16float texture per output, named as
// its outputs, with the material's own `mrtNode` merged over it as the page's passes merge it. A
// material whose `mrtNode` names outputs the target lacks writes none of them without it, and the
// code that feeds them (and the textures it reads) is left out.
//
// What it guarantees: each file is the WGSL three generates for the node graph the entry built, on
// a device with those features: the text the page creates its module from when the entry builds
// what the page builds (same inputs, query and order). What it does not: it does not validate the
// WGSL (no naga or tint here), so a shader that builds can still fail `createShaderModule` or its
// pipeline on the device; three's own build errors (a node without a type, a missing input) are
// reported as failures.
//
// The listing (bindings.txt; report.json holds the same for a script) gives per stage every
// binding in the module (group, binding, WGSL name and type, and the resource behind it: a
// texture's name and, for a storage texture with mips, the level its view binds), each uniform
// buffer's members (three names a uniform `nodeUniformN` when the code gave it no name: many of
// those, such as a uv matrix per texture read, are worth a look), the workgroup size and
// workgroup storage, and the varyings and colour outputs of a draw. The limits checked are
// WebGPU's defaults, which the page's device has (it requests none above them,
// `requiredLimits`): sampled textures 16, samplers 16, storage textures 4, storage buffers 8 and
// uniform buffers 12 per stage, a uniform buffer's 64 KiB, 4 bind groups, a workgroup's 256
// invocations (256 x 256 x 64) and 16 KiB of workgroup storage, 16 inter-stage variables and 8
// colour attachments. Counts are what each stage's module declares.
//
// Output: <out>/<name>.wgsl (or .vert.wgsl / .frag.wgsl), <out>/bindings.txt, <out>/report.json;
// stdout one line per shader and the totals. Exit 0 when every shader built within the limits,
// 1 when one failed to build or exceeds a limit, 2 for a usage error.

import './qos.mjs';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three/webgpu';
import { installIslandLook } from './island-look.mjs';

const ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const ENTRIES = join( ROOT, 'tools', 'wgsl-build' );

// WebGPU's default limits (a device that requests none)
const LIMITS = {
	sampledTextures: [ 16, 'maxSampledTexturesPerShaderStage' ],
	samplers: [ 16, 'maxSamplersPerShaderStage' ],
	storageTextures: [ 4, 'maxStorageTexturesPerShaderStage' ],
	storageBuffers: [ 8, 'maxStorageBuffersPerShaderStage' ],
	uniformBuffers: [ 12, 'maxUniformBuffersPerShaderStage' ],
	uniformBufferSize: [ 65536, 'maxUniformBufferBindingSize' ],
	bindGroups: [ 4, 'maxBindGroups' ],
	workgroupStorage: [ 16384, 'maxComputeWorkgroupStorageSize' ],
	invocations: [ 256, 'maxComputeInvocationsPerWorkgroup' ],
	workgroupSize: [ [ 256, 256, 64 ], 'maxComputeWorkgroupSizeX/Y/Z' ],
	interStage: [ 16, 'maxInterStageShaderVariables' ],
	colorAttachments: [ 8, 'maxColorAttachments' ],
};

function usage( message ) {

	console.error( `wgsl-build: ${ message }\nusage: node tools/wgsl-build.mjs <entry> [--out <dir>] [--features <a,b>] [--q "<query>"]` );
	process.exit( 2 );

}

function parseArgs( argv ) {

	const opts = { entry: null, out: null, features: [], q: '' };
	for ( let i = 0; i < argv.length; i ++ ) {

		const a = argv[ i ];
		const value = () => {

			if ( i + 1 >= argv.length ) usage( `${ a } needs a value` );
			return argv[ ++ i ];

		};
		if ( a === '--out' ) opts.out = value();
		else if ( a === '--features' ) opts.features = value().split( ',' ).map( ( s ) => s.trim() ).filter( Boolean );
		else if ( a === '--q' ) opts.q = value().replace( /^\?/, '' );
		else if ( a.startsWith( '-' ) ) usage( `unknown option ${ a }` );
		else if ( opts.entry === null ) opts.entry = a;
		else usage( `unexpected argument ${ a }` );

	}
	if ( opts.entry === null ) usage( 'no entry' );
	return opts;

}

function resolveEntry( entry ) {

	const path = existsSync( entry ) ? resolve( entry ) : join( ENTRIES, `${ entry }.mjs` );
	if ( ! existsSync( path ) ) usage( `no entry ${ entry } (a path, or one of ${ readdirSync( ENTRIES ).map( ( f ) => basename( f, '.mjs' ) ).join( ', ' ) })` );
	const rel = relative( ROOT, path );
	if ( rel.startsWith( '..' ) ) usage( `the entry must be inside the repository (${ ROOT })` );
	return { path, url: '/' + rel.split( '\\' ).join( '/' ), name: basename( path, extname( path ) ) };

}

// A WebGPURenderer three's node builder can work with: never initialised (no adapter), the
// device a stand-in that answers the feature questions the builder and the page's modules ask.
function stubRenderer( features ) {

	const canvas = { width: 1, height: 1, style: {}, addEventListener() {}, removeEventListener() {}, getContext: () => null };
	const renderer = new THREE.WebGPURenderer( { canvas } );
	renderer.backend.device = { features: new Set( features ), limits: {} };
	renderer._initialized = true; // (hasFeature asks the backend only once initialised)
	renderer.setRenderTarget( new THREE.RenderTarget( 1, 1, { type: THREE.HalfFloatType, depthBuffer: false } ) );
	return renderer;

}

// ---- building

function buildCompute( renderer, node ) {

	const builder = renderer.backend.createNodeBuilder( null, renderer ); // as NodeManager.getForCompute
	builder.compute = node;
	builder.build();
	return { builder, stages: { compute: builder.computeShader } };

}

function buildDraw( renderer, { material, object = null, scene = null, camera = null, mrt = null } ) {

	object ??= new THREE.QuadMesh( material );
	camera ??= object.isQuadMesh ? object.camera : new THREE.PerspectiveCamera();
	scene ??= new THREE.Scene();
	const lights = [];
	scene.traverse( ( o ) => {

		if ( o.isLight ) lights.push( o );

	} );
	// as NodeManager._createNodeBuilder
	const builder = renderer.backend.createNodeBuilder( object, renderer );
	builder.scene = scene;
	builder.material = material;
	builder.camera = camera;
	builder.context.material = material;
	builder.lightsNode = renderer.lighting.getNode( scene ).setLights( lights );
	builder.environmentNode = scene.environmentNode ?? null;
	builder.fogNode = scene.fogNode ?? null;
	builder.clippingContext = null;
	if ( ! mrt ) {

		builder.build();
		return { builder, stages: { vertex: builder.vertexShader, fragment: builder.fragmentShader } };

	}
	// into a target of one rgba16float texture per output, named as the MRT's outputs
	const target = renderer.getRenderTarget();
	const names = Object.keys( mrt.outputNodes );
	const outputs = new THREE.RenderTarget( 1, 1, { type: THREE.HalfFloatType, depthBuffer: false, count: names.length } );
	names.forEach( ( name, i ) => outputs.textures[ i ].name = name );
	renderer.setRenderTarget( outputs );
	renderer.setMRT( mrt );
	try {

		builder.build();

	} finally {

		renderer.setMRT( null );
		renderer.setRenderTarget( target );

	}
	return { builder, stages: { vertex: builder.vertexShader, fragment: builder.fragmentShader } };

}

function build( renderer, shader ) {

	if ( shader?.isComputeNode ) return buildCompute( renderer, shader );
	if ( shader?.isNodeMaterial ) return buildDraw( renderer, { material: shader } );
	if ( shader?.material?.isNodeMaterial ) return buildDraw( renderer, shader );
	throw new Error( 'not a ComputeNode, a NodeMaterial or { material, object, scene, camera }' );

}

// ---- reading the WGSL

// the parameter list and return type of the entry point `main`
function mainSignature( code ) {

	const start = code.search( /\bfn\s+main\s*\(/ );
	if ( start < 0 ) return null;
	let i = code.indexOf( '(', start ) + 1, depth = 1;
	const from = i;
	for ( ; i < code.length && depth > 0; i ++ ) {

		if ( code[ i ] === '(' ) depth ++;
		else if ( code[ i ] === ')' ) depth --;

	}
	const params = code.slice( from, i - 1 );
	const ret = /^\s*->\s*([^{]+)\{/.exec( code.slice( i ) );
	return { params, returns: ret ? ret[ 1 ].trim() : null };

}

function parseStructs( code ) {

	const structs = new Map();
	for ( const m of code.matchAll( /\bstruct\s+(\w+)\s*\{([^}]*)\}/g ) ) {

		const members = [];
		for ( let line of m[ 2 ].split( '\n' ) ) {

			const attributes = line.match( /@\w+(\s*\([^)]*\))?/g ) ?? [];
			line = line.replace( /@\w+(\s*\([^)]*\))?/g, '' ).trim().replace( /,$/, '' );
			const mm = /^(\w+)\s*:\s*(.+)$/.exec( line );
			if ( mm ) members.push( { name: mm[ 1 ], type: mm[ 2 ].trim(), location: attributes.some( ( a ) => a.startsWith( '@location' ) ) } );

		}
		structs.set( m[ 1 ], members );

	}
	return structs;

}

const roundUp = ( k, n ) => Math.ceil( n / k ) * k;

// WGSL's size and alignment of a type (host-shareable layout), null when not fixed
function layoutOf( type, structs ) {

	type = type.replace( /\s+/g, '' );
	if ( /^(f32|i32|u32)$/.test( type ) || /^atomic<(i32|u32)>$/.test( type ) ) return { size: 4, align: 4 };
	if ( type === 'f16' ) return { size: 2, align: 2 };
	let m = /^vec([234])(?:<(\w+)>|([fiuh]))$/.exec( type );
	if ( m ) {

		const s = ( m[ 2 ] ?? m[ 3 ] ).startsWith( 'f16' ) || m[ 3 ] === 'h' ? 2 : 4;
		const n = Number( m[ 1 ] );
		return { size: n * s, align: ( n === 2 ? 2 : 4 ) * s };

	}
	m = /^mat([234])x([234])(?:<(\w+)>|([fh]))$/.exec( type );
	if ( m ) {

		const column = layoutOf( `vec${ m[ 2 ] }<${ m[ 4 ] === 'h' || m[ 3 ] === 'f16' ? 'f16' : 'f32' }>`, structs );
		return { size: Number( m[ 1 ] ) * roundUp( column.align, column.size ), align: column.align };

	}
	m = /^array<(.+),(\d+)u?>$/.exec( type );
	if ( m ) {

		const element = layoutOf( m[ 1 ], structs );
		return element && { size: Number( m[ 2 ] ) * roundUp( element.align, element.size ), align: element.align };

	}
	const members = structs.get( type );
	if ( members ) {

		let offset = 0, align = 1;
		for ( const member of members ) {

			const l = layoutOf( member.type, structs );
			if ( ! l ) return null;
			offset = roundUp( l.align, offset ) + l.size;
			align = Math.max( align, l.align );

		}
		return { size: roundUp( align, offset ), align };

	}
	return null;

}

function kindOf( space, type ) {

	if ( space?.startsWith( 'uniform' ) ) return 'uniform buffer';
	if ( space?.startsWith( 'storage' ) ) return 'storage buffer';
	if ( /^sampler(_comparison)?$/.test( type ) ) return 'sampler';
	if ( type.startsWith( 'texture_storage_' ) ) return 'storage texture';
	if ( type.startsWith( 'texture_' ) ) return 'sampled texture';
	return 'other';

}

// the resources behind a stage's WGSL names, from the builder's uniforms
function resourcesOf( builder, stage ) {

	const names = new Map();
	for ( const u of builder.uniforms[ stage ] ?? [] ) {

		const node = u.node;
		if ( node?.isTextureNode ) {

			const t = node.value;
			let what = t?.name ? t.name : '(unnamed texture)';
			if ( node.isStorageTextureNode && t?.mipmaps?.length > 1 ) what += ` level ${ node.mipLevel }`;
			names.set( u.name, what );
			names.set( `${ u.name }_sampler`, what );

		} else if ( node?.isStorageBufferNode || node?.isBufferNode ) {

			const a = node.value;
			if ( a?.isBufferAttribute ) names.set( u.name, `${ a.name ? a.name + ', ' : '' }${ a.count } x ${ a.itemSize }` );

		}

	}
	return names;

}

function analyseStage( stage, code, builder ) {

	const structs = parseStructs( code );
	const resources = resourcesOf( builder, stage );
	const bindings = [];
	for ( const m of code.matchAll( /@binding\(\s*(\d+)\s*\)\s*@group\(\s*(\d+)\s*\)\s*var(?:<([^>]+)>)?\s+(\w+)\s*:\s*([^;]+);/g ) ) {

		const [ , binding, group, space, name, type ] = m;
		const b = { group: Number( group ), binding: Number( binding ), name, type: type.trim(), kind: kindOf( space?.replace( /\s/g, '' ), type.trim() ) };
		if ( space?.includes( ',' ) ) b.access = space.split( ',' )[ 1 ].trim();
		if ( resources.has( name ) ) b.resource = resources.get( name );
		// (three wraps a buffer's array in a struct of one member)
		const wrapped = structs.get( b.type );
		if ( b.kind === 'storage buffer' && wrapped?.length === 1 ) b.type = wrapped[ 0 ].type;
		if ( b.kind === 'uniform buffer' ) {

			b.members = structs.get( b.type )?.map( ( { name, type } ) => ( { name, type } ) ) ?? [];
			b.size = layoutOf( b.type, structs )?.size ?? null;

		}
		bindings.push( b );

	}
	bindings.sort( ( a, b ) => a.group - b.group || a.binding - b.binding );

	const count = ( kind ) => bindings.filter( ( b ) => b.kind === kind ).length;
	const out = {
		lines: code.split( '\n' ).length,
		counts: {
			sampledTextures: count( 'sampled texture' ), storageTextures: count( 'storage texture' ), samplers: count( 'sampler' ),
			storageBuffers: count( 'storage buffer' ), uniformBuffers: count( 'uniform buffer' ),
			uniforms: bindings.reduce( ( n, b ) => n + ( b.members?.length ?? 0 ), 0 ),
			unnamedUniforms: bindings.reduce( ( n, b ) => n + ( b.members?.filter( ( u ) => /^nodeUniform\d+$/.test( u.name ) ).length ?? 0 ), 0 ),
		},
		bindings,
		warnings: [],
	};
	const over = ( key, value, what = key, limit = LIMITS[ key ][ 0 ] ) => {

		if ( value > limit ) out.warnings.push( `${ what } ${ value } > ${ limit } (${ LIMITS[ key ][ 1 ] })` );

	};
	const labels = { sampledTextures: 'sampled textures', storageTextures: 'storage textures', samplers: 'samplers', storageBuffers: 'storage buffers', uniformBuffers: 'uniform buffers' };
	for ( const [ key, label ] of Object.entries( labels ) ) over( key, out.counts[ key ], label );
	for ( const b of bindings ) if ( b.size !== undefined && b.size !== null ) over( 'uniformBufferSize', b.size, `uniform buffer ${ b.name } bytes` );
	over( 'bindGroups', bindings.reduce( ( n, b ) => Math.max( n, b.group + 1 ), 0 ), 'bind groups' );

	if ( stage === 'compute' ) {

		const size = /@workgroup_size\(\s*([^)]*)\)/.exec( code )?.[ 1 ].split( ',' ).map( ( s ) => Number( s.trim() ) );
		if ( size && size.every( Number.isFinite ) ) {

			while ( size.length < 3 ) size.push( 1 );
			out.workgroupSize = size;
			over( 'invocations', size[ 0 ] * size[ 1 ] * size[ 2 ], 'workgroup invocations' );
			size.forEach( ( n, i ) => over( 'workgroupSize', n, `workgroup size ${ 'xyz'[ i ] }`, LIMITS.workgroupSize[ 0 ][ i ] ) );

		}
		let bytes = 0;
		for ( const m of code.matchAll( /var<workgroup>\s+(\w+)\s*:\s*([^;]+);/g ) ) {

			const l = layoutOf( m[ 2 ], structs );
			if ( l ) bytes += roundUp( 16, l.size ); // (the limit's own rounding, per variable)

		}
		out.workgroupStorage = bytes;
		over( 'workgroupStorage', bytes, 'workgroup storage bytes' );

	} else {

		const sig = mainSignature( code );
		if ( stage === 'vertex' && sig?.returns ) {

			out.varyings = structs.get( sig.returns )?.filter( ( m ) => m.location ).length ?? 0;
			over( 'interStage', out.varyings, 'varyings' );

		}
		if ( stage === 'fragment' && sig?.returns ) {

			out.colorOutputs = structs.get( sig.returns )?.filter( ( m ) => m.location ).length ?? ( sig.returns.includes( '@location' ) ? 1 : 0 );
			over( 'colorAttachments', out.colorOutputs, 'colour outputs' );

		}

	}
	return out;

}

// ---- the listing

function summaryOf( stage, s ) {

	const c = s.counts;
	const parts = [ `${ stage }${ s.workgroupSize ? ' ' + s.workgroupSize.join( 'x' ) : '' } ${ s.lines } lines` ];
	parts.push( `tex ${ c.sampledTextures } sampled + ${ c.storageTextures } storage`, `samplers ${ c.samplers }`, `buffers ${ c.storageBuffers } storage + ${ c.uniformBuffers } uniform` );
	parts.push( `uniforms ${ c.uniforms }${ c.unnamedUniforms ? ` (${ c.unnamedUniforms } unnamed)` : '' }` );
	if ( s.workgroupStorage ) parts.push( `workgroup ${ s.workgroupStorage } B` );
	if ( s.varyings !== undefined ) parts.push( `varyings ${ s.varyings }` );
	if ( s.colorOutputs !== undefined ) parts.push( `outputs ${ s.colorOutputs }` );
	return parts.join( ', ' );

}

function listing( shaders ) {

	const lines = [];
	for ( const sh of shaders ) {

		lines.push( `== ${ sh.name }${ sh.error ? '  FAILED' : '' }` );
		if ( sh.error ) {

			lines.push( '  ' + sh.error.split( '\n' ).join( '\n  ' ), '' );
			continue;

		}
		for ( const [ stage, s ] of Object.entries( sh.stages ) ) {

			lines.push( `  ${ summaryOf( stage, s ) }  -> ${ sh.files[ stage ] }` );
			for ( const w of s.warnings ) lines.push( `  WARNING ${ w }` );
			for ( const b of s.bindings ) {

				const where = `@group(${ b.group }) @binding(${ String( b.binding ).padEnd( 2 ) })`;
				const extra = [ b.access, b.resource, b.size !== undefined && b.size !== null ? `${ b.size } B` : null ].filter( Boolean ).join( ', ' );
				lines.push( `    ${ where } ${ b.kind.padEnd( 15 ) } ${ b.name } : ${ b.type }${ extra ? `  [${ extra }]` : '' }` );
				if ( b.members?.length ) lines.push( `      ${ b.members.map( ( u ) => `${ u.name } ${ u.type }` ).join( ', ' ) }` );

			}

		}
		lines.push( '' );

	}
	return lines.join( '\n' );

}

// ---- main

const opts = parseArgs( process.argv.slice( 2 ) );
const entry = resolveEntry( opts.entry );
const outDir = resolve( opts.out ?? join( ROOT, 'artifacts', 'wgsl', entry.name ) );
mkdirSync( outDir, { recursive: true } );
for ( const f of readdirSync( outDir ) ) if ( f.endsWith( '.wgsl' ) || f === 'bindings.txt' || f === 'report.json' ) rmSync( join( outDir, f ) );

const renderer = stubRenderer( opts.features );

const { createServer } = await import( 'vite' );
const server = await createServer( {
	root: ROOT, logLevel: 'error', appType: 'custom', clearScreen: false,
	server: { middlewareMode: true, hmr: false, ws: false, watch: null },
	optimizeDeps: { noDiscovery: true, include: [] },
} );
let list;
try {

	const { installSettings, parseSettings } = await server.ssrLoadModule( '/packages/render/Settings.ts' );
	installSettings( parseSettings( opts.q ?? '' ) );
	// the island's look, as the page's entry installs it after the settings (packages/render/look/Look.ts)
	await installIslandLook( ( file ) => server.ssrLoadModule( `/${ file }` ) );
	// the scene's uniforms, as the page's entry creates and installs them (packages/render/shared.ts)
	const { createShared, installShared } = await server.ssrLoadModule( '/packages/render/shared.ts' );
	installShared( createShared() );
	const mod = await server.ssrLoadModule( entry.url );
	if ( typeof mod.default !== 'function' ) throw new Error( `${ entry.url } has no default export function` );
	list = await mod.default( { renderer } );

} catch ( e ) {

	await server.close();
	console.error( `wgsl-build: the entry failed: ${ e?.stack ?? e }` );
	process.exit( 1 );

}
await server.close();

const pairs = Array.isArray( list ) ? list : list instanceof Map ? [ ...list ] : Object.entries( list ?? {} );
const fileName = ( name ) => name.replace( /[^\w.-]+/g, '-' );
const seen = new Set();
const shaders = [];
let failed = 0, overLimit = 0;
for ( const [ name, shader ] of pairs ) {

	if ( seen.has( fileName( name ) ) ) {

		console.error( `wgsl-build: two shaders named ${ name }` );
		process.exit( 1 );

	}
	seen.add( fileName( name ) );
	const sh = { name, stages: {}, files: {} };
	try {

		const { builder, stages } = build( renderer, shader );
		for ( const [ stage, code ] of Object.entries( stages ) ) {

			const file = fileName( name ) + ( stage === 'compute' ? '.wgsl' : stage === 'vertex' ? '.vert.wgsl' : '.frag.wgsl' );
			writeFileSync( join( outDir, file ), code );
			sh.files[ stage ] = file;
			sh.stages[ stage ] = analyseStage( stage, code, builder );

		}

	} catch ( e ) {

		sh.error = String( e?.stack ?? e ).split( '\n' ).slice( 0, 8 ).join( '\n' );

	}
	shaders.push( sh );
	if ( sh.error ) {

		failed ++;
		console.log( `FAIL ${ name }: ${ sh.error.split( '\n' )[ 0 ] }` );
		continue;

	}
	const warnings = Object.values( sh.stages ).flatMap( ( s ) => s.warnings );
	if ( warnings.length ) overLimit ++;
	for ( const [ stage, s ] of Object.entries( sh.stages ) ) console.log( `${ warnings.length ? 'OVER' : 'ok  ' } ${ name }: ${ summaryOf( stage, s ) }` );
	for ( const w of warnings ) console.log( `     WARNING ${ w }` );

}

writeFileSync( join( outDir, 'bindings.txt' ), `wgsl-build ${ relative( ROOT, entry.path ) }, three r${ THREE.REVISION }, features: ${ opts.features.join( ', ' ) || 'none' }${ opts.q ? `, query ?${ opts.q }` : '' }\n\n${ listing( shaders ) }` );
writeFileSync( join( outDir, 'report.json' ), JSON.stringify( { entry: relative( ROOT, entry.path ), three: THREE.REVISION, features: opts.features, query: opts.q, shaders }, null, '\t' ) );
console.log( `${ shaders.length - failed } of ${ shaders.length } built${ failed ? `, ${ failed } failed` : '' }${ overLimit ? `, ${ overLimit } over a default limit` : '' }; listing: ${ relative( process.cwd(), join( outDir, 'bindings.txt' ) ) }` );
process.exit( failed || overLimit ? 1 : 0 );
