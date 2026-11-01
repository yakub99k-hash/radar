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
 * Every lookup runs on the key the visitor pasted in the browser. When that key
 * is missing the API answers with this wording, which the frontend shows as-is,
 * instead of silently spending the site owner's own credits.
 */
const MISSING_USER_KEY_MESSAGE = 'Please add your own API key first.';

/**
 * Shown on the brand card when Hunter refuses a call because the plan/credit
 * balance is exhausted. Wording is fixed because the frontend displays it as-is.
 */
const CREDIT_LIMIT_MESSAGE = 'API Limit Reached - Please add your own Hunter key';

/** Same message for the second provider, so the card names the right product. */
const PROSPEO_CREDIT_LIMIT_MESSAGE = 'API Limit Reached - Please add your own Prospeo key';

const CREDIT_LIMIT_MESSAGES = Object.freeze({
  hunter: CREDIT_LIMIT_MESSAGE,
  prospeo: PROSPEO_CREDIT_LIMIT_MESSAGE
});

/** Normalises "Hunter", "PROSPEO" ... to the canonical provider id. */
function normalizeProviderName(value) {
  const name = String(value || '').trim().toLowerCase();
  if (name === 'prospeo') return 'prospeo';
  return 'hunter';
}

function creditLimitMessage(provider) {
  return CREDIT_LIMIT_MESSAGES[normalizeProviderName(provider)] || CREDIT_LIMIT_MESSAGE;
}

/**
 * True when the provider failed because the account has no credits/quota left,
 * so the user needs to supply their own key (the frontend shows the message from
 * creditLimitMessage()). 402 is Hunter's "payment required"; 429 is both
 * providers' rate/credit limit. Prospeo reports INSUFFICIENT_CREDITS in the body.
 */
function isCreditLimitError(err) {
  if (!err) return false;
  const status = Number(err.upstreamStatus || err.status || 0);
  const text = `${err.code || ''} ${err.message || ''}`;
  const provider = String(err.provider || '').toLowerCase();
  const fromHunter = provider === 'hunter' || (!provider && /hunter/i.test(text));
  const fromProspeo = provider === 'prospeo' || (!provider && /prospeo/i.test(text));
  if (!fromHunter && !fromProspeo) return false;
  if (status === 402 || status === 429) return true;
  if (/INSUFFICIENT_CREDITS|insufficient_credits/i.test(text)) return true;
  return /credit|quota|balance|plan limit|upgrade/i.test(text);
}

module.exports = {
  AppError,
  UpstreamError,
  isCreditLimitError,
  creditLimitMessage,
  normalizeProviderName,
  MISSING_USER_KEY_MESSAGE,
  CREDIT_LIMIT_MESSAGE,
  PROSPEO_CREDIT_LIMIT_MESSAGE,
  CREDIT_LIMIT_MESSAGES
};
