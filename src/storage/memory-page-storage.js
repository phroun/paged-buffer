/**
 * In-memory page storage implementation
 */

const { PageStorage } = require('./page-storage');

/**
 * In-memory page storage for testing/small files
 */
class MemoryPageStorage extends PageStorage {
  constructor() {
    super();
    this.pages = new Map();
  }

  async savePage(pageId, data) {
    this.pages.set(pageId, Buffer.from(data));
  }

  async loadPage(pageId) {
    const page = this.pages.get(pageId);
    if (!page) throw new Error(`Page ${pageId} not found`);
    return page;
  }

  async deletePage(pageId) {
    this.pages.delete(pageId);
  }

  async pageExists(pageId) {
    return this.pages.has(pageId);
  }
}

module.exports = { MemoryPageStorage };
