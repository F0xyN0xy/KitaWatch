import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Tauri dev expects a fixed port
  server: {
    port: 1420,
    host: true,
    strictPort: true,
  },
  build: {
    target: 'es2021',
    // Build the minimal splash as a separate HTML entry so it does not load React.
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        splashscreen: fileURLToPath(new URL('./splashscreen.html', import.meta.url)),
      },
    },
  },
});
