'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createContactFinder, REASONS } = require('../src/contactFinder');
const { AppError } = require('../src/errors');
const { createTtlCache } = require('../src/cache');
const { silentLogger } = require('../src/logger');

function makeApollo(config = {}) {
  const calls = { search: [], enrich: [] };
  return {
    calls,
    async searchPeople(params) {
      calls.search.push(params);
      const list =
        calls.search.length > 1 && config.fallbackPeople ? config.fallbackPeople : config.people || [];
      return { people: list, total: list.length };
    },
    async enrichPerson(params) {
      calls.enrich.push(params);
      const person = (config.peopleById && config.peopleById[params.id]) || config.person || null;
      return { person, matchConfidence: person ? 'high' : 'none' };
    }
  };
}

function makeHunter(config = {}) {
  const calls = { find: [], verify: [] };
  return {
    calls,
    async findEmail(params) {
      calls.find.push(params);
      if (typeof config.find === 'function') return config.find(params);
      return config.find === undefined ? { email: 'jane@brand.com', score: 92 } : config.find;
    },
    async verifyEmail(email) {
      calls.verify.push(email);
      if (typeof config.verify === 'function') return config.verify(email);
      return config.verify || { status: 'valid', result: 'deliverable', score: 95 };
    }
  };
}

const INFLUENCER = {
  id: 'p1',
  title: 'Influencer Marketing Manager',
  organization: { name: 'Brand' }
};

const JANE = {
  name: 'Jane Doe',
  title: 'Influencer Marketing Manager',
  linkedin_url: 'https://www.linkedin.com/in/jane-doe-4a7c21'
};

function makeFinder({ apollo, hunter, options, cache, now }) {
  return createContactFinder({
    apollo,
    hunter,
    logger: silentLogger,
    cache: cache === null ? null : cache || createTtlCache({ ttlMs: 60000 }),
    now,
    options: Object.assign({ maxEnrichedCandidates: 2, maxEmailsToVerify: 2 }, options)
  });
}


test('happy path returns the four fields the frontend needs', async () => {
  const apollo = makeApollo({ people: [INFLUENCER], person: JANE });
  const hunter = makeHunter();
  const finder = makeFinder({ apollo, hunter });

  const result = await finder.findContact({
    domain: 'https://www.brand.com/pages/contact',
    brand: 'Brand'
  });

  assert.equal(result.contact_name, 'Jane Doe');
  assert.equal(result.title, 'Influencer Marketing Manager');
  assert.equal(result.email, 'jane@brand.com');
  assert.equal(result.email_status, 'valid');
  assert.equal(result.linkedin_url, 'https://www.linkedin.com/in/jane-doe-4a7c21');
  assert.equal(result.found, true);
  assert.equal(result.is_fallback, false);
  assert.equal(result.meta.domain, 'brand.com');

  // LinkedIn handle is the most precise Hunter input and is tried first.
  assert.equal(hunter.calls.find[0].linkedinHandle, 'jane-doe-4a7c21');
  assert.equal(hunter.calls.verify[0], 'jane@brand.com');
  assert.equal(apollo.calls.enrich[0].id, 'p1');
});

test('generic role mailboxes are marked as fallback, not as a contact', async () => {
  const apollo = makeApollo({ people: [INFLUENCER], person: JANE });
  const hunter = makeHunter({ find: { email: 'press@brand.com', score: 88 } });
  const finder = makeFinder({ apollo, hunter });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand' });

  assert.equal(result.is_fallback, true);
  assert.equal(result.found, false);
  assert.equal(result.reason, REASONS.GENERIC_EMAIL);
  assert.equal(result.email, 'press@brand.com');
  assert.equal(result.email_status, 'valid');
  assert.match(result.message, /fallback/i);
});

test('no matching person is reported without touching Hunter', async () => {
  const apollo = makeApollo({ people: [] });
  const hunter = makeHunter();
  const finder = makeFinder({ apollo, hunter });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand' });

  assert.equal(result.found, false);
  assert.equal(result.reason, REASONS.NO_PERSON_FOUND);
  assert.equal(result.email, null);
  assert.equal(hunter.calls.find.length, 0);
});

test('an unverified email is never returned as a contact', async () => {
  const apollo = makeApollo({ people: [INFLUENCER], person: JANE });
  const hunter = makeHunter({ verify: { status: 'unknown', result: 'unknown', score: 20 } });
  const finder = makeFinder({ apollo, hunter });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand' });

  assert.equal(result.found, false);
  assert.equal(result.email, null);
  assert.equal(result.email_status, 'unknown');
  assert.equal(result.reason, REASONS.EMAIL_UNVERIFIED);
  assert.deepEqual(result.meta.rejected[0], {
    email: 'jane@brand.com',
    reason: 'verification_unknown'
  });
});

test('catch-all addresses are rejected by default and accepted on request', async () => {
  const verify = { status: 'accept_all', result: 'risky', score: 70 };

  const strict = makeFinder({
    apollo: makeApollo({ people: [INFLUENCER], person: JANE }),
    hunter: makeHunter({ verify }),
    cache: null
  });
  const strictResult = await strict.findContact({ domain: 'brand.com', brand: 'Brand' });
  assert.equal(strictResult.found, false);
  assert.equal(strictResult.reason, REASONS.EMAIL_UNVERIFIED);

  const relaxed = makeFinder({
    apollo: makeApollo({ people: [INFLUENCER], person: JANE }),
    hunter: makeHunter({ verify }),
    options: { allowAcceptAll: true },
    cache: null
  });
  const relaxedResult = await relaxed.findContact({ domain: 'brand.com', brand: 'Brand' });
  assert.equal(relaxedResult.found, true);
  assert.equal(relaxedResult.email_status, 'accept_all');
});

test('off-domain addresses are refused when the brand domain is required', async () => {
  const apollo = makeApollo({ people: [INFLUENCER], person: JANE });
  const hunter = makeHunter({ find: { email: 'jane@gmail.com', score: 90 } });
  const finder = makeFinder({ apollo, hunter });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand' });

  assert.equal(result.found, false);
  assert.equal(result.reason, REASONS.NO_EMAIL_FOUND);
  assert.equal(hunter.calls.verify.length, 0, 'no credits spent verifying a gmail address');
});


test('a better second candidate wins over a generic first candidate', async () => {
  const people = [
    { id: 'p1', title: 'Head of Influencer Marketing' },
    { id: 'p2', title: 'Partnerships Manager' }
  ];
  const apollo = makeApollo({
    people,
    peopleById: {
      p1: { name: 'Pat Press', linkedin_url: 'https://www.linkedin.com/in/pat-press-111111' },
      p2: { name: 'Jane Doe', linkedin_url: 'https://www.linkedin.com/in/jane-doe-4a7c21' }
    }
  });
  const hunter = makeHunter({
    find: (params) =>
      params.linkedinHandle === 'jane-doe-4a7c21'
        ? { email: 'jane@brand.com', score: 95 }
        : { email: 'press@brand.com', score: 80 }
  });
  const finder = makeFinder({ apollo, hunter });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand' });

  assert.equal(result.found, true);
  assert.equal(result.contact_name, 'Jane Doe');
  assert.equal(result.email, 'jane@brand.com');
  assert.ok(result.meta.rejected.some((item) => item.reason === 'generic'));
});

test('unknown domains fall back to a brand keyword search and drop other companies', async () => {
  const apollo = makeApollo({
    people: [],
    fallbackPeople: [
      { id: 'x1', title: 'Partnerships Manager', organization: { name: 'Totally Different Co' } },
      { id: 'x2', title: 'Partnerships Manager', organization: { name: 'Acme Bikes' } }
    ],
    peopleById: { x2: { name: 'Jane Doe', linkedin_url: 'https://www.linkedin.com/in/jane-doe' } }
  });
  const hunter = makeHunter({ find: { email: 'jane@acmebikes.com', score: 90 } });
  const finder = makeFinder({ apollo, hunter });

  const result = await finder.findContact({ domain: 'acmebikes.com', brand: 'Acme Bikes' });

  assert.equal(apollo.calls.search.length, 2);
  assert.equal(apollo.calls.search[1].keywords, 'Acme Bikes');
  assert.deepEqual(apollo.calls.enrich.map((call) => call.id), ['x2']);
  assert.equal(result.found, true);
});

test('results are cached and concurrent lookups share one run', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const apollo = {
    calls: 0,
    async searchPeople() {
      this.calls += 1;
      await gate;
      return { people: [INFLUENCER], total: 1 };
    },
    async enrichPerson() {
      return { person: JANE, matchConfidence: 'high' };
    }
  };
  const hunter = makeHunter();
  const finder = makeFinder({ apollo, hunter });

  const first = finder.findContact({ domain: 'brand.com', brand: 'Brand' });
  const second = finder.findContact({ domain: 'brand.com', brand: 'Brand' });
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(apollo.calls, 1, 'one Apollo search for two simultaneous requests');
  assert.deepEqual(a, b);

  const cached = await finder.findContact({ domain: 'https://brand.com', brand: 'Brand' });
  assert.equal(apollo.calls, 1, 'cached lookup did not call Apollo again');
  assert.equal(cached.meta.cached, true);
});

test('an invalid domain is rejected before any paid call', async () => {
  const apollo = makeApollo({ people: [INFLUENCER], person: JANE });
  const finder = makeFinder({ apollo, hunter: makeHunter() });

  await assert.rejects(
    () => finder.findContact({ domain: 'not a domain', brand: 'Brand' }),
    (err) => err.status === 400 && err.code === REASONS.INVALID_DOMAIN
  );
  assert.equal(apollo.calls.search.length, 0);
});

test('Apollo outages never break the frontend response', async () => {
  const apollo = {
    async searchPeople() {
      const err = new Error('Apollo rate limit or credit limit reached.');
      err.code = 'APOLLO_429';
      throw err;
    }
  };
  const finder = makeFinder({ apollo, hunter: makeHunter() });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand' });

  assert.equal(result.found, false);
  assert.equal(result.reason, REASONS.UPSTREAM_ERROR);
  assert.match(result.message, /Apollo search failed/);
  assert.ok(result.meta.elapsed_ms >= 0);
});

test('missing Apollo credentials bubble up as a 503', async () => {
  const apollo = {
    async searchPeople() {
      throw new AppError('Apollo API key is not configured', {
        status: 503,
        code: 'APOLLO_KEY_MISSING'
      });
    }
  };
  const finder = makeFinder({ apollo, hunter: makeHunter() });

  await assert.rejects(
    () => finder.findContact({ domain: 'brand.com', brand: 'Brand' }),
    (err) => err.status === 503 && err.code === 'APOLLO_KEY_MISSING'
  );
});
