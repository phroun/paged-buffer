/**
 * Integration Tests for Massive Files
 */

const { PagedBuffer, FilePageStorage, MemoryPageStorage, BufferMode } = require('../../src');
const { testUtils } = require('../setup');

describe('Massive File Integration Tests', () => {
  let buffer;
  let storage;

  beforeEach(async () => {
    storage = new FilePageStorage();
    buffer = new PagedBuffer(64 * 1024, storage, 50); // 64KB pages, 50 in memory
  });

  describe('Large File Loading', () => {
    test('should load 100MB file efficiently', async () => {
      const filePath = await testUtils.createLargeFile(100); // 100MB file
      
      const startTime = Date.now();
      await buffer.loadFile(filePath);
      const loadTime = Date.now() - startTime;
      
      expect(buffer.getTotalSize()).toBeGreaterThan(90 * 1024 * 1024); // At least 90MB
      expect(loadTime).toBeLessThan(5000); // Should load in under 5 seconds
      
      const stats = buffer.getMemoryStats();
      expect(stats.totalPages).toBeGreaterThan(1000);
      expect(stats.loadedPages).toBe(0); // No pages loaded initially
      expect(stats.memoryUsed).toBe(0);
    });

    test('should handle very large UTF-8 files', async () => {
      const content = '🌍'.repeat(1000000); // 4MB of UTF-8 content
      const filePath = await testUtils.createTempFile(content);
      
      await buffer.loadFile(filePath);
      
      expect(buffer.getMode()).toBe(BufferMode.UTF8);
      expect(buffer.getTotalSize()).toBe(Buffer.byteLength(content, 'utf8'));
    });

    test('should detect binary files correctly', async () => {
      const binaryData = testUtils.generateTestData('binary', 10 * 1024 * 1024); // 10MB binary
      const filePath = await testUtils.createTempFile(binaryData);
      
      await buffer.loadFile(filePath);
      
      expect(buffer.getMode()).toBe(BufferMode.BINARY);
      expect(buffer.getTotalSize()).toBe(binaryData.length);
    });
  });

  describe('Large File Operations', () => {
    let largeFilePath;

    beforeEach(async () => {
      largeFilePath = await testUtils.createLargeFile(50); // 50MB file
      await buffer.loadFile(largeFilePath);
    });

    test('should read data from various positions efficiently', async () => {
      const positions = [
        { start: 0, end: 1000 },              // Beginning
        { start: 25 * 1024 * 1024, end: 25 * 1024 * 1024 + 1000 }, // Middle
        { start: buffer.getTotalSize() - 1000, end: buffer.getTotalSize() } // End
      ];

      for (const pos of positions) {
        const startTime = Date.now();
        const data = await buffer.getBytes(pos.start, pos.end);
        const readTime = Date.now() - startTime;
        
        expect(data.length).toBe(pos.end - pos.start);
        expect(readTime).toBeLessThan(1000); // Should read in under 1 second
      }
    });

    test('should handle large insertions efficiently', async () => {
      const largeInsert = Buffer.alloc(1024 * 1024, 'X'); // 1MB insertion
      
      const startTime = Date.now();
      await buffer.insertBytes(1000, largeInsert);
      const insertTime = Date.now() - startTime;
      
      expect(insertTime).toBeLessThan(2000); // Should complete in under 2 seconds
      expect(buffer.getTotalSize()).toBeGreaterThanOrEqual(51 * 1024 * 1024); // Original + 1MB
      
      // Verify insertion worked
      const inserted = await buffer.getBytes(1000, 1000 + 1024);
      expect(inserted.every(byte => byte === 88)).toBe(true); // 'X' is ASCII 88
    });

    test('should handle large deletions efficiently', async () => {
      const deleteSize = 1024 * 1024; // Delete 1MB
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
      
      // Read across multiple page boundaries
      const crossPageRead = await buffer.getBytes(
        pageSize - 500,
        pageSize * 3 + 500
      );
      
      expect(crossPageRead.length).toBe(pageSize * 2 + 1000);
      
      // Insert across page boundary
      await buffer.insertBytes(pageSize, Buffer.from('PAGE_BOUNDARY_INSERT'));
      
      const verification = await buffer.getBytes(pageSize - 10, pageSize + 30);
      expect(verification.toString()).toContain('PAGE_BOUNDARY_INSERT');
    });
  });

  describe('Memory Management with Large Files', () => {
    test('should evict pages when memory limit is reached', async () => {
      const smallMemoryBuffer = new PagedBuffer(64 * 1024, storage, 5); // Only 5 pages in memory
      const filePath = await testUtils.createLargeFile(10); // 10MB file
      
      await smallMemoryBuffer.loadFile(filePath);
      
      // Access many different parts of the file to force page loading and eviction
      const accessPoints = [];
      for (let i = 0; i < 20; i++) {
        const position = Math.floor(Math.random() * smallMemoryBuffer.getTotalSize());
        accessPoints.push(position);
        await smallMemoryBuffer.getBytes(position, Math.min(position + 100, smallMemoryBuffer.getTotalSize()));
      }
      
      const stats = smallMemoryBuffer.getMemoryStats();
      expect(stats.loadedPages).toBeLessThanOrEqual(5); // Should respect memory limit
      expect(stats.totalPages).toBeGreaterThan(100); // Should have many pages total
    });

    test('should handle page splitting with large content', async () => {
      const mediumFile = await testUtils.createLargeFile(5); // 5MB file
      await buffer.loadFile(mediumFile);
      
      const initialStats = buffer.getMemoryStats();
      
      // Insert very large content to force page splitting
      const hugecontent = Buffer.alloc(200 * 1024, 'Y'); // 200KB insertion
      await buffer.insertBytes(100000, hugecontent);
      
      const finalStats = buffer.getMemoryStats();
      expect(finalStats.totalPages).toBeGreaterThanOrEqual(initialStats.totalPages);
      expect(finalStats.dirtyPages).toBeGreaterThan(0);
    });

    test('should provide accurate memory statistics for large files', async () => {
      const filePath = await testUtils.createLargeFile(20); // 20MB file
      await buffer.loadFile(filePath);
      
      // Access several different areas
      await buffer.getBytes(0, 1000);
      await buffer.getBytes(10 * 1024 * 1024, 10 * 1024 * 1024 + 1000);
      await buffer.getBytes(19 * 1024 * 1024, 19 * 1024 * 1024 + 1000);
      
      const stats = buffer.getMemoryStats();
      
      expect(stats.totalPages).toBeGreaterThan(300); // ~20MB / 64KB = ~320 pages
      expect(stats.loadedPages).toBeGreaterThan(0);
      expect(stats.loadedPages).toBeLessThanOrEqual(stats.maxMemoryPages);
      expect(stats.memoryUsed).toBeGreaterThan(0);
      expect(stats.memoryUsed).toBeLessThan(buffer.pageSize * buffer.maxMemoryPages);
    });
  });

  describe('Large File Editing with Undo', () => {
    beforeEach(async () => {
      const filePath = await testUtils.createLargeFile(10); // 10MB file
      await buffer.loadFile(filePath);
      buffer.enableUndo({ maxUndoLevels: 50 });
    });

    test('should handle undo operations on large files efficiently', async () => {
      const insertPosition = 5 * 1024 * 1024; // 5MB mark
      const insertData = Buffer.alloc(100 * 1024, 'Z'); // 100KB insert
      
      // Get original data at insertion point for comparison
      const originalData = await buffer.getBytes(insertPosition, insertPosition + 1000);
      console.log('Original data sample:', originalData.subarray(0, 10));
      
      // Verify undo system is enabled and working
      expect(buffer.undoSystem).toBeDefined();
      
      // Use transaction to ensure operation is immediately available for undo
      buffer.beginUndoTransaction('Large File Insert');
      
      // Perform insertion
      const startTime = Date.now();
      await buffer.insertBytes(insertPosition, insertData);
      const insertTime = Date.now() - startTime;
      
      // Commit transaction
      buffer.commitUndoTransaction();
      
      // Verify insertion worked
      const afterInsert = await buffer.getBytes(insertPosition, insertPosition + 10);
      console.log('After insert (first 10 bytes):', Array.from(afterInsert));
      expect(afterInsert.every(byte => byte === 90)).toBe(true);
      
      // Verify undo is now available
      const canUndoAfterInsert = buffer.canUndo();
      console.log('Can undo after insert:', canUndoAfterInsert);
      expect(canUndoAfterInsert).toBe(true);
      
      // Check undo system state
      const undoStats = buffer.getMemoryStats().undo;
      console.log('Undo stats after transaction:', undoStats);
      expect(undoStats.undoGroups).toBeGreaterThan(0);
      
      // Perform undo
      const undoStartTime = Date.now();
      const undoResult = await buffer.undo();
      const undoTime = Date.now() - undoStartTime;
      
      console.log('Undo result:', undoResult);
      expect(undoResult).toBe(true); // Undo should succeed
      expect(insertTime).toBeLessThan(2000);
      expect(undoTime).toBeLessThan(2000);
      
      // Verify undo worked - data should match original
      const afterUndo = await buffer.getBytes(insertPosition, insertPosition + 1000);
      console.log('After undo (first 10 bytes):', Array.from(afterUndo.subarray(0, 10)));
      console.log('Original (first 10 bytes):', Array.from(originalData.subarray(0, 10)));
      
      // Compare with original data
      try {
        testUtils.compareBuffers(afterUndo, originalData, 'Undo verification');
      } catch (error) {
        console.error('Buffer comparison failed:', error.message);
        // Log more details for debugging
        console.log('After undo length:', afterUndo.length);
        console.log('Original length:', originalData.length);
        console.log('Buffer total size after undo:', buffer.getTotalSize());
        throw error;
      }
      
      // Also verify no Z bytes remain at insertion point
      const hasZBytes = afterUndo.some(byte => byte === 90);
      if (hasZBytes) {
        console.log('Found Z bytes at positions:', 
          Array.from(afterUndo).map((byte, idx) => byte === 90 ? idx : null).filter(idx => idx !== null)
        );
      }
      expect(hasZBytes).toBe(false); // 'Z' should be gone
    });

    test('should manage undo memory efficiently with large operations', async () => {
      // Perform several large operations using transactions
      for (let i = 0; i < 5; i++) {
        buffer.beginUndoTransaction(`Large Operation ${i + 1}`);
        const data = Buffer.alloc(50 * 1024, String.fromCharCode(65 + i)); // 50KB each
        await buffer.insertBytes(i * 1024 * 1024, data);
        buffer.commitUndoTransaction();
      }
      
      const stats = buffer.getMemoryStats();
      
      // Undo memory should be reasonable compared to total operations
      expect(stats.undo.memoryUsage).toBeLessThan(1 * 1024 * 1024); // Under 1MB
      expect(stats.undo.undoGroups).toBe(5);
      
      // Undo all operations
      for (let i = 0; i < 5; i++) {
        await buffer.undo();
      }
      
      // Memory should be freed after undo
      const afterUndoStats = buffer.getMemoryStats();
      expect(afterUndoStats.undo.undoGroups).toBe(0);
      expect(afterUndoStats.undo.redoGroups).toBe(5);
    });

    test('should handle transactions with large operations', async () => {
      buffer.beginUndoTransaction('Large File Batch Edit');
      
      // Perform multiple large operations in transaction
      await buffer.insertBytes(1 * 1024 * 1024, Buffer.alloc(10 * 1024, 'A'));
      await buffer.deleteBytes(5 * 1024 * 1024, 5 * 1024 * 1024 + 10 * 1024);
      await buffer.insertBytes(8 * 1024 * 1024, Buffer.alloc(10 * 1024, 'B'));
      
      buffer.commitUndoTransaction();
      
      const stats = buffer.getMemoryStats();
      expect(stats.undo.undoGroups).toBe(1); // Single transaction
      
      const startTime = Date.now();
      await buffer.undo(); // Should undo entire transaction
      const undoTime = Date.now() - startTime;
      
      expect(undoTime).toBeLessThan(3000); // Should complete in reasonable time
    });
  });

  describe('Error Handling with Large Files', () => {
    test('should handle out-of-memory conditions gracefully', async () => {
      // Create buffer with very limited memory
      const tinyBuffer = new PagedBuffer(1024, new MemoryPageStorage(), 1);
      const filePath = await testUtils.createLargeFile(1); // 1MB file
      
      await tinyBuffer.loadFile(filePath);
      
      // Try to access data that would exceed memory limits
      await expect(async () => {
        for (let i = 0; i < 100; i++) {
          await tinyBuffer.getBytes(i * 10000, i * 10000 + 100);
        }
      }).not.toThrow(); // Should handle gracefully without throwing
    });

    test('should handle corrupted large files', async () => {
      const filePath = await testUtils.createLargeFile(5);
      await buffer.loadFile(filePath);
      
      // Simulate corruption by modifying file externally
      await testUtils.modifyFile(filePath, 'truncate');
      
      // Buffer should detect and handle the change
      const notifications = [];
      buffer.onNotification((notification) => {
        notifications.push(notification);
      });
      
      // Trigger file check
      await buffer.getBytes(0, 100);
      
      // Should have received notifications about file changes
      expect(notifications.length).toBeGreaterThan(0);
    });

    test('should handle disk space issues during large operations', async () => {
      const filePath = await testUtils.createLargeFile(1);
      await buffer.loadFile(filePath);
      
      // Try to insert extremely large content that might cause disk issues
      const hugeContent = Buffer.alloc(10 * 1024 * 1024, 'X'); // 10MB
      
      // This might fail due to disk space, but should fail gracefully
      try {
        await buffer.insertBytes(100000, hugeContent);
        await buffer.saveFile();
      } catch (error) {
        expect(error.message).toContain('Failed to save file');
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
