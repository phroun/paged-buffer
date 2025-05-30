/**
 * @fileoverview Paged Buffer System - Enhanced with Virtual Page Manager
 * @description High-performance buffer system for handling arbitrarily large files
 * with constant memory usage, intelligent undo/redo, robust address translation,
 * and pluggable storage backends.
 * 
 * @example
 * const { PagedBuffer } = require('paged-buffer-system');
 * 
 * const buffer = new PagedBuffer();
 * buffer.enableUndo();
 * await buffer.loadFile('large-file.txt');
 * await buffer.insertBytes(100, Buffer.from('Hello'));
 * 
 * @author Jeffrey R. Day
 * @version 2.0.0
 */

const { PagedBuffer } = require('./paged-buffer');
const { BufferUndoSystem, BufferOperation, OperationGroup, OperationType } = require('./undo-system');
const { PageStorage } = require('./storage/page-storage');
const { FilePageStorage } = require('./storage/file-page-storage');
const { MemoryPageStorage } = require('./storage/memory-page-storage');
const { PageInfo } = require('./utils/page-info');
const { VirtualPageManager, PageDescriptor, PageAddressIndex } = require('./virtual-page-manager');
const { 
  BufferMode, 
  BufferState, 
  FileChangeStrategy 
} = require('./types/buffer-types');
const { 
  NotificationType, 
  BufferNotification 
} = require('./types/notifications');

module.exports = {
  // Core classes
  PagedBuffer,
  BufferUndoSystem,
  VirtualPageManager,
  
  // Storage implementations
  PageStorage,
  FilePageStorage,
  MemoryPageStorage,
  
  // Utility classes
  PageInfo,
  PageDescriptor,
  PageAddressIndex,
  BufferOperation,
  OperationGroup,
  BufferNotification,
  
  // Enums and constants
  BufferMode,
  BufferState,
  NotificationType,
  FileChangeStrategy,
  OperationType
};

// For CommonJS compatibility
module.exports.default = module.exports;
