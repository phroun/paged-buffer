/**
 * @fileoverview Enhanced Paged Buffer System with Line Tracking and Named Marks
 * @description High-performance buffer system for handling arbitrarily large files
 * with constant memory usage, intelligent undo/redo, robust address translation,
 * comprehensive line tracking, named marks support, and pluggable storage backends.
 * 
 * @example
 * import { PagedBuffer } from 'paged-buffer-system';
 * 
 * const buffer = new PagedBuffer();
 * buffer.enableUndo();
 * await buffer.loadFile('large-file.txt');
 * 
 * // Basic operations
 * await buffer.insertBytes(100, Buffer.from('Hello'));
 * 
 * // Line operations
 * const lineCount = await buffer.getLineCount();
 * const lineInfo = await buffer.getLineInfo(5); // Get info about line 5
 * 
 * // Named marks
 * buffer.setMark('bookmark1', 100);
 * const bookmarkPos = buffer.getMark('bookmark1');
 * const allMarks = buffer.getAllMarks();
 * 
 * // Enhanced operations with marks
 * const result = await buffer.getBytes(0, 100, true); // Include marks
 * await buffer.insertBytes(50, Buffer.from('text'), [
 *   { name: 'mark1', relativeOffset: 0 },
 *   { name: 'mark2', relativeOffset: 4 }
 * ]);
 * 
 * @author Jeffrey R. Day
 * @version 2.2.0
 */

import { PagedBuffer } from './paged-buffer';
import { BufferOperation, OperationType } from './buffer-operation';
import { BufferUndoSystem, OperationGroup } from './undo-system';
import { PageStorage } from './storage/page-storage';
import { FilePageStorage } from './storage/file-page-storage';
import { MemoryPageStorage } from './storage/memory-page-storage';
import { PageInfo, LineInfo, MarkInfo } from './utils/page-info';
import { VirtualPageManager, PageDescriptor, PageAddressIndex } from './virtual-page-manager';
import { LineAndMarksManager, LineOperationResult, ExtractedContent } from './utils/line-marks-manager';
import { 
  BufferState, 
  FileChangeStrategy 
} from './types/buffer-types';
import { 
  NotificationType, 
  BufferNotification 
} from './types/notifications';
import {
  OperationPosition,
  OperationDescriptor,
  OperationDistanceCalculator
} from './utils/operation-distance';

// Export all the classes and types
export {
  // Core classes
  PagedBuffer,
  BufferUndoSystem,
  VirtualPageManager,
  LineAndMarksManager,
  
  // Storage implementations
  PageStorage,
  FilePageStorage,
  MemoryPageStorage,
  
  // Enhanced utility classes
  PageInfo,
  LineInfo,
  MarkInfo,
  PageDescriptor,
  PageAddressIndex,
  LineOperationResult,
  ExtractedContent,
  
  // Operation and undo system
  BufferOperation,
  OperationGroup,
  OperationType,
  
  // Operation distance calculation
  OperationPosition,
  OperationDescriptor,
  OperationDistanceCalculator,
  
  // Notifications
  BufferNotification,
  
  // Enums and constants
  BufferState,
  NotificationType,
  FileChangeStrategy
};

// Default export for convenience
export default {
  // Core classes
  PagedBuffer,
  BufferUndoSystem,
  VirtualPageManager,
  LineAndMarksManager,
  
  // Storage implementations
  PageStorage,
  FilePageStorage,
  MemoryPageStorage,
  
  // Enhanced utility classes
  PageInfo,
  LineInfo,
  MarkInfo,
  PageDescriptor,
  PageAddressIndex,
  LineOperationResult,
  ExtractedContent,
  
  // Operation and undo system
  BufferOperation,
  OperationGroup,
  OperationType,
  
  // Operation distance calculation
  OperationPosition,
  OperationDescriptor,
  OperationDistanceCalculator,
  
  // Notifications
  BufferNotification,
  
  // Enums and constants
  BufferState,
  NotificationType,
  FileChangeStrategy
};
