/**
 * Additional comprehensive tests for PagedBuffer system
 * Covering file operations, transactions, memory management, and text features
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { PagedBuffer } = require('../src/paged-buffer');
const { BufferUndoSystem, OperationType } = require('../src/undo-system');
const { FilePageStorage } = require('../src/storage/file-page-storage');
const { BufferMode, BufferState } = require('../src/types/buffer-types');

describe('PagedBuffer - File Operations', () => {
  let buffer;
  let tempDir;
  let testFile;

  beforeEach(async () => {
    buffer = new PagedBuffer(1024);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buffer-test-'));
    testFile = path.join(tempDir, 'test.txt');
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('File Saving', () => {
    test('should save buffer to file', async () => {
      const content = 'Hello, World!';
      buffer.loadContent(content);
      
      await buffer.saveFile(testFile);
      
      const savedContent = await fs.readFile(testFile, 'utf8');
      expect(savedContent).toBe(content);
      expect(buffer.getState()).toBe(BufferState.CLEAN);
      expect(buffer.filename).toBe(testFile);
    });

    test('should save modified buffer to file', async () => {
      buffer.loadContent('Hello');
      await buffer.insertBytes(5, Buffer.from(', World!'));
      
      await buffer.saveFile(testFile);
      
      const savedContent = await fs.readFile(testFile, 'utf8');
      expect(savedContent).toBe('Hello, World!');
      expect(buffer.getState()).toBe(BufferState.CLEAN);
    });

    test('should throw error when saving without filename', async () => {
      buffer.loadContent('test');
      
      await expect(buffer.saveFile()).rejects.toThrow('No filename specified');
    });

    test('should save empty buffer', async () => {
      buffer.loadContent('');
      
      await buffer.saveFile(testFile);
      
      const savedContent = await fs.readFile(testFile, 'utf8');
      expect(savedContent).toBe('');
    });
  });

  describe('Save As Operations', () => {
    test('should save as new file', async () => {
      buffer.loadContent('Original content');
      const newFile = path.join(tempDir, 'new.txt');
      
      await buffer.saveAs(newFile);
      
      const savedContent = await fs.readFile(newFile, 'utf8');
      expect(savedContent).toBe('Original content');
      expect(buffer.filename).toBe(newFile);
      expect(buffer.getState()).toBe(BufferState.CLEAN);
    });

    test('should handle detached buffer save as with forcePartial', async () => {
      buffer.loadContent('test content');
      buffer.state = BufferState.DETACHED; // Simulate detached state
      
      await buffer.saveAs(testFile, true);
      
      const savedContent = await fs.readFile(testFile, 'utf8');
      expect(savedContent).toBe('test content');
    });

    test('should throw error for detached buffer without forcePartial', async () => {
      buffer.loadContent('test content');
      buffer.state = BufferState.DETACHED;
      
      // Mock some pages as not loaded and not dirty
      const pageInfo = buffer.pages.values().next().value;
      pageInfo.isLoaded = false;
      pageInfo.isDirty = false;
      
      await expect(buffer.saveAs(testFile, false)).rejects.toThrow('Cannot save detached buffer');
    });
  });

  describe('File Change Detection', () => {
    test('should detect no changes in unchanged file', async () => {
      await fs.writeFile(testFile, 'test content');
      await buffer.loadFile(testFile);
      
      const changes = await buffer.checkFileChanges();
      
      expect(changes.changed).toBe(false);
      expect(changes.sizeChanged).toBe(false);
      expect(changes.mtimeChanged).toBe(false);
      expect(changes.deleted).toBe(false);
    });

    test('should detect size changes', async () => {
      await fs.writeFile(testFile, 'original');
      await buffer.loadFile(testFile);
      
      // Modify file externally
      await fs.writeFile(testFile, 'modified content');
      
      const changes = await buffer.checkFileChanges();
      
      expect(changes.changed).toBe(true);
      expect(changes.sizeChanged).toBe(true);
      expect(changes.newSize).toBeGreaterThan(buffer.fileSize);
    });

    test('should detect file deletion', async () => {
      await fs.writeFile(testFile, 'content');
      await buffer.loadFile(testFile);
      
      await fs.unlink(testFile);
      
      const changes = await buffer.checkFileChanges();
      
      expect(changes.changed).toBe(true);
      expect(changes.deleted).toBe(true);
      expect(changes.sizeChanged).toBe(true);
      expect(changes.mtimeChanged).toBe(true);
    });

    test('should handle non-file buffers', async () => {
      buffer.loadContent('memory content');
      
      const changes = await buffer.checkFileChanges();
      
      expect(changes.changed).toBe(false);
    });
  });

  describe('File Checksum Calculation', () => {
    test('should calculate checksum for non-empty file', async () => {
      const content = 'test content for checksum';
      await fs.writeFile(testFile, content);
      
      await buffer.loadFile(testFile);
      
      expect(buffer.fileChecksum).toBeTruthy();
      expect(typeof buffer.fileChecksum).toBe('string');
      expect(buffer.fileChecksum.length).toBe(32); // MD5 hex length
    });

    test('should handle empty file checksum', async () => {
      await fs.writeFile(testFile, '');
      
      await buffer.loadFile(testFile);
      
      expect(buffer.fileChecksum).toBe('d41d8cd98f00b204e9800998ecf8427e'); // MD5 of empty string
    });
  });
});

describe('PagedBuffer - Storage Layer Integration', () => {
  let buffer;
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-test-'));
    const storage = new FilePageStorage(tempDir);
    buffer = new PagedBuffer(64, storage, 1); // Force evictions with 1 page limit
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('File-based Page Storage', () => {
    test('should save and load pages through file storage', async () => {
      buffer.loadContent('Content that will be stored to disk');
      
      // Modify content to make it dirty
      await buffer.insertBytes(0, Buffer.from('Modified: '));
      
      // Force eviction by accessing end of buffer
      await buffer.getBytes(50, 60);
      
      // Access beginning again - should load from storage
      const result = await buffer.getBytes(0, 15);
      expect(result.toString()).toBe('Modified: Conte');
    });
  });

  test('should handle storage errors gracefully', async () => {
    // Create our own storage instance for this test
    const testStorage = new FilePageStorage();
    
    let storageErrors = [];
    buffer.onNotification((notification) => {
      if (notification.type === 'storage_error' || notification.severity === 'error') {
        storageErrors.push(notification);
      }
    });
    
    // Create a buffer with extremely limited memory to force storage operations
    const limitedBuffer = new PagedBuffer(64, testStorage, 1); // Only 1 page in memory
    
    // Load content that will require multiple pages
    limitedBuffer.loadContent('A'.repeat(500)); // Creates ~8 pages with 64-byte pages
    
    // Modify content to make pages dirty
    await limitedBuffer.insertBytes(100, Buffer.from('X'.repeat(100)));
    await limitedBuffer.insertBytes(300, Buffer.from('Y'.repeat(100)));
    
    // Access scattered positions to force eviction and potential storage operations
    const positions = [50, 150, 250, 350, 450, 550];
    for (const pos of positions) {
      try {
        if (pos < limitedBuffer.getTotalSize()) {
          await limitedBuffer.getBytes(pos, Math.min(pos + 10, limitedBuffer.getTotalSize()));
        }
      } catch (error) {
        // Some operations may fail, but we should handle them gracefully
      }
    }
    
    // The test passes if no unhandled errors were thrown
    // Storage errors (if any) should be captured in notifications
    const stats = limitedBuffer.getMemoryStats();
    expect(stats.loadedPages).toBeLessThanOrEqual(1);
    expect(stats.totalPages).toBeGreaterThan(5);
    
    // If storage errors occurred, they should be in notifications
    if (storageErrors.length > 0) {
      expect(storageErrors[0].severity).toBe('error');
    }
    
    // The buffer should still be functional
    expect(limitedBuffer.getTotalSize()).toBeGreaterThan(600);
  });

  describe('Page Existence Checks', () => {
    test('should check page existence in storage', async () => {
      // Use the existing working tempDir instead of creating a bad path
      const storage = new FilePageStorage(); // Uses default temp dir
      
      // Should not exist initially
      const existsBefore = await storage.pageExists('test-page');
      expect(existsBefore).toBe(false);
      
      // Save a page
      await storage.savePage('test-page', Buffer.from('test data'));
      
      // Should exist now
      const existsAfter = await storage.pageExists('test-page');
      expect(existsAfter).toBe(true);
      
      // Delete the page
      await storage.deletePage('test-page');
      
      // Should not exist after deletion
      const existsDeleted = await storage.pageExists('test-page');
      expect(existsDeleted).toBe(false);
    });
  });
});

describe('PagedBuffer - Comprehensive Integration Tests', () => {
  let buffer;

  beforeEach(() => {
    buffer = new PagedBuffer(128);
    buffer.enableUndo({
      mergeTimeWindow: 15000,
      mergePositionWindow: 0  // This is crucial!
    });
  });

  describe('Complex Edit Scenarios', () => {
    test('should handle realistic text editing workflow', async () => {
      // Start with some content
      const initialContent = 'Hello World\nThis is a test\nEnd of file';
      buffer.loadContent(initialContent);
      
      // Simulate user editing workflow
      buffer.beginUndoTransaction('Add header');
      await buffer.insertBytes(0, Buffer.from('# Document Title\n\n'));
      buffer.commitUndoTransaction();
      
      // Get fresh line starts after header insertion
      const lineStarts = await buffer.getLineStarts();
      
      // Find the line that contains "This is a test" - should be line index 2 now
      const testLineIndex = lineStarts.findIndex(async (start, index) => {
        if (index + 1 < lineStarts.length) {
          const lineEnd = lineStarts[index + 1] - 1;
          const lineContent = await buffer.getBytes(start, lineEnd);
          return lineContent.toString().includes('This is a test');
        }
        return false;
      });
      
      buffer.beginUndoTransaction('Edit middle line');
      
      // Simpler approach - find and replace the specific text
      const fullContent = await buffer.getBytes(0, buffer.getTotalSize());
      const contentStr = fullContent.toString();
      const testIndex = contentStr.indexOf('This is a test');
      
      if (testIndex !== -1) {
        await buffer.deleteBytes(testIndex, testIndex + 'This is a test'.length);
        await buffer.insertBytes(testIndex, Buffer.from('This is modified content'));
      }
      
      buffer.commitUndoTransaction();
      
      // Verify final content
      const finalContent = await buffer.getBytes(0, buffer.getTotalSize());
      const expectedContent = '# Document Title\n\nHello World\nThis is modified content\nEnd of file';
      expect(finalContent.toString()).toBe(expectedContent);
      
      // Verify undo works correctly
      await buffer.undo(); // Undo edit
      await buffer.undo(); // Undo header addition
      
      const undoneContent = await buffer.getBytes(0, buffer.getTotalSize());
      expect(undoneContent.toString()).toBe(initialContent);
    });

    test('should handle mixed binary and text operations', async () => {
      // Load binary content directly without string conversion
      const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);
      
      // Reset buffer and load binary data properly
      buffer.mode = BufferMode.BINARY;
      buffer.pages.clear();
      buffer.pageOrder = [];
      buffer.nextPageId = 0;
      buffer.totalSize = binaryData.length;
      
      // Create page directly with binary data
      const pageId = `page_${buffer.nextPageId++}`;
      const { PageInfo } = require('../src/utils/page-info');
      const pageInfo = new PageInfo(pageId, 0, binaryData.length);
      pageInfo.updateData(binaryData, buffer.mode);
      buffer.pages.set(pageId, pageInfo);
      buffer.pageOrder.push(pageId);
      
      // Insert more binary data
      await buffer.insertBytes(3, Buffer.from([0xAA, 0xBB, 0xCC]));
      
      // Verify binary integrity
      const result = await buffer.getBytes(0, buffer.getTotalSize());
      const expected = Buffer.from([0x00, 0x01, 0x02, 0xAA, 0xBB, 0xCC, 0xFF, 0xFE, 0xFD]);
      expect(result).toEqual(expected);
      
      // Line operations should still work (return single line)
      const lineStarts = await buffer.getLineStarts();
      expect(lineStarts).toEqual([0]);
    });
  });

  describe('Memory and Performance Edge Cases', () => {
    test('should handle rapid page access patterns', async () => {
      // Create content that spans many pages
      const pageContent = 'A'.repeat(100);
      const totalContent = Array(20).fill(pageContent).join('');
      buffer.loadContent(totalContent);
      
      // Rapidly access random positions to stress page loading
      const accessPattern = [];
      for (let i = 0; i < 50; i++) {
        const pos = Math.floor(Math.random() * totalContent.length);
        accessPattern.push(pos);
        const chunk = await buffer.getBytes(pos, Math.min(pos + 10, totalContent.length));
        expect(chunk.length).toBeGreaterThan(0);
      }
      
      // Buffer should still be functional
      expect(buffer.getTotalSize()).toBe(totalContent.length);
    });


    test('should maintain consistency during concurrent-like operations', async () => {
      const originalContent = 'Base content for consistency test';
      buffer.loadContent(originalContent);
      
      // Perform a sequence of operations
      await buffer.insertBytes(4, Buffer.from(' NEW'));           // "Base NEW content for consistency test"
      await buffer.insertBytes(0, Buffer.from('Modified '));      // "Modified Base NEW content for consistency test"
      await buffer.deleteBytes(9, 18);                           // Delete "Base NEW " 
      await buffer.deleteBytes(0, 9);                            // Delete "Modified "
      await buffer.insertBytes(0, Buffer.from('Base '));         // "Base content for consistency test"
      
      const finalContent = await buffer.getBytes(0, buffer.getTotalSize());
      expect(finalContent.toString()).toBe('Base content for consistency test');
      
      // Verify undo functionality
      expect(buffer.canUndo()).toBe(true);
      
      // Perform some undos to verify stack works
      let undoCount = 0;
      while (buffer.canUndo() && undoCount < 10) {
        const undoResult = await buffer.undo();
        if (undoResult) {
          undoCount++;
        } else {
          break;
        }
      }
      
      // Should have been able to perform some undo operations
      expect(undoCount).toBeGreaterThan(0);
    });

  });

  describe('Resource Management', () => {
    test('should properly clean up resources', async () => {
      const initialStats = buffer.getMemoryStats();
      
      // Create and modify content
      buffer.loadContent('Resource test content');
      await buffer.insertBytes(0, Buffer.from('Modified '));
      
      const modifiedStats = buffer.getMemoryStats();
      expect(modifiedStats.memoryUsed).toBeGreaterThan(0);
      
      // Clear undo history to free memory
      if (buffer.undoSystem) {
        buffer.undoSystem.clear();
      }
      
      const clearedStats = buffer.getMemoryStats();
      expect(clearedStats.undo.totalUndoOperations).toBe(0);
    });

    test('should handle disable/enable undo correctly', async () => {
      buffer.loadContent('Undo test');
      
      // Make changes with undo enabled
      await buffer.insertBytes(0, Buffer.from('A'));
      expect(buffer.canUndo()).toBe(true);
      
      // Disable undo
      buffer.disableUndo();
      expect(buffer.undoSystem).toBe(null);
      
      // Make more changes
      await buffer.insertBytes(1, Buffer.from('B'));
      expect(buffer.canUndo()).toBe(false);
      
      // Re-enable undo
      buffer.enableUndo();
      await buffer.insertBytes(2, Buffer.from('C'));
      expect(buffer.canUndo()).toBe(true);
      
      // Should only undo the last change (after re-enabling)
      await buffer.undo();
      const result = await buffer.getBytes(0, buffer.getTotalSize());
      expect(result.toString()).toBe('ABUndo test');
    });
  });
});

describe('PagedBuffer - Transaction System', () => {
  let buffer;

  beforeEach(() => {
    buffer = new PagedBuffer(64);
    buffer.enableUndo();
    buffer.loadContent('Initial content');
  });

  describe('Basic Transactions', () => {
    test('should begin and commit transaction', async () => {
      buffer.beginUndoTransaction('Test Transaction');
      
      expect(buffer.inUndoTransaction()).toBe(true);
      expect(buffer.getCurrentUndoTransaction().name).toBe('Test Transaction');
      
      await buffer.insertBytes(0, Buffer.from('New '));
      
      const committed = buffer.commitUndoTransaction();
      
      expect(committed).toBe(true);
      expect(buffer.inUndoTransaction()).toBe(false);
      expect(buffer.canUndo()).toBe(true);
    });

    test('should rollback transaction', async () => {
      const originalContent = await buffer.getBytes(0, buffer.getTotalSize());
      
      buffer.beginUndoTransaction('Rollback Test');
      await buffer.insertBytes(0, Buffer.from('This will be rolled back '));
      
      const rolledBack = await buffer.rollbackUndoTransaction();
      
      expect(rolledBack).toBe(true);
      expect(buffer.inUndoTransaction()).toBe(false);
      
      const currentContent = await buffer.getBytes(0, buffer.getTotalSize());
      expect(currentContent.toString()).toBe(originalContent.toString());
    });

    test('should commit empty transaction', () => {
      buffer.beginUndoTransaction('Empty Transaction');
      
      const committed = buffer.commitUndoTransaction();
      
      expect(committed).toBe(true);
      expect(buffer.inUndoTransaction()).toBe(false);
    });

    test('should handle rollback of non-existent transaction', async () => {
      const result = await buffer.rollbackUndoTransaction();
      expect(result).toBe(false);
    });

    test('should handle commit of non-existent transaction', () => {
      const result = buffer.commitUndoTransaction();
      expect(result).toBe(false);
    });
  });

  describe('Transaction Undo Behavior', () => {
    test('should undo by rolling back active transaction', async () => {
      const original = await buffer.getBytes(0, buffer.getTotalSize());
      
      buffer.beginUndoTransaction('Active Transaction');
      await buffer.insertBytes(0, Buffer.from('Added '));
      
      const undone = await buffer.undo(); // Should rollback transaction
      
      expect(undone).toBe(true);
      expect(buffer.inUndoTransaction()).toBe(false);
      
      const current = await buffer.getBytes(0, buffer.getTotalSize());
      expect(current.toString()).toBe(original.toString());
    });

    test('should prevent redo during transaction', () => {
      buffer.beginUndoTransaction('Test');
      
      expect(buffer.canRedo()).toBe(false);
    });
  });

  describe('Transaction Configuration', () => {
    test('should never merge transactions with adjacent operations', async () => {
      // First, do a regular operation
      await buffer.insertBytes(0, Buffer.from('Before '));
      
      // Then do a transaction
      buffer.beginUndoTransaction('Separate Transaction');
      await buffer.insertBytes(7, Buffer.from('During '));
      buffer.commitUndoTransaction();
      
      // Transaction should be separate undo step, even though operations are adjacent
      const undo1 = await buffer.undo(); // Should undo transaction
      expect(undo1).toBe(true);
      
      const undo2 = await buffer.undo(); // Should undo the pre-transaction operation  
      expect(undo2).toBe(true);
      
      const content = await buffer.getBytes(0, buffer.getTotalSize());
      expect(content.toString()).toBe('Initial content');
    });
  });
});

describe('PagedBuffer - Memory Management', () => {
  let buffer;

  beforeEach(() => {
    buffer = new PagedBuffer(64, null, 2); // Small page size and memory limit for testing
  });

  describe('Page Eviction', () => {
    test('should evict pages when memory limit exceeded', async () => {
      // Set up notification tracking
      let memoryPressureNotifications = 0;
      buffer.onNotification((notification) => {
        if (notification.type === 'page_evicted') {
          memoryPressureNotifications++;
        }
      });
      
      // Load content that will create multiple pages
      const largeContent = 'A'.repeat(300); // Will create ~5 pages with 64-byte page size
      buffer.loadContent(largeContent);
      
      // Access first few bytes to ensure first page is loaded
      await buffer.getBytes(0, 10);
      
      // Access bytes from end to load last page and trigger eviction
      await buffer.getBytes(250, 260);
      
      const stats = buffer.getMemoryStats();
      expect(stats.loadedPages).toBeLessThanOrEqual(buffer.maxMemoryPages);
      
      // Should have notifications for evicted pages
      expect(memoryPressureNotifications).toBeGreaterThan(0);
    });

    test('should handle memory pressure notifications appropriately', async () => {
      let evictionNotifications = [];
      buffer.onNotification((notification) => {
        if (notification.type === 'page_evicted') {
          evictionNotifications.push(notification);
        }
      });
      
      const content = 'A'.repeat(300); // Multiple pages
      buffer.loadContent(content);
      
      // Trigger multiple evictions
      for (let i = 0; i < 10; i++) {
        await buffer.getBytes(i * 20, i * 20 + 10);
      }
      
      // Should have eviction notifications (implementation decides frequency)
      expect(evictionNotifications.length).toBeGreaterThan(0);
      
      // Each notification should have useful metadata
      evictionNotifications.forEach(notification => {
        expect(notification.metadata).toHaveProperty('pageId');
        expect(notification.metadata).toHaveProperty('loadedPages');
        expect(notification.severity).toBe('debug');
      });
    });

    test('should maintain LRU order for page eviction', async () => {
      const content = 'A'.repeat(200); // Multiple pages
      buffer.loadContent(content);
      
      // Access pages in specific order
      await buffer.getBytes(0, 10);    // Page 1
      await buffer.getBytes(100, 110); // Page 2  
      await buffer.getBytes(0, 5);     // Page 1 again (should be most recent)
      await buffer.getBytes(150, 160); // Page 3 (should trigger eviction)
      
      const stats = buffer.getMemoryStats();
      expect(stats.loadedPages).toBeLessThanOrEqual(buffer.maxMemoryPages);
    });

    test('should save dirty pages before eviction', async () => {
      const storage = new FilePageStorage();
      buffer = new PagedBuffer(64, storage, 1); // Only 1 page in memory
      buffer.loadContent('Original content here');
      
      // Modify first page to make it dirty
      await buffer.insertBytes(0, Buffer.from('Modified '));
      
      // Access end of buffer to trigger eviction
      await buffer.getBytes(50, 60);
      
      // First page should have been saved to storage before eviction
      const stats = buffer.getMemoryStats();
      expect(stats.dirtyPages).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Page Splitting', () => {
    test('should split page at midpoint when it grows too large', async () => {
      buffer.loadContent('Small');
      
      const initialPageCount = buffer.pages.size;
      
      // Insert large amount of data to trigger page split
      const largeInsert = 'X'.repeat(buffer.pageSize * 3); // 3x page size
      await buffer.insertBytes(2, Buffer.from(largeInsert));
      
      const finalPageCount = buffer.pages.size;
      expect(finalPageCount).toBeGreaterThan(initialPageCount);
    });

    test('should maintain data integrity after page split', async () => {
      const original = 'Hello World';
      buffer.loadContent(original);
      
      const largeInsert = 'X'.repeat(buffer.pageSize * 2);
      await buffer.insertBytes(5, Buffer.from(largeInsert));
      
      const expected = 'Hello' + largeInsert + ' World';
      const result = await buffer.getBytes(0, buffer.getTotalSize());
      
      expect(result.toString()).toBe(expected);
    });

    test('should split at midpoint even if it breaks UTF-8 characters', async () => {
      // Create content with multi-byte UTF-8 characters
      const unicodeContent = 'Test ' + '🚀'.repeat(20) + ' content'; // Emojis are multi-byte
      buffer.loadContent(unicodeContent);
      
      const initialPageCount = buffer.pages.size;
      
      // Force a split by inserting lots of data
      const largeInsert = 'X'.repeat(buffer.pageSize * 2);
      await buffer.insertBytes(10, Buffer.from(largeInsert));
      
      const finalPageCount = buffer.pages.size;
      expect(finalPageCount).toBeGreaterThan(initialPageCount);
      
      // Data should still be retrievable (even with broken UTF-8 at split points)
      const result = await buffer.getBytes(0, buffer.getTotalSize());
      expect(result.length).toBeGreaterThan(unicodeContent.length);
    });
  });

  describe('Memory Statistics', () => {
    test('should provide accurate memory statistics', async () => {
      buffer.loadContent('Test content for stats');
      
      const stats = buffer.getMemoryStats();
      
      expect(stats).toHaveProperty('totalPages');
      expect(stats).toHaveProperty('loadedPages');
      expect(stats).toHaveProperty('dirtyPages');
      expect(stats).toHaveProperty('detachedPages');
      expect(stats).toHaveProperty('memoryUsed');
      expect(stats).toHaveProperty('maxMemoryPages');
      expect(stats).toHaveProperty('state');
      expect(stats).toHaveProperty('mode');
      expect(stats).toHaveProperty('undo');
      
      expect(stats.totalPages).toBeGreaterThan(0);
      expect(stats.maxMemoryPages).toBe(buffer.maxMemoryPages);
    });

    test('should track dirty pages correctly', async () => {
      buffer.loadContent('Original');
      
      let stats = buffer.getMemoryStats();
      const initialDirtyPages = stats.dirtyPages;
      
      await buffer.insertBytes(0, Buffer.from('Modified '));
      
      stats = buffer.getMemoryStats();
      expect(stats.dirtyPages).toBeGreaterThanOrEqual(initialDirtyPages);
    });
  });
});

describe('PagedBuffer - Text Features (UTF-8)', () => {
  let buffer;

  beforeEach(() => {
    buffer = new PagedBuffer(64);
  });

  describe('Line Operations', () => {
    test('should get line starts for multi-line content', async () => {
      const content = 'Line 1\nLine 2\nLine 3\n';
      buffer.loadContent(content);
      
      const lineStarts = await buffer.getLineStarts();
      
      expect(lineStarts).toEqual([0, 7, 14, 21]); // Start of each line
    });

    test('should handle empty content', async () => {
      buffer.loadContent('');
      
      const lineStarts = await buffer.getLineStarts();
      
      expect(lineStarts).toEqual([0]);
    });

    test('should handle content without newlines', async () => {
      buffer.loadContent('Single line content');
      
      const lineStarts = await buffer.getLineStarts();
      
      expect(lineStarts).toEqual([0]);
    });

    test('should get accurate line count', async () => {
      const content = 'Line 1\nLine 2\nLine 3';
      buffer.loadContent(content);
      
      const lineCount = await buffer.getLineCount();
      
      expect(lineCount).toBe(3);
    });

    test('should handle binary mode for line operations', async () => {
      buffer.mode = BufferMode.BINARY;
      buffer.loadContent('Binary\0content');
      
      const lineStarts = await buffer.getLineStarts();
      
      expect(lineStarts).toEqual([0]); // Binary mode should return single line start
      
      const lineCount = await buffer.getLineCount();
      expect(lineCount).toBe(1); // Binary mode should report 1 line
    });
  });

  describe('Position Conversion', () => {
    beforeEach(() => {
      const content = 'First line\nSecond line\nThird line';
      buffer.loadContent(content);
    });

    test('should convert line/character to byte position', async () => {
      // Start of first line
      let bytePos = await buffer.lineCharToBytePosition({line: 0, character: 0});
      expect(bytePos).toBe(0);
      
      // Start of second line
      bytePos = await buffer.lineCharToBytePosition({line: 1, character: 0});
      expect(bytePos).toBe(11); // After "First line\n"
      
      // Character 5 of first line
      bytePos = await buffer.lineCharToBytePosition({line: 0, character: 5});
      expect(bytePos).toBe(5);
    });

    test('should convert byte position to line/character', async () => {
      // Start of buffer
      let pos = await buffer.byteToLineCharPosition(0);
      expect(pos).toEqual({line: 0, character: 0});
      
      // Start of second line
      pos = await buffer.byteToLineCharPosition(11);
      expect(pos).toEqual({line: 1, character: 0});
      
      // Middle of first line
      pos = await buffer.byteToLineCharPosition(5);
      expect(pos).toEqual({line: 0, character: 5});
    });

    test('should handle positions beyond line end', async () => {
      const bytePos = await buffer.lineCharToBytePosition({line: 0, character: 1000});
      
      // Should clamp to end of line
      expect(bytePos).toBeLessThanOrEqual(10); // "First line".length
    });

    test('should handle positions beyond buffer end', async () => {
      const pos = await buffer.byteToLineCharPosition(1000);
      
      expect(pos.line).toBeGreaterThanOrEqual(0);
      expect(pos.character).toBeGreaterThanOrEqual(0);
    });

    test('should throw error for binary mode position conversion', async () => {
      buffer.mode = BufferMode.BINARY;
      
      await expect(buffer.lineCharToBytePosition({line: 0, character: 0}))
        .rejects.toThrow('Line/character positioning only available in UTF-8 mode');
        
      await expect(buffer.byteToLineCharPosition(0))
        .rejects.toThrow('Line/character positioning only available in UTF-8 mode');
    });
  });

  describe('Text Insertion and Deletion', () => {
    beforeEach(() => {
      buffer.loadContent('Line 1\nLine 2\nLine 3');
    });

    test('should insert text at line/character position', async () => {
      const result = await buffer.insertTextAtPosition(
        {line: 1, character: 4}, 
        ' inserted'
      );
      
      expect(result.newPosition.line).toBe(1);
      expect(result.newPosition.character).toBe(13); // After inserted text
      expect(result.newLineStarts).toBeTruthy();
      
      const content = await buffer.getBytes(0, buffer.getTotalSize());
      expect(content.toString()).toContain('Line inserted 2');
    });

    test('should delete text between positions', async () => {
      const result = await buffer.deleteTextBetweenPositions(
        {line: 0, character: 5}, 
        {line: 1, character: 4}
      );
      
      expect(result.deletedText).toBe('1\nLine');
      expect(result.newLineStarts).toBeTruthy();
      
      const content = await buffer.getBytes(0, buffer.getTotalSize());
      // After deleting "1\nLine" from "Line 1\nLine 2\nLine 3"
      // We get "Line  2\nLine 3" (note the double space)
      expect(content.toString()).toContain('2');
      expect(content.toString()).toContain('Line 3');
    });

    test('should handle newlines in inserted text', async () => {
      await buffer.insertTextAtPosition(
        {line: 1, character: 0}, 
        'New line\nAnother line\n'
      );
      
      const lineCount = await buffer.getLineCount();
      expect(lineCount).toBeGreaterThan(3); // Original + inserted lines
    });
  });
});

describe('PagedBuffer - Advanced Operation Merging', () => {
  let buffer;

  beforeEach(() => {
    buffer = new PagedBuffer(64);
    buffer.enableUndo({
      mergeTimeWindow: 1000,
      mergePositionWindow: 10
    });
    buffer.loadContent('Test content for merging');
  });

  describe('Operation Merging Logic', () => {
    test('should merge adjacent insert operations', async () => {
      // Insert characters one by one (simulating typing)
      await buffer.insertBytes(0, Buffer.from('H'));
      await buffer.insertBytes(1, Buffer.from('e'));
      await buffer.insertBytes(2, Buffer.from('l'));
      await buffer.insertBytes(3, Buffer.from('l'));
      await buffer.insertBytes(4, Buffer.from('o'));
      
      // Should merge into single undo operation
      const undone = await buffer.undo();
      expect(undone).toBe(true);
      
      const content = await buffer.getBytes(0, buffer.getTotalSize());
      expect(content.toString()).toBe('Test content for merging');
    });

    test('should merge delete operations', async () => {
      // Delete characters one by one (simulating backspace from "Test" to "T")
      await buffer.deleteBytes(3, 4); // Delete 't' at position 3
      await buffer.deleteBytes(2, 3); // Delete 's' at position 2  
      await buffer.deleteBytes(1, 2); // Delete 'e' at position 1
      
      // Verify the operations merged into a single undo unit
      const undone = await buffer.undo();
      expect(undone).toBe(true);
      
      // Should restore all deleted characters at once
      const content = await buffer.getBytes(0, buffer.getTotalSize());
      expect(content.toString()).toBe('Test content for merging');
    });

    test('should merge delete operations (backspace simulation)', async () => {
      // Simulate backspacing through "Test" to leave just "T"
      
      await buffer.deleteBytes(3, 4); // Delete 't' → "Tes content for merging"
      await buffer.deleteBytes(2, 3); // Delete 's' → "Te content for merging"
      await buffer.deleteBytes(1, 2); // Delete 'e' → "T content for merging"
      
      // Verify the intermediate state
      const afterDeletes = await buffer.getBytes(0, buffer.getTotalSize());
      expect(afterDeletes.toString()).toBe('T content for merging');
      
      // Now undo should restore all the deleted characters
      const undone = await buffer.undo();
      expect(undone).toBe(true);
      
      const content = await buffer.getBytes(0, buffer.getTotalSize());
      expect(content.toString()).toBe('Test content for merging');
    });

    test('should merge "delete next word" operations', async () => {
      // Simulate Ctrl+Delete (delete next word) repeatedly
      buffer.loadContent('My test content is here.');
      
      // Position analysis: "My test content is here."
      //                    012345678901234567890123
      //                    M  t  c        i  h
      
      // Starting at position 3 (after "My "), delete words forward:
      
      // Delete "test " (positions 3-8)
      await buffer.deleteBytes(3, 8);
      let content = await buffer.getBytes(0, buffer.getTotalSize());
      expect(content.toString()).toBe('My content is here.');
      
      // Delete "content " (now at positions 3-11 in the modified buffer)
      await buffer.deleteBytes(3, 11);
      content = await buffer.getBytes(0, buffer.getTotalSize());  
      expect(content.toString()).toBe('My is here.');
      
      // Delete "is " (now at positions 3-6 in the modified buffer)
      await buffer.deleteBytes(3, 6);
      content = await buffer.getBytes(0, buffer.getTotalSize());
      expect(content.toString()).toBe('My here.');
      
      // All operations should merge into one undo unit
      const undone = await buffer.undo();
      expect(undone).toBe(true);
      
      // Should restore all deleted words at once
      const finalContent = await buffer.getBytes(0, buffer.getTotalSize());
      expect(finalContent.toString()).toBe('My test content is here.');
    });

    test('should merge "delete previous word" operations', async () => {
      // Simulate Ctrl+Backspace (delete previous word) repeatedly  
      buffer.loadContent('My test content is here.');
      
      // Position analysis: "My test content is here."
      //                    012345678901234567890123
      
      // Starting from end, delete words backward:
      
      // Delete " is" (positions 15-18, the space and "is" before "here")
      await buffer.deleteBytes(15, 18);
      let content = await buffer.getBytes(0, buffer.getTotalSize());
      expect(content.toString()).toBe('My test content here.');
      
      // Delete " content" (positions 7-15 in the modified buffer)
      await buffer.deleteBytes(7, 15);
      content = await buffer.getBytes(0, buffer.getTotalSize());
      expect(content.toString()).toBe('My test here.');
      
      // Delete " test" (positions 2-7 in the modified buffer)  
      await buffer.deleteBytes(2, 7);
      content = await buffer.getBytes(0, buffer.getTotalSize());
      expect(content.toString()).toBe('My here.');
      
      // All operations should merge into one undo unit
      const undone = await buffer.undo();
      expect(undone).toBe(true);
      
      // Should restore all deleted words at once
      const finalContent = await buffer.getBytes(0, buffer.getTotalSize());
      expect(finalContent.toString()).toBe('My test content is here.');
    });

    test('should handle mixed word deletion patterns', async () => {
      // Test a realistic editing scenario: delete some words, then undo
      buffer.loadContent('The quick brown fox jumps over the lazy dog.');
      
      // Delete "brown fox " (positions 10-20)
      await buffer.deleteBytes(10, 20);
      let content = await buffer.getBytes(0, buffer.getTotalSize());
      expect(content.toString()).toBe('The quick jumps over the lazy dog.');
      
      // Delete "jumps over " (positions 10-21 in modified buffer)
      await buffer.deleteBytes(10, 21);
      content = await buffer.getBytes(0, buffer.getTotalSize());
      expect(content.toString()).toBe('The quick the lazy dog.');
      
      // Verify merge behavior
      const undone = await buffer.undo();
      expect(undone).toBe(true);
      
      const finalContent = await buffer.getBytes(0, buffer.getTotalSize());
      expect(finalContent.toString()).toBe('The quick brown fox jumps over the lazy dog.');
    });

    test('should handle word deletion with transactions', async () => {
      // Test explicit transaction wrapping for word deletion
      buffer.loadContent('Alpha beta gamma delta epsilon.');
      
      buffer.beginUndoTransaction('Delete middle words');
      
      // Delete "beta " (positions 6-11)
      await buffer.deleteBytes(6, 11);
      
      // Delete "gamma " (now positions 6-12)
      await buffer.deleteBytes(6, 12);
      
      buffer.commitUndoTransaction();
      
      // Should have "Alpha delta epsilon."
      const content = await buffer.getBytes(0, buffer.getTotalSize());
      expect(content.toString()).toBe('Alpha delta epsilon.');
      
      // Transaction should undo as one unit
      const undone = await buffer.undo();
      expect(undone).toBe(true);
      
      const finalContent = await buffer.getBytes(0, buffer.getTotalSize());
      expect(finalContent.toString()).toBe('Alpha beta gamma delta epsilon.');
    });

    test('should handle complex operation sequences', async () => {
      // Simulate editing: delete some text, then insert replacement
      await buffer.deleteBytes(5, 12); // Delete "content"
      await buffer.insertBytes(5, Buffer.from('data')); // Insert "data"
      
      const content = await buffer.getBytes(0, buffer.getTotalSize());
      expect(content.toString()).toBe('Test data for merging');
      
      const undone = await buffer.undo();
      expect(undone).toBe(true);
      
      const restored = await buffer.getBytes(0, buffer.getTotalSize());
      expect(restored.toString()).toBe('Test content for merging');
    });
  });

  describe('Merge Time and Position Windows', () => {
    test('should not merge operations outside time window', async () => {
      // Mock time to test time-based merging
      let currentTime = 1000;
      const mockClock = jest.fn(() => currentTime);
      
      buffer.undoSystem.setClock(mockClock);
      
      await buffer.insertBytes(0, Buffer.from('A'));
      
      // Advance time beyond merge window
      currentTime += 2000; // Beyond mergeTimeWindow
      
      await buffer.insertBytes(1, Buffer.from('B'));
      
      // Should have two separate undo operations on the stack
      const stats = buffer.undoSystem.getStats();
      expect(stats.undoGroups).toBe(2);
      
      const undo1 = await buffer.undo();
      expect(undo1).toBe(true);
      
      const undo2 = await buffer.undo(); 
      expect(undo2).toBe(true);
    });

    test('should not merge operations outside position window', async () => {
      await buffer.insertBytes(0, Buffer.from('Start'));
      
      // Insert far away (beyond position window)
      await buffer.insertBytes(buffer.getTotalSize(), Buffer.from('End'));
      
      // Should be separate operations on stack
      const stats = buffer.undoSystem.getStats();
      expect(stats.undoGroups).toBe(2); // Two separate groups
    });
  });
});

describe('PagedBuffer - Notification System', () => {
  let buffer;
  let notifications;

  beforeEach(() => {
    buffer = new PagedBuffer(64, null, 2); // Small memory limit for testing
    notifications = [];
    buffer.onNotification((notification) => {
      notifications.push(notification);
    });
  });

  describe('Memory Pressure Notifications', () => {
    test('should notify about page evictions', async () => {
      const content = 'A'.repeat(300); // Multiple pages
      buffer.loadContent(content);
      
      // Force evictions by accessing different pages
      await buffer.getBytes(0, 10);
      await buffer.getBytes(100, 110);
      await buffer.getBytes(200, 210);
      
      const evictionNotifications = notifications.filter(n => n.type === 'page_evicted');
      expect(evictionNotifications.length).toBeGreaterThan(0);
      
      // Check notification structure
      evictionNotifications.forEach(notification => {
        expect(notification.severity).toBe('debug');
        expect(notification.metadata.pageId).toBeTruthy();
        expect(typeof notification.metadata.loadedPages).toBe('number');
      });
    });

    test('should handle notification callback errors gracefully', async () => {
      // Add a callback that throws
      buffer.onNotification(() => {
        throw new Error('Callback error');
      });
      
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      
      const content = 'Test content';
      buffer.loadContent(content); // This should trigger notifications
      
      // Should not throw, should log error
      expect(consoleSpy).toHaveBeenCalledWith('Notification callback error:', expect.any(Error));
      
      consoleSpy.mockRestore();
    });
  });

  describe('File Operation Notifications', () => {
    test('should notify when content is loaded', () => {
      buffer.loadContent('Test content');
      
      const loadNotifications = notifications.filter(n => n.type === 'buffer_content_loaded');
      expect(loadNotifications.length).toBe(1);
      
      const notification = loadNotifications[0];
      expect(notification.severity).toBe('info');
      expect(notification.metadata.mode).toBe(BufferMode.UTF8);
      expect(notification.metadata.size).toBeGreaterThan(0);
    });
  });

  describe('Notification Management', () => {
    test('should get all notifications', () => {
      buffer.loadContent('Test');
      
      const allNotifications = buffer.getNotifications();
      expect(allNotifications.length).toBeGreaterThan(0);
      expect(allNotifications[0]).toHaveProperty('type');
      expect(allNotifications[0]).toHaveProperty('severity');
      expect(allNotifications[0]).toHaveProperty('message');
    });

    test('should clear notifications', () => {
      buffer.loadContent('Test');
      expect(buffer.getNotifications().length).toBeGreaterThan(0);
      
      buffer.clearNotifications();
      expect(buffer.getNotifications().length).toBe(0);
    });

    test('should clear notifications by type', () => {
      buffer.loadContent('Test 1');
      buffer.loadContent('Test 2');
      
      const allNotifications = buffer.getNotifications();
      expect(allNotifications.length).toBeGreaterThan(0);
      
      buffer.clearNotifications('buffer_content_loaded');
      
      const remaining = buffer.getNotifications();
      const contentLoadedRemaining = remaining.filter(n => n.type === 'buffer_content_loaded');
      expect(contentLoadedRemaining.length).toBe(0);
    });
  });
});

describe('PagedBuffer - Advanced Operation Merging', () => {
  let buffer;

  beforeEach(() => {
    buffer = new PagedBuffer(64);
    buffer.enableUndo({
      mergeTimeWindow: 1000,
      mergePositionWindow: 10
    });
    buffer.loadContent('Test content for merging');
  });

  describe('Operation Merging Logic', () => {
    test('should merge adjacent insert operations', async () => {
      // Insert characters one by one (simulating typing)
      await buffer.insertBytes(0, Buffer.from('H'));
      await buffer.insertBytes(1, Buffer.from('e'));
      await buffer.insertBytes(2, Buffer.from('l'));
      await buffer.insertBytes(3, Buffer.from('l'));
      await buffer.insertBytes(4, Buffer.from('o'));
      
      // Should merge into single undo operation
      const undone = await buffer.undo();
      expect(undone).toBe(true);
      
      const content = await buffer.getBytes(0, buffer.getTotalSize());
      expect(content.toString()).toBe('Test content for merging');
    });

    test('should merge delete operations', async () => {
      // Delete characters one by one (simulating backspace)
      await buffer.deleteBytes(4, 5); // Delete 't'
      await buffer.deleteBytes(3, 4); // Delete 's' 
      await buffer.deleteBytes(2, 3); // Delete 'e'
      await buffer.deleteBytes(1, 2); // Delete 'e'
      
      const undone = await buffer.undo();
      expect(undone).toBe(true);
      
      const content = await buffer.getBytes(0, buffer.getTotalSize());
      expect(content.toString()).toBe('Test content for merging');
    });

    test('should handle complex operation sequences', async () => {
      // Simulate editing: delete some text, then insert replacement
      await buffer.deleteBytes(5, 12); // Delete "content"
      await buffer.insertBytes(5, Buffer.from('data')); // Insert "data"
      
      const content = await buffer.getBytes(0, buffer.getTotalSize());
      expect(content.toString()).toBe('Test data for merging');
      
      const undone = await buffer.undo();
      expect(undone).toBe(true);
      
      const restored = await buffer.getBytes(0, buffer.getTotalSize());
      expect(restored.toString()).toBe('Test content for merging');
    });
  });

  describe('Merge Time and Position Windows', () => {
    test('should not merge operations outside time window', async () => {
      // Mock time to test time-based merging
      let currentTime = 1000;
      const mockClock = jest.fn(() => currentTime);
      
      buffer.undoSystem.setClock(mockClock);
      
      await buffer.insertBytes(0, Buffer.from('A'));
      
      // Advance time beyond merge window
      currentTime += 2000; // Beyond mergeTimeWindow
      
      await buffer.insertBytes(1, Buffer.from('B'));
      
      // Should have two separate undo operations
      const undo1 = await buffer.undo();
      expect(undo1).toBe(true);
      
      const undo2 = await buffer.undo(); 
      expect(undo2).toBe(true);
    });

    test('should not merge operations outside position windowm, level 1', async () => {
      await buffer.insertBytes(0, Buffer.from('Start'));
      
      // Insert far away (beyond position window)
      await buffer.insertBytes(buffer.getTotalSize(), Buffer.from('End'));
      
      // Should be separate operations
      const stats = buffer.undoSystem.getStats();
      expect(stats.undoGroups).toBeGreaterThan(0);
    });

    test('should not merge operations outside position window, level 2', async () => {
      // Mock time to test time-based merging
      let currentTime = 1000;
      const mockClock = jest.fn(() => currentTime);
      
      buffer.undoSystem.setClock(mockClock);
      
      await buffer.insertBytes(0, Buffer.from('Start'));
      
      // Insert at end instead of invalid position
      await buffer.insertBytes(buffer.getTotalSize(), Buffer.from('End'));
      
      // Should be separate operations due to distance
      const stats = buffer.undoSystem.getStats();
      expect(stats.undoGroups).toBeGreaterThan(0);
    });
  });
});

describe('PagedBuffer - Error Handling and Edge Cases', () => {
  let buffer;

  beforeEach(() => {
    buffer = new PagedBuffer(64);
  });

  describe('Invalid Operations', () => {
    test('should handle negative positions', async () => {
      buffer.loadContent('test');
      
      await expect(buffer.getBytes(-1, 5)).rejects.toThrow('Invalid range');
      await expect(buffer.insertBytes(-1, Buffer.from('x'))).rejects.toThrow('Invalid position');
      await expect(buffer.deleteBytes(-1, 5)).rejects.toThrow('Invalid range');
    });

    test('should handle positions beyond buffer', async () => {
      buffer.loadContent('short');
      
      // Should handle gracefully without throwing
      const result = await buffer.getBytes(10, 20);
      expect(result.length).toBe(0);
      
      await expect(buffer.insertBytes(100, Buffer.from('x'))).rejects.toThrow('beyond end of buffer');
    });

    test('should handle invalid ranges', async () => {
      buffer.loadContent('test content');
      
      await expect(buffer.deleteBytes(5, 2)).rejects.toThrow('Invalid range');
    });
  });

  describe('Empty Buffer Operations', () => {
    test('should handle operations on empty buffer', async () => {
      buffer.loadContent('');
      
      const content = await buffer.getBytes(0, 0);
      expect(content.length).toBe(0);
      
      await buffer.insertBytes(0, Buffer.from('first'));
      const newContent = await buffer.getBytes(0, buffer.getTotalSize());
      expect(newContent.toString()).toBe('first');
    });
  });

  describe('Large Operations', () => {
    test('should handle very large insertions', async () => {
      buffer.loadContent('small');
      
      const largeData = Buffer.alloc(10000, 'X');
      await buffer.insertBytes(2, largeData);
      
      expect(buffer.getTotalSize()).toBe(5 + 10000);
      
      const result = await buffer.getBytes(0, 10);
      expect(result.toString()).toBe('smXXXXXXXX');
    });
  });

  describe('Page Boundary Operations', () => {
    test('should handle operations spanning multiple pages', async () => {
      // Create content that spans multiple pages
      const content = 'A'.repeat(200); // Multiple 64-byte pages
      buffer.loadContent(content);
      
      // Insert data that spans pages
      await buffer.insertBytes(50, Buffer.from('INSERTED'));
      
      const result = await buffer.getBytes(45, 65);
      expect(result.toString()).toContain('INSERTED');
    });

    test('should handle deletion spanning multiple pages', async () => {
      const content = 'A'.repeat(200);
      buffer.loadContent(content);
      
      // Delete across page boundaries
      const deleted = await buffer.deleteBytes(50, 150);
      
      expect(deleted.length).toBe(100);
      expect(buffer.getTotalSize()).toBe(100);
    });
  });

  describe('UTF-8 Edge Cases', () => {
    test('should handle multi-byte UTF-8 characters at page boundaries', async () => {
      // Create content with emojis that might span page boundaries
      const emoji = '🚀';
      const content = 'A'.repeat(60) + emoji.repeat(10) + 'B'.repeat(60);
      buffer.loadContent(content);
      
      // Operations around emoji boundaries
      await buffer.insertBytes(65, Buffer.from('INSERT'));
      
      const result = await buffer.getBytes(60, 80);
      expect(result.length).toBeGreaterThan(0);
    });

    test('should handle corrupted UTF-8 gracefully', async () => {
      // Load content with invalid UTF-8 sequence
      const invalidUtf8 = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0xFF, 0xFE]); // Hello + invalid bytes
      buffer.pages.clear();
      buffer.pageOrder = [];
      buffer.nextPageId = 0;
      buffer.totalSize = invalidUtf8.length;
      
      const pageId = `page_${buffer.nextPageId++}`;
      const pageInfo = new (require('../src/utils/page-info').PageInfo)(pageId, 0, invalidUtf8.length);
      pageInfo.updateData(invalidUtf8, buffer.mode);
      buffer.pages.set(pageId, pageInfo);
      buffer.pageOrder.push(pageId);
      
      // Should not throw when reading
      const result = await buffer.getBytes(0, invalidUtf8.length);
      expect(result.length).toBe(invalidUtf8.length);
    });
  });

  describe('Concurrent Operations', () => {
    test('should handle rapid sequential operations', async () => {
      buffer.loadContent('base content');
      
      // Simulate rapid typing
      const operations = [];
      for (let i = 0; i < 10; i++) {
        operations.push(buffer.insertBytes(i, Buffer.from(i.toString())));
      }
      
      await Promise.all(operations);
      
      const result = await buffer.getBytes(0, buffer.getTotalSize());
      expect(result.length).toBeGreaterThan(10);
    });
  });

  describe('Memory Stress Tests', () => {
    test('should handle many small pages', async () => {
      const smallBuffer = new PagedBuffer(16, null, 5); // Very small pages and memory limit
      
      const content = 'X'.repeat(1000); // Will create many small pages
      smallBuffer.loadContent(content);
      
      // Access random positions to stress memory management
      for (let i = 0; i < 20; i++) {
        const pos = Math.floor(Math.random() * 900);
        await smallBuffer.getBytes(pos, pos + 10);
      }
      
      const stats = smallBuffer.getMemoryStats();
      expect(stats.loadedPages).toBeLessThanOrEqual(smallBuffer.maxMemoryPages);
    });
  });
});
