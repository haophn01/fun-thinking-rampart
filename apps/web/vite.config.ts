import { Agent } from 'node:http';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { resolveDevPorts } from './dev-ports.ts';

const HOST = '127.0.0.1';

/** Dev and preview: Vite on WEB_PORT, with `/api` proxied to the api on API_PORT. */
function devServer() {
  const ports = resolveDevPorts(process.env);
  return {
    host: HOST,
    port: ports.web,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://${HOST}:${String(ports.api)}`,
        agent: new Agent({ keepAlive: true }),
      },
    },
  };
}

export default defineConfig(({ command }) => {
  // A build serves nothing, so it reads no ports: `pnpm start` builds whatever they are.
  const servers = command === 'build' ? {} : { server: devServer(), preview: devServer() };
  return {
    plugins: [react()],
    ...servers,
    build: {
      // Every asset is a file: a data: URI would be blocked by the CSP (img-src/font-src 'self').
      assetsInlineLimit: 0,
    },
    test: {
      name: '@rampart/web',
      environment: 'jsdom',
      setupFiles: ['./src/test-setup.ts'],
    },
  };
});
