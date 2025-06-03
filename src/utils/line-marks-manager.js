/**
 * @fileoverview Line and Marks Manager - Simple synchronous line tracking
 * @description Manages line positions and named marks across the virtual buffer
 * @author Jeffrey R. Day
 * @version 1.3.0 - Removed global line cache, simple sync operations
 */

/**
 * Represents the result of line-related operations
 */
class LineOperationResult {
  constructor(lineNumber, byteStart, byteEnd, marks = [], isExact = true) {
    this.lineNumber = lineNumber; // 1-based line number
    this.byteStart = byteStart; // Start byte address (exact or page boundary)
    this.byteEnd = byteEnd; // End byte address (exact or page boundary)
    this.length = byteEnd - byteStart; // Line length in bytes
    this.marks = marks; // Marks within this line
    this.isExact = isExact; // true = exact line bounds, false = page bounds
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
 * Simple synchronous line and marks manager
 */
class LineAndMarksManager {
  constructor(virtualPageManager) {
    this.vpm = virtualPageManager;
    
    // Global marks registry (always in memory)
    this.globalMarks = new Map(); // markName -> virtualAddress
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

    // Invalidate page line caches
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
  }

  /**
   * Ensure page containing address is loaded (ASYNC)
   * @param {number} address - Byte address to load
   * @returns {Promise<boolean>} - True if page was loaded successfully
   */
  async seekAddress(address) {
    if (address < 0 || address > this.vpm.getTotalSize()) {
      return false;
    }

    const descriptor = this.vpm.addressIndex.findPageAt(address);
    if (!descriptor) {
      return false;
    }

    try {
      await this.vpm._ensurePageLoaded(descriptor);
      return true;
    } catch (error) {
      return false;
    }
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

  // =================== SIMPLE SYNCHRONOUS LINE TRACKING ===================

  /**
   * Get the total number of lines in the buffer (SYNCHRONOUS)
   * @returns {number} - Total line count
   */
  getTotalLineCount() {
    const totalSize = this.vpm.getTotalSize();
    if (totalSize === 0) {
      return 1; // Empty content has 1 line
    }

    let lineCount = 1; // Start with first line
    
    for (const descriptor of this.vpm.addressIndex.getAllPages()) {
      if (descriptor.virtualSize === 0) {
        continue; // Skip empty pages
      }

      // Use cached newline count if available
      if (descriptor.lineInfoCached) {
        lineCount += descriptor.newlineCount;
      } else if (this.vpm.pageCache.has(descriptor.pageId)) {
        // Page is loaded - count newlines and cache the result
        const pageInfo = this.vpm.pageCache.get(descriptor.pageId);
        pageInfo.ensureLineCacheValid();
        descriptor.cacheLineInfo(pageInfo);
        lineCount += descriptor.newlineCount;
      } else {
        // Page not loaded and no cached count - we can't know exactly
        // This is a limitation of keeping it synchronous
        // For now, assume worst case of 0 newlines in unloaded pages
        // (Total will be underestimated but won't crash)
      }
    }
    
    return lineCount;
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

    const totalSize = this.vpm.getTotalSize();
    if (totalSize === 0) {
      return lineNumber === 1 ? 
        new LineOperationResult(1, 0, 0, [], true) : null;
    }

    let currentLine = 1;
    let currentAddress = 0;

    for (const descriptor of this.vpm.addressIndex.getAllPages()) {
      if (descriptor.virtualSize === 0) {
        continue;
      }

      const pageStartLine = currentLine;
      const pageStartAddress = currentAddress;
      const pageEndAddress = descriptor.virtualStart + descriptor.virtualSize;

      // Count lines in this page
      let pageLinesCount = 0;
      let exactPositions = null;

      if (this.vpm.pageCache.has(descriptor.pageId)) {
        // Page is loaded - get exact line positions
        const pageInfo = this.vpm.pageCache.get(descriptor.pageId);
        pageInfo.ensureLineCacheValid();
        descriptor.cacheLineInfo(pageInfo);
        pageLinesCount = descriptor.newlineCount;
        exactPositions = pageInfo.newlinePositions;
      } else if (descriptor.lineInfoCached) {
        // Use cached count
        pageLinesCount = descriptor.newlineCount;
      }

      // Check if target line is in this page
      if (lineNumber >= currentLine && lineNumber < currentLine + pageLinesCount + 1) {
        if (exactPositions && lineNumber < currentLine + pageLinesCount) {
          // Target line ends with a newline in this page - exact position
          const lineIndex = lineNumber - currentLine;
          const lineStart = lineIndex === 0 ? descriptor.virtualStart : 
            descriptor.virtualStart + exactPositions[lineIndex - 1] + 1;
          const lineEnd = descriptor.virtualStart + exactPositions[lineIndex] + 1;
          
          const marks = this.getMarksInRange(lineStart, lineEnd - 1);
          return new LineOperationResult(lineNumber, lineStart, lineEnd, marks, true);
        } else if (exactPositions) {
          // Target line is the last line in this page (no trailing newline)
          const lastNewlinePos = exactPositions.length > 0 ? 
            descriptor.virtualStart + exactPositions[exactPositions.length - 1] + 1 : 
            descriptor.virtualStart;
          const lineStart = exactPositions.length > 0 ? lastNewlinePos : descriptor.virtualStart;
          const lineEnd = pageEndAddress;
          
          const marks = this.getMarksInRange(lineStart, lineEnd - 1);
          return new LineOperationResult(lineNumber, lineStart, lineEnd, marks, true);
        } else {
          // Page not loaded - return page boundaries as approximation
          const marks = this.getMarksInRange(descriptor.virtualStart, pageEndAddress - 1);
          return new LineOperationResult(lineNumber, descriptor.virtualStart, pageEndAddress, marks, false);
        }
      }

      currentLine += pageLinesCount;
      currentAddress = pageEndAddress;
    }

    // Line not found or beyond end
    return null;
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
    const clampedEnd = Math.max(clampedStart, endLine);
    
    for (let lineNum = clampedStart; lineNum <= clampedEnd; lineNum++) {
      const lineInfo = this.getLineInfo(lineNum);
      if (lineInfo) {
        result.push(lineInfo);
      } else {
        break; // No more lines
      }
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

    if (this.vpm.getTotalSize() === 0) {
      return 1; // Empty buffer has line 1
    }

    let currentLine = 1;

    for (const descriptor of this.vpm.addressIndex.getAllPages()) {
      if (descriptor.virtualSize === 0) {
        continue;
      }

      // Check if address is in this page
      if (virtualAddress >= descriptor.virtualStart && virtualAddress < descriptor.virtualEnd) {
        if (this.vpm.pageCache.has(descriptor.pageId)) {
          // Page is loaded - get exact line
          const pageInfo = this.vpm.pageCache.get(descriptor.pageId);
          pageInfo.ensureLineCacheValid();
          descriptor.cacheLineInfo(pageInfo);
          
          const relativeAddress = virtualAddress - descriptor.virtualStart;
          let linesInPage = 0;
          
          for (const nlPos of pageInfo.newlinePositions) {
            if (relativeAddress <= nlPos) {
              break;
            }
            linesInPage++;
          }
          
          return currentLine + linesInPage;
        } else {
          // Page not loaded - return start of page's line range
          return currentLine;
        }
      }

      // Count lines in this page and continue
      if (this.vpm.pageCache.has(descriptor.pageId)) {
        const pageInfo = this.vpm.pageCache.get(descriptor.pageId);
        pageInfo.ensureLineCacheValid();
        descriptor.cacheLineInfo(pageInfo);
        currentLine += descriptor.newlineCount;
      } else if (descriptor.lineInfoCached) {
        currentLine += descriptor.newlineCount;
      }
    }

    return currentLine; // Address is at end of buffer
  }

  /**
   * Convert line/character position to absolute byte position (SYNCHRONOUS)
   * @param {Object} pos - {line, character} (both 1-based, character = byte offset in line)
   * @param {number[]} lineStarts - Ignored (legacy parameter)
   * @returns {number} - Absolute byte position
   */
  lineCharToBytePosition(pos, lineStarts = null) {
    const lineInfo = this.getLineInfo(pos.line);
    if (!lineInfo) {
      return this.vpm.getTotalSize();
    }

    const character = pos.character - 1; // Convert to 0-based
    if (character <= 0) {
      return lineInfo.byteStart;
    }

    // Simple byte arithmetic - character position is byte offset within line
    const targetByte = lineInfo.byteStart + character;
    
    // Clamp to line boundaries
    return Math.min(targetByte, lineInfo.byteEnd - 1);
  }

  /**
   * Convert absolute byte position to line/character position (SYNCHRONOUS)
   * @param {number} bytePos - Absolute byte position
   * @param {number[]} lineStarts - Ignored (legacy parameter)
   * @returns {Object} - {line, character} (both 1-based, character = byte offset in line + 1)
   */
  byteToLineCharPosition(bytePos, lineStarts = null) {
    const lineNumber = this.getLineNumberFromAddress(bytePos);
    
    if (lineNumber === 0) {
      return { line: 1, character: 1 };
    }

    const lineInfo = this.getLineInfo(lineNumber);
    if (!lineInfo) {
      return { line: lineNumber, character: 1 };
    }

    const byteOffsetInLine = bytePos - lineInfo.byteStart;
    
    // Simple byte arithmetic - character position is byte offset + 1 (for 1-based indexing)
    return { line: lineNumber, character: byteOffsetInLine + 1 };
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
    
    return {
      globalMarksCount: this.globalMarks.size,
      totalLines: -1, // No longer cached globally
      lineStartsCacheSize: 0, // No global cache
      lineStartsCacheValid: true, // Always valid since no cache
      estimatedMarksMemory: marksMemory,
      estimatedLinesCacheMemory: 0 // No global cache
    };
  }
}

module.exports = {
  LineAndMarksManager,
  LineOperationResult,
  ExtractedContent
};
