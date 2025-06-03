/**
 * @fileoverview Enhanced Buffer Undo/Redo System with Line and Marks Integration
 * @author Jeffrey R. Day
 * @version 2.2.0
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
    this.isFromTransaction = false;
    
    // Enhanced: Store marks state before and after group execution
    this.marksSnapshot = null; // Will be set when group is recorded
    this.linesSnapshot = null; // Line count snapshot for verification
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
    
    // Add marks snapshot memory (rough estimate)
    if (this.marksSnapshot) {
      total += this.marksSnapshot.length * 64; // Rough estimate per mark
    }
    
    return total;
  }

  /**
   * Set marks snapshot for this group
   * @param {Array} marks - Current marks state
   */
  setMarksSnapshot(marks) {
    this.marksSnapshot = marks.map(mark => ({ ...mark })); // Deep copy
  }

  /**
   * Set lines snapshot for this group
   * @param {number} lineCount - Current line count
   */
  setLinesSnapshot(lineCount) {
    this.linesSnapshot = lineCount;
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
    
    // Enhanced: Track marks state at transaction start
    this.initialMarksSnapshot = null;
    this.initialLinesSnapshot = null;
  }

  /**
   * Set initial state snapshots
   * @param {Array} marks - Initial marks state
   * @param {number} lineCount - Initial line count
   */
  setInitialState(marks, lineCount) {
    this.initialMarksSnapshot = marks.map(mark => ({ ...mark }));
    this.initialLinesSnapshot = lineCount;
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
      options: this.options,
      hasMarksSnapshot: this.initialMarksSnapshot !== null,
      hasLinesSnapshot: this.initialLinesSnapshot !== null
    };
  }
}

/**
 * Enhanced Buffer Undo/Redo System with Line and Marks Integration
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
    
    // IMPROVED DEFAULTS: More conservative merge settings
    this.mergeTimeWindow = 5000;      // Keep reasonable time window for rapid typing
    this.mergePositionWindow = 0;     // DEFAULT TO ZERO - no position-based merging
    
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
   * CRITICAL FIX: Capture current marks state for snapshot BEFORE any operation recording
   * This must be called by buffer operations BEFORE they execute
   * @returns {Array} - Current marks snapshot
   */
  captureCurrentMarksState() {
    if (!this.buffer.lineAndMarksManager) {
      return [];
    }
    
    try {
      return this.buffer.lineAndMarksManager.getAllMarks();
    } catch (error) {
      console.warn('Failed to capture current marks state:', error.message);
      return [];
    }
  }

  /**
   * Record an insert operation with enhanced tracking
   * @param {number} position - Insert position
   * @param {Buffer} data - Inserted data
   * @param {number} timestamp - Optional timestamp (defaults to current time)
   * @param {Array} preOpMarksSnapshot - Pre-operation marks snapshot
   * @returns {BufferOperation} - The created operation
   */
  recordInsert(position, data, timestamp = null, preOpMarksSnapshot = null) {
    const operation = new BufferOperation(
      OperationType.INSERT, 
      position, 
      Buffer.from(data), 
      null, 
      timestamp || this.getClock()
    );
    
    operation.setPostExecutionPosition(position);
    this._recordOperation(operation, preOpMarksSnapshot);
    return operation;
  }

  /**
   * Record a delete operation with enhanced tracking
   * @param {number} position - Delete position
   * @param {Buffer} deletedData - Data that was deleted
   * @param {number} timestamp - Optional timestamp (defaults to current time)
   * @param {Array} preOpMarksSnapshot - Pre-operation marks snapshot
   * @returns {BufferOperation} - The created operation
   */
  recordDelete(position, deletedData, timestamp = null, preOpMarksSnapshot = null) {
    const operation = new BufferOperation(
      OperationType.DELETE, 
      position, 
      Buffer.alloc(0), 
      Buffer.from(deletedData), 
      timestamp || this.getClock()
    );
    
    operation.setPostExecutionPosition(position);
    this._recordOperation(operation, preOpMarksSnapshot);
    return operation;
  }

  /**
   * Record an overwrite operation with enhanced tracking
   * @param {number} position - Overwrite position
   * @param {Buffer} newData - New data
   * @param {Buffer} originalData - Original data that was overwritten
   * @param {number} timestamp - Optional timestamp (defaults to current time)
   * @param {Array} preOpMarksSnapshot - Pre-operation marks snapshot
   * @returns {BufferOperation} - The created operation
   */
  recordOverwrite(position, newData, originalData, timestamp = null, preOpMarksSnapshot = null) {
    const operation = new BufferOperation(
      OperationType.OVERWRITE, 
      position, 
      Buffer.from(newData), 
      Buffer.from(originalData), 
      timestamp || this.getClock()
    );
    
    operation.setPostExecutionPosition(position);
    this._recordOperation(operation, preOpMarksSnapshot);
    return operation;
  }

  /**
   * Enhanced operation recording with marks and lines tracking - FIXED SNAPSHOT TIMING
   * @param {BufferOperation} operation - Operation to record
   * @param {Array} preOpMarksSnapshot - Pre-operation marks snapshot
   * @private
   */
  _recordOperation(operation, preOpMarksSnapshot = null) {
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
        
        // Check if operations can be merged
        if (lastOp.canMergeWith(operation, this.mergeTimeWindow, this.mergePositionWindow)) {
          
          // IMPROVED: Only do physical merges for truly contiguous same-type operations
          const distance = this._getOperationDistance(lastOp, operation);
          
          if (distance === 0 && 
              this._areContiguousOperations(lastOp, operation) &&
              lastOp.type === operation.type) {
            // PHYSICAL MERGE: Operations are truly contiguous and same type
            lastOp.mergeWith(operation);
          } else {
            // LOGICAL MERGE: Operations should undo together but remain separate
            topGroup.operations.push(operation);
          }
          
          // NOTE: Don't update snapshot for merged operations - keep original pre-state
          return; // Either way, we're done
        }
      }
    }
    
    // Cannot merge - create NEW group and push to stack
    // CRITICAL FIX: Use the provided pre-operation snapshot, or capture current state
    const newGroup = new OperationGroup(this._generateGroupId());
    
    // Use provided snapshot or capture current state if none provided
    const snapshotToUse = preOpMarksSnapshot || this.captureCurrentMarksState();
    newGroup.setMarksSnapshot(snapshotToUse);
    
    // Capture line count snapshot
    if (this.buffer.lineAndMarksManager) {
      try {
        const lineCount = this.buffer.lineAndMarksManager.getTotalLineCount();
        newGroup.setLinesSnapshot(lineCount);
      } catch (error) {
        console.warn('Failed to capture line count snapshot:', error.message);
      }
    }
    
    // Now add the operation to the group
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
   * More conservative contiguous operation detection
   */
  _areContiguousOperations(op1, op2) {
    // Only insert operations of the same type can be physically merged
    if (op1.type !== 'insert' || op2.type !== 'insert') {
      return false;
    }
    
    // Check if they're truly adjacent with no gap and in correct order
    const distance = this._getOperationDistance(op1, op2);
    if (distance !== 0) {
      return false;
    }
    
    // Additional check: second operation should start where first ends
    const op1End = op1.preExecutionPosition + (op1.data ? op1.data.length : 0);
    return Math.abs(op2.preExecutionPosition - op1End) <= 1;
  }

  // =================== ENHANCED TRANSACTION SUPPORT ===================

  /**
   * Begin a new transaction with state tracking
   * @param {string} name - Transaction name
   * @param {Object} options - Transaction options
   */
  beginUndoTransaction(name, options = {}) {
    if (this.activeTransaction) {
      throw new Error('Cannot start transaction - another transaction is already active');
    }
    
    this.activeTransaction = new OperationTransaction(name, options);
    this.activeTransaction.startTime = this.getClock();
    
    // FIXED: Capture initial state using virtual addresses BEFORE any operations
    if (this.buffer.lineAndMarksManager) {
      try {
        const allMarks = this.buffer.lineAndMarksManager.getAllMarks();
        const lineCount = this.buffer.lineAndMarksManager.getTotalLineCount();
        this.activeTransaction.setInitialState(allMarks, lineCount);
      } catch (error) {
        console.warn('Failed to capture initial transaction state:', error.message);
      }
    }
  }

  /**
   * Commit the current transaction with enhanced state tracking
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
      group.isFromTransaction = true;
      
      // FIXED: Set snapshots using virtual addresses from transaction INITIAL state (pre-operations)
      if (this.activeTransaction.initialMarksSnapshot) {
        group.setMarksSnapshot(this.activeTransaction.initialMarksSnapshot);
      }
      if (this.activeTransaction.initialLinesSnapshot !== null) {
        group.setLinesSnapshot(this.activeTransaction.initialLinesSnapshot);
      }
      
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
   * Enhanced rollback with marks and lines restoration
   * @returns {Promise<boolean>} - True if transaction was rolled back
   */
  async rollbackUndoTransaction() {
    if (!this.activeTransaction) {
      return false;
    }
    
    // Undo all operations in reverse order using VPM
    this.isUndoing = true;
    try {
      for (let i = this.activeTransaction.operations.length - 1; i >= 0; i--) {
        const operation = this.activeTransaction.operations[i];
        await this._undoOperationVPM(operation);
      }
      
      // FIXED: Restore marks state using virtual addresses
      if (this.activeTransaction.initialMarksSnapshot && this.buffer.lineAndMarksManager) {
        await this._restoreMarksState(this.activeTransaction.initialMarksSnapshot);
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

  // =================== ENHANCED UNDO/REDO OPERATIONS ===================

  /**
   * Enhanced undo with marks and lines restoration
   * @returns {Promise<boolean>} - True if successful
   */
  async undo() {
    // Handle undo during active transaction as rollback
    if (this.activeTransaction) {
      return await this.rollbackUndoTransaction();
    }
    
    if (this.undoStack.length === 0) {
      return false;
    }
    
    const group = this.undoStack.pop();
    
    this.isUndoing = true;
    try {
      // Undo operations in reverse order using VPM
      for (let i = group.operations.length - 1; i >= 0; i--) {
        const operation = group.operations[i];
        await this._undoOperationVPM(operation);
      }
      
      // FIXED: Restore marks state using virtual addresses
      if (group.marksSnapshot && this.buffer.lineAndMarksManager) {
        await this._restoreMarksState(group.marksSnapshot);
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
   * Enhanced redo with marks and lines restoration
   * @returns {Promise<boolean>} - True if successful
   */
  async redo() {
    if (this.redoStack.length === 0) {
      return false;
    }
    
    const group = this.redoStack.pop();
    
    this.isUndoing = true;
    try {
      // CRITICAL FIX: Capture current marks state BEFORE redo operations
      let currentMarksSnapshot = null;
      if (this.buffer.lineAndMarksManager) {
        try {
          currentMarksSnapshot = this.buffer.lineAndMarksManager.getAllMarks();
        } catch (error) {
          console.warn('Failed to capture current marks state for redo:', error.message);
        }
      }
      
      // Redo operations in forward order using VPM
      for (const operation of group.operations) {
        await this._redoOperationVPM(operation);
      }
      
      // FIXED: Update the group's snapshot to current post-redo state for future undo
      if (currentMarksSnapshot) {
        group.setMarksSnapshot(currentMarksSnapshot);
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
   * CORRECTED: Restore marks state from snapshot using virtual addresses
   * @param {Array} marksSnapshot - Marks to restore (virtual address format)
   * @private
   */
  async _restoreMarksState(marksSnapshot) {
    if (!this.buffer.lineAndMarksManager) {
      return;
    }
    
    console.log(`[DEBUG] Restoring ${marksSnapshot.length} marks from snapshot`);
    
    try {
      // Clear all current marks
      const currentMarks = this.buffer.lineAndMarksManager.getAllMarks();
      console.log(`[DEBUG] Current marks before clear:`, currentMarks);
      
      this.buffer.lineAndMarksManager.clearAllMarks();
      
      // Restore marks using virtual addresses from snapshot
      for (const mark of marksSnapshot) {
        console.log(`[DEBUG] Restoring mark ${mark.name} at address ${mark.address}`);
        
        // Validate that the address is still within bounds
        const totalSize = this.buffer.getTotalSize();
        if (mark.address >= 0 && mark.address <= totalSize) {
          this.buffer.lineAndMarksManager.setMark(mark.name, mark.address);
          console.log(`[DEBUG] Successfully restored mark ${mark.name}`);
        } else {
          console.log(`[DEBUG] Skipping mark ${mark.name} - address ${mark.address} out of bounds (buffer size: ${totalSize})`);
        }
      }
      
      const restoredMarks = this.buffer.lineAndMarksManager.getAllMarks();
      console.log(`[DEBUG] Marks after restoration:`, restoredMarks);
      
    } catch (error) {
      console.warn('Failed to restore marks state:', error.message);
    }
  }

  /**
   * Undo a single operation using Virtual Page Manager with enhanced tracking
   * @param {BufferOperation} operation - Operation to undo
   * @private
   */
  async _undoOperationVPM(operation) {
    const vpm = this.buffer.virtualPageManager;
    
    switch (operation.type) {
      case OperationType.INSERT:
        // Undo insert by deleting the inserted data
        await vpm.deleteRange(
          operation.preExecutionPosition,
          operation.preExecutionPosition + operation.data.length
        );
        // FORCE mark update for undo
        if (this.buffer.lineAndMarksManager) {
          this.buffer.lineAndMarksManager.updateMarksAfterModification(
            operation.preExecutionPosition,
            operation.data.length,
            0
          );
        }
        this.buffer.totalSize -= operation.data.length;
        break;
        
      case OperationType.DELETE:
        // Undo delete by inserting the original data back
        await vpm.insertAt(operation.preExecutionPosition, operation.originalData);
        // FORCE mark update for undo
        if (this.buffer.lineAndMarksManager) {
          this.buffer.lineAndMarksManager.updateMarksAfterModification(
            operation.preExecutionPosition,
            0,
            operation.originalData.length
          );
        }
        this.buffer.totalSize += operation.originalData.length;
        break;
        
      case OperationType.OVERWRITE:
        // Undo overwrite by deleting new data and inserting original data
        await vpm.deleteRange(
          operation.preExecutionPosition,
          operation.preExecutionPosition + operation.data.length
        );
        await vpm.insertAt(operation.preExecutionPosition, operation.originalData);
        // FORCE mark update for undo (net change)
        if (this.buffer.lineAndMarksManager) {
          this.buffer.lineAndMarksManager.updateMarksAfterModification(
            operation.preExecutionPosition,
            operation.data.length,
            operation.originalData.length
          );
        }
        const sizeChange = operation.originalData.length - operation.data.length;
        this.buffer.totalSize += sizeChange;
        break;
        
      default:
        throw new Error(`Unknown operation type: ${operation.type}`);
    }
    
    this.buffer._markAsModified();
  }

  async _redoOperationVPM(operation) {
    const vpm = this.buffer.virtualPageManager;
    
    switch (operation.type) {
      case OperationType.INSERT:
        // Redo insert
        await vpm.insertAt(operation.preExecutionPosition, operation.data);
        // FORCE mark update for redo
        if (this.buffer.lineAndMarksManager) {
          this.buffer.lineAndMarksManager.updateMarksAfterModification(
            operation.preExecutionPosition,
            0,
            operation.data.length
          );
        }
        this.buffer.totalSize += operation.data.length;
        break;
        
      case OperationType.DELETE:
        // Redo delete
        await vpm.deleteRange(
          operation.preExecutionPosition,
          operation.preExecutionPosition + operation.originalData.length
        );
        // FORCE mark update for redo
        if (this.buffer.lineAndMarksManager) {
          this.buffer.lineAndMarksManager.updateMarksAfterModification(
            operation.preExecutionPosition,
            operation.originalData.length,
            0
          );
        }
        this.buffer.totalSize -= operation.originalData.length;
        break;
        
      case OperationType.OVERWRITE:
        // Redo overwrite by deleting original data and inserting new data
        await vpm.deleteRange(
          operation.preExecutionPosition,
          operation.preExecutionPosition + operation.originalData.length
        );
        await vpm.insertAt(operation.preExecutionPosition, operation.data);
        // FORCE mark update for redo (net change)
        if (this.buffer.lineAndMarksManager) {
          this.buffer.lineAndMarksManager.updateMarksAfterModification(
            operation.preExecutionPosition,
            operation.originalData.length,
            operation.data.length
          );
        }
        const sizeChange = operation.data.length - operation.originalData.length;
        this.buffer.totalSize += sizeChange;
        break;
        
      default:
        throw new Error(`Unknown operation type: ${operation.type}`);
    }
    
    this.buffer._markAsModified();
  }

  // =================== STATE QUERIES ===================

  /**
   * Check if undo is available
   * @returns {boolean} - True if undo is available
   */
  canUndo() {
    // During active transaction, undo should be available for rollback
    if (this.activeTransaction) {
      return true;
    }
    return this.undoStack.length > 0;
  }

  /**
   * Check if redo is available
   * @returns {boolean} - True if redo is available
   */
  canRedo() {
    // Block redo during active transactions
    if (this.activeTransaction) {
      return false;
    }
    return this.redoStack.length > 0;
  }

  /**
   * Get enhanced undo/redo statistics
   * @returns {Object} - Statistics
   */
  getStats() {
    let totalUndoOperations = 0;
    let totalRedoOperations = 0;
    let memoryUsage = 0;
    let groupsWithMarksSnapshots = 0;
    let groupsWithLinesSnapshots = 0;
    
    for (const group of this.undoStack) {
      totalUndoOperations += group.operations.length;
      memoryUsage += group.getMemoryUsage();
      if (group.marksSnapshot) groupsWithMarksSnapshots++;
      if (group.linesSnapshot !== null) groupsWithLinesSnapshots++;
    }
    
    for (const group of this.redoStack) {
      totalRedoOperations += group.operations.length;
      memoryUsage += group.getMemoryUsage();
      if (group.marksSnapshot) groupsWithMarksSnapshots++;
      if (group.linesSnapshot !== null) groupsWithLinesSnapshots++;
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
      maxUndoLevels: this.maxUndoLevels,
      groupsWithMarksSnapshots,
      groupsWithLinesSnapshots,
      hasEnhancedTracking: true
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
   * Get enhanced debug information
   * @returns {Object} - Debug info
   */
  getDebugInfo() {
    return {
      undoStack: this.undoStack.map(group => ({
        id: group.id,
        name: group.name,
        operationCount: group.operations.length,
        isFromTransaction: group.isFromTransaction,
        hasMarksSnapshot: group.marksSnapshot !== null,
        hasLinesSnapshot: group.linesSnapshot !== null,
        marksCount: group.marksSnapshot ? group.marksSnapshot.length : 0,
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
        isFromTransaction: group.isFromTransaction,
        hasMarksSnapshot: group.marksSnapshot !== null,
        hasLinesSnapshot: group.linesSnapshot !== null,
        marksCount: group.marksSnapshot ? group.marksSnapshot.length : 0
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
