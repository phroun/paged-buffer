/**
 * Direct test of operation distance calculation logic
 * This isolates the merge decision from the complex buffer operations
 */

const { BufferOperation, OperationType } = require('../src/undo-system');

describe('Operation Distance Calculation Tests', () => {

  test('should calculate correct distance for adjacent inserts (distance 0)', () => {
    const op1 = new BufferOperation(OperationType.INSERT, 0, Buffer.from('A'), null, 1000);
    const op2 = new BufferOperation(OperationType.INSERT, 1, Buffer.from('B'), null, 1001);
    
    // CRITICAL: Set post-execution position for op1
    op1.setPostExecutionPosition(0); // A is at position 0 after execution
    
    const distance = op1.getLogicalDistance(op2);
    
    console.log('Adjacent inserts distance:', distance);
    expect(distance).toBe(0); // Should be adjacent
  });

  test('should calculate correct distance for gap inserts (distance 1)', () => {
    const op1 = new BufferOperation(OperationType.INSERT, 0, Buffer.from('A'), null, 1000);
    const op2 = new BufferOperation(OperationType.INSERT, 2, Buffer.from('B'), null, 1001);
    
    // CRITICAL: Set post-execution position for op1
    op1.setPostExecutionPosition(0); // A is at position 0 after execution
    
    const distance = op1.getLogicalDistance(op2);
    
    console.log('Gap inserts distance:', distance);
    expect(distance).toBe(1); // Gap between A (ends at 1) and B (starts at 2)
  });

  test('should test merge decision with specific windows', () => {
    const op1 = new BufferOperation(OperationType.INSERT, 0, Buffer.from('A'), null, 1000);
    const op2 = new BufferOperation(OperationType.INSERT, 2, Buffer.from('B'), null, 1001);
    
    // CRITICAL: Set post-execution position for first operation
    op1.setPostExecutionPosition(0); // A is at position 0 after execution
    
    // Test with different merge windows
    const canMergeWindow0 = op1.canMergeWith(op2, 15000, 0);   // Distance 1 > window 0
    const canMergeWindow1 = op1.canMergeWith(op2, 15000, 1);   // Distance 1 <= window 1
    const canMergeWindow2 = op1.canMergeWith(op2, 15000, 2);   // Distance 1 <= window 2
    
    expect(canMergeWindow0).toBe(false); // Distance 1 > window 0
    expect(canMergeWindow1).toBe(true);  // Distance 1 <= window 1
    expect(canMergeWindow2).toBe(true);  // Distance 1 <= window 2
  });

  // For truly adjacent operations (distance 0), we need a different test:
  test('should calculate distance 0 for truly adjacent operations', () => {
    const op1 = new BufferOperation(OperationType.DELETE, 5, null, Buffer.from('old'), 1000);
    const op2 = new BufferOperation(OperationType.INSERT, 5, Buffer.from('new'), null, 1001);
    
    // CRITICAL: Set post-execution position for first operation
    op1.setPostExecutionPosition(5); // Delete position stays the same
    
    const distance = op1.getLogicalDistance(op2);
    
    console.log('Delete-then-insert at same position distance:', distance);
    expect(distance).toBe(0); // Should be truly adjacent/overlapping
  });

  test('should calculate correct distance for reverse order operations', () => {
    // What if we calculate distance the other way around?
    const op1 = new BufferOperation(OperationType.INSERT, 0, Buffer.from('A'), null, 1000);
    const op2 = new BufferOperation(OperationType.INSERT, 2, Buffer.from('B'), null, 1001);
    
    // FIXED: Set post-execution position for both operations since we test both directions
    op1.setPostExecutionPosition(0); // A is at position 0 after execution
    op2.setPostExecutionPosition(2); // B is at position 2 after execution (assuming it happens after op1)
    
    const distance1to2 = op1.getLogicalDistance(op2);
    const distance2to1 = op2.getLogicalDistance(op1);
    
    console.log('Distance 1->2:', distance1to2);
    console.log('Distance 2->1:', distance2to1);
    
    // Distance should be the same regardless of direction
    expect(distance1to2).toBe(distance2to1);
  });

  test('should handle position shifts correctly', () => {
    // Test distance calculation when operations are at different positions
    const op1 = new BufferOperation(OperationType.INSERT, 4, Buffer.from(' NEW'), null, 1000);
    const op2 = new BufferOperation(OperationType.INSERT, 0, Buffer.from('Modified '), null, 1001);
    
    // FIXED: Set post-execution position for op1
    op1.setPostExecutionPosition(4); // " NEW" is at position 4 after execution
    
    const distance = op1.getLogicalDistance(op2);
    
    console.log('Position shift distance:', distance);
    
    // op1 occupies positions 4-7, op2 wants to insert at position 0
    // Distance from position 0 to position 4 is 4
    expect(distance).toBe(4); // CORRECT: 4-character gap between operations
  });

  test('should handle delete operations correctly', () => {
    // Test delete operation distance calculation
    // "Hello World" -> delete "ello" at pos 1-5 -> "H World"
    // Then delete " Wor" at pos 1-5 -> "Hld"
    
    const op1 = new BufferOperation(OperationType.DELETE, 1, null, Buffer.from('ello'), 1000);
    const op2 = new BufferOperation(OperationType.DELETE, 1, null, Buffer.from(' Wor'), 1001);
    
    // FIXED: Set post-execution position for op1
    op1.setPostExecutionPosition(1); // Delete position stays the same
    
    const distance = op1.getLogicalDistance(op2);
    
    console.log('Delete operations distance:', distance);
    
    // Both operations start at the same position (1) after adjustment
    expect(distance).toBe(0);
  });

  test('should handle mixed insert/delete operations', () => {
    // "Hello World" -> delete "World" at pos 6-11 -> "Hello "
    // Then insert "Universe" at pos 6 -> "Hello Universe"
    
    const op1 = new BufferOperation(OperationType.DELETE, 6, null, Buffer.from('World'), 1000);
    const op2 = new BufferOperation(OperationType.INSERT, 6, Buffer.from('Universe'), null, 1001);
    
    // FIXED: Set post-execution position for op1
    op1.setPostExecutionPosition(6); // Delete position stays the same
    
    const distance = op1.getLogicalDistance(op2);
    
    console.log('Delete-then-insert distance:', distance);
    
    // Operations at same position should have distance 0
    expect(distance).toBe(0);
  });

});
