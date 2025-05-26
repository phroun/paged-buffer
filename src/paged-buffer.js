/**
 * PagedBuffer - High-performance buffer for massive files
 * Provides byte-level operations with minimal line information for calling libraries
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
const { PageInfo } = require('./utils/page-info');

/**
 * PagedBuffer - Core buffer implementation with byte-level operations
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
    
    // Page management
    this.pages = new Map();
    this.pageOrder = [];
    this.nextPageId = 0;
    
    // Virtual file state
    this.totalSize = 0;
    this.state = BufferState.CLEAN;
    
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
    const stats = await fs.stat(filename);
    this.filename = filename;
    this.fileSize = stats.size;
    this.fileMtime = stats.mtime;
    this.totalSize = stats.size;
    this.lastFileCheck = Date.now();
    
    // Detect or set buffer mode
    if (mode) {
      this.mode = mode;
    } else {
      const fd = await fs.open(filename, 'r');
      const sampleBuffer = Buffer.alloc(Math.min(8192, stats.size));
      await fd.read(sampleBuffer, 0, sampleBuffer.length, 0);
      await fd.close();
      
      this.mode = this._detectMode(sampleBuffer);
    }
    
    this._notify(
      NotificationType.FILE_MODIFIED_ON_DISK,
      'info',
      `Loaded file in ${this.mode} mode`,
      { filename, mode: this.mode, size: stats.size }
    );
    
    // Calculate file checksum
    this.fileChecksum = await this._calculateFileChecksum(filename);
    
    // Create page structure
    await this._createPageStructure(filename);
    
    this.state = BufferState.CLEAN;
  }

  /**
   * Load content from string
   * @param {string} content - Text content
   */
  loadContent(content) {
    this.lines = content.split(/\r?\n/);
    this.originalLines = [...this.lines];
    this.filename = null;
    this.totalSize = Buffer.byteLength(content, 'utf8');
    this.mode = BufferMode.UTF8;
    this.state = BufferState.CLEAN;
    
    // Create single page for content
    this.pages.clear();
    this.pageOrder = [];
    this.nextPageId = 0;
    
    const pageId = `page_${this.nextPageId++}`;
    const contentBuffer = Buffer.from(content, 'utf8');
    const checksum = PageInfo.calculateChecksum(contentBuffer);
    const pageInfo = new PageInfo(pageId, 0, contentBuffer.length, checksum);
    pageInfo.updateData(contentBuffer, this.mode);
    
    this.pages.set(pageId, pageInfo);
  }

  /**
   * Create page structure by scanning file
   * @param {string} filename - Source file
   */
  async _createPageStructure(filename) {
    const fd = await fs.open(filename, 'r');
    let offset = 0;
    
    try {
      while (offset < this.fileSize) {
        const pageId = `page_${this.nextPageId++}`;
        const readSize = Math.min(this.pageSize, this.fileSize - offset);
        
        const buffer = Buffer.alloc(readSize);
        await fd.read(buffer, 0, readSize, offset);
        
        const checksum = PageInfo.calculateChecksum(buffer);
        const pageInfo = new PageInfo(pageId, offset, readSize, checksum);
        
        this.pages.set(pageId, pageInfo);
        offset += readSize;
      }
    } finally {
      await fd.close();
    }
  }

  /**
   * Calculate file checksum for change detection
   * @param {string} filename - File to checksum
   * @returns {Promise<string>} - File checksum
   */
  async _calculateFileChecksum(filename) {
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
   * Get page that contains the given absolute byte position
   * @param {number} absolutePos - Absolute byte position
   * @returns {Promise<{page: PageInfo, relativePos: number}>}
   */
  async _getPageForPosition(absolutePos) {
    let currentPos = 0;
    
    for (const [pageId, pageInfo] of this.pages) {
      if (absolutePos >= currentPos && absolutePos < currentPos + pageInfo.currentSize) {
        await this._ensurePageLoaded(pageInfo);
        return {
          page: pageInfo,
          relativePos: absolutePos - currentPos
        };
      }
      currentPos += pageInfo.currentSize;
    }
    
    throw new Error(`Position ${absolutePos} is beyond end of buffer`);
  }

  /**
   * Ensure a page is loaded into memory
   * @param {PageInfo} pageInfo - Page to load
   */
  async _ensurePageLoaded(pageInfo) {
    if (pageInfo.isLoaded) {
      this._updatePageAccess(pageInfo);
      return;
    }

    try {
      if (pageInfo.isDirty) {
        pageInfo.data = await this.storage.loadPage(pageInfo.pageId);
      } else if (pageInfo.isDetached) {
        throw new Error(`Page ${pageInfo.pageId} is detached from source file`);
      } else {
        const fd = await fs.open(this.filename, 'r');
        try {
          const buffer = Buffer.alloc(pageInfo.originalSize);
          await fd.read(buffer, 0, pageInfo.originalSize, pageInfo.fileOffset);
          
          if (!pageInfo.verifyIntegrity(buffer)) {
            this._notify(
              NotificationType.PAGE_CONFLICT_DETECTED,
              'warning',
              `Page ${pageInfo.pageId} checksum mismatch`,
              { pageId: pageInfo.pageId, offset: pageInfo.fileOffset }
            );
          }
          
          pageInfo.data = buffer;
        } finally {
          await fd.close();
        }
      }

      pageInfo.isLoaded = true;
      pageInfo.lastAccess = Date.now();
      
      this.pageOrder.push(pageInfo.pageId);
      await this._evictPagesIfNeeded();
    } catch (error) {
      this._notify(
        NotificationType.STORAGE_ERROR,
        'error',
        `Failed to load page ${pageInfo.pageId}: ${error.message}`,
        { pageId: pageInfo.pageId, error: error.message }
      );
      throw error;
    }
  }

  /**
   * Update page access for LRU tracking
   * @param {PageInfo} pageInfo - Page that was accessed
   */
  _updatePageAccess(pageInfo) {
    pageInfo.lastAccess = Date.now();
    
    const index = this.pageOrder.indexOf(pageInfo.pageId);
    if (index > -1) {
      this.pageOrder.splice(index, 1);
    }
    this.pageOrder.push(pageInfo.pageId);
  }

  /**
   * Evict pages if over memory limit
   */
  async _evictPagesIfNeeded() {
    while (this.pageOrder.length > this.maxMemoryPages) {
      const oldestPageId = this.pageOrder.shift();
      const pageInfo = this.pages.get(oldestPageId);
      
      if (pageInfo && pageInfo.isLoaded) {
        try {
          if (pageInfo.isDirty) {
            await this.storage.savePage(pageInfo.pageId, pageInfo.data);
          }
          
          pageInfo.data = null;
          pageInfo.isLoaded = false;
        } catch (error) {
          this._notify(
            NotificationType.STORAGE_ERROR,
            'error',
            `Failed to evict page ${pageInfo.pageId}: ${error.message}`,
            { pageId: pageInfo.pageId, error: error.message }
          );
        }
      }
    }
  }

  /**
   * Split a page that has grown too large
   * @param {PageInfo} pageInfo - Page to split
   */
  async _splitPage(pageInfo) {
    const splitPoint = Math.floor(pageInfo.currentSize / 2);
    
    const newPageId = `page_${this.nextPageId++}`;
    const newPageData = pageInfo.data.subarray(splitPoint);
    const newPageInfo = new PageInfo(newPageId, -1, 0);
    newPageInfo.updateData(newPageData, this.mode);
    newPageInfo.isDetached = true;
    
    const originalData = pageInfo.data.subarray(0, splitPoint);
    pageInfo.updateData(originalData, this.mode);
    
    this.pages.set(newPageId, newPageInfo);
    
    this._notify(
      NotificationType.LARGE_OPERATION,
      'info',
      `Split page ${pageInfo.pageId} due to size (${pageInfo.currentSize} bytes)`,
      { originalPageId: pageInfo.pageId, newPageId, splitPoint }
    );
  }

  // =================== CORE BYTE OPERATIONS ===================

  /**
   * Get bytes from absolute position
   * @param {number} start - Start byte position
   * @param {number} end - End byte position
   * @returns {Promise<Buffer>} - Data
   */
  async getBytes(start, end) {
    if (start >= end) return Buffer.alloc(0);
    
    const chunks = [];
    let currentPos = start;
    
    while (currentPos < end) {
      const { page, relativePos } = await this._getPageForPosition(currentPos);
      const endInPage = Math.min(relativePos + (end - currentPos), page.currentSize);
      
      chunks.push(page.data.subarray(relativePos, endInPage));
      currentPos += (endInPage - relativePos);
    }
    
    return Buffer.concat(chunks);
  }

  /**
   * Insert bytes at absolute position
   * @param {number} position - Insertion position
   * @param {Buffer} data - Data to insert
   */
  async insertBytes(position, data) {
    if (this.undoSystem) {
      this.undoSystem.recordInsert(position, data);
    }

    const { page, relativePos } = await this._getPageForPosition(position);
    
    const before = page.data.subarray(0, relativePos);
    const after = page.data.subarray(relativePos);
    page.updateData(Buffer.concat([before, data, after]), this.mode);
    
    this.totalSize += data.length;
    this.state = BufferState.MODIFIED;
    
    if (page.currentSize > this.pageSize * 2) {
      await this._splitPage(page);
    }
  }

  /**
   * Delete bytes from absolute range
   * @param {number} start - Start position
   * @param {number} end - End position
   * @returns {Promise<Buffer>} - Deleted data
   */
  async deleteBytes(start, end) {
    const deletedData = await this.getBytes(start, end);
    
    if (this.undoSystem) {
      this.undoSystem.recordDelete(start, deletedData);
    }
    
    const { page, relativePos } = await this._getPageForPosition(start);
    const deleteLength = end - start;
    
    const before = page.data.subarray(0, relativePos);
    const after = page.data.subarray(relativePos + deleteLength);
    page.updateData(Buffer.concat([before, after]), this.mode);
    
    this.totalSize -= deleteLength;
    this.state = BufferState.MODIFIED;
    
    return deletedData;
  }

  /**
   * Overwrite bytes at absolute position
   * @param {number} position - Position to overwrite
   * @param {Buffer} data - New data
   * @returns {Promise<Buffer>} - Original data that was overwritten
   */
  async overwriteBytes(position, data) {
    const originalData = await this.getBytes(position, position + data.length);
    
    if (this.undoSystem) {
      this.undoSystem.recordOverwrite(position, data, originalData);
    }
    
    await this.deleteBytes(position, position + originalData.length);
    await this.insertBytes(position, data);
    
    return originalData;
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
    const chunkSize = 64 * 1024;

    for (let pos = 0; pos < totalSize; pos += chunkSize) {
      const endPos = Math.min(pos + chunkSize, totalSize);
      const chunk = await this.getBytes(pos, endPos);
      
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 0x0A) {
          lineStarts.push(pos + i + 1);
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

    const lineEndByte = line + 1 < lineStarts.length ? 
      lineStarts[line + 1] - 1 :
      this.getTotalSize();

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

    const lineEndByte = line + 1 < lineStarts.length ? 
      lineStarts[line + 1] - 1 :
      this.getTotalSize();

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

  // =================== FILE OPERATIONS ===================

  /**
   * Save the buffer to a file
   * @param {string} [filename] - Optional filename to save to
   */
  async saveFile(filename = this.filename) {
    if (!filename) {
      throw new Error('No filename specified');
    }

    if (this.state === BufferState.DETACHED) {
      throw new Error('Buffer is detached - must use saveAs() with complete data verification');
    }

    const fd = await fs.open(filename, 'w');
    
    try {
      for (const [pageId, pageInfo] of this.pages) {
        await this._ensurePageLoaded(pageInfo);
        await fd.write(pageInfo.data);
      }
    } finally {
      await fd.close();
    }
    
    const stats = await fs.stat(filename);
    this.filename = filename;
    this.fileSize = stats.size;
    this.fileMtime = stats.mtime;
    this.totalSize = stats.size;
    this.state = BufferState.CLEAN;
    
    for (const pageInfo of this.pages.values()) {
      pageInfo.isDirty = false;
      pageInfo.isDetached = false;
    }
  }

  /**
   * Save as new file (for detached buffers)
   * @param {string} filename - New filename
   * @param {boolean} forcePartial - Allow saving partial data
   */
  async saveAs(filename, forcePartial = false) {
    if (this.state === BufferState.DETACHED && !forcePartial) {
      const missingPages = [];
      for (const [pageId, pageInfo] of this.pages) {
        if (!pageInfo.isLoaded && !pageInfo.isDirty) {
          missingPages.push(pageId);
        }
      }
      
      if (missingPages.length > 0) {
        throw new Error(`Cannot save detached buffer - missing pages: ${missingPages.join(', ')}`);
      }
    }
    
    await this.saveFile(filename);
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
      this.undoSystem.beginTransaction(name, options);
    }
  }

  /**
   * Commit the current undo transaction
   * @param {string} finalName - Optional final name
   * @returns {boolean} - True if transaction was committed
   */
  commitUndoTransaction(finalName = null) {
    if (this.undoSystem) {
      return this.undoSystem.commitTransaction(finalName);
    }
    return false;
  }

  /**
   * Rollback the current undo transaction
   * @returns {Promise<boolean>} - True if transaction was rolled back
   */
  async rollbackUndoTransaction() {
    if (this.undoSystem) {
      return await this.undoSystem.rollbackTransaction();
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
    return this.totalSize;
  }

  /**
   * Get buffer state
   * @returns {string} - Buffer state
   */
  getState() {
    return this.state;
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
    let loadedPages = 0;
    let dirtyPages = 0;
    let detachedPages = 0;
    let memoryUsed = 0;
    
    for (const pageInfo of this.pages.values()) {
      if (pageInfo.isLoaded) {
        loadedPages++;
        memoryUsed += pageInfo.currentSize;
      }
      if (pageInfo.isDirty) {
        dirtyPages++;
      }
      if (pageInfo.isDetached) {
        detachedPages++;
      }
    }
    
    const undoStats = this.undoSystem ? this.undoSystem.getStats() : {
      undoGroups: 0,
      redoGroups: 0,
      totalUndoOperations: 0,
      totalRedoOperations: 0,
      currentGroupOperations: 0,
      memoryUsage: 0
    };
    
    return {
      totalPages: this.pages.size,
      loadedPages,
      dirtyPages,
      detachedPages,
      memoryUsed,
      maxMemoryPages: this.maxMemoryPages,
      state: this.state,
      mode: this.mode,
      undo: undoStats
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
}

module.exports = { PagedBuffer };
