/**
 * In-memory page storage implementation
 */

import { PageStorage } from './page-storage';

/**
 * In-memory page storage for testing/small files
 */
class MemoryPageStorage extends PageStorage {
  private pages: Map<string, Buffer> = new Map();

  constructor() {
    super();
  }

  async savePage(pageKey: string, data: Buffer): Promise<void> {
    this.pages.set(pageKey, Buffer.from(data));
  }

  async loadPage(pageKey: string): Promise<Buffer> {
    const page = this.pages.get(pageKey);
    if (!page) throw new Error(`Page ${pageKey} not found`);
    return page;
  }

  async deletePage(pageKey: string): Promise<void> {
    this.pages.delete(pageKey);
  }

  async pageExists(pageKey: string): Promise<boolean> {
    return this.pages.has(pageKey);
  }

  /**
   * Get all stored page keys (useful for debugging/testing)
   */
  getAllPageKeys(): string[] {
    return Array.from(this.pages.keys());
  }

  /**
   * Get memory usage statistics
   */
  getMemoryStats(): { pageCount: number; totalBytes: number } {
    let totalBytes = 0;
    for (const buffer of this.pages.values()) {
      totalBytes += buffer.length;
    }
    
    return {
      pageCount: this.pages.size,
      totalBytes
    };
  }

  /**
   * Clear all stored pages
   */
  clear(): void {
    this.pages.clear();
  }
}

export { MemoryPageStorage };
