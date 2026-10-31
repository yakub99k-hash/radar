'use strict';

/**
 * Error that already knows which HTTP status the API should answer with.
 * `code` is a stable machine readable string the frontend can branch on.
 */
class AppError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.status = options.status || 500;
    this.code = options.code || 'INTERNAL_ERROR';
    this.details = options.details || null;
    if (options.cause) this.cause = options.cause;
  }

  toJSON() {
    return { error: this.message, code: this.code, details: this.details };
  }
}

/**
 * Error raised when Apollo.io or Hunter.io answers with a non 2xx status.
 * `upstreamStatus` lets callers treat "404 no match" differently from "500".
 */
class UpstreamError extends AppError {
  constructor(provider, upstreamStatus, message, options = {}) {
    super(message, {
      status: options.status || 502,
      code: options.code || `${provider.toUpperCase()}_ERROR`,
      details: options.details || null,
      cause: options.cause
    });
    this.name = 'UpstreamError';
    this.provider = provider;
    this.upstreamStatus = upstreamStatus;
    this.data = options.data || null;
    this.retryable = Boolean(options.retryable);
  }
}

module.exports = { AppError, UpstreamError };
