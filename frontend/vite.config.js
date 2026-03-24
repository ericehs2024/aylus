import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  build: {
    // Output directly into the backend's dist folder
    outDir: path.resolve(__dirname, '../backend/dist'),
    emptyOutDir: true,
  },
  server: {
    // In dev, proxy /api/* to the backend so relative paths work
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
