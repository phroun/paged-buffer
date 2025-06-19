/**
 * @fileoverview Common types shared across the paged buffer system
 * @description Centralized type definitions to avoid duplication
 * @author Jeffrey R. Day
 * @version 1.0.0
 */

// =================== CORE BUFFER TYPES ===================

/**
 * Source information for page data
 */
export interface SourceInfo {
  filename?: string;
  fileOffset?: number;
  size?: number;
  pageKey?: string;
}

/**
 * Types of page sources
 */
export type SourceType = 'original' | 'storage' | 'memory';

/**
 * Types of buffer operations
 */
export enum OperationType {
  INSERT = 'insert',
  DELETE = 'delete',
  OVERWRITE = 'overwrite'
}

// =================== PAGE DESCRIPTOR INTERFACE ===================

/**
 * Interface for page descriptors (implemented by PageDescriptor class)
 */
export interface IPageDescriptor {
  pageKey: string;
  virtualStart: number;
  virtualSize: number;
  virtualEnd: number;
  sourceType: SourceType;
  sourceInfo: SourceInfo;
  isDirty: boolean;
  isLoaded: boolean;
  lastAccess: number;
  generation: number;
  parentKey: string | null;
  newlineCount: number;
  lineInfoCached: boolean;
  
  // Methods
  contains(virtualPos: number): boolean;
  toRelativePosition(virtualPos: number): number;
  cacheLineInfo(pageInfo: IPageInfo): void;
}

// =================== PAGE INFO INTERFACE ===================

/**
 * Interface for page information (implemented by PageInfo class)
 */
export interface IPageInfo {
  pageKey: string;
  fileOffset: number;
  originalSize: number;
  checksum: string | null;
  isDirty: boolean;
  isLoaded: boolean;
  isDetached: boolean;
  currentSize: number;
  data: Buffer | null;
  lastAccess: number;
  newlinePositions: number[];
  linesCacheValid: boolean;
  
  // Methods
  updateData(data: Buffer): void;
  ensureLineCacheValid(): void;
  getNewlineCount(): number;
  getGlobalLineStarts(pageVirtualStart: number): number[];
  updateAfterModification(offset: number, deletedBytes: number, insertedData: Buffer): void;
  verifyIntegrity(originalData: Buffer): boolean;
  getMemoryStats(): PageInfoMemoryStats;
}

// =================== VIRTUAL PAGE MANAGER INTERFACE ===================

/**
 * Interface for virtual page manager (implemented by VirtualPageManager class)
 */
export interface IVirtualPageManager {
  getTotalSize(): number;
  readRange(start: number, end: number): Promise<Buffer>;
  insertAt(position: number, data: Buffer): Promise<number>;
  deleteRange(start: number, end: number): Promise<Buffer>;
  translateAddress(virtualPos: number): Promise<TranslateAddressResult>;
  getMemoryStats(): VirtualPageManagerMemoryStats;
  
  // Address index access
  addressIndex: {
    findPageAt(virtualPos: number): IPageDescriptor | null;
    getAllPages(): IPageDescriptor[];
    pages: IPageDescriptor[];
  };
  
  // Page cache access
  pageCache: Map<string, IPageInfo>;
  
  // Optional methods (may not be available in all implementations)
  _ensurePageLoaded?(descriptor: IPageDescriptor): Promise<IPageInfo>;
}

// =================== LINE AND MARKS MANAGER INTERFACE ===================

/**
 * Interface for line and marks manager
 */
export interface ILineAndMarksManager {
  invalidateLineCaches?(): void;
  getMarksInRange(start: number, end: number): MarkTuple[];
  insertMarksFromRelative(offset: number, marks: RelativeMarkTuple[], virtualStart?: number): void;
  handlePageMerge(fromPageKey: string, toPageKey: string, insertOffset: number): void;
  getMemoryStats(): LineAndMarksManagerMemoryStats;
  clearAllMarks(): void;
  setMark(markName: string, virtualAddress: number): void;
  getAllMarks(): MarkTuple[];
  getTotalLineCount(): number;
  updateMarksAfterModification(virtualStart: number, deletedBytes: number, insertedBytes: number): void;
}

// =================== BUFFER INTERFACE ===================

/**
 * Interface for buffer operations (used by VirtualPageManager)
 */
export interface IBuffer {
  storage: {
    savePage(pageKey: string, data: Buffer): Promise<void>;
    loadPage(pageKey: string): Promise<Buffer>;
    deletePage(pageKey: string): Promise<void>;
  };
  _notify(type: string, level: string, message: string, details?: any): void;
  _markAsDetached?(reason: string, missingRanges: any[]): void;
}

// =================== OPERATION TYPES ===================

/**
 * Buffer operation descriptor
 */
export interface BufferOperation {
  type: OperationType;
  position: number;
  preExecutionPosition?: number;
  postExecutionPosition?: number | null;
  data?: Buffer | undefined;
  originalData?: Buffer | undefined;
  operationNumber: number;
}

/**
 * Operation range for distance calculations
 */
export interface OperationRange {
  start: number;
  end: number;
}

/**
 * Distance calculation options
 */
export interface DistanceCalculationOptions {
  debug?: boolean;
}

// =================== MARK TYPES ===================

/**
 * Mark tuple: [markName, absoluteAddress]
 */
export type MarkTuple = [string, number];

/**
 * Relative mark tuple: [markName, relativeAddress]
 */
export type RelativeMarkTuple = [string, number];

/**
 * Mark information for extracted content
 */
export interface MarkInfo {
  name: string;
  relativeOffset: number;
}

// =================== LINE TYPES ===================

/**
 * Line and character position
 */
export interface LineCharPosition {
  line: number;
  character: number;
}

// =================== RESULT TYPES ===================

/**
 * Result of address translation
 */
export interface TranslateAddressResult {
  page: IPageInfo;
  relativePos: number;
  descriptor: IPageDescriptor;
}

// =================== MEMORY STATS TYPES ===================

/**
 * Memory statistics for PageInfo
 */
export interface PageInfoMemoryStats {
  dataSize: number;
  newlineCount: number;
  newlinePositionsSize: number;
  marksCount: number;
  estimatedMemoryUsed: number;
  isLoaded: boolean;
  isDirty: boolean;
  linesCacheValid: boolean;
  marksValid: boolean;
}

/**
 * Memory statistics for VirtualPageManager
 */
export interface VirtualPageManagerMemoryStats {
  totalPages: number;
  loadedPages: number;
  dirtyPages: number;
  cachedLineInfoPages: number;
  memoryUsed: number;
  linesMemory: number;
  marksMemory: number;
  persistentLineMemory: number;
  virtualSize: number;
  sourceSize: number;
}

/**
 * Memory statistics for LineAndMarksManager
 */
export interface LineAndMarksManagerMemoryStats {
  globalMarksCount: number;
  pageIndexSize: number;
  totalLines: number;
  lineStartsCacheSize: number;
  lineStartsCacheValid: boolean;
  estimatedMarksMemory: number;
  estimatedLinesCacheMemory: number;
}

// =================== DEBUG TYPES ===================

/**
 * Debug information for operation distance calculations
 */
export interface OperationDistanceDebugInfo {
  firstOp: {
    type: OperationType;
    prePos: number;
    postPos: number | null;
    len: number;
  };
  secondOp: {
    type: OperationType;
    prePos: number;
    len: number;
  };
  range: OperationRange;
  distance: number;
}
