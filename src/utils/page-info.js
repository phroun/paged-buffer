/**
 * Enhanced Page metadata with simplified line tracking (marks moved to global system)
 */

const crypto = require('crypto');

/**
 * Enhanced Page metadata with simplified line tracking and no marks management
 * (Marks are now handled globally by the page coordinate system)
 */
class PageInfo {
  constructor(pageId, fileOffset, originalSize, checksum = null) {
    this.pageId = pageId;
    this.fileOffset = fileOffset; // Original offset in source file
    this.originalSize = originalSize; // Original size in source file
    this.checksum = checksum; // Fast checksum for change detection
    
    // Runtime state
    this.isDirty = false; // Has been modified
    this.isLoaded = false; // Currently in memory
    this.isDetached = false; // Conflicts with source file
    this.currentSize = originalSize; // Current size (may differ if modified)
    this.data = null; // In-memory data buffer
    this.lastAccess = Date.now();
    
    // Simplified line tracking - just store newline positions
    this.newlinePositions = []; // Array of relative positions of \n characters
    this.linesCacheValid = false; // Whether newline positions are up to date
  }

  /**
   * Calculate fast checksum for change detection
   * @param {Buffer} data - Data to checksum
   * @returns {string} - Checksum
   */
  static calculateChecksum(data) {
    return crypto.createHash('md5').update(data).digest('hex');
  }

  /**
   * Update page with new data and invalidate caches as needed
   * @param {Buffer} data - New data
   */
  updateData(data) {
    this.data = data;
    this.currentSize = data.length;
    this.isDirty = true;
    this.isLoaded = true;
    this.lastAccess = Date.now();
    
    // Invalidate caches when data changes
    this.linesCacheValid = false;
    
    // Rebuild line information immediately for loaded pages
    this._rebuildLineCache(data);
  }

  /**
   * Rebuild the newline positions cache
   * @param {Buffer} data - Page data
   * @private
   */
  _rebuildLineCache(data) {
    this.newlinePositions = [];
    
    // Single pass through data to find all newlines
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0x0A) { // \n
        this.newlinePositions.push(i);
      }
    }
    
    this.linesCacheValid = true;
  }

  /**
   * Ensure line cache is valid and up to date
   */
  ensureLineCacheValid() {
    if (!this.linesCacheValid && this.isLoaded && this.data) {
      this._rebuildLineCache(this.data);
    }
  }

  /**
   * Get the number of newlines in this page
   * @returns {number} - Number of \n characters
   */
  getNewlineCount() {
    this.ensureLineCacheValid();
    return this.newlinePositions.length;
  }

  /**
   * Get global line starts contributed by this page
   * @param {number} pageVirtualStart - Virtual start address of this page
   * @returns {number[]} - Array of global line start positions
   */
  getGlobalLineStarts(pageVirtualStart) {
    this.ensureLineCacheValid();
    const starts = [];
    
    // Each newline creates a line start at position + 1
    for (const nlPos of this.newlinePositions) {
      const globalLineStart = pageVirtualStart + nlPos + 1;
      starts.push(globalLineStart);
    }
    
    return starts;
  }

  /**
   * Update line cache after a modification within this page
   * @param {number} offset - Offset within page where modification occurred
   * @param {number} deletedBytes - Number of bytes deleted
   * @param {Buffer} insertedData - Data that was inserted
   */
  updateAfterModification(offset, deletedBytes, insertedData) {
    // Invalidate cache - we'll rebuild on next access
    this.linesCacheValid = false;
  }

  // =================== LEGACY MARKS METHODS (NO-OP) ===================
  // These methods are kept for compatibility but do nothing since marks
  // are now handled globally by the page coordinate system

  /**
   * Legacy method - no longer used (marks handled globally)
   * @deprecated
   */
  setMark(markName, pageOffset, virtualAddress) {
    // No-op - marks are handled globally now
  }

  /**
   * Legacy method - no longer used (marks handled globally)
   * @deprecated
   */
  removeMark(markName) {
    // No-op - marks are handled globally now
    return false;
  }

  /**
   * Legacy method - no longer used (marks handled globally)
   * @deprecated
   */
  getMark(markName) {
    // No-op - marks are handled globally now
    return null;
  }

  /**
   * Legacy method - no longer used (marks handled globally)
   * @deprecated
   */
  getAllMarks() {
    // No-op - marks are handled globally now
    return [];
  }

  /**
   * Legacy method - no longer used (marks handled globally)
   * @deprecated
   */
  getMarksInRange(startOffset, endOffset) {
    // No-op - marks are handled globally now
    return [];
  }

  /**
   * Legacy method - no longer used (marks handled globally)
   * @deprecated
   */
  updateMarkVirtualAddresses(pageVirtualStart) {
    // No-op - marks are handled globally now
  }

  /**
   * Legacy method - no longer used (marks handled globally)
   * @deprecated
   */
  extractMarksFromRange(startOffset, endOffset) {
    // No-op - marks are handled globally now
    return [];
  }

  /**
   * Legacy method - no longer used (marks handled globally)
   * @deprecated
   */
  insertMarksFromRelative(insertOffset, marks, pageVirtualStart) {
    // No-op - marks are handled globally now
  }

  /**
   * Verify page integrity against original file
   * @param {Buffer} originalData - Data from original file
   * @returns {boolean} - True if page matches original
   */
  verifyIntegrity(originalData) {
    if (!this.checksum) return false;
    const currentChecksum = PageInfo.calculateChecksum(originalData);
    return currentChecksum === this.checksum;
  }

  /**
   * Get memory usage statistics for this page
   * @returns {Object} - Memory usage info
   */
  getMemoryStats() {
    let memoryUsed = 0;
    
    if (this.data) {
      memoryUsed += this.data.length;
    }
    
    // Newline positions memory (much smaller than before)
    memoryUsed += this.newlinePositions.length * 4; // 4 bytes per position
    
    return {
      dataSize: this.data ? this.data.length : 0,
      newlineCount: this.newlinePositions.length,
      newlinePositionsSize: this.newlinePositions.length,
      marksCount: 0, // No marks stored here anymore
      estimatedMemoryUsed: memoryUsed,
      isLoaded: this.isLoaded,
      isDirty: this.isDirty,
      linesCacheValid: this.linesCacheValid,
      marksValid: true // Always valid since no marks
    };
  }
}

// Backwards compatibility exports
class LineInfo {
  constructor(startOffset, length, endsWithNewline = false) {
    this.startOffset = startOffset;
    this.length = length;
    this.endsWithNewline = endsWithNewline;
  }

  get endOffset() {
    return this.startOffset + this.length;
  }

  get contentLength() {
    return this.endsWithNewline ? this.length - 1 : this.length;
  }
}

// Legacy class kept for compatibility but no longer used
class MarkInfo {
  constructor(name, pageOffset, virtualAddress) {
    this.name = name;
    this.pageOffset = pageOffset;
    this.virtualAddress = virtualAddress;
  }
}

module.exports = { PageInfo, LineInfo, MarkInfo };
