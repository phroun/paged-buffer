module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    project: './tsconfig.json'
  },
  extends: [
    'standard-with-typescript',
    'plugin:jest/recommended'
  ],
  plugins: [
    '@typescript-eslint',
    'jest'
  ],
  env: {
    node: true,
    jest: true,
    es2020: true
  },
  rules: {
    // TypeScript specific overrides
    '@typescript-eslint/no-unused-vars': ['error', { 
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_'
    }],
    '@typescript-eslint/explicit-function-return-type': 'warn',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-non-null-assertion': 'warn',
    '@typescript-eslint/prefer-nullish-coalescing': 'error',
    '@typescript-eslint/prefer-optional-chain': 'error',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/require-await': 'warn',
    
    // Style preferences
    'indent': 'off', // Let TypeScript ESLint handle this
    '@typescript-eslint/indent': ['error', 2],
    'quotes': 'off', // Let TypeScript ESLint handle this
    '@typescript-eslint/quotes': ['error', 'single', { avoidEscape: true }],
    'semi': 'off', // Let TypeScript ESLint handle this
    '@typescript-eslint/semi': ['error', 'always'],
    'comma-dangle': 'off', // Let TypeScript ESLint handle this
    '@typescript-eslint/comma-dangle': ['error', 'never'],
    
    // Node.js specific
    'no-console': 'warn',
    'no-process-exit': 'error'
  },
  overrides: [
    {
      // Test files
      files: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
      rules: {
        'no-console': 'off',
        '@typescript-eslint/explicit-function-return-type': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off'
      }
    },
    {
      // Configuration files
      files: ['*.config.js', 'jest.config.js', '.eslintrc.js'],
      env: {
        node: true
      },
      rules: {
        'no-console': 'off',
        '@typescript-eslint/no-var-requires': 'off'
      }
    }
  ],
  ignorePatterns: [
    'node_modules/',
    'lib/',
    'coverage/',
    'docs/',
    'reference/',
    '*.min.js',
    '*.d.ts'
  ]
};
