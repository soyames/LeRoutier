import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { browserAuthDomain } from '../../packages/config/src/firebase.js';

const FIREBASE = {
  apiKey: 'browser-test-api-key',
  authDomain: 'leroutier-df848.firebaseapp.com',
  projectId: 'leroutier-df848',
  appId: '1:1:web:test',
};

test('production Google auth resolves every branded host to the one registered auth origin', () => {
  // Google Cloud authorizes exactly one redirect URI (the apex handler). Both
  // hosts the platform may serve must therefore converge on the apex —
  // mirroring the serving hostname produced a second, unregistered URI.
  expect(browserAuthDomain(FIREBASE, { hostname: 'leroutier.app' })).toBe('leroutier.app');
  expect(browserAuthDomain(FIREBASE, { hostname: 'www.leroutier.app' })).toBe('leroutier.app');
});

test('local development keeps the configured Firebase helper domain', () => {
  expect(browserAuthDomain(FIREBASE, { hostname: '127.0.0.1' })).toBe('leroutier-df848.firebaseapp.com');
  expect(browserAuthDomain(FIREBASE, { hostname: 'localhost' })).toBe('leroutier-df848.firebaseapp.com');
});

test('the auth helper is reverse proxied and excluded from app frame-deny headers', () => {
  const config = JSON.parse(fs.readFileSync('apps/web/vercel.json', 'utf8'));
  const helper = config.rewrites.find(rule => rule.source === '/__/auth/:path*');
  expect(helper?.destination).toBe('https://leroutier-df848.firebaseapp.com/__/auth/:path*');

  const broadSecurityRule = config.headers.find(rule => rule.headers?.some(header => header.key === 'X-Frame-Options'));
  expect(broadSecurityRule?.source).toContain('(?!__/auth/)');
});

test('the installed PWA service worker never answers Firebase auth helper navigations', () => {
  // The OAuth callback is a same-origin navigation and the auth iframe is a
  // frame navigation; the navigation fallback used to answer both with the
  // cached app shell, which killed Google sign-in wherever the service worker
  // controlled the page — exactly the installed PWA.
  const vite = fs.readFileSync('apps/web/vite.config.js', 'utf8');
  const denylist = vite.match(/navigateFallbackDenylist:\s*\[([^\]]*)\]/);
  expect(denylist?.[1] ?? '').toContain('/^\\/__\\/auth\\//');
});

test('the CSP allows the pinned helper origin from either branded host', () => {
  // With the auth origin pinned to the apex, the helper iframe/popup URL is
  // apex even when the app serves on www — the frame directive must allow it.
  const config = JSON.parse(fs.readFileSync('apps/web/vercel.json', 'utf8'));
  const csp = config.headers.map(rule => rule.headers ?? []).flat()
    .find(header => header.key === 'Content-Security-Policy')?.value ?? '';
  expect(csp).toContain('frame-src \'self\' https://*.leroutier.app');
});
