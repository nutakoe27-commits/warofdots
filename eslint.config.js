import js from '@eslint/js';
import ts from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Flat ESLint config.
 *
 * The important rule in here is the `src/core` + `src/ai` restriction block:
 * the simulation must stay deterministic and DOM-free, so the globals that
 * would silently break replays are hard errors rather than review comments.
 */
export default ts.config(
  { ignores: ['dist', 'coverage', 'node_modules', '*.timestamp-*'] },

  js.configs.recommended,
  ...ts.configs.recommended,
  prettier,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.es2022 },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-explicit-any': 'error',
      // `noUncheckedIndexedAccess` types every typed-array read as `number | undefined`.
      // The SoA simulation reads them millions of times per second and the bounds are
      // already guaranteed by `count`/`capacity`, so `!` is the zero-cost escape hatch.
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': [
        'error',
        { max: 70, skipBlankLines: true, skipComments: true, IIFEs: true },
      ],
      complexity: ['error', 26],
    },
  },

  {
    files: ['src/core/**/*.ts', 'src/ai/**/*.ts'],
    languageOptions: { globals: { ...globals.es2022 } },
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'src/core and src/ai must stay DOM-free.' },
        { name: 'document', message: 'src/core and src/ai must stay DOM-free.' },
        { name: 'performance', message: 'Non-deterministic. Timing belongs in src/game.' },
        { name: 'requestAnimationFrame', message: 'src/core and src/ai must stay DOM-free.' },
        { name: 'localStorage', message: 'src/core and src/ai must stay DOM-free.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use world.rng (src/core/rng.ts).' },
        { object: 'Date', property: 'now', message: 'Non-deterministic. Use world.tick.' },
        { object: 'performance', property: 'now', message: 'Non-deterministic. Use world.tick.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'Non-deterministic. Use world.tick.',
        },
      ],
    },
  },

  {
    files: ['src/core/balance.ts'],
    rules: { 'max-lines': 'off' },
  },

  {
    files: ['tools/**/*.ts', 'vite.config.ts', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off' },
  },

  {
    files: ['tests/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      'no-console': 'off',
    },
  },
);
