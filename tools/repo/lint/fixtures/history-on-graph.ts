// Fixture for ponlai/history-on-graph (tools/repo/verify-lint.mjs): each line marked `reported` must be
// reported by that rule, and no other line.
import * as THREE from 'three/webgpu';

declare const renderer: THREE.WebGPURenderer;
declare const graph: { addPass( name: string, kind: string, build: ( b: unknown ) => unknown ): void };
const history = new THREE.RenderTarget( 4, 4 ), current = new THREE.RenderTarget( 4, 4 );

// a history copied around the graph, after the frame
export function endFrame(): void {

	renderer.copyTextureToTexture( current.texture, history.texture ); // reported

}
// a copy that is the run of a declared pass
graph.addPass( 'copy', 'callback', () => ( { copy: true, run: () => renderer.copyTextureToTexture( current.texture, history.texture ) } ) );
