/**
 * @fileoverview Enhanced BufferOperation with position tracking and distance calculation - FIXED
 * @author Jeffrey R. Day
 * @version 1.0.0
 */

import { OperationDescriptor, OperationDistanceCalculator } from './utils/operation-distance';
import {
  type OperationType,
  type BufferOperation as IBufferOperationInterface,
  type DistanceCalculationOptions
} from './types/common';

/**
 * Operation types for undo/redo tracking
 */
const OperationType = {
  INSERT: 'insert' as const,
  DELETE: 'delete' as const,
  OVERWRITE: 'overwrite' as const
} as const;

/**
 * Global operation counter for determining chronological order
 * Moved here from undo-system.js since BufferOperation needs it
 */
let globalOperationCounter: number = 0;

/**
 * Reset the global operation counter (for testing)
 */
function resetOperationCounter(): void {
  globalOperationCounter = 0;
}

/**
 * Get current operation counter value (for testing)
 */
function getOperationCounter(): number {
  return globalOperationCounter;
}

interface MergedOperationResult {
  type: OperationType;
  position: number;
  data: Buffer;
  originalData: Buffer;
}

/**
 * Enhanced BufferOperation with position tracking and distance calculation - FIXED
 */
class BufferOperation implements IBufferOperationInterface {
  public type: OperationType;
  public preExecutionPosition: number;
  public data: Buffer | undefined;
  public originalData: Buffer | undefined;
  public timestamp: number;
  public operationNumber: number;
  public id: string;
  public postExecutionPosition: number | null = null;

  constructor(
    type: OperationType,
    position: number,
    data?: Buffer,
    originalData: Buffer | null = null,
    timestamp: number | null = null
  ) {
    this.type = type;
    this.preExecutionPosition = position;
    this.data = data;
    this.originalData = originalData || undefined;
    this.timestamp = timestamp || Date.now();
    this.operationNumber = ++globalOperationCounter;
    this.id = `op_${this.operationNumber}_${this.timestamp}`;
  }

  /**
   * Legacy position property for backwards compatibility
   */
  get position(): number {
    return this.preExecutionPosition;
  }

  /**
   * Set position for backwards compatibility
   */
  set position(value: number) {
    this.preExecutionPosition = value;
  }

  /**
   * Set the position after this operation has executed
   */
  setPostExecutionPosition(position: number): void {
    this.postExecutionPosition = position;
  }

  /**
   * Calculate logical distance to another operation using the distance module
   */
  getLogicalDistance(other: BufferOperation, options: DistanceCalculationOptions = {}): number {
    // Convert both operations to descriptors
    const thisDescriptor = OperationDescriptor.fromBufferOperation(this);
    const otherDescriptor = OperationDescriptor.fromBufferOperation(other);
    
    // Use the distance calculator
    return OperationDistanceCalculator.calculateDistance(
      thisDescriptor, 
      otherDescriptor, 
      options
    );
  }

  /**
   * Get the size impact of this operation
   */
  getSizeImpact(): number {
    switch (this.type) {
      case OperationType.INSERT:
        return this.data ? this.data.length : 0;
      case OperationType.DELETE:
        return this.originalData ? -this.originalData.length : 0;
      case OperationType.OVERWRITE:
        const oldSize = this.originalData ? this.originalData.length : 0;
        const newSize = this.data ? this.data.length : 0;
        return newSize - oldSize;
      default:
        return 0;
    }
  }

  /**
   * Get the end position of this operation (legacy method)
   */
  getEndPosition(): number {
    switch (this.type) {
      case OperationType.INSERT:
        return this.preExecutionPosition + (this.data ? this.data.length : 0);
      case OperationType.DELETE:
        return this.preExecutionPosition;
      case OperationType.OVERWRITE:
        return this.preExecutionPosition + (this.data ? this.data.length : 0);
      default:
        return this.preExecutionPosition;
    }
  }

  /**
   * Get the length of content that an operation inserts into the final buffer
   */
  getInsertedLength(): number {
    switch (this.type) {
      case OperationType.INSERT:
        return this.data ? this.data.length : 0;
      case OperationType.DELETE:
        return 0;
      case OperationType.OVERWRITE:
        return this.data ? this.data.length : 0;
      default:
        return 0;
    }
  }

  /**
   * Check if this operation can be merged with another - FIXED
   */
  canMergeWith(other: BufferOperation, timeWindow: number = 15000, positionWindow: number = -1): boolean {
    // Check time window first
    const timeDiff = Math.abs(this.timestamp - other.timestamp);
    const timeWithinWindow = timeDiff <= timeWindow;
    
    if (!timeWithinWindow) {
      return false;
    }
    
    // IMPROVED: If position window is 0 (default), skip position check
    // This means operations only merge based on time, not position
    if (positionWindow >= 0) {
      // Check distance (for logical grouping)
      let distance: number;
      if (this.postExecutionPosition !== null) {
        try {
          distance = this.getLogicalDistance(other);
        } catch (error) {
          distance = Math.abs(this.preExecutionPosition - other.preExecutionPosition);
        }
      } else {
        distance = Math.abs(this.preExecutionPosition - other.preExecutionPosition);
      }
      
      const distanceWithinWindow = distance <= positionWindow;
      
      if (!distanceWithinWindow) {
        return false;
      }
    }
    
    // Check type compatibility for grouping
    return this._areOperationsCompatible(this.type, other.type);
  }
  
  /**
   * Check if two operation types are compatible for merging
   */
  private _areOperationsCompatible(type1: OperationType, type2: OperationType): boolean {
    // Same type operations are generally compatible
    if (type1 === type2) {
      return true;
    }

    // Cross-type compatibility rules
    const compatibleCombinations: Array<[OperationType, OperationType]> = [
      [OperationType.DELETE, OperationType.INSERT],
      [OperationType.INSERT, OperationType.DELETE],
      [OperationType.INSERT, OperationType.OVERWRITE],
      [OperationType.DELETE, OperationType.OVERWRITE],
      [OperationType.OVERWRITE, OperationType.INSERT],
      [OperationType.OVERWRITE, OperationType.DELETE]
    ];

    return compatibleCombinations.some(([first, second]) =>
      (type1 === first && type2 === second) ||
      (type1 === second && type2 === first)
    );
  }

  /**
   * Merge another operation into this one - FIXED VERSION
   */
  mergeWith(other: BufferOperation): void {
    // Determine chronological order
    let firstOp: BufferOperation, secondOp: BufferOperation;
    
    if (this.operationNumber <= other.operationNumber) {
      firstOp = this;
      secondOp = other;
    } else {
      firstOp = other;
      secondOp = this;
    }
    
    let mergedOp: MergedOperationResult;
    
    if (firstOp.type === 'insert' && secondOp.type === 'insert') {
      mergedOp = this._mergeInsertOperations(firstOp, secondOp);
    } else if (firstOp.type === 'delete' && secondOp.type === 'delete') {
      mergedOp = this._mergeDeleteOperations(firstOp, secondOp);
    } else {
      // Mixed operations - merge as overwrite
      mergedOp = this._mergeAsOverwrite(firstOp, secondOp);
    }
    
    // CRITICAL FIX: Update this operation with merged data properly
    this.type = mergedOp.type;
    this.preExecutionPosition = mergedOp.position;
    this.data = mergedOp.data;
    this.originalData = mergedOp.originalData;
    
    // CRITICAL: Keep the earliest timestamp for proper chronological order
    this.timestamp = Math.min(firstOp.timestamp, secondOp.timestamp);
    
    // CRITICAL: Update post-execution position based on merged result
    if (mergedOp.type === 'insert') {
      this.postExecutionPosition = mergedOp.position;
    } else if (mergedOp.type === 'delete') {
      this.postExecutionPosition = mergedOp.position;
    } else if (mergedOp.type === 'overwrite') {
      this.postExecutionPosition = mergedOp.position;
    }
  }

  /**
   * FIXED: Merge two insert operations
   */
  private _mergeInsertOperations(firstOp: BufferOperation, secondOp: BufferOperation): MergedOperationResult {
    // Determine which operation comes first in the final buffer
    let finalFirstStart = firstOp.preExecutionPosition;
    let finalSecondStart = secondOp.preExecutionPosition;
    
    // Apply position adjustments based on chronological order
    if (firstOp.operationNumber <= secondOp.operationNumber) {
      // Second op gets pushed right by first op if first op comes before it
      if (firstOp.preExecutionPosition <= secondOp.preExecutionPosition) {
        finalSecondStart += firstOp.data ? firstOp.data.length : 0;
      }
    }
    
    if (finalFirstStart <= finalSecondStart) {
      // First operation comes before second in final buffer
      return {
        type: 'insert',
        position: firstOp.preExecutionPosition,
        data: Buffer.concat([firstOp.data || Buffer.alloc(0), secondOp.data || Buffer.alloc(0)]),
        originalData: Buffer.alloc(0)
      };
    } else {
      // Second operation comes before first in final buffer
      return {
        type: 'insert',
        position: secondOp.preExecutionPosition,
        data: Buffer.concat([secondOp.data || Buffer.alloc(0), firstOp.data || Buffer.alloc(0)]),
        originalData: Buffer.alloc(0)
      };
    }
  }

  /**
   * FIXED: Merge two delete operations
   */
  private _mergeDeleteOperations(firstOp: BufferOperation, secondOp: BufferOperation): MergedOperationResult {
    // Determine the final position (should be the lowest position)
    const finalPosition = Math.min(firstOp.preExecutionPosition, secondOp.preExecutionPosition);
    
    // Determine the correct order of data based on positions
    let combinedData: Buffer;
    if (firstOp.preExecutionPosition <= secondOp.preExecutionPosition) {
      // First operation is at lower/equal position
      combinedData = Buffer.concat([
        firstOp.originalData || Buffer.alloc(0), 
        secondOp.originalData || Buffer.alloc(0)
      ]);
    } else {
      // Second operation is at lower position (backspace scenario)
      combinedData = Buffer.concat([
        secondOp.originalData || Buffer.alloc(0), 
        firstOp.originalData || Buffer.alloc(0)
      ]);
    }
    
    return {
      type: 'delete',
      position: finalPosition,
      data: Buffer.alloc(0),
      originalData: combinedData
    };
  }

  /**
   * FIXED: Merge mixed operations as overwrite
   */
  private _mergeAsOverwrite(firstOp: BufferOperation, secondOp: BufferOperation): MergedOperationResult {
    const startPos = Math.min(firstOp.preExecutionPosition, secondOp.preExecutionPosition);
    
    // For mixed operations, we need to be careful about the final result
    let finalData: Buffer, originalData: Buffer;
    
    if (firstOp.type === 'delete' && secondOp.type === 'insert') {
      // Delete then insert at same/nearby position
      finalData = secondOp.data || Buffer.alloc(0);
      originalData = firstOp.originalData || Buffer.alloc(0);
    } else if (firstOp.type === 'insert' && secondOp.type === 'delete') {
      // Insert then delete - tricky case
      originalData = firstOp.data || Buffer.alloc(0);
      finalData = Buffer.alloc(0); // Net result is deletion
    } else {
      // One of them is overwrite
      finalData = secondOp.type === 'delete' ? Buffer.alloc(0) : (secondOp.data || Buffer.alloc(0));
      originalData = firstOp.type === 'delete' ? (firstOp.originalData || Buffer.alloc(0)) : (firstOp.data || Buffer.alloc(0));
    }
    
    return {
      type: 'overwrite',
      position: startPos,
      data: finalData,
      originalData: originalData
    };
  }
}

export {
  BufferOperation,
  OperationType,
  resetOperationCounter,
  getOperationCounter,
  type MergedOperationResult
};
