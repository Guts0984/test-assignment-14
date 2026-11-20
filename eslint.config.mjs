import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

const NEST_FILES = [
  'apps/api/src/**/*.{module,controller,service,guard,filter,interceptor,pipe,gateway,dto,exception}.ts',
  'apps/api/src/**/dto/**/*.ts',
  'apps/worker/src/**/*.{module,service}.ts',
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/generated/**', 'apps/web/next-env.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': 'allow-with-description', 'ts-expect-error': 'allow-with-description', 'ts-nocheck': true, minimumDescriptionLength: 10 },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: 'ClassDeclaration', message: 'Classes are only allowed for NestJS constructs and generated DTOs.' },
        { selector: 'ThisExpression', message: 'No `this`: use functions and closures.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: 'Read configuration only through src/config/env.ts.' },
      ],
      'no-restricted-exports': ['error', { restrictDefaultExports: { direct: true, named: true, defaultFrom: true, namedFrom: true } }],
    },
  },
  {
    // Nest constructs may declare classes and use `this`
    files: NEST_FILES,
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // env.ts is the only reader of process.env
    files: ['apps/*/src/config/env.ts', 'infra/*/src/config/env.ts', 'apps/api/src/config/seed-env.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    // test code may read the environment and use looser helpers
    files: ['**/*.test.{ts,tsx}', '**/test/**/*.ts', 'packages/testkit/src/**/*.ts', 'apps/*/e2e/**/*.ts', 'apps/web/playwright.config.ts', '**/vitest*.config.ts', 'apps/web/next.config.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    // tool configs and Next route files require default exports
    files: ['**/*.config.{ts,mjs,js}', 'apps/web/middleware.ts', 'apps/web/src/app/i18n/request.ts', 'packages/testkit/src/global-setup.ts', 'apps/web/app/**/{page,layout,loading,error,not-found,template,default}.tsx'],
    rules: { 'no-restricted-exports': 'off' },
  },
  {
    // Feature-Sliced Design for the web app: a layer may only import from layers below it, never sideways between
    // slices of one layer, and only through a slice's public API (index.ts).
    files: ['apps/web/src/**/*.{ts,tsx}', 'apps/web/app/**/*.{ts,tsx}', 'apps/web/middleware.ts'],
    plugins: { boundaries },
    settings: {
      'import/resolver': { typescript: { project: 'apps/web/tsconfig.json' } },
      'boundaries/elements': [
        { type: 'routes', pattern: ['apps/web/app/**', 'apps/web/middleware.ts'], mode: 'file' },
        { type: 'config', pattern: 'apps/web/src/config', mode: 'folder' },
        { type: 'app', pattern: 'apps/web/src/app', mode: 'folder' },
        { type: 'pages', pattern: 'apps/web/src/pages/*', mode: 'folder', capture: ['slice'] },
        { type: 'widgets', pattern: 'apps/web/src/widgets/*', mode: 'folder', capture: ['slice'] },
        { type: 'features', pattern: 'apps/web/src/features/*', mode: 'folder', capture: ['slice'] },
        { type: 'entities', pattern: 'apps/web/src/entities/*', mode: 'folder', capture: ['slice'] },
        { type: 'shared', pattern: 'apps/web/src/shared', mode: 'folder' },
      ],
      'boundaries/ignore': ['**/*.test.{ts,tsx}'],
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: 'routes', allow: ['app', 'pages', 'shared', 'config'] },
            { from: 'app', allow: ['pages', 'widgets', 'features', 'entities', 'shared', 'config'] },
            { from: 'pages', allow: ['widgets', 'features', 'entities', 'shared', 'config'] },
            { from: 'widgets', allow: ['features', 'entities', 'shared', 'config'] },
            { from: 'features', allow: ['entities', 'shared', 'config'] },
            { from: 'entities', allow: ['shared', 'config'] },
            { from: 'shared', allow: ['config'] },
            { from: 'config', allow: [] },
          ],
        },
      ],
      'boundaries/entry-point': [
        'error',
        {
          default: 'disallow',
          rules: [
            { target: ['pages', 'widgets', 'features', 'entities'], allow: 'index.{ts,tsx}' },
            { target: ['app', 'shared', 'config', 'routes'], allow: '**' },
          ],
        },
      ],
    },
  },
  { files: ['**/*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly' } }, rules: { 'no-console': 'off', 'no-restricted-properties': 'off' } },
);
