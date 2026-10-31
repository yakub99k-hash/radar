'use strict';

const { AppError, UpstreamError } = require('./errors');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(headerValue) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(headerValue);
  return Number.isNaN(when) ? null : Math.max(0, when - Date.now());
}

/** Pulls the most useful message out of an Apollo/Hunter error body. */
function extractMessage(data, fallback) {
  if (!data || typeof data !== 'object') return fallback;
  if (typeof data.error === 'string' && data.error) return data.error;
  if (data.error && typeof data.error === 'object' && data.error.message) {
    return String(data.error.message);
  }
  if (Array.isArray(data.errors) && data.errors.length) {
    const first = data.errors[0];
    if (typeof first === 'string') return first;
    if (first && (first.details || first.message || first.title)) {
      return String(first.details || first.message || first.title);
    }
  }
  if (typeof data.message === 'string' && data.message) return data.message;
  return fallback;
}

function friendlyMessage(provider, status, data) {
  const raw = extractMessage(data, '');
  if (status === 401) {
    return `${provider} rejected the API key. Check the key in your .env file.`;
  }
  if (status === 403) {
    return raw || `${provider} API key is not allowed to use this endpoint (check its scopes/plan).`;
  }
  if (status === 429) {
    return `${provider} rate limit or credit limit reached. Try again later.`;
  }
  if (status === 422 || status === 400) {
    return raw || `${provider} rejected the request parameters.`;
  }
  return raw || `${provider} answered with HTTP ${status}.`;
}

/**
 * JSON request with timeout, bounded retries and typed errors.
 * All outbound calls in this service go through here so behaviour is uniform.
 *
 * @returns {Promise<{status:number, data:any, headers:Headers}>}
 * @throws {UpstreamError} for every non 2xx answer (including 404, so callers
 *   can inspect `upstreamStatus`).
 */
async function requestJson(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 15000,
    retries = 2,
    retryBaseMs = 400,
    maxRetryWaitMs = 5000,
    fetchImpl = globalThis.fetch,
    logger,
    provider = 'upstream'
  } = options;

  if (typeof fetchImpl !== 'function') {
    throw new AppError('No fetch implementation available (Node 18+ required).', {
      status: 500,
      code: 'FETCH_UNAVAILABLE'
    });
  }

  let lastError = null;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    let response;
    try {
      const signal =
        typeof AbortSignal !== 'undefined' && AbortSignal.timeout
          ? AbortSignal.timeout(timeoutMs)
          : undefined;
      response = await fetchImpl(url, { method, headers, body, signal });
    } catch (err) {
      lastError = new UpstreamError(
        provider,
        0,
        `${provider} could not be reached (${err && err.message ? err.message : 'network error'}).`,
        { code: `${provider.toUpperCase()}_UNREACHABLE`, status: 504, cause: err, retryable: true }
      );
      if (attempt > retries) break;
      await sleep(Math.min(retryBaseMs * 2 ** (attempt - 1), maxRetryWaitMs));
      continue;
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (err) {
        data = { raw: text.slice(0, 500) };
      }
    }

    if (response.ok) {
      return { status: response.status, data, headers: response.headers };
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt <= retries) {
      const wait =
        retryAfterMs(response.headers.get && response.headers.get('retry-after')) ??
        retryBaseMs * 2 ** (attempt - 1);
      if (logger) {
        logger.warn('retrying upstream request', {
          provider,
          status: response.status,
          attempt,
          wait_ms: Math.min(wait, maxRetryWaitMs)
        });
      }
      await sleep(Math.min(wait, maxRetryWaitMs));
      lastError = new UpstreamError(provider, response.status, friendlyMessage(provider, response.status, data), {
        code: `${provider.toUpperCase()}_${response.status}`,
        data,
        retryable: true
      });
      continue;
    }

    throw new UpstreamError(
      provider,
      response.status,
      friendlyMessage(provider, response.status, data),
      {
        code: `${provider.toUpperCase()}_${response.status}`,
        data,
        status: response.status === 429 ? 429 : 502,
        retryable
      }
    );
  }

  throw (
    lastError ||
    new UpstreamError(provider, 0, `${provider} request failed.`, {
      code: `${provider.toUpperCase()}_FAILED`
    })
  );
}

module.exports = { requestJson, extractMessage, sleep, retryAfterMs };
