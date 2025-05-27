/**
 * Buffer mode enumeration
 * @enum {string}
 */
const BufferMode = {
  /** Binary mode for handling raw bytes */
  BINARY: 'binary',
  /** UTF-8 text mode with character-aware operations */
  UTF8: 'utf8'
};

/**
 * Buffer state enumeration
 * @enum {string}
 */
const BufferState = {
  /** No modifications, synced with file */
  CLEAN: 'clean',
  /** Has modifications, can still save */
  MODIFIED: 'modified',
  /** Conflicts exist, must save-as */
  DETACHED: 'detached',
  /** Serious data integrity issues */
  CORRUPTED: 'corrupted'
};

/**
 * File change detection strategies
 * @enum {string}
 */
const FileChangeStrategy = {
  /** Ignore external file changes */
  IGNORE: 'ignore',
  /** Warn user about external changes */
  WARN: 'warn',
  /** Automatically rebase changes */
  REBASE: 'rebase',
  /** Detach buffer from file */
  DETACH: 'detach'
};

module.exports = {
  BufferMode,
  BufferState,
  FileChangeStrategy
};
