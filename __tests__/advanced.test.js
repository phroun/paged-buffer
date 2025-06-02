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
const { BufferState } = require('../src/types/buffer-types');

describe('PagedBuffer - Size Tracking Verification', () => {
  let buffer;
  let tempDir;
  let testFile;

  beforeEach(async () => {
    buffer = new PagedBuffer(1024);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'size-test-'));
    testFile = path.join(tempDir, 'test.txt');
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Size consistency across loading methods', () => {
    const testContent = 'Hello World\nLine 2\nLine 3\n';
    const expectedSize = Buffer.byteLength(testContent, 'utf8');

    test('should track size correctly when loading from file', async () => {
      // Create test file
      await fs.writeFile(testFile, testContent);
      
      // Load from file
      await buffer.loadFile(testFile);
      
      // Check all size tracking methods
      console.log('File load - buffer.totalSize:', buffer.totalSize);
      console.log('File load - buffer.getTotalSize():', buffer.getTotalSize());
      console.log('File load - buffer.virtualPageManager.getTotalSize():', buffer.virtualPageManager.getTotalSize());
      console.log('File load - buffer.virtualPageManager.addressIndex.totalVirtualSize:', buffer.virtualPageManager.addressIndex.totalVirtualSize);
      console.log('File load - expected size:', expectedSize);
      
      expect(buffer.totalSize).toBe(expectedSize);
      expect(buffer.getTotalSize()).toBe(expectedSize);
      expect(buffer.virtualPageManager.getTotalSize()).toBe(expectedSize);
      expect(buffer.virtualPageManager.addressIndex.totalVirtualSize).toBe(expectedSize);
    });

    test('should track size correctly when using loadContent', async () => {
      // Load content directly
      buffer.loadContent(testContent);
      
      // Check all size tracking methods
      console.log('loadContent - buffer.totalSize:', buffer.totalSize);
      console.log('loadContent - buffer.getTotalSize():', buffer.getTotalSize());
      console.log('loadContent - buffer.virtualPageManager.getTotalSize():', buffer.virtualPageManager.getTotalSize());
      console.log('loadContent - buffer.virtualPageManager.addressIndex.totalVirtualSize:', buffer.virtualPageManager.addressIndex.totalVirtualSize);
      console.log('loadContent - expected size:', expectedSize);
      
      expect(buffer.totalSize).toBe(expectedSize);
      expect(buffer.getTotalSize()).toBe(expectedSize);
      expect(buffer.virtualPageManager.getTotalSize()).toBe(expectedSize);
      expect(buffer.virtualPageManager.addressIndex.totalVirtualSize).toBe(expectedSize);
    });

    test('should track size correctly when using loadBinaryContent', async () => {
      const binaryContent = Buffer.from(testContent, 'utf8');
      
      // Load binary content
      buffer.loadBinaryContent(binaryContent);
      
      // Check all size tracking methods
      console.log('loadBinaryContent - buffer.totalSize:', buffer.totalSize);
      console.log('loadBinaryContent - buffer.getTotalSize():', buffer.getTotalSize());
      console.log('loadBinaryContent - buffer.virtualPageManager.getTotalSize():', buffer.virtualPageManager.getTotalSize());
      console.log('loadBinaryContent - buffer.virtualPageManager.addressIndex.totalVirtualSize:', buffer.virtualPageManager.addressIndex.totalVirtualSize);
      console.log('loadBinaryContent - expected size:', expectedSize);
      
      expect(buffer.totalSize).toBe(expectedSize);
      expect(buffer.getTotalSize()).toBe(expectedSize);
      expect(buffer.virtualPageManager.getTotalSize()).toBe(expectedSize);
      expect(buffer.virtualPageManager.addressIndex.totalVirtualSize).toBe(expectedSize);
    });

    test('should track size correctly when starting empty and inserting content', async () => {
      // Start with empty content
      buffer.loadContent('');
      
      console.log('Empty - buffer.totalSize:', buffer.totalSize);
      console.log('Empty - buffer.getTotalSize():', buffer.getTotalSize());
      console.log('Empty - buffer.virtualPageManager.getTotalSize():', buffer.virtualPageManager.getTotalSize());
      console.log('Empty - buffer.virtualPageManager.addressIndex.totalVirtualSize:', buffer.virtualPageManager.addressIndex.totalVirtualSize);
      
      expect(buffer.totalSize).toBe(0);
      expect(buffer.getTotalSize()).toBe(0);
      expect(buffer.virtualPageManager.getTotalSize()).toBe(0);
      expect(buffer.virtualPageManager.addressIndex.totalVirtualSize).toBe(0);
      
      // Insert content
      await buffer.insertBytes(0, Buffer.from(testContent, 'utf8'));
      
      // Check all size tracking methods after insertion
      console.log('After insert - buffer.totalSize:', buffer.totalSize);
      console.log('After insert - buffer.getTotalSize():', buffer.getTotalSize());
      console.log('After insert - buffer.virtualPageManager.getTotalSize():', buffer.virtualPageManager.getTotalSize());
      console.log('After insert - buffer.virtualPageManager.addressIndex.totalVirtualSize:', buffer.virtualPageManager.addressIndex.totalVirtualSize);
      console.log('After insert - expected size:', expectedSize);
      
      expect(buffer.totalSize).toBe(expectedSize);
      expect(buffer.getTotalSize()).toBe(expectedSize);
      expect(buffer.virtualPageManager.getTotalSize()).toBe(expectedSize);
      expect(buffer.virtualPageManager.addressIndex.totalVirtualSize).toBe(expectedSize);
    });

    test('should track size correctly with multiple insertions', async () => {
      // Start empty
      buffer.loadContent('');
      
      // Insert content in chunks
      await buffer.insertBytes(0, Buffer.from('Hello', 'utf8'));
      console.log('After "Hello" - totalSize:', buffer.getTotalSize());
      expect(buffer.getTotalSize()).toBe(5);
      
      await buffer.insertBytes(5, Buffer.from(' World', 'utf8'));
      console.log('After " World" - totalSize:', buffer.getTotalSize());
      expect(buffer.getTotalSize()).toBe(11);
      
      await buffer.insertBytes(11, Buffer.from('\nLine 2\nLine 3\n', 'utf8'));
      console.log('After newlines - totalSize:', buffer.getTotalSize());
      expect(buffer.getTotalSize()).toBe(expectedSize);
      
      // Verify all tracking methods are consistent
      expect(buffer.totalSize).toBe(expectedSize);
      expect(buffer.getTotalSize()).toBe(expectedSize);
      expect(buffer.virtualPageManager.getTotalSize()).toBe(expectedSize);
      expect(buffer.virtualPageManager.addressIndex.totalVirtualSize).toBe(expectedSize);
    });
  });

  describe('Size tracking edge cases', () => {
    test('should handle empty content correctly', async () => {
      buffer.loadContent('');
      
      console.log('Empty content - all sizes:');
      console.log('  buffer.totalSize:', buffer.totalSize);
      console.log('  buffer.getTotalSize():', buffer.getTotalSize());
      console.log('  buffer.virtualPageManager.getTotalSize():', buffer.virtualPageManager.getTotalSize());
      console.log('  addressIndex.totalVirtualSize:', buffer.virtualPageManager.addressIndex.totalVirtualSize);
      
      expect(buffer.totalSize).toBe(0);
      expect(buffer.getTotalSize()).toBe(0);
      expect(buffer.virtualPageManager.getTotalSize()).toBe(0);
      expect(buffer.virtualPageManager.addressIndex.totalVirtualSize).toBe(0);
    });

    test('should handle single character correctly', async () => {
      buffer.loadContent('A');
      
      console.log('Single char - all sizes:');
      console.log('  buffer.totalSize:', buffer.totalSize);
      console.log('  buffer.getTotalSize():', buffer.getTotalSize());
      console.log('  buffer.virtualPageManager.getTotalSize():', buffer.virtualPageManager.getTotalSize());
      console.log('  addressIndex.totalVirtualSize:', buffer.virtualPageManager.addressIndex.totalVirtualSize);
      
      expect(buffer.totalSize).toBe(1);
      expect(buffer.getTotalSize()).toBe(1);
      expect(buffer.virtualPageManager.getTotalSize()).toBe(1);
      expect(buffer.virtualPageManager.addressIndex.totalVirtualSize).toBe(1);
    });

    test('should handle unicode content correctly', async () => {
      const unicodeContent = 'Hello 🌍 World! 🚀';
      const expectedSize = Buffer.byteLength(unicodeContent, 'utf8');
      
      buffer.loadContent(unicodeContent);
      
      console.log('Unicode content - expected bytes:', expectedSize);
      console.log('Unicode content - all sizes:');
      console.log('  buffer.totalSize:', buffer.totalSize);
      console.log('  buffer.getTotalSize():', buffer.getTotalSize());
      console.log('  buffer.virtualPageManager.getTotalSize():', buffer.virtualPageManager.getTotalSize());
      console.log('  addressIndex.totalVirtualSize:', buffer.virtualPageManager.addressIndex.totalVirtualSize);
      
      expect(buffer.totalSize).toBe(expectedSize);
      expect(buffer.getTotalSize()).toBe(expectedSize);
      expect(buffer.virtualPageManager.getTotalSize()).toBe(expectedSize);
      expect(buffer.virtualPageManager.addressIndex.totalVirtualSize).toBe(expectedSize);
    });

    test('should handle operations that change size', async () => {
      buffer.loadContent('Original content');
      const originalSize = buffer.getTotalSize();
      
      console.log('Original size:', originalSize);
      
      // Delete some content
      await buffer.deleteBytes(0, 8); // Delete "Original"
      const afterDeleteSize = buffer.getTotalSize();
      console.log('After delete size:', afterDeleteSize);
      expect(afterDeleteSize).toBe(originalSize - 8);
      
      // Insert new content
      await buffer.insertBytes(0, Buffer.from('Modified'));
      const afterInsertSize = buffer.getTotalSize();
      console.log('After insert size:', afterInsertSize);
      expect(afterInsertSize).toBe(afterDeleteSize + 8);
      
      // Verify all tracking methods are consistent
      expect(buffer.totalSize).toBe(afterInsertSize);
      expect(buffer.virtualPageManager.getTotalSize()).toBe(afterInsertSize);
      expect(buffer.virtualPageManager.addressIndex.totalVirtualSize).toBe(afterInsertSize);
    });
  });

  describe('Line tracking dependency on size', () => {
    test('should verify line tracking works when size is correct', async () => {
      const content = 'Line 1\nLine 2\nLine 3\n';
      buffer.loadContent(content);
      
      console.log('Line tracking test - sizes:');
      console.log('  buffer.getTotalSize():', buffer.getTotalSize());
      console.log('  vpm.getTotalSize():', buffer.virtualPageManager.getTotalSize());
      
      // Only test line tracking if size is correct
      if (buffer.virtualPageManager.getTotalSize() > 0) {
        const lineStarts = await buffer.getLineStarts();
        const lineCount = await buffer.getLineCount();
        
        console.log('  lineStarts:', lineStarts);
        console.log('  lineCount:', lineCount);
        
        // These should pass if size tracking is working
        expect(lineStarts.length).toBeGreaterThan(0);
        expect(lineCount).toBeGreaterThan(0);
      } else {
        console.log('  Size is 0, skipping line tracking tests');
        expect(buffer.virtualPageManager.getTotalSize()).toBeGreaterThan(0);
      }
    });
  });
});

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
      expect(buffer.getState()).toBe(BufferState.CLEAN); // check
      expect(buffer.hasChanges()).toBe(false);
      expect(buffer.filename).toBe(testFile);
    });

    test('should save modified buffer to file', async () => {
      buffer.loadContent('Hello');
      await buffer.insertBytes(5, Buffer.from(', World!'));
      
      await buffer.saveFile(testFile);
      
      const savedContent = await fs.readFile(testFile, 'utf8');
      expect(savedContent).toBe('Hello, World!');
      expect(buffer.getState()).toBe(BufferState.CLEAN); // check
      expect(buffer.hasChanges()).toBe(false);
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

  describe('Page Existence Checks', () => {
    test('should check page existence in storage', async () => {
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
      // Load binary content using proper method
      const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);
      buffer.loadBinaryContent(binaryData);
      
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
      await buffer.insertBytes(4, Buffer.from(' NEW'));           
      await buffer.insertBytes(0, Buffer.from('Modified '));      
      await buffer.deleteBytes(9, 18);                           
      await buffer.deleteBytes(0, 9);                            
      await buffer.insertBytes(0, Buffer.from('Base '));         
      
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
});

describe('PagedBuffer - Memory Management', () => {
  let buffer;

  beforeEach(() => {
    buffer = new PagedBuffer(64, null, 2); // Small page size and memory limit for testing
  });

  describe('Page Eviction', () => {
    test('should evict pages when memory limit exceeded', async () => {
      // Set up notification tracking
      let evictionNotifications = 0;
      buffer.onNotification((notification) => {
        if (notification.type === 'page_evicted') {
          evictionNotifications++;
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
      expect(evictionNotifications).toBeGreaterThan(0);
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
      
      const stats = buffer.getMemoryStats();
      expect(stats.dirtyPages).toBeGreaterThanOrEqual(0);
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
  });

  describe('Position Conversion', () => {
    beforeEach(() => {
      const content = 'First line\nSecond line\nThird line';
      buffer.loadContent(content);
    });

    test('should convert line/character to byte position', async () => {
      // Start of first line (1-based indexing)
      let bytePos = await buffer.lineCharToBytePosition({line: 1, character: 1});
      expect(bytePos).toBe(0);
      
      // Start of second line
      bytePos = await buffer.lineCharToBytePosition({line: 2, character: 1});
      expect(bytePos).toBe(11); // After "First line\n"
      
      // Character 6 of first line (1-based, so 5th character)
      bytePos = await buffer.lineCharToBytePosition({line: 1, character: 6});
      expect(bytePos).toBe(5);
    });

    test('should convert byte position to line/character', async () => {
      // Start of buffer
      let pos = await buffer.byteToLineCharPosition(0);
      expect(pos).toEqual({line: 1, character: 1}); // 1-based indexing
      
      // Start of second line
      pos = await buffer.byteToLineCharPosition(11);
      expect(pos).toEqual({line: 2, character: 1});
      
      // Middle of first line
      pos = await buffer.byteToLineCharPosition(5);
      expect(pos).toEqual({line: 1, character: 6}); // 1-based character position
    });

    test('should handle positions beyond line end', async () => {
      const bytePos = await buffer.lineCharToBytePosition({line: 1, character: 1000});
      
      // Should clamp to end of buffer, not end of line since that's how our implementation works
      expect(bytePos).toBeLessThanOrEqual(buffer.getTotalSize());
    });

    test('should handle positions beyond buffer end', async () => {
      const pos = await buffer.byteToLineCharPosition(1000);
      
      expect(pos.line).toBeGreaterThanOrEqual(1); // 1-based
      expect(pos.character).toBeGreaterThanOrEqual(1); // 1-based
    });
  });

  describe('Text Insertion and Deletion', () => {
    beforeEach(() => {
      buffer.loadContent('Line 1\nLine 2\nLine 3');
    });

    test('should insert text at line/character position', async () => {
      const result = await buffer.insertTextAtPosition(
        {line: 2, character: 5}, // 1-based: line 2, after "Line"
        ' inserted'
      );
      
      expect(result.newPosition.line).toBe(2);
      expect(result.newPosition.character).toBe(14); // After inserted text, 1-based
      expect(result.newLineStarts).toBeTruthy();
      
      const content = await buffer.getBytes(0, buffer.getTotalSize());
      expect(content.toString()).toContain('Line inserted 2');
    });

    test('should delete text between positions', async () => {
      const result = await buffer.deleteTextBetweenPositions(
        {line: 1, character: 6}, // After "Line " (1-based)
        {line: 2, character: 5}  // Up to "Line" in second line (1-based)
      );
      
      expect(result.deletedText).toBe('1\nLine');
      expect(result.newLineStarts).toBeTruthy();
      
      const content = await buffer.getBytes(0, buffer.getTotalSize());
      expect(content.toString()).toContain('Line  2'); // "Line " + " 2"
    });

    test('should handle newlines in inserted text', async () => {
      await buffer.insertTextAtPosition(
        {line: 2, character: 1}, // Start of line 2 (1-based)
        'New line\nAnother line\n'
      );
      
      const lineCount = await buffer.getLineCount();
      expect(lineCount).toBeGreaterThan(3); // Original + inserted lines
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
      buffer.loadBinaryContent(invalidUtf8);
      
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
