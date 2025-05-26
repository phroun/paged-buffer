/**
 * Undo/Redo System Tests
 */

const { PagedBuffer, MemoryPageStorage } = require('../src');
const { testUtils } = require('./setup');

describe('Undo/Redo System', () => {
  let buffer;

  beforeEach(() => {
    const storage = new MemoryPageStorage();
    buffer = new PagedBuffer(1024, storage, 10);
    buffer.loadContent('Hello World');
    buffer.enableUndo({
      maxUndoLevels: 100,
      mergeTimeWindow: 15000,
      mergePositionWindow: 1000
    });
  });

  describe('Basic Undo/Redo Operations', () => {
    test('should enable and disable undo system', () => {
      expect(buffer.undoSystem).toBeDefined();
      
      buffer.disableUndo();
      expect(buffer.undoSystem).toBeNull();
      
      buffer.enableUndo();
      expect(buffer.undoSystem).toBeDefined();
    });

    test('should track simple insert operation', async () => {
      expect(buffer.canUndo()).toBe(false);
      
      await buffer.insertBytes(6, Buffer.from('Beautiful '));
      
      expect(buffer.canUndo()).toBe(true);
      expect(buffer.canRedo()).toBe(false);
    });

    test('should undo insert operation', async () => {
      await buffer.insertBytes(6, Buffer.from('Beautiful '));
      
      const beforeUndo = await buffer.getBytes(0, 21);
      expect(beforeUndo.toString()).toBe('Hello Beautiful World');
      
      const undoResult = await buffer.undo();
      expect(undoResult).toBe(true);
      
      const afterUndo = await buffer.getBytes(0, 11);
      expect(afterUndo.toString()).toBe('Hello World');
      
      expect(buffer.canUndo()).toBe(false);
      expect(buffer.canRedo()).toBe(true);
    });

    test('should redo insert operation', async () => {
      await buffer.insertBytes(6, Buffer.from('Beautiful '));
      await buffer.undo();
      
      const redoResult = await buffer.redo();
      expect(redoResult).toBe(true);
      
      const afterRedo = await buffer.getBytes(0, 21);
      expect(afterRedo.toString()).toBe('Hello Beautiful World');
      
      expect(buffer.canUndo()).toBe(true);
      expect(buffer.canRedo()).toBe(false);
    });

    test('should handle delete operations', async () => {
      await buffer.deleteBytes(6, 11); // Delete "World"
      
      const afterDelete = await buffer.getBytes(0, 6);
      expect(afterDelete.toString()).toBe('Hello ');
      
      await buffer.undo();
      
      const afterUndo = await buffer.getBytes(0, 11);
      expect(afterUndo.toString()).toBe('Hello World');
    });

    test('should handle overwrite operations', async () => {
      await buffer.overwriteBytes(6, Buffer.from('Universe'));
      
      const afterOverwrite = await buffer.getBytes(0, 14);
      expect(afterOverwrite.toString()).toBe('Hello Universe');
      
      await buffer.undo();
      
      const afterUndo = await buffer.getBytes(0, 11);
      expect(afterUndo.toString()).toBe('Hello World');
    });
  });

  describe('Operation Merging', () => {
    test('should merge consecutive insert operations', async () => {
      // Simulate typing
      await buffer.insertBytes(11, Buffer.from('!'));
      await buffer.insertBytes(12, Buffer.from('!'));
      await buffer.insertBytes(13, Buffer.from('!'));
      
      const stats = buffer.getMemoryStats().undo;
      expect(stats.undoGroups).toBe(1); // Should be merged into one group
      
      await buffer.undo();
      
      const result = await buffer.getBytes(0, 11);
      expect(result.toString()).toBe('Hello World');
    });

    test('should merge backspace operations', async () => {
      await buffer.insertBytes(11, Buffer.from('!!!'));
      
      // Simulate backspacing
      await buffer.deleteBytes(13, 14); // Delete one !
      await buffer.deleteBytes(12, 13); // Delete another !
      await buffer.deleteBytes(11, 12); // Delete last !
      
      const stats = buffer.getMemoryStats().undo;
      expect(stats.undoGroups).toBe(2); // Insert operation + merged delete operations
      
      await buffer.undo(); // Undo the backspaces
      
      const result = await buffer.getBytes(0, 14);
      expect(result.toString()).toBe('Hello World!!!');
    });

    test('should not merge operations separated by time', async () => {
      await buffer.insertBytes(11, Buffer.from('!'));
      
      // Wait longer than merge window
      await testUtils.wait(100); // Simulate time gap
      
      // Create another operation with large time gap
      const buffer2 = new PagedBuffer(1024, new MemoryPageStorage(), 10);
      buffer2.loadContent('Hello World');
      buffer2.enableUndo({
        maxUndoLevels: 100,
        mergeTimeWindow: 50 // Very short window
      });
      
      await buffer2.insertBytes(11, Buffer.from('!'));
      await testUtils.wait(100); // Wait longer than merge window
      await buffer2.insertBytes(12, Buffer.from('?'));
      
      const stats = buffer2.getMemoryStats().undo;
      expect(stats.undoGroups).toBe(2); // Should be separate groups
    });

    test('should not merge operations separated by distance', async () => {
      await buffer.insertBytes(0, Buffer.from('Start '));
      await buffer.insertBytes(17, Buffer.from(' End')); // Far from first insertion
      
      const stats = buffer.getMemoryStats().undo;
      expect(stats.undoGroups).toBe(2); // Should be separate due to distance
    });

    test('should merge insert followed by backspace', async () => {
      await buffer.insertBytes(11, Buffer.from('!!!'));
      await buffer.deleteBytes(11, 14); // Delete what we just inserted
      
      const stats = buffer.getMemoryStats().undo;
      expect(stats.undoGroups).toBe(0); // Operations should cancel out
      
      expect(buffer.canUndo()).toBe(false);
    });
  });

  describe('Named Transactions', () => {
    test('should create named transaction', async () => {
      buffer.beginUndoTransaction('Find and Replace');
      
      expect(buffer.inUndoTransaction()).toBe(true);
      
      const tx = buffer.getCurrentUndoTransaction();
      expect(tx.name).toBe('Find and Replace');
      expect(tx.operations).toBe(0);
    });

    test('should commit transaction with multiple operations', async () => {
      buffer.beginUndoTransaction('Complex Edit');
      
      await buffer.deleteBytes(6, 11); // Delete "World"
      await buffer.insertBytes(6, Buffer.from('Universe'));
      await buffer.insertBytes(14, Buffer.from('!'));
      
      const success = buffer.commitUndoTransaction();
      expect(success).toBe(true);
      expect(buffer.inUndoTransaction()).toBe(false);
      
      const stats = buffer.getMemoryStats().undo;
      expect(stats.undoGroups).toBe(1);
      
      // Undo should revert all operations at once
      await buffer.undo();
      
      const result = await buffer.getBytes(0, 11);
      expect(result.toString()).toBe('Hello World');
    });

    test('should rollback transaction', async () => {
      const originalContent = await buffer.getBytes(0, 11);
      
      buffer.beginUndoTransaction('Experimental Changes');
      
      await buffer.insertBytes(6, Buffer.from('Modified '));
      await buffer.deleteBytes(15, 20);
      
      const success = await buffer.rollbackUndoTransaction();
      expect(success).toBe(true);
      expect(buffer.inUndoTransaction()).toBe(false);
      
      // Content should be restored
      const afterRollback = await buffer.getBytes(0, 11);
      testUtils.compareBuffers(afterRollback, originalContent, 'Rollback comparison');
      
      // No undo history should be created
      expect(buffer.canUndo()).toBe(false);
    });

    test('should handle nested transactions', async () => {
      buffer.beginUndoTransaction('Outer Transaction');
      
      await buffer.insertBytes(0, Buffer.from('Start '));
      
      buffer.beginUndoTransaction('Inner Transaction');
      await buffer.insertBytes(17, Buffer.from(' Middle'));
      buffer.commitUndoTransaction();
      
      await buffer.insertBytes(24, Buffer.from(' End'));
      buffer.commitUndoTransaction();
      
      const stats = buffer.getMemoryStats().undo;
      expect(stats.undoGroups).toBe(1); // Should be one combined transaction
      
      await buffer.undo();
      
      const result = await buffer.getBytes(0, 11);
      expect(result.toString()).toBe('Hello World');
    });

    test('should allow overriding transaction name on commit', async () => {
      const mockHandler = testUtils.createMockNotificationHandler();
      buffer.onNotification(mockHandler.handler);
      
      buffer.beginUndoTransaction('Original Name');
      await buffer.insertBytes(11, Buffer.from('!'));
      buffer.commitUndoTransaction('Final Name');
      
      const notifications = mockHandler.getByType('undo_transaction_committed');
      expect(notifications.length).toBe(1);
      expect(notifications[0].metadata.name).toBe('Final Name');
    });
  });

  describe('Automatic Operation Naming', () => {
    test('should generate appropriate names for insert operations', async () => {
      const mockHandler = testUtils.createMockNotificationHandler();
      buffer.onNotification(mockHandler.handler);
      
      await buffer.insertBytes(11, Buffer.from('!'));
      
      // Let auto-group timeout trigger
      await testUtils.wait(2100);
      
      const notifications = mockHandler.getByType('undo_operation_recorded');
      expect(notifications.length).toBe(1);
      expect(notifications[0].metadata.name).toBe('Insert content');
    });

    test('should generate appropriate names for delete operations', async () => {
      const mockHandler = testUtils.createMockNotificationHandler();
      buffer.onNotification(mockHandler.handler);
      
      await buffer.deleteBytes(6, 11);
      
      // Let auto-group timeout trigger
      await testUtils.wait(2100);
      
      const notifications = mockHandler.getByType('undo_operation_recorded');
      expect(notifications.length).toBe(1);
      expect(notifications[0].metadata.name).toBe('Delete content');
    });

    test('should generate appropriate names for mixed operations', async () => {
      const mockHandler = testUtils.createMockNotificationHandler();
      buffer.onNotification(mockHandler.handler);
      
      await buffer.insertBytes(11, Buffer.from('!'));
      await buffer.deleteBytes(6, 7);
      
      // Let auto-group timeout trigger
      await testUtils.wait(2100);
      
      const notifications = mockHandler.getByType('undo_operation_recorded');
      expect(notifications.length).toBe(1);
      expect(notifications[0].metadata.name).toBe('Edit content');
    });
  });

  describe('Transaction Options', () => {
    test('should respect allowMerging option', async () => {
      buffer.beginUndoTransaction('Batch Operation', { allowMerging: true });
      
      await buffer.insertBytes(11, Buffer.from('!'));
      await buffer.insertBytes(12, Buffer.from('!'));
      await buffer.insertBytes(13, Buffer.from('!'));
      
      const tx = buffer.getCurrentUndoTransaction();
      expect(tx.operations).toBe(1); // Should be merged due to allowMerging: true
      
      buffer.commitUndoTransaction();
    });

    test('should respect allowMerging: false option', async () => {
      buffer.beginUndoTransaction('Separate Operations', { allowMerging: false });
      
      await buffer.insertBytes(11, Buffer.from('!'));
      await buffer.insertBytes(12, Buffer.from('!'));
      await buffer.insertBytes(13, Buffer.from('!'));
      
      const tx = buffer.getCurrentUndoTransaction();
      expect(tx.operations).toBe(3); // Should be separate due to allowMerging: false
      
      buffer.commitUndoTransaction();
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

    test('should handle nested transaction rollback', async () => {
      buffer.beginUndoTransaction('Outer');
      await buffer.insertBytes(0, Buffer.from('Outer '));
      
      buffer.beginUndoTransaction('Inner');
      await buffer.insertBytes(6, Buffer.from('Inner '));
      
      const result = await buffer.rollbackUndoTransaction();
      expect(result).toBe(true);
      
      // Should still be in outer transaction
      expect(buffer.inUndoTransaction()).toBe(true);
      
      const tx = buffer.getCurrentUndoTransaction();
      expect(tx.name).toBe('Outer');
    });

    test('should clear redo stack when new operations are performed', async () => {
      await buffer.insertBytes(11, Buffer.from('!'));
      await buffer.undo();
      
      expect(buffer.canRedo()).toBe(true);
      
      await buffer.insertBytes(11, Buffer.from('?'));
      
      expect(buffer.canRedo()).toBe(false);
    });
  });

  describe('Undo System Configuration', () => {
    test('should respect maxUndoLevels configuration', async () => {
      const smallBuffer = new PagedBuffer(1024, new MemoryPageStorage(), 10);
      smallBuffer.loadContent('Test');
      smallBuffer.enableUndo({ maxUndoLevels: 2 });
      
      // Perform more operations than the limit
      await smallBuffer.insertBytes(4, Buffer.from('1'));
      await testUtils.wait(100);
      await smallBuffer.insertBytes(5, Buffer.from('2'));
      await testUtils.wait(100);
      await smallBuffer.insertBytes(6, Buffer.from('3'));
      
      const stats = smallBuffer.getMemoryStats().undo;
      expect(stats.undoGroups).toBeLessThanOrEqual(2);
    });

    test('should respect mergeTimeWindow configuration', async () => {
      const fastBuffer = new PagedBuffer(1024, new MemoryPageStorage(), 10);
      fastBuffer.loadContent('Test');
      fastBuffer.enableUndo({ 
        maxUndoLevels: 10,
        mergeTimeWindow: 50 // Very short window
      });
      
      await fastBuffer.insertBytes(4, Buffer.from('!'));
      await testUtils.wait(100); // Wait longer than merge window
      await fastBuffer.insertBytes(5, Buffer.from('?'));
      
      const stats = fastBuffer.getMemoryStats().undo;
      expect(stats.undoGroups).toBe(2); // Should be separate due to time
    });
  });

  describe('Memory Management', () => {
    test('should provide accurate undo memory statistics', async () => {
      await buffer.insertBytes(11, Buffer.from('! This is a longer text'));
      await buffer.deleteBytes(0, 5);
      await buffer.insertBytes(0, Buffer.from('Hi'));
      
      const stats = buffer.getMemoryStats().undo;
      
      expect(stats.undoGroups).toBeGreaterThan(0);
      expect(stats.totalUndoOperations).toBeGreaterThan(0);
      expect(stats.memoryUsage).toBeGreaterThan(0);
      expect(stats.currentGroupOperations).toBeGreaterThanOrEqual(0);
    });

    test('should handle large operations efficiently', async () => {
      const largeData = Buffer.alloc(10000, 'X');
      
      await buffer.insertBytes(11, largeData);
      
      const stats = buffer.getMemoryStats().undo;
      expect(stats.memoryUsage).toBeGreaterThan(10000);
      
      await buffer.undo();
      
      const result = await buffer.getBytes(0, 11);
      expect(result.toString()).toBe('Hello World');
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
      
      await buffer.insertBytes(11, Buffer.from('!'));
      await buffer2.insertBytes(13, Buffer.from('!'));
      
      expect(buffer.canUndo()).toBe(true);
      expect(buffer2.canUndo()).toBe(true);
      
      await buffer.undo();
      await buffer2.undo();
      
      const result1 = await buffer.getBytes(0, 11);
      const result2 = await buffer2.getBytes(0, 13);
      
      expect(result1.toString()).toBe('Hello World');
      expect(result2.toString()).toBe('Second Buffer');
    });
  });
});
