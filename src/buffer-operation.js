/**
 * @fileoverview Enhanced BufferOperation with position tracking and distance calculation - FIXED
 * @author Jeffrey R. Day
 * @version 1.0.0
 */

const { OperationDescriptor, OperationDistanceCalculator } = require('./utils/operation-distance');

/**
 * Operation types for undo/redo tracking
 */
const OperationType = {
  INSERT: 'insert',
  DELETE: 'delete',
  OVERWRITE: 'overwrite'
};

/**
 * Global operation counter for determining chronological order
 * Moved here from undo-system.js since BufferOperation needs it
 */
let globalOperationCounter = 0;

/**
 * Reset the global operation counter (for testing)
 */
function resetOperationCounter() {
  globalOperationCounter = 0;
}

/**
 * Get current operation counter value (for testing)
 */
function getOperationCounter() {
  return globalOperationCounter;
}

/**
 * Enhanced BufferOperation with position tracking and distance calculation - FIXED
 */
class BufferOperation {
  constructor(type, position, data, originalData = null, timestamp = null) {
    this.type = type;
    this.preExecutionPosition = position;
    this.data = data;
    this.originalData = originalData;
    this.timestamp = timestamp || Date.now();
    this.operationNumber = ++globalOperationCounter;
    this.id = `op_${this.operationNumber}_${this.timestamp}`;
    
    // Post-execution position (set after operation completes)
    this.postExecutionPosition = null;
  }

  /**
   * Legacy position property for backwards compatibility
   */
  get position() {
    return this.preExecutionPosition;
  }

  /**
   * Set position for backwards compatibility
   */
  set position(value) {
    this.preExecutionPosition = value;
  }

  /**
   * Set the position after this operation has executed
   * @param {number} position - Position in buffer after operation executed
   */
  setPostExecutionPosition(position) {
    this.postExecutionPosition = position;
  }

  /**
   * Calculate logical distance to another operation using the distance module
   * @param {BufferOperation} other - Other operation to compare with
   * @param {Object} options - Calculation options
   * @param {boolean} options.debug - Enable debug logging
   * @returns {number} - Logical distance (0 = adjacent/overlapping)
   */
  getLogicalDistance(other, options = {}) {
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
   * @returns {number} - Net size change (positive for growth, negative for shrinkage)
   */
  getSizeImpact() {
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
   * @returns {number} - End position
   */
  getEndPosition() {
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
   * @returns {number}
   */
  _getInsertedLength() {
    switch (this.type) {
      case 'insert':
        return this.data ? this.data.length : 0;
      case 'delete':
        return 0;
      case 'overwrite':
        return this.data ? this.data.length : 0;
      default:
        return 0;
    }
  }

  /**
   * Check if this operation can be merged with another - FIXED
   * @param {BufferOperation} other - Other operation
   * @param {number} timeWindow - Time window for merging (ms)
   * @param {number} positionWindow - Position window for merging (bytes)
   * @returns {boolean} - True if mergeable
   */
  canMergeWith(other, timeWindow = 15000, positionWindow = -1) {
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
      let distance;
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
   * @param {string} type1 - First operation type
   * @param {string} type2 - Second operation type
   * @returns {boolean} - True if compatible
   * @private
   */
  _areOperationsCompatible(type1, type2) {
    // Same type operations are generally compatible
    if (type1 === type2) {
      return true;
    }

    // Cross-type compatibility rules
    const compatibleCombinations = [
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
   * @param {BufferOperation} other - Operation to merge
   */
  mergeWith(other) {
    // Determine chronological order
    let firstOp, secondOp;
    
    if (this.operationNumber <= other.operationNumber) {
      firstOp = this;
      secondOp = other;
    } else {
      firstOp = other;
      secondOp = this;
    }
    
    let mergedOp;
    
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
  _mergeInsertOperations(firstOp, secondOp) {
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
  _mergeDeleteOperations(firstOp, secondOp) {
    // Determine the final position (should be the lowest position)
    const finalPosition = Math.min(firstOp.preExecutionPosition, secondOp.preExecutionPosition);
    
    // Determine the correct order of data based on positions
    let combinedData;
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
  _mergeAsOverwrite(firstOp, secondOp) {
    const startPos = Math.min(firstOp.preExecutionPosition, secondOp.preExecutionPosition);
    
    // For mixed operations, we need to be careful about the final result
    let finalData, originalData;
    
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

module.exports = {
  BufferOperation,
  OperationType,
  resetOperationCounter,
  getOperationCounter
};
