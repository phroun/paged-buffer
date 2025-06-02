/**
 * Enhanced Page metadata with simplified line tracking and marks management
 */

const crypto = require('crypto');

/**
 * Represents a named mark within a page
 */
class MarkInfo {
  constructor(name, pageOffset, virtualAddress) {
    this.name = name;
    this.pageOffset = pageOffset; // Offset within the page
    this.virtualAddress = virtualAddress; // Global virtual address (for external interface)
  }
}

/**
 * Enhanced Page metadata with simplified line tracking and marks management
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
    
    // Named marks management
    this.marks = new Map(); // markName -> MarkInfo
    this.marksValid = true; // Whether mark positions are up to date
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
    this.marksValid = false; // Marks will need virtual address recalculation
    
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
    
    // Update mark positions within this page
    this._updateMarksAfterModification(offset, deletedBytes, insertedData.length);
  }

  /**
   * Update mark positions after modification within this page
   * @param {number} offset - Offset within page where modification occurred
   * @param {number} deletedBytes - Number of bytes deleted
   * @param {number} insertedBytes - Number of bytes inserted
   * @private
   */
  _updateMarksAfterModification(offset, deletedBytes, insertedBytes) {
    const netChange = insertedBytes - deletedBytes;
    const endOfDeletion = offset + deletedBytes;

    for (const [markName, markInfo] of this.marks) {
      if (markInfo.pageOffset >= endOfDeletion) {
        // Mark is after the modification - shift by net change
        markInfo.pageOffset += netChange;
        this.marksValid = false; // Virtual address needs recalculation
      } else if (markInfo.pageOffset >= offset) {
        // Mark is within the deleted region - move to start of modification
        markInfo.pageOffset = offset;
        this.marksValid = false;
      }
      // Marks before the modification are unaffected
    }
  }

  /**
   * Add or update a named mark in this page
   * @param {string} markName - Name of the mark
   * @param {number} pageOffset - Offset within this page
   * @param {number} virtualAddress - Global virtual address
   */
  setMark(markName, pageOffset, virtualAddress) {
    this.marks.set(markName, new MarkInfo(markName, pageOffset, virtualAddress));
  }

  /**
   * Remove a named mark from this page
   * @param {string} markName - Name of the mark to remove
   * @returns {boolean} - True if mark was found and removed
   */
  removeMark(markName) {
    return this.marks.delete(markName);
  }

  /**
   * Get a mark by name
   * @param {string} markName - Name of the mark
   * @returns {MarkInfo|null} - Mark info or null if not found
   */
  getMark(markName) {
    return this.marks.get(markName) || null;
  }

  /**
   * Get all marks in this page
   * @returns {MarkInfo[]} - Array of all marks
   */
  getAllMarks() {
    return Array.from(this.marks.values());
  }

  /**
   * Get marks within a specific range of this page
   * @param {number} startOffset - Start offset within page (inclusive)
   * @param {number} endOffset - End offset within page (exclusive)
   * @returns {MarkInfo[]} - Marks within the range
   */
  getMarksInRange(startOffset, endOffset) {
    const result = [];
    for (const markInfo of this.marks.values()) {
      if (markInfo.pageOffset >= startOffset && markInfo.pageOffset < endOffset) {
        result.push(markInfo);
      }
    }
    return result.sort((a, b) => a.pageOffset - b.pageOffset);
  }

  /**
   * Update virtual addresses for all marks in this page
   * @param {number} pageVirtualStart - Virtual start address of this page
   */
  updateMarkVirtualAddresses(pageVirtualStart) {
    for (const markInfo of this.marks.values()) {
      markInfo.virtualAddress = pageVirtualStart + markInfo.pageOffset;
    }
    this.marksValid = true;
  }

  /**
   * Extract marks from a range (for delete operations)
   * @param {number} startOffset - Start offset within page
   * @param {number} endOffset - End offset within page
   * @returns {Array<{name: string, relativeOffset: number}>} - Extracted marks with relative positions
   */
  extractMarksFromRange(startOffset, endOffset) {
    const extracted = [];
    const marksToRemove = [];

    for (const [markName, markInfo] of this.marks) {
      if (markInfo.pageOffset >= startOffset && markInfo.pageOffset < endOffset) {
        extracted.push({
          name: markName,
          relativeOffset: markInfo.pageOffset - startOffset
        });
        marksToRemove.push(markName);
      }
    }

    // Remove extracted marks from this page
    for (const markName of marksToRemove) {
      this.marks.delete(markName);
    }

    return extracted.sort((a, b) => a.relativeOffset - b.relativeOffset);
  }

  /**
   * Insert marks from relative positions (for insert operations)
   * @param {number} insertOffset - Offset within page where content was inserted
   * @param {Array<{name: string, relativeOffset: number}>} marks - Marks to insert
   * @param {number} pageVirtualStart - Virtual start address of this page
   */
  insertMarksFromRelative(insertOffset, marks, pageVirtualStart) {
    for (const markData of marks) {
      const pageOffset = insertOffset + markData.relativeOffset;
      const virtualAddress = pageVirtualStart + pageOffset;
      this.setMark(markData.name, pageOffset, virtualAddress);
    }
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
    
    // Marks memory
    memoryUsed += this.marks.size * 64; // Rough estimate for MarkInfo objects
    
    return {
      dataSize: this.data ? this.data.length : 0,
      newlineCount: this.newlinePositions.length,
      newlinePositionsSize: this.newlinePositions.length,
      marksCount: this.marks.size,
      estimatedMemoryUsed: memoryUsed,
      isLoaded: this.isLoaded,
      isDirty: this.isDirty,
      linesCacheValid: this.linesCacheValid,
      marksValid: this.marksValid
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

module.exports = { PageInfo, LineInfo, MarkInfo };
