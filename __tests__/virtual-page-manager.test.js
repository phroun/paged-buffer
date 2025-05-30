/**
 * Comprehensive test suite for Virtual Page Manager
 * Uses small page sizes to thoroughly test boundary conditions
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');

// Mock the buffer dependencies since we're testing in isolation
const mockBuffer = {
  mode: 'utf8',
  storage: {
    savePage: jest.fn().mockResolvedValue(undefined),
    loadPage: jest.fn().mockImplementation((pageId) => {
      // Simulate storage with some test data
      return Promise.resolve(Buffer.from(`stored_data_for_${pageId}`));
    }),
    deletePage: jest.fn().mockResolvedValue(undefined)
  },
  _notify: jest.fn()
};

// Mock PageInfo since we need it for compatibility
const MockPageInfo = jest.fn().mockImplementation((pageId, fileOffset, originalSize) => {
  const instance = {
    pageId,
    fileOffset,
    originalSize,
    currentSize: originalSize,
    data: null,
    isDirty: false,
    isLoaded: false,
    updateData: jest.fn().mockImplementation(function(data, mode) {
      this.data = data;
      this.currentSize = data.length;
      this.isDirty = true;
      this.isLoaded = true;
    })
  };
  return instance;
});

// Mock the PageInfo module
jest.mock('../src/utils/page-info', () => ({
  PageInfo: MockPageInfo
}));

const { VirtualPageManager, PageDescriptor, PageAddressIndex } = require('../src/virtual-page-manager');

describe('PageDescriptor', () => {
  test('should create descriptor with correct properties', () => {
    const desc = new PageDescriptor('page1', 100, 50, 'original', { filename: 'test.txt' });
    
    expect(desc.pageId).toBe('page1');
    expect(desc.virtualStart).toBe(100);
    expect(desc.virtualSize).toBe(50);
    expect(desc.virtualEnd).toBe(150);
    expect(desc.sourceType).toBe('original');
    expect(desc.isDirty).toBe(false);
    expect(desc.isLoaded).toBe(false);
  });

  test('should check if position is contained', () => {
    const desc = new PageDescriptor('page1', 100, 50, 'memory', {});
    
    expect(desc.contains(99)).toBe(false);
    expect(desc.contains(100)).toBe(true);
    expect(desc.contains(125)).toBe(true);
    expect(desc.contains(149)).toBe(true);
    expect(desc.contains(150)).toBe(false);
  });

  test('should convert to relative position', () => {
    const desc = new PageDescriptor('page1', 100, 50, 'memory', {});
    
    expect(desc.toRelativePosition(100)).toBe(0);
    expect(desc.toRelativePosition(125)).toBe(25);
    expect(desc.toRelativePosition(149)).toBe(49);
    
    expect(() => desc.toRelativePosition(99)).toThrow('Position 99 not in page page1');
    expect(() => desc.toRelativePosition(150)).toThrow('Position 150 not in page page1');
  });
});

describe('PageAddressIndex', () => {
  let index;

  beforeEach(() => {
    index = new PageAddressIndex();
  });

  describe('Basic Operations', () => {
    test('should start empty', () => {
      expect(index.findPageAt(0)).toBeNull();
      expect(index.getAllPages()).toHaveLength(0);
      expect(index.totalVirtualSize).toBe(0);
    });

    test('should insert and find single page', () => {
      const page = new PageDescriptor('page1', 0, 10, 'memory', {});
      index.insertPage(page);
      
      expect(index.findPageAt(0)).toBe(page);
      expect(index.findPageAt(5)).toBe(page);
      expect(index.findPageAt(9)).toBe(page);
      expect(index.findPageAt(10)).toBeNull();
      expect(index.totalVirtualSize).toBe(10);
    });

    test('should insert pages in order', () => {
      const page1 = new PageDescriptor('page1', 0, 10, 'memory', {});
      const page2 = new PageDescriptor('page2', 10, 20, 'memory', {});
      const page3 = new PageDescriptor('page3', 30, 15, 'memory', {});
      
      // Insert out of order
      index.insertPage(page2);
      index.insertPage(page1);
      index.insertPage(page3);
      
      const allPages = index.getAllPages();
      expect(allPages).toEqual([page1, page2, page3]);
      expect(index.totalVirtualSize).toBe(45);
    });

    test('should find correct page with binary search', () => {
      // Create many small pages to test binary search
      const pages = [];
      for (let i = 0; i < 100; i++) {
        const page = new PageDescriptor(`page${i}`, i * 10, 10, 'memory', {});
        pages.push(page);
        index.insertPage(page);
      }
      
      // Test finding pages at various positions
      expect(index.findPageAt(0)).toBe(pages[0]);
      expect(index.findPageAt(155)).toBe(pages[15]);
      expect(index.findPageAt(999)).toBe(pages[99]);
      expect(index.findPageAt(1000)).toBeNull();
    });
  });

  describe('Page Modification', () => {
    test('should update page size and shift subsequent pages', () => {
      const page1 = new PageDescriptor('page1', 0, 10, 'memory', {});
      const page2 = new PageDescriptor('page2', 10, 10, 'memory', {});
      const page3 = new PageDescriptor('page3', 20, 10, 'memory', {});
      
      index.insertPage(page1);
      index.insertPage(page2);
      index.insertPage(page3);
      
      // Grow page1 by 5 bytes
      index.updatePageSize('page1', 5);
      
      expect(page1.virtualSize).toBe(15);
      expect(page1.virtualEnd).toBe(15);
      expect(page2.virtualStart).toBe(15);
      expect(page2.virtualEnd).toBe(25);
      expect(page3.virtualStart).toBe(25);
      expect(page3.virtualEnd).toBe(35);
      expect(index.totalVirtualSize).toBe(35);
    });

    test('should handle negative size changes', () => {
      const page1 = new PageDescriptor('page1', 0, 10, 'memory', {});
      const page2 = new PageDescriptor('page2', 10, 10, 'memory', {});
      
      index.insertPage(page1);
      index.insertPage(page2);
      
      // Shrink page1 by 3 bytes
      index.updatePageSize('page1', -3);
      
      expect(page1.virtualSize).toBe(7);
      expect(page2.virtualStart).toBe(7);
      expect(index.totalVirtualSize).toBe(17);
    });

    test('should remove pages', () => {
      const page1 = new PageDescriptor('page1', 0, 10, 'memory', {});
      const page2 = new PageDescriptor('page2', 10, 10, 'memory', {});
      const page3 = new PageDescriptor('page3', 20, 10, 'memory', {});
      
      index.insertPage(page1);
      index.insertPage(page2);
      index.insertPage(page3);
      
      index.removePage('page2');
      
      const allPages = index.getAllPages();
      expect(allPages).toEqual([page1, page3]);
      expect(index.totalVirtualSize).toBe(20);
    });
  });

  describe('Page Splitting', () => {
    test('should split page correctly', () => {
      const originalPage = new PageDescriptor('page1', 0, 20, 'memory', {});
      index.insertPage(originalPage);
      
      const newPage = index.splitPage('page1', 12, 'page1_split');
      
      // Original page should be first 12 bytes
      expect(originalPage.virtualStart).toBe(0);
      expect(originalPage.virtualSize).toBe(12);
      expect(originalPage.virtualEnd).toBe(12);
      
      // New page should be remaining 8 bytes
      expect(newPage.virtualStart).toBe(12);
      expect(newPage.virtualSize).toBe(8);
      expect(newPage.virtualEnd).toBe(20);
      expect(newPage.pageId).toBe('page1_split');
      expect(newPage.parentId).toBe('page1');
      expect(newPage.generation).toBe(1);
      
      // Should maintain total size
      expect(index.totalVirtualSize).toBe(20);
      
      // Should be able to find both pages
      expect(index.findPageAt(0)).toBe(originalPage);
      expect(index.findPageAt(11)).toBe(originalPage);
      expect(index.findPageAt(12)).toBe(newPage);
      expect(index.findPageAt(19)).toBe(newPage);
    });

    test('should handle splitting with subsequent pages', () => {
      const page1 = new PageDescriptor('page1', 0, 20, 'memory', {});
      const page2 = new PageDescriptor('page2', 20, 10, 'memory', {});
      
      index.insertPage(page1);
      index.insertPage(page2);
      
      const newPage = index.splitPage('page1', 15, 'page1_split');
      
      expect(page1.virtualSize).toBe(15);
      expect(newPage.virtualStart).toBe(15);
      expect(newPage.virtualSize).toBe(5);
      expect(page2.virtualStart).toBe(20); // Should remain unchanged
      expect(index.totalVirtualSize).toBe(30);
    });
  });

  describe('Range Operations', () => {
    test('should get pages in range', () => {
      const page1 = new PageDescriptor('page1', 0, 10, 'memory', {});
      const page2 = new PageDescriptor('page2', 10, 10, 'memory', {});
      const page3 = new PageDescriptor('page3', 20, 10, 'memory', {});
      
      index.insertPage(page1);
      index.insertPage(page2);
      index.insertPage(page3);
      
      // Range entirely within one page
      expect(index.getPagesInRange(2, 8)).toEqual([page1]);
      
      // Range spanning two pages
      expect(index.getPagesInRange(8, 15)).toEqual([page1, page2]);
      
      // Range spanning all pages
      expect(index.getPagesInRange(0, 30)).toEqual([page1, page2, page3]);
      
      // Range beyond all pages
      expect(index.getPagesInRange(35, 40)).toEqual([]);
      
      // Range starting before first page
      expect(index.getPagesInRange(-5, 5)).toEqual([page1]);
    });
  });

  describe('Validation', () => {
    test('should validate consistent index', () => {
      const page1 = new PageDescriptor('page1', 0, 10, 'memory', {});
      const page2 = new PageDescriptor('page2', 10, 15, 'memory', {});
      
      index.insertPage(page1);
      index.insertPage(page2);
      
      expect(() => index.validate()).not.toThrow();
    });

    test('should detect invalid virtual starts', () => {
      const page1 = new PageDescriptor('page1', 0, 10, 'memory', {});
      const page2 = new PageDescriptor('page2', 10, 10, 'memory', {});
      
      index.insertPage(page1);
      index.insertPage(page2);
      
      // Manually corrupt the index
      page2.virtualStart = 12; // Should be 10
      
      expect(() => index.validate()).toThrow('invalid virtual start');
    });

    test('should detect invalid sizes', () => {
      const page1 = new PageDescriptor('page1', 0, 0, 'memory', {});
      
      index.insertPage(page1);
      
      expect(() => index.validate()).toThrow('invalid size');
    });
  });
});

describe('VirtualPageManager', () => {
  let manager;
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vpm-test-'));
    // Use very small page size to test boundary conditions
    manager = new VirtualPageManager(mockBuffer, 16); // 16 byte pages!
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Initialization', () => {
    test('should initialize from string content', async () => {
      const content = Buffer.from('Hello World Test');
      manager.initializeFromContent(content);
      
      expect(manager.getTotalSize()).toBe(16);
      
      const stats = manager.getMemoryStats();
      expect(stats.totalPages).toBe(1);
      expect(stats.loadedPages).toBe(1);
      expect(stats.virtualSize).toBe(16);
    });

    test('should initialize from file', async () => {
      // Create test file with multiple pages worth of content
      const content = 'A'.repeat(50); // 50 bytes = ~3 pages at 16 bytes each
      const filePath = path.join(tempDir, 'test.txt');
      await fs.writeFile(filePath, content);
      
      manager.initializeFromFile(filePath, 50, 'dummy_checksum');
      
      expect(manager.getTotalSize()).toBe(50);
      
      const stats = manager.getMemoryStats();
      expect(stats.totalPages).toBe(4); // 16+16+16+2 bytes
      expect(stats.loadedPages).toBe(0); // No pages loaded yet
      expect(stats.sourceSize).toBe(50);
    });

    test('should create correct number of pages for file size', async () => {
      const content = 'X'.repeat(33); // Should create 3 pages: 16+16+1
      const filePath = path.join(tempDir, 'test.txt');
      await fs.writeFile(filePath, content);
      
      manager.initializeFromFile(filePath, 33, 'checksum');
      
      const stats = manager.getMemoryStats();
      expect(stats.totalPages).toBe(3);
    });
  });

  describe('Address Translation', () => {
    beforeEach(async () => {
      const content = Buffer.from('0123456789ABCDEF'); // Exactly 16 bytes = 1 page
      manager.initializeFromContent(content);
    });

    test('should translate addresses within single page', async () => {
      const result = await manager.translateAddress(0);
      expect(result.relativePos).toBe(0);
      expect(result.descriptor.pageId).toBeTruthy();
      
      const result2 = await manager.translateAddress(8);
      expect(result2.relativePos).toBe(8);
    });

    test('should throw for invalid addresses', async () => {
      await expect(manager.translateAddress(-1)).rejects.toThrow('No page found');
      await expect(manager.translateAddress(17)).rejects.toThrow('No page found'); // Beyond buffer size
    });

    test('should handle addresses across multiple pages', async () => {
      // Create content spanning multiple pages
      const content = Buffer.from('A'.repeat(40)); // 40 bytes = 3 pages
      manager = new VirtualPageManager(mockBuffer, 16);
      manager.initializeFromContent(content);
      
      const result1 = await manager.translateAddress(0);
      expect(result1.relativePos).toBe(0);
      
      const result2 = await manager.translateAddress(16); // Second page
      expect(result2.relativePos).toBe(0);
      
      const result3 = await manager.translateAddress(35); // Third page
      expect(result3.relativePos).toBe(3); // 35 - 32 = 3
    });
  });

  describe('Data Insertion', () => {
    beforeEach(async () => {
      const content = Buffer.from('ABCDEFGHIJKLMNOP'); // 16 bytes
      manager.initializeFromContent(content);
    });

    test('should insert at beginning', async () => {
      const inserted = await manager.insertAt(0, Buffer.from('XX'));
      expect(inserted).toBe(2);
      expect(manager.getTotalSize()).toBe(18);
      
      const result = await manager.readRange(0, 18);
      expect(result.toString()).toBe('XXABCDEFGHIJKLMNOP');
    });

    test('should insert in middle', async () => {
      await manager.insertAt(8, Buffer.from('XX'));
      expect(manager.getTotalSize()).toBe(18);
      
      const result = await manager.readRange(0, 18);
      expect(result.toString()).toBe('ABCDEFGHXXIJKLMNOP');
    });

    test('should insert at end', async () => {
      await manager.insertAt(16, Buffer.from('XX'));
      expect(manager.getTotalSize()).toBe(18);
      
      const result = await manager.readRange(0, 18);
      expect(result.toString()).toBe('ABCDEFGHIJKLMNOPXX');
    });

    test('should trigger page split when page grows too large', async () => {
      // Page size is 16, so inserting 20 bytes should trigger split at 32+ bytes
      await manager.insertAt(8, Buffer.from('X'.repeat(20)));
      
      const stats = manager.getMemoryStats();
      expect(stats.totalPages).toBe(2); // Should have split
      expect(manager.getTotalSize()).toBe(36);
      
      // Verify split notification was called
      expect(mockBuffer._notify).toHaveBeenCalledWith(
        'page_split',
        'info',
        expect.stringContaining('Split page'),
        expect.any(Object)
      );
    });

    test('should handle insertions that span multiple pages', async () => {
      // Create multi-page content first
      const content = Buffer.from('A'.repeat(40)); // 40 bytes = 3 pages
      manager = new VirtualPageManager(mockBuffer, 16);
      manager.initializeFromContent(content);
      
      // Insert across page boundary
      await manager.insertAt(15, Buffer.from('XY')); // Spans page 1/2 boundary
      
      expect(manager.getTotalSize()).toBe(42);
      const result = await manager.readRange(14, 18);
      expect(result.toString()).toBe('AXYA');
    });
  });

  describe('Data Deletion', () => {
    beforeEach(async () => {
      const content = Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ'); // 26 bytes = 2 pages
      manager.initializeFromContent(content);
    });

    test('should delete from beginning', async () => {
      const deleted = await manager.deleteRange(0, 3);
      expect(deleted.toString()).toBe('ABC');
      expect(manager.getTotalSize()).toBe(23);
      
      const result = await manager.readRange(0, 23);
      expect(result.toString()).toBe('DEFGHIJKLMNOPQRSTUVWXYZ');
    });

    test('should delete from middle', async () => {
      const deleted = await manager.deleteRange(5, 10);
      expect(deleted.toString()).toBe('FGHIJ');
      expect(manager.getTotalSize()).toBe(21);
      
      const result = await manager.readRange(0, 21);
      expect(result.toString()).toBe('ABCDEKLMNOPQRSTUVWXYZ');
    });

    test('should delete from end', async () => {
      const deleted = await manager.deleteRange(20, 26);
      expect(deleted.toString()).toBe('UVWXYZ');
      expect(manager.getTotalSize()).toBe(20);
      
      const result = await manager.readRange(0, 20);
      expect(result.toString()).toBe('ABCDEFGHIJKLMNOPQRST');
    });

    test('should delete across page boundaries', async () => {
      const deleted = await manager.deleteRange(10, 20); // Spans across pages
      expect(deleted.toString()).toBe('KLMNOPQRST');
      expect(manager.getTotalSize()).toBe(16);
      
      const result = await manager.readRange(0, 16);
      expect(result.toString()).toBe('ABCDEFGHIJUVWXYZ');
    });

    test('should clean up empty pages', async () => {
      // Delete entire first page
      await manager.deleteRange(0, 16);
      
      const stats = manager.getMemoryStats();
      expect(stats.totalPages).toBe(1); // Should have cleaned up empty page
      expect(manager.getTotalSize()).toBe(10);
    });
  });

  describe('Data Reading', () => {
    beforeEach(async () => {
      const content = Buffer.from('0123456789ABCDEFGHIJKLMNOP'); // 26 bytes
      manager.initializeFromContent(content);
    });

    test('should read single page range', async () => {
      const result = await manager.readRange(5, 10);
      expect(result.toString()).toBe('56789');
    });

    test('should read across page boundaries', async () => {
      const result = await manager.readRange(10, 20);
      expect(result.toString()).toBe('ABCDEFGHIJ');
    });

    test('should read entire buffer', async () => {
      const result = await manager.readRange(0, 26);
      expect(result.toString()).toBe('0123456789ABCDEFGHIJKLMNOP');
    });

    test('should handle empty ranges', async () => {
      const result = await manager.readRange(10, 10);
      expect(result.length).toBe(0);
    });
  });

  describe('File-based Operations', () => {
    let testFilePath;

    beforeEach(async () => {
      const content = 'The quick brown fox jumps over the lazy dog ABCDEFGHIJKLMNOP'; // 60 bytes - fixed spacing
      testFilePath = path.join(tempDir, 'test.txt');
      await fs.writeFile(testFilePath, content);
      
      manager.initializeFromFile(testFilePath, content.length, 'checksum');
    });

    test('should load pages on demand from file', async () => {
      // Initially no pages loaded
      expect(manager.getMemoryStats().loadedPages).toBe(0);
      
      // Reading should load the page
      const result = await manager.readRange(0, 16);
      expect(result.toString()).toBe('The quick brown ');
      expect(manager.getMemoryStats().loadedPages).toBe(1);
    });

    test('should load multiple pages as needed', async () => {
      // Read across multiple pages
      const result = await manager.readRange(10, 30);
      expect(result.toString()).toBe('brown fox jumps over');
      
      const stats = manager.getMemoryStats();
      expect(stats.loadedPages).toBeGreaterThan(1);
    });

    test('should handle insertions in file-based pages', async () => {
      await manager.insertAt(10, Buffer.from('XXX'));
      
      const result = await manager.readRange(8, 20);
      expect(result.toString()).toBe('k XXXbrown f');
      expect(manager.getTotalSize()).toBe(63);
    });

    test('should mark pages as dirty after modification', async () => {
      await manager.insertAt(5, Buffer.from('X'));
      
      const stats = manager.getMemoryStats();
      expect(stats.dirtyPages).toBe(1);
    });
  });

  describe('Memory Management', () => {
    beforeEach(async () => {
      // Create manager with very low memory limit
      manager = new VirtualPageManager(mockBuffer, 16);
      manager.maxLoadedPages = 2; // Only 2 pages in memory
      
      const content = Buffer.from('A'.repeat(80)); // 80 bytes = 5 pages
      manager.initializeFromContent(content);
    });

    test('should evict pages when memory limit reached', async () => {
      // Memory limit should be applied during initialization
      const initialStats = manager.getMemoryStats();
      expect(initialStats.loadedPages).toBeLessThanOrEqual(2);
      
      // Reading from different pages should maintain the limit
      await manager.readRange(0, 5);   // Page 1
      await manager.readRange(16, 21); // Page 2  
      await manager.readRange(32, 37); // Page 3 - should trigger eviction
      
      const stats = manager.getMemoryStats();
      expect(stats.loadedPages).toBeLessThanOrEqual(2);
      
      // Should have saved evicted pages to storage
      expect(mockBuffer.storage.savePage).toHaveBeenCalled();
    });

    test('should update LRU order correctly', async () => {
      // Clear any previous calls from setup
      mockBuffer.storage.savePage.mockClear();
      
      // Access pages to force specific eviction order
      await manager.readRange(0, 5);   // Access page 1
      await manager.readRange(16, 21); // Access page 2
      await manager.readRange(32, 37); // Access page 3 - should evict oldest
      
      // Should evict pages when exceeding memory limit
      expect(mockBuffer.storage.savePage).toHaveBeenCalled();
    });

    test('should reload evicted pages from storage', async () => {
      // Clear any previous calls
      mockBuffer.storage.savePage.mockClear();
      mockBuffer.storage.loadPage.mockClear();
      
      // Force eviction by accessing many pages
      await manager.readRange(0, 5);   // Page 1
      await manager.readRange(16, 21); // Page 2
      await manager.readRange(32, 37); // Page 3 - evicts page 1
      await manager.readRange(48, 53); // Page 4 - evicts page 2
      
      // Access first page again - should reload from storage
      await manager.readRange(0, 5);
      expect(mockBuffer.storage.loadPage).toHaveBeenCalled();
    });
  });

  describe('Complex Operations', () => {
    test('should handle mixed insert/delete operations', async () => {
      const content = Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
      manager.initializeFromContent(content);
      
      // Perform operations in sequence and verify each step
      // Delete middle section: ABCDE + PQRSTUVWXYZ (remove FGHIJKLMNO)
      await manager.deleteRange(5, 15);
      expect(manager.getTotalSize()).toBe(16);
      
      let result = await manager.readRange(0, 16);
      expect(result.toString()).toBe('ABCDEPQRSTUVWXYZ');
      
      // Insert at same position: ABCDE + 12345 + PQRSTUVWXYZ
      await manager.insertAt(5, Buffer.from('12345'));
      expect(manager.getTotalSize()).toBe(21);
      
      result = await manager.readRange(0, 21);
      expect(result.toString()).toBe('ABCDE12345PQRSTUVWXYZ');
    });

    test('should handle rapid insertions that cause multiple splits', async () => {
      const content = Buffer.from('BASE');
      manager.initializeFromContent(content);
      
      // Insert large amounts to trigger multiple splits
      for (let i = 0; i < 5; i++) {
        await manager.insertAt(2, Buffer.from('X'.repeat(10)));
      }
      
      const stats = manager.getMemoryStats();
      expect(stats.totalPages).toBeGreaterThan(1);
      expect(manager.getTotalSize()).toBe(54); // 4 + 50
    });

    test('should maintain data integrity across complex operations', async () => {
      const content = Buffer.from('0123456789');
      manager.initializeFromContent(content);
      
      // Step by step verification
      // Step 1: Insert ABC at position 5: 01234ABC56789
      await manager.insertAt(5, Buffer.from('ABC'));
      let result = await manager.readRange(0, manager.getTotalSize());
      expect(result.toString()).toBe('01234ABC56789');
      
      // Step 2: Delete positions 2-6 (234A): 01BC56789
      await manager.deleteRange(2, 6);
      result = await manager.readRange(0, manager.getTotalSize());
      expect(result.toString()).toBe('01BC56789');
      
      // Step 3: Insert XY at beginning: XY01BC56789
      await manager.insertAt(0, Buffer.from('XY'));
      result = await manager.readRange(0, manager.getTotalSize());
      expect(result.toString()).toBe('XY01BC56789');
      
      // Step 4: Delete from position 7 to end: XY01BC5
      const totalBeforeDelete = manager.getTotalSize();
      await manager.deleteRange(7, totalBeforeDelete);
      result = await manager.readRange(0, manager.getTotalSize());
      expect(result.toString()).toBe('XY01BC5');
    });
  });

  describe('Edge Cases', () => {
    test('should handle zero-length operations', async () => {
      const content = Buffer.from('TEST');
      manager.initializeFromContent(content);
      
      // Zero-length insert
      await manager.insertAt(2, Buffer.alloc(0));
      expect(manager.getTotalSize()).toBe(4);
      
      // Zero-length delete
      const deleted = await manager.deleteRange(2, 2);
      expect(deleted.length).toBe(0);
      expect(manager.getTotalSize()).toBe(4);
      
      // Zero-length read
      const read = await manager.readRange(2, 2);
      expect(read.length).toBe(0);
    });

    test('should handle operations at exact page boundaries', async () => {
      const content = Buffer.from('A'.repeat(32)); // Exactly 2 pages
      manager.initializeFromContent(content);
      
      // Insert at page boundary
      await manager.insertAt(16, Buffer.from('X'));
      expect(manager.getTotalSize()).toBe(33);
      
      // Delete across page boundary - delete 3 bytes: one before X, X itself, and one after
      await manager.deleteRange(15, 18);
      expect(manager.getTotalSize()).toBe(30);
      
      const result = await manager.readRange(14, 17);
      expect(result.toString()).toBe('AAA');
    });

    test('should handle single-byte operations', async () => {
      const content = Buffer.from('ABCD');
      manager.initializeFromContent(content);
      
      await manager.insertAt(2, Buffer.from('X'));
      expect(manager.getTotalSize()).toBe(5);
      
      const deleted = await manager.deleteRange(2, 3);
      expect(deleted.toString()).toBe('X');
      expect(manager.getTotalSize()).toBe(4);
      
      const result = await manager.readRange(0, 4);
      expect(result.toString()).toBe('ABCD');
    });
  });

  describe('Error Handling', () => {
    test('should handle storage errors during eviction', async () => {
      // Mock storage to fail on first save attempt
      mockBuffer.storage.savePage.mockRejectedValueOnce(new Error('Storage full'));
      
      manager = new VirtualPageManager(mockBuffer, 16);
      manager.maxLoadedPages = 1;
      
      const content = Buffer.from('A'.repeat(32)); // 2 pages
      manager.initializeFromContent(content);
      
      // This should trigger eviction and handle storage error gracefully
      await manager.readRange(0, 5);
      await manager.readRange(16, 21);
      
      // Should continue working despite storage error
      const result = await manager.readRange(16, 21);
      expect(result.toString()).toBe('AAAAA');
      
      // Should have attempted to save but may have failed gracefully
      expect(mockBuffer.storage.savePage).toHaveBeenCalled();
      
      // Should have received error notification
      expect(mockBuffer._notify).toHaveBeenCalledWith(
        'storage_error',
        'error',
        expect.stringContaining('Failed to save page'),
        expect.any(Object)
      );
    });
  });

  describe('Statistics and Monitoring', () => {
    test('should provide accurate memory statistics', async () => {
      const content = Buffer.from('A'.repeat(50));
      manager.initializeFromContent(content);
      
      // Load some pages
      await manager.readRange(0, 10);
      await manager.readRange(20, 30);
      
      const stats = manager.getMemoryStats();
      expect(stats.totalPages).toBeGreaterThan(0);
      expect(stats.loadedPages).toBeGreaterThan(0);
      expect(stats.virtualSize).toBe(50);
      expect(stats.memoryUsed).toBeGreaterThan(0);
    });

    test('should track dirty pages correctly', async () => {
      const content = Buffer.from('TEST');
      manager.initializeFromContent(content);
      
      let stats = manager.getMemoryStats();
      expect(stats.dirtyPages).toBe(1); // Content pages start dirty
      
      // Perform modification
      await manager.insertAt(2, Buffer.from('X'));
      
      stats = manager.getMemoryStats();
      expect(stats.dirtyPages).toBeGreaterThan(0);
    });
  });
});

describe('Integration Tests', () => {
  test('should handle realistic editing scenario', async () => {
    const manager = new VirtualPageManager(mockBuffer, 64); // More realistic page size
    
    // Start with document content
    const content = Buffer.from(`# Document Title

This is the first paragraph with some content.
This is the second paragraph.

## Section 2

More content here in section 2.
Final paragraph.`);
    
    manager.initializeFromContent(content);
    const originalSize = manager.getTotalSize();
    
    // Edit 1: Insert at beginning
    await manager.insertAt(0, Buffer.from('DRAFT: '));
    
    // Edit 2: Find and replace "paragraph" with "section"
    let currentContent = await manager.readRange(0, manager.getTotalSize());
    let contentStr = currentContent.toString();
    let pos = contentStr.indexOf('paragraph');
    while (pos !== -1) {
      await manager.deleteRange(pos, pos + 9);
      await manager.insertAt(pos, Buffer.from('section'));
      
      currentContent = await manager.readRange(0, manager.getTotalSize());
      contentStr = currentContent.toString();
      pos = contentStr.indexOf('paragraph', pos + 7);
    }
    
    // Edit 3: Add footer
    await manager.insertAt(manager.getTotalSize(), Buffer.from('\n\n---\nEnd of document'));
    
    const finalContent = await manager.readRange(0, manager.getTotalSize());
    const finalStr = finalContent.toString();
    
    expect(finalStr).toContain('DRAFT:');
    expect(finalStr).toContain('first section');
    expect(finalStr).toContain('second section');
    expect(finalStr).toContain('End of document');
    expect(finalStr).not.toContain('paragraph');
    
    expect(manager.getTotalSize()).toBeGreaterThan(originalSize);
  });
});
