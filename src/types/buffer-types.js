/**
 * Buffer mode enumeration
 */
const BufferMode = {
  BINARY: 'binary',
  UTF8: 'utf8'
};

/**
 * Buffer state enumeration
 */
const BufferState = {
  CLEAN: 'clean',           // No modifications, synced with file
  MODIFIED: 'modified',     // Has modifications, can still save
  DETACHED: 'detached',     // Conflicts exist, must save-as
  CORRUPTED: 'corrupted'    // Serious data integrity issues
};

/**
 * File change detection strategies
 */
const FileChangeStrategy = {
  IGNORE: 'ignore',
  WARN: 'warn', 
  REBASE: 'rebase',
  DETACH: 'detach'
};

module.exports = {
  BufferMode,
  BufferState, 
  FileChangeStrategy
};
