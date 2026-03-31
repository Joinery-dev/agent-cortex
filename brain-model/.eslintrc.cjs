// ESLint legacy .eslintrc.cjs format chosen over flat config for mature IDE plugin support.
// Flat config has spotty red-squiggle reliability in VSCode (as of 2026) — legacy format
// provides reliable feedback during Three.js component work. Do not "upgrade" without
// validating IDE integration first.
module.exports = {
  root: true,
  env: {
    browser: true,
    es2020: true,
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
    'plugin:jsx-a11y/recommended',
    'prettier', // must be last — disables rules that conflict with Prettier
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'react', 'react-hooks', 'jsx-a11y'],
  rules: {
    'react/react-in-jsx-scope': 'off', // React 17+ JSX transform
    'react/prop-types': 'off', // TypeScript handles prop validation
  },
  settings: {
    react: {
      version: 'detect',
    },
  },
};
