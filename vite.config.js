import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // В dev-режиме запросы к /api проксируются на реальный API,
  // поэтому браузер не упирается в CORS.
  const apiTarget =
    env.VITE_DEV_API_TARGET || process.env.VITE_DEV_API_TARGET || 'http://194.158.195.62:41290';

  return {
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          secure: false,
        },
      },
    },
    preview: {
      host: '0.0.0.0',
      port: 4173,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          secure: false,
        },
      },
    },
    build: {
      target: 'es2020',
      sourcemap: false,
    },
  };
});
