// logger.js

let debugOutputEnabled = false;

/**
 * Logs messages to the console if debugging is enabled.
 * Behaves like console.log, accepting multiple arguments.
 */
function debug(...args) {
  if (debugOutputEnabled) {
    // eslint-disable-next-line no-console
    console.log(...args);
  }
}

function error(...args) {
  // eslint-disable-next-line no-console
  console.error(...args);
}

/**
 * Enables or disables debug output.
 * @param {boolean} enable - True to enable debug output, false to disable.
 */
function setDebug(enable) {
  debugOutputEnabled = enable;
}

module.exports = {
  debug,
  warn: debug,
  error,
  setDebug
};
