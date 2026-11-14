// The project's own ESLint rules, loaded by eslint.config.mjs as the `ponlai` plugin.
//
// Each rule turns a mechanical rule of the project into a check, and its message tells whoever wrote
// the line what is wrong, what to write instead and which file explains why. `npm run lint` runs
// ESLint over packages/ and app/ with these rules and nothing else: no recommended sets and no style
// rules (the code style is three.js's and is not linted). It reads the code with type information
// (typescript-eslint's project service over tsconfig.json), takes a few seconds and is one of the
// checks every commit passes (tools/check.mjs). The scopes are in eslint.config.mjs.
//
// The rules, what each reports and where:
// - `ponlai/tsl-method-order`: TSL's `.mix`, `.step` and `.smoothstep` method forms, which take
//   their receiver out of order (a call whose receiver is typed as a TSL node or is untyped). All
//   code.
// - `ponlai/tsl-only`: shader code in strings: `wgslFn`, `glslFn`, `nativeFn`, `wgsl`, `glsl`, `js`,
//   `code`, `CodeNode`, `FunctionNode`. All code.
// - `ponlai/history-on-graph`: `copyTextureToTexture` outside a pass added with `addPass`. All code
//   but packages/render/post/graph/ and packages/render/three/.
// - `ponlai/pass-on-graph`: `rtt()` and `convertToTexture()`. All code.
// - `ponlai/chunk-normals`: `computeVertexNormals`. packages/island/world/ only.
// - `ponlai/no-dynamic-draw`: `DynamicDrawUsage`. All code.
// - `ponlai/timestamp-owner`: `trackTimestamp` and three's timestamp pools (`timestampPools`,
//   `takeTimestamps`, `resolveTimestamps`, `resolveTimestampsAsync`). All code but
//   packages/render/post/DynamicResolution.ts, packages/render/debug/FrameProfiler.ts and
//   packages/render/three/.
// - `ponlai/scene-clock`: the wall clock: `performance.now()`, `Date.now()`, `new Date()`, `Date()`.
//   All code but the debug folders (packages/render/debug/, packages/island/debug/),
//   packages/game/GameDebug.ts and app/QualityDetect.ts.
// - `ponlai/vegetation-tag`: reading `alphaToCoverage` (setting it is fine). All code.
//
// An exception is a comment on the line above the one it excepts, naming the rule and a reason a
// reader can check:
//   // eslint-disable-next-line ponlai/scene-clock -- the time budget of one slice of the growth's work
//   const start = performance.now();
// A file at its line limit (tools/repo/verify-file-size.mjs) takes the same comment at the end of
// the line, as `// eslint-disable-line ponlai/<rule> -- <reason>`, so the exception adds no line. A
// real violation that cannot be fixed yet is excepted the same way, its reason starting with
// `known violation:`. A disable comment that no longer suppresses anything is an error, so the
// exceptions stay true. For `ponlai/scene-clock`, a reading that only measures how long something
// took, budgets a slice of work, times out a wait or paces the game's interface in the player's
// time (its animations, the wheel's repeat limit: they go on while the scene is paused) is an
// exception; one that decides what the scene shows is a violation.
//
// To add a rule:
// 1. Write it here: a few AST selectors through `selectorRule`, or a rule of its own when it needs
//    more than a selector can say: the receiver's type (`tsl-method-order`), an ancestor
//    (`history-on-graph`) or whether a member is read or written (`vegetation-tag`). Its message
//    says what to write instead and names the file that explains why.
// 2. Turn it on in eslint.config.mjs in a block of its own whose `files` and `ignores` are the
//    folders it concerns, each exclusion with its reason in a comment.
// 3. Add its fixture, tools/repo/lint/fixtures/<rule>.ts: the wrong forms, each line marked
//    `// reported`, beside the right forms the rule must leave alone. A rule scoped to one folder
//    names the path its fixture is linted from in `FIXTURE_PATHS` in tools/repo/verify-lint.mjs,
//    which checks every fixture.
// 4. Run `npm run lint` and go through every hit: fix it, narrow the scope or write the exception.
//
// Each rule has a name of its own, rather than all of them sharing `no-restricted-syntax`: ESLint
// keeps only the last options of a rule for a file, so rules with different folders would replace
// each other, and a disable comment names the one rule it excepts.

const docs = ( description ) => ( { type: 'problem', docs: { description }, schema: [] } );

/** A rule that reports every node one of `selectors` matches, with `message`. */
function selectorRule( description, selectors, message ) {

	return {
		meta: { ...docs( description ), messages: { found: message } },
		create( context ) {

			const visitors = {};
			for ( const selector of selectors ) visitors[ selector ] = ( node ) => context.report( { node, messageId: 'found' } );
			return visitors;

		},
	};

}

// ---- tsl-method-order

// The forms as written and what three r186 computes for them.
const METHOD_FORMS = {
	mix: '`t.mix( a, b )` is mix( a, b, t )',
	step: '`x.step( edge )` is step( edge, x )',
	smoothstep: '`x.smoothstep( low, high )` is smoothstep( low, high, x )',
};

// Whether a TypeScript type is a TSL node: it has three's `Node.isNode`. `any` counts too, since
// TSL hands `Fn` parameters and some node results to TypeScript untyped; plain numbers, three's
// `MathUtils` and our own classes' `step` methods are typed and are not nodes.
function isNodeType( type ) {

	if ( type.flags & 1 /* ts.TypeFlags.Any */ ) return true;
	const parts = type.isUnion() ? type.types : [ type ];
	return parts.some( ( t ) => {

		const isNode = t.getProperty( 'isNode' );
		return isNode !== undefined && ( isNode.declarations ?? [] ).some( ( d ) => /[\\/]three[\\/]src[\\/]nodes[\\/]/.test( d.getSourceFile().fileName ) );

	} );

}

const tslMethodOrder = {
	meta: {
		...docs( 'TSL\'s mix, step and smoothstep only in their function form' ),
		messages: {
			found: 'TSL\'s method form takes its receiver out of order in three r186: {{ form }}. Write the function form imported from \'three/tsl\' with the arguments in their usual order ( mix( a, b, t ), step( edge, x ), smoothstep( low, high, x ) ). Why: packages/render/post/fsr3/Upsample.ts, the comment on ffxLerp.',
		},
	},
	create( context ) {

		const services = context.sourceCode.parserServices;
		if ( ! services?.program ) throw new Error( 'ponlai/tsl-method-order needs type information (parserOptions.projectService)' );
		const checker = services.program.getTypeChecker();
		return {
			'CallExpression > MemberExpression.callee[computed=false][property.name=/^(mix|step|smoothstep)$/]'( member ) {

				const receiver = services.esTreeNodeToTSNodeMap.get( member.object );
				if ( ! isNodeType( checker.getTypeAtLocation( receiver ) ) ) return;
				context.report( { node: member.property, messageId: 'found', data: { form: METHOD_FORMS[ member.property.name ] } } );

			},
		};

	},
};

// ---- tsl-only

const RAW_IMPORTS = 'wgslFn|glslFn|nativeFn|wgsl|glsl|js|code|CodeNode|FunctionNode';
const tslOnly = selectorRule(
	'no shader code as WGSL or GLSL strings',
	[
		`ImportDeclaration[source.value=/^three(\\u002F(tsl|webgpu))?$/] > ImportSpecifier[imported.name=/^(${ RAW_IMPORTS })$/]`,
		'MemberExpression[computed=false][property.name=/^(wgslFn|glslFn|nativeFn|CodeNode|FunctionNode)$/]',
		'MemberExpression[computed=false][object.name="TSL"][property.name=/^(wgsl|glsl|js|code)$/]',
		'MemberExpression[computed=false][object.property.name="TSL"][property.name=/^(wgsl|glsl|js|code)$/]',
	],
	'Shaders are written in TSL only: no WGSL or GLSL in strings (wgslFn, glslFn, nativeFn, wgsl, glsl, js, code, CodeNode, FunctionNode). Write the code as TSL nodes; a helper called from several places is `Fn( ... ).setLayout( ... )`, so it compiles to one shader function. `node tools/render/wgsl-build.mjs` shows the WGSL a TSL material or kernel compiles to. The rule: AGENTS.md, What the checks hold.',
);

// ---- history-on-graph

const historyOnGraph = {
	meta: {
		...docs( 'copyTextureToTexture only inside a frame graph pass, the graph or three\'s wrappers' ),
		messages: {
			found: 'copyTextureToTexture outside a frame graph pass: a texture\'s history is declared on the graph, as a ping-pong resource read through `previous()` or a frame-end `copyToPersistent` (single-sampled, same size class and format), and a copy that is frame work is the `run` of a pass added with `addPass` that declares what it reads and writes; otherwise the attachment ops discard what nothing declared. Read packages/render/post/graph/GraphCompiler.ts (`previous`, `copyToPersistent`) and the header of packages/render/post/Pipeline.ts.',
		},
	},
	create( context ) {

		return {
			'CallExpression > MemberExpression.callee[computed=false][property.name="copyTextureToTexture"]'( member ) {

				const inPass = context.sourceCode.getAncestors( member ).some( ( a ) => a.type === 'CallExpression' && a.callee.type === 'MemberExpression' && a.callee.property.name === 'addPass' );
				if ( ! inPass ) context.report( { node: member.property, messageId: 'found' } );

			},
		};

	},
};

// ---- pass-on-graph

const passOnGraph = selectorRule(
	'no rtt() or convertToTexture() inside a material',
	[
		'CallExpression[callee.type="Identifier"][callee.name=/^(rtt|convertToTexture)$/]',
		'CallExpression > MemberExpression.callee[computed=false][property.name=/^(rtt|convertToTexture)$/]',
	],
	'rtt() and convertToTexture() render a target from inside another pass\'s material, where the frame graph cannot see, order, size or warm it. New frame work is a pass on the frame graph: add it with `addPass`, declare its target with a size class and every texture it binds as a read. Read the header of packages/render/post/Pipeline.ts.',
);

// ---- chunk-normals

const chunkNormals = selectorRule(
	'no computeVertexNormals on a chunk\'s own triangles',
	[ 'CallExpression > MemberExpression.callee[computed=false][property.name="computeVertexNormals"]' ],
	'computeVertexNormals on a chunk\'s geometry averages only that chunk\'s triangles, so the normals on a chunk\'s border differ from its neighbour\'s and the seam shows. Data on a chunk border must be bit-identical in both chunks: take normals and curvature from a world-anchored lattice or field (central differences of the function, as SeabedTile.ts does) or from the apron round the chunk. Read the header of packages/island/world/Chunks.ts.',
);

// ---- no-dynamic-draw

const noDynamicDraw = selectorRule(
	'no DynamicDrawUsage',
	[ 'MemberExpression[computed=false][property.name="DynamicDrawUsage"]', 'ImportSpecifier[imported.name="DynamicDrawUsage"]' ],
	'With DynamicDrawUsage three r186 re-uploads the whole buffer on every draw. Leave the attribute at its static usage and, after writing it, bump its version with update ranges (`addUpdateRange`, `needsUpdate = true`), so only what changed is uploaded, once. Read packages/render/weather/LightningStrike.ts (the comment on its static usage) and packages/render/vegetation/Instances.ts.',
);

// ---- timestamp-owner

const timestampOwner = selectorRule(
	'GPU timestamps have one owner',
	[
		'Identifier[name="trackTimestamp"]',
		'CallExpression[callee.type="Identifier"][callee.name=/^(timestampPools|takeTimestamps|resolveTimestamps)$/]',
		'CallExpression > MemberExpression.callee[computed=false][property.name="resolveTimestampsAsync"]',
	],
	'three\'s timestamp queries (`trackTimestamp`) have one owner at a time: three resolves them into one buffer and drops what it resolves while that is mapped, so a second reader takes readings from the first. They are read only by packages/render/post/DynamicResolution.ts (`GpuFrameTimer`) and, while it times passes, the frame profiler (packages/render/debug/FrameProfiler.ts), which then feeds the first; three\'s members are reached through packages/render/three/Backend.ts. Take GPU times from DynamicResolution or the profiler instead. Read the header of DynamicResolution.ts.',
);

// ---- scene-clock

const sceneClock = selectorRule(
	'simulation, generation and per-frame updates read the scene clock, not the wall clock',
	[
		'CallExpression > MemberExpression.callee[computed=false][object.name="performance"][property.name="now"]',
		'CallExpression > MemberExpression.callee[computed=false][object.name="Date"][property.name="now"]',
		'NewExpression[callee.name="Date"][arguments.length=0]',
		'CallExpression[callee.type="Identifier"][callee.name="Date"]',
	],
	'The wall clock (performance.now, Date.now, new Date()) in code that changes the scene: the simulation, the world\'s generation and growth, the weather and every per-frame update are functions of the scene clock, so a paused page, a stepped clip and a fresh load repeat. Read the scene clock\'s time or its step (the `time` and `dt` the frame stages hand on) instead. A reading that only measures how long something took, budgets a slice of work or times out a wait, and so changes when work lands but never what it produces, takes `// eslint-disable-next-line ponlai/scene-clock -- <what it measures>`. Read ARCHITECTURE.md, rule 17 (time) and rule 4.',
);

// ---- vegetation-tag

const vegetationTag = {
	meta: {
		...docs( 'vegetation is found by userData.vegetation, never by alphaToCoverage' ),
		messages: {
			found: 'Reading `alphaToCoverage` does not tell vegetation: it is off without multisampling (the temporal modes) and on for other cut-outs. Find vegetation materials by their tag, `material.userData.vegetation === true` (set by `markVegetation`). Setting `alphaToCoverage` is fine. Read the header of packages/render/vegetation/Coverage.ts.',
		},
	},
	create( context ) {

		return {
			'MemberExpression[computed=false][property.name="alphaToCoverage"]'( member ) {

				const parent = member.parent;
				if ( parent.type === 'AssignmentExpression' && parent.left === member && parent.operator === '=' ) return;
				context.report( { node: member.property, messageId: 'found' } );

			},
			'ObjectPattern > Property[key.name="alphaToCoverage"]'( property ) {

				context.report( { node: property.key, messageId: 'found' } );

			},
		};

	},
};

export default {
	meta: { name: 'ponlai' },
	rules: {
		'tsl-method-order': tslMethodOrder,
		'tsl-only': tslOnly,
		'history-on-graph': historyOnGraph,
		'pass-on-graph': passOnGraph,
		'chunk-normals': chunkNormals,
		'no-dynamic-draw': noDynamicDraw,
		'timestamp-owner': timestampOwner,
		'scene-clock': sceneClock,
		'vegetation-tag': vegetationTag,
	},
};
