/**
 * @fileoverview Enhanced Virtual Page Manager with Line Tracking, Marks Integration, and Page Merging
 * @description Handles mapping between virtual buffer addresses and physical page locations
 * while maintaining sparse, efficient access to massive files, with comprehensive line and marks support
 * @author Jeffrey R. Day
 * @version 2.1.0 - Added page merging and marks coordination
 */

import { promises as fs } from 'fs';
import { PageInfo } from './utils/page-info';
import { logger } from './utils/logger';
import {
  type IPageDescriptor,
  type IPageInfo,
  type IVirtualPageManager,
  type ILineAndMarksManager,
  type IBuffer,
  type SourceInfo,
  type SourceType,
  type TranslateAddressResult,
  type VirtualPageManagerMemoryStats
} from './types/common';

/**
 * Represents a page's metadata for address translation
 */
class PageDescriptor implements IPageDescriptor {
  public pageKey: string;
  public virtualStart: number;
  public virtualSize: number;
  public sourceType: SourceType;
  public sourceInfo: SourceInfo;
  public isDirty: boolean = false;
  public isLoaded: boolean = false;
  public lastAccess: number = 0;
  public generation: number = 0;
  public parentKey: string | null = null;
  public newlineCount: number = 0;
  public lineInfoCached: boolean = false;

  constructor(
    pageKey: string,
    virtualStart: number,
    virtualSize: number,
    sourceType: SourceType,
    sourceInfo: SourceInfo
  ) {
    this.pageKey = pageKey;
    this.virtualStart = virtualStart;
    this.virtualSize = virtualSize;
    this.sourceType = sourceType;
    this.sourceInfo = sourceInfo;
  }

  /**
   * Get the virtual end position of this page
   */
  get virtualEnd(): number {
    return this.virtualStart + this.virtualSize;
  }

  /**
   * Check if a virtual position falls within this page
   */
  contains(virtualPos: number): boolean {
    return virtualPos >= this.virtualStart && virtualPos < this.virtualEnd;
  }

  /**
   * Convert virtual position to relative position within this page
   */
  toRelativePosition(virtualPos: number): number {
    if (!this.contains(virtualPos)) {
      throw new Error(`Position ${virtualPos} not in page ${this.pageKey}`);
    }
    return virtualPos - this.virtualStart;
  }

  /**
   * Cache line information from a loaded page
   */
  cacheLineInfo(pageInfo: IPageInfo): void {
    this.newlineCount = pageInfo.getNewlineCount();
    this.lineInfoCached = true;
  }
}

/**
 * Efficient B-tree-like structure for fast address lookups
 * Uses binary search for O(log n) lookups even with thousands of pages
 * Hash map for O(1) pageKey lookups
 */
class PageAddressIndex {
  public pages: PageDescriptor[] = [];
  public pageKeyIndex: Map<string, PageDescriptor> = new Map();
  public totalVirtualSize: number = 0;

  /**
   * Generic binary search for range boundaries
   */
  private _findRangeBoundary(
    condition: (page: PageDescriptor) => boolean,
    findFirst: boolean,
    searchStart: number = 0,
    searchEnd: number = this.pages.length - 1
  ): number {
    let left = searchStart;
    let right = searchEnd;
    let result = -1;
    
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const page = this.pages[mid];
      
      if (condition(page)) {
        result = mid;
        if (findFirst) {
          right = mid - 1;  // Search left for earlier match
        } else {
          left = mid + 1;   // Search right for later match
        }
      } else {
        if (findFirst) {
          left = mid + 1;
        } else {
          right = mid - 1;
        }
      }
    }
    
    return result;
  }

  /**
   * Find the page containing a virtual address
   */
  findPageAt(virtualPos: number): PageDescriptor | null {
    const index = this._findRangeBoundary(
      page => page.contains(virtualPos),
      true  // findFirst = true (though there should only be one match)
    );
    
    return index === -1 ? null : this.pages[index];
  }

  /**
   * Find page by pageKey
   */
  findPageByKey(pageKey: string): PageDescriptor | null {
    return this.pageKeyIndex.get(pageKey) || null;
  }

  /**
   * Insert a new page, maintaining sorted order
   */
  insertPage(pageDesc: PageDescriptor): void {
    // Find insertion point using binary search
    const insertIndex = this._findRangeBoundary(
      page => page.virtualStart > pageDesc.virtualStart,
      true  // findFirst = true (find the first page that starts after our new page)
    );
    
    // If no page starts after our new page, insert at the end
    const actualInsertIndex = insertIndex === -1 ? this.pages.length : insertIndex;
    
    this.pages.splice(actualInsertIndex, 0, pageDesc);
    this.pageKeyIndex.set(pageDesc.pageKey, pageDesc); // Add to hash map
    this._updateVirtualSizes();
  }

  /**
   * Remove a page from the index
   */
  removePage(pageKey: string): void {
    const index = this.pages.findIndex(p => p.pageKey === pageKey);
    if (index >= 0) {
      this.pages.splice(index, 1);
      this.pageKeyIndex.delete(pageKey); // Remove from hash map
      this._updateVirtualSizes();
    }
  }

  /**
   * Update virtual addresses after a size change
   */
  updatePageSize(pageKey: string, sizeDelta: number): void {
    const pageIndex = this.pages.findIndex(p => p.pageKey === pageKey);
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
   */
  splitPage(pageKey: string, splitPoint: number, newPageKey: string): PageDescriptor {
    const pageIndex = this.pages.findIndex(p => p.pageKey === pageKey);
    if (pageIndex < 0) throw new Error(`Page ${pageKey} not found`);
    
    const originalPage = this.pages[pageIndex];
    const splitVirtualPos = originalPage.virtualStart + splitPoint;
    
    // Create new page for the second half
    const newPage = new PageDescriptor(
      newPageKey,
      splitVirtualPos,
      originalPage.virtualSize - splitPoint,
      'memory', // Split pages start in memory
      { pageKey: newPageKey }
    );
    newPage.isDirty = true;
    newPage.generation = originalPage.generation + 1;
    newPage.parentKey = originalPage.pageKey;
    
    // Update original page to first half
    originalPage.virtualSize = splitPoint;
    
    // Insert new page right after original
    this.pages.splice(pageIndex + 1, 0, newPage);
    this.pageKeyIndex.set(newPageKey, newPage); // Add new page to hash map
    
    return newPage;
  }

  /**
   * Get all pages in virtual address order
   */
  getAllPages(): PageDescriptor[] {
    return [...this.pages];
  }

  /**
   * Get pages that intersect with a virtual range
   */
  getPagesInRange(startPos: number, endPos: number): PageDescriptor[] {
    if (this.pages.length === 0) return [];
    
    // Find first page where virtualEnd > startPos
    const firstIndex = this._findRangeBoundary(
      page => page.virtualEnd > startPos,
      true  // findFirst = true
    );
    
    if (firstIndex === -1) return [];
    
    // Find last page where virtualStart < endPos
    // OPTIMIZATION: Start search from firstIndex since we know earlier pages don't intersect
    const lastIndex = this._findRangeBoundary(
      page => page.virtualStart < endPos,
      false,        // findFirst = false (find last)
      firstIndex,   // searchStart = firstIndex (optimization!)
      this.pages.length - 1
    );
    
    if (lastIndex === -1) return [];
    
    // Collect intersecting pages
    const result: PageDescriptor[] = [];
    for (let i = firstIndex; i <= lastIndex; i++) {
      const page = this.pages[i];
      if (page.virtualEnd > startPos && page.virtualStart < endPos) {
        result.push(page);
      }
    }
    
    return result;
  }

  /**
   * Recalculate total virtual size
   */
  private _updateVirtualSizes(): void {
    this.totalVirtualSize = this.pages.reduce((sum, page) => sum + page.virtualSize, 0);
  }

  /**
   * Validate the index consistency (for debugging)
   */
  validate(): void {
    let expectedStart = 0;
    
    for (let i = 0; i < this.pages.length; i++) {
      const page = this.pages[i];
      
      if (page.virtualStart !== expectedStart) {
        throw new Error(`Page ${page.pageKey} has invalid virtual start: expected ${expectedStart}, got ${page.virtualStart}`);
      }
      
      if (page.virtualSize <= 0) {
        throw new Error(`Page ${page.pageKey} has invalid size: ${page.virtualSize}`);
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
   */
  validateHashMapSync(): void {
    // Check that every page in array is in hash map
    for (const page of this.pages) {
      const hashMapPage = this.pageKeyIndex.get(page.pageKey);
      if (hashMapPage !== page) {
        throw new Error(`Hash map out of sync for page ${page.pageKey}: expected same object reference`);
      }
    }
    
    // Check that hash map doesn't have extra entries
    if (this.pageKeyIndex.size !== this.pages.length) {
      throw new Error(`Hash map size mismatch: ${this.pageKeyIndex.size} entries vs ${this.pages.length} pages`);
    }
    
    // Check that every hash map entry points to a page in the array
    for (const [pageKey, pageDesc] of this.pageKeyIndex) {
      const arrayIndex = this.pages.findIndex(p => p.pageKey === pageKey);
      if (arrayIndex < 0) {
        throw new Error(`Hash map contains orphaned entry for page ${pageKey}`);
      }
      if (this.pages[arrayIndex] !== pageDesc) {
        throw new Error(`Hash map entry for page ${pageKey} points to wrong object`);
      }
    }
  }
}

/**
 * Enhanced Virtual Page Manager with Line Tracking, Marks Integration, and Page Merging
 */
class VirtualPageManager implements IVirtualPageManager {
  private buffer: IBuffer;
  private pageSize: number;
  private nextPageKey: number = 0;
  public addressIndex: PageAddressIndex = new PageAddressIndex();
  public pageCache: Map<string, IPageInfo> = new Map();
  private loadedPages: Set<string> = new Set();
  public sourceFile: string | null = null;
  private sourceSize: number = 0;
  private maxLoadedPages;
  private lruOrder: string[] = [];
  private minPageSize: number;
  private maxPageSize: number;
  private lineAndMarksManager: ILineAndMarksManager | null = null;

  constructor(buffer: IBuffer, pageSize: number = 64 * 1024, maxMemoryPages: number = 100) {
    this.buffer = buffer;
    this.pageSize = pageSize;
    this.minPageSize = Math.floor(pageSize / 4);
    this.maxPageSize = pageSize * 2;
    this.maxLoadedPages = maxMemoryPages;
  }

  /**
   * Set the line and marks manager (called by PagedBuffer)
   */
  setLineAndMarksManager(manager: ILineAndMarksManager): void {
    this.lineAndMarksManager = manager;
  }

  /**
   * Initialize from a file
   */
  initializeFromFile(filename: string, fileSize: number, _checksum: string): void {
    this.sourceFile = filename;
    this.sourceSize = fileSize;
    // Note: checksum parameter provided for future use but not currently stored
    
    // Create initial page descriptors for the entire file
    this._createInitialPages(fileSize);
    
    // Invalidate line caches since we have new content
    if (this.lineAndMarksManager?.invalidateLineCaches) {
      this.lineAndMarksManager.invalidateLineCaches();
    }
  }

  /**
   * Initialize from string content
   */
  initializeFromContent(content: Buffer): void {
    this.sourceFile = null;
    this.sourceSize = content.length;
    
    // Handle empty content
    if (content.length === 0) {
      const pageKey = this._generatePageKey();
      const pageDesc = new PageDescriptor(
        pageKey,
        0,              // virtualStart
        0,              // virtualSize
        'memory',       // sourceType
        { pageKey }      // sourceInfo
      );
      pageDesc.isDirty = true;
      pageDesc.isLoaded = true;
      
      this.addressIndex.insertPage(pageDesc);
      this.pageCache.set(pageKey, this._createPageInfo(pageDesc, Buffer.alloc(0)));
      this.loadedPages.add(pageKey);
      
      // Apply memory limit after initialization
      this._applyMemoryLimit();
      
      // Invalidate line caches
      if (this.lineAndMarksManager) {
        this.lineAndMarksManager.invalidateLineCaches?.();
      }
      return;
    }
    
    // Create pages for content, respecting page size limits
    let offset = 0;
    while (offset < content.length) {
      const pageSize = Math.min(this.pageSize, content.length - offset);
      const pageKey = this._generatePageKey();
      const pageData = content.subarray(offset, offset + pageSize);
      
      const pageDesc = new PageDescriptor(
        pageKey,
        offset,         // virtualStart
        pageSize,       // virtualSize
        'memory',       // sourceType
        { pageKey }      // sourceInfo
      );
      pageDesc.isDirty = true;
      pageDesc.isLoaded = true;
      
      this.addressIndex.insertPage(pageDesc);
      const pageInfo = this._createPageInfo(pageDesc, pageData);
      this.pageCache.set(pageKey, pageInfo);
      this.loadedPages.add(pageKey);
      
      // Cache line information immediately for in-memory content
      pageDesc.cacheLineInfo(pageInfo);
      
      offset += pageSize;
    }
    
    // Apply memory limit after initialization
    this._applyMemoryLimit();
    
    // Invalidate line caches since we have new content
    if (this.lineAndMarksManager) {
      this.lineAndMarksManager.invalidateLineCaches?.();
    }
  }

  /**
   * Apply memory limit by evicting excess pages
   */
  private async _applyMemoryLimit(): Promise<void> {
    while (this.loadedPages.size > this.maxLoadedPages) {
      // Find the oldest loaded page to evict
      const pageKeys = Array.from(this.loadedPages);
      if (pageKeys.length === 0) break;
      
      const pageToEvict = pageKeys[0]; // Evict first (oldest) page
      const descriptor = this.addressIndex.pages.find(p => p.pageKey === pageToEvict);
      
      if (descriptor?.isLoaded) {
        await this._evictPage(descriptor);
      }
    }
  }

  /**
   * Translate virtual address to page and relative position
   */
  async translateAddress(virtualPos: number): Promise<TranslateAddressResult> {
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
        const pageKey = this._generatePageKey();
        const pageDesc = new PageDescriptor(pageKey, 0, 0, 'memory', { pageKey });
        pageDesc.isDirty = true;
        pageDesc.isLoaded = true;
        
        this.addressIndex.insertPage(pageDesc);
        this.pageCache.set(pageKey, this._createPageInfo(pageDesc, Buffer.alloc(0)));
        this.loadedPages.add(pageKey);
        
        return {
          page: this.pageCache.get(pageKey)!,
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
   */
  async insertAt(virtualPos: number, data: Buffer): Promise<number> {
    logger.debug(`[DEBUG] insertAt: pos=${virtualPos}, dataLen=${data.length}`);
    
    const { descriptor, relativePos } = await this.translateAddress(virtualPos);
    const pageInfo = await this._ensurePageLoaded(descriptor);
    
    logger.debug(`[DEBUG] Page ${descriptor.pageKey} current size: ${pageInfo.currentSize}, max: ${this.maxPageSize}`);
    
    // Perform the insertion within the page
    const before = pageInfo.data!.subarray(0, relativePos);
    const after = pageInfo.data!.subarray(relativePos);
    const newData = Buffer.concat([before, data, after]);
    
    // Update page data with line and marks tracking
    pageInfo.updateData(newData);
    
    // Update page-level marks for this modification
    pageInfo.updateAfterModification(relativePos, 0, data);
    
    descriptor.isDirty = true;
    
    // Invalidate cached line info since page content changed
    descriptor.lineInfoCached = false;
    
    // Update virtual addresses in the page index
    this.addressIndex.updatePageSize(descriptor.pageKey, data.length);

    // Check if page needs splitting
    if (newData.length > this.maxPageSize) {
      logger.debug(`[DEBUG] Page split needed: ${newData.length} > ${this.maxPageSize}`);
      await this._splitPage(descriptor);
    }
    
    // Check for potential page merging opportunities
    await this._checkForMergeOpportunities();
    
    return data.length;
  }

  /**
   * Delete data from a virtual range with line and marks tracking
   */
  async deleteRange(startPos: number, endPos: number): Promise<Buffer> {
    if (startPos >= endPos) {
      return Buffer.alloc(0);
    }
    
    // Clamp to valid range
    startPos = Math.max(0, startPos);
    endPos = Math.min(endPos, this.addressIndex.totalVirtualSize);
    
    if (startPos >= endPos) {
      return Buffer.alloc(0);
    }
    
    const deletedChunks: Buffer[] = [];
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
      const deletedFromPage = pageInfo.data!.subarray(relativeStart, relativeEnd);
      
      // Insert at beginning of array to maintain order
      deletedChunks.unshift(deletedFromPage);
      
      // Remove data from page
      const before = pageInfo.data!.subarray(0, relativeStart);
      const after = pageInfo.data!.subarray(relativeEnd);
      const newData = Buffer.concat([before, after]);
      
      // Update page data with line and marks tracking
      pageInfo.updateData(newData);
      
      // Update page-level marks for this modification
      pageInfo.updateAfterModification(relativeStart, relativeEnd - relativeStart, Buffer.alloc(0));
      
      descriptor.isDirty = true;
      
      // Invalidate cached line info since page content changed
      descriptor.lineInfoCached = false;
      
      // Update virtual size
      const sizeChange = -(relativeEnd - relativeStart);
      this.addressIndex.updatePageSize(descriptor.pageKey, sizeChange);
    }
    
    // Clean up empty pages and merge small ones
    await this._cleanupAndMergePages();
    
    return Buffer.concat(deletedChunks);
  }

  /**
   * Read data from a virtual range
   */
  async readRange(startPos: number, endPos: number): Promise<Buffer> {
    if (startPos >= endPos) {
      return Buffer.alloc(0);
    }
    
    // Clamp to valid range
    startPos = Math.max(0, startPos);
    endPos = Math.min(endPos, this.addressIndex.totalVirtualSize);
    
    if (startPos >= endPos) {
      return Buffer.alloc(0);
    }
    
    const chunks: Buffer[] = [];
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
        const actualEnd = Math.min(relativeEnd, pageInfo.data!.length);
        
        if (relativeStart < pageInfo.data!.length) {
          chunks.push(pageInfo.data!.subarray(relativeStart, actualEnd));
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
  getTotalSize(): number {
    return this.addressIndex.totalVirtualSize;
  }

  // =================== PAGE MANAGEMENT ===================

  /**
   * Split a page that has grown too large
   */
  private async _splitPage(descriptor: PageDescriptor): Promise<void> {
    logger.debug(`[DEBUG] _splitPage called for page ${descriptor.pageKey}`);
    const pageInfo = this.pageCache.get(descriptor.pageKey);
    if (!pageInfo) return;
    
    const splitPoint = Math.floor(pageInfo.currentSize / 2);
    const newPageKey = this._generatePageKey();
    
    // Extract marks from the second half before splitting
    const marksInSecondHalf = this.lineAndMarksManager ? 
      this.lineAndMarksManager.getMarksInRange(splitPoint, pageInfo.currentSize) : [];
    
    // Split the page in the address index
    const newDescriptor = this.addressIndex.splitPage(
      descriptor.pageKey,
      splitPoint,
      newPageKey
    );
    
    // Create new page data
    const newData = pageInfo.data!.subarray(splitPoint);
    this._createPageInfo(newDescriptor, newData);
    
    // Insert marks into the new page
    if (this.lineAndMarksManager && marksInSecondHalf?.length > 0) {
      logger.debug('[DEBUG] (JRD)');
      logger.debug(marksInSecondHalf);
      this.lineAndMarksManager.insertMarksFromRelative(0, marksInSecondHalf, newDescriptor.virtualStart);
    }
    
    // Update original page data
    const originalData = pageInfo.data!.subarray(0, splitPoint);
    pageInfo.updateData(originalData);
    
    // Invalidate line caches after cleanup
    if (this.lineAndMarksManager?.invalidateLineCaches) {
      this.lineAndMarksManager.invalidateLineCaches();
    }

    // Make sure notification is called
    logger.debug('[DEBUG] Sending split notification');
    this.buffer._notify(
      'page_split',
      'info',
      `Split page ${descriptor.pageKey} at ${splitPoint} bytes`,
      { originalPageKey: descriptor.pageKey, newPageKey, splitPoint }
    );
  }

  /**
   * Check for page merging opportunities
   */
  private async _checkForMergeOpportunities(): Promise<void> {
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
   */
  private async _mergePages(firstPage: PageDescriptor, secondPage: PageDescriptor): Promise<void> {
    // Always merge smaller page into larger page for consistency
    let targetPage: PageDescriptor, absorbedPage: PageDescriptor;
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
    let insertOffset: number, newData: Buffer;
    
    if (targetPage === firstPage) {
      // Absorbing second page into first page
      insertOffset = targetPage.virtualSize;
      newData = Buffer.concat([targetPageInfo.data!, absorbedPageInfo.data!]);
    } else {
      // Absorbing first page into second page
      insertOffset = 0;
      newData = Buffer.concat([absorbedPageInfo.data!, targetPageInfo.data!]);
      // Update target page's virtual start to absorbed page's start
      targetPage.virtualStart = absorbedPage.virtualStart;
    }
    
    // Update target page data
    targetPageInfo.updateData(newData);
    targetPage.isDirty = true;
    targetPage.lineInfoCached = false;
    
    // Update marks manager if available
    if (this.lineAndMarksManager?.handlePageMerge) {
      this.lineAndMarksManager.handlePageMerge(
        absorbedPage.pageKey,
        targetPage.pageKey,
        insertOffset
      );
    }
    
    // Update virtual size of target page
    this.addressIndex.updatePageSize(targetPage.pageKey, absorbedPage.virtualSize);
    
    // Remove absorbed page
    this.addressIndex.removePage(absorbedPage.pageKey);
    this.pageCache.delete(absorbedPage.pageKey);
    this.loadedPages.delete(absorbedPage.pageKey);
    
    // Remove from storage if it was saved there
    if (absorbedPage.sourceType === 'storage') {
      try {
        await this.buffer.storage.deletePage(absorbedPage.pageKey);
      } catch (error) {
        // Ignore deletion errors
      }
    }
    
    this.buffer._notify(
      'page_merged',
      'info',
      `Merged page ${absorbedPage.pageKey} into ${targetPage.pageKey}`,
      { 
        targetPageKey: targetPage.pageKey, 
        absorbedPageKey: absorbedPage.pageKey,
        newSize: targetPage.virtualSize
      }
    );
  }

  /**
   * Clean up empty pages and merge small ones
   */
  private async _cleanupAndMergePages(): Promise<void> {
    // First, handle empty pages
    await this._cleanupEmptyPages();
    
    // Then check for merge opportunities
    await this._checkForMergeOpportunities();
  }

  /**
   * Clean up pages that have become empty
   */
  private async _cleanupEmptyPages(): Promise<void> {
    const emptyPages = this.addressIndex.pages.filter(p => p.virtualSize === 0);
    
    for (const descriptor of emptyPages) {
      // Transfer any marks from empty page to next page (at offset 0)
      if (this.lineAndMarksManager?.handlePageMerge) {
        const nextPage = this._findNextPage(descriptor);
        if (nextPage) {
          this.lineAndMarksManager.handlePageMerge(
            descriptor.pageKey,
            nextPage.pageKey,
            0
          );
        }
      }
      
      this.addressIndex.removePage(descriptor.pageKey);
      this.pageCache.delete(descriptor.pageKey);
      this.loadedPages.delete(descriptor.pageKey);
      
      // Remove from storage if it was saved there
      if (descriptor.sourceType === 'storage') {
        try {
          await this.buffer.storage.deletePage(descriptor.pageKey);
        } catch (error) {
          // Ignore deletion errors
        }
      }
    }
    
    // Invalidate line caches after cleanup
    if (this.lineAndMarksManager?.invalidateLineCaches) {
      this.lineAndMarksManager.invalidateLineCaches();
    }
  }

  /**
   * Find the next page after the given page
   */
  private _findNextPage(currentPage: PageDescriptor): PageDescriptor | null {
    const pages = this.addressIndex.getAllPages();
    const currentIndex = pages.findIndex(p => p.pageKey === currentPage.pageKey);
    return currentIndex >= 0 && currentIndex < pages.length - 1 ? pages[currentIndex + 1] : null;
  }

  /**
   * Get memory statistics
   */
  getMemoryStats(): VirtualPageManagerMemoryStats {
    const totalPages = this.addressIndex.pages.length;
    const loadedPages = this.loadedPages.size;
    const dirtyPages = this.addressIndex.pages.filter(p => p.isDirty).length;
    const cachedLineInfoPages = this.addressIndex.pages.filter(p => p.lineInfoCached).length;
    
    let memoryUsed = 0;
    let linesMemory = 0;
    let marksMemory = 0;
    
    for (const pageKey of this.loadedPages) {
      const pageInfo = this.pageCache.get(pageKey);
      if (pageInfo?.data) {
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
   */
  private _createInitialPages(fileSize: number): void {
    let offset = 0;
    
    // Handle empty files
    if (fileSize === 0) {
      const pageKey = this._generatePageKey();
      const descriptor = new PageDescriptor(
        pageKey,
        0,              // virtualStart
        0,              // virtualSize - empty page
        'original',     // sourceType
        {               // sourceInfo
          filename: this.sourceFile!,
          fileOffset: 0,
          size: 0
        }
      );
      
      this.addressIndex.insertPage(descriptor);
      return;
    }
    
    while (offset < fileSize) {
      const pageSize = Math.min(this.pageSize, fileSize - offset);
      const pageKey = this._generatePageKey();
      
      const descriptor = new PageDescriptor(
        pageKey,
        offset,         // virtualStart
        pageSize,       // virtualSize
        'original',     // sourceType
        {               // sourceInfo
          filename: this.sourceFile!,
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
   */
  public async _ensurePageLoaded(descriptor: PageDescriptor): Promise<IPageInfo> {
    if (descriptor.isLoaded && this.pageCache.has(descriptor.pageKey)) {
      this._updateLRU(descriptor.pageKey);
      return this.pageCache.get(descriptor.pageKey)!;
    }
    
    // Load page data based on source type
    let data: Buffer;
    let loadError: Error | null = null;
    
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
          if (this.pageCache.has(descriptor.pageKey)) {
            const pageInfo = this.pageCache.get(descriptor.pageKey)!;
            this._updateLRU(descriptor.pageKey);
            descriptor.isLoaded = true;
            return pageInfo;
          }
          // Try to load from storage first
          try {
            data = await this._loadFromStorage(descriptor);
            descriptor.sourceType = 'storage';
          } catch (storageError) {
            // Memory page unavailable and not in storage
            loadError = new Error(`Memory page ${descriptor.pageKey} unavailable: ${(storageError as Error).message}`);
            throw loadError;
          }
          break;
        default:
          loadError = new Error(`Unknown source type: ${descriptor.sourceType}`);
          throw loadError;
      }
    } catch (error) {
      // CRITICAL: Data unavailable - trigger detachment
      loadError = error as Error;
      this._handleCorruption(descriptor, loadError);
      
      // Return empty page info to allow operations to continue
      data = Buffer.alloc(0);
    }
    
    const pageInfo = this._createPageInfo(descriptor, data);
    this.pageCache.set(descriptor.pageKey, pageInfo);
    this.loadedPages.add(descriptor.pageKey);
    descriptor.isLoaded = true;
    
    // IMPORTANT: Ensure line cache is built immediately for loaded pages
    if (!loadError && data.length > 0) {
      pageInfo.ensureLineCacheValid();
      // Cache the line info in the page descriptor
      descriptor.cacheLineInfo(pageInfo);
    }
    
    // Update LRU and possibly evict
    this._updateLRU(descriptor.pageKey);
    await this._evictIfNeeded();
    
    return pageInfo;
  }

  /**
   * Enhanced corruption handling that properly triggers detachment
   */
  private _handleCorruption(descriptor: PageDescriptor, error: Error): void {
    // Import MissingDataRange from the main module
    const { MissingDataRange } = require('./paged-buffer');
    
    const missingRange = new MissingDataRange(
      descriptor.virtualStart,
      descriptor.virtualEnd,
      descriptor.sourceType === 'original' ? descriptor.sourceInfo.fileOffset : null,
      descriptor.sourceType === 'original' ? 
        descriptor.sourceInfo.fileOffset! + descriptor.sourceInfo.size! : null,
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
      `Page ${descriptor.pageKey} data unavailable: ${error.message}`,
      { 
        pageKey: descriptor.pageKey,
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
  private _determineCorruptionReason(error: Error): string {
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
  private async _loadFromOriginalFile(descriptor: PageDescriptor): Promise<Buffer> {
    if (!descriptor.sourceInfo.filename) {
      throw new Error('No source filename available');
    }
    
    try {
      // First check if file exists and is readable
      await fs.access(descriptor.sourceInfo.filename, require('fs').constants.R_OK);
      
      // Get current file stats
      const stats = await fs.stat(descriptor.sourceInfo.filename);
      
      // CRITICAL: Check if file has been truncated since we loaded it
      if (descriptor.sourceInfo.fileOffset! >= stats.size) {
        throw new Error(`File truncated: offset ${descriptor.sourceInfo.fileOffset} beyond current size ${stats.size}`);
      }
      
      // Calculate how much we can actually read
      const maxReadSize = stats.size - descriptor.sourceInfo.fileOffset!;
      const readSize = Math.min(descriptor.sourceInfo.size!, maxReadSize);
      
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
          descriptor.sourceInfo.fileOffset!
        );
        
        if (bytesRead === 0) {
          throw new Error(`No data read from offset ${descriptor.sourceInfo.fileOffset}`);
        }
        
        if (bytesRead !== readSize) {
          // Partial read - file changed during read
          logger.warn(`Partial read: expected ${readSize}, got ${bytesRead}`);
          return buffer.subarray(0, bytesRead);
        }
        
        return buffer;
      } finally {
        await fd.close();
      }
      
    } catch (error) {
      // Enhanced error context
      const enhancedError = new Error(`Failed to load from ${descriptor.sourceInfo.filename}: ${(error as Error).message}`);
      (enhancedError as any).originalError = error;
      (enhancedError as any).sourceInfo = descriptor.sourceInfo;
      throw enhancedError;
    }
  }

  /**
   * Enhanced storage loading with better error handling
   */
  private async _loadFromStorage(descriptor: PageDescriptor): Promise<Buffer> {
    try {
      const data = await this.buffer.storage.loadPage(descriptor.pageKey);
      if (!data || data.length === 0) {
        throw new Error(`Storage returned empty data for page ${descriptor.pageKey}`);
      }
      return data;
    } catch (error) {
      // Enhanced storage error
      const enhancedError = new Error(`Storage load failed for page ${descriptor.pageKey}: ${(error as Error).message}`);
      (enhancedError as any).originalError = error;
      (enhancedError as any).pageKey = descriptor.pageKey;
      throw enhancedError;
    }
  }

  /**
   * Create PageInfo with enhanced line and marks support
   */
  private _createPageInfo(descriptor: PageDescriptor, data: Buffer): PageInfo {
    const pageInfo = new PageInfo(
      descriptor.pageKey,
      descriptor.sourceType === 'original' ? descriptor.sourceInfo.fileOffset! : -1,
      descriptor.sourceType === 'original' ? descriptor.sourceInfo.size! : 0
    );
    pageInfo.updateData(data);
    pageInfo.isDirty = descriptor.isDirty;
    pageInfo.isLoaded = true;
    return pageInfo;
  }

  /**
   * Update LRU order
   */
  private _updateLRU(pageKey: string): void {
    const index = this.lruOrder.indexOf(pageKey);
    if (index >= 0) {
      this.lruOrder.splice(index, 1);
    }
    this.lruOrder.push(pageKey);
  }

  /**
   * Evict pages if over memory limit
   */
  private async _evictIfNeeded(): Promise<void> {
    while (this.loadedPages.size > this.maxLoadedPages && this.lruOrder.length > 0) {
      const pageKey = this.lruOrder.shift();
      if (!pageKey) break;
      
      const descriptor = this.addressIndex.pages.find(p => p.pageKey === pageKey);
      
      if (descriptor?.isLoaded && this.loadedPages.has(pageKey)) {
        await this._evictPage(descriptor);
      }
    }
  }

  /**
   * Evict a specific page with marks preservation and line info caching
   */
  private async _evictPage(descriptor: PageDescriptor): Promise<boolean> {
    const pageInfo = this.pageCache.get(descriptor.pageKey);
    if (!pageInfo) return false;
    
    // IMPORTANT: Cache line information before evicting (if not already cached)
    if (!descriptor.lineInfoCached) {
      descriptor.cacheLineInfo(pageInfo);
    }
    
    // Save to storage if dirty
    if (descriptor.isDirty) {
      try {
        await this.buffer.storage.savePage(descriptor.pageKey, pageInfo.data!);
        descriptor.sourceType = 'storage';
        descriptor.sourceInfo = { pageKey: descriptor.pageKey };
      } catch (error) {
        // If storage fails, we can't evict this page safely
        this.buffer._notify(
          'storage_error',
          'error',
          `Failed to save page ${descriptor.pageKey} during eviction: ${(error as Error).message}`,
          { pageKey: descriptor.pageKey, error: (error as Error).message }
        );
        return false; // Indicate eviction failed
      }
    }
    
    // Remove from memory
    this.pageCache.delete(descriptor.pageKey);
    this.loadedPages.delete(descriptor.pageKey);
    descriptor.isLoaded = false;
    
    this.buffer._notify(
      'page_evicted',
      'debug',
      `Evicted page ${descriptor.pageKey}`,
      { pageKey: descriptor.pageKey, lineInfoCached: descriptor.lineInfoCached }
    );
    
    return true; // Indicate eviction succeeded
  }

  /**
   * Generate unique page Key
   */
  private _generatePageKey(): string {
    return `vpage_${++this.nextPageKey}_${Date.now()}`;
  }
}

export {
  VirtualPageManager,
  PageDescriptor,
  PageAddressIndex
};
