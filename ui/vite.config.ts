import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The Bun backend in ../src/api.ts owns /api. Proxying keeps the browser same-origin,
// which matters for SSE (no CORS preflight on every stream).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5000',
        changeOrigin: true,
      },
      // report.html is a standalone self-contained page the server writes next to itself —
      // it is not a UI route. Without this, Vite's SPA fallback answers the link with
      // index.html, so the "open report" links silently reload the app instead.
      '/report.html': {
        target: 'http://127.0.0.1:5000',
        changeOrigin: true,
      },
    },
  },
})
