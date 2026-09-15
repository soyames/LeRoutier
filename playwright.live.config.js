import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';
export default defineConfig({...base,testIgnore:[],testMatch:/(^|\/)(live\.spec\.js|.*\.live\.spec\.js)$/,workers:1,retries:0,
  projects:[{name:'live-neon',use:{viewport:{width:1280,height:900}}}],
  use:{trace:'off',screenshot:'off',video:'off'},timeout:90_000});
