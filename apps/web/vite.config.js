import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// VITE_API_URL points the app at the shared API. Local builds default to the
// development API; Vercel builds stay unconfigured until VITE_API_URL is set
// in the project settings, so no localhost URL is ever shipped by accident.
// A future custom domain changes this value only — never the app architecture.
const apiUrl = process.env.VITE_API_URL
  ?? (process.env.VERCEL ? '' : 'http://127.0.0.1:4000');

// Whether the development sign-in panel is COMPILED IN at all.
//
// The API already refuses /auth/demo outside local development, so shipping
// the panel was never exploitable — but it shipped: the production bundle
// carried the whole TEST profile list, naming every workspace and the exact
// shape of the development bypass, for a control nobody can use. This is a
// build-time constant, so the branch is eliminated rather than hidden, and the
// bundle stops describing a door that is not there.
//
// True for local and CI builds, because the browser suite drives the app
// through that panel; false for anything Vercel builds.
const developmentSignIn = !process.env.VERCEL;

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
  // No source maps are published. Vite's default is already false, but the
  // value that decides whether every module's original source ships next to
  // the bundle should be stated where it can be reviewed, not inherited — and
  // `pnpm secrets:check` fails the build if a .map ever appears in dist.
  build: { sourcemap: false },
  resolve: { dedupe: ['react', 'react-dom'] },
  server: { port: 3003, strictPort: true },
  preview: { port: 4173, strictPort: true },
  define: {
    'import.meta.env.VITE_API_URL': JSON.stringify(apiUrl),
    'import.meta.env.VITE_DEVELOPMENT_SIGN_IN': JSON.stringify(developmentSignIn),
  },
});
