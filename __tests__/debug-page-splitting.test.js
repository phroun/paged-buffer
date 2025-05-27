/**
 * Debug Page Splitting - Let's understand what's actually happening
 */

const { PagedBuffer, MemoryPageStorage } = require('../src');
const { testUtils } = require('./setup');
jest.setTimeout(10000);

describe('Debug Page Splitting Issues', () => {
  
  test('should debug page splitting behavior step by step', async () => {
    const storage = new MemoryPageStorage();
    const buffer = new PagedBuffer(128, storage, 20);
    
    console.log('=== STEP 1: Load initial content ===');
    buffer.loadContent('START');
    console.log(`Initial size: ${buffer.getTotalSize()}`);
    console.log(`Initial pages: ${buffer.getMemoryStats().totalPages}`);
    
    // Check what pages look like
    const pages = Array.from(buffer.pages.values());
    console.log('Pages:', pages.map(p => ({ id: p.pageId, size: p.currentSize, dirty: p.isDirty })));
    
    console.log('\n=== STEP 2: Insert large content ===');
    const largeInsert = 'X'.repeat(300); // Should make page 305 bytes (> 256 = 2*128)
    await buffer.insertBytes(2, Buffer.from(largeInsert));
    
    console.log(`After insert size: ${buffer.getTotalSize()}`);
    console.log(`After insert pages: ${buffer.getMemoryStats().totalPages}`);
    
    const pagesAfter = Array.from(buffer.pages.values());
    console.log('Pages after:', pagesAfter.map(p => ({ 
      id: p.pageId, 
      size: p.currentSize, 
      dirty: p.isDirty,
      loaded: p.isLoaded 
    })));
    
    console.log('\n=== STEP 3: Check content integrity ===');
    const result = await buffer.getBytes(0, buffer.getTotalSize());
    console.log(`Expected: ST + ${'X'.repeat(300)} + ART`);
    console.log(`Actual start: ${result.toString().substring(0, 10)}`);
    console.log(`Actual end: ${result.toString().substring(result.length - 10)}`);
    console.log(`Full length: ${result.length}, expected: 305`);
  });

  test('should debug why undo is not working correctly', async () => {
    const storage = new MemoryPageStorage();
    const buffer = new PagedBuffer(128, storage, 20);
    buffer.enableUndo();
    
    console.log('\n=== UNDO DEBUG ===');
    console.log('Step 1: Load original content');
    buffer.loadContent('ORIGINAL');
    const originalData = await buffer.getBytes(0, buffer.getTotalSize());
    console.log(`Original: "${originalData.toString()}"`);
    
    console.log('Step 2: Insert content');
    await buffer.insertBytes(4, Buffer.from('XXXX'));
    const afterInsert = await buffer.getBytes(0, buffer.getTotalSize());
    console.log(`After insert: "${afterInsert.toString()}"`);
    
    console.log('Step 3: Check undo availability');
    console.log(`Can undo: ${buffer.canUndo()}`);
    
    if (buffer.undoSystem) {
      const stats = buffer.undoSystem.getStats();
      console.log('Undo stats:', stats);
      
      if (buffer.undoSystem.undoStack) {
        console.log('Current stack:', buffer.undoSystem.undoStack.length);
      }
    }
    
    console.log('Step 4: Perform undo');
    const undoResult = await buffer.undo();
    console.log(`Undo result: ${undoResult}`);
    
    const afterUndo = await buffer.getBytes(0, buffer.getTotalSize());
    console.log(`After undo: "${afterUndo.toString()}" (expected: "ORIGINAL")`);
    console.log(`After undo size: ${buffer.getTotalSize()} (expected: 8)`);
  });

  test('should check what happens with exact threshold values', async () => {
    const storage = new MemoryPageStorage();
    const buffer = new PagedBuffer(128, storage, 20);
    
    console.log('\n=== THRESHOLD DEBUG ===');
    buffer.loadContent('BASE');
    
    // Test exactly at 2x threshold
    const insertSize = 252; // 4 + 252 = 256 = exactly 2 * 128
    console.log(`Inserting ${insertSize} bytes to reach exactly 256 bytes (2x threshold)`);
    
    await buffer.insertBytes(2, Buffer.from('Y'.repeat(insertSize)));
    console.log(`Size after insert: ${buffer.getTotalSize()}`);
    console.log(`Pages after exact threshold: ${buffer.getMemoryStats().totalPages}`);
    
    // Add one more byte to exceed threshold
    console.log('Adding 1 more byte to exceed threshold...');
    await buffer.insertBytes(128, Buffer.from('Z'));
    console.log(`Size after +1 byte: ${buffer.getTotalSize()}`);
    console.log(`Pages after exceeding threshold: ${buffer.getMemoryStats().totalPages}`);
  });

  test('should check if splitPage is being called at all', async () => {
    const storage = new MemoryPageStorage();
    const buffer = new PagedBuffer(128, storage, 20);
    
    // Monkey patch _splitPage to see if it's called
    const originalSplitPage = buffer._splitPage;
    let splitCalled = false;
    buffer._splitPage = function(pageInfo) {
      console.log(`_splitPage called! Page size: ${pageInfo.currentSize}`);
      splitCalled = true;
      return originalSplitPage.call(this, pageInfo);
    };
    
    console.log('\n=== SPLIT DETECTION DEBUG ===');
    buffer.loadContent('TEST');
    
    // Insert way more than 2x threshold
    await buffer.insertBytes(2, Buffer.from('X'.repeat(500)));
    
    console.log(`Split was called: ${splitCalled}`);
    console.log(`Final pages: ${buffer.getMemoryStats().totalPages}`);
    console.log(`Final size: ${buffer.getTotalSize()}`);
  });

  test('should debug memory eviction', async () => {
    const storage = new MemoryPageStorage();
    const buffer = new PagedBuffer(100, storage, 2); // Very small pages, very low limit
    
    console.log('\n=== MEMORY EVICTION DEBUG ===');
    
    const content = 'X'.repeat(500); // Should create 5 pages
    buffer.loadContent(content);
    
    console.log(`Initial pages: ${buffer.getMemoryStats().totalPages}`);
    console.log(`Initial loaded: ${buffer.getMemoryStats().loadedPages}`);
    
    // Access different pages to trigger eviction
    for (let i = 0; i < 5; i++) {
      const pos = i * 100;
      console.log(`Accessing position ${pos}`);
      await buffer.getBytes(pos, pos + 10);
      
      const stats = buffer.getMemoryStats();
      console.log(`  After access ${i}: loaded=${stats.loadedPages}, total=${stats.totalPages}`);
    }
  });
});
