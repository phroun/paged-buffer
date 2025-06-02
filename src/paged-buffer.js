/**
 * @fileoverview Enhanced PagedBuffer with comprehensive line tracking and named marks
 * @description High-performance buffer with line-aware operations and named marks support
 * @author Jeffrey R. Day
 * @version 2.2.0
 */

const fs = require('fs').promises;
const crypto = require('crypto');
const path = require('path');
const { BufferUndoSystem } = require('./undo-system');
const os = require('os');    

const { 
  BufferState, 
  FileChangeStrategy 
} = require('./types/buffer-types');

const { NotificationType, BufferNotification } = require('./types/notifications');
const { PageStorage } = require('./storage/page-storage');
const { MemoryPageStorage } = require('./storage/memory-page-storage');
const { VirtualPageManager } = require('./virtual-page-manager');
const { LineAndMarksManager, LineOperationResult, ExtractedContent } = require('./utils/line-marks-manager');

/**
 * Tracks missing data ranges in detached buffers
 */
class MissingDataRange {
  constructor(virtualStart, virtualEnd, originalFileStart = null, originalFileEnd = null, reason = 'unknown') {
    this.virtualStart = virtualStart;
    this.virtualEnd = virtualEnd;
    this.originalFileStart = originalFileStart;
    this.originalFileEnd = originalFileEnd;
    this.reason = reason; // 'file_deleted', 'file_corrupted', 'storage_failed', etc.
    this.size = virtualEnd - virtualStart;
  }

  /**
   * Generate human-readable description of missing data
   */
  toDescription() {
    const sizeDesc = this.size === 1 ? '1 byte' : `${this.size.toLocaleString()} bytes`;
    let desc = `[Missing ${sizeDesc} from buffer addresses ${this.virtualStart.toLocaleString()} to ${this.virtualEnd.toLocaleString()}`;
    
    if (this.originalFileStart !== null && this.originalFileEnd !== null) {
      desc += `, original file positions ${this.originalFileStart.toLocaleString()} to ${this.originalFileEnd.toLocaleString()}`;
    }
    
    if (this.reason !== 'unknown') {
      desc += `, reason: ${this.reason}`;
    }
    
    desc += '.]';
    desc += '\n';
    
    return desc;
  }
}

/**
 * Enhanced PagedBuffer with comprehensive line tracking and named marks
 */
class PagedBuffer {
  constructor(pageSize = 64 * 1024, storage = null, maxMemoryPages = 100) {
    this.pageSize = pageSize;
    this.storage = storage || new MemoryPageStorage();
    this.maxMemoryPages = maxMemoryPages;
    
    // File metadata
    this.filename = null;
    this.fileSize = 0;
    this.fileMtime = null;
    this.fileChecksum = null;
    
    // Virtual Page Manager
    this.virtualPageManager = new VirtualPageManager(this, pageSize);
    this.virtualPageManager.maxLoadedPages = maxMemoryPages;
    
    // Enhanced Line and Marks Manager
    this.lineAndMarksManager = new LineAndMarksManager(this.virtualPageManager);
    this.virtualPageManager.setLineAndMarksManager(this.lineAndMarksManager);
    
    // Virtual file state
    this.totalSize = 0;
    
    // REFACTORED STATE MANAGEMENT:
    // Data integrity state (clean/detached/corrupted)
    this.state = BufferState.CLEAN;
    // Modification state (separate from integrity)
    this.hasUnsavedChanges = false;
    
    // Detached buffer tracking
    this.missingDataRanges = [];
    this.detachmentReason = null;
    
    // Notification system
    this.notifications = [];
    this.notificationCallbacks = [];
    
    // File change detection settings
    this.changeStrategy = {
      noEdits: FileChangeStrategy.REBASE,
      withEdits: FileChangeStrategy.WARN,
      sizeChanged: FileChangeStrategy.DETACH
    };
    
    // Monitoring
    this.lastFileCheck = null;
    this.fileCheckInterval = 5000;
    
    // Undo/Redo system
    this.undoSystem = null;
  }

  /**
   * Mark buffer as detached due to data loss
   * @param {string} reason - Reason for detachment
   * @param {MissingDataRange[]} missingRanges - Missing data ranges
   */
  _markAsDetached(reason, missingRanges = []) {
    const wasDetached = this.state === BufferState.DETACHED;
    
    // CRITICAL: Always transition to DETACHED when corruption is detected
    this.state = BufferState.DETACHED;
    this.detachmentReason = reason;
    this.missingDataRanges = [...this.missingDataRanges, ...missingRanges];
    
    // Merge overlapping ranges
    this._mergeMissingRanges();
    
    if (!wasDetached) {
      this._notify(
        NotificationType.BUFFER_DETACHED,
        'warning',
        `Buffer detached: ${reason}. Some data may be unavailable.`,
        { 
          reason, 
          missingRanges: missingRanges.length,
          totalMissingBytes: missingRanges.reduce((sum, range) => sum + range.size, 0),
          recommendation: 'Use Save As to save available data to a new file'
        }
      );
    }
  }

  /**
   * Mark buffer as having unsaved changes
   * @private
   */
  _markAsModified() {
    this.hasUnsavedChanges = true;
  }

  /**
   * Mark buffer as saved (no unsaved changes)
   * @private
   */
  _markAsSaved() {
    this.hasUnsavedChanges = false;
  }

  /**
   * Merge overlapping missing data ranges
   * @private
   */
  _mergeMissingRanges() {
    if (this.missingDataRanges.length <= 1) return;
    
    // Sort by virtual start position
    this.missingDataRanges.sort((a, b) => a.virtualStart - b.virtualStart);
    
    const merged = [this.missingDataRanges[0]];
    
    for (let i = 1; i < this.missingDataRanges.length; i++) {
      const current = this.missingDataRanges[i];
      const last = merged[merged.length - 1];
      
      if (current.virtualStart <= last.virtualEnd) {
        // Overlapping or adjacent ranges - merge them
        last.virtualEnd = Math.max(last.virtualEnd, current.virtualEnd);
        last.size = last.virtualEnd - last.virtualStart;
        if (current.originalFileEnd !== null && last.originalFileEnd !== null) {
          last.originalFileEnd = Math.max(last.originalFileEnd, current.originalFileEnd);
        }
      } else {
        merged.push(current);
      }
    }
    
    this.missingDataRanges = merged;
  }

  /**
   * Add notification callback
   * @param {Function} callback - Callback function for notifications
   */
  onNotification(callback) {
    this.notificationCallbacks.push(callback);
  }

  /**
   * Emit a notification
   * @param {string} type - Notification type
   * @param {string} severity - Severity level
   * @param {string} message - Human-readable message
   * @param {Object} metadata - Additional data
   */
  _notify(type, severity, message, metadata = {}) {
    const notification = new BufferNotification(type, severity, message, metadata);
    this.notifications.push(notification);
    
    for (const callback of this.notificationCallbacks) {
      try {
        callback(notification);
      } catch (error) {
        console.error('Notification callback error:', error);
      }
    }
  }

  /**
   * Load a file into the buffer
   * @param {string} filename - Path to the file
   */
  async loadFile(filename) {
    try {
      const stats = await fs.stat(filename);
      this.filename = filename;
      this.fileSize = stats.size;
      this.fileMtime = stats.mtime;
      this.totalSize = stats.size;
      this.lastFileCheck = Date.now();
      
      // Clear any previous state
      this.state = BufferState.CLEAN;
      this.hasUnsavedChanges = false;
      this.missingDataRanges = [];
      this.detachmentReason = null;
      
      // Calculate file checksum
      this.fileChecksum = await this._calculateFileChecksum(filename);
      
      // Initialize Virtual Page Manager from file
      this.virtualPageManager.initializeFromFile(filename, stats.size, this.fileChecksum);
      
      this._notify(
        NotificationType.FILE_MODIFIED_ON_DISK,
        'info',
        `Loaded file`,
        { filename, size: stats.size, state: this.state, hasUnsavedChanges: this.hasUnsavedChanges }
      );
      
    } catch (error) {
      throw new Error(`Failed to load file: ${error.message}`);
    }
  }

  /**
   * Enhanced loadContent with proper initial state
   */
  loadContent(content) {
    this.filename = null;
    this.totalSize = Buffer.byteLength(content, 'utf8');
    
    // Clear any previous state
    this.state = BufferState.CLEAN;
    this.hasUnsavedChanges = false;
    this.missingDataRanges = [];
    this.detachmentReason = null;
    
    // Initialize Virtual Page Manager from content
    const contentBuffer = Buffer.from(content, 'utf8');
    this.virtualPageManager.initializeFromContent(contentBuffer);
    
    this._notify(
      'buffer_content_loaded',
      'info',
      `Loaded content`,
      { size: this.totalSize, state: this.state, hasUnsavedChanges: this.hasUnsavedChanges }
    );
  }

  /**
   * Enhanced loadBinaryContent with proper initial state
   */
  loadBinaryContent(content) {
    this.filename = null;
    this.totalSize = content.length;
    
    // Clear any previous state
    this.state = BufferState.CLEAN;
    this.hasUnsavedChanges = false;
    this.missingDataRanges = [];
    this.detachmentReason = null;
    
    // Initialize Virtual Page Manager from content
    this.virtualPageManager.initializeFromContent(content);
    
    this._notify(
      'buffer_content_loaded',
      'info',
      `Loaded binary content`,
      { size: this.totalSize, state: this.state, hasUnsavedChanges: this.hasUnsavedChanges }
    );
  }

  /**
   * Calculate file checksum for change detection
   * @param {string} filename - File to checksum
   * @returns {Promise<string>} - File checksum
   */
  async _calculateFileChecksum(filename) {
    if (this.fileSize === 0) {
      return 'd41d8cd98f00b204e9800998ecf8427e'; // MD5 of empty string
    }

    const hash = crypto.createHash('md5');
    const fd = await fs.open(filename, 'r');
    const buffer = Buffer.alloc(8192);
    
    try {
      let position = 0;
      while (position < this.fileSize) {
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    } finally {
      await fd.close();
    }
    
    return hash.digest('hex');
  }

  /**
   * Check for file changes
   * @returns {Promise<Object>} - Change information
   */
  async checkFileChanges() {
    if (!this.filename) {
      return { changed: false };
    }

    try {
      const stats = await fs.stat(this.filename);
      const sizeChanged = stats.size !== this.fileSize;
      const mtimeChanged = stats.mtime.getTime() !== this.fileMtime.getTime();
      const changed = sizeChanged || mtimeChanged;

      return {
        changed,
        sizeChanged,
        mtimeChanged,
        newSize: stats.size,
        newMtime: stats.mtime,
        deleted: false
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {
          changed: true,
          deleted: true,
          sizeChanged: true,
          mtimeChanged: true
        };
      }
      throw error;
    }
  }

  // =================== CORE BYTE OPERATIONS WITH MARKS SUPPORT ===================

  /**
   * Get bytes from absolute position with optional marks extraction
   * @param {number} start - Start byte position
   * @param {number} end - End byte position
   * @param {boolean} includeMarks - Whether to include marks in result
   * @returns {Promise<Buffer|ExtractedContent>} - Data or data with marks
   */
  async getBytes(start, end, includeMarks = false) {
    if (start < 0 || end < 0) {
      throw new Error('Invalid range: positions cannot be negative');
    }
    if (start > end) {
      return includeMarks ? new ExtractedContent(Buffer.alloc(0), []) : Buffer.alloc(0);
    }
    if (start >= this.totalSize) {
      return includeMarks ? new ExtractedContent(Buffer.alloc(0), []) : Buffer.alloc(0);
    }
    if (end > this.totalSize) {
      end = this.totalSize;
    }
    
    try {
      if (includeMarks) {
        return await this.lineAndMarksManager.getBytesWithMarks(start, end, true);
      } else {
        return await this.virtualPageManager.readRange(start, end);
      }
    } catch (error) {
      // CRITICAL: If VPM fails to read data, this triggers detachment
      // The VPM should have already called _markAsDetached through _handleCorruption
      // So we just return empty buffer here
      return includeMarks ? new ExtractedContent(Buffer.alloc(0), []) : Buffer.alloc(0);
    }
  }

  /**
   * Insert bytes at absolute position with optional marks
   * @param {number} position - Insertion position
   * @param {Buffer} data - Data to insert
   * @param {Array<{name: string, relativeOffset: number}>} marks - Marks to insert
   */
  async insertBytes(position, data, marks = []) {
    if (position < 0) {
      throw new Error('Invalid position: cannot be negative');
    }
    if (position > this.totalSize) {
      throw new Error(`Position ${position} is beyond end of buffer (size: ${this.totalSize})`);
    }

    // Capture values before execution for undo recording
    const originalPosition = position;
    const originalData = Buffer.from(data);
    const timestamp = this.undoSystem ? this.undoSystem.getClock() : Date.now();

    // Use enhanced VPM for insertion with marks support
    if (marks.length > 0) {
      await this.lineAndMarksManager.insertBytesWithMarks(position, data, marks);
    } else {
      await this.virtualPageManager.insertAt(position, data);
      // Update marks and lines manually if no marks provided
      if (this.lineAndMarksManager && this.lineAndMarksManager.updateMarksAfterModification) {
        this.lineAndMarksManager.updateMarksAfterModification(position, 0, data.length);
      }
    }
    
    // Update buffer state
    this.totalSize += data.length;
    this._markAsModified();
    
    // Record the operation AFTER executing it
    if (this.undoSystem) {
      this.undoSystem.recordInsert(originalPosition, originalData, timestamp);
    }
  }

  /**
   * Enhanced deleteBytes with marks extraction
   * @param {number} start - Start position
   * @param {number} end - End position
   * @param {boolean} extractMarks - Whether to extract marks from deleted content
   * @returns {Promise<Buffer|ExtractedContent>} - Deleted data with optional marks
   */
  async deleteBytes(start, end, extractMarks = false) {
    if (start < 0 || end < 0) {
      throw new Error('Invalid range: positions cannot be negative');  
    }
    if (start > end) {
      throw new Error('Invalid range: start position must be less than or equal to end position');
    }
    if (start >= this.totalSize) {
      return extractMarks ? new ExtractedContent(Buffer.alloc(0), []) : Buffer.alloc(0);
    }
    if (end > this.totalSize) {
      end = this.totalSize;
    }

    // Capture values before execution for undo recording
    const originalStart = start;
    const timestamp = this.undoSystem ? this.undoSystem.getClock() : Date.now();

    let deletedData;
    
    if (extractMarks) {
      // Use enhanced deletion with marks extraction
      const result = await this.lineAndMarksManager.deleteBytesWithMarks(start, end);
      deletedData = result.data;
      
      // Update buffer state
      this.totalSize -= deletedData.length;
      this._markAsModified();
      
      // Record the operation AFTER executing it
      if (this.undoSystem) {
        this.undoSystem.recordDelete(originalStart, deletedData, timestamp);
      }
      
      return result;
    } else {
      // Use standard VPM deletion
      deletedData = await this.virtualPageManager.deleteRange(start, end);
      
      // Update marks and lines
      if (this.lineAndMarksManager && this.lineAndMarksManager.updateMarksAfterModification) {
        this.lineAndMarksManager.updateMarksAfterModification(start, end - start, 0);
      }
      
      // Update buffer state
      this.totalSize -= deletedData.length;
      this._markAsModified();
      
      // Record the operation AFTER executing it
      if (this.undoSystem) {
        this.undoSystem.recordDelete(originalStart, deletedData, timestamp);
      }
      
      return deletedData;
    }
  }

  /**
   * Enhanced overwriteBytes with marks support
   * @param {number} position - Overwrite position
   * @param {Buffer} data - New data
   * @param {Array<{name: string, relativeOffset: number}>} marks - Marks to insert
   * @returns {Promise<Buffer|ExtractedContent>} - Overwritten data with optional marks
   */
  async overwriteBytes(position, data, marks = []) {
    if (position < 0) {
      throw new Error('Invalid position: cannot be negative');
    }
    if (position >= this.totalSize) {
      throw new Error(`Position ${position} is beyond end of buffer (size: ${this.totalSize})`);
    }

    // Capture values before execution for undo recording
    const originalPosition = position;
    const originalData = Buffer.from(data);
    const timestamp = this.undoSystem ? this.undoSystem.getClock() : Date.now();

    let overwrittenData;
    
    if (marks.length > 0) {
      // Use enhanced overwrite with marks
      const result = await this.lineAndMarksManager.overwriteBytesWithMarks(position, data, marks);
      overwrittenData = result.data;
      
      // Record the operation AFTER executing it
      if (this.undoSystem) {
        this.undoSystem.recordOverwrite(originalPosition, originalData, overwrittenData, timestamp);
      }
      
      return result;
    } else {
      // Standard overwrite
      const endPos = Math.min(position + data.length, this.totalSize);
      overwrittenData = await this.getBytes(position, endPos);
      
      // Disable undo recording temporarily for delete/insert operations
      const undoSystem = this.undoSystem;
      this.undoSystem = null;
      
      try {
        // Perform the overwrite as delete + insert but without recording
        await this.deleteBytes(position, endPos);
        await this.insertBytes(position, data);
      } finally {
        // Restore undo system
        this.undoSystem = undoSystem;
      }
      
      // Record the operation AFTER executing it
      if (this.undoSystem) {
        this.undoSystem.recordOverwrite(originalPosition, originalData, overwrittenData, timestamp);
      }
      
      return overwrittenData;
    }
  }

  // =================== NAMED MARKS API ===================

  /**
   * Set a named mark at a byte address
   * @param {string} markName - Name of the mark
   * @param {number} byteAddress - Byte address in buffer
   */
  setMark(markName, byteAddress) {
    this.lineAndMarksManager.setMark(markName, byteAddress);
  }

  /**
   * Get the byte address of a named mark
   * @param {string} markName - Name of the mark
   * @returns {number|null} - Byte address or null if not found
   */
  getMark(markName) {
    return this.lineAndMarksManager.getMark(markName);
  }

  /**
   * Remove a named mark
   * @param {string} markName - Name of the mark
   * @returns {boolean} - True if mark was found and removed
   */
  removeMark(markName) {
    return this.lineAndMarksManager.removeMark(markName);
  }

  /**
   * Get all marks between two byte addresses
   * @param {number} startAddress - Start address (inclusive)
   * @param {number} endAddress - End address (inclusive)
   * @returns {Array<{name: string, address: number}>} - Marks in range
   */
  getMarksInRange(startAddress, endAddress) {
    return this.lineAndMarksManager.getMarksInRange(startAddress, endAddress);
  }

  /**
   * Get all marks in the buffer
   * @returns {Array<{name: string, address: number}>} - All marks
   */
  getAllMarks() {
    return this.lineAndMarksManager.getAllMarks();
  }

  // =================== UNDO/REDO SYSTEM ===================

  /**
   * Enable undo/redo functionality
   * @param {Object} config - Undo system configuration  
   */
  enableUndo(config = {}) {
    if (!this.undoSystem) {
      this.undoSystem = new BufferUndoSystem(this, config.maxUndoLevels);
      if (config) {
        this.undoSystem.configure(config);
      }
    }
  }

  /**
   * Disable undo/redo functionality
   */
  disableUndo() {
    if (this.undoSystem) {
      this.undoSystem.clear();
      this.undoSystem = null;
    }
  }

  /**
   * Begin a named undo transaction
   * @param {string} name - Name/description of the transaction
   * @param {Object} options - Transaction options  
   */
  beginUndoTransaction(name, options = {}) {
    if (this.undoSystem) {
      this.undoSystem.beginUndoTransaction(name, options);
    }
  }

  /**
   * Commit the current undo transaction
   * @param {string} finalName - Optional final name
   * @returns {boolean} - True if transaction was committed
   */
  commitUndoTransaction(finalName = null) {
    if (this.undoSystem) {
      return this.undoSystem.commitUndoTransaction(finalName);
    }
    return false;
  }

  /**
   * Rollback the current undo transaction
   * @returns {Promise<boolean>} - True if transaction was rolled back
   */
  async rollbackUndoTransaction() {
    if (this.undoSystem) {
      return await this.undoSystem.rollbackUndoTransaction();
    }
    return false;
  }

  /**
   * Check if currently in an undo transaction
   * @returns {boolean} - True if in transaction
   */
  inUndoTransaction() {
    return this.undoSystem ? this.undoSystem.inTransaction() : false;
  }

  /**
   * Get current undo transaction info
   * @returns {Object|null} - Transaction info or null
   */
  getCurrentUndoTransaction() {
    return this.undoSystem ? this.undoSystem.getCurrentTransaction() : null;
  }

  /**
   * Undo the last operation
   * @returns {Promise<boolean>} - True if successful
   */
  async undo() {
    if (!this.undoSystem) {
      return false;
    }
    return await this.undoSystem.undo();
  }

  /**
   * Redo the last undone operation
   * @returns {Promise<boolean>} - True if successful
   */
  async redo() {
    if (!this.undoSystem) {
      return false;
    }
    return await this.undoSystem.redo();
  }

  /**
   * Check if undo is available
   * @returns {boolean} - True if undo is available
   */
  canUndo() {
    return this.undoSystem ? this.undoSystem.canUndo() : false;
  }

  /**
   * Check if redo is available
   * @returns {boolean} - True if redo is available
   */
  canRedo() {
    return this.undoSystem ? this.undoSystem.canRedo() : false;
  }

  // =================== UTILITY METHODS ===================

  /**
   * Get total size of buffer
   * @returns {number} - Total size
   */
  getTotalSize() {
    return this.virtualPageManager.getTotalSize();
  }

  /**
   * Get buffer state (data integrity)
   * @returns {string} - Buffer state
   */
  getState() {
    // Validate state consistency
    if (this.state === BufferState.DETACHED && this.missingDataRanges.length === 0) {
      console.warn('Buffer marked as DETACHED but has no missing data ranges');
    }
    
    return this.state;
  }

  /**
   * Check if buffer has unsaved changes
   * @returns {boolean} - True if there are unsaved changes
   */
  hasChanges() {
    return this.hasUnsavedChanges;
  }

  /**
   * Check if buffer can be saved to its original location
   * @returns {boolean} - True if safe to save to original location
   */
  canSaveToOriginal() {
    return this.state !== BufferState.DETACHED;
  }

  /**
   * Get comprehensive buffer status
   * @returns {Object} - Complete status information
   */
  getStatus() {
    return {
      state: this.state,
      hasUnsavedChanges: this.hasUnsavedChanges,
      canSaveToOriginal: this.canSaveToOriginal(),
      isDetached: this.state === BufferState.DETACHED,
      isCorrupted: this.state === BufferState.CORRUPTED,
      missingDataRanges: this.missingDataRanges.length,
      totalSize: this.getTotalSize(),
      filename: this.filename
    };
  }

  /**
   * Get enhanced memory usage stats with line and marks information
   * @returns {Object} - Memory statistics
   */
  getMemoryStats() {
    const vpmStats = this.virtualPageManager.getMemoryStats();
    const lmStats = this.lineAndMarksManager.getMemoryStats();
    
    const undoStats = this.undoSystem ? this.undoSystem.getStats() : {
      undoGroups: 0,
      redoGroups: 0,
      totalUndoOperations: 0,
      totalRedoOperations: 0,
      currentGroupOperations: 0,
      memoryUsage: 0
    };
    
    return {
      // VPM stats
      totalPages: vpmStats.totalPages,
      loadedPages: vpmStats.loadedPages,
      dirtyPages: vpmStats.dirtyPages,
      detachedPages: 0, // Enhanced VPM handles this differently
      memoryUsed: vpmStats.memoryUsed,
      maxMemoryPages: this.maxMemoryPages,
      
      // Line and marks stats
      totalLines: lmStats.totalLines,
      globalMarksCount: lmStats.globalMarksCount,
      linesMemory: vpmStats.linesMemory + lmStats.estimatedLinesCacheMemory,
      marksMemory: vpmStats.marksMemory + lmStats.estimatedMarksMemory,
      lineStartsCacheValid: lmStats.lineStartsCacheValid,
      
      // Buffer stats
      state: this.state,
      hasUnsavedChanges: this.hasUnsavedChanges,
      virtualSize: vpmStats.virtualSize,
      sourceSize: vpmStats.sourceSize,
      
      // Undo stats
      undo: undoStats
    };
  }

  /**
   * Get detachment information
   * @returns {Object} Detachment details
   */
  getDetachmentInfo() {
    return {
      isDetached: this.state === BufferState.DETACHED,
      reason: this.detachmentReason,
      missingRanges: this.missingDataRanges.length,
      totalMissingBytes: this.missingDataRanges.reduce((sum, range) => sum + range.size, 0),
      ranges: this.missingDataRanges.map(range => ({
        virtualStart: range.virtualStart,
        virtualEnd: range.virtualEnd,
        size: range.size,
        reason: range.reason
      }))
    };
  }

  /**
   * Get all notifications
   * @returns {Array} - Array of notifications
   */
  getNotifications() {
    return [...this.notifications];
  }

  /**
   * Clear notifications
   * @param {string} [type] - Optional type filter
   */
  clearNotifications(type = null) {
    if (type) {
      this.notifications = this.notifications.filter(n => n.type !== type);
    } else {
      this.notifications = [];
    }
  }

  /**
   * Set file change handling strategy
   * @param {Object} strategies - Strategy configuration
   */
  setChangeStrategy(strategies) {
    this.changeStrategy = { ...this.changeStrategy, ...strategies };
  }

  // =================== FILE METHODS WITH DETACHED BUFFER SUPPORT ===================

  /**
   * Generate missing data summary for save operations
   * @private
   */
  _generateMissingDataSummary() {
    if (this.missingDataRanges.length === 0) {
      return '';
    }
    
    let summary = '';
    const header = '--- MISSING DATA SUMMARY ---\n';
    
    summary += header;
    
    for (const range of this.missingDataRanges) {
      summary += range.toDescription();
    }
    
    const footer = '--- END MISSING DATA ---\n\n';
    
    summary += footer;
    
    return summary;
  }

  /**
   * Create marker for missing data at a specific position
   * @private
   */
  _createMissingDataMarker(missingRange) {
    const nl = '\n'; // Use newlines for readability
    
    let marker = `${nl}--- MISSING ${missingRange.size.toLocaleString()} BYTES `;
    marker += `FROM BUFFER ADDRESS ${missingRange.virtualStart.toLocaleString()} `;
    
    if (missingRange.originalFileStart !== null) {
      marker += `(ORIGINAL FILE POSITION ${missingRange.originalFileStart.toLocaleString()}) `;
    }
    
    if (missingRange.reason && missingRange.reason !== 'unknown') {
      marker += `- REASON: ${missingRange.reason.toUpperCase()} `;
    }
    
    marker += `---${nl}`;
    marker += `--- BEGIN DATA BELONGING AT BUFFER ADDRESS ${missingRange.virtualEnd.toLocaleString()} ---${nl}`;
    
    return marker;
  }

  /**
   * Create marker for missing data at end of file
   * @private
   */
  _createEndOfFileMissingMarker(lastRange, totalSize) {
    const nl = '\n';
    const missingAtEnd = lastRange.virtualEnd - totalSize;
    
    if (missingAtEnd <= 0) return '';
    
    let marker = `${nl}--- MISSING ${missingAtEnd.toLocaleString()} BYTES AT END OF FILE `;
    
    if (lastRange.originalFileStart !== null) {
      const originalEnd = lastRange.originalFileEnd || (lastRange.originalFileStart + lastRange.size);
      const missingOriginalAtEnd = originalEnd - (lastRange.originalFileStart + (totalSize - lastRange.virtualStart));
      if (missingOriginalAtEnd > 0) {
        marker += `(ORIGINAL FILE BYTES ${(originalEnd - missingOriginalAtEnd).toLocaleString()} TO ${originalEnd.toLocaleString()}) `;
      }
    }
    
    if (lastRange.reason && lastRange.reason !== 'unknown') {
      marker += `- REASON: ${lastRange.reason.toUpperCase()} `;
    }
    
    marker += `---${nl}`;
    
    return marker;
  }

  /**
   * Create emergency marker for data that became unavailable during save
   * @private
   */
  _createEmergencyMissingMarker(startPos, endPos, reason) {
    const nl = '\n';
    const size = endPos - startPos;
    
    let marker = `${nl}--- EMERGENCY: ${size.toLocaleString()} BYTES UNAVAILABLE DURING SAVE `;
    marker += `FROM BUFFER ADDRESS ${startPos.toLocaleString()} `;
    marker += `- REASON: ${reason.toUpperCase()} ---${nl}`;
    marker += `--- BEGIN DATA BELONGING AT BUFFER ADDRESS ${endPos.toLocaleString()} ---${nl}`;
    
    // Add this as a new missing range for future reference
    const emergencyRange = new MissingDataRange(
      startPos, 
      endPos, 
      startPos, 
      endPos, 
      `save_failure: ${reason}`
    );
    
    if (!this.missingDataRanges.some(range => 
      range.virtualStart === startPos && range.virtualEnd === endPos)) {
      this.missingDataRanges.push(emergencyRange);
      this._mergeMissingRanges();
    }
    
    return marker;
  }

  /**
   * Write data with markers indicating where missing data belongs - FIXED for large files
   * @private
   */
  async _writeDataWithMissingMarkers(fd) {
    const totalSize = this.getTotalSize();
    if (totalSize === 0) return;
    
    // Calculate maximum chunk size to prevent memory issues
    const maxChunkSize = this.pageSize * this.maxMemoryPages;
    console.log(`Writing file with chunk size: ${maxChunkSize.toLocaleString()} bytes`);
    
    // Sort missing ranges by position for proper insertion
    const sortedMissingRanges = [...this.missingDataRanges].sort((a, b) => 
      a.virtualStart - b.virtualStart
    );
    
    let currentPos = 0;
    let missingRangeIndex = 0;
    
    while (currentPos < totalSize || missingRangeIndex < sortedMissingRanges.length) {
      // Check if we've reached a missing data range
      if (missingRangeIndex < sortedMissingRanges.length) {
        const missingRange = sortedMissingRanges[missingRangeIndex];
        
        if (currentPos === missingRange.virtualStart) {
          // Insert missing data marker
          const marker = this._createMissingDataMarker(missingRange);
          await fd.write(Buffer.from(marker));
          
          // Skip over the missing range
          currentPos = missingRange.virtualEnd;
          missingRangeIndex++;
          continue;
        }
      }
      
      // Find the next chunk boundary (either to end or to next missing range)
      let segmentEnd = totalSize;
      if (missingRangeIndex < sortedMissingRanges.length) {
        segmentEnd = Math.min(segmentEnd, sortedMissingRanges[missingRangeIndex].virtualStart);
      }
      
      if (currentPos < segmentEnd) {
        // FIXED: Write available data in chunks to prevent memory/buffer issues
        await this._writeSegmentInChunks(fd, currentPos, segmentEnd, maxChunkSize);
        currentPos = segmentEnd;
      } else {
        break;
      }
    }
    
    // Check for missing data at the end of file
    if (sortedMissingRanges.length > 0) {
      const lastRange = sortedMissingRanges[sortedMissingRanges.length - 1];
      if (lastRange.virtualEnd >= totalSize) {
        const endMarker = this._createEndOfFileMissingMarker(lastRange, totalSize);
        await fd.write(Buffer.from(endMarker));
      }
    }
  }

  /**
   * Write a segment of data in manageable chunks
   * @param {fs.FileHandle} fd - File handle to write to
   * @param {number} startPos - Start position in virtual buffer
   * @param {number} endPos - End position in virtual buffer  
   * @param {number} maxChunkSize - Maximum size per chunk
   * @private
   */
  async _writeSegmentInChunks(fd, startPos, endPos, maxChunkSize) {
    let chunkStart = startPos;
    
    while (chunkStart < endPos) {
      // Calculate this chunk's end (don't exceed segment boundary or max chunk size)
      const chunkEnd = Math.min(chunkStart + maxChunkSize, endPos);
      const chunkSize = chunkEnd - chunkStart;
      
      try {
        // Read this chunk from the virtual page manager
        const chunk = await this.virtualPageManager.readRange(chunkStart, chunkEnd);
        
        if (chunk.length > 0) {
          await fd.write(chunk);
          
          // Progress logging for large files
          if (chunkSize > 1024 * 1024) { // Log for chunks > 1MB
            const progress = ((chunkEnd - startPos) / (endPos - startPos) * 100).toFixed(1);
            console.log(`Written ${chunkEnd.toLocaleString()} / ${endPos.toLocaleString()} bytes (${progress}%)`);
          }
        }
        
      } catch (error) {
        // Data became unavailable during save - add an emergency marker
        console.warn(`Data unavailable for chunk ${chunkStart}-${chunkEnd}: ${error.message}`);
        const emergencyMarker = this._createEmergencyMissingMarker(chunkStart, chunkEnd, error.message);
        await fd.write(Buffer.from(emergencyMarker));
      }
      
      chunkStart = chunkEnd;
      
      // CRITICAL: Yield control periodically to prevent event loop blocking
      if (chunkStart % (maxChunkSize * 10) === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
  }
  
  /**
   * Enhanced save method with smart behavior and atomic operations
   */
  async saveFile(filename = this.filename, options = {}) {
    if (!filename) {
      throw new Error('No filename specified');
    }

    // CRITICAL: Check for detached buffer trying to save to original path
    if (this.state === BufferState.DETACHED) {
      const isOriginalFile = this.filename && path.resolve(filename) === path.resolve(this.filename);
      
      if (isOriginalFile && !options.forcePartialSave) {
        throw new Error(
          `Refusing to save to original file path with partial data. ` +
          `Missing ${this.missingDataRanges.length} data range(s). ` +
          `Use saveAs() to save to a different location, or pass forcePartialSave=true to override.`
        );
      }
    }

    // SMART SAVE: If saving to same file and buffer is clean with no changes, it's a no-op
    const isSameFile = this.filename && path.resolve(filename) === path.resolve(this.filename);
    if (isSameFile && this.state === BufferState.CLEAN && !this.hasUnsavedChanges && this.filename) {
      // File is unmodified and we're saving to the same location - no need to save
      this._notify(
        'save_skipped',
        'info',
        'Save skipped: buffer is unmodified',
        { filename, reason: 'unmodified_same_file' }
      );
      return;
    }

    if (isSameFile) {
      await this._performAtomicSave(filename, options);
    } else {
      await this._performSave(filename, options);
    }
  }

  /**
   * Enhanced saveAs that handles detached buffers gracefully
   */
  async saveAs(filename, forcePartialOrOptions = {}, options = {}) {
    if (!filename) {
      throw new Error('Filename required for saveAs operation');
    }

    let saveOptions = {};
    
    if (typeof forcePartialOrOptions === 'boolean') {
      // Legacy boolean parameter - ignore it for saveAs
      saveOptions = { ...options };
    } else {
      saveOptions = { ...forcePartialOrOptions };
    }

    // saveAs always allows saving detached buffers - that's the point
    await this._performSave(filename, { ...saveOptions, allowDetached: true });
  }

  /**
   * Enhanced save method with positional missing data markers
   * @private
   */
  async _performSave(filename, options = {}) {
    const fd = await fs.open(filename, 'w');
    
    try {
      // For detached buffers, add missing data summary at the beginning
      if (this.state === BufferState.DETACHED && this.missingDataRanges.length > 0) {
        const summary = this._generateMissingDataSummary();
        await fd.write(Buffer.from(summary));
        
        this._notify(
          'detached_save_summary',
          'info',
          `Added missing data summary to saved file: ${this.missingDataRanges.length} missing range(s)`,
          { 
            filename, 
            missingRanges: this.missingDataRanges.length,
            summarySize: summary.length
          }
        );
      }
      
      // Write data with positional markers for missing ranges
      await this._writeDataWithMissingMarkers(fd);
      
    } finally {
      await fd.close();
    }
    
    // Update metadata after successful save
    const stats = await fs.stat(filename);
    this.filename = filename;
    this.fileSize = stats.size;
    this.fileMtime = stats.mtime;
    this.totalSize = this.virtualPageManager.getTotalSize(); // Keep VPM as source of truth
    
    // Mark as saved (no unsaved changes)
    this._markAsSaved();
    
    // Only mark as clean if we're not detached
    if (this.state !== BufferState.DETACHED) {
      this.state = BufferState.CLEAN;
    }
  }

  /**
   * Atomic save that uses temporary copy to prevent corruption
   */
  async _performAtomicSave(filename, options = {}) {
    let tempCopyPath = null;
    
    try {
      // Step 1: Create temporary copy of original file (if it exists and we need it)
      if (await this._fileExists(filename)) {
        tempCopyPath = await this._createTempCopy(filename);
        
        this._notify(
          'atomic_save_started',
          'info',
          `Created temporary copy for atomic save: ${tempCopyPath}`,
          { originalFile: filename, tempCopy: tempCopyPath }
        );
      }

      // Step 2: Update VPM to use temp copy for original file reads
      if (tempCopyPath) {
        this._updateVPMSourceFile(tempCopyPath);
      }

      // Step 3: Perform the actual save
      await this._performSave(filename, { ...options, isAtomicSave: true });

      // Step 4: Update metadata and state after successful save
      await this._updateMetadataAfterSave(filename);

    } catch (error) {
      // If atomic save fails, we need to restore the VPM source
      if (tempCopyPath) {
        this._updateVPMSourceFile(filename); // Restore original
      }
      throw error;
    } finally {
      // Step 5: Always cleanup temp copy
      if (tempCopyPath) {
        await this._cleanupTempCopy(tempCopyPath);
      }
    }
  }
  
  /**
   * Create a temporary copy of the original file
   */
  async _createTempCopy(originalPath) {
    const tempDir = os.tmpdir();
    const baseName = path.basename(originalPath);
    const tempName = `paged-buffer-${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${baseName}`;
    const tempPath = path.join(tempDir, tempName);
    
    await fs.copyFile(originalPath, tempPath);
    return tempPath;
  }

  /**
   * Update VPM to use a different source file path
   */
  _updateVPMSourceFile(newPath) {
    // Update all original-type page descriptors to use the new path
    for (const descriptor of this.virtualPageManager.addressIndex.getAllPages()) {
      if (descriptor.sourceType === 'original' && descriptor.sourceInfo.filename) {
        descriptor.sourceInfo.filename = newPath;
      }
    }
    
    // Update manager's source file reference
    this.virtualPageManager.sourceFile = newPath;
  }
  
  /**
   * Cleanup temporary copy
   */
  async _cleanupTempCopy(tempPath) {
    try {
      await fs.unlink(tempPath);
      
      this._notify(
        'temp_cleanup',
        'debug',
        `Cleaned up temporary copy: ${tempPath}`,
        { tempPath }
      );
    } catch (error) {
      // Log warning but don't fail the save
      this._notify(
        'temp_cleanup_failed',
        'warning',
        `Failed to cleanup temporary copy: ${error.message}`,
        { tempPath, error: error.message }
      );
    }
  }

  /**
   * Update metadata after successful save
   */
  async _updateMetadataAfterSave(filename) {
    try {
      const stats = await fs.stat(filename);
      this.filename = filename;
      this.fileSize = stats.size;
      this.fileMtime = stats.mtime;
      
      // Mark as saved
      this._markAsSaved();
      
      // CRITICAL: Mark buffer as clean after successful save (unless detached)
      if (this.state !== BufferState.DETACHED) {
        this.state = BufferState.CLEAN;
      }
      
      // Update VPM source to point back to the saved file
      this._updateVPMSourceFile(filename);
      
      this._notify(
        'save_completed',
        'info',
        `Successfully saved to ${filename}`,
        { 
          filename, 
          size: stats.size, 
          newState: this.state,
          hasUnsavedChanges: this.hasUnsavedChanges,
          wasAtomic: true 
        }
      );
      
    } catch (error) {
      this._notify(
        'save_metadata_update_failed',
        'warning',
        `Save succeeded but metadata update failed: ${error.message}`,
        { filename, error: error.message }
      );
    }
  }

  /**
   * Check if file exists
   */
  async _fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Method to manually mark buffer as clean (for testing/special cases)
   */
  _markAsClean() {
    if (this.state !== BufferState.DETACHED) {
      this.state = BufferState.CLEAN;
    }
    this._markAsSaved();
  }

  /**
   * Method to check if buffer has been modified
   * @deprecated Use hasChanges() instead
   */
  isModified() {
    return this.hasUnsavedChanges;
  }

  /**
   * Method to check if buffer is detached
   */
  isDetached() {
    return this.state === BufferState.DETACHED;
  }

  /**
   * Method to check if buffer is clean
   */
  isClean() {
    return this.state === BufferState.CLEAN && !this.hasUnsavedChanges;
  }

// =================== SYNCHRONOUS LINE OPERATIONS API ===================

  /**
   * Get total number of lines in the buffer (SYNCHRONOUS)
   * @returns {number} - Total line count
   */
  getLineCount() {
    return this.lineAndMarksManager.getTotalLineCount();
  }

  /**
   * Get line start positions (byte offsets) (SYNCHRONOUS)
   * @returns {number[]} - Array of byte positions where each line starts
   */
  getLineStarts() {
    return this.lineAndMarksManager.getLineStarts();
  }

  /**
   * Get information about a specific line (SYNCHRONOUS)
   * @param {number} lineNumber - Line number (1-based)
   * @returns {LineOperationResult|null} - Line info or null if not found
   */
  getLineInfo(lineNumber) {
    return this.lineAndMarksManager.getLineInfo(lineNumber);
  }

  /**
   * Get information about multiple lines at once (SYNCHRONOUS)
   * @param {number} startLine - Start line number (1-based, inclusive)
   * @param {number} endLine - End line number (1-based, inclusive)
   * @returns {LineOperationResult[]} - Array of line info
   */
  getMultipleLines(startLine, endLine) {
    return this.lineAndMarksManager.getMultipleLines(startLine, endLine);
  }

  /**
   * Get line start addresses for a range of lines (SYNCHRONOUS)
   * @param {number} startLine - Start line number (1-based)
   * @param {number} endLine - End line number (1-based, inclusive)
   * @returns {number[]} - Array of start addresses
   */
  getLineAddresses(startLine, endLine) {
    return this.lineAndMarksManager.getLineAddresses(startLine, endLine);
  }

  /**
   * Convert byte address to line number (SYNCHRONOUS)
   * @param {number} byteAddress - Byte address in buffer
   * @returns {number} - Line number (1-based) or 0 if invalid
   */
  getLineNumberFromAddress(byteAddress) {
    return this.lineAndMarksManager.getLineNumberFromAddress(byteAddress);
  }

  /**
   * Convert line/character position to absolute byte position (SYNCHRONOUS)
   * @param {Object} pos - {line, character} (both 1-based)
   * @param {number[]} lineStarts - Cached line starts (optional)
   * @returns {number} - Absolute byte position
   */
  lineCharToBytePosition(pos, lineStarts = null) {
    return this.lineAndMarksManager.lineCharToBytePosition(pos, lineStarts);
  }

  /**
   * Convert absolute byte position to line/character position (SYNCHRONOUS)
   * @param {number} bytePos - Absolute byte position
   * @param {number[]} lineStarts - Cached line starts (optional)
   * @returns {Object} - {line, character} (both 1-based)
   */
  byteToLineCharPosition(bytePos, lineStarts = null) {
    return this.lineAndMarksManager.byteToLineCharPosition(bytePos, lineStarts);
  }

  // =================== SYNCHRONOUS CONVENIENCE LINE METHODS ===================

  /**
   * Insert content with line/character position (SYNCHRONOUS convenience method)
   * @param {Object} pos - {line, character} (both 1-based)
   * @param {string} text - Text to insert
   * @param {number[]} lineStarts - Cached line starts (optional)
   * @returns {Promise<{newPosition: Object, newLineStarts: number[]}>}
   */
  async insertTextAtPosition(pos, text, lineStarts = null) {
    if (!lineStarts) {
      lineStarts = this.getLineStarts(); // Now synchronous!
    }

    const bytePos = this.lineCharToBytePosition(pos, lineStarts); // Now synchronous!
    const textBuffer = Buffer.from(text, 'utf8');
    
    await this.insertBytes(bytePos, textBuffer);
    
    const newLineStarts = this.getLineStarts(); // Now synchronous!
    const newBytePos = bytePos + textBuffer.length;
    const newPosition = this.byteToLineCharPosition(newBytePos, newLineStarts); // Now synchronous!
    
    return { newPosition, newLineStarts };
  }

  /**
   * Delete content between line/character positions (SYNCHRONOUS convenience method)
   * @param {Object} startPos - {line, character} (both 1-based)
   * @param {Object} endPos - {line, character} (both 1-based)
   * @param {number[]} lineStarts - Cached line starts (optional)
   * @returns {Promise<{deletedText: string, newLineStarts: number[]}>}
   */
  async deleteTextBetweenPositions(startPos, endPos, lineStarts = null) {
    if (!lineStarts) {
      lineStarts = this.getLineStarts(); // Now synchronous!
    }

    const startByte = this.lineCharToBytePosition(startPos, lineStarts); // Now synchronous!
    const endByte = this.lineCharToBytePosition(endPos, lineStarts); // Now synchronous!
    
    const deletedBytes = await this.deleteBytes(startByte, endByte);
    const deletedText = deletedBytes.toString('utf8');
    
    const newLineStarts = this.getLineStarts(); // Now synchronous!
    
    return { deletedText, newLineStarts };
  }

}

// Export the MissingDataRange class as well for testing
module.exports = { PagedBuffer, MissingDataRange };
