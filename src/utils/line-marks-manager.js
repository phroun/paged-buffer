/**
 * @fileoverview Line and Marks Manager - Simplified line tracking and named marks
 * @description Manages line positions and named marks across the virtual buffer
 * @author Jeffrey R. Day
 * @version 1.2.0 - Made line operations synchronous
 */

/**
 * Represents the result of line-related operations
 */
class LineOperationResult {
  constructor(lineNumber, byteStart, byteEnd, marks = []) {
    this.lineNumber = lineNumber; // 1-based line number
    this.byteStart = byteStart; // Start byte address (inclusive)
    this.byteEnd = byteEnd; // End byte address (exclusive)
    this.length = byteEnd - byteStart; // Line length in bytes
    this.marks = marks; // Marks within this line
  }
}

/**
 * Represents extracted content with marks
 */
class ExtractedContent {
  constructor(data, marks = []) {
    this.data = data; // Buffer containing the extracted data
    this.marks = marks; // Array of {name, relativeOffset} for marks in the content
  }
}

/**
 * Simplified line and marks manager - synchronous line operations
 */
class LineAndMarksManager {
  constructor(virtualPageManager) {
    this.vpm = virtualPageManager;
    
    // Global marks registry (always in memory)
    this.globalMarks = new Map(); // markName -> virtualAddress
    
    // Cache for line information to support sync operations
    this._cachedLineStarts = null;
    this._lineStartsCacheValid = false;
    this._cachedLineCount = null;
  }

  /**
   * Update marks after a modification
   * @param {number} virtualStart - Start of modification
   * @param {number} deletedBytes - Bytes deleted
   * @param {number} insertedBytes - Bytes inserted
   */
  updateMarksAfterModification(virtualStart, deletedBytes, insertedBytes) {
    const netChange = insertedBytes - deletedBytes;
    const deletionEnd = virtualStart + deletedBytes;

    // Update global marks
    for (const [markName, virtualAddress] of this.globalMarks) {
      if (virtualAddress >= deletionEnd) {
        // Mark is after modification - shift by net change
        this.globalMarks.set(markName, virtualAddress + netChange);
      } else if (virtualAddress >= virtualStart) {
        // Mark is within deleted region - move to start of modification
        this.globalMarks.set(markName, virtualStart);
      }
      // Marks before modification are unaffected
    }

    // Update marks in affected pages (handled by VPM)
    
    // Invalidate line caches
    this.invalidateLineCaches();
  }

  /**
   * Invalidate line caches (called when buffer content changes)
   * LEGACY METHOD NAME - keeping for compatibility with VPM
   */
  invalidateLineCaches() {
    this.invalidatePageLineCaches();
  }

  /**
   * Invalidate line caches in pages (called when buffer content changes)
   */
  invalidatePageLineCaches() {
    // Mark all page line caches as invalid in the VPM
    for (const descriptor of this.vpm.addressIndex.getAllPages()) {
      descriptor.lineInfoCached = false;
    }
    
    // Invalidate our own caches
    this._lineStartsCacheValid = false;
    this._cachedLineStarts = null;
    this._cachedLineCount = null;
  }

  // =================== MARKS MANAGEMENT ===================

  /**
   * Set a named mark at a virtual address
   * @param {string} markName - Name of the mark
   * @param {number} virtualAddress - Virtual buffer address
   */
  setMark(markName, virtualAddress) {
    if (virtualAddress < 0 || virtualAddress > this.vpm.getTotalSize()) {
      throw new Error(`Mark address ${virtualAddress} is out of range`);
    }

    // Update global registry
    this.globalMarks.set(markName, virtualAddress);

    // Find the page containing this address
    const descriptor = this.vpm.addressIndex.findPageAt(virtualAddress);
    if (descriptor && this.vpm.pageCache.has(descriptor.pageId)) {
      const pageInfo = this.vpm.pageCache.get(descriptor.pageId);
      const pageOffset = virtualAddress - descriptor.virtualStart;
      pageInfo.setMark(markName, pageOffset, virtualAddress);
    }
  }

  /**
   * Get the virtual address of a named mark
   * @param {string} markName - Name of the mark
   * @returns {number|null} - Virtual address or null if not found
   */
  getMark(markName) {
    return this.globalMarks.get(markName) || null;
  }

  /**
   * Remove a named mark
   * @param {string} markName - Name of the mark
   * @returns {boolean} - True if mark was found and removed
   */
  removeMark(markName) {
    const existed = this.globalMarks.has(markName);
    
    if (existed) {
      const virtualAddress = this.globalMarks.get(markName);
      this.globalMarks.delete(markName);

      // Remove from page cache if loaded
      const descriptor = this.vpm.addressIndex.findPageAt(virtualAddress);
      if (descriptor && this.vpm.pageCache.has(descriptor.pageId)) {
        const pageInfo = this.vpm.pageCache.get(descriptor.pageId);
        pageInfo.removeMark(markName);
      }
    }

    return existed;
  }

  /**
   * Get all marks between two virtual addresses
   * @param {number} startAddress - Start address (inclusive)
   * @param {number} endAddress - End address (inclusive)
   * @returns {Array<{name: string, address: number}>} - Marks in range
   */
  getMarksInRange(startAddress, endAddress) {
    const result = [];
    
    for (const [markName, virtualAddress] of this.globalMarks) {
      if (virtualAddress >= startAddress && virtualAddress <= endAddress) {
        result.push({ name: markName, address: virtualAddress });
      }
    }
    
    return result.sort((a, b) => a.address - b.address);
  }

  /**
   * Get all marks in the buffer
   * @returns {Array<{name: string, address: number}>} - All marks
   */
  getAllMarks() {
    const result = [];
    for (const [markName, virtualAddress] of this.globalMarks) {
      result.push({ name: markName, address: virtualAddress });
    }
    return result.sort((a, b) => a.address - b.address);
  }

  /**
   * Extract marks from a range (for delete operations)
   * @param {number} startAddress - Start address
   * @param {number} endAddress - End address
   * @returns {Array<{name: string, relativeOffset: number}>} - Extracted marks
   */
  extractMarksFromRange(startAddress, endAddress) {
    const extracted = [];
    const marksToRemove = [];

    for (const [markName, virtualAddress] of this.globalMarks) {
      if (virtualAddress >= startAddress && virtualAddress < endAddress) {
        extracted.push({
          name: markName,
          relativeOffset: virtualAddress - startAddress
        });
        marksToRemove.push(markName);
      }
    }

    // Remove extracted marks
    for (const markName of marksToRemove) {
      this.removeMark(markName);
    }

    return extracted.sort((a, b) => a.relativeOffset - b.relativeOffset);
  }

  /**
   * Insert marks from relative positions (for insert operations)
   * @param {number} insertAddress - Address where content was inserted
   * @param {Array<{name: string, relativeOffset: number}>} marks - Marks to insert
   */
  insertMarksFromRelative(insertAddress, marks) {
    for (const markData of marks) {
      const virtualAddress = insertAddress + markData.relativeOffset;
      this.setMark(markData.name, virtualAddress);
    }
  }

  // =================== SYNCHRONOUS LINE TRACKING ===================

  /**
   * Ensure line starts cache is built and valid
   * @private
   */
  _ensureLineStartsCache() {
    if (this._lineStartsCacheValid && this._cachedLineStarts !== null) {
      return;
    }

    const totalSize = this.vpm.getTotalSize();
    if (totalSize === 0) {
      this._cachedLineStarts = [0]; // Empty content has 1 line starting at 0
      this._cachedLineCount = 1;
      this._lineStartsCacheValid = true;
      return;
    }

    const starts = [0]; // First line always starts at 0
    
    // Process pages to find newlines
    for (const descriptor of this.vpm.addressIndex.getAllPages()) {
      if (descriptor.virtualSize === 0) {
        continue; // Skip empty pages
      }

      // Only process pages that have cached line info or are currently loaded
      if (descriptor.lineInfoCached && descriptor.newlineCount > 0) {
        // Use cached newline count - we need exact positions, so try to get from loaded page
        if (this.vpm.pageCache.has(descriptor.pageId)) {
          const pageInfo = this.vpm.pageCache.get(descriptor.pageId);
          pageInfo.ensureLineCacheValid();
          
          // Convert page-relative positions to global positions
          for (const nlPos of pageInfo.newlinePositions) {
            starts.push(descriptor.virtualStart + nlPos + 1);
          }
        } else {
          // Page not loaded, but we know it has newlines
          // We can't get exact positions synchronously, so we'll have incomplete data
          // This is a limitation of making it synchronous
          console.warn(`Line cache incomplete: page ${descriptor.pageId} has newlines but is not loaded`);
        }
      } else if (this.vpm.pageCache.has(descriptor.pageId)) {
        // Page is loaded but line info not cached - build it now
        const pageInfo = this.vpm.pageCache.get(descriptor.pageId);
        pageInfo.ensureLineCacheValid();
        descriptor.cacheLineInfo(pageInfo);
        
        // Convert page-relative positions to global positions
        for (const nlPos of pageInfo.newlinePositions) {
          starts.push(descriptor.virtualStart + nlPos + 1);
        }
      }
    }
    
    this._cachedLineStarts = starts;
    this._cachedLineCount = starts.length;
    this._lineStartsCacheValid = true;
  }

  /**
   * Get the total number of lines in the buffer (SYNCHRONOUS)
   * @returns {number} - Total line count
   */
  getTotalLineCount() {
    this._ensureLineStartsCache();
    return this._cachedLineCount;
  }

  /**
   * Get the byte addresses where lines start (SYNCHRONOUS)
   * @returns {number[]} - Array of line start addresses
   */
  getLineStarts() {
    this._ensureLineStartsCache();
    return [...this._cachedLineStarts]; // Return copy to prevent mutation
  }

  /**
   * Get line information by line number (SYNCHRONOUS)
   * @param {number} lineNumber - Line number (1-based)
   * @returns {LineOperationResult|null} - Line info or null if not found
   */
  getLineInfo(lineNumber) {
    if (lineNumber < 1) {
      return null;
    }

    const lineStarts = this.getLineStarts();
    
    if (lineNumber > lineStarts.length) {
      return null;
    }

    const startAddress = lineStarts[lineNumber - 1];
    let endAddress;
    
    if (lineNumber < lineStarts.length) {
      endAddress = lineStarts[lineNumber];
    } else {
      endAddress = this.vpm.getTotalSize();
    }

    const marks = this.getMarksInRange(startAddress, endAddress - 1);
    return new LineOperationResult(lineNumber, startAddress, endAddress, marks);
  }

  /**
   * Get information about multiple lines at once (SYNCHRONOUS)
   * @param {number} startLine - Start line number (1-based, inclusive)
   * @param {number} endLine - End line number (1-based, inclusive)
   * @returns {LineOperationResult[]} - Array of line info
   */
  getMultipleLines(startLine, endLine) {
    const result = [];
    const clampedStart = Math.max(1, startLine);
    const totalLines = this.getTotalLineCount();
    const clampedEnd = Math.min(totalLines, endLine);
    
    for (let lineNum = clampedStart; lineNum <= clampedEnd; lineNum++) {
      const lineInfo = this.getLineInfo(lineNum);
      if (lineInfo) {
        result.push(lineInfo);
      }
    }
    
    return result;
  }

  /**
   * Get line addresses for a range of lines (SYNCHRONOUS)
   * @param {number} startLine - Start line number (1-based)
   * @param {number} endLine - End line number (1-based, inclusive)
   * @returns {number[]} - Array of start addresses
   */
  getLineAddresses(startLine, endLine) {
    const lineStarts = this.getLineStarts();
    const result = [];
    const clampedStart = Math.max(1, startLine);
    const clampedEnd = Math.min(lineStarts.length, endLine);
    
    for (let lineNum = clampedStart; lineNum <= clampedEnd; lineNum++) {
      result.push(lineStarts[lineNum - 1]);
    }
    
    return result;
  }

  /**
   * Convert virtual byte address to line number (SYNCHRONOUS)
   * @param {number} virtualAddress - Virtual buffer address
   * @returns {number} - Line number (1-based) or 0 if invalid address
   */
  getLineNumberFromAddress(virtualAddress) {
    if (virtualAddress < 0 || virtualAddress > this.vpm.getTotalSize()) {
      return 0;
    }

    const lineStarts = this.getLineStarts();
    
    // Binary search to find the line
    let left = 0;
    let right = lineStarts.length - 1;
    let bestLine = 0;
    
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const lineStart = lineStarts[mid];
      
      if (lineStart <= virtualAddress) {
        bestLine = mid + 1; // Convert to 1-based
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }
    
    return bestLine;
  }

  /**
   * Convert line/character position to absolute byte position (SYNCHRONOUS)
   * @param {Object} pos - {line, character} (both 1-based, character = byte offset in line)
   * @param {number[]} lineStarts - Cached line starts (optional)
   * @returns {number} - Absolute byte position
   */
  lineCharToBytePosition(pos, lineStarts = null) {
    if (!lineStarts) {
      lineStarts = this.getLineStarts();
    }

    // Convert 1-based to 0-based for internal calculations
    const line = pos.line - 1;
    const character = pos.character - 1; // character is really byte offset

    if (line >= lineStarts.length) {
      return this.vpm.getTotalSize();
    }

    const lineStartByte = lineStarts[line];
    
    if (character <= 0) {
      return lineStartByte;
    }

    // Calculate line end for boundary checking
    let lineEndByte;
    if (line + 1 < lineStarts.length) {
      lineEndByte = lineStarts[line + 1] - 1; // Exclude newline
    } else {
      lineEndByte = this.vpm.getTotalSize();
    }

    // Simple byte arithmetic - character position is byte offset within line
    const targetByte = lineStartByte + character;
    
    // Clamp to line boundaries
    return Math.min(targetByte, lineEndByte);
  }

  /**
   * Convert absolute byte position to line/character position (SYNCHRONOUS)
   * @param {number} bytePos - Absolute byte position
   * @param {number[]} lineStarts - Cached line starts (optional)
   * @returns {Object} - {line, character} (both 1-based, character = byte offset in line + 1)
   */
  byteToLineCharPosition(bytePos, lineStarts = null) {
    const lineNumber = this.getLineNumberFromAddress(bytePos);
    
    if (lineNumber === 0) {
      return { line: 1, character: 1 };
    }

    if (!lineStarts) {
      lineStarts = this.getLineStarts();
    }

    const lineStartByte = lineStarts[lineNumber - 1]; // Convert to 0-based
    const byteOffsetInLine = bytePos - lineStartByte;
    
    // Simple byte arithmetic - character position is byte offset + 1 (for 1-based indexing)
    return { line: lineNumber, character: byteOffsetInLine + 1 };
  }

  /**
   * Attempt to get bytes synchronously (best effort)
   * @param {number} start - Start position
   * @param {number} end - End position
   * @returns {Buffer|null} - Data if available synchronously, null otherwise
   * @private
   */
  _getBytesSync(start, end) {
    // This is a best-effort synchronous read that only works if pages are loaded
    try {
      const affectedPages = this.vpm.addressIndex.getPagesInRange(start, end);
      const chunks = [];
      
      for (const descriptor of affectedPages) {
        if (!this.vpm.pageCache.has(descriptor.pageId)) {
          return null; // Page not loaded, can't read synchronously
        }
        
        const pageInfo = this.vpm.pageCache.get(descriptor.pageId);
        
        // Calculate intersection with read range
        const readStart = Math.max(start, descriptor.virtualStart);
        const readEnd = Math.min(end, descriptor.virtualEnd);
        
        const relativeStart = readStart - descriptor.virtualStart;
        const relativeEnd = readEnd - descriptor.virtualStart;
        
        const actualEnd = Math.min(relativeEnd, pageInfo.data.length);
        
        if (relativeStart < pageInfo.data.length) {
          chunks.push(pageInfo.data.subarray(relativeStart, actualEnd));
        }
      }
      
      return Buffer.concat(chunks);
    } catch (error) {
      return null;
    }
  }

  // =================== ENHANCED OPERATIONS WITH MARKS (Still Async) ===================

  /**
   * Enhanced getBytes that includes marks in the result
   * @param {number} start - Start address
   * @param {number} end - End address
   * @param {boolean} includeMarks - Whether to include marks in result
   * @returns {Promise<Buffer|ExtractedContent>} - Data or data with marks
   */
  async getBytesWithMarks(start, end, includeMarks = false) {
    const data = await this.vpm.readRange(start, end);
    
    if (!includeMarks) {
      return data;
    }

    const marks = this.getMarksInRange(start, end - 1);
    const relativeMarks = marks.map(mark => ({
      name: mark.name,
      relativeOffset: mark.address - start
    }));

    return new ExtractedContent(data, relativeMarks);
  }

  /**
   * Enhanced deleteBytes that returns deleted data with marks
   * @param {number} start - Start address
   * @param {number} end - End address
   * @returns {Promise<ExtractedContent>} - Deleted data with marks
   */
  async deleteBytesWithMarks(start, end) {
    // Extract marks before deletion
    const extractedMarks = this.extractMarksFromRange(start, end);
    
    // Perform the deletion through VPM
    const deletedData = await this.vpm.deleteRange(start, end);
    
    // Update remaining marks
    this.updateMarksAfterModification(start, end - start, 0);
    
    return new ExtractedContent(deletedData, extractedMarks);
  }

  /**
   * Enhanced insertBytes that accepts marks to be inserted
   * @param {number} position - Insert position
   * @param {Buffer} data - Data to insert
   * @param {Array<{name: string, relativeOffset: number}>} marks - Marks to insert
   */
  async insertBytesWithMarks(position, data, marks = []) {
    // Perform the insertion through VPM
    await this.vpm.insertAt(position, data);
    
    // Update marks
    this.updateMarksAfterModification(position, 0, data.length);
    
    // Insert the new marks
    this.insertMarksFromRelative(position, marks);
  }

  /**
   * Enhanced overwriteBytes with marks support
   * @param {number} position - Overwrite position
   * @param {Buffer} data - New data
   * @param {Array<{name: string, relativeOffset: number}>} marks - Marks to insert
   * @returns {Promise<ExtractedContent>} - Overwritten data with marks
   */
  async overwriteBytesWithMarks(position, data, marks = []) {
    const endPosition = position + data.length;
    
    // Extract marks from overwritten region
    const overwrittenMarks = this.extractMarksFromRange(position, endPosition);
    
    // Get the overwritten data
    const overwrittenData = await this.vpm.readRange(position, endPosition);
    
    // Perform delete and insert
    await this.vpm.deleteRange(position, endPosition);
    await this.vpm.insertAt(position, data);
    
    // Update marks (no net size change)
    this.updateMarksAfterModification(position, data.length, data.length);
    
    // Insert new marks
    this.insertMarksFromRelative(position, marks);
    
    return new ExtractedContent(overwrittenData, overwrittenMarks);
  }

  /**
   * Get memory usage statistics
   * @returns {Object} - Memory usage info
   */
  getMemoryStats() {
    let marksMemory = this.globalMarks.size * 64; // Rough estimate
    let linesCacheMemory = this._cachedLineStarts ? this._cachedLineStarts.length * 8 : 0;
    
    return {
      globalMarksCount: this.globalMarks.size,
      totalLines: this._cachedLineCount || -1,
      lineStartsCacheSize: this._cachedLineStarts ? this._cachedLineStarts.length : 0,
      lineStartsCacheValid: this._lineStartsCacheValid,
      estimatedMarksMemory: marksMemory,
      estimatedLinesCacheMemory: linesCacheMemory
    };
  }
}

module.exports = {
  LineAndMarksManager,
  LineOperationResult,
  ExtractedContent
};
