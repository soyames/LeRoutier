import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// VITE_API_URL points the app at the shared API. Local builds default to the
// development API; Vercel builds stay unconfigured until VITE_API_URL is set
// in the project settings, so no localhost URL is ever shipped by accident.
const apiUrl = process.env.VITE_API_URL
  ?? (process.env.VERCEL ? '' : 'http://127.0.0.1:4000');

// PWA resilience for driver consoles: app shell and static assets are cached
// for offline use. Authenticated API calls are never cached — the offline
// action queue (localStorage) carries pending work until reconnection.
export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: 'autoUpdate',
    manifest: {
      name: 'LeRoutier Conducteur',
      short_name: 'LeRoutier',
      description: 'Console conducteur LeRoutier — feuille de route, contrôle des billets et gains.',
      theme_color: '#d97706',
      background_color: '#f7f9ff',
      display: 'standalone',
      start_url: '/',
    },
    workbox: {
      navigateFallback: '/index.html',
      runtimeCaching: [{
        urlPattern: ({ url, request }) => url.origin === self.location.origin && request.destination === 'document',
        handler: 'NetworkFirst',
      }],
    },
  })],
  resolve: { dedupe: ['react', 'react-dom'] },
  server: { port: 3001, strictPort: true },
  define: { 'import.meta.env.VITE_API_URL': JSON.stringify(apiUrl) },
});
