import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// VITE_API_URL points the app at the shared API. Local builds default to the
// development API; Vercel builds stay unconfigured until VITE_API_URL is set
// in the project settings, so no localhost URL is ever shipped by accident.
// A future custom domain changes this value only — never the app architecture.
const apiUrl = process.env.VITE_API_URL
  ?? (process.env.VERCEL ? '' : 'http://127.0.0.1:4000');

// One installable LeRoutier PWA. It is branded LeRoutier, not per role: the
// workspace a person lands in is decided after sign-in, from their identity.
// The app shell and static assets are cached for offline use; authenticated
// API calls are never cached, and crew work continues through the existing
// offline action queue (localStorage) until reconnection.
export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: 'prompt',
    manifest: {
      name: 'LeRoutier',
      short_name: 'LeRoutier',
      description: 'LeRoutier — mobilité interurbaine et colis au Bénin. Voyagez, expédiez, conduisez, gérez.',
      lang: 'fr',
      theme_color: '#d97706',
      background_color: '#f7f9ff',
      display: 'standalone',
      orientation: 'portrait',
      start_url: '/',
      scope: '/',
      categories: ['travel', 'navigation'],
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    workbox: {
      navigateFallback: '/index.html',
      navigateFallbackDenylist: [/^\/api\//],
      runtimeCaching: [],
    },
  })],
  resolve: { dedupe: ['react', 'react-dom'] },
  server: { port: 3003, strictPort: true },
  preview: { port: 4176, strictPort: true },
  define: { 'import.meta.env.VITE_API_URL': JSON.stringify(apiUrl) },
});
