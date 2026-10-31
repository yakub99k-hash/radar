'use strict';

/**
 * End to end test: real Apollo + Hunter clients (HTTP included) against a local
 * fake upstream, so URL building, headers, JSON parsing and routing all get
 * exercised together. No real API keys or credits are used.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { buildConfig } = require('../src/config');
const { buildServices } = require('../src/index');
const { createApp } = require('../src/app');
const { silentLogger } = require('../src/logger');

function startMockUpstream(state) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      state.requests.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null
      });

      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (state.apolloStatus && url.pathname.startsWith('/api/v1/')) {
        return send(state.apolloStatus, { error: 'Invalid API key', error_code: 'invalid_api_key' });
      }
      if (url.pathname === '/api/v1/mixed_people/api_search') {
        return send(200, {
          total_entries: 2,
          people: [
            { id: 'p2', title: 'Social Media Manager', has_email: true, organization: { name: 'Brand' } },
            { id: 'p1', title: 'Influencer Marketing Manager', has_email: true, organization: { name: 'Brand' } }
          ]
        });
      }
      if (url.pathname === '/api/v1/people/match') {
        return send(200, {
          match_confidence: 'high',
          person: {
            name: 'Jane Doe',
            title: 'Influencer Marketing Manager',
            linkedin_url: 'https://www.linkedin.com/in/jane-doe-4a7c21'
          }
        });
      }
      if (url.pathname === '/v2/domain-search') {
        return send(200, {
          data: {
            domain: url.searchParams.get('domain'),
            pattern: '{first}',
            emails: [
              {
                value: 'press@brand.com',
                type: 'generic',
                confidence: 60,
                verification: { status: 'valid' }
              },
              {
                value: 'Jane.Doe@Brand.com',
                type: 'personal',
                confidence: 93,
                first_name: 'Jane',
                last_name: 'Doe',
                position: 'Influencer Marketing Manager',
                linkedin: 'https://www.linkedin.com/in/jane-doe-4a7c21',
                verification: { status: 'valid' }
              }
            ]
          }
        });
      }
      if (url.pathname === '/v2/email-finder') {
        return send(200, {
          data: { email: 'jane@brand.com', score: 96, position: 'Influencer Marketing Manager' }
        });
      }
      if (url.pathname === '/v2/email-verifier') {
        return send(200, {
          data: {
            email: url.searchParams.get('email'),
            status: state.verification.status,
            result: state.verification.result,
            score: 97,
            disposable: false,
            block: false
          }
        });
      }
      return send(404, { errors: [{ details: 'not found' }] });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

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

async function boot(state, overrides = {}, servicesOptions = {}) {
  const upstream = await startMockUpstream(state);
  const config = buildConfig({
    APOLLO_API_KEY: 'apollo-test-key',
    HUNTER_API_KEY: 'hunter-test-key',
    APOLLO_BASE_URL: `${upstream.baseUrl}/api/v1`,
    HUNTER_BASE_URL: upstream.baseUrl,
    ALLOWED_ORIGINS: 'https://radar.yaqubu.com',
    HTTP_RETRIES: '0',
    HUNTER_POLL_DELAY_MS: '250',
    ...overrides
  });
  const services = buildServices(config, silentLogger, servicesOptions);
  const app = createApp({
    config,
    logger: silentLogger,
    pipeline: services.pipeline,
    authMiddleware: services.authMiddleware
  });
  const server = await listen(app);
  return {
    server,
    async close() {
      await server.close();
      await upstream.close();
    }
  };
}

test('pipeline runs Apollo -> Hunter end to end over HTTP', async () => {
  const state = { requests: [], verification: { status: 'valid', result: 'deliverable' } };
  const { server, close } = await boot(state);

  try {
    const res = await fetch(`${server.url}/api/brand-contact?domain=brand.com&brand=Brand`, {
      headers: { Origin: 'https://radar.yaqubu.com' }
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.contact_name, 'Jane Doe');
    assert.equal(body.title, 'Influencer Marketing Manager');
    assert.equal(body.email, 'jane@brand.com');
    assert.equal(body.email_status, 'valid');
    assert.equal(body.linkedin_url, 'https://www.linkedin.com/in/jane-doe-4a7c21');
    assert.equal(body.found, true);
    assert.equal(body.is_fallback, false);

    const search = state.requests.find((r) => r.path === '/api/v1/mixed_people/api_search');
    assert.equal(search.headers['x-api-key'], 'apollo-test-key');
    assert.deepEqual(search.body.q_organization_domains_list, ['brand.com']);
    assert.ok(search.body.person_titles.includes('Influencer Marketing'));

    // Best title is enriched first, not the first row Apollo returned.
    const match = state.requests.find((r) => r.path === '/api/v1/people/match');
    assert.equal(match.body.id, 'p1');

    const finder = state.requests.find((r) => r.path === '/v2/email-finder');
    assert.equal(finder.headers['x-api-key'], 'hunter-test-key');
    assert.equal(finder.query.linkedin_handle, 'jane-doe-4a7c21');

    const verifier = state.requests.find((r) => r.path === '/v2/email-verifier');
    assert.equal(verifier.query.email, 'jane@brand.com');
  } finally {
    await close();
  }
});

test('an unverifiable email produces a graceful, cacheable answer', async () => {
  const state = { requests: [], verification: { status: 'invalid', result: 'undeliverable' } };
  const { server, close } = await boot(state);

  try {
    const url = `${server.url}/api/brand-contact?domain=brand.com&brand=Brand`;
    const first = await (await fetch(url)).json();
    assert.equal(first.found, false);
    assert.equal(first.email, null);
    assert.equal(first.reason, 'EMAIL_UNVERIFIED');
    assert.equal(first.email_status, 'invalid');

    const callsBefore = state.requests.length;
    const second = await (await fetch(url)).json();
    assert.equal(second.reason, 'EMAIL_UNVERIFIED');
    assert.equal(second.meta.cached, true);
    assert.equal(state.requests.length, callsBefore, 'cached response spent no credits');
  } finally {
    await close();
  }
});

test('a rejected Apollo key still answers through the Hunter domain search over HTTP', async () => {
  // 401 = what a placeholder APOLLO_API_KEY produces on Render today.
  const state = {
    requests: [],
    apolloStatus: 401,
    verification: { status: 'valid', result: 'deliverable' }
  };
  const { server, close } = await boot(state);

  try {
    const res = await fetch(`${server.url}/api/brand-contact?domain=brand.com&brand=Brand`, {
      headers: { Origin: 'https://radar.yaqubu.com' }
    });
    const body = await res.json();

    assert.equal(res.status, 200, 'a broken Apollo key is not an error any more');
    assert.equal(body.found, true);
    assert.equal(body.email, 'jane.doe@brand.com');
    assert.equal(body.contact_name, 'Jane Doe');
    assert.equal(body.title, 'Influencer Marketing Manager');
    assert.equal(body.email_status, 'valid');
    assert.equal(body.linkedin_url, 'https://www.linkedin.com/in/jane-doe-4a7c21');
    assert.equal(body.meta.strategy, 'hunter-domain-search');
    assert.match(body.meta.apollo_error, /Apollo rejected the API key/);

    const search = state.requests.find((r) => r.path === '/v2/domain-search');
    assert.ok(search, 'Hunter domain search was called');
    assert.equal(search.query.domain, 'brand.com');
    assert.equal(search.headers['x-api-key'], 'hunter-test-key');
    assert.equal(search.query.api_key, undefined, 'the key stays out of the URL');

    // Domain search already said "valid", so no paid verifier call was made.
    assert.equal(state.requests.filter((r) => r.path === '/v2/email-verifier').length, 0);
    assert.equal(state.requests.filter((r) => r.path === '/api/v1/people/match').length, 0);
  } finally {
    await close();
  }
});


test('Gemini finds a hidden email over HTTP before any paid call', async () => {
  const state = { requests: [], verification: { status: 'valid', result: 'deliverable' } };
  const sdk = () => ({
    models: {
      async generateContent() {
        return { text: '{"emails": ["sam.poe@brand.com"]}' };
      }
    }
  });
  const { server, close } = await boot(state, { GEMINI_API_KEY: 'gemini-test-key' }, {
    geminiSdkFactory: sdk
  });

  try {
    const res = await fetch(`${server.url}/api/brand-contact`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hunter-api-key': 'browser-key-123',
        Origin: 'https://radar.yaqubu.com'
      },
      body: JSON.stringify({
        domain: 'brand.com',
        brand: 'Brand',
        pageText: 'Sponsorships: write to sam.poe [at] brand [dot] com for creator campaigns.'
      })
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.found, true);
    assert.equal(body.email, 'sam.poe@brand.com');
    assert.equal(body.email_source, 'gemini');
    assert.equal(body.meta.strategy, 'gemini-text');
    assert.equal(state.requests.length, 0, 'neither Apollo nor Hunter was called');
  } finally {
    await close();
  }
});

test('the pipeline still answers when Gemini is not configured', async () => {
  const state = { requests: [], verification: { status: 'valid', result: 'deliverable' } };
  const { server, close } = await boot(state);

  try {
    const res = await fetch(`${server.url}/api/brand-contact?domain=brand.com&brand=Brand`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.found, true);
    assert.equal(body.email, 'jane@brand.com');
    assert.equal(body.email_source, null);
  } finally {
    await close();
  }
});

