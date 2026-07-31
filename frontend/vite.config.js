import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  build: {
    // Output to frontend/dist/ first, then build.js copies to backend/dist/
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
  server: {
    // In dev, proxy /api/* to the backend so relative paths work
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
