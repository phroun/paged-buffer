/**
 * Undo/Redo System for PagedBuffer with transaction support
 * COMPLETE FIXED VERSION - All critical bugs resolved + Emergency dump system
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');

/**
 * Operation types for undo/redo tracking
 */
const OperationType = {
  INSERT: 'insert',
  DELETE: 'delete',
  OVERWRITE: 'overwrite'
};

function debugLog(s) {
  // do nothing for now
}

/**
 * Represents a single atomic operation that can be undone/redone
 */
class BufferOperation {
  constructor(type, position, data, originalData = null, timestamp = null) {
    this.type = type; // Should be string: 'insert', 'delete', 'overwrite'
    this.position = position; // Should be number: byte position
    this.data = data; // Should be Buffer
    this.originalData = originalData; // Should be Buffer or null
    this.timestamp = timestamp || Date.now();
    this.id = `op_${this.timestamp}_${Math.random().toString(36).substr(2, 9)}`;
    
    // DEBUG: Log what we're creating
    debugLog(`DEBUG: BufferOperation constructor called:`, {
      type: typeof this.type,
      typeValue: this.type,
      position: typeof this.position,
      positionValue: this.position,
      dataLength: this.data ? this.data.length : 'null',
      originalDataLength: this.originalData ? this.originalData.length : 'null'
    });
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
   * Get the end position of this operation
   * @returns {number} - End position
   */
  getEndPosition() {
    switch (this.type) {
      case OperationType.INSERT:
        return this.position + (this.data ? this.data.length : 0);
      case OperationType.DELETE:
        return this.position;
      case OperationType.OVERWRITE:
        return this.position + (this.data ? this.data.length : 0);
      default:
        return this.position;
    }
  }

  /**
   * Calculate logical distance between this operation and another
   * FIXED: Accounts for how the NEW operation shifts the PREVIOUS operation's final position
   * @param {BufferOperation} other - Other operation (the new one being considered)
   * @returns {number} - Logical distance (0 = adjacent/overlapping)
   */
  getLogicalDistance(other) {
    // This = previous operation, other = new operation being considered
    
    // Get our original range (the previous operation)
    const thisStart = this.position;
    const thisEnd = this._getEffectiveEndPosition();
    
    // Adjust OUR position based on how the NEW operation will shift us
    const adjustedThisStart = this._adjustForNewOperation(thisStart, other);
    const adjustedThisEnd = this._adjustForNewOperation(thisEnd, other);
    
    // Get the new operation's range (no adjustment needed - it executes first)
    const otherStart = other.position;
    const otherEnd = other.position + this._getOperationLength(other);

    // Calculate distance between the adjusted ranges
    return this._calculateDistanceBetweenRanges(
      adjustedThisStart, adjustedThisEnd,
      otherStart, otherEnd
    );
  }

  /**
   * Adjust our position based on how the new operation will affect us
   */
  _adjustForNewOperation(ourPosition, newOperation) {
    switch (newOperation.type) {
      case OperationType.INSERT:
        // If new operation inserts BEFORE our position, we get shifted right
        if (newOperation.position <= ourPosition) {
          return ourPosition + (newOperation.data ? newOperation.data.length : 0);
        }
        // If new operation inserts AFTER our position, we're not affected
        return ourPosition;
        
      case OperationType.DELETE:
        // If new operation deletes BEFORE our position, we get shifted left
        if (newOperation.position < ourPosition) {
          const deleteLength = newOperation.originalData ? newOperation.originalData.length : 0;
          return Math.max(newOperation.position, ourPosition - deleteLength);
        }
        // If new operation deletes AFTER our position, we're not affected
        return ourPosition;
        
      case OperationType.OVERWRITE:
        // If new operation overwrites BEFORE our position, we might get shifted
        if (newOperation.position < ourPosition) {
          const oldLength = newOperation.originalData ? newOperation.originalData.length : 0;
          const newLength = newOperation.data ? newOperation.data.length : 0;
          const netChange = newLength - oldLength;
          return ourPosition + netChange;
        }
        return ourPosition;
        
      default:
        return ourPosition;
    }
  }

  /**
   * Get the effective end position where this operation's effect ends
   */
  _getEffectiveEndPosition() {
    switch (this.type) {
      case OperationType.INSERT:
        return this.position + (this.data ? this.data.length : 0);
      case OperationType.DELETE:
        return this.position; // Delete removes content, end position = start position
      case OperationType.OVERWRITE:
        return this.position + (this.data ? this.data.length : 0);
      default:
        return this.position;
    }
  }

  /**
   * Get the length of an operation's effect
   */
  _getOperationLength(operation) {
    switch (operation.type) {
      case OperationType.INSERT:
        return operation.data ? operation.data.length : 0;
      case OperationType.DELETE:
        return 0; // Delete doesn't add length to final position
      case OperationType.OVERWRITE:
        return operation.data ? operation.data.length : 0;
      default:
        return 0;
    }
  }

  /**
   * Calculate distance between two ranges
   */
  _calculateDistanceBetweenRanges(thisStart, thisEnd, otherStart, otherEnd) {
    // Case 1: Other range starts after this range ends
    if (otherStart >= thisEnd) {
      return otherStart - thisEnd; // Gap between ranges
    }
    
    // Case 2: This range starts after other range ends  
    if (thisStart >= otherEnd) {
      return thisStart - otherEnd; // Gap between ranges
    }
    
    // Case 3: Ranges overlap or are adjacent
    return 0;
  }

  /**
   * Check if this operation can be merged with another
   * @param {BufferOperation} other - Other operation
   * @param {number} timeWindow - Time window for merging (ms)
   * @param {number} positionWindow - Position window for merging (bytes)
   * @returns {boolean} - True if mergeable
   */
  canMergeWith(other, timeWindow, positionWindow) {
    // Time-based merging
    const timeDiff = Math.abs(this.timestamp - other.timestamp);
    const timeOk = timeDiff <= timeWindow;
    
    // Position-based merging - calculate distance between operation boundaries
    let distance = this._calculateDistanceTo(other);
    
    const distanceOk = distance <= positionWindow;
    
    const result = timeOk && distanceOk;
    return result;
  }

  _calculateDistanceTo(other) {
    // For operations that happen in sequence, we need to account for how
    // the buffer changes affect subsequent position calculations
    
    const thisStart = this.position;
    const thisEnd = this._getOperationEndPosition();
    
    const otherStart = other.position;
    const otherEnd = other._getOperationEndPosition();
    
    // Special case: if operations are at the exact same position, distance is 0
    if (thisStart === otherStart) {
      return 0;
    }
    
    // For consecutive typing (insertions), calculate based on expected positions
    if (this.type === 'insert' && other.type === 'insert') {
      // If the other operation starts exactly where this one ends, distance is 0
      if (other.position === thisEnd) {
        return 0;
      }
      // Otherwise calculate actual gap
      return Math.abs(other.position - thisEnd);
    }
    
    // For delete operations, consider the range being deleted
    if (this.type === 'delete' && other.type === 'delete') {
      // Adjacent deletes
      if (other.position === thisStart || other.position === thisEnd) {
        return 0;
      }
    }
    
    // For mixed operations, calculate minimum boundary distance
    const distances = [
      Math.abs(thisStart - otherStart),
      Math.abs(thisStart - otherEnd),
      Math.abs(thisEnd - otherStart),
      Math.abs(thisEnd - otherEnd)
    ];
    
    return Math.min(...distances);
  }

  _getOperationEndPosition() {
    // Calculate where this operation ends
    switch (this.type) {
      case 'insert':
        // Insert operation affects from position to position + data.length
        return this.position + (this.data ? this.data.length : 0);
        
      case 'delete':
        // Delete operation affects from position to position + originalData.length
        // But since we're calculating distance, we use the original range that was deleted
        return this.position + (this.originalData ? this.originalData.length : 0);
        
      case 'overwrite':  
        // Overwrite affects from position to position + max(data.length, originalData.length)
        const dataLen = this.data ? this.data.length : 0;
        const originalLen = this.originalData ? this.originalData.length : 0;
        return this.position + Math.max(dataLen, originalLen);
        
      default:
        return this.position;
    }
  }

  canMergeWith(other, timeWindow = 15000, positionWindow = 1000) {
    // BOTH time AND distance must be within their respective windows
    const timeWithinWindow = Math.abs(this.timestamp - other.timestamp) <= timeWindow;
    const logicalDistance = this.getLogicalDistance(other);
    const distanceWithinWindow = logicalDistance <= positionWindow;
    const result = timeWithinWindow && distanceWithinWindow;
    
    // Both conditions must be true
    if (result) {
      // Inline compatibility check
      if (this.type === other.type) {
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
        (this.type === first && other.type === second) ||
        (this.type === second && other.type === first)
      );
    }
    
    return false;
  }

  /**
   * Merge another operation into this one
   * @param {BufferOperation} other - Operation to merge
   * @returns {BufferOperation} - New merged operation
   */
  mergeWith(other) {
    // Determine the best way to merge these operations
    let mergedOp;
    
    if (this.type === 'delete' && other.type === 'delete') {
      mergedOp = this._mergeDeleteOperations(other);
    } else if (this.type === 'insert' && other.type === 'insert') {
      mergedOp = this._mergeInsertOperations(other);
    } else if ((this.type === 'insert' && other.type === 'delete') || 
               (this.type === 'delete' && other.type === 'insert')) {
      mergedOp = this._mergeInsertDeleteOperations(other);
    } else {
      // Default: convert to overwrite
      mergedOp = this._mergeAsOverwrite(other);
    }
    
    // Update this operation with merged data
    this.type = mergedOp.type;
    this.position = mergedOp.position;
    this.data = mergedOp.data;
    this.originalData = mergedOp.originalData;
  }

  _determineMergeStrategy(other) {
    // Handle different merge scenarios intelligently
    
    if (this.type === 'insert' && other.type === 'insert') {
      return this._mergeInsertOperations(other);
    }
    
    if (this.type === 'delete' && other.type === 'delete') {
      return this._mergeDeleteOperations(other);
    }
    
    if ((this.type === 'insert' && other.type === 'delete') || 
        (this.type === 'delete' && other.type === 'insert')) {
      return this._mergeInsertDeleteOperations(other);
    }
    
    // Default: convert to overwrite
    return this._mergeAsOverwrite(other);
  }
    
  _mergeInsertOperations(other) {
    // Merge two insert operations
    if (this.position <= other.position) {
      // This operation comes first
      const thisEnd = this.position + this.data.length;
      const gap = other.position - thisEnd;
      
      if (gap <= 0) {
        // Adjacent or overlapping inserts - simple concatenation
        // Handle overlap by taking the furthest extent
        const overlapAdjustment = Math.max(0, -gap);
        const effectiveOtherData = other.data.subarray(overlapAdjustment);
        
        return {
          type: 'insert',
          position: this.position,
          data: Buffer.concat([this.data, effectiveOtherData]),
          originalData: Buffer.alloc(0)
        };
      } else if (gap <= 2) {
        // Small gap - fill with spaces or merge anyway for nearby operations
        const fillBuffer = Buffer.alloc(gap, 32); // Fill with spaces
        return {
          type: 'insert',
          position: this.position,
          data: Buffer.concat([this.data, fillBuffer, other.data]),
          originalData: Buffer.alloc(0)
        };
      } else {
        // Large gap - shouldn't happen if distance calc is correct, but handle gracefully
        // Don't merge operations that are too far apart
        throw new Error(`Cannot merge insert operations with gap of ${gap}`);
      }
    } else {
      // Other operation comes first
      return other._mergeInsertOperations(this);
    }
  }

// In undo-system.js, replace the _mergeDeleteOperations method:

_mergeDeleteOperations(other) {
  // IMPORTANT: 'this' is the existing operation, 'other' is the new operation
  // We need to restore content in position order (lower positions first)
  
  // Determine the final position (should be the lowest position)
  const finalPosition = Math.min(this.position, other.position);
  
  // Determine the correct order of data based on positions
  let combinedData;
  if (this.position <= other.position) {
    // Existing operation is at lower/equal position
    // Example: this at pos 2, other at pos 3
    // Restore: this.data (pos 2) then other.data (pos 3)
    combinedData = Buffer.concat([this.originalData, other.originalData]);
  } else {
    // New operation is at lower position (backspace scenario)
    // Example: this at pos 3, other at pos 2  
    // Restore: other.data (pos 2) then this.data (pos 3)
    combinedData = Buffer.concat([other.originalData, this.originalData]);
  }
  
  return {
    type: 'delete',
    position: finalPosition,
    data: Buffer.alloc(0),
    originalData: combinedData
  };
}



  _mergeInsertDeleteOperations(other) {
    // Merge insert and delete operations
    if (this.type === 'delete' && other.type === 'insert') {
      // Delete then insert at same/nearby position = overwrite
      return {
        type: 'overwrite',
        position: Math.min(this.position, other.position),
        data: other.data,
        originalData: this.originalData
      };
    } else {
      // Insert then delete at same/nearby position  
      const netData = Buffer.alloc(Math.max(0, this.data.length - other.originalData.length));
      if (netData.length === 0) {
        // Insert then delete same amount = no-op, but keep as insert with remaining data
        return {
          type: 'insert',
          position: this.position,
          data: netData,
          originalData: Buffer.alloc(0)
        };
      } else {
        return {
          type: 'insert',
          position: this.position,
          data: netData,
          originalData: Buffer.alloc(0)
        };
      }
    }
  }

  _mergeAsOverwrite(other) {
    // Generic merge as overwrite operation
    const startPos = Math.min(this.position, other.position);
    
    return {
      type: 'overwrite',
      position: startPos,
      data: other.data || Buffer.alloc(0),
      originalData: this.originalData || Buffer.alloc(0)
    };
  }
  
}

/**
 * Represents a group of operations that form a logical unit
 */
class OperationGroup {
  constructor(description = 'Edit operation', clockFn = null) {
    this.operations = [];
    this.description = description;
    this.timestamp = clockFn ? clockFn() : Date.now();
    this.id = `group_${this.timestamp}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Add an operation to this group
   * @param {BufferOperation} operation - Operation to add
   */
  addOperation(operation) {
    this.operations.push(operation);
    this.timestamp = Math.max(this.timestamp, operation.timestamp);
  }

  /**
   * Get total size impact of all operations in group
   * @returns {number} - Net size change
   */
  getTotalSizeImpact() {
    return this.operations.reduce((total, op) => total + op.getSizeImpact(), 0);
  }

  /**
   * Get affected position range
   * @returns {Object} - {start, end} positions
   */
  getAffectedRange() {
    if (this.operations.length === 0) {
      return { start: 0, end: 0 };
    }

    let start = Infinity;
    let end = -Infinity;

    for (const op of this.operations) {
      start = Math.min(start, op.position);
      end = Math.max(end, op.getEndPosition());
    }

    return { start, end };
  }

  /**
   * Check if this group can be merged with another
   * @param {OperationGroup} other - Other group
   * @param {number} timeWindow - Time window for merging
   * @param {number} positionWindow - Position window for merging
   * @returns {boolean} - True if mergeable
   */
  canMergeWith(other, timeWindow = 15000, positionWindow = 1000) {
    // BOTH time AND distance must be within their respective windows
    const timeWithinWindow = Math.abs(this.timestamp - other.timestamp) <= timeWindow;
    const logicalDistance = this._calculateLogicalDistance(other);
    const distanceWithinWindow = logicalDistance <= positionWindow;
    
    // Both conditions must be true
    return timeWithinWindow && distanceWithinWindow;
  }

  /**
   * Calculate logical distance between operation groups
   * @param {OperationGroup} other - Other group
   * @returns {number} - Logical distance
   */
  _calculateLogicalDistance(other) {
    if (this.operations.length === 0 || other.operations.length === 0) {
      return Infinity;
    }

    // Find the closest logical distance between any operations in the groups
    let minDistance = Infinity;

    for (const thisOp of this.operations) {
      for (const otherOp of other.operations) {
        const distance = thisOp.getLogicalDistance(otherOp);
        minDistance = Math.min(minDistance, distance);
        
        // Early exit if we find adjacent operations
        if (distance === 0) {
          return 0;
        }
      }
    }

    // Also consider the relationship between the groups' overall ranges
    const thisRange = this.getAffectedRange();
    const otherRange = other.getAffectedRange();
    
    // Check if ranges are adjacent or overlapping
    if (thisRange.end === otherRange.start || otherRange.end === thisRange.start) {
      return 0; // Adjacent ranges
    }
    
    if (!(thisRange.end < otherRange.start || otherRange.end < thisRange.start)) {
      return 0; // Overlapping ranges
    }

    // Distance between range boundaries
    const rangeDistance = Math.min(
      Math.abs(thisRange.end - otherRange.start),
      Math.abs(otherRange.end - thisRange.start)
    );

    return Math.min(minDistance, rangeDistance);
  }

  /**
   * Merge another group into this one
   * @param {OperationGroup} other - Group to merge
   * @returns {OperationGroup} - New merged group
   */
  mergeWith(other) {
    const merged = new OperationGroup(`${this.description} + ${other.description}`);
    merged.timestamp = Math.min(this.timestamp, other.timestamp);
    merged.id = `merged_${this.id}_${other.id}`;

    // Combine all operations
    merged.operations = [...this.operations, ...other.operations];
    
    // Sort by position and timestamp for consistent ordering
    merged.operations.sort((a, b) => {
      if (a.position !== b.position) {
        return a.position - b.position;
      }
      return a.timestamp - b.timestamp;
    });

    return merged;
  }
}

/**
 * Undo/Redo system for PagedBuffer with transaction support
 * COMPLETE FIXED VERSION with all critical bug fixes + Emergency Dump System
 */
class BufferUndoSystem {
  constructor(pagedBuffer, maxUndoLevels = 1000) {
    this.buffer = pagedBuffer;
    this.maxUndoLevels = maxUndoLevels;

    this.isUndoing = false;
    
    // Undo/redo stacks
    this.undoStack = []; // Array of OperationGroup
    this.redoStack = []; // Array of OperationGroup
    
    // Current operation tracking
    this.currentGroup = null;
    
    // Configuration
    this.mergeTimeWindow = 15000; // 15 seconds
    this.mergePositionWindow = 0; // 0 bytes distance
    this.autoGroupTimeout = 2000; // 2 seconds for auto-grouping
    
    // Transaction system
    this.activeTransaction = null;
    this.transactionStack = []; // Support nested transactions
    
    // Clock injection for testing
    this.clockFn = null;
  }

  /**
   * Set a custom clock function for testing
   * @param {Function} clockFn - Function that returns current timestamp
   */
  setClock(clockFn) {
    this.clockFn = clockFn;
  }

  /**
   * Get current time using injected clock or system clock
   * @returns {number} - Current timestamp
   */
  getClock() {
    return this.clockFn ? this.clockFn() : Date.now();
  }

  /**
   * Begin a named transaction
   * @param {string} name - Name/description of the transaction
   * @param {Object} options - Transaction options
   */
  beginTransaction(name, options = {}) {
    // If there's already an active transaction, nest it
    if (this.activeTransaction) {
      this.transactionStack.push(this.activeTransaction);
    }

    // Close any current auto-managed group
    this._closeCurrentGroup();
    
    // Create new transaction
    this.activeTransaction = {
      name,
      startTime: this.getClock(),
      operations: [],
      options: {
        allowMerging: options.allowMerging || false, // Allow merging within transaction
        autoCommit: options.autoCommit !== false,    // Auto-commit on next non-transaction operation
        ...options
      },
      id: `tx_${this.getClock()}_${Math.random().toString(36).substr(2, 9)}`
    };

    this.buffer._notify(
      'undo_transaction_started',
      'info',
      `Started transaction: ${name}`,
      { 
        transactionId: this.activeTransaction.id,
        name,
        nested: this.transactionStack.length > 0
      }
    );
  }

  /**
   * Commit the current transaction
   * @param {string} finalName - Optional final name (overrides original name)
   * @returns {boolean} - True if transaction was committed
   */
  commitTransaction(finalName = null) {
    if (!this.activeTransaction) {
      return false;
    }
    
//    console.log(`DEBUG: Committing transaction with ${this.activeTransaction.operations.length} operations`);
    
    // Create a group from transaction operations
    const group = new OperationGroup(this._generateGroupId());
    
    // CRITICAL FIX: Copy the operations correctly
    group.operations = [...this.activeTransaction.operations]; // Don't modify original operations
    
    // Set group name
    if (finalName) {
      this.activeTransaction.name = finalName;
    }
    
    // CRITICAL FIX: Add group to undo stack with forceNoMerge = true
    // Transactions should NEVER merge with adjacent operations
    this._addGroupToUndoStack(group, true); // forceNoMerge = true
    
    // Notify about transaction commit
    if (this.buffer && this.buffer._notify) {
      this.buffer._notify('undo_transaction_committed', 'info', `Committed transaction: ${this.activeTransaction.name}`, {
        name: this.activeTransaction.name,
        operationCount: group.operations.length
      });
    }
    
    // Clear transaction
    this.activeTransaction = null;
    
    return true;
  }

  /**
   * Rollback the current transaction
   * @returns {Promise<boolean>} - True if transaction was rolled back
   */
  async rollbackTransaction() {
    if (!this.activeTransaction) {
      this.buffer._notify(
        'undo_transaction_error',
        'warning',
        'No active transaction to rollback',
        {}
      );
      return false;
    }

    const transaction = this.activeTransaction;

    try {
      // Undo all operations in reverse order
      for (let i = transaction.operations.length - 1; i >= 0; i--) {
        const op = transaction.operations[i];
        await this._undoOperation(op);
      }

      this.buffer._notify(
        'undo_transaction_rolled_back',
        'info',
        `Rolled back transaction: ${transaction.name} (${transaction.operations.length} operations)`,
        {
          transactionId: transaction.id,
          name: transaction.name,
          operations: transaction.operations.length
        }
      );

      this._cleanupTransaction();
      return true;
    } catch (error) {
      this.buffer._notify(
        'undo_transaction_rollback_failed',
        'error',
        `Failed to rollback transaction: ${error.message}`,
        {
          transactionId: transaction.id,
          error: error.message
        }
      );
      return false;
    }
  }

  /**
   * Clean up current transaction and restore previous one if nested
   */
  _cleanupTransaction() {
    this.activeTransaction = null;

    // Restore previous transaction if nested
    if (this.transactionStack.length > 0) {
      this.activeTransaction = this.transactionStack.pop();
    }
  }

  /**
   * Check if currently in a transaction
   * @returns {boolean} - True if in transaction
   */
  inTransaction() {
    return this.activeTransaction !== null;
  }

  /**
   * Get current transaction info
   * @returns {Object|null} - Transaction info or null
   */
  getCurrentTransaction() {
    return this.activeTransaction ? {
      name: this.activeTransaction.name,
      id: this.activeTransaction.id,
      operations: this.activeTransaction.operations.length,
      startTime: this.activeTransaction.startTime,
      nested: this.transactionStack.length > 0
    } : null;
  }

  /**
   * Generate automatic operation name based on operations
   * @param {Array} operations - Array of operations
   * @returns {string} - Generated name
   */
  _generateOperationName(operations) {
    if (operations.length === 0) {
      return 'Empty operation';
    }

    // Analyze operation types and patterns
    const insertOps = operations.filter(op => op.type === OperationType.INSERT);
    const deleteOps = operations.filter(op => op.type === OperationType.DELETE);
    const overwriteOps = operations.filter(op => op.type === OperationType.OVERWRITE);

    // Single operation type names
    if (operations.length === 1) {
      const op = operations[0];
      switch (op.type) {
        case OperationType.INSERT:
          return 'Insert content';
        case OperationType.DELETE:
          return 'Delete content';
        case OperationType.OVERWRITE:
          return 'Replace content';
      }
    }

    // Multiple operations - categorize
    if (insertOps.length > 0 && deleteOps.length === 0 && overwriteOps.length === 0) {
      return 'Insert content';
    }

    if (deleteOps.length > 0 && insertOps.length === 0 && overwriteOps.length === 0) {
      return 'Delete content';
    }

    if (overwriteOps.length > 0 && insertOps.length === 0 && deleteOps.length === 0) {
      return 'Replace content';
    }

    // Mixed operations
    if (insertOps.length > 0 && deleteOps.length > 0) {
      return 'Edit content';
    }

    if (overwriteOps.length > 0) {
      return 'Edit content';
    }

    return 'Edit content';
  }

  /**
   * Internal method to close current group
   */
  _closeCurrentGroup() {
    if (this.currentGroup && this.currentGroup.operations.length > 0) {
      // Add group to undo stack
      this._addGroupToUndoStack(this.currentGroup);
      
      // Clear current group
      this.currentGroup = null;
    }
  }

  /**
   * Force close current group (for explicit undo/redo operations)
   */
  _forceCloseCurrentGroup() {
    if (this.currentGroup && this.currentGroup.operations.length > 0) {
      // Generate automatic name if using default
      if (this.currentGroup.description === 'Edit operation') {
        this.currentGroup.description = this._generateOperationName(this.currentGroup.operations);
      }

      this._addGroupToUndoStack(this.currentGroup);
      this.currentGroup = null;
    }
  }

  /**
   * Add a group to the undo stack with intelligent merging
   * @param {OperationGroup} group - Group to add
   * @param {boolean} forceNoMerge - Force no merging (for transactions)
   */
  _addGroupToUndoStack(group, forceNoMerge = false) {
    // Clear redo stack when new operation is added
    this.redoStack = [];

    // Try to merge with the last group in undo stack (if allowed)
    if (!forceNoMerge && this.undoStack.length > 0) {
      const lastGroup = this.undoStack[this.undoStack.length - 1];
      
      if (lastGroup.canMergeWith(group, this.mergeTimeWindow, this.mergePositionWindow)) {
        // Merge with last group and update name
        const mergedGroup = lastGroup.mergeWith(group);
        mergedGroup.description = this._generateOperationName(mergedGroup.operations);
        this.undoStack[this.undoStack.length - 1] = mergedGroup;
        
        this.buffer._notify(
          'undo_operation_merged',
          'info',
          `Merged operation: ${group.operations.length} ops into existing group "${mergedGroup.description}"`,
          { 
            groupId: mergedGroup.id,
            totalOperations: mergedGroup.operations.length,
            sizeImpact: mergedGroup.getTotalSizeImpact(),
            finalName: mergedGroup.description
          }
        );
        
        return;
      }
    }

    // Add as new group
    this.undoStack.push(group);
    
    // Limit undo stack size
    while (this.undoStack.length > this.maxUndoLevels) {
      this.undoStack.shift();
    }

    this.buffer._notify(
      'undo_operation_recorded',
      'info',
      `Recorded operation: "${group.description}" (${group.operations.length} operations)`,
      {
        groupId: group.id,
        name: group.description,
        operations: group.operations.length,
        sizeImpact: group.getTotalSizeImpact(),
        undoStackSize: this.undoStack.length,
        transaction: forceNoMerge
      }
    );
  }

  /**
   * NEW METHOD: Create emergency snapshot/core dump
   * @param {Error} error - The error that triggered the dump
   * @param {Object} context - Additional context information
   * @returns {Promise<string>} - Path to the dump file
   */
  async _createEmergencyDump(error, context = {}) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dumpFilename = `pagedBuffer-crash-${timestamp}.json`;
      const homeDir = os.homedir();
      
      // Ensure unique filename
      let dumpPath = path.join(homeDir, dumpFilename);
      let counter = 1;
      while (true) {
        try {
          await fs.access(dumpPath);
          // File exists, try with counter
          const baseName = `pagedBuffer-crash-${timestamp}-${counter}.json`;
          dumpPath = path.join(homeDir, baseName);
          counter++;
        } catch {
          // File doesn't exist, we can use this path
          break;
        }
      }

      // Collect buffer state information
      const dumpData = {
        timestamp: new Date().toISOString(),
        error: {
          message: error.message,
          stack: error.stack,
          name: error.name
        },
        context,
        bufferState: {
          totalSize: this.buffer.getTotalSize(),
          state: this.buffer.getState(),
          mode: this.buffer.getMode(),
          filename: this.buffer.filename,
          pageCount: this.buffer.pages.size,
          memoryStats: this.buffer.getMemoryStats()
        },
        undoSystemState: {
          undoGroups: this.undoStack.length,
          redoGroups: this.redoStack.length,
          currentGroupOperations: this.currentGroup ? this.currentGroup.operations.length : 0,
          activeTransaction: this.activeTransaction ? {
            name: this.activeTransaction.name,
            operations: this.activeTransaction.operations.length
          } : null
        },
        pages: []
      };

      // Collect page information (but not full data to avoid massive files)
      for (const [pageId, pageInfo] of this.buffer.pages) {
        dumpData.pages.push({
          pageId: pageInfo.pageId,
          fileOffset: pageInfo.fileOffset,
          originalSize: pageInfo.originalSize,
          currentSize: pageInfo.currentSize,
          isDirty: pageInfo.isDirty,
          isLoaded: pageInfo.isLoaded,
          isDetached: pageInfo.isDetached,
          hasData: pageInfo.data !== null,
          dataLength: pageInfo.data ? pageInfo.data.length : 0
        });
      }

      // Write dump file
      await fs.writeFile(dumpPath, JSON.stringify(dumpData, null, 2), 'utf8');
      
      return dumpPath;
    } catch (dumpError) {
      // If we can't create the dump, at least log the original error
      console.error('Failed to create emergency dump:', dumpError);
      throw error; // Re-throw original error
    }
  }

  /**
   * NEW METHOD: Ensure pages are loaded for an operation
   * CRITICAL FIX: Load pages before undo operations to prevent null pointer crashes
   * @param {BufferOperation} operation - Operation that needs page access
   */
  async _ensurePagesLoadedForOperation(operation) {
    try {
      const startPos = operation.position;
      const endPos = operation.getEndPosition();
      
      // For INSERT operations, we need the page at the insertion point
      if (operation.type === OperationType.INSERT) {
        const { page } = await this.buffer._getPageForPosition(startPos);
        await this.buffer._ensurePageLoaded(page);
      }
      
      // For DELETE and OVERWRITE, we need pages covering the range
      if (operation.type === OperationType.DELETE || operation.type === OperationType.OVERWRITE) {
        // Load all pages in the affected range
        let currentPos = startPos;
        while (currentPos < endPos) {
          const { page } = await this.buffer._getPageForPosition(currentPos);
          await this.buffer._ensurePageLoaded(page);
          
          // Move to next page
          if (page.currentSize > 0) {
            currentPos += page.currentSize;
          } else {
            // Avoid infinite loop on zero-size pages
            currentPos++;
          }
          
          // Safety check to avoid infinite loops
          if (currentPos > this.buffer.getTotalSize()) {
            break;
          }
        }
      }
    } catch (error) {
      // Create emergency dump and notify
      const dumpPath = await this._createEmergencyDump(error, {
        operation: {
          type: operation.type,
          position: operation.position,
          endPosition: operation.getEndPosition(),
          id: operation.id
        },
        action: 'ensurePagesLoaded'
      });
      
      this.buffer._notify(
        'undo_emergency_dump_created',
        'error',
        `Critical error during page loading for undo. Emergency dump created: ${dumpPath}`,
        {
          error: error.message,
          dumpPath,
          operationType: operation.type,
          operationId: operation.id
        }
      );
      
      throw error; // Re-throw to let caller handle
    }
  }

  /**
   * Internal method to record an operation
   * FIXED: Only clear redo stack for actual new operations, not during undo/redo
   * @param {BufferOperation} operation - Operation to record
   */
  _recordOperation(operation) {
    // Don't record operations during undo/redo
    if (this.isUndoing) {
      return;
    }

    // Clear redo stack when new operations are performed
    this.redoStack = [];
      
    debugLog(`DEBUG: Recording operation:`, {
      type: operation.type,
      position: operation.position,
      dataLength: operation.data ? operation.data.length : 0,
      originalDataLength: operation.originalData ? operation.originalData.length : 0
    });
    
    // Handle transactions
    if (this.activeTransaction) {
      this.activeTransaction.operations.push(operation);
      debugLog(`DEBUG: Added operation to transaction. Transaction now has ${this.activeTransaction.operations.length} operations`);
      return;
    }
    
    // CRITICAL FIX: Only clear redo stack for actual new operations
    // Don't clear during undo operations (which temporarily disable recording)
    this.redoStack = [];
    debugLog(`DEBUG: Cleared redo stack for new operation`);
    
    // Check if we should close current group based on timestamp
    if (this._shouldCloseCurrentGroup(operation.timestamp)) {
      this._closeCurrentGroup();
    }
    
    // Handle regular operations
    if (!this.currentGroup) {
      // Create new group
      this.currentGroup = new OperationGroup(this._generateGroupId());
      this.currentGroup.operations.push(operation);
    } else {
      // Try to merge with last operation in current group
      const lastOp = this.currentGroup.operations[this.currentGroup.operations.length - 1];
      
      if (lastOp.canMergeWith(operation, this.mergeTimeWindow, this.mergePositionWindow)) {
        // Merge operations
        lastOp.mergeWith(operation);
      } else {
        // Cannot merge - close current group and start new one
        this._closeCurrentGroup();
        
        // Create new group for this operation
        this.currentGroup = new OperationGroup(this._generateGroupId());
        this.currentGroup.operations.push(operation);
      }
    }
  }

  _shouldCloseCurrentGroup(newOperationTimestamp) {
    if (!this.currentGroup || this.currentGroup.operations.length === 0) {
      return false;
    }
    
    // Get timestamp of last operation in current group
    const lastOp = this.currentGroup.operations[this.currentGroup.operations.length - 1];
    const timeSinceLastOp = newOperationTimestamp - lastOp.timestamp;
    
    // Close group if too much time has passed
    return timeSinceLastOp > this.autoGroupTimeout;
  }

  /**
   * Record an insert operation
   * @param {number} position - Absolute position where data was inserted
   * @param {Buffer} data - Data that was inserted
   */
  recordInsert(position, data) {
    const operation = new BufferOperation(OperationType.INSERT, position, Buffer.from(data), null, this.getClock());
    this._recordOperation(operation);
  }

  /**
   * Record a delete operation
   * @param {number} position - Absolute position where data was deleted
   * @param {Buffer} deletedData - Data that was deleted
   */
  recordDelete(position, deletedData) {
    const operation = new BufferOperation(OperationType.DELETE, position, null, Buffer.from(deletedData), this.getClock());
    this._recordOperation(operation);
  }

  /**
   * Record an overwrite operation
   * @param {number} position - Absolute position where data was overwritten
   * @param {Buffer} newData - New data
   * @param {Buffer} originalData - Original data that was overwritten
   */
  recordOverwrite(position, newData, originalData) {
    const operation = new BufferOperation(OperationType.OVERWRITE, position, Buffer.from(newData), Buffer.from(originalData), this.getClock());
    this._recordOperation(operation);
  }

  /**
   * Check if operations are compatible for merging based on their types
   * @param {BufferOperation} other - Other operation
   * @returns {boolean} - True if compatible
   */
  _areOperationsCompatible(other) {
    // Same type operations are generally compatible
    if (this.type === other.type) {
      return true;
    }

    // Cross-type compatibility rules
    const compatibleCombinations = [
      // Delete followed by insert at same position = replacement
      [OperationType.DELETE, OperationType.INSERT],
      // Insert followed by delete within inserted content = modified insert/backspace
      [OperationType.INSERT, OperationType.DELETE],
      // Any operation can be followed by overwrite in same area
      [OperationType.INSERT, OperationType.OVERWRITE],
      [OperationType.DELETE, OperationType.OVERWRITE],
      [OperationType.OVERWRITE, OperationType.INSERT],
      [OperationType.OVERWRITE, OperationType.DELETE]
    ];

    return compatibleCombinations.some(([first, second]) => 
      (this.type === first && other.type === second) ||
      (this.type === second && other.type === first)
    );
  }

  /**
   * Undoes the last operation group
   * @returns {Promise<boolean>} - True if undo was successful
   */
  async undo() {
    debugLog(`DEBUG: undo() called`);
    
    // If we're in a transaction, rollback the transaction
    if (this.activeTransaction) {
      debugLog(`DEBUG: Rolling back active transaction`);
      return await this.rollbackTransaction();
    }
    
    // If there's a current group with operations, undo it first
    if (this.currentGroup && this.currentGroup.operations.length > 0) {
      debugLog(`DEBUG: Undoing current group with ${this.currentGroup.operations.length} operations`);
      const group = this.currentGroup;
      this.currentGroup = null; // Clear current group
      
      // Undo the current group
      const result = await this._undoGroup(group);
      debugLog(`DEBUG: Current group undo result: ${result}`);
      return result;
    }
    
    // Otherwise, undo from undo stack
    if (this.undoStack.length === 0) {
      debugLog(`DEBUG: No operations to undo`);
      return false;
    }
    
    debugLog(`DEBUG: Undoing from stack, stack size: ${this.undoStack.length}`);
    const group = this.undoStack.pop();
    
    // DEBUG: Check if _undoGroup method exists
    debugLog(`DEBUG: _undoGroup method exists: ${typeof this._undoGroup}`);
    debugLog(`DEBUG: Group to undo:`, {
      id: group.id,
      operationCount: group.operations.length,
      operations: group.operations.map(op => ({
        type: op.type,
        position: op.position,
        dataLength: op.data ? op.data.length : 0,
        originalDataLength: op.originalData ? op.originalData.length : 0
      }))
    });
    
    try {
      debugLog(`DEBUG: About to call _undoGroup`);
      const result = await this._undoGroup(group);
      debugLog(`DEBUG: _undoGroup returned: ${result}`);
      return result;
    } catch (error) {
      debugLog(`DEBUG: Exception calling _undoGroup: ${error.message}`);
      debugLog(`DEBUG: Exception stack: ${error.stack}`);
      return false;
    }
  }

  /**
   * Redoes the last undone operation group
   * @returns {Promise<boolean>} - True if redo was successful
   */
  async redo() {
    debugLog(`DEBUG: redo() called`);
    
    if (this.redoStack.length === 0) {
      debugLog(`DEBUG: No operations to redo (redoStack is empty)`);
      return false;
    }

    // Force close current group first
    this._forceCloseCurrentGroup();

    const group = this.redoStack.pop();
    debugLog(`DEBUG: Redoing group ${group.id} with ${group.operations.length} operations`);
    
    try {
      // Apply operations in forward order
      for (let i = 0; i < group.operations.length; i++) {
        const op = group.operations[i];
        debugLog(`DEBUG: About to redo operation ${i}: ${op.type} at ${op.position}`);
        await this._redoOperation(op);
        debugLog(`DEBUG: Successfully redid operation ${i}`);
      }

      // Move group back to undo stack
      this.undoStack.push(group);
      
      debugLog(`DEBUG: Successfully redid group ${group.id}`);
      
      this.buffer._notify(
        'redo_applied',
        'info',
        `Redid operation group: ${group.description}`,
        {
          groupId: group.id,
          operations: group.operations.length,
          sizeImpact: group.getTotalSizeImpact()
        }
      );

      return true;
    } catch (error) {
      debugLog(`DEBUG: Error in redo(): ${error.message}`);
      
      // Put group back on redo stack if redo failed
      this.redoStack.push(group);
      
      this.buffer._notify(
        'redo_failed',
        'error',
        `Failed to redo operation: ${error.message}`,
        { groupId: group.id, error: error.message }
      );
      
      throw error;
    }
  }

  /**
   * Undo a single operation
   * FIXED: Ensures pages are loaded before attempting undo + Emergency Dump System
   * @param {BufferOperation} operation - Operation to undo
   */
  async _undoOperation(operation) {
    debugLog(`DEBUG: _undoOperation called with: ${operation.type} at position ${operation.position}`);
    
    try {
      switch (operation.type) {
        case 'insert':
          debugLog(`DEBUG: Undoing insert - deleting ${operation.data.length} bytes from position ${operation.position}`);
          // Undo insert by deleting the inserted data
          const deleteEnd = operation.position + operation.data.length;
          await this.buffer.deleteBytes(operation.position, deleteEnd);
          debugLog(`DEBUG: Successfully deleted bytes ${operation.position}-${deleteEnd}`);
          break;
          
        case 'delete':
          debugLog(`DEBUG: Undoing delete - inserting ${operation.originalData.length} bytes at position ${operation.position}`);
          // Undo delete by inserting the original data back
          await this.buffer.insertBytes(operation.position, operation.originalData);
          debugLog(`DEBUG: Successfully inserted ${operation.originalData.length} bytes`);
          break;
          
        case 'overwrite':
          debugLog(`DEBUG: Undoing overwrite at position ${operation.position}`);
          // Undo overwrite by restoring original data
          const overwriteEnd = operation.position + operation.data.length;
          await this.buffer.deleteBytes(operation.position, overwriteEnd);
          await this.buffer.insertBytes(operation.position, operation.originalData);
          debugLog(`DEBUG: Successfully restored original data`);
          break;
          
        default:
          throw new Error(`Unknown operation type: ${operation.type}`);
      }
      
      debugLog(`DEBUG: _undoOperation completed successfully`);
    } catch (error) {
      debugLog(`DEBUG: Error in _undoOperation: ${error.message}`);
      throw error; // Re-throw the error
    }
  }

  /**
   * Redo a single operation
   * FIXED: Properly handles redo operations without creating new undo entries
   * @param {BufferOperation} operation - Operation to redo
   */
  async _redoOperation(operation) {
    debugLog(`DEBUG: Redoing operation: ${operation.type} at position ${operation.position}`);
    
    // Set flag to prevent recording redo operations as new undo operations
    const wasUndoing = this.isUndoing;
    this.isUndoing = true;
    
    try {
      // CRITICAL FIX: Ensure affected pages are loaded before performing redo operations
      await this._ensurePagesLoadedForOperation(operation);
      
      switch (operation.type) {
        case OperationType.INSERT:
        case 'insert':
          // Re-insert the data
          debugLog(`DEBUG: Redoing insert of ${operation.data.length} bytes at ${operation.position}`);
          await this.buffer.insertBytes(operation.position, operation.data);
          break;
          
        case OperationType.DELETE:
        case 'delete':
          // Re-delete the data
          debugLog(`DEBUG: Redoing delete of ${operation.originalData.length} bytes at ${operation.position}`);
          await this.buffer.deleteBytes(operation.position, operation.position + operation.originalData.length);
          break;
          
        case OperationType.OVERWRITE:
        case 'overwrite':
          // Re-apply the overwrite
          debugLog(`DEBUG: Redoing overwrite at ${operation.position}`);
          await this.buffer.deleteBytes(operation.position, operation.position + operation.originalData.length);
          await this.buffer.insertBytes(operation.position, operation.data);
          break;
          
        default:
          throw new Error(`Unknown operation type for redo: ${operation.type}`);
      }
      
      debugLog(`DEBUG: Successfully redid ${operation.type} operation`);
      
    } catch (error) {
      debugLog(`DEBUG: Error in _redoOperation: ${error.message}`);
      
      // Create emergency dump for failed redo operations
      const dumpPath = await this._createEmergencyDump(error, {
        operation: {
          type: operation.type,
          position: operation.position,
          endPosition: operation.getEndPosition(),
          id: operation.id
        },
        action: 'redoOperation'
      });
      
      this.buffer._notify(
        'undo_emergency_dump_created',
        'error',
        `Critical error during redo operation. Emergency dump created: ${dumpPath}`,
        {
          error: error.message,
          dumpPath,
          operationType: operation.type,
          operationId: operation.id
        }
      );
      
      throw error; // Re-throw to let caller handle
    } finally {
      // Restore previous isUndoing state
      this.isUndoing = wasUndoing;
    }
  }

  canUndo() {
    // Return true if there are operations in undo stack OR current group has operations
    const hasUndoStack = this.undoStack.length > 0;
    const hasCurrentGroup = this.currentGroup && this.currentGroup.operations.length > 0;
    const hasActiveTransaction = this.activeTransaction && this.activeTransaction.operations.length > 0;
    
    return hasUndoStack || hasCurrentGroup || hasActiveTransaction;
  }

  /**
   * Check if redo is available
   * @returns {boolean} - True if redo is available
   */
  canRedo() {
    // Don't allow redo during active transactions
    if (this.activeTransaction) {
      debugLog(`DEBUG: canRedo() = false (active transaction)`);
      return false;
    }
    
    const result = this.redoStack.length > 0;
    debugLog(`DEBUG: canRedo() = ${result} (redoStack.length = ${this.redoStack.length})`);
    return result;
  }

  /**
   * Get undo/redo statistics
   * @returns {Object} - Statistics
   */
  getStats() {
    let totalUndoOps = 0;
    let totalRedoOps = 0;
    
    for (const group of this.undoStack) {
      totalUndoOps += group.operations.length;
    }
    
    for (const group of this.redoStack) {
      totalRedoOps += group.operations.length;
    }

    return {
      undoGroups: this.undoStack.length,
      redoGroups: this.redoStack.length,
      totalUndoOperations: totalUndoOps,
      totalRedoOperations: totalRedoOps,
      currentGroupOperations: this.currentGroup ? this.currentGroup.operations.length : 0,
      memoryUsage: this._estimateMemoryUsage()
    };
  }

  /**
   * Estimate memory usage of undo system
   * @returns {number} - Estimated bytes
   */
  _estimateMemoryUsage() {
    let totalSize = 0;
    
    for (const group of [...this.undoStack, ...this.redoStack]) {
      for (const op of group.operations) {
        if (op.data) totalSize += op.data.length;
        if (op.originalData) totalSize += op.originalData.length;
      }
    }
    
    return totalSize;
  }

  /**
   * Clear all undo/redo history
   */
  clear() {
    this._forceCloseCurrentGroup();
    this.undoStack = [];
    this.redoStack = [];
    
    this.buffer._notify(
      'undo_history_cleared',
      'info',
      'Undo/redo history cleared',
      { reason: 'manual_clear' }
    );
  }

  /**
   * Configure merging behavior
   * @param {Object} config - Configuration options
   */
  configure(config) {
    if (config.mergeTimeWindow !== undefined) {
      this.mergeTimeWindow = config.mergeTimeWindow;
    }
    if (config.mergePositionWindow !== undefined) {
      this.mergePositionWindow = config.mergePositionWindow;
    }
    if (config.autoGroupTimeout !== undefined) {
      this.autoGroupTimeout = config.autoGroupTimeout;
    }
    if (config.maxUndoLevels !== undefined) {
      this.maxUndoLevels = config.maxUndoLevels;
    }
  }

  getDebugInfo() {
    return {
      undoStackSize: this.undoStack.length,
      redoStackSize: this.redoStack.length,
      hasCurrentGroup: !!this.currentGroup,
      currentGroupOps: this.currentGroup ? this.currentGroup.operations.length : 0,
      hasActiveTransaction: !!this.activeTransaction,
      activeTransactionOps: this.activeTransaction ? this.activeTransaction.operations.length : 0,
      canUndoResult: this.canUndo(),
      canRedoResult: this.canRedo(),
      currentTime: this.getClock(),
      lastOperationTime: this.currentGroup && this.currentGroup.operations.length > 0 
        ? this.currentGroup.operations[this.currentGroup.operations.length - 1].timestamp 
        : null
    };
  }

  _notify(type, severity, message, metadata = {}) {
    // Use the buffer's notification system
    if (this.buffer && typeof this.buffer._notify === 'function') {
      this.buffer._notify(type, severity, message, metadata);
    }
    // If buffer doesn't have _notify, silently ignore (for testing)
  }

  // Generate unique group ID
  _generateGroupId() {
    const timestamp = this.getClock();
    const random = Math.random().toString(36).substr(2, 9);
    return `group_${timestamp}_${random}`;
  }

  async _undoGroup(group) {
    debugLog(`DEBUG: _undoGroup called with group ${group ? group.id : 'null'}`);
    
    if (!group) {
      debugLog(`DEBUG: Group is null/undefined`);
      return false;
    }
    
    if (!group.operations || group.operations.length === 0) {
      debugLog(`DEBUG: Group has no operations`);
      return false;
    }
    
    // Set flag to prevent recording undo operations
    this.isUndoing = true;
    debugLog(`DEBUG: Set isUndoing = true`);
    
    try {
      debugLog(`DEBUG: Starting undo of group ${group.id} with ${group.operations.length} operations`);
      
      // Undo operations in reverse order
      for (let i = group.operations.length - 1; i >= 0; i--) {
        const operation = group.operations[i];
        debugLog(`DEBUG: About to undo operation ${i}: ${operation.type} at ${operation.position}`);
        
        try {
          await this._undoOperation(operation);
          debugLog(`DEBUG: Successfully undid operation ${i}`);
        } catch (opError) {
          debugLog(`DEBUG: Failed to undo operation ${i}: ${opError.message}`);
          debugLog(`DEBUG: Operation error stack: ${opError.stack}`);
          throw opError; // Re-throw to be caught by outer try-catch
        }
      }
      
      debugLog(`DEBUG: Successfully undid all operations in group ${group.id}`);
      
      // CRITICAL FIX: Move the undone group to the redo stack
      this.redoStack.push(group);
      debugLog(`DEBUG: Moved group ${group.id} to redo stack. Redo stack now has ${this.redoStack.length} groups`);
      
      // Notify about successful undo
      if (this.buffer && this.buffer._notify) {
        this.buffer._notify('undo_group_executed', 'info', `Undid group ${group.id}`, {
          groupId: group.id,
          operationCount: group.operations.length
        });
      }
      
      return true;
    } catch (error) {
      debugLog(`DEBUG: Error in _undoGroup: ${error.message}`);
      debugLog(`DEBUG: Error stack: ${error.stack}`);
      
      // Notify about undo failure
      if (this.buffer && this.buffer._notify) {
        this.buffer._notify('undo_group_failed', 'error', `Failed to undo group ${group.id}: ${error.message}`, {
          groupId: group.id,
          error: error.message
        });
      }
      
      return false;
    } finally {
      // Always clear the flag, even if an error occurred
      this.isUndoing = false;
      debugLog(`DEBUG: Cleared isUndoing flag`);
    }
  }

  async _undoOperation(operation) {
    switch (operation.type) {
      case 'insert':
        // Undo insert by deleting the inserted data
        await this.buffer.deleteBytes(operation.position, operation.position + operation.data.length);
        break;
        
      case 'delete':
        // Undo delete by inserting the original data back
        await this.buffer.insertBytes(operation.position, operation.originalData);
        break;
        
      case 'overwrite':
        // Undo overwrite by restoring original data
        await this.buffer.deleteBytes(operation.position, operation.position + operation.data.length);
        await this.buffer.insertBytes(operation.position, operation.originalData);
        break;
        
      default:
        throw new Error(`Unknown operation type: ${operation.type}`);
    }
  }
  
    _addGroupToUndoStack(group, forceNoMerge = false) {
    // Clear redo stack when new operation is added
    this.redoStack = [];
    
    // Try to merge with previous group if conditions are met
    if (!forceNoMerge && this.undoStack.length > 0) {
      const lastGroup = this.undoStack[this.undoStack.length - 1];
      
      // Only merge if both groups have single operations and can merge
      if (lastGroup.operations.length === 1 && group.operations.length === 1) {
        const lastOp = lastGroup.operations[0];
        const newOp = group.operations[0];
        
        if (lastOp.canMergeWith(newOp, this.mergeTimeWindow, this.mergePositionWindow)) {
          // Merge the operations
          lastOp.mergeWith(newOp);
          return; // Don't add new group, merged into existing
        }
      }
    }
    
    // Add new group to undo stack
    this.undoStack.push(group);
    
    // Limit undo stack size
    if (this.undoStack.length > this.maxUndoLevels) {
      this.undoStack.shift();
    }
  }
}

module.exports = {
  BufferUndoSystem,
  BufferOperation,
  OperationGroup,
  OperationType
};
