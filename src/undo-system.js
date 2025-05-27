/**
 * @fileoverview Buffer Undo/Redo System with operation merging - FIXED VERSION
 * @author Jeffrey R. Day
 * @version 1.0.0
 */

const { BufferOperation, OperationType } = require('./buffer-operation');
const { BufferState } = require('./types/buffer-types');

/**
 * Groups related operations together for undo/redo
 */
class OperationGroup {
  constructor(id, name = null) {
    this.id = id;
    this.name = name;
    this.operations = [];
    this.timestamp = Date.now();
    this.isFromTransaction = false; // Flag to track transaction groups
  }

  /**
   * Calculate total memory usage of this group
   * @returns {number} - Estimated memory usage in bytes
   */
  getMemoryUsage() {
    let total = 0;
    for (const op of this.operations) {
      if (op.data) total += op.data.length;
      if (op.originalData) total += op.originalData.length;
    }
    return total;
  }
}

/**
 * Transaction for grouping operations
 */
class OperationTransaction {
  constructor(name, options = {}) {
    this.name = name;
    this.operations = [];
    this.startTime = Date.now();
    this.options = options;
  }

  /**
   * Get info about this transaction
   * @returns {Object} - Transaction info
   */
  getInfo() {
    return {
      name: this.name,
      operationCount: this.operations.length,
      startTime: this.startTime,
      duration: Date.now() - this.startTime,
      options: this.options
    };
  }
}

/**
 * Buffer Undo/Redo System with intelligent operation merging - FIXED
 */
class BufferUndoSystem {
  constructor(buffer, maxUndoLevels = 50) {
    this.buffer = buffer;
    this.maxUndoLevels = maxUndoLevels;
    
    // Undo/Redo stacks - contain only OperationGroup objects
    this.undoStack = [];
    this.redoStack = [];
    
    // Transaction support
    this.activeTransaction = null;
    
    // Configuration
    this.mergeTimeWindow = 5000; // 5 seconds
    this.mergePositionWindow = 1000; // 1000 byte distance
    
    // State tracking
    this.isUndoing = false;
    this.groupIdCounter = 0;
    
    // Clock function (can be mocked for testing)
    this.clockFunction = () => Date.now();
  }

  /**
   * Configure the undo system
   * @param {Object} config - Configuration options
   */
  configure(config) {
    if (config.maxUndoLevels !== undefined) {
      this.maxUndoLevels = config.maxUndoLevels;
    }
    if (config.mergeTimeWindow !== undefined) {
      this.mergeTimeWindow = config.mergeTimeWindow;
    }
    if (config.mergePositionWindow !== undefined) {
      this.mergePositionWindow = config.mergePositionWindow;
    }
  }

  /**
   * Set custom clock function (for testing)
   * @param {Function} clockFn - Function that returns current time
   */
  setClock(clockFn) {
    this.clockFunction = clockFn;
  }

  /**
   * Get current time from clock function
   * @returns {number} - Current timestamp
   */
  getClock() {
    return this.clockFunction();
  }

  /**
   * Generate unique group ID
   * @returns {string} - Unique group ID
   */
  _generateGroupId() {
    return `group_${++this.groupIdCounter}_${this.getClock()}`;
  }

  /**
   * Record an insert operation
   * @param {number} position - Insert position
   * @param {Buffer} data - Inserted data
   * @param {number} timestamp - Optional timestamp (defaults to current time)
   * @returns {BufferOperation} - The created operation
   */
  recordInsert(position, data, timestamp = null) {
    const operation = new BufferOperation(
      OperationType.INSERT, 
      position, 
      Buffer.from(data), 
      null, 
      timestamp || this.getClock()
    );
    
    // CRITICAL: Set post-execution position BEFORE recording
    operation.setPostExecutionPosition(position);
    
    this._recordOperation(operation);
    return operation;
  }

  /**
   * Record a delete operation
   * @param {number} position - Delete position
   * @param {Buffer} deletedData - Data that was deleted
   * @param {number} timestamp - Optional timestamp (defaults to current time)
   * @returns {BufferOperation} - The created operation
   */
  recordDelete(position, deletedData, timestamp = null) {
    const operation = new BufferOperation(
      OperationType.DELETE, 
      position, 
      Buffer.alloc(0), 
      Buffer.from(deletedData), 
      timestamp || this.getClock()
    );
    
    // CRITICAL: Set post-execution position BEFORE recording
    operation.setPostExecutionPosition(position); // Delete position stays the same
    
    this._recordOperation(operation);
    return operation;
  }

  /**
   * Record an overwrite operation
   * @param {number} position - Overwrite position
   * @param {Buffer} newData - New data
   * @param {Buffer} originalData - Original data that was overwritten
   * @param {number} timestamp - Optional timestamp (defaults to current time)
   * @returns {BufferOperation} - The created operation
   */
  recordOverwrite(position, newData, originalData, timestamp = null) {
    const operation = new BufferOperation(
      OperationType.OVERWRITE, 
      position, 
      Buffer.from(newData), 
      Buffer.from(originalData), 
      timestamp || this.getClock()
    );
    
    // CRITICAL: Set post-execution position BEFORE recording
    operation.setPostExecutionPosition(position);
    
    this._recordOperation(operation);
    return operation;
  }

  /**
   * Record an operation - FIXED core logic for undo system
   * @param {BufferOperation} operation - Operation to record
   * @private
   */
  _recordOperation(operation) {
    // Don't record operations during undo/redo
    if (this.isUndoing) {
      return;
    }
    
    // Clear redo stack when new operations are performed
    this.redoStack = [];
    
    // Handle transactions
    if (this.activeTransaction) {
      this.activeTransaction.operations.push(operation);
      return;
    }
    
    // Try to merge with the top group on the stack first
    if (this.undoStack.length > 0) {
      const topGroup = this.undoStack[this.undoStack.length - 1];
      
      // Don't merge across transaction boundaries
      if (!topGroup.isFromTransaction && topGroup.operations.length > 0) {
        const lastOp = topGroup.operations[topGroup.operations.length - 1];
        
        // Check if operations can be merged (logically)
        if (lastOp.canMergeWith(operation, this.mergeTimeWindow, this.mergePositionWindow)) {
          
          // CRITICAL FIX: Decide between physical merge vs logical merge
          const distance = this._getOperationDistance(lastOp, operation);
          
          if (distance === 0 && this._areContiguousOperations(lastOp, operation)) {
            // PHYSICAL MERGE: Operations are truly contiguous
            console.log(`Physical merge: ${lastOp.type} + ${operation.type}`);
            lastOp.mergeWith(operation);
          } else {
            // LOGICAL MERGE: Operations should undo together but remain separate
            console.log(`Logical merge: Adding ${operation.type} to existing group`);
            topGroup.operations.push(operation);
          }
          
          return; // Either way, we're done
        }
      }
    }
    
    // Cannot merge - create NEW group and push to stack
    const newGroup = new OperationGroup(this._generateGroupId());
    newGroup.operations.push(operation);
    this.undoStack.push(newGroup);
    
    // Enforce maximum undo levels
    while (this.undoStack.length > this.maxUndoLevels) {
      this.undoStack.shift();
    }
  }

  /**
   * Helper method to get distance between operations
   */
  _getOperationDistance(op1, op2) {
    try {
      return op1.getLogicalDistance(op2);
    } catch (error) {
      // Fallback to simple distance
      return Math.abs(op1.preExecutionPosition - op2.preExecutionPosition);
    }
  }

  /**
   * Helper method to check if operations are truly contiguous
   */
  _areContiguousOperations(op1, op2) {
    // Only insert operations can be physically merged
    if (op1.type !== 'insert' || op2.type !== 'insert') {
      return false;
    }
    
    // Check if they're truly adjacent with no gap
    const distance = this._getOperationDistance(op1, op2);
    return distance === 0;
  }

  // =================== TRANSACTION SUPPORT ===================

  /**
   * Begin a new transaction
   * @param {string} name - Transaction name
   * @param {Object} options - Transaction options
   */
  beginUndoTransaction(name, options = {}) {
    if (this.activeTransaction) {
      throw new Error('Cannot start transaction - another transaction is already active');
    }
    
    this.activeTransaction = new OperationTransaction(name, options);
    // CRITICAL FIX: Use the same clock function as the undo system
    this.activeTransaction.startTime = this.getClock();
  }

  /**
   * Commit the current transaction
   * @param {string} finalName - Optional final name for the group
   * @returns {boolean} - True if transaction was committed
   */
  commitUndoTransaction(finalName = null) {
    if (!this.activeTransaction) {
      return false;
    }
    
    if (this.activeTransaction.operations.length > 0) {
      // Create group from transaction operations
      const group = new OperationGroup(
        this._generateGroupId(),
        finalName || this.activeTransaction.name
      );
      group.operations = [...this.activeTransaction.operations];
      group.isFromTransaction = true; // Mark as transaction group
      
      this.undoStack.push(group);
      
      // Enforce maximum undo levels
      while (this.undoStack.length > this.maxUndoLevels) {
        this.undoStack.shift();
      }
    }
    
    this.activeTransaction = null;
    return true;
  }

  /**
   * Rollback the current transaction
   * @returns {Promise<boolean>} - True if transaction was rolled back
   */
  async rollbackUndoTransaction() {
    if (!this.activeTransaction) {
      return false;
    }
    
    // Undo all operations in reverse order
    this.isUndoing = true;
    try {
      for (let i = this.activeTransaction.operations.length - 1; i >= 0; i--) {
        const operation = this.activeTransaction.operations[i];
        await this._undoOperation(operation);
      }
    } finally {
      this.isUndoing = false;
    }
    
    this.activeTransaction = null;
    return true;
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
    return this.activeTransaction ? this.activeTransaction.getInfo() : null;
  }

  // =================== UNDO/REDO OPERATIONS ===================

  /**
   * Undo the last operation group OR rollback active transaction - FIXED
   * @returns {Promise<boolean>} - True if successful
   */
  async undo() {
    // CRITICAL FIX: Handle undo during active transaction as rollback
    if (this.activeTransaction) {
      return await this.rollbackUndoTransaction();
    }
    
    if (this.undoStack.length === 0) {
      return false;
    }
    
    const group = this.undoStack.pop();
    
    this.isUndoing = true;
    try {
      // Undo operations in reverse order
      for (let i = group.operations.length - 1; i >= 0; i--) {
        const operation = group.operations[i];
        await this._undoOperation(operation);
      }
      
      this.redoStack.push(group);
      return true;
    } catch (error) {
      // If undo fails, restore the group to undo stack
      this.undoStack.push(group);
      throw error;
    } finally {
      this.isUndoing = false;
    }
  }

  /**
   * Redo the last undone operation group
   * @returns {Promise<boolean>} - True if successful
   */
  async redo() {
    if (this.redoStack.length === 0) {
      return false;
    }
    
    const group = this.redoStack.pop();
    
    this.isUndoing = true;
    try {
      // Redo operations in forward order
      for (const operation of group.operations) {
        await this._redoOperation(operation);
      }
      
      this.undoStack.push(group);
      return true;
    } catch (error) {
      // If redo fails, restore the group to redo stack
      this.redoStack.push(group);
      throw error;
    } finally {
      this.isUndoing = false;
    }
  }

  /**
   * Undo a single operation
   * @param {BufferOperation} operation - Operation to undo
   * @private
   */
  async _undoOperation(operation) {
    switch (operation.type) {
      case OperationType.INSERT:
        // Undo insert by deleting the inserted data
        await this.buffer.deleteBytes(
          operation.preExecutionPosition,
          operation.preExecutionPosition + operation.data.length
        );
        break;
        
      case OperationType.DELETE:
        // Undo delete by inserting the original data back
        await this.buffer.insertBytes(
          operation.preExecutionPosition,
          operation.originalData
        );
        break;
        
      case OperationType.OVERWRITE:
        // CRITICAL FIX: For undo, we need to use the atomic overwrite method
        // that doesn't trigger additional undo recording
        const { page, relativePos } = await this.buffer._getPageForPosition(operation.preExecutionPosition);
        await this.buffer._ensurePageLoaded(page);
        
        if (!page.data) {
          page.data = Buffer.alloc(0);
        }
        
        // Calculate the end position of the current data
        const currentDataLength = operation.data.length;
        const endPos = operation.preExecutionPosition + currentDataLength;
        
        // Replace the current data with the original data
        const before = page.data.subarray(0, relativePos);
        const after = page.data.subarray(relativePos + currentDataLength);
        page.updateData(Buffer.concat([before, operation.originalData, after]), this.buffer.mode);
        
        // Update total size
        this.buffer.totalSize = this.buffer.totalSize - currentDataLength + operation.originalData.length;
        this.buffer.state = BufferState.MODIFIED;
        break;
        
      default:
        throw new Error(`Unknown operation type: ${operation.type}`);
    }
  }

  /**
   * Redo a single operation
   * @param {BufferOperation} operation - Operation to redo
   * @private
   */
  async _redoOperation(operation) {
    switch (operation.type) {
      case OperationType.INSERT:
        // Redo insert
        await this.buffer.insertBytes(
          operation.preExecutionPosition,
          operation.data
        );
        break;
        
      case OperationType.DELETE:
        // Redo delete
        await this.buffer.deleteBytes(
          operation.preExecutionPosition,
          operation.preExecutionPosition + operation.originalData.length
        );
        break;
        
      case OperationType.OVERWRITE:
        // Redo overwrite
        await this.buffer.overwriteBytes(
          operation.preExecutionPosition,
          operation.data
        );
        break;
        
      default:
        throw new Error(`Unknown operation type: ${operation.type}`);
    }
  }

  // =================== STATE QUERIES ===================

  /**
   * Check if undo is available - FIXED
   * @returns {boolean} - True if undo is available
   */
  canUndo() {
    // During active transaction, undo should be available for rollback
    if (this.activeTransaction) {
      return true; // Can always rollback active transaction
    }
    return this.undoStack.length > 0;
  }

  /**
   * Check if redo is available - FIXED
   * @returns {boolean} - True if redo is available
   */
  canRedo() {
    // CRITICAL FIX: Block redo during active transactions
    if (this.activeTransaction) {
      return false; // No redo allowed during transactions
    }
    return this.redoStack.length > 0;
  }

  /**
   * Get undo/redo statistics
   * @returns {Object} - Statistics
   */
  getStats() {
    let totalUndoOperations = 0;
    let totalRedoOperations = 0;
    let memoryUsage = 0;
    
    for (const group of this.undoStack) {
      totalUndoOperations += group.operations.length;
      memoryUsage += group.getMemoryUsage();
    }
    
    for (const group of this.redoStack) {
      totalRedoOperations += group.operations.length;
      memoryUsage += group.getMemoryUsage();
    }
    
    const currentTransactionOperations = this.activeTransaction ? 
      this.activeTransaction.operations.length : 0;
    
    return {
      undoGroups: this.undoStack.length,
      redoGroups: this.redoStack.length,
      totalUndoOperations,
      totalRedoOperations,
      currentGroupOperations: 0, // No more current group
      currentTransactionOperations,
      memoryUsage,
      maxUndoLevels: this.maxUndoLevels
    };
  }

  /**
   * Clear all undo/redo history
   */
  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.activeTransaction = null;
    this.groupIdCounter = 0;
  }

  /**
   * Get debug information
   * @returns {Object} - Debug info
   */
  getDebugInfo() {
    return {
      undoStack: this.undoStack.map(group => ({
        id: group.id,
        name: group.name,
        operationCount: group.operations.length,
        isFromTransaction: group.isFromTransaction,
        operations: group.operations.map(op => ({
          type: op.type,
          position: op.preExecutionPosition,
          dataLength: op.data ? op.data.length : 0,
          originalDataLength: op.originalData ? op.originalData.length : 0
        }))
      })),
      redoStack: this.redoStack.map(group => ({
        id: group.id,
        name: group.name,
        operationCount: group.operations.length,
        isFromTransaction: group.isFromTransaction
      })),
      activeTransaction: this.activeTransaction ? this.activeTransaction.getInfo() : null,
      stats: this.getStats()
    };
  }
}

module.exports = {
  BufferUndoSystem,
  OperationGroup,
  OperationTransaction,
  BufferOperation,
  OperationType
};
