/**
 * Enhanced Page metadata with simplified line tracking (marks moved to global system)
 */

import * as crypto from 'crypto';
import {
  type IPageInfo,
  type PageInfoMemoryStats
} from '../types/common';

/**
 * Enhanced Page metadata with simplified line tracking and no marks management
 * (Marks are now handled globally by the page coordinate system)
 */
class PageInfo implements IPageInfo {
  public pageKey: string;
  public fileOffset: number; // Original offset in source file
  public originalSize: number; // Original size in source file
  public checksum: string | null; // Fast checksum for change detection
  
  // Runtime state
  public isDirty: boolean = false; // Has been modified
  public isLoaded: boolean = false; // Currently in memory
  public isDetached: boolean = false; // Conflicts with source file
  public currentSize: number; // Current size (may differ if modified)
  public data: Buffer | null = null; // In-memory data buffer
  public lastAccess: number;
  
  // Simplified line tracking - just store newline positions
  public newlinePositions: number[] = []; // Array of relative positions of \n characters
  public linesCacheValid: boolean = false; // Whether newline positions are up to date

  constructor(pageKey: string, fileOffset: number, originalSize: number, checksum: string | null = null) {
    this.pageKey = pageKey;
    this.fileOffset = fileOffset;
    this.originalSize = originalSize;
    this.checksum = checksum;
    this.currentSize = originalSize;
    this.lastAccess = Date.now();
  }

  /**
   * Calculate fast checksum for change detection
   */
  static calculateChecksum(data: Buffer): string {
    return crypto.createHash('md5').update(data).digest('hex');
  }

  /**
   * Update page with new data and invalidate caches as needed
   */
  updateData(data: Buffer): void {
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
   */
  private _rebuildLineCache(data: Buffer): void {
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
  ensureLineCacheValid(): void {
    if (!this.linesCacheValid && this.isLoaded && this.data) {
      this._rebuildLineCache(this.data);
    }
  }

  /**
   * Get the number of newlines in this page
   */
  getNewlineCount(): number {
    this.ensureLineCacheValid();
    return this.newlinePositions.length;
  }

  /**
   * Get global line starts contributed by this page
   */
  getGlobalLineStarts(pageVirtualStart: number): number[] {
    this.ensureLineCacheValid();
    const starts: number[] = [];
    
    // Each newline creates a line start at position + 1
    for (const nlPos of this.newlinePositions) {
      const globalLineStart = pageVirtualStart + nlPos + 1;
      starts.push(globalLineStart);
    }
    
    return starts;
  }

  /**
   * Update line cache after a modification within this page
   */
  updateAfterModification(_offset: number, _deletedBytes: number, _insertedData: Buffer): void {
    // Invalidate cache - we'll rebuild on next access
    this.linesCacheValid = false;
  }

  /**
   * Verify page integrity against original file
   */
  verifyIntegrity(originalData: Buffer): boolean {
    if (!this.checksum) return false;
    const currentChecksum = PageInfo.calculateChecksum(originalData);
    return currentChecksum === this.checksum;
  }

  /**
   * Get memory usage statistics for this page
   */
  getMemoryStats(): PageInfoMemoryStats {
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
  public startOffset: number;
  public length: number;
  public endsWithNewline: boolean;

  constructor(startOffset: number, length: number, endsWithNewline: boolean = false) {
    this.startOffset = startOffset;
    this.length = length;
    this.endsWithNewline = endsWithNewline;
  }

  get endOffset(): number {
    return this.startOffset + this.length;
  }

  get contentLength(): number {
    return this.endsWithNewline ? this.length - 1 : this.length;
  }
}

// Legacy class kept for compatibility but no longer used
class MarkInfo {
  public name: string;
  public pageOffset: number;
  public virtualAddress: number;

  constructor(name: string, pageOffset: number, virtualAddress: number) {
    this.name = name;
    this.pageOffset = pageOffset;
    this.virtualAddress = virtualAddress;
  }
}

export {
  PageInfo,
  LineInfo,
  MarkInfo
};
