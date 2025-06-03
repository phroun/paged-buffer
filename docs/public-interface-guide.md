# PagedBuffer Public Interface Guide

## Core Setup
```javascript
const { PagedBuffer } = require('paged-buffer-system');
const buffer = new PagedBuffer(pageSize, storage, maxMemoryPages);
```

## Content Loading
```javascript
await buffer.loadFile(filename)              // Load from file
buffer.loadContent(textString)               // Load from string  
buffer.loadBinaryContent(bufferData)         // Load from Buffer
```

## File Operations (Async)
```javascript
await buffer.saveFile(filename, options)     // Save to file
await buffer.saveAs(filename, options)       // Save to new file
await buffer.checkFileChanges()              // Check for external changes
```

## Core Buffer Operations (Async)
```javascript
await buffer.getBytes(start, end, includeMarks?)     
// → Buffer | ExtractedContent
// Returns: Buffer of data, or ExtractedContent{data: Buffer, marks: [{name, relativeOffset}]}

await buffer.insertBytes(position, data, marks?)     
// → void
// Marks AT insertion point stay put, marks AFTER insertion point shift right
// Optional marks array: [{name, relativeOffset}] - marks to insert with the data

await buffer.deleteBytes(start, end, reportMarks?)  
// → Buffer | ExtractedContent  
// Marks in deleted range move to deletion start (consolidated)
// If reportMarks=true, returns info about marks that were in deleted content
// Returns: Buffer of deleted data, or ExtractedContent with data + marks report

await buffer.overwriteBytes(position, data, marks?)  
// → Buffer | ExtractedContent
// For shrinking content: marks in removed portion are consolidated to overwrite start
// For growing content: marks after overwrite region shift appropriately
// Returns: Buffer of overwritten data, or ExtractedContent with data + marks report
```

## Line Operations (Sync) 
```javascript
buffer.getLineCount()                        
// → number
// Returns: Total number of lines (minimum 1, even for empty buffer)

buffer.getLineInfo(lineNumber)               
// → LineOperationResult | null
// Returns: {lineNumber, byteStart, byteEnd, length, marks[], isExact} or null if line doesn't exist
// isExact: true = exact line bounds, false = page boundary approximation

buffer.getMultipleLines(startLine, endLine)  
// → LineOperationResult[]
// Returns: Array of LineOperationResult objects for the specified line range

buffer.getLineNumberFromAddress(byteAddr)    
// → number
// Returns: Line number (1-based) containing the byte address, or 0 if invalid address
```

## Position Conversion (Sync)
```javascript
// Note: "character" = byte offset within line (1-based)
buffer.lineCharToBytePosition({line: 2, character: 5})  // → byte position
buffer.byteToLineCharPosition(bytePos)                  // → {line, character}
```

## Page Loading (Async)
```javascript
await buffer.seekAddress(byteAddress)       
// → boolean
// Ensures page containing address is loaded, returns true if successful
// Triggers LRU eviction if memory limit exceeded
```

## Text Convenience (Async)
```javascript
await buffer.insertTextAtPosition(pos, text)
// → {newPosition: {line, character}}

await buffer.deleteTextBetweenPositions(startPos, endPos)
// → {deletedText: string}
```

## Named Marks System (Sync)

Named marks are persistent bookmarks that survive buffer modifications by automatically updating their positions.

### Basic Marks Operations
```javascript
buffer.setMark(name, byteAddress)           // Set bookmark at address
buffer.getMark(name)                        // → number | null (bookmark position)
buffer.removeMark(name)                     // → boolean (true if removed)
buffer.getAllMarks()                        // → [{name, address}] (sorted by address)
buffer.getMarksInRange(start, end)          // → [{name, address}] (marks in range)
buffer.clearAllMarks()                      // Remove all marks
```

### Marks Behavior During Operations

**Insert Operations:**
- Marks AT insertion point: Stay at insertion point
- Marks AFTER insertion point: Shift right by inserted length

**Delete Operations:**  
- Marks BEFORE deletion: Unchanged
- Marks WITHIN deletion: Move to deletion start (consolidated)
- Marks AFTER deletion: Shift left by deleted length

**Overwrite Operations:**
- Similar to delete + insert, with net position changes

### Advanced Marks Operations
```javascript
// Get marks that would be affected by deletion (for cut/paste workflows)
buffer.lineAndMarksManager.getMarksInDeletedContent(start, end)
// → [{name, relativeOffset}] - reports marks without moving them

// Actually remove marks from a range (for true cut operations)
buffer.lineAndMarksManager.removeMarksFromRange(start, end)  
// → [{name, relativeOffset}] - removes and returns marks

// Insert marks from relative positions (for paste operations)
buffer.lineAndMarksManager.insertMarksFromRelative(address, marks)
// marks: [{name, relativeOffset}]
```

### Marks Persistence
```javascript
// Export marks for saving
const marksData = buffer.getAllMarks();                    // → {markName: address, ...}

// Import marks after loading
buffer.setMarks(marksData);                               // Set marks from object

// JSON serialization
const json = JSON.stringify(buffer.getAllMarks());
buffer.clearAllMarks();
buffer.setMarks(JSON.parse(json));
```

## Undo/Redo System

The undo system automatically captures mark states and restores them during undo/redo operations.

```javascript
buffer.enableUndo(config?)                 // Enable undo
buffer.disableUndo()                       // Disable undo

// Transactions
buffer.beginUndoTransaction(name, options?)
buffer.commitUndoTransaction(finalName?)
await buffer.rollbackUndoTransaction()

// Operations  
await buffer.undo()                        // Undo last operation (restores marks)
await buffer.redo()                        // Redo last undone (restores marks)
buffer.canUndo()                          // Check if undo available
buffer.canRedo()                          // Check if redo available
```

## Status & Information (Sync)
```javascript
buffer.getTotalSize()                      // Buffer size in bytes
buffer.getState()                         // 'clean'|'detached'|'corrupted'
buffer.hasChanges()                       // Has unsaved changes
buffer.canSaveToOriginal()                // Safe to save to original file
buffer.getStatus()                        // Complete status object
buffer.getMemoryStats()                   // Memory usage info (includes marks)
buffer.getNotifications()                 // System notifications
buffer.clearNotifications(type?)          // Clear notifications
```

## Key Concepts

**Addressing**: Everything is byte-addressed. Line/character positions use bytes, not UTF-8 characters.

**Lines**: 1-based numbering. Empty buffer has 1 line. Newlines create new lines.

**Line Precision**: `getLineInfo()` returns `isExact` flag:
- `true` = exact line boundaries (page is loaded)
- `false` = page boundary approximation (page not loaded)

**Page Loading**: Use `seekAddress()` to ensure exact line information when needed.

**LineOperationResult**: Object with `{lineNumber, byteStart, byteEnd, length, marks, isExact}` providing line information.

**ExtractedContent**: Object with `{data: Buffer, marks: [{name, relativeOffset}]}` used when marks are included in operations.

**Named Marks**: Persistent bookmarks stored using page coordinates that automatically update during buffer modifications. Marks represent logical positions that survive edits.

**Mark Consolidation**: When content containing marks is deleted, marks move to the deletion start point rather than disappearing. This preserves bookmark intent during editing.

**Mark Reporting**: Delete/overwrite operations can report what marks were in affected content (for implementing cut/paste with mark preservation).

**State**: `CLEAN` (unmodified), `DETACHED` (missing source data), `CORRUPTED` (data integrity issues).

**Async vs Sync**: File I/O, buffer modifications, and page loading are async. Line operations, mark operations, and queries are sync.

## Example Usage

### Basic Editing with Marks
```javascript
const buffer = new PagedBuffer();
buffer.enableUndo();
buffer.loadContent('Line 1\nLine 2\nLine 3');

// Set bookmarks
buffer.setMark('start', 0);
buffer.setMark('line2', 7);      // Start of "Line 2"
buffer.setMark('end', 21);       // End of buffer

// Edit content - marks automatically update
await buffer.insertBytes(0, Buffer.from('# Title\n'));

// Check updated mark positions
console.log(buffer.getMark('start'));    // 0 (stayed at insertion point)
console.log(buffer.getMark('line2'));    // 15 (shifted right by 8 bytes)
console.log(buffer.getMark('end'));      // 29 (shifted right by 8 bytes)

// Undo restores both content and marks
await buffer.undo();
console.log(buffer.getMark('line2'));    // 7 (back to original position)
```

### Cut/Paste Workflow with Marks
```javascript
// Select content that contains marks for cutting
const cutStart = 7, cutEnd = 14;   // "Line 2\n"

// Report marks in content being cut
const result = await buffer.deleteBytes(cutStart, cutEnd, true);
console.log(result.marks);               // [{name: 'line2', relativeOffset: 0}]

// The mark is now consolidated at cut position
console.log(buffer.getMark('line2'));   // 7 (moved to deletion start)

// Paste elsewhere with mark restoration
const pastePos = 0;
await buffer.insertBytes(pastePos, result.data);

// Restore marks at paste location
buffer.lineAndMarksManager.insertMarksFromRelative(pastePos, result.marks);
console.log(buffer.getMark('line2'));   // 0 (at paste location)
```

### Line Operations with Page Loading
```javascript
// Quick line info (may be approximate for large files)
const lineCount = buffer.getLineCount();           // 3
const line2Info = buffer.getLineInfo(2);           // Line 2 details

// Load exact data if needed
if (!line2Info.isExact) {
  await buffer.seekAddress(line2Info.byteStart);
  const exactInfo = buffer.getLineInfo(2);         // Now exact
}

// Position conversion  
const pos = buffer.byteToLineCharPosition(10);     // {line: 2, character: 4}
const byte = buffer.lineCharToBytePosition(pos);   // 10

// Get marks within a line
const marksInLine2 = buffer.getMarksInRange(line2Info.byteStart, line2Info.byteEnd - 1);
```

### Transactions with Marks
```javascript
buffer.beginUndoTransaction('Complex Edit');

// Multiple operations
await buffer.insertBytes(0, Buffer.from('Header\n'));
buffer.setMark('header_end', 7);
await buffer.insertBytes(buffer.getTotalSize(), Buffer.from('\nFooter'));

buffer.commitUndoTransaction();

// Single undo restores everything including marks
await buffer.undo();  // All changes and marks reverted
```

## Performance Notes

- **Memory Efficient**: Marks use page coordinates, no global line cache - scales to any file size
- **Page-Based**: Only loaded pages have exact line positions
- **On-Demand Loading**: Use `seekAddress()` for precise line operations when needed
- **Fast Counting**: Line counts use page-level newline counts, not full scans
- **Mark Efficiency**: Marks are stored with page coordinates and updated only during page structure changes
- **Undo Efficiency**: Mark states are captured only when needed, not on every operation
