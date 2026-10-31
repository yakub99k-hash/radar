'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApolloClient } = require('../src/apollo');
const { silentLogger } = require('../src/logger');

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(body)
  };
}

function recordingFetch(responseBody, status = 200) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(responseBody, status);
  };
  fn.calls = calls;
  return fn;
}

test('searchPeople posts the domain + titles Apollo expects', async () => {
  const fetchImpl = recordingFetch({
    people: [{ id: 'p1', first_name: 'Jane', last_name_obfuscated: 'Do***e', title: 'Influencer Marketing Manager', has_email: true }],
    total_entries: 1
  });

  const apollo = createApolloClient({
    apiKey: 'test-key',
    fetchImpl,
    logger: silentLogger,
    retries: 0
  });

  const result = await apollo.searchPeople({
    domain: 'brand.com',
    titles: ['Influencer Marketing', 'Partnerships'],
    perPage: 10
  });

  assert.equal(fetchImpl.calls.length, 1);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://api.apollo.io/api/v1/mixed_people/api_search');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['X-Api-Key'], 'test-key');

  const body = JSON.parse(options.body);
  assert.deepEqual(body.q_organization_domains_list, ['brand.com']);
  assert.deepEqual(body.person_titles, ['Influencer Marketing', 'Partnerships']);
  assert.equal(body.include_similar_titles, true);
  assert.equal(body.per_page, 10);
  assert.equal(body.page, 1);

  assert.equal(result.total, 1);
  assert.equal(result.people.length, 1);
  assert.equal(result.people[0].title, 'Influencer Marketing Manager');
});

test('searchPeople supports the keyword fallback without a domain', async () => {
  const fetchImpl = recordingFetch({ people: [] });
  const apollo = createApolloClient({ apiKey: 'k', fetchImpl, logger: silentLogger, retries: 0 });

  await apollo.searchPeople({ titles: ['Partnerships'], keywords: 'Acme Bikes' });

  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.equal(body.q_keywords, 'Acme Bikes');
  assert.equal(body.q_organization_domains_list, undefined);
  // q_organization_name is a *company* search parameter, never sent here.
  assert.equal(body.q_organization_name, undefined);
});

test('enrichPerson reveals the name and LinkedIn profile by id', async () => {
  const fetchImpl = recordingFetch({
    person: {
      id: 'p1',
      name: 'Jane Doe',
      title: 'Influencer Marketing Manager',
      linkedin_url: 'https://www.linkedin.com/in/jane-doe-4a7c21'
    },
    match_confidence: 'high'
  });

  const apollo = createApolloClient({ apiKey: 'k', fetchImpl, logger: silentLogger, retries: 0 });
  const result = await apollo.enrichPerson({ id: 'p1', domain: 'brand.com', linkedinUrl: null });

  assert.equal(fetchImpl.calls[0].url, 'https://api.apollo.io/api/v1/people/match');
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.equal(body.id, 'p1');
  assert.equal(body.domain, 'brand.com');
  assert.equal(body.reveal_personal_emails, false);
  assert.equal(body.linkedin_url, undefined);

  assert.equal(result.person.name, 'Jane Doe');
  assert.equal(result.person.linkedin_url, 'https://www.linkedin.com/in/jane-doe-4a7c21');
  assert.equal(result.matchConfidence, 'high');
});

test('missing API key fails fast with a helpful 503', async () => {
  const apollo = createApolloClient({ apiKey: '', logger: silentLogger });
  await assert.rejects(
    () => apollo.searchPeople({ domain: 'brand.com', titles: ['Partnerships'] }),
    (err) => err.status === 503 && err.code === 'APOLLO_KEY_MISSING'
  );
});

test('a rejected key surfaces a readable error', async () => {
  const fetchImpl = recordingFetch({ error: 'Invalid API key' }, 401);
  const apollo = createApolloClient({ apiKey: 'bad', fetchImpl, logger: silentLogger, retries: 0 });

  await assert.rejects(
    () => apollo.searchPeople({ domain: 'brand.com', titles: ['Partnerships'] }),
    (err) => {
      assert.equal(err.provider, 'Apollo');
      assert.equal(err.upstreamStatus, 401);
      assert.match(err.message, /rejected the API key/i);
      return true;
    }
  );
});
