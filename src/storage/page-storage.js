/**
 * Base page storage interface - allows external storage implementation
 */
class PageStorage {
  /**
   * Save a page to storage
   * @param {string} pageId - Unique page identifier
   * @param {Buffer} data - Page data
   * @returns {Promise<void>}
   */
  async savePage(_pageId, _data) {
    throw new Error('Must implement savePage');
  }

  /**
   * Load a page from storage
   * @param {string} pageId - Unique page identifier
   * @returns {Promise<Buffer>} - Page data
   */
  async loadPage(_pageId) {
    throw new Error('Must implement loadPage');
  }

  /**
   * Delete a page from storage
   * @param {string} pageId - Unique page identifier
   * @returns {Promise<void>}
   */
  async deletePage(_pageId) {
    throw new Error('Must implement deletePage');
  }

  /**
   * Check if page exists in storage
   * @param {string} pageId - Unique page identifier
   * @returns {Promise<boolean>}
   */
  async pageExists(_pageId) {
    throw new Error('Must implement pageExists');
  }
}

module.exports = { PageStorage };
