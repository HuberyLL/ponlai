// The renderer's browser exit: the host a scene takes from a browser page.
//
// The renderer's browser exit: `browserHost`, the host (assemble/SceneHost.ts) a running scene
// takes from a browser page: the window, the document, the loading screen, the globals. Only the
// page (the app layer) takes it (tools/repo/verify-layers.mjs), so no other package reads the
// browser through the renderer. It holds re-exports only.
export { browserHost } from './assemble/BrowserHost.ts';
