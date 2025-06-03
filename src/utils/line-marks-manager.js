/**
 * @fileoverview Line and Marks Manager - Page coordinate-based marks with CORRECTED logic
 * @description Manages line positions and named marks using page coordinates for efficiency
 * @author Jeffrey R. Day
 * @version 2.1.1 - Fixed mark update logic for deletions and page operations
 */

const logger = require('./logger');

/**
 * @typedef {Array<string|number>} MarkTuple
 * @property {string} 0 - The name of the mark.
 * @property {number} 1 - The absolute address of the mark.
 */

/**
 * @typedef {Array<string|number>} RelativeMarkTuple
 * @property {string} 0 - The name of the mark.
 * @property {number} 1 - The relative address of the mark.
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
 * Page coordinate-based marks and line manager
 */
class LineAndMarksManager {
  constructor(virtualPageManager) {
    this.vpm = virtualPageManager;
    
    // Page coordinate marks storage (global only)
    this.globalMarks = new Map(); // markName -> [pageId, offset]
    this.pageToMarks = new Map(); // pageId -> Set<markName> (for performance)
  }

  // =================== INTERNAL COORDINATE METHODS ===================

  /**
   * Convert virtual address to page coordinates
   * @param {number} virtualAddress - Virtual buffer address
   * @returns {Array} - [pageId, offset]
   * @private
   */
  _virtualToPageCoord(virtualAddress) {
    // Handle address at the very end of buffer
    const totalSize = this.vpm.getTotalSize();
    if (virtualAddress === totalSize && totalSize > 0) {
      const allPages = this.vpm.addressIndex.getAllPages();
      if (allPages.length > 0) {
        const lastPage = allPages[allPages.length - 1];
        return [lastPage.pageId, lastPage.virtualSize];
      }
    }
    
    const descriptor = this.vpm.addressIndex.findPageAt(virtualAddress);
    if (!descriptor) {
      throw new Error(`No page found for virtual address ${virtualAddress}`);
    }
    const offset = virtualAddress - descriptor.virtualStart;
    return [descriptor.pageId, offset];
  }

  /**
   * Convert page coordinates to virtual address
   * @param {string} pageId - Page identifier
   * @param {number} offset - Offset within page
   * @returns {number} - Virtual buffer address
   * @private
   */
  _pageCoordToVirtual(pageId, offset) {
    const descriptor = this.vpm.addressIndex.pages.find(p => p.pageId === pageId);
    if (!descriptor) {
      throw new Error(`Page ${pageId} not found`);
    }
    return descriptor.virtualStart + offset;
  }

  /**
   * Set mark using page coordinates
   * @param {string} markName - Name of the mark
   * @param {string} pageId - Page identifier
   * @param {number} offset - Offset within page
   * @private
   */
  _setMarkByCoord(markName, pageId, offset) {
    // Remove from old page index if exists
    const oldCoord = this.globalMarks.get(markName);
    if (oldCoord) {
      this._removeFromPageIndex(markName, oldCoord[0]);
    }

    // Set new coordinates (using array for performance)
    this.globalMarks.set(markName, [pageId, offset]);
    
    // Update page index
    if (!this.pageToMarks.has(pageId)) {
      this.pageToMarks.set(pageId, new Set());
    }
    this.pageToMarks.get(pageId).add(markName);
  }

  /**
   * Remove mark from page index
   * @param {string} markName - Name of the mark
   * @param {string} pageId - Page identifier
   * @private
   */
  _removeFromPageIndex(markName, pageId) {
    const markSet = this.pageToMarks.get(pageId);
    if (markSet) {
      markSet.delete(markName);
      if (markSet.size === 0) {
        this.pageToMarks.delete(pageId);
      }
    }
  }

  /**
   * Get all mark names in a specific page
   * @param {string} pageId - Page identifier
   * @returns {Set<string>} - Set of mark names
   * @private
   */
  _getMarkNamesInPage(pageId) {
    return this.pageToMarks.get(pageId) || new Set();
  }

  /**
   * Helper method to update mark coordinate and page index
   * @param {string} markName - Name of the mark
   * @param {Array} coord - Coordinate array to update in place [pageId, offset]
   * @param {Array} newCoord - New coordinate [pageId, offset]
   * @private
   */
  _updateMarkCoordinate(markName, coord, newCoord) {
    const [oldPageId] = coord;
    const [newPageId, newOffset] = newCoord;
    
    // Update the coordinate in place
    coord[0] = newPageId;
    coord[1] = newOffset;
    
    // Update page index if page changed
    if (oldPageId !== newPageId) {
      // Remove from old page index
      this._removeFromPageIndex(markName, oldPageId);
      
      // Add to new page index
      if (!this.pageToMarks.has(newPageId)) {
        this.pageToMarks.set(newPageId, new Set());
      }
      this.pageToMarks.get(newPageId).add(markName);
    }
  }

  // =================== PAGE STRUCTURE UPDATE OPERATIONS (Page Coordinate Based) ===================
  // These handle page splits/merges - only called by VPM for structural changes

  /**
   * Handle page split - transfer marks to appropriate pages
   * @param {string} originalPageId - Original page being split
   * @param {string} newPageId - New page created from split
   * @param {number} splitOffset - Offset within original page where split occurred
   */
  handlePageSplit(originalPageId, newPageId, splitOffset) {
    const markNames = this.pageToMarks.get(originalPageId);
    if (!markNames) return;
    
    const marksToMove = [];
    
    // Find marks that need to move to the new page
    for (const markName of markNames) {
      const coord = this.globalMarks.get(markName);
      const [_pageId, offset] = coord;
      
      if (offset >= splitOffset) {
        marksToMove.push(markName);
      }
    }
    
    // Move marks to new page
    for (const markName of marksToMove) {
      const coord = this.globalMarks.get(markName);
      coord[0] = newPageId; // Update pageId
      coord[1] -= splitOffset; // Adjust offset
      
      // Update page index
      this.pageToMarks.get(originalPageId).delete(markName);
      if (!this.pageToMarks.has(newPageId)) {
        this.pageToMarks.set(newPageId, new Set());
      }
      this.pageToMarks.get(newPageId).add(markName);
    }
  }

  /**
   * Handle page merge - transfer marks from absorbed page
   * @param {string} absorbedPageId - Page being absorbed/deleted
   * @param {string} targetPageId - Page absorbing the content
   * @param {number} insertOffset - Offset in target page where absorbed content starts
   */
  handlePageMerge(absorbedPageId, targetPageId, insertOffset) {
    const markNames = this.pageToMarks.get(absorbedPageId);
    if (!markNames) return;
    
    // Move all marks from absorbed page to target page
    for (const markName of markNames) {
      const coord = this.globalMarks.get(markName);
      coord[0] = targetPageId; // Update pageId
      coord[1] = insertOffset + coord[1]; // Adjust offset
      
      // Update page index
      if (!this.pageToMarks.has(targetPageId)) {
        this.pageToMarks.set(targetPageId, new Set());
      }
      this.pageToMarks.get(targetPageId).add(markName);
    }
    
    // Remove absorbed page from index
    this.pageToMarks.delete(absorbedPageId);
  }

  /**
   * Validate and clean up orphaned marks
   * @returns {Array<string>} - Names of orphaned marks that were removed
   */
  validateAndCleanupMarks() {
    const orphanedMarks = [];
    
    for (const [markName, coord] of this.globalMarks) {
      const [pageId, offset] = coord;
      
      // Check if page still exists
      const descriptor = this.vpm.addressIndex.pages.find(p => p.pageId === pageId);
      if (!descriptor) {
        orphanedMarks.push(markName);
        continue;
      }
      
      // Check if offset is within page bounds
      if (offset > descriptor.virtualSize) {
        // Try to move mark to next page
        const nextPage = this._findNextPage(descriptor);
        if (nextPage) {
          coord[0] = nextPage.pageId;
          coord[1] = 0; // Move to start of next page
          
          // Update page index
          this._removeFromPageIndex(markName, pageId);
          if (!this.pageToMarks.has(nextPage.pageId)) {
            this.pageToMarks.set(nextPage.pageId, new Set());
          }
          this.pageToMarks.get(nextPage.pageId).add(markName);
        } else {
          // No next page - clamp to end of current page
          coord[1] = Math.max(0, descriptor.virtualSize - 1);
        }
      }
    }
    
    // Remove orphaned marks
    for (const markName of orphanedMarks) {
      this.removeMark(markName);
    }
    
    return orphanedMarks;
  }

  /**
   * Find the next page after the given page
   * @param {PageDescriptor} currentPage - Current page descriptor
   * @returns {PageDescriptor|null} - Next page or null
   * @private
   */
  _findNextPage(currentPage) {
    const pages = this.vpm.addressIndex.getAllPages();
    const currentIndex = pages.findIndex(p => p.pageId === currentPage.pageId);
    return currentIndex >= 0 && currentIndex < pages.length - 1 ? pages[currentIndex + 1] : null;
  }

  // =================== PUBLIC MARKS API ===================

  /**
   * Set a named mark at a virtual address
   * @param {string} markName - Name of the mark
   * @param {number} virtualAddress - Virtual buffer address
   */
  setMark(markName, virtualAddress) {
    const totalSize = this.vpm.getTotalSize();
    if (virtualAddress < 0 || virtualAddress > totalSize) {
      throw new Error(`Mark address ${virtualAddress} is out of range`);
    }

    // Handle the special case of marking at the very end of the buffer
    if (virtualAddress === totalSize) {
      // Find the last page or create one if empty
      const allPages = this.vpm.addressIndex.getAllPages();
      if (allPages.length > 0) {
        const lastPage = allPages[allPages.length - 1];
        this._setMarkByCoord(markName, lastPage.pageId, lastPage.virtualSize);
        return;
      }
    }

    const coord = this._virtualToPageCoord(virtualAddress);
    this._setMarkByCoord(markName, coord[0], coord[1]);
  }

  /**
   * Get the virtual address of a named mark
   * @param {string} markName - Name of the mark
   * @returns {number|null} - Virtual address or null if not found
   */
  getMark(markName) {
    const coord = this.globalMarks.get(markName);
    if (!coord) return null;
    
    try {
      return this._pageCoordToVirtual(coord[0], coord[1]);
    } catch (error) {
      // Page might have been deleted - mark is orphaned
      return null;
    }
  }

  /**
   * Remove a named mark
   * @param {string} markName - Name of the mark
   * @returns {boolean} - True if mark was found and removed
   */
  removeMark(markName) {
    const coord = this.globalMarks.get(markName);
    if (!coord) return false;
    
    // Remove from page index
    this._removeFromPageIndex(markName, coord[0]);
    
    // Remove from global registry
    this.globalMarks.delete(markName);
    
    return true;
  }

  /**
   * Get all marks between two virtual addresses
   * @param {number} startAddress - Start address (inclusive)
   * @param {number} endAddress - End address (inclusive)
   * @returns {Array<MarkTuple>} - Name and absolute address of each mark
   */
  getMarksInRange(startAddress, endAddress) {
    const result = [];
    
    for (const [markName, coord] of this.globalMarks) {
      try {
        const virtualAddress = this._pageCoordToVirtual(coord[0], coord[1]);
        if (virtualAddress >= startAddress && virtualAddress <= endAddress) {
          result.push([markName, virtualAddress]);
        }
      } catch (error) {
        // Skip orphaned marks
        continue;
      }
    }
    
    return result.sort((a, b) => a[1] - b[1]);
  }

  /**
   * Get all marks in the buffer
   * @returns {Array<MarkTuple>} - Name and absolute address of all marks
   */
  getAllMarks() {
    const result = [];
    
    for (const [markName, coord] of this.globalMarks) {
      try {
        const virtualAddress = this._pageCoordToVirtual(coord[0], coord[1]);
        result.push([markName, virtualAddress]);
      } catch (error) {
        // Skip orphaned marks
        continue;
      }
    }
    
    return result.sort((a, b) => a[1] - b[1]);
  }

  /**
   * Get information about marks in content that will be deleted
   * This reports what marks were in the deleted content (for paste operations)
   * but does NOT remove the marks - they get consolidated to deletion start
   * @param {number} startAddress - Start address
   * @param {number} endAddress - End address
   * @returns {Array<RelativeMarkTuple>} - Relative mark info for deleted content
   */
  getMarksInDeletedContent(startAddress, endAddress) {
    const marksInfo = [];

    for (const [markName, coord] of this.globalMarks) {
      try {
        const virtualAddress = this._pageCoordToVirtual(coord[0], coord[1]);
        if (virtualAddress >= startAddress && virtualAddress < endAddress) {
          marksInfo.push([markName, virtualAddress - startAddress]);
        }
      } catch (error) {
        // Skip orphaned marks
        continue;
      }
    }

    return marksInfo.sort((a, b) => a[1] - b[1]);
  }

  /**
   * Remove marks from a range entirely (for true extraction/cut operations)
   * This actually removes marks from the buffer - used when marks should disappear
   * @param {number} startAddress - Start address
   * @param {number} endAddress - End address
   * @returns {Array<RelativeMarkTuple>} - Relative info for removed marks
   */
  removeMarksFromRange(startAddress, endAddress) {
    const removed = [];
    const marksToRemove = [];

    for (const [markName, coord] of this.globalMarks) {
      try {
        const virtualAddress = this._pageCoordToVirtual(coord[0], coord[1]);
        if (virtualAddress >= startAddress && virtualAddress < endAddress) {
          removed.push([markName, virtualAddress - startAddress]);
          marksToRemove.push(markName);
        }
      } catch (error) {
        // Mark is orphaned - remove it
        marksToRemove.push(markName);
      }
    }

    // Actually remove the marks
    for (const markName of marksToRemove) {
      this.removeMark(markName);
    }

    return removed.sort((a, b) => a[1] - b[1]);
  }

  /**
   * Insert marks from relative positions (for insert operations)
   * @param {number} insertAddress - Address where content was inserted
   * @param {Array<RelativeMarkTuple>} marks - Relative marks to insert
   */
  insertMarksFromRelative(insertAddress, marks) {
    for (const markData of marks) {
      const virtualAddress = insertAddress + markData[1];
      this.setMark(markData[0], virtualAddress);
    }
  }

  // =================== PERSISTENCE API ===================

  /**
   * Get all marks as a key-value object with virtual addresses (for persistence)
   * @returns {Object} - Object mapping mark names to virtual addresses
   */
  getAllMarksForPersistence() {
    const result = {};
    
    for (const [markName, coord] of this.globalMarks) {
      try {
        const virtualAddress = this._pageCoordToVirtual(coord[0], coord[1]);
        result[markName] = virtualAddress;
      } catch (error) {
        // Skip orphaned marks
        continue;
      }
    }
    
    return result;
  }

  /**
   * Set marks from a key-value object (for persistence)
   * Updates/overwrites conflicting marks, retains others
   * @param {Object} marksObject - Object mapping mark names to virtual addresses
   */
  setMarksFromPersistence(marksObject) {
    for (const [markName, virtualAddress] of Object.entries(marksObject)) {
      if (typeof virtualAddress === 'number' && virtualAddress >= 0) {
        try {
          this.setMark(markName, virtualAddress);
        } catch (error) {
          // Skip invalid addresses
          continue;
        }
      }
    }
  }

  /**
   * Clear all marks
   */
  clearAllMarks() {
    this.globalMarks.clear();
    this.pageToMarks.clear();
  }

  // =================== ENHANCED OPERATIONS WITH MARKS ===================

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
   * CORRECTED: Enhanced insertBytes - handles marks correctly with page operations
   * @param {number} position - Insert position
   * @param {Buffer} data - Data to insert
   * @param {Array<RelativeMarkTuple>} marks -Relative marks to insert
   */
  async insertBytesWithMarks(position, data, marks = []) {
    logger.debug(`[DEBUG] insertBytesWithMarks: position=${position}, dataLen=${data.length}`);
    logger.debug('[DEBUG] Marks before operation:', this.getAllMarks());
    
    // STEP 1: Capture marks that need to be shifted (AFTER insertion point, not AT)
    const marksToShift = [];
    for (const [markName, coord] of this.globalMarks) {
      try {
        const markVirtualPos = this._pageCoordToVirtual(coord[0], coord[1]);
        if (markVirtualPos > position) { // FIXED: Only marks AFTER insertion point get shifted
          marksToShift.push({ name: markName, originalPos: markVirtualPos });
        }
      } catch (error) {
        // Skip invalid marks
        continue;
      }
    }
    
    logger.debug('[DEBUG] Marks to shift:', marksToShift);
    
    // STEP 2: Let VPM handle the insertion first (including any page splits)
    await this.vpm.insertAt(position, data);
    
    logger.debug('[DEBUG] Marks after VPM insertAt:', this.getAllMarks());
    
    // STEP 3: Now update the captured marks to their new positions
    for (const markInfo of marksToShift) {
      const newPos = markInfo.originalPos + data.length;
      try {
        this.setMark(markInfo.name, newPos);
      } catch (error) {
        logger.warn(`Failed to update mark ${markInfo.name} to position ${newPos}: ${error.message}`);
      }
    }
    
    logger.debug('[DEBUG] Marks after shifting:', this.getAllMarks());
    
    // STEP 4: Insert new marks
    if (marks.length > 0) {
      this.insertMarksFromRelative(position, marks);
      logger.debug('[DEBUG] Marks after inserting new marks:', this.getAllMarks());
    }
  }

  /**
   * CORRECTED: Enhanced deleteBytes - reports marks in deleted content but consolidates them
   * @param {number} start - Start address
   * @param {number} end - End address
   * @param {boolean} reportMarks - Whether to report marks that were in deleted content
   * @returns {Promise<ExtractedContent>} - Deleted data with optional marks report
   */
  async deleteBytesWithMarks(start, end, reportMarks = false) {
    logger.debug(`[DEBUG] deleteBytesWithMarks: start=${start}, end=${end}, reportMarks=${reportMarks}`);
    logger.debug('[DEBUG] Marks before operation:', this.getAllMarks());
    
    // STEP 1: If requested, get info about marks in the deleted content (for paste operations)
    let marksInDeletedContent = [];
    if (reportMarks) {
      marksInDeletedContent = this.getMarksInDeletedContent(start, end);
      logger.debug('[DEBUG] Marks in deleted content (for reporting):', marksInDeletedContent);
    }
    
    // STEP 2: Update marks for the content change (this will move marks in deletion range to deletion start)
    this.updateMarksAfterModification(start, end - start, 0);
    
    logger.debug('[DEBUG] Marks after consolidating to deletion start:', this.getAllMarks());
    
    // STEP 3: Let VPM handle the actual deletion (VPM will handle any page structure changes)
    const deletedData = await this.vpm.deleteRange(start, end);
    
    logger.debug('[DEBUG] Marks after VPM deleteRange:', this.getAllMarks());
    
    // Return deleted data with marks report (if requested)
    return new ExtractedContent(deletedData, marksInDeletedContent);
  }

  /**
   * Enhanced overwriteBytes with marks support
   * @param {number} position - Overwrite position
   * @param {Buffer} data - New data
   * @param {Array<RelativeMarkTuple>} marks - Relative marks to insert
   * @returns {Promise<ExtractedContent>} - Overwritten data with marks info
   */
  async overwriteBytesWithMarks(position, data, marks = []) {
    const endPosition = Math.min(position + data.length, this.vpm.getTotalSize());
    const originalSize = endPosition - position;
    const netSizeChange = data.length - originalSize;
    
    logger.debug(`[DEBUG] overwriteBytesWithMarks: position=${position}, dataLen=${data.length}, originalSize=${originalSize}, netChange=${netSizeChange}`);
    logger.debug('[DEBUG] Marks before operation:', this.getAllMarks());
    
    // Get overwritten data before modification
    const overwrittenData = await this.vpm.readRange(position, endPosition);
    
    // Handle marks based on the type of overwrite
    let marksInOverwrittenContent = [];
    if (data.length < originalSize) {
      // Content is shrinking - report marks that will be in the removed portion
      marksInOverwrittenContent = this.getMarksInDeletedContent(position + data.length, endPosition);
    }
    
    // Capture marks that need to be shifted (after the overwrite region)
    const marksToShift = [];
    if (netSizeChange !== 0) {
      for (const [markName, coord] of this.globalMarks) {
        try {
          const markVirtualPos = this._pageCoordToVirtual(coord[0], coord[1]);
          if (markVirtualPos >= endPosition) {
            marksToShift.push({ name: markName, originalPos: markVirtualPos });
          }
        } catch (error) {
          // Skip invalid marks
          continue;
        }
      }
    }
    
    // If content is shrinking, consolidate marks in the removed portion
    if (data.length < originalSize) {
      this.updateMarksAfterModification(position + data.length, originalSize - data.length, 0);
    }
    
    logger.debug('[DEBUG] Marks after consolidation, before VPM:', this.getAllMarks());
    
    // Let VPM handle the actual overwrite (VPM will handle any page structure changes)
    await this.vpm.deleteRange(position, endPosition);
    await this.vpm.insertAt(position, data);
    
    logger.debug('[DEBUG] Marks after VPM operations:', this.getAllMarks());
    
    // Update marks that were after the overwrite region
    for (const markInfo of marksToShift) {
      const newPos = markInfo.originalPos + netSizeChange;
      try {
        this.setMark(markInfo.name, newPos);
      } catch (error) {
        logger.warn(`Failed to update mark ${markInfo.name} to position ${newPos}: ${error.message}`);
      }
    }
    
    // Insert new marks
    if (marks.length > 0) {
      this.insertMarksFromRelative(position, marks);
      logger.debug('[DEBUG] Marks after inserting new marks:', this.getAllMarks());
    }
    
    return new ExtractedContent(overwrittenData, marksInOverwrittenContent);
  }

  /**
   * CORRECTED: Update marks after a modification using virtual addresses
   * This method handles logical mark movement for content changes
   * @param {number} virtualStart - Start of modification
   * @param {number} deletedBytes - Bytes deleted
   * @param {number} insertedBytes - Bytes inserted
   */
  updateMarksAfterModification(virtualStart, deletedBytes, insertedBytes) {
    const virtualEnd = virtualStart + deletedBytes;
    const netChange = insertedBytes - deletedBytes;
    
    logger.debug(`[DEBUG] updateMarksAfterModification: start=${virtualStart}, deleted=${deletedBytes}, inserted=${insertedBytes}, netChange=${netChange}`);
    
    // Create a list of marks to update (avoid modifying map during iteration)
    const marksToUpdate = [];
    for (const [markName, coord] of this.globalMarks) {
      try {
        const markVirtualPos = this._pageCoordToVirtual(coord[0], coord[1]);
        marksToUpdate.push({ name: markName, virtualPos: markVirtualPos, coord }); // bespoke three part object for this task
        logger.debug(`[DEBUG] Mark ${markName} at position ${markVirtualPos}`);
      } catch (error) {
        // Mark coordinate is invalid - skip for now, don't remove yet
        logger.warn(`Mark ${markName} has invalid coordinates, skipping update`);
        continue;
      }
    }
    
    // Update marks based on their position relative to the modification
    for (const mark of marksToUpdate) {
      const { name, virtualPos, coord } = mark;
      
      if (virtualPos < virtualStart) {
        // Mark before modification - no change
        logger.debug(`[DEBUG] Mark ${name}: before modification, no change`);
        continue;
        
      } else if (virtualPos === virtualStart) {
        // CORRECTED: Mark exactly at modification start
        if (deletedBytes === 0) {
          // Pure insertion at this point - mark stays at insertion point
          logger.debug(`[DEBUG] Mark ${name}: at insertion point, stays put`);
          continue;
        } else {
          // Deletion starting at this point - mark stays at deletion start
          logger.debug(`[DEBUG] Mark ${name}: at deletion start, stays put`);
          continue;
        }
        
      } else if (deletedBytes > 0 && virtualPos > virtualStart && virtualPos < virtualEnd) {
        // CORRECTED: Mark within deleted region - move to deletion start (don't remove!)
        logger.debug(`[DEBUG] Mark ${name}: within deletion range [${virtualStart}, ${virtualEnd}), moving to deletion start`);
        try {
          const newCoord = this._virtualToPageCoord(virtualStart);
          this._updateMarkCoordinate(name, coord, newCoord);
        } catch (error) {
          logger.warn(`Failed to move mark ${name} to deletion start: ${error.message}`);
          // Don't remove the mark, leave it where it is
        }
        
      } else if (virtualPos >= virtualEnd) {
        // CORRECTED: Mark after deletion end - shift by net change
        logger.debug(`[DEBUG] Mark ${name}: after modification, shifting by ${netChange} (${virtualPos} + ${netChange} = ${virtualPos + netChange})`);
        try {
          const newVirtualPos = virtualPos + netChange;
          const newCoord = this._virtualToPageCoord(newVirtualPos);
          this._updateMarkCoordinate(name, coord, newCoord);
        } catch (error) {
          logger.warn(`Failed to shift mark ${name}: ${error.message}`);
          // Don't remove the mark, leave it where it is
        }
      } else {
        logger.debug(`[DEBUG] Mark ${name}: no condition matched - virtualPos=${virtualPos}, virtualStart=${virtualStart}, virtualEnd=${virtualEnd}, deletedBytes=${deletedBytes}`);
      }
    }
    
    // Invalidate line caches after mark updates
    this.invalidateLineCaches();
  }

  // =================== LINE TRACKING (UNCHANGED) ===================
  
  /**
   * Invalidate line caches (called when buffer content changes)
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
      } else if (this.vpm && this.vpm.pageCache.has(descriptor.pageId)) {
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

    for (const descriptor of this.vpm.addressIndex.getAllPages()) {
      if (descriptor.virtualSize === 0) {
        continue;
      }

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
    if (virtualAddress < 0) {
      return 0;
    }
    
    const totalSize = this.vpm.getTotalSize();
    if (virtualAddress > totalSize) {
      return 0;
    }

    if (totalSize === 0) {
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
   * @returns {number} - Absolute byte position
   */
  lineCharToBytePosition(pos) {
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
   * @returns {Object} - {line, character} (both 1-based, character = byte offset in line + 1)
   */
  byteToLineCharPosition(bytePos) {
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

  /**
   * Get memory usage statistics
   * @returns {Object} - Memory usage info
   */
  getMemoryStats() {
    // Calculate marks memory more accurately
    let marksMemory = 0;
    for (const [markName, coord] of this.globalMarks) {
      marksMemory += markName.length * 2; // String storage (UTF-16)
      marksMemory += 16; // Array overhead
      marksMemory += coord[0].length * 2; // pageId string
      marksMemory += 8; // offset number
    }
    
    // Add page index memory
    for (const markSet of this.pageToMarks.values()) {
      marksMemory += markSet.size * 16; // Set overhead per mark
    }
    
    return {
      globalMarksCount: this.globalMarks.size,
      pageIndexSize: this.pageToMarks.size,
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
