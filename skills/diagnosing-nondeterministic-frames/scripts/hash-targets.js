// Runs in the page (three.js, WebGPURenderer or WebGLRenderer). Hashes every GPU texture and render
// target reachable from the given roots, each layer and mip level apart, and records every number
// reachable from them bit for bit, so two pages can be compared value by value
// (compare-runs.mjs). Read-only: it renders nothing and changes no state.
//
// The file is one async function expression. Call it with ( roots, renderer, options ), or with no
// arguments after setting `globalThis.HASH_TARGETS = { roots, renderer, options }` (for tools whose
// eval calls a function without arguments).
//   roots     an object whose properties are walked: the renderer's parts, the app's modules
//   renderer  the three.js renderer
//   options   { depth: 6, levels: 1, maxNumbers: 80000, skip: [ 'parent', 'children' ] }
//             levels: how many mip levels of each texture to hash (1 = level 0 only)
// Returns { textures: { '<path> <w>x<h> <format> layer <l> level <m>': hash }, numbers: { path: bits },
// skipped: [ reason ] }.
async ( roots, renderer, options ) => {

	const given = globalThis.HASH_TARGETS ?? {};
	roots = roots ?? given.roots;
	renderer = renderer ?? given.renderer;
	const o = { depth: 6, levels: 1, maxNumbers: 80000, skip: [ 'parent', 'children' ], ...( options ?? given.options ) };
	if ( ! roots || ! renderer ) throw new Error( 'hash-targets: give ( roots, renderer ) or set globalThis.HASH_TARGETS = { roots, renderer }' );

	const out = { textures: {}, numbers: {}, skipped: [] };
	const fnv = ( bytes ) => {

		const u = new Uint32Array( bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2 );
		let h = 2166136261;
		for ( let i = 0; i < u.length; i ++ ) { h ^= u[ i ]; h = Math.imul( h, 16777619 ); }
		return ( h >>> 0 ).toString( 16 ).padStart( 8, '0' );

	};
	const bits = ( x ) => {

		const u = new Uint32Array( new Float64Array( [ x ] ).buffer );
		return u[ 1 ].toString( 16 ).padStart( 8, '0' ) + u[ 0 ].toString( 16 ).padStart( 8, '0' );

	};

	// walk: numbers recorded, textures and render targets collected with the first path that reached them
	const seen = new WeakSet(), found = new Map();
	let count = 0;
	const walk = ( v, path, depth ) => {

		if ( count > o.maxNumbers ) return;
		if ( typeof v === 'number' ) { out.numbers[ path ] = bits( v ); count ++; return; }
		if ( v === null || typeof v !== 'object' || seen.has( v ) ) return;
		seen.add( v );
		if ( v.isRenderTarget || v.isTexture ) { if ( ! found.has( v ) ) found.set( v, path ); if ( v.isTexture ) return; }
		if ( ArrayBuffer.isView( v ) ) { if ( v.byteLength % 4 === 0 ) out.numbers[ path ] = '#' + fnv( new Uint8Array( v.buffer, v.byteOffset, v.byteLength ) ); return; }
		if ( typeof v.toArray === 'function' && ( v.isVector2 || v.isVector3 || v.isVector4 || v.isColor || v.isMatrix3 || v.isMatrix4 || v.isQuaternion || v.isEuler ) ) {

			out.numbers[ path ] = v.toArray().filter( ( x ) => typeof x === 'number' ).map( bits ).join( ',' );
			count ++;
			return;

		}

		if ( depth <= 0 || v === renderer || v === renderer.backend ) return;
		if ( v.isNode ) { if ( 'value' in v ) walk( v.value, path + '.value', 2 ); return; }
		if ( v.isRenderTarget ) { walk( v.textures ?? v.texture, path + '.textures', 2 ); return; }
		if ( v instanceof Map ) { let i = 0; for ( const [ k, x ] of v ) walk( x, `${ path }<${ typeof k === 'string' ? k : i ++ }>`, depth - 1 ); return; }
		if ( Array.isArray( v ) ) { for ( let i = 0; i < Math.min( v.length, 256 ); i ++ ) walk( v[ i ], `${ path }[${ i }]`, depth - 1 ); return; }
		let keys;
		try { keys = Object.keys( v ); } catch { return; }
		for ( const k of keys ) {

			if ( o.skip.includes( k ) ) continue;
			let x;
			try { x = v[ k ]; } catch { continue; }
			walk( x, `${ path }.${ k }`, depth - 1 );

		}

	};

	for ( const [ k, v ] of Object.entries( roots ) ) walk( v, k, o.depth );

	const textures = new Map();
	for ( const [ v, path ] of found ) {

		if ( v.isRenderTarget ) ( v.textures ?? [ v.texture ] ).forEach( ( t, i ) => textures.has( t ) || textures.set( t, { path: `${ path }.textures[${ i }]`, target: v, index: i } ) );
		else if ( ! textures.has( v ) ) textures.set( v, { path } );

	}

	const backend = renderer.backend;
	const device = backend?.device;
	// bytes per texel of the colour formats a copy can read
	const SIZE = { r8unorm: 1, rg8unorm: 2, rgba8unorm: 4, 'rgba8unorm-srgb': 4, bgra8unorm: 4, 'bgra8unorm-srgb': 4, r16float: 2, rg16float: 4, rgba16float: 8, r32float: 4, rg32float: 8, rgba32float: 16, r32uint: 4, rg32uint: 8, rgba32uint: 16, r32sint: 4, r16uint: 2, rgba16uint: 8, rgb10a2unorm: 4, rg11b10ufloat: 4 };

	const copy = async ( gpu, level, layer ) => {

		const w = Math.max( 1, gpu.width >> level ), h = Math.max( 1, gpu.height >> level );
		const row = Math.ceil( w * SIZE[ gpu.format ] / 256 ) * 256;
		const buffer = device.createBuffer( { size: row * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ } );
		device.pushErrorScope( 'validation' );
		const encoder = device.createCommandEncoder();
		encoder.copyTextureToBuffer( { texture: gpu, mipLevel: level, origin: { x: 0, y: 0, z: layer } }, { buffer, bytesPerRow: row }, { width: w, height: h } );
		device.queue.submit( [ encoder.finish() ] );
		const error = await device.popErrorScope();
		if ( error ) { buffer.destroy(); throw new Error( error.message.split( '\n' )[ 0 ] ); }
		await buffer.mapAsync( GPUMapMode.READ );
		// rows are padded to 256 bytes: hash only each row's texels
		const all = new Uint8Array( buffer.getMappedRange() ), packed = new Uint8Array( w * SIZE[ gpu.format ] * h + 3 & ~ 3 );
		for ( let y = 0; y < h; y ++ ) packed.set( all.subarray( y * row, y * row + w * SIZE[ gpu.format ] ), y * w * SIZE[ gpu.format ] );
		const hash = fnv( packed );
		buffer.unmap();
		buffer.destroy();
		return { w, h, hash };

	};

	for ( const [ t, { path, target, index } ] of textures ) {

		const gpu = device && backend.get?.( t )?.texture;
		if ( gpu && typeof gpu.createView === 'function' ) {

			if ( gpu.sampleCount > 1 ) { out.skipped.push( `${ path }: multisampled (${ gpu.format }); hash its resolve target` ); continue; }
			if ( ! SIZE[ gpu.format ] ) { out.skipped.push( `${ path }: format ${ gpu.format } not read` ); continue; }
			const layers = gpu.dimension === '3d' || gpu.depthOrArrayLayers > 1 ? gpu.depthOrArrayLayers : 1;
			for ( let level = 0; level < Math.min( o.levels, gpu.mipLevelCount ); level ++ ) for ( let layer = 0; layer < layers; layer ++ ) {

				try {

					const { w, h, hash } = await copy( gpu, level, gpu.dimension === '3d' ? Math.min( layer, ( gpu.depthOrArrayLayers >> level ) - 1 ) : layer );
					out.textures[ `${ path } ${ w }x${ h } ${ gpu.format } layer ${ layer } level ${ level }` ] = hash;

				} catch ( e ) { out.skipped.push( `${ path } layer ${ layer } level ${ level }: ${ e.message }` ); }

			}

		} else if ( target && ! device ) {

			// WebGL: level 0 of each layer through the renderer
			const layers = target.depth > 1 ? target.depth : 1;
			for ( let layer = 0; layer < layers; layer ++ ) {

				try {

					const px = await renderer.readRenderTargetPixelsAsync( target, 0, 0, target.width, target.height, index, layer );
					out.textures[ `${ path } ${ target.width }x${ target.height } layer ${ layer } level 0` ] = fnv( new Uint8Array( px.buffer, px.byteOffset, px.byteLength ) );

				} catch ( e ) { out.skipped.push( `${ path } layer ${ layer }: ${ e.message }` ); }

			}

		} else if ( ! gpu ) out.skipped.push( `${ path }: not on the GPU (not uploaded or not used)` );

	}

	out.count = { textures: Object.keys( out.textures ).length, numbers: Object.keys( out.numbers ).length, skipped: out.skipped.length };
	return out;

}
