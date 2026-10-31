'use strict';

const { AppError } = require('./errors');
const { requestJson, sleep } = require('./http');

/**
 * Hunter.io client: domain search + email finder + email verifier.
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

  function normalizeDomainSearchEmail(item) {
    if (!item || typeof item !== 'object') return null;
    // Domain search calls the address "value"; the finder calls it "email".
    const email = String(item.value || item.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return null;
    const linkedinUrl = item.linkedin || item.linkedin_url || null;
    return {
      email,
      type: String(item.type || 'personal').toLowerCase(),
      confidence: Number.isFinite(item.confidence) ? item.confidence : null,
      firstName: item.first_name || null,
      lastName: item.last_name || null,
      position: item.position || null,
      seniority: item.seniority || null,
      department: item.department || null,
      linkedinUrl,
      // Domain search usually reports a verification status already.
      verification: item.verification || null,
      sources: Array.isArray(item.sources) ? item.sources.slice(0, 5) : []
    };
  }

  function normalizeDomainSearch(data) {
    const body = (data && data.data) || null;
    if (!body || typeof body !== 'object') return null;
    const emails = Array.isArray(body.emails) ? body.emails : [];
    return {
      domain: body.domain || null,
      organization: body.organization || null,
      pattern: body.pattern || null,
      acceptAll: body.accept_all === true,
      disposable: body.disposable === true,
      webmail: body.webmail === true,
      emails: emails.map(normalizeDomainSearchEmail).filter(Boolean)
    };
  }

  /**
   * Lists every address Hunter knows for a domain. This is the workhorse when
   * Apollo is unavailable: one call returns people, titles, LinkedIn profiles and
   * often an email verification status, so only a few verifier calls are needed.
   *
   * @param {{domain: string, limit?: number, offset?: number, type?: string,
   *          seniority?: string, department?: string}} params
   * @returns {Promise<object|null>} null when Hunter has nothing (HTTP 404)
   */
  async function domainSearch(params = {}) {
    if (!params.domain) {
      throw new AppError('domainSearch needs a domain.', {
        status: 400,
        code: 'HUNTER_BAD_INPUT'
      });
    }

    const query = { domain: params.domain };
    if (params.limit) query.limit = params.limit;
    if (params.offset) query.offset = params.offset;
    if (params.type) query.type = params.type;
    if (params.seniority) query.seniority = params.seniority;
    if (params.department) query.department = params.department;

    try {
      const { data } = await call('/v2/domain-search', query);
      return normalizeDomainSearch(data);
    } catch (err) {
      // 404 = Hunter has no addresses for this domain; a normal outcome.
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

  return { findEmail, domainSearch, verifyEmail, hasKey: Boolean(apiKey) };
}

module.exports = { createHunterClient };
