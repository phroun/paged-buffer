/**
 * @fileoverview Enhanced PagedBuffer with page coordinate-based marks
 * @description High-performance buffer with line-aware operations and page coordinate marks support
 * @author Jeffrey R. Day
 * @version 2.3.0 - Page coordinate marks system
 */

import { promises as fs } from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';
import { logger } from './utils/logger';
import { BufferUndoSystem } from './undo-system';
import { MemoryPageStorage } from './storage/memory-page-storage';
import { VirtualPageManager } from './virtual-page-manager';
import { LineAndMarksManager, ExtractedContent } from './utils/line-marks-manager';

import {
  type IBuffer,
  type MarkInfo,
  type LineCharPosition,
  type RelativeMarkTuple
} from './types/common';

// Import buffer-specific types (these would need to be created)
enum BufferState {
  CLEAN = 'clean',
  DETACHED = 'detached',
  CORRUPTED = 'corrupted'
}

enum FileChangeStrategy {
  REBASE = 'rebase',
  WARN = 'warn',
  DETACH = 'detach'
}

enum NotificationType {
  BUFFER_DETACHED = 'buffer_detached',
  FILE_MODIFIED_ON_DISK = 'file_modified_on_disk',
  PAGE_SPLIT = 'page_split',
  PAGE_MERGED = 'page_merged',
  STORAGE_ERROR = 'storage_error'
}

interface BufferNotification {
  type: string;
  severity: string;
  message: string;
  metadata: any;
  timestamp: Date;
}

class BufferNotificationImpl implements BufferNotification {
  public timestamp: Date;

  constructor(
    public type: string,
    public severity: string,
    public message: string,
    public metadata: any = {}
  ) {
    this.timestamp = new Date();
  }
}

interface ChangeStrategy {
  noEdits: FileChangeStrategy;
  withEdits: FileChangeStrategy;
  sizeChanged: FileChangeStrategy;
}

interface Storage {
  savePage(pageKey: string, data: Buffer): Promise<void>;
  loadPage(pageKey: string): Promise<Buffer>;
  deletePage(pageKey: string): Promise<void>;
}

interface SaveOptions {
  forcePartialSave?: boolean;
  allowDetached?: boolean;
  isAtomicSave?: boolean;
}

interface UndoConfig {
  maxUndoLevels?: number;
  [key: string]: any;
}

interface UndoTransactionOptions {
  [key: string]: any;
}

interface LineOperationResult {
  lineNumber: number;
  byteStart: number;
  byteEnd: number;
  length: number;
  marks: Array<[string, number]>;
  isExact: boolean;
}

interface FileChangeInfo {
  changed: boolean;
  sizeChanged?: boolean;
  mtimeChanged?: boolean;
  newSize?: number;
  newMtime?: Date;
  deleted?: boolean;
}

interface BufferStatus {
  state: BufferState;
  hasUnsavedChanges: boolean;
  canSaveToOriginal: boolean;
  isDetached: boolean;
  isCorrupted: boolean;
  missingDataRanges: number;
  totalSize: number;
  filename: string | null;
}

interface DetachmentInfo {
  isDetached: boolean;
  reason: string | null;
  missingRanges: number;
  totalMissingBytes: number;
  ranges: Array<{
    virtualStart: number;
    virtualEnd: number;
    size: number;
    reason: string;
  }>;
}

interface MemoryStats {
  totalPages: number;
  loadedPages: number;
  dirtyPages: number;
  detachedPages: number;
  memoryUsed: number;
  maxMemoryPages: number;
  totalLines: number;
  globalMarksCount: number;
  pageIndexSize: number;
  linesMemory: number;
  marksMemory: number;
  lineStartsCacheValid: boolean;
  state: BufferState;
  hasUnsavedChanges: boolean;
  virtualSize: number;
  sourceSize: number;
  undo: {
    undoGroups: number;
    redoGroups: number;
    totalUndoOperations: number;
    totalRedoOperations: number;
    currentGroupOperations: number;
    memoryUsage: number;
  };
}

/**
 * Tracks missing data ranges in detached buffers
 */
class MissingDataRange {
  public size: number;

  constructor(
    public virtualStart: number,
    public virtualEnd: number,
    public originalFileStart: number | null = null,
    public originalFileEnd: number | null = null,
    public reason: string = 'unknown'
  ) {
    this.size = virtualEnd - virtualStart;
  }

  /**
   * Generate human-readable description of missing data
   */
  toDescription(): string {
    const sizeDesc = this.size === 1 ? '1 byte' : `${this.size.toLocaleString()} bytes`;
    let desc = `[Missing ${sizeDesc} from buffer addresses ${this.virtualStart.toLocaleString()} to ${this.virtualEnd.toLocaleString()}`;
    
    if (this.originalFileStart !== null && this.originalFileEnd !== null) {
      desc += `, original file positions ${this.originalFileStart.toLocaleString()} to ${this.originalFileEnd.toLocaleString()}`;
    }
    
    if (this.reason !== 'unknown') {
      desc += `, reason: ${this.reason}`;
    }
    
    desc += '.]';
    desc += '\n';
    
    return desc;
  }
}

/**
 * Enhanced PagedBuffer with page coordinate-based marks
 */
class PagedBuffer implements IBuffer {
  public pageSize: number;
  public storage: Storage;
  public maxMemoryPages: number;
  
  // File metadata
  public filename: string | null = null;
  public fileSize: number = 0;
  public fileMtime: Date | null = null;
  public fileChecksum: string | null = null;
  
  // Virtual Page Manager
  public virtualPageManager: VirtualPageManager;
  
  // Enhanced Line and Marks Manager with page coordinates
  public lineAndMarksManager: LineAndMarksManager;
  
  // Virtual file state
  public totalSize: number = 0;
  
  // REFACTORED STATE MANAGEMENT:
  // Data integrity state (clean/detached/corrupted)
  public state: BufferState = BufferState.CLEAN;
  // Modification state (separate from integrity)
  public hasUnsavedChanges: boolean = false;
  
  // Detached buffer tracking
  public missingDataRanges: MissingDataRange[] = [];
  public detachmentReason: string | null = null;
  
  // Notification system
  public notifications: BufferNotification[] = [];
  public notificationCallbacks: Array<(notification: BufferNotification) => void> = [];
  
  // File change detection settings
  public changeStrategy: ChangeStrategy;
  
  // Monitoring
  public lastFileCheck: number | null = null;
  public fileCheckInterval: number = 5000;
  
  // Undo/Redo system
  public undoSystem: BufferUndoSystem | null = null;

  constructor(pageSize: number = 64 * 1024, storage: Storage | null = null, maxMemoryPages: number = 100) {
    this.pageSize = pageSize;
    this.storage = storage || new MemoryPageStorage();
    this.maxMemoryPages = maxMemoryPages;
    
    // Virtual Page Manager
    this.virtualPageManager = new VirtualPageManager(this, pageSize, maxMemoryPages);
    
    // Enhanced Line and Marks Manager with page coordinates
    this.lineAndMarksManager = new LineAndMarksManager(this.virtualPageManager);
    this.virtualPageManager.setLineAndMarksManager(this.lineAndMarksManager);
    
    // File change detection settings
    this.changeStrategy = {
      noEdits: FileChangeStrategy.REBASE,
      withEdits: FileChangeStrategy.WARN,
      sizeChanged: FileChangeStrategy.DETACH
    };
  }

  /**
   * Mark buffer as detached due to data loss
   */
  _markAsDetached(reason: string, missingRanges: MissingDataRange[] = []): void {
    const wasDetached = this.state === BufferState.DETACHED;
    
    // CRITICAL: Always transition to DETACHED when corruption is detected
    this.state = BufferState.DETACHED;
    this.detachmentReason = reason;
    this.missingDataRanges = [...this.missingDataRanges, ...missingRanges];
    
    // Merge overlapping ranges
    this._mergeMissingRanges();
    
    if (!wasDetached) {
      this._notify(
        NotificationType.BUFFER_DETACHED,
        'warning',
        `Buffer detached: ${reason}. Some data may be unavailable.`,
        { 
          reason, 
          missingRanges: missingRanges.length,
          totalMissingBytes: missingRanges.reduce((sum, range) => sum + range.size, 0),
          recommendation: 'Use Save As to save available data to a new file'
        }
      );
    }
  }

  /**
   * Mark buffer as having unsaved changes
   */
  public markAsModified(): void {
    this.hasUnsavedChanges = true;
  }

  /**
   * Mark buffer as saved (no unsaved changes)
   */
  private _markAsSaved(): void {
    this.hasUnsavedChanges = false;
  }

  /**
   * Merge overlapping missing data ranges
   */
  private _mergeMissingRanges(): void {
    if (this.missingDataRanges.length <= 1) return;
    
    // Sort by virtual start position
    this.missingDataRanges.sort((a, b) => a.virtualStart - b.virtualStart);
    
    const merged = [this.missingDataRanges[0]];
    
    for (let i = 1; i < this.missingDataRanges.length; i++) {
      const current = this.missingDataRanges[i];
      const last = merged[merged.length - 1];
      
      if (current.virtualStart <= last.virtualEnd) {
        // Overlapping or adjacent ranges - merge them
        last.virtualEnd = Math.max(last.virtualEnd, current.virtualEnd);
        last.size = last.virtualEnd - last.virtualStart;
        if (current.originalFileEnd !== null && last.originalFileEnd !== null) {
          last.originalFileEnd = Math.max(last.originalFileEnd, current.originalFileEnd);
        }
      } else {
        merged.push(current);
      }
    }
    
    this.missingDataRanges = merged;
  }

  /**
   * Add notification callback
   */
  onNotification(callback: (notification: BufferNotification) => void): void {
    this.notificationCallbacks.push(callback);
  }

  /**
   * Emit a notification
   */
  _notify(type: string, severity: string, message: string, metadata: any = {}): void {
    const notification = new BufferNotificationImpl(type, severity, message, metadata);
    this.notifications.push(notification);
    
    for (const callback of this.notificationCallbacks) {
      try {
        callback(notification);
      } catch (error) {
        logger.error('Notification callback error:', error);
      }
    }
  }

  /**
   * Load a file into the buffer
   */
  async loadFile(filename: string): Promise<void> {
    try {
      const stats = await fs.stat(filename);
      this.filename = filename;
      this.fileSize = stats.size;
      this.fileMtime = stats.mtime;
      this.totalSize = stats.size;
      this.lastFileCheck = Date.now();
      
      // Clear any previous state
      this.state = BufferState.CLEAN;
      this.hasUnsavedChanges = false;
      this.missingDataRanges = [];
      this.detachmentReason = null;
      
      // Calculate file checksum
      this.fileChecksum = await this._calculateFileChecksum(filename);
      
      // Initialize Virtual Page Manager from file
      this.virtualPageManager.initializeFromFile(filename, stats.size, this.fileChecksum);
      
      this._notify(
        NotificationType.FILE_MODIFIED_ON_DISK,
        'info',
        'Loaded file',
        { filename, size: stats.size, state: this.state, hasUnsavedChanges: this.hasUnsavedChanges }
      );
      
    } catch (error) {
      throw new Error(`Failed to load file: ${(error as Error).message}`);
    }
  }

  /**
   * Enhanced loadContent with proper initial state
   */
  loadContent(content: string): void {
    this.filename = null;
    this.totalSize = Buffer.byteLength(content, 'utf8');
    
    // Clear any previous state
    this.state = BufferState.CLEAN;
    this.hasUnsavedChanges = false;
    this.missingDataRanges = [];
    this.detachmentReason = null;
    
    // Initialize Virtual Page Manager from content
    const contentBuffer = Buffer.from(content, 'utf8');
    this.virtualPageManager.initializeFromContent(contentBuffer);
    
    this._notify(
      'buffer_content_loaded',
      'info',
      'Loaded content',
      { size: this.totalSize, state: this.state, hasUnsavedChanges: this.hasUnsavedChanges }
    );
  }

  /**
   * Enhanced loadBinaryContent with proper initial state
   */
  loadBinaryContent(content: Buffer): void {
    this.filename = null;
    this.totalSize = content.length;
    
    // Clear any previous state
    this.state = BufferState.CLEAN;
    this.hasUnsavedChanges = false;
    this.missingDataRanges = [];
    this.detachmentReason = null;
    
    // Initialize Virtual Page Manager from content
    this.virtualPageManager.initializeFromContent(content);
    
    this._notify(
      'buffer_content_loaded',
      'info',
      'Loaded binary content',
      { size: this.totalSize, state: this.state, hasUnsavedChanges: this.hasUnsavedChanges }
    );
  }

  /**
   * Calculate file checksum for change detection
   */
  private async _calculateFileChecksum(filename: string): Promise<string> {
    if (this.fileSize === 0) {
      return 'd41d8cd98f00b204e9800998ecf8427e'; // MD5 of empty string
    }

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
   * Check for file changes
   */
  async checkFileChanges(): Promise<FileChangeInfo> {
    if (!this.filename) {
      return { changed: false };
    }

    try {
      const stats = await fs.stat(this.filename);
      const sizeChanged = stats.size !== this.fileSize;
      const mtimeChanged = stats.mtime.getTime() !== this.fileMtime!.getTime();
      const changed = sizeChanged || mtimeChanged;

      return {
        changed,
        sizeChanged,
        mtimeChanged,
        newSize: stats.size,
        newMtime: stats.mtime,
        deleted: false
      };
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return {
          changed: true,
          deleted: true,
          sizeChanged: true,
          mtimeChanged: true
        };
      }
      throw error;
    }
  }

  // =================== CORE BYTE OPERATIONS WITH MARKS SUPPORT ===================

  /**
   * Get bytes from absolute position with optional marks extraction
   */
  async getBytes(start: number, end: number, includeMarks: boolean = false): Promise<Buffer | ExtractedContent> {
    if (start < 0 || end < 0) {
      throw new Error('Invalid range: positions cannot be negative');
    }
    if (start > end) {
      return includeMarks ? new ExtractedContent(Buffer.alloc(0), []) : Buffer.alloc(0);
    }
    if (start >= this.totalSize) {
      return includeMarks ? new ExtractedContent(Buffer.alloc(0), []) : Buffer.alloc(0);
    }
    if (end > this.totalSize) {
      end = this.totalSize;
    }
    
    try {
      if (includeMarks) {
        return await this.lineAndMarksManager.getBytesWithMarks(start, end, true);
      } else {
        return await this.virtualPageManager.readRange(start, end);
      }
    } catch (error) {
      // CRITICAL: If VPM fails to read data, this triggers detachment
      // The VPM should have already called _markAsDetached through _handleCorruption
      // So we just return empty buffer here
      return includeMarks ? new ExtractedContent(Buffer.alloc(0), []) : Buffer.alloc(0);
    }
  }

  /**
   * Enhanced insertBytes with marks support - FIXED parameter handling
   */
  async insertBytes(position: number, data: Buffer, marks: MarkInfo[] | RelativeMarkTuple[] = []): Promise<void> {
    if (position < 0) {
      throw new Error('Invalid position: cannot be negative');
    }
    if (position > this.totalSize) {
      throw new Error(`Position ${position} is beyond end of buffer (size: ${this.totalSize})`);
    }

    logger.debug(`[DEBUG] insertBytes called: position=${position}, dataLen=${data.length}`);

    // Capture values before execution for undo recording
    const originalPosition = position;
    const originalData = Buffer.from(data);
    const timestamp = this.undoSystem ? this.undoSystem.getClock() : Date.now();
    
    // CRITICAL FIX: Capture marks snapshot BEFORE operation executes
    const preOpMarksSnapshot = this.undoSystem ? this.undoSystem.captureCurrentMarksState() : null;

    logger.debug('[DEBUG] Pre-op marks:', preOpMarksSnapshot);

    // FIXED: Handle both MarkInfo objects and RelativeMarkTuple arrays
    let relativeMarks: RelativeMarkTuple[];
    if (marks.length > 0) {
      if (Array.isArray(marks[0])) {
        // Already tuples
        relativeMarks = marks as RelativeMarkTuple[];
      } else {
        // MarkInfo objects - convert to tuples
        relativeMarks = (marks as MarkInfo[]).map(mark => [mark.name, mark.relativeOffset]);
      }
    } else {
      relativeMarks = [];
    }

    // Always use enhanced method (handles both VPM and mark updates)
    await this.lineAndMarksManager.insertBytesWithMarks(position, data, relativeMarks);
    
    // Update buffer state
    this.totalSize += data.length;
    this.markAsModified();
    
    logger.debug('[DEBUG] Post-op marks:', this.lineAndMarksManager.getAllMarks());
    
    // Record the operation AFTER executing it, with pre-operation snapshot
    if (this.undoSystem) {
      this.undoSystem.recordInsert(originalPosition, originalData, timestamp, preOpMarksSnapshot);
    }
  }

  /**
   * Enhanced deleteBytes with marks reporting - FIXED to handle tuples
   */
  async deleteBytes(start: number, end: number, reportMarks: boolean = false): Promise<Buffer | ExtractedContent> {
    if (start < 0 || end < 0) {
      throw new Error('Invalid range: positions cannot be negative');  
    }
    if (start > end) {
      throw new Error('Invalid range: start position must be less than or equal to end position');
    }
    if (start >= this.totalSize) {
      return reportMarks ? new ExtractedContent(Buffer.alloc(0), []) : Buffer.alloc(0);
    }
    if (end > this.totalSize) {
      end = this.totalSize;
    }

    logger.debug(`[DEBUG] deleteBytes called: start=${start}, end=${end}, reportMarks=${reportMarks}`);

    // Capture values before execution for undo recording
    const originalStart = start;
    const timestamp = this.undoSystem ? this.undoSystem.getClock() : Date.now();
    
    // CRITICAL FIX: Capture marks snapshot BEFORE operation executes
    const preOpMarksSnapshot = this.undoSystem ? this.undoSystem.captureCurrentMarksState() : null;

    logger.debug('[DEBUG] Pre-delete marks:', preOpMarksSnapshot);

    // Always use enhanced method (handles both VPM and mark updates)
    const result = await this.lineAndMarksManager.deleteBytesWithMarks(start, end, reportMarks);
    
    // Update buffer state
    this.totalSize -= result.data.length;
    this.markAsModified();
    
    logger.debug('[DEBUG] Post-delete marks:', this.lineAndMarksManager.getAllMarks());
    
    // Record the operation AFTER executing it, with pre-operation snapshot
    if (this.undoSystem) {
      this.undoSystem.recordDelete(originalStart, result.data, timestamp, preOpMarksSnapshot);
    }
    
    // Return appropriate format based on reportMarks parameter
    if (reportMarks) {
      return result; // ExtractedContent with marks info as tuples
    } else {
      return result.data; // Just the Buffer for backward compatibility
    }
  }

  /**
   * Enhanced overwriteBytes with marks support - FIXED to handle tuples
   */
  async overwriteBytes(position: number, data: Buffer, marks: MarkInfo[] | RelativeMarkTuple[] = []): Promise<Buffer | ExtractedContent> {
    if (position < 0) {
      throw new Error('Invalid position: cannot be negative');
    }
    if (position >= this.totalSize) {
      throw new Error(`Position ${position} is beyond end of buffer (size: ${this.totalSize})`);
    }

    logger.debug(`[DEBUG] overwriteBytes called: position=${position}, dataLen=${data.length}`);

    // Capture values before execution for undo recording
    const originalPosition = position;
    const originalData = Buffer.from(data);
    const timestamp = this.undoSystem ? this.undoSystem.getClock() : Date.now();
    
    // CRITICAL FIX: Capture marks snapshot BEFORE operation executes
    const preOpMarksSnapshot = this.undoSystem ? this.undoSystem.captureCurrentMarksState() : null;

    // Calculate overwrite range for undo recording
    const overwriteEnd = Math.min(position + data.length, this.totalSize);
    const overwrittenDataForUndo = await this.getBytes(position, overwriteEnd) as Buffer;

    // FIXED: Handle both MarkInfo objects and RelativeMarkTuple arrays
    let relativeMarks: RelativeMarkTuple[];
    if (marks.length > 0) {
      if (Array.isArray(marks[0])) {
        // Already tuples
        relativeMarks = marks as RelativeMarkTuple[];
      } else {
        // MarkInfo objects - convert to tuples
        relativeMarks = (marks as MarkInfo[]).map(mark => [mark.name, mark.relativeOffset]);
      }
    } else {
      relativeMarks = [];
    }

    // Always use enhanced method (handles both VPM and mark updates)
    const result = await this.lineAndMarksManager.overwriteBytesWithMarks(position, data, relativeMarks);
    
    // Update buffer state
    const originalSize = overwriteEnd - position;
    const netSizeChange = data.length - originalSize;
    this.totalSize += netSizeChange;
    this.markAsModified();
    
    // Record the operation AFTER executing it, with pre-operation snapshot
    if (this.undoSystem) {
      this.undoSystem.recordOverwrite(originalPosition, originalData, overwrittenDataForUndo, timestamp, preOpMarksSnapshot);
    }
    
    // BACKWARD COMPATIBILITY: Return Buffer if no marks provided, ExtractedContent if marks provided
    if (marks.length > 0) {
      return result; // ExtractedContent with tuple marks
    } else {
      return result.data; // Buffer (legacy behavior)
    }
  }

  // =================== NAMED MARKS API ===================

  /**
   * Set a named mark at a byte address
   */
  setMark(markName: string, byteAddress: number): void {
    this.lineAndMarksManager.setMark(markName, byteAddress);
  }

  /**
   * Get the byte address of a named mark
   */
  getMark(markName: string): number | null {
    return this.lineAndMarksManager.getMark(markName);
  }

  /**
   * Remove a named mark
   */
  removeMark(markName: string): boolean {
    return this.lineAndMarksManager.removeMark(markName);
  }

  /**
   * Get all marks between two byte addresses
   */
  getMarksInRange(startAddress: number, endAddress: number): Array<[string, number]> {
    return this.lineAndMarksManager.getMarksInRange(startAddress, endAddress);
  }

  /**
   * Get all marks in the buffer
   */
  getAllMarks(): Record<string, number> {
    return this.lineAndMarksManager.getAllMarksForPersistence();
  }

  /**
   * Set marks from a key-value object (for persistence)
   */
  setMarks(marksObject: Record<string, number>): void {
    this.lineAndMarksManager.setMarksFromPersistence(marksObject);
  }

  /**
   * Clear all marks
   */
  clearAllMarks(): void {
    this.lineAndMarksManager.clearAllMarks();
  }

  // =================== UNDO/REDO SYSTEM ===================

  /**
   * Enable undo/redo functionality
   */
  enableUndo(config: UndoConfig = {}): void {
    if (!this.undoSystem) {
      this.undoSystem = new BufferUndoSystem(this, config.maxUndoLevels);
      if (config) {
        this.undoSystem.configure(config);
      }
    }
  }

  /**
   * Disable undo/redo functionality
   */
  disableUndo(): void {
    if (this.undoSystem) {
      this.undoSystem.clear();
      this.undoSystem = null;
    }
  }

  /**
   * Begin a named undo transaction
   */
  beginUndoTransaction(name: string, options: UndoTransactionOptions = {}): void {
    if (this.undoSystem) {
      this.undoSystem.beginUndoTransaction(name, options);
    }
  }

  /**
   * Commit the current undo transaction
   */
  commitUndoTransaction(finalName: string | null = null): boolean {
    if (this.undoSystem) {
      return this.undoSystem.commitUndoTransaction(finalName);
    }
    return false;
  }

  /**
   * Rollback the current undo transaction
   */
  async rollbackUndoTransaction(): Promise<boolean> {
    if (this.undoSystem) {
      return await this.undoSystem.rollbackUndoTransaction();
    }
    return false;
  }

  /**
   * Check if currently in an undo transaction
   */
  inUndoTransaction(): boolean {
    return this.undoSystem ? this.undoSystem.inTransaction() : false;
  }

  /**
   * Get current undo transaction info
   */
  getCurrentUndoTransaction(): any {
    return this.undoSystem ? this.undoSystem.getCurrentTransaction() : null;
  }

  /**
   * Undo the last operation
   */
  async undo(): Promise<boolean> {
    if (!this.undoSystem) {
      return false;
    }
    return await this.undoSystem.undo();
  }

  /**
   * Redo the last undone operation
   */
  async redo(): Promise<boolean> {
    if (!this.undoSystem) {
      return false;
    }
    return await this.undoSystem.redo();
  }

  /**
   * Check if undo is available
   */
  canUndo(): boolean {
    return this.undoSystem ? this.undoSystem.canUndo() : false;
  }

  /**
   * Check if redo is available
   */
  canRedo(): boolean {
    return this.undoSystem ? this.undoSystem.canRedo() : false;
  }

  // =================== UTILITY METHODS ===================

  /**
   * Get total size of buffer
   */
  getTotalSize(): number {
    return this.virtualPageManager.getTotalSize();
  }

  /**
   * Get buffer state (data integrity)
   */
  getState(): BufferState {
    // Validate state consistency
    if (this.state === BufferState.DETACHED && this.missingDataRanges.length === 0) {
      logger.warn('Buffer marked as DETACHED but has no missing data ranges');
    }
    
    return this.state;
  }

  /**
   * Check if buffer has unsaved changes
   */
  hasChanges(): boolean {
    return this.hasUnsavedChanges;
  }

  /**
   * Check if buffer can be saved to its original location
   */
  canSaveToOriginal(): boolean {
    return this.state !== BufferState.DETACHED;
  }

  /**
   * Get comprehensive buffer status
   */
  getStatus(): BufferStatus {
    return {
      state: this.state,
      hasUnsavedChanges: this.hasUnsavedChanges,
      canSaveToOriginal: this.canSaveToOriginal(),
      isDetached: this.state === BufferState.DETACHED,
      isCorrupted: this.state === BufferState.CORRUPTED,
      missingDataRanges: this.missingDataRanges.length,
      totalSize: this.getTotalSize(),
      filename: this.filename
    };
  }

  /**
   * Get enhanced memory usage stats with line and marks information
   */
  getMemoryStats(): MemoryStats {
    const vmpStats = this.virtualPageManager.getMemoryStats();
    const lmStats = this.lineAndMarksManager.getMemoryStats();
    
    const undoStats = this.undoSystem ? this.undoSystem.getStats() : {
      undoGroups: 0,
      redoGroups: 0,
      totalUndoOperations: 0,
      totalRedoOperations: 0,
      currentGroupOperations: 0,
      memoryUsage: 0
    };
    
    return {
      // VPM stats
      totalPages: vmpStats.totalPages,
      loadedPages: vmpStats.loadedPages,
      dirtyPages: vmpStats.dirtyPages,
      detachedPages: 0, // Enhanced VPM handles this differently
      memoryUsed: vmpStats.memoryUsed,
      maxMemoryPages: this.maxMemoryPages,
      
      // Line and marks stats
      totalLines: lmStats.totalLines,
      globalMarksCount: lmStats.globalMarksCount,
      pageIndexSize: lmStats.pageIndexSize,
      linesMemory: vmpStats.linesMemory + lmStats.estimatedLinesCacheMemory,
      marksMemory: vmpStats.marksMemory + lmStats.estimatedMarksMemory,
      lineStartsCacheValid: lmStats.lineStartsCacheValid,
      
      // Buffer stats
      state: this.state,
      hasUnsavedChanges: this.hasUnsavedChanges,
      virtualSize: vmpStats.virtualSize,
      sourceSize: vmpStats.sourceSize,
      
      // Undo stats
      undo: undoStats
    };
  }

  /**
   * Get detachment information
   */
  getDetachmentInfo(): DetachmentInfo {
    return {
      isDetached: this.state === BufferState.DETACHED,
      reason: this.detachmentReason,
      missingRanges: this.missingDataRanges.length,
      totalMissingBytes: this.missingDataRanges.reduce((sum, range) => sum + range.size, 0),
      ranges: this.missingDataRanges.map(range => ({
        virtualStart: range.virtualStart,
        virtualEnd: range.virtualEnd,
        size: range.size,
        reason: range.reason
      }))
    };
  }

  /**
   * Get all notifications
   */
  getNotifications(): BufferNotification[] {
    return [...this.notifications];
  }

  /**
   * Clear notifications
   */
  clearNotifications(type: string | null = null): void {
    if (type) {
      this.notifications = this.notifications.filter(n => n.type !== type);
    } else {
      this.notifications = [];
    }
  }

  /**
   * Set file change handling strategy
   */
  setChangeStrategy(strategies: Partial<ChangeStrategy>): void {
    this.changeStrategy = { ...this.changeStrategy, ...strategies };
  }

  // =================== FILE METHODS WITH DETACHED BUFFER SUPPORT ===================

  /**
   * Generate missing data summary for save operations
   */
  private _generateMissingDataSummary(): string {
    if (this.missingDataRanges.length === 0) {
      return '';
    }
    
    let summary = '';
    const header = '--- MISSING DATA SUMMARY ---\n';
    
    summary += header;
    
    for (const range of this.missingDataRanges) {
      summary += range.toDescription();
    }
    
    const footer = '--- END MISSING DATA ---\n\n';
    
    summary += footer;
    
    return summary;
  }

  /**
   * Create marker for missing data at a specific position
   */
  private _createMissingDataMarker(missingRange: MissingDataRange): string {
    const nl = '\n'; // Use newlines for readability
    
    let marker = `${nl}--- MISSING ${missingRange.size.toLocaleString()} BYTES `;
    marker += `FROM BUFFER ADDRESS ${missingRange.virtualStart.toLocaleString()} `;
    
    if (missingRange.originalFileStart !== null) {
      marker += `(ORIGINAL FILE POSITION ${missingRange.originalFileStart.toLocaleString()}) `;
    }
    
    if (missingRange.reason && missingRange.reason !== 'unknown') {
      marker += `- REASON: ${missingRange.reason.toUpperCase()} `;
    }
    
    marker += `---${nl}`;
    marker += `--- BEGIN DATA BELONGING AT BUFFER ADDRESS ${missingRange.virtualEnd.toLocaleString()} ---${nl}`;
    
    return marker;
  }

  /**
   * Create marker for missing data at end of file
   */
  private _createEndOfFileMissingMarker(lastRange: MissingDataRange, totalSize: number): string {
    const nl = '\n';
    const missingAtEnd = lastRange.virtualEnd - totalSize;
    
    if (missingAtEnd <= 0) return '';
    
    let marker = `${nl}--- MISSING ${missingAtEnd.toLocaleString()} BYTES AT END OF FILE `;
    
    if (lastRange.originalFileStart !== null) {
      const originalEnd = lastRange.originalFileEnd || (lastRange.originalFileStart + lastRange.size);
      const missingOriginalAtEnd = originalEnd - (lastRange.originalFileStart + (totalSize - lastRange.virtualStart));
      if (missingOriginalAtEnd > 0) {
        marker += `(ORIGINAL FILE BYTES ${(originalEnd - missingOriginalAtEnd).toLocaleString()} TO ${originalEnd.toLocaleString()}) `;
      }
    }
    
    if (lastRange.reason && lastRange.reason !== 'unknown') {
      marker += `- REASON: ${lastRange.reason.toUpperCase()} `;
    }
    
    marker += `---${nl}`;
    
    return marker;
  }

  /**
   * Create emergency marker for data that became unavailable during save
   */
  private _createEmergencyMissingMarker(startPos: number, endPos: number, reason: string): string {
    const nl = '\n';
    const size = endPos - startPos;
    
    let marker = `${nl}--- EMERGENCY: ${size.toLocaleString()} BYTES UNAVAILABLE DURING SAVE `;
    marker += `FROM BUFFER ADDRESS ${startPos.toLocaleString()} `;
    marker += `- REASON: ${reason.toUpperCase()} ---${nl}`;
    marker += `--- BEGIN DATA BELONGING AT BUFFER ADDRESS ${endPos.toLocaleString()} ---${nl}`;
    
    // Add this as a new missing range for future reference
    const emergencyRange = new MissingDataRange(
      startPos, 
      endPos, 
      startPos, 
      endPos, 
      `save_failure: ${reason}`
    );
    
    if (!this.missingDataRanges.some(range => 
      range.virtualStart === startPos && range.virtualEnd === endPos)) {
      this.missingDataRanges.push(emergencyRange);
      this._mergeMissingRanges();
    }
    
    return marker;
  }

  /**
   * Write data with markers indicating where missing data belongs - FIXED for large files
   */
  private async _writeDataWithMissingMarkers(fd: fs.FileHandle): Promise<void> {
    const totalSize = this.getTotalSize();
    if (totalSize === 0) return;
    
    // Calculate maximum chunk size to prevent memory issues
    const maxChunkSize = this.pageSize * this.maxMemoryPages;
    logger.debug(`Writing file with chunk size: ${maxChunkSize.toLocaleString()} bytes`);
    
    // Sort missing ranges by position for proper insertion
    const sortedMissingRanges = [...this.missingDataRanges].sort((a, b) => 
      a.virtualStart - b.virtualStart
    );
    
    let currentPos = 0;
    let missingRangeIndex = 0;
    
    while (currentPos < totalSize || missingRangeIndex < sortedMissingRanges.length) {
      // Check if we've reached a missing data range
      if (missingRangeIndex < sortedMissingRanges.length) {
        const missingRange = sortedMissingRanges[missingRangeIndex];
        
        if (currentPos === missingRange.virtualStart) {
          // Insert missing data marker
          const marker = this._createMissingDataMarker(missingRange);
          await fd.write(Buffer.from(marker));
          
          // Skip over the missing range
          currentPos = missingRange.virtualEnd;
          missingRangeIndex++;
          continue;
        }
      }
      
      // Find the next chunk boundary (either to end or to next missing range)
      let segmentEnd = totalSize;
      if (missingRangeIndex < sortedMissingRanges.length) {
        segmentEnd = Math.min(segmentEnd, sortedMissingRanges[missingRangeIndex].virtualStart);
      }
      
      if (currentPos < segmentEnd) {
        // FIXED: Write available data in chunks to prevent memory/buffer issues
        await this._writeSegmentInChunks(fd, currentPos, segmentEnd, maxChunkSize);
        currentPos = segmentEnd;
      } else {
        break;
      }
    }
    
    // Check for missing data at the end of file
    if (sortedMissingRanges.length > 0) {
      const lastRange = sortedMissingRanges[sortedMissingRanges.length - 1];
      if (lastRange.virtualEnd >= totalSize) {
        const endMarker = this._createEndOfFileMissingMarker(lastRange, totalSize);
        await fd.write(Buffer.from(endMarker));
      }
    }
  }

  /**
   * Write a segment of data in manageable chunks
   */
  private async _writeSegmentInChunks(fd: fs.FileHandle, startPos: number, endPos: number, maxChunkSize: number): Promise<void> {
    let chunkStart = startPos;
    
    while (chunkStart < endPos) {
      // Calculate this chunk's end (don't exceed segment boundary or max chunk size)
      const chunkEnd = Math.min(chunkStart + maxChunkSize, endPos);
      const chunkSize = chunkEnd - chunkStart;
      
      try {
        // Read this chunk from the virtual page manager
        const chunk = await this.virtualPageManager.readRange(chunkStart, chunkEnd);
        
        if (chunk.length > 0) {
          await fd.write(chunk);
          
          // Progress logging for large files
          if (chunkSize > 1024 * 1024) { // Log for chunks > 1MB
            const progress = ((chunkEnd - startPos) / (endPos - startPos) * 100).toFixed(1);
            logger.debug(`Written ${chunkEnd.toLocaleString()} / ${endPos.toLocaleString()} bytes (${progress}%)`);
          }
        }
        
      } catch (error) {
        // Data became unavailable during save - add an emergency marker
        logger.warn(`Data unavailable for chunk ${chunkStart}-${chunkEnd}: ${(error as Error).message}`);
        const emergencyMarker = this._createEmergencyMissingMarker(chunkStart, chunkEnd, (error as Error).message);
        await fd.write(Buffer.from(emergencyMarker));
      }
      
      chunkStart = chunkEnd;
      
      // CRITICAL: Yield control periodically to prevent event loop blocking
      if (chunkStart % (maxChunkSize * 10) === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
  }
  
  /**
   * Enhanced save method with smart behavior and atomic operations
   */
  async saveFile(filename: string | null = this.filename, options: SaveOptions = {}): Promise<void> {
    if (!filename) {
      throw new Error('No filename specified');
    }

    // CRITICAL: Check for detached buffer trying to save to original path
    if (this.state === BufferState.DETACHED) {
      const isOriginalFile = this.filename && path.resolve(filename) === path.resolve(this.filename);
      
      if (isOriginalFile && !options.forcePartialSave) {
        throw new Error(
          'Refusing to save to original file path with partial data. ' +
          `Missing ${this.missingDataRanges.length} data range(s). ` +
          'Use saveAs() to save to a different location, or pass forcePartialSave=true to override.'
        );
      }
    }

    // SMART SAVE: If saving to same file and buffer is clean with no changes, it's a no-op
    const isSameFile = this.filename && path.resolve(filename) === path.resolve(this.filename);
    if (isSameFile && this.state === BufferState.CLEAN && !this.hasUnsavedChanges && this.filename) {
      // File is unmodified and we're saving to the same location - no need to save
      this._notify(
        'save_skipped',
        'info',
        'Save skipped: buffer is unmodified',
        { filename, reason: 'unmodified_same_file' }
      );
      return;
    }

    if (isSameFile) {
      await this._performAtomicSave(filename, options);
    } else {
      await this._performSave(filename, options);
    }
  }

  /**
   * Enhanced saveAs that handles detached buffers gracefully
   */
  async saveAs(filename: string, forcePartialOrOptions: boolean | SaveOptions = {}, options: SaveOptions = {}): Promise<void> {
    if (!filename) {
      throw new Error('Filename required for saveAs operation');
    }

    let saveOptions: SaveOptions = {};
    
    if (typeof forcePartialOrOptions === 'boolean') {
      // Legacy boolean parameter - ignore it for saveAs
      saveOptions = { ...options };
    } else {
      saveOptions = { ...forcePartialOrOptions };
    }

    // saveAs always allows saving detached buffers - that's the point
    await this._performSave(filename, { ...saveOptions, allowDetached: true });
  }

  /**
   * Enhanced save method with positional missing data markers
   */
  private async _performSave(filename: string, _options: SaveOptions = {}): Promise<void> {
    const fd = await fs.open(filename, 'w');
    
    try {
      // For detached buffers, add missing data summary at the beginning
      if (this.state === BufferState.DETACHED && this.missingDataRanges.length > 0) {
        const summary = this._generateMissingDataSummary();
        await fd.write(Buffer.from(summary));
        
        this._notify(
          'detached_save_summary',
          'info',
          `Added missing data summary to saved file: ${this.missingDataRanges.length} missing range(s)`,
          { 
            filename, 
            missingRanges: this.missingDataRanges.length,
            summarySize: summary.length
          }
        );
      }
      
      // Write data with positional markers for missing ranges
      await this._writeDataWithMissingMarkers(fd);
      
    } finally {
      await fd.close();
    }
    
    // Update metadata after successful save
    const stats = await fs.stat(filename);
    this.filename = filename;
    this.fileSize = stats.size;
    this.fileMtime = stats.mtime;
    this.totalSize = this.virtualPageManager.getTotalSize(); // Keep VPM as source of truth
    
    // Mark as saved (no unsaved changes)
    this._markAsSaved();
    
    // Only mark as clean if we're not detached
    if (this.state !== BufferState.DETACHED) {
      this.state = BufferState.CLEAN;
    }
  }

  /**
   * Atomic save that uses temporary copy to prevent corruption
   */
  private async _performAtomicSave(filename: string, options: SaveOptions = {}): Promise<void> {
    let tempCopyPath: string | null = null;
    
    try {
      // Step 1: Create temporary copy of original file (if it exists and we need it)
      if (await this._fileExists(filename)) {
        tempCopyPath = await this._createTempCopy(filename);
        
        this._notify(
          'atomic_save_started',
          'info',
          `Created temporary copy for atomic save: ${tempCopyPath}`,
          { originalFile: filename, tempCopy: tempCopyPath }
        );
      }

      // Step 2: Update VPM to use temp copy for original file reads
      if (tempCopyPath) {
        this._updateVPMSourceFile(tempCopyPath);
      }

      // Step 3: Perform the actual save
      await this._performSave(filename, { ...options, isAtomicSave: true });

      // Step 4: Update metadata and state after successful save
      await this._updateMetadataAfterSave(filename);

    } catch (error) {
      // If atomic save fails, we need to restore the VPM source
      if (tempCopyPath) {
        this._updateVPMSourceFile(filename); // Restore original
      }
      throw error;
    } finally {
      // Step 5: Always cleanup temp copy
      if (tempCopyPath) {
        await this._cleanupTempCopy(tempCopyPath);
      }
    }
  }
  
  /**
   * Create a temporary copy of the original file
   */
  private async _createTempCopy(originalPath: string): Promise<string> {
    const tempDir = os.tmpdir();
    const baseName = path.basename(originalPath);
    const tempName = `paged-buffer-${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${baseName}`;
    const tempPath = path.join(tempDir, tempName);
    
    await fs.copyFile(originalPath, tempPath);
    return tempPath;
  }

  /**
   * Update VPM to use a different source file path
   */
  private _updateVPMSourceFile(newPath: string): void {
    // Update all original-type page descriptors to use the new path
    for (const descriptor of this.virtualPageManager.addressIndex.getAllPages()) {
      if (descriptor.sourceType === 'original' && descriptor.sourceInfo.filename) {
        descriptor.sourceInfo.filename = newPath;
      }
    }
    
    // Update manager's source file reference
    this.virtualPageManager.sourceFile = newPath;
  }
  
  /**
   * Cleanup temporary copy
   */
  private async _cleanupTempCopy(tempPath: string): Promise<void> {
    try {
      await fs.unlink(tempPath);
      
      this._notify(
        'temp_cleanup',
        'debug',
        `Cleaned up temporary copy: ${tempPath}`,
        { tempPath }
      );
    } catch (error) {
      // Log warning but don't fail the save
      this._notify(
        'temp_cleanup_failed',
        'warning',
        `Failed to cleanup temporary copy: ${(error as Error).message}`,
        { tempPath, error: (error as Error).message }
      );
    }
  }

  /**
   * Update metadata after successful save
   */
  private async _updateMetadataAfterSave(filename: string): Promise<void> {
    try {
      const stats = await fs.stat(filename);
      this.filename = filename;
      this.fileSize = stats.size;
      this.fileMtime = stats.mtime;
      
      // Mark as saved
      this._markAsSaved();
      
      // CRITICAL: Mark buffer as clean after successful save (unless detached)
      if (this.state !== BufferState.DETACHED) {
        this.state = BufferState.CLEAN;
      }
      
      // Update VPM source to point back to the saved file
      this._updateVPMSourceFile(filename);
      
      this._notify(
        'save_completed',
        'info',
        `Successfully saved to ${filename}`,
        { 
          filename, 
          size: stats.size, 
          newState: this.state,
          hasUnsavedChanges: this.hasUnsavedChanges,
          wasAtomic: true 
        }
      );
      
    } catch (error) {
      this._notify(
        'save_metadata_update_failed',
        'warning',
        `Save succeeded but metadata update failed: ${(error as Error).message}`,
        { filename, error: (error as Error).message }
      );
    }
  }

  /**
   * Check if file exists
   */
  private async _fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Method to manually mark buffer as clean (for testing/special cases)
   */
  _markAsClean(): void {
    if (this.state !== BufferState.DETACHED) {
      this.state = BufferState.CLEAN;
    }
    this._markAsSaved();
  }

  /**
   * Method to check if buffer has been modified
   * @deprecated Use hasChanges() instead
   */
  isModified(): boolean {
    return this.hasUnsavedChanges;
  }

  /**
   * Method to check if buffer is detached
   */
  isDetached(): boolean {
    return this.state === BufferState.DETACHED;
  }

  /**
   * Method to check if buffer is clean
   */
  isClean(): boolean {
    return this.state === BufferState.CLEAN && !this.hasUnsavedChanges;
  }

  // =================== SYNCHRONOUS LINE OPERATIONS API ===================

  /**
   * Get total number of lines in the buffer (SYNCHRONOUS)
   */
  getLineCount(): number {
    return this.lineAndMarksManager.getTotalLineCount();
  }

  /**
   * Get information about a specific line (SYNCHRONOUS)
   */
  getLineInfo(lineNumber: number): LineOperationResult | null {
    return this.lineAndMarksManager.getLineInfo(lineNumber);
  }

  /**
   * Get information about multiple lines at once (SYNCHRONOUS)
   */
  getMultipleLines(startLine: number, endLine: number): LineOperationResult[] {
    return this.lineAndMarksManager.getMultipleLines(startLine, endLine);
  }

  /**
   * Convert byte address to line number (SYNCHRONOUS)
   */
  getLineNumberFromAddress(byteAddress: number): number {
    return this.lineAndMarksManager.getLineNumberFromAddress(byteAddress);
  }

  /**
   * Convert line/character position to absolute byte position (SYNCHRONOUS)
   */
  lineCharToBytePosition(pos: LineCharPosition): number {
    return this.lineAndMarksManager.lineCharToBytePosition(pos);
  }

  /**
   * Convert absolute byte position to line/character position (SYNCHRONOUS)
   */
  byteToLineCharPosition(bytePos: number): LineCharPosition {
    return this.lineAndMarksManager.byteToLineCharPosition(bytePos);
  }

  /**
   * Ensure page containing address is loaded (ASYNC)
   */
  async seekAddress(address: number): Promise<boolean> {
    return await this.lineAndMarksManager.seekAddress(address);
  }

  // =================== CONVENIENCE LINE METHODS ===================

  /**
   * Insert content with line/character position (convenience method)
   */
  async insertTextAtPosition(pos: LineCharPosition, text: string): Promise<{ newPosition: LineCharPosition }> {
    const bytePos = this.lineCharToBytePosition(pos);
    const textBuffer = Buffer.from(text, 'utf8');
    
    await this.insertBytes(bytePos, textBuffer);
    
    const newBytePos = bytePos + textBuffer.length;
    const newPosition = this.byteToLineCharPosition(newBytePos);
    
    return { newPosition };
  }

  /**
   * Delete content between line/character positions (convenience method)
   */
  async deleteTextBetweenPositions(startPos: LineCharPosition, endPos: LineCharPosition): Promise<{ deletedText: string }> {
    const startByte = this.lineCharToBytePosition(startPos);
    const endByte = this.lineCharToBytePosition(endPos);
    
    const deletedBytes = await this.deleteBytes(startByte, endByte) as Buffer;
    const deletedText = deletedBytes.toString('utf8');
    
    return { deletedText };
  }
}

// Export the MissingDataRange class as well for testing
export { PagedBuffer, MissingDataRange, BufferState, FileChangeStrategy, NotificationType };
