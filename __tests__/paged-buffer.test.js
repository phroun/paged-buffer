/**
 * PagedBuffer Core Functionality Tests
 */

const { PagedBuffer, FilePageStorage, MemoryPageStorage, BufferState, BufferMode } = require('../src');
const { testUtils } = require('./setup');

describe('PagedBuffer Core Functionality', () => {
  let buffer;
  let storage;

  beforeEach(() => {
    storage = new MemoryPageStorage();
    buffer = new PagedBuffer(1024, storage, 10); // Small pages for testing
  });

  describe('Buffer Creation and Configuration', () => {
    test('should create buffer with default settings', () => {
      const defaultBuffer = new PagedBuffer();
      expect(defaultBuffer.pageSize).toBe(64 * 1024);
      expect(defaultBuffer.maxMemoryPages).toBe(100);
      expect(defaultBuffer.getState()).toBe(BufferState.CLEAN);
    });

    test('should create buffer with custom settings', () => {
      const customBuffer = new PagedBuffer(2048, storage, 20);
      expect(customBuffer.pageSize).toBe(2048);
      expect(customBuffer.maxMemoryPages).toBe(20);
    });

    test('should initialize with correct default values', () => {
      expect(buffer.getTotalSize()).toBe(0);
      expect(buffer.getState()).toBe(BufferState.CLEAN);
      expect(buffer.getMode()).toBe(BufferMode.BINARY);
    });
  });

  describe('Content Loading', () => {
    test('should load string content correctly', () => {
      const content = 'Hello, World!\nThis is a test.';
      buffer.loadContent(content);
      
      expect(buffer.getTotalSize()).toBe(content.length);
      expect(buffer.getState()).toBe(BufferState.CLEAN);
    });

    test('should load file content correctly', async () => {
      const content = 'Test file content\nWith multiple lines\nAnd some UTF-8: 🚀';
      const filePath = await testUtils.createTempFile(content);
      
      await buffer.loadFile(filePath);
      
      expect(buffer.getTotalSize()).toBe(Buffer.byteLength(content, 'utf8'));
      expect(buffer.getMode()).toBe(BufferMode.UTF8);
      expect(buffer.filename).toBe(filePath);
    });

    test('should detect binary files correctly', async () => {
      const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE]);
      const filePath = await testUtils.createTempFile(binaryContent);
      
      await buffer.loadFile(filePath);
      
      expect(buffer.getMode()).toBe(BufferMode.BINARY);
      expect(buffer.getTotalSize()).toBe(binaryContent.length);
    });

    test('should force specific mode when requested', async () => {
      const content = 'This looks like text';
      const filePath = await testUtils.createTempFile(content);
      
      await buffer.loadFile(filePath, BufferMode.BINARY);
      
      expect(buffer.getMode()).toBe(BufferMode.BINARY);
    });

    test('should handle empty files', async () => {
      const filePath = await testUtils.createTempFile('');
      
      await buffer.loadFile(filePath);
      
      expect(buffer.getTotalSize()).toBe(0);
      expect(buffer.getState()).toBe(BufferState.CLEAN);
    });

    test('should throw error for non-existent files', async () => {
      await expect(buffer.loadFile('/non/existent/file.txt'))
        .rejects.toThrow('Failed to load file');
    });
  });

  describe('Basic Data Operations', () => {
    beforeEach(() => {
      const content = 'Hello, World!\nThis is line 2.\nThis is line 3.';
      buffer.loadContent(content);
    });

    test('should read bytes correctly', async () => {
      const data = await buffer.getBytes(0, 5);
      expect(data.toString()).toBe('Hello');
    });

    test('should read bytes from middle of buffer', async () => {
      const data = await buffer.getBytes(7, 12);
      expect(data.toString()).toBe('World');
    });

    test('should read bytes across multiple pages', async () => {
      // Create content larger than page size
      const largeContent = 'A'.repeat(2000);
      buffer.loadContent(largeContent);
      
      const data = await buffer.getBytes(500, 1500);
      expect(data.length).toBe(1000);
      expect(data.toString()).toBe('A'.repeat(1000));
    });

    test('should handle empty range reads', async () => {
      const data = await buffer.getBytes(5, 5);
      expect(data.length).toBe(0);
    });

    test('should throw error for invalid ranges', async () => {
      await expect(buffer.getBytes(100, 50))
        .rejects.toThrow();
    });

    test('should throw error for out-of-bounds reads', async () => {
      await expect(buffer.getBytes(0, 1000))
        .rejects.toThrow();
    });
  });

  describe('Data Modification', () => {
    beforeEach(() => {
      buffer.loadContent('Hello World');
    });

    test('should insert bytes at beginning', async () => {
      await buffer.insertBytes(0, Buffer.from('Hi '));
      
      const result = await buffer.getBytes(0, 14);
      expect(result.toString()).toBe('Hi Hello World');
      expect(buffer.getTotalSize()).toBe(14);
      expect(buffer.getState()).toBe(BufferState.MODIFIED);
    });

    test('should insert bytes in middle', async () => {
      await buffer.insertBytes(6, Buffer.from('Beautiful '));
      
      const result = await buffer.getBytes(0, 21);
      expect(result.toString()).toBe('Hello Beautiful World');
    });

    test('should insert bytes at end', async () => {
      await buffer.insertBytes(11, Buffer.from('!'));
      
      const result = await buffer.getBytes(0, 12);
      expect(result.toString()).toBe('Hello World!');
    });

    test('should delete bytes from beginning', async () => {
      const deleted = await buffer.deleteBytes(0, 6);
      
      expect(deleted.toString()).toBe('Hello ');
      const remaining = await buffer.getBytes(0, 5);
      expect(remaining.toString()).toBe('World');
      expect(buffer.getTotalSize()).toBe(5);
    });

    test('should delete bytes from middle', async () => {
      const deleted = await buffer.deleteBytes(5, 6);
      
      expect(deleted.toString()).toBe(' ');
      const result = await buffer.getBytes(0, 10);
      expect(result.toString()).toBe('HelloWorld');
    });

    test('should delete bytes from end', async () => {
      const deleted = await buffer.deleteBytes(6, 11);
      
      expect(deleted.toString()).toBe('World');
      const result = await buffer.getBytes(0, 6);
      expect(result.toString()).toBe('Hello ');
    });

    test('should overwrite bytes correctly', async () => {
      const original = await buffer.overwriteBytes(6, Buffer.from('Universe'));
      
      expect(original.toString()).toBe('World');
      const result = await buffer.getBytes(0, 14);
      expect(result.toString()).toBe('Hello Universe');
    });

    test('should handle multi-byte UTF-8 characters', async () => {
      buffer.loadContent('Hello 🌍 World');
      
      // Insert UTF-8 characters
      await buffer.insertBytes(6, Buffer.from('🚀 '));
      
      const result = await buffer.getBytes(0, 18);
      expect(result.toString('utf8')).toBe('Hello 🚀 🌍 World');
    });
  });

  describe('Page Management', () => {
    test('should split pages when they grow too large', async () => {
      const initialStats = buffer.getMemoryStats();
      
      // Insert content larger than 2x page size to trigger split
      const largeContent = 'X'.repeat(3000);
      await buffer.insertBytes(0, Buffer.from(largeContent));
      
      const finalStats = buffer.getMemoryStats();
      expect(finalStats.totalPages).toBeGreaterThan(initialStats.totalPages);
    });

    test('should track loaded pages correctly', async () => {
      const content = 'A'.repeat(5000); // Spans multiple pages
      buffer.loadContent(content);
      
      // Access different parts to load pages
      await buffer.getBytes(0, 100);
      await buffer.getBytes(2000, 2100);
      await buffer.getBytes(4000, 4100);
      
      const stats = buffer.getMemoryStats();
      expect(stats.loadedPages).toBeGreaterThan(0);
      expect(stats.loadedPages).toBeLessThanOrEqual(stats.totalPages);
    });

    test('should evict pages when memory limit is reached', async () => {
      // Create buffer with very low memory limit
      const lowMemBuffer = new PagedBuffer(100, storage, 2); // Only 2 pages in memory
      const content = 'X'.repeat(1000); // Content spanning many pages
      lowMemBuffer.loadContent(content);
      
      // Access many different parts to force eviction
      for (let i = 0; i < 10; i++) {
        await lowMemBuffer.getBytes(i * 50, i * 50 + 10);
      }
      
      const stats = lowMemBuffer.getMemoryStats();
      expect(stats.loadedPages).toBeLessThanOrEqual(2);
    });
  });

  describe('File Saving', () => {
    test('should save to original file', async () => {
      const content = 'Original content';
      const filePath = await testUtils.createTempFile(content);
      
      await buffer.loadFile(filePath);
      await buffer.insertBytes(8, Buffer.from(' modified'));
      await buffer.saveFile();
      
      const savedContent = await testUtils.testUtils.readFile(filePath, 'utf8');
      expect(savedContent).toBe('Original modified content');
      expect(buffer.getState()).toBe(BufferState.CLEAN);
    });

    test('should save to new file', async () => {
      buffer.loadContent('Test content');
      await buffer.insertBytes(4, Buffer.from(' modified'));
      
      const newFilePath = await testUtils.createTempFile(''); // Create empty file
      await buffer.saveFile(newFilePath);
      
      const savedContent = await testUtils.testUtils.readFile(newFilePath, 'utf8');
      expect(savedContent).toBe('Test modified content');
    });

    test('should throw error when saving without filename', async () => {
      buffer.loadContent('Content');
      await expect(buffer.saveFile()).rejects.toThrow('No filename specified');
    });

    test('should handle saveAs for detached buffers', async () => {
      buffer.loadContent('Content');
      // Simulate detached state
      buffer.state = BufferState.DETACHED;
      
      const filePath = await testUtils.createTempFile('');
      await buffer.saveAs(filePath, true); // Force partial save
      
      const savedContent = await testUtils.testUtils.readFile(filePath, 'utf8');
      expect(savedContent).toBe('Content');
    });
  });

  describe('Memory Statistics', () => {
    test('should provide accurate memory statistics', async () => {
      const content = 'Test content for memory stats';
      buffer.loadContent(content);
      
      // Make some modifications
      await buffer.insertBytes(0, Buffer.from('Modified '));
      
      const stats = buffer.getMemoryStats();
      
      expect(stats).toHaveProperty('totalPages');
      expect(stats).toHaveProperty('loadedPages');
      expect(stats).toHaveProperty('dirtyPages');
      expect(stats).toHaveProperty('memoryUsed');
      expect(stats).toHaveProperty('state');
      expect(stats).toHaveProperty('mode');
      
      expect(stats.totalPages).toBeGreaterThan(0);
      expect(stats.loadedPages).toBeGreaterThan(0);
      expect(stats.dirtyPages).toBeGreaterThan(0);
      expect(stats.memoryUsed).toBeGreaterThan(0);
      expect(stats.state).toBe(BufferState.MODIFIED);
    });

    test('should track undo statistics when enabled', () => {
      buffer.enableUndo({ maxUndoLevels: 10 });
      
      const stats = buffer.getMemoryStats();
      expect(stats.undo).toBeDefined();
      expect(stats.undo.undoGroups).toBe(0);
      expect(stats.undo.redoGroups).toBe(0);
    });
  });

  describe('Error Handling', () => {
    test('should handle corrupted page data gracefully', async () => {
      buffer.loadContent('Test content');
      
      // Simulate corrupted page by directly modifying internal state
      const pages = Array.from(buffer.pages.values());
      if (pages.length > 0) {
        pages[0].isDetached = true;
      }
      
      // Should handle gracefully without crashing
      await expect(buffer.getBytes(0, 5)).rejects.toThrow();
    });

    test('should validate input parameters', async () => {
      buffer.loadContent('Test');
      
      // Invalid position parameters
      await expect(buffer.insertBytes(-1, Buffer.from('test')))
        .rejects.toThrow();
      
      await expect(buffer.deleteBytes(10, 5))
        .rejects.toThrow();
    });

    test('should handle empty buffer operations', async () => {
      // Operations on empty buffer
      await expect(buffer.getBytes(0, 1)).rejects.toThrow();
      
      // But should allow insertion at position 0
      await buffer.insertBytes(0, Buffer.from('First content'));
      const result = await buffer.getBytes(0, 13);
      expect(result.toString()).toBe('First content');
    });
  });

  describe('Notification System', () => {
    test('should emit notifications for operations', async () => {
      const mockHandler = testUtils.createMockNotificationHandler();
      buffer.onNotification(mockHandler.handler);
      
      buffer.loadContent('Test content');
      await buffer.insertBytes(4, Buffer.from(' inserted'));
      
      expect(mockHandler.count()).toBeGreaterThan(0);
      
      const notifications = mockHandler.notifications;
      expect(notifications.some(n => n.type === 'file_modified_on_disk')).toBe(true);
    });

    test('should allow clearing notifications', () => {
      const mockHandler = testUtils.createMockNotificationHandler();
      buffer.onNotification(mockHandler.handler);
      
      buffer.loadContent('Test');
      expect(buffer.getNotifications().length).toBeGreaterThan(0);
      
      buffer.clearNotifications();
      expect(buffer.getNotifications().length).toBe(0);
    });

    test('should filter notifications by type', () => {
      const mockHandler = testUtils.createMockNotificationHandler();
      buffer.onNotification(mockHandler.handler);
      
      buffer.loadContent('Test');
      buffer.clearNotifications('file_modified_on_disk');
      
      const remaining = buffer.getNotifications();
      expect(remaining.every(n => n.type !== 'file_modified_on_disk')).toBe(true);
    });
  });
});
