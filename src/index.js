/**
 * @fileoverview Enhanced Paged Buffer System with Line Tracking and Named Marks
 * @description High-performance buffer system for handling arbitrarily large files
 * with constant memory usage, intelligent undo/redo, robust address translation,
 * comprehensive line tracking, named marks support, and pluggable storage backends.
 * 
 * @example
 * const { PagedBuffer } = require('paged-buffer-system');
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

const { PagedBuffer } = require('./paged-buffer');
const { BufferUndoSystem, BufferOperation, OperationGroup, OperationType } = require('./undo-system');
const { PageStorage } = require('./storage/page-storage');
const { FilePageStorage } = require('./storage/file-page-storage');
const { MemoryPageStorage } = require('./storage/memory-page-storage');
const { PageInfo, LineInfo, MarkInfo } = require('./utils/page-info');
const { VirtualPageManager, PageDescriptor, PageAddressIndex } = require('./virtual-page-manager');
const { LineAndMarksManager, LineOperationResult, ExtractedContent } = require('./utils/line-marks-manager');
const { 
  BufferState, 
  FileChangeStrategy 
} = require('./types/buffer-types');
const { 
  NotificationType, 
  BufferNotification 
} = require('./types/notifications');
const {
  FilesystemCompatibilityTester,
  SmartStrategySelector
} = require('./utils/filesystem-compatibility-test');
const {
  SafeFileWriter,
  ModificationAnalyzer,
  SaveStrategy,
  RiskLevel
} = require('./utils/safe-file-writer');
const {
  OperationPosition,
  OperationDescriptor,
  OperationDistanceCalculator
} = require('./utils/operation-distance');

module.exports = {
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
  
  // Safe file writing
  SafeFileWriter,
  ModificationAnalyzer,
  SaveStrategy,
  RiskLevel,
  
  // Filesystem compatibility
  FilesystemCompatibilityTester,
  SmartStrategySelector,
  
  // Notifications
  BufferNotification,
  
  // Enums and constants
  BufferState,
  NotificationType,
  FileChangeStrategy
};

// For CommonJS compatibility
module.exports.default = module.exports;
