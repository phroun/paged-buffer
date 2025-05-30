/**
 * @fileoverview PagedBuffer - Enhanced with Detached Buffer System and Refactored State Management
 * @description High-performance buffer with robust data loss tracking and transparent reporting
 * @author Jeffrey R. Day
 * @version 2.1.0
 */

const fs = require('fs').promises;
const crypto = require('crypto');
const path = require('path');

const { 
  BufferMode, 
  BufferState, 
  FileChangeStrategy 
} = require('./types/buffer-types');

const { NotificationType, BufferNotification } = require('./types/notifications');
const { PageStorage } = require('./storage/page-storage');
const { MemoryPageStorage } = require('./storage/memory-page-storage');
const { VirtualPageManager } = require('./virtual-page-manager');

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
  toDescription(mode = BufferMode.BINARY) {
    const sizeDesc = this.size === 1 ? '1 byte' : `${this.size.toLocaleString()} bytes`;
    let desc = `[Missing ${sizeDesc} from buffer addresses ${this.virtualStart.toLocaleString()} to ${this.virtualEnd.toLocaleString()}`;
    
    if (this.originalFileStart !== null && this.originalFileEnd !== null) {
      desc += `, original file positions ${this.originalFileStart.toLocaleString()} to ${this.originalFileEnd.toLocaleString()}`;
    }
    
    if (this.reason !== 'unknown') {
      desc += `, reason: ${this.reason}`;
    }
    
    desc += '.]';
    
    if (mode === BufferMode.UTF8) {
      desc += '\n';
    }
    
    return desc;
  }
}

/**
 * PagedBuffer - Enhanced with Virtual Page Manager and refactored state management
 */
class PagedBuffer {
  constructor(pageSize = 64 * 1024, storage = null, maxMemoryPages = 100) {
    this.pageSize = pageSize;
    this.storage = storage || new MemoryPageStorage();
    this.maxMemoryPages = maxMemoryPages;
    
    // Buffer mode
    this.mode = BufferMode.BINARY;
    
    // File metadata
    this.filename = null;
    this.fileSize = 0;
    this.fileMtime = null;
    this.fileChecksum = null;
    
    // Virtual Page Manager (replaces old page management)
    this.virtualPageManager = new VirtualPageManager(this, pageSize);
    this.virtualPageManager.maxLoadedPages = maxMemoryPages;
    
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
   * Detect buffer mode from content
   * @param {Buffer} sampleData - Sample of file content
   * @returns {string} - BufferMode.BINARY or BufferMode.UTF8
   */
  _detectMode(sampleData) {
    // Check for null bytes (strong indicator of binary)
    for (let i = 0; i < Math.min(sampleData.length, 8192); i++) {
      if (sampleData[i] === 0) {
        return BufferMode.BINARY;
      }
    }
    
    // Try to decode as UTF-8
    try {
      const text = sampleData.toString('utf8');
      if (text.includes('\uFFFD')) {
        return BufferMode.BINARY;
      }
      return BufferMode.UTF8;
    } catch {
      return BufferMode.BINARY;
    }
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
   * @param {string} [mode] - Force specific mode, or auto-detect
   */
  async loadFile(filename, mode = null) {
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
      
      // Detect or set buffer mode
      if (mode) {
        this.mode = mode;
      } else if (stats.size > 0) {
        const fd = await fs.open(filename, 'r');
        const sampleBuffer = Buffer.alloc(Math.min(8192, stats.size));
        await fd.read(sampleBuffer, 0, sampleBuffer.length, 0);
        await fd.close();
        
        this.mode = this._detectMode(sampleBuffer);
      } else {
        // Empty file defaults to UTF8
        this.mode = BufferMode.UTF8;
      }
      
      // Calculate file checksum
      this.fileChecksum = await this._calculateFileChecksum(filename);
      
      // Initialize Virtual Page Manager from file
      this.virtualPageManager.initializeFromFile(filename, stats.size, this.fileChecksum);
      
      this._notify(
        NotificationType.FILE_MODIFIED_ON_DISK,
        'info',
        `Loaded file in ${this.mode} mode`,
        { filename, mode: this.mode, size: stats.size, state: this.state, hasUnsavedChanges: this.hasUnsavedChanges }
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
    this.mode = BufferMode.UTF8;
    
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
      `Loaded content in ${this.mode} mode`,
      { mode: this.mode, size: this.totalSize, state: this.state, hasUnsavedChanges: this.hasUnsavedChanges }
    );
  }

  /**
   * Enhanced loadBinaryContent with proper initial state
   */
  loadBinaryContent(content) {
    this.filename = null;
    this.totalSize = content.length;
    this.mode = BufferMode.BINARY;
    
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
      { mode: this.mode, size: this.totalSize, state: this.state, hasUnsavedChanges: this.hasUnsavedChanges }
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

  // =================== CORE BYTE OPERATIONS (Enhanced with VPM) ===================

  /**
   * Get bytes from absolute position with detachment detection
   * @param {number} start - Start byte position
   * @param {number} end - End byte position
   * @returns {Promise<Buffer>} - Data
   */
  async getBytes(start, end) {
    if (start < 0 || end < 0) {
      throw new Error('Invalid range: positions cannot be negative');
    }
    if (start > end) {
      return Buffer.alloc(0);
    }
    if (start >= this.totalSize) {
      return Buffer.alloc(0);
    }
    if (end > this.totalSize) {
      end = this.totalSize;
    }
    
    try {
      return await this.virtualPageManager.readRange(start, end);
    } catch (error) {
      // CRITICAL: If VPM fails to read data, this triggers detachment
      // The VPM should have already called _markAsDetached through _handleCorruption
      // So we just return empty buffer here
      return Buffer.alloc(0);
    }
  }

  /**
   * Insert bytes at absolute position
   * @param {number} position - Insertion position
   * @param {Buffer} data - Data to insert
   */
  async insertBytes(position, data) {
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

    // Use Virtual Page Manager for insertion
    const sizeChange = await this.virtualPageManager.insertAt(position, data);
    
    // Update buffer state
    this.totalSize += sizeChange;
    this._markAsModified();
    
    // Record the operation AFTER executing it
    if (this.undoSystem) {
      this.undoSystem.recordInsert(originalPosition, originalData, timestamp);
    }
  }

  /**
   * Enhanced deleteBytes with proper state transition
   */
  async deleteBytes(start, end) {
    if (start < 0 || end < 0) {
      throw new Error('Invalid range: positions cannot be negative');  
    }
    if (start > end) {
      throw new Error('Invalid range: start position must be less than or equal to end position');
    }
    if (start >= this.totalSize) {
      return Buffer.alloc(0);
    }
    if (end > this.totalSize) {
      end = this.totalSize;
    }

    // Capture values before execution for undo recording
    const originalStart = start;
    const timestamp = this.undoSystem ? this.undoSystem.getClock() : Date.now();

    // Use Virtual Page Manager for deletion
    const deletedData = await this.virtualPageManager.deleteRange(start, end);
    
    // Update buffer state
    this.totalSize -= deletedData.length;
    this._markAsModified();
    
    // Record the operation AFTER executing it
    if (this.undoSystem) {
      this.undoSystem.recordDelete(originalStart, deletedData, timestamp);
    }
    
    return deletedData;
  }

  /**
   * Enhanced overwriteBytes with proper state transition
   */
  async overwriteBytes(position, data) {
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

    const endPos = Math.min(position + data.length, this.totalSize);
    const overwrittenData = await this.getBytes(position, endPos);
    
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
    
    // The delete/insert operations above already marked as modified
    
    // Record the operation AFTER executing it
    if (this.undoSystem) {
      this.undoSystem.recordOverwrite(originalPosition, originalData, overwrittenData, timestamp);
    }
    
    return overwrittenData;
  }

  // =================== MINIMAL LINE INFORMATION API ===================

  /**
   * Get line start positions (byte offsets) for UTF-8 files
   * @returns {Promise<number[]>} - Array of byte positions where each line starts
   */
  async getLineStarts() {
    if (this.mode !== BufferMode.UTF8) {
      return [0];
    }

    const lineStarts = [0];
    const totalSize = this.getTotalSize();
    
    if (totalSize === 0) {
      return lineStarts;
    }

    const chunkSize = 64 * 1024;

    for (let pos = 0; pos < totalSize; pos += chunkSize) {
      const endPos = Math.min(pos + chunkSize, totalSize);
      const chunk = await this.getBytes(pos, endPos);
      
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 0x0A) {
          const nextLineStart = pos + i + 1;
          lineStarts.push(nextLineStart);
        }
      }
    }

    return lineStarts;
  }

  /**
   * Get total line count
   * @returns {Promise<number>} - Number of lines
   */
  async getLineCount() {
    const lineStarts = await this.getLineStarts();
    return lineStarts.length;
  }

  /**
   * Convert line/character position to absolute byte position
   * @param {Object} pos - {line, character}
   * @param {number[]} lineStarts - Cached line starts (optional)
   * @returns {Promise<number>} - Absolute byte position
   */
  async lineCharToBytePosition({line, character}, lineStarts = null) {
    if (this.mode !== BufferMode.UTF8) {
      throw new Error('Line/character positioning only available in UTF-8 mode');
    }

    if (!lineStarts) {
      lineStarts = await this.getLineStarts();
    }

    if (line >= lineStarts.length) {
      return this.getTotalSize();
    }

    const lineStartByte = lineStarts[line];
    
    if (character === 0) {
      return lineStartByte;
    }

    let lineEndByte;
    if (line + 1 < lineStarts.length) {
      lineEndByte = lineStarts[line + 1] - 1;
    } else {
      lineEndByte = this.getTotalSize();
    }

    if (lineStartByte >= lineEndByte) {
      return lineStartByte;
    }

    const lineBytes = await this.getBytes(lineStartByte, lineEndByte);
    const lineText = lineBytes.toString('utf8');
    
    if (character >= lineText.length) {
      return lineEndByte;
    }

    const characterBytes = Buffer.byteLength(lineText.substring(0, character), 'utf8');
    return lineStartByte + characterBytes;
  }

  /**
   * Convert absolute byte position to line/character position
   * @param {number} bytePos - Absolute byte position
   * @param {number[]} lineStarts - Cached line starts (optional)
   * @returns {Promise<Object>} - {line, character}
   */
  async byteToLineCharPosition(bytePos, lineStarts = null) {
    if (this.mode !== BufferMode.UTF8) {
      throw new Error('Line/character positioning only available in UTF-8 mode');
    }

    if (!lineStarts) {
      lineStarts = await this.getLineStarts();
    }

    let left = 0;
    let right = lineStarts.length - 1;
    
    while (left < right) {
      const mid = Math.floor((left + right + 1) / 2);
      if (lineStarts[mid] <= bytePos) {
        left = mid;
      } else {
        right = mid - 1;
      }
    }

    const line = left;
    const lineStartByte = lineStarts[line];
    const byteOffsetInLine = bytePos - lineStartByte;
    
    if (byteOffsetInLine === 0) {
      return {line, character: 0};
    }

    let lineEndByte;
    if (line + 1 < lineStarts.length) {
      lineEndByte = lineStarts[line + 1] - 1;
    } else {
      lineEndByte = this.getTotalSize();
    }

    if (bytePos >= lineEndByte) {
      const lineBytes = await this.getBytes(lineStartByte, lineEndByte);
      const lineText = lineBytes.toString('utf8');
      return {line, character: lineText.length};
    }

    const lineBytes = await this.getBytes(lineStartByte, Math.min(lineStartByte + byteOffsetInLine, lineEndByte));
    const partialText = lineBytes.toString('utf8');
    
    return {line, character: partialText.length};
  }

  /**
   * Insert content with line/character position (convenience method)
   * @param {Object} pos - {line, character}
   * @param {string} text - Text to insert
   * @param {number[]} lineStarts - Cached line starts (optional)
   * @returns {Promise<{newPosition: Object, newLineStarts: number[]}>}
   */
  async insertTextAtPosition(pos, text, lineStarts = null) {
    if (!lineStarts) {
      lineStarts = await this.getLineStarts();
    }

    const bytePos = await this.lineCharToBytePosition(pos, lineStarts);
    const textBuffer = Buffer.from(text, 'utf8');
    
    await this.insertBytes(bytePos, textBuffer);
    
    const newLineStarts = await this.getLineStarts();
    const newBytePos = bytePos + textBuffer.length;
    const newPosition = await this.byteToLineCharPosition(newBytePos, newLineStarts);
    
    return {newPosition, newLineStarts};
  }

  /**
   * Delete content between line/character positions (convenience method)
   * @param {Object} startPos - {line, character}
   * @param {Object} endPos - {line, character}
   * @param {number[]} lineStarts - Cached line starts (optional)
   * @returns {Promise<{deletedText: string, newLineStarts: number[]}>}
   */
  async deleteTextBetweenPositions(startPos, endPos, lineStarts = null) {
    if (!lineStarts) {
      lineStarts = await this.getLineStarts();
    }

    const startByte = await this.lineCharToBytePosition(startPos, lineStarts);
    const endByte = await this.lineCharToBytePosition(endPos, lineStarts);
    
    const deletedBytes = await this.deleteBytes(startByte, endByte);
    const deletedText = deletedBytes.toString('utf8');
    
    const newLineStarts = await this.getLineStarts();
    
    return {deletedText, newLineStarts};
  }

  // =================== UNDO/REDO SYSTEM ===================

  /**
   * Enable undo/redo functionality
   * @param {Object} config - Undo system configuration  
   */
  enableUndo(config = {}) {
    if (!this.undoSystem) {
      const { BufferUndoSystem } = require('./undo-system');
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
      filename: this.filename,
      mode: this.mode
    };
  }

  /**
   * Get buffer mode
   * @returns {string} - Buffer mode
   */
  getMode() {
    return this.mode;
  }

  /**
   * Get memory usage stats
   * @returns {Object} - Memory statistics
   */
  getMemoryStats() {
    const vpmStats = this.virtualPageManager.getMemoryStats();
    
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
      detachedPages: 0, // VPM handles this differently
      memoryUsed: vpmStats.memoryUsed,
      maxMemoryPages: this.maxMemoryPages,
      
      // Buffer stats
      state: this.state,
      hasUnsavedChanges: this.hasUnsavedChanges,
      mode: this.mode,
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
    const header = this.mode === BufferMode.UTF8 ? 
      '--- MISSING DATA SUMMARY ---\n' : 
      '--- MISSING DATA SUMMARY ---\n';
    
    summary += header;
    
    for (const range of this.missingDataRanges) {
      summary += range.toDescription(this.mode);
    }
    
    const footer = this.mode === BufferMode.UTF8 ? 
      '--- END MISSING DATA ---\n\n' : 
      '--- END MISSING DATA ---\n\n';
    
    summary += footer;
    
    return summary;
  }

  /**
   * Create marker for missing data at a specific position
   * @private
   */
  _createMissingDataMarker(missingRange) {
    const nl = '\n'; // Use newlines even for binary for readability
    
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
   * Write data with markers indicating where missing data belongs
   * @private
   */
  async _writeDataWithMissingMarkers(fd) {
    const totalSize = this.getTotalSize();
    if (totalSize === 0) return;
    
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
      
      // Find the next chunk to write (either to end or to next missing range)
      let chunkEnd = totalSize;
      if (missingRangeIndex < sortedMissingRanges.length) {
        chunkEnd = Math.min(chunkEnd, sortedMissingRanges[missingRangeIndex].virtualStart);
      }
      
      if (currentPos < chunkEnd) {
        // Write available data chunk
        try {
          const chunk = await this.virtualPageManager.readRange(currentPos, chunkEnd);
          if (chunk.length > 0) {
            await fd.write(chunk);
          }
        } catch (error) {
          // Data became unavailable during save - add an emergency marker
          const emergencyMarker = this._createEmergencyMissingMarker(currentPos, chunkEnd, error.message);
          await fd.write(Buffer.from(emergencyMarker));
        }
        
        currentPos = chunkEnd;
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
    const fs = require('fs').promises;
    const os = require('os');
    
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
      const fs = require('fs').promises;
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
    const fs = require('fs').promises;
    
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
      const fs = require('fs').promises;
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

}

// Export the MissingDataRange class as well for testing
module.exports = { PagedBuffer, MissingDataRange };
