# @phroun/paged-buffer

[![npm version](https://badge.fury.io/js/%40phroun%2Fpaged-buffer.svg)](https://badge.fury.io/js/%40phroun%2Fpaged-buffer)
[![Build Status](https://github.com/phroun/paged-buffer/workflows/CI/badge.svg)](https://github.com/phroun/paged-buffer/actions)
[![Coverage Status](https://coveralls.io/repos/github/phroun/paged-buffer/badge.svg?branch=main)](https://coveralls.io/github/phroun/paged-buffer?branch=main)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A high-performance, byte-level buffer system for editing massive files with intelligent memory management and undo/redo capabilities.

## Features

- **📁 Massive File Support**: Edit multi-gigabyte files with minimal memory usage
- **💾 Intelligent Memory Management**: LRU page eviction with configurable memory limits
- **↩️ Smart Undo/Redo**: Transaction-based undo with intelligent operation merging
- **🔄 File Change Handling**: Automatic detection and intelligent merging of external changes
- **⚡ High Performance**: ~6MB memory usage for 10GB files, instant loading
- **🛡️ Binary & UTF-8 Support**: Automatic mode detection with appropriate handling
- **🔔 Event Notifications**: Comprehensive notification system for monitoring operations
- **🏗️ Minimal API**: Focused byte-level operations, letting higher-level libraries handle line/character semantics

## Quick Start

```bash
npm install @phroun/paged-buffer
```

```javascript
const { PagedBuffer, FilePageStorage } = require('@phroun/paged-buffer');

// Create buffer with file-based storage
const storage = new FilePageStorage('/tmp/editor-cache');
const buffer = new PagedBuffer(64 * 1024, storage, 100);

// Load a massive file (loads instantly)
await buffer.loadFile('huge-file.txt');

// Enable undo system
buffer.enableUndo();

// Edit the file at byte level
await buffer.insertBytes(1000, Buffer.from('Hello World'));

// Use transactions for complex operations
buffer.beginUndoTransaction('Find and Replace');
await buffer.deleteBytes(2000, 2010);
await buffer.insertBytes(2000, Buffer.from('replacement'));
buffer.commitUndoTransaction();

// Undo changes
await buffer.undo(); // Undoes entire transaction

// Save changes
await buffer.saveFile();
```

## Architecture Philosophy

This library focuses on **high-performance byte-level operations** and leaves higher-level concerns to the calling application:

### **This Library Handles:**
- ✅ Byte-level file operations (`insertBytes`, `deleteBytes`, `getBytes`)
- ✅ Memory management with intelligent paging
- ✅ File change detection and conflict resolution
- ✅ Transaction-based undo/redo system
- ✅ Binary and UTF-8 file mode detection
- ✅ Minimal line information for UTF-8 files

### **Your Application Handles:**
- 🎯 Line/character positioning and conversion
- 🎯 Marks/bookmarks system with position adjustment
- 🎯 Line-based editing operations
- 🎯 Text-specific features (syntax highlighting, etc.)

## Performance Characteristics

| Operation | 10GB File | Memory Usage | Time |
|-----------|-----------|--------------|------|
| Load | ✅ | ~6MB | <2s |
| Random Access | ✅ | Per page (64KB) | <100ms |
| Large Insert | ✅ | Affected pages only | <500ms |
| Undo/Redo | ✅ | Operation delta only | <200ms |

## Core API Reference

### Buffer Operations

```javascript
// Loading and saving
await buffer.loadFile(filename, mode);    // Load file (auto-detects mode)
buffer.loadContent(string);              // Load from string
await buffer.saveFile(filename);         // Save to file
await buffer.saveAs(filename, force);    // Save detached buffer

// Reading data (byte-level)
const data = await buffer.getBytes(start, end);
const size = buffer.getTotalSize();
const mode = buffer.getMode();           // 'binary' or 'utf8'
const state = buffer.getState();        // Buffer state

// Modifying data (byte-level)
await buffer.insertBytes(position, data);
const deleted = await buffer.deleteBytes(start, end);
const original = await buffer.overwriteBytes(position, data);
```

### Line Information (UTF-8 Mode Only)

For higher-level libraries that need line/character positioning:

```javascript
// Get line start positions (byte offsets)
const lineStarts = await buffer.getLineStarts();
// Returns: [0, 15, 32, 48, ...] - byte positions where each line starts

// Get total line count
const lineCount = await buffer.getLineCount();

// Position conversion helpers
const bytePos = await buffer.lineCharToBytePosition({line: 10, character: 5}, lineStarts);
const lineChar = await buffer.byteToLineCharPosition(1500, lineStarts);

// Convenience methods for line-based operations
const result = await buffer.insertTextAtPosition({line: 10, character: 5}, 'Hello', lineStarts);
const {deletedText, newLineStarts} = await buffer.deleteTextBetweenPositions(
  {line: 5, character: 0}, 
  {line: 5, character: 10}, 
  lineStarts
);
```

### Undo/Redo System

```javascript
// Enable undo with configuration
buffer.enableUndo({
  maxUndoLevels: 1000,        // Maximum undo steps
  mergeTimeWindow: 15000,     // Merge operations within 15 seconds
  mergePositionWindow: 1000   // Merge operations within 1000 bytes
});

// Basic undo/redo
const canUndo = buffer.canUndo();
const canRedo = buffer.canRedo();
await buffer.undo();
await buffer.redo();

// Named transactions
buffer.beginUndoTransaction('Complex Operation');
// ... multiple operations ...
buffer.commitUndoTransaction();

// Transaction rollback
await buffer.rollbackUndoTransaction();

// Transaction status
const inTransaction = buffer.inUndoTransaction();
const txInfo = buffer.getCurrentUndoTransaction();
```

### File Change Handling

```javascript
// Configure change strategies
buffer.setChangeStrategy({
  noEdits: 'rebase',      // Auto-rebase if no local edits
  withEdits: 'warn',      // Warn but continue if local edits exist
  sizeChanged: 'detach'   // Always detach if file size changed
});

// Manual change detection
const changeInfo = await buffer.checkFileChanges();
const handled = await buffer.handleFileChanges(changeInfo);
```

### Storage Backends

```javascript
// File-based storage (recommended for large files)
const fileStorage = new FilePageStorage('/tmp/editor-cache');

// Memory storage (for testing/small files)
const memoryStorage = new MemoryPageStorage();

// Custom storage implementation
class CustomStorage extends PageStorage {
  async savePage(pageId, data) { /* implement */ }
  async loadPage(pageId) { /* implement */ }
  async deletePage(pageId) { /* implement */ }
  async pageExists(pageId) { /* implement */ }
}
```

## Building a Text Editor on Top

Here's how you might build line-based operations in your text editor:

```javascript
class TextEditor {
  constructor() {
    this.buffer = new PagedBuffer();
    this.lineStarts = []; // Cache for performance
    this.marks = new Map(); // Your marks implementation
  }

  async loadFile(filename) {
    await this.buffer.loadFile(filename);
    this.lineStarts = await this.buffer.getLineStarts();
  }

  async insertLine(lineNum, text) {
    const position = {line: lineNum, character: 0};
    const result = await this.buffer.insertTextAtPosition(
      position, 
      text + '\n', 
      this.lineStarts
    );
    
    // Update cached line starts
    this.lineStarts = result.newLineStarts;
    
    // Update your marks
    this.updateMarksAfterInsertion(position, [text]);
    
    return result.newPosition;
  }

  setBookmark(name, line, character) {
    this.marks.set(name, {line, character});
  }

  updateMarksAfterInsertion(insertPos, insertedLines) {
    // Your sophisticated marks adjustment logic
    for (const [name, markPos] of this.marks) {
      if (markPos.line >= insertPos.line) {
        // Adjust mark based on your rules
        markPos.line += insertedLines.length;
        this.marks.set(name, markPos);
      }
    }
  }
}
```

## Advanced Usage

### Large File Editing

```javascript
// Configure for very large files
const buffer = new PagedBuffer(
  1024 * 1024,    // 1MB pages for large files
  fileStorage,
  20              // Keep 20 pages in memory (~20MB)
);

// Monitor memory usage
const stats = buffer.getMemoryStats();
console.log(`Memory: ${stats.memoryUsed} bytes`);
console.log(`Pages: ${stats.loadedPages}/${stats.totalPages}`);
```

### Batch Operations

```javascript
// Group related operations
buffer.beginUndoTransaction('Batch Replace');

// Use lineStarts cache for efficiency
const lineStarts = await buffer.getLineStarts();

for (const {line, character, oldText, newText} of replacements) {
  const pos = {line, character};
  await buffer.deleteTextBetweenPositions(
    pos, 
    {line, character: character + oldText.length}, 
    lineStarts
  );
  await buffer.insertTextAtPosition(pos, newText, lineStarts);
}

buffer.commitUndoTransaction(); // Single undo step
```

### Error Handling

```javascript
try {
  await buffer.loadFile('massive-file.txt');
} catch (error) {
  console.error('Failed to load:', error.message);
}

// Handle detached buffers
if (buffer.getState() === 'detached') {
  await buffer.saveAs('backup-file.txt', true);
}
```

## Memory Management

The buffer uses sophisticated memory management:

- **Page-based Loading**: Only active pages are kept in memory
- **LRU Eviction**: Least recently used pages are evicted when memory limit is reached  
- **Lazy Evaluation**: Operations are deferred until actually needed
- **Delta Storage**: Undo operations store only changes, not entire content

For a 10GB file with default settings:
- **Initial Load**: ~6MB memory (metadata only)
- **Active Editing**: ~6-50MB memory (depending on access patterns)
- **Undo History**: Proportional to actual changes made

## File Change Scenarios

The buffer intelligently handles external file changes:

### Append-Only (Log Files)
```javascript
// Original file: 5GB log file
// External process appends 100MB
// Buffer detects append and merges gracefully
// Your edits preserved + new content added
```

### Conflict Resolution
```javascript
// You edit at byte position 1000
// External process edits at byte position 2000
// Buffer preserves both changes

// You edit at byte position 1000
// External process also edits at byte position 1000  
// Buffer detaches and requires manual resolution
```

## Notifications

```javascript
buffer.onNotification((notification) => {
  console.log(`${notification.severity}: ${notification.message}`);
  
  switch(notification.type) {
    case 'file_modified_on_disk':
      // Handle external file changes
      break;
    case 'undo_transaction_committed':
      // Transaction completed
      break;
    case 'buffer_detached':
      // Buffer conflicts with file
      break;
  }
});
```

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test suite
npm test -- --grep "Undo System"

# Run integration tests (requires more time/disk space)
npm test -- --grep "Integration"
```

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Make changes and add tests
4. Run tests: `npm test`
5. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Changelog

### 0.1.0
- Initial release
- Core paged buffer functionality with byte-level operations
- Transaction-based undo/redo system
- File change detection and handling
- Line information helpers for UTF-8 files
- Comprehensive test suite
- Full documentation
