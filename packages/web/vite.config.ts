// Serves preview/ over the fixture client: `pnpm --filter @clerq/web preview`.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'preview',
  plugins: [react()],
  clearScreen: false,
  server: { port: 1430, strictPort: true, host: '127.0.0.1' },
  preview: { port: 1430, strictPort: true, host: '127.0.0.1' },
  build: { outDir: 'dist', emptyOutDir: true },
});
