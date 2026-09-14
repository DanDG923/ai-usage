import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The packaged renderer talks only to its preload bridge, so its CSP allows
// no network origin. The dev server needs the loopback for HMR, which is
// added to the policy here rather than shipped in dist/.
function devLoopbackCsp() {
  return {
    name: 'dev-loopback-csp',
    apply: 'serve' as const,
    transformIndexHtml(html: string) {
      return html.replace("connect-src 'self'", "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*");
    },
  };
}

export default defineConfig({
  plugins: [react(), devLoopbackCsp()],
  base: './',
  build: {
    target: 'es2022',
    sourcemap: 'hidden',
  },
});
