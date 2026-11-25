import { Agent } from 'node:http';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { resolveDevPorts } from './dev-ports.ts';

const HOST = '127.0.0.1';

export default defineConfig(() => {
  const ports = resolveDevPorts(process.env);
  const server = {
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
  return {
    plugins: [react()],
    server,
    preview: server,
    test: {
      name: '@rampart/web',
      environment: 'jsdom',
      setupFiles: ['./src/test-setup.ts'],
    },
  };
});
