/**
 * Test setup and utilities for PagedBuffer system
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/**
 * Test utilities and fixtures
 */
class TestUtils {
  constructor() {
    this.tempDir = null;
    this.tempFiles = [];
  }

  /**
   * Setup temporary directory for tests
   */
  async setupTempDir() {
    this.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paged-buffer-test-'));
    return this.tempDir;
  }

  /**
   * Cleanup temporary files and directories
   */
  async cleanup() {
    // Remove temporary files
    for (const file of this.tempFiles) {
      try {
        await fs.unlink(file);
      } catch (error) {
        // Ignore errors - file might not exist
      }
    }
    this.tempFiles = [];

    // Remove temporary directory
    if (this.tempDir) {
      try {
        await fs.rm(this.tempDir, { recursive: true });
      } catch (error) {
        // Ignore errors
      }
      this.tempDir = null;
    }
  }

  /**
   * Create a temporary file with content
   * @param {string|Buffer} content - File content
   * @param {string} suffix - File suffix (e.g., '.txt')
   * @returns {string} - File path
   */
  async createTempFile(content, suffix = '.txt') {
    if (!this.tempDir) {
      await this.setupTempDir();
    }

    const fileName = `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}${suffix}`;
    const filePath = path.join(this.tempDir, fileName);
    
    await fs.writeFile(filePath, content);
    this.tempFiles.push(filePath);
    
    return filePath;
  }

  /**
   * Create a large test file
   * @param {number} sizeInMB - File size in megabytes
   * @param {string} pattern - Repeating pattern (default: line numbers)
   * @returns {string} - File path
   */
  async createLargeFile(sizeInMB, pattern = null) {
    if (!this.tempDir) {
      await this.setupTempDir();
    }

    const fileName = `large-test-${sizeInMB}mb-${Date.now()}.txt`;
    const filePath = path.join(this.tempDir, fileName);
    
    const targetSize = sizeInMB * 1024 * 1024;
    const writeStream = require('fs').createWriteStream(filePath);

    return new Promise((resolve, reject) => {
      let written = 0;
      let lineNumber = 1;

      const writeChunk = () => {
        if (written >= targetSize) {
          writeStream.end();
          this.tempFiles.push(filePath);
          resolve(filePath);
          return;
        }

        let chunk;
        if (pattern) {
          chunk = pattern.repeat(Math.min(1000, Math.ceil((targetSize - written) / pattern.length)));
        } else {
          // Generate realistic log-like content
          const lines = [];
          for (let i = 0; i < 100 && written < targetSize; i++) {
            const timestamp = new Date().toISOString();
            const level = ['INFO', 'WARN', 'ERROR', 'DEBUG'][Math.floor(Math.random() * 4)];
            const message = `Line ${lineNumber++}: Sample log message with some content`;
            lines.push(`${timestamp} [${level}] ${message}`);
          }
          chunk = lines.join('\n') + '\n';
        }

        // Trim chunk if it would exceed target size
        if (written + chunk.length > targetSize) {
          chunk = chunk.substring(0, targetSize - written);
        }

        written += chunk.length;
        writeStream.write(chunk, writeChunk);
      };

      writeStream.on('error', reject);
      writeChunk();
    });
  }

  /**
   * Generate test data with specific patterns
   * @param {string} type - Type of test data
   * @param {number} size - Size in bytes
   * @returns {Buffer} - Generated data
   */
  generateTestData(type, size) {
    switch (type) {
      case 'binary':
        return crypto.randomBytes(size);
      
      case 'ascii':
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 \n';
        let result = '';
        for (let i = 0; i < size; i++) {
          result += chars[Math.floor(Math.random() * chars.length)];
        }
        return Buffer.from(result);
      
      case 'utf8':
        const unicodeChars = 'Hello 世界 🌍 Ñoël Москва العالم 🚀✨';
        let utf8Result = '';
        let byteCount = 0;
        while (byteCount < size) {
          const char = unicodeChars[Math.floor(Math.random() * unicodeChars.length)];
          const charBytes = Buffer.byteLength(char, 'utf8');
          if (byteCount + charBytes <= size) {
            utf8Result += char;
            byteCount += charBytes;
          } else {
            break;
          }
        }
        return Buffer.from(utf8Result, 'utf8');
      
      case 'lines':
        const lines = [];
        let totalBytes = 0;
        let lineNum = 1;
        while (totalBytes < size) {
          const line = `Line ${lineNum++}: This is a test line with some content.\n`;
          if (totalBytes + line.length <= size) {
            lines.push(line);
            totalBytes += line.length;
          } else {
            break;
          }
        }
        return Buffer.from(lines.join(''));
      
      default:
        throw new Error(`Unknown test data type: ${type}`);
    }
  }

  /**
   * Compare two buffers with detailed error reporting
   * @param {Buffer} actual - Actual buffer
   * @param {Buffer} expected - Expected buffer
   * @param {string} context - Context for error reporting
   */
  compareBuffers(actual, expected, context = 'Buffer comparison') {
    if (!Buffer.isBuffer(actual)) {
      throw new Error(`${context}: actual is not a Buffer`);
    }
    if (!Buffer.isBuffer(expected)) {
      throw new Error(`${context}: expected is not a Buffer`);
    }
    
    if (actual.length !== expected.length) {
      throw new Error(`${context}: length mismatch. Expected ${expected.length}, got ${actual.length}`);
    }

    for (let i = 0; i < actual.length; i++) {
      if (actual[i] !== expected[i]) {
        const start = Math.max(0, i - 10);
        const end = Math.min(actual.length, i + 10);
        const actualHex = actual.subarray(start, end).toString('hex');
        const expectedHex = expected.subarray(start, end).toString('hex');
        throw new Error(
          `${context}: byte mismatch at position ${i}.\n` +
          `Expected: ${expectedHex}\n` +
          `Actual:   ${actualHex}\n` +
          `Context: bytes ${start}-${end}`
        );
      }
    }
  }

  /**
   * Wait for a specified number of milliseconds
   * @param {number} ms - Milliseconds to wait
   */
  async wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Create a mock notification handler for testing
   * @returns {Object} - Mock handler with captured notifications
   */
  createMockNotificationHandler() {
    const notifications = [];
    const handler = (notification) => {
      notifications.push({
        type: notification.type,
        severity: notification.severity,
        message: notification.message,
        metadata: notification.metadata,
        timestamp: notification.timestamp
      });
    };

    return {
      handler,
      notifications,
      clear: () => notifications.splice(0),
      getByType: (type) => notifications.filter(n => n.type === type),
      getLatest: () => notifications[notifications.length - 1],
      count: () => notifications.length
    };
  }

  /**
   * Assert that arrays are equal with detailed error reporting
   * @param {Array} actual - Actual array
   * @param {Array} expected - Expected array
   * @param {string} context - Context for error reporting
   */
  compareArrays(actual, expected, context = 'Array comparison') {
    if (!Array.isArray(actual)) {
      throw new Error(`${context}: actual is not an array`);
    }
    if (!Array.isArray(expected)) {
      throw new Error(`${context}: expected is not an array`);
    }
    
    if (actual.length !== expected.length) {
      throw new Error(`${context}: length mismatch. Expected ${expected.length}, got ${actual.length}`);
    }

    for (let i = 0; i < actual.length; i++) {
      if (actual[i] !== expected[i]) {
        throw new Error(`${context}: element mismatch at index ${i}. Expected "${expected[i]}", got "${actual[i]}"`);
      }
    }
  }

  /**
   * Get file statistics
   * @param {string} filePath - Path to file
   * @returns {Object} - File stats
   */
  async getFileStats(filePath) {
    const stats = await fs.stat(filePath);
    return {
      size: stats.size,
      mtime: stats.mtime,
      exists: true
    };
  }

  /**
   * Modify file to simulate external changes
   * @param {string} filePath - Path to file
   * @param {string} operation - 'append', 'prepend', 'modify', 'truncate'
   * @param {string} content - Content for operation
   */
  async modifyFile(filePath, operation, content = '') {
    const originalContent = await fs.readFile(filePath, 'utf8');
    
    let newContent;
    switch (operation) {
      case 'append':
        newContent = originalContent + content;
        break;
      case 'prepend':
        newContent = content + originalContent;
        break;
      case 'modify':
        // Replace middle section
        const midPoint = Math.floor(originalContent.length / 2);
        newContent = originalContent.substring(0, midPoint) + content + originalContent.substring(midPoint + content.length);
        break;
      case 'truncate':
        newContent = originalContent.substring(0, Math.floor(originalContent.length / 2));
        break;
      default:
        throw new Error(`Unknown file operation: ${operation}`);
    }
    
    await fs.writeFile(filePath, newContent);
    return newContent;
  }

  // Direct filesystem methods (to replace testUtils.xxx calls)
  async readFile(filePath, encoding = null) {
    return await fs.readFile(filePath, encoding);
  }

  async writeFile(filePath, content) {
    return await fs.writeFile(filePath, content);
  }

  async unlink(filePath) {
    return await fs.unlink(filePath);
  }

  async chmod(filePath, mode) {
    return await fs.chmod(filePath, mode);
  }

  /**
   * Get a temporary file path without creating the file (for saveAs tests)
   * @param {string} suffix - File suffix (e.g., '.txt')  
   * @returns {string} - File path where a file could be created
   */
  getTempFilePath(suffix = '.txt') {
    if (!this.tempDir) {
      throw new Error('Temp directory not set up. Call setupTempDir() first.');
    }

    const fileName = `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}${suffix}`;
    const filePath = path.join(this.tempDir, fileName);
    
    // Add to tracking so it gets cleaned up
    this.tempFiles.push(filePath);
    
    return filePath;
  }

  /**
   * Check if a file exists
   * @param {string} filePath - Path to check
   * @returns {Promise<boolean>} - True if file exists
   */
  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

// Global test utilities instance
const testUtils = new TestUtils();

// Jest setup and teardown
beforeEach(async () => {
  await testUtils.setupTempDir();
});

afterEach(async () => {
  // Wait for any pending operations to complete
  await new Promise(resolve => setTimeout(resolve, 100));

  // Clear any active timers (more comprehensive approach)
  if (typeof global !== 'undefined') {
    // Look for any objects that might have undo systems with timers
    Object.getOwnPropertyNames(global).forEach(key => {
      try {
        const obj = global[key];
        if (obj && typeof obj === 'object' && obj.undoSystem?.autoCloseTimer) {
          clearTimeout(obj.undoSystem.autoCloseTimer);
          obj.undoSystem.autoCloseTimer = null;
        }
      } catch (error) {
        // Ignore errors during cleanup
      }
    });
  }
 
  await testUtils.cleanup();
});

// Global teardown
afterAll(async () => {
  await testUtils.cleanup();
});

// Export utilities
module.exports = {
  TestUtils,
  testUtils
};
