/**
 * Test setup and utilities for PagedBuffer system
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { createWriteStream } from 'fs';
import { PagedBuffer } from '../src';

// Type definitions for test utilities
interface FileStats {
  size: number;
  mtime: Date;
  exists: boolean;
}

interface CorruptionTestResult {
  result: Buffer;
  detached: boolean;
  allZeros: boolean;
}

interface MockNotificationHandler {
  handler: (notification: any) => void;
  notifications: any[];
  clear: () => void;
  getByType: (type: string) => any[];
  getLatest: () => any;
  count: () => number;
}

/**
 * Test utilities and fixtures
 */
class TestUtils {
  private tempDir: string | null = null;
  private tempFiles: string[] = [];

  /**
   * Setup temporary directory for tests
   */
  async setupTempDir(): Promise<string> {
    this.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paged-buffer-test-'));
    return this.tempDir;
  }

  /**
   * Cleanup temporary files and directories
   */
  async cleanup(): Promise<void> {
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
   * @param content - File content
   * @param suffix - File suffix (e.g., '.txt')
   * @returns File path
   */
  async createTempFile(content: string | Buffer, suffix: string = '.txt'): Promise<string> {
    if (!this.tempDir) {
      await this.setupTempDir();
    }

    const fileName = `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}${suffix}`;
    const filePath = path.join(this.tempDir!, fileName);
    
    await fs.writeFile(filePath, content);
    this.tempFiles.push(filePath);
    
    return filePath;
  }

  /**
   * Create a large test file
   * @param sizeInMB - File size in megabytes
   * @param pattern - Repeating pattern (default: line numbers)
   * @returns File path
   */
  async createLargeFile(sizeInMB: number, pattern: string | null = null): Promise<string> {
    if (!this.tempDir) {
      await this.setupTempDir();
    }

    const fileName = `large-test-${sizeInMB}mb-${Date.now()}.txt`;
    const filePath = path.join(this.tempDir!, fileName);
    
    const targetSize = sizeInMB * 1024 * 1024;
    const writeStream = createWriteStream(filePath);

    return new Promise<string>((resolve, reject) => {
      let written = 0;
      let lineNumber = 1;

      const writeChunk = (): void => {
        if (written >= targetSize) {
          writeStream.end();
          this.tempFiles.push(filePath);
          resolve(filePath);
          return;
        }

        let chunk: string;
        if (pattern) {
          chunk = pattern.repeat(Math.min(1000, Math.ceil((targetSize - written) / pattern.length)));
        } else {
          // Generate realistic log-like content
          const lines: string[] = [];
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
   * @param type - Type of test data
   * @param size - Size in bytes
   * @returns Generated data
   */
  generateTestData(type: 'binary' | 'ascii' | 'utf8' | 'lines', size: number): Buffer {
    switch (type) {
      case 'binary':
        return crypto.randomBytes(size);
      
      case 'ascii': {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 \n';
        let result = '';
        for (let i = 0; i < size; i++) {
          result += chars[Math.floor(Math.random() * chars.length)];
        }
        return Buffer.from(result);
      }
      
      case 'utf8': {
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
      }
      
      case 'lines': {
        const lines: string[] = [];
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
      }
      
      default:
        throw new Error(`Unknown test data type: ${type}`);
    }
  }

  /**
   * Compare two buffers with detailed error reporting
   * @param actual - Actual buffer
   * @param expected - Expected buffer
   * @param context - Context for error reporting
   */
  compareBuffers(actual: Buffer, expected: Buffer, context: string = 'Buffer comparison'): void {
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
   * @param ms - Milliseconds to wait
   */
  async wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Create a mock notification handler for testing
   * @returns Mock handler with captured notifications
   */
  createMockNotificationHandler(): MockNotificationHandler {
    const notifications: any[] = [];
    const handler = (notification: any): void => {
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
      clear: (): void => { notifications.splice(0); },
      getByType: (type: string): any[] => notifications.filter(n => n.type === type),
      getLatest: (): any => notifications[notifications.length - 1],
      count: (): number => notifications.length
    };
  }

  /**
   * Assert that arrays are equal with detailed error reporting
   * @param actual - Actual array
   * @param expected - Expected array
   * @param context - Context for error reporting
   */
  compareArrays<T>(actual: T[], expected: T[], context: string = 'Array comparison'): void {
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
   * @param filePath - Path to file
   * @returns File stats
   */
  async getFileStats(filePath: string): Promise<FileStats> {
    const stats = await fs.stat(filePath);
    return {
      size: stats.size,
      mtime: stats.mtime,
      exists: true
    };
  }

  /**
   * Modify file to simulate external changes
   * @param filePath - Path to file
   * @param operation - 'append', 'prepend', 'modify', 'truncate'
   * @param content - Content for operation
   */
  async modifyFile(filePath: string, operation: 'append' | 'prepend' | 'modify' | 'truncate', content: string = ''): Promise<string> {
    const originalContent = await fs.readFile(filePath, 'utf8');
    
    let newContent: string;
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
  async readFile(filePath: string, encoding?: BufferEncoding): Promise<string>;
  async readFile(filePath: string): Promise<Buffer>;
  async readFile(filePath: string, encoding?: BufferEncoding): Promise<string | Buffer> {
    if (encoding) {
      return await fs.readFile(filePath, encoding);
    }
    return await fs.readFile(filePath);
  }

  async writeFile(filePath: string, content: string | Buffer): Promise<void> {
    return await fs.writeFile(filePath, content);
  }

  async unlink(filePath: string): Promise<void> {
    return await fs.unlink(filePath);
  }

  async chmod(filePath: string, mode: string | number): Promise<void> {
    return await fs.chmod(filePath, mode);
  }

  /**
   * Get a temporary file path without creating the file (for saveAs tests)
   * @param suffix - File suffix (e.g., '.txt')  
   * @returns File path where a file could be created
   */
  getTempFilePath(suffix: string = '.txt'): string {
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
   * @param filePath - Path to check
   * @returns True if file exists
   */
  async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Force cache invalidation for corruption testing
   * This ensures the VPM will try to read from the source file again
   * @param buffer - Buffer instance
   */
  forceSourceReload(buffer: PagedBuffer): void {
    if (!(buffer as any).virtualPageManager) return;
    
    const vpm = (buffer as any).virtualPageManager;
    
    // Clear all caches and force reload from source
    if (vpm.pageCache) vpm.pageCache.clear();
    if (vpm.loadedPages) vpm.loadedPages.clear();
    if (vpm.lruOrder) vpm.lruOrder.length = 0;
    
    // Reset page descriptors
    if (vpm.addressIndex && vpm.addressIndex.pages) {
      for (const descriptor of vpm.addressIndex.pages) {
        if (descriptor.sourceType === 'original') {
          descriptor.isLoaded = false;
        }
      }
    }
  }

  /**
   * Force cache invalidation for only unmodified original pages
   * This preserves modified pages while ensuring unmodified regions trigger source reads
   * @param buffer - Buffer instance
   */
  forceUnmodifiedSourceReload(buffer: PagedBuffer): void {
    if (!(buffer as any).virtualPageManager) return;
    
    const vpm = (buffer as any).virtualPageManager;
    
    // Only clear unmodified original pages
    if (vpm.pageCache && vpm.loadedPages && vpm.addressIndex) {
      for (const [pageKey, pageInfo] of vpm.pageCache) {
        const descriptor = vpm.addressIndex.pages.find((p: any) => p.pageKey === pageKey);
        if (descriptor && descriptor.sourceType === 'original' && !descriptor.isDirty) {
          vpm.pageCache.delete(pageKey);
          vpm.loadedPages.delete(pageKey);
          descriptor.isLoaded = false;
          
          // Remove from LRU order
          const lruIndex = vpm.lruOrder.indexOf(pageKey);
          if (lruIndex >= 0) {
            vpm.lruOrder.splice(lruIndex, 1);
          }
        }
      }
    }
  }

  /**
   * Test corruption detection by reading from a specific range
   * @param buffer - Buffer instance
   * @param start - Start position
   * @param end - End position
   * @returns Result with corruption detection info
   */
  async testCorruptionDetection(buffer: PagedBuffer, start: number, end: number): Promise<CorruptionTestResult> {
    this.forceUnmodifiedSourceReload(buffer);
    
    const result = await buffer.getBytes(start, end);
    const detached = buffer.getState() === 'detached';
    const allZeros = result.length > 0 && result.every(byte => byte === 0);
    
    return { result, detached, allZeros };
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
        const obj = (global as any)[key];
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
export {
  TestUtils,
  testUtils,
  type FileStats,
  type CorruptionTestResult,
  type MockNotificationHandler
};
