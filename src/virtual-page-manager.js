/**
 * @fileoverview Enhanced Virtual Page Manager with Line Tracking, Marks Integration, and Page Merging
 * @description Handles mapping between virtual buffer addresses and physical page locations
 * while maintaining sparse, efficient access to massive files, with comprehensive line and marks support
 * @author Jeffrey R. Day
 * @version 2.1.0 - Added page merging and marks coordination
 */

const fs = require('fs').promises;
const path = require('path');

/**
 * Represents a page's metadata for address translation
 */
class PageDescriptor {
  constructor(pageId, virtualStart, virtualSize, sourceType, sourceInfo) {
    this.pageId = pageId;
    this.virtualStart = virtualStart;    // Where this page starts in the virtual buffer
    this.virtualSize = virtualSize;      // Current size of this page in virtual space
    
    // Source information - where the data actually lives
    this.sourceType = sourceType;        // 'original', 'storage', 'memory'
    this.sourceInfo = sourceInfo;        // Location details
    
    // State tracking
    this.isDirty = false;               // Has been modified
    this.isLoaded = false;              // Currently in memory
    this.lastAccess = 0;                // For LRU eviction
    
    // Split/merge tracking
    this.generation = 0;                // For tracking split history
    this.parentId = null;               // Original page this came from
    
    // Persistent line info (survives eviction)
    this.newlineCount = 0;              // How many \n characters in this page
    this.lineInfoCached = false;        // Have we scanned this page for newlines yet?
  }

  /**
   * Get the virtual end position of this page
   */
  get virtualEnd() {
    return this.virtualStart + this.virtualSize;
  }

  /**
   * Check if a virtual position falls within this page
   */
  contains(virtualPos) {
    return virtualPos >= this.virtualStart && virtualPos < this.virtualEnd;
  }

  /**
   * Convert virtual position to relative position within this page
   */
  toRelativePosition(virtualPos) {
    if (!this.contains(virtualPos)) {
      throw new Error(`Position ${virtualPos} not in page ${this.pageId}`);
    }
    return virtualPos - this.virtualStart;
  }

  /**
   * Cache line information from a loaded page
   * @param {PageInfo} pageInfo - Loaded page info
   */
  cacheLineInfo(pageInfo) {
    this.newlineCount = pageInfo.getNewlineCount();
    this.lineInfoCached = true;
  }
}

/**
 * Efficient B-tree-like structure for fast address lookups
 * Uses binary search for O(log n) lookups even with thousands of pages
 * Hash map for O(1) pageId lookups
 */
class PageAddressIndex {
  constructor() {
    this.pages = [];           // Sorted array of PageDescriptors by virtualStart
    this.pageIdIndex = new Map(); // pageId -> PageDescriptor lookup for O(1) access
    this.totalVirtualSize = 0; // Cache of total virtual buffer size
  }

  /**
   * Find the page containing a virtual address
   * @param {number} virtualPos - Virtual position to look up
   * @returns {PageDescriptor|null} - Page containing this position
   */
  findPageAt(virtualPos) {
    if (this.pages.length === 0) return null;
    
    // Binary search for the correct page
    let left = 0;
    let right = this.pages.length - 1;
    
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const page = this.pages[mid];
      
      if (page.contains(virtualPos)) {
        return page;
      } else if (virtualPos < page.virtualStart) {
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    }
    
    return null;
  }

  /**
   * Find page by pageId
   * @param {string} pageId - Page ID to find
   * @returns {PageDescriptor|null} - Page descriptor or null
   */
  findPageById(pageId) {
    return this.pageIdIndex.get(pageId) || null;
  }

  /**
   * Insert a new page, maintaining sorted order
   * @param {PageDescriptor} pageDesc - Page to insert
   */
  insertPage(pageDesc) {
    // Find insertion point using binary search
    let insertIndex = 0;
    for (let i = 0; i < this.pages.length; i++) {
      if (this.pages[i].virtualStart > pageDesc.virtualStart) {
        insertIndex = i;
        break;
      }
      insertIndex = i + 1;
    }
    
    this.pages.splice(insertIndex, 0, pageDesc);
    this.pageIdIndex.set(pageDesc.pageId, pageDesc); // Add to hash map
    this._updateVirtualSizes();
  }

  /**
   * Remove a page from the index
   * @param {string} pageId - ID of page to remove
   */
  removePage(pageId) {
    const index = this.pages.findIndex(p => p.pageId === pageId);
    if (index >= 0) {
      this.pages.splice(index, 1);
      this.pageIdIndex.delete(pageId); // Remove from hash map
      this._updateVirtualSizes();
    }
  }

  /**
   * Update virtual addresses after a size change
   * @param {string} pageId - Page that changed size
   * @param {number} sizeDelta - Change in size (positive or negative)
   */
  updatePageSize(pageId, sizeDelta) {
    const pageIndex = this.pages.findIndex(p => p.pageId === pageId);
    if (pageIndex < 0) return;
    
    const page = this.pages[pageIndex];
    page.virtualSize += sizeDelta;
    
    // Shift all subsequent pages
    for (let i = pageIndex + 1; i < this.pages.length; i++) {
      this.pages[i].virtualStart += sizeDelta;
    }
    
    this.totalVirtualSize += sizeDelta;
  }

  /**
   * Split a page into two pages
   * @param {string} pageId - Page to split
   * @param {number} splitPoint - Relative position within page to split at
   * @param {string} newPageId - ID for the new second page
   * @returns {PageDescriptor} - The new second page descriptor
   */
  splitPage(pageId, splitPoint, newPageId) {
    const pageIndex = this.pages.findIndex(p => p.pageId === pageId);
    if (pageIndex < 0) throw new Error(`Page ${pageId} not found`);
    
    const originalPage = this.pages[pageIndex];
    const splitVirtualPos = originalPage.virtualStart + splitPoint;
    
    // Create new page for the second half
    const newPage = new PageDescriptor(
      newPageId,
      splitVirtualPos,
      originalPage.virtualSize - splitPoint,
      'memory', // Split pages start in memory
      { pageId: newPageId }
    );
    newPage.isDirty = true;
    newPage.generation = originalPage.generation + 1;
    newPage.parentId = originalPage.pageId;
    
    // Update original page to first half
    originalPage.virtualSize = splitPoint;
    
    // Insert new page right after original
    this.pages.splice(pageIndex + 1, 0, newPage);
    this.pageIdIndex.set(newPageId, newPage); // Add new page to hash map
    
    return newPage;
  }

  /**
   * Get all pages in virtual address order
   */
  getAllPages() {
    return [...this.pages];
  }

  /**
   * Get pages that intersect with a virtual range
   * @param {number} startPos - Start of range
   * @param {number} endPos - End of range
   * @returns {PageDescriptor[]} - Pages that intersect the range
   */
  getPagesInRange(startPos, endPos) {
    const result = [];
    
    for (const page of this.pages) {
      if (page.virtualStart >= endPos) break;
      if (page.virtualEnd > startPos) {
        result.push(page);
      }
    }
    
    return result;
  }

  /**
   * Recalculate total virtual size
   * @private
   */
  _updateVirtualSizes() {
    this.totalVirtualSize = this.pages.reduce((sum, page) => sum + page.virtualSize, 0);
  }

  /**
   * Validate the index consistency (for debugging)
   */
  validate() {
    let expectedStart = 0;
    
    for (let i = 0; i < this.pages.length; i++) {
      const page = this.pages[i];
      
      if (page.virtualStart !== expectedStart) {
        throw new Error(`Page ${page.pageId} has invalid virtual start: expected ${expectedStart}, got ${page.virtualStart}`);
      }
      
      if (page.virtualSize <= 0) {
        throw new Error(`Page ${page.pageId} has invalid size: ${page.virtualSize}`);
      }
      
      expectedStart += page.virtualSize;
    }
    
    if (expectedStart !== this.totalVirtualSize) {
      throw new Error(`Total size mismatch: expected ${expectedStart}, got ${this.totalVirtualSize}`);
    }
    
    // Validate hash map synchronization
    this.validateHashMapSync();
  }

  /**
   * Validate that hash map is synchronized with pages array
   * @throws {Error} If synchronization is broken
   */
  validateHashMapSync() {
    // Check that every page in array is in hash map
    for (const page of this.pages) {
      const hashMapPage = this.pageIdIndex.get(page.pageId);
      if (hashMapPage !== page) {
        throw new Error(`Hash map out of sync for page ${page.pageId}: expected same object reference`);
      }
    }
    
    // Check that hash map doesn't have extra entries
    if (this.pageIdIndex.size !== this.pages.length) {
      throw new Error(`Hash map size mismatch: ${this.pageIdIndex.size} entries vs ${this.pages.length} pages`);
    }
    
    // Check that every hash map entry points to a page in the array
    for (const [pageId, pageDesc] of this.pageIdIndex) {
      const arrayIndex = this.pages.findIndex(p => p.pageId === pageId);
      if (arrayIndex < 0) {
        throw new Error(`Hash map contains orphaned entry for page ${pageId}`);
      }
      if (this.pages[arrayIndex] !== pageDesc) {
        throw new Error(`Hash map entry for page ${pageId} points to wrong object`);
      }
    }
  }
}

/**
 * Enhanced Virtual Page Manager with Line Tracking, Marks Integration, and Page Merging
 */
class VirtualPageManager {
  constructor(buffer, pageSize = 64 * 1024) {
    this.buffer = buffer;
    this.pageSize = pageSize;
    this.nextPageId = 0;
    
    // Core data structures
    this.addressIndex = new PageAddressIndex();
    this.pageCache = new Map();        // pageId -> actual PageInfo objects
    this.loadedPages = new Set();      // Track which pages are in memory
    
    // Source file information
    this.sourceFile = null;
    this.sourceSize = 0;
    this.sourceChecksum = null;
    
    // Memory management
    this.maxLoadedPages = 100;
    this.lruOrder = [];               // For eviction decisions
    
    // Page merging thresholds
    this.minPageSize = Math.floor(pageSize / 4);  // Merge pages smaller than this
    this.maxPageSize = pageSize * 2;              // Split pages larger than this
    
    // Line and Marks Manager will be set by PagedBuffer
    this.lineAndMarksManager = null;
  }

  /**
   * Set the line and marks manager (called by PagedBuffer)
   * @param {LineAndMarksManager} manager - Line and marks manager instance
   */
  setLineAndMarksManager(manager) {
    this.lineAndMarksManager = manager;
  }

  /**
   * Initialize from a file
   * @param {string} filename - Source file path
   * @param {number} fileSize - File size
   * @param {string} checksum - File checksum
   */
  initializeFromFile(filename, fileSize, checksum) {
    this.sourceFile = filename;
    this.sourceSize = fileSize;
    this.sourceChecksum = checksum;
    
    // Create initial page descriptors for the entire file
    this._createInitialPages(fileSize);
    
    // Invalidate line caches since we have new content
    if (this.lineAndMarksManager && this.lineAndMarksManager.invalidateLineCaches) {
      this.lineAndMarksManager.invalidateLineCaches();
    }
  }

  /**
   * Initialize from string content
   * @param {Buffer} content - Content buffer
   */
  initializeFromContent(content) {
    this.sourceFile = null;
    this.sourceSize = content.length;
    
    // Handle empty content
    if (content.length === 0) {
      const pageId = this._generatePageId();
      const pageDesc = new PageDescriptor(
        pageId,
        0,              // virtualStart
        0,              // virtualSize
        'memory',       // sourceType
        { pageId }      // sourceInfo
      );
      pageDesc.isDirty = true;
      pageDesc.isLoaded = true;
      
      this.addressIndex.insertPage(pageDesc);
      this.pageCache.set(pageId, this._createPageInfo(pageDesc, Buffer.alloc(0)));
      this.loadedPages.add(pageId);
      
      // Apply memory limit after initialization
      this._applyMemoryLimit();
      
      // Invalidate line caches
      if (this.lineAndMarksManager) {
        this.lineAndMarksManager.invalidateLineCaches();
      }
      return;
    }
    
    // Create pages for content, respecting page size limits
    let offset = 0;
    while (offset < content.length) {
      const pageSize = Math.min(this.pageSize, content.length - offset);
      const pageId = this._generatePageId();
      const pageData = content.subarray(offset, offset + pageSize);
      
      const pageDesc = new PageDescriptor(
        pageId,
        offset,         // virtualStart
        pageSize,       // virtualSize
        'memory',       // sourceType
        { pageId }      // sourceInfo
      );
      pageDesc.isDirty = true;
      pageDesc.isLoaded = true;
      
      this.addressIndex.insertPage(pageDesc);
      const pageInfo = this._createPageInfo(pageDesc, pageData);
      this.pageCache.set(pageId, pageInfo);
      this.loadedPages.add(pageId);
      
      // Cache line information immediately for in-memory content
      pageDesc.cacheLineInfo(pageInfo);
      
      offset += pageSize;
    }
    
    // Apply memory limit after initialization
    this._applyMemoryLimit();
    
    // Invalidate line caches since we have new content
    if (this.lineAndMarksManager) {
      this.lineAndMarksManager.invalidateLineCaches();
    }
  }

  /**
   * Apply memory limit by evicting excess pages
   * @private
   */
  async _applyMemoryLimit() {
    while (this.loadedPages.size > this.maxLoadedPages) {
      // Find the oldest loaded page to evict
      const pageIds = Array.from(this.loadedPages);
      if (pageIds.length === 0) break;
      
      const pageToEvict = pageIds[0]; // Evict first (oldest) page
      const descriptor = this.addressIndex.pages.find(p => p.pageId === pageToEvict);
      
      if (descriptor && descriptor.isLoaded) {
        await this._evictPage(descriptor);
      }
    }
  }

  /**
   * Translate virtual address to page and relative position
   * @param {number} virtualPos - Virtual buffer position
   * @returns {Promise<{page: PageInfo, relativePos: number, descriptor: PageDescriptor}>}
   */
  async translateAddress(virtualPos) {
    // Handle negative positions
    if (virtualPos < 0) {
      throw new Error(`No page found for virtual position ${virtualPos}`);
    }
    
    // Allow insertion at the very end of the buffer
    if (virtualPos === this.addressIndex.totalVirtualSize) {
      // Find the last page or create one if empty
      const allPages = this.addressIndex.getAllPages();
      if (allPages.length === 0) {
        // Create an empty page for insertion
        const pageId = this._generatePageId();
        const pageDesc = new PageDescriptor(pageId, 0, 0, 'memory', { pageId });
        pageDesc.isDirty = true;
        pageDesc.isLoaded = true;
        
        this.addressIndex.insertPage(pageDesc);
        this.pageCache.set(pageId, this._createPageInfo(pageDesc, Buffer.alloc(0)));
        this.loadedPages.add(pageId);
        
        return {
          page: this.pageCache.get(pageId),
          relativePos: 0,
          descriptor: pageDesc
        };
      } else {
        const lastPage = allPages[allPages.length - 1];
        const pageInfo = await this._ensurePageLoaded(lastPage);
        return {
          page: pageInfo,
          relativePos: lastPage.virtualSize,
          descriptor: lastPage
        };
      }
    }
    
    // For positions beyond the end of buffer, throw error
    if (virtualPos > this.addressIndex.totalVirtualSize) {
      throw new Error(`No page found for virtual position ${virtualPos}`);
    }
    
    const descriptor = this.addressIndex.findPageAt(virtualPos);
    if (!descriptor) {
      throw new Error(`No page found for virtual position ${virtualPos}`);
    }
    
    const relativePos = descriptor.toRelativePosition(virtualPos);
    const pageInfo = await this._ensurePageLoaded(descriptor);
    
    return {
      page: pageInfo,
      relativePos,
      descriptor
    };
  }

  /**
   * Insert data at a virtual position with line and marks tracking
   * @param {number} virtualPos - Position to insert at
   * @param {Buffer} data - Data to insert
   */
  async insertAt(virtualPos, data) {
    console.log(`[DEBUG] insertAt: pos=${virtualPos}, dataLen=${data.length}`);
    
    const { descriptor, relativePos } = await this.translateAddress(virtualPos);
    const pageInfo = await this._ensurePageLoaded(descriptor);
    
    console.log(`[DEBUG] Page ${descriptor.pageId} current size: ${pageInfo.currentSize}, max: ${this.maxPageSize}`);
    
    // Perform the insertion within the page
    const before = pageInfo.data.subarray(0, relativePos);
    const after = pageInfo.data.subarray(relativePos);
    const newData = Buffer.concat([before, data, after]);
    
    // Update page data with line and marks tracking
    pageInfo.updateData(newData);
    
    // Update page-level marks for this modification
    pageInfo.updateAfterModification(relativePos, 0, data);
    
    descriptor.isDirty = true;
    
    // Invalidate cached line info since page content changed
    descriptor.lineInfoCached = false;
    
    // REMOVED: Content-based mark updates (handled globally now)
    // if (this.lineAndMarksManager && this.lineAndMarksManager.updateMarksAfterPageModification) {
    //   this.lineAndMarksManager.updateMarksAfterPageModification(
    //     descriptor.pageId,
    //     relativePos,
    //     0,
    //     data.length
    //   );
    // }
    
    // Update virtual addresses in the page index
    this.addressIndex.updatePageSize(descriptor.pageId, data.length);

    // Check if page needs splitting
    if (newData.length > this.maxPageSize) {
      console.log(`[DEBUG] Page split needed: ${newData.length} > ${this.maxPageSize}`);
      await this._splitPage(descriptor);
    }
    
    // Check for potential page merging opportunities
    await this._checkForMergeOpportunities();
    
    return data.length;
  }

  /**
   * Delete data from a virtual range with line and marks tracking
   * @param {number} startPos - Start position
   * @param {number} endPos - End position
   * @returns {Promise<Buffer>} - Deleted data
   */
  async deleteRange(startPos, endPos) {
    if (startPos >= endPos) {
      return Buffer.alloc(0);
    }
    
    // Clamp to valid range
    startPos = Math.max(0, startPos);
    endPos = Math.min(endPos, this.addressIndex.totalVirtualSize);
    
    if (startPos >= endPos) {
      return Buffer.alloc(0);
    }
    
    const deletedChunks = [];
    const affectedPages = this.addressIndex.getPagesInRange(startPos, endPos);
    
    // Process pages in reverse order to maintain position consistency
    for (let i = affectedPages.length - 1; i >= 0; i--) {
      const descriptor = affectedPages[i];
      const pageInfo = await this._ensurePageLoaded(descriptor);
      
      // Calculate intersection with delete range
      const deleteStart = Math.max(startPos, descriptor.virtualStart);
      const deleteEnd = Math.min(endPos, descriptor.virtualEnd);
      
      const relativeStart = deleteStart - descriptor.virtualStart;
      const relativeEnd = deleteEnd - descriptor.virtualStart;
      
      // Extract deleted data
      const deletedFromPage = pageInfo.data.subarray(relativeStart, relativeEnd);
      
      // Insert at beginning of array to maintain order
      deletedChunks.unshift(deletedFromPage);
      
      // Remove data from page
      const before = pageInfo.data.subarray(0, relativeStart);
      const after = pageInfo.data.subarray(relativeEnd);
      const newData = Buffer.concat([before, after]);
      
      // Update page data with line and marks tracking
      pageInfo.updateData(newData);
      
      // Update page-level marks for this modification
      pageInfo.updateAfterModification(relativeStart, relativeEnd - relativeStart, Buffer.alloc(0));
      
      descriptor.isDirty = true;
      
      // Invalidate cached line info since page content changed
      descriptor.lineInfoCached = false;
      
      // REMOVED: Content-based mark updates (handled globally now)
      // if (this.lineAndMarksManager && this.lineAndMarksManager.updateMarksAfterPageModification) {
      //   this.lineAndMarksManager.updateMarksAfterPageModification(
      //     descriptor.pageId,
      //     relativeStart,
      //     relativeEnd - relativeStart,
      //     0
      //   );
      // }
      
      // Update virtual size
      const sizeChange = -(relativeEnd - relativeStart);
      this.addressIndex.updatePageSize(descriptor.pageId, sizeChange);
    }
    
    // Clean up empty pages and merge small ones
    await this._cleanupAndMergePages();
    
    return Buffer.concat(deletedChunks);
  }

  /**
   * Read data from a virtual range
   * @param {number} startPos - Start position
   * @param {number} endPos - End position
   * @returns {Promise<Buffer>} - Read data
   */
  async readRange(startPos, endPos) {
    if (startPos >= endPos) {
      return Buffer.alloc(0);
    }
    
    // Clamp to valid range
    startPos = Math.max(0, startPos);
    endPos = Math.min(endPos, this.addressIndex.totalVirtualSize);
    
    if (startPos >= endPos) {
      return Buffer.alloc(0);
    }
    
    const chunks = [];
    const affectedPages = this.addressIndex.getPagesInRange(startPos, endPos);
    
    for (const descriptor of affectedPages) {
      try {
        const pageInfo = await this._ensurePageLoaded(descriptor);
        
        // Calculate intersection with read range
        const readStart = Math.max(startPos, descriptor.virtualStart);
        const readEnd = Math.min(endPos, descriptor.virtualEnd);
        
        const relativeStart = readStart - descriptor.virtualStart;
        const relativeEnd = readEnd - descriptor.virtualStart;
        
        // Handle case where page data is shorter than expected
        const actualEnd = Math.min(relativeEnd, pageInfo.data.length);
        
        if (relativeStart < pageInfo.data.length) {
          chunks.push(pageInfo.data.subarray(relativeStart, actualEnd));
        }
        
        // If we couldn't read the full expected range, fill with zeros or handle missing data
        if (actualEnd < relativeEnd) {
          const missingBytes = relativeEnd - actualEnd;
          // Fill missing with zeros for now - detachment is already handled in _ensurePageLoaded
          chunks.push(Buffer.alloc(missingBytes));
        }
        
      } catch (error) {
        // Page loading failed - this range will be missing from output
        // The _ensurePageLoaded method already handled detachment notification
        const missingSize = Math.min(endPos, descriptor.virtualEnd) - 
                           Math.max(startPos, descriptor.virtualStart);
        chunks.push(Buffer.alloc(missingSize)); // Fill with zeros
      }
    }
    
    return Buffer.concat(chunks);
  }

  /**
   * Get total virtual size
   */
  getTotalSize() {
    return this.addressIndex.totalVirtualSize;
  }

  // =================== PAGE MANAGEMENT ===================

  /**
   * Split a page that has grown too large
   * @private
   */
  async _splitPage(descriptor) {
    console.log(`[DEBUG] _splitPage called for page ${descriptor.pageId}`);
    const pageInfo = this.pageCache.get(descriptor.pageId);
    if (!pageInfo) return;
    
    const splitPoint = Math.floor(pageInfo.currentSize / 2);
    const newPageId = this._generatePageId();
    
    // Extract marks from the second half before splitting
    const marksInSecondHalf = pageInfo.extractMarksFromRange(splitPoint, pageInfo.currentSize);
    
    // Split the page in the address index
    const newDescriptor = this.addressIndex.splitPage(
      descriptor.pageId,
      splitPoint,
      newPageId
    );
    
    // Create new page data
    const newData = pageInfo.data.subarray(splitPoint);
    const newPageInfo = this._createPageInfo(newDescriptor, newData);
    
    // Insert marks into the new page
    newPageInfo.insertMarksFromRelative(0, marksInSecondHalf, newDescriptor.virtualStart);
    
    // Update original page data
    const originalData = pageInfo.data.subarray(0, splitPoint);
    pageInfo.updateData(originalData);
    
    // Invalidate line caches after cleanup
    if (this.lineAndMarksManager && this.lineAndMarksManager.invalidateLineCaches) {
      this.lineAndMarksManager.invalidateLineCaches();
    }

    // Make sure notification is called
    console.log(`[DEBUG] Sending split notification`);
    this.buffer._notify(
      'page_split',
      'info',
      `Split page ${descriptor.pageId} at ${splitPoint} bytes`,
      { originalPageId: descriptor.pageId, newPageId, splitPoint }
    );
  }

  /**
   * Check for page merging opportunities
   * @private
   */
  async _checkForMergeOpportunities() {
    const pages = this.addressIndex.getAllPages();
    
    for (let i = 0; i < pages.length - 1; i++) {
      const currentPage = pages[i];
      const nextPage = pages[i + 1];
      
      // Check if either page is below minimum size threshold
      if (currentPage.virtualSize < this.minPageSize || nextPage.virtualSize < this.minPageSize) {
        // Check if combined size would be reasonable
        const combinedSize = currentPage.virtualSize + nextPage.virtualSize;
        if (combinedSize <= this.maxPageSize) {
          await this._mergePages(currentPage, nextPage);
          return; // Only merge one pair at a time to avoid complexity
        }
      }
    }
  }

  /**
   * Merge two adjacent pages
   * @param {PageDescriptor} firstPage - First page to merge
   * @param {PageDescriptor} secondPage - Second page to merge (will be absorbed)
   * @private
   */
  async _mergePages(firstPage, secondPage) {
    // Always merge smaller page into larger page for consistency
    let targetPage, absorbedPage;
    if (firstPage.virtualSize >= secondPage.virtualSize) {
      targetPage = firstPage;
      absorbedPage = secondPage;
    } else {
      targetPage = secondPage;
      absorbedPage = firstPage;
    }
    
    // Ensure both pages are loaded
    const targetPageInfo = await this._ensurePageLoaded(targetPage);
    const absorbedPageInfo = await this._ensurePageLoaded(absorbedPage);
    
    // Calculate merge parameters
    let insertOffset, newData;
    
    if (targetPage === firstPage) {
      // Absorbing second page into first page
      insertOffset = targetPage.virtualSize;
      newData = Buffer.concat([targetPageInfo.data, absorbedPageInfo.data]);
    } else {
      // Absorbing first page into second page
      insertOffset = 0;
      newData = Buffer.concat([absorbedPageInfo.data, targetPageInfo.data]);
      // Update target page's virtual start to absorbed page's start
      targetPage.virtualStart = absorbedPage.virtualStart;
    }
    
    // Update target page data
    targetPageInfo.updateData(newData);
    targetPage.isDirty = true;
    targetPage.lineInfoCached = false;
    
    // Update marks manager if available
    if (this.lineAndMarksManager && this.lineAndMarksManager.handlePageMerge) {
      this.lineAndMarksManager.handlePageMerge(
        absorbedPage.pageId,
        targetPage.pageId,
        insertOffset
      );
    }
    
    // Update virtual size of target page
    this.addressIndex.updatePageSize(targetPage.pageId, absorbedPage.virtualSize);
    
    // Remove absorbed page
    this.addressIndex.removePage(absorbedPage.pageId);
    this.pageCache.delete(absorbedPage.pageId);
    this.loadedPages.delete(absorbedPage.pageId);
    
    // Remove from storage if it was saved there
    if (absorbedPage.sourceType === 'storage') {
      try {
        await this.buffer.storage.deletePage(absorbedPage.pageId);
      } catch (error) {
        // Ignore deletion errors
      }
    }
    
    this.buffer._notify(
      'page_merged',
      'info',
      `Merged page ${absorbedPage.pageId} into ${targetPage.pageId}`,
      { 
        targetPageId: targetPage.pageId, 
        absorbedPageId: absorbedPage.pageId,
        newSize: targetPage.virtualSize
      }
    );
  }

  /**
   * Clean up empty pages and merge small ones
   * @private
   */
  async _cleanupAndMergePages() {
    // First, handle empty pages
    await this._cleanupEmptyPages();
    
    // Then check for merge opportunities
    await this._checkForMergeOpportunities();
  }

  /**
   * Clean up pages that have become empty
   * @private
   */
  async _cleanupEmptyPages() {
    const emptyPages = this.addressIndex.pages.filter(p => p.virtualSize === 0);
    
    for (const descriptor of emptyPages) {
      // Transfer any marks from empty page to next page (at offset 0)
      if (this.lineAndMarksManager && this.lineAndMarksManager.handlePageMerge) {
        const nextPage = this._findNextPage(descriptor);
        if (nextPage) {
          this.lineAndMarksManager.handlePageMerge(
            descriptor.pageId,
            nextPage.pageId,
            0
          );
        }
      }
      
      this.addressIndex.removePage(descriptor.pageId);
      this.pageCache.delete(descriptor.pageId);
      this.loadedPages.delete(descriptor.pageId);
      
      // Remove from storage if it was saved there
      if (descriptor.sourceType === 'storage') {
        try {
          await this.buffer.storage.deletePage(descriptor.pageId);
        } catch (error) {
          // Ignore deletion errors
        }
      }
    }
    
    // Invalidate line caches after cleanup
    if (this.lineAndMarksManager && this.lineAndMarksManager.invalidateLineCaches) {
      this.lineAndMarksManager.invalidateLineCaches();
    }
  }

  /**
   * Find the next page after the given page
   * @param {PageDescriptor} currentPage - Current page descriptor
   * @returns {PageDescriptor|null} - Next page or null
   * @private
   */
  _findNextPage(currentPage) {
    const pages = this.addressIndex.getAllPages();
    const currentIndex = pages.findIndex(p => p.pageId === currentPage.pageId);
    return currentIndex >= 0 && currentIndex < pages.length - 1 ? pages[currentIndex + 1] : null;
  }

  /**
   * Get memory statistics
   */
  getMemoryStats() {
    const totalPages = this.addressIndex.pages.length;
    const loadedPages = this.loadedPages.size;
    const dirtyPages = this.addressIndex.pages.filter(p => p.isDirty).length;
    const cachedLineInfoPages = this.addressIndex.pages.filter(p => p.lineInfoCached).length;
    
    let memoryUsed = 0;
    let linesMemory = 0;
    let marksMemory = 0;
    
    for (const pageId of this.loadedPages) {
      const pageInfo = this.pageCache.get(pageId);
      if (pageInfo && pageInfo.data) {
        const pageStats = pageInfo.getMemoryStats();
        memoryUsed += pageStats.dataSize;
        linesMemory += pageStats.estimatedMemoryUsed - pageStats.dataSize; // Lines and marks overhead
      }
    }
    
    // Add line and marks manager memory
    if (this.lineAndMarksManager) {
      const lmStats = this.lineAndMarksManager.getMemoryStats();
      linesMemory += lmStats.estimatedLinesCacheMemory;
      marksMemory += lmStats.estimatedMarksMemory;
    }
    
    // Add persistent line info memory (very small)
    const persistentLineMemory = totalPages * 8; // ~8 bytes per page for line info
    
    return {
      totalPages,
      loadedPages,
      dirtyPages,
      cachedLineInfoPages,
      memoryUsed,
      linesMemory,
      marksMemory,
      persistentLineMemory,
      virtualSize: this.addressIndex.totalVirtualSize,
      sourceSize: this.sourceSize
    };
  }

  // =================== PRIVATE METHODS ===================

  /**
   * Create initial page descriptors for a file
   * @private
   */
  _createInitialPages(fileSize) {
    let offset = 0;
    
    // Handle empty files
    if (fileSize === 0) {
      const pageId = this._generatePageId();
      const descriptor = new PageDescriptor(
        pageId,
        0,              // virtualStart
        0,              // virtualSize - empty page
        'original',     // sourceType
        {               // sourceInfo
          filename: this.sourceFile,
          fileOffset: 0,
          size: 0
        }
      );
      
      this.addressIndex.insertPage(descriptor);
      return;
    }
    
    while (offset < fileSize) {
      const pageSize = Math.min(this.pageSize, fileSize - offset);
      const pageId = this._generatePageId();
      
      const descriptor = new PageDescriptor(
        pageId,
        offset,         // virtualStart
        pageSize,       // virtualSize
        'original',     // sourceType
        {               // sourceInfo
          filename: this.sourceFile,
          fileOffset: offset,
          size: pageSize
        }
      );
      
      this.addressIndex.insertPage(descriptor);
      offset += pageSize;
    }
  }

  /**
   * Enhanced page loading with detachment detection
   * @private
   */
  async _ensurePageLoaded(descriptor) {
    if (descriptor.isLoaded && this.pageCache.has(descriptor.pageId)) {
      this._updateLRU(descriptor.pageId);
      return this.pageCache.get(descriptor.pageId);
    }
    
    // Load page data based on source type
    let data;
    let loadError = null;
    
    try {
      switch (descriptor.sourceType) {
        case 'original':
          data = await this._loadFromOriginalFile(descriptor);
          break;
        case 'storage':
          data = await this._loadFromStorage(descriptor);
          break;
        case 'memory':
          // Handle memory pages that might have been evicted
          if (this.pageCache.has(descriptor.pageId)) {
            const pageInfo = this.pageCache.get(descriptor.pageId);
            this._updateLRU(descriptor.pageId);
            descriptor.isLoaded = true;
            return pageInfo;
          }
          // Try to load from storage first
          try {
            data = await this._loadFromStorage(descriptor);
            descriptor.sourceType = 'storage';
          } catch (storageError) {
            // Memory page unavailable and not in storage
            loadError = new Error(`Memory page ${descriptor.pageId} unavailable: ${storageError.message}`);
            throw loadError;
          }
          break;
        default:
          loadError = new Error(`Unknown source type: ${descriptor.sourceType}`);
          throw loadError;
      }
    } catch (error) {
      // CRITICAL: Data unavailable - trigger detachment
      loadError = error;
      this._handleCorruption(descriptor, error);
      
      // Return empty page info to allow operations to continue
      data = Buffer.alloc(0);
    }
    
    const pageInfo = this._createPageInfo(descriptor, data);
    this.pageCache.set(descriptor.pageId, pageInfo);
    this.loadedPages.add(descriptor.pageId);
    descriptor.isLoaded = true;
    
    // IMPORTANT: Ensure line cache is built immediately for loaded pages
    if (!loadError && data.length > 0) {
      pageInfo.ensureLineCacheValid();
      // Cache the line info in the page descriptor
      descriptor.cacheLineInfo(pageInfo);
    }
    
    // Update LRU and possibly evict
    this._updateLRU(descriptor.pageId);
    await this._evictIfNeeded();
    
    return pageInfo;
  }

  /**
   * Enhanced corruption handling that properly triggers detachment
   */
  _handleCorruption(descriptor, error) {
    // Import MissingDataRange from the main module
    const { MissingDataRange } = require('./paged-buffer');
    
    const missingRange = new MissingDataRange(
      descriptor.virtualStart,
      descriptor.virtualEnd,
      descriptor.sourceType === 'original' ? descriptor.sourceInfo.fileOffset : null,
      descriptor.sourceType === 'original' ? 
        descriptor.sourceInfo.fileOffset + descriptor.sourceInfo.size : null,
      this._determineCorruptionReason(error)
    );
    
    // CRITICAL: Trigger buffer detachment
    if (this.buffer._markAsDetached) {
      this.buffer._markAsDetached(`Page data unavailable: ${error.message}`, [missingRange]);
    }
    
    // Send detailed notification
    this.buffer._notify(
      'page_data_unavailable',
      'error',
      `Page ${descriptor.pageId} data unavailable: ${error.message}`,
      { 
        pageId: descriptor.pageId,
        virtualStart: descriptor.virtualStart,
        virtualEnd: descriptor.virtualEnd,
        sourceType: descriptor.sourceType,
        reason: error.message,
        recoverable: false
      }
    );
  }
  
  /**
   * Determine the specific reason for corruption based on error
   */
  _determineCorruptionReason(error) {
    if (error.message.includes('ENOENT')) {
      return 'file_deleted';
    } else if (error.message.includes('truncated') || error.message.includes('beyond current size')) {
      return 'file_truncated';
    } else if (error.message.includes('Permission denied') || error.message.includes('EACCES')) {
      return 'permission_denied';
    } else if (error.message.includes('Storage')) {
      return 'storage_failure';
    } else {
      return 'data_corruption';
    }
  }

  /**
   * Enhanced file loading with better corruption detection
   */
  async _loadFromOriginalFile(descriptor) {
    if (!descriptor.sourceInfo.filename) {
      throw new Error('No source filename available');
    }
    
    const fs = require('fs').promises;
    
    try {
      // First check if file exists and is readable
      await fs.access(descriptor.sourceInfo.filename, require('fs').constants.R_OK);
      
      // Get current file stats
      const stats = await fs.stat(descriptor.sourceInfo.filename);
      
      // CRITICAL: Check if file has been truncated since we loaded it
      if (descriptor.sourceInfo.fileOffset >= stats.size) {
        throw new Error(`File truncated: offset ${descriptor.sourceInfo.fileOffset} beyond current size ${stats.size}`);
      }
      
      // Calculate how much we can actually read
      const maxReadSize = stats.size - descriptor.sourceInfo.fileOffset;
      const readSize = Math.min(descriptor.sourceInfo.size, maxReadSize);
      
      if (readSize <= 0) {
        throw new Error(`No data available at offset ${descriptor.sourceInfo.fileOffset}`);
      }
      
      // Open and read the file
      const fd = await fs.open(descriptor.sourceInfo.filename, 'r');
      
      try {
        const buffer = Buffer.alloc(readSize);
        const { bytesRead } = await fd.read(
          buffer, 
          0, 
          readSize, 
          descriptor.sourceInfo.fileOffset
        );
        
        if (bytesRead === 0) {
          throw new Error(`No data read from offset ${descriptor.sourceInfo.fileOffset}`);
        }
        
        if (bytesRead !== readSize) {
          // Partial read - file changed during read
          console.warn(`Partial read: expected ${readSize}, got ${bytesRead}`);
          return buffer.subarray(0, bytesRead);
        }
        
        return buffer;
      } finally {
        await fd.close();
      }
      
    } catch (error) {
      // Enhanced error context
      const enhancedError = new Error(`Failed to load from ${descriptor.sourceInfo.filename}: ${error.message}`);
      enhancedError.originalError = error;
      enhancedError.sourceInfo = descriptor.sourceInfo;
      throw enhancedError;
    }
  }

  /**
   * Enhanced storage loading with better error handling
   */
  async _loadFromStorage(descriptor) {
    try {
      const data = await this.buffer.storage.loadPage(descriptor.pageId);
      if (!data || data.length === 0) {
        throw new Error(`Storage returned empty data for page ${descriptor.pageId}`);
      }
      return data;
    } catch (error) {
      // Enhanced storage error
      const enhancedError = new Error(`Storage load failed for page ${descriptor.pageId}: ${error.message}`);
      enhancedError.originalError = error;
      enhancedError.pageId = descriptor.pageId;
      throw enhancedError;
    }
  }

  /**
   * Create PageInfo with enhanced line and marks support
   */
  _createPageInfo(descriptor, data) {
    const { PageInfo } = require('./utils/page-info');
    
    const pageInfo = new PageInfo(
      descriptor.pageId,
      descriptor.sourceType === 'original' ? descriptor.sourceInfo.fileOffset : -1,
      descriptor.sourceType === 'original' ? descriptor.sourceInfo.size : 0
    );
    pageInfo.updateData(data);
    pageInfo.isDirty = descriptor.isDirty;
    pageInfo.isLoaded = true;
    return pageInfo;
  }

  /**
   * Update LRU order
   * @private
   */
  _updateLRU(pageId) {
    const index = this.lruOrder.indexOf(pageId);
    if (index >= 0) {
      this.lruOrder.splice(index, 1);
    }
    this.lruOrder.push(pageId);
  }

  /**
   * Evict pages if over memory limit
   * @private
   */
  async _evictIfNeeded() {
    while (this.loadedPages.size > this.maxLoadedPages && this.lruOrder.length > 0) {
      const pageId = this.lruOrder.shift();
      const descriptor = this.addressIndex.pages.find(p => p.pageId === pageId);
      
      if (descriptor && descriptor.isLoaded && this.loadedPages.has(pageId)) {
        await this._evictPage(descriptor);
      }
    }
  }

  /**
   * Evict a specific page with marks preservation and line info caching
   * @private
   */
  async _evictPage(descriptor) {
    const pageInfo = this.pageCache.get(descriptor.pageId);
    if (!pageInfo) return;
    
    // IMPORTANT: Cache line information before evicting (if not already cached)
    if (!descriptor.lineInfoCached) {
      descriptor.cacheLineInfo(pageInfo);
    }
    
    // IMPORTANT: Don't lose marks when evicting pages
    // Marks are preserved in the global registry by LineAndMarksManager
    
    // Save to storage if dirty
    if (descriptor.isDirty) {
      try {
        await this.buffer.storage.savePage(descriptor.pageId, pageInfo.data);
        descriptor.sourceType = 'storage';
        descriptor.sourceInfo = { pageId: descriptor.pageId };
      } catch (error) {
        // If storage fails, we can't evict this page safely
        // Log the error and continue without evicting
        this.buffer._notify(
          'storage_error',
          'error',
          `Failed to save page ${descriptor.pageId} during eviction: ${error.message}`,
          { pageId: descriptor.pageId, error: error.message }
        );
        return false; // Indicate eviction failed
      }
    }
    
    // Remove from memory
    this.pageCache.delete(descriptor.pageId);
    this.loadedPages.delete(descriptor.pageId);
    descriptor.isLoaded = false;
    
    this.buffer._notify(
      'page_evicted',
      'debug',
      `Evicted page ${descriptor.pageId}`,
      { pageId: descriptor.pageId, lineInfoCached: descriptor.lineInfoCached }
    );
    
    return true; // Indicate eviction succeeded
  }

  /**
   * Generate unique page ID
   * @private
   */
  _generatePageId() {
    return `vpage_${++this.nextPageId}_${Date.now()}`;
  }
}

module.exports = {
  VirtualPageManager,
  PageDescriptor,
  PageAddressIndex
};
