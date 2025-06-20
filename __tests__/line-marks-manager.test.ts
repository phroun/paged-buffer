/**
 * Comprehensive tests for the new page coordinate-based LineAndMarksManager
 * Tests marks system, line operations, and edge cases
 */

import { PagedBuffer } from '../src/paged-buffer';
import { LineAndMarksManager } from '../src/utils/line-marks-manager';
import { testUtils } from './setup';

describe('LineAndMarksManager - Page Coordinate Marks System', () => {
  let buffer: PagedBuffer;
  let lineAndMarksManager: LineAndMarksManager;

  beforeEach(() => {
    buffer = new PagedBuffer(128); // Small pages for testing page operations
    lineAndMarksManager = buffer.lineAndMarksManager;
  });

  describe('Basic Marks Operations', () => {
    beforeEach(() => {
      buffer.loadContent('Hello World\nThis is line 2\nThis is line 3\nEnd of content');
    });

    test('should set and get marks by virtual address', () => {
      // Set marks at different positions
      lineAndMarksManager.setMark('start', 0);
      lineAndMarksManager.setMark('middle', 20);
      lineAndMarksManager.setMark('end', 50);

      // Get marks back
      expect(lineAndMarksManager.getMark('start')).toBe(0);
      expect(lineAndMarksManager.getMark('middle')).toBe(20);
      expect(lineAndMarksManager.getMark('end')).toBe(50);
    });

    test('should return null for non-existent marks', () => {
      expect(lineAndMarksManager.getMark('nonexistent')).toBe(null);
    });

    test('should remove marks correctly', () => {
      lineAndMarksManager.setMark('temp', 10);
      expect(lineAndMarksManager.getMark('temp')).toBe(10);

      const removed = lineAndMarksManager.removeMark('temp');
      expect(removed).toBe(true);
      expect(lineAndMarksManager.getMark('temp')).toBe(null);

      // Try to remove again
      const removedAgain = lineAndMarksManager.removeMark('temp');
      expect(removedAgain).toBe(false);
    });

    test('should get all marks sorted by address', () => {
      lineAndMarksManager.setMark('c', 30);
      lineAndMarksManager.setMark('a', 10);
      lineAndMarksManager.setMark('b', 20);

      const allMarks = lineAndMarksManager.getAllMarks();
      expect(allMarks).toEqual([
        ['a', 10],
        ['b', 20],
        ['c', 30]
      ]);
    });

    test('should get marks in range', () => {
      lineAndMarksManager.setMark('before', 5);
      lineAndMarksManager.setMark('start', 10);
      lineAndMarksManager.setMark('middle', 15);
      lineAndMarksManager.setMark('end', 20);
      lineAndMarksManager.setMark('after', 25);

      const rangeMarks = lineAndMarksManager.getMarksInRange(10, 20);
      expect(rangeMarks).toEqual([
        [ 'start', 10 ],
        [ 'middle', 15 ],
        [ 'end', 20 ]
      ]);
    });

    test('should validate mark address bounds', () => {
      const totalSize = buffer.getTotalSize();

      // Valid positions
      expect(() => lineAndMarksManager.setMark('valid', 0)).not.toThrow();
      expect(() => lineAndMarksManager.setMark('valid_end', totalSize)).not.toThrow();

      // Invalid positions
      expect(() => lineAndMarksManager.setMark('invalid_negative', -1)).toThrow('out of range');
      expect(() => lineAndMarksManager.setMark('invalid_beyond', totalSize + 1)).toThrow('out of range');
    });
  });

  describe('Page Coordinate Storage and Conversion', () => {
    beforeEach(() => {
      // Create content spanning multiple pages
      const content = 'A'.repeat(100) + 'B'.repeat(100) + 'C'.repeat(100); // ~300 bytes, multiple 128-byte pages
      buffer.loadContent(content);
    });

    test('should store marks as page coordinates internally', () => {
      lineAndMarksManager.setMark('mark1', 50);   // First page
      lineAndMarksManager.setMark('mark2', 150);  // Second page
      lineAndMarksManager.setMark('mark3', 250);  // Third page

      // Check internal storage (accessing private members for testing)
      const globalMarks = (lineAndMarksManager as any).globalMarks;
      expect(globalMarks.size).toBe(3);

      // Each mark should be stored as [pageKey, offset]
      const mark1Coord = globalMarks.get('mark1');
      const mark2Coord = globalMarks.get('mark2');
      const mark3Coord = globalMarks.get('mark3');

      expect(Array.isArray(mark1Coord)).toBe(true);
      expect(Array.isArray(mark2Coord)).toBe(true);
      expect(Array.isArray(mark3Coord)).toBe(true);

      expect(mark1Coord.length).toBe(2); // [pageKey, offset]
      expect(mark2Coord.length).toBe(2);
      expect(mark3Coord.length).toBe(2);

      // Offsets should be reasonable for page positions
      expect(mark1Coord[1]).toBe(50);   // 50 bytes into first page
      expect(mark2Coord[1]).toBe(22);   // 150 - 128 = 22 bytes into second page
      expect(mark3Coord[1]).toBe(122);  // 250 - 128 = 122 bytes into second page (or page splits differently)
    });

    test('should convert coordinates back to virtual addresses correctly', () => {
      const positions = [0, 50, 128, 150, 200, 299];
      
      for (const pos of positions) {
        lineAndMarksManager.setMark(`mark_${pos}`, pos);
        const retrieved = lineAndMarksManager.getMark(`mark_${pos}`);
        expect(retrieved).toBe(pos);
      }
    });

    test('should maintain page index for fast lookup', () => {
      lineAndMarksManager.setMark('page1_mark', 50);
      lineAndMarksManager.setMark('page2_mark', 150);
      lineAndMarksManager.setMark('page2_mark2', 180);

      // Check page index (accessing private member for testing)
      const pageToMarks = (lineAndMarksManager as any).pageToMarks;
      expect(pageToMarks.size).toBeGreaterThan(0);

      // Should have marks distributed across pages
      let totalMarksInPages = 0;
      for (const markSet of pageToMarks.values()) {
        totalMarksInPages += markSet.size;
      }
      expect(totalMarksInPages).toBe(3);
    });
  });

  describe('Marks Updates During Buffer Modifications', () => {
    beforeEach(() => {
      buffer.loadContent('Hello World\nSecond line\nThird line');
    });

    test('should update marks after insertions', async () => {
      lineAndMarksManager.setMark('before_insert', 5);
      lineAndMarksManager.setMark('at_insert', 12);
      lineAndMarksManager.setMark('after_insert', 20);

      // Insert text at position 12
      await buffer.insertBytes(12, Buffer.from('INSERTED '));

      // Check mark positions
      expect(lineAndMarksManager.getMark('before_insert')).toBe(5);  // Unchanged
      expect(lineAndMarksManager.getMark('at_insert')).toBe(12);     // Stays at insertion point
      expect(lineAndMarksManager.getMark('after_insert')).toBe(29); // Shifted by 9 bytes ('INSERTED ')
    });

    test('should update marks after deletions', async () => {
      lineAndMarksManager.setMark('before_delete', 5);
      lineAndMarksManager.setMark('in_delete_start', 12);
      lineAndMarksManager.setMark('in_delete_middle', 15);
      lineAndMarksManager.setMark('in_delete_end', 18);
      lineAndMarksManager.setMark('after_delete', 25);

      // Delete bytes 12-20
      await buffer.deleteBytes(12, 20);

      // Check mark positions
      expect(lineAndMarksManager.getMark('before_delete')).toBe(5);   // Unchanged
      expect(lineAndMarksManager.getMark('in_delete_start')).toBe(12); // Moved to deletion start
      expect(lineAndMarksManager.getMark('in_delete_middle')).toBe(12); // Moved to deletion start
      expect(lineAndMarksManager.getMark('in_delete_end')).toBe(12);   // Moved to deletion start
      expect(lineAndMarksManager.getMark('after_delete')).toBe(17);   // Shifted by -8 bytes
    });

    test('should update marks after overwrite operations', async () => {
      lineAndMarksManager.setMark('before_overwrite', 5);
      lineAndMarksManager.setMark('at_overwrite', 12);
      lineAndMarksManager.setMark('after_overwrite', 20);

      // Overwrite 5 bytes starting at position 12
      await buffer.overwriteBytes(12, Buffer.from('XXXXX'));

      // For same-size overwrite, positions shouldn't change
      expect(lineAndMarksManager.getMark('before_overwrite')).toBe(5);
      expect(lineAndMarksManager.getMark('at_overwrite')).toBe(12);
      expect(lineAndMarksManager.getMark('after_overwrite')).toBe(20);
    });

    test('should handle complex modification sequences', async () => {
      lineAndMarksManager.setMark('anchor', 10);

      // Multiple operations
      await buffer.insertBytes(5, Buffer.from('NEW '));  // +4 bytes
      expect(lineAndMarksManager.getMark('anchor')).toBe(14);

      await buffer.deleteBytes(16, 21);                  // -5 bytes at new position
      expect(lineAndMarksManager.getMark('anchor')).toBe(14);

      await buffer.insertBytes(0, Buffer.from('START ')); // +6 bytes
      expect(lineAndMarksManager.getMark('anchor')).toBe(20);
    });
  });

  describe('Page Operations and Marks Transfer', () => {
    let largeBuff: PagedBuffer;

    beforeEach(() => {
      // Create a buffer that will definitely trigger page operations
      largeBuff = new PagedBuffer(64); // Very small pages
      const content = 'A'.repeat(50) + 'B'.repeat(50) + 'C'.repeat(50) + 'D'.repeat(50); // 200 bytes
      largeBuff.loadContent(content);
    });

    test('should handle marks during page splits', async () => {
      const lm = largeBuff.lineAndMarksManager;
      
      // Set marks that will span split boundaries
      lm.setMark('early', 10);
      lm.setMark('split_point', 64);
      lm.setMark('late', 120);

      // Force a page split by inserting large content
      const largeInsert = Buffer.from('X'.repeat(100));
      await largeBuff.insertBytes(70, largeInsert);

      // All marks should still be accessible
      expect(lm.getMark('early')).toBe(10);       // Before insertion
      expect(lm.getMark('split_point')).toBe(64); // At insertion point
      expect(lm.getMark('late')).toBe(220);       // After insertion (+100)

      // Verify they're correctly positioned in content
      const content = await largeBuff.getBytes(0, largeBuff.getTotalSize());
      expect(content[10]).toBe(0x41); // 'A'
      // Note: The exact byte at position 64 may vary due to where insertion occurred
    });

    test('should handle marks during page merging', async () => {
      const lm = largeBuff.lineAndMarksManager;
      
      // Set marks in pages that might get merged
      lm.setMark('page1', 30);
      lm.setMark('page2', 90);
      lm.setMark('page3', 150);

      // Delete content to potentially trigger merging
      await largeBuff.deleteBytes(40, 140); // Remove 100 bytes

      // Marks should be updated correctly
      expect(lm.getMark('page1')).toBe(30);  // Before deletion
      expect(lm.getMark('page2')).toBe(40);  // Moved to deletion start
      expect(lm.getMark('page3')).toBe(50);  // Shifted back by 100
    });

    test('should validate and cleanup orphaned marks', () => {
      const lm = largeBuff.lineAndMarksManager;
      
      lm.setMark('valid1', 10);
      lm.setMark('valid2', 50);
      
      // Manually create an orphaned mark by corrupting internal state
      (lm as any).globalMarks.set('orphan', ['nonexistent_page', 10]);
      (lm as any).pageToMarks.set('nonexistent_page', new Set(['orphan']));

      const orphanedMarks = lm.validateAndCleanupMarks();
      
      expect(orphanedMarks).toContain('orphan');
      expect(lm.getMark('orphan')).toBe(null);
      expect(lm.getMark('valid1')).toBe(10); // Should still exist
      expect(lm.getMark('valid2')).toBe(50); // Should still exist
    });
  });

  describe('Marks Reporting, Insertion, and Deletion', () => {
    beforeEach(() => {
      buffer.loadContent('Hello World\nSecond line\nThird line');
    });

    test('should report marks in deleted content and consolidate them', () => {
      lineAndMarksManager.setMark('before', 5);
      lineAndMarksManager.setMark('consolidate1', 12);
      lineAndMarksManager.setMark('consolidate2', 15);
      lineAndMarksManager.setMark('after', 25);

      const marksInfo = lineAndMarksManager.getMarksInDeletedContent(10, 20);

      // Should report marks that were in the range
      expect(marksInfo).toEqual([
        [ 'consolidate1', 2 ], // 12 - 10 = 2
        [ 'consolidate2', 5 ]  // 15 - 10 = 5
      ]);

      // Marks should still exist in buffer (not removed)
      expect(lineAndMarksManager.getMark('consolidate1')).toBe(12);
      expect(lineAndMarksManager.getMark('consolidate2')).toBe(15);
      expect(lineAndMarksManager.getMark('before')).toBe(5);
      expect(lineAndMarksManager.getMark('after')).toBe(25);

      // Now simulate the actual delete operation that would consolidate marks
      lineAndMarksManager.updateMarksAfterModification(10, 10, 0); // delete 10 bytes at position 10

      // After deletion, marks in deleted range should be consolidated to deletion start
      expect(lineAndMarksManager.getMark('consolidate1')).toBe(10);
      expect(lineAndMarksManager.getMark('consolidate2')).toBe(10);
      expect(lineAndMarksManager.getMark('before')).toBe(5);
      expect(lineAndMarksManager.getMark('after')).toBe(15); // shifted left by 10
    });

    test('should insert marks from relative positions', () => {
      const marks: Array<[string, number]> = [
        [ 'inserted1', 0 ],
        [ 'inserted2', 5 ],
        [ 'inserted3', 10 ]
      ];

      lineAndMarksManager.insertMarksFromRelative(20, marks);

      expect(lineAndMarksManager.getMark('inserted1')).toBe(20);
      expect(lineAndMarksManager.getMark('inserted2')).toBe(25);
      expect(lineAndMarksManager.getMark('inserted3')).toBe(30);
    });

    test('should handle mark reporting and restoration cycle correctly', () => {
      lineAndMarksManager.setMark('cycle1', 12);
      lineAndMarksManager.setMark('cycle2', 15);

      // Get marks info for later restoration (without removing marks)
      const marksInfo = lineAndMarksManager.getMarksInDeletedContent(10, 20);

      // Simulate deletion (consolidates marks to deletion start)
      lineAndMarksManager.updateMarksAfterModification(10, 10, 0);

      // Marks should now be consolidated at deletion start
      expect(lineAndMarksManager.getMark('cycle1')).toBe(10);
      expect(lineAndMarksManager.getMark('cycle2')).toBe(10);

      // Now simulate "paste" operation - restore marks at new location
      const totalSize = buffer.getTotalSize();
      const pastePos = Math.min(25, totalSize); // Ensure within bounds
      
      // First remove the consolidated marks
      lineAndMarksManager.removeMark('cycle1');
      lineAndMarksManager.removeMark('cycle2');
      
      // Then restore them at paste location using the reported info
      lineAndMarksManager.insertMarksFromRelative(pastePos, marksInfo);

      expect(lineAndMarksManager.getMark('cycle1')).toBe(pastePos + 2); // pastePos + 2
      expect(lineAndMarksManager.getMark('cycle2')).toBe(pastePos + 5); // pastePos + 5
    });

    test('should remove marks when explicitly requested', () => {
      lineAndMarksManager.setMark('remove1', 12);
      lineAndMarksManager.setMark('remove2', 15);
      lineAndMarksManager.setMark('keep', 25);

      const removed = lineAndMarksManager.removeMarksFromRange(10, 20);

      // Should return removed marks
      expect(removed).toEqual([
        [ 'remove1', 2 ],
        [ 'remove2', 5 ]
      ]);

      // Removed marks should be gone
      expect(lineAndMarksManager.getMark('remove1')).toBe(null);
      expect(lineAndMarksManager.getMark('remove2')).toBe(null);
      
      // Other marks should remain
      expect(lineAndMarksManager.getMark('keep')).toBe(25);
    });
  });

  describe('Persistence API', () => {
    beforeEach(() => {
      buffer.loadContent('Test content for persistence');
    });

    test('should export all marks for persistence', () => {
      lineAndMarksManager.setMark('bookmark1', 5);
      lineAndMarksManager.setMark('bookmark2', 15);
      lineAndMarksManager.setMark('bookmark3', 25);

      const exported = lineAndMarksManager.getAllMarksForPersistence();

      expect(exported).toEqual({
        bookmark1: 5,
        bookmark2: 15,
        bookmark3: 25
      });
    });

    test('should import marks from persistence object', () => {
      const totalSize = buffer.getTotalSize();
      const importData: Record<string, number> = {
        loaded1: 10,
        loaded2: 20,
        loaded3: Math.min(25, totalSize) // Ensure within bounds
      };

      lineAndMarksManager.setMarksFromPersistence(importData);

      expect(lineAndMarksManager.getMark('loaded1')).toBe(10);
      expect(lineAndMarksManager.getMark('loaded2')).toBe(20);
      expect(lineAndMarksManager.getMark('loaded3')).toBe(Math.min(25, totalSize));
    });

    test('should handle invalid persistence data gracefully', () => {
      const invalidData: Record<string, any> = {
        valid: 10,
        invalid_negative: -5,
        invalid_string: 'not_a_number',
        invalid_beyond: 1000
      };

      // Should not throw
      expect(() => lineAndMarksManager.setMarksFromPersistence(invalidData)).not.toThrow();

      // Valid mark should be set
      expect(lineAndMarksManager.getMark('valid')).toBe(10);

      // Invalid marks should be ignored
      expect(lineAndMarksManager.getMark('invalid_negative')).toBe(null);
      expect(lineAndMarksManager.getMark('invalid_string')).toBe(null);
      expect(lineAndMarksManager.getMark('invalid_beyond')).toBe(null);
    });

    test('should support JSON serialization roundtrip', () => {
      lineAndMarksManager.setMark('json1', 5);
      lineAndMarksManager.setMark('json2', 15);

      const exported = lineAndMarksManager.getAllMarksForPersistence();
      const jsonString = JSON.stringify(exported);
      const imported = JSON.parse(jsonString);

      lineAndMarksManager.clearAllMarks();
      expect(lineAndMarksManager.getAllMarks()).toEqual([]);

      lineAndMarksManager.setMarksFromPersistence(imported);

      expect(lineAndMarksManager.getMark('json1')).toBe(5);
      expect(lineAndMarksManager.getMark('json2')).toBe(15);
    });

    test('should clear all marks', () => {
      lineAndMarksManager.setMark('clear1', 5);
      lineAndMarksManager.setMark('clear2', 15);

      expect(lineAndMarksManager.getAllMarks().length).toBe(2);

      lineAndMarksManager.clearAllMarks();

      expect(lineAndMarksManager.getAllMarks()).toEqual([]);
      expect(lineAndMarksManager.getMark('clear1')).toBe(null);
      expect(lineAndMarksManager.getMark('clear2')).toBe(null);
    });
  });

  describe('Integration with Buffer Operations', () => {
    beforeEach(() => {
      buffer.loadContent('Hello World\nSecond line\nThird line');
    });

    test('should work with enhanced buffer operations', async () => {
      lineAndMarksManager.setMark('test_mark', 15);

      // Test with marks-aware operations
      const marks: Array<[string, number]> = [[ 'inserted_mark', 3 ]];
      await buffer.insertBytes(10, Buffer.from('NEW '), marks);

      expect(lineAndMarksManager.getMark('test_mark')).toBe(19); // Shifted by 4
      expect(lineAndMarksManager.getMark('inserted_mark')).toBe(13); // 10 + 3
    });

    test('should work with marks reporting operations', async () => {
      lineAndMarksManager.setMark('report_test', 15);

      const result = await buffer.deleteBytes(10, 20, true); // Report marks
      
      expect(result.marks).toEqual([
        [ 'report_test', 5 ] // 15 - 10 = 5
      ]);
      // Mark should be consolidated to deletion start, not removed
      expect(lineAndMarksManager.getMark('report_test')).toBe(10);
    });
  });

  describe('Line Operations (Synchronous)', () => {
    beforeEach(() => {
      buffer.loadContent('Line 1\nLine 2\nLine 3\n');
    });

    test('should get total line count correctly', () => {
      expect(lineAndMarksManager.getTotalLineCount()).toBe(4); // 3 lines + final empty line
    });

    test('should get line info for specific lines', () => {
      const line1 = lineAndMarksManager.getLineInfo(1);
      const line2 = lineAndMarksManager.getLineInfo(2);
      const line3 = lineAndMarksManager.getLineInfo(3);

      expect(line1?.lineNumber).toBe(1);
      expect(line1?.byteStart).toBe(0);
      expect(line1?.byteEnd).toBe(7); // "Line 1\n"

      expect(line2?.lineNumber).toBe(2);
      expect(line2?.byteStart).toBe(7);
      expect(line2?.byteEnd).toBe(14); // "Line 2\n"

      expect(line3?.lineNumber).toBe(3);
      expect(line3?.byteStart).toBe(14);
      expect(line3?.byteEnd).toBe(21); // "Line 3\n"
    });

    test('should convert addresses to line numbers', () => {
      expect(lineAndMarksManager.getLineNumberFromAddress(0)).toBe(1);
      expect(lineAndMarksManager.getLineNumberFromAddress(6)).toBe(1);
      expect(lineAndMarksManager.getLineNumberFromAddress(7)).toBe(2);
      expect(lineAndMarksManager.getLineNumberFromAddress(14)).toBe(3);
      expect(lineAndMarksManager.getLineNumberFromAddress(21)).toBe(4);
    });

    test('should convert line/character positions', () => {
      // Test line/char to byte position
      expect(lineAndMarksManager.lineCharToBytePosition({line: 1, character: 1})).toBe(0);
      expect(lineAndMarksManager.lineCharToBytePosition({line: 1, character: 5})).toBe(4);
      expect(lineAndMarksManager.lineCharToBytePosition({line: 2, character: 1})).toBe(7);

      // Test byte to line/char position
      expect(lineAndMarksManager.byteToLineCharPosition(0)).toEqual({line: 1, character: 1});
      expect(lineAndMarksManager.byteToLineCharPosition(4)).toEqual({line: 1, character: 5});
      expect(lineAndMarksManager.byteToLineCharPosition(7)).toEqual({line: 2, character: 1});
    });

    test('should get multiple lines at once', () => {
      const lines = lineAndMarksManager.getMultipleLines(1, 3);

      expect(lines.length).toBe(3);
      expect(lines[0]?.lineNumber).toBe(1);
      expect(lines[1]?.lineNumber).toBe(2);
      expect(lines[2]?.lineNumber).toBe(3);
    });

    test('should include marks in line info', () => {
      lineAndMarksManager.setMark('line1_mark', 3);
      lineAndMarksManager.setMark('line2_mark', 10);

      const line1 = lineAndMarksManager.getLineInfo(1);
      const line2 = lineAndMarksManager.getLineInfo(2);

      expect(line1?.marks).toContainEqual([ 'line1_mark', 3 ]);
      expect(line2?.marks).toContainEqual([ 'line2_mark', 10 ]);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    test('should handle empty content', () => {
      buffer.loadContent('');
      
      expect(lineAndMarksManager.getTotalLineCount()).toBe(1);
      expect(lineAndMarksManager.getLineInfo(1)).toBeTruthy();
      expect(lineAndMarksManager.getLineInfo(1)?.byteStart).toBe(0);
      expect(lineAndMarksManager.getLineInfo(1)?.byteEnd).toBe(0);
    });

    test('should handle single character content', () => {
      buffer.loadContent('A');
      
      expect(lineAndMarksManager.getTotalLineCount()).toBe(1);
      
      lineAndMarksManager.setMark('single', 0);
      expect(lineAndMarksManager.getMark('single')).toBe(0);
    });

    test('should handle content with only newlines', () => {
      buffer.loadContent('\n\n\n');
      
      expect(lineAndMarksManager.getTotalLineCount()).toBe(4); // 3 newlines create 4 lines
    });

    test('should handle marks at exact page boundaries', () => {
      // Create content that aligns with page boundaries
      const pageSize = 128;
      const content = 'A'.repeat(pageSize) + 'B'.repeat(pageSize);
      buffer.loadContent(content);

      // Set marks at exact page boundaries
      lineAndMarksManager.setMark('page_start', 0);
      lineAndMarksManager.setMark('page_boundary', pageSize);
      lineAndMarksManager.setMark('page_end', pageSize * 2);

      expect(lineAndMarksManager.getMark('page_start')).toBe(0);
      expect(lineAndMarksManager.getMark('page_boundary')).toBe(pageSize);
      expect(lineAndMarksManager.getMark('page_end')).toBe(pageSize * 2);
    });

    test('should handle invalid line numbers gracefully', () => {
      buffer.loadContent('Line 1\nLine 2');

      expect(lineAndMarksManager.getLineInfo(0)).toBe(null);
      expect(lineAndMarksManager.getLineInfo(-1)).toBe(null);
      expect(lineAndMarksManager.getLineInfo(10)).toBe(null);
    });

    test('should handle invalid address ranges', () => {
      buffer.loadContent('Test content');

      expect(lineAndMarksManager.getLineNumberFromAddress(-1)).toBe(0);
      expect(lineAndMarksManager.getLineNumberFromAddress(1000)).toBe(0); // Changed expectation
    });

    test('should handle unicode content correctly', () => {
      const unicode = 'Hello 🌍 World! 🚀\nSecond line with émojis 😊';
      buffer.loadContent(unicode);

      const expectedSize = Buffer.byteLength(unicode, 'utf8');
      expect(buffer.getTotalSize()).toBe(expectedSize);

      // Set marks in unicode content
      lineAndMarksManager.setMark('start', 0);
      lineAndMarksManager.setMark('emoji', 6); // Should be at the 🌍
      lineAndMarksManager.setMark('newline', unicode.indexOf('\n'));

      expect(lineAndMarksManager.getMark('start')).toBe(0);
      expect(lineAndMarksManager.getMark('emoji')).toBe(6);
      expect(lineAndMarksManager.getMark('newline')).toBe(unicode.indexOf('\n'));
    });

    test('should handle rapid mark updates correctly', () => {
      buffer.loadContent('Rapid update test content');

      // Set many marks quickly at different positions
      for (let i = 0; i < 100; i++) {
        lineAndMarksManager.setMark(`rapid_${i}`, i % 20);
      }

      // Verify they're all there (last one wins for each position)
      expect(lineAndMarksManager.getAllMarks().length).toBe(100); // All 100 marks, not just 20 unique positions

      // Remove them quickly
      for (let i = 0; i < 100; i++) {
        lineAndMarksManager.removeMark(`rapid_${i}`);
      }

      expect(lineAndMarksManager.getAllMarks().length).toBe(0);
    });
  });

  describe('Memory and Performance', () => {
    test('should provide accurate memory statistics', () => {
      buffer.loadContent('Memory test content');
      
      lineAndMarksManager.setMark('mem1', 5);
      lineAndMarksManager.setMark('mem2', 10);
      lineAndMarksManager.setMark('mem3', 15);

      const stats = lineAndMarksManager.getMemoryStats();

      expect(stats.globalMarksCount).toBe(3);
      expect(stats.pageIndexSize).toBeGreaterThan(0);
      expect(stats.estimatedMarksMemory).toBeGreaterThan(0);
      expect(typeof stats.estimatedMarksMemory).toBe('number');
    });

    test('should handle large numbers of marks efficiently', () => {
      const content = 'A'.repeat(1000);
      buffer.loadContent(content);

      const startTime = Date.now();

      // Add 1000 marks
      for (let i = 0; i < 1000; i++) {
        lineAndMarksManager.setMark(`mark_${i}`, i);
      }

      const addTime = Date.now() - startTime;

      // Retrieve all marks
      const retrieveStart = Date.now();
      for (let i = 0; i < 1000; i++) {
        lineAndMarksManager.getMark(`mark_${i}`);
      }
      const retrieveTime = Date.now() - retrieveStart;

      // Should be reasonably fast (adjust thresholds as needed)
      expect(addTime).toBeLessThan(1000); // < 1 second to add 1000 marks
      expect(retrieveTime).toBeLessThan(500); // < 0.5 second to retrieve 1000 marks

      expect(lineAndMarksManager.getAllMarks().length).toBe(1000);
    });
  });

  describe('Integration with Undo System', () => {
    beforeEach(() => {
      buffer.enableUndo();
      buffer.loadContent('Undo test content');
    });

    test('should maintain marks consistency through undo/redo', async () => {
      lineAndMarksManager.setMark('undo_test', 10);

      // Make a change
      await buffer.insertBytes(5, Buffer.from('NEW '));
      expect(lineAndMarksManager.getMark('undo_test')).toBe(14); // Shifted

      // Undo the change
      await buffer.undo();
      expect(lineAndMarksManager.getMark('undo_test')).toBe(10); // Back to original

      // Redo the change
      await buffer.redo();
      expect(lineAndMarksManager.getMark('undo_test')).toBe(14); // Shifted again
    });

    test('should handle transaction rollbacks with marks', async () => {
      lineAndMarksManager.setMark('transaction_test', 8);

      buffer.beginUndoTransaction('Test Transaction');
      await buffer.insertBytes(5, Buffer.from('TEMP '));
      lineAndMarksManager.setMark('temp_mark', 15);

      expect(lineAndMarksManager.getMark('transaction_test')).toBe(13); // Shifted
      expect(lineAndMarksManager.getMark('temp_mark')).toBe(15);

      // Rollback transaction
      await buffer.rollbackUndoTransaction();

      expect(lineAndMarksManager.getMark('transaction_test')).toBe(8); // Back to original
      // Note: temp_mark behavior during rollback depends on implementation
    });
  });
});
