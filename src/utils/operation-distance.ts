/**
 * @fileoverview Operation Distance Calculator
 * Calculates logical distance between buffer operations for merge decisions
 * @author Jeffrey R. Day
 * @version 1.0.0
 */

import {
  type OperationType,
  type BufferOperation,
  type OperationRange,
  type DistanceCalculationOptions,
  type OperationDistanceDebugInfo
} from '../types/common';

import { logger } from './logger';

/**
 * Represents position information for an operation
 */
class OperationPosition {
  public preExecution: number; // Position before operation executes
  public postExecution: number | null; // Position after operation executes

  constructor(preExecution: number, postExecution: number | null = null) {
    this.preExecution = preExecution;
    this.postExecution = postExecution;
  }
  
  /**
   * Set the post-execution position
   */
  setPostExecution(position: number): void {
    this.postExecution = position;
  }
  
  /**
   * Check if this position info is complete (has both pre and post execution positions)
   */
  isComplete(): boolean {
    return this.postExecution !== null;
  }
}

/**
 * Lightweight operation descriptor for distance calculations
 */
class OperationDescriptor {
  public type: OperationType;
  public position: OperationPosition;
  public dataLength: number; // Length of inserted/overwritten data
  public originalDataLength: number; // Length of deleted/overwritten data
  public operationNumber: number; // For chronological ordering

  constructor(
    type: OperationType,
    position: number,
    dataLength: number = 0,
    originalDataLength: number = 0,
    operationNumber: number = 0
  ) {
    this.type = type;
    this.position = new OperationPosition(position);
    this.dataLength = dataLength;
    this.originalDataLength = originalDataLength;
    this.operationNumber = operationNumber;
  }
  
  /**
   * Create from a BufferOperation
   */
  static fromBufferOperation(bufferOp: BufferOperation): OperationDescriptor {
    const dataLength = bufferOp.data ? bufferOp.data.length : 0;
    const originalDataLength = bufferOp.originalData ? bufferOp.originalData.length : 0;
    
    const descriptor = new OperationDescriptor(
      bufferOp.type,
      bufferOp.preExecutionPosition ?? bufferOp.position, // Fallback for legacy
      dataLength,
      originalDataLength,
      bufferOp.operationNumber
    );
    
    if (bufferOp.postExecutionPosition !== null && bufferOp.postExecutionPosition !== undefined) {
      descriptor.position.setPostExecution(bufferOp.postExecutionPosition);
    }
    
    return descriptor;
  }
  
  /**
   * Set post-execution position
   */
  setPostExecutionPosition(position: number): void {
    this.position.setPostExecution(position);
  }
  
  /**
   * Get the length of content this operation adds to the final buffer
   */
  getInsertedLength(): number {
    switch (this.type) {
      case 'insert':
        return this.dataLength;
      case 'delete':
        return 0; // Delete removes content, doesn't add
      case 'overwrite':
        return this.dataLength;
      default:
        return 0;
    }
  }
}

/**
 * Calculator for logical distance between operations
 */
class OperationDistanceCalculator {
  
  /**
   * Calculate logical distance between two operations
   */
  static calculateDistance(
    op1: OperationDescriptor,
    op2: OperationDescriptor,
    options: DistanceCalculationOptions = {}
  ): number {
    // Determine chronological order
    let firstOp: OperationDescriptor, secondOp: OperationDescriptor;
    if (op1.operationNumber <= op2.operationNumber) {
      firstOp = op1;
      secondOp = op2;
    } else {
      firstOp = op2;
      secondOp = op1;
    }
    
    // Verify that the first operation has executed
    if (!firstOp.position.isComplete()) {
      throw new Error('Cannot calculate distance: first operation has not executed yet');
    }
    
    // Calculate affected range of first operation (ffS, ffE)
    const range = this._calculateOperationRange(firstOp);
    
    // Calculate distance from second operation to this range
    const distance = this._calculateDistanceToRange(secondOp, range);
    
    // Debug logging
    if (options.debug) {
      this._logDistanceCalculation(firstOp, secondOp, range, distance);
    }
    
    return distance;
  }
  
  /**
   * Calculate the range affected by an operation in post-execution coordinates
   */
  private static _calculateOperationRange(op: OperationDescriptor): OperationRange {
    const start = op.position.postExecution!;
    let end: number;
    
    if (op.type === 'delete') {
      // Delete operations don't occupy space in final buffer
      end = start;
    } else {
      // Insert/overwrite operations occupy space
      end = start + op.getInsertedLength();
    }
    
    return { start, end };
  }
  
  /**
   * Calculate distance from an operation to a range
   */
  private static _calculateDistanceToRange(op: OperationDescriptor, range: OperationRange): number {
    if (op.type === 'insert') {
      return this._calculateInsertDistance(op, range);
    } else if (op.type === 'delete') {
      return this._calculateDeleteDistance(op, range);
    } else if (op.type === 'overwrite') {
      return this._calculateOverwriteDistance(op, range);
    } else {
      // Unknown operation type, use position difference
      return Math.abs(op.position.preExecution - range.start);
    }
  }
  
  /**
   * Calculate distance for insert operations
   */
  private static _calculateInsertDistance(op: OperationDescriptor, range: OperationRange): number {
    const insPos = op.position.preExecution;
    
    // Check if insertion point is within or touching the range
    if (insPos >= range.start && insPos <= range.end) {
      return 0;
    }
    
    // Calculate minimum distance to either boundary
    return Math.min(Math.abs(insPos - range.start), Math.abs(insPos - range.end));
  }
  
  /**
   * Calculate distance for delete operations
   */
  private static _calculateDeleteDistance(op: OperationDescriptor, range: OperationRange): number {
    const delStart = op.position.preExecution;
    const delEnd = delStart + op.originalDataLength;
    
    // Check if deletion range touches the target range
    if ((delStart >= range.start && delStart <= range.end) || 
        (delEnd >= range.start && delEnd <= range.end) ||
        (delStart <= range.start && delEnd >= range.end)) {
      return 0;
    }
    
    // Calculate minimum distance from any part of deletion to any boundary
    return Math.min(
      Math.min(Math.abs(delStart - range.start), Math.abs(delEnd - range.start)),
      Math.min(Math.abs(delStart - range.end), Math.abs(delEnd - range.end))
    );
  }
  
  /**
   * Calculate distance for overwrite operations
   */
  private static _calculateOverwriteDistance(op: OperationDescriptor, range: OperationRange): number {
    const ovStart = op.position.preExecution;
    const ovEnd = ovStart + op.dataLength;
    
    // Check if overwrite range touches the target range
    if ((ovStart >= range.start && ovStart <= range.end) || 
        (ovEnd >= range.start && ovEnd <= range.end) ||
        (ovStart <= range.start && ovEnd >= range.end)) {
      return 0;
    }
    
    return Math.min(
      Math.min(Math.abs(ovStart - range.start), Math.abs(ovEnd - range.start)),
      Math.min(Math.abs(ovStart - range.end), Math.abs(ovEnd - range.end))
    );
  }
  
  /**
   * Log debug distance calculation
   */
  private static _logDistanceCalculation(
    firstOp: OperationDescriptor,
    secondOp: OperationDescriptor,
    range: OperationRange,
    distance: number
  ): void {
    const debugInfo = this._getDebugDistanceCalculation(firstOp, secondOp, range, distance);
    logger.debug('[OperationDistance]', JSON.stringify(debugInfo, null, 2));
  }
  
  /**
   * Get debug distance calculation
   */
  private static _getDebugDistanceCalculation(
    firstOp: OperationDescriptor,
    secondOp: OperationDescriptor,
    range: OperationRange,
    distance: number
  ): OperationDistanceDebugInfo {
    return {
      firstOp: {
        type: firstOp.type,
        prePos: firstOp.position.preExecution,
        postPos: firstOp.position.postExecution,
        len: firstOp.getInsertedLength()
      },
      secondOp: {
        type: secondOp.type,
        prePos: secondOp.position.preExecution,
        len: secondOp.getInsertedLength()
      },
      range: { start: range.start, end: range.end },
      distance: distance
    };
  }
}

export {
  OperationPosition,
  OperationDescriptor,
  OperationDistanceCalculator
};
