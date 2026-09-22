import js from '@eslint/js';
import globals from 'globals';
import hooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.vercel/**', '.tmp/**', 'playwright-report/**', 'test-results/**', '.claude/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx,mjs}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': hooks },
    rules: {
      ...hooks.configs.recommended.rules,
    },
  },
  {
    // These Playwright route/request guards intentionally assign only after a
    // URL parses successfully, then return immediately from the catch branch.
    // ESLint 10's no-useless-assignment rule currently treats that defensive
    // shape as redundant even though it keeps malformed URLs fail-closed.
    files: [
      'tests/e2e/api-fixture.js',
      'tests/e2e/auth.spec.js',
      'tests/e2e/checkout-auth-timing.spec.js',
      'tests/e2e/home-search.spec.js',
    ],
    rules: { 'no-useless-assignment': 'off' },
  },
];
