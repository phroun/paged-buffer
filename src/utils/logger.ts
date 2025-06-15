/**
 * @fileoverview Simple logger utility with debug toggle
 * @description Provides console logging with optional debug output control
 * @author Jeffrey R. Day
 * @version 1.0.0
 */

let debugOutputEnabled: boolean = false;

/**
 * Logs messages to the console if debugging is enabled.
 * Behaves like console.log, accepting multiple arguments.
 */
function debug(...args: any[]): void {
  if (debugOutputEnabled) {
    // eslint-disable-next-line no-console
    console.log(...args);
  }
}

/**
 * Logs warning messages to the console if debugging is enabled.
 * Alias for debug function to maintain compatibility.
 */
function warn(...args: any[]): void {
  if (debugOutputEnabled) {
    // eslint-disable-next-line no-console
    console.warn(...args);
  }
}

/**
 * Logs error messages to the console (always enabled).
 */
function error(...args: any[]): void {
  // eslint-disable-next-line no-console
  console.error(...args);
}

/**
 * Logs info messages to the console if debugging is enabled.
 */
function info(...args: any[]): void {
  if (debugOutputEnabled) {
    // eslint-disable-next-line no-console
    console.info(...args);
  }
}

/**
 * Enables or disables debug output.
 */
function setDebug(enable: boolean): void {
  debugOutputEnabled = enable;
}

/**
 * Gets the current debug state.
 */
function isDebugEnabled(): boolean {
  return debugOutputEnabled;
}

/**
 * Logger interface for compatibility with other logging libraries
 */
interface Logger {
  debug(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
  info(...args: any[]): void;
  setDebug(enable: boolean): void;
  isDebugEnabled(): boolean;
}

/**
 * Default logger instance
 */
const logger: Logger = {
  debug,
  warn,
  error,
  info,
  setDebug,
  isDebugEnabled
};

export {
  debug,
  warn,
  error,
  info,
  setDebug,
  isDebugEnabled,
  logger,
  type Logger
};

// Default export for compatibility
export default logger;
