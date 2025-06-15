/**
 * File-based page storage implementation
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PageStorage } from './page-storage';

/**
 * File-based page storage implementation
 */
class FilePageStorage extends PageStorage {
  private tempDir: string;

  constructor(tempDir?: string) {
    super();
    this.tempDir = tempDir || path.join(os.tmpdir(), 'buffer-pages');
    this._ensureTempDir();
  }

  private async _ensureTempDir(): Promise<void> {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
    } catch (error) {
      if ((error as any).code !== 'EEXIST') throw error;
    }
  }

  async savePage(pageKey: string, data: Buffer): Promise<void> {
    const pagePath = path.join(this.tempDir, `${pageKey}.page`);
    await fs.writeFile(pagePath, data);
  }

  async loadPage(pageKey: string): Promise<Buffer> {
    const pagePath = path.join(this.tempDir, `${pageKey}.page`);
    return await fs.readFile(pagePath);
  }

  async deletePage(pageKey: string): Promise<void> {
    const pagePath = path.join(this.tempDir, `${pageKey}.page`);
    try {
      await fs.unlink(pagePath);
    } catch (error) {
      if ((error as any).code !== 'ENOENT') throw error;
    }
  }

  async pageExists(pageKey: string): Promise<boolean> {
    const pagePath = path.join(this.tempDir, `${pageKey}.page`);
    try {
      await fs.access(pagePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the directory where pages are stored
   */
  getTempDir(): string {
    return this.tempDir;
  }

  /**
   * Get all stored page keys (useful for debugging/cleanup)
   */
  async getAllPageKeys(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.tempDir);
      return files
        .filter(file => file.endsWith('.page'))
        .map(file => file.slice(0, -5)); // Remove .page extension
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Get storage statistics
   */
  async getStorageStats(): Promise<{ pageCount: number; totalBytes: number; directory: string }> {
    const pageKeys = await this.getAllPageKeys();
    let totalBytes = 0;

    for (const pageKey of pageKeys) {
      try {
        const pagePath = path.join(this.tempDir, `${pageKey}.page`);
        const stats = await fs.stat(pagePath);
        totalBytes += stats.size;
      } catch (error) {
        // Skip files that might have been deleted concurrently
        continue;
      }
    }

    return {
      pageCount: pageKeys.length,
      totalBytes,
      directory: this.tempDir
    };
  }

  /**
   * Clean up all stored pages
   */
  async cleanup(): Promise<void> {
    try {
      const files = await fs.readdir(this.tempDir);
      const pageFiles = files.filter(file => file.endsWith('.page'));
      
      await Promise.all(
        pageFiles.map(async file => {
          try {
            await fs.unlink(path.join(this.tempDir, file));
          } catch (error) {
            // Ignore files that might have been deleted concurrently
          }
        })
      );
    } catch (error) {
      if ((error as any).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * Remove the temporary directory entirely
   */
  async destroy(): Promise<void> {
    try {
      await this.cleanup();
      await fs.rmdir(this.tempDir);
    } catch (error) {
      if ((error as any).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

export { FilePageStorage };
