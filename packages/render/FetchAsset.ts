// The renderer's and the island's one fetch of the page's data files.
//
// The renderer's and the island's one fetch of the page's assets: the code reads its data files
// (noise volumes, the star catalogue, scans) through `fetchAsset`, never `fetch` itself, so what the
// code takes from the network is in one place (tools/repo/verify-layers.mjs, the page check). Textures
// and models loaded by three's loaders go through their own requests, from the same base address.

/** Fetches an asset by its path under the address the build serves the assets from
 * (`import.meta.env.BASE_URL`: `public/`). */
export function fetchAsset( path: string ): Promise<Response> {

	return fetch( import.meta.env.BASE_URL + path );

}
