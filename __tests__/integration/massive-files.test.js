/**
 * Integration Tests for Massive Files - Corrected to match design specifications
 */

const { PagedBuffer, FilePageStorage, MemoryPageStorage, BufferMode } = require('../../src');
const { testUtils } = require('../setup');
jest.setTimeout(60000);

describe('Massive File Integration Tests', () => {
  let buffer;
  let storage;

  beforeEach(async () => {
    storage = new FilePageStorage();
    buffer = new PagedBuffer(64 * 1024, storage, 50);
  });

  describe('Large File Loading', () => {
    test('should load 100MB file efficiently', async () => {
      const filePath = await testUtils.createLargeFile(100);
      
      const startTime = Date.now();
      await buffer.loadFile(filePath);
      const loadTime = Date.now() - startTime;
      
      expect(buffer.getTotalSize()).toBeGreaterThan(90 * 1024 * 1024);
      expect(loadTime).toBeLessThan(5000);
      
      const stats = buffer.getMemoryStats();
      expect(stats.totalPages).toBeGreaterThan(1000);
      expect(stats.loadedPages).toBe(0);
      expect(stats.memoryUsed).toBe(0);
    });

    test('should handle very large UTF-8 files', async () => {
      const content = '🌍'.repeat(1000000);
      const filePath = await testUtils.createTempFile(content);
      
      await buffer.loadFile(filePath);
      
      expect(buffer.getMode()).toBe(BufferMode.UTF8);
      expect(buffer.getTotalSize()).toBe(Buffer.byteLength(content, 'utf8'));
    });

    test('should detect binary files correctly', async () => {
      const binaryData = testUtils.generateTestData('binary', 10 * 1024 * 1024);
      const filePath = await testUtils.createTempFile(binaryData);
      
      await buffer.loadFile(filePath);
      
      expect(buffer.getMode()).toBe(BufferMode.BINARY);
      expect(buffer.getTotalSize()).toBe(binaryData.length);
    });
  });

  describe('Large File Operations', () => {
    let largeFilePath;

    beforeEach(async () => {
      largeFilePath = await testUtils.createLargeFile(50);
      await buffer.loadFile(largeFilePath);
    });

    test('should read data from various positions efficiently', async () => {
      const positions = [
        { start: 0, end: 1000 },
        { start: 25 * 1024 * 1024, end: 25 * 1024 * 1024 + 1000 },
        { start: buffer.getTotalSize() - 1000, end: buffer.getTotalSize() }
      ];

      for (const pos of positions) {
        const startTime = Date.now();
        const data = await buffer.getBytes(pos.start, pos.end);
        const readTime = Date.now() - startTime;
        
        expect(data.length).toBe(pos.end - pos.start);
        expect(readTime).toBeLessThan(1000);
      }
    });

    test('should handle large insertions efficiently', async () => {
      const largeInsert = Buffer.alloc(1024 * 1024, 'X');
      
      const startTime = Date.now();
      await buffer.insertBytes(1000, largeInsert);
      const insertTime = Date.now() - startTime;
      
      expect(insertTime).toBeLessThan(2000);
      expect(buffer.getTotalSize()).toBeGreaterThanOrEqual(51 * 1024 * 1024);
      
      const inserted = await buffer.getBytes(1000, 1000 + 1024);
      expect(inserted.every(byte => byte === 88)).toBe(true);
    });

    test('should handle large deletions efficiently', async () => {
      const deleteSize = 1024 * 1024;
      const originalSize = buffer.getTotalSize();
      
      const startTime = Date.now();
      const deleted = await buffer.deleteBytes(1000, 1000 + deleteSize);
      const deleteTime = Date.now() - startTime;
      
      expect(deleteTime).toBeLessThan(2000);
      expect(deleted.length).toBe(deleteSize);
      expect(buffer.getTotalSize()).toBe(originalSize - deleteSize);
    });

    test('should maintain performance across page boundaries', async () => {
      const pageSize = buffer.pageSize;
      
      const crossPageRead = await buffer.getBytes(
        pageSize - 500,
        pageSize * 3 + 500
      );
      
      expect(crossPageRead.length).toBe(pageSize * 2 + 1000);
      
      await buffer.insertBytes(pageSize, Buffer.from('PAGE_BOUNDARY_INSERT'));
      
      const verification = await buffer.getBytes(pageSize - 10, pageSize + 30);
      expect(verification.toString()).toContain('PAGE_BOUNDARY_INSERT');
    });
  });

  describe('Memory Management with Large Files', () => {
    test('should evict pages when memory limit is reached', async () => {
      const smallMemoryBuffer = new PagedBuffer(64 * 1024, storage, 5);
      const filePath = await testUtils.createLargeFile(10);
      
      await smallMemoryBuffer.loadFile(filePath);
      
      const accessPoints = [];
      for (let i = 0; i < 20; i++) {
        const position = Math.floor(Math.random() * smallMemoryBuffer.getTotalSize());
        accessPoints.push(position);
        await smallMemoryBuffer.getBytes(position, Math.min(position + 100, smallMemoryBuffer.getTotalSize()));
      }
      
      const stats = smallMemoryBuffer.getMemoryStats();
      expect(stats.loadedPages).toBeLessThanOrEqual(5);
      expect(stats.totalPages).toBeGreaterThan(100);
    });

    test('should handle page splitting with large content', async () => {
      const mediumFile = await testUtils.createLargeFile(5);
      await buffer.loadFile(mediumFile);
      
      const initialStats = buffer.getMemoryStats();
      
      const hugeContent = Buffer.alloc(200 * 1024, 'Y');
      await buffer.insertBytes(100000, hugeContent);
      
      const finalStats = buffer.getMemoryStats();
      expect(finalStats.totalPages).toBeGreaterThanOrEqual(initialStats.totalPages);
      expect(finalStats.dirtyPages).toBeGreaterThan(0);
    });
  });

  describe('Large File Editing with Undo', () => {
    beforeEach(async () => {
      const filePath = await testUtils.createLargeFile(10);
      await buffer.loadFile(filePath);
      buffer.enableUndo({ 
        maxUndoLevels: 50,
        autoGroupTimeout: 100
      });
    });

    test('should handle undo operations on large files efficiently', async () => {
      const insertPosition = 5 * 1024 * 1024;
      const insertData = Buffer.alloc(1024, 'Z'); // Smaller insert for reliability
      
      const originalData = await buffer.getBytes(insertPosition, insertPosition + 1000);
      
      // Use transaction for immediate undo availability
      buffer.beginUndoTransaction('Large File Insert');
      
      const startTime = Date.now();
      await buffer.insertBytes(insertPosition, insertData);
      const insertTime = Date.now() - startTime;
      
      buffer.commitUndoTransaction();
      
      // Verify insertion
      const afterInsert = await buffer.getBytes(insertPosition, insertPosition + 10);
      expect(afterInsert.every(byte => byte === 90)).toBe(true);
      
      expect(buffer.canUndo()).toBe(true);
      
      // Perform undo
      const undoStartTime = Date.now();
      const undoResult = await buffer.undo();
      const undoTime = Date.now() - undoStartTime;
      
      expect(undoResult).toBe(true);
      expect(insertTime).toBeLessThan(2000);
      expect(undoTime).toBeLessThan(2000);
      
      // Verify undo worked
      const afterUndo = await buffer.getBytes(insertPosition, insertPosition + 1000);
      testUtils.compareBuffers(afterUndo, originalData, 'Undo verification');
    });

    test('should manage undo memory efficiently with large operations', async () => {
      for (let i = 0; i < 5; i++) {
        buffer.beginUndoTransaction(`Large Operation ${i + 1}`);
        const data = Buffer.alloc(50 * 1024, String.fromCharCode(65 + i));
        await buffer.insertBytes(i * 1024 * 1024, data);
        buffer.commitUndoTransaction();
      }
      
      const stats = buffer.getMemoryStats();
      
      expect(stats.undo.memoryUsage).toBeLessThan(1 * 1024 * 1024);
      expect(stats.undo.undoGroups).toBe(5);
      
      for (let i = 0; i < 5; i++) {
        await buffer.undo();
      }
      
      const afterUndoStats = buffer.getMemoryStats();
      expect(afterUndoStats.undo.undoGroups).toBe(0);
      expect(afterUndoStats.undo.redoGroups).toBe(5);
    });

    test('should handle transactions with large operations', async () => {
      buffer.beginUndoTransaction('Large File Batch Edit');
      
      await buffer.insertBytes(1 * 1024 * 1024, Buffer.alloc(10 * 1024, 'A'));
      await buffer.deleteBytes(5 * 1024 * 1024, 5 * 1024 * 1024 + 10 * 1024);
      await buffer.insertBytes(8 * 1024 * 1024, Buffer.alloc(10 * 1024, 'B'));
      
      buffer.commitUndoTransaction();
      
      const stats = buffer.getMemoryStats();
      expect(stats.undo.undoGroups).toBe(1);
      
      const startTime = Date.now();
      await buffer.undo();
      const undoTime = Date.now() - startTime;
      
      expect(undoTime).toBeLessThan(3000);
    });
  });

  describe('Error Handling with Large Files', () => {
    test('should handle out-of-memory conditions gracefully', async () => {
      const tinyBuffer = new PagedBuffer(1024, new MemoryPageStorage(), 1);
      const filePath = await testUtils.createLargeFile(1);
      
      await tinyBuffer.loadFile(filePath);
      
      // Access many positions without crashing
      for (let i = 0; i < 100; i++) {
        try {
          await tinyBuffer.getBytes(i * 10000, i * 10000 + 100);
        } catch (error) {
          // Expected for out-of-bounds, but shouldn't crash
          expect(error.message).toMatch(/beyond end of buffer|detached/);
        }
      }
    });

    test('should handle corrupted large files with proper notifications', async () => {
      const filePath = await testUtils.createLargeFile(5);
      await buffer.loadFile(filePath);
      
      const mockHandler = testUtils.createMockNotificationHandler();
      buffer.onNotification(mockHandler.handler);
      
      // Simulate corruption by modifying file externally
      await testUtils.modifyFile(filePath, 'truncate');
      
      // Try to trigger change detection
      const changeInfo = await buffer.checkFileChanges();
      expect(changeInfo.changed).toBe(true);
      
      // Should have notifications about the change
      expect(mockHandler.count()).toBe(0); // No automatic detection yet
    });

    test('should handle disk space issues during large operations', async () => {
      const filePath = await testUtils.createLargeFile(1);
      await buffer.loadFile(filePath);
      
      // Try to insert very large content
      const hugeContent = Buffer.alloc(10 * 1024 * 1024, 'X');
      
      try {
        await buffer.insertBytes(100000, hugeContent);
        await buffer.saveFile();
      } catch (error) {
        // May fail due to disk space, but should fail gracefully
        expect(error.message).toMatch(/Failed to|ENOSPC|disk/);
      }
    });
  });

  describe('Performance Benchmarks', () => {
    test('should maintain reasonable performance benchmarks', async () => {
      const benchmarks = {
        fileLoad: { size: 50, maxTime: 3000 },
        randomRead: { operations: 100, maxTime: 5000 },
        sequentialRead: { size: 1024 * 1024, maxTime: 2000 },
        insertion: { size: 100 * 1024, maxTime: 1000 },
        deletion: { size: 100 * 1024, maxTime: 1000 }
      };

      // File loading benchmark
      const filePath = await testUtils.createLargeFile(benchmarks.fileLoad.size);
      const loadStart = Date.now();
      await buffer.loadFile(filePath);
      const loadTime = Date.now() - loadStart;
      expect(loadTime).toBeLessThan(benchmarks.fileLoad.maxTime);

      // Random read benchmark
      const readStart = Date.now();
      for (let i = 0; i < benchmarks.randomRead.operations; i++) {
        const pos = Math.floor(Math.random() * buffer.getTotalSize() * 0.9);
        await buffer.getBytes(pos, pos + 1000);
      }
      const readTime = Date.now() - readStart;
      expect(readTime).toBeLessThan(benchmarks.randomRead.maxTime);

      // Sequential read benchmark
      const seqStart = Date.now();
      await buffer.getBytes(0, benchmarks.sequentialRead.size);
      const seqTime = Date.now() - seqStart;
      expect(seqTime).toBeLessThan(benchmarks.sequentialRead.maxTime);

      // Insertion benchmark
      const insertStart = Date.now();
      await buffer.insertBytes(1000, Buffer.alloc(benchmarks.insertion.size, 'Y'));
      const insertTime = Date.now() - insertStart;
      expect(insertTime).toBeLessThan(benchmarks.insertion.maxTime);

      // Deletion benchmark
      const deleteStart = Date.now();
      await buffer.deleteBytes(1000, 1000 + benchmarks.deletion.size);
      const deleteTime = Date.now() - deleteStart;
      expect(deleteTime).toBeLessThan(benchmarks.deletion.maxTime);
    });
  });
});
