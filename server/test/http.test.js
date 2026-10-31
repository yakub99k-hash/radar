'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { requestJson, extractMessage, retryAfterMs } = require('../src/http');
const { silentLogger } = require('../src/logger');

function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

test('extractMessage understands Apollo and Hunter error shapes', () => {
  assert.equal(extractMessage({ error: 'bad key' }, 'fallback'), 'bad key');
  assert.equal(extractMessage({ error: { message: 'nested' } }, 'fallback'), 'nested');
  assert.equal(extractMessage({ errors: [{ details: 'No email' }] }, 'fallback'), 'No email');
  assert.equal(extractMessage({ errors: ['plain'] }, 'fallback'), 'plain');
  assert.equal(extractMessage({ message: 'hello' }, 'fallback'), 'hello');
  assert.equal(extractMessage(null, 'fallback'), 'fallback');
  assert.equal(extractMessage({ raw: '<html>' }, 'fallback'), 'fallback');
});

test('retryAfterMs parses seconds and HTTP dates', () => {
  assert.equal(retryAfterMs('2'), 2000);
  assert.equal(retryAfterMs(null), null);
  const when = new Date(Date.now() + 3000).toUTCString();
  const parsed = retryAfterMs(when);
  assert.ok(parsed > 1000 && parsed <= 3000);
});

test('429 is retried and the next success is returned', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) return jsonResponse({ message: 'slow down' }, 429, { 'retry-after': '0' });
    return jsonResponse({ ok: true });
  };

  const result = await requestJson('https://example.test/x', {
    fetchImpl,
    logger: silentLogger,
    retries: 2,
    retryBaseMs: 1,
    provider: 'Test'
  });

  assert.equal(attempts, 2);
  assert.deepEqual(result.data, { ok: true });
});

test('server errors are retried, then surfaced as a typed error', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return jsonResponse({ message: 'boom' }, 500);
  };

  await assert.rejects(
    () =>
      requestJson('https://example.test/x', {
        fetchImpl,
        logger: silentLogger,
        retries: 1,
        retryBaseMs: 1,
        provider: 'Hunter'
      }),
    (err) => {
      assert.equal(err.provider, 'Hunter');
      assert.equal(err.upstreamStatus, 500);
      assert.equal(err.code, 'HUNTER_500');
      return true;
    }
  );
  assert.equal(attempts, 2);
});

test('client errors are not retried and carry the upstream body', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return jsonResponse({ errors: [{ details: 'No email found' }] }, 404);
  };

  await assert.rejects(
    () =>
      requestJson('https://example.test/x', {
        fetchImpl,
        logger: silentLogger,
        retries: 2,
        provider: 'Hunter'
      }),
    (err) => err.upstreamStatus === 404 && err.message === 'No email found'
  );
  assert.equal(attempts, 1);
});

test('network failures become a 504 and never hang', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };

  await assert.rejects(
    () =>
      requestJson('https://example.test/x', {
        fetchImpl,
        logger: silentLogger,
        retries: 0,
        provider: 'Apollo'
      }),
    (err) => err.status === 504 && err.code === 'APOLLO_UNREACHABLE'
  );
});

test('non JSON bodies do not crash the parser', async () => {
  const fetchImpl = async () => jsonResponse('<html>oops</html>', 200);
  const result = await requestJson('https://example.test/x', { fetchImpl, provider: 'Test' });
  assert.equal(result.data.raw, '<html>oops</html>');
});
