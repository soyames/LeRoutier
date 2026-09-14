import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_API_URL points the app at the shared API. Local builds default to the
// development API; Vercel builds stay unconfigured until VITE_API_URL is set
// in the project settings, so no localhost URL is ever shipped by accident.
const apiUrl = process.env.VITE_API_URL
  ?? (process.env.VERCEL ? '' : 'http://127.0.0.1:4000');

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  server: { port: 3002, strictPort: true },
  define: { 'import.meta.env.VITE_API_URL': JSON.stringify(apiUrl) },
});
