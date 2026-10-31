'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHunterClient } = require('../src/hunter');
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

test('findEmail uses the LinkedIn handle when it is known', async () => {
  const fetchImpl = sequenceFetch([
    {
      body: {
        data: {
          email: 'Jane.Doe@Brand.com',
          score: 95,
          linkedin_url: 'https://www.linkedin.com/in/jane-doe-4a7c21',
          verification: { status: 'valid' },
          sources: [{ uri: 'https://brand.com/team' }]
        }
      }
    }
  ]);

  const hunter = createHunterClient({ apiKey: 'hunter-key', fetchImpl, logger: silentLogger, retries: 0 });
  const match = await hunter.findEmail({
    linkedinHandle: 'jane-doe-4a7c21',
    domain: 'brand.com',
    firstName: 'Jane',
    lastName: 'Doe'
  });

  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://api.hunter.io/v2/email-finder');
  assert.equal(url.searchParams.get('linkedin_handle'), 'jane-doe-4a7c21');
  assert.equal(url.searchParams.get('domain'), null);
  // The key must never travel in the URL.
  assert.equal(url.searchParams.get('api_key'), null);
  assert.equal(fetchImpl.calls[0].options.headers['X-API-KEY'], 'hunter-key');

  assert.equal(match.email, 'jane.doe@brand.com');
  assert.equal(match.score, 95);
});

test('findEmail falls back to domain + first/last name', async () => {
  const fetchImpl = sequenceFetch([{ body: { data: { email: 'jane@brand.com', score: 80 } } }]);
  const hunter = createHunterClient({ apiKey: 'k', fetchImpl, logger: silentLogger, retries: 0 });

  await hunter.findEmail({
    domain: 'brand.com',
    firstName: 'Jane',
    lastName: 'Doe',
    fullName: 'Jane Doe'
  });

  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.searchParams.get('domain'), 'brand.com');
  assert.equal(url.searchParams.get('first_name'), 'Jane');
  assert.equal(url.searchParams.get('last_name'), 'Doe');
  assert.equal(url.searchParams.get('full_name'), 'Jane Doe');
  assert.equal(url.searchParams.get('linkedin_handle'), null);
});

test('findEmail returns null on a 404 (Hunter has no match)', async () => {
  const fetchImpl = sequenceFetch([
    { status: 404, body: { errors: [{ id: 'not_found', code: 404, details: 'No email found' }] } }
  ]);
  const hunter = createHunterClient({ apiKey: 'k', fetchImpl, logger: silentLogger, retries: 0 });

  const match = await hunter.findEmail({ domain: 'brand.com', firstName: 'Jane', lastName: 'Doe' });
  assert.equal(match, null);
});

test('findEmail needs an identifier', async () => {
  const hunter = createHunterClient({ apiKey: 'k', logger: silentLogger });
  await assert.rejects(
    () => hunter.findEmail({}),
    (err) => err.status === 400 && err.code === 'HUNTER_BAD_INPUT'
  );
});

test('verifyEmail normalises Hunter status and result', async () => {
  const fetchImpl = sequenceFetch([
    {
      body: {
        data: {
          email: 'jane@brand.com',
          status: 'valid',
          result: 'deliverable',
          score: 97,
          disposable: false,
          webmail: false,
          accept_all: false,
          block: false,
          smtp_check: true,
          mx_records: true
        }
      }
    }
  ]);
  const hunter = createHunterClient({ apiKey: 'k', fetchImpl, logger: silentLogger, retries: 0 });

  const verification = await hunter.verifyEmail('jane@brand.com');
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.pathname, '/v2/email-verifier');
  assert.equal(url.searchParams.get('email'), 'jane@brand.com');
  assert.equal(verification.status, 'valid');
  assert.equal(verification.result, 'deliverable');
  assert.equal(verification.smtpCheck, true);
});

test('verifyEmail polls while Hunter answers 202', async () => {
  const fetchImpl = sequenceFetch([
    { status: 202, body: { data: {}, meta: { message: 'Verification in progress' } } },
    { status: 202, body: { data: {}, meta: { message: 'Verification in progress' } } },
    { body: { data: { email: 'jane@brand.com', status: 'valid', result: 'deliverable', score: 90 } } }
  ]);
  const hunter = createHunterClient({
    apiKey: 'k',
    fetchImpl,
    logger: silentLogger,
    retries: 0,
    pollAttempts: 3,
    pollDelayMs: 1
  });

  const verification = await hunter.verifyEmail('jane@brand.com');
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(verification.status, 'valid');
});

test('verifyEmail gives up gracefully when checks stay pending', async () => {
  const fetchImpl = sequenceFetch([{ status: 202, body: { data: {} } }]);
  const hunter = createHunterClient({
    apiKey: 'k',
    fetchImpl,
    logger: silentLogger,
    retries: 0,
    pollAttempts: 2,
    pollDelayMs: 1
  });

  const verification = await hunter.verifyEmail('jane@brand.com');
  assert.equal(verification.status, 'unknown');
  assert.equal(verification.pending, true);
});

test('verifyEmail treats HTTP 451 as blocked instead of throwing', async () => {
  const fetchImpl = sequenceFetch([{ status: 451, body: { errors: [{ details: 'Privacy' }] } }]);
  const hunter = createHunterClient({ apiKey: 'k', fetchImpl, logger: silentLogger, retries: 0 });

  const verification = await hunter.verifyEmail('jane@brand.com');
  assert.equal(verification.block, true);
  assert.equal(verification.status, 'unknown');
});
