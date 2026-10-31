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

/**
 * Shown on the brand card when Hunter refuses a call because the plan/credit
 * balance is exhausted. Wording is fixed because the frontend displays it as-is.
 */
const CREDIT_LIMIT_MESSAGE = 'API Limit Reached - Please add your own Hunter key';

/**
 * True when Hunter failed because the account has no credits/quota left, so the
 * user needs to supply their own key (the frontend shows CREDIT_LIMIT_MESSAGE).
 * 402 is Hunter's "payment required"; 429 is its rate/credit limit.
 */
function isCreditLimitError(err) {
  if (!err) return false;
  const status = Number(err.upstreamStatus || err.status || 0);
  const text = `${err.code || ''} ${err.message || ''}`;
  const fromHunter = String(err.provider || '').toLowerCase() === 'hunter' || /hunter/i.test(text);
  if (!fromHunter) return false;
  if (status === 402 || status === 429) return true;
  return /credit|quota|balance|plan limit|upgrade/i.test(text);
}

module.exports = { AppError, UpstreamError, isCreditLimitError, CREDIT_LIMIT_MESSAGE };
