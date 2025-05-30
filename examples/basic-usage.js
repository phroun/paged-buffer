#!/usr/bin/env node
/**
 * PagedBuffer Basic Usage Example - Interactive REPL
 * 
 * A simple command-line interface to learn and experiment with PagedBuffer.
 * All files are confined to the txtfiles subdirectory for safety.
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const readline = require('readline');

// Import PagedBuffer system
const { PagedBuffer, MemoryPageStorage } = require('../src/index');

// ANSI color codes
const COLORS = {
  YELLOW: '\x1b[33m',    // Bright yellow for prompts
  WHITE: '\x1b[37m',     // Bright white for user input
  TEAL: '\x1b[36m',      // Teal for notifications
  RESET: '\x1b[0m'       // Reset to normal
};

class PagedBufferREPL {
  constructor() {
    this.buffer = new PagedBuffer();
    this.txtfilesDir = null;
    this.rl = null;
    this.config = {
      pageSize: 64 * 1024,
      maxMemoryPages: 100,
      mergeTimeWindow: 5000,
      mergePositionWindow: 0
    };
  }

  async initialize() {
    // Setup txtfiles directory
    await this.setupTxtfilesDir();
    
    // Initialize buffer with current config
    this.buffer = new PagedBuffer(
      this.config.pageSize,
      new MemoryPageStorage(),
      this.config.maxMemoryPages
    );
    
    // Enable undo with current config
    this.buffer.enableUndo({
      mergeTimeWindow: this.config.mergeTimeWindow,
      mergePositionWindow: this.config.mergePositionWindow
    });

    // Setup readline interface
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    console.log('PagedBuffer Interactive REPL');
    console.log('============================');
    console.log(`Files directory: ${this.txtfilesDir}`);
    console.log('Type "help" for available commands.\n');
  }

  async setupTxtfilesDir() {
    // Try local examples/txtfiles directory first
    const localDir = path.join(process.cwd(), 'txtfiles');
    
    try {
      await fs.mkdir(localDir, { recursive: true });
      await fs.access(localDir, fs.constants.W_OK);
      this.txtfilesDir = localDir;
      return;
    } catch (error) {
      // Fall back to temp directory
      const tempDir = path.join(os.tmpdir(), 'paged-buffer-examples', 'txtfiles');
      await fs.mkdir(tempDir, { recursive: true });
      this.txtfilesDir = tempDir;
      console.log(`Note: Using temp directory for files: ${tempDir}`);
    }
  }

  getStatusLine() {
    const size = this.buffer.getTotalSize();
    const state = this.buffer.getState();
    const hasChanges = this.buffer.hasChanges();
    
    // Check for notifications
    const notifications = this.buffer.getNotifications();
    let notifStr = '';
    if (notifications.length > 0) {
      const count = notifications.length;
      const plural = count === 1 ? 'notification' : 'notifications';
      notifStr = ` ${COLORS.TEAL}(${count} ${plural} waiting)${COLORS.RESET}`;
    }
    
    return `[Size: ${size}, State: ${state}, Changes: ${hasChanges ? 'Yes' : 'No'}]${notifStr}`;
  }

  async prompt(message) {
    return new Promise((resolve) => {
      this.rl.question(`${COLORS.YELLOW}${message}${COLORS.RESET}`, (answer) => {
        resolve(answer.trim());
      });
    });
  }

  async promptMultiline(message, endMarker = 'END') {
    console.log(`${message} (type '${endMarker}' on a line by itself to finish):`);
    const lines = [];
    
    while (true) {
      const line = await this.prompt('> ');
      if (line === endMarker) break;
      lines.push(line);
    }
    
    return lines.join('\n');
  }

  validateFilename(filename) {
    // Only allow alphanumeric with .txt or .bin extensions, no leading dot
    const valid = /^[a-zA-Z0-9_-]+\.(txt|bin)$/.test(filename);
    if (!valid) {
      console.log('Error: Filename must be alphanumeric with .txt or .bin extension');
      return false;
    }
    return true;
  }

  getFilePath(filename) {
    if (!this.validateFilename(filename)) return null;
    return path.join(this.txtfilesDir, filename);
  }

  async showHelp(section = '') {
    switch (section.toLowerCase()) {
      case 'config':
        this.showConfigHelp();
        break;
      case 'files':
        this.showFilesHelp();
        break;
      case 'editing':
        this.showEditingHelp();
        break;
      case 'info':
        this.showInfoHelp();
        break;
      default:
        this.showMainHelp();
    }
  }

  showMainHelp() {
    console.log('PagedBuffer Interactive REPL');
    console.log('============================');
    console.log('');
    console.log('Quick Start - Create a Hello World file:');
    console.log('  loadContent          (type: Hello World, type END)');
    console.log('  insertText           (pos: 0, text: !)');
    console.log('  getBytes             (pos: 0, length: 100)');
    console.log('  undo');
    console.log('  insertText           (pos: 11, text: !)');
    console.log('  saveAs               (type: hello.txt)');
    console.log('');
    console.log('For more commands, type:');
    console.log('  help config    - Configuration commands');
    console.log('  help files     - File operations and loading/saving');
    console.log('  help editing   - Editing and undo/redo commands');
    console.log('  help info      - Information and status commands');
    console.log('');
    console.log('  exit           - Exit REPL');
  }

  showConfigHelp() {
    console.log('Configuration Commands:');
    console.log('======================');
    console.log('  config          - Show current configuration');
    console.log('  setPageSize     - Set page size in bytes');
    console.log('  setMaxPages     - Set max memory pages');
    console.log('  setTimeWindow   - Set undo merge time window');
    console.log('  setPosWindow    - Set undo merge position window');
  }

  showFilesHelp() {
    console.log('File Operations:');
    console.log('===============');
    console.log('Loading/Saving:');
    console.log('  loadFile        - Load file from txtfiles directory');
    console.log('  loadContent     - Load text content interactively');
    console.log('  loadBinary      - Load binary content (hex input)');
    console.log('  saveFile        - Save current buffer to original file');
    console.log('  saveAs          - Save as new file');
    console.log('  checkFileChanges - Check for external file changes');
    console.log('');
    console.log('File Management (txtfiles directory only):');
    console.log('  listFiles       - List files in txtfiles directory');
    console.log('  copyFile        - Copy file');
    console.log('  renameFile      - Rename file');
    console.log('  deleteFile      - Delete file');
    console.log('  truncateFile    - Truncate file at offset');
    console.log('  corruptFile     - Slightly corrupt file');
    console.log('  growFile        - Grow file with fill data');
  }

  showEditingHelp() {
    console.log('Editing Commands:');
    console.log('================');
    console.log('Byte Operations:');
    console.log('  getBytes        - Read bytes at position');
    console.log('  insertBytes     - Insert bytes at position (hex input)');
    console.log('  deleteBytes     - Delete bytes in range');
    console.log('  overwriteBytes  - Overwrite bytes at position (hex input)');
    console.log('');
    console.log('Text Operations:');
    console.log('  insertText      - Insert text at position');
    console.log('  deleteText      - Delete text in range');
    console.log('');
    console.log('Position Conversion (UTF-8 mode only):');
    console.log('  lineCharToBytePosition - Convert line/char to byte position');
    console.log('  byteToLineCharPosition - Convert byte position to line/char');
    console.log('');
    console.log('Undo/Redo:');
    console.log('  undo            - Undo last operation');
    console.log('  redo            - Redo last undone operation');
    console.log('  beginTx         - Begin undo transaction');
    console.log('  commitTx        - Commit undo transaction');
    console.log('  rollbackTx      - Rollback undo transaction');
  }

  showInfoHelp() {
    console.log('Information Commands:');
    console.log('====================');
    console.log('  stats           - Show memory statistics');
    console.log('  detachment      - Show detachment information');
    console.log('  notifications   - Show all notifications');
    console.log('  clearNotifs     - Clear all notifications');
  }

  async showConfig() {
    console.log('Current Configuration:');
    console.log(`  Page Size: ${this.config.pageSize} bytes`);
    console.log(`  Max Memory Pages: ${this.config.maxMemoryPages}`);
    console.log(`  Merge Time Window: ${this.config.mergeTimeWindow}ms`);
    console.log(`  Merge Position Window: ${this.config.mergePositionWindow} bytes`);
  }

  async setPageSize() {
    const size = parseInt(await this.prompt('Enter page size in bytes: '));
    if (isNaN(size) || size < 1024) {
      console.log('Error: Page size must be at least 1024 bytes');
      return;
    }
    this.config.pageSize = size;
    console.log(`Page size set to ${size} bytes (will apply to new buffer)`);
  }

  async setMaxPages() {
    const pages = parseInt(await this.prompt('Enter max memory pages: '));
    if (isNaN(pages) || pages < 1) {
      console.log('Error: Max pages must be at least 1');
      return;
    }
    this.config.maxMemoryPages = pages;
    this.buffer.virtualPageManager.maxLoadedPages = pages;
    console.log(`Max memory pages set to ${pages}`);
  }

  async setTimeWindow() {
    const time = parseInt(await this.prompt('Enter merge time window in ms: '));
    if (isNaN(time) || time < 0) {
      console.log('Error: Time window must be 0 or greater');
      return;
    }
    this.config.mergeTimeWindow = time;
    this.buffer.undoSystem.configure({ mergeTimeWindow: time });
    console.log(`Merge time window set to ${time}ms`);
  }

  async setPosWindow() {
    const pos = parseInt(await this.prompt('Enter merge position window in bytes: '));
    if (isNaN(pos) || pos < 0) {
      console.log('Error: Position window must be 0 or greater');
      return;
    }
    this.config.mergePositionWindow = pos;
    this.buffer.undoSystem.configure({ mergePositionWindow: pos });
    console.log(`Merge position window set to ${pos} bytes`);
  }

  async loadFile() {
    const filename = await this.prompt('Enter filename: ');
    const filepath = this.getFilePath(filename);
    if (!filepath) return;

    try {
      await this.buffer.loadFile(filepath);
      console.log(`Loaded file: ${filename} (${this.buffer.getTotalSize()} bytes)`);
    } catch (error) {
      console.log(`Error loading file: ${error.message}`);
    }
  }

  async loadContent() {
    const content = await this.promptMultiline('Enter text content');
    this.buffer.loadContent(content);
    console.log(`Loaded content (${this.buffer.getTotalSize()} bytes)`);
  }

  async loadBinary() {
    const hexInput = await this.promptMultiline('Enter hex content (spaces optional)');
    const hex = hexInput.replace(/\s+/g, '');
    
    if (!/^[0-9a-fA-F]*$/.test(hex)) {
      console.log('Error: Invalid hex characters');
      return;
    }
    
    if (hex.length % 2 !== 0) {
      console.log('Error: Hex string must have even number of characters');
      return;
    }

    const buffer = Buffer.from(hex, 'hex');
    this.buffer.loadBinaryContent(buffer);
    console.log(`Loaded binary content (${this.buffer.getTotalSize()} bytes)`);
  }

  async saveFile() {
    if (this.buffer.isDetached()) {
      console.log('Error: Buffer is detached, use saveAs instead');
      return;
    }
    
    try {
      await this.buffer.saveFile();
      console.log('File saved successfully');
    } catch (error) {
      console.log(`Error saving file: ${error.message}`);
    }
  }

  async saveAs() {
    const filename = await this.prompt('Enter filename: ');
    const filepath = this.getFilePath(filename);
    if (!filepath) return;

    try {
      await this.buffer.saveAs(filepath);
      console.log(`Saved as: ${filename}`);
    } catch (error) {
      console.log(`Error saving file: ${error.message}`);
    }
  }

  async checkChanges() {
    try {
      const changes = await this.buffer.checkFileChanges();
      if (changes.changed) {
        console.log('File has changed:');
        console.log(`  Size changed: ${changes.sizeChanged}`);
        console.log(`  Modified time changed: ${changes.mtimeChanged}`);
        console.log(`  File deleted: ${changes.deleted}`);
      } else {
        console.log('No external changes detected');
      }
    } catch (error) {
      console.log(`Error checking changes: ${error.message}`);
    }
  }

  parseHex(hexStr) {
    const hex = hexStr.replace(/\s+/g, '');
    if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
      throw new Error('Invalid hex format');
    }
    return Buffer.from(hex, 'hex');
  }

  async getBytes() {
    const start = parseInt(await this.prompt('Start position: '));
    const end = parseInt(await this.prompt('End position: '));
    
    if (isNaN(start) || isNaN(end) || start < 0 || end < start) {
      console.log('Error: Invalid positions');
      return;
    }

    try {
      const data = await this.buffer.getBytes(start, end);
      console.log(`Read ${data.length} bytes:`);
      console.log('Hex:', data.toString('hex'));
      console.log('Text:', data.toString('utf8').replace(/[\x00-\x1F\x7F]/g, '.'));
    } catch (error) {
      console.log(`Error reading bytes: ${error.message}`);
    }
  }

  async insertBytes() {
    const pos = parseInt(await this.prompt('Position: '));
    if (isNaN(pos) || pos < 0) {
      console.log('Error: Invalid position');
      return;
    }

    const hexData = await this.promptMultiline('Enter hex data (spaces optional)');
    
    try {
      const data = this.parseHex(hexData);
      await this.buffer.insertBytes(pos, data);
      console.log(`Inserted ${data.length} bytes at position ${pos}`);
    } catch (error) {
      console.log(`Error inserting bytes: ${error.message}`);
    }
  }

  async deleteBytes() {
    const start = parseInt(await this.prompt('Start position: '));
    const end = parseInt(await this.prompt('End position: '));
    
    if (isNaN(start) || isNaN(end) || start < 0 || end < start) {
      console.log('Error: Invalid positions');
      return;
    }

    try {
      const deleted = await this.buffer.deleteBytes(start, end);
      console.log(`Deleted ${deleted.length} bytes from ${start} to ${end}`);
    } catch (error) {
      console.log(`Error deleting bytes: ${error.message}`);
    }
  }

  async overwriteBytes() {
    const pos = parseInt(await this.prompt('Position: '));
    if (isNaN(pos) || pos < 0) {
      console.log('Error: Invalid position');
      return;
    }

    const hexData = await this.promptMultiline('Enter hex data (spaces optional)');
    
    try {
      const data = this.parseHex(hexData);
      const original = await this.buffer.overwriteBytes(pos, data);
      console.log(`Overwrote ${data.length} bytes at position ${pos}`);
      console.log(`Original data: ${original.toString('hex')}`);
    } catch (error) {
      console.log(`Error overwriting bytes: ${error.message}`);
    }
  }

  async insertText() {
    const pos = parseInt(await this.prompt('Position: '));
    if (isNaN(pos) || pos < 0) {
      console.log('Error: Invalid position');
      return;
    }

    const text = await this.prompt('Enter text: ');
    
    try {
      await this.buffer.insertBytes(pos, Buffer.from(text, 'utf8'));
      console.log(`Inserted "${text}" at position ${pos}`);
    } catch (error) {
      console.log(`Error inserting text: ${error.message}`);
    }
  }

  async deleteText() {
    const start = parseInt(await this.prompt('Start position: '));
    const end = parseInt(await this.prompt('End position: '));
    
    if (isNaN(start) || isNaN(end) || start < 0 || end < start) {
      console.log('Error: Invalid positions');
      return;
    }

    try {
      const deleted = await this.buffer.deleteBytes(start, end);
      const text = deleted.toString('utf8');
      console.log(`Deleted text: "${text}"`);
    } catch (error) {
      console.log(`Error deleting text: ${error.message}`);
    }
  }

  async lineCharToBytePosition() {
    if (this.buffer.getMode() !== 'utf8') {
      console.log('Error: Line/character positioning only available in UTF-8 mode');
      return;
    }

    const line = parseInt(await this.prompt('Line number: '));
    const character = parseInt(await this.prompt('Character offset: '));
    
    if (isNaN(line) || isNaN(character) || line < 0 || character < 0) {
      console.log('Error: Invalid line or character position');
      return;
    }

    try {
      const bytePos = await this.buffer.lineCharToBytePosition({line, character});
      console.log(`Line ${line}, character ${character} = byte position ${bytePos}`);
    } catch (error) {
      console.log(`Error converting position: ${error.message}`);
    }
  }

  async byteToLineCharPosition() {
    if (this.buffer.getMode() !== 'utf8') {
      console.log('Error: Line/character positioning only available in UTF-8 mode');
      return;
    }

    const bytePos = parseInt(await this.prompt('Byte position: '));
    
    if (isNaN(bytePos) || bytePos < 0) {
      console.log('Error: Invalid byte position');
      return;
    }

    try {
      const {line, character} = await this.buffer.byteToLineCharPosition(bytePos);
      console.log(`Byte position ${bytePos} = line ${line}, character ${character}`);
    } catch (error) {
      console.log(`Error converting position: ${error.message}`);
    }
  }

  async undo() {
    try {
      const success = await this.buffer.undo();
      console.log(success ? 'Undo successful' : 'Nothing to undo');
    } catch (error) {
      console.log(`Error during undo: ${error.message}`);
    }
  }

  async redo() {
    try {
      const success = await this.buffer.redo();
      console.log(success ? 'Redo successful' : 'Nothing to redo');
    } catch (error) {
      console.log(`Error during redo: ${error.message}`);
    }
  }

  async beginTx() {
    const name = await this.prompt('Transaction name: ');
    try {
      this.buffer.beginUndoTransaction(name);
      console.log(`Started transaction: ${name}`);
    } catch (error) {
      console.log(`Error starting transaction: ${error.message}`);
    }
  }

  async commitTx() {
    try {
      const success = this.buffer.commitUndoTransaction();
      console.log(success ? 'Transaction committed' : 'No active transaction');
    } catch (error) {
      console.log(`Error committing transaction: ${error.message}`);
    }
  }

  async rollbackTx() {
    try {
      const success = await this.buffer.rollbackUndoTransaction();
      console.log(success ? 'Transaction rolled back' : 'No active transaction');
    } catch (error) {
      console.log(`Error rolling back transaction: ${error.message}`);
    }
  }

  async showStats() {
    const stats = this.buffer.getMemoryStats();
    console.log('Memory Statistics:');
    console.log(`  Total Pages: ${stats.totalPages}`);
    console.log(`  Loaded Pages: ${stats.loadedPages}`);
    console.log(`  Dirty Pages: ${stats.dirtyPages}`);
    console.log(`  Memory Used: ${stats.memoryUsed} bytes`);
    console.log(`  Virtual Size: ${stats.virtualSize} bytes`);
    console.log(`  Source Size: ${stats.sourceSize} bytes`);
    
    if (stats.undo) {
      console.log('Undo Statistics:');
      console.log(`  Undo Groups: ${stats.undo.undoGroups}`);
      console.log(`  Redo Groups: ${stats.undo.redoGroups}`);
      console.log(`  Memory Usage: ${stats.undo.memoryUsage} bytes`);
    }
  }

  async showDetachment() {
    const info = this.buffer.getDetachmentInfo();
    if (info.isDetached) {
      console.log('Buffer Detachment Info:');
      console.log(`  Reason: ${info.reason}`);
      console.log(`  Missing Ranges: ${info.missingRanges}`);
      console.log(`  Total Missing Bytes: ${info.totalMissingBytes}`);
    } else {
      console.log('Buffer is not detached');
    }
  }

  async showNotifications() {
    const notifications = this.buffer.getNotifications();
    if (notifications.length === 0) {
      console.log('No notifications');
      return;
    }

    console.log(`Notifications (${notifications.length}):`);
    for (const notif of notifications) {
      console.log(`  [${notif.severity.toUpperCase()}] ${notif.type}: ${notif.message}`);
    }
  }

  async clearNotifications() {
    this.buffer.clearNotifications();
    console.log('Notifications cleared');
  }

  async listFiles() {
    try {
      const files = await fs.readdir(this.txtfilesDir);
      const validFiles = files.filter(f => this.validateFilename(f));
      
      if (validFiles.length === 0) {
        console.log('No files in txtfiles directory');
        return;
      }

      console.log('Files in txtfiles directory:');
      for (const file of validFiles) {
        const filepath = path.join(this.txtfilesDir, file);
        const stats = await fs.stat(filepath);
        console.log(`  ${file} (${stats.size} bytes)`);
      }
    } catch (error) {
      console.log(`Error listing files: ${error.message}`);
    }
  }

  async copyFile() {
    const source = await this.prompt('Source filename: ');
    const dest = await this.prompt('Destination filename: ');
    
    const sourcePath = this.getFilePath(source);
    const destPath = this.getFilePath(dest);
    if (!sourcePath || !destPath) return;

    try {
      await fs.copyFile(sourcePath, destPath);
      console.log(`Copied ${source} to ${dest}`);
    } catch (error) {
      console.log(`Error copying file: ${error.message}`);
    }
  }

  async renameFile() {
    const oldName = await this.prompt('Current filename: ');
    const newName = await this.prompt('New filename: ');
    
    const oldPath = this.getFilePath(oldName);
    const newPath = this.getFilePath(newName);
    if (!oldPath || !newPath) return;

    try {
      await fs.rename(oldPath, newPath);
      console.log(`Renamed ${oldName} to ${newName}`);
    } catch (error) {
      console.log(`Error renaming file: ${error.message}`);
    }
  }

  async deleteFile() {
    const filename = await this.prompt('Filename to delete: ');
    const filepath = this.getFilePath(filename);
    if (!filepath) return;

    const confirm = await this.prompt(`Delete ${filename}? (y/N): `);
    if (confirm.toLowerCase() !== 'y') {
      console.log('Delete cancelled');
      return;
    }

    try {
      await fs.unlink(filepath);
      console.log(`Deleted ${filename}`);
    } catch (error) {
      console.log(`Error deleting file: ${error.message}`);
    }
  }

  async truncateFile() {
    const filename = await this.prompt('Filename: ');
    const offset = parseInt(await this.prompt('Truncate at offset: '));
    
    if (isNaN(offset) || offset < 0) {
      console.log('Error: Invalid offset');
      return;
    }

    const filepath = this.getFilePath(filename);
    if (!filepath) return;

    try {
      const handle = await fs.open(filepath, 'r+');
      await handle.truncate(offset);
      await handle.close();
      console.log(`Truncated ${filename} at offset ${offset}`);
    } catch (error) {
      console.log(`Error truncating file: ${error.message}`);
    }
  }

  async corruptFile() {
    const filename = await this.prompt('Filename: ');
    const filepath = this.getFilePath(filename);
    if (!filepath) return;

    try {
      const data = await fs.readFile(filepath);
      if (data.length === 0) {
        console.log('Cannot corrupt empty file');
        return;
      }

      // Corrupt a random byte
      const pos = Math.floor(Math.random() * data.length);
      const original = data[pos];
      data[pos] = (original + 1) % 256;
      
      await fs.writeFile(filepath, data);
      console.log(`Corrupted ${filename} at position ${pos} (${original} -> ${data[pos]})`);
    } catch (error) {
      console.log(`Error corrupting file: ${error.message}`);
    }
  }

  async growFile() {
    const filename = await this.prompt('Filename: ');
    const size = parseInt(await this.prompt('Additional bytes: '));
    const fillType = await this.prompt('Fill with (zero/random): ');
    
    if (isNaN(size) || size < 0) {
      console.log('Error: Invalid size');
      return;
    }

    if (!['zero', 'random'].includes(fillType)) {
      console.log('Error: Fill type must be "zero" or "random"');
      return;
    }

    const filepath = this.getFilePath(filename);
    if (!filepath) return;

    try {
      const fillData = fillType === 'zero' 
        ? Buffer.alloc(size, 0)
        : Buffer.from(Array.from({length: size}, () => Math.floor(Math.random() * 256)));
      
      await fs.appendFile(filepath, fillData);
      console.log(`Grew ${filename} by ${size} bytes with ${fillType} fill`);
    } catch (error) {
      console.log(`Error growing file: ${error.message}`);
    }
  }

  async processCommand(command) {
    const parts = command.split(' ');
    const cmd = parts[0].toLowerCase();
    const arg = parts[1] || '';
    
    try {
      switch (cmd) {
        case 'help': await this.showHelp(arg); break;
        case 'config': await this.showConfig(); break;
        case 'setpagesize': await this.setPageSize(); break;
        case 'setmaxpages': await this.setMaxPages(); break;
        case 'settimewindow': await this.setTimeWindow(); break;
        case 'setposwindow': await this.setPosWindow(); break;
        case 'loadfile': await this.loadFile(); break;
        case 'loadcontent': await this.loadContent(); break;
        case 'loadbinary': await this.loadBinary(); break;
        case 'savefile': await this.saveFile(); break;
        case 'saveas': await this.saveAs(); break;
        case 'checkfilechanges': await this.checkChanges(); break;
        case 'getbytes': await this.getBytes(); break;
        case 'insertbytes': await this.insertBytes(); break;
        case 'deletebytes': await this.deleteBytes(); break;
        case 'overwritebytes': await this.overwriteBytes(); break;
        case 'inserttext': await this.insertText(); break;
        case 'deletetext': await this.deleteText(); break;
        case 'linechartobyteposition': await this.lineCharToBytePosition(); break;
        case 'bytetolinecharposition': await this.byteToLineCharPosition(); break;
        case 'undo': await this.undo(); break;
        case 'redo': await this.redo(); break;
        case 'begintx': await this.beginTx(); break;
        case 'committx': await this.commitTx(); break;
        case 'rollbacktx': await this.rollbackTx(); break;
        case 'stats': await this.showStats(); break;
        case 'detachment': await this.showDetachment(); break;
        case 'notifications': await this.showNotifications(); break;
        case 'clearnotifs': await this.clearNotifications(); break;
        case 'listfiles': await this.listFiles(); break;
        case 'copyfile': await this.copyFile(); break;
        case 'renamefile': await this.renameFile(); break;
        case 'deletefile': await this.deleteFile(); break;
        case 'truncatefile': await this.truncateFile(); break;
        case 'corruptfile': await this.corruptFile(); break;
        case 'growfile': await this.growFile(); break;
        case 'exit':
          console.log('Goodbye!');
          process.exit(0);
          break;
        default:
          console.log(`Unknown command: ${command}. Type "help" for available commands.`);
      }
    } catch (error) {
      console.log(`Command error: ${error.message}`);
    }
  }

  async run() {
    await this.initialize();
    
    while (true) {
      const status = this.getStatusLine();
      const command = await this.prompt(`${status}\nCommand: `);
      
      if (command === '') continue;
      
      await this.processCommand(command);
      console.log(''); // Empty line for readability
    }
  }
}

// Run the REPL
const repl = new PagedBufferREPL();
repl.run().catch(console.error);