import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  // Ports live in the project-root .env, shared with the server.
  const env = loadEnv(mode, '..', '');
  const apiPort = Number(env.PORT || 4080);
  const clientPort = Number(env.CLIENT_PORT || 5180);
  const api = `http://localhost:${apiPort}`;

  return {
    plugins: [react(), tailwindcss()],
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
