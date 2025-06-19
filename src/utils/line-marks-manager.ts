/**
 * @fileoverview Line and Marks Manager - Page coordinate-based marks with CORRECTED logic
 * @description Manages line positions and named marks using page coordinates for efficiency
 * @author Jeffrey R. Day
 * @version 2.1.1 - Fixed mark update logic for deletions and page operations
 */

import { logger } from './logger';
import {
  type IPageDescriptor,
  type IVirtualPageManager,
  type ILineAndMarksManager,
  type MarkTuple,
  type RelativeMarkTuple,
  type LineCharPosition,
  type LineAndMarksManagerMemoryStats
} from '../types/common';

/**
 * Represents the result of line-related operations
 */
class LineOperationResult {
  public lineNumber: number; // 1-based line number
  public byteStart: number; // Start byte address (exact or page boundary)
  public byteEnd: number; // End byte address (exact or page boundary)
  public length: number; // Line length in bytes
  public marks: MarkTuple[]; // Marks within this line
  public isExact: boolean; // true = exact line bounds, false = page bounds

  constructor(
    lineNumber: number,
    byteStart: number,
    byteEnd: number,
    marks: MarkTuple[] = [],
    isExact: boolean = true
  ) {
    this.lineNumber = lineNumber;
    this.byteStart = byteStart;
    this.byteEnd = byteEnd;
    this.length = byteEnd - byteStart;
    this.marks = marks;
    this.isExact = isExact;
  }
}

/**
 * Represents extracted content with marks - FIXED to use tuples consistently
 */
class ExtractedContent {
  public data: Buffer; // Buffer containing the extracted data
  public marks: RelativeMarkTuple[]; // Array of [name, relativeOffset] tuples for marks in the content

  constructor(data: Buffer, marks: RelativeMarkTuple[] = []) {
    this.data = data;
    this.marks = marks;
  }
}

/**
 * Page coordinate-based marks and line manager
 */
class LineAndMarksManager implements ILineAndMarksManager {
  private vpm: IVirtualPageManager;
  private globalMarks: Map<string, [string, number]> = new Map(); // markName -> [pageKey, offset]
  private pageToMarks: Map<string, Set<string>> = new Map(); // pageKey -> Set<markName> (for performance)

  constructor(virtualPageManager: IVirtualPageManager) {
    this.vpm = virtualPageManager;
  }

  // =================== INTERNAL COORDINATE METHODS ===================

  /**
   * Convert virtual address to page coordinates
   */
  private _virtualToPageCoord(virtualAddress: number): [string, number] {
    // Handle address at the very end of buffer
    const totalSize = this.vpm.getTotalSize();
    if (virtualAddress === totalSize && totalSize > 0) {
      const allPages = this.vpm.addressIndex.getAllPages();
      if (allPages.length > 0) {
        const lastPage = allPages[allPages.length - 1];
        return [lastPage.pageKey, lastPage.virtualSize];
      }
    }
    
    const descriptor = this.vpm.addressIndex.findPageAt(virtualAddress);
    if (!descriptor) {
      throw new Error(`No page found for virtual address ${virtualAddress}`);
    }
    const offset = virtualAddress - descriptor.virtualStart;
    return [descriptor.pageKey, offset];
  }

  /**
   * Convert page coordinates to virtual address
   */
  private _pageCoordToVirtual(pageKey: string, offset: number): number {
    const descriptor = this.vpm.addressIndex.pages.find(p => p.pageKey === pageKey);
    if (!descriptor) {
      throw new Error(`Page ${pageKey} not found`);
    }
    return descriptor.virtualStart + offset;
  }

  /**
   * Set mark using page coordinates
   */
  private _setMarkByCoord(markName: string, pageKey: string, offset: number): void {
    // Remove from old page index if exists
    const oldCoord = this.globalMarks.get(markName);
    if (oldCoord) {
      this._removeFromPageIndex(markName, oldCoord[0]);
    }

    // Set new coordinates (using array for performance)
    this.globalMarks.set(markName, [pageKey, offset]);
    
    // Update page index
    if (!this.pageToMarks.has(pageKey)) {
      this.pageToMarks.set(pageKey, new Set());
    }
    this.pageToMarks.get(pageKey)!.add(markName);
  }

  /**
   * Remove mark from page index
   */
  private _removeFromPageIndex(markName: string, pageKey: string): void {
    const markSet = this.pageToMarks.get(pageKey);
    if (markSet) {
      markSet.delete(markName);
      if (markSet.size === 0) {
        this.pageToMarks.delete(pageKey);
      }
    }
  }

  /**
   * Helper method to update mark coordinate and page index
   */
  private _updateMarkCoordinate(
    markName: string,
    coord: [string, number],
    newCoord: [string, number]
  ): void {
    const [oldPageKey] = coord;
    const [newPageKey, newOffset] = newCoord;
    
    // Update the coordinate in place
    coord[0] = newPageKey;
    coord[1] = newOffset;
    
    // Update page index if page changed
    if (oldPageKey !== newPageKey) {
      // Remove from old page index
      this._removeFromPageIndex(markName, oldPageKey);
      
      // Add to new page index
      if (!this.pageToMarks.has(newPageKey)) {
        this.pageToMarks.set(newPageKey, new Set());
      }
      this.pageToMarks.get(newPageKey)!.add(markName);
    }
  }

  // =================== PAGE STRUCTURE UPDATE OPERATIONS (Page Coordinate Based) ===================
  // These handle page splits/merges - only called by VPM for structural changes

  /**
   * Handle page split - transfer marks to appropriate pages
   */
  handlePageSplit(originalPageKey: string, newPageKey: string, splitOffset: number): void {
    const markNames = this.pageToMarks.get(originalPageKey);
    if (!markNames) return;
    
    const marksToMove: string[] = [];
    
    // Find marks that need to move to the new page
    for (const markName of markNames) {
      const coord = this.globalMarks.get(markName)!;
      const [_pageKey, offset] = coord;
      
      if (offset >= splitOffset) {
        marksToMove.push(markName);
      }
    }
    
    // Move marks to new page
    for (const markName of marksToMove) {
      const coord = this.globalMarks.get(markName)!;
      coord[0] = newPageKey; // Update pageKey
      coord[1] -= splitOffset; // Adjust offset
      
      // Update page index
      this.pageToMarks.get(originalPageKey)!.delete(markName);
      if (!this.pageToMarks.has(newPageKey)) {
        this.pageToMarks.set(newPageKey, new Set());
      }
      this.pageToMarks.get(newPageKey)!.add(markName);
    }
  }

  /**
   * Handle page merge - transfer marks from absorbed page
   */
  handlePageMerge(absorbedPageKey: string, targetPageKey: string, insertOffset: number): void {
    const markNames = this.pageToMarks.get(absorbedPageKey);
    if (!markNames) return;
    
    // Move all marks from absorbed page to target page
    for (const markName of markNames) {
      const coord = this.globalMarks.get(markName)!;
      coord[0] = targetPageKey; // Update pageKey
      coord[1] = insertOffset + coord[1]; // Adjust offset
      
      // Update page index
      if (!this.pageToMarks.has(targetPageKey)) {
        this.pageToMarks.set(targetPageKey, new Set());
      }
      this.pageToMarks.get(targetPageKey)!.add(markName);
    }
    
    // Remove absorbed page from index
    this.pageToMarks.delete(absorbedPageKey);
  }

  /**
   * Validate and clean up orphaned marks
   */
  validateAndCleanupMarks(): string[] {
    const orphanedMarks: string[] = [];
    
    for (const [markName, coord] of this.globalMarks) {
      const [pageKey, offset] = coord;
      
      // Check if page still exists
      const descriptor = this.vpm.addressIndex.pages.find(p => p.pageKey === pageKey);
      if (!descriptor) {
        orphanedMarks.push(markName);
        continue;
      }
      
      // Check if offset is within page bounds
      if (offset > descriptor.virtualSize) {
        // Try to move mark to next page
        const nextPage = this._findNextPage(descriptor);
        if (nextPage) {
          coord[0] = nextPage.pageKey;
          coord[1] = 0; // Move to start of next page
          
          // Update page index
          this._removeFromPageIndex(markName, pageKey);
          if (!this.pageToMarks.has(nextPage.pageKey)) {
            this.pageToMarks.set(nextPage.pageKey, new Set());
          }
          this.pageToMarks.get(nextPage.pageKey)!.add(markName);
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
   */
  private _findNextPage(currentPage: IPageDescriptor): IPageDescriptor | null {
    const pages = this.vpm.addressIndex.getAllPages();
    const currentIndex = pages.findIndex(p => p.pageKey === currentPage.pageKey);
    return currentIndex >= 0 && currentIndex < pages.length - 1 ? pages[currentIndex + 1] : null;
  }

  // =================== PUBLIC MARKS API ===================

  /**
   * Set a named mark at a virtual address
   */
  setMark(markName: string, virtualAddress: number): void {
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
        this._setMarkByCoord(markName, lastPage.pageKey, lastPage.virtualSize);
        return;
      }
    }

    const coord = this._virtualToPageCoord(virtualAddress);
    this._setMarkByCoord(markName, coord[0], coord[1]);
  }

  /**
   * Get the virtual address of a named mark
   */
  getMark(markName: string): number | null {
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
   */
  removeMark(markName: string): boolean {
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
   */
  getMarksInRange(startAddress: number, endAddress: number): MarkTuple[] {
    const result: MarkTuple[] = [];
    
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
   */
  getAllMarks(): MarkTuple[] {
    const result: MarkTuple[] = [];
    
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
   */
  getMarksInDeletedContent(startAddress: number, endAddress: number): RelativeMarkTuple[] {
    const marksInfo: RelativeMarkTuple[] = [];

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
   */
  removeMarksFromRange(startAddress: number, endAddress: number): RelativeMarkTuple[] {
    const removed: RelativeMarkTuple[] = [];
    const marksToRemove: string[] = [];

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
   */
  insertMarksFromRelative(insertAddress: number, marks: RelativeMarkTuple[]): void {
    for (const markData of marks) {
      const virtualAddress = insertAddress + markData[1];
      this.setMark(markData[0], virtualAddress);
    }
  }

  // =================== PERSISTENCE API ===================

  /**
   * Get all marks as a key-value object with virtual addresses (for persistence)
   */
  getAllMarksForPersistence(): Record<string, number> {
    const result: Record<string, number> = {};
    
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
   */
  setMarksFromPersistence(marksObject: Record<string, number>): void {
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
  clearAllMarks(): void {
    this.globalMarks.clear();
    this.pageToMarks.clear();
  }

  // =================== ENHANCED OPERATIONS WITH MARKS ===================

  /**
   * Enhanced getBytes that includes marks in the result
   */
  async getBytesWithMarks(start: number, end: number, includeMarks: boolean = false): Promise<Buffer | ExtractedContent> {
    const data = await this.vpm.readRange(start, end);
    
    if (!includeMarks) {
      return data;
    }

    const marks = this.getMarksInRange(start, end - 1);
    const relativeMarks: RelativeMarkTuple[] = marks.map(mark => [
      mark[0], // name
      mark[1] - start // relative offset
    ]);

    return new ExtractedContent(data, relativeMarks);
  }

  /**
   * CORRECTED: Enhanced insertBytes - handles marks correctly with page operations
   */
  async insertBytesWithMarks(position: number, data: Buffer, marks: RelativeMarkTuple[] = []): Promise<void> {
    logger.debug(`[DEBUG] insertBytesWithMarks: position=${position}, dataLen=${data.length}`);
    logger.debug('[DEBUG] Marks before operation:', this.getAllMarks());
    
    // STEP 1: Capture marks that need to be shifted (AFTER insertion point, not AT)
    const marksToShift: Array<{ name: string; originalPos: number }> = [];
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
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`Failed to update mark ${markInfo.name} to position ${newPos}: ${errorMessage}`);
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
   */
  async deleteBytesWithMarks(start: number, end: number, reportMarks: boolean = false): Promise<ExtractedContent> {
    logger.debug(`[DEBUG] deleteBytesWithMarks: start=${start}, end=${end}, reportMarks=${reportMarks}`);
    logger.debug('[DEBUG] Marks before operation:', this.getAllMarks());
    
    // STEP 1: If requested, get info about marks in the deleted content (for paste operations)
    let marksInDeletedContent: RelativeMarkTuple[] = [];
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
    
    // Return deleted data with marks report (if requested) - using tuples directly
    return new ExtractedContent(deletedData, marksInDeletedContent);
  }

  /**
   * Enhanced overwriteBytes with marks support
   */
  async overwriteBytesWithMarks(position: number, data: Buffer, marks: RelativeMarkTuple[] = []): Promise<ExtractedContent> {
    const endPosition = Math.min(position + data.length, this.vpm.getTotalSize());
    const originalSize = endPosition - position;
    const netSizeChange = data.length - originalSize;
    
    logger.debug(`[DEBUG] overwriteBytesWithMarks: position=${position}, dataLen=${data.length}, originalSize=${originalSize}, netChange=${netSizeChange}`);
    logger.debug('[DEBUG] Marks before operation:', this.getAllMarks());
    
    // Get overwritten data before modification
    const overwrittenData = await this.vpm.readRange(position, endPosition);
    
    // Handle marks based on the type of overwrite
    let marksInOverwrittenContent: RelativeMarkTuple[] = [];
    if (data.length < originalSize) {
      // Content is shrinking - report marks that will be in the removed portion
      marksInOverwrittenContent = this.getMarksInDeletedContent(position + data.length, endPosition);
    }
    
    // Capture marks that need to be shifted (after the overwrite region)
    const marksToShift: Array<{ name: string; originalPos: number }> = [];
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
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`Failed to update mark ${markInfo.name} to position ${newPos}: ${errorMessage}`);
      }
    }
    
    // Insert new marks
    if (marks.length > 0) {
      this.insertMarksFromRelative(position, marks);
      logger.debug('[DEBUG] Marks after inserting new marks:', this.getAllMarks());
    }
    
    // Return overwritten data with marks report - using tuples directly
    return new ExtractedContent(overwrittenData, marksInOverwrittenContent);
  }

  /**
   * CORRECTED: Update marks after a modification using virtual addresses
   * This method handles logical mark movement for content changes
   */
  updateMarksAfterModification(virtualStart: number, deletedBytes: number, insertedBytes: number): void {
    const virtualEnd = virtualStart + deletedBytes;
    const netChange = insertedBytes - deletedBytes;
    
    logger.debug(`[DEBUG] updateMarksAfterModification: start=${virtualStart}, deleted=${deletedBytes}, inserted=${insertedBytes}, netChange=${netChange}`);
    
    // Create a list of marks to update (avoid modifying map during iteration)
    const marksToUpdate: Array<{ name: string; virtualPos: number; coord: [string, number] }> = [];
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
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.warn(`Failed to move mark ${name} to deletion start: ${errorMessage}`);
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
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.warn(`Failed to shift mark ${name}: ${errorMessage}`);
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
  invalidateLineCaches(): void {
    this.invalidatePageLineCaches();
  }

  /**
   * Invalidate line caches in pages (called when buffer content changes)
   */
  invalidatePageLineCaches(): void {
    // Mark all page line caches as invalid in the VPM
    for (const descriptor of this.vpm.addressIndex.getAllPages()) {
      descriptor.lineInfoCached = false;
    }
  }

  /**
   * Ensure page containing address is loaded (ASYNC)
   */
  async seekAddress(address: number): Promise<boolean> {
    if (address < 0 || address > this.vpm.getTotalSize()) {
      return false;
    }

    const descriptor = this.vpm.addressIndex.findPageAt(address);
    if (!descriptor) {
      return false;
    }

    try {
      if (this.vpm._ensurePageLoaded) {
        await this.vpm._ensurePageLoaded(descriptor);
      }
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get the total number of lines in the buffer (SYNCHRONOUS)
   */
  getTotalLineCount(): number {
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
      } else if (this.vpm?.pageCache.has(descriptor.pageKey)) {
        // Page is loaded - count newlines and cache the result
        const pageInfo = this.vpm.pageCache.get(descriptor.pageKey)!;
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
   */
  getLineInfo(lineNumber: number): LineOperationResult | null {
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
      let exactPositions: number[] | null = null;

      if (this.vpm.pageCache.has(descriptor.pageKey)) {
        // Page is loaded - get exact line positions
        const pageInfo = this.vpm.pageCache.get(descriptor.pageKey)!;
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
   */
  getMultipleLines(startLine: number, endLine: number): LineOperationResult[] {
    const result: LineOperationResult[] = [];
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
   */
  getLineNumberFromAddress(virtualAddress: number): number {
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
        if (this.vpm.pageCache.has(descriptor.pageKey)) {
          // Page is loaded - get exact line
          const pageInfo = this.vpm.pageCache.get(descriptor.pageKey)!;
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
      if (this.vpm.pageCache.has(descriptor.pageKey)) {
        const pageInfo = this.vpm.pageCache.get(descriptor.pageKey)!;
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
   */
  lineCharToBytePosition(pos: LineCharPosition): number {
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
   */
  byteToLineCharPosition(bytePos: number): LineCharPosition {
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
   */
  getMemoryStats(): LineAndMarksManagerMemoryStats {
    // Calculate marks memory more accurately
    let marksMemory = 0;
    for (const [markName, coord] of this.globalMarks) {
      marksMemory += markName.length * 2; // String storage (UTF-16)
      marksMemory += 16; // Array overhead
      marksMemory += coord[0].length * 2; // pageKey string
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

export {
  LineAndMarksManager,
  LineOperationResult,
  ExtractedContent
};
