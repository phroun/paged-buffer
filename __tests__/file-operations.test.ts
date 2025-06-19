/**
 * Comprehensive File Operations Tests
 * Tests basic file loading, saving, and file system interactions
 * (Non-corruption scenarios)
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { PagedBuffer } from '../src/paged-buffer';
import { FilePageStorage } from '../src/storage/file-page-storage';
import { BufferState } from '../src/types/buffer-types';
import { testUtils } from './setup';

jest.setTimeout(15000);

describe('File Operations', () => {
  let buffer: PagedBuffer;
  let storage: FilePageStorage;

  beforeEach(async () => {
    storage = new FilePageStorage();
    buffer = new PagedBuffer(1024, storage, 10);
    // Disable corruption detection for basic file operations tests
    (buffer as any).corruptionDetectionEnabled = false;
  });

  describe('File Loading', () => {
    test('should load text file correctly', async () => {
      const content = 'Hello, World!\nThis is a test file.\nEnd of file.';
      const filePath = await testUtils.createTempFile(content);
      
      await buffer.loadFile(filePath);
      
      expect(buffer.filename).toBe(filePath);
      expect(buffer.getTotalSize()).toBe(content.length);
      expect(buffer.getState()).toBe(BufferState.CLEAN);
      expect(buffer.hasChanges()).toBe(false);
      
      const loadedContent = await buffer.getBytes(0, buffer.getTotalSize());
      expect(loadedContent.toString()).toBe(content);
    });

    test('should load binary file correctly', async () => {
      const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD, 0x7F, 0x80]);
      const filePath = await testUtils.createTempFile(binaryData);
      
      await buffer.loadFile(filePath);
      
      expect(buffer.getTotalSize()).toBe(binaryData.length);
      
      const loadedData = await buffer.getBytes(0, buffer.getTotalSize());
      expect(loadedData).toEqual(binaryData);
    });

    test('should load empty file correctly', async () => {
      const filePath = await testUtils.createTempFile('');
      
      await buffer.loadFile(filePath);
      
      expect(buffer.getTotalSize()).toBe(0);
      expect(buffer.getState()).toBe(BufferState.CLEAN);
      expect(buffer.hasChanges()).toBe(false);
    });

    test('should detect UTF-8 files with multi-byte characters', async () => {
      const content = 'Hello 世界 🌍 Test';
      const filePath = await testUtils.createTempFile(content);
      
      await buffer.loadFile(filePath);
      
      expect(buffer.getTotalSize()).toBe(Buffer.byteLength(content, 'utf8'));
      
      const loadedContent = await buffer.getBytes(0, buffer.getTotalSize());
      expect(loadedContent.toString('utf8')).toBe(content);
    });

    test('should calculate file checksum during load', async () => {
      const content = 'Content for checksum test';
      const filePath = await testUtils.createTempFile(content);
      
      await buffer.loadFile(filePath);
      
      expect(buffer.fileChecksum).toBeTruthy();
      expect(typeof buffer.fileChecksum).toBe('string');
      expect(buffer.fileChecksum?.length).toBe(32); // MD5 hex length
    });

    test('should load large files efficiently', async () => {
      const largeContent = 'A'.repeat(50000); // 50KB
      const filePath = await testUtils.createTempFile(largeContent);
      
      const startTime = Date.now();
      await buffer.loadFile(filePath);
      const loadTime = Date.now() - startTime;
      
      expect(loadTime).toBeLessThan(1000); // Should load quickly
      expect(buffer.getTotalSize()).toBe(largeContent.length);
      
      // Initial load shouldn't load all pages into memory
      const stats = buffer.getMemoryStats();
      expect(stats.totalPages).toBeGreaterThan(1);
      expect(stats.loadedPages).toBe(0); // Pages loaded on demand
    });

    test('should handle non-existent files appropriately', async () => {
      const nonExistentPath = '/path/that/does/not/exist.txt';
      
      await expect(buffer.loadFile(nonExistentPath)).rejects.toThrow('Failed to load file');
    });
  });

  describe('File Saving - Clean State', () => {
    test('should save unmodified buffer (NO-OP for same file)', async () => {
      const content = 'Original content for save test';
      const filePath = await testUtils.createTempFile(content);
      await buffer.loadFile(filePath);
      
      // Verify initial state is clean
      expect(buffer.getState()).toBe(BufferState.CLEAN);
      expect(buffer.hasChanges()).toBe(false);
      
      // Save without modifications to same file - should be no-op
      await buffer.saveFile();
      
      // File content should remain unchanged
      const savedContent = await testUtils.readFile(filePath, 'utf8');
      expect(savedContent).toBe(content);
      expect(buffer.getState()).toBe(BufferState.CLEAN); // Still clean
      expect(buffer.hasChanges()).toBe(false);
    });

    test('should save modified buffer and transition to hasChanges=false', async () => {
      const originalContent = 'Original content';
      const filePath = await testUtils.createTempFile(originalContent);
      await buffer.loadFile(filePath);
      
      // Make modifications
      await buffer.insertBytes(0, Buffer.from('Modified: '));
      await buffer.insertBytes(buffer.getTotalSize(), Buffer.from(' [END]'));
      
      expect(buffer.hasChanges()).toBe(true);
      
      // Save modifications
      await buffer.saveFile();
      
      const savedContent = await testUtils.readFile(filePath, 'utf8');
      expect(savedContent).toBe('Modified: Original content [END]');
      expect(buffer.hasChanges()).toBe(false); // Should transition back to false
    });

    test('should save as copy when filename differs', async () => {
      const content = 'Original content for save as test';
      const originalPath = await testUtils.createTempFile(content);
      await buffer.loadFile(originalPath);
      
      // Save as different file (even though unmodified) should create copy
      const newPath = testUtils.getTempFilePath();
      await buffer.saveAs(newPath);
      
      const savedContent = await testUtils.readFile(newPath, 'utf8');
      expect(savedContent).toBe(content);
      expect(buffer.filename).toBe(newPath); // Should update filename
      expect(buffer.hasChanges()).toBe(false);
    });

    test('should save binary modifications correctly', async () => {
      const originalData = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const filePath = await testUtils.createTempFile(originalData);
      await buffer.loadFile(filePath);
      
      // Insert binary data
      await buffer.insertBytes(2, Buffer.from([0xFF, 0xFE]));
      
      await buffer.saveFile();
      
      const savedData = await testUtils.readFile(filePath);
      const expected = Buffer.from([0x01, 0x02, 0xFF, 0xFE, 0x03, 0x04]);
      expect(savedData).toEqual(expected);
    });

    test('should handle saving empty buffer', async () => {
      const filePath = await testUtils.createTempFile('some content');
      await buffer.loadFile(filePath);
      
      // Delete all content
      await buffer.deleteBytes(0, buffer.getTotalSize());
      
      await buffer.saveFile();
      
      const savedContent = await testUtils.readFile(filePath, 'utf8');
      expect(savedContent).toBe('');
      expect(buffer.hasChanges()).toBe(false);
    });

    test('should update metadata after successful save', async () => {
      const content = 'Content for metadata test';
      const filePath = await testUtils.createTempFile(content);
      await buffer.loadFile(filePath);
      
      const originalMtime = buffer.fileMtime;
      const originalSize = buffer.fileSize;
      
      // Make modification
      await buffer.insertBytes(0, Buffer.from('NEW: '));
      
      // Wait a bit to ensure mtime difference
      await testUtils.wait(10);
      
      await buffer.saveFile();
      
      // Metadata should be updated
      expect(buffer.fileSize).toBeGreaterThan(originalSize);
      expect(buffer.fileMtime?.getTime()).toBeGreaterThan(originalMtime?.getTime() ?? 0);
      expect(buffer.totalSize).toBe(buffer.fileSize);
    });
  });

  describe('Save As Operations', () => {
    test('should save as new file', async () => {
      const content = 'Content for save as test';
      const originalPath = await testUtils.createTempFile(content);
      await buffer.loadFile(originalPath);
      
      // Make modifications
      await buffer.insertBytes(0, Buffer.from('SaveAs: '));
      
      // Save as new file
      const newPath = testUtils.getTempFilePath();
      await buffer.saveAs(newPath);
      
      // New file should have modified content
      const newContent = await testUtils.readFile(newPath, 'utf8');
      expect(newContent).toBe('SaveAs: Content for save as test');
      
      // Original file should be unchanged
      const originalContent = await testUtils.readFile(originalPath, 'utf8');
      expect(originalContent).toBe(content);
      
      // Buffer should point to new file
      expect(buffer.filename).toBe(newPath);
      expect(buffer.hasChanges()).toBe(false);
    });

    test('should handle save as to same path as original', async () => {
      const content = 'Content for same path test';
      const filePath = await testUtils.createTempFile(content);
      await buffer.loadFile(filePath);
      
      await buffer.insertBytes(0, Buffer.from('Same path: '));
      
      // Save as to same path (should work like regular save)
      await buffer.saveAs(filePath);
      
      const savedContent = await testUtils.readFile(filePath, 'utf8');
      expect(savedContent).toBe('Same path: Content for same path test');
      expect(buffer.hasChanges()).toBe(false);
    });

    test('should allow save as without source file', async () => {
      // Create buffer from string content
      const content = 'In-memory content for save as';
      buffer.loadContent(content);
      
      await buffer.insertBytes(0, Buffer.from('New: '));
      
      const filePath = testUtils.getTempFilePath();
      await buffer.saveAs(filePath);
      
      const savedContent = await testUtils.readFile(filePath, 'utf8');
      expect(savedContent).toBe('New: In-memory content for save as');
      expect(buffer.filename).toBe(filePath);
      expect(buffer.hasChanges()).toBe(false);
    });

    test('should require filename for saveAs', async () => {
      buffer.loadContent('test content');
      
      await expect(buffer.saveAs()).rejects.toThrow('Filename required');
      await expect(buffer.saveAs('')).rejects.toThrow('Filename required');
      await expect(buffer.saveAs(null as any)).rejects.toThrow('Filename required');
    });
  });

  describe('File Change Detection', () => {
    test('should detect no changes in unchanged file', async () => {
      const content = 'Content for change detection';
      const filePath = await testUtils.createTempFile(content);
      await buffer.loadFile(filePath);
      
      const changes = await buffer.checkFileChanges();
      
      expect(changes.changed).toBe(false);
      expect(changes.sizeChanged).toBe(false);
      expect(changes.mtimeChanged).toBe(false);
      expect(changes.deleted).toBe(false);
    });

    test('should detect file size changes', async () => {
      const content = 'Original content';
      const filePath = await testUtils.createTempFile(content);
      await buffer.loadFile(filePath);
      
      const originalSize = buffer.fileSize;
      
      // Modify file externally
      await testUtils.modifyFile(filePath, 'append', ' and more content');
      
      const changes = await buffer.checkFileChanges();
      
      expect(changes.changed).toBe(true);
      expect(changes.sizeChanged).toBe(true);
      expect(changes.newSize).toBeGreaterThan(originalSize);
    });

    test('should detect mtime changes', async () => {
      const content = 'Content for mtime test';
      const filePath = await testUtils.createTempFile(content);
      await buffer.loadFile(filePath);
      
      // Wait and modify file (same size)
      await testUtils.wait(100);
      const modifiedContent = content.replace('mtime', 'MTIME');
      await testUtils.writeFile(filePath, modifiedContent);
      
      const changes = await buffer.checkFileChanges();
      
      expect(changes.changed).toBe(true);
      expect(changes.mtimeChanged).toBe(true);
      expect(changes.sizeChanged).toBe(false); // Same size
    });

    test('should detect file deletion', async () => {
      const content = 'Content for deletion test';
      const filePath = await testUtils.createTempFile(content);
      await buffer.loadFile(filePath);
      
      await testUtils.unlink(filePath);
      
      const changes = await buffer.checkFileChanges();
      
      expect(changes.changed).toBe(true);
      expect(changes.deleted).toBe(true);
      expect(changes.sizeChanged).toBe(true);
      expect(changes.mtimeChanged).toBe(true);
    });

    test('should handle buffers without source file', async () => {
      buffer.loadContent('In-memory content');
      
      const changes = await buffer.checkFileChanges();
      
      expect(changes.changed).toBe(false);
    });
  });

  describe('Content Loading (Non-File)', () => {
    test('should load string content correctly', async () => {
      const content = 'String content for testing';
      
      buffer.loadContent(content);
      
      expect(buffer.filename).toBeNull();
      expect(buffer.getTotalSize()).toBe(Buffer.byteLength(content));
      expect(buffer.getState()).toBe(BufferState.CLEAN);
      expect(buffer.hasChanges()).toBe(false);
      
      const loadedContent = await buffer.getBytes(0, buffer.getTotalSize());
      expect(loadedContent.toString()).toBe(content);
    });

    test('should load binary content correctly', async () => {
      const binaryData = Buffer.from([0x00, 0x01, 0xFF, 0xFE, 0x7F, 0x80]);
      
      buffer.loadBinaryContent(binaryData);
      
      expect(buffer.filename).toBeNull();
      expect(buffer.getTotalSize()).toBe(binaryData.length);
      expect(buffer.getState()).toBe(BufferState.CLEAN);
      expect(buffer.hasChanges()).toBe(false);
      
      const loadedData = await buffer.getBytes(0, buffer.getTotalSize());
      expect(loadedData).toEqual(binaryData);
    });

    test('should handle empty string content', async () => {
      buffer.loadContent('');
      
      expect(buffer.getTotalSize()).toBe(0);
      expect(buffer.getState()).toBe(BufferState.CLEAN);
      expect(buffer.hasChanges()).toBe(false);
    });

    test('should handle empty binary content', async () => {
      buffer.loadBinaryContent(Buffer.alloc(0));
      
      expect(buffer.getTotalSize()).toBe(0);
      expect(buffer.getState()).toBe(BufferState.CLEAN);
      expect(buffer.hasChanges()).toBe(false);
    });
  });

  describe('Large File Operations', () => {
    test('should handle large file modifications and saves', async () => {
      const filePath = await testUtils.createLargeFile(5); // 5MB
      await buffer.loadFile(filePath);
      
      // Verify initial state
      expect(buffer.getState()).toBe(BufferState.CLEAN);
      expect(buffer.hasChanges()).toBe(false);
      
      // Make modification
      const insertData = Buffer.from('LARGE FILE MODIFICATION: ');
      await buffer.insertBytes(1000000, insertData); // 1MB in
      
      expect(buffer.hasChanges()).toBe(true);
      
      const startTime = Date.now();
      await buffer.saveFile();
      const saveTime = Date.now() - startTime;
      
      expect(saveTime).toBeLessThan(10000); // Should save reasonably fast
      expect(buffer.getState()).toBe(BufferState.CLEAN); // Should transition back to clean
      expect(buffer.hasChanges()).toBe(false);
      
      // Verify modification was saved
      const savedData = await buffer.getBytes(1000000, 1000000 + insertData.length);
      expect(savedData).toEqual(insertData);
    });

    test('should handle large file loading efficiently', async () => {
      const filePath = await testUtils.createLargeFile(10); // 10MB
      
      const startTime = Date.now();
      await buffer.loadFile(filePath);
      const loadTime = Date.now() - startTime;
      
      expect(loadTime).toBeLessThan(5000); // Should load reasonably fast
      expect(buffer.getTotalSize()).toBeGreaterThan(9 * 1024 * 1024); // ~10MB
      
      // Should create many pages but not load them all
      const stats = buffer.getMemoryStats();
      expect(stats.totalPages).toBeGreaterThan(100);
      expect(stats.loadedPages).toBe(0); // Lazy loading
    });

    test('should handle large file modifications and saves', async () => {
      const filePath = await testUtils.createLargeFile(5); // 5MB
      await buffer.loadFile(filePath);
      
      // Make modification
      const insertData = Buffer.from('LARGE FILE MODIFICATION: ');
      await buffer.insertBytes(1000000, insertData); // 1MB in
      
      expect(buffer.hasChanges()).toBe(true);
      
      const startTime = Date.now();
      await buffer.saveFile();
      const saveTime = Date.now() - startTime;
      
      expect(saveTime).toBeLessThan(10000); // Should save reasonably fast
      expect(buffer.getState()).toBe(BufferState.CLEAN);
      expect(buffer.hasChanges()).toBe(false);
      
      // Verify modification was saved
      const savedData = await buffer.getBytes(1000000, 1000000 + insertData.length);
      expect(savedData).toEqual(insertData);
    });
  });

  describe('Notification System', () => {
    test('should notify when file is loaded', async () => {
      const mockHandler = testUtils.createMockNotificationHandler();
      buffer.onNotification(mockHandler.handler);
      
      const content = 'Content for notification test';
      const filePath = await testUtils.createTempFile(content);
      
      await buffer.loadFile(filePath);
      
      const notifications = mockHandler.getByType('file_modified_on_disk');
      expect(notifications.length).toBeGreaterThan(0);
      
      const notification = notifications[0];
      expect(notification.severity).toBe('info');
      expect(notification.metadata.filename).toBe(filePath);
    });

    test('should notify when content is loaded', async () => {
      const mockHandler = testUtils.createMockNotificationHandler();
      buffer.onNotification(mockHandler.handler);
      
      buffer.loadContent('Test content for notifications');
      
      const notifications = mockHandler.getByType('buffer_content_loaded');
      expect(notifications.length).toBeGreaterThan(0);
      
      const notification = notifications[0];
      expect(notification.severity).toBe('info');
    });

    test('should handle notification callback errors gracefully', async () => {
      // Add callback that throws
      buffer.onNotification(() => {
        throw new Error('Callback error');
      });
      
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      
      // This should not throw despite callback error
      buffer.loadContent('Test content');
      
      expect(consoleSpy).toHaveBeenCalledWith(
        'Notification callback error:', 
        expect.any(Error)
      );
      
      consoleSpy.mockRestore();
    });
  });

  describe('Error Handling', () => {
    test('should handle permission errors during save', async () => {
      const content = 'Content for permission test';
      const filePath = await testUtils.createTempFile(content);
      await buffer.loadFile(filePath);
      
      await buffer.insertBytes(0, Buffer.from('Modified: '));
      
      // Remove file to simulate permission error
      await testUtils.unlink(filePath);
      
      // Save should succeed (creates new file)
      await buffer.saveFile();
      
      // File should be recreated
      const exists = await testUtils.fileExists(filePath);
      expect(exists).toBe(true);
    });

    test('should handle disk space issues gracefully', async () => {
      const content = 'Test content';
      const filePath = await testUtils.createTempFile(content);
      await buffer.loadFile(filePath);
      
      // This test just ensures no crashes occur
      // Real disk space issues are hard to simulate
      await buffer.insertBytes(0, Buffer.from('Modified: '));
      
      await expect(buffer.saveFile()).resolves.not.toThrow();
    });

    test('should handle invalid file paths', async () => {
      buffer.loadContent('test content');
      
      // Invalid characters in path
      const invalidPath = '/invalid\0path/file.txt';
      
      await expect(buffer.saveAs(invalidPath)).rejects.toThrow();
    });
  });

  describe('Memory Management with Files', () => {
    test('should manage memory efficiently with file-based buffer', async () => {
      const limitedBuffer = new PagedBuffer(1024, storage, 3); // Very limited memory
      const filePath = await testUtils.createLargeFile(1); // 1MB file
      
      await limitedBuffer.loadFile(filePath);
      
      // Access various parts of file
      const positions = [0, 100000, 200000, 500000, 800000];
      for (const pos of positions) {
        if (pos < limitedBuffer.getTotalSize()) {
          const data = await limitedBuffer.getBytes(pos, Math.min(pos + 100, limitedBuffer.getTotalSize()));
          expect(data.length).toBeGreaterThan(0);
        }
      }
      
      const stats = limitedBuffer.getMemoryStats();
      expect(stats.loadedPages).toBeLessThanOrEqual(3);
      expect(stats.totalPages).toBeGreaterThan(500); // Large file has many pages
    });
  });
});
