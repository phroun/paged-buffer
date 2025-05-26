/**
 * File Change Handling Tests
 */

const { PagedBuffer, FilePageStorage, BufferState, FileChangeStrategy } = require('../src');
const { testUtils } = require('./setup');

describe('File Change Handling', () => {
  let buffer;
  let storage;
  let testFilePath;

  beforeEach(async () => {
    storage = new FilePageStorage();
    buffer = new PagedBuffer(1024, storage, 10);
    
    const content = 'Initial file content\nLine 2\nLine 3\nLine 4';
    testFilePath = await testUtils.createTempFile(content);
    await buffer.loadFile(testFilePath);
  });

  describe('File Change Detection', () => {
    test('should detect when file is modified externally', async () => {
      const mockHandler = testUtils.createMockNotificationHandler();
      buffer.onNotification(mockHandler.handler);
      
      // Modify file externally
      await testUtils.modifyFile(testFilePath, 'append', '\nNew line added');
      
      // Trigger file check by accessing data
      await buffer.getBytes(0, 10);
      
      const notifications = mockHandler.getByType('file_modified_on_disk');
      expect(notifications.length).toBeGreaterThan(0);
    });

    test('should detect file size changes', async () => {
      const originalStats = await testUtils.getFileStats(testFilePath);
      
      await testUtils.modifyFile(testFilePath, 'truncate');
      
      const changeInfo = await buffer.checkFileChanges();
      expect(changeInfo.changed).toBe(true);
      expect(changeInfo.sizeChanged).toBe(true);
      expect(changeInfo.newSize).toBeLessThan(originalStats.size);
    });

    test('should detect mtime changes without size changes', async () => {
      // Modify file content without changing size
      const originalContent = await testUtils.testUtils.readFile(testFilePath, 'utf8');
      const modifiedContent = originalContent.replace('Line 2', 'Line X');
      await testUtils.testUtils.writeFile(testFilePath, modifiedContent);
      
      const changeInfo = await buffer.checkFileChanges();
      expect(changeInfo.changed).toBe(true);
      expect(changeInfo.mtimeChanged).toBe(true);
      expect(changeInfo.sizeChanged).toBe(false);
    });

    test('should handle deleted files', async () => {
      await testUtils.testUtils.unlink(testFilePath);
      
      const changeInfo = await buffer.checkFileChanges();
      expect(changeInfo.changed).toBe(true);
      expect(changeInfo.deleted).toBe(true);
    });
  });

  describe('Change Strategy Handling', () => {
    test('should rebase automatically when no edits exist', async () => {
      buffer.setChangeStrategy({
        noEdits: FileChangeStrategy.REBASE,
        withEdits: FileChangeStrategy.WARN,
        sizeChanged: FileChangeStrategy.DETACH
      });
      
      const mockHandler = testUtils.createMockNotificationHandler();
      buffer.onNotification(mockHandler.handler);
      
      // Modify file - same size, just content change
      const originalContent = await testUtils.testUtils.readFile(testFilePath, 'utf8');
      const modifiedContent = originalContent.replace('Line 2', 'Line Y');
      await testUtils.testUtils.writeFile(testFilePath, modifiedContent);
      
      // Trigger rebase
      await buffer.getBytes(0, 10);
      
      const rebaseNotifications = mockHandler.getByType('page_rebase_success');
      expect(rebaseNotifications.length).toBeGreaterThan(0);
      expect(buffer.getState()).toBe(BufferState.CLEAN);
    });

    test('should warn when edits exist and file changes', async () => {
      buffer.setChangeStrategy({
        noEdits: FileChangeStrategy.REBASE,
        withEdits: FileChangeStrategy.WARN,
        sizeChanged: FileChangeStrategy.DETACH
      });
      
      const mockHandler = testUtils.createMockNotificationHandler();
      buffer.onNotification(mockHandler.handler);
      
      // Make local edit
      await buffer.insertBytes(10, Buffer.from(' LOCAL_EDIT'));
      expect(buffer.getState()).toBe(BufferState.MODIFIED);
      
      // Modify file externally
      await testUtils.modifyFile(testFilePath, 'append', '\nExternal addition');
      
      // Trigger change detection
      await buffer.getBytes(0, 10);
      
      const conflictNotifications = mockHandler.getByType('page_conflict_detected');
      expect(conflictNotifications.length).toBeGreaterThan(0);
    });

    test('should detach when file size changes', async () => {
      buffer.setChangeStrategy({
        noEdits: FileChangeStrategy.REBASE,
        withEdits: FileChangeStrategy.WARN,
        sizeChanged: FileChangeStrategy.DETACH
      });
      
      const mockHandler = testUtils.createMockNotificationHandler();
      buffer.onNotification(mockHandler.handler);
      
      // Truncate file (size change)
      await testUtils.modifyFile(testFilePath, 'truncate');
      
      // Trigger change detection
      await buffer.getBytes(0, 5);
      
      const detachNotifications = mockHandler.getByType('buffer_detached');
      expect(detachNotifications.length).toBeGreaterThan(0);
      expect(buffer.getState()).toBe(BufferState.DETACHED);
    });
  });

  describe('Append-Only File Handling', () => {
    test('should detect pure append operations', async () => {
      const mockHandler = testUtils.createMockNotificationHandler();
      buffer.onNotification(mockHandler.handler);
      
      // Append content to file (common log file scenario)
      const appendContent = '\nNew log entry 1\nNew log entry 2\nNew log entry 3';
      await testUtils.modifyFile(testFilePath, 'append', appendContent);
      
      // Trigger append detection
      await buffer.getBytes(0, 10);
      
      // Should detect as append and handle gracefully
      const appendNotifications = mockHandler.notifications.filter(n => 
        n.message.includes('append') || n.type === 'page_rebase_success'
      );
      expect(appendNotifications.length).toBeGreaterThan(0);
      
      // Buffer should still be clean (rebased successfully)
      expect(buffer.getState()).toBe(BufferState.CLEAN);
    });

    test('should handle append with local edits', async () => {
      const mockHandler = testUtils.createMockNotificationHandler();
      buffer.onNotification(mockHandler.handler);
      
      // Make local edit in middle of file
      await buffer.insertBytes(20, Buffer.from(' [EDITED]'));
      
      // Append to file externally
      await testUtils.modifyFile(testFilePath, 'append', '\nAppended content');
      
      // Trigger change detection
      await buffer.getBytes(0, 10);
      
      // Should preserve local edits and add appended content
      const finalContent = await buffer.getBytes(0, buffer.getTotalSize());
      expect(finalContent.toString()).toContain('[EDITED]');
      expect(finalContent.toString()).toContain('Appended content');
    });

    test('should handle large append operations efficiently', async () => {
      const originalSize = buffer.getTotalSize();
      
      // Append large content (simulate log file growth)
      const largeAppend = 'LOG ENTRY\n'.repeat(10000); // ~90KB of log entries
      await testUtils.modifyFile(testFilePath, 'append', largeAppend);
      
      const startTime = Date.now();
      await buffer.getBytes(0, 10); // Trigger detection and handling
      const handlingTime = Date.now() - startTime;
      
      expect(handlingTime).toBeLessThan(2000); // Should handle efficiently
      expect(buffer.getTotalSize()).toBeGreaterThan(originalSize);
      
      // Verify appended content is accessible
      const endContent = await buffer.getBytes(
        buffer.getTotalSize() - 100, 
        buffer.getTotalSize()
      );
      expect(endContent.toString()).toContain('LOG ENTRY');
    });
  });

  describe('Intelligent Merge Scenarios', () => {
    test('should merge compatible changes', async () => {
      const mockHandler = testUtils.createMockNotificationHandler();
      buffer.onNotification(mockHandler.handler);
      
      // Local edit at beginning
      await buffer.insertBytes(0, Buffer.from('LOCAL: '));
      
      // External edit at end (compatible)
      await testUtils.modifyFile(testFilePath, 'append', '\nEXTERNAL: Added line');
      
      // Trigger merge
      await buffer.getBytes(0, 10);
      
      // Should successfully merge both changes
      const mergeNotifications = mockHandler.getByType('page_rebase_success');
      expect(mergeNotifications.length).toBeGreaterThan(0);
      
      const finalContent = await buffer.getBytes(0, buffer.getTotalSize());
      const contentStr = finalContent.toString();
      expect(contentStr).toContain('LOCAL: ');
      expect(contentStr).toContain('EXTERNAL: Added line');
    });

    test('should detect and handle conflicting changes', async () => {
      const mockHandler = testUtils.createMockNotificationHandler();
      buffer.onNotification(mockHandler.handler);
      
      // Local edit in middle
      await buffer.deleteBytes(10, 20);
      await buffer.insertBytes(10, Buffer.from('LOCAL_REPLACEMENT'));
      
      // External edit in same area (conflict)
      const originalContent = await testUtils.testUtils.readFile(testFilePath, 'utf8');
      const conflictingContent = originalContent.replace(
        'file content',
        'EXTERNAL_REPLACEMENT'
      );
      await testUtils.testUtils.writeFile(testFilePath, conflictingContent);
      
      // Trigger conflict detection
      await buffer.getBytes(0, 10);
      
      const conflictNotifications = mockHandler.getByType('page_conflict_detected');
      expect(conflictNotifications.length).toBeGreaterThan(0);
    });
  });

  describe('Buffer State Management', () => {
    test('should transition states correctly during file changes', async () => {
      expect(buffer.getState()).toBe(BufferState.CLEAN);
      
      // Make local edit -> MODIFIED
      await buffer.insertBytes(10, Buffer.from('edit'));
      expect(buffer.getState()).toBe(BufferState.MODIFIED);
      
      // File changed externally with conflicts -> DETACHED
      buffer.setChangeStrategy({ withEdits: FileChangeStrategy.DETACH });
      await testUtils.modifyFile(testFilePath, 'append', '\nExternal change');
      await buffer.getBytes(0, 5); // Trigger detection
      
      expect(buffer.getState()).toBe(BufferState.DETACHED);
      
      // Should require saveAs for detached buffers
      await expect(buffer.saveFile()).rejects.toThrow('detached');
    });

    test('should handle save operations with different states', async () => {
      // Clean state - should save normally
      expect(buffer.getState()).toBe(BufferState.CLEAN);
      await buffer.saveFile(); // Should work
      
      // Modified state - should save normally
      await buffer.insertBytes(10, Buffer.from('edit'));
      expect(buffer.getState()).toBe(BufferState.MODIFIED);
      await buffer.saveFile(); // Should work
      expect(buffer.getState()).toBe(BufferState.CLEAN);
      
      // Detached state - should require saveAs
      buffer.state = BufferState.DETACHED; // Simulate detached state
      await expect(buffer.saveFile()).rejects.toThrow();
      
      const newFilePath = await testUtils.createTempFile('');
      await buffer.saveAs(newFilePath, true); // Should work with force flag
    });
  });

  describe('Notification System Integration', () => {
    test('should provide detailed change information in notifications', async () => {
      const mockHandler = testUtils.createMockNotificationHandler();
      buffer.onNotification(mockHandler.handler);
      
      // Modify file
      await testUtils.modifyFile(testFilePath, 'append', '\nDetailed notification test');
      
      // Trigger detection
      await buffer.getBytes(0, 10);
      
      const notifications = mockHandler.notifications;
      expect(notifications.length).toBeGreaterThan(0);
      
      // Check for detailed metadata
      const changeNotifications = notifications.filter(n => 
        n.type === 'file_modified_on_disk' || n.type === 'page_rebase_success'
      );
      
      expect(changeNotifications.length).toBeGreaterThan(0);
      changeNotifications.forEach(notification => {
        expect(notification.metadata).toBeDefined();
        expect(notification.timestamp).toBeDefined();
      });
    });

    test('should allow filtering and clearing change notifications', () => {
      const mockHandler = testUtils.createMockNotificationHandler();
      buffer.onNotification(mockHandler.handler);
      
      // Generate some notifications
      buffer.loadContent('New content to generate notifications');
      
      const allNotifications = buffer.getNotifications();
      expect(allNotifications.length).toBeGreaterThan(0);
      
      // Clear specific type
      const fileNotificationsBefore = buffer.getNotifications()
        .filter(n => n.type === 'file_modified_on_disk');
      
      buffer.clearNotifications('file_modified_on_disk');
      
      const fileNotificationsAfter = buffer.getNotifications()
        .filter(n => n.type === 'file_modified_on_disk');
      
      expect(fileNotificationsAfter.length).toBeLessThan(fileNotificationsBefore.length);
      
      // Clear all
      buffer.clearNotifications();
      expect(buffer.getNotifications().length).toBe(0);
    });
  });

  describe('Performance with File Changes', () => {
    test('should handle frequent file checks efficiently', async () => {
      const startTime = Date.now();
      
      // Perform many operations that trigger file checks
      for (let i = 0; i < 50; i++) {
        await buffer.getBytes(i * 10, i * 10 + 10);
      }
      
      const totalTime = Date.now() - startTime;
      expect(totalTime).toBeLessThan(5000); // Should be efficient
    });

    test('should batch file change notifications', async () => {
      const mockHandler = testUtils.createMockNotificationHandler();
      buffer.onNotification(mockHandler.handler);
      
      // Make multiple rapid file changes
      await testUtils.modifyFile(testFilePath, 'append', '\nChange 1');
      await testUtils.modifyFile(testFilePath, 'append', '\nChange 2');
      await testUtils.modifyFile(testFilePath, 'append', '\nChange 3');
      
      // Single operation should detect all changes
      await buffer.getBytes(0, 10);
      
      // Should not generate excessive notifications
      const changeNotifications = mockHandler.getByType('file_modified_on_disk');
      expect(changeNotifications.length).toBeLessThan(10); // Reasonable limit
    });
  });

  describe('Error Recovery', () => {
    test('should recover gracefully from file system errors', async () => {
      const mockHandler = testUtils.createMockNotificationHandler();
      buffer.onNotification(mockHandler.handler);
      
      // Remove file permissions (simulate access error)
      try {
        await testUtils.testUtils.chmod(testFilePath, 0o000); // No permissions
        
        // Try to detect changes
        await buffer.getBytes(0, 10);
        
        // Should handle error gracefully
        const errorNotifications = mockHandler.notifications.filter(n => 
          n.severity === 'error'
        );
        expect(errorNotifications.length).toBeGreaterThan(0);
        
      } finally {
        // Restore permissions for cleanup
        try {
          await testUtils.testUtils.chmod(testFilePath, 0o644);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    });

    test('should handle network file system delays', async () => {
      // Simulate slow file system by creating very large file
      const largeFilePath = await testUtils.createLargeFile(50); // 50MB
      const largeBuffer = new PagedBuffer(64 * 1024, storage, 20);
      
      await largeBuffer.loadFile(largeFilePath);
      
      // File operations should still work despite potential delays
      const startTime = Date.now();
      await largeBuffer.getBytes(0, 1000);
      const accessTime = Date.now() - startTime;
      
      // Should complete within reasonable time even with large files
      expect(accessTime).toBeLessThan(3000);
    });
  });
});
