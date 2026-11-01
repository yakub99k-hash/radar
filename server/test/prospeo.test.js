'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createProspeoClient } = require('../src/prospeo');
const { isCreditLimitError } = require('../src/errors');
const { silentLogger } = require('../src/logger');

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(body)
  };
}

function sequenceFetch(responses) {
  const calls = [];
  let index = 0;
  const fn = async (url, options) => {
    calls.push({ url, options });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return jsonResponse(next.body, next.status);
  };
  fn.calls = calls;
  return fn;
}

const PERSON = {
  person_id: 'pid1',
  first_name: 'Lee',
  last_name: 'Ann',
  full_name: 'Lee Ann',
  current_job_title: 'Partnerships Manager',
  linkedin_url: 'https://www.linkedin.com/in/lee-ann-1a2b3c',
  job_history: [
    { title: 'Partnerships Manager', current: true, seniority: 'Senior' },
    { title: 'Marketing Assistant', current: false, seniority: 'Entry' }
  ],
  email: {
    status: 'VERIFIED',
    revealed: true,
    email: 'Lee.Ann@Brand.com',
    verification_method: 'SMTP',
    email_mx_provider: 'Google'
  }
};

test('searchPeople posts the company website filter with the X-KEY header', async () => {
  const fetchImpl = sequenceFetch([{ body: { error: false, results: [PERSON] } }]);
  const prospeo = createProspeoClient({
    apiKey: 'prospeo-key',
    fetchImpl,
    logger: silentLogger,
    retries: 0
  });

  const people = await prospeo.searchPeople({ domain: 'brand.com' });

  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://api.prospeo.io/search-person');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['X-KEY'], 'prospeo-key');
  assert.equal(options.headers['Content-Type'], 'application/json');
  // The key must never travel in the URL.
  assert.equal(url.includes('prospeo-key'), false);

  const body = JSON.parse(options.body);
  assert.deepEqual(body.filters.company.websites.include, ['brand.com']);
  assert.equal(body.page, 1);

  assert.equal(people.length, 1);
  assert.equal(people[0].personId, 'pid1');
  assert.equal(people[0].fullName, 'Lee Ann');
  assert.equal(people[0].title, 'Partnerships Manager');
  assert.equal(people[0].email, 'lee.ann@brand.com');
  assert.equal(people[0].emailStatus, 'valid');
});

test('searchPeople falls back to the brand name without a domain', async () => {
  const fetchImpl = sequenceFetch([{ body: { error: false, results: [] } }]);
  const prospeo = createProspeoClient({ apiKey: 'k', fetchImpl, logger: silentLogger, retries: 0 });

  await prospeo.searchPeople({ brand: 'Brand' });

  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.deepEqual(body.filters.company.names.include, ['Brand']);
});

test('searchPeople drops rows without a person_id', async () => {
  const fetchImpl = sequenceFetch([
    { body: { error: false, results: [{ full_name: 'No Id' }, { person_id: 'pid2' }] } }
  ]);
  const prospeo = createProspeoClient({ apiKey: 'k', fetchImpl, logger: silentLogger, retries: 0 });

  const people = await prospeo.searchPeople({ domain: 'brand.com' });
  assert.deepEqual(people.map((person) => person.personId), ['pid2']);
});

test('searchPeople turns NO_MATCH into an empty list', async () => {

test('an invalid key is a clear 401 instead of a generic upstream error', async () => {
  const fetchImpl = sequenceFetch([
    { status: 400, body: { error: true, error_code: 'INVALID_API_KEY' } }
  ]);
  const prospeo = createProspeoClient({ apiKey: 'bad', fetchImpl, logger: silentLogger, retries: 0 });

  await assert.rejects(
    () => prospeo.searchPeople({ domain: 'brand.com' }),
    (err) => err.status === 401 && err.code === 'PROSPEO_INVALID_KEY'
  );
});

test('an exhausted plan is a credit limit error, not a generic failure', async () => {
  const fetchImpl = sequenceFetch([
    { status: 400, body: { error: true, error_code: 'INSUFFICIENT_CREDITS' } }
  ]);
  const prospeo = createProspeoClient({ apiKey: 'k', fetchImpl, logger: silentLogger, retries: 0 });

  await assert.rejects(
    () => prospeo.searchPeople({ domain: 'brand.com' }),
    (err) => isCreditLimitError(err) === true && err.code === 'PROSPEO_INSUFFICIENT_CREDITS'
  );
});

test('enrichPerson sends the person_id and never asks for a mobile', async () => {
  const fetchImpl = sequenceFetch([
    { body: { error: false, free_enrichment: true, person: PERSON } }
  ]);
  const prospeo = createProspeoClient({ apiKey: 'k', fetchImpl, logger: silentLogger, retries: 0 });

  const person = await prospeo.enrichPerson({ personId: 'pid1', domain: 'brand.com', brand: 'Brand' });

  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://api.prospeo.io/enrich-person');
  const body = JSON.parse(options.body);
  assert.equal(body.data.person_id, 'pid1');
  assert.equal(body.data.company_website, 'brand.com');
  assert.equal(body.data.company_name, 'Brand');
  assert.equal(body.enrich_mobile, false);
  assert.equal(body.only_verified_email, false);

  assert.equal(person.email, 'lee.ann@brand.com');
  assert.equal(person.emailStatus, 'valid');
  assert.equal(person.verificationMethod, 'SMTP');
  assert.equal(person.free, true);
});

test('enrichPerson returns null on NO_MATCH (nothing found)', async () => {
  const fetchImpl = sequenceFetch([{ status: 400, body: { error: true, error_code: 'NO_MATCH' } }]);
  const prospeo = createProspeoClient({ apiKey: 'k', fetchImpl, logger: silentLogger, retries: 0 });

  assert.equal(await prospeo.enrichPerson({ personId: 'pid1' }), null);
});

test('enrichPerson refuses to run without enough datapoints', async () => {
  const prospeo = createProspeoClient({ apiKey: 'k', logger: silentLogger, retries: 0 });
  await assert.rejects(
    () => prospeo.enrichPerson({ firstName: 'Lee' }),
    (err) => err.status === 400 && err.code === 'PROSPEO_BAD_INPUT'
  );
});

test('a client without a key refuses every call', async () => {
  const prospeo = createProspeoClient({ logger: silentLogger });
  await assert.rejects(
    () => prospeo.searchPeople({ domain: 'brand.com' }),
    (err) => err.status === 400 && err.code === 'PROSPEO_KEY_MISSING'
  );
  assert.equal(prospeo.hasKey, false);
});

test('UNAVAILABLE emails are reported as unknown, never as valid', async () => {
  const fetchImpl = sequenceFetch([
    {
      body: {
        error: false,
        person: { ...PERSON, email: { status: 'UNAVAILABLE', revealed: false, email: null } }
      }
    }
  ]);
  const prospeo = createProspeoClient({ apiKey: 'k', fetchImpl, logger: silentLogger, retries: 0 });

  assert.equal(await prospeo.enrichPerson({ personId: 'pid1' }), null, 'no address returned');
});

  const fetchImpl = sequenceFetch([{ status: 400, body: { error: true, error_code: 'NO_MATCH' } }]);
  const prospeo = createProspeoClient({ apiKey: 'k', fetchImpl, logger: silentLogger, retries: 0 });

  assert.deepEqual(await prospeo.searchPeople({ domain: 'brand.com' }), []);
});
