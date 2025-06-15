/**
 * Base page storage interface - allows external storage implementation
 */
abstract class PageStorage {
  /**
   * Save a page to storage
   * @param pageKey - Unique page identifier
   * @param data - Page data
   */
  abstract savePage(pageKey: string, data: Buffer): Promise<void>;

  /**
   * Load a page from storage
   * @param pageKey - Unique page identifier
   * @returns Page data
   */
  abstract loadPage(pageKey: string): Promise<Buffer>;

  /**
   * Delete a page from storage
   * @param pageKey - Unique page identifier
   */
  abstract deletePage(pageKey: string): Promise<void>;

  /**
   * Check if page exists in storage
   * @param pageKey - Unique page identifier
   */
  abstract pageExists(pageKey: string): Promise<boolean>;
}

export { PageStorage };
