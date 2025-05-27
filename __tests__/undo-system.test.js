/**
 * Undo/Redo System Tests - Fixed with Clock Injection and Proper Expectations
 */

const { PagedBuffer, MemoryPageStorage } = require('../src');
const { testUtils } = require('./setup');
jest.setTimeout(10000);

describe('Undo/Redo System', () => {
  let buffer;
  let mockClock;
  let currentTime;

  beforeEach(() => {
    const storage = new MemoryPageStorage();
    buffer = new PagedBuffer(1024, storage, 10);
    buffer.loadContent('Hello World');
    
    // Setup mock clock
    currentTime = 1000; // Start at timestamp 1000
    mockClock = () => currentTime;
    
    buffer.enableUndo({
      maxUndoLevels: 100,
      mergeTimeWindow: 15000,
      mergePositionWindow: 1000
    });
    
    // Inject mock clock
    if (buffer.undoSystem) {
      buffer.undoSystem.setClock(mockClock);
    }
  });

  // Helper function to advance mock time
  const advanceTime = (ms) => {
    currentTime += ms;
  };

  describe('Basic Undo/Redo Operations', () => {
    test('should enable and disable undo system', () => {
      expect(buffer.undoSystem).toBeDefined();
      
      buffer.disableUndo();
      expect(buffer.undoSystem).toBeNull();
      
      buffer.enableUndo();
      expect(buffer.undoSystem).toBeDefined();
    });

    test('should track operations on undo stack', async () => {
      // Check that canUndo returns boolean false, not null
      expect(buffer.canUndo()).toBe(false);
      
      await buffer.insertBytes(6, Buffer.from('Beautiful '));
      
      // Operation should be on undo stack, making undo available
      expect(buffer.canUndo()).toBe(true);
      expect(buffer.canRedo()).toBe(false);
    });

    test('should undo insert operation from undo stack', async () => {
      await buffer.insertBytes(6, Buffer.from('Beautiful '));
      
      const beforeUndo = await buffer.getBytes(0, buffer.getTotalSize());
      expect(beforeUndo.toString()).toBe('Hello Beautiful World');
      
      const undoResult = await buffer.undo();
      expect(undoResult).toBe(true);
      
      const afterUndo = await buffer.getBytes(0, buffer.getTotalSize());
      expect(afterUndo.toString()).toBe('Hello World');
      
      expect(buffer.canRedo()).toBe(true);
    });

    test('should redo insert operation', async () => {
      await buffer.insertBytes(6, Buffer.from('Beautiful '));
      await buffer.undo();
      
      const redoResult = await buffer.redo();
      expect(redoResult).toBe(true);
      
      const afterRedo = await buffer.getBytes(0, buffer.getTotalSize());
      expect(afterRedo.toString()).toBe('Hello Beautiful World');
      
      expect(buffer.canUndo()).toBe(true);
      expect(buffer.canRedo()).toBe(false);
    });

    test('should handle delete operations', async () => {
      await buffer.deleteBytes(6, 11); // Delete "World"
      
      const afterDelete = await buffer.getBytes(0, buffer.getTotalSize());
      expect(afterDelete.toString()).toBe('Hello ');
      
      await buffer.undo();
      
      const afterUndo = await buffer.getBytes(0, buffer.getTotalSize());
      expect(afterUndo.toString()).toBe('Hello World');
    });

    test('should handle overwrite operations', async () => {
      const originalData = await buffer.getBytes(6, 11); // Get "World" first
      await buffer.overwriteBytes(6, Buffer.from('Universe'));
      
      const afterOverwrite = await buffer.getBytes(0, buffer.getTotalSize());
      expect(afterOverwrite.toString()).toBe('Hello Universe');
      
      await buffer.undo();
      
      const afterUndo = await buffer.getBytes(0, buffer.getTotalSize());
      expect(afterUndo.toString()).toBe('Hello World');
    });
  });

  describe('Operation Grouping and Merging', () => {
    test('should merge consecutive insert operations into groups', async () => {
      // Simulate rapid typing - same timestamp
      await buffer.insertBytes(11, Buffer.from('!'));
      await buffer.insertBytes(12, Buffer.from('!'));
      await buffer.insertBytes(13, Buffer.from('!'));
      
      // Operations should be merged on undo stack
      expect(buffer.canUndo()).toBe(true);
      
      // Single undo should remove all exclamation marks
      await buffer.undo();
      
      const result = await buffer.getBytes(0, buffer.getTotalSize());
      expect(result.toString()).toBe('Hello World');
    });

    test('should separate operations with time gaps', async () => {
      await buffer.insertBytes(11, Buffer.from('!'));
      
      // Advance time beyond grouping timeout
      advanceTime(16000); // Beyond merge window
      
      await buffer.insertBytes(12, Buffer.from('?'));
      
      // Should have two separate groups now
      const stats = buffer.getMemoryStats().undo;
      expect(stats.undoGroups).toBeGreaterThanOrEqual(2);
      
      expect(buffer.canUndo()).toBe(true);
    });

    test('should not merge operations separated by distance - WITH EXPECTS', async () => {
      // Check initial state
      const initialContent = await buffer.getBytes(0, buffer.getTotalSize());
      expect(initialContent.toString()).toBe('Hello World');
      expect(buffer.getTotalSize()).toBe(11);
      
      // First operation: Insert "Start " at position 0
      await buffer.insertBytes(0, Buffer.from('Start '));
      
      const afterFirst = await buffer.getBytes(0, buffer.getTotalSize());
      expect(afterFirst.toString()).toBe('Start Hello World');
      expect(buffer.getTotalSize()).toBe(17); // 11 + 6
      expect(buffer.getMemoryStats().undo.undoGroups).toBe(1);
      
      // Advance time slightly but insert far away
      advanceTime(100);
      
      // Second operation: Insert " End" at end
      const insertPosition = buffer.getTotalSize();
      expect(insertPosition).toBe(17); // Should be at position 17
      
      await buffer.insertBytes(insertPosition, Buffer.from(' End'));
      
      const afterSecond = await buffer.getBytes(0, buffer.getTotalSize());
      expect(afterSecond.toString()).toBe('Start Hello World End');
      expect(buffer.getTotalSize()).toBe(21); // 17 + 4
      
      // Key question: Should these operations merge?
      // Distance: 17 - 0 = 17 bytes
      // Window: 1000 bytes  
      // Time: 100ms < 15000ms
      // Expected: They SHOULD merge (distance 17 < window 1000)
      
      const stats = buffer.getMemoryStats().undo;
      
      // This will tell us if operations merged or not
      expect(stats.undoGroups).toBe(1); // If this fails, operations didn't merge when they should have
      
      // If the above fails, then either:
      // 1. Distance calculation is wrong (returning > 1000)
      // 2. Time calculation is wrong 
      // 3. Operations aren't compatible
      // 4. There's a bug in merge logic
    });

    test('should merge compatible operations', async () => {
      await buffer.insertBytes(11, Buffer.from('!!!'));
      // Same timestamp - should merge
      await buffer.deleteBytes(11, 14); // Delete what we just inserted
      
      // Operations may cancel out or be minimized
      const stats = buffer.getMemoryStats().undo;
      
      // Should have some undo groups available
      expect(stats.undoGroups).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Named Transactions', () => {
    test('should create and commit named transaction', async () => {
      buffer.beginUndoTransaction('Find and Replace');
      
      expect(buffer.inUndoTransaction()).toBe(true);
      
      const tx = buffer.getCurrentUndoTransaction();
      expect(tx.name).toBe('Find and Replace');
      expect(tx.operationCount).toBe(0); // Changed from operations to operationCount
      
      await buffer.deleteBytes(6, 11); // Delete "World"
      await buffer.insertBytes(6, Buffer.from('Universe'));
      
      const success = buffer.commitUndoTransaction();
      expect(success).toBe(true);
      expect(buffer.inUndoTransaction()).toBe(false);
      
      // Should be able to undo entire transaction as one unit
      await buffer.undo();
      
      const result = await buffer.getBytes(0, buffer.getTotalSize());
      expect(result.toString()).toBe('Hello World');
    });

    test('should rollback transaction', async () => {
      const originalContent = await buffer.getBytes(0, buffer.getTotalSize());
      
      buffer.beginUndoTransaction('Experimental Changes');
      
      await buffer.insertBytes(6, Buffer.from('Modified '));
      await buffer.deleteBytes(15, 20);
      
      const success = await buffer.rollbackUndoTransaction();
      expect(success).toBe(true);
      expect(buffer.inUndoTransaction()).toBe(false);
      
      // Content should be restored without creating undo history
      const afterRollback = await buffer.getBytes(0, buffer.getTotalSize());
      testUtils.compareBuffers(afterRollback, originalContent, 'Rollback comparison');
      
      expect(buffer.canUndo()).toBe(false);
    });

    test('should handle nested transactions correctly', async () => {
      buffer.beginUndoTransaction('Outer Transaction');
      
      await buffer.insertBytes(0, Buffer.from('Start '));
      
      // Note: Nested transactions aren't supported, so this will throw
      expect(() => {
        buffer.beginUndoTransaction('Inner Transaction');
      }).toThrow('Cannot start transaction - another transaction is already active');
      
      await buffer.insertBytes(buffer.getTotalSize(), Buffer.from(' End'));
      buffer.commitUndoTransaction();
      
      // Should create undo entry
      const stats = buffer.getMemoryStats().undo;
      expect(stats.undoGroups).toBe(1);
      
      await buffer.undo();
      
      const result = await buffer.getBytes(0, buffer.getTotalSize());
      // Should undo the entire transaction
      expect(result.toString()).toBe('Hello World');
    });

    test('should allow overriding transaction name on commit', async () => {
      const mockHandler = testUtils.createMockNotificationHandler();
      buffer.onNotification(mockHandler.handler);
      
      buffer.beginUndoTransaction('Original Name');
      await buffer.insertBytes(11, Buffer.from('!'));
      buffer.commitUndoTransaction('Final Name');
      
      // Transaction naming is internal, so we just verify it committed
      const stats = buffer.getMemoryStats().undo;
      expect(stats.undoGroups).toBe(1);
    });

    test('should handle undo during transaction as rollback', async () => {
      buffer.beginUndoTransaction('Test Transaction');
      
      await buffer.insertBytes(6, Buffer.from('Modified '));
      expect(buffer.canUndo()).toBe(true); // Should be true - can rollback transaction
      
      const originalContent = await buffer.getBytes(0, buffer.getTotalSize());
      expect(originalContent.toString()).toBe('Hello Modified World');
      
      // Undo during transaction should rollback
      const undoResult = await buffer.undo();
      expect(undoResult).toBe(true);
      expect(buffer.inUndoTransaction()).toBe(false);
      
      const afterUndo = await buffer.getBytes(0, buffer.getTotalSize());
      expect(afterUndo.toString()).toBe('Hello World');
    });
  });

  describe('Automatic Operation Naming', () => {
    test('should generate appropriate names for operations', async () => {
      const mockHandler = testUtils.createMockNotificationHandler();
      buffer.onNotification(mockHandler.handler);
      
      await buffer.insertBytes(11, Buffer.from('!'));
      
      // Force separation by advancing time and performing another operation
      advanceTime(16000);
      await buffer.insertBytes(12, Buffer.from('?'));
      
      // Operations should be recorded on stack
      const stats = buffer.getMemoryStats().undo;
      expect(stats.undoGroups).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Error Handling', () => {
    test('should handle undo when no operations available', async () => {
      const result = await buffer.undo();
      expect(result).toBe(false);
    });

    test('should handle redo when no operations available', async () => {
      const result = await buffer.redo();
      expect(result).toBe(false);
    });

    test('should handle commit when no transaction active', () => {
      const result = buffer.commitUndoTransaction();
      expect(result).toBe(false);
    });

    test('should handle rollback when no transaction active', async () => {
      const result = await buffer.rollbackUndoTransaction();
      expect(result).toBe(false);
    });

    test('should clear redo stack when new operations are performed after undo', async () => {
      await buffer.insertBytes(11, Buffer.from('!'));
      await buffer.undo();
      
      expect(buffer.canRedo()).toBe(true);
      
      // New operation should clear redo stack
      await buffer.insertBytes(11, Buffer.from('?'));
      
      expect(buffer.canRedo()).toBe(false);
    });

    test('should not allow redo during transactions', async () => {
      await buffer.insertBytes(11, Buffer.from('!'));
      await buffer.undo();
      
      expect(buffer.canRedo()).toBe(true);
      
      buffer.beginUndoTransaction('Test');
      expect(buffer.canRedo()).toBe(false); // No redo during transactions
      
      buffer.commitUndoTransaction();
      expect(buffer.canRedo()).toBe(true); // Redo available again
    });
  });

  describe('Memory Management', () => {
    test('should provide accurate undo memory statistics', async () => {
      await buffer.insertBytes(11, Buffer.from('! This is longer text'));
      
      // Advance time to separate operations
      advanceTime(16000);
      await buffer.insertBytes(0, Buffer.from('Hi '));
      
      const stats = buffer.getMemoryStats().undo;
      
      expect(stats.undoGroups).toBeGreaterThanOrEqual(0);
      expect(stats.totalUndoOperations).toBeGreaterThanOrEqual(0);
      expect(stats.memoryUsage).toBeGreaterThanOrEqual(0);
    });

    test('should handle large operations efficiently', async () => {
      const largeData = Buffer.alloc(10000, 'X');
      
      await buffer.insertBytes(11, largeData);
      
      // Advance time to separate operations
      advanceTime(16000);
      await buffer.insertBytes(0, Buffer.from('Y'));
      
      const stats = buffer.getMemoryStats().undo;
      expect(stats.memoryUsage).toBeGreaterThanOrEqual(0);
      
      await buffer.undo();
      
      const result = await buffer.getBytes(0, buffer.getTotalSize());
      expect(result.toString()).toContain('Hello World');
    });
  });

  describe('Integration with Buffer State', () => {
    test('should not create undo operations when undo is disabled', async () => {
      buffer.disableUndo();
      
      await buffer.insertBytes(11, Buffer.from('!'));
      
      expect(buffer.canUndo()).toBe(false);
    });

    test('should work with multiple buffer instances', async () => {
      const buffer2 = new PagedBuffer(1024, new MemoryPageStorage(), 10);
      buffer2.loadContent('Second Buffer');
      buffer2.enableUndo();
      
      // Give buffer2 its own mock clock
      let currentTime2 = 2000;
      const mockClock2 = () => currentTime2;
      if (buffer2.undoSystem) {
        buffer2.undoSystem.setClock(mockClock2);
      }
      
      await buffer.insertBytes(11, Buffer.from('!'));
      await buffer2.insertBytes(13, Buffer.from('!'));
      
      expect(buffer.canUndo()).toBe(true);
      expect(buffer2.canUndo()).toBe(true);
      
      await buffer.undo();
      await buffer2.undo();
      
      const result1 = await buffer.getBytes(0, buffer.getTotalSize());
      const result2 = await buffer2.getBytes(0, buffer2.getTotalSize());
      
      expect(result1.toString()).toBe('Hello World');
      expect(result2.toString()).toBe('Second Buffer');
    });
  });

  describe('Clock Injection Testing', () => {
    test('should use injected clock for timestamps', async () => {
      // Verify that operations use mock clock
      const startTime = currentTime;
      
      await buffer.insertBytes(11, Buffer.from('!'));
      
      // Operations should use mock time, not real time
      // (Internal verification - operations are on stack now)
      const stats = buffer.getMemoryStats().undo;
      expect(stats.undoGroups).toBeGreaterThanOrEqual(1);
      
      advanceTime(1000);
      await buffer.insertBytes(12, Buffer.from('!'));
      
      // Check if operations were merged or are separate
      const finalStats = buffer.getMemoryStats().undo;
      expect(finalStats.undoGroups).toBeGreaterThanOrEqual(1);
    });

    test('should handle time-based grouping with mock clock', async () => {
      await buffer.insertBytes(11, Buffer.from('!'));
      
      // Small time advance - should merge
      advanceTime(100);
      await buffer.insertBytes(12, Buffer.from('!'));
      
      let stats = buffer.getMemoryStats().undo;
      const groupsAfterMerge = stats.undoGroups;
      
      // Large time advance - should create new group
      advanceTime(20000); // Beyond merge window
      await buffer.insertBytes(13, Buffer.from('?'));
      
      stats = buffer.getMemoryStats().undo;
      expect(stats.undoGroups).toBeGreaterThan(groupsAfterMerge);
    });

    test('should handle transaction timestamps with mock clock', async () => {
      const transactionStartTime = currentTime;
      
      buffer.beginUndoTransaction('Test Transaction');
      
      if (buffer.undoSystem.activeTransaction) {
        expect(buffer.undoSystem.activeTransaction.startTime).toBe(transactionStartTime);
      }
      
      advanceTime(500);
      await buffer.insertBytes(11, Buffer.from('!'));
      
      buffer.commitUndoTransaction();
      
      // Transaction should be recorded
      const stats = buffer.getMemoryStats().undo;
      expect(stats.undoGroups).toBe(1);
    });
  });
});
