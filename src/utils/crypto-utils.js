/**
 * @fileoverview Cryptographic utilities for checksums and data integrity
 * @author Jeffrey R. Day
 */

const crypto = require('crypto');

/**
 * Cryptographic utilities for the paged buffer system
 */
class CryptoUtils {
  /**
   * Calculate MD5 checksum for data integrity verification
   * @param {Buffer} data - Data to checksum
   * @returns {string} - Hexadecimal checksum string
   */
  static calculateMD5(data) {
    if (!Buffer.isBuffer(data)) {
      throw new Error('Data must be a Buffer');
    }
    
    return crypto.createHash('md5').update(data).digest('hex');
  }

  /**
   * Calculate SHA-256 checksum for stronger integrity verification
   * @param {Buffer} data - Data to checksum
   * @returns {string} - Hexadecimal checksum string
   */
  static calculateSHA256(data) {
    if (!Buffer.isBuffer(data)) {
      throw new Error('Data must be a Buffer');
    }
    
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Calculate fast CRC32 checksum for quick integrity checks
   * @param {Buffer} data - Data to checksum
   * @returns {number} - CRC32 checksum as number
   */
  static calculateCRC32(data) {
    if (!Buffer.isBuffer(data)) {
      throw new Error('Data must be a Buffer');
    }

    let crc = 0xFFFFFFFF;
    
    for (let i = 0; i < data.length; i++) {
      crc = crc ^ data[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (0xEDB88320 & (-(crc & 1)));
      }
    }
    
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /**
   * Calculate checksum for a file by reading it in chunks
   * @param {string} filePath - Path to file
   * @param {string} algorithm - Hash algorithm ('md5', 'sha256', 'crc32')
   * @returns {Promise<string|number>} - Checksum
   */
  static async calculateFileChecksum(filePath, algorithm = 'md5') {
    const fs = require('fs').promises;
    
    if (algorithm === 'crc32') {
      const data = await fs.readFile(filePath);
      return this.calculateCRC32(data);
    }
    
    const hash = crypto.createHash(algorithm);
    const fd = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(64 * 1024); // 64KB chunks
    
    try {
      let position = 0;
      const stats = await fd.stat();
      
      while (position < stats.size) {
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    } finally {
      await fd.close();
    }
    
    return hash.digest('hex');
  }

  /**
   * Verify data integrity against a known checksum
   * @param {Buffer} data - Data to verify
   * @param {string|number} expectedChecksum - Expected checksum
   * @param {string} algorithm - Hash algorithm used
   * @returns {boolean} - True if checksums match
   */
  static verifyChecksum(data, expectedChecksum, algorithm = 'md5') {
    let actualChecksum;
    
    switch (algorithm.toLowerCase()) {
      case 'md5':
        actualChecksum = this.calculateMD5(data);
        break;
      case 'sha256':
        actualChecksum = this.calculateSHA256(data);
        break;
      case 'crc32':
        actualChecksum = this.calculateCRC32(data);
        break;
      default:
        throw new Error(`Unsupported algorithm: ${algorithm}`);
    }
    
    return actualChecksum === expectedChecksum;
  }

  /**
   * Generate a unique ID for pages or operations
   * @param {number} length - Length of ID (default: 16)
   * @returns {string} - Random hexadecimal ID
   */
  static generateId(length = 16) {
    return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
  }

  /**
   * Create a content signature combining size and checksum
   * @param {Buffer} data - Data to sign
   * @param {string} algorithm - Hash algorithm
   * @returns {Object} - Signature object
   */
  static createContentSignature(data, algorithm = 'md5') {
    if (!Buffer.isBuffer(data)) {
      throw new Error('Data must be a Buffer');
    }

    let checksum;
    switch (algorithm.toLowerCase()) {
      case 'md5':
        checksum = this.calculateMD5(data);
        break;
      case 'sha256':
        checksum = this.calculateSHA256(data);
        break;
      case 'crc32':
        checksum = this.calculateCRC32(data);
        break;
      default:
        throw new Error(`Unsupported algorithm: ${algorithm}`);
    }

    return {
      size: data.length,
      checksum,
      algorithm,
      timestamp: Date.now()
    };
  }

  /**
   * Verify a content signature
   * @param {Buffer} data - Data to verify
   * @param {Object} signature - Signature object to verify against
   * @returns {boolean} - True if signature is valid
   */
  static verifyContentSignature(data, signature) {
    if (!Buffer.isBuffer(data)) {
      throw new Error('Data must be a Buffer');
    }

    if (!signature || typeof signature !== 'object') {
      throw new Error('Invalid signature object');
    }

    // Check size first (fast check)
    if (data.length !== signature.size) {
      return false;
    }

    // Check checksum
    return this.verifyChecksum(data, signature.checksum, signature.algorithm);
  }

  /**
   * Compare two buffers for equality (constant time to prevent timing attacks)
   * @param {Buffer} buffer1 - First buffer
   * @param {Buffer} buffer2 - Second buffer
   * @returns {boolean} - True if buffers are equal
   */
  static constantTimeEquals(buffer1, buffer2) {
    if (!Buffer.isBuffer(buffer1) || !Buffer.isBuffer(buffer2)) {
      throw new Error('Both arguments must be Buffers');
    }

    if (buffer1.length !== buffer2.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < buffer1.length; i++) {
      result |= buffer1[i] ^ buffer2[i];
    }

    return result === 0;
  }

  /**
   * Calculate rolling hash for efficient diff detection
   * @param {Buffer} data - Data to hash
   * @param {number} windowSize - Rolling window size
   * @returns {Array<number>} - Array of rolling hashes
   */
  static calculateRollingHash(data, windowSize = 64) {
    if (!Buffer.isBuffer(data) || data.length < windowSize) {
      return [];
    }

    const hashes = [];
    const base = 257;
    const mod = 1000000007;
    
    let hash = 0;
    let basePower = 1;
    
    // Calculate base^(windowSize-1) % mod
    for (let i = 0; i < windowSize - 1; i++) {
      basePower = (basePower * base) % mod;
    }
    
    // Calculate first window hash
    for (let i = 0; i < windowSize; i++) {
      hash = (hash * base + data[i]) % mod;
    }
    hashes.push(hash);
    
    // Roll the hash through the rest of the data
    for (let i = windowSize; i < data.length; i++) {
      // Remove leftmost character and add rightmost character
      hash = (hash - (data[i - windowSize] * basePower) % mod + mod) % mod;
      hash = (hash * base + data[i]) % mod;
      hashes.push(hash);
    }
    
    return hashes;
  }

  /**
   * Get available hash algorithms
   * @returns {Array<string>} - Array of supported algorithms
   */
  static getSupportedAlgorithms() {
    return ['md5', 'sha256', 'crc32'];
  }

  /**
   * Benchmark hash algorithms on given data
   * @param {Buffer} data - Data to benchmark
   * @returns {Object} - Benchmark results
   */
  static benchmarkAlgorithms(data) {
    if (!Buffer.isBuffer(data)) {
      throw new Error('Data must be a Buffer');
    }

    const results = {};
    const algorithms = ['md5', 'sha256', 'crc32'];
    
    for (const algorithm of algorithms) {
      const iterations = Math.max(1, Math.floor(1000000 / data.length));
      const startTime = process.hrtime.bigint();
      
      for (let i = 0; i < iterations; i++) {
        switch (algorithm) {
          case 'md5':
            this.calculateMD5(data);
            break;
          case 'sha256':
            this.calculateSHA256(data);
            break;
          case 'crc32':
            this.calculateCRC32(data);
            break;
        }
      }
      
      const endTime = process.hrtime.bigint();
      const durationMs = Number(endTime - startTime) / 1000000;
      
      results[algorithm] = {
        iterations,
        totalTimeMs: durationMs,
        timePerOpUs: (durationMs * 1000) / iterations,
        throughputMBps: (data.length * iterations) / (durationMs / 1000) / (1024 * 1024)
      };
    }
    
    return results;
  }
}

module.exports = { CryptoUtils };
