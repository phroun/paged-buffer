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
 * Buffer data integrity state enumeration
 * @enum {string}
 */
const BufferState = {
  /** Data is intact and synchronized with source */
  CLEAN: 'clean',
  /** Some data is missing or source is unavailable, must save-as */
  DETACHED: 'detached',
  /** Serious data integrity issues detected */
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
