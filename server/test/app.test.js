'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app');
const { AppError } = require('../src/errors');

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
  const server = await listen(createApp({ config: baseConfig, pipeline: { findContact: async () => FOUND } }));
  try {
    const res = await fetch(`${server.url}/healthz`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.apollo, true);
    assert.equal(body.hunter, true);
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
    const res = await fetch(`${server.url}/api/brand-contact?domain=brand.com&brand=Brand`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(calls[0], { domain: 'brand.com', brand: 'Brand' });
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
      headers: { 'Content-Type': 'application/json' },
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
    const res = await fetch(`${server.url}/api/brand-contact?domain=brand.com`);
    const body = await res.json();
    assert.equal(res.status, 503);
    assert.equal(body.code, 'APOLLO_KEY_MISSING');
  } finally {
    await server.close();
  }

  server = await listen(making(new Error('kaboom')));
  try {
    const res = await fetch(`${server.url}/api/brand-contact?domain=brand.com`);
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
      headers: { Origin: 'https://radar.yaqubu.com' }
    });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://radar.yaqubu.com');

    const other = await fetch(`${server.url}/api/brand-contact?domain=brand.com`, {
      headers: { Origin: 'https://evil.example' }
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

test("a user's Hunter key and page text reach the pipeline", async () => {
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
      headers: { 'x-hunter-api-key': 'user-key-9', Origin: 'https://radar.yaqubu.com' }
    });
    assert.equal(get.status, 200);
    assert.equal(calls[0].hunterApiKey, 'user-key-9');
    assert.deepEqual(Object.keys(calls[0]).sort(), ['brand', 'domain', 'hunterApiKey']);

    const post = await fetch(`${server.url}/api/brand-contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hunter-api-key': 'user-key-9' },
      body: JSON.stringify({
        domain: 'brand.com',
        brand: 'Brand',
        pageText: 'p'.repeat(120)
      })
    });
    assert.equal(post.status, 200);
    assert.equal(calls[1].pageText.length, 120);
    assert.equal(calls[1].hunterApiKey, 'user-key-9');
  } finally {
    await server.close();
  }
});

test('without the header the pipeline gets no per-request key', async () => {
  const calls = [];
  const pipeline = {
    async findContact(params) {
      calls.push(params);
      return FOUND;
    }
  };
  const server = await listen(createApp({ config: baseConfig, pipeline }));
  try {
    await fetch(`${server.url}/api/brand-contact?domain=brand.com&brand=Brand`);
    assert.deepEqual(calls[0], { domain: 'brand.com', brand: 'Brand' });
  } finally {
    await server.close();
  }
});

test('ALLOW_USER_HUNTER_KEY=false ignores a browser key', async () => {
  const calls = [];
  const pipeline = {
    async findContact(params) {
      calls.push(params);
      return FOUND;
    }
  };
  const config = { ...baseConfig, hunter: { apiKey: 'h', allowUserKey: false } };
  const server = await listen(createApp({ config, pipeline }));
  try {
    await fetch(`${server.url}/api/brand-contact?domain=brand.com`, {
      headers: { 'x-hunter-api-key': 'ignored-key' }
    });
    assert.deepEqual(calls[0], { domain: 'brand.com', brand: '' });
  } finally {
    await server.close();
  }
});

test('CORS preflight allows the X-Hunter-Api-Key header', async () => {
  const server = await listen(createApp({ config: baseConfig, pipeline: { findContact: async () => FOUND } }));
  try {
    const preflight = await fetch(`${server.url}/api/brand-contact`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://radar.yaqubu.com',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization,x-hunter-api-key'
      }
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-headers'), /X-Hunter-Api-Key/);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://radar.yaqubu.com');
  } finally {
    await server.close();
  }
});

