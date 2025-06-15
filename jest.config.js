module.exports = {
  // Use ts-jest preset for TypeScript support
  preset: 'ts-jest',
  
  // Test environment
  testEnvironment: 'node',
  
  // Test file patterns (now targeting TypeScript files)
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/?(*.)+(spec|test).ts'
  ],
  
  // Files to ignore
  testPathIgnorePatterns: [
    '/node_modules/',
    '/lib/',
    '/coverage/',
    '/__tests__/setup.ts',
    '/__tests__/fixtures/',
    '\\.js'
  ],
  
  // Setup files
  setupFilesAfterEnv: [
    '<rootDir>/__tests__/setup.ts'
  ],
  
  // TypeScript transformation - SIMPLIFIED
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        outDir: './lib-test', // Different from main outDir
        noEmit: true,
        isolatedModules: true
      }
    }]
  },
  
  // Module file extensions
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  
  // Module resolution
  moduleDirectories: ['node_modules', 'src'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@types/(.*)$': '<rootDir>/src/types/$1'
  },
  
  // Coverage configuration
  collectCoverage: false, // Enable with --coverage flag
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
    '!src/test-utils.ts',
    '!src/**/*.d.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: [
    'text',
    'text-summary',
    'lcov',
    'html',
    'json'
  ],
  
  // Verbose output
  verbose: false,
  
  // Error handling
  bail: false,
  errorOnDeprecated: true,
  
  // Reporter configuration
  reporters: [
    'default'
  ],
  
  // Clear mocks between tests
  clearMocks: true,
  restoreMocks: true,
  
  // Force exit after tests complete
  forceExit: true,
  
  // Detect hanging processes
  detectOpenHandles: true,
  
  // Memory management for large file tests
  maxWorkers: '50%',
  workerIdleMemoryLimit: '512MB',
  
  // Ignore patterns for watch mode
  watchPathIgnorePatterns: [
    '/lib/',
    '/coverage/',
    '/reference/',
    '/docs/'
  ],
  
  // Setup files
  setupFilesAfterEnv: [
    '<rootDir>/__tests__/setup.ts'
  ],
  
  // TypeScript transformation - SIMPLIFIED
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        outDir: './lib-test', // Different from main outDir
        noEmit: true,
        isolatedModules: true
      }
    }]
  },
  
  // Module file extensions
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  
  // Module resolution
  moduleDirectories: ['node_modules', 'src'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@types/(.*)$': '<rootDir>/src/types/$1'
  },
  
  // Coverage configuration
  collectCoverage: false, // Enable with --coverage flag
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
    '!src/test-utils.ts',
    '!src/**/*.d.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: [
    'text',
    'text-summary',
    'lcov',
    'html',
    'json'
  ],
  
  // Verbose output
  verbose: false,
  
  // Error handling
  bail: false,
  errorOnDeprecated: true,
  
  // Reporter configuration
  reporters: [
    'default'
  ],
  
  // Clear mocks between tests
  clearMocks: true,
  restoreMocks: true,
  
  // Force exit after tests complete
  forceExit: true,
  
  // Detect hanging processes
  detectOpenHandles: true,
  
  // Memory management for large file tests
  maxWorkers: '50%',
  workerIdleMemoryLimit: '512MB',
  
  // Ignore patterns for watch mode
  watchPathIgnorePatterns: [
    '/lib/',
    '/coverage/',
    '/reference/',
    '/docs/'
  ]
};
