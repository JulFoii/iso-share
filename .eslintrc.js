module.exports = {
  env: {
    node: true,
    es2021: true,
    jest: true
  },
  extends: [
    'eslint:recommended'
  ],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  rules: {
    'indent': ['error', 4],
    'quotes': ['error', 'single'],
    'semi': ['error', 'always'],
    'no-unused-vars': ['error', { 'argsIgnorePattern': '^_' }],
    'no-console': 'off',
    'no-undef': 'error',
    'eqeqeq': 'error',
    'curly': 'error'
  },
  globals: {
    'process': 'readonly',
    'Buffer': 'readonly',
    '__dirname': 'readonly',
    'module': 'readonly',
    'require': 'readonly',
    'exports': 'readonly'
  }
};