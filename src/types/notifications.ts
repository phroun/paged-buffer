/**
 * Notification types for buffer events
 */
export enum NotificationType {
  // File system events
  FILE_MODIFIED_ON_DISK = 'file_modified_on_disk',
  FILE_SIZE_CHANGED = 'file_size_changed',
  FILE_DELETED = 'file_deleted',

  // Save operations
  SAVE_SKIPPED = 'save_skipped',
  ATOMIC_SAVE_STARTED = 'atomic_save_started',
  SAVE_COMPLETED = 'save_completed',
  SAVE_METADATA_UPDATE_FAILED = 'save_metadata_update_failed',
  TEMP_CLEANUP = 'temp_cleanup',
  TEMP_CLEANUP_FAILED = 'temp_cleanup_failed',
  
  // Data integrity
  PARTIAL_DATA_DETECTED = 'partial_data_detected',
  EMERGENCY_MISSING_DATA = 'emergency_missing_data',
  
  // Page operations
  PAGE_SPLIT = 'page_split',
  PAGE_EVICTED = 'page_evicted',
  
  // Page conflicts
  PAGE_CONFLICT_DETECTED = 'page_conflict_detected',
  PAGE_REBASE_SUCCESS = 'page_rebase_success',
  PAGE_REBASE_FAILED = 'page_rebase_failed',
  
  // Buffer state changes
  BUFFER_DETACHED = 'buffer_detached',
  MEMORY_PRESSURE = 'memory_pressure',
  STORAGE_ERROR = 'storage_error',
  
  // Performance warnings
  LARGE_OPERATION = 'large_operation',
  SLOW_STORAGE = 'slow_storage',
  
  // Undo system events
  UNDO_TRANSACTION_STARTED = 'undo_transaction_started',
  UNDO_TRANSACTION_COMMITTED = 'undo_transaction_committed',
  UNDO_TRANSACTION_ROLLED_BACK = 'undo_transaction_rolled_back',
  UNDO_OPERATION_MERGED = 'undo_operation_merged',
  UNDO_OPERATION_RECORDED = 'undo_operation_recorded',
  UNDO_APPLIED = 'undo_applied',
  UNDO_FAILED = 'undo_failed',
  REDO_APPLIED = 'redo_applied',
  REDO_FAILED = 'redo_failed'
}

/**
 * Severity levels for notifications
 */
export type NotificationSeverity = 'info' | 'warning' | 'error' | 'critical' | 'debug';

/**
 * Metadata object for notifications
 */
export interface NotificationMetadata {
  [key: string]: any;
}

/**
 * Notification for buffer events
 */
export class BufferNotification {
  public readonly type: NotificationType;
  public readonly severity: NotificationSeverity;
  public readonly message: string;
  public readonly metadata: NotificationMetadata;
  public readonly timestamp: Date;

  /**
   * Create a buffer notification
   * @param type - Notification type from NotificationType enum
   * @param severity - Severity level
   * @param message - Human-readable message
   * @param metadata - Additional notification data
   */
  constructor(
    type: NotificationType,
    severity: NotificationSeverity,
    message: string,
    metadata: NotificationMetadata = {}
  ) {
    this.type = type;
    this.severity = severity;
    this.message = message;
    this.metadata = metadata;
    this.timestamp = new Date();
  }
}
