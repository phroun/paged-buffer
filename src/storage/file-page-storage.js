/**
 * File-based page storage implementation
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { PageStorage } = require('./page-storage');

/**
 * File-based page storage implementation
 * @extends PageStorage
 */
class FilePageStorage extends PageStorage {
  constructor(tempDir = null) {
    super();
    this.tempDir = tempDir || path.join(os.tmpdir(), 'buffer-pages');
    this._ensureTempDir();
  }

  async _ensureTempDir() {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }

  async savePage(pageId, data) {
    const pagePath = path.join(this.tempDir, `${pageId}.page`);
    await fs.writeFile(pagePath, data);
  }

  async loadPage(pageId) {
    const pagePath = path.join(this.tempDir, `${pageId}.page`);
    return await fs.readFile(pagePath);
  }

  async deletePage(pageId) {
    const pagePath = path.join(this.tempDir, `${pageId}.page`);
    try {
      await fs.unlink(pagePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async pageExists(pageId) {
    const pagePath = path.join(this.tempDir, `${pageId}.page`);
    try {
      await fs.access(pagePath);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { FilePageStorage };
