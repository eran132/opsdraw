import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the same build works inside the Tauri shell.
  base: './',
  server: { port: 5173 },
  preview: { port: 4173 },
});
