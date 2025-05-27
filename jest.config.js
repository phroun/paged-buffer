module.exports = {
  // Test environment
  testEnvironment: 'node',
  
  // Test file patterns
  testMatch: [
    '**/__tests__/**/*.test.js',
    '**/?(*.)+(spec|test).js'
  ],
  
  // Files to ignore
  testPathIgnorePatterns: [
    '/node_modules/',
    '/lib/',
    '/coverage/',
    '/__tests__/setup.js',
    '/__tests__/fixtures/'
  ],
  
  // Setup files
  setupFilesAfterEnv: [
    '<rootDir>/__tests__/setup.js'
  ],
  
  // Coverage configuration
  collectCoverage: false, // Enable with --coverage flag
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/*.test.js',
    '!src/**/*.spec.js',
    '!src/test-utils.js'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: [
    'text',
    'text-summary',
    'lcov',
    'html',
    'json'
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 85,
      lines: 85,
      statements: 85
    }
  },
  
  // Module resolution
  moduleFileExtensions: ['js', 'json', 'node'],
  moduleDirectories: ['node_modules', 'src'],
  
  // Transform configuration (if needed for ES modules)
  transform: {},
  
  // Verbose output
  verbose: false,
  
  // Error handling
  bail: false,
  errorOnDeprecated: true,
  
  // Reporter configuration
  reporters: [
    'default',
    ['jest-junit', {
      outputDirectory: 'coverage',
      outputName: 'junit.xml',
      suiteName: '@phroun/paged-buffer Tests'
    }]
  ],
  
  // Global variables available in tests
  globals: {
    '__DEV__': true,
    '__TEST__': true
  },
  
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
  
  // Test categories using projects (optional advanced setup)
  projects: [
    {
      displayName: 'unit',
      testMatch: [
        '<rootDir>/__tests__/*.test.js'
      ]
    },
    {
      displayName: 'integration', 
      testMatch: [
        '<rootDir>/__tests__/integration/*.test.js'
      ],
      slowTestThreshold: 30
    }
  ]
};
