import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';
export default defineConfig({...base,testIgnore:[],testMatch:/(^|\/)(live\.spec\.js|.*\.live\.spec\.js)$/,workers:1,retries:0,
  projects:[{name:'live-neon',use:{viewport:{width:1280,height:900}}}],
  use:{trace:'off',screenshot:'off',video:'off'},timeout:90_000,
  // Every assertion here waits on a real API, a real PostgreSQL and a real
  // browser, so Playwright's 5 s default is the wrong budget: a mutation
  // followed by a refetch can exceed it on a cold CI runner while being
  // perfectly correct. The test timeout was already 90 s; this makes the
  // per-assertion budget agree with that intent.
  //
  // `retries` stays 0 on purpose. A live suite that needs a second attempt to
  // pass is hiding something, and waiting longer is not the same as retrying.
  expect:{timeout:15_000}});
