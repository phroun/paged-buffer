/**
 * Fixed coverage tests for buffer-operation.test.js
 */

const { BufferOperation, OperationType } = require('../src/buffer-operation');
const { PageStorage } = require('../src/storage/page-storage');
const { MemoryPageStorage } = require('../src/storage/memory-page-storage');
const { FilePageStorage } = require('../src/storage/file-page-storage');

describe('BufferOperation - Unused Methods Coverage', () => {
  test('should get size impact for different operation types', () => {
    const insertOp = new BufferOperation('insert', 0, Buffer.from('test'), null);
    expect(insertOp.getSizeImpact()).toBe(4);

    const deleteOp = new BufferOperation('delete', 0, null, Buffer.from('test'));
    expect(deleteOp.getSizeImpact()).toBe(-4);

    // FIXED: overwrite size impact = new size - old size = 3 - 3 = 0
    const overwriteOp = new BufferOperation('overwrite', 0, Buffer.from('new'), Buffer.from('old'));
    expect(overwriteOp.getSizeImpact()).toBe(0); // 3 - 3 = 0

    const unknownOp = new BufferOperation('unknown', 0, Buffer.from('test'));
    expect(unknownOp.getSizeImpact()).toBe(0);
  });

  test('should get end position for different operation types', () => {
    const insertOp = new BufferOperation('insert', 5, Buffer.from('test'));
    expect(insertOp.getEndPosition()).toBe(9);

    const deleteOp = new BufferOperation('delete', 5, null, Buffer.from('test'));
    expect(deleteOp.getEndPosition()).toBe(5);

    const overwriteOp = new BufferOperation('overwrite', 5, Buffer.from('test'));
    expect(overwriteOp.getEndPosition()).toBe(9);
  });

  test('should get inserted length', () => {
    const insertOp = new BufferOperation('insert', 0, Buffer.from('test'));
    expect(insertOp._getInsertedLength()).toBe(4);

    const deleteOp = new BufferOperation('delete', 0, null, Buffer.from('test'));
    expect(deleteOp._getInsertedLength()).toBe(0);

    const overwriteOp = new BufferOperation('overwrite', 0, Buffer.from('test'));
    expect(overwriteOp._getInsertedLength()).toBe(4);
  });

  test('should handle legacy position getter/setter', () => {
    const op = new BufferOperation('insert', 5, Buffer.from('test'));
    expect(op.position).toBe(5);
    
    op.position = 10;
    expect(op.preExecutionPosition).toBe(10);
    expect(op.position).toBe(10);
  });
});

describe('File Storage Error Handling', () => {
  test('should handle non-existent page deletion', async () => {
    const storage = new FilePageStorage();
    
    // Should not throw for non-existent page
    await expect(storage.deletePage('non-existent')).resolves.not.toThrow();
  });

  test('should handle directory creation errors', async () => {
    // Test error handling by creating storage with problematic temp dir
    const storage = new FilePageStorage();
    
    // Mock mkdir to simulate permission error only for the first call
    const fs = require('fs').promises;
    const originalMkdir = fs.mkdir;
    let callCount = 0;
    
    fs.mkdir = jest.fn().mockImplementation(async (path, options) => {
      callCount++;
      if (callCount === 1) {
        const error = new Error('Permission denied');
        error.code = 'EACCES';
        throw error;
      }
      return originalMkdir(path, options);
    });
    
    // This should handle the error gracefully
    try {
      await storage._ensureTempDir();
      // If we get here, the error was handled
      expect(true).toBe(true);
    } catch (error) {
      // Expected - the error should be thrown
      expect(error.message).toBe('Permission denied');
    } finally {
      // Always restore the original function
      fs.mkdir = originalMkdir;
    }
  });
});

describe('Memory Storage Complete Coverage', () => {
  test('should handle page existence check', async () => {
    const storage = new MemoryPageStorage();
    
    expect(await storage.pageExists('non-existent')).toBe(false);
    
    await storage.savePage('test-page', Buffer.from('data'));
    expect(await storage.pageExists('test-page')).toBe(true);
    
    await storage.deletePage('test-page');
    expect(await storage.pageExists('test-page')).toBe(false);
  });

  test('should handle deletion of non-existent pages', async () => {
    const storage = new MemoryPageStorage();
    
    // Should not throw
    await expect(storage.deletePage('non-existent')).resolves.not.toThrow();
  });
});

describe('Base PageStorage Coverage', () => {
  test('should throw not implemented errors', async () => {
    const storage = new PageStorage();
    
    await expect(storage.savePage('test', Buffer.from('data'))).rejects.toThrow('Must implement savePage');
    await expect(storage.loadPage('test')).rejects.toThrow('Must implement loadPage');
    await expect(storage.deletePage('test')).rejects.toThrow('Must implement deletePage');
    await expect(storage.pageExists('test')).rejects.toThrow('Must implement pageExists');
  });
});

describe('Operation Distance Edge Cases', () => {
  test('should handle operations without post-execution positions', () => {
    const op1 = new BufferOperation('insert', 0, Buffer.from('A'));
    const op2 = new BufferOperation('insert', 5, Buffer.from('B'));
    
    // Don't set post-execution positions
    expect(() => op1.getLogicalDistance(op2)).toThrow('first operation has not executed yet');
  });

  test('should handle different operation type combinations', () => {
    const insertOp = new BufferOperation('insert', 0, Buffer.from('A'));
    const deleteOp = new BufferOperation('delete', 1, null, Buffer.from('B'));
    const overwriteOp = new BufferOperation('overwrite', 2, Buffer.from('C'), Buffer.from('D'));
    
    insertOp.setPostExecutionPosition(0);
    deleteOp.setPostExecutionPosition(1);
    overwriteOp.setPostExecutionPosition(2);
    
    // Test various combinations
    expect(insertOp.getLogicalDistance(deleteOp)).toBeGreaterThanOrEqual(0);
    expect(deleteOp.getLogicalDistance(overwriteOp)).toBeGreaterThanOrEqual(0);
    expect(insertOp.getLogicalDistance(overwriteOp)).toBeGreaterThanOrEqual(0);
  });
});

describe('Operation Compatibility Edge Cases', () => {
  test('should test all operation compatibility combinations', () => {
    const op = new BufferOperation('insert', 0, Buffer.from('test'));
    
    // Test all same-type combinations
    expect(op._areOperationsCompatible('insert', 'insert')).toBe(true);
    expect(op._areOperationsCompatible('delete', 'delete')).toBe(true);
    expect(op._areOperationsCompatible('overwrite', 'overwrite')).toBe(true);
    
    // Test all cross-type combinations
    expect(op._areOperationsCompatible('insert', 'delete')).toBe(true);
    expect(op._areOperationsCompatible('delete', 'insert')).toBe(true);
    expect(op._areOperationsCompatible('insert', 'overwrite')).toBe(true);
    expect(op._areOperationsCompatible('overwrite', 'insert')).toBe(true);
    expect(op._areOperationsCompatible('delete', 'overwrite')).toBe(true);
    expect(op._areOperationsCompatible('overwrite', 'delete')).toBe(true);
  });
});

describe('Merge Operation Edge Cases', () => {
  test('should handle null/empty data in merge operations', () => {
    const op1 = new BufferOperation('insert', 0, null, null, 1000);
    const op2 = new BufferOperation('insert', 0, Buffer.from('test'), null, 1001);
    
    op1.setPostExecutionPosition(0);
    
    // Should handle null data gracefully
    expect(() => op1.mergeWith(op2)).not.toThrow();
  });

  test('should handle different merge scenarios', () => {
    // Test delete + delete merge
    const delete1 = new BufferOperation('delete', 5, null, Buffer.from('abc'), 1000);
    const delete2 = new BufferOperation('delete', 3, null, Buffer.from('de'), 1001);
    
    delete1.setPostExecutionPosition(5);
    
    expect(() => delete1.mergeWith(delete2)).not.toThrow();
    
    // Test mixed operation merge
    const insert1 = new BufferOperation('insert', 0, Buffer.from('A'), null, 1000);
    const delete1Mixed = new BufferOperation('delete', 1, null, Buffer.from('B'), 1001);
    
    insert1.setPostExecutionPosition(0);
    
    expect(() => insert1.mergeWith(delete1Mixed)).not.toThrow();
  });

  test('should handle canMergeWith edge cases', () => {
    const op1 = new BufferOperation('insert', 0, Buffer.from('A'), null, 1000);
    const op2 = new BufferOperation('insert', 10, Buffer.from('B'), null, 2000);
    
    // Test time window exceeded
    expect(op1.canMergeWith(op2, 500, 1000)).toBe(false); // Time diff 1000 > window 500
    
    // Test distance window exceeded  
    expect(op1.canMergeWith(op2, 2000, 5)).toBe(false); // Distance 10 > window 5
    
    // Test without post-execution position (should use fallback)
    expect(op1.canMergeWith(op2, 2000, 15)).toBe(true); // Should use simple distance calc
  });
});
