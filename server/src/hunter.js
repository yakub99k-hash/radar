'use strict';

const { AppError } = require('./errors');
const { requestJson, sleep } = require('./http');

/**
 * Hunter.io client: email finder + email verifier.
 * The API key travels in the X-API-KEY header so it never ends up in URLs/logs.
 */
function createHunterClient(options = {}) {
  const apiKey = options.apiKey || '';
  const baseUrl = String(options.baseUrl || 'https://api.hunter.io').replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl;
  const logger = options.logger;
  const timeoutMs = options.timeoutMs || 15000;
  const retries = Number.isFinite(options.retries) ? options.retries : 2;
  const pollAttempts = options.pollAttempts || 3;
  const pollDelayMs = options.pollDelayMs || 1500;
  const provider = 'Hunter';

  function requireKey() {
    if (!apiKey) {
      throw new AppError('Hunter API key is not configured (set HUNTER_API_KEY in .env).', {
        status: 503,
        code: 'HUNTER_KEY_MISSING'
      });
    }
  }

  async function call(pathname, params) {
    requireKey();
    const query = new URLSearchParams();
    Object.keys(params).forEach((key) => {
      const value = params[key];
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
    });
    return requestJson(`${baseUrl}${pathname}?${query.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-API-KEY': apiKey },
      timeoutMs,
      retries,
      fetchImpl,
      logger,
      provider
    });
  }

  function normalizeFinder(data) {
    const body = (data && data.data) || null;
    if (!body || !body.email) return null;
    return {
      email: String(body.email).trim().toLowerCase(),
      score: Number.isFinite(body.score) ? body.score : null,
      position: body.position || null,
      linkedinUrl: body.linkedin_url || null,
      domain: body.domain || null,
      acceptAll: Boolean(body.accept_all),
      verification: body.verification || null,
      sources: Array.isArray(body.sources) ? body.sources.slice(0, 5) : []
    };
  }

  /**
   * Finds the most likely email.
   * A LinkedIn handle is the most precise input; domain + name is the fallback.
   * @returns {Promise<object|null>} null when Hunter has no match (HTTP 404)
   */
  async function findEmail(params = {}) {
    const query = {};
    if (params.linkedinHandle) {
      query.linkedin_handle = params.linkedinHandle;
    } else {
      query.domain = params.domain;
      if (params.firstName) query.first_name = params.firstName;
      if (params.lastName) query.last_name = params.lastName;
      if (params.fullName) query.full_name = params.fullName;
    }
    if (!query.linkedin_handle && !query.domain) {
      throw new AppError('findEmail needs a domain or a LinkedIn handle.', {
        status: 400,
        code: 'HUNTER_BAD_INPUT'
      });
    }

    try {
      const { data } = await call('/v2/email-finder', query);
      return normalizeFinder(data);
    } catch (err) {
      // 404 = Hunter has nothing for this person; that is a normal outcome.
      if (err && err.upstreamStatus === 404) return null;
      throw err;
    }
  }

  function normalizeVerifier(data) {
    const body = (data && data.data) || {};
    return {
      email: body.email || null,
      status: String(body.status || 'unknown').toLowerCase(),
      result: String(body.result || 'unknown').toLowerCase(),
      score: Number.isFinite(body.score) ? body.score : null,
      disposable: body.disposable === true,
      webmail: body.webmail === true,
      acceptAll: body.accept_all === true,
      block: body.block === true,
      smtpCheck: body.smtp_check === true,
      mxRecords: body.mx_records === true
    };
  }

  /**
   * Verifies deliverability. Hunter answers 202 while a check is still running,
   * so we poll a few times before giving up.
   */
  async function verifyEmail(email) {
    if (!email) throw new AppError('verifyEmail needs an email address.', {
      status: 400,
      code: 'HUNTER_BAD_INPUT'
    });

    for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
      let response;
      try {
        response = await call('/v2/email-verifier', { email });
      } catch (err) {
        if (err && err.upstreamStatus === 202) {
          response = { status: 202, data: null };
        } else if (err && (err.upstreamStatus === 222 || err.upstreamStatus === 451)) {
          // 222: verification failed outside Hunter's control, 451: privacy.
          return {
            email,
            status: 'unknown',
            result: 'unknown',
            score: null,
            disposable: false,
            webmail: false,
            acceptAll: false,
            block: err.upstreamStatus === 451,
            smtpCheck: false,
            mxRecords: false,
            pending: err.upstreamStatus === 222
          };
        } else {
          throw err;
        }
      }

      if (response.status !== 202) return normalizeVerifier(response.data);

      if (attempt < pollAttempts) {
        if (logger) logger.debug('Hunter verification pending, polling again', { attempt });
        await sleep(pollDelayMs);
      }
    }

    // Still pending after every attempt: treat as unverified rather than valid.
    return {
      email,
      status: 'unknown',
      result: 'unknown',
      score: null,
      disposable: false,
      webmail: false,
      acceptAll: false,
      block: false,
      smtpCheck: false,
      mxRecords: false,
      pending: true
    };
  }

  return { findEmail, verifyEmail, hasKey: Boolean(apiKey) };
}

module.exports = { createHunterClient };
