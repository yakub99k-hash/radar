'use strict';

const { AppError, UpstreamError } = require('./errors');
const { requestJson } = require('./http');

/**
 * Prospeo.io client: /search-person finds the people who work at a brand,
 * /enrich-person reveals the verified email of one of them.
 *
 * Every call uses the visitor's own key in the X-KEY header, so no request can
 * spend the site owner's Prospeo credits. The key never travels in the URL.
 *
 * Docs: https://prospeo.io/api-docs (POST only, JSON body, X-KEY header).
 */
function createProspeoClient(options = {}) {
  const apiKey = String(options.apiKey || '').trim();
  const baseUrl = String(options.baseUrl || 'https://api.prospeo.io').replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl;
  const logger = options.logger;
  const timeoutMs = options.timeoutMs || 15000;
  const retries = Number.isFinite(options.retries) ? options.retries : 2;
  const searchLimit = Math.min(Math.max(options.searchLimit || 25, 1), 25);
  const onlyVerifiedEmail = options.onlyVerifiedEmail === true;
  const provider = 'Prospeo';

  function requireKey() {
    if (!apiKey) {
      throw new AppError('Prospeo API key is missing. Please add your own API key first.', {
        status: 400,
        code: 'PROSPEO_KEY_MISSING'
      });
    }
  }

  /** Prospeo puts the reason in `error_code`; turn it into a typed error. */
  function errorFromCode(errorCode, details) {
    const code = String(errorCode || 'UNKNOWN').toUpperCase();
    if (code === 'NO_MATCH') return null;
    if (code === 'INVALID_API_KEY') {
      return new AppError(
        'Prospeo rejected the API key. Save your own Prospeo key in the box above and try again.',
        { status: 401, code: 'PROSPEO_INVALID_KEY', details }
      );
    }
    if (code === 'INSUFFICIENT_CREDITS') {
      return new UpstreamError(provider, 402, 'Prospeo has no credits left for this API key.', {
        code: 'PROSPEO_INSUFFICIENT_CREDITS',
        data: details
      });
    }
    if (code === 'RATE_LIMIT_EXCEEDED' || code === 'RATE_LIMITED') {
      return new UpstreamError(provider, 429, 'Prospeo rate limit reached.', {
        code: 'PROSPEO_429',
        data: details,
        status: 429,
        retryable: true
      });
    }
    return new UpstreamError(provider, 400, `Prospeo rejected the request (${code}).`, {
      code: `PROSPEO_${code}`,
      data: details
    });
  }

  /**
   * POST one endpoint.
   * @returns {Promise<object|null>} the JSON body, or null when Prospeo has no match
   */
  async function post(pathname, body) {
    requireKey();
    let response;
    try {
      response = await requestJson(`${baseUrl}${pathname}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-KEY': apiKey
        },
        body: JSON.stringify(body || {}),
        timeoutMs,
        retries,
        fetchImpl,
        logger,
        provider
      });
    } catch (err) {
      const data = err && err.data;
      const errorCode = data && typeof data.error_code === 'string' ? data.error_code : '';
      if (errorCode) {
        const mapped = errorFromCode(errorCode, data);
        if (!mapped) return null; // NO_MATCH: a normal "nothing found" answer
        throw mapped;
      }
      throw err;
    }

    const data = (response && response.data) || null;
    if (data && data.error) {
      const mapped = errorFromCode(data.error_code, data);
      if (!mapped) return null;
      throw mapped;
    }
    return data;
  }

  /** Prospeo says VERIFIED / UNAVAILABLE; the pipeline speaks Hunter's words. */
  function mapEmailStatus(raw) {
    const status = String(raw || '').trim().toUpperCase();
    if (status === 'VERIFIED') return 'valid';
    if (status === 'INVALID' || status === 'UNDELIVERABLE') return 'invalid';
    if (status === 'ACCEPT_ALL' || status === 'CATCH_ALL') return 'accept_all';
    return 'unknown';
  }

  function textOrNull(value) {
    const text = String(value || '').trim();
    return text || null;
  }

  /** Turns one raw Prospeo person into the flat shape the pipeline ranks. */
  function normalizePerson(person) {
    if (!person || typeof person !== 'object') return null;
    const mailbox = person.email && typeof person.email === 'object' ? person.email : {};
    const email = String(mailbox.email || '').trim().toLowerCase();
    const jobs = Array.isArray(person.job_history) ? person.job_history : [];
    const currentJob = jobs.find((job) => job && job.current) || jobs[0] || null;
    const firstName = textOrNull(person.first_name);
    const lastName = textOrNull(person.last_name);
    return {
      personId: textOrNull(person.person_id),
      firstName,
      lastName,
      fullName:
        textOrNull(person.full_name) || [firstName, lastName].filter(Boolean).join(' ') || null,
      title: textOrNull(person.current_job_title) || textOrNull(currentJob && currentJob.title),
      linkedinUrl: textOrNull(person.linkedin_url),
      seniority: textOrNull(currentJob && currentJob.seniority),
      email: email.includes('@') ? email : null,
      emailStatus: mapEmailStatus(mailbox.status),
      verificationMethod: textOrNull(mailbox.verification_method),
      mxProvider: textOrNull(mailbox.email_mx_provider)
    };
  }

  /**
   * People currently working at the brand.
   * Search results never include emails; call enrichPerson() for that.
   *
   * @param {{domain?: string, brand?: string, page?: number}} params
   * @returns {Promise<Array<object>>} normalised people (never null)
   */
  async function searchPeople(params = {}) {
    const domain = textOrNull(params.domain);
    const brand = textOrNull(params.brand);
    if (!domain && !brand) {
      throw new AppError('searchPeople needs a domain or a brand name.', {
        status: 400,
        code: 'PROSPEO_BAD_INPUT'
      });
    }

    // A domain is exact; the brand name is only used when no domain is known.
    const company = domain ? { websites: { include: [domain] } } : { names: { include: [brand] } };
    const body = { page: Math.max(parseInt(params.page, 10) || 1, 1), filters: { company } };

    const data = await post('/search-person', body);
    const results = data && Array.isArray(data.results) ? data.results : [];
    const people = results
      .map(normalizePerson)
      .filter(Boolean)
      .filter((person) => person.personId);
    return people.slice(0, searchLimit);
  }

  /**
   * Reveals the verified email of one person (1 credit when an email is found).
   * A person_id from searchPeople() is enough to identify the record.
   *
   * @param {{personId?: string, firstName?: string, lastName?: string,
   *          fullName?: string, linkedinUrl?: string, domain?: string,
   *          brand?: string}} params
   * @returns {Promise<object|null>} normalised person with an email, or null
   */
  async function enrichPerson(params = {}) {
    const personId = textOrNull(params.personId);
    const domain = textOrNull(params.domain);
    const brand = textOrNull(params.brand);
    const data = {};
    if (personId) {
      data.person_id = personId;
    } else {
      // Without a person_id Prospeo needs a name (or LinkedIn URL) plus the company.
      if (textOrNull(params.linkedinUrl)) data.linkedin_url = textOrNull(params.linkedinUrl);
      if (textOrNull(params.firstName)) data.first_name = textOrNull(params.firstName);
      if (textOrNull(params.lastName)) data.last_name = textOrNull(params.lastName);
      if (textOrNull(params.fullName)) data.full_name = textOrNull(params.fullName);
      if (!data.linkedin_url && !data.full_name && !(data.first_name && data.last_name)) {
        throw new AppError(
          'enrichPerson needs a person_id, a LinkedIn URL, an email or a full name.',
          { status: 400, code: 'PROSPEO_BAD_INPUT' }
        );
      }
    }
    if (domain) data.company_website = domain;
    if (brand) data.company_name = brand;

    const response = await post('/enrich-person', {
      only_verified_email: onlyVerifiedEmail,
      enrich_mobile: false,
      data
    });
    if (!response) return null;
    const person = normalizePerson(response.person);
    if (!person || !person.email) return null;
    return { ...person, free: response.free_enrichment === true };
  }

  return { searchPeople, enrichPerson, hasKey: Boolean(apiKey) };
}

module.exports = { createProspeoClient };
