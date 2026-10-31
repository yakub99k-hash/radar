'use strict';

/**
 * Tiny structured logger. No dependency, no PII beyond what we pass in,
 * and API keys are never logged.
 */
function createLogger(options = {}) {
  const level = String(options.level || process.env.LOG_LEVEL || 'info').toLowerCase();
  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  const threshold = levels[level] === undefined ? levels.info : levels[level];
  const sink = options.sink || console;

  function write(lvl, message, context) {
    if (levels[lvl] > threshold) return;
    const line = {
      ts: new Date().toISOString(),
      level: lvl,
      msg: message
    };
    if (context && typeof context === 'object') {
      for (const key of Object.keys(context)) {
        if (/api[-_]?key|token|authorization|secret/i.test(key)) continue;
        line[key] = context[key];
      }
    }
    const out = lvl === 'error' ? sink.error : lvl === 'warn' ? sink.warn : sink.log;
    if (typeof out === 'function') out.call(sink, JSON.stringify(line));
  }

  return {
    error: (message, context) => write('error', message, context),
    warn: (message, context) => write('warn', message, context),
    info: (message, context) => write('info', message, context),
    debug: (message, context) => write('debug', message, context)
  };
}

/** Logger that stays quiet; used by the tests. */
const silentLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {}
};

module.exports = { createLogger, silentLogger };
