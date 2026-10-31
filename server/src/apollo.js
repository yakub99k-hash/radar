'use strict';

const { AppError } = require('./errors');
const { requestJson } = require('./http');

/**
 * Apollo.io client.
 *
 * Two calls are needed because the search endpoint is anonymised:
 *  - POST /mixed_people/api_search  -> 0 credits, gives title + obfuscated name
 *  - POST /people/match             -> 1 credit, gives the real full name + LinkedIn
 */
function createApolloClient(options = {}) {
  const apiKey = options.apiKey || '';
  const baseUrl = String(options.baseUrl || 'https://api.apollo.io/api/v1').replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl;
  const logger = options.logger;
  const timeoutMs = options.timeoutMs || 15000;
  const retries = Number.isFinite(options.retries) ? options.retries : 2;
  const provider = 'Apollo';

  async function post(pathname, payload) {
    if (!apiKey) {
      throw new AppError('Apollo API key is not configured (set APOLLO_API_KEY in .env).', {
        status: 503,
        code: 'APOLLO_KEY_MISSING'
      });
    }
    const { data } = await requestJson(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Api-Key': apiKey
      },
      body: JSON.stringify(payload),
      timeoutMs,
      retries,
      fetchImpl,
      logger,
      provider
    });
    return data && typeof data === 'object' ? data : {};
  }

  /**
   * @param {{domain?: string, titles: string[], perPage?: number, page?: number,
   *          keywords?: string, seniorities?: string[]}} params
   * @returns {Promise<{people: object[], total: number}>}
   */
  async function searchPeople(params = {}) {
    const payload = {
      person_titles: Array.isArray(params.titles) && params.titles.length ? params.titles : undefined,
      include_similar_titles: true,
      per_page: params.perPage || 10,
      page: params.page || 1
    };
    if (params.domain) payload.q_organization_domains_list = [params.domain];
    if (params.keywords) payload.q_keywords = params.keywords;
    if (Array.isArray(params.seniorities) && params.seniorities.length) {
      payload.person_seniorities = params.seniorities;
    }

    const data = await post('/mixed_people/api_search', payload);
    const people = Array.isArray(data.people) ? data.people : [];
    const total =
      Number(data.total_entries) ||
      (data.pagination && Number(data.pagination.total_entries)) ||
      people.length;

    return { people, total };
  }

  /**
   * Reveals the full name and LinkedIn URL for one person id.
   * @returns {Promise<{person: object|null, matchConfidence: string|null}>}
   */
  async function enrichPerson(params = {}) {
    const payload = {
      // Personal emails stay with Hunter; Apollo only supplies name + profile.
      reveal_personal_emails: false
    };
    if (params.id) payload.id = params.id;
    if (params.name) payload.name = params.name;
    if (params.firstName) payload.first_name = params.firstName;
    if (params.lastName) payload.last_name = params.lastName;
    if (params.domain) payload.domain = params.domain;
    if (params.organizationName) payload.organization_name = params.organizationName;
    if (params.linkedinUrl) payload.linkedin_url = params.linkedinUrl;

    const data = await post('/people/match', payload);
    return {
      person: data.person && typeof data.person === 'object' ? data.person : null,
      matchConfidence: data.match_confidence || null
    };
  }

  return { searchPeople, enrichPerson, hasKey: Boolean(apiKey) };
}

module.exports = { createApolloClient };
