import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { browserAuthDomain } from '../../packages/config/src/firebase.js';

const FIREBASE = {
  apiKey: 'browser-test-api-key',
  authDomain: 'leroutier-df848.firebaseapp.com',
  projectId: 'leroutier-df848',
  appId: '1:1:web:test',
};

test('production Google auth stays on the LeRoutier domain', () => {
  expect(browserAuthDomain(FIREBASE, { hostname: 'leroutier.app' })).toBe('leroutier.app');
  expect(browserAuthDomain(FIREBASE, { hostname: 'www.leroutier.app' })).toBe('www.leroutier.app');
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
