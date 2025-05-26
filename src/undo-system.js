/**
 * Undo/Redo System for PagedBuffer with transaction support
 */

/**
 * Operation types for undo/redo tracking
 */
const OperationType = {
  INSERT: 'insert',
  DELETE: 'delete',
  OVERWRITE: 'overwrite'
};

/**
 * Represents a single atomic operation that can be undone/redone
 */
class BufferOperation {
  constructor(type, position, data = null, originalData = null) {
    this.type = type;
    this.position = position; // Absolute byte position
    this.data = data; // Data that was inserted/used for overwrite
    this.originalData = originalData; // Data that was deleted/overwritten
    this.timestamp = Date.now();
    this.id = `op_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
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
   * @param {BufferOperation} other - Other operation
   * @returns {number} - Logical distance (0 = adjacent/overlapping)
   */
  getLogicalDistance(other) {
    const thisStart = this.position;
    const thisEnd = this.getEndPosition();
    const otherStart = other.position;
    const otherEnd = other.getEndPosition();

    // For same-type operations, calculate based on natural flow
    if (this.type === other.type) {
      switch (this.type) {
        case OperationType.INSERT:
          // Insert operations are adjacent if one starts where the other ends
          if (otherStart === thisEnd) return 0;  // Other inserts right after this
          if (thisStart === otherEnd) return 0;  // This inserts right after other
          // Otherwise, minimum distance between ranges
          return Math.min(
            Math.abs(thisStart - otherEnd),
            Math.abs(otherStart - thisEnd)
          );
        
        case OperationType.DELETE:
          // Delete operations are adjacent if they're at the same position or consecutive
          if (thisStart === otherStart) return 0;  // Same deletion point
          if (thisEnd === otherStart) return 0;    // Consecutive deletions (forward)
          if (otherEnd === thisStart) return 0;    // Consecutive deletions (backward)
          // For deletes, consider they might be deleting from same area
          return Math.min(
            Math.abs(thisStart - otherStart),
            Math.abs(thisStart - otherEnd),
            Math.abs(thisEnd - otherStart)
          );
        
        case OperationType.OVERWRITE:
          // Overwrite operations are adjacent if they overlap or touch
          if (thisEnd >= otherStart && thisStart <= otherEnd) return 0; // Overlapping
          return Math.min(
            Math.abs(thisEnd - otherStart),
            Math.abs(otherEnd - thisStart)
          );
      }
    }

    // For different operation types, check logical relationships
    if (this.type === OperationType.INSERT && other.type === OperationType.DELETE) {
      // Insert followed by delete - check if delete is within or adjacent to insert
      if (otherStart >= thisStart && otherStart <= thisEnd) return 0; // Delete within insert
      if (otherStart === thisEnd) return 0; // Delete right after insert
      return Math.abs(otherStart - thisEnd);
    }

    if (this.type === OperationType.DELETE && other.type === OperationType.INSERT) {
      // Delete followed by insert - check if insert is at delete point
      if (otherStart === thisStart) return 0; // Insert at delete point
      return Math.abs(otherStart - thisStart);
    }

    if (this.type === OperationType.INSERT && other.type === OperationType.OVERWRITE) {
      // Insert followed by overwrite
      if (otherStart >= thisStart && otherStart <= thisEnd) return 0; // Overwrite within insert
      return Math.min(
        Math.abs(otherStart - thisEnd),
        Math.abs(otherEnd - thisStart)
      );
    }

    if (this.type === OperationType.DELETE && other.type === OperationType.OVERWRITE) {
      // Delete followed by overwrite
      if (otherStart === thisStart) return 0; // Overwrite at delete point
      return Math.abs(otherStart - thisStart);
    }

    if (this.type === OperationType.OVERWRITE && other.type === OperationType.INSERT) {
      // Overwrite followed by insert
      if (otherStart >= thisStart && otherStart <= thisEnd) return 0; // Insert within overwrite
      if (otherStart === thisEnd) return 0; // Insert right after overwrite
      return Math.abs(otherStart - thisEnd);
    }

    if (this.type === OperationType.OVERWRITE && other.type === OperationType.DELETE) {
      // Overwrite followed by delete
      if (otherStart >= thisStart && otherStart <= thisEnd) return 0; // Delete within overwrite
      return Math.min(
        Math.abs(otherStart - thisStart),
        Math.abs(otherStart - thisEnd)
      );
    }

    // Fallback: minimum distance between operation ranges
    return Math.min(
      Math.abs(thisStart - otherEnd),
      Math.abs(otherStart - thisEnd),
      Math.abs(thisStart - otherStart)
    );
  }

  /**
   * Check if this operation can be merged with another
   * @param {BufferOperation} other - Other operation
   * @param {number} timeWindow - Time window for merging (ms)
   * @param {number} positionWindow - Position window for merging (bytes)
   * @returns {boolean} - True if mergeable
   */
  canMergeWith(other, timeWindow = 15000, positionWindow = 1000) {
    // Check time window
    if (Math.abs(this.timestamp - other.timestamp) > timeWindow) {
      return false;
    }

    // Use logical distance instead of simple position comparison
    const logicalDistance = this.getLogicalDistance(other);
    
    // Operations are mergeable if they're logically adjacent (distance 0) 
    // or within the position window
    if (logicalDistance <= positionWindow) {
      return this._areOperationsCompatible(other);
    }

    return false;
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
   * Merge another operation into this one
   * @param {BufferOperation} other - Operation to merge
   * @returns {BufferOperation} - New merged operation
   */
  mergeWith(other) {
    if (!this.canMergeWith(other)) {
      throw new Error('Operations cannot be merged');
    }

    const merged = new BufferOperation(this.type, this.position);
    merged.timestamp = Math.min(this.timestamp, other.timestamp);
    merged.id = `merged_${this.id}_${other.id}`;

    // Handle different merge scenarios
    if (this.type === OperationType.DELETE && other.type === OperationType.INSERT) {
      // Delete + Insert = Overwrite
      merged.type = OperationType.OVERWRITE;
      merged.originalData = this.originalData;
      merged.data = other.data;
    } else if (this.type === OperationType.INSERT && other.type === OperationType.DELETE) {
      // Insert + Delete = modified Insert or Delete
      if (other.position === this.getEndPosition()) {
        // Backspace after insert - reduce the insert
        const remainingData = this.data.subarray(0, this.data.length - other.originalData.length);
        if (remainingData.length > 0) {
          merged.type = OperationType.INSERT;
          merged.data = remainingData;
        } else {
          // Completely cancelled out
          return null;
        }
      }
    } else if (this.type === other.type) {
      // Same operation types
      switch (this.type) {
        case OperationType.INSERT:
          merged.position = Math.min(this.position, other.position);
          if (other.position === this.getEndPosition()) {
            // Append to our insert
            merged.data = Buffer.concat([this.data, other.data]);
          } else if (this.position === other.getEndPosition()) {
            // Prepend to our insert
            merged.data = Buffer.concat([other.data, this.data]);
          } else {
            // Non-adjacent inserts - keep separate for now
            throw new Error('Non-adjacent inserts cannot be merged');
          }
          break;
          
        case OperationType.DELETE:
          merged.position = Math.min(this.position, other.position);
          // Combine deleted data
          if (this.position <= other.position) {
            merged.originalData = Buffer.concat([this.originalData, other.originalData]);
          } else {
            merged.originalData = Buffer.concat([other.originalData, this.originalData]);
          }
          break;
          
        case OperationType.OVERWRITE:
          // Merge overlapping overwrites
          const startPos = Math.min(this.position, other.position);
          const endPos = Math.max(this.getEndPosition(), other.getEndPosition());
          merged.position = startPos;
          
          // This is complex - for now, keep the later operation
          if (other.timestamp >= this.timestamp) {
            merged.data = other.data;
            merged.originalData = this.originalData; // Keep original original data
          } else {
            merged.data = this.data;
            merged.originalData = other.originalData;
          }
          break;
      }
    }

    return merged;
  }
}

/**
 * Represents a group of operations that form a logical unit
 */
class OperationGroup {
  constructor(description = 'Edit operation') {
    this.operations = [];
    this.description = description;
    this.timestamp = Date.now();
    this.id = `group_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
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
    // Check time window
    if (Math.abs(this.timestamp - other.timestamp) > timeWindow) {
      return false;
    }

    // Check logical proximity using operation endpoints
    const logicalDistance = this._calculateLogicalDistance(other);
    return logicalDistance <= positionWindow;
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
 */
class BufferUndoSystem {
  constructor(pagedBuffer, maxUndoLevels = 1000) {
    this.buffer = pagedBuffer;
    this.maxUndoLevels = maxUndoLevels;
    
    // Undo/redo stacks
    this.undoStack = []; // Array of OperationGroup
    this.redoStack = []; // Array of OperationGroup
    
    // Current operation tracking
    this.currentGroup = null;
    this.lastOperationTime = 0;
    
    // Configuration
    this.mergeTimeWindow = 15000; // 15 seconds
    this.mergePositionWindow = 1000; // 1000 bytes
    this.autoGroupTimeout = 2000; // 2 seconds to auto-close group
    
    // Auto-close timer
    this.autoCloseTimer = null;
    
    // Transaction system
    this.activeTransaction = null;
    this.transactionStack = []; // Support nested transactions
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
      startTime: Date.now(),
      operations: [],
      options: {
        allowMerging: options.allowMerging || false, // Allow merging within transaction
        autoCommit: options.autoCommit !== false,    // Auto-commit on next non-transaction operation
        ...options
      },
      id: `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
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
      this.buffer._notify(
        'undo_transaction_error',
        'warning',
        'No active transaction to commit',
        {}
      );
      return false;
    }

    const transaction = this.activeTransaction;
    const operationName = finalName || transaction.name;

    if (transaction.operations.length === 0) {
      // Empty transaction - just clean up
      this._cleanupTransaction();
      return true;
    }

    // Create operation group from transaction
    const group = new OperationGroup(operationName);
    group.operations = [...transaction.operations];
    group.timestamp = transaction.startTime;
    group.id = `group_from_${transaction.id}`;

    // Add to undo stack (transactions never merge with previous operations)
    this._addGroupToUndoStack(group, true); // true = force no merge

    this.buffer._notify(
      'undo_transaction_committed',
      'info',
      `Committed transaction: ${operationName} (${transaction.operations.length} operations)`,
      {
        transactionId: transaction.id,
        name: operationName,
        operations: transaction.operations.length,
        sizeImpact: group.getTotalSizeImpact()
      }
    );

    this._cleanupTransaction();
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
    if (this.activeTransaction) {
      return; // Don't close groups during transactions
    }

    if (this.currentGroup && this.currentGroup.operations.length > 0) {
      // Generate automatic name if using default
      if (this.currentGroup.description === 'Edit operation') {
        this.currentGroup.description = this._generateOperationName(this.currentGroup.operations);
      }

      this._addGroupToUndoStack(this.currentGroup);
      this.currentGroup = null;
    }
    
    if (this.autoCloseTimer) {
      clearTimeout(this.autoCloseTimer);
      this.autoCloseTimer = null;
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
   * Internal method to record an operation
   * @param {BufferOperation} operation - Operation to record
   * @param {string} defaultDescription - Default group description
   */
  _recordOperation(operation, defaultDescription) {
    // If in transaction, add to transaction
    if (this.activeTransaction) {
      // Try to merge with last operation in transaction if allowed
      if (this.activeTransaction.options.allowMerging && 
          this.activeTransaction.operations.length > 0) {
        const lastOp = this.activeTransaction.operations[this.activeTransaction.operations.length - 1];
        
        if (lastOp.canMergeWith(operation, this.mergeTimeWindow, this.mergePositionWindow)) {
          const mergedOp = lastOp.mergeWith(operation);
          
          if (mergedOp) {
            this.activeTransaction.operations[this.activeTransaction.operations.length - 1] = mergedOp;
          } else {
            // Operations cancelled each other out
            this.activeTransaction.operations.pop();
          }
          return;
        }
      }

      // Add to transaction
      this.activeTransaction.operations.push(operation);
      return;
    }

    // Not in transaction - use normal group management
    // Auto-start group if none exists
    if (!this.currentGroup) {
      this.currentGroup = new OperationGroup(defaultDescription);
    }

    // Try to merge with last operation in current group
    if (this.currentGroup.operations.length > 0) {
      const lastOp = this.currentGroup.operations[this.currentGroup.operations.length - 1];
      
      if (lastOp.canMergeWith(operation, this.mergeTimeWindow, this.mergePositionWindow)) {
        const mergedOp = lastOp.mergeWith(operation);
        
        if (mergedOp) {
          // Replace last operation with merged one
          this.currentGroup.operations[this.currentGroup.operations.length - 1] = mergedOp;
        } else {
          // Operations cancelled each other out
          this.currentGroup.operations.pop();
        }
        
        this._resetAutoCloseTimer();
        return;
      }
    }

    // Add as new operation
    this.currentGroup.addOperation(operation);
    this.lastOperationTime = Date.now();
    
    this._resetAutoCloseTimer();
  }

  /**
   * Reset the auto-close timer
   */
  _resetAutoCloseTimer() {
    if (this.autoCloseTimer) {
      clearTimeout(this.autoCloseTimer);
    }
    
    this.autoCloseTimer = setTimeout(() => {
      this._closeCurrentGroup();
    }, this.autoGroupTimeout);
  }

  /**
   * Record an insert operation
   * @param {number} position - Absolute position where data was inserted
   * @param {Buffer} data - Data that was inserted
   */
  recordInsert(position, data) {
    const operation = new BufferOperation(OperationType.INSERT, position, Buffer.from(data));
    this._recordOperation(operation, 'Insert text');
  }

  /**
   * Record a delete operation
   * @param {number} position - Absolute position where data was deleted
   * @param {Buffer} deletedData - Data that was deleted
   */
  recordDelete(position, deletedData) {
    const operation = new BufferOperation(OperationType.DELETE, position, null, Buffer.from(deletedData));
    this._recordOperation(operation, 'Delete text');
  }

  /**
   * Record an overwrite operation
   * @param {number} position - Absolute position where data was overwritten
   * @param {Buffer} newData - New data
   * @param {Buffer} originalData - Original data that was overwritten
   */
  recordOverwrite(position, newData, originalData) {
    const operation = new BufferOperation(OperationType.OVERWRITE, position, newData, originalData);
    this._recordOperation(operation, 'Overwrite text');
  }

  /**
   * Undoes the last operation group
   * @returns {Promise<boolean>} - True if undo was successful
   */
  async undo() {
    if (this.undoStack.length === 0) return false;

    // Close current group first
    this._closeCurrentGroup();

    const group = this.undoStack.pop();
    
    try {
      // Apply operations in reverse order
      for (let i = group.operations.length - 1; i >= 0; i--) {
        const op = group.operations[i];
        await this._undoOperation(op);
      }

      // Move group to redo stack
      this.redoStack.push(group);
      
      this.buffer._notify(
        'undo_applied',
        'info',
        `Undid operation group: ${group.description}`,
        {
          groupId: group.id,
          operations: group.operations.length,
          sizeImpact: -group.getTotalSizeImpact()
        }
      );

      return true;
    } catch (error) {
      // Put group back on undo stack if undo failed
      this.undoStack.push(group);
      
      this.buffer._notify(
        'undo_failed',
        'error',
        `Failed to undo operation: ${error.message}`,
        { groupId: group.id, error: error.message }
      );
      
      throw error;
    }
  }

  /**
   * Redoes the last undone operation group
   * @returns {Promise<boolean>} - True if redo was successful
   */
  async redo() {
    if (this.redoStack.length === 0) return false;

    // Close current group first
    this._closeCurrentGroup();

    const group = this.redoStack.pop();
    
    try {
      // Apply operations in forward order
      for (const op of group.operations) {
        await this._redoOperation(op);
      }

      // Move group back to undo stack
      this.undoStack.push(group);
      
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
   * @param {BufferOperation} operation - Operation to undo
   */
  async _undoOperation(operation) {
    switch (operation.type) {
      case OperationType.INSERT:
        // Remove the inserted data - make sure positions are correct
        await this.buffer.deleteBytes(operation.position, operation.getEndPosition());
        break;
        
      case OperationType.DELETE:
        // Re-insert the deleted data at exact original position
        await this.buffer.insertBytes(operation.position, operation.originalData);
        break;
        
      case OperationType.OVERWRITE:
        // First delete new content, then restore original
        await this.buffer.deleteBytes(operation.position, operation.getEndPosition());
        await this.buffer.insertBytes(operation.position, operation.originalData);
        break;
    }
  }

  /**
   * Redo a single operation
   * @param {BufferOperation} operation - Operation to redo
   */
  async _redoOperation(operation) {
    switch (operation.type) {
      case OperationType.INSERT:
        // Re-insert the data
        await this.buffer.insertBytes(operation.position, operation.data);
        break;
        
      case OperationType.DELETE:
        // Re-delete the data
        await this.buffer.deleteBytes(operation.position, operation.position + operation.originalData.length);
        break;
        
      case OperationType.OVERWRITE:
        // Re-apply the overwrite
        await this.buffer.deleteBytes(operation.position, operation.position + operation.originalData.length);
        await this.buffer.insertBytes(operation.position, operation.data);
        break;
    }
  }

  /**
   * Check if undo is available
   * @returns {boolean} - True if undo is available
   */
  canUndo() {
    return this.undoStack.length > 0 || (this.currentGroup && this.currentGroup.operations.length > 0);
  }

  /**
   * Check if redo is available
   * @returns {boolean} - True if redo is available
   */
  canRedo() {
    return this.redoStack.length > 0;
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
    this._closeCurrentGroup();
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
}

module.exports = {
  BufferUndoSystem,
  BufferOperation,
  OperationGroup,
  OperationType
};
