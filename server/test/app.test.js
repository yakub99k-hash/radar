'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app');
const { AppError } = require('../src/errors');

/** Every lookup must carry the visitor's own provider + key headers. */
const KEY_HEADERS = { 'x-provider': 'hunter', 'x-api-key': 'user-key-9' };

const baseConfig = {
  trustProxy: true,
  cors: { allowedOrigins: ['https://radar.yaqubu.com'] },
  apollo: { apiKey: 'a' },
  hunter: { apiKey: 'h' },
  auth: { requireAuth: false }
};

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

const FOUND = {
  contact_name: 'Jane Doe',
  title: 'Influencer Marketing Manager',
  email: 'jane@brand.com',
  email_status: 'valid',
  linkedin_url: 'https://www.linkedin.com/in/jane-doe-4a7c21',
  is_fallback: false,
  found: true,
  reason: null,
  message: 'ok',
  meta: { domain: 'brand.com' }
};

test('healthz reports which keys are configured', async () => {
  const config = { ...baseConfig, pipeline: { useApollo: false } };
  const server = await listen(createApp({ config, pipeline: { findContact: async () => FOUND } }));
  try {
    const res = await fetch(`${server.url}/healthz`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.providers, ['hunter', 'prospeo']);
    assert.equal(body.userKeysRequired, true);
    // No server-side Hunter key exists any more, so it is never advertised.
    assert.equal(body.hunter, undefined);
    assert.equal(body.apollo, false);
  } finally {
    await server.close();
  }
});

test('GET /api/brand-contact returns the clean JSON to the frontend', async () => {
  const calls = [];
  const pipeline = {
    async findContact(params) {
      calls.push(params);
      return FOUND;
    }
  };
  const server = await listen(createApp({ config: baseConfig, pipeline }));
  try {
    const res = await fetch(`${server.url}/api/brand-contact?domain=brand.com&brand=Brand`, {
      headers: KEY_HEADERS
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(calls[0], {
      domain: 'brand.com',
      brand: 'Brand',
      provider: 'hunter',
      apiKey: 'user-key-9'
    });
    assert.deepEqual(Object.keys(body).slice(0, 4), [
      'contact_name',
      'title',
      'email',
      'email_status'
    ]);
    assert.equal(body.email, 'jane@brand.com');
  } finally {
    await server.close();
  }
});

test('POST /api/brand-contact also works (JSON body)', async () => {
  const pipeline = { findContact: async () => FOUND };
  const server = await listen(createApp({ config: baseConfig, pipeline }));
  try {
    const res = await fetch(`${server.url}/api/brand-contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...KEY_HEADERS },
      body: JSON.stringify({ domain: 'https://brand.com', brand: 'Brand' })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.contact_name, 'Jane Doe');
  } finally {
    await server.close();
  }
});

test('a missing domain is a clear 400', async () => {
  const server = await listen(createApp({ config: baseConfig, pipeline: { findContact: async () => FOUND } }));
  try {
    const res = await fetch(`${server.url}/api/brand-contact?brand=Brand`);
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.code, 'MISSING_DOMAIN');
    assert.match(body.error, /domain/);
  } finally {
    await server.close();
  }
});

test('AppErrors keep their status, unknown errors become 500', async () => {
  const making = (error) =>
    createApp({
      config: baseConfig,
      pipeline: {
        findContact: async () => {
          throw error;
        }
      }
    });

  let server = await listen(making(new AppError('Apollo API key is not configured', {
    status: 503,
    code: 'APOLLO_KEY_MISSING'
  })));
  try {
    const res = await fetch(`${server.url}/api/brand-contact?domain=brand.com`, {
      headers: KEY_HEADERS
    });
    const body = await res.json();
    assert.equal(res.status, 503);
    assert.equal(body.code, 'APOLLO_KEY_MISSING');
  } finally {
    await server.close();
  }

  server = await listen(making(new Error('kaboom')));
  try {
    const res = await fetch(`${server.url}/api/brand-contact?domain=brand.com`, {
      headers: KEY_HEADERS
    });
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.equal(body.error, 'kaboom');
    assert.equal(body.code, 'INTERNAL_ERROR');
  } finally {
    await server.close();
  }
});

test('CORS only allows the configured origin and answers preflight', async () => {
  const server = await listen(createApp({ config: baseConfig, pipeline: { findContact: async () => FOUND } }));
  try {
    const allowed = await fetch(`${server.url}/api/brand-contact?domain=brand.com`, {
      headers: { Origin: 'https://radar.yaqubu.com', ...KEY_HEADERS }
    });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://radar.yaqubu.com');

    const other = await fetch(`${server.url}/api/brand-contact?domain=brand.com`, {
      headers: { Origin: 'https://evil.example', ...KEY_HEADERS }
    });
    assert.equal(other.headers.get('access-control-allow-origin'), null);

    const preflight = await fetch(`${server.url}/api/brand-contact`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://radar.yaqubu.com' }
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
  } finally {
    await server.close();
  }
});

test('unknown routes 404 as JSON', async () => {
  const server = await listen(createApp({ config: baseConfig, pipeline: { findContact: async () => FOUND } }));
  try {
    const res = await fetch(`${server.url}/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, 'NOT_FOUND');
  } finally {
    await server.close();
  }
});

test("the chosen provider, the visitor's key and the page text reach the pipeline", async () => {
  const calls = [];
  const pipeline = {
    async findContact(params) {
      calls.push(params);
      return FOUND;
    }
  };
  const server = await listen(createApp({ config: baseConfig, pipeline }));
  try {
    const get = await fetch(`${server.url}/api/brand-contact?domain=brand.com&brand=Brand`, {
      headers: { 'x-provider': 'prospeo', 'x-api-key': 'prospeo-key', Origin: 'https://radar.yaqubu.com' }
    });
    assert.equal(get.status, 200);
    assert.deepEqual(calls[0], {
      domain: 'brand.com',
      brand: 'Brand',
      provider: 'prospeo',
      apiKey: 'prospeo-key'
    });

    const post = await fetch(`${server.url}/api/brand-contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...KEY_HEADERS },
      body: JSON.stringify({
        domain: 'brand.com',
        brand: 'Brand',
        pageText: 'p'.repeat(120)
      })
    });
    assert.equal(post.status, 200);
    assert.equal(calls[1].pageText.length, 120);
    assert.equal(calls[1].provider, 'hunter');
    assert.equal(calls[1].apiKey, 'user-key-9');
  } finally {
    await server.close();
  }
});

test('a missing key is a 400 with the "add your own key" message', async () => {
  const calls = [];
  const pipeline = {
    async findContact(params) {
      calls.push(params);
      return FOUND;
    }
  };
  const server = await listen(createApp({ config: baseConfig, pipeline }));
  try {
    const res = await fetch(`${server.url}/api/brand-contact?domain=brand.com&brand=Brand`, {
      headers: { 'x-provider': 'prospeo' }
    });
    const body = await res.json();

    assert.equal(res.status, 400);
    assert.equal(body.code, 'API_KEY_MISSING');
    assert.equal(body.error, 'Please add your own API key first.');
    assert.deepEqual(calls, [], 'the pipeline (and any paid API) was never called');
  } finally {
    await server.close();
  }
});

test('an unknown provider is rejected before any paid call', async () => {
  const server = await listen(createApp({
    config: baseConfig,
    pipeline: { findContact: async () => FOUND }
  }));
  try {
    const res = await fetch(`${server.url}/api/brand-contact?domain=brand.com`, {
      headers: { 'x-provider': 'apollo', 'x-api-key': 'k' }
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.code, 'INVALID_PROVIDER');
  } finally {
    await server.close();
  }
});

test("the old x-hunter-api-key header still works for cached pages", async () => {
  const calls = [];
  const pipeline = {
    async findContact(params) {
      calls.push(params);
      return FOUND;
    }
  };
  const server = await listen(createApp({ config: baseConfig, pipeline }));
  try {
    const res = await fetch(`${server.url}/api/brand-contact?domain=brand.com`, {
      headers: { 'x-hunter-api-key': 'legacy-key' }
    });
    assert.equal(res.status, 200);
    assert.equal(calls[0].provider, 'hunter');
    assert.equal(calls[0].apiKey, 'legacy-key');
  } finally {
    await server.close();
  }
});

test('CORS preflight allows the X-Provider and X-Api-Key headers', async () => {
  const server = await listen(createApp({ config: baseConfig, pipeline: { findContact: async () => FOUND } }));
  try {
    const preflight = await fetch(`${server.url}/api/brand-contact`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://radar.yaqubu.com',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization,x-provider,x-api-key'
      }
    });
    assert.equal(preflight.status, 204);
    const allowed = preflight.headers.get('access-control-allow-headers');
    assert.match(allowed, /X-Provider/);
    assert.match(allowed, /X-Api-Key/);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://radar.yaqubu.com');
  } finally {
    await server.close();
  }
});

