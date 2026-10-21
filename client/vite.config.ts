import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  // client/.env (plus .env.local / .env.[mode] if present). Only VITE_-prefixed
  // variables ever reach browser code; these two only configure the dev server.
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), '');
  const clientPort = Number(env.CLIENT_PORT || 5180);
  const api = env.API_URL || 'http://localhost:4080';

  return {
    plugins: [react(), tailwindcss()],
    // ffmpeg.wasm starts its own worker from its package files; pre-bundling breaks that.
    optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] },
    worker: { format: 'es' },
    server: {
      port: clientPort,
      strictPort: true,
      host: true,
      proxy: {
        '/api': api,
        '/socket.io': { target: api, ws: true },
      },
    },
    preview: { port: clientPort, strictPort: true },
  };
});
