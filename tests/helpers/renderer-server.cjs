'use strict';

// A Vite server in middleware mode, for tests that load renderer modules with
// server.ssrLoadModule. It registers no hooks: each test starts and closes its
// own. Vite and the React plugin are imported only when a server is started.

const { repoRoot } = require('./repo.cjs');

async function startRendererServer({ react = true } = {}) {
  const [{ createServer }, plugin] = await Promise.all([import('vite'), react ? import('@vitejs/plugin-react') : null]);
  return createServer({
    root: repoRoot,
    configFile: false,
    ...(react ? { plugins: [plugin.default()] } : {}),
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: 'custom',
  });
}

module.exports = { startRendererServer };
