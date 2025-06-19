/**
 * Operation Merging Logic Tests
 * Tests for BufferOperation.canMergeWith() and mergeWith() methods
 * Targets the uncovered branches in buffer-operation.ts
 */

import { BufferOperation, OperationType, resetOperationCounter } from '../src/buffer-operation';
import { testUtils } from './setup';

describe('Operation Merging Logic', () => {
  let mockTime: number;
  
  beforeEach(() => {
    resetOperationCounter();
    mockTime = 1000;
  });

  const createOperation = (
    type: OperationType, 
    position: number, 
    data: string | null, 
    originalData: string | null = null, 
    timeOffset: number = 0
  ): BufferOperation => {
    const timestamp = mockTime + timeOffset;
    const dataBuffer = data ? Buffer.from(data) : null;
    const originalBuffer = originalData ? Buffer.from(originalData) : null;
    
    const op = new BufferOperation(type, position, dataBuffer, originalBuffer, timestamp);
    op.setPostExecutionPosition(position);
    return op;
  };

  describe('canMergeWith - Time Window Tests', () => {
    test('should merge operations within time window', () => {
      const op1 = createOperation(OperationType.INSERT, 10, 'hello', null, 0);
      const op2 = createOperation(OperationType.INSERT, 15, 'world', null, 5000); // 5 seconds later
      
      const canMerge = op1.canMergeWith(op2, 15000, 1000); // 15s time window, 1000 byte position window
      expect(canMerge).toBe(true);
    });

    test('should not merge operations outside time window', () => {
      const op1 = createOperation(OperationType.INSERT, 10, 'hello', null, 0);
      const op2 = createOperation(OperationType.INSERT, 15, 'world', null, 20000); // 20 seconds later
      
      const canMerge = op1.canMergeWith(op2, 15000, 1000); // 15s time window
      expect(canMerge).toBe(false);
    });

    test('should handle reverse time comparison', () => {
      const op1 = createOperation(OperationType.INSERT, 10, 'hello', null, 10000);
      const op2 = createOperation(OperationType.INSERT, 15, 'world', null, 5000); // Earlier timestamp
      
      const canMerge = op1.canMergeWith(op2, 15000, 1000);
      expect(canMerge).toBe(true); // Time diff is 5000ms, within 15000ms window
    });
  });

  describe('canMergeWith - Position Window Tests', () => {
    test('should merge operations within position window', () => {
      const op1 = createOperation(OperationType.INSERT, 10, 'hello');
      const op2 = createOperation(OperationType.INSERT, 15, 'world');
      
      const canMerge = op1.canMergeWith(op2, 15000, 10); // 10 byte position window
      expect(canMerge).toBe(true);
    });

    test('should not merge operations outside position window', () => {
      const op1 = createOperation(OperationType.INSERT, 10, 'hello');
      const op2 = createOperation(OperationType.INSERT, 1000, 'world');
      
      const canMerge = op1.canMergeWith(op2, 15000, 100); // 100 byte position window
      expect(canMerge).toBe(false);
    });

    test('should skip position check when position window is -1 (default)', () => {
      const op1 = createOperation(OperationType.INSERT, 10, 'hello');
      const op2 = createOperation(OperationType.INSERT, 10000, 'world'); // Very far away
      
      // With position window = -1, should only check time
      const canMerge = op1.canMergeWith(op2, 15000, -1);
      expect(canMerge).toBe(true); // Should merge based on time only
    });
  });

  describe('canMergeWith - Logical Distance Calculation', () => {
    test('should use logical distance when post-execution position is available', () => {
      const op1 = createOperation(OperationType.INSERT, 10, 'hello');
      op1.setPostExecutionPosition(10);
      
      const op2 = createOperation(OperationType.INSERT, 15, 'world');
      
      const canMerge = op1.canMergeWith(op2, 15000, 10);
      expect(canMerge).toBe(true);
    });

    test('should fallback to position difference when logical distance fails', () => {
      const op1 = createOperation(OperationType.INSERT, 10, 'hello');
      // Don't set post-execution position to trigger fallback
      
      const op2 = createOperation(OperationType.INSERT, 15, 'world');
      
      const canMerge = op1.canMergeWith(op2, 15000, 10);
      expect(canMerge).toBe(true);
    });

    test('should handle distance calculation errors gracefully', () => {
      const op1 = createOperation(OperationType.INSERT, 10, 'hello');
      const op2 = createOperation(OperationType.INSERT, 15, 'world');
      
      // Mock getLogicalDistance to throw an error to test fallback
      (op1 as any).getLogicalDistance = () => {
        throw new Error('Distance calculation failed');
      };
      
      const canMerge = op1.canMergeWith(op2, 15000, 10);
      expect(canMerge).toBe(true); // Should use fallback calculation
    });
  });

  describe('canMergeWith - Operation Type Compatibility', () => {
    test('should merge same operation types', () => {
      const op1 = createOperation(OperationType.INSERT, 10, 'hello');
      const op2 = createOperation(OperationType.INSERT, 15, 'world');
      
      expect(op1.canMergeWith(op2, 15000, 1000)).toBe(true);
    });

    test('should merge compatible cross-type operations - DELETE + INSERT', () => {
      const op1 = createOperation(OperationType.DELETE, 10, null, 'deleted');
      const op2 = createOperation(OperationType.INSERT, 10, 'inserted');
      
      expect(op1.canMergeWith(op2, 15000, 1000)).toBe(true);
    });

    test('should merge compatible cross-type operations - INSERT + DELETE', () => {
      const op1 = createOperation(OperationType.INSERT, 10, 'inserted');
      const op2 = createOperation(OperationType.DELETE, 15, null, 'deleted');
      
      expect(op1.canMergeWith(op2, 15000, 1000)).toBe(true);
    });

    test('should merge compatible cross-type operations - INSERT + OVERWRITE', () => {
      const op1 = createOperation(OperationType.INSERT, 10, 'inserted');
      const op2 = createOperation(OperationType.OVERWRITE, 15, 'new', 'old');
      
      expect(op1.canMergeWith(op2, 15000, 1000)).toBe(true);
    });

    test('should merge compatible cross-type operations - DELETE + OVERWRITE', () => {
      const op1 = createOperation(OperationType.DELETE, 10, null, 'deleted');
      const op2 = createOperation(OperationType.OVERWRITE, 15, 'new', 'old');
      
      expect(op1.canMergeWith(op2, 15000, 1000)).toBe(true);
    });

    test('should merge compatible cross-type operations - OVERWRITE + INSERT', () => {
      const op1 = createOperation(OperationType.OVERWRITE, 10, 'new', 'old');
      const op2 = createOperation(OperationType.INSERT, 15, 'inserted');
      
      expect(op1.canMergeWith(op2, 15000, 1000)).toBe(true);
    });

    test('should merge compatible cross-type operations - OVERWRITE + DELETE', () => {
      const op1 = createOperation(OperationType.OVERWRITE, 10, 'new', 'old');
      const op2 = createOperation(OperationType.DELETE, 15, null, 'deleted');
      
      expect(op1.canMergeWith(op2, 15000, 1000)).toBe(true);
    });
  });

  describe('mergeWith - Insert Operations', () => {
    test('should merge two insert operations in correct order', () => {
      const op1 = createOperation(OperationType.INSERT, 10, 'hello', null, 0);
      const op2 = createOperation(OperationType.INSERT, 15, 'world', null, 100);
      
      op1.mergeWith(op2);
      
      expect(op1.type).toBe(OperationType.INSERT);
      expect(op1.preExecutionPosition).toBe(10);
      expect(op1.data?.toString()).toBe('helloworld');
      expect(op1.timestamp).toBe(mockTime); // Should keep earliest timestamp
    });

    test('should merge insert operations with overlapping positions', () => {
      const op1 = createOperation(OperationType.INSERT, 15, 'world', null, 100);
      const op2 = createOperation(OperationType.INSERT, 10, 'hello', null, 0);
      
      op1.mergeWith(op2);
      
      expect(op1.type).toBe(OperationType.INSERT);
      expect(op1.preExecutionPosition).toBe(10);
      expect(op1.data?.toString()).toBe('helloworld');
      expect(op1.timestamp).toBe(mockTime); // Should keep earliest timestamp
    });

    test('should handle insert operations with position adjustments', () => {
      const op1 = createOperation(OperationType.INSERT, 10, 'abc', null, 0);
      const op2 = createOperation(OperationType.INSERT, 12, 'def', null, 100);
      
      // Simulate that op1 executed first and pushed op2's position
      op1.mergeWith(op2);
      
      expect(op1.data?.toString()).toBe('abcdef');
    });

    test('should handle null or empty data in insert operations', () => {
      const op1 = createOperation(OperationType.INSERT, 10, 'hello', null, 0);
      const op2 = createOperation(OperationType.INSERT, 15, null, null, 100);
      
      op1.mergeWith(op2);
      
      expect(op1.data?.toString()).toBe('hello');
    });
  });

  describe('mergeWith - Delete Operations', () => {
    test('should merge two delete operations in correct order', () => {
      const op1 = createOperation(OperationType.DELETE, 10, null, 'hello', 0);
      const op2 = createOperation(OperationType.DELETE, 15, null, 'world', 100);
      
      op1.mergeWith(op2);
      
      expect(op1.type).toBe(OperationType.DELETE);
      expect(op1.preExecutionPosition).toBe(10); // Should use minimum position
      expect(op1.originalData?.toString()).toBe('helloworld');
      expect(op1.timestamp).toBe(mockTime); // Should keep earliest timestamp
    });

    test('should merge delete operations with backspace scenario', () => {
      const op1 = createOperation(OperationType.DELETE, 15, null, 'world', 100);
      const op2 = createOperation(OperationType.DELETE, 10, null, 'hello', 0);
      
      op1.mergeWith(op2);
      
      expect(op1.type).toBe(OperationType.DELETE);
      expect(op1.preExecutionPosition).toBe(10); // Should use minimum position
      expect(op1.originalData?.toString()).toBe('helloworld');
    });

    test('should handle null or empty original data in delete operations', () => {
      const op1 = createOperation(OperationType.DELETE, 10, null, 'hello', 0);
      const op2 = createOperation(OperationType.DELETE, 15, null, null, 100);
      
      op1.mergeWith(op2);
      
      expect(op1.originalData?.toString()).toBe('hello');
    });
  });

  describe('mergeWith - Mixed Operations (Overwrite)', () => {
    test('should merge DELETE + INSERT as overwrite', () => {
      const op1 = createOperation(OperationType.DELETE, 10, null, 'deleted', 0);
      const op2 = createOperation(OperationType.INSERT, 10, 'inserted', null, 100);
      
      op1.mergeWith(op2);
      
      expect(op1.type).toBe(OperationType.OVERWRITE);
      expect(op1.preExecutionPosition).toBe(10);
      expect(op1.data?.toString()).toBe('inserted');
      expect(op1.originalData?.toString()).toBe('deleted');
      expect(op1.timestamp).toBe(mockTime); // Should keep earliest timestamp
    });

    test('should merge INSERT + DELETE as overwrite (net deletion)', () => {
      const op1 = createOperation(OperationType.INSERT, 10, 'inserted', null, 0);
      const op2 = createOperation(OperationType.DELETE, 10, null, 'deleted', 100);
      
      op1.mergeWith(op2);
      
      expect(op1.type).toBe(OperationType.OVERWRITE);
      expect(op1.preExecutionPosition).toBe(10);
      expect(op1.data?.length).toBe(0); // Net result is deletion
      expect(op1.originalData?.toString()).toBe('inserted');
    });

    test('should handle mixed operations with different positions', () => {
      const op1 = createOperation(OperationType.DELETE, 15, null, 'world', 100);
      const op2 = createOperation(OperationType.INSERT, 10, 'hello', null, 0);
      
      op1.mergeWith(op2);
      
      expect(op1.type).toBe(OperationType.OVERWRITE);
      expect(op1.preExecutionPosition).toBe(10); // Should use minimum position
    });

    test('should handle null data in mixed operations', () => {
      const op1 = createOperation(OperationType.DELETE, 10, null, null, 0);
      const op2 = createOperation(OperationType.INSERT, 10, null, null, 100);
      
      op1.mergeWith(op2);
      
      expect(op1.type).toBe(OperationType.OVERWRITE);
      expect(op1.data?.length).toBe(0);
      expect(op1.originalData?.length).toBe(0);
    });
  });

  describe('mergeWith - Post-Execution Position Updates', () => {
    test('should update post-execution position for insert merge', () => {
      const op1 = createOperation(OperationType.INSERT, 10, 'hello');
      const op2 = createOperation(OperationType.INSERT, 15, 'world');
      
      op1.mergeWith(op2);
      
      expect(op1.postExecutionPosition).toBe(10); // Insert type uses position
    });

    test('should update post-execution position for delete merge', () => {
      const op1 = createOperation(OperationType.DELETE, 10, null, 'hello');
      const op2 = createOperation(OperationType.DELETE, 15, null, 'world');
      
      op1.mergeWith(op2);
      
      expect(op1.postExecutionPosition).toBe(10); // Delete type uses position
    });

    test('should update post-execution position for overwrite merge', () => {
      const op1 = createOperation(OperationType.DELETE, 10, null, 'deleted');
      const op2 = createOperation(OperationType.INSERT, 10, 'inserted');
      
      op1.mergeWith(op2);
      
      expect(op1.postExecutionPosition).toBe(10); // Overwrite type uses position
    });
  });

  describe('mergeWith - Chronological Order Handling', () => {
    test('should determine chronological order by operation number', () => {
      const op1 = createOperation(OperationType.INSERT, 10, 'first', null, 0);
      const op2 = createOperation(OperationType.INSERT, 15, 'second', null, 100);
      
      // op2 has higher operation number (created later), so it should be "second"
      expect(op1.operationNumber).toBeLessThan(op2.operationNumber);
      
      op2.mergeWith(op1); // Merge in reverse order
      
      // Should still process op1 first (lower operation number)
      expect(op2.data?.toString()).toBe('firstsecond');
    });

    test('should handle equal operation numbers gracefully', () => {
      const op1 = createOperation(OperationType.INSERT, 10, 'hello');
      const op2 = createOperation(OperationType.INSERT, 15, 'world');
      
      // Force same operation number
      (op2 as any).operationNumber = op1.operationNumber;
      
      op1.mergeWith(op2);
      
      // Should still merge successfully
      expect(op1.data?.toString()).toBe('helloworld');
    });
  });

  describe('getSizeImpact method', () => {
    test('should calculate size impact for insert operations', () => {
      const op = createOperation(OperationType.INSERT, 10, 'hello');
      expect(op.getSizeImpact()).toBe(5);
    });

    test('should calculate size impact for delete operations', () => {
      const op = createOperation(OperationType.DELETE, 10, null, 'hello');
      expect(op.getSizeImpact()).toBe(-5);
    });

    test('should calculate size impact for overwrite operations', () => {
      const op = createOperation(OperationType.OVERWRITE, 10, 'hello', 'hi');
      expect(op.getSizeImpact()).toBe(3); // 5 - 2 = 3
    });

    test('should handle null data in size impact calculation', () => {
      const op1 = createOperation(OperationType.INSERT, 10, null);
      expect(op1.getSizeImpact()).toBe(0);
      
      const op2 = createOperation(OperationType.DELETE, 10, null, null);
      expect(op2.getSizeImpact()).toBe(0);
      
      const op3 = createOperation(OperationType.OVERWRITE, 10, null, null);
      expect(op3.getSizeImpact()).toBe(0);
    });

    test('should handle unknown operation types', () => {
      const op = createOperation('unknown_type' as OperationType, 10, 'hello');
      expect(op.getSizeImpact()).toBe(0);
    });
  });

  describe('getEndPosition method', () => {
    test('should calculate end position for insert operations', () => {
      const op = createOperation(OperationType.INSERT, 10, 'hello');
      expect(op.getEndPosition()).toBe(15);
    });

    test('should calculate end position for delete operations', () => {
      const op = createOperation(OperationType.DELETE, 10, null, 'hello');
      expect(op.getEndPosition()).toBe(10);
    });

    test('should calculate end position for overwrite operations', () => {
      const op = createOperation(OperationType.OVERWRITE, 10, 'hello', 'hi');
      expect(op.getEndPosition()).toBe(15);
    });

    test('should handle null data in end position calculation', () => {
      const op = createOperation(OperationType.INSERT, 10, null);
      expect(op.getEndPosition()).toBe(10);
    });

    test('should handle unknown operation types', () => {
      const op = createOperation('unknown_type' as OperationType, 10, 'hello');
      expect(op.getEndPosition()).toBe(10);
    });
  });

  describe('getInsertedLength method', () => {
    test('should calculate inserted length for insert operations', () => {
      const op = createOperation(OperationType.INSERT, 10, 'hello');
      expect((op as any).getInsertedLength()).toBe(5);
    });

    test('should calculate inserted length for delete operations', () => {
      const op = createOperation(OperationType.DELETE, 10, null, 'hello');
      expect((op as any).getInsertedLength()).toBe(0);
    });

    test('should calculate inserted length for overwrite operations', () => {
      const op = createOperation(OperationType.OVERWRITE, 10, 'hello', 'hi');
      expect((op as any).getInsertedLength()).toBe(5);
    });

    test('should handle null data in inserted length calculation', () => {
      const op = createOperation(OperationType.INSERT, 10, null);
      expect((op as any).getInsertedLength()).toBe(0);
    });

    test('should handle unknown operation types', () => {
      const op = createOperation('unknown_type' as OperationType, 10, 'hello');
      expect((op as any).getInsertedLength()).toBe(0);
    });
  });

  describe('Edge Cases and Error Conditions', () => {
    test('should handle merging with very large position differences', () => {
      const op1 = createOperation(OperationType.INSERT, 0, 'start');
      const op2 = createOperation(OperationType.INSERT, Number.MAX_SAFE_INTEGER, 'end');
      
      expect(() => {
        op1.mergeWith(op2);
      }).not.toThrow();
    });

    test('should handle merging with very large time differences', () => {
      const op1 = createOperation(OperationType.INSERT, 10, 'hello', null, 0);
      const op2 = createOperation(OperationType.INSERT, 15, 'world', null, Number.MAX_SAFE_INTEGER);
      
      expect(() => {
        op1.mergeWith(op2);
      }).not.toThrow();
      
      expect(op1.timestamp).toBe(mockTime); // Should keep earlier timestamp
    });

    test('should handle merging operations with very large data', () => {
      const largeData1 = 'a'.repeat(10000);
      const largeData2 = 'b'.repeat(10000);
      
      const op1 = createOperation(OperationType.INSERT, 10, largeData1);
      const op2 = createOperation(OperationType.INSERT, 20010, largeData2);
      
      op1.mergeWith(op2);
      
      expect(op1.data?.length).toBe(20000);
      expect(op1.data?.toString()).toBe(largeData1 + largeData2);
    });

    test('should handle merging operations with empty buffers', () => {
      const op1 = createOperation(OperationType.INSERT, 10, '');
      const op2 = createOperation(OperationType.INSERT, 10, '');
      
      op1.mergeWith(op2);
      
      expect(op1.data?.length).toBe(0);
    });

    test('should preserve operation metadata during merge', () => {
      const op1 = createOperation(OperationType.INSERT, 10, 'hello', null, 0);
      const op2 = createOperation(OperationType.INSERT, 15, 'world', null, 100);
      
      const originalId = op1.id;
      const originalOpNumber = op1.operationNumber;
      
      op1.mergeWith(op2);
      
      expect(op1.id).toBe(originalId);
      expect(op1.operationNumber).toBe(originalOpNumber);
    });
  });
});
