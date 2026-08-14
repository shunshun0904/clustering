import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages などサブパス配信をする場合は VITE_BASE=/segmentlab/ を渡す
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
