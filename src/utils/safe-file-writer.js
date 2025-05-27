/**
 * @fileoverview Safe File Writer - Handles in-place file modifications with conflict detection
 * @author Jeffrey R. Day
 * @version 1.0.0
 */

const fs = require('fs').promises;
const path = require('path');

/**
 * Save strategies based on conflict analysis
 */
const SaveStrategy = {
  SAFE_INPLACE: 'safe_inplace',
  REVERSE_ORDER: 'reverse_order_write', 
  PARTIAL_TEMP: 'partial_temp_buffer',
  ATOMIC_TEMP: 'atomic_temp_file',
  NEW_FILE: 'new_file' // For save-as scenarios
};

/**
 * Risk assessment levels
 */
const RiskLevel = {
  NONE: 'none',
  LOW: 'low', 
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

/**
 * Analyzes buffer modifications to detect read/write conflicts
 */
class ModificationAnalyzer {
  constructor(buffer) {
    this.buffer = buffer;
  }

  /**
   * Analyze all modifications and determine the safest approach
   * @param {string} targetFilename - Target filename for save operation
   * @returns {Object} Analysis result with strategy recommendation
   */
  analyze(targetFilename) {
    const isNewFile = this._isNewFileOperation(targetFilename);
    const modifications = this._buildModificationMap();
    
    if (isNewFile) {
      // Save-as operation - no conflicts possible, use sequential write
      return {
        modifications,
        conflicts: [],
        strategy: SaveStrategy.NEW_FILE,
        riskLevel: RiskLevel.NONE,
        isNewFile: true,
        stats: this._calculateStats(modifications, [])
      };
    }

    // In-place operation - analyze for conflicts
    const conflicts = this._detectConflicts(modifications);
    const strategy = this._selectStrategy(modifications, conflicts);
    const riskLevel = this._assessRisk(conflicts);
    
    return {
      modifications,
      conflicts,
      strategy,
      riskLevel,
      isNewFile: false,
      stats: this._calculateStats(modifications, conflicts)
    };
  }

  /**
   * Determine if this is a save-as operation (new file)
   * @private
   */
  _isNewFileOperation(targetFilename) {
    // No source file - definitely new
    if (!this.buffer.filename) {
      return true;
    }

    // Different filename - save-as operation
    if (path.resolve(targetFilename) !== path.resolve(this.buffer.filename)) {
      return true;
    }

    return false;
  }

  /**
   * Build a map of all page modifications
   * @private
   */
  _buildModificationMap() {
    const modifications = [];
    let virtualOffset = 0;

    for (const [pageId, pageInfo] of this.buffer.pages) {
      const mod = {
        pageId,
        pageInfo,
        virtualStart: virtualOffset,
        virtualEnd: virtualOffset + pageInfo.currentSize,
        physicalStart: pageInfo.fileOffset,
        physicalEnd: pageInfo.fileOffset + pageInfo.originalSize,
        sizeDelta: pageInfo.currentSize - pageInfo.originalSize,
        isDirty: pageInfo.isDirty,
        needsRead: !pageInfo.isDirty && pageInfo.originalSize > 0,
        willWrite: pageInfo.currentSize > 0
      };

      mod.modificationType = this._classifyModification(mod);
      modifications.push(mod);
      virtualOffset += pageInfo.currentSize;
    }

    return modifications;
  }

  /**
   * Classify the type of modification
   * @private
   */
  _classifyModification(mod) {
    if (!mod.isDirty) return 'unchanged';
    if (mod.sizeDelta > 0) return 'expansion';
    if (mod.sizeDelta < 0) return 'contraction';
    return 'replacement';
  }

  /**
   * Detect read/write conflicts between modifications
   * @private
   */
  _detectConflicts(modifications) {
    const conflicts = [];
    let cumulativeShift = 0;

    for (let i = 0; i < modifications.length; i++) {
      const writeMod = modifications[i];
      
      if (!writeMod.willWrite) {
        continue;
      }

      // Calculate target write position accounting for cumulative shifts
      const targetStart = writeMod.physicalStart + cumulativeShift;
      const targetEnd = targetStart + (writeMod.virtualEnd - writeMod.virtualStart);

      // Check for conflicts with later pages that need to be read
      for (let j = i + 1; j < modifications.length; j++) {
        const readMod = modifications[j];
        
        if (!readMod.needsRead) {
          continue;
        }

        // Check for overlap between write target and read source
        const overlapStart = Math.max(targetStart, readMod.physicalStart);
        const overlapEnd = Math.min(targetEnd, readMod.physicalEnd);

        if (overlapStart < overlapEnd) {
          const conflict = {
            type: 'write_before_read',
            writePageId: writeMod.pageId,
            readPageId: readMod.pageId,
            writeMod,
            readMod,
            overlapStart,
            overlapEnd,
            size: overlapEnd - overlapStart,
            severity: this._calculateSeverity(readMod, overlapEnd - overlapStart)
          };
          
          conflicts.push(conflict);
        }
      }

      cumulativeShift += writeMod.sizeDelta;
    }

    return conflicts;
  }

  /**
   * Calculate conflict severity
   * @private
   */
  _calculateSeverity(readMod, overlapSize) {
    const readSize = readMod.physicalEnd - readMod.physicalStart;
    const overlapRatio = overlapSize / readSize;
    
    if (overlapRatio >= 0.9) return 'critical';
    if (overlapRatio >= 0.5) return 'high';
    if (overlapRatio >= 0.1) return 'medium';
    return 'low';
  }

  /**
   * Select the optimal save strategy for in-place operations
   * @private
   */
  _selectStrategy(modifications, conflicts) {
    if (conflicts.length === 0) {
      return SaveStrategy.SAFE_INPLACE;
    }

    const criticalConflicts = conflicts.filter(c => c.severity === 'critical');
    const highConflicts = conflicts.filter(c => c.severity === 'high');
    const totalConflictSize = conflicts.reduce((sum, c) => sum + c.size, 0);
    const hasOnlyExpansions = modifications.every(m => 
      !m.isDirty || m.modificationType === 'expansion' || m.modificationType === 'unchanged'
    );

    // Critical conflicts or very large conflict regions require atomic temp file
    if (criticalConflicts.length > 0 || totalConflictSize > 100 * 1024 * 1024) {
      return SaveStrategy.ATOMIC_TEMP;
    }

    // If we only have expansions, reverse order writing is very effective
    if (hasOnlyExpansions && highConflicts.length <= 3) {
      return SaveStrategy.REVERSE_ORDER;
    }

    // Moderate conflicts can use partial temp buffers
    if (totalConflictSize < 50 * 1024 * 1024) {
      return SaveStrategy.PARTIAL_TEMP;
    }

    // Default to safest approach
    return SaveStrategy.ATOMIC_TEMP;
  }

  /**
   * Assess overall risk level
   * @private
   */
  _assessRisk(conflicts) {
    if (conflicts.length === 0) return RiskLevel.NONE;
    
    const severities = conflicts.map(c => c.severity);
    if (severities.includes('critical')) return RiskLevel.CRITICAL;
    if (severities.includes('high')) return RiskLevel.HIGH;
    if (severities.includes('medium')) return RiskLevel.MEDIUM;
    return RiskLevel.LOW;
  }

  /**
   * Calculate statistics for the analysis
   * @private
   */
  _calculateStats(modifications, conflicts) {
    const dirtyPages = modifications.filter(m => m.isDirty).length;
    const totalSizeChange = modifications.reduce((sum, m) => sum + m.sizeDelta, 0);
    const conflictSize = conflicts.reduce((sum, c) => sum + c.size, 0);
    
    return {
      totalPages: modifications.length,
      dirtyPages,
      unchangedPages: modifications.length - dirtyPages,
      totalSizeChange,
      conflictCount: conflicts.length,
      conflictSize,
      conflictRatio: this.buffer.totalSize > 0 ? conflictSize / this.buffer.totalSize : 0
    };
  }
}

/**
 * Safe file writer that handles various save strategies
 */
class SafeFileWriter {
  constructor(buffer, options = {}) {
    this.buffer = buffer;
    this.options = {
      createBackups: options.createBackups !== false,
      maxTempBufferSize: options.maxTempBufferSize || 100 * 1024 * 1024,
      backupSuffix: options.backupSuffix || '.backup',
      ...options
    };
  }

  /**
   * Save the buffer to a file using the safest detected strategy
   * @param {string} filename - Target filename
   * @param {Object} options - Save options
   */
  async save(filename, options = {}) {
    const analyzer = new ModificationAnalyzer(this.buffer);
    const analysis = analyzer.analyze(filename);
    
    this._notify('save_analysis_complete', 'info', 
      `Save analysis: ${analysis.isNewFile ? 'new file' : 'in-place'}, ` +
      `${analysis.conflicts.length} conflicts, ` +
      `risk: ${analysis.riskLevel}, strategy: ${analysis.strategy}`,
      { analysis }
    );

    const saveOptions = { ...this.options, ...options };
    
    try {
      switch (analysis.strategy) {
        case SaveStrategy.NEW_FILE:
          return await this._saveNewFile(filename, analysis, saveOptions);
          
        case SaveStrategy.SAFE_INPLACE:
          return await this._saveInPlace(filename, analysis, saveOptions);
          
        case SaveStrategy.REVERSE_ORDER:
          return await this._saveReverseOrder(filename, analysis, saveOptions);
          
        case SaveStrategy.PARTIAL_TEMP:
          return await this._saveWithPartialTemp(filename, analysis, saveOptions);
          
        case SaveStrategy.ATOMIC_TEMP:
          return await this._saveWithAtomicTemp(filename, analysis, saveOptions);
          
        default:
          throw new Error(`Unknown save strategy: ${analysis.strategy}`);
      }
    } catch (error) {
      this._notify('save_failed', 'error', `Save failed: ${error.message}`, { 
        strategy: analysis.strategy, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Strategy 0: New file - simple sequential write
   * @private
   */
  async _saveNewFile(filename, analysis, options) {
    try {
      await this._performStandardSave(filename);
      await this._updateBufferMetadata(filename);
      
      this._notify('save_completed', 'info', 
        `New file save completed: ${filename}`);
        
    } catch (error) {
      // Clean up partial file on error
      await this._cleanupTempFile(filename);
      throw error;
    }
  }

  /**
   * Strategy 1: Safe in-place writing (no conflicts)
   * @private
   */
  async _saveInPlace(filename, analysis, options) {
    const backup = await this._createBackup(filename, options);
    
    try {
      await this._performStandardSave(filename);
      await this._cleanupBackup(backup);
      
      this._notify('save_completed', 'info', 
        `Safe in-place save completed: ${filename}`);
        
    } catch (error) {
      await this._restoreBackup(backup, filename);
      throw error;
    }
  }

  /**
   * Strategy 2: Reverse order writing to avoid conflicts
   * @private
   */
  async _saveReverseOrder(filename, analysis, options) {
    const backup = await this._createBackup(filename, options);
    
    try {
      // Sort modifications by physical position in descending order
      const sortedMods = analysis.modifications
        .filter(mod => mod.willWrite && mod.isDirty)
        .sort((a, b) => b.physicalStart - a.physicalStart);

      const fd = await fs.open(filename, 'r+');
      let cumulativeShift = 0;
      
      try {
        // Write from end to beginning
        for (const mod of sortedMods.reverse()) {
          const targetOffset = mod.physicalStart + cumulativeShift;
          await this.buffer._ensurePageLoaded(mod.pageInfo, false);
          
          if (mod.pageInfo.data && mod.pageInfo.data.length > 0) {
            await fd.write(mod.pageInfo.data, 0, mod.pageInfo.data.length, targetOffset);
          }
          
          cumulativeShift += mod.sizeDelta;
        }
        
        // Adjust file size if needed
        await fd.truncate(this.buffer.totalSize);
        
      } finally {
        await fd.close();
      }
      
      await this._updateBufferMetadata(filename);
      await this._cleanupBackup(backup);
      
      this._notify('save_completed', 'info', 
        `Reverse order save completed: ${filename}`);
        
    } catch (error) {
      await this._restoreBackup(backup, filename);
      throw error;
    }
  }

  /**
   * Strategy 3: Partial temporary buffers for conflict regions
   * @private
   */
  async _saveWithPartialTemp(filename, analysis, options) {
    const backup = await this._createBackup(filename, options);
    const tempBuffers = new Map();
    
    try {
      // Pre-read all conflict regions into temporary buffers
      if (await this._fileExists(filename)) {
        const sourceFd = await fs.open(filename, 'r');
        
        try {
          const conflictPages = new Set(analysis.conflicts.map(c => c.readPageId));
          
          for (const pageId of conflictPages) {
            const mod = analysis.modifications.find(m => m.pageId === pageId);
            if (mod && mod.needsRead) {
              const buffer = Buffer.alloc(mod.physicalEnd - mod.physicalStart);
              await sourceFd.read(buffer, 0, buffer.length, mod.physicalStart);
              tempBuffers.set(pageId, buffer);
            }
          }
        } finally {
          await sourceFd.close();
        }
      }
      
      // Perform save using temp buffers for conflict regions
      await this._performSaveWithTempBuffers(filename, tempBuffers);
      await this._cleanupBackup(backup);
      
      this._notify('save_completed', 'info', 
        `Partial temp buffer save completed: ${filename} ` +
        `(${tempBuffers.size} conflict regions buffered)`);
        
    } catch (error) {
      await this._restoreBackup(backup, filename);
      throw error;
    } finally {
      tempBuffers.clear();
    }
  }

  /**
   * Strategy 4: Atomic temporary file
   * @private
   */
  async _saveWithAtomicTemp(filename, analysis, options) {
    const tempFile = `${filename}.tmp.${Date.now()}.${process.pid}`;
    
    try {
      await this._performStandardSave(tempFile);
      await fs.rename(tempFile, filename);
      await this._updateBufferMetadata(filename);
      
      this._notify('save_completed', 'info', 
        `Atomic temp file save completed: ${filename}`);
        
    } catch (error) {
      await this._cleanupTempFile(tempFile);
      throw error;
    }
  }

  /**
   * Perform standard sequential save
   * @private
   */
  async _performStandardSave(filename) {
    const fd = await fs.open(filename, 'w');
    
    try {
      for (const [pageId, pageInfo] of this.buffer.pages) {
        let pageData = null;
        
        if (pageInfo.isDirty) {
          await this.buffer._ensurePageLoaded(pageInfo, false);
          pageData = pageInfo.data;
        } else if (pageInfo.originalSize > 0) {
          // Read from original file
          pageData = await this._readPageFromSource(pageInfo);
        }
        
        if (pageData && pageData.length > 0) {
          await fd.write(pageData);
        }
      }
    } finally {
      await fd.close();
    }
  }

  /**
   * Perform save using temporary buffers for specific pages
   * @private
   */
  async _performSaveWithTempBuffers(filename, tempBuffers) {
    const fd = await fs.open(filename, 'w');
    
    try {
      for (const [pageId, pageInfo] of this.buffer.pages) {
        let pageData = null;
        
        if (tempBuffers.has(pageId)) {
          pageData = tempBuffers.get(pageId);
        } else if (pageInfo.isDirty) {
          await this.buffer._ensurePageLoaded(pageInfo, false);
          pageData = pageInfo.data;
        } else if (pageInfo.originalSize > 0) {
          pageData = await this._readPageFromSource(pageInfo);
        }
        
        if (pageData && pageData.length > 0) {
          await fd.write(pageData);
        }
      }
    } finally {
      await fd.close();
    }
    
    await this._updateBufferMetadata(filename);
  }

  /**
   * Read page data from the original source file
   * @private
   */
  async _readPageFromSource(pageInfo) {
    if (!this.buffer.filename || pageInfo.originalSize === 0) {
      return Buffer.alloc(0);
    }
    
    const fd = await fs.open(this.buffer.filename, 'r');
    try {
      const buffer = Buffer.alloc(pageInfo.originalSize);
      const { bytesRead } = await fd.read(buffer, 0, pageInfo.originalSize, pageInfo.fileOffset);
      
      if (bytesRead !== pageInfo.originalSize) {
        throw new Error(`Incomplete read from source: expected ${pageInfo.originalSize}, got ${bytesRead}`);
      }
      
      return buffer;
    } finally {
      await fd.close();
    }
  }

  /**
   * Create backup file if enabled
   * @private
   */
  async _createBackup(filename, options) {
    if (!options.createBackups || !await this._fileExists(filename)) {
      return null;
    }
    
    const backupPath = `${filename}${options.backupSuffix}.${Date.now()}`;
    await fs.copyFile(filename, backupPath);
    
    this._notify('backup_created', 'info', `Backup created: ${backupPath}`);
    return backupPath;
  }

  /**
   * Restore from backup file
   * @private
   */
  async _restoreBackup(backupPath, targetFile) {
    if (!backupPath || !await this._fileExists(backupPath)) {
      return false;
    }
    
    try {
      await fs.copyFile(backupPath, targetFile);
      this._notify('backup_restored', 'warning', `Restored from backup: ${backupPath}`);
      return true;
    } catch (error) {
      this._notify('backup_restore_failed', 'error', 
        `Failed to restore backup: ${error.message}`);
      return false;
    }
  }

  /**
   * Clean up backup file
   * @private
   */
  async _cleanupBackup(backupPath) {
    if (!backupPath || !await this._fileExists(backupPath)) {
      return;
    }
    
    try {
      await fs.unlink(backupPath);
    } catch (error) {
      // Ignore cleanup errors - backup can stay
    }
  }

  /**
   * Clean up temporary file
   * @private
   */
  async _cleanupTempFile(tempPath) {
    if (!await this._fileExists(tempPath)) {
      return;
    }
    
    try {
      await fs.unlink(tempPath);
    } catch (error) {
      // Ignore cleanup errors
    }
  }

  /**
   * Update buffer metadata after successful save
   * @private
   */
  async _updateBufferMetadata(filename) {
    // Let the buffer handle its own metadata update to avoid import issues
    if (typeof this.buffer._updateMetadataAfterSave === 'function') {
      await this.buffer._updateMetadataAfterSave(filename);
    } else {
      // Fallback to direct update
      const stats = await fs.stat(filename);
      this.buffer.filename = filename;
      this.buffer.fileSize = stats.size;
      this.buffer.fileMtime = stats.mtime;
      this.buffer.totalSize = stats.size;
      this.buffer.state = 'clean'; // Use string constant as fallback
      
      // Mark all pages as clean
      for (const pageInfo of this.buffer.pages.values()) {
        pageInfo.isDirty = false;
        pageInfo.isDetached = false;
      }
    }
  }

  /**
   * Check if file exists
   * @private
   */
  async _fileExists(filepath) {
    try {
      await fs.access(filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send notification (delegate to buffer if available)
   * @private
   */
  _notify(type, severity, message, metadata = {}) {
    if (this.buffer._notify) {
      this.buffer._notify(type, severity, message, metadata);
    }
  }
}

module.exports = {
  SafeFileWriter,
  ModificationAnalyzer,
  SaveStrategy,
  RiskLevel
};
