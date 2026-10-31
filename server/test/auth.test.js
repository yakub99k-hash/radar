'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAuthMiddleware } = require('../src/auth');
const { silentLogger } = require('../src/logger');

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(body)
  };
}

function run(middleware, headers = {}) {
  return new Promise((resolve) => {
    const req = { headers };
    const res = {};
    middleware(req, res, (err) => resolve({ err, req }));
  });
}

test('auth is skipped while REQUIRE_AUTH is off', async () => {
  let fetched = false;
  const middleware = createAuthMiddleware({
    requireAuth: false,
    firebaseWebApiKey: 'key',
    fetchImpl: async () => {
      fetched = true;
      return jsonResponse({});
    },
    logger: silentLogger
  });

  const { err, req } = await run(middleware, {});
  assert.equal(err, undefined);
  assert.equal(req.user, null);
  assert.equal(fetched, false);
});

test('a missing bearer token is rejected with 401', async () => {
  const middleware = createAuthMiddleware({
    requireAuth: true,
    firebaseWebApiKey: 'key',
    logger: silentLogger
  });
  const { err } = await run(middleware, {});
  assert.equal(err.status, 401);
  assert.equal(err.code, 'UNAUTHENTICATED');
});

test('a valid Firebase token becomes req.user', async () => {
  const calls = [];
  const middleware = createAuthMiddleware({
    requireAuth: true,
    firebaseWebApiKey: 'web-key',
    logger: silentLogger,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ users: [{ localId: 'uid-1', email: 'me@example.com', emailVerified: true }] });
    }
  });

  const { err, req } = await run(middleware, { authorization: 'Bearer token-123' });
  assert.equal(err, undefined);
  assert.deepEqual(req.user, { uid: 'uid-1', email: 'me@example.com', emailVerified: true });
  assert.match(calls[0].url, /accounts:lookup\?key=web-key/);
  assert.equal(JSON.parse(calls[0].options.body).idToken, 'token-123');
});

test('an expired token is a 401, Firebase being down is a 503', async () => {
  const rejected = createAuthMiddleware({
    requireAuth: true,
    firebaseWebApiKey: 'k',
    logger: silentLogger,
    fetchImpl: async () => jsonResponse({ error: { message: 'INVALID_ID_TOKEN' } }, 400)
  });
  const first = await run(rejected, { authorization: 'Bearer bad' });
  assert.equal(first.err.status, 401);
  assert.equal(first.err.code, 'INVALID_TOKEN');

  const offline = createAuthMiddleware({
    requireAuth: true,
    firebaseWebApiKey: 'k',
    logger: silentLogger,
    fetchImpl: async () => {
      throw new Error('ENOTFOUND');
    }
  });
  const second = await run(offline, { authorization: 'Bearer token' });
  assert.equal(second.err.status, 503);
  assert.equal(second.err.code, 'AUTH_UNAVAILABLE');
});

test('REQUIRE_AUTH without a Firebase key fails loudly', async () => {
  const middleware = createAuthMiddleware({ requireAuth: true, logger: silentLogger });
  const { err } = await run(middleware, { authorization: 'Bearer token' });
  assert.equal(err.status, 503);
  assert.equal(err.code, 'AUTH_NOT_CONFIGURED');
});
