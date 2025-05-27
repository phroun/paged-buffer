/**
 * @fileoverview Operation Distance Calculator
 * Calculates logical distance between buffer operations for merge decisions
 * @author Jeffrey R. Day
 * @version 1.0.0
 */

/**
 * Represents position information for an operation
 */
class OperationPosition {
  constructor(preExecution, postExecution = null) {
    this.preExecution = preExecution; // Position before operation executes
    this.postExecution = postExecution; // Position after operation executes
  }
  
  /**
   * Set the post-execution position
   * @param {number} position - Position after operation executed
   */
  setPostExecution(position) {
    this.postExecution = position;
  }
  
  /**
   * Check if this position info is complete (has both pre and post execution positions)
   * @returns {boolean}
   */
  isComplete() {
    return this.postExecution !== null;
  }
}

/**
 * Lightweight operation descriptor for distance calculations
 */
class OperationDescriptor {
  constructor(type, position, dataLength = 0, originalDataLength = 0, operationNumber = 0) {
    this.type = type; // 'insert', 'delete', 'overwrite'
    this.position = new OperationPosition(position);
    this.dataLength = dataLength; // Length of inserted/overwritten data
    this.originalDataLength = originalDataLength; // Length of deleted/overwritten data
    this.operationNumber = operationNumber; // For chronological ordering
  }
  
  /**
   * Create from a BufferOperation
   * @param {BufferOperation} bufferOp - Source operation
   * @returns {OperationDescriptor}
   */
  static fromBufferOperation(bufferOp) {
    const dataLength = bufferOp.data ? bufferOp.data.length : 0;
    const originalDataLength = bufferOp.originalData ? bufferOp.originalData.length : 0;
    
    const descriptor = new OperationDescriptor(
      bufferOp.type,
      bufferOp.preExecutionPosition || bufferOp.position, // Fallback for legacy
      dataLength,
      originalDataLength,
      bufferOp.operationNumber
    );
    
    if (bufferOp.postExecutionPosition !== null) {
      descriptor.position.setPostExecution(bufferOp.postExecutionPosition);
    }
    
    return descriptor;
  }
  
  /**
   * Set post-execution position
   * @param {number} position - Position after execution
   */
  setPostExecutionPosition(position) {
    this.position.setPostExecution(position);
  }
  
  /**
   * Get the length of content this operation adds to the final buffer
   * @returns {number}
   */
  getInsertedLength() {
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
   * @param {OperationDescriptor} op1 - First operation
   * @param {OperationDescriptor} op2 - Second operation
   * @param {Object} options - Calculation options
   * @param {boolean} options.debug - Enable debug logging
   * @returns {number} - Logical distance (0 = adjacent/overlapping)
   */
  static calculateDistance(op1, op2, options = {}) {
    // Determine chronological order
    let firstOp, secondOp;
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
   * @param {OperationDescriptor} op - Operation that has executed
   * @returns {{start: number, end: number}} - Affected range
   * @private
   */
  static _calculateOperationRange(op) {
    const start = op.position.postExecution;
    let end;
    
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
   * @param {OperationDescriptor} op - Operation to test
   * @param {{start: number, end: number}} range - Target range
   * @returns {number} - Distance to range
   * @private
   */
  static _calculateDistanceToRange(op, range) {
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
   * @param {OperationDescriptor} op - Insert operation
   * @param {{start: number, end: number}} range - Target range
   * @returns {number} - Distance
   * @private
   */
  static _calculateInsertDistance(op, range) {
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
   * @param {OperationDescriptor} op - Delete operation
   * @param {{start: number, end: number}} range - Target range
   * @returns {number} - Distance
   * @private
   */
  static _calculateDeleteDistance(op, range) {
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
   * @param {OperationDescriptor} op - Overwrite operation
   * @param {{start: number, end: number}} range - Target range
   * @returns {number} - Distance
   * @private
   */
  static _calculateOverwriteDistance(op, range) {
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
   * Get debug distance calculation
   * @param {OperationDescriptor} firstOp - First operation
   * @param {OperationDescriptor} secondOp - Second operation
   * @param {{start: number, end: number}} range - Calculated range
   * @param {number} distance - Calculated distance
   * @returns {firstOp, secondOp, range, distance} - Debugging descriptions
   * @private
   */
  static _getDebugDistanceCalculation(firstOp, secondOp, range, distance) {
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

module.exports = {
  OperationPosition,
  OperationDescriptor,
  OperationDistanceCalculator
};
