/**
 * @fileoverview Paged Buffer System - Main Entry Point
 * @author Jeffrey R. Day
 * @version 0.1.0
 */

const { PagedBuffer } = require('./paged-buffer');
const { BufferManager } = require('./buffer-manager');
const { BufferUndoSystem, BufferOperation, OperationGroup, OperationType } = require('./undo-system');
const { PageStorage } = require('./storage/page-storage');
const { FilePageStorage } = require('./storage/file-page-storage');
const { MemoryPageStorage } = require('./storage/memory-page-storage');
const { PageInfo } = require('./utils/page-info');
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
  BufferManager,
  BufferUndoSystem,
  
  // Storage implementations
  PageStorage,
  FilePageStorage,
  MemoryPageStorage,
  
  // Utility classes
  PageInfo,
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
